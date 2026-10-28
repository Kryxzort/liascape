#!/bin/bash
# Single build+install engine for Liascape (the Electron+React UI over the headless C# backend).
# Used directly for a user install AND reused by packaging (PKGBUILD, build-appimage.sh) so the build
# lives in ONE place — a code change (new file/dep/helper) only needs updating here, and every
# package inherits it. (The Nix flake is the one exception: it's declarative and builds separately,
# into the same layout.)
#
# Knobs (env):
#   PREFIX             runtime install prefix   (default: $HOME/.local; packages use /usr)
#   DESTDIR            staging root             (default: empty; PKGBUILD/AppImage set $pkgdir/$AppDir)
#   LIASCAPE_ELECTRON  read at RUNTIME by `liascape` (default: 'electron' on PATH; the AppImage bundles one)
#
# Options:
#   --no-scenes  build without Wallpaper Engine scene support under liascape-player (no LWE core, no
#                cmake/SDL2/freetype/glm/lz4 needed): liascape-scene-worker plays nothing but test scenes
#   --dry-run    print the layout it would install, build nothing
#
# Layout (scripts/liascape finds everything relative to itself, so a staged tree works wherever it lands):
#   $PREFIX/bin/liascape                    the one command (bare = the app, `liascape help` = the CLI)
#   $PREFIX/libexec/liascape/               liascape-backend (→ ../../lib/liascape/backend/), liascape-player,
#                                           liascape-scene-worker, liascape-transition, liascape-audio
#   $PREFIX/lib/liascape/                   backend/ ui/ shell/ transitions/ + LWE's core library
#   $PREFIX/share/applications/liascape.desktop
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"  # physical path: a symlinked alias makes MSBuild delete its own outputs

NO_SCENES=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --no-scenes) NO_SCENES=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option '$arg' (see --help)" >&2; exit 2 ;;
  esac
done

PREFIX="${PREFIX:-$HOME/.local}"
DESTDIR="${DESTDIR:-}"
BINDIR="$PREFIX/bin"
LIBEXEC="$PREFIX/libexec/liascape"   # the internal executables — never on PATH
LIBDIR="$PREFIX/lib/liascape"        # backend + ui + shell + transitions + LWE's core
APPSDIR="$PREFIX/share/applications"
# staging (where we write now) = $DESTDIR + runtime path
S_BIN="$DESTDIR$BINDIR"
S_LIBEXEC="$DESTDIR$LIBEXEC"
S_LIB="$DESTDIR$LIBDIR"
S_APPS="$DESTDIR$APPSDIR"

if [ "$DRY" = 1 ]; then
  cat <<EOF
install.sh --dry-run (PREFIX=$PREFIX${DESTDIR:+, staged under $DESTDIR}$([ "$NO_SCENES" = 1 ] && echo ", no scenes")):
  $S_BIN/liascape
  $S_LIBEXEC/liascape-backend -> ../../lib/liascape/backend/liascape-backend
  $S_LIBEXEC/liascape-player
  $S_LIBEXEC/liascape-scene-worker$([ "$NO_SCENES" = 1 ] && echo "   (test scenes only)")
