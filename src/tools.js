import * as THREE from 'three';

// Fab tools layered on top of the splat world: invisible hit boxes for interaction,
// stack lights that show tool state, floating name tags, and "near this tool" floor zones.

export const STATE_INFO = {
  running: { label: 'Running', color: '#3ecf6b' },
  idle: { label: 'Idle', color: '#f2b705' },
  hold: { label: 'On hold', color: '#f2b705' },
  alarm: { label: 'Alarm', color: '#ff4d4d' },
  pm: { label: 'Down (PM)', color: '#4da3ff' },
  emo: { label: 'EMO (powered off)', color: '#8b97a6' },
};

const READINGS = {
  Etch: [
    { key: 'chamberA', label: 'Chamber A pressure', unit: 'mTorr', value: 45, limit: 120, digits: 0 },
    { key: 'chamberB', label: 'Chamber B pressure', unit: 'mTorr', value: 47, limit: 120, digits: 0 },
    { key: 'rf', label: 'RF power', unit: 'W', value: 1200, digits: 0 },
    { key: 'he', label: 'Helium backside', unit: 'Torr', value: 12, digits: 1 },
    { key: 'chuck', label: 'Chuck temperature', unit: '°C', value: 40, digits: 1 },
  ],
  Litho: [
    { key: 'stage', label: 'Stage temperature', unit: '°C', value: 22, digits: 2 },
    { key: 'dose', label: 'Exposure dose', unit: 'mJ/cm²', value: 32.5, digits: 1 },
    { key: 'focus', label: 'Focus offset', unit: 'nm', value: 4, digits: 1 },
    { key: 'wph', label: 'Throughput', unit: 'wafers/h', value: 182, digits: 0 },
  ],
  CVD: [
    { key: 'pressure', label: 'Chamber pressure', unit: 'Torr', value: 2.1, limit: 4, digits: 2 },
    { key: 'heater', label: 'Heater temperature', unit: '°C', value: 400, digits: 0 },
    { key: 'sih4', label: 'SiH₄ flow', unit: 'sccm', value: 180, digits: 0 },
    { key: 'rf', label: 'RF power', unit: 'W', value: 600, digits: 0 },
  ],
  PVD: [
    { key: 'base', label: 'Base pressure', unit: 'µTorr', value: 0.02, digits: 3 },
    { key: 'target', label: 'Target power', unit: 'kW', value: 18, digits: 1 },
    { key: 'ar', label: 'Argon flow', unit: 'sccm', value: 25, digits: 1 },
    { key: 'temp', label: 'Chamber temperature', unit: '°C', value: 300, digits: 0 },
  ],
};

const LAMP_COLORS = { red: 0xff3b30, amber: 0xffb300, green: 0x34c759, blue: 0x2f80ff };

let glowTexture = null;
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

export class Tool {
  constructor(def, rails, scene, labelsEl) {
    this.def = def;
    this.id = def.id;
    this.type = def.type;
    this.side = def.side;
    this.state = def.state || 'running';
    this.lot = def.lot || null;
    this.note = def.note || '';
    this.alarm = null; // { code, message, reading, value, limit, unit, t, acked }
    this.queue = []; // lots delivered to the load port
    this.readings = (READINGS[def.type] || []).map((r) => ({ ...r, current: r.value }));
    this.wafer = 1 + Math.floor(Math.random() * 20);

    const [x0, x1, z0, z1] = def.module;
    const top = def.top;
    const right = def.side === 'right';
    const inner = right ? x0 : x1; // edge facing the aisle
    const outer = right ? x1 : x0;
    const out = right ? 1 : -1; // direction away from the aisle
    const cz = (z0 + z1) / 2;
    this.center = new THREE.Vector3((x0 + x1) / 2, top, cz);

    // Hit box: the load-port module plus the tool face behind it.
    const hx0 = right ? x0 - 0.05 : x0 - 0.6;
    const hx1 = right ? x1 + 0.6 : x1 + 0.05;
    this.hotspot = new THREE.Mesh(new THREE.BoxGeometry(hx1 - hx0, 2.1, z1 - z0 + 0.1), new THREE.MeshBasicMaterial());
    this.hotspot.position.set((hx0 + hx1) / 2, 1.05, cz);
    this.hotspot.visible = false; // still raycastable
    this.hotspot.userData.tool = this;
    scene.add(this.hotspot);
    this.hotspot.updateMatrixWorld(true);

    // Highlight outline shown when the crosshair is on the tool.
    const box = new THREE.BoxGeometry(x1 - x0 + 0.08, top + 0.06, z1 - z0 + 0.08);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xf2b705, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.outline.position.set((x0 + x1) / 2, (top + 0.06) / 2, cz);
    this.outline.renderOrder = 30;
    this.outline.visible = false;
    scene.add(this.outline);

    // Stack light on the module's outer corner nearest the bay entrance.
    this.light = this.buildStackLight(new THREE.Vector3(outer - out * 0.15, top, z1 - 0.15));
    scene.add(this.light.group);

    // Where an overhead vehicle sets a FOUP down.
    const rail = rails[def.side];
    this.port = new THREE.Vector3(rail.x, top, cz);

    // Name tag
    this.labelPos = new THREE.Vector3((x0 + x1) / 2, 2.25, cz);
    this.labelEl = document.createElement('div');
    this.labelEl.className = 'tool-label';
    this.labelEl.innerHTML = `<i></i><b>${def.id}</b><small>${def.process || def.type}</small>`;
    labelsEl.appendChild(this.labelEl);

    // Floor area that counts as "at this tool" (for the log).
    // Reaches about halfway across the aisle; overlaps are resolved by nearest tool.
    this.zone = right
      ? { x0: inner - 1.9, x1: outer + 0.6, z0: z0 - 1.0, z1: z1 + 1.0 }
      : { x0: outer - 0.6, x1: inner + 1.9, z0: z0 - 1.0, z1: z1 + 1.0 };

    this.applyState();
  }

