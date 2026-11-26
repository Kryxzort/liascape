#!/bin/bash
# Liascape's own Electron, for a system that has none (.claude/rules/build-and-packaging.md § Electron). install.sh runs
# it; the AppImage gets its copy through install.sh too (LIASCAPE_BUNDLE_ELECTRON=1).
#
#   electron-bundle.sh decide        which Electron the installed launcher will run, one line:
#                                    `env <path>` | `system <name> <path>` | `bundle <version>` | `none`
#   electron-bundle.sh describe      that decision in words (install.sh --dry-run prints it)
#   electron-bundle.sh install <lib-dir> [<shell-dir>]
#                                    remove <lib-dir>/electron, then, when `decide` says bundle, put the Electron of
#                                    <shell-dir>'s lockfile (default app/shell) there
#
# The launcher's order (scripts/liascape): LIASCAPE_ELECTRON, then `electron45`, then the copy in lib/liascape/electron/,
# then a plain `electron` on PATH. The copy is installed only when none of LIASCAPE_ELECTRON, `electron45` and `electron`
# is there at install time; once it is, a plain `electron` installed later (maybe another major) doesn't take over.
#   LIASCAPE_BUNDLE_ELECTRON  auto (default): as above | 1: always (the AppImage) | 0: never (the PKGBUILD, which
#                             depends on electron45 and builds offline)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

lock_version() {  # the electron version a shell dir's lockfile pins: the one supported major
  node -e 'const l=require(process.argv[1]); console.log(l.packages["node_modules/electron"].version)' \
    "$(cd "$1" && pwd -P)/package-lock.json"
}

decide() {
  case "${LIASCAPE_BUNDLE_ELECTRON:-auto}" in
    1) echo "bundle $(lock_version "$ROOT/app/shell")"; return ;;
    0) echo none; return ;;
    auto) ;;
    *) echo "electron-bundle.sh: LIASCAPE_BUNDLE_ELECTRON must be auto, 1 or 0" >&2; exit 2 ;;
  esac
  local n p
  if [ -n "${LIASCAPE_ELECTRON:-}" ]; then echo "env $LIASCAPE_ELECTRON"; return; fi
  for n in electron45 electron; do
    if p="$(command -v "$n" 2>/dev/null)"; then echo "system $n $p"; return; fi
  done
  echo "bundle $(lock_version "$ROOT/app/shell")"
}

describe() {
  local d; d="$(decide)"
  case "$d" in
    env\ *) echo "LIASCAPE_ELECTRON=${d#env }, not bundled" ;;
    system\ *) set -- $d; echo "system $2 ($3), not bundled" ;;
    bundle\ *) echo "bundled Electron ${d#bundle } into lib/liascape/electron/" ;;
    none) echo "not bundled (LIASCAPE_BUNDLE_ELECTRON=0)" ;;
  esac
}

install_bundle() {
  local lib="$1" shell="${2:-$ROOT/app/shell}" want got
  # a reinstall never keeps an older copy: it goes first, and comes back only when this install still bundles
  rm -rf "$lib/electron"
  case "$(decide)" in
    bundle\ *) ;;
    *) echo "    Electron: $(describe)"; return ;;
  esac
  want="$(lock_version "$shell")"
  echo "    Electron: bundling Electron $want → $lib/electron"
  # the npm package fetches its binary on first use, not at install: install.js fetches it now (checked against the
  # package's checksums.json)
  (cd "$shell" && npm ci --no-audit --no-fund && node node_modules/electron/install.js) \
    || { echo "ERROR: couldn't get Electron (npm ci, then node_modules/electron/install.js, in $shell)" >&2; exit 1; }
  got="$(cat "$shell/node_modules/electron/dist/version" 2>/dev/null || true)"
  [ -x "$shell/node_modules/electron/dist/electron" ] && [ "$got" = "$want" ] \
    || { echo "ERROR: $shell/node_modules/electron/dist holds Electron '${got:-nothing}', not $want" >&2; exit 1; }
  mkdir -p "$lib/electron"
  cp -a "$shell/node_modules/electron/dist/." "$lib/electron/"
}

case "${1:-}" in
  decide) decide ;;
  describe) describe ;;
  install) [ -n "${2:-}" ] || { echo "usage: electron-bundle.sh install <lib-dir> [<shell-dir>]" >&2; exit 2; }
           install_bundle "$2" "${3:-}" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
