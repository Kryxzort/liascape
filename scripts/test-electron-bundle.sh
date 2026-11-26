#!/usr/bin/env bash
# Hermetic test of Liascape's own Electron outside Nix (.claude/rules/build-and-packaging.md § Electron): which Electron
# install.sh decides on, the copy it bundles into a temp prefix, and the one the installed launcher then runs.
#  dry-run:   `install.sh --dry-run` names the decision: the bundled copy with no Electron on PATH, a system `electron45`
#             stub when one is there, LIASCAPE_ELECTRON when set, nothing with LIASCAPE_BUNDLE_ELECTRON=0.
#  bundled:   PATH stripped of every electron / electron45, LIASCAPE_ELECTRON unset: the install step puts the lockfile's
#             Electron in <prefix>/lib/liascape/electron/ (a stale file planted there first is gone), and the installed
#             launcher starts that binary (ELECTRON_RUN_AS_NODE on a stub shell: it prints its version and path, no window),
#             also with a stub plain `electron` (another major, installed later) on PATH.
#  system:    a stub `electron45` on PATH: the install step bundles nothing and removes the copy a previous install left,
#             and the launcher runs the stub.
# Only the Electron step of install.sh runs (scripts/electron-bundle.sh, the one install.sh calls), not the full build.
# npm ci runs in a temp copy of app/shell's package.json + lockfile, with the user's npm and Electron download caches
# (a cached zip: no download). On NixOS the npm prebuilt can't find its libs, so the test alone runs it through nix-ld
# with nixpkgs' libs; a NixOS install never takes this path (the flake brings its own Electron).
#
# Usage: scripts/test-electron-bundle.sh    LIASCAPE_KEEP_TMP=1 keeps the temp folder.
# Needs: node, npm (and nix on NixOS). Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"
. "$ROOT/scripts/test-lock.sh"
for t in node npm timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done

