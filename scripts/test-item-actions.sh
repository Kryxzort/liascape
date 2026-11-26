#!/usr/bin/env bash
# Hermetic test of two of the item sidebar's actions (src/backend/Web/AppOps.cs ClearCrash / OpenMedia):
#  crash: POST /library/clear-crash lifts a scene's crash mark field-level (its other index fields kept), /library and a
#         WebSocket `library-item-changed {path, hasCrashed:false}` say so; a second clear (or a path outside the library)
#         changes nothing and writes nothing. POST /library/clear-crash-all (Settings → Housekeeping) lifts every other
#         mark (a scene's, a video's) the same way, answers how many, and a second one clears nothing.
#  open:  POST /open/media hands a library video / GIF / PNG / JPEG to xdg-open (a stub on PATH that records its argv) as
#         ONE argument, the resolved file; it refuses with 403 (and opens nothing) a path outside the library, a symlink
#         escaping it, a `..` path, a .desktop renamed .mp4 or .png, a .desktop behind a forged MP4 box, a script renamed
#         .png, a GIF named .mp4, a video named .png, a link named .mp4 to a .bin, a non-media extension, a directory and a
#         FIFO (without hanging). ApiSecurity.OpenableMedia.
#  import: POST /library/import of a .gif, a .webm and a .MKV stores each under its own (lowercased) extension, its bytes
#         as they were, with a thumbnail; a container the library doesn't name (.ts) as .mp4; a .png as it is, a .jpg converted
#         to a .png; another file under a taken title beside it as "<title> (1)", a slash left out of a name, a missing source
#         nothing (400). /library lists the gif as its
#         own animated preview and the videos without one, /media serves each as its own type, the gif and the mkv open in
#         the user's app, a re-import is the same item, delete takes it away; a URL download's <key>.gif beside its video
#         stays its preview, and never stands in for a broken video link. Helpers/ImportService.cs, LibraryService.ResolveItemMedia.
#  link:  POST /library/link and /library/import-link (Web/LinkImportOps.cs) against a stand-in file server on loopback: a
#         file's link resolves by its name and lands in imported/ with the link as its source, told by download-progress and
#         the library-ops "link" operation; again → "already"; a picture → png; a same-server redirect followed; an unknown
#         site's file named by its Content-Disposition, its page "isn't supported"; refused, landing nothing: a page served
#         as video/mp4, redirects to cloud metadata / the LAN / file: / round a loop, a LAN address, a file over the cap
#         (by its length, and one sending none), a 404; the link's query never logged. A Workshop link: Steam's details
#         (LIASCAPE_STEAM_CM_FIXTURE), the download mode's refusal and nothing else (no Steam page); a web wallpaper and an
#         unknown id refused. A MoeWalls page goes to MoeWalls (unreachable here).
# Runs in its own network namespace (`unshare -rn`), a temp HOME + XDG dirs and a private backend whose player is an
# `exit 1` stub (nothing plays).
# Never touches ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-item-actions.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs / screenshots and prints where (last line).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), ffmpeg, curl, jq, python3, mkfifo.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
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
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-actions- "$rc"; }
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
# the player: an `exit 1` stub, so no real liascape-player ever starts here
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
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
# two more marks for Housekeeping's clear-all: a second scene and a video
SC2=$LIB/workshop/900000010
mkdir -p "$SC2"; printf '{"type":"scene","file":"scene.json","title":"sc2"}' > "$SC2/project.json"; head -c 16 /dev/zero > "$SC2/scene.pkg"
printf '{"900000009":{"title":"sc","isScene":true,"workshopId":"900000009","crashed":true,"whitelist":false,"volume":40},"900000010":{"title":"sc2","isScene":true,"workshopId":"900000010","crashed":true,"speed":1.5}}' > "$LIB/workshop/index.json"
# media to open
mkdir -p "$LIB/imported/v1" "$LIB/imported/g1" "$LIB/imported/p1" "$LIB/imported/bad"
vid "$LIB/imported/v1/v1.mp4"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=32x32:rate=4:duration=1" "$LIB/imported/g1/g1.gif"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=green:s=32x18" -frames:v 1 "$LIB/imported/p1/p1.png"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=green:s=32x18" -frames:v 1 "$LIB/imported/p1/p1.jpg"
printf '{"v1":{"title":"v1","crashed":true},"g1":{"title":"g1"},"p1":{"title":"p1"}}' > "$LIB/imported/index.json"
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
{"WorkshopFolder":"$WE","AutoAddWeWallpapersToLibrary":false,"AllowScenes":true,"NoAudio":true}
EOF
# § link: the stand-in file server listens on loopback, which only a test lets a link reach; a small cap; Steam's details
# for the Workshop links from a file (a video, a web wallpaper, a scene), never Steam
export LIASCAPE_TEST_LINK_LOOPBACK=1 LIASCAPE_LINK_MAX_BYTES=200000 LIASCAPE_STEAM_CM_FIXTURE=$T/steam-cm.json
cat > "$LIASCAPE_STEAM_CM_FIXTURE" <<'EOF'
{"930000001": {"title": "Link Workshop Video", "tags": ["Video", "Everyone", "1920 x 1080"]},
 "930000002": {"title": "Link Web Wallpaper", "tags": ["Web", "Everyone"]},
 "930000003": {"title": "Link Workshop Scene", "tags": ["Scene", "Everyone"]}}
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

