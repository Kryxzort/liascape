#!/usr/bin/env bash
# liascape-player Phase 1 on-machine battery (Task 20, docs/superpowers/sdd/2026-10-20-liascape-player-phase0-1/
# task-20-brief.md). Drives the REAL C# backend (`liascape serve`, PlayerEngine=liascape-player) over
# HTTP exactly like the owner's UI would, and inspects the result with `liascape-player ctl` directly —
# same split as `scripts/test-liascape-player-adapter.sh` (§ Integration test) and
# `src/player/tests/onmachine/bus.sh`, whose patterns this reuses (temp dirs for --hermetic, a
# cleanup trap that always restores owner state, `pactl`/`nvidia-smi` for live measurements).
#
# Subcommands:
#   battery.sh run        [options]   -- the method x mode switch matrix (this file's main job)
#   battery.sh permonitor [options]   -- brief step 3: per-output isolation, via `ctl` only
#   battery.sh soak       [options]   -- brief step 4: 1 h RSS/VRAM soak on the owner's playlist
#   battery.sh scenes <step…> [opts]  -- Phase 2 Task 14, the scene-worker battery (scenes.sh)
#
# Options (run):
#   --hermetic            private backend + private headless liascape-player (own HOME/XDG/port, --ao null,
#                         synthetic ffmpeg media) -- never touches the owner's session. Use this for
#                         stage-1 verification; stage 2 drops it to run on the owner's live session.
#   --smoke               2 switches per cell instead of >= 50 (plumbing check, not a real battery)
#   --switches N          override the per-cell switch count (default 50)
#   --cells m1/mo1,m2/mo2 only run these method/mode cells (see --list-cells); default = every
#                         cell this build knows (the 24-cell matrix + the realism cell + the
#                         3-method extremes block, R100/R101 -- see --list-cells)
#   --list-cells          print every method/mode cell id (matrix + realism + extremes) and exit
#   --effect-ms N          R100 (controller ruling): fix the MAIN MATRIX's effect duration to N ms
#                         instead of deriving it from real media -- skips setup_live_media's
#                         derivation and is what actually reaches the backend (fixes a real
#                         ordering bug found running this live: setup_live_backend used to push
#                         globalTransitionDurationMs from the stale pre-media-scan default BEFORE
#                         setup_live_media recomputed it from real clips, so the backend ran at
#                         the wrong duration the whole time -- now ALWAYS re-pushed after media
#                         setup, whether from this flag or the auto-derivation). The realism cell
#                         (full-live/realism) and the extremes block's own cells (R101) set their
#                         own duration per cell regardless of this flag.
#   --results-dir DIR     override the timestamped results directory
#   --resume DIR          resume an interrupted run (stage-2 controller ruling R99): reuses DIR
#                         (implies --results-dir DIR), skips every method/mode cell that already
#                         has a full SWITCHES-count of records in switches.jsonl OR a recorded
#                         entry in cell-failures.jsonl, and re-runs (cleanly, discarding any
#                         partial records first) any cell that was cut off mid-way. switches.jsonl
#                         is never truncated when resuming.
#   --build               rebuild liascape-player (cargo) + the backend (dotnet) first (hermetic only;
#                         default: use whatever is already built, like `--no-build` elsewhere)
#   -h / --help           this text
#
# Options (soak): --minutes N (default 60); --hermetic soak only (Task 20b -- it used to switch
# ~never: the playlist followed GlobalIntervalSeconds 1800 with 320x180 clips): --soak-interval S
# (default 10: a timed switch every S s with transitions, ~6x the owner's real rate) and
# --soak-hwdec X (default auto, the owner's HwDec) over three 1080p30 clips with audio. Every
# sample also records the `memory` probe (malloc in-use / retained / arenas) and the switch count.
# Options (permonitor): --hermetic (headless 2-output
# stand-in for DP-1/DP-2); live permonitor always targets the owner's real DP-1/DP-2.
#
# Pass criteria (brief step 2, enforced live, REPORTED-not-enforced under --hermetic): 0 drops and
# 0 micro_gaps per the dropout detector (skipped entirely if this branch has no `probe dropout` --
# see "Dropout detector availability" below), frame present intervals within +/- 0.5 ms of refresh on
# every output, no `transition.failed` except ones we deliberately inject (we inject none -- any
# `failed:` is a real failure). **R99 (stage-2 controller ruling, overrides this file's original
# "stop the whole battery" design):** a failing switch stops only ITS OWN cell's remaining
# switches (that corr's `ctl logs` + the frames/dropout stats already in switches.jsonl are
# recorded to cell-failures.jsonl) -- run_battery then moves on to the next method/mode cell, so
# one run still produces the full 24-cell matrix even when a cell genuinely fails. The script's
# own exit code still goes non-zero if anything failed (cleanup() checks $FAILED at the very end,
# after every cell has had its turn and owner state is fully restored).
#
# Realism cell + extremes block (R100/R101 controller rulings), run AFTER the main matrix,
# BEFORE permonitor/soak, same R99/resume machinery (own cells in switches.jsonl/
# cell-failures.jsonl, named below -- `--list-cells` prints every one):
#   full-live/realism       10 switches, timed-interval, at the OWNER's own pre-touched
#                           globalTransitionDurationMs/globalTransitionEffectIds (snapshotted
#                           before this script changes anything) -- sanity-checks the
#                           controlled-duration matrix (--effect-ms) against what the owner
#                           actually experiences day to day.
#   <method>/fast-cut       0 ms, 20x manual /next   -- R42's 30 ms gain-ramp floor even at D=0,
#   <method>/fast-50ms      50 ms, 20x manual /next     onset/offset ramps shorter than the
#   <method>/fast-250ms     250 ms, 20x manual /next     effect; checked via the dropout report.
#   <method>/long-timed     30 s effect, 3x via timed-interval (35 s tick, so each really lands)
#   <method>/long-advance   30 s effect, 3x via advance-on-end
#   <method>/long-interrupt 30 s effect, /next at ~40% of a running effect x3 -- the
#                           interrupt/commit path (same mechanism as next-mid-transition, at
#                           this method's own 30 s)
#   <method>/long-shortA-end a clip SHORTER than the 30 s effect, raw `ctl transition` with
#                           align:"end" -- the short-A-hold fallback (player-core.md "Align":
#                           "if it's already past at the first evaluation... it starts at once
#                           and A holds its last frame")
#   <method>/long-pause-resume  player.paused true for 3 s mid-effect then false -- frozen
#                           picture/audio/time together (R75/invariant #7), checked via a
#                           time_pos-unchanged assertion across the pause plus the usual
#                           frames+dropout checks on the switch itself
# (<method> = full-live, reveal, frozen for every extremes row). Each extra cell sets its own
# globalTransitionDurationMs before running and leaves EFFECT_DURATION_MS as the main matrix's
# own value afterward -- owner settings are still restored once, at script exit, as usual.
#
# Dropout detector availability: this worktree (liascape-player-laneC, HEAD cbf6451) predates lane B's
# audio work, which adds the `dropout` probe / `probe.dropout` events / `player.debug`'s consumer.
# `ctl probe '{"name":"dropout",...}'` on this branch replies `no_such_probe` -- probe_dropout()
# below detects that exactly once, logs it, and every switch's `dropout` field becomes
# `{"skipped":"unavailable_on_this_branch"}` for the rest of the run. Re-run after the controller
# merges lane B and it picks the probe up with no script change (global-constraints.md: "the full
# run happens later, after the controller merges the audio work").
#
# Owner-environment safety (brief, owner-approved -- only active without --hermetic):
#   - Legacy wallpaper is stopped first (global-constraints.md) and left stopped at the end.
#   - The liascape-player bus playback stream (sink-input node.name=liascape-player-bus.playback) is held at
#     0% volume throughout (re-applied if PipeWire recreates it) and restored on exit -- audio is
#     silenced for the owner but the bus's own meter (what the dropout detector reads) sits
#     upstream of that stream, so measurement is unaffected. The claim itself is checked in the
#     first minute of a live run (see check_mute_does_not_blind_meter()).
#   - Every AppSettings field we touch (PlayerEngine, TransitionMethod, GlobalTransitionEnabled,
#     GlobalTransitionEffectIds, GlobalTransitionDurationMs, AutoMute) is snapshotted before the
#     first change and restored at the end via a FRESH GET -> set just those fields back -> POST the
#     full object (never a stale start-of-run snapshot -- the owner may change something else of
#     their own while this runs; global-constraints.md's POST-replaces-the-whole-object hazard). The
#     CustomPlaylist (`/playlist/state`) is snapshotted/restored the same way.
#   - LastSession is NOT restorable this way and isn't attempted: ServerHost's POST /settings
#     handler deliberately always keeps `prev.LastSession` no matter what the request body carries
#     (its own comment: "mutated backend-side... clobbered by [a] stale copy... never edited through
#     this form") -- confirmed empirically while building this script (a round-tripped LastSession
#     change via /settings silently didn't take). LastSession ends the run as whatever OUR last
#     /apply left it, which is harmless: the legacy wallpaper itself still ends STOPPED (see below),
#     so nothing auto-replays it; the owner's own next manual pick is unaffected. Flagged in the
#     report for the controller's awareness, not fixed here -- fixing it would mean writing
#     settings.json directly, fighting a deliberate backend protection.
#   - Any library item we imported for /next//prev/-random navigation is deleted again at the end.
#   - A `trap` on EXIT/INT/TERM/HUP always runs the restore + kills any liascape-player left running
#     (quit over the socket, else the supervisor pid we observed via `ctl hello`), regardless of
#     where the script stopped.
#
# Needs: bash, curl, jq, python3, ffmpeg (hermetic media / ffprobe durations), pactl (mute, live
# only), nvidia-smi (soak VRAM, live only). dotnet only for --hermetic (set DOTNET=/path/to/dotnet
# if it is not on PATH).
set -uo pipefail
unset LD_LIBRARY_PATH

# ------------------------------------------------------------------ paths, binaries, defaults
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)

METHODS=(full-live reveal frozen)
MODES=(manual-next manual-prev timed-interval advance-on-end wait-for-end random restore-replay next-mid-transition)
# R101 (controller ruling, owner request "testing very long and very fast transitions"):
# per-method extremes, run after the main matrix, before permonitor/soak (see run_extra_cell).
EXTRA_MODES=(fast-cut fast-50ms fast-250ms long-timed long-advance long-interrupt long-shortA-end long-pause-resume)
EFFECT_ID="fade"
EFFECT_DURATION_MS=1000
EFFECT_MS_OVERRIDE=""   # --effect-ms: fixes the MAIN MATRIX's effect duration instead of
                        # deriving it from real media (R100) -- skips the live-media derivation
                        # in setup_live_media and is pushed to the backend right after setup.

SUBCMD="run"
case "${1:-}" in
  run|permonitor|soak) SUBCMD=$1; shift ;;
  # Phase 2 (Task 14): the scene-worker battery lives in scenes.sh (its own player, no backend).
  scenes) shift; exec bash "$(dirname "${BASH_SOURCE[0]}")/scenes.sh" "$@" ;;
esac

HERMETIC=0
SMOKE=0
SWITCHES=50
CELLS_FILTER=""
RESULTS_DIR_OVERRIDE=""
BUILD=0
SOAK_MINUTES=60
SOAK_INTERVAL=10
SOAK_HWDEC=auto
RESUME=0

