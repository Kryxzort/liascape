#!/usr/bin/env bash
# Hermetic test of folder import and watched folders (src/backend/Helpers/FolderScanner.cs, Web/FolderImportOps.cs,
# Web/FolderWatch.cs, ImportService.ImportFolderAsync):
#  scan:   POST /library/scan of a fixture tree lists a Wallpaper Engine scene folder and video folder as one item each (their
#          files never on their own), loose mp4 / webm / gif / png / jpg one each, a nested backed-up Workshop folder's every
#          item, a web wallpaper as unsupported, a Workshop id seen twice once, a folder link loop and a second way into a folder
#          adding nothing, a folder it can't read reported (not an error), dot-folders skipped, and what the library already
#          has (the same source imported before, the same Workshop id under local/) as inLibrary. A scan writes nothing.
#  import: POST /library/import-found imports exactly the paths sent: linked (a link to the file / the folder) or copied
#          (the same bytes; a folder copied whole), with titles, scene-ness, Workshop ids and thumbnails; a re-scan says
#          inLibrary; a delete of a linked item or of a copy holding a folder link leaves every source file where it was.
#  watch:  a folder imported with watch on is listed in settings (POST /settings can't change the list), its unticked
#          items never come in; a new file comes in live (inotify) and, with events off, by the periodic pass; a file still
#          being written waits until it settles; a changed file is imported again (a copy follows it); a removed linked item
#          leaves the library and the playlist, a removed copy stays; a folder that is gone or reads as empty removes
#          nothing; an item the user deletes never comes back; a scene waits for "Play scenes"; "Add new wallpapers to the
#          playlist" adds what a watch brings; unwatching keeps the items and stops the pickup.
#  subscribed: a backed-up Workshop folder imported, then its subscription's folder synced (the WE auto-import): one item,
#          no local/ link beside it; deleting either leaves the other's files, and the subscription comes in once the
#          imported item is gone.
#  steam:  Steam's own Workshop folder (a library named in a fake libraryfolders.vdf): scanning it, a parent of it or a link
#          into it lists its items as subscriptions (the user's own file beside them as usual); /library/import-found of every
#          path lands only the user's file, and watching the parent never imports a subscription, old or new: nothing in
#          the library links into Steam's folder and Steam's files are unchanged.
#  presets: Wallpaper Engine's own preset files (scripts/test-fixtures/presets) in a tree scan as one scene item each,
#          `preset` with their base's id; a preset imported (copied or linked) is its own preset item over its base from the
#          same tree, the same way; a base the user unticked never comes (watched or not: "Needs its base scene"), nor one
#          while "Play scenes" is off; a base the library has is reused, a web base is never imported (the preset says why,
#          only when the folder's own project.json names the id) and a scene base of that id landing later makes the preset
#          play; a base not there leaves "Needs its base scene"; in a watched folder a preset waits
#          for "Play scenes", joins the playlist, plays once its base turns up there (the presets' base pass runs), and
#          leaves when its folder goes; a legacy settings file changes none of it; nothing in the tree or the fixtures changes.
#  open:   POST /open/media opens a watched folder's linked file (a stub xdg-open), never a library link to a file outside
#          every root nor a watched folder's file by its own path, and no longer once the folder is unwatched.
# Runs in its own network namespace (`unshare -rn`), a temp HOME + XDG dirs and a private backend whose player is an
# `exit 1` stub (nothing ever plays).
# Never touches ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-folder-import.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), ffmpeg, curl, jq.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_FOLDERS_T:-}" ]; then
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
  T=$(mktemp -d /tmp/liascape-folders-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; chmod -R u+rwx "$T" 2>/dev/null; lp_tmp_done "$T" /tmp/liascape-folders- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_FOLDERS_T=$T
  timeout -k 10 400 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_FOLDERS_T
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
# the backend's xdg-open (POST /open/media): records each call's argv, opens nothing
mkdir -p "$T/bin"; OPENED=$T/xdg-open.log; : > "$OPENED"
printf '#!/bin/sh\n{ printf "argc=%%s\\n" "$#"; for a; do printf "arg=%%s\\n" "$a"; done; } >> %s\n' "'$OPENED'" > "$T/bin/xdg-open"
chmod +x "$T/bin/xdg-open"; export PATH=$T/bin:$PATH
# the player: a stub that never plays (nothing here applies a wallpaper)
printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"; export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }
# wait_for <seconds> <command…>: true once the command succeeds
wait_for() { local n=$(( $1 * 10 )); shift; for _ in $(seq 1 $n); do "$@" && return 0; sleep 0.1; done; return 1; }

LIB=$XDG_DATA_HOME/liascape/library
IMP=$LIB/imported
WE=$T/we/431960
S=$T/src
mkdir -p "$LIB/local" "$WE" "$S"
vid() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=${2:-blue}:s=64x36" -frames:v 2 -c:v libx264 -pix_fmt yuv420p "$1"; }
pic() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=green:s=32x18" -frames:v 1 "$1"; }
scene() { mkdir -p "$1"; printf '{"type":"scene","file":"scene.json","title":"%s"}' "$2" > "$1/project.json"; head -c 16 /dev/zero > "$1/scene.pkg"; pic "$1/preview.jpg"; }
wevid() { mkdir -p "$1"; printf '{"type":"video","file":"v.mp4","title":"%s"%s}' "$2" "${3:+,\"workshopid\":\"$3\"}" > "$1/project.json"; vid "$1/v.mp4"; pic "$1/preview.jpg"; }

# ---- the fixture tree ----
scene "$S/1111111111" "Scene One"
wevid "$S/we-video" "WE Video" 2222222222
mkdir -p "$S/we-web"; printf '{"type":"web","file":"index.html","title":"Web"}' > "$S/we-web/project.json"; echo '<html>' > "$S/we-web/index.html"
vid "$S/loose.mp4"; ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=blue:s=64x36" -frames:v 2 -c:v libvpx-vp9 "$S/clip.webm"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=32x32:rate=4:duration=1" "$S/anim.gif"
pic "$S/still.png"; pic "$S/pic.jpg"; echo notes > "$S/notes.txt"
vid "$S/already.mp4"
mkdir -p "$S/backup"; wevid "$S/backup/3333333333" "Backed Video"; scene "$S/backup/4444444444" "Backed Scene"
scene "$S/backup/dup/1111111111" "Scene One Again"         # the same Workshop id twice: listed once
wevid "$S/backup/5555555555" "Subscribed"                  # the library has it under local/
ln -s .. "$S/backup/loop"                                   # a folder link loop
ln -s "$S/backup/3333333333" "$S/again"                     # a second way into a folder
mkdir -p "$S/.hidden"; vid "$S/.hidden/h.mp4"
# a folder the backend can't read: a 000 folder (when the namespace's root can still read it, a folder owned by the real root)
mkdir -p "$S/locked"; vid "$S/locked/l.mp4"; chmod 000 "$S/locked"
if ls "$S/locked" >/dev/null 2>&1; then
  chmod 755 "$S/locked"; rm -rf "$S/locked"
  for d in /root /proc/1/fd; do ls "$d" >/dev/null 2>&1 || { ln -s "$d" "$S/locked"; break; }; done
fi
LOCKED_OK=$([ -e "$S/locked" ] || [ -L "$S/locked" ] && echo 1 || echo 0)
mkdir -p "$WE/5555555555"; cp -a "$S/backup/5555555555/." "$WE/5555555555/"; ln -s "$WE/5555555555" "$LIB/local/5555555555"
printf '{"5555555555":{"title":"Subscribed","workshopId":"5555555555"}}' > "$LIB/local/index.json"
SRC_SUM=$(cd "$S" && find . -path ./locked -prune -o -type f -print0 2>/dev/null | sort -z | xargs -0 sha1sum | sha1sum)

cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"WorkshopFolder":"$WE","AutoAddWeWallpapersToLibrary":false,"AllowScenes":true,"NoAudio":true}
EOF