echo "== crash: Housekeeping's clear-all"
SC2P=$(item sc2 | jq -r .videoPath); V1P=$(item v1 | jq -r .videoPath)
check "sc2 and v1 show as crashed, sc not" "$(api "$U/library" | jq -c '[.[] | select(.hasCrashed) | .title] | sort')" '["sc2","v1"]'
check "POST /library/clear-crash-all → cleared 2" "$(postc /library/clear-crash-all '{}') $(cat "$T/body")" '200 {"cleared":2}'
check "…no item crashed in /library" "$(api "$U/library" | jq -c '[.[] | select(.hasCrashed)] | length')" 0
check "…both marks gone from their index entries, other fields kept" \
  "$(jq -c '.["900000010"] | [(.crashed // false), .speed, .title]' "$LIB/workshop/index.json") $(jq -c '.v1 | [(.crashed // false), .title]' "$LIB/imported/index.json")" '[false,1.5,"sc2"] [false,"v1"]'
for p in "$SC2P" "$V1P"; do
  got=""; for _ in $(seq 1 30); do got=$(jq -c --arg p "$p" 'select(.type == "library-item-changed" and .payload.path == $p) | .payload' "$T/events.jsonl" 2>/dev/null | head -1); [ -n "$got" ] && break; sleep 0.1; done
  check "…every page told for $(basename "$p"): library-item-changed {path, hasCrashed:false}" "$got" "$(jq -nc --arg p "$p" '{path: $p, hasCrashed: false}')"
done
n=$(grep -c library-item-changed "$T/events.jsonl" 2>/dev/null)
check "a second clear-all clears nothing" "$(postc /library/clear-crash-all '{}') $(cat "$T/body")" '200 {"cleared":0}'
sleep 0.3
check "…and sends no event" "$(grep -c library-item-changed "$T/events.jsonl" 2>/dev/null)" "$n"

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

