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

export const RUBRIC_META_ETCH = { version: 'etch-v2', approvedBy: 'Dana Ruiz, EHS Lead', approvedOn: 'Oct 10, 2026' };

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

// Competency profile: 1-5 levels scored from the same evidence as the checks. Descriptive only:
// pass/fail is still the 8 checks plus the auto-fail rule. A level is null when its data is missing.
export const LEVELS = { 1: 'Not yet', 2: 'Developing', 3: 'Proficient', 4: 'Strong', 5: 'Exemplary' };
export const COMPETENCY_GROUPS = [
  { id: 'technical', label: 'Technical' },
  { id: 'behavioural', label: 'Behavioural' },
];

export const COMPETENCIES_ETCH = [
  {
    id: 'procedure', group: 'technical', label: 'Following procedure',
    definition: 'Carried out the site’s fault-response steps completely and within their time targets.',
    anchors: {
      1: 'Missed most of the response steps.',
      3: 'Did the core steps (check, hold, reroute) but missed or delayed others.',
      5: 'Checked, acknowledged, held, rerouted, called maintenance and reported, all on time.',
    },
    sources: ['3D actions'],
  },
  {
    id: 'deliberate_action', group: 'technical', label: 'Deliberate action',
    definition: 'Knew which actions to take and took them on purpose: read the tool first, with no guessing, trial and error or stray actions.',
    anchors: {
      1: 'Acted before reading the tool, or tried actions that didn’t fit the fault.',
      3: 'Mostly purposeful, with a stray action or a slow step from diagnosis to action.',
      5: 'Read the tool, then went straight to the right actions on the right tool.',
    },
    sources: ['3D actions'],
  },
  {
    id: 'safety_judgment', group: 'technical', label: 'Safety judgment',
    definition: 'Protected people, tools and wafers: no bypassed alarms, no needless emergency stops, no product sent into a faulted or down tool.',
    anchors: {
      1: 'Bypassed the alarm, pressed the EMO with nobody in danger, or let product into the faulted tool.',
      3: 'Avoided the worst outcomes but left a risk open, such as a tool never put on hold.',
      5: 'Made the faulted tool safe and kept all product away from it, with no bypass.',
    },
    sources: ['3D actions'],
  },
  {
    id: 'fab_tools', group: 'technical', label: 'Working with semiconductor fab tools',
    definition: 'Read the tool correctly and used the right controls: the alarm details, hold versus reset versus EMO, which etcher could take the lot, and the operator terminal.',
    anchors: {
      1: 'Couldn’t read the alarm, or used the wrong controls.',
      3: 'Read the alarm and used some of the right controls.',
      5: 'Read out the reading, limit and code, used Hold, picked the healthy etcher and used the terminal.',
    },
    sources: ['3D actions', 'Transcript'],
  },
  {
    id: 'situational_awareness', group: 'technical', label: 'Situational awareness',
    definition: 'Noticed the alarm quickly, made the tool safe in time and kept track of the lot heading for it.',
    anchors: {
      1: 'Slow to respond, and the lot reached the faulted tool.',
      3: 'Responded, but reached a safe state late or lost track of the lot.',
      5: 'At the tool within 15 s and safe within 30 s, with the lot on a healthy tool.',
    },
    sources: ['3D actions'],
  },
  {
    id: 'composure', group: 'behavioural', label: 'Composure under pressure',
    definition: 'Stayed calm and steady when pushed: tone, pace and pauses held up under pressure.',
    note: 'Voice-based. Voice varies with accent, language and nerves, so this never affects pass or fail.',
    anchors: {
      1: 'Tone and pace changed sharply, with long pauses under pressure.',
      3: 'Some strain under pressure, but kept going.',
      5: 'Tone, pace and response time stayed steady under pressure.',
    },
    sources: ['Voice signals'],
  },
  {
    id: 'clarifying_questions', group: 'behavioural', label: 'Asking clarifying questions',
    definition: 'Gathered information before deciding: asked relevant questions and checked the tool screen and terminal instead of assuming.',
    anchors: {
      1: 'Decided without checking or asking.',
      3: 'Checked the tool and terminal before deciding, but asked nothing.',
      5: 'Asked relevant questions and checked the tool and terminal before deciding.',
    },
    sources: ['Transcript', '3D actions'],
  },
  {
    id: 'problem_solving', group: 'behavioural', label: 'Problem solving',
    definition: 'Found a fix that met both goals (a safe tool and a moving line), explained why, and dealt with the root cause.',
    anchors: {
      1: 'Didn’t contain the fault or find a way to keep the lot moving.',
      3: 'Contained the fault or kept the lot moving, but not both.',
      5: 'Held the tool, moved the lot to the healthy etcher, explained why and raised maintenance.',
    },
    sources: ['3D actions', 'Transcript'],
  },
  {
    id: 'integrity', group: 'behavioural', label: 'Integrity under pressure',
    definition: 'Held a safe position when the shift lead pushed for shortcuts, firmly and respectfully, and offered a way forward.',
    anchors: {
      1: 'Agreed to or took the unsafe shortcut.',
      3: 'Refused one push but gave way or wavered on the other.',
      5: 'Refused both pushes, acknowledged the pressure and offered a safe alternative.',
    },
    sources: ['Transcript', 'Sam’s logs', '3D actions'],
  },
  {
    id: 'collaboration', group: 'behavioural', label: 'Collaboration and communication',
    definition: 'Kept the shift lead and maintenance informed, acknowledged their concerns and gave a clear, complete shift report.',
    anchors: {
      1: 'Said little, and the shift report was missing or unclear.',
      3: 'Kept people partly informed; the report missed key facts.',
      5: 'Gave updates as they went, used the formal channels and covered fault, tool state, lot and maintenance in the report.',
    },
    sources: ['Transcript', '3D actions'],
  },
  {
    id: 'ownership', group: 'behavioural', label: 'Ownership and follow-through',
    definition: 'Did what they said they would and reported what happened honestly, including their own mistakes.',
    anchors: {
      1: 'Promises weren’t kept, and mistakes were left out of the report.',
      3: 'Kept most promises but missed one, or the report was incomplete.',
      5: 'Every spoken promise was carried out, and the report was complete and honest.',
    },
    sources: ['Transcript', '3D actions'],
  },
];

