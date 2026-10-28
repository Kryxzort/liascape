#!/usr/bin/env python3
"""Phase 2 Task 13: classify a scene corpus run (scene_corpus.sh) and write the report.

    python3 -I scene_corpus_report.py --results /tmp/liascape-scene-corpus-<stamp> \
        [--dir <workshop folder>] [--report-dir docs/player/reports] [--notes <notes.json>]

Reads the results dir (records.jsonl, events.jsonl, captures/, scene-check.json, hello.json and,
after an owner-run `--ab-legacy`, legacy.jsonl + its screenshots) and writes
scene-corpus.{json,md} into the results dir and, with --report-dir, there too.

Classes, first match wins:
  load_failed      the worker's fatal `load failed: …` (or the source never opened)
  renderer_failed  the worker's fatal `renderer build failed …`
  broken           the restart budget was spent (3 crashes within 60 s, then a 4th)
  timeout          no Ready within the runner's --ready-timeout (default 20 s)
  crashed          Ready, but the worker crashed (restarted) at least once during the run
  blank            the +4 s capture's luma stddev < 2, or >= 99 % of its pixels one colour
  static           the +1 s, +2.3 s and +4 s captures are identical (the off-grid +2.3 s one:
                   a loop whose period divides 3 s repeats its +1 s frame at +4 s)
  ok               everything else

Workshop items are named by id only (never by title). Captures stay in the results dir.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter

import numpy as np
from PIL import Image

CLASSES = [
    "ok",
    "static",
    "blank",
    "load_failed",
    "renderer_failed",
    "crashed",
    "broken",
    "timeout",
]
NOT_OK = [c for c in CLASSES if c != "ok"]
BLANK_STDDEV = 2.0
BLANK_ONE_COLOUR = 0.99
HERE = os.path.dirname(os.path.abspath(__file__))


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def image_stats(path):
    """Luma stddev/mean, the most common colour's share, and the RGB array (for diffs)."""
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)
    f = rgb.astype(np.float32)
    luma = 0.2126 * f[..., 0] + 0.7152 * f[..., 1] + 0.0722 * f[..., 2]
    packed = (
        rgb[..., 0].astype(np.uint32) << 16
        | rgb[..., 1].astype(np.uint32) << 8
        | rgb[..., 2].astype(np.uint32)
    ).ravel()
    _, counts = np.unique(packed, return_counts=True)
    return {
        "luma_mean": round(float(luma.mean()), 2),
        "luma_stddev": round(float(luma.std()), 2),
        "top_colour_share": round(float(counts.max()) / packed.size, 4),
        "size": [int(rgb.shape[1]), int(rgb.shape[0])],
    }, rgb


def is_blank(st):
    return st["luma_stddev"] < BLANK_STDDEV or st["top_colour_share"] >= BLANK_ONE_COLOUR


def project_info(folder):
    p = read_json(os.path.join(folder, "project.json"), {}) or {}
    general = p.get("general") or {}
    props = general.get("properties") or {}
    dep = p.get("dependency")
    return {
        "dependency": str(dep) if dep not in (None, "") else None,
        "supports_audio_processing": bool(general.get("supportsaudioprocessing")),
        "user_properties": len(props) if isinstance(props, dict) else 0,
        "has_scene_pkg": os.path.exists(os.path.join(folder, "scene.pkg")),
        "has_scene_json": os.path.exists(os.path.join(folder, "scene.json")),
    }


# (regex on the log tail / error, cause) — the first that matches names the likely cause.
CAUSE_PATTERNS = [
    (r"does not exist|still downloading", "the item folder is gone or half-downloaded"),
    (r"truncated scene\.pkg|unsupported project", "LWE could not load the project (scene.pkg/scene.json it can't parse)"),
    (r"(?i)terminate called|exception|what\(\)", "an LWE C++ exception while building the scene"),
    (r"(?i)shader.*(error|fail)|(error|fail).*shader|compil", "a shader LWE failed to compile/translate"),
    (r"(?i)cannot find|not found|no such file|missing", "an asset LWE could not find"),
    (r"(?i)unsupported|not supported|not implemented", "a WE feature LWE next-v2 does not implement"),
    (r"(?i)GL error", "an OpenGL error left by LWE's renderer"),
    (r"killed by signal 11|signal 11|SIGSEGV", "a segfault inside LWE (crash)"),
    (r"killed by signal 6|signal 6|SIGABRT", "an abort inside LWE (assert/terminate)"),
    (r"hung", "the worker stopped answering (an LWE hang)"),
]


