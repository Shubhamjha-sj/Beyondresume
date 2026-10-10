import * as THREE from 'three';

// All sounds are synthesised in code (no audio files, no licensing questions):
// cleanroom air-handling hum, tool alarm horn, overhead-vehicle whir, UI blips, EMO siren.
// Positional sounds use three.js PositionalAudio, so they get louder as you walk closer.
// Voice lines use the browser's built-in speech synthesis, with subtitles.
// With { speech: false } (embed mode, where the call has a real voice) say() only shows the subtitle.

export class AudioManager {
  constructor(camera, { speech = true, volume = 1 } = {}) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    if (Number.isFinite(volume) && volume !== 1) this.listener.setMasterVolume(volume);
    this.ctx = this.listener.context;
    this.speech = speech && 'speechSynthesis' in window;
    this.buffers = {
      hum: makeHum(this.ctx),
      alarm: makeAlarm(this.ctx),
      whir: makeWhir(this.ctx),
      click: makeTone(this.ctx, [[1400, 0.035]], 0.5),
      chime: makeTone(this.ctx, [[660, 0.16], [990, 0.28]], 0.45),
      buzz: makeBuzz(this.ctx),
      emo: makeSiren(this.ctx),
    };
    this.alarms = new Map(); // toolId -> PositionalAudio
    this.ambient = null;
    this.voices = [];
    this.onSubtitle = null; // (speaker, text) => void
    this.onSubtitleEnd = null; // () => void

    if (this.speech) {
      const load = () => (this.voices = window.speechSynthesis.getVoices());
      load();
      window.speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  // Must be called from a click/keypress (browsers block audio until the user interacts).
  async unlock() {
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume();
    } catch (e) {
      console.warn('Audio could not start:', e);
    }
    if (!this.ambient) {
      this.ambient = new THREE.Audio(this.listener);
      this.ambient.setBuffer(this.buffers.hum);
      this.ambient.setLoop(true);
      this.ambient.setVolume(0.35);
      this.ambient.play();
    }
  }

  suspend() {
    this.ctx.suspend?.().catch(() => {});
    if (this.speech) window.speechSynthesis.pause();
  }

  resume() {
    this.ctx.resume?.().catch(() => {});
    if (this.speech) window.speechSynthesis.resume();
  }

  stopAll() {
    for (const id of [...this.alarms.keys()]) this.stopAlarm(id);
    if (this.speech) window.speechSynthesis.cancel();
  }

  // Looping sound attached to a 3D object (it moves with the object).
  attachLoop(object3d, name, { volume = 1, refDistance = 2, rolloff = 1.3, maxDistance = 40 } = {}) {
    const sound = new THREE.PositionalAudio(this.listener);
    sound.setBuffer(this.buffers[name]);
    sound.setLoop(true);
    sound.setVolume(volume);
    sound.setRefDistance(refDistance);
    sound.setRolloffFactor(rolloff);
    sound.setDistanceModel('inverse');
    sound.setMaxDistance(maxDistance);
    object3d.add(sound);
    sound.play();
    return sound;
  }

  detach(sound) {
    if (!sound) return;
    if (sound.isPlaying) sound.stop();
    sound.parent?.remove(sound);
  }

  startAlarm(toolId, anchor) {
    this.stopAlarm(toolId);
    this.alarms.set(toolId, this.attachLoop(anchor, 'alarm', { volume: 0.9, refDistance: 2.5, rolloff: 1.1 }));
  }

  stopAlarm(toolId) {
    this.detach(this.alarms.get(toolId));
    this.alarms.delete(toolId);
  }

  // One-shot, non-positional UI sound.
  play(name, volume = 0.5) {
    if (this.ctx.state !== 'running' || !this.buffers[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.listener.getInput());
    src.start();
  }

  say(text, speaker = 'Supervisor') {
    const done = () => this.onSubtitleEnd?.();
    if (!this.speech) {
      this.onSubtitle?.(speaker, text);
      setTimeout(done, 1500 + text.length * 55);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice(speaker);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-US';
    u.rate = 1.03;
    u.pitch = speaker === 'Maintenance' ? 0.85 : 1.0;
    u.onstart = () => this.onSubtitle?.(speaker, text); // subtitles follow the speech queue
    u.onend = done;
    u.onerror = () => {
      this.onSubtitle?.(speaker, text);
      setTimeout(done, 1500 + text.length * 55);
    };
    window.speechSynthesis.speak(u);
  }

  pickVoice(speaker) {
    const english = this.voices.filter((v) => /^en[-_]/i.test(v.lang));
    if (!english.length) return null;
    const preferred =
      speaker === 'Maintenance'
        ? ['Daniel', 'Google UK English Male', 'Alex', 'Fred', 'Arthur']
        : ['Samantha', 'Google US English', 'Karen', 'Moira', 'Victoria'];
    for (const name of preferred) {
      const v = english.find((voice) => voice.name.includes(name));
      if (v) return v;
    }
    return english[speaker === 'Maintenance' ? Math.min(1, english.length - 1) : 0];
  }
}

// ---------- Sound synthesis ----------
function makeBuffer(ctx, seconds, fill) {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buffer = ctx.createBuffer(1, n, sr);
  fill(buffer.getChannelData(0), sr, n);
  return buffer;
}

// Noise that loops without a click: generate extra samples and crossfade the tail into the head.
function loopableNoise(n, fade, next) {
  const src = new Float32Array(n + fade);
  for (let i = 0; i < src.length; i++) src[i] = next();
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i];
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = src[i] * w + src[n + i] * (1 - w);
  }
  return out;
}

