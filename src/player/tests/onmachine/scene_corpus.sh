#!/usr/bin/env bash
# Phase 2 Task 13: the scene corpus runner. Plays every Wallpaper Engine scene of a Workshop
# folder through lp-player's scene worker, one after another, on a PRIVATE headless player, and
# classifies each: ok | static | blank | load_failed | renderer_failed | crashed | broken | timeout
# (+ ready_ms, native size, worker peak RSS, gpu_ms_p50). The report (scene_corpus_report.py)
# goes to docs/player/reports/scene-corpus.{md,json}.
#
#   bash src/player/tests/onmachine/scene_corpus.sh                 # the whole 431960 folder
#   bash src/player/tests/onmachine/scene_corpus.sh --only 2371103399,1726902114
#   bash src/player/tests/onmachine/scene_corpus.sh --ab-legacy --legacy-output DP-1 \
#        --reuse /tmp/lp-scene-corpus-<stamp>                        # owner-run, see below
#
# Options:
#   --dir DIR            Workshop content folder (default
#                        ~/.local/share/Steam/steamapps/workshop/content/431960). REFUSED when it
#                        is (or resolves into) ~/.cache/livepaper/steamcmd_workshop — that cache is
#                        never test media. Every item is checked again after resolving symlinks.
#   --only ID[,ID…]      only these workshop ids
#   --limit N            only the first N scenes (sorted by id)
#   --ready-timeout S    seconds to wait for Ready (default 20)
#   --results DIR        where captures/records/logs go (default /tmp/lp-scene-corpus-<stamp>;
#                        never the repo — captures of scenes are not committed)
#   --report-dir DIR     where scene-corpus.{md,json} go (default <repo>/docs/player/reports;
#                        "-" = only into the results dir)
#   --assets DIR         WE's assets dir (default: lp-player's own resolution)
#   --bin DIR            dir holding lp-player + lp-scene-worker (default: build
#                        <crate>/target/release with `cargo build --release` in the devShell)
#   --no-build           use --bin / target/release as is
#   --reuse DIR          skip lp-player's run; reuse DIR's records (for --ab-legacy / re-reports)
#   --ab-legacy          ALSO run the installed `linux-wallpaperengine` on each scene and screenshot
#                        it (`--screenshot`), then list the scenes that start there but not here.
#                        THIS DRAWS ON THE REAL OUTPUT NAMED BY --legacy-output (it takes over the
#                        desktop session for ~20 s per scene): owner-run only, never in a test lane.
#                        Stop the app's own wallpaper first (`livepaper --kill`); the runner kills
#                        each LWE it started and nothing else.
#   --legacy-output NAME the output LWE draws on (required with --ab-legacy, e.g. DP-1)
#   --legacy-delay N     LWE's --screenshot-delay in frames (default 120 = 4 s at 30 fps)
#
# Isolation (lp-player's run): its own XDG_RUNTIME_DIR / XDG_STATE_HOME / XDG_CACHE_HOME /
# socket under the results dir, `serve --no-supervise --headless --outputs 1920x1080@60 --clock
# real --ao null`, no WAYLAND_DISPLAY / DISPLAY, PipeWire/Pulse pointed at nothing (the
# visualiser tap of a scene that wants audio input can't reach the owner's session),
# LP_PLAYER_VRAM_PROBE=none (the low-VRAM rule never acts on the shared GPU). Nothing it starts
# outlives it (the EXIT trap kills only the pids it started). HOME stays real: WE's assets are
# found through ~/.local/share/Steam.
#
# Per scene: destroy the previous one and wait for its worker to be gone (measures never
# overlap), create the `kind: scene` source with NO preview (so a crash can't pass for a
# picture), show it on the output (a cut), wait Ready ≤ --ready-timeout (or a fatal error /
# broken), capture the SOURCE at +1 s, +2.3 s and +4 s (the `workers` probe's rates and GPU time read
# just before the +4 s capture), then read the `workers` probe again (with its log tail), the worker's VmHWM (peak RSS) and its VRAM (nvidia-smi, when present). Exit 0 = the run
# completed (whatever the classes); non-zero = the runner itself failed.
set -u -o pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CRATE=$(cd "$HERE/../.." && pwd -P)
REPO=$(cd "$CRATE/../.." && pwd -P)

DIR=$HOME/.local/share/Steam/steamapps/workshop/content/431960
ONLY=
LIMIT=0
READY_TIMEOUT=20
RESULTS=
REPORT_DIR=$REPO/docs/player/reports
ASSETS=
BIN=
BUILD=1
REUSE=
AB_LEGACY=0
LEGACY_OUTPUT=
LEGACY_DELAY=120