T=$(mktemp -d /tmp/liascape-eb-XXXXXX)
cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-eb- "$rc"; }
trap cleanup EXIT INT TERM HUP

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
check() { local what=$1; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

WANT=$(node -e 'console.log(require(process.argv[1]).packages["node_modules/electron"].version)' "$ROOT/app/shell/package-lock.json")
NODE_DIR=$(dirname "$(command -v node)"); NPM_DIR=$(dirname "$(command -v npm)")

# PATH without any electron: every dir that holds one goes, node and npm come back first
STRIPPED="$NODE_DIR:$NPM_DIR"
IFS=: read -ra dirs <<< "$PATH"
for d in "${dirs[@]}"; do
  [ -n "$d" ] && [ ! -e "$d/electron" ] && [ ! -e "$d/electron45" ] && STRIPPED="$STRIPPED:$d"
done
for d in "$NODE_DIR" "$NPM_DIR"; do
  if [ -e "$d/electron" ] || [ -e "$d/electron45" ]; then echo "node's own dir $d holds an electron: can't strip it"; exit 2; fi
done
STUBS="$T/stubs"; mkdir -p "$STUBS"
printf '#!/bin/sh\necho "stub electron45 $*"\n' > "$STUBS/electron45"; chmod 755 "$STUBS/electron45"

# hermetic HOME; the npm and Electron download caches stay the user's (a cached zip, no network)
REAL_HOME=$HOME
run() {  # run <PATH> <command …>: no LIASCAPE_* from the caller, own HOME
  local p=$1; shift
  env -u LIASCAPE_ELECTRON -u LIASCAPE_BUNDLE_ELECTRON HOME="$T/home" PATH="$p" \
    npm_config_cache="${npm_config_cache:-$REAL_HOME/.npm}" \
    electron_config_cache="${electron_config_cache:-$REAL_HOME/.cache/electron}" "$@"
}
mkdir -p "$T/home"

echo "== dry-run decision"
out=$(run "$STRIPPED" bash "$ROOT/scripts/install.sh" --dry-run 2>&1); echo "$out" > "$T/dry-none.txt"
check "no electron on PATH → bundled Electron $WANT" grep -q "Electron: bundled Electron $WANT" <<< "$out"
out=$(run "$STUBS:$STRIPPED" bash "$ROOT/scripts/install.sh" --dry-run 2>&1); echo "$out" > "$T/dry-system.txt"
check "electron45 on PATH → that one, nothing bundled" grep -q "Electron: system electron45 ($STUBS/electron45), not bundled" <<< "$out"
out=$(run "$STRIPPED" env LIASCAPE_ELECTRON=/opt/e/electron bash "$ROOT/scripts/install.sh" --dry-run 2>&1)
check "LIASCAPE_ELECTRON set → that one, nothing bundled" grep -q "Electron: LIASCAPE_ELECTRON=/opt/e/electron, not bundled" <<< "$out"
out=$(run "$STRIPPED" env LIASCAPE_BUNDLE_ELECTRON=0 bash "$ROOT/scripts/install.sh" --dry-run 2>&1)
check "LIASCAPE_BUNDLE_ELECTRON=0 → nothing bundled" grep -q "Electron: not bundled (LIASCAPE_BUNDLE_ELECTRON=0)" <<< "$out"

# a prefix with the installed launcher and a stub shell (main.js prints which Electron runs it)
P="$T/prefix"; LIB="$P/lib/liascape"
install -Dm755 "$ROOT/scripts/liascape" "$P/bin/liascape"
mkdir -p "$LIB/shell"
echo '{"name":"stub-shell","main":"main.js"}' > "$LIB/shell/package.json"
echo 'console.log("electron=" + process.versions.electron + " exec=" + process.execPath)' > "$LIB/shell/main.js"
SHELLSRC="$T/shell-src"; mkdir -p "$SHELLSRC"
cp "$ROOT/app/shell/package.json" "$ROOT/app/shell/package-lock.json" "$SHELLSRC/"

# NixOS: the test's own way to run the npm prebuilt (nix-ld + nixpkgs' libs, from the flake's nixpkgs)
NIXLD=""
if [ -e /etc/NIXOS ]; then
  libs=$(cd "$ROOT" && nix build --no-link --print-out-paths --inputs-from . \
    nixpkgs#{glib.out,nspr.out,nss.out,at-spi2-core.out,cups.lib,dbus.lib,cairo.out,gtk3.out,pango.out,libx11.out,libxcomposite.out,libxdamage.out,libxext.out,libxfixes.out,libxrandr.out,libgbm.out,expat.out,libxcb.out,libxkbcommon.out,systemd.out,alsa-lib.out} 2>/dev/null) \
    || { echo "NixOS: couldn't build the prebuilt's libs"; exit 2; }
  NIXLD=$(printf '%s/lib:' $libs)
fi

echo "== bundled (no electron on PATH, LIASCAPE_ELECTRON unset)"
mkdir -p "$LIB/electron"; echo stale > "$LIB/electron/stale-from-last-install"
run "$STRIPPED" bash "$ROOT/scripts/electron-bundle.sh" install "$LIB" "$SHELLSRC" > "$T/install-bundled.log" 2>&1
check "install step succeeds" [ $? = 0 ]
check "the bundled copy is Electron $WANT" [ "$(cat "$LIB/electron/version" 2>/dev/null)" = "$WANT" ]
check "a reinstall leaves nothing of the last copy" [ ! -e "$LIB/electron/stale-from-last-install" ]
echo "    install size: $(du -sh "$LIB/electron" | cut -f1) ($(du -sb "$LIB/electron" | cut -f1) bytes)"
out=$(run "$STRIPPED" env ELECTRON_RUN_AS_NODE=1 ${NIXLD:+NIX_LD_LIBRARY_PATH="$NIXLD"} timeout 60 "$P/bin/liascape" 2>&1)
echo "$out" > "$T/launch-bundled.txt"; echo "    launcher: $out"
check "the launcher starts the bundled Electron $WANT" [ "$out" = "electron=$WANT exec=$LIB/electron/electron" ]
# a plain `electron` installed after the bundle may be another major: the bundled 45 keeps the window
OTHER="$T/other-electron"; mkdir -p "$OTHER"
printf '#!/bin/sh\necho "stub plain electron $*"\n' > "$OTHER/electron"; chmod 755 "$OTHER/electron"
out=$(run "$OTHER:$STRIPPED" env ELECTRON_RUN_AS_NODE=1 ${NIXLD:+NIX_LD_LIBRARY_PATH="$NIXLD"} timeout 60 "$P/bin/liascape" 2>&1)
echo "$out" > "$T/launch-bundled-vs-plain.txt"; echo "    launcher with a plain electron on PATH: $out"
check "a later plain electron on PATH doesn't take over from the bundled copy" [ "$out" = "electron=$WANT exec=$LIB/electron/electron" ]

echo "== system electron45 on PATH"
run "$STUBS:$STRIPPED" bash "$ROOT/scripts/electron-bundle.sh" install "$LIB" "$SHELLSRC" > "$T/install-system.log" 2>&1
check "install step succeeds" [ $? = 0 ]
check "nothing bundled, the previous copy removed" [ ! -e "$LIB/electron" ]
out=$(run "$STUBS:$STRIPPED" "$P/bin/liascape" 2>&1)
check "the launcher runs the system electron45" [ "$out" = "stub electron45 $LIB/shell" ]

echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
