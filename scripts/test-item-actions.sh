#!/usr/bin/env bash
# Hermetic test of two of the item sidebar's actions (src/backend/Web/AppOps.cs ClearCrash / OpenMedia):
#  crash: POST /library/clear-crash lifts a scene's crash mark field-level (its other index fields kept), /library and a
#         WebSocket `library-item-changed {path, hasCrashed:false}` say so; a second clear (or a path outside the library)
#         changes nothing and writes nothing.
#  open:  POST /open/media hands a library video / GIF / PNG / JPEG to xdg-open (a stub on PATH that records its argv) as
#         ONE argument, the resolved file; it refuses with 403 (and opens nothing) a path outside the library, a symlink
#         escaping it, a `..` path, a .desktop renamed .mp4 or .png, a .desktop behind a forged MP4 box, a script renamed
#         .png, a GIF named .mp4, a video named .png, a link named .mp4 to a .bin, a non-media extension, a directory and a
#         FIFO (without hanging). ApiSecurity.OpenableMedia.
# Runs in its own network namespace (`unshare -rn`), a temp HOME + XDG dirs and a private backend (legacy engine: no player).
# Never touches ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-item-actions.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), ffmpeg, curl, jq, python3, mkfifo.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [ -z "${LIASCAPE_ACTIONS_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip ffmpeg curl jq python3 timeout mkfifo; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-actions-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { trap - EXIT INT TERM HUP; case "$T" in /tmp/liascape-actions-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_ACTIONS_T=$T
  timeout -k 10 300 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_ACTIONS_T
DLL=$T/backend/liascape-backend.dll
BP=""; WP=""
stopbe() { [ -n "$WP" ] && kill "$WP" 2>/dev/null; [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }; BP=""; WP=""; }
trap 'stopbe' EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# the backend's xdg-open: records each call's argv, opens nothing
mkdir -p "$T/bin"; OPENED=$T/xdg-open.log; : > "$OPENED"
printf '#!/bin/sh\n{ printf "argc=%%s\\n" "$#"; for a; do printf "arg=%%s\\n" "$a"; done; } >> %s\n' "'$OPENED'" > "$T/bin/xdg-open"
chmod +x "$T/bin/xdg-open"
export PATH=$T/bin:$PATH
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

LIB=$XDG_DATA_HOME/liascape/library
WE=$T/we/431960
OUT=$T/outside
mkdir -p "$LIB/imported" "$LIB/workshop" "$LIB/local" "$WE" "$OUT"
vid() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=blue:s=64x36" -frames:v 2 -c:v libx264 -pix_fmt yuv420p "$1"; }
# a crashed scene with other fields of its own (they must survive the clear)
SC=$LIB/workshop/900000009
mkdir -p "$SC"; printf '{"type":"scene","file":"scene.json","title":"sc"}' > "$SC/project.json"; head -c 16 /dev/zero > "$SC/scene.pkg"
printf '{"900000009":{"title":"sc","isScene":true,"workshopId":"900000009","crashed":true,"whitelist":false,"volume":40}}' > "$LIB/workshop/index.json"
# media to open
mkdir -p "$LIB/imported/v1" "$LIB/imported/g1" "$LIB/imported/p1" "$LIB/imported/bad"
vid "$LIB/imported/v1/v1.mp4"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=32x32:rate=4:duration=1" "$LIB/imported/g1/g1.gif"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=green:s=32x18" -frames:v 1 "$LIB/imported/p1/p1.png"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=green:s=32x18" -frames:v 1 "$LIB/imported/p1/p1.jpg"
printf '{"v1":{"title":"v1"},"g1":{"title":"g1"},"p1":{"title":"p1"}}' > "$LIB/imported/index.json"
mkdir -p "$WE/920000001"; vid "$WE/920000001/v.mp4"; ln -s "$WE/920000001" "$LIB/local/920000001"
vid "$OUT/o.mp4"
ln -s "$OUT/o.mp4" "$LIB/imported/bad/escape.mp4"
printf '[Desktop Entry]\nType=Application\nName=x\nExec=touch %s/pwned\n' "$T" > "$LIB/imported/bad/desk.mp4"
printf '\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2[Desktop Entry]\nType=Application\nExec=touch %s/pwned\n' "$T" > "$LIB/imported/bad/forged.mp4"
cp "$LIB/imported/g1/g1.gif" "$LIB/imported/bad/gif.mp4"
cp "$LIB/imported/bad/desk.mp4" "$LIB/imported/bad/desk.png"
printf '#!/bin/sh\ntouch %s/pwned\n' "$T" > "$LIB/imported/bad/script.png"; chmod +x "$LIB/imported/bad/script.png"
cp "$LIB/imported/v1/v1.mp4" "$LIB/imported/bad/video.png"
cp "$LIB/imported/v1/v1.mp4" "$LIB/imported/bad/clip.bin"; ln -s clip.bin "$LIB/imported/bad/link.mp4"
cp "$LIB/imported/v1/v1.mp4" "$LIB/imported/bad/video.txt"
mkdir -p "$LIB/imported/bad/dir.mp4"
mkfifo "$LIB/imported/bad/fifo.mp4"
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"legacy","WorkshopFolder":"$WE","AutoAddWeWallpapersToLibrary":false,"AllowScenes":true,"NoAudio":true}
EOF

