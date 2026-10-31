#!/usr/bin/env bash
# Hermetic test of POST /settings's merge (PATCH) semantics under PlayerEngine=liascape-player: the body's keys
# overwrite the saved settings, every key it leaves out keeps its saved value. It used to replace the whole
# AppSettings — a partial body (an agent's {"Volume": 50}) reset every other field to its C# default (~15
# fields incl. SceneMonitors and the engine, which then switched the player away). Checks: a partial body
# changes only its own fields (camelCase and PascalCase keys), a provided array replaces the whole array,
# an explicit null sets null, unknown keys (incl. the removed LweSilent) are ignored, a bad value is a 400
# that saves nothing, parallel partial bodies all land, a full body (the UI's whole copy) behaves as
# before incl. the backend-owned fields kept from disk, and a partial body still applies live: Volume /
# Speed / NoAudio / VideoScale on the playing wallpaper, override ?? global, a running rotation's
# interval, the engine switch. Also: a settings.json that still carries LweSilent loads.
# Phase 3 Task 10: PauseWhenCovered (default maximized) / GlobalPlaylistStart (start_over) / RotateWhileParked (true) /
# ShowExpertOptions (false) — the defaults on a file without the keys, partial bodies keep them, bad values are
# normalized, an old file's ResumeFromLast loads and is gone from GET and the next save, each is live on the player
# (`player.pause_when_covered`, `prog:main.start_mode` / `.while_parked`, the current play untouched), and a playlist's
# own PlaylistStart beats the global one only with its override on.
#
# Hermetic like scripts/test-liascape-player-adapter.sh: temp HOME + every XDG dir (own settings.json, library,
# player socket), a private `liascape-player serve --headless --clock real --ao null`, its own backend port;
# never touches another backend, the real settings or the real player, and stops before any playback call
# unless /player-engine says `active: liascape-player` (so it can't start or kill mpvpaper). It never prints a
# /settings response or settings.json — only field NAMES and non-secret single values. Stopped on exit.
#
# Usage: scripts/test-settings-merge.sh [--no-build]
# Needs: dotnet (or DOTNET=…), ffmpeg, jq, curl, python3. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)  # physical path: a symlinked alias makes MSBuild delete its own outputs
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
for t in ffmpeg jq curl python3 timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
B=$ROOT/src/player/target/debug/liascape-player
# LIASCAPE_SM_DLL: another backend build to test (e.g. an older commit's, for a RED run of new checks)
DLL=${LIASCAPE_SM_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
if [ $BUILD = 1 ]; then
  if command -v nix >/dev/null; then
    (cd "$ROOT" && env -u LD_LIBRARY_PATH nix develop -c cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  else
    (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  fi
  "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -x "$B" ] && [ -f "$DLL" ] || { echo "not built: $B / $DLL (drop --no-build)"; exit 2; }

T=$(mktemp -d /tmp/liascape-sm-XXXXXX)   # short: a unix socket path must be < 108 bytes
# run the backend from a private copy of its build (a `dotnet watch` on this tree may rebuild bin/Debug
# mid-test — see test-liascape-player-adapter.sh's snapshot_backend)
mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
DLL=$T/backend/liascape-backend.dll
mkdir -p "$T/home/.config/liascape" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st"
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LIASCAPE_PLAYER_BIN=$B LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT
SP=""; BP=""
cleanup() {
  trap - EXIT INT TERM HUP
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1   # clean child exit → the supervisor exits too
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  case "$T" in /tmp/liascape-sm-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
pass=0; fail=0
ok()  { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
ctl() { "$B" ctl --timeout-ms 3000 "$@"; }
dB() { python3 -c "import math; print(60*math.log10($1/100))"; }
near() { python3 -c "import sys; sys.exit(0 if abs(float('$1')-float('$2'))<${3:-0.01} else 1)" 2>/dev/null; }
clip() { timeout 60 ffmpeg -nostdin -loglevel error -y -f lavfi -i "$2=size=320x180:rate=30:duration=$4" \
           -f lavfi -i "sine=frequency=$3:sample_rate=48000:duration=$4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$1"; }
C1=$T/c1.mp4; C2=$T/c2.mp4
clip "$C1" testsrc2 440 6; clip "$C2" smptebars 550 6
[ -s "$C1" ] && [ -s "$C2" ] || { echo "ABORT: ffmpeg made no clips"; exit 2; }

# Non-default values everywhere, so a reset to a C# default shows; LweSilent = the removed setting, still
# in older files; the Steam fields are dummies (still never printed — the real file holds a real token).
SJ=$XDG_CONFIG_HOME/liascape/settings.json
cat > "$SJ" <<EOF
{"PlayerEngine":"liascape-player","NoAudio":false,"Loop":true,"Volume":80,"Speed":1,"VideoScale":"fill","HwDec":"no",
 "DemuxerMaxMib":32,"DemuxerMaxBackMib":8,"LweSilent":true,"LweVolume":55,
 "SceneMonitors":[{"Name":"DP-1","Fps":144,"IsPrimary":true},{"Name":"HDMI-A-1","Fps":30,"IsPrimary":false}],
 "SceneTransitionDelayMs":1500,"Theme":"Catppuccin Latte","CardSize":"Large","ThumbnailAspect":"16:9","LibrarySortIndex":2,
 "GlobalIntervalSeconds":600,"GlobalSwitchWhenVideoEnds":false,"GlobalWaitForVideoEnd":true,"PlaylistWaitForVideoEnd":true,"GlobalMinPlaySeconds":45,"GlobalMaxPlaySeconds":0,
 "GlobalTransitionEnabled":false,"GlobalTransitionEffectIds":["fade","wipeLeft"],"GlobalTransitionDurationMs":900,
 "TransitionMethod":"full-live","AdvancedSettings":true,"ResumeFromLast":false,"StayPausedWhenSwitching":true,"RestartMpvpaperEverySeconds":0,"AutoMute":false,
 "AllowScenes":true,"WorkshopDownloadMode":"steamcmd","SteamRefreshToken":"test-refresh-token","SteamAccessToken":"test-access-token",
 "SteamAccountName":"test-account","SteamId":76561190000000000,"SteamUsername":"test-user","SteamCmdPath":"/nonexistent/steamcmd"}
EOF

(cd /tmp && exec "$B" serve --headless --outputs 640x360@60 --clock real --ao null > "$T/serve.log" 2>&1) & SP=$!
for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
"$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "ABORT: backend didn't start"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
engine() { curl -sf -m 5 "$U/player-engine" | jq -r .active; }
[ "$(engine)" = liascape-player ] || { echo "ABORT: backend not on liascape-player — refusing to touch any legacy player"; exit 1; }

post() { curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
cur()  { ctl get "{\"path\":\"cur:*.$1\"}" 2>/dev/null | jq -r '.value'; }
snap() { curl -sf -m 5 "$U/settings" > "$T/$1.json"; }           # kept in $T, never printed
f()    { jq -c "$1" "$T/$2.json"; }                                # one NON-secret field of a snapshot
disk() { jq -r "$1" "$SJ"; }                                       # a boolean/non-secret test on the file
# the NAMES of the fields that differ between two snapshots, minus the ones this step changes on purpose
changed() { jq -rn --slurpfile a "$T/$1.json" --slurpfile b "$T/$2.json" --argjson want "${3:-[]}" \
  '$a[0] as $x | $b[0] as $y | ([$x, $y] | map(keys[]) | unique | map(select($x[.] != $y[.]))) - $want | join(",")'; }
same() {   # $1 before, $2 after, $3 = JSON array of the fields that should change, $4 = what
  local c; c=$(changed "$1" "$2" "${3:-[]}")
  [ -z "$c" ] && ok "$4: no other field changed" || bad "$4 also changed: $c"
}

echo "== a settings.json that still carries the removed LweSilent loads"
snap s0
[ "$(f .volume s0)" = 80 ] && [ "$(f .theme s0)" = '"Catppuccin Latte"' ] && [ "$(f '.sceneMonitors|length' s0)" = 2 ] \
  && ok "loaded the file, not the defaults (volume 80, theme, 2 SceneMonitors)" || bad "loaded volume $(f .volume s0) theme $(f .theme s0)"
[ "$(f 'has("lweSilent")' s0)" = false ] && ok "GET /settings has no lweSilent" || bad "GET /settings still has lweSilent"
# the rotation redesign (2026-10-28): "Wait for video to end after interval" is gone and the separate minimum merged
# into the interval field (= the minimum under advance-on-end) — an old file's keys load as unknown ones, no migration
[ "$(f '[has("globalWaitForVideoEnd"), has("playlistWaitForVideoEnd"), has("globalMinPlaySeconds")] | any' s0)" = false ] \
  && ok "GET /settings has no globalWaitForVideoEnd / playlistWaitForVideoEnd / globalMinPlaySeconds (removed)" \
  || bad "GET /settings still has a removed rotation key: $(f '[has("globalWaitForVideoEnd"), has("playlistWaitForVideoEnd"), has("globalMinPlaySeconds")]' s0)"
[ "$(f '[.globalIntervalSeconds, .globalSwitchWhenVideoEnds, .globalMaxPlaySeconds]' s0)" = '[600,false,0]' ] \
  && ok "the rotation fields that stay loaded from the old file as they were (interval 600, advance off, max 0)" \
  || bad "rotation fields after loading an old file: $(f '[.globalIntervalSeconds, .globalSwitchWhenVideoEnds, .globalMaxPlaySeconds]' s0)"
# "Separate timing for scenes" (2026-10-28): a file written before it loads its defaults — on, 30 min (the one-off
# migration script writes both keys into the owner's files, so this default never decides an existing rotation)
[ "$(f '[.globalSeparateSceneTiming, .globalSwitchScenesAfterSeconds]' s0)" = '[true,1800]' ] \
  && ok "a file without the scene-timing keys: globalSeparateSceneTiming true, globalSwitchScenesAfterSeconds 1800 (the defaults)" \
  || bad "scene-timing fields after loading a file without them: $(f '[.globalSeparateSceneTiming, .globalSwitchScenesAfterSeconds]' s0)"

# Phase 3 Task 10: a file without the new keys loads their defaults; the folded-in ResumeFromLast (designer call 13) is
# an unknown key now — no migration, gone from GET and from the next save
[ "$(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .showExpertOptions]' s0)" = '["maximized","start_over",true,false]' ] \
  && ok "a file without the Task 10 keys: pauseWhenCovered maximized, globalPlaylistStart start_over, rotateWhileParked true, showExpertOptions false" \
  || bad "Task 10 defaults after loading an old file: $(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .showExpertOptions]' s0)"
[ "$(f 'has("resumeFromLast")' s0)" = false ] && ok "GET /settings has no resumeFromLast (the old file's key is an unknown one)" || bad "GET /settings still has resumeFromLast"

echo "== a partial body changes only its own fields (nothing playing)"
post /settings '{"Theme":"Nord"}' >/dev/null && ok "POST {\"Theme\":\"Nord\"} → 200" || bad "POST {\"Theme\":\"Nord\"} failed"
snap s1
[ "$(f .theme s1)" = '"Nord"' ] && ok "theme → Nord" || bad "theme → $(f .theme s1)"
c=$(changed s0 s1 '["theme"]')
[ -z "$c" ] && ok "a partial body: no other field changed" || bad "a partial body reset $(echo "$c" | tr ',' '\n' | wc -l) other fields: $c"
[ "$(disk '.SteamRefreshToken == "test-refresh-token" and .SteamAccessToken == "test-access-token"')" = true ] \
  && ok "the Steam tokens survived on disk" || bad "the Steam tokens were reset on disk"
[ "$(disk 'has("LweSilent")')" = false ] && ok "the save dropped LweSilent from settings.json" || bad "settings.json still has LweSilent after a save"
[ "$(disk '[has("GlobalWaitForVideoEnd"), has("PlaylistWaitForVideoEnd"), has("GlobalMinPlaySeconds")] | any')" = false ] \
  && ok "the save dropped the removed rotation keys from settings.json" || bad "settings.json still has a removed rotation key after a save"
[ "$(disk 'has("ResumeFromLast")')" = false ] && ok "the save dropped ResumeFromLast from settings.json" || bad "settings.json still has ResumeFromLast after a save"
[ "$(disk '[.PauseWhenCovered, .GlobalPlaylistStart, .RotateWhileParked, .ShowExpertOptions] == ["maximized","start_over",true,false]')" = true ] \
  && ok "…and wrote the Task 10 keys with their defaults" || bad "settings.json after the save: $(disk '[.PauseWhenCovered, .GlobalPlaylistStart, .RotateWhileParked, .ShowExpertOptions]' | tr -d '\n ')"
if [ "$(engine)" != liascape-player ]; then
  bad "the partial body switched the engine to $(engine) — stopping here (every check below plays on liascape-player)"
  echo "RESULT pass=$pass fail=$fail"; exit 1
fi
ok "the engine is still liascape-player"

echo "== key spelling, arrays, null, unknown keys"
post /settings '{"volume":70,"Speed":1.25}' >/dev/null; snap s2
[ "$(f .volume s2)" = 70 ] && [ "$(f .speed s2)" = 1.25 ] && ok "camelCase + PascalCase keys both bind (volume 70, speed 1.25)" || bad "volume $(f .volume s2) speed $(f .speed s2)"
same s1 s2 '["volume","speed"]' "{volume, Speed}"
post /settings '{"SceneMonitors":[{"Name":"DP-9","Fps":15,"IsPrimary":true}]}' >/dev/null; snap s3
[ "$(f .sceneMonitors s3)" = '[{"name":"DP-9","fps":15,"isPrimary":true}]' ] && ok "SceneMonitors: the array is replaced whole (1 entry)" || bad "sceneMonitors → $(f .sceneMonitors s3)"
same s2 s3 '["sceneMonitors"]' "{SceneMonitors}"
post /settings '{"globalTransitionEffectIds":["wipeLeft"]}' >/dev/null; snap s4
[ "$(f .globalTransitionEffectIds s4)" = '["wipeLeft"]' ] && ok "globalTransitionEffectIds replaced whole" || bad "effect ids → $(f .globalTransitionEffectIds s4)"
same s3 s4 '["globalTransitionEffectIds"]' "{globalTransitionEffectIds}"
post /settings '{"SteamUsername":null}' >/dev/null; snap s5
[ "$(f .steamUsername s5)" = null ] && ok "an explicit null sets null (steamUsername)" || bad "steamUsername → $(f .steamUsername s5)"
same s4 s5 '["steamUsername"]' "{SteamUsername: null}"
post /settings '{"NoSuchSetting":1,"LweSilent":true,"Volume":65}' >/dev/null && ok "unknown keys → 200" || bad "unknown keys → an error"
snap s6
[ "$(f .volume s6)" = 65 ] && [ "$(f 'has("noSuchSetting") or has("NoSuchSetting") or has("lweSilent")' s6)" = false ] \
  && ok "unknown keys (incl. LweSilent) ignored, volume 65 applied" || bad "unknown keys: volume $(f .volume s6), keys kept: $(f 'has("noSuchSetting") or has("lweSilent")' s6)"
same s5 s6 '["volume"]' "{NoSuchSetting, LweSilent, Volume}"

echo "== Phase 3 Task 10: the cover / playlist start / parked / expert settings — partial bodies keep them, bad values are normalized"
snap t0
post /settings '{"PauseWhenCovered":"fullscreen","GlobalPlaylistStart":"resume","RotateWhileParked":false,"ShowExpertOptions":true}' >/dev/null; snap t1
[ "$(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .showExpertOptions]' t1)" = '["fullscreen","resume",false,true]' ] \
  && ok "the four keys set by one partial body (PascalCase)" || bad "Task 10 keys after a partial body: $(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .showExpertOptions]' t1)"
same t0 t1 '["pauseWhenCovered","globalPlaylistStart","rotateWhileParked","showExpertOptions"]' "{PauseWhenCovered, GlobalPlaylistStart, RotateWhileParked, ShowExpertOptions}"
post /settings '{"theme":"Nord"}' >/dev/null; snap t2
[ "$(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .showExpertOptions]' t2)" = '["fullscreen","resume",false,true]' ] \
  && ok "an unrelated partial body keeps them" || bad "an unrelated partial body changed them: $(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .showExpertOptions]' t2)"
for pair in 'PauseWhenCovered:OFF:off' 'pauseWhenCovered:Maximized:maximized' 'pauseWhenCovered:bogus:maximized' 'pauseWhenCovered::maximized'; do
  IFS=: read -r k v want <<< "$pair"
  post /settings "{\"$k\":\"$v\"}" >/dev/null; snap t3
  [ "$(f .pauseWhenCovered t3)" = "\"$want\"" ] && ok "{$k:\"$v\"} → $want" || bad "{$k:\"$v\"} → $(f .pauseWhenCovered t3), want $want"
done
for pair in 'GlobalPlaylistStart:RESUME:resume' 'globalPlaylistStart:nonsense:start_over' 'globalPlaylistStart::start_over'; do
  IFS=: read -r k v want <<< "$pair"
  post /settings "{\"$k\":\"$v\"}" >/dev/null; snap t3
  [ "$(f .globalPlaylistStart t3)" = "\"$want\"" ] && ok "{$k:\"$v\"} → $want" || bad "{$k:\"$v\"} → $(f .globalPlaylistStart t3), want $want"
done
post /settings '{"PauseWhenCovered":"maximized","GlobalPlaylistStart":"start_over","RotateWhileParked":true,"ShowExpertOptions":false,"Theme":"Nord"}' >/dev/null; snap t4
same t0 t4 '["theme"]' "the Task 10 keys back to their defaults"

echo "== a bad value is a 400 and saves nothing"
for body in '{"Volume":"loud"}' '{"Volume":null,"Theme":"Bad"}' '{"SceneMonitors":5}' '[1,2]' '"x"'; do
  cd_=$(code /settings "$body"); [ "$cd_" = 400 ] && ok "$body → 400" || bad "$body → $cd_"
done
snap s7; same s6 s7 '[]' "the rejected bodies"

echo "== the advance-on-end maximum play time: partial bodies, clamped 0…359999 s; the removed keys are unknown ones"
snap l0; post /settings '{"GlobalMinPlaySeconds":30,"GlobalWaitForVideoEnd":true,"PlaylistWaitForVideoEnd":true}' >/dev/null; snap l1
[ "$(f '[has("globalWaitForVideoEnd"), has("globalMinPlaySeconds")] | any' l1)" = false ] && ok "{GlobalMinPlaySeconds, GlobalWaitForVideoEnd} → ignored (removed)" || bad "a removed rotation key came back: $(f '[has("globalWaitForVideoEnd"), has("globalMinPlaySeconds")]' l1)"
same l0 l1 '[]' "{GlobalMinPlaySeconds:30, GlobalWaitForVideoEnd:true, PlaylistWaitForVideoEnd:true}"
post /settings '{"globalMaxPlaySeconds":-5}' >/dev/null; snap l2
[ "$(f .globalMaxPlaySeconds l2)" = 0 ] && ok "{globalMaxPlaySeconds:-5} → clamped to 0 (off)" || bad "globalMaxPlaySeconds -5 → $(f .globalMaxPlaySeconds l2)"
post /settings '{"GlobalMaxPlaySeconds":99999999}' >/dev/null; snap l3
[ "$(f .globalMaxPlaySeconds l3)" = 359999 ] && ok "{GlobalMaxPlaySeconds:99999999} → clamped to 359999" || bad "globalMaxPlaySeconds 99999999 → $(f .globalMaxPlaySeconds l3)"
same l2 l3 '["globalMaxPlaySeconds"]' "{GlobalMaxPlaySeconds:99999999}"
post /settings '{"GlobalMaxPlaySeconds":0}' >/dev/null; snap l4
same l0 l4 '[]' "the limits back to 0"
post /settings '{"GlobalSeparateSceneTiming":false}' >/dev/null; snap l5
[ "$(f .globalSeparateSceneTiming l5)" = false ] && ok "{GlobalSeparateSceneTiming:false} → false" || bad "globalSeparateSceneTiming → $(f .globalSeparateSceneTiming l5)"
same l4 l5 '["globalSeparateSceneTiming"]' "{GlobalSeparateSceneTiming:false}"
post /settings '{"globalSwitchScenesAfterSeconds":-3}' >/dev/null; snap l6
[ "$(f .globalSwitchScenesAfterSeconds l6)" = 0 ] && ok "{globalSwitchScenesAfterSeconds:-3} → clamped to 0 (off)" || bad "globalSwitchScenesAfterSeconds -3 → $(f .globalSwitchScenesAfterSeconds l6)"
same l5 l6 '["globalSwitchScenesAfterSeconds"]' "{globalSwitchScenesAfterSeconds:-3}"
post /settings '{"GlobalSwitchScenesAfterSeconds":99999999}' >/dev/null; snap l7
[ "$(f .globalSwitchScenesAfterSeconds l7)" = 359999 ] && ok "{GlobalSwitchScenesAfterSeconds:99999999} → clamped to 359999" || bad "globalSwitchScenesAfterSeconds 99999999 → $(f .globalSwitchScenesAfterSeconds l7)"
post /settings '{"GlobalSeparateSceneTiming":true,"GlobalSwitchScenesAfterSeconds":1800}' >/dev/null; snap l8
same l4 l8 '[]' "the scene timing back to on, 1800 s"

echo "== parallel partial bodies all land"
# 8 rounds × 10 bodies released at once, each setting a different field: without one poster at a time, two
# that load the same file each save it with only their own field changed → the other's change is lost
PF='["librarySortIndex","lweVolume","sceneTransitionDelayMs","fullLiveSyncOffsetMs","globalTransitionDurationMaxMs",
     "autoMuteDelayMs","autoUnmuteDelayMs","demuxerMaxBackMib","globalTransitionDurationMs","videoFpsCap"]'
lost=$(python3 - "$U" "$PF" <<'PY'
import http.client, json, sys, threading
host, port = sys.argv[1].split("//")[1].split(":"); fields = json.loads(sys.argv[2]); lost = 0
def req(method, body=None):
    c = http.client.HTTPConnection(host, int(port), timeout=10)
    c.request(method, "/settings", body, {"Content-Type": "application/json"} if body else {})
    r = c.getresponse(); data = r.read(); c.close(); return r.status, data
for rnd in range(1, 9):
    want = {f: 10 * i + rnd for i, f in enumerate(fields)}   # 1..88: valid for every one of these fields
    gate = threading.Barrier(len(fields))
    def go(f):
        gate.wait(); req("POST", json.dumps({f: want[f]}))
    ts = [threading.Thread(target=go, args=(f,)) for f in fields]
    [t.start() for t in ts]; [t.join() for t in ts]
    got = json.loads(req("GET")[1])                          # read here, never printed
    lost += sum(1 for f in fields if got.get(f) != want[f])
print(lost)
PY
)
snap s8
[ "$lost" = 0 ] && ok "8 rounds × 10 parallel partial bodies: all 80 landed" || bad "8 rounds × 10 parallel partial bodies: $lost of 80 lost"
same s7 s8 "$PF" "the parallel bodies"

echo "== a partial body applies live (liascape-player playing)"
PLAYER=$(post /library/import "{\"path\":\"$C1\",\"title\":\"merge one\"}" | jq -r .videoPath)
[ -f "$PLAYER" ] && ok "imported a clip into the temp library" || bad "import → $PLAYER"
post /apply "{\"path\":\"$PLAYER\"}" >/dev/null
for _ in $(seq 1 40); do [ "$(cur path)" = "$PLAYER" ] && break; sleep 0.1; done
[ "$(cur path)" = "$PLAYER" ] && ok "/apply → playing" || bad "/apply → cur $(cur path)"
[ "$(engine)" = liascape-player ] || { bad "not on liascape-player any more — stopping"; echo "RESULT pass=$pass fail=$fail"; exit 1; }
# Phase 3 Task 10: the cover setting is a player prop — asserted on this fresh player (its own default is off), then live
pcov() { ctl get '{"path":"player.pause_when_covered"}' | jq -r .value; }
for _ in $(seq 1 30); do [ "$(pcov)" = maximized ] && break; sleep 0.1; done
[ "$(pcov)" = maximized ] && ok "a fresh player was given player.pause_when_covered = maximized (the setting's default)" || bad "player.pause_when_covered = $(pcov) on a fresh player, want maximized"
for v in fullscreen off maximized; do
  post /settings "{\"PauseWhenCovered\":\"$v\"}" >/dev/null
  for _ in $(seq 1 30); do [ "$(pcov)" = "$v" ] && break; sleep 0.1; done
  [ "$(pcov)" = "$v" ] && ok "{PauseWhenCovered:$v} → player.pause_when_covered $v live" || bad "{PauseWhenCovered:$v} → player.pause_when_covered $(pcov)"
done
[ "$(cur path)" = "$PLAYER" ] && [ "$(ctl get '{"path":"player.paused"}' | jq -r .value)" = false ] && ok "…the playing wallpaper untouched, not paused" || bad "the cover setting disturbed the play: cur $(cur path)"
post /settings '{"Volume":45}' >/dev/null; sleep 0.3
near "$(cur gain.user)" "$(dB 45)" && ok "{Volume:45} → gain.user $(cur gain.user)" || bad "{Volume:45} → gain.user $(cur gain.user), want $(dB 45)"
post /settings '{"speed":1.5}' >/dev/null; sleep 0.3
near "$(cur speed)" 1.5 && ok "{speed:1.5} → speed 1.5" || bad "{speed:1.5} → $(cur speed)"
post /settings '{"NoAudio":true}' >/dev/null; sleep 0.3
[ "$(cur no_audio)" = true ] && ok "{NoAudio:true} → no_audio" || bad "{NoAudio:true} → no_audio $(cur no_audio)"
post /settings '{"NoAudio":false}' >/dev/null; sleep 0.3
[ "$(cur no_audio)" = false ] && ok "{NoAudio:false} → audio back" || bad "{NoAudio:false} → no_audio $(cur no_audio)"
post /settings '{"VideoScale":"fit"}' >/dev/null; sleep 0.3
[ "$(ctl get '{"path":"lay:VIRTUAL-1:main.fit"}' | jq -r .value)" = fit ] && ok "{VideoScale:fit} → layer fit" || bad "{VideoScale:fit} → $(ctl get '{"path":"lay:VIRTUAL-1:main.fit"}' | jq -r .value)"
post /library/volume "{\"path\":\"$PLAYER\",\"intValue\":70}" >/dev/null; sleep 0.3
post /settings '{"Volume":30}' >/dev/null; sleep 0.3
near "$(cur gain.user)" "$(dB 70)" && ok "{Volume:30} keeps the playing item's own override 70 (override ?? global)" || bad "{Volume:30} over an override 70 → $(cur gain.user)"
post /library/volume "{\"path\":\"$PLAYER\",\"intValue\":null}" >/dev/null; sleep 0.3
near "$(cur gain.user)" "$(dB 30)" && ok "clearing the override → the partial body's global 30" || bad "cleared → $(cur gain.user), want $(dB 30)"
[ "$(cur path)" = "$PLAYER" ] && ok "the same wallpaper played through every partial body" || bad "the wallpaper changed: cur $(cur path)"

echo "== the full body (the UI's whole copy) behaves as before"
snap f0
# stale like the UI's copy: loaded before an apply (lastSession) and a QR sign-in (the Steam fields)
jq '.volume = 55 | .theme = "Dracula" | .lastSession = null | .steamRefreshToken = "stale" | .steamAccessToken = "" | .steamId = 0' "$T/f0.json" > "$T/full.json"
post /settings "$(cat "$T/full.json")" >/dev/null && ok "a full body → 200" || bad "a full body failed"
sleep 0.3; snap f1
[ "$(f .volume f1)" = 55 ] && [ "$(f .theme f1)" = '"Dracula"' ] && ok "volume 55, theme Dracula" || bad "volume $(f .volume f1) theme $(f .theme f1)"
same f0 f1 '["volume","theme"]' "the full body"
near "$(cur gain.user)" "$(dB 55)" && ok "…and applied live (gain.user $(cur gain.user))" || bad "full body → gain.user $(cur gain.user), want $(dB 55)"
[ "$(disk '.SteamRefreshToken == "test-refresh-token" and .SteamAccessToken == "test-access-token"')" = true ] \
  && ok "a stale copy's Steam tokens don't overwrite the saved ones" || bad "the full body overwrote the Steam tokens"
[ "$(disk '.SteamId == 76561190000000000')" = true ] \
  && ok "a stale copy's steamId doesn't overwrite the saved one (QR sign-in sets it)" || bad "the full body overwrote SteamId"
[ "$(jq -r --arg p "$PLAYER" '.LastSession.Paths[0] == $p' "$SJ")" = true ] \
  && ok "a stale copy's lastSession doesn't overwrite the saved one" || bad "the full body overwrote LastSession"
post /settings '{"lastSession":null,"steamRefreshToken":"","steamId":0}' >/dev/null
[ "$(jq -r --arg p "$PLAYER" '.LastSession.Paths[0] == $p and .SteamRefreshToken == "test-refresh-token" and .SteamId == 76561190000000000' "$SJ")" = true ] \
  && ok "a partial body can't touch the backend-owned fields either" || bad "a partial body changed LastSession / the refresh token / SteamId"
post /stop '{}' >/dev/null; sleep 0.6

echo "== a partial body retimes a running rotation (it follows the globals: interval 600 s)"
post /playlist/play "{\"paths\":[\"$C1\",\"$C2\"],\"settings\":{\"Order\":0}}" >/dev/null
for _ in $(seq 1 40); do [ "$(cur path)" = "$C1" ] && break; sleep 0.1; done
sleep 1.5
[ "$(cur path)" = "$C1" ] && ok "the rotation plays c1 (next switch in ~600 s)" || bad "rotation → cur $(cur path)"
snap r0; post /settings '{"GlobalIntervalSeconds":3}' >/dev/null; snap r1
same r0 r1 '["globalIntervalSeconds"]' "{GlobalIntervalSeconds:3}"
for _ in $(seq 1 60); do [ "$(cur path)" = "$C2" ] && break; sleep 0.1; done
[ "$(cur path)" = "$C2" ] && ok "{GlobalIntervalSeconds:3} → switched to c2 within 6 s (no replay needed)" || bad "the rotation didn't retime: cur $(cur path)"
post /stop '{}' >/dev/null; sleep 0.6

echo "== Phase 3 Task 10: the playlist start / while-parked settings reach the running program live; a playlist's own start beats the global one only under its override"
prog() { ctl get "{\"path\":\"prog:main.$1\"}" 2>/dev/null | jq -r '.value'; }
nsched() { ctl logs '{"kind_prefix":"transition.scheduled","limit":10000}' | jq '.events|length'; }
playedms() { ctl state | jq -r '.programs[]? | select(.id=="prog:main") | .played_ms // 0'; }
post /settings '{"GlobalSwitchWhenVideoEnds":false,"GlobalIntervalSeconds":600,"GlobalPlaylistStart":"start_over","RotateWhileParked":true}' >/dev/null
post /playlist/state '{"videoPaths":[],"settings":{"order":0,"overrideGlobalSettings":false},"name":null}' >/dev/null
post /playlist/play "{\"paths\":[\"$C1\",\"$C2\"],\"settings\":{\"Order\":0}}" >/dev/null
for _ in $(seq 1 40); do [ "$(cur path)" = "$C1" ] && break; sleep 0.1; done
for _ in $(seq 1 30); do [ "$(prog start_mode)" = start_over ] && break; sleep 0.1; done
[ "$(prog start_mode)" = start_over ] && [ "$(prog while_parked)" = rotate ] && ok "a new program starts with the settings: start_mode start_over, while_parked rotate" || bad "program: start_mode $(prog start_mode), while_parked $(prog while_parked)"
n_pt=$(nsched); pl_pt=$(playedms)
waitprog() { local i; for i in $(seq 1 40); do [ "$(prog "$1")" = "$2" ] && return 0; sleep 0.1; done; return 1; }
post /settings '{"GlobalPlaylistStart":"resume"}' >/dev/null
waitprog start_mode resume && ok "{GlobalPlaylistStart:resume} → prog:main.start_mode resume live" || bad "start_mode $(prog start_mode), want resume"
post /settings '{"RotateWhileParked":false}' >/dev/null
waitprog while_parked hold && ok "{RotateWhileParked:false} → prog:main.while_parked hold live" || bad "while_parked $(prog while_parked), want hold"
post /settings '{"RotateWhileParked":true}' >/dev/null
waitprog while_parked rotate && ok "{RotateWhileParked:true} → rotate" || bad "while_parked $(prog while_parked), want rotate"
[ "$(nsched)" = "$n_pt" ] && [ "$(cur path)" = "$C1" ] && python3 -c "import sys; sys.exit(0 if $(playedms) >= $pl_pt - 1 else 1)" \
  && ok "…the current play untouched (no switch scheduled, still c1, played_ms $pl_pt → $(playedms), monotone)" || bad "the settings disturbed the play: switches $n_pt → $(nsched), cur $(cur path), played_ms $pl_pt → $(playedms)"
# the playlist's own start beats the global one only with its override on
ps_body() { echo "{\"videoPaths\":[\"$C1\",\"$C2\"],\"settings\":{\"order\":0,\"overrideGlobalSettings\":$1,\"playlistStart\":\"$2\",\"intervalSeconds\":600,\"switchWhenVideoEnds\":false,\"separateSceneTiming\":false,\"switchScenesAfterSeconds\":1800},\"name\":null}"; }
post /playlist/state "$(ps_body false start_over)" >/dev/null
post /settings '{"GlobalPlaylistStart":"start_over"}' >/dev/null
waitprog start_mode start_over && ok "playlist playlistStart start_over, no override, global start_over → start_over" || bad "start_mode $(prog start_mode)"
post /playlist/state "$(ps_body false resume)" >/dev/null; sleep 0.5
[ "$(prog start_mode)" = start_over ] && ok "its own resume without the override is ignored (the global start_over stays)" || bad "an un-overridden playlist's playlistStart reached the program: $(prog start_mode)"
post /playlist/state "$(ps_body true resume)" >/dev/null
waitprog start_mode resume && ok "the override on → the playlist's own resume beats the global start_over" || bad "start_mode $(prog start_mode), want resume (override on)"
post /settings '{"GlobalPlaylistStart":"start_over","Theme":"Nord"}' >/dev/null; sleep 0.5
[ "$(prog start_mode)" = resume ] && ok "a global change under the override leaves the playlist's own resume" || bad "a global change moved an overriding playlist: $(prog start_mode)"
post /playlist/state "$(ps_body true start_over)" >/dev/null
post /settings '{"GlobalPlaylistStart":"resume"}' >/dev/null; sleep 0.5
[ "$(prog start_mode)" = start_over ] && ok "an overriding playlist's own start_over holds against a global resume" || bad "start_mode $(prog start_mode), want start_over"
post /playlist/state "$(ps_body false start_over)" >/dev/null
waitprog start_mode resume && ok "the override off → the global resume applies again" || bad "start_mode $(prog start_mode), want resume (override off)"
[ "$(nsched)" = "$n_pt" ] && [ "$(cur path)" = "$C1" ] && ok "…and none of it switched anything" || bad "the start-mode edits scheduled switches: $n_pt → $(nsched), cur $(cur path)"
post /settings '{"GlobalPlaylistStart":"start_over"}' >/dev/null
post /stop '{}' >/dev/null; sleep 0.6

echo "== a partial body sets a maximum play time on a running advance-on-end rotation (live)"
post /settings '{"GlobalSwitchWhenVideoEnds":true,"GlobalIntervalSeconds":0}' >/dev/null   # minimum 0: c1 advances at its end
post /playlist/play "{\"paths\":[\"$C1\",\"$C2\"],\"settings\":{\"Order\":0}}" >/dev/null
for _ in $(seq 1 40); do [ "$(cur path)" = "$C1" ] && break; sleep 0.1; done
sleep 1; t_mx=$(date +%s%3N); p_mx=$(cur time_pos)
# c1 ends (6 − its position) s from here: the 2 s maximum must switch well before that, and within ~1 s of the change
lim_mx=$(python3 -c "print(int(min(2200, (6 - float('${p_mx:-0}')) * 1000 - 800)))")
post /settings '{"GlobalMaxPlaySeconds":2}' >/dev/null
for _ in $(seq 1 60); do [ "$(cur path)" = "$C2" ] && break; sleep 0.1; done
d_mx=$(( $(date +%s%3N) - t_mx ))
[ "$(cur path)" = "$C2" ] && [ "$d_mx" -lt "$lim_mx" ] && ok "{GlobalMaxPlaySeconds:2} → c1 (at ${p_mx} s of 6) left for c2 $d_mx ms after (< $lim_mx; no replay)" || bad "max 2 s live: cur $(cur path) $d_mx ms after (c1 was at ${p_mx} s; want < $lim_mx ms)"
post /settings '{"GlobalMaxPlaySeconds":0,"GlobalSwitchWhenVideoEnds":false,"GlobalIntervalSeconds":600}' >/dev/null
post /stop '{}' >/dev/null; sleep 0.6

echo "== a partial body sets \"Switch scenes after\" on a running advance-on-end rotation holding a still image (live)"
# separate timing on, 0 = off → the image (it never ends) stays; {GlobalSwitchScenesAfterSeconds:2} → it moves on
I1=$T/i1.png; timeout 60 ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=320x180" -frames:v 1 "$I1"
# an fps cap on (the parallel section left 98; 30 here explicitly): the player ignores it on a still image
# (it once stalled the image unready — docs/TODO.md "An fps cap stalls a still image", fixed)
post /settings '{"VideoFpsCap":30}' >/dev/null
post /settings '{"GlobalSwitchWhenVideoEnds":true,"GlobalIntervalSeconds":0,"GlobalMaxPlaySeconds":0,"GlobalSeparateSceneTiming":true,"GlobalSwitchScenesAfterSeconds":0}' >/dev/null
post /playlist/play "{\"paths\":[\"$I1\",\"$C1\"],\"settings\":{\"Order\":0}}" >/dev/null
for _ in $(seq 1 40); do [ "$(cur path)" = "$I1" ] && break; sleep 0.1; done
sleep 2
[ "$(cur path)" = "$I1" ] && ok "scenes after 0 = off: the image still shows after 2 s" || bad "scenes after 0 × image: cur $(cur path) after 2 s (want the image)"
t_sc=$(date +%s%3N); post /settings '{"GlobalSwitchScenesAfterSeconds":3}' >/dev/null
for _ in $(seq 1 50); do [ "$(cur path)" = "$C1" ] && break; sleep 0.1; done
d_sc=$(( $(date +%s%3N) - t_sc ))
[ "$(cur path)" = "$C1" ] && [ "$d_sc" -lt 2500 ] && ok "{GlobalSwitchScenesAfterSeconds:3} → the image (2 s in) left for c1 $d_sc ms after (no replay, the play time kept)" \
  || bad "scenes after 3 s live × image: cur $(cur path) $d_sc ms after"
post /settings '{"GlobalSwitchScenesAfterSeconds":1800,"GlobalSwitchWhenVideoEnds":false,"GlobalIntervalSeconds":600}' >/dev/null
post /stop '{}' >/dev/null; sleep 0.6

echo "== a partial body switches the engine (nothing playing → nothing starts)"
mp0=$(pgrep -c -x mpvpaper)
snap e0; post /settings '{"PlayerEngine":"legacy"}' >/dev/null; sleep 1; snap e1
[ "$(engine)" = legacy ] && ok "{PlayerEngine:legacy} → /player-engine active=legacy" || bad "engine → $(engine)"
same e0 e1 '["playerEngine"]' "{PlayerEngine:legacy}"
kill -0 "$SP" 2>/dev/null && bad "liascape-player still running after the switch away" || ok "liascape-player quit on the switch away"
[ "$(pgrep -c -x mpvpaper)" = "$mp0" ] && ok "no mpvpaper started or killed" || bad "the mpvpaper count changed"
grep -q "test-refresh-token" "$T/backend.log" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null && bad "settings dumped to a log" || ok "no settings dump in the logs"
echo "RESULT pass=$pass fail=$fail"
[ $fail = 0 ]
