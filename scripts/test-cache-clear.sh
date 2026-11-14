#!/usr/bin/env bash
# Hermetic test of Settings → Housekeeping's cache clear (src/backend/Web/AppOps.cs CacheCategories, ServerHost /cache/*):
#  size:   GET /cache/size answers every category's clearable bytes and count: the regular files directly in its folder,
#          not a writer's temporary (`.tmp`, `.part`, `.tmp<pid>`), a symlink or a subfolder; the backend's caches under
#          ~/.cache/liascape, the player's under $XDG_CACHE_HOME/liascape (set apart from ~/.cache here, so a wrong root shows)
#  refuse: an unknown id (alone or beside a known one), an empty list or a wrong body → 400 and nothing deleted; no token → 401
#  clear:  {ids} deletes exactly those categories' clearable files and answers what each freed and still holds; every other
#          category, the temporaries, symlinks (and what they point at), subfolders, a clip item's `.src` while one of its
#          clips is still encoding, and everything beside the caches (history-*, src, we-ref, settings, the library)
#          stay byte for byte; an id-less body is a 400 like an empty list
#  logs:   the logs category empties a current `*.log` in place (a writer appending to it carries on at the new end) and
#          deletes a rotated `*.log.<n>`; nothing else in the cache root is touched
#  link:   a category folder that is itself a symlink is never followed: size 0, nothing deleted behind it
# Runs in its own network namespace (`unshare -rn`), a temp HOME + XDG dirs and a private backend (legacy engine: no player).
# Never touches ~/.cache/liascape, ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-cache-clear.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), curl, jq, sha256sum.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [ -z "${LIASCAPE_CACHE_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip curl jq timeout sha256sum; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-cache-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { trap - EXIT INT TERM HUP; case "$T" in /tmp/liascape-cache-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_CACHE_T=$T
  timeout -k 10 240 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_CACHE_T
DLL=$T/backend/liascape-backend.dll
BP=""
stopbe() { [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }; BP=""; }
trap 'stopbe' EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/xdg-cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/xdg-cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

BC=$H/.cache/liascape        # the backend's caches (ServerHost.PreviewCacheDir, WallpaperEngineScraper, ClipStore)
PC=$XDG_CACHE_HOME/liascape  # the player's (scene-loudness, media-art, lwe-shaders)
OUT=$T/outside; mkdir -p "$OUT"
mk() { mkdir -p "$(dirname "$1")"; head -c "$2" /dev/urandom > "$1"; }
# the clearable files of each category, with their sizes
declare -A DIR=([thumbs]=$BC/workshop_previews [we-thumbs]=$BC/we_thumbs [clips]=$BC/video_clips
  [scene-loudness]=$PC/scene-loudness [media-art]=$PC/media-art [shaders]=$PC/lwe-shaders)
IT=0123456789abcdef01234567; IB=fedcba9876543210fedcba98   # clip items: IT finished, IB still encoding
mk "${DIR[thumbs]}/a1b2_still320.jpg" 30000;      mk "${DIR[thumbs]}/c3d4_trim.gif" 50000
mk "${DIR[we-thumbs]}/900001.jpg" 20000
# the clips go in once the backend's start-up sweep (ClipStore.Sweep: clips of a missing source go) has run, below
mk "${DIR[scene-loudness]}/00000000000000aa.json" 3000; mk "${DIR[scene-loudness]}/00000000000000bb.json" 4000
mk "${DIR[media-art]}/00000000000000cc" 90000
mk "${DIR[shaders]}/1111.unit" 8000; mk "${DIR[shaders]}/2222.glsl" 9000
# a writer's file in progress in each: never counted, never deleted
KEEP=("${DIR[we-thumbs]}/900002.jpg.tmp"
  "${DIR[scene-loudness]}/00000000000000dd.tmp4242" "${DIR[media-art]}/00000000000000ee.part" "${DIR[shaders]}/3333.glsl.77.1.tmp")
for f in "${KEEP[@]}"; do [ -e "$f" ] || mk "$f" 5000; done
# a symlink and a subfolder in every category, and what's beside the categories
mk "$OUT/target.bin" 7777
mkdir -p "${DIR[clips]}"
links() { ln -s "$OUT/target.bin" "${DIR[$1]}/link.jpg"; mk "${DIR[$1]}/sub/inner.bin" 1234; KEEP+=("${DIR[$1]}/link.jpg" "${DIR[$1]}/sub/inner.bin"); }
for c in "${!DIR[@]}"; do [ "$c" = clips ] || links "$c"; done
for f in "$BC/liascape-player-serve.log" "$BC/freeze.log" "$BC/history-backup/h.json" "$BC/src/x.c" "$BC/we-ref/r.txt" \
  "$BC/playlist.txt" "$PC/steam-cooldown.json" "$PC/other/o.bin" "$H/.local/share/liascape/library/imported/v/v.mp4"; do mk "$f" 2222; KEEP+=("$f"); done