$(for d in "$ROOT"/src/native/*/; do [ -f "${d}Makefile" ] && echo "  $S_LIBEXEC/$(basename "$d")"; done)
  $S_LIB/backend/   (dotnet publish, self-contained)
  $S_LIB/ui/  $S_LIB/shell/  $S_LIB/transitions/
$([ "$NO_SCENES" = 0 ] && echo "  $S_LIB/liblinux-wallpaperengine-core.so*")
  $S_APPS/liascape.desktop
EOF
  exit 0
fi

# liascape-player (the Rust Wayland compositor, src/player/) needs the Rust toolchain to build. Preflight
# this FIRST, before any build/publish side effect below — a missing toolchain must fail loud and
# immediately, not after minutes of npm/dotnet work already done.
echo "==> checking Rust toolchain (cargo/rustc — builds liascape-player)"
missing_rust=""
command -v cargo >/dev/null 2>&1 || missing_rust="$missing_rust cargo"
command -v rustc >/dev/null 2>&1 || missing_rust="$missing_rust rustc"
if [ -n "$missing_rust" ]; then
  cat >&2 <<MSG
ERROR: missing Rust toolchain:$missing_rust
  liascape-player (the Wayland wallpaper compositor) is built from source — install it and re-run:
    Arch:   sudo pacman -S rust
    Debian: sudo apt install cargo rustc
    Fedora: sudo dnf install cargo rust
    NixOS:  use the flake instead — 'nix run github:Kryxzort/liascape' (all deps handled)
MSG
  exit 1
fi

# Native helpers are REQUIRED, not optional: liascape-transition renders every wallpaper switch
# (transitions are a core feature, never a no-op) and liascape-audio gapless-crossfades scene audio.
# Preflight the toolchain and fail loudly with a fix — never silently ship a degraded build.
# liascape-player (Rust) links mpv/wayland/EGL/PipeWire/xkbcommon and runs bindgen (needs libclang).
# Checked here, before any build/publish side effect below.
echo "==> checking native build toolchain (liascape-transition + liascape-audio + liascape-player)"
missing=""
command -v cc            >/dev/null 2>&1 || missing="$missing cc"
command -v make          >/dev/null 2>&1 || missing="$missing make"
command -v pkg-config    >/dev/null 2>&1 || missing="$missing pkg-config"
command -v wayland-scanner >/dev/null 2>&1 || missing="$missing wayland-scanner"
if command -v pkg-config >/dev/null 2>&1; then
  for p in wayland-client wayland-egl egl glesv2 mpv libpulse libpipewire-0.3 xkbcommon; do
    pkg-config --exists "$p" 2>/dev/null || missing="$missing ${p}(dev)"
  done
fi
# bindgen (liascape-player's libmpv bindings) loads libclang at build time
if [ -z "${LIBCLANG_PATH:-}" ] && ! command -v clang >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q "libclang"; then
  missing="$missing libclang"
fi
if [ -n "$missing" ]; then
  cat >&2 <<MSG
ERROR: missing native build dependencies:$missing
  Transitions, scene-audio crossfade and the liascape-player compositor are core, not optional — install these and re-run:
    Arch:   sudo pacman -S base-devel wayland wayland-protocols libglvnd mpv libpulse pipewire libxkbcommon clang
    Debian: sudo apt install build-essential libwayland-bin libwayland-dev libegl-dev libgles-dev libmpv-dev libpulse-dev libpipewire-0.3-dev libxkbcommon-dev libclang-dev
    Fedora: sudo dnf install gcc make wayland-devel mesa-libEGL-devel mesa-libGLES-devel mpv-libs-devel pulseaudio-libs-devel pipewire-devel libxkbcommon-devel clang-devel
    NixOS:  use the flake instead — 'nix run github:Kryxzort/liascape' (all deps handled)
MSG
  exit 1
fi

# Wallpaper Engine scenes under liascape-player: the scene worker links LWE's core (linux-wallpaperengine
# next-v2, built from source at third_party/lwe/PIN). Its build deps are required unless --no-scenes —
# preflighted here too, before any build side effect (scripts/lwe.sh deps prints the package lines).
if [ "$NO_SCENES" = 0 ]; then
  echo "==> checking Wallpaper Engine scene build deps (LWE core: cmake, SDL2, freetype, glm, lz4, FFmpeg)"
  bash "$ROOT/scripts/lwe.sh" deps || exit 1
fi

echo "==> building React UI"
(cd "$ROOT/app/ui" && npm install && npm run build)

echo "==> publishing backend (self-contained) → $LIBDIR/backend"
rm -rf "$S_LIB/backend"; mkdir -p "$S_LIB" "$S_LIBEXEC"
dotnet publish "$ROOT/src/backend" -r linux-x64 --self-contained -c Release -o "$S_LIB/backend"
# the apphost finds its runtime from its real path (/proc/self/exe), so a symlink in libexec is enough
ln -sfn ../../lib/liascape/backend/liascape-backend "$S_LIBEXEC/liascape-backend"

echo "==> staging UI"
rm -rf "$S_LIB/ui"; mkdir -p "$S_LIB/ui"; cp -r "$ROOT/app/ui/dist/." "$S_LIB/ui/"

echo "==> staging Electron shell (self-contained — no repo dependency at runtime)"
rm -rf "$S_LIB/shell"; mkdir -p "$S_LIB/shell"
# electron provides its own runtime; the shell only needs its own JS, not node_modules
(cd "$ROOT/app/shell" && cp -r $(ls | grep -v '^node_modules$') "$S_LIB/shell/")

echo "==> staging transition assets (shaders + manifest + preview frames)"
rm -rf "$S_LIB/transitions"; mkdir -p "$S_LIB/transitions"; cp -r "$ROOT/transitions/." "$S_LIB/transitions/"

# Auto-discover every native helper (src/native/<name>/ with a Makefile producing a binary named
# <name>) — adding a new one needs NO edit here. Each Makefile owns its own source list, so new .c
# files are picked up automatically too. set -e aborts loudly on any build failure.
echo "==> building native helpers (src/native/*) → $LIBEXEC"
for d in "$ROOT"/src/native/*/; do
  [ -f "${d}Makefile" ] || continue
  name="$(basename "$d")"
  echo "    - $name"
  make -C "$d" >/dev/null
  install -Dm755 "${d}${name}" "$S_LIBEXEC/$name"
done

if [ "$NO_SCENES" = 0 ]; then
  # fetched into ~/.cache/liascape/src (git clone, once per pin), built in $ROOT/build/
  echo "==> building LWE core (Wallpaper Engine scenes) → $LIBDIR"
  LWE_CORE="$ROOT/build/lwe-core"
  LIASCAPE_LWE_CORE_DIR="$LWE_CORE" bash "$ROOT/scripts/lwe.sh" fetch prepare build check
  find "$S_LIB" -maxdepth 1 -name 'liblinux-wallpaperengine-core.so*' -delete
  cp -P "$LWE_CORE"/lib/liblinux-wallpaperengine-core.so* "$S_LIB/"
  echo "==> building liascape-player + liascape-scene-worker (Rust compositor) → $LIBEXEC"
  # the worker finds the core at runtime from libexec/liascape/ → lib/liascape/, not in the build tree
  (cd "$ROOT" && LIASCAPE_LWE_CORE_DIR="$LWE_CORE" LIASCAPE_LWE_RPATH='$ORIGIN/../../lib/liascape' \
    cargo build --release --locked --manifest-path src/player/Cargo.toml)
else
  echo "==> building liascape-player + liascape-scene-worker without scene support (--no-scenes) → $LIBEXEC"
  (cd "$ROOT" && cargo build --release --locked --no-default-features --manifest-path src/player/Cargo.toml)
fi
install -Dm755 "$ROOT/src/player/target/release/liascape-player" "$S_LIBEXEC/liascape-player"
install -Dm755 "$ROOT/src/player/target/release/liascape-scene-worker" "$S_LIBEXEC/liascape-scene-worker"

echo "==> ensuring Electron is available for the GUI"
# The GUI runs: <electron> <shell-dir>. By default a system 'electron' (PATH) — the bundled prebuilt
# can't load its libs on some distros (NixOS) and pulls 200MB. Packages provide electron their own way:
# AUR depends=(electron); the AppImage bundles one and sets LIASCAPE_ELECTRON. Only warn here.
if [ -z "${LIASCAPE_ELECTRON:-}" ] && ! command -v electron >/dev/null 2>&1; then
  echo "    WARN: no 'electron' on PATH — install it (Arch: electron / Debian: apt has none, use the AppImage)"
  echo "          or set LIASCAPE_ELECTRON=/path/to/electron. The CLI works without it; only the GUI needs it."
fi

echo "==> installing 'liascape' (bare = the app; 'liascape help' = the CLI)"
install -Dm755 "$ROOT/scripts/liascape" "$S_BIN/liascape"

mkdir -p "$S_APPS"
cat > "$S_APPS/liascape.desktop" <<EOF
[Desktop Entry]
Name=Liascape
Comment=Live wallpaper manager (Wayland)
Exec=$BINDIR/liascape
Type=Application
Categories=Utility;
Keywords=wallpaper;live;wayland;video;
StartupWMClass=liascape
EOF
update-desktop-database "$S_APPS" 2>/dev/null || true

echo ""
echo "Done. Installed to $PREFIX (bin/liascape, libexec/liascape/, lib/liascape/)."
echo "  App:  liascape"
echo "  CLI:  liascape restore | next | previous | random | volume up | kill | ctl state | help"
if [ -z "$DESTDIR" ]; then echo "  Ensure $BINDIR is on PATH."; fi  # (a bare `[ ] &&` made a DESTDIR install exit 1)
