// Live voice-signal panel for the call screen's side column (~320 px wide):
// a pitch + loudness trace (canvas, up to 20 fps) and four tiles (tone drift, speech
// rate, hesitation, de-escalation), each with a value and a one-line plain-English read.
// Uses the shell's CSS variables (dark theme) and injects its own scoped <style> once.
//
//   const panel = mountSignalPanel(el);
//   analyzer.onFrame((f) => panel.pushFrames(f));
//   panel.setSignals(tracker.summary(), tracker.turns());

const STYLE_ID = 'vsig-style';
const TRACE_MS = 8000; // visible history
const TRACE_H = 76; // css px
const DRAW_MS = 50; // 20 fps cap
const MAX_BARS = 12;

const CSS = `
.vsig{display:grid;gap:10px;padding:12px 14px 14px;min-width:0;border:1px solid var(--line,#2A2F36);border-radius:20px;background:var(--panel,#16191D);color:var(--ink,#F1F3F4);font-family:var(--font-body,system-ui,sans-serif);font-size:14px;line-height:1.4}
.vsig *{box-sizing:border-box}
.vsig-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.vsig-head h3{margin:0;font-size:15px;font-weight:700}
.vsig-state{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#9AA2AA)}
.vsig-state i{width:7px;height:7px;border-radius:50%;background:var(--line-strong,#3B424B)}
.vsig.is-live .vsig-state{color:var(--fail,#FF7E6E)}
.vsig.is-live .vsig-state i{background:var(--fail,#FF7E6E);animation:vsig-blink 1.4s infinite}
@keyframes vsig-blink{50%{opacity:.25}}
.vsig-trace{border:1px solid var(--line,#2A2F36);border-radius:12px;background:var(--frame,#111316);overflow:hidden}
.vsig-trace canvas{display:block;width:100%;height:${TRACE_H}px}
.vsig-legend{display:flex;flex-wrap:wrap;gap:4px 12px;padding:6px 10px;border-top:1px solid var(--line,#2A2F36);font-size:11px;color:var(--muted,#9AA2AA)}
.vsig-legend span{display:inline-flex;align-items:center;gap:5px}
.vsig-legend span::before{content:"";width:8px;height:8px;border-radius:2px}
.vsig-legend .k-pitch::before{background:var(--lime-a,#E4F35C)}
.vsig-legend .k-loud::before{background:var(--ice,#86C2F4)}
.vsig-legend .k-agent::before{background:var(--panel-2,#1E2227);box-shadow:inset 0 0 0 1px var(--line-strong,#3B424B)}
.vsig-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.vsig-tile{display:grid;gap:3px;align-content:start;min-width:0;padding:10px 10px 9px;border-radius:12px;background:var(--panel-2,#1E2227);border:1px solid transparent;transition:border-color .6s}
.vsig-tile.bump{border-color:var(--ice-deep,#2B66AE);transition:none}
.vsig-k{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted,#9AA2AA);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vsig-k i{flex:none;width:6px;height:6px;border-radius:50%;background:var(--line-strong,#3B424B)}
.vsig-tile[data-level="ok"] .vsig-k i{background:var(--pass,#86E3AE)}
.vsig-tile[data-level="mid"] .vsig-k i{background:var(--warn,#F4C766)}
.vsig-tile[data-level="high"] .vsig-k i{background:var(--fail,#FF7E6E)}
.vsig-v{font-family:var(--font-display,system-ui,sans-serif);font-weight:300;font-size:24px;line-height:1.15;font-variant-numeric:tabular-nums;white-space:nowrap}
.vsig-v small{margin-left:3px;font-family:var(--font-body,system-ui,sans-serif);font-size:11px;font-weight:600;color:var(--muted,#9AA2AA)}
.vsig-r{font-size:12px;line-height:1.35;color:var(--muted,#9AA2AA);min-height:2.7em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vsig-bars{display:flex;align-items:flex-end;gap:2px;height:14px;margin-top:2px}
.vsig-bars:empty{display:none}
.vsig-bars i{flex:1 1 0;max-width:10px;min-height:2px;border-radius:2px;background:var(--ice,#86C2F4)}
.vsig-bars i.p{background:var(--warn,#F4C766)}
.vsig-bars i.b{background:var(--line-strong,#3B424B)}
.vsig-note{margin:0;font-size:11.5px;color:var(--muted,#9AA2AA)}
@media (prefers-reduced-motion:reduce){.vsig.is-live .vsig-state i{animation:none}.vsig-tile{transition:none}}
`;

