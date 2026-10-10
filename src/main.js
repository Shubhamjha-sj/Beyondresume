import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { CONFIG } from './config.js';
import { NavGrid } from './navgrid.js';
import { Player } from './player.js';
import { Minimap } from './minimap.js';
import { ToolManager } from './tools.js';
import { OhtSystem } from './oht.js';
import { AudioManager } from './audio.js';
import { SessionLog } from './log.js';
import { ScenarioRunner, LOT_APPROACH_SECONDS } from './scenario.js';
import { scoreSession } from './scoring.js';
import { Hud } from './hud.js';
import { ToolPanel, Dashboard } from './panels.js';
import { showResults } from './results.js';

const $ = (id) => document.getElementById(id);
const ui = {
  overlay: $('overlay'),
  enter: $('enter'),
  loading: $('loading'),
  barFill: $('bar-fill'),
  loadingText: $('loading-text'),
  error: $('error'),
  setup: $('setup'),
  briefing: $('briefing'),
  candidate: $('candidate'),
  hud: $('hud'),
  labels: $('labels'),
  debug: $('debug'),
  marker: $('minimap-player'),
  results: $('results'),
};

// ---------- Renderer, scene, camera ----------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); // MSAA doesn't help splats
renderer.setPixelRatio(CONFIG.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0b0d10, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(CONFIG.spawn.x, CONFIG.eyeHeight, CONFIG.spawn.z);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

// Lights only affect the overlay meshes (vehicles, FOUPs, stack lights); splats carry their own lighting.
scene.add(new THREE.HemisphereLight(0xffffff, 0x50565e, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(1, 5, 2);
scene.add(keyLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.fab = { THREE, scene, camera, renderer, spark, CONFIG };

// ---------- App state ----------
// mode: loading | ready | walking | panel | relocking | paused | results
const app = { mode: 'loading', t: 0, started: false, panel: null, target: null, zone: null, candidate: 'Candidate', sampleTimer: 0, panelTimer: 0 };
let player = null;
let nav = null;
let minimap = null;
let tools = null;
let oht = null;
let audio = null;
let log = null;
let runner = null;
let hud = null;
let toolPanel = null;
let dashboard = null;
let def = null;

// ---------- Helpers ----------
function setProgress(fraction, text) {
  ui.barFill.style.width = `${Math.round(fraction * 100)}%`;
  if (text) ui.loadingText.textContent = text;
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.classList.remove('is-hidden');
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.json();
}

const warnNull = (msg) => (e) => {
  console.warn(msg, e);
  return null;
};

const isTyping = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'submit', 'checkbox'].includes(el.type)));

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Loading ----------
async function loadWorld() {
  const mb = (n) => (n / 1048576).toFixed(0);
  const world = new SplatMesh({
    url: CONFIG.worldUrl,
    ...(CONFIG.lod ? { lod: true } : {}),
    onProgress: (e) => {
      if (e && e.lengthComputable && e.total) {
        setProgress((0.9 * e.loaded) / e.total, `Loading the fab… ${mb(e.loaded)} / ${mb(e.total)} MB`);
      }
    },
  });
  scene.add(world);
  await world.initialized;
  return world;
}

async function boot() {
  if (location.protocol === 'file:') {
    throw new Error('Open this through a local web server (see README), not by double-clicking index.html.');
  }

  const [world, navGrid, map, layout, scenario] = await Promise.all([
    loadWorld(),
    NavGrid.load(CONFIG.navGridUrl).catch(warnNull('No nav grid, collisions disabled:')),
    Minimap.load(CONFIG.floorplanUrl, ui.marker).catch(warnNull('No minimap:')),
    fetchJSON(CONFIG.layoutUrl),
    fetchJSON(CONFIG.scenarioUrl),
  ]);
  nav = navGrid;
  minimap = map;
  def = scenario;

  audio = new AudioManager(camera);
  tools = new ToolManager(scene, layout, ui.labels);
  oht = new OhtSystem(scene, layout.rails, audio);
  log = new SessionLog();
  runner = new ScenarioRunner(def, { log, onEvent: handleEvent });
  hud = new Hud({ prompt: $('prompt'), clock: $('clock'), badge: $('alarm-badge'), subtitles: $('subtitles'), toast: $('toast') });
  audio.onSubtitle = (speaker, text) => hud.showSubtitle(speaker, text);
  audio.onSubtitleEnd = () => hud.hideSubtitleSoon();

  toolPanel = new ToolPanel($('tool-panel'), { onAction: perform, onClose: () => closePanel(true) });
  dashboard = new Dashboard($('dashboard'), {
    tools,
    runner,
    plan: minimap?.plan,
    onAction: perform,
    onClose: () => closePanel(true),
    getTime: () => app.t,
    getPlayer: () => camera.position,
  });

  player = new Player(camera, renderer.domElement, nav, CONFIG);
  if (nav && !nav.isWalkable(CONFIG.spawn.x, CONFIG.spawn.z)) {
    console.warn('Spawn point is not on walkable floor; collisions disabled.');
    player.setNoclip(true);
  }
  player.addEventListener('lock', onLock);
  player.addEventListener('unlock', onUnlock);
  document.addEventListener('pointerlockerror', onLockError);

  ui.briefing.textContent = def.briefing;
  ui.enter.addEventListener('click', onEnter);
  ui.candidate.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onEnter();
  });

  Object.assign(window.fab, { world, player, tools, oht, audio, log, runner, def, app });
  setProgress(1, 'Ready.');
  ui.enter.disabled = false;
  app.mode = 'ready';
  ui.candidate.focus();
}

