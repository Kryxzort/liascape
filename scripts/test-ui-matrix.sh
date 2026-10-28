#!/usr/bin/env bash
# UI × player-state matrix (PlayerEngine=liascape-player): every playback-relevant UI control (and every
# `--action=` keybind) exercised in every player state — idle, playing, playlist, an effect running,
# an align:end switch pending, paused, paused mid-effect, no output, muted — through the REAL UI
# (headless Electron clicking the built bundle), checking after each step what every live source of
# the player actually runs. Driver + oracle: app/shell/probe-matrix.js.
#
# Hermetic like scripts/test-liascape-player-adapter.sh: its own temp HOME / XDG_* dirs (own settings.json,
# library, liascape-player socket + event log), its own backend port, a private `liascape-player serve --headless
# --clock real --ao null`, the UI built into the temp dir and served by that backend (LIASCAPE_UI_DIR), and a
# private PulseAudio (its own socket, one null sink, no device) that the backend's auto-mute watches and
# the auto-mute cells play synthetic streams into. It never touches the dev backend, the real library,
# the real player or the session's audio server; everything it started is stopped and the temp dir
# removed on every exit path.
#
# Usage: scripts/test-ui-matrix.sh [--no-build] [--only <regex over cell names>] [--ui-dir <built UI>]
#                                  [--jobs N] [--probe <app/shell script>]  (default probe-matrix.js;
#                                  probe-morph.js = the settings-modal morph probe, same hermetic stack)
#                                  [--changed [<rev>]]
#   --changed: only the cells the change can affect (scripts/matrix-cells-for.sh maps changed files → cells;
#   no rev = the uncommitted change, <rev> = everything since it). Central files mean the full matrix, docs
#   and areas the matrix doesn't cover mean none. Use it before a commit; the full run is the merge gate.
#   --ui-dir: drive an already-built UI bundle instead of building this tree's (e.g. an older commit's,
#   to show a UI-side fix RED)
#   --jobs N (default 6, env LIASCAPE_MATRIX_JOBS): N complete hermetic stacks in parallel, each running every
#   N-th cell (`--shard i/N`, internal); builds once, merges <out>/cells.jsonl (each shard keeps its own
#   dir <out>/shard-i/ + log <out>/shard-i.log), prints the combined MATRIX line. --jobs 1 = one stack,
#   the cells in order (the original single run). A probe other than probe-matrix.js always runs alone.
#   Each stack is a debug liascape-player + a backend + a software-rendered Electron (~0.8 GB). Measured on the
#   24-core / 31 GB dev box (~530 cells, 56 min of cell time): 4 → 14.5 min, 6 → 10 min (clean), 8 → 8.3 min
#   but 13 cells timed out entering their state (all passed alone). 4+ stacks make the desktop laggy:
#   use --jobs 2 + LIASCAPE_MATRIX_NICE=1 next to someone working.
#   Memory guard: N is capped so each stack has ~1 GiB above LIASCAPE_MATRIX_MIN_FREE_MB (default 3072) of
#   MemAvailable, and the run is stopped (exit 3) if MemAvailable falls under that floor — a test run must
#   never be what makes earlyoom kill the desktop's apps.
#
# Fuzz: scripts/test-ui-matrix.sh --fuzz <steps> [--seed <n>] [--fuzz-runs <k>] [--jobs N]
#        scripts/test-ui-matrix.sh --fuzz-replay '<state>:<c1>,<c2>,…'
#   Random CHAINS of controls instead of one per cell (bugs keep turning up at combinations nobody listed): each of the
#   k runs (default 4) enters a random start state, applies <steps> controls picked at random from the ones eligible in
#   the state the stack is in NOW, and after every step runs the same checks a cell runs; a run stops at its first
#   failing step. Eligibility: the control's `states` must list the state DERIVED from what runs (its label — an
#   unrestricted control runs anywhere), minus probe-matrix.js's FUZZ_RULES: excluded (race:*, plState:partial,
#   apply:broken, autoMute*, shuffle:*, set:normalizeFresh — backend-only stress, a failure on purpose, special setup),
#   last-step-only (trash without undo, plShuffle, the 4–8 s interval changers, the -keep / volume-key-mode variants —
#   what they leave, the later controls' expectations can't follow), or gated on the starting value their drive/check
#   assumes. Expectations (paused / muted) carry across steps through every control's exp / flipPause / flipMute.
#   A step also waits for the page's requests and a queued keybind (pending_action.txt) — one never taken FAILs — and
#   lets an advance-on-end switch that fired on its own land (its control's own check is then skipped: "rotated").
#   --seed: the PRNG seed (default: random, printed); a run's picks depend only on (seed, run index), not on --jobs.
#   A failure prints the seed, the run index, the exact sequence (`state → c1 → c2 …`) and a --fuzz-replay command that
#   reruns exactly that sequence on one stack. --jobs defaults to 2 here (LIASCAPE_FUZZ_JOBS), capped at the run count.
#   Results: <out>/fuzz.jsonl, one record per run (seed, run, start, sequence, replay, per-step phases + violations).
# LIASCAPE_MATRIX_SCREEN=<w>x<h> (default 1400x900): the private Xvfb's screen size (a probe that measures at the owner's 1080p).
# LIASCAPE_MATRIX_NICE=1: run at the lowest CPU + I/O priority (nice 19, ionice idle — everything it starts
# inherits it); off by default — a starved stack makes the timing-sensitive cells flaky.
# Needs: dotnet (DOTNET=…), ffmpeg, jq, curl, node, an Electron (ELECTRON=…, default: the nix store's
# electron-42); pulseaudio (PULSEAUDIO=…) + pactl / paplay / parec for the auto-mute cells (they SKIP
# without). Exit 0 = every cell passed. Results: $LIASCAPE_MATRIX_OUT (default: a dir printed at the end).
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)  # physical path: a symlinked alias (/home → /mnt/…) makes MSBuild delete its own outputs
if [ "${LIASCAPE_MATRIX_NICE:-0}" = 1 ]; then renice -n 19 -p $$ >/dev/null 2>&1; ionice -c3 -p $$ >/dev/null 2>&1; fi
BUILD=1; ONLY=""; UIDIR=""; JOBS=${LIASCAPE_MATRIX_JOBS:-6}; SHARD=""; PROBE=""; CHANGED=""
FUZZ=""; FSEED=""; FRUNS=""; FREPLAY=""; JOBS_SET=""
while [ $# -gt 0 ]; do
  case "$1" in --no-build) BUILD=0 ;; --only) ONLY=$2; shift ;; --ui-dir) UIDIR=$(cd "$2" && pwd); shift ;; --probe) PROBE=$2; shift ;;
    --jobs) JOBS=$2; JOBS_SET=1; shift ;; --shard) SHARD=$2; shift ;;
    --changed) CHANGED=HEAD; if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then CHANGED=$2; shift; fi ;;
    --fuzz) FUZZ=$2; shift ;; --seed) FSEED=$2; shift ;; --fuzz-runs) FRUNS=$2; shift ;; --fuzz-replay) FREPLAY=$2; shift ;;
    *) echo "unknown arg $1"; exit 2 ;; esac; shift
