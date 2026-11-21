#!/usr/bin/env bash
# Hermetic test of the legacy engine's (`PlayerEngine=legacy`) cold mpvpaper launch and its auto-mute monitor
# (src/backend/Helpers/PlayerHelper.cs AnnounceWhenIpcAnswers, AudioMonitor.SpawnDetachedMonitor):
#  launch: a page whose WebSocket opened after `/apply` announced B, while /current still said nothing (mpv's IPC socket
#          not up yet), hears `wallpaper-changed` B once the launch's IPC answers, and /current names B; a launch
#          superseded by a newer cold apply, or stopped, before its IPC answered never announces its file afterwards.
#  monitor: a forwarded `liascape play` on a `serve` that runs auto-mute itself spawns no `monitor-daemon`; closing that
#          backend still hands auto-mute to exactly one.
#  presets: a legacy playlist never starts linux-wallpaperengine on a preset (presets play only in the Liascape player):
#          Play and shuffle start at the next item that plays, play-from on one and a playlist of only presets are
#          refused with the reason.
# mpvpaper, linux-wallpaperengine, pactl, parec and playerctl are stubs on PATH: the mpvpaper stub answers mpv's IPC
# (`path` = its file, a loadfile moves it) after a delay read from $T/mpv-delay, plays nothing, needs no Wayland output;
# the LWE stub logs its arguments and idles; the audio stubs log their arguments and never reach an audio server. Runs in its own user, network, mount and PID namespaces
# (`unshare -rnpf --mount-proc`): the backend's process scans (mpvpaper by cmdline, LWE, liascape-transition) see only
# this run's processes, and every one dies with the namespace. Temp HOME + XDG dirs; never touches ~/.config/liascape,
# the session's player, its audio or its outputs.
#
# Usage: scripts/test-legacy-launch.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs / screenshots and prints where (last line).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), curl, jq, python3, timeout, setsid.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_LEGACY_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip curl jq python3 timeout setsid; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-legacy-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-legacy- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_LEGACY_T=$T
  # PID 1 of the new namespace is this script: when it exits, the kernel kills every process left in it
  timeout -k 10 240 unshare -rnpf --mount-proc bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_LEGACY_T
DLL=$T/backend/liascape-backend.dll
BP=""; WP=""
stopws() { [ -n "$WP" ] && { kill "$WP" 2>/dev/null; wait "$WP" 2>/dev/null; }; WP=""; }
stopbe() { stopws; [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }; BP=""; }
trap 'stopbe' EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET PULSE_SERVER
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }

# ── stubs ────────────────────────────────────────────────────────────────────────────────────────────────────────────
mkdir -p "$T/bin"
echo 2 > "$T/mpv-delay"
cat > "$T/bin/mpvpaper" <<PY
#!/usr/bin/env python3
# mpvpaper -o "<mpv options>" <output> <file>: after \$(cat mpv-delay) s, answers mpv's JSON IPC on --input-ipc-server
import json, os, socket, sys, threading, time
args = sys.argv[1:]
opts = args[args.index("-o") + 1] if "-o" in args else ""
cur = {"path": args[-1]}
ipc = next((o.split("=", 1)[1] for o in opts.split() if o.startswith("--input-ipc-server=")), None)
with open("$T/mpvpaper.log", "a") as f: f.write(f"start {cur['path']}\n")
time.sleep(float(open("$T/mpv-delay").read()))
if not ipc: sys.exit(0)
try: os.unlink(ipc)
except FileNotFoundError: pass
srv = socket.socket(socket.AF_UNIX); srv.bind(ipc); srv.listen(16)
def serve(c):
    try:
        for line in c.makefile("rb"):
            try: cmd = json.loads(line)["command"]
            except Exception: continue
            if cmd[0] == "get_property":
                v = {"path": cur["path"], "playtime-remaining": 60.0, "time-remaining": 60.0, "duration": 60.0,
                     "time-pos": 1.0, "pause": False, "speed": 1.0, "volume": 100.0, "mute": False}.get(cmd[1])
                r = {"data": v, "error": "success"} if v is not None else {"error": "property unavailable"}
            else:
                if cmd[0] == "loadfile": cur["path"] = cmd[1]
                r = {"data": None, "error": "success"}
            c.sendall((json.dumps(r) + "\n").encode())
    except Exception: pass
    finally: c.close()
while True:
    c, _ = srv.accept(); threading.Thread(target=serve, args=(c,), daemon=True).start()
