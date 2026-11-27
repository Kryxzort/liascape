#!/usr/bin/env bash
# Hermetic test of POST /settings's merge (PATCH) semantics on liascape-player: the body's keys
# overwrite the saved settings, every key it leaves out keeps its saved value. Replacing the whole
# AppSettings, a partial body (an agent's {"Volume": 50}) would reset every other field to its C# default
# (SceneMonitors and the rotation among them). Checks: a partial body
# changes only its own fields (camelCase and PascalCase keys), a provided array replaces the whole array,
# an explicit null sets null, unknown keys (incl. the removed LweSilent) are ignored, a bad value is a 400
# that saves nothing, parallel partial bodies all land, a full body (the UI's whole copy) behaves as
# before incl. the backend-owned fields kept from disk, and a partial body still applies live: Volume /
# Speed / NoAudio / VideoScale on the playing wallpaper, override ?? global, a running rotation's
# interval; the removed PlayerEngine key is ignored. Also: a settings.json that still carries LweSilent loads.
# PauseWhenCovered (default maximized) / GlobalPlaylistStart (start_over) / RotateWhileParked (true) /
# SettingsLevel ("standard") — the defaults on a file without the keys, partial bodies keep them, bad values are
# normalized, an old file's ResumeFromLast loads and is gone from GET and the next save, each is live on the player
# (`player.pause_when_covered`, `prog:main.start_mode` / `.while_parked`, the current play untouched), and a playlist's
# own PlaylistStart beats the global one only with its override on.
# SceneVramStopShows (default last_frame): the default on a file without it, partial bodies keep it, unknown values read
# as the default, live on `player.scene_vram_stop_shows`.
#
# Hermetic like scripts/test-liascape-player-adapter.sh: temp HOME + every XDG dir (own settings.json, library,
# player socket), a private `liascape-player serve --headless --clock real --ao null`, its own backend port;
# never touches another backend, the real settings or the real player, and stops before any playback call
# unless /player-engine says the player is available. It never prints a
# /settings response or settings.json — only field NAMES and non-secret single values. Stopped on exit.
#
# Usage: scripts/test-settings-merge.sh [--no-build]
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs / screenshots and prints where (last line).
# Needs: dotnet (or DOTNET=…), ffmpeg, jq, curl, python3. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/test-lock.sh" # one heavy test run at a time on this machine
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)  # physical path: a symlinked alias makes MSBuild delete its own outputs
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
. "$ROOT/scripts/test-no-network.sh"   # lp_real_network: a call to a real server fails the run
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
[ -n "${LIASCAPE_NETNS:-}" ] && BUILD=0   # built outside, before the namespace
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

# Everything from here on runs in its own network namespace (scripts/test-netns.sh, as this user): what the suite starts
# (the backend, the player, mpv, ffmpeg) reaches no real network and looks no name up, under the backend's own
# LIASCAPE_TEST_NO_NETWORK guard. exec'd in place: this pid keeps the test lock.
if [ -z "${LIASCAPE_NETNS:-}" ]; then
  NSD=$(mktemp -d /tmp/liascape-ns-XXXXXX)
  LIASCAPE_NETNS=$NSD exec unshare -rnm bash "$ROOT/scripts/test-netns.sh" --own-uid "$NSD" bash "${BASH_SOURCE[0]}" "$@"
fi
lp_netns_entered
lp_no_lookup "RESULT pass=0 fail=1" || exit 1
T=$(mktemp -d /tmp/liascape-sm-XXXXXX)   # short: a unix socket path must be < 108 bytes
# run the backend from a private copy of its build (a `dotnet watch` on this tree may rebuild bin/Debug
# mid-test — see test-liascape-player-adapter.sh's snapshot_backend)
mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
DLL=$T/backend/liascape-backend.dll
mkdir -p "$T/home/.config/liascape" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st"
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export LIASCAPE_SECRETS=file # Helpers/SecretStore.cs: the Steam secrets never reach the session's keyring from a test
# every curl here goes to the private backend: it carries the backend's API token (serve.token beside serve.port, read
# per call — a restarted backend may have written it since; .claude/rules/backend/api.md § Security). /health needs none.
curl() { command curl -H "X-Liascape-Token: $(cat "$XDG_CONFIG_HOME/liascape/serve.token" 2>/dev/null)" "$@"; }
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LIASCAPE_PLAYER_BIN=$B LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# no real server: anything but loopback is refused and fails the run (scripts/test-no-network.sh)
export LIASCAPE_TEST_NO_NETWORK=1
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT
SP=""; BP=""
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1   # clean child exit → the supervisor exits too
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  lp_tmp_done "$T" /tmp/liascape-sm- "$rc"
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

# Non-default values everywhere, so a reset to a C# default shows; LweSilent, SteamUsername and SteamCmdPath = removed
# settings, still in older files, and "steamcmd" a removed download mode; the Steam fields are dummies (still never printed — the real file holds a real token).
SJ=$XDG_CONFIG_HOME/liascape/settings.json
# the Steam tokens live in steam-auth.json (Helpers/SecretStore.cs, LIASCAPE_SECRETS=file), seeded there: settings.json
# never held them since the pre-release cleanup (no migration from it)
mkdir -p "$XDG_CONFIG_HOME/liascape"
(umask 077; printf '%s' '{"steam-refresh-token":"test-refresh-token","steam-access-token":"test-access-token"}' > "$XDG_CONFIG_HOME/liascape/steam-auth.json")
cat > "$SJ" <<EOF
{"NoAudio":false,"Volume":80,"Speed":1,"VideoScale":"fill","HwDec":"no",
 "DemuxerMaxMib":32,"DemuxerMaxBackMib":8,"LweSilent":true,"LweVolume":55,
 "SceneMonitors":[{"Name":"DP-1","Fps":144,"IsPrimary":true},{"Name":"HDMI-A-1","Fps":30,"IsPrimary":false}],
 "SceneTransitionDelayMs":1500,"Theme":"Catppuccin Latte","CardSize":"Large","ThumbnailAspect":"16:9","LibrarySortIndex":2,
 "GlobalIntervalSeconds":600,"GlobalSwitchWhenVideoEnds":false,"GlobalWaitForVideoEnd":true,"PlaylistWaitForVideoEnd":true,"GlobalMinPlaySeconds":45,"GlobalMaxPlaySeconds":0,
 "GlobalTransitionEnabled":false,"GlobalTransitionEffectIds":["fade","wipeLeft"],"GlobalTransitionDurationMs":900,
 "TransitionMethod":"full-live","AdvancedSettings":true,"ResumeFromLast":false,"StayPausedWhenSwitching":true,"AutoMute":false,
 "AllowScenes":true,"WorkshopDownloadMode":"steamcmd","AutoPlayGifs":true,"AutoPlayVideoThumbs":true,"PreferVideoThumbs":true,
 "SteamAccountName":"test-account","SteamId":76561190000000000,"SteamUsername":"test-user","SteamCmdPath":"/nonexistent/steamcmd",
 "SteamClientLibPath":"/nonexistent/steamclient.so"}
