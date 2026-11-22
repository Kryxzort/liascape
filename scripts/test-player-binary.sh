#!/usr/bin/env bash
# Hermetic test of liascape-player as the only engine (docs/decisions.md § "Make liascape-player the only engine, no
# fallback"): what the backend does with an old settings file, a missing player binary, one that appears later, and a
# stub that never plays.
#  a legacy settings file: `"PlayerEngine":"legacy"` and legacy keys are ignored — /player-engine has no engine / active;
#          a legacy wallpaper this session left running (a fake mpvpaper and linux-wallpaperengine with this run's HOME)
#          is stopped at `serve` start and LastSession plays on the player instead, while one of another HOME is left
#          alone; an /apply plays on exactly one player (`serve` on this run's socket); the next save drops PlayerEngine and
#          RestartMpvpaperEverySeconds.
#  missing: no binary resolves → /player-engine says why, /apply answers non-2xx with that reason, /health/features
#          marks liascape-player missing.
#  appears later: the binary appears (a rebuild, a store path after boot) → the next /apply plays, no backend restart.
#  stub never plays: LIASCAPE_PLAYER_BIN at an `exit 1` stub (what the other hermetic suites use to keep a player
#          away) → an /apply tries it and no real `liascape-player serve` ever runs.
# The player is the repo's debug build behind a wrapProgram-style wrapper that adds `--headless --outputs 640x360@60
# --clock real --ao null` to the `serve` the backend starts (no Wayland, no audio server). Runs in its own user, network,
# mount and PID namespaces (`unshare -rnpf --mount-proc`): every process scan sees only this run, and everything dies
# with the namespace. Temp HOME + XDG dirs, its own player socket; never touches ~/.config/liascape, the session's
# player or its wallpaper. Never prints settings.json or a token.
#
# Usage: scripts/test-player-binary.sh [--no-build]   LIASCAPE_PB_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), cargo (unless --no-build), unshare + ip (iproute2), ffmpeg, curl, jq, timeout.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_PB_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip ffmpeg curl jq timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  B=$ROOT/src/player/target/debug/liascape-player
  DLL=${LIASCAPE_PB_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ]; then
    if command -v nix >/dev/null; then
      (cd "$ROOT" && env -u LD_LIBRARY_PATH nix develop -c cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
    else
      (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
    fi
    if [ -z "${LIASCAPE_PB_DLL:-}" ]; then
      "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
      [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
    fi
  fi
  [ -x "$B" ] && [ -f "$DLL" ] || { echo "not built: $B / $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-pb-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-pb- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_PB_T=$T LIASCAPE_PB_BIN=$B
  # PID 1 of the new namespace is this script: when it exits, the kernel kills every process left in it
  timeout -k 10 300 unshare -rnpf --mount-proc bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_PB_T
B=$LIASCAPE_PB_BIN
DLL=$T/backend/liascape-backend.dll
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT PULSE_SERVER
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st" "$T/bin" "$T/media"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export LIASCAPE_PLAYER_SOCKET=$XDG_RUNTIME_DIR/liascape-player.sock
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions
# no liascape-player on PATH: § missing must find none anywhere
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | while read -r d; do [ -n "$d" ] && [ ! -e "$d/liascape-player" ] && printf '%s:' "$d"; done)
export PATH=${PATH%:}
SJ=$XDG_CONFIG_HOME/liascape/settings.json
LOG=$T/backend.log
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }

# the debug player behind a wrapProgram-style wrapper ($1 = its name in $T/bin): the backend's `serve` gets the headless
# arguments; the resolver's RunsFile finds `.<name>-wrapped`, so the upgrade check sees the real build
wrap_player() {
  ln -sf "$B" "$T/bin/.$1-wrapped"
  cat > "$T/bin/$1.tmp" <<EOF
#!/bin/sh
real="\$(dirname "\$0")/.\$(basename "\$0")-wrapped"
[ "\$1" = serve ] && { shift; exec "\$real" serve --headless --outputs 640x360@60 --clock real --ao null "\$@"; }
exec "\$real" "\$@"
EOF
  chmod +x "$T/bin/$1.tmp"; mv "$T/bin/$1.tmp" "$T/bin/$1"
}
wrap_player liascape-player
# the stub the other hermetic suites point LIASCAPE_PLAYER_BIN at: logs each call, never plays
printf '#!/bin/sh\necho "$*" >> "%s/stub-calls.txt"\nexit 1\n' "$T" > "$T/bin/stub"; chmod +x "$T/bin/stub"

V1=$T/media/v1.mp4; V2=$T/media/v2.mp4
for v in "$V1:testsrc2" "$V2:smptebars"; do
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "${v#*:}=size=320x180:rate=30" -t 20 -c:v libx264 -pix_fmt yuv420p "${v%%:*}" \
    || { echo "ABORT: ffmpeg couldn't make a fixture"; exit 2; }
done

BP=""
startbe() {
  rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
  (cd /tmp && exec "$DOTNET" "$DLL" serve >> "$LOG" 2>&1) & BP=$!
  for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
  U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
  TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
  for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
}
# this namespace's liascape-player processes (by their executable: the wrapper execs the real one), one pid a line
players() { local p; for p in /proc/[0-9]*; do [ "$(basename "$(readlink "$p/exe" 2>/dev/null)")" = liascape-player ] && basename "$p"; done; }
stopbe() {
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  BP=""
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1
  for _ in $(seq 1 50); do [ -z "$(players)" ] && break; sleep 0.1; done
  for p in $(players); do kill -9 "$p" 2>/dev/null; done
  return 0
}
trap 'stopbe' EXIT
trap 'exit 130' INT TERM HUP
api() { curl -s -m 10 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
current() { api "$U/current" | jq -r '.path // "null"'; }
waitcur() { local want=$1 n=$2; for _ in $(seq 1 "$n"); do [ "$(current)" = "$want" ] && return 0; sleep 0.1; done; return 1; }
# processes named $1 (argv[0] or the executable) whose environment has HOME=$2, one pid a line
named_with_home() {
  local p a0 ex
  for p in /proc/[0-9]*; do
    a0=$(tr '\0' '\n' < "$p/cmdline" 2>/dev/null | head -1); ex=$(readlink "$p/exe" 2>/dev/null)
    [ "$(basename "$a0")" = "$1" ] || [ "$(basename "$ex")" = "$1" ] || continue
    tr '\0' '\n' < "$p/environ" 2>/dev/null | grep -qx "HOME=$2" && basename "$p"
  done
}

echo "== a legacy settings file: the old engine's keys are ignored, its wallpaper gives way to the player"
cat > "$SJ" <<'EOF'
{"PlayerEngine":"legacy","RestartMpvpaperEverySeconds":600,"SceneMonitors":[{"name":"X-1","fps":30,"isPrimary":true}]}
EOF
jq --arg v "$V1" '. + {NoAudio: true, AutoMute: false, LastSession: {Paths: [$v]}}' "$SJ" > "$SJ.tmp" && mv "$SJ.tmp" "$SJ"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
# a legacy session of this HOME still on screen, and another HOME's mpvpaper (another user session's: never ours to stop)
# (a shell under that name: coreutils' multi-call binary won't run as `mpvpaper`; the loop keeps it from exec'ing sleep)
fake() { exec -a "$1" bash -c 'while :; do sleep 1; done'; }
(fake mpvpaper) & MP_OURS=$!
(fake linux-wallpaperengine) & LWE_OURS=$!
(export HOME=$T/other-home; fake mpvpaper) & MP_OTHER=$!
disown $MP_OURS $LWE_OURS $MP_OTHER   # their kills below are the point: no job notices
sleep 0.3
[ "$(named_with_home mpvpaper "$HOME")" = "$MP_OURS" ] && [ "$(named_with_home mpvpaper "$T/other-home")" = "$MP_OTHER" ] \
  || bad "precondition: the fake mpvpapers aren't what this run sees ($(named_with_home mpvpaper "$HOME") / $(named_with_home mpvpaper "$T/other-home")) — this proved nothing"
startbe
pe=$(api "$U/player-engine")
[ "$(jq -c '[has("engine"), has("active"), .available]' <<<"$pe")" = '[false,false,true]' ] \
  && ok "/player-engine: no engine / active, the player available" || bad "/player-engine: $(jq -c '{engine, active, available, reason}' <<<"$pe")"
for _ in $(seq 1 50); do kill -0 "$MP_OURS" 2>/dev/null || kill -0 "$LWE_OURS" 2>/dev/null || break; sleep 0.1; done
! kill -0 "$MP_OURS" 2>/dev/null && ! kill -0 "$LWE_OURS" 2>/dev/null \
  && ok "serve start stopped this session's legacy wallpaper (mpvpaper, linux-wallpaperengine)" \
  || bad "a legacy wallpaper of this HOME still runs after serve start: mpvpaper $(kill -0 "$MP_OURS" 2>/dev/null && echo alive || echo gone), LWE $(kill -0 "$LWE_OURS" 2>/dev/null && echo alive || echo gone)"
kill -0 "$MP_OTHER" 2>/dev/null && ok "…another HOME's mpvpaper is left alone" || bad "serve start killed another HOME's mpvpaper"
waitcur "$V1" 300 && ok "…and the last session (v1.mp4) plays on liascape-player in its place" || bad "the last session didn't come back on the player: /current $(current)"
code=$(api -o "$T/apply.txt" -w '%{http_code}' -X POST "$U/apply" -d "{\"path\":\"$V2\"}")
waitcur "$V2" 150 && [ "$code" = 200 ] && ok "/apply v2.mp4 → 200, /current names it" || bad "/apply v2.mp4: HTTP $code $(cat "$T/apply.txt"), /current $(current)"
hello=$("$B" ctl --timeout-ms 2000 hello 2>/dev/null)
want=$(jq -r 'select(.pid and .supervisor_pid) | [.supervisor_pid, .pid] | map(tostring) | sort | join(" ")' <<<"$hello" 2>/dev/null)
got=$(players | sort | tr '\n' ' ' | sed 's/ $//')
[ -n "$want" ] && [ "$got" = "$want" ] && [ -S "$LIASCAPE_PLAYER_SOCKET" ] \
  && ok "exactly one player: its supervisor + compositor ($got) on this run's socket" || bad "player processes: [$got], the socket's player: [$want]"
[ -z "$(named_with_home mpvpaper "$HOME")" ] && ok "no mpvpaper with this run's HOME" || bad "mpvpaper with this run's HOME: $(named_with_home mpvpaper "$HOME")"
api -o /dev/null -X POST "$U/settings" -d '{"Volume":70}'
[ "$(jq -c '[has("PlayerEngine"), has("RestartMpvpaperEverySeconds"), .Volume]' "$SJ")" = '[false,false,70]' ] && ok "one /settings save → no PlayerEngine / RestartMpvpaperEverySeconds key in settings.json" \
  || bad "after a save: PlayerEngine key $(jq -c 'has("PlayerEngine")' "$SJ"), RestartMpvpaperEverySeconds key $(jq -c 'has("RestartMpvpaperEverySeconds")' "$SJ"), Volume $(jq -c .Volume "$SJ")"
stopbe
kill "$MP_OTHER" 2>/dev/null

echo "== missing: no player binary anywhere"
export LIASCAPE_PLAYER_BIN=$T/bin/absent
startbe
pe=$(api "$U/player-engine")
[ "$(jq -r .available <<<"$pe")" = false ] && jq -r '.reason // ""' <<<"$pe" | grep -q "liascape-player binary not found" \
  && ok "/player-engine: unavailable, the reason says the binary isn't found" || bad "/player-engine: $(jq -c '{available, reason}' <<<"$pe")"
code=$(api -o "$T/apply.txt" -w '%{http_code}' -X POST "$U/apply" -d "{\"path\":\"$V1\"}")
case "$code" in 2??) bad "/apply without a binary → HTTP $code (a silent black screen)" ;;
  *) grep -q "liascape-player binary not found" "$T/apply.txt" && ok "/apply → HTTP $code with the reason" || bad "/apply → HTTP $code without the reason: $(head -c 300 "$T/apply.txt")" ;; esac
[ -z "$(players)" ] && ok "…and no player runs" || bad "a player runs without a binary: $(players | tr '\n' ' ')"
hf=$(api "$U/health/features" | jq -c '.features[] | select(.id == "liascape-player") | [.ok, .inUse, (.reason // "" | test("binary not found"))]')
[ "$hf" = '[false,true,true]' ] && ok "/health/features: liascape-player missing, in use, with the reason" || bad "/health/features liascape-player: $hf"

echo "== appears later: the binary turns up, the next /apply plays (no backend restart)"
wrap_player absent
t0=$(date +%s%3N)
code=$(api -o "$T/apply.txt" -w '%{http_code}' -X POST "$U/apply" -d "{\"path\":\"$V1\"}")
if waitcur "$V1" 100; then ok "/apply → HTTP $code, v1.mp4 plays $(( $(date +%s%3N) - t0 )) ms after the binary appeared"
else bad "/apply after the binary appeared: HTTP $code $(head -c 300 "$T/apply.txt"), /current $(current) after 10 s"; fi
stopbe

echo "== the stub never plays: an /apply tries it, no real player runs"
export LIASCAPE_PLAYER_BIN=$T/bin/stub
startbe
code=$(api -o "$T/apply.txt" -w '%{http_code}' -X POST "$U/apply" -d "{\"path\":\"$V1\"}")
for _ in $(seq 1 50); do grep -q "^serve" "$T/stub-calls.txt" 2>/dev/null && break; sleep 0.1; done
sleep 1
grep -q "^serve" "$T/stub-calls.txt" 2>/dev/null || bad "the stub was never asked to serve (HTTP $code) — this proved nothing"
[ -z "$(players)" ] && [ "$(current)" = null ] && ok "the stub was started, no liascape-player serve ran, nothing plays" \
  || bad "with the stub: players [$(players | tr '\n' ' ')], /current $(current)"
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
