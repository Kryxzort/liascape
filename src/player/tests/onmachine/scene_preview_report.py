#!/usr/bin/env python3
"""Score each scene's render against its author's preview and write scene-preview.{md,json}.

    python3 -I scene_preview_report.py --results /tmp/liascape-scene-preview-<stamp> [--report-dir docs/player/reports]
        [--dir <workshop folder>] [--notes scene_preview_notes.json]

Reads <results>/run.json and <results>/scenes/<id>/{lwe-smoke-<T>s.png, smoke.json, exit.json} (scene_preview_compare.sh)
and <dir>/<id>/project.json's `preview` (jpg / png / gif). Needs numpy, Pillow and OpenCV (the runner finds them).

A preview is the author's square capture from WE's editor: a crop of the canvas (usually all of its height, sometimes
less), resized, sometimes edited, an animated gif for most scenes. So, per scene:

  1. Every pair (one of our frames, one preview frame — a gif's frames sampled to <= 12) is aligned first: the
     square of the frame that best matches the preview (normalised cross-correlation of blurred grey images, at
     window sizes 100 %…40 % of the frame's height, every position) is the crop. The full frame squeezed to a square
     is tried too (a preview made from a stretched capture).
  2. The aligned pair, both at 128 × 128, is scored by four measures, each a distance in 0…1:
       ssim    1 - SSIM of the blurred grey images (structure: a missing or moved layer, a flipped axis)
       hist    Bhattacharyya distance of the HSV histograms (colour: a wrong tint, a black or blown-out frame)
       edges   1 - F1 overlap of Canny edge maps (dilated 2 px: outlines in the right places)
       local   the mean of the worst 3 of the 4 × 4 cells' (1 - SSIM + |mean colour difference|), clipped to 1
               (a regional loss: a head that isn't there, a band that is)
     dist = 0.30 ssim + 0.20 hist + 0.20 edges + 0.30 local (weights calibrated on 3414858021 before and after its
     head fix and on scenes the owner has seen right — see the report's calibration section).
  3. The scene's score is its best pair's dist (the best-matching gif frame at the best of our times): low = looks
     like its preview.

The output is a ranked "look here first" list, not pass/fail: a preview that is a crop of a scene's corner, an
edited poster, or a moment of an animation we never reach still ranks high, and the notes file
(scene_preview_notes.json: {id: {class, note}}) records which differences are explained (class `by-design`,
`time`, `property`, `crop`, `fixed`, `bug`, `known`). Side-by-sides (our frame with the crop boxed | our crop | the
preview frame) go to <results>/sbs/<id>.png, a contact sheet of the worst 20 to <results>/contact-worst20.png.

Workshop items are named by id only (never by title). PNGs stay in the results dir.
"""

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
WORKSHOP = os.path.expanduser("~/.local/share/Steam/steamapps/workshop/content/431960")
SIDE = 128  # the common size of an aligned pair
SEARCH_H = 96  # the frame's height for the crop search
WEIGHTS = {"ssim": 0.30, "hist": 0.20, "edges": 0.20, "local": 0.30}
GIF_FRAMES = 12


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def rgb(im):
    """PIL image → float32 RGB array 0…1 (alpha composited on black)."""
    im = im.convert("RGBA")
    a = np.asarray(im, dtype=np.float32) / 255.0
    return a[..., :3] * a[..., 3:4]


def preview_frames(path):
    """The preview's frames (a gif's sampled evenly to <= GIF_FRAMES), as RGB float arrays."""
    im = Image.open(path)
    n = getattr(im, "n_frames", 1)
    if n <= 1:
        return [rgb(im)], 1
    want = sorted(set(np.linspace(0, n - 1, min(n, GIF_FRAMES)).round().astype(int).tolist()))
    out = []
    for i, fr in enumerate(ImageSequence.Iterator(im)):
        if i in want:
            out.append(rgb(fr.copy()))
    return out, n


def grey(a):
    return cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)


def resize(a, w, h):
    interp = cv2.INTER_AREA if w < a.shape[1] else cv2.INTER_LINEAR
    return cv2.resize(a, (w, h), interpolation=interp)


def ssim_map(x, y):
    c1, c2 = 0.01**2, 0.03**2
    blur = lambda z: cv2.GaussianBlur(z, (7, 7), 1.5)
    mx, my = blur(x), blur(y)
    vx = blur(x * x) - mx * mx
    vy = blur(y * y) - my * my
    cxy = blur(x * y) - mx * my
    return ((2 * mx * my + c1) * (2 * cxy + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2))


