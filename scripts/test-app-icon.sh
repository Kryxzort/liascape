#!/usr/bin/env bash
# The app icon as launchers draw it. Qt's SVG renderer (KDE's and Quickshell's launchers) implements SVG Tiny 1.2 and
# ignores clip paths and masks: an icon whose rounded tile is a <clipPath> draws as a full square there. Checks:
#  - the UI's copies (app/ui/public/favicon.svg, logo-lavender.svg) are generate.py's output, byte for byte;
#  - no clip path, mask, filter, pattern or element opacity in either SVG (none of them is in SVG Tiny 1.2);
#  - the installed SVG rendered the way Qt does (QSvgRenderer through PyQt6 / PyQt5 / PySide6 when one is installed,
#    else rsvg-convert or ImageMagick on a copy with its clip paths and masks stripped) has transparent corners, an
#    opaque middle, and the light page under the peeled corner (the diagonal clip baked in, not dark artwork);
#  - the hicolor PNGs (48–512) exist at their sizes with transparent corners;
#  - scripts/install-icons.sh puts the SVG and every PNG in a hicolor tree, and install.sh and the flake both call it.
# Usage: scripts/test-app-icon.sh    LIASCAPE_KEEP_TMP=1 keeps the temp folder.
# Needs: python3, and Qt's Python bindings or rsvg-convert / magick. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"
. "$ROOT/scripts/test-lock.sh"
command -v python3 >/dev/null || { echo "missing: python3"; exit 2; }

T=$(mktemp -d /tmp/liascape-icon-XXXXXX)
cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-icon- "$rc"; }
trap cleanup EXIT INT TERM HUP

bash "$ROOT/scripts/install-icons.sh" "$T/share/icons" > "$T/install.log" 2>&1 || { echo "install-icons.sh failed:"; cat "$T/install.log"; }

python3 -I - "$ROOT" "$T" <<'PY'
import filecmp, os, re, shutil, struct, subprocess, sys, zlib
root, tmp = sys.argv[1], sys.argv[2]
icon = os.path.join(root, "app/icon")
pub = os.path.join(root, "app/ui/public")
SIZES = (48, 64, 128, 256, 512)
npass = nfail = 0
def check(what, ok, why=""):
    global npass, nfail
    if ok: npass += 1; print(f"  ok   {what}")
    else: nfail += 1; print(f"  FAIL {what}{': ' + why if why else ''}")

# Qt's own renderer when its Python bindings are installed
Qt = None
for mod in ("PyQt6", "PyQt5", "PySide6"):
    try:
        gui = __import__(f"{mod}.QtGui", fromlist=["x"]); svg = __import__(f"{mod}.QtSvg", fromlist=["x"])
        core = __import__(f"{mod}.QtCore", fromlist=["x"])
        Qt = (mod, gui, svg, core)
        break
    except Exception:
        pass
app = None
if Qt:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = Qt[1].QGuiApplication(["test-app-icon", "-platform", "offscreen"])

def render(src, out, size):
    """Draws src the way a Qt launcher does; returns the renderer's name."""
    if Qt:
        _, gui, svg, core = Qt
        r = svg.QSvgRenderer(src)
        if not r.isValid(): raise RuntimeError(f"QSvgRenderer can't read {src}")
        fmt = gui.QImage.Format.Format_ARGB32 if hasattr(gui.QImage, "Format") else gui.QImage.Format_ARGB32
        img = gui.QImage(size, size, fmt)
        img.fill(0)
        p = gui.QPainter(img)
        p.setRenderHint(gui.QPainter.RenderHint.Antialiasing if hasattr(gui.QPainter, "RenderHint") else gui.QPainter.Antialiasing)
        r.render(p); p.end()
        img.save(out)
        return f"Qt ({Qt[0]} QSvgRenderer)"
    # stand-in: what Qt ignores, removed, then a full renderer
    text = open(src).read()
    text = re.sub(r"<clipPath\b.*?</clipPath>|<mask\b.*?</mask>", "", text, flags=re.S)
    text = re.sub(r'\s(clip-path|mask)="[^"]*"', "", text)
    stripped = os.path.join(tmp, "stripped.svg")
    open(stripped, "w").write(text)
    if shutil.which("rsvg-convert"):
        subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", out, stripped], check=True)
        return "rsvg-convert, clip paths and masks stripped"
    if shutil.which("magick"):
        subprocess.run(["magick", "-background", "none", stripped, "-resize", f"{size}x{size}", f"PNG32:{out}"], check=True)
        return "ImageMagick, clip paths and masks stripped"
    raise RuntimeError("no Qt bindings, rsvg-convert or magick to render with")

