#!/bin/bash
# Installs the app icon into a hicolor theme: the scalable SVG plus PNGs at the sizes launchers ask for, all drawn by
# app/icon/generate.py and committed (no build needs an SVG renderer). The one list of icon files: install.sh (and so the
# PKGBUILD and the AppImage) and the flake all call this.
# Usage: scripts/install-icons.sh <share/icons dir> [icon source dir, default app/icon]
set -e
DEST=${1:?usage: install-icons.sh <share/icons dir> [icon source dir]}
SRC=${2:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/app/icon"}
install -Dm644 "$SRC/liascape-night.svg" "$DEST/hicolor/scalable/apps/liascape.svg"
for n in 48 64 128 256 512; do
  install -Dm644 "$SRC/liascape-night-$n.png" "$DEST/hicolor/${n}x${n}/apps/liascape.png"
done