  buildStackLight(base) {
    const group = new THREE.Group();
    group.position.copy(base);
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.3 });
    const poleHeight = Math.max(0.3, 1.5 - base.y);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, poleHeight, 10), dark);
    pole.position.y = poleHeight / 2;
    group.add(pole);

    const lamps = {};
    const order = ['blue', 'green', 'amber', 'red']; // bottom to top
    const h = 0.075;
    order.forEach((name, i) => {
      const mat = new THREE.MeshBasicMaterial({ color: LAMP_COLORS[name] });
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, h, 18), mat);
      lamp.position.y = poleHeight + h / 2 + i * (h + 0.006);
      group.add(lamp);
      lamps[name] = { mesh: lamp, mat, on: null }; // null forces the first update to set the colour
    });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.02, 18), dark);
    cap.position.y = poleHeight + order.length * (h + 0.006) + 0.01;
    group.add(cap);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: LAMP_COLORS.red,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      }),
    );
    glow.scale.setScalar(0.7);
    glow.position.y = lamps.red.mesh.position.y;
    glow.renderOrder = 20;
    group.add(glow);

    // Sound anchor for this tool's alarm horn.
    const anchor = new THREE.Object3D();
    anchor.position.y = lamps.red.mesh.position.y;
    group.add(anchor);

    return { group, lamps, glow, anchor };
  }

  get alarmAnchor() {
    return this.light.anchor;
  }

  get stateInfo() {
    return STATE_INFO[this.state] || STATE_INFO.running;
  }

  // Which lamps should be lit: 'on', 'blink' or undefined (off).
  lampPlan() {
    if (this.state === 'emo') return {};
    const plan = {};
    if (this.alarm) plan.red = this.alarm.acked ? 'on' : 'blink';
    if (this.state === 'running') plan.green = 'on';
    if (this.state === 'idle' || this.state === 'hold') plan.amber = 'on';
    if (this.state === 'pm') plan.blue = 'on';
    return plan;
  }

  applyState() {
    this.labelEl.style.setProperty('--state', this.stateInfo.color);
    this.labelEl.classList.toggle('is-alarm', !!this.alarm && !this.alarm.acked);
  }

  update(dt, t) {
    const plan = this.lampPlan();
    const blinkOn = Math.floor(t * 2.5) % 2 === 0;
    for (const [name, lamp] of Object.entries(this.light.lamps)) {
      const mode = plan[name];
      const lit = mode === 'on' || (mode === 'blink' && blinkOn);
      if (lit !== lamp.on) {
        lamp.on = lit;
        lamp.mat.color.setHex(LAMP_COLORS[name]);
        if (!lit) lamp.mat.color.multiplyScalar(0.16);
      }
    }
    const red = this.light.lamps.red.on;
    this.light.glow.material.opacity = red ? (this.alarm?.acked ? 0.55 : 0.9) : 0;

    // Sensor read-outs drift a little; the faulted reading keeps creeping up.
    this.jitterTimer = (this.jitterTimer || 0) - dt;
    if (this.jitterTimer <= 0) {
      this.jitterTimer = 0.6;
      for (const r of this.readings) {
        if (this.state === 'emo') {
          r.current = 0;
          continue;
        }
        let base = r.value;
        if (this.alarm && this.alarm.reading === r.key) base = this.alarm.value + 0.06 * (t - this.alarm.t);
        r.current = base * (1 + (Math.random() - 0.5) * 0.012);
      }
    }
  }
}

