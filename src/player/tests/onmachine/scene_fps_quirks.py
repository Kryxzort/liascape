#!/usr/bin/env python3
"""WE's frame-rate quirks, ours against real Wallpaper Engine at each fps: the cursor ripple of 3184155462.

    bash scripts/test-lock.sh python3 src/player/tests/onmachine/scene_fps_quirks.py --we DIR \
        [--fps 30,60,144] [--ours player|smoke] [--ours-fps N] [--bin DIR] [--out DIR]

WE's stock `cursorripple` adds, each frame, a force of min(1/30, g_Frametime) / 0.02 times that frame's pointer move
and takes off at least 1/255 a frame, so its water is ~10x weaker at 144 fps than at 30 — in WE, whose `fps` setting
is the rate it draws and steps at. Wallpaper authors tuned their scenes on that, so ours must follow the same rate
(`out:<c>.scene_fps`, the worker's `ToWorker::Rate`, the core's simulation clock).

The case: the water on, a 1 s drag from (200,1600) to (1600,1600) native px against the pointer parked at
(200,1600), both on WE's timeline. The ripple at a time is mean |drag − parked| (0–255) where the water moves: the
path's band left of the girl (y 700–900, x 0–640 of the 1920 × 1080 frame; the scene's collision mask keeps the
water off her, and her own sway differs between two runs). The parked run cancels the stroke the first frame draws
from the 0 0 last pointer to the pointer, whose water is still there when the drag starts. WE: the captures
    scripts/dev/we-ref-capture.sh 3184155462 --out DIR --docs - --fps F --repeat N \
        --times 0.9,1.2,1.5,1.8,2.1,2.4,2.7,3,3.5,4 --prop cameraparallax=false --prop watereffect=true \
        --tag fr-F-drag --pointer 200,1600:1600,1600 --pointer-time 1-2      (and --tag fr-F-park --pointer 200,1600)
(--we-tag sets the `fr` prefix); every drag run is paired with every parked run. The capture's times and drag run on
its request clock, which starts at WE's scene time `off` (the frames' median scene_time − t_actual). Ours, by --ours:
  player  (default) a PRIVATE headless player (scene_load.py's `Player`: own runtime, state and cache dirs, no audio,
          no display) shows the scene at `out:*.scene_fps` F on a 1920x1080 output at max(F, 60) Hz; the pointer
          arrives at the output's corner (a jump) and moves to (200,1600), the stroke WE's first frame draws; a client
          moves `headless.pointer` along the path at 250 Hz in real time (as a mouse would) and captures the source.
          The real tick, pointer and capture path; not deterministic.
  smoke   `liascape-scene-worker --lwe-smoke` at --fps F (what scene_we_compare.sh renders); its first frame strokes
          from 0 0 as WE's does. Deterministic.
--ours-fps N renders ours at N whatever F is (what the compare did before it followed a capture's fps: the RED case).

A pair's strength is its ripple's peak from the drag's start less its value before the drag. Each fps passes when ours
is within --tol (default 0.35) of WE's mean strength, or 1.0 when that is less (WE's water at 144 fps is ~0). Exit 0 =
every fps passed; 1 = one failed; 2 = it couldn't measure.
"""

import argparse
import itertools
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent.parent
sys.path.insert(0, str(HERE))
from scene_load import Player  # noqa: E402

SCENE_ID = "3184155462"
PATH = ((200.0, 1600.0), (1600.0, 1600.0))
CANVAS = (3840.0, 2160.0)
DRAG = (1.0, 2.0)  # seconds of the capture's request clock
TIMES = (0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0, 3.5, 4.0)
BAND = (slice(700, 900), slice(0, 640))
PROPS = {"cameraparallax": False, "watereffect": True}


def load(path):
    im = Image.open(path).convert("RGB")
    if im.size != (1920, 1080):
        im = im.resize((1920, 1080), Image.BOX)
    return np.asarray(im, dtype=np.float32)


def ripple(drag, park):
    """{t: mean |drag − park| in the band} over the times both runs have."""
    return {t: float(np.abs(load(drag[t])[BAND] - load(park[t])[BAND]).mean()) for t in sorted(drag) if t in park}


def strength(curve):
    """The ripple's peak from the drag's start on, less its value before the drag."""
    base = min((v for t, v in curve.items() if t < DRAG[0]), default=0.0)
    return max(0.0, max((v for t, v in curve.items() if t >= DRAG[0]), default=0.0) - base)


