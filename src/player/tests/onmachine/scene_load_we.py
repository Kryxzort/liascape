#!/usr/bin/env python3
"""How fast a scene switch is: real Wallpaper Engine under Proton against ours, request to the new scene's first
frame on screen and to its complete picture, timed by the same frame detector on both.

    bash scripts/test-lock.sh python3 src/player/tests/onmachine/scene_load_we.py we \
        --scene 3042492564 [--scene …] [--cold 10] [--boot 10] [--warm 10] [--fps 60] [--period S] [--out DIR]
    bash scripts/test-lock.sh python3 src/player/tests/onmachine/scene_load_we.py ours \
        --scene 3042492564 [--scene …] [--cold 10] [--boot 10] [--warm 10] [--fps 60] [--spare] [--no-capture] [--bin DIR] [--out DIR]
    python3 src/player/tests/onmachine/scene_load_we.py summary DIR [DIR …]

Both start on the same probe scene A (`<we-ref>/probe-scenes/loadprobe`, written here: a flat magenta clear colour
and WE's scene clock as a strip along the bottom, so every frame A renders differs from the last) and switch to the
Workshop scene B. Per switch, on one monotonic clock:
  first     the first frame that is neither A nor flat (black, Wine's window background): B's first frame, or the
            first frame of a crossfade into it — the transition's start
  complete  the first frame with at most 3 % of the tiles (24 x 15) where B's settled picture (4 s after `first`) has
            content still empty (flat): late textures and videos are in (an intro zoom never empties a tile)
  settle    (informational) the first frame within the noise floor of the settled picture: an intro zoom counts
  a_last    the last frame of A whose clock strip moved (A still rendering)
Frames: WE's are read from its window on gamescope's Xwayland with MIT-SHM (XShmGetImage + the reduction ~2.5 ms,
one every --period, default 4 ms; a run at 50 ms shows what the reads cost WE); ours with the player's own `capture`
of the output (the last composed frame, a PNG into /dev/shm, back to back, reduced on another thread). Each detector
time is the read that first saw the frame; the frame was there no earlier than the read before it (`first_prev`).

we    The we-ref setup (scripts/dev/we-ref-capture.sh: its WE farm, prefix, Proton, config; run `--setup` once),
      in a headless gamescope at 1920x1080, WE at --fps. B opens from a farm of the item (`<we-ref>/load-ws/<id>`,
      symlinks; WE writes the item's own compiled shaders there, never into the Workshop folder; the rest go to
      the WE farm's `assets/shaders/blobsSM50`). A scene WE crashes on (a new minidump: video textures under
      Proton) is recorded once and skipped. The switch is WE's own
      `-control openWallpaper`, sent by a second wallpaper64.exe run in the session's container (nsenter) and wine
      server, as the UI does. t0 (`req`) = that sender's start; `opened` = WE's first open of B's project.json
      (inotify on the Workshop folder) — WE has the request; times are given from both. Sender start → open is wine
      starting a 2nd process, which a click in WE's UI doesn't pay: compare on `opened`.
        cold  the first load ever: a fresh WE session per load (A, then B) with every shader WE compiled hidden
              (`assets/shaders/blobsSM50` moved aside for the load and put back after; B's farm blobs dropped), the
              session's NVIDIA shader disk cache empty (a private __GL_SHADER_DISK_CACHE_PATH per scene), B's files
              and WE's assets dropped from the page cache (posix_fadvise DONTNEED: clean pages only, no root)
        boot  the first load after a reboot: a fresh session, the files dropped, every cache kept
        warm  B again in the same session (B → A → B …): everything cached, WE's process warm
ours  A private headless player (scene_load.py's `Player`: own runtime, state, cache dirs, no audio, no display) on
      a 1920x1080@60 output, `out:*.scene_fps` = --fps; the switch is a `transition` (a cut) from A to B, as the
      backend sends it. Times from the request (`req`), with the player's own events beside the detector:
      `started` (transition.started: B's first frame latched, the cut composed on that tick) and `ready`
      (source.ready). --no-capture measures without the capture loop (what it costs the load).
        cold  both shader caches emptied (NVIDIA's and the core's), B's files, WE's assets, the worker and its
              core dropped from the page cache (as scene_load.py's cold)
        boot  the files dropped, the caches kept
        warm  B again (a new worker each time; with --spare the spare worker)
Records: one JSON line per switch in <out>/records.jsonl; `summary` prints medians and spreads per scene, side and
condition. Nothing appears on the real outputs and nothing is heard; it kills only what it started.
"""

import argparse
import ctypes as C
import ctypes.util
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent.parent
REPO = CRATE.parent.parent
sys.path.insert(0, str(HERE))

WR = Path(os.environ.get("WE_REF_HOME") or Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "liascape/we-ref")
WE = WR / "we"
WORKSHOP = Path.home() / ".local/share/Steam/steamapps/workshop/content/431960"
PROTON = "/@steam/SteamLibrary/steamapps/common/Proton - Experimental"
UMU = Path.home() / ".local/share/lutris/runtime/umu/umu-run"
W, H = 1920, 1080
DS = 8  # detector downsampling (240 x 135 grey)
A_RGB = (0.55, 0.15, 0.55)
SETTLE = 4.0  # B's settled picture: this long after its first frame


# ---------------------------------------------------------------- the probe scene A

