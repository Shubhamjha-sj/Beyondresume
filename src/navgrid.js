// Walkability grid built offline from the splat world (tools/build_navgrid.py).
// Each cell is `cell` metres square; '1' = the player's centre may stand here.
// The grid is already shrunk by the player's radius, so one lookup per position is enough.

export class NavGrid {
  constructor({ x0, z0, cell, w, h, rows }) {
    Object.assign(this, { x0, z0, cell, w, h, rows });
  }

  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return new NavGrid(await res.json());
  }

  isWalkable(x, z) {
    const ix = Math.floor((x - this.x0) / this.cell);
    const iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return false;
    return this.rows[iz].charCodeAt(ix) === 49; // '1'
  }

  // Move from (x, z) by (dx, dz), sliding along walls instead of stopping dead.
  // Large steps are split so we never skip over a thin obstacle.
  move(x, z, dx, dz) {
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    for (let i = 0; i < steps; i++) {
      if (this.isWalkable(x + sx, z + sz)) { x += sx; z += sz; }
      else if (this.isWalkable(x + sx, z)) { x += sx; }
      else if (this.isWalkable(x, z + sz)) { z += sz; }
      else break;
    }
    return [x, z];
  }
}
