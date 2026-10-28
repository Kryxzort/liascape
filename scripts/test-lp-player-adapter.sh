#!/usr/bin/env bash
# Hermetic integration test of the backend's lp-player adapter (PlayerEngine=lp-player).
# See .claude/rules/player-adapter.md § Integration test.
#
# It runs the REAL `livepaper --serve` backend against a PRIVATE `lp-player serve --headless --clock
# real --ao null` (SUPERVISED — `$SP` is the supervisor, `$CP`/`comp_pid` is its compositor child, see
# player-core.md § Supervisor) and drives everything over HTTP, checking the result with `lp-player ctl`:
#   apply + transitions · every live setting · mute · pause (incl. an in-flight transition's pending B) ·
#   volume± · /preview · per-item overrides (incl. a pending B's own override) · timed rotation with
#   align:end · /next mid-wait · /stop · a SIGSTOPped COMPOSITOR (/settings must still answer < 500 ms) ·
#   a kill -9 of the COMPOSITOR → a supervised restart (new hello.pid, same supervisor) · switching the
#   engine lp-player → legacy with nothing playing · Phase 2 scenes (synthetic scene items: apply, every live
#   setting, scene fps, V→S/S→S/S→V, a crashing scene → marked + skipped + advanced, a missing folder, no worker) ·
#   auto-mute never hearing our own switches (the one section with real audio: a private PipeWire + pipewire-pulse).
#
# Hermetic: its own temp HOME / XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME / XDG_RUNTIME_DIR /
# XDG_STATE_HOME (so its own settings.json, library, lp-player socket + event log) and its own random
# backend port. It never talks to another backend (e.g. the dev one on :5174), never reads the real
# settings.json, never connects to the real lp-player socket, never starts or kills mpvpaper (it aborts
# before any playback call unless the backend reports `active: lp-player`). Display/compositor env is
# unset; audio is `--ao null` (but the auto-mute section's, on its own private PipeWire). Everything it started is stopped and its temp dir removed on every exit
# path (EXIT/INT/TERM/HUP trap; a SIGSTOPped compositor is SIGCONTed first; cleanup kills the SUPERVISOR
# `$SP` — never just a compositor pid, which would only make it restart again).
#
# Usage (from anywhere; uses the binaries of the tree this script lives in):
#   scripts/test-lp-player-adapter.sh             # builds lp-player (cargo, via the flake devShell when
#                                                 # `nix` exists) + the backend (dotnet build), then tests
#   scripts/test-lp-player-adapter.sh --no-build  # use what's built (e.g. a tree `dotnet watch` owns)
# Needs: dotnet (or DOTNET=/path/to/dotnet), ffmpeg, jq, curl, python3. Exit 0 = all pass.
# Last line: `RESULT pass=N fail=M`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)  # physical path: a symlinked alias (/home → /mnt/…) makes MSBuild delete its own outputs
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
for t in ffmpeg jq curl python3; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
B=$ROOT/src/player/target/debug/lp-player
# LP_IT_DLL: another backend build to test (e.g. an older commit's, for a RED run of new checks)
DLL=${LP_IT_DLL:-$ROOT/src/livepaper/bin/Debug/net10.0/livepaper.dll}

