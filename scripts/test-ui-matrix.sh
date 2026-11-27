#!/usr/bin/env bash
# UI × player-state matrix (on liascape-player): every playback-relevant UI control (and every
# keybind command) exercised in every player state — idle, playing, playlist, an effect running,
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
# Temp folders: removed on every exit; LIASCAPE_KEEP_TMP=1 keeps them. A failed run keeps its results + logs in
# /tmp/liascape-mx-last (the last line says so).
#
# Usage: scripts/test-ui-matrix.sh [--no-build] [--only <regex over cell names>] [--ui-dir <built UI>]
#                                  [--jobs N] [--probe <app/shell script>]  (default probe-matrix.js;
#                                  probe-sidebar.js = the item sidebar probe, same hermetic stack)
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
#   A step also waits for the page's requests and a keybind switch the program must take (a `program.current` since the step
#   began, or prog:main.path moved) — one never taken FAILs — and
#   lets an advance-on-end switch that fired on its own land (its control's own check is then skipped: "rotated").
#   --seed: the PRNG seed (default: random, printed); a run's picks depend only on (seed, run index), not on --jobs.
#   A failure prints the seed, the run index, the exact sequence (`state → c1 → c2 …`) and a --fuzz-replay command that
#   reruns exactly that sequence on one stack. --jobs defaults to 2 here (LIASCAPE_FUZZ_JOBS), capped at the run count.
#   Results: <out>/fuzz.jsonl, one record per run (seed, run, start, sequence, replay, per-step phases + violations).
# LIASCAPE_MATRIX_AUTOMUTE=signal (the default) | audiomonitor: the auto-mute engine. signal = the shipped one, the player's
# Signal: the stack's audio is a private PipeWire + WirePlumber + pipewire-pulse and its player plays
# audio (no `--ao null`). audiomonitor = the backend's AudioMonitor (what runs while the player has no `automute`
# capability): a private PulseAudio, the player at `--ao null` (no bus). Without pipewire / wireplumber / pipewire-pulse the
# default falls back to audiomonitor (printed).
# LIASCAPE_MATRIX_SCREEN=<w>x<h> (default 1400x900): the private Xvfb's screen size (a probe that measures at the owner's 1080p).
# A cell that never ends must not hold the machine's test lock (a wedged probe Electron can ignore
# SIGTERM). LIASCAPE_MATRIX_CELL_LIMIT=<s> (default 240: the slowest cell seen took 62 s, a passing one 28 s): a probe-matrix
# cell still running then is recorded as an ERROR naming it and its last log lines, its Electron and everything under it
# get TERM (KILL 5 s later), the player / backend are started again if they no longer answer, and a new Electron goes on
# with the next cell. After LIASCAPE_MATRIX_MAX_HANGS (default 3) such cells, or when the stack can't be brought back
# (Xvfb gone, a player or backend that won't start), the stack ends with an error instead. LIASCAPE_MATRIX_RUN_LIMIT=<s>
# (0 = none): the whole run's ceiling, counted from the stacks' start; by default 900 s for the start-up + 20 s for each
# cell of the largest shard + room for the hung cells (fuzz: per step; another probe: 5400 s, the lock wrapper's cap).
# Every exit lets the lock go, a kill -9 of the run too: the lock's helper watches the run's pid, the shards stop when
# their parent is gone, and a single stack's reaper stops what the killed run had started.
# LIASCAPE_MATRIX_NICE=1: run at the lowest CPU + I/O priority (nice 19, ionice idle — everything it starts
# inherits it); off by default — a starved stack makes the timing-sensitive cells flaky.
# Needs: dotnet (DOTNET=…), ffmpeg, jq, curl, node, an Electron (ELECTRON=…, default: $LIASCAPE_ELECTRON — the
# devShell's, the flake's major — else `electron` on PATH; the version it runs is printed); pulseaudio (PULSEAUDIO=…) + pactl / paplay / parec for the auto-mute cells (they SKIP
# without). Exit 0 = every cell passed. Results: $LIASCAPE_MATRIX_OUT (default: a dir printed at the end).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/test-lock.sh" # one heavy test run at a time on this machine
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)  # physical path: a symlinked alias (/home → /mnt/…) makes MSBuild delete its own outputs
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
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
CELL_LIMIT=${LIASCAPE_MATRIX_CELL_LIMIT:-240}; MAX_HANGS=${LIASCAPE_MATRIX_MAX_HANGS:-3}
num "$CELL_LIMIT" && [ "$CELL_LIMIT" -gt 0 ] || { echo "LIASCAPE_MATRIX_CELL_LIMIT wants a positive number of seconds"; exit 2; }
num "$MAX_HANGS" || { echo "LIASCAPE_MATRIX_MAX_HANGS wants a number"; exit 2; }
[ -z "${LIASCAPE_MATRIX_RUN_LIMIT:-}" ] || num "$LIASCAPE_MATRIX_RUN_LIMIT" || { echo "LIASCAPE_MATRIX_RUN_LIMIT wants seconds (0 = none)"; exit 2; }
# The whole run's ceiling in seconds since the stacks started (0 = none); $1 = the largest shard's cell count, empty while
# a probe-matrix shard hasn't said yet (cells.total) — the start-up allowance alone until then. A backstop: a hung cell
# is the per-cell limit's, so this only ends a run whose every cell crawls, or a stack wedged outside a cell.
run_limit() {
  local startup=900 per=20 hung=$(( MAX_HANGS * (CELL_LIMIT + 60) ))
  if [ -n "${LIASCAPE_MATRIX_RUN_LIMIT:-}" ]; then echo "$LIASCAPE_MATRIX_RUN_LIMIT"
  elif [ -n "$FUZZ" ]; then echo $(( startup + (FRUNS + JOBS - 1) / JOBS * (FUZZ * per + 60) ))
  elif [ -n "$FREPLAY" ]; then echo $(( startup + ($(printf '%s' "$FREPLAY" | tr -cd , | wc -c) + 1) * per + 60 ))
  elif [ -n "$PROBE" ] && [ "$PROBE" != probe-matrix.js ]; then echo 5400
  elif [ -z "${1:-}" ]; then echo "$startup"
  else echo $(( startup + $1 * per + hung )); fi
}
# $1 and every process under it (listed before any is killed: the children of a dead process are re-parented)
descendants() {
  ps -e -o pid=,ppid= | awk -v root="$1" '{ kids[$2] = kids[$2] " " $1 }
    END { out = root; q = root; while (q != "") { n = split(q, a, " "); q = ""; for (i = 1; i <= n; i++) { m = split(kids[a[i]], b, " ")
      for (j = 1; j <= m; j++) { out = out " " b[j]; q = q " " b[j] } } } print out }'
}
# running (a zombie — our own child not yet waited for — isn't)
alive() { local s; s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; s=${s##*) }; [ "${s%% *}" != Z ]; }
# TERM to $1, KILL after $2 seconds (CONT too: a SIGSTOPped process takes no TERM); then whatever is left under it gets TERM,
# KILL 2 s later. The root goes first: Electron (and the player's supervisor) stop their own children, and an Electron
# whose zygote / GPU process is TERMed under it aborts with a core dump. Returns 1 when the root needed the KILL.
kill_tree() {
  local pids p left r=0; pids=$(descendants "$1")
  kill -CONT $pids 2>/dev/null; kill -TERM "$1" 2>/dev/null
  for _ in $(seq 1 $(( ${2:-5} * 10 ))); do alive "$1" || break; sleep 0.1; done
  alive "$1" && { kill -KILL "$1" 2>/dev/null; r=1; }
  left=""; for p in $pids; do alive "$p" && left="$left $p"; done
  [ -n "$left" ] && kill -TERM $left 2>/dev/null
  for _ in $(seq 1 20); do
    left=""; for p in $pids; do alive "$p" && left="$left $p"; done
    [ -z "$left" ] && return $r; sleep 0.1
  done
  kill -KILL $left 2>/dev/null; return $r
}
SELF=$ROOT/scripts/$(basename "${BASH_SOURCE[0]}")
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
ELECTRON=${ELECTRON:-${LIASCAPE_ELECTRON:-$(command -v electron || true)}}
[ -x "$ELECTRON" ] || { echo "no electron — set ELECTRON=/path/to/electron (or run in the devShell)"; exit 2; }
[ -n "$SHARD" ] || echo "== electron $("$ELECTRON" --version 2>/dev/null) ($ELECTRON)"
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
    rc=$?; kept=""
    trap - EXIT INT TERM HUP
    # each shard runs in its own session (setsid): its whole tree — Electron, Xvfb, backend, player — goes
    for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && kill -TERM -- "-$pid" 2>/dev/null; done
    for pid in "${PIDS[@]}"; do for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; kill -KILL -- "-$pid" 2>/dev/null; done
    # a passing run leaves nothing; a failed one keeps its results (screens, cells.jsonl, shard logs) in /tmp/liascape-mx-last
    if [ -z "${LIASCAPE_MATRIX_OUT:-}" ] && [ -d "$OUTROOT" ] && [ "$rc" != 0 ] && [ -z "${LIASCAPE_KEEP_TMP:-}" ]; then
      rm -rf -- /tmp/liascape-mx-last
      cp -r "$OUTROOT" /tmp/liascape-mx-last && kept=/tmp/liascape-mx-last
    fi
    lp_tmp_done "$P" /tmp/liascape-mx- 0
    [ -n "$kept" ] && echo "results kept in $kept"
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
    LIASCAPE_MATRIX_OUT=$OUTROOT/shard-$i LIASCAPE_MATRIX_PARENT=$$ setsid "$SELF" --no-build --ui-dir "$UIDIR" --shard "$i/$JOBS" ${ONLY:+--only "$ONLY"} "${FARGS[@]}" \
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
  # the largest shard's cell count once every shard still running has said (cells.total), else empty
  slice_max() {
    local i m=0 c
    for i in $(seq 0 $((JOBS - 1))); do
      if c=$(cat "$OUTROOT/shard-$i/cells.total" 2>/dev/null) && num "$c"; then [ "$c" -gt "$m" ] && m=$c
      elif kill -0 "${PIDS[$i]}" 2>/dev/null; then return 0; fi
    done
    echo "$m"
  }
  while :; do
    alive=0; for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    if [ "$(memavail)" -lt "$MINFREE" ]; then echo "ABORT: only $(memavail) MiB available (floor $MINFREE) — stopping every shard"; exit 3; fi
    flush; [ $alive = 0 ] && break
    lim=$(run_limit "$(slice_max)")
    if [ "$lim" -gt 0 ] && [ $(( $(date +%s) - T0 )) -ge "$lim" ]; then
      echo "ERROR: the run passed its ceiling of $lim s (LIASCAPE_MATRIX_RUN_LIMIT overrides it) — stopping every shard"; exit 4
    fi
    sleep 3
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
  grep -h -A12 '^FAIL real network' "$OUTROOT"/shard-*.log 2>/dev/null | grep -v '^--$'
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
RUN_T0=$(date +%s)   # the whole-run ceiling counts from here (a single stack; --jobs: the parent's T0)
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
export LIASCAPE_SECRETS=file # Helpers/SecretStore.cs: the Steam secrets never reach the session's keyring from a test
# Steam's servers for the library's tag / trailer look-ups and Browse's Workshop pages (Helpers/SteamWorkshopDetails.cs):
# this file, never Steam — no id keys = no Workshop item has a public listing (probe-filters lib:steamTags adds one);
# "@query" = the Workshop Browse lists to a page that doesn't stub /browse itself (no preview: /img would go out); its two
# presets name the scene 910000003 as their base ("children": Browse's Preset option and a scene's Presets list, probe-filters
# filter:preset:*, probe-steam ws:presets*)
export LIASCAPE_STEAM_CM_FIXTURE=$T/steam-cm.json
cat > "$LIASCAPE_STEAM_CM_FIXTURE" <<'EOF'
{"@query": [
  {"publishedfileid": "910000001", "title": "Fixture Workshop One", "tags": ["Video", "Everyone", "1920 x 1080", "Nature"], "subscriptions": 30},
  {"publishedfileid": "910000002", "title": "Fixture Workshop Two", "tags": ["Video", "Everyone", "3840 x 2160", "Abstract"], "subscriptions": 20},
  {"publishedfileid": "910000003", "title": "Fixture Workshop Three", "tags": ["Scene", "Everyone", "1920 x 1080", "Anime"], "subscriptions": 10},
  {"publishedfileid": "910000011", "title": "Fixture Preset One", "tags": ["Preset", "Scene", "Everyone", "1920 x 1080", "Anime"], "subscriptions": 8, "children": ["910000003"]},
  {"publishedfileid": "910000012", "title": "Fixture Preset Two", "tags": ["Preset", "Scene", "Everyone", "Anime"], "subscriptions": 6, "children": ["910000003"]}]}
EOF
# Browse's web sources (Services/WebSourcesFixture.cs): {} = each lists nothing — the page reads the first source at
# every load, which would otherwise scrape a real site
export LIASCAPE_WEB_SOURCES_FIXTURE=$T/web-sources.json
printf '{}' > "$LIASCAPE_WEB_SOURCES_FIXTURE"
# and nothing else reaches a real server: the backend refuses any outbound connection but loopback with a
# "test-network: REFUSED <call>" line (Helpers/TestNetwork.cs), and the run fails on one (the end of this script)
export LIASCAPE_TEST_NO_NETWORK=1
# an import from a link reaches only public addresses (Helpers/LinkImport.cs); probe-import's file server listens on loopback,
# which this lets a link reach (never the LAN). Guard: --probe probe-import.js import:link:*
export LIASCAPE_TEST_LINK_LOOPBACK=1
# every curl here goes to the private backend: it carries the backend's API token (serve.token beside serve.port, read
# per call — a restarted backend may have written it since; .claude/rules/backend/api.md § Security). /health needs none.
curl() { command curl -H "X-Liascape-Token: $(cat "$XDG_CONFIG_HOME/liascape/serve.token" 2>/dev/null)" "$@"; }
export XDG_RUNTIME_DIR=$T/rt XDG_STATE_HOME=$T/st LIASCAPE_PLAYER_BIN=$B LIASCAPE_TRANSITIONS_DIR=$ROOT/transitions LIASCAPE_UI_DIR=$T/ui
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# restart:initDown loads the built UI from file:// (the dev topology: the UI on another origin than the backend — Chromium
# sends Origin "null" on its fetches, "file://" on its WebSocket); a backend that serves its own UI admits no other
# origin unless told (.claude/rules/backend/api.md § Security)
export LIASCAPE_DEV_ORIGINS=null,file://
# scenes: the private player (and any the backend starts) plays synthetic scene folders with this build's worker,
# and measures VRAM through a fake probe the scene cells drive (healthy by default: 6000 of 8192 MiB free — the
# low-VRAM rule never engages; never this machine's GPU) with short holds (interval, enter, resume, settle, scene hold)
export LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 LIASCAPE_SCENE_WORKER_BIN=${B%/*}/liascape-scene-worker
export LIASCAPE_PLAYER_VRAM_PROBE=fake:$T/vram.json LIASCAPE_PLAYER_VRAM_TIMING=200,600,2000,300,600
printf '{"total_mib":8192,"free_mib":6000,"procs":{}}' > "$T/vram.json"
unset LIASCAPE_PLAYER_SOCKET LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_PORT
# "Start with your desktop" (Helpers/Autostart.cs): the stack's session is none the backend knows (its autostart check
# reads "unknown" on every machine, whatever desktop runs the matrix) and its entry runs a fixed launcher path
unset XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP DESKTOP_SESSION KDE_FULL_SESSION GNOME_DESKTOP_SESSION_ID APPIMAGE
for v in $(env | sed -n 's/^\(UWSM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
export LIASCAPE_LAUNCHER=/opt/liascape-matrix/bin/liascape
# audio: every pulse client of the stack (the backend's pactl/parec, the probe's paplay) resolves the PRIVATE server
# started below ($XDG_RUNTIME_DIR/pulse/native) — never the session's
unset PULSE_SERVER PULSE_SINK PULSE_SOURCE PULSE_COOKIE PULSE_CLIENTCONFIG PULSE_RUNTIME_PATH
SP=""; BP=""; XP=""; PA=""; EP=""; REAPER=""
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  [ -n "$REAPER" ] && kill "$REAPER" 2>/dev/null
  # the probe's Electron (a run stopped mid-cell): it may ignore TERM
  [ -n "$EP" ] && alive "$EP" && kill_tree "$EP" 5
  [ -n "$XP" ] && kill "$XP" 2>/dev/null
  [ -n "$PA" ] && kill $PA 2>/dev/null
  [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
  # a backend the probe started in place of $BP (restore:scene restarts it) — only one whose HOME is this stack's
  if [ -s "$T/backend2.pid" ]; then
    b2=$(cat "$T/backend2.pid")
    if tr '\0' '\n' < "/proc/$b2/environ" 2>/dev/null | grep -qx "HOME=$T/home"; then
      kill "$b2" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$b2" 2>/dev/null || break; sleep 0.1; done; kill -9 "$b2" 2>/dev/null
    fi
  fi
  "$B" ctl --timeout-ms 1000 quit >/dev/null 2>&1
  [ -n "$SP" ] && { for _ in $(seq 1 30); do kill -0 "$SP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$SP" 2>/dev/null; }
  # pass: nothing stays. Fail: the results (screens, cells.jsonl) plus this stack's logs go to /tmp/liascape-mx-last, or
  # (a shard of --jobs, whose parent collects them) beside the shard's results in $OUT/tmp-logs.
  if [ -z "${LIASCAPE_MATRIX_OUT:-}" ]; then
    if [ "$rc" != 0 ] && [ -z "${LIASCAPE_KEEP_TMP:-}" ] && [ -d "$OUT" ]; then
      rm -rf -- /tmp/liascape-mx-last
      cp -r "$OUT" /tmp/liascape-mx-last
      lp_tmp_done "$T" /tmp/liascape-mx- "$rc" /tmp/liascape-mx-last/tmp-logs ./out
      echo "results kept in /tmp/liascape-mx-last"
    else
      lp_tmp_done "$T" /tmp/liascape-mx- "$rc"
    fi
  else
    lp_tmp_done "$T" /tmp/liascape-mx- "$rc" "$OUT/tmp-logs"
  fi
}
trap cleanup EXIT
trap '[ -e "$T/ceiling" ] && exit 4; exit 130' INT TERM HUP
# A single stack's watcher, beside the run from here to its end (start-up, cells, a restart after a hung cell):
# - the whole run's ceiling (run_limit, from RUN_T0): past it, it says so and TERMs the run, whose cleanup stops the stack
#   (exit 4). A shard's ceiling is its parent's.
# - a run killed outright (kill -9: no trap runs) lets the test lock go by itself (its helper watches this pid), but what it
#   started would play on: the watcher then stops every process started with the stack's HOME and removes the temp dir.
#   A shard needs none: its parent's cleanup ends the shard's whole session, and a shard whose parent is gone stops itself.
if [ -z "$SHARD" ]; then
  ( trap '' INT HUP
    while kill -0 $$ 2>/dev/null; do
      lim=$(run_limit "$(cat "$OUT/cells.total" 2>/dev/null)")
      if [ ! -e "$T/ceiling" ] && [ "$lim" -gt 0 ] && [ $(( $(date +%s) - RUN_T0 )) -ge "$lim" ]; then
        echo "ERROR: the run passed its ceiling of $lim s (LIASCAPE_MATRIX_RUN_LIMIT overrides it)"; : > "$T/ceiling"; kill -TERM $$
      fi
      sleep 1
    done
    exec >/dev/null 2>&1
    pids=$(grep -lzx "HOME=$T/home" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3)
    if [ -n "$pids" ]; then kill -TERM $pids; kill -CONT $pids; sleep 3; kill -KILL $pids; fi
    [ -n "${LIASCAPE_KEEP_TMP:-}" ] || rm -rf -- "$T"
  ) </dev/null &
  REAPER=$!
fi

clip() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "$2=size=320x180:rate=30" -f lavfi -i "sine=frequency=$3:sample_rate=48000" \
           -t "$4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$1"; }
clip "$T/k1.mp4" testsrc2 330 30; clip "$T/k2.mp4" smptebars 440 30; clip "$T/k3.mp4" rgbtestsrc 550 30; clip "$T/k4.mp4" testsrc 660 10

# Expert: every Settings row renders, so the cells that drive an Expert row (video cache, buffers) find it. The one-time tips
# seen: no tip line moves what the other probes measure (probe-firstrun.js shows them itself)
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"NoAudio":false,"Volume":80,"Speed":1,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["fade"],"GlobalTransitionDurationMs":1200,"GlobalTransitionShuffle":false,
 "TransitionMethod":"full-live","GlobalSwitchWhenVideoEnds":false,"GlobalMaxPlaySeconds":0,
 "GlobalIntervalSeconds":600,"AutoMute":false,"SettingsLevel":"expert",
 "AutoAddWeWallpapersToLibrary":false,"SeenTips":["cardMenu","playlists","itemSettings","downloadModes"]}
EOF

# A private PulseAudio for the auto-mute cells: its own socket under $XDG_RUNTIME_DIR/pulse, ONE null sink (mx_null),
# no device module, no D-Bus, no autospawn (client.conf) — the backend's AudioMonitor (pactl subscribe + parec) and
# the probe's synthetic streams only ever meet there; the owner's audio server, routing and streams are never seen.
# Missing pulseaudio/pactl/paplay/parec → the auto-mute cells SKIP.
mkdir -p "$T/home/.config/pulse"; printf 'autospawn = no\n' >"$T/home/.config/pulse/client.conf"
PULSEAUDIO=${PULSEAUDIO:-$(command -v pulseaudio || ls /nix/store/*-pulseaudio-*/bin/pulseaudio 2>/dev/null | head -1)}
LIASCAPE_PULSE=0
AMX=${LIASCAPE_MATRIX_AUTOMUTE:-signal}
case "$AMX" in signal|audiomonitor) ;; *) echo "LIASCAPE_MATRIX_AUTOMUTE: signal | audiomonitor"; exit 2 ;; esac
if [ "$AMX" = signal ] && ! { command -v pipewire && command -v wireplumber && command -v pipewire-pulse && command -v paplay; } >/dev/null; then
  echo "(no pipewire / wireplumber / pipewire-pulse / paplay — the auto-mute engine is AudioMonitor, on a private PulseAudio)"; AMX=audiomonitor
