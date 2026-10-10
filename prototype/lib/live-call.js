// Live call for the candidate side (contract: docs/INTEGRATION.md).
//
//   FabTwinFrame  Creates the FabTwin iframe once, relays its postMessage protocol and lays it
//                 over a slot in the call screen. The iframe is never moved in the DOM, because
//                 moving it would reload the 35 MB world.
//   LiveCall      One call with Sam (ElevenLabs agent). It directs Sam from FabTwin events
//                 ([FAB EVENT] cues, [FAB STATE] context), records his client-tool calls, the
//                 transcript and the voice signals, and at the end builds the assessment and
//                 has the server sign it.
//
// Browser only. The shell passes a small `ui` object; this file never builds the shell's HTML.

import { buildAssessment, toCredentialRecord } from './assessment.js';
import { createTurnTracker } from './voice-metrics.js';
import { fetchConfig, issueCredential } from './credential-client.js';

// FabTwin in embed mode. vol keeps the alarm horn under Sam's voice (and out of the mic).
export const FAB_SRC = '../index.html?embed=1&dev=0&debug=0&vol=0.45';
// Self-contained browser build of @elevenlabs/client (exposes window.ElevenLabsClient).
export const ELEVENLABS_CLIENT_URL = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.25.0/dist/lib.iife.js';

const FOCUS = 'ETCH-02';
const HOT_LOT = 'LOT-4471';
const COMMIT_ACTIONS = ['inspect', 'ack_alarm', 'hold_tool', 'reroute', 'call_maintenance', 'notify_supervisor', 'reset_resume', 'emo'];
const STANCES = ['refused', 'complied', 'unclear'];

// Cue pacing. A cue sent while Sam is still generating cuts his line off. In a live browser call
// Sam took 4 to 10 s from a cue to his reply, so after a cue we wait for the reply itself.
const CUE_GAP_MS = 4000;
const SILENCE_MS = 700; // the candidate must be quiet this long before a cue
const REPLY_WAIT_MS = 6000; // after the candidate speaks: Sam answers or skips the turn
const CUE_REPLY_MS = 10000; // after a cue or a logging tool call Sam always speaks; wait up to this long
const P1_DELAY_MS = 2500; // after the first Etch 2 inspect, let them read the screen first
const P2_AFTER_P1_MS = 12000;
const MAX_AGE_MS = { BRIEF: 25000, SAY: 25000, LOT_ARRIVED: 40000, MAINT: 25000 }; // a cue cycle can take ~12 s
const CALL_CAP_S = 350; // the agent hangs up at 360 s

// FabTwin Supervisor lines that a named cue already covers (BRIEF, ALARM, LOT_ARRIVED, WRAP_UP).
const DUPLICATE_SAY = [/^morning\b/i, /alarm on etch 2 from here/i, /lot-4471 just landed|lot-4471 sitting/i, /^nice work\b/i];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r1 = (x) => Math.round(x * 10) / 10;
const lcFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const shortClock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 100) {
  const until = performance.now() + ms;
  while (!pred() && performance.now() < until) await sleep(step);
  return pred();
}

export class CallSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- Plain-English rows for the timeline ----------

const clip = (s, n = 80) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// One FabTwin action as a short sentence ("Put ETCH-02 on hold").
export function describeAction(a) {
  const tool = a.tool || 'the tool';
  switch (a.action) {
    case 'inspect': return `Opened the ${tool} control screen`;
    case 'ack_alarm': return `Acknowledged the alarm on ${tool}`;
    case 'hold_tool': return `Put ${tool} on hold`;
    case 'reroute': return `Rerouted ${a.lot || 'a lot'} to ${a.to || 'another tool'}`;
    case 'call_maintenance': return `Called maintenance for ${tool}`;
    case 'notify_supervisor': return a.text ? `Messaged the supervisor: “${clip(a.text)}”` : 'Messaged the supervisor';
    case 'reset_resume': return `Reset the alarm on ${tool} and resumed it`;
    case 'emo': return `Pressed the EMO on ${tool}`;
    case 'end_shift': return 'Ended the shift on the terminal';
    default: return `${String(a.action || 'Action').replace(/_/g, ' ')}${a.tool ? ` on ${a.tool}` : ''}`;
  }
}

// Timeline rows ({ t, kind: 'action' | 'event', text, action? }) from FabTwin log entries.
// t = entry t + offsetSec (call seconds when the entries are in scenario seconds).
export function timelineFromLog(entries, offsetSec = 0) {
  const rows = [];
  let alarms = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.t !== 'number') continue;
    const t = r1(e.t + offsetSec);
    if (e.type === 'action' && e.ok !== false) {
      rows.push({ t, kind: 'action', action: e.action, text: describeAction(e) });
    } else if (e.type === 'event' && e.name === 'alarm') {
      rows.push({ t, kind: 'event', text: alarms++ ? `${e.tool} alarmed again: ${e.message}` : `Alarm on ${e.tool}: ${e.message} (${e.value} ${e.unit}, limit ${e.limit})` });
    } else if (e.type === 'event' && e.name === 'lot_arrived' && e.lot === HOT_LOT) {
      rows.push({ t, kind: 'event', text: `${e.lot} landed on ${e.tool}` });
    } else if (e.type === 'event' && e.name === 'say' && e.speaker && e.speaker !== 'Supervisor') {
      rows.push({ t, kind: 'event', text: `${e.speaker}: ${e.text}` });
    }
  }
  return rows;
}

