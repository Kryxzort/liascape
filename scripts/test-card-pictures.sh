#!/usr/bin/env bash
# Hermetic timing test of Browse's card pictures: a Workshop card's still (/still, a frame made from its gif preview) and
# its gif (/anim, the preview trimmed of a fade from black), both made from a gif on Steam's image CDN. A temp HOME + XDG
# dirs, no network (`unshare -rnm`: loopback only, its own mounts), a private backend, a fake CDN on loopback
# (scripts/test-fixtures/fake-image-cdn.mjs: ~1.1 MB gifs, 224×224, 56 frames, as Workshop previews are; one shared 8 MB/s
# link, 150 ms to the first byte) named cdn.test, and a slow DNS server for that name (scripts/test-fixtures/fake-dns.mjs,
# 500 ms an answer; the namespace's /etc/resolv.conf names only it). The page is
# scripts/test-fixtures/drive-card-pictures.mjs: 6 connections, each card's still first and its gif once that is in.
#  1. a page of 24 cards, cold: every still and gif arrives, each gif crosses the link ONCE (a card's still and gif share
#     one download), cdn.test is looked up once ("lookups"), and the page is done within 1.25× the time its 24 gifs take on
#     the link + 1.5 s.
#  2. the same page again: nothing fetched, nothing looked up, done within 1.5 s.
#  3. a page left while it loads (every request aborted at 600 ms, as a list switch drops its cards): the downloads nobody
#     waits for stop mid-way (none runs to the end after), and the next page is done within the same bound.
# Never touches ~/.config/liascape, ~/.cache or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-card-pictures.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   CARD_PICTURES_OLD=1: the page asks as Card.tsx did before (every gif at once, then the stills): numbers only.
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), node, unshare + ip (iproute2), ffmpeg, curl, jq. Last line `RESULT pass=N fail=M`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_CARDPIX_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in node unshare ip ffmpeg curl jq timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-cardpix-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-cardpix- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_CARDPIX_T=$T
  # the namespace's resolver: only the fake DNS server, asked by glibc itself (nscd's socket hidden: nscd would ask the
  # host's resolver, outside the namespace)
  printf 'nameserver 127.0.0.1\noptions timeout:5 attempts:2\n' > "$T/resolv.conf"; mkdir -p "$T/no-nscd"
  timeout -k 10 300 unshare -rnm bash -c 'ip link set lo up && mount --bind "$1" /etc/resolv.conf &&
    { [ ! -d /run/nscd ] || mount --bind "$2" /run/nscd; } && exec bash "$0"' "${BASH_SOURCE[0]}" "$T/resolv.conf" "$T/no-nscd"
  exit $?
fi

T=$LIASCAPE_CARDPIX_T
DLL=$T/backend/liascape-backend.dll
BP="" FP="" DP=""
stopbe() { [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }; BP=""; }
trap 'stopbe; [ -n "$FP" ] && kill $FP 2>/dev/null; [ -n "$DP" ] && kill $DP 2>/dev/null; pkill -P $$ 2>/dev/null' EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
# the fake CDN listens on loopback: the media fetches may reach it (ApiSecurity.MediaLoopbackForTests)
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player LIASCAPE_TEST_MEDIA_LOOPBACK=1
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }

# a Workshop preview's size: ~1.1 MB, 224×224, 56 frames; "lead" opens on 0.3 s of black (its gif is trimmed and
# re-encoded), "plain" doesn't (served as it came)
mkdir -p "$T/cdn"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=black:size=224x224:rate=20:d=0.3" \
    -f lavfi -i "testsrc2=size=224x224:rate=20:d=2.5,noise=alls=25:allf=t+u" -filter_complex "[0][1]concat=n=2:v=1" "$T/cdn/lead.gif" \
  && ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=224x224:rate=20:d=2.8,noise=alls=25:allf=t+u" "$T/cdn/plain.gif" \
  || { echo "ABORT: ffmpeg can't make the fixtures"; exit 2; }
BPS=8000000
node "$ROOT/scripts/test-fixtures/fake-image-cdn.mjs" "$T/cdn.port" "$T/cdn" $BPS 150 > "$T/cdn.log" 2>&1 & FP=$!
for _ in $(seq 1 50); do [ -s "$T/cdn.port" ] && break; sleep 0.1; done
[ -s "$T/cdn.port" ] || { echo "ABORT: the fake CDN didn't start"; cat "$T/cdn.log"; exit 2; }
node "$ROOT/scripts/test-fixtures/fake-dns.mjs" 500 > "$T/dns.log" 2>&1 & DP=$!
for _ in $(seq 1 50); do grep -q ready "$T/dns.log" 2>/dev/null && break; sleep 0.1; done
grep -q ready "$T/dns.log" || { echo "ABORT: the fake DNS server didn't start"; cat "$T/dns.log"; exit 2; }
CDN=http://cdn.test:$(cat "$T/cdn.port") CDNIP=http://127.0.0.1:$(cat "$T/cdn.port")
GIFB=$(( ($(stat -c %s "$T/cdn/lead.gif") + $(stat -c %s "$T/cdn/plain.gif")) / 2 ))
N=24
# the bound: 1.25× the page's 24 gifs on the link, + 1.5 s (one lookup and the rest)
BOUND=$(( N * GIFB * 1250 / BPS + 1500 ))