// ---------- Flow: start, pause, panels, finish ----------
function onEnter() {
  if (ui.enter.disabled || app.mode === 'results') return;
  if (!app.started) {
    app.started = true;
    app.candidate = ui.candidate.value.trim() || 'Candidate';
    log.meta = {
      candidate: app.candidate,
      scenario: def.id,
      scenarioTitle: def.title,
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };
    ui.setup.classList.add('is-hidden');
    ui.enter.textContent = 'Resume';
    audio.unlock();
    runner.start();
  } else {
    audio.resume();
  }
  ui.error.classList.add('is-hidden');
  ui.candidate.blur();
  ui.enter.blur(); // so Space/Enter while walking don't re-trigger the button
  player.lock();
}

function onLock() {
  app.mode = 'walking';
  ui.overlay.classList.add('is-hidden');
  ui.hud.classList.remove('is-hidden');
}

function onUnlock() {
  if (app.mode === 'panel' || app.mode === 'results') return;
  pause();
}

function onLockError() {
  if (app.mode === 'results') return;
  pause();
  showError('The browser blocked mouse capture. Click Resume to continue.');
}

function pause() {
  if (app.mode === 'results') return;
  app.mode = 'paused';
  ui.overlay.classList.remove('is-hidden');
  ui.loading.classList.add('is-hidden');
  audio?.suspend();
}

function clearTarget() {
  app.target = null;
  tools.setTarget(null);
  hud.setPrompt(null);
}

function openToolPanel(tool) {
  app.mode = 'panel';
  app.panel = 'tool';
  clearTarget();
  toolPanel.open(tool);
  log.add('ui', { name: 'tool_panel_open', tool: tool.id });
  perform({ action: 'inspect', tool: tool.id, source: 'tool_panel' });
  audio.play('click', 0.35);
  player.unlock();
}

function openDashboard() {
  app.mode = 'panel';
  app.panel = 'dashboard';
  clearTarget();
  dashboard.open();
  log.add('ui', { name: 'dashboard_open' });
  audio.play('click', 0.35);
  player.unlock();
}

function closePanel(relock) {
  if (app.panel === 'tool') {
    toolPanel.close();
    log.add('ui', { name: 'tool_panel_close' });
  } else if (app.panel === 'dashboard') {
    dashboard.close();
    log.add('ui', { name: 'dashboard_close' });
  }
  app.panel = null;
  if (app.mode === 'results') return;
  if (relock) {
    app.mode = 'relocking';
    player.lock();
  } else {
    pause();
  }
}

function finish(reason) {
  if (app.mode === 'results') return;
  app.mode = 'results';
  if (app.panel) {
    toolPanel.close();
    dashboard.close();
    app.panel = null;
  }
  for (const t of tools.list()) audio.stopAlarm(t.id);
  player.unlock();
  ui.hud.classList.add('is-hidden');
  ui.overlay.classList.add('is-hidden');

  const score = scoreSession(def, log.entries, log.positions);
  log.meta = { ...log.meta, endedAt: new Date().toISOString(), endReason: reason, durationSec: Math.round(app.t) };
  const slug = app.candidate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'candidate';
  showResults(ui.results, {
    score,
    def,
    log,
    candidate: app.candidate,
    reason,
    onDownload: () => download(`fabtwin-${slug}-${def.id}.json`, { ...log.toJSON(), score }),
    onRestart: () => location.reload(),
  });
  window.fab.score = score;
}