EOF

(cd /tmp && exec "$B" serve --headless --outputs 640x360@60 --clock real --ao null > "$T/serve.log" 2>&1) & SP=$!
for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
"$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "ABORT: backend didn't start"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
available() { curl -sf -m 5 "$U/player-engine" | jq -r .available; }
[ "$(available)" = true ] || { echo "ABORT: the backend's liascape-player isn't available"; exit 1; }

post() { curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
cur()  { ctl get "{\"path\":\"cur:*.$1\"}" 2>/dev/null | jq -r '.value'; }
snap() { curl -sf -m 5 "$U/settings" > "$T/$1.json"; }           # kept in $T, never printed
f()    { jq -c "$1" "$T/$2.json"; }                                # one NON-secret field of a snapshot
disk() { jq -r "$1" "$SJ"; }                                       # a boolean/non-secret test on the file
# the Steam tokens: moved out of settings.json by the backend (Helpers/SecretStore.cs; LIASCAPE_SECRETS=file → steam-auth.json)
AJ=$XDG_CONFIG_HOME/liascape/steam-auth.json
tokens_kept() {   # true = in steam-auth.json (0600) with the seeded values, and settings.json has neither key
  [ "$(jq -r '.["steam-refresh-token"] == "test-refresh-token" and .["steam-access-token"] == "test-access-token"' "$AJ" 2>/dev/null)" = true ] \
    && [ "$(stat -c %a "$AJ")" = 600 ] && [ "$(disk 'has("SteamRefreshToken") or has("SteamAccessToken")')" = false ]
}
# the NAMES of the fields that differ between two snapshots, minus the ones this step changes on purpose
changed() { jq -rn --slurpfile a "$T/$1.json" --slurpfile b "$T/$2.json" --argjson want "${3:-[]}" \
  '$a[0] as $x | $b[0] as $y | ([$x, $y] | map(keys[]) | unique | map(select($x[.] != $y[.]))) - $want | join(",")'; }
same() {   # $1 before, $2 after, $3 = JSON array of the fields that should change, $4 = what
  local c; c=$(changed "$1" "$2" "${3:-[]}")
  [ -z "$c" ] && ok "$4: no other field changed" || bad "$4 also changed: $c"
}

# UI toggles (key:default, camelCase as GET /settings spells them): a file without the key loads the default, a
# partial body sets/keeps it. Glow effects / Text shadow / Smooth window animations (Settings → Look & feel), Import new Workshop wallpapers.
UI_TOGGLES=("glows:true" "textShadow:false" "morphs:true" "autoAddWeWallpapersToLibrary:true")
echo "== a settings.json that still carries the removed LweSilent loads"
snap s0
[ "$(f .volume s0)" = 80 ] && [ "$(f .theme s0)" = '"Catppuccin Latte"' ] && [ "$(f '.sceneMonitors|length' s0)" = 2 ] \
  && ok "loaded the file, not the defaults (volume 80, theme, 2 SceneMonitors)" || bad "loaded volume $(f .volume s0) theme $(f .theme s0)"
[ "$(f 'has("lweSilent")' s0)" = false ] && ok "GET /settings has no lweSilent" || bad "GET /settings still has lweSilent"
# no "Wait for video to end after interval", and no separate minimum: it is the interval field (= the minimum under
# advance-on-end; docs/decisions.md § "Use one interval field: "Switch every" or "Minimum play time"") — an old file's
# keys load as unknown ones, no migration (.claude/rules/backend/state-files.md § Writing)
[ "$(f '[has("globalWaitForVideoEnd"), has("playlistWaitForVideoEnd"), has("globalMinPlaySeconds")] | any' s0)" = false ] \
  && ok "GET /settings has no globalWaitForVideoEnd / playlistWaitForVideoEnd / globalMinPlaySeconds (removed)" \
  || bad "GET /settings still has a removed rotation key: $(f '[has("globalWaitForVideoEnd"), has("playlistWaitForVideoEnd"), has("globalMinPlaySeconds")]' s0)"
[ "$(f '[.globalIntervalSeconds, .globalSwitchWhenVideoEnds, .globalMaxPlaySeconds]' s0)" = '[600,false,0]' ] \
  && ok "the rotation fields that stay loaded from the old file as they were (interval 600, advance off, max 0)" \
  || bad "rotation fields after loading an old file: $(f '[.globalIntervalSeconds, .globalSwitchWhenVideoEnds, .globalMaxPlaySeconds]' s0)"
# "Separate timing for scenes": a file without its keys loads the defaults — on, 30 min
[ "$(f '[.globalSeparateSceneTiming, .globalSwitchScenesAfterSeconds]' s0)" = '[true,1800]' ] \
  && ok "a file without the scene-timing keys: globalSeparateSceneTiming true, globalSwitchScenesAfterSeconds 1800 (the defaults)" \
  || bad "scene-timing fields after loading a file without them: $(f '[.globalSeparateSceneTiming, .globalSwitchScenesAfterSeconds]' s0)"

# a file without the cover / playlist start / parked / level keys loads their defaults; the folded-in ResumeFromLast is
# an unknown key — no migration, gone from GET and from the next save
[ "$(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .settingsLevel]' s0)" = '["maximized","start_over",true,"standard"]' ] \
  && ok "a file without the Task 10 keys: pauseWhenCovered maximized, globalPlaylistStart start_over, rotateWhileParked true, settingsLevel standard" \
  || bad "Task 10 defaults after loading an old file: $(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .settingsLevel]' s0)"
[ "$(f 'has("resumeFromLast")' s0)" = false ] && ok "GET /settings has no resumeFromLast (the old file's key is an unknown one)" || bad "GET /settings still has resumeFromLast"
# the card previews are two orders ("On hover" / "Not hovered"): the three toggles they replaced are unknown keys, no
# migration — a file with them loads the orders' defaults (what plays by default, nothing unhovered, the GIF first on hover)
[ "$(f '[has("autoPlayGifs"), has("autoPlayVideoThumbs"), has("preferVideoThumbs")] | any' s0)" = false ] \
  && ok "GET /settings has no autoPlayGifs / autoPlayVideoThumbs / preferVideoThumbs (replaced by the preview orders)" \
  || bad "GET /settings still has a replaced preview toggle: $(f '[has("autoPlayGifs"), has("autoPlayVideoThumbs"), has("preferVideoThumbs")]' s0)"
[ "$(f '[.previewOnHover, .previewNotHovered]' s0)" = '[["gif","video","image"],["image","gif","video"]]' ] \
  && ok "a file with the old toggles on: previewOnHover gif,video,image and previewNotHovered image,gif,video (the defaults)" \
  || bad "preview orders after loading an old file: $(f '[.previewOnHover, .previewNotHovered]' s0)"

# the dropped "steamcmd" download mode reads as the default ("steamapp"); its two settings are unknown keys (no migration)
[ "$(f .workshopDownloadMode s0)" = '"steamapp"' ] && ok "an old file's WorkshopDownloadMode \"steamcmd\" loads as \"steamapp\" (the default)" \
  || bad "WorkshopDownloadMode \"steamcmd\" loaded as $(f .workshopDownloadMode s0)"
[ "$(f '[has("steamUsername"), has("steamCmdPath")] | any' s0)" = false ] && ok "GET /settings has no steamUsername / steamCmdPath (removed with the steamcmd mode)" \
  || bad "GET /settings still has a steamcmd setting: $(f '[has("steamUsername"), has("steamCmdPath")]' s0)"

echo "== a partial body changes only its own fields (nothing playing)"
post /settings '{"Theme":"Nord"}' >/dev/null && ok "POST {\"Theme\":\"Nord\"} → 200" || bad "POST {\"Theme\":\"Nord\"} failed"
snap s1
[ "$(f .theme s1)" = '"Nord"' ] && ok "theme → Nord" || bad "theme → $(f .theme s1)"
c=$(changed s0 s1 '["theme"]')
[ -z "$c" ] && ok "a partial body: no other field changed" || bad "a partial body reset $(echo "$c" | tr ',' '\n' | wc -l) other fields: $c"
tokens_kept && ok "the Steam tokens survived in steam-auth.json (0600), none in settings.json" \
  || bad "the Steam tokens in steam-auth.json changed (or leaked into settings.json)"
[ "$(disk 'has("LweSilent")')" = false ] && ok "the save dropped LweSilent from settings.json" || bad "settings.json still has LweSilent after a save"
[ "$(disk '[has("GlobalWaitForVideoEnd"), has("PlaylistWaitForVideoEnd"), has("GlobalMinPlaySeconds")] | any')" = false ] \
  && ok "the save dropped the removed rotation keys from settings.json" || bad "settings.json still has a removed rotation key after a save"
[ "$(disk 'has("ResumeFromLast")')" = false ] && ok "the save dropped ResumeFromLast from settings.json" || bad "settings.json still has ResumeFromLast after a save"
[ "$(disk '[has("AutoPlayGifs"), has("AutoPlayVideoThumbs"), has("PreferVideoThumbs")] | any')" = false ] \
  && ok "the save dropped AutoPlayGifs / AutoPlayVideoThumbs / PreferVideoThumbs from settings.json" || bad "settings.json still has a replaced preview toggle after a save"
[ "$(disk '[.PreviewOnHover, .PreviewNotHovered] == [["gif","video","image"],["image","gif","video"]]')" = true ] \
  && ok "…and wrote the preview orders with their defaults" || bad "settings.json preview orders after the save: $(disk '[.PreviewOnHover, .PreviewNotHovered]' | tr -d '\n ')"
[ "$(disk '[.PauseWhenCovered, .GlobalPlaylistStart, .RotateWhileParked, .SettingsLevel] == ["maximized","start_over",true,"standard"]')" = true ] \
  && ok "…and wrote the Task 10 keys with their defaults" || bad "settings.json after the save: $(disk '[.PauseWhenCovered, .GlobalPlaylistStart, .RotateWhileParked, .SettingsLevel]' | tr -d '\n ')"
if [ "$(available)" != true ]; then
  bad "liascape-player is no longer available — stopping here (every check below plays on it)"
  echo "RESULT pass=$pass fail=$fail"; exit 1
fi
ok "liascape-player is still available"

echo "== key spelling, arrays, null, unknown keys"
post /settings '{"volume":70,"Speed":1.25}' >/dev/null; snap s2
[ "$(f .volume s2)" = 70 ] && [ "$(f .speed s2)" = 1.25 ] && ok "camelCase + PascalCase keys both bind (volume 70, speed 1.25)" || bad "volume $(f .volume s2) speed $(f .speed s2)"
same s1 s2 '["volume","speed"]' "{volume, Speed}"
post /settings '{"SceneMonitors":[{"Name":"DP-9","Fps":15,"IsPrimary":true}]}' >/dev/null; snap s3
[ "$(f .sceneMonitors s3)" = '[{"name":"DP-9","fps":15}]' ] && ok "SceneMonitors: the array is replaced whole (1 entry; an entry's unknown isPrimary dropped)" || bad "sceneMonitors → $(f .sceneMonitors s3)"
same s2 s3 '["sceneMonitors"]' "{SceneMonitors}"
post /settings '{"globalTransitionEffectIds":["wipeLeft"]}' >/dev/null; snap s4
[ "$(f .globalTransitionEffectIds s4)" = '["wipeLeft"]' ] && ok "globalTransitionEffectIds replaced whole" || bad "effect ids → $(f .globalTransitionEffectIds s4)"
same s3 s4 '["globalTransitionEffectIds"]' "{globalTransitionEffectIds}"
post /settings '{"SteamClientLibPath":null}' >/dev/null; snap s5
[ "$(f .steamClientLibPath s5)" = null ] && ok "an explicit null sets null (steamClientLibPath)" || bad "steamClientLibPath → $(f .steamClientLibPath s5)"
same s4 s5 '["steamClientLibPath"]' "{SteamClientLibPath: null}"
post /settings '{"NoSuchSetting":1,"LweSilent":true,"Volume":65}' >/dev/null && ok "unknown keys → 200" || bad "unknown keys → an error"
snap s6
[ "$(f .volume s6)" = 65 ] && [ "$(f 'has("noSuchSetting") or has("NoSuchSetting") or has("lweSilent")' s6)" = false ] \
  && ok "unknown keys (incl. LweSilent) ignored, volume 65 applied" || bad "unknown keys: volume $(f .volume s6), keys kept: $(f 'has("noSuchSetting") or has("lweSilent")' s6)"
same s5 s6 '["volume"]' "{NoSuchSetting, LweSilent, Volume}"

echo "== Phase 3 Task 10: the cover / playlist start / parked / expert settings — partial bodies keep them, bad values are normalized"
snap t0
post /settings '{"PauseWhenCovered":"fullscreen","GlobalPlaylistStart":"resume","RotateWhileParked":false,"SettingsLevel":"expert"}' >/dev/null; snap t1
[ "$(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .settingsLevel]' t1)" = '["fullscreen","resume",false,"expert"]' ] \
  && ok "the four keys set by one partial body (PascalCase)" || bad "Task 10 keys after a partial body: $(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .settingsLevel]' t1)"
same t0 t1 '["pauseWhenCovered","globalPlaylistStart","rotateWhileParked","settingsLevel"]' "{PauseWhenCovered, GlobalPlaylistStart, RotateWhileParked, SettingsLevel}"
post /settings '{"theme":"Nord"}' >/dev/null; snap t2
[ "$(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .settingsLevel]' t2)" = '["fullscreen","resume",false,"expert"]' ] \
  && ok "an unrelated partial body keeps them" || bad "an unrelated partial body changed them: $(f '[.pauseWhenCovered, .globalPlaylistStart, .rotateWhileParked, .settingsLevel]' t2)"
for pair in 'PauseWhenCovered:OFF:off' 'pauseWhenCovered:Maximized:maximized' 'pauseWhenCovered:bogus:maximized' 'pauseWhenCovered::maximized'; do
  IFS=: read -r k v want <<< "$pair"
  post /settings "{\"$k\":\"$v\"}" >/dev/null; snap t3
  [ "$(f .pauseWhenCovered t3)" = "\"$want\"" ] && ok "{$k:\"$v\"} → $want" || bad "{$k:\"$v\"} → $(f .pauseWhenCovered t3), want $want"
done
for pair in 'SettingsLevel:EXPERT:expert' 'settingsLevel:Basic:basic' 'settingsLevel:nonsense:standard' 'settingsLevel::standard'; do
  IFS=: read -r k v want <<< "$pair"
  post /settings "{\"$k\":\"$v\"}" >/dev/null; snap t3
  [ "$(f .settingsLevel t3)" = "\"$want\"" ] && ok "{$k:\"$v\"} → $want" || bad "{$k:\"$v\"} → $(f .settingsLevel t3), want $want"
done
for pair in 'GlobalPlaylistStart:RESUME:resume' 'globalPlaylistStart:nonsense:start_over' 'globalPlaylistStart::start_over'; do
  IFS=: read -r k v want <<< "$pair"
  post /settings "{\"$k\":\"$v\"}" >/dev/null; snap t3
  [ "$(f .globalPlaylistStart t3)" = "\"$want\"" ] && ok "{$k:\"$v\"} → $want" || bad "{$k:\"$v\"} → $(f .globalPlaylistStart t3), want $want"
done
post /settings '{"PauseWhenCovered":"maximized","GlobalPlaylistStart":"start_over","RotateWhileParked":true,"SettingsLevel":"standard","Theme":"Nord"}' >/dev/null; snap t4
same t0 t4 '["theme"]' "the Task 10 keys back to their defaults"

echo "== Video preview quality: a file without it loads mid; partial bodies set / keep it; unknown values read as mid"
[ "$(f .videoPreviewQuality s0)" = '"mid"' ] && ok "a file without videoPreviewQuality: mid (the default)" || bad "videoPreviewQuality after loading a file without it: $(f .videoPreviewQuality s0)"
snap v0
post /settings '{"VideoPreviewQuality":"high"}' >/dev/null; snap v1
[ "$(f .videoPreviewQuality v1)" = '"high"' ] && ok "{VideoPreviewQuality:high} → high" || bad "{VideoPreviewQuality:high} → $(f .videoPreviewQuality v1)"
same v0 v1 '["videoPreviewQuality"]' "{VideoPreviewQuality:high}"
[ "$(disk .VideoPreviewQuality)" = high ] && ok "VideoPreviewQuality high written to settings.json" || bad "settings.json VideoPreviewQuality → $(disk .VideoPreviewQuality)"
post /settings '{"theme":"Nord"}' >/dev/null; snap v2
[ "$(f .videoPreviewQuality v2)" = '"high"' ] && ok "an unrelated partial body keeps videoPreviewQuality high" || bad "an unrelated partial body changed videoPreviewQuality to $(f .videoPreviewQuality v2)"
for pair in 'videoPreviewQuality:LOW:low' 'VideoPreviewQuality:ultra:mid' 'videoPreviewQuality:high:high' 'videoPreviewQuality::mid'; do
  IFS=: read -r k v want <<< "$pair"
  post /settings "{\"$k\":\"$v\"}" >/dev/null; snap v3
  [ "$(f .videoPreviewQuality v3)" = "\"$want\"" ] && ok "{$k:\"$v\"} → $want" || bad "{$k:\"$v\"} → $(f .videoPreviewQuality v3), want $want"
done
code_=$(code /settings '{"VideoPreviewQuality":5}'); [ "$code_" = 400 ] && ok "{VideoPreviewQuality:5} → 400" || bad "{VideoPreviewQuality:5} → $code_"
snap v4; [ "$(f .videoPreviewQuality v4)" = '"mid"' ] && ok "…and videoPreviewQuality stays mid" || bad "videoPreviewQuality after the rejected body: $(f .videoPreviewQuality v4)"
same v0 v4 '["theme"]' "videoPreviewQuality back to mid"

echo "== What a scene stopped by its video memory cap shows: a file without it loads last_frame; partial bodies set / keep it; unknown values read as last_frame"
[ "$(f .sceneVramStopShows s0)" = '"last_frame"' ] && ok "a file without sceneVramStopShows: last_frame (the default)" || bad "sceneVramStopShows after loading a file without it: $(f .sceneVramStopShows s0)"
snap x0
post /settings '{"SceneVramStopShows":"nothing"}' >/dev/null; snap x1
[ "$(f .sceneVramStopShows x1)" = '"nothing"' ] && ok "{SceneVramStopShows:nothing} → nothing" || bad "{SceneVramStopShows:nothing} → $(f .sceneVramStopShows x1)"
same x0 x1 '["sceneVramStopShows"]' "{SceneVramStopShows:nothing}"
[ "$(disk .SceneVramStopShows)" = nothing ] && ok "SceneVramStopShows nothing written to settings.json" || bad "settings.json SceneVramStopShows → $(disk .SceneVramStopShows)"
post /settings '{"theme":"Nord"}' >/dev/null; snap x2
[ "$(f .sceneVramStopShows x2)" = '"nothing"' ] && ok "an unrelated partial body keeps sceneVramStopShows nothing" || bad "an unrelated partial body changed sceneVramStopShows to $(f .sceneVramStopShows x2)"
for pair in 'sceneVramStopShows:LAST_FRAME:last_frame' 'SceneVramStopShows:black:last_frame' 'sceneVramStopShows:Nothing:nothing' 'sceneVramStopShows::last_frame'; do
  IFS=: read -r k v want <<< "$pair"
  post /settings "{\"$k\":\"$v\"}" >/dev/null; snap x3
  [ "$(f .sceneVramStopShows x3)" = "\"$want\"" ] && ok "{$k:\"$v\"} → $want" || bad "{$k:\"$v\"} → $(f .sceneVramStopShows x3), want $want"
done
code_=$(code /settings '{"SceneVramStopShows":5}'); [ "$code_" = 400 ] && ok "{SceneVramStopShows:5} → 400" || bad "{SceneVramStopShows:5} → $code_"
snap x4; [ "$(f .sceneVramStopShows x4)" = '"last_frame"' ] && ok "…and sceneVramStopShows stays last_frame" || bad "sceneVramStopShows after the rejected body: $(f .sceneVramStopShows x4)"
same x0 x4 '["theme"]' "sceneVramStopShows back to last_frame"

echo "== UI toggles: defaults on a file without the keys, partial bodies set / keep them, in either key spelling"
for spec in "${UI_TOGGLES[@]}"; do
  k=${spec%%:*}; def=${spec##*:}; K=$(python3 -c "print('$k'[0].upper()+'$k'[1:])"); inv=$([ "$def" = true ] && echo false || echo true)
  [ "$(f ".$k" s0)" = "$def" ] && ok "a file without $k: $k $def (the default)" || bad "$k after loading a file without it: $(f ".$k" s0), want $def"
  snap u0
  post /settings "{\"$K\":$inv}" >/dev/null; snap u1
  [ "$(f ".$k" u1)" = "$inv" ] && ok "{$K:$inv} → $k $inv" || bad "{$K:$inv} → $k $(f ".$k" u1)"
  same u0 u1 "[\"$k\"]" "{$K:$inv}"
  [ "$(disk ".$K")" = "$inv" ] && ok "$K $inv written to settings.json" || bad "settings.json $K → $(disk ".$K")"
  post /settings '{"theme":"Nord"}' >/dev/null; snap u2
  [ "$(f ".$k" u2)" = "$inv" ] && ok "an unrelated partial body keeps $k $inv" || bad "an unrelated partial body changed $k to $(f ".$k" u2)"
  post /settings "{\"$k\":$def}" >/dev/null; snap u3
  [ "$(f ".$k" u3)" = "$def" ] && ok "{$k:$def} (camelCase) → $k $def" || bad "{$k:$def} → $k $(f ".$k" u3)"
  same u2 u3 "[\"$k\"]" "{$k:$def}"
  code_=$(code /settings "{\"$K\":\"yes\"}"); [ "$code_" = 400 ] && ok "{$K:\"yes\"} → 400" || bad "{$K:\"yes\"} → $code_"
  snap u4; [ "$(f ".$k" u4)" = "$def" ] && ok "…and $k stays $def" || bad "$k after the rejected body: $(f ".$k" u4)"
done

echo "== the preview orders: a partial body sets one list, any list stores as the three kinds once each, a non-list is a 400"
snap o0
post /settings '{"PreviewNotHovered":["video","gif","image"]}' >/dev/null; snap o1
[ "$(f .previewNotHovered o1)" = '["video","gif","image"]' ] && ok "{PreviewNotHovered:[video,gif,image]} → stored" || bad "PreviewNotHovered → $(f .previewNotHovered o1)"
same o0 o1 '["previewNotHovered"]' "{PreviewNotHovered:[…]}"
[ "$(disk '.PreviewNotHovered == ["video","gif","image"]')" = true ] && ok "PreviewNotHovered written to settings.json" || bad "settings.json PreviewNotHovered → $(disk '.PreviewNotHovered' | tr -d '\n ')"
post /settings '{"theme":"Nord"}' >/dev/null; snap o2
[ "$(f .previewNotHovered o2)" = '["video","gif","image"]' ] && ok "an unrelated partial body keeps previewNotHovered" || bad "an unrelated partial body changed previewNotHovered to $(f .previewNotHovered o2)"
for c in '["IMAGE","Gif"]|["image","gif","video"]|upper case, missing video (appended last: unreachable)' \
         '["gif","gif","sparkle","video"]|["gif","video","image"]|a repeat and an unknown kind dropped' \
         '[]|["image","gif","video"]|empty: the default order'; do
  body=${c%%|*}; rest=${c#*|}; want=${rest%%|*}; what=${rest#*|}
  post /settings "{\"previewNotHovered\":$body}" >/dev/null; snap o3
  [ "$(f .previewNotHovered o3)" = "$want" ] && ok "{previewNotHovered:$body} → $want ($what)" || bad "{previewNotHovered:$body} → $(f .previewNotHovered o3), want $want ($what)"
done
post /settings '{"previewOnHover":["video","image","gif"]}' >/dev/null; snap o4
[ "$(f .previewOnHover o4)" = '["video","image","gif"]' ] && ok "{previewOnHover:[video,image,gif]} (camelCase) → stored" || bad "previewOnHover → $(f .previewOnHover o4)"
code_=$(code /settings '{"PreviewOnHover":"video"}'); [ "$code_" = 400 ] && ok "{PreviewOnHover:\"video\"} → 400" || bad "{PreviewOnHover:\"video\"} → $code_"
snap o5; [ "$(f .previewOnHover o5)" = '["video","image","gif"]' ] && ok "…and previewOnHover stays as it was" || bad "previewOnHover after the rejected body: $(f .previewOnHover o5)"
post /settings '{"PreviewOnHover":["gif","video","image"],"PreviewNotHovered":["image","gif","video"]}' >/dev/null; snap o6
same o0 o6 '["theme"]' "the preview orders back to the defaults"

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
# "Switch scenes and pictures after" is never 0: 1 s is the floor (no "stay until you switch" any more)
post /settings '{"globalSwitchScenesAfterSeconds":-3}' >/dev/null; snap l6
[ "$(f .globalSwitchScenesAfterSeconds l6)" = 1 ] && ok "{globalSwitchScenesAfterSeconds:-3} → clamped to 1 (the floor)" || bad "globalSwitchScenesAfterSeconds -3 → $(f .globalSwitchScenesAfterSeconds l6), want 1"
same l5 l6 '["globalSwitchScenesAfterSeconds"]' "{globalSwitchScenesAfterSeconds:-3}"
post /settings '{"GlobalSwitchScenesAfterSeconds":0}' >/dev/null; snap l6b
[ "$(f .globalSwitchScenesAfterSeconds l6b)" = 1 ] && ok "{GlobalSwitchScenesAfterSeconds:0} → 1 (0 is no longer \"stay\")" || bad "globalSwitchScenesAfterSeconds 0 → $(f .globalSwitchScenesAfterSeconds l6b), want 1"
post /settings '{"GlobalSwitchScenesAfterSeconds":99999999}' >/dev/null; snap l7
[ "$(f .globalSwitchScenesAfterSeconds l7)" = 359999 ] && ok "{GlobalSwitchScenesAfterSeconds:99999999} → clamped to 359999" || bad "globalSwitchScenesAfterSeconds 99999999 → $(f .globalSwitchScenesAfterSeconds l7)"
post /settings '{"GlobalSeparateSceneTiming":true,"GlobalSwitchScenesAfterSeconds":1800}' >/dev/null; snap l8
same l4 l8 '[]' "the scene timing back to on, 1800 s"

echo "== the loudness target: 0 LUFS (the loudest) is valid; above it clamps to 0, below -100 to -100"
post /settings '{"NormalizeTargetLufs":0}' >/dev/null; snap n1
[ "$(f .normalizeTargetLufs n1)" = 0 ] && ok "{NormalizeTargetLufs:0} → 0" || bad "normalizeTargetLufs 0 → $(f .normalizeTargetLufs n1)"
same l8 n1 '["normalizeTargetLufs"]' "{NormalizeTargetLufs:0}"
post /settings '{"normalizeTargetLufs":5}' >/dev/null; snap n2
[ "$(f .normalizeTargetLufs n2)" = 0 ] && ok "{normalizeTargetLufs:5} → clamped to 0" || bad "normalizeTargetLufs 5 → $(f .normalizeTargetLufs n2)"
post /settings '{"NormalizeTargetLufs":-150}' >/dev/null; snap n3
[ "$(f .normalizeTargetLufs n3)" = -100 ] && ok "{NormalizeTargetLufs:-150} → clamped to -100" || bad "normalizeTargetLufs -150 → $(f .normalizeTargetLufs n3)"
post /settings '{"NormalizeTargetLufs":-14}' >/dev/null; snap n4
same l8 n4 '[]' "the loudness target back to -14"

echo "== the maximum play time is 0 (off) or at least the minimum (advance-on-end); a playlist's own too"
# what the section changes, put back at its end
rot0=$(f '{GlobalSwitchWhenVideoEnds:.globalSwitchWhenVideoEnds, GlobalIntervalSeconds:.globalIntervalSeconds, GlobalMaxPlaySeconds:.globalMaxPlaySeconds}' l8)
mx() { snap "$1"; f '[.globalSwitchWhenVideoEnds, .globalIntervalSeconds, .globalMaxPlaySeconds]' "$1"; }
post /settings '{"GlobalSwitchWhenVideoEnds":true,"GlobalIntervalSeconds":60,"GlobalMaxPlaySeconds":30}' >/dev/null
[ "$(mx n1)" = '[true,60,60]' ] && ok "{minimum 60, maximum 30} → the maximum stored as 60 (never below the minimum)" || bad "{minimum 60, maximum 30} → $(mx n1), want [true,60,60]"
post /settings '{"GlobalMaxPlaySeconds":45}' >/dev/null
[ "$(mx n2)" = '[true,60,60]' ] && ok "{maximum 45} under a 60 s minimum → 60" || bad "{maximum 45} under minimum 60 → $(mx n2), want [true,60,60]"
post /settings '{"GlobalMaxPlaySeconds":0}' >/dev/null
[ "$(mx n3)" = '[true,60,0]' ] && ok "{maximum 0} → 0 (off stays allowed)" || bad "{maximum 0} → $(mx n3), want [true,60,0]"
post /settings '{"GlobalMaxPlaySeconds":90}' >/dev/null
[ "$(mx n4)" = '[true,60,90]' ] && ok "{maximum 90} over a 60 s minimum → 90" || bad "{maximum 90} → $(mx n4)"
post /settings '{"GlobalIntervalSeconds":120}' >/dev/null
[ "$(mx n5)" = '[true,120,120]' ] && ok "the minimum raised to 120 past the maximum 90 → the maximum follows to 120" || bad "{minimum 120} over maximum 90 → $(mx n5), want [true,120,120]"
post /settings '{"GlobalIntervalSeconds":30}' >/dev/null
[ "$(mx n6)" = '[true,30,120]' ] && ok "the minimum lowered to 30 → the maximum stays 120 (it follows up only)" || bad "{minimum 30} → $(mx n6), want [true,30,120]"
# advance-on-end off: the field is "Switch every" and there's no minimum, so a smaller hidden maximum is left alone…
post /settings '{"GlobalSwitchWhenVideoEnds":false,"GlobalIntervalSeconds":600,"GlobalMaxPlaySeconds":40}' >/dev/null
[ "$(mx n7)" = '[false,600,40]' ] && ok "advance-on-end off: \"Switch every\" 600 keeps the maximum 40" || bad "advance off → $(mx n7), want [false,600,40]"
# …until advance-on-end turns on and the 600 becomes the minimum
post /settings '{"GlobalSwitchWhenVideoEnds":true}' >/dev/null
[ "$(mx n8)" = '[true,600,600]' ] && ok "advance-on-end on with minimum 600 → the maximum 40 becomes 600" || bad "advance on → $(mx n8), want [true,600,600]"
post /settings "$rot0" >/dev/null; snap n9
same l8 n9 '[]' "the rotation put back"
# a playlist's own rotation: the playlist bar's state (POST /playlist/state merges) and a named playlist
pss() { curl -sf -m 5 "$U/playlist/state" | jq -c "[.settings.switchWhenVideoEnds, .settings.intervalSeconds, .settings.maxPlaySeconds, .settings.switchScenesAfterSeconds]"; }
ps0=$(curl -sf -m 5 "$U/playlist/state")
post /playlist/state '{"settings":{"switchWhenVideoEnds":true,"intervalSeconds":50,"maxPlaySeconds":20,"switchScenesAfterSeconds":0}}' >/dev/null
[ "$(pss)" = '[true,50,50,1]' ] && ok "the playlist bar: {minimum 50, maximum 20, scenes after 0} → stored [maximum 50, scenes after 1]" || bad "playlist bar → $(pss), want [true,50,50,1]"
post /playlist/state '{"settings":{"intervalSeconds":80}}' >/dev/null
[ "$(pss)" = '[true,80,80,1]' ] && ok "the playlist bar: its minimum raised to 80 → its maximum follows" || bad "playlist bar minimum 80 → $(pss), want [true,80,80,1]"
post /playlist/state '{"settings":{"maxPlaySeconds":0}}' >/dev/null
[ "$(pss)" = '[true,80,0,1]' ] && ok "the playlist bar: maximum 0 → off" || bad "playlist bar maximum 0 → $(pss), want [true,80,0,1]"
post /playlist/save '{"name":"merge-norm","playlist":{"videoPaths":[],"settings":{"switchWhenVideoEnds":true,"intervalSeconds":70,"maxPlaySeconds":10,"switchScenesAfterSeconds":-2}}}' >/dev/null
pn=$(post /playlist/load '{"name":"merge-norm"}' | jq -c "[.settings.maxPlaySeconds, .settings.switchScenesAfterSeconds]")
[ "$pn" = '[70,1]' ] && ok "a saved playlist {minimum 70, maximum 10, scenes after -2} → [maximum 70, scenes after 1]" || bad "saved playlist → $pn, want [70,1]"
post /playlist/state "$ps0" >/dev/null

echo "== parallel partial bodies all land"
# 8 rounds × 10 bodies released at once, each setting a different field: without one poster at a time, two
# that load the same file each save it with only their own field changed → the other's change is lost
PF='["librarySortIndex","demuxerMaxMib","globalSwitchScenesAfterSeconds","volume","globalTransitionDurationMaxMs",
     "autoMuteDelayMs","autoUnmuteDelayMs","demuxerMaxBackMib","globalTransitionDurationMs","videoFpsCap"]'
lost=$(python3 - "$U" "$PF" <<'PY'
import http.client, json, os, sys, threading
host, port = sys.argv[1].split("//")[1].split(":"); fields = json.loads(sys.argv[2]); lost = 0
# the API token (.claude/rules/backend/api.md § Security) — without it every request was a 401 ("80 of 80 lost")
TOKEN = open(os.environ["XDG_CONFIG_HOME"] + "/liascape/serve.token").read().strip()
def req(method, body=None):
    c = http.client.HTTPConnection(host, int(port), timeout=10)
    h = {"X-Liascape-Token": TOKEN}
    if body: h["Content-Type"] = "application/json"
    c.request(method, "/settings", body, h)
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
[ "$(available)" = true ] || { bad "liascape-player isn't available any more — stopping"; echo "RESULT pass=$pass fail=$fail"; exit 1; }
# the cover setting is a player prop — asserted on this fresh player (its own default is off), then live
pcov() { ctl get '{"path":"player.pause_when_covered"}' | jq -r .value; }
for _ in $(seq 1 30); do [ "$(pcov)" = maximized ] && break; sleep 0.1; done
[ "$(pcov)" = maximized ] && ok "a fresh player was given player.pause_when_covered = maximized (the setting's default)" || bad "player.pause_when_covered = $(pcov) on a fresh player, want maximized"
for v in fullscreen off maximized; do
  post /settings "{\"PauseWhenCovered\":\"$v\"}" >/dev/null
  for _ in $(seq 1 30); do [ "$(pcov)" = "$v" ] && break; sleep 0.1; done
  [ "$(pcov)" = "$v" ] && ok "{PauseWhenCovered:$v} → player.pause_when_covered $v live" || bad "{PauseWhenCovered:$v} → player.pause_when_covered $(pcov)"
done
[ "$(cur path)" = "$PLAYER" ] && [ "$(ctl get '{"path":"player.paused"}' | jq -r .value)" = false ] && ok "…the playing wallpaper untouched, not paused" || bad "the cover setting disturbed the play: cur $(cur path)"
# what a scene stopped by its video memory cap shows is a player prop too: given to a fresh player, then live both ways
pstop() { ctl get '{"path":"player.scene_vram_stop_shows"}' | jq -r .value; }
[ "$(pstop)" = last_frame ] && ok "a fresh player has player.scene_vram_stop_shows = last_frame (the setting's default)" || bad "player.scene_vram_stop_shows = $(pstop) on a fresh player, want last_frame"
for v in nothing last_frame; do
  post /settings "{\"SceneVramStopShows\":\"$v\"}" >/dev/null
  for _ in $(seq 1 30); do [ "$(pstop)" = "$v" ] && break; sleep 0.1; done
  [ "$(pstop)" = "$v" ] && ok "{SceneVramStopShows:$v} → player.scene_vram_stop_shows $v live" || bad "{SceneVramStopShows:$v} → player.scene_vram_stop_shows $(pstop)"
done
[ "$(cur path)" = "$PLAYER" ] && ok "…the playing wallpaper untouched" || bad "the stop-shows setting disturbed the play: cur $(cur path)"
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
tokens_kept && ok "a stale copy's Steam tokens don't overwrite the saved ones (nor land in settings.json)" \
  || bad "the full body overwrote the Steam tokens"
[ "$(disk '.SteamId == 76561190000000000')" = true ] \
  && ok "a stale copy's steamId doesn't overwrite the saved one (QR sign-in sets it)" || bad "the full body overwrote SteamId"
[ "$(jq -r --arg p "$PLAYER" '.LastSession.Paths[0] == $p' "$SJ")" = true ] \
  && ok "a stale copy's lastSession doesn't overwrite the saved one" || bad "the full body overwrote LastSession"
post /settings '{"lastSession":null,"steamRefreshToken":"","steamId":0}' >/dev/null
[ "$(jq -r --arg p "$PLAYER" '.LastSession.Paths[0] == $p and .SteamId == 76561190000000000' "$SJ")" = true ] && tokens_kept \
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

echo "== a maximum below the minimum reaches the running rotation as the minimum (live; globals, then a playlist's own)"
post /settings '{"GlobalSwitchWhenVideoEnds":true,"GlobalIntervalSeconds":20,"GlobalMaxPlaySeconds":0}' >/dev/null
post /playlist/play "{\"paths\":[\"$C1\",\"$C2\"],\"settings\":{\"Order\":0}}" >/dev/null
for _ in $(seq 1 40); do [ "$(cur path)" = "$C1" ] && break; sleep 0.1; done
n_nm=$(nsched)
waitms() { local i; for i in $(seq 1 40); do [ "$(prog "$1" | jq floor 2>/dev/null)" = "$2" ] && return 0; sleep 0.1; done; return 1; }   # the prop is a float
post /settings '{"GlobalMaxPlaySeconds":3}' >/dev/null
waitms max_ms 20000 && ok "{maximum 3} under a 20 s minimum → prog:main.max_ms 20000 live" || bad "{maximum 3} under minimum 20 → prog:main.max_ms $(prog max_ms), want 20000"
post /settings '{"GlobalIntervalSeconds":40}' >/dev/null
waitms max_ms 40000 && ok "the minimum raised to 40 → prog:main.max_ms follows to 40000 live" || bad "{minimum 40} → prog:main.max_ms $(prog max_ms), want 40000"
post /playlist/state "{\"videoPaths\":[\"$C1\",\"$C2\"],\"settings\":{\"order\":0,\"overrideGlobalSettings\":true,\"switchWhenVideoEnds\":true,\"intervalSeconds\":30,\"maxPlaySeconds\":2,\"separateSceneTiming\":true,\"switchScenesAfterSeconds\":1800}}" >/dev/null
waitms max_ms 30000 && ok "a playlist's own {minimum 30, maximum 2} → prog:main.max_ms 30000 live" || bad "playlist {minimum 30, maximum 2} → prog:main.max_ms $(prog max_ms), want 30000"
sleep 3.5   # a 2 or 3 s maximum that got through would have cut c1 (6 s) by now
[ "$(cur path)" = "$C1" ] && [ "$(nsched)" = "$n_nm" ] && ok "…c1 still plays: no maximum below the minimum cut it" || bad "a too-short maximum switched: cur $(cur path), switches $n_nm → $(nsched)"
post /playlist/state '{"settings":{"overrideGlobalSettings":false,"maxPlaySeconds":0,"intervalSeconds":600,"switchWhenVideoEnds":false}}' >/dev/null
post /settings '{"GlobalMaxPlaySeconds":0,"GlobalSwitchWhenVideoEnds":false,"GlobalIntervalSeconds":600}' >/dev/null
post /stop '{}' >/dev/null; sleep 0.6

echo "== a partial body sets \"Switch scenes after\" on a running advance-on-end rotation holding a still image (live)"
# separate timing on, 1800 s → the image (it never ends) stays; {GlobalSwitchScenesAfterSeconds:3} → it moves on
I1=$T/i1.png; timeout 60 ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=red:s=320x180" -frames:v 1 "$I1"
# an fps cap on (the parallel section left 98; 30 here explicitly): the player ignores it on a still image
# (it once stalled the image unready — docs/TODO.md "An fps cap stalls a still image", fixed)
post /settings '{"VideoFpsCap":30}' >/dev/null
post /settings '{"GlobalSwitchWhenVideoEnds":true,"GlobalIntervalSeconds":0,"GlobalMaxPlaySeconds":0,"GlobalSeparateSceneTiming":true,"GlobalSwitchScenesAfterSeconds":1800}' >/dev/null
post /playlist/play "{\"paths\":[\"$I1\",\"$C1\"],\"settings\":{\"Order\":0}}" >/dev/null
for _ in $(seq 1 40); do [ "$(cur path)" = "$I1" ] && break; sleep 0.1; done
sleep 2
[ "$(cur path)" = "$I1" ] && ok "scenes after 1800 s: the image still shows after 2 s" || bad "scenes after 1800 s × image: cur $(cur path) after 2 s (want the image)"
t_sc=$(date +%s%3N); post /settings '{"GlobalSwitchScenesAfterSeconds":3}' >/dev/null
for _ in $(seq 1 50); do [ "$(cur path)" = "$C1" ] && break; sleep 0.1; done
d_sc=$(( $(date +%s%3N) - t_sc ))
[ "$(cur path)" = "$C1" ] && [ "$d_sc" -lt 2500 ] && ok "{GlobalSwitchScenesAfterSeconds:3} → the image (2 s in) left for c1 $d_sc ms after (no replay, the play time kept)" \
  || bad "scenes after 3 s live × image: cur $(cur path) $d_sc ms after"
post /settings '{"GlobalSwitchScenesAfterSeconds":1800,"GlobalSwitchWhenVideoEnds":false,"GlobalIntervalSeconds":600}' >/dev/null
post /stop '{}' >/dev/null; sleep 0.6

echo "== the removed PlayerEngine key: ignored like any unknown key (no engine to switch, the player stays)"
snap e0; post /settings '{"PlayerEngine":"legacy"}' >/dev/null; sleep 1; snap e1
same e0 e1 '[]' "{PlayerEngine:legacy}"
[ "$(f 'has("playerEngine")' e1) $(disk 'has("PlayerEngine")')" = "false false" ] && ok "…GET /settings and settings.json have no PlayerEngine" \
  || bad "PlayerEngine after the post: GET $(f 'has("playerEngine")' e1), file $(disk 'has("PlayerEngine")')"
kill -0 "$SP" 2>/dev/null && [ "$(available)" = true ] && ok "liascape-player still runs, available" || bad "the player after {PlayerEngine:legacy}: supervisor alive $(kill -0 "$SP" 2>/dev/null && echo yes || echo no), available $(available)"
grep -q "test-refresh-token" "$T/backend.log" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null && bad "settings dumped to a log" || ok "no settings dump in the logs"
echo "== no real network"
rn=$(lp_real_network "$T")
[ -z "$rn" ] && ok "no call to a real server (none refused, no Steam session)" \
  || { bad "real network: $(awk '{n += $1} END {print n}' <<<"$rn") call(s) to real servers:"; echo "$rn"; }
echo "RESULT pass=$pass fail=$fail"
[ $fail = 0 ]
