#!/usr/bin/env bash
# Hermetic test of `liascape-backend serve` stopping on SIGTERM (Web/ServerHost.cs § shutdown): a service manager (the
# dev stack's systemd unit, a session logout) gives it seconds before SIGKILL, and a SIGKILLed backend skips its
# ApplicationStopping hand-offs. Each state below gets SIGTERM and must exit within $BUDGET_MS, leave every state file
# parsable, and leave the player as it was (it outlives the backend on purpose: .claude/rules/backend/player-adapter.md):
#  idle · a WebSocket client on /events (an open app page; it must be sent a close frame, 1001) · a wallpaper playing in a
#  private headless liascape-player with a page connected · a /media download whose reader stopped reading (a paused
#  <video>) · the library's clip sweep encoding (its nice'd ffmpeg children stopped with it) · the backend in a systemd
#  unit (KillMode=control-group) that spawned the player itself: `systemctl stop` of that unit leaves the player playing,
#  and a second backend adopts it rather than starting another (Helpers/UserScope.cs).
# Runs in its own user, network, cgroup and mount namespaces (`unshare -rnCm`), a temp HOME + XDG dirs, its own backend,
# player socket and no audio server. The unit case runs a PRIVATE user manager (`systemd --user` on this run's
# XDG_RUNTIME_DIR, in a cgroup subtree of its own, only this test's units on its unit path); the session's user manager
# is never asked to start or stop anything. Without a cgroup of its own (the caller's cgroup isn't the user's to divide)
# that case is skipped, and says so. Never touches ~/.config/liascape, the real library or the owner's player;
# everything it started is stopped on exit.
#
# Usage: scripts/test-backend-stop.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
# Needs: dotnet (or DOTNET=…), the player's debug build (src/player/target/debug/liascape-player), unshare + ip
# (iproute2), ffmpeg, curl, jq, python3. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [ -z "${LIASCAPE_STOP_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip ffmpeg curl jq python3 timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  PB=$ROOT/src/player/target/debug/liascape-player
  [ -x "$PB" ] || { echo "not built: $PB (cargo build --manifest-path src/player/Cargo.toml)"; exit 2; }
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-stop-XXXXXX)   # short: a unix socket path must be < 108 bytes
  mkdir -p "$T/backend" "$T/bin"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  # a copy: a rebuild of the tree's player mid-run must not change the one under test
  cp "$PB" "$T/bin/liascape-player" || { echo "ABORT: can't copy the player"; exit 2; }
  # A cgroup subtree of our own (a child of the caller's, when the user owns it): the namespaced run mounts it as its
  # cgroup root, where the unit case's private user manager makes its slices and scopes.
  CG=""; cg0=$(sed -n 's/^0:://p' /proc/self/cgroup)
  [ -n "$cg0" ] && mkdir "/sys/fs/cgroup${cg0%/}/liascape-stop-$$" 2>/dev/null && CG=/sys/fs/cgroup${cg0%/}/liascape-stop-$$
  cg_procs() { [ -n "$CG" ] && [ -d "$CG" ] && find "$CG" -name cgroup.procs -exec cat {} + 2>/dev/null; }
  cleanup() {
    trap - EXIT INT TERM HUP
    if [ -n "$CG" ] && [ -d "$CG" ]; then   # whatever outlived the namespaced run (all of it started by this test)
      for p in $(cg_procs); do kill -TERM "$p" 2>/dev/null; done
      for _ in $(seq 1 50); do [ -z "$(cg_procs)" ] && break; sleep 0.1; done
      for p in $(cg_procs); do kill -9 "$p" 2>/dev/null; done
      for _ in $(seq 1 20); do [ -z "$(cg_procs)" ] && break; sleep 0.1; done
      find "$CG" -depth -type d -exec rmdir {} \; 2>/dev/null
    fi
    case "$T" in /tmp/liascape-stop-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_STOP_T=$T LIASCAPE_STOP_CG=${CG:+1}
  if [ -n "$CG" ]; then
    # moved into the subtree first, so the cgroup namespace's root is it
    bash -c 'echo $$ > "$1/cgroup.procs" && exec timeout -k 10 420 unshare -rnCm --propagation private bash -c \
      "ip link set lo up && mount -t cgroup2 none /sys/fs/cgroup && exec bash \"\$0\"" "$0"' "${BASH_SOURCE[0]}" "$CG"
  else
    timeout -k 10 420 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  fi
  exit $?
fi

T=$LIASCAPE_STOP_T
DLL=$T/backend/liascape-backend.dll
B=$T/bin/liascape-player
BUDGET_MS=3000
BP=""; WP=""; SP=""; MP=""; MGR=""
gentle() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done; kill -9 "$1" 2>/dev/null; }
teardown() {
  gentle "$WP"; gentle "$MP"; gentle "$BP"
  [ -n "$MGR" ] && for u in liascape-stop-be1.service liascape-stop-be2.service; do timeout 15 systemctl --user stop "$u" >/dev/null 2>&1; done
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1   # a clean quit ends the supervisor too
  gentle "$SP"
  [ -n "$MGR" ] && { kill -s RTMIN+24 "$MGR" 2>/dev/null; gentle "$MGR"; }   # RTMIN+24: a user manager exits at once
  for p in $(pgrep -f "ffmpeg .*$T/" 2>/dev/null); do gentle "$p"; done
}
trap teardown EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
unset PULSE_SINK PULSE_SOURCE PIPEWIRE_RUNTIME_DIR PIPEWIRE_REMOTE LIASCAPE_PLAYER_AUTOMUTE
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export PULSE_SERVER=unix:$H/rt/no-pulse LIASCAPE_PLAYER_BIN=$B LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