// ---------- Scenario events -> world ----------
function handleEvent(evt) {
  switch (evt.type) {
    case 'say':
      audio.say(evt.text, evt.speaker);
      break;
    case 'alarm': {
      const tool = tools.setAlarm(evt.tool, evt, app.t);
      if (tool) audio.startAlarm(tool.id, tool.alarmAnchor);
      break;
    }
    case 'lot_approach': {
      const tool = tools.get(evt.to);
      if (tool) oht.deliver({ lot: evt.lot, side: tool.side, port: tool.port, inSeconds: LOT_APPROACH_SECONDS });
      break;
    }
    case 'lot_arrived':
      tools.get(evt.tool)?.queue.push(evt.lot);
      break;
    case 'scenario_end':
      finish(evt.reason);
      break;
  }
}

// ---------- Candidate actions -> world + log ----------
let ticketNo = 8810;

function perform(a) {
  if (!runner || runner.ended) return { ok: false, message: 'The exercise has ended.' };
  let result = { ok: true, message: '' };
  switch (a.action) {
    case 'inspect':
      break;
    case 'ack_alarm':
      result = tools.ack(a.tool);
      if (result.ok) audio.stopAlarm(a.tool);
      break;
    case 'hold_tool':
      result = tools.hold(a.tool);
      break;
    case 'reset_resume':
      result = tools.resetResume(a.tool);
      if (result.ok) audio.stopAlarm(a.tool);
      break;
    case 'emo':
      result = tools.emo(a.tool);
      if (result.ok) {
        audio.stopAlarm(a.tool);
        audio.play('emo', 0.6);
      }
      break;
    case 'reroute':
      result = runner.reroute(a.lot, a.to)
        ? { ok: true, message: `${a.lot} rerouted to ${a.to}.` }
        : { ok: false, message: `${a.lot} can't be rerouted any more.` };
      break;
    case 'call_maintenance':
      ticketNo += 1;
      result = { ok: true, message: `Ticket MT-${ticketNo} sent to maintenance for ${a.tool}.` };
      break;
    case 'notify_supervisor':
      result = a.text ? { ok: true, message: 'Message sent to your supervisor.' } : { ok: false, message: 'Type a message first.' };
      break;
    case 'end_shift':
      break;
    default:
      result = { ok: false, message: 'Unknown action.' };
  }
  runner.act({ ...a, ok: result.ok });
  if (a.action !== 'inspect' && a.action !== 'end_shift') audio.play(result.ok ? 'chime' : 'buzz', 0.4);
  if (a.action === 'end_shift') runner.end('ended_by_candidate');
  return result;
}

// ---------- Input ----------
const _heading = new THREE.Vector3();

function currentPose() {
  const h = player.getHeading(_heading);
  const yawDeg = Math.round((Math.atan2(-h.x, -h.z) * 180) / Math.PI);
  const p = camera.position;
  return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), yawDeg };
}

window.addEventListener('keydown', (e) => {
  if (!player) return;
  if (app.mode === 'walking') {
    if (e.code === 'Tab') {
      e.preventDefault();
      openDashboard();
    } else if (e.code === 'KeyE') {
      if (app.target) openToolPanel(app.target);
    } else if (CONFIG.dev) {
      devKey(e);
    }
  } else if (app.mode === 'panel') {
    if (e.code === 'Escape') {
      e.preventDefault();
      closePanel(false);
      return;
    }
    if (isTyping(document.activeElement)) return;
    if (e.code === 'KeyE' || e.code === 'Tab') {
      e.preventDefault();
      closePanel(true);
    }
  }
});