LOG=$T/backend.log
startbe() {
  rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
  (cd /tmp && exec env "$@" "$DOTNET" "$DLL" serve >> "$LOG" 2>&1) & BP=$!
  for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
  PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); U=http://127.0.0.1:$PORT
  TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
  for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "$U/health" >/dev/null && break; sleep 0.1; done
}
api() { curl -s -m 30 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
post() { api -X POST "$U$1" -d "$2"; }
lib() { api "$U/library"; }
item() { lib | jq -c --arg t "$1" '[.[] | select(.title == $t)][0]'; }
has() { [ "$(item "$1")" != null ]; }
hasnt() { [ "$(item "$1")" = null ]; }
idle() { [ "$(api "$U/library/ops" | jq '[.ops[] | select(.id == "import")] | length')" = 0 ]; }
meta() { jq -c --arg k "$1" '.[$k] // null' "$IMP/index.json" 2>/dev/null; }

startbe LIASCAPE_WATCH_DEBOUNCE_MS=300 LIASCAPE_WATCH_STABLE_MS=800 LIASCAPE_WATCH_RESCAN_MS=60000

echo "== scan"
post /library/import "$(jq -nc --arg p "$S/already.mp4" '{path: $p, title: "already"}')" >/dev/null
BEFORE=$(cd "$LIB" && find . | sort | sha1sum)
SCAN=$(post /library/scan "$(jq -nc --arg p "$S" '{paths: [$p]}')")
echo "$SCAN" > "$T/scan.txt"
rel() { echo "$SCAN" | jq -c --arg s "$S/" '[.items[] | {p: (.path | ltrimstr($s)), k: .kind, l: .inLibrary}] | sort_by(.p)'; }
check "every item once, by kind, with what the library has" "$(rel)" \
  "$(jq -nc '[{p:"1111111111",k:"scene",l:false},{p:"already.mp4",k:"video",l:true},{p:"anim.gif",k:"gif",l:false},
    {p:"backup/3333333333",k:"video",l:false},{p:"backup/4444444444",k:"scene",l:false},{p:"backup/5555555555",k:"video",l:true},
    {p:"clip.webm",k:"video",l:false},{p:"loose.mp4",k:"video",l:false},{p:"pic.jpg",k:"image",l:false},{p:"still.png",k:"image",l:false},
    {p:"we-video",k:"video",l:false}] | sort_by(.p)')"
check "a web wallpaper unsupported, a Workshop id seen twice once" "$(echo "$SCAN" | jq -c '[.unsupported, .duplicates, .truncated]')" '[1,1,false]'
if [ "$LOCKED_OK" = 1 ]; then
  check "a folder it can't read is reported" "$(echo "$SCAN" | jq -c --arg l "$S/locked" '[.unreadable[] | select(. == $l)] | length')" 1
else bad "no unreadable folder could be made here (proved nothing)"; fi
check "titles and Workshop ids from project.json" "$(echo "$SCAN" | jq -c '[.items[] | select(.folder) | [.title, .workshopId]] | sort')" \
  '[["Backed Scene","4444444444"],["Backed Video","3333333333"],["Scene One","1111111111"],["Subscribed","5555555555"],["WE Video","2222222222"]]'