def we_runs(root):
    """[{nominal t: png}] per run under a capture tag (r1…rN, or one run), and the request clock's scene time."""
    runs, offs = [], []
    for d in sorted(root.glob("r*")) or [root]:
        man = d / "manifest.json"
        if not man.is_file():
            continue
        frames = {}
        for s in json.loads(man.read_text()).get("shots", []):
            png = d / f"t{s['t']:g}s.png"
            if png.is_file():
                frames[float(s["t"])] = png
            if s.get("scene_time") is not None:
                offs.append(s["scene_time"] - s.get("t_actual", s["t"]))
        if frames:
            runs.append(frames)
    return runs, float(np.median(offs)) if offs else 0.0


def ours_smoke(worker, assets, fps, drag, out, off):
    """The run through `--lwe-smoke` at `fps`, at WE's scene times (`off` later than the request clock)."""
    out.mkdir(parents=True, exist_ok=True)
    at = {t: round(t + off, 3) for t in TIMES}
    path = PATH if drag else (PATH[0], PATH[0])
    cmd = [str(worker), "--lwe-smoke", str(scene_dir()), "--assets", str(assets), "--out", str(out),
           "--fps", str(fps), "--seconds", "1", "--shots", ",".join(f"{s:g}" for s in at.values()),
           "--shot-width", "1920", "--pointer", ":".join(f"{x:g},{y:g}" for x, y in path),
           "--pointer-time", f"{DRAG[0] + off:.3f}-{DRAG[1] + off:.3f}"]
    for k, v in PROPS.items():
        cmd += ["--prop", f"{k}={json.dumps(v)}"]
    env = dict(os.environ, LIASCAPE_SCENE_STORAGE_DIR=str(out / "storage"),
               LIASCAPE_SCENE_SHADER_CACHE_DIR=str(out.parent / "shader-cache"))
    env.pop("LD_LIBRARY_PATH", None)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise SystemExit(f"smoke failed ({r.returncode}): {r.stdout[-400:]}{r.stderr[-800:]}")
    pngs = {}
    for p in out.glob("lwe-smoke-*s.png"):
        try:
            pngs[float(p.name[len("lwe-smoke-"):-len("s.png")])] = p
        except ValueError:
            pass
    if not pngs:
        raise SystemExit(f"smoke wrote no frames into {out}")
    return {t: pngs[min(pngs, key=lambda s: abs(s - a))] for t, a in at.items()}, None


def ours_player(player, fps, drag, out, off):
    """The run on the private player at `out:*.scene_fps` = fps, on WE's timeline (see the module doc)."""
    out.mkdir(parents=True, exist_ok=True)
    ctl = player.ctl
    ctl.call("set", {"path": "out:*.scene_fps", "value": fps})
    src = ctl.call("create", {"kind": "source", "props": {"kind": "scene", "path": str(scene_dir()),
                                                          "scene_props": PROPS}})["id"]
    ctl.call("set", {"path": "lay:*:main.content", "value": src})
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        w = [w for w in ctl.call("probe", {"name": "workers"}).get("workers", []) if w.get("id") == src]
        if w and w[0].get("ready"):
            break
        if w and (w[0].get("broken") or w[0].get("last_error")):
            raise SystemExit(f"the scene failed: {w[0]}")
        time.sleep(0.05)
    else:
        raise SystemExit("the scene never became ready")
    # the request clock (TIMES, DRAG) starts at scene time `off`; the scene clock starts about now
    t0 = time.monotonic() + off
    out_name = "VIRTUAL-1"  # `serve --headless --outputs` names its one output so
    sx, sy = 1920.0 / CANVAS[0], 1080.0 / CANVAS[1]  # the 16:9 canvas covers the 1920 x 1080 output

    def at(k):
        k = k if drag else 0.0
        x = PATH[0][0] + (PATH[1][0] - PATH[0][0]) * k
        y = PATH[0][1] + (PATH[1][1] - PATH[0][1]) * k
        return {"output": out_name, "x": x * sx, "y": y * sy}

    ctl.call("headless.pointer", {"output": out_name, "x": 0, "y": 0, "entered": True})
    time.sleep(3.0 / fps)  # a frame or two at the corner
    ctl.call("headless.pointer", at(0.0))
    shots = {}
    cli = type(ctl)(player.sock)  # a second connection for the captures, so the pointer never waits on one

    def capture_all():
        for t in TIMES:
            wait = t0 + t - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            png = out / f"t{t:g}s.png"
            cli.call("capture", {"target": src, "path": str(png)}, timeout=20.0)
            shots[t] = png

    th = threading.Thread(target=capture_all)
    th.start()
    moves = 0
    while True:
        now = time.monotonic() - t0
        if now >= DRAG[1] + 0.05:
            break
        k = min(1.0, max(0.0, (now - DRAG[0]) / (DRAG[1] - DRAG[0])))
        ctl.call("headless.pointer", at(k))
        moves += drag and 0.0 < k < 1.0
        time.sleep(0.004)
    th.join()
    for _ in range(100):  # captures are written off the loop: wait for the files
        if all(p.is_file() and p.stat().st_size > 0 for p in shots.values()):
            break
        time.sleep(0.05)
    workers = ctl.call("probe", {"name": "workers"}).get("workers", [])
    info = next((w for w in workers if w.get("id") == src), {})
    ctl.call("destroy", {"id": src})
    time.sleep(0.5)
    return shots, dict({k: info.get(k) for k in ("fps_target", "fps_actual", "rate_sent")}, moves=moves)


