#!/usr/bin/env bash
# Hermetic integration test of the backend's liascape-player adapter (PlayerEngine=liascape-player).
# See .claude/rules/player-adapter.md § Integration test.
#
# It runs the REAL `liascape serve` backend against a PRIVATE `liascape-player serve --headless --clock
# real --ao null` (SUPERVISED — `$SP` is the supervisor, `$CP`/`comp_pid` is its compositor child, see
# player-core.md § Supervisor) and drives everything over HTTP, checking the result with `liascape-player ctl`:
#   apply + transitions · every live setting · mute · pause (incl. an in-flight transition's pending B) ·
#   volume± · /preview · per-item overrides (incl. a pending B's own override) · timed rotation with
#   align:end · /next mid-wait · /stop · a SIGSTOPped COMPOSITOR (/settings must still answer < 500 ms) ·
#   a kill -9 of the COMPOSITOR → a supervised restart (new hello.pid, same supervisor) · switching the
#   engine liascape-player → legacy with nothing playing · Phase 2 scenes (synthetic scene items: apply, every live
#   setting, scene fps, V→S/S→S/S→V, a crashing scene → marked + skipped + advanced, a missing folder, no worker) ·
#   auto-mute never hearing our own switches (the one section with real audio: a private PipeWire + pipewire-pulse) ·
#   Phase 3 Task 8: the app closed (the program rotates alone, no timer/restart daemon, none of legacy's daemon files
#   ever written), keybinds as one-shot CLI processes with no backend (a 10× `next` storm, every action), `liascape
#   restore` × the playlist start mode (it starts the player `serve --restore --session-start` through a headless shim).
#
# Hermetic: its own temp HOME / XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME / XDG_RUNTIME_DIR /
# XDG_STATE_HOME (so its own settings.json, library, liascape-player socket + event log) and its own random
# backend port. It never talks to another backend (e.g. the dev one on :5174), never reads the real
# settings.json, never connects to the real liascape-player socket, never starts or kills mpvpaper (it aborts
# before any playback call unless the backend reports `active: liascape-player`). Display/compositor env is
# unset; audio is `--ao null` (but the auto-mute section's, on its own private PipeWire). Everything it started is stopped and its temp dir removed on every exit
# path (EXIT/INT/TERM/HUP trap; a SIGSTOPped compositor is SIGCONTed first; cleanup kills the SUPERVISOR
# `$SP` — never just a compositor pid, which would only make it restart again).
#
# Usage (from anywhere; uses the binaries of the tree this script lives in):
#   scripts/test-liascape-player-adapter.sh             # builds liascape-player (cargo, via the flake devShell when
#                                                 # `nix` exists) + the backend (dotnet build), then tests
#   scripts/test-liascape-player-adapter.sh --no-build  # use what's built (e.g. a tree `dotnet watch` owns)
# Needs: dotnet (or DOTNET=/path/to/dotnet), ffmpeg, jq, curl, python3. Exit 0 = all pass.
# Last line: `RESULT pass=N fail=M`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)  # physical path: a symlinked alias (/home → /mnt/…) makes MSBuild delete its own outputs
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
for t in ffmpeg jq curl python3; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
B=$ROOT/src/player/target/debug/liascape-player
# LIASCAPE_IT_DLL: another backend build to test (e.g. an older commit's, for a RED run of new checks)
DLL=${LIASCAPE_IT_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}

if [ $BUILD = 1 ]; then
  echo "== build"
  if command -v nix >/dev/null; then
    (cd "$ROOT" && env -u LD_LIBRARY_PATH nix develop -c cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  else
    (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  fi
  "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -x "$B" ] && [ -f "$DLL" ] || { echo "not built: $B / $DLL (drop --no-build)"; exit 2; }
[ -x "${B%/*}/liascape-scene-worker" ] || { echo "not built: ${B%/*}/liascape-scene-worker (drop --no-build)"; exit 2; }

# Run the backend from a private copy of its build: the owner's `dotnet watch` rebuilds the same
# bin/Debug whenever a build here touches obj/, and mid-rebuild liascape-backend.runtimeconfig.json is briefly
# missing — stacks started then died ("backend didn't start": libhostpolicy.so … runtimeconfig.json not
# found; 2 of 6 matrix shards once). Copied whole, retried until the DLL didn't change during the copy.
snapshot_backend() {   # $1 = destination dir → prints the copied DLL's path
  local src; src=$(dirname "$DLL")
  for _ in $(seq 1 60); do
    if [ -f "$src/liascape-backend.runtimeconfig.json" ] && [ -f "$DLL" ]; then
      local m0; m0=$(stat -c %Y.%s "$DLL")
      mkdir -p "$1" && cp -a "$src/." "$1/" 2>/dev/null
      [ -f "$1/liascape-backend.runtimeconfig.json" ] && [ -f "$1/liascape-backend.dll" ] && [ "$(stat -c %Y.%s "$DLL")" = "$m0" ] \
        && { echo "$1/liascape-backend.dll"; return 0; }
    fi
    sleep 1
  done
  return 1
}
T=$(mktemp -d /tmp/liascape-it-XXXXXX)   # short: a unix socket path must be < 108 bytes
DLL=$(snapshot_backend "$T/backend") || { echo "ABORT: no complete backend build to snapshot"; exit 2; }
mkdir -p "$T/home/.config/liascape" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st" "$T/bin"
# the backend's player binary: a link to this build, replaced by a copy to stand in for a rebuild (upgrade test)
ln -s "$B" "$T/bin/liascape-player"
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LIASCAPE_PLAYER_BIN=$T/bin/liascape-player LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# Phase 2 scenes: the private player (and every one the backend starts) plays synthetic scene folders, and
# finds its worker even when its binary is a copy elsewhere (the upgrade test replaces $T/bin/liascape-player)
export LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 LIASCAPE_SCENE_WORKER_BIN=$ROOT/src/player/target/debug/liascape-scene-worker
# The adapter's aligned-switch backstop slack (LiascapePlayerMedia.AlignBackstopSlackSec, 15 s in production),
# shortened so the speed-drop / long-pause scenarios below reach it in seconds.
export LIASCAPE_TEST_ALIGN_BACKSTOP_SLACK_SEC=2
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT
unset PULSE_SINK PULSE_SOURCE PULSE_COOKIE PULSE_CLIENTCONFIG PULSE_RUNTIME_PATH PIPEWIRE_RUNTIME_DIR PIPEWIRE_REMOTE
# Audio: every libpulse client (the backend's auto-mute pactl/parec, this script's own) and PipeWire client can only
# ever reach THIS test's private servers — the auto-mute section's PipeWire + pipewire-pulse in $XDG_RUNTIME_DIR. An
# explicit PULSE_SERVER also means libpulse never falls back to another server or autospawns one while none runs.
export PULSE_SERVER=unix:$XDG_RUNTIME_DIR/pulse/native
SP=""; CP=""; BP=""; PWP=""
cleanup() {
  trap - EXIT INT TERM HUP
  # SIGCONT both the compositor (it may be SIGSTOPped by the stall test) and the supervisor (no-op if
  # it was never stopped) before anything else, so a `quit`/TERM below can actually be handled.
  [ -n "$CP" ] && kill -CONT "$CP" 2>/dev/null
  [ -n "$SP" ] && kill -CONT "$SP" 2>/dev/null
  [ -n "${WSP:-}" ] && kill "$WSP" 2>/dev/null
  [ -n "${FWP:-}" ] && kill "$FWP" 2>/dev/null
  [ -n "${SMP:-}" ] && kill "$SMP" 2>/dev/null
  for bp in "$BP" ${BP_OLD:-}; do [ -n "$bp" ] && { kill "$bp" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$bp" 2>/dev/null || break; sleep 0.1; done; kill -9 "$bp" 2>/dev/null; }; done
  # a `timer-daemon` a stopping backend handed the playlist to (the restart test below)
  [ -s "$XDG_CONFIG_HOME/liascape/timer.pid" ] && kill -9 "$(cat "$XDG_CONFIG_HOME/liascape/timer.pid")" 2>/dev/null
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1   # clean child exit → the supervisor exits too, no restart
  # Fallback: kill the SUPERVISOR (never a bare compositor pid — that would just make it restart again).
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  for p in $PWP; do kill -9 "$p" 2>/dev/null; done   # the auto-mute section's private audio daemons
  [ -n "${LIASCAPE_IT_KEEP:-}" ] && { echo "kept $T"; return; }
  case "$T" in /tmp/liascape-it-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

ctl() { "$B" ctl --timeout-ms 3000 "$@"; }
comp_pid() { ctl hello 2>/dev/null | jq -r '.pid // empty'; }
sup_pid()  { ctl hello 2>/dev/null | jq -r '.supervisor_pid // empty'; }
pass=0; fail=0
ok()  { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
dB() { python3 -c "import math; print(60*math.log10($1/100))"; }
near() { python3 -c "import sys; sys.exit(0 if abs(float('$1')-float('$2'))<${3:-0.01} else 1)" 2>/dev/null; }
handoffs() { ctl logs '{"kind_prefix":"transition.handoff","limit":10000}' | jq '.events|length'; }

clip() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "$2=size=320x180:rate=30" -f lavfi -i "sine=frequency=$3:sample_rate=48000" \
           -t "$4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$1"; }
A=$T/a.mp4; Bc=$T/b.mp4; C=$T/c.mp4; D=$T/d.mp4
clip "$A" testsrc2 440 2; clip "$Bc" smptebars 550 2; clip "$C" rgbtestsrc 660 2; clip "$D" testsrc 220 10
E1=$T/e1.mp4; E2=$T/e2.mp4; P1=$T/p1.mp4; P2=$T/p2.mp4
clip "$E1" testsrc2 330 12; clip "$E2" smptebars 770 12; clip "$P1" rgbtestsrc 880 4; clip "$P2" testsrc 990 4
L1=$T/l1.mp4; clip "$L1" testsrc2 360 20   # outlasts the 10 s stale check while an end-of-video switch is armed

cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"liascape-player","NoAudio":false,"Loop":true,"Volume":100,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["fade"],"GlobalTransitionDurationMs":300,"TransitionMethod":"full-live",
 "GlobalSwitchWhenVideoEnds":true,"GlobalIntervalSeconds":0,"GlobalMaxPlaySeconds":0,"GlobalSeparateSceneTiming":false,
 "RestartMpvpaperEverySeconds":600}
EOF

# Phase 3 Task 8: under liascape-player legacy's daemon files are never written (no timer-daemon / restart-daemon, no
# pending-action IPC, no timer ownership) — sampled every 0.2 s for the whole run, checked before the engine switch at
# the end. The legacy timed_state.json the Task 7 section plants itself is exempt while its marker exists.
LEGACY_FILES_LOG=$T/legacy-files.log; : > "$LEGACY_FILES_LOG"
( while :; do
    for f in pending_action.txt timer.pid gui_timer.pid restart.pid timed_state.json; do
      [ -e "$XDG_CONFIG_HOME/liascape/$f" ] && [ ! -e "$T/planted-$f" ] && echo "$(date +%T.%N) $f" >> "$LEGACY_FILES_LOG"
    done
    [ -e "$XDG_CACHE_HOME/liascape/playlist_observer_paths.json" ] && echo "$(date +%T.%N) playlist_observer_paths.json" >> "$LEGACY_FILES_LOG"
    sleep 0.2
  done ) & FWP=$!
start_player() { (cd /tmp && exec "$B" serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null > "$T/serve$1.log" 2>&1) & SP=$!; }
# A fresh player in place of the running one (`ctl quit` — its final snapshot may take seconds), with extra
# env for it: `restart_player <n> VAR=value …`. The backend finds the new pid at its next request.
restart_player() {
  local n=$1; shift
  "$B" ctl --timeout-ms 3000 quit >/dev/null 2>&1
  for _ in $(seq 1 600); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$SP" 2>/dev/null && { echo "  note: supervisor $SP outlived its quit by 60 s — SIGKILL"; kill -9 "$SP"; }
  (cd /tmp && exec env "$@" "$B" serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null > "$T/serve$n.log" 2>&1) & SP=$!
  for _ in $(seq 1 100); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
  CP=$(ctl hello 2>/dev/null | jq -r '.pid // empty')
}
start_player 1
for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
CP=$(comp_pid)   # the compositor — `$SP` (spawned by `start_player`) is its SUPERVISOR, a different pid
[ -n "$CP" ] && [ "$CP" != "$SP" ] && ok "hello.pid ($CP) is the compositor, != the spawned supervisor $SP" || bad "hello.pid = $CP, spawned supervisor = $SP"
[ "$(sup_pid)" = "$SP" ] && ok "hello.supervisor_pid == spawned supervisor $SP" || bad "hello.supervisor_pid $(sup_pid) != spawned $SP"
"$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "ABORT: backend didn't start (see $T/backend.log)"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
post() { curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
# an import copies the clip + ffmpeg-extracts its thumbnail: seconds under load, past `post`'s 10 s
lib_import() { curl -sf -m 60 -X POST -H 'Content-Type: application/json' -d "{\"path\":\"$1\",\"title\":\"$2\"}" "$U/library/import" | jq -r .videoPath; }
cur()  { ctl get "{\"path\":\"cur:*.$1\"}" 2>/dev/null | jq -r '.value'; }
# R75 (final): pause is PLAYER-level (`player.paused`), not a per-source prop — `cur:*.paused` (the
# node's own raw value) never changes, by design (a recipe-held source must stay exactly as the
# recipe left it; see player-core.md § Graph & properties "Player node paused").
playerPaused() { ctl get '{"path":"player.paused"}' | jq -r .value; }
srcPaused() { ctl probe '{"name":"sources"}' | jq -r --arg id "$1" '.sources[] | select(.id==$id) | .effective_paused'; }
srcIdForPath() { ctl state | jq -r --arg p "$1" '.graph | to_entries[] | select((.key | startswith("src")) and .value.path==$p) | .key' | head -1; }   # a source: a program node has a `path` too
setting() { curl -sf -m 5 "$U/settings" | jq "$1" > "$T/s.json" && post /settings "$(cat "$T/s.json")" >/dev/null; }
post_ms() { curl -s -m 10 -o /dev/null -w '%{time_total}' -X POST -H 'Content-Type: application/json' -d "$2" "$U$1" | python3 -c "import sys; print(int(float(sys.stdin.read())*1000))"; }

# Condition waits. A check of a state that CONVERGES (a setting landing, a switch showing, a reapply
# running) polls its condition until a deadline — `waitfor <ms> <cmd…>`, a real clock deadline, not an
# iteration count (under load every poll's own ctl/jq/python spawn costs more) — and returns the moment
# it holds, so the bound only matters on failure. Fixed sleeps stay only where the window IS the check:
# an absence (no switch in N s), a count over a window, or a latency bound (< 500 ms while SIGSTOPped).
# Each check reads its values ONCE and reports those (a failure message that re-reads the player shows
# a later state than the one that failed).
ms_now() { date +%s%3N; }
waitfor() { local end=$(( $(ms_now) + $1 )); shift; until "$@"; do [ "$(ms_now)" -ge "$end" ] && return 1; sleep 0.1; done; }
WAIT=10000   # the deadline for a converging state
cur_is()   { [ "$(cur "$1")" = "$2" ]; }                     # cur_is path "$A"
cur_near() { near "$(cur "$1")" "$2" "${3:-0.01}"; }         # cur_near gain.user -18.06
paused_is() { [ "$(playerPaused)" = "$1" ]; }
# no switch still running / armed (a /apply's own fade done) — what the old fixed sleeps after an apply waited out
settled()  { ctl state | jq -e '[.transitions[] | select(.phase != "done")] | length == 0' >/dev/null; }
shows()    { cur_is path "$1" && settled; }                  # $1 on screen, its switch finished
nothing_shown() { [ -z "$(cur path | grep -v null)" ]; }
stop_now() { post /stop '{}' >/dev/null; waitfor $WAIT nothing_shown || bad "/stop left $(cur path)"; }
nows() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '[.events[] | select(.align=="now")] | length'; }
handed_more() { [ "$(handoffs)" -gt "$1" ]; }
corr_has() { ctl logs "{\"corr\":\"$1\",\"kind_prefix\":\"transition.$2\"}" | jq '.events|length'; }
reapplies() { grep -c "re-applied effective settings" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null || true; }
reapplied_since() { [ "$(reapplies)" -gt "$1" ]; }
# A reapply after a restart: its own log line (count > $1) — or, since the adapter log drops a line
# identical to one written < 10 s earlier, that identical line. It happens when the restarted player
# came back with what an EARLIER reapply named: a snapshot still behind the last switch (writes are
# fsync'ed; under I/O load one lagged 2.4 s) restores the previous wallpaper, so the restart's reapply
# line ("… for dee.mp4 (player.paused = false, kept)") repeats the stall-recovery one 2.7 s before.
reapply_seen() {
  reapplied_since "$1" && return 0
  grep -q "liascape-player restarted (new pid)" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null || return 1
  python3 - "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" \
    "liascape-player: re-applied effective settings for $(basename "$(cur path)") (player.paused = $(playerPaused), kept)" <<'PY'
import re, sys
log, want = sys.argv[1], sys.argv[2]
def t(line):
    m = re.match(r"\[liascape-player (\d+):(\d+):([\d.]+)\] ", line)
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else None
lines = open(log).read().splitlines()
restart = [t(l) for l in lines if "liascape-player restarted (new pid)" in l][-1]
same = [t(l) for l in lines if l.endswith("] " + want) and t(l) is not None and t(l) <= restart]
sys.exit(0 if same and restart - same[-1] < 10 else 1)
PY
}
# Judging a MOMENT after it: under load the reads that follow a window took seconds (3.4 s for four once),
# so "what had happened by t" is read from the event log afterwards and judged by the events' own wall
# time (`t_wall`, the same system clock as `ms_now`), never by when the read returned.
EV_MS='(.t_wall | ((.[0:19] + "Z") | fromdateiso8601) * 1000 + (.[20:23] | tonumber))'
# n_before <kind> <corr|""> <t epoch ms> [first index among that kind's events] → how many were stamped before t
n_before() { ctl logs "{\"kind_prefix\":\"$1\",\"limit\":10000}" | jq --arg k "$1" --arg c "$2" --argjson t "$3" --argjson n "${4:-0}" \
  "[.events[\$n:][] | select(.kind == \$k and (\$c == \"\" or .corr == \$c) and $EV_MS < \$t)] | length"; }
# the path the last handoff (from index $1 of the handoffs) stamped before $2 handed to (its source's `scheduled.path`)
handed_to_before() {
  local to; to=$(ctl logs '{"kind_prefix":"transition.handoff","limit":10000}' | jq -r --argjson n "$1" --argjson t "$2" "[.events[\$n:][] | select($EV_MS < \$t)][-1].to // empty")
  [ -n "$to" ] && ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg to "$to" '[.events[] | select(.to == $to)][-1].path // empty'
}
SNAP=$XDG_STATE_HOME/liascape/liascape-player/snapshot.json
snap_paused() { jq -e --argjson v "$1" '.player.paused == $v' "$SNAP" >/dev/null 2>&1; }

PE=$(curl -sf -m 5 "$U/player-engine"); echo "player-engine: $PE"
[ "$(echo "$PE" | jq -r .active)" = "liascape-player" ] || { echo "ABORT: backend not on liascape-player — refusing to touch any legacy player"; exit 1; }

echo "== apply / transition"
post /apply "{\"path\":\"$A\"}" >/dev/null
waitfor $WAIT shows "$A" && ok "/apply a → cur a" || bad "/apply a → cur $(cur path), transitions $(ctl state | jq -c '[.transitions[].phase]')"
post /apply "{\"path\":\"$Bc\"}" >/dev/null
waitfor $WAIT shows "$Bc" && ok "/apply b → cur b" || bad "/apply b → cur $(cur path), transitions $(ctl state | jq -c '[.transitions[].phase]')"
ctl logs '{"kind_prefix":"transition.started"}' | jq -r '.events[-1] | "\(.effect_id) \(.method)"' | grep -q "fade full-live" && ok "a→b ran fade full-live" || bad "a→b effect: $(ctl logs '{"kind_prefix":"transition.started"}' | jq -c '.events[-1]')"
curl -sf -m 5 "$U/current" | jq -e ".playing == true and .path == \"$Bc\" and (.position|type) == \"number\"" >/dev/null && ok "/current playing b + position" || bad "/current $(curl -sf -m 5 "$U/current")"

echo "== live settings"
fit1() { [ "$(ctl get '{"path":"lay:VIRTUAL-1:main.fit"}' | jq -r .value)" = fit ]; }
setting '.Volume = 50'; waitfor $WAIT cur_near gain.user -18.0618 && ok "Volume 50 → gain.user $(cur gain.user)" || bad "Volume 50 → $(cur gain.user)"
setting '.Speed = 1.5'; waitfor $WAIT cur_near speed 1.5 && ok "Speed 1.5" || bad "Speed → $(cur speed)"
setting '.VideoScale = "fit"'; waitfor $WAIT fit1 && ok "VideoScale fit → layer fit" || bad "VideoScale"
setting '.VideoFpsCap = 30'; waitfor $WAIT cur_near fps_cap 30 && ok "VideoFpsCap 30 → fps_cap" || bad "VideoFpsCap → $(cur fps_cap)"
setting '.HwDec = "no"'; waitfor $WAIT cur_is hwdec no && ok "HwDec no" || bad "HwDec → $(cur hwdec)"
setting '.DisableCache = true'; waitfor $WAIT cur_is cache false && ok "DisableCache → cache false" || bad "cache → $(cur cache)"
setting '.DemuxerMaxMib = 64'; waitfor $WAIT cur_near demuxer_max_mib 64 && ok "DemuxerMaxMib 64" || bad "demuxer → $(cur demuxer_max_mib)"
setting '.NoAudio = true'; waitfor $WAIT cur_is no_audio true && ok "NoAudio → no_audio true" || bad "NoAudio → $(cur no_audio)"
setting '.NoAudio = false'; waitfor $WAIT cur_is no_audio false && ok "NoAudio off" || bad "NoAudio off → $(cur no_audio)"
setting '.Loop = false'; waitfor $WAIT cur_is loop false && ok "Loop off (single video)" || bad "Loop → $(cur loop)"
setting '.Loop = true | .Speed = 1 | .VideoFpsCap = 0'; waitfor $WAIT cur_near speed 1 || bad "Loop/Speed/VideoFpsCap reset → speed $(cur speed)"
post /mute '{"value":true,"user":true}' >/dev/null; waitfor $WAIT cur_near gain.mute -96 && ok "user mute → gain.mute -96" || bad "mute → $(cur gain.mute)"
post /mute '{"value":false,"user":true}' >/dev/null; waitfor $WAIT cur_near gain.mute 0 && ok "unmute → 0" || bad "unmute → $(cur gain.mute)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true && ok "/pause → player.paused" || bad "pause → $(playerPaused)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is false && ok "/pause again → playing" || bad "unpause → $(playerPaused)"
g55=$(dB 55); g20=$(dB 20)
post /volume '{"delta":5}' >/dev/null; waitfor $WAIT cur_near gain.user "$g55" && ok "/volume +5 → 55%" || bad "volume+5 → $(cur gain.user)"
post /preview '{"volume":20}' >/dev/null; waitfor $WAIT cur_near gain.user "$g20" && ok "/preview volume 20 → that item's source" || bad "preview → $(cur gain.user)"

echo "== timed playlist: advance-on-end, no minimum play time (2 s clips → advance on end)"
# A rotation's rate is counted on the PLAYER's clock: the handoffs (after index $1) whose t_mono_ms lies
# within $2 ms of the first one (the play's own switch). The sleep only lets that window pass. Counting
# "handoffs during a sleep after the request" broke under load: the /playlist/play request itself took
# its full 10 s curl timeout once, so the "9 s" window held 17 s of rotation (10 handoffs).
rotation_window() {   # $1 = handoff count before the play, $2 = window (ms) → prints the handoffs in it
  waitfor 30000 handed_more "$1" || { echo 0; return; }
  sleep "$(python3 -c "print($2 / 1000 + 0.5)")"
  ctl logs '{"kind_prefix":"transition.handoff","limit":10000}' | jq --argjson n "$1" --argjson w "$2" \
    '.events[$n:] | map(.t_mono_ms) | . as $t | [ .[] | select(. - $t[0] < $w) ] | length'
}
n0=$(handoffs)
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\",\"$C\"],\"settings\":{\"Order\":0}}" >/dev/null
nh=$(rotation_window "$n0" 9000)
[ $nh -ge 4 ] && [ $nh -le 7 ] && ok "advance-on-end rotated: $nh handoffs in 9 s" || bad "$nh handoffs in 9 s"
na=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '[.events[] | select(.align=="end")] | length')
[ $na -ge 3 ] && ok "rotation uses align:end ($na aligned)" || bad "aligned switches: $na"

echo "== /next mid-wait → cancel the aligned one, switch now"
# /next is an align:now switch (the rotation's own are align:end), so "it switched" = a new align:now
# request whose B shows — the rotation advancing by itself meanwhile can't pass for it.
last_now_corr() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r '[.events[] | select(.align=="now")][-1].corr // empty'; }
next_shown() { [ "$(nows)" -gt "$nw0" ] && nc=$(last_now_corr) && [ "$(corr_has "$nc" handoff)" -ge 1 ]; }
before=$(cur path); nw0=$(nows); nc=""; post /next '{}' >/dev/null
waitfor $WAIT next_shown; after=$(cur path)
[ -n "$nc" ] && [ "$(corr_has "$nc" handoff)" -ge 1 ] && [ "$after" != "$before" ] && ok "/next switched ($(basename "$before") → $(basename "$after"), $nc)" || bad "/next: align:now ${nc:-none}, cur $(basename "$before") → $(basename "$after")"
nh2=$(handoffs)   # counted after /next's own handoff: the next one is the rotation's
waitfor $WAIT handed_more "$nh2" && ok "rotation continues after /next" || bad "rotation stalled after /next ($(( $(handoffs) - nh2 )) handoffs in ${WAIT} ms)"

echo "== /next during the aligned switch's EFFECT → the item after its B (B already shows)"
# Once an aligned switch's effect runs, B is what shows (`cur:*` = B; a new request commits it, a cancel
# snaps back to A). The backend counted it only from its handoff: a /next in that window cancelled it and
# switched "now" to the same B — the user's next did nothing (the flaky "cur a.mp4 → a.mp4" above, ~1 in 6
# /next with 2 s clips and a 300 ms fade). A 1.5 s fade on a 4 s clip makes the window deterministic.
setting '.GlobalTransitionDurationMs = 1500'
post /playlist/play "{\"paths\":[\"$P1\",\"$P2\",\"$E1\"],\"settings\":{\"Order\":0}}" >/dev/null
al_corr() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg p "$1" '[.events[] | select(.align=="end" and .path==$p)][-1].corr // empty'; }
al_running() { ac=$(al_corr "$P2") && [ -n "$ac" ] && [ "$(corr_has "$ac" started)" -ge 1 ]; }
waitfor 15000 al_running || bad "no aligned p1 → p2 effect started (corr ${ac:-none})"
nw0=$(nows); post /next '{}' >/dev/null
now_path() { [ "$(nows)" -gt "$nw0" ] && np=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r '[.events[] | select(.align=="now")][-1].path // empty') && [ -n "$np" ]; }
waitfor $WAIT now_path
[ "${np:-}" = "$E1" ] && ok "/next mid-effect (p1 → p2, $ac) → e1.mp4, the item after p2" || bad "/next mid-effect (p1 → p2, $ac) → $(basename "${np:-none}"), expected e1.mp4"
al_out() { ctl logs "{\"corr\":\"$ac\",\"kind_prefix\":\"transition.\"}" | jq -r '[.events[] | select(.kind=="transition.handoff" or .kind=="transition.cancelled")][-1].kind // empty'; }
al_done() { ao=$(al_out); [ -n "$ao" ]; }
waitfor $WAIT al_done
[ "$ao" = transition.handoff ] && ok "the running p1 → p2 effect was committed (handoff), not cancelled" || bad "the running p1 → p2 effect ended in ${ao:-nothing}, expected transition.handoff"
waitfor $WAIT cur_is path "$E1" && ok "e1.mp4 on screen after the /next" || bad "after /next mid-effect: cur $(basename "$(cur path)")"
setting '.GlobalTransitionDurationMs = 300'