check "a scan writes nothing" "$(cd "$LIB" && find . | sort | sha1sum)" "$BEFORE"
check "a single file scans as itself" "$(post /library/scan "$(jq -nc --arg p "$S/anim.gif" '{paths: [$p]}')" | jq -c '[.items[] | [.kind, .title]]')" '[["gif","anim"]]'
check "a relative path is no path" "$(post /library/scan '{"paths":["src"]}' | jq -c '.items | length')" 0

echo "== import: link and copy"
P() { jq -nc --args '$ARGS.positional' "$@"; }
post /library/import-found "$(jq -nc --argjson p "$(P "$S/loose.mp4" "$S/we-video" "$S/1111111111" "$S/still.png")" '{paths: $p, copy: false}')" > /dev/null
wait_for 30 idle; wait_for 10 has "Scene One"
check "only the paths sent land" "$(lib | jq -c '[.[].title] | sort')" '["Scene One","Subscribed","WE Video","already","loose","still"]'
check "a linked file is a link to its source" "$(readlink "$IMP/loose/loose.mp4")" "$S/loose.mp4"
check "…with a thumbnail" "$(item loose | jq -r .thumbnailPath)" "$IMP/loose/loose.jpg"
check "a linked Wallpaper Engine folder is a link to it" "$(readlink "$IMP/WE Video") $(readlink "$IMP/Scene One")" "$S/we-video $S/1111111111"
check "the WE video plays its file, with its Workshop id" "$(item "WE Video" | jq -c '[.videoPath, .isScene, .workshopId, .thumbnailPath]')" \
  "[\"$IMP/WE Video/v.mp4\",false,\"2222222222\",\"$IMP/WE Video/preview.jpg\"]"
check "the scene is its folder" "$(item "Scene One" | jq -c '[.videoPath, .isScene, .workshopId]')" "[\"$IMP/Scene One\",true,\"1111111111\"]"
post /library/import-found "$(jq -nc --argjson p "$(P "$S/clip.webm" "$S/backup/3333333333" "$S/pic.jpg")" '{paths: $p, copy: true}')" > /dev/null
wait_for 30 idle; wait_for 10 has "Backed Video"
check "a copied file: the same bytes, no link" "$([ -L "$IMP/clip/clip.webm" ] && echo link || cmp -s "$S/clip.webm" "$IMP/clip/clip.webm" && echo same)" same
check "a copied folder: every file, no link" "$([ -L "$IMP/Backed Video" ] && echo link || diff -r "$S/backup/3333333333" "$IMP/Backed Video" >/dev/null && echo same)" same
check "a jpg becomes the item's png" "$(item pic | jq -r .videoPath)" "$IMP/pic/pic.png"
SCAN2=$(post /library/scan "$(jq -nc --arg p "$S" '{paths: [$p]}')")
check "a re-scan: what landed is in the library" "$(echo "$SCAN2" | jq -c --arg s "$S/" '[.items[] | select(.inLibrary) | .path | ltrimstr($s)] | sort')" \
  '["1111111111","already.mp4","backup/3333333333","backup/5555555555","clip.webm","loose.mp4","pic.jpg","still.png","we-video"]'

echo "== delete never touches a source"
mkdir -p "$T/outside/keep"; echo keep > "$T/outside/keep/k.txt"
wevid "$S/withlink" "With Link"; ln -s "$T/outside/keep" "$S/withlink/extra"
post /library/import-found "$(jq -nc --argjson p "$(P "$S/withlink")" '{paths: $p, copy: true}')" > /dev/null
wait_for 30 idle; wait_for 10 has "With Link"
check "a copy keeps a folder link as a link" "$(readlink "$IMP/With Link/extra")" "$T/outside/keep"
for t in loose "WE Video" "Scene One" "With Link"; do post /library/delete "$(item "$t")" > /dev/null; done
check "deleted: gone from the library" "$(lib | jq -c '[.[].title | select(. == "loose" or . == "WE Video" or . == "Scene One" or . == "With Link")]')" '[]'
check "deleted: the links and the copy are gone" "$(ls "$IMP" | grep -cE '^(loose|WE Video|Scene One|With Link)$')" 0
rm -rf "$S/withlink"
check "every source file is where it was, unchanged" "$(cd "$S" && find . -path ./locked -prune -o -type f -print0 2>/dev/null | sort -z | xargs -0 sha1sum | sha1sum)" "$SRC_SUM"
check "the folder a copy linked to is untouched" "$(cat "$T/outside/keep/k.txt")" keep

echo "== subscribed: an imported Workshop item and Steam's copy of it"
# A backed-up Workshop folder imported, then subscribed to (Steam's folder appears, the WE auto-import runs): one item, the
# imported one; deleting either touches only its own files, and once the imported one is gone the subscription comes in.
BK=$S/backup/4444444444
BK_SUM=$(cd "$BK" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum)
post /library/import-found "$(jq -nc --argjson p "$(P "$BK")" '{paths: $p, copy: false}')" > /dev/null
wait_for 30 idle; wait_for 10 has "Backed Scene"
mkdir -p "$WE/4444444444"; cp -a "$BK/." "$WE/4444444444/"
WE_SUM=$(cd "$WE/4444444444" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum)
post /library/sync '{}' > /dev/null
bywid() { lib | jq -c --arg w "$1" '[.[] | select(.workshopId == $w) | .videoPath]'; }
check "subscribed after an import: one item, the imported one" "$(bywid 4444444444)" "[\"$IMP/Backed Scene\"]"
check "…no local/ link beside it" "$([ -e "$LIB/local/4444444444" ] || [ -L "$LIB/local/4444444444" ] && echo there || echo none)" none
post /library/delete "$(item "Backed Scene")" > /dev/null
check "the imported one deleted: its source and Steam's folder untouched" \
  "$(cd "$BK" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum) $(cd "$WE/4444444444" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum)" "$BK_SUM $WE_SUM"
