#!/usr/bin/env bash
# Hermetic test of Wallpaper Engine presets in the library (src/backend/Helpers/Presets.cs, LibraryService):
#  1. library: a preset folder (project.json: no `type`, a `preset` object, the base's Workshop id as `dependency`) lists
#     as its own scene item (`isPreset`, `baseWorkshopId`, its own title and preview, nothing borrowed from the base),
#     linked to its base scene by Workshop id whatever form the base has (a `local/<id>` link, the library's own copy at
#     that path once Steam's folder is gone, `workshop/<id>`, an `imported/` folder with that Workshop id), greyed with
#     its reason when it can't play (no base, a malformed preset file, a base that is a preset / a video / a web
#     wallpaper, the legacy engine); the WE auto-import brings presets in only with scene support on; a preset added from
#     Browse's "Wallpaper Engine (Local)" brings its base from that folder the same way (a link), one whose base isn't
#     there needs it, one whose base there is a web wallpaper says so (never added); trashing a preset leaves its base alone.
#  2. layered properties (SceneProperties): a preset's sidebar lists its base's properties with the preset's values as
#     their defaults (conditions read them too); the card's own tweaks go to the preset's index entry only (a tweak equal
#     to the preset's value drops, Reset returns to it); the base's tweaks never reach the preset or the other way round;
#     no base → no properties and a tweak is refused. Loudness per item: a preset's offline estimate runs on its base's
#     folder with its merged map and lands under its own path (the stub player answers `scene-loudness`). A bool saved
#     as 0 / 1 reads as false / true. Preset images: a scenetexture value `files/<name>` goes to the player as the image's
#     real path inside the preset's own folder; a path out of it, a link out, not an image or a missing file sends nothing.
#  3. the base trashed: its presets read "Needs its base scene" and the WebSocket says `library-synced`; Undo makes them
#     playable again (playing them: the adapter IT § presets).
# Runs in its own network namespace (`unshare -rn`) with a temp HOME + XDG dirs and a private backend whose Steam servers
# are an empty fixture (LIASCAPE_STEAM_CM_FIXTURE) and which refuses every real server (LIASCAPE_TEST_NO_NETWORK=1). The
# engine is liascape-player through a stub binary that never runs (nothing is played here); the base scene is synthetic.
# Never touches ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-presets.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), ffmpeg, curl, jq, flock. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_PRESETS_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip ffmpeg curl jq flock timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-presets-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-presets- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_PRESETS_T=$T LIASCAPE_PRESETS_FIXTURES=$ROOT/scripts/test-fixtures/presets
  timeout -k 10 300 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_PRESETS_T
FX=$LIASCAPE_PRESETS_FIXTURES
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
export LIASCAPE_TEST_NO_NETWORK=1 LIASCAPE_STEAM_CM_FIXTURE=$T/steam-cm.json
echo '{}' > "$LIASCAPE_STEAM_CM_FIXTURE"
# the engine is liascape-player (presets play only there), its binary a stub: nothing here ever plays. Once
# $T/stub-loudness exists it answers `scene-loudness <dir> --props <json>` (the offline estimate) with a fingerprint of
# exactly what it was given and logs the call in $T/loudness-calls
mkdir -p "$T/bin"
cat > "$T/bin/liascape-player" <<EOF
#!/bin/sh
[ "\$1" = scene-loudness ] && [ -e "$T/stub-loudness" ] || exit 1
printf '%s %s\n' "\$2" "\$4" >> "$T/loudness-calls"
printf '{"fingerprint":"fp-%s","lufs":-20,"peak_dbfs":-3,"model":"stub"}\n' "\$(printf '%s %s' "\$2" "\$4" | sha1sum | cut -c1-12)"
EOF
chmod +x "$T/bin/liascape-player"
stubfp() { echo "fp-$(printf '%s %s' "$1" "$2" | sha1sum | cut -c1-12)"; }   # $1 = dir, $2 = props: the stub's fingerprint
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

