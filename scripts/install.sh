#!/bin/bash
# Single build+install engine for livepaper (the Electron+React UI over the headless C# backend).
# Used directly for a user install AND reused by packaging (PKGBUILD, build-appimage.sh) so the build
# lives in ONE place — a code change (new file/dep/helper) only needs updating here, and every
# package inherits it. (The Nix flake is the one exception: it's declarative and builds separately.)
#
# Knobs (env):
#   PREFIX       runtime install prefix        (default: $HOME/.local; packages use /usr)
#   DESTDIR      staging root for packaging     (default: empty; PKGBUILD/AppImage set $pkgdir/$AppDir)
#   LP_ELECTRON  electron binary the GUI runs   (default: 'electron' on PATH; AppImage sets a bundled one)
#   SKIP_BUILD   1 = don't compile, only stage  (unused split; reserved)
#
# Paths: everything is staged under $DESTDIR but the wrappers reference the RUNTIME paths ($PREFIX...),
# so a packaged tree works once installed to $PREFIX regardless of where it was staged.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PREFIX="${PREFIX:-$HOME/.local}"
DESTDIR="${DESTDIR:-}"
LIBDIR="$PREFIX/lib/livepaper"           # runtime location of backend + ui + shell + helpers
BINDIR="$PREFIX/bin"
APPSDIR="$PREFIX/share/applications"
# staging (where we write now) = $DESTDIR + runtime path
S_LIB="$DESTDIR$LIBDIR"
S_BIN="$DESTDIR$BINDIR"
S_APPS="$DESTDIR$APPSDIR"

echo "==> building React UI"
(cd "$ROOT/app/ui" && npm install && npm run build)

echo "==> publishing backend (self-contained) → $LIBDIR/backend"
rm -rf "$S_LIB/backend"; mkdir -p "$S_LIB"
dotnet publish "$ROOT/src/livepaper" -r linux-x64 --self-contained -c Release -o "$S_LIB/backend"

echo "==> staging UI"
rm -rf "$S_LIB/ui"; mkdir -p "$S_LIB/ui"; cp -r "$ROOT/app/ui/dist/." "$S_LIB/ui/"

echo "==> staging Electron shell (self-contained — no repo dependency at runtime)"
rm -rf "$S_LIB/shell"; mkdir -p "$S_LIB/shell"
# electron provides its own runtime; the shell only needs its own JS, not node_modules
(cd "$ROOT/app/shell" && cp -r $(ls | grep -v '^node_modules$') "$S_LIB/shell/")

echo "==> staging transition assets (shaders + manifest + preview frames)"
rm -rf "$S_LIB/transitions"; mkdir -p "$S_LIB/transitions"; cp -r "$ROOT/transitions/." "$S_LIB/transitions/"

# Native helpers are REQUIRED, not optional: lp-transition renders every wallpaper switch
# (transitions are a core feature, never a no-op) and lp-audio gapless-crossfades scene audio.
# Preflight the toolchain and fail loudly with a fix — never silently ship a degraded build.
echo "==> checking native build toolchain (lp-transition + lp-audio)"
missing=""
command -v cc            >/dev/null 2>&1 || missing="$missing cc"
command -v make          >/dev/null 2>&1 || missing="$missing make"
command -v pkg-config    >/dev/null 2>&1 || missing="$missing pkg-config"
command -v wayland-scanner >/dev/null 2>&1 || missing="$missing wayland-scanner"
if command -v pkg-config >/dev/null 2>&1; then
  for p in wayland-client wayland-egl egl glesv2 mpv libpulse; do
    pkg-config --exists "$p" 2>/dev/null || missing="$missing ${p}(dev)"
  done
fi
if [ -n "$missing" ]; then
  cat >&2 <<MSG
