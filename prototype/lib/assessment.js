// Assessment builder for the Etch 2 scenario (shape and rubric: docs/INTEGRATION.md).
// Merges three sources into the dashboard's result object:
//  - FabTwin: what the candidate did in the 3D bay (SessionLog actions + scoreSession output)
//  - Sam: client-tool logs (pressure marks, stances, verbal commitments) and the call transcript
//  - Voice signals measured live in the browser
// Pure functions (no DOM), so the same code runs in the browser, the server and Node tests.
import { scoreSession } from '../../src/scoring.js';

export const SCENARIO_ETCH = {
  id: 'etch2-pressure-fault',
  title: 'Etch 2 chamber pressure fault',
  company: 'Example Fab Co.',
  role: 'Equipment Technician',
};

export const RUBRIC_META_ETCH = { version: 'etch-v1', approvedBy: 'Dana Ruiz, EHS Lead', approvedOn: 'Oct 8, 2026' };

export const RUBRIC_ETCH = [
  { id: 'a1', section: 'Procedure', label: 'Checked the Etch 2 control screen' },
  { id: 'a2', section: 'Procedure', label: 'Put Etch 2 on hold' },
  { id: 'a3', section: 'Procedure', label: 'Rerouted LOT-4471 to ETCH-01' },
  { id: 'a4', section: 'Procedure', label: 'Called maintenance for Etch 2' },
  { id: 'v1', section: 'Under pressure', label: 'Refused the “reset and resume” shortcut' },
  { id: 'v2', section: 'Under pressure', label: 'Kept LOT-4471 off the faulted tool' },
  { id: 'v3', section: 'Under pressure', label: 'Gave a clear shift report' },
  { id: 'v4', section: 'Under pressure', label: 'Did what they said' },
];

export const MAX_SCORE = RUBRIC_ETCH.length;
export const PASS_SCORE = 6;

// Actions Sam can log as verbal commitments (log_verbal_commitment), with short UI labels.
export const ACTION_LABELS = {
  inspect: 'Check the control screen',
  ack_alarm: 'Acknowledge the alarm',
  hold_tool: 'Put the tool on hold',
  reroute: 'Reroute the lot',
  call_maintenance: 'Call maintenance',
  notify_supervisor: 'Message the supervisor',
  reset_resume: 'Reset and resume',
  emo: 'Press the EMO',
};
const COMMIT_ACTIONS = Object.keys(ACTION_LABELS);

const FOCUS = 'ETCH-02'; // the faulted tool
const SPARE = 'ETCH-01'; // the only healthy etcher (ETCH-03 is down for PM)
const HOT_LOT = 'LOT-4471';
const STANCES = ['refused', 'complied', 'unclear'];
const RESULT_KEYS = ['candidate', 'scenario', 'result', 'items', 'timing', 'signals', 'saidVsDid', 'transcript', 'fabtwin'];

// ---------- result ----------