// Dev keys: N noclip, ` debug read-out, P copy position, J skip 15 s of scenario time,
// H show every tool's box outline (to check layout.json against the world)
function devKey(e) {
  if (e.code === 'KeyH') {
    tools.setShowAll(!tools.showAll);
    hud.toast(tools.showAll ? 'Showing all tool outlines' : 'Tool outlines hidden');
  } else if (e.code === 'KeyN') {
    player.setNoclip(!player.noclip);
    hud.toast(player.noclip ? 'Noclip on (R/F to fly up/down)' : 'Noclip off');
  } else if (e.code === 'Backquote') {
    ui.debug.classList.toggle('is-hidden');
  } else if (e.code === 'KeyP') {
    const pose = JSON.stringify(currentPose());
    console.log('Position:', pose);
    navigator.clipboard?.writeText(pose).catch(() => {});
    hud.toast(`Position ${pose} (copied)`);
  } else if (e.code === 'KeyJ') {
    app.t += 15;
    hud.toast('Skipped 15 s ahead (dev)');
  }
}

if (CONFIG.debug) ui.debug.classList.remove('is-hidden');

// ---------- Per-frame helpers ----------
const raycaster = new THREE.Raycaster();
const CENTER = new THREE.Vector2(0, 0);

function updateTarget() {
  raycaster.setFromCamera(CENTER, camera);
  raycaster.far = CONFIG.interactDistance;
  const tool = tools.pick(raycaster);
  if (tool === app.target) return;
  app.target = tool;
  tools.setTarget(tool);
  hud.setPrompt(tool ? `${tool.id} · open control panel` : null);
}

function trackZone() {
  const zone = tools.zoneAt(camera.position.x, camera.position.z);
  const id = zone ? zone.id : null;
  if (id === app.zone) return;
  if (app.zone) log.add('zone', { tool: app.zone, enter: false });
  if (id) log.add('zone', { tool: id, enter: true });
  app.zone = id;
}

function samplePosition(dt) {
  app.sampleTimer -= dt;
  if (app.sampleTimer > 0) return;
  app.sampleTimer = 0.5;
  const { x, z, yawDeg } = currentPose();
  log.samplePosition(x, z, yawDeg);
}

function updateDebug(fps) {
  if (!player || ui.debug.classList.contains('is-hidden')) return;
  const { x, z, yawDeg } = currentPose();
  const cell = nav ? (nav.isWalkable(x, z) ? 'walkable' : 'blocked') : 'no grid';
  ui.debug.textContent =
    `x ${x.toFixed(2)}  z ${z.toFixed(2)}  yaw ${yawDeg}°\n` +
    `fps ${fps}  collisions ${player.noclip ? 'off' : 'on'}  ${cell}\n` +
    `t ${app.t.toFixed(1)}s  mode ${app.mode}${app.zone ? `  at ${app.zone}` : ''}`;
}

// ---------- Main loop ----------
let last = performance.now();
let fpsFrames = 0;
let fpsStart = last;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const running =
    app.started && runner && !runner.ended && (app.mode === 'walking' || app.mode === 'panel' || app.mode === 'relocking');
  if (running) {
    app.t += dt;
    log.t = app.t;
    runner.update(app.t);
  }
  const sdt = running ? dt : 0;

  if (player) {
    player.update(dt);
    camera.updateMatrixWorld(); // so labels, raycasts and audio use this frame's camera pose
    tools.update(sdt, app.t, camera, window.innerWidth, window.innerHeight, app.mode !== 'results');
    oht.update(sdt);
    if (app.mode === 'walking') updateTarget();
    if (running) {
      trackZone();
      samplePosition(sdt);
    }
    hud.setClock(app.t);
    hud.setAlarmCount(tools.activeAlarms().length);

    app.panelTimer -= dt;
    if (app.panelTimer <= 0) {
      app.panelTimer = 0.25;
      if (toolPanel.isOpen) toolPanel.refresh();
      if (dashboard.isOpen) dashboard.refresh();
    }
    if (minimap) {
      const h = player.getHeading(_heading);
      minimap.update(camera.position.x, camera.position.z, h.x, h.z);
    }
  }

  fpsFrames++;
  if (now - fpsStart > 500) {
    updateDebug(Math.round((fpsFrames * 1000) / (now - fpsStart)));
    fpsFrames = 0;
    fpsStart = now;
  }

  renderer.render(scene, camera);
});

boot().catch((err) => {
  console.error(err);
  ui.loadingText.textContent = 'Loading failed.';
  showError(`Couldn't start: ${err?.message || err}`);
});