post /library/sync '{}' > /dev/null
check "…then the subscription comes in as itself" "$(bywid 4444444444) $(readlink "$LIB/local/4444444444")" "[\"$LIB/local/4444444444\"] $WE/4444444444"
post /library/delete "$(item "Backed Scene")" > /dev/null
check "Steam's one deleted: both folders untouched" \
  "$([ -L "$LIB/local/4444444444" ] && echo link) $(cd "$BK" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum) $(cd "$WE/4444444444" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum)" " $BK_SUM $WE_SUM"
rm -rf "$WE/4444444444"

echo "== steam: Steam's own Workshop folder is its subscriptions, never imported"
# a second Steam library, known only through Steam's libraryfolders.vdf (WorkshopDownloader.SteamLibraryRoots)
SL=$T/steamlib2; SWC=$SL/steamapps/workshop/content/431960
mkdir -p "$H/.local/share/Steam/steamapps"
printf '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"%s"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"%s"\n\t}\n}\n' \
  "$H/.local/share/Steam" "$SL" > "$H/.local/share/Steam/steamapps/libraryfolders.vdf"
wevid "$SWC/6666666661" "Steam Video"; scene "$SWC/6666666662" "Steam Scene"; vid "$SL/mine.mp4"
ln -s "$SWC/6666666661" "$T/to-steam"
steamsum() { (cd "$SWC" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum); }
SWC_SUM=$(steamsum)
subs() { post /library/scan "$(jq -nc --arg p "$1" '{paths: [$p]}')" | jq -c --arg s "$SL/" '[.items[] | [(.path | ltrimstr($s)), .subscription]] | sort'; }
check "Steam's Workshop folder: every item a subscription" "$(subs "$SWC")" \
  '[["steamapps/workshop/content/431960/6666666661",true],["steamapps/workshop/content/431960/6666666662",true]]'
check "a parent of it: the subscriptions, the user's own file beside them not one" "$(subs "$SL")" \
  '[["mine.mp4",false],["steamapps/workshop/content/431960/6666666661",true],["steamapps/workshop/content/431960/6666666662",true]]'
check "a link into it: still a subscription" "$(post /library/scan "$(jq -nc --arg p "$T/to-steam" '{paths: [$p]}')" | jq -c '[.items[].subscription]')" '[true]'
check "the scan says the auto-import is off" "$(post /library/scan "$(jq -nc --arg p "$SL" '{paths: [$p]}')" | jq -c .autoImport)" false
post /library/import-found "$(jq -nc --argjson p "$(P "$SWC/6666666661" "$SWC/6666666662" "$T/to-steam" "$SL/mine.mp4")" '{paths: $p, copy: false}')" > /dev/null
wait_for 30 idle; wait_for 10 has mine
intosteam() { find "$LIB" -type l -print0 | xargs -0 -r realpath -m -- | grep -c "^$SL/steamapps/"; }
check "every path sent: only the user's own file lands" "$(lib | jq -c '[.[].title | select(. == "mine" or . == "Steam Video" or . == "Steam Scene")] | sort')" '["mine"]'
check "…nothing in the library links into Steam's folder" "$(intosteam)" 0
post /library/import-found "$(jq -nc --arg w "$SL" '{paths: [], copy: false, watch: $w}')" > /dev/null
wevid "$SWC/6666666663" "Steam New"; vid "$SL/mine2.mp4"
if wait_for 8 has mine2; then ok "a watched folder holding Steam's: the user's new file comes in"; else bad "a watched folder holding Steam's: the user's new file comes in (proved nothing)"; fi
post /library/watched "$(jq -nc --arg w "$SL" '{path: $w}')" > /dev/null; sleep 1.5
check "…no subscription, old or new" "$(lib | jq -c '[.[].title | select(startswith("Steam "))]')" '[]'
check "…nothing links into Steam's folder" "$(intosteam)" 0
post /library/watched "$(jq -nc --arg w "$SL" '{path: $w, remove: true}')" > /dev/null
rm -rf "$SWC/6666666663"
check "Steam's files are unchanged" "$(steamsum)" "$SWC_SUM"
for t in mine mine2; do post /library/delete "$(item "$t")" > /dev/null; done

echo "== watch"
W=$T/watched; mkdir -p "$W/sub"
vid "$W/a.mp4"; vid "$W/b.mp4"; vid "$W/sub/c.mp4"; wevid "$W/7777777777" "Watched WE"
SW=$(post /library/scan "$(jq -nc --arg p "$W" '{paths: [$p]}')")
post /library/import-found "$(jq -nc --arg w "$W" --argjson p "$(P "$W/a.mp4" "$W/sub/c.mp4" "$W/7777777777")" --argjson s "$(P "$W/b.mp4")" \
  '{paths: $p, copy: false, watch: $w, skip: $s}')" > /dev/null
wait_for 30 idle; wait_for 10 has "Watched WE"
check "the folder is watched (link), its unticked item skipped" "$(api "$U/settings" | jq -c --arg w "$W" '[.watchedFolders[] | select(.path == $w) | [.copy, .skip]]')" \
  "[[false,[\"$W/b.mp4\"]]]"
