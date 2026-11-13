#!/usr/bin/env bash
# Hermetic test of the preview clips following "Video preview quality" (Web/ClipStore.cs § the library follows "Video
# preview quality", Web/LibraryOps.cs): a temp HOME + XDG dirs, no network (`unshare -rn`), a private backend with short
# waits (LIASCAPE_CLIP_SETTLE_MS, LIASCAPE_CLIP_GRACE_MS) and five 1080p library videos.
#  1. debounce: Low → Mid → High within a second, back where it started: nothing is re-made, no file changes.
#  2. down + priority: Mid then Low (the last one wins: the sweep follows Low, never Mid); the item a "card" keeps asking
#     about is re-made first; every clip ends up Low, one file per item, fewer bytes on disk once the old ones' grace is
#     over; the wallpapers' own files untouched; GET /library/ops counted it ("clips", phase low, total 4) and is empty after.
#  3. up, held: the UI holds the sweep (POST /clip/sweep-hold, the Settings tab showing), Mid: nothing starts while held;
#     released, the sweep starts at once and every clip ends up Mid.
#  3b. a hold nobody renews runs out (the lease): Low, held and never released: the sweep starts on its own.
#  4. cancel: High, then Low while a High encode runs: it is stopped, the sweep re-targets, every clip ends up Low.
#  6. the video-loudness pass (normalization turned on) is listed on GET /library/ops while it measures, then dropped.
#  5. restart: High, the backend stopped mid-sweep; the next start resumes it (only what is left) to the end; a card
#     waiting for a new item's first clip goes before the sweep's rest.
#  7. a card's own first clips (the background queue, no sweep): one clip alone lists no operation; three cards asking at
#     once list "clips" (phase make) on GET /library/ops, total 3, done counting up, gone once the queue drains.
#  8. a quality change while the cards' batch runs: the same operation goes on (never ended in between) with the new
#     quality as its phase until the sweep and the cards' clips are done; every clip ends up at the new quality.
# Never touches ~/.config/liascape, ~/.cache or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-clip-sweep.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), ffmpeg, curl, jq, sha256sum. Last line `RESULT pass=N fail=M`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [ -z "${LIASCAPE_SWEEP_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip ffmpeg curl jq sha256sum timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-sweep-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { trap - EXIT INT TERM HUP; case "$T" in /tmp/liascape-sweep-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_SWEEP_T=$T
  timeout -k 10 900 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_SWEEP_T
DLL=$T/backend/liascape-backend.dll
BP=""
stopbe() { [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }; BP=""; }
trap 'stopbe; pkill -P $$ 2>/dev/null' EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export LIASCAPE_CLIP_SETTLE_MS=1000 LIASCAPE_CLIP_GRACE_MS=2000 LIASCAPE_CLIP_RELEASE_MS=500 LIASCAPE_CLIP_HOLD_MS=5000
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

LIB=$XDG_DATA_HOME/liascape/library
CD=$H/.cache/liascape/video_clips
mkdir -p "$LIB/imported" "$T/we"
IDX='{}'
for n in a b c d e; do
  mkdir -p "$LIB/imported/$n"
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 90 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$LIB/imported/$n/$n.mp4" \
    || { echo "ABORT: ffmpeg can't make the fixtures"; exit 2; }
  IDX=$(jq -c --arg n "$n" '.[$n] = {title: $n}' <<< "$IDX")
