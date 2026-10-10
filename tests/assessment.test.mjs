// Assessment builder tests (no browser needed): `node tests/assessment.test.mjs`
// FabTwin runs are simulated with the real ScenarioRunner + SessionLog + scoreSession, then merged
// with transcripts and Sam's tool logs. `--print-samples` prints the FabTwin data behind samples.js.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { ScenarioRunner } from '../src/scenario.js';
import { SessionLog } from '../src/log.js';
import { scoreSession } from '../src/scoring.js';
import {
  buildAssessment, toCredentialRecord, evidenceDigest, checkResult, shortQuote, levelOf,
  RUBRIC_ETCH, RUBRIC_META_ETCH, SCENARIO_ETCH, PASS_SCORE, COMPETENCIES_ETCH, COMPETENCY_GROUPS, LEVELS, BADGE_ETCH,
} from '../prototype/lib/assessment.js';
import { SAMPLE_RUNS, SAMPLE_CANDIDATES } from '../prototype/lib/samples.js';

const def = JSON.parse(readFileSync(new URL('../scenarios/etch2-pressure-fault.json', import.meta.url), 'utf8'));

// ---------- simulation ----------

// plan.steps: [t, 'zone' | 'ui' | 'act', data] in scenario seconds; plan.path: [t, x, z] waypoints.
function simulate(plan) {
  const log = new SessionLog();
  let endReason = null;
  const runner = new ScenarioRunner(def, {
    log,
    onEvent: (e) => {
      if (e.type === 'scenario_end') endReason = e.reason;
    },
  });
  runner.start();
  const steps = [...plan.steps];
  for (let t = 0; t <= 400 && !runner.ended; t = Math.round((t + 0.1) * 10) / 10) {
    log.t = t;
    runner.update(t);
    if (plan.path && Math.round(t * 10) % 5 === 0) {
      const p = posAt(plan.path, t);
      log.samplePosition(p.x, p.z, p.yaw);
    }
    while (steps.length && steps[0][0] <= t) {
      const [, kind, data] = steps.shift();
      if (kind !== 'act') {
        log.add(kind, data);
        continue;
      }
      const ok = data.action === 'reroute' ? runner.reroute(data.lot, data.to) : true;
      runner.act({ ...data, ok });
      if (data.action === 'end_shift') runner.end('ended_by_candidate');
    }
  }
  return { score: scoreSession(def, log.entries, log.positions), endReason, log };
}

function posAt(path, t) {
  let i = 0;
  while (i < path.length - 1 && path[i + 1][0] <= t) i++;
  const a = path[i];
  const b = path[i + 1] || a;
  const k = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
  const yaw = Math.round((Math.atan2(-(b[1] - a[1]), -(b[2] - a[2])) * 180) / Math.PI) || 0;
  return { x: a[1] + (b[1] - a[1]) * k, z: a[2] + (b[2] - a[2]) * k, yaw };
}

const act = (t, data) => [t, 'act', data];
const zone = (t, tool, enter = true) => [t, 'zone', { tool, enter }];
const ui = (t, name, tool) => [t, 'ui', tool ? { name, tool } : { name }];
const twinOf = ({ score, log }) => ({ score, log: log.toJSON(), def });
const pickScore = (s) => ({ overall: s.overall, rating: s.rating, skills: s.skills, metrics: s.metrics });

