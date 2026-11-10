#!/usr/bin/env python3
"""Record the private sink AND scene A's own stream while A transitions to B (rig.sh's instance).
record.py <tag> <trials.json>   trials: [{"a": scene dir, "b": path | "scene:dir", "fx": id, "method": m,
                                      "dur": ms, "speed": A speed, "name": label,
                                      "stall": [ms stopped, ms between, times] (SIGSTOPs the compositor)}, ...]
Writes out/<tag>-<name>.{bus,a}.wav + .meter.json, and out/<tag>.jsonl."""
import json, os, subprocess, sys, time, signal
S = os.path.dirname(os.path.abspath(__file__))
RIG = os.path.join(S, "rig.sh")
OUT = os.environ.get("TA_OUT") or os.path.join(os.getcwd(), "out"); os.makedirs(OUT, exist_ok=True)

def ctl(*a, timeout=20):
    r = subprocess.run([RIG, "ctl", *a], capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"raw": r.stdout + r.stderr}

def to_json(spec):
    if spec.startswith("scene:"):
        return {"kind": "scene", "path": spec[6:]}
    return {"path": spec, "loop": True}

def wait_done(corr, limit=90):
    t0 = time.time()
    while time.time() - t0 < limit:
        ev = ctl("logs", json.dumps({"corr": corr, "limit": 400}))
        kinds = [e["kind"] for e in ev.get("events", [])]
        if any(k in kinds for k in ("transition.done", "transition.failed", "transition.cancelled")):
            return ev["events"]
        time.sleep(0.2)
    return None

def wait_audio(limit=90):
    t0 = time.time()
    while time.time() - t0 < limit:
        w = ctl("probe", '{"name":"workers"}').get("workers", [])
        live = [x for x in w if (x.get("audio") or {}).get("flows", 0) > 0 and (x.get("audio") or {}).get("gain_db", -96) > -1]
        if live:
            return live[0]["id"]
        time.sleep(0.3)
    return None

def rec(target, wav, sink=False):
    a = [RIG, "pw", "pw-record", "--target", target, "--rate", "48000", "--channels", "2", "--format", "f32"]
    if sink:
        a += ["-P", "{ stream.capture.sink = true }"]
    return subprocess.Popen(a + [wav], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def main():
    tag = sys.argv[1]
    trials = json.load(open(sys.argv[2]))
    log = open(os.path.join(OUT, tag + ".jsonl"), "a")
    for t in trials:
        name = t["name"]
        # show A (cut) at its speed, wait until its sound flows at full gain
        r = ctl("transition", json.dumps({"outputs": "out:*", "to": {"kind": "scene", "path": t["a"]}}))
        wait_done(r.get("corr"))
        aid = wait_audio()
        if aid is None:
            print(name, "A never flowed", flush=True); continue
        if t.get("speed", 1.0) != 1.0:
            ctl("set", json.dumps({"path": f"{aid}.speed", "value": t["speed"]}))
        time.sleep(2.0)
        base = os.path.join(OUT, f"{tag}-{name}")
        rb = rec("hermetic-sink", base + ".bus.wav", sink=True)
        ra = rec(f"liascape-player-scene.{aid}", base + ".a.wav")
        time.sleep(3.0)
        now_ms = ctl("probe", '{"name":"bus"}').get("now_ms")
        r = ctl("transition", json.dumps({"outputs": "out:*", "to": to_json(t["b"]), "effect_id": t["fx"],
                                          "duration_ms": t.get("dur", 2500), "method": t["method"]}))
        if t.get("stall"):
            # the owner's compositor stalls (13-34 s worker.host_stalled gaps around scene loads), in small: stop the
            # compositor (never the supervisor) for stall[0] ms every stall[1] ms, stall[2] times
            import threading
            cp = ctl("hello").get("pid")
            def stall(cp=cp, s=t["stall"]):
                time.sleep(0.6)
                for _ in range(s[2]):
                    os.kill(cp, signal.SIGSTOP); time.sleep(s[0] / 1000); os.kill(cp, signal.SIGCONT); time.sleep(s[1] / 1000)
            threading.Thread(target=stall, daemon=True).start()
        evs = wait_done(r.get("corr")) or []
        time.sleep(2.0)
        for p in (rb, ra):
            try:
                os.killpg(p.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            p.wait()
        end_ms = ctl("probe", '{"name":"bus"}').get("now_ms")
        mw = ctl("probe", json.dumps({"name": "meter.window", "args": {"from_ms": now_ms - 3000, "to_ms": end_ms}}), timeout=30)
        json.dump(mw.get("samples", []), open(base + ".meter.json", "w"))
        dbg = ctl("logs", json.dumps({"limit": 20000, "min_level": "debug"}), timeout=30)
        evw = [e for e in dbg.get("events", []) if now_ms - 3000 <= (e.get("t_mono_ms") or 0) <= end_ms and e.get("kind") != "source.position"]
        json.dump(evw, open(base + ".events.json", "w"))
        ks = {}
        for e in evs:
            ks.setdefault(e["kind"], e.get("t_mono_ms"))
        out = dict(t, a_id=aid, req_ms=now_ms, end_ms=end_ms, corr=r.get("corr"), events=ks)
        log.write(json.dumps(out) + "\n"); log.flush()
        print(name, json.dumps(ks)[:300], flush=True)

main()
