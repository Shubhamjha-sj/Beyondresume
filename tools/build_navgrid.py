"""Build a walkability grid (and a top-down floor-plan image) from a Marble SPZ world.
Usage: python3 build_navgrid.py <world.spz> <out_dir>
Writes navgrid.json (used for collisions) and floorplan.png (used for the minimap).
"""
import sys, json, numpy as np
from PIL import Image
from collections import deque
from spz_decode import decode

src, out = sys.argv[1], sys.argv[2]
d = decode(src)
pos, a, rgb = d['pos'], d['alpha'], d['rgb']

CELL = 0.1
X0, X1, Z0, Z1 = -5.0, 5.0, -14.0, 5.0
W, H = int(round((X1 - X0) / CELL)), int(round((Z1 - Z0) / CELL))
SPAWN = (-0.5, 2.0)   # (x, z) of the player start, must be on open floor
RADIUS = 0.25   # player radius in metres

def count(mask):
    p = pos[mask]
    ix = np.floor((p[:, 0] - X0) / CELL).astype(int); iz = np.floor((p[:, 2] - Z0) / CELL).astype(int)
    ok = (ix >= 0) & (ix < W) & (iz >= 0) & (iz < H)
    g = np.zeros((H, W), np.int32); np.add.at(g, (iz[ok], ix[ok]), 1); return g

def box(g, r):
    """sum over a (2r+1)^2 window"""
    p = np.pad(g, r)
    c = p.cumsum(0).cumsum(1); c = np.pad(c, ((1, 0), (1, 0)))
    k = 2 * r + 1
    return c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]

floor = box(count((a > 0.3) & (np.abs(pos[:, 1]) < 0.12)), 1)          # 0.3 m window
body = box(count((a > 0.5) & (pos[:, 1] > 0.25) & (pos[:, 1] < 2.0)), 1)

walk = (floor >= 6) & (body < 12)
# keep the player inside the main bay: splat quality drops off behind the tool rows
MAX_ABS_X = 3.5
xs = X0 + (np.arange(W) + 0.5) * CELL
walk[:, np.abs(xs) > MAX_ABS_X] = False

def flood(mask, seed):
    keep = np.zeros_like(mask); q = deque([seed])
    if not mask[seed]: return keep
    keep[seed] = True
    while q:
        r, c = q.popleft()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rr, cc = r + dr, c + dc
            if 0 <= rr < H and 0 <= cc < W and mask[rr, cc] and not keep[rr, cc]:
                keep[rr, cc] = True; q.append((rr, cc))
    return keep

seed = (int((SPAWN[1] - Z0) / CELL), int((SPAWN[0] - X0) / CELL))
# close tiny gaps in the floor (sparse splats) before flood fill
closed = box(walk.astype(np.int32), 1) >= 5
walk = flood(walk | (closed & (body < 12) & (np.abs(xs) <= MAX_ABS_X)[None, :]), seed)
# erode by player radius so the player's centre can use a single lookup
r = int(np.ceil(RADIUS / CELL))
blocked = ~walk
walk_c = box(blocked.astype(np.int32), r) == 0
walk_c = flood(walk_c, seed)
print("walkable cells", int(walk.sum()), "after erosion", int(walk_c.sum()), "area m2", round(walk_c.sum() * CELL * CELL, 1))

rows = ["".join("1" if v else "0" for v in row) for row in walk_c]
json.dump({"x0": X0, "z0": Z0, "cell": CELL, "w": W, "h": H, "rows": rows}, open(f"{out}/navgrid.json", "w"))

# floor-plan image: top-down colour of the highest splat under 3 m, 4 px per 0.1 m cell
S = 4
m = (a > 0.3) & (pos[:, 1] < 3.0) & (pos[:, 1] > -0.2)
p, c = pos[m], rgb[m]
ix = np.floor((p[:, 0] - X0) / (CELL / S)).astype(int); iz = np.floor((p[:, 2] - Z0) / (CELL / S)).astype(int)
ok = (ix >= 0) & (ix < W * S) & (iz >= 0) & (iz < H * S)
ix, iz, p, c = ix[ok], iz[ok], p[ok], c[ok]
o = np.argsort(p[:, 1])
img = np.zeros((H * S, W * S, 3), np.float32)
img[iz[o], ix[o]] = c[o]
Image.fromarray((img * 255).astype(np.uint8)).save(f"{out}/floorplan.png")
# debug overlay
dbg = img.copy()
wc = np.kron(walk_c, np.ones((S, S), bool))
dbg[wc] = dbg[wc] * 0.5 + np.array([0, 0.5, 0.2])
Image.fromarray((dbg * 255).astype(np.uint8)).save(f"{out}/navgrid_debug.png")
json.dump({"x0": X0, "z0": Z0, "x1": X1, "z1": Z1, "pxPerMetre": S / CELL}, open(f"{out}/floorplan.json", "w"))
