#!/usr/bin/env bash
# Hermetic test of the previews made ahead of their cards (Web/PreviewBackfill.cs on ClipStore's worker): a temp HOME + XDG
# dirs, no network (`unshare -rn`), a private backend and nine library items (a video, a 1280×720 still and a gif each; x's
# still is broken). The hold's signals are stood in for by a file (LIASCAPE_PREVIEW_HOLD_FILE: its words while it exists).
#  1. held: started with the hold on, nothing is made, GET /previews/status names why, no operation is listed.
#  2. released: every card's still is made (only the still: "Never animate"), the card on screen first, then the Library's
#     order; x's broken still fails once and is remembered; the progress line ("clips", phase make) counts it and goes.
#  3. restart: nothing made again, x not tried again (its file unchanged).
#  4. x's file replaced: its still is made on the next plan (a sync).
#  5. "On hover" reaches the gif: every gif is trimmed, live (no restart).
#  6. "Not hovered" reaches the video: every item's clip at the card's box (after a restart the page reports it again),
#     every ffmpeg niced (19); a hold mid-way stops the running encode and starts nothing more; released, the rest is made.
#  7. "Play GIF previews as videos": off, no gif's clip was made; on (live), every gif's clip instead of its trimmed gif, a
#     card asking for one gets it at once while the queue is held, the queue's niced; the black lead cut; after a restart
#     nothing made again and the card gets the same clip; off again (live), the trimmed gifs come back, the clips stay.
# Never touches ~/.config/liascape, ~/.cache or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-preview-backfill.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), ffmpeg, curl, jq. Last line `RESULT pass=N fail=M`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_BACKFILL_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip ffmpeg curl jq timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-backfill-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-backfill- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_BACKFILL_T=$T
  timeout -k 10 600 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_BACKFILL_T
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
# the player: an `exit 1` stub, so no real liascape-player ever starts here
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
export LIASCAPE_CLIP_SETTLE_MS=500 LIASCAPE_CLIP_GRACE_MS=2000 LIASCAPE_PREVIEW_HOLD_FILE=$T/hold LIASCAPE_PREVIEW_HOLD_POLL_MS=300
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

LIB=$XDG_DATA_HOME/liascape/library
PC=$H/.cache/liascape/workshop_previews
CD=$H/.cache/liascape/video_clips
ITEMS="a b c d e f g h x"
mkdir -p "$LIB/imported" "$T/we" "$T/fx"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 90 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$T/fx/v.mp4" \
  && ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=1280x720" -frames:v 1 "$T/fx/s.jpg" \
  && ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=black:size=160x90:rate=10:d=0.3" -f lavfi -i "testsrc2=size=160x90:rate=10:d=1.5" \
       -filter_complex "[0][1]concat=n=2:v=1" "$T/fx/p.gif" \
  || { echo "ABORT: ffmpeg can't make the fixtures"; exit 2; }
IDX='{}'
for n in $ITEMS; do
  mkdir -p "$LIB/imported/$n"
  cp "$T/fx/v.mp4" "$LIB/imported/$n/$n.mp4"
  if [ $n = x ]; then head -c 4096 /dev/urandom > "$LIB/imported/$n/$n.jpg"; else cp "$T/fx/s.jpg" "$LIB/imported/$n/$n.jpg"; cp "$T/fx/p.gif" "$LIB/imported/$n/$n.gif"; fi
  IDX=$(jq -c --arg n "$n" '.[$n] = {title: $n}' <<< "$IDX")