check "its items carry the folder" "$(meta a | jq -r .watchedFrom) $(meta "Watched WE" | jq -r .watchedFrom)" "$W $W"
post /settings '{"watchedFolders":[]}' > /dev/null
check "POST /settings can't change the list" "$(api "$U/settings" | jq '.watchedFolders | length')" 1
sleep 1.5
check "the unticked item never comes in" "$(item b)" null
vid "$W/d.mp4"
if wait_for 8 has d; then ok "a new file comes in live"; else bad "a new file comes in live"; fi
check "…linked" "$(readlink "$IMP/d/d.mp4")" "$W/d.mp4"
# a file still being written: its write time keeps moving; it comes in only once it settles, whole
vid "$T/e.mp4"; head -c 1000 "$T/e.mp4" > "$W/e.mp4"
for _ in $(seq 1 12); do touch "$W/e.mp4"; sleep 0.2; done
check "a file still being written waits" "$(item e)" null
cat "$T/e.mp4" > "$W/e.mp4"
if wait_for 8 has e; then ok "…and comes in once it settles"; else bad "…and comes in once it settles"; fi
# changed: a linked item stays a link and its stamp follows; a copied folder's copy follows
SIG0=$(meta a | jq -r .sourceSig); vid "$W/a.mp4" red
if wait_for 8 bash -c "[ \"\$(jq -r '.a.sourceSig' '$IMP/index.json')\" != '$SIG0' ]"; then ok "a changed file is imported again"; else bad "a changed file is imported again"; fi
check "…still a link" "$(readlink "$IMP/a/a.mp4")" "$W/a.mp4"
# removed: a link leaves the library and the playlist
post /playlist/state "$(jq -nc --arg a "$IMP/a/a.mp4" --arg d "$IMP/d/d.mp4" '{videoPaths: [$a, $d]}')" > /dev/null
# (the library already hides an item whose link dangles: what proves the removal is its index entry going)
rm "$W/d.mp4"
if wait_for 8 bash -c "[ \"\$(jq -c '.d // null' '$IMP/index.json')\" = null ]"; then ok "a removed file's link leaves the library"; else bad "a removed file's link leaves the library"; fi
check "…its folder and its playlist place too" "$([ -e "$IMP/d" ] && echo left || echo gone) $(api "$U/playlist/state" | jq -c '.videoPaths')" \
  "gone [\"$IMP/a/a.mp4\"]"
check "…and no Undo for it" "$(api "$U/library/undo-depth" | jq .depth)" 0
# a removed Wallpaper Engine folder (a link to the folder)
rm -rf "$W/7777777777"
if wait_for 8 bash -c "[ \"\$(jq -c '.[\"Watched WE\"] // null' '$IMP/index.json')\" = null ]"; then ok "a removed WE folder's link leaves the library"; else bad "a removed WE folder's link leaves the library"; fi
check "…its link gone" "$([ -L "$IMP/Watched WE" ] && echo left || echo gone)" gone
# offline: the folder gone, or reads as empty (an unmounted drive's mount point), removes nothing
# (the moved folder's watcher still hears it: a file written there runs a pass of the missing folder; an edit of the
# listed folder runs one of the empty folder in its place)
mv "$W" "$W.off"; vid "$W.off/x.mp4"
if wait_for 8 grep -q "watch: $W: not there" "$LOG"; then ok "a pass found the folder gone"; else bad "a pass found the folder gone (proved nothing)"; fi
check "a folder that is gone removes nothing" "$(meta a | jq -r .watchedFrom) $(meta c | jq -r .watchedFrom)" "$W $W"
mkdir "$W"; post /library/watched "$(jq -nc --arg w "$W" '{path: $w}')" > /dev/null
if wait_for 8 grep -q "watch: $W: reads as empty" "$LOG"; then ok "a pass found the folder empty"; else bad "a pass found the folder empty (proved nothing)"; fi
check "a folder that reads as empty removes nothing" "$(meta a | jq -r .watchedFrom) $(meta c | jq -r .watchedFrom)" "$W $W"
rmdir "$W"; mv "$W.off" "$W"; rm "$W/x.mp4"
# deleted by the user: never comes back
post /library/delete "$(item c)" > /dev/null
touch "$W/sub/c.mp4"; vid "$W/f.mp4"
wait_for 8 has f
check "an item the user deleted never comes back" "$(item c)" null
check "…its source is still there" "$([ -f "$W/sub/c.mp4" ] && echo there)" there
# a scene waits for "Play scenes"
post /settings '{"allowScenes":false}' > /dev/null
scene "$W/8888888888" "Watched Scene"; sleep 2
check "a scene waits while Play scenes is off" "$(item "Watched Scene")" null
post /settings '{"allowScenes":true}' > /dev/null
if wait_for 8 has "Watched Scene"; then ok "…and comes in once it's on"; else bad "…and comes in once it's on"; fi
# "Add new wallpapers to the playlist"
post /settings '{"autoAddLibraryToPlaylist":true}' > /dev/null
vid "$W/g.mp4"
inbar() { [ "$(api "$U/playlist/state" | jq -c --arg g "$1" '[.videoPaths[] | select(. == $g)] | length')" = 1 ]; }
if wait_for 8 inbar "$IMP/g/g.mp4"; then ok "a watched folder's new item joins the playlist"; else bad "a watched folder's new item joins the playlist"; fi
post /settings '{"autoAddLibraryToPlaylist":false}' > /dev/null
# a copy-mode folder: a changed file's copy follows; a removed one's copy stays as the user's own
W2=$T/copied; mkdir -p "$W2"; vid "$W2/h.mp4"; vid "$W2/i.mp4"
post /library/import-found "$(jq -nc --arg w "$W2" --argjson p "$(P "$W2/h.mp4" "$W2/i.mp4")" '{paths: $p, copy: true, watch: $w}')" > /dev/null
wait_for 30 idle; wait_for 10 has i
vid "$W2/h.mp4" red
if wait_for 8 bash -c "cmp -s '$W2/h.mp4' '$IMP/h/h.mp4'"; then ok "a copy follows its changed file"; else bad "a copy follows its changed file"; fi
rm "$W2/i.mp4"
if wait_for 8 bash -c "[ \"\$(jq -r '.i.watchedFrom' '$IMP/index.json')\" = null ]"; then ok "a removed file's copy is no longer the folder's"; else bad "a removed file's copy is no longer the folder's"; fi
check "…and stays in the library" "$(item i | jq -r .videoPath)" "$IMP/i/i.mp4"
echo "== open: a watched folder's linked file in the user's own app"
# POST /open/media: the watched folders count as roots for where a library link resolves (xdg-open: the stub on PATH)
openst() { : > "$OPENED"; api -o /dev/null -w '%{http_code}' -X POST "$U/open/media" -d "$(jq -nc --arg p "$1" '{path: $p}')"; }
opened() { for _ in $(seq 1 30); do [ -s "$OPENED" ] && break; sleep 0.1; done; tr '\n' '|' < "$OPENED"; }
check "a watched folder's linked file opens" "$(openst "$IMP/a/a.mp4")" 200
check "…xdg-open got its file in the watched folder" "$(opened)" "argc=1|arg=$W/a.mp4|"
mkdir -p "$T/outside/media" "$IMP/manual"; vid "$T/outside/media/o.mp4"; ln -s "$T/outside/media/o.mp4" "$IMP/manual/o.mp4"
check "a library link to a file outside every root is still refused" "$(openst "$IMP/manual/o.mp4")" 403
check "a watched folder's file asked for by its own path is refused (only library paths)" "$(openst "$W/a.mp4")" 403
sleep 0.5; check "…nothing was opened" "$(tr '\n' '|' < "$OPENED")" ""
# unwatching keeps the items and stops the pickup
post /library/watched "$(jq -nc --arg w "$W" '{path: $w, remove: true}')" > /dev/null
check "a folder no longer watched is no longer a root" "$(openst "$IMP/a/a.mp4")" 403
rm -rf "$IMP/manual"
vid "$W/j.mp4"; sleep 2
check "unwatched: nothing new comes in" "$(item j)" null
check "…its items stay" "$(item a | jq -r .videoPath)" "$IMP/a/a.mp4"
check "nothing was ever deleted from a watched folder" "$(ls "$W" | sort | tr '\n' ' ')" "8888888888 a.mp4 b.mp4 e.mp4 f.mp4 g.mp4 j.mp4 sub "
stopbe