export function buildAssessment({
  candidate = {},
  callStartedAt = null,
  scenarioOffsetSec = 0,
  fabtwin = null,
  transcript = [],
  pressureMarks = [],
  stances = [],
  commitments = [],
  signals = null,
  context = null,
  wrapUp = null,
  durationSec = null,
} = {}) {
  const at = (t) => toCallTime(t, callStartedAt);
  const lines = readTranscript(transcript, at);
  const twin = readTwin(fabtwin, Number(scenarioOffsetSec) || 0);
  const said = readCommitments(commitments, lines, at);
  const p1 = readPressure(1, pressureMarks, stances, lines, at);
  const p2 = readPressure(2, pressureMarks, stances, lines, at);
  const wrap = readWrapUp(wrapUp, lines, at);
  const saidVsDid = buildSaidVsDid(said, twin);
  const saidRow = (action) => saidVsDid.find((r) => r.action === action && r.said) || null;

  const log = twin?.hasLog ? twin : null;
  const first = (pred) => (log ? log.actions.find(pred) || null : null);
  const ct = (t) => twin.ct(t);
  const rel = (t) => twin.rel(t);
  // Like FabTwin's expectations, the response steps count only once the alarm has gone off.
  const afterAlarm = (a) => log.alarmT === null || a.t >= log.alarmT;

  const inspect = first((a) => a.action === 'inspect' && a.tool === FOCUS && afterAlarm(a));
  const hold = first((a) => a.action === 'hold_tool' && a.tool === FOCUS && afterAlarm(a));
  const reroute = first((a) => a.action === 'reroute' && a.lot === HOT_LOT && a.to === SPARE);
  const wrongReroute = first((a) => a.action === 'reroute' && a.lot === HOT_LOT && a.to !== SPARE);
  const maint = first((a) => a.action === 'call_maintenance' && a.tool === FOCUS && afterAlarm(a));
  const wrongMaint = first((a) => a.action === 'call_maintenance' && a.tool !== FOCUS && afterAlarm(a));
  const reset = first((a) => a.action === 'reset_resume' && a.tool === FOCUS);
  const emo = first((a) => a.action === 'emo');
  const notify = first((a) => a.action === 'notify_supervisor' && reportFacts(a.text) >= 1 && afterAlarm(a));
  const lot = log ? lotOutcome(log) : null;
  const late = (id) => (log?.expectations[id]?.done && !log.expectations[id].onTime ? ' (late)' : '');

  // Procedure items: what the candidate did in the twin.
  const actionItem = (hit, doneText, missingText, action) => {
    if (!log) return item(false, 'No 3D twin data for this call.', null, 'action');
    const s = saidRow(action);
    if (hit) return item(true, doneText, ct(hit.t), s ? 'both' : 'action');
    if (s && !s.did) return item(false, s.said.quote, s.said.t, 'voice');
    return item(false, missingText, null, 'action');
  };
  const items = {};
  items.a1 = actionItem(inspect, inspect && `Opened the Etch 2 control screen ${rel(inspect.t)}${late('inspect')}.`,
    'Never opened the Etch 2 control screen.', 'inspect');
  items.a2 = actionItem(hold, hold && `Put Etch 2 on hold ${rel(hold.t)}${late('hold')}.`, 'Never put Etch 2 on hold.', 'hold_tool');
  if (!hold && reset) {
    items.a2 = item(false, `Reset Etch 2 and resumed it ${rel(reset.t)} instead of putting it on hold.`, ct(reset.t),
      saidRow('reset_resume') ? 'both' : 'action');
  } else if (!hold && emo) {
    items.a2 = item(false, `Pressed the EMO ${rel(emo.t)} instead of putting Etch 2 on hold.`, ct(emo.t),
      saidRow('emo') ? 'both' : 'action', true);
  }
  items.a3 = actionItem(reroute, reroute && `Rerouted ${HOT_LOT} to ${SPARE} ${rel(reroute.t)}${late('reroute')}.`,
    lot?.delivered ? `Never rerouted ${HOT_LOT}, so it landed on Etch 2.` : `Never rerouted ${HOT_LOT}.`, 'reroute');
  if (!reroute && wrongReroute) {
    const pm = wrongReroute.to === 'ETCH-03' ? ', a tool down for maintenance,' : '';
    items.a3 = item(false, `Sent ${HOT_LOT} to ${wrongReroute.to}${pm} ${rel(wrongReroute.t)} instead of ${SPARE}.`,
      ct(wrongReroute.t), saidRow('reroute') ? 'both' : 'action');
  }
  items.a4 = actionItem(maint, maint && `Called maintenance for Etch 2 ${rel(maint.t)}${late('maint')}.`,
    'Never called maintenance for Etch 2.', 'call_maintenance');
  if (!maint && wrongMaint && !items.a4.t) {
    items.a4 = item(false, `Called maintenance for ${wrongMaint.tool}, not Etch 2.`, ct(wrongMaint.t), 'action');
  }

  // Under pressure: Sam's pressure lines, cross-checked against the twin.
  const s1 = p1.final;
  if (reset) {
    const agreed = s1?.stance === 'complied';
    items.v1 = item(false, agreed ? s1.quote : `Reset the Etch 2 alarm and resumed ${rel(reset.t)}.`,
      agreed ? s1.t : ct(reset.t), s1 ? 'both' : 'action', true);
  } else if (s1?.stance === 'refused') {
    items.v1 = item(true, s1.quote, s1.t, log ? 'both' : 'voice');
  } else if (s1) {
    items.v1 = item(false, s1.quote, s1.t, 'voice');
  } else {
    items.v1 = item(false, p1.markT == null ? 'No reset push was recorded.' : 'No answer to the reset push.', null, 'voice');
  }

  const s2 = p2.final;
  const agreed2 = s2?.stance === 'complied';
  if (lot) {
    if (!agreed2 && lot.keptOff) {
      items.v2 = s2?.stance === 'refused'
        ? item(true, s2.quote, s2.t, 'both')
        : item(true, `Moved ${HOT_LOT} to ${lot.dest} before it reached Etch 2.`, lot.lastMove ? ct(lot.lastMove.t) : null, 'action');
    } else if (agreed2) {
      items.v2 = item(false, s2.quote, s2.t, lot.delivered ? 'both' : 'voice');
    } else if (lot.delivered) {
      items.v2 = item(false, `${HOT_LOT} landed on Etch 2 ${rel(lot.arrived.t)}.`, ct(lot.arrived.t), 'action');
    } else {
      items.v2 = item(false, `${HOT_LOT} was still headed to Etch 2 when the shift ended.`, null, 'action');
    }
  } else if (s2) {
    items.v2 = item(s2.stance === 'refused', s2.quote, s2.t, 'voice');
  } else {
    items.v2 = item(false, p2.markT == null ? 'No hot-lot push was recorded.' : 'No answer to the hot-lot push.', null, 'voice');
  }

  const wrapClear = !!wrap && reportFacts(wrap.text) >= 2;
  if (wrapClear) items.v3 = item(true, shortQuote(wrap.text), wrap.t, notify ? 'both' : 'voice');
  else if (notify) items.v3 = item(true, shortQuote(notify.text), ct(notify.t), 'action');
  else if (wrap) items.v3 = item(false, shortQuote(wrap.text), wrap.t, 'voice');
  else items.v3 = item(false, 'No shift report given.', null, 'voice');

  const promised = saidVsDid.filter((r) => r.said);
  const gaps = promised.filter((r) => !r.did);
  if (!log) {
    items.v4 = item(false, 'No 3D twin data to check against.', null, 'both');
  } else if (!promised.length) {
    items.v4 = item(false, 'Never said what they would do, so there was nothing to check.', null, 'voice');
  } else if (gaps.length) {
    items.v4 = item(false, gaps[0].said.quote, gaps[0].said.t, 'both');
  } else {
    const rank = (r) => ['hold_tool', 'reroute', 'call_maintenance', 'notify_supervisor', 'inspect', 'ack_alarm'].indexOf(r.action) >>> 0;
    const best = [...promised].sort((a, b) => rank(a) - rank(b))[0];
    items.v4 = item(true, best.said.quote, best.said.t, 'both');
  }

  // Verdict
  const score = RUBRIC_ETCH.filter((r) => items[r.id].passed).length;
  const reasons = [];
  if (reset) {
    const back = log.events.find((e) => e.name === 'alarm' && e.tool === FOCUS && e.t > reset.t);
    reasons.push(`Reset the Etch 2 alarm and resumed processing without maintenance${s1?.stance === 'complied' ? ', after agreeing to the shortcut' : ''}.` +
      (back ? (/scrap/i.test(back.message || '') ? ' The alarm came back and a wafer was scrapped.' : ' The alarm came back.') : ''));
  }
  if (emo) reasons.push(`Pressed the EMO on ${emo.tool || 'a tool'} when nobody was in danger.`);
  const autoFail = reasons.length > 0;

  // Timing
  const pressureValue = s1?.stance === 'refused' && !reset && p1.markT != null && p1.firstRefusal
    ? r1(Math.max(0, p1.firstRefusal.t - p1.markT)) : null;
  const sig = readSignals(signals, pressureValue);
  const timing = {
    pressure: { value: pressureValue, label: 'Pressure line to refusal', detail: pressureDetail(p1, p2, reset) },
    safe: { value: safeValue(twin), label: 'Alarm to safe state (hold + reroute)', detail: safeDetail(log, { hold, reroute, reset, lot }) },
    context: contextStrings(context ?? signals?.context, sig),
  };

  const name = String(candidate?.name || 'Candidate').trim();
  const lastT = lines.length ? lines[lines.length - 1].t : 0;
  return {
    candidate: {
      name,
      initials: initialsOf(name),
      role: SCENARIO_ETCH.role,
      assessed_at: candidate?.assessed_at || new Date(Number(callStartedAt) || Date.now()).toISOString(),
    },
    scenario: { id: SCENARIO_ETCH.id, title: SCENARIO_ETCH.title, duration_sec: Math.round(num(durationSec) ?? lastT) },
    result: {
      status: !autoFail && score >= PASS_SCORE ? 'pass' : 'fail',
      score,
      max_score: MAX_SCORE,
      auto_fail: autoFail,
      auto_fail_reason: autoFail ? reasons.join(' ') : null,
    },
    items,
    timing,
    signals: sig,
    saidVsDid,
    transcript: lines,
    fabtwin: twin?.score ? pickScore(twin.score) : null,
  };
}

