#!/usr/bin/env bash
# liascape-player Phase 2 on-machine battery (plan docs/superpowers/plans/2026-10-27-liascape-player-phase2-scene-worker.md
# Task 14): scene workers on the REAL outputs (DP-1 143.98 Hz, DP-2 239.76 Hz). The report is
# docs/player/reports/phase2.md. Also reachable as `battery.sh scenes <step…>`.
#
#   bash src/player/tests/onmachine/scenes.sh outputs        # step 1: pixels, pacing, CPU, pointer, visualiser
#   bash src/player/tests/onmachine/scenes.sh dropout        # step 2: V/S switch matrix, dropout detector (headless)
#   bash src/player/tests/onmachine/scenes.sh crash          # step 3: crash isolation (DP-1 video, DP-2 scene)
#   bash src/player/tests/onmachine/scenes.sh budget         # step 4: GPU budget under a heavy worker
#   bash src/player/tests/onmachine/scenes.sh workers        # step 5: several workers, S→S on both outputs
#   bash src/player/tests/onmachine/scenes.sh pause          # step 6: pause on a scripted scene
#   bash src/player/tests/onmachine/scenes.sh soak [--minutes N]   # step 7: mixed-playlist soak
#   bash src/player/tests/onmachine/scenes.sh all            # 1–7 in order
#
# Options: --results DIR (default src/player/tests/onmachine/results/phase2-<stamp>, gitignored),
# --bin DIR (liascape-player + liascape-scene-worker; default <crate>/target/release — build it first:
# `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo build --release`), --switches N
# (dropout, default 20 per cell), --minutes N (soak, default 60).
#
# Each step writes <results>/<step>.json ({checks: [{name, value, bound, pass}], …}) and a log.
#
# What it touches (the owner approved taking over the live session for these runs):
# - draws on every monitor through its OWN `liascape-player serve` (private XDG_RUNTIME_DIR/STATE/CACHE
#   → its own socket + instance lock; RLIMIT_CORE 1 so deliberate crashes reach no core handler);
#   the real Wayland session via an absolute WAYLAND_DISPLAY. It briefly puts its surfaces on the
#   overlay layer for grim pixel checks (always back to background, also from the trap).
# - AUDIO NEVER REACHES THE OWNER'S SPEAKERS: every step runs a private, hermetic PipeWire +
#   WirePlumber (the `PrivatePw` recipe of tests/common/pw.rs: own runtime/config/state dirs, no
#   D-Bus, the `policy` profile — no ALSA/Bluetooth device —, one null sink) and points the player
#   (its bus, mpv's AO, every scene worker's stream, the visualiser tap) at it. The visualiser's
#   test tone is played INTO that private PipeWire too.
# - warps the cursor over DP-1 (step 1's pointer check) and puts it back, also from the trap.
# - the backend (`livepaper-watch`) must not drive a player meanwhile: stop it first
#   (`systemctl --user stop livepaper-watch`); this script refuses to start while any other
#   liascape-player surface is mapped. It never touches settings.json, the library or the default sink.
# - kills only pids it started (its serve, the private PipeWire) and, for step 3, its own scene
#   workers (looked up through its own player's `workers` probe).
set -u -o pipefail
# This machine's shells carry a stray LD_LIBRARY_PATH that breaks ffmpeg/pipewire/liascape-player.
unset LD_LIBRARY_PATH

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CRATE=$(cd "$HERE/../.." && pwd -P)
REPO=$(cd "$CRATE/../.." && pwd -P)
WS=$HOME/.local/share/Steam/steamapps/workshop/content/431960
# The three spike scenes (Task 7) + the scripted one (Bunk: 32 scripts, a visualiser).
SC_EMILIA=$WS/1726902114   # 2048×1423
SC_KIMI=$WS/2371103399     # 3840×1080, has sound
SC_BUNK=$WS/2134765860     # 1920×1080, visualiser bars, scripts
OUT_A=DP-1
OUT_B=DP-2

