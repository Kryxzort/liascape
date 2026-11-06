#!/usr/bin/env python3
"""Helpers for we-ref-capture.sh (real Wallpaper Engine under Proton, captured headless).

    we_ref_tool.py canvas <scene dir>                       -> "W H kind" (the scene's canvas; kind ortho|auto|video|web)
    we_ref_tool.py config <base config.json> <out> <file> [k=v ...]
                                                            -> WE's config.json with our render settings and the
                                                               user properties for <file> (a Windows path, Z:/…)
    we_ref_tool.py stat <png>                               -> "max mean" of the grey image (black detection)
    we_ref_tool.py jpeg <png> <jpg> <width>                 -> a small JPEG copy (quality 85)
    we_ref_tool.py same <png a> <png b>                     -> "mean_abs_diff max_abs_diff" over RGB (0..255)

Scene canvas: scene.json's general.orthogonalprojection {width, height} (read from scene.pkg when packed);
"auto" or a perspective-only scene gets 1920 x 1080. Nothing here touches the network or the Steam install.
"""

import json
import os
import struct
import sys

# What we render with: the owner's WE preset (Ultra everywhere; MSAA x8 as on their Windows install), paced at
# 30 fps like the scene worker, nothing paused by "another app is fullscreen" (the capture window is), no media
# integration (no host media leaks in), verbose log.
USER_SETTINGS = {
    "preset": "ultra",
    "postprocessing": "ultra",
    "shadows": "ultra",
    "volumetrics": "ultra",
    "reflection": True,
    "msaa": "x8",
    "fps": 30,
    "resolution": "full",
    "playbackaudio": "run",
    "playbackfocus": "run",
    "playbackfullscreen": "run",
    "playbackmaximized": "run",
    "playbackonbattery": "run",
    "playbacksleep": "run",
    "pausevram": False,
    "mediaintegration": False,
    "loglevel": "verbose",
    "autostart": False,
    "hasshownwelcomedialog": True,
    "anticrash": False,
    "safemode": False,
}


def read_pkg_entry(path, name):
    with open(path, "rb") as f:
        data = f.read()
    off = 0

    def u32():
        nonlocal off
        (v,) = struct.unpack_from("<I", data, off)
        off += 4
        return v

    def s():
        nonlocal off
        n = u32()
        v = data[off : off + n]
        off += n
        return v.decode("utf-8", "replace")

    s()  # "PKGV00xx"
    count = u32()
    entries = []
    for _ in range(count):
        entries.append((s(), u32(), u32()))
    base = off
    for n, o, ln in entries:
        if n == name:
            return data[base + o : base + o + ln]
    return None


def load_scene_json(scene_dir):
    proj = json.load(open(os.path.join(scene_dir, "project.json"), encoding="utf-8-sig"))
    kind = (proj.get("type") or "").lower()
    f = proj.get("file") or "scene.json"
    if kind != "scene":
        return proj, None, kind
    p = os.path.join(scene_dir, f)
    if os.path.exists(p) and not f.endswith(".pkg"):
        return proj, json.load(open(p, encoding="utf-8-sig")), kind
    pkg = os.path.join(scene_dir, "scene.pkg")
    if os.path.exists(pkg):
        raw = read_pkg_entry(pkg, f if not f.endswith(".pkg") else "scene.json")
        if raw is None:
            raw = read_pkg_entry(pkg, "scene.json")
        if raw is not None:
            return proj, json.loads(raw.decode("utf-8-sig", "replace")), kind
    return proj, None, kind


def cmd_canvas(scene_dir):
    proj, scene, kind = load_scene_json(scene_dir)
    w, h, how = 1920, 1080, kind or "unknown"
    if scene is not None:
        op = (scene.get("general") or {}).get("orthogonalprojection")
        if isinstance(op, dict) and op.get("width") and op.get("height") and not op.get("auto"):
            w, h, how = int(op["width"]), int(op["height"]), "ortho"
        else:
            how = "auto"
    print(w, h, how)


def parse_value(v):
    try:
        return json.loads(v)
    except ValueError:
        return v


def cmd_config(base, out, wfile, kvs):
    c = json.load(open(base, encoding="utf-8-sig"))
    c.pop("?installdirectory", None)
    users = [k for k, v in c.items() if isinstance(v, dict)]
    if "steamuser" not in users:
        # a Windows-side config: keep only the general block of its first user, renamed for Proton's user
        src = c[users[0]] if users else {"general": {}}
        c = {"steamuser": {"general": src.get("general", {}), "version": src.get("version", 1)}}
    u = c["steamuser"]
    g = u.setdefault("general", {})
    g.setdefault("user", {}).update(USER_SETTINGS)
    g["user"]["fps"] = int(os.environ.get("WE_REF_FPS", "30"))
    g["wallpaperconfig"] = {"layout": 0, "profile": None, "selectedwallpapers": {}}
    g["playlists"] = []
    props = {}
    for kv in kvs:
        k, _, v = kv.partition("=")
        props[k] = parse_value(v)
    u["wproperties"] = {}
    if props:
        # WE reads a wallpaper's user properties at load from wproperties[<file>][<location>]; the location is
        # the window name for -playInWindow ("Ref") and MonitorN on a desktop — write both. applyProperties on a
        # running window is ignored without the UI, so props are config + a fresh start.
        # keyed by the wallpaper's file (the UI writes <dir>/scene.pkg); written for every name it may use
        d = wfile.rsplit("/", 1)[0]
        for f in {wfile, d + "/project.json", d + "/scene.pkg", d + "/scene.json"}:
            u["wproperties"][f] = {"Ref": dict(props), "Monitor0": dict(props)}
    with open(out, "w") as f:
        json.dump(c, f, indent="\t")


def grey_stats(path):
    from PIL import Image, ImageStat

    im = Image.open(path).convert("L")
    st = ImageStat.Stat(im)
    return im.getextrema()[1], st.mean[0]


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    c = argv[1]
    if c == "canvas":
        cmd_canvas(argv[2])
    elif c == "config":
        cmd_config(argv[2], argv[3], argv[4], argv[5:])
    elif c == "stat":
        mx, mean = grey_stats(argv[2])
        print(mx, round(mean, 2))
    elif c == "jpeg":
        from PIL import Image

        im = Image.open(argv[2]).convert("RGB")
        w = int(argv[4])
        if im.width > w:
            im = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)
        im.save(argv[3], quality=85, optimize=True)
    elif c == "same":
        import numpy as np
        from PIL import Image

        a = np.asarray(Image.open(argv[2]).convert("RGB"), dtype=np.int16)
        b = np.asarray(Image.open(argv[3]).convert("RGB"), dtype=np.int16)
        if a.shape != b.shape:
            print("shape", a.shape, b.shape)
            return 1
        d = np.abs(a - b)
        print(round(float(d.mean()), 3), int(d.max()))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
