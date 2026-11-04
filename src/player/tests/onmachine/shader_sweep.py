#!/usr/bin/env python3
"""Shader sweep: compile every shader WE ships and every custom shader in the Workshop library through LWE's own
pipeline (the core's preprocessing, glslang + SPIRV-Cross, the GL compile and link), without rendering.

    python3 src/player/tests/onmachine/shader_sweep.py --work DIR [--bin DIR] [--assets DIR] [--dir WORKSHOP]
                                                       [--sample N] [--seed S] [--only ID,…] [--no-stock]
                                                       [--compare OLD.jsonl] [--report FILE.md]

It writes `<work>/request.json` (the checks), runs `liascape-scene-worker --shader-sweep` one process per scene (a
check that crashes the driver is recorded as `stage: crash` and the rest go on), and writes `<work>/results.jsonl`
plus a summary (`<work>/summary.md`, or `--report`). `--compare` puts an earlier results file beside it: failures
fixed, still failing, newly failing.

Which shaders: stock = `assets/shaders/**` and `assets/effects/*/shaders/**` (every .frag with its .vert), compiled
from a synthetic project in `<work>/stock` holding a copy of the effects' shader folders as its own `shaders/`; custom =
every `shaders/**` .frag/.vert pair in each Workshop scene's `scene.pkg` or folder, from that scene (its own copy wins
over the assets', as when the scene loads). A shader whose files are byte-identical to one already queued (the same
name and text in another scene) is checked once.

Which combos (per shader): none (the metadata's defaults); every single combo set to each of its other values (the
`options` it declares, else 0/1, at most 6 each; a texture-slot combo through its slot); every combination the library
uses for it (material passes and effect passes in the scene and its effects, and the scene's per-instance pass
overrides); and `--sample` (default 4) random combinations of all its combos.
"""

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
DEFAULT_ASSETS = Path("/@steam/SteamLibrary/steamapps/common/wallpaper_engine/assets")
DEFAULT_DIR = Path.home() / ".local/share/Steam/steamapps/workshop/content/431960"
MAX_VALUES = 6


def pkg_files(pkg):
    """{name: bytes} of a scene.pkg (PKGV)"""
    out = {}
    with open(pkg, "rb") as f:
        def s():
            n = struct.unpack("<I", f.read(4))[0]
            return f.read(n).decode("utf-8", "replace")
        s()
        count = struct.unpack("<I", f.read(4))[0]
        entries = []
        for _ in range(count):
            name = s()
            off, size = struct.unpack("<II", f.read(8))
            entries.append((name, off, size))
        base = f.tell()
        for name, off, size in entries:
            if name.endswith((".frag", ".vert", ".h", ".json", ".geom")):
                f.seek(base + off)
                out[name] = f.read(size)
    return out


class Files:
    """a scene's text files (pkg + folder) over the assets', as the core's container mounts them"""

    def __init__(self, scene, assets, extra_shader_roots=()):
        self.own = {}
        if scene is not None:
            pkg = scene / "scene.pkg"
            if pkg.exists():
                try:
                    self.own.update(pkg_files(pkg))
                except Exception as e:  # a broken pkg: the folder still counts
                    print(f"shader_sweep: {pkg}: {e}", file=sys.stderr)
            for p in scene.rglob("*"):
                if p.is_file() and p.suffix in (".frag", ".vert", ".h", ".json", ".geom"):
                    self.own.setdefault(str(p.relative_to(scene)), None)
        self.scene = scene
        self.assets = assets
        self.extra = extra_shader_roots

    def read(self, name):
        if name in self.own:
            data = self.own[name]
            if data is None:
                data = (self.scene / name).read_bytes()
            return data.decode("utf-8", "replace")
        for root in self.extra:
            if name.startswith("shaders/") and (root / name[len("shaders/"):]).is_file():
                return (root / name[len("shaders/"):]).read_text("utf-8", "replace")
        p = self.assets / name
        if p.is_file():
            return p.read_text("utf-8", "replace")
        return None