LOG=$T/backend.log
rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
(cd /tmp && exec "$DOTNET" "$DLL" serve > "$LOG" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
for _ in $(seq 1 50); do curl -sf -m 2 -H "X-Liascape-Token: $TOKEN" "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.1; done
MEDIA=http://127.0.0.1:$((PORT + 1))
OLD=""; [ "${CARD_PICTURES_OLD:-}" = 1 ] && OLD=--old
page() { node "$ROOT/scripts/test-fixtures/drive-card-pictures.mjs" "$MEDIA" "$TOKEN" "$CDN" "$@" $OLD; }
stats() { curl -sf -m 5 "$CDNIP/stats"; }
lookups() { jq -s '[.[] | select(.name == "cdn.test" and .type == 1)] | length' "$T/dns.log"; }
ms() { jq -r .ms <<< "$1"; }

echo "== 1. a page of $N cards, cold (gifs of $GIFB bytes on a $BPS B/s link: bound $BOUND ms)"
R=$(page 0 $N); echo "   $R"
L1=$(lookups)
[ "$L1" -le 1 ] && ok "lookups: cdn.test looked up $L1 time(s) for the page's $((2 * N)) pictures" \
  || bad "lookups: cdn.test looked up $L1 times for the page's $((2 * N)) pictures (want 1): each one waits on the resolver"
S=$(stats)
[ "$(jq -r '.stills, .anims' <<< "$R" | paste -sd/)" = "$N/$N" ] && ok "every still and gif arrived" \
  || bad "stills/gifs that arrived: $(jq -r '.stills, .anims' <<< "$R" | paste -sd/), want $N/$N; failed: $(jq -c .failed <<< "$R")"
G=$(jq '[.gets[]] | add // 0' <<< "$S"); MAXG=$(jq '[.gets[]] | max // 0' <<< "$S")
[ "$G" = $N ] && [ "$MAXG" = 1 ] && ok "each gif crossed the link once ($G downloads for $N cards)" \
  || bad "$G downloads for $N cards (a gif fetched up to $MAXG times): a card's still and gif each fetched their own copy"
[ "$(ms "$R")" -le $BOUND ] && ok "the page's pictures in $(ms "$R") ms (≤ $BOUND); the screen's stills in $(jq -r .screenMs <<< "$R") ms" \
  || bad "the page's pictures took $(ms "$R") ms (bound $BOUND); the screen's stills $(jq -r .screenMs <<< "$R") ms, queue median $(jq -r .queueMed <<< "$R") ms, work median $(jq -r .workMed <<< "$R") ms"

echo "== 2. the same page again"
R=$(page 0 $N); echo "   $R"
G2=$(stats | jq '[.gets[]] | add // 0')
[ "$G2" = "$G" ] && ok "nothing fetched again" || bad "$((G2 - G)) gifs fetched again"
L2=$(lookups)
[ "$L2" = "$L1" ] && ok "nothing looked up for cached pictures" || bad "$((L2 - L1)) lookups of cdn.test for pictures already cached"
[ "$(jq -r .ok <<< "$R")" = $((2 * N)) ] && [ "$(ms "$R")" -le 1500 ] && ok "every picture from the cache in $(ms "$R") ms (≤ 1500)" \
  || bad "$(jq -r .ok <<< "$R") of $((2 * N)) pictures from the cache in $(ms "$R") ms (want all, ≤ 1500)"

echo "== 3. a page left while it loads, then the next page"
R=$(page 100 $N --abort-after 600); echo "   $R"
AT=$(jq -r .abortedAt <<< "$R")
sleep 3
# the left page's downloads the CDN served to the end after the page left (each ~0.9 s on the shared link: those running
# at 600 ms were mid-body), and those it saw stop
LATE=$(jq -s --argjson at "$AT" '[.[] | select(.path | test("^/ugc/1[0-9][0-9]/")) | select(.ev == "end" and .t > $at)] | length' "$T/cdn.log")
CUT=$(jq -s '[.[] | select(.path | test("^/ugc/1[0-9][0-9]/")) | select(.ev == "abort")] | length' "$T/cdn.log")
[ "$LATE" = 0 ] && [ "$CUT" -ge 1 ] && ok "the left page's downloads stopped ($CUT cut mid-way, none finished after it was left)" \
  || bad "$LATE of the left page's downloads ran to the end after it was left ($CUT cut): nobody waits for them"
R=$(page 200 $N); echo "   $R"
[ "$(jq -r .ok <<< "$R")" = $((2 * N)) ] && [ "$(ms "$R")" -le $BOUND ] && ok "the next page's pictures in $(ms "$R") ms (≤ $BOUND)" \
  || bad "the next page: $(jq -r .ok <<< "$R") of $((2 * N)) pictures in $(ms "$R") ms (want all, ≤ $BOUND)"

stopbe
grep -E "error|Exception" "$LOG" | head -5
echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