echo "== watch without events (a mount that sends none): the periodic pass"
startbe LIASCAPE_WATCH_NO_EVENTS=1 LIASCAPE_WATCH_DEBOUNCE_MS=300 LIASCAPE_WATCH_STABLE_MS=500 LIASCAPE_WATCH_RESCAN_MS=1500
vid "$W2/k.mp4"
if wait_for 10 has k; then ok "a new file comes in by the periodic pass"; else bad "a new file comes in by the periodic pass"; fi
stopbe

echo "== presets: a preset folder is its own preset item and brings its base scene from the same tree"
# Wallpaper Engine's own preset files (scripts/test-fixtures/presets: real Workshop ids), each with a synthetic preview.
# Their bases are synthetic: 2932157836 a scene in another folder of the tree, 3419466417 a web wallpaper there (its
# project.json names its id), 3354740764 a scene there too (the user unticks it) and, later, in a watched folder. The
# engine is liascape-player through a stub binary that never plays (presets play only there); the legacy engine's reason
# at the end.
FX=$ROOT/scripts/test-fixtures/presets
PT=$T/presets-tree
fxcopy() {   # $1 = fixture id, $2 = destination folder: the fixture with a preview of its own type
  mkdir -p "$(dirname "$2")"; cp -r "$FX/$1" "$2"
  case "$(jq -r .preview "$2/project.json")" in
    preview.gif) ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=32x18:rate=4:duration=0.5" "$2/preview.gif" ;;
    *) pic "$2/preview.jpg" ;;
  esac
}
pjset() { jq "$2" "$1/project.json" > "$T/pj" && mv "$T/pj" "$1/project.json"; }   # $1 = folder, $2 = jq edit
fxcopy 3009121253 "$PT/presets/3009121253"; fxcopy 3420428971 "$PT/presets/3420428971"; fxcopy 3520333138 "$PT/presets/3520333138"
# fixtures again under folders that are no Workshop id (a user's own copies), retitled: the first one's; the second's over
# a base 900000077 whose folder only its name ties to that id; the third's, imported while "Play scenes" is off
fxcopy 3009121253 "$PT/more/my-copy"; pjset "$PT/more/my-copy" '.title = "Preset fixture 1, my copy"'
fxcopy 3420428971 "$PT/more/named-web"; pjset "$PT/more/named-web" '.title = "Preset fixture 2, named base" | .dependency = "900000077"'
fxcopy 3520333138 "$PT/more/scenes-off"; pjset "$PT/more/scenes-off" '.title = "Preset fixture 3, scenes off"'
scene "$PT/scenes/2932157836" "Base One"; scene "$PT/scenes/3354740764" "Base Three (tree)"
webdir() { mkdir -p "$1"; printf '{"type":"web","file":"index.html","title":"%s"%s}' "$2" "${3:+,\"workshopid\":\"$3\"}" > "$1/project.json"; echo '<html>' > "$1/index.html"; }
webdir "$PT/web/3419466417" "Web Base" 3419466417; webdir "$PT/web2/900000077" "Web By Name"
treesum() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum); }
PT_SUM=$(treesum "$PT"); FX_SUM=$(treesum "$FX")
startbe LIASCAPE_WATCH_DEBOUNCE_MS=300 LIASCAPE_WATCH_STABLE_MS=800 LIASCAPE_WATCH_RESCAN_MS=60000
check "the player binary resolves (the stub)" "$(api "$U/player-engine" | jq -r .available)" true
pr() { item "$1" | jq -c '[.isPreset, .isScene, .presetReason, .basePath]'; }
found() { jq -nc --argjson p "$(P "${@:3}")" --argjson s "$2" --argjson r "$(P "$PT")" --argjson c "$1" '{paths: $p, copy: $c, skip: $s, roots: $r}'; }   # $1 copy, $2 skip (JSON), paths…
SP=$(post /library/scan "$(jq -nc --arg p "$PT" '{paths: [$p]}')")
check "scan: each preset folder is one scene item, a preset naming its base; the base scenes beside; the web ones unsupported" \
  "$(echo "$SP" | jq -c --arg s "$PT/" '[.items[] | [(.path | ltrimstr($s)), .kind, .preset, .baseWorkshopId, .workshopId, .title]] | sort') $(echo "$SP" | jq .unsupported)" \
  '[["more/my-copy","scene",true,"2932157836",null,"Preset fixture 1, my copy"],["more/named-web","scene",true,"900000077",null,"Preset fixture 2, named base"],["more/scenes-off","scene",true,"3354740764",null,"Preset fixture 3, scenes off"],["presets/3009121253","scene",true,"2932157836","3009121253","Preset fixture 1"],["presets/3420428971","scene",true,"3419466417","3420428971","Preset fixture 2"],["presets/3520333138","scene",true,"3354740764","3520333138","Preset fixture 3"],["scenes/2932157836","scene",false,null,"2932157836","Base One"],["scenes/3354740764","scene",false,null,"3354740764","Base Three (tree)"]] 2'
