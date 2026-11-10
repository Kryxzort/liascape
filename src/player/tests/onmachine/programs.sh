#!/usr/bin/env bash
# liascape-player Phase 3 on-machine battery (plan docs/superpowers/plans/2026-10-29-liascape-player-phase3-programs.md
# Task 12): programs (rotation inside the player) and the cover Signal on the REAL outputs (DP-1 143.98 Hz,
# DP-2 239.76 Hz). The report is docs/player/reports/phase3.md. Also reachable as `battery.sh programs <step…>`.
#
#   bash src/player/tests/onmachine/programs.sh dropout     # step 1: dropout across program switches (5 cells × 3 methods;
#                                                            `manual` = the user's next/prev/random, + next mid-effect)
#   bash src/player/tests/onmachine/programs.sh appclosed   # step 2: the app closed, a 1 h rotation + CLI keybinds
#   bash src/player/tests/onmachine/programs.sh crash       # step 3: 5 × SIGSEGV mid-rotation + restore × start mode
#   bash src/player/tests/onmachine/programs.sh cover       # step 4: pause when covered (kitty, mpv), one output, default
#   bash src/player/tests/onmachine/programs.sh nomonitor   # step 4b: both monitors disabled: rotate / hold
#   bash src/player/tests/onmachine/programs.sh soak        # step 5: 2 h mixed program, the app closed
#   bash src/player/tests/onmachine/programs.sh all         # every step, in that order
#   bash src/player/tests/onmachine/programs.sh suspend     # step 6.2: suspend + rtcwake mid-interval: no catch-up switch
#   bash src/player/tests/onmachine/programs.sh vt          # step 6.3: a VT switch and back mid-rotation
#   (suspend and vt are not in `all`: each takes the whole machine; the owner says when)
#
# Options: --results DIR (default src/player/tests/onmachine/results/phase3-<stamp>, gitignored), --bin DIR
# (liascape-player + liascape-scene-worker; default <crate>/target/release), --dll PATH (the backend,
# default src/backend/bin/Debug/net10.0/liascape-backend.dll), --switches N (dropout, default 50 per cell),
# --cells LIST / --methods LIST (dropout subsets, comma-separated), --app-minutes N (default 60),
# --soak-minutes N (default 120). DOTNET=<path> if `dotnet` is not on PATH (it is inside `nix develop`).
# --headless WxH@HZ[,…] (bare-serve steps only: dropout, soak): the player draws on HEADLESS outputs instead of the
# real session (no Wayland, no Hyprland IPC; the private PipeWire as always) — the switch-over checklist's runs that
# need no owner (docs/player/reports/switch-over.md), e.g. `--headless 1920x1080@144,1920x1080@240`.
#
# Each step writes <results>/<step>.json ({checks: [{name, value, bound, pass}], notes, pass}) and a log;
# every number is computed from the player's own event file (`<state>/liascape/liascape-player/events*.jsonl`)
# by programs_report.py.
#
# What it touches (the owner approved taking over the live session for these runs):
# - draws on both monitors through its OWN player: either a bare `liascape-player serve` (steps 1, 5) or one
#   started by its OWN private backend (`liascape-backend serve` with a private HOME / XDG dirs / port —
#   steps 2, 3, 4, 4b), on the real Wayland session (absolute WAYLAND_DISPLAY) and the real Hyprland IPC
#   (the private runtime dir links `hypr/` to the real one). The owner's backend (`liascape-watch`) and their
#   player must be stopped first; it refuses to start while another liascape-player surface is mapped.
#   It never touches the owner's settings.json, library, playlists or default sink.
# - AUDIO NEVER REACHES THE OWNER'S SPEAKERS: a private, hermetic PipeWire + WirePlumber (scenes.sh's recipe)
#   carries the bus, mpv and the scene workers; the dropout detector reads the bus meter there.
# - step 4 opens its own windows (kitty, mpv; classes `lia-cov-*`) fullscreen / maximized on workspaces 1
#   and 6 with `silent` (no focus change) and closes them by pid; step 4b disables both monitors with
#   `hyprctl eval 'hl.monitor({… disabled = true})'` (this Hyprland has no `keyword`) and re-enables them
#   with the owner's own System.lua lines + `disabled = false`. A detached watchdog re-enables them if this
#   script dies or a phase overruns, and the EXIT trap does too; the step ends by comparing `hyprctl
#   monitors` and the workspaces with the state before.
# - kills only pids it started: its serve / backend, the private PipeWire, its windows, and (step 3) its own
#   compositor child, identified through its own socket (`ctl hello`) and checked in /proc (exe, parent,
#   XDG_RUNTIME_DIR) before the signal.
set -u -o pipefail
unset LD_LIBRARY_PATH

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CRATE=$(cd "$HERE/../.." && pwd -P)
REPO=$(cd "$CRATE/../.." && pwd -P)
WS=$HOME/.local/share/Steam/steamapps/workshop/content/431960
SC_EMILIA=$WS/1726902114 # 2048×1423
SC_KIMI=$WS/2371103399   # 3840×1080, has sound
SC_BUNK=$WS/2134765860   # 1920×1080, scripts + visualiser
OUT_A=DP-1
OUT_B=DP-2
REPORT_PY=$HERE/programs_report.py