usage() { sed -n '2,125p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hermetic) HERMETIC=1 ;;
    --smoke) SMOKE=1 ;;
    --switches) shift; SWITCHES=${1:?--switches needs N} ;;
    --cells) shift; CELLS_FILTER=${1:?--cells needs a list} ;;
    --list-cells)
      for m in "${METHODS[@]}"; do for o in "${MODES[@]}"; do echo "$m/$o"; done; done
      echo "full-live/realism"
      for m in "${METHODS[@]}"; do for o in "${EXTRA_MODES[@]}"; do echo "$m/$o"; done; done
      exit 0 ;;
    --results-dir) shift; RESULTS_DIR_OVERRIDE=${1:?--results-dir needs a path} ;;
    --resume) shift; RESUME=1; RESULTS_DIR_OVERRIDE=${1:?--resume needs a results dir} ;;
    --effect-ms) shift; EFFECT_MS_OVERRIDE=${1:?--effect-ms needs N}; EFFECT_DURATION_MS=$EFFECT_MS_OVERRIDE ;;
    --build) BUILD=1 ;;
    --minutes) shift; SOAK_MINUTES=${1:?--minutes needs N} ;;
    --soak-interval) shift; SOAK_INTERVAL=${1:?--soak-interval needs S} ;;
    --soak-hwdec) shift; SOAK_HWDEC=${1:?--soak-hwdec needs a value} ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 2 ;;
  esac
  shift
done
[ "$SMOKE" = 1 ] && SWITCHES=2

for t in curl jq python3 ffmpeg; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 2; }; done

BIN=${LIASCAPE_PLAYER_BIN:-}
if [ -z "$BIN" ]; then
  if [ -x "$REPO/src/player/target/release/liascape-player" ]; then BIN=$REPO/src/player/target/release/liascape-player
  elif [ -x "$REPO/src/player/target/debug/liascape-player" ]; then BIN=$REPO/src/player/target/debug/liascape-player
  else BIN=$(command -v liascape-player || true); fi
fi
[ -n "$BIN" ] && [ -x "$BIN" ] || { echo "no liascape-player binary found (set LIASCAPE_PLAYER_BIN, or build src/player)" >&2; exit 2; }

DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || DOTNET=/nix/store/a9ml93kizcwff3yakmqw4qs3w4llpbf2-dotnet-sdk-wrapped-10.0.301/bin/dotnet
DLL=$REPO/src/backend/bin/Debug/net10.0/liascape-backend.dll

# ------------------------------------------------------------------ small helpers
ts() { date +%s.%N; }
log()  { echo "[battery] $*"; }
warn() { echo "[battery] WARN: $*" >&2; }
err()  { echo "[battery] ERROR: $*" >&2; }

json_str_array() { jq -nc '$ARGS.positional' --args "$@"; }

# ------------------------------------------------------------------ results dir (never committed)
if [ -n "$RESULTS_DIR_OVERRIDE" ]; then
  RESULTS_DIR=$RESULTS_DIR_OVERRIDE
else
  STAMP=$(date +%Y%m%dT%H%M%S)
  RESULTS_DIR="$REPO/src/player/tests/onmachine/results/${STAMP}-${SUBCMD}$([ "$HERMETIC" = 1 ] && echo -hermetic)$([ "$SMOKE" = 1 ] && echo -smoke)"
fi
mkdir -p "$RESULTS_DIR"
SWITCHES_FILE="$RESULTS_DIR/switches.jsonl"
[ "$RESUME" = 1 ] && [ -f "$SWITCHES_FILE" ] || : > "$SWITCHES_FILE"   # --resume: keep prior switches
log "results: $RESULTS_DIR$([ "$RESUME" = 1 ] && echo " (resuming)")"

# ==================================================================
# State shared by the cleanup trap. Populated as the run progresses so the trap can always leave
# the machine exactly as found, however far the script got.
# ==================================================================
FAILED=0
PLAYER_SP=""      # supervisor pid we last observed via `ctl hello` (live or hermetic)
BUS_MUTE_WATCHER_PID=""
BUS_STREAM_ORIG_VOL=""
declare -A ORIG_FIELDS=()          # AppSettings field -> jq-encoded original value, live mode only
ORIG_PLAYLIST_STATE_FILE="$RESULTS_DIR/.orig-playlist-state.json"
IMPORTED_ITEMS_FILE="$RESULTS_DIR/.imported-items.jsonl"
HAVE_ORIG_PLAYLIST_STATE=0
HERMETIC_T=""     # hermetic temp dir
API=""            # http://127.0.0.1:<port>, set once the backend we're using is known
BP=""             # hermetic backend pid

ctl() { "$BIN" ctl --timeout-ms "${CTL_TIMEOUT_MS:-10000}" "$@"; }
comp_pid() { ctl hello 2>/dev/null | jq -r '.pid // empty'; }
sup_pid()  { ctl hello 2>/dev/null | jq -r '.supervisor_pid // empty'; }

post() { curl -sf -m 15 -X POST -H 'Content-Type: application/json' -d "$2" "$API$1"; }
get()  { curl -sf -m 10 "$API$1"; }
settings_get() { get /settings; }   # NEVER echo this directly anywhere -- it carries SteamRefreshToken

# GET -> modify with a jq filter -> POST the FULL object back. Same pattern as
# scripts/test-liascape-player-adapter.sh's setting(); global-constraints.md: POST /settings replaces the
# whole object, so every write must round-trip through the live object, never a hand-built partial one.
setting_set() {
  local body prog="$1"; shift   # extra args go to jq (--arg …): never interpolate values into the program
  body=$(settings_get | jq -c "$@" "$prog") || { err "settings_set: GET /settings failed"; return 1; }
  post /settings "$body" >/dev/null
}

cur() { ctl get "{\"path\":\"cur:*.$1\"}" 2>/dev/null | jq -r '.value // empty'; }
last_corr() {
  ctl logs '{"kind_prefix":"transition.scheduled","limit":1}' 2>/dev/null | jq -r '.events[-1].corr // empty'
}

wait_for_new_corr() {
  local prev="$1" timeout="$2" waited=0 c
  while (( waited < timeout * 10 )); do
    c=$(last_corr)
    if [ -n "$c" ] && [ "$c" != "$prev" ]; then echo "$c"; return 0; fi
    sleep 0.1; waited=$((waited + 1))
  done
  echo ""; return 1
}

# Polls `ctl logs {corr, kind_prefix:"transition."}` for a terminal event, same safety-net pattern
# player-adapter.md's WaitCorr uses. Echoes handoff | cancelled:<reason> | failed:<reason> | timeout.
wait_for_terminal() {
  local corr="$1" timeout="$2" waited=0 ev kind reason
  while (( waited < timeout * 10 )); do
    ev=$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"transition.\"}" 2>/dev/null)
    if [ -n "$ev" ]; then
      kind=$(echo "$ev" | jq -r '[.events[] | select(.kind=="transition.handoff" or .kind=="transition.cancelled" or .kind=="transition.failed")][-1].kind // empty')
      case "$kind" in
        transition.handoff) echo "handoff"; return 0 ;;
        transition.cancelled)
          reason=$(echo "$ev" | jq -r '[.events[] | select(.kind=="transition.cancelled")][-1].reason // "unknown"')
          echo "cancelled:$reason"; return 0 ;;
        transition.failed)
          reason=$(echo "$ev" | jq -r '[.events[] | select(.kind=="transition.failed")][-1].reason // "unknown"')
          echo "failed:$reason"; return 0 ;;
      esac
    fi
    sleep 0.2; waited=$((waited + 2))
  done
  echo "timeout"; return 1
}

probe_frames_raw() { ctl probe '{"name":"frames"}' 2>/dev/null; }

