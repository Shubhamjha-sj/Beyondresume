// Top-down minimap. The floor-plan image was rendered from the splats (tools/build_navgrid.py),
// with -z (down the aisle) pointing up, so map coordinates are a simple linear mapping.

export class Minimap {
  constructor(markerEl, plan) {
    this.marker = markerEl;
    this.plan = plan; // { x0, z0, x1, z1, pxPerMetre }
  }

  static async load(url, markerEl) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return new Minimap(markerEl, await res.json());
  }

  // Percent position of a world point on the map (useful later for tool and zone markers).
  toPercent(x, z) {
    const { x0, z0, x1, z1 } = this.plan;
    return [((x - x0) / (x1 - x0)) * 100, ((z - z0) / (z1 - z0)) * 100];
  }

  update(x, z, headingX, headingZ) {
    const [u, v] = this.toPercent(x, z);
    const angle = (Math.atan2(headingX, -headingZ) * 180) / Math.PI; // 0° = facing -z = map up
    this.marker.style.left = `${u}%`;
    this.marker.style.top = `${v}%`;
    this.marker.style.transform = `translate(-50%, -60%) rotate(${angle}deg)`;
  }
}
