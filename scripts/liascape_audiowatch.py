#!/usr/bin/env python3
"""liascape-audiowatch — continuous sink-monitor capture, correlated with liascape-transition handoff events.

The legacy-engine monitor (2026-10-20): the reference-based half of this (`refcheck`,
below) is what `liascape-player`'s native `probe dropout` (Task 15, `src/player/src/probe/
dropout.rs`) ports — see `docs/player/debugging.md` for the bugs it originally found
(cubic volume sag, a speed-step micro-gap, ready-timeout silence, paused-after-kill
silence) and the native tool's own usage. This script stays as the external monitor for
the **legacy** engine (mpvpaper + `liascape-transition`), which has no in-process probe of its
own; `ffmpeg` is resolved from `PATH` (never a hard-coded store path), so it runs
unmodified on any machine with `ffmpeg` installed.

Per transition it maps the renderer's [+ms] timeline onto wall clock (anchor: the backend's
"overlay covered" line ≈ the instant mpvpaper-A gets loadfile-B; ready-file poll = 8ms), then runs a
baseline-relative dropout detector at 1ms resolution around the three handoff instants:
  E0   effect clock start (overlay-A goes audible)          — gate OPEN (aligned) or GO
  ACUT mpvpaper-A switched to B (A's own audio stops)       — backend "overlay covered"
  TD   teardown (mpvpaper-B unpaused, overlay muted)
A CONTROL window of equal length far from any handoff runs through the same detector so a dip can
be told apart from quiet passages in the music.
"""
import array, collections, datetime, json, math, operator, os, re, shutil, subprocess, sys, threading, time

SR, MS = 48000, 48
LOG = os.path.expanduser('~/.cache/livepaper/liascape-transition.log')
DEV = sys.argv[1] if len(sys.argv) > 1 else 'easyeffects_sink.monitor'
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else '/tmp'
os.makedirs(OUTDIR, exist_ok=True)

env = collections.deque(maxlen=240_000)      # (wall_t, dBFS) per 1ms — 4 minutes
lock = threading.Lock()

def say(*a):
    print(*a, flush=True)

# ---- capture: sample-count timebase, anchored to the MIN arrival offset (immune to GIL stalls) ----
def capture():
    p = subprocess.Popen(['parec', '--device=' + DEV, '--format=float32le', '--channels=1',
                          '--rate=%d' % SR, '--raw', '--latency-msec=10'], stdout=subprocess.PIPE)
    total = 0; offs = collections.deque()   # (arrival, offset) for the anchor window
    rem = b''
    while True:
        chunk = p.stdout.read1(MS * 4 * 20) if hasattr(p.stdout, 'read1') else p.stdout.read(MS * 80)
        if not chunk:
            say('CAPTURE: parec ended'); return
        tnow = time.time()
        rem += chunk
        n = len(rem) // (MS * 4)
        if not n: continue
        a = array.array('f'); a.frombytes(rem[:n * MS * 4]); rem = rem[n * MS * 4:]
        total += n * MS
        offs.append((tnow, tnow - total / SR))
        while offs and tnow - offs[0][0] > 5.0: offs.popleft()
        anchor = min(o for _, o in offs)
        base = total - n * MS
        out = []
        for k in range(n):
            seg = a[k * MS:(k + 1) * MS]
            r = math.sqrt(sum(map(operator.mul, seg, seg)) / MS)
            out.append((anchor + (base + (k + 1) * MS) / SR, 20 * math.log10(r) if r > 1e-9 else -180.0))
        with lock: env.extend(out)

# ---- detector ----------------------------------------------------------------------------------
def window(t0, t1):
    with lock: return [(t, d) for t, d in env if t0 <= t <= t1]

def pw(ds):
    return 10 * math.log10(sum(10 ** (d / 10) for d in ds) / len(ds)) if ds else float('nan')

