#!/usr/bin/env bash
# Hermetic test of `liascape-backend serve` stopping on SIGTERM (Web/ServerHost.cs § shutdown): a service manager (the
# dev stack's systemd unit, a session logout) gives it seconds before SIGKILL, and a SIGKILLed backend skips its
# ApplicationStopping hand-offs. Each state below gets SIGTERM and must exit within $BUDGET_MS, leave every state file
# parsable, and leave the player as it was (it outlives the backend on purpose: .claude/rules/backend/player-adapter.md):
#  idle · a WebSocket client on /events (an open app page; it must be sent a close frame, 1001) · a wallpaper playing in a
#  private headless liascape-player with a page connected · a /media download whose reader stopped reading (a paused
#  <video>) · the library's clip sweep encoding (its nice'd ffmpeg children stopped with it).
# Runs in its own network namespace (`unshare -rn`), a temp HOME + XDG dirs, its own backend, player socket and no audio
# server. Never touches ~/.config/liascape, the real library or the owner's player; everything it started is stopped on exit.
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
  cleanup() { trap - EXIT INT TERM HUP; case "$T" in /tmp/liascape-stop-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_STOP_T=$T
  timeout -k 10 420 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_STOP_T
DLL=$T/backend/liascape-backend.dll
B=$T/bin/liascape-player
BUDGET_MS=3000
BP=""; WP=""; SP=""; MP=""
gentle() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done; kill -9 "$1" 2>/dev/null; }
teardown() {
  gentle "$WP"; gentle "$MP"; gentle "$BP"
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1   # a clean quit ends the supervisor too
  gentle "$SP"
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
{"PlayerEngine":"liascape-player","WorkshopFolder":"$T/we","AutoAddWeWallpapersToLibrary":false,"NoAudio":true,"Loop":true,
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

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
