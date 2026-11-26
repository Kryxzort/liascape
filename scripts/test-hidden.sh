#!/usr/bin/env bash
# Hermetic test of the hidden cards' file (src/backend/Helpers/HiddenItems.cs, ServerHost /hidden, AppOps.Hide / Undo):
#  empty:    a fresh install reads {library: {}, browse: {}} and has no file
#  hide:     POST /hidden {scope, hide} keeps each key with its title (Browse's with its source and card), in
#            $XDG_DATA_HOME/liascape/hidden.json, written atomically (no temp file left), and broadcasts nothing it can't read back
#  field:    a change touches only the keys it names in its own scope: the other scope and the other keys stay as saved;
#            unhide removes just its keys; a key hidden again keeps when it was first hidden
#  undo:     a Hide goes on the Undo stack (undo-depth + 1); POST /library/undo answers kind "hide" and the keys it hid are
#            shown again, nothing else; hiding only keys already hidden adds no Undo step; an Undo whose write fails
#            keeps its step for the next Undo
#  refuse:   an unknown scope, an empty key, a card that isn't an object → 400 and the file unchanged
#  parallel: 24 concurrent POSTs, each hiding its own key, all land (in-process lock)
#  procs:    16 `hidden-edit` processes (another liascape process than the backend) and 16 POSTs at once, all land (FileLock)
#  restart:  the backend stopped and started again reads every key back
#  torn:     a file that doesn't parse is never written over: a POST fails, the bytes stay; GET reads nothing hidden
#  files:    nothing under the library changes (Hide only hides)
# Runs in its own network namespace (`unshare -rn`), a temp HOME + XDG dirs and a private backend whose player is an
# `exit 1` stub (nothing plays). Never touches ~/.local/share/liascape or ~/.config/liascape; everything it started is
# stopped on exit.
#
# Usage: scripts/test-hidden.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), curl, jq, sha256sum.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_HIDDEN_T:-}" ]; then
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
  T=$(mktemp -d /tmp/liascape-hidden-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-hidden- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_HIDDEN_T=$T
  timeout -k 10 300 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_HIDDEN_T
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
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

D=$XDG_DATA_HOME/liascape; F=$D/hidden.json
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"AutoAddWeWallpapersToLibrary":false,"NoAudio":true}
EOF
# a library item's file: Hide must leave every byte under the library alone
mkdir -p "$D/library/imported/v"; head -c 4096 /dev/urandom > "$D/library/imported/v/v.mp4"
libsum() { sha256sum < "$D/library/imported/v/v.mp4"; }
LIB0=$(libsum)

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
get() { curl -s -m 10 -H "X-Liascape-Token: $TOKEN" "$U$1"; }
post() { curl -s -m 10 -o "$T/body" -w '%{http_code}\n' -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' -X POST --data "$2" "$U$1"; }
keys() { get /hidden | jq -c "[.$1 // {} | keys[]] | sort" 2>/dev/null; }
depth() { get /library/undo-depth | jq -r '.depth'; }
tmpfiles() { find "$D" -maxdepth 1 -name '.hidden.json.*' | wc -l; }

startbe

echo "== empty"
check "a fresh install reads nothing hidden" "$(get /hidden | jq -c '[(.library | length), (.browse | length)]' 2>/dev/null)" "[0,0]"
check "no file before the first Hide" "$([ -e "$F" ] && echo yes || echo no)" "no"

echo "== hide"
d0=$(depth)
code=$(post /hidden '{"scope":"library","hide":[{"key":"/lib/a.mp4","title":"A"},{"key":"/lib/b.mp4","title":"B"}]}')
check "POST hide (library) → 200" "$code" "200"
check "the answer holds both keys" "$(jq -c '[.library | keys[]] | sort' "$T/body" 2>/dev/null)" '["/lib/a.mp4","/lib/b.mp4"]'
check "the file holds them, with their titles" "$(jq -c '[.library["/lib/a.mp4"].title, .library["/lib/b.mp4"].title]' "$F" 2>/dev/null)" '["A","B"]'
check "one Undo step for the Hide" "$(depth)" "$((d0 + 1))"
CARD='{"title":"W","pageUrl":"https://steamcommunity.com/sharedfiles/filedetails/?id=900000001","workshopId":"900000001","thumbnailUrl":"https://x.invalid/t.jpg"}'
code=$(post /hidden "{\"scope\":\"browse\",\"hide\":[{\"key\":\"https://steamcommunity.com/sharedfiles/filedetails/?id=900000001\",\"title\":\"W\",\"source\":\"Steam Workshop\",\"card\":$CARD}]}")
check "POST hide (browse) → 200" "$code" "200"
check "Browse's entry keeps its source and card" "$(jq -c '.browse[] | [.source, .card.workshopId]' "$F" 2>/dev/null)" '["Steam Workshop","900000001"]'
check "no temp file left beside it" "$(tmpfiles)" "0"

echo "== field"
check "the Library's keys untouched by Browse's Hide" "$(keys library)" '["/lib/a.mp4","/lib/b.mp4"]'
at0=$(jq -r '.library["/lib/b.mp4"].hiddenAt' "$F")
sleep 1.1
post /hidden '{"scope":"library","hide":[{"key":"/lib/b.mp4","title":"B again"}],"unhide":["/lib/a.mp4"]}' >/dev/null
check "unhide removes just its key" "$(keys library)" '["/lib/b.mp4"]'
check "a key hidden again keeps its first time" "$(jq -r '.library["/lib/b.mp4"].hiddenAt' "$F")" "$at0"
check "Browse's keys untouched by the Library's change" "$(keys browse)" '["https://steamcommunity.com/sharedfiles/filedetails/?id=900000001"]'

echo "== undo"
d1=$(depth)
post /hidden '{"scope":"library","hide":[{"key":"/lib/c.mp4","title":"C"},{"key":"/lib/b.mp4","title":"B"}]}' >/dev/null
check "a Hide of one new key (and one hidden already): one Undo step" "$(depth)" "$((d1 + 1))"
post /hidden '{"scope":"library","hide":[{"key":"/lib/c.mp4","title":"C"}]}' >/dev/null
check "a Hide of keys hidden already adds no Undo step" "$(depth)" "$((d1 + 1))"
code=$(post /library/undo '')
check "Undo → 200" "$code" "200"
check "Undo answers kind hide, count 1, its title" "$(jq -c '[.ok, .kind, .count, .title]' "$T/body" 2>/dev/null)" '[true,"hide",1,"C"]'
check "Undo shows only that Hide's key again" "$(keys library)" '["/lib/b.mp4"]'
check "Browse's keys untouched by the Undo" "$(keys browse | jq length)" "1"
# an Undo whose write fails (the file unreadable for a moment) keeps its step: once the file is back, Undo does it
post /hidden '{"scope":"library","hide":[{"key":"/lib/d.mp4","title":"D"}]}' >/dev/null
d2=$(depth); cp "$F" "$T/hidden.keep"; printf '{"library": {' > "$F"
code=$(post /library/undo '')
[ "$code" != "200" ] && ok "an Undo over an unreadable file fails ($code)" || bad "an Undo over an unreadable file → 200"
check "the failed Undo keeps its step" "$(depth)" "$d2"
cp "$T/hidden.keep" "$F"
code=$(post /library/undo '')
check "the kept step undoes once the file is back" "$(jq -c '[.ok, .kind, .title]' "$T/body" 2>/dev/null)" '[true,"hide","D"]'
check "…showing D again, the rest as it was" "$(keys library)" '["/lib/b.mp4"]'

echo "== refuse"
S0=$(sha256sum < "$F")
check "an unknown scope → 400" "$(post /hidden '{"scope":"nope","hide":[{"key":"k"}]}')" "400"
check "an empty key → 400" "$(post /hidden '{"scope":"library","hide":[{"key":""}]}')" "400"
check "an empty unhide key → 400" "$(post /hidden '{"scope":"browse","unhide":[" "]}')" "400"
check "a card that isn't an object → 400" "$(post /hidden '{"scope":"browse","hide":[{"key":"k","card":[1,2]}]}')" "400"
check "no token → 401" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST --data '{"scope":"library","hide":[{"key":"z"}]}' "$U/hidden")" "401"
check "the refusals changed nothing" "$(sha256sum < "$F")" "$S0"

