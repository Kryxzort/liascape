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
#   engine lp-player → legacy with nothing playing.
#
# Hermetic: its own temp HOME / XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME / XDG_RUNTIME_DIR /
# XDG_STATE_HOME (so its own settings.json, library, lp-player socket + event log) and its own random
# backend port. It never talks to another backend (e.g. the dev one on :5174), never reads the real
# settings.json, never connects to the real lp-player socket, never starts or kills mpvpaper (it aborts
# before any playback call unless the backend reports `active: lp-player`). Display/compositor env is
# unset; audio is `--ao null`. Everything it started is stopped and its temp dir removed on every exit
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
DLL=$ROOT/src/livepaper/bin/Debug/net10.0/livepaper.dll

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
# The adapter's aligned-switch backstop slack (LpPlayerMedia.AlignBackstopSlackSec, 15 s in production),
# shortened so the speed-drop / long-pause scenarios below reach it in seconds.
export LP_TEST_ALIGN_BACKSTOP_SLACK_SEC=2
unset LP_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LP_UI_DIR LP_PORT
SP=""; CP=""; BP=""
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

echo "== a rebuilt player binary: the backend restarts the player onto it, keeping what it shows"
# The player outlives the backend on purpose, so a rebuild/reinstall never reached a running one: fixes
# "persisted" for hours. Here: a new file at the backend's binary path (cp + mv = a new inode, like cargo/nix).
rebuild() { cp "$B" "$T/bin/lp-player.new" && mv -f "$T/bin/lp-player.new" "$T/bin/lp-player"; }
post /apply "{\"path\":\"$D\"}" >/dev/null; waitfor $WAIT shows "$D" || bad "/apply d → cur $(cur path)"
post /pause '{}' >/dev/null; waitfor $WAIT paused_is true || bad "/pause → player.paused $(playerPaused)"
CP0=$(comp_pid); SP0=$(sup_pid)
curl -sf -m 5 "$U/player-engine" | jq -e '.running.stale == null' >/dev/null && ok "/player-engine: running player current" || bad "stale before the rebuild: $(curl -sf -m 5 "$U/player-engine" | jq -c .running)"
rebuild
for _ in $(seq 1 200); do c=$(comp_pid); [ -n "$c" ] && [ "$c" != "$CP0" ] && break; sleep 0.1; done   # ≤ the 10 s check + 2 s settle
CP=$(comp_pid); SP=$(sup_pid)
[ -n "$CP" ] && [ "$CP" != "$CP0" ] && [ -n "$SP" ] && [ "$SP" != "$SP0" ] && ok "idle player upgraded: compositor $CP0 → $CP, supervisor $SP0 → $SP" || bad "no upgrade: compositor $CP0 → $CP, supervisor $SP0 → $SP"
[ "$(readlink "/proc/$CP/exe")" = "$T/bin/lp-player" ] && ok "it runs the new build" || bad "it runs $(readlink "/proc/$CP/exe")"
[ "$(cur path)" = "$D" ] && [ "$(playerPaused)" = true ] && ok "same wallpaper, still paused" || bad "after the upgrade: cur $(basename "$(cur path)") paused=$(playerPaused)"
[ "$(ctl logs '{"kind_prefix":"snapshot.restored"}' | jq '.events|length')" -ge 1 ] && ok "restored from its snapshot" || bad "no snapshot.restored on the new player"
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