done
# f: a small video with a 2-minute tone, for the video-loudness pass (case 6); it never gets a clip, so no sweep counts it
mkdir -p "$LIB/imported/f"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=size=320x240:rate=10" -f lavfi -i "sine=frequency=440:duration=120" -shortest \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "$LIB/imported/f/f.mp4" || { echo "ABORT: ffmpeg can't make f"; exit 2; }
IDX=$(jq -c '.f = {title: "f"}' <<< "$IDX")
printf '%s' "$IDX" > "$LIB/imported/index.json"
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"legacy","WorkshopFolder":"$T/we","AutoAddWeWallpapersToLibrary":false,"NoAudio":true,"VideoPreviewQuality":"high"}
EOF
SRC_SUM=$(sha256sum "$LIB"/imported/*/*.mp4 | sha256sum)

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
api() { curl -sf -m 30 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
# wait for the $2-th log line matching $1 (≤ $3 s)
waitlog() { local n=${2:-1} t=${3:-60}; for _ in $(seq 1 $((t * 10))); do [ "$(grep -c -- "$1" "$LOG")" -ge "$n" ] && return 0; sleep 0.1; done; return 1; }
P() { echo "$LIB/imported/$1/$1.mp4"; }
ask() { api "$U/clip?path=$(jq -rn --arg p "$(P "$1")" '$p|@uri')&info=1&w=300&h=300&q=$2"; }
quality() { api -X POST "$U/settings" -d "{\"videoPreviewQuality\":\"$1\"}" >/dev/null || bad "POST /settings $1"; }
id() { printf '%s' "$(P "$1")" | sha256sum | cut -c1-24; }
# the quality (0 low, 1 mid, 2 high) of each item's newest full clip (an older one may wait out its grace), "-" for none
fulls() { local out=""; for n in "${@:-a b c d}"; do
  local q; q=$(ls -t "$CD/$(id "$n")"_*_full.mp4 2>/dev/null | head -1 | sed -E 's/.*_([0-2])_full\.mp4$/\1/'); out+="$n:${q:--} "; done; echo "${out% }"; }
waitq() { local want=$1 t=${2:-120}; for _ in $(seq 1 $((t * 2))); do [ "$(fulls a b c d)" = "$want" ] && return 0; sleep 0.5; done; return 1; }
clipbytes() { du -cb "$CD"/*.mp4 2>/dev/null | tail -1 | cut -f1; }
remade() { grep -c "clips: re-made" "$LOG"; }

start run1
echo "== 0. every item gets its full High clip"
for n in a b c d; do ask $n high >/dev/null; done
for _ in $(seq 1 240); do
  [ "$(fulls a b c d)" = "a:2 b:2 c:2 d:2" ] && break
  for n in a b c d; do ask $n high >/dev/null; done; sleep 0.5   # a card asks again while it waits
done
check "four full High clips" "$(fulls a b c d)" "a:2 b:2 c:2 d:2"
sleep 3 # the stand-ins' grace
HIGH_BYTES=$(clipbytes)

echo "== 1. flipping through the options settles on nothing"
before=$(ls "$CD" | sort | sha256sum)
quality low; sleep 0.3; quality mid; sleep 0.3; quality high
sleep 4
check "no clip re-made" "$(remade)" 0
check "no sweep started" "$(grep -c 'the library follows' "$LOG")" 0
check "the clip files unchanged" "$(ls "$CD" | sort | sha256sum)" "$before"

echo "== 2. down: the last choice, the asked-about item first, the space freed"
quality mid; sleep 0.3; quality low
maxtotal=0; phase=""
for _ in $(seq 1 240); do
  r=$(ask c low); [ -n "$r" ] || true    # the card on screen keeps asking while pending
  o=$(api "$U/library/ops" | jq -c '.ops[] | select(.id == "clips")' 2>/dev/null)
  if [ -n "$o" ]; then phase=$(jq -r .phase <<< "$o"); t=$(jq -r .total <<< "$o"); [ "$t" -gt "$maxtotal" ] && maxtotal=$t; fi
  [ "$(fulls a b c d)" = "a:0 b:0 c:0 d:0" ] && break
  sleep 0.5
done
check "every clip Low" "$(fulls a b c d)" "a:0 b:0 c:0 d:0"
check "the sweep followed Low only (never the Mid in between)" "$(grep -o 'the library follows [A-Za-z]*: [0-9]*' "$LOG" | tr '\n' ' ')" "the library follows low: 4 "
check "the item a card asked about went first" "$(grep 'clips: re-made' "$LOG" | head -1 | grep -o 'for [a-z]*\.mp4')" "for c.mp4"
check "GET /library/ops counted it (clips, low, 4)" "$phase $maxtotal" "low 4"
sleep 4 # the old clips' grace
check "one clip file per item" "$(for n in a b c d; do ls "$CD/$(id $n)"_*.mp4 2>/dev/null | wc -l; done | tr '\n' ' ')" "1 1 1 1 "
LOW_BYTES=$(clipbytes)
if [ "$LOW_BYTES" -lt "$HIGH_BYTES" ]; then ok "space freed: $HIGH_BYTES → $LOW_BYTES bytes"; else bad "no space freed: $HIGH_BYTES → $LOW_BYTES bytes"; fi
check "/library/ops empty once done" "$(api "$U/library/ops" | jq -c '[.ops[] | select(.id == "clips")]')" "[]"
check "the wallpapers' own files untouched" "$(sha256sum "$LIB"/imported/*/*.mp4 | sha256sum)" "$SRC_SUM"