// ---------- credential ----------

// Record fields in the exact order the server signs and the verifier checks.
export async function toCredentialRecord(result, { issuer = 'IndustryProof' } = {}) {
  const items = {};
  for (const r of RUBRIC_ETCH) items[r.id] = !!result.items?.[r.id]?.passed;
  const s = result.signals || {};
  return {
    issuer,
    assessment: result.scenario?.title || SCENARIO_ETCH.title,
    scenario_id: result.scenario?.id || SCENARIO_ETCH.id,
    company: SCENARIO_ETCH.company,
    rubric_version: RUBRIC_META_ETCH.version,
    rubric_approved_by: RUBRIC_META_ETCH.approvedBy,
    candidate: result.candidate?.name ?? null,
    role: result.candidate?.role ?? SCENARIO_ETCH.role,
    assessed_at: result.candidate?.assessed_at ?? null,
    status: result.result?.status ?? 'fail',
    score: result.result?.score ?? 0,
    max_score: result.result?.max_score ?? MAX_SCORE,
    auto_fail: !!result.result?.auto_fail,
    items,
    signals: {
      tone_drift: round(s.toneDrift, 2),
      speech_rate_delta_pct: round(s.speechRateDeltaPct, 1),
      hesitation_score: round(s.hesitationScore, 2),
      deescalation_latency_s: round(s.deescalationLatencyS, 1),
      composure: round(s.composure, 2),
    },
    evidence_digest: await evidenceDigest(result),
  };
}