echo "== advance-on-end play-time limits: a minimum (a short clip loops, advances at the end of the loop that reaches it) / a maximum (a long one advances, align:now)"
# Wall-clock seconds, 0 = off. Under "Switch when video ends" the rotation's one interval field IS the minimum
# (GlobalIntervalSeconds — the UI's "Minimum play time"); GlobalMaxPlaySeconds is the maximum. The playlists below
# follow the globals (advance-on-end, minimum 0, set at the top). Times are judged by the player's own event
# clocks: t0 = the handoff of the play's own switch (its first item fully shown — 300 ms into that item, a fade).
tev_n() { ctl logs '{"kind_prefix":"transition.","limit":10000}' | jq '.events|length'; }
# after transition event $1: the first switch scheduled to $2 that handed off (or, with $3 = any, the first one scheduled)
# → "<scheduled − t0 ms> <its handoff − t0 ms, -1 = none yet> <align> <t0 as wall ms> <switches scheduled to $2> <cancelled>"
sw_to() { ctl logs '{"kind_prefix":"transition.","limit":10000}' | python3 -c '
import json, sys, datetime
n, p, anyone = int(sys.argv[1]), sys.argv[2], sys.argv[3] == "any"
ev = json.load(sys.stdin)["events"][n:]
def wall(e):
    s = e["t_wall"]; d = datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    return int(d.timestamp() * 1000) + int(s[20:23])
h = [e for e in ev if e["kind"] == "transition.handoff"]
if not h: print("none"); sys.exit()
t0 = h[0]["t_mono_ms"]
s = [e for e in ev if e["kind"] == "transition.scheduled" and e.get("path") == p and e["t_mono_ms"] >= t0]
done = {e.get("corr"): e["t_mono_ms"] for e in ev if e["kind"] == "transition.handoff"}
corrs = {x.get("corr") for x in s}
canc = sum(1 for e in ev if e["kind"] == "transition.cancelled" and e.get("corr") in corrs)
pick = [x for x in s if anyone or x.get("corr") in done]
if not pick: print("none"); sys.exit()
x = pick[0]; th = round(done[x.get("corr")] - t0) if x.get("corr") in done else -1
print(round(x["t_mono_ms"] - t0), th, x.get("align"), wall(h[0]), len(s), canc)' "$1" "$2" "${3:-done}"; }
sw_seen() { swr=$(sw_to "$@"); [ "$swr" != none ]; }
sw_field() { echo "$swr" | cut -d' ' -f"$1"; }
t0w() { local v; v=$(sw_field 4); case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac; }   # t0 (wall ms), 0 = none
between() { python3 -c "import sys; sys.exit(0 if $2 <= float('$1') <= $3 else 1)" 2>/dev/null; }
n_sched_to() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq --argjson n "$1" --arg p "$2" '[.events[$n:][] | select(.kind=="transition.scheduled" and .path==$p)] | length'; }
nows_after() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq --argjson n "$1" '[.events[$n:][] | select(.align=="now")] | length'; }
armed_to() { ctl state | jq -e --arg p "$1" '. as $s | [.transitions[] | select(.phase == "waiting_start" and $s.graph[.to].path == $p)] | length > 0' >/dev/null; }
nsched_all() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '.events|length'; }
stop_now

# min before the play (ApplyTimedPlaylist picks it up): a.mp4 is 2 s → its loops end at +1.7, +3.7, +5.7 s; the first ≥ 5 s is the 3rd
setting '.GlobalIntervalSeconds = 5 | .GlobalMaxPlaySeconds = 0'
m0=$(tev_n); nw0=$(nows)
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 20000 sw_seen "$m0" "$Bc"
between "$(sw_field 2)" 5200 6400 && [ "$(sw_field 3)" = end ] \
  && ok "min 5 s: the 2 s clip looped and advanced at its 3rd loop's end (handoff +$(sw_field 2) ms, align $(sw_field 3))" \
  || bad "min 5 s on a 2 s clip: $swr (want a handoff at +5.2…6.4 s, align end)"
between "$(sw_field 1)" 3300 5600 && ok "…its aligned switch requested inside the loop that reaches the minimum (+$(sw_field 1) ms)" || bad "min 5 s: the switch was requested at +$(sw_field 1) ms (want +3.3…5.6 s: the 3rd loop)"
[ $(( $(nows) - nw0 )) -le 1 ] && ok "…never cut mid-loop (no align:now switch but the play's own)" || bad "min: $(( $(nows) - nw0 - 1 )) align:now switches besides the play's own"

# min set LIVE while an aligned switch is already armed for the first loop's end (p1.mp4, 4 s: loops end +3.7, +7.7 s)
setting '.GlobalIntervalSeconds = 0'; stop_now
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$P1\",\"$P2\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT armed_to "$P2" || bad "min live: no aligned switch to p2 armed"
setting '.GlobalIntervalSeconds = 6'; t_set=$(ms_now)
swr=none; waitfor 20000 sw_seen "$m0" "$P2"
echo "     min set $(( t_set - $(t0w) )) ms after p1 showed"
[ $(( t_set - $(t0w) )) -lt 3500 ] || bad "min live: precondition — the setting landed after p1's first loop ended"
between "$(sw_field 2)" 7200 8400 && ok "min 6 s set live: the armed switch was re-armed, p1 advanced at its 2nd loop's end (+$(sw_field 2) ms; $(sw_field 6) cancelled)" \
  || bad "min 6 s set live on a 4 s clip: $swr (want a handoff at +7.2…8.4 s)"
setting '.GlobalIntervalSeconds = 0'; stop_now

# a playlist's own minimum (override): a.mp4 (2 s) with 3 s → advances at its 2nd loop's end (+3.7 s), never at its 1st
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\"],\"settings\":{\"Order\":0,\"OverrideGlobalSettings\":true,\"IntervalSeconds\":3,\"SwitchWhenVideoEnds\":true}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$Bc"
between "$(sw_field 2)" 3200 4400 && [ "$(sw_field 3)" = end ] && ok "the playlist's own min 3 s: a 2 s clip advanced at its 2nd loop's end (handoff +$(sw_field 2) ms, align $(sw_field 3))" \
  || bad "playlist override min 3 s on a 2 s clip: $swr (want a handoff at +3.2…4.4 s, align end)"
stop_now

# max: e1.mp4 is 12 s → advances 3 s in (align:now, like a timed switch). Minimum 0 (switch at every end otherwise)
setting '.GlobalMaxPlaySeconds = 3 | .GlobalIntervalSeconds = 0'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$E2"
between "$(sw_field 1)" 2300 3900 && [ "$(sw_field 3)" = now ] && ok "max 3 s: the 12 s clip advanced 3 s in (requested +$(sw_field 1) ms, align $(sw_field 3), handed off +$(sw_field 2))" \
  || bad "max 3 s on a 12 s clip: $swr (want align now at +2.3…3.9 s)"
waitfor $WAIT cur_is path "$E2" && ok "…e2 on screen" || bad "max: cur $(basename "$(cur path)")"
setting '.GlobalMaxPlaySeconds = 0'; stop_now

# max set live 1 s in, then an unrelated edit: neither restarts the item's play time (it advances ~5 s after e1 showed, not 5 s after an edit)
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT cur_is path "$E1"; sleep 1
setting '.GlobalMaxPlaySeconds = 5'; t_set=$(ms_now); sleep 1; setting '.Volume = 90'
swr=none; waitfor 15000 sw_seen "$m0" "$E2"
rel=$(( t_set - $(t0w) )); echo "     max set ${rel} ms after e1 showed"
between "$(sw_field 1)" 4300 5900 && [ "$(sw_field 3)" = now ] && ok "max 5 s set live (+${rel} ms) + a volume edit: advanced at +$(sw_field 1) ms of e1 — the play time kept counting" \
  || bad "max set live: $swr (want align now at +4.3…5.9 s of e1, max set at +${rel} ms)"
setting '.GlobalMaxPlaySeconds = 0 | .Volume = 100'; stop_now

# pause: the play time stands still while paused (no switch during a 4 s pause), then the rest of the 3 s runs
setting '.GlobalMaxPlaySeconds = 3'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT cur_is path "$E1"; sleep 0.8
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true; t_p=$(ms_now); sleep 4
n_p=$(n_sched_to "$m0" "$E2"); post /pause '{}' >/dev/null; waitfor $WAIT paused_is false; t_r=$(ms_now)
swr=none; waitfor 15000 sw_seen "$m0" "$E2"
if [ "$swr" = none ]; then played=-1; else played=$(( ${swr%% *} - (t_r - t_p) )); fi
[ "$n_p" = 0 ] && ok "max 3 s: no switch during a 4 s pause" || bad "max: $n_p switches to e2 while paused"
between "$played" 2200 4000 && ok "…advanced after 3 s of PLAY (+$(sw_field 1) ms, $(( t_r - t_p )) ms of it paused)" || bad "max × pause: $swr, paused $(( t_r - t_p )) ms → played ${played} ms (want ~3 s)"
stop_now

# speed 2×: the limits are wall-clock (a video-time 3 s would be 1.5 s of wall clock)
setting '.Speed = 2'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$E2"
between "$(sw_field 1)" 2300 3900 && [ "$(sw_field 3)" = now ] && ok "max 3 s at 2× speed: advanced after 3 s of wall clock (+$(sw_field 1) ms)" || bad "max × speed 2: $swr (want align now at +2.3…3.9 s)"
setting '.Speed = 1'; stop_now

# a one-item playlist never switches to itself (max 2 s, 4 s watched)
setting '.GlobalMaxPlaySeconds = 2'
m0=$(nsched_all)
post /playlist/play "{\"paths\":[\"$E1\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT cur_is path "$E1"; sleep 4
[ "$(n_sched_to "$m0" "$E1")" = 1 ] && ok "max 2 s on a one-item playlist: no switch to itself in 4 s" || bad "one-item playlist: $(n_sched_to "$m0" "$E1") switches to e1 (want only the play's own)"
stop_now

# pure timed (advance-on-end off): a plain timer — the 3 s interval switches MID-video (align:now; e1 is 12 s), the
# maximum (2 s) doesn't apply. The removed "wait for video to end" toggle's key, still in an old settings.json, changes
# nothing (it used to hold the switch for e1's end).
setting '.GlobalSwitchWhenVideoEnds = false | .GlobalIntervalSeconds = 3 | .GlobalWaitForVideoEnd = true'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$E2" any
between "$(sw_field 1)" 2200 3900 && [ "$(sw_field 3)" = now ] && ok "advance-on-end off: the 3 s timer switched mid-video (+$(sw_field 1) ms, align $(sw_field 3)); max 2 s and the old wait key ignored" \
  || bad "pure timed 3 s (max 2 s, an old wait key): $swr (want align now at +2.2…3.9 s — counted from the handoff of the play's own switch, the timer from its request; the 2 s max would land ≤ +2.0 s)"
setting '.GlobalSwitchWhenVideoEnds = true | .GlobalIntervalSeconds = 0 | .GlobalMaxPlaySeconds = 0 | .GlobalWaitForVideoEnd = false'; stop_now

# a per-playlist override (its own rotation): the playlist's max wins over the globals' (2 s here, global 0)
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0,\"OverrideGlobalSettings\":true,\"IntervalSeconds\":20,\"SwitchWhenVideoEnds\":true,\"MaxPlaySeconds\":2}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$E2"
between "$(sw_field 1)" 1300 2900 && [ "$(sw_field 3)" = now ] && ok "the playlist's own max 2 s (override, min 20 s — a cap beats the minimum): advanced at +$(sw_field 1) ms" || bad "playlist override max 2 s: $swr"
# …and a /playlist/state edit of its max applies live (2 → 0: e2 then plays on — 4 s watched, no align:now switch)
post /playlist/state '{"settings":{"maxPlaySeconds":0}}' >/dev/null; m1=$(nsched_all); sleep 4
[ "$(nows_after "$m1")" = 0 ] && ok "/playlist/state max 0 (live): no more max switches" || bad "/playlist/state max 0: $(nows_after "$m1") align:now switches after it"
stop_now

# a still image under advance-on-end never ends (it switched at once); with a minimum it shows for it
I1=$T/i1.png; ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=320x180" -frames:v 1 "$I1"
setting '.GlobalIntervalSeconds = 3'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$I1\",\"$E1\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$E1"
between "$(sw_field 2)" 2400 4300 && ok "min 3 s: an image showed for it (handoff to e1 at +$(sw_field 2) ms)" || bad "min 3 s × image: $swr"
setting '.GlobalIntervalSeconds = 0'
stop_now

# an fps cap never stalls a still: VideoFpsCap 30 → an image item plays (it used to sit in waiting_ready,
# ready:false — docs/TODO.md "An fps cap stalls a still image"); the cap still reaches the node
setting '.VideoFpsCap = 30'
post /apply "{\"path\":\"$I1\"}" >/dev/null
waitfor $WAIT shows "$I1" && cur_is ready true && cur_near fps_cap 30 && ok "VideoFpsCap 30 × an image: it plays (ready, fps_cap 30 kept)" \
  || bad "VideoFpsCap 30 × image: cur $(basename "$(cur path)") ready $(cur ready) fps_cap $(cur fps_cap), transitions $(ctl state | jq -c '[.transitions[].phase]')"
post /apply "{\"path\":\"$E1\"}" >/dev/null
waitfor $WAIT shows "$E1" && cur_is ready true && ok "…and a video after it plays capped" || bad "VideoFpsCap 30 × video after the image: cur $(basename "$(cur path)") ready $(cur ready)"
setting '.VideoFpsCap = 0'
stop_now

echo "== 0 = off for both limits (minimum 0, maximum 0): a short clip switches at its end, a long one plays to its end"
# p1 (4 s) → e1 (12 s) → e2: each switch at its clip's end (align:end), never cut by a limit
m0=$(tev_n); nw0=$(nows)
post /playlist/play "{\"paths\":[\"$P1\",\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 25000 sw_seen "$m0" "$E2"; sw_e2=$swr
swr=$(sw_to "$m0" "$E1")
between "$(sw_field 2)" 3200 4400 && [ "$(sw_field 3)" = end ] && ok "0/0: p1 (4 s) switched at its end (handoff +$(sw_field 2) ms, align end)" || bad "0/0 × a 4 s clip: $swr (want a handoff at +3.2…4.4 s, align end)"
swr=$sw_e2
between "$(sw_field 2)" 14800 16400 && [ "$(sw_field 3)" = end ] && ok "0/0: e1 (12 s) played to its end (handoff +$(sw_field 2) ms, align end)" || bad "0/0 × a 12 s clip: $swr (want a handoff at +14.8…16.4 s, align end)"
[ $(( $(nows) - nw0 )) -le 1 ] && ok "…never cut (no align:now switch but the play's own)" || bad "0/0: $(( $(nows) - nw0 - 1 )) align:now switches besides the play's own"
stop_now

echo "== separate timing for scenes ON: a still image (it never ends) switches after \"Switch scenes after\", not at the minimum"
setting '.GlobalIntervalSeconds = 0 | .GlobalMaxPlaySeconds = 0 | .GlobalSeparateSceneTiming = true | .GlobalSwitchScenesAfterSeconds = 3'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$I1\",\"$E1\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$E1"
between "$(sw_field 2)" 2400 4300 && ok "scenes after 3 s (minimum 0): the image showed 3 s (handoff to e1 at +$(sw_field 2) ms)" || bad "scenes after 3 s × image: $swr (want a handoff at +2.4…4.3 s; minimum 0 would flash it by)"
stop_now
setting '.GlobalSwitchScenesAfterSeconds = 0 | .GlobalMaxPlaySeconds = 2'
m0=$(nsched_all)
post /playlist/play "{\"paths\":[\"$I1\",\"$E1\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT cur_is path "$I1"; sleep 4
[ "$(n_sched_to "$m0" "$E1")" = 0 ] && cur_is path "$I1" && ok "scenes after 0 = off (a 2 s maximum): the image still shows after 4 s (the maximum doesn't apply to it)" \
  || bad "scenes after 0 × image: $(n_sched_to "$m0" "$E1") switches to e1, cur $(basename "$(cur path)")"
setting '.GlobalSeparateSceneTiming = false | .GlobalSwitchScenesAfterSeconds = 0 | .GlobalMaxPlaySeconds = 0'

echo "== /stop"
post /stop '{}' >/dev/null
waitfor $WAIT nothing_shown && ok "/stop → nothing on screen" || bad "/stop left $(cur path)"
not_playing() { curl -sf -m 5 "$U/current" | jq -e '.playing == false' >/dev/null; }
waitfor $WAIT not_playing && ok "/current playing=false" || bad "/current after stop $(curl -sf -m 5 "$U/current")"
nh4=$(handoffs); sleep 3
[ $(handoffs) -eq $nh4 ] && ok "no switches after /stop" || bad "switched after /stop"

echo "== per-item overrides (R61): the item's own source, incl. an in-flight transition's pending B"
setting '.Volume = 100 | .Speed = 1'
LD=$(lib_import "$D" dee)
LB=$(lib_import "$Bc" bee)
[ -f "$LD" ] && [ -f "$LB" ] && ok "imported 2 clips into the temp library" || bad "import: $LD $LB"
g30=$(dB 30); g40=$(dB 40); g70=$(dB 70)
post /apply "{\"path\":\"$LD\"}" >/dev/null
waitfor $WAIT shows "$LD" || bad "/apply dee → cur $(cur path)"
post /library/volume "{\"path\":\"$LD\",\"intValue\":30}" >/dev/null
waitfor $WAIT cur_near gain.user "$g30" && ok "/library/volume 30 on the playing item" || bad "override vol → $(cur gain.user)"
post /library/speed "{\"path\":\"$LD\",\"doubleValue\":1.25}" >/dev/null
waitfor $WAIT cur_near speed 1.25 && ok "/library/speed 1.25 on the playing item" || bad "override speed → $(cur speed)"
post /library/volume "{\"path\":\"$LB\",\"intValue\":40}" >/dev/null
TBR=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$LB\",\"loop\":true,\"gain.user\":0},\"align\":\"end\"}")
TB=$(echo "$TBR" | jq -r .to); TBC=$(echo "$TBR" | jq -r .corr)
sleep 0.3   # another client's switch: the backend learns of B from its transition.scheduled event
setting '.Volume = 70'
gB_is() { gB=$(ctl get "{\"path\":\"$TB.gain.user\"}" | jq -r .value); near "$gB" "$1"; }
waitfor $WAIT gB_is "$g40"; gD=$(cur gain.user)
near "$gD" "$g30" && ok "global Volume 70 keeps the playing item's override 30 (gain $gD)" || bad "playing item → $gD"
near "$gB" "$g40" && ok "pending B ($TB) got ITS override 40 (gain $gB)" || bad "pending B → $gB"

echo "== pause during an in-flight transition (R75 final: ONE set player.paused freezes A and the pending B ($TB))"
# $TB is still SCHEDULED (align:end, waiting for a 10 s clip to reach its end) — the recipe holds a
# scheduled/pending B at frame 0 (its own `paused`, nothing to do with player.paused) regardless of our
# toggle, same as before R75; it only comes off hold at its own handoff. So A is the one that proves the
# toggle (it's genuinely playing, not recipe-held) — B's effective_paused must stay true continuously,
# proving the hold survives an unrelated player.paused flip rather than fighting it (player-core.md §
# Graph & properties "Player node paused": a recipe-held source's own `paused` is never touched by the
# override, so a resume doesn't un-pause what the RECIPE is deliberately holding).
TA=$(srcIdForPath "$LD")
pause_reads() { pp=$(playerPaused); pa=$(srcPaused "$TA"); pb=$(srcPaused "$TB"); [ "$pp" = "$1" ] && [ "$pa" = "$1" ]; }
post /pause '{}' >/dev/null; waitfor $WAIT pause_reads true
[ "$pp" = true ] && [ "$pa" = true ] && [ "$pb" = true ] && ok "/pause → player.paused, A ($TA) and pending B ($TB) both effective_paused" || bad "pause: player=$pp A=$pa B=$pb"
post /pause '{}' >/dev/null; waitfor $WAIT pause_reads false
[ "$pp" = false ] && [ "$pa" = false ] && [ "$pb" = true ] && ok "/pause again → player+A unpaused, B stays held (unaffected, still scheduled)" || bad "unpause: player=$pp A=$pa B=$pb"
# B's part ends here: cancel it, so dee (10 s at 1.25×) keeps the screen through the sections below
# instead of handing off to bee (its own override 40) at its end — under load the checks below
# reached that end ("after SIGCONT → −23.88 dB" = bee's 40 %, not the global 50 %).
ctl cancel "{\"corr\":\"$TBC\"}" >/dev/null
waitfor $WAIT settled || bad "cancel $TBC: transitions $(ctl state | jq -c '[.transitions[].phase]')"
post /library/volume "{\"path\":\"$LD\",\"intValue\":null}" >/dev/null
waitfor $WAIT cur_near gain.user "$g70" && ok "clearing the override → global 70" || bad "cleared → $(cur gain.user)"

echo "== a SIGSTOPped player never stalls the backend (no player I/O under PlayerHelper's _lock; stall breaker)"
body60=$(curl -sf -m 5 "$U/settings" | jq -c '.Volume = 60'); body61=$(echo "$body60" | jq -c '.Volume = 61')
# The COMPOSITOR ($CP) holds the socket — the supervisor never answers requests — so IT must be the one
# stopped; stopping $SP (the supervisor) instead would feel nothing and prove nothing.
kill -STOP "$CP"
m1=$(post_ms /settings "$body60"); m2=$(post_ms /settings "$body61")
m3=$(post_ms /pause '{}'); m4=$(post_ms /volume '{"delta":-5}')
kill -CONT "$CP"
[ "$m1" -lt 500 ] && [ "$m2" -lt 500 ] && ok "/settings Volume with the player stopped: ${m1} ms, then ${m2} ms (< 500)" || bad "/settings took ${m1} / ${m2} ms"
[ "$m3" -lt 500 ] && [ "$m4" -lt 500 ] && ok "/pause ${m3} ms, /volume ${m4} ms with the player stopped (< 500)" || bad "/pause ${m3} ms, /volume ${m4} ms"
sleep 3.5   # the breaker re-opens 3 s after the last timeout
setting '.Volume = 50'
waitfor $WAIT cur_near gain.user -18.0618 && ok "after SIGCONT: /settings Volume 50 applies again" || bad "after SIGCONT → $(cur gain.user) on $(basename "$(cur path)")"
[ "$(playerPaused)" = false ] || post /pause '{}' >/dev/null   # the /pause sent while stopped was dropped (breaker) — normalize
post /stop '{}' >/dev/null; waitfor $WAIT nothing_shown || bad "/stop left $(cur path)"

echo "== supervised restart (kill -9 the COMPOSITOR, never the supervisor): the backend reconnects"
echo "== R81: the backend's current settings survive it (OnRestarted re-applies them)"
g37=$(dB 37)
post /apply "{\"path\":\"$A\"}" >/dev/null; waitfor $WAIT shows "$A" || bad "/apply a → cur $(cur path)"
setting '.Volume = 37'
waitfor $WAIT cur_near gain.user "$g37" && ok "Volume 37 before the kill" || bad "pre-kill volume → $(cur gain.user)"
re0=$(reapplies)
# Killing $SP outright would tear down the WHOLE supervisor+child tree (PR_SET_PDEATHSIG) — no restart
# at all. The real crash-recovery path is SIGKILLing the COMPOSITOR while its supervisor ($SP) lives:
# the supervisor restarts it (--restore) with a NEW hello.pid, same hello.supervisor_pid, in ~150-260 ms.
oldCP=$CP; kill -9 "$CP"
for _ in $(seq 1 30); do CP=$(comp_pid); [ -n "$CP" ] && [ "$CP" != "$oldCP" ] && break; sleep 0.05; done
[ -n "$CP" ] && [ "$CP" != "$oldCP" ] && ok "compositor restarted: $oldCP -> $CP within 1.5 s" || bad "no new hello.pid within 1.5 s after killing $oldCP"
[ "$(sup_pid)" = "$SP" ] && ok "same supervisor $SP after the restart" || bad "supervisor_pid $(sup_pid) != $SP after restart"
kill -0 "$SP" 2>/dev/null && ok "supervisor $SP never died" || bad "supervisor $SP is gone — it should have survived its child's crash"
# the adapter's queued OnRestarted reapply (it logs once it has pushed every value)
waitfor $WAIT reapply_seen "$re0" && ok "R81: adapter log shows a reapply after the restart" || bad "R81: no reapply log line after the restart"
waitfor $WAIT cur_near gain.user "$g37" && ok "R81: gain.user still 37% ($(cur gain.user)) after the supervised restart" || bad "R81: gain.user $(cur gain.user) after restart, want $g37"
n0=$(handoffs)   # the temp state dir's event log spans both the old and the restarted compositor
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\"],\"settings\":{\"Order\":0}}" >/dev/null
nh=$(rotation_window "$n0" 6000)
gaps=$(ctl logs '{"kind_prefix":"transition.handoff","limit":10000}' | jq -c --argjson n "$n0" '[.events[$n:] | map(.t_mono_ms) | . as $t | range(1; length) | ($t[.] - $t[.-1] | floor)]')
echo "     handoff gaps (ms): $gaps"
[ $nh -ge 2 ] && [ $nh -le 5 ] && ok "rotation runs on the new player ($nh handoffs in 6 s)" || bad "after restart: $nh handoffs in 6 s"
echo "$gaps" | jq -e '.[1:] | all(. >= 1200)' >/dev/null && ok "no switch storm after the restart (aligned gaps ≥ 1.2 s)" || bad "storm: gaps $gaps"
stop_now

echo "== I3: a keybind's toggle-pause (a separate one-shot CLI process) survives a compositor restart"
post /apply "{\"path\":\"$A\"}" >/dev/null; waitfor $WAIT shows "$A" || bad "/apply a → cur $(cur path)"
pp=$(playerPaused); [ "$pp" = false ] && ok "a new session (/apply) plays" || bad "/apply left player.paused $pp"
"$DOTNET" "$DLL" toggle-pause > "$T/cli1.log" 2>&1
waitfor $WAIT paused_is true && ok "CLI toggle-pause → player.paused" || bad "CLI toggle → $(playerPaused)"
# Precondition: the player's snapshot carries the pause (written 250 ms after a change — a fixed 0.6 s
# wait didn't always cover it under load, and a crash before it restores the player unpaused).
waitfor $WAIT snap_paused true || bad "the snapshot never recorded player.paused=true: $(jq -c .player "$SNAP" 2>&1)"
re0=$(reapplies)
oldCP=$CP; kill -9 "$CP"
for _ in $(seq 1 30); do CP=$(comp_pid); [ -n "$CP" ] && [ "$CP" != "$oldCP" ] && break; sleep 0.05; done
# the backend's OnRestarted reapply must have RUN before this proves it didn't flip the pause
waitfor $WAIT reapply_seen "$re0" || bad "no reapply after the restart (compositor $oldCP → $CP)"
pp=$(playerPaused); [ "$pp" = true ] && ok "pause survived the restart + the backend's reapply (not flipped)" || bad "after restart: player.paused $pp"
"$DOTNET" "$DLL" toggle-pause > "$T/cli2.log" 2>&1
waitfor $WAIT paused_is false && ok "a second CLI toggle resumes" || bad "second CLI toggle → $(playerPaused)"

echo "== I1: pause → /stop → /apply: the new session plays (legacy semantics)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true || bad "/pause → player.paused $(playerPaused)"
stop_now
waitfor $WAIT paused_is false && ok "/stop cleared player.paused" || bad "after /stop: player.paused $(playerPaused)"
post /apply "{\"path\":\"$Bc\"}" >/dev/null; waitfor $WAIT shows "$Bc"
tb=$(srcIdForPath "$Bc"); cp=$(cur path); ep=$(srcPaused "$tb")
[ "$cp" = "$Bc" ] && [ "$ep" = false ] && ok "/apply after pause+stop plays b ($tb)" || bad "/apply after stop: cur $cp effective_paused $ep"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true || bad "/pause → player.paused $(playerPaused)"
post /apply "{\"path\":\"$A\"}" >/dev/null; waitfor $WAIT shows "$A"
pp=$(playerPaused); cp=$(cur path)
[ "$pp" = false ] && [ "$cp" = "$A" ] && ok "pause → /apply (no stop): the new session plays" || bad "pause → /apply: player.paused $pp, cur $cp"
stop_now

