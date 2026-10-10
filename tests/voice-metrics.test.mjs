// Voice-signal tests (no browser needed): `node tests/voice-metrics.test.mjs`
// Builds synthetic mic frames for a calm baseline, a tense pressure answer, a flat answer
// and silence, and checks segmentation, per-turn metrics, the session summary and the
// tracker glue.
import assert from 'node:assert/strict';
import {
  FRAME_MS,
  rmsDb,
  detectPitch,
  segmentUtterances,
  findTurnSpan,
  countFillers,
  countWords,
  computeTurn,
  summarizeSignals,
  toRecordSignals,
  createTurnTracker,
  createMicAnalyzer,
} from '../prototype/lib/voice-metrics.js';
import { describeSignals, mountSignalPanel } from '../prototype/lib/signal-panel.js';

/* ---------- synthetic data ---------- */

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

// Frames every 50 ms. speech: [{ start, end, pitch, sdSt, db, dbSd, gaps: [[a, b]] }],
// agent: [[a, b]] (Sam talking; echo leaks in as voiced frames).
function makeFrames({ from = 0, to, speech = [], agent = [], noiseDb = -62, seed = 1 }) {
  const r = rng(seed);
  const out = [];
  for (let t = from; t < to; t += FRAME_MS) {
    const ag = agent.some(([a, b]) => t >= a && t < b);
    const sp = speech.find((s) => t >= s.start && t < s.end && !(s.gaps || []).some(([a, b]) => t >= a && t < b));
    if (ag) out.push({ t, rmsDb: -38 + gauss(r), pitchHz: 110 + 5 * gauss(r), voiced: true, agentSpeaking: true });
    else if (sp && r() > 0.12) {
      const hz = sp.pitch * 2 ** ((gauss(r) * sp.sdSt) / 12);
      out.push({ t, rmsDb: sp.db + gauss(r) * (sp.dbSd ?? 2), pitchHz: Math.round(hz * 10) / 10, voiced: true, agentSpeaking: false });
    } else out.push({ t, rmsDb: noiseDb + gauss(r), pitchHz: 0, voiced: false, agentSpeaking: false });
  }
  return out;
}

const VOCAB = ['etch', 'two', 'chamber', 'pressure', 'reads', 'high', 'so', 'I', 'will', 'hold', 'the', 'tool', 'and', 'move', 'lot', 'over', 'to', 'one', 'now', 'first'];
const words = (n, extra = '') => (extra ? extra + ' ' : '') + Array.from({ length: n }, (_, i) => VOCAB[i % VOCAB.length]).join(' ') + '.';

// One turn with a voice profile. Words are sized to hit `wpm` over `durMs`.
const PROFILES = {
  calm: { pitch: 120, sdSt: 1.2, db: -30, dbSd: 2, wpm: 150, latencyMs: 700 },
  calm2: { pitch: 122, sdSt: 1.3, db: -30.5, dbSd: 2, wpm: 145, latencyMs: 800 },
  tense: { pitch: 150, sdSt: 2.3, db: -25, dbSd: 3, wpm: 185, latencyMs: 450 },
  flat: { pitch: 108, sdSt: 0.45, db: -36, dbSd: 1, wpm: 110, latencyMs: 2600, gaps: [[3000, 4300]], fillers: 'Um, I mean, uh,' },
};
function turn(kind, { at = 0, durMs = 6000, seed = 7, underPressure = false } = {}) {
  const p = PROFILES[kind];
  const promptEndedAt = at;
  const start = at + p.latencyMs;
  const end = start + durMs;
  const gaps = (p.gaps || []).map(([a, b]) => [start + a, start + b]);
  const frames = makeFrames({ from: at - 500, to: end + 800, speech: [{ start, end, pitch: p.pitch, sdSt: p.sdSt, db: p.db, dbSd: p.dbSd, gaps }], seed });
  const fillerWords = p.fillers ? countWords(p.fillers) : 0;
  const text = words(Math.round((p.wpm * durMs) / 60000) - fillerWords, p.fillers);
  const span = findTurnSpan(frames, { from: promptEndedAt, to: end + 800 });
  return computeTurn({ text, start: span.start, end: span.end, frames, promptEndedAt, underPressure });
}