export class ToolManager {
  constructor(scene, layout, labelsEl) {
    this.scene = scene;
    this.labelsEl = labelsEl;
    this.tools = new Map();
    for (const def of layout.tools) this.tools.set(def.id, new Tool(def, layout.rails, scene, labelsEl));
    this.hotspots = [...this.tools.values()].map((t) => t.hotspot);
    this.target = null;
    this.showAll = false;
    this._v = new THREE.Vector3();
  }

  get(id) {
    return this.tools.get(id);
  }

  list() {
    return [...this.tools.values()];
  }

  activeAlarms() {
    return this.list().filter((t) => t.alarm);
  }

  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.hotspots, false);
    return hits.length ? hits[0].object.userData.tool : null;
  }

  setTarget(tool) {
    if (this.target === tool) return;
    if (this.target && !this.showAll) this.target.outline.visible = false;
    this.target = tool;
    if (tool) tool.outline.visible = true;
  }

  // Dev aid: outline every tool's module so positions can be checked against the splats.
  setShowAll(on) {
    this.showAll = on;
    for (const t of this.tools.values()) t.outline.visible = on || t === this.target;
  }

  zoneAt(x, z) {
    let best = null;
    let bestD = Infinity;
    for (const t of this.tools.values()) {
      const r = t.zone;
      if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      const d = Math.hypot(x - t.center.x, z - t.center.z);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  // ---- state changes (each returns { ok, message } for the UI) ----
  setAlarm(id, evt, t) {
    const tool = this.get(id);
    if (!tool || tool.state === 'emo') return null;
    tool.alarm = {
      code: evt.code,
      message: evt.message,
      reading: evt.reading,
      value: evt.value,
      limit: evt.limit,
      unit: evt.unit,
      t,
      acked: false,
    };
    if (tool.state !== 'hold' && tool.state !== 'pm') tool.state = 'alarm';
    tool.applyState();
    return tool;
  }

  ack(id) {
    const tool = this.get(id);
    if (!tool?.alarm) return { ok: false, message: 'There is no active alarm on this tool.' };
    if (tool.alarm.acked) return { ok: false, message: 'Alarm already acknowledged.' };
    tool.alarm.acked = true;
    tool.applyState();
    return { ok: true, message: 'Alarm acknowledged. Horn silenced; the alarm stays active until it is fixed.' };
  }

  hold(id) {
    const tool = this.get(id);
    if (!tool) return { ok: false, message: 'Unknown tool.' };
    if (tool.state === 'emo') return { ok: false, message: 'Tool is powered off.' };
    if (tool.state === 'pm') return { ok: false, message: 'Tool is already down for maintenance.' };
    if (tool.state === 'hold') return { ok: false, message: 'Tool is already on hold.' };
    tool.state = 'hold';
    tool.applyState();
    return { ok: true, message: `${tool.id} is on hold. It won't start any new wafers.` };
  }

  resetResume(id) {
    const tool = this.get(id);
    if (!tool?.alarm) return { ok: false, message: 'There is no alarm to reset.' };
    tool.alarm = null;
    tool.state = 'running';
    tool.applyState();
    return { ok: true, message: 'Alarm cleared. Processing resumed.' };
  }

  emo(id) {
    const tool = this.get(id);
    if (!tool) return { ok: false, message: 'Unknown tool.' };
    if (tool.state === 'emo') return { ok: false, message: 'Tool is already powered off.' };
    tool.state = 'emo';
    tool.alarm = null;
    tool.applyState();
    return { ok: true, message: 'EMERGENCY OFF activated. All power to the tool is cut.' };
  }

  // ---- per frame ----
  update(dt, t, camera, width, height, showLabels = true) {
    for (const tool of this.tools.values()) {
      tool.update(dt, t);
      const el = tool.labelEl;
      if (!showLabels) {
        el.style.opacity = '0';
        continue;
      }
      const v = this._v.copy(tool.labelPos).project(camera);
      const dist = camera.position.distanceTo(tool.labelPos);
      const fade = Math.min(1, Math.max(0, (17 - dist) / 6));
      if (v.z > 1 || v.z < -1 || fade <= 0) {
        el.style.opacity = '0';
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height;
      el.style.opacity = String(fade);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }
}