def detect(w):
    """dips: runs where the 5ms power envelope is >15 dB under the local (±250ms median) baseline,
    or the raw 1ms envelope is under -60 dBFS. Returns (dips, env5)."""
    if len(w) < 600: return [], []
    ts = [t for t, _ in w]; ds = [d for _, d in w]
    e5 = [pw(ds[max(0, i - 2):i + 3]) for i in range(len(ds))]
    base = []
    for i in range(0, len(e5), 50):
        seg = sorted(e5[max(0, i - 250):i + 250]); base.append(seg[len(seg) // 2])
    dips = []; i = 0
    while i < len(e5):
        b = base[min(i // 50, len(base) - 1)]
        if e5[i] < b - 15 or ds[i] < -60:
            j = i; mn = e5[i]; sil = 0
            while j < len(e5) and (e5[j] < base[min(j // 50, len(base) - 1)] - 15 or ds[j] < -60):
                mn = min(mn, e5[j]); sil += ds[j] < -60; j += 1
            if j - i >= 3:
                dips.append(dict(t=ts[i], ms=j - i, depth=b - mn, floor=mn, silent_ms=sil))
            i = j
        else:
            i += 1
    return dips, e5

# ---- log tail → transition records ---------------------------------------------------------------
RB = re.compile(r'^\[backend (\d\d):(\d\d):(\d\d)\.(\d{3})\] (.*)')
RR = re.compile(r'^\[\+\s*(\d+)ms\] (.*)')
def bwall(m):
    d = datetime.datetime.now().replace(hour=int(m[1]), minute=int(m[2]), second=int(m[3]),
                                         microsecond=int(m[4]) * 1000)
    return d.timestamp()

stats = []
def analyse(tr, n):
    try:
        if 'covered' not in tr or 'ready' not in tr:
            say('#%d %s → %s: no cover/ready (%s) — skipped' % (n, tr.get('from'), tr.get('to'), tr.get('note', '?'))); return
        t0 = tr['covered'] - tr['ready'] / 1000.0 - 0.004          # renderer proc start, wall
        E0 = t0 + tr.get('gate', tr.get('go', 0)) / 1000.0
        ACUT = tr['covered']
        TD = t0 + tr['td'] / 1000.0
        c0, c1 = TD + 8.0, TD + 8.0 + (TD + 3.5 - E0)               # equal-length control, far from handoffs
        time.sleep(max(0.0, c1 + 0.3 - time.time()))
        w = window(E0 - 1.5, TD + 2.0)
        dips, _ = detect(w)
        ctrl = window(c0, c1)
        cdips, _ = detect(ctrl)
        lv = lambda a, b: pw([d for t, d in w if a <= t < b])
        def near(t):
            ev = min((('E0', E0), ('ACUT', ACUT), ('TD', TD)), key=lambda e: abs(t - e[1]))
            return '%s%+.0fms' % (ev[0], (t - ev[1]) * 1000)
        hand = [d for d in dips if min(abs(d['t'] - E0), abs(d['t'] - ACUT), abs(d['t'] - TD)) < 0.4]
        rec = dict(n=n, effect=tr.get('effect'), mode=tr.get('mode'), e0_acut_ms=(ACUT - E0) * 1000,
                   pre=lv(E0 - 0.5, E0), e0_acut=lv(E0, ACUT) if ACUT > E0 + 0.003 else None,
                   post=lv(ACUT + 0.02, ACUT + 0.5), td_pre=lv(TD - 0.4, TD), td_post=lv(TD, TD + 0.4),
                   dips=[dict(d, at=near(d['t'])) for d in dips], hand=len(hand), control=len(cdips))
        stats.append(rec)
        json.dump(dict(rec, env=[(t - E0, d) for t, d in w]), open(os.path.join(OUTDIR, 'tr%02d.json' % n), 'w'))
        say('#%d %s  %s→%s  [%s]  E0→ACUT %+.0fms' % (n, tr.get('effect'), tr.get('from', '?')[:14],
             tr.get('to', '?')[:14], tr.get('mode'), rec['e0_acut_ms']))
        say('   level dB: pre %.1f | E0..ACUT %s | post-ACUT %.1f | TD %.1f→%.1f' % (
            rec['pre'], ('%.1f' % rec['e0_acut']) if rec['e0_acut'] is not None else '—',
            rec['post'], rec['td_pre'], rec['td_post']))
        for d in dips:
            say('   DIP %-11s %4dms  depth %4.1fdB  floor %6.1fdB%s' % (near(d['t']), d['ms'], d['depth'],
                 d['floor'], '  SILENT %dms' % d['silent_ms'] if d['silent_ms'] else ''))
        try:
            for ln in refcheck(tr, w, E0, ACUT, TD): say(ln)
        except Exception as ex:
            say('   ref: error %r' % ex)
        say('   verdict: %s   (control window: %d dip%s)' % (
            ('baseline dips near handoff ×%d' % len(hand)) if hand else 'no baseline dips near handoff', len(cdips), '' if len(cdips) == 1 else 's'))
        if len(stats) % 3 == 0:
            h = sum(1 for s in stats if s['hand'])
            say('== %d transitions: %d with handoff dropouts, %d control dips total' % (
                len(stats), h, sum(s['control'] for s in stats)))
    except Exception as ex:
        say('#%d analyse error: %r' % (n, ex))

FF = shutil.which('ffmpeg') or 'ffmpeg'  # resolved from PATH — never a hard-coded store path
def resolve(base):
    try:
        st = json.load(open(os.path.expanduser('~/.config/livepaper/playlist_state.json')))
        for p in st.get('VideoPaths', []):
            if os.path.basename(p) == base: return p
    except Exception: pass
    return None

def decode_env(path, start, dur):
    """10ms power envelope (linear) of `path` from `start` for `dur` s; pads silence past EOF/before 0."""
    pad = max(0.0, -start); start = max(0.0, start)
    r = subprocess.run([FF, '-v', 'error', '-ss', '%.3f' % start, '-t', '%.3f' % dur, '-i', path, '-vn',
                        '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True)
    a = array.array('f'); a.frombytes(r.stdout[:len(r.stdout) // 4 * 4])
    out = [0.0] * int(round(pad * 100))
    for i in range(0, len(a) - 479, 480):
        seg = a[i:i + 480]; out.append(sum(map(operator.mul, seg, seg)) / 480)
    need = int(dur * 100) + len([0] * int(round(pad * 100)))
    return (out + [0.0] * need)[:need]

def refcheck(tr, w, E0, ACUT, TD):
    """Reference-based dropout check: expected mix from the SOURCE files at the logged positions vs
    what actually reached the sink. Flags only where the sources say audio should be playing."""
    A, B = resolve(tr.get('from', '')), resolve(tr.get('to', ''))
    if not A or not B or 'posA0' not in tr or 'posB0' not in tr:
        return ['   ref: skipped (paths/positions unknown)']
    pre, post = 1.5, (TD - E0) + 2.0
    eA = decode_env(A, tr['posA0'] - pre, pre + post)          # A from 1.5s before E0 (mpvpaper-A, then overlay-A)
    eB = decode_env(B, tr['posB0'], post)                       # B from E0 on (overlay-B, then mpvpaper-B)
    dur = TD - E0; ac = ACUT - E0
    exp = []
    for k in range(len(eA)):
        t = k / 100.0 - pre
        pa = eA[k]; pb = eB[k - int(pre * 100)] if t >= 0 and 0 <= k - int(pre * 100) < len(eB) else 0.0
        if t < 0: v = pa
        elif t >= dur: v = pb
        else:
            x = t / dur; c2, s2 = math.cos(x * math.pi / 2) ** 2, math.sin(x * math.pi / 2) ** 2
            v = pa * c2 + pb * s2 + (pa if t < ac else 0.0)       # E0..ACUT: mpvpaper-A still playing too
        exp.append(10 * math.log10(v) if v > 1e-14 else -140.0)
    # captured → 10ms bins relative to E0
    cap = {}
    for t, d in w:
        cap.setdefault(int(math.floor((t - E0 + pre) * 100)), []).append(d)
    capb = [pw(cap[k]) if k in cap else None for k in range(len(exp))]
    # latency: lag (10ms steps, 0..+250ms) maximising agreement on audible bins
    best = None
    for lag in range(0, 26):
        pairs = [(capb[k + lag], exp[k]) for k in range(len(exp) - lag)
                 if capb[k + lag] is not None and exp[k] > -60 and capb[k + lag] > -90]
        if len(pairs) < 50: continue
        off = sorted(c - e for c, e in pairs)[len(pairs) // 2]
        err = sum(abs(c - e - off) for c, e in pairs) / len(pairs)
        if best is None or err < best[0]: best = (err, lag, off)
    if not best: return ['   ref: not enough audible overlap']
    err, lag, off = best
    flags = []; k = 0
    while k < len(exp) - lag:
        c = capb[k + lag]
        if c is not None and exp[k] + off > -55 and c < exp[k] + off - 15:
            j = k; worst = 0.0
            while j < len(exp) - lag and capb[j + lag] is not None and exp[j] + off > -55 and capb[j + lag] < exp[j] + off - 15:
                worst = max(worst, exp[j] + off - capb[j + lag]); j += 1
            t = k / 100.0 - pre
            ev = min((('E0', 0.0), ('ACUT', ac), ('TD', dur)), key=lambda e: abs(t - e[1]))
            flags.append('   REF-DROP %s%+.0fms  %dms  %.0f dB under expected' % (ev[0], (t - ev[1]) * 1000, (j - k) * 10, worst))
            k = j
        else: k += 1
    # micro-gaps: 1ms captured bins vs the 10ms expected level — a run ≥2ms that sits ≥35 dB under what
    # the sources say should be playing (a 1ms window of real music never falls that far below its 10ms
    # level; a dropout to digital silence does). This is the "flicker" scale the 10ms pass blurs away.
    gaps = []; run = []
    for t, d in w:
        k = int(math.floor((t - E0 + pre) * 100)) - lag
        e = exp[k] + off if 0 <= k < len(exp) else None
        if e is not None and e > -45 and d < e - 35: run.append((t, d, e))
        else:
            if len(run) >= 2: gaps.append(run)
            run = []
    for g in gaps:
        t = g[0][0] - E0 - lag / 100.0
        ev = min((('E0', 0.0), ('ACUT', ac), ('TD', dur)), key=lambda e: abs(t - e[1]))
        flags.append('   MICRO-GAP %s%+.0fms  %dms  floor %.0fdB vs expected %.0fdB' % (
            ev[0], (t - ev[1]) * 1000, len(g), min(x[1] for x in g), max(x[2] for x in g)))
    head = '   ref: latency %dms  fit ±%.1fdB  offset %+.1fdB  → %s' % (
        lag * 10, err, off, ('%d real dropout/gap%s' % (len(flags), '' if len(flags) == 1 else 's')) if flags else 'NO real dropouts (dips = content)')
    return [head] + flags

def tail():
    f = open(LOG); f.seek(0, 2)
    tr = None; n = 0
    while True:
        line = f.readline()
        if not line: time.sleep(0.03); continue
        m = RB.match(line)
        if m:
            msg = m[5]
            if msg.startswith('START '):
                n += 1
                tr = dict(start=bwall(m), mode='?')
                for k, v in re.findall(r'(\w+)=(\S+)', msg):
                    if k in ('effect', 'method'): tr[k] = v
                tr['from'] = (re.search(r'from=(.*?) to=', msg) or [None, '?'])[1]
                tr['to'] = (re.search(r' to=(.*)$', msg) or [None, '?'])[1].strip()
            elif msg.startswith('overlay covered') and tr is not None:
                tr['covered'] = bwall(m)
            elif 'SKIPPED' in msg:
                say('!! %s  %s' % (m[0][9:21], msg[:150]))
            continue
        m = RR.match(line)
        if m and tr is not None:
            ms, msg = int(m[1]), m[2].strip()
            if msg.startswith('GO (all decoders'): tr['go'] = ms
            elif msg.startswith('A-END gate OPEN'): tr['gate'] = ms; tr['mode'] = 'aligned'
            elif msg.startswith('A-END gate:'):
                tr['gate'] = ms; tr['mode'] = 'late-fire' if 'late fire' in msg else 'unaligned'
            elif msg.startswith('ready-file signaled'): tr['ready'] = ms
            elif msg.startswith('A: pos=') and 'posA0' not in tr: tr['posA0'] = float(msg[7:].split()[0])
            elif msg.startswith('B: pos=') and 'posB0' not in tr: tr['posB0'] = float(msg[7:].split()[0])
            elif msg.lstrip().startswith('t+0.00s progress') and 'stat0' not in tr: tr['stat0'] = ms
            elif msg.startswith('teardown:'): tr['td'] = ms
            elif msg.startswith('DONE:'):
                if tr.get('mode') == '?': tr['mode'] = 'manual'
                threading.Thread(target=analyse, args=(tr, n), daemon=True).start(); tr = None

threading.Thread(target=capture, daemon=True).start()
time.sleep(1.0)
say('liascape-audiowatch armed: device=%s log=%s out=%s' % (DEV, LOG, OUTDIR))
tail()
