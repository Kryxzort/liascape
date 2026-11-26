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
#   LIBEXECDIR         the internal executables go in $LIBEXECDIR/liascape (default: $PREFIX/libexec; the PKGBUILD sets
#                      /usr/lib, Arch's place for them, so they sit in lib/liascape/ beside backend/ and ui/)
#   LIASCAPE_ELECTRON  read at RUNTIME by `liascape`, first in its order: LIASCAPE_ELECTRON, then `electron45`, then
#                      the copy in lib/liascape/electron/, then `electron` on PATH. Set (or `electron45` / `electron` on
#                      PATH) at install time, nothing is bundled.
#   LIASCAPE_BUNDLE_ELECTRON  auto (default: bundle app/shell's lockfile Electron into lib/liascape/electron/ only when
#                      none of the above is there) | 1: always (the AppImage) | 0: never (the PKGBUILD)
#
# Options:
#   --no-scenes  build without Wallpaper Engine scene support under liascape-player (no LWE core, no
#                cmake/SDL2/freetype/glm/lz4 needed): liascape-scene-worker plays nothing but test scenes
#   --dry-run    print the layout it would install, build nothing
#
# Layout (scripts/liascape finds everything relative to itself, so a staged tree works wherever it lands):
#   $PREFIX/bin/liascape                    the one command (bare = the app, `liascape help` = the CLI)
#   $LIBEXECDIR/liascape/                   liascape-backend (→ lib/liascape/backend/), liascape-player,
#                                           liascape-scene-worker
#   $PREFIX/lib/liascape/                   backend/ ui/ shell/ transitions/ + LWE's core library
#                                           (+ electron/ when bundled, scripts/electron-bundle.sh)
#   $PREFIX/share/applications/liascape.desktop
#   $PREFIX/share/icons/hicolor/scalable/apps/liascape.svg   (app/ui/public/favicon.svg: one icon for the page, the
#                                           desktop entry and the AppImage)
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"  # physical path: a symlinked alias makes MSBuild delete its own outputs

NO_SCENES=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --no-scenes) NO_SCENES=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option '$arg' (see --help)" >&2; exit 2 ;;
  esac
done

PREFIX="${PREFIX:-$HOME/.local}"
DESTDIR="${DESTDIR:-}"
BINDIR="$PREFIX/bin"
LIBEXEC="${LIBEXECDIR:-$PREFIX/libexec}/liascape"   # the internal executables — never on PATH
LIBDIR="$PREFIX/lib/liascape"        # backend + ui + shell + transitions + LWE's core
APPSDIR="$PREFIX/share/applications"
# staging (where we write now) = $DESTDIR + runtime path
S_BIN="$DESTDIR$BINDIR"
S_LIBEXEC="$DESTDIR$LIBEXEC"
S_LIB="$DESTDIR$LIBDIR"
S_APPS="$DESTDIR$APPSDIR"
S_ICONS="$DESTDIR$PREFIX/share/icons/hicolor/scalable/apps"

if [ "$DRY" = 1 ]; then
  cat <<EOF
install.sh --dry-run (PREFIX=$PREFIX${DESTDIR:+, staged under $DESTDIR}$([ "$NO_SCENES" = 1 ] && echo ", no scenes")):
  $S_BIN/liascape
  $S_LIBEXEC/liascape-backend -> $(realpath -ms --relative-to="$LIBEXEC" "$LIBDIR/backend/liascape-backend")
  $S_LIBEXEC/liascape-player
  $S_LIBEXEC/liascape-scene-worker$([ "$NO_SCENES" = 1 ] && echo "   (test scenes only)")
  $S_LIB/backend/   (dotnet publish, self-contained)
  $S_LIB/ui/  $S_LIB/shell/  $S_LIB/transitions/
$([ "$NO_SCENES" = 0 ] && echo "  $S_LIB/liblinux-wallpaperengine-core.so*")
  $S_APPS/liascape.desktop
  $S_ICONS/liascape.svg
  Electron: $(bash "$ROOT/scripts/electron-bundle.sh" describe)
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

# liascape-player (Rust) links libmpv, wayland-client/-egl, EGL and PipeWire (its crates find them with pkg-config), links
# through cc and runs bindgen (needs libclang). Preflight exactly that and fail loudly with a fix, before any
# build/publish side effect below.
echo "==> checking native build toolchain (liascape-player)"
missing=""
command -v cc            >/dev/null 2>&1 || missing="$missing cc"
command -v pkg-config    >/dev/null 2>&1 || missing="$missing pkg-config"
if command -v pkg-config >/dev/null 2>&1; then
  for p in wayland-client wayland-egl egl mpv libpipewire-0.3; do
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
  liascape-player (the Wayland wallpaper compositor) is built from source — install these and re-run:
    Arch:   sudo pacman -S base-devel wayland libglvnd mpv pipewire clang
    Debian: sudo apt install build-essential pkg-config libwayland-dev libegl-dev libmpv-dev libpipewire-0.3-dev libclang-dev
    Fedora: sudo dnf install gcc pkgconf wayland-devel mesa-libEGL-devel mpv-libs-devel pipewire-devel clang-devel
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
# npm ci: exactly the lockfile, so a package build gets the dependency tree the repo was tested with
(cd "$ROOT/app/ui" && npm ci && npm run build)

echo "==> publishing backend (self-contained) → $LIBDIR/backend"
rm -rf "$S_LIB/backend"; mkdir -p "$S_LIB" "$S_LIBEXEC"
dotnet publish "$ROOT/src/backend" -r linux-x64 --self-contained -c Release -o "$S_LIB/backend"
# the apphost finds its runtime from its real path (/proc/self/exe), so a symlink in libexec is enough
ln -sfn "$(realpath -ms --relative-to="$LIBEXEC" "$LIBDIR/backend/liascape-backend")" "$S_LIBEXEC/liascape-backend"