mk "$BC/freeze.log.1" 3333; KEEP+=("$BC/freeze.log.1")   # a rotated log: kept until the logs category is cleared
KEEP+=("$OUT/target.bin")
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"legacy","AutoAddWeWallpapersToLibrary":false,"NoAudio":true}
EOF
KEEP+=("$XDG_CONFIG_HOME/liascape/settings.json")
sums() { for f in "${KEEP[@]}"; do if [ -L "$f" ]; then printf 'L %s %s\n' "$f" "$(readlink "$f")"; else sha256sum "$f" 2>/dev/null || echo "MISSING $f"; fi; done; }
# the clearable files, per category
files() { case $1 in
  thumbs) echo "${DIR[thumbs]}/a1b2_still320.jpg ${DIR[thumbs]}/c3d4_trim.gif" ;;
  we-thumbs) echo "${DIR[we-thumbs]}/900001.jpg" ;;
  clips) echo "${DIR[clips]}/${IT}_aaaaaaaa_480_1_full.mp4 ${DIR[clips]}/${IT}_aaaaaaaa_320_1_short.mp4 ${DIR[clips]}/$IT.src ${DIR[clips]}/${IB}_bbbbbbbb_320_1_short.mp4" ;;
  scene-loudness) echo "${DIR[scene-loudness]}/00000000000000aa.json ${DIR[scene-loudness]}/00000000000000bb.json" ;;
  media-art) echo "${DIR[media-art]}/00000000000000cc" ;;
  shaders) echo "${DIR[shaders]}/1111.unit ${DIR[shaders]}/2222.glsl" ;;
esac; }
want_size() { local b=0 n=0 f; for f in $(files "$1"); do [ -f "$f" ] || continue; b=$((b + $(stat -c %s "$f"))); n=$((n + 1)); done; echo "$b $n"; }
present() { local n=0 f; for f in $(files "$1"); do [ -e "$f" ] && n=$((n + 1)); done; echo $n; }
ALL="thumbs we-thumbs clips scene-loudness media-art shaders"
: > "${DIR[clips]}/sweep-marker"   # an unknown name: the start-up sweep deletes it

