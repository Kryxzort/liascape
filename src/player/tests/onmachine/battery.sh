#!/usr/bin/env bash
# lp-player Phase 1 on-machine battery (Task 20, docs/superpowers/sdd/2026-10-20-lp-player-phase0-1/
# task-20-brief.md). Drives the REAL C# backend (`livepaper --serve`, PlayerEngine=lp-player) over
# HTTP exactly like the owner's UI would, and inspects the result with `lp-player ctl` directly —
# same split as `scripts/test-lp-player-adapter.sh` (§ Integration test) and
# `src/player/tests/onmachine/bus.sh`, whose patterns this reuses (temp dirs for --hermetic, a
# cleanup trap that always restores owner state, `pactl`/`nvidia-smi` for live measurements).
#
# Subcommands:
#   battery.sh run        [options]   -- the method x mode switch matrix (this file's main job)
#   battery.sh permonitor [options]   -- brief step 3: per-output isolation, via `ctl` only
#   battery.sh soak       [options]   -- brief step 4: 1 h RSS/VRAM soak on the owner's playlist
#
# Options (run):
#   --hermetic            private backend + private headless lp-player (own HOME/XDG/port, --ao null,
#                         synthetic ffmpeg media) -- never touches the owner's session. Use this for
#                         stage-1 verification; stage 2 drops it to run on the owner's live session.
#   --smoke               2 switches per cell instead of >= 50 (plumbing check, not a real battery)
#   --switches N          override the per-cell switch count (default 50)
#   --cells m1/mo1,m2/mo2 only run these method/mode cells (see --list-cells); default = all 24
#   --list-cells          print every method/mode cell id and exit
#   --results-dir DIR     override the timestamped results directory
#   --build               rebuild lp-player (cargo) + the backend (dotnet) first (hermetic only;
#                         default: use whatever is already built, like `--no-build` elsewhere)
#   -h / --help           this text
#
# Options (soak): --minutes N (default 60).  Options (permonitor): --hermetic (headless 2-output
# stand-in for DP-1/DP-2); live permonitor always targets the owner's real DP-1/DP-2.
#
# Pass criteria (brief step 2, enforced live, REPORTED-not-enforced under --hermetic): 0 drops and
# 0 micro_gaps per the dropout detector (skipped entirely if this branch has no `probe dropout` --
# see "Dropout detector availability" below), frame present intervals within +/- 0.5 ms of refresh on
# every output, no `transition.failed` except ones we deliberately inject (we inject none -- any
# `failed:` is a real stop).
#
# Dropout detector availability: this worktree (lp-player-laneC, HEAD cbf6451) predates lane B's
# audio work, which adds the `dropout` probe / `probe.dropout` events / `player.debug`'s consumer.
# `ctl probe '{"name":"dropout",...}'` on this branch replies `no_such_probe` -- probe_dropout()
# below detects that exactly once, logs it, and every switch's `dropout` field becomes
# `{"skipped":"unavailable_on_this_branch"}` for the rest of the run. Re-run after the controller
# merges lane B and it picks the probe up with no script change (global-constraints.md: "the full
# run happens later, after the controller merges the audio work").
#
# Owner-environment safety (brief, owner-approved -- only active without --hermetic):
#   - Legacy wallpaper is stopped first (global-constraints.md) and left stopped at the end.
#   - The lp-player bus playback stream (sink-input node.name=lp-player-bus.playback) is held at
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
#   - A `trap` on EXIT/INT/TERM/HUP always runs the restore + kills any lp-player left running
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
EFFECT_ID="fade"
EFFECT_DURATION_MS=1000

SUBCMD="run"
case "${1:-}" in
  run|permonitor|soak) SUBCMD=$1; shift ;;
esac

HERMETIC=0
SMOKE=0
SWITCHES=50
CELLS_FILTER=""
RESULTS_DIR_OVERRIDE=""
BUILD=0
SOAK_MINUTES=60

usage() { sed -n '2,70p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hermetic) HERMETIC=1 ;;
    --smoke) SMOKE=1 ;;
    --switches) shift; SWITCHES=${1:?--switches needs N} ;;
    --cells) shift; CELLS_FILTER=${1:?--cells needs a list} ;;
    --list-cells) for m in "${METHODS[@]}"; do for o in "${MODES[@]}"; do echo "$m/$o"; done; done; exit 0 ;;
    --results-dir) shift; RESULTS_DIR_OVERRIDE=${1:?--results-dir needs a path} ;;
    --build) BUILD=1 ;;
    --minutes) shift; SOAK_MINUTES=${1:?--minutes needs N} ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 2 ;;
  esac
  shift
