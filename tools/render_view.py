"""Quick CPU point-splat preview of the world from a given pose (for layout checks).
Usage: python3 render_view.py x y z yawDeg pitchDeg out.png [overlay boxes as x0,x1,z0,z1,top;...]"""
import sys, numpy as np
from PIL import Image, ImageDraw
from spz_decode import decode

def render(pos, a, rgb, sc, eye, yaw_deg, pitch_deg=0, W=960, H=540, fov=70):
    yaw = np.radians(yaw_deg); pitch = np.radians(pitch_deg)
    f = np.array([-np.sin(yaw)*np.cos(pitch), np.sin(pitch), -np.cos(yaw)*np.cos(pitch)])
    rgt = np.array([np.cos(yaw), 0, -np.sin(yaw)]); up = np.cross(rgt, f)
    rel = pos - np.array(eye); zc = rel @ f; xc = rel @ rgt; yc = rel @ up
    m = (zc > 0.2) & (a > 0.25)
    fpx = (W/2) / np.tan(np.radians(fov/2))
    u = W/2 + fpx * xc[m]/zc[m]; v = H/2 - fpx * yc[m]/zc[m]
    rad = np.clip(fpx * sc[m].max(1) * 1.2 / zc[m], 0.5, 5).round().astype(int)
    z = zc[m]; c = rgb[m]
    img = np.zeros((H, W, 3)); zb = np.full((H, W), np.inf)
    o = np.argsort(-z); u, v, z, c, rad = u[o], v[o], z[o], c[o], rad[o]
    for R in range(0, 6):
        sel = rad == R if R < 5 else rad >= 5
        offs = [(dx, dy) for dx in range(-R, R+1) for dy in range(-R, R+1) if dx*dx+dy*dy <= R*R] or [(0, 0)]
        for dx, dy in offs:
            x = (u[sel]+dx).astype(int); y = (v[sel]+dy).astype(int); zz = z[sel]; cc = c[sel]
            k = (x >= 0) & (x < W) & (y >= 0) & (y < H)
            x, y, zz, cc = x[k], y[k], zz[k], cc[k]
            # far-to-near order already: later (nearer) writes win where nearer than current
            better = zz <= zb[y, x]
            zb[y[better], x[better]] = zz[better]; img[y[better], x[better]] = cc[better]
    proj = lambda p: (W/2 + fpx * ((np.array(p)-eye) @ rgt) / ((np.array(p)-eye) @ f), H/2 - fpx * ((np.array(p)-eye) @ up) / ((np.array(p)-eye) @ f), (np.array(p)-eye) @ f)
    return Image.fromarray((np.clip(img, 0, 1)*255).astype(np.uint8)), proj

if __name__ == "__main__":
    x, y, z, yaw, pitch = map(float, sys.argv[1:6]); out = sys.argv[6]
    d = decode(sys.argv[8] if len(sys.argv) > 8 else "../assets/fab.spz")
    im, proj = render(d['pos'], d['alpha'], d['rgb'], d['scale'], np.array([x, y, z]), yaw, pitch)
    if len(sys.argv) > 7 and sys.argv[7]:
        dr = ImageDraw.Draw(im)
        for spec in sys.argv[7].split(';'):
            x0, x1, z0, z1, top = map(float, spec.split(','))
            corners = [(x0, 0, z0), (x1, 0, z0), (x1, 0, z1), (x0, 0, z1), (x0, top, z0), (x1, top, z0), (x1, top, z1), (x0, top, z1)]
            P = [proj(cn) for cn in corners]
            for i, j in [(0,1),(1,2),(2,3),(3,0),(4,5),(5,6),(6,7),(7,4),(0,4),(1,5),(2,6),(3,7)]:
                if P[i][2] > 0.2 and P[j][2] > 0.2:
                    dr.line([P[i][:2], P[j][:2]], fill=(255, 40, 40), width=2)
    im.save(out)
