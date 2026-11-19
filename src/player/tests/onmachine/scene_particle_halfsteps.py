#!/usr/bin/env python3
"""WE's particle half steps at 1 to 20 fps, ours against real Wallpaper Engine: a fountain's sag.

    python3 -I src/player/tests/onmachine/scene_particle_halfsteps.py variant ~/.cache/liascape/we-ref/probe-scenes/fountain-3516106265
    python3 -I src/player/tests/onmachine/scene_particle_halfsteps.py sag DIR|PNG…

WE 2.8.797 runs a particle system's operators twice a frame on half steps when its fps setting is 1 to 20 (the default
15), once above (docs/player/spikes/we-lwe-gap-audit.md § "Particle half steps at 1 to 20 fps (P37)"). WE's particles
are unseeded, so a library scene's frames can't show it; this fountain can. `variant` writes a private copy of
3516106265 (never into the Workshop folder: under ~/.cache/liascape/we-ref/probe-scenes, where we-ref-capture.sh takes
a project path) with only its shooting-star system, made a fixed fountain: one particle per 1/15 s from one point at
900, 1400 px/s under gravity 1200 px/s², no drag, its background at alpha 0.3 on a black clear colour (the capture
waits for a frame with a picture). Every particle follows one parabola; semi-implicit Euler leaves a dot of age t
600 · t · h canvas px below it for a step h. `sag` fits that residual = k · t + c over every dot of each frame:
k −40 for whole 1/15 s steps, −20 for half ones or whole 1/30 s ones. WE and ours:
    scripts/dev/we-ref-capture.sh <variant dir> --fps F --times 3,4,5,6 --docs - --tag fountainF-rN
    liascape-scene-worker --lwe-smoke <variant dir> --assets <WE assets> --out DIR --fps F --shots 3,4,5,6 \\
        --shot-width 1920 --seconds 6
Exit 0 = every frame had dots and a fit; 2 = a frame had none (WE emits nothing from a boxrandom emitter that names
`directions` / `speedmin` / `speedmax` / `distancemin`, so the variant leaves them out).
"""

import json
import os
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ in the tree
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "scripts" / "dev"))

ITEM = Path.home() / ".local/share/Steam/steamapps/workshop/content/431960/3516106265"
SYSTEM = "particles/workshop/2562725207/Shooting_Star_01.json"
X0, Y0, VX, VY, G = 600.0, 400.0, 900.0, 1400.0, 1200.0
THRESHOLD = 120  # above the background at alpha 0.3, below the dots


def variant(out):
    import we_ref_tool as T  # noqa: E402  (scripts/dev)

    out = Path(out).expanduser()
    if "workshop/content" in str(out.resolve()):
        sys.exit("scene_particle_halfsteps: never write into the Workshop folder")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ITEM, out)
    version, files = T.read_pkg(str(out / "scene.pkg"))
    d = dict(files)
    scene = json.loads(d["scene.json"].decode("utf-8-sig"))
    scene["general"]["clearcolor"] = "0.00000 0.00000 0.00000"
    scene["general"]["bloom"] = False
    for o in scene["objects"]:
        if o.get("id") == 122:  # the shooting stars
            o.update(angles="0.00000 0.00000 0.00000", scale="1.00000 1.00000 1.00000",
                     origin=f"{X0:.5f} {Y0:.5f} 0.00000", instanceoverride={"id": 124}, visible=True)
        elif o.get("id") == 16:  # the background
            o["alpha"] = 0.3
        elif o.get("id") is not None and any(k in o for k in ("image", "particle", "text", "sound")):
            o["visible"] = False
    d[SYSTEM] = json.dumps({
        "emitter": [{"id": 6, "name": "boxrandom", "origin": "0 0 0", "distancemax": "0 0 0", "rate": 15}],
        "initializer": [{"id": 2, "name": "lifetimerandom", "min": 2.6, "max": 2.6},
                        {"id": 3, "name": "sizerandom", "min": 24, "max": 24},
                        {"id": 4, "name": "velocityrandom", "min": f"{VX:g} {VY:g} 0", "max": f"{VX:g} {VY:g} 0"},
                        {"id": 5, "name": "colorrandom", "min": "255 255 255", "max": "255 255 255"}],
        "material": "materials/workshop/2562725207/particle/halo_1_1.json",
        "maxcount": 100,
        "operator": [{"id": 7, "name": "movement", "gravity": f"0 {-G:g} 0", "drag": 0}],
        "renderer": [{"id": 1, "name": "sprite"}],
        "starttime": 0,
    }).encode()
    d["scene.json"] = json.dumps(scene, ensure_ascii=False, indent="\t").encode()
    T.write_pkg(str(out / "scene.pkg"), version, [(n, d[n]) for n, _ in files])
    print(out)


def dots(png):
    """The dots' centroids in canvas px (3840 × 2160, y up)."""
    im = cv2.imread(str(png), cv2.IMREAD_GRAYSCALE).astype(np.float32)
    s = 3840.0 / im.shape[1]
    n, lab, stats, _ = cv2.connectedComponentsWithStats((im > THRESHOLD).astype(np.uint8), connectivity=8)
    out = []
    for i in range(1, n):
        x0, y0, w, h, area = stats[i]
        if area < 2:
            continue
        sub = im[y0:y0 + h, x0:x0 + w] * (lab[y0:y0 + h, x0:x0 + w] == i)
        yy, xx = np.mgrid[y0:y0 + h, x0:x0 + w]
        out.append((((xx * sub).sum() / sub.sum() + 0.5) * s, 2160.0 - ((yy * sub).sum() / sub.sum() + 0.5) * s))
    return out


def sag(png):
    """(dots, k, c): residual below the parabola = k · t + c, t a dot's age from its x."""
    pts = [(x, y) for x, y in dots(png) if x > X0 + 30]
    if len(pts) < 5:
        return len(pts), None, None
    t = np.array([(x - X0) / VX for x, _ in pts])
    res = np.array([y for _, y in pts]) - (Y0 + VY * t - 0.5 * G * t * t)
    keep = np.abs(res - np.median(res)) < 150
    k, c = np.linalg.lstsq(np.vstack([t[keep], np.ones(keep.sum())]).T, res[keep], rcond=None)[0]
    return int(keep.sum()), float(k), float(c)


def main(argv):
    if len(argv) >= 2 and argv[0] == "variant":
        variant(argv[1])
        return 0
    if len(argv) >= 2 and argv[0] == "sag":
        pngs = []
        for a in argv[1:]:
            p = Path(a).expanduser()
            pngs += sorted(p.rglob("*.png")) if p.is_dir() else [p]
        rc, ks = 0, []
        for p in pngs:
            n, k, c = sag(p)
            if k is None:
                print(json.dumps({"file": str(p), "dots": n, "error": "no dots"}))
                rc = 2
                continue
            ks.append(k)
            print(json.dumps({"file": str(p), "dots": n, "k": round(k, 2), "c": round(c, 2)}))
        if ks:
            print(json.dumps({"frames": len(ks), "k_mean": round(float(np.mean(ks)), 2),
                              "k_min": round(min(ks), 2), "k_max": round(max(ks), 2)}))
        return rc
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
