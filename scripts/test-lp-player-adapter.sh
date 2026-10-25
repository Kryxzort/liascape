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
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
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

T=$(mktemp -d /tmp/lpit-XXXXXX)   # short: a unix socket path must be < 108 bytes
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
cur()  { ctl get "{\"path\":\"cur:*.$1\"}" 2>/dev/null | jq -r '.value'; }
# R75 (final): pause is PLAYER-level (`player.paused`), not a per-source prop — `cur:*.paused` (the
# node's own raw value) never changes, by design (a recipe-held source must stay exactly as the
# recipe left it; see player-core.md § Graph & properties "Player node paused").
playerPaused() { ctl get '{"path":"player.paused"}' | jq -r .value; }
srcPaused() { ctl probe '{"name":"sources"}' | jq -r --arg id "$1" '.sources[] | select(.id==$id) | .effective_paused'; }
srcIdForPath() { ctl state | jq -r --arg p "$1" '.graph | to_entries[] | select(.value.path==$p) | .key' | head -1; }
setting() { curl -sf -m 5 "$U/settings" | jq "$1" > "$T/s.json" && post /settings "$(cat "$T/s.json")" >/dev/null; }
post_ms() { curl -s -m 10 -o /dev/null -w '%{time_total}' -X POST -H 'Content-Type: application/json' -d "$2" "$U$1" | python3 -c "import sys; print(int(float(sys.stdin.read())*1000))"; }

PE=$(curl -sf -m 5 "$U/player-engine"); echo "player-engine: $PE"
[ "$(echo "$PE" | jq -r .active)" = "lp-player" ] || { echo "ABORT: backend not on lp-player — refusing to touch any legacy player"; exit 1; }

echo "== apply / transition"
post /apply "{\"path\":\"$A\"}" >/dev/null; sleep 1
[ "$(cur path)" = "$A" ] && ok "/apply a → cur a" || bad "/apply a → cur $(cur path)"
post /apply "{\"path\":\"$Bc\"}" >/dev/null; sleep 1.2
[ "$(cur path)" = "$Bc" ] && ok "/apply b → cur b" || bad "/apply b → cur $(cur path)"
ctl logs '{"kind_prefix":"transition.started"}' | jq -r '.events[-1] | "\(.effect_id) \(.method)"' | grep -q "fade full-live" && ok "a→b ran fade full-live" || bad "a→b effect: $(ctl logs '{"kind_prefix":"transition.started"}' | jq -c '.events[-1]')"
curl -sf -m 5 "$U/current" | jq -e ".playing == true and .path == \"$Bc\" and (.position|type) == \"number\"" >/dev/null && ok "/current playing b + position" || bad "/current $(curl -sf -m 5 "$U/current")"