// No NaN / Infinity anywhere in a result.
function assertFinite(v, path = 'value') {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} is ${v}`);
  else if (Array.isArray(v)) v.forEach((x, i) => assertFinite(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`);
}

function sine(hz, sr, n, amp = 0.1) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * hz * i) / sr;
    out[i] = amp * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)); // voice-like harmonics
  }
  return out;
}

/* ---------- tests ---------- */

const tests = {
  'rmsDb and YIN pitch on synthetic signals'() {
    assert.ok(Math.abs(rmsDb(sine(150, 16000, 682, 0.1)) - -21.1) < 1);
    assert.equal(rmsDb(new Float32Array(682)), -100);
    for (const hz of [85, 120, 150, 220, 330]) {
      for (const sr of [16000, 22050]) {
        const n = sr === 16000 ? 682 : 1024;
        const got = detectPitch(sine(hz, sr, n), sr).hz;
        assert.ok(Math.abs(got - hz) / hz < 0.02, `${hz} Hz at ${sr}: got ${got}`);
      }
    }
    const r = rng(3);
    const noise = Float32Array.from({ length: 682 }, () => (r() * 2 - 1) * 0.1);
    assert.equal(detectPitch(noise, 16000).hz, 0);
    assert.equal(detectPitch(new Float32Array(682), 16000).hz, 0);
  },

  'segmentation bridges short gaps, splits long ones, drops blips and ignores echo'() {
    const frames = makeFrames({
      to: 12000,
      speech: [
        { start: 1000, end: 3000, pitch: 120, sdSt: 1, db: -30, gaps: [[2000, 2400]] }, // 400 ms gap: same utterance
        { start: 4000, end: 5000, pitch: 120, sdSt: 1, db: -30 }, // 1 s later: new utterance
        { start: 6000, end: 6100, pitch: 120, sdSt: 1, db: -30 }, // 100 ms blip: dropped
      ],
      agent: [[7000, 9500]], // echo of Sam: never candidate speech
      seed: 11,
    });
    const segs = segmentUtterances(frames);
    assert.equal(segs.length, 2, JSON.stringify(segs));
    assert.ok(Math.abs(segs[0].start - 1000) <= 150 && Math.abs(segs[0].end - 3000) <= 150, JSON.stringify(segs[0]));
    assert.ok(Math.abs(segs[1].start - 4000) <= 150 && Math.abs(segs[1].end - 5000) <= 150, JSON.stringify(segs[1]));
    const span = findTurnSpan(frames, { from: 500, to: 6500 });
    assert.equal(span.utterances, 2);
    assert.ok(span.end - span.start > 3800);
    assert.equal(findTurnSpan(frames, { from: 6500, to: 12000 }), null); // only the blip and echo
    assert.deepEqual(segmentUtterances([]), []);
    assert.deepEqual(segmentUtterances(null), []);
  },

  'Sam starting to talk closes the candidate utterance at once'() {
    const frames = makeFrames({ to: 5000, speech: [{ start: 500, end: 2500, pitch: 130, sdSt: 1, db: -30 }], agent: [[2500, 4000]], seed: 5 });
    const segs = segmentUtterances(frames);
    assert.equal(segs.length, 1);
    assert.ok(segs[0].end <= 2550, JSON.stringify(segs));
  },

  'filler lexicon counts filler senses only'() {
    assert.equal(countFillers('Um, I mean, like, it is kind of stuck, you know.'), 5);
    assert.equal(countFillers('I like this kind of tool. What kind of alarm is it?'), 0);
    assert.equal(countFillers('Do you know where the gauge is? What I mean is the chamber.'), 0);
    assert.equal(countFillers('Basically the pressure is actually high, uh, hmm, er, erm.'), 6);
    assert.equal(countFillers('It looks like the valve. Like, I was like no.'), 2);
    assert.equal(countFillers('It is sort of high'), 1);
    assert.equal(countFillers(''), 0);
    assert.equal(countFillers(null), 0);
    assert.equal(countWords("I'll hold Etch 2, then call maintenance."), 7);
  },

  'per-turn metrics: latency, pace, fillers, pauses, pitch'() {
    const calm = turn('calm');
    assert.ok(Math.abs(calm.latencyMs - 700) <= 150, `latency ${calm.latencyMs}`);
    assert.ok(Math.abs(calm.wpm - 150) <= 15, `wpm ${calm.wpm}`);
    assert.equal(calm.fillerCount, 0);
    assert.equal(calm.longPauses, 0);
    assert.ok(Math.abs(calm.pitchMeanHz - 120) < 5, `pitch ${calm.pitchMeanHz}`);
    assert.ok(Math.abs(calm.energyMeanDb - -30) < 1.5);
    const flat = turn('flat');
    assert.ok(Math.abs(flat.latencyMs - 2600) <= 150);
    assert.equal(flat.fillerCount, 3);
    assert.ok(flat.fillerPer100 > 15);
    assert.equal(flat.longPauses, 1);
    assert.ok(flat.longestPauseMs >= 1100);
    assert.ok(flat.pitchSdSt < calm.pitchSdSt);
    assertFinite(calm);
    assertFinite(flat);
  },

  'per-turn metrics never NaN on silence, junk or missing pitch'() {
    const silence = makeFrames({ to: 4000, seed: 2 });
    const t1 = computeTurn({ text: 'Okay.', start: 1000, end: 2000, frames: silence, promptEndedAt: 400 });
    assert.equal(t1.pitchMeanHz, null);
    assert.equal(t1.energyMeanDb, null);
    assert.equal(t1.latencyMs, 600);
    assertFinite(t1);
    for (const args of [{}, { start: NaN, end: NaN }, { text: 'hello', start: 5, end: 1 }, { text: 'x y z', start: 0, end: 0, frames: null }]) {
      const t = computeTurn(args);
      assertFinite(t);
      assert.equal(typeof t.wordCount, 'number');
    }
    const est = computeTurn({ text: 'one two three four', start: 0, end: 1600, promptEndedAt: 0, estimated: true });
    assert.equal(est.latencyMs, null);
    assert.equal(est.wpm, null);
  },

  'drift ordering: calm < tense and calm < flat'() {
    const turns = [turn('calm', { seed: 1 }), turn('calm2', { at: 20000, seed: 2 }), turn('tense', { at: 40000, seed: 3 }), turn('flat', { at: 60000, seed: 4 })];
    const s = summarizeSignals(turns, { pressureTurnIndexes: [2, 3] });
    const [base, calm2, tense, flat] = s.driftSeries;
    assert.equal(base, 0);
    assert.ok(calm2 < 25, `calm2 drift ${calm2}`);
    assert.ok(tense > 45, `tense drift ${tense}`);
    assert.ok(flat > 45, `flat drift ${flat}`);
    assert.ok(tense > calm2 + 25 && flat > calm2 + 25);
    assertFinite(s);
  },

  'labels: tense, flat and stable pressure answers'() {
    const calm = turn('calm', { seed: 1 });
    const tense = summarizeSignals([calm, turn('tense', { at: 20000, seed: 3, underPressure: true })]);
    assert.equal(tense.toneDirection, 'tense');
    assert.ok(tense.speechRateDeltaPct >= 15, `delta ${tense.speechRateDeltaPct}`);
    const flat = summarizeSignals([calm, turn('flat', { at: 20000, seed: 4 })], { pressureTurnIndexes: [1] });
    assert.equal(flat.toneDirection, 'flat');
    assert.ok(flat.speechRateDeltaPct <= -15, `delta ${flat.speechRateDeltaPct}`);
    assert.ok(flat.hesitationScore < tense.hesitationScore);
    const stable = summarizeSignals([calm, turn('calm2', { at: 20000, seed: 2 })], { pressureTurnIndexes: [1] });
    assert.equal(stable.toneDirection, 'stable');
    assert.ok(Math.abs(stable.speechRateDeltaPct) < 10);
    assert.ok(stable.composure > flat.composure);
    assert.ok(stable.hesitationScore >= 80, `hesitation ${stable.hesitationScore}`);
    assert.match(stable.context.rate, /^\d+ words\/min$/);
    assert.match(stable.context.avgPause, /^\d+\.\d s$/);
    assert.match(flat.context.longestPause, /^\d+\.\d s$/);
  },

  'de-escalation latency from pressure end to refusal start'() {
    const turns = [turn('calm'), turn('calm2', { at: 20000, underPressure: true })];
    const s = summarizeSignals(turns, {
      deescalation: [
        { pressureEndedAt: 10000, refusalStartedAt: 12400 },
        { pressureEndedAt: 30000, refusalStartedAt: 33600 },
      ],
    });
    assert.equal(s.deescalationLatencyS, 3);
    const none = summarizeSignals(turns, { deescalation: [{ pressureEndedAt: 10000, refusalStartedAt: null }] });
    assert.equal(none.deescalationLatencyS, null);
    assert.ok(s.composure >= none.composure - 20);
  },

  'empty, single-turn and pitchless sessions are sane'() {
    const empty = summarizeSignals([]);
    assert.deepEqual(empty.driftSeries, []);
    assert.equal(empty.toneDirection, 'stable');
    assert.equal(empty.meanLatencyMs, null);
    assert.equal(empty.deescalationLatencyS, null);
    assert.deepEqual(empty.context, { rate: 'Not measured', avgPause: 'Not measured', longestPause: 'Not measured' });
    assertFinite(empty);
    assertFinite(summarizeSignals(undefined, undefined));
    assertFinite(summarizeSignals(null, { pressureTurnIndexes: [5, 'x', -1], deescalation: [null, {}] }));

    const one = summarizeSignals([turn('calm')]);
    assert.deepEqual(one.driftSeries, [0]);
    assert.equal(one.toneDrift, 0);
    assertFinite(one);

    // Six turns with no pitch at all (e.g. a very noisy mic): rate-only drift.
    const pitchless = ['calm', 'calm2', 'tense', 'flat', 'calm', 'tense'].map((k, i) => {
      const t = turn(k, { at: i * 20000, seed: i + 1, underPressure: i === 2 || i === 5 });
      return { ...t, pitchMeanHz: null, pitchSdHz: null, pitchSdSt: null, energyMeanDb: null, energySdDb: null };
    });
    const s = summarizeSignals(pitchless);
    assertFinite(s);
    assert.equal(s.driftSeries.length, 6);
    assert.ok(s.speechRateDeltaPct > 0);
    assert.equal(s.toneDirection, 'tense');

    // All turns estimated (no mic frames).
    const est = [computeTurn({ text: 'hello there', start: 0, end: 900, estimated: true }), computeTurn({ text: 'no I will hold it', start: 5000, end: 7000, estimated: true, underPressure: true })];
    const se = summarizeSignals(est);
    assertFinite(se);
    assert.equal(se.speechRateWpm, 0);
    assert.equal(se.context.rate, 'Not measured');
  },

  'record signals use contract names and order'() {
    const rec = toRecordSignals({ toneDrift: 31, speechRateDeltaPct: 18, hesitationScore: 72, deescalationLatencyS: 2.4, composure: 77 });
    assert.deepEqual(Object.keys(rec), ['tone_drift', 'speech_rate_delta_pct', 'hesitation_score', 'deescalation_latency_s', 'composure']);
    assert.deepEqual(toRecordSignals({}), { tone_drift: 0, speech_rate_delta_pct: 0, hesitation_score: 0, deescalation_latency_s: null, composure: 0 });
  },

  'tracker: agent turns + transcripts + pressure tools give turns and signals'() {
    let clock = 0;
    const now = () => clock;
    // Sam 0-3 s, candidate 3.7-9 s (calm); Sam 10-13 s (pressure 1), candidate 13.5-19 s (tense)
    const frames = makeFrames({
      to: 26000,
      speech: [
        { start: 3700, end: 9000, pitch: 120, sdSt: 1.2, db: -30 },
        { start: 13500, end: 19000, pitch: 150, sdSt: 2.3, db: -25, dbSd: 3 },
      ],
      agent: [[0, 3000], [10000, 13000]],
      seed: 21,
    });
    const tr = createTurnTracker({ frames: () => frames.filter((f) => f.t <= clock), now });
    tr.setAgentSpeaking(true, 0);
    clock = 3000;
    tr.setAgentSpeaking(false);
    clock = 9800; // transcript arrives after turn detection
    const t0 = tr.addCandidateTurn(words(13));
    assert.equal(t0.estimated, false);
    assert.ok(Math.abs(t0.latencyMs - 700) <= 150, `latency ${t0.latencyMs}`);
    assert.equal(t0.underPressure, false);
    clock = 10000;
    tr.setAgentSpeaking(true);
    tr.markPressure(1); // tool fires while Sam says the line
    clock = 13000;
    tr.setAgentSpeaking(false);
    clock = 19700;
    const t1 = tr.addCandidateTurn('No. ' + words(16));
    assert.equal(t1.underPressure, true);
    assert.equal(t1.pressure, 1);
    tr.logStance(1, 'refused');
    const m = tr.pressureMoments();
    assert.equal(m[0].pressureEndedAt, 13000);
    assert.ok(Math.abs(m[0].latencyS - 0.5) <= 0.15, `latency ${m[0].latencyS}`);
    const s = tr.summary();
    assert.ok(Math.abs(s.deescalationLatencyS - 0.5) <= 0.15);
    assert.equal(s.driftSeries.length, 2);
    assert.equal(s.toneDirection, 'tense');
    assertFinite(s);

    // Pressure 2 never marked by Sam: the stance call still pins it to the latest turn.
    clock = 21000;
    tr.setAgentSpeaking(true);
    clock = 23000;
    tr.setAgentSpeaking(false);
    clock = 25000;
    const t2 = tr.addCandidateTurn('Okay.');
    assert.equal(t2.estimated, true); // no speech frames after 23 s
    tr.logStance(2, 'complied');
    assert.equal(tr.turns()[2].underPressure, true);
    assert.equal(tr.pressureMoments()[1].refusalStartedAt, null);
    assertFinite(tr.summary());
    tr.reset();
    assert.equal(tr.turns().length, 0);
  },

  'panel module loads in Node and tiles read plainly'() {
    assert.equal(typeof mountSignalPanel, 'function');
    assert.equal(typeof createMicAnalyzer, 'function');
    const waiting = describeSignals(null, []);
    assert.equal(waiting.tone.value, '—');
    assert.equal(waiting.deesc.level, 'none');
    const turns = [turn('calm', { seed: 1 }), turn('tense', { at: 20000, seed: 3, underPressure: true })];
    const s = summarizeSignals(turns, { deescalation: [{ pressureEndedAt: 20000, refusalStartedAt: 22400 }] });
    const d = describeSignals(s, turns);
    assert.match(d.rate.read, /^Speeding up under pressure \(\+\d+%\)$/);
    assert.equal(d.tone.read, 'Tenser voice under pressure');
    assert.equal(d.deesc.value, '2.4');
    assert.equal(d.deesc.read, 'Pushed back quickly');
    const slow = describeSignals(summarizeSignals([turn('calm'), turn('flat', { at: 20000, underPressure: true })]), [{}, { underPressure: true }]);
    assert.match(slow.rate.read, /^Slowing down under pressure \(−\d+%\)$/);
    assert.equal(slow.deesc.read, 'No pushback yet');
    assert.equal(describeSignals(summarizeSignals([turn('calm')]), [{}]).tone.read, 'Baseline set from the first answer');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