def pixels(png, pts):
    """(r, g, b, a) at each point, and the image size: a plain PNG decoder (8-bit RGB / RGBA, not interlaced: what Qt,
    rsvg-convert and ImageMagick's PNG32 write), so reading needs no tool beyond the renderer."""
    data = open(png, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n": raise ValueError(f"{png} is not a PNG")
    pos, idat = 8, b""
    while pos < len(data):
        n = int.from_bytes(data[pos:pos + 4], "big"); kind = data[pos + 4:pos + 8]; body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR": w, h, depth, ctype, _, _, lace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT": idat += body
        pos += 12 + n
    if depth != 8 or ctype not in (2, 6) or lace: raise ValueError(f"{png}: depth {depth}, colour type {ctype}, interlace {lace} unsupported")
    bpp = 4 if ctype == 6 else 3
    raw, stride, rows, prev = zlib.decompress(idat), w * bpp, [], bytearray(w * bpp)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line); prev = line
    out = []
    for x, y in pts:
        px = rows[y][x * bpp:(x + 1) * bpp]
        out.append(tuple(px) if bpp == 4 else tuple(px) + (255,))
    return out, (w, h)

def corners(size):
    # the tile's radius is 58 of 256: (6, 6) of 256 lies well outside the rounding, (128, 128) is the middle
    k = size / 256
    a, b = max(1, round(6 * k)), size - 1 - max(1, round(6 * k))
    return [(a, a), (b, a), (a, b), (b, b), (0, 0), (size - 1, size - 1)], (size // 2, size // 2)

# the UI's copies are the generator's output
for ours, theirs in (("liascape-night.svg", "favicon.svg"), ("liascape-lavender.svg", "logo-lavender.svg")):
    check(f"app/ui/public/{theirs} is app/icon/{ours}", filecmp.cmp(os.path.join(icon, ours), os.path.join(pub, theirs), shallow=False),
          "run python3 app/icon/generate.py")

# nothing SVG Tiny 1.2 lacks
for name in ("liascape-night.svg", "liascape-lavender.svg"):
    text = open(os.path.join(icon, name)).read()
    found = sorted(set(m.group(0).strip() for m in re.finditer(r"<clipPath\b|\sclip-path=|<mask\b|\smask=|<filter\b|\sfilter=|<pattern\b|\sopacity=", text)))
    check(f"{name} uses no clip path, mask, filter, pattern or element opacity", not found, ", ".join(found))

# the installed SVG as Qt draws it
fav = os.path.join(pub, "favicon.svg")
out = os.path.join(tmp, "favicon-qt.png")
try:
    how = render(fav, out, 256)
    print(f"  (rendered with {how})")
    pts, mid = corners(256)
    # (225, 240) is on the light page the peeled corner shows, below the diagonal the artwork ends at
    px, _ = pixels(out, pts + [mid, (225, 240)])
    check("favicon.svg as Qt draws it: the corners are transparent", all(p[3] == 0 for p in px[:len(pts)]), f"alpha {[p[3] for p in px[:len(pts)]]}")
    check("favicon.svg as Qt draws it: the middle is opaque", px[len(pts)][3] == 255, f"{px[len(pts)]}")
    r, g, b, a = px[-1]
    check("favicon.svg as Qt draws it: the peeled corner shows the light page", a == 255 and (r + g + b) / 3 > 150, f"{px[-1]}")
except Exception as e:
    check("favicon.svg renders", False, str(e))

# the PNGs beside it
for n in SIZES:
    png = os.path.join(icon, f"liascape-night-{n}.png")
    if not os.path.exists(png):
        check(f"liascape-night-{n}.png exists", False, "run python3 app/icon/generate.py"); continue
    pts, mid = corners(n)
    px, wh = pixels(png, pts + [mid])
    check(f"liascape-night-{n}.png is {n}x{n} with transparent corners and an opaque middle",
          wh == (n, n) and all(p[3] == 0 for p in px[:-1]) and px[-1][3] == 255, f"size {wh}, alpha {[p[3] for p in px]}")

# the install tree
hi = os.path.join(tmp, "share/icons/hicolor")
check("install-icons.sh installs the scalable SVG", os.path.exists(f"{hi}/scalable/apps/liascape.svg")
      and filecmp.cmp(f"{hi}/scalable/apps/liascape.svg", fav, shallow=False))
for n in SIZES:
    p = f"{hi}/{n}x{n}/apps/liascape.png"
    check(f"install-icons.sh installs {n}x{n}/apps/liascape.png", os.path.exists(p))
for f in ("scripts/install.sh", "flake.nix"):
    check(f"{f} installs the icons with install-icons.sh", "install-icons.sh" in open(os.path.join(root, f)).read())

print(f"RESULT pass={npass} fail={nfail}")
sys.exit(1 if nfail else 0)
PY
