#!/usr/bin/env python3
"""Time-to-first-data of the legacy auto-mute's `parec --monitor-stream=<id>` spawn
(AudioMonitor.MonitorStreamAsync), with and without --latency-msec=10, against a SYNTHETIC stream.

Usage: scripts/measure-automute-latency.py [trials]   (default 6; needs pactl, paplay, parec)

It touches no real stream: it loads a private module-null-sink (`liascape_lat_test`, unloaded at the end),
plays 60 s of digital SILENCE into it with paplay (inaudible, below every auto-mute threshold, and
named `mpv` so a running livepaper auto-mute ignores it), times parec's first byte / first 20 ms
chunk on that stream, then stops it. Measured 2026-10-25: default 2023 ms → 65 ms (first chunk 76 ms)."""
import os, subprocess, sys, time, signal, statistics, tempfile, math, struct, wave

TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 6
CHUNK = 160 * 4  # AudioMonitor's ChunkBytes (160 float32 samples @ 8 kHz = 20 ms)

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, timeout=20)

mod = sh("pactl", "load-module", "module-null-sink", "sink_name=liascape_lat_test",
         "sink_properties=device.description=liascape-latency-test").stdout.strip()
if not mod.isdigit():
    sys.exit(f"could not load a null sink: {mod!r}")
play = None
tmp = tempfile.mkdtemp(prefix="liascape-lat-")
try:
    wav = os.path.join(tmp, "sine.wav")
    with wave.open(wav, "wb") as w:  # 60 s of digital silence, mono 48 kHz — bounded; below any auto-mute threshold
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        frames = bytearray()
        for i in range(48000 * 60):
            frames += struct.pack("<h", 0)
        w.writeframes(bytes(frames))
    play = subprocess.Popen(["paplay", "--device=liascape_lat_test", "--property=application.name=mpv", "--property=media.name=liascape-latency-test", wav],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sid = None
    for _ in range(50):
        out = sh("pactl", "list", "sink-inputs").stdout
        cur = None
        for line in out.splitlines():
            if line.startswith("Sink Input #"):
                cur = line.split("#")[1].strip()
            if 'media.name = "liascape-latency-test"' in line:
                sid = cur
        if sid:
            break
        time.sleep(0.1)
    if not sid:
        sys.exit("test stream not found")
    print(f"test stream: sink-input #{sid} on the null sink liascape_lat_test")
    time.sleep(0.5)

    def first_data(extra):
        args = ["parec", f"--monitor-stream={sid}", "--format=float32le", "--channels=1", "--rate=8000", "--raw"] + extra
        t0 = time.monotonic()
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        got, first = 0, None
        while got < CHUNK:
            b = p.stdout.read1(CHUNK - got) if hasattr(p.stdout, "read1") else p.stdout.read(CHUNK - got)
            if not b:
                break
            if first is None:
                first = time.monotonic() - t0
            got += len(b)
        full = time.monotonic() - t0
        p.send_signal(signal.SIGTERM)
        try: p.wait(2)
        except subprocess.TimeoutExpired: p.kill()
        return first * 1000 if first else None, full * 1000

    res = {"default": [], "--latency-msec=10": []}
    for _ in range(TRIALS):
        for name, extra in (("default", []), ("--latency-msec=10", ["--latency-msec=10"])):
            res[name].append(first_data(extra))
            time.sleep(0.2)
    for name, rows in res.items():
        firsts = [r[0] for r in rows if r[0] is not None]
        fulls = [r[1] for r in rows]
        print(f"{name:20s} first byte median {statistics.median(firsts):7.1f} ms (min {min(firsts):.0f}, max {max(firsts):.0f}); "
              f"first 20 ms chunk median {statistics.median(fulls):7.1f} ms (n={len(rows)})")
finally:
    if play:
        play.terminate()
        try: play.wait(2)
        except subprocess.TimeoutExpired: play.kill()
    sh("pactl", "unload-module", mod)
    subprocess.run(["trash", tmp], capture_output=True)