const SKELETON = `
<div class="vsig-head"><h3>Voice signals</h3><span class="vsig-state"><i></i><span>Off</span></span></div>
<div class="vsig-trace">
  <canvas aria-hidden="true"></canvas>
  <div class="vsig-legend" aria-hidden="true"><span class="k-pitch">Pitch</span><span class="k-loud">Loudness</span><span class="k-agent">Sam talking</span></div>
</div>
<div class="vsig-tiles">
  <div class="vsig-tile" data-k="tone" data-level="none"><div class="vsig-k"><i></i>Tone drift</div><div class="vsig-v"></div><div class="vsig-r"></div><div class="vsig-bars" aria-hidden="true"></div></div>
  <div class="vsig-tile" data-k="rate" data-level="none"><div class="vsig-k"><i></i>Speech rate</div><div class="vsig-v"></div><div class="vsig-r"></div></div>
  <div class="vsig-tile" data-k="hesitation" data-level="none"><div class="vsig-k"><i></i>Hesitation</div><div class="vsig-v"></div><div class="vsig-r"></div></div>
  <div class="vsig-tile" data-k="deesc" data-level="none"><div class="vsig-k"><i></i>De-escalation</div><div class="vsig-v"></div><div class="vsig-r"></div></div>
</div>
<p class="vsig-note">Compared with your first answer. Measured in this browser from your mic.</p>
`;

const TILE_KEYS = ['tone', 'rate', 'hesitation', 'deesc'];
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const s1 = (ms) => (ms / 1000).toFixed(1);
const level = (v, okBelow, midBelow) => (v < okBelow ? 'ok' : v < midBelow ? 'mid' : 'high');

// Tile contents for a signals object (pure; also used by tests).
// Returns { tone, rate, hesitation, deesc }, each { value, unit, read, level } where
// level is 'none' | 'ok' | 'mid' | 'high'.
export function describeSignals(signals, turns) {
  const s = signals && typeof signals === 'object' ? signals : null;
  const ts = Array.isArray(turns) ? turns.filter(Boolean) : null;
  const series = s && Array.isArray(s.driftSeries) ? s.driftSeries : [];
  const count = ts ? ts.length : series.length;
  const has = !!s && count > 0;
  const pressured = ts ? ts.some((t) => t.underPressure) : count > 1;
  const wait = (read) => ({ value: '—', unit: '', read, level: 'none' });

  let tone = wait('Starts when you talk');
  if (has && count === 1) tone = { value: '0', unit: '/100', read: 'Baseline set from the first answer', level: 'ok' };
  else if (has) {
    const d = finite(s.toneDrift) ? Math.round(s.toneDrift) : 0;
    const read = {
      stable: pressured ? 'Steady voice under pressure' : 'Steady voice so far',
      tense: pressured ? 'Tenser voice under pressure' : 'Voice getting tenser',
      flat: pressured ? 'Voice went flat under pressure' : 'Voice going flat',
    }[s.toneDirection] || 'Steady voice so far';
    tone = { value: String(d), unit: '/100', read, level: level(d, 25, 50) };
  }

  let rate = wait('Starts when you talk');
  if (has && finite(s.speechRateWpm) && s.speechRateWpm > 0) {
    const d = finite(s.speechRateDeltaPct) ? Math.round(s.speechRateDeltaPct) : 0;
    const pct = `${d > 0 ? '+' : d < 0 ? '−' : '+'}${Math.abs(d)}%`;
    let read = 'Baseline pace';
    if (pressured) read = d >= 10 ? `Speeding up under pressure (${pct})` : d <= -10 ? `Slowing down under pressure (${pct})` : `Steady pace under pressure (${pct})`;
    rate = { value: String(Math.round(s.speechRateWpm)), unit: 'wpm', read, level: pressured ? level(Math.abs(d), 10, 25) : 'ok' };
  }

  let hesitation = wait('Starts when you talk');
  if (has && finite(s.hesitationScore)) {
    const h = Math.round(s.hesitationScore);
    const lat = finite(s.meanLatencyMs) ? s.meanLatencyMs : null;
    const fil = finite(s.fillerPer100) ? s.fillerPer100 : 0;
    let read;
    if (h >= 75) read = lat != null ? `Quick answers (${s1(lat)} s avg)` : 'Few fillers or pauses';
    else if (lat != null && lat >= 2000) read = `Slow to answer (${s1(lat)} s avg)`;
    else if (fil >= 4) read = `Many fillers (${Math.round(fil)} per 100 words)`;
    else read = lat != null ? `Some pauses (${s1(lat)} s avg)` : 'Some pauses mid-answer';
    hesitation = { value: String(h), unit: '/100', read, level: h >= 75 ? 'ok' : h >= 50 ? 'mid' : 'high' };
  }

  let deesc = wait('Starts at the first push');
  if (s && finite(s.deescalationLatencyS)) {
    const v = s.deescalationLatencyS;
    const read = v <= 3 ? 'Pushed back quickly' : v <= 6 ? 'Pushed back after a pause' : 'Slow to push back';
    deesc = { value: v.toFixed(1), unit: 's', read, level: level(v, 3.05, 6.05) };
  } else if (has && pressured) deesc = { value: '—', unit: '', read: 'No pushback yet', level: 'mid' };

  return { tone, rate, hesitation, deesc };
}