// The FabTwin side of the two dashboard samples (prototype/lib/samples.js).
const SAMPLE_PLANS = {
  jordan: {
    path: [[0, -0.5, 2.0], [4, -0.5, 2.0], [10, 0.1, -1.0], [15, 0.3, -4.6], [21, 0.4, -8.3], [25, 0.5, -11.0], [31, 0.2, -6.5], [34, 0.2, -5.5], [40, 0.6, -8.3]],
    steps: [
      zone(9, 'CVD-01'), zone(11, 'CVD-01', false), zone(14, 'ETCH-01'), zone(16, 'ETCH-01', false),
      zone(20, 'ETCH-02'), zone(22, 'ETCH-02', false), zone(40, 'ETCH-02'),
      ui(42, 'tool_panel_open', 'ETCH-02'),
      act(42, { action: 'inspect', tool: 'ETCH-02', source: 'tool_panel' }),
      act(46, { action: 'ack_alarm', tool: 'ETCH-02', source: 'tool_panel' }),
      act(48, { action: 'hold_tool', tool: 'ETCH-02', source: 'tool_panel' }),
      ui(50, 'tool_panel_close'),
      ui(56, 'dashboard_open'),
      act(58, { action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-01', source: 'dashboard' }),
      ui(62, 'dashboard_close'),
      ui(95, 'dashboard_open'),
      act(98, { action: 'notify_supervisor', text: 'Etch 2 on hold, chamber B pressure 182 vs 120 limit (E-4102). LOT-4471 moved to Etch 1.', source: 'dashboard' }),
      ui(100, 'dashboard_close'),
      ui(127, 'dashboard_open'),
      act(130, { action: 'end_shift', source: 'dashboard' }),
    ],
  },
  riley: {
    path: [[0, -0.5, 2.0], [6, -0.5, 2.0], [14, 0.0, -1.0], [22, 0.3, -4.6], [30, 0.0, -3.5], [37, -0.4, 0.4], [43, 0.0, -3.0], [50, 0.6, -8.3]],
    steps: [
      zone(12, 'CVD-01'), zone(15, 'CVD-01', false), zone(22, 'ETCH-01'), zone(26, 'ETCH-01', false),
      ui(33, 'dashboard_open'), ui(36, 'dashboard_close'),
      zone(50, 'ETCH-02'),
      ui(53, 'tool_panel_open', 'ETCH-02'),
      act(53, { action: 'inspect', tool: 'ETCH-02', source: 'tool_panel' }),
      act(67, { action: 'reset_resume', tool: 'ETCH-02', source: 'tool_panel' }),
      ui(71, 'tool_panel_close'),
      ui(99, 'tool_panel_open', 'ETCH-02'),
      act(99, { action: 'inspect', tool: 'ETCH-02', source: 'tool_panel' }),
      act(100, { action: 'ack_alarm', tool: 'ETCH-02', source: 'tool_panel' }),
      ui(102, 'tool_panel_close'),
      ui(125, 'dashboard_open'),
      act(128, { action: 'end_shift', source: 'dashboard' }),
    ],
  },
};

if (process.argv.includes('--print-samples')) {
  for (const [id, plan] of Object.entries(SAMPLE_PLANS)) {
    const { score, log, endReason } = simulate(plan);
    console.log(`// ${id}: ${endReason}`);
    console.log(JSON.stringify(pickScore(score)));
    for (const e of log.entries) console.log(JSON.stringify(e) + ',');
  }
  process.exit(0);
}

// ---------- live-style runs ----------

const BRIEF = "Morning. You're covering Bay 3 today. Walk the aisle and get to know the tools. Your terminal is on Tab.";
const ALARM = "I'm seeing an alarm on Etch 2 from here. Can you check it? LOT-4471 is due there in about ninety seconds.";
const PUSH_1 = "It does that all the time. Just hit reset and resume, we're already behind today.";
const PUSH_2 = "4471 is a hot lot for a customer. Don't move it, let it run on Etch 2.";
const WRAP = 'Okay. Give me the thirty-second version for the shift report.';
const a = (t, text) => ({ speaker: 'agent', t, text });
const c = (t, text) => ({ speaker: 'candidate', t, text });

// Everything right; FabTwin started 4.2 s into the call.
function exemplary() {
  const sim = simulate({
    steps: [
      zone(40, 'ETCH-02'),
      act(42, { action: 'inspect', tool: 'ETCH-02' }),
      act(46, { action: 'ack_alarm', tool: 'ETCH-02' }),
      act(50, { action: 'hold_tool', tool: 'ETCH-02' }),
      act(58, { action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-01' }),
      act(66, { action: 'call_maintenance', tool: 'ETCH-02', problem: 'Chamber pressure', priority: 'Urgent' }),
      act(75, { action: 'notify_supervisor', text: 'Etch 2 on hold, lot moved to Etch 1, maintenance called.' }),
    ],
  });
  const input = {
    candidate: { name: 'Sam Park', assessed_at: '2026-10-10T09:00:00Z' },
    callStartedAt: Date.parse('2026-10-10T09:00:00Z'),
    scenarioOffsetSec: 4.2,
    fabtwin: twinOf(sim),
    transcript: [
      a(5, BRIEF),
      c(11, 'Morning. Walking the bay.'),
      a(38, ALARM),
      c(44, 'Heading over.'),
      c(46.5, 'On the Etch 2 screen now. Chamber B is at 182, limit 120.'),
      a(49, PUSH_1),
      c(51.4, "No. I won't reset it with the pressure that high. I'm putting it on hold."),
      a(56, 'Okay.'),
      c(60, "I'm moving 4471 over to Etch 1."),
      a(64, 'Fine.'),
      c(68, "I'm calling maintenance for Etch 2."),
      a(74, 'Good, maintenance is on it.'),
      a(84, PUSH_2),
      c(87.3, "It's already on Etch 1, and I'm keeping it there. Etch 2 isn't safe to run."),
      a(92, 'Okay.'),
      a(125, '4471 is on Etch 1.'),
      a(134, WRAP),
      c(137, "Etch 2 alarmed on chamber pressure. It's on hold, 4471 went to Etch 1, and maintenance has a ticket."),
      a(150, "Thanks. That's the end of the exercise."),
    ],
    pressureMarks: [{ n: 1, t: 49 }, { n: 2, t: 84 }],
    stances: [
      { pressure: 1, stance: 'refused', quote: "I won't reset it with the pressure that high.", t: 56 },
      { pressure: 2, stance: 'refused', quote: "I'm keeping it there.", t: 92 },
    ],
    commitments: [
      { action: 'inspect', quote: 'On the Etch 2 screen now.', t: 49 },
      { action: 'hold_tool', quote: "I'm putting it on hold.", t: 56 },
      { action: 'reroute', quote: "I'm moving 4471 over to Etch 1.", t: 64 },
      { action: 'call_maintenance', quote: "I'm calling maintenance for Etch 2.", t: 74 },
    ],
    signals: { toneDrift: 9, toneDirection: 'stable', speechRateWpm: 150, speechRateDeltaPct: 3.456, hesitationScore: 88.123, meanLatencyMs: 600, fillerPer100: 0.5, deescalationLatencyS: null, composure: 90.456, driftSeries: [0, 5, 9], context: { rate: '150 words/min', avgPause: '0.6 s', longestPause: '1.5 s' } },
    wrapUp: { t: 137, text: "Etch 2 alarmed on chamber pressure. It's on hold, 4471 went to Etch 1, and maintenance has a ticket." },
    durationSec: 152.4,
  };
  return { sim, input };
}

// Takes both shortcuts: agrees to reset, resets, hits the EMO and sends the lot to the PM tool.
function unsafe() {
  const sim = simulate({
    steps: [
      act(45, { action: 'inspect', tool: 'ETCH-02' }),
      act(47, { action: 'reset_resume', tool: 'ETCH-02' }),
      act(70, { action: 'emo', tool: 'ETCH-02' }),
      act(80, { action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-03' }),
    ],
  });
  const input = {
    candidate: { name: 'Alex Moore', assessed_at: '2026-10-10T09:30:00Z' },
    scenarioOffsetSec: 0,
    fabtwin: twinOf(sim),
    transcript: [
      a(34, ALARM),
      c(44, 'Looking at it.'),
      a(46, PUSH_1),
      c(48.6, "Sure, I'll reset it."),
      a(84, PUSH_2),
      c(86, "It's going to Etch 3 instead."),
    ],
    pressureMarks: [{ n: 1, t: 46 }, { n: 2, t: 84 }],
    stances: [
      { pressure: 1, stance: 'complied', quote: "Sure, I'll reset it.", t: 50 },
      { pressure: 2, stance: 'unclear', quote: "It's going to Etch 3 instead.", t: 88 },
    ],
    commitments: [{ action: 'reset_resume', quote: "I'll reset it.", t: 50 }],
    durationSec: 120,
  };
  return { sim, input };
}

const candidateTimes = (r) => new Set(r.transcript.filter((l) => l.speaker === 'candidate').map((l) => l.t));
const vias = (r) => Object.fromEntries(RUBRIC_ETCH.map((x) => [x.id, r.items[x.id].via]));
const passed = (r) => RUBRIC_ETCH.filter((x) => r.items[x.id].passed).map((x) => x.id);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const levels = (r) => Object.fromEntries(Object.entries(r.competencies).map(([id, x]) => [id, x.level]));
const TECHNICAL = COMPETENCIES_ETCH.filter((x) => x.group === 'technical').map((x) => x.id);

// ---------- tests ----------

const tests = {
  'rubric, meta and scenario constants match the contract'() {
    assert.deepEqual(RUBRIC_ETCH.map((r) => r.id), ['a1', 'a2', 'a3', 'a4', 'v1', 'v2', 'v3', 'v4']);
    assert.deepEqual([...new Set(RUBRIC_ETCH.map((r) => r.section))], ['Procedure', 'Under pressure']);
    assert.deepEqual(RUBRIC_META_ETCH, { version: 'etch-v2', approvedBy: 'Dana Ruiz, EHS Lead', approvedOn: 'Oct 10, 2026' });
    assert.deepEqual(SCENARIO_ETCH, { id: 'etch2-pressure-fault', title: 'Etch 2 chamber pressure fault', company: 'Example Fab Co.', role: 'Equipment Technician' });
    assert.equal(PASS_SCORE, 6);
  },

  'exemplary run: 8/8 pass, evidence from voice and the twin'() {
    const { sim, input } = exemplary();
    assert.equal(sim.endReason, 'complete');
    const r = buildAssessment(input);
    assert.deepEqual(checkResult(r), []);
    assert.deepEqual(r.result, { status: 'pass', score: 8, max_score: 8, auto_fail: false, auto_fail_reason: null });
    assert.deepEqual(vias(r), { a1: 'both', a2: 'both', a3: 'both', a4: 'both', v1: 'both', v2: 'both', v3: 'both', v4: 'both' });
    // Action items: scenario time + 4.2 s offset, described with time since the alarm
    assert.equal(r.items.a1.t, 46.2);
    assert.equal(r.items.a1.evidence, 'Opened the Etch 2 control screen 12 s after the alarm.');
    assert.equal(r.items.a2.evidence, 'Put Etch 2 on hold 20 s after the alarm.');
    assert.equal(r.items.a3.evidence, 'Rerouted LOT-4471 to ETCH-01 28 s after the alarm.');
    assert.equal(r.items.a4.t, 70.2);
    // Voice items quote the candidate at their transcript line
    assert.deepEqual(r.items.v1, { passed: true, evidence: "I won't reset it with the pressure that high.", t: 51.4, via: 'both' });
    assert.equal(r.items.v2.t, 87.3);
    assert.equal(r.items.v3.t, 137);
    assert.equal(r.items.v4.evidence, "I'm putting it on hold.");
    assert.ok(Object.values(r.items).every((it) => !it.critical));
    // Timing
    assert.deepEqual(r.timing.pressure, { value: 2.4, label: 'Pressure line to refusal', detail: 'Refused the reset, then held firm on the hot lot.' });
    assert.equal(r.timing.safe.value, sim.score.metrics.timeToSafe);
    assert.equal(r.timing.safe.value, 28);
    assert.equal(r.timing.safe.detail, 'Etch 2 on hold 20 s and LOT-4471 rerouted 28 s after the alarm.');
    assert.deepEqual(r.timing.context, { rate: '150 words/min', avgPause: '0.6 s', longestPause: '1.5 s' });
    // Said vs did: commitments matched to actions, unspoken actions listed with said: null
    assert.deepEqual(r.saidVsDid, [
      { action: 'inspect', said: { t: 46.5, quote: 'On the Etch 2 screen now.' }, did: { t: 46.2 } },
      { action: 'ack_alarm', said: null, did: { t: 50.2 } },
      { action: 'hold_tool', said: { t: 51.4, quote: "I'm putting it on hold." }, did: { t: 54.2 } },
      { action: 'reroute', said: { t: 60, quote: "I'm moving 4471 over to Etch 1." }, did: { t: 62.2 } },
      { action: 'call_maintenance', said: { t: 68, quote: "I'm calling maintenance for Etch 2." }, did: { t: 70.2 } },
      { action: 'notify_supervisor', said: null, did: { t: 79.2 } },
    ]);
    // Signals pass through; de-escalation falls back to the measured refusal time
    assert.equal(r.signals.deescalationLatencyS, 2.4);
    assert.deepEqual(r.signals.driftSeries, [0, 5, 9]);
    assert.ok(!('context' in r.signals));
    assert.deepEqual(r.fabtwin, pickScore(sim.score));
    assert.equal(r.fabtwin.overall, 100);
    assert.deepEqual(r.candidate, { name: 'Sam Park', initials: 'SP', role: 'Equipment Technician', assessed_at: '2026-10-10T09:00:00Z' });
    assert.deepEqual(r.scenario, { id: 'etch2-pressure-fault', title: 'Etch 2 chamber pressure fault', duration_sec: 152 });
  },

  'unsafe run: reset + EMO is an automatic fail with a critical item'() {
    const { sim, input } = unsafe();
    const r = buildAssessment(input);
    assert.deepEqual(checkResult(r), []);
    assert.equal(r.result.status, 'fail');
    assert.equal(r.result.auto_fail, true);
    assert.match(r.result.auto_fail_reason, /^Reset the Etch 2 alarm and resumed processing without maintenance, after agreeing to the shortcut\./);
    assert.match(r.result.auto_fail_reason, /a wafer was scrapped/);
    assert.match(r.result.auto_fail_reason, /Pressed the EMO on ETCH-02 when nobody was in danger\./);
    assert.deepEqual(r.items.v1, { passed: false, evidence: "Sure, I'll reset it.", t: 48.6, via: 'both', critical: true });
    assert.equal(r.items.a2.evidence, 'Reset Etch 2 and resumed it 17 s after the alarm instead of putting it on hold.');
    assert.equal(r.items.a2.t, 47);
    assert.equal(r.items.a2.via, 'both');
    assert.equal(r.items.a3.evidence, 'Sent LOT-4471 to ETCH-03, a tool down for maintenance, 50 s after the alarm instead of ETCH-01.');
    // Lot never reached Etch 2 and the push answer was unclear: kept off by action
    assert.deepEqual(r.items.v2, { passed: true, evidence: 'Moved LOT-4471 to ETCH-03 before it reached Etch 2.', t: 80, via: 'action' });
    assert.deepEqual(passed(r), ['a1', 'v2', 'v4']); // said "reset" and did reset: consistent, but auto-fail rules
    assert.deepEqual(r.timing.pressure, { value: null, label: 'Pressure line to refusal', detail: 'Agreed to reset and resume 2.6 s after it was suggested.' });
    assert.equal(r.timing.safe.value, null);
    assert.equal(r.timing.safe.detail, 'No safe state. Etch 2 was reset instead of held, and LOT-4471 was not rerouted to ETCH-01.');
    assert.equal(r.fabtwin.overall, sim.score.overall);
    assert.equal(r.fabtwin.overall, 0);
    assert.deepEqual(r.saidVsDid.map((x) => [x.action, !!x.said, !!x.did]), [
      ['inspect', false, true], ['reset_resume', true, true], ['emo', false, true], ['reroute', false, true],
    ]);
  },

  'EMO alone fails the hold item as critical'() {
    const sim = simulate({ steps: [act(40, { action: 'inspect', tool: 'ETCH-02' }), act(44, { action: 'emo', tool: 'ETCH-02' })] });
    const r = buildAssessment({ candidate: { name: 'Kim' }, fabtwin: twinOf(sim), scenarioOffsetSec: 2 });
    assert.equal(r.result.auto_fail, true);
    assert.equal(r.result.auto_fail_reason, 'Pressed the EMO on ETCH-02 when nobody was in danger.');
    assert.deepEqual(r.items.a2, { passed: false, evidence: 'Pressed the EMO 14 s after the alarm instead of putting Etch 2 on hold.', t: 46, via: 'action', critical: true });
  },

  'checking Etch 2 before the alarm does not count as the response check'() {
    const sim = simulate({ steps: [act(20, { action: 'inspect', tool: 'ETCH-02' }), act(150, { action: 'end_shift' })] });
    const r = buildAssessment({ fabtwin: twinOf(sim) });
    assert.deepEqual(r.items.a1, { passed: false, evidence: 'Never opened the Etch 2 control screen.', t: null, via: 'action' });
    assert.equal(r.items.v2.evidence, 'LOT-4471 landed on Etch 2 90 s after the alarm.');
  },

  'a spoken promise that is not kept fails "did what they said"'() {
    const sim = simulate({
      steps: [
        act(42, { action: 'inspect', tool: 'ETCH-02' }),
        act(50, { action: 'hold_tool', tool: 'ETCH-02' }),
        act(58, { action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-01' }),
        act(140, { action: 'end_shift' }),
      ],
    });
    const r = buildAssessment({
      candidate: { name: 'Lee' },
      fabtwin: twinOf(sim),
      transcript: [c(52, "I'll call maintenance for Etch 2 right after this."), c(60, "I'm moving 4471 to Etch 3.")],
      commitments: [
        { action: 'call_maintenance', quote: "I'll call maintenance for Etch 2 right after this.", t: 54 },
        { action: 'reroute', quote: "I'm moving 4471 to Etch 3.", t: 62 },
      ],
    });
    assert.deepEqual(r.items.a4, { passed: false, evidence: "I'll call maintenance for Etch 2 right after this.", t: 52, via: 'voice' });
    assert.equal(r.items.v4.passed, false);
    assert.equal(r.items.v4.t, 52);
    // Said Etch 3, did Etch 1: the tool named aloud must match
    assert.deepEqual(r.saidVsDid.find((x) => x.action === 'reroute').did, null);
    assert.equal(r.items.a3.passed, true);
  },

  'call ended early: no FabTwin data and empty inputs still give a valid result'() {
    for (const input of [undefined, {}, { candidate: { name: 'Pat Doe' }, fabtwin: null, transcript: null, stances: null, commitments: [], pressureMarks: null, signals: null, wrapUp: null }]) {
      const r = buildAssessment(input);
      assert.deepEqual(checkResult(r), []);
      assert.equal(r.result.score, 0);
      assert.equal(r.result.status, 'fail');
      assert.equal(r.result.auto_fail, false);
      assert.equal(r.fabtwin, null);
      assert.equal(r.items.a1.evidence, 'No 3D twin data for this call.');
      assert.equal(r.timing.pressure.value, null);
      assert.equal(r.timing.safe.value, null);
      assert.deepEqual(r.timing.context, { rate: 'Not measured', avgPause: 'Not measured', longestPause: 'Not measured' });
      assert.deepEqual(r.saidVsDid, []);
      assert.deepEqual(r.transcript, []);
    }
    // Voice items still work without the twin
    const { input } = exemplary();
    const r = buildAssessment({ ...input, fabtwin: null });
    assert.deepEqual(passed(r), ['v1', 'v2', 'v3']);
    assert.equal(r.items.v1.via, 'voice');
    assert.equal(r.items.v4.evidence, 'No 3D twin data to check against.');
  },

  'FabTwin score is computed from the log when it is missing'() {
    const { sim, input } = exemplary();
    const r = buildAssessment({ ...input, fabtwin: { score: null, log: sim.log.toJSON(), def } });
    assert.deepEqual(r.fabtwin, pickScore(scoreSession(def, sim.log.entries, sim.log.positions)));
    assert.equal(r.result.score, 8);
  },

  "without Sam's tool logs, stances, commitments and the wrap-up come from the transcript"() {
    const bare = (run) => ({ ...run, pressureMarks: [], stances: [], commitments: [], wrapUp: null });
    const j = buildAssessment(bare(SAMPLE_RUNS.jordan));
    assert.deepEqual(passed(j), passed(SAMPLE_CANDIDATES.jordan));
    assert.equal(j.timing.pressure.value, 2.5);
    assert.deepEqual(j.saidVsDid.filter((x) => x.said).map((x) => x.action), ['inspect', 'hold_tool', 'reroute', 'notify_supervisor']);
    const r = buildAssessment(bare(SAMPLE_RUNS.riley));
    assert.equal(r.items.v1.critical, true);
    assert.equal(r.items.v1.t, 64.8);
    assert.equal(r.items.v2.passed, false);
    assert.match(r.timing.pressure.detail, /^Agreed to reset and resume/);
    assert.equal(r.items.v4.passed, false); // "I'll get maintenance to look at it" was never done
    // "I'm keeping it there" (on Etch 1) refuses the hot-lot push
    const e = buildAssessment(bare(exemplary().input));
    assert.equal(e.result.score, 8);
    assert.equal(e.items.v2.t, 87.3);
    assert.equal(e.timing.pressure.value, 2.4);
    // Questions and refusals are not promises
    const q = buildAssessment({
      transcript: [c(10, "Should I reset it? No, I'm not resetting it. I'll put Etch 2 on hold, and I'm calling maintenance.")],
    });
    assert.deepEqual(q.saidVsDid.map((x) => [x.action, x.said.quote]), [['hold_tool', "I'll put Etch 2 on hold."], ['call_maintenance', "I'm calling maintenance."]]);
  },

  'epoch-millisecond times are converted to call seconds'() {
    const start = Date.parse('2026-10-10T10:00:00Z');
    const r = buildAssessment({
      callStartedAt: start,
      transcript: [{ speaker: 'agent', t: start + 46000, text: PUSH_1 }, { speaker: 'user', t: start + 48250, text: 'No, not resetting it.' }],
      pressureMarks: [{ n: 1, t: start + 46000 }],
      stances: [{ pressure: 1, stance: 'refused', quote: 'not resetting it', t: start + 50000 }],
    });
    assert.deepEqual(r.transcript.map((l) => [l.speaker, l.t]), [['agent', 46], ['candidate', 48.3]]);
    assert.deepEqual(r.items.v1, { passed: true, evidence: 'not resetting it', t: 48.3, via: 'voice' });
    assert.equal(r.timing.pressure.value, 2.3);
    assert.equal(r.candidate.assessed_at, '2026-10-10T10:00:00.000Z');
  },

  'cue lines are dropped and long quotes are shortened'() {
    const r = buildAssessment({ transcript: [a(1, '[FAB EVENT] ALARM'), c(2, 'Hi.')] });
    assert.deepEqual(r.transcript, [{ speaker: 'candidate', t: 2, text: 'Hi.' }]);
    assert.equal(shortQuote('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen'), 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen…');
    assert.equal(shortQuote('Etch 2 alarmed on chamber B pressure, 182 against a 120 limit. I put it on hold and moved 4471 to Etch 1.'), 'Etch 2 alarmed on chamber B pressure, 182 against a 120 limit.');
  },

  async 'toCredentialRecord: contract key order, booleans, rounded signals, digest'() {
    const { input } = exemplary();
    const result = buildAssessment(input);
    const rec = await toCredentialRecord(result);
    assert.deepEqual(Object.keys(rec), ['issuer', 'assessment', 'scenario_id', 'company', 'rubric_version', 'rubric_approved_by', 'candidate', 'role', 'assessed_at', 'status', 'score', 'max_score', 'auto_fail', 'items', 'competencies', 'signals', 'evidence_digest']);
    assert.equal(rec.issuer, 'IndustryProof');
    assert.equal(rec.assessment, 'Etch 2 chamber pressure fault');
    assert.equal(rec.rubric_version, 'etch-v2');
    // Competencies: levels only, in rubric order
    assert.deepEqual(Object.keys(rec.competencies), COMPETENCIES_ETCH.map((x) => x.id));
    assert.deepEqual(rec.competencies, levels(result));
    assert.equal(rec.rubric_approved_by, 'Dana Ruiz, EHS Lead');
    assert.deepEqual(rec.items, { a1: true, a2: true, a3: true, a4: true, v1: true, v2: true, v3: true, v4: true });
    assert.deepEqual(Object.keys(rec.signals), ['tone_drift', 'speech_rate_delta_pct', 'hesitation_score', 'deescalation_latency_s', 'composure']);
    assert.deepEqual(rec.signals, { tone_drift: 9, speech_rate_delta_pct: 3.5, hesitation_score: 88.12, deescalation_latency_s: 2.4, composure: 90.46 });
    assert.match(rec.evidence_digest, /^sha256:[0-9a-f]{64}$/);
    const expected = 'sha256:' + sha256(JSON.stringify({ transcript: result.transcript, saidVsDid: result.saidVsDid, items: result.items }));
    assert.equal(rec.evidence_digest, expected);
    assert.equal(await evidenceDigest(result), expected);
    // Any change to the evidence changes the digest
    const edited = structuredClone(result);
    edited.transcript[1].text = 'Something else.';
    assert.notEqual(await evidenceDigest(edited), expected);
    assert.equal((await toCredentialRecord(result, { issuer: 'Other' })).issuer, 'Other');
    // Null-safe on an empty result
    const empty = await toCredentialRecord(buildAssessment({ candidate: { name: 'X', assessed_at: '2026-10-10T00:00:00Z' } }));
    assert.deepEqual(empty.signals, { tone_drift: null, speech_rate_delta_pct: null, hesitation_score: null, deescalation_latency_s: null, composure: null });
    assert.ok(Object.values(empty.competencies).every((v) => v === null));
  },

  'competency rubric: 11 ids in two groups, anchors at 1, 3 and 5, level bands'() {
    assert.deepEqual(COMPETENCIES_ETCH.map((x) => x.id), [
      'procedure', 'deliberate_action', 'safety_judgment', 'fab_tools', 'situational_awareness',
      'composure', 'clarifying_questions', 'problem_solving', 'integrity', 'collaboration', 'ownership',
    ]);
    assert.deepEqual(COMPETENCY_GROUPS.map((g) => g.id), ['technical', 'behavioural']);
    for (const x of COMPETENCIES_ETCH) {
      assert.ok(COMPETENCY_GROUPS.some((g) => g.id === x.group), x.id);
      assert.ok(x.label && x.definition && x.sources.length, x.id);
      assert.deepEqual(Object.keys(x.anchors), ['1', '3', '5'], x.id);
    }
    assert.equal(COMPETENCIES_ETCH.find((x) => x.id === 'fab_tools').label, 'Working with semiconductor fab tools');
    assert.match(COMPETENCIES_ETCH.find((x) => x.id === 'composure').note, /never affects pass or fail/);
    assert.deepEqual(Object.keys(LEVELS), ['1', '2', '3', '4', '5']);
    assert.deepEqual([0, 34, 35, 54, 55, 74, 75, 89, 90, 100].map(levelOf), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    assert.ok(BADGE_ETCH.name && BADGE_ETCH.description && BADGE_ETCH.criteria);
  },

  'competencies: exemplary run is 5 everywhere except questions it never asked'() {
    const r = buildAssessment(exemplary().input);
    assert.deepEqual(levels(r), {
      procedure: 5, deliberate_action: 5, safety_judgment: 5, fab_tools: 5, situational_awareness: 5,
      composure: 5, clarifying_questions: 3, problem_solving: 5, integrity: 5, collaboration: 5, ownership: 5,
    });
    assert.equal(r.competencies.procedure.score, 100);
    assert.equal(r.competencies.clarifying_questions.evidence[0].text, 'Asked Sam no questions about the situation.');
    assert.equal(r.competencies.fab_tools.evidence[0].quote, 'Chamber B is at 182, limit 120.');
    assert.equal(r.competencies.composure.via, 'voice');
    // Competencies never change pass/fail
    assert.deepEqual(r.result, { status: 'pass', score: 8, max_score: 8, auto_fail: false, auto_fail_reason: null });
  },

  'competencies: unsafe shortcuts cap safety and integrity at 1'() {
    const r = buildAssessment(unsafe().input);
    const l = levels(r);
    assert.equal(l.safety_judgment, 1);
    assert.equal(l.integrity, 1);
    assert.ok(l.deliberate_action <= 2);
    assert.equal(l.composure, null); // no voice signals in this run: not assessed, not a 1
    assert.equal(r.competencies.safety_judgment.evidence[0].ok, false);
    assert.match(r.competencies.safety_judgment.evidence[0].text, /safety bypass/);
    assert.match(r.competencies.safety_judgment.evidence.map((e) => e.text).join(' '), /ETCH-03, which is down for planned maintenance/);
  },

  'competencies: without the twin, technical ones are not assessed and voice ones still are'() {
    const r = buildAssessment({ ...exemplary().input, fabtwin: null });
    assert.deepEqual(checkResult(r), []);
    for (const id of TECHNICAL) {
      assert.equal(r.competencies[id].level, null, id);
      assert.equal(r.competencies[id].evidence[0].text, 'No 3D twin data for this call.');
    }
    assert.equal(r.competencies.composure.level, 5);
    assert.equal(r.competencies.integrity.level, 5);
    assert.equal(r.competencies.collaboration.level, 5); // the twin-only indicators are skipped, not zeroed
    assert.equal(r.competencies.ownership.level, null);
    for (const r0 of [buildAssessment(), buildAssessment({})]) {
      assert.ok(Object.values(r0.competencies).every((x) => x.level === null && x.score === null && x.evidence.length === 1));
    }
  },

  'competencies: checkResult rejects a bad level'() {
    const r = structuredClone(SAMPLE_CANDIDATES.jordan);
    r.competencies.integrity.level = 6;
    assert.deepEqual(checkResult(r), ['competencies.integrity.level is 6']);
    delete r.competencies.ownership;
    assert.ok(checkResult(r).some((e) => e.startsWith('competency ids are')));
  },

  'samples: FabTwin logs and scores are real simulation output'() {
    for (const [id, plan] of Object.entries(SAMPLE_PLANS)) {
      const { score, log, endReason } = simulate(plan);
      assert.equal(endReason, 'ended_by_candidate', id);
      assert.deepEqual(SAMPLE_RUNS[id].fabtwin.log.entries, log.entries, `${id} log`);
      assert.deepEqual(SAMPLE_RUNS[id].fabtwin.score, pickScore(score), `${id} score`);
    }
  },

  'samples: contract shape, and every evidence time is a transcript line'() {
    assert.deepEqual(Object.keys(SAMPLE_CANDIDATES), ['jordan', 'riley']);
    for (const [id, r] of Object.entries(SAMPLE_CANDIDATES)) {
      assert.deepEqual(checkResult(r), [], id);
      assert.deepEqual(Object.keys(r.items), RUBRIC_ETCH.map((x) => x.id), id);
      const said = candidateTimes(r);
      for (const x of RUBRIC_ETCH) {
        const it = r.items[x.id];
        if (it.t !== null) assert.ok(said.has(it.t), `${id}.${x.id} t=${it.t} has no candidate line`);
      }
      for (const row of r.saidVsDid) if (row.said) assert.ok(said.has(row.said.t), `${id} said ${row.action}`);
      assert.deepEqual(Object.keys(r.signals), ['toneDrift', 'toneDirection', 'speechRateWpm', 'speechRateDeltaPct', 'hesitationScore', 'meanLatencyMs', 'fillerPer100', 'deescalationLatencyS', 'composure', 'driftSeries']);
      assert.equal(r.signals.driftSeries.length, r.transcript.filter((l) => l.speaker === 'candidate').length, `${id} drift per turn`);
      assert.ok(r.fabtwin && typeof r.fabtwin.overall === 'number');
    }
  },

  'samples: Jordan passes 7/8 with no said-vs-did gap'() {
    const r = SAMPLE_CANDIDATES.jordan;
    assert.deepEqual(r.result, { status: 'pass', score: 7, max_score: 8, auto_fail: false, auto_fail_reason: null });
    assert.deepEqual(passed(r), ['a1', 'a2', 'a3', 'v1', 'v2', 'v3', 'v4']);
    assert.equal(r.items.a4.evidence, 'Never called maintenance for Etch 2.');
    assert.ok(r.saidVsDid.every((x) => !x.said || x.did));
    assert.equal(r.timing.pressure.value, 2.5);
    assert.equal(r.timing.safe.value, 28);
    assert.equal(r.fabtwin.overall, 80);
    assert.deepEqual(r.timing.context, { rate: '152 words/min', avgPause: '0.6 s', longestPause: '1.8 s' });
  },

  'samples: Riley agrees to the reset, resets, and the lot lands on Etch 2'() {
    const r = SAMPLE_CANDIDATES.riley;
    assert.equal(r.result.status, 'fail');
    assert.equal(r.result.auto_fail, true);
    assert.equal(r.result.auto_fail_reason, 'Reset the Etch 2 alarm and resumed processing without maintenance, after agreeing to the shortcut. The alarm came back and a wafer was scrapped.');
    assert.deepEqual(passed(r), ['a1', 'v3']);
    assert.equal(r.items.v1.critical, true);
    assert.equal(r.items.v1.evidence, "If it does it all the time, I'll just reset it.");
    assert.equal(r.items.a3.evidence, 'Never rerouted LOT-4471, so it landed on Etch 2.');
    assert.deepEqual(r.saidVsDid.map((x) => [x.action, x.said?.t ?? null, x.did?.t ?? null]), [
      ['inspect', 56, 56], ['reset_resume', 64.8, 70], ['call_maintenance', 86, null], ['ack_alarm', 103, 103],
    ]);
    assert.equal(r.timing.pressure.value, null);
    assert.equal(r.timing.pressure.detail, 'Agreed to reset and resume 5.3 s after it was suggested.');
    assert.equal(r.timing.safe.detail, 'No safe state. Etch 2 was reset instead of held, and LOT-4471 landed on it.');
    assert.equal(r.fabtwin.overall, 0);
  },

  'samples: competency levels'() {
    // Jordan: strong all round, missed maintenance, asked no questions
    assert.deepEqual(levels(SAMPLE_CANDIDATES.jordan), {
      procedure: 4, deliberate_action: 5, safety_judgment: 5, fab_tools: 5, situational_awareness: 5,
      composure: 4, clarifying_questions: 3, problem_solving: 4, integrity: 5, collaboration: 4, ownership: 5,
    });
    // Riley: unsafe, but asked a question and owned the reset in the report
    assert.deepEqual(levels(SAMPLE_CANDIDATES.riley), {
      procedure: 1, deliberate_action: 2, safety_judgment: 1, fab_tools: 1, situational_awareness: 1,
      composure: 2, clarifying_questions: 4, problem_solving: 1, integrity: 1, collaboration: 2, ownership: 3,
    });
    const own = SAMPLE_CANDIDATES.riley.competencies.ownership;
    assert.equal(own.score, 85); // capped at 3 by the broken maintenance promise
    assert.equal(own.evidence[0].text, 'Broke a spoken commitment, so this is capped at Proficient.');
    assert.deepEqual(SAMPLE_CANDIDATES.riley.competencies.clarifying_questions.evidence[0], {
      ok: true, text: 'Asked a question about the situation', t: 43.5, quote: 'Which one is Etch 2?',
    });
  },

  'samples: every competency evidence time is a transcript line or a 3D log entry'() {
    for (const [id, r] of Object.entries(SAMPLE_CANDIDATES)) {
      const run = SAMPLE_RUNS[id];
      const times = new Set(r.transcript.map((l) => l.t));
      for (const e of run.fabtwin.log.entries) times.add(Math.round((e.t + run.scenarioOffsetSec) * 10) / 10);
      for (const [cid, x] of Object.entries(r.competencies)) {
        for (const e of x.evidence) if (e.t !== null) assert.ok(times.has(e.t), `${id}.${cid} "${e.text}" t=${e.t}`);
      }
    }
  },

  async 'samples: credential records build in the contract order'() {
    for (const r of Object.values(SAMPLE_CANDIDATES)) {
      const rec = await toCredentialRecord(r);
      assert.equal(rec.candidate, r.candidate.name);
      assert.equal(rec.score, r.result.score);
      assert.match(rec.evidence_digest, /^sha256:[0-9a-f]{64}$/);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e.message.split('\n').join('\n  ')}`);
  }
}
process.exit(failed ? 1 : 0);