LOG=$T/backend.log
(cd /tmp && exec "$DOTNET" "$DLL" serve > "$LOG" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); U=http://127.0.0.1:$PORT
TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "$U/health" >/dev/null && break; sleep 0.1; done
for _ in $(seq 1 100); do [ -e "${DIR[clips]}/sweep-marker" ] || break; sleep 0.1; done
[ -e "${DIR[clips]}/sweep-marker" ] && bad "the backend's start-up clip sweep never ran"
mk "${DIR[clips]}/${IT}_aaaaaaaa_480_1_full.mp4" 400000; mk "${DIR[clips]}/${IT}_aaaaaaaa_320_1_short.mp4" 60000
printf '/lib/a.mp4' > "${DIR[clips]}/$IT.src"
mk "${DIR[clips]}/${IB}_bbbbbbbb_320_1_short.mp4" 70000; printf '/lib/b.mp4' > "${DIR[clips]}/$IB.src"
mk "${DIR[clips]}/${IB}_bbbbbbbb_480_1_full.mp4.tmp" 5000
KEEP+=("${DIR[clips]}/${IB}_bbbbbbbb_480_1_full.mp4.tmp" "${DIR[clips]}/$IB.src"); links clips
KEEPSUM=$(sums)
declare -A W0; for c in $ALL; do W0[$c]=$(want_size "$c"); done
api() { curl -s -m 10 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
postc() { api -o "$T/body" -w '%{http_code}' -X POST "$U$1" -d "$2"; }
sizes() { api "$U/cache/size"; }
cat_size() { echo "$1" | jq -r --arg c "$2" '.categories[]? | select(.id == $c) | "\(.bytes) \(.count)"'; }

echo "== size: every category's clearable bytes, each under its writer's root"
S=$(sizes)
check "/cache/size lists the seven categories" "$(echo "$S" | jq -c '[.categories[]?.id] | sort')" '["clips","logs","media-art","scene-loudness","shaders","thumbs","we-thumbs"]'
for c in $ALL; do check "…$c: ${W0[$c]% *} bytes in ${W0[$c]#* } files (no temporaries, links or subfolders)" "$(cat_size "$S" "$c")" "${W0[$c]}"; done

echo "== refuse: bad requests delete nothing"
check "an unknown id → 400" "$(postc /cache/clear '{"ids":["nope"]}')" 400
check "…the answer names it" "$(jq -r .error "$T/body")" "unknown cache: nope"
check "an unknown id beside a known one → 400" "$(postc /cache/clear '{"ids":["thumbs","../../.config"]}')" 400
check "an empty list → 400" "$(postc /cache/clear '{"ids":[]}')" 400
check "no ids at all → 400" "$(api -o /dev/null -w '%{http_code}' -X POST "$U/cache/clear")" 400
check "a list of the wrong type → 400" "$(postc /cache/clear '{"ids":"thumbs"}')" 400
check "no token → 401" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' "$U/cache/clear" -d '{"ids":["thumbs"]}')" 401
check "a foreign Origin → 403" "$(api -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://evil.example' "$U/cache/clear" -d '{"ids":["thumbs"]}')" 403
n=0; for c in $ALL; do n=$((n + $(present "$c"))); done
check "…every clearable file still there" "$n" 12

echo "== clear: only the ticked categories go"
check "{ids: [clips, scene-loudness]} → 200" "$(postc /cache/clear '{"ids":["clips","scene-loudness"]}')" 200
R=$(cat "$T/body")
check "…clips: freed what it held, nothing left" "$(echo "$R" | jq -c '.categories[] | select(.id == "clips") | [.freedBytes, .count, .bytes]')" "[${W0[clips]% *},${W0[clips]#* },0]"
check "…scene-loudness: freed what it held, nothing left" "$(echo "$R" | jq -c '.categories[] | select(.id == "scene-loudness") | [.freedBytes, .count, .bytes]')" "[${W0[scene-loudness]% *},${W0[scene-loudness]#* },0]"
check "…the totals add up" "$(echo "$R" | jq -c '[.freedBytes, .count]')" "[$(( ${W0[clips]% *} + ${W0[scene-loudness]% *} )),$(( ${W0[clips]#* } + ${W0[scene-loudness]#* } ))]"
check "…their files are gone" "$(present clips) $(present scene-loudness)" "0 0"
for c in thumbs we-thumbs media-art shaders; do check "…$c untouched" "$(want_size "$c")" "${W0[$c]}"; done
check "…temporaries, links, subfolders, the encoding clip's .src and everything beside the caches unchanged" "$(sums)" "$KEEPSUM"
S=$(sizes)
check "/cache/size now reads clips and scene-loudness empty" "$(cat_size "$S" clips) / $(cat_size "$S" scene-loudness)" "0 0 / 0 0"

echo "== logs: current logs emptied in place, rotated ones deleted"
L="$BC/liascape-player-serve.log"
exec 3>>"$L"; printf 'before\n' >&3          # a writer appending, like the player's serve log
KEEPNOLOG=(); for f in "${KEEP[@]}"; do case "$f" in *.log|*.log.[0-9]*) ;; *) KEEPNOLOG+=("$f") ;; esac; done
sumsnl() { for f in "${KEEPNOLOG[@]}"; do if [ -L "$f" ]; then printf 'L %s %s\n' "$f" "$(readlink "$f")"; else sha256sum "$f" 2>/dev/null || echo "MISSING $f"; fi; done; }
NL0=$(sumsnl)
check "{ids: [logs]} → 200" "$(postc /cache/clear '{"ids":["logs"]}')" 200
check "…the current logs are still there, empty" "$(stat -c %s "$L" "$BC/freeze.log" | tr '\n' ' ')" "0 0 "
check "…the rotated log is gone" "$([ -e "$BC/freeze.log.1" ] && echo there || echo gone)" gone
printf 'after\n' >&3; exec 3>&-
check "…the writer carries on at the new end (no hole)" "$(cat "$L")" "after"
check "…nothing else in the cache root or beside it touched" "$(sumsnl)" "$NL0"

echo "== link: a category folder that is a symlink is never followed"
mkdir -p "$OUT/art"; mk "$OUT/art/precious.bin" 4321; PS=$(sha256sum "$OUT/art/precious.bin")
mv "${DIR[media-art]}" "$T/media-art.real"; ln -s "$OUT/art" "${DIR[media-art]}"
check "/cache/size reads it empty" "$(cat_size "$(sizes)" media-art)" "0 0"
check "{ids: [media-art]} → 200, nothing freed" "$(postc /cache/clear '{"ids":["media-art"]}') $(jq -c '[.freedBytes, .count]' "$T/body")" "200 [0,0]"
check "…the folder it points at untouched" "$(sha256sum "$OUT/art/precious.bin")" "$PS"
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