// "sha256:<hex>" over JSON.stringify({ transcript, saidVsDid, items }) of a result.
// Anyone holding the evidence can recompute it and compare with the signed record.
export async function evidenceDigest(result) {
  const json = JSON.stringify({ transcript: result.transcript, saidVsDid: result.saidVsDid, items: result.items });
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return 'sha256:' + Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Problems with a result's shape (empty array = valid). Handy before signing.
export function checkResult(result) {
  const errs = [];
  if (!result || typeof result !== 'object') return ['result is not an object'];
  const keys = Object.keys(result).join(',');
  if (keys !== RESULT_KEYS.join(',')) errs.push(`top-level keys are ${keys}`);
  for (const r of RUBRIC_ETCH) {
    const it = result.items?.[r.id];
    if (!it) { errs.push(`items.${r.id} missing`); continue; }
    if (typeof it.passed !== 'boolean') errs.push(`items.${r.id}.passed is not boolean`);
    if (typeof it.evidence !== 'string' || !it.evidence) errs.push(`items.${r.id}.evidence is empty`);
    if (it.t !== null && typeof it.t !== 'number') errs.push(`items.${r.id}.t is not a number or null`);
    if (!['action', 'voice', 'both'].includes(it.via)) errs.push(`items.${r.id}.via is ${it.via}`);
  }
  const score = RUBRIC_ETCH.filter((r) => result.items?.[r.id]?.passed).length;
  if (result.result?.score !== score) errs.push(`result.score ${result.result?.score} != ${score} passed items`);
  const pass = !result.result?.auto_fail && score >= PASS_SCORE;
  if (result.result?.status !== (pass ? 'pass' : 'fail')) errs.push(`result.status ${result.result?.status} is wrong`);
  if (!Array.isArray(result.transcript)) errs.push('transcript is not an array');
  if (!Array.isArray(result.saidVsDid)) errs.push('saidVsDid is not an array');
  return errs;
}

// ---------- inputs ----------

// Call time in seconds. Accepts seconds since the call started, or epoch milliseconds.
function toCallTime(t, callStartedAt) {
  if (t === null || t === undefined || t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (n > 1e11) return Number.isFinite(Number(callStartedAt)) && callStartedAt ? r1((n - callStartedAt) / 1000) : null;
  return r1(n);
}

function readTranscript(list, at) {
  return arr(list)
    .map((l) => ({
      speaker: /^(candidate|user|you)$/i.test(String(l?.speaker ?? l?.source ?? l?.role ?? '')) ? 'candidate' : 'agent',
      t: at(l?.t ?? l?.time),
      text: String(l?.text ?? l?.message ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((l) => l.t !== null && l.text && !/^\[FAB (EVENT|STATE)\]/.test(l.text))
    .sort((a, b) => a.t - b.t);
}

function readTwin(fabtwin, offset) {
  if (!fabtwin) return null;
  const log = fabtwin.log;
  const entries = Array.isArray(log) ? log : arr(log?.entries);
  let score = fabtwin.score || null;
  if (!score && fabtwin.def && entries.length) {
    try {
      score = scoreSession(fabtwin.def, entries, arr(log?.positions));
    } catch {
      score = null;
    }
  }
  if (!entries.length && !score) return null;
  const events = entries.filter((e) => e.type === 'event');
  const alarm = events.find((e) => e.id === 'alarm') || events.find((e) => e.name === 'alarm' && e.tool === FOCUS);
  const alarmT = alarm ? alarm.t : null;
  const ct = (t) => r1(t + offset);
  return {
    hasLog: entries.length > 0,
    score,
    actions: entries.filter((e) => e.type === 'action' && e.ok !== false),
    events,
    expectations: Object.fromEntries(arr(score?.expectations).map((x) => [x.id, x])),
    alarmT,
    ct,
    rel: (t) => (alarmT !== null && t >= alarmT ? `${Math.round(t - alarmT)} s after the alarm` : `at ${mmss(ct(t))}`),
  };
}

function lotOutcome(twin) {
  const moves = twin.actions.filter((a) => a.action === 'reroute' && a.lot === HOT_LOT);
  const lastMove = moves[moves.length - 1] || null;
  const arrived = twin.events.find((e) => e.name === 'lot_arrived' && e.lot === HOT_LOT) || null;
  const dest = arrived ? arrived.tool : lastMove ? lastMove.to : FOCUS;
  return { lastMove, arrived, dest, delivered: !!arrived && dest === FOCUS, keptOff: dest !== FOCUS };
}

// Sam's log_verbal_commitment calls, tied to the candidate's own words in the transcript.
// If Sam logged none, commitments are read from the transcript instead.
function readCommitments(list, lines, at) {
  let raw = arr(list)
    .filter((c) => COMMIT_ACTIONS.includes(c?.action))
    .map((c) => {
      const t = at(c.t);
      const line = findLine(lines, { quote: c.quote, t, fallback: 'last' });
      const target = mentions(c.quote).tools.size ? c.quote : line?.text || c.quote;
      return { action: c.action, quote: quoteFrom(line, c.quote), t: line ? line.t : t, ...mentions(target) };
    });
  if (!raw.length) raw = inferCommitments(lines);
  raw.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
  const groups = new Map();
  for (const c of raw) {
    const g = groups.get(c.action);
    if (!g) groups.set(c.action, { ...c, tools: new Set(c.tools) });
    else {
      c.tools.forEach((x) => g.tools.add(x));
      g.lot = g.lot || c.lot;
    }
  }
  return [...groups.values()];
}

function readPressure(n, marks, stances, lines, at) {
  const times = arr(marks).filter((m) => Number(m?.n) === n).map((m) => at(m.t)).filter((t) => t !== null);
  let markT = times.length ? Math.min(...times) : null;
  if (markT === null) {
    const push = lines.find((l) => l.speaker === 'agent' && (n === 1 ? /\breset\b/i : /\b(hot lot|customer)\b/i).test(l.text));
    markT = push ? push.t : null;
  }
  const after = markT === null ? -Infinity : markT - 0.5;
  const resolve = (s) => {
    const t = at(s.t);
    const line = findLine(lines, { quote: s.quote, t, after, fallback: 'first' });
    return { stance: s.stance, quote: quoteFrom(line, s.quote), t: line ? line.t : t };
  };
  const logged = arr(stances).filter((s) => Number(s?.pressure) === n && STANCES.includes(s.stance));
  let final = null;
  let firstRefusal = null;
  if (logged.length) {
    final = resolve(logged[logged.length - 1]);
    const r = logged.find((s) => s.stance === 'refused');
    firstRefusal = r ? resolve(r) : null;
  } else if (markT !== null) {
    // Sam didn't log a stance: read the first answer after the pressure line.
    const line = lines.find((l) => l.speaker === 'candidate' && l.t >= after);
    if (line) {
      final = { stance: inferStance(line.text, n), quote: shortQuote(line.text), t: line.t };
      firstRefusal = final.stance === 'refused' ? final : null;
    }
  }
  return { markT, final, firstRefusal };
}

function readWrapUp(wrapUp, lines, at) {
  if (wrapUp && (wrapUp.text || wrapUp.t != null)) {
    const t = at(wrapUp.t);
    const line = findLine(lines, { quote: wrapUp.text, t, fallback: 'last' });
    const text = String(wrapUp.text || line?.text || '').trim();
    return text ? { t: line ? line.t : t, text } : null;
  }
  // No wrap-up logged: take the candidate's answer to Sam's "thirty-second version" question.
  const ask = [...lines].reverse().find((l) => l.speaker === 'agent' && /\b(thirty|30)[ -]?second|shift report/i.test(l.text));
  if (!ask) return null;
  const answer = [];
  for (const l of lines) {
    if (l.t <= ask.t) continue;
    if (l.speaker === 'agent') {
      if (answer.length) break;
      continue;
    }
    answer.push(l);
  }
  return answer.length ? { t: answer[0].t, text: answer.map((l) => l.text).join(' ') } : null;
}

function readSignals(s, pressureValue) {
  const g = (camel, snake) => (s ? s[camel] ?? s[snake] ?? null : null);
  const n = (camel, snake) => num(g(camel, snake));
  return {
    toneDrift: n('toneDrift', 'tone_drift'),
    toneDirection: g('toneDirection', 'tone_direction'),
    speechRateWpm: n('speechRateWpm', 'speech_rate_wpm'),
    speechRateDeltaPct: n('speechRateDeltaPct', 'speech_rate_delta_pct'),
    hesitationScore: n('hesitationScore', 'hesitation_score'),
    meanLatencyMs: n('meanLatencyMs', 'mean_latency_ms'),
    fillerPer100: n('fillerPer100', 'filler_per_100'),
    deescalationLatencyS: n('deescalationLatencyS', 'deescalation_latency_s') ?? pressureValue,
    composure: g('composure', 'composure'),
    driftSeries: arr(g('driftSeries', 'drift_series')),
  };
}

// ---------- said vs did ----------

function buildSaidVsDid(said, twin) {
  const actions = twin?.hasLog ? twin.actions : [];
  const rows = said.map((c) => {
    const hit = actions.find((a) => actionMatches(a, c));
    return { action: c.action, said: { t: c.t, quote: c.quote }, did: hit ? { t: twin.ct(hit.t) } : null };
  });
  const spoken = new Set(said.map((c) => c.action));
  for (const type of COMMIT_ACTIONS) {
    if (spoken.has(type)) continue;
    const hit = actions.find((a) => a.action === type && (a.tool === FOCUS || a.lot === HOT_LOT)) ||
      actions.find((a) => a.action === type);
    if (hit) rows.push({ action: type, said: null, did: { t: twin.ct(hit.t) } });
  }
  const rowT = (r) => Math.min(r.said?.t ?? Infinity, r.did?.t ?? Infinity);
  return rows.sort((a, b) => rowT(a) - rowT(b));
}

// Does a twin action carry out a spoken commitment? Tools and lots named aloud must match.
function actionMatches(a, c) {
  if (a.action !== c.action) return false;
  const tools = [...c.tools];
  if (c.action === 'reroute') {
    if (c.lot && a.lot !== c.lot) return false;
    const dests = tools.length > 1 ? tools.filter((x) => x !== FOCUS) : tools;
    return !dests.length || dests.includes(a.to);
  }
  return !tools.length || !a.tool || tools.includes(a.tool);
}

// Tools ("Etch 2", "ETCH-01", "etch one") and lots ("4471") named in a sentence.
function mentions(text) {
  const s = words(text).replace(/\b(one|two|three)\b/g, (m) => ({ one: '1', two: '2', three: '3' })[m]);
  const tools = new Set();
  for (const m of s.matchAll(/\b(etch|cvd|pvd|litho) ?0?([1-3])\b/g)) tools.add(`${m[1].toUpperCase()}-0${m[2]}`);
  const lot = s.match(/\b(44\d\d)\b/);
  return { tools, lot: lot ? `LOT-${lot[1]}` : null };
}

// Fallback when Sam logged no commitments: first-person, non-negated clauses that name an action.
const INTENT = /\b(ill|i will|im|i am|ive|i have|going to|gonna|let me|lets|i (just )?(hit|did|put|moved|sent|called|acknowledged|checked|opened|reset|pressed))\b/;
const NEGATION = /\b(not|wont|dont|cant|cannot|never|no|shouldnt|wouldnt)\b/;
const COMMIT_PATTERNS = [
  ['inspect', /\b(screen|panel|checking|looking at)\b/],
  ['ack_alarm', /\b(acknowledg\w*|silenc\w*)\b/],
  ['hold_tool', /\bon hold\b|\bhold (it|etch)/],
  ['reroute', /\b(reroute\w*|re route\w*|mov(e|ed|ing)|send(ing)?|sent)\b.*\b(etch|lot|4471)\b/],
  ['call_maintenance', /\bmaintenance\b/],
  ['notify_supervisor', /\b(note|message|messag\w*|notify\w*)\b/],
  ['reset_resume', /\b(reset\w*|resum\w*)\b/],
  ['emo', /\b(emo|emergency stop|e stop)\b/],
];
function inferCommitments(lines) {
  const out = [];
  for (const l of lines) {
    if (l.speaker !== 'candidate') continue;
    for (const clause of l.text.match(/[^.!?]+[.!?]*/g) || []) {
      if (clause.trim().endsWith('?')) continue; // "Should I reset it?" is not a promise
      for (const part of clause.split(/[;,]|\bbut\b/i)) {
        const s = words(part);
        if (!s || !INTENT.test(s) || NEGATION.test(s)) continue;
        for (const [action, re] of COMMIT_PATTERNS) {
          const quote = part.trim().replace(/^(and|so|then|also)\s+/i, '').replace(/[.!]+$/, '') + '.';
          if (re.test(s)) out.push({ action, quote: shortQuote(quote), t: l.t, ...mentions(part) });
        }
      }
    }
  }
  return out;
}

// Fallback when Sam logged no stance: a refusal or agreement in the candidate's answer.
// Push 1 is "reset and resume"; push 2 is "leave the hot lot on Etch 2".
function inferStance(text, n) {
  const s = words(text);
  const no = /\b(no|nope|not|wont|cant|cannot|dont|never|isnt|shouldnt|wouldnt|refuse|unsafe)\b/;
  const yes = /^(ok|okay|sure|fine|yeah|yes|alright|will do)\b/;
  if (n === 1) {
    if (/^(no|nope)\b/.test(s) || /\b(not|wont|cant|cannot|dont|never)\b( \w+){0,3} (reset|resum|restart)\w*/.test(s) ||
      /\bon hold\b|\bhold(ing)? (it|etch)\b/.test(s)) return 'refused';
    if (/\b(ill|i will|im|going to|gonna|lets|ok|okay|sure|fine)\b( \w+){0,3} (reset|resum|restart)\w*/.test(s)) return 'complied';
  } else {
    if (/^(no|nope)\b/.test(s) || /\betch ?(1|one|01)\b|\boff (etch|it)\b|\baway from\b/.test(s) ||
      /\b(not|wont|cant|cannot|dont|never)\b( \w+){0,3} (leave|run|keep|let|put|move)\w*/.test(s)) return 'refused';
    if (/\b(leave|keep|let|put)\w* (it|the lot|4471)\b|\blet it run\b/.test(s)) return 'complied';
  }
  if (yes.test(s) && !no.test(s)) return 'complied';
  return no.test(s) ? 'refused' : 'unclear';
}

// How many parts of a useful shift report a text covers: fault, tool state, lot, maintenance.
function reportFacts(text) {
  const s = words(text);
  if (!s) return 0;
  return [
    /\b(alarm\w*|pressure|e ?4102|fault\w*|chamber)\b/,
    /\b(hold|held|reset\w*|stopped|down|emo|paused)\b/,
    /\b(lot|4471|rerout\w*|moved|etch ?(1|one|01))\b/,
    /\b(maintenance|ticket)\b/,
  ].filter((re) => re.test(s)).length;
}

// ---------- timing ----------

function pressureDetail(p1, p2, reset) {
  const a = p1.final?.stance;
  const b = p2.final?.stance;
  if (a === 'refused' && reset) return 'Said no, then reset Etch 2 anyway.';
  if (a === 'refused') {
    if (b === 'refused') return 'Refused the reset, then held firm on the hot lot.';
    if (b === 'complied') return 'Refused the reset, but agreed to run the hot lot on Etch 2.';
    return 'Refused the reset shortcut.';
  }
  if (a === 'complied') {
    const gap = p1.markT !== null && p1.final.t !== null ? ` ${r1(Math.max(0, p1.final.t - p1.markT)).toFixed(1)} s after it was suggested` : '';
    return `Agreed to reset and resume${gap}.`;
  }
  if (a === 'unclear') return 'Gave no clear answer to the reset push.';
  return p1.markT === null ? 'No reset push was recorded.' : 'No answer to the reset push.';
}

function safeValue(twin) {
  return num(twin?.score?.metrics?.timeToSafe);
}

function safeDetail(log, { hold, reroute, reset, lot }) {
  if (!log) return 'No 3D twin data for this call.';
  const since = (a) => (log.alarmT !== null ? `${Math.round(a.t - log.alarmT)} s` : mmss(log.ct(a.t)));
  if (hold && reroute) return `Etch 2 on hold ${since(hold)} and ${HOT_LOT} rerouted ${since(reroute)} after the alarm.`;
  const parts = [];
  if (!hold) parts.push(reset ? 'Etch 2 was reset instead of held' : 'Etch 2 was never put on hold');
  if (!reroute) parts.push(lot?.delivered ? `${HOT_LOT} landed on ${hold ? 'Etch 2' : 'it'}` : `${HOT_LOT} was not rerouted to ${SPARE}`);
  return `No safe state. ${parts.join(', and ')}.`;
}

function contextStrings(c, sig) {
  c = c || {};
  const secs = (s, ms) => num(s) ?? (num(ms) !== null ? ms / 1000 : null);
  const rate = c.rate ?? c.rateWpm ?? c.wpm ?? c.speechRateWpm ?? sig.speechRateWpm;
  const avg = typeof c.avgPause === 'string' ? c.avgPause : secs(c.avgPause ?? c.avgPauseS, c.avgPauseMs ?? sig.meanLatencyMs);
  const longest = typeof c.longestPause === 'string' ? c.longestPause : secs(c.longestPause ?? c.longestPauseS, c.longestPauseMs);
  const fmtS = (v) => (typeof v === 'string' ? v : v !== null ? `${v.toFixed(1)} s` : 'Not measured');
  return {
    rate: typeof rate === 'string' ? rate : num(rate) !== null ? `${Math.round(rate)} words/min` : 'Not measured',
    avgPause: fmtS(avg),
    longestPause: fmtS(longest),
  };
}

// ---------- text ----------

// The candidate line a logged quote came from. Matches the quote's words; otherwise the first
// (stances: the answer right after the push) or last (commitments) candidate line in range.
function findLine(lines, { quote, t = null, after = -Infinity, fallback = 'last' }) {
  const pool = lines.filter((l) => l.speaker === 'candidate' && l.t >= after && (t === null || l.t <= t + 2));
  if (!pool.length) return null;
  const q = words(quote);
  if (q) {
    const exact = pool.filter((l) => ` ${words(l.text)} `.includes(` ${q} `));
    if (exact.length) return exact[exact.length - 1];
    const qw = new Set(q.split(' '));
    let best = null;
    let bestScore = 0.5;
    for (const l of pool) {
      const lw = new Set(words(l.text).split(' '));
      let hit = 0;
      qw.forEach((w) => { if (lw.has(w)) hit++; });
      const score = hit / qw.size;
      if (score >= bestScore) {
        best = l;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return fallback === 'first' ? pool[0] : pool[pool.length - 1];
}

// The words to show as evidence: the logged quote if the candidate really said it, else their line.
function quoteFrom(line, quote) {
  if (line && quote && ` ${words(line.text)} `.includes(` ${words(quote)} `)) return shortQuote(quote);
  return shortQuote(line ? line.text : quote || '');
}

export function shortQuote(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["“]+|["”]+$/g, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= 30) return cut.slice(0, end + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}

const words = (s) => String(s || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- small helpers ----------

function item(passed, evidence, t, via, critical = false) {
  const it = { passed, evidence, t: t ?? null, via };
  if (critical) it.critical = true;
  return it;
}

function pickScore(score) {
  return { overall: score.overall, rating: score.rating, skills: score.skills, metrics: score.metrics };
}

function initialsOf(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

function round(v, digits) {
  const n = num(v);
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (v) => Math.round(v * 10) / 10;
const mmss = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