echo "== 3. up, held while Settings shows"
hold() { api -X POST "$U/clip/sweep-hold" -d "{\"hold\":$1}" >/dev/null || bad "POST /clip/sweep-hold $1"; }
hold true
quality mid
sleep 3   # three settles, inside the lease
check "held: no sweep started" "$(grep -c 'the library follows mid' "$LOG")" 0
check "held: the clips still Low" "$(fulls a b c d)" "a:0 b:0 c:0 d:0"
hold false
waitlog 'the library follows mid' 1 3 && ok "released: the sweep started within 3 s" || bad "released: no sweep within 3 s"
waitq "a:1 b:1 c:1 d:1" 180 || true
check "every clip Mid" "$(fulls a b c d)" "a:1 b:1 c:1 d:1"

echo "== 3b. a hold nobody renews runs out"
hold true
quality low
sleep 3
check "held (lease running): no sweep started" "$(grep -c 'the library follows low' "$LOG")" 1   # 1: case 2's
waitlog 'the library follows low' 2 8 && ok "the lease ran out: the sweep started on its own" || bad "the lease ran out: no sweep"
waitq "a:0 b:0 c:0 d:0" 180 || true
check "every clip Low again" "$(fulls a b c d)" "a:0 b:0 c:0 d:0"

echo "== 4. a new choice stops the running sweep and re-targets it"
quality high
waitlog "the library follows high" 1 30 || bad "no High sweep"
waitlog "clips: re-made .* high" 1 120 || bad "no High clip made"
nlow=$(grep -c "the library follows low" "$LOG")   # the earlier cases' Low sweeps
quality low   # one done, the next running (≈ 2 s an encode, longer than the settling)
waitlog "the library follows low" $((nlow + 1)) 30 || bad "no re-target to Low"
check "the running High encode was stopped" "$(grep -c 'clips: stopping a high encode' "$LOG")" 1
waitq "a:0 b:0 c:0 d:0" 180 || true
check "every clip Low after all" "$(fulls a b c d)" "a:0 b:0 c:0 d:0"
n=$(grep -c "clips: re-made .* high" "$LOG")
if [ "$n" -lt 4 ]; then ok "the High sweep didn't run to its end ($n of 4)"; else bad "the High sweep ran to its end ($n of 4)"; fi
check "no unfinished encode left" "$(ls "$CD" | grep -c '\.tmp$')" 0

echo "== 5. a restart resumes the sweep; a waiting card goes first"
quality high
waitlog "the library follows high: 4" 2 30 || bad "no second High sweep"
waitlog "clips: re-made .* high" $((n + 1)) 120 || bad "no High clip made"
stopbe
left=$(fulls a b c d | grep -o ':[01]' | wc -l)
if [ "$left" -gt 0 ] && [ "$left" -lt 4 ]; then ok "stopped mid-sweep ($left of 4 left)"; else bad "stopped mid-sweep? $left of 4 left ($(fulls a b c d))"; fi
start run2
waitlog "the library follows high: $left" 1 30 || bad "the start-up didn't resume the sweep with the $left left ($(grep 'the library follows' "$LOG"))"
ask e high >/dev/null   # a new card: its first full clip waits in the queue
for _ in $(seq 1 240); do [ "$(fulls a b c d)" = "a:2 b:2 c:2 d:2" ] && [ "$(fulls e)" = "e:2" ] && break; ask e high >/dev/null; sleep 0.5; done
check "every clip High after the restart" "$(fulls a b c d)" "a:2 b:2 c:2 d:2"
emade=$(grep -n "clips: made .* for e\.mp4" "$LOG" | head -1 | cut -d: -f1)
lastre=$(grep -n "clips: re-made" "$LOG" | tail -1 | cut -d: -f1)
if [ "$left" -lt 2 ]; then ok "(one item left: nothing to queue behind)"
elif [ -n "$emade" ] && [ -n "$lastre" ] && [ "$emade" -lt "$lastre" ]; then ok "the waiting card's clip went before the sweep's rest"
else bad "the waiting card's clip (line ${emade:-none}) didn't go before the sweep's last (line ${lastre:-none})"; fi
check "the wallpapers' own files still untouched" "$(sha256sum "$LIB"/imported/*/*.mp4 | sha256sum)" "$SRC_SUM"