echo "== live settings"
setting '.Volume = 50'; sleep 0.3; near "$(cur gain.user)" -18.0618 && ok "Volume 50 → gain.user $(cur gain.user)" || bad "Volume 50 → $(cur gain.user)"
setting '.Speed = 1.5'; sleep 0.3; near "$(cur speed)" 1.5 && ok "Speed 1.5" || bad "Speed → $(cur speed)"
setting '.VideoScale = "fit"'; sleep 0.3; [ "$(ctl get '{"path":"lay:VIRTUAL-1:main.fit"}' | jq -r .value)" = fit ] && ok "VideoScale fit → layer fit" || bad "VideoScale"
setting '.VideoFps = 30'; sleep 0.3; near "$(cur fps_cap)" 30 && ok "VideoFps 30 → fps_cap" || bad "VideoFps → $(cur fps_cap)"
setting '.HwDec = "no"'; sleep 0.3; [ "$(cur hwdec)" = no ] && ok "HwDec no" || bad "HwDec → $(cur hwdec)"
setting '.DisableCache = true'; sleep 0.3; [ "$(cur cache)" = false ] && ok "DisableCache → cache false" || bad "cache → $(cur cache)"
setting '.DemuxerMaxBytes = 64'; sleep 0.3; near "$(cur demuxer_max_mib)" 64 && ok "DemuxerMaxBytes 64" || bad "demuxer → $(cur demuxer_max_mib)"
setting '.NoAudio = true'; sleep 0.3; [ "$(cur no_audio)" = true ] && ok "NoAudio → no_audio true" || bad "NoAudio → $(cur no_audio)"
setting '.NoAudio = false'; sleep 0.3; [ "$(cur no_audio)" = false ] && ok "NoAudio off" || bad "NoAudio off → $(cur no_audio)"
setting '.Loop = false'; sleep 0.3; [ "$(cur loop)" = false ] && ok "Loop off (single video)" || bad "Loop → $(cur loop)"
setting '.Loop = true | .Speed = 1 | .VideoFps = 0'; sleep 0.3
post /mute '{"value":true,"user":true}' >/dev/null; sleep 0.3; near "$(cur gain.mute)" -96 && ok "user mute → gain.mute -96" || bad "mute → $(cur gain.mute)"
post /mute '{"value":false,"user":true}' >/dev/null; sleep 0.3; near "$(cur gain.mute)" 0 && ok "unmute → 0" || bad "unmute → $(cur gain.mute)"
post /pause '{}' >/dev/null; sleep 0.3; [ "$(playerPaused)" = true ] && ok "/pause → player.paused" || bad "pause → $(playerPaused)"
post /pause '{}' >/dev/null; sleep 0.3; [ "$(playerPaused)" = false ] && ok "/pause again → playing" || bad "unpause → $(playerPaused)"
post /volume '{"delta":5}' >/dev/null; sleep 0.3; near "$(cur gain.user)" "$(dB 55)" && ok "/volume +5 → 55%" || bad "volume+5 → $(cur gain.user)"
post /preview '{"volume":20}' >/dev/null; sleep 0.3; near "$(cur gain.user)" "$(dB 20)" && ok "/preview volume 20 → that item's source" || bad "preview → $(cur gain.user)"

echo "== timed playlist: interval 20 s + WaitForVideoEnd + AdvanceOnVideoEnd (2 s clips → advance on end)"
n0=$(handoffs)
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\",\"$C\"],\"settings\":{\"Order\":0}}" >/dev/null; sleep 9
nh=$(( $(handoffs) - n0 ))
[ $nh -ge 4 ] && [ $nh -le 7 ] && ok "advance-on-end rotated: $nh handoffs in 9 s" || bad "$nh handoffs in 9 s"
na=$(ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '[.events[] | select(.align=="end")] | length')
[ $na -ge 3 ] && ok "rotation uses align:end ($na aligned)" || bad "aligned switches: $na"

echo "== /next mid-wait → cancel the aligned one, switch now"
before=$(cur path); post /next '{}' >/dev/null; sleep 1.0
after=$(cur path); [ "$after" != "$before" ] && ok "/next switched ($(basename "$before") → $(basename "$after"))" || bad "/next stayed on $(basename "$before")"
sleep 3; nh2=$(handoffs); sleep 2.5
[ $(handoffs) -gt $nh2 ] && ok "rotation continues after /next" || bad "rotation stalled after /next"

echo "== /stop"
post /stop '{}' >/dev/null; sleep 0.6
[ -z "$(cur path | grep -v null)" ] && ok "/stop → nothing on screen" || bad "/stop left $(cur path)"
curl -sf -m 5 "$U/current" | jq -e '.playing == false' >/dev/null && ok "/current playing=false" || bad "/current after stop $(curl -sf -m 5 "$U/current")"
nh4=$(handoffs); sleep 3
[ $(handoffs) -eq $nh4 ] && ok "no switches after /stop" || bad "switched after /stop"