STEPS=()
RESULTS=
BINDIR=$CRATE/target/release
SWITCHES=20
SOAK_MIN=60
while (($#)); do
    case $1 in
        outputs|dropout|crash|budget|workers|pause|soak|explore) STEPS+=("$1") ;;
        all) STEPS+=(outputs dropout crash budget workers pause soak) ;;
        --results) RESULTS=$2; shift ;;
        --bin) BINDIR=$2; shift ;;
        --switches) SWITCHES=$2; shift ;;
        --minutes) SOAK_MIN=$2; shift ;;
        -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done
((${#STEPS[@]})) || { echo "name a step (outputs|dropout|crash|budget|workers|pause|soak|all)" >&2; exit 2; }
BIN=$BINDIR/liascape-player
WBIN=$BINDIR/liascape-scene-worker
[[ -x $BIN && -x $WBIN ]] || { echo "no liascape-player/liascape-scene-worker in $BINDIR (build release first)" >&2; exit 2; }
RESULTS=${RESULTS:-$HERE/results/phase2-$(date +%Y%m%dT%H%M%S)}
mkdir -p "$RESULTS"
RESULTS=$(cd "$RESULTS" && pwd -P) # absolute: `ctl capture` paths are the player's
# Short paths: a unix socket path must stay < 108 bytes.
SCRATCH=$(mktemp -d /tmp/liascape-p2.XXXXXX)
MEDIA=$RESULTS/media
mkdir -p "$MEDIA"
REAL_RT=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
WL=${WAYLAND_DISPLAY:-wayland-1}
[[ $WL == /* ]] || WL=$REAL_RT/$WL

say() { printf '[scenes %s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$RESULTS/run.log" >&2; }
die() { say "ABORT: $*"; exit 1; }

# ------------------------------------------------------------------ checks → <step>.json
STEP=
CHECKS=
check() { # <name> <value> <bound text> <pass: 0/1> [extra json]
    local pass=false
    [[ $4 == 1 ]] && pass=true
    say "  $( [[ $pass == true ]] && echo PASS || echo FAIL ): $1 = $2 (bound $3)"
    jq -nc --arg n "$1" --arg v "$2" --arg b "$3" --argjson p "$pass" --argjson x "${5:-null}" \
        '{name:$n, value:$v, bound:$b, pass:$p, extra:$x}' >>"$CHECKS"
}
note() { say "  note: $*"; jq -nc --arg n "$*" '{note:$n}' >>"$CHECKS"; }
step_begin() {
    STEP=$1
    CHECKS=$RESULTS/$1.checks.jsonl
    : >"$CHECKS"
    say "=== step $1 ==="
}
step_end() {
    jq -s --arg s "$STEP" '{step:$s, checks:[.[] | select(.name)], notes:[.[] | select(.note) | .note],
        pass: ([.[] | select(.name) | .pass] | all)}' "$CHECKS" >"$RESULTS/$STEP.json"
    say "=== step $STEP: $(jq -r 'if .pass then "PASS" else "FAIL" end' "$RESULTS/$STEP.json") ($(jq '[.checks[] | select(.pass)] | length' "$RESULTS/$STEP.json")/$(jq '.checks | length' "$RESULTS/$STEP.json") checks) ==="
}
fnum() { python3 -c "import sys; print(f'{float(sys.argv[1]):.$2f}')" "$1" "${2:-2}"; }
le() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) <= float(sys.argv[2]) else 1)" "$1" "$2" && echo 1 || echo 0; }
ge() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)" "$1" "$2" && echo 1 || echo 0; }
within() { python3 -c "import sys; sys.exit(0 if abs(float(sys.argv[1])-float(sys.argv[2])) <= float(sys.argv[3]) else 1)" "$1" "$2" "$3" && echo 1 || echo 0; }

# ------------------------------------------------------------------ private PipeWire (no sound for the owner)
PW_DIR=$SCRATCH/pw
PW_PIDS=()
# The private instance's client environment (`env "${PW_ENV[@]}" cmd …` — never through a shell
# function in the background, whose $! would be a subshell, not the daemon).
PW_ENV=(-u LD_LIBRARY_PATH -u PULSE_SERVER HOME="$PW_DIR" XDG_RUNTIME_DIR="$PW_DIR/run" PIPEWIRE_RUNTIME_DIR="$PW_DIR/run"
    XDG_CONFIG_HOME="$PW_DIR/cfg" XDG_STATE_HOME="$PW_DIR/state" DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent)
pw_env() { env "${PW_ENV[@]}" "$@"; }
pw_start() {
    [[ ${#PW_PIDS[@]} -gt 0 ]] && return 0
    mkdir -p "$PW_DIR/run" "$PW_DIR/state" "$PW_DIR/cfg/wireplumber/wireplumber.conf.d"
    chmod 700 "$PW_DIR/run"
    cat >"$PW_DIR/pw.conf" <<'EOF'
context.properties = { core.daemon = true core.name = pipewire-0
  default.clock.rate = 48000 support.dbus = true log.level = 1 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-rt args = { nice.level = -11 rt.prio = 88 } flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native } { name = libpipewire-module-profiler }
  { name = libpipewire-module-access } { name = libpipewire-module-metadata }
  { name = libpipewire-module-spa-device-factory } { name = libpipewire-module-spa-node-factory }
  { name = libpipewire-module-client-node } { name = libpipewire-module-client-device }
  { name = libpipewire-module-adapter } { name = libpipewire-module-link-factory } ]
context.objects = [
  { factory = spa-node-factory args = { factory.name = support.node.driver node.name = Dummy-Driver
      node.group = pipewire.dummy priority.driver = 20000 } }
  { factory = adapter args = { factory.name = support.null-audio-sink node.name = hermetic-sink
      node.description = "hermetic sink" media.class = Audio/Sink audio.position = [ FL FR ]
      monitor.channel-volumes = true node.group = pipewire.dummy priority.driver = 21000 } } ]
EOF
    cat >"$PW_DIR/cfg/wireplumber/wireplumber.conf.d/99-hermetic.conf" <<'EOF'
wireplumber.profiles = { policy = { support.reserve-device = disabled monitor.alsa.reserve-device = disabled support.portal-permissionstore = disabled script.client.access-portal = disabled support.logind = disabled monitor.bluez.seat-monitoring = disabled hooks.device.profile.state = disabled hooks.device.routes.state = disabled } }
EOF
    env "${PW_ENV[@]}" pipewire -c "$PW_DIR/pw.conf" >"$SCRATCH/pipewire.log" 2>&1 &
    PW_PIDS+=($!)
    for _ in $(seq 100); do [[ -S $PW_DIR/run/pipewire-0 ]] && break; sleep 0.05; done
    [[ -S $PW_DIR/run/pipewire-0 ]] || die "private pipewire never came up"
    env "${PW_ENV[@]}" wireplumber -p policy >"$SCRATCH/wireplumber.log" 2>&1 &
    PW_PIDS+=($!)
    sleep 1
    # Real-time like the session's (rtkit on the system bus): without it the private graph's
    # data loop is SCHED_OTHER and, under load, whole cycles run late — every stream and the
    # meter then miss a quantum together (measured: −96 dB blocks between 2.3 ms jumps of the
    # meter's own timestamps), which the detector reads as a drop.
    local rt
    rt=$(awk '{print $41}' /proc/"${PW_PIDS[0]}"/task/*/stat 2>/dev/null | sort -u | tr '\n' ' ')
    say "private PipeWire up (pids ${PW_PIDS[*]}), runtime $PW_DIR/run, thread policies: $rt(2 = SCHED_RR)"
}
pw_stop() {
    local p
    for p in "${PW_PIDS[@]}"; do kill "$p" 2>/dev/null; done
    for p in "${PW_PIDS[@]}"; do wait "$p" 2>/dev/null; done
    PW_PIDS=()
}

# ------------------------------------------------------------------ the player
RT=$SCRATCH/run
PSTATE=$SCRATCH/state
SERVE_PID=
PLAYER_PID=
SERVE_MODE=
lp() {
    env -u LD_LIBRARY_PATH -u PULSE_SERVER XDG_RUNTIME_DIR="$RT" XDG_STATE_HOME="$PSTATE" XDG_CACHE_HOME="$SCRATCH/cache" \
        PIPEWIRE_RUNTIME_DIR="$PW_DIR/run" LIASCAPE_SCENE_WORKER_BIN="$WBIN" LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 "$BIN" "$@"
}
ctl() { lp ctl --timeout-ms "${CTL_MS:-10000}" "$@"; }
# serve_up wayland|headless:<WxH@hz,…> [extra env assignments…]
serve_up() {
    local mode=$1
    shift
    serve_down
    # A fresh runtime/state dir per serve (no snapshot of a previous step is ever restored).
    SERVE_N=$((${SERVE_N:-0} + 1))
    RT=$SCRATCH/run$SERVE_N
    PSTATE=$SCRATCH/state$SERVE_N
    mkdir -p -m 700 "$RT"
    mkdir -p "$PSTATE"
    pw_start
    local args=(serve --log-level debug) wl=(WAYLAND_DISPLAY="$WL")
    if [[ $mode == wayland ]]; then
        hyprctl layers -j | jq -e '[.. | objects | select(.namespace? == "liascape-player")] | length == 0' >/dev/null ||
            die "another liascape-player surface is mapped (stop the backend: systemctl --user stop livepaper-watch)"
    else
        args+=(--headless --outputs "${mode#headless:}" --debug)
        wl=(-u WAYLAND_DISPLAY)
    fi
    SERVE_MODE=$mode
    prlimit --core=1:1 env "${wl[@]}" "$@" \
        env -u LD_LIBRARY_PATH -u PULSE_SERVER XDG_RUNTIME_DIR="$RT" XDG_STATE_HOME="$PSTATE" XDG_CACHE_HOME="$SCRATCH/cache" \
        PIPEWIRE_RUNTIME_DIR="$PW_DIR/run" LIASCAPE_SCENE_WORKER_BIN="$WBIN" LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 \
        "$BIN" "${args[@]}" >>"$RESULTS/serve-$STEP.log" 2>&1 &
    SERVE_PID=$!
    for _ in $(seq 150); do
        [[ -S $RT/livepaper/liascape-player.sock ]] && break
        kill -0 "$SERVE_PID" 2>/dev/null || die "serve exited early (log $RESULTS/serve-$STEP.log)"
        sleep 0.1
    done
    local h
    h=$(ctl hello) || die "ctl hello: $h"
    PLAYER_PID=$(jq -r .pid <<<"$h")
    jq -e '.capabilities | index("scene")' <<<"$h" >/dev/null || die "no scene capability: $(jq -c .health <<<"$h")"
    say "serve ($mode) up: supervisor $SERVE_PID, compositor $PLAYER_PID, backend $(jq -r .backend <<<"$h")"
    # The real bus must be on the PRIVATE PipeWire (never the owner's).
    for _ in $(seq 50); do [[ $(ctl probe '{"name":"bus"}' | jq -r .state) == up ]] && break; sleep 0.1; done
    say "bus: $(ctl probe '{"name":"bus"}' | jq -c '{state, target, default_sink, latency_ms}')"
    [[ $(ctl probe '{"name":"bus"}' | jq -r .default_sink) == hermetic-sink ]] || die "the bus is not on the private PipeWire"
}
serve_down() {
    [[ -n $SERVE_PID ]] || return 0
    if kill -0 "$SERVE_PID" 2>/dev/null; then
        ctl set '{"path":"out:*.layer","value":"background"}' >/dev/null 2>&1
        ctl quit >/dev/null 2>&1
        for _ in $(seq 80); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
        kill -TERM "$SERVE_PID" 2>/dev/null && sleep 1
        kill -KILL "$SERVE_PID" 2>/dev/null
    fi
    wait "$SERVE_PID" 2>/dev/null
    SERVE_PID=
    PLAYER_PID=
}

CURSOR=
FOCUS=
restore_cursor() {
    [[ -n $CURSOR ]] || return 0
    local f
    f=$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')
    [[ -n $FOCUS && $f != "$FOCUS" ]] && hyprctl eval "hl.dispatch(hl.dsp.focus({ monitor = \"$FOCUS\" }))" >/dev/null
    cursor_to "$(jq -r .x <<<"$CURSOR")" "$(jq -r .y <<<"$CURSOR")"
    CURSOR=
}
cursor_to() { hyprctl eval "hl.dispatch(hl.dsp.cursor.move({ x = $1, y = $2 }))" >/dev/null; }

cleanup() {
    local rc=$?
    restore_cursor
    [[ -n ${TONE_PID:-} ]] && kill "$TONE_PID" 2>/dev/null
    serve_down
    pw_stop
    if hyprctl layers -j | jq -e '[.. | objects | select(.namespace? == "liascape-player")] | length > 0' >/dev/null 2>&1; then
        say "WARNING: an liascape-player layer surface is still mapped"
    fi
    say "results: $RESULTS"
    command -v trash >/dev/null && trash "$SCRATCH" 2>/dev/null
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# ------------------------------------------------------------------ media
# A synthetic scene folder (tests/common::synthetic_scene's layout). $2 = liascape-synthetic.json.
mk_scene() {
    local d=$MEDIA/scenes/$1
    mkdir -p "$d"
    jq -nc --arg t "liascape-player synthetic scene $1" '{type:"scene", title:$t, file:"scene.json", preview:"preview.png"}' >"$d/project.json"
    head -c 16 /dev/zero >"$d/scene.pkg"
    echo "$2" >"$d/liascape-synthetic.json"
    [[ -f $d/preview.png ]] || ffmpeg -nostdin -v error -y -f lavfi -i color=c=0x404040:s=320x180 -frames:v 1 "$d/preview.png"
    echo "$d"
}
mk_clip() { # <name> <ffmpeg video src> <rate> <seconds> <tone hz|0> <size>
    local f=$MEDIA/$1.mkv
    [[ -s $f ]] && { echo "$f"; return; }
    local a=() m=()
    if [[ $5 != 0 ]]; then
        a=(-f lavfi -i "aevalsrc=0.1*sin(2*PI*$5*t)|0.1*sin(2*PI*$5*t):s=48000:d=$4")
        m=(-c:a pcm_s16le)
    fi
    local src=$2=size=$6:rate=$3
    [[ $2 == *=* ]] && src=$2:size=$6:rate=$3
    ffmpeg -nostdin -v error -y -f lavfi -i "$src" "${a[@]}" -t "$4" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${m[@]}" "$f" || die "ffmpeg $1"
    echo "$f"
}

# ------------------------------------------------------------------ player helpers
create_scene() {
    local x='{}'
    [[ -n ${2:-} ]] && x=$2
    ctl create "$(jq -nc --arg p "$1" --argjson x "$x" '{kind:"source", props:({kind:"scene", path:$p} + $x)}')" | jq -r .id
}
create_video() { ctl create "$(jq -nc --arg p "$1" '{kind:"source", props:{path:$p, loop:true}}')" | jq -r .id; }
create_color() { ctl create "{\"kind\":\"source\",\"props\":{\"kind\":\"color\",\"color\":$1}}" | jq -r .id; }
show() { ctl set "{\"path\":\"lay:$1:main.content\",\"value\":\"$2\"}" >/dev/null || die "show $2 on $1"; }
destroy() { ctl destroy "{\"id\":\"$1\"}" >/dev/null 2>&1; }
wait_ready() { # <id> [timeout s]
    local i n=$(( ${2:-20} * 20 ))
    for ((i = 0; i < n; i++)); do
        [[ $(ctl get "{\"path\":\"$1.ready\"}" | jq -r .value) == true ]] && return 0
        sleep 0.05
    done
    return 1
}
worker_of() { ctl probe '{"name":"workers"}' | jq -c --arg id "$1" '.workers[] | select(.id == $id)' 2>/dev/null | head -1; }
workers_json() { ctl probe '{"name":"workers"}'; }
frames() { ctl probe '{"name":"frames"}'; }
reset_frames() { ctl probe '{"name":"frames","args":{"reset":true}}' >/dev/null; }
fstat() { jq -r --arg o "$2" ".outputs[] | select(.name == \$o) | $3" <<<"$1"; }
now_ms() { ctl probe '{"name":"bus"}' | jq -r .now_ms; }
# CPU % of one core used by a pid (all threads) over $2 seconds.
cpu_pct() {
    local pid=$1 s=$2 a b hz
    hz=$(getconf CLK_TCK)
    a=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null) || { echo nan; return; }
    sleep "$s"
    b=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null) || { echo nan; return; }
    python3 -c "print(f'{($b-$a)/$hz/$s*100:.2f}')"
}
# CPU % of two pids measured over the same window: prints "<a> <b>".
cpu_pct2() {
    local s=$3 hz a1 b1 a2 b2
    hz=$(getconf CLK_TCK)
    a1=$(awk '{print $14+$15}' "/proc/$1/stat"); b1=$(awk '{print $14+$15}' "/proc/$2/stat")
    sleep "$s"
    a2=$(awk '{print $14+$15}' "/proc/$1/stat"); b2=$(awk '{print $14+$15}' "/proc/$2/stat")
    python3 -c "print(f'{($a2-$a1)/$hz/$s*100:.2f} {($b2-$b1)/$hz/$s*100:.2f}')"
}
grim_png() { grim -o "$1" "$2"; }
# Image stats: luma stddev and the share of the most common colour (blank = stddev < 2 or ≥ 99 %).
img_stats() {
    python3 - "$1" <<'PY'
import sys, json
from PIL import Image, ImageStat
im = Image.open(sys.argv[1]).convert("RGB")
sm = im.resize((max(1, im.width // 4), max(1, im.height // 4)))
l = sm.convert("L")
sd = ImageStat.Stat(l).stddev[0]
cols = sm.getcolors(sm.width * sm.height) or []
top = max(c for c, _ in cols) / (sm.width * sm.height) if cols else 1.0
print(json.dumps({"luma_sd": round(sd, 2), "top_colour_share": round(top, 4), "blank": sd < 2 or top >= 0.99}))
PY
}
# Mean absolute RGB difference (0–255) between two images; "identical" = 0.
img_diff() {
    python3 - "$1" "$2" <<'PY'
import sys
from PIL import Image, ImageChops, ImageStat
a = Image.open(sys.argv[1]).convert("RGB"); b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size: print("nan"); sys.exit()
d = ImageChops.difference(a, b)
print(f"{sum(ImageStat.Stat(d).mean) / 3:.4f}")
PY
}
on_overlay() { # put our surfaces on the overlay layer (owner's windows cover the background) and wait
    ctl set '{"path":"out:*.layer","value":"overlay"}' >/dev/null
    local o
    for o in $OUT_A $OUT_B; do
        for _ in $(seq 30); do
            hyprctl layers -j | jq -e --arg o "$o" --argjson p "$PLAYER_PID" \
                '.[$o].levels."3"[]? | select(.namespace == "liascape-player" and .pid == $p)' >/dev/null && break
            sleep 0.1
        done
    done
    sleep 0.3
}
on_background() { ctl set '{"path":"out:*.layer","value":"background"}' >/dev/null; sleep 0.2; }
events_since() { # <t_mono_ms> <kind prefix> → JSON array of events
    ctl logs "{\"kind_prefix\":\"$2\",\"limit\":10000}" | jq -c --argjson t "$1" '[.events[] | select(.t_mono_ms >= $t)]'
}

. "$HERE/scenes_steps.sh"

for s in "${STEPS[@]}"; do
    "step_$s"
done
jq -s '{steps: ., pass: ([.[].pass] | all)}' "$RESULTS"/{outputs,dropout,crash,budget,workers,pause,soak}.json 2>/dev/null >"$RESULTS/summary.json"
say "summary: $(jq -c '[.steps[] | {step, pass}]' "$RESULTS/summary.json")"