done
printf '%s' "$IDX" > "$LIB/imported/index.json"
NEVER='["image","gif","video"]'
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"WorkshopFolder":"$T/we","AutoAddWeWallpapersToLibrary":false,"NoAudio":true,"VideoPreviewQuality":"low",
 "PreviewOnHover":$NEVER,"PreviewNotHovered":$NEVER}
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
api() { curl -sf -m 30 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
waitlog() { local n=${2:-1} t=${3:-60}; for _ in $(seq 1 $((t * 10))); do [ "$(grep -c -- "$1" "$LOG")" -ge "$n" ] && return 0; sleep 0.1; done; return 1; }
P() { echo "$LIB/imported/$1/$1.mp4"; }
uri() { jq -rn --arg p "$1" '$p|@uri'; }
status() { api "$U/previews/status?path=$(uri "$(P "$1")")"; }
missing() { local out=""; for n in "$@"; do out+="$n:$(status "$n" | jq -r '.item.missing | join("+")') "; done; echo "${out% }"; }
ORDER=$(for n in $ITEMS; do P $n; done | jq -R . | jq -sc .)
seen() { api -X POST "$U/previews/seen" -d "{\"visible\":[\"$(P "$1")\"],\"side\":null,\"order\":$ORDER,\"box\":{\"w\":400,\"h\":240}}" >/dev/null || bad "POST /previews/seen"; }
settings() { api -X POST "$U/settings" -d "$1" >/dev/null || bad "POST /settings $1"; }
NONE="a: b: c: d: e: f: g: h: x:"
opswatch() { ( for _ in $(seq 1 1200); do api "$U/library/ops" | jq -c '.ops[] | select(.id == "clips") | [.done, .total, .phase]' 2>/dev/null; sleep 0.05; done ) > "$T/$1" & OPSP=$!; }
opsstop() { kill $OPSP 2>/dev/null; wait $OPSP 2>/dev/null; }

echo "== 1. held: nothing is made"
echo "test hold" > "$T/hold"
start run1
seen e
opswatch ops1
sleep 5
check "nothing made while held" "$(grep -c 'previews: made' "$LOG")" 0
check "the status names the hold" "$(api "$U/previews/status" | jq -r .held)" "test hold"
check "what is missing: every still" "$(missing $ITEMS)" "a:still b:still c:still d:still e:still f:still g:still h:still x:still"
check "no operation listed while held" "$(wc -l < "$T/ops1")" 0

echo "== 2. released: every still, the card on screen first, x's failure remembered"
rm -f "$T/hold"
waitlog 'previews: going on' 1 15 && ok "resumed by itself" || bad "never resumed"
for _ in $(seq 1 300); do [ "$(missing $ITEMS)" = "$NONE" ] && break; sleep 0.2; done
opsstop
check "nothing missing" "$(missing $ITEMS)" "$NONE"
check "the card on screen first, then the Library's order" "$(grep -o 'previews: made still for [a-z]\.mp4' "$LOG" | head -3 | grep -o '[a-z]\.mp4' | tr '\n' ' ')" "e.mp4 a.mp4 b.mp4 "
check "x's still failed once" "$(grep -c "can't make the still of .*/x\.jpg" "$LOG")" 1
check "x's still failed, remembered" "$(status x | jq -c .item.failed)" '["still"]'
check "only stills (Never animate): no gif, no clip" "$(ls "$PC" | grep -c '_trim\.gif$') $(ls "$CD" 2>/dev/null | grep -c '\.mp4$')" "0 0"
check "8 stills at the card's width" "$(ls "$PC" | grep -c '_still640\.jpg$')" 8
if [ "$(jq -s 'map(.[1]) | max // 0' "$T/ops1")" -ge 2 ] && [ "$(jq -rs 'map(.[2]) | unique | join(" ")' "$T/ops1")" = make ]; then ok "the line counted it (clips, make, total $(jq -s 'map(.[1]) | max' "$T/ops1"))"
else bad "the line: $(head -c 300 "$T/ops1")"; fi
waitlog 'library-ops: clips ended' 1 5 && ok "the line went once done" || bad "the line never ended"

echo "== 3. a restart: nothing made again, x not tried again"
stopbe; start run2; seen a
sleep 6
check "nothing made" "$(grep -c 'previews: made' "$LOG")" 0
check "nothing planned" "$(grep -c 'previews: .* item(s) to make' "$LOG")" 0
check "x not tried again" "$(grep -c "can't make" "$LOG")" 0
check "no operation" "$(grep -c 'library-ops: clips started' "$LOG")" 0

echo "== 4. x's file replaced: made on the next plan"
cp "$T/fx/s.jpg" "$LIB/imported/x/x.jpg"
api -X POST "$U/library/sync" >/dev/null || bad "POST /library/sync"
waitlog 'previews: made still for x' 1 20 && ok "x's new still made" || bad "x's new still not made"
check "x: nothing missing or failed" "$(status x | jq -c '[.item.missing, .item.failed]')" "[[],[]]"

echo "== 5. \"On hover\" reaches the gif: every gif trimmed, live"
settings '{"previewOnHover":["gif","video","image"]}'
for _ in $(seq 1 300); do [ "$(ls "$PC" | grep -c '_trim\.gif$')" -ge 8 ] && break; sleep 0.2; done
check "8 trimmed gifs" "$(ls "$PC" | grep -c '_trim\.gif$')" 8
check "nothing missing" "$(missing $ITEMS)" "$NONE"

echo "== 6. \"Not hovered\" reaches the video: every clip, niced; a hold stops it mid-way"
( for _ in $(seq 1 1200); do ps -eo ni=,args= | grep "[f]fmpeg .*$T" | awk '{print $1}'; sleep 0.05; done > "$T/nice" ) & NP=$!
opswatch ops6
settings '{"previewNotHovered":["video","gif","image"]}'
waitlog 'ahead of its card' 2 60 || bad "no clips made"
# the hold comes while a clip encodes (a game starting mid-way)
for _ in $(seq 1 200); do ps -eo args= | grep -q "[f]fmpeg .*$T.*_full\.mp4\.tmp" && break; sleep 0.05; done
echo "game" > "$T/hold"
waitlog 'previews: waiting (game)' 1 10 && ok "held mid-way" || bad "not held"
sleep 1; n=$(grep -c 'ahead of its card' "$LOG")
sleep 4
check "nothing more made while held" "$(grep -c 'ahead of its card' "$LOG")" "$n"
if [ "$n" -lt 9 ]; then ok "held before the end ($n of 9)"; else bad "the queue ran to its end before the hold — proved nothing"; fi
check "the status names it" "$(api "$U/previews/status" | jq -r .held)" game
rm -f "$T/hold"
for _ in $(seq 1 600); do [ "$(missing $ITEMS)" = "$NONE" ] && break; sleep 0.3; done
opsstop; kill $NP 2>/dev/null; wait $NP 2>/dev/null
check "every clip made" "$(missing $ITEMS)" "$NONE"
check "9 clips, one each" "$(ls "$CD" | grep -c '_full\.mp4$')" 9
check "every ffmpeg niced 19" "$(sort -u "$T/nice" | tr '\n' ' ')" "19 "
check "the running encode was stopped by the hold (and made after)" "$(grep -c 'previews: stopped the clip of .*(game)' "$LOG")" 1
check "no unfinished encode left" "$(ls "$CD" | grep -c '\.tmp$')" 0
stopbe

echo "== 7. \"Play GIF previews as videos\": each gif's clip instead of its trimmed gif, a card's first, niced, kept, live both ways"
G() { echo "$LIB/imported/$1/$1.gif"; }
gifclips() { local c=0 f; for f in "$CD"/*.src; do grep -q '\.gif$' "$f" && c=$((c + 1)); done; echo $c; }
start run3; seen a
check "off (steps 5-6): no gif's clip made" "$(gifclips)" 0
rm -f "$PC"/*_trim.gif
echo "test hold" > "$T/hold"
settings '{"gifPreviewsAsVideo":true}'
waitlog 'previews: .* item(s) to make (settings)' 1 10 || bad "no plan after the switch"
check "on: every gif's clip missing, never its trimmed gif" "$(missing $ITEMS)" "a:gifclip b:gifclip c:gifclip d:gifclip e:gifclip f:gifclip g:gifclip h:gifclip x:"
# a card asking makes its own at once, the queue held (a ≤ 10 s gif's full clip is as quick as a stand-in)
r=$(api "$U/clip?path=$(uri "$(G a)")&w=400&h=240&q=low&info=1")
check "a card's gif clip, made on its request while the queue is held" "$(jq -c '[.full, (.v != null)]' <<< "$r")" "[true,true]"
check "a: nothing missing" "$(missing a)" "a:"
check "the queue made nothing while held" "$(grep -c 'previews: made' "$LOG")" 0
( for _ in $(seq 1 1200); do ps -eo ni=,args= | grep "[f]fmpeg .*$T" | awk '{print $1}'; sleep 0.05; done > "$T/nice7" ) & NP=$!
rm -f "$T/hold"
for _ in $(seq 1 300); do [ "$(missing $ITEMS)" = "$NONE" ] && break; sleep 0.2; done
kill $NP 2>/dev/null; wait $NP 2>/dev/null
check "every gif's clip made" "$(missing $ITEMS)" "$NONE"
check "8 gif clips" "$(gifclips)" 8
check "7 by the queue (a's was the card's)" "$(grep -c 'previews: made gif clip for' "$LOG")" 7
check "the queue's ffmpeg niced 19" "$(sort -u "$T/nice7" | tr '\n' ' ')" "19 "
check "no trimmed gif made while on" "$(ls "$PC" | grep -c '_trim\.gif$')" 0
# the gif's 0.3 s fade-from-black is cut, as /anim's trim cuts it: the clip starts on a picture and runs ~1.5 s
ac=$(ls -t "$CD"/*_full.mp4 | while read -r f; do b=$(basename "$f"); src=$(cat "$CD/${b%%_*}.src" 2>/dev/null); [ "$src" = "$(G a)" ] && { echo "$f"; break; }; done)
y=$(ffmpeg -nostdin -hide_banner -i "$ac" -vf signalstats,metadata=print:key=lavfi.signalstats.YAVG -frames:v 1 -f null - 2>&1 | grep -o 'YAVG=[0-9.]*' | head -1 | cut -d= -f2)
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$ac")
if awk -v y="${y:-0}" -v d="${d:-0}" 'BEGIN { exit !(y > 30 && d > 1.3 && d < 1.65) }'; then ok "a's clip starts past the black (first frame Y $y, $d s)"
else bad "a's clip: first frame Y ${y:-?}, ${d:-?} s (want > 30, 1.3-1.65 s: the black lead cut)"; fi
stopbe; start run4; seen a
sleep 5
check "after a restart: nothing made again" "$(grep -c 'previews: made\|item(s) to make' "$LOG")" 0
check "the card gets the same clip" "$(api "$U/clip?path=$(uri "$(G a)")&w=400&h=240&q=low&info=1" | jq -r .v)" "$(jq -r .v <<< "$r")"
settings '{"gifPreviewsAsVideo":false}'
for _ in $(seq 1 300); do [ "$(ls "$PC" | grep -c '_trim\.gif$')" -ge 8 ] && break; sleep 0.2; done
check "off again, live: the 8 trimmed gifs made" "$(ls "$PC" | grep -c '_trim\.gif$')" 8
check "off: nothing missing" "$(missing $ITEMS)" "$NONE"
check "the gif clips stay (on again shows them at once)" "$(gifclips)" 8
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