fi
export LIASCAPE_MATRIX_AUTOMUTE=$AMX
if [ "$AMX" = signal ]; then
  # The auto-mute cells with the player's Signal as the engine (`--only autoMute`): it hears PipeWire
  # streams only, so here the stack's audio is a private PipeWire + WirePlumber + pipewire-pulse (no device, no D-Bus; the
  # same null sink name, so the probe's paplay is unchanged). No session bus: lia-mpris never reads the machine's players.
  unset LIASCAPE_PLAYER_AUTOMUTE; export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
  unset PIPEWIRE_RUNTIME_DIR PIPEWIRE_REMOTE
  PW=$T/pw; mkdir -p "$PW/cfg/wireplumber/wireplumber.conf.d" "$PW/state"
  cat > "$PW/pw.conf" <<'PWEOF'
context.properties = { core.daemon = true core.name = pipewire-0
  default.clock.rate = 48000 support.dbus = false log.level = 1 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-protocol-native } { name = libpipewire-module-profiler }
  { name = libpipewire-module-access } { name = libpipewire-module-metadata }
  { name = libpipewire-module-spa-device-factory } { name = libpipewire-module-spa-node-factory }
  { name = libpipewire-module-client-node } { name = libpipewire-module-client-device }
  { name = libpipewire-module-adapter } { name = libpipewire-module-link-factory } ]