let styleRefs = 0;

// Mounts the panel at the end of `container`. Returns
// { pushFrames(frames), setSignals(signals, turns), setRecording(bool), reset(), destroy() }.
export function mountSignalPanel(container) {
  const doc = container.ownerDocument || document;
  const win = doc.defaultView || window;
  if (!doc.getElementById(STYLE_ID)) {
    const st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  styleRefs++;

  const root = doc.createElement('section');
  root.className = 'vsig';
  root.setAttribute('aria-label', 'Live voice signals');
  root.innerHTML = SKELETON;
  container.appendChild(root);

  const canvas = root.querySelector('canvas');
  const g = canvas.getContext('2d');
  const stateText = root.querySelector('.vsig-state span');
  const bars = root.querySelector('.vsig-bars');
  const tiles = {};
  for (const k of TILE_KEYS) {
    const el = root.querySelector(`[data-k="${k}"]`);
    tiles[k] = { el, v: el.querySelector('.vsig-v'), r: el.querySelector('.vsig-r'), last: null };
  }

  let frames = [];
  let recording = false;
  let everRecorded = false;
  let dirty = true;
  let raf = 0;
  let lastDraw = -Infinity;
  let dead = false;
  let cssW = 0;
  let colors = null;

  function readColors() {
    const cs = win.getComputedStyle(root);
    const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    colors = {
      pitch: v('--lime-a', '#E4F35C'),
      loud: v('--ice', '#86C2F4'),
      agent: v('--panel-2', '#1E2227'),
      line: v('--line', '#2A2F36'),
      muted: v('--muted', '#9AA2AA'),
      bg: v('--frame', '#111316'),
      mono: v('--font-mono', 'ui-monospace,monospace'),
      body: v('--font-body', 'system-ui,sans-serif'),
    };
  }

  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth || 290));
    const dpr = Math.min(3, win.devicePixelRatio || 1);
    if (w !== cssW || canvas.width !== Math.round(w * dpr)) {
      cssW = w;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(TRACE_H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
    }
  }

  // Pitch (log scale, 70-400 Hz) in the top ~60%, loudness bars along the bottom,
  // Sam's turns shaded so echo is visibly excluded.
  function draw() {
    if (!colors) readColors();
    const W = cssW;
    const H = TRACE_H;
    const pTop = 7;
    const pBot = H * 0.62;
    const yPitch = (hz) => pBot - (Math.log(clamp(hz, 70, 400) / 70) / Math.log(400 / 70)) * (pBot - pTop);
    g.clearRect(0, 0, W, H);
    g.globalAlpha = 1;
    g.lineWidth = 1;
    g.strokeStyle = colors.line;
    g.textBaseline = 'middle';
    for (const hz of [100, 200, 300]) {
      const y = Math.round(yPitch(hz)) + 0.5;
      g.beginPath();
      g.moveTo(24, y);
      g.lineTo(W, y);
      g.stroke();
    }
    // Hz labels go on top of everything else.
    const labels = () => {
      g.globalAlpha = 1;
      g.font = `9px ${colors.mono}`;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      for (const hz of [100, 200]) {
        const y = Math.round(yPitch(hz)) + 0.5;
        g.fillStyle = colors.bg;
        g.fillRect(1, y - 5, 21, 10);
        g.fillStyle = colors.muted;
        g.fillText(String(hz), 3, y);
      }
    };
    if (!frames.length) {
      labels();
      g.fillStyle = colors.muted;
      g.font = `12px ${colors.body}`;
      g.textAlign = 'center';
      g.fillText(recording ? 'Listening…' : 'Your voice trace appears here', W / 2, H * 0.8);
      return;
    }
    const tEnd = frames[frames.length - 1].t;
    const x = (t) => W - ((tEnd - t) / TRACE_MS) * W;
    const colW = Math.max(1, (W / TRACE_MS) * 50);

    // Sam's turns
    g.fillStyle = colors.agent;
    let bandStart = null;
    let labelX = null;
    for (const f of frames) {
      if (!f.agentSpeaking) {
        bandStart = null;
        continue;
      }
      const fx = x(f.t);
      g.fillRect(fx - colW, 0, colW + 0.6, H);
      if (bandStart == null) bandStart = fx;
      if (fx - bandStart > 26) labelX = bandStart;
    }
    if (labelX != null) {
      g.fillStyle = colors.muted;
      g.font = `9px ${colors.body}`;
      g.textAlign = 'left';
      g.fillText('Sam', Math.max(26, labelX + 3), H * 0.74);
    }

    // Loudness
    const loudH = H * 0.32;
    for (const f of frames) {
      const v = clamp((f.rmsDb + 80) / 60, 0, 1);
      if (v <= 0) continue;
      g.globalAlpha = f.agentSpeaking ? 0.22 : f.voiced ? 0.85 : 0.32;
      g.fillStyle = f.agentSpeaking ? colors.muted : colors.loud;
      g.fillRect(x(f.t) - colW, H - v * loudH, Math.max(1, colW - 0.6), v * loudH);
    }

    // Pitch (candidate only)
    g.globalAlpha = 1;
    g.strokeStyle = colors.pitch;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    let prevT = null;
    for (const f of frames) {
      if (!(f.voiced && !f.agentSpeaking && f.pitchHz > 0)) continue;
      const px = x(f.t);
      const py = yPitch(f.pitchHz);
      if (prevT != null && f.t - prevT <= 160) g.lineTo(px, py);
      else {
        g.moveTo(px, py);
        g.lineTo(px + 0.1, py);
      }
      prevT = f.t;
    }
    g.stroke();

    if (!recording) {
      g.globalAlpha = 0.45;
      g.fillStyle = colors.bg;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
    labels();
  }

  function loop(ts) {
    if (dead) return;
    raf = win.requestAnimationFrame(loop);
    if (!dirty || ts - lastDraw < DRAW_MS) return;
    lastDraw = ts;
    dirty = false;
    resize();
    draw();
  }

  const onResize = () => {
    resize();
    dirty = true;
  };
  let ro = null;
  if (win.ResizeObserver) {
    ro = new win.ResizeObserver(onResize);
    ro.observe(canvas);
  } else win.addEventListener('resize', onResize);

  function setTile(k, d) {
    const t = tiles[k];
    const key = d.value + d.unit + d.read;
    t.el.dataset.level = d.level;
    t.v.textContent = d.value;
    if (d.unit) {
      const u = doc.createElement('small');
      u.textContent = d.unit;
      t.v.appendChild(u);
    }
    t.r.textContent = d.read;
    t.el.setAttribute('aria-label', `${t.el.querySelector('.vsig-k').textContent}: ${d.value}${d.unit ? ' ' + d.unit : ''}. ${d.read}`);
    if (t.last != null && t.last !== key && d.level !== 'none') {
      t.el.classList.add('bump');
      win.setTimeout(() => t.el.classList.remove('bump'), 60);
    }
    t.last = key;
  }

  function setSignals(signals, turns) {
    const d = describeSignals(signals, turns);
    for (const k of TILE_KEYS) setTile(k, d[k]);
    const series = signals && Array.isArray(signals.driftSeries) ? signals.driftSeries : [];
    const ts = Array.isArray(turns) ? turns : [];
    const from = Math.max(0, series.length - MAX_BARS);
    let html = '';
    if (series.length > 1) {
      for (let i = from; i < series.length; i++) {
        const v = finite(series[i]) ? clamp(series[i], 0, 100) : 0;
        const cls = ts[i] && ts[i].underPressure ? 'p' : i === 0 || v === 0 ? 'b' : '';
        html += `<i class="${cls}" style="height:${Math.max(12, v)}%"></i>`;
      }
    }
    bars.innerHTML = html;
  }

  function pushFrames(input) {
    const arr = Array.isArray(input) ? input : input ? [input] : [];
    let lastT = frames.length ? frames[frames.length - 1].t : -Infinity;
    for (const f of arr) {
      if (!f || !finite(f.t) || f.t <= lastT) continue; // ignore repeats, so a full buffer can be pushed too
      frames.push(f);
      lastT = f.t;
    }
    if (!frames.length) return;
    const cut = lastT - TRACE_MS - 200;
    if (frames[0].t < cut || frames.length > 2000) {
      let i = 0;
      while (i < frames.length && (frames[i].t < cut || frames.length - i > 2000)) i++;
      frames = frames.slice(i);
    }
    dirty = true;
  }

  function setRecording(on) {
    recording = !!on;
    if (recording) everRecorded = true;
    root.classList.toggle('is-live', recording);
    stateText.textContent = recording ? 'Live' : everRecorded ? 'Paused' : 'Off';
    dirty = true;
  }

  function reset() {
    frames = [];
    for (const k of TILE_KEYS) tiles[k].last = null;
    setSignals(null, []);
    dirty = true;
  }

  reset();
  raf = win.requestAnimationFrame(loop);

  return {
    pushFrames,
    setSignals,
    setRecording,
    reset,
    destroy() {
      dead = true;
      win.cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      else win.removeEventListener('resize', onResize);
      root.remove();
      styleRefs = Math.max(0, styleRefs - 1);
      if (!styleRefs) {
        const st = doc.getElementById(STYLE_ID);
        if (st) st.remove();
      }
    },
    get element() {
      return root;
    },
  };
}