if [ $BUILD = 1 ]; then
  echo "== build"
  if command -v nix >/dev/null; then
    (cd "$ROOT" && env -u LD_LIBRARY_PATH nix develop -c cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  else
    (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  fi
  "$DOTNET" build "$ROOT/src/livepaper" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -x "$B" ] && [ -f "$DLL" ] || { echo "not built: $B / $DLL (drop --no-build)"; exit 2; }
[ -x "${B%/*}/lp-scene-worker" ] || { echo "not built: ${B%/*}/lp-scene-worker (drop --no-build)"; exit 2; }

# Run the backend from a private copy of its build: the owner's `dotnet watch` rebuilds the same
# bin/Debug whenever a build here touches obj/, and mid-rebuild livepaper.runtimeconfig.json is briefly
# missing — stacks started then died ("backend didn't start": libhostpolicy.so … runtimeconfig.json not
# found; 2 of 6 matrix shards once). Copied whole, retried until the DLL didn't change during the copy.
snapshot_backend() {   # $1 = destination dir → prints the copied DLL's path
  local src; src=$(dirname "$DLL")
  for _ in $(seq 1 60); do
    if [ -f "$src/livepaper.runtimeconfig.json" ] && [ -f "$DLL" ]; then
      local m0; m0=$(stat -c %Y.%s "$DLL")
      mkdir -p "$1" && cp -a "$src/." "$1/" 2>/dev/null
      [ -f "$1/livepaper.runtimeconfig.json" ] && [ -f "$1/livepaper.dll" ] && [ "$(stat -c %Y.%s "$DLL")" = "$m0" ] \
        && { echo "$1/livepaper.dll"; return 0; }
    fi
    sleep 1
  done
  return 1
}
T=$(mktemp -d /tmp/lpit-XXXXXX)   # short: a unix socket path must be < 108 bytes
DLL=$(snapshot_backend "$T/backend") || { echo "ABORT: no complete backend build to snapshot"; exit 2; }
mkdir -p "$T/home/.config/livepaper" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st" "$T/bin"
# the backend's player binary: a link to this build, replaced by a copy to stand in for a rebuild (upgrade test)
ln -s "$B" "$T/bin/lp-player"
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LP_PLAYER_BIN=$T/bin/lp-player LP_TRANSITIONS_DIR=$ROOT/transitions
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# Phase 2 scenes: the private player (and every one the backend starts) plays synthetic scene folders, and
# finds its worker even when its binary is a copy elsewhere (the upgrade test replaces $T/bin/lp-player)
export LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1 LP_SCENE_WORKER_BIN=$ROOT/src/player/target/debug/lp-scene-worker
# The adapter's aligned-switch backstop slack (LpPlayerMedia.AlignBackstopSlackSec, 15 s in production),
# shortened so the speed-drop / long-pause scenarios below reach it in seconds.
export LP_TEST_ALIGN_BACKSTOP_SLACK_SEC=2
unset LP_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LP_UI_DIR LP_PORT
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
  for bp in "$BP" ${BP_OLD:-}; do [ -n "$bp" ] && { kill "$bp" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$bp" 2>/dev/null || break; sleep 0.1; done; kill -9 "$bp" 2>/dev/null; }; done
  # a `--timer-daemon` a stopping backend handed the playlist to (the restart test below)
  [ -s "$XDG_CONFIG_HOME/livepaper/timer.pid" ] && kill -9 "$(cat "$XDG_CONFIG_HOME/livepaper/timer.pid")" 2>/dev/null
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1   # clean child exit → the supervisor exits too, no restart
  # Fallback: kill the SUPERVISOR (never a bare compositor pid — that would just make it restart again).
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  for p in $PWP; do kill -9 "$p" 2>/dev/null; done   # the auto-mute section's private audio daemons
  [ -n "${LP_IT_KEEP:-}" ] && { echo "kept $T"; return; }
  case "$T" in /tmp/lpit-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
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

cat > "$XDG_CONFIG_HOME/livepaper/settings.json" <<EOF
{"PlayerEngine":"lp-player","NoAudio":false,"Loop":true,"Volume":100,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["fade"],"GlobalTransitionDurationMs":300,"TransitionMethod":"full-live",
 "GlobalAdvanceOnVideoEnd":true,"GlobalWaitForVideoEnd":true,"GlobalIntervalSeconds":20,"RestartIntervalSeconds":600}
EOF

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
"$DOTNET" "$DLL" --serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] || { echo "ABORT: backend didn't start (see $T/backend.log)"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")
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
srcIdForPath() { ctl state | jq -r --arg p "$1" '.graph | to_entries[] | select(.value.path==$p) | .key' | head -1; }
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
reapplies() { grep -c "re-applied effective settings" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null || true; }
reapplied_since() { [ "$(reapplies)" -gt "$1" ]; }
# A reapply after a restart: its own log line (count > $1) — or, since the adapter log drops a line
# identical to one written < 10 s earlier, that identical line. It happens when the restarted player
# came back with what an EARLIER reapply named: a snapshot still behind the last switch (writes are
# fsync'ed; under I/O load one lagged 2.4 s) restores the previous wallpaper, so the restart's reapply
# line ("… for dee.mp4 (player.paused = false, kept)") repeats the stall-recovery one 2.7 s before.
reapply_seen() {
  reapplied_since "$1" && return 0
  grep -q "lp-player restarted (new pid)" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null || return 1
  python3 - "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" \
    "lp-player: re-applied effective settings for $(basename "$(cur path)") (player.paused = $(playerPaused), kept)" <<'PY'
import re, sys
log, want = sys.argv[1], sys.argv[2]
def t(line):
    m = re.match(r"\[lp-player (\d+):(\d+):([\d.]+)\] ", line)
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else None
lines = open(log).read().splitlines()
restart = [t(l) for l in lines if "lp-player restarted (new pid)" in l][-1]
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
SNAP=$XDG_STATE_HOME/livepaper/lp-player/snapshot.json
snap_paused() { jq -e --argjson v "$1" '.player.paused == $v' "$SNAP" >/dev/null 2>&1; }

PE=$(curl -sf -m 5 "$U/player-engine"); echo "player-engine: $PE"
[ "$(echo "$PE" | jq -r .active)" = "lp-player" ] || { echo "ABORT: backend not on lp-player — refusing to touch any legacy player"; exit 1; }

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
setting '.VideoFps = 30'; waitfor $WAIT cur_near fps_cap 30 && ok "VideoFps 30 → fps_cap" || bad "VideoFps → $(cur fps_cap)"
setting '.HwDec = "no"'; waitfor $WAIT cur_is hwdec no && ok "HwDec no" || bad "HwDec → $(cur hwdec)"
setting '.DisableCache = true'; waitfor $WAIT cur_is cache false && ok "DisableCache → cache false" || bad "cache → $(cur cache)"
setting '.DemuxerMaxBytes = 64'; waitfor $WAIT cur_near demuxer_max_mib 64 && ok "DemuxerMaxBytes 64" || bad "demuxer → $(cur demuxer_max_mib)"
setting '.NoAudio = true'; waitfor $WAIT cur_is no_audio true && ok "NoAudio → no_audio true" || bad "NoAudio → $(cur no_audio)"
setting '.NoAudio = false'; waitfor $WAIT cur_is no_audio false && ok "NoAudio off" || bad "NoAudio off → $(cur no_audio)"
setting '.Loop = false'; waitfor $WAIT cur_is loop false && ok "Loop off (single video)" || bad "Loop → $(cur loop)"
setting '.Loop = true | .Speed = 1 | .VideoFps = 0'; waitfor $WAIT cur_near speed 1 || bad "Loop/Speed/VideoFps reset → speed $(cur speed)"
post /mute '{"value":true,"user":true}' >/dev/null; waitfor $WAIT cur_near gain.mute -96 && ok "user mute → gain.mute -96" || bad "mute → $(cur gain.mute)"
post /mute '{"value":false,"user":true}' >/dev/null; waitfor $WAIT cur_near gain.mute 0 && ok "unmute → 0" || bad "unmute → $(cur gain.mute)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true && ok "/pause → player.paused" || bad "pause → $(playerPaused)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is false && ok "/pause again → playing" || bad "unpause → $(playerPaused)"
g55=$(dB 55); g20=$(dB 20)
post /volume '{"delta":5}' >/dev/null; waitfor $WAIT cur_near gain.user "$g55" && ok "/volume +5 → 55%" || bad "volume+5 → $(cur gain.user)"
post /preview '{"volume":20}' >/dev/null; waitfor $WAIT cur_near gain.user "$g20" && ok "/preview volume 20 → that item's source" || bad "preview → $(cur gain.user)"

echo "== timed playlist: interval 20 s + WaitForVideoEnd + AdvanceOnVideoEnd (2 s clips → advance on end)"
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
"$DOTNET" "$DLL" --action=toggle-pause > "$T/cli1.log" 2>&1
waitfor $WAIT paused_is true && ok "CLI --action=toggle-pause → player.paused" || bad "CLI toggle → $(playerPaused)"
# Precondition: the player's snapshot carries the pause (written 250 ms after a change — a fixed 0.6 s
# wait didn't always cover it under load, and a crash before it restores the player unpaused).
waitfor $WAIT snap_paused true || bad "the snapshot never recorded player.paused=true: $(jq -c .player "$SNAP" 2>&1)"
re0=$(reapplies)
oldCP=$CP; kill -9 "$CP"
for _ in $(seq 1 30); do CP=$(comp_pid); [ -n "$CP" ] && [ "$CP" != "$oldCP" ] && break; sleep 0.05; done
# the backend's OnRestarted reapply must have RUN before this proves it didn't flip the pause
waitfor $WAIT reapply_seen "$re0" || bad "no reapply after the restart (compositor $oldCP → $CP)"
pp=$(playerPaused); [ "$pp" = true ] && ok "pause survived the restart + the backend's reapply (not flipped)" || bad "after restart: player.paused $pp"
"$DOTNET" "$DLL" --action=toggle-pause > "$T/cli2.log" 2>&1
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

echo "== Task 20c: /next /prev /random skip scenes under lp-player (never a 500, never land on one)"
# Minimal fake scene items the way LibraryService/PlayerHelper actually recognize them (library.md /
# player.md): a library-item FOLDER with project.json {"type":"scene"} and NO media file — exactly
# what IsSceneFolder checks, and exactly what makes PlayerHelper.IsScenePath (no media extension) true
# for that folder's path. No linux-wallpaperengine / scene.pkg needed to be *recognized* as a scene —
# only to actually render one, which these never attempt (they must be SKIPPED, not launched).
LIB=$XDG_DATA_HOME/livepaper/library
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
# self-test instead (LpPlayerSelfTest.SceneSkipAssertions) — this IT script stays on lp-player
# throughout by design (see header: "it aborts before any playback call unless active: lp-player"),
# and switching the live engine to legacy here while something is playing would try to launch a real
# mpvpaper/LWE, which this hermetic sandbox explicitly never does.
stop_now

echo "== Phase 2: scenes under lp-player (synthetic scenes — the player runs with LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1)"
# Synthetic scene items the way lp-player's tests write them (tests/common::synthetic_scene): a workshop item
# folder with project.json type scene + scene.pkg + preview.png + lp-synthetic.json (the worker's synthetic
# renderer; only with the env gate — WE's assets are proprietary, no real scene renders hermetically).
mk_scene() {   # $1 = item folder, $2 = lp-synthetic.json
  mkdir -p "$1"
  printf '{"type":"scene","title":"%s","file":"scene.json","preview":"preview.png"}' "$(basename "$1")" > "$1/project.json"
  head -c 16 /dev/zero > "$1/scene.pkg"
  printf '%s' "$2" > "$1/lp-synthetic.json"
  echo iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC | base64 -d > "$1/preview.png"
}
# Task 20c's fake scenes have no lp-synthetic.json (they'd need WE's assets): out of the library meanwhile
mv "$LIB/imported/ss1" "$T/removed-ss1"; mv "$LIB/imported/ss2" "$T/removed-ss2"
S1=$LIB/workshop/900000001; S2=$LIB/workshop/900000002; S3=$LIB/workshop/900000003; S4=$LIB/workshop/900000004
mk_scene "$S1" '{"pattern":"solid","rgb":[255,0,0],"native":[640,360],"has_audio":true,"tone_hz":440}'
mk_scene "$S2" '{"pattern":"solid","rgb":[0,0,255],"native":[640,360],"has_audio":true,"tone_hz":660}'
mk_scene "$S3" '{"pattern":"solid","rgb":[0,255,0],"native":[640,360],"crash_after_ms":400}'
mk_scene "$S4" '{"pattern":"solid","native":[640,360]}'
IDX=$LIB/workshop/index.json
setting '.AllowScenes = true | .Volume = 100 | .Speed = 1 | .NoAudio = false | .LweMonitors = []'
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
# the outputs there are now (the I4 section above replugs them as VIRTUAL-3 + VIRTUAL-2), every one in LweMonitors
OUTS=$(ctl state | jq -c '[.outputs[].name]'); O1=$(echo "$OUTS" | jq -r '.[0]')
all_fps() { echo "$OUTS" | jq -r '.[]' | while read -r o; do near "$(out_fps "$o")" "$1" || return 1; done; }
fps_now() { all_fps "$1" && near "$(ctl probe '{"name":"workers"}' | jq -r --arg id "$SID" '.workers[] | select(.id==$id) | .fps_target')" "$1"; }
setting ".LweMonitors = ($OUTS | to_entries | map({Name: .value, Fps: 45, IsPrimary: (.key == 0)}))"
waitfor $WAIT fps_now 45 && [ "$(wpid "$SID")" = "$WP" ] && ok "LweMonitors fps 45 on $OUTS → each out:<c>.scene_fps 45 live, the worker ticks at 45, same pid" || bad "LweMonitors fps → out:$O1 $(out_fps "$O1"), worker $(ctl probe '{"name":"workers"}' | jq -c --arg id "$SID" '.workers[] | select(.id==$id) | {fps_target, pid}')"
setting '.LweMonitors = []'
waitfor $WAIT fps_now 30 && ok "LweMonitors emptied → back to the default 30" || bad "LweMonitors [] → out:$O1 $(out_fps "$O1")"

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
# The player measures VRAM through LP_PLAYER_VRAM_PROBE=fake:<file> (read at every sample: {total_mib, free_mib,
# procs: {"<pid>": MiB}}) with short holds (interval 200, enter 600, resume 2000, settle 300, scene hold 600 ms) —
# deterministic, never this machine's GPU. 6000 of 8192 MiB free: the low-VRAM rule never engages here.
VR=$T/vram.json
vram_fake() { printf '{"total_mib":8192,"free_mib":6000,"procs":{%s}}' "$1" > "$VR.tmp" && mv "$VR.tmp" "$VR"; }
vram_fake ""
VRAM_ENV=(LP_PLAYER_VRAM_PROBE=fake:$VR LP_PLAYER_VRAM_TIMING=200,600,2000,300,600)
restart_player 8 "${VRAM_ENV[@]}"
pget() { ctl get "{\"path\":\"player.$1\"}" | jq -r '.value | if type == "number" then (. * 1000 | round / 1000) else . end'; }   # 0.0 → 0
p_is() { [ "$(pget "$1")" = "$2" ]; }
p_near() { near "$(pget "$1")" "$2" 0.001; }
gpu_props() { echo "throttle $(pget scene_throttle), limit $(pget scene_vram_limit_mib), low $(pget vram_low_mode)"; }
[ "$(gpu_props)" = "throttle true, limit 0, low stop" ] && ok "a fresh player: the defaults ($(gpu_props))" || bad "a fresh player: $(gpu_props)"
post /apply "{\"path\":\"$S1\"}" >/dev/null
waitfor 5000 scene_ready "$S1" || bad "/apply s1 on the fake-VRAM player → $(basename "$(cur path)") ready $(cur ready)"
SID=$(srcIdForPath "$S1"); WP=$(wpid "$SID")
setting '.SceneThrottle = false'
waitfor $WAIT p_is scene_throttle false && [ "$(wpid "$SID")" = "$WP" ] && ok "SceneThrottle off → player.scene_throttle false live, same worker $WP" || bad "SceneThrottle off → $(gpu_props), pid $WP → $(wpid "$SID")"
setting '.SceneThrottle = true'
waitfor $WAIT p_is scene_throttle true && ok "SceneThrottle on → true" || bad "SceneThrottle on → $(gpu_props)"
setting '.SceneVramLimitEnabled = true | .SceneVramLimitMib = 1536'
waitfor $WAIT p_near scene_vram_limit_mib 1536 && [ "$(wpid "$SID")" = "$WP" ] && ok "the VRAM limit on at 1536 MiB → player.scene_vram_limit_mib 1536 live, same worker" || bad "VRAM limit on → $(gpu_props)"
setting '.SceneVramLimitMib = 2048'
waitfor $WAIT p_near scene_vram_limit_mib 2048 && ok "…2048 MiB → 2048" || bad "VRAM limit 2048 → $(gpu_props)"
setting '.SceneVramLimitEnabled = false'
waitfor $WAIT p_near scene_vram_limit_mib 0 && [ "$(curl -sf -m 5 "$U/settings" | jq -r '.sceneVramLimitMib')" = 2048 ] && ok "the limit off → 0 (off), the MiB value kept for the toggle" || bad "VRAM limit off → $(gpu_props), saved MiB $(curl -sf -m 5 "$U/settings" | jq -r '.sceneVramLimitMib')"
for m in pause off stop; do
  setting ".VramLowMode = \"$m\""
  waitfor $WAIT p_is vram_low_mode "$m" && ok "VramLowMode $m → player.vram_low_mode $m live" || bad "VramLowMode $m → $(gpu_props)"
done
[ "$(pget paused)" = false ] && ok "none of it touched player.paused" || bad "player.paused $(pget paused) after the GPU settings"
# a fresh player process (not restored: the defaults) gets the backend's values back (R81's re-apply)
setting '.SceneThrottle = false | .SceneVramLimitEnabled = true | .SceneVramLimitMib = 1536 | .VramLowMode = "pause"'
waitfor $WAIT eval '[ "$(gpu_props)" = "throttle false, limit 1536, low pause" ]' || bad "set before the restart: $(gpu_props)"
stop_now
restart_player 8b "${VRAM_ENV[@]}"
waitfor 15000 eval '[ "$(gpu_props)" = "throttle false, limit 1536, low pause" ]' && ok "a fresh player gets them re-applied: $(gpu_props)" || bad "after a player restart: $(gpu_props) (want throttle false, limit 1536, low pause)"
setting '.SceneThrottle = true | .VramLowMode = "stop"'

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
setting '.SceneVramLimitEnabled = false'

echo "== Phase 2: scene loudness learned on first play (scene.loudness → the index → gain.normalize, live)"
# A player whose learning window is 3 s of audible play (LP_PLAYER_LOUDNESS_WINDOW_S; 60 in production, a partial
# from a third of it). S5: a stereo 1 kHz tone at −20 dBFS peak = −20 LUFS; S6: no sound; S7: −26 dBFS.
restart_player 8c LP_PLAYER_LOUDNESS_WINDOW_S=3
S5=$LIB/workshop/900000005; S6=$LIB/workshop/900000006; S7=$LIB/workshop/900000007
mk_scene "$S5" '{"pattern":"solid","rgb":[255,255,0],"native":[640,360],"has_audio":true,"tone_hz":1000,"tone_dbfs":-20}'
mk_scene "$S6" '{"pattern":"solid","rgb":[0,255,255],"native":[640,360]}'
mk_scene "$S7" '{"pattern":"solid","rgb":[255,0,255],"native":[640,360],"has_audio":true,"tone_hz":1000,"tone_dbfs":-26}'
idx_loud() { jq -c --arg k "$1" '.[$k] | {i: .loudnessI, tp: .loudnessTP, s: .loudnessSeconds, partial: .loudnessPartial}' "$IDX" 2>/dev/null; }
loud_i() { jq -r --arg k "$1" '.[$k].loudnessI // empty' "$IDX" 2>/dev/null; }
wloud() { ctl probe '{"name":"workers"}' | jq -r --arg id "$1" ".workers[] | select(.id==\$id) | .loudness.$2"; }
setting '.NormalizeAudio = true | .NormalizeTargetLufs = -14 | .Volume = 100 | .NoAudio = false'
post /apply "{\"path\":\"$S5\"}" >/dev/null
waitfor 5000 scene_ready "$S5" || bad "/apply s5 → $(basename "$(cur path)") ready $(cur ready)"
SID5=$(srcIdForPath "$S5"); WP5=$(wpid "$SID5")
near "$(cur gain.normalize)" 0 0.001 && ok "an unlearned scene plays at gain.normalize 0" || bad "unlearned scene: gain.normalize $(cur gain.normalize)"
t_l=$(ms_now)
waitfor 15000 eval '[ -n "$(loud_i 900000005)" ]' && ok "learned after $(( $(ms_now) - t_l )) ms of play: index $(idx_loud 900000005)" || bad "no loudness in the index: $(idx_loud 900000005)"
near "$(loud_i 900000005)" -20 1 && jq -e '."900000005" | .loudnessSeconds >= 3 and (.loudnessPartial // false | not)' "$IDX" >/dev/null \
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
stop_now
post /apply "{\"path\":\"$S5\"}" >/dev/null
waitfor 5000 scene_ready "$S5" || bad "re-apply s5 → $(basename "$(cur path)")"
SID5b=$(srcIdForPath "$S5")
W5=$(python3 -c "print(round(-14 - float('$I5'), 3))")
G5b=$(ctl get "{\"path\":\"$SID5b.gain.normalize\"}" | jq -r .value)
A5b=$(ctl logs '{"kind_prefix":"anim.start","limit":10000}' | jq --arg p "$SID5b.gain.normalize" '[.events[] | select(.path==$p)] | length')
[ "$SID5b" != "$SID5" ] && near "$G5b" "$W5" 0.01 && [ "$A5b" = 0 ] \
  && ok "reopened ($SID5b): gain.normalize $G5b from its first frame (its create props — no ramp)" || bad "reopened $SID5b: gain.normalize $G5b (want $W5), ramps $A5b"
ns_l() { ctl logs '{"kind_prefix":"scene.loudness","limit":10000}' | jq --arg id "$1" '[.events[] | select(.id==$id)] | length'; }
waitfor 15000 eval '[ "$(ns_l "$SID5b")" -ge 1 ]' && [ "$(loud_i 900000005)" = "$I5" ] && ok "a second play's measurement keeps the learned one ($I5)" || bad "second play: events $(ns_l "$SID5b"), index $(idx_loud 900000005) (was $I5)"
grep -q "loudness .* kept the stored one" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" || bad "adapter log has no 'kept the stored one' line"
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
waitfor $WAIT eval '[ -n "$(loud_i 900000007)" ]' && jq -e '."900000007".loudnessPartial == true' "$IDX" >/dev/null && near "$(loud_i 900000007)" -26 1 \
  && ok "switched away after ~1.2 s: a partial stored $(idx_loud 900000007)" || bad "partial: $(idx_loud 900000007)"
post /apply "{\"path\":\"$S7\"}" >/dev/null
waitfor 5000 scene_ready "$S7" || bad "re-apply s7 → $(basename "$(cur path)")"
SID7b=$(srcIdForPath "$S7")
waitfor $WAIT cur_near gain.normalize 12 0.2 && ok "reopened with a partial: gain.normalize $(cur gain.normalize) (−14 − (−26)) from it" || bad "s7 with a partial: gain.normalize $(cur gain.normalize), want 12 (applied from the partial)"
waitfor 15000 eval 'jq -e ".\"900000007\" | (.loudnessPartial // false | not) and .loudnessSeconds >= 3" "$IDX" >/dev/null' && [ "$(wpid "$SID7b")" != "" ] \
  && ok "the next play completed it: $(idx_loud 900000007), gain.normalize $(cur gain.normalize)" || bad "s7 never completed: $(idx_loud 900000007)"
stop_now
setting '.NormalizeAudio = false'
mv "$S5" "$S6" "$S7" "$T/"   # out of the library: the sections below step through it

restart_player 9 LP_SCENE_WORKER_BIN=/nonexistent
ctl hello | jq -e '.capabilities | index("scene") == null' >/dev/null && ok "a player whose lp-scene-worker doesn't resolve has no scene capability" || bad "capabilities: $(ctl hello | jq -c .capabilities)"
pe_off() { curl -sf -m 5 "$U/player-engine" | jq -e '.scenes.available == false and (.scenes.reason | type == "string" and length > 0)' >/dev/null; }
waitfor $WAIT pe_off && ok "/player-engine.scenes: unavailable, with a reason: $(curl -sf -m 5 "$U/player-engine" | jq -r .scenes.reason)" || bad "/player-engine.scenes: $(pe_scenes)"
lib_steps_no_scene "no lp-scene-worker"
restart_player 10
setting '.AllowScenes = false'
mv "$T/removed-ss1" "$LIB/imported/ss1"; mv "$T/removed-ss2" "$LIB/imported/ss2"

echo "== play-from keeps the playlist's transition settings (it used to rebuild them from rotation fields only)"
pf=$(jq -nc --arg a "$SV1" --arg b "$SV2" '{paths:[$a,$b], startIndex:1, settings:{order:1, overrideGlobalSettings:true,
  intervalSeconds:20, advanceOnVideoEnd:true, waitForVideoEnd:true, transitionEnabled:true,
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
backstops() { grep -c "not handed off within" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null || true; }
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
[ "$(backstops)" = "$bs0" ] && ok "no adapter backstop fired" || bad "the adapter backstop fired: $(grep "not handed off within" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" | tail -1)"
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
[ "$(backstops)" = "$bs0" ] && ok "no adapter backstop fired while paused" || bad "the adapter backstop fired while paused: $(grep "not handed off within" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" | tail -1)"
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
# A stopping backend hands its timed playlist to a detached --timer-daemon, but kept ticking itself until
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
storms() { grep -c "→ switching in" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null || true; }
port_moved() { [ "$(cat "$XDG_CONFIG_HOME/livepaper/serve.port" 2>/dev/null)" != "$1" ]; }
healthy() { curl -sf -m 2 "$U/health" >/dev/null; }
new_backend_up() {   # $1 = the old port; sets U
  waitfor 60000 port_moved "$1" || bad "the new backend never wrote its port"
  U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")
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
st0=$(storms); nw0=$(nows); h0=$(handoffs); port0=$(cat "$XDG_CONFIG_HOME/livepaper/serve.port"); pe=$(tpos 0); te=$(ms_now)
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; OLD1=$BP; sleep 1.5
"$DOTNET" "$DLL" --serve > "$T/backend2.log" 2>&1 & BP=$!
new_backend_up "$port0"
kill -0 "$OLD1" 2>/dev/null && ok "the old backend is still shutting down (WebSocket open) while the new one runs" || echo "  note the old backend already exited — the overlap this tests didn't happen"
e1_window "$te" "$pe"   # E1 (12 s) ends inside this window → exactly one aligned advance
[ "$(storms)" = "$st0" ] && ok "no switch storm across the restart" || bad "switch storm: $(( $(storms) - st0 )) failed/superseded aligned switches — $(grep "→ switching in" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" | tail -3 | tr '\n' ' ')"
[ "$(nows)" = "$nw0" ] && ok "no immediate (align:now) switch during the handover" || bad "$(( $(nows) - nw0 )) align:now switches during the handover"
one_advance && ok "one advance at E1's end, E2 on screen" || bad "$dh handoffs, the last to $(basename "$dto")"
[ "$(cat "$XDG_CONFIG_HOME/livepaper/gui_timer.pid" 2>/dev/null)" = "$BP" ] && ok "the new backend owns the timer (gui_timer.pid)" || bad "gui_timer.pid = $(cat "$XDG_CONFIG_HOME/livepaper/gui_timer.pid" 2>/dev/null) (new backend $BP)"
tp=$(cat "$XDG_CONFIG_HOME/livepaper/timer.pid" 2>/dev/null); { [ -z "$tp" ] || ! kill -0 "$tp" 2>/dev/null; } && ok "no --timer-daemon left running" || bad "a --timer-daemon (pid $tp) runs next to the new backend"
kill "$WSP" 2>/dev/null; WSP=""
for _ in $(seq 1 50); do kill -0 "$OLD1" 2>/dev/null || break; sleep 0.1; done
stop_now

echo "== a second backend started while the first runs takes the playlist over (the first stops ticking)"
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
armed_only
st0=$(storms); nw0=$(nows); h0=$(handoffs); port0=$(cat "$XDG_CONFIG_HOME/livepaper/serve.port"); first=$BP; pe=$(tpos 0); te=$(ms_now)
"$DOTNET" "$DLL" --serve > "$T/backend3.log" 2>&1 & BP=$!; BP_OLD="$BP_OLD $first"
new_backend_up "$port0"
e1_window "$te" "$pe"
[ "$(storms)" = "$st0" ] && [ "$(nows)" = "$nw0" ] && ok "two live backends: no storm, no immediate switch" || bad "two live backends: $(( $(storms) - st0 )) failed aligned switches, $(( $(nows) - nw0 )) align:now"
one_advance && ok "one advance at E1's end" || bad "$dh handoffs, the last to $(basename "$dto")"
grep -q "stops ticking" "$T/backend2.log" && ok "the first backend yielded: $(grep -m1 "stops ticking" "$T/backend2.log")" || bad "the first backend never yielded the timer"
kill "$first" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$first" 2>/dev/null || break; sleep 0.1; done
stop_now

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
# Every snapshot write takes 4 s here (LP_PLAYER_TEST_SNAPSHOT_WRITE_MS — what an fsync took under load): a crash
# right after a switch restores the wallpaper before it. R81 re-applied settings only, never the wallpaper — the
# screen kept a, while the backend (and every UI) said c.
restart_player 4 LP_PLAYER_TEST_SNAPSHOT_WRITE_MS=4000
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
restart_player 5 LP_PLAYER_TEST_SNAPSHOT_WRITE_MS=4000
kills() { grep -cE "did not quit|ignored SIGTERM" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null || true; }
rebuild() { cp "$B" "$T/bin/lp-player.new" && mv -f "$T/bin/lp-player.new" "$T/bin/lp-player"; }
post /apply "{\"path\":\"$D\"}" >/dev/null; waitfor $WAIT shows "$D" || bad "/apply d → cur $(cur path)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true || bad "/pause → player.paused $(playerPaused)"
CP0=$(comp_pid); SP0=$(sup_pid); k0=$(kills)
curl -sf -m 5 "$U/player-engine" | jq -e '.running.stale == null' >/dev/null && ok "/player-engine: running player current" || bad "stale before the rebuild: $(curl -sf -m 5 "$U/player-engine" | jq -c .running)"
rebuild
waitfor 60000 newcomp "$CP0"   # ≤ the 10 s check + 2 s settle + the old player's slow quit (≤ 2 writes of 4 s)
CP=$(comp_pid); SP=$(sup_pid)
[ -n "$CP" ] && [ "$CP" != "$CP0" ] && [ -n "$SP" ] && [ "$SP" != "$SP0" ] && ok "idle player upgraded: compositor $CP0 → $CP, supervisor $SP0 → $SP" || bad "no upgrade: compositor $CP0 → $CP, supervisor $SP0 → $SP"
[ "$(readlink "/proc/$CP/exe")" = "$T/bin/lp-player" ] && ok "it runs the new build" || bad "it runs $(readlink "/proc/$CP/exe")"
[ "$(cur path)" = "$D" ] && [ "$(playerPaused)" = true ] && ok "same wallpaper, still paused" || bad "after the upgrade: cur $(basename "$(cur path)") paused=$(playerPaused)"
[ "$(ctl logs '{"kind_prefix":"snapshot.restored"}' | jq '.events|length')" -ge 1 ] && ok "restored from its snapshot" || bad "no snapshot.restored on the new player"
[ "$(kills)" = "$k0" ] && ok "the old player's slow clean quit was waited for (never signalled)" || bad "the upgrade signalled the quitting player: $(grep -E "did not quit|ignored SIGTERM" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" | tail -2 | tr '\n' ' ')"
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

echo "== auto-mute never hears our own switches (a private PipeWire + pipewire-pulse; the player on its real audio bus)"
# Owner report: with AutoMute on (both delays 0) every switch muted the wallpaper for a hitch — for the whole
# "unmute after" delay when that's > 0. The incoming source's own stream (mpv's `lp-player` node / a scene worker's
# `lp-player-scene.<id>`) was MONITORED from its first event and only classified as ours ~120 ms later, and each
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
  setting '.AutoMute = true | .AutoMuteDelayMs = 0 | .AutoUnmuteDelayMs = 0 | .AutoMuteThresholdDb = -70 | .AutoMuteOnlyIfMprisActive = false
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

echo "== engine switch lp-player → legacy with nothing playing (no legacy media starts)"
mp0=$(pgrep -c -f mpvpaper); setting '.PlayerEngine = "legacy"'; sleep 1
[ "$(curl -sf -m 5 "$U/player-engine" | jq -r .active)" = legacy ] && ok "/player-engine active=legacy" || bad "active → $(curl -sf -m 5 "$U/player-engine")"
kill -0 "$SP" 2>/dev/null && bad "lp-player supervisor still running after the switch away" || ok "lp-player supervisor quit on switch away"
kill -0 "$CP" 2>/dev/null && bad "lp-player compositor still running after the switch away" || ok "lp-player compositor quit on switch away"
[ "$(pgrep -c -f mpvpaper)" = "$mp0" ] && ok "no mpvpaper started/killed" || bad "mpvpaper count changed"
grep -q SteamRefreshToken "$T/backend.log" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null && bad "settings dumped to a log" || ok "no settings dump in the logs"

echo "== adapter log (tail)"
tail -n 8 "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null | sed 's/^/     /'
echo "RESULT pass=$pass fail=$fail"
[ $fail = 0 ]