echo "== I4: every output gone (monitors off): an advance-on-end rotation never spins, the last target shows on replug"
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\",\"$C\"],\"settings\":{\"Order\":0}}" >/dev/null; sleep 3
ctl headless.remove_output '{"name":"VIRTUAL-1"}' >/dev/null; ctl headless.remove_output '{"name":"VIRTUAL-2"}' >/dev/null
sleep 1
ns0=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '.events|length')
sleep 8
ns1=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '.events|length')
[ $((ns1 - ns0)) -le 2 ] && ok "no switch storm with no output: $((ns1 - ns0)) switch request(s) in 8 s" || bad "with no output: $((ns1 - ns0)) switch requests in 8 s (a spin)"
pk=$(ctl state | jq -r .parked); last=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r '.events[-1].to')
[ "$pk" = "$last" ] && ok "the last requested target ($last) is the parked wallpaper" || bad "parked $pk, last target $last"
nh0=$(handoffs)
ctl headless.add_output '{"name":"VIRTUAL-3","width":640,"height":360,"hz":60}' >/dev/null
v3_shows() { v3=$(ctl get '{"path":"lay:VIRTUAL-3:main.content"}' | jq -r .value); [ "$v3" = "$1" ]; }
waitfor $WAIT v3_shows "$last" && ok "replug shows the last target" || bad "replug shows $v3"
waitfor $WAIT handed_more "$nh0" && ok "rotation resumes after the replug" || bad "rotation stalled after the replug"
stop_now
ctl headless.add_output '{"name":"VIRTUAL-2","width":320,"height":180,"hz":60}' >/dev/null

echo "== Task 20c: /next /prev /random skip scenes under liascape-player (never a 500, never land on one)"
# Minimal fake scene items the way LibraryService/PlayerHelper actually recognize them (library.md /
# player.md): a library-item FOLDER with project.json {"type":"scene"} and NO media file — exactly
# what IsSceneFolder checks, and exactly what makes PlayerHelper.IsScenePath (no media extension) true
# for that folder's path. No linux-wallpaperengine / scene.pkg needed to be *recognized* as a scene —
# only to actually render one, which these never attempt (they must be SKIPPED, not launched).
LIB=$XDG_DATA_HOME/liascape/library
postcode() { curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'Content-Type: application/json' -d "${2:-{}}" "$U$1"; }
postbody() { curl -s -m 10 -X POST -H 'Content-Type: application/json' -d "${2:-{}}" "$U$1"; }

mkdir -p "$LIB/imported/sv1" "$LIB/imported/sv2" "$LIB/imported/sv3" "$LIB/imported/ss1" "$LIB/imported/ss2"
cp "$A" "$LIB/imported/sv1/sv1.mp4"; cp "$A" "$LIB/imported/sv2/sv2.mp4"; cp "$A" "$LIB/imported/sv3/sv3.mp4"
echo '{"type":"scene"}' > "$LIB/imported/ss1/project.json"
echo '{"type":"scene"}' > "$LIB/imported/ss2/project.json"
SV1=$LIB/imported/sv1/sv1.mp4; SV2=$LIB/imported/sv2/sv2.mp4; SV3=$LIB/imported/sv3/sv3.mp4
SS1=$LIB/imported/ss1; SS2=$LIB/imported/ss2
curl -sf -m 5 "$U/library" | jq -e --arg p "$SS1" '[.[] | select(.videoPath==$p)][0].isScene == true' >/dev/null \
  && ok "fake scene item recognized by /library (isScene=true, no media file)" || bad "fake scene not recognized as a scene"

post /apply "{\"path\":\"$SV1\"}" >/dev/null
waitfor $WAIT shows "$SV1" && ok "/apply sv1 (library/single-wallpaper mode) → cur sv1" || bad "/apply sv1 → cur $(cur path)"

step_many() {   # $1 = /next|/prev|/random, $2 = iteration count
  local route=$1 n=$2 allok=1 sceneHit=0 i p code
  for i in $(seq 1 "$n"); do
    code=$(postcode "$route")
    [ "$code" = 200 ] || allok=0
    sleep 0.5
    p=$(cur path)
    { [ "$p" = "$SS1" ] || [ "$p" = "$SS2" ]; } && sceneHit=1
  done
  [ "$allok" = 1 ] && ok "$n x $route all returned 200 (mixed video/scene library)" || bad "$n x $route had a non-200 response"
  [ "$sceneHit" = 0 ] && ok "$n x $route never landed on a scene" || bad "$route landed on a scene — TryStepLibrary/ApplyRandom didn't skip it"
}
step_many /next 20
step_many /prev 20
step_many /random 20

echo "== Task 20c: an all-scene library → 409, no hang, no crash, current wallpaper untouched"
mv "$LIB/imported/sv1" "$T/removed-sv1"; mv "$LIB/imported/sv2" "$T/removed-sv2"; mv "$LIB/imported/sv3" "$T/removed-sv3"
mv "$(dirname "$LD")" "$T/removed-ld"; mv "$(dirname "$LB")" "$T/removed-lb"
before=$(cur path)
code=$(postcode /next); body=$(postbody /next)
[ "$code" = 409 ] && ok "/next on an all-scene library → 409 (not a 500, not a hang)" || bad "/next on all-scene library → $code"
echo "$body" | jq -e '.error | contains("No playable wallpaper")' >/dev/null \
  && ok "409 body carries a clear message: $(echo "$body" | jq -r .error)" || bad "409 body: $body"
after=$(cur path)
[ "$after" = "$before" ] && ok "the failed /next left the current wallpaper untouched ($before)" || bad "cur path changed: $before -> $after"
code=$(postcode /random)
[ "$code" = 409 ] && ok "/random on an all-scene library → 409 too" || bad "/random on all-scene library → $code"
code=$(postcode /prev)
[ "$code" = 409 ] && ok "/prev on an all-scene library → 409 too" || bad "/prev on all-scene library → $code"

mv "$T/removed-sv1" "$LIB/imported/sv1"; mv "$T/removed-sv2" "$LIB/imported/sv2"; mv "$T/removed-sv3" "$LIB/imported/sv3"
mv "$T/removed-ld" "$(dirname "$LD")"; mv "$T/removed-lb" "$(dirname "$LB")"
# The legacy-engine "scenes still reachable when AllowScenes=true" decision-point check lives in the
# self-test instead (LiascapePlayerSelfTest.SceneSkipAssertions) — this IT script stays on liascape-player
# throughout by design (see header: "it aborts before any playback call unless active: liascape-player"),
# and switching the live engine to legacy here while something is playing would try to launch a real
# mpvpaper/LWE, which this hermetic sandbox explicitly never does.
stop_now

echo "== Phase 2: scenes under liascape-player (synthetic scenes — the player runs with LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1)"
# Synthetic scene items the way liascape-player's tests write them (tests/common::synthetic_scene): a workshop item
# folder with project.json type scene + scene.pkg + preview.png + liascape-synthetic.json (the worker's synthetic
# renderer; only with the env gate — WE's assets are proprietary, no real scene renders hermetically).
mk_scene() {   # $1 = item folder, $2 = liascape-synthetic.json
  mkdir -p "$1"
  printf '{"type":"scene","title":"%s","file":"scene.json","preview":"preview.png"}' "$(basename "$1")" > "$1/project.json"
  head -c 16 /dev/zero > "$1/scene.pkg"
  printf '%s' "$2" > "$1/liascape-synthetic.json"
  echo iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC | base64 -d > "$1/preview.png"
}
# Task 20c's fake scenes have no liascape-synthetic.json (they'd need WE's assets): out of the library meanwhile
mv "$LIB/imported/ss1" "$T/removed-ss1"; mv "$LIB/imported/ss2" "$T/removed-ss2"
S1=$LIB/workshop/900000001; S2=$LIB/workshop/900000002; S3=$LIB/workshop/900000003; S4=$LIB/workshop/900000004
mk_scene "$S1" '{"pattern":"solid","rgb":[255,0,0],"native":[640,360],"has_audio":true,"tone_hz":440}'
mk_scene "$S2" '{"pattern":"solid","rgb":[0,0,255],"native":[640,360],"has_audio":true,"tone_hz":660}'
mk_scene "$S3" '{"pattern":"solid","rgb":[0,255,0],"native":[640,360],"crash_after_ms":400}'
mk_scene "$S4" '{"pattern":"solid","native":[640,360]}'
IDX=$LIB/workshop/index.json
setting '.AllowScenes = true | .Volume = 100 | .Speed = 1 | .NoAudio = false | .SceneMonitors = []'
pe_scenes() { curl -sf -m 5 "$U/player-engine" | jq -c .scenes; }
curl -sf -m 5 "$U/player-engine" | jq -e '.scenes.available == true' >/dev/null && ok "/player-engine.scenes: $(pe_scenes)" || bad "/player-engine.scenes: $(pe_scenes)"
nsch() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '.events|length'; }
wpid() { ctl state | jq -r --arg id "$1" '.workers[]? | select(.id==$id) | .pid // empty'; }
waudio() { ctl probe '{"name":"workers"}' | jq -r --arg id "$1" ".workers[] | select(.id==\$id) | .audio.$2"; }
pid_gone() { ! kill -0 "$1" 2>/dev/null; }
scene_ready() { [ "$(cur path)" = "$1" ] && [ "$(cur kind)" = scene ] && [ "$(cur ready)" = true ]; }
# the newest switch to $1 (after scheduled event $2, of align $3) and its outcome
corr_to() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg p "$1" --argjson n "$2" --arg a "$3" '[.events[$n:][] | select(.path==$p and .align==$a)][-1].corr // empty'; }
switched_to() { sc=$(corr_to "$1" "$2" "${3:-now}"); [ -n "$sc" ] && [ "$(corr_has "$sc" handoff)" -ge 1 ]; }
method_of() { ctl logs "{\"corr\":\"$1\",\"kind_prefix\":\"transition.started\"}" | jq -r '.events[-1] | "\(.effect_id) \(.method)"'; }

t_ap=$(ms_now); post /apply "{\"path\":\"$S1\"}" >/dev/null
waitfor 3000 scene_ready "$S1" && ok "/apply a scene → cur kind scene, ready in $(( $(ms_now) - t_ap )) ms" || bad "/apply a scene → path $(basename "$(cur path)") kind $(cur kind) ready $(cur ready)"
[ "$(cur preview)" = "$S1/preview.png" ] && ok "the scene source carries the item's preview" || bad "preview → $(cur preview)"
SID=$(srcIdForPath "$S1"); WP=$(wpid "$SID")
[ -n "$WP" ] && kill -0 "$WP" 2>/dev/null && ok "its worker runs (pid $WP)" || bad "no worker for $SID: $(ctl state | jq -c .workers)"
setting '.Volume = 50'; waitfor $WAIT cur_near gain.user -18.0618 && ok "Volume 50 → the scene's gain.user $(cur gain.user)" || bad "Volume 50 → scene gain.user $(cur gain.user)"
waitfor $WAIT eval '[ "$(waudio "$SID" gain_db)" != null ] && near "$(waudio "$SID" gain_db)" -18.0618 0.05' && ok "…reaches the worker's stream ($(waudio "$SID" gain_db) dB)" || bad "worker audio gain_db $(waudio "$SID" gain_db)"
setting '.Volume = 100'
setting '.NoAudio = true'
waitfor $WAIT eval 'cur_is no_audio true && [ "$(waudio "$SID" no_audio)" = true ]' && [ "$(wpid "$SID")" = "$WP" ] && ok "NoAudio → the scene's no_audio live (worker too), same worker $WP" || bad "NoAudio → no_audio $(cur no_audio), worker $(waudio "$SID" no_audio), pid $WP → $(wpid "$SID")"
setting '.NoAudio = false'
waitfor $WAIT eval 'cur_is no_audio false && [ "$(waudio "$SID" no_audio)" = false ]' && [ "$(wpid "$SID")" = "$WP" ] && ok "NoAudio off → live, same worker" || bad "NoAudio off → $(cur no_audio) / $(waudio "$SID" no_audio), pid $(wpid "$SID")"
out_fps() { ctl get "{\"path\":\"out:$1.scene_fps\"}" | jq -r .value; }
# the outputs there are now (the I4 section above replugs them as VIRTUAL-3 + VIRTUAL-2), every one in SceneMonitors
OUTS=$(ctl state | jq -c '[.outputs[].name]'); O1=$(echo "$OUTS" | jq -r '.[0]')
all_fps() { echo "$OUTS" | jq -r '.[]' | while read -r o; do near "$(out_fps "$o")" "$1" || return 1; done; }
fps_now() { all_fps "$1" && near "$(ctl probe '{"name":"workers"}' | jq -r --arg id "$SID" '.workers[] | select(.id==$id) | .fps_target')" "$1"; }
setting ".SceneMonitors = ($OUTS | to_entries | map({Name: .value, Fps: 45, IsPrimary: (.key == 0)}))"
waitfor $WAIT fps_now 45 && [ "$(wpid "$SID")" = "$WP" ] && ok "SceneMonitors fps 45 on $OUTS → each out:<c>.scene_fps 45 live, the worker ticks at 45, same pid" || bad "SceneMonitors fps → out:$O1 $(out_fps "$O1"), worker $(ctl probe '{"name":"workers"}' | jq -c --arg id "$SID" '.workers[] | select(.id==$id) | {fps_target, pid}')"
setting '.SceneMonitors = []'
waitfor $WAIT fps_now 30 && ok "SceneMonitors emptied → back to the default 30" || bad "SceneMonitors [] → out:$O1 $(out_fps "$O1")"

# /library/volume on the playing scene moves that source only — mid-fade (6 s) to another scene, both live
setting '.GlobalTransitionDurationMs = 6000'
post /apply "{\"path\":\"$S2\"}" >/dev/null
fade_running() { ctl state | jq -e '[.transitions[] | select(.phase=="running")] | length > 0' >/dev/null; }
waitfor $WAIT fade_running || bad "no S1 → S2 fade running"
ID1=$SID; ID2=$(srcIdForPath "$S2")
gain_of() { ctl get "{\"path\":\"$1.gain.user\"}" | jq -r .value; }
g2a=$(gain_of "$ID2"); g30=$(dB 30)
post /library/volume "{\"path\":\"$S1\",\"intValue\":30}" >/dev/null
waitfor $WAIT eval 'near "$(gain_of "$ID1")" "$g30"' && near "$(gain_of "$ID2")" "$g2a" && ok "/library/volume 30 on scene 1 mid-fade → its source only (gain $(gain_of "$ID1"); scene 2 stays $(gain_of "$ID2"))" || bad "/library/volume mid-fade: $ID1 $(gain_of "$ID1") (want $g30), $ID2 $(gain_of "$ID2") (was $g2a)"
post /library/volume "{\"path\":\"$S1\",\"intValue\":100}" >/dev/null   # == global → the override is dropped
setting '.GlobalTransitionDurationMs = 300'
waitfor 15000 shows "$S2" || bad "the 6 s fade never handed off: cur $(basename "$(cur path)")"
WP2=$(wpid "$ID2"); t_stop=$(ms_now); post /stop '{}' >/dev/null
[ -n "$WP2" ] && waitfor 1000 pid_gone "$WP2" && ok "/stop → the scene's worker ($WP2) gone in $(( $(ms_now) - t_stop )) ms" || bad "/stop: worker $WP2 still alive after 1 s"
waitfor $WAIT nothing_shown || bad "/stop left $(cur path)"

# switches with scenes: V→S, S→S, S→V through /next (full-live fades), and an aligned V→S at A's end
ns=$(nsch)
post /playlist/play "{\"paths\":[\"$D\",\"$S1\",\"$S2\"],\"settings\":{\"Order\":0}}" >/dev/null
# (a video's aligned switch to the next item is armed at once, so "settled" never holds while D plays)
waitfor $WAIT cur_is path "$D" || bad "play [d, s1, s2] → cur $(basename "$(cur path)")"
for step in "V→S:$S1" "S→S:$S2" "S→V:$D"; do
  what=${step%%:*}; to=${step#*:}; ns=$(nsch); post /next '{}' >/dev/null
  if waitfor $WAIT switched_to "$to" "$ns"; then
    m=$(method_of "$sc"); [ "$m" = "fade full-live" ] && waitfor $WAIT cur_is path "$to" && ok "/next $what ($(basename "$to")): $m, handed off ($sc)" || bad "/next $what: $m, cur $(basename "$(cur path)")"
  else bad "/next $what: no handoff to $(basename "$to") (corr ${sc:-none}), cur $(basename "$(cur path)")"; fi
done
stop_now
ns=$(nsch)
post /playlist/play "{\"paths\":[\"$A\",\"$S1\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor 15000 switched_to "$S1" "$ns" end && waitfor $WAIT scene_ready "$S1" && ok "an aligned V→S at the video's end ($sc): $(method_of "$sc"), the scene shows" || bad "aligned V→S: corr ${sc:-none}, cur $(basename "$(cur path)") kind $(cur kind)"
stop_now
# a scene never ends: under advance-on-end it plays until the minimum play time (it has no end to wait for — the
# minimum reached IS its end), else until the maximum, else until a user switch (align:now, a transition like a timed switch)
m0=$(nsched_all)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT scene_ready "$S1"; sleep 4
[ "$(n_sched_to "$m0" "$A")" = 0 ] && ok "advance-on-end, no minimum, no maximum: the scene still plays after 4 s" || bad "a scene under advance-on-end (no limits) switched within 4 s ($(n_sched_to "$m0" "$A") switches to a)"
stop_now
setting '.GlobalIntervalSeconds = 3'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$A"
between "$(sw_field 1)" 2300 3900 && [ "$(sw_field 3)" = now ] && ok "min 3 s on a scene: advanced once it was reached (+$(sw_field 1) ms, align $(sw_field 3))" || bad "min 3 s × scene: $swr (want align now at +2.3…3.9 s)"
setting '.GlobalIntervalSeconds = 0'; stop_now
setting '.GlobalMaxPlaySeconds = 3'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$A"
between "$(sw_field 1)" 2300 3900 && [ "$(sw_field 3)" = now ] && ok "max 3 s on a scene: advanced 3 s in (+$(sw_field 1) ms, align $(sw_field 3))" || bad "max 3 s × scene: $swr (want align now at +2.3…3.9 s)"
setting '.GlobalMaxPlaySeconds = 0'; stop_now

echo "-- separate timing for scenes: ON → a scene switches after its own time (0 = off), the minimum / maximum don't apply to it; videos keep theirs"
setting '.GlobalIntervalSeconds = 6 | .GlobalMaxPlaySeconds = 0 | .GlobalSeparateSceneTiming = true | .GlobalSwitchScenesAfterSeconds = 3'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$A"
between "$(sw_field 1)" 2300 3900 && [ "$(sw_field 3)" = now ] && ok "scenes after 3 s (minimum 6 s): the scene advanced at its own 3 s (+$(sw_field 1) ms, align $(sw_field 3))" || bad "scenes after 3 s × min 6 × scene: $swr (want align now at +2.3…3.9 s)"
stop_now
# e1 → s1 → e2 with a 3 s maximum and scenes after 5 s: e1 is cut at 3 s (the maximum is a video's), s1 plays its own 5 s
setting '.GlobalIntervalSeconds = 0 | .GlobalMaxPlaySeconds = 3 | .GlobalSwitchScenesAfterSeconds = 5'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$S1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 20000 sw_seen "$m0" "$E2"; sw_e2=$swr
swr=$(sw_to "$m0" "$S1")
between "$(sw_field 1)" 2300 3900 && [ "$(sw_field 3)" = now ] && ok "max 3 s still cuts a video with the scene timing on (e1 → s1 at +$(sw_field 1) ms)" || bad "max 3 s × video × scene timing on: $swr"
s1_at=$(sw_field 1); swr=$sw_e2
d=$(( ${swr%% *} - ${s1_at:-0} ))
between "$d" 4300 6000 && [ "$(sw_field 3)" = now ] && ok "…and s1 played its own 5 s, not the 3 s maximum (s1 → e2 $d ms after its switch)" || bad "scenes after 5 s × max 3 s × scene: $swr ($d ms after s1's switch; want 4.3…6.0 s)"
stop_now
# scenes after 0 = off: the scene stays, the maximum (2 s) doesn't move it
setting '.GlobalMaxPlaySeconds = 2 | .GlobalSwitchScenesAfterSeconds = 0'
m0=$(nsched_all)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT scene_ready "$S1"; sleep 4
[ "$(n_sched_to "$m0" "$A")" = 0 ] && ok "scenes after 0 = off (a 2 s maximum): the scene still plays after 4 s" || bad "scenes after 0 × max 2 × scene: $(n_sched_to "$m0" "$A") switches to a"
stop_now
# a one-item playlist never switches to itself
setting '.GlobalMaxPlaySeconds = 0 | .GlobalSwitchScenesAfterSeconds = 2'
m0=$(nsched_all)
post /playlist/play "{\"paths\":[\"$S1\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT scene_ready "$S1"; sleep 4
[ "$(n_sched_to "$m0" "$S1")" = 1 ] && ok "scenes after 2 s on a one-item playlist: no switch to itself in 4 s" || bad "one-item scene playlist: $(n_sched_to "$m0" "$S1") switches to s1 (want only the play's own)"
stop_now
# OFF → the video rules (the minimum reached is a scene's end): "Switch scenes after" is ignored
setting '.GlobalSeparateSceneTiming = false | .GlobalIntervalSeconds = 3 | .GlobalSwitchScenesAfterSeconds = 9'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0}}" >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$A"
between "$(sw_field 1)" 2300 3900 && [ "$(sw_field 3)" = now ] && ok "separate timing OFF: the scene moved at the minimum 3 s (+$(sw_field 1) ms), its own 9 s ignored" || bad "separate timing off × min 3 × scene: $swr"
stop_now
# live: OFF (min 0, max 0 → the scene stays) → ON with 4 s ~1.5 s in, then an unrelated edit: it advances 4 s after s1
# showed — the play time kept counting, neither edit restarted it
setting '.GlobalIntervalSeconds = 0 | .GlobalSwitchScenesAfterSeconds = 0'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT scene_ready "$S1"; sleep 1.5
setting '.GlobalSeparateSceneTiming = true | .GlobalSwitchScenesAfterSeconds = 4'; t_set=$(ms_now); sleep 1; setting '.Volume = 90'
swr=none; waitfor 15000 sw_seen "$m0" "$A"
rel=$(( t_set - $(t0w) )); echo "     separate timing turned on ${rel} ms after s1 showed"
between "$(sw_field 1)" 3300 5000 && [ "$(sw_field 3)" = now ] && ok "separate timing on + 4 s set live (+${rel} ms) + a volume edit: s1 advanced at +$(sw_field 1) ms of its play" \
  || bad "scene timing live: $swr (want align now at +3.3…5.0 s of s1, set at +${rel} ms)"
setting '.Volume = 100'; stop_now
# a playlist's own (override): its 0 = off beats the globals' 2 s; a /playlist/state edit to 4 s ~1 s in (and an
# unrelated transition edit after it) → it advances 4 s after s1 showed
setting '.GlobalSwitchScenesAfterSeconds = 2'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$S1\",\"$A\"],\"settings\":{\"Order\":0,\"OverrideGlobalSettings\":true,\"SwitchWhenVideoEnds\":true,\"IntervalSeconds\":0,\"MaxPlaySeconds\":0,\"SeparateSceneTiming\":true,\"SwitchScenesAfterSeconds\":0,\"TransitionEnabled\":true,\"TransitionEffectIds\":[\"fade\"],\"TransitionDurationMs\":300}}" >/dev/null
waitfor $WAIT scene_ready "$S1"; sleep 1
post /playlist/state '{"settings":{"switchScenesAfterSeconds":4}}' >/dev/null; t_set=$(ms_now); sleep 1
post /playlist/state '{"settings":{"transitionDurationMs":350}}' >/dev/null
swr=none; waitfor 15000 sw_seen "$m0" "$A"
rel=$(( t_set - $(t0w) )); echo "     the playlist's own 4 s set ${rel} ms after s1 showed"
between "$(sw_field 1)" 3300 5000 && [ "$(sw_field 3)" = now ] && ok "the playlist's own scene timing (0 → 4 s live via /playlist/state, the globals' 2 s ignored): advanced at +$(sw_field 1) ms" \
  || bad "playlist override scene timing: $swr (want align now at +3.3…5.0 s; the globals' 2 s would land ≤ +2.9 s)"
setting '.GlobalSeparateSceneTiming = false | .GlobalSwitchScenesAfterSeconds = 0 | .GlobalIntervalSeconds = 0 | .GlobalMaxPlaySeconds = 0'; stop_now

echo "-- scene properties (project.json general.properties → the item's index → scene_props, live)"
# scene 1 gets WE-style user properties: `color` (the synthetic renderer's WE-encoded colour — red by default),
# a bool other properties depend on (`condition`), a slider, a combo, a text input, a label and a usershortcut
cat > "$S1/project.json" <<'EOF'
{"type":"scene","title":"900000001","file":"scene.json","preview":"preview.png","general":{"properties":{
 "color":{"order":0,"text":"ui_browse_properties_scheme_color","type":"color","value":"1 0 0"},
 "hdr":{"order":1,"text":"<hr><h4>Clock</h4>"},
 "clock":{"order":2,"text":"Show clock","type":"bool","value":true},
 "style":{"order":3,"text":"Style","type":"combo","value":"1","options":[{"label":"Digital","value":"1"},{"label":"Analog","value":"2"}],"condition":"clock.value"},
 "bars":{"order":4,"text":"Bars","type":"slider","value":32,"min":16,"max":64,"fraction":false,"condition":"clock.value && style.value == 2"},
 "name":{"order":5,"text":"Name","type":"textinput","value":"YOU"},
 "dock":{"order":6,"text":"#1","type":"usershortcut","value":""}}}}