def lenient_json(text):
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r'"combo"\s*:\s*"([^"]+)"', text)
    if not m:
        return None
    d = {"combo": m.group(1)}
    m2 = re.search(r'"default"\s*:\s*(-?\d+)', text)
    if m2:
        d["default"] = int(m2.group(1))
    return d


def declared_combos(files, shader):
    """{COMBO: [values]} the shader's units (and their includes) declare, with sampler slots for texture combos"""
    combos, slots = {}, {}
    seen = set()

    def scan(name):
        if name in seen:
            return
        seen.add(name)
        text = files.read(name)
        if text is None:
            return
        for line in text.splitlines():
            inc = re.match(r'\s*#include\s+"([^"]+)"', line)
            if inc:
                scan("shaders/" + inc.group(1))
                continue
            m = re.search(r"//\s*\[COMBO\]\s*(\{.*)", line)
            if m:
                d = lenient_json(m.group(1))
                if d and isinstance(d.get("combo"), str):
                    values = set()
                    opts = d.get("options")
                    if isinstance(opts, dict):
                        values |= {v for v in opts.values() if isinstance(v, int)}
                    elif isinstance(opts, list):
                        values |= set(range(len(opts)))
                    if not values:
                        values = {0, 1}
                    if isinstance(d.get("default"), int):
                        values.add(d["default"])
                    combos.setdefault(d["combo"], set()).update(values)
                continue
            u = re.match(r"\s*uniform\s+sampler2D\w*\s+g_Texture(\d+)\s*;\s*//\s*(\{.*)", line)
            if u:
                d = lenient_json(u.group(2))
                if d and isinstance(d.get("combo"), str):
                    combos.setdefault(d["combo"], set()).update({0, 1})
                    slots[d["combo"]] = int(u.group(1))

    scan(f"shaders/{shader}.frag")
    scan(f"shaders/{shader}.vert")
    return {k: sorted(v)[: MAX_VALUES + 1] for k, v in combos.items()}, slots


def used_combos(files):
    """{shader: [(combos, textures)]} the scene's materials, effects and objects use"""
    out = defaultdict(list)

    def load(name):
        text = files.read(name)
        if text is None:
            return None
        try:
            return json.loads(text)
        except Exception:
            return None

    def material(name, combos=None, textures=None):
        m = load(name)
        if not isinstance(m, dict):
            return
        for i, p in enumerate(m.get("passes") or []):
            if not isinstance(p, dict) or not isinstance(p.get("shader"), str):
                continue
            c = {k.upper(): v for k, v in (p.get("combos") or {}).items() if isinstance(v, int)}
            t = [j for j, x in enumerate(p.get("textures") or []) if x]
            if combos and i < len(combos):
                c.update({k.upper(): v for k, v in (combos[i] or {}).items() if isinstance(v, int)})
            if textures and i < len(textures):
                t = sorted(set(t) | {j for j, x in enumerate(textures[i] or []) if x})
            out[p["shader"]].append((c, t))

    names = [n for n in files.own if n.endswith(".json")]
    for n in names:
        if n.startswith("materials/"):
            material(n)
    scene = load("scene.json")
    effect_files = {n for n in names if n.endswith("effect.json")}
    for obj in (scene or {}).get("objects", []) if isinstance(scene, dict) else []:
        if not isinstance(obj, dict):
            continue
        for eff in obj.get("effects") or []:
            if not isinstance(eff, dict) or not isinstance(eff.get("file"), str):
                continue
            effect_files.add(eff["file"])
            e = load(eff["file"])
            passes = eff.get("passes") or []
            for i, ep in enumerate((e or {}).get("passes") or [] if isinstance(e, dict) else []):
                if isinstance(ep, dict) and isinstance(ep.get("material"), str):
                    over = passes[i] if i < len(passes) and isinstance(passes[i], dict) else {}
                    material(ep["material"], [over.get("combos")], [over.get("textures")])
    for n in effect_files:
        e = load(n)
        for ep in (e or {}).get("passes") or [] if isinstance(e, dict) else []:
            if isinstance(ep, dict) and isinstance(ep.get("material"), str):
                material(ep["material"], [ep.get("combos")])
    return out


