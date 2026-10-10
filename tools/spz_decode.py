"""Decode a Marble/Niantic SPZ (v2/v3) file into numpy arrays.
Marble UI downloads (since early 2026) are already in OpenGL / three.js axes (y up, floor near y=0, metres).
Raw API assets use OpenCV axes instead; pass opencv=True to rotate them 180 deg about X.
"""
import gzip, struct, numpy as np

SH_C0 = 0.28209479177387814

def decode(path, opencv=False):
    data = gzip.decompress(open(path, 'rb').read())
    magic, version, n, shdeg, fracbits, flags, _ = struct.unpack_from('<IIIBBBB', data, 0)
    assert magic == 0x5053474E, 'not an SPZ file'
    off = 16
    # positions: 3 x int24 per point, little-endian, fixed point
    p = np.frombuffer(data, dtype=np.uint8, count=n * 9, offset=off).reshape(n * 3, 3).astype(np.int32)
    off += n * 9
    v = p[:, 0] | (p[:, 1] << 8) | (p[:, 2] << 16)
    v = np.where(v & 0x800000, v - 0x1000000, v)
    pos = (v.astype(np.float32) / (1 << fracbits)).reshape(n, 3)
    alpha = np.frombuffer(data, dtype=np.uint8, count=n, offset=off).astype(np.float32) / 255.0
    off += n
    col = np.frombuffer(data, dtype=np.uint8, count=n * 3, offset=off).reshape(n, 3).astype(np.float32)
    off += n * 3
    dc = (col / 255.0 - 0.5) / 0.15
    rgb = np.clip(0.5 + SH_C0 * dc, 0, 1)
    scl = np.frombuffer(data, dtype=np.uint8, count=n * 3, offset=off).reshape(n, 3).astype(np.float32)
    off += n * 3
    log_scale = scl / 16.0 - 10.0
    if opencv:
        pos = pos * np.array([1, -1, -1], dtype=np.float32)
    return dict(version=version, n=n, pos=pos, alpha=alpha, rgb=rgb, scale=np.exp(log_scale), fracbits=fracbits, flags=flags)