EOF
sp_get() { curl -sf -m 5 "$U/library/scene-props?path=$S1"; }
sp_set() { curl -s -m 10 -o "$T/sp.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$1" "$U/library/scene-props"; }
sp_prev() { curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$1" "$U/library/scene-props/preview"; }
live_sp() { ctl get "{\"path\":\"$1.scene_props\"}" | jq -c '.value'; }
idx_sp()  { jq -c '."900000001".sceneProps // null' "$IDX"; }
# one pixel of a source's own picture (rgb), from a capture
px() { ctl capture "{\"target\":\"$1\",\"path\":\"$T/px.png\"}" >/dev/null 2>&1 && ffmpeg -nostdin -loglevel error -i "$T/px.png" -vf "crop=1:1:100:100" -f rawvideo -pix_fmt rgb24 - | od -An -tu1 | tr -s ' ' | sed 's/^ //;s/ $//'; }
px_is() { [ "$(px "$1")" = "$2" ]; }
SPJ=$(sp_get)
echo "$SPJ" | jq -e '[.props[].name] == ["color","hdr","clock","style","bars","name","dock"]
  and (.props[0] | .type == "color" and .label == "Scheme color" and .value == "1 0 0" and .overridden == false and .editable)
  and (.props[1] | .type == "text" and .label == "Clock" and (.editable | not))
  and (.props[3] | .visible and (.options | length) == 2) and (.props[4] | .visible | not)
  and (.props[6] | (.editable | not) and .unsupported != null) and .live == true' >/dev/null \
  && ok "GET /library/scene-props: 7 properties in order, types/labels/defaults, condition visibility, usershortcut not editable" || bad "GET /library/scene-props → $(echo "$SPJ" | jq -c '[.props[] | {name, type, label, value, visible, editable}]')"
post /apply "{\"path\":\"$S1\"}" >/dev/null
waitfor $WAIT scene_ready "$S1" || bad "/apply scene 1 → $(basename "$(cur path)")"
SID=$(srcIdForPath "$S1"); WP=$(wpid "$SID")
waitfor $WAIT px_is "$SID" "255 0 0" && [ "$(live_sp "$SID")" = "{}" ] && ok "at defaults: red, scene_props {}" || bad "defaults: pixel $(px "$SID"), scene_props $(live_sp "$SID")"
code=$(sp_set "{\"path\":\"$S1\",\"name\":\"color\",\"value\":\"0 1 0\"}")
[ "$code" = 200 ] && jq -e '.props[0] | .value == "0 1 0" and .overridden' "$T/sp.json" >/dev/null || bad "set color → HTTP $code $(head -c 300 "$T/sp.json")"
waitfor $WAIT px_is "$SID" "0 255 0" && [ "$(wpid "$SID")" = "$WP" ] \
  && ok "set color \"0 1 0\" → live: green on the same worker ($WP), scene_props $(live_sp "$SID")" || bad "set color: pixel $(px "$SID"), scene_props $(live_sp "$SID"), pid $WP → $(wpid "$SID")"
wprop_ok() { ctl probe '{"name":"workers"}' | jq -e --arg id "$1" --arg n "$2" '.workers[] | select(.id==$id) | .properties[$n].ok == true' >/dev/null; }
waitfor $WAIT wprop_ok "$SID" color && ok "…the worker took it (workers.properties.color.ok)" || bad "workers.properties: $(ctl probe '{"name":"workers"}' | jq -c --arg id "$SID" '.workers[] | select(.id==$id) | .properties')"
[ "$(idx_sp)" = '{"color":"0 1 0"}' ] && ok "persisted in the item's index: $(idx_sp)" || bad "index sceneProps $(idx_sp)"
code=$(sp_set "{\"path\":\"$S1\",\"name\":\"clock\",\"value\":false}")
[ "$code" = 200 ] && jq -e '(.props[] | select(.name=="style") | .visible | not) and (.props[] | select(.name=="clock") | .value == false)' "$T/sp.json" >/dev/null \
  && ok "clock false → its dependants hidden (condition)" || bad "clock false → HTTP $code $(jq -c '[.props[] | {name, value, visible}]' "$T/sp.json" 2>/dev/null)"
sp_is() { [ "$(live_sp "$1" | jq -c '{clock, color: (.color | map(round))}' 2>/dev/null)" = "$2" ]; }
waitfor $WAIT sp_is "$SID" '{"clock":false,"color":[0,1,0]}' \
  && ok "the source's scene_props carries both: $(live_sp "$SID")" || bad "scene_props $(live_sp "$SID")"
code=$(sp_set "{\"path\":\"$S1\",\"name\":\"bars\",\"value\":999}")
[ "$code" = 200 ] && jq -e '.props[] | select(.name=="bars") | .value == 64' "$T/sp.json" >/dev/null && ok "slider 999 → clamped to its max 64" || bad "bars 999 → HTTP $code"
c1=$(sp_set "{\"path\":\"$S1\",\"name\":\"style\",\"value\":\"9\"}"); c2=$(sp_set "{\"path\":\"$S1\",\"name\":\"dock\",\"value\":\"x\"}"); c3=$(sp_set "{\"path\":\"$S1\",\"name\":\"nope\",\"value\":1}")
[ "$c1$c2$c3" = 400400400 ] && ok "refused with 400: a combo value not among its options, a usershortcut, an unknown name" || bad "refusals: $c1 $c2 $c3"
before=$(idx_sp)
c=$(sp_prev "{\"path\":\"$S1\",\"name\":\"color\",\"value\":\"0 0 1\"}")
[ "$c" = 200 ] && waitfor $WAIT px_is "$SID" "0 0 255" && [ "$(idx_sp)" = "$before" ] && ok "preview color blue → live, nothing persisted" || bad "preview: HTTP $c, pixel $(px "$SID"), index $(idx_sp)"
sp_set "{\"path\":\"$S1\",\"name\":\"color\",\"value\":\"0 1 0\"}" >/dev/null   # the drag's persist (same value as saved)
waitfor $WAIT px_is "$SID" "0 255 0" && ok "the persist after a drag puts the saved value back (green)" || bad "after preview + persist: pixel $(px "$SID")"
# re-applied at every open: switch away and back (a new source), then a player restart
post /apply "{\"path\":\"$S2\"}" >/dev/null; waitfor $WAIT scene_ready "$S2" || bad "→ scene 2: $(basename "$(cur path)")"
post /apply "{\"path\":\"$S1\"}" >/dev/null; waitfor $WAIT scene_ready "$S1" || bad "→ scene 1 again: $(basename "$(cur path)")"
SID2=$(srcIdForPath "$S1")
[ "$SID2" != "$SID" ] && waitfor $WAIT px_is "$SID2" "0 255 0" && [ "$(live_sp "$SID2" | jq -c '{clock, color: (.color | map(round))}')" = '{"clock":false,"color":[0,1,0]}' ] \
  && ok "switched away and back → a new source ($SID → $SID2) opens with them: green, $(live_sp "$SID2")" || bad "after switch back: $SID → $SID2, pixel $(px "$SID2"), scene_props $(live_sp "$SID2")"
oldcp=$CP; kill -9 "$CP"
waitfor 8000 eval 'CP=$(comp_pid); [ -n "$CP" ] && [ "$CP" != "$oldcp" ]' || bad "no restarted compositor after kill -9 $oldcp"
waitfor $WAIT scene_ready "$S1" || bad "after the restart: cur $(basename "$(cur path)")"
SID3=$(srcIdForPath "$S1")
waitfor $WAIT px_is "$SID3" "0 255 0" && [ "$(live_sp "$SID3" | jq -c '.color | map(round)')" = '[0,1,0]' ] \
  && ok "player restart (compositor $oldcp → $CP) → the restored scene has them: green, $(live_sp "$SID3")" || bad "after restart: $SID3 pixel $(px "$SID3"), scene_props $(live_sp "$SID3")"
WP3=$(wpid "$SID3")
code=$(sp_set "{\"path\":\"$S1\",\"name\":\"color\",\"reset\":true}")
[ "$code" = 200 ] && jq -e '.props[0] | .value == "1 0 0" and (.overridden | not)' "$T/sp.json" >/dev/null && [ "$(idx_sp | jq -c 'has("color")')" = false ] \
  && waitfor $WAIT px_is "$SID3" "255 0 0" && [ "$(wpid "$SID3")" = "$WP3" ] \
  && ok "reset color → its default live (red, the default sent: $(live_sp "$SID3" | jq -c .color)), dropped from the index, same worker" || bad "reset color: HTTP $code, pixel $(px "$SID3"), index $(idx_sp), scene_props $(live_sp "$SID3")"
code=$(sp_set "{\"path\":\"$S1\",\"reset\":true}")
[ "$code" = 200 ] && [ "$(idx_sp)" = null ] && waitfor $WAIT eval '[ "$(live_sp "$SID3" | jq -c .clock)" = true ]' \
  && ok "reset all → no sceneProps in the index, clock back to true live" || bad "reset all: HTTP $code, index $(idx_sp), scene_props $(live_sp "$SID3")"
stop_now

# a WebSocket client of the backend's /events (one text message per line) → $1; its pid in $WSP
ws_listen() {
python3 - "${U##*:}" > "$1" 2>&1 <<'PY' & WSP=$!
import socket, sys, base64, os
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
s.send(("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % base64.b64encode(os.urandom(16)).decode()).encode())
buf = b""
def need(n):
    global buf
    while len(buf) < n:
        d = s.recv(65536)
        if not d: sys.exit(0)
        buf += d
need(4)
while b"\r\n\r\n" not in buf: need(len(buf) + 1)
head, buf = buf.split(b"\r\n\r\n", 1)
print(head.split(b"\r\n")[0].decode(), flush=True)
while True:   # server frames are unmasked: one text message per line
    need(2); n = buf[1] & 0x7f; o = 2
    if n == 126: need(4); n = int.from_bytes(buf[2:4], "big"); o = 4
    elif n == 127: need(10); n = int.from_bytes(buf[2:10], "big"); o = 10
    need(o + n); msg = buf[o:o + n]; op = buf[0] & 0x0f; buf = buf[o + n:]
    if op == 1: print(msg.decode(errors="replace"), flush=True)
PY
}
# a scene that keeps crashing (3 restarts in 60 s → broken) while it plays in a timed playlist
ws_listen "$T/ws-scene.log"
waitfor $WAIT eval 'grep -q " 101 " "$T/ws-scene.log"' || bad "WebSocket: $(head -c 300 "$T/ws-scene.log")"
ns=$(nsch)
post /playlist/play "{\"paths\":[\"$S3\",\"$S1\"],\"settings\":{\"Order\":0}}" >/dev/null
broken_ev() { ctl logs '{"kind_prefix":"source.broken","limit":1000}' | jq -c --arg p "$S3" '[.events[] | select(.path==$p)][-1] // empty'; }
waitfor 30000 eval 'bev=$(broken_ev); [ -n "$bev" ]' && ok "the crashing scene broke: $(echo "$bev" | jq -c '{scene_id, restarts, signal}')" || bad "no source.broken for the crashing scene"
t_b=0; [ -n "${bev:-}" ] && t_b=$(printf '%s' "$bev" | jq -r "$EV_MS")
waitfor $WAIT eval 'grep -q "scene-crashed" "$T/ws-scene.log" && grep "scene-crashed" "$T/ws-scene.log" | grep -qF "900000003"' && ok "WS scene-crashed for it" || bad "no WS scene-crashed: $(grep -c . "$T/ws-scene.log") lines"
waitfor $WAIT eval 'jq -e ".\"900000003\".crashed == true" "$IDX" >/dev/null' && ok "its index entry: crashed true" || bad "index: $(jq -c '."900000003"' "$IDX" 2>/dev/null)"
adv_ms() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg p "$S1" --argjson n "$ns" --argjson t "$t_b" "[.events[\$n:][] | select(.path==\$p) | $EV_MS - \$t | select(. >= -50)][0] // empty"; }
waitfor $WAIT eval 'am=$(adv_ms); [ -n "$am" ]'
[ -n "${am:-}" ] && python3 -c "import sys; sys.exit(0 if float('$am') <= 2000 else 1)" && ok "the rotation advanced to the next item $(printf %.0f "$am") ms after the break" || bad "advance after the break: ${am:-none} ms (cur $(basename "$(cur path)"))"
waitfor $WAIT scene_ready "$S1" || bad "after the break: cur $(basename "$(cur path)")"
ns=$(nsch); hit=0
for _ in 1 2 3; do post /next '{}' >/dev/null; waitfor $WAIT settled; [ "$(cur path)" = "$S3" ] && hit=1; done
[ -n "${bev:-}" ] && [ "$(corr_to "$S3" "$ns" now)" = "" ] && [ $hit = 0 ] && ok "/next ×3 skips the crashed scene" || bad "/next landed on the crashed scene"
post /library/whitelist "{\"path\":\"$S3\",\"value\":true}" >/dev/null
ns=$(nsch); post /next '{}' >/dev/null
waitfor $WAIT eval '[ -n "$(corr_to "$S3" "$ns" now)" ]' && ok "whitelisted → /next plays it again" || bad "whitelisted crashed scene still skipped (cur $(basename "$(cur path)"))"
post /library/whitelist "{\"path\":\"$S3\",\"value\":false}" >/dev/null
stop_now
kill "$WSP" 2>/dev/null; WSP=""

# a scene folder that's gone (deleted, Steam still downloading): the switch fails cleanly, no crash mark
mv "$S4" "$T/removed-s4"
ns=$(nsch); post /apply "{\"path\":\"$S4\"}" >/dev/null
s4_failed() { sc=$(corr_to "$S4" "$ns" now); [ -n "$sc" ] && [ "$(corr_has "$sc" failed)" -ge 1 ]; }
waitfor $WAIT s4_failed && ok "a missing scene folder → transition.failed ($sc)" || bad "missing folder: corr ${sc:-none}, cur $(basename "$(cur path)")"
jq -e '."900000004".crashed // false | not' "$IDX" >/dev/null && [ -z "$(ctl logs '{"kind_prefix":"source.broken","limit":1000}' | jq -r --arg p "$S4" '.events[] | select(.path==$p) | .id')" ] \
  && ok "…not marked crashed (no source.broken)" || bad "a missing folder was marked crashed: $(jq -c '."900000004"' "$IDX")"
stop_now

lib_steps_no_scene() {   # $1 = label: /apply a video, then 8 × /next through a library of videos + scenes
  local hit=0 i
  post /apply "{\"path\":\"$SV1\"}" >/dev/null; waitfor $WAIT shows "$SV1" || bad "$1: /apply sv1 → $(basename "$(cur path)")"
  for i in $(seq 1 8); do post /next '{}' >/dev/null; waitfor $WAIT settled; [ "$(cur kind)" = scene ] && hit=1; done
  [ $hit = 0 ] && ok "$1: 8 × /next never landed on a scene" || bad "$1: /next landed on a scene ($(basename "$(cur path)"))"
  stop_now
}
setting '.AllowScenes = false'
lib_steps_no_scene "AllowScenes=false"
setting '.AllowScenes = true'

echo "== Phase 2 Task 8: scene GPU budget + VRAM settings (live, re-applied onto a fresh player; a fake VRAM probe)"
# The player measures VRAM through LIASCAPE_PLAYER_VRAM_PROBE=fake:<file> (read at every sample: {total_mib, free_mib,
# procs: {"<pid>": MiB}}) with short holds (interval 200, enter 600, resume 2000, settle 300, scene hold 600 ms) —
# deterministic, never this machine's GPU. 6000 of 8192 MiB free: the low-VRAM rule never engages here.
VR=$T/vram.json
vram_fake() { printf '{"total_mib":8192,"free_mib":6000,"procs":{%s}}' "$1" > "$VR.tmp" && mv "$VR.tmp" "$VR"; }
vram_fake ""
VRAM_ENV=(LIASCAPE_PLAYER_VRAM_PROBE=fake:$VR LIASCAPE_PLAYER_VRAM_TIMING=200,600,2000,300,600)
restart_player 8 "${VRAM_ENV[@]}"
pget() { ctl get "{\"path\":\"player.$1\"}" | jq -r '.value | if type == "number" then (. * 1000 | round / 1000) else . end'; }   # 0.0 → 0
p_is() { [ "$(pget "$1")" = "$2" ]; }
p_near() { near "$(pget "$1")" "$2" 0.001; }
gpu_props() { echo "throttle $(pget scene_throttle), limit $(pget scene_vram_limit_mib), low $(pget vram_low_mode)"; }
[ "$(gpu_props)" = "throttle true, limit 0, low stop" ] && ok "a fresh player: the defaults ($(gpu_props))" || bad "a fresh player: $(gpu_props)"
post /apply "{\"path\":\"$S1\"}" >/dev/null
waitfor 5000 scene_ready "$S1" || bad "/apply s1 on the fake-VRAM player → $(basename "$(cur path)") ready $(cur ready)"
SID=$(srcIdForPath "$S1"); WP=$(wpid "$SID")
setting '.AutoThrottleScenes = false'
waitfor $WAIT p_is scene_throttle false && [ "$(wpid "$SID")" = "$WP" ] && ok "AutoThrottleScenes off → player.scene_throttle false live, same worker $WP" || bad "AutoThrottleScenes off → $(gpu_props), pid $WP → $(wpid "$SID")"
setting '.AutoThrottleScenes = true'
waitfor $WAIT p_is scene_throttle true && ok "AutoThrottleScenes on → true" || bad "AutoThrottleScenes on → $(gpu_props)"
setting '.LimitVramPerScene = true | .SceneVramLimitMib = 1536'
waitfor $WAIT p_near scene_vram_limit_mib 1536 && [ "$(wpid "$SID")" = "$WP" ] && ok "the VRAM limit on at 1536 MiB → player.scene_vram_limit_mib 1536 live, same worker" || bad "VRAM limit on → $(gpu_props)"
setting '.SceneVramLimitMib = 2048'
waitfor $WAIT p_near scene_vram_limit_mib 2048 && ok "…2048 MiB → 2048" || bad "VRAM limit 2048 → $(gpu_props)"
setting '.LimitVramPerScene = false'
waitfor $WAIT p_near scene_vram_limit_mib 0 && [ "$(curl -sf -m 5 "$U/settings" | jq -r '.sceneVramLimitMib')" = 2048 ] && ok "the limit off → 0 (off), the MiB value kept for the toggle" || bad "VRAM limit off → $(gpu_props), saved MiB $(curl -sf -m 5 "$U/settings" | jq -r '.sceneVramLimitMib')"
for m in pause off stop; do
  setting ".VramLowMode = \"$m\""
  waitfor $WAIT p_is vram_low_mode "$m" && ok "VramLowMode $m → player.vram_low_mode $m live" || bad "VramLowMode $m → $(gpu_props)"
done
[ "$(pget paused)" = false ] && ok "none of it touched player.paused" || bad "player.paused $(pget paused) after the GPU settings"
# a fresh player process (not restored: the defaults) gets the backend's values back (R81's re-apply)
setting '.AutoThrottleScenes = false | .LimitVramPerScene = true | .SceneVramLimitMib = 1536 | .VramLowMode = "pause"'
waitfor $WAIT eval '[ "$(gpu_props)" = "throttle false, limit 1536, low pause" ]' || bad "set before the restart: $(gpu_props)"
stop_now
restart_player 8b "${VRAM_ENV[@]}"
waitfor 15000 eval '[ "$(gpu_props)" = "throttle false, limit 1536, low pause" ]' && ok "a fresh player gets them re-applied: $(gpu_props)" || bad "after a player restart: $(gpu_props) (want throttle false, limit 1536, low pause)"
setting '.AutoThrottleScenes = true | .VramLowMode = "stop"'

# a scene over the limit in a timed playlist: stopped by the player (never a crash) → the rotation advances at once,
# the UI is told why (WS scene-vram-stopped), the item is NOT marked crashed and stays playable
ws_listen "$T/ws-vram.log"
waitfor $WAIT eval 'grep -q " 101 " "$T/ws-vram.log"' || bad "WebSocket: $(head -c 300 "$T/ws-vram.log")"
ns=$(nsch)
post /playlist/play "{\"paths\":[\"$S1\",\"$S2\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT scene_ready "$S1" || bad "play [s1, s2] → cur $(basename "$(cur path)")"
WP=$(wpid "$(srcIdForPath "$S1")")
vram_fake "\"$WP\":2000"
vram_ev() { ctl logs '{"kind_prefix":"scene.vram_exceeded","limit":1000}' | jq -c --arg p "$S1" --argjson n "${1:-0}" '[.events[$n:][] | select(.path==$p)][-1] // empty'; }
waitfor 10000 eval 'vev=$(vram_ev); [ -n "$vev" ]' && ok "scene 1 over the limit (2000 > 1536 MiB) → scene.vram_exceeded $(echo "$vev" | jq -c '{used_mib, limit_mib}')" || bad "no scene.vram_exceeded for scene 1 (worker $WP)"
t_v=0; [ -n "${vev:-}" ] && t_v=$(printf '%s' "$vev" | jq -r "$EV_MS")
adv2_ms() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg p "$S2" --argjson n "$ns" --argjson t "$t_v" "[.events[\$n:][] | select(.path==\$p) | $EV_MS - \$t | select(. >= -50)][0] // empty"; }
waitfor $WAIT eval 'am=$(adv2_ms); [ -n "$am" ]'
[ -n "${am:-}" ] && python3 -c "import sys; sys.exit(0 if float('$am') <= 2000 else 1)" && ok "the rotation advanced to scene 2 $(printf %.0f "$am") ms after the stop" || bad "advance after the VRAM stop: ${am:-none} ms (cur $(basename "$(cur path)"))"
waitfor $WAIT scene_ready "$S2" || bad "after the VRAM stop: cur $(basename "$(cur path)")"
waitfor $WAIT eval 'grep "scene-vram-stopped" "$T/ws-vram.log" | jq -r "select(.payload.path | endswith(\"900000001\")) | .payload.message" | grep -q "used 2000 MiB > limit 1536"' && ok "WS scene-vram-stopped: $(grep -m1 scene-vram-stopped "$T/ws-vram.log" | jq -r .payload.message)" || bad "no WS scene-vram-stopped: $(grep -c . "$T/ws-vram.log") lines"
jq -e '."900000001".crashed // false | not' "$IDX" >/dev/null && [ -z "$(ctl logs '{"kind_prefix":"source.broken","limit":1000}' | jq -r --arg p "$S1" '.events[] | select(.path==$p) | .id')" ] \
  && ok "…never marked crashed (no source.broken, index crashed false)" || bad "a VRAM stop marked the scene crashed: $(jq -c '."900000001"' "$IDX")"
vram_fake ""
ns=$(nsch); post /next '{}' >/dev/null
waitfor $WAIT eval '[ -n "$(corr_to "$S1" "$ns" now)" ]' && waitfor $WAIT scene_ready "$S1" && ok "/next plays the stopped scene again (not skipped)" || bad "/next after a VRAM stop: cur $(basename "$(cur path)")"
stop_now
# a single wallpaper over the limit keeps what the player shows (its last frame) — no switch, no crash mark
n0=$(ctl logs '{"kind_prefix":"scene.vram_exceeded","limit":1000}' | jq '.events|length')
post /apply "{\"path\":\"$S1\"}" >/dev/null
waitfor $WAIT scene_ready "$S1" || bad "/apply s1 → $(basename "$(cur path)")"
WP=$(wpid "$(srcIdForPath "$S1")"); ns=$(nsch)
vram_fake "\"$WP\":2000"
waitfor 10000 eval '[ -n "$(vram_ev "$n0")" ]' || bad "no scene.vram_exceeded for the single scene"
sleep 2   # the window is the check: nothing may switch after the stop
[ "$(nsch)" = "$ns" ] && [ "$(cur path)" = "$S1" ] && jq -e '."900000001".crashed // false | not' "$IDX" >/dev/null \
  && ok "a single scene over the limit: stays on screen (its last frame), no switch, not marked crashed" || bad "single scene VRAM stop: switches $ns → $(nsch), cur $(basename "$(cur path)"), index $(jq -c '."900000001"' "$IDX")"
vram_fake ""
stop_now
kill "$WSP" 2>/dev/null; WSP=""
setting '.LimitVramPerScene = false'

echo "== Phase 2: scene loudness learned on first play (scene.loudness → the index → gain.normalize, live)"
# A player whose learning window is 3 s of audible play (LIASCAPE_PLAYER_LOUDNESS_WINDOW_S; 60 in production, a partial
# from a third of it). S5: a stereo 1 kHz tone at −20 dBFS peak = −20 LUFS; S6: no sound; S7: −26 dBFS.
restart_player 8c LIASCAPE_PLAYER_LOUDNESS_WINDOW_S=3
S5=$LIB/workshop/900000005; S6=$LIB/workshop/900000006; S7=$LIB/workshop/900000007
mk_scene "$S5" '{"pattern":"solid","rgb":[255,255,0],"native":[640,360],"has_audio":true,"tone_hz":1000,"tone_dbfs":-20}'
mk_scene "$S6" '{"pattern":"solid","rgb":[0,255,255],"native":[640,360]}'
mk_scene "$S7" '{"pattern":"solid","rgb":[255,0,255],"native":[640,360],"has_audio":true,"tone_hz":1000,"tone_dbfs":-26}'
# a scene's live measurement is kept per audio configuration (sceneLoudness[<fingerprint>].live; these synthetic
# scenes have no estimable sound objects, so no fingerprint: the configuration "")
LIVE='(.sceneLoudness[.sceneLoudnessFp // ""].live // {})'
idx_loud() { jq -c --arg k "$1" ".[\$k] | {i: .loudnessI, tp: .loudnessTP, s: $LIVE.seconds, partial: $LIVE.partial}" "$IDX" 2>/dev/null; }
loud_i() { jq -r --arg k "$1" '.[$k].loudnessI // empty' "$IDX" 2>/dev/null; }
wloud() { ctl probe '{"name":"workers"}' | jq -r --arg id "$1" ".workers[] | select(.id==\$id) | .loudness.$2"; }
setting '.NormalizeAudio = true | .NormalizeTargetLufs = -14 | .Volume = 100 | .NoAudio = false'
t5_0=$(ms_now)   # play 1 starts (its audible seconds can't exceed the time since)
post /apply "{\"path\":\"$S5\"}" >/dev/null
waitfor 5000 scene_ready "$S5" || bad "/apply s5 → $(basename "$(cur path)") ready $(cur ready)"
SID5=$(srcIdForPath "$S5"); WP5=$(wpid "$SID5")
near "$(cur gain.normalize)" 0 0.001 && ok "an unlearned scene plays at gain.normalize 0" || bad "unlearned scene: gain.normalize $(cur gain.normalize)"
t_l=$(ms_now)
waitfor 15000 eval '[ -n "$(loud_i 900000005)" ]' && ok "learned after $(( $(ms_now) - t_l )) ms of play: index $(idx_loud 900000005)" || bad "no loudness in the index: $(idx_loud 900000005)"
near "$(loud_i 900000005)" -20 1 && jq -e "(.\"900000005\" | $LIVE) | .seconds >= 3 and (.partial // false | not)" "$IDX" >/dev/null \
  && ok "…−20 LUFS ± 1 over ≥ 3 audible s, complete" || bad "stored $(idx_loud 900000005), want ≈ −20 LUFS, complete"
waitfor $WAIT cur_near gain.normalize 6 0.1 && [ "$(wpid "$SID5")" = "$WP5" ] && [ "$(srcIdForPath "$S5")" = "$SID5" ] \
  && ok "gain.normalize moved live to $(cur gain.normalize) dB (−14 − (−20)) — same source $SID5, same worker $WP5" || bad "normalize live: $(cur gain.normalize), src $SID5 → $(srcIdForPath "$S5"), worker $WP5 → $(wpid "$SID5")"
ramp=$(ctl logs '{"kind_prefix":"anim.start","limit":10000}' | jq -c --arg p "$SID5.gain.normalize" '[.events[] | select(.path==$p)][-1] | {to, duration_ms}')
echo "$ramp" | jq -e '.duration_ms >= 300' >/dev/null && ok "…as a ramp ($ramp), never a step" || bad "normalize not ramped: $ramp"
waitfor $WAIT eval 'near "$(waudio "$SID5" gain_db)" 6 0.1' && ok "…reaches the worker's stream (effective $(waudio "$SID5" gain_db) dB)" || bad "worker gain_db $(waudio "$SID5" gain_db)"
setting '.NormalizeTargetLufs = -23'
waitfor $WAIT cur_near gain.normalize -3 0.1 && ok "target −23 → gain.normalize $(cur gain.normalize) live" || bad "target −23 → $(cur gain.normalize)"
setting '.NormalizeAudio = false'
waitfor $WAIT cur_near gain.normalize 0 0.1 && ok "normalization off → gain.normalize $(cur gain.normalize) live" || bad "normalization off → $(cur gain.normalize)"
setting '.NormalizeAudio = true | .NormalizeTargetLufs = -14'
waitfor $WAIT cur_near gain.normalize 6 0.1 || bad "normalization back on → $(cur gain.normalize)"
post /library/volume "{\"path\":\"$S5\",\"intValue\":50}" >/dev/null
waitfor $WAIT cur_near gain.user -18.0618 && cur_near gain.normalize 6 0.1 && ok "a per-item volume (50) stacks on it: gain.user $(cur gain.user), gain.normalize $(cur gain.normalize)" || bad "override: gain.user $(cur gain.user), normalize $(cur gain.normalize)"
post /library/volume "{\"path\":\"$S5\",\"intValue\":100}" >/dev/null
[ "$(wpid "$SID5")" = "$WP5" ] || bad "the worker changed while normalizing: $WP5 → $(wpid "$SID5")"
# reopened: the new source opens at its normalization (create props), and a later play's measurement never replaces it
I5=$(loud_i 900000005)
t5_stop=$(ms_now)
stop_now
post /apply "{\"path\":\"$S5\"}" >/dev/null
t5_re=$(ms_now)
waitfor 5000 scene_ready "$S5" || bad "re-apply s5 → $(basename "$(cur path)")"
SID5b=$(srcIdForPath "$S5")
W5=$(python3 -c "print(round(-14 - float('$I5'), 3))")
G5b=$(ctl get "{\"path\":\"$SID5b.gain.normalize\"}" | jq -r .value)
A5b=$(ctl logs '{"kind_prefix":"anim.start","limit":10000}' | jq --arg p "$SID5b.gain.normalize" '[.events[] | select(.path==$p)] | length')
[ "$SID5b" != "$SID5" ] && near "$G5b" "$W5" 0.01 && [ "$A5b" = 0 ] \
  && ok "reopened ($SID5b): gain.normalize $G5b from its first frame (its create props — no ramp)" || bad "reopened $SID5b: gain.normalize $G5b (want $W5), ramps $A5b"
ns_l() { ctl logs '{"kind_prefix":"scene.loudness","limit":10000}' | jq --arg id "$1" '[.events[] | select(.id==$id)] | length'; }
# refined across plays (2026-10-28): the reopened source continues the first play's measurement, each report covers
# both plays, the index keeps the longer one — and the applied value only moves by ≥ 0.5 LU. The player continues its
# OWN measurement of the path (audio::loudness::Book): the backend's `loudness_seed`, read from the index at create,
# can lag the end-of-play report the stop just made (stored off its event thread — TODO "A reopen right after a stop
# can seed with the previous report": this check read the window's 3.0 s for the end's 5.8 s in 2 of 3 runs).
idx_s() { jq -r --arg k "$1" ".[\$k] | $LIVE.seconds // 0" "$IDX" 2>/dev/null; }
E5s=$(ctl logs '{"kind_prefix":"scene.loudness","limit":10000}' | jq -r --arg id "$SID5" '[.events[] | select(.id==$id)][-1].seconds')
P5=$(ctl probe '{"name":"workers"}' | jq -c --arg id "$SID5b" '.workers[] | select(.id==$id) | .loudness | {seconds, seed_s, session_s, measuring}')
# its seed = everything play 1 measured: never less than play 1's last report (its end's, + a rest too short to
# report — or, when the reopen came during the stop's fade-out, play 1's live measurement handed over: no end
# report then), about play 1's play time (a stale seed is ≥ 0.25 s short — up to a window; a double count ~2×)
echo "$P5" | jq -e --argjson e "${E5s:-0}" --argjson lo "$(( t5_stop - t5_0 ))" --argjson hi "$(( t5_re - t5_0 ))" \
  '.measuring and .seed_s >= $e - 0.001 and .seed_s >= $lo / 1000 - 2.5 and .seed_s <= $hi / 1000 + 0.2' >/dev/null \
  && ok "reopened: continues the whole first play ($P5; play 1's last report ${E5s} s, played $(( t5_stop - t5_0 ))–$(( t5_re - t5_0 )) ms)" \
  || bad "reopened source's loudness: $P5 (play 1's last report ${E5s} s, played $(( t5_stop - t5_0 ))–$(( t5_re - t5_0 )) ms)"
S5s=$(echo "$P5" | jq -r .seed_s)
waitfor $WAIT eval 'python3 -c "import sys; sys.exit(0 if float(\"$(idx_s 900000005)\") >= ${E5s:-0} - 0.001 else 1)"' \
  && ok "…the index holds play 1's last report ($(idx_s 900000005) s)" || bad "the index never stored play 1's last report: $(idx_s 900000005) s (want ≥ ${E5s} s)"
waitfor 15000 eval '[ "$(ns_l "$SID5b")" -ge 1 ]'
ev5b=$(ctl logs '{"kind_prefix":"scene.loudness","limit":10000}' | jq -c --arg id "$SID5b" '[.events[] | select(.id==$id)][0] | {seconds, seed_s, session_s, lufs}')
# (due a window after play 1's last report: its unreported rest, if any, counts toward it)
echo "$ev5b" | jq -e --argjson s "$S5s" --argjson e "${E5s:-0}" '(.seed_s - $s | fabs) < 0.05 and (.seconds - .seed_s - .session_s | fabs) < 0.05 and .seconds >= $e + 3 - 0.001' >/dev/null \
  && ok "the second play's report covers both plays: $ev5b" || bad "second play's report: $ev5b (stored before: ${S5s} s)"
waitfor $WAIT eval 'python3 -c "import sys; sys.exit(0 if float(\"$(idx_s 900000005)\") > $S5s + 2.5 else 1)"' && [ "$(loud_i 900000005)" = "$I5" ] \
  && ok "the index refined: $(idx_loud 900000005) — loudnessI kept at $I5 (moved < 0.5 LU)" || bad "second play: index $(idx_loud 900000005) (was $I5 over ${S5s} s)"
A5b=$(ctl logs '{"kind_prefix":"anim.start","limit":10000}' | jq --arg p "$SID5b.gain.normalize" '[.events[] | select(.path==$p)] | length')
[ "$A5b" = 0 ] && near "$(cur gain.normalize)" "$W5" 0.01 && ok "…gain.normalize untouched ($(cur gain.normalize), no ramp)" || bad "a sub-0.5 refinement moved gain.normalize: $(cur gain.normalize), ramps $A5b"
grep -q "loudness .* stored (< 0.5 LU: not applied)" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" || bad "adapter log has no 'stored (< 0.5 LU: not applied)' line"
# a third play much louder (the same folder, its tone at −10 dBFS now): the combined measurement moves ≥ 0.5 LU →
# gain.normalize ramps to it — same source, same worker
stop_now
mk_scene "$S5" '{"pattern":"solid","rgb":[255,255,0],"native":[640,360],"has_audio":true,"tone_hz":1000,"tone_dbfs":-10}'
post /apply "{\"path\":\"$S5\"}" >/dev/null
waitfor 5000 scene_ready "$S5" || bad "third play s5 → $(basename "$(cur path)")"
SID5c=$(srcIdForPath "$S5"); WP5c=$(wpid "$SID5c")
waitfor 15000 eval 'python3 -c "import sys; sys.exit(0 if float(\"$(loud_i 900000005)\") >= $I5 + 0.5 else 1)"' \
  && ok "a louder third play moved loudnessI $I5 → $(loud_i 900000005) ($(idx_loud 900000005))" || bad "third play: index $(idx_loud 900000005) (was $I5)"
W5c=$(python3 -c "print(round(min(-14 - float('$(loud_i 900000005)'), -1.5 - float('$(jq -r '."900000005".loudnessTP' "$IDX")')), 3))")
waitfor $WAIT cur_near gain.normalize "$W5c" 0.05 && [ "$(srcIdForPath "$S5")" = "$SID5c" ] && [ "$(wpid "$SID5c")" = "$WP5c" ] \
  && ok "…gain.normalize ramped live to $(cur gain.normalize) dB — same source $SID5c, same worker $WP5c" || bad "third play: gain.normalize $(cur gain.normalize) (want $W5c), src $SID5c → $(srcIdForPath "$S5"), worker $WP5c → $(wpid "$SID5c")"
ramp5c=$(ctl logs '{"kind_prefix":"anim.start","limit":10000}' | jq -c --arg p "$SID5c.gain.normalize" '[.events[] | select(.path==$p)][-1] | {to, duration_ms}')
echo "$ramp5c" | jq -e '.duration_ms >= 300' >/dev/null && ok "…as a ramp ($ramp5c)" || bad "third play: normalize not ramped: $ramp5c"
# a scene without sound: nothing learned, never normalized
post /apply "{\"path\":\"$S6\"}" >/dev/null
waitfor 5000 scene_ready "$S6" || bad "/apply s6 → $(basename "$(cur path)")"
SID6=$(srcIdForPath "$S6"); sleep 4.5
[ -z "$(loud_i 900000006)" ] && near "$(cur gain.normalize)" 0 0.001 && [ "$(ns_l "$SID6")" = 0 ] \
  && ok "a scene without sound: no scene.loudness, nothing stored, gain.normalize 0" || bad "silent scene: index $(idx_loud 900000006), events $(ns_l "$SID6"), normalize $(cur gain.normalize)"
# switched away early: a partial (≥ a third of the window); a later play's complete one replaces it
post /apply "{\"path\":\"$S7\"}" >/dev/null
waitfor 5000 scene_ready "$S7" || bad "/apply s7 → $(basename "$(cur path)")"
SID7=$(srcIdForPath "$S7")
audible_ge() { local v; v=$(wloud "$1" seconds); python3 -c "import sys; sys.exit(0 if float('${v:-0}') >= $2 else 1)" 2>/dev/null; }
waitfor 10000 audible_ge "$SID7" 1.2 || bad "s7 never reached 1.2 s audible: $(wloud "$SID7" seconds)"
post /apply "{\"path\":\"$S6\"}" >/dev/null
waitfor $WAIT eval '[ -n "$(loud_i 900000007)" ]' && jq -e "(.\"900000007\" | $LIVE).partial == true" "$IDX" >/dev/null && near "$(loud_i 900000007)" -26 1 \
  && ok "switched away after ~1.2 s: a partial stored $(idx_loud 900000007)" || bad "partial: $(idx_loud 900000007)"
post /apply "{\"path\":\"$S7\"}" >/dev/null
waitfor 5000 scene_ready "$S7" || bad "re-apply s7 → $(basename "$(cur path)")"
SID7b=$(srcIdForPath "$S7")
waitfor $WAIT cur_near gain.normalize 12 0.2 && ok "reopened with a partial: gain.normalize $(cur gain.normalize) (−14 − (−26)) from it" || bad "s7 with a partial: gain.normalize $(cur gain.normalize), want 12 (applied from the partial)"
waitfor 15000 eval 'jq -e "(.\"900000007\" | $LIVE) | (.partial // false | not) and .seconds >= 3" "$IDX" >/dev/null' && [ "$(wpid "$SID7b")" != "" ] \
  && ok "the next play completed it: $(idx_loud 900000007), gain.normalize $(cur gain.normalize)" || bad "s7 never completed: $(idx_loud 900000007)"
stop_now

echo "== Scene loudness estimated offline, per audio configuration (estimate endpoints, a property toggle re-keys live)"
# S8: a synthetic scene (it plays the tone of liascape-synthetic.json) that ALSO carries real WE sound objects for the
# estimator (`liascape-player scene-loudness`): sound 1 always, sound 2 bound to the bool property "extra" (off).
S8=$LIB/workshop/900000008
mkdir -p "$S8/sounds"
printf '{"type":"scene","title":"900000008","file":"scene.json","preview":"preview.png","general":{"properties":{"extra":{"type":"bool","value":false,"text":"Extra"}}}}' > "$S8/project.json"
printf '{"objects":[{"id":1,"name":"a","sound":["sounds/a.wav"],"playbackmode":"loop","volume":1.0},{"id":2,"name":"b","sound":["sounds/b.wav"],"playbackmode":"loop","volume":{"user":"extra","value":0.0}}]}' > "$S8/scene.json"
ffmpeg -v error -y -f lavfi -i "sine=frequency=1000:duration=6" -af volume=0.8 -ac 2 "$S8/sounds/a.wav"
ffmpeg -v error -y -f lavfi -i "sine=frequency=330:duration=4" -ac 2 "$S8/sounds/b.wav"
printf '%s' '{"pattern":"solid","rgb":[0,128,255],"native":[640,360],"has_audio":true,"tone_hz":1000,"tone_dbfs":-20}' > "$S8/liascape-synthetic.json"
echo iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC | base64 -d > "$S8/preview.png"
sl_status() { curl -sf -m 5 "$U/library/scene-loudness/status"; }
sl_idle() { sl_status | jq -e '.running == false' >/dev/null; }
fp8() { jq -r '."900000008".sceneLoudnessFp // empty' "$IDX"; }
est8() { jq -c '."900000008" | .sceneLoudness[.sceneLoudnessFp].estimate | {lufs, peakDbfs, confidence, seed: (.seed != null)}' "$IDX"; }
waitfor $WAIT sl_idle || bad "the startup estimate queue never went idle: $(sl_status)"
Q=$(post /library/scene-loudness/estimate "{\"paths\":[\"$S8\"]}" | jq -r .queued)
waitfor 30000 eval '[ -n "$(fp8)" ] && sl_idle' && [ "$Q" = 1 ] && est8 | jq -e '.lufs < -10 and .lufs > -40 and .seed' >/dev/null \
  && ok "estimate {paths}: queued $Q, stored under $(fp8): $(est8); status $(sl_status | jq -c '{running, done, total, failed: (.failed | length)}')" \
  || bad "estimate: queued $Q, fp $(fp8), $(est8), status $(sl_status)"
FP1=$(fp8); EST1=$(jq -r '."900000008".loudnessI' "$IDX")
curl -sf "$U/library" | jq -e --arg p "$S8" '.[] | select(.videoPath==$p) | .loudnessEstimated == true and (.loudnessLufs != null)' >/dev/null \
  && ok "/library: the item's loudness is the estimate (loudnessEstimated, $EST1 LUFS)" || bad "/library item: $(curl -sf "$U/library" | jq -c --arg p "$S8" '.[] | select(.videoPath==$p) | {loudnessLufs, loudnessEstimated}')"
[ "$(post /library/scene-loudness/estimate "{\"paths\":[\"$S8\"]}" | jq -r .queued)" = 0 ] && ok "Estimate skips a scene already estimated for its configuration" || bad "a second Estimate re-queued S8"
[ "$(post /library/scene-loudness/estimate "{\"paths\":[\"$S8\"],\"force\":true}" | jq -r .queued)" = 1 ] && waitfor 30000 sl_idle && [ "$(fp8)" = "$FP1" ] \
  && ok "Recalculate (force) re-estimates it: same fingerprint" || bad "force: fp $(fp8) (was $FP1)"
post /library/scene-loudness/cancel '{}' | jq -e '.cancelled == false' >/dev/null && ok "cancel with nothing running: {cancelled: false}" || bad "idle cancel"
setting '.NormalizeAudio = true | .NormalizeTargetLufs = -14'
post /apply "{\"path\":\"$S8\"}" >/dev/null
waitfor 5000 scene_ready "$S8" || bad "/apply s8 → $(basename "$(cur path)")"
SID8=$(srcIdForPath "$S8"); WP8=$(wpid "$SID8")
W8=$(python3 -c "print(round(min(-14 - float('$EST1'), -1.5 - float('$(jq -r '."900000008".loudnessTP' "$IDX")')), 3))")
K8=$(wloud "$SID8" key); SEED8=$(wloud "$SID8" seed_s)
[ "$K8" = "$FP1" ] && near "$(cur gain.normalize)" "$W8" 0.01 && near "$SEED8" 10 0.2 \
  && ok "never played: opens on loudness_key $K8, gain.normalize $(cur gain.normalize) from the estimate at once, seeded with 10 s of it" \
  || bad "s8 open: key $K8 (want $FP1), gain.normalize $(cur gain.normalize) (want $W8), seed_s $SEED8"
waitfor 10000 eval 'python3 -c "import sys; sys.exit(0 if float(\"$(wloud "$SID8" session_s)\") >= 1.5 else 1)"' || bad "s8 never played 1.5 s: $(wloud "$SID8" session_s)"
S8a=$(wloud "$SID8" seconds)
# the property that turns sound 2 on: re-planned → a new configuration → ONE pass: scene_props, loudness_key + its
# seed (its estimate), gain.normalize ramped — same source, same worker
t8=$(ms_now)
post /library/scene-props "{\"path\":\"$S8\",\"name\":\"extra\",\"value\":true}" >/dev/null || bad "scene-props extra=true refused"
waitfor 5000 eval '[ "$(wloud "$SID8" key)" != "$FP1" ] && [ -n "$(wloud "$SID8" key)" ]' || bad "the source never re-keyed: $(wloud "$SID8" key)"
FP2=$(fp8); K8b=$(wloud "$SID8" key)
[ "$FP2" != "$FP1" ] && [ "$K8b" = "$FP2" ] && [ "$(srcIdForPath "$S8")" = "$SID8" ] && [ "$(wpid "$SID8")" = "$WP8" ] \
  && ok "extra=true → configuration $FP2 in $(( $(ms_now) - t8 )) ms, live on the same source $SID8 / worker $WP8" || bad "re-key: index $FP2, source $K8b, src $(srcIdForPath "$S8"), worker $(wpid "$SID8")"
EST2=$(jq -r '."900000008".loudnessI' "$IDX")
python3 -c "import sys; sys.exit(0 if float('$EST2') > float('$EST1') + 0.5 else 1)" && ok "…its estimate applies: $EST1 → $EST2 LUFS (sound 2 adds to it)" || bad "applied $EST1 → $EST2"
W8b=$(python3 -c "print(round(min(-14 - float('$EST2'), -1.5 - float('$(jq -r '."900000008".loudnessTP' "$IDX")')), 3))")
waitfor $WAIT cur_near gain.normalize "$W8b" 0.05 && ramp8=$(ctl logs '{"kind_prefix":"anim.start","limit":10000}' | jq -c --arg p "$SID8.gain.normalize" '[.events[] | select(.path==$p)][-1] | {to, duration_ms}') \
  && echo "$ramp8" | jq -e '.duration_ms >= 300' >/dev/null && ok "…gain.normalize ramped to $(cur gain.normalize) ($ramp8)" || bad "normalize after the toggle: $(cur gain.normalize) (want $W8b), ramp $ramp8"
P8=$(ctl probe '{"name":"workers"}' | jq -c --arg id "$SID8" '.workers[] | select(.id==$id) | .loudness | {key, seconds, seed_s, dropped}')
echo "$P8" | jq -e '.seed_s > 9.8 and .seed_s < 10.2 and .seconds < 13' >/dev/null && ok "…the new configuration starts from its own estimate's 10 s, nothing of the old one's play: $P8" || bad "new configuration's measurement: $P8 (old one had $S8a s)"
waitfor 3000 eval '[ "$(wloud "$SID8" dropped)" -ge 1 ]' && ok "…segments dropped right after the key change ($(wloud "$SID8" dropped))" || bad "nothing dropped after the key change: $(wloud "$SID8" dropped)"
OLD8=$(ctl logs '{"kind_prefix":"scene.loudness","limit":10000}' | jq -c --arg id "$SID8" --arg k "$FP1" '[.events[] | select(.id==$id and .key==$k)][-1] | {key, seconds}')
echo "$OLD8" | jq -e '.seconds >= 1' >/dev/null && waitfor $WAIT eval "jq -e '.\"900000008\".sceneLoudness[\"$FP1\"].live.seconds >= 1' \"\$IDX\" >/dev/null" \
  && ok "…the old configuration's rest reported with its key and stored under it: $OLD8" || bad "old key's end report: $OLD8, index $(jq -c --arg k "$FP1" '."900000008".sceneLoudness[$k]' "$IDX")"
# toggled back: the first configuration again — its own measurement (the player's book) and its applied value
post /library/scene-props "{\"path\":\"$S8\",\"reset\":true}" >/dev/null
waitfor 5000 eval '[ "$(wloud "$SID8" key)" = "$FP1" ]' && [ "$(fp8)" = "$FP1" ] \
  && python3 -c "import sys; sys.exit(0 if float('$(wloud "$SID8" seconds)') >= float('$S8a') - 0.001 else 1)" \
  && ok "reset → back on $FP1, continuing its own measurement ($(wloud "$SID8" seconds) s ≥ the $S8a s it had)" || bad "back: key $(wloud "$SID8" key), index $(fp8), seconds $(wloud "$SID8" seconds) (had $S8a)"
grep -q "re-planned in .* ms" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" && ok "adapter log: $(grep -o 're-planned in [0-9]* ms' "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" | tail -1)" || bad "no re-plan line in the adapter log"
stop_now
setting '.NormalizeAudio = false'
mv "$S5" "$S6" "$S7" "$S8" "$T/"   # out of the library: the sections below step through it

restart_player 9 LIASCAPE_SCENE_WORKER_BIN=/nonexistent
ctl hello | jq -e '.capabilities | index("scene") == null' >/dev/null && ok "a player whose liascape-scene-worker doesn't resolve has no scene capability" || bad "capabilities: $(ctl hello | jq -c .capabilities)"
pe_off() { curl -sf -m 5 "$U/player-engine" | jq -e '.scenes.available == false and (.scenes.reason | type == "string" and length > 0)' >/dev/null; }
waitfor $WAIT pe_off && ok "/player-engine.scenes: unavailable, with a reason: $(curl -sf -m 5 "$U/player-engine" | jq -r .scenes.reason)" || bad "/player-engine.scenes: $(pe_scenes)"
# "missing libraries fail loudly" (FeatureHealth): the running player's hello.health and /health/features say so
ctl hello | jq -e '.health.scenes.ok == false and (.health.scenes.reason | test("liascape-scene-worker not found")) and .health.effects.ok == true' >/dev/null \
  && ok "hello.health: scenes not ok (liascape-scene-worker not found), effects ok" || bad "hello.health: $(ctl hello | jq -c .health)"
hf_scenes() { curl -sf -m 10 "$U/health/features" | jq -e '.features[] | select(.id == "scenes") | .ok == false and (.reason | test("liascape-scene-worker")) and (.affects | index("allowScenes") != null)' >/dev/null; }
waitfor $WAIT hf_scenes && ok "/health/features: scenes not ok with the reason, affects allowScenes" \
  || bad "/health/features: $(curl -sf -m 10 "$U/health/features" | jq -c '.features[] | select(.id == "scenes")')"
lib_steps_no_scene "no liascape-scene-worker"
restart_player 10
setting '.AllowScenes = false'
mv "$T/removed-ss1" "$LIB/imported/ss1"; mv "$T/removed-ss2" "$LIB/imported/ss2"

echo "== Phase 3 Task 7: a rotation session is the player's program (prog:main) — the backend loads it, edits it live, mirrors it"
# The rotation runs inside the player (recipes/program/): every switch of a session is `origin: program:prog:main`,
# the backend sends only the load, the live edits (`set prog:main.<prop>`) and the verbs, and follows `program.current`.
prog() { ctl get "{\"path\":\"prog:main.$1\"}" 2>/dev/null | jq -c '.value'; }
prog_is() { [ "$(prog "$1")" = "$2" ]; }
prog_num() { near "$(prog "$1")" "$2" 0.5; }
pst() { ctl state | jq -c '.programs[]? | select(.id=="prog:main")'; }
pplayed() { pst | jq -r '.played_ms // 0'; }
ncur() { ctl logs '{"kind_prefix":"program.current","limit":10000}' | jq '.events|length'; }
curs_after() { ctl logs '{"kind_prefix":"program.current","limit":10000}' | jq -c --argjson n "$1" '[.events[$n:][] | {p: (.path | split("/") | .[-1]), r: .reason, resumed}]'; }
last_cur() { ctl logs '{"kind_prefix":"program.current","limit":10000}' | jq -c '.events[-1] | {p: (.path | split("/") | .[-1]), r: .reason, resumed}'; }
api_after() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq --argjson n "$1" '[.events[$n:][] | select(.origin != "program:prog:main")] | length'; }
ge() { python3 -c "import sys; sys.exit(0 if float('$1') >= float('$2') - 1 else 1)" 2>/dev/null; }
setting '.GlobalSwitchWhenVideoEnds = false | .GlobalIntervalSeconds = 3 | .GlobalMaxPlaySeconds = 0 | .GlobalSeparateSceneTiming = false | .GlobalTransitionDurationMs = 300 | .GlobalPlaylistStart = "start_over" | .Volume = 100 | .NormalizeAudio = false'
post /playlist/state '{"videoPaths":[],"settings":{"order":0,"overrideGlobalSettings":false},"name":null}' >/dev/null
ws_listen "$T/ws-prog.log"
waitfor $WAIT eval 'grep -q " 101 " "$T/ws-prog.log"' || bad "WebSocket: $(head -c 300 "$T/ws-prog.log")"
m0=$(nsched_all); c0=$(ncur)
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\",\"$C\"],\"settings\":{\"order\":0}}" >/dev/null
waitfor $WAIT eval 'ctl state | jq -e ".graph[\"prog:main\"].kind == \"program\"" >/dev/null' && ok "/playlist/play → ctl state has prog:main (kind program)" || bad "no prog:main: $(ctl state | jq -c '.programs')"
waitfor 16000 eval '[ $(( $(ncur) - c0 )) -ge 4 ]'
[ "$(curs_after "$c0" | jq -c '.[0:4] | map(.p)')" = '["a.mp4","b.mp4","c.mp4","a.mp4"]' ] && [ "$(curs_after "$c0" | jq -c '.[0:4] | map(.r)')" = '["play","timer","timer","timer"]' ] \
  && ok "timer 3 s: program.current a (play) → b → c → a (timer)" || bad "program.current: $(curs_after "$c0")"
[ "$(api_after "$m0")" = 0 ] && ok "every switch since the load is origin program:prog:main ($(( $(nsched_all) - m0 )) scheduled, none api)" || bad "$(api_after "$m0") switches not from the program"
prog_is mode '"timer"' && prog_num interval_ms 3000 && ok "prog:main mode timer, interval_ms 3000" || bad "prog:main mode $(prog mode), interval $(prog interval_ms)"
cur_matches() { [ "$(curl -sf -m 5 "$U/current" | jq -r .path)" = "$(ctl logs '{"kind_prefix":"program.current","limit":10000}' | jq -r '.events[-1].path')" ]; }
waitfor $WAIT cur_matches && curl -sf -m 5 "$U/current" | jq -e '.timed == true' >/dev/null && ok "/current = the program's path, timed true" || bad "/current $(curl -sf -m 5 "$U/current" | jq -c '{path, timed}')"
nwc=$(grep -c '"wallpaper-changed"' "$T/ws-prog.log")
[ "$nwc" -ge 4 ] && grep '"wallpaper-changed"' "$T/ws-prog.log" | grep -qF "c.mp4" && ok "WS wallpaper-changed per program switch ($nwc)" || bad "WS wallpaper-changed: $nwc ($(tail -c 300 "$T/ws-prog.log"))"

# live edits: each reaches prog:main at once; an edit never resets the play time
setting '.GlobalIntervalSeconds = 30'; waitfor $WAIT prog_num interval_ms 30000; sleep 1   # no timer switch during the edits below
cl0=$(ncur); p0=$(pplayed); setting '.GlobalIntervalSeconds = 40'
waitfor $WAIT prog_num interval_ms 40000 && ge "$(pplayed)" "$p0" && [ "$(ncur)" = "$cl0" ] && ok "/settings interval 40 s → interval_ms 40000 live, no switch, played_ms kept ($p0 → $(pplayed))" || bad "interval live: $(prog interval_ms), played $p0 → $(pplayed), switches $(( $(ncur) - cl0 ))"
setting '.GlobalMaxPlaySeconds = 9 | .GlobalSeparateSceneTiming = true | .GlobalSwitchScenesAfterSeconds = 7'
waitfor $WAIT eval 'prog_num max_ms 9000 && prog_is separate_scenes true && prog_num scenes_after_ms 7000' && ok "max / separate timing / scenes after → prog:main live" || bad "limits: max $(prog max_ms), separate $(prog separate_scenes), after $(prog scenes_after_ms)"
setting '.GlobalTransitionEffectIds = ["fade","wipeLeft"] | .GlobalTransitionShuffle = false | .TransitionMethod = "reveal"'
waitfor $WAIT eval '[ "$(prog transition | jq -c "{effects, shuffle, method}")" = "{\"effects\":[\"fade\",\"wipeLeft\"],\"shuffle\":false,\"method\":\"reveal\"}" ]' && ok "transitions + method → prog:main.transition live" || bad "transition: $(prog transition)"
setting '.GlobalSwitchWhenVideoEnds = true | .GlobalIntervalSeconds = 0'
waitfor $WAIT eval 'prog_is mode "\"on_end\"" && prog_num interval_ms 0' && ok "advance-on-end on → mode on_end, minimum 0, live" || bad "mode $(prog mode), interval $(prog interval_ms)"
setting '.GlobalSwitchWhenVideoEnds = false | .GlobalIntervalSeconds = 3 | .GlobalMaxPlaySeconds = 0 | .GlobalSeparateSceneTiming = false | .GlobalTransitionEffectIds = ["fade"] | .TransitionMethod = "full-live"'
post /playlist/state "{\"videoPaths\":[\"$A\",\"$Bc\",\"$C\"],\"settings\":{\"order\":0},\"name\":null}" >/dev/null
c1=$(ncur); pp=$(prog path)
post /playlist/state "{\"videoPaths\":[\"$C\",\"$A\",\"$Bc\"],\"settings\":{\"order\":1},\"name\":null}" >/dev/null
waitfor $WAIT eval '[ "$(prog items | jq -c "map(.path | split(\"/\") | .[-1])")" = "[\"c.mp4\",\"a.mp4\",\"b.mp4\"]" ] && prog_is order "\"shuffle\""' \
  && ok "/playlist/state reorder + shuffle → prog:main.items / order live" || bad "items $(prog items | jq -c 'map(.path)'), order $(prog order)"
setting '.Volume = 40'
waitfor $WAIT eval 'near "$(prog defaults | jq -r ".\"gain.user\"")" "$(dB 40)" 0.01' && ok "Volume 40 → prog:main.defaults gain.user $(prog defaults | jq -r '."gain.user"')" || bad "defaults after Volume 40: $(prog defaults)"
post /mute '{"value":true,"user":true}' >/dev/null
waitfor $WAIT eval 'near "$(prog defaults | jq -r ".\"gain.mute\"")" -96 0.01' && ok "user mute → prog:main.defaults gain.mute -96 (a new B starts muted)" || bad "defaults after mute: $(prog defaults | jq -c '{"gain.mute"}')"
post /mute '{"value":false,"user":true}' >/dev/null
waitfor $WAIT eval 'near "$(prog defaults | jq -r ".\"gain.mute\"")" 0 0.01' || bad "unmute → defaults $(prog defaults | jq -c '{"gain.mute"}')"
stop_now
waitfor $WAIT eval '[ -z "$(pst)" ]' && curl -sf -m 5 "$U/current" | jq -e '.timed == false' >/dev/null && ok "/stop → no program, /current timed false" || bad "after /stop: $(pst), $(curl -sf -m 5 "$U/current" | jq -c .timed)"

# per-item values (R61) → the item props; a library item's own volume, its loudness (normalization)
setting '.Volume = 100'
QA=$(lib_import "$A" qa); QB=$(lib_import "$Bc" qb)
post /library/volume "{\"path\":\"$QB\",\"intValue\":30}" >/dev/null
post /playlist/play "{\"paths\":[\"$QA\",\"$QB\",\"$C\"],\"settings\":{\"order\":0}}" >/dev/null
item_props() { prog items | jq -c --arg p "$1" '.[] | select(.path==$p) | .props'; }
waitfor $WAIT eval 'near "$(item_props "$QB" | jq -r ".\"gain.user\" // 99")" "$(dB 30)" 0.01 && [ "$(item_props "$QA")" = "{}" ]' \
  && ok "an item's own volume → only its props (gain.user $(item_props "$QB" | jq -r '."gain.user"')), a plain one carries none" || bad "item props: qa $(item_props "$QA"), qb $(item_props "$QB")"
post /library/volume "{\"path\":\"$QA\",\"intValue\":60}" >/dev/null
waitfor $WAIT eval 'near "$(item_props "$QA" | jq -r ".\"gain.user\" // 99")" "$(dB 60)" 0.01' && ok "/library/volume on an item mid-rotation → its props live" || bad "qa props after /library/volume: $(item_props "$QA")"
nb0=$(nsched_all)
waitfor 12000 eval '[ -n "$(ctl logs "{\"kind_prefix\":\"transition.scheduled\",\"limit\":10000}" | jq -r --argjson n "$nb0" --arg p "$QA" "[.events[\$n:][] | select(.path==\$p)][0].to // empty")" ]'
qa_src=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --argjson n "$nb0" --arg p "$QA" '[.events[$n:][] | select(.path==$p)][0].to // empty')
waitfor $WAIT eval 'near "$(ctl get "{\"path\":\"$qa_src.gain.user\"}" | jq -r .value)" "$(dB 60)" 0.01' && ok "…and its next B is created with it ($qa_src gain.user $(ctl get "{\"path\":\"$qa_src.gain.user\"}" | jq -r .value))" || bad "next B of qa ($qa_src): gain.user $(ctl get "{\"path\":\"$qa_src.gain.user\"}" 2>&1 | head -c 200)"
setting '.NormalizeAudio = true'
waitfor 30000 eval 'item_props "$QA" | jq -e "(.af // \"\") | test(\"loudnorm\")" >/dev/null' && ok "normalization on → a measured item's own af (loudnorm) in its props" || bad "no loudnorm af in qa's props: $(item_props "$QA")"
setting '.NormalizeAudio = false'
waitfor $WAIT eval '[ "$(item_props "$QA" | jq -r ".af // \"none\"")" = none ]' && ok "normalization off → its af gone (= the defaults')" || bad "qa af after off: $(item_props "$QA" | jq -c .af)"
post /library/volume "{\"path\":\"$QA\",\"intValue\":null}" >/dev/null; post /library/volume "{\"path\":\"$QB\",\"intValue\":null}" >/dev/null

