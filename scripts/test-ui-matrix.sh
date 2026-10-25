#!/usr/bin/env bash
# UI × player-state matrix (PlayerEngine=lp-player): every playback-relevant UI control (and every
# `--action=` keybind) exercised in every player state — idle, playing, playlist, an effect running,
# an align:end switch pending, paused, paused mid-effect, no output, muted — through the REAL UI
# (headless Electron clicking the built bundle), checking after each step what every live source of
# the player actually runs. Driver + oracle: app/shell/probe-matrix.js.
#
# Hermetic like scripts/test-lp-player-adapter.sh: its own temp HOME / XDG_* dirs (own settings.json,
# library, lp-player socket + event log), its own backend port, a private `lp-player serve --headless
# --clock real --ao null`, the UI built into the temp dir and served by that backend (LP_UI_DIR). It
# never touches the dev backend, the real library or the real player; everything it started is stopped
# and the temp dir removed on every exit path.
#
# Usage: scripts/test-ui-matrix.sh [--no-build] [--only <regex over cell names>] [--ui-dir <built UI>]
#   --ui-dir: drive an already-built UI bundle instead of building this tree's (e.g. an older commit's,
#   to show a UI-side fix RED)
# Needs: dotnet (DOTNET=…), ffmpeg, jq, curl, node, an Electron (ELECTRON=…, default: the nix store's
# electron-42). Exit 0 = every cell passed. Results: $LP_MATRIX_OUT (default: a dir printed at the end).
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD=1; ONLY=""; UIDIR=""
while [ $# -gt 0 ]; do
  case "$1" in --no-build) BUILD=0 ;; --only) ONLY=$2; shift ;; --ui-dir) UIDIR=$(cd "$2" && pwd); shift ;; *) echo "unknown arg $1"; exit 2 ;; esac; shift
done
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
ELECTRON=${ELECTRON:-$(ls -d /nix/store/*-electron-42*/bin/electron 2>/dev/null | head -1)}
[ -x "$ELECTRON" ] || { echo "no electron — set ELECTRON=/path/to/electron"; exit 2; }
for t in ffmpeg jq curl node; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
# Electron renders on a private Xvfb (its headless ozone platform crashes on this build; no display of
# the session is ever used)
XVFB=${XVFB:-$(ls /nix/store/*-xorg-server-*/bin/Xvfb 2>/dev/null | head -1)}
[ -x "$XVFB" ] || XVFB=$(command -v Xvfb || true)
[ -x "$XVFB" ] || { echo "no Xvfb — set XVFB=/path/to/Xvfb"; exit 2; }
B=$ROOT/src/player/target/debug/lp-player
DLL=$ROOT/src/livepaper/bin/Debug/net10.0/livepaper.dll

if [ $BUILD = 1 ]; then
  echo "== build"
  (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  "$DOTNET" build "$ROOT/src/livepaper" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -x "$B" ] && [ -f "$DLL" ] || { echo "not built: $B / $DLL (drop --no-build)"; exit 2; }

T=$(mktemp -d /tmp/lpmx-XXXXXX)   # short: a unix socket path must be < 108 bytes
OUT=${LP_MATRIX_OUT:-$T/out}
mkdir -p "$T/home/.config/livepaper" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st" "$OUT"
if [ -n "$UIDIR" ]; then
  [ -f "$UIDIR/index.html" ] || { echo "no index.html in $UIDIR"; exit 2; }
  cp -r "$UIDIR" "$T/ui"
else
  echo "== UI bundle"
  (cd "$ROOT/app/ui" && node node_modules/vite/bin/vite.js build --outDir "$T/ui" --emptyOutDir --logLevel error) || { echo "vite build failed"; exit 2; }
fi
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LP_PLAYER_BIN=$B LP_TRANSITIONS_DIR=$ROOT/transitions LP_UI_DIR=$T/ui
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 LP_TEST_ALIGN_BACKSTOP_SLACK_SEC=2
unset LP_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LP_PORT
SP=""; BP=""; XP=""
cleanup() {
  trap - EXIT INT TERM HUP
  [ -n "$XP" ] && kill "$XP" 2>/dev/null
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  if [ -z "${LP_MATRIX_OUT:-}" ] && [ -d "$OUT" ]; then
    [ -e /tmp/lpmx-last ] && trash /tmp/lpmx-last 2>/dev/null
    cp -r "$OUT" /tmp/lpmx-last && echo "results kept in /tmp/lpmx-last"
  fi
  case "$T" in /tmp/lpmx-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

clip() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "$2=size=320x180:rate=30" -f lavfi -i "sine=frequency=$3:sample_rate=48000" \
           -t "$4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$1"; }
clip "$T/k1.mp4" testsrc2 330 30; clip "$T/k2.mp4" smptebars 440 30; clip "$T/k3.mp4" rgbtestsrc 550 30; clip "$T/k4.mp4" testsrc 660 10

cat > "$XDG_CONFIG_HOME/livepaper/settings.json" <<EOF
{"PlayerEngine":"lp-player","NoAudio":false,"Loop":true,"Volume":80,"Speed":1,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["fade"],"GlobalTransitionDurationMs":2500,"GlobalTransitionShuffle":false,
 "TransitionMethod":"full-live","GlobalAdvanceOnVideoEnd":false,"GlobalWaitForVideoEnd":false,
 "GlobalIntervalSeconds":600,"AutoMute":false,"AdvancedSettings":true,"RestartIntervalSeconds":0}
EOF

(cd /tmp && exec "$B" serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null > "$T/serve.log" 2>&1) & SP=$!
for _ in $(seq 1 50); do "$B" ctl --timeout-ms 500 hello >/dev/null 2>&1 && break; sleep 0.1; done
"$DOTNET" "$DLL" --serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] || { echo "ABORT: backend didn't start"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
[ "$(curl -sf -m 5 "$U/player-engine" | jq -r .active)" = lp-player ] || { echo "ABORT: backend not on lp-player"; exit 1; }
post() { curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
CLIPS=$(for k in k1 k2 k3 k4; do post /library/import "{\"path\":\"$T/$k.mp4\",\"title\":\"$k\"}" | jq -c .videoPath; done | jq -sc .)
echo "library: $CLIPS"

"$XVFB" -displayfd 3 -nolisten tcp -screen 0 1400x900x24 3>"$T/xdisplay" >"$T/xvfb.log" 2>&1 & XP=$!
for _ in $(seq 1 50); do [ -s "$T/xdisplay" ] && break; sleep 0.1; done
[ -s "$T/xdisplay" ] || { echo "ABORT: Xvfb didn't start"; tail -3 "$T/xvfb.log"; exit 1; }
echo "== matrix"
(cd "$ROOT/app/shell" && env -u LD_LIBRARY_PATH DISPLAY=":$(cat "$T/xdisplay")" LP_URL="$U" LP_PLAYER_SOCKET="$XDG_RUNTIME_DIR/livepaper/lp-player.sock" \
  LP_CLIPS="$CLIPS" LP_OUT="$OUT" LP_DOTNET="$DOTNET" LP_DLL="$DLL" LP_ONLY="$ONLY" \
  LP_ADAPTER_LOG="$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" LP_BACKEND_LOG="$T/backend.log" \
  LP_USER_MUTE="$XDG_CONFIG_HOME/livepaper/user_mute.state" \
  "$ELECTRON" --ozone-platform=x11 --disable-gpu probe-matrix.js 2>"$OUT/electron.stderr")
rc=$?
echo "== adapter log (tail)"; tail -n 6 "$XDG_CACHE_HOME/livepaper/lp-player-adapter.log" 2>/dev/null | sed 's/^/     /'
exit $rc
