#!/usr/bin/env bash
# Print the Electron shell files an installed app needs, one name per line (relative to the shell dir): package.json,
# its "main", the preload, and every local module they reach through require("./…"). Everything else in app/shell
# (probe-*.js, cdp.js, drive.js and the other UI-matrix helpers) is test-only and stays out of an install.
# install.sh and the flake's shellSrc both stage exactly this list, so a new runtime module is picked up by following its
# require() and never needs listing anywhere.
#   bash scripts/shell-runtime-files.sh [<shell dir>]   (default: app/shell beside this script)
set -euo pipefail
DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../app/shell" && pwd -P)}"
cd "$DIR"

main="$(sed -n 's/^ *"main": *"\([^"]*\)".*/\1/p' package.json)"
[ -n "$main" ] || { echo "shell-runtime-files.sh: no \"main\" in $DIR/package.json" >&2; exit 1; }

declare -A seen=()
queue=(package.json "$main")
# files a module loads by path rather than require(): path.join(__dirname, "<file>")
mapfile -t found < <(sed -n 's/.*path\.join(__dirname, *"\([^"]*\)").*/\1/p' "$main")
queue+=("${found[@]}")

while [ "${#queue[@]}" -gt 0 ]; do
  f="${queue[0]}"; queue=("${queue[@]:1}")
  f="${f#./}"
  case "$f" in *.js|*.json) ;; *) f="$f.js" ;; esac
  [ -n "${seen[$f]:-}" ] && continue
  [ -f "$f" ] || { echo "shell-runtime-files.sh: $DIR/$f is required but missing" >&2; exit 1; }
  seen[$f]=1
  echo "$f"
  case "$f" in
    *.js) mapfile -t found < <(grep -o 'require("\./[^"]*")' "$f" | sed 's/require("\(.*\)")/\1/')
          queue+=("${found[@]}") ;;
  esac
done
