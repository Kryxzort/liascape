#!/bin/bash
# liascape-x86_64.AppImage: one file that runs on any glibc distro with nothing installed and no sandbox (a Flatpak's
# sandbox would cut a wallpaper app off from layer-shell and from starting its own helpers). It holds the tree
# scripts/install.sh builds (staged as AppDir/usr), Electron from app/shell's lockfile, and an AppRun that points
# scripts/liascape at that Electron; the launcher finds everything else relative to itself, wherever the image mounts.
#
# Usage: scripts/build-appimage.sh [--help]
#   Writes liascape-x86_64.AppImage at the repo root. Needs what install.sh needs, plus npm, and appimagetool on PATH
#   (else it is fetched once to scripts/appimagetool, which git ignores).
set -euo pipefail

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "build-appimage.sh: unknown option '$1' (see --help)" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"  # physical path: a symlinked alias makes MSBuild delete its own outputs
APPDIR="$ROOT/AppDir"
IMAGE="$ROOT/liascape-x86_64.AppImage"

echo "==> the install tree, staged as AppDir/usr, with Electron from app/shell's lockfile"
rm -rf "$APPDIR"
# the image's own Electron always, whatever the build machine has: it must run where nothing is installed
DESTDIR="$APPDIR" PREFIX=/usr LIASCAPE_BUNDLE_ELECTRON=1 bash "$ROOT/scripts/install.sh"
[ -x "$APPDIR/usr/lib/liascape/electron/electron" ] || { echo "ERROR: install.sh bundled no Electron" >&2; exit 1; }

echo "==> AppRun, the desktop entry and the icon"
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
# the image's own Electron, unless the user names another; the launcher resolves the rest from its own path
HERE="$(dirname "$(readlink -f "$0")")"
export LIASCAPE_ELECTRON="${LIASCAPE_ELECTRON:-$HERE/usr/lib/liascape/electron/electron}"
exec "$HERE/usr/bin/liascape" "$@"
APPRUN
chmod 755 "$APPDIR/AppRun"
# install.sh's entry and icon, at the image's root where appimagetool looks; Exec is a bare name (an AppImage has no fixed
# path, and desktop integration tools put the image's own path there)
sed 's|^Exec=.*|Exec=liascape|' "$APPDIR/usr/share/applications/liascape.desktop" > "$APPDIR/liascape.desktop"
cp "$APPDIR/usr/share/icons/hicolor/scalable/apps/liascape.svg" "$APPDIR/liascape.svg"
# .DirIcon (the image's own icon, what file managers show for it) must be a PNG: appimagetool reports an SVG one as an
# error and says a later release will refuse to build with it. The icon's PNG is committed beside its SVG
# (app/icon/generate.py draws both), so the build needs no SVG renderer.
cp "$ROOT/app/icon/liascape-night-256.png" "$APPDIR/.DirIcon"

TOOL="$(command -v appimagetool || true)"
if [ -z "$TOOL" ]; then
  TOOL="$ROOT/scripts/appimagetool"
  if [ ! -x "$TOOL" ]; then
    echo "==> appimagetool (not on PATH): fetching it to scripts/appimagetool"
    curl -fL --progress-bar -o "$TOOL.part" \
      https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
    chmod 755 "$TOOL.part" && mv "$TOOL.part" "$TOOL"
  fi
fi

echo "==> packing"
ARCH=x86_64 "$TOOL" "$APPDIR" "$IMAGE"
echo "built $IMAGE"
