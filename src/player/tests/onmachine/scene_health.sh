#!/usr/bin/env bash
# The per-scene health report: runs every Wallpaper Engine scene of the Workshop folder through the scene worker's
# `--lwe-smoke` (one process per scene, offscreen, 3 s of frames), which has LWE's core write what it built and what
# it left out (`WPENGINE_HEALTH`, fork patches 0061–0062 → `<out>/health.json`: each object built or dropped and why, shader /
# script / asset errors, unsupported features, each layer's canvas bbox at frames 1 and 31). scene_health_report.py
# classifies each scene clean | degraded | failed, ranks the degraded ones by what they lose, tallies the commonest
# root causes, and writes docs/player/reports/scene-health.{md,json}.
#
# The scene corpus (scene_corpus.sh) asks "does it load and isn't it blank"; this asks "what did it silently drop"
# (3414858021 passed the corpus for months with its head's compose layer dropped).
#
#   bash src/player/tests/onmachine/scene_health.sh                     # the whole 431960 folder
#   bash src/player/tests/onmachine/scene_health.sh --only 3414858021,2189783622
#   bash src/player/tests/onmachine/scene_health.sh --reuse /tmp/liascape-scene-health-<stamp>   # re-report
#
# Options:
#   --dir DIR          Workshop content folder (default ~/.local/share/Steam/steamapps/workshop/content/431960).
#                      REFUSED when it is (or resolves into) a steamcmd_workshop cache — never test media.
#   --only ID[,ID…]    only these workshop ids
#   --limit N          only the first N scenes (sorted by id)
#   --seconds S        smoke frames (default 3; layers are reported at frames 1 and 31)
#   --timeout S        per-scene wall limit (default 90; then TERM, KILL 10 s later)
#   --results DIR      where each scene's PNGs + health.json go (default /tmp/liascape-scene-health-<stamp>; never
#                      the repo — captures of scenes are not committed)
#   --report-dir DIR   where scene-health.{md,json} go (default <repo>/docs/player/reports; "-" = the results dir only)
#   --assets DIR       WE's assets dir (default: /@steam/…/wallpaper_engine/assets, else liascape's resolution)
#   --bin DIR          dir holding liascape-scene-worker (default <crate>/target/release, built with
#                      `cargo build --release --bin liascape-scene-worker` in the devShell unless --no-build)
#   --no-build         use --bin / target/release as is
#   --reuse DIR        skip the runs; re-report DIR
#
# Isolation: each smoke runs with RLIMIT_CORE 1 (no coredump popup), no WAYLAND_DISPLAY / DISPLAY, PipeWire / Pulse
# pointed at nothing (the core's audio goes to the smoke's host driver, never a device), the scene's localStorage under
# its results dir. Exit 0 = the run completed (whatever the classes); non-zero = the runner itself failed.
set -u -o pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CRATE=$(cd "$HERE/../.." && pwd -P)
REPO=$(cd "$CRATE/../.." && pwd -P)

DIR=$HOME/.local/share/Steam/steamapps/workshop/content/431960
ONLY=
LIMIT=0
SECONDS_=3
TIMEOUT=90
RESULTS=
REPORT_DIR=$REPO/docs/player/reports
ASSETS=
BIN=
BUILD=1
REUSE=

die() {
    echo "scene_health: $*" >&2
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
    --seconds) SECONDS_=$2; shift ;;
    --timeout) TIMEOUT=$2; shift ;;
    --results) RESULTS=$2; shift ;;
    --report-dir) REPORT_DIR=$2; shift ;;
    --assets) ASSETS=$2; shift ;;
    --bin) BIN=$2; shift ;;
    --no-build) BUILD=0 ;;
    --reuse) REUSE=$2; shift ;;
    -h | --help) usage 0 ;;
    *) echo "unknown option $1" >&2; usage 2 ;;
    esac
    shift
done