context.objects = [
  { factory = spa-node-factory args = { factory.name = support.node.driver node.name = Dummy-Driver
      node.group = pipewire.dummy priority.driver = 20000 } }
  { factory = adapter args = { factory.name = support.null-audio-sink node.name = mx_null
      node.description = "mx null" media.class = Audio/Sink audio.position = [ FL FR ]
      monitor.channel-volumes = true node.group = pipewire.dummy priority.driver = 21000 } } ]
PWEOF
  echo 'wireplumber.profiles = { policy = { support.reserve-device = disabled monitor.alsa.reserve-device = disabled support.portal-permissionstore = disabled script.client.access-portal = disabled support.logind = disabled monitor.bluez.seat-monitoring = disabled hooks.device.profile.state = disabled hooks.device.routes.state = disabled } }' \
    > "$PW/cfg/wireplumber/wireplumber.conf.d/99-hermetic.conf"
  pw_daemon() { local log=$1; shift
    (exec env XDG_CONFIG_HOME="$PW/cfg" XDG_STATE_HOME="$PW/state" "$@" > "$log" 2>&1) & PA="$PA $!"; }
  pw_daemon "$PW/pipewire.log" pipewire -c "$PW/pw.conf"
  for _ in $(seq 1 50); do [ -e "$XDG_RUNTIME_DIR/pipewire-0" ] && break; sleep 0.1; done
  pw_daemon "$PW/wireplumber.log" wireplumber -p policy
  pw_daemon "$PW/pipewire-pulse.log" pipewire-pulse
  for _ in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/pulse/native" ] && break; sleep 0.1; done
  [ -S "$XDG_RUNTIME_DIR/pulse/native" ] && LIASCAPE_PULSE=1 || echo "(no private pipewire-pulse — the auto-mute cells skip)"