LIB=$XDG_DATA_HOME/liascape/library
WE=$T/we/431960
SETTINGS=$XDG_CONFIG_HOME/liascape/settings.json
mkdir -p "$LIB/imported" "$LIB/workshop" "$LIB/local" "$WE"
PNG=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC
# A synthetic base scene the way liascape-player's tests write one (the adapter IT's mk_scene: project.json type scene +
# scene.pkg + preview.png + liascape-synthetic.json) with a property set a preset can change: `color`, `clock`, and
# `style`, shown only while `clock` is on. $1 = item folder, $2 = title
mk_base() {
  mkdir -p "$1"
  jq -nc --arg t "$2" '{type: "scene", title: $t, file: "scene.json", preview: "preview.png", general: {properties: {
    color: {order: 0, text: "Colour", type: "color", value: "1 0 0"},
    clock: {order: 1, text: "Show clock", type: "bool", value: true},
    style: {order: 2, text: "Style", type: "combo", value: 1, options: [{label: "A", value: 1}, {label: "B", value: 2}],
            condition: "clock.value"}}}}' > "$1/project.json"
  head -c 16 /dev/zero > "$1/scene.pkg"
  printf '{"pattern":"solid","rgb":[255,0,0],"native":[640,360]}' > "$1/liascape-synthetic.json"
  echo "$PNG" | base64 -d > "$1/preview.png"
}
# A preset in Wallpaper Engine's confirmed shape (.claude/rules/backend/library.md § Presets): WE's own settings beside
# the property values. $1 = item folder, $2 = dependency (JSON: a digit string, or null for none), $3 = title,
# $4 = property values (a JSON object), $5 = preview file name ("" = none)
mk_preset() {
  mkdir -p "$1"
  jq -nc --argjson dep "$2" --arg t "$3" --argjson v "$4" --arg pv "${5:-}" \
    '{contentrating: "Everyone", preset: ({_d0: null, alignment: 0, alignmentx: 50, rate: 100, wec_brs: 50, wec_e: false} + $v),
      tags: ["Unspecified"], title: $t, visibility: "public"} + (if $dep == null then {} else {dependency: $dep} end)
      + (if $pv == "" then {} else {preview: $pv} end)' > "$1/project.json"
  [ -n "${5:-}" ] && preview "$1/$5"
  return 0
}
preview() {   # a small preview image of the file's own type
  case "$1" in
    *.gif) ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=32x18:rate=4:duration=0.5" "$1" ;;
    *) ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=blue:s=32x18" -frames:v 1 "$1" ;;
  esac
}
# a field-level change of an index (or settings) file while the backend runs: under its own cross-process lock
# (Helpers/FileLock.cs: an flock on <file>.lock), written through a temp file + rename like the backend's own writes
jqset() {   # $1 = file, $2 = jq filter, then jq args
  local f=$1 flt=$2; shift 2
  flock "$f.lock" sh -c '[ -s "$1" ] || echo "{}" > "$1"; f=$1; flt=$2; shift 2; jq "$flt" "$@" "$f" > "$f.tmp" && mv "$f.tmp" "$f"' _ "$f" "$flt" "$@"
}
idx() { jqset "$LIB/$1/index.json" "$2" "${@:3}"; }