# ---------------------------------------------------------------- the steamcmd cache guard (as scene_corpus.sh)
FORBIDDEN=$HOME/.cache/liascape/steamcmd_workshop
forbidden_path() {
    local p r f
    p=$1
    r=$(realpath -m -- "$p")
    f=$(realpath -m -- "$FORBIDDEN")
    case "$r/" in "$f"/*) return 0 ;; esac
    case "$p/" in "$FORBIDDEN"/* | */steamcmd_workshop/*) return 0 ;; esac
    case "$r/" in */steamcmd_workshop/*) return 0 ;; esac
    return 1
}
forbidden_path "$DIR" && die "refusing $DIR: a steamcmd_workshop cache is never test media"
[[ -d $DIR ]] || die "no such folder: $DIR"
DIR=$(realpath -- "$DIR")

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
        echo "scene_health: skipping $id: resolves into a steamcmd cache" >&2
        continue
    fi
    ITEMS+=("$id")
    ((LIMIT > 0 && ${#ITEMS[@]} >= LIMIT)) && break
done
((${#ITEMS[@]})) || die "no scene items in $DIR${ONLY:+ matching --only $ONLY}"

if [[ -n $REUSE ]]; then
    RESULTS=$(realpath -- "$REUSE")
    [[ -f $RESULTS/run.json ]] || die "--reuse $REUSE: no run.json there"
else
    RESULTS=${RESULTS:-/tmp/liascape-scene-health-$(date +%Y%m%d-%H%M%S)}
    mkdir -p "$RESULTS" || die "can't create $RESULTS"
    RESULTS=$(realpath -- "$RESULTS")
    case "$RESULTS/" in "$REPO"/*) die "--results must be outside the repo (captures are never committed)" ;; esac
fi

unset LD_LIBRARY_PATH # the stray one on this machine breaks native links (.claude/rules/player/core.md)

run_all() {
    if [[ -z $BIN ]]; then
        BIN=$CRATE/target/release
        if ((BUILD)); then
            echo "scene_health: building release liascape-scene-worker…" >&2
            (cd "$CRATE" && nix develop ../.. -c cargo build --release --bin liascape-scene-worker) >"$RESULTS/build.log" 2>&1 ||
                die "release build failed: $RESULTS/build.log"
        fi
    fi
    local worker=$BIN/liascape-scene-worker
    [[ -x $worker ]] || die "no liascape-scene-worker in $BIN"
    "$worker" --features | jq -e 'index("lwe")' >/dev/null || die "$worker was built without LWE (feature lwe)"
    if [[ -z $ASSETS ]]; then
        for a in /@steam/SteamLibrary/steamapps/common/wallpaper_engine/assets \
            "$HOME/.local/share/Steam/steamapps/common/wallpaper_engine/assets"; do
            [[ -d $a ]] && { ASSETS=$a; break; }
        done
    fi
    [[ -d $ASSETS ]] || die "no WE assets dir (pass --assets)"

    local priv=$RESULTS/priv
    mkdir -p "$priv/run"
    chmod 700 "$priv/run"
    export XDG_RUNTIME_DIR=$priv/run PIPEWIRE_RUNTIME_DIR=$priv/run PIPEWIRE_REMOTE=liascape-scene-health-none
    # NVIDIA's shader cache too: the caller's __GL_SHADER_DISK_CACHE_PATH is the user's real one (the player
    # creates and fills it), and unset the driver falls back to ~/.cache/nvidia.
    export __GL_SHADER_DISK_CACHE_PATH=$priv/nv-shader-cache
    export PULSE_SERVER=unix:$priv/run/no-pulse DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
    unset WAYLAND_DISPLAY DISPLAY WPENGINE_HEALTH

    jq -n --arg dir "$DIR" --arg assets "$ASSETS" --arg worker "$worker" --argjson seconds "$SECONDS_" \
        --arg started "$(date -Iseconds)" --arg commit "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)$(git -C "$REPO" diff --quiet 2>/dev/null || echo +dirty)" \
        --arg lwe "$(cat "$(dirname "$(readlink -f "$(ldd "$worker" | awk '/liblinux-wallpaperengine-core/ {print $3}')")")/../REV" 2>/dev/null)" \
        --arg pin "$(jq -r .rev "$REPO/third_party/lwe/PIN" 2>/dev/null | cut -c1-12)" \
        --arg gpu "$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1)" \
        '{dir:$dir, assets:$assets, worker:$worker, seconds:$seconds, started:$started, commit:$commit, lwe:$lwe, pin:$pin, gpu:$gpu}' \
        >"$RESULTS/run.json"

    local n=0 t_start=$SECONDS id out t0 code
    for id in "${ITEMS[@]}"; do
        n=$((n + 1))
        out=$RESULTS/scenes/$id
        mkdir -p "$out"
        t0=$(date +%s%3N)
        LIASCAPE_SCENE_STORAGE_DIR=$out/storage prlimit --core=1:1 \
            timeout -k 10 "$TIMEOUT" "$worker" --lwe-smoke "$DIR/$id" --assets "$ASSETS" --out "$out" \
            --seconds "$SECONDS_" >"$out/smoke.json" 2>"$out/stderr.log"
        code=$?
        jq -n --arg id "$id" --argjson code "$code" --argjson ms "$(($(date +%s%3N) - t0))" \
            '{id:$id, exit:$code, wall_ms:$ms}' >"$out/exit.json"
        echo "scene_health: [$n/${#ITEMS[@]}] $id → exit $code ($(jq -r '.counts // {} | to_entries | map("\(.key) \(.value)") | join(", ")' "$out/health.json" 2>/dev/null))" >&2
    done
    echo "scene_health: ${#ITEMS[@]} scenes in $((SECONDS - t_start)) s" >&2
}

[[ -z $REUSE ]] && run_all

REPORT_ARGS=(--results "$RESULTS")
[[ $REPORT_DIR != - ]] && REPORT_ARGS+=(--report-dir "$REPORT_DIR")
python3 -I "$HERE/scene_health_report.py" "${REPORT_ARGS[@]}" || die "the report failed"