ERROR: missing native build dependencies:$missing
  Transitions and scene-audio crossfade are core features, not optional — install these and re-run:
    Arch:   sudo pacman -S base-devel wayland wayland-protocols libglvnd mpv libpulse
    Debian: sudo apt install build-essential libwayland-bin libwayland-dev libegl-dev libgles-dev libmpv-dev libpulse-dev
    Fedora: sudo dnf install gcc make wayland-devel mesa-libEGL-devel mesa-libGLES-devel mpv-libs-devel pulseaudio-libs-devel
    NixOS:  use the flake instead — 'nix run github:Kryxzort/livepaper-pro' (all deps handled)
MSG
  exit 1
fi

# Auto-discover every native helper (src/native/<name>/ with a Makefile producing a binary named
# <name>) — adding a new one needs NO edit here. Each Makefile owns its own source list, so new .c
# files are picked up automatically too. set -e aborts loudly on any build failure.
echo "==> building native helpers (src/native/*)"
for d in "$ROOT"/src/native/*/; do
  [ -f "${d}Makefile" ] || continue
  name="$(basename "$d")"
  echo "    - $name"
  make -C "$d" >/dev/null
  install -Dm755 "${d}${name}" "$S_LIB/$name"
done

echo "==> ensuring Electron is available for the GUI"
# The GUI runs: <electron> <shell-dir>. By default use a system 'electron' (PATH) — the bundled
# prebuilt can't load its libs on some distros (NixOS) and pulls 200MB. Packages provide electron
# their own way: AUR depends=(electron); AppImage bundles one and sets LP_ELECTRON. Only warn here.
if [ -z "$LP_ELECTRON" ] && ! command -v electron >/dev/null 2>&1; then
  echo "    WARN: no 'electron' on PATH — install it (Arch: electron / Debian: apt has none, use the AppImage)"
  echo "          or set LP_ELECTRON=/path/to/electron. The CLI works without it; only the GUI needs it."
fi

mkdir -p "$S_BIN"
echo "==> installing 'livepaper' (bare = GUI; flags = headless CLI)"
cat > "$S_BIN/livepaper" <<WRAP
#!/bin/bash
export LP_UI_DIR="$LIBDIR/ui"
export LP_TRANSITIONS_DIR="$LIBDIR/transitions"
[ -x "$LIBDIR/lp-transition" ] && export LP_TRANSITION_BIN="$LIBDIR/lp-transition"
[ -x "$LIBDIR/lp-audio" ] && export LP_AUDIO_BIN="$LIBDIR/lp-audio"
[ \$# -eq 0 ] && exec "$BINDIR/livepaper-ui"
exec "$LIBDIR/backend/livepaper" "\$@"
WRAP
chmod 755 "$S_BIN/livepaper"

echo "==> installing 'livepaper-ui' (GUI)"
cat > "$S_BIN/livepaper-ui" <<WRAP
#!/bin/bash
export LP_BACKEND="$LIBDIR/backend/livepaper"
export LP_UI_DIR="$LIBDIR/ui"
export LP_TRANSITIONS_DIR="$LIBDIR/transitions"
[ -x "$LIBDIR/lp-transition" ] && export LP_TRANSITION_BIN="$LIBDIR/lp-transition"
[ -x "$LIBDIR/lp-audio" ] && export LP_AUDIO_BIN="$LIBDIR/lp-audio"
exec "\${LP_ELECTRON:-electron}" "$LIBDIR/shell"
WRAP
chmod 755 "$S_BIN/livepaper-ui"

mkdir -p "$S_APPS"
cat > "$S_APPS/livepaper.desktop" <<EOF
[Desktop Entry]
Name=Livepaper
Comment=Live wallpaper manager (Wayland)
Exec=$BINDIR/livepaper-ui
Type=Application
Categories=Utility;
Keywords=wallpaper;live;wayland;video;
EOF
update-desktop-database "$S_APPS" 2>/dev/null || true

echo ""
echo "Done. Installed to $LIBDIR (runtime prefix $PREFIX)."
echo "  GUI:  livepaper            (bare = open the app; livepaper-ui also works)"
echo "  CLI:  livepaper --restore | --action=next-wallpaper | --kill | --serve | …"
[ -z "$DESTDIR" ] && echo "  Ensure $BINDIR is on PATH."
