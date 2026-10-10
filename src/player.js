import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

// First-person walker: mouse look via pointer lock, WASD movement, collisions from the NavGrid.
export class Player extends THREE.EventDispatcher {
  constructor(camera, domElement, navGrid, config) {
    super();
    this.camera = camera;
    this.nav = navGrid;
    this.config = config;
    this.keys = new Set();
    this.noclip = config.noclip || !navGrid;

    this.controls = new PointerLockControls(camera, domElement);
    this.controls.addEventListener('lock', () => this.dispatchEvent({ type: 'lock' }));
    this.controls.addEventListener('unlock', () => {
      this.keys.clear();
      this.dispatchEvent({ type: 'unlock' });
    });

    this.respawn();

    window.addEventListener('keydown', (e) => {
      if (!this.controls.isLocked) return;
      if (MOVE_KEYS.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get isLocked() {
    return this.controls.isLocked;
  }

  lock() {
    this.controls.lock();
  }

  unlock() {
    if (this.controls.isLocked) this.controls.unlock();
  }

  respawn() {
    const { spawn, eyeHeight } = this.config;
    this.camera.position.set(spawn.x, eyeHeight, spawn.z);
    this.camera.rotation.set(0, THREE.MathUtils.degToRad(spawn.yawDeg), 0, 'YXZ');
  }

  setNoclip(on) {
    this.noclip = on;
    if (!on) {
      // Back to walking: drop to eye height and leave any spot we flew into.
      this.camera.position.y = this.config.eyeHeight;
      const p = this.camera.position;
      if (this.nav && !this.nav.isWalkable(p.x, p.z)) this.respawn();
    }
  }

  // Horizontal facing direction (unit vector on the floor plane).
  getHeading(target = new THREE.Vector3()) {
    this.camera.getWorldDirection(target);
    target.y = 0;
    return target.normalize();
  }

  update(dt) {
    if (!this.controls.isLocked) return;
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const lift = this.noclip ? (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0) : 0;
    if (!fwd && !strafe && !lift) return;

    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = fast ? this.config.fastSpeed : this.config.walkSpeed;

    this.getHeading(_forward);
    _right.set(-_forward.z, 0, _forward.x); // forward rotated 90° clockwise seen from above
    const len = Math.hypot(fwd, strafe) || 1;
    const dx = ((_forward.x * fwd + _right.x * strafe) / len) * speed * dt;
    const dz = ((_forward.z * fwd + _right.z * strafe) / len) * speed * dt;

    const p = this.camera.position;
    if (this.noclip) {
      p.x += dx;
      p.z += dz;
      p.y += lift * speed * dt;
    } else {
      const [nx, nz] = this.nav.move(p.x, p.z, dx, dz);
      p.set(nx, this.config.eyeHeight, nz);
    }
  }
}