echo "== per-item overrides (R61): the item's own source, incl. an in-flight transition's pending B"
setting '.Volume = 100 | .Speed = 1'
LD=$(post /library/import "{\"path\":\"$D\",\"title\":\"dee\"}" | jq -r .videoPath)
LB=$(post /library/import "{\"path\":\"$Bc\",\"title\":\"bee\"}" | jq -r .videoPath)
[ -f "$LD" ] && [ -f "$LB" ] && ok "imported 2 clips into the temp library" || bad "import: $LD $LB"
post /apply "{\"path\":\"$LD\"}" >/dev/null; sleep 1.2
post /library/volume "{\"path\":\"$LD\",\"intValue\":30}" >/dev/null; sleep 0.3
near "$(cur gain.user)" "$(dB 30)" && ok "/library/volume 30 on the playing item" || bad "override vol → $(cur gain.user)"
post /library/speed "{\"path\":\"$LD\",\"doubleValue\":1.25}" >/dev/null; sleep 0.3
near "$(cur speed)" 1.25 && ok "/library/speed 1.25 on the playing item" || bad "override speed → $(cur speed)"
post /library/volume "{\"path\":\"$LB\",\"intValue\":40}" >/dev/null
TB=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$LB\",\"loop\":true,\"gain.user\":0},\"align\":\"end\"}" | jq -r .to)
sleep 0.3
setting '.Volume = 70'; sleep 0.4
gD=$(cur gain.user); gB=$(ctl get "{\"path\":\"$TB.gain.user\"}" | jq -r .value)
near "$gD" "$(dB 30)" && ok "global Volume 70 keeps the playing item's override 30 (gain $gD)" || bad "playing item → $gD"
near "$gB" "$(dB 40)" && ok "pending B ($TB) got ITS override 40 (gain $gB)" || bad "pending B → $gB"

echo "== pause during an in-flight transition (R75 final: ONE set player.paused freezes A and the pending B ($TB))"
# $TB is still SCHEDULED (align:end, waiting for a 10 s clip to reach its end) — the recipe holds a
# scheduled/pending B at frame 0 (its own `paused`, nothing to do with player.paused) regardless of our
# toggle, same as before R75; it only comes off hold at its own handoff. So A is the one that proves the
# toggle (it's genuinely playing, not recipe-held) — B's effective_paused must stay true continuously,
# proving the hold survives an unrelated player.paused flip rather than fighting it (player-core.md §
# Graph & properties "Player node paused": a recipe-held source's own `paused` is never touched by the
# override, so a resume doesn't un-pause what the RECIPE is deliberately holding).
TA=$(srcIdForPath "$LD")
post /pause '{}' >/dev/null; sleep 0.4
pp=$(playerPaused); pa=$(srcPaused "$TA"); pb=$(srcPaused "$TB")
[ "$pp" = true ] && [ "$pa" = true ] && [ "$pb" = true ] && ok "/pause → player.paused, A ($TA) and pending B ($TB) both effective_paused" || bad "pause: player=$pp A=$pa B=$pb"
post /pause '{}' >/dev/null; sleep 0.4
pp=$(playerPaused); pa=$(srcPaused "$TA"); pb=$(srcPaused "$TB")
[ "$pp" = false ] && [ "$pa" = false ] && [ "$pb" = true ] && ok "/pause again → player+A unpaused, B stays held (unaffected, still scheduled)" || bad "unpause: player=$pp A=$pa B=$pb"
post /library/volume "{\"path\":\"$LD\",\"intValue\":null}" >/dev/null; sleep 0.3
near "$(cur gain.user)" "$(dB 70)" && ok "clearing the override → global 70" || bad "cleared → $(cur gain.user)"

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
setting '.Volume = 50'; sleep 0.4
near "$(cur gain.user)" -18.0618 && ok "after SIGCONT: /settings Volume 50 applies again" || bad "after SIGCONT → $(cur gain.user)"
[ "$(playerPaused)" = false ] || post /pause '{}' >/dev/null   # the /pause sent while stopped was dropped (breaker) — normalize
post /stop '{}' >/dev/null; sleep 0.6