elif [ -n "$PULSEAUDIO" ] && [ -x "$PULSEAUDIO" ] && command -v pactl >/dev/null && command -v paplay >/dev/null && command -v parec >/dev/null; then
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

# `--ao null` means no bus (so no `automute` capability): under the Signal it plays on the private PipeWire
AO=(--ao null); [ "$AMX" = signal ] && AO=()
player_up() { "$B" ctl --timeout-ms 500 hello >/dev/null 2>&1; }
start_player() {
  (cd /tmp && exec "$B" serve --headless --outputs 640x360@60,320x180@60 --clock real "${AO[@]}" >> "$T/serve.log" 2>&1) & SP=$!
  for _ in $(seq 1 50); do player_up && return 0; sleep 0.1; done
  return 1
}
start_player
"$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1 & BP=$!
for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "ABORT: backend didn't start"; tail -5 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
# after a hung cell: a backend on the same port again (the probe's own restarts do the same), up once it answers /health
start_backend() {
  LIASCAPE_PORT=${U##*:} "$DOTNET" "$DLL" serve >> "$T/backend.log" 2>&1 & BP=$!
  local end=$((SECONDS + 40))
  while [ $SECONDS -lt $end ]; do curl -sf -m 2 "$U/health" >/dev/null && return 0; alive "$BP" || return 1; sleep 0.1; done
  return 1
}
[ "$(curl -sf -m 5 "$U/player-engine" | jq -r .available)" = true ] || { echo "ABORT: the backend's liascape-player isn't available"; exit 1; }
post() { curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$U$1"; }
# each import tried three times: one lost to a busy start-up left the stack with three clips, and every cell then failed
# its entry as SETUP
import_clip() {
  local r
  for _ in 1 2 3; do r=$(post /library/import "{\"path\":\"$T/$1.mp4\",\"title\":\"$1\"}" | jq -ce '.videoPath | strings') && { echo "$r"; return 0; }; sleep 1; done
  return 1
}
CLIPS=$(for k in k1 k2 k3 k4; do import_clip "$k" || echo "ABORT: importing $k failed" >&2; done | jq -sc .)
echo "library: $CLIPS"
[ "$(echo "$CLIPS" | jq length)" = 4 ] || { echo "ABORT: the library has $(echo "$CLIPS" | jq length) of its 4 clips"; tail -5 "$T/backend.log"; exit 1; }
# k1 looks like a Wallpaper Engine item: a SQUARE preview image + an animated gif next to its video (the
# card crops it to 16:9, the settings modal shows it at its own aspect — the morph probe needs both)
K1DIR=$(dirname "$(echo "$CLIPS" | jq -r '.[0]')")
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=480x480" -frames:v 1 "$K1DIR/k1.jpg"
# duration= bounds the SOURCE: palettegen waits for its input to end while paletteuse queues every frame,
# so an unbounded source grew to 18 GB until earlyoom killed it (an output -t never ends the input)
# Each frame is one solid colour that codes its index (r = 40 + 4·i, g = 200 − 3·i, b = 90; 48 frames at 8 fps), so a
# screenshot tells which frame a card shows (probe-matrix appear:gifResume).
timeout 60 ffmpeg -nostdin -loglevel error -y -f lavfi -i "color=c=black:size=240x240:rate=8:duration=6,format=gbrp,geq=r='40+4*N':g='200-3*N':b=90" -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse" "$K1DIR/k1.gif"

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
CELLF=$T/cell.now   # probe-matrix.js: "<start ms>\t<last phase finished>\t<cell>" while a cell runs
# In the background, waited on below: a foreground Electron would hold off this script's TERM trap for as long as it
# lives, and the per-cell watchdog has to run meanwhile.
start_probe() {   # $1 = the cell to go on after (a hung one), empty = from the start
  rm -f "$CELLF"
  (cd "$ROOT/app/shell" && exec env -u LD_LIBRARY_PATH DISPLAY=":$(cat "$T/xdisplay")" LIASCAPE_URL="$U" LIASCAPE_PLAYER_SOCKET="$XDG_RUNTIME_DIR/liascape/liascape-player.sock" \
    LIASCAPE_CLIPS="$CLIPS" LIASCAPE_OUT="$OUT" LIASCAPE_DOTNET="$DOTNET" LIASCAPE_DLL="$DLL" LIASCAPE_ONLY="$ONLY" LIASCAPE_SHARD="$SHARD" \
    LIASCAPE_FUZZ_STEPS="$FUZZ" LIASCAPE_FUZZ_SEED="$FSEED" LIASCAPE_FUZZ_RUNS="$FRUNS" LIASCAPE_FUZZ_REPLAY="$FREPLAY" \
    LIASCAPE_ADAPTER_LOG="$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" LIASCAPE_BACKEND_LOG="$T/backend.log" \
    LIASCAPE_USER_MUTE="$XDG_CONFIG_HOME/liascape/user_mute.state" LIASCAPE_PULSE="$LIASCAPE_PULSE" \
    LIASCAPE_SCENES="$SCENES_JSON" LIASCAPE_VRAM_FAKE="$T/vram.json" LIASCAPE_BACKEND_PID="$BP" LIASCAPE_BACKEND_PID_FILE="$T/backend2.pid" \
    LIASCAPE_MATRIX_CELL_FILE="$CELLF" LIASCAPE_MATRIX_BASE_SETTINGS="$T/base-settings.json" LIASCAPE_MATRIX_RESUME_AFTER="$1" \
    "$ELECTRON" --ozone-platform=x11 --disable-gpu "${PROBE:-probe-matrix.js}" 2>>"$OUT/electron.stderr") & EP=$!
}
# the backend that should be serving now: the probe's own restart (backend2.pid, only one with this stack's HOME) or ours
backend_pids() {
  local b2; b2=$(cat "$T/backend2.pid" 2>/dev/null)
  [ -n "$b2" ] && tr '\0' '\n' 2>/dev/null < "/proc/$b2/environ" | grep -qx "HOME=$T/home" && alive "$b2" && echo "$b2"
  alive "$BP" && echo "$BP"
}
# After a hung cell's Electron is gone, bring back what no longer answers and go on: one hung cell shouldn't cost the
# rest of a shard. Xvfb and the audio server stay (no cell stops them); a player that doesn't answer `hello` within 5 s
# goes with its whole tree and starts again, the same for a backend without /health (the probe's own restart of it ran
# under the killed Electron). Non-zero = not possible: the stack ends with an error instead.
restart_stack() {
  alive "$XP" || { echo "        (the stack's Xvfb is gone)"; return 1; }
  local ok=0 p
  for _ in $(seq 1 10); do player_up && { ok=1; break; }; sleep 0.5; done
  if [ $ok = 0 ]; then
    echo "        the player doesn't answer: starting it again"
    kill_tree "$SP" 5; wait "$SP" 2>/dev/null
    start_player || { echo "        (the player didn't start again)"; return 1; }
  fi
  ok=0; for _ in $(seq 1 10); do curl -sf -m 2 "$U/health" >/dev/null && { ok=1; break; }; sleep 0.5; done
  if [ $ok = 0 ]; then
    echo "        the backend doesn't answer: starting it again"
    for p in $(backend_pids); do kill_tree "$p" 5; done; rm -f "$T/backend2.pid"
    start_backend || { echo "        (the backend didn't start again)"; tail -n 5 "$T/backend.log" | sed 's/^/          /'; return 1; }
  fi
  for _ in $(seq 1 50); do [ "$(curl -sf -m 5 "$U/player-engine" | jq -r .available 2>/dev/null)" = true ] && return 0; sleep 0.2; done
  echo "        (the backend doesn't reach the player)"; return 1
}
# what a hung cell is reported with (no Steam token line: a failed run's logs are kept)
last_logs() {
  { tail -n 8 "$OUT/electron.stderr" 2>/dev/null | sed 's/^/electron: /'
    tail -n 8 "$T/backend.log" 2>/dev/null | sed 's/^/backend: /'
    tail -n 4 "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null | sed 's/^/adapter: /'
  } | grep -v SteamRefreshToken
}
RESUME=""; hangs=0; rc=""
while [ -z "$rc" ]; do
  start_probe "$RESUME"; RESUME=""
  while alive "$EP"; do
    # a shard whose parent is gone (killed outright: its cleanup never ran) stops, or it would play on with no one waiting
    if [ -n "${LIASCAPE_MATRIX_PARENT:-}" ] && ! kill -0 "$LIASCAPE_MATRIX_PARENT" 2>/dev/null; then echo "ERROR: the run that started this shard is gone"; exit 1; fi
    if [ -s "$CELLF" ] && IFS=$'\t' read -r c0 cph cname 2>/dev/null < "$CELLF" && num "$c0" \
       && [ $(( $(date +%s%3N) - c0 )) -ge $(( CELL_LIMIT * 1000 )) ]; then
      RESUME=$cname; break
    fi
    sleep 1
  done
  if [ -z "$RESUME" ]; then wait "$EP"; rc=$?; EP=""; break; fi
  # a cell past the limit. Guard: scripts/test-matrix-watchdog.sh
  hangs=$((hangs + 1))
  logs=$(last_logs)
  echo "ERROR $RESUME"
  echo "        - no result within $CELL_LIMIT s (LIASCAPE_MATRIX_CELL_LIMIT; last phase finished: $cph): its Electron is stopped (TERM, KILL after 5 s)"
  echo "        last log lines:"; printf '%s\n' "$logs" | sed 's/^/          /'
  if kill_tree "$EP" 5; then echo "        its Electron ended on TERM"; else echo "        its Electron ignored TERM: KILLed after 5 s"; fi
  wait "$EP" 2>/dev/null; EP=""; rm -f "$CELLF"
  # this record stands for the cell: an Electron that quit on the TERM may have recorded it failing on its way out
  jq -c --arg cell "$RESUME" 'select("\(.state) × \(.control)" != $cell)' "$OUT/cells.jsonl" > "$OUT/cells.jsonl.mx" 2>/dev/null \
    && mv -f "$OUT/cells.jsonl.mx" "$OUT/cells.jsonl"
  jq -nc --arg cell "$RESUME" --arg ph "$cph" --argjson lim "$CELL_LIMIT" --arg logs "$logs" \
    '($cell | split(" × ")) as $sc | { state: $sc[0], control: ($sc[1:] | join(" × ")), result: "ERROR", ms: ($lim * 1000),
      violations: ["no result within \($lim) s (last phase finished: \($ph)): the cell hung, its Electron was killed"],
      logs: ($logs | split("\n") | map(select(length > 0))) }' >> "$OUT/cells.jsonl"
  if [ "$hangs" -ge "$MAX_HANGS" ]; then echo "ERROR: $hangs cells hung (LIASCAPE_MATRIX_MAX_HANGS $MAX_HANGS): this stack ends here"; rc=1
  elif ! restart_stack; then echo "ERROR: the stack couldn't be brought back after $RESUME: it ends here"; rc=1
  else echo "        the stack answers again: on with the cells after it"; fi
done
echo "== adapter log (tail)"; tail -n 6 "$XDG_CACHE_HOME/liascape/liascape-player-adapter.log" 2>/dev/null | sed 's/^/     /'
# a call to a real server (LIASCAPE_TEST_NO_NETWORK above refused it): the run fails, naming each — the probe that made it
# needs a stub or a fixture
grep -h 'test-network: REFUSED' "$T/backend.log" 2>/dev/null | sed 's/^.*REFUSED //' | sort | uniq -c > "$T/refused.txt"
if [ -s "$T/refused.txt" ]; then
  echo "FAIL real network: the backend refused $(awk '{n += $1} END {print n}' "$T/refused.txt") call(s) to real servers:"
  sed 's/^/     /' "$T/refused.txt"
  rc=1
fi
exit $rc
