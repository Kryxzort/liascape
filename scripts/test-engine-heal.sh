#!/usr/bin/env bash
# Hermetic test: PlayerEngine=liascape-player while its binary is MISSING (serve started mid-rebuild, a boot before the
# store path existed) runs legacy; once the binary appears, the next GET /player-engine switches to liascape-player by
# itself (PlayerEngine.HealIfFound), no "select it again". Checks: legacy + the not-found reason at first; the binary
# appears → active liascape-player within 10 s, the reason says it's switching or is gone; settings untouched. And two
# quick engine changes (legacy, then back within a second) end on liascape-player: the switches take turns.
#
# Hermetic like scripts/test-settings-merge.sh: temp HOME + every XDG dir, a private headless liascape-player, its own
# backend port; LIASCAPE_PLAYER_BIN points at a path that only gets the binary mid-test. Nothing ever plays (no wallpaper
# is applied, no Wayland display), so no legacy player can start. Never prints settings.json or a token.
#
# Usage: scripts/test-engine-heal.sh [--no-build]
# Needs: dotnet (or DOTNET=…), jq, curl. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/test-lock.sh" # one heavy test run at a time on this machine
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
for t in jq curl timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
B=$ROOT/src/player/target/debug/liascape-player
DLL=${LIASCAPE_EH_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll} # another build: a RED run on an older one
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

T=$(mktemp -d /tmp/liascape-eh-XXXXXX)
mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
DLL=$T/backend/liascape-backend.dll
mkdir -p "$T/home/.config/liascape" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st" "$T/bin"
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export LIASCAPE_SECRETS=file XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player   # absent until the "rebuild" below
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT
curl() { command curl -H "X-Liascape-Token: $(cat "$XDG_CONFIG_HOME/liascape/serve.token" 2>/dev/null)" "$@"; }
SP=""; BP=""
cleanup() {
  trap - EXIT INT TERM HUP
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  case "$T" in /tmp/liascape-eh-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
pass=0; fail=0
ok()  { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }

echo '{"PlayerEngine":"liascape-player","Theme":"Nord"}' > "$XDG_CONFIG_HOME/liascape/settings.json"
gone() { [ -e "$1" ] || [ -L "$1" ] && trash "$1"; return 0; }   # trash-cli also takes a dangling symlink
up() {   # a private player + backend on this HOME
  (cd /tmp && exec "$B" serve --headless --outputs 640x360@60 --clock real --ao null >> "$T/serve.log" 2>&1) & SP=$!
  for _ in $(seq 1 50); do "$B" ctl --timeout-ms 500 hello >/dev/null 2>&1 && break; sleep 0.1; done
  gone "$XDG_CONFIG_HOME/liascape/serve.port"
  "$DOTNET" "$DLL" serve >> "$T/backend.log" 2>&1 & BP=$!
  for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "ABORT: backend didn't start"; tail -5 "$T/backend.log"; exit 1; }
  U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
  for _ in $(seq 1 50); do command curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
}
down() {
  kill "$BP" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; BP=""
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1
  for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; SP=""
}
pe() { curl -sf -m 5 "$U/player-engine"; }
post_s() { curl -sf -m 30 -X POST -H 'Content-Type: application/json' -d "$1" "$U/settings" >/dev/null; }

echo "== A. on liascape-player: legacy, then back at once → liascape-player runs (the switches take turns, the newest wins)"
ln -s "$B" "$LIASCAPE_PLAYER_BIN"; up
[ "$(pe | jq -r .active)" = liascape-player ] || { echo "ABORT: not on liascape-player at the start"; exit 1; }
for k in 1 2 3; do
  post_s '{"PlayerEngine":"legacy"}' & P1=$!
  sleep 0.03
  post_s '{"PlayerEngine":"liascape-player"}'
  wait $P1; sleep 3
  # ONE status read per round: it would start the heal itself, which must not be what makes this pass
  a=$(pe | jq -r .active)
  [ "$a" = liascape-player ] && ok "round $k: active liascape-player after legacy → liascape-player" \
    || bad "round $k: active $a after legacy → liascape-player (the setting says liascape-player)"
  [ "$a" = liascape-player ] || { for _ in $(seq 1 60); do [ "$(pe | jq -r .active)" = liascape-player ] && break; sleep 0.2; done; }
done
down

echo "== B. the binary is missing: legacy, and the row says why"
gone "$LIASCAPE_PLAYER_BIN"; up
s=$(pe)
[ "$(jq -r .engine <<<"$s")/$(jq -r .active <<<"$s")" = "liascape-player/legacy" ] \
  && ok "wants liascape-player, runs legacy" || bad "engine/active: $(jq -c '[.engine, .active]' <<<"$s")"
[ "$(jq -r .available <<<"$s")" = false ] && ok "available: false" || bad "available: $(jq -r .available <<<"$s")"

echo "== B. the binary appears (a rebuild finished): the next status switches by itself"
ln -s "$B" "$LIASCAPE_PLAYER_BIN"
t0=$(date +%s%3N); act=""
for _ in $(seq 1 100); do act=$(pe | jq -r .active); [ "$act" = liascape-player ] && break; sleep 0.1; done
ms=$(( $(date +%s%3N) - t0 ))
[ "$act" = liascape-player ] && ok "active liascape-player ${ms} ms after the binary appeared (no reselect)" \
  || bad "still $act 10 s after the binary appeared"
r=$(pe | jq -r '.reason // ""')
case "$r" in *"select it again"*) bad "the reason still says to select it again" ;; *) ok "no \"select it again\" reason" ;; esac
[ "$(jq -r .PlayerEngine "$XDG_CONFIG_HOME/liascape/settings.json")" = liascape-player ] && [ "$(jq -r .Theme "$XDG_CONFIG_HOME/liascape/settings.json")" = Nord ] \
  && ok "settings.json untouched (PlayerEngine, Theme)" || bad "settings.json changed"
grep -q "it is available, legacy runs → switching" "$T/backend.log" "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null \
  && ok "the switch is logged" || bad "no switch line in the logs"

echo "RESULT pass=$pass fail=$fail"
[ $fail = 0 ]
