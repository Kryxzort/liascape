#!/usr/bin/env bash
# Hermetic test of what the library learns in the background (Web/LibraryFactsOps.cs): Steam's Workshop tags for the items
# auto-imported from Wallpaper Engine's folder, asked once, and every other item's frame size, bucketed into the Workshop's
# resolution tags (WorkshopTags.ResolutionTagOf) — the Library filter column's data.
# Runs in its own network namespace (`unshare -rn`: loopback only, nothing can reach Steam), a temp HOME + XDG dirs and a
# private backend whose Steam servers are a fixture file (LIASCAPE_STEAM_CM_FIXTURE, Helpers/SteamWorkshopDetails.cs:
# every GetDetails request is logged with its ids).
#  1. tags: the first start asks Steam ONCE for every Workshop item without tags (one GetDetails of exactly those ids;
#     never the downloaded item that has Steam's tags already); each found item's index entry gets `tags`, an id Steam has
#     no public item for gets `tagsCheckedAt`; /library shows Steam's tags, age rating and resolution; the rest of the old
#     index.json (no new fields — it loads) is kept: titles, a volume override.
#  2. frame sizes: imported videos of 10 shapes, an image and a rotated phone video → their Workshop resolution tag in
#     /library's tags + "W x H"; a Workshop scene Steam has no item for → its project size (scene.json inside scene.pkg);
#     a Workshop video whose Steam tags carry no resolution → its file's; an item whose Steam tags carry one isn't read.
#  3. a restart asks Steam nothing and reads no file again.
#  4. a new arrival (/library/sync) → one GetDetails of only its id.
#  5. Steam unreachable (no fixture file) + a new arrival → nothing stored for it; once Steam answers, it is asked again.
#  6. a replaced file is read again.
# Never touches ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-library-facts.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), ffmpeg, ffprobe, curl, jq, python3.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [ -z "${LIASCAPE_FACTS_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip ffmpeg ffprobe curl jq python3 timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-facts-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { trap - EXIT INT TERM HUP; case "$T" in /tmp/liascape-facts-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  # the test itself runs with no network at all (loopback only): nothing in it can reach Steam
  export DOTNET LIASCAPE_FACTS_T=$T
  timeout -k 10 600 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_FACTS_T
DLL=$T/backend/liascape-backend.dll
BP=""
stopbe() { [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }; BP=""; }
trap 'stopbe' EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export LIASCAPE_STEAM_CM_FIXTURE=$T/steam-cm.json
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

LIB=$XDG_DATA_HOME/liascape/library
WE=$T/we/431960
mkdir -p "$WE" "$LIB/local" "$LIB/imported"
vid() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=blue:s=$2" -frames:v 1 -c:v libx264 -pix_fmt yuv420p "$1"; }
# a Wallpaper Engine item folder (+ its local/<id> link): $1 id, $2 type, $3 project.json tags (JSON), $4 frame size (videos), $5 "arrival" = no link
we_item() {
  mkdir -p "$WE/$1"
  if [ "$2" = video ]; then
    vid "$WE/$1/v.mp4" "$4"
    printf '{"type":"video","file":"v.mp4","title":"we-%s","contentrating":"Everyone","tags":%s}' "$1" "$3" > "$WE/$1/project.json"
  else
    printf '{"type":"scene","file":"scene.json","title":"we-%s","tags":%s}' "$1" "$3" > "$WE/$1/project.json"
    # scene.pkg (Wallpaper Engine's container: src/player/src/scene/pkg.rs) holding scene.json with a 2560 x 1440 projection
    python3 -I -c '
import struct, sys
def s(b): return struct.pack("<I", len(b)) + b
files = [(b"scene.json", b"{\"general\":{\"orthogonalprojection\":{\"width\":2560,\"height\":1440}},\"objects\":[]}"), (b"x.txt", b"hi")]
table, data = b"", b""
for n, d in files: table += s(n) + struct.pack("<II", len(data), len(d)); data += d
open(sys.argv[1], "wb").write(s(b"PKGV0019") + struct.pack("<I", len(files)) + table + data)' "$WE/$1/scene.pkg"
  fi
  [ "${5:-}" = arrival ] || ln -s "$WE/$1" "$LIB/local/$1" # an arrival: /library/sync links it
}
we_item 910000001 video '["Anime"]' 640x360          # Steam: 3840 x 2160, Everyone, Anime, Audio responsive
we_item 910000002 video '["Nature"]' 640x360         # Steam: Portrait 1080 x 1920, Mature, Nature
we_item 910000003 video '["Game"]' 640x360           # Steam: no resolution tag → its file's: Standard Definition
we_item 910000004 scene '["Abstract"]'               # Steam has no such item → its project size: 2560 x 1440
we_item 910000005 video '["Anime"]' 640x360          # a download: Steam's tags in the index already → never asked
we_item 910000008 video '["Cyberpunk"]' 640x360       # a local/<id> link with no index entry yet: its folder name is its id
# the index as an older build wrote it: none of the new fields
cat > "$LIB/local/index.json" <<'EOF'
{"910000001":{"title":"one","workshopId":"910000001","volume":40},"910000002":{"title":"two","workshopId":"910000002"},
 "910000003":{"title":"three","workshopId":"910000003"},"910000004":{"title":"four","workshopId":"910000004","isScene":true},
 "910000005":{"title":"five","workshopId":"910000005","tags":["Video","Everyone","1920 x 1080","Anime"],"trailerCheckedAt":4102444800}}
