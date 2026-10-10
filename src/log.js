// Session log: everything that happens during an assessment, on one timeline.
// `t` is scenario time in seconds (the clock pauses while the game is paused).

export class SessionLog {
  constructor() {
    this.t = 0;
    this.meta = {};
    this.entries = []; // { t, type: 'event' | 'action' | 'zone' | 'ui', ... }
    this.positions = []; // [t, x, z, yawDeg] sampled while walking
  }

  add(type, data = {}) {
    const entry = { t: round(this.t, 2), type, ...data };
    this.entries.push(entry);
    return entry;
  }

  samplePosition(x, z, yawDeg) {
    this.positions.push([round(this.t, 2), round(x, 2), round(z, 2), Math.round(yawDeg)]);
  }

  toJSON() {
    return { meta: this.meta, entries: this.entries, positions: this.positions };
  }
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