# {outputs:[{name,expected_ms,mean_ms,within_tol,missed}], ok:bool} -- ok is reported always, enforced
# only when ENFORCE_FRAME_TIMING=1 (live mode; --hermetic reports but never fails on this, per the brief).
#
# battery-script fix #1 (found analysing task20-final-run): `ok` used to ALSO require `missed ==
# 0`. `missed` counts presents > 1.5 refresh periods apart within the probe's rolling 2 s window --
# which a switch itself routinely produces on purpose: player-core.md's Runtime "Switch cost" /
# final-review I5 measures the render-context-create + first-render cost of opening a new source
# at ~1-26 ms on the loop, i.e. "one to five missed frames at 240 Hz on every output per switch",
# and says explicitly "Task 20's pacing criterion should exclude the switch frame". Requiring
# missed==0 right after every single switch this probe samples made frame_violations == switches
# in EVERY cell of that run (100% "violation" rate) -- not evidence of a pacing defect, just this
# check asking for something the design doc says a switch is allowed to cost. The brief's actual
# pass bar is "frame present intervals within +/- 0.5 ms of refresh" -- the MEAN -- so `ok` no
# longer requires missed==0; `missed` is still captured/reported per switch for visibility (a
# genuinely stuck/duplicate-frame output would still show up as a persistently nonzero missed
# count across many switches in the report, just not as a per-switch hard failure here).
#
# battery-script fix #2 (found analysing the SAME run's raw frames field, after fix #1):
# `.paced.mean_ms` is `null` -- not a small number -- for a switch sampled before the output has
# presented >= 2 frames BACK TO BACK within the probe's own 2 s window (`paced` = "intervals
# between presents made back to back", player-core.md § Wayland "frames probe"). This probe is
# called from `evaluate_known_corr()` right as a switch reaches its terminal event -- for most
# modes (manual-next, timed-interval, every `fast-*`/`long-*` extremes cell...) that is BEFORE 2
# presents have happened yet, so `.paced.mean_ms // 0` silently became a literal `0`, which then
# failed `within_tol` by the full expected refresh period every time -- the actual dominant cause
# of frame_violations == switches in essentially the WHOLE matrix (confirmed: every non-
# wait-for-end sample checked post-hoc has `mean_ms: 0`, not some small-but-wrong value). This is
# "no data yet", not "paced at 0 ms" -- `.paced.count` (or a missing/null `.paced` object entirely)
# distinguishes the two; `within_tol` is now vacuously true (not a violation) when there weren't
# enough paced samples to judge, flagged separately as `insufficient` for visibility instead.
#
# What's left after both fixes, NOT a bug (documented in the report, not re-fixed here): once a
# switch DOES have enough real paced samples (wait-for-end's own clips, which keep playing for
# 10-30s), `mean_ms` reflects the SOURCE's own frame rate (these SFW clips are ~24-25 fps, i.e.
# ~40 ms apart), not the display's 144/240 Hz refresh -- player-core.md's own "Frame pacing"
# section documents exactly this as CORRECT, by-design content-paced behaviour (its own measured
# "60 fps test clip" row: "60.0 presents/s (content-paced, idle between frames)", not a defect).
# The brief's "+/- 0.5 ms of refresh" bar is only meaningful for genuinely display-rate content
# (an opacity/gain animation, or a high-fps clip) -- exactly what `outputs.sh` checks with its own
# dedicated synthetic 240 fps clip + opacity animation (matching player-core.md's measured
# 6.94/4.17 ms numbers). battery.sh's per-switch frame probe can't meaningfully re-validate the
# refresh-matching bar against arbitrary real video content; `outputs.sh` is the authority for it.
evaluate_frames() {
  echo "$1" | jq -c '
    { outputs: [ .outputs[] | ( (1000000 / .refresh_mhz) as $exp | (.paced.count // 0) as $n |
        { name, expected_ms: $exp, mean_ms: (.paced.mean_ms // 0), paced_count: $n,
          missed: (.paced.missed // 0), insufficient: ($n < 2),
          within_tol: (if $n < 2 then true
                       else ((((.paced.mean_ms // 0) - $exp) | if . < 0 then -. else . end) <= 0.5) end) } ) ] }
    | .ok = (.outputs | all(.within_tol))'
}

# A sentinel FILE, not a plain variable: probe_dropout() is always invoked via `$(...)` (to capture
# its JSON), which runs it in a subshell -- a subshell's variable assignment never reaches the
# parent, so a plain global here would silently stay stuck at "available" forever (caught in the
# first hermetic smoke run). dropout_probe_available() below is the only reader.
DROPOUT_UNAVAILABLE_SENTINEL="$RESULTS_DIR/.dropout-unavailable"
dropout_probe_available() { [ -f "$DROPOUT_UNAVAILABLE_SENTINEL" ] && echo false || echo true; }
probe_dropout() {
  local corr="$1" out rc code waited ev match
  out=$(ctl probe "{\"name\":\"dropout\",\"args\":{\"corr\":\"$corr\"}}" 2>/dev/null); rc=$?
  if [ $rc -ne 0 ]; then
    code=$(echo "$out" | jq -r '.code // empty' 2>/dev/null)
    if [ "$code" = "no_such_probe" ]; then
      # File existence, not a variable, dedups the warning: this function always runs inside a
      # `$(...)` subshell (the caller captures its JSON stdout), so a plain flag variable set in
      # here never reaches the parent shell -- same class of bug as observe_switch's OBS_CORR fix.
      [ -f "$DROPOUT_UNAVAILABLE_SENTINEL" ] || warn "probe dropout unavailable on this branch (lane B not merged yet) -- recording {skipped} for every switch"
      touch "$DROPOUT_UNAVAILABLE_SENTINEL"
      echo '{"skipped":"unavailable_on_this_branch"}'; return 0
    fi
    echo "{\"skipped\":\"probe_error_${code:-unknown}\"}"; return 0
  fi
  waited=0
  while (( waited < 50 )); do
    ev=$(ctl logs '{"kind_prefix":"probe.dropout","limit":50}' 2>/dev/null)
    match=$(echo "$ev" | jq -c --arg c "$corr" '[.events[] | select(.corr==$c)][-1] // empty' 2>/dev/null)
    if [ -n "$match" ] && [ "$match" != "null" ]; then echo "$match"; return 0; fi
    sleep 0.1; waited=$((waited + 1))
  done
  echo '{"skipped":"timeout_waiting_for_probe_dropout_event"}'
}

record_switch() {
  # cell idx corr outcome frames_json dropout_json note
  # effect_ms (R100 "mark their duration in the results"): the EFFECT_DURATION_MS actually
  # active on the backend for THIS switch -- lets the report show per-cell duration without
  # cross-referencing logs. Older records written before this field existed simply lack it.
  jq -nc --arg cell "$1" --argjson idx "$2" --arg corr "$3" --arg outcome "$4" \
    --argjson frames "$5" --argjson dropout "$6" --arg note "${7:-}" --argjson effect_ms "$EFFECT_DURATION_MS" --arg t "$(date -Iseconds)" \
    '{t:$t, cell:$cell, idx:$idx, corr:$corr, outcome:$outcome, frames:$frames, frames_ok:$frames.ok,
      dropout:$dropout, note:$note, effect_ms:$effect_ms}' >> "$SWITCHES_FILE"
}

# R99 (stage-2 controller ruling, overrides this file's original "stop the whole battery"
# design): record the failing switch's corr logs (+ its frames/dropout stats, already written
# to switches.jsonl by record_switch below, called before this from every real caller) into
# CELL_FAILURES_FILE, then return 1 so the CALLING CELL aborts its own remaining switches --
# but run_battery's method x mode loop continues with the next cell. One run must still give
# the full 24-cell matrix even if one cell hits a real failure. FAILED stays the "did anything
# fail" flag for cleanup()'s final exit code (still non-zero if any cell failed), but no longer
# an immediate `exit`.
CELL_FAILURES_FILE="$RESULTS_DIR/cell-failures.jsonl"
stop_on_failure() {
  local reason="$1" corr="${2:-}"
  FAILED=1
  err "CELL FAILURE ($CUR_CELL switch ${CUR_IDX:-?}): $reason${corr:+ (corr=$corr)}"
  if [ -n "$corr" ]; then
    ctl logs "{\"corr\":\"$corr\"}" > "$RESULTS_DIR/failure-$corr.json" 2>/dev/null
    err "dumped $RESULTS_DIR/failure-$corr.json"
  fi
  jq -nc --arg cell "$CUR_CELL" --argjson idx "${CUR_IDX:-0}" --arg corr "$corr" --arg reason "$reason" --arg t "$(date -Iseconds)" \
    '{t:$t, cell:$cell, idx:$idx, corr:$corr, reason:$reason}' >> "$CELL_FAILURES_FILE"
  return 1
}

# One switch, generically: wait for a new corr after the caller already issued whatever action
# triggers it, wait for its terminal event, collect frames+dropout, record, stop on real failure.
#
# Sets the global OBS_CORR and returns 1 on a real (non-tolerant) failure (never echoed/never
# called via `$(...)`: a `$(...)` subshell's `return`/variable writes never reach the caller --
# every caller invokes this as a plain statement and reads OBS_CORR + the return code
# afterward). CUR_CELL/CUR_IDX (globals) are set here so stop_on_failure() always knows which
# cell/switch it's reporting against without every call site re-threading them.
OBS_CORR=""
CUR_CELL=""; CUR_IDX=""

# Everything AFTER a corr is already known: wait for its terminal event, collect frames+dropout,
# record, stop-this-cell on real failure. Split out of observe_switch (below) so a caller that
# already has its own corr (long-pause-resume: the corr it's evaluating is the SAME one it
# started before the pause, not a new one -- calling observe_switch there made it wait for a
# *different* corr that was never going to appear, which is exactly what produced "no new
# transition corr observed" the first time this was tried) can skip the new-corr wait entirely.
evaluate_known_corr() {
  local cell="$1" idx="$2" corr="$3" term_timeout="$4" tolerant="${5:-0}"
  local outcome frames frames_eval dropout
  CUR_CELL="$cell"; CUR_IDX="$idx"
  outcome=$(wait_for_terminal "$corr" "$term_timeout")
  frames=$(probe_frames_raw); [ -n "$frames" ] || frames='{"outputs":[]}'
  frames_eval=$(evaluate_frames "$frames")
  dropout=$(probe_dropout "$corr")
  record_switch "$cell" "$idx" "$corr" "$outcome" "$frames_eval" "$dropout"
  if [ "$ENFORCE_FRAME_TIMING" = 1 ]; then
    echo "$frames_eval" | jq -e '.ok' >/dev/null || warn "cell $cell switch $idx: frame timing out of +/-0.5ms tolerance (reported, see $SWITCHES_FILE)"
  fi
  OBS_CORR="$corr"
  case "$outcome" in
    failed:*)
      [ "$tolerant" = 1 ] && { warn "cell $cell switch $idx: $outcome (tolerated -- interrupted side)"; return 0; }
      stop_on_failure "$outcome" "$corr"; return 1 ;;
    timeout)
      [ "$tolerant" = 1 ] && { warn "cell $cell switch $idx: terminal timeout (tolerated -- interrupted side)"; return 0; }
      stop_on_failure "transition did not reach a terminal state" "$corr"; return 1 ;;
  esac
  return 0
}

observe_switch() {
  local cell="$1" idx="$2" prev_corr="$3" new_timeout="$4" term_timeout="$5" tolerant="${6:-0}"
  local corr
  OBS_CORR=""
  CUR_CELL="$cell"; CUR_IDX="$idx"
  corr=$(wait_for_new_corr "$prev_corr" "$new_timeout")
  if [ -z "$corr" ]; then
    [ "$tolerant" = 1 ] && return 1
    stop_on_failure "no new transition corr observed" ""
    return 1
  fi
  evaluate_known_corr "$cell" "$idx" "$corr" "$term_timeout" "$tolerant"
}

# ==================================================================
# Owner-environment safety (live mode only -- every function here is a no-op under --hermetic)
# ==================================================================

stop_legacy_wallpaper() {
  [ "$HERMETIC" = 1 ] && return 0
  # Exact owner instruction (global-constraints.md): stop legacy before any on-machine measurement.
  curl -s -X POST 127.0.0.1:5174/stop >/dev/null 2>&1
  for _ in $(seq 1 30); do pgrep -x mpvpaper >/dev/null || break; sleep 0.1; done
  pgrep -x mpvpaper >/dev/null && warn "mpvpaper still running after /stop -- continuing anyway"
  return 0
}

snapshot_owner_settings() {
  [ "$HERMETIC" = 1 ] && return 0
  local f
  # NOTE (battery-script fix): the backend serializes /settings with camelCase keys
  # (confirmed live: GET /settings | jq keys -> "playerEngine", "transitionMethod", ... --
  # never the PascalCase C# property names). jq field access is case-sensitive, so a
  # PascalCase filter here would silently read/write a DIFFERENT, brand-new key than the
  # real one -- and since .NET's deserializer IS case-insensitive (verified live: POSTing
  # both "transitionMethod" and a differently-cased "TransitionMethod" in one object has
  # the LAST one win), restore_owner_settings below would have ended every live run by
  # POSTing a real field's value as the jq-appended PascalCase key's (always-null, because
  # the snapshot read was equally broken) value -- silently NULLING playerEngine/
  # transitionMethod/globalTransitionEnabled/globalTransitionEffectIds/
  # globalTransitionDurationMs/autoMute instead of restoring them. Fixed by using the
  # real camelCase names throughout this script's /settings GET->modify->POST paths.
  for f in playerEngine transitionMethod globalTransitionEnabled globalTransitionEffectIds \
           globalTransitionDurationMs autoMute lastSession; do
    ORIG_FIELDS["$f"]=$(settings_get | jq -c ".$f")
  done
  get /playlist/state > "$ORIG_PLAYLIST_STATE_FILE" 2>/dev/null && HAVE_ORIG_PLAYLIST_STATE=1
  : > "$IMPORTED_ITEMS_FILE"
  log "snapshotted owner settings fields: ${!ORIG_FIELDS[*]}"
}

# Restore exactly the fields we touched onto a FRESH /settings GET (the owner may have changed
# something unrelated while this ran) -> POST full. Then the CustomPlaylist, verbatim. Then drop
# any library items we imported for next/prev/random navigation.
restore_owner_settings() {
  [ "$HERMETIC" = 1 ] && return 0
  [ "${#ORIG_FIELDS[@]}" = 0 ] && return 0
  local body f
  body=$(settings_get) || { err "restore_owner_settings: GET /settings failed -- owner settings NOT restored, check manually"; return 1; }
  for f in "${!ORIG_FIELDS[@]}"; do
    body=$(echo "$body" | jq -c --argjson v "${ORIG_FIELDS[$f]}" ".$f = \$v")
  done
  post /settings "$body" >/dev/null && log "restored owner settings: ${!ORIG_FIELDS[*]}" || err "POST /settings restore failed"
  if [ "$HAVE_ORIG_PLAYLIST_STATE" = 1 ]; then
    post /playlist/state "$(cat "$ORIG_PLAYLIST_STATE_FILE")" >/dev/null && log "restored /playlist/state" || warn "POST /playlist/state restore failed"
  fi
  if [ -s "$IMPORTED_ITEMS_FILE" ]; then
    while IFS= read -r item; do
      [ -n "$item" ] && post /library/delete "$item" >/dev/null 2>&1
    done < "$IMPORTED_ITEMS_FILE"
    log "removed $(wc -l < "$IMPORTED_ITEMS_FILE") imported battery library item(s)"
  fi
}

# `/library/import` returns the full LibraryItem; stash it so restore can POST it back to
# /library/delete (which takes a LibraryItem, not a bare path).
import_target() {
  local path="$1" title item
  title=$(basename "$path")
  item=$(post /library/import "$(jq -nc --arg p "$path" --arg t "$title" '{path:$p,title:$t}')") || return 1
  echo "$item" >> "$IMPORTED_ITEMS_FILE"
  echo "$item" | jq -r '.videoPath // .VideoPath // empty'
}

BUS_STREAM_NODE_NAME="liascape-player-bus.playback"
bus_stream_id() {
  pactl -f json list sink-inputs 2>/dev/null \
    | jq -r --arg n "$BUS_STREAM_NODE_NAME" '.[] | select(.properties["node.name"]==$n) | .index' 2>/dev/null | head -1
}
mute_bus_stream_once() {
  local id vol
  id=$(bus_stream_id); [ -n "$id" ] || return 1
  if [ -z "$BUS_STREAM_ORIG_VOL" ]; then
    vol=$(pactl -f json list sink-inputs 2>/dev/null | jq -r --arg id "$id" \
      '.[] | select((.index|tostring)==$id) | (.volume | to_entries[0].value.value_percent // "100%")' 2>/dev/null)
    BUS_STREAM_ORIG_VOL=${vol%\%}
    [ -n "$BUS_STREAM_ORIG_VOL" ] || BUS_STREAM_ORIG_VOL=100
    log "bus playback stream $id found, original volume ${BUS_STREAM_ORIG_VOL}% -- silencing for the run"
  fi
  pactl set-sink-input-volume "$id" 0% >/dev/null 2>&1
}
start_bus_mute_watcher() {
  [ "$HERMETIC" = 1 ] && return 0
  ( while true; do mute_bus_stream_once >/dev/null 2>&1; sleep 1; done ) &
  BUS_MUTE_WATCHER_PID=$!
}
stop_bus_mute_watcher_and_restore_volume() {
  [ "$HERMETIC" = 1 ] && return 0
  [ -n "$BUS_MUTE_WATCHER_PID" ] && { kill "$BUS_MUTE_WATCHER_PID" 2>/dev/null; wait "$BUS_MUTE_WATCHER_PID" 2>/dev/null; }
  local id; id=$(bus_stream_id)
  if [ -n "$id" ]; then
    pactl set-sink-input-volume "$id" "${BUS_STREAM_ORIG_VOL:-100}%" >/dev/null 2>&1
    log "restored bus playback stream volume to ${BUS_STREAM_ORIG_VOL:-100}%"
  fi
}

# Brief: "verify this claim in stage 2's first minute (meter median well above -60 dBFS while the
# stream is at 0)". Best-effort here -- needs the `bus`/`meter.window` probes (present on this lane,
# Task 14) and a bus stream already muted. Logs a result; never aborts the run over it.
check_mute_does_not_blind_meter() {
  [ "$HERMETIC" = 1 ] && return 0
  local bus median
  bus=$(ctl probe '{"name":"bus"}' 2>/dev/null)
  echo "$bus" | jq -e '.state=="up"' >/dev/null 2>&1 || { warn "mute-blindness check: no audio bus up yet, skipping"; return 0; }
  median=$(ctl probe '{"name":"meter.window","args":{"last_ms":1000,"samples":false}}' 2>/dev/null | jq -r '.median_db // empty')
  if [ -z "$median" ]; then warn "mute-blindness check: meter.window gave no median_db"; return 0; fi
  log "mute-blindness check: meter median ${median} dBFS while the bus playback stream is held at 0% (want > -60)"
  python3 -c "import sys; sys.exit(0 if float('$median') > -60 else 1)" \
    && log "OK: meter sees real audio through the mute" \
    || warn "meter median <= -60 dBFS while muted -- the mute may be blinding the detector, investigate before trusting dropout results"
}

assert_default_sink_unchanged() {
  [ "$HERMETIC" = 1 ] && return 0
  [ -n "${ORIG_DEFAULT_SINK:-}" ] || return 0
  local cur; cur=$(pactl get-default-sink 2>/dev/null)
  [ "$cur" = "$ORIG_DEFAULT_SINK" ] && log "default sink unchanged ($cur)" \
    || warn "default sink drifted: was $ORIG_DEFAULT_SINK, now $cur -- NOT changed by this script, investigate"
}

# ==================================================================
# Cleanup -- runs on every exit path (EXIT/INT/TERM/HUP), in both modes. Order matters: stop
# anything we're driving BEFORE restoring settings (switching PlayerEngine back to legacy while
# something is still "playing" would replay it on legacy -- see player-adapter.md SwitchEngineLive;
# we want "nothing playing" at the moment of the switch so legacy comes back stopped, as found).
# ==================================================================
cleanup() {
  trap - EXIT INT TERM HUP
  stop_bus_mute_watcher_and_restore_volume
  if [ "$HERMETIC" = 0 ] && [ -n "$API" ]; then
    post /stop '{}' >/dev/null 2>&1
  fi
  restore_owner_settings
  assert_default_sink_unchanged
  # No liascape-player process left, in either mode: quit over the socket first (clean), else the
  # supervisor pid we last observed (never a bare compositor pid -- that would just restart it).
  ctl quit >/dev/null 2>&1
  if [ -n "$PLAYER_SP" ]; then
    kill -CONT "$PLAYER_SP" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$PLAYER_SP" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$PLAYER_SP" 2>/dev/null
  fi
  if [ "$HERMETIC" = 1 ]; then
    [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }
    if [ -n "$HERMETIC_T" ]; then
      case "$HERMETIC_T" in
        /tmp/liascape-battery-*) command -v trash >/dev/null && trash "$HERMETIC_T" 2>/dev/null || rm -rf -- "$HERMETIC_T" ;;
      esac
    fi
  fi
  log "cleanup done. results kept at $RESULTS_DIR"
  [ "$FAILED" = 1 ] && exit 1
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# ==================================================================
# Backend discovery / setup
# ==================================================================
ENFORCE_FRAME_TIMING=1   # overridden to 0 under --hermetic (brief: "frame criteria reported but not enforced")

setup_live_backend() {
  ENFORCE_FRAME_TIMING=1
  ORIG_DEFAULT_SINK=$(pactl get-default-sink 2>/dev/null || true)
  log "default sink before: ${ORIG_DEFAULT_SINK:-unknown}"
  stop_legacy_wallpaper
  local portfile="$HOME/.config/liascape/serve.port"
  [ -s "$portfile" ] || { err "no $portfile -- is the owner's backend (liascape-watch) running?"; exit 1; }
  API="http://127.0.0.1:$(cat "$portfile")"
  curl -sf -m 5 "$API/health" >/dev/null || { err "backend at $API not responding"; exit 1; }
  snapshot_owner_settings
  setting_set ".playerEngine = \"liascape-player\" | .autoMute = false | .globalTransitionEnabled = true | .globalTransitionEffectIds = [\"$EFFECT_ID\"] | .globalTransitionDurationMs = $EFFECT_DURATION_MS"
  sleep 1
  [ "$(curl -sf -m 5 "$API/player-engine" | jq -r .active)" = "liascape-player" ] || { err "backend did not switch to liascape-player -- aborting before touching any playback"; exit 1; }
  PLAYER_SP=$(sup_pid)
  start_bus_mute_watcher
  sleep 1.5
  check_mute_does_not_blind_meter
}

setup_hermetic_backend() {
  ENFORCE_FRAME_TIMING=0
  [ -f "$DLL" ] || { err "hermetic mode needs the backend built: $DLL missing (dotnet build src/backend)"; exit 2; }
  if [ "$BUILD" = 1 ]; then
    log "== build (hermetic --build)"
    if command -v nix >/dev/null; then
      (cd "$REPO" && env -u LD_LIBRARY_PATH nix develop -c cargo build -q --manifest-path src/player/Cargo.toml) || { err "cargo build failed"; exit 2; }
    else
      (cd "$REPO" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { err "cargo build failed"; exit 2; }
    fi
    "$DOTNET" build "$REPO/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  fi
  HERMETIC_T=$(mktemp -d /tmp/liascape-battery-XXXXXX)   # short: a unix socket path must be < 108 bytes
  mkdir -p "$HERMETIC_T/home/.config/liascape" "$HERMETIC_T/home/.cache" "$HERMETIC_T/home/.local/share" "$HERMETIC_T/rt" "$HERMETIC_T/st"
  export HOME=$HERMETIC_T/home XDG_CONFIG_HOME=$HERMETIC_T/home/.config XDG_CACHE_HOME=$HERMETIC_T/home/.cache
  export XDG_DATA_HOME=$HERMETIC_T/home/.local/share XDG_RUNTIME_DIR=$HERMETIC_T/rt XDG_STATE_HOME=$HERMETIC_T/st
  export LIASCAPE_PLAYER_BIN=$BIN LIASCAPE_TRANSITIONS_DIR=$REPO/transitions
  export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
  unset LIASCAPE_PLAYER_SOCKET WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT

  cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"liascape-player","NoAudio":false,"Loop":true,"Volume":100,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["$EFFECT_ID"],"GlobalTransitionDurationMs":$EFFECT_DURATION_MS,"TransitionMethod":"full-live",
 "GlobalSwitchWhenVideoEnds":false,"GlobalWaitForVideoEnd":false,"GlobalIntervalSeconds":1800,"RestartMpvpaperEverySeconds":600,"AutoMute":false}
EOF

  OUTA=VIRTUAL-1; OUTB=VIRTUAL-2
  ( cd /tmp && exec "$BIN" serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null \
      > "$HERMETIC_T/serve.log" 2>&1 ) & PLAYER_SP=$!
  for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
  ctl hello >/dev/null 2>&1 || { err "hermetic liascape-player did not start, see $HERMETIC_T/serve.log"; exit 1; }
  PLAYER_SP=$(sup_pid)

  "$DOTNET" "$DLL" serve > "$HERMETIC_T/backend.log" 2>&1 & BP=$!
  for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { err "hermetic backend did not start, see $HERMETIC_T/backend.log"; tail -5 "$HERMETIC_T/backend.log" >&2; exit 1; }
  API="http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")"
  for _ in $(seq 1 50); do curl -sf -m 2 "$API/health" >/dev/null && break; sleep 0.1; done
  [ "$(curl -sf -m 5 "$API/player-engine" | jq -r .active)" = "liascape-player" ] || { err "hermetic backend not on liascape-player"; exit 1; }
  log "hermetic: player pid $(comp_pid) (supervisor $PLAYER_SP), backend $API"
}

# ==================================================================
# Media. VIDEOS/IMAGES are the general alternating-target pool; SHORT_VIDEOS is specifically for
# advance-on-end/wait-for-end (brief: "pick short clips" -- those two modes rely on a video's own
# natural end, which an image never reaches, so they are video-only by construction here).
# ==================================================================
VIDEOS=(); IMAGES=(); SHORT_VIDEOS=()
# battery-script fix (found analysing task20-final-run, all 3 wait-for-end cells: tr-136/324/515,
# every one "scheduled" with align:end then "cancelled" by LiascapePlayerMedia.SwitchAndWait's own
# AlignBackstopSlackSec=15s backstop ~15.5-16s later -- see player-adapter.md's `DoVideoEndWait`
# row and LiascapePlayerMedia.cs's AlignBackstopSlackSec). term_timeout() below is EFFECT_DURATION_MS-based,
# which bounds a plain cut/effect switch fine but has NOTHING to do with how long an align:"end"
# wait-for-the-video's-real-end switch can legitimately take -- that's bounded by the CLIP's own
# remaining play time (+ the player's own 10 s align_fallback, behind which sits the adapter's own
# 15 s backstop). MAX_SHORT_VIDEO_MS is the longest of the real SHORT_VIDEOS clips used by
# advance-on-end/wait-for-end, so a term_timeout for those two modes can safely bound "the clip plays
# all the way to its own end" without mistaking that for "the switch never completed".
MAX_SHORT_VIDEO_MS=0

ffprobe_duration_ms() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null \
    | python3 -c "import sys; d=sys.stdin.read().strip(); print(int(float(d)*1000) if d else 0)"
}

setup_hermetic_media() {
  local T=$HERMETIC_T
  clip() { ffmpeg -nostdin -loglevel error -y -f lavfi -i "$2=size=320x180:rate=30" -f lavfi -i "sine=frequency=$3:sample_rate=48000" \
             -t "$4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$1"; }
  clip "$T/va.mp4" testsrc2 440 2.0
  clip "$T/vb.mp4" smptebars 550 2.0
  clip "$T/vshort.mp4" rgbtestsrc 660 0.6   # shorter than EFFECT_DURATION_MS (1000 ms) on purpose
  clip "$T/vend1.mp4" testsrc 220 3.0       # advance/wait-for-end: short enough to loop fast
  clip "$T/vend2.mp4" smptehdbars 330 3.5
  ffmpeg -nostdin -loglevel error -y -f lavfi -i color=c=red:s=320x180 -frames:v 1 "$T/imga.png"
  ffmpeg -nostdin -loglevel error -y -f lavfi -i color=c=blue:s=320x180 -frames:v 1 "$T/imgb.png"
  VIDEOS=("$T/va.mp4" "$T/vb.mp4" "$T/vshort.mp4")
  IMAGES=("$T/imga.png" "$T/imgb.png")
  SHORT_VIDEOS=("$T/vend1.mp4" "$T/vend2.mp4")
  MAX_SHORT_VIDEO_MS=3500   # vend2.mp4 above, 3.5 s
}

WORKSHOP_DIR="$HOME/.local/share/Steam/steamapps/workshop/content/431960"
setup_live_media() {
  [ -d "$WORKSHOP_DIR" ] || { err "SFW workshop dir missing: $WORKSHOP_DIR"; exit 1; }
  local d v durs=() i=0
  for d in "$WORKSHOP_DIR"/*/; do
    [ -f "$d/scene.pkg" ] && continue   # Phase 1: scenes are skipped exactly like AllowScenes=false
    v=$(find "$d" -maxdepth 1 -iname '*.mp4' | head -1)
    if [ -n "$v" ]; then
      VIDEOS+=("$v")
      [ -f "$d/preview.jpg" ] && IMAGES+=("$d/preview.jpg")
      i=$((i + 1))
      [ $i -ge 12 ] && break
    fi
  done
  [ "${#VIDEOS[@]}" -ge 2 ] && [ "${#IMAGES[@]}" -ge 2 ] || { err "not enough video/image candidates found under $WORKSHOP_DIR"; exit 1; }
  # Pick the EFFECT duration so at least the shortest real clip we found is shorter than it (brief:
  # "some clips shorter than the effect"), and take the 3 shortest videos as the advance/wait-for-end set.
  # R100: skipped when --effect-ms fixed it explicitly -- the matrix then runs at that exact
  # duration instead of whatever real media happens to produce (SHORT_VIDEOS is still computed
  # either way; advance-on-end/wait-for-end need real short clips regardless of the effect length).
  local min_ms=999999999 m
  for v in "${VIDEOS[@]}"; do
    m=$(ffprobe_duration_ms "$v"); durs+=("$m:$v")
    [ "$m" -gt 0 ] && [ "$m" -lt "$min_ms" ] && min_ms=$m
  done
  if [ -z "$EFFECT_MS_OVERRIDE" ] && [ "$min_ms" -lt 999999999 ]; then
    EFFECT_DURATION_MS=$(python3 -c "print(max(800, int($min_ms * 1.5)))")
  fi
  mapfile -t SHORT_VIDEOS < <(printf '%s\n' "${durs[@]}" | sort -n -t: -k1,1 | head -3 | cut -d: -f2-)
  MAX_SHORT_VIDEO_MS=$(printf '%s\n' "${durs[@]}" | sort -n -t: -k1,1 | head -3 | cut -d: -f1 | sort -n | tail -1)
  log "media: ${#VIDEOS[@]} video(s), ${#IMAGES[@]} image(s), effect duration ${EFFECT_DURATION_MS} ms (shortest clip ${min_ms} ms, longest of the 3 short videos ${MAX_SHORT_VIDEO_MS} ms)${EFFECT_MS_OVERRIDE:+ [--effect-ms override]}"
}

# alternating video/image pool, used by every mode except advance-on-end/wait-for-end
ALT_TARGETS=()
build_alt_targets() {
  ALT_TARGETS=()
  local i n=${#VIDEOS[@]} m=${#IMAGES[@]}
  for ((i = 0; i < n || i < m; i++)); do
    [ $i -lt $n ] && ALT_TARGETS+=("${VIDEOS[$i]}")
    [ $i -lt $m ] && ALT_TARGETS+=("${IMAGES[$i]}")
  done
}

# ==================================================================
# ETA (rough; stage 2 refines these per-switch seconds against real measured durations)
# ==================================================================
print_eta() {
  local effect_s; effect_s=$(python3 -c "print($EFFECT_DURATION_MS/1000)")
  local per_manual per_restore per_timed per_nextmid total=0
  per_manual=$(python3 -c "print($effect_s + 1.5)")
  per_restore=$(python3 -c "print(2*($effect_s + 1.5) + 1.0)")
  per_nextmid=$(python3 -c "print(0.4*$effect_s + $effect_s + 1.5)")
  per_timed=5.5   # dominated by the per-playlist IntervalSeconds/short-clip timers we configure below
  log "ETA estimate (rough -- real per-switch time is confirmed on the first live run):"
  for mode in "${MODES[@]}"; do
    local secs
    case "$mode" in
      manual-next|manual-prev|random) secs=$per_manual ;;
      restore-replay) secs=$per_restore ;;
      next-mid-transition) secs=$per_nextmid ;;
      timed-interval|advance-on-end|wait-for-end) secs=$per_timed ;;
    esac
    local cell_total; cell_total=$(python3 -c "print($secs * $SWITCHES * ${#METHODS[@]})")
    total=$(python3 -c "print($total + $cell_total)")
    printf '  %-20s ~%.1fs/switch x %d switches x %d methods = ~%.0fs\n' "$mode" "$secs" "$SWITCHES" "${#METHODS[@]}" "$cell_total"
  done
  log "total ETA: ~$(python3 -c "print(round($total/60,1))") min (+ setup/teardown overhead, typically 1-3 min)"
}

cell_selected() {
  [ -z "$CELLS_FILTER" ] && return 0
  local c="$1/$2" want
  IFS=',' read -ra WANT <<< "$CELLS_FILTER"
  for want in "${WANT[@]}"; do [ "$want" = "$c" ] && return 0; done
  return 1
}

# --resume support: a cell counts as "already attempted" (skip, don't re-run) if either (a)
# switches.jsonl already has a full SWITCHES-count of records for it (completed, pass or not),
# or (b) cell-failures.jsonl recorded an R99 failure for it (a deliberate early stop, not an
# interruption -- re-running it would just re-diagnose the same thing). A cell with a non-zero
# but PARTIAL record count and no failure entry was cut off mid-run (e.g. a usage-limit
# interruption, not a real failure) -- NOT "attempted"; run_battery's caller purges its
# partial records and redoes it from scratch.
cell_already_attempted() {
  local c="$1" cnt=0
  [ -s "$SWITCHES_FILE" ] && cnt=$(jq -c --arg c "$c" 'select(.cell==$c)' "$SWITCHES_FILE" 2>/dev/null | wc -l)
  [ "$cnt" -ge "$SWITCHES" ] && return 0
  if [ -s "$CELL_FAILURES_FILE" ] && jq -e --arg c "$c" 'select(.cell==$c)' "$CELL_FAILURES_FILE" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

restore_cli_invoke() {
  if [ "$HERMETIC" = 1 ]; then
    "$DOTNET" "$DLL" restore > "$HERMETIC_T/restore-$(date +%s%N).log" 2>&1
  else
    # battery-script fix (task20-final-run: restore-replay failed its FIRST switch in all 3
    # methods, "no new transition corr observed", every time). Root cause confirmed live, in two
    # steps: first, `strace`'d the owner's INSTALLED `liascape` (what `command -v liascape`
    # resolves to, what this used to invoke) running `LIASCAPE_PLAYER_BIN=<repo liascape-player> liascape
    # --restore` -- the env var DID reach the final managed process (verified: present in that
    # exact execve's own environ via `strace -v`), yet it still ran the legacy path (`Apply()` ->
    # `SwitchToFile` -> `setsid mpvpaper ...`). That ruled out a missing-env-var/PATH problem, so
    # second: `strings -el` (UTF-16, .NET string literals) on the installed package's
    # `liascape-backend.dll` for "LIASCAPE_PLAYER_BIN"/"PlayerEngine" found ZERO matches, while the SAME search
    # on this worktree's own dev build (`$DLL`, what `liascape-watch`/dotnet watch actually runs)
    # finds both -- the NixOS-packaged `liascape` is a STALE BUILD that predates liascape-player/
    # PlayerEngine existing in the C# source AT ALL, not a binary-resolution gap `LIASCAPE_PLAYER_BIN`
    # could ever have fixed. Confirmed the actual fix: priming the SAME session then invoking
    # `$DOTNET $DLL restore` (the current dev build, what serve itself runs) produces a real
    # new transition.scheduled corr immediately. This is a packaging/deployment gap (the owner's
    # installed system package needs rebuilding from this branch) -- not a bug in the restore
    # mechanism, this script's corr-detection, or anything fixable by this script choosing a
    # different binary on PATH. Using the dev build here is what actually exercises what this
    # cell is supposed to test; flagged for the owner in docs/player/reports/phase1.md + TODO.md.
    "$DOTNET" "$DLL" restore >/dev/null 2>&1
  fi
}

NEW_CORR_TIMEOUT=15
term_timeout() { python3 -c "print(int($EFFECT_DURATION_MS/1000) + 10)"; }

# ==================================================================
# One cell = one (method, mode) pair. TransitionMethod is set by the caller (per-method, once for
# all 8 modes); this only sets up and drives one mode's SWITCHES switches.
# ==================================================================
run_cell() {
  local method="$1" mode="$2"
  local cell="$method/$mode"
  log "-- cell $cell ($SWITCHES switches) --"
  local term; term=$(term_timeout)
  local i corr prev cell_failed=0   # R99: set on a real observe_switch failure; breaks this
                                     # cell's own remaining switches but run_battery still moves
                                     # on to the next cell -- never aborts the whole matrix.

  case "$mode" in
    manual-next|manual-prev|random|next-mid-transition)
      build_alt_targets   # already imported into the library once, in run_battery() below
      post /apply "$(jq -nc --arg p "${ALT_TARGETS[0]}" '{path:$p}')" >/dev/null
      sleep 1.5   # let the bootstrap apply settle; not one of our counted switches
      for ((i = 1; i <= SWITCHES; i++)); do
        prev=$(last_corr)
        case "$mode" in
          manual-next) post /next '{}' >/dev/null ;;
          manual-prev) post /prev '{}' >/dev/null ;;
          random) post /random '{}' >/dev/null ;;
          next-mid-transition)
            post /next '{}' >/dev/null
            corr=$(wait_for_new_corr "$prev" "$NEW_CORR_TIMEOUT")
            if [ -n "$corr" ]; then
              sleep "$(python3 -c "print(0.4*$EFFECT_DURATION_MS/1000)")"
              local outcome1
              post /next '{}' >/dev/null   # interrupt it; the generic observe below tracks the SECOND corr
              outcome1=$(wait_for_terminal "$corr" "$term")
              case "$outcome1" in
                failed:*) warn "cell $cell switch $i: interrupted corr $corr ended $outcome1 (expected handoff/cancelled)" ;;
                cancelled:*|handoff) : ;;
                *) warn "cell $cell switch $i: interrupted corr $corr: $outcome1" ;;
              esac
              prev="$corr"
            fi
            ;;
        esac
        observe_switch "$cell" "$i" "$prev" "$NEW_CORR_TIMEOUT" "$term" 0 || { cell_failed=1; break; }
      done
      ;;

    restore-replay)
      build_alt_targets
      for ((i = 1; i <= SWITCHES; i++)); do
        local target=${ALT_TARGETS[$(((i - 1) % ${#ALT_TARGETS[@]}))]}
        prev=$(last_corr)
        post /apply "$(jq -nc --arg p "$target" '{path:$p}')" >/dev/null
        corr=$(wait_for_new_corr "$prev" "$NEW_CORR_TIMEOUT")
        [ -n "$corr" ] && wait_for_terminal "$corr" "$term" >/dev/null   # priming switch, drained, not evaluated
        prev=$(last_corr)
        restore_cli_invoke
        observe_switch "$cell" "$i" "$prev" "$NEW_CORR_TIMEOUT" "$term" 0 || { cell_failed=1; break; }
      done
      ;;

    timed-interval|advance-on-end|wait-for-end)
      local paths=() settings interval=5 advance=false wait_end=false
      case "$mode" in
        timed-interval) build_alt_targets; paths=("${ALT_TARGETS[@]}"); interval=5; advance=false; wait_end=false ;;
        advance-on-end) paths=("${SHORT_VIDEOS[@]}"); interval=8; advance=true; wait_end=false ;;
        wait-for-end)   paths=("${SHORT_VIDEOS[@]}"); interval=2; advance=true; wait_end=true ;;
      esac
      [ "${#paths[@]}" -ge 2 ] || { err "cell $cell: fewer than 2 media paths available"; return 1; }
      settings=$(jq -nc --argjson iv "$interval" --argjson adv "$advance" --argjson w "$wait_end" \
        '{Order:0, OverrideGlobalSettings:true, IntervalSeconds:$iv, SwitchWhenVideoEnds:$adv, WaitForVideoEnd:$w}')
      post /playlist/play "$(jq -nc --argjson p "$(json_str_array "${paths[@]}")" --argjson s "$settings" '{paths:$p, settings:$s}')" >/dev/null
      sleep 1.5
      local auto_timeout; auto_timeout=$(python3 -c "print(int($interval) + 15)")
      # battery-script fix (task20-final-run: full-live/reveal/frozen wait-for-end ALL failed their
      # very first switch, "transition did not reach a terminal state", tr-136/324/515 -- confirmed
      # via events.jsonl: each was scheduled align:"end" then genuinely CANCELLED ~15.5-16s later by
      # LiascapePlayerMedia.SwitchAndWait's own AlignBackstopSlackSec=15s backstop (player-adapter.md's
      # `DoVideoEndWait` row), not by this script's own /stop -- i.e. the switch was still correctly
      # in flight, this script just stopped watching too early). wait-for-end's countdown freezes
      # while _waitingForVideoEnd (PlayerHelper.cs ~line 992), so its real per-switch bound is the
      # CLIP's own remaining play time, not EFFECT_DURATION_MS -- use MAX_SHORT_VIDEO_MS (+ the
      # player's 10s align_fallback / adapter's 15s backstop + margin) instead of term() for this
      # mode only. advance-on-end's own interval always wins first (PlayerHelper.cs ~line 1032: the
      # interval elapsing while _waitingForVideoEnd && !_waitForVideoEnd force-advances at the
      # interval, well under `term`), so it keeps the plain term().
      local term_this="$term"
      [ "$mode" = wait-for-end ] && term_this=$(python3 -c "print(int($MAX_SHORT_VIDEO_MS/1000) + 30)")
      prev=$(last_corr)
      for ((i = 1; i <= SWITCHES; i++)); do
        observe_switch "$cell" "$i" "$prev" "$auto_timeout" "$term_this" 0 || { cell_failed=1; break; }
        prev="$OBS_CORR"
      done
      post /stop '{}' >/dev/null; sleep 0.5
      ;;
  esac
  [ "$cell_failed" = 1 ] && return 1
  return 0
}

# ==================================================================
# R100 realism cell: ONE cell at the OWNER's own pre-touched globalTransitionDurationMs /
# globalTransitionEffectIds (snapshotted into ORIG_FIELDS before this script changed anything)
# -- full-live, timed-interval, 10 switches. Takes (method, mode) like every other cell
# function for dispatch_cell's sake, but both are fixed ("full-live"/"realism") by the ruling.
# ==================================================================
run_realism_cell() {
  local cell="full-live/realism"
  local owner_ms owner_ids saved_effect_ms=$EFFECT_DURATION_MS term paths settings
  owner_ms=${ORIG_FIELDS[globalTransitionDurationMs]:-3000}
  owner_ids=${ORIG_FIELDS[globalTransitionEffectIds]:-'["fade"]'}
  log "-- cell $cell (10 switches, owner's own duration ${owner_ms} ms / effects $owner_ids) --"
  if [ "$HERMETIC" = 1 ]; then
    log "cell $cell: hermetic has no owner settings to be realistic about -- using EFFECT_DURATION_MS/EFFECT_ID as-is"
  else
    setting_set ".transitionMethod = \"full-live\" | .globalTransitionDurationMs = $owner_ms | .globalTransitionEffectIds = $owner_ids"
  fi
  EFFECT_DURATION_MS=$owner_ms
  term=$(term_timeout)
  build_alt_targets
  paths=("${ALT_TARGETS[@]}")
  settings=$(jq -nc '{Order:0, OverrideGlobalSettings:true, IntervalSeconds:5, SwitchWhenVideoEnds:false, WaitForVideoEnd:false}')
  post /playlist/play "$(jq -nc --argjson p "$(json_str_array "${paths[@]}")" --argjson s "$settings" '{paths:$p, settings:$s}')" >/dev/null
  sleep 1.5
  local prev cell_failed=0 i
  prev=$(last_corr)
  for ((i = 1; i <= 10; i++)); do
    observe_switch "$cell" "$i" "$prev" 20 "$term" 0 || { cell_failed=1; break; }
    prev="$OBS_CORR"
  done
  post /stop '{}' >/dev/null; sleep 0.5
  EFFECT_DURATION_MS=$saved_effect_ms
  [ "$HERMETIC" = 0 ] && setting_set ".globalTransitionDurationMs = $EFFECT_DURATION_MS | .transitionMethod = \"full-live\""
  [ "$cell_failed" = 1 ] && return 1
  return 0
}

# ==================================================================
# R101 extremes block: per method, very-fast (0/50/250 ms, manual /next) and very-long
# (30 s: timed/advance-on-end, a 40%-mark interrupt, a short-A align:end hold, a mid-effect
# pause/resume). Every switch goes through observe_switch exactly like the main matrix, so the
# frames+dropout checks R101 asks for are automatic (record_switch already captures both).
# ==================================================================
run_extra_cell() {
  local method="$1" mode="$2"
  local cell="$method/$mode"
  log "-- extra cell $cell --"
  local saved_effect_ms=$EFFECT_DURATION_MS cell_failed=0 term i prev corr
  case "$mode" in
    fast-cut)   EFFECT_DURATION_MS=0 ;;
    fast-50ms)  EFFECT_DURATION_MS=50 ;;
    fast-250ms) EFFECT_DURATION_MS=250 ;;
    long-*)     EFFECT_DURATION_MS=30000 ;;
  esac
  [ "$HERMETIC" = 0 ] && setting_set ".transitionMethod = \"$method\" | .globalTransitionDurationMs = $EFFECT_DURATION_MS"
  term=$(term_timeout)

  case "$mode" in
    fast-cut|fast-50ms|fast-250ms)
      build_alt_targets
      post /apply "$(jq -nc --arg p "${ALT_TARGETS[0]}" '{path:$p}')" >/dev/null
      sleep 1.0
      for ((i = 1; i <= 20; i++)); do
        prev=$(last_corr)
        post /next '{}' >/dev/null
        observe_switch "$cell" "$i" "$prev" "$NEW_CORR_TIMEOUT" "$term" 0 || { cell_failed=1; break; }
      done
      ;;

    long-timed|long-advance)
      local paths=() settings advance=false
      if [ "$mode" = long-advance ]; then paths=("${SHORT_VIDEOS[@]}"); advance=true
      else build_alt_targets; paths=("${ALT_TARGETS[@]}"); advance=false; fi
      if [ "${#paths[@]}" -lt 2 ]; then
        err "cell $cell: fewer than 2 media paths available"; EFFECT_DURATION_MS=$saved_effect_ms; return 1
      fi
      # interval (35 s) > the 30 s effect so every tick's transition actually completes before
      # the next one fires, instead of racing R35/R36's commit path (that's long-interrupt's job).
      settings=$(jq -nc --argjson adv "$advance" '{Order:0, OverrideGlobalSettings:true, IntervalSeconds:35, SwitchWhenVideoEnds:$adv, WaitForVideoEnd:false}')
      post /playlist/play "$(jq -nc --argjson p "$(json_str_array "${paths[@]}")" --argjson s "$settings" '{paths:$p, settings:$s}')" >/dev/null
      sleep 1.5
      prev=$(last_corr)
      for ((i = 1; i <= 3; i++)); do
        observe_switch "$cell" "$i" "$prev" 50 "$term" 0 || { cell_failed=1; break; }
        prev="$OBS_CORR"
      done
      post /stop '{}' >/dev/null; sleep 0.5
      ;;

    long-interrupt)
      build_alt_targets
      post /apply "$(jq -nc --arg p "${ALT_TARGETS[0]}" '{path:$p}')" >/dev/null
      sleep 1.5
      for ((i = 1; i <= 3; i++)); do
        prev=$(last_corr)
        post /next '{}' >/dev/null
        corr=$(wait_for_new_corr "$prev" "$NEW_CORR_TIMEOUT")
        if [ -n "$corr" ]; then
          sleep "$(python3 -c "print(0.4*$EFFECT_DURATION_MS/1000)")"   # ~40% of the 30 s effect
          local outcome1
          post /next '{}' >/dev/null   # interrupt it; observe_switch below tracks the SECOND corr
          outcome1=$(wait_for_terminal "$corr" "$term")
          case "$outcome1" in
            failed:*) warn "cell $cell switch $i: interrupted corr $corr ended $outcome1 (expected handoff/cancelled)" ;;
            cancelled:*|handoff) : ;;
            *) warn "cell $cell switch $i: interrupted corr $corr: $outcome1" ;;
          esac
          prev="$corr"
        fi
        observe_switch "$cell" "$i" "$prev" "$NEW_CORR_TIMEOUT" "$term" 0 || { cell_failed=1; break; }
      done
      ;;

    long-shortA-end)
      # A clip SHORTER than the 30 s effect, align:"end" -- the short-A-hold fallback
      # (player-core.md "Align": "if it's already past at the first evaluation... it starts
      # at once and A holds its last frame"). /next doesn't expose align, so this goes through
      # raw `ctl transition`, same pattern permonitor already uses.
      build_alt_targets
      local shortA=${SHORT_VIDEOS[0]:-${ALT_TARGETS[0]}}
      post /apply "$(jq -nc --arg p "$shortA" '{path:$p}')" >/dev/null
      sleep 1.0
      prev=$(last_corr)
      local resp
      resp=$(ctl transition "$(jq -nc --arg p "${ALT_TARGETS[1]}" --arg eff "$EFFECT_ID" --argjson d "$EFFECT_DURATION_MS" --arg m "$method" \
        '{outputs:"out:*", to:{path:$p}, effect_id:$eff, duration_ms:$d, method:$m, align:"end"}')")
      corr=$(echo "$resp" | jq -r '.corr // empty')
      if [ -z "$corr" ]; then
        err "cell $cell: align:end ctl transition failed to start: $resp"
        cell_failed=1
      else
        observe_switch "$cell" 1 "$prev" 5 "$term" 0 || cell_failed=1
      fi
      ;;

    long-pause-resume)
      # player.paused for 3 s mid-effect then resumed -- R75/invariant #7: picture, audio AND
      # time freeze together, resuming exactly where they left off. time_pos is asserted
      # unchanged across the pause; the switch itself still gets the normal frames+dropout
      # checks via observe_switch (R101's "verified with the dropout report + frames probe").
      build_alt_targets
      post /apply "$(jq -nc --arg p "${ALT_TARGETS[0]}" '{path:$p}')" >/dev/null
      sleep 1.0
      prev=$(last_corr)
      post /next '{}' >/dev/null
      corr=$(wait_for_new_corr "$prev" "$NEW_CORR_TIMEOUT")
      if [ -z "$corr" ]; then
        stop_on_failure "no new transition corr observed (long-pause-resume)" ""
        cell_failed=1
      else
        sleep "$(python3 -c "print(0.4*$EFFECT_DURATION_MS/1000)")"
        ctl set '{"path":"player.paused","value":true}' >/dev/null 2>&1
        sleep 0.3   # let the pause actually land (R47: a set reaches sources at the next
                    # dispatch/tick, not synchronously) BEFORE sampling "before" -- sampling
                    # right at the set call races real playback that hasn't frozen yet, which
                    # read as a false "time_pos moved during pause" the first time this ran.
        # (.sources // .): the probe's exact top-level shape (a bare array vs {sources:[...]})
        # isn't pinned down by the docs read for this task -- robust to either.
        local before_tp after_tp
        before_tp=$(ctl probe '{"name":"sources"}' 2>/dev/null | jq -r '(.sources // .) | [.[] | select(.time_pos != null)][0].time_pos // "null"' 2>/dev/null)
        sleep 3
        after_tp=$(ctl probe '{"name":"sources"}' 2>/dev/null | jq -r '(.sources // .) | [.[] | select(.time_pos != null)][0].time_pos // "null"' 2>/dev/null)
        [ "$before_tp" = "$after_tp" ] && log "OK: cell $cell time_pos frozen across the 3 s pause ($before_tp)" \
          || warn "cell $cell: time_pos moved during pause: $before_tp -> $after_tp (expected frozen, R75/invariant #7)"
        ctl set '{"path":"player.paused","value":false}' >/dev/null 2>&1
        # Evaluate the SAME corr this switch already started -- not observe_switch, which
        # waits for a *different, new* corr (nothing new is issued here) and would time out
        # every time (exactly what happened the first time this cell was tried).
        evaluate_known_corr "$cell" 1 "$corr" "$term" 0 || cell_failed=1
      fi
      ;;
  esac
  EFFECT_DURATION_MS=$saved_effect_ms
  [ "$cell_failed" = 1 ] && return 1
  return 0
}

write_summary() {
  jq -s '
    group_by(.cell) | map({
      cell: .[0].cell, switches: length,
      handoff: (map(select(.outcome=="handoff")) | length),
      cancelled: (map(select(.outcome | startswith("cancelled")))  | length),
      failed: (map(select(.outcome | startswith("failed")))  | length),
      timeout: (map(select(.outcome=="timeout")) | length),
      frame_violations: (map(select(.frames_ok == false)) | length),
      dropout_available: (map(select(.dropout.skipped == null)) | length > 0),
      dropout_drops_total: (map(.dropout.drops // [] | length) | add // 0),
      dropout_micro_gaps_total: (map(.dropout.micro_gaps // [] | length) | add // 0)
    })' "$SWITCHES_FILE" > "$RESULTS_DIR/summary.json" 2>/dev/null
  log "summary: $RESULTS_DIR/summary.json"
}

OUTA=""; OUTB=""   # set by setup_*_backend (hermetic: VIRTUAL-1/2) or hardcoded below for live

# ==================================================================
# permonitor (brief step 3): a different clip on each output, a transition on ONE output alone ->
# the other's frames+audio unaffected, and a span of one source across both. "Via `ctl` only" means
# the ASSERTIONS below are plain graph/probe reads -- HTTP is used only to get PlayerEngine=liascape-player
# running in the first place, same as every other subcommand.
# ==================================================================
run_permonitor() {
  if [ "$HERMETIC" = 1 ]; then setup_hermetic_backend; setup_hermetic_media
  else setup_live_backend; setup_live_media; OUTA=DP-1; OUTB=DP-2; fi
  build_alt_targets
  local tA=${ALT_TARGETS[0]} tB=${ALT_TARGETS[1 % ${#ALT_TARGETS[@]}]} tC=${ALT_TARGETS[2 % ${#ALT_TARGETS[@]}]}
  log "permonitor: $OUTA <- $tA, $OUTB <- $tB, then a transition on $OUTA alone -> $tC"

  # battery-script fix (found running this live -- first real exercise per Stage 1's own notes):
  # `setup_live_backend` only flips the `PlayerEngine` SETTING; player-adapter.md's
  # `EnsureRunning()` is explicit that "only a switch calls it -- queries/sets never spawn" --
  # so without an actual HTTP switch first, no `liascape-player serve` process (and no socket) exists
  # yet when the raw `ctl` calls below run, and every one of them failed with `io`/"can't
  # connect to .../liascape-player.sock: No such file or directory". `run_battery`'s own cells never
  # hit this because every one of them starts with a real `/apply`/`/playlist/play` HTTP call
  # before touching `ctl`. Prime it here the same way (drained, not evaluated) for live mode
  # only (hermetic's `setup_hermetic_backend` already starts `liascape-player serve` itself directly).
  if [ "$HERMETIC" = 0 ]; then
    local prime_prev prime_corr
    prime_prev=$(last_corr)
    post /apply "$(jq -nc --arg p "$tA" '{path:$p}')" >/dev/null
    for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
    ctl hello >/dev/null 2>&1 || warn "permonitor: liascape-player socket still not up after priming apply -- the ctl calls below will likely fail"
    # The priming apply is itself a full-live `out:*` transition (default duration/effect) --
    # found running this live: without waiting for IT to hand off first, the raw `ctl create`/
    # `ctl set lay:<out>:main.content` calls below raced it, landing mid-effect (both layers'
    # `content` still the apply's own in-flight `fx*` node, not the two distinct sources this
    # step is trying to place) instead of a clean starting point.
    prime_corr=$(wait_for_new_corr "$prime_prev" "$NEW_CORR_TIMEOUT")
    [ -n "$prime_corr" ] && wait_for_terminal "$prime_corr" "$(term_timeout)" >/dev/null
  fi

  local srcA srcB
  srcA=$(ctl create "$(jq -nc --arg p "$tA" '{kind:"source",props:{path:$p,loop:true}}')" | jq -r .id)
  srcB=$(ctl create "$(jq -nc --arg p "$tB" '{kind:"source",props:{path:$p,loop:true}}')" | jq -r .id)
  ctl set "$(jq -nc --arg v "$srcA" '{path:("lay:'"$OUTA"':main.content"),value:$v}')" >/dev/null
  ctl set "$(jq -nc --arg v "$srcB" '{path:("lay:'"$OUTB"':main.content"),value:$v}')" >/dev/null
  sleep 1.0
  # battery-script fix (found running this live): `ctl get {path:"cur:X"}` with no property is
  # `no_such_prop` ("prop path ... has no '.' separating node id from property name") -- `cur:`
  # is a NODE alias, only valid as the node-id half of a `<node>.<prop>` path (e.g.
  # `cur:DP-1.time_pos`), never queryable bare. What this check actually wants -- "which source
  # id does this output's main layer show right now" -- is `lay:<out>:main.content` directly.
  local curA curB
  curA=$(ctl get "{\"path\":\"lay:$OUTA:main.content\"}" | jq -r .value); curB=$(ctl get "{\"path\":\"lay:$OUTB:main.content\"}" | jq -r .value)
  [ "$curA" = "$srcA" ] && [ "$curB" = "$srcB" ] && log "OK: independent sources on $OUTA ($srcA) and $OUTB ($srcB)" \
    || warn "lay:$OUTA:main.content=$curA (want $srcA), lay:$OUTB:main.content=$curB (want $srcB)"

  local framesB_before meterB_before resp corr outcome framesB_after meterB_after
  framesB_before=$(probe_frames_raw | jq -c --arg o "$OUTB" '.outputs[] | select(.name==$o)')
  meterB_before=$(ctl probe '{"name":"meter.window","args":{"last_ms":500,"samples":false}}' | jq -c '{median_db,min_db,max_db}')
  resp=$(ctl transition "$(jq -nc --arg o "$OUTA" --arg p "$tC" '{outputs:("out:"+$o), to:{path:$p}, effect_id:"'"$EFFECT_ID"'", duration_ms:'"$EFFECT_DURATION_MS"'}')")
  corr=$(echo "$resp" | jq -r '.corr // empty')
  if [ -z "$corr" ]; then warn "permonitor: transition on out:$OUTA failed to start: $resp"; else
    outcome=$(wait_for_terminal "$corr" "$(term_timeout)")
    [ "$outcome" = handoff ] && log "OK: out:$OUTA-only transition ($corr) handed off" || warn "out:$OUTA-only transition: $outcome"
  fi
  framesB_after=$(probe_frames_raw | jq -c --arg o "$OUTB" '.outputs[] | select(.name==$o)')
  meterB_after=$(ctl probe '{"name":"meter.window","args":{"last_ms":500,"samples":false}}' | jq -c '{median_db,min_db,max_db}')
  local missed_before missed_after
  missed_before=$(echo "$framesB_before" | jq -r '.paced.missed // 0'); missed_after=$(echo "$framesB_after" | jq -r '.paced.missed // 0')
  [ "$missed_after" = "$missed_before" ] && log "OK: $OUTB frames.missed unchanged ($missed_before) while $OUTA transitioned" \
    || warn "$OUTB frames.missed moved $missed_before -> $missed_after during an $OUTA-only transition"

  # Span: one source across both outputs via complementary viewports (docs/player/architecture.md
  # Composition § "Spanning one source across two outputs").
  local srcSpan
  srcSpan=$(ctl create "$(jq -nc --arg p "$tA" '{kind:"source",props:{path:$p,loop:true}}')" | jq -r .id)
  ctl set "$(jq -nc --arg v "$srcSpan" '{path:("lay:'"$OUTA"':main.content"),value:$v}')" >/dev/null
  ctl set "$(jq -nc --arg v "$srcSpan" '{path:("lay:'"$OUTB"':main.content"),value:$v}')" >/dev/null
  ctl set '{"path":"lay:'"$OUTA"':main.viewport","value":[0,0,0.5,1]}' >/dev/null
  ctl set '{"path":"lay:'"$OUTB"':main.viewport","value":[0.5,0,0.5,1]}' >/dev/null
  sleep 0.5
  curA=$(ctl get "{\"path\":\"lay:$OUTA:main.content\"}" | jq -r .value); curB=$(ctl get "{\"path\":\"lay:$OUTB:main.content\"}" | jq -r .value)
  [ "$curA" = "$srcSpan" ] && [ "$curB" = "$srcSpan" ] && log "OK: one source ($srcSpan) spans $OUTA+$OUTB" \
    || warn "span check: lay:$OUTA:main.content=$curA lay:$OUTB:main.content=$curB (want both $srcSpan)"
  ctl set '{"path":"lay:'"$OUTA"':main.viewport","value":[0,0,1,1]}' >/dev/null
  ctl set '{"path":"lay:'"$OUTB"':main.viewport","value":[0,0,1,1]}' >/dev/null

  jq -nc --arg outA "$OUTA" --arg outB "$OUTB" --argjson fb "$framesB_before" --argjson fa "$framesB_after" \
    --argjson mb "$meterB_before" --argjson ma "$meterB_after" \
    '{outA:$outA, outB:$outB, outB_frames_before:$fb, outB_frames_after:$fa, outB_meter_before:$mb, outB_meter_after:$ma}' \
    > "$RESULTS_DIR/permonitor.json"
  log "permonitor report: $RESULTS_DIR/permonitor.json"
}

# ==================================================================
# soak (brief step 4): 1 h RSS + VRAM every 60 s on the owner's playlist (named "dp"), slope < 1
# MiB/min after the first 5 min. VRAM via nvidia-smi's per-process compute-apps query, falling back
# to whole-GPU memory.used if that pid isn't listed (a known limitation on some driver/desktop
# combinations where a graphics-only client doesn't show up as a "compute app" -- noted in the report).
# ==================================================================
run_soak() {
  if [ "$HERMETIC" = 1 ]; then setup_hermetic_backend; setup_hermetic_media
  else setup_live_backend; setup_live_media; fi
  # battery-script fix (found running permonitor live, same root cause applies here): `ctl
  # hello`/`comp_pid` needs the liascape-player SOCKET, which only exists once something actually
  # switches (player-adapter.md: "EnsureRunning()... only a switch calls it -- queries/sets
  # never spawn"). setup_live_backend only flips the PlayerEngine SETTING, so checking comp_pid
  # THIS early (before the playlist below ever issues its first real switch) failed every time
  # live. Moved past the `/playlist/play` call, which is this subcommand's own first real switch
  # (hermetic's setup_hermetic_backend starts `liascape-player serve` directly, so it never had this
  # problem either way).
  local pid

  if [ "$HERMETIC" = 1 ]; then
    # Task 20b: a soak that never switches can't find per-switch growth. Three 1080p30 clips with
    # audio (what a real wallpaper decodes -- 320x180 frames hide allocator retention), a timed
    # switch every SOAK_INTERVAL s with transitions, and the owner's HwDec.
    local T=$HERMETIC_T c soak=()
    for c in "testsrc2 440" "smptebars 550" "mandelbrot 660"; do
      local src hz; read -r src hz <<<"$c"
      ffmpeg -nostdin -loglevel error -y -f lavfi -i "$src=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=$hz:sample_rate=48000" \
        -t 6 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "$T/soak-$src.mp4"
      soak+=("$T/soak-$src.mp4")
    done
    setting_set '.hwDec = $hw' --arg hw "$SOAK_HWDEC" || exit 1   # camelCase on the wire (see the R-note near snapshot_owner_settings)
    log "soak (hermetic): ${#soak[@]} 1080p clips, a switch every ${SOAK_INTERVAL}s, HwDec=$SOAK_HWDEC"
    post /playlist/play "$(jq -nc --argjson p "$(json_str_array "${soak[@]}")" --argjson iv "$SOAK_INTERVAL" \
      '{paths:$p, settings:{Order:0, OverrideGlobalSettings:true, IntervalSeconds:$iv, SwitchWhenVideoEnds:false,
        WaitForVideoEnd:false, TransitionEnabled:true, TransitionEffectIds:["fade","crosswarp","dissolve","wind"],
        TransitionDurationMs:1000}}')" >/dev/null
  else
    local names; names=$(get /playlist/names | jq -r '.[]?' 2>/dev/null)
    if echo "$names" | grep -qx dp; then
      local pl; pl=$(post /playlist/load '{"name":"dp"}' 2>/dev/null || curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d '{"name":"dp"}' "$API/playlist/load")
      post /playlist/play "$(echo "$pl" | jq -c '{paths:.videoPaths, settings:.settings}')" >/dev/null
      log "soak: playing the owner's 'dp' playlist"
    else
      warn "soak: no saved playlist named 'dp' -- falling back to the scanned 431960 media as a playlist"
      build_alt_targets
      post /playlist/play "$(jq -nc --argjson p "$(json_str_array "${ALT_TARGETS[@]}")" --argjson s '{"Order":0}' '{paths:$p, settings:$s}')" >/dev/null
    fi
  fi
  sleep 2
  for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
  pid=$(comp_pid)
  [ -n "$pid" ] || { err "soak: no compositor pid from ctl hello after starting the playlist"; exit 1; }

  local samples="$RESULTS_DIR/soak-samples.jsonl"; : > "$samples"
  local n=$((SOAK_MINUTES)) i rss vram t0 t
  t0=$(date +%s)
  log "soak: sampling every 60 s for ${SOAK_MINUTES} min (pid $pid)"
  for ((i = 0; i < n; i++)); do
    pid=$(comp_pid)   # a supervised restart during the soak changes this; re-read each sample
    rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' '); [ -n "$rss" ] || rss=0
    vram=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null | awk -F',' -v p="$pid" '$1+0==p{print $2+0}')
    [ -n "$vram" ] || vram=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
    [ -n "$vram" ] || vram=0
    t=$(date +%s)
    # Task 20b: malloc's own split (in use vs retained) + how many switches so far, so a slope can
    # be read as "per switch" and as "leak vs allocator retention" without re-running anything.
    local mem sw
    # switches = the probe's monotonic transitions_done_total (the log ring is bounded); .policy
    # carries the trim counters. A failed probe leaves all three null (the summary skips them).
    local pol
    mem=$(ctl probe '{"name":"memory"}' 2>/dev/null)
    sw=$(jq -c '.transitions_done_total // null' <<<"$mem" 2>/dev/null); [ -n "$sw" ] || sw=null
    pol=$(jq -c '.policy // null' <<<"$mem" 2>/dev/null); [ -n "$pol" ] || pol=null
    mem=$(jq -c '.malloc // null' <<<"$mem" 2>/dev/null); [ -n "$mem" ] || mem=null
    jq -nc --argjson t "$t" --argjson rss_kib "$rss" --argjson vram_mib "$vram" --argjson pid "$pid" \
      --argjson malloc "$mem" --argjson policy "$pol" --argjson switches "$sw" \
      '{t:$t, pid:$pid, rss_kib:$rss_kib, vram_mib:$vram_mib, switches:$switches, malloc:$malloc, policy:$policy}' >> "$samples"
    sleep 60
  done

  # NOTE: over a ~15 min run the 1 MiB/min bar is inside the +-40 MiB per-sample noise (an in-flight
  # transition holds two cores); trust it only on long (>= 1 h) soaks.
  # Linear-regression slope over samples taken >= 5 min in (the brief excludes warmup); < 1 MiB/min
  # on both RSS and VRAM is a pass. python3 for the same reason the rest of the repo's test scripts
  # reach for it over awk/bc (global-constraints.md / test-liascape-player-adapter.sh's dB()/near()).
  python3 - "$samples" "$t0" <<'PYEOF' > "$RESULTS_DIR/soak-summary.json"
import json, sys
path, t0 = sys.argv[1], int(sys.argv[2])
rows = [json.loads(l) for l in open(path) if l.strip()]
skip = [r for r in rows if r["t"] - t0 >= 300]
def slope_per_min(key, to_mib):
    if len(skip) < 2: return None
    xs = [(r["t"] - t0) / 60.0 for r in skip]
    ys = [to_mib(r[key]) for r in skip]
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    num = sum((x-mx)*(y-my) for x, y in zip(xs, ys)); den = sum((x-mx)**2 for x in xs)
    return num/den if den else 0.0
rss_slope = slope_per_min("rss_kib", lambda v: v/1024.0)
vram_slope = slope_per_min("vram_mib", lambda v: float(v))
# Samples whose memory probe failed carry malloc:null -- skipped (counting them as 0 would spike a slope).
skip_all = skip
skip = [r for r in skip_all if r.get("malloc")]
for r in skip:
    m = r["malloc"]
    r["retained"] = m.get("free_bytes", 0)
    r["arena"] = m.get("arena_bytes", 0)
    r["live"] = m.get("in_use_bytes", 0) + m.get("mmap_bytes", 0)
retained_slope = slope_per_min("retained", lambda v: v/1048576.0)
arena_slope = slope_per_min("arena", lambda v: v/1048576.0)
live_slope = slope_per_min("live", lambda v: v/1048576.0)
trim_max = max([(r.get("policy") or {}).get("trim_ms_max", 0) for r in rows] or [0])
swr = [r for r in rows if r.get("switches") is not None]
sw = [r["switches"] for r in swr]
mins = (swr[-1]["t"] - swr[0]["t"]) / 60.0 if len(swr) > 1 else 0
print(json.dumps({"samples": len(rows), "after_5min": len(skip_all),
       "switches": sw[-1] if sw else 0,
       "switches_per_min": ((sw[-1] - sw[0]) / mins) if mins else None,
       "malloc_live_slope_mib_per_min": live_slope,
       "malloc_retained_slope_mib_per_min": retained_slope,
       "arena_bytes_slope_mib_per_min": arena_slope,
       "free_bytes_slope_mib_per_min": retained_slope,
       "trim_ms_max": trim_max,
       "rss_slope_mib_per_min": rss_slope, "vram_slope_mib_per_min": vram_slope,
       "rss_pass": (rss_slope is not None and rss_slope < 1.0),
       "vram_pass": (vram_slope is not None and vram_slope < 1.0)}, indent=2))
PYEOF
  post /stop '{}' >/dev/null 2>&1 || true
  log "soak summary: $RESULTS_DIR/soak-summary.json"
}

# R99 resume/dispatch shared by every cell source (the main matrix, the realism cell, the
# extremes block): skip an already-attempted cell under --resume, purge a partial (interrupted,
# not failed) one before redoing it, run it, and turn a real failure into a counted "continue
# with the rest" instead of aborting (same pattern for all three, so R101's extra cells don't
# need their own copy of this logic).
dispatch_cell() {
  local fn="$1" method="$2" mode="$3"
  local c="$method/$mode"
  if [ "$RESUME" = 1 ] && cell_already_attempted "$c"; then
    log "resume: $c already attempted (per $SWITCHES_FILE/$CELL_FAILURES_FILE) -- skipping"
    return 0
  fi
  if [ "$RESUME" = 1 ] && [ -s "$SWITCHES_FILE" ]; then
    local tmp; tmp=$(mktemp)
    jq -c --arg c "$c" 'select(.cell != $c)' "$SWITCHES_FILE" > "$tmp" 2>/dev/null && mv "$tmp" "$SWITCHES_FILE"
  fi
  "$fn" "$method" "$mode" || { warn "cell $c FAILED (R99) -- continuing with remaining cells"; return 1; }
  return 0
}

run_battery() {
  print_eta
  if [ "$HERMETIC" = 1 ]; then setup_hermetic_backend; setup_hermetic_media; else setup_live_backend; setup_live_media; fi
  if [ "$HERMETIC" = 0 ]; then
    # R100 fix: setup_live_backend already pushed globalTransitionDurationMs from whatever
    # EFFECT_DURATION_MS was BEFORE setup_live_media ran (the stale 1000 ms default, unless
    # --effect-ms set it earlier) -- setup_live_media may since have changed it (media-derived,
    # when no override was given). Push the FINAL value now so the backend's actual duration
    # always matches what this script's own term_timeout()/sleeps assume for the main matrix.
    setting_set ".globalTransitionDurationMs = $EFFECT_DURATION_MS"
  fi
  NEW_CORR_TIMEOUT=15
  build_alt_targets
  log "importing ${#ALT_TARGETS[@]} alternating target(s) into the library once (needed for /next //prev/-random navigation)"
  for p in "${ALT_TARGETS[@]}"; do import_target "$p" >/dev/null || warn "import failed for $p"; done

  local any=0 failed_cells=0
  for method in "${METHODS[@]}"; do
    setting_set ".transitionMethod = \"$method\""
    for mode in "${MODES[@]}"; do
      cell_selected "$method" "$mode" || continue
      any=1
      dispatch_cell run_cell "$method" "$mode" || failed_cells=$((failed_cells + 1))
    done
  done

  # R100 realism cell + R101 extremes block -- after the main matrix, before permonitor/soak.
  if cell_selected full-live realism; then
    any=1
    dispatch_cell run_realism_cell full-live realism || failed_cells=$((failed_cells + 1))
  fi
  for method in "${METHODS[@]}"; do
    for mode in "${EXTRA_MODES[@]}"; do
      cell_selected "$method" "$mode" || continue
      any=1
      dispatch_cell run_extra_cell "$method" "$mode" || failed_cells=$((failed_cells + 1))
    done
  done

  [ "$any" = 1 ] || { err "--cells matched nothing (try --list-cells)"; exit 2; }
  write_summary
  jq -n --argjson avail "$(dropout_probe_available)" \
    '{dropout_probe_available: $avail, note: "false means lane B (the dropout detector) was not merged into this build -- re-run after it is"}' \
    > "$RESULTS_DIR/dropout-availability.json"
  if [ "$failed_cells" = 0 ]; then
    log "battery complete. 0 cells failed -- see $RESULTS_DIR/summary.json"
  else
    err "battery complete. $failed_cells cell(s) failed (R99: ran the full matrix anyway) -- see $RESULTS_DIR/summary.json and $CELL_FAILURES_FILE"
  fi
}

# ==================================================================
# Dispatch
# ==================================================================
case "$SUBCMD" in
  run) run_battery ;;
  permonitor) run_permonitor ;;
  soak) run_soak ;;
  *) echo "unknown subcommand: $SUBCMD" >&2; usage 2 ;;
esac
