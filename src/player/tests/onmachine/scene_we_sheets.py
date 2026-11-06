#!/usr/bin/env python3
"""Side-by-side JPEGs (WE under Proton | ours) for checking by eye against WE on Windows.

    python3 -I scene_we_sheets.py --results /tmp/liascape-scene-we-<stamp> [--refs ~/.cache/liascape/we-ref/captures]
        [--out docs/player/reports/we-ref/compare] [--ids ID,ID…] [--worst N] [--times 2,5]

For each id (the listed ones, then the N most different valid scenes of <results>/scene-we-ref.json), at each time:
<out>/<id>_t<T>s_left-WE-proton_right-liascape.jpg — WE's frame on the left, ours on the right (both at the
capture window's size, <= 960 px wide each), a caption bar naming the scene, the time and the sides. Writes
<out>/index.md: one line per scene with what to look at (the notes file's note, else what the scores say).
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True


def read_json(p, d=None):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return d


def what_to_look_at(r):
    if r.get("note"):
        return r["note"]
    if r.get("dist") is None:
        return "no pair scored"
    parts = []
    k = max(("ssim", "hist", "edges"), key=lambda m: r.get(m, 0))
    parts.append({"ssim": "structure (a layer missing, moved or animated differently)",
                  "hist": "colour / brightness (tint, bloom, exposure)",
                  "edges": "outlines (layer placement, text, sharpness)"}[k])
    p = max(r["pairs"], key=lambda p: p["dist"])
    i, j = p.get("worst_cell", [0, 0])
    v = ["top", "upper middle", "lower middle", "bottom"][i]
    h = ["left", "centre-left", "centre-right", "right"][j]
    parts.append(f"worst at {v} {h}, t = {p['t']:g} s")
    return "; ".join(parts) + " (not looked at yet)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--refs", default=os.path.expanduser("~/.cache/liascape/we-ref/captures"))
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "..", "..", "docs/player/reports/we-ref/compare"))
    ap.add_argument("--ids", default="")
    ap.add_argument("--worst", type=int, default=20)
    ap.add_argument("--times", default="2,5")
    a = ap.parse_args()
    rep = read_json(os.path.join(a.results, "scene-we-ref.json"), {})
    by_id = {r["id"]: r for r in rep.get("scenes", [])}
    ids = [x for x in a.ids.split(",") if x]
    ranked = sorted([r for r in rep.get("scenes", []) if r.get("dist") is not None and not r.get("invalid")],
                    key=lambda r: -r["dist"])
    for r in ranked[: a.worst]:
        if r["id"] not in ids:
            ids.append(r["id"])
    times = [float(t) for t in a.times.split(",")]
    os.makedirs(a.out, exist_ok=True)
    lines = []
    for sid in ids:
        r = by_id.get(sid, {"id": sid})
        man = read_json(os.path.join(a.refs, sid, "manifest.json"), {})
        actual = {round(float(x["t"]), 1): round(float(x.get("t_actual", x["t"])), 1) for x in man.get("shots", [])}
        files = []
        for t in times:
            we = os.path.join(a.refs, sid, f"t{t:g}s.png")
            ours = os.path.join(a.results, "scenes", sid, f"lwe-smoke-{actual.get(round(t, 1), t):g}s.png")
            if not (os.path.exists(we) and os.path.exists(ours)):
                continue
            A = Image.open(we).convert("RGB")
            B = Image.open(ours).convert("RGB")
            w = min(960, A.width)
            h = round(A.height * w / A.width)
            A = A.resize((w, h), Image.LANCZOS)
            B = B.resize((w, h), Image.LANCZOS)
            cap = 22
            im = Image.new("RGB", (2 * w + 6, h + cap), (24, 24, 24))
            d = ImageDraw.Draw(im)
            d.text((6, 5), f"{sid}  t={t:g}s   LEFT: Wallpaper Engine {man.get('we', '')} (Proton)", fill=(255, 220, 0))
            d.text((w + 12, 5), "RIGHT: Liascape (--lwe-smoke)", fill=(0, 230, 255))
            im.paste(A, (0, cap))
            im.paste(B, (w + 6, cap))
            name = f"{sid}_t{t:g}s_left-WE-proton_right-liascape.jpg"
            im.save(os.path.join(a.out, name), quality=82, optimize=True)
            files.append(name)
        if not files:
            continue
        score = f"{r['dist']:.3f}" if r.get("dist") is not None else "—"
        flag = f" **{r['invalid']}** —" if r.get("invalid") else ""
        links = ", ".join(f"[{f.split('_')[1]}]({f})" for f in files)
        lines.append(f"- **{sid}** (score {score}; {links}):{flag} {what_to_look_at(r)}")
    with open(os.path.join(a.out, "index.md"), "w") as f:
        f.write("# Liascape vs Wallpaper Engine — side-by-sides to check by eye\n\n")
        f.write("Each JPEG: **left = real Wallpaper Engine** (2.8.485 under Proton, Ultra, MSAA x8, 30 fps, "
                "pointer at the centre, default properties), **right = Liascape** (`liascape-scene-worker "
                "--lwe-smoke`, the same scene time). Scene time = seconds after WE's first frame (+-0.15 s). "
                "Compare the left against WE on Windows too: Proton's WE can differ (see "
                "`docs/player/spikes/we-proton.md`). Generated by `src/player/tests/onmachine/scene_we_sheets.py`; "
                "the ranking is `docs/player/reports/scene-we-ref.md`.\n\n")
        f.write("\n".join(lines) + "\n")
    print(f"scene_we_sheets: {len(lines)} scenes → {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