echo "== supervised restart (kill -9 the COMPOSITOR, never the supervisor): the backend reconnects"
echo "== R81: the backend's current settings survive it (OnRestarted re-applies them)"
post /apply "{\"path\":\"$A\"}" >/dev/null; sleep 1.2
setting '.Volume = 37'; sleep 0.3
near "$(cur gain.user)" "$(dB 37)" && ok "Volume 37 before the kill" || bad "pre-kill volume → $(cur gain.user)"
# Killing $SP outright would tear down the WHOLE supervisor+child tree (PR_SET_PDEATHSIG) — no restart
# at all. The real crash-recovery path is SIGKILLing the COMPOSITOR while its supervisor ($SP) lives:
# the supervisor restarts it (--restore) with a NEW hello.pid, same hello.supervisor_pid, in ~150-260 ms.
oldCP=$CP; kill -9 "$CP"
for _ in $(seq 1 30); do CP=$(comp_pid); [ -n "$CP" ] && [ "$CP" != "$oldCP" ] && break; sleep 0.05; done
[ -n "$CP" ] && [ "$CP" != "$oldCP" ] && ok "compositor restarted: $oldCP -> $CP within 1.5 s" || bad "no new hello.pid within 1.5 s after killing $oldCP"
[ "$(sup_pid)" = "$SP" ] && ok "same supervisor $SP after the restart" || bad "supervisor_pid $(sup_pid) != $SP after restart"
kill -0 "$SP" 2>/dev/null && ok "supervisor $SP never died" || bad "supervisor $SP is gone — it should have survived its child's crash"
sleep 0.6   # give the adapter's queued OnRestarted reapply a moment to run
near "$(cur gain.user)" "$(dB 37)" && ok "R81: gain.user still 37% ($(cur gain.user)) after the supervised restart" || bad "R81: gain.user $(cur gain.user) after restart, want $(dB 37)"
grep -q "re-applied effective settings" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null && ok "R81: adapter log shows a reapply after the restart" || bad "R81: no reapply log line found"
n0=$(handoffs)   # the temp state dir's event log spans both the old and the restarted compositor
post /playlist/play "{\"paths\":[\"$A\",\"$Bc\"],\"settings\":{\"Order\":0}}" >/dev/null; sleep 6
nh=$(( $(handoffs) - n0 ))
gaps=$(ctl logs '{"kind_prefix":"transition.handoff","limit":10000}' | jq -c --argjson n "$n0" '[.events[$n:] | map(.t_mono_ms) | . as $t | range(1; length) | ($t[.] - $t[.-1] | floor)]')
echo "     handoff gaps (ms): $gaps"
[ $nh -ge 2 ] && [ $nh -le 5 ] && ok "rotation runs on the new player ($nh handoffs in 6 s)" || bad "after restart: $nh handoffs in 6 s"
echo "$gaps" | jq -e '.[1:] | all(. >= 1200)' >/dev/null && ok "no switch storm after the restart (aligned gaps ≥ 1.2 s)" || bad "storm: gaps $gaps"
post /stop '{}' >/dev/null; sleep 0.6

echo "== I3: a keybind's toggle-pause (a separate one-shot CLI process) survives a compositor restart"
post /apply "{\"path\":\"$A\"}" >/dev/null; sleep 1.0
[ "$(playerPaused)" = false ] && ok "a new session (/apply) plays" || bad "/apply left player.paused $(playerPaused)"
"$DOTNET" "$DLL" --action=toggle-pause > "$T/cli1.log" 2>&1
[ "$(playerPaused)" = true ] && ok "CLI --action=toggle-pause → player.paused" || bad "CLI toggle → $(playerPaused)"
sleep 0.6   # the player's snapshot (which carries player.paused) is written 250 ms after a change
oldCP=$CP; kill -9 "$CP"
for _ in $(seq 1 30); do CP=$(comp_pid); [ -n "$CP" ] && [ "$CP" != "$oldCP" ] && break; sleep 0.05; done
sleep 1.0   # the backend's OnRestarted reapply runs meanwhile
[ "$(playerPaused)" = true ] && ok "pause survived the restart + the backend's reapply (not flipped)" || bad "after restart: player.paused $(playerPaused)"
"$DOTNET" "$DLL" --action=toggle-pause > "$T/cli2.log" 2>&1
[ "$(playerPaused)" = false ] && ok "a second CLI toggle resumes" || bad "second CLI toggle → $(playerPaused)"

