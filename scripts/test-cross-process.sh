#!/usr/bin/env bash
# Hermetic test of read-modify-writes across liascape PROCESSES: the in-process locks (SettingsService's,
# LibraryStore's) don't reach the CLI or the daemons, so a keybind run locally (no backend answers) or
# `liascape restore`'s WE sync could lose an update another process saved meanwhile. Fires N concurrent
# `liascape volume-up` with no backend running — each one a local load → +5 → save of settings.json — and
# expects every step to land. Temp HOME + every XDG dir; never touches the real settings, a backend or a
# player (no serve.port → nothing to forward to; no player socket → the live push is a no-op).
#
# Usage: scripts/test-cross-process.sh [--no-build]
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs / screenshots and prints where (last line).
# Needs: dotnet (or DOTNET=…), jq. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/test-lock.sh" # one heavy test run at a time on this machine
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)  # physical path: a symlinked alias makes MSBuild delete its own outputs
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
. "$ROOT/scripts/test-no-network.sh"   # lp_no_lookup: a name that resolves inside fails the run
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
[ -n "${LIASCAPE_NETNS:-}" ] && BUILD=0   # built outside, before the namespace
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
command -v jq >/dev/null || { echo "missing: jq"; exit 2; }
DLL=$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll
if [ $BUILD = 1 ]; then
  "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }

# Everything from here on runs in its own network namespace (scripts/test-netns.sh, as this user): what the suite starts
# (the backend, the player, mpv, ffmpeg) reaches no real network and looks no name up, under the backend's own
# LIASCAPE_TEST_NO_NETWORK guard. exec'd in place: this pid keeps the test lock.
if [ -z "${LIASCAPE_NETNS:-}" ]; then
  NSD=$(mktemp -d /tmp/liascape-ns-XXXXXX)
  LIASCAPE_NETNS=$NSD exec unshare -rnm bash "$ROOT/scripts/test-netns.sh" --own-uid "$NSD" bash "${BASH_SOURCE[0]}" "$@"
fi
lp_netns_entered
lp_no_lookup "RESULT pass=0 fail=1" || exit 1
T=$(mktemp -d /tmp/liascape-xp-XXXXXX)
mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
DLL=$T/backend/liascape-backend.dll
mkdir -p "$T/home/.config/liascape" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st"
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export LIASCAPE_SECRETS=file # Helpers/SecretStore.cs: the Steam secrets never reach the session's keyring from a test
# the player: an `exit 1` stub, so no real liascape-player ever starts here
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT
cleanup() { rc=$?; lp_tmp_done "$T" /tmp/liascape-xp- "$rc"; }
trap cleanup EXIT
pass=0; fail=0
ok()  { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
SJ=$XDG_CONFIG_HOME/liascape/settings.json

N=16
for round in 1 2 3; do
  echo '{"Volume":0,"VolumeKeyTarget":"global","AutoMute":false}' > "$SJ"
  pids=()
  for _ in $(seq 1 $N); do "$DOTNET" "$DLL" volume-up >>"$T/cli.log" 2>&1 & pids+=($!); done
  codes=0; for p in "${pids[@]}"; do wait "$p" || codes=$((codes+1)); done
  v=$(jq -r '.Volume' "$SJ" 2>/dev/null)
  want=$((N*5))
  [ "$codes" = 0 ] || bad "round $round: $codes of $N command runs exited non-zero ($(tail -2 "$T/cli.log" | tr '\n' ' '))"
  if [ "$v" = "$want" ]; then ok "round $round: $N concurrent local volume-ups → $v"
  else bad "round $round: $N concurrent local volume-ups → $v, expected $want (lost $(( (want - ${v:-0}) / 5 )))"; fi
done
echo "RESULT pass=$pass fail=$fail"
[ $fail = 0 ]
