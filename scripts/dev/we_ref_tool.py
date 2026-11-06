#!/usr/bin/env python3
"""Helpers for we-ref-capture.sh (real Wallpaper Engine under Proton, captured headless).

    we_ref_tool.py canvas <scene dir>                       -> "W H kind" (the scene's canvas; kind ortho|auto|video|web)
    we_ref_tool.py config <base config.json> <out> <file> [k=v ...]
                                                            -> WE's config.json with our render settings and the
                                                               user properties for <file> (a Windows path, Z:/…)
    we_ref_tool.py stat <png>                               -> "max mean stddev" of the grey image (black / flat detection)
    we_ref_tool.py jpeg <png> <jpg> <width>                 -> a small JPEG copy (quality 85)
    we_ref_tool.py same <png a> <png b>                     -> "mean_abs_diff max_abs_diff" over RGB (0..255)
    we_ref_tool.py scrgb <scene dir> <run dir>              -> "scrgb N" (N frames re-encoded) or "sdr": an HDR scene's
                                                               frames as Windows shows them (see SCRGB below)
    we_ref_tool.py clock-inject <item dir> <out dir>        -> a private copy of the item whose scene draws WE's own
                                                               scene clock into a strip along the bottom (see CLOCK)
    we_ref_tool.py clock-read <png>...                      -> "<scene seconds>|- <png>" per frame (the strip decoded)
    we_ref_tool.py clock-manifest <run dir>                 -> each shot's / burst frame's scene_time into its manifest
    we_ref_tool.py wall0 <run dir>                          -> WE's wall time (epoch s) when its scene clock read 0

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
    for kv in os.environ.get("WE_REF_SETTINGS", "").splitlines():
        if "=" in kv:
            k, _, v = kv.partition("=")
            g["user"][k] = parse_value(v)
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


# SCRGB. With the "postprocessing" setting at ultra, WE's project classifier (GH 0x14013f860) sets the renderer flag
# 0x2000 for a scene whose general has `bloom` and `hdr` both literally true. With that flag the renderer creates its
# flip-model swap chain as DXGI_FORMAT_R16G16B16A16_FLOAT (GH 0x14015a0f0: format 10, else 0x1c R8G8B8A8_UNORM;
# GH 0x140141520 passes the flag) and never calls SetColorSpace1, and the scene's last pass, combine_hdr (or
# combine_srgb with bloom off), writes lin () of the picture into it (g_RenderVar0.x = 1 on an SDR display,
# GH 0x140141520's defaults at +0x228). Windows takes an FP16 swap chain as scRGB (linear) and, on an SDR display,
# clips it to 0..1 and sRGB-encodes it: the linear write round-trips and the picture looks as composed. DXVK under
# Proton keeps scRGB only when the Vulkan surface offers an HDR colour space; gamescope's headless surface offers
# SRGB_NONLINEAR only (no gamescope WSI layer), so DxgiSwapChain::UpdateColorSpace falls back to G22 and the blit
# copies the linear values into the 8-bit sRGB surface as they are: darker and more saturated. These frames get the
# sRGB encode Windows would have applied (exact up to the 8-bit quantisation of the linear values: banding below
# ~13/255 in the darks). The raw frames stay in <run dir>/fp16-raw/.
SCRGB_NOTE = ("fp16 swap chain (Ultra + bloom + hdr): presented by DXVK as sRGB (linear values shown raw); "
              "the frames are sRGB-encoded after capture, as Windows shows an FP16 (scRGB) swap chain on an SDR display")


def scene_is_fp16(scene_dir):
    _, scene, _ = load_scene_json(scene_dir)
    g = (scene or {}).get("general") or {}
    pp = USER_SETTINGS["postprocessing"]
    for kv in os.environ.get("WE_REF_SETTINGS", "").splitlines():
        k, _, v = kv.partition("=")
        if k == "postprocessing":
            pp = parse_value(v)
    # literal JSON booleans only: a user-property object or a number never turns HDR on (GH 0x14013f170)
    return g.get("bloom") is True and g.get("hdr") is True and pp in ("ultra", "displayhdr")


def cmd_scrgb(scene_dir, rd):
    import glob
    import shutil

    import numpy as np
    from PIL import Image

    if not scene_is_fp16(scene_dir):
        print("sdr")
        return
    raw_dir = os.path.join(rd, "fp16-raw")
    os.makedirs(raw_dir, exist_ok=True)
    lut = np.arange(256) / 255.0
    lut = np.where(lut <= 0.0031308, lut * 12.92, 1.055 * np.power(lut, 1 / 2.4) - 0.055)
    lut = np.clip(np.round(lut * 255), 0, 255).astype(np.uint8)
    mf = os.path.join(rd, "manifest.json")
    # a fresh capture's manifest has no swap_chain yet: its frames are raw (a re-run encodes from fp16-raw/ again)
    fresh = not os.path.exists(mf) or "swap_chain" not in json.load(open(mf))
    n = 0
    for f in sorted(glob.glob(os.path.join(rd, "t*s.png"))):
        raw = os.path.join(raw_dir, os.path.basename(f))
        if fresh or not os.path.exists(raw):
            shutil.copy2(f, raw)
        im = Image.open(raw)
        mode = im.mode
        a = np.asarray(im.convert("RGBA") if mode == "RGBA" else im.convert("RGB")).copy()
        a[..., :3] = lut[a[..., :3]]
        Image.fromarray(a).save(f)
        n += 1
    if os.path.exists(mf):
        m = json.load(open(mf))
        m["swap_chain"] = {"format": "R16G16B16A16_FLOAT", "corrected": "srgb-encode", "raw": "fp16-raw/",
                           "note": SCRGB_NOTE}
        with open(mf, "w") as fh:
            json.dump(m, fh, indent=2)
    print("scrgb", n)


# CLOCK. WE's scene clock isn't the capture's t = 0: at the first frame with a picture it is already 0.15-1.1 s along,
# a different amount every run (the scene's loading). Nothing outside the frames shows it (log.txt has 1 s stamps), so
# the scene shows it itself: the capture opens a private copy of the item (never the Workshop folder) whose scene.json
# has one more layer, drawn last, a strip along the bottom edge of the frame: 26 cells across, a guard cell lit, then
# floor(g_Time * 1000) as 24 bits MSB first, then an unlit guard. Its vertex shader places it in clip space, so camera,
# zoom, shake and parallax never move it. g_Time is the clock everything in the scene runs on: a capture-only test
# scene (we-proton.md "The scene clock") read g_Time, a SceneScript's engine.runtime and the frame side by side and they
# agreed to the ms. The compare crops the strip (and a margin for bloom) off both pictures.
CLOCK_STRIP = 0.012  # of the frame height (13 px of 1080)
CLOCK_CROP = 0.03    # what the compare leaves out at the bottom: the strip and any bloom around it
CLOCK_LIT = 0.5      # a lit cell: grey, under any bloom threshold of an HDR scene and dim for an LDR one
CLOCK_NAME = "liascape_clock"
CLOCK_VERT = """attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
	v_TexCoord = a_TexCoord;
	gl_Position = vec4(a_TexCoord.x * 2.0 - 1.0, -1.0 + %(strip).4f * 2.0 * (1.0 - a_TexCoord.y), 0.0, 1.0);
}
"""
CLOCK_FRAG = """// liascape we-ref capture only: WE's scene clock g_Time (ms) as 24 bits, MSB first, between a lit and an unlit cell
uniform sampler2D g_Texture0; // {"hidden":true}
uniform float g_Time;
varying vec2 v_TexCoord;
void main() {
	float N = floor(g_Time * 1000.0);
	float cell = floor(v_TexCoord.x * 26.0);
	float bit = 0.0;
	if (cell < 0.5) {
		bit = 1.0;
	} else if (cell < 24.5) {
		bit = mod(floor(N / exp2(24.0 - cell)), 2.0);
	}
	gl_FragColor = vec4(bit * %(lit).3f, bit * %(lit).3f, bit * %(lit).3f, 1.0);
}
"""


def write_pkg(path, version, files):
    """files: [(name, bytes)] -> a scene.pkg (the layout read_pkg_entry reads)"""
    def sb(v):
        b = v.encode("utf-8")
        return struct.pack("<I", len(b)) + b
    head = sb(version) + struct.pack("<I", len(files))
    off = 0
    for n, data in files:
        head += sb(n) + struct.pack("<II", off, len(data))
        off += len(data)
    with open(path, "wb") as f:
        f.write(head)
        for _, data in files:
            f.write(data)


def read_pkg(path):
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

    version = s()
    entries = [(s(), u32(), u32()) for _ in range(u32())]
    return version, [(n, data[off + o : off + o + ln]) for n, o, ln in entries]


def cmd_clock_inject(item, out):
    """out: a directory of links to the item's files (its shader blobs left out, so WE compiles them here) with the
    scene (scene.pkg's scene.json, or a loose scene.json) carrying the clock layer. Re-run: the scene is rewritten,
    links that exist are kept (and WE's compiled blobs with them)."""

    proj = json.load(open(os.path.join(item, "project.json"), encoding="utf-8-sig"))
    f = proj.get("file") or "scene.json"
    sname = "scene.json" if f.endswith(".pkg") else f
    pkg = os.path.join(item, "scene.pkg")
    packed = os.path.exists(pkg) and not os.path.exists(os.path.join(item, sname))
    os.makedirs(out, exist_ok=True)
    for root, dirs, files in os.walk(item):
        rel = os.path.relpath(root, item)
        dirs[:] = [d for d in dirs if not (rel == "shaders" and d.startswith("blobs"))]
        os.makedirs(os.path.join(out, rel), exist_ok=True)
        for fn in files:
            if rel == "." and fn in (sname, "scene.pkg"):
                continue
            dst = os.path.join(out, rel, fn)
            if not os.path.lexists(dst):
                os.symlink(os.path.join(root, fn), dst)
    extra = {
        # (not "fullscreen": true — that left 3276522107 all black; its plain layer is drawn under the scene's
        # post-processing letterbox, so that scene's clock goes unread)
        f"models/{CLOCK_NAME}.json": json.dumps({"material": f"materials/{CLOCK_NAME}.json"}).encode(),
        f"materials/{CLOCK_NAME}.json": json.dumps({"passes": [{
            "blending": "translucent", "cullmode": "nocull", "depthtest": "disabled", "depthwrite": "disabled",
            "shader": CLOCK_NAME, "textures": ["util/white"]}]}).encode(),
        f"shaders/{CLOCK_NAME}.vert": (CLOCK_VERT % {"strip": CLOCK_STRIP}).encode(),
        f"shaders/{CLOCK_NAME}.frag": (CLOCK_FRAG % {"lit": CLOCK_LIT}).encode(),
    }
    if packed:
        version, files = read_pkg(pkg)
        raw = dict(files).get(sname) or dict(files)["scene.json"]
    else:
        version, files = None, []
        raw = open(os.path.join(item, sname), "rb").read()
    scene = json.loads(raw.decode("utf-8-sig"))
    w, h = 1920, 1080
    op = (scene.get("general") or {}).get("orthogonalprojection")
    if isinstance(op, dict) and op.get("width") and op.get("height"):
        w, h = op["width"], op["height"]
    # (the shader ignores the layer's bounds; in a perspective scene these are what WE draws the strip with: moving
    # them to the camera's centre lost 3509243656's strip and didn't bring back 3276522107's)
    origin, size = f"{w / 2} {h / 2} 0", f"{w} {h}"
    ids = [o.get("id", 0) for o in scene.get("objects", []) if isinstance(o.get("id"), int)]
    scene.setdefault("objects", []).append({
        "id": max(ids + [0]) + 1, "name": CLOCK_NAME, "image": f"models/{CLOCK_NAME}.json",
        "origin": origin, "size": size, "scale": "1 1 1", "angles": "0 0 0",
        "parallaxDepth": "0 0", "visible": True, "castshadow": False})
    new = json.dumps(scene, ensure_ascii=False, indent="\t").encode("utf-8")
    if packed:
        names = {n for n, _ in files}
        files = [(n, new if n == sname or (n == "scene.json" and sname not in names) else d) for n, d in files]
        files += [(n, d) for n, d in extra.items() if n not in names]
        write_pkg(os.path.join(out, "scene.pkg"), version, files)
    else:
        with open(os.path.join(out, sname), "wb") as fh:
            fh.write(new)
        for n, d in extra.items():
            os.makedirs(os.path.dirname(os.path.join(out, n)), exist_ok=True)
            with open(os.path.join(out, n), "wb") as fh:
                fh.write(d)
    print(out)


def clock_read(path):
    """the strip's scene time in s, or None (no strip, or a cell between levels: a frame mid-blend)"""
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(path).convert("L"), dtype=np.float32)
    H, W = a.shape
    if H < 100 or W < 260:  # gamescope's placeholder before the first frame (1 x 1)
        return None
    sh = CLOCK_STRIP * H
    band = a[int(H - sh * 0.75) : max(int(H - sh * 0.25), int(H - sh * 0.75) + 1)].mean(0)
    cells = [float(band[int((c + 0.3) / 26 * W) : int((c + 0.7) / 26 * W)].mean()) for c in range(26)]
    lit, dark = cells[0], cells[25]
    if not lit - dark >= 40:
        return None
    mid, tol = (lit + dark) / 2, (lit - dark) * 0.3
    n = 0
    for v in cells[1:25]:
        if abs(v - mid) < tol:
            return None
        n = n * 2 + (1 if v > mid else 0)
    return n / 1000.0


def cmd_clock_manifest(rd):
    mf = os.path.join(rd, "manifest.json")
    m = json.load(open(mf))
    n = 0
    for s in m.get("shots", []):
        t = clock_read(os.path.join(rd, "t%gs.png" % float(s["t"])))
        s["scene_time"] = t
        n += t is not None
    for b in m.get("burst", []):
        p = os.path.join(rd, b["file"])
        b["scene_time"] = clock_read(p) if os.path.exists(p) and os.path.getsize(p) else None
    # a frame whose strip is unreadable (a scene fading in from black, 3509243656's intro; a strip under the scene's
    # own letterbox): WE's clock runs at the wall clock's rate (the test scene: the request-to-clock offset held to
    # ±0.03 s over 4 s), so it gets the request time plus the median offset of the frames that were read
    offs = sorted(float(x["scene_time"]) - float(x.get("t_actual", x["t"]))
                  for x in m.get("shots", []) + m.get("burst", []) if x.get("scene_time") is not None and "t_actual" in x)
    offs += sorted(float(b["scene_time"]) - float(b["t"]) for b in m.get("burst", []) if b.get("scene_time") is not None)
    off = sorted(offs)[len(offs) // 2] if offs else None
    for s in m.get("shots", []):
        s.pop("scene_time_estimated", None)
        if s["scene_time"] is None and off is not None:
            s["scene_time"] = round(float(s.get("t_actual", s["t"])) + off, 3)
            s["scene_time_estimated"] = True
    m["scene_clock"] = {"strip": CLOCK_STRIP, "crop": CLOCK_CROP, "read": n, "of": len(m.get("shots", [])),
                        "offset_median": None if off is None else round(off, 3)}
    with open(mf, "w") as fh:
        json.dump(m, fh, indent=2)
    print(n, len(m.get("shots", [])))


def cmd_wall0(rd):
    """WE's wall time (epoch s) when its scene clock read 0: each frame's PNG was written ~0.1 s after the frame its
    strip read (a re-encoded frame's raw copy in fp16-raw/ keeps the capture's mtime); the median over the shots.
    The compare runs ours at it (libfaketime): Wine's clock is the host's."""
    m = json.load(open(os.path.join(rd, "manifest.json")))
    w = []
    for s in m.get("shots", []):
        f = "t%gs.png" % float(s["t"])
        p = os.path.join(rd, "fp16-raw", f)
        p = p if os.path.exists(p) else os.path.join(rd, f)
        st = s.get("scene_time")
        st = float(st) if st is not None else float(s.get("t_actual", s["t"]))
        if os.path.exists(p):
            w.append(os.path.getmtime(p) - 0.1 - st)
    print(round(sorted(w)[len(w) // 2]) if w else "")


def grey_stats(path):
    from PIL import Image, ImageStat

    im = Image.open(path).convert("L")
    st = ImageStat.Stat(im)
    return im.getextrema()[1], st.mean[0], st.stddev[0]


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
        mx, mean, sd = grey_stats(argv[2])
        print(mx, round(mean, 2), round(sd, 2))
    elif c == "jpeg":
        from PIL import Image

        im = Image.open(argv[2]).convert("RGB")
        w = int(argv[4])
        if im.width > w:
            im = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)
        im.save(argv[3], quality=85, optimize=True)
    elif c == "scrgb":
        cmd_scrgb(argv[2], argv[3])
    elif c == "clock-inject":
        cmd_clock_inject(argv[2], argv[3])
    elif c == "clock-read":
        for p in argv[2:]:
            t = clock_read(p)
            print("-" if t is None else "%.3f" % t, p)
    elif c == "clock-manifest":
        cmd_clock_manifest(argv[2])
    elif c == "wall0":
        cmd_wall0(argv[2])
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