# LWE prints these for every scene (its Steam-dir probe): never a cause, left out of the report.
NOISE = re.compile(r"Cannot find (appmanifest_431960\.acf|workshop directory for steam app)")


def useful_tail(lines):
    return [l for l in lines or [] if l.strip() and not NOISE.search(l)]


def likely_cause(rec, cls, proj):
    text = "\n".join([rec.get("reason") or ""] + useful_tail(rec.get("log_tail")))
    for pat, cause in CAUSE_PATTERNS:
        if re.search(pat, text):
            hit = cause
            break
    else:
        hit = None
    if proj.get("dependency") and cls != "ok":
        dep = f"depends on Workshop item {proj['dependency']} (LWE next-v2 resolves no project dependency yet)"
        hit = f"{dep}; {hit}" if hit else dep
    if hit:
        return hit
    return {
        "blank": "renders but shows (nearly) one colour — an effect/material LWE draws empty, "
        "or content driven by something not fed headless (audio input, user properties)",
        "static": "renders but nothing changed between +1 s, +2.3 s and +4 s — a still scene by design, "
        "or animation LWE doesn't run (scripts, timeline, particles)",
        "timeout": "no first frame within the timeout (a very slow build, or a hang the "
        "heartbeat didn't catch during the load)",
        "crashed": "the worker crashed and was restarted (see the log tail)",
        "broken": "the worker crashed 4 times within 60 s",
        "load_failed": "LWE refused the project",
        "renderer_failed": "LWE's renderer build failed",
    }.get(cls, "")


def classify(rec, events_by_src, caps_dir):
    w = rec.get("worker") or {}
    m = rec.get("metrics") or w  # rates + GPU time read before the +4 s capture
    src = rec.get("src")
    evs = events_by_src.get(src, [])
    out = {
        "id": rec["id"],
        "outcome": rec.get("outcome"),
        "native": w.get("native"),
        "export": w.get("size"),
        "ready_ms": None,
        "wall_ready_ms": rec.get("wall_ready_ms"),
        "rss_hwm_mib": round(rec["rss_hwm_kib"] / 1024, 1) if rec.get("rss_hwm_kib") else None,
        "vram_mib": rec.get("vram_mib"),
        "gpu_ms_p50": m.get("gpu_ms_p50"),
        "gpu_ms_p95": m.get("gpu_ms_p95"),
        "fps_actual": m.get("fps_actual"),
        "fps_target": m.get("fps_target"),
        "restarts": w.get("total_restarts") or 0,
        "has_audio": (w.get("audio") or {}).get("has_audio"),
        "wants_audio_input": w.get("wants_audio_input"),
        "throttled": m.get("throttle") is not None if m else None,
        "reason": w.get("last_error"),
        "log_tail": w.get("log_tail") or [],
        "capture_errors": rec.get("capture_errors") or [],
    }
    spawned = [e["t_mono_ms"] for e in evs if e.get("event") == "worker.spawned"]
    ready = [e["t_mono_ms"] for e in evs if e.get("event") == "source.ready"]
    if spawned and ready:
        out["ready_ms"] = round(ready[0] - spawned[0], 1)
    if not out["reason"]:
        for e in evs:
            if e.get("event") in ("source.error", "scene.error") and e.get("reason"):
                out["reason"] = e["reason"]
                break
    outcome = rec.get("outcome")
    caps = {}
    for at in ("1s", "2.3s", "4s"):
        p = os.path.join(caps_dir, f"{rec['id']}-{at}.png")
        if os.path.exists(p):
            caps[at] = image_stats(p)
    if outcome in ("create_failed", "open_failed"):
        cls = "load_failed"
    elif outcome == "error":
        cls = "renderer_failed" if "renderer build failed" in (out["reason"] or "") else "load_failed"
    elif outcome == "broken":
        cls = "broken"
    elif outcome == "timeout":
        cls = "timeout"
    elif out["restarts"] > 0:
        cls = "crashed"
    elif not caps:
        cls = "blank"
        out["reason"] = out["reason"] or "Ready, but no capture: " + "; ".join(out["capture_errors"])
    else:
        last = caps.get("4s") or caps.get("1s")
        if is_blank(last[0]):
            cls = "blank"
        elif len(caps) >= 2 and all(
            np.array_equal(c[1], last[1]) for c in caps.values()
        ):
            cls = "static"
        else:
            cls = "ok"
    for a, b, key in (("1s", "4s", "changed_pct"), ("1s", "2.3s", "changed_pct_1_to_2_3")):
        if a in caps and b in caps and caps[a][1].shape == caps[b][1].shape:
            diff = np.any(caps[a][1] != caps[b][1], axis=2)
            out[key] = round(100.0 * float(diff.mean()), 3)
    for at, (st, _) in caps.items():
        out[f"capture_{at}"] = st
    out["class"] = cls
    return out