function normalise(d, peak) {
  let max = 0;
  for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
  if (max > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / max;
}

function makeHum(ctx) {
  return makeBuffer(ctx, 6, (d, sr, n) => {
    let brown = 0;
    const noise = loopableNoise(n, Math.floor(sr * 0.5), () => {
      brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      return brown;
    });
    normalise(noise, 0.5);
    for (let i = 0; i < n; i++) {
      const t = i / sr; // 120 Hz and 240 Hz fit exactly in 6 s, so the loop is seamless
      d[i] = noise[i] + 0.06 * Math.sin(2 * Math.PI * 120 * t) + 0.025 * Math.sin(2 * Math.PI * 240 * t);
    }
  });
}

function makeAlarm(ctx) {
  // Three sharp beeps, then a pause; 1.6 s loop.
  return makeBuffer(ctx, 1.6, (d, sr) => {
    const f = 2800;
    for (let b = 0; b < 3; b++) {
      const start = Math.floor((0.05 + b * 0.3) * sr);
      const len = Math.floor(0.18 * sr);
      const ramp = Math.floor(0.008 * sr);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.min(1, i / ramp, (len - i) / ramp);
        const x = 2 * Math.PI * f * t;
        d[start + i] = 0.55 * env * (Math.sin(x) + Math.sin(3 * x) / 3 + Math.sin(5 * x) / 5);
      }
    }
  });
}

function makeWhir(ctx) {
  return makeBuffer(ctx, 2, (d, sr, n) => {
    let lp1 = 0;
    let lp2 = 0;
    const noise = loopableNoise(n, Math.floor(sr * 0.25), () => {
      const w = Math.random() * 2 - 1;
      lp1 += 0.08 * (w - lp1); // low-pass
      lp2 += 0.01 * (lp1 - lp2); // slower low-pass, subtracted = band-pass
      return lp1 - lp2;
    });
    normalise(noise, 0.35);
    for (let i = 0; i < n; i++) {
      const t = i / sr; // 90/180 Hz fit exactly in 2 s
      d[i] = noise[i] + 0.08 * Math.sin(2 * Math.PI * 90 * t) + 0.03 * Math.sin(2 * Math.PI * 180 * t);
    }
  });
}

function makeTone(ctx, notes, peak) {
  const total = notes.reduce((s, [, len]) => s + len, 0) + 0.05;
  return makeBuffer(ctx, total, (d, sr) => {
    let offset = 0;
    for (const [f, len] of notes) {
      const start = Math.floor(offset * sr);
      const count = Math.floor(len * sr);
      for (let i = 0; i < count; i++) {
        const t = i / sr;
        const env = Math.min(1, i / (0.004 * sr)) * Math.exp((-4 * t) / len);
        d[start + i] += peak * env * Math.sin(2 * Math.PI * f * t);
      }
      offset += len;
    }
  });
}

function makeBuzz(ctx) {
  return makeBuffer(ctx, 0.25, (d, sr, n) => {
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, i / (0.005 * sr)) * Math.exp(-6 * t);
      d[i] = 0.35 * env * Math.sign(Math.sin(2 * Math.PI * 160 * t));
    }
  });
}

function makeSiren(ctx) {
  return makeBuffer(ctx, 2.6, (d, sr, n) => {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = 850 + 300 * Math.sin(2 * Math.PI * 0.8 * t);
      phase += (2 * Math.PI * f) / sr;
      const env = Math.min(1, t / 0.05) * Math.min(1, (2.6 - t) / 0.4);
      d[i] = 0.45 * env * Math.sin(phase);
    }
  });
}
