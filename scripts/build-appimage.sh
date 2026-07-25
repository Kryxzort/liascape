#!/bin/bash
# Portable, single-file AppImage — bundles EVERYTHING (backend, UI, electron, native helpers) so it
# runs on any glibc distro with no install and no sandbox (unlike Flatpak, whose sandbox breaks a
# wallpaper app's layer-shell + helper spawning). Reuses scripts/install.sh to build+stage the
# components, then adds a bundled electron and a relocatable AppRun.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDIR="$ROOT/AppDir"
APPIMAGETOOL="$ROOT/scripts/appimagetool"
OUTPUT="$ROOT/livepaper-x86_64.AppImage"

echo "==> staging app into AppDir (via install.sh)"
rm -rf "$APPDIR"
# Stage the full tree under AppDir/usr. install.sh's own /usr wrappers are ignored here — AppImages
# mount at a random path, so AppRun below launches with $APPDIR-relative paths instead.
DESTDIR="$APPDIR" PREFIX=/usr bash "$ROOT/scripts/install.sh"

LIB="$APPDIR/usr/lib/livepaper"

echo "==> bundling Electron (portable — no system electron needed)"
(cd "$ROOT/app/shell" && npm install >/dev/null 2>&1 || true)
ELECTRON_DIST="$ROOT/app/shell/node_modules/electron/dist"
[ -d "$ELECTRON_DIST" ] || { echo "ERROR: no bundled electron at $ELECTRON_DIST (npm install failed?)"; exit 1; }
mkdir -p "$APPDIR/usr/lib/electron"
cp -r "$ELECTRON_DIST"/. "$APPDIR/usr/lib/electron/"

echo "==> writing AppRun (relocatable — resolves paths from the mount point)"
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
LIB="$HERE/usr/lib/livepaper"
export LP_UI_DIR="$LIB/ui"
export LP_TRANSITIONS_DIR="$LIB/transitions"
[ -x "$LIB/lp-transition" ] && export LP_TRANSITION_BIN="$LIB/lp-transition"
[ -x "$LIB/lp-audio" ] && export LP_AUDIO_BIN="$LIB/lp-audio"
export LP_BACKEND="$LIB/backend/livepaper"
export LP_ELECTRON="$HERE/usr/lib/electron/electron"
# bare → GUI (electron shell); any flag → headless backend
if [ $# -eq 0 ]; then exec "$LP_ELECTRON" "$LIB/shell"; fi
exec "$LIB/backend/livepaper" "$@"
EOF
chmod +x "$APPDIR/AppRun"

echo "==> desktop entry + icon"
cat > "$APPDIR/livepaper.desktop" <<'EOF'
[Desktop Entry]
Name=Livepaper
Comment=Live wallpaper manager (Wayland)
Exec=livepaper
Icon=livepaper
Type=Application
Categories=Utility;
Keywords=wallpaper;live;wayland;video;
EOF
# SVG icon from the UI (no PNG in the rewrite); appimagetool accepts scalable icons.
if [ -f "$ROOT/app/ui/public/favicon.svg" ]; then
  cp "$ROOT/app/ui/public/favicon.svg" "$APPDIR/livepaper.svg"
  ln -sf livepaper.svg "$APPDIR/.DirIcon"
fi

echo "==> fetching appimagetool if needed"
if ! command -v appimagetool &>/dev/null && [ ! -x "$APPIMAGETOOL" ]; then
  wget -q --show-progress \
    "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" \
    -O "$APPIMAGETOOL"
  chmod +x "$APPIMAGETOOL"
fi
TOOL="$(command -v appimagetool 2>/dev/null || echo "$APPIMAGETOOL")"

echo "==> packaging AppImage"
ARCH=x86_64 "$TOOL" "$APPDIR" "$OUTPUT"
echo ""
echo "Done: $OUTPUT"
