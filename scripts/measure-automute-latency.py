#!/usr/bin/env python3
"""Auto-mute latency and delay accuracy, both engines in ONE hermetic harness (Phase 3 Task 14,
parity criteria 3 + 4).

Usage:
  scripts/measure-automute-latency.py [--engine signal|audiomonitor|both] [--scenario onset|new]
      [--delays 0,500,2000] [--trials 30] [--quantum FRAMES] [--out results.json]
  scripts/measure-automute-latency.py --parec-first-data [trials]   (the 2026-10-25 measurement)

The default mode runs `src/player/tests/automute.rs::measure_automute_latency` (cargo, ignored test)
once per engine. Each run starts a PRIVATE PipeWire + WirePlumber (+ pipewire-pulse for the legacy
engine) — the owner's audio is never touched — with two null sinks: the player's bus forwards its
wallpaper (a -20 dBFS tone) to `hermetic-sink`; every foreign test stream (a synthetic 1 kHz
-20 dBFS tone, `pw-cat`) plays to `foreign-sink`. An in-test observer captures both sinks'
monitors on one PipeWire connection (same graph cycles, `pw_buffer.time`), in 1 ms peak blocks:
  mute   = first audible foreign sample (> -70 dBFS)  ->  the wallpaper silent (< -100 dBFS: the
           tone at -96 dB gain) for good;
  unmute = last audible foreign sample                ->  the wallpaper audible again.
Overhead = that time - the configured delay (mute delay = unmute delay = each of --delays).
Engines: `signal` = the in-player Signal (LIASCAPE_PLAYER_AUTOMUTE=1); `audiomonitor` = a faithful
port of the backend's AudioMonitor.cs (pactl subscribe + list classification, one `parec
--monitor-stream --latency-msec=10` per sink-input in 20 ms chunks, a 20 ms poll loop, then the
adapter's `animate <id>.gain.mute` over 30 ms through the player's socket).
Scenarios: `onset` = an existing stream starts sounding (400 ms of silence first: every capture is
linked by then); `new` = a new stream audible from its first sample (a notification).

--parec-first-data: the old measurement (time to parec's first data on a synthetic stream). It
loads a null sink into the CURRENT pulse server — run it only inside a private session."""
import argparse, json, os, statistics, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAYER = os.path.join(ROOT, "src", "player")


def run_engine(engine, a):
    env = dict(os.environ)
    env.pop("LD_LIBRARY_PATH", None)
    env.update({
        "LIASCAPE_AUTOMUTE_ENGINE": engine,
        "LIASCAPE_AUTOMUTE_TRIALS": str(a.trials),
        "LIASCAPE_AUTOMUTE_DELAYS": a.delays,
        "LIASCAPE_AUTOMUTE_SCENARIO": a.scenario,
    })
    if a.quantum:
        env["LIASCAPE_AUTOMUTE_QUANTUM"] = str(a.quantum)
    cmd = ["nix", "develop", "-c", "cargo", "test", "-q", "--test", "automute", "--",
           "measure_automute_latency", "--ignored", "--nocapture", "--test-threads=1"]
    p = subprocess.run(cmd, cwd=PLAYER, env=env, capture_output=True, text=True)
    out = []
    for line in p.stdout.splitlines():
        if line.startswith("MEASURE "):
            out.append(json.loads(line[len("MEASURE "):]))
    if p.returncode != 0 or not out:
        sys.stderr.write(p.stdout[-4000:] + p.stderr[-4000:])
        sys.exit(f"{engine}: the measurement failed (exit {p.returncode})")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="both")
    ap.add_argument("--scenario", default="onset", choices=["onset", "new"])
    ap.add_argument("--delays", default="0,500,2000")
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--quantum", type=int)
    ap.add_argument("--out")
    ap.add_argument("--parec-first-data", nargs="?", const=6, type=int)
    a = ap.parse_args()
    if a.parec_first_data:
        return parec_first_data(a.parec_first_data)
    engines = ["signal", "audiomonitor"] if a.engine == "both" else [a.engine]
    results = []
    for e in engines:
        results += run_engine(e, a)
    print(f"scenario {a.scenario}, quantum {a.quantum or 'graph default'}, {a.trials} trials per row")
    print(f"{'engine':13s} {'delay':>6s} | {'mute p50':>9s} {'p95':>7s} {'ovh p50':>8s} {'ovh p95':>8s} | "
          f"{'unmute p50':>10s} {'p95':>7s} {'ovh p50':>8s} {'ovh p95':>8s} | n  quantum")
    for r in results:
        print(f"{r['engine']:13s} {r['delay_ms']:6d} | {r['mute_p50']:9.1f} {r['mute_p95']:7.1f} "
              f"{r['mute_overhead_p50']:8.1f} {r['mute_overhead_p95']:8.1f} | {r['unmute_p50']:10.1f} "
              f"{r['unmute_p95']:7.1f} {r['unmute_overhead_p50']:8.1f} {r['unmute_overhead_p95']:8.1f} | "
              f"{r['mute_n']}/{r['unmute_n']} {r['quantum_frames_seen']}")
    if a.out:
        with open(a.out, "w") as f:
            json.dump(results, f, indent=1)