// ---------- ElevenLabs browser SDK ----------

let sdkP = null;
export function loadElevenLabs() {
  if (window.ElevenLabsClient?.Conversation) return Promise.resolve(window.ElevenLabsClient);
  if (!sdkP) {
    sdkP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ELEVENLABS_CLIENT_URL;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.ElevenLabsClient?.Conversation ? resolve(window.ElevenLabsClient) : reject(new Error('The voice library loaded without Conversation')));
      s.onerror = () => {
        s.remove();
        reject(new Error('Could not load the voice library'));
      };
      document.head.appendChild(s);
    }).catch((e) => {
      sdkP = null;
      throw e;
    });
  }
  return sdkP;
}

function withTimeout(p, ms, message, onLate) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (onLate) p.then(onLate, () => {});
        reject(new Error(message));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------- FabTwin iframe ----------

export class FabTwinFrame {
  // parent: a positioned element the iframe host is appended to (it stays there for good).
  constructor({ parent = document.body, src = FAB_SRC } = {}) {
    this.parent = parent;
    this.src = src;
    this.iframe = null;
    this.host = null;
    this.slot = null;
    this.state = 'idle'; // idle | loading | ready | error
    this.progress = 0;
    this.scenario = null;
    this.error = null;
    this.used = false; // a scenario ran in this page load; FabTwin runs one per load
    this.handlers = new Map();
    this.raf = 0;
    this.rectKey = '';
    this.watchdog = 0;
    this.onMessage = this.onMessage.bind(this);
    this.sync = this.sync.bind(this);
  }

  load() {
    if (this.iframe) return this;
    const host = document.createElement('div');
    host.className = 'fabhost is-parked';
    const f = document.createElement('iframe');
    f.title = 'FabTwin: 3D replica of Bay 3';
    f.allow = 'microphone; camera; autoplay; fullscreen';
    f.setAttribute('allowfullscreen', '');
    f.addEventListener('load', () => this.armWatchdog());
    host.appendChild(f);
    this.parent.appendChild(host);
    window.addEventListener('message', this.onMessage);
    this.host = host;
    this.iframe = f;
    this.navigate();
    return this;
  }

  // A fresh FabTwin (it runs one scenario per page load).
  reload() {
    if (!this.iframe) return this.load();
    this.navigate();
    return this;
  }

  navigate() {
    this.progress = 0;
    this.scenario = null;
    this.error = null;
    this.used = false;
    this.setState('loading');
    this.iframe.src = this.src;
  }