def hist_dist(a, b):
    def h(z):
        hsv = cv2.cvtColor(z, cv2.COLOR_RGB2HSV)  # float: H 0…360, S, V 0…1
        hh = cv2.calcHist([hsv], [0, 1, 2], None, [12, 4, 6], [0, 360, 0, 1, 0, 1])
        return cv2.normalize(hh, hh).flatten()

    return float(cv2.compareHist(h(a), h(b), cv2.HISTCMP_BHATTACHARYYA))


def edges(g):
    u8 = (np.clip(g, 0, 1) * 255).astype(np.uint8)
    u8 = cv2.GaussianBlur(u8, (3, 3), 0)
    med = float(np.median(u8))
    lo, hi = int(max(0, 0.66 * med)), int(min(255, 1.33 * med + 20))
    return cv2.Canny(u8, lo, max(hi, lo + 10)) > 0


def edge_dist(ga, gb):
    ea, eb = edges(ga), edges(gb)
    if ea.sum() < 10 and eb.sum() < 10:
        return 0.0
    k = np.ones((5, 5), np.uint8)
    da = cv2.dilate(ea.astype(np.uint8), k) > 0
    db = cv2.dilate(eb.astype(np.uint8), k) > 0
    p = (ea & db).sum() / max(ea.sum(), 1)
    r = (eb & da).sum() / max(eb.sum(), 1)
    return float(1 - (2 * p * r / (p + r) if p + r > 0 else 0.0))


def measures(a, b):
    """Distances of two aligned SIDE x SIDE RGB arrays."""
    ga = cv2.GaussianBlur(grey(a), (3, 3), 0.8)
    gb = cv2.GaussianBlur(grey(b), (3, 3), 0.8)
    sm = ssim_map(ga, gb)
    cells = []
    n = 4
    s = SIDE // n
    for i in range(n):
        for j in range(n):
            sl = (slice(i * s, (i + 1) * s), slice(j * s, (j + 1) * s))
            col = float(np.abs(a[sl].mean(axis=(0, 1)) - b[sl].mean(axis=(0, 1))).mean()) * 2
            cells.append(min(1.0, max(0.0, 1 - float(sm[sl].mean())) + col))
    cells.sort(reverse=True)
    m = {
        "ssim": float(np.clip(1 - sm.mean(), 0, 1)),
        "hist": hist_dist(a, b),
        "edges": edge_dist(ga, gb),
        "local": float(np.mean(cells[:3])),
    }
    m["dist"] = float(sum(WEIGHTS[k] * m[k] for k in WEIGHTS))
    return m


