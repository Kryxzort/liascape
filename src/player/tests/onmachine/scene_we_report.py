#!/usr/bin/env python3
"""Score our render against real Wallpaper Engine's at the same scene times; write scene-we-ref.{md,json}.

    python3 -I scene_we_report.py --results /tmp/liascape-scene-we-<stamp> --refs ~/.cache/liascape/we-ref/captures
        [--report-dir docs/player/reports] [--sbs-dir docs/player/reports/we-ref/sbs] [--notes scene_we_notes.json]

Reads <refs>/<id>/{manifest.json, t<T>s.png} (scripts/dev/we-ref-capture.sh: WE 2.8.485 under Proton in a
headless gamescope, the window at the canvas's aspect, so a WE frame shows exactly the canvas our worker renders)
and <results>/scenes/<id>/lwe-smoke-<T>s.png (scene_we_compare.sh: our worker at the same times, props, pointer).

Unlike the preview compare there is nothing to align: both frames are the whole canvas at the same scene time.
Each (WE, ours) pair at the same T is resized to 256 px wide and scored with the preview compare's measures
(scene_preview_report.py: ssim / hist / edges / local, the same weights), the local grid 4 x 4 over the frame.
A scene's score is the mean over its times (the worst time is listed too). Two things keep it a ranking, not a
verdict: WE's clock is the first non-black frame (+-80 ms, an animation that moves fast differs by that much), and
WE's particles / random choices are not seeded like ours (WPENGINE_PARTICLE_SEED=7).

Side-by-sides (WE | ours | |difference| x4, one row per time) go to <results>/sbs/<id>.png and, as small JPEGs,
to --sbs-dir; a contact sheet of the worst 20 to <results>/contact-worst20.png. Workshop items by id only.
"""

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
sys.dont_write_bytecode = True  # no __pycache__ in the tree
sys.path.insert(0, HERE)
import scene_preview_report as spr  # noqa: E402  (the measures, the weights)

W = 256  # scoring width
N = 4  # local grid


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load(path):
    im = Image.open(path).convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


def fit_pair(a, b):
    h = max(8, round(W * a.shape[0] / a.shape[1]))
    h -= h % N
    return spr.resize(a, W, h), spr.resize(b, W, h)