# trash of the playing item: the items lose it, the rotation goes on to the next survivor (the player's verb)
setting '.GlobalIntervalSeconds = 30'
post /playlist/state "{\"videoPaths\":[\"$QA\",\"$QB\",\"$C\"],\"settings\":{\"order\":0},\"name\":null}" >/dev/null
post /playlist/play-from "{\"paths\":[\"$QA\",\"$QB\",\"$C\"],\"startIndex\":0,\"settings\":{\"order\":0}}" >/dev/null
waitfor $WAIT shows "$QA"
playing=$(cur path); item=$(curl -sf -m 5 "$U/library" | jq -c --arg p "$playing" '[.[] | select(.videoPath==$p)][0]')
m1=$(nsched_all); c2=$(ncur)
post /library/trash "{\"items\":[$item]}" >/dev/null
waitfor $WAIT eval '[ "$(prog items | jq -r --arg p "$playing" "[.[] | select(.path==\$p)] | length")" = 0 ] && [ "$(ncur)" -gt "$c2" ] && ! cur_is path "$playing"' \
  && ok "trash of the playing $(basename "$playing") → gone from the items, the program moved on ($(last_cur))" || bad "trash: items $(prog items | jq -c 'map(.path | split("/") | .[-1])'), cur $(basename "$(cur path)")"