echo "== I1: pause → /stop → /apply: the new session plays (legacy semantics)"
post /pause '{}' >/dev/null; sleep 0.3
post /stop '{}' >/dev/null; sleep 0.6
[ "$(playerPaused)" = false ] && ok "/stop cleared player.paused" || bad "after /stop: player.paused $(playerPaused)"
post /apply "{\"path\":\"$Bc\"}" >/dev/null; sleep 1.2
tb=$(srcIdForPath "$Bc")
[ "$(cur path)" = "$Bc" ] && [ "$(srcPaused "$tb")" = false ] && ok "/apply after pause+stop plays b ($tb)" || bad "/apply after stop: cur $(cur path) effective_paused $(srcPaused "$tb")"
post /pause '{}' >/dev/null; sleep 0.3
post /apply "{\"path\":\"$A\"}" >/dev/null; sleep 1.2
[ "$(playerPaused)" = false ] && [ "$(cur path)" = "$A" ] && ok "pause → /apply (no stop): the new session plays" || bad "pause → /apply: player.paused $(playerPaused), cur $(cur path)"
post /stop '{}' >/dev/null; sleep 0.6

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
ctl headless.add_output '{"name":"VIRTUAL-3","width":640,"height":360,"hz":60}' >/dev/null; sleep 0.5
[ "$(ctl get '{"path":"lay:VIRTUAL-3:main.content"}' | jq -r .value)" = "$last" ] && ok "replug shows the last target" || bad "replug shows $(ctl get '{"path":"lay:VIRTUAL-3:main.content"}' | jq -r .value)"
sleep 5
[ $(handoffs) -gt $nh0 ] && ok "rotation resumes after the replug" || bad "rotation stalled after the replug"
post /stop '{}' >/dev/null; sleep 0.6
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

post /apply "{\"path\":\"$SV1\"}" >/dev/null; sleep 1.2
[ "$(cur path)" = "$SV1" ] && ok "/apply sv1 (library/single-wallpaper mode) → cur sv1" || bad "/apply sv1 → cur $(cur path)"

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
post /stop '{}' >/dev/null; sleep 0.6

echo "== play-from keeps the playlist's transition settings (it used to rebuild them from rotation fields only)"
pf=$(jq -nc --arg a "$SV1" --arg b "$SV2" '{paths:[$a,$b], startIndex:1, settings:{order:1, overrideGlobalSettings:true,
  intervalSeconds:20, advanceOnVideoEnd:true, waitForVideoEnd:true, transitionEnabled:true,
  transitionEffectIds:["fade","wipeLeft"], transitionDurationMs:1234, transitionDurationMaxMs:0, transitionShuffle:false}}')
post /playlist/play-from "$pf" >/dev/null; sleep 1
st=$(curl -sf -m 5 "$U/playlist/state")
echo "$st" | jq -e '.settings.transitionEnabled == true and .settings.transitionDurationMs == 1234 and (.settings.transitionEffectIds == ["fade","wipeLeft"]) and .settings.transitionShuffle == false' >/dev/null \
  && ok "play-from kept transitionEnabled/effects/duration/shuffle in the current playlist state" \
  || bad "play-from dropped transition settings: $(echo "$st" | jq -c '.settings | {transitionEnabled, transitionEffectIds, transitionDurationMs, transitionShuffle}')"
echo "$st" | jq -e '.settings.order == 1' >/dev/null && ok "play-from kept the playlist's own order (shuffle) in the saved state" \
  || bad "play-from overwrote the saved order: $(echo "$st" | jq -c '.settings.order')"
post /stop '{}' >/dev/null; sleep 0.6

# An aligned (wait-for-video-end) switch is bounded by the adapter at A's remaining time + slack, read
# when it was armed. A's real remaining time moves with its CURRENT speed and stands still while the
# player is paused (the player re-derives its own align deadline for both) — a fixed bound gave up
# early: cancel + switch now, cutting A long before its end (and switching while paused).
aligned_corr() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq -r --arg p "$1" '[.events[] | select(.align=="end" and .path==$p)][-1].corr // empty'; }
corr_has() { ctl logs "{\"corr\":\"$1\",\"kind_prefix\":\"transition.$2\"}" | jq '.events|length'; }
nsched() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '.events|length'; }
backstops() { grep -c "not handed off within" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null || true; }