EOF
# no trailer look-up noise for the first four: they have one
for id in 910000001 910000002 910000003 910000004; do
  jq --arg id "$id" '.[$id].youtubeUrl = "https://www.youtube.com/watch?v=x"' "$LIB/local/index.json" > "$T/i.json" && mv "$T/i.json" "$LIB/local/index.json"
done
cat > "$T/steam-cm.json" <<'EOF'
{"910000001":{"tags":["Video","Everyone","3840 x 2160","Anime","Audio responsive"]},
 "910000002":{"tags":["Video","Mature","Portrait 1080 x 1920","Nature"]},
 "910000003":{"tags":["Video","Questionable","Game"]},
 "910000005":{"tags":["Video","Everyone","1920 x 1080","Anime","HDR"]},
 "910000006":{"tags":["Video","Everyone","2560 x 1440","Relaxing"]},
 "910000007":{"tags":["Video","Everyone","Ultrawide 3440 x 1440","Retro"]},
 "910000008":{"tags":["Video","Everyone","1920 x 1080","Cyberpunk"]}}
EOF
# imported (non-Workshop) items: name → frame size → the resolution tag it must get
SIZES="i4k:3840x2160:3840 x 2160|idci:4096x2160:3840 x 2160|ipad:1920x1088:1920 x 1080|iport:1080x1920:Portrait 1080 x 1920|iuw:2560x1080:Ultrawide 2560 x 1080|idual:3840x1080:Dual 3840 x 1080|itri:5760x1080:Triple 5760 x 1080|isd:320x180:Standard Definition|i1610:1920x1200:Other resolution|i720:1280x720:1280 x 720"
IDX='{}'
IFS='|' read -ra ROWS <<< "$SIZES"
for row in "${ROWS[@]}"; do
  IFS=: read -r name size _ <<< "$row"
  mkdir -p "$LIB/imported/$name"; vid "$LIB/imported/$name/$name.mp4" "$size"
  IDX=$(jq -c --arg n "$name" '.[$n] = {title: $n}' <<< "$IDX")
done
mkdir -p "$LIB/imported/irot" "$LIB/imported/ipng"
vid "$T/rot0.mp4" 1920x1080 && ffmpeg -nostdin -loglevel error -y -display_rotation 90 -i "$T/rot0.mp4" -c copy "$LIB/imported/irot/irot.mp4"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=2560x1440" -frames:v 1 "$LIB/imported/ipng/ipng.png"
IDX=$(jq -c '.irot = {title: "irot"} | .ipng = {title: "ipng"}' <<< "$IDX")
printf '%s' "$IDX" > "$LIB/imported/index.json"
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"legacy","WorkshopFolder":"$WE","AutoAddWeWallpapersToLibrary":false,"AllowScenes":true,"NoAudio":true}
EOF