die() {
    echo "scene_corpus: $*" >&2
    exit 2
}
usage() {
    sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1
    exit "${1:-0}"
}

while (($#)); do
    case $1 in
    --dir) DIR=$2; shift ;;
    --only) ONLY=$2; shift ;;
    --limit) LIMIT=$2; shift ;;
    --ready-timeout) READY_TIMEOUT=$2; shift ;;
    --results) RESULTS=$2; shift ;;
    --report-dir) REPORT_DIR=$2; shift ;;
    --assets) ASSETS=$2; shift ;;
    --bin) BIN=$2; shift ;;
    --no-build) BUILD=0 ;;
    --reuse) REUSE=$2; shift ;;
    --ab-legacy) AB_LEGACY=1 ;;
    --legacy-output) LEGACY_OUTPUT=$2; shift ;;
    --legacy-delay) LEGACY_DELAY=$2; shift ;;
    -h | --help) usage 0 ;;
    *) echo "unknown option $1" >&2; usage 2 ;;
    esac
    shift
done

# ---------------------------------------------------------------- the steamcmd cache guard
FORBIDDEN=$HOME/.cache/livepaper/steamcmd_workshop
forbidden_path() { # $1 = a path; true if it is, or lies inside, the steamcmd cache
    local p r f
    p=$1
    r=$(realpath -m -- "$p")
    f=$(realpath -m -- "$FORBIDDEN")
    case "$r/" in "$f"/*) return 0 ;; esac
    case "$p/" in "$FORBIDDEN"/* | */steamcmd_workshop/*) return 0 ;; esac
    case "$r/" in */steamcmd_workshop/*) return 0 ;; esac
    return 1
}
if forbidden_path "$DIR"; then
    die "refusing $DIR: the steamcmd cache (~/.cache/livepaper/steamcmd_workshop) is never test media"
fi
[[ -d $DIR ]] || die "no such folder: $DIR"
DIR=$(realpath -- "$DIR")
((AB_LEGACY)) && [[ -z $LEGACY_OUTPUT ]] && die "--ab-legacy needs --legacy-output <output name> (it draws there)"
[[ -n $REUSE && ! -f $REUSE/records.jsonl ]] && die "--reuse $REUSE: no records.jsonl there"

# ---------------------------------------------------------------- the scene list
mapfile -t ALL_ITEMS < <(
    for d in "$DIR"/*/; do
        d=${d%/}
        [[ -f $d/project.json ]] || continue
        t=$(jq -r '(.type // "") | ascii_downcase' "$d/project.json" 2>/dev/null) || continue
        [[ $t == scene ]] && basename "$d"
    done | sort
)
ITEMS=()
for id in "${ALL_ITEMS[@]}"; do
    if [[ -n $ONLY && ",$ONLY," != *",$id,"* ]]; then continue; fi
    if forbidden_path "$DIR/$id"; then
        echo "scene_corpus: skipping $id: resolves into the steamcmd cache" >&2
        continue
    fi
    ITEMS+=("$id")
    ((LIMIT > 0 && ${#ITEMS[@]} >= LIMIT)) && break
done
((${#ITEMS[@]})) || die "no scene items in $DIR${ONLY:+ matching --only $ONLY}"

if [[ -n $REUSE ]]; then
    RESULTS=$(realpath -- "$REUSE")
else
    RESULTS=${RESULTS:-/tmp/lp-scene-corpus-$(date +%Y%m%d-%H%M%S)}
    mkdir -p "$RESULTS" || die "can't create $RESULTS"
    RESULTS=$(realpath -- "$RESULTS")
    case "$RESULTS/" in "$REPO"/*) die "--results must be outside the repo (captures are never committed)" ;; esac
fi
CAPS=$RESULTS/captures
mkdir -p "$CAPS"
echo "scene_corpus: ${#ITEMS[@]} scenes from $DIR → $RESULTS" >&2

unset LD_LIBRARY_PATH # the stray one on this machine breaks native links (player-core.md)

# ---------------------------------------------------------------- cleanup (our pids only)
SERVE_PID=
SUB_PID=
LWE_PID=
cleanup() {
    local p
    for p in $LWE_PID $SUB_PID; do
        kill "$p" 2>/dev/null
    done
    if [[ -n $SERVE_PID ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
        LP_PLAYER_SOCKET=$SOCK "$LP" ctl --timeout-ms 3000 quit >/dev/null 2>&1
        for _ in $(seq 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
        kill -KILL "$SERVE_PID" 2>/dev/null
    fi
    wait 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT TERM

now_ms() { date +%s%3N; }

# ---------------------------------------------------------------- lp-player's run
run_player() {
    if [[ -z $BIN ]]; then
        BIN=$CRATE/target/release
        if ((BUILD)); then
            echo "scene_corpus: building release (lp-player + lp-scene-worker)…" >&2
            (cd "$CRATE" && nix develop -c cargo build --release --bins) >"$RESULTS/build.log" 2>&1 ||
                die "release build failed: $RESULTS/build.log"
        fi
    fi
    LP=$BIN/lp-player
    [[ -x $LP && -x $BIN/lp-scene-worker ]] || die "no lp-player/lp-scene-worker in $BIN"
    "$BIN/lp-scene-worker" --features | jq -e 'index("lwe")' >/dev/null ||
        die "$BIN/lp-scene-worker was built without LWE (feature lwe)"

    local priv=$RESULTS/priv
    mkdir -p "$priv/run" "$priv/state" "$priv/cache" "$priv/config"
    chmod 700 "$priv/run"
    SOCK=$priv/run/lp.sock
    export LP_PLAYER_SOCKET=$SOCK XDG_RUNTIME_DIR=$priv/run XDG_STATE_HOME=$priv/state
    export XDG_CACHE_HOME=$priv/cache XDG_CONFIG_HOME=$priv/config
    export PIPEWIRE_RUNTIME_DIR=$priv/run PIPEWIRE_REMOTE=lp-scene-corpus-none
    export PULSE_SERVER=unix:$priv/run/no-pulse DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
    export LP_PLAYER_VRAM_PROBE=none LP_SCENE_WORKER_BIN=$BIN/lp-scene-worker
    unset WAYLAND_DISPLAY DISPLAY LP_PLAYER_ALLOW_SYNTHETIC_SCENES
    [[ -n $ASSETS ]] && export LP_WE_ASSETS_DIR=$ASSETS

    "$LP" scene-check >"$RESULTS/scene-check.json" 2>&1 ||
        die "scene-check failed: $(cat "$RESULTS/scene-check.json")"
    # RLIMIT_CORE 1: a crash (the player's own) skips systemd-coredump and its desktop popup —
    # 0 would not (a piped core_pattern still runs). The workers set it themselves too.
    prlimit --core=1:1 "$LP" serve --no-supervise --headless --outputs 1920x1080@60 \
        --clock real --ao null --log-level info >"$RESULTS/serve.log" 2>&1 &
    SERVE_PID=$!
    for _ in $(seq 150); do
        "$LP" ctl --timeout-ms 1000 hello >/dev/null 2>&1 && break
        kill -0 "$SERVE_PID" 2>/dev/null || die "serve exited: $(tail -5 "$RESULTS/serve.log")"
        sleep 0.1
    done
    "$LP" ctl hello >"$RESULTS/hello.json" || die "serve never answered"
    jq -e '.capabilities | index("scene")' "$RESULTS/hello.json" >/dev/null ||
        die "the player offers no scene capability: $(cat "$RESULTS/scene-check.json")"
    "$LP" ctl subscribe source. worker. scene. >"$RESULTS/events.jsonl" 2>/dev/null &
    SUB_PID=$!
    sleep 0.3

    : >"$RESULTS/records.jsonl"
    local n=0 prev= prev_pid= t_start
    t_start=$(now_ms)
    for wid in "${ITEMS[@]}"; do
        n=$((n + 1))
        # The previous scene goes first, its worker reaped: no two workers measure each other.
        if [[ -n $prev ]]; then
            "$LP" ctl destroy "{\"id\":\"$prev\"}" >/dev/null 2>&1
            if [[ -n $prev_pid ]]; then
                for _ in $(seq 50); do kill -0 "$prev_pid" 2>/dev/null || break; sleep 0.1; done
            fi
        fi
        play_one "$wid"
        echo "scene_corpus: [$n/${#ITEMS[@]}] $wid → $OUTCOME (${WALL_READY_MS:-–} ms)" >&2
    done
    [[ -n $prev ]] && "$LP" ctl destroy "{\"id\":\"$prev\"}" >/dev/null 2>&1
    echo "scene_corpus: lp-player run took $(( ($(now_ms) - t_start) / 1000 )) s" >&2
    "$LP" ctl logs '{"min_level":"warn","limit":10000}' >"$RESULTS/warnings.json" 2>/dev/null
    "$LP" ctl --timeout-ms 5000 quit >/dev/null 2>&1
    for _ in $(seq 100); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
    sleep 0.3
    kill "$SUB_PID" 2>/dev/null
    SUB_PID=
}

worker_entry() { # $1 = source id, $2 = probe args (json, default {}) → the entry (or null)
    local args=${2:-}
    [[ -n $args ]] || args='{}'
    "$LP" ctl probe "{\"name\":\"workers\",\"args\":$args}" 2>/dev/null |
        jq -c --arg id "$1" '[.workers[]? | select(.id == $id)][0]'
}

play_one() {
    local wid=$1 path=$DIR/$1 src t0 w state err broken ready caps=() cerr=() rss= vram= pid metrics=
    OUTCOME=
    WALL_READY_MS=
    t0=$(now_ms)
    src=$("$LP" ctl create "$(jq -nc --arg p "$path" '{kind:"source",props:{kind:"scene",path:$p}}')" |
        jq -r '.id // empty')
    if [[ -z $src ]]; then
        OUTCOME=create_failed
        jq -nc --arg wid "$wid" '{id:$wid, outcome:"create_failed"}' >>"$RESULTS/records.jsonl"
        prev=
        prev_pid=
        return
    fi
    "$LP" ctl set "{\"path\":\"lay:*:main.content\",\"value\":\"$src\"}" >/dev/null
    prev=$src
    prev_pid=
    while :; do
        w=$(worker_entry "$src")
        if [[ -z $w || $w == null ]]; then
            # Not hosted: the open itself failed (source.error says why).
            if (($(now_ms) - t0 > 2000)); then OUTCOME=open_failed; break; fi
        else
            ready=$(jq -r '.ready' <<<"$w")
            broken=$(jq -r '.broken' <<<"$w")
            err=$(jq -r '.last_error // empty' <<<"$w")
            state=$(jq -r '.state' <<<"$w")
            pid=$(jq -r '.pid // empty' <<<"$w")
            [[ -n $pid ]] && prev_pid=$pid
            if [[ $broken == true ]]; then OUTCOME=broken; break; fi
            if [[ -n $err ]]; then OUTCOME=error; break; fi
            if [[ $ready == true ]]; then
                OUTCOME=ready
                WALL_READY_MS=$(($(now_ms) - t0))
                break
            fi
        fi
        if (($(now_ms) - t0 > READY_TIMEOUT * 1000)); then OUTCOME=timeout; break; fi
        sleep 0.05
    done
    if [[ $OUTCOME == ready ]]; then
        # +1 s, +2.3 s, +4 s: a loop whose period divides 3 s (common: 1 s, 1.5 s, 3 s) shows the
        # same frame at +1 s and +4 s (ticks run on a 30 fps grid of scene time) — the third,
        # off-grid capture keeps such a scene from reading as static.
        local at ms
        for at in 1 2.3 4; do
            ms=$(awk -v a="$at" 'BEGIN { printf "%d", a * 1000 }')
            sleep_until $((WALL_READY_MS + t0 + ms))
            # The rates first: a capture reads back + encodes a PNG on the player's loop, which
            # holds latching for that long (fps_actual of the next second would show it). The
            # +2.3 s one is done by ~+2.4 s (≤ 0.1 s for a 3840×1080 frame), so the +3…+4 s
            # window is clean.
            [[ $at == 4 ]] && metrics=$(worker_entry "$src")
            local f=$CAPS/$wid-${at}s.png out
            out=$("$LP" ctl capture "{\"target\":\"$src\",\"path\":\"$f\"}" 2>&1)
            if jq -e '.path' <<<"$out" >/dev/null 2>&1; then caps+=("$f"); else cerr+=("+${at}s: $(jq -r '.message // .' <<<"$out" | head -c 300)"); fi
        done
    fi
    w=$(worker_entry "$src" '{"log_tail":true}')
    pid=$(jq -r '.pid // empty' <<<"${w:-null}" 2>/dev/null)
    if [[ -n $pid ]]; then
        prev_pid=$pid
        rss=$(awk '/^VmHWM:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
        if command -v nvidia-smi >/dev/null; then
            vram=$(nvidia-smi 2>/dev/null | awk -v p="$pid" '$5 == p { v = $(NF-1); sub(/MiB/, "", v); print v }')
        fi
    fi
    jq -nc --arg wid "$wid" --arg src "$src" --arg outcome "$OUTCOME" \
        --argjson wall "${WALL_READY_MS:-null}" --argjson worker "${w:-null}" \
        --argjson metrics "${metrics:-null}" \
        --argjson rss "${rss:-null}" --argjson vram "${vram:-null}" \
        --argjson caps "$(printf '%s\n' "${caps[@]}" | jq -R . | jq -sc 'map(select(length > 0))')" \
        --argjson cerr "$(printf '%s\n' "${cerr[@]}" | jq -R . | jq -sc 'map(select(length > 0))')" \
        --argjson t0 "$t0" \
        '{id:$wid, src:$src, outcome:$outcome, wall_ready_ms:$wall, t0_unix_ms:$t0,
          worker:$worker, metrics:$metrics, rss_hwm_kib:$rss, vram_mib:$vram, captures:$caps, capture_errors:$cerr}' \
        >>"$RESULTS/records.jsonl"
}

sleep_until() { # $1 = unix ms
    local d=$(($1 - $(now_ms)))
    ((d > 0)) && sleep "$(awk -v d="$d" 'BEGIN { printf "%.3f", d / 1000 }')"
}

# ---------------------------------------------------------------- the legacy A/B (owner-run)
run_legacy() {
    local lwe assets
    lwe=$(command -v linux-wallpaperengine) || die "--ab-legacy: linux-wallpaperengine is not installed"
    [[ -n ${WAYLAND_DISPLAY:-} ]] || die "--ab-legacy runs in the desktop session (no WAYLAND_DISPLAY)"
    assets=${ASSETS:-$(jq -r '.assets_dir // empty' "$RESULTS/scene-check.json" 2>/dev/null)}
    [[ -n $assets ]] || die "--ab-legacy: no WE assets dir (pass --assets)"
    echo "scene_corpus: --ab-legacy: linux-wallpaperengine draws on $LEGACY_OUTPUT for each scene" >&2
    # A fresh folder per run: a screenshot left by an earlier run can't pass for this one's.
    LEG=$RESULTS/legacy-$(date +%Y%m%d-%H%M%S)
    mkdir -p "$LEG"
    : >"$RESULTS/legacy.jsonl"
    local wid png t0 status code
    for wid in "${ITEMS[@]}"; do
        png=$LEG/$wid.png
        t0=$(now_ms)
        prlimit --core=1:1 "$lwe" --silent --noautomute --no-fullscreen-pause --fps 30 --assets-dir "$assets" \
            --screenshot "$png" --screenshot-delay "$LEGACY_DELAY" \
            --screen-root "$LEGACY_OUTPUT" --bg "$DIR/$wid" >"$LEG/$wid.log" 2>&1 &
        LWE_PID=$!
        status=timeout
        code=
        while (($(now_ms) - t0 < READY_TIMEOUT * 1000)); do
            if [[ -s $png ]]; then sleep 0.5; status=screenshot; break; fi
            if ! kill -0 "$LWE_PID" 2>/dev/null; then
                wait "$LWE_PID"
                code=$?
                status=exited
                [[ -s $png ]] && status=screenshot
                break
            fi
            sleep 0.1
        done
        if kill -0 "$LWE_PID" 2>/dev/null; then
            kill "$LWE_PID"
            for _ in $(seq 30); do kill -0 "$LWE_PID" 2>/dev/null || break; sleep 0.1; done
            kill -KILL "$LWE_PID" 2>/dev/null
            wait "$LWE_PID" 2>/dev/null
        fi
        LWE_PID=
        jq -nc --arg wid "$wid" --arg status "$status" --argjson code "${code:-null}" \
            --argjson ms "$(($(now_ms) - t0))" \
            --arg png "$([[ -s $png ]] && echo "$png")" \
            --argjson tail "$(tail -n 30 "$LEG/$wid.log" | jq -R . | jq -sc .)" \
            '{id:$wid, status:$status, code:$code, ms:$ms,
              screenshot:(if $png == "" then null else $png end), log_tail:$tail}' >>"$RESULTS/legacy.jsonl"
        echo "scene_corpus: legacy $wid → $status" >&2
    done
}

[[ -z $REUSE ]] && run_player
((AB_LEGACY)) && run_legacy

REPORT_ARGS=(--results "$RESULTS" --dir "$DIR")
[[ $REPORT_DIR != - ]] && REPORT_ARGS+=(--report-dir "$REPORT_DIR")
python3 -I "$HERE/scene_corpus_report.py" "${REPORT_ARGS[@]}" || die "the report failed"