// The badge a passing candidate can share (docs/INTEGRATION.md, "Badge").
export const BADGE_ETCH = {
  name: 'Etch Tool Fault Response',
  description: 'Handled a live chamber-pressure fault on a plasma etch tool in a 3D replica of a fab bay while the shift lead pushed for unsafe shortcuts.',
  criteria: 'Passed the Etch 2 chamber pressure fault assessment: at least 6 of 8 checks and no safety bypass.',
};

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
const PM_TOOL = 'ETCH-03'; // down for planned maintenance
const STANCES = ['refused', 'complied', 'unclear'];
const RESULT_KEYS = ['candidate', 'scenario', 'result', 'items', 'competencies', 'timing', 'signals', 'saidVsDid', 'transcript', 'fabtwin'];
// Time targets in s after the alarm, from scenarios/etch2-pressure-fault.json expect[].within.
const WITHIN = { inspect: 60, ack: 90, hold: 120, reroute: 78, maint: 180, notify: 240 };
const LOT_ETA = 90; // LOT-4471 reaches Etch 2 this long after the alarm unless it is rerouted
const TERMINAL_ACTIONS = ['reroute', 'notify_supervisor', 'call_maintenance'];

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
  const notifyAny = first((a) => a.action === 'notify_supervisor' && afterAlarm(a));
  const ack = first((a) => a.action === 'ack_alarm' && a.tool === FOCUS && afterAlarm(a));
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
  const competencies = scoreCompetencies({
    log, lines, items, inspect, ack, hold, reroute, wrongReroute, maint, wrongMaint, reset, emo, notify, notifyAny,
    lot, p1, p2, wrap, saidVsDid, sig, ct, rel, afterAlarm,
  });
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
    competencies,
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
    competencies: Object.fromEntries(COMPETENCIES_ETCH.map((c) => [c.id, levelOrNull(result.competencies?.[c.id]?.level)])),
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
  const comps = result.competencies;
  if (!comps || typeof comps !== 'object') errs.push('competencies is not an object');
  else {
    const ids = Object.keys(comps).join(',');
    if (ids !== COMPETENCIES_ETCH.map((c) => c.id).join(',')) errs.push(`competency ids are ${ids}`);
    for (const c of COMPETENCIES_ETCH) {
      const x = comps[c.id];
      if (!x) continue;
      if (x.level !== levelOrNull(x.level)) errs.push(`competencies.${c.id}.level is ${x.level}`);
      if (x.score !== null && !(Number.isInteger(x.score) && x.score >= 0 && x.score <= 100)) errs.push(`competencies.${c.id}.score is ${x.score}`);
      if ((x.level === null) !== (x.score === null)) errs.push(`competencies.${c.id} has a level without a score or the reverse`);
      if (!['action', 'voice', 'both'].includes(x.via)) errs.push(`competencies.${c.id}.via is ${x.via}`);
      if (!Array.isArray(x.evidence) || !x.evidence.length) errs.push(`competencies.${c.id}.evidence is empty`);
      else if (x.evidence.some((e) => typeof e.text !== 'string' || !e.text || (e.t !== null && typeof e.t !== 'number') || ![true, false, null].includes(e.ok))) {
        errs.push(`competencies.${c.id}.evidence has a bad entry`);
      }
    }
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
    failed: entries.filter((e) => e.type === 'action' && e.ok === false),
    zones: entries.filter((e) => e.type === 'zone'),
    ui: entries.filter((e) => e.type === 'ui'),
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

// ---------- competencies ----------

// Each competency adds up weighted indicators to a 0-100 score and bands it into a level
// (levelOf). Indicators whose data is missing are skipped and the rest renormalised; caps for
// unsafe actions apply after banding. Every indicator is listed as evidence, so a reviewer can
// see why a level came out as it did.
const ALARM_FACTS = [/\b(chamber|pressure)\b/, /\b182\b/, /\b120\b/, /\be ?4102\b/];
const REASONING = /\b(because|since|over (the |a |its )?limit|scrap\w*|unsafe|not safe|isnt safe|only option|down for (pm|maintenance))\b/;
const PRESSURE_ACK = /\b(i get (that|it)|i understand|i hear you|i know|understood|sorry)\b/;
const WAY_FORWARD = /\b(instead|can take it|etch (1|one|01)|ill|i will|im (putting|moving|calling|sending|keeping)|lets)\b/;
const RAPPORT = /\b(i get (that|it)|i understand|i hear you|understood|got it|thanks|thank you|will do|on it|copy that|morning|sounds good)\b/;
const STATE_CHANGES = ['hold_tool', 'reset_resume', 'call_maintenance', 'emo'];

export function levelOf(score) {
  return score >= 90 ? 5 : score >= 75 ? 4 : score >= 55 ? 3 : score >= 35 ? 2 : 1;
}

function scoreCompetencies(x) {
  const { log, lines, items, inspect, ack, hold, reroute, wrongReroute, maint, wrongMaint, reset, emo, notify, notifyAny,
    lot, p1, p2, wrap, saidVsDid, sig, ct, rel, afterAlarm } = x;
  const cand = lines.filter((l) => l.speaker === 'candidate');
  const NO_LOG = 'No 3D twin data for this call';
  const NO_SPEECH = 'The candidate didn’t speak during this call';
  const at = (a) => (a ? ct(a.t) : null);
  const c = {};

  // Shared reads of the 3D log
  let arrivals = [];
  let pmMove = null;
  let terminalAfterAlarm = null;
  let terminalEver = null;
  if (log) {
    arrivals = [log.zones.find((z) => z.enter && z.tool === FOCUS && afterAlarm(z)), inspect].filter(Boolean);
    pmMove = log.actions.find((a) => a.action === 'reroute' && a.to === PM_TOOL) || null;
    const usesTerminal = (a) => TERMINAL_ACTIONS.includes(a.action) || a.source === 'dashboard';
    terminalAfterAlarm = log.ui.find((u) => u.name === 'dashboard_open' && afterAlarm(u)) ||
      log.actions.find((a) => usesTerminal(a) && afterAlarm(a)) || null;
    terminalEver = log.ui.find((u) => u.name === 'dashboard_open') || log.actions.find(usesTerminal) || null;
  }

  // ----- Technical -----
  if (!log) {
    for (const id of ['procedure', 'deliberate_action', 'safety_judgment', 'fab_tools', 'situational_awareness']) c[id] = unrated('action', NO_LOG);
  } else {
    const since = (a) => (log.alarmT === null ? null : Math.round(a.t - log.alarmT));
    const step = (hit, w, within, did, missing) => {
      if (!hit) return pt(w, 0, missing);
      const d = since(hit);
      const onTime = d === null || d <= within;
      return pt(w, onTime ? w : w / 2, `${did} ${rel(hit.t)}${onTime ? '' : `, after the ${within} s target`}`, at(hit), onTime);
    };
    c.procedure = rate('action', [
      step(inspect, 15, WITHIN.inspect, 'Checked the Etch 2 control screen', 'Never checked the Etch 2 control screen'),
      step(ack, 10, WITHIN.ack, 'Acknowledged the alarm at the tool', 'Never acknowledged the alarm at the tool'),
      step(hold, 20, WITHIN.hold, 'Put Etch 2 on hold', 'Never put Etch 2 on hold'),
      step(reroute, 25, WITHIN.reroute, `Rerouted ${HOT_LOT} to ${SPARE}`, `Never rerouted ${HOT_LOT} to ${SPARE}`),
      step(maint, 20, WITHIN.maint, 'Called maintenance for Etch 2', 'Never called maintenance for Etch 2'),
      step(notifyAny, 10, WITHIN.notify, 'Sent the supervisor an update', 'Never sent the supervisor an update'),
    ]);

    // Deliberate action: diagnose first, act on the right target, no stray or failed tries, no detours.
    const firstChange = log.actions.find((a) => STATE_CHANGES.includes(a.action) && (a.tool === FOCUS || a.action === 'emo') && afterAlarm(a)) || null;
    const diagnose = firstChange && (!inspect || firstChange.t < inspect.t)
      ? pt(25, 0, `${didText(firstChange)} ${rel(firstChange.t)}, before checking its screen`, at(firstChange))
      : inspect ? pt(25, 25, `Checked the Etch 2 screen ${rel(inspect.t)}${firstChange ? ', before changing anything' : ''}`, at(inspect))
      : pt(25, 0, 'Never checked the Etch 2 screen');
    let movedLot = false;
    const judged = log.actions.filter((a) => a.action !== 'inspect' && a.action !== 'end_shift');
    const purposeful = judged.map((a) => {
      if (!afterAlarm(a)) return false;
      if (['ack_alarm', 'hold_tool', 'call_maintenance'].includes(a.action)) return a.tool === FOCUS;
      if (a.action === 'notify_supervisor') return true;
      if (a.action === 'reroute' && a.lot === HOT_LOT && a.to === SPARE && !movedLot) return (movedLot = true);
      return false;
    });
    const failedTries = log.failed.filter((a) => a.action !== 'inspect' && a.action !== 'end_shift');
    const total = judged.length + failedTries.length;
    const good = purposeful.filter(Boolean).length;
    const precision = total
      ? pt(35, (35 * good) / total, good === total ? `All ${total} actions were the right action on the right tool` : `${good} of ${total} actions were the right action on the right tool`, null, good === total)
      : pt(35, 0, 'Took no actions on the tools');
    const stray = judged.filter((_, i) => !purposeful[i]).map((a) => pt(0, 0, `Stray action: ${didText(a)} ${rel(a.t)}`, at(a), false))
      .concat(failedTries.map((a) => pt(0, 0, `Tried: ${didText(a)} ${rel(a.t)}, which didn’t go through`, at(a), false)))
      .slice(0, 3);
    const gap = hold && inspect && hold.t >= inspect.t ? Math.round(hold.t - inspect.t) : null;
    const decisive = gap !== null
      ? pt(25, gap <= 30 ? 25 : gap <= 60 ? 12 : 0, `Put Etch 2 on hold ${gap} s after reading its screen`, at(hold), gap <= 30)
      : pt(25, 0, hold ? 'Put Etch 2 on hold without reading its screen first' : 'Never got from diagnosis to a hold');
    let route;
    if (log.alarmT === null) route = skip('Route to Etch 2: no alarm in this run');
    else if (!arrivals.length) route = pt(15, 0, 'Never went to Etch 2 after the alarm');
    else {
      const t = Math.min(...arrivals.map((a) => a.t));
      const detours = [...new Set(log.zones.filter((z) => z.enter && z.tool !== FOCUS && z.t >= log.alarmT && z.t < t).map((z) => z.tool))];
      route = detours.length
        ? pt(15, 0, `Stopped at ${detours.join(', ')} on the way to Etch 2`, ct(t))
        : pt(15, 15, 'Went straight to Etch 2 after the alarm', ct(t));
    }
    c.deliberate_action = rate('action', [diagnose, precision, ...stray, decisive, route],
      reset || emo ? [cap(2, 'Took an unsafe action, so this is capped at Developing', at(reset || emo))] : []);

    // Safety judgment
    const healthyHolds = log.actions.filter((a) => a.action === 'hold_tool' && a.tool !== FOCUS);
    const safetyCaps = [];
    if (reset) safetyCaps.push(cap(1, `Reset Etch 2 and resumed it ${rel(reset.t)} without maintenance: a safety bypass`, at(reset)));
    if (emo) safetyCaps.push(cap(1, `Pressed the EMO ${rel(emo.t)} when nobody was in danger`, at(emo)));
    c.safety_judgment = rate('action', [
      hold ? pt(30, 30, `Put Etch 2 on hold ${rel(hold.t)}`, at(hold)) : pt(30, 0, 'Etch 2 was never put on hold'),
      lot.delivered ? pt(40, 0, `${HOT_LOT} landed on the faulted Etch 2 ${rel(lot.arrived.t)}`, at(lot.arrived))
        : lot.keptOff ? pt(40, 40, `Kept ${HOT_LOT} off the faulted tool`, at(lot.arrived || lot.lastMove))
        : pt(40, 20, `${HOT_LOT} was still headed to Etch 2 when the shift ended`, null, false),
      pmMove ? pt(30, 0, `Sent ${pmMove.lot} to ${PM_TOOL}, which is down for planned maintenance`, at(pmMove))
        : pt(30, 30, `Sent nothing to ${PM_TOOL}, which is down for maintenance`),
      healthyHolds.length ? pt(10, 0, `Put a healthy tool on hold: ${[...new Set(healthyHolds.map((a) => a.tool))].join(', ')}`, at(healthyHolds[0]))
        : pt(10, 10, 'Held only the faulted tool'),
      ...(!reset && !emo ? [pt(0, 0, 'No alarm bypass and no needless EMO', null, true)] : []),
    ], safetyCaps);

    // Working with fab tools: read the alarm, use the right control, pick the right spare, use the terminal.
    const sources = cand.map((l) => ({ text: l.text, t: l.t, said: true }))
      .concat(log.actions.filter((a) => a.action === 'notify_supervisor' && a.text).map((a) => ({ text: a.text, t: ct(a.t), said: false })));
    let best = null;
    let bestN = 0;
    for (const s of sources) {
      for (const sentence of sentencesOf(s.text)) {
        const n = ALARM_FACTS.filter((re) => re.test(words(sentence))).length;
        if (n > bestN) { best = { ...s, q: sentence }; bestN = n; }
      }
    }
    c.fab_tools = rate('both', [
      !best ? pt(30, 0, 'Never described the alarm reading')
        : pt(30, bestN >= 2 ? 30 : 15, `${best.said ? 'Read out' : 'Wrote down'} ${bestN} of 4 alarm details (chamber, reading, limit, code)`, best.t, bestN >= 2, best.q),
      hold && !reset && !emo ? pt(25, 25, 'Used Hold on Etch 2, not reset or the EMO', at(hold))
        : hold ? pt(25, 12, `Used Hold on Etch 2, but also ${reset ? 'reset it' : 'pressed the EMO'}`, at(hold), false)
        : reset ? pt(25, 0, 'Used Reset and resume instead of Hold', at(reset))
        : emo ? pt(25, 0, 'Used the EMO instead of Hold', at(emo))
        : pt(25, 0, 'Never used Hold on Etch 2'),
      reroute && !wrongReroute ? pt(25, 25, `Chose ${SPARE}, the only healthy etcher, for ${HOT_LOT}`, at(reroute))
        : reroute ? pt(25, 15, `Ended on ${SPARE} for ${HOT_LOT}, after first sending it to ${wrongReroute.to}`, at(reroute), false)
        : wrongReroute ? pt(25, 0, `Sent ${HOT_LOT} to ${wrongReroute.to} instead of ${SPARE}`, at(wrongReroute))
        : pt(25, 0, `Never moved ${HOT_LOT} to a healthy etcher`),
      terminalEver ? pt(10, 10, 'Used the operator terminal', at(terminalEver)) : pt(10, 0, 'Never used the operator terminal'),
      maint ? pt(10, 10, 'Raised maintenance on the right tool', at(maint))
        : wrongMaint ? pt(10, 0, `Raised maintenance on ${wrongMaint.tool}, not Etch 2`, at(wrongMaint))
        : pt(10, 0, 'Never raised maintenance'),
    ]);

    // Situational awareness: reaction time, time to a safe state, and where the lot ended up.
    if (log.alarmT === null) c.situational_awareness = unrated('action', 'No alarm was raised in this run');
    else {
      const arrive = arrivals.length ? Math.min(...arrivals.map((a) => a.t)) : null;
      const react = arrive === null ? null : Math.round(arrive - log.alarmT);
      const lotEvent = log.events.find((e) => e.name === 'lot' && e.lot === HOT_LOT);
      const eta = lotEvent && Number.isFinite(lotEvent.eta) ? lotEvent.t + lotEvent.eta - log.alarmT : LOT_ETA;
      const safeAt = hold && reroute ? Math.max(hold.t, reroute.t) : null;
      const safeT = safeAt === null ? null : Math.round(safeAt - log.alarmT);
      c.situational_awareness = rate('action', [
        react === null ? pt(30, 0, 'Never reached Etch 2 after the alarm')
          : pt(30, react <= 15 ? 30 : react <= 30 ? 22 : react <= 60 ? 12 : 0, `Reached Etch 2 ${react} s after the alarm`, ct(arrive), react <= 30),
        safeT === null ? pt(40, 0, hold ? `Never rerouted ${HOT_LOT}, so no safe state` : 'Never put Etch 2 on hold, so no safe state')
          : pt(40, safeT <= 30 ? 40 : safeT <= 60 ? 30 : safeT <= eta ? 20 : 0, `Safe state (hold and reroute) ${safeT} s after the alarm`, ct(safeAt), safeT <= 60),
        lot.keptOff && lot.dest === SPARE ? pt(30, 30, `Kept track of ${HOT_LOT}: it ended on ${SPARE}`, at(lot.arrived || lot.lastMove))
          : lot.keptOff ? pt(30, 10, `Moved ${HOT_LOT} off Etch 2, but to ${lot.dest}`, at(lot.lastMove), false)
          : lot.delivered ? pt(30, 0, `${HOT_LOT} landed on Etch 2 ${rel(lot.arrived.t)}`, at(lot.arrived))
          : pt(30, 0, `${HOT_LOT} was still headed to Etch 2 when the shift ended`),
      ]);
    }
  }

  // ----- Behavioural -----
  const composure = num(sig.composure);
  if (composure === null) c.composure = unrated('voice', 'Voice signals weren’t measured in this call');
  else {
    const score = clamp(Math.round(composure), 0, 100);
    const detail = [];
    const drift = num(sig.toneDrift);
    if (drift !== null) {
      detail.push(drift < 25 ? pt(0, 0, `Tone stayed steady under pressure (drift ${Math.round(drift)}/100)`, null, true)
        : pt(0, 0, `Tone shifted under pressure (drift ${Math.round(drift)}/100${sig.toneDirection ? `, ${sig.toneDirection}` : ''})`, null, false));
    }
    const hes = num(sig.hesitationScore);
    if (hes !== null) {
      detail.push(pt(0, 0, hes >= 70 ? `Answered without much hesitation (${Math.round(hes)}/100)` : `Hesitant answers (${Math.round(hes)}/100, higher is steadier)`, null, hes >= 70));
    }
    const pace = num(sig.speechRateDeltaPct);
    if (pace !== null) {
      const p = `${pace > 0 ? '+' : pace < 0 ? '−' : ''}${Math.abs(Math.round(pace))}%`;
      detail.push(pt(0, 0, Math.abs(pace) <= 10 ? `Kept a normal pace under pressure (${p})` : `Pace changed under pressure (${p})`, null, Math.abs(pace) <= 10));
    }
    const deesc = num(sig.deescalationLatencyS);
    if (deesc !== null) detail.push(pt(0, 0, `Pushed back ${deesc.toFixed(1)} s after the shortcut was suggested`, null, deesc <= 4));
    c.composure = rate('voice', [pt(100, score, `Composure ${score}/100 from tone, pace, pauses and how fast they pushed back`, null, score >= 55), ...detail],
      log && emo ? [cap(2, 'Pressed the EMO, a panic response', at(emo))] : []);
  }

  if (!log) c.clarifying_questions = unrated('both', NO_LOG);
  else {
    const qs = [];
    for (const l of cand) {
      for (const s of sentencesOf(l.text)) if (s.endsWith('?') && words(s).split(' ').length >= 3) qs.push({ q: s, t: l.t });
    }
    const ans = p1.final;
    c.clarifying_questions = rate('both', [
      qs.length ? pt(35, qs.length >= 2 ? 35 : 20, qs.length >= 2 ? `Asked ${qs.length} questions about the situation` : 'Asked a question about the situation', qs[0].t, true, qs[0].q)
        : pt(35, 0, 'Asked Sam no questions about the situation'),
      ...qs.slice(1, 3).map((q) => pt(0, 0, 'Also asked', q.t, true, q.q)),
      !inspect ? pt(35, 0, 'Never checked the Etch 2 screen')
        : ans && ans.t !== null && ans.t < ct(inspect.t) ? pt(35, 0, 'Answered the reset push before checking the Etch 2 screen', ans.t)
        : pt(35, 35, ans ? 'Checked the Etch 2 screen before answering the reset push' : `Checked the Etch 2 screen ${rel(inspect.t)}`, at(inspect)),
      terminalAfterAlarm ? pt(30, 30, `Checked the operator terminal ${rel(terminalAfterAlarm.t)}`, at(terminalAfterAlarm))
        : pt(30, 0, 'Never opened the operator terminal after the alarm'),
    ]);
  }

  if (!log) c.problem_solving = unrated('both', NO_LOG);
  else {
    const why = findSentence(cand, REASONING);
    const saidMaint = saidVsDid.find((r) => r.action === 'call_maintenance' && r.said && !r.did);
    c.problem_solving = rate('both', [
      hold && !reset ? pt(25, 25, `Contained the fault: put Etch 2 on hold ${rel(hold.t)}`, at(hold))
        : reset ? pt(25, 0, 'Reset the tool instead of containing the fault', at(reset))
        : emo ? pt(25, 0, 'Shut the tool down with the EMO instead of containing the fault', at(emo))
        : pt(25, 0, 'Never contained the fault'),
      reroute ? pt(30, 30, `Kept the line moving: sent ${HOT_LOT} to ${SPARE}`, at(reroute))
        : wrongReroute ? pt(30, 0, `Sent ${HOT_LOT} to ${wrongReroute.to}, which can’t run it`, at(wrongReroute))
        : pt(30, 0, `Found no way to keep ${HOT_LOT} moving`),
      why ? pt(20, 20, 'Explained their reasoning', why.t, true, why.q) : pt(20, 0, 'Never explained the reasoning behind their decisions'),
      maint ? pt(25, 25, `Raised maintenance for the root cause ${rel(maint.t)}`, at(maint))
        : saidMaint ? pt(25, 0, 'Said they would get maintenance but never raised it', saidMaint.said.t, false, saidMaint.said.quote)
        : pt(25, 0, 'Never raised maintenance for the root cause'),
    ]);
  }

  if (p1.markT === null && p2.markT === null) c.integrity = unrated('both', 'Sam’s pressure lines weren’t delivered in this call');
  else {
    const s1 = p1.final;
    const s2 = p2.final;
    const parts = [];
    if (p1.markT !== null) {
      parts.push(reset ? pt(40, 0, `Reset and resumed Etch 2 when pushed, ${rel(reset.t)}`, at(reset))
        : s1?.stance === 'refused' ? pt(40, 40, 'Refused the “reset and resume” shortcut', s1.t, true, s1.quote)
        : s1?.stance === 'unclear' ? pt(40, 15, 'Gave no clear answer to the reset push', s1.t, false, s1.quote)
        : s1?.stance === 'complied' ? pt(40, 0, 'Agreed to the reset shortcut', s1.t, false, s1.quote)
        : pt(40, 0, 'No answer to the reset push'));
    }
    if (p2.markT !== null) {
      parts.push(items.v2.passed ? pt(35, 35, `Held firm on ${HOT_LOT}: kept it off the faulted tool`, items.v2.t, true, s2?.stance === 'refused' ? s2.quote : null)
        : s2?.stance === 'unclear' ? pt(35, 15, 'Gave no clear answer to the hot-lot push', s2.t, false, s2.quote)
        : s2?.stance === 'complied' ? pt(35, 0, `Agreed to run ${HOT_LOT} on the faulted tool`, s2.t, false, s2.quote)
        : pt(35, 0, items.v2.evidence, items.v2.t, false));
    }
    const resisted = [];
    if (p1.markT !== null && !reset && s1?.stance === 'refused') resisted.push(p1.markT);
    if (p2.markT !== null && items.v2.passed) resisted.push(p2.markT);
    if (!resisted.length) parts.push(pt(25, 0, 'Never pushed back, so there was no refusal to frame'));
    else {
      const answers = cand.filter((l) => resisted.some((m) => l.t >= m - 0.5 && l.t <= m + 20));
      const ackS = findSentence(answers, PRESSURE_ACK);
      const fwdS = findSentence(answers, WAY_FORWARD);
      parts.push(ackS ? pt(10, 10, 'Acknowledged the pressure', ackS.t, true, ackS.q) : pt(10, 0, 'Pushed back without acknowledging the pressure'));
      parts.push(fwdS ? pt(15, 15, 'Offered a safe way forward', fwdS.t, true, fwdS.q) : pt(15, 0, 'Said no without offering another way'));
    }
    c.integrity = rate('both', parts, reset ? [cap(1, 'Took the unsafe shortcut', at(reset))] : []);
  }

  if (!cand.length) c.collaboration = unrated('both', NO_SPEECH);
  else {
    const n = wrap ? reportFacts(wrap.text) : 0;
    const announced = saidVsDid.filter((r) => r.said).length;
    const rapport = findSentence(cand, RAPPORT);
    c.collaboration = rate('both', [
      wrap ? pt(30, [0, 7, 15, 22, 30][n], `Shift report covered ${n} of 4 key facts (fault, tool state, lot, maintenance)`, wrap.t, n >= 3, shortQuote(wrap.text))
        : pt(30, 0, 'Gave no shift report'),
      pt(20, announced >= 3 ? 20 : announced ? 10 : 0, announced ? `Told Sam what they were doing ${announced} time${announced > 1 ? 's' : ''}` : 'Didn’t tell Sam what they were doing', null, announced >= 3),
      !log ? skip('Written update: no 3D twin data')
        : notify ? pt(15, 15, `Sent the supervisor a written update ${rel(notify.t)}`, at(notify)) : pt(15, 0, 'Sent no written update on the terminal'),
      !log ? skip('Maintenance: no 3D twin data')
        : maint ? pt(15, 15, `Brought in maintenance ${rel(maint.t)}`, at(maint)) : pt(15, 0, 'Didn’t bring in maintenance'),
      rapport ? pt(20, 20, 'Engaged with Sam', rapport.t, true, rapport.q) : pt(20, 0, 'Never acknowledged Sam or his concerns'),
    ]);
  }

  if (!log || !cand.length) c.ownership = unrated('both', !log ? NO_LOG : NO_SPEECH);
  else {
    const said = saidVsDid.filter((r) => r.said);
    const broken = said.filter((r) => !r.did);
    const mistakes = [
      reset && ['the reset', /\b(reset\w*|resum\w*)\b/],
      emo && ['the EMO', /\b(emo|emergency stop|e stop)\b/],
      lot.delivered && [`${HOT_LOT} landing on Etch 2`, /\b(4471|lot)\b.*\betch ?(2|two|02)\b|\betch ?(2|two|02)\b.*\b(4471|lot)\b/],
      pmMove && [`the lot sent to ${PM_TOOL}`, /\betch ?(3|three|03)\b/],
    ].filter(Boolean);
    const report = wrap ? words(wrap.text) : '';
    const left = mistakes.filter(([, re]) => !re.test(report));
    const owned = wrap && mistakes.length && !left.length ? findSentence([{ text: wrap.text, t: wrap.t }], mistakes[0][1]) : null;
    c.ownership = rate('both', [
      said.length ? pt(60, (60 * (said.length - broken.length)) / said.length, `Kept ${said.length - broken.length} of ${said.length} spoken commitments`, null, !broken.length)
        : pt(60, 0, 'Never said what they would do, so there was nothing to follow through on'),
      ...broken.slice(0, 3).map((r) => pt(0, 0, `Said but didn’t do: ${(ACTION_LABELS[r.action] || r.action).toLowerCase()}`, r.said.t, false, r.said.quote)),
      wrap ? pt(15, 15, 'Gave the shift report', wrap.t) : pt(15, 0, 'Gave no shift report'),
      !wrap ? pt(25, 0, 'No report, so nothing was owned up to')
        : !mistakes.length ? pt(25, 25, 'No mistakes to own up to')
        : left.length ? pt(25, 0, `Left ${left.map(([m]) => m).join(' and ')} out of the report`, wrap.t)
        : pt(25, 25, 'Owned their mistakes in the report', owned ? owned.t : wrap.t, true, owned ? owned.q : null),
    ], broken.length ? [cap(3, 'Broke a spoken commitment, so this is capped at Proficient')] : []);
  }

  return Object.fromEntries(COMPETENCIES_ETCH.map((d) => [d.id, c[d.id]]));
}

// An indicator worth w points, of which `got` were earned. `quote` is the candidate's own words.
function pt(w, got, text, t = null, ok = got > 0, quote = null) {
  const e = { ok, text: quote || /[.!?]$/.test(text) ? text : `${text}.`, t: t ?? null };
  if (quote) e.quote = quote;
  return { w, got, e };
}
const skip = (text) => ({ w: 0, got: 0, skip: true, e: { ok: null, text: `${text}.`, t: null } });
const cap = (max, text, t = null) => ({ max, e: { ok: false, text: `${text}.`, t: t ?? null } });

function rate(via, parts, caps = []) {
  const used = parts.filter((p) => !p.skip);
  const total = used.reduce((s, p) => s + p.w, 0);
  if (!total) return unrated(via, 'Not enough evidence in this call');
  const score = Math.round((used.reduce((s, p) => s + p.got, 0) / total) * 100);
  const level = Math.min(levelOf(score), ...caps.map((x) => x.max));
  return { level, score, via, evidence: [...caps.map((x) => x.e), ...parts.map((p) => p.e)] };
}

function unrated(via, why) {
  return { level: null, score: null, via, evidence: [{ ok: null, text: `${why}.`, t: null }] };
}

function didText(a) {
  const tool = a.tool === FOCUS ? 'Etch 2' : a.tool || 'a tool';
  switch (a.action) {
    case 'ack_alarm': return `Acknowledged an alarm on ${tool}`;
    case 'hold_tool': return `Put ${tool} on hold`;
    case 'call_maintenance': return `Called maintenance for ${tool}`;
    case 'reset_resume': return `Reset and resumed ${tool}`;
    case 'emo': return `Pressed the EMO on ${tool}`;
    case 'reroute': return `Sent ${a.lot || 'a lot'} to ${a.to || 'another tool'}`;
    case 'notify_supervisor': return 'Messaged the supervisor';
    default: return ACTION_LABELS[a.action] || String(a.action);
  }
}

const sentencesOf = (text) => (String(text || '').match(/[^.!?]+[.!?]*/g) || []).map((s) => s.trim()).filter(Boolean);

// First candidate sentence (in time order) whose words match re.
function findSentence(lines, re) {
  for (const l of lines) {
    for (const s of sentencesOf(l.text)) if (re.test(words(s))) return { q: s, t: l.t ?? null };
  }
  return null;
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

const levelOrNull = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (v) => Math.round(v * 10) / 10;
const mmss = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
