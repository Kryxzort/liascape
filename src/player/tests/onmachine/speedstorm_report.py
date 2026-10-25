#!/usr/bin/env python3
"""Summarise a speedstorm.py run: transition outcomes, refused/failed events, loop stalls, missed
frames, HTTP errors/latency, bus-meter holes, and whether the final speeds match what was restored.
Usage: python3 speedstorm_report.py <out-dir>"""
import json, os, statistics, sys
from collections import Counter, defaultdict

D = sys.argv[1]
def rows(name):
    p = os.path.join(D, name)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []
ev, req, smp = rows("events.jsonl"), rows("requests.jsonl"), rows("samples.jsonl")
run = json.load(open(os.path.join(D, "run.json")))
orig = json.load(open(os.path.join(D, "originals.json")))
phases = run["phases"]
def phase_of(t):
    for p in phases:
        if p["start"] <= t <= p.get("end", 1e9): return p["name"]
    return "pre"

# --- transitions
tr = defaultdict(dict)
for e in ev:
    if e["event"].startswith("transition.") and e.get("corr"):
        tr[e["corr"]].setdefault(e["event"].split(".", 1)[1], e)
outcome = Counter()
stuck, failed = [], []
for c, k in tr.items():
    if "scheduled" not in k: continue
    if "failed" in k: outcome["failed"] += 1; failed.append((c, k["failed"].get("reason")))
    elif "done" in k: outcome["done"] += 1
    elif "cancelled" in k: outcome["cancelled:" + str(k["cancelled"].get("reason"))] += 1
    elif "handoff" in k: outcome["handoff-not-done"] += 1; stuck.append(c)
    else: outcome["no-terminal"] += 1; stuck.append(c)
ran = [k for k in tr.values() if "scheduled" in k and "started" in k and "handoff" in k]
overrun = []
for k in ran:
    d = k["scheduled"].get("duration_ms") or 0
    got = k["handoff"]["at_ms"] - k["started"]["start_ms"]
    if not k["handoff"].get("committed") and d and abs(got - d) > 50: overrun.append((k["scheduled"]["corr"], d, round(got)))
committed = sum(1 for k in ran if k["handoff"].get("committed"))

# --- other events
kinds = Counter(e["event"] for e in ev if not e["event"].startswith("transition."))
warn = [e for e in ev if e.get("level") in ("warn", "error")]
warn_kinds = Counter(e["event"] for e in warn)
rej = Counter((e.get("prop"), (e.get("reason") or "")[:90]) for e in ev if e["event"] == "source.rejected")

# --- loop + frames per phase, split into seconds with an effect running ("fx") and plain playback
fx_spans, st = [], {}
for e in ev:
    if e["event"] == "transition.started": st[e["corr"]] = e["_t"]
    if e["event"] == "transition.handoff" and e["corr"] in st: fx_spans.append((st[e["corr"]], e["_t"]))
def in_fx(t0, t1): return any(a < t1 and b > t0 for a, b in fx_spans)
busy = defaultdict(list); missed = defaultdict(lambda: defaultdict(int)); prev = {}
split = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [0, 0, 0])))  # phase -> fx|play -> output -> [s, missed, presents]
prev_t = None
for s in smp:
    if s.get("max_busy_ms") is None: continue
    ph = phase_of(s["t"]); busy[ph].append(s["max_busy_ms"])
    state = "fx" if prev_t is not None and in_fx(prev_t, s["t"]) else "play"
    for o in s.get("frames", []):
        m, pr = o.get("missed") or 0, o.get("presents") or 0
        if o["name"] in prev and s["t"] - prev_t < 1.6:
            dm, dp = max(0, m - prev[o["name"]][0]), max(0, pr - prev[o["name"]][1])
            missed[ph][o["name"]] += dm
            c = split[ph][state][o["name"]]; c[0] += 1; c[1] += dm; c[2] += dp
        prev[o["name"]] = (m, pr)
    prev_t = s["t"]
def pct(v, q): return round(sorted(v)[min(len(v) - 1, int(q * len(v)))], 1) if v else None

# --- http
http = defaultdict(list); bad_http = Counter()
for r in req:
    http[r["route"]].append(r["ms"])
    if r["code"] != 200: bad_http[(r["route"], r["code"])] += 1

# --- meter holes: >= 3 ms below -60 dB with > -40 dB median on both sides (10 ms)
holes = []
for s in smp:
    m = s.get("meter")
    if not m: continue
    db = [x[1] for x in m]; ts = [x[0] for x in m]; i = 0
    while i < len(db):
        if db[i] < -60:
            j = i
            while j < len(db) and db[j] < -60: j += 1
            if j - i >= 3 and i >= 10 and j + 10 <= len(db):
                if statistics.median(db[i - 10:i]) > -40 and statistics.median(db[j:j + 10]) > -40:
                    holes.append({"t_mono_ms": round(ts[i]), "len_ms": j - i})
            i = j
        else: i += 1
meter_db = [x[1] for s in smp for x in (s.get("meter") or [])]

# --- final speeds
want = {p: (v if v is not None else orig["orig_speed"]) for p, v in orig["orig_over"].items()}
final = [(v["path"].rsplit("/", 1)[-1], v["speed"], want.get(v["path"])) for v in run["final_sources"].values()]
wrong_final = [f for f in final if f[2] is not None and abs((f[1] or 0) - f[2]) > 1e-6]

rep = {
    "phases": {p["name"]: round(p.get("end", 0) - p["start"], 1) for p in phases},
    "requests": {k: {"n": len(v), "p50_ms": pct(v, .5), "p95_ms": pct(v, .95), "max_ms": round(max(v), 1)} for k, v in http.items()},
    "http_errors": {f"{a} {b}": n for (a, b), n in bad_http.items()},
    "transitions": dict(outcome), "committed_by_next": committed, "full_length_mismatch": overrun[:10],
    "failed": failed[:10], "stuck": stuck[:10],
    "warn_events": dict(warn_kinds), "rejected": {f"{a}: {b}": n for (a, b), n in rej.items()},
    "other_events": dict(kinds),
    "loop_busy_ms": {ph: {"p50": pct(v, .5), "p95": pct(v, .95), "max": round(max(v), 1), "n>50": sum(x > 50 for x in v)} for ph, v in busy.items()},
    "missed_frames": {ph: dict(v) for ph, v in missed.items()},
    "per_s": {ph: {k: {o: {"secs": c[0], "missed": round(c[1] / c[0], 2), "presents": round(c[2] / c[0], 1)} for o, c in d.items()} for k, d in v.items()} for ph, v in split.items()},
    "meter": {"samples": len(meter_db), "audible_share": round(sum(d > -50 for d in meter_db) / max(1, len(meter_db)), 3), "holes": len(holes), "hole_examples": holes[:8]},
    "final_speeds": final, "final_speed_mismatch": wrong_final,
}
json.dump(rep, open(os.path.join(D, "report.json"), "w"), indent=1)
print(json.dumps(rep, indent=1))