LOG=$T/backend.log
rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
(cd /tmp && exec "$DOTNET" "$DLL" serve > "$LOG" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); U=http://127.0.0.1:$PORT
TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "$U/health" >/dev/null && break; sleep 0.1; done
api() { curl -s -m 10 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
# POST $1 with JSON $2 → "<status> <body>"
postc() { api -o "$T/body" -w '%{http_code}' -X POST "$U$1" -d "$2"; }
item() { api "$U/library" | jq -c --arg t "$1" '[.[] | select(.title == $t)][0]'; }

# the WebSocket's events, one JSON per line (a minimal client: the stdlib has none)
python3 -I - "$PORT" "$TOKEN" "$T/events.jsonl" <<'PY' & WP=$!
import socket, sys, base64, os, json
port, token, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
s = socket.create_connection(("127.0.0.1", port))
key = base64.b64encode(os.urandom(16)).decode()
s.sendall((f"GET /events?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
buf = b""
while b"\r\n\r\n" not in buf: buf += s.recv(4096)
head, buf = buf.split(b"\r\n\r\n", 1)
if b" 101 " not in head.split(b"\r\n")[0]: sys.exit("no websocket: " + head.decode(errors="replace"))
open(out + ".ready", "w").close()
def need(n):
    global buf
    while len(buf) < n:
        c = s.recv(65536)
        if not c: sys.exit(0)
        buf += c
while True:
    need(2); op, ln = buf[0] & 0x0F, buf[1] & 0x7F; i = 2
    if ln == 126: need(4); ln = int.from_bytes(buf[2:4], "big"); i = 4
    elif ln == 127: need(10); ln = int.from_bytes(buf[2:10], "big"); i = 10
    need(i + ln); data, buf = buf[i:i + ln], buf[i + ln:]
    if op == 1:
        with open(out, "a") as f: f.write(data.decode() + "\n")
PY
for _ in $(seq 1 50); do [ -e "$T/events.jsonl.ready" ] && break; sleep 0.1; done
[ -e "$T/events.jsonl.ready" ] || bad "the WebSocket didn't open"

echo "== crash: clear a scene's crash mark"
SCP=$(item sc | jq -r .videoPath)
check "the scene shows as crashed" "$(item sc | jq -c .hasCrashed)" true
check "POST /library/clear-crash → cleared" "$(postc /library/clear-crash "$(jq -nc --arg p "$SCP" '{path: $p}')") $(cat "$T/body")" '200 {"cleared":true}'
check "…the mark gone from its index entry, its other fields kept" \
  "$(jq -c '.["900000009"] | [(.crashed // false), .whitelist, .volume, .title, .isScene]' "$LIB/workshop/index.json")" '[false,false,40,"sc",true]'
check "…/library says it isn't crashed" "$(item sc | jq -c .hasCrashed)" false
got=""; for _ in $(seq 1 30); do got=$(jq -c --arg p "$SCP" 'select(.type == "library-item-changed" and .payload.path == $p) | .payload' "$T/events.jsonl" 2>/dev/null | head -1); [ -n "$got" ] && break; sleep 0.1; done
check "…every page told: library-item-changed {path, hasCrashed:false}" "$got" "$(jq -nc --arg p "$SCP" '{path: $p, hasCrashed: false}')"
# the startup's background passes (Steam facts, frame sizes) write the index too: wait until it's quiet
m0=""; for _ in $(seq 1 40); do m=$(stat -c %Y.%s "$LIB/workshop/index.json"); [ "$m" = "$m0" ] && break; m0=$m; sleep 0.5; done; sleep 1.1
check "a second clear changes nothing" "$(postc /library/clear-crash "$(jq -nc --arg p "$SCP" '{path: $p}')") $(cat "$T/body")" '200 {"cleared":false}'
check "…and leaves index.json unwritten" "$(stat -c %Y.%s "$LIB/workshop/index.json")" "$m0"
check "a path outside the library → nothing cleared" "$(postc /library/clear-crash "$(jq -nc --arg p "$OUT/o.mp4" '{path: $p}')") $(cat "$T/body")" '200 {"cleared":false}'
check "…no index made for it" "$(ls "$OUT")" "o.mp4"
n=$(grep -c library-item-changed "$T/events.jsonl" 2>/dev/null); sleep 0.3
check "…and no event for either" "$(grep -c library-item-changed "$T/events.jsonl" 2>/dev/null)" "$n"

echo "== open: a library video / GIF / picture in the user's own app"
opened() { cat "$OPENED"; }
open_ok() {   # $1 label, $2 path asked, $3 the argv expected (the resolved file)
  : > "$OPENED"
  local st; st=$(postc /open/media "$(jq -nc --arg p "$2" '{path: $p}')")
  check "$1 → 200" "$st" 200
  for _ in $(seq 1 50); do [ -s "$OPENED" ] && break; sleep 0.1; done
  check "…xdg-open got exactly the resolved file" "$(opened | tr '\n' '|')" "argc=1|arg=$3|"
}
open_no() {   # $1 label, $2 path
  : > "$OPENED"
  local st; st=$(timeout 8 curl -s -m 6 -o /dev/null -w '%{http_code}' -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$U/open/media" -d "$(jq -nc --arg p "$2" '{path: $p}')")
  sleep 0.3
  check "$1 → 403, nothing opened" "$st $(opened | wc -l)" "403 0"
}
open_ok "a library video" "$LIB/imported/v1/v1.mp4" "$(realpath "$LIB/imported/v1/v1.mp4")"
open_ok "a library GIF" "$LIB/imported/g1/g1.gif" "$(realpath "$LIB/imported/g1/g1.gif")"
open_ok "a library PNG" "$LIB/imported/p1/p1.png" "$(realpath "$LIB/imported/p1/p1.png")"
open_ok "a library JPEG" "$LIB/imported/p1/p1.jpg" "$(realpath "$LIB/imported/p1/p1.jpg")"
open_ok "a Workshop item's video through its local/ link" "$LIB/local/920000001/v.mp4" "$(realpath "$WE/920000001/v.mp4")"
open_no "a video outside the library" "$OUT/o.mp4"
open_no "a library symlink escaping it" "$LIB/imported/bad/escape.mp4"
open_no "a .. path" "$LIB/imported/bad/../v1/v1.mp4"
open_no "a .desktop renamed .mp4" "$LIB/imported/bad/desk.mp4"
open_no "a .desktop behind a forged MP4 box" "$LIB/imported/bad/forged.mp4"
open_no "a GIF named .mp4" "$LIB/imported/bad/gif.mp4"
open_no "a .desktop renamed .png" "$LIB/imported/bad/desk.png"
open_no "a script renamed .png" "$LIB/imported/bad/script.png"
open_no "a video named .png" "$LIB/imported/bad/video.png"
open_no "a link named .mp4 to a .bin" "$LIB/imported/bad/link.mp4"
open_no "a non-media extension (a real video named .txt)" "$LIB/imported/bad/video.txt"
open_no "a directory named .mp4" "$LIB/imported/bad/dir.mp4"
open_no "a FIFO named .mp4 (answered, not hung)" "$LIB/imported/bad/fifo.mp4"
open_no "a relative path" "imported/v1/v1.mp4"
check "nothing ran the planted .desktop" "$([ -e "$T/pwned" ] && echo ran || echo no)" no
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