def legacy_started(rec):
    png = rec.get("screenshot")
    if rec.get("status") != "screenshot" or not png or not os.path.exists(png):
        return False, None
    st, _ = image_stats(png)
    return not is_blank(st), st


def env_info(results):
    def run(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""

    repo = os.path.abspath(os.path.join(HERE, "../../../.."))
    return {
        "commit": run(["git", "-C", repo, "describe", "--always", "--dirty=+dirty", "--exclude=*"]),
        "gpu": run(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"]),
        "scene_check": read_json(os.path.join(results, "scene-check.json")),
        "player_version": (read_json(os.path.join(results, "hello.json")) or {}).get("version"),
        "lwe_rev": read_json(os.path.join(repo, "third_party/lwe/PIN"), {}).get("rev"),
    }


def top(scenes, key, n=10):
    have = [s for s in scenes if isinstance(s.get(key), (int, float))]
    return sorted(have, key=lambda s: s[key], reverse=True)[:n]


def fmt(v, nd=1):
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    if isinstance(v, list):
        return "×".join(str(x) for x in v)
    return str(v)


def median(xs):
    xs = sorted(x for x in xs if isinstance(x, (int, float)))
    if not xs:
        return None
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def write_md(rep, path):
    s = rep["summary"]
    L = []
    a = L.append
    a("# Scene corpus — liascape-player's scene worker over the Workshop library")
    a("")
    a("Phase 2 Task 13. Generated by `src/player/tests/onmachine/scene_corpus.sh` +")
    a("`scene_corpus_report.py` — regenerate, don't hand-edit (hand-written causes live in")
    a("`src/player/tests/onmachine/scene_corpus_notes.json`). Items are named by Workshop id only.")
    a("")
    e = rep["env"]
    a(f"- **Run:** {rep.get('run_started') or '?'} (report {rep['generated']}), commit `{e.get('commit')}`, LWE `{(e.get('lwe_rev') or '')[:12]}`, "
      f"GPU {e.get('gpu') or '?'}; {s['scenes']} scenes in {s.get('run_s') or '?'} s.")
    a("- **Setup:** a private `liascape-player serve --no-supervise --headless --outputs 1920x1080@60 --clock real "
      "--ao null` (release build, own runtime/state/cache dirs, no Wayland/X, PipeWire unreachable, "
      "`LIASCAPE_PLAYER_VRAM_PROBE=none`); one scene at a time (the previous worker reaped first), a cut "
      "onto the output, no preview; Ready ≤ 20 s; captures of the source at Ready +1 s, +2.3 s and +4 s.")
    a("- **Metrics:** `ready_ms` = `worker.spawned` → `source.ready` on the player's log clock "
      "(spawn + EGL + LWE load/build + first frame); RSS = the worker's VmHWM at +4 s; "
      "`gpu_ms_p50` = the worker's `GL_TIME_ELAPSED` median over 2 s (scene + blit into the slot, "
      "30 fps); VRAM = the worker's line in `nvidia-smi`. The machine was shared with other "
      "agents' test suites (GPU and CPU), so times are upper bounds.")
    a("")
    a("## Summary")
    a("")
    a("| class | count |")
    a("|---|---|")
    for c in CLASSES:
        a(f"| {c} | {s['counts'].get(c, 0)} |")
    a(f"| **total** | **{s['scenes']}** |")
    a("")
    a(f"Ready (`ready_ms`, scenes that readied): median {fmt(s.get('ready_ms_median'))} ms, "
      f"max {fmt(s.get('ready_ms_max'))} ms. Worker peak RSS median {fmt(s.get('rss_median_mib'))} MiB; "
      f"`gpu_ms_p50` median {fmt(s.get('gpu_ms_p50_median'), 2)} ms; VRAM median "
      f"{fmt(s.get('vram_median_mib'), 0)} MiB.")
    a("")
    thr = [x for x in rep["scenes"] if x.get("throttled")]
    if thr:
        a("**Throttled by the GPU budget** (Task 8: ≥ 40 % of the GPU and missed frames → the scene's "
          "fps halved; these are ok — the budget doing its job): "
          + ", ".join(f"{x['id']} ({fmt(x['gpu_ms_p50'], 1)} ms/frame, {x['fps_actual']} fps)" for x in thr) + ".")
        a("")
    for title, key, unit, nd in [
        ("Slowest Ready", "ready_ms", "ms", 0),
        ("Biggest worker peak RSS", "rss_hwm_mib", "MiB", 0),
        ("Biggest GPU time per frame (p50)", "gpu_ms_p50", "ms", 2),
        ("Biggest VRAM", "vram_mib", "MiB", 0),
    ]:
        a(f"### {title}")
        a("")
        a(f"| id | {key} ({unit}) | native | class |")
        a("|---|---|---|---|")
        for x in top(rep["scenes"], key):
            a(f"| {x['id']} | {fmt(x[key], nd)} | {fmt(x['native'])} | {x['class']} |")
        a("")
    a("## Every scene")
    a("")
    a("| id | class | ready ms | native | export | RSS MiB | gpu p50 ms | VRAM MiB | changed % +1→+4 s / +1→+2.3 s | audio |")
    a("|---|---|---|---|---|---|---|---|---|---|")
    for x in rep["scenes"]:
        a(f"| {x['id']} | {x['class']} | {fmt(x['ready_ms'], 0)} | {fmt(x['native'])} | {fmt(x['export'])} "
          f"| {fmt(x['rss_hwm_mib'], 0)} | {fmt(x['gpu_ms_p50'], 2)} | {fmt(x['vram_mib'], 0)} "
          f"| {fmt(x.get('changed_pct'), 2)} / {fmt(x.get('changed_pct_1_to_2_3'), 2)} | {'yes' if x.get('has_audio') else 'no' if x.get('has_audio') is False else '–'} |")
    a("")
    a("## Non-ok scenes")
    a("")
    bad = [x for x in rep["scenes"] if x["class"] != "ok"]
    if not bad:
        a("None.")
    for x in bad:
        a(f"### {x['id']} — {x['class']}")
        a("")
        a(f"- **Likely cause:** {x['cause']}")
        if x.get("note"):
            a(f"- **Diagnosis:** {x['note']}")
        if x.get("todo"):
            a(f"- **Follow-up:** {x['todo']}")
        if x.get("reason"):
            a(f"- **Error:** `{x['reason']}`")
        meta = []
        if x.get("project", {}).get("dependency"):
            meta.append(f"depends on {x['project']['dependency']}")
        if x.get("capture_4s"):
            c = x["capture_4s"]
            meta.append(f"+4 s capture luma mean {c['luma_mean']}, stddev {c['luma_stddev']}, "
                        f"top colour {100 * c['top_colour_share']:.1f} %")
        if x.get("changed_pct") is not None:
            meta.append(f"{x['changed_pct']} % of pixels changed +1 s → +4 s, "
                        f"{x.get('changed_pct_1_to_2_3')} % +1 s → +2.3 s")
        if x.get("restarts"):
            meta.append(f"{x['restarts']} restarts")
        if meta:
            a("- " + "; ".join(meta))
        tail = useful_tail(x.get("log_tail"))[-15:]
        if tail:
            a("")
            a("```text")
            for l in tail:
                a(l[:300])
            a("```")
        a("")
    a("## A/B against the legacy engine (`--ab-legacy`)")
    a("")
    lg = rep.get("legacy")
    if not lg:
        a("Not run yet — it takes over the desktop session (the installed `linux-wallpaperengine` draws")
        a("each scene on a real output for ~20 s), so the owner runs it:")
        a("")
        a("```sh")
        a("livepaper --kill   # stop the app's own wallpaper first")
        a("bash src/player/tests/onmachine/scene_corpus.sh --ab-legacy --legacy-output DP-1 \\")
        a("     --reuse /tmp/liascape-scene-corpus-<stamp>   # reuse this run's liascape-player half (or omit to redo it)")
        a("```")
        a("")
        a("It screenshots each scene with LWE's own `--screenshot` (`--screenshot-delay 120` frames),")
        a("classifies a screenshot that isn't blank as \"starts\", rewrites this report with the lists")
        a("below, and kills each LWE it started. Until then **every non-ok scene above counts as")
        a("possibly newly failing** and has a Phase 6 entry in `docs/TODO.md` (§11.5 acceptance).")
    else:
        a(f"Legacy started {lg['started']} of {lg['scenes']}.")
        a("")
        a(f"**Start under legacy but not here ({len(lg['newly_failing'])}):** "
          + (", ".join(lg["newly_failing"]) or "none"))
        a("")
        a(f"**Start here but not under legacy ({len(lg['newly_working'])}):** "
          + (", ".join(lg["newly_working"]) or "none"))
        a("")
        a("| id | legacy | here |")
        a("|---|---|---|")
        for r in lg["rows"]:
            a(f"| {r['id']} | {r['legacy']} | {r['here']} |")
    a("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--dir", default=os.path.expanduser("~/.local/share/Steam/steamapps/workshop/content/431960"))
    ap.add_argument("--report-dir")
    ap.add_argument("--notes", default=os.path.join(HERE, "scene_corpus_notes.json"))
    args = ap.parse_args()
    res = os.path.abspath(args.results)
    records = read_jsonl(os.path.join(res, "records.jsonl"))
    if not records:
        sys.exit(f"no records in {res}/records.jsonl")
    events_by_src = {}
    for e in read_jsonl(os.path.join(res, "events.jsonl")):
        if e.get("id"):
            events_by_src.setdefault(e["id"], []).append(e)
    notes = read_json(args.notes, {}) or {}
    scenes = []
    for rec in records:
        x = classify(rec, events_by_src, os.path.join(res, "captures"))
        x["project"] = project_info(os.path.join(args.dir, rec["id"]))
        x["cause"] = likely_cause(x, x["class"], x["project"])
        n = notes.get(rec["id"]) or {}
        if n.get("cause"):
            x["cause"] = n["cause"]
        if n.get("note"):
            x["note"] = n["note"]
        if n.get("todo"):
            x["todo"] = n["todo"]
        if x["class"] == "ok":
            x.pop("log_tail", None)
        else:
            x["log_tail"] = useful_tail(x.get("log_tail"))
        scenes.append(x)
    counts = Counter(x["class"] for x in scenes)
    t0 = [r.get("t0_unix_ms") for r in records if r.get("t0_unix_ms")]
    run_s = round((max(t0) - min(t0)) / 1000 + 5) if t0 else None
    summary = {
        "scenes": len(scenes),
        "counts": {c: counts.get(c, 0) for c in CLASSES},
        "run_s": run_s,
        "ready_ms_median": median([x["ready_ms"] for x in scenes]),
        "ready_ms_max": max([x["ready_ms"] for x in scenes if x["ready_ms"] is not None], default=None),
        "rss_median_mib": median([x["rss_hwm_mib"] for x in scenes]),
        "gpu_ms_p50_median": median([x["gpu_ms_p50"] for x in scenes]),
        "vram_median_mib": median([x["vram_mib"] for x in scenes]),
        "slowest_ready": [x["id"] for x in top(scenes, "ready_ms", 5)],
        "biggest_rss": [x["id"] for x in top(scenes, "rss_hwm_mib", 5)],
        "biggest_gpu": [x["id"] for x in top(scenes, "gpu_ms_p50", 5)],
        "not_ok": [x["id"] for x in scenes if x["class"] != "ok"],
        "throttled": [x["id"] for x in scenes if x.get("throttled")],
    }
    rep = {
        "generated": time.strftime("%Y-%m-%d %H:%M %Z"),
        "run_started": time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(min(t0) / 1000)) if t0 else None,
        "env": env_info(res),
        "summary": summary,
        "scenes": scenes,
    }
    legacy = read_jsonl(os.path.join(res, "legacy.jsonl"))
    if legacy:
        here = {x["id"]: x["class"] for x in scenes}
        rows = []
        for r in legacy:
            started, _ = legacy_started(r)
            rows.append({"id": r["id"], "legacy": "starts" if started else r.get("status"),
                         "here": here.get(r["id"], "–"), "legacy_log_tail": r.get("log_tail")})
        ours_start = {"ok", "static"}
        rep["legacy"] = {
            "scenes": len(rows),
            "started": sum(1 for r in rows if r["legacy"] == "starts"),
            "newly_failing": [r["id"] for r in rows if r["legacy"] == "starts" and r["here"] not in ours_start],
            "newly_working": [r["id"] for r in rows if r["legacy"] != "starts" and r["here"] in ours_start],
            "rows": rows,
        }
    for d in [res] + ([os.path.abspath(args.report_dir)] if args.report_dir else []):
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "scene-corpus.json"), "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=1, ensure_ascii=False)
            f.write("\n")
        write_md(rep, os.path.join(d, "scene-corpus.md"))
    print(json.dumps({"counts": summary["counts"], "not_ok": summary["not_ok"]}))


if __name__ == "__main__":
    main()