def write_probe():
    """loadprobe: a flat clear colour and the scene clock (24 bits of g_Time in ms) as a strip along the bottom."""
    d = WR / "probe-scenes" / "loadprobe"
    for sub in ("materials", "models", "shaders"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    (d / "project.json").write_text(json.dumps(
        {"file": "scene.json", "title": "liascape load probe (capture-only)", "type": "scene", "general": {"properties": {}}}))
    (d / "shaders" / "loadprobe.vert").write_text(
        "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nattribute vec2 a_TexCoord;\n"
        "varying vec2 v_TexCoord;\nvoid main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n"
        "\tv_TexCoord = a_TexCoord;\n}\n")
    (d / "shaders" / "loadprobe.frag").write_text(
        "uniform sampler2D g_Texture0; // {\"hidden\":true}\nuniform float g_Time;\nvarying vec2 v_TexCoord;\n"
        "void main() {\n\tfloat N = floor(g_Time * 1000.0);\n\tfloat cell = floor(v_TexCoord.x * 26.0);\n\tfloat bit = 0.0;\n"
        "\tif (cell < 0.5) {\n\t\tbit = 1.0;\n\t} else if (cell < 24.5) {\n\t\tbit = mod(floor(N / exp2(24.0 - cell)), 2.0);\n\t}\n"
        "\tgl_FragColor = vec4(bit, bit, bit, 1.0);\n}\n")
    (d / "materials" / "loadprobe.json").write_text(json.dumps({"passes": [{
        "blending": "normal", "cullmode": "nocull", "depthtest": "disabled", "depthwrite": "disabled",
        "shader": "loadprobe", "textures": ["util/white"]}]}))
    (d / "models" / "loadprobe.json").write_text(json.dumps({"material": "materials/loadprobe.json"}))
    (d / "scene.json").write_text(json.dumps({
        "camera": {"center": "960 540 -1", "eye": "960 540 0", "up": "0 1 0"},
        "general": {"ambientcolor": "0.3 0.3 0.3", "bloom": False, "camerafade": False, "cameraparallax": False,
                    "camerashake": False, "clearcolor": " ".join(str(c) for c in A_RGB), "clearenabled": True,
                    "hdr": False, "orthogonalprojection": {"width": W, "height": H}, "zoom": 1.0},
        "objects": [{"id": 1, "name": "clock", "image": "models/loadprobe.json", "origin": "960 27 0",
                     "size": "1920 54", "scale": "1 1 1", "angles": "0 0 0", "parallaxDepth": "0 0", "visible": True}],
        "version": 3}, indent=1))
    return d


# ---------------------------------------------------------------- the detector

def small(frame_rgb):
    """HxWx3 uint8 → the detector's grey (H/DS x W/DS float32): 2 x 2 samples a block, so a read costs ~2 ms (a full
    average of a 1080p frame took ~15 ms and set the read interval)."""
    h, w = (frame_rgb.shape[0] // DS) * DS, (frame_rgb.shape[1] // DS) * DS
    f = frame_rgb[DS // 4:h:DS // 2, DS // 4:w:DS // 2].astype(np.float32)
    g = f[..., 0] * 0.299 + f[..., 1] * 0.587 + f[..., 2] * 0.114
    return g.reshape(g.shape[0] // 2, 2, g.shape[1] // 2, 2).mean(axis=(1, 3))


def classify(g):
    """'a' (the probe: flat magenta above its strip), 'flat' (black, a window background), or 'pic'."""
    top = g[: int(g.shape[0] * 0.9)]
    a = 0.299 * A_RGB[0] * 255 + 0.587 * A_RGB[1] * 255 + 0.114 * A_RGB[2] * 255
    if top.std() < 3.0 and abs(top.mean() - a) < 6.0:
        return "a"
    if top.std() < 3.0:
        return "flat"
    return "pic"


def tiles_std(g, tw=10, th=9):
    """Each tile's standard deviation (240 x 135 → 24 x 15 tiles)."""
    h, w = (g.shape[0] // th) * th, (g.shape[1] // tw) * tw
    return g[:h, :w].reshape(h // th, th, w // tw, tw).std(axis=(1, 3))


def strip(g):
    return g[int(g.shape[0] * 0.96):]


def analyse(frames, t0):
    """frames: [(t_read, t_prev_read, grey)] in time order (each a changed frame). Times in ms from t0."""
    out = {}
    first = None
    a_last = None
    prev_a = None
    for i, (t, tp, g) in enumerate(frames):
        c = classify(g)
        if c == "a":
            if prev_a is not None and np.abs(strip(g) - strip(prev_a)).max() > 8:
                a_last = t
            prev_a = g
        elif c == "pic" and t >= t0:
            first = i
            break
    out["a_last_ms"] = None if a_last is None else (a_last - t0) * 1e3
    if first is None:
        out["error"] = "no picture of B"
        return out
    tf = frames[first][0]
    out["first_ms"] = (tf - t0) * 1e3
    out["first_prev_ms"] = (frames[first][1] - t0) * 1e3  # the read before it saw the old picture
    seen_flat = [((t - t0) * 1e3) for t, _, g in frames[:first] if t >= t0 and classify(g) == "flat"]
    out["flat_before_ms"] = seen_flat[0] if seen_flat else None
    # B's settled picture and its noise floor
    ref_i = next((i for i in range(first, len(frames)) if frames[i][0] >= tf + SETTLE), None)
    if ref_i is None:
        out["error"] = "B not watched long enough"
        return out
    ref = frames[ref_i][2]
    # complete: (almost) no tile that has content in the settled picture is still empty (a video, a late texture);
    # an intro zoom or B's own animation never empties a tile, so it doesn't count as loading
    ref_rich = tiles_std(ref) > 4.0
    missing = [(t, int(np.count_nonzero((tiles_std(g) < 1.5) & ref_rich))) for t, _, g in frames[first:ref_i + 1]]
    out["first_missing_tiles"] = missing[0][1]
    out["tiles"] = int(np.count_nonzero(ref_rich))
    allow = max(2, int(0.03 * out["tiles"]))  # a scene's own late text or widget (a clock filled in by script)
    tc = next(t for t, m in missing if m <= allow)
    out["complete_ms"] = (tc - t0) * 1e3
    # settle (informational): within the noise floor of the settled picture — B's own intro animation counts too
    late = [float(np.abs(g - ref).mean()) for t, _, g in frames[first:ref_i] if t >= tf + SETTLE - 1.0]
    floor = float(np.percentile(late, 90)) if late else 0.0
    thr = max(floor * 1.5, floor + 2.0)
    diffs = [(t, float(np.abs(g - ref).mean())) for t, _, g in frames[first:ref_i + 1]]
    out["settle_ms"] = (next(t for t, d in diffs if d <= thr) - t0) * 1e3
    return out


# ---------------------------------------------------------------- MIT-SHM window reads (WE's window on Xwayland)

def _lib(name, attr):
    p = ctypes.util.find_library(name)
    if not p:
        outs = subprocess.run(["nix", "build", "--no-link", "--print-out-paths", f"nixpkgs#xorg.{attr}"],
                              capture_output=True, text=True).stdout.split()
        for d in outs:
            hits = sorted(glob.glob(f"{d}/lib/lib{name}.so.*"))
            if hits:
                p = hits[0]
                break
    if not p:
        raise SystemExit(f"no lib{name} (nixpkgs#xorg.{attr})")
    return C.CDLL(p)


class _XImage(C.Structure):
    _fields_ = [("width", C.c_int), ("height", C.c_int), ("xoffset", C.c_int), ("format", C.c_int),
                ("data", C.c_void_p), ("byte_order", C.c_int), ("bitmap_unit", C.c_int),
                ("bitmap_bit_order", C.c_int), ("bitmap_pad", C.c_int), ("depth", C.c_int),
                ("bytes_per_line", C.c_int), ("bits_per_pixel", C.c_int)]


class _ShmInfo(C.Structure):
    _fields_ = [("shmseg", C.c_ulong), ("shmid", C.c_int), ("shmaddr", C.c_void_p), ("readOnly", C.c_int)]


class _WinAttr(C.Structure):
    _fields_ = [("x", C.c_int), ("y", C.c_int), ("width", C.c_int), ("height", C.c_int), ("border_width", C.c_int),
                ("depth", C.c_int), ("visual", C.c_void_p), ("root", C.c_ulong), ("class_", C.c_int),
                ("bit_gravity", C.c_int), ("win_gravity", C.c_int), ("backing_store", C.c_int),
                ("backing_planes", C.c_ulong), ("backing_pixel", C.c_ulong), ("save_under", C.c_int),
                ("colormap", C.c_ulong), ("map_installed", C.c_int), ("map_state", C.c_int),
                ("all_event_masks", C.c_long), ("your_event_mask", C.c_long), ("do_not_propagate_mask", C.c_long),
                ("override_redirect", C.c_int), ("screen", C.c_void_p)]


class XGrabber:
    """XShmGetImage of one window: its own contents (gamescope redirects every window, so the root shows nothing)."""

    def __init__(self, display, window):
        x = self.x = _lib("X11", "libX11")
        xe = self.xe = _lib("Xext", "libXext")
        libc = C.CDLL(None, use_errno=True)
        x.XOpenDisplay.restype = C.c_void_p
        x.XOpenDisplay.argtypes = [C.c_char_p]
        self.dpy = x.XOpenDisplay(display.encode())
        if not self.dpy:
            raise RuntimeError(f"can't open display {display}")
        x.XGetWindowAttributes.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(_WinAttr)]
        a = _WinAttr()
        if not x.XGetWindowAttributes(self.dpy, window, C.byref(a)):
            raise RuntimeError(f"no window {window:#x}")
        self.w, self.h, self.win = a.width, a.height, window
        xe.XShmCreateImage.restype = C.POINTER(_XImage)
        xe.XShmCreateImage.argtypes = [C.c_void_p, C.c_void_p, C.c_uint, C.c_int, C.c_void_p, C.POINTER(_ShmInfo),
                                       C.c_uint, C.c_uint]
        self.info = _ShmInfo()
        self.img = xe.XShmCreateImage(self.dpy, a.visual, a.depth, 2, None, C.byref(self.info), a.width, a.height)
        im = self.img.contents
        size = im.bytes_per_line * im.height
        libc.shmget.restype = C.c_int
        libc.shmget.argtypes = [C.c_int, C.c_size_t, C.c_int]
        libc.shmat.restype = C.c_void_p
        libc.shmat.argtypes = [C.c_int, C.c_void_p, C.c_int]
        libc.shmctl.argtypes = [C.c_int, C.c_int, C.c_void_p]
        self.info.shmid = libc.shmget(0, size, 0o1000 | 0o600)
        self.info.shmaddr = libc.shmat(self.info.shmid, None, 0)
        im.data = self.info.shmaddr
        xe.XShmAttach.argtypes = [C.c_void_p, C.POINTER(_ShmInfo)]
        xe.XShmAttach(self.dpy, C.byref(self.info))
        x.XSync.argtypes = [C.c_void_p, C.c_int]
        x.XSync(self.dpy, 0)
        libc.shmctl(self.info.shmid, 0, None)  # IPC_RMID now: the segment goes when both sides detach
        xe.XShmGetImage.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(_XImage), C.c_int, C.c_int, C.c_ulong]
        self.buf = (C.c_ubyte * size).from_address(self.info.shmaddr)
        self.bpl = im.bytes_per_line
        x.XCloseDisplay.argtypes = [C.c_void_p]

    def grab(self):
        """(monotonic time after the read, the frame as HxWx3 BGR→RGB view) or (t, None)."""
        ok = self.xe.XShmGetImage(self.dpy, self.win, self.img, 0, 0, 0xFFFFFFFF)
        t = time.monotonic()
        if not ok:
            return t, None
        a = np.frombuffer(self.buf, dtype=np.uint8).reshape(self.h, self.bpl // 4, 4)[:, : self.w]
        return t, a[..., 2::-1]

    def close(self):
        self.x.XCloseDisplay(self.dpy)


# ---------------------------------------------------------------- page cache

def evict(paths):
    """Drops each file's clean pages (posix_fadvise DONTNEED; no root, pages another process maps stay)."""
    total = 0
    for root in paths:
        root = Path(root)
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for f in files:
            try:
                fd = os.open(f, os.O_RDONLY)
            except OSError:
                continue
            try:
                total += os.fstat(fd).st_size
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            finally:
                os.close(fd)
    return total


# ---------------------------------------------------------------- WE under Proton

def farm(item):
    """<we-ref>/load-ws/<id>: the item as symlinks (no shaders/blobs*), so WE's compiled shaders land here."""
    src = WORKSHOP / item
    dst = WR / "load-ws" / item
    if (dst / "project.json").exists():
        return dst
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if rel.parts[:1] == ("shaders",) and len(rel.parts) > 1 and rel.parts[1].startswith("blobs"):
            continue
        if p.is_dir():
            (dst / rel).mkdir(parents=True, exist_ok=True)
        else:
            (dst / rel).parent.mkdir(parents=True, exist_ok=True)
            os.symlink(p, dst / rel)
    return dst


def drop_blobs(d):
    """WE's compiled shaders for a farm (files WE wrote: never a Workshop file, the farm holds only links)."""
    n = 0
    for b in (d / "shaders").glob("blobs*"):
        if b.is_symlink() or not b.is_dir():
            continue
        for f in b.rglob("*"):
            if f.is_file() and not f.is_symlink():
                f.unlink()
                n += 1
    return n


def winpath(p):
    return "Z:" + str(p).replace("/", "\\")


def descendants(pid):
    out = []
    try:
        for t in os.listdir(f"/proc/{pid}/task"):
            for c in Path(f"/proc/{pid}/task/{t}/children").read_text().split():
                out.append(int(c))
                out += descendants(int(c))
    except OSError:
        pass
    return out


def comm(pid):
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


class WeSession:
    def __init__(self, first, fps, sdir, nvcache):
        self.sdir = sdir
        sdir.mkdir(parents=True, exist_ok=True)
        tool = REPO / "scripts/dev/we_ref_tool.py"
        subprocess.run([sys.executable, "-I", str(tool), "config", str(WR / "config.base.json"), str(WE / "config.json"),
                        winpath(first / "scene.json").replace("\\", "/")], env=dict(os.environ, WE_REF_FPS=str(fps)),
                       check=True)
        steam_run = shutil.which("steam-run") or sys.exit("no steam-run on PATH")
        gsenv = sdir / "gs.env"
        gsenv.write_text("")
        child = sdir / "child.sh"
        child.write_text(f"""#!/usr/bin/env bash
env | grep -E '^(DISPLAY|GAMESCOPE_WAYLAND_DISPLAY)=' >"{gsenv}"
cd "{WE}"
exec "{steam_run}" "{UMU}" "{WE}/wallpaper64.exe" -control openWallpaper -file "{winpath(first / 'project.json')}" -playInWindow Ref -width {W} -height {H} -x 0 -y 0 -borderless
""")
        child.chmod(0o755)
        native = (WR / "pfx-builtin-bak" / "d3dcompiler_47.dll").exists()  # we-ref's trust_setup put Microsoft's in
        env = dict(os.environ)
        for k in ("WAYLAND_DISPLAY", "LD_LIBRARY_PATH"):
            env.pop(k, None)
        env.update(WINEPREFIX=str(WR / "pfx"), PROTONPATH=PROTON, UMU_RUNTIME_UPDATE="0", GAMEID="umu-liascape-we-ref",
                   WINEDLLOVERRIDES="winepulse.drv=d;winealsa.drv=d;d3dcompiler_47=" + ("n" if native else "b"),
                   PULSE_SERVER="unix:/nonexistent", PROTON_LOG="0", WINEDEBUG="-all", DXVK_LOG_LEVEL="none",
                   __GL_SHADER_DISK_CACHE_PATH=str(nvcache), __GL_SHADER_DISK_CACHE_SKIP_CLEANUP="1",
                   DXVK_STATE_CACHE_PATH=str(nvcache))
        self.t_launch = time.monotonic()
        self.gs = subprocess.Popen(["setsid", "gamescope", "--backend", "headless", "-W", str(W), "-H", str(H), "-w", str(W),
                                    "-h", str(H), "-r", str(fps), "--", str(child)], env=env,
                                   stdout=open(sdir / "gamescope.log", "w"), stderr=subprocess.STDOUT)
        end = time.monotonic() + 30
        while "DISPLAY=" not in gsenv.read_text():
            if time.monotonic() > end or self.gs.poll() is not None:
                self.stop()
                raise RuntimeError(f"gamescope never started ({sdir / 'gamescope.log'})")
            time.sleep(0.05)
        ge = dict(line.split("=", 1) for line in gsenv.read_text().split())
        self.display = ge["DISPLAY"]
        xdotool = shutil.which("xdotool") or (subprocess.run(
            ["nix", "build", "--no-link", "--print-out-paths", "nixpkgs#xdotool"], capture_output=True, text=True
        ).stdout.split() or [""])[-1] + "/bin/xdotool"
        self.win = None
        end = time.monotonic() + 90
        while time.monotonic() < end and self.win is None:
            r = subprocess.run([xdotool, "search", "--name", "^Ref$"], env=dict(os.environ, DISPLAY=self.display),
                               capture_output=True, text=True)
            if r.stdout.split():
                self.win = int(r.stdout.split()[0])
            else:
                time.sleep(0.2)
        self.we_pid = next((p for p in descendants(self.gs.pid) if comm(p) == "wallpaper64.exe"), None)
        if self.win is None or self.we_pid is None:
            self.stop()
            raise RuntimeError("WE's window never came")
        self.grabber = XGrabber(self.display, self.win)
        env = {}
        for kv in Path(f"/proc/{self.we_pid}/environ").read_bytes().split(b"\0"):
            k, sep, v = kv.partition(b"=")
            if sep:
                env[k.decode()] = v.decode(errors="replace")
        for k in ("WINESERVERSOCKET", "WINEPRELOADRESERVE", "WINELOADERNOEXEC"):  # the server's own fd and layout
            env.pop(k, None)
        self.ctl_env = env

    def wait_picture(self, timeout=120):
        """Waits until the window shows the probe A (its clock moving); returns ms from launch or None."""
        end = time.monotonic() + timeout
        last = None
        while time.monotonic() < end:
            t, f = self.grabber.grab()
            if f is not None:
                g = small(f)
                if classify(g) == "a":
                    if last is not None and np.abs(strip(g) - strip(last)).max() > 8:
                        return (t - self.t_launch) * 1e3
                    last = g
            time.sleep(0.02)
        return None

    def open(self, project_dir):
        """Sends `-control openWallpaper` from a 2nd wallpaper64.exe in the session's container and wine server."""
        return subprocess.Popen(
            ["nsenter", "-t", str(self.we_pid), "-U", "-m", "--preserve-credentials", "--", PROTON + "/files/bin/wine",
             str(WE / "wallpaper64.exe"), "-control", "openWallpaper", "-file", winpath(project_dir / "project.json"),
             "-playInWindow", "Ref", "-width", str(W), "-height", str(H), "-x", "0", "-y", "0", "-borderless"],
            cwd=WE, env=self.ctl_env, stdout=open(self.sdir / "control.log", "a"), stderr=subprocess.STDOUT)

    def alive(self):
        return self.gs.poll() is None and Path(f"/proc/{self.we_pid}").exists()

    def stop(self):
        try:
            self.grabber.close()
        except Exception:
            pass
        if self.gs.poll() is not None:
            return
        pids = descendants(self.gs.pid)
        # WE first (Wine ends a process on SIGTERM): umu winds the prefix down and gamescope follows its child out
        for p in pids:
            if comm(p) == "wallpaper64.exe":
                os.kill(p, signal.SIGTERM)
        end = time.monotonic() + 8
        while time.monotonic() < end and self.gs.poll() is None:
            time.sleep(0.2)
        if self.gs.poll() is None:
            self.gs.terminate()
        end = time.monotonic() + 10
        while time.monotonic() < end and any(Path(f"/proc/{p}").exists() for p in [self.gs.pid] + pids):
            time.sleep(0.2)
        for p in [self.gs.pid] + pids:
            if Path(f"/proc/{p}").exists():
                print(f"pid {p} still up 10 s after TERM: KILL", file=sys.stderr)
                try:
                    os.kill(p, signal.SIGKILL)
                except OSError:
                    pass
        self.gs.wait()


class OpenWatch:
    """inotify on B's Workshop folder: the monotonic time of the first open of project.json after arm()."""

    def __init__(self, item):
        tool = shutil.which("inotifywait") or (subprocess.run(
            ["nix", "build", "--no-link", "--print-out-paths", "nixpkgs#inotify-tools"], capture_output=True, text=True
        ).stdout.split() or [""])[-1] + "/bin/inotifywait"
        self.p = subprocess.Popen([tool, "-m", "-q", "-e", "open", "--format", "%e %f", str(WORKSHOP / item)],
                                  stdout=subprocess.PIPE, text=True)
        self.opens = []
        threading.Thread(target=self._read, daemon=True).start()
        time.sleep(0.3)

    def _read(self):
        for line in self.p.stdout:
            if line.split()[-1:] == ["project.json"]:
                self.opens.append(time.monotonic())

    def first_after(self, t):
        return next((o for o in self.opens if o >= t), None)

    def close(self):
        self.p.terminate()
        self.p.wait()


def switch_we(s, ow, b_dir, item, a_dir, period=0.004):
    dumps = len(list(WE.glob("*.mdmp")))  # WE's crash handler writes a minidump and shows a dialog
    t0 = time.monotonic()
    ctl = s.open(b_dir)
    frames = []
    state = {"first": None, "crashed": False, "checked": t0}

    def until():
        el = time.monotonic() - t0
        if el > 120 or not s.alive():
            return True
        if time.monotonic() - state["checked"] > 0.5:
            state["checked"] = time.monotonic()
            if len(list(WE.glob("*.mdmp"))) > dumps:
                state["crashed"] = True
                return True
        if state["first"] is None and frames and classify(frames[-1][2]) == "pic" and frames[-1][0] > t0:
            state["first"] = frames[-1][0]
        return state["first"] is not None and time.monotonic() > state["first"] + SETTLE + 0.3

    prev = None
    tp = time.monotonic()
    while not until():
        t, f = s.grabber.grab()
        if f is not None:
            g = small(f)
            if prev is None or np.abs(g - prev).max() > 0.5:
                frames.append((t, tp, g))
                prev = g
        tp = t
        rest = period - (time.monotonic() - t)
        if rest > 0:
            time.sleep(rest)
    try:
        ctl.wait(10)
    except subprocess.TimeoutExpired:
        ctl.terminate()
    opened = ow.first_after(t0)
    rec = analyse(frames, t0)
    if state["crashed"]:
        rec["error"] = "WE crashed (a new minidump)"
        rec["we_crashed"] = True
    rec["opened_ms"] = None if opened is None else (opened - t0) * 1e3
    for k in ("first_ms", "complete_ms", "settle_ms", "a_last_ms", "flat_before_ms"):
        if rec.get(k) is not None and opened is not None:
            rec[k.replace("_ms", "_from_open_ms")] = rec[k] - rec["opened_ms"]
    rec["n_frames"] = len(frames)
    return rec, frames


def back_to_a(s, a_dir):
    ctl = s.open(a_dir)
    ok = s.wait_picture(60)
    try:
        ctl.wait(10)
    except subprocess.TimeoutExpired:
        ctl.terminate()
    return ok


def run_we(a, out, records):
    lock = open(WR / "lock", "w")
    import fcntl
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SystemExit(f"another we-ref run holds {WR / 'lock'}")
    if not (WE / "wallpaper64.exe").exists() or not (WR / "pfx").exists():
        raise SystemExit("no we-ref setup: run scripts/dev/we-ref-capture.sh --setup and one capture first")
    probe = write_probe()
    nv = out / "nvcache"
    assets = (WE / "assets").resolve() if (WE / "assets").is_symlink() else WE / "assets"
    items = [str(s) for s in a.scene]
    farms = {i: farm(i) for i in items}

    def save(rec, frames, tag):
        records.write(json.dumps(rec) + "\n")
        records.flush()
        np.savez_compressed(out / "frames" / f"{tag}.npz", t=np.array([f[0] for f in frames]),
                            tp=np.array([f[1] for f in frames]), g=np.array([f[2] for f in frames], dtype=np.uint8))
        print(f"we {rec['scene']} {rec['mode']}: " + " ".join(
            f"{k}={v:.0f}" for k, v in rec.items() if k.endswith("_ms") and v is not None) +
              (f" ERROR {rec['error']}" if rec.get("error") else ""), file=sys.stderr, flush=True)

    (out / "frames").mkdir(parents=True, exist_ok=True)
    blobs_dir = WE / "assets" / "shaders" / "blobsSM50"
    hidden = WE / "assets" / "shaders" / "blobsSM50.hidden-by-load-timing"
    if hidden.exists():
        raise SystemExit(f"{hidden} exists (an interrupted run): move it back to {blobs_dir} first")

    crashed = set()

    def fresh(item, mode, r):
        """One load in a fresh WE session: A, then B (cold: every compiled shader hidden, NVIDIA's cache empty)."""
        if item in crashed:
            return
        nvi = nv / item
        blobs = 0
        if mode == "cold":
            shutil.rmtree(nvi, ignore_errors=True)
            blobs = drop_blobs(farms[item])
            if blobs_dir.is_dir():
                blobs_dir.rename(hidden)  # WE's compiled shaders (it writes a new set; ours are put back after)
        nvi.mkdir(parents=True, exist_ok=True)
        try:
            s = WeSession(probe, a.fps, out / "session", nvi)
            ow = OpenWatch(item)
            try:
                up = s.wait_picture()
                if up is None:
                    raise RuntimeError("the probe never showed")
                time.sleep(1.0)
                # the files, after WE and A are up (WE's own binaries are mapped: they stay, as for a running app)
                dropped = evict([WORKSHOP / item, assets, probe])
                time.sleep(a.gap)
                rec, frames = switch_we(s, ow, farms[item], item, probe, a.period)
                rec.update(side="we", scene=item, mode=mode, round=r, session_up_ms=up, blobs_dropped=blobs,
                           evicted_mb=round(dropped / 2**20), fps=a.fps, period_ms=a.period * 1e3)
                save(rec, frames, f"we-{item}-{mode}-{r}")
                if rec.get("we_crashed"):
                    crashed.add(item)  # it crashes every time (video textures under Proton): not again
            finally:
                ow.close()
                s.stop()
        finally:
            if hidden.exists():
                if blobs_dir.is_dir():
                    rec_n = sum(1 for f in blobs_dir.rglob("*") if f.is_file() and not f.is_symlink())
                    print(f"we {item} cold: WE compiled {rec_n} shaders afresh (dropped again)", file=sys.stderr)
                    for f in sorted(blobs_dir.rglob("*"), reverse=True):
                        if f.is_symlink() or f.is_file():
                            f.unlink()
                        elif f.is_dir():
                            f.rmdir()
                    blobs_dir.rmdir()
                hidden.rename(blobs_dir)

    for mode, n in (("cold", a.cold), ("boot", a.boot)):
        for r in range(n):
            for item in items:
                fresh(item, mode, r)
    if a.warm:
        for item in [i for i in items if i not in crashed]:
            (nv / item).mkdir(parents=True, exist_ok=True)
            s = WeSession(probe, a.fps, out / "session", nv / item)
            ow = OpenWatch(item)
            try:
                if s.wait_picture() is None:
                    raise RuntimeError("the probe never showed")
                for k in range(a.warm + 1):
                    time.sleep(a.gap)
                    rec, frames = switch_we(s, ow, farms[item], item, probe, a.period)
                    rec.update(side="we", scene=item, mode="prime" if k == 0 else "warm", round=k, fps=a.fps,
                               period_ms=a.period * 1e3)
                    save(rec, frames, f"we-{item}-warm-{k}")
                    if rec.get("we_crashed"):
                        break
                    if back_to_a(s, probe) is None:
                        raise RuntimeError("A never came back")
            finally:
                ow.close()
                s.stop()


# ---------------------------------------------------------------- ours

class Capturer:
    """`capture` of the output back to back on its own connection, into /dev/shm (no disk writes beside a cold load);
    a second thread reduces each PNG so the decode never delays the next request."""

    def __init__(self, sock, target):
        import queue
        from scene_load import Client
        self.c = Client(sock)
        self.target = target
        self.d = Path(tempfile.mkdtemp(prefix="lp-loadcap-", dir="/dev/shm" if os.path.isdir("/dev/shm") else None))
        self.frames = []
        self.q = queue.Queue()
        self.on = False
        self.quit = False
        self.pending = 0
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()
        threading.Thread(target=self._reduce, daemon=True).start()

    def _run(self):
        tp = None
        i = 0
        while not self.quit:
            if not self.on:
                time.sleep(0.005)
                tp = None
                continue
            path = self.d / f"c{i}.png"
            i += 1
            ts = time.monotonic()
            try:
                self.c.call("capture", {"target": self.target, "path": str(path)}, timeout=10.0)
            except (RuntimeError, OSError):
                time.sleep(0.01)
                continue
            # the frame was composed before the loop answered the request: stamp the request
            with self.lock:
                self.pending += 1
            self.q.put((ts, ts if tp is None else tp, path))
            tp = ts

    def _reduce(self):
        from PIL import Image
        prev = None
        while True:
            ts, tp, path = self.q.get()
            if ts is None:
                prev = None
                continue
            try:
                g = small(np.asarray(Image.open(path).convert("RGB")))
                path.unlink()
            except OSError:
                g = None
            if g is not None and (prev is None or np.abs(g - prev).max() > 0.5):
                self.frames.append((ts, tp, g))
                prev = g
            with self.lock:
                self.pending -= 1

    def take(self):
        while True:
            with self.lock:
                if self.pending == 0:
                    break
            time.sleep(0.01)
        self.q.put((None, None, None))  # the next run starts with no previous frame
        f, self.frames = self.frames, []
        return f

    def close(self):
        self.quit = True
        time.sleep(0.1)
        shutil.rmtree(self.d, ignore_errors=True)


def run_ours(a, out, records):
    from scene_load import Player, core_of
    probe = write_probe()
    bindir = Path(a.bin).resolve()
    priv = out / "player"
    if priv.exists():
        raise SystemExit(f"{priv} exists: give a fresh --out")
    p = Player(bindir, priv, f"{W}x{H}@60")
    p.sub.call("subscribe", {"topics": ["source.", "worker.", "transition."]})
    core = core_of(bindir / "liascape-scene-worker")
    files = [bindir / "liascape-scene-worker", Path(p.check["assets_dir"])] + ([core] if core else [])
    (out / "frames").mkdir(parents=True, exist_ok=True)
    cap = None
    try:
        p.spare(a.spare)
        p.ctl.call("set", {"path": "out:*.scene_fps", "value": a.fps})
        outs = ["out:" + o["name"] for o in p.ctl.call("state")["outputs"]]
        cap = None if a.no_capture else Capturer(p.sock, outs[0])

        def switch(path, timeout=60.0):
            for _ in p.sub.lines(0.05):
                pass
            if cap:
                cap.take()
                cap.on = True
            t0 = time.monotonic()
            res = p.ctl.call("transition", {"outputs": "out:*", "to": {"kind": "scene", "path": str(path)},
                                            "effect_id": None, "align": "now"})
            b_id = res.get("to") if isinstance(res, dict) else None
            rec = {}
            end = t0 + timeout
            started = None
            while time.monotonic() < end:
                for t, ev in p.sub.lines(0.1):
                    k = ev.get("event")
                    if k == "transition.started" and ev.get("b", {}).get("id", b_id) == b_id and started is None:
                        started = t
                        rec["started_ms"] = (t - t0) * 1e3
                    elif k == "source.ready" and ev.get("id") == b_id and "ready_ms" not in rec:
                        rec["ready_ms"] = (t - t0) * 1e3
                    elif k == "worker.adopted":
                        rec["spare"] = True
                    elif k in ("source.error", "source.broken", "transition.failed"):
                        rec["error"] = ev
                if started is not None and time.monotonic() > started + SETTLE + 0.5:
                    break
                if "error" in rec:
                    break
            frames = []
            if cap:
                cap.on = False
                time.sleep(0.05)
                frames = cap.take()
            # where B's load went: the worker's own split (`lwe: loaded … in A ms, built in B ms`) and, for a slow
            # one, its log tail
            for w in p.ctl.call("probe", {"name": "workers", "args": {"log_tail": True}}, timeout=30.0).get("workers", []):
                if w.get("id") != b_id:
                    continue
                for line in w.get("log_tail", []):
                    m = re.search(r"lwe: loaded .* in ([\d.]+) ms, built in ([\d.]+) ms", line)
                    if m:
                        rec["load_ms"], rec["build_ms"] = float(m.group(1)), float(m.group(2))
                if rec.get("started_ms", 0) > 2000:
                    rec["log_tail"] = w.get("log_tail", [])[-20:]
            return t0, rec, frames

        def save(rec, frames, tag):
            records.write(json.dumps(rec) + "\n")
            records.flush()
            if frames:
                np.savez_compressed(out / "frames" / f"{tag}.npz", t=np.array([f[0] for f in frames]),
                                    tp=np.array([f[1] for f in frames]), g=np.array([f[2] for f in frames], dtype=np.uint8))
            print(f"ours {rec['scene']} {rec['mode']}: " + " ".join(
                f"{k}={v:.0f}" for k, v in rec.items() if k.endswith("_ms") and v is not None) +
                  (f" ERROR {rec['error']}" if rec.get("error") else ""), file=sys.stderr, flush=True)

        def to_a():
            _, rec, _ = switch(probe, 30.0)
            if "started_ms" not in rec:
                raise RuntimeError(f"A never came back: {rec}")
            time.sleep(1.0)

        to_a()
        plan = ([("cold", r) for r in range(a.cold)] + [("boot", r) for r in range(a.boot)] + [("prime", 0)] +
                [("warm", k) for k in range(a.warm)])
        for item in [str(s) for s in a.scene]:
            path = (WORKSHOP / item).resolve()
            for mode, r in plan:
                if mode == "cold":
                    for d in (priv / "cache" / "nv", priv / "cache" / "liascape" / "lwe-shaders"):
                        shutil.rmtree(d, ignore_errors=True)
                        d.mkdir(parents=True, exist_ok=True)
                    if a.spare:
                        p.respawn_spare()
                time.sleep(a.gap)
                if a.spare:
                    p.wait_spare()
                if mode in ("cold", "boot"):
                    evict(files + [path])
                t0, rec, frames = switch(path)
                if frames:
                    rec.update(analyse(frames, t0))
                    rec["n_frames"] = len(frames)
                    if rec.get("first_ms") is not None and rec.get("started_ms") is not None:
                        rec["detector_minus_started_ms"] = rec["first_ms"] - rec["started_ms"]
                rec.update(side="ours", scene=item, mode=mode, round=r, fps=a.fps, spare_on=a.spare,
                           capture=not a.no_capture)
                save(rec, frames, f"ours-{item}-{mode}-{r}")
                to_a()
    finally:
        if cap:
            cap.close()
        p.quit()


# ---------------------------------------------------------------- summary

def summary(dirs):
    """Per scene, side and condition: median [p25–p75] (min–max) of each time, in ms."""
    recs = []
    for d in dirs:
        for line in open(Path(d) / "records.jsonl"):
            recs.append(json.loads(line))
    groups = {}
    for r in recs:
        if r["mode"] == "prime":
            continue
        side = r["side"] + ("" if r.get("capture", True) else " nocap") + (" spare" if r.get("spare_on") else "")
        if r.get("period_ms", 4) > 10:
            side += f" read every {r['period_ms']:.0f} ms"
        groups.setdefault((r["scene"], side, r["mode"]), []).append(r)
    cols = ["opened_ms", "a_last_ms", "first_ms", "first_from_open_ms", "complete_ms", "complete_from_open_ms",
            "settle_from_open_ms", "settle_ms", "ready_ms", "started_ms", "detector_minus_started_ms"]
    for key in sorted(groups):
        rs = groups[key]
        errs = sum(1 for r in rs if r.get("error"))
        print(f"{' '.join(key)}: n={len(rs)}" + (f" errors={errs}" if errs else ""))
        for c in cols:
            v = [r[c] for r in rs if r.get(c) is not None]
            if v:
                q = np.percentile(v, [0, 25, 50, 75, 100])
                print(f"    {c[:-3]:<22} {q[2]:6.0f} [{q[1]:.0f}–{q[3]:.0f}] ({q[0]:.0f}–{q[4]:.0f})")


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("side", choices=["we", "ours", "summary"])
    ap.add_argument("dirs", nargs="*")
    ap.add_argument("--scene", action="append", default=[])
    ap.add_argument("--cold", type=int, default=10)
    ap.add_argument("--boot", type=int, default=10)
    ap.add_argument("--warm", type=int, default=10)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--gap", type=float, default=2.0, help="seconds on A before each switch")
    ap.add_argument("--period", type=float, default=0.004,
                    help="we: seconds between window reads (what the reads cost WE: compare a slow run)")
    ap.add_argument("--spare", action="store_true", help="ours: player.scene_spare on")
    ap.add_argument("--no-capture", action="store_true", help="ours: events only, no capture loop")
    ap.add_argument("--bin", default=str(CRATE / "target" / "release"))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    if a.side == "summary":
        return summary(a.dirs)
    if not a.scene:
        ap.error("--scene is required")
    out = Path(a.out or tempfile.mkdtemp(prefix=f"liascape-load-{a.side}-"))
    if str(out.resolve()).startswith(str(REPO) + "/"):
        raise SystemExit("--out must be outside the repo")
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "records.jsonl", "a") as records:
        (run_we if a.side == "we" else run_ours)(a, out, records)
    print(f"records: {out / 'records.jsonl'}", file=sys.stderr)


if __name__ == "__main__":
    main()