echo "== import: a gif and videos keep their own format"
SRC=$T/src; mkdir -p "$SRC"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=64x36:rate=4:duration=1" "$SRC/ig.gif"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=blue:s=64x36" -frames:v 2 -c:v libvpx-vp9 "$SRC/iw.webm"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=blue:s=64x36" -frames:v 2 -c:v libx264 -pix_fmt yuv420p -f matroska "$SRC/im.MKV"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=blue:s=64x36:rate=4:duration=1" -c:v libx264 -pix_fmt yuv420p -f mpegts "$SRC/it.ts"
# $1 the source, $2 the title, $3 the extension it must be stored under
imp() {
  local want=$LIB/imported/$2/$2.$3 got
  got=$(postc /library/import "$(jq -nc --arg p "$1" --arg t "$2" '{path: $p, title: $t}')"; echo " $(jq -r .videoPath "$T/body")")
  check "import $(basename "$1") → stored as $2.$3" "$got" "200 $want"
  check "…the source's own bytes" "$(cmp -s "$1" "$want" && echo same || echo differ)" same
  check "…its thumbnail extracted" "$(item "$2" | jq -r .thumbnailPath)" "$LIB/imported/$2/$2.jpg"
}
imp "$SRC/ig.gif" ig gif
imp "$SRC/iw.webm" iw webm
imp "$SRC/im.MKV" im mkv
# a container the library doesn't name (LibraryService.ImportedMediaExts): .mp4, which the player plays whatever is inside
imp "$SRC/it.ts" it mp4
# a picture: a png as it is, any other picture converted to one (the library finds a still as <key>.png)
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=yellow:s=64x36" -frames:v 1 "$SRC/ip.png"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=yellow:s=64x36" -frames:v 1 "$SRC/ij.jpg"
imp "$SRC/ip.png" ip png
check "import ij.jpg → stored as ij.png, a PNG" "$(postc /library/import "$(jq -nc --arg p "$SRC/ij.jpg" '{path: $p, title: "ij"}')") $(jq -r .videoPath "$T/body") $(head -c 8 "$LIB/imported/ij/ij.png" 2>/dev/null | od -An -tx1 | tr -d ' \n')" \
  "200 $LIB/imported/ij/ij.png 89504e470d0a1a0a"
check "…its thumbnail extracted" "$(item ij | jq -r .thumbnailPath)" "$LIB/imported/ij/ij.jpg"
# another file under a title already taken is its own item beside it; a source that doesn't exist imports nothing
cp "$SRC/iw.webm" "$SRC/other.webm"
check "another file titled iw → its own item, iw (1)" "$(postc /library/import "$(jq -nc --arg p "$SRC/other.webm" '{path: $p, title: "iw"}')") $(jq -r .videoPath "$T/body")" \
  "200 $LIB/imported/iw (1)/iw (1).webm"
cp "$SRC/ip.png" "$SRC/slash.png"
check "a title with a slash → the slash left out of its name" "$(postc /library/import "$(jq -nc --arg p "$SRC/slash.png" '{path: $p, title: "a/b"}')") $(jq -r .videoPath "$T/body")" \
  "200 $LIB/imported/ab/ab.png"
check "a source that doesn't exist → 400, nothing imported" "$(postc /library/import "$(jq -nc --arg p "$SRC/nope.mp4" '{path: $p, title: "nope"}')") $([ -e "$LIB/imported/nope" ] && echo made || echo none)" \
  "400 none"
# what the UI tells a gif from a video by (components/mediaAssets.ts): the gif is its own animated preview, a video has none
check "the gif lists as its own animated preview (a card plays it as a gif)" "$(item ig | jq -c '[.videoPath == .animatedThumbnailPath, .isScene]')" '[true,false]'
check "the webm and mkv list as videos, with no gif" "$(item iw | jq -c '[.videoPath, .animatedThumbnailPath]') $(item im | jq -c '[.videoPath, .animatedThumbnailPath]')" \
  "[\"$LIB/imported/iw/iw.webm\",null] [\"$LIB/imported/im/im.mkv\",null]"
ctype() { api -o /dev/null -w '%{content_type}' "$U/media?path=$(jq -rn --arg p "$1" '$p|@uri')"; }
check "/media serves each as its own type" "$(ctype "$LIB/imported/ig/ig.gif") $(ctype "$LIB/imported/iw/iw.webm") $(ctype "$LIB/imported/im/im.mkv")" \
  "image/gif video/webm video/x-matroska"
open_ok "the imported gif in the user's own app (a GIF named .mp4 is refused)" "$LIB/imported/ig/ig.gif" "$(realpath "$LIB/imported/ig/ig.gif")"
open_ok "the imported mkv in the user's own app" "$LIB/imported/im/im.mkv" "$(realpath "$LIB/imported/im/im.mkv")"
# importing the same file again reuses its folder and name
check "importing the gif again → the same item" "$(postc /library/import "$(jq -nc --arg p "$SRC/ig.gif" '{path: $p, title: "ig"}')") $(jq -r .videoPath "$T/body") $(ls "$LIB/imported" | grep -c '^ig')" \
  "200 $LIB/imported/ig/ig.gif 1"