def align(frame, prev):
    """The square of `frame` that best matches `prev` (both RGB float): (x, y, side) in frame px, + the score."""
    H, W = frame.shape[:2]
    k = SEARCH_H / H
    fs = grey(resize(frame, max(1, round(W * k)), SEARCH_H))
    fs = cv2.GaussianBlur(fs, (5, 5), 1.2)
    best = (-2.0, (0, 0, H))
    for frac in np.linspace(1.0, 0.4, 13):
        side = int(round(SEARCH_H * frac))
        if side < 16 or side > fs.shape[1]:
            continue
        t = cv2.GaussianBlur(grey(resize(prev, side, side)), (5, 5), 1.2)
        if float(t.std()) < 1e-4:
            continue
        r = cv2.matchTemplate(fs, t, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(r)
        if mx > best[0]:
            best = (mx, (loc[0] / k, loc[1] / k, side / k))
    x, y, s = best[1]
    if best[0] <= -1.5:  # flat preview: the centred full-height square
        s = min(H, W)
        x, y = (W - s) / 2, (H - s) / 2
    return (int(round(x)), int(round(y)), int(round(s))), best[0]


def crop(frame, box):
    x, y, s = box
    H, W = frame.shape[:2]
    x, y = max(0, min(x, W - 1)), max(0, min(y, H - 1))
    c = frame[y : min(H, y + s), x : min(W, x + s)]
    return resize(c, SIDE, SIDE)


def score_scene(shots, prevs):
    """Best (frame, preview frame) pair: dict with the measures, the time, the gif frame index, the box."""
    best = None
    pv = [resize(p, SIDE, SIDE) for p in prevs]
    for t, fr in shots:
        H, W = fr.shape[:2]
        for i, p in enumerate(prevs):
            box, ncc = align(fr, p)
            m = measures(crop(fr, box), pv[i])
            m.update(t=t, gif_frame=i, box=list(box), ncc=round(float(ncc), 3), fit="crop")
            sq = measures(resize(fr, SIDE, SIDE), pv[i])  # the whole frame squeezed square
            if sq["dist"] < m["dist"]:
                sq.update(t=t, gif_frame=i, box=[0, 0, 0], ncc=None, fit="squeeze")
                m = sq
            if best is None or m["dist"] < best["dist"]:
                best = m
    return best


def to_pil(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


def side_by_side(fr, box, fit, prev, h=240):
    """our frame (crop boxed) | our crop | the preview frame, `h` px high."""
    H, W = fr.shape[:2]
    full = to_pil(fr).resize((max(1, round(W * h / H)), h), Image.LANCZOS)
    d = ImageDraw.Draw(full)
    k = h / H
    if fit == "crop":
        x, y, s = box
        d.rectangle([x * k, y * k, (x + s) * k - 1, (y + s) * k - 1], outline=(255, 0, 255), width=2)
        ours = to_pil(crop(fr, box)).resize((h, h), Image.LANCZOS)
    else:
        ours = to_pil(resize(fr, SIDE, SIDE)).resize((h, h), Image.LANCZOS)
    pv = to_pil(prev).resize((h, h), Image.LANCZOS)
    out = Image.new("RGB", (full.width + 2 * h + 8, h), (40, 40, 40))
    out.paste(full, (0, 0))
    out.paste(ours, (full.width + 4, 0))
    out.paste(pv, (full.width + h + 8, 0))
    return out


def contact_sheet(rows, path):
    """rows: [(label, PIL side-by-side)] stacked, two columns."""
    if not rows:
        return
    lab = 18
    w = max(im.width for _, im in rows)
    h = max(im.height for _, im in rows) + lab
    cols = 2
    n = (len(rows) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w + (cols - 1) * 6, n * h), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(rows):
        x, y = (i % cols) * (w + 6), (i // cols) * h
        d.text((x + 4, y + 3), label, fill=(255, 255, 0))
        sheet.paste(im, (x, y + lab))
    sheet.save(path)


def shot_times(d):
    out = []
    for f in os.listdir(d):
        if f.startswith("lwe-smoke-") and f.endswith("s.png") and "before" not in f:
            try:
                out.append((float(f[len("lwe-smoke-") : -5]), os.path.join(d, f)))
            except ValueError:
                pass
    return sorted(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--report-dir")
    ap.add_argument("--dir", default=WORKSHOP)
    ap.add_argument("--notes", default=os.path.join(HERE, "scene_preview_notes.json"))
    ap.add_argument("--times", default="", help="only these shot times (comma list); default all")
    args = ap.parse_args()
    res = os.path.abspath(args.results)
    run = read_json(os.path.join(res, "run.json"), {}) or {}
    notes = read_json(args.notes, {}) or {}
    only_t = {float(x) for x in args.times.split(",") if x.strip()}
    sbs_dir = os.path.join(res, "sbs")
    os.makedirs(sbs_dir, exist_ok=True)
    scenes_dir = os.path.join(res, "scenes")
    recs = []
    for sid in sorted(os.listdir(scenes_dir)):
        d = os.path.join(scenes_dir, sid)
        proj = read_json(os.path.join(args.dir, sid, "project.json"), {}) or {}
        pname = proj.get("preview") or ""
        ppath = os.path.join(args.dir, sid, pname)
        ex = read_json(os.path.join(d, "exit.json"), {}) or {}
        rec = {"id": sid, "preview": pname, "exit": ex.get("exit")}
        shots = [(t, p) for t, p in shot_times(d) if not only_t or t in only_t]
        if not pname or not os.path.isfile(ppath):
            rec.update(status="no-preview")
        elif not shots:
            rec.update(status="no-render")
        else:
            prevs, nframes = preview_frames(ppath)
            frames = [(t, rgb(Image.open(p))) for t, p in shots]
            b = score_scene(frames, prevs)
            fr = dict(frames)[b["t"]]
            sbs = os.path.join(sbs_dir, f"{sid}.png")
            side_by_side(fr, b["box"], b["fit"], prevs[b["gif_frame"]], 240).save(sbs)
            gif_idx = int(np.linspace(0, nframes - 1, min(nframes, GIF_FRAMES)).round()[b["gif_frame"]]) if nframes > 1 else 0
            rec.update(
                status="scored",
                score=round(b["dist"], 4),
                measures={k: round(b[k], 4) for k in WEIGHTS},
                t=b["t"],
                fit=b["fit"],
                box=b["box"],
                ncc=b["ncc"],
                preview_frames=nframes,
                preview_frame=gif_idx,
                frame=os.path.join(d, os.path.basename(dict(shots)[b["t"]])),
                preview_path=ppath,
                side_by_side=sbs,
                native=list(fr.shape[1::-1]),
            )
        n = notes.get(sid) or {}
        if n:
            rec["class"] = n.get("class")
            rec["note"] = n.get("note")
        recs.append(rec)
        print(f"scene_preview: {sid} {rec.get('score', rec['status'])}", file=sys.stderr)
    scored = sorted((r for r in recs if r["status"] == "scored"), key=lambda r: -r["score"])
    for i, r in enumerate(scored):
        r["rank"] = i + 1
    rows = []
    for r in scored[:20]:
        rows.append((f"#{r['rank']} {r['id']}  {r['score']:.3f}  t={r['t']}s  {r.get('class') or ''}", Image.open(r["side_by_side"])))
    sheet = os.path.join(res, "contact-worst20.png")
    contact_sheet(rows, sheet)
    out = {
        "run": run,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "weights": WEIGHTS,
        "contact_sheet": sheet,
        "scenes": scored + [r for r in recs if r["status"] != "scored"],
    }
    dest = [res] + ([os.path.abspath(args.report_dir)] if args.report_dir else [])
    md = render_md(out, res)
    for dd in dest:
        os.makedirs(dd, exist_ok=True)
        with open(os.path.join(dd, "scene-preview.json"), "w") as f:
            json.dump(out, f, indent=1)
            f.write("\n")
        with open(os.path.join(dd, "scene-preview.md"), "w") as f:
            f.write(md)
    print(f"scene_preview: {len(scored)} scored → {', '.join(dest)}", file=sys.stderr)


def render_md(out, res):
    run = out["run"]
    sc = [r for r in out["scenes"] if r["status"] == "scored"]
    other = [r for r in out["scenes"] if r["status"] != "scored"]
    L = []
    a = L.append
    a("# Scene preview compare — our render against each author's preview\n")
    a("Generated by `src/player/tests/onmachine/scene_preview_compare.sh` + `scene_preview_report.py` — regenerate, don't "
      "hand-edit (the classes come from `src/player/tests/onmachine/scene_preview_notes.json`). **A ranked \"look here "
      "first\" list, not pass/fail.** Items are named by Workshop id only.\n")
    a(f"- **Run:** {run.get('started', '?')}, commit `{run.get('commit', '?')}`, LWE core `{run.get('core', run.get('lwe', '?'))}`, "
      f"GPU {run.get('gpu', '?')}; {len(sc)} scenes scored from `{run.get('dir', '?')}`"
      + (f", {len(other)} not ({', '.join(r['id'] + ' ' + r['status'] for r in other)})" if other else "") + ".")
    a(f"- **How:** one `liascape-scene-worker --lwe-smoke <scene> --shots {run.get('shots', '?')} --shot-width {run.get('shot_width', '?')}` "
      "per scene (offscreen, paced 30 fps, particle seed 7, no audio device). Every (our frame, preview frame) pair — a gif "
      f"sampled to {GIF_FRAMES} frames — is aligned (the best-correlating square of our frame, 100–40 % of its height, or "
      "the frame squeezed square) and scored at 128 × 128; the scene keeps its best pair.")
    a("- **Score** (distance, 0 = identical): " + " + ".join(f"{w:.2f} {k}" for k, w in out["weights"].items()) +
      ". `ssim` = 1 − SSIM (grey), `hist` = HSV-histogram Bhattacharyya distance, `edges` = 1 − Canny-edge F1, "
      "`local` = mean of the worst 3 of 4 × 4 cells' (1 − SSIM + colour difference). See the script's docstring.")
    a(f"- **Images:** side-by-sides (our frame with the crop boxed | our crop | the preview) `{res}/sbs/<id>.png`; "
      f"the worst 20 on one sheet: `{out['contact_sheet']}`. Captures are not committed.\n")
    a("## Calibration\n")
    a("3414858021 rendered by the core before its head fix (pin `157c111`) and after: see "
      "`docs/player/spikes/we-lwe-gap-audit.md` § \"Preview compare result\" for the numbers that set the weights.\n")
    classes = {}
    for r in sc:
        classes[r.get("class") or "unexamined"] = classes.get(r.get("class") or "unexamined", 0) + 1
    a("## Summary\n")
    a("| class | scenes |")
    a("|---|---|")
    for k in sorted(classes, key=lambda k: -classes[k]):
        a(f"| {k} | {classes[k]} |")
    a("")
    a("Classes: `bug` a render bug still open · `fixed` a render bug fixed (the score is after the fix) · `known` a "
      "known gap with its own TODO · `by-design` the preview differs on purpose (an edited poster, other art, overlays) · "
      "`crop` the preview shows a part we can't align · `time` an animation moment we don't reach · `property` other "
      "user-property settings · `ok` looked at, matches · `unexamined` not looked at yet.\n")
    a("## Ranked\n")
    a("| # | id | score | ssim | hist | edges | local | t | fit | class | note |")
    a("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in sc:
        m = r["measures"]
        note = (r.get("note") or "").replace("|", "\\|").replace("\n", " ")
        a(f"| {r['rank']} | {r['id']} | {r['score']:.3f} | {m['ssim']:.2f} | {m['hist']:.2f} | {m['edges']:.2f} | "
          f"{m['local']:.2f} | {r['t']} s | {r['fit']} | {r.get('class') or ''} | {note} |")
    a("")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