echo "== 6. the video-loudness pass shows on the progress feed"
( for _ in $(seq 1 600); do api "$U/library/ops" | jq -r '.ops[].id' 2>/dev/null; sleep 0.05; done ) > "$T/ops-seen" &
OPSP=$!
api -X POST "$U/settings" -d '{"normalizeAudio":true}' >/dev/null || bad "POST /settings normalizeAudio"
loudf() { jq -r '.f.loudnessI // empty' "$LIB/imported/index.json"; }
for _ in $(seq 1 600); do [ -n "$(loudf)" ] && break; sleep 0.1; done
sleep 1; kill $OPSP 2>/dev/null; wait $OPSP 2>/dev/null
[ -n "$(loudf)" ] && ok "f measured ($(loudf) LUFS)" || bad "f never measured"
grep -qx "video-loudness" "$T/ops-seen" && ok "/library/ops listed video-loudness while it ran" || bad "/library/ops never listed video-loudness"
check "/library/ops dropped it once done" "$(api "$U/library/ops" | jq -c '[.ops[] | select(.id == "video-loudness")]')" "[]"
stopbe

echo "== 7. a card's own first clips: a batch shows as \"clips\" (make), one clip alone doesn't"
# copies of a: new items (their own paths) with no clip yet
for n in g h i j; do mkdir -p "$LIB/imported/$n"; cp "$(P a)" "$(P $n)"; done
start run3
ask j high >/dev/null
for _ in $(seq 1 240); do [ "$(fulls j)" = "j:2" ] && break; ask j high >/dev/null; sleep 0.5; done
check "one card: its first full clip made" "$(fulls j)" "j:2"
check "one card: no operation listed" "$(grep -c 'library-ops: clips started' "$LOG")" 0
( for _ in $(seq 1 1200); do api "$U/library/ops" | jq -c '.ops[] | select(.id == "clips") | [.done, .total, .phase]' 2>/dev/null; sleep 0.05; done ) > "$T/previews-seen" &
OPSP=$!
asks=(); for n in g h i; do ask $n high >/dev/null & asks+=($!); done; wait "${asks[@]}"
for _ in $(seq 1 240); do [ "$(fulls g h i)" = "g:2 h:2 i:2" ] && break; for n in g h i; do ask $n high >/dev/null; done; sleep 0.5; done
check "three cards: their first full clips made" "$(fulls g h i)" "g:2 h:2 i:2"
waitlog 'library-ops: clips ended' 1 5 || true
sleep 0.5; kill $OPSP 2>/dev/null; wait $OPSP 2>/dev/null
check "three cards: the operation started once" "$(grep -c 'library-ops: clips started' "$LOG")" 1
check "three cards: its phase (make)" "$(jq -rs 'map(.[2]) | unique | join(" ")' "$T/previews-seen")" make
check "three cards: its total" "$(jq -s 'map(.[1]) | max' "$T/previews-seen")" 3
check "three cards: done counted up" "$(jq -s '[.[] | .[0]] | (. == sort) and (unique | length >= 2)' "$T/previews-seen")" true
check "three cards: ended once the queue drained" "$(grep -c 'library-ops: clips ended' "$LOG")" 1
check "/library/ops dropped it" "$(api "$U/library/ops" | jq -c '[.ops[] | select(.id == "clips")]')" "[]"

echo "== 8. a quality change during the cards' batch: one operation from the batch's first clip to the sweep's last"
for n in k l m; do mkdir -p "$LIB/imported/$n"; cp "$(P a)" "$(P $n)"; done
( for _ in $(seq 1 3600); do api "$U/library/ops" | jq -r '.ops[] | select(.id == "clips") | .phase' 2>/dev/null; sleep 0.05; done ) > "$T/phases-seen" &
OPSP=$!
asks=(); for n in k l m; do ask $n high >/dev/null & asks+=($!); done; wait "${asks[@]}"
waitlog 'library-ops: clips started' 2 10 || bad "no batch to change the quality under"
quality low
ALL="a b c d e g h i j k l m"
for _ in $(seq 1 480); do
  [ "$(fulls $ALL)" = "a:0 b:0 c:0 d:0 e:0 g:0 h:0 i:0 j:0 k:0 l:0 m:0" ] && break
  for n in k l m; do ask $n low >/dev/null; done; sleep 0.5   # the cards on screen keep asking at the new quality
done
check "every clip Low, the batch's too" "$(fulls $ALL)" "a:0 b:0 c:0 d:0 e:0 g:0 h:0 i:0 j:0 k:0 l:0 m:0"
waitlog 'library-ops: clips ended' 2 10 || true
sleep 0.5; kill $OPSP 2>/dev/null; wait $OPSP 2>/dev/null
check "one operation throughout (started and ended once more)" "$(grep -c 'library-ops: clips started' "$LOG") $(grep -c 'library-ops: clips ended' "$LOG")" "2 2"
check "its phase: the batch's, then the change's" "$(uniq "$T/phases-seen" | tr '\n' ' ')" "make low "
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