check "delete takes the gif item away" "$(postc /library/delete "$(item ig)") $(item ig) $([ -e "$LIB/imported/ig" ] && echo left || echo gone)" "200 null gone"
# a URL download from an unknown site lands in imported/ too, its <key>.gif the PREVIEW of the video beside it
# (Helpers/DownloadHelper.cs): the video stays the media, and a video link that broke never turns into its preview
mkdir -p "$LIB/imported/dl1" "$LIB/imported/dl2"
vid "$LIB/imported/dl1/dl1.webm"; cp "$SRC/ig.gif" "$LIB/imported/dl1/dl1.gif"
ln -s "$T/gone.mp4" "$LIB/imported/dl2/dl2.mp4"; cp "$SRC/ig.gif" "$LIB/imported/dl2/dl2.gif"
jq -c '. + {"dl1": {"title": "dl1"}, "dl2": {"title": "dl2"}}' "$LIB/imported/index.json" > "$T/idx" && mv "$T/idx" "$LIB/imported/index.json"
check "a download's video stays its media, its gif the preview" "$(item dl1 | jq -c '[.videoPath, .animatedThumbnailPath]')" \
  "[\"$LIB/imported/dl1/dl1.webm\",\"$LIB/imported/dl1/dl1.gif\"]"
check "a download whose video link broke still names that link, never its preview gif" "$(item dl2 | jq -c '[.videoPath, .animatedThumbnailPath]')" \
  "[\"$LIB/imported/dl2/dl2.mp4\",\"$LIB/imported/dl2/dl2.gif\"]"

echo "== link: an import from a pasted link (Web/LinkImportOps.cs)"
# a stand-in file server on loopback: files by name, one without a name (its Content-Disposition names it), a page, a page
# served as video/mp4, redirects (on to itself, to cloud metadata, the LAN, file:, round in a loop), files over the cap
# (one saying so, one sending no length), a 404. Every request logged with its User-Agent.
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=yellow:s=64x36" -frames:v 1 "$SRC/lj.jpg"
: > "$T/files.log"
python3 -I - "$T/files.port" "$T/files.log" "$LIB/imported/v1/v1.mp4" "$SRC/lj.jpg" <<'PY' & FP=$!
import http.server, sys
port_file, log, video, jpg = sys.argv[1:5]
V = open(video, "rb").read(); J = open(jpg, "rb").read()
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def send(self, code, body=b"", ctype=None, extra=()):
        self.send_response(code)
        if ctype: self.send_header("Content-Type", ctype)
        for k, v in extra: self.send_header(k, v)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = self.path.split("?")[0]
        with open(log, "a") as f: f.write(f"{p} {self.headers.get('User-Agent', '')[:20]}\n")
        go = lambda to: self.send(302, extra=[("Location", to)])
        if p in ("/files/neon.mp4", "/files/redir-target.mp4", "/files/again.mp4"): self.send(200, V, "video/mp4")
        elif p == "/files/still.jpg": self.send(200, J, "image/jpeg")
        elif p == "/v/abc": self.send(200, V, "video/mp4", [("Content-Disposition", 'attachment; filename="Sunset Loop.mp4"')])
        elif p in ("/page", "/v/page"): self.send(200, b"<!doctype html><title>a page</title>", "text/html; charset=utf-8")
        elif p == "/files/fake.mp4": self.send(200, b"<!doctype html><title>log in</title>" + b" " * 64, "video/mp4")
        elif p == "/r/ok": go("/files/redir-target.mp4")
        elif p == "/r/meta.mp4": go("http://169.254.169.254/latest/meta-data/x.mp4")
        elif p == "/r/lan.mp4": go("http://192.168.1.1/a.mp4")
        elif p == "/r/file.mp4": go("file:///etc/passwd")
        elif p == "/r/loop.mp4": go("/r/loop.mp4")
        elif p == "/files/big.mp4": self.send(200, b"\0" * 300000, "video/mp4")
        elif p == "/files/endless.mp4":
            self.send_response(200); self.send_header("Content-Type", "video/mp4"); self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
            try:
                for _ in range(40):
                    chunk = b"\0" * 10000
                    self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError): pass
        else: self.send(404, b"no", "text/plain")
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_address[1]))
s.serve_forever()
PY
for _ in $(seq 1 50); do [ -s "$T/files.port" ] && break; sleep 0.1; done
S=http://127.0.0.1:$(cat "$T/files.port")
link() { postc "$1" "$(jq -nc --arg u "$2" '{url: $u}')"; }
resolve() { echo "$(link /library/link "$1") $(jq -c "${2:-.}" "$T/body")"; }
importl() { echo "$(link /library/import-link "$1") $(jq -c "${2:-.}" "$T/body")"; }
trash_left() { find "$LIB/.trash" -mindepth 1 -maxdepth 1 -name 'link-*' 2>/dev/null | wc -l; }

