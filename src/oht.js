import * as THREE from 'three';

// Overhead hoist transport (OHT): vehicles running along the ceiling rails, carrying FOUPs.
// Ambient vehicles loop up and down the bay; scenario lots are delivered to a tool's load port
// (the vehicle stops above the port, lowers the FOUP on its hoist belts, then leaves).

const BODY_H = 0.42;
const FOUP_H = 0.33;
const TRAVEL_SPEED = 1.2; // m/s for deliveries
const LOWER_SECONDS = 4;
const RAISE_SECONDS = 2.5;

const smooth = (x) => x * x * (3 - 2 * x);

export class OhtSystem {
  constructor(scene, rails, audio) {
    this.scene = scene;
    this.rails = rails;
    this.audio = audio;
    this.vehicles = [];
    this.placed = []; // FOUPs left on load ports
    this.busy = { left: false, right: false };
    this.mats = {
      body: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.45, metalness: 0.15 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.6, metalness: 0.2 }),
      stripe: new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.5 }),
      foup: new THREE.MeshStandardMaterial({ color: 0xe9e4d4, roughness: 0.35, metalness: 0.05 }),
      door: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.4 }),
      belt: new THREE.MeshBasicMaterial({ color: 0x1d2025 }),
    };
    this.addLooper('left', -4.0, -1, 1.0);
    this.addLooper('right', -9.5, 1, 0.9);
  }

  makeFoup() {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(0.39, FOUP_H, 0.42), this.mats.foup);
    g.add(shell);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.02, FOUP_H - 0.05, 0.36), this.mats.door);
    door.position.x = 0.2;
    g.add(door);
    const flange = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.2), this.mats.dark);
    flange.position.y = FOUP_H / 2 + 0.015;
    g.add(flange);
    return g;
  }

  makeVehicle(side, z, withFoup = true) {
    const rail = this.rails[side];
    const group = new THREE.Group();
    group.position.set(rail.x, rail.y, z);

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, BODY_H, 0.85), this.mats.body);
    body.position.y = -BODY_H / 2;
    group.add(body);
    const trolley = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.5), this.mats.dark);
    trolley.position.y = 0.04;
    group.add(trolley);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.505, 0.04, 0.855), this.mats.stripe);
    stripe.position.y = -BODY_H + 0.08;
    group.add(stripe);

    const hoist = new THREE.Group();
    hoist.position.y = -BODY_H;
    group.add(hoist);
    const gripper = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.3), this.mats.dark);
    gripper.position.y = -0.02;
    hoist.add(gripper);
    let foup = null;
    if (withFoup) {
      foup = this.makeFoup();
      foup.position.y = -0.04 - FOUP_H / 2 - 0.03;
      hoist.add(foup);
    }
    const belts = [-0.1, 0.1].map((dx) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.025, 1, 0.012), this.mats.belt);
      b.position.set(dx, -BODY_H, 0);
      b.visible = false;
      group.add(b);
      return b;
    });

    this.scene.add(group);
    const sound = this.audio?.attachLoop(group, 'whir', { volume: 0.35, refDistance: 1.5, rolloff: 1.6, maxDistance: 25 });
    return { group, hoist, belts, foup, side, z, sound, lowered: 0 };
  }

  setLowered(v, amount) {
    v.lowered = amount;
    v.hoist.position.y = -BODY_H - amount;
    for (const b of v.belts) {
      b.visible = amount > 0.01;
      b.scale.y = Math.max(amount, 0.001);
      b.position.y = -BODY_H - amount / 2;
    }
  }

  addLooper(side, z, dir, speed) {
    const v = this.makeVehicle(side, z);
    Object.assign(v, { mode: 'loop', dir, speed });
    this.vehicles.push(v);
  }

  // Deliver a lot: arrive above `port` and finish lowering exactly `inSeconds` from now.
  deliver({ lot, side, port, inSeconds }) {
    const { zMin } = this.rails;
    const travel = Math.abs(port.z - zMin) / TRAVEL_SPEED;
    const wait = inSeconds - LOWER_SECONDS - travel;
    const v = this.makeVehicle(side, zMin);
    Object.assign(v, {
      mode: 'deliver',
      phase: wait > 0 ? 'wait' : 'travel',
      timer: Math.max(0, wait),
      lot,
      port: port.clone(),
      speed: TRAVEL_SPEED,
    });
    if (wait < 0) v.z = Math.min(port.z, zMin + TRAVEL_SPEED * -wait);
    v.group.position.z = v.z;
    v.group.visible = wait <= 0;
    v.maxLower = this.rails[side].y - BODY_H - 0.04 - 0.03 - FOUP_H - port.y;
    this.busy[side] = true;
    this.vehicles.push(v);
    return v;
  }

  update(dt) {
    if (dt <= 0) return;
    const { zMin, zMax } = this.rails;
    for (const v of [...this.vehicles]) {
      if (v.mode === 'loop') this.updateLooper(v, dt, zMin, zMax);
      else this.updateDelivery(v, dt, zMax);
    }
  }

  updateLooper(v, dt, zMin, zMax) {
    if (v.parked) {
      if (this.busy[v.side]) return;
      v.parked = false;
      v.group.visible = true;
      v.sound?.setVolume(0.35);
    }
    v.z += v.dir * v.speed * dt;
    if (v.z > zMax || v.z < zMin) {
      v.z = v.dir > 0 ? zMin : zMax; // wrap around
      if (this.busy[v.side]) {
        // A delivery is using this rail: wait off-screen until it's done.
        v.parked = true;
        v.group.visible = false;
        v.sound?.setVolume(0);
      }
    }
    const edge = Math.min(v.z - zMin, zMax - v.z);
    v.group.scale.setScalar(Math.max(0.001, smooth(Math.min(1, edge / 0.8))));
    v.group.position.z = v.z;
  }

  updateDelivery(v, dt, zMax) {
    switch (v.phase) {
      case 'wait':
        v.timer -= dt;
        if (v.timer <= 0) {
          v.phase = 'travel';
          v.group.visible = true;
        }
        break;
      case 'travel': {
        const remaining = v.port.z - v.z;
        const step = Math.sign(remaining) * Math.min(Math.abs(remaining), v.speed * dt);
        v.z += step;
        v.group.position.z = v.z;
        if (Math.abs(v.port.z - v.z) < 1e-3) {
          v.phase = 'lower';
          v.timer = 0;
        }
        break;
      }
      case 'lower':
        v.timer += dt;
        this.setLowered(v, v.maxLower * smooth(Math.min(1, v.timer / LOWER_SECONDS)));
        if (v.timer >= LOWER_SECONDS) {
          this.release(v);
          v.phase = 'raise';
          v.timer = 0;
        }
        break;
      case 'raise':
        v.timer += dt;
        this.setLowered(v, v.maxLower * (1 - smooth(Math.min(1, v.timer / RAISE_SECONDS))));
        if (v.timer >= RAISE_SECONDS) {
          v.phase = 'leave';
          this.busy[v.side] = false;
        }
        break;
      case 'leave':
        v.z += v.speed * dt;
        v.group.position.z = v.z;
        v.group.scale.setScalar(Math.max(0.001, smooth(Math.min(1, (zMax - v.z) / 0.8))));
        if (v.z >= zMax) this.remove(v);
        break;
    }
  }

  // Detach the FOUP and leave it sitting on the load port.
  release(v) {
    if (!v.foup) return;
    v.hoist.remove(v.foup);
    v.foup.position.set(v.port.x, v.port.y + FOUP_H / 2 + 0.01, v.port.z);
    this.scene.add(v.foup);
    this.placed.push(v.foup);
    v.foup = null;
  }

  remove(v) {
    this.audio?.detach(v.sound);
    this.scene.remove(v.group);
    this.vehicles.splice(this.vehicles.indexOf(v), 1);
  }
}