[ "$(api_after "$m1")" = 0 ] && ok "…by the program (no backend switch)" || bad "trash: $(api_after "$m1") switches not from the program"
post /library/undo '{}' >/dev/null
waitfor $WAIT eval '[ "$(prog items | jq -r --arg p "$playing" "[.[] | select(.path==\$p)] | length")" = 1 ]' && ok "undo → back in the items" || bad "undo: items $(prog items | jq -c 'map(.path | split("/") | .[-1])')"
stop_now

# § Playlist start through the HTTP routes (start over / resume; play again, stop → play, A → B → A)
setting '.GlobalIntervalSeconds = 3 | .GlobalPlaylistStart = "start_over"'
pl() { post /playlist/state "{\"videoPaths\":$2,\"settings\":{\"order\":0},\"name\":$1}" >/dev/null; post /playlist/play "{\"paths\":$2,\"settings\":{\"order\":0}}" >/dev/null; }
PA="[\"$A\",\"$Bc\",\"$C\"]"; PB="[\"$P1\",\"$P2\"]"
at_item() { waitfor 10000 eval "[ \"\$(last_cur | jq -r .p)\" = \"$1\" ]"; }
pl '"Alpha"' "$PA"; at_item b.mp4 || bad "precondition: Alpha never reached b ($(last_cur))"
prog_is key '"name:Alpha"' && ok "a saved playlist's key: name:Alpha" || bad "key $(prog key)"
c3=$(ncur); pl '"Alpha"' "$PA"
waitfor $WAIT eval '[ "$(curs_after "$c3" | jq "map(select(.r == \"play\")) | length")" -gt 0 ]'
[ "$(curs_after "$c3" | jq -c 'map(select(.r == "play"))[0]')" = '{"p":"a.mp4","r":"play","resumed":false}' ] && ok "start over: Play on the playing playlist → item 1 (a.mp4)" || bad "start over × play again: $(curs_after "$c3")"
setting '.GlobalPlaylistStart = "resume"'
waitfor $WAIT prog_is start_mode '"resume"' && ok "the start setting → prog:main.start_mode live" || bad "start_mode $(prog start_mode)"
at_item b.mp4; c4=$(ncur); m4=$(nsched_all); pb=$(pplayed); pl '"Alpha"' "$PA"; sleep 1
[ "$(curs_after "$c4" | jq -c 'map(select(.r == "play"))')" = "[]" ] && ge "$(pplayed)" "$pb" && [ "$(last_cur | jq -r .p)" = b.mp4 ] \
  && ok "resume: Play on the playing playlist keeps playing where it is (b.mp4, played_ms $pb → $(pplayed))" || bad "resume × play again: $(curs_after "$c4"), played $pb → $(pplayed)"
at_item c.mp4; stop_now; was=$(last_cur | jq -r .p); c5=$(ncur); pl '"Alpha"' "$PA"
waitfor $WAIT eval '[ "$(curs_after "$c5" | jq "map(select(.r == \"play\")) | length")" -gt 0 ]'
[ "$(curs_after "$c5" | jq -c 'map(select(.r == "play"))[0] | {p, resumed}')" = "{\"p\":\"$was\",\"resumed\":true}" ] && ok "resume: stop → Play → its resume point ($was, resumed)" || bad "resume × stop → play: $(curs_after "$c5") (stopped on $was)"
at_item a.mp4; was=$(last_cur | jq -r .p)
post /playlist/state "{\"videoPaths\":$PB,\"settings\":{\"order\":0},\"name\":\"Beta\"}" >/dev/null   # Beta loaded into the bar
waitfor $WAIT prog_is key '"name:Beta"' && ok "another playlist loaded into the bar → key name:Beta (Alpha's point kept)" || bad "key after loading Beta: $(prog key)"
pl '"Beta"' "$PB"; waitfor $WAIT eval '[ "$(last_cur | jq -r .p)" = p1.mp4 ]' && ok "resume × Beta never played → its item 1 (p1.mp4)" || bad "Beta: $(last_cur)"
c7=$(ncur); pl '"Alpha"' "$PA"
waitfor $WAIT eval '[ "$(curs_after "$c7" | jq "map(select(.r == \"play\")) | length")" -gt 0 ]'
[ "$(curs_after "$c7" | jq -c 'map(select(.r == "play"))[0] | {p, resumed}')" = "{\"p\":\"$was\",\"resumed\":true}" ] && ok "resume: Alpha → Beta → Alpha → Alpha's own point ($was, resumed)" || bad "A → B → A × resume: $(curs_after "$c7") (Alpha was at $was)"
setting '.GlobalPlaylistStart = "start_over"'
pl '"Beta"' "$PB"; at_item p1.mp4; c8=$(ncur); pl '"Alpha"' "$PA"
waitfor $WAIT eval '[ "$(curs_after "$c8" | jq "map(select(.r == \"play\")) | length")" -gt 0 ]'
[ "$(curs_after "$c8" | jq -c 'map(select(.r == "play"))[0] | {p, resumed}')" = '{"p":"a.mp4","resumed":false}' ] && ok "start over: Alpha → Beta → Alpha → item 1" || bad "A → B → A × start over: $(curs_after "$c8")"
c9=$(ncur); post /playlist/play-from "{\"paths\":$PA,\"startIndex\":2,\"settings\":{\"order\":0}}" >/dev/null
waitfor $WAIT eval '[ "$(curs_after "$c9" | jq "map(select(.r == \"play\")) | length")" -gt 0 ]'
[ "$(curs_after "$c9" | jq -c 'map(select(.r == "play"))[0] | {p, r}')" = '{"p":"c.mp4","r":"play"}' ] && ok "play-from c (index 2) → c.mp4, whatever the start setting" || bad "play-from: $(curs_after "$c9")"
stop_now
post /playlist/state '{"videoPaths":[],"settings":{"order":0},"name":null}' >/dev/null

# a backend restart under a legacy rotation (timed_state.json — a backend before Task 7): the player's program takes over at its item
touch "$T/planted-timed_state.json"   # planted on purpose: the legacy-files watch ignores it until the takeover removed it
printf '{"Paths":["%s","%s","%s"],"Index":1,"Options":"","Shuffle":false,"IntervalSeconds":3,"History":["%s","%s"],"HistoryIndex":1,"TimerPaused":false,"TimerStopped":false,"RemainingMs":2000,"SwitchWhenVideoEnds":false,"WaitingForVideoEnd":false,"ItemPlayedMs":0,"PlayedSavedAtMs":0}' \
  "$A" "$Bc" "$C" "$A" "$Bc" > "$XDG_CONFIG_HOME/liascape/timed_state.json"
port0=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); old=$BP; c10=$(ncur)
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; for _ in $(seq 1 100); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
"$DOTNET" "$DLL" serve > "$T/backend-legacy-state.log" 2>&1 & BP=$!
waitfor 60000 eval '[ "$(cat "$XDG_CONFIG_HOME/liascape/serve.port" 2>/dev/null)" != "$port0" ]'; U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); waitfor 30000 eval 'curl -sf -m 2 "$U/health" >/dev/null'
waitfor 15000 eval '[ "$(curs_after "$c10" | jq "map(select(.r == \"play\")) | length")" -gt 0 ]'
[ "$(curs_after "$c10" | jq -c 'map(select(.r == "play"))[0] | {p, r}')" = '{"p":"b.mp4","r":"play"}' ] && prog_is mode '"timer"' && [ ! -e "$XDG_CONFIG_HOME/liascape/timed_state.json" ] \
  && ok "a legacy timed_state.json at serve start → the player's program at its item (b.mp4), the file gone" || bad "legacy takeover: $(curs_after "$c10"), mode $(prog mode), file $(ls "$XDG_CONFIG_HOME/liascape/timed_state.json" 2>&1)"
waitfor $WAIT eval '[ ! -e "$XDG_CONFIG_HOME/liascape/timed_state.json" ]'; mv "$T/planted-timed_state.json" "$T/planted-done"
stop_now
kill "$WSP" 2>/dev/null; WSP=""
setting '.GlobalSwitchWhenVideoEnds = true | .GlobalIntervalSeconds = 0 | .GlobalPlaylistStart = "start_over" | .Volume = 100'

echo "== play-from keeps the playlist's transition settings (it used to rebuild them from rotation fields only)"
pf=$(jq -nc --arg a "$SV1" --arg b "$SV2" '{paths:[$a,$b], startIndex:1, settings:{order:1, overrideGlobalSettings:true,
  intervalSeconds:20, switchWhenVideoEnds:true, transitionEnabled:true,
  transitionEffectIds:["fade","wipeLeft"], transitionDurationMs:1234, transitionDurationMaxMs:0, transitionShuffle:false}}')
post /playlist/play-from "$pf" >/dev/null
pf_playing() { st=$(curl -sf -m 5 "$U/playlist/state") && { cur_is path "$SV1" || cur_is path "$SV2"; }; }   # the play-from is on screen
waitfor $WAIT pf_playing || bad "play-from: cur $(basename "$(cur path)") (want sv1/sv2)"
echo "$st" | jq -e '.settings.transitionEnabled == true and .settings.transitionDurationMs == 1234 and (.settings.transitionEffectIds == ["fade","wipeLeft"]) and .settings.transitionShuffle == false' >/dev/null \
  && ok "play-from kept transitionEnabled/effects/duration/shuffle in the current playlist state" \
  || bad "play-from dropped transition settings: $(echo "$st" | jq -c '.settings | {transitionEnabled, transitionEffectIds, transitionDurationMs, transitionShuffle}')"
echo "$st" | jq -e '.settings.order == 1' >/dev/null && ok "play-from kept the playlist's own order (shuffle) in the saved state" \
  || bad "play-from overwrote the saved order: $(echo "$st" | jq -c '.settings.order')"
stop_now

# An aligned (wait-for-video-end) switch is bounded by the adapter at A's remaining time + slack, read
# when it was armed. A's real remaining time moves with its CURRENT speed and stands still while the
# player is paused (the player re-derives its own align deadline for both) — a fixed bound gave up
# early: cancel + switch now, cutting A long before its end (and switching while paused).
aligned_corr() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg p "$1" '[.events[] | select(.align=="end" and .path==$p)][-1].corr // empty'; }
armed_for() { ac=$(aligned_corr "$1"); [ -n "$ac" ]; }
nsched() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '.events|length'; }
backstops() { grep -c "not handed off within" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null || true; }
# `ac` handed off; to what — from its handoff event (B is a short clip whose own aligned switch starts
# ~0.3 s before ITS end, so reading `cur:*` after a slow poll could already show the next one)
handed_off() {
  local to
  to=$(ctl logs "{\"corr\":\"$ac\",\"kind_prefix\":\"transition.handoff\"}" | jq -r '.events[-1].to // empty')
  [ -n "$to" ] && cp=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg to "$to" '[.events[] | select(.to == $to)][-1].path // empty')
}
pyint() { python3 -c "print(int($1))"; }

echo "== aligned wait survives a speed drop (the backstop follows A's current speed)"
# The window is MEASURED, not assumed: 9 s after the drop, but never later than 1 s before E1's own end
# at 0.5× — and never earlier than 3 s past the old bound (read when armed at 4×: E1's remaining/4 + the
# 2 s slack, so it ran out at "E1's end at 4×" + 2 s wherever it was armed). A fixed 9 s overran E1's
# real end whenever the drop landed late under load (E1 at 8 s of 12 → at 0.5× it ends 8 s later).
tpos() { local v; v=$(cur time_pos); case "$v" in ''|null) echo "$1" ;; *) echo "$v" ;; esac; }
setting '.Speed = 4'
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
ac=""; waitfor $WAIT armed_for "$E2"
p_arm=$(tpos 0); t_arm=$(ms_now)
bs0=$(backstops); ns0=$(nsched)
setting '.Speed = 0.5'
waitfor $WAIT cur_near speed 0.5 || bad "speed drop: E1 at $(cur speed)x"
p_drop=$(tpos 12); t_drop=$(ms_now)
t_min=$(pyint "$t_arm + (12 - $p_arm) / 4 * 1000 + 2000 + 3000")
t_max=$(pyint "$t_drop + (12 - $p_drop) / 0.5 * 1000 - 1000")
t_check=$(( t_drop + 9000 )); [ "$t_check" -gt "$t_max" ] && t_check=$t_max
echo "     armed at E1 ${p_arm} s, 0.5× from ${p_drop} s (+$(( t_drop - t_arm )) ms); looking at +$(( t_check - t_arm )) ms (old bound + 3 s: +$(( t_min - t_arm )), E1's end − 1 s: +$(( t_max - t_arm )))"
[ "$t_check" -ge "$t_min" ] || bad "speed drop: precondition — the drop landed too late (E1 at ${p_drop} s) to look past the old bound before E1's own end"
w=$(( t_check - $(ms_now) )); [ "$w" -gt 0 ] && sleep "$(python3 -c "print($w / 1000)")"
nc_=$(n_before transition.cancelled "$ac" "$t_check"); nh_=$(n_before transition.handoff "$ac" "$t_check")
nst_=$(n_before transition.started "$ac" "$t_check"); nn_=$(n_before transition.scheduled "" "$t_check" "$ns0")
[ -n "$ac" ] && [ "$nc_" = 0 ] && [ "$nh_" = 0 ] && [ "$nn_" = 0 ] \
  && ok "aligned switch $ac still waiting $(( t_check - t_drop )) ms after a 4x → 0.5x drop (no cancel, no new switch)" \
  || bad "speed drop: corr=$ac cancelled=$nc_ handoff=$nh_ new switches=$nn_ by +$(( t_check - t_arm )) ms"
# E1 on screen then = no effect had started from it (mid-effect `cur:*` is the incoming side) and nothing replaced it
[ "$nst_" = 0 ] && [ "$nn_" = 0 ] && ok "E1 still on screen (not cut before its end)" || bad "speed drop: $ac started=$nst_, new switches=$nn_ by +$(( t_check - t_arm )) ms — E1 was cut early"
[ "$(backstops)" = "$bs0" ] && ok "no adapter backstop fired" || bad "the adapter backstop fired: $(grep "not handed off within" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" | tail -1)"
setting '.Speed = 4'
cp=""; waitfor 20000 handed_off   # E1's rest at 4×: ≤ 3 s
[ "$(corr_has "$ac" handoff)" = 1 ] && [ "$cp" = "$E2" ] && ok "back at 4x: the same aligned switch handed off to E2 at E1's end" || bad "after 4x: handoff=$(corr_has "$ac" handoff) to $(basename "$cp")"
stop_now; setting '.Speed = 1'

echo "== aligned wait survives a long pause (no switch while paused, resumes at A's end)"
post /playlist/play "{\"paths\":[\"$P1\",\"$P2\"],\"settings\":{\"Order\":0}}" >/dev/null
ac=""; waitfor $WAIT armed_for "$P2"
post /pause '{}' >/dev/null
waitfor $WAIT paused_is true; p_pause=$(tpos "?")
bs0=$(backstops); ns0=$(nsched)
echo "     paused at P1 ${p_pause} s"
sleep 8   # > P1's remaining (< 4 s) + the 2 s slack, from arming — nothing moves while paused
pp=$(playerPaused); nc_=$(corr_has "$ac" cancelled); nn_=$(( $(nsched) - ns0 )); cp=$(cur path)
[ "$pp" = true ] && [ -n "$ac" ] && [ "$nc_" = 0 ] && [ "$nn_" = 0 ] && [ "$cp" = "$P1" ] \
  && ok "8 s paused: aligned switch $ac still waiting, P1 on screen, no new switch" \
  || bad "long pause: paused=$pp corr=$ac cancelled=$nc_ new switches=$nn_ cur $(basename "$cp") (paused at P1 ${p_pause} s)"
[ "$(backstops)" = "$bs0" ] && ok "no adapter backstop fired while paused" || bad "the adapter backstop fired while paused: $(grep "not handed off within" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" | tail -1)"
post /pause '{}' >/dev/null
cp=""; waitfor 20000 handed_off   # P1's rest: < 4 s
[ "$(corr_has "$ac" handoff)" = 1 ] && [ "$cp" = "$P2" ] && ok "resumed: the same aligned switch handed off to P2 at P1's end" || bad "after resume: handoff=$(corr_has "$ac" handoff) to $(basename "$cp")"
stop_now

echo "== /preview mid-transition reaches the edited item's source only (never the other side)"
# The per-wallpaper modal drag-previews through /preview. Mid-effect `cur:*` is the INCOMING side, so a
# drag on the outgoing A used to land on B (and stay there: the persist that follows targets A by path).
# The fades below are 60 s (an 8 s one ran out under load before the last check: A gone → `null dB`);
# nothing here depends on the duration, and the `/stop` after each section ends it.
post /apply "{\"path\":\"$E1\"}" >/dev/null; waitfor $WAIT shows "$E1" || bad "/apply e1 → cur $(cur path)"
TBp=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$E2\",\"loop\":true,\"gain.user\":0,\"speed\":1},\"effect_id\":\"fade\",\"duration_ms\":60000,\"align\":\"now\"}" | jq -r .to)
TAp=$(srcIdForPath "$E1")
sv() { ctl get "{\"path\":\"$1.$2\"}" | jq -r .value; }
running() { [ "$(ctl state | jq -r '.transitions[0].phase // empty')" = running ]; }
src_at() { near "$(sv "$1" gain.user)" "$2" && near "$(sv "$1" speed)" "$3"; }   # src_at <id> <dB> <speed>
waitfor $WAIT running && ok "fade $TAp → $TBp running" || bad "transition not running: $(ctl state | jq -c .transitions)"
post /preview "{\"volume\":20,\"speed\":1.5,\"paths\":[\"$E1\"]}" >/dev/null
waitfor $WAIT src_at "$TAp" "$g20" 1.5 && ok "A's drag moved A ($TAp: $(sv "$TAp" gain.user) dB, $(sv "$TAp" speed)x)" || bad "A's drag: A at $(sv "$TAp" gain.user) dB $(sv "$TAp" speed)x"
src_at "$TBp" 0 1 && ok "…and left B alone ($TBp: $(sv "$TBp" gain.user) dB, $(sv "$TBp" speed)x)" || bad "A's drag leaked into B: $(sv "$TBp" gain.user) dB $(sv "$TBp" speed)x"
g40=$(dB 40); b_at() { near "$(sv "$TBp" gain.user)" "$g40"; }
post /preview "{\"volume\":40,\"paths\":[\"$E2\"]}" >/dev/null
waitfor $WAIT b_at && near "$(sv "$TAp" gain.user)" "$g20" && ok "B's drag moved B only" || bad "B's drag: A $(sv "$TAp" gain.user) B $(sv "$TBp" gain.user)"
stop_now

echo "== global slider drag (/preview global): every source that follows the global moves, an overridden one never does"
# The Settings page's Volume/Speed sliders drag-preview through /preview {global:true} (no persist; the
# debounced /settings persists). Effective = override ?? global (R61): mid-effect, A follows the global and
# B has its own override → only A moves (RED before: the request ignored `global` and moved `cur:*` = B).
setting '.Volume = 100 | .Speed = 1'
LG1=$(lib_import "$E1" "gee one")
LG2=$(lib_import "$E2" "gee two")
[ -f "$LG1" ] && [ -f "$LG2" ] || bad "import: '$LG1' '$LG2'"
post /library/volume "{\"path\":\"$LG2\",\"intValue\":30}" >/dev/null; post /library/speed "{\"path\":\"$LG2\",\"doubleValue\":0.8}" >/dev/null
post /apply "{\"path\":\"$LG1\"}" >/dev/null; waitfor $WAIT shows "$LG1" || bad "/apply gee one → cur $(cur path)"
TG2=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$LG2\",\"loop\":true,\"gain.user\":$g30,\"speed\":0.8},\"effect_id\":\"fade\",\"duration_ms\":60000,\"align\":\"now\"}" | jq -r .to)
TG1=$(srcIdForPath "$LG1")
waitfor $WAIT running && ok "fade $TG1 → $TG2 (own override 30 / 0.8×) running" || bad "transition not running: $(ctl state | jq -c .transitions)"
g55=$(dB 55); g60=$(dB 60)
post /preview '{"volume":55,"speed":1.6,"global":true}' >/dev/null
waitfor $WAIT src_at "$TG1" "$g55" 1.6 && ok "the global drag moved A ($TG1: $(sv "$TG1" gain.user) dB, $(sv "$TG1" speed)x)" || bad "global drag: A at $(sv "$TG1" gain.user) dB $(sv "$TG1" speed)x"
src_at "$TG2" "$g30" 0.8 && ok "…and never the overridden B ($TG2: $(sv "$TG2" gain.user) dB, $(sv "$TG2" speed)x)" || bad "global drag moved the overridden B: $(sv "$TG2" gain.user) dB $(sv "$TG2" speed)x"
[ "$(curl -sf -m 5 "$U/settings" | jq .volume)" = 100 ] && ok "a preview doesn't persist (volume still 100)" || bad "preview persisted volume $(curl -sf -m 5 "$U/settings" | jq .volume)"
m_prev=$(post_ms /preview '{"volume":60,"global":true}')
[ "$m_prev" -lt 100 ] && ok "/preview global answers in ${m_prev} ms" || bad "/preview global took ${m_prev} ms"
a_at60() { near "$(sv "$TG1" gain.user)" "$g60"; }
waitfor $WAIT a_at60 && ok "a volume-only global drag keeps A's speed (1.6×: $(sv "$TG1" speed))" || bad "volume-only drag: A $(sv "$TG1" gain.user) dB"
near "$(sv "$TG1" speed)" 1.6 || bad "volume-only global drag moved A's speed: $(sv "$TG1" speed)"
stop_now