def checks_for(files, shader, used, rng, sample):
    combos, slots = declared_combos(files, shader)
    checks = [{"shader": shader, "combos": {}, "why": "default"}]
    for name, values in sorted(combos.items()):
        for v in values:
            # a texture-slot combo is only ever defined as 1, with its texture (the core leaves it out otherwise)
            if name in slots and v != 1:
                continue
            c = {"shader": shader, "combos": {name: v}, "why": f"toggle {name}={v}"}
            if name in slots and v:
                c["textures"] = [slots[name]]
            checks.append(c)
    seen = {json.dumps(c["combos"], sort_keys=True) for c in checks}
    for c, t in used.get(shader, []):
        key = json.dumps(c, sort_keys=True)
        if key not in seen:
            seen.add(key)
            checks.append({"shader": shader, "combos": c, "textures": t, "why": "used"})
    if combos:
        for _ in range(sample):
            c = {k: rng.choice(v) for k, v in sorted(combos.items())}
            c = {k: v for k, v in c.items() if k not in slots or v == 1}
            key = json.dumps(c, sort_keys=True)
            if key not in seen:
                seen.add(key)
                t = [slots[k] for k, v in c.items() if k in slots and v]
                checks.append({"shader": shader, "combos": c, "textures": t, "why": "sample"})
    return checks


def shader_names(names):
    frags = {n[len("shaders/"):-5] for n in names if n.startswith("shaders/") and n.endswith(".frag")}
    verts = {n[len("shaders/"):-5] for n in names if n.startswith("shaders/") and n.endswith(".vert")}
    return sorted(n for n in frags & verts if not n.startswith("HLSL/"))


def stock_project(work, assets):
    """a project whose shaders/ holds a copy of every stock effect's shader files (its own copies of the assets' shaders win)"""
    root = work / "stock"
    (root / "shaders").mkdir(parents=True, exist_ok=True)
    (root / "project.json").write_text(json.dumps({"title": "shader sweep (stock)", "type": "scene", "file": "scene.json", "general": {}}))
    (root / "scene.json").write_text(json.dumps({
        "camera": {"center": "0 0 -1", "eye": "0 0 0", "up": "0 1 0"},
        "general": {"clearcolor": "0 0 0", "orthogonalprojection": {"width": 64, "height": 32}},
        "objects": []}))
    names = set()
    for eff in sorted((assets / "effects").glob("*/shaders")):
        for p in eff.rglob("*"):
            if p.is_file():
                rel = p.relative_to(eff)
                link = root / "shaders" / rel
                link.parent.mkdir(parents=True, exist_ok=True)
                if not link.exists():
                    shutil.copyfile(p, link)  # the core's folder adapter doesn't follow symlinks
                names.add("shaders/" + str(rel))
    for p in (assets / "shaders").rglob("*"):
        if p.is_file():
            names.add("shaders/" + str(p.relative_to(assets / "shaders")))
    return root, names


def build_request(args, work):
    rng = random.Random(args.seed)
    jobs = []
    seen = set()
    if not args.no_stock:
        root, names = stock_project(work, args.assets)
        files = Files(root, args.assets)
        used = defaultdict(list)
        for eff in sorted((args.assets / "effects").glob("*")):
            ef = Files(eff, args.assets)
            for k, v in used_combos(ef).items():
                used[k] += v
        for k, v in used_combos(Files(None, args.assets)).items():
            used[k] += v
        checks = []
        for shader in shader_names(names):
            for c in checks_for(files, shader, used, rng, args.sample):
                c["origin"] = "stock"
                c["combos_asked"] = dict(c["combos"])
                checks.append(c)
        jobs.append({"scene": str(root), "checks": checks})
    only = set(args.only.split(",")) if args.only else None
    lib_used = defaultdict(list)
    scenes = []
    for d in sorted(args.dir.iterdir()):
        if only and d.name not in only:
            continue
        if not (d / "project.json").is_file() or not ((d / "scene.pkg").is_file() or (d / "scene.json").is_file()):
            continue
        files = Files(d, args.assets)
        scenes.append((d, files))
        for k, v in used_combos(files).items():
            lib_used[k] += v
    for d, files in scenes:
        checks = []
        for shader in shader_names(files.own):
            text = (files.read(f"shaders/{shader}.frag") or "") + "\0" + (files.read(f"shaders/{shader}.vert") or "")
            key = hashlib.sha1((shader + "\0" + text).encode()).hexdigest()
            if key in seen:
                continue
            seen.add(key)
            for c in checks_for(files, shader, lib_used, rng, args.sample):
                c["origin"] = d.name
                c["combos_asked"] = dict(c["combos"])
                checks.append(c)
        if checks:
            jobs.append({"scene": str(d), "checks": checks})
    return {"jobs": jobs}