def scene_dir():
    return Path.home() / ".local/share/Steam/steamapps/workshop/content/431960" / SCENE_ID


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--we", required=True, type=Path, help="the captures' root (we-ref-capture.sh --out)")
    ap.add_argument("--we-tag", default="fr", help="tag prefix: <we>/<prefix>-<fps>-drag|park (default fr)")
    ap.add_argument("--fps", default="30,60,144")
    ap.add_argument("--ours", choices=("player", "smoke"), default="player")
    ap.add_argument("--ours-fps", type=float, default=None)
    ap.add_argument("--bin", type=Path, default=CRATE / "target/release")
    ap.add_argument("--assets", type=Path, default=None, help="WE's assets (smoke; default the player's own)")
    ap.add_argument("--tol", type=float, default=0.35)
    ap.add_argument("--out", type=Path, default=None, help="default a new /tmp/liascape-fps-quirks-* dir")
    a = ap.parse_args()
    fpss = [float(f) for f in a.fps.split(",")]
    out = a.out or Path(tempfile.mkdtemp(prefix="liascape-fps-quirks-"))
    assets = a.assets
    if assets is None and a.ours == "smoke":
        # the player's own resolution (Steam's libraries)
        check = subprocess.run([str(a.bin / "liascape-player"), "scene-check"], capture_output=True, text=True)
        assets = json.loads(check.stdout or "{}").get("assets_dir")
        if not assets:
            print(f"no WE assets dir (pass --assets): {check.stdout}{check.stderr}", file=sys.stderr)
            return 2
        assets = Path(assets)

    we, offs = {}, {}
    for f in fpss:
        drags, offs[f] = we_runs(a.we / f"{a.we_tag}-{f:g}-drag" / SCENE_ID)
        parks, _ = we_runs(a.we / f"{a.we_tag}-{f:g}-park" / SCENE_ID)
        if not drags or not parks:
            print(f"no WE captures for {f:g} fps under {a.we} ({a.we_tag}-{f:g}-drag|park)", file=sys.stderr)
            return 2
        we[f] = [strength(ripple(x, y)) for x, y in itertools.product(drags, parks)]

    player = None
    rows = []
    try:
        if a.ours == "player":
            player = Player(a.bin, out / "player", f"1920x1080@{max(fpss + [60.0]):g}")
        for f in fpss:
            fo = a.ours_fps or f
            runs = {}
            info = None
            for drag in (True, False):
                d = out / f"ours-{f:g}-{'drag' if drag else 'park'}"
                if a.ours == "smoke":
                    runs[drag], info = ours_smoke(a.bin / "liascape-scene-worker", assets, fo, drag, d, offs[f])
                else:
                    runs[drag], info = ours_player(player, fo, drag, d, offs[f])
            curve = ripple(runs[True], runs[False])
            rows.append((f, fo, strength(curve), curve, info))
    finally:
        if player:
            player.quit()

    fails = 0
    print(f"{'fps':>5} {'ours@':>6} {'ours':>6} {'WE':>6} {'WE pairs':>12}  verdict  ours' curve (t: |drag-park|)")
    for f, fo, s, curve, info in rows:
        w = float(np.mean(we[f]))
        ok = abs(s - w) <= max(a.tol * w, 1.0)
        fails += not ok
        print(f"{f:5g} {fo:6g} {s:6.2f} {w:6.2f} {min(we[f]):5.2f}-{max(we[f]):<6.2f}  {'pass' if ok else 'FAIL':7}  "
              + " ".join(f"{t:g}:{v:.2f}" for t, v in curve.items()) + (f"  {info}" if info else ""))
    print(f"results: {out}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