armed_only() { for _ in $(seq 1 80); do ctl state | jq -e '[.transitions[] | select(.phase != "done")] | length == 1 and .[0].phase == "waiting_start"' >/dev/null && return; sleep 0.1; done; echo "  note: no lone armed switch within 8 s: $(ctl state | jq -c '[.transitions[] | .phase]')"; }
echo "== a backend restart hands the playlist over without two timers (dotnet watch / app relaunch)"
# A stopping backend hands its timed playlist to a detached timer-daemon, but kept ticking itself until
# the process exited — up to Kestrel's 30 s shutdown timeout while the UI's WebSocket holds it open — and a
# new backend then resumed the playlist too: two or three owners each armed an aligned switch and
# superseded the others' (a switch every 1–16 s, "cancelled:superseded → switching in N s" storm).
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
armed_only
python3 - "${U##*:}" > "$T/ws.log" 2>&1 <<'PY' & WSP=$!
import socket, sys, time, base64, os
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
s.send(("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % base64.b64encode(os.urandom(16)).decode()).encode())
print(s.recv(256).split(b"\r\n")[0].decode(), flush=True)
time.sleep(120)
PY
ws_up() { grep -q " 101 " "$T/ws.log"; }
waitfor $WAIT ws_up && ok "a WebSocket client holds the backend open (like the UI)" || bad "WebSocket upgrade: $(cat "$T/ws.log")"
storms() { grep -c "→ switching in" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null || true; }
port_moved() { [ "$(cat "$XDG_CONFIG_HOME/liascape/serve.port" 2>/dev/null)" != "$1" ]; }
healthy() { curl -sf -m 2 "$U/health" >/dev/null; }
new_backend_up() {   # $1 = the old port; sets U
  waitfor 60000 port_moved "$1" || bad "the new backend never wrote its port"
  U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
  waitfor 30000 healthy || bad "the new backend never answered /health"
}
# The window that must hold exactly ONE advance (E1's end) is anchored on E1's own position, read with
# the baseline: it closes 6 s after E1's end (and ≥ 3 s after the new backend answered) — never later
# than 10 s after it, as E2 (12 s) starts its own effect at 11.7 s. A fixed 16 s after the new backend
# answered ran into E2's end whenever that start took seconds under load (2 handoffs, cur e1). The
# advance is then counted by event time up to the window's end (`tw`) — the reads after it are slow too.
e1_window() {   # $1 = when E1's position was read (ms), $2 = that position → sets tw
  local e1end up w
  e1end=$(pyint "$1 + (12 - $2) * 1000"); tw=$(( e1end + 6000 )); up=$(( $(ms_now) + 3000 ))
  [ "$tw" -lt "$up" ] && tw=$up
  [ "$tw" -le $(( e1end + 10000 )) ] || bad "precondition: the new backend answered $(( up - 3000 - e1end )) ms after E1's end — too late to see one advance before E2's"
  w=$(( tw - $(ms_now) )); [ "$w" -gt 0 ] && sleep "$(python3 -c "print($w / 1000)")"
}
one_advance() {   # exactly one handoff (after index h0) before tw, and it handed to E2
  dh=$(n_before transition.handoff "" "$tw" "$h0"); dto=$(handed_to_before "$h0" "$tw")
  [ "$dh" = 1 ] && [ "$dto" = "$E2" ]
}
# the play's own switch has handed off and only the next aligned one is armed (a baseline to count from)
st0=$(storms); nw0=$(nows); h0=$(handoffs); port0=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); pe=$(tpos 0); te=$(ms_now)
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; OLD1=$BP; sleep 1.5
"$DOTNET" "$DLL" serve > "$T/backend2.log" 2>&1 & BP=$!
new_backend_up "$port0"
kill -0 "$OLD1" 2>/dev/null && ok "the old backend is still shutting down (WebSocket open) while the new one runs" || echo "  note the old backend already exited — the overlap this tests didn't happen"
e1_window "$te" "$pe"   # E1 (12 s) ends inside this window → exactly one aligned advance
[ "$(storms)" = "$st0" ] && ok "no switch storm across the restart" || bad "switch storm: $(( $(storms) - st0 )) failed/superseded aligned switches — $(grep "→ switching in" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" | tail -3 | tr '\n' ' ')"
[ "$(nows)" = "$nw0" ] && ok "no immediate (align:now) switch during the handover" || bad "$(( $(nows) - nw0 )) align:now switches during the handover"
one_advance && ok "one advance at E1's end, E2 on screen" || bad "$dh handoffs, the last to $(basename "$dto")"
# Phase 3 Task 8: no backend owns a timer under liascape-player (the player's program rotates) — no gui_timer.pid
[ ! -e "$XDG_CONFIG_HOME/liascape/gui_timer.pid" ] && ok "no backend claims the timer (no gui_timer.pid: the player's program rotates)" || bad "gui_timer.pid = $(cat "$XDG_CONFIG_HOME/liascape/gui_timer.pid" 2>/dev/null) (new backend $BP)"
tp=$(cat "$XDG_CONFIG_HOME/liascape/timer.pid" 2>/dev/null); { [ -z "$tp" ] || ! kill -0 "$tp" 2>/dev/null; } && ok "no timer-daemon left running" || bad "a timer-daemon (pid $tp) runs next to the new backend"
kill "$WSP" 2>/dev/null; WSP=""
for _ in $(seq 1 50); do kill -0 "$OLD1" 2>/dev/null || break; sleep 0.1; done
stop_now

echo "== a backend restart keeps the item's play time (a maximum play time counts across it, the player played on)"
# max 7 s on e1 (12 s); the backend is stopped ~1.5 s in and a new one starts 2 s later: the switch still comes 7 s
# after e1 showed — not 7 s after the new backend (the play time restarted) nor 7 s of counted time (the gap lost)
setting '.GlobalMaxPlaySeconds = 7'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT cur_is path "$E1"; sleep 1.5
port0=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); old=$BP
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; for _ in $(seq 1 100); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
sleep 2
BLOG=$T/backend-limits.log   # the running backend's log (the next section greps it)
"$DOTNET" "$DLL" serve > "$BLOG" 2>&1 & BP=$!
new_backend_up "$port0"; t_up=$(ms_now)
swr=none; waitfor 15000 sw_seen "$m0" "$E2"
echo "     the new backend answered $(( t_up - $(t0w) )) ms after e1 showed"
between "$(sw_field 1)" 6300 8200 && [ "$(sw_field 3)" = now ] && ok "max 7 s across a backend restart: advanced at +$(sw_field 1) ms of e1" || bad "max × backend restart: $swr (want align now at +6.3…8.2 s)"
setting '.GlobalMaxPlaySeconds = 0'; stop_now

echo "== …and a minimum play time (6 s on p1, a 4 s clip): it loops on across the restart and advances at its 2nd loop's end"
setting '.GlobalIntervalSeconds = 6'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$P1\",\"$P2\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT cur_is path "$P1"; sleep 1.5
port0=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); old=$BP
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; for _ in $(seq 1 100); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
sleep 1
BLOG=$T/backend-limits2.log
"$DOTNET" "$DLL" serve > "$BLOG" 2>&1 & BP=$!
new_backend_up "$port0"; t_up=$(ms_now)
swr=none; waitfor 20000 sw_seen "$m0" "$P2"
echo "     the new backend answered $(( t_up - $(t0w) )) ms after p1 showed"
[ $(( t_up - $(t0w) )) -lt 3500 ] || bad "precondition: the new backend answered after p1's first loop ended"
between "$(sw_field 2)" 7200 8400 && [ "$(sw_field 3)" = end ] && ok "min 6 s across a backend restart: p1 advanced at its 2nd loop's end (handoff +$(sw_field 2) ms)" \
  || bad "min × backend restart: $swr (want a handoff at +7.2…8.4 s, align end)"
setting '.GlobalIntervalSeconds = 0'; stop_now

echo "== …and a scene's own time (separate timing for scenes, 6 s): counted across a backend restart"
setting '.AllowScenes = true | .GlobalSeparateSceneTiming = true | .GlobalSwitchScenesAfterSeconds = 6'
m0=$(tev_n)
post /playlist/play "{\"paths\":[\"$S1\",\"$E1\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT scene_ready "$S1"; sleep 1.5
port0=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); old=$BP
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; for _ in $(seq 1 100); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
sleep 1
BLOG=$T/backend-limits3.log
"$DOTNET" "$DLL" serve > "$BLOG" 2>&1 & BP=$!
new_backend_up "$port0"; t_up=$(ms_now)
swr=none; waitfor 20000 sw_seen "$m0" "$E1"
echo "     the new backend answered $(( t_up - $(t0w) )) ms after s1 showed"
between "$(sw_field 1)" 5300 7300 && [ "$(sw_field 3)" = now ] && ok "scenes after 6 s across a backend restart: s1 advanced at +$(sw_field 1) ms" \
  || bad "scene timing × backend restart: $swr (want align now at +5.3…7.3 s)"
setting '.GlobalSeparateSceneTiming = false | .GlobalSwitchScenesAfterSeconds = 0 | .AllowScenes = false'; stop_now

echo "== a second backend started while the first runs: the player's program keeps the playlist (no backend timer)"
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
armed_only
apis0=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '[.events[] | select(.origin=="api")] | length')
st0=$(storms); nw0=$(nows); h0=$(handoffs); port0=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); first=$BP; pe=$(tpos 0); te=$(ms_now)
"$DOTNET" "$DLL" serve > "$T/backend3.log" 2>&1 & BP=$!; BP_OLD="$BP_OLD $first"
new_backend_up "$port0"
e1_window "$te" "$pe"
[ "$(storms)" = "$st0" ] && [ "$(nows)" = "$nw0" ] && ok "two live backends: no storm, no immediate switch" || bad "two live backends: $(( $(storms) - st0 )) failed aligned switches, $(( $(nows) - nw0 )) align:now"
one_advance && ok "one advance at E1's end" || bad "$dh handoffs, the last to $(basename "$dto")"
# Phase 3 Task 7: no backend ticks a rotation under liascape-player — neither one requested a switch (the program did)
apis1=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '[.events[] | select(.origin=="api")] | length')
[ "$apis1" = "$apis0" ] && ok "neither backend requested a switch (every one origin program)" || bad "$(( apis1 - apis0 )) backend (origin api) switches with two backends"
kill "$first" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$first" 2>/dev/null || break; sleep 0.1; done
stop_now

echo "== Phase 3 Task 9: the player outbox — what the backend stores, kept while it is away (a scene breaks, another learns its loudness)"
# The backend TERMed; the player alone (a fresh one, its loudness window 3 s) plays a scene that breaks and one that
# learns its loudness. A new backend drains the outbox when it subscribes: the index has both ≤ 2 s after, then acks.
S9=$LIB/workshop/900000009; S10=$LIB/workshop/900000010
mk_scene "$S9" '{"pattern":"solid","rgb":[0,255,0],"native":[640,360],"crash_after_ms":400}'
mk_scene "$S10" '{"pattern":"solid","rgb":[255,128,0],"native":[640,360],"has_audio":true,"tone_hz":1000,"tone_dbfs":-20}'
OB=$XDG_STATE_HOME/liascape/liascape-player/outbox.jsonl
obread() { ctl outbox.read '{"limit":2000}' 2>/dev/null; }
ob_n() { obread | jq --arg a "$S9" --arg b "$S10" '[.events[]? | select(.fields.path == $a or .fields.path == $b)] | length'; }
ob_empty() { obread | jq -e '.events | length == 0' >/dev/null; }
port0=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); old=$BP
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; for _ in $(seq 1 100); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
kill -0 "$old" 2>/dev/null && bad "precondition: the backend outlived its TERM by 10 s"
restart_player 11 LIASCAPE_PLAYER_LOUDNESS_WINDOW_S=3
ctl transition "{\"outputs\":\"out:*\",\"to\":{\"kind\":\"scene\",\"path\":\"$S9\"}}" >/dev/null
s9_broke() { [ -n "$(ctl logs '{"kind_prefix":"source.broken","limit":1000}' | jq -r --arg p "$S9" '.events[] | select(.path==$p) | .id')" ]; }
waitfor 30000 s9_broke && ok "backend away: s9 broke (source.broken)" || bad "backend away: no source.broken for s9"
ctl transition "{\"outputs\":\"out:*\",\"to\":{\"kind\":\"scene\",\"path\":\"$S10\"}}" >/dev/null
s10_learned() { [ "$(ctl logs '{"kind_prefix":"scene.loudness","limit":1000}' | jq --arg p "$S10" '[.events[] | select(.path==$p)] | length')" -ge 1 ]; }
waitfor 15000 s10_learned && ok "backend away: s10 learned its loudness (scene.loudness)" || bad "backend away: no scene.loudness for s10"
ctl stop >/dev/null
nob=$(ob_n)
[ "${nob:-0}" -ge 2 ] && [ -s "$OB" ] && ok "…both kept in the player's outbox ($nob entries, $(grep -c . "$OB") lines in outbox.jsonl)" || bad "outbox: $nob entries for s9/s10: $(obread | head -c 400)"
jq -e '(."900000009".crashed // false | not) and (."900000010".loudnessI == null)' "$IDX" >/dev/null \
  && ok "…and nothing in the index yet (no backend)" || bad "index before the backend: $(jq -c '{s9: ."900000009", s10: ."900000010"}' "$IDX")"
drains0=$(grep -c "outbox: drained" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null || true)
"$DOTNET" "$DLL" serve > "$T/backend-outbox.log" 2>&1 & BP=$!
new_backend_up "$port0"
drained() { [ "$(grep -c "outbox: drained" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null || true)" -gt "${drains0:-0}" ]; }
waitfor 30000 drained || bad "the new backend never drained the outbox: $(tail -3 "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log")"
dline=$(grep "outbox: drained" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" | tail -1)
dms=$(printf '%s' "$dline" | sed -n 's/.* in \([0-9]*\) ms after subscribing.*/\1/p')
jq -e '."900000009".crashed == true' "$IDX" >/dev/null && [ -n "$(jq -r '."900000010".loudnessI // empty' "$IDX")" ] && [ -n "$dms" ] && [ "$dms" -le 2000 ] \
  && ok "drained on subscribing (${dms} ms): s9 crashed true, s10 loudnessI $(jq -r '."900000010".loudnessI' "$IDX") — ${dline#*] }" \
  || bad "after the drain (${dms:-?} ms): index $(jq -c '{s9: ."900000009".crashed, s10: ."900000010".loudnessI}' "$IDX"), log: $dline"
waitfor $WAIT ob_empty && ok "…acked: the outbox is empty" || bad "outbox after the drain: $(obread | head -c 400)"
waitfor $WAIT eval '[ ! -s "$OB" ]' && ok "…and outbox.jsonl compacted" || bad "outbox.jsonl after the ack: $(grep -c . "$OB") lines"
# with the backend listening, a live report is acked as it is handled (never kept for the next drain)
setting '.AllowScenes = true'
nl0=$(ctl logs '{"kind_prefix":"scene.loudness","limit":10000}' | jq '.events|length')
post /apply "{\"path\":\"$S10\"}" >/dev/null
waitfor 15000 eval '[ "$(ctl logs "{\"kind_prefix\":\"scene.loudness\",\"limit\":10000}" | jq ".events|length")" -gt "$nl0" ]' || bad "no live scene.loudness for s10"
lseq=$(ctl logs '{"kind_prefix":"scene.loudness","limit":10000}' | jq -r '.events[-1].outbox_seq // empty')
[ -n "$lseq" ] && waitfor $WAIT ob_empty && ok "a live scene.loudness (outbox_seq $lseq) is acked once handled: the outbox stays empty" || bad "live report: outbox_seq ${lseq:-none}, outbox $(obread | head -c 400)"
stop_now
setting '.AllowScenes = false'

echo "== a crash while an end-of-video switch is armed: A comes back where it was, the switch re-armed for A's end"
# The snapshot saved an armed align:end switch as its B — the restart showed B at once, cutting A's rest — and
# the backend's wait ended "failed:player restarted" → its fallback switched NOW (align:now) after a 1 s back-off.
newcomp() { c=$(comp_pid); [ -n "$c" ] && [ "$c" != "$1" ]; }
snap_after() { [ "$(jq -r '.saved_unix_ms // 0' "$SNAP" 2>/dev/null)" -gt "$1" ]; }
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
waitfor $WAIT cur_is path "$E1" || bad "/playlist/play e1 → cur $(cur path)"
armed_only; ta=$(ms_now)
waitfor $WAIT snap_after "$ta" || bad "precondition: no snapshot saved after the end-of-video switch was armed"
p0=$(tpos 0); oldCP=$CP; kill -9 "$CP"
waitfor $WAIT newcomp "$oldCP" || bad "no new compositor after killing $oldCP"; CP=$(comp_pid)
waitfor $WAIT cur_is ready true   # a restored source reads its position once it plays again
cp1=$(cur path); p1=$(tpos -1)   # the restarted player's own log starts empty: every event below is after the crash
[ "$cp1" = "$E1" ] && near "$p1" "$p0" 2.6 && ok "e1 back after the crash at ${p1} s (was ${p0} s), not e2" || bad "after the crash: cur $(basename "$cp1") at $p1 s (e1 was at $p0 s)"
waitfor $WAIT armed_for "$E2" && ok "the switch to e2 is re-armed for e1's end ($ac)" || bad "no aligned switch to e2 on the restarted player"
[ "$(nows)" = 0 ] && ok "no immediate (align:now) switch after the crash" || bad "$(nows) align:now switch(es) after the crash (the armed one fired early)"
waitfor 20000 handed_more 0; waitfor $WAIT shows "$E2"
nh=$(handoffs); [ "$nh" = 1 ] && [ "$(cur path)" = "$E2" ] && [ "$(nows)" = 0 ] && ok "one handoff to e2 at e1's end" || bad "after e1's end: $nh handoffs, cur $(basename "$(cur path)"), $(nows) align:now"
stop_now

echo "== a crash whose snapshot lags the last switch (an fsync under I/O load): the backend puts back what it switched to"
# Every snapshot write takes 4 s here (LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS — what an fsync took under load): a crash
# right after a switch restores the wallpaper before it. R81 re-applied settings only, never the wallpaper — the
# screen kept a, while the backend (and every UI) said c.
restart_player 4 LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS=4000
snap_shows() { jq -e --arg p "$1" '[.outputs[].content as $k | .sources[$k].path] | length > 0 and all(. == $p)' "$SNAP" >/dev/null 2>&1; }
post /apply "{\"path\":\"$A\"}" >/dev/null; waitfor $WAIT shows "$A" || bad "/apply a → cur $(cur path)"
waitfor 20000 snap_shows "$A" || bad "precondition: the snapshot never showed a"
post /apply "{\"path\":\"$C\"}" >/dev/null; waitfor $WAIT shows "$C" || bad "/apply c → cur $(cur path)"
snap_shows "$A" && ok "precondition: the snapshot still shows a (its write lags the switch to c)" || bad "precondition: the snapshot caught up with c already"
oldCP=$CP; kill -9 "$CP"
waitfor $WAIT newcomp "$oldCP" || bad "no new compositor after killing $oldCP"; CP=$(comp_pid)
waitfor $WAIT shows "$C" && ok "c on screen after the restart (the snapshot brought back a)" || bad "after the restart: cur $(basename "$(cur path)") — the backend last switched to c"
[ "$(curl -sf -m 5 "$U/current" | jq -r .path)" = "$C" ] && ok "/current says c" || bad "/current $(curl -sf -m 5 "$U/current" | jq -c .)"
stop_now

echo "== a rebuilt player binary: the backend restarts the player onto it, keeping what it shows"
# The player outlives the backend on purpose, so a rebuild/reinstall never reached a running one: fixes
# "persisted" for hours. Here: a new file at the backend's binary path (cp + mv = a new inode, like cargo/nix).
# Every snapshot write of the old player takes 4 s (an fsync under I/O load): its clean quit — the pause's write
# still in flight, then the final snapshot — takes seconds. The upgrade waited 1.5 s, SIGTERMed, SIGKILLed at 3 s
# (killing the final snapshot: the new player restored an older one) and then gave up on the new one after 3 s.
restart_player 5 LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS=4000
kills() { grep -cE "did not quit|ignored SIGTERM" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null || true; }
rebuild() { cp "$B" "$T/bin/liascape-player.new" && mv -f "$T/bin/liascape-player.new" "$T/bin/liascape-player"; }
post /apply "{\"path\":\"$D\"}" >/dev/null; waitfor $WAIT shows "$D" || bad "/apply d → cur $(cur path)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true || bad "/pause → player.paused $(playerPaused)"
CP0=$(comp_pid); SP0=$(sup_pid); k0=$(kills)
curl -sf -m 5 "$U/player-engine" | jq -e '.running.stale == null' >/dev/null && ok "/player-engine: running player current" || bad "stale before the rebuild: $(curl -sf -m 5 "$U/player-engine" | jq -c .running)"
rebuild
waitfor 60000 newcomp "$CP0"   # ≤ the 10 s check + 2 s settle + the old player's slow quit (≤ 2 writes of 4 s)
CP=$(comp_pid); SP=$(sup_pid)
[ -n "$CP" ] && [ "$CP" != "$CP0" ] && [ -n "$SP" ] && [ "$SP" != "$SP0" ] && ok "idle player upgraded: compositor $CP0 → $CP, supervisor $SP0 → $SP" || bad "no upgrade: compositor $CP0 → $CP, supervisor $SP0 → $SP"
[ "$(readlink "/proc/$CP/exe")" = "$T/bin/liascape-player" ] && ok "it runs the new build" || bad "it runs $(readlink "/proc/$CP/exe")"
[ "$(cur path)" = "$D" ] && [ "$(playerPaused)" = true ] && ok "same wallpaper, still paused" || bad "after the upgrade: cur $(basename "$(cur path)") paused=$(playerPaused)"
[ "$(ctl logs '{"kind_prefix":"snapshot.restored"}' | jq '.events|length')" -ge 1 ] && ok "restored from its snapshot" || bad "no snapshot.restored on the new player"
[ "$(kills)" = "$k0" ] && ok "the old player's slow clean quit was waited for (never signalled)" || bad "the upgrade signalled the quitting player: $(grep -E "did not quit|ignored SIGTERM" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" | tail -2 | tr '\n' ' ')"
sa=$([ -n "$SP" ] && tr '\0' ' ' < "/proc/$SP/cmdline" 2>/dev/null)
case "$sa" in *"serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null --restore"*) ok "the new player got the old one's arguments + --restore" ;; *) bad "the new supervisor runs: $sa" ;; esac
curl -sf -m 5 "$U/player-engine" | jq -e '.running.stale == null' >/dev/null && ok "/player-engine: current again" || bad "still stale: $(curl -sf -m 5 "$U/player-engine" | jq -c .running)"
post /pause '{}' >/dev/null
stop_now

echo "== …never across an armed end-of-video switch: an advance-on-end playlist upgrades at its next switch"
# armed for THIS play: an aligned switch to E2 scheduled after it (earlier sections armed E2 too — a
# stale corr returned at once and the window below was timed from before L1 even started)
armed_new() { ac=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg p "$1" --argjson n "$2" '[.events[$n:][] | select(.align=="end" and .path==$p)][-1].corr // empty'); [ -n "$ac" ]; }
ns_l1=$(nsched)
post /playlist/play "{\"paths\":[\"$L1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
ac=""; waitfor $WAIT armed_new "$E2" "$ns_l1"
CP0=$(comp_pid); st0=$(storms); nw0=$(nows)
rebuild; p_r=$(tpos 0); t_r=$(ms_now)
# Look when L1 is at 18 s of its 20 (stale ≥ 15 s — the 10 s check ran past the 2 s settle — and ~1.7 s
# before its aligned effect starts), timed from ONE position read: polling time_pos with a python spawn
# per poll missed that window under load (the poll outlasted it; mid-effect `cur:*` is already E2).
t_check=$(pyint "$t_r + (18 - $p_r) * 1000"); w=$(( t_check - $(ms_now) )); [ "$w" -gt 0 ] && sleep "$(python3 -c "print($w / 1000)")"
c=$(comp_pid); cp=$(cur path); n=$(nows); tp=$(tpos "?"); stale=$(( ($(ms_now) - t_r) / 1000 ))
[ "$stale" -ge 15 ] || bad "armed upgrade: precondition — stale only $stale s at the check (L1 at $p_r s at the rebuild)"
[ "$c" = "$CP0" ] && [ "$cp" = "$L1" ] && [ "$n" = "$nw0" ] && ok "armed for L1's end: not upgraded (L1 at $tp s, stale $stale s)" || bad "upgraded or switched while armed: compositor $CP0 → $c, cur $(basename "$cp"), $(( n - nw0 )) align:now (L1 at $tp s)"
new_comp() { c=$(comp_pid); [ -n "$c" ] && [ "$c" != "$CP0" ]; }
waitfor 30000 new_comp   # L1's end (≤ 2 s) + the upgrade (quit + start, seconds under load)
CP=$(comp_pid); SP=$(sup_pid)
[ -n "$CP" ] && [ "$CP" != "$CP0" ] && [ "$(cur path)" = "$E2" ] && ok "upgraded at the switch: E2 on screen, compositor $CP0 → $CP" || bad "after L1's end: compositor $CP0 → $CP, cur $(basename "$(cur path)")"
waitfor $WAIT armed_for "$L1"
[ -n "$(aligned_corr "$L1")" ] && [ "$(storms)" = "$st0" ] && [ "$(nows)" = 0 ] && ok "the next end-of-video switch is armed on the new player, no storm" || bad "after the upgrade: armed=$(aligned_corr "$L1") storms=$(( $(storms) - st0 )) now-switches=$(nows)"
stop_now

echo "== the player gone (its supervisor killed): the next switch starts it again with the supervisor's own arguments"
# A failed upgrade (or any player that went away) fell back to a plain `serve` at the next switch — without the
# running one's --headless / --outputs / --socket (here: no Wayland, so it never came up) and without --restore.
gone() { ! kill -0 "$1" 2>/dev/null; }
post /apply "{\"path\":\"$A\"}" >/dev/null; waitfor $WAIT shows "$A" || bad "/apply a → cur $(cur path)"
oldSP=$SP; oldCP=$CP; kill -9 "$SP"
waitfor 30000 gone "$oldCP" || bad "the compositor $oldCP outlived its killed supervisor by 30 s"
post /apply "{\"path\":\"$C\"}" >/dev/null
waitfor 20000 shows "$C" && ok "the next switch started the player again: c on screen" || bad "after the player was gone: cur $(basename "$(cur path)"), /player-engine $(curl -sf -m 5 "$U/player-engine" | jq -c '{reason}')"
SP=$(sup_pid); CP=$(comp_pid)
sa=$([ -n "$SP" ] && tr '\0' ' ' < "/proc/$SP/cmdline" 2>/dev/null)
case "$sa" in *"serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null --restore"*) ok "started with the gone supervisor's arguments + --restore" ;; *) bad "the new supervisor ($SP) runs: $sa" ;; esac
stop_now

echo "== Phase 3 Task 8: the app closed — the player rotates alone, no timer/restart daemon; the CLI drives the player itself"
# Under liascape-player the backend starts no timer-daemon / restart-daemon and owns no timer: the player's program
# rotates with no backend at all, a keybind with no app sends the program verb straight to the player, and
# `liascape restore` starts the player with its snapshot as a session start (`serve --restore --session-start`).
# every process running this run's private backend DLL (the backend, a daemon it spawned, a CLI) — by /proc cmdline,
# never `pgrep -f` (the owner's own backend runs on this machine); grep's own argv (the pattern) is not one
our_cmds() {
  local f a0
  for f in $(grep -laF -- "$DLL" /proc/[0-9]*/cmdline 2>/dev/null); do
    a0=$(tr '\0' '\n' < "$f" 2>/dev/null | head -1)
    case "$a0" in *dotnet*|*liascape-backend*) tr '\0' ' ' < "$f" 2>/dev/null; echo ;; esac
  done
}
legacy_daemons() { our_cmds | grep -E 'timer-daemon|restart-daemon'; }
backend_down() {   # TERM the backend and wait it out; the port file is voided so no CLI ever forwards to a port reused since
  local old=$BP; kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"
  waitfor 30000 eval '! kill -0 "$old" 2>/dev/null' || bad "the backend $old outlived its TERM by 30 s"
  echo 0 > "$XDG_CONFIG_HOME/liascape/serve.port"
}
backend_up() {   # $1 = its log
  "$DOTNET" "$DLL" serve > "$T/$1" 2>&1 & BP=$!
  waitfor 60000 port_moved 0 || bad "the new backend never wrote its port"
  U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); waitfor 30000 healthy || bad "the new backend never answered /health"
}
cli() { "$DOTNET" "$DLL" "$@" >> "$T/cli.log" 2>&1; }
set_file() { jq "$1" "$XDG_CONFIG_HOME/liascape/settings.json" > "$T/sf.json" && mv "$T/sf.json" "$XDG_CONFIG_HOME/liascape/settings.json"; }   # the app is closed: its settings file
base() { basename "$1"; }
at_cur() { [ "$(last_cur | jq -r .p)" = "$1" ] && settled; }   # the program's last switch is to $1 (a basename) and done
# `liascape restore` starts a player the way autostart does — but this test has no Wayland: the binary the CLI is given
# runs it headless and logs what the backend asked for. Its `.<name>-wrapped` sibling tells the backend which binary it
# really runs (makeWrapper's naming), so the player it starts never reads as out of date.
HB=$T/hb; mkdir -p "$HB"
cat > "$HB/liascape-player" <<EOF
#!/bin/sh
echo "\$*" >> "$HB/spawned.log"
if [ "\$1" = serve ]; then shift; exec "$T/bin/liascape-player" serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null "\$@"; fi
exec "$T/bin/liascape-player" "\$@"
EOF
chmod +x "$HB/liascape-player"; ln -s "$T/bin/liascape-player" "$HB/.liascape-player-wrapped"; : > "$HB/spawned.log"
restore_cli() { LIASCAPE_PLAYER_BIN=$HB/liascape-player "$DOTNET" "$DLL" restore >> "$T/cli.log" 2>&1; SP=$(sup_pid); CP=$(comp_pid); }
player_quit() {   # the player quits (its final snapshot + resume points) — no backend runs to start it again
  local sp; sp=$(sup_pid); ctl quit >/dev/null 2>&1
  waitfor 60000 eval '! kill -0 "$sp" 2>/dev/null' || { echo "  note: supervisor $sp outlived its quit by 60 s — SIGKILL"; kill -9 "$sp"; }
}
first_cur() { ctl logs '{"kind_prefix":"program.current","limit":10000}' | jq -c '.events[0] // {} | {p: ((.path // "") | split("/") | .[-1]), r: .reason, resumed}'; }