PY
# the auto-mute monitor's tools: log the call; `pactl subscribe` stays up (a live event stream), the rest print nothing
for t in pactl parec playerctl; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/audio.log"\ncase "$1" in subscribe) exec sleep 3600 ;; esac\nexit 0\n' "$t" "$T" > "$T/bin/$t"
done
# linux-wallpaperengine: each launch's arguments (the scene is the last), then it idles like a running scene
printf '#!/bin/sh\necho "$*" >> "%s/lwe.log"\nexec sleep 3600\n' "$T" > "$T/bin/linux-wallpaperengine"
chmod +x "$T/bin/"*
: > "$T/audio.log"; : > "$T/mpvpaper.log"; : > "$T/lwe.log"
export PATH=$T/bin:$PATH

V=$T/media; mkdir -p "$V"
for n in v1 v2 v3; do head -c 64 /dev/zero > "$V/$n.mp4"; done
# scenes on (LWE is the stub, one named monitor to launch it on) for § presets; the videos above never notice
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"legacy","AutoMute":true,"NoAudio":true,"RestartMpvpaperEverySeconds":0,"AutoAddWeWallpapersToLibrary":false,
 "AllowScenes":true,"SceneMonitors":[{"Name":"TEST-1","IsPrimary":true}],"LastSession":{"Paths":["$V/v1.mp4"]}}
EOF

