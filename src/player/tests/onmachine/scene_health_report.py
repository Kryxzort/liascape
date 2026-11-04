#!/usr/bin/env python3
"""The per-scene health report: classify a scene_health.sh run and write scene-health.{md,json}.

    python3 -I scene_health_report.py --results /tmp/liascape-scene-health-<stamp> [--report-dir docs/player/reports]

Reads <results>/run.json and <results>/scenes/<id>/{health.json | health.jsonl, smoke.json, exit.json}.
health.json is the smoke's dump of LWE's `WPENGINE_HEALTH` records (fork patches 0061–0062; the event list is in the
core's WallpaperEngine/Health.h); a smoke that crashed or timed out leaves only health.jsonl, read instead.

Classes, first match wins:
  failed    no scene was built (load / renderer build failed, the smoke crashed or timed out, or nothing was lit)
  degraded  at least one error: an object or effect left out, a shader / script / asset error, a feature LWE
            reports as unsupported, a non-finite transform
  clean     none of those (warnings — a visible layer off the canvas, at alpha 0 or of zero size at frames 1 and 31,
            a script's own console.error, unparsable shader metadata — don't make a scene degraded)

Degraded scenes are ranked by `loss`, an estimate of how much of the picture is gone (fractions of the canvas):
a dropped visible layer counts its on-canvas area (its scene-data box: size × scale about its origin), a dropped
compose layer 0.3, a dropped particle system 0.05, a dropped model 0.1, a hidden one a tenth of that; an effect left
out counts 0.3 × its layer's on-canvas area; each distinct script error 0.01, missing texture 0.05, missing user texture 0.005 (a fallback
shows), other missing asset 0.02, unsupported feature 0.01 (a user property type 0.002), non-finite layer 0.05. The causes are tallied across scenes by a normalised
signature (line numbers and object ids out), so fixes can be batched.

Workshop items are named by id only (never by title). PNGs stay in the results dir.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
DRAWN = {"image", "text", "compose"}
CLASSES = ["clean", "degraded", "failed"]


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return default


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    except OSError:
        pass
    return out


def norm(text, n=160):
    """A message's signature: its first line, numbers out, short."""
    text = (text or "").strip()
    line = text.splitlines()[0] if text else ""
    line = re.sub(r"\b0x[0-9a-fA-F]+\b", "N", line)
    line = re.sub(r"(?<![A-Za-z_\d])\d+(\.\d+)?", "N", line)
    line = re.sub(r"\s+", " ", line).strip()
    return line[:n]


def glslang_first(message):
    """The first real glslang error, without its `ERROR: 0:123:` prefix."""
    for line in (message or "").splitlines():
        line = line.strip()
        if not line.startswith("ERROR:"):
            continue
        body = re.sub(r"^ERROR:\s*(\d+:\d+:)?\s*", "", line)
        if re.match(r"^\d+ compilation errors", body) or "compilation terminated" in body:
            continue
        return re.sub(r"\s+", " ", body).strip()
    return norm(message)


def gl_first(message):
    for line in (message or "").splitlines():
        if "error" in line.lower():
            return re.sub(r"^\s*\d*\(\d+\)\s*:\s*", "", line).strip()
    return norm(message)


def short(text, n=220):
    text = re.sub(r"\s+", " ", (text or "")).strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def layer_label(e):
    name = e.get("object_name")
    oid = e.get("object")
    t = e.get("type")
    bits = [f"layer {oid}" if oid is not None and oid != -1 else
            f"property `{e['property']}`" if oid is None and e.get("property") else "scene"]
    if t:
        bits.append(t)
    if name:
        bits.append(f"“{short(str(name), 40)}”")
    return " ".join(bits)


def fmt_box(b):
    if not b:
        return "–"
    return "(" + ", ".join(f"{v:.0f}" for v in b) + ")"