def parec_first_data(trials):
    import signal, struct, tempfile, time, wave
    chunk = 160 * 4  # AudioMonitor's ChunkBytes (160 float32 samples @ 8 kHz = 20 ms)

    def sh(*args):
        return subprocess.run(args, capture_output=True, text=True, timeout=20)

    mod = sh("pactl", "load-module", "module-null-sink", "sink_name=liascape_lat_test",
             "sink_properties=device.description=liascape-latency-test").stdout.strip()
    if not mod.isdigit():
        sys.exit(f"could not load a null sink: {mod!r}")
    play = None
    tmp = tempfile.mkdtemp(prefix="liascape-lat-")
    try:
        wav = os.path.join(tmp, "silence.wav")
        with wave.open(wav, "wb") as w:  # 60 s of digital silence, below every threshold
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
            w.writeframes(struct.pack("<h", 0) * (48000 * 60))
        play = subprocess.Popen(["paplay", "--device=liascape_lat_test", "--property=media.name=liascape-latency-test", wav],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sid = None
        for _ in range(50):
            cur = None
            for line in sh("pactl", "list", "sink-inputs").stdout.splitlines():
                if line.startswith("Sink Input #"):
                    cur = line.split("#")[1].strip()
                if 'media.name = "liascape-latency-test"' in line:
                    sid = cur
            if sid:
                break
            time.sleep(0.1)
        if not sid:
            sys.exit("test stream not found")
        time.sleep(0.5)
        res = {"default": [], "--latency-msec=10": []}
        for _ in range(trials):
            for name, extra in (("default", []), ("--latency-msec=10", ["--latency-msec=10"])):
                args = ["parec", f"--monitor-stream={sid}", "--format=float32le", "--channels=1", "--rate=8000", "--raw"] + extra
                t0 = time.monotonic()
                p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                got, first = 0, None
                while got < chunk:
                    b = p.stdout.read1(chunk - got)
                    if not b:
                        break
                    if first is None:
                        first = time.monotonic() - t0
                    got += len(b)
                full = time.monotonic() - t0
                p.send_signal(signal.SIGTERM)
                try: p.wait(2)
                except subprocess.TimeoutExpired: p.kill()
                res[name].append((first * 1000 if first else None, full * 1000))
                time.sleep(0.2)
        for name, rows in res.items():
            firsts = [r[0] for r in rows if r[0] is not None]
            print(f"{name:20s} first byte median {statistics.median(firsts):7.1f} ms; "
                  f"first 20 ms chunk median {statistics.median([r[1] for r in rows]):7.1f} ms (n={len(rows)})")
    finally:
        if play:
            play.terminate()
            try: play.wait(2)
            except subprocess.TimeoutExpired: play.kill()
        sh("pactl", "unload-module", mod)
        subprocess.run(["trash", tmp], capture_output=True)


if __name__ == "__main__":
    main()
