#!/usr/bin/env python3
"""Cross-check two independent real-Wallpaper-Engine references against each other and against our render.

    python3 -I scene_we_crosscheck.py --first docs/player/reports/we-ref --wp docs/player/reports/we-ref-wallpiper \
        [--ours /tmp/liascape-scene-we-<stamp>] [--sbs-dir docs/player/reports/we-ref-wallpiper/sbs] [--json out.json]

--first: the first set (scripts/dev/we-ref-capture.sh: WE in a -playInWindow window, headless gamescope).
--wp:    the second (scripts/dev/we-ref-wallpiper.sh: WE as a desktop wallpaper, wallpiper + headless sway).
Both as <dir>/<id>/{manifest.json, t<T>s.jpg}. --ours: a scene_we_compare.sh results dir rendered against the
wallpiper captures (<ours>/scenes/<id>/lwe-smoke-<T>s.png at the wallpiper shots' t_actual).

Each pair is scored like scene_we_report.py (256 px wide; 0.30 ssim + 0.20 hist + 0.20 edges + 0.30 local) per
time; a scene's number is the mean over the times. Prints a markdown table (id, wp~first, ours~first, ours~wp,
mean |wp - first| 0-255) and writes 4-up side-by-sides (first | wallpiper | ours | |wp - first| x4) to --sbs-dir.
Workshop items by id only.
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import scene_preview_report as spr  # noqa: E402
import scene_we_report as swr  # noqa: E402


def shots(d, ext):
    out = {}
    if not os.path.isdir(d):
        return out
    for f in os.listdir(d):
        if f.startswith("t") and f.endswith("s" + ext):
            try:
                out[round(float(f[1 : -len(ext) - 1]), 1)] = os.path.join(d, f)
            except ValueError:
                pass
    return out


def score(a, b):
    if a.shape != b.shape:
        b = spr.resize(b, a.shape[1], a.shape[0])
    pa, pb = swr.fit_pair(a, b)
    return swr.measures(pa, pb)


def tile(img, w, h, label):
    t = Image.new("RGB", (w, h + 16), (30, 30, 30))
    if img is not None:
        t.paste(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS), (0, 16))
    ImageDraw.Draw(t).text((4, 2), label, fill=(255, 255, 0))
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", required=True)
    ap.add_argument("--wp", required=True)
    ap.add_argument("--ours", default=None)
    ap.add_argument("--ids", default="")
    ap.add_argument("--sbs-dir", default=None)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    ids = [x for x in a.ids.split(",") if x] or sorted(
        d for d in os.listdir(a.wp) if os.path.isfile(os.path.join(a.wp, d, "manifest.json")))
    rows = []
    for sid in ids:
        mw = swr.read_json(os.path.join(a.wp, sid, "manifest.json"), {})
        mf = swr.read_json(os.path.join(a.first, sid, "manifest.json"), {})
        fw, ff = shots(os.path.join(a.wp, sid), ".jpg"), shots(os.path.join(a.first, sid), ".jpg")
        od = os.path.join(a.ours, "scenes", sid) if a.ours else ""
        ours = swr.our_shots(od) if od and os.path.isdir(od) else {}
        actual = {round(float(x["t"]), 1): round(float(x.get("t_actual", x["t"])), 1) for x in mw.get("shots", [])}
        r = {"id": sid, "wp_crashed": bool(mw.get("we_crashed")), "wp_no_picture": bool(mw.get("no_picture")),
             "first_crashed": bool(mf.get("we_crashed")), "times": [], "wp_first": [], "ours_first": [],
             "ours_wp": [], "abs255": []}
        tiles = []
        for t in sorted(set(fw) & set(ff)):
            W, F = swr.load(fw[t]), swr.load(ff[t])
            O = swr.load(ours[actual.get(t, t)]) if actual.get(t, t) in ours else None
            m = score(F, W)
            r["times"].append(t)
            r["wp_first"].append(m["dist"])
            r["abs255"].append(m["mean_abs"] * 255)
            if O is not None:
                r["ours_first"].append(score(F, O)["dist"])
                r["ours_wp"].append(score(W, O)["dist"])
            if a.sbs_dir:
                h = 180
                w = round(h * F.shape[1] / F.shape[0])
                Wr = spr.resize(W, F.shape[1], F.shape[0]) if W.shape != F.shape else W
                D = np.clip(np.abs(Wr - F) * 4, 0, 1)
                parts = [tile(F, w, h, f"first set t={t:g}s"), tile(W, w, h, "wallpiper"),
                         tile(O, w, h, "ours"), tile(D, w, h, "|wp - first| x4")]
                row = Image.new("RGB", (4 * w + 12, h + 16), (30, 30, 30))
                for i, p in enumerate(parts):
                    row.paste(p, (i * (w + 4), 0))
                tiles.append(row)
        for k in ("wp_first", "ours_first", "ours_wp", "abs255"):
            r[k + "_mean"] = float(np.mean(r[k])) if r[k] else None
        rows.append(r)
        if a.sbs_dir and tiles:
            os.makedirs(a.sbs_dir, exist_ok=True)
            im = Image.new("RGB", (max(t.width for t in tiles), sum(t.height for t in tiles)), (30, 30, 30))
            y = 0
            for t in tiles:
                im.paste(t, (0, y))
                y += t.height
            if im.width > 1200:
                im = im.resize((1200, round(im.height * 1200 / im.width)), Image.LANCZOS)
            im.save(os.path.join(a.sbs_dir, f"{sid}.jpg"), quality=80, optimize=True)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(rows, f, indent=1)

    def f3(v):
        return "–" if v is None else f"{v:.3f}"

    print("| id | wp ~ first | ours ~ first | ours ~ wp | mean abs wp−first (0–255) | notes |")
    print("|---|---|---|---|---|---|")
    for r in rows:
        notes = []
        if r["wp_crashed"]:
            notes.append("wallpiper: WE crashed")
        if r["wp_no_picture"]:
            notes.append("wallpiper: no picture")
        if r["first_crashed"]:
            notes.append("first set: WE crashed")
        ab = "–" if r["abs255_mean"] is None else f"{r['abs255_mean']:.1f}"
        print(f"| {r['id']} | {f3(r['wp_first_mean'])} | {f3(r['ours_first_mean'])} | {f3(r['ours_wp_mean'])} | {ab} | {'; '.join(notes)} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
