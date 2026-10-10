// Live voice signals for the call (Track 2): tone drift, speech rate, hesitation and
// de-escalation latency.
//
// - createMicAnalyzer(): browser only. Opens its own mic stream (ElevenLabs captures the
//   mic separately) and polls it every 50 ms into LiveFrames.
// - Everything else is pure (no DOM), so it imports and tests fine in Node.
//
// All times are ms on one injected clock, now(). A LiveFrame is
//   { t, rmsDb, pitchHz (0 = unvoiced), voiced, agentSpeaking }
// Frames flagged agentSpeaking (Sam talking, plus a short echo tail) never count as
// candidate speech.

export const FRAME_MS = 50;
export const PITCH_MIN_HZ = 70;
export const PITCH_MAX_HZ = 400;
export const FILLERS = ['um', 'uh', 'er', 'erm', 'hmm', 'like', 'you know', 'I mean', 'sort of', 'kind of', 'basically', 'actually'];

const SILENT_DB = -100;
const PAUSE_MS = 250; // a gap in voicing this long inside a turn is a pause
const LONG_PAUSE_MS = 1000; // ...and this long is a hesitation pause
const MAX_LATENCY_MS = 8000; // Sam re-prompts after 7 s of silence, so cap outliers
const STABLE_BELOW = 25; // toneDrift under this reads as 'stable'

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 0) => {
  const k = 10 ** d;
  return Math.round(x * k) / k;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const stdev = (xs) => {
  if (xs.length < 2) return xs.length ? 0 : null;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
};
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = clamp((s.length - 1) * q, 0, s.length - 1);
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};
const semitones = (hz, refHz) => 12 * Math.log2(hz / refHz);

/* ---------- DSP (pure) ---------- */

// RMS level of a block in dBFS, floored at -100.
export function rmsDb(samples) {
  const n = samples.length;
  if (!n) return SILENT_DB;
  let s = 0;
  for (let i = 0; i < n; i++) s += samples[i] * samples[i];
  const rms = Math.sqrt(s / n);
  return rms > 1e-5 ? Math.max(SILENT_DB, 20 * Math.log10(rms)) : SILENT_DB;
}

// YIN pitch detector. Returns { hz, clarity }: hz is 0 when the block isn't periodic
// enough (cumulative-mean-normalised difference never dips under `threshold`).
export function detectPitch(samples, sampleRate, { minHz = PITCH_MIN_HZ, maxHz = PITCH_MAX_HZ, threshold = 0.3 } = {}) {
  const n = samples.length;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.ceil(sampleRate / minHz), Math.floor(n / 2) - 1);
  if (!(sampleRate > 0) || tauMax <= tauMin + 1) return { hz: 0, clarity: 0 };
  const w = n - tauMax - 1;
  const cm = new Float32Array(tauMax + 2);
  cm[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let d = 0;
    for (let j = 0; j < w; j++) {
      const diff = samples[j] - samples[j + tau];
      d += diff * diff;
    }
    running += d;
    cm[tau] = running > 0 ? (d * tau) / running : 1;
  }
  let best = -1;
  let min = 1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] < min) min = cm[tau];
    if (cm[tau] < threshold) {
      while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return { hz: 0, clarity: round(1 - min, 3) };
  // Parabolic interpolation around the dip for sub-sample period accuracy.
  const a = cm[best - 1];
  const b = cm[best];
  const c = cm[best + 1];
  const den = a - 2 * b + c;
  const shift = den > 0 ? clamp((0.5 * (a - c)) / den, -1, 1) : 0;
  const hz = sampleRate / (best + shift);
  if (!finite(hz) || hz < minHz * 0.95 || hz > maxHz * 1.05) return { hz: 0, clarity: round(1 - b, 3) };
  return { hz, clarity: round(1 - b, 3) };
}

// Box-filter decimation (crude low-pass) so pitch detection runs at ~16 kHz.
function decimate(src, factor, out) {
  if (factor <= 1) {
    out.set(src.subarray(0, out.length));
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    const o = i * factor;
    for (let k = 0; k < factor; k++) s += src[o + k];
    out[i] = s / factor;
  }
  return out;
}

/* ---------- Mic analyzer (browser) ---------- */

// AudioWorklet that hands the main thread one block of mic samples per frame. Audio
// callbacks keep running when timers are throttled (hidden tab, busy 3D iframe).
const TAP_SRC = `class VmTap extends AudioWorkletProcessor {
  constructor(o) { super(); this.n = o.processorOptions.block; this.buf = new Float32Array(this.n); this.i = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let k = 0; k < ch.length; k++) {
      this.buf[this.i++] = ch[k];
      if (this.i === this.n) { this.port.postMessage(this.buf.slice(0)); this.i = 0; }
    }
    return true;
  }
}
registerProcessor('vm-tap', VmTap);`;