check "a file's link resolves to it, by its name" "$(resolve "$S/files/neon.mp4?token=SECRET-IN-QUERY")" \
  "200 $(jq -nc --arg u "$S/files/neon.mp4?token=SECRET-IN-QUERY" '{kind: "direct", id: $u, title: "neon", source: "127.0.0.1", media: "video", inLibrary: false, blocked: null}')"
check "…nothing fetched to say so (the name told)" "$(grep -c neon "$T/files.log" 2>/dev/null || true)" 0
: > "$T/events.jsonl"
check "importing it → imported/neon/neon.mp4" "$(importl "$S/files/neon.mp4?token=SECRET-IN-QUERY" .videoPath)" "200 \"$LIB/imported/neon/neon.mp4\""
check "…its bytes the server's" "$(cmp -s "$LIB/imported/v1/v1.mp4" "$LIB/imported/neon/neon.mp4" && echo same || echo differ)" same
check "…fetched once, with the Firefox User-Agent" "$(grep neon "$T/files.log")" "/files/neon.mp4 Mozilla/5.0 (X11; Li"
check "…the item names the link as its source and page, with a thumbnail" "$(item neon | jq -c '[.sourceId, .pageUrl, (.thumbnailPath != null)]')" \
  "$(jq -nc --arg u "$S/files/neon.mp4?token=SECRET-IN-QUERY" '[$u, $u, true]')"
got=""; for _ in $(seq 1 30); do got=$(jq -c --arg u "$S/files/neon.mp4?token=SECRET-IN-QUERY" 'select(.type == "download-progress" and .payload.id == $u and .payload.done) | .payload.value' "$T/events.jsonl" 2>/dev/null | head -1); [ -n "$got" ] && break; sleep 0.1; done
check "…its progress told like a Browse card's: download-progress {id: the link, done}" "$got" 1
check "…the top bar's progress line had it: library-ops \"link\" started and ended" "$(grep -c 'library-ops: link \(started\|ended\)' "$LOG")" 2
check "…the library's trash keeps nothing of it" "$(trash_left)" 0
check "the same link again → already in the library, nothing fetched" "$(importl "$S/files/neon.mp4?token=SECRET-IN-QUERY") $(grep -c neon "$T/files.log")" \
  '200 {"already":true,"title":"neon"} 1'
check "…and its resolve says so" "$(resolve "$S/files/neon.mp4?token=SECRET-IN-QUERY" .inLibrary)" "200 true"
check "a picture's link → stored as a png" "$(importl "$S/files/still.jpg" .videoPath) $(head -c 8 "$LIB/imported/still/still.png" 2>/dev/null | od -An -tx1 | tr -d ' \n')" \
  "200 \"$LIB/imported/still/still.png\" 89504e470d0a1a0a"
check "a redirect on the same server is followed" "$(importl "$S/r/ok" .videoPath)" "200 \"$LIB/imported/ok/ok.mp4\""
check "an unknown site's address: its answer looked at, named by its Content-Disposition" "$(resolve "$S/v/abc" '[.kind, .title, .media]')" '200 ["direct","Sunset Loop","video"]'
check "…and imported as that file" "$(importl "$S/v/abc" .videoPath)" "200 \"$LIB/imported/Sunset Loop/Sunset Loop.mp4\""
unsupported='"That site isn'"'"'t supported. Import takes a Steam Workshop item, a MoeWalls, DesktopHut or MotionBgs page, or a link straight to a video or picture."'
check "an unknown site's page → it isn't supported, in plain words (resolve)" "$(resolve "$S/page" .error)" "400 $unsupported"
check "…and import, landing nothing" "$(importl "$S/v/page" .error) $(trash_left)" "400 $unsupported 0"
n0=$(ls "$LIB/imported" | wc -l)
check "a page served as video/mp4 → refused by its first bytes, nothing kept" "$(importl "$S/files/fake.mp4" .error) $(ls "$LIB/imported" | wc -l) $(trash_left)" \
  "400 \"The link's file isn't a video.\" $n0 0"