echo "== aligned wait survives a speed drop (the backstop follows A's current speed)"
setting '.Speed = 4'
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
ac=""; for _ in $(seq 1 60); do ac=$(aligned_corr "$E2"); [ -n "$ac" ] && break; sleep 0.1; done
bs0=$(backstops); ns0=$(nsched)
setting '.Speed = 0.5'   # E1 now needs ~20 s more; the armed bound was ~3 s + slack
sleep 9
[ -n "$ac" ] && [ "$(corr_has "$ac" cancelled)" = 0 ] && [ "$(corr_has "$ac" handoff)" = 0 ] && [ "$(nsched)" = "$ns0" ] \
  && ok "aligned switch $ac still waiting 9 s after a 4x → 0.5x drop (no cancel, no new switch)" \
  || bad "speed drop: corr=$ac cancelled=$(corr_has "$ac" cancelled) handoff=$(corr_has "$ac" handoff) new switches=$(( $(nsched) - ns0 ))"
[ "$(cur path)" = "$E1" ] && ok "E1 still on screen (not cut before its end)" || bad "speed drop: cur $(basename "$(cur path)") — E1 was cut early"
[ "$(backstops)" = "$bs0" ] && ok "no adapter backstop fired" || bad "the adapter backstop fired: $(grep "not handed off within" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" | tail -1)"
setting '.Speed = 4'
for _ in $(seq 1 80); do [ "$(corr_has "$ac" handoff)" = 1 ] && break; sleep 0.1; done
[ "$(corr_has "$ac" handoff)" = 1 ] && [ "$(cur path)" = "$E2" ] && ok "back at 4x: the same aligned switch handed off at E1's end" || bad "after 4x: handoff=$(corr_has "$ac" handoff) cur $(basename "$(cur path)")"
post /stop '{}' >/dev/null; sleep 0.6; setting '.Speed = 1'

echo "== aligned wait survives a long pause (no switch while paused, resumes at A's end)"
post /playlist/play "{\"paths\":[\"$P1\",\"$P2\"],\"settings\":{\"Order\":0}}" >/dev/null
ac=""; for _ in $(seq 1 60); do ac=$(aligned_corr "$P2"); [ -n "$ac" ] && break; sleep 0.1; done
post /pause '{}' >/dev/null
bs0=$(backstops); ns0=$(nsched)
sleep 8   # > P1's remaining (< 4 s) + slack
[ "$(playerPaused)" = true ] && [ -n "$ac" ] && [ "$(corr_has "$ac" cancelled)" = 0 ] && [ "$(nsched)" = "$ns0" ] && [ "$(cur path)" = "$P1" ] \
  && ok "8 s paused: aligned switch $ac still waiting, P1 on screen, no new switch" \
  || bad "long pause: paused=$(playerPaused) corr=$ac cancelled=$(corr_has "$ac" cancelled) new switches=$(( $(nsched) - ns0 )) cur $(basename "$(cur path)")"
[ "$(backstops)" = "$bs0" ] && ok "no adapter backstop fired while paused" || bad "the adapter backstop fired while paused: $(grep "not handed off within" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" | tail -1)"
post /pause '{}' >/dev/null
for _ in $(seq 1 80); do [ "$(corr_has "$ac" handoff)" = 1 ] && break; sleep 0.1; done
[ "$(corr_has "$ac" handoff)" = 1 ] && [ "$(cur path)" = "$P2" ] && ok "resumed: the same aligned switch handed off at P1's end" || bad "after resume: handoff=$(corr_has "$ac" handoff) cur $(basename "$(cur path)")"
post /stop '{}' >/dev/null; sleep 0.6

