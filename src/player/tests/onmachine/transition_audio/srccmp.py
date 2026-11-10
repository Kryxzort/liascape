#!/usr/bin/env python3
"""srccmp.py <trial base> <scene dir> : A's own stream vs the scene's (single, looping) sound file x the equal-power fade.
Aligns the decoded sound to the 2 s before the fade (1 ms envelope correlation), then per 20 ms bin:
dev = A - src - (pre-fade offset) - 20 log10 cos(pi/2 p). Prints the pre offset, the envelope correlation and
dev's p50/p95/max over bins where the source is above -40 dBFS (a dip/warble of our making shows as |dev| >> 1 dB)."""
import sys, os, json, struct, subprocess, tempfile, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ana
base, scene = sys.argv[1], sys.argv[2]
f = open(os.path.join(scene, 'scene.pkg'), 'rb')
u32 = lambda: struct.unpack('<I', f.read(4))[0]
n = u32(); f.read(n); cnt = u32(); ents = []
for _ in range(cnt):
    l = u32(); name = f.read(l).decode(errors='replace'); off = u32(); ln = u32(); ents.append((name, off, ln))
ds = f.tell()
snd = [e for e in ents if e[0].lower().endswith(('.mp3', '.ogg', '.wav', '.flac'))]
if len(snd) != 1:
    print(json.dumps({"skip": f"{len(snd)} sound files"})); sys.exit(0)
name, off, ln = snd[0]
f.seek(ds + off); blob = f.read(ln)
td = tempfile.mkdtemp()
p = os.path.join(td, 's' + os.path.splitext(name)[1]); open(p, 'wb').write(blob)
raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', p, '-ar', '48000', '-ac', '2', '-f', 'f32le', '-'], capture_output=True).stdout
src = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).mean(1).astype(np.float64)
src = np.concatenate([src, src, src])  # it loops
a = ana.load(base + '.a.wav').mean(1).astype(np.float64)
nz = np.nonzero(np.abs(a) > 0)[0]; end = nz[-1]; t0 = end - int(2.5 * 48000)
c0 = t0 - int(2.0 * 48000)
env = lambda x: np.sqrt((x[: len(x) // 48 * 48].reshape(-1, 48) ** 2).mean(1))
ec = env(a[c0:t0]); es = env(src)
L = len(ec); ecz = (ec - ec.mean()) / (ec.std() + 1e-12)
best = (-2, 0)
for k in range(0, len(es) - L, 1):
    v = es[k:k + L]; sd = v.std()
    if sd < 1e-9: continue
    cc = float(np.dot((v - v.mean()) / sd, ecz) / L)
    if cc > best[0]: best = (cc, k)
pos0 = best[1] * 48 - c0
al = np.zeros_like(a); lo = max(0, -pos0); hi = min(len(a), len(src) - pos0)
al[lo:hi] = src[lo + pos0: hi + pos0]
ea = ana.env_db(a, 960); esd = ana.env_db(al, 960)
s0 = t0 // 960; e0 = end // 960
pre = ea[s0 - 100: s0] - esd[s0 - 100: s0]
offs = float(np.median(pre))
dev = []
for i in range(s0, e0 - 12):  # the last 0.25 s is under -20 dB of fade
    tt = (i - s0) * 0.02 + 0.01
    g = 20 * np.log10(max(np.cos(min(tt / 2.5, 1) * np.pi / 2), 1e-6))
    if esd[i] > -40:
        dev.append(ea[i] - esd[i] - offs - g)
dev = np.abs(np.array(dev))
pre_dev = np.abs(pre - offs)
print(json.dumps({"sound": name, "corr": round(best[0], 4), "offset_db": round(offs, 2),
                  "pre_dev_p95": round(float(np.percentile(pre_dev, 95)), 2),
                  "fade_dev_p50": round(float(np.percentile(dev, 50)), 2), "fade_dev_p95": round(float(np.percentile(dev, 95)), 2),
                  "fade_dev_max": round(float(dev.max()), 2), "bins": int(len(dev))}))
