#!/bin/bash
# Single build+install engine for livepaper (the Electron+React UI over the headless C# backend).
# Used directly for a user install AND reused by packaging (PKGBUILD, build-appimage.sh) so the build
# lives in ONE place — a code change (new file/dep/helper) only needs updating here, and every
# package inherits it. (The Nix flake is the one exception: it's declarative and builds separately.)
#
# Knobs (env):
#   PREFIX       runtime install prefix        (default: $HOME/.local; packages use /usr)
#   DESTDIR      staging root for packaging     (default: empty; PKGBUILD/AppImage set $pkgdir/$AppDir)
#   LIASCAPE_ELECTRON  electron binary the GUI runs   (default: 'electron' on PATH; AppImage sets a bundled one)
#   SKIP_BUILD   1 = don't compile, only stage  (unused split; reserved)
#
# Options:
#   --no-scenes  build without Wallpaper Engine scene support under liascape-player (no LWE core, no
#                cmake/SDL2/freetype/glm/lz4 needed): liascape-scene-worker plays nothing but test scenes
#
# Paths: everything is staged under $DESTDIR but the wrappers reference the RUNTIME paths ($PREFIX...),
# so a packaged tree works once installed to $PREFIX regardless of where it was staged.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"  # physical path: a symlinked alias makes MSBuild delete its own outputs

NO_SCENES=0
for arg in "$@"; do
  case "$arg" in
    --no-scenes) NO_SCENES=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option '$arg' (see --help)" >&2; exit 2 ;;
  esac
done

PREFIX="${PREFIX:-$HOME/.local}"
DESTDIR="${DESTDIR:-}"
LIBDIR="$PREFIX/lib/livepaper"           # runtime location of backend + ui + shell + helpers
BINDIR="$PREFIX/bin"
APPSDIR="$PREFIX/share/applications"
# Fixed (NOT $PREFIX-relative) shared-assets location — matches the hardcoded candidate dir
# TransitionService.cs and liascape-player's Catalogue::resolve_dir already fall back to for
# transitions/binaries installed outside the main $PREFIX tree.
WEBDIR="$HOME/.local/share/livepaper-web"
# staging (where we write now) = $DESTDIR + runtime path
S_LIB="$DESTDIR$LIBDIR"
S_BIN="$DESTDIR$BINDIR"
S_APPS="$DESTDIR$APPSDIR"
S_WEB="$DESTDIR$WEBDIR"

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
    NixOS:  use the flake instead — 'nix run github:Kryxzort/livepaper-pro' (all deps handled)
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
    NixOS:  use the flake instead — 'nix run github:Kryxzort/livepaper-pro' (all deps handled)
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

if [ "$NO_SCENES" = 0 ]; then
  # fetched into ~/.cache/livepaper/src (git clone, once per pin), built in $ROOT/build/
  echo "==> building LWE core (Wallpaper Engine scenes) → $WEBDIR/lib"
  LWE_CORE="$ROOT/build/lwe-core"
  LIASCAPE_LWE_CORE_DIR="$LWE_CORE" bash "$ROOT/scripts/lwe.sh" fetch prepare build check
  mkdir -p "$S_WEB/lib"
  find "$S_WEB/lib" -maxdepth 1 -name 'liblinux-wallpaperengine-core.so*' -delete
  cp -P "$LWE_CORE"/lib/liblinux-wallpaperengine-core.so* "$S_WEB/lib/"
  echo "==> building liascape-player + liascape-scene-worker (Rust compositor) → $WEBDIR/bin"
  # the worker finds the core next to it at runtime ($WEBDIR/bin/../lib), not in the build tree
  (cd "$ROOT" && LIASCAPE_LWE_CORE_DIR="$LWE_CORE" LIASCAPE_LWE_RPATH='$ORIGIN/../lib' \
    cargo build --release --locked --manifest-path src/player/Cargo.toml)
else
  echo "==> building liascape-player + liascape-scene-worker without scene support (--no-scenes) → $WEBDIR/bin"
  (cd "$ROOT" && cargo build --release --locked --no-default-features --manifest-path src/player/Cargo.toml)
fi
install -Dm755 "$ROOT/src/player/target/release/liascape-player" "$S_WEB/bin/liascape-player"
install -Dm755 "$ROOT/src/player/target/release/liascape-scene-worker" "$S_WEB/bin/liascape-scene-worker"

echo "==> ensuring Electron is available for the GUI"
# The GUI runs: <electron> <shell-dir>. By default use a system 'electron' (PATH) — the bundled
# prebuilt can't load its libs on some distros (NixOS) and pulls 200MB. Packages provide electron
# their own way: AUR depends=(electron); AppImage bundles one and sets LIASCAPE_ELECTRON. Only warn here.
if [ -z "$LIASCAPE_ELECTRON" ] && ! command -v electron >/dev/null 2>&1; then
  echo "    WARN: no 'electron' on PATH — install it (Arch: electron / Debian: apt has none, use the AppImage)"
  echo "          or set LIASCAPE_ELECTRON=/path/to/electron. The CLI works without it; only the GUI needs it."
fi

mkdir -p "$S_BIN"
echo "==> installing 'livepaper' (bare = GUI; flags = headless CLI)"
cat > "$S_BIN/livepaper" <<WRAP
#!/bin/bash
export LIASCAPE_UI_DIR="$LIBDIR/ui"
export LIASCAPE_TRANSITIONS_DIR="$LIBDIR/transitions"
[ -x "$LIBDIR/liascape-transition" ] && export LIASCAPE_TRANSITION_BIN="$LIBDIR/liascape-transition"
[ -x "$LIBDIR/liascape-audio" ] && export LIASCAPE_AUDIO_BIN="$LIBDIR/liascape-audio"
[ -x "$WEBDIR/bin/liascape-player" ] && export LIASCAPE_PLAYER_BIN="$WEBDIR/bin/liascape-player"
[ \$# -eq 0 ] && exec "$BINDIR/livepaper-ui"
exec "$LIBDIR/backend/livepaper" "\$@"
WRAP
chmod 755 "$S_BIN/livepaper"

echo "==> installing 'livepaper-ui' (GUI)"
cat > "$S_BIN/livepaper-ui" <<WRAP
#!/bin/bash
export LIASCAPE_BACKEND="$LIBDIR/backend/livepaper"
export LIASCAPE_UI_DIR="$LIBDIR/ui"
export LIASCAPE_TRANSITIONS_DIR="$LIBDIR/transitions"
[ -x "$LIBDIR/liascape-transition" ] && export LIASCAPE_TRANSITION_BIN="$LIBDIR/liascape-transition"
[ -x "$LIBDIR/liascape-audio" ] && export LIASCAPE_AUDIO_BIN="$LIBDIR/liascape-audio"
[ -x "$WEBDIR/bin/liascape-player" ] && export LIASCAPE_PLAYER_BIN="$WEBDIR/bin/liascape-player"
exec "\${LIASCAPE_ELECTRON:-electron}" "$LIBDIR/shell"
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
if [ -z "$DESTDIR" ]; then echo "  Ensure $BINDIR is on PATH."; fi  # (a bare `[ ] &&` made a DESTDIR install exit 1)