LIB=$XDG_DATA_HOME/liascape/library
mkdir -p "$LIB/imported" "$T/we"
IDX='{}'
for n in a b c d; do   # big enough that a High clip encode runs for seconds
  mkdir -p "$LIB/imported/$n"
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 60 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$LIB/imported/$n/$n.mp4" \
    || { echo "ABORT: ffmpeg can't make the fixtures"; exit 2; }
  IDX=$(jq -c --arg n "$n" '.[$n] = {title: $n}' <<< "$IDX")
done
printf '%s' "$IDX" > "$LIB/imported/index.json"
W=$T/w.mp4
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=30" -t 30 -c:v libx264 -pix_fmt yuv420p "$W"
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"liascape-player","WorkshopFolder":"$T/we","AutoAddWeWallpapersToLibrary":false,"NoAudio":true,
 "GlobalTransitionEnabled":false,"AutoMute":false,"VideoPreviewQuality":"high"}
EOF

alive() { [ -r "/proc/$1/stat" ] && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]; }
ms() { date +%s%3N; }
start() {   # $1 = log name
  LOG=$T/$1.log
  rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
  (cd /tmp && exec "$DOTNET" "$DLL" serve > "$LOG" 2>&1) & BP=$!
  for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
  PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); U=http://127.0.0.1:$PORT
  TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
  for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "$U/health" >/dev/null && break; sleep 0.1; done
}
api() { curl -s -m 30 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
shown() { "$B" ctl --timeout-ms 1000 get '{"path":"cur:*.path"}' 2>/dev/null | jq -r '.value // empty'; }

# A page's /events socket that never closes first: it records the server's close code, answers the close, and ends.
ws_open() {
  rm -f "$T/ws.ready" "$T/ws.close"
  python3 -I - "$PORT" "$TOKEN" "$T/ws" <<'PY' & WP=$!
import socket, sys, base64, os
port, token, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
s = socket.create_connection(("127.0.0.1", port))
key = base64.b64encode(os.urandom(16)).decode()
s.sendall((f"GET /events?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
buf = b""
while b"\r\n\r\n" not in buf: buf += s.recv(4096)
head, buf = buf.split(b"\r\n\r\n", 1)
if b" 101 " not in head.split(b"\r\n")[0]: sys.exit("no websocket")
open(out + ".ready", "w").close()
def need(n):
    global buf
    while len(buf) < n:
        c = s.recv(65536)
        if not c: open(out + ".close", "w").write("eof"); sys.exit(0)
        buf += c
while True:
    need(2); op, ln = buf[0] & 0x0F, buf[1] & 0x7F; i = 2
    if ln == 126: need(4); ln = int.from_bytes(buf[2:4], "big"); i = 4
    elif ln == 127: need(10); ln = int.from_bytes(buf[2:10], "big"); i = 10
    need(i + ln); data, buf = buf[i:i + ln], buf[i + ln:]
    if op == 8:
        open(out + ".close", "w").write(str(int.from_bytes(data[:2], "big")) if len(data) >= 2 else "none")
        mask = os.urandom(4)
        try: s.sendall(bytes([0x88, 0x82]) + mask + bytes(b ^ mask[k % 4] for k, b in enumerate(data[:2])))
        except OSError: pass
        sys.exit(0)
PY
  for _ in $(seq 1 50); do [ -e "$T/ws.ready" ] && break; sleep 0.1; done
  [ -e "$T/ws.ready" ]
}

# SIGTERM → the backend's exit, in ms (the budget's ceiling + 30 s: a hang shows as one)
stop_ms() {
  local t0; t0=$(ms); kill -TERM "$BP"
  while alive "$BP" && [ $(( $(ms) - t0 )) -lt $((BUDGET_MS + 30000)) ]; do sleep 0.02; done
  local took=$(( $(ms) - t0 ))
  alive "$BP" && { kill -9 "$BP"; took=never; }
  wait "$BP" 2>/dev/null; BP=""
  echo "$took"
}
judge() {   # $1 = state, $2 = the ms it took
  if [ "$2" != never ] && [ "$2" -le $BUDGET_MS ]; then ok "$1: SIGTERM → exit in $2 ms (≤ $BUDGET_MS)"
  else bad "$1: SIGTERM → exit took ${2} ms (budget $BUDGET_MS)"; fi
  local f bad_files=""
  for f in "$XDG_CONFIG_HOME/liascape/settings.json" "$XDG_CONFIG_HOME/liascape/playlist_state.json" "$LIB/imported/index.json"; do
    [ -e "$f" ] && ! jq empty "$f" 2>/dev/null && bad_files+=" ${f#$H/}"
  done
  check "$1: every state file still parses" "${bad_files:-none}" none
}

echo "== idle"
start idle; sleep 1
judge idle "$(stop_ms)"

echo "== an app page's WebSocket"
start ws
ws_open || bad "ws: the WebSocket didn't open (proved nothing)"
took=$(stop_ms); judge "ws" "$took"
for _ in $(seq 1 20); do [ -e "$T/ws.close" ] && break; sleep 0.1; done
check "ws: the page was sent a close frame (going away)" "$(cat "$T/ws.close" 2>/dev/null || echo none)" 1001
gentle "$WP"; WP=""

echo "== a wallpaper playing (a private headless player) + a page connected"
(cd /tmp && exec "$B" serve --headless --outputs 640x360@60 --clock real --ao null > "$T/player.log" 2>&1) & SP=$!
for _ in $(seq 1 100); do "$B" ctl --timeout-ms 500 hello >/dev/null 2>&1 && break; sleep 0.1; done
CP=$("$B" ctl --timeout-ms 1000 hello 2>/dev/null | jq -r '.pid // empty')
start playing
api -X POST "$U/apply" -d "$(jq -nc --arg p "$W" '{path: $p}')" >/dev/null
for _ in $(seq 1 100); do [ "$(shown)" = "$W" ] && break; sleep 0.1; done
check "playing: the wallpaper is on screen before the stop" "$(shown)" "$W"
ws_open || bad "playing: the WebSocket didn't open (proved nothing)"
sleep 1
took=$(stop_ms); judge "playing" "$took"
check "playing: the player outlived the backend, same compositor" "$("$B" ctl --timeout-ms 1000 hello 2>/dev/null | jq -r '.pid // empty')" "$CP"
check "playing: …still showing the wallpaper" "$(shown)" "$W"
check "playing: …not paused" "$("$B" ctl --timeout-ms 1000 get '{"path":"player.paused"}' 2>/dev/null | jq -r .value)" false
gentle "$WP"; WP=""

echo "== a /media download whose reader stopped reading"
start media
python3 -I - "$PORT" "$TOKEN" "$LIB/imported/a/a.mp4" "$T/media" <<'PY' & MP=$!
import socket, sys, time, urllib.parse
port, token, path, out = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096); s.connect(("127.0.0.1", port))
s.sendall((f"GET /media?path={urllib.parse.quote(path)}&token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").encode())
head = s.recv(4096)
open(out + ".ready", "w").write(head.split(b"\r\n")[0].decode(errors="replace"))
time.sleep(120)   # never reads the rest: the server's send blocks on a full socket
PY
for _ in $(seq 1 50); do [ -e "$T/media.ready" ] && break; sleep 0.1; done
check "media: the download started (else this proved nothing)" "$(cut -d' ' -f2 "$T/media.ready" 2>/dev/null)" 200
took=$(stop_ms); judge "media" "$took"
gentle "$MP"; MP=""

echo "== the clip sweep encoding"
start libop
for n in a b c d; do api "$U/clip?path=$(jq -rn --arg p "$LIB/imported/$n/$n.mp4" '$p|@uri')&info=1&w=300&h=300&q=high" >/dev/null; done
for _ in $(seq 1 100); do pgrep -f "ffmpeg .*$T/" >/dev/null && break; sleep 0.1; done
check "libop: an encode runs (else this proved nothing)" "$(pgrep -f "ffmpeg .*$T/" >/dev/null && echo yes || echo no)" yes
took=$(stop_ms); judge "libop" "$took"
for _ in $(seq 1 30); do pgrep -f "ffmpeg .*$T/" >/dev/null || break; sleep 0.1; done
check "libop: no encode outlived the backend" "$(pgrep -fc "ffmpeg .*$T/")" 0

echo "== the backend in a systemd unit (a private user manager), the player started by it"
# A unit's stop (KillMode=control-group) signals every process in its cgroup; `setsid` doesn't leave it. The player the
# backend starts must be out of that cgroup, and keep playing.
systemd_bin() {
  local c
  for c in "$(dirname "$(readlink -f "$(command -v systemctl 2>/dev/null)" 2>/dev/null)")/../lib/systemd/systemd" \
           /usr/lib/systemd/systemd /lib/systemd/systemd; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
unit_case() {
  local sd
  [ "${LIASCAPE_STOP_CG:-}" = 1 ] || { echo "SKIP  unit: no cgroup subtree of our own here (the caller's cgroup isn't the user's), so no private user manager"; return; }
  command -v systemd-run >/dev/null && command -v systemctl >/dev/null && sd=$(systemd_bin) \
    || { echo "SKIP  unit: no systemd / systemd-run / systemctl"; return; }
  # the player of the earlier cases goes: the backend under test must start its own
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1; gentle "$SP"; SP=""
  for _ in $(seq 1 50); do "$B" ctl --timeout-ms 300 hello >/dev/null 2>&1 || break; sleep 0.1; done
  # the player the backends start: headless (no Wayland here), logging what it was asked; its `.<name>-wrapped` sibling
  # tells the backend which binary it really runs
  local HB=$T/hb; mkdir -p "$HB"
  cat > "$HB/liascape-player" <<EOF
#!/bin/sh
echo "\$*" >> "$HB/spawned.log"
if [ "\$1" = serve ]; then shift; exec "$B" serve --headless --outputs 640x360@60 --clock real --ao null "\$@"; fi
exec "$B" "\$@"
EOF
  chmod +x "$HB/liascape-player"; ln -s "$B" "$HB/.liascape-player-wrapped"; : > "$HB/spawned.log"
  # only this test's (empty) target on the manager's unit path: it starts nothing of the system's user units
  mkdir -p "$T/units"; printf '[Unit]\nDescription=liascape-stop idle\n' > "$T/units/liascape-stop-idle.target"
  (cd / && unset DBUS_SESSION_BUS_ADDRESS && SYSTEMD_UNIT_PATH=$T/units exec "$sd" --user --unit=liascape-stop-idle.target \
     --log-target=console --log-level=notice > "$T/manager.log" 2>&1) & MGR=$!
  for _ in $(seq 1 100); do timeout 2 systemctl --user is-system-running >/dev/null 2>&1 && break; sleep 0.1; done
  [ "$(timeout 2 systemctl --user is-system-running 2>/dev/null)" = running ] \
    || { bad "unit: the private user manager didn't come up (proved nothing)"; tail -5 "$T/manager.log"; return; }
  local envs=() v
  for v in PATH HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR XDG_STATE_HOME DBUS_SESSION_BUS_ADDRESS \
           LIASCAPE_SECRETS DOTNET_CLI_TELEMETRY_OPTOUT DOTNET_NOLOGO PULSE_SERVER LIASCAPE_TRANSITIONS_DIR; do
    envs+=("--setenv=$v=${!v}")
  done
  envs+=("--setenv=LIASCAPE_PLAYER_BIN=$HB/liascape-player")
  be_unit() {   # $1 = unit name → BPID, PORT, TOKEN, U of the backend serving in it
    rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
    timeout 15 systemd-run --user --quiet --unit="$1" -p KillMode=control-group -p TimeoutStopSec=10 -p DefaultDependencies=no -p WorkingDirectory=/tmp \
      -p StandardOutput="append:$T/$1.log" -p StandardError=inherit "${envs[@]}" -- "$DOTNET" "$DLL" serve
    for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
    [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "unit: the backend in $1 didn't start"; tail -15 "$T/$1.log"; return 1; }
    BPID=$(systemctl --user show -p MainPID --value "$1")
    PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); U=http://127.0.0.1:$PORT
    TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
    for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "$U/health" >/dev/null && break; sleep 0.1; done
  }
  be_unit liascape-stop-be1.service || return
  check "unit: the backend runs in its unit's cgroup (else this proved nothing)" \
    "$(grep -c '/liascape-stop-be1\.service$' "/proc/$BPID/cgroup" 2>/dev/null)" 1
  api -X POST "$U/apply" -d "$(jq -nc --arg p "$W" '{path: $p}')" >/dev/null
  for _ in $(seq 1 200); do [ "$(shown)" = "$W" ] && break; sleep 0.1; done
  check "unit: the backend started the player, and the wallpaper is on screen" "$(wc -l < "$HB/spawned.log")/$(shown)" "1/$W"
  local hello cp sp
  hello=$("$B" ctl --timeout-ms 1000 hello 2>/dev/null); cp=$(jq -r '.pid // empty' <<< "$hello"); sp=$(jq -r '.supervisor_pid // empty' <<< "$hello")
  echo "  player: supervisor $sp in $(sed -n 's/^0:://p' "/proc/$sp/cgroup" 2>/dev/null), compositor $cp"
  check "unit: the player is out of the backend's unit (its own liascape-player-*.scope)" \
    "$(grep -cE '/liascape-player-[0-9a-f]{12}\.scope$' "/proc/${sp:-0}/cgroup" 2>/dev/null)" 1
  local t0; t0=$(ms)
  timeout 30 systemctl --user stop liascape-stop-be1.service
  for _ in $(seq 1 100); do alive "$BPID" || break; sleep 0.05; done
  check "unit: systemctl stop ended the backend" "$(alive "$BPID" && echo alive || echo gone)" gone
  echo "  (unit stop took $(( $(ms) - t0 )) ms)"
  sleep 1   # a SIGTERMed player would be gone by now
  check "unit: the player outlived the unit's stop, same compositor" "$("$B" ctl --timeout-ms 1000 hello 2>/dev/null | jq -r '.pid // empty')" "$cp"
  check "unit: …still showing the wallpaper" "$(shown)" "$W"
  # a second backend finds the player running: it adopts it (no second `serve`), and drives it
  be_unit liascape-stop-be2.service || return
  local W2=$LIB/imported/a/a.mp4
  api -X POST "$U/apply" -d "$(jq -nc --arg p "$W2" '{path: $p}')" >/dev/null
  for _ in $(seq 1 200); do [ "$(shown)" = "$W2" ] && break; sleep 0.1; done
  check "unit: a second backend adopted the running player (no new serve) and switched it" \
    "$(wc -l < "$HB/spawned.log")/$("$B" ctl --timeout-ms 1000 hello 2>/dev/null | jq -r '.pid // empty')/$(shown)" "1/$cp/$W2"
  timeout 30 systemctl --user stop liascape-stop-be2.service
  sleep 1
  check "unit: …and the player outlived that unit's stop too" "$("$B" ctl --timeout-ms 1000 hello 2>/dev/null | jq -r '.pid // empty')" "$cp"
  grep -h "systemd scope\|systemd user scope" "$T"/liascape-stop-be*.log 2>/dev/null | sed 's/^/  backend: /' | head -4
}
unit_case

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
