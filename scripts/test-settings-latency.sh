#!/usr/bin/env bash
# Hermetic latency check of the Settings page's hot paths under PlayerEngine=liascape-player, with a library the
# size of a real one (300 items, every one loudness-measured, NormalizeAudio on): a no-op POST /settings
# (what every debounced slider save costs) and /preview {global:true} (the slider's live drag preview).
# Speed storm leftover: a no-op /settings cost ~150 ms on the owner's machine (330–550 ms here) — the
# loudness backfill scanned the whole library on the request thread, parsing index.json twice per item.
#
# Hermetic like scripts/test-liascape-player-adapter.sh: temp HOME + every XDG dir (own settings.json, library,
# player socket), a private `liascape-player serve --headless --clock real --ao null`, its own backend port;
# never touches another backend, the real library or the real player. Everything is stopped on exit.
#
# Usage: scripts/test-settings-latency.sh [--no-build]   (env N = library size, default 300)
# Needs: dotnet (or DOTNET=…), ffmpeg, jq, curl, python3. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
for t in ffmpeg jq curl python3; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
B=$ROOT/src/player/target/debug/liascape-player
DLL=$ROOT/src/livepaper/bin/Debug/net10.0/livepaper.dll
if [ $BUILD = 1 ]; then
  (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  "$DOTNET" build "$ROOT/src/livepaper" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -x "$B" ] && [ -f "$DLL" ] || { echo "not built: $B / $DLL (drop --no-build)"; exit 2; }
N=${N:-300}
T=$(mktemp -d /tmp/liascape-lat-XXXXXX)   # short: a unix socket path must be < 108 bytes
LIB=$T/home/.local/share/livepaper/library/imported
mkdir -p "$T/home/.config/livepaper" "$T/home/.cache" "$LIB" "$T/rt" "$T/st"
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LIASCAPE_PLAYER_BIN=$B LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 LIASCAPE_PROFILE_SETTINGS=1
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT
SP=""; BP=""
cleanup() {
  trap - EXIT INT TERM HUP
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1   # clean child exit → the supervisor exits too
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  case "$T" in /tmp/liascape-lat-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
pass=0; fail=0
ok()  { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
ctl() { "$B" ctl --timeout-ms 3000 "$@"; }
dB() { python3 -c "import math; print(60*math.log10($1/100))"; }
near() { python3 -c "import sys; sys.exit(0 if abs(float('$1')-float('$2'))<${3:-0.01} else 1)" 2>/dev/null; }
median() { tr ' ' '\n' | grep -v '^$' | sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}'; }

# one short clip, N library items linking to it, an index.json like a real one (~450 B per item, measured)
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$T/clip.mp4"
python3 - "$LIB" "$T/clip.mp4" "$N" <<'EOF'
import json, os, sys
lib, clip, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
idx = {}
for i in range(n):
    k = f"item{i:03d}"
    os.makedirs(f"{lib}/{k}", exist_ok=True)
    os.symlink(clip, f"{lib}/{k}/{k}.mp4")
    idx[k] = {"title": f"Item {i} with a reasonably long descriptive title", "sourceUrl": f"file:///some/where/{k}.mp4",
              "loudnessI": -20.5, "loudnessTP": -3.1, "loudnessLRA": 5.2, "loudnessThresh": -31.0,
              "tags": ["Anime", "Landscape", "Relaxing"], "description": "x" * 120}
json.dump(idx, open(f"{lib}/index.json", "w"), indent=2)
EOF
echo "library: $N items, index.json $(stat -c %s "$LIB/index.json") bytes"
cat > "$XDG_CONFIG_HOME/livepaper/settings.json" <<EOF
{"PlayerEngine":"liascape-player","NoAudio":false,"Loop":true,"Volume":100,"Speed":1,"NormalizeAudio":true,"AutoMute":false,
 "GlobalTransitionEnabled":false,"RestartIntervalSeconds":600}
EOF
(cd /tmp && exec "$B" serve --headless --outputs 640x360@60 --clock real --ao null > "$T/serve.log" 2>&1) & SP=$!
for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
"$DOTNET" "$DLL" --serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] || { echo "ABORT: backend didn't start"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
[ "$(curl -sf -m 5 "$U/player-engine" | jq -r .active)" = liascape-player ] || { echo "ABORT: backend not on liascape-player — refusing to touch any legacy player"; exit 1; }
post_ms() { curl -s -m 10 -o /dev/null -w '%{time_total}' -X POST -H 'Content-Type: application/json' -d "$2" "$U$1" | python3 -c "import sys; print(int(float(sys.stdin.read())*1000))"; }
I0=$LIB/item000/item000.mp4
curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "{\"path\":\"$I0\"}" "$U/apply" >/dev/null; sleep 2
[ "$(ctl get '{"path":"cur:*.path"}' | jq -r .value)" = "$I0" ] && ok "item000 playing" || bad "nothing playing"
sleep 2   # the startup loudness backfill (every item is measured → a scan only) is long done

echo "== a no-op POST /settings (every debounced slider save)"
BODY=$(curl -sf -m 5 "$U/settings")   # never printed (it would hold a Steam token in a real config)
post_ms /settings "$BODY" >/dev/null    # warm (JIT)
ms=""; for _ in $(seq 1 15); do ms="$ms $(post_ms /settings "$BODY")"; done
med=$(echo "$ms" | median); echo "     ms:$ms"
grep '/settings:' "$T/backend.log" | tail -3 | sed 's/^/     /'
[ "$med" -lt 40 ] && ok "no-op /settings median ${med} ms (< 40)" || bad "no-op /settings median ${med} ms (want < 40)"

echo "== /preview {global:true} (the Settings sliders' live drag)"
ms=""; for i in $(seq 1 15); do ms="$ms $(post_ms /preview "{\"volume\":$((40+i)),\"global\":true}")"; done
med=$(echo "$ms" | median); echo "     ms:$ms"; sleep 0.3
[ "$med" -lt 20 ] && ok "/preview global median ${med} ms (< 20)" || bad "/preview global median ${med} ms (want < 20)"
near "$(ctl get '{"path":"cur:*.gain.user"}' | jq -r .value)" "$(dB 55)" && ok "the last drag value landed ($(dB 55) dB)" || bad "cur gain.user $(ctl get '{"path":"cur:*.gain.user"}' | jq -r .value), want $(dB 55)"
[ "$(curl -sf -m 5 "$U/settings" | jq .volume)" = 100 ] && ok "no persist (volume still 100)" || bad "a preview persisted volume $(curl -sf -m 5 "$U/settings" | jq .volume)"
echo "RESULT pass=$pass fail=$fail"
[ $fail = 0 ]