STEPS=()
RESULTS=
BINDIR=$CRATE/target/release
DLL=$REPO/src/backend/bin/Debug/net10.0/liascape-backend.dll
SWITCHES=50
CELLS=timer,onend,onendmax,scenes,manual
METHODS=full-live,reveal,frozen
APP_MIN=60
SOAK_MIN=120
HEADLESS=
SUSPEND_S=60
VT_S=15
while (($#)); do
    case $1 in
        dropout|appclosed|crash|cover|nomonitor|soak|suspend|vt|sceneaway) STEPS+=("$1") ;;
        all) STEPS+=(dropout appclosed crash cover soak nomonitor) ;; # no monitor last: the one step that can upset the session
        --results) RESULTS=$2; shift ;;
        --bin) BINDIR=$2; shift ;;
        --dll) DLL=$2; shift ;;
        --switches) SWITCHES=$2; shift ;;
        --cells) CELLS=$2; shift ;;
        --methods) METHODS=$2; shift ;;
        --app-minutes) APP_MIN=$2; shift ;;
        --soak-minutes) SOAK_MIN=$2; shift ;;
        --headless) HEADLESS=$2; shift ;;
        -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done
if [[ -n $HEADLESS ]]; then
    for s in "${STEPS[@]}"; do [[ $s == dropout || $s == soak ]] || { echo "--headless: only the dropout and soak steps run headless (not $s)" >&2; exit 2; }; done