done
[ "$SMOKE" = 1 ] && SWITCHES=2

for t in curl jq python3 ffmpeg; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 2; }; done

BIN=${LP_PLAYER_BIN:-}
if [ -z "$BIN" ]; then
  if [ -x "$REPO/src/player/target/release/lp-player" ]; then BIN=$REPO/src/player/target/release/lp-player
  elif [ -x "$REPO/src/player/target/debug/lp-player" ]; then BIN=$REPO/src/player/target/debug/lp-player
  else BIN=$(command -v lp-player || true); fi
fi
[ -n "$BIN" ] && [ -x "$BIN" ] || { echo "no lp-player binary found (set LP_PLAYER_BIN, or build src/player)" >&2; exit 2; }

DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || DOTNET=/nix/store/a9ml93kizcwff3yakmqw4qs3w4llpbf2-dotnet-sdk-wrapped-10.0.301/bin/dotnet
DLL=$REPO/src/livepaper/bin/Debug/net10.0/livepaper.dll

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
: > "$SWITCHES_FILE"
log "results: $RESULTS_DIR"

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
# scripts/test-lp-player-adapter.sh's setting(); global-constraints.md: POST /settings replaces the
# whole object, so every write must round-trip through the live object, never a hand-built partial one.
setting_set() {
  local body
  body=$(settings_get | jq -c "$1") || { err "settings_set: GET /settings failed"; return 1; }
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
evaluate_frames() {
  echo "$1" | jq -c '
    { outputs: [ .outputs[] | ( (1000000 / .refresh_mhz) as $exp |
        { name, expected_ms: $exp, mean_ms: (.paced.mean_ms // 0), missed: (.paced.missed // 0),
          within_tol: ((((.paced.mean_ms // 0) - $exp) | if . < 0 then -. else . end) <= 0.5) } ) ] }
    | .ok = ((.outputs | all(.within_tol)) and (.outputs | all(.missed == 0)))'
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
  jq -nc --arg cell "$1" --argjson idx "$2" --arg corr "$3" --arg outcome "$4" \
    --argjson frames "$5" --argjson dropout "$6" --arg note "${7:-}" --arg t "$(date -Iseconds)" \
    '{t:$t, cell:$cell, idx:$idx, corr:$corr, outcome:$outcome, frames:$frames, frames_ok:$frames.ok,
      dropout:$dropout, note:$note}' >> "$SWITCHES_FILE"
}

stop_on_failure() {
  local reason="$1" corr="${2:-}"
  FAILED=1
  err "BATTERY STOPPED: $reason${corr:+ (corr=$corr)}"
  if [ -n "$corr" ]; then
    ctl logs "{\"corr\":\"$corr\"}" > "$RESULTS_DIR/failure-$corr.json" 2>/dev/null
    err "dumped $RESULTS_DIR/failure-$corr.json"
  fi
  exit 1
}

# One switch, generically: wait for a new corr after the caller already issued whatever action
# triggers it, wait for its terminal event, collect frames+dropout, record, stop on real failure.
#
# Sets the global OBS_CORR (never echoes/is never called via `$(...)`: stop_on_failure() below calls
# `exit`, and `exit` inside a command-substitution subshell would only kill that subshell, silently
# defeating "stop on the first failure" -- every caller invokes this as a plain statement and reads
# OBS_CORR afterward).
OBS_CORR=""
observe_switch() {
  local cell="$1" idx="$2" prev_corr="$3" new_timeout="$4" term_timeout="$5" tolerant="${6:-0}"
  local corr outcome frames frames_eval dropout
  OBS_CORR=""
  corr=$(wait_for_new_corr "$prev_corr" "$new_timeout")
  if [ -z "$corr" ]; then
    [ "$tolerant" = 1 ] && return 1
    stop_on_failure "no new transition corr observed" ""
  fi
  outcome=$(wait_for_terminal "$corr" "$term_timeout")
  frames=$(probe_frames_raw); [ -n "$frames" ] || frames='{"outputs":[]}'
  frames_eval=$(evaluate_frames "$frames")
  dropout=$(probe_dropout "$corr")
  record_switch "$cell" "$idx" "$corr" "$outcome" "$frames_eval" "$dropout"
  if [ "$ENFORCE_FRAME_TIMING" = 1 ]; then
    echo "$frames_eval" | jq -e '.ok' >/dev/null || warn "cell $cell switch $idx: frame timing out of +/-0.5ms tolerance (reported, see $SWITCHES_FILE)"
  fi
  case "$outcome" in
    failed:*) [ "$tolerant" = 1 ] && warn "cell $cell switch $idx: $outcome (tolerated -- interrupted side)" || stop_on_failure "$outcome" "$corr" ;;
    timeout) [ "$tolerant" = 1 ] && warn "cell $cell switch $idx: terminal timeout (tolerated -- interrupted side)" || stop_on_failure "transition did not reach a terminal state" "$corr" ;;
  esac
  OBS_CORR="$corr"
  return 0
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
  for f in PlayerEngine TransitionMethod GlobalTransitionEnabled GlobalTransitionEffectIds \
           GlobalTransitionDurationMs AutoMute LastSession; do
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

BUS_STREAM_NODE_NAME="lp-player-bus.playback"
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
  # No lp-player process left, in either mode: quit over the socket first (clean), else the
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
        /tmp/lp-battery-*) command -v trash >/dev/null && trash "$HERMETIC_T" 2>/dev/null || rm -rf -- "$HERMETIC_T" ;;
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
  local portfile="$HOME/.config/livepaper/serve.port"
  [ -s "$portfile" ] || { err "no $portfile -- is the owner's backend (livepaper-watch) running?"; exit 1; }
  API="http://127.0.0.1:$(cat "$portfile")"
  curl -sf -m 5 "$API/health" >/dev/null || { err "backend at $API not responding"; exit 1; }
  snapshot_owner_settings
  setting_set ".PlayerEngine = \"lp-player\" | .AutoMute = false | .GlobalTransitionEnabled = true | .GlobalTransitionEffectIds = [\"$EFFECT_ID\"] | .GlobalTransitionDurationMs = $EFFECT_DURATION_MS"
  sleep 1
  [ "$(curl -sf -m 5 "$API/player-engine" | jq -r .active)" = "lp-player" ] || { err "backend did not switch to lp-player -- aborting before touching any playback"; exit 1; }
  PLAYER_SP=$(sup_pid)
  start_bus_mute_watcher
  sleep 1.5
  check_mute_does_not_blind_meter
}

setup_hermetic_backend() {
  ENFORCE_FRAME_TIMING=0
  [ -f "$DLL" ] || { err "hermetic mode needs the backend built: $DLL missing (dotnet build src/livepaper)"; exit 2; }
  if [ "$BUILD" = 1 ]; then
    log "== build (hermetic --build)"
    if command -v nix >/dev/null; then
      (cd "$REPO" && env -u LD_LIBRARY_PATH nix develop -c cargo build -q --manifest-path src/player/Cargo.toml) || { err "cargo build failed"; exit 2; }
    else
      (cd "$REPO" && env -u LD_LIBRARY_PATH cargo build -q --manifest-path src/player/Cargo.toml) || { err "cargo build failed"; exit 2; }
    fi
    "$DOTNET" build "$REPO/src/livepaper" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  fi
  HERMETIC_T=$(mktemp -d /tmp/lp-battery-XXXXXX)   # short: a unix socket path must be < 108 bytes
  mkdir -p "$HERMETIC_T/home/.config/livepaper" "$HERMETIC_T/home/.cache" "$HERMETIC_T/home/.local/share" "$HERMETIC_T/rt" "$HERMETIC_T/st"
  export HOME=$HERMETIC_T/home XDG_CONFIG_HOME=$HERMETIC_T/home/.config XDG_CACHE_HOME=$HERMETIC_T/home/.cache
  export XDG_DATA_HOME=$HERMETIC_T/home/.local/share XDG_RUNTIME_DIR=$HERMETIC_T/rt XDG_STATE_HOME=$HERMETIC_T/st
  export LP_PLAYER_BIN=$BIN LP_TRANSITIONS_DIR=$REPO/transitions
  export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
  unset LP_PLAYER_SOCKET WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LP_UI_DIR LP_PORT

  cat > "$XDG_CONFIG_HOME/livepaper/settings.json" <<EOF
{"PlayerEngine":"lp-player","NoAudio":false,"Loop":true,"Volume":100,"GlobalTransitionEnabled":true,
 "GlobalTransitionEffectIds":["$EFFECT_ID"],"GlobalTransitionDurationMs":$EFFECT_DURATION_MS,"TransitionMethod":"full-live",
 "GlobalAdvanceOnVideoEnd":false,"GlobalWaitForVideoEnd":false,"GlobalIntervalSeconds":1800,"RestartIntervalSeconds":600,"AutoMute":false}
EOF

  OUTA=VIRTUAL-1; OUTB=VIRTUAL-2
  ( cd /tmp && exec "$BIN" serve --headless --outputs 640x360@60,320x180@60 --clock real --ao null \
      > "$HERMETIC_T/serve.log" 2>&1 ) & PLAYER_SP=$!
  for _ in $(seq 1 50); do ctl hello >/dev/null 2>&1 && break; sleep 0.1; done
  ctl hello >/dev/null 2>&1 || { err "hermetic lp-player did not start, see $HERMETIC_T/serve.log"; exit 1; }
  PLAYER_SP=$(sup_pid)

  "$DOTNET" "$DLL" --serve > "$HERMETIC_T/backend.log" 2>&1 & BP=$!
  for _ in $(seq 1 150); do [ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] && break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/livepaper/serve.port" ] || { err "hermetic backend did not start, see $HERMETIC_T/backend.log"; tail -5 "$HERMETIC_T/backend.log" >&2; exit 1; }
  API="http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/livepaper/serve.port")"
  for _ in $(seq 1 50); do curl -sf -m 2 "$API/health" >/dev/null && break; sleep 0.1; done
  [ "$(curl -sf -m 5 "$API/player-engine" | jq -r .active)" = "lp-player" ] || { err "hermetic backend not on lp-player"; exit 1; }
  log "hermetic: player pid $(comp_pid) (supervisor $PLAYER_SP), backend $API"
}

# ==================================================================
# Media. VIDEOS/IMAGES are the general alternating-target pool; SHORT_VIDEOS is specifically for
# advance-on-end/wait-for-end (brief: "pick short clips" -- those two modes rely on a video's own
# natural end, which an image never reaches, so they are video-only by construction here).
# ==================================================================
VIDEOS=(); IMAGES=(); SHORT_VIDEOS=()

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
  local min_ms=999999999 m
  for v in "${VIDEOS[@]}"; do
    m=$(ffprobe_duration_ms "$v"); durs+=("$m:$v")
    [ "$m" -gt 0 ] && [ "$m" -lt "$min_ms" ] && min_ms=$m
  done
  if [ "$min_ms" -lt 999999999 ]; then
    EFFECT_DURATION_MS=$(python3 -c "print(max(800, int($min_ms * 1.5)))")
  fi
  mapfile -t SHORT_VIDEOS < <(printf '%s\n' "${durs[@]}" | sort -n -t: -k1,1 | head -3 | cut -d: -f2-)
  log "media: ${#VIDEOS[@]} video(s), ${#IMAGES[@]} image(s), effect duration ${EFFECT_DURATION_MS} ms (shortest clip ${min_ms} ms)"
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

restore_cli_invoke() {
  if [ "$HERMETIC" = 1 ]; then
    "$DOTNET" "$DLL" --restore > "$HERMETIC_T/restore-$(date +%s%N).log" 2>&1
  else
    local lp; lp=$(command -v livepaper || true)
    [ -n "$lp" ] || { err "restore-replay (live): 'livepaper' not found on PATH"; return 1; }
    "$lp" --restore >/dev/null 2>&1
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
  local i corr prev

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
        observe_switch "$cell" "$i" "$prev" "$NEW_CORR_TIMEOUT" "$term" 0
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
        observe_switch "$cell" "$i" "$prev" "$NEW_CORR_TIMEOUT" "$term" 0
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
        '{Order:0, OverrideGlobalSettings:true, IntervalSeconds:$iv, AdvanceOnVideoEnd:$adv, WaitForVideoEnd:$w}')
      post /playlist/play "$(jq -nc --argjson p "$(json_str_array "${paths[@]}")" --argjson s "$settings" '{paths:$p, settings:$s}')" >/dev/null
      sleep 1.5
      local auto_timeout; auto_timeout=$(python3 -c "print(int($interval) + 15)")
      prev=$(last_corr)
      for ((i = 1; i <= SWITCHES; i++)); do
        observe_switch "$cell" "$i" "$prev" "$auto_timeout" "$term" 0
        prev="$OBS_CORR"
      done
      post /stop '{}' >/dev/null; sleep 0.5
      ;;
  esac
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
# the ASSERTIONS below are plain graph/probe reads -- HTTP is used only to get PlayerEngine=lp-player
# running in the first place, same as every other subcommand.
# ==================================================================
run_permonitor() {
  if [ "$HERMETIC" = 1 ]; then setup_hermetic_backend; setup_hermetic_media
  else setup_live_backend; setup_live_media; OUTA=DP-1; OUTB=DP-2; fi
  build_alt_targets
  local tA=${ALT_TARGETS[0]} tB=${ALT_TARGETS[1 % ${#ALT_TARGETS[@]}]} tC=${ALT_TARGETS[2 % ${#ALT_TARGETS[@]}]}
  log "permonitor: $OUTA <- $tA, $OUTB <- $tB, then a transition on $OUTA alone -> $tC"

  local srcA srcB
  srcA=$(ctl create "$(jq -nc --arg p "$tA" '{kind:"source",props:{path:$p,loop:true}}')" | jq -r .id)
  srcB=$(ctl create "$(jq -nc --arg p "$tB" '{kind:"source",props:{path:$p,loop:true}}')" | jq -r .id)
  ctl set "$(jq -nc --arg v "$srcA" '{path:("lay:'"$OUTA"':main.content"),value:$v}')" >/dev/null
  ctl set "$(jq -nc --arg v "$srcB" '{path:("lay:'"$OUTB"':main.content"),value:$v}')" >/dev/null
  sleep 1.0
  local curA curB
  curA=$(ctl get "{\"path\":\"cur:$OUTA\"}" | jq -r .value); curB=$(ctl get "{\"path\":\"cur:$OUTB\"}" | jq -r .value)
  [ "$curA" = "$srcA" ] && [ "$curB" = "$srcB" ] && log "OK: independent sources on $OUTA ($srcA) and $OUTB ($srcB)" \
    || warn "cur:$OUTA=$curA (want $srcA), cur:$OUTB=$curB (want $srcB)"

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
  curA=$(ctl get "{\"path\":\"cur:$OUTA\"}" | jq -r .value); curB=$(ctl get "{\"path\":\"cur:$OUTB\"}" | jq -r .value)
  [ "$curA" = "$srcSpan" ] && [ "$curB" = "$srcSpan" ] && log "OK: one source ($srcSpan) spans $OUTA+$OUTB" \
    || warn "span check: cur:$OUTA=$curA cur:$OUTB=$curB (want both $srcSpan)"
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
  local pid; pid=$(comp_pid)
  [ -n "$pid" ] || { err "soak: no compositor pid from ctl hello"; exit 1; }

  if [ "$HERMETIC" = 1 ]; then
    build_alt_targets
    post /playlist/play "$(jq -nc --argjson p "$(json_str_array "${ALT_TARGETS[@]}")" --argjson s '{"Order":0}' '{paths:$p, settings:$s}')" >/dev/null
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
    jq -nc --argjson t "$t" --argjson rss_kib "$rss" --argjson vram_mib "$vram" --argjson pid "$pid" \
      '{t:$t, pid:$pid, rss_kib:$rss_kib, vram_mib:$vram_mib}' >> "$samples"
    sleep 60
  done

  # Linear-regression slope over samples taken >= 5 min in (the brief excludes warmup); < 1 MiB/min
  # on both RSS and VRAM is a pass. python3 for the same reason the rest of the repo's test scripts
  # reach for it over awk/bc (global-constraints.md / test-lp-player-adapter.sh's dB()/near()).
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
print(json.dumps({"samples": len(rows), "after_5min": len(skip),
       "rss_slope_mib_per_min": rss_slope, "vram_slope_mib_per_min": vram_slope,
       "rss_pass": (rss_slope is not None and rss_slope < 1.0),
       "vram_pass": (vram_slope is not None and vram_slope < 1.0)}, indent=2))
PYEOF
  post /stop '{}' >/dev/null 2>&1 || true
  log "soak summary: $RESULTS_DIR/soak-summary.json"
}

run_battery() {
  print_eta
  if [ "$HERMETIC" = 1 ]; then setup_hermetic_backend; setup_hermetic_media; else setup_live_backend; setup_live_media; fi
  NEW_CORR_TIMEOUT=15
  build_alt_targets
  log "importing ${#ALT_TARGETS[@]} alternating target(s) into the library once (needed for /next //prev/-random navigation)"
  for p in "${ALT_TARGETS[@]}"; do import_target "$p" >/dev/null || warn "import failed for $p"; done

  local any=0
  for method in "${METHODS[@]}"; do
    setting_set ".TransitionMethod = \"$method\""
    for mode in "${MODES[@]}"; do
      cell_selected "$method" "$mode" || continue
      any=1
      run_cell "$method" "$mode"
    done
  done
  [ "$any" = 1 ] || { err "--cells matched nothing (try --list-cells)"; exit 2; }
  write_summary
  jq -n --argjson avail "$(dropout_probe_available)" \
    '{dropout_probe_available: $avail, note: "false means lane B (the dropout detector) was not merged into this build -- re-run after it is"}' \
    > "$RESULTS_DIR/dropout-availability.json"
  log "battery complete. 0 failures stopped the run -- see $RESULTS_DIR/summary.json"
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
