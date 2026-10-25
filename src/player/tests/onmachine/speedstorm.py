#!/usr/bin/env python3
"""Speed storm: hammer playback speed on the LIVE session (PlayerEngine=lp-player) the way the UI
does — per-item drag (/preview ~11/s + /library/speed persist), the global slider (/settings), and a
raw flood (/preview 50/s) — while /next forces a transition every few seconds, so many speed
changes land mid-transition. Records every player event, loop/frame health and the bus meter, then
restores everything it changed (global speed, per-item overrides, user mute, bus playback mute).

The owner hears nothing: the bus playback stream (lp-player-bus.playback) is muted for the run and
the wallpaper's user mute is lifted so the meter sees real audio.

Usage: python3 speedstorm.py <out-dir> [--phases control:60,drag:180,global:180,flood:120] [--next-every S]
  control = no speed changes (baseline); hold@X = /preview speed X once, then hold; jit@X = /preview
  alternating X-0.05 / X+0.05 every 90 ms (same mean speed as hold@X, 11 changes/s) — hold vs jit
  separates "a faster wallpaper costs more" from "changing the speed costs frames".
  alt@A/B = alternate A and B every 400 ms (alt@0.9/1.0 vs alt@0.9/1.1: does landing on exactly 1×
  — mpv removing/re-inserting scaletempo2 — cut the audio?).
  --next-every 0 = no /next (align:end switches then run under the storm instead of being cancelled).
Never prints /settings (it holds SteamRefreshToken); writes it nowhere either.
"""
import json, os, random, socket, subprocess, sys, threading, time, urllib.request

U = "http://127.0.0.1:5174"
SOCK = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "livepaper", "lp-player.sock")
args = sys.argv[1:]
OUT = args[0]
def opt(name, default):
    return args[args.index(name) + 1] if name in args else default
PHASES = [(n, float(d)) for n, d in (x.split(":") for x in opt("--phases", "drag:180,global:180,flood:120").split(","))]
NEXT_EVERY = float(opt("--next-every", 8))
os.makedirs(OUT, exist_ok=True)
T0 = time.monotonic()
def now(): return round(time.monotonic() - T0, 3)

def http(method, path, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(U + path, data=data, method=method, headers={"Content-Type": "application/json"})
    t = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), time.monotonic() - t
    except urllib.error.HTTPError as e:
        return e.code, e.read(), time.monotonic() - t
    except Exception as e:  # noqa: BLE001 — record, never crash the storm
        return -1, str(e).encode(), time.monotonic() - t