echo "==> staging UI"
rm -rf "$S_LIB/ui"; mkdir -p "$S_LIB/ui"; cp -r "$ROOT/app/ui/dist/." "$S_LIB/ui/"

echo "==> staging Electron shell (self-contained — no repo dependency at runtime)"
rm -rf "$S_LIB/shell"; mkdir -p "$S_LIB/shell"
# electron provides its own runtime; the shell needs only its runtime JS, not node_modules or the UI matrix's probes
shell_files="$(bash "$ROOT/scripts/shell-runtime-files.sh" "$ROOT/app/shell")"
while read -r f; do install -Dm644 "$ROOT/app/shell/$f" "$S_LIB/shell/$f"; done <<< "$shell_files"

echo "==> staging transition assets (shaders + manifest + preview frames)"
rm -rf "$S_LIB/transitions"; mkdir -p "$S_LIB/transitions"; cp -r "$ROOT/transitions/." "$S_LIB/transitions/"

if [ "$NO_SCENES" = 0 ]; then
  # fetched into ~/.cache/liascape/src (git clone, once per pin), built in $ROOT/build/
  echo "==> building LWE core (Wallpaper Engine scenes) → $LIBDIR"
  LWE_CORE="$ROOT/build/lwe-core"
  LIASCAPE_LWE_CORE_DIR="$LWE_CORE" bash "$ROOT/scripts/lwe.sh" fetch prepare build check
  find "$S_LIB" -maxdepth 1 -name 'liblinux-wallpaperengine-core.so*' -delete
  cp -P "$LWE_CORE"/lib/liblinux-wallpaperengine-core.so* "$S_LIB/"
  echo "==> building liascape-player + liascape-scene-worker (Rust compositor) → $LIBEXEC"
  # the worker finds the core at runtime from libexec/liascape/ → lib/liascape/ (or beside it), not in the build tree
  core_rel="$(realpath -ms --relative-to="$LIBEXEC" "$LIBDIR")"
  if [ "$core_rel" = . ]; then core_rpath='$ORIGIN'; else core_rpath="\$ORIGIN/$core_rel"; fi
  (cd "$ROOT" && LIASCAPE_LWE_CORE_DIR="$LWE_CORE" LIASCAPE_LWE_RPATH="$core_rpath" \
    cargo build --release --locked --manifest-path src/player/Cargo.toml)
else
  echo "==> building liascape-player + liascape-scene-worker without scene support (--no-scenes) → $LIBEXEC"
  (cd "$ROOT" && cargo build --release --locked --no-default-features --manifest-path src/player/Cargo.toml)
fi
install -Dm755 "$ROOT/src/player/target/release/liascape-player" "$S_LIBEXEC/liascape-player"
install -Dm755 "$ROOT/src/player/target/release/liascape-scene-worker" "$S_LIBEXEC/liascape-scene-worker"

echo "==> Electron for the GUI"
# The GUI runs: <electron> <shell-dir>. The system's Electron when there is one (LIASCAPE_ELECTRON, electron45, electron);
# else app/shell's lockfile Electron goes into lib/liascape/electron/, the way Discord or VS Code bring their own. A
# reinstall replaces that copy (or removes it once a system one is there). NixOS never gets here: the flake brings its
# own. Guard: scripts/test-electron-bundle.sh
bash "$ROOT/scripts/electron-bundle.sh" install "$S_LIB"

# OPTIONAL: secret-tool (libsecret) keeps the Steam sign-in in the system keyring (Helpers/SecretStore.cs); without it (or
# without a keyring) the sign-in goes to ~/.config/liascape/steam-auth.json (0600). Only a note.
if ! command -v secret-tool >/dev/null 2>&1; then
  echo "    NOTE: no 'secret-tool' — install libsecret (Arch: libsecret / Debian: libsecret-tools / Fedora: libsecret) to keep"
  echo "          the Steam sign-in in the system keyring; without it it is kept in ~/.config/liascape/steam-auth.json (0600)."
fi

echo "==> installing 'liascape' (bare = the app; 'liascape help' = the CLI)"
install -Dm755 "$ROOT/scripts/liascape" "$S_BIN/liascape"

mkdir -p "$S_APPS"
cat > "$S_APPS/liascape.desktop" <<EOF
[Desktop Entry]
Name=Liascape
Comment=Live wallpaper manager (Wayland)
Exec=$BINDIR/liascape
Icon=liascape
Type=Application
Categories=Utility;
Keywords=wallpaper;live wallpaper;animated;video;scene;Wallpaper Engine;Wayland;
StartupWMClass=liascape
EOF
# only for a direct install: in a package the cache belongs to the system (its package manager rebuilds it), and a staged
# mimeinfo.cache would clash with the one already on disk
if [ -z "$DESTDIR" ]; then update-desktop-database "$S_APPS" 2>/dev/null || true; fi
install -Dm644 "$ROOT/app/ui/public/favicon.svg" "$S_ICONS/liascape.svg"
if [ -z "$DESTDIR" ]; then gtk-update-icon-cache -qtf "$PREFIX/share/icons/hicolor" 2>/dev/null || true; fi

echo ""
echo "Done. Installed to $PREFIX (bin/liascape, $LIBEXEC, lib/liascape/)."
echo "  App:  liascape"
echo "  CLI:  liascape restore | next | previous | random | volume up | kill | ctl state | help"
if [ -z "$DESTDIR" ]; then echo "  Ensure $BINDIR is on PATH."; fi  # (a bare `[ ] &&` made a DESTDIR install exit 1)