done
num() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }
if [ -n "$FUZZ$FREPLAY" ]; then
  [ -n "$ONLY$CHANGED$PROBE" ] && { echo "--fuzz / --fuzz-replay don't combine with --only / --changed / --probe"; exit 2; }
  [ -n "$FUZZ" ] && [ -n "$FREPLAY" ] && { echo "--fuzz and --fuzz-replay don't combine"; exit 2; }
  if [ -n "$FUZZ" ]; then
    num "$FUZZ" && [ "$FUZZ" -gt 0 ] || { echo "--fuzz wants a positive number of steps"; exit 2; }
    FRUNS=${FRUNS:-4}; num "$FRUNS" && [ "$FRUNS" -gt 0 ] || { echo "--fuzz-runs wants a positive number"; exit 2; }
    FSEED=${FSEED:-$(( (RANDOM << 15) | RANDOM ))}; num "$FSEED" || { echo "--seed wants a non-negative integer"; exit 2; }
    [ -z "$JOBS_SET" ] && JOBS=${LIASCAPE_FUZZ_JOBS:-2}
    num "$JOBS" && [ "$JOBS" -gt "$FRUNS" ] && JOBS=$FRUNS
  else JOBS=1; fi # a replay is one run on one stack
elif [ -n "$FSEED$FRUNS" ]; then echo "--seed / --fuzz-runs go with --fuzz"; exit 2; fi
FARGS=(); [ -n "$FUZZ" ] && FARGS=(--fuzz "$FUZZ" --seed "$FSEED" --fuzz-runs "$FRUNS")
MODE=MATRIX; [ -n "$FUZZ$FREPLAY" ] && MODE=FUZZ
# --changed [<rev>]: only the cells the change can affect (scripts/matrix-cells-for.sh — the uncommitted change,
# or everything since <rev>); FULL when it touches something central, nothing when the matrix covers none of it
if [ -n "$CHANGED" ] && [ -z "$SHARD" ]; then
  [ -n "$ONLY" ] && { echo "--changed and --only don't combine"; exit 2; }
  echo "== cells for the change (${CHANGED/HEAD/uncommitted}):"
  sel=$(bash "$ROOT/scripts/matrix-cells-for.sh" $([ "$CHANGED" = HEAD ] || echo "$CHANGED")) || exit 2
  case "$sel" in
    NONE) echo "== the matrix covers nothing in this change — skipped"; exit 0 ;;
    FULL) echo "== → the full matrix" ;;
    *) ONLY=$sel; echo "== → --only '$ONLY'" ;;
  esac