def ctl(cmd, a=None, timeout=5):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout); s.connect(SOCK)
    s.sendall((json.dumps({"id": 1, "cmd": cmd, "args": a or {}}) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(1 << 20)
        if not chunk: break
        buf += chunk
    s.close()
    for line in buf.splitlines():
        m = json.loads(line)
        if m.get("id") == 1: return m.get("result") if m.get("ok") else {"error": m.get("error")}
    return None

def sink_inputs():
    out = subprocess.run(["pactl", "-f", "json", "list", "sink-inputs"], capture_output=True, text=True).stdout
    try: return json.loads(out)
    except Exception: return []  # noqa: BLE001

def bus_playback(): return [si for si in sink_inputs() if si.get("properties", {}).get("node.name") == "lp-player-bus.playback"]

def mute_bus(v):
    for si in bus_playback():
        subprocess.run(["pactl", "set-sink-input-mute", str(si["index"]), "1" if v else "0"])

def settings(): return json.loads(http("GET", "/settings")[1])

stop = threading.Event()
log = open(os.path.join(OUT, "requests.jsonl"), "w")
log_lock = threading.Lock()
def rec(**kw):
    kw["t"] = now()
    with log_lock: log.write(json.dumps(kw) + "\n")

# ---------------------------------------------------------------- preflight + originals
eng = json.loads(http("GET", "/player-engine")[1])
assert eng.get("active") == "lp-player", f"engine is {eng.get('active')}, not lp-player"
cur = json.loads(http("GET", "/current")[1])
assert cur.get("path"), "nothing playing"
st = json.loads(http("GET", "/playlist/state")[1]) or {}
items = st.get("videoPaths") or [cur["path"]]
lib = json.loads(http("GET", "/library")[1])
orig_over = {i["videoPath"]: i.get("speedOverride") for i in lib if i["videoPath"] in items}
orig_speed = settings().get("speed", 1.0)
orig_user_muted = os.path.exists(os.path.expanduser("~/.config/livepaper/user_mute.state"))
json.dump({"items": items, "orig_over": orig_over, "orig_speed": orig_speed, "orig_user_muted": orig_user_muted},
          open(os.path.join(OUT, "originals.json"), "w"), indent=1)
print(f"[storm] {len(items)} playlist items, global speed {orig_speed}, user muted {orig_user_muted}", flush=True)

# ---------------------------------------------------------------- event capture
def subscriber():
    s = socket.socket(socket.AF_UNIX); s.connect(SOCK); s.settimeout(1)
    topics = ["transition.", "source.rejected", "source.error", "source.ended", "source.retire", "onset.", "runtime.",
              "anim.dropped", "compose.", "loop.", "audio.bus", "output.", "supervisor.", "player."]
    s.sendall((json.dumps({"id": 1, "cmd": "subscribe", "args": {"topics": topics}}) + "\n").encode())
    f = open(os.path.join(OUT, "events.jsonl"), "w"); buf = b""
    while not stop.is_set():
        try: chunk = s.recv(1 << 20)
        except socket.timeout: continue
        except OSError: break
        if not chunk: break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            try: m = json.loads(line)
            except Exception: continue  # noqa: BLE001
            if "event" in m: m["_t"] = now(); f.write(json.dumps(m) + "\n"); f.flush()
    f.close()

# ---------------------------------------------------------------- health sampler
def sampler():
    f = open(os.path.join(OUT, "samples.jsonl"), "w"); last_meter = time.monotonic()
    while not stop.is_set():
        if any(not si.get("mute") for si in bus_playback()):
            mute_bus(True)  # a re-created bus stream must stay silent for the owner
        try:
            lp = ctl("probe", {"name": "loop", "args": {"reset": True}}) or {}
            fr = ctl("probe", {"name": "frames"}) or {}
            srcs = ctl("probe", {"name": "sources"}) or {}
        except OSError as e:
            f.write(json.dumps({"t": now(), "ctl_error": str(e)}) + "\n"); stop.wait(1.0); continue
        row = {"t": now(), "max_busy_ms": lp.get("max_busy_ms"), "max_open_ms": lp.get("max_open_ms"),
               "frames": [{"name": o["name"], "missed": o.get("totals", {}).get("missed"),
                           "presents": o.get("totals", {}).get("presents")} for o in fr.get("outputs", [])],
               "sources": [{"id": x.get("id"), "speed": x.get("speed"), "inflight": x.get("requests_in_flight"),
                            "ready": x.get("ready")} for x in srcs.get("sources", [])]}
        if time.monotonic() - last_meter >= 20:
            try:
                m = ctl("probe", {"name": "meter.window", "args": {"last_ms": 21000}}, timeout=10) or {}
                row["meter"] = m.get("samples")
            except OSError:
                pass
            last_meter = time.monotonic()
        f.write(json.dumps(row) + "\n"); f.flush()
        stop.wait(1.0)
    f.close()

# ---------------------------------------------------------------- drivers
def nexter():
    while not stop.wait(NEXT_EVERY):
        c, _, dt = http("POST", "/next"); rec(route="/next", code=c, ms=round(dt * 1000, 1))

def phase_drag(dur):
    end = time.monotonic() + dur; last_persist = 0
    while time.monotonic() < end and not stop.is_set():
        sp = round(random.uniform(0.25, 4.0), 2)
        c, _, dt = http("POST", "/preview", {"speed": sp}); rec(route="/preview", code=c, ms=round(dt * 1000, 1), speed=sp)
        if time.monotonic() - last_persist > 1.2:
            p = (json.loads(http("GET", "/current")[1]) or {}).get("path")
            if p in orig_over:  # only items we recorded (and will restore)
                c, _, dt = http("POST", "/library/speed", {"path": p, "doubleValue": sp})
                rec(route="/library/speed", code=c, ms=round(dt * 1000, 1), speed=sp)
            last_persist = time.monotonic()
        time.sleep(0.09)

def phase_global(dur):
    for p in orig_over:  # an override wins over the global — clear them for this phase
        http("POST", "/library/speed", {"path": p, "doubleValue": None})
    end = time.monotonic() + dur
    while time.monotonic() < end and not stop.is_set():
        sp = round(random.uniform(0.25, 4.0), 2)
        s = settings(); s["speed"] = sp
        c, _, dt = http("POST", "/settings", s); rec(route="/settings", code=c, ms=round(dt * 1000, 1), speed=sp)
        time.sleep(0.3)

def phase_control(dur):
    stop.wait(dur)

def phase_hold(dur, x):
    c, _, dt = http("POST", "/preview", {"speed": x}); rec(route="/preview-hold", code=c, ms=round(dt * 1000, 1), speed=x)
    stop.wait(dur)

def phase_jit(dur, x):
    end = time.monotonic() + dur; i = 0
    while time.monotonic() < end and not stop.is_set():
        sp = round(x + (0.05 if i % 2 else -0.05), 2); i += 1
        c, _, dt = http("POST", "/preview", {"speed": sp}); rec(route="/preview-jit", code=c, ms=round(dt * 1000, 1), speed=sp)
        time.sleep(0.09)

def phase_alt(dur, a, b):
    end = time.monotonic() + dur; i = 0
    while time.monotonic() < end and not stop.is_set():
        sp = b if i % 2 else a; i += 1
        c, _, dt = http("POST", "/preview", {"speed": sp}); rec(route="/preview-alt", code=c, ms=round(dt * 1000, 1), speed=sp)
        time.sleep(0.4)

def phase_flood(dur):
    end = time.monotonic() + dur
    while time.monotonic() < end and not stop.is_set():
        sp = round(random.uniform(0.25, 4.0), 2)
        c, _, dt = http("POST", "/preview", {"speed": sp}, timeout=5)
        rec(route="/preview-flood", code=c, ms=round(dt * 1000, 1), speed=sp)
        time.sleep(0.02)

def restore():
    s = settings(); s["speed"] = orig_speed; http("POST", "/settings", s)
    for p, v in orig_over.items():
        http("POST", "/library/speed", {"path": p, "doubleValue": v})
    http("POST", "/mute", {"user": True, "value": orig_user_muted})
    time.sleep(1.0)

threads = [threading.Thread(target=subscriber, daemon=True), threading.Thread(target=sampler, daemon=True)]
for t in threads: t.start()
time.sleep(1.0)
mute_bus(True)
http("POST", "/mute", {"user": True, "value": False})
phases = []
try:
    if NEXT_EVERY > 0:
        nx = threading.Thread(target=nexter, daemon=True); nx.start()
    fns = {"control": phase_control, "drag": phase_drag, "global": phase_global, "flood": phase_flood}
    for name, dur in PHASES:
        base, _, arg = name.partition("@")
        if base == "alt":
            lo, hi = (float(x) for x in arg.split("/"))
            fn = lambda d, lo=lo, hi=hi: phase_alt(d, lo, hi)
        else:
            fn = (lambda d, b=base, a=float(arg): {"hold": phase_hold, "jit": phase_jit}[b](d, a)) if arg else fns[name]
        phases.append({"name": name, "start": now()}); print(f"[storm] phase {name} {dur:.0f}s", flush=True)
        fn(dur); phases[-1]["end"] = now()
    phases.append({"name": "settle", "start": now()}); time.sleep(10); phases[-1]["end"] = now()
finally:
    restore()
    time.sleep(3)
    final = ctl("state") or {}
    srcs = {k: {"speed": v.get("speed"), "path": v.get("path")} for k, v in (final.get("graph") or {}).items()
            if isinstance(v, dict) and v.get("gain_effective_db") is not None}
    json.dump({"phases": phases, "final_sources": srcs}, open(os.path.join(OUT, "run.json"), "w"), indent=1)
    stop.set(); time.sleep(1.5)
    mute_bus(False)
    log.close()
    print("[storm] done; restored global speed, item overrides, user mute, bus playback", flush=True)