LOG=""
start() {   # $1 = log name
  LOG=$T/$1.log
  rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
  (cd /tmp && exec "$DOTNET" "$DLL" serve > "$LOG" 2>&1) & BP=$!
  for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
  U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
  TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
  for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "$U/health" >/dev/null && break; sleep 0.1; done
}
api() { curl -sf -m 10 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
# wait for the $2-th log line matching $1 (≤ $3 s)
waitlog() { local n=${2:-1} t=${3:-60}; for _ in $(seq 1 $((t * 10))); do [ "$(grep -c -- "$1" "$LOG")" -ge "$n" ] && return 0; sleep 0.1; done; return 1; }
lib() { api "$U/library"; }
item() { lib | jq -c --arg k "$1" '[.[] | select(.videoPath | contains("/" + $k + "/") or endswith("/" + $k))][0]'; }
tags() { item "$1" | jq -c '.tags'; }
asks() { grep -c "steam-cm: GetDetails" "$LOG"; }
idx() { jq -c --arg k "$2" ".[\$k]$3" "$LIB/$1/index.json"; }

echo "== 1. Steam's tags, asked once"
start run1
# the pass is over once the frame sizes are read (the last step)
waitlog "library-facts: frame sizes of" 1 90 || bad "the first pass didn't finish in 90 s"
check "one GetDetails request" "$(asks)" 1
check "…of exactly the five untagged Workshop items" "$(grep -o 'fixture: [0-9,]*' "$LOG" | head -1 | tr ',' '\n' | sed 's/fixture: //' | sort | tr '\n' ' ')" "910000001 910000002 910000003 910000004 910000008 "
check "910000001's index entry: Steam's tags" "$(idx local 910000001 .tags)" '["Video","Everyone","3840 x 2160","Anime","Audio responsive"]'
check "…its volume override and title kept" "$(idx local 910000001 '| [.volume, .title]')" '[40,"one"]'
check "910000004 (no such item on Steam): tagsCheckedAt, no tags" "$(idx local 910000004 '| [(.tagsCheckedAt | type), .tags]')" '["number",null]'
check "910000005 (a download) keeps its own tags, never asked" "$(idx local 910000005 .tags)" '["Video","Everyone","1920 x 1080","Anime"]'
check "910000008 (a link with no index entry) gets one, with Steam's tags" "$(idx local 910000008 .tags)" '["Video","Everyone","1920 x 1080","Cyberpunk"]'
check "/library: 910000001's tags" "$(tags 910000001)" '["Video","Everyone","3840 x 2160","Anime","Audio responsive"]'
check "…its age rating and resolution from them" "$(item 910000001 | jq -c '[.ageRating, .resolution]')" '["Everyone","3840 x 2160"]'
check "/library: 910000002 (Portrait, Mature)" "$(item 910000002 | jq -c '[.ageRating, .resolution, (.tags | index("Portrait 1080 x 1920") != null)]')" '["Mature","Portrait 1080 x 1920",true]'

echo "== 2. frame sizes"
for row in "${ROWS[@]}"; do
  IFS=: read -r name size want <<< "$row"
  check "$name ($size) → $want" "$(item "$name" | jq -c --arg w "$want" '[(.tags // [] | index($w) != null), .resolution]')" "[true,\"${size/x/ x }\"]"
done
check "irot (1920x1080 shown rotated 90°) → Portrait 1080 x 1920" "$(item irot | jq -c '[(.tags // [] | index("Portrait 1080 x 1920") != null), .resolution]')" '[true,"1080 x 1920"]'
check "ipng (a 2560x1440 image) → 2560 x 1440" "$(item ipng | jq -c '[(.tags // [] | index("2560 x 1440") != null), .resolution]')" '[true,"2560 x 1440"]'
check "910000003 (Steam: no resolution) → its file's: Standard Definition" "$(item 910000003 | jq -c '[(.tags | index("Standard Definition") != null), .resolution, (.tags | index("Game") != null)]')" '[true,"640 x 360",true]'
check "910000004 (a scene, not on Steam) → its project size, project.json's genre kept" "$(item 910000004 | jq -c '[.tags, .resolution]')" '[["Abstract","2560 x 1440"],"2560 x 1440"]'
check "items with Steam's resolution aren't read" "$(jq -c '[.["910000001","910000002","910000005"].frameSize]' "$LIB/local/index.json")" '[null,null,null]'
check "the frame size cached with its file state" "$(idx imported i4k '| [.frameSize, (.frameSizeOf | test("^[0-9]+:[0-9]+$"))]')" '["3840 x 2160",true]'
stopbe

echo "== 3. a restart asks nothing, reads nothing"
start run2
sleep 6
check "no GetDetails request" "$(asks)" 0
check "no file read" "$(grep -c 'library-facts: frame sizes of' "$LOG")" 0
check "/library still has 910000001's tags" "$(tags 910000001)" '["Video","Everyone","3840 x 2160","Anime","Audio responsive"]'

echo "== 4. a new arrival"
we_item 910000006 video '["Relaxing"]' 640x360 arrival
api -X POST "$U/library/sync" -d '{}' >/dev/null || bad "POST /library/sync"
waitlog "steam-cm: GetDetails" 1 30 || bad "no request for the new arrival"
check "one request, of only its id" "$(grep -o 'GetDetails of [0-9]* id(s).*' "$LOG" | sed 's/, in [0-9]* ms//')" "GetDetails of 1 id(s) — 1 found (fixture: 910000006)"
for _ in $(seq 1 50); do [ "$(idx local 910000006 .tags)" != null ] && break; sleep 0.1; done
check "its tags saved" "$(idx local 910000006 .tags)" '["Video","Everyone","2560 x 1440","Relaxing"]'

echo "== 5. Steam unreachable"
mv "$T/steam-cm.json" "$T/steam-cm.off"
we_item 910000007 video '["Retro"]' 640x360 arrival
n=$(grep -c 'library-facts: frame sizes of' "$LOG")
api -X POST "$U/library/sync" -d '{}' >/dev/null || bad "POST /library/sync"
waitlog "GetDetails of 1 id(s) — no answer" 1 30 || bad "no (failed) request for 910000007"
# its trailer falls to page reading, which fails here (no network), then its file is read
waitlog "library-facts: frame sizes of" $((n + 1)) 60 || bad "the pass didn't finish"
check "nothing stored for it (no tags, no tagsCheckedAt)" "$(idx local 910000007 '| [.tags, .tagsCheckedAt]')" '[null,null]'
check "…its file's size meanwhile" "$(item 910000007 | jq -c '.resolution')" '"640 x 360"'
mv "$T/steam-cm.off" "$T/steam-cm.json"
api -X POST "$U/library/sync" -d '{}' >/dev/null || bad "POST /library/sync"
waitlog "fixture: 910000007" 1 30 || bad "910000007 not asked again once Steam answers"
for _ in $(seq 1 50); do [ "$(idx local 910000007 .tags)" != null ] && break; sleep 0.1; done
check "…then its tags saved" "$(idx local 910000007 .tags)" '["Video","Everyone","Ultrawide 3440 x 1440","Retro"]'
check "…and Steam's resolution shown, not the file's" "$(item 910000007 | jq -c '[.resolution, (.tags | index("Standard Definition"))]')" '["Ultrawide 3440 x 1440",null]'

echo "== 6. a replaced file is read again"
vid "$T/new.mp4" 1280x720 && mv "$T/new.mp4" "$LIB/imported/isd/isd.mp4"
n=$(grep -c 'library-facts: frame sizes of' "$LOG")
api -X POST "$U/library/sync" -d '{}' >/dev/null || bad "POST /library/sync"
waitlog "library-facts: frame sizes of" $((n + 1)) 30 || bad "the replaced file wasn't read again"
check "isd → 1280 x 720 now" "$(item isd | jq -c '[(.tags | index("1280 x 720") != null), (.tags | index("Standard Definition")), .resolution]')" '[true,null,"1280 x 720"]'
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