echo "== parallel"
pids=()
for i in $(seq 1 24); do post /hidden "{\"scope\":\"library\",\"hide\":[{\"key\":\"/par/$i\",\"title\":\"P$i\"}]}" > "$T/par.$i" & pids+=($!); done
for p in "${pids[@]}"; do wait "$p"; done
check "24 concurrent POSTs all → 200" "$(cat "$T"/par.* | sort -u | tr '\n' ' ')" "200 "
check "24 concurrent Hides all landed" "$(get /hidden | jq '[.library | keys[] | select(startswith("/par/"))] | length')" "24"
check "the file parses after them" "$(jq -r '.library | length' "$F" 2>/dev/null)" "25"

echo "== procs"
pids=()
for i in $(seq 1 16); do
  "$DOTNET" "$DLL" hidden-edit browse hide "proc-$i" >> "$T/procs.log" 2>&1 & pids+=($!)
  post /hidden "{\"scope\":\"browse\",\"hide\":[{\"key\":\"api-$i\",\"title\":\"A$i\"}]}" > "$T/api.$i" & pids+=($!)
done
codes=0; for p in "${pids[@]}"; do wait "$p" || codes=$((codes + 1)); done
check "every writer exited 0" "$codes" "0"
n=$(jq '[.browse | keys[] | select(startswith("proc-") or startswith("api-"))] | length' "$F" 2>/dev/null)
check "16 process writes + 16 API writes at once: all 32 landed" "$n" "32"
post /hidden '{"scope":"browse","unhide":["proc-1","api-1"]}' >/dev/null
"$DOTNET" "$DLL" hidden-edit library unhide /par/1 >> "$T/procs.log" 2>&1
check "unhide from either side: only those keys go" "$(jq -c '[(.browse | has("proc-1")), (.browse | has("api-1")), (.browse | has("proc-2")), (.library | has("/par/1")), (.library | has("/par/2"))]' "$F")" '[false,false,true,false,true]'
check "no temp file left after the concurrent writes" "$(tmpfiles)" "0"

echo "== restart"
before=$(get /hidden | jq -cS '[(.library | keys), (.browse | keys)]')
stopbe; startbe
check "a restarted backend reads every key back" "$(get /hidden | jq -cS '[(.library | keys), (.browse | keys)]')" "$before"
check "Browse's card survives the restart" "$(get /hidden | jq -r '.browse["https://steamcommunity.com/sharedfiles/filedetails/?id=900000001"].card.workshopId')" "900000001"

echo "== torn"
printf '{"library": {"/lib/x": {"title": "X"' > "$F"; S1=$(sha256sum < "$F")
code=$(post /hidden '{"scope":"library","hide":[{"key":"/lib/y","title":"Y"}]}')
[ "$code" != "200" ] && ok "a Hide over a file that doesn't parse fails ($code)" || bad "a Hide over a file that doesn't parse → 200"
check "the unparsable file is never written over" "$(sha256sum < "$F")" "$S1"
check "GET reads nothing hidden from it" "$(get /hidden | jq -c '[(.library | length), (.browse | length)]')" "[0,0]"

echo "== files"
check "nothing under the library changed" "$(libsum)" "$LIB0"

stopbe
echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