LOG=$T/backend.log
startbe() {
  rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
  (cd /tmp && exec "$DOTNET" "$DLL" serve >> "$LOG" 2>&1) & BP=$!
  for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
  PORT=$(cat "$XDG_CONFIG_HOME/liascape/serve.port"); U=http://127.0.0.1:$PORT
  TOKEN=$(cat "$XDG_CONFIG_HOME/liascape/serve.token")
  for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
}
api() { curl -s -m 10 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
post() { api -o /dev/null -w '%{http_code}' -X POST "$U$1" -d "$2"; }
current() { api "$U/current" | jq -r '.path // "null"'; }

# the WebSocket's events, one JSON per line, into $1 (a minimal client: python's stdlib has none)
openws() {
  local out=$1; : > "$out"; rm -f "$out.ready"
  python3 -I - "$PORT" "$TOKEN" "$out" <<'PY' & WP=$!
import socket, sys, base64, os
port, token, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
s = socket.create_connection(("127.0.0.1", port))
key = base64.b64encode(os.urandom(16)).decode()
s.sendall((f"GET /events?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
buf = b""
while b"\r\n\r\n" not in buf: buf += s.recv(4096)
head, buf = buf.split(b"\r\n\r\n", 1)
if b" 101 " not in head.split(b"\r\n")[0]: sys.exit("no websocket: " + head.decode(errors="replace"))
open(out + ".ready", "w").close()
def need(n):
    global buf
    while len(buf) < n:
        c = s.recv(65536)
        if not c: sys.exit(0)
        buf += c
while True:
    need(2); op, ln = buf[0] & 0x0F, buf[1] & 0x7F; i = 2
    if ln == 126: need(4); ln = int.from_bytes(buf[2:4], "big"); i = 4
    elif ln == 127: need(10); ln = int.from_bytes(buf[2:10], "big"); i = 10
    need(i + ln); data, buf = buf[i:i + ln], buf[i + ln:]
    if op == 1:
        with open(out, "a") as f: f.write(data.decode() + "\n")
PY
  for _ in $(seq 1 50); do [ -e "$out.ready" ] && return 0; sleep 0.1; done
  bad "the WebSocket didn't open"; return 1
}
# the paths of every wallpaper-changed in $1, in order (null = nothing plays)
changes() { jq -r 'select(.type == "wallpaper-changed") | .payload.path // "null"' "$1" 2>/dev/null; }
# this namespace's processes whose argv has the word $1
procs() { local n=0 p; for p in /proc/[0-9]*; do tr '\0' '\n' < "$p/cmdline" 2>/dev/null | grep -qx -- "$1" && n=$((n + 1)); done; echo $n; }

startbe

echo "== launch: a page that opened after /apply's announcement hears B when mpv's IPC first answers"
post /apply "{\"path\":\"$V/v1.mp4\"}" >/dev/null
EV=$T/ev-late.jsonl; openws "$EV"
c0=$(current)
if [ "$c0" != null ]; then
  bad "/current right after a cold /apply said $c0 — the launch window was already over, this proved nothing (raise mpv-delay)"
else
  ok "/current right after a cold /apply says nothing plays (mpv's IPC isn't up yet)"
  for _ in $(seq 1 80); do changes "$EV" | grep -qx "$V/v1.mp4" && break; sleep 0.1; done
  if changes "$EV" | grep -qx "$V/v1.mp4"; then ok "wallpaper-changed v1.mp4 reached the late page once mpv answered"
  else bad "the late page heard no wallpaper-changed v1.mp4 in 8 s (got: $(changes "$EV" | xargs -r -n1 basename | tr '\n' ' '))"; fi
fi
c1=$(current); [ "$c1" = "$V/v1.mp4" ] && ok "/current names v1.mp4 once mpv answers" || bad "/current → $c1, want v1.mp4"
stopws

echo "== launch: a cold apply superseded before its IPC answered never announces its file afterwards"
post /stop '{}' >/dev/null; sleep 0.3
EV=$T/ev-super.jsonl; openws "$EV"
post /apply "{\"path\":\"$V/v1.mp4\"}" >/dev/null; sleep 0.4
post /apply "{\"path\":\"$V/v2.mp4\"}" >/dev/null
for _ in $(seq 1 30); do [ "$(tail -1 "$T/mpvpaper.log")" = "start $V/v2.mp4" ] && break; sleep 0.1; done # the stub's start
[ "$(tail -2 "$T/mpvpaper.log" | tr '\n' ' ')" = "start $V/v1.mp4 start $V/v2.mp4 " ] \
  || bad "v1.mp4 then v2.mp4 weren't two cold launches ($(tail -2 "$T/mpvpaper.log" | tr '\n' ' ')) — this proved nothing"
sleep 4.5
seq_=$(changes "$EV" | xargs -r -n1 basename | tr '\n' ' ')
after=$(changes "$EV" | sed -n "\|^$V/v2.mp4\$|,\$p")
if [ -z "$after" ]; then bad "v2.mp4 was never announced ($seq_)"
elif echo "$after" | grep -qvx "$V/v2.mp4"; then bad "after v2.mp4 was announced: something else ($seq_)"
else ok "after v2.mp4 was announced only v2.mp4 followed ($seq_)"; fi
[ "$(current)" = "$V/v2.mp4" ] && ok "/current names v2.mp4" || bad "/current → $(current), want v2.mp4"
stopws

echo "== launch: a cold apply stopped before its IPC answered never announces its file afterwards"
post /stop '{}' >/dev/null; sleep 0.3
EV=$T/ev-stop.jsonl; openws "$EV"
post /apply "{\"path\":\"$V/v3.mp4\"}" >/dev/null; sleep 0.4
for _ in $(seq 1 30); do grep -qx "start $V/v3.mp4" "$T/mpvpaper.log" && break; sleep 0.1; done
grep -qx "start $V/v3.mp4" "$T/mpvpaper.log" || bad "the v3.mp4 apply launched no mpvpaper — not a cold launch, this proved nothing"
code=$(post /action '{"name":"stop"}')
sleep 3.5
seq_=$(changes "$EV" | while read -r p; do [ "$p" = null ] && echo null || basename "$p"; done | tr '\n' ' ')
after=$(changes "$EV" | sed -n '/^null$/,$p' | tail -n +2)
if [ "$code" != 200 ] || ! changes "$EV" | grep -qx null; then bad "the stop wasn't announced (HTTP $code; $seq_)"
elif [ -n "$after" ]; then bad "after the stop: $(echo "$after" | xargs -n1 basename | tr '\n' ' ')($seq_)"
else ok "nothing announced after the stop ($seq_)"; fi
[ "$(current)" = null ] && ok "/current says nothing plays after the stop" || bad "/current → $(current) after the stop"
stopws

echo "== monitor: a forwarded \`play\` spawns no monitor-daemon next to the backend's own monitor"
grep -q "^pactl subscribe" "$T/audio.log" && ok "the backend runs auto-mute itself (its own pactl subscribe)" \
  || bad "the backend's own monitor never started (no pactl subscribe) — the check below would prove nothing"
[ "$(procs monitor-daemon)" = 0 ] || bad "a monitor-daemon ran before the play: $(procs monitor-daemon)"
out=$("$DOTNET" "$DLL" play 2>&1); rc=$?
sleep 3
[ $rc = 0 ] && grep -c "start $V/v3.mp4" "$T/mpvpaper.log" | grep -qx 2 \
  && ok "\`liascape play\` was forwarded and replayed the last session (v3.mp4)" \
  || bad "\`liascape play\`: exit $rc, $out; launches: $(tr '\n' ' ' < "$T/mpvpaper.log")"
n=$(procs monitor-daemon)
[ "$n" = 0 ] && ok "no monitor-daemon after a forwarded play" || bad "$n monitor-daemon(s) next to the backend's own monitor after a forwarded play"

echo "== monitor: closing the backend still hands auto-mute to one monitor-daemon"
for _ in $(seq 1 30); do [ "$(current)" = "$V/v3.mp4" ] && break; sleep 0.1; done
stopbe
for _ in $(seq 1 50); do [ "$(procs monitor-daemon)" -ge 1 ] && break; sleep 0.1; done
sleep 1
n=$(procs monitor-daemon)
[ "$n" = 1 ] && ok "one monitor-daemon after the backend closed" || bad "$n monitor-daemon(s) after the backend closed, want 1"

echo "== presets: a legacy playlist never starts linux-wallpaperengine on a preset"
# a scene and a preset of it (Wallpaper Engine's shape: no type, a `preset` object, the base's Workshop id): the base is
# here, so the only reason the preset can't play is the engine
LIB=$XDG_DATA_HOME/liascape/library
BASE=$LIB/workshop/900000001; P=$LIB/workshop/910000101
mkdir -p "$BASE" "$P"
printf '{"type":"scene","title":"Base","file":"scene.json"}' > "$BASE/project.json"; head -c 16 /dev/zero > "$BASE/scene.pkg"
printf '{"dependency":"900000001","preset":{"color":"0 0 1"},"title":"Preset","tags":["Unspecified"],"visibility":"public"}' > "$P/project.json"
LEG="Presets play only in the Liascape player"
echo 0.3 > "$T/mpv-delay"
startbe
reason=$(api "$U/library" | jq -r --arg p "$P" '[.[] | select(.videoPath == $p)][0].presetReason')
[ "$reason" = "$LEG" ] || bad "precondition: the preset's library reason is \"$reason\", want \"$LEG\""
play() { api -X POST "$U/playlist/$1" -d "$2" | jq -r '.message // "?"'; }
lwe_on_preset() { grep -c "910000101" "$T/lwe.log"; }
starts() { wc -l < "$T/mpvpaper.log"; }
# what plays after a Play: the mpvpaper launch it made, if any, and /current once mpv answers
after_play() { local m0=$1 p; for _ in $(seq 1 40); do [ "$(starts)" -gt "$m0" ] && break; sleep 0.1; done
  for _ in $(seq 1 30); do p=$(current); [ "$p" != null ] && break; sleep 0.1; done; echo "$p"; }
m0=$(starts)
msg=$(play play "{\"paths\":[\"$P\",\"$V/v1.mp4\"],\"settings\":{\"order\":0}}")
cur=$(after_play "$m0")
[ "$msg" = "" ] && [ "$cur" = "$V/v1.mp4" ] && [ "$(lwe_on_preset)" = 0 ] \
  && ok "Play [preset, v1] → v1 plays, LWE never started on the preset" \
  || bad "Play [preset, v1]: message \"$msg\", /current $cur, LWE launches on the preset $(lwe_on_preset) ($(tail -1 "$T/lwe.log"))"
m0=$(starts)
msg=$(play play-from "{\"paths\":[\"$V/v2.mp4\",\"$P\"],\"startIndex\":1,\"settings\":{\"order\":0}}")
sleep 1
[ "$msg" = "$LEG" ] && [ "$(starts)" = "$m0" ] && [ "$(current)" = "$V/v1.mp4" ] && [ "$(lwe_on_preset)" = 0 ] \
  && ok "play-from the preset → refused: \"$msg\" (v1 plays on)" \
  || bad "play-from the preset: message \"$msg\", mpvpaper launches $(( $(starts) - m0 )), /current $(current), LWE on the preset $(lwe_on_preset)"
shuffled=""
for i in 1 2 3 4; do
  m0=$(starts)
  play play "{\"paths\":[\"$P\",\"$V/v$((i % 2 + 2)).mp4\"],\"settings\":{\"order\":1}}" >/dev/null
  shuffled="$shuffled $(basename "$(after_play "$m0")")"
done
[ "$(lwe_on_preset)" = 0 ] && [ "$shuffled" = " v3.mp4 v2.mp4 v3.mp4 v2.mp4" ] \
  && ok "shuffle [preset, video] ×4 → the video each time ($shuffled), LWE never on the preset" \
  || bad "shuffle [preset, video] ×4: played$shuffled, LWE on the preset $(lwe_on_preset)"
msg=$(play play "{\"paths\":[\"$P\"],\"settings\":{\"order\":0}}")
sleep 1
[ "$msg" = "$LEG" ] && [ "$(lwe_on_preset)" = 0 ] && ok "Play [preset] alone → refused: \"$msg\"" \
  || bad "Play [preset] alone: message \"$msg\", LWE on the preset $(lwe_on_preset)"
grep -q "skipping 910000101: $LEG" "$LOG" && ok "the backend log says why the preset was skipped" || bad "no 'skipping 910000101: …' in the backend log"
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
