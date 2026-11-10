#!/usr/bin/env python3
"""sine.py <a.wav> [hz=660]: discontinuities in A's own stream of a pure sine.
Per 32-frame block: least-squares amplitude+phase fit; flags blocks where the fit residual is
large (a splice/repeat/skip inside), phase jumps vs the running phase, and zero runs."""
import sys, numpy as np, ana
d = ana.load(sys.argv[1]); x = d[:, 0].astype(np.float64)
hz = float(sys.argv[2]) if len(sys.argv) > 2 else 660
sr = 48000; B = 32
n = len(x) // B
t = np.arange(B) / sr
w = 2 * np.pi * hz
C = np.cos(w * t); Sn = np.sin(w * t)
M = np.stack([C, Sn], 1)
P = np.linalg.pinv(M)
amp = np.zeros(n); ph = np.zeros(n); res = np.zeros(n)
for i in range(n):
    y = x[i*B:(i+1)*B]
    a, b = P @ y
    amp[i] = np.hypot(a, b); ph[i] = np.arctan2(-b, a)
    r = y - M @ np.array([a, b]); res[i] = np.sqrt((r**2).mean()) / (amp[i] / np.sqrt(2) + 1e-12)
# expected phase advance per block
adv = (w * B / sr) % (2*np.pi)
dph = np.angle(np.exp(1j * (ph[1:] - ph[:-1] - adv)))
live = amp > 1e-3
jumps = [(round((i+1)*B/sr, 4), round(float(dph[i]), 2)) for i in range(n-1) if live[i] and live[i+1] and abs(dph[i]) > 0.05]
bad = [(round(i*B/sr, 4), round(float(res[i]), 3)) for i in range(n) if live[i] and res[i] > 0.02]
lv = np.nonzero(live)[0]
print(f"len {len(x)/sr:.2f}s live {lv[0]*B/sr if len(lv) else 0:.2f}-{lv[-1]*B/sr if len(lv) else 0:.2f}s jumps {len(jumps)} badfit {len(bad)}")
print("jumps", jumps[:20]); print("badfit", bad[:20])