# copied: the preset and its base both ticked (the dialog's default)
post /library/import-found "$(found true '[]' "$PT/presets/3009121253" "$PT/scenes/2932157836")" > /dev/null
wait_for 30 idle; wait_for 10 has "Preset fixture 1"
check "a copied preset: its own preset item, playing over its ticked base" "$(pr "Preset fixture 1")" "[true,true,null,\"$IMP/Base One\"]"
check "…its own path and Workshop id, its own preview" "$(item "Preset fixture 1" | jq -c '[.videoPath, .workshopId, .baseWorkshopId, .thumbnailPath]')" \
  "[\"$IMP/Preset fixture 1\",\"3009121253\",\"2932157836\",\"$IMP/Preset fixture 1/preview.jpg\"]"
check "…the preset and its base are copies (the same files, no link)" \
  "$([ -L "$IMP/Preset fixture 1" ] || [ -L "$IMP/Base One" ] && echo link || { diff -r "$PT/presets/3009121253" "$IMP/Preset fixture 1" >/dev/null && diff -r "$PT/scenes/2932157836" "$IMP/Base One" >/dev/null && echo same; })" same
check "…the base a plain scene item with its Workshop id" "$(item "Base One" | jq -c '[.isScene, (.isPreset // false), .workshopId]')" '[true,false,"2932157836"]'
# linked, no watch: a base that is a web wallpaper, a base the user unticked, a base the library has, a non-scene folder
# that only its name ties to the base's id
post /library/import-found "$(found false "$(P "$PT/scenes/3354740764")" "$PT/presets/3420428971" "$PT/presets/3520333138" "$PT/more/my-copy" "$PT/more/named-web")" > /dev/null
wait_for 30 idle; wait_for 10 has "Preset fixture 2, named base"
check "a linked preset is a link to its folder" "$(readlink "$IMP/Preset fixture 2") $(readlink "$IMP/Preset fixture 3")" "$PT/presets/3420428971 $PT/presets/3520333138"
check "a base that is a web wallpaper: not imported, the preset greyed with why" \
  "$(pr "Preset fixture 2") $(lib | jq -c '[.[] | select(.workshopId == "3419466417")] | length')" '[true,true,"Its base is a web wallpaper, not a scene",null] 0'
check "a base the user unticked (no watch): not imported, the preset needs its base scene" \
  "$(pr "Preset fixture 3") $(item "Base Three (tree)")" '[true,true,"Needs its base scene",null] null'
check "a base the library has is reused (one item of it, from the copy)" \
  "$(pr "Preset fixture 1, my copy") $(lib | jq -c '[.[] | select(.workshopId == "2932157836") | .videoPath]')" "[true,true,null,\"$IMP/Base One\"] [\"$IMP/Base One\"]"
check "a non-scene folder named by the base's id only: no kind saved, the preset needs its base scene" \
  "$(pr "Preset fixture 2, named base") $(meta "Preset fixture 2, named base" | jq -c '.baseKind // null')" '[true,true,"Needs its base scene",null] null'
# "Play scenes" off: a preset sent anyway (the dialog can't tick one then) never brings a base scene the user can't play
post /settings '{"allowScenes":false}' > /dev/null
post /library/import-found "$(found false '[]' "$PT/more/scenes-off")" > /dev/null
wait_for 30 idle
if [ "$(meta "Preset fixture 3, scenes off")" = null ]; then bad "Play scenes off: its base scene stays out (the preset never landed: proved nothing)"
else check "Play scenes off: a preset's base scene stays out of the library" "$(item "Base Three (tree)") $(meta "Base Three (tree)")" "null null"; fi
post /settings '{"allowScenes":true}' > /dev/null
# a watched folder: an unticked base stays out the same way
W4=$T/watched-untick; fxcopy 3420428971 "$W4/p/preset"; pjset "$W4/p/preset" '.title = "Preset fixture 2, watched"'
scene "$W4/b/3419466417" "Base Two (unticked)"
post /library/import-found "$(jq -nc --arg w "$W4" --argjson p "$(P "$W4/p/preset")" --argjson s "$(P "$W4/b/3419466417")" --argjson r "$(P "$W4")" \
  '{paths: $p, copy: false, watch: $w, skip: $s, roots: $r}')" > /dev/null