// Reads its own mic stream every 50 ms (AudioWorklet blocks; a timer + AnalyserNode if
// worklets are unavailable). Frames are kept in a ring buffer (~10 min).
// Voiced = louder than an adaptive noise floor by `voicedMarginDb` AND periodic (YIN).
export function createMicAnalyzer({
  stream = null,
  now = defaultNow,
  pollMs = FRAME_MS,
  maxFrames = 12000,
  voicedMarginDb = 8,
  agentTailMs = 300,
  useWorklet = true,
} = {}) {
  const ring = new Array(maxFrames);
  let head = 0;
  let size = 0;
  const listeners = new Set();
  let ctx = null;
  let source = null;
  let analyser = null;
  let tap = null;
  let sink = null;
  let ownStream = null;
  let timer = null;
  let win = null; // last fftSize samples, for pitch
  let small = null;
  let dec = 1;
  let floorDb = null;
  let agentOn = false;
  let agentOffAt = -Infinity;
  let muted = false;
  let calib = null;
  let mode = null; // 'worklet' | 'timer'

  function push(frame) {
    ring[head] = frame;
    head = (head + 1) % maxFrames;
    size = Math.min(size + 1, maxFrames);
    for (const cb of listeners) {
      try {
        cb(frame);
      } catch (e) {
        console.warn('[voice] onFrame listener failed', e);
      }
    }
  }

  // Noise floor: falls fast to quiet frames, creeps up 0.5 dB/s so speech can't drag it far.
  function updateFloor(db) {
    if (floorDb == null) floorDb = db;
    else if (db < floorDb) floorDb += (db - floorDb) * 0.3;
    else floorDb = Math.min(db, floorDb + (0.5 * pollMs) / 1000);
    floorDb = clamp(floorDb, -95, -25);
  }

  function finishCalibration() {
    const q = quantile(calib.values, 0.2);
    if (q != null) floorDb = clamp(q, -95, -25);
    const done = calib;
    calib = null;
    done.resolve({ noiseFloorDb: floorDb == null ? null : round(floorDb, 1) });
  }

  // One frame: loudness from `level` (this frame's samples), pitch from `win`.
  function analyze(level) {
    if (!ctx) return;
    const t = now();
    const db = rmsDb(level);
    const agentSpeaking = agentOn || t - agentOffAt < agentTailMs;
    if (calib) {
      if (!agentSpeaking) calib.values.push(db);
      if (t >= calib.until) finishCalibration();
    } else if (!agentSpeaking) {
      updateFloor(db);
    }
    const loud = floorDb != null && db > floorDb + voicedMarginDb && db > -75;
    let hz = 0;
    if (loud) hz = detectPitch(decimate(win, dec, small), ctx.sampleRate / dec).hz;
    const voiced = !muted && loud && hz > 0;
    push({ t: round(t, 1), rmsDb: round(db, 1), pitchHz: voiced ? round(hz, 1) : 0, voiced, agentSpeaking });
  }

  function onBlock(block) {
    if (block.length >= win.length) win.set(block.subarray(block.length - win.length));
    else {
      win.copyWithin(0, block.length);
      win.set(block, win.length - block.length);
    }
    analyze(block);
  }

  function poll() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(win);
    analyze(win);
  }

  async function startWorklet() {
    if (!useWorklet || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    try {
      const url = URL.createObjectURL(new Blob([TAP_SRC], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const block = Math.round((ctx.sampleRate * pollMs) / 1000);
      tap = new AudioWorkletNode(ctx, 'vm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { block } });
      sink = ctx.createGain();
      sink.gain.value = 0; // keeps the tap pulled by the graph; silent
      source.connect(tap);
      tap.connect(sink).connect(ctx.destination);
      tap.port.onmessage = (e) => onBlock(e.data);
      return true;
    } catch (e) {
      console.warn('[voice] AudioWorklet unavailable, polling with a timer', e);
      tap = sink = null;
      return false;
    }
  }

  return {
    async start() {
      if (mode) return;
      if (typeof window === 'undefined') throw new Error('createMicAnalyzer needs a browser');
      let s = stream;
      if (!s) {
        ownStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        });
        s = ownStream;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      // resume() needs a user gesture; don't hang start() if it never resolves.
      if (ctx.state === 'suspended') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
      source = ctx.createMediaStreamSource(s);
      win = new Float32Array(ctx.sampleRate > 50000 ? 4096 : 2048);
      dec = Math.max(1, Math.round(ctx.sampleRate / 16000));
      small = new Float32Array(Math.floor(win.length / dec));
      if (await startWorklet()) mode = 'worklet';
      else {
        analyser = ctx.createAnalyser();
        analyser.fftSize = win.length;
        source.connect(analyser); // never connected to the speakers
        timer = setInterval(poll, pollMs);
        mode = 'timer';
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (tap) tap.port.onmessage = null;
      for (const n of [source, tap, sink, analyser]) {
        try {
          n && n.disconnect();
        } catch (e) {}
      }
      if (ownStream) ownStream.getTracks().forEach((tr) => tr.stop());
      ownStream = null;
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
      ctx = source = analyser = tap = sink = null;
      mode = null;
      if (calib) finishCalibration();
    },
    onFrame(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    // Ordered copy, oldest first. Pass `since` (clock ms) to get only newer frames.
    frames(since = -Infinity) {
      const out = [];
      for (let i = 0; i < size; i++) {
        const f = ring[(head - size + i + maxFrames) % maxFrames];
        if (f.t >= since) out.push(f);
      }
      return out;
    },
    clear() {
      head = size = 0;
    },
    // Measure the room for `ms` (candidate silent) and set the noise floor from it.
    // Resolves { noiseFloorDb }.
    calibrate(ms = 1000) {
      if (calib) return calib.promise;
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      calib = { until: now() + ms, values: [], resolve, promise };
      // Safety net if no frames arrive (not started, or audio suspended).
      setTimeout(() => calib && calib.promise === promise && finishCalibration(), ms + 1500);
      return promise;
    },
    // Call from the agent's mode changes; frames while Sam talks (+ echo tail) are flagged.
    setAgentSpeaking(on) {
      on = !!on;
      if (agentOn && !on) agentOffAt = now();
      agentOn = on;
    },
    // While muted in the call UI, frames are never voiced.
    setMuted(on) {
      muted = !!on;
    },
    get running() {
      return !!mode;
    },
    // 'worklet' | 'timer' | null
    get mode() {
      return mode;
    },
    get noiseFloorDb() {
      return floorDb == null ? null : round(floorDb, 1);
    },
  };
}

/* ---------- Segmentation (pure) ---------- */

function cleanFrames(frames) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && finite(f.t));
  for (let i = 1; i < list.length; i++) {
    if (list[i].t < list[i - 1].t) return [...list].sort((a, b) => a.t - b.t);
  }
  return list;
}

// Typical frame spacing (median of the first gaps), default 50 ms.
function frameStep(list) {
  const gaps = [];
  for (let i = 1; i < list.length && gaps.length < 64; i++) {
    const g = list[i].t - list[i - 1].t;
    if (g > 0) gaps.push(g);
  }
  const m = quantile(gaps, 0.5);
  return m == null ? FRAME_MS : clamp(m, 5, 500);
}

// Candidate utterances from frames: speech = voiced && !agentSpeaking. A segment closes
// after `hangoverMs` without speech or as soon as Sam talks; it is kept only if it holds
// at least `minSpeechMs` of speech. Returns [{ start, end }] in clock ms.
export function segmentUtterances(frames, { minSpeechMs = 250, hangoverMs = 600 } = {}) {
  const list = cleanFrames(frames);
  const step = frameStep(list);
  const out = [];
  let start = null;
  let last = null;
  let speechMs = 0;
  const close = () => {
    if (start != null && speechMs >= minSpeechMs) out.push({ start, end: last + step });
    start = null;
    speechMs = 0;
  };
  for (const f of list) {
    if (start != null && (f.agentSpeaking || f.t - last > hangoverMs)) close();
    if (f.voiced && !f.agentSpeaking) {
      if (start == null) start = f.t;
      speechMs += step;
      last = f.t;
    }
  }
  close();
  return out;
}

// The candidate's speech between `from` and `to` (e.g. Sam stopped -> transcript arrived),
// merged into one span. Returns { start, end, utterances } or null if nobody spoke.
export function findTurnSpan(frames, { from = -Infinity, to = Infinity, minSpeechMs, hangoverMs } = {}) {
  const segs = segmentUtterances(
    cleanFrames(frames).filter((f) => f.t >= from && f.t <= to),
    { minSpeechMs, hangoverMs },
  );
  if (!segs.length) return null;
  return { start: segs[0].start, end: segs[segs.length - 1].end, utterances: segs.length };
}

/* ---------- Text features (pure) ---------- */

const SINGLE_FILLERS = new Set(['um', 'umm', 'uhm', 'uh', 'uhh', 'er', 'err', 'erm', 'hmm', 'hm', 'mm', 'mmm', 'basically', 'actually']);
const LIKE_VERB_BEFORE = new Set(['i', 'you', 'we', 'they', 'would', "i'd", "you'd", "we'd", "they'd", 'look', 'looks', 'looked', 'feel', 'feels', 'felt', 'seem', 'seems', 'sound', 'sounds', 'something', 'anything', 'nothing', 'more', 'just', 'much', 'not', "don't", "didn't", 'do', 'did']);
const LIKE_QUOTATIVE_BEFORE = new Set(['was', 'were', 'so', 'and', 'but', 'um', 'uh']);
const KIND_DETERMINER_BEFORE = new Set(['what', 'this', 'that', 'the', 'a', 'an', 'any', 'some', 'which', 'same', 'every', 'one', 'each', 'no', 'these', 'those', 'all', 'different', 'other', 'another', 'its', 'your', 'my', 'our', 'their', 'his', 'her']);
const YOU_KNOW_SKIP_BEFORE = new Set(['do', 'did', "don't", "didn't", 'if', 'would', 'as', 'wanna', 'to', 'let']);
const YOU_KNOW_SKIP_AFTER = new Set(['what', 'how', 'where', 'why', 'when', 'who', 'which', 'if', 'whether', 'the']);

// Words with a flag for punctuation right before them (clause boundary).
function wordTokens(text) {
  const norm = String(text || '').toLowerCase().replace(/[’‘`]/g, "'");
  const out = [];
  let boundary = true;
  for (const m of norm.matchAll(/[a-z0-9]+(?:'[a-z]+)?|[,.;:!?…—–()"]|\s-\s/g)) {
    const tok = m[0];
    if (/[a-z0-9]/.test(tok)) {
      out.push({ w: tok, before: boundary });
      boundary = false;
    } else {
      boundary = true;
      if (out.length) out[out.length - 1].after = true;
    }
  }
  return out;
}

export function countWords(text) {
  return wordTokens(text).length;
}

// Filler heuristic over the lexicon in FILLERS. "like", "kind of", "sort of", "you know"
// and "I mean" only count in their filler sense (e.g. "I like it" and "what kind of
// alarm" don't).
export function countFillers(text) {
  const t = wordTokens(text);
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const { w } = t[i];
    const prev = i > 0 ? t[i - 1].w : null;
    const next = t[i + 1];
    const joined = next && !t[i].after; // no punctuation between this word and the next
    if (SINGLE_FILLERS.has(w)) n++;
    else if (w === 'like') {
      const commaNear = t[i].before || t[i].after;
      if ((commaNear || LIKE_QUOTATIVE_BEFORE.has(prev)) && !(prev && !t[i].before && LIKE_VERB_BEFORE.has(prev))) n++;
    } else if ((w === 'kind' || w === 'sort') && joined && next.w === 'of') {
      if (!(prev && !t[i].before && KIND_DETERMINER_BEFORE.has(prev))) {
        n++;
        i++;
      }
    } else if (w === 'you' && joined && next.w === 'know') {
      const after = t[i + 2] && !next.after ? t[i + 2].w : null;
      if (!(prev && !t[i].before && YOU_KNOW_SKIP_BEFORE.has(prev)) && !YOU_KNOW_SKIP_AFTER.has(after)) {
        n++;
        i++;
      }
    } else if (w === 'i' && joined && next.w === 'mean') {
      if (!(prev === 'what' && !t[i].before)) {
        n++;
        i++;
      }
    }
  }
  return n;
}

/* ---------- Per-turn metrics (pure) ---------- */

// Drop octave errors: keep pitch values within ~an octave-and-a-bit of the median.
function trimPitch(values) {
  const m = quantile(values, 0.5);
  if (m == null) return [];
  return values.filter((hz) => hz > m / 1.8 && hz < m * 1.8);
}

// One candidate turn. start/end/promptEndedAt are clock ms. Numbers are rounded; a field
// is null when it couldn't be measured (never NaN):
//   latencyMs    = start - promptEndedAt (end of Sam's line), capped at 8 s
//   wpm          = words / (end - start) minutes, capped at 400
//   fillerPer100 = fillers per 100 words
//   longPauses   = gaps in voicing >= 1 s inside the turn
//   pitch*/energy* = over voiced frames in the turn (pitchSdSt = spread in semitones)
// Pass estimated:true when start/end were guessed (no mic frames): timing fields go null.
export function computeTurn({ text = '', start, end, frames = [], promptEndedAt = null, underPressure = false, estimated = false } = {}) {
  const s = finite(start) ? start : null;
  const e = s == null ? null : finite(end) && end >= s ? end : s;
  const durationMs = s == null ? 0 : e - s;
  const wordCount = countWords(text);
  const fillerCount = countFillers(text);
  const timed = !estimated && s != null;

  const step = frameStep(cleanFrames(frames));
  const voiced = s == null ? [] : cleanFrames(frames).filter((f) => f.t >= s && f.t <= e && f.voiced && !f.agentSpeaking);
  const pitch = trimPitch(voiced.map((f) => f.pitchHz).filter((hz) => finite(hz) && hz > 0));
  const energy = voiced.map((f) => f.rmsDb).filter(finite);
  const pitchMean = pitch.length >= 3 ? mean(pitch) : null;

  let longPauses = 0;
  let longestPauseMs = 0;
  let pauses = 0;
  for (let i = 1; i < voiced.length; i++) {
    const gap = voiced[i].t - voiced[i - 1].t - step;
    if (gap >= PAUSE_MS) pauses++;
    if (gap >= LONG_PAUSE_MS) longPauses++;
    if (gap > longestPauseMs) longestPauseMs = gap;
  }

  return {
    text: String(text || ''),
    start: s,
    end: e,
    promptEndedAt: finite(promptEndedAt) ? promptEndedAt : null,
    underPressure: !!underPressure,
    estimated: !!estimated,
    latencyMs: timed && finite(promptEndedAt) ? round(clamp(s - promptEndedAt, 0, MAX_LATENCY_MS)) : null,
    durationSec: round(durationMs / 1000, 2),
    wordCount,
    wpm: timed && durationMs >= 300 && wordCount > 0 ? round(clamp(wordCount / (durationMs / 60000), 0, 400)) : null,
    fillerCount,
    fillerPer100: wordCount ? round((fillerCount / wordCount) * 100, 1) : 0,
    longPauses,
    pauses,
    longestPauseMs: round(longestPauseMs),
    voicedMs: round(voiced.length * step),
    pitchMeanHz: pitchMean == null ? null : round(pitchMean, 1),
    pitchSdHz: pitchMean == null ? null : round(stdev(pitch), 1),
    pitchSdSt: pitchMean == null ? null : round(stdev(pitch.map((hz) => semitones(hz, pitchMean))), 2),
    energyMeanDb: energy.length >= 2 ? round(mean(energy), 1) : null,
    energySdDb: energy.length >= 2 ? round(stdev(energy), 1) : null,
  };
}

/* ---------- Session summary (pure) ---------- */

const usable = (t) => t && !t.estimated && t.wordCount >= 4 && t.durationSec >= 1;

const paceOk = (t) => finite(t.wpm) && t.wordCount >= 6 && t.durationSec >= 2;

// Baseline = first non-pressure turn (preferring one with at least 4 words and 1 s of
// speech). A feature missing from it falls back to the mean of the other calm turns;
// pace also falls back when the baseline turn is too short for a reliable rate.
function baselineOf(turns, pressure) {
  const calm = turns.map((t, i) => i).filter((i) => !pressure.has(i));
  const idx = calm.find((i) => usable(turns[i])) ?? calm[0] ?? (turns.length ? 0 : -1);
  if (idx < 0) return { idx, f: {} };
  const pool = calm.length ? calm : [idx];
  const pick = (k, ok = (t) => finite(t[k])) => {
    if (ok(turns[idx])) return turns[idx][k];
    const alt = mean(pool.map((i) => turns[i]).filter(ok).map((t) => t[k]));
    return alt ?? (finite(turns[idx][k]) ? turns[idx][k] : null);
  };
  return {
    idx,
    f: { pitchMeanHz: pick('pitchMeanHz'), pitchSdSt: pick('pitchSdSt'), energyMeanDb: pick('energyMeanDb'), wpm: pick('wpm', paceOk) },
  };
}

// Drift of one turn from the baseline. Each feature becomes a z-like unit where 1 = a
// clearly noticeable change: pitch 2 semitones, pitch spread x1.6, loudness 5 dB, pace 25%
// (pace only for turns of 6+ words and 2+ s; short replies give noisy rates).
//   score   = 50 * rms(units), clamped 0-100 (one noticeable change ~ 50)
//   tension = mean(signed units): > 0 higher/more varied/louder/faster, < 0 flatter
function turnDrift(t, base) {
  const z = [];
  if (finite(t.pitchMeanHz) && finite(base.pitchMeanHz) && base.pitchMeanHz > 0) z.push(semitones(t.pitchMeanHz, base.pitchMeanHz) / 2);
  if (finite(t.pitchSdSt) && finite(base.pitchSdSt)) z.push(Math.log2(Math.max(t.pitchSdSt, 0.2) / Math.max(base.pitchSdSt, 0.2)) / Math.log2(1.6));
  if (finite(t.energyMeanDb) && finite(base.energyMeanDb)) z.push((t.energyMeanDb - base.energyMeanDb) / 5);
  if (finite(t.wpm) && finite(base.wpm) && base.wpm > 0 && t.wordCount >= 6 && t.durationSec >= 2) z.push((t.wpm - base.wpm) / base.wpm / 0.25);
  if (!z.length) return { score: 0, tension: 0, n: 0 };
  const rms = Math.sqrt(mean(z.map((v) => v * v)));
  return { score: round(clamp(50 * rms, 0, 100)), tension: mean(z), n: z.length };
}

// Pooled pace: total words / total speaking minutes over turns with a measured wpm.
function pooledWpm(turns) {
  const ts = turns.filter((t) => finite(t.wpm) && t.durationSec > 0);
  const min = sum(ts.map((t) => t.durationSec)) / 60;
  return min > 0 ? sum(ts.map((t) => t.wordCount)) / min : null;
}

// Hesitation, 0-100 where higher = less hesitant:
//   100 * (1 - (0.40 * latency + 0.35 * fillers + 0.25 * long pauses)), each penalty 0-1:
//   latency  = (mean latency - 0.5 s) / 3.5 s      (4 s or more = full penalty)
//   fillers  = fillers per 100 words / 8           (8 or more = full penalty)
//   pauses   = long pauses per speaking minute / 4 (4 or more = full penalty)
// Missing parts are dropped and the weights renormalised; null if nothing is measurable.
function hesitation(turns) {
  const parts = [];
  const lats = turns.map((t) => t.latencyMs).filter(finite);
  if (lats.length) parts.push([clamp((mean(lats) - 500) / 3500, 0, 1), 0.4]);
  const words = sum(turns.map((t) => t.wordCount || 0));
  if (words > 0) parts.push([clamp(((sum(turns.map((t) => t.fillerCount || 0)) / words) * 100) / 8, 0, 1), 0.35]);
  const timed = turns.filter((t) => !t.estimated && t.durationSec > 0);
  const minutes = sum(timed.map((t) => t.durationSec)) / 60;
  if (minutes >= 0.05) parts.push([clamp(sum(timed.map((t) => t.longPauses || 0)) / minutes / 4, 0, 1), 0.25]);
  if (!parts.length) return null;
  const w = sum(parts.map((p) => p[1]));
  return round(100 * (1 - sum(parts.map(([v, k]) => v * k)) / w));
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const NOT_MEASURED = 'Not measured'; // same wording as assessment.js

// Session signals, field names exactly as in docs/INTEGRATION.md `signals`, plus
// `context` strings for the dashboard (timing.context).
//   toneDrift          mean drift of the pressure turns (or of all non-baseline turns
//                      if none are marked), 0-100
//   toneDirection      'stable' if toneDrift < 25, else 'tense' / 'flat' by mean tension
//   speechRateWpm      pooled pace over all turns
//   speechRateDeltaPct pooled pace of pressure turns vs baseline, in %
//   hesitationScore    see hesitation(), over all turns
//   meanLatencyMs      mean pause before answering (null if never measured)
//   fillerPer100       pooled fillers per 100 words
//   deescalationLatencyS mean of (refusalStartedAt - pressureEndedAt) over the pressure
//                      lines that got a refusal, in s (null if none did)
//   composure          0.45 * (100 - toneDrift) + 0.35 * hesitation under pressure
//                      + 0.20 * refusal speed (1 s = 100, 8 s or more = 0), renormalised
//                      when a part is missing
//   driftSeries        drift score per turn (baseline = 0)
export function summarizeSignals(turns = [], { pressureTurnIndexes = [], deescalation = [] } = {}) {
  const list = (Array.isArray(turns) ? turns : []).filter((t) => t && typeof t === 'object');
  const pressure = new Set();
  for (const i of Array.isArray(pressureTurnIndexes) ? pressureTurnIndexes : []) {
    const k = Number(i);
    if (Number.isInteger(k) && k >= 0 && k < list.length) pressure.add(k);
  }
  list.forEach((t, i) => t.underPressure && pressure.add(i));

  const { idx: baseIdx, f: base } = baselineOf(list, pressure);
  const drift = list.map((t, i) => (i === baseIdx ? { score: 0, tension: 0, n: 0 } : turnDrift(t, base)));
  const focus = (pressure.size ? [...pressure] : list.map((_, i) => i).filter((i) => i !== baseIdx)).filter((i) => drift[i].n > 0);
  const toneDrift = focus.length ? round(mean(focus.map((i) => drift[i].score))) : 0;
  const tension = focus.length ? mean(focus.map((i) => drift[i].tension)) : 0;
  const toneDirection = toneDrift < STABLE_BELOW ? 'stable' : tension >= 0 ? 'tense' : 'flat';

  const pressureTurns = [...pressure].map((i) => list[i]);
  const allWpm = pooledWpm(list);
  const pWpm = pooledWpm(pressureTurns);
  const speechRateDeltaPct =
    pressure.size && finite(pWpm) && finite(base.wpm) && base.wpm > 0 ? round(clamp(((pWpm - base.wpm) / base.wpm) * 100, -100, 300)) : 0;

  const lats = list.map((t) => t.latencyMs).filter(finite);
  const words = sum(list.map((t) => t.wordCount || 0));
  const fillers = sum(list.map((t) => t.fillerCount || 0));

  const refusals = (Array.isArray(deescalation) ? deescalation : [])
    .filter((d) => d && finite(d.pressureEndedAt) && finite(d.refusalStartedAt))
    .map((d) => clamp((d.refusalStartedAt - d.pressureEndedAt) / 1000, 0, 120));
  const deescalationLatencyS = refusals.length ? round(mean(refusals), 1) : null;

  const parts = [];
  if (list.length) parts.push([100 - toneDrift, 0.45]);
  const hesP = hesitation(pressure.size ? pressureTurns : list);
  if (hesP != null) parts.push([hesP, 0.35]);
  if (deescalationLatencyS != null) parts.push([100 * (1 - clamp((deescalationLatencyS - 1) / 7, 0, 1)), 0.2]);
  const composure = parts.length ? round(sum(parts.map(([v, w]) => v * w)) / sum(parts.map((p) => p[1]))) : 0;

  const longest = Math.max(0, ...lats, ...list.map((t) => (finite(t.longestPauseMs) ? t.longestPauseMs : 0)));
  const speechRateWpm = finite(allWpm) ? round(allWpm) : 0;
  const meanLatencyMs = lats.length ? round(mean(lats)) : null;

  return {
    toneDrift,
    toneDirection,
    speechRateWpm,
    speechRateDeltaPct,
    hesitationScore: hesitation(list) ?? 0,
    meanLatencyMs,
    fillerPer100: words ? round((fillers / words) * 100, 1) : 0,
    deescalationLatencyS,
    composure,
    driftSeries: drift.map((d) => d.score),
    context: {
      rate: speechRateWpm > 0 ? `${speechRateWpm} words/min` : NOT_MEASURED,
      avgPause: meanLatencyMs != null ? secs(meanLatencyMs) : NOT_MEASURED,
      longestPause: longest > 0 ? secs(longest) : NOT_MEASURED,
    },
  };
}

// The credential record's `signals` field (snake_case, contract key order).
export function toRecordSignals(s = {}) {
  const num = (x) => (finite(x) ? x : null);
  return {
    tone_drift: num(s.toneDrift) ?? 0,
    speech_rate_delta_pct: num(s.speechRateDeltaPct) ?? 0,
    hesitation_score: num(s.hesitationScore) ?? 0,
    deescalation_latency_s: num(s.deescalationLatencyS),
    composure: num(s.composure) ?? 0,
  };
}

/* ---------- Turn tracker (glue for the live call, no DOM) ---------- */

// Turns ElevenLabs events into turns + signals:
//   setAgentSpeaking(on)      from onModeChange (mode === 'speaking'); also flags analyzer frames
//   markPressure(n)           from the mark_pressure client tool
//   addCandidateTurn(text)    from onMessage when source is the user (cue lines filtered out)
//   logStance(n, stance)      from the log_candidate_stance client tool
//   summary()                 summarizeSignals() over everything so far
// The candidate's speech for a transcript is found in the frames between the end of
// Sam's last line (or the previous turn) and the transcript's arrival. With no mic frames
// it falls back to an estimated span (timing fields null).
export function createTurnTracker({ analyzer = null, frames = null, now = defaultNow, fallbackLagMs = 700, graceMs = 2000, minSpeechMs, hangoverMs } = {}) {
  const getFrames = frames || (analyzer ? () => analyzer.frames() : () => []);
  let agentOn = false;
  let agentEndedAt = null;
  let list = [];
  let pressures = new Map();

  const pressureOf = (n) => {
    if (!pressures.has(n)) pressures.set(n, { n, markedAt: null, endedAt: null, pending: false, turnIndex: null, stance: null, refusalStartedAt: null });
    return pressures.get(n);
  };
  const lastTurn = () => list[list.length - 1] || null;
  const pressureMoments = () =>
    [...pressures.values()]
      .sort((a, b) => a.n - b.n)
      .map((p) => ({
        n: p.n,
        markedAt: p.markedAt,
        pressureEndedAt: p.endedAt,
        turnIndex: p.turnIndex,
        stance: p.stance,
        refusalStartedAt: p.refusalStartedAt,
        latencyS: finite(p.endedAt) && finite(p.refusalStartedAt) ? round(Math.max(0, p.refusalStartedAt - p.endedAt) / 1000, 1) : null,
      }));

  return {
    setAgentSpeaking(on, at = now()) {
      on = !!on;
      if (analyzer && analyzer.setAgentSpeaking) analyzer.setAgentSpeaking(on);
      if (on === agentOn) return;
      agentOn = on;
      if (!on) {
        agentEndedAt = at;
        for (const p of pressures.values()) {
          if (p.pending) {
            p.endedAt = at;
            p.pending = false;
          }
        }
      }
    },

    // The pressure line is the one Sam is speaking now, the one that just ended (no
    // answer yet), or else his next line.
    markPressure(n, at = now()) {
      n = Number(n);
      if (!(n >= 1)) return;
      const p = pressureOf(n);
      if (p.endedAt != null || p.pending) return;
      p.markedAt = at;
      const lt = lastTurn();
      const justEnded = agentEndedAt != null && at - agentEndedAt < 1500 && (!lt || lt.end <= agentEndedAt);
      if (!agentOn && justEnded) p.endedAt = agentEndedAt;
      else p.pending = true;
    },

    addCandidateTurn(text, { at = now(), underPressure } = {}) {
      const prev = lastTurn();
      const from = Math.max(prev && finite(prev.end) ? prev.end : -Infinity, agentEndedAt ?? -Infinity, at - 60000);
      const win = getFrames().filter((f) => f && f.t >= from && f.t <= at);
      const span = findTurnSpan(win, { minSpeechMs, hangoverMs });
      let start;
      let end;
      const estimated = !span;
      if (span) ({ start, end } = span);
      else {
        end = Math.max(from, at - fallbackLagMs);
        start = Math.max(from, end - Math.max(600, countWords(text) * 400));
      }
      const idx = list.length;
      let pressureN = null;
      for (const p of pressures.values()) {
        if (p.endedAt != null && p.turnIndex == null && start >= p.endedAt - graceMs) {
          p.turnIndex = idx;
          pressureN = p.n;
        }
      }
      const promptEndedAt = agentEndedAt != null && agentEndedAt <= start + 1 ? agentEndedAt : null;
      const turn = computeTurn({ text, start, end, frames: win, promptEndedAt, underPressure: underPressure ?? pressureN != null, estimated });
      turn.index = idx;
      turn.pressure = pressureN;
      turn.at = at;
      list.push(turn);
      return turn;
    },

    // A refusal timestamps de-escalation at the start of the latest candidate turn after
    // the pressure line. If Sam never called mark_pressure, the latest turn is taken as
    // the answer to his previous line.
    logStance(n, stance) {
      n = Number(n);
      if (!(n >= 1)) return;
      const p = pressureOf(n);
      p.stance = stance;
      const lt = lastTurn();
      if (p.endedAt == null && lt) {
        p.endedAt = lt.promptEndedAt ?? lt.start;
        p.pending = false;
        if (p.turnIndex == null) {
          p.turnIndex = lt.index;
          lt.underPressure = true;
          lt.pressure = n;
        }
      }
      if (stance === 'refused' && p.refusalStartedAt == null && p.endedAt != null) {
        const t = [...list].reverse().find((x) => finite(x.start) && x.start >= p.endedAt - graceMs);
        if (t) p.refusalStartedAt = t.start;
      }
    },

    turns() {
      return list.slice();
    },
    pressureMoments,
    summary() {
      const pressureTurnIndexes = list.map((t, i) => (t.underPressure ? i : -1)).filter((i) => i >= 0);
      const deescalation = pressureMoments()
        .filter((p) => p.pressureEndedAt != null)
        .map((p) => ({ pressureEndedAt: p.pressureEndedAt, refusalStartedAt: p.refusalStartedAt }));
      return summarizeSignals(list, { pressureTurnIndexes, deescalation });
    },
    get agentSpeaking() {
      return agentOn;
    },
    reset() {
      list = [];
      pressures = new Map();
      agentOn = false;
      agentEndedAt = null;
    },
  };
}