def analyse(sid, sdir):
    health = read_json(os.path.join(sdir, "health.json"))
    if health is not None:
        events = health.get("events", [])
        smoke = health.get("smoke") or {}
    else:
        events = read_jsonl(os.path.join(sdir, "health.jsonl"))
        lines = read_jsonl(os.path.join(sdir, "smoke.json"))
        smoke = lines[-1] if lines else {}
    exit_info = read_json(os.path.join(sdir, "exit.json"), {}) or {}
    code = exit_info.get("exit")

    # the smoke's own numbers (an Err "not animating or blank: {json}" still carries them)
    numbers = smoke if smoke.get("native") else {}
    err = smoke.get("error") or ""
    if not numbers and err.startswith("not animating or blank: "):
        try:
            numbers = json.loads(err[len("not animating or blank: "):])
        except json.JSONDecodeError:
            numbers = {}

    by_ev = defaultdict(list)
    for e in events:
        by_ev[e.get("ev")].append(e)
    scene = (by_ev.get("scene") or [{}])[0]
    native = numbers.get("native") or [0, 0]
    width = scene.get("width") or native[0] or 1
    height = scene.get("height") or native[1] or 1
    canvas = float(width * height)
    objects = {e.get("object"): e for e in by_ev.get("object", [])}
    layers = defaultdict(dict)  # object → frame → record
    for e in by_ev.get("layers", []):
        layers[e.get("object")][e.get("frame")] = e

    def on_canvas_fraction(oid):
        rec = layers.get(oid, {}).get(1) or layers.get(oid, {}).get(31)
        if rec and rec.get("on_canvas_px") is not None:
            return min(1.0, rec["on_canvas_px"] / canvas)
        o = objects.get(oid)
        if o and o.get("estimated_on_canvas_px") is not None:
            return min(1.0, o["estimated_on_canvas_px"] / canvas)
        return 0.0

    # glslang errors per (object, effect): the cause of a drop whose own reason is GL's "must write to gl_Position"
    glslang = {}
    gl = {}
    for e in by_ev.get("shader_error", []):
        if e.get("stage") == "glslang":
            glslang.setdefault((e.get("object"), e.get("effect")), e)
            glslang.setdefault((e.get("object"), None), e)
        elif "must write to gl_Position" not in (e.get("message") or ""):
            gl.setdefault((e.get("object"), e.get("effect")), e)
            gl.setdefault((e.get("object"), None), e)

    problems = []

    def add(kind, severity, cause, message, loss=0.0, e=None, **extra):
        p = {"kind": kind, "severity": severity, "cause": cause, "message": short(message, 400), "loss": round(loss, 4)}
        if e is not None:
            for k in ("object", "object_name", "type", "effect", "effect_name", "shader", "property", "phase", "path"):
                if e.get(k) is not None:
                    p[k] = e[k]
            if p.get("object") in objects and "type" not in p:
                p["type"] = objects[p["object"]].get("type")
        p.update(extra)
        problems.append(p)

    def shader_cause(key):
        """The drop's cause: glslang's first error, else the driver's (glslang accepted, GL refused)."""
        g = glslang.get(key)
        if g is not None:
            return f"glslang: {glslang_first(g.get('message'))}", g
        g = gl.get(key)
        if g is not None:
            return f"GL: {norm(gl_first(g.get('message')))}", dict(g, message=gl_first(g.get("message")))
        return None, None

    # objects left out
    for e in by_ev.get("dropped", []):
        oid = e.get("object")
        o = objects.get(oid, {})
        t = o.get("type") or e.get("type") or "?"
        visible = o.get("effectively_visible", True)
        if t == "compose":
            loss = 0.3
        elif t in DRAWN:
            loss = on_canvas_fraction(oid)
        elif t == "particle":
            loss = 0.05
        elif t == "model":
            loss = 0.1
        else:
            loss = 0.02
        if not visible:
            loss *= 0.1
        reason = e.get("reason") or ""
        cause, g = shader_cause((oid, None))
        if cause is None:
            cause = f"dropped: {norm(reason)}"
        msg = f"{t} not built" + ("" if visible else " (hidden at load)")
        msg += f": {(glslang_first(g['message']) if g.get('stage') == 'glslang' else g['message']) if g else short(reason)}"
        if g and g.get("shader"):
            msg += f" [{g['shader']}]"
        add("dropped", "error", cause, msg, loss, {**e, "type": t}, visible=visible)

    # objects the build report lists as not built without a `dropped` record (none expected; kept honest)
    dropped_ids = {e.get("object") for e in by_ev.get("dropped", [])}
    for oid, o in objects.items():
        if not o.get("built") and oid not in dropped_ids and o.get("type") not in ("group", "camera", "light"):
            t = o.get("type")
            add("dropped", "error", f"not built (no reason logged): {t}", f"{t} not built, no reason logged",
                on_canvas_fraction(oid) if t in DRAWN else 0.02, o)

    # effects left out
    for e in by_ev.get("effect_dropped", []):
        oid = e.get("object")
        cause, g = shader_cause((oid, e.get("effect")))
        if cause is None:
            cause = f"effect dropped: {norm(e.get('reason'))}"
        takes = e.get("takes_layer")
        loss = 0.0 if takes else 0.3 * on_canvas_fraction(oid)
        if oid == -1:
            loss = 0.05
        msg = f"effect {e.get('effect')} “{short(str(e.get('effect_name') or ''), 40)}” left out"
        msg += " (and with it the layer)" if takes else ""
        msg += f": {(glslang_first(g['message']) if g.get('stage') == 'glslang' else g['message']) if g else short(e.get('reason'))}"
        if g and g.get("shader"):
            msg += f" [{g['shader']}]"
        add("effect_dropped", "error", cause, msg, loss, e)

    # shader errors that didn't end in a drop above (the drop records carry those)
    explained = {(p.get("object"), p.get("effect")) for p in problems}
    explained |= {(p.get("object"), None) for p in problems if p["kind"] == "dropped"}
    for e in by_ev.get("shader_error", []):
        key = (e.get("object"), e.get("effect"))
        if key in explained or (e.get("object"), None) in explained:
            continue
        if e.get("stage") == "gl" and "must write to gl_Position" in (e.get("message") or "") and key in glslang:
            continue  # GL's view of the empty source glslang left
        if e.get("stage") == "glslang":
            cause = f"glslang: {glslang_first(e.get('message'))}"
        else:
            cause = f"GL: {norm(gl_first(e.get('message')))}"
        add("shader_error", "error", cause, f"{e.get('stage')} {e.get('unit')}: {short(e.get('message'))}", 0.01, e)
        explained.add(key)

    for e in by_ev.get("missing_asset", []):
        kind = e.get("kind") or "?"
        path = e.get("path") or ""
        # a user texture names what the user picked: a fallback shows until then (WE's too)
        loss = 0.05 if kind == "texture" else 0.005 if kind == "usertexture" else 0.02
        add("missing_asset", "error", f"missing {kind}: {re.sub(r'[0-9]+', 'N', path)[:100] or '(empty name) ' + norm(e.get('message'), 80)}", f"{kind} {path}: {short(e.get('message'), 160)}",
            loss, e)

    for e in by_ev.get("asset_error", []):
        add("asset_error", "error", f"{e.get('kind')} asset: {norm(e.get('message'), 100)}",
            f"{e.get('kind')} {e.get('path') or ''}: {short(e.get('message'), 160)}", 0.02, e)

    seen_scripts = set()
    for e in by_ev.get("script_error", []):
        key = (e.get("object"), e.get("property"), e.get("phase"))
        first = key not in seen_scripts
        seen_scripts.add(key)
        m = e.get("message") or ""
        # the identifiers of "x.y is not a function" are the cause; the values in other messages aren't
        nf = re.search(r"([\w.]+) is not a function", m)
        src = e.get("source_line") or ""
        if nf:
            cause = f"script: {nf.group(1)} is not a function"
        elif m.strip() in ("TypeError: not a function", "TypeError: not an object") and src:
            # QuickJS names no callee: the calls on the line it points at do (the column's call first)
            col = e.get("column") or 0
            calls = [(mm.start(), mm.group(1)) for mm in re.finditer(r"([A-Za-z_$][\w$.]*)\s*\(", src)]
            calls = [c for c in calls if c[1].split(".")[-1] not in ("if", "for", "while", "switch", "return", "function")]
            near = min(calls, key=lambda c: abs(c[0] + 1 - col), default=None)
            name = near[1] if near else ""
            cause = f"script: {m.strip()[len('TypeError: '):]} — {name}()" if name else f"script: {norm(m, 120)}"
        else:
            cause = f"script: {norm(m, 120)}"
        msg = f"script on `{e.get('property')}` ({e.get('phase')}): {short(m, 200)}"
        if src:
            msg += f" — line {e.get('line')}: `{short(src.strip(), 120)}`"
        add("script_error", "error", cause, msg, 0.01 if first else 0.0, e)

    for e in by_ev.get("unsupported", []):
        what = e.get("what") or ""
        extra = f" (property `{e['property']}`)" if e.get("property") else ""
        add("unsupported", "error", f"unsupported: {what}", f"unsupported: {what}{extra}",
            0.002 if what.startswith("user property type") else 0.01, e)
    for e in by_ev.get("pass_error", []):
        add("pass_error", "error", f"pass: {norm(e.get('message'))}", short(e.get("message")), 0.01, e)
    for e in by_ev.get("parse_error", []):
        add("parse_error", "error", f"parse: {norm(e.get('message'), 100)}", short(e.get("message")), 0.02, e)
    for e in by_ev.get("renderer_failed", []) + by_ev.get("load_failed", []):
        add(e.get("ev"), "error", f"{e.get('ev')}: {norm(e.get('message'))}", short(e.get("message")), 1.0, e)

    # layers at frames 1 and 31 (both must agree for a layout warning: a script may move a layer in)
    for oid, frames in layers.items():
        recs = [frames[f] for f in sorted(frames)]
        bad = [r for r in recs if r.get("finite") is False]
        if bad:
            add("nonfinite", "error", "non-finite transform (NaN/inf)",
                f"NaN/inf in the transform at frame {bad[0].get('frame')}", 0.05, bad[0])
            continue
        drawn = [r for r in recs if r.get("type") in DRAWN and r.get("effectively_visible") and not r.get("fullscreen")
                 and not r.get("passthrough")]
        if drawn and len(drawn) == len(recs):
            r = drawn[0]
            if all(x.get("on_canvas_px") == 0 for x in drawn):
                add("offcanvas", "warning", "visible layer off the canvas (frames 1 and 31)",
                    f"visible, wholly off the {width}×{height} canvas: bbox {fmt_box(r.get('bbox'))}", 0.0, r)
            elif all((x.get("area_px") or 0) < 1 for x in drawn):
                add("zero_size", "warning", "visible layer of zero size (frames 1 and 31)", "visible, zero size", 0.0, r)
            elif all(x.get("alpha") is not None and x["alpha"] <= 0.001 for x in drawn):
                add("alpha0", "warning", "visible layer at alpha 0 (frames 1 and 31)", "visible, alpha 0", 0.0, r)
            if any(x.get("behind_camera") for x in drawn):
                add("behind_camera", "warning", "a layer corner behind the camera", "a corner behind the camera", 0.0, r)
        ps = [r for r in recs if r.get("type") == "particle" and r.get("effectively_visible") and "origin_on_canvas" in r]
        if ps and len(ps) == len(recs) and not any(r["origin_on_canvas"] for r in ps):
            add("offcanvas", "warning", "visible particle system's origin off the canvas (frames 1 and 31)",
                f"particle origin {fmt_box(ps[0].get('origin_px'))} off the canvas", 0.0, ps[0])

    for e in by_ev.get("shader_warning", []):
        add("shader_warning", "warning", f"shader metadata: {norm(e.get('message'), 60)}", short(e.get("message"), 200),
            0.0, e)
    for e in by_ev.get("script_console_error", []):
        add("console_error", "warning", "script console.error", short(e.get("message"), 200), 0.0, e)

    compat = sorted({e.get("what") for e in by_ev.get("compat", [])} - {None})
    fonts = [e for e in by_ev.get("font", []) if e.get("used") and e.get("requested") and not e.get("system")
             and e.get("used") != e.get("requested")]

    lit = numbers.get("lit_pixels")
    failed_why = None
    if code is not None and code not in (0, 1):
        failed_why = "timed out" if code in (124, 137) else f"crashed (exit {code})"
    elif by_ev.get("load_failed"):
        failed_why = "load failed: " + short(by_ev["load_failed"][0].get("message"), 160)
    elif by_ev.get("renderer_failed"):
        failed_why = "renderer build failed: " + short(by_ev["renderer_failed"][0].get("message"), 160)
    elif not scene:
        failed_why = "no scene built: " + short(err or "(no smoke output)", 200)
    elif lit == 0:
        failed_why = "nothing lit (blank frame)"
    errors = [p for p in problems if p["severity"] == "error"]
    cls = "failed" if failed_why else ("degraded" if errors else "clean")
    loss = 1.0 if failed_why else min(1.0, sum(p["loss"] for p in problems))
    shots = numbers.get("shots") or sorted(os.path.join(sdir, f) for f in os.listdir(sdir) if f.endswith(".png"))
    return {
        "id": sid,
        "class": cls,
        "failed": failed_why,
        "loss": round(loss, 4),
        "native": numbers.get("native") or [width, height],
        "objects": scene.get("objects"),
        "built": scene.get("built"),
        "perspective": scene.get("perspective"),
        "hdr": scene.get("hdr"),
        "load_ms": numbers.get("load_ms"),
        "build_ms": numbers.get("build_ms"),
        "frame_ms_mean": numbers.get("frame_ms_mean"),
        "frame_ms_p95": numbers.get("frame_ms_p95"),
        "static": err.startswith("not animating or blank") and lit != 0,
        "shots": shots,
        "exit": code,
        "counts": dict(Counter(p["kind"] for p in problems)),
        "errors": len(errors),
        "warnings": len(problems) - len(errors),
        "problems": problems,
        "compat": compat,
        "fonts_substituted": [{"requested": f["requested"], "used": f["used"]} for f in fonts],
    }