fi
((${#STEPS[@]})) || { echo "name a step (dropout|appclosed|crash|cover|nomonitor|soak|suspend|vt|sceneaway|all)" >&2; exit 2; }
BIN=$BINDIR/liascape-player
WBIN=$BINDIR/liascape-scene-worker
[[ -x $BIN && -x $WBIN ]] || { echo "no liascape-player/liascape-scene-worker in $BINDIR (build release first)" >&2; exit 2; }
DOTNET=${DOTNET:-$(command -v dotnet || true)}
DOTNET_ROOT_=${DOTNET_ROOT:-$( [[ -n $DOTNET ]] && cd "$(dirname "$(readlink -f "$DOTNET")")/../share/dotnet" 2>/dev/null && pwd)}
RESULTS=${RESULTS:-$HERE/results/phase3-$(date +%Y%m%dT%H%M%S)}
mkdir -p "$RESULTS"
RESULTS=$(cd "$RESULTS" && pwd -P)
SCRATCH=$(mktemp -d /tmp/lp3.XXXXXX) # short: a unix socket path (be/rt/hypr/<sig>/.socket2.sock) must stay < 108 bytes
MEDIA=$RESULTS/media
mkdir -p "$MEDIA"
REAL_RT=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
WL=${WAYLAND_DISPLAY:-wayland-1}
[[ $WL == /* ]] || WL=$REAL_RT/$WL
HYPR_SIG=${HYPRLAND_INSTANCE_SIGNATURE:-}

say() { printf '[programs %s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$RESULTS/run.log" >&2; }
die() { say "ABORT: $*"; exit 1; }
now() { date +%s.%N; }

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
b01() { [[ $1 == true ]] && echo 1 || echo 0; } # a jq boolean → 0/1
pyb() { python3 -c "import sys; print(1 if ($1) else 0)"; }

# ------------------------------------------------------------------ private PipeWire (no sound for the owner)
PW_DIR=$SCRATCH/pw
PW_PIDS=()
PW_ENV=(-u LD_LIBRARY_PATH -u PULSE_SERVER HOME="$PW_DIR" XDG_RUNTIME_DIR="$PW_DIR/run" PIPEWIRE_RUNTIME_DIR="$PW_DIR/run"
    XDG_CONFIG_HOME="$PW_DIR/cfg" XDG_STATE_HOME="$PW_DIR/state" DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent)
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
    say "private PipeWire up (pids ${PW_PIDS[*]}), runtime $PW_DIR/run"
}
pw_stop() {
    local p
    for p in "${PW_PIDS[@]}"; do kill "$p" 2>/dev/null; done
    for p in "${PW_PIDS[@]}"; do wait "$p" 2>/dev/null; done
    PW_PIDS=()
}

# ------------------------------------------------------------------ the player (bare, or the private backend's)
RT=
PSTATE=
PCACHE=
SERVE_PID=
PLAYER_PID=
lp() {
    env -u LD_LIBRARY_PATH -u PULSE_SERVER -u LIASCAPE_PLAYER_SOCKET XDG_RUNTIME_DIR="$RT" XDG_STATE_HOME="$PSTATE" \
        XDG_CACHE_HOME="$PCACHE" PIPEWIRE_RUNTIME_DIR="$PW_DIR/run" LIASCAPE_SCENE_WORKER_BIN="$WBIN" "$BIN" "$@"
}
ctl() { lp ctl --timeout-ms "${CTL_MS:-10000}" "$@"; }
evdir() { echo "$PSTATE/liascape/liascape-player"; }
report() { python3 "$REPORT_PY" "$@"; }
others_mapped() { # another liascape-player's layer surface (not ours) is mapped
    local mine=${PLAYER_PID:-0}
    hyprctl layers -j | jq -e --argjson me "$mine" '[.. | objects | select(.namespace? == "liascape-player" and .pid != $me)] | length > 0' >/dev/null
}
link_hypr() { mkdir -p -m 700 "$1"; [[ -e $1/hypr ]] || ln -s "$REAL_RT/hypr" "$1/hypr"; }
wait_socket() { # ≤ $1 s for the player socket + hello
    local i
    for ((i = 0; i < $1 * 10; i++)); do
        [[ -S $RT/liascape/liascape-player.sock ]] && ctl hello >/dev/null 2>&1 && return 0
        sleep 0.1
    done
    return 1
}
serve_up() { # a bare `serve` on the real session (or headless outputs: --headless); extra args go to serve
    serve_down
    local session=(WAYLAND_DISPLAY="$WL" HYPRLAND_INSTANCE_SIGNATURE="$HYPR_SIG") hl=()
    if [[ -n $HEADLESS ]]; then
        session=(-u WAYLAND_DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE)
        hl=(--headless --outputs "$HEADLESS")
    else
        others_mapped && die "another liascape-player surface is mapped (quit the owner's player, stop liascape-watch)"
    fi
    SERVE_N=$((${SERVE_N:-0} + 1))
    RT=$SCRATCH/run$SERVE_N
    PSTATE=$SCRATCH/state$SERVE_N
    PCACHE=$SCRATCH/cache
    if [[ -n $HEADLESS ]]; then mkdir -p -m 700 "$RT"; else link_hypr "$RT"; fi
    mkdir -p "$PSTATE" "$PCACHE"
    pw_start
    prlimit --core=1:1 env -u LD_LIBRARY_PATH -u PULSE_SERVER "${session[@]}" \
        XDG_RUNTIME_DIR="$RT" XDG_STATE_HOME="$PSTATE" XDG_CACHE_HOME="$PCACHE" PIPEWIRE_RUNTIME_DIR="$PW_DIR/run" \
        LIASCAPE_SCENE_WORKER_BIN="$WBIN" LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 \
        "$BIN" serve --log-level info "${hl[@]}" "$@" >>"$RESULTS/serve-$STEP.log" 2>&1 &
    SERVE_PID=$!
    wait_socket 15 || die "serve never answered (log $RESULTS/serve-$STEP.log)"
    PLAYER_PID=$(ctl hello | jq -r .pid)
    say "serve up: supervisor $SERVE_PID, compositor $PLAYER_PID, caps $(ctl hello | jq -c .capabilities)"
    bus_on_private
}
bus_on_private() {
    local b
    for _ in $(seq 50); do b=$(ctl probe '{"name":"bus"}' 2>/dev/null); [[ $(jq -r .state <<<"$b") == up ]] && break; sleep 0.1; done
    [[ $(jq -r .default_sink <<<"$b") == hermetic-sink ]] || die "the bus is not on the private PipeWire: $(jq -c '{state, default_sink}' <<<"$b")"
}
serve_down() {
    [[ -n $SERVE_PID ]] || return 0
    if kill -0 "$SERVE_PID" 2>/dev/null; then
        ctl quit >/dev/null 2>&1
        for _ in $(seq 80); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
        kill -TERM "$SERVE_PID" 2>/dev/null && sleep 1
        kill -KILL "$SERVE_PID" 2>/dev/null
    fi
    wait "$SERVE_PID" 2>/dev/null
    SERVE_PID=
    PLAYER_PID=
}

# ------------------------------------------------------------------ the private backend ("the app")
BE=$SCRATCH/be
BE_PID=
API=
BE_ENV=()
be_env() {
    RT=$BE/rt
    PSTATE=$BE/st
    PCACHE=$BE/home/.cache
    BE_ENV=(-u LD_LIBRARY_PATH -u PULSE_SERVER -u LIASCAPE_PORT -u LIASCAPE_PLAYER_SOCKET -u LIASCAPE_UI_DIR
        HOME="$BE/home" XDG_CONFIG_HOME="$BE/home/.config" XDG_CACHE_HOME="$PCACHE" XDG_DATA_HOME="$BE/home/.local/share"
        XDG_RUNTIME_DIR="$RT" XDG_STATE_HOME="$PSTATE" PIPEWIRE_RUNTIME_DIR="$PW_DIR/run"
        WAYLAND_DISPLAY="$WL" HYPRLAND_INSTANCE_SIGNATURE="$HYPR_SIG" XDG_SESSION_TYPE=wayland
        LIASCAPE_PLAYER_BIN="$BIN" LIASCAPE_SCENE_WORKER_BIN="$WBIN" LIASCAPE_TRANSITIONS_DIR="$REPO/transitions"
        LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 DOTNET_ROOT="$DOTNET_ROOT_" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1)
}
be_settings_init() { # the private settings.json — deliberately WITHOUT PauseWhenCovered (O1: the default must apply)
    local f=$BE/home/.config/liascape/settings.json
    [[ -s $f ]] && return 0
    mkdir -p "$(dirname "$f")"
    cat >"$f" <<'EOF'
{"PlayerEngine":"liascape-player","NoAudio":false,"Loop":true,"Volume":80,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["fade"],"GlobalTransitionDurationMs":1000,"TransitionMethod":"full-live",
 "GlobalSwitchWhenVideoEnds":false,"GlobalIntervalSeconds":1800,"AutoMute":false}
EOF
}
be_up() {
    [[ -n $DOTNET && -f $DLL ]] || die "the backend needs dotnet (DOTNET=…) and $DLL (dotnet build src/backend)"
    be_down
    serve_down
    be_env
    mkdir -p "$BE/home/.cache" "$BE/home/.local/share" "$PSTATE"
    link_hypr "$RT"
    be_settings_init
    pw_start
    local pf=$BE/home/.config/liascape/serve.port
    echo 0 >"$pf"
    prlimit --core=1:1 env "${BE_ENV[@]}" "$DOTNET" "$DLL" serve >>"$RESULTS/backend-$STEP.log" 2>&1 &
    BE_PID=$!
    local i
    for ((i = 0; i < 300; i++)); do
        [[ -s $pf && $(cat "$pf") != 0 ]] && break
        kill -0 "$BE_PID" 2>/dev/null || die "the private backend exited (log $RESULTS/backend-$STEP.log)"
        sleep 0.1
    done
    API=http://127.0.0.1:$(cat "$pf")
    for ((i = 0; i < 100; i++)); do curl -sf -m 2 "$API/health" >/dev/null && break; sleep 0.1; done
    [[ $(curl -sf -m 5 "$API/player-engine" | jq -r .active) == liascape-player ]] || die "the private backend is not on liascape-player"
    say "private backend up: pid $BE_PID, $API"
}
be_down() { # "the app closes": TERM, as the shell's quit does
    [[ -n $BE_PID ]] || return 0
    kill -TERM "$BE_PID" 2>/dev/null
    for _ in $(seq 150); do kill -0 "$BE_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$BE_PID" 2>/dev/null
    wait "$BE_PID" 2>/dev/null
    BE_PID=
    # a keybind CLI must never forward to a port some other process reuses (the IT's rule)
    echo 0 >"$BE/home/.config/liascape/serve.port"
}
be_cli() { env "${BE_ENV[@]}" "$DOTNET" "$DLL" "$@" >>"$RESULTS/cli-$STEP.log" 2>&1; }
be_procs() { # pids of THIS run's backend (serve or CLI): /proc cmdline holds our DLL, environ our private HOME
    local p
    for p in /proc/[0-9]*; do
        tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -qF "$DLL" || continue
        tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -qxF "HOME=$BE/home" && echo "${p#/proc/}"
    done
}
legacy_daemons() { # a timer-daemon / restart-daemon of this run (never expected)
    local p
    for p in $(be_procs); do tr '\0' ' ' <"/proc/$p/cmdline" | grep -qE 'timer-daemon|restart-daemon' && echo "$p"; done
}
bpost() { curl -sf -m 30 -X POST -H 'Content-Type: application/json' -d "$2" "$API$1"; }
bget() { curl -sf -m 10 "$API$1"; }
be_setting() { # <key> <json value> — GET → set one key → POST the whole object (never printed)
    local s
    s=$(bget /settings) || return 1
    bpost /settings "$(jq -c --arg k "$1" --argjson v "$2" '.[$k] = $v' <<<"$s")" >/dev/null
}
the_player_pid() { # the compositor of the player on $RT, once it answers (≤ 20 s)
    wait_socket 20 || return 1
    PLAYER_PID=$(ctl hello | jq -r .pid)
}
quit_player() { # ctl quit, then wait for the supervisor (hello.supervisor_pid) to be gone
    local sp
    sp=$(ctl hello 2>/dev/null | jq -r '.supervisor_pid // empty')
    ctl quit >/dev/null 2>&1
    if [[ -n $sp ]]; then
        for _ in $(seq 100); do kill -0 "$sp" 2>/dev/null || break; sleep 0.1; done
        kill -0 "$sp" 2>/dev/null && { kill -TERM "$sp"; sleep 2; }
    fi
    PLAYER_PID=
}

# ------------------------------------------------------------------ media
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
mk_png() { # <name> <ffmpeg src>
    local f=$MEDIA/$1.png
    [[ -s $f ]] || ffmpeg -nostdin -v error -y -f lavfi -i "$2" -frames:v 1 "$f" || die "ffmpeg $1"
    echo "$f"
}
for d in "$SC_EMILIA" "$SC_KIMI" "$SC_BUNK"; do [[ -f $d/project.json ]] || die "missing SFW scene $d"; done

# ------------------------------------------------------------------ player helpers
prog() { ctl state | jq -c '.programs[0] // empty'; }
pget() { ctl get "{\"path\":\"prog:main.$1\"}" | jq -c .value; }
cur() { ctl get "{\"path\":\"cur:$1.$2\"}" 2>/dev/null | jq -r '.value // empty'; }
frames() { ctl probe '{"name":"frames"}'; }
reset_frames() { ctl probe '{"name":"frames","args":{"reset":true}}' >/dev/null; }
wall_iso() { date -u +%Y-%m-%dT%H:%M:%S.%NZ; }
cpu_pct() { # <pid> <seconds> → % of one core (all threads)
    local pid=$1 s=$2 a b hz
    hz=$(getconf CLK_TCK)
    a=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null) || { echo nan; return; }
    sleep "$s"
    b=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null) || { echo nan; return; }
    python3 -c "print(f'{($b-$a)/$hz/$s*100:.2f}')"
}
gpu_sm() { # <pid> <samples> → mean SM % of that process (nvidia-smi pmon, 1 s samples; "-" = 0)
    nvidia-smi pmon -s u -c "$2" 2>/dev/null | awk -v p="$1" '$2 == p { v = ($4 == "-" ? 0 : $4); s += v; n++ } END { if (n) printf "%.1f", s / n; else print "nan" }'
}
smi_vram() { # → {"<pid>": MiB, …} for every GPU process (graphics included)
    nvidia-smi -q -d PIDS 2>/dev/null | python3 -c '
import sys, json, re
out = {}; pid = None
for line in sys.stdin:
    m = re.search(r"Process ID\s*:\s*(\d+)", line)
    if m: pid = m.group(1)
    m = re.search(r"Used GPU Memory\s*:\s*(\d+)\s*MiB", line)
    if m and pid: out[pid] = int(m.group(1)); pid = None
print(json.dumps(out))'
}
wait_prog() { # <jq predicate on .programs[0]> <timeout s>
    local i
    for ((i = 0; i < $2 * 5; i++)); do
        prog | jq -e "$1" >/dev/null 2>&1 && return 0
        sleep 0.2
    done
    return 1
}
count_since() { # <kind> <iso wall> [jq extra predicate] → count in the ring
    ctl logs "{\"kind_prefix\":\"$1\",\"limit\":10000}" | jq --arg t "$2" "[.events[] | select(.kind == \"$1\" and .t_wall >= \$t) ${3:+| select($3)}] | length"
}
wait_count() { # <kind> <iso wall> <n> <timeout s> [jq predicate]
    local i
    for ((i = 0; i < $4 * 2; i++)); do
        (($(count_since "$1" "$2" "${5:-}") >= $3)) && return 0
        sleep 0.5
    done
    return 1
}
source_paused_frozen() { # every live source effective_paused and its time_pos still over 1 s → true/false
    local a b
    a=$(ctl probe '{"name":"sources"}' | jq -c '[(.sources // .)[] | {id, ep: .effective_paused, t: .time_pos}]')
    sleep 1
    b=$(ctl probe '{"name":"sources"}' | jq -c '[(.sources // .)[] | {id, ep: .effective_paused, t: .time_pos}]')
    jq -n --argjson a "$a" --argjson b "$b" '($a | length) > 0 and ([$a[].ep] | all) and ([$b[].ep] | all) and
        ([$a[] | . as $x | ($b[] | select(.id == $x.id) | .t) == $x.t] | all)'
}
source_playing() { # the shown source's time_pos advances over 1 s and it is not effective_paused → true/false
    local id a b
    id=$(ctl get "{\"path\":\"lay:$OUT_B:main.content\"}" | jq -r .value)
    a=$(ctl get "{\"path\":\"$id.time_pos\"}" | jq -r .value)
    sleep 1
    b=$(ctl get "{\"path\":\"$id.time_pos\"}" | jq -r .value)
    jq -n --argjson ep "$(ctl probe '{"name":"sources"}' | jq --arg id "$id" '[(.sources // .)[] | select(.id == $id) | .effective_paused][0] | if . == null then true else . end')" \
        --arg a "$a" --arg b "$b" '($ep | not) and ($a != $b) and ($a != "null")'
}

# ------------------------------------------------------------------ windows (step 4) and monitors (step 4b)
COVER_PIDS=()
open_window() { # <class> <workspace> <kitty-fs|kitty-max|mpv-fs> → waits until mapped in that state; echoes its pid
    local cls=$1 ws=$2 how=$3 cmd want i c
    case $how in
        kitty-fs) cmd="kitty --class $cls --start-as=fullscreen -o confirm_os_window_close=0 sh -c 'sleep 900'"; want=2 ;;
        kitty-max) cmd="kitty --class $cls --start-as=maximized -o confirm_os_window_close=0 sh -c 'sleep 900'"; want=1 ;;
        mpv-fs) cmd="env -u LD_LIBRARY_PATH mpv --fs --no-audio --loop-file=inf --really-quiet --wayland-app-id=$cls $COVER_CLIP"; want=2 ;;
    esac
    hyprctl dispatch "hl.dsp.exec_cmd(\"${cmd//\"/\\\"}\", { workspace = \"$ws silent\" })" >/dev/null
    for ((i = 0; i < 200; i++)); do
        c=$(hyprctl clients -j | jq -c --arg c "$cls" '[.[] | select(.class == $c)][0] // empty')
        [[ -n $c && $(jq -r .fullscreen <<<"$c") == "$want" && $(jq -r .mapped <<<"$c") == true ]] && break
        sleep 0.025
    done
    [[ -n $c ]] || { say "window $cls never mapped"; return 1; }
    COVER_PIDS+=("$(jq -r .pid <<<"$c")")
    jq -r .pid <<<"$c"
}
close_windows() {
    local p
    for p in "${COVER_PIDS[@]}"; do kill -TERM "$p" 2>/dev/null; done
    for p in "${COVER_PIDS[@]}"; do for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.05; done; done
    COVER_PIDS=()
    for _ in $(seq 60); do
        hyprctl clients -j | jq -e '[.[] | select(.class | startswith("lia-cov"))] | length == 0' >/dev/null && return 0
        sleep 0.05
    done
}
# The owner's monitor lines (~/.config/hypr/Kryxzort/System.lua), by serial; checked against the file at start.
MON_PRIMARY_DESC="BNQ ZOWIE XL LCD EBV4L02353SL0"   # DP-2, 240 Hz, 0x0
MON_SECONDARY_DESC="BNQ ZOWIE XL LCD EB99K03982SL0" # DP-1, 144 Hz, -1920x0
MON_ON_PRIMARY="hl.monitor({ output = \"desc:$MON_PRIMARY_DESC\", mode = \"1920x1080@240\", position = \"0x0\", scale = 1, vrr = 2, disabled = false })"
MON_ON_SECONDARY="hl.monitor({ output = \"desc:$MON_SECONDARY_DESC\", mode = \"1920x1080@144\", position = \"-1920x0\", scale = 1, disabled = false })"
MON_FLAG=$SCRATCH/monitors-off
WD_PID=
mon_desc() { [[ $1 == DP-2 ]] && echo "$MON_PRIMARY_DESC" || echo "$MON_SECONDARY_DESC"; }
mon_disable() { hyprctl eval "hl.monitor({ output = \"desc:$(mon_desc "$1")\", disabled = true })" >/dev/null; }
mon_enable_all() {
    hyprctl eval "$MON_ON_PRIMARY" >/dev/null
    hyprctl eval "$MON_ON_SECONDARY" >/dev/null
    local i
    for ((i = 0; i < 100; i++)); do
        hyprctl monitors -j | jq -e '[.[] | select(.name == "DP-1" or .name == "DP-2")] | length == 2' >/dev/null && return 0
        sleep 0.1
    done
    say "monitors not back after the eval — hyprctl reload"
    hyprctl reload >/dev/null
    sleep 3
    hyprctl eval "$MON_ON_PRIMARY" >/dev/null; hyprctl eval "$MON_ON_SECONDARY" >/dev/null
}
mon_state() { hyprctl monitors -j | jq -c '[.[] | {name, width, height, refreshRate, x, y, scale, transform, disabled, currentFormat}] | sort_by(.name)'; }
ws_state() { hyprctl workspaces -j | jq -c '[.[] | {id, monitor}] | sort_by(.id)'; }
watchdog_start() { # a detached process: monitors back if this script dies or the flag's deadline passes
    cat >"$SCRATCH/watchdog.sh" <<EOF
#!/usr/bin/env bash
flag=$MON_FLAG; parent=$$
while [[ -e \$flag ]]; do
    dl=\$(cat "\$flag" 2>/dev/null || echo 0)
    if ! kill -0 \$parent 2>/dev/null || (( \$(date +%s) > \${dl:-0} )); then
        echo "\$(date) restoring monitors (parent alive: \$(kill -0 \$parent 2>/dev/null && echo yes || echo no), deadline \$dl)"
        hyprctl eval '$MON_ON_PRIMARY'; hyprctl eval '$MON_ON_SECONDARY'
        sleep 3
        hyprctl monitors -j | jq -e '[.[] | select(.name == "DP-1" or .name == "DP-2")] | length == 2' >/dev/null || {
            echo "still missing → reload"; hyprctl reload; sleep 3
            hyprctl eval '$MON_ON_PRIMARY'; hyprctl eval '$MON_ON_SECONDARY'; }
        hyprctl monitors -j | jq -c '[.[] | .name]'
        rm -f "\$flag"
        exit 0
    fi
    sleep 1
done
EOF
    setsid nohup bash "$SCRATCH/watchdog.sh" >>"$RESULTS/watchdog.log" 2>&1 </dev/null &
    WD_PID=$!
}
mon_flag() { echo $(($(date +%s) + $1)) >"$MON_FLAG"; } # arm the watchdog: monitors back within $1 s at the latest

CURSOR=
FOCUS=
save_cursor() {
    CURSOR=$(hyprctl cursorpos -j 2>/dev/null)
    FOCUS=$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')
}
restore_cursor() {
    [[ -n $CURSOR ]] || return 0
    local f
    f=$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')
    [[ -n $FOCUS && $f != "$FOCUS" ]] && hyprctl eval "hl.dispatch(hl.dsp.focus({ monitor = \"$FOCUS\" }))" >/dev/null
    hyprctl eval "hl.dispatch(hl.dsp.cursor.move({ x = $(jq -r .x <<<"$CURSOR"), y = $(jq -r .y <<<"$CURSOR") }))" >/dev/null
}

cleanup() {
    local rc=$?
    close_windows
    if [[ -e $MON_FLAG ]]; then
        say "cleanup: monitors were off — re-enabling"
        mon_enable_all
        rm -f "$MON_FLAG"
    fi
    restore_cursor
    be_down
    if [[ -n $RT && -S $RT/liascape/liascape-player.sock ]]; then quit_player; fi
    serve_down
    pw_stop
    others_mapped && say "WARNING: a liascape-player layer surface is still mapped"
    say "results: $RESULTS"
    command -v trash >/dev/null && trash "$SCRATCH" 2>/dev/null
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

. "$HERE/programs_steps.sh"

for s in "${STEPS[@]}"; do
    "step_$s"
done
jq -s '{steps: ., pass: ([.[].pass] | all)}' "$RESULTS"/{dropout,appclosed,crash,cover,nomonitor,soak}.json 2>/dev/null >"$RESULTS/summary.json"
say "summary: $(jq -c '[.steps[] | {step, pass}]' "$RESULTS/summary.json")"