echo "== /preview mid-transition reaches the edited item's source only (never the other side)"
# The per-wallpaper modal drag-previews through /preview. Mid-effect `cur:*` is the INCOMING side, so a
# drag on the outgoing A used to land on B (and stay there: the persist that follows targets A by path).
post /apply "{\"path\":\"$E1\"}" >/dev/null; sleep 1.2
TBp=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$E2\",\"loop\":true,\"gain.user\":0,\"speed\":1},\"effect_id\":\"fade\",\"duration_ms\":8000,\"align\":\"now\"}" | jq -r .to)
TAp=$(srcIdForPath "$E1"); sleep 0.8
sv() { ctl get "{\"path\":\"$1.$2\"}" | jq -r .value; }
[ "$(ctl state | jq -r '.transitions[0].phase // empty')" = running ] && ok "fade $TAp → $TBp running" || bad "transition not running: $(ctl state | jq -c .transitions)"
post /preview "{\"volume\":20,\"speed\":1.5,\"paths\":[\"$E1\"]}" >/dev/null; sleep 0.4
near "$(sv "$TAp" gain.user)" "$(dB 20)" && near "$(sv "$TAp" speed)" 1.5 && ok "A's drag moved A ($TAp: $(sv "$TAp" gain.user) dB, $(sv "$TAp" speed)x)" || bad "A's drag: A at $(sv "$TAp" gain.user) dB $(sv "$TAp" speed)x"
near "$(sv "$TBp" gain.user)" 0 && near "$(sv "$TBp" speed)" 1 && ok "…and left B alone ($TBp: $(sv "$TBp" gain.user) dB, $(sv "$TBp" speed)x)" || bad "A's drag leaked into B: $(sv "$TBp" gain.user) dB $(sv "$TBp" speed)x"
post /preview "{\"volume\":40,\"paths\":[\"$E2\"]}" >/dev/null; sleep 0.4
near "$(sv "$TBp" gain.user)" "$(dB 40)" && near "$(sv "$TAp" gain.user)" "$(dB 20)" && ok "B's drag moved B only" || bad "B's drag: A $(sv "$TAp" gain.user) B $(sv "$TBp" gain.user)"
post /stop '{}' >/dev/null; sleep 0.6

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
sleep 0.5
grep -q " 101 " "$T/ws.log" && ok "a WebSocket client holds the backend open (like the UI)" || bad "WebSocket upgrade: $(cat "$T/ws.log")"
storms() { grep -c "→ switching in" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null || true; }
# the play's own switch has handed off and only the next aligned one is armed (a baseline to count from)
nows() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '[.events[] | select(.align=="now")] | length'; }
st0=$(storms); nw0=$(nows); h0=$(handoffs); port0=$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")
kill -TERM "$BP"; BP_OLD="${BP_OLD:-} $BP"; OLD1=$BP; sleep 1.5
"$DOTNET" "$DLL" --serve > "$T/backend2.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ "$(cat "$XDG_CONFIG_HOME/livepaper/serve.port" 2>/dev/null)" != "$port0" ] && break; sleep 0.1; done
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
kill -0 "$OLD1" 2>/dev/null && ok "the old backend is still shutting down (WebSocket open) while the new one runs" || echo "  note the old backend already exited — the overlap this tests didn't happen"
sleep 16   # E1 (12 s) ends inside this window → exactly one aligned advance
[ "$(storms)" = "$st0" ] && ok "no switch storm across the restart" || bad "switch storm: $(( $(storms) - st0 )) failed/superseded aligned switches — $(grep "→ switching in" "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" | tail -3 | tr '\n' ' ')"
[ "$(nows)" = "$nw0" ] && ok "no immediate (align:now) switch during the handover" || bad "$(( $(nows) - nw0 )) align:now switches during the handover"
dh=$(( $(handoffs) - h0 )); [ "$dh" = 1 ] && [ "$(cur path)" = "$E2" ] && ok "one advance at E1's end, E2 on screen" || bad "$dh handoffs, cur $(basename "$(cur path)")"
[ "$(cat "$XDG_CONFIG_HOME/livepaper/gui_timer.pid" 2>/dev/null)" = "$BP" ] && ok "the new backend owns the timer (gui_timer.pid)" || bad "gui_timer.pid = $(cat "$XDG_CONFIG_HOME/livepaper/gui_timer.pid" 2>/dev/null) (new backend $BP)"
tp=$(cat "$XDG_CONFIG_HOME/livepaper/timer.pid" 2>/dev/null); { [ -z "$tp" ] || ! kill -0 "$tp" 2>/dev/null; } && ok "no --timer-daemon left running" || bad "a --timer-daemon (pid $tp) runs next to the new backend"
kill "$WSP" 2>/dev/null; WSP=""
for _ in $(seq 1 50); do kill -0 "$OLD1" 2>/dev/null || break; sleep 0.1; done
post /stop '{}' >/dev/null; sleep 0.6