LOG=$T/backend.log
startbe() {
  rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
  (cd /tmp && exec "$DOTNET" "$DLL" serve >> "$LOG" 2>&1) & BP=$!
  for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
  PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); U=http://127.0.0.1:$PORT
  TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
  for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "$U/health" >/dev/null && break; sleep 0.1; done
}
api() { curl -s -m 10 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
# one library item (by its folder: a scene's or preset's play path IS its folder), as GET /library lists it
item() { api "$U/library" | jq -c --arg p "$1" '[.[] | select(.videoPath == $p)][0]'; }
pf() { item "$1" | jq -c "$2"; }   # $1 = folder, $2 = jq of the item

cat > "$SETTINGS" <<EOF
{"PlayerEngine":"liascape-player","WorkshopFolder":"$WE","AutoAddWeWallpapersToLibrary":false,"AllowScenes":true,"NoAudio":true}
EOF

# ---- the library as it starts ------------------------------------------------------------------------------------------
# Wallpaper Engine's own preset files (from real Workshop items), each as a download would land it: workshop/<id> with
# its preview and an index entry; none of their bases is here
FXIDS=""
for d in "$FX"/*/; do
  id=$(basename "$d"); FXIDS="$FXIDS $id"
  cp -r "$d" "$LIB/workshop/$id"
  preview "$LIB/workshop/$id/$(jq -r .preview "$d/project.json")"
  idx workshop '.[$id] = {title: $t, workshopId: $id}' --arg id "$id" --arg t "$(jq -r .title "$d/project.json")"
done
# presets of the synthetic base 900000001 (it arrives in § base forms)
P1=$LIB/workshop/910000101; mk_preset "$P1" '"900000001"' "Preset one" '{"color":"0 0 1","clock":false}' preview.jpg
P2=$LIB/workshop/910000102; mk_preset "$P2" '"900000001"' "Preset no preview" '{"color":"0 1 0"}' ""
idx workshop '. + {"910000101": {title: "Preset one", workshopId: "910000101"}, "910000102": {title: "Preset no preview", workshopId: "910000102"}}'

startbe
check "the engine is liascape-player (the stub binary resolves)" "$(api "$U/player-engine" | jq -r .active)" liascape-player

echo "== 1. library: Wallpaper Engine's preset files list as presets that need their base"
[ -n "$FXIDS" ] || bad "no preset fixtures in $FX: proved nothing"
for id in $FXIDS; do
  d=$LIB/workshop/$id pj=$FX/$id/project.json
  check "fixture $id: a preset scene item, its base's id, needs its base, its own title" \
    "$(pf "$d" '[.isPreset, .isScene, .baseWorkshopId, .presetReason, .basePath, .title]')" \
    "$(jq -c --arg d "$d" '[true, true, .dependency, "Needs its base scene", null, .title]' "$pj")"
  case "$(jq -r .preview "$pj")" in
    *.gif) check "…its own animated preview" "$(pf "$d" '[.thumbnailPath, .animatedThumbnailPath]')" "[null,\"$d/preview.gif\"]" ;;
    *) check "…its own preview" "$(pf "$d" '.thumbnailPath')" "\"$d/preview.jpg\"" ;;
  esac
done

echo "== 1. base forms: found by Workshop id, whatever form the base has"
BASE_WE=$WE/900000001
mk_base "$BASE_WE" "Base scene"
ln -s "$BASE_WE" "$LIB/local/900000001"
idx local '.["900000001"] = {title: "Base scene", workshopId: "900000001", isScene: true}'
check "base as local/900000001 (a link to Steam's folder) → plays, its folder and title" \
  "$(pf "$P1" '[.presetReason, .basePath, .baseTitle, .baseWorkshopId]')" "[null,\"$LIB/local/900000001\",\"Base scene\",\"900000001\"]"
check "…every preset of it" "$(pf "$P2" '[.isPreset, .presetReason, .basePath]')" "[true,null,\"$LIB/local/900000001\"]"
check "the base itself is a plain scene" "$(pf "$LIB/local/900000001" '[.isScene, (.isPreset // false), .presetReason]')" '[true,false,null]'
# "Unsubscribe without deleting" (LibraryService.KeepOwnCopy): the link becomes the library's own copy AT THE SAME PATH, then
# Steam deletes its folder. A preset that held on to where the link pointed (or cached it) now points at nothing.
cp -r "$BASE_WE" "$LIB/local/.stage-900000001"
rm "$LIB/local/900000001"; mv "$LIB/local/.stage-900000001" "$LIB/local/900000001"
mv "$BASE_WE" "$T/steam-deleted-900000001"
check "…swapped for the library's own copy at that path (Steam's folder gone) → still plays from that path" \
  "$(pf "$P1" '[.presetReason, .basePath, .baseTitle]') $([ -L "$LIB/local/900000001" ] && echo link || echo copy)" \
  "[null,\"$LIB/local/900000001\",\"Base scene\"] copy"
rm -r "$LIB/local/900000001"; idx local 'del(.["900000001"])'
check "base gone → needs its base scene" "$(pf "$P1" '[.presetReason, .basePath]')" '["Needs its base scene",null]'
mk_base "$LIB/imported/base-copy" "Base scene (imported)"
idx imported '.["base-copy"] = {title: "Base scene (imported)", workshopId: "900000001", isScene: true, sourceUrl: "import:/somewhere/900000001"}'
check "base as an imported folder with Workshop id 900000001 → plays from it" \
  "$(pf "$P1" '[.presetReason, .basePath, .baseTitle]')" "[null,\"$LIB/imported/base-copy\",\"Base scene (imported)\"]"
mk_base "$LIB/workshop/900000001" "Base scene (download)"
idx workshop '.["900000001"] = {title: "Base scene (download)", workshopId: "900000001", isScene: true}'
check "base as workshop/900000001 (beside the imported one) → that one: workshop/ before imported/" \
  "$(pf "$P1" '[.presetReason, .basePath, .baseTitle]')" "[null,\"$LIB/workshop/900000001\",\"Base scene (download)\"]"
mkdir -p "$T/we2"; mk_base "$T/we2/900000001" "Base scene (Steam)"; ln -s "$T/we2/900000001" "$LIB/local/900000001"
idx local '.["900000001"] = {title: "Base scene (Steam)", workshopId: "900000001", isScene: true}'
check "…and local/900000001 before both" "$(pf "$P1" '[.presetReason, .basePath, .baseTitle]')" "[null,\"$LIB/local/900000001\",\"Base scene (Steam)\"]"
rm "$LIB/local/900000001"; idx local 'del(.["900000001"])'
rm -r "$LIB/imported/base-copy"; idx imported 'del(.["base-copy"])'
# the title the download saved for the base (LibMeta.baseTitle): shown while the base has none of its own, or is away
idx workshop 'del(.["900000001"].title) | .["910000101"].baseTitle = "Saved base title"'
check "a base with no title of its own → the preset's saved base title" "$(pf "$P1" '[.presetReason, .baseTitle]')" '[null,"Saved base title"]'
mv "$LIB/workshop/900000001" "$T/base-away"
check "…and while the base is away" "$(pf "$P1" '[.presetReason, .baseTitle]')" '["Needs its base scene","Saved base title"]'
mv "$T/base-away" "$LIB/workshop/900000001"
idx workshop '.["900000001"].title = "Base scene (download)" | del(.["910000101"].baseTitle)'
check "the base's own title wins over the saved one" "$(idx workshop '.["910000101"].baseTitle = "Saved base title"'; pf "$P1" '.baseTitle')" '"Base scene (download)"'
idx workshop 'del(.["910000101"].baseTitle)'
check "a preset with no preview lists none (nothing borrowed from its base, which has one)" \
  "$(pf "$P2" '[.thumbnailPath, .animatedThumbnailPath]') $(pf "$LIB/workshop/900000001" '.thumbnailPath')" \
  "[null,null] \"$LIB/workshop/900000001/preview.png\""

echo "== 1. malformed: greyed with the reason, never resolved through"
mk_preset "$LIB/workshop/910000201" null "No base id" '{"color":"0 0 1"}' preview.jpg
mk_preset "$LIB/workshop/910000202" '"910000202"' "Its own base" '{"color":"0 0 1"}' preview.jpg
mk_preset "$LIB/workshop/900000009" '"900000001"' "A preset as a base" '{"color":"1 1 0"}' preview.jpg
mk_preset "$LIB/workshop/910000203" '"900000009"' "Over a preset" '{"color":"0 0 1"}' preview.jpg
mkdir -p "$LIB/workshop/900000002"; : > "$LIB/workshop/900000002/v.mp4"
printf '{"type":"video","file":"v.mp4","title":"A video"}' > "$LIB/workshop/900000002/project.json"
mk_preset "$LIB/workshop/910000204" '"900000002"' "Over a video" '{"color":"0 0 1"}' preview.jpg
mk_preset "$LIB/workshop/910000205" '"900000003"' "Over a web wallpaper" '{"color":"0 0 1"}' preview.jpg
idx workshop '.["910000205"] = {title: "Over a web wallpaper", workshopId: "910000205", baseKind: "web"}'
check "no base id → its reason" "$(pf "$LIB/workshop/910000201" '[.isPreset, .baseWorkshopId, .presetReason]')" '[true,null,"Its preset file names no base scene"]'
check "its own id as its base → the same" "$(pf "$LIB/workshop/910000202" '[.isPreset, .presetReason, .basePath]')" '[true,"Its preset file names no base scene",null]'
check "the preset used as a base plays itself (its base is a scene)" "$(pf "$LIB/workshop/900000009" '[.isPreset, .presetReason]')" '[true,null]'
check "a base that is itself a preset → its reason" "$(pf "$LIB/workshop/910000203" '.presetReason')" '"Its base is a preset wallpaper, not a scene"'
check "a base that is a video → its reason" "$(pf "$LIB/workshop/910000204" '.presetReason')" '"Its base is a video wallpaper, not a scene"'
check "a base the download found to be a web wallpaper (LibMeta.baseKind), not here → that reason, not 'needs'" \
  "$(pf "$LIB/workshop/910000205" '.presetReason')" '"Its base is a web wallpaper, not a scene"'

echo "== 1. auto-import: presets in the Wallpaper Engine folder come in only with scene support on"
mk_preset "$WE/910000301" '"900000001"' "Subscribed preset" '{"color":"0 0 1"}' preview.jpg
mk_preset "$WE/910000302" '"not-an-id"' "Malformed subscribed preset" '{"color":"0 0 1"}' preview.jpg
jqset "$SETTINGS" '.AllowScenes = false'
check "scene support off: /library/sync adds no preset" \
  "$(api -X POST "$U/library/sync" | jq -c '[.added[] | select(test("91000030"))]') $([ -e "$LIB/local/910000301" ] && echo linked || echo none)" '[] none'
jqset "$SETTINGS" '.AllowScenes = true'
check "scene support on: /library/sync adds local/910000301 (a link), its index entry a scene" \
  "$(api -X POST "$U/library/sync" | jq -c '[.added[] | select(test("91000030"))]') $([ -L "$LIB/local/910000301" ] && echo link) $(jq -c '.["910000301"] | [.isScene, .workshopId, .title]' "$LIB/local/index.json")" \
  "[\"$LIB/local/910000301\"] link [true,\"910000301\",\"Subscribed preset\"]"
check "…a preset over its base, playable" "$(pf "$LIB/local/910000301" '[.isPreset, .presetReason, .basePath]')" "[true,null,\"$LIB/workshop/900000001\"]"
check "…one with no Workshop id as its dependency stays out" "$([ -e "$LIB/local/910000302" ] && echo linked || echo none)" none

echo "== 1. Wallpaper Engine (Local): adding a preset brings its base from that folder the same way"
# Browse's "Wallpaper Engine (Local)" card of a preset (WallpaperEngineScraper: its folder as the page, isPreset); its base
# 900000031 sits beside it in the Wallpaper Engine folder, 900000032 (the other preset's) doesn't
mk_base "$WE/900000031" "Base scene (WE folder)"
mk_preset "$WE/910000331" '"900000031"' "Local preset" '{"color":"0 0 1"}' preview.jpg
mk_preset "$WE/910000332" '"900000032"' "Local preset, base elsewhere" '{"color":"0 0 1"}' preview.jpg
WESRC=$(api "$U/sources" | jq '[.[] | select(.supportsLocalFilter)][0].index')
weadd() { api -o "$T/body" -w '%{http_code}' -X POST "$U/download" -d "$(jq -nc --argjson s "$WESRC" --arg d "$WE/$1" --arg id "$1" \
  '{source: $s, result: {title: $id, thumbnailUrl: "", pageUrl: $d, isScene: true, isPreset: true, workshopId: $id}, apply: false}')"; }
check "add the preset from the Wallpaper Engine folder → 200, local/910000331 a link" \
  "$(weadd 910000331) $([ -L "$LIB/local/910000331" ] && echo link)" "200 link"
for _ in $(seq 1 50); do [ "$(pf "$LIB/local/910000331" '.presetReason')" = null ] && break; sleep 0.1; done
check "…its base comes from the same folder the same way (local/900000031, a link), and the preset plays over it" \
  "$([ -L "$LIB/local/900000031" ] && readlink "$LIB/local/900000031") $(pf "$LIB/local/900000031" '[.isScene, .isPreset]') $(pf "$LIB/local/910000331" '[.presetReason, .basePath]')" \
  "$WE/900000031 [true,false] [null,\"$LIB/local/900000031\"]"
check "a preset whose base isn't in the folder → 200, it needs its base scene, nothing else added" \
  "$(weadd 910000332) $(sleep 1; pf "$LIB/local/910000332" '.presetReason') $([ -e "$LIB/local/900000032" ] && echo added || echo none)" \
  '200 "Needs its base scene" none'
mkdir -p "$WE/900000033"; printf '{"type":"web","file":"index.html","title":"Web base"}' > "$WE/900000033/project.json"
mk_preset "$WE/910000333" '"900000033"' "Local preset, web base" '{"color":"0 0 1"}' preview.jpg
st=$(weadd 910000333)
for _ in $(seq 1 30); do r=$(pf "$LIB/local/910000333" '.presetReason'); [ "$r" != '"Needs its base scene"' ] && break; sleep 0.1; done
check "a preset whose base in the folder is a web wallpaper → 200, greyed with why, the base not added" \
  "$st $r $([ -e "$LIB/local/900000033" ] && echo added || echo none)" '200 "Its base is a web wallpaper, not a scene" none'

echo "== 1. trash: a preset goes, its base stays"
# the base's own fields (the background facts pass may add its frame size or size on disk meanwhile)
base_entry() { jq -cS '.["900000001"] | {title, workshopId, isScene, sceneProps}' "$LIB/workshop/index.json"; }
before=$(base_entry)
st=$(api -o "$T/body" -w '%{http_code}' -X POST "$U/library/trash" -d "$(jq -nc --argjson i "$(item "$P1")" '{items: [$i]}')")
check "trash the preset → 200, it's gone" "$st $(item "$P1")" "200 null"
check "…its base's folder and index entry untouched" \
  "$([ -f "$LIB/workshop/900000001/scene.pkg" ] && echo there) $(base_entry) $(pf "$LIB/workshop/900000001" '[.isScene, .title]')" \
  "there $before [true,\"Base scene (download)\"]"
check "…the other preset of that base still plays" "$(pf "$P2" '.presetReason')" null
check "undo → the preset is back, over its base" "$(api -X POST "$U/library/undo" | jq -c .ok) $(pf "$P1" '[.isPreset, .presetReason]')" 'true [true,null]'
stopbe

echo "== 1. legacy engine: presets play only in the Liascape player"
jqset "$SETTINGS" '.PlayerEngine = "legacy"'
startbe
check "the engine is legacy" "$(api "$U/player-engine" | jq -r .active)" legacy
check "a preset whose base is here → the legacy reason" "$(pf "$P1" '[.isPreset, .presetReason, .basePath]')" "[true,\"Presets play only in the Liascape player\",\"$LIB/workshop/900000001\"]"
check "…a missing base still says so first" "$(pf "$LIB/workshop/3009121253" '.presetReason')" '"Needs its base scene"'
check "…a malformed one too" "$(pf "$LIB/workshop/910000201" '.presetReason')" '"Its preset file names no base scene"'
stopbe

# ---- 2. layered properties --------------------------------------------------------------------------------------------
jqset "$SETTINGS" '.PlayerEngine = "liascape-player"'
startbe
check "§ 2 runs under liascape-player" "$(api "$U/player-engine" | jq -r .active)" liascape-player
BASE=$LIB/workshop/900000001
props() { api "$U/library/scene-props?path=$(jq -rn --arg p "$1" '$p|@uri')"; }
prop() { props "$1" | jq -c --arg n "$2" '.props[] | select(.name == $n) | '"$3"; }
setp() { api -o "$T/body" -w '%{http_code}' -X POST "$U/library/scene-props" -d "$(jq -nc --arg p "$1" --arg n "$2" --argjson v "$3" '{path: $p, name: $n, value: $v}')"; }
resetp() { api -o "$T/body" -w '%{http_code}' -X POST "$U/library/scene-props" -d "$(jq -nc --arg p "$1" --arg n "$2" '{path: $p, name: $n, reset: true}')"; }
sp() { jq -c --arg k "$2" '.[$k].sceneProps // null' "$LIB/$1/index.json"; }   # $1 = source, $2 = key

echo "== 2. layered properties: the base's properties, the preset's values as their defaults, the card's own tweaks"
check "the preset lists its base's properties, in its base's order" "$(props "$P1" | jq -c '[.props[].name]')" '["color","clock","style"]'
check "…color: the preset's value is the default and the value, not overridden" \
  "$(prop "$P1" color '[.default, .value, .overridden]')" '["0 0 1","0 0 1",false]'
check "…clock: the preset's false" "$(prop "$P1" clock '[.default, .value]')" '[false,false]'
check "…style hidden (its condition reads the preset's clock)" "$(prop "$P1" style '.visible')" false
check "the base keeps its own defaults" "$(prop "$BASE" color '[.default, .value]') $(prop "$BASE" style '.visible')" '["1 0 0","1 0 0"] true'
check "a tweak on the preset → 200, saved on the preset only" \
  "$(setp "$P1" color '"0 1 0"') $(sp workshop 910000101) $(sp workshop 900000001)" '200 {"color":"0 1 0"} null'
check "…the preset's value stays the default, the tweak is the value" "$(prop "$P1" color '[.default, .value, .overridden]')" '["0 0 1","0 1 0",true]'
check "a tweak equal to the preset's value drops the key" "$(setp "$P1" color '"0 0 1"') $(sp workshop 910000101)" '200 null'
setp "$P1" color '"0 1 0"' >/dev/null
check "reset → back to the preset's value, the key gone" \
  "$(resetp "$P1" color) $(sp workshop 910000101) $(prop "$P1" color '[.value, .overridden]')" '200 null ["0 0 1",false]'
check "a tweak of the base's own color → the preset's view unchanged" \
  "$(setp "$BASE" color '"1 1 0"') $(prop "$P1" color '[.default, .value]') $(sp workshop 910000101)" '200 ["0 0 1","0 0 1"] null'
check "…the base's tweak against the scene's own default" "$(prop "$BASE" color '[.default, .value]') $(sp workshop 900000001)" '["1 0 0","1 1 0"] {"color":"1 1 0"}'
check "a tweak of the preset's clock → the base's view unchanged" \
  "$(setp "$P1" clock true) $(prop "$BASE" clock '[.default, .value]') $(prop "$P1" style '.visible') $(sp workshop 900000001)" \
  '200 [true,true] true {"color":"1 1 0"}'
resetp "$P1" clock >/dev/null; resetp "$BASE" color >/dev/null
check "WE's own settings in a preset (_d0, alignment*, rate, wec_*) never list; the base's list is what shows" \
  "$(props "$LIB/workshop/900000009" | jq -c '[.props[] | [.name, .default]]')" '[["color","1 1 0"],["clock",true],["style","1"]]'
check "a preset whose base is missing → no properties" "$(props "$LIB/workshop/3009121253" | jq -c '.props')" '[]'
check "…a tweak on it → 400, nothing saved" "$(setp "$LIB/workshop/3009121253" color '"0 1 0"') $(sp workshop 3009121253)" '400 null'

echo "== 2. loudness per item: a preset is estimated on its base's folder with its own map, stored under its own path"
NOBASE=$LIB/workshop/3009121253
fp() { jq -r --arg k "$2" '.[$k].sceneLoudnessFp // "none"' "$LIB/$1/index.json"; }
estimate() {   # queue these items (force) and wait for the queue to finish
  api -X POST "$U/library/scene-loudness/estimate" -d "$(jq -nc '{paths: $ARGS.positional, force: true}' --args "$@")" >/dev/null
  for _ in $(seq 1 100); do [ "$(api "$U/library/scene-loudness/status" | jq -r .running)" = false ] && break; sleep 0.1; done
}
: > "$T/stub-loudness"; : > "$T/loudness-calls"
estimate "$P1" "$P2" "$BASE" "$NOBASE"
check "the estimator ran on the base's folder for each: the base {}, preset one its values, preset two its value" \
  "$(sort "$T/loudness-calls" | tr '\n' '|')" \
  "$(printf '%s\n' "$BASE {\"clock\":false,\"color\":[0,0,1]}" "$BASE {\"color\":[0,1,0]}" "$BASE {}" | sort | tr '\n' '|')"
check "each stored under its own path, its own configuration" \
  "$(fp workshop 910000101) $(fp workshop 910000102) $(fp workshop 900000001)" \
  "$(stubfp "$BASE" '{"clock":false,"color":[0,0,1]}') $(stubfp "$BASE" '{"color":[0,1,0]}') $(stubfp "$BASE" '{}')"
check "a preset whose base is missing: not estimated, with the reason" \
  "$(fp workshop 3009121253) $(api "$U/library/scene-loudness/status" | jq -c --arg p "$NOBASE" '[.failed[] | select(.path == $p) | .error]')" \
  'none ["needs its base scene"]'
: > "$T/loudness-calls"
setp "$P1" color '"0 1 0"' >/dev/null
want=$(stubfp "$BASE" '{"clock":false,"color":[0,1,0]}')
for _ in $(seq 1 100); do [ "$(fp workshop 910000101)" = "$want" ] && break; sleep 0.1; done
check "a tweak on the preset re-plans it with the merged map (the base's own configuration unchanged)" \
  "$(cat "$T/loudness-calls") $(fp workshop 910000101) $(fp workshop 900000001)" \
  "$BASE {\"clock\":false,\"color\":[0,1,0]} $want $(stubfp "$BASE" '{}')"
resetp "$P1" color >/dev/null

echo "== 2. bools saved as 0 / 1: WE writes both"
mk_preset "$LIB/workshop/910000401" '"900000001"' "Clock as 0" '{"clock":0}' ""
mk_preset "$LIB/workshop/910000402" '"900000001"' "Clock as 2" '{"clock":2,"color":"0 0 1"}' ""
check "a bool saved as 0 → false (the preset's default; style hidden by it)" \
  "$(prop "$LIB/workshop/910000401" clock '.default') $(prop "$LIB/workshop/910000401" style '.visible')" 'false false'
check "…any other number for a bool → dropped alone (the base's true), the rest applied" \
  "$(prop "$LIB/workshop/910000402" clock '.default') $(prop "$LIB/workshop/910000402" color '.default')" 'true "0 0 1"'

echo "== 2. preset images: a scenetexture value is the preset's own files/<name>, sent as its real path"
# the base the fixtures 3583880694 and 3520333138 name, synthetic: its two image slots (empty by default, as the real
# one's) and the toggles that show them
IB=$LIB/workshop/3354740764
mk_base "$IB" "Image base"
jq '.general.properties += {custom11pnggif: {order: 10, text: "Custom image", type: "bool", value: false},
  custom: {order: 11, text: "Image", type: "scenetexture", value: "", condition: "custom11pnggif.value == true"},
  customtab: {order: 15, text: "Window", type: "bool", value: false},
  customtabimage: {order: 16, text: "Window image", type: "scenetexture", value: "", condition: "customtab.value == true"}}' \
  "$IB/project.json" > "$IB/p.tmp" && mv "$IB/p.tmp" "$IB/project.json"
idx workshop '.["3354740764"] = {title: "Image base", workshopId: "3354740764", isScene: true}'
F1=$LIB/workshop/3583880694 F2=$LIB/workshop/3520333138
real() { realpath -e "$1"; }
check "fixture 3583880694 plays over it" "$(pf "$F1" '[.presetReason, .basePath]')" "[null,\"$IB\"]"
check "…its image slot's default is its own files/eeeeee.png (real path); the empty one stays empty" \
  "$(prop "$F1" custom '.default') $(prop "$F1" customtabimage '.default')" "\"$(real "$F1/files/eeeeee.png")\" null"
check "the base's own slots stay empty" "$(prop "$IB" custom '.default')" null
# a preset over the image base for each value that must never reach the core as a file to read
mkdir -p "$T/elsewhere"; cp "$F1/files/eeeeee.png" "$T/elsewhere/out.png"
ESC=$LIB/workshop/910000501
mk_preset "$ESC" '"3354740764"' "Escapes" "$(jq -nc --arg abs "$T/elsewhere/out.png" '{custom: "../3583880694/files/eeeeee.png", customtabimage: $abs}')" ""
ESC2=$LIB/workshop/910000502
mk_preset "$ESC2" '"3354740764"' "Escapes 2" '{"custom":"files/link.png","customtabimage":"files/notes.txt","custom11pnggif":1}' ""
mkdir -p "$ESC2/files"; ln -s "$T/elsewhere/out.png" "$ESC2/files/link.png"; echo text > "$ESC2/files/notes.txt"
GONE=$LIB/workshop/910000503
mk_preset "$GONE" '"3354740764"' "Missing image" '{"custom":"files/none.png","custom11pnggif":true}' ""
: > "$T/loudness-calls"
estimate "$F1" "$F2" "$ESC" "$ESC2" "$GONE"
check "the player's map: each preset's own images as real paths, the toggles its values; nothing out of its folder, no text file, no missing file" \
  "$(sort "$T/loudness-calls" | tr '\n' '|')" \
  "$(printf '%s\n' \
    "$IB $(jq -nc --arg a "$(real "$F1/files/eeeeee.png")" '{custom: $a, custom11pnggif: true}')" \
    "$IB $(jq -nc --arg a "$(real "$F2/files/com-resize-unscreen.gif")" --arg b "$(real "$F2/files/4367d2382289f5f8ce92347c4e2417db.gif")" \
         '{custom: $a, custom11pnggif: true, customtab: true, customtabimage: $b}')" \
    "$IB {}" "$IB {\"custom11pnggif\":true}" "$IB {\"custom11pnggif\":true}" | sort | tr '\n' '|')"
check "a value for an image slot can't be set on the card (no file picker): 400, the preset's image stays" \
  "$(setp "$F1" custom "\"$T/elsewhere/out.png\"") $(sp workshop 3583880694) $(prop "$F1" custom '.default')" \
  "400 null \"$(real "$F1/files/eeeeee.png")\""
stopbe

# ---- 3. the base trashed (no player: the library's side) ----------------------------------------------------------------
echo "== 3. the base trashed: its presets need it again (the WS tells the Library); Undo makes them playable"
startbe
# the backend's WebSocket (/events) as the UI opens it: Host 127.0.0.1:<port>, the token as ?token= → one message per line
python3 - "$PORT" "$TOKEN" > "$T/ws3.log" 2>&1 <<'PY' &
import socket, sys, base64, os
port, token = int(sys.argv[1]), sys.argv[2]
s = socket.create_connection(("127.0.0.1", port))
s.send(("GET /events?token=%s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (token, port, base64.b64encode(os.urandom(16)).decode())).encode())
buf = b""
def need(n):
    global buf
    while len(buf) < n:
        d = s.recv(65536)
        if not d: sys.exit(0)
        buf += d
need(4)
while b"\r\n\r\n" not in buf: need(len(buf) + 1)
head, buf = buf.split(b"\r\n\r\n", 1)
print(head.split(b"\r\n")[0].decode(), flush=True)
while True:
    need(2); n = buf[1] & 0x7f; o = 2
    if n == 126: need(4); n = int.from_bytes(buf[2:4], "big"); o = 4
    elif n == 127: need(10); n = int.from_bytes(buf[2:10], "big"); o = 10
    need(o + n); msg = buf[o:o + n]; op = buf[0] & 0x0f; buf = buf[o + n:]
    if op == 1: print(msg.decode(errors="replace"), flush=True)
PY
WSP=$!
for _ in $(seq 1 50); do grep -q " 101 " "$T/ws3.log" 2>/dev/null && break; sleep 0.1; done
grep -q " 101 " "$T/ws3.log" || bad "WebSocket: $(head -c 200 "$T/ws3.log")"
synced() { grep -c '"library-synced"' "$T/ws3.log"; }
# the startup passes (library sync, facts) send their own library-synced: wait until 2 s go by without one
q=0; for _ in $(seq 1 100); do c=$(synced); sleep 0.5; [ "$(synced)" = "$c" ] && q=$((q + 1)) || q=0; [ $q -ge 4 ] && break; done
check "precondition: both presets play over workshop/900000001" "$(pf "$P1" '.presetReason') $(pf "$P2" '.presetReason')" "null null"
w0=$(synced)
st=$(api -o "$T/body" -w '%{http_code}' -X POST "$U/library/trash" -d "$(jq -nc --argjson i "$(item "$BASE")" '{items: [$i]}')")
check "trash the base → 200; both presets: needs its base scene" \
  "$st $(pf "$P1" '[.isPreset, .presetReason]') $(pf "$P2" '[.isPreset, .presetReason]')" \
  '200 [true,"Needs its base scene"] [true,"Needs its base scene"]'
for _ in $(seq 1 30); do [ "$(synced)" -gt "$w0" ] && break; sleep 0.1; done
check "…the WS says library-synced (the Library greys them out without a reload)" "$([ "$(synced)" -gt "$w0" ] && echo seen || echo none)" seen
w1=$(synced)
check "undo → the base is back, both presets playable again" \
  "$(api -X POST "$U/library/undo" | jq -c .ok) $(pf "$P1" '.presetReason') $(pf "$P2" '.presetReason')" "true null null"
for _ in $(seq 1 30); do [ "$(synced)" -gt "$w1" ] && break; sleep 0.1; done
check "…the WS says library-synced again" "$([ "$(synced)" -gt "$w1" ] && echo seen || echo none)" seen
kill "$WSP" 2>/dev/null
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
