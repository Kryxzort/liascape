#!/usr/bin/env python3
"""Envelope of a recorded trial: 10 ms RMS dB (L+R mid), printed at 50 ms around the request.
ana.py <wav> <req_off_s> [from_s=-1] [to_s=5] [--band LO HI]  (band: FFT band-pass before RMS)"""
import sys, numpy as np

def load(wav):
    raw = open(wav, "rb").read()
    k = raw.find(b"data")
    d = np.frombuffer(raw[k + 8: k + 8 + ((len(raw) - k - 8) // 8) * 8], dtype=np.float32).reshape(-1, 2)
    return d

def env_db(x, blk=480):
    n = len(x) // blk
    r = np.sqrt((x[: n * blk].reshape(n, blk) ** 2).mean(axis=1))
    return 20 * np.log10(np.maximum(r, 1e-9))

def bandpass(x, lo, hi, sr=48000):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / sr)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))

if __name__ == "__main__":
    wav, off = sys.argv[1], float(sys.argv[2])
    a = [x for x in sys.argv[3:] if not x.startswith("--")]
    fr = float(a[0]) if len(a) > 0 else -1.0
    to = float(a[1]) if len(a) > 1 else 5.0
    d = load(wav)
    m = d.mean(axis=1)
    if "--band" in sys.argv:
        i = sys.argv.index("--band")
        m = bandpass(m, float(sys.argv[i + 1]), float(sys.argv[i + 2]))
    e = env_db(m)
    s0 = int((off + fr) * 100); s1 = int((off + to) * 100)
    seg = e[max(0, s0): s1]
    for j in range(0, len(seg), 5):
        t = fr + j / 100
        v = seg[j: j + 5].mean()
        print(f"{t:6.2f} {v:7.1f} " + "#" * max(0, int((v + 90) / 1.5)))