private_msg() { echo "\"The link leads to $1, which is this computer or your own network: only public addresses are fetched.\""; }
check "a redirect to cloud metadata (169.254.169.254) → refused" "$(importl "$S/r/meta.mp4" .error)" "400 $(private_msg 169.254.169.254)"
check "a redirect into the LAN (192.168.1.1) → refused" "$(importl "$S/r/lan.mp4" .error)" "400 $(private_msg 192.168.1.1)"
check "a link straight into the LAN (10.0.0.5) → refused" "$(importl "http://10.0.0.5/a.mp4" .error)" "400 $(private_msg 10.0.0.5)"
check "a redirect to file: → refused" "$(importl "$S/r/file.mp4" .error)" '400 "The link leads on to a file: address, which isn'"'"'t fetched."'
check "a redirect loop → refused" "$(importl "$S/r/loop.mp4" .error)" '400 "The link redirects too many times."'
check "a file: link itself → only web links" "$(importl "file:///etc/passwd" .error)" '400 "Only web links (http or https) can be imported."'
toobig="\"It's bigger than 200000 bytes, the most an import from a link fetches.\""
check "a file over the cap by its Content-Length → refused before its body" "$(importl "$S/files/big.mp4" .error) $(trash_left)" "400 $toobig 0"
check "a file over the cap with no length → cut off at the cap, nothing kept" "$(importl "$S/files/endless.mp4" .error) $(ls "$LIB/imported" | wc -l) $(trash_left)" \
  "400 $toobig $n0 0"
check "a link the server doesn't have → its answer" "$(importl "$S/files/gone.mp4" .error)" '400 "The server answered 404 (Not Found)."'
check "the link's query (a token in it) never reaches the log" "$(grep -c SECRET-IN-QUERY "$LOG" || true)" 0
# a Workshop item's link goes through /download's path: the chosen mode ("subscribe", signed out here) refuses it with the
# mode's own words before anything reaches Steam, and no other way (a Steam page) is tried
: > "$OPENED"
check "a Workshop link resolves to the item (Steam's details), the mode's refusal shown up front" \
  "$(resolve "https://steamcommunity.com/workshop/filedetails/?id=930000001" '[.kind, .id, .title, .media, .blocked]')" \
  '200 ["workshop","https://steamcommunity.com/sharedfiles/filedetails/?id=930000001","Link Workshop Video","video","Sign in to Steam to download"]'
check "…its import refused with those words, no Steam page opened" "$(importl "https://steamcommunity.com/sharedfiles/filedetails/?id=930000001" .error) $(wc -l < "$OPENED")" \
  '400 "Sign in to Steam to download" 0'
check "a Workshop scene's link → a scene" "$(resolve "https://steamcommunity.com/sharedfiles/filedetails/?id=930000003" .media)" '200 "scene"'
check "a Workshop web wallpaper's link → refused (it can't play)" "$(resolve "https://steamcommunity.com/sharedfiles/filedetails/?id=930000002" .error)" \
  '400 "That Workshop item is a web or application wallpaper, which Liascape doesn'"'"'t play."'
check "a Workshop id Steam has no item for → says so" "$(resolve "https://steamcommunity.com/sharedfiles/filedetails/?id=930000099" .error)" \
  '400 "Steam has no public Workshop item with that id, or Steam couldn'"'"'t be reached."'
# a web source's page goes to that site (no network here: it can't be reached), never anywhere else
check "a MoeWalls page → fetched from MoeWalls (unreachable in this test)" \
  "$(importl "https://moewalls.com/anime/neon-rain-live-wallpaper/" '.error | startswith("MoeWalls couldn'"'"'t be reached")')" "400 true"
kill "$FP" 2>/dev/null
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