# 11 still images (they never end): a timer moves them, else only a user switch
NI=(); for i in $(seq 0 10); do f=$T/n$i.png
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=0x$(printf '%02x%02x40' $((i * 20)) $((255 - i * 20))):size=64x36" -frames:v 1 "$f"; NI+=("$f"); done
NIJ=$(printf '%s\n' "${NI[@]}" | jq -R . | jq -sc .)
setting '.GlobalSwitchWhenVideoEnds = false | .GlobalIntervalSeconds = 3 | .GlobalMaxPlaySeconds = 0 | .GlobalSeparateSceneTiming = false | .GlobalPlaylistStart = "start_over" | .Volume = 50 | .NormalizeAudio = false | .GlobalTransitionEnabled = true | .GlobalTransitionEffectIds = ["fade"] | .GlobalTransitionDurationMs = 300 | .TransitionMethod = "full-live" | .AutoMute = false'
post /playlist/state "{\"videoPaths\":$NIJ,\"settings\":{\"order\":0},\"name\":null}" >/dev/null
post /playlist/play "{\"paths\":$NIJ,\"settings\":{\"order\":0}}" >/dev/null
waitfor $WAIT eval '[ -n "$(pst)" ]' || bad "precondition: no prog:main after /playlist/play"
backend_down
c0=$(ncur); sleep 10; n=$(( $(ncur) - c0 )); procs=$(our_cmds)
[ "$n" -ge 2 ] && [ -z "$procs" ] && ok "app closed: the program rotates on its own ($n program.current in 10 s, no backend process)" || bad "app closed: $n program.current in 10 s, this run's processes: $procs"
[ -z "$(legacy_daemons)" ] && ok "app closed: no timer-daemon / restart-daemon" || bad "legacy daemons: $(legacy_daemons)"

# Review Focus 1: 10 × `liascape next` at once (each its own process, no backend) → ten items on, ≤ 2 playing sources
# (a source is shared by every output it shows on) at every 100 ms sample, every superseded B gone
ctl set '{"path":"prog:main.interval_ms","value":600000}' >/dev/null   # only the storm moves it now
waitfor $WAIT settled
p0=$(pst | jq -r .path); i0=-1; for i in "${!NI[@]}"; do [ "${NI[$i]}" = "$p0" ] && i0=$i; done
want=${NI[$(( (i0 + 10) % 11 ))]}
echo 0 > "$T/storm-max"
( mx=0; while [ ! -e "$T/storm-done" ]; do
    n=$(ctl probe '{"name":"sources"}' 2>/dev/null | jq '[.sources[] | select(.effective_paused == false and ((.gains.anticlick // 0) > -90))] | length')
    [ -n "$n" ] && [ "$n" -gt "$mx" ] && { mx=$n; echo "$mx" > "$T/storm-max"; }; sleep 0.1; done ) & SMP=$!
c1=$(ncur); pids=""
for _ in $(seq 1 10); do cli next & pids="$pids $!"; done
for p in $pids; do wait "$p"; done
waitfor $WAIT eval '[ "$(pst | jq -r .path)" = "$want" ] && settled'
sleep 0.5; touch "$T/storm-done"; wait "$SMP" 2>/dev/null; SMP=""
lp=$(pst | jq -r .path); mx=$(cat "$T/storm-max"); srcp=$(ctl probe '{"name":"sources"}' | jq -c '[.sources[].path] | unique')
[ "$i0" -ge 0 ] && [ "$lp" = "$want" ] && ok "CLI storm, no backend: 10 × next → ten items on ($(base "$p0") → $(base "$lp"))" || bad "CLI storm: $(base "$p0") (index $i0) → $(base "$lp"), want $(base "$want"); $(( $(ncur) - c1 )) program.current; $(tail -3 "$T/cli.log" | tr '\n' ' ')"
[ "$mx" -le 2 ] && ok "CLI storm: at most $mx playing sources at any sample" || bad "CLI storm: $mx playing sources at once"
[ "$srcp" = "$(jq -nc --arg p "$want" '[$p]')" ] && ok "CLI storm: every superseded B destroyed (only $(base "$want") left)" || bad "CLI storm: sources left $srcp"

# A backend started again (the app reopened): what it reports is the program's at once, and it switches nothing itself
m0=$(nsched_all)
backend_up backend-t8a.log
cur_is_prog() { [ "$(curl -sf -m 2 "$U/current" | jq -r .path)" = "$(prog path | jq -r .)" ]; }
waitfor 1000 cur_is_prog && ok "app reopened: /current = prog:main.path within 1 s" || bad "app reopened: /current $(curl -sf -m 2 "$U/current" | jq -c '{path, timed}'), prog:main.path $(prog path)"
sleep 5
[ "$(api_after "$m0")" = 0 ] && ok "app reopened: no backend switch (origin api) within 5 s" || bad "app reopened: $(api_after "$m0") switches not from the program"

# Every keybind with the app closed reaches the player: an item with its own volume plays (QB, 30 %), the timer is off
setting '.GlobalIntervalSeconds = 60 | .Volume = 50 | .VolumeKeyTarget = "auto"'
post /library/volume "{\"path\":\"$QB\",\"intValue\":30}" >/dev/null
PQ="[\"$QA\",\"$QB\",\"$L1\"]"
post /playlist/state "{\"videoPaths\":$PQ,\"settings\":{\"order\":0},\"name\":null}" >/dev/null
post /playlist/play-from "{\"paths\":$PQ,\"startIndex\":1,\"settings\":{\"order\":0}}" >/dev/null
waitfor $WAIT at_cur "$(base "$QB")" || bad "precondition: play-from QB → $(last_cur)"
backend_down
cli volume up
waitfor $WAIT eval 'near "$(item_props "$QB" | jq -r ".\"gain.user\" // 99")" "$(dB 35)" 0.01' && ok "CLI volume up on an item with its own volume → its props gain.user $(item_props "$QB" | jq -r '."gain.user"') (35 %)" || bad "CLI volume up × override: qb props $(item_props "$QB"), $(tail -2 "$T/cli.log" | tr '\n' ' ')"
cli next; waitfor $WAIT at_cur "$(base "$L1")" && ok "CLI next → $(base "$L1") (reason $(last_cur | jq -r .r))" || bad "CLI next → $(last_cur)"
cli volume up
waitfor $WAIT eval 'near "$(prog defaults | jq -r ".\"gain.user\"")" "$(dB 55)" 0.01' && ok "CLI volume up on the global → prog:main.defaults gain.user $(prog defaults | jq -r '."gain.user"') (55 %)" || bad "CLI volume up × global: defaults $(prog defaults | jq -c '{"gain.user"}')"
cli previous; waitfor $WAIT eval '[ "$(last_cur | jq -c "{p, r}")" = "{\"p\":\"$(base "$QB")\",\"r\":\"prev\"}" ] && settled' && ok "CLI previous → back to $(base "$QB")" || bad "CLI previous → $(last_cur)"
c2=$(ncur); cli random; waitfor $WAIT eval '[ "$(ncur)" -gt "$c2" ] && settled'
[ "$(last_cur | jq -r .r)" = random ] && [ "$(last_cur | jq -r .p)" != "$(base "$QB")" ] && ok "CLI random → $(last_cur | jq -r .p)" || bad "CLI random → $(last_cur)"
cli toggle-pause; waitfor $WAIT paused_is true && ok "CLI toggle-pause → player.paused" || bad "CLI toggle-pause → $(playerPaused)"
cli toggle-pause; waitfor $WAIT paused_is false && ok "CLI toggle-pause again → playing" || bad "CLI toggle-pause again → $(playerPaused)"
c3=$(ncur); cli play; sleep 1
[ "$(ncur)" = "$c3" ] && [ -n "$(pst)" ] && ok "CLI play while the program plays → nothing" || bad "CLI play while playing: $(curs_after "$c3")"
cli stop; waitfor $WAIT eval 'nothing_shown && [ -z "$(pst)" ]' && ok "CLI stop → nothing shown, no program" || bad "CLI stop: cur $(cur path), program $(pst)"
c4=$(ncur); cli play; waitfor $WAIT eval '[ "$(ncur)" -gt "$c4" ]'
[ "$(curs_after "$c4" | jq -c '.[0]')" = "{\"p\":\"$(base "$QA")\",\"r\":\"play\",\"resumed\":false}" ] && ok "start over: CLI stop → play → LastSession from item 1 ($(base "$QA"))" || bad "start over × stop → play: $(curs_after "$c4")"
cli toggle-play; waitfor $WAIT eval 'nothing_shown && [ -z "$(pst)" ]' && ok "CLI toggle-play while playing → stopped" || bad "CLI toggle-play → cur $(cur path), program $(pst)"
c5=$(ncur); cli toggle-play; waitfor $WAIT eval '[ "$(ncur)" -gt "$c5" ]' && [ "$(curs_after "$c5" | jq -r '.[0].r')" = play ] && ok "CLI toggle-play while stopped → the program plays ($(curs_after "$c5" | jq -r '.[0].p'))" || bad "CLI toggle-play while stopped: $(curs_after "$c5")"
set_file '.GlobalPlaylistStart = "resume"'
waitfor $WAIT settled; cli next; waitfor $WAIT at_cur "$(base "$QB")" || bad "precondition: next → $(last_cur)"
cli stop; waitfor $WAIT nothing_shown
c6=$(ncur); cli play; waitfor $WAIT eval '[ "$(ncur)" -gt "$c6" ]'
[ "$(curs_after "$c6" | jq -c '.[0] | {p, resumed}')" = "{\"p\":\"$(base "$QB")\",\"resumed\":true}" ] && ok "resume: CLI stop → play → its resume point ($(base "$QB"))" || bad "resume × stop → play: $(curs_after "$c6")"

# `liascape restore` (boot): the player is started with `--restore --session-start`; the player applies the start mode
set_file '.GlobalPlaylistStart = "start_over"'
cli stop; waitfor $WAIT nothing_shown; cli play; waitfor $WAIT at_cur "$(base "$QA")" || bad "precondition: play → $(last_cur)"
cli next; waitfor $WAIT at_cur "$(base "$QB")" || bad "precondition: next → $(last_cur)"
player_quit; restore_cli
tail -1 "$HB/spawned.log" | grep -q -- '^serve --restore --session-start$' && ok "restore: the player started as \`serve --restore --session-start\`" || bad "restore started: $(tail -1 "$HB/spawned.log")"
waitfor $WAIT eval '[ "$(ncur)" -gt 0 ] && settled'
nqb=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq --arg p "$QB" '[.events[] | select(.path == $p)] | length')
[ "$(first_cur)" = "{\"p\":\"$(base "$QA")\",\"r\":\"play\",\"resumed\":false}" ] && [ "$nqb" = 0 ] && [ -n "$(pst)" ] \
  && ok "restore × start over (sequential): item 1 ($(base "$QA")), the item it was on ($(base "$QB")) never shown" || bad "restore × start over: first $(first_cur), $nqb switches to qb, program $(pst)"
ctl set '{"path":"prog:main.order","value":"shuffle"}' >/dev/null
cli next; waitfor $WAIT eval '[ "$(ncur)" -gt 1 ] && settled'; was=$(last_cur | jq -r .p)
player_quit; restore_cli; waitfor $WAIT eval '[ "$(ncur)" -gt 0 ] && settled'
[ "$(first_cur | jq -r .r)/$(first_cur | jq -r .resumed)" = play/false ] && [ "$(first_cur | jq -r .p)" != "$was" ] && prog_is order '"shuffle"' \
  && ok "restore × start over (shuffle): a fresh shuffle ($was → $(first_cur | jq -r .p))" || bad "restore × start over × shuffle: first $(first_cur) (was $was), order $(prog order)"
ctl set '{"path":"prog:main.order","value":"sequential"}' >/dev/null; ctl set '{"path":"prog:main.start_mode","value":"resume"}' >/dev/null
ctl program.play '{"id":"prog:main","from":"index","index":2}' >/dev/null
waitfor $WAIT at_cur "$(base "$L1")" || bad "precondition: program.play index 2 → $(last_cur)"
waitfor 15000 eval 'ge "$(cur time_pos)" 9'; tq=$(cur time_pos)   # far enough in that a restart from 0 can't pass for it
# a restored source reads 0 until it is ready (its position once it plays again) — reading sooner failed 1 run in 2
player_quit; tr0=$(ms_now); restore_cli; waitfor $WAIT eval '[ "$(ncur)" -gt 0 ]'; waitfor $WAIT cur_is ready true; tr=$(cur time_pos); el=$(( $(ms_now) - tr0 ))
# at its position ± 2 s: it played on from there once started (at most the time since the restore began)
at_pos() { python3 -c "import sys; sys.exit(0 if $tq - 2 <= float('$tr') <= $tq + 2 + $el / 1000 else 1)" 2>/dev/null; }
[ "$(first_cur | jq -c '{p, resumed}')" = "{\"p\":\"$(base "$L1")\",\"resumed\":true}" ] && at_pos && [ -n "$(pst)" ] \
  && ok "restore × resume: the same item at its position ($(base "$L1") $tq s → $tr s), still a program" || bad "restore × resume: first $(first_cur), time $tq → $tr, program $(pst)"
waitfor $WAIT settled
player_quit; mv "$SNAP" "$T/snapshot-aside.json"; restore_cli; waitfor $WAIT eval '[ "$(ncur)" -gt 0 ]'
[ "$(first_cur)" = "{\"p\":\"$(base "$QA")\",\"r\":\"play\",\"resumed\":false}" ] && [ -n "$(pst)" ] \
  && ok "restore × no snapshot × start over: LastSession from item 1 ($(base "$QA"))" || bad "restore × no snapshot × start over: first $(first_cur), program $(pst)"
set_file '.GlobalPlaylistStart = "resume"'
waitfor $WAIT settled; cli next; waitfor $WAIT at_cur "$(base "$QB")" || bad "precondition: next → $(last_cur)"
player_quit; mv "$SNAP" "$T/snapshot-aside2.json"; restore_cli; waitfor $WAIT eval '[ "$(ncur)" -gt 0 ]'
[ "$(first_cur | jq -c '{p, resumed}')" = "{\"p\":\"$(base "$QB")\",\"resumed\":true}" ] \
  && ok "restore × no snapshot × resume: LastSession at its resume point ($(base "$QB"))" || bad "restore × no snapshot × resume: first $(first_cur)"
[ -z "$(legacy_daemons)" ] && [ "$(grep -c . "$HB/spawned.log")" = 5 ] && ok "5 restores: one player start each, no timer-daemon / restart-daemon" || bad "restores: $(grep -c . "$HB/spawned.log") player starts, daemons: $(legacy_daemons)"
set_file '.GlobalPlaylistStart = "start_over"'
# `serve` start stops a daemon a legacy session left (its cmdline says it is one) — and never what a stale pid file
# names by now (a pid file outlives a reboot): an unrelated process lives on, both pid files go
touch "$T/planted-timer.pid" "$T/planted-restart.pid"
python3 -c 'import time; time.sleep(300)' liascape-backend.dll timer-daemon & FAKED=$!
sleep 300 & INNOCENT=$!
waitfor $WAIT eval 'grep -qa timer-daemon "/proc/$FAKED/cmdline"' || bad "precondition: the fake timer-daemon never started"
echo "$FAKED" > "$XDG_CONFIG_HOME/liascape/timer.pid"; echo "$INNOCENT" > "$XDG_CONFIG_HOME/liascape/restart.pid"
backend_up backend-t8b.log
SP=$(sup_pid); CP=$(comp_pid)
waitfor $WAIT eval '! kill -0 "$FAKED" 2>/dev/null' && ok "serve start stops a leftover timer-daemon" || bad "the leftover timer-daemon $FAKED outlived serve start"
kill -0 "$INNOCENT" 2>/dev/null && ok "…and never an unrelated process a stale restart.pid names" || bad "serve start killed the unrelated process a stale restart.pid named"
[ ! -e "$XDG_CONFIG_HOME/liascape/timer.pid" ] && [ ! -e "$XDG_CONFIG_HOME/liascape/restart.pid" ] && ok "…both pid files gone" || bad "pid files left: $(ls "$XDG_CONFIG_HOME/liascape" | grep -E '^(timer|restart)\.pid$' | tr '\n' ' ')"
kill "$FAKED" "$INNOCENT" 2>/dev/null
mv "$T/planted-timer.pid" "$T/planted-timer-done"; mv "$T/planted-restart.pid" "$T/planted-restart-done"
post /library/volume "{\"path\":\"$QB\",\"intValue\":null}" >/dev/null
setting '.GlobalSwitchWhenVideoEnds = true | .GlobalIntervalSeconds = 0 | .Volume = 100'
stop_now

echo "== auto-mute never hears our own switches (a private PipeWire + pipewire-pulse; the player on its real audio bus)"
# Owner report: with AutoMute on (both delays 0) every switch muted the wallpaper for a hitch — for the whole
# "unmute after" delay when that's > 0. The incoming source's own stream (mpv's `liascape-player` node / a scene worker's
# `liascape-player-scene.<id>`) was MONITORED from its first event and only classified as ours ~120 ms later, and each
# `change` event (its uncork) re-opened that window. Here: AutoMute on, 0/0 delays, −70 dB, every switch combo with
# each method → no `gain.mute` −96 anywhere; then a foreign stream still mutes, as fast as before.
# The daemons get their own config/state dirs (no D-Bus, WirePlumber's `policy` profile — no ALSA/Bluetooth device
# monitor, one null sink): sockets in this test's $XDG_RUNTIME_DIR, where the backend's pactl/parec (PULSE_SERVER,
# exported above) and the player's PipeWire client look. The owner's audio server is never involved.
if command -v pipewire >/dev/null && command -v pipewire-pulse >/dev/null && command -v wireplumber >/dev/null \
   && command -v pactl >/dev/null && command -v paplay >/dev/null && command -v parec >/dev/null; then
  PW=$T/pw; mkdir -p "$PW/cfg/wireplumber/wireplumber.conf.d" "$PW/state"
  cat > "$PW/pw.conf" <<'EOF'
context.properties = { core.daemon = true core.name = pipewire-0
  default.clock.rate = 48000 support.dbus = false log.level = 1 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-protocol-native } { name = libpipewire-module-profiler }
  { name = libpipewire-module-access } { name = libpipewire-module-metadata }
  { name = libpipewire-module-spa-device-factory } { name = libpipewire-module-spa-node-factory }
  { name = libpipewire-module-client-node } { name = libpipewire-module-client-device }
  { name = libpipewire-module-adapter } { name = libpipewire-module-link-factory } ]
context.objects = [
  { factory = spa-node-factory args = { factory.name = support.node.driver node.name = Dummy-Driver
      node.group = pipewire.dummy priority.driver = 20000 } }
  { factory = adapter args = { factory.name = support.null-audio-sink node.name = it-sink
      node.description = "it sink" media.class = Audio/Sink audio.position = [ FL FR ]
      monitor.channel-volumes = true node.group = pipewire.dummy priority.driver = 21000 } } ]
EOF
  echo 'wireplumber.profiles = { policy = { support.reserve-device = disabled monitor.alsa.reserve-device = disabled support.portal-permissionstore = disabled script.client.access-portal = disabled support.logind = disabled monitor.bluez.seat-monitoring = disabled hooks.device.profile.state = disabled hooks.device.routes.state = disabled } }' \
    > "$PW/cfg/wireplumber/wireplumber.conf.d/99-hermetic.conf"
  # `exec`: $! must be the daemon itself, or the kills below would only hit a wrapping subshell
  pwd_start() { local log=$1; shift
    (exec env XDG_CONFIG_HOME="$PW/cfg" XDG_STATE_HOME="$PW/state" DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent "$@" > "$log" 2>&1) &
    PWP="$PWP $!"; }
  pwd_start "$PW/pipewire.log" pipewire -c "$PW/pw.conf"
  waitfor 5000 test -e "$XDG_RUNTIME_DIR/pipewire-0" || bad "the private pipewire never made its socket"
  pwd_start "$PW/wireplumber.log" wireplumber -p policy
  pwd_start "$PW/pipewire-pulse.log" pipewire-pulse
  waitfor 5000 test -S "$XDG_RUNTIME_DIR/pulse/native" || bad "the private pipewire-pulse never made its socket"
  # a player WITH audio (no --ao null): its bus + mpv/scene streams on the private PipeWire
  "$B" ctl --timeout-ms 3000 quit >/dev/null 2>&1
  for _ in $(seq 1 600); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$SP" 2>/dev/null && kill -9 "$SP"
  (cd /tmp && exec "$B" serve --headless --outputs 640x360@60 --clock real > "$T/serve-am.log" 2>&1) & SP=$!
  waitfor $WAIT eval 'ctl hello >/dev/null 2>&1'; CP=$(comp_pid)
  bus_up() { [ "$(ctl probe '{"name":"bus"}' | jq -r .state)" = up ]; }
  waitfor $WAIT bus_up && ok "the player's audio bus is up on the private PipeWire ($(ctl probe '{"name":"bus"}' | jq -r .target))" \
    || bad "bus: $(ctl probe '{"name":"bus"}' | jq -c '{state, reason}')"
  setting '.AutoMute = true | .AutoMuteDelayMs = 0 | .AutoUnmuteDelayMs = 0 | .AutoMuteMinLevelDb = -70 | .AutoMuteOnlyIfMprisActive = false
           | .AllowScenes = true | .NoAudio = false | .Volume = 100 | .Speed = 1 | .NormalizeAudio = false
           | .GlobalTransitionEnabled = true | .GlobalTransitionEffectIds = ["fade"] | .GlobalTransitionDurationMs = 600'
  # the backend's stream watch (`pactl subscribe`) is a client of the private server
  am_ready() { [ "$(pactl list clients 2>/dev/null | grep -c 'application.process.binary = "pactl"')" -ge 2 ]; }
  waitfor $WAIT am_ready && ok "auto-mute watches the private server" || bad "auto-mute's pactl subscribe never connected: $(pactl list short clients 2>&1 | head -3)"
  amutes() { ctl logs '{"kind_prefix":"anim.start","limit":100000}' | jq '[.events[] | select((.path | test("gain\\.mute$")) and .to < -50)] | length'; }
  sinks_log() { pactl list sink-inputs 2>/dev/null | grep -E 'Sink Input #|node.name|application.name|application.process.id|target.object' | tr -s ' \t' ' ' | paste -sd' ' | sed 's/Sink Input/\n     Sink Input/g'; }
  post /apply "{\"path\":\"$A\"}" >/dev/null; waitfor $WAIT shows "$A" || bad "/apply a → $(cur path)"
  sleep 1
  for meth in full-live reveal frozen; do
    setting ".TransitionMethod = \"$meth\""
    for step in "V→V:$Bc" "V→S:$S1" "S→S:$S2" "S→V:$A"; do
      lbl=${step%%:*}; to=${step#*:}; m0=$(amutes); n0=$(nsch)
      post /apply "{\"path\":\"$to\"}" >/dev/null
      waitfor $WAIT eval 'shows "$to" && switched_to "$to" "$n0"' || bad "$meth $lbl: never handed off to $(basename "$to") (cur $(basename "$(cur path)"))"
      sleep 0.5   # the incoming stream's events (new, uncork) and the outgoing one's removal are all past
      m1=$(amutes)
      [ "$m1" = "$m0" ] && ok "$meth $lbl ($(method_of "$(corr_to "$to" "$n0" now)")): our own audio never auto-muted" \
        || bad "$meth $lbl: auto-mute fired on our own switch ($((m1 - m0)) gain.mute −96 ramps); streams:$(sinks_log)"
    done
  done
  # a FOREIGN stream still mutes every source — as fast as before — and unmutes when it ends
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" -af volume=-12dB "$PW/tone.wav"
  m0=$(amutes); t0=$(ms_now)
  paplay --property=application.name=it-foreign "$PW/tone.wav" & TP=$!
  muted_now() { [ "$(amutes)" -gt "$m0" ]; }
  if waitfor 3000 muted_now; then
    tm=$(ctl logs '{"kind_prefix":"anim.start","limit":100000}' | jq -r '[.events[] | select((.path | test("gain\\.mute$")) and .to < -50)][-1].t_wall')
    lat=$(python3 -c "import datetime,sys; t=datetime.datetime.fromisoformat(sys.argv[1][:26]+'+00:00'); print(int(t.timestamp()*1000)-$t0)" "$tm")
    [ "$lat" -le 1000 ] && ok "a foreign stream (paplay) auto-mutes in ${lat} ms (paplay start → the player's mute ramp)" || bad "a foreign stream muted only after ${lat} ms"
  else bad "a foreign stream played but nothing was auto-muted; streams:$(sinks_log)"; fi
  wait "$TP" 2>/dev/null
  unmuted_now() { ctl state | jq -e '[.graph[] | select(.gain.mute != null) | .gain.mute] | length > 0 and all(. > -1)' >/dev/null; }
  waitfor 3000 unmuted_now && ok "…and unmutes when it ends" || bad "still muted after the foreign stream ended: $(ctl state | jq -c '[.graph[] | select(.gain.mute != null) | .gain.mute]')"
  setting '.AutoMute = false'
  stop_now
  # back to the --ao null player the rest of the test expects; the audio daemons go
  "$B" ctl --timeout-ms 3000 quit >/dev/null 2>&1
  for _ in $(seq 1 600); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$SP" 2>/dev/null && kill -9 "$SP"
  for p in $PWP; do kill "$p" 2>/dev/null; done
  pw_gone() { for p in $PWP; do kill -0 "$p" 2>/dev/null && return 1; done; return 0; }
  waitfor 5000 pw_gone && ok "the private audio daemons are gone" || { bad "a private audio daemon outlived its TERM: $(for p in $PWP; do ps -o pid=,comm= -p "$p"; done)"; for p in $PWP; do kill -9 "$p" 2>/dev/null; done; }
  PWP=""
  start_player am2; waitfor $WAIT eval 'ctl hello >/dev/null 2>&1'; CP=$(comp_pid)
else
  echo "  SKIP (pipewire / pipewire-pulse / wireplumber / pactl / paplay / parec not all found)"
fi

echo "== Phase 3 Task 8: legacy's daemon files never existed under liascape-player (the whole run, sampled every 0.2 s)"
kill "$FWP" 2>/dev/null; wait "$FWP" 2>/dev/null; FWP=""
[ ! -s "$LEGACY_FILES_LOG" ] && ok "no pending_action.txt / timer.pid / gui_timer.pid / restart.pid / timed_state.json / playlist_observer_paths.json at any sample" \
  || bad "legacy files seen: $(awk '{print $2}' "$LEGACY_FILES_LOG" | sort | uniq -c | tr -s ' \n' ' ') (first: $(head -1 "$LEGACY_FILES_LOG"))"

echo "== engine switch liascape-player → legacy with nothing playing (no legacy media starts)"
mp0=$(pgrep -c -f mpvpaper); setting '.PlayerEngine = "legacy"'; sleep 1
[ "$(curl -sf -m 5 "$U/player-engine" | jq -r .active)" = legacy ] && ok "/player-engine active=legacy" || bad "active → $(curl -sf -m 5 "$U/player-engine")"
kill -0 "$SP" 2>/dev/null && bad "liascape-player supervisor still running after the switch away" || ok "liascape-player supervisor quit on switch away"
kill -0 "$CP" 2>/dev/null && bad "liascape-player compositor still running after the switch away" || ok "liascape-player compositor quit on switch away"
[ "$(pgrep -c -f mpvpaper)" = "$mp0" ] && ok "no mpvpaper started/killed" || bad "mpvpaper count changed"
grep -q SteamRefreshToken "$T/backend.log" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null && bad "settings dumped to a log" || ok "no settings dump in the logs"

echo "== adapter log (tail)"
tail -n 8 "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null | sed 's/^/     /'
echo "RESULT pass=$pass fail=$fail"
[ $fail = 0 ]