  // No word from FabTwin 25 s after the page loaded: its scripts (CDN) probably failed.
  armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.state === 'loading' && this.progress === 0) {
        this.error = 'The 3D bay did not start. Check the internet connection and reload.';
        this.setState('error');
        this.emit('error', { message: this.error });
      }
    }, 25000);
  }

  onMessage(e) {
    if (!this.iframe || e.origin !== location.origin || e.source !== this.iframe.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.source !== 'fabtwin' || typeof d.type !== 'string') return;
    if (d.type === 'progress') {
      this.progress = clamp(Number(d.fraction) || 0, 0, 1);
      if (this.state === 'error') this.setState('loading'); // it was only slow
    } else if (d.type === 'ready') {
      this.scenario = d.scenario || null;
      this.progress = 1;
      this.error = null;
      this.setState('ready');
    } else if (d.type === 'started') {
      this.used = true;
    } else if (d.type === 'error') {
      this.error = String(d.message || 'The 3D bay failed to load.');
      this.setState('error');
    }
    this.emit(d.type, d);
  }

  setState(state) {
    this.state = state;
    this.emit('status', { state, progress: this.progress, error: this.error });
  }

  // on('ready' | 'started' | 'clock' | 'event' | 'action' | 'zone' | 'say' | 'ended' | 'error' |
  //    'progress' | 'status' | '*', fn(data, type)). Returns an unsubscribe function.
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, data) {
    for (const key of [type, '*']) {
      for (const fn of this.handlers.get(key) || []) {
        try {
          fn(data, type);
        } catch (err) {
          console.error(`[fabtwin] '${type}' handler failed`, err);
        }
      }
    }
  }

  post(type, data = {}) {
    try {
      this.iframe?.contentWindow?.postMessage({ target: 'fabtwin', type, ...data }, location.origin);
    } catch (err) {
      console.warn(`[fabtwin] could not send '${type}'`, err);
    }
  }

  // Lay the iframe over `slot` and keep it there (resizes, scrolls, layout changes).
  dock(slot) {
    if (!this.host) this.load();
    this.slot = slot;
    this.rectKey = '';
    this.host.classList.remove('is-parked');
    this.host.classList.add('is-docked');
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.sync);
  }

  // Back to hidden; it keeps running and stays loaded.
  undock() {
    this.slot = null;
    cancelAnimationFrame(this.raf);
    if (!this.host) return;
    this.host.classList.remove('is-docked');
    this.host.classList.add('is-parked');
    this.host.removeAttribute('style');
  }

  sync() {
    if (!this.slot || !this.host) return;
    this.raf = requestAnimationFrame(this.sync);
    const r = this.slot.getBoundingClientRect();
    const p = this.parent.getBoundingClientRect();
    const key = `${r.left - p.left}|${r.top - p.top}|${r.width}|${r.height}`;
    if (key === this.rectKey) return;
    this.rectKey = key;
    const s = this.host.style;
    s.visibility = r.width > 0 && r.height > 0 ? '' : 'hidden';
    s.left = `${r.left - p.left}px`;
    s.top = `${r.top - p.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
  }

  focus() {
    try {
      this.iframe?.focus();
    } catch {}
  }
}

// ---------- The call ----------

// ui (all optional): line({ speaker: 'agent'|'candidate'|'event', t, text }), caption(who, text, kind),
// speaking(bool), candidateTalking(bool), amp(0..1), clock(sec), phase(0..4), area(text, cls),
// lot(text), notice(text, kind), hint(text).
// onFinish(final) runs once the call has ended, however it ended (Sam, End button, timeouts).
export class LiveCall {
  constructor({ fab, analyzer = null, panel = null, candidate = 'Candidate', ui = {}, onFinish = null } = {}) {
    this.fab = fab;
    this.analyzer = analyzer;
    this.panel = panel;
    this.onFinish = onFinish;
    this.candidate = String(candidate || 'Candidate').trim() || 'Candidate';
    const noop = () => {};
    this.ui = new Proxy(ui, { get: (o, k) => (typeof o[k] === 'function' ? o[k] : noop) });

    this.conv = null;
    this.connectionType = null;
    this.status = 'idle'; // idle | connecting | live | finishing | done
    this.t0 = 0;
    this.epoch = 0;
    this.mode = 'listening';
    this.tracker = null;

    this.transcript = [];
    this.pressureMarks = [];
    this.stances = [];
    this.commitments = [];
    this.wrapLines = [];

    this.queue = [];
    this.cued = new Set();
    this.sentAt = {};
    this.lastCueAt = -Infinity;
    this.lastAgentAt = -Infinity;
    this.lastSpeakEndAt = -Infinity;
    this.lastBusyAt = -Infinity;
    this.replyDueBy = 0;
    this.lastPromptAt = -Infinity;
    this.lastAgentKey = '';
    this.lastVoicedAt = -Infinity;
    this.lastVadAt = -Infinity;
    this.p1At = null;
    this.wrapAskedAt = null;
    this.wrapAnsweredAt = null;
    this.amp = 0;

    this.scen = {
      started: false, offsetSec: null, t: 0, timeLimit: fab?.scenario?.timeLimit || 330,
      ended: false, alarmT: null, alarm: null, etch2: 'running', acked: false, maint: false,
      lotEta: null, lotTo: FOCUS, lotArrived: null, done: [], clock: [],
    };
    this.entries = []; // streamed event/action entries (if 'ended' never comes)
    this.endedPayload = null;
    this.offs = [];
    this.finalP = null;
  }

  callSec(ms = performance.now()) {
    return r1(Math.max(0, (ms - this.t0) / 1000));
  }

  get finishing() {
    return this.status === 'finishing' || this.status === 'done';
  }

  // Connects to Sam and arms FabTwin. Throws CallSetupError when the live call can't run,
  // so the shell can fall back to the recorded sample.
  async start() {
    this.status = 'connecting';
    // One retry: a single failed request (seen once in a live test) must not drop the demo to the sample.
    const cfg = (await fetchConfig({ refresh: true })) || (await sleep(500), await fetchConfig({ refresh: true }));
    if (!cfg) throw new CallSetupError('server', 'The demo server can’t be reached.');
    if (!cfg.agentId) throw new CallSetupError('no-agent', 'Sam isn’t set up on this server yet (no agent ID).');
    if (!this.fab || this.fab.state !== 'ready') throw new CallSetupError('fab', 'The 3D bay isn’t loaded.');
    if (this.fab.used) throw new CallSetupError('fab', 'The 3D bay needs a reload before another run.');
    this.scen.timeLimit = this.fab.scenario?.timeLimit || 330;

    let EL;
    try {
      EL = await withTimeout(loadElevenLabs(), 15000, 'Loading the voice library timed out');
    } catch (e) {
      throw new CallSetupError('sdk', `The voice library didn’t load (${e.message}).`);
    }

    const analyzer = this.analyzer?.running ? this.analyzer : null;
    this.tracker = createTurnTracker({ analyzer });
    if (analyzer) {
      this.offs.push(analyzer.onFrame((f) => {
        if (f.voiced && !f.agentSpeaking) this.lastVoicedAt = f.t;
      }));
    }
    this.listenToFab();

    this.t0 = performance.now();
    this.epoch = Date.now();
    const callbacks = {
      onDisconnect: (details) => this.onDisconnect(details),
      onError: (message) => console.warn('[call] Sam:', message),
      onMessage: (m) => this.onMessage(m),
      onModeChange: ({ mode }) => this.onModeChange(mode),
      onVadScore: ({ vadScore }) => {
        if (vadScore > 0.6) this.lastVadAt = performance.now();
      },
    };
    let lastErr = null;
    for (const connectionType of ['webrtc', 'websocket']) {
      // An attempt that timed out can still connect later (it is hung up at once). Its events,
      // above all its disconnect, must not reach this call or they would drop the live session.
      const attempt = { live: true };
      const guarded = Object.fromEntries(Object.entries(callbacks).map(([k, fn]) => [k, (...a) => (attempt.live ? fn(...a) : undefined)]));
      try {
        this.conv = await withTimeout(
          EL.Conversation.startSession({ agentId: cfg.agentId, clientTools: this.clientTools(), onConnect: () => {}, ...guarded, connectionType }),
          20000,
          'Connecting to Sam timed out',
          (late) => late?.endSession?.().catch(() => {}),
        );
        this.connectionType = connectionType;
        break;
      } catch (e) {
        attempt.live = false;
        lastErr = e;
        console.warn(`[call] ${connectionType} connection failed`, e);
        if (e?.name === 'NotAllowedError' || /permission|notallowed/i.test(String(e?.message))) break;
      }
    }
    if (!this.conv) {
      this.cleanup();
      this.status = 'idle';
      const denied = lastErr?.name === 'NotAllowedError' || /permission|notallowed/i.test(String(lastErr?.message));
      throw new CallSetupError(denied ? 'mic' : 'connect', denied ? 'Microphone access is blocked.' : `Couldn’t reach Sam (${lastErr?.message || 'unknown error'}).`);
    }

    this.status = 'live';
    this.panel?.setRecording(true);
    this.ui.phase(0);
    this.ui.caption('Connected', 'Click the 3D view to enter the bay.');
    this.ui.hint('Click the 3D view to enter the bay. W A S D to walk, E to use a tool, Tab for the terminal, Esc to pause.');
    this.fab.post('start', { candidate: this.candidate });
    this.pumpTimer = setInterval(() => this.pump(), 200);
    this.raf = requestAnimationFrame(this.loop);
    return { connectionType: this.connectionType };
  }

  setMicMuted(muted) {
    try {
      this.conv?.setMicMuted(!!muted);
    } catch {}
  }

  // Skip ahead (demo): end the 3D part now so Sam asks for the shift report.
  skipToWrapUp() {
    if (this.finishing) return;
    if (this.scen.started && !this.scen.ended) this.fab.post('end', { reason: 'skipped_to_wrap_up' });
    else this.cue('WRAP_UP');
  }

  // Ends the call and returns { result, credential, record, error, timeline, durationSec, reason }.
  end(reason = 'ended_by_candidate') {
    if (!this.finalP) {
      this.finalP = this.finalize(reason)
        .catch((e) => {
          console.error('[call] finishing failed', e);
          this.status = 'done';
          return { result: null, record: null, credential: null, error: e?.message || String(e), timeline: [], durationSec: Math.round(this.callSec()), reason };
        })
        .then((final) => {
        try {
          this.onFinish?.(final);
        } catch (e) {
          console.error('[call] onFinish failed', e);
        }
        return final;
      });
    }
    return this.finalP;
  }

  // ----- ElevenLabs events -----

  clientTools() {
    const now = () => this.callSec();
    return {
      mark_pressure: (p = {}) => {
        const n = Number(p.n);
        if (n !== 1 && n !== 2) return 'ignored: n must be 1 or 2';
        if (!this.pressureMarks.some((m) => m.n === n)) this.pressureMarks.push({ n, t: now() });
        this.tracker?.markPressure(n);
        this.ui.phase(2);
        return 'ok';
      },
      log_candidate_stance: (p = {}) => {
        const n = Number(p.pressure);
        const stance = String(p.stance || '');
        if ((n !== 1 && n !== 2) || !STANCES.includes(stance)) return 'ignored';
        this.stances.push({ pressure: n, stance, quote: String(p.quote || ''), t: now() });
        this.tracker?.logStance(n, stance);
        this.toolCalled();
        this.refreshSignals();
        return 'ok';
      },
      log_verbal_commitment: (p = {}) => {
        const action = String(p.action || '');
        if (!COMMIT_ACTIONS.includes(action)) return 'ignored';
        this.commitments.push({ action, quote: String(p.quote || ''), t: now() });
        this.toolCalled();
        return 'ok';
      },
      // post_tool_speech: this arrives after Sam's thanks has been spoken.
      end_exercise: (p = {}) => {
        this.endReason = String(p.reason || 'debrief complete');
        setTimeout(() => this.end('end_exercise'), 300);
        return 'ok';
      },
    };
  }

  // Something Sam has to answer just happened (a cue went out, the candidate spoke): hold cues
  // until his reply arrives, or for waitMs.
  expectReply(now, waitMs, prompt = true) {
    const pending = this.lastBusyAt > this.lastAgentAt;
    if (prompt) this.lastPromptAt = now;
    this.lastBusyAt = now;
    this.replyDueBy = Math.max(pending ? this.replyDueBy : 0, now + waitMs);
  }

  // A logging tool call. Before Sam has answered the latest cue or candidate line, his spoken
  // line follows the call; after it, the call is only bookkeeping.
  toolCalled() {
    if (this.lastAgentAt > this.lastPromptAt) return;
    this.expectReply(performance.now(), CUE_REPLY_MS, false);
  }

  onMessage({ message, role, source, event_id: eventId } = {}) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text || /^\[FAB (EVENT|STATE)\]/.test(text) || this.status === 'done') return;
    const now = performance.now();
    const fromAgent = role ? role === 'agent' : source === 'ai';
    if (fromAgent) {
      // The same agent_response can arrive twice (seen live after a turn with tool calls).
      const key = `${eventId}|${text}`;
      if (eventId != null && key === this.lastAgentKey) return;
      this.lastAgentKey = key;
      const t = this.callSec(now);
      this.transcript.push({ speaker: 'agent', t, text });
      this.lastAgentAt = now;
      if (this.sentAt.WRAP_UP && !this.wrapAskedAt) this.wrapAskedAt = now;
      this.ui.line({ speaker: 'agent', t, text });
      this.ui.caption('Sam', text);
      this.fab.post('subtitle', { speaker: 'Sam', text });
    } else {
      // "..." is what ElevenLabs sends when the candidate stays quiet past the turn timeout.
      // Sam answers it ("Still there?"), but the candidate said nothing: keep it out of the record.
      if (!/[a-z0-9]/i.test(text)) {
        this.expectReply(now, REPLY_WAIT_MS);
        return;
      }
      const turn = this.tracker ? this.tracker.addCandidateTurn(text, { at: now }) : null;
      const start = turn && Number.isFinite(turn.start) ? turn.start : now;
      const t = this.callSec(Math.min(start, now));
      this.transcript.push({ speaker: 'candidate', t, text });
      this.expectReply(now, REPLY_WAIT_MS);
      if (this.wrapAskedAt) {
        this.wrapLines.push({ t, text });
        this.wrapAnsweredAt = now;
      }
      this.ui.line({ speaker: 'candidate', t, text });
      this.ui.caption('You', text, 'cand');
      this.refreshSignals();
    }
  }

  onModeChange(mode) {
    const was = this.mode;
    this.mode = mode;
    const speaking = mode === 'speaking';
    this.tracker?.setAgentSpeaking(speaking);
    if (was === 'speaking' && !speaking) this.lastSpeakEndAt = performance.now();
    this.ui.speaking(speaking);
  }

  onDisconnect(details) {
    const conv = this.conv;
    this.conv = null;
    this.ui.speaking(false);
    if (this.finishing || !conv) return;
    console.warn('[call] Sam disconnected', details);
    if (this.sentAt.WRAP_UP || this.scen.ended) {
      this.end('call_disconnected');
    } else {
      this.ui.notice('Sam dropped off the call. You can keep working in the 3D bay, then press End call to submit.', 'warn');
      this.ui.caption('Call', 'Sam left the call.');
    }
  }

  refreshSignals() {
    if (this.panel && this.tracker) this.panel.setSignals(this.tracker.summary(), this.tracker.turns());
  }

  // ----- FabTwin events -----

  listenToFab() {
    const on = (type, fn) => this.offs.push(this.fab.on(type, fn));
    on('started', () => {
      const s = this.scen;
      s.started = true;
      s.offsetSec = this.callSec();
      s.clock.push([0, s.offsetSec]);
      this.ui.phase(0);
      this.ui.hint('W A S D to walk, E to use a tool, Tab for the terminal, Esc to pause.');
      this.ui.line({ speaker: 'event', t: s.offsetSec, text: 'Entered Bay 3' });
      this.cue('BRIEF');
    });
    on('clock', (d) => {
      const s = this.scen;
      s.t = Number(d.t) || 0;
      if (s.offsetSec != null) s.clock.push([s.t, this.callSec()]);
      this.updateLot();
    });
    on('event', (d) => this.onFabEvent(d.event));
    on('action', (d) => this.onFabAction(d.action));
    on('say', (d) => this.onFabSay(d));
    on('ended', (d) => this.onFabEnded(d));
    on('error', (d) => {
      if (!this.finishing) this.ui.notice(`The 3D bay hit an error: ${d.message || 'unknown'}`, 'warn');
    });
  }

  onFabEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    this.entries.push(ev);
    const s = this.scen;
    if (ev.name === 'alarm') {
      if (s.alarmT == null) {
        s.alarmT = ev.t;
        s.alarm = ev;
        if (s.etch2 === 'running') s.etch2 = 'alarm';
        this.ui.phase(1);
        this.ui.area(`Etch 2: alarm ${ev.code || ''}`.trim(), 'fail');
        this.cue('ALARM');
      } else {
        s.acked = false;
        this.ui.area('Etch 2: alarm again', 'fail');
      }
      this.eventLine(ev);
    } else if (ev.name === 'lot' && ev.lot === HOT_LOT) {
      s.lotEta = ev.t + (Number(ev.eta) || 0);
      s.lotTo = ev.to || FOCUS;
      this.updateLot();
    } else if (ev.name === 'lot_approach' && ev.lot === HOT_LOT) {
      if (ev.to) s.lotTo = ev.to;
      if (Number.isFinite(ev.eta)) s.lotEta = ev.eta;
    } else if (ev.name === 'lot_arrived' && ev.lot === HOT_LOT) {
      s.lotArrived = ev.tool;
      this.queue = this.queue.filter((q) => q.name !== 'PRESSURE_2'); // too late to push for Etch 2 now
      this.updateLot();
      this.cue('LOT_ARRIVED', { tool: ev.tool });
      this.eventLine(ev);
    }
  }

  onFabAction(a) {
    if (!a || typeof a !== 'object') return;
    this.entries.push(a);
    if (a.ok === false) return;
    const s = this.scen;
    s.done.push([a.action, a.lot, a.tool, a.to && `to ${a.to}`].filter(Boolean).join(' '));
    switch (a.action) {
      case 'inspect':
        if (a.tool === FOCUS && s.alarmT != null && a.t >= s.alarmT && this.p1At == null) this.p1At = performance.now() + P1_DELAY_MS;
        break;
      case 'ack_alarm':
        if (a.tool === FOCUS) s.acked = true;
        break;
      case 'hold_tool':
        if (a.tool === FOCUS) {
          s.etch2 = 'held';
          this.ui.area(s.maint ? 'Etch 2: on hold, maintenance called' : 'Etch 2: on hold', 'pass');
        }
        break;
      case 'reset_resume':
        if (a.tool === FOCUS) {
          s.etch2 = 'reset';
          s.acked = false;
          this.ui.area('Etch 2: reset and running', 'fail');
        }
        break;
      case 'emo':
        s.etch2 = 'emo';
        this.ui.area(`${a.tool === FOCUS || !a.tool ? 'Etch 2' : a.tool}: EMO pressed`, 'fail');
        break;
      case 'reroute':
        if (a.lot === HOT_LOT && !s.lotArrived && a.to) {
          s.lotTo = a.to;
          this.updateLot();
        }
        break;
      case 'call_maintenance':
        if (a.tool === FOCUS) {
          s.maint = true;
          if (s.etch2 === 'held') this.ui.area('Etch 2: on hold, maintenance called', 'pass');
          this.cue('MAINT');
        }
        break;
    }
    const text = describeAction(a);
    const t = this.callSec();
    this.context(`[FAB STATE] Candidate ${lcFirst(text)} at ${shortClock(t)}`);
    this.ui.line({ speaker: 'event', t, text });
  }

  onFabSay(d) {
    const speaker = d.speaker || 'Supervisor';
    const text = String(d.text || '').trim();
    if (!text) return;
    if (speaker !== 'Supervisor') {
      // Maintenance etc.: FabTwin shows it as a subtitle; we only log it.
      this.ui.line({ speaker: 'event', t: this.callSec(), text: `${speaker}: ${text}` });
      return;
    }
    if (DUPLICATE_SAY.some((re) => re.test(text))) return;
    this.cue('SAY', { text });
  }

  onFabEnded(d) {
    if (this.scen.ended) return;
    this.scen.ended = true;
    this.endedPayload = d;
    const why = { complete: 'Exercise complete', time_limit: 'Time is up', ended_by_candidate: 'Shift ended on the terminal' }[d.reason] || '3D exercise ended';
    this.ui.line({ speaker: 'event', t: this.callSec(), text: why });
    this.ui.hint('The 3D part is over. Answer Sam to finish the call.');
    if (this.finishing) return;
    if (this.conv) this.cue('WRAP_UP');
    else this.end('fabtwin_ended');
  }

  eventLine(ev) {
    const [row] = timelineFromLog([ev], 0);
    if (row) this.ui.line({ speaker: 'event', t: this.callSec(), text: row.text });
  }

  updateLot() {
    const s = this.scen;
    if (s.lotArrived) this.ui.lot(`${HOT_LOT} on ${s.lotArrived}`);
    else if (s.lotEta != null) this.ui.lot(`${HOT_LOT} → ${s.lotTo} · ${shortClock(Math.max(0, s.lotEta - s.t))}`);
  }

  // ----- Director -----

  context(text) {
    if (!this.conv || this.finishing) return;
    try {
      this.conv.sendContextualUpdate(text);
    } catch (e) {
      console.warn('[call] contextual update failed', e);
    }
  }

  cue(name, extra = {}) {
    if (this.finishing) return;
    if (this.cued.has('WRAP_UP') && name !== 'END') return; // nothing new after the wrap-up
    if (name !== 'SAY') {
      if (this.cued.has(name)) return;
      this.cued.add(name);
    }
    const c = { name, extra, at: performance.now(), maxAge: MAX_AGE_MS[name] || 0, ready: null };
    if (name === 'ALARM') this.queue = this.queue.filter((q) => q.name !== 'BRIEF');
    if (name === 'WRAP_UP') this.queue = this.queue.filter((q) => q.name === 'END'); // the rest is moot now
    if (name === 'PRESSURE_2') {
      c.ready = (now) => !this.sentAt.PRESSURE_1 || now - this.sentAt.PRESSURE_1 >= P2_AFTER_P1_MS || this.stances.some((x) => x.pressure === 1);
    }
    this.queue.push(c);
  }

  cueText(name, extra) {
    const s = this.scen;
    const eta = s.lotEta != null ? Math.max(0, Math.round(s.lotEta - s.t)) : null;
    switch (name) {
      case 'ALARM': {
        const a = s.alarm || {};
        return `[FAB EVENT] ALARM tool=${a.tool || FOCUS} code=${a.code || 'E-4102'} "${a.message || 'Chamber B pressure high'}" ${a.reading || 'chamberB'}=${a.value ?? 182} ${a.unit || 'mTorr'} limit=${a.limit ?? 120} lot=${HOT_LOT} to=${s.lotTo} eta=${eta ?? 90}s`;
      }
      case 'PRESSURE_1':
        return `[FAB EVENT] PRESSURE_1${s.etch2 === 'held' ? ' ETCH-02 is on hold' : ''}`;
      case 'PRESSURE_2':
        return `[FAB EVENT] PRESSURE_2 ${HOT_LOT} eta=${eta ?? 40}s routed to ${s.lotTo}`;
      case 'LOT_ARRIVED':
        return `[FAB EVENT] LOT_ARRIVED lot=${HOT_LOT} tool=${extra.tool}`;
      case 'MAINT':
        return `[FAB EVENT] MAINT tool=${FOCUS}`;
      case 'SAY':
        return `[FAB EVENT] SAY ${extra.text}`;
      default:
        return `[FAB EVENT] ${name}`; // BRIEF, WRAP_UP, END
    }
  }

  stateLine() {
    const s = this.scen;
    const parts = [`t=${Math.round(s.t)}s`];
    parts.push({
      running: 'ETCH-02 running',
      alarm: 'ETCH-02 alarmed and still running (not on hold)',
      held: 'ETCH-02 ON HOLD',
      reset: 'ETCH-02 alarm was reset and the tool resumed',
      emo: 'ETCH-02 stopped by EMO',
    }[s.etch2]);
    if (s.alarmT != null) parts.push(s.acked ? 'alarm E-4102 acknowledged' : 'alarm E-4102 active');
    if (s.lotArrived) parts.push(`${HOT_LOT} landed on ${s.lotArrived}`);
    else if (s.lotEta != null) parts.push(`${HOT_LOT} routed to ${s.lotTo} eta ${Math.max(0, Math.round(s.lotEta - s.t))}s`);
    if (s.maint) parts.push('maintenance called for ETCH-02');
    parts.push(`candidate actions: ${s.done.length ? s.done.slice(-10).join(', ') : 'none yet'}`);
    return `[FAB STATE] ${parts.join('; ')}`;
  }

  checkTimers(now) {
    const s = this.scen;
    if (s.alarmT != null && !this.cued.has('PRESSURE_1')) {
      if ((this.p1At != null && now >= this.p1At) || s.t >= s.alarmT + 30) this.cue('PRESSURE_1');
    }
    if (s.lotEta != null && !s.lotArrived && s.t >= s.lotEta - 40) this.cue('PRESSURE_2');
    if (s.started && s.t >= s.timeLimit - 45) this.cue('WRAP_UP');
    // Sam ends the call himself after the debrief; these are the fallbacks.
    if (this.sentAt.WRAP_UP) {
      if (!this.cued.has('END')) {
        if ((this.wrapAnsweredAt && now - this.wrapAnsweredAt > 12000) || now - this.sentAt.WRAP_UP > 35000) this.cue('END');
      } else if (this.sentAt.END && now - this.sentAt.END > 12000) {
        this.end('no_end_exercise');
      }
    }
    if (this.callSec(now) > CALL_CAP_S) this.end('time_limit');
  }

  pump() {
    if (!this.conv || this.finishing) return;
    const now = performance.now();
    this.checkTimers(now);
    if (this.finishing) return;
    this.queue = this.queue.filter((c) => !(c.maxAge && now - c.at > c.maxAge));
    const c = this.queue[0];
    if (!c || (c.ready && !c.ready(now))) return;
    if (this.mode === 'speaking') return;
    if (now - this.lastSpeakEndAt < 1000) return; // WebRTC mode can flicker in Sam's short pauses
    if (now - this.lastCueAt < CUE_GAP_MS) return;
    if (this.lastAgentAt > this.lastSpeakEndAt && now - this.lastAgentAt < 5000) return; // Sam's line is in, audio not done
    if (this.lastBusyAt > this.lastAgentAt && now < this.replyDueBy) return; // Sam is about to answer
    // The candidate must be quiet. After a long wait, trust only ElevenLabs' VAD, then nothing,
    // so noise on the local mic can't hold a cue forever.
    const waited = now - c.at;
    const voiceAt = waited < 10000 ? Math.max(this.lastVoicedAt, this.lastVadAt) : waited < 20000 ? this.lastVadAt : -Infinity;
    if (now - voiceAt < SILENCE_MS) return;
    this.queue.shift();
    this.dispatch(c, now);
  }

  dispatch(c, now) {
    const text = this.cueText(c.name, c.extra);
    try {
      this.conv.sendContextualUpdate(this.stateLine());
      this.conv.sendUserMessage(text);
    } catch (e) {
      console.warn('[call] cue failed', c.name, e);
      return;
    }
    console.info('[call] cue', text);
    this.lastCueAt = now;
    this.expectReply(now, CUE_REPLY_MS);
    this.sentAt[c.name] = now;
    if (c.name === 'PRESSURE_1' || c.name === 'PRESSURE_2') this.ui.phase(2);
    if (c.name === 'WRAP_UP') this.ui.phase(3);
  }

  loop = () => {
    if (this.status !== 'live' && this.status !== 'finishing') return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - (this.lastUiAt || 0) < 60) return;
    this.lastUiAt = now;
    this.ui.clock(this.callSec(now));
    let target = 0;
    if (this.conv && this.mode === 'speaking') {
      try {
        target = clamp((this.conv.getOutputVolume() || 0) * 2.2, 0, 1);
      } catch {}
    }
    this.amp += (target - this.amp) * 0.45;
    this.ui.amp(this.amp < 0.01 ? 0 : this.amp);
    this.ui.candidateTalking(now - this.lastVoicedAt < 350 || now - this.lastVadAt < 350);
  };

  // ----- End -----

  cleanup() {
    clearInterval(this.pumpTimer);
    for (const off of this.offs.splice(0)) {
      try {
        off();
      } catch {}
    }
  }

  async finalize(reason) {
    this.status = 'finishing';
    this.queue = [];
    clearInterval(this.pumpTimer);
    this.ui.caption('Call', 'Wrapping up the call…');
    // Let Sam finish his last line, then hang up.
    const conv = this.conv;
    if (conv) {
      await waitFor(() => this.mode !== 'speaking', 4000);
      await sleep(300);
      this.conv = null;
      try {
        await conv.endSession();
      } catch (e) {
        console.warn('[call] endSession failed', e);
      }
    }
    // Stop the 3D part and wait for its log.
    if (this.scen.started && !this.scen.ended) {
      this.fab.post('end', { reason: 'ended_by_call' });
      await waitFor(() => this.scen.ended, 3000);
    }
    const durationSec = Math.round(this.callSec());
    this.status = 'done';
    cancelAnimationFrame(this.raf);
    this.cleanup();
    this.ui.speaking(false);
    this.ui.amp(0);
    this.ui.candidateTalking(false);
    this.ui.phase(4);
    this.panel?.setRecording(false);

    // No candidate speech: report the signals as not measured rather than as zeros.
    const signals = this.tracker && this.tracker.turns().length ? this.tracker.summary() : null;
    const { fabtwin, offset } = this.fabtwinInput();
    const wrap = this.wrapLines;
    let result = null;
    let record = null;
    let credential = null;
    let error = null;
    try {
      result = buildAssessment({
        candidate: { name: this.candidate, assessed_at: new Date(this.epoch).toISOString() },
        callStartedAt: this.epoch,
        scenarioOffsetSec: offset,
        fabtwin,
        transcript: this.transcript,
        pressureMarks: this.pressureMarks,
        stances: this.stances,
        commitments: this.commitments,
        signals,
        wrapUp: wrap.length ? { t: wrap[0].t, text: wrap.map((l) => l.text).join(' ') } : null,
        durationSec,
      });
      record = await toCredentialRecord(result);
      credential = await issueCredential(record);
    } catch (e) {
      console.warn('[call] could not finish the assessment', e);
      error = e?.message || String(e);
    }
    const timeline = fabtwin?.log?.entries ? timelineFromLog(fabtwin.log.entries, offset) : [];
    return { result, record, credential, error, timeline, durationSec, reason, connectionType: this.connectionType };
  }

  // FabTwin's log for buildAssessment, with times corrected for pauses: scenario time stops
  // while FabTwin is paused but call time doesn't, so each entry is shifted by the drift seen
  // in the 'clock' messages up to that point. Then entry t + offset = call time.
  fabtwinInput() {
    const s = this.scen;
    if (s.offsetSec == null) return { fabtwin: null, offset: 0 };
    const src = this.endedPayload;
    const raw = Array.isArray(src?.log?.entries) ? src.log.entries : this.entries;
    const samples = s.clock;
    const entries = raw.map((e) => {
      if (!e || typeof e.t !== 'number') return e;
      let drift = 0;
      for (const [st, cs] of samples) {
        if (st <= e.t) drift = cs - (st + s.offsetSec);
        else break;
      }
      return drift > 0.05 ? { ...e, t: r1(e.t + drift) } : e;
    });
    if (src) return { fabtwin: { score: src.score, log: { ...src.log, entries }, def: src.def }, offset: s.offsetSec };
    return { fabtwin: entries.length ? { log: { entries } } : null, offset: s.offsetSec };
  }
}
