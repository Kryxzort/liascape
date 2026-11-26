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

echo "==> the install tree, staged as AppDir/usr"
rm -rf "$APPDIR"
DESTDIR="$APPDIR" PREFIX=/usr bash "$ROOT/scripts/install.sh"

echo "==> Electron, from app/shell's lockfile"
# the npm package fetches its binary on first use, not at install: install.js fetches it now (checked against the
# package's checksums.json)
(cd "$ROOT/app/shell" && npm ci --no-audit --no-fund && node node_modules/electron/install.js) \
  || { echo "ERROR: couldn't get Electron (npm ci, then node_modules/electron/install.js, in app/shell)" >&2; exit 1; }
ELECTRON="$ROOT/app/shell/node_modules/electron/dist"
[ -x "$ELECTRON/electron" ] || { echo "ERROR: no Electron binary in $ELECTRON" >&2; exit 1; }
mkdir -p "$APPDIR/usr/lib/electron"
cp -a "$ELECTRON/." "$APPDIR/usr/lib/electron/"

echo "==> AppRun, the desktop entry and the icon"
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
# the image's own Electron, unless the user names another; the launcher resolves the rest from its own path
HERE="$(dirname "$(readlink -f "$0")")"
export LIASCAPE_ELECTRON="${LIASCAPE_ELECTRON:-$HERE/usr/lib/electron/electron}"
exec "$HERE/usr/bin/liascape" "$@"
APPRUN
chmod 755 "$APPDIR/AppRun"
# install.sh's entry and icon, at the image's root where appimagetool looks; Exec is a bare name (an AppImage has no fixed
# path, and desktop integration tools put the image's own path there)
sed 's|^Exec=.*|Exec=liascape|' "$APPDIR/usr/share/applications/liascape.desktop" > "$APPDIR/liascape.desktop"
cp "$APPDIR/usr/share/icons/hicolor/scalable/apps/liascape.svg" "$APPDIR/liascape.svg"
ln -sf liascape.svg "$APPDIR/.DirIcon"

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