wait_for 30 idle; wait_for 10 has "Preset fixture 2, watched"; sleep 1.5
check "a base the user unticked (watched): not imported, by the import or the watch; the preset needs its base scene" \
  "$(pr "Preset fixture 2, watched") $(item "Base Two (unticked)")" '[true,true,"Needs its base scene",null] null'
post /library/watched "$(jq -nc --arg w "$W4" '{path: $w, remove: true}')" > /dev/null
# a kind saved for a base (the web folder above) never outlives a scene base of that id landing in the library
scene "$T/late/3419466417" "Base Two"
post /library/import-found "$(jq -nc --argjson p "$(P "$T/late/3419466417")" '{paths: $p, copy: false}')" > /dev/null
wait_for 30 idle; wait_for 10 has "Base Two"
check "a preset saved with a web base: a scene base of its id lands → it plays (so does the other preset of it)" \
  "$(meta "Preset fixture 2" | jq -r .baseKind) $(pr "Preset fixture 2") $(pr "Preset fixture 2, watched")" \
  "web [true,true,null,\"$IMP/Base Two\"] [true,true,null,\"$IMP/Base Two\"]"
# a watched folder: a preset waits for "Play scenes", joins the playlist, needs its base until the base turns up there
W3=$T/watched-presets; mkdir -p "$W3"
post /settings '{"allowScenes":false,"autoAddLibraryToPlaylist":true}' > /dev/null
post /library/import-found "$(jq -nc --arg w "$W3" '{paths: [], copy: false, watch: $w}')" > /dev/null
fxcopy 3583880694 "$W3/3583880694"; sleep 2
check "a watched folder's preset waits while Play scenes is off" "$(item "Preset fixture 4")" null
post /settings '{"allowScenes":true}' > /dev/null
if wait_for 8 has "Preset fixture 4"; then ok "…and comes in once it's on"; else bad "…and comes in once it's on"; fi
check "…a link, needing its base scene" "$(readlink "$IMP/Preset fixture 4") $(pr "Preset fixture 4")" "$W3/3583880694 [true,true,\"Needs its base scene\",null]"
if wait_for 5 inbar "$IMP/Preset fixture 4"; then ok "…and it joins the playlist"; else bad "…and it joins the playlist"; fi
MOVED=$(grep -c "a preset's base scene came, went or moved" "$LOG")
scene "$W3/bases/3354740764" "Base Three"
if wait_for 8 has "Base Three"; then ok "its base turns up in the watched folder: it comes in"; else bad "its base turns up in the watched folder: it comes in"; fi
for _ in $(seq 1 30); do [ "$(item "Preset fixture 4" | jq -c .presetReason)" = null ] && break; sleep 0.1; done
check "…and the preset plays over it, so does the imported preset of the same base" \
  "$(pr "Preset fixture 4") $(pr "Preset fixture 3")" "[true,true,null,\"$IMP/Base Three\"] [true,true,null,\"$IMP/Base Three\"]"
if wait_for 5 bash -c "[ \$(grep -c \"a preset's base scene came, went or moved\" '$LOG') -gt $MOVED ]"; then
  ok "…a running rotation's items follow (the presets' base pass)"; else bad "…a running rotation's items follow (the presets' base pass)"; fi
post /settings '{"autoAddLibraryToPlaylist":false}' > /dev/null
HAD4=$(meta "Preset fixture 4" | jq -r '.watchedFrom // empty')
rm -rf "$W3/3583880694"
if [ "$HAD4" != "$W3" ]; then bad "a removed preset folder's link leaves the library (it never came in: proved nothing)"
elif wait_for 8 bash -c "[ \"\$(jq -c '.[\"Preset fixture 4\"] // null' '$IMP/index.json')\" = null ]"; then ok "a removed preset folder's link leaves the library"; else bad "a removed preset folder's link leaves the library"; fi
check "…and the playlist; its base stays" "$(api "$U/playlist/state" | jq -c --arg p "$IMP/Preset fixture 4" '[.videoPaths[] | select(. == $p)]') $(item "Base Three" | jq -r .videoPath)" "[] $IMP/Base Three"
post /library/watched "$(jq -nc --arg w "$W3" '{path: $w, remove: true}')" > /dev/null
stopbe
jq '.PlayerEngine = "legacy"' "$XDG_CONFIG_HOME/liascape/settings.json" > "$T/s" && mv "$T/s" "$XDG_CONFIG_HOME/liascape/settings.json"
startbe
check "a legacy settings file (PlayerEngine legacy, ignored): an imported preset with its base still plays" \
  "$(pr "Preset fixture 1")" "[true,true,null,\"$IMP/Base One\"]"
check "…a missing base still says so first" "$(item "Preset fixture 2, named base" | jq -c .presetReason)" '"Needs its base scene"'
for t in "Preset fixture 1" "Preset fixture 2" "Preset fixture 1, my copy" "Preset fixture 2, named base" "Base One"; do post /library/delete "$(item "$t")" > /dev/null; done
check "deleted (copies and links): every source file and fixture unchanged" "$(treesum "$PT") $(treesum "$FX")" "$PT_SUM $FX_SUM"
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
