#!/bin/bash
# Portable, single-file AppImage — bundles EVERYTHING (backend, UI, electron, liascape-player) so it
# runs on any glibc distro with no install and no sandbox (unlike Flatpak, whose sandbox breaks a
# wallpaper app's layer-shell + helper spawning). Reuses scripts/install.sh to build+stage the
# components, then adds a bundled electron and a relocatable AppRun.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"  # physical path: a symlinked alias makes MSBuild delete its own outputs
APPDIR="$ROOT/AppDir"
APPIMAGETOOL="$ROOT/scripts/appimagetool"
OUTPUT="$ROOT/liascape-x86_64.AppImage"

echo "==> staging app into AppDir (via install.sh)"
rm -rf "$APPDIR"
# Stage the full tree under AppDir/usr. AppImages mount at a random path — fine: usr/bin/liascape
# resolves libexec/ and lib/ relative to itself; AppRun only adds the bundled electron.
DESTDIR="$APPDIR" PREFIX=/usr bash "$ROOT/scripts/install.sh"

echo "==> bundling Electron (portable — no system electron needed)"
# the lockfile's Electron (app/shell/package.json, the same major as the flake's). Its npm package has no install script:
# it fetches its binary into node_modules/electron/dist on first run, so fetch it here (its `install-electron` bin;
# checked against the package's checksums.json)
(cd "$ROOT/app/shell" && npm ci --no-audit --no-fund && node node_modules/electron/install.js) \
  || { echo "ERROR: couldn't install the bundled electron (npm ci / install-electron in app/shell)"; exit 1; }
ELECTRON_DIST="$ROOT/app/shell/node_modules/electron/dist"
[ -x "$ELECTRON_DIST/electron" ] || { echo "ERROR: no bundled electron at $ELECTRON_DIST"; exit 1; }
mkdir -p "$APPDIR/usr/lib/electron"
cp -r "$ELECTRON_DIST"/. "$APPDIR/usr/lib/electron/"

echo "==> writing AppRun (relocatable — resolves paths from the mount point)"
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
# the AppImage's own electron; scripts/liascape (usr/bin) finds everything else relative to itself
HERE="$(dirname "$(readlink -f "$0")")"
export LIASCAPE_ELECTRON="${LIASCAPE_ELECTRON:-$HERE/usr/lib/electron/electron}"
exec "$HERE/usr/bin/liascape" "$@"
EOF
chmod +x "$APPDIR/AppRun"

echo "==> desktop entry + icon"
cat > "$APPDIR/liascape.desktop" <<'EOF'
[Desktop Entry]
Name=Liascape
Comment=Live wallpaper manager (Wayland)
Exec=liascape
Icon=liascape
Type=Application
Categories=Utility;
Keywords=wallpaper;live;wayland;video;
EOF
# SVG icon from the UI (no PNG in the rewrite); appimagetool accepts scalable icons.
if [ -f "$ROOT/app/ui/public/favicon.svg" ]; then
  cp "$ROOT/app/ui/public/favicon.svg" "$APPDIR/liascape.svg"
  ln -sf liascape.svg "$APPDIR/.DirIcon"
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