echo "== a second backend started while the first runs takes the playlist over (the first stops ticking)"
post /playlist/play "{\"paths\":[\"$E1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
armed_only
st0=$(storms); nw0=$(nows); h0=$(handoffs); port0=$(cat "$XDG_CONFIG_HOME/livepaper/serve.port"); first=$BP
"$DOTNET" "$DLL" --serve > "$T/backend3.log" 2>&1 & BP=$!; BP_OLD="$BP_OLD $first"
for _ in $(seq 1 150); do [ "$(cat "$XDG_CONFIG_HOME/livepaper/serve.port" 2>/dev/null)" != "$port0" ] && break; sleep 0.1; done
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
sleep 16
[ "$(storms)" = "$st0" ] && [ "$(nows)" = "$nw0" ] && ok "two live backends: no storm, no immediate switch" || bad "two live backends: $(( $(storms) - st0 )) failed aligned switches, $(( $(nows) - nw0 )) align:now"
dh=$(( $(handoffs) - h0 )); [ "$dh" = 1 ] && [ "$(cur path)" = "$E2" ] && ok "one advance at E1's end" || bad "$dh handoffs, cur $(basename "$(cur path)")"
grep -q "stops ticking" "$T/backend2.log" && ok "the first backend yielded: $(grep -m1 "stops ticking" "$T/backend2.log")" || bad "the first backend never yielded the timer"
kill "$first" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$first" 2>/dev/null || break; sleep 0.1; done
post /stop '{}' >/dev/null; sleep 0.6

echo "== a rebuilt player binary: the backend restarts the player onto it, keeping what it shows"
# The player outlives the backend on purpose, so a rebuild/reinstall never reached a running one: fixes
# "persisted" for hours. Here: a new file at the backend's binary path (cp + mv = a new inode, like cargo/nix).
rebuild() { cp "$B" "$T/bin/lp-player.new" && mv -f "$T/bin/lp-player.new" "$T/bin/lp-player"; }
post /apply "{\"path\":\"$D\"}" >/dev/null; sleep 1.5
post /pause '{}' >/dev/null; sleep 0.3
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
post /stop '{}' >/dev/null; sleep 0.6

echo "== …never across an armed end-of-video switch: an advance-on-end playlist upgrades at its next switch"
post /playlist/play "{\"paths\":[\"$L1\",\"$E2\"],\"settings\":{\"Order\":0}}" >/dev/null
for _ in $(seq 1 60); do [ -n "$(aligned_corr "$E2")" ] && break; sleep 0.1; done
CP0=$(comp_pid); st0=$(storms); nw0=$(nows)
rebuild
for _ in $(seq 1 250); do python3 -c "import sys; sys.exit(0 if float('$(cur time_pos)') >= 18.6 else 1)" 2>/dev/null && break; sleep 0.1; done
[ "$(comp_pid)" = "$CP0" ] && [ "$(cur path)" = "$L1" ] && [ "$(nows)" = "$nw0" ] && ok "armed for L1's end: not upgraded (L1 at $(cur time_pos) s, stale > 15 s)" || bad "upgraded or switched while armed: compositor $CP0 → $(comp_pid), cur $(basename "$(cur path)")"
for _ in $(seq 1 80); do c=$(comp_pid); [ -n "$c" ] && [ "$c" != "$CP0" ] && break; sleep 0.1; done
CP=$(comp_pid); SP=$(sup_pid)
[ -n "$CP" ] && [ "$CP" != "$CP0" ] && [ "$(cur path)" = "$E2" ] && ok "upgraded at the switch: E2 on screen, compositor $CP0 → $CP" || bad "after L1's end: compositor $CP0 → $CP, cur $(basename "$(cur path)")"
for _ in $(seq 1 40); do [ -n "$(aligned_corr "$L1")" ] && break; sleep 0.1; done
[ -n "$(aligned_corr "$L1")" ] && [ "$(storms)" = "$st0" ] && [ "$(nows)" = 0 ] && ok "the next end-of-video switch is armed on the new player, no storm" || bad "after the upgrade: armed=$(aligned_corr "$L1") storms=$(( $(storms) - st0 )) now-switches=$(nows)"
post /stop '{}' >/dev/null; sleep 0.6

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