def git(*args):
    try:
        return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def collapse(problems):
    """One line per (kind, cause, effect name / script property) with the layers it hit: 30 identical drops read as one."""
    out = {}
    for p in problems:
        key = (p["kind"], p["cause"], p.get("effect_name"), p.get("property") if p["kind"] == "script_error" else None)
        if key not in out:
            out[key] = dict(p, layers=[])
        out[key]["layers"].append(p)
    for v in out.values():
        v["loss"] = sum(x["loss"] for x in v["layers"])
    return sorted(out.values(), key=lambda p: -p["loss"])


def md_cell(text, n):
    return short(str(text), n).replace("|", "\\|")


def problem_line(p):
    layers = p.get("layers") or [p]
    where = layer_label(layers[0])
    if len(layers) > 1:
        more = ", ".join(str(x.get("object") if x.get("object") is not None else x.get("property")) for x in layers[1:6])
        where += f" (+{len(layers) - 1}: {more}{' …' if len(layers) > 6 else ''})"
    loss = f" — loss {100 * p['loss']:.1f} %" if p["severity"] == "error" and p["loss"] >= 0.001 else ""
    return f"**{p['kind']}** {where}: {md_cell(p['message'], 260)}{loss}"


def render_md(report, scenes, ranked):
    run = report["run"]
    s = report["summary"]
    L = []
    L.append("# Scene health — what LWE's core silently leaves out, per scene\n")
    L.append("Generated by `src/player/tests/onmachine/scene_health.sh` + `scene_health_report.py` — regenerate, don't "
             "hand-edit. **Report only: nothing here is fixed.** Items are named by Workshop id only; layer names are "
             "the scenes' own.\n")
    L.append(f"- **Run:** {run.get('started', '?')} (report {report['generated']}), commit "
             f"`{run.get('commit') or report['commit']}`, LWE pin `{run.get('pin') or '?'}` (core `{run.get('lwe') or '?'}`), GPU {run.get('gpu') or '?'}; "
             f"{s['total']} scenes from `{run.get('dir', '?')}`.")
    L.append(f"- **How:** one `liascape-scene-worker --lwe-smoke <scene> --seconds {run.get('seconds', 3)}` per scene "
             "(offscreen, paced 30 fps, no audio device) with the core's `WPENGINE_HEALTH` build report (fork patch "
             "0061) gathered into `<results>/scenes/<id>/health.json` beside its PNGs: every object built or dropped "
             "and why, effects left out, shader compile/link errors (layer, effect, shader file), missing assets, "
             "script errors (layer + property), features LWE reports as unsupported, and each drawable layer's canvas "
             "bbox / alpha / finiteness at frames 1 and 31.")
    L.append("- **Classes:** `failed` = no scene (load / renderer build failed, crash, timeout, nothing lit); "
             "`degraded` = at least one error; `clean` = none (layout warnings allowed). `loss` ≈ the share of the "
             "canvas gone, the ranking key (weights in the report script's docstring).\n")
    L.append("## Summary\n")
    L.append("| class | scenes |\n|---|---|")
    for c in CLASSES:
        L.append(f"| {c} | {s[c]} |")
    L.append(f"| **total** | **{s['total']}** |\n")
    L.append(f"{s['clean_with_warnings']} of the clean scenes carry warnings only (a visible layer off the canvas or at "
             "alpha 0 at both frames, a script's own `console.error`, unparsable shader metadata).\n")

    L.append("## Commonest root causes\n")
    L.append("Errors, by the number of scenes they touch. A cause is a normalised signature (line numbers out), so one "
             "fix can clear a row's scenes together.\n")
    L.append("| # | cause | scenes | hits | ids | e.g. |\n|---|---|---|---|---|---|")
    errs = [r for r in report["causes"] if r["severity"] == "error"]
    for i, r in enumerate(errs[:40], 1):
        ex = r["examples"][0] if r["examples"] else {}
        where = ex.get("shader") or ex.get("path") or ex.get("effect_name") or ex.get("property") or ""
        if ex.get("object") is not None:
            where = f"{ex['scene']} layer {ex['object']}" + (f" · {where}" if where else "")
        ids = ", ".join(r["scenes"][:8]) + (" …" if len(r["scenes"]) > 8 else "")
        L.append(f"| {i} | {md_cell(r['cause'], 110)} | {r['scene_count']} | {r['occurrences']} | {ids} | "
                 f"{md_cell(where, 80)} |")
    if len(errs) > 40:
        L.append(f"\n{len(errs) - 40} more error causes in `scene-health.json` (`causes`).")
    warns = [r for r in report["causes"] if r["severity"] != "error"]
    if warns:
        L.append("\nWarnings (they don't make a scene degraded):\n")
        L.append("| cause | scenes | hits |\n|---|---|---|")
        for r in warns[:15]:
            L.append(f"| {md_cell(r['cause'], 110)} | {r['scene_count']} | {r['occurrences']} |")
    L.append("")

    L.append("## Degraded and failed scenes, ranked\n")
    L.append("Failed first, then by `loss`. Each scene's errors, then (⚠, indented) its warnings; a layer is the scene "
             "object's id, type and name; identical problems on several layers are one line. PNGs: "
             "`<results>/scenes/<id>/lwe-smoke-*.png`.\n")
    for n, sc in enumerate(ranked, 1):
        head = f"### {n}. {sc['id']} — {sc['class']}"
        head += f": {sc['failed']}" if sc["failed"] else f", loss ≈ {100 * sc['loss']:.1f} %"
        L.append(head + "\n")
        bits = []
        if sc.get("native"):
            bits.append(f"{sc['native'][0]}×{sc['native'][1]}")
        if sc.get("objects") is not None:
            bits.append(f"{sc.get('built')}/{sc.get('objects')} objects built")
        if sc.get("frame_ms_mean") is not None:
            bits.append(f"frame {sc['frame_ms_mean']:.1f} ms (p95 {sc['frame_ms_p95']:.1f})")
        if sc.get("perspective"):
            bits.append("3D")
        if sc.get("static"):
            bits.append("static over the smoke")
        tally = ", ".join(f"{k} {v}" for k, v in sorted(sc["counts"].items()))
        L.append("- " + "; ".join(bits) + (f" — {tally}" if tally else ""))
        e_lines = collapse([p for p in sc["problems"] if p["severity"] == "error"])
        w_lines = collapse([p for p in sc["problems"] if p["severity"] != "error"])
        for p in e_lines[:20]:
            L.append(f"- {problem_line(p)}")
        if len(e_lines) > 20:
            L.append(f"- … {len(e_lines) - 20} more (scene-health.json)")
        for p in w_lines[:6]:
            L.append(f"  - ⚠ {problem_line(p)}")
        if len(w_lines) > 6:
            L.append(f"  - ⚠ … {len(w_lines) - 6} more warnings")
        L.append("")

    L.append("## Leniency in use\n")
    L.append("Rewrites the core makes so WE's HLSL-era sources and paths load (fork 0016, 0034, 0059 …): not errors, but "
             "the scenes that would break if one regressed.\n")
    L.append("| rewrite | scenes |\n|---|---|")
    for k, v in report["compat"].items():
        L.append(f"| {md_cell(k, 90)} | {len(v)} |")
    if report["fonts_substituted"]:
        L.append("\nScene fonts replaced by another file:\n")
        for f in report["fonts_substituted"]:
            L.append(f"- `{f['requested']}` → `{f['used']}`: {', '.join(f['scenes'])}")
    L.append("")
    clean = [sc for sc in scenes if sc["class"] == "clean"]
    L.append(f"## Clean scenes ({len(clean)})\n")
    L.append(", ".join(sc["id"] + (" ⚠" if sc["warnings"] else "") for sc in clean) + "\n")
    L.append("⚠ = warnings only (in `scene-health.json`).\n")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--report-dir")
    a = ap.parse_args()
    results = os.path.abspath(a.results)
    run = read_json(os.path.join(results, "run.json"), {}) or {}
    sroot = os.path.join(results, "scenes")
    ids = sorted(d for d in os.listdir(sroot) if os.path.isdir(os.path.join(sroot, d))) if os.path.isdir(sroot) else []
    if not ids:
        print("scene_health_report: no scenes in", sroot, file=sys.stderr)
        return 2
    scenes = [analyse(i, os.path.join(sroot, i)) for i in ids]
    by_class = Counter(s["class"] for s in scenes)

    causes = defaultdict(lambda: {"scenes": set(), "occurrences": 0, "kinds": Counter(), "severity": "warning",
                                  "examples": []})
    for s in scenes:
        for p in s["problems"]:
            c = causes[p["cause"]]
            c["scenes"].add(s["id"])
            c["occurrences"] += 1
            c["kinds"][p["kind"]] += 1
            if p["severity"] == "error":
                c["severity"] = "error"
            if len(c["examples"]) < 3 and s["id"] not in {x["scene"] for x in c["examples"]}:
                ex = {"scene": s["id"]}
                for k in ("object", "object_name", "effect_name", "shader", "path", "property"):
                    if p.get(k) is not None:
                        ex[k] = p[k]
                c["examples"].append(ex)
    cause_rows = sorted(
        ({"cause": k, "severity": v["severity"], "scenes": sorted(v["scenes"]), "scene_count": len(v["scenes"]),
          "occurrences": v["occurrences"], "kinds": dict(v["kinds"]), "examples": v["examples"]}
         for k, v in causes.items()),
        key=lambda r: (r["severity"] != "error", -r["scene_count"], -r["occurrences"], r["cause"]),
    )
    compat = defaultdict(set)
    fonts = defaultdict(set)
    for s in scenes:
        for w in s["compat"]:
            compat[w].add(s["id"])
        for f in s["fonts_substituted"]:
            fonts[(f["requested"], f["used"])].add(s["id"])

    ranked = sorted((s for s in scenes if s["class"] != "clean"),
                    key=lambda s: (s["class"] != "failed", -s["loss"], -s["errors"], s["id"]))
    report = {
        "generated": time.strftime("%Y-%m-%d %H:%M %Z"),
        "run": run,
        "commit": git("rev-parse", "--short", "HEAD"),
        "summary": {c: by_class.get(c, 0) for c in CLASSES}
        | {"total": len(scenes), "clean_with_warnings": sum(1 for s in scenes if s["class"] == "clean" and s["warnings"])},
        "causes": cause_rows,
        "compat": {k: sorted(v) for k, v in sorted(compat.items(), key=lambda kv: -len(kv[1]))},
        "fonts_substituted": [{"requested": r, "used": u, "scenes": sorted(v)} for (r, u), v in sorted(fonts.items())],
        "ranked": [s["id"] for s in ranked],
        "scenes": scenes,
    }
    md = render_md(report, scenes, ranked)
    outs = [results] + ([os.path.abspath(a.report_dir)] if a.report_dir else [])
    for d in outs:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "scene-health.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
            f.write("\n")
        with open(os.path.join(d, "scene-health.md"), "w", encoding="utf-8") as f:
            f.write(md)
    print(f"scene_health_report: {report['summary']} → {', '.join(outs)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