def run(args, work, request):
    results = work / "results.jsonl"
    results.write_text("")
    worker = args.bin / "liascape-scene-worker"
    env = dict(os.environ)
    env.pop("WPENGINE_HEALTH", None)
    for job in request["jobs"]:
        todo = list(job["checks"])
        while todo:
            part = work / "job.json"
            part.write_text(json.dumps({"jobs": [{"scene": job["scene"], "checks": todo}]}))
            out = work / "job.jsonl"
            out.write_text("")
            t0 = time.time()
            p = subprocess.run([str(worker), "--shader-sweep", str(part), "--assets", str(args.assets), "--out", str(out)],
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3600)
            lines = [l for l in out.read_text().splitlines() if l.strip()]
            with results.open("a") as f:
                for l in lines:
                    f.write(l + "\n")
            done = len(lines)
            if p.returncode == 0 or done >= len(todo):
                if p.returncode != 0 and not lines:
                    pass
                break
            if lines and json.loads(lines[-1]).get("stage") == "project":
                break
            crashed = dict(todo[done])
            crashed.update({"scene": job["scene"], "ok": False, "stage": "crash", "message": f"worker exit {p.returncode}"})
            with results.open("a") as f:
                f.write(json.dumps(crashed) + "\n")
            todo = todo[done + 1:]
        print(f"shader_sweep: {Path(job['scene']).name}: {len(job['checks'])} checks", file=sys.stderr)
    return results


def signature(r):
    msg = r.get("message") or ""
    first = next((l for l in msg.splitlines() if "ERROR" in l or "error" in l), msg.splitlines()[0] if msg else "")
    first = re.sub(r"^ERROR: 0:\d+: ", "", first)
    first = re.sub(r"^0\(\d+\) : ", "", first)
    first = re.sub(r"\d+", "N", first)
    return f"{r.get('stage')}: {first.strip()[:140]}"


def key(r):
    return (r.get("origin"), r.get("shader"), json.dumps(r.get("combos_requested", r.get("combos_in", {})), sort_keys=True), r.get("why"))


def load_results(path):
    out = []
    for l in Path(path).read_text().splitlines():
        if l.strip():
            out.append(json.loads(l))
    return out


def report(results, compare, out):
    rows = load_results(results)
    fails = [r for r in rows if not r.get("ok")]
    by_shader = {(r.get("origin"), r.get("shader")) for r in rows}
    bad_shader = {(r.get("origin"), r.get("shader")) for r in fails}
    lines = ["# Shader sweep", "",
             f"{len(rows)} checks of {len(by_shader)} shaders ({sum(1 for s in by_shader if s[0] == 'stock')} stock); "
             f"{len(fails)} checks failed, in {len(bad_shader)} shaders.", ""]
    compat = Counter(c for r in rows for c in set(r.get("compat") or []))
    if compat:
        lines += ["| rewrite applied | checks |", "|---|---|"] + [f"| {k} | {v} |" for k, v in compat.most_common()] + [""]
    sig = defaultdict(list)
    for r in fails:
        sig[signature(r)].append(r)
    lines += ["| cause | checks | shaders | e.g. |", "|---|---|---|---|"]
    for s, rs in sorted(sig.items(), key=lambda x: -len(x[1])):
        sh = sorted({(r.get('origin'), r.get('shader')) for r in rs})
        eg = ", ".join(f"{o}:{n}" for o, n in sh[:3])
        lines.append(f"| {s.replace('|', '/')} | {len(rs)} | {len(sh)} | {eg} |")
    if compare:
        old = load_results(compare)
        def k(r):
            return (r.get("origin"), r.get("shader"), r.get("why"), json.dumps(r.get("combos_asked", {}), sort_keys=True),
                    json.dumps(r.get("textures") or [], sort_keys=True))
        oldf = {k(r) for r in old if not r.get("ok")}
        newf = {k(r) for r in fails}
        old_bad = {(r.get("origin"), r.get("shader")) for r in old if not r.get("ok")}
        lines += ["", f"Compared with `{compare}`: {len(old)} checks, {len(oldf)} failed in {len(old_bad)} shaders before; "
                  f"{len(oldf - newf)} fixed, {len(oldf & newf)} still failing, {len(newf - oldf)} newly failing.", ""]
        for r in fails:
            if k(r) not in oldf:
                lines.append(f"- NEW: {r.get('origin')}:{r.get('shader')} {r.get('why')}: {signature(r)}")
    lines += ["", "## Failing shaders", ""]
    for (o, n) in sorted(bad_shader):
        rs = [r for r in fails if (r.get("origin"), r.get("shader")) == (o, n)]
        lines.append(f"- {o}:{n} — {len(rs)} checks; {signature(rs[0])} ({rs[0].get('why')})")
    Path(out).write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:40]))


