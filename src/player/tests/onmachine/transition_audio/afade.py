#!/usr/bin/env python3
"""afade.py <base> [--plot] : A's own stream around its fade-out.
The fade ends where A's stream goes to exact zero for good; the 2.5 s before it is the
equal-power fade (cos). Divides it out and compares the residual's 20 ms envelope with the
3 s before the fade: deep dips (> 10 dB under the local median), zero runs, level steps."""
import sys, json, numpy as np, ana

def stats(e):
    # e: 20 ms dB bins of the residual. Local median over 9 bins (180 ms).
    med = np.array([np.median(e[max(0, i - 4): i + 5]) for i in range(len(e))])
    dev = e - med
    return {"dips10": int((dev < -10).sum()), "dips6": int((dev < -6).sum()), "peaks6": int((dev > 6).sum()),
            "sd_step": round(float(np.std(np.diff(e))), 2), "n": len(e)}

def zero_runs(x, min_len=48):
    nz = np.abs(x).sum(1) > 0
    runs = []; i = 0; n = len(nz)
    while i < n:
        if not nz[i]:
            j = i
            while j < n and not nz[j]:
                j += 1
            if j - i >= min_len and i > 0 and j < n:
                runs.append((round(i / 48000, 3), j - i))
            i = j
        else:
            i += 1
    return runs

base = sys.argv[1]
meta = None
d = ana.load(base + ".a.wav")
m = d.mean(1)
nz = np.nonzero(np.abs(d).sum(1) > 0)[0]
end = nz[-1] / 48000 if len(nz) else 0
meta = json.loads(open(base + ".meta").read()) if False else None
fade = 2.5
t0 = end - fade
blk = 960  # 20 ms
e = ana.env_db(m, blk)
tb = (np.arange(len(e)) + 0.5) * blk / 48000
pre = e[(tb > t0 - 3.0) & (tb < t0)]
infade = (tb >= t0) & (tb < end - 0.25)  # the last 0.25 s is below the noise of the measure
p = (tb[infade] - t0) / fade
g = np.cos(p * np.pi / 2)
res = e[infade] - 20 * np.log10(np.maximum(g, 1e-6))
out = {"len_s": round(len(d) / 48000, 2), "end_s": round(end, 3), "pre": stats(pre), "fade": stats(res),
       "pre_db": round(float(np.median(pre)), 1), "fade_res_db": round(float(np.median(res)), 1),
       "zero_runs": zero_runs(d[: int(end * 48000)])}
print(json.dumps(out))
if "--plot" in sys.argv:
    for i in np.nonzero((tb > t0 - 1.0) & (tb < end + 0.1))[0]:
        rr = e[i] - (20 * np.log10(max(np.cos((tb[i] - t0) / fade * np.pi / 2), 1e-6)) if t0 <= tb[i] < end else 0)
        print(f"{tb[i]-t0:6.2f} raw {e[i]:6.1f} res {rr:6.1f} " + "#" * max(0, int((rr + 80) / 1.5)))