def measures(a, b):
    """spr.measures for a W x h pair (its cells are SIDE-square only)."""
    ga = cv2.GaussianBlur(spr.grey(a), (3, 3), 0.8)
    gb = cv2.GaussianBlur(spr.grey(b), (3, 3), 0.8)
    sm = spr.ssim_map(ga, gb)
    H, Wd = sm.shape
    cells = []
    for i in range(N):
        for j in range(N):
            sl = (slice(i * H // N, (i + 1) * H // N), slice(j * Wd // N, (j + 1) * Wd // N))
            col = float(np.abs(a[sl].mean(axis=(0, 1)) - b[sl].mean(axis=(0, 1))).mean()) * 2
            cells.append((min(1.0, max(0.0, 1 - float(sm[sl].mean())) + col), i, j))
    cells.sort(reverse=True)
    m = {
        "ssim": float(np.clip(1 - sm.mean(), 0, 1)),
        "hist": spr.hist_dist(a, b),
        "edges": spr.edge_dist(ga, gb),
        "local": float(np.mean([c[0] for c in cells[:3]])),
        "worst_cell": [cells[0][1], cells[0][2]],
        "mean_abs": float(np.abs(a - b).mean()),
    }
    m["dist"] = float(sum(spr.WEIGHTS[k] * m[k] for k in spr.WEIGHTS))
    return m


def our_shots(d):
    out = {}
    for t, p in spr.shot_times(d):
        out[round(t, 1)] = p
    return out


def ref_shots(d):
    out = {}
    for f in os.listdir(d):
        if f.startswith("t") and f.endswith("s.png") and os.path.getsize(os.path.join(d, f)) > 0:
            try:
                out[round(float(f[1:-5]), 1)] = os.path.join(d, f)
            except ValueError:
                pass
    return out


def sbs(rows, h=200):
    """rows: [(T, we, ours)] -> one image: WE | ours | |diff| x4, one row per time."""
    tiles = []
    for t, a, b in rows:
        w = round(h * a.shape[1] / a.shape[0])
        A = Image.fromarray((a * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)
        bb = spr.resize(b, a.shape[1], a.shape[0]) if b.shape != a.shape else b
        B = Image.fromarray((bb * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)
        D = Image.fromarray((np.clip(np.abs(a - bb) * 4, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)
        row = Image.new("RGB", (3 * w + 8, h + 16), (30, 30, 30))
        d = ImageDraw.Draw(row)
        d.text((4, 2), f"WE  t={t:g}s", fill=(255, 255, 0))
        d.text((w + 8, 2), "ours", fill=(255, 255, 0))
        d.text((2 * w + 12, 2), "|diff| x4", fill=(255, 255, 0))
        row.paste(A, (0, 16))
        row.paste(B, (w + 4, 16))
        row.paste(D, (2 * w + 8, 16))
        tiles.append(row)
    out = Image.new("RGB", (max(t.width for t in tiles), sum(t.height for t in tiles)), (30, 30, 30))
    y = 0
    for t in tiles:
        out.paste(t, (0, y))
        y += t.height
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--refs", default=os.path.expanduser("~/.cache/liascape/we-ref/captures"))
    ap.add_argument("--report-dir", default=None)
    ap.add_argument("--sbs-dir", default=None)
    ap.add_argument("--notes", default=os.path.join(HERE, "scene_we_notes.json"))
    ap.add_argument("--first", default="", help="ids listed first in the report regardless of score (comma list)")
    a = ap.parse_args()
    run = read_json(os.path.join(a.results, "run.json"), {})
    notes = read_json(a.notes, {})
    res = []
    os.makedirs(os.path.join(a.results, "sbs"), exist_ok=True)
    scenes = os.path.join(a.results, "scenes")
    for sid in sorted(os.listdir(scenes)) if os.path.isdir(scenes) else []:
        man = read_json(os.path.join(a.refs, sid, "manifest.json"))
        if not man:
            continue
        ours = our_shots(os.path.join(scenes, sid))
        refs = ref_shots(os.path.join(a.refs, sid))
        # WE's frame for T was taken late_ms after T: ours is rendered at that actual time (to 0.1 s)
        actual = {round(float(x["t"]), 1): round(float(x.get("t_actual", x["t"])), 1) for x in man.get("shots", [])}
        ex = read_json(os.path.join(scenes, sid, "exit.json"), {})
        pairs = []
        rows = []
        for t in sorted(refs):
            ta = actual.get(t, t)
            if ta not in ours:
                continue
            we, us = load(refs[t]), load(ours[ta])
            pa, pb = fit_pair(we, us)
            m = measures(pa, pb)
            m["t"] = t
            m["t_ours"] = ta
            pairs.append(m)
            rows.append((t, we, us))
        r = {"id": sid, "exit": ex.get("exit"), "times": [p["t"] for p in pairs], "pairs": pairs,
             "props": man.get("props", []), "pointer": man.get("pointer", ""), "window": man.get("window"),
             "class": (notes.get(sid) or {}).get("class", ""), "note": (notes.get(sid) or {}).get("note", "")}
        if pairs:
            for k in ("dist", "ssim", "hist", "edges", "local", "mean_abs"):
                r[k] = float(np.mean([p[k] for p in pairs]))
            worst = max(pairs, key=lambda p: p["dist"])
            r["worst_t"], r["worst_dist"] = worst["t"], worst["dist"]
            im = sbs(rows)
            im.save(os.path.join(a.results, "sbs", f"{sid}.png"))
            if a.sbs_dir:
                os.makedirs(a.sbs_dir, exist_ok=True)
                small = im if im.width <= 960 else im.resize((960, round(im.height * 960 / im.width)), Image.LANCZOS)
                small.save(os.path.join(a.sbs_dir, f"{sid}.jpg"), quality=80, optimize=True)
        else:
            r["dist"] = None
        res.append(r)
    first = [x for x in a.first.split(",") if x]
    res.sort(key=lambda r: (r["id"] not in first, first.index(r["id"]) if r["id"] in first else 0,
                            -(r["dist"] if r["dist"] is not None else 9)))
    # contact sheet of the worst 20 (WE | ours at the worst time)
    sheet_rows = []
    for r in [r for r in res if r.get("dist") is not None][:20]:
        p = os.path.join(a.results, "sbs", f"{r['id']}.png")
        im = Image.open(p)
        sheet_rows.append((f"{r['id']}  {r['dist']:.3f}", im.resize((720, round(im.height * 720 / im.width)))))
    if sheet_rows:
        spr.contact_sheet(sheet_rows, os.path.join(a.results, "contact-worst20.png"))
    out = {"run": run, "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "scenes": res}
    with open(os.path.join(a.results, "scene-we-ref.json"), "w") as f:
        json.dump(out, f, indent=1)
    if a.report_dir:
        with open(os.path.join(a.report_dir, "scene-we-ref.json"), "w") as f:
            json.dump(out, f, indent=1)
        with open(os.path.join(a.report_dir, "scene-we-ref.md"), "w") as f:
            f.write(render_md(out, a, first))
    print(f"scene_we: {len(res)} scenes scored → {a.results}", file=sys.stderr)


def render_md(out, a, first):
    run = out["run"]
    res = out["scenes"]
    sbs_rel = os.path.relpath(a.sbs_dir, a.report_dir) if a.sbs_dir else None
    L = []
    L.append("# Scene WE-reference compare — our render against real Wallpaper Engine\n")
    L.append("Generated by `src/player/tests/onmachine/scene_we_compare.sh` + `scene_we_report.py` from references "
             "captured by `scripts/dev/we-ref-capture.sh` — regenerate, don't hand-edit (notes come from "
             "`src/player/tests/onmachine/scene_we_notes.json`). **A ranked \"look here first\" list, not pass/fail.** "
             "Items are named by Workshop id only.\n")
    L.append(f"- **Run:** {run.get('started', '?')}, commit `{run.get('commit', '?')}`, LWE pin `{run.get('pin', '?')}`, "
             f"GPU {run.get('gpu', '?')}; references: Wallpaper Engine {run.get('we', '?')} under {run.get('proton', '?')}, "
             "Ultra preset, MSAA x8, 30 fps, no audio device; {} scenes.".format(len(res)))
    L.append("- **How:** WE renders each scene in a window of the canvas's own aspect (<= 1920 x 1080) inside a "
             "headless gamescope; frames at T s after its first non-black frame (+-80 ms). Ours: `liascape-scene-worker "
             "--lwe-smoke --shots` at the same T (paced 30 fps, particle seed 7), same props / pointer path. Each pair "
             "at 256 px wide: score = 0.30 ssim + 0.20 hist + 0.20 edges + 0.30 local (the preview compare's measures, "
             "no alignment needed); a scene's score is its mean over the times, `worst` its worst time.")
    L.append("- **Not render bugs by themselves:** WE's particles and random choices are unseeded (ours seed 7), a "
             "clock / date shows the capture's wall time, WE's time base is +-80 ms (fast motion), and media-driven "
             "layers have no media on either side.")
    if sbs_rel:
        L.append(f"- **Images:** side-by-sides (WE | ours | |diff| x4, a row per time) `{sbs_rel}/<id>.jpg`; "
                 "WE frames (960 px JPEG) + manifests `docs/player/reports/we-ref/<id>/`.\n")
    L.append("| # | id | score | worst (t) | ssim | hist | edges | local | |Δ| | class | note |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(res, 1):
        if r.get("dist") is None:
            L.append(f"| {i} | {r['id']} | — | | | | | | | {r['class']} | no pair (exit {r.get('exit')}) {r['note']} |")
            continue
        img = f"[sbs]({sbs_rel}/{r['id']}.jpg)" if sbs_rel else ""
        L.append(f"| {i} | {r['id']} | {r['dist']:.3f} | {r['worst_dist']:.3f} ({r['worst_t']:g} s) | {r['ssim']:.2f} | "
                 f"{r['hist']:.2f} | {r['edges']:.2f} | {r['local']:.2f} | {r['mean_abs']:.3f} | {r['class']} | "
                 f"{r['note']} {img} |")
    L.append("")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