def debug(args):
    """--debug SCENE SHADER [COMBOS-JSON]: one check, its error with the source lines it points at"""
    scene, shader = args.debug[0], args.debug[1]
    combos = json.loads(args.debug[2]) if len(args.debug) > 2 else {}
    if scene == "stock":
        scene = str(stock_project(args.work, args.assets)[0])
    elif not scene.startswith("/"):
        scene = str(args.dir / scene)
    req = args.work / "debug.json"
    req.write_text(json.dumps({"jobs": [{"scene": scene, "checks": [{"shader": shader, "combos": combos, "source": True}]}]}))
    out = args.work / "debug.jsonl"
    subprocess.run([str(args.bin / "liascape-scene-worker"), "--shader-sweep", str(req), "--assets", str(args.assets), "--out", str(out)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = json.loads(out.read_text().splitlines()[0])
    for unit in ("vertex", "fragment"):
        (args.work / f"debug.{unit}.glsl").write_text(r.get(f"{unit}_source", ""))
        (args.work / f"debug.{unit}.out.glsl").write_text(r.get(f"{unit}_glsl", ""))
    print(json.dumps({k: v for k, v in r.items() if not k.endswith(("_source", "_glsl"))}, indent=1, ensure_ascii=False))
    unit = r.get("unit") or "vertex"
    src = r.get(f"{unit}_{'glsl' if r.get('stage') == 'gl' else 'source'}", "").split("\n")
    for m in re.finditer(r"0[:(](\d+)[:)]", r.get("message") or ""):
        n = int(m.group(1))
        print(f"--- {unit} line {n}")
        for i in range(max(0, n - 4), min(len(src), n + 2)):
            print(f"{i + 1:5} {src[i]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug", nargs="+", metavar="ARG")
    ap.add_argument("--work", type=Path, required=True)
    ap.add_argument("--bin", type=Path, default=REPO / "src/player/target/release")
    ap.add_argument("--assets", type=Path, default=DEFAULT_ASSETS)
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    ap.add_argument("--sample", type=int, default=4)
    ap.add_argument("--seed", type=int, default=431960)
    ap.add_argument("--only")
    ap.add_argument("--no-stock", action="store_true")
    ap.add_argument("--report-only", action="store_true", help="re-report <work>/results.jsonl")
    ap.add_argument("--compare", type=Path)
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)
    if args.debug:
        return debug(args)
    results = args.work / "results.jsonl"
    if not args.report_only:
        request = build_request(args, args.work)
        (args.work / "request.json").write_text(json.dumps(request))
        print(f"shader_sweep: {sum(len(j['checks']) for j in request['jobs'])} checks in {len(request['jobs'])} jobs", file=sys.stderr)
        results = run(args, args.work, request)
    report(results, args.compare, args.report or args.work / "summary.md")


if __name__ == "__main__":
    main()