fi
case "$JOBS" in ''|*[!0-9]*|0) echo "--jobs wants a positive number"; exit 2 ;; esac
[ -n "$PROBE" ] && [ "$PROBE" != probe-matrix.js ] && JOBS=1
SELF=$ROOT/scripts/$(basename "${BASH_SOURCE[0]}")
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
B=$ROOT/src/player/target/debug/liascape-player
DLL=${LIASCAPE_MATRIX_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll} # LIASCAPE_MATRIX_DLL: another backend build (an older commit's — a fix RED)

if [ $BUILD = 1 ]; then
  echo "== build"
  (cd "$ROOT" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { echo "cargo build failed"; exit 2; }
  "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -x "$B" ] && [ -f "$DLL" ] || { echo "not built: $B / $DLL (drop --no-build)"; exit 2; }
[ -x "${B%/*}/liascape-scene-worker" ] || { echo "not built: ${B%/*}/liascape-scene-worker (drop --no-build)"; exit 2; }

# Run the backend from a private copy of its build: the owner's `dotnet watch` rebuilds the same
# bin/Debug whenever a build here touches obj/, and mid-rebuild liascape-backend.runtimeconfig.json is briefly
# missing — stacks started then died ("backend didn't start": libhostpolicy.so … runtimeconfig.json not
# found; 2 of 6 matrix shards once). Copied whole, retried until the DLL didn't change during the copy.
snapshot_backend() {   # $1 = destination dir → prints the copied DLL's path
  local src; src=$(dirname "$DLL")
  for _ in $(seq 1 60); do
    if [ -f "$src/liascape-backend.runtimeconfig.json" ] && [ -f "$DLL" ]; then
      local m0; m0=$(stat -c %Y.%s "$DLL")
      mkdir -p "$1" && cp -a "$src/." "$1/" 2>/dev/null
      [ -f "$1/liascape-backend.runtimeconfig.json" ] && [ -f "$1/liascape-backend.dll" ] && [ "$(stat -c %Y.%s "$DLL")" = "$m0" ] \
        && { echo "$1/liascape-backend.dll"; return 0; }
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------- --jobs N: N shards in parallel
if [ -z "$SHARD" ] && [ "$JOBS" -gt 1 ]; then
  P=$(mktemp -d /tmp/liascape-mx-XXXXXX)
  OUTROOT=${LIASCAPE_MATRIX_OUT:-$P/out}
  mkdir -p "$OUTROOT"
  if [ -z "$UIDIR" ]; then
    echo "== UI bundle"
    (cd "$ROOT/app/ui" && node node_modules/vite/bin/vite.js build --outDir "$P/ui" --emptyOutDir --logLevel error) || { echo "vite build failed"; exit 2; }
    UIDIR=$P/ui
  fi
  PIDS=()
  pcleanup() {
    trap - EXIT INT TERM HUP
    # each shard runs in its own session (setsid): its whole tree — Electron, Xvfb, backend, player — goes
    for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && kill -TERM -- "-$pid" 2>/dev/null; done
    for pid in "${PIDS[@]}"; do for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; kill -KILL -- "-$pid" 2>/dev/null; done
    if [ -z "${LIASCAPE_MATRIX_OUT:-}" ] && [ -d "$OUTROOT" ]; then
      [ -e /tmp/liascape-mx-last ] && trash /tmp/liascape-mx-last 2>/dev/null
      cp -r "$OUTROOT" /tmp/liascape-mx-last && echo "results kept in /tmp/liascape-mx-last"
    fi
    case "$P" in /tmp/liascape-mx-*) if command -v trash >/dev/null; then trash "$P" 2>/dev/null; else rm -rf -- "$P"; fi ;; esac
  }
  trap pcleanup EXIT
  trap 'exit 130' INT TERM HUP
  # one snapshot for every shard (they inherit LIASCAPE_MATRIX_DLL and skip their own)
  DLL=$(snapshot_backend "$P/backend") || { echo "ABORT: no complete backend build to snapshot ($(dirname "$DLL"))"; exit 2; }
  export LIASCAPE_MATRIX_DLL=$DLL LIASCAPE_MATRIX_SNAPPED=1
  T0=$(date +%s)
  MINFREE=${LIASCAPE_MATRIX_MIN_FREE_MB:-3072}
  memavail() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }
  fit=$(( ($(memavail) - MINFREE) / 1024 )); [ "$fit" -lt 1 ] && fit=1
  [ "$JOBS" -gt "$fit" ] && { echo "== only $(memavail) MiB available: $fit shard(s), not $JOBS"; JOBS=$fit; }
  if [ $MODE = FUZZ ]; then echo "== fuzz: $FRUNS runs × $FUZZ steps, seed $FSEED, $JOBS shards"; else echo "== matrix: $JOBS shards"; fi
  for i in $(seq 0 $((JOBS - 1))); do
    LIASCAPE_MATRIX_OUT=$OUTROOT/shard-$i setsid "$SELF" --no-build --ui-dir "$UIDIR" --shard "$i/$JOBS" ${ONLY:+--only "$ONLY"} "${FARGS[@]}" \
      </dev/null >"$OUTROOT/shard-$i.log" 2>&1 &
    PIDS+=($!)
    sleep 2 # stagger the start-up spikes (ffmpeg clips, the backend's JIT, Electron)
  done
  # live: every shard's lines as they land, prefixed with its number
  SEEN=(); for i in $(seq 0 $((JOBS - 1))); do SEEN[$i]=0; done
  flush() {
    for i in $(seq 0 $((JOBS - 1))); do
      local n; n=$(wc -l <"$OUTROOT/shard-$i.log" 2>/dev/null || echo 0)
      [ "$n" -gt "${SEEN[$i]}" ] && sed -n "$((SEEN[$i] + 1)),${n}p" "$OUTROOT/shard-$i.log" | sed "s|^|[$i] |"
      SEEN[$i]=$n
    done
  }
  while :; do
    alive=0; for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    if [ "$(memavail)" -lt "$MINFREE" ]; then echo "ABORT: only $(memavail) MiB available (floor $MINFREE) — stopping every shard"; exit 3; fi
    flush; [ $alive = 0 ] && break; sleep 3
  done
  rcs=""; for i in $(seq 0 $((JOBS - 1))); do wait "${PIDS[$i]}"; rcs="$rcs $?"; done
  if [ $MODE = FUZZ ]; then
    cat "$OUTROOT"/shard-*/fuzz.jsonl >"$OUTROOT/fuzz.jsonl" 2>/dev/null
    echo "== fuzz failures (all shards; seed $FSEED)"
    jq -r --arg q "'" 'select(.result != "PASS") | (if .failedAt != null then .steps[.failedAt] else null end) as $f
      | "\(.result) run \(.run) (seed \(.seed)): \([.start] + .sequence | join(" → "))"
        + (if $f then "\n        at step \(.failedAt + 1): [\($f.state)] \($f.control)" else "" end)
        + ((($f.violations // .violations) // []) | map("\n        - " + .) | join(""))
        + (if .replay then "\n        replay: scripts/test-ui-matrix.sh --fuzz-replay \($q)\(.replay)\($q)" else "" end)' "$OUTROOT/fuzz.jsonl"
    crashed=0
    for i in $(seq 0 $((JOBS - 1))); do
      grep -q '^FUZZ ' "$OUTROOT/shard-$i.log" || { crashed=$((crashed + 1)); echo "shard $i/$JOBS ended without a summary:"; tail -n 8 "$OUTROOT/shard-$i.log" | sed 's/^/     /'; }
    done
    n() { jq -s --arg r "$1" 'map(select(.result == $r)) | length' "$OUTROOT/fuzz.jsonl"; }
    echo "== done in $(( ($(date +%s) - T0) / 60 ))m$(( ($(date +%s) - T0) % 60 ))s ($JOBS shards, exit codes:$rcs)"
    pass=$(n PASS); fail=$(n FAIL); err=$(n ERROR); setup=$(n SETUP)
    steps=$(jq -s 'map(.steps | length) | add // 0' "$OUTROOT/fuzz.jsonl")
    echo "FUZZ runs=$((pass + fail + err + setup)) pass=$pass fail=$fail error=$((err + crashed)) setup=$setup steps=$steps seed=$FSEED"
    [ $((fail + err + setup + crashed)) = 0 ] && [ -z "$(echo $rcs | tr -d ' 0')" ]
    exit $?
  fi
  cat "$OUTROOT"/shard-*/cells.jsonl >"$OUTROOT/cells.jsonl" 2>/dev/null
  echo "== failures (all shards)"
  jq -r 'select(.result != "PASS" and .result != "SKIP") | "\(.result) \(.state) × \(.control)" + ((.violations // []) | map("\n        - " + .) | join(""))' "$OUTROOT/cells.jsonl"
  crashed=0
  for i in $(seq 0 $((JOBS - 1))); do
    grep -q '^MATRIX ' "$OUTROOT/shard-$i.log" || { crashed=$((crashed + 1)); echo "shard $i/$JOBS ended without a summary:"; tail -n 8 "$OUTROOT/shard-$i.log" | sed 's/^/     /'; }
  done
  n() { jq -s --arg r "$1" 'map(select(.result == $r)) | length' "$OUTROOT/cells.jsonl"; }
  echo "== done in $(( ($(date +%s) - T0) / 60 ))m$(( ($(date +%s) - T0) % 60 ))s ($JOBS shards, exit codes:$rcs)"
  pass=$(n PASS); fail=$(n FAIL); err=$(n ERROR); skip=$(n SKIP); setup=$(n SETUP); known=$(n KNOWN)
  echo "MATRIX pass=$pass fail=$fail error=$((err + crashed)) skip=$skip setup=$setup known=$known"
  [ $((fail + err + setup + crashed)) = 0 ] && [ -z "$(echo $rcs | tr -d ' 0')" ]
  exit $?
fi

T=$(mktemp -d /tmp/liascape-mx-XXXXXX)   # short: a unix socket path must be < 108 bytes
if [ -z "${LIASCAPE_MATRIX_SNAPPED:-}" ]; then
  DLL=$(snapshot_backend "$T/backend") || { echo "ABORT: no complete backend build to snapshot"; exit 2; }
fi
OUT=${LIASCAPE_MATRIX_OUT:-$T/out}
mkdir -p "$T/home/.config/liascape" "$T/home/.cache" "$T/home/.local/share" "$T/rt" "$T/st" "$OUT"
if [ -n "$UIDIR" ]; then
  [ -f "$UIDIR/index.html" ] || { echo "no index.html in $UIDIR"; exit 2; }
  cp -r "$UIDIR" "$T/ui"
else
  echo "== UI bundle"
  (cd "$ROOT/app/ui" && node node_modules/vite/bin/vite.js build --outDir "$T/ui" --emptyOutDir --logLevel error) || { echo "vite build failed"; exit 2; }
fi
export HOME=$T/home XDG_CONFIG_HOME=$T/home/.config XDG_CACHE_HOME=$T/home/.cache XDG_DATA_HOME=$T/home/.local/share
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LIASCAPE_PLAYER_BIN=$B LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions LIASCAPE_UI_DIR=$T/ui
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 LIASCAPE_TEST_ALIGN_BACKSTOP_SLACK_SEC=2
# Phase 2 scenes: the private player (and any the backend starts) plays synthetic scene folders with this build's worker,
# and measures VRAM through a fake probe the scene cells drive (healthy by default: 6000 of 8192 MiB free — the
# low-VRAM rule never engages; never this machine's GPU) with short holds (interval, enter, resume, settle, scene hold)
export LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 LIASCAPE_SCENE_WORKER_BIN=${B%/*}/liascape-scene-worker
export LIASCAPE_PLAYER_VRAM_PROBE=fake:$T/vram.json LIASCAPE_PLAYER_VRAM_TIMING=200,600,2000,300,600
printf '{"total_mib":8192,"free_mib":6000,"procs":{}}' > "$T/vram.json"
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_PORT
# audio: every pulse client of the stack (the backend's pactl/parec, the probe's paplay) resolves the PRIVATE server
# started below ($XDG_RUNTIME_DIR/pulse/native) — never the session's
unset PULSE_SERVER PULSE_SINK PULSE_SOURCE PULSE_COOKIE PULSE_CLIENTCONFIG PULSE_RUNTIME_PATH
SP=""; BP=""; XP=""; PA=""
cleanup() {
  trap - EXIT INT TERM HUP
  [ -n "$XP" ] && kill "$XP" 2>/dev/null
  [ -n "$PA" ] && kill "$PA" 2>/dev/null
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  # a backend the probe started in place of $BP (restore:scene restarts it) — only one whose HOME is this stack's
  if [ -s "$T/backend2.pid" ]; then
    b2=$(cat "$T/backend2.pid")
    if tr '\0' '\n' < "/proc/$b2/environ" 2>/dev/null | grep -qx "HOME=$T/home"; then
      kill "$b2" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$b2" 2>/dev/null || break; sleep 0.1; done; kill -9 "$b2" 2>/dev/null
    fi
  fi
  # a stopping backend hands a running timed playlist / restart timer / auto-mute to detached daemons (setsid: out of
  # this stack's process group) — one outlived its stack for 35 min, its HOME gone, writing timed_state.json relative
  # to the cwd. Stop them by their pid files, and only a pid whose HOME is this stack's.
  for f in timer restart monitor; do
    pf=$XDG_CONFIG_HOME/liascape/$f.pid; [ -s "$pf" ] || continue
    for dp in $(tr -c '0-9\n' ' ' < "$pf"); do
      tr '\0' '\n' < "/proc/$dp/environ" 2>/dev/null | grep -qx "HOME=$T/home" && kill "$dp" 2>/dev/null
    done
  done
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  if [ -z "${LIASCAPE_MATRIX_OUT:-}" ] && [ -d "$OUT" ]; then
    [ -e /tmp/liascape-mx-last ] && trash /tmp/liascape-mx-last 2>/dev/null
    cp -r "$OUT" /tmp/liascape-mx-last && echo "results kept in /tmp/liascape-mx-last"
  fi
  case "$T" in /tmp/liascape-mx-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

clip() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "$2=size=320x180:rate=30" -f lavfi -i "sine=frequency=$3:sample_rate=48000" \
           -t "$4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$1"; }
clip "$T/k1.mp4" testsrc2 330 30; clip "$T/k2.mp4" smptebars 440 30; clip "$T/k3.mp4" rgbtestsrc 550 30; clip "$T/k4.mp4" testsrc 660 10

cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"liascape-player","NoAudio":false,"Loop":true,"Volume":80,"Speed":1,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["fade"],"GlobalTransitionDurationMs":1200,"GlobalTransitionShuffle":false,
 "TransitionMethod":"full-live","GlobalAdvanceOnVideoEnd":false,"GlobalMaxPlaySeconds":0,
 "GlobalIntervalSeconds":600,"AutoMute":false,"AdvancedSettings":true,"RestartIntervalSeconds":0}
EOF

# A private PulseAudio for the auto-mute cells: its own socket under $XDG_RUNTIME_DIR/pulse, ONE null sink (mx_null),
# no device module, no D-Bus, no autospawn (client.conf) — the backend's AudioMonitor (pactl subscribe + parec) and
# the probe's synthetic streams only ever meet there; the owner's audio server, routing and streams are never seen.
# Missing pulseaudio/pactl/paplay/parec → the auto-mute cells SKIP.
mkdir -p "$T/home/.config/pulse"; printf 'autospawn = no\n' >"$T/home/.config/pulse/client.conf"
PULSEAUDIO=${PULSEAUDIO:-$(command -v pulseaudio || ls /nix/store/*-pulseaudio-*/bin/pulseaudio 2>/dev/null | head -1)}
LIASCAPE_PULSE=0
if [ -n "$PULSEAUDIO" ] && [ -x "$PULSEAUDIO" ] && command -v pactl >/dev/null && command -v paplay >/dev/null && command -v parec >/dev/null; then
  (unset DBUS_SESSION_BUS_ADDRESS; exec "$PULSEAUDIO" -n --daemonize=no --exit-idle-time=-1 --use-pid-file=no --disable-shm=yes \
     -L "module-native-protocol-unix auth-anonymous=1" -L "module-null-sink sink_name=mx_null" >"$T/pulse.log" 2>&1) & PA=$!
  for _ in $(seq 1 50); do pactl info >/dev/null 2>&1 && break; sleep 0.1; done
  if [ "$(pactl info 2>/dev/null | sed -n 's/^Server String: //p')" = "$XDG_RUNTIME_DIR/pulse/native" ]; then LIASCAPE_PULSE=1
  else echo "(no private PulseAudio — the auto-mute cells skip)"; tail -3 "$T/pulse.log"; kill "$PA" 2>/dev/null; PA=""; fi
else echo "(pulseaudio / pactl / paplay / parec not found — the auto-mute cells skip)"; fi

# Synthetic WE scenes in the private library (the adapter IT's mk_scene; the worker's synthetic renderer — gated by
# LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES): s1 red + 440 Hz, s2 blue + 660 Hz, s3 crashing 1.5 s after each start (→ broken
# after 3 restarts). Titled s1..s3 in the source's index (the cards' titles). Scene support stays OFF in the baseline
# (the library-stepping / random cells would land on them); the scene cells turn it on (probe-matrix.js).
SCENES=()
mk_scene() {   # $1 = item folder, $2 = liascape-synthetic.json, $3 = its preview's colour (a real-sized 320×180 still), $4 = user properties
  local props=${4:-}; [ -n "$props" ] || props='{}'
  mkdir -p "$1"
  printf '{"type":"scene","title":"%s","file":"scene.json","preview":"preview.png","general":{"properties":%s}}' "$(basename "$1")" "$props" > "$1/project.json"
  head -c 16 /dev/zero > "$1/scene.pkg"
  printf '%s' "$2" > "$1/liascape-synthetic.json"
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=$3:s=320x180" -frames:v 1 "$1/preview.png"
  SCENES+=("$1")
}
SLIB=$XDG_DATA_HOME/liascape/library/workshop
# s1's user properties (the sceneProp cells): `color` is the synthetic renderer's WE-encoded colour (red by default,
# like its rgb), `clock` a bool that `bars` depends on (`condition`)
S1_PROPS='{"color":{"order":0,"text":"ui_browse_properties_scheme_color","type":"color","value":"1 0 0"},"clock":{"order":1,"text":"Show clock","type":"bool","value":true},"bars":{"order":2,"text":"Bars","type":"slider","value":32,"min":16,"max":64,"fraction":false,"condition":"clock.value"}}'
mk_scene "$SLIB/900000001" '{"pattern":"solid","rgb":[255,0,0],"native":[640,360],"has_audio":true,"tone_hz":440}' red "$S1_PROPS"
mk_scene "$SLIB/900000002" '{"pattern":"solid","rgb":[0,0,255],"native":[640,360],"has_audio":true,"tone_hz":660}' blue
mk_scene "$SLIB/900000003" '{"pattern":"solid","rgb":[0,255,0],"native":[640,360],"crash_after_ms":1500}' green
printf '{"900000001":{"title":"s1","isScene":true,"workshopId":"900000001"},"900000002":{"title":"s2","isScene":true,"workshopId":"900000002"},"900000003":{"title":"s3","isScene":true,"workshopId":"900000003"}}' > "$SLIB/index.json"
SCENES_JSON=$(printf '%s\n' "${SCENES[@]}" | jq -R . | jq -sc .)

(cd /tmp && exec "$B" serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null > "$T/serve.log" 2>&1) & SP=$!
for _ in $(seq 1 50); do "$B" ctl --timeout-ms 500 hello >/dev/null 2>&1 && break; sleep 0.1; done
"$DOTNET" "$DLL" --serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "ABORT: backend didn't start"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
[ "$(curl -sf -m 5 "$U/player-engine" | jq -r .active)" = liascape-player ] || { echo "ABORT: backend not on liascape-player"; exit 1; }
post() { curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
CLIPS=$(for k in k1 k2 k3 k4; do post /library/import "{\"path\":\"$T/$k.mp4\",\"title\":\"$k\"}" | jq -c .videoPath; done | jq -sc .)
echo "library: $CLIPS"
# k1 looks like a Wallpaper Engine item: a SQUARE preview image + an animated gif next to its video (the
# card crops it to 16:9, the settings modal shows it at its own aspect — the morph probe needs both)
K1DIR=$(dirname "$(echo "$CLIPS" | jq -r '.[0]')")
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=480x480" -frames:v 1 "$K1DIR/k1.jpg"
# duration= bounds the SOURCE: palettegen waits for its input to end while paletteuse queues every frame,
# so an unbounded source grew to 18 GB until earlyoom killed it (an output -t never ends the input)
timeout 60 ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=240x240:rate=12:duration=2" -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse" "$K1DIR/k1.gif"

# An explicit display from :90 up, never one with a socket, a lock file or an abstract socket: `-displayfd` alone
# picks the first FREE-LOOKING display, and the session's Xwayland (:1, started with -listenfd) leaves a lock file
# naming a pid that is long dead — Xvfb took that for stale, took :1 and replaced the session's /tmp/.X11-unix/X1
# (unlinked again when the shard ended). -displayfd stays as the "ready" signal. Shards racing for one number: the
# loser exits on the lock, the next number is tried.
x_taken() { [ -e "/tmp/.X11-unix/X$1" ] || [ -e "/tmp/.X$1-lock" ] || grep -q "@/tmp/.X11-unix/X$1\$" /proc/net/unix; }
XP=""
for n in $(seq 90 189); do
  x_taken "$n" && continue
  : > "$T/xdisplay"
  "$XVFB" ":$n" -displayfd 3 -nolisten tcp -screen 0 "${LIASCAPE_MATRIX_SCREEN:-1400x900}x24" 3>"$T/xdisplay" >"$T/xvfb.log" 2>&1 & XP=$!
  for _ in $(seq 1 50); do { [ -s "$T/xdisplay" ] || ! kill -0 $XP 2>/dev/null; } && break; sleep 0.1; done
  [ -s "$T/xdisplay" ] && kill -0 $XP 2>/dev/null && break
  kill $XP 2>/dev/null; wait $XP 2>/dev/null; XP=""
done
[ -n "$XP" ] && [ -s "$T/xdisplay" ] || { echo "ABORT: Xvfb didn't start on any of :90–:189"; tail -3 "$T/xvfb.log"; exit 1; }
case "$(cat "$T/xdisplay")" in 0|1|2|3|4|5|6|7|8|9) echo "ABORT: Xvfb on a low display :$(cat "$T/xdisplay")"; exit 1 ;; esac
echo "== Xvfb on :$(cat "$T/xdisplay")"
if [ $MODE = FUZZ ]; then echo "== fuzz${FREPLAY:+ (replay)}"; else echo "== matrix"; fi
(cd "$ROOT/app/shell" && env -u LD_LIBRARY_PATH DISPLAY=":$(cat "$T/xdisplay")" LIASCAPE_URL="$U" LIASCAPE_PLAYER_SOCKET="$XDG_RUNTIME_DIR/liascape/liascape-player.sock" \
  LIASCAPE_CLIPS="$CLIPS" LIASCAPE_OUT="$OUT" LIASCAPE_DOTNET="$DOTNET" LIASCAPE_DLL="$DLL" LIASCAPE_ONLY="$ONLY" LIASCAPE_SHARD="$SHARD" \
  LIASCAPE_FUZZ_STEPS="$FUZZ" LIASCAPE_FUZZ_SEED="$FSEED" LIASCAPE_FUZZ_RUNS="$FRUNS" LIASCAPE_FUZZ_REPLAY="$FREPLAY" \
  LIASCAPE_ADAPTER_LOG="$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" LIASCAPE_BACKEND_LOG="$T/backend.log" \
  LIASCAPE_USER_MUTE="$XDG_CONFIG_HOME/liascape/user_mute.state" LIASCAPE_PULSE="$LIASCAPE_PULSE" \
  LIASCAPE_SCENES="$SCENES_JSON" LIASCAPE_VRAM_FAKE="$T/vram.json" LIASCAPE_BACKEND_PID="$BP" LIASCAPE_BACKEND_PID_FILE="$T/backend2.pid" \
  "$ELECTRON" --ozone-platform=x11 --disable-gpu "${PROBE:-probe-matrix.js}" 2>"$OUT/electron.stderr")
rc=$?
echo "== adapter log (tail)"; tail -n 6 "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null | sed 's/^/     /'
exit $rc
