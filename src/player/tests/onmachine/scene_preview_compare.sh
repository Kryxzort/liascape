#!/usr/bin/env bash
# The preview compare: renders every Wallpaper Engine scene of the Workshop folder through the scene worker's
# `--lwe-smoke` (one process per scene, offscreen, small frames at 0.5 / 2 / 5 s) and scores each against the
# author's preview (`project.json` `preview`: a square jpg / png / gif from WE's editor). scene_preview_report.py
# aligns every (frame, preview frame) pair, scores it (SSIM + colour histogram + edges + the worst local cells),
# ranks the scenes worst first, writes side-by-sides and a contact sheet of the worst 20 into the results dir and
# docs/player/reports/scene-preview.{md,json}.
#
# The health report (scene_health.sh) asks "what did the core leave out"; this asks "does it look like what the
# author saw" — a scene can build cleanly and still be wrong (3414858021's head, from a wrong transform).
# A ranked "look here first" list, not pass/fail: previews are crops, edited, or another moment of the animation;
# scene_preview_notes.json says which differences are explained.
#
#   bash src/player/tests/onmachine/scene_preview_compare.sh                    # the whole 431960 folder
#   bash src/player/tests/onmachine/scene_preview_compare.sh --only 3414858021 --core build/lwe-core-dev/lib
#   bash src/player/tests/onmachine/scene_preview_compare.sh --reuse /tmp/liascape-scene-preview-<stamp>   # re-score
#
# Options:
#   --dir DIR          Workshop content folder (default ~/.local/share/Steam/steamapps/workshop/content/431960).
#                      REFUSED when it is (or resolves into) a steamcmd_workshop cache — never test media.
#   --only ID[,ID…]    only these workshop ids
#   --limit N          only the first N scenes (sorted by id)
#   --shots T,T…       scene times of the frames (default 0.5,2,5)
#   --shot-width W     frames box-filtered to at most W px wide (default 640: small files, the scorer works at 128)
#   --timeout S        per-scene wall limit (default 90; then TERM, KILL 10 s later)
#   --results DIR      where each scene's PNGs go (default /tmp/liascape-scene-preview-<stamp>; never the repo)
#   --report-dir DIR   where scene-preview.{md,json} go (default <repo>/docs/player/reports; "-" = the results dir only)
#   --assets DIR       WE's assets dir (default: /@steam/…/wallpaper_engine/assets, else liascape's resolution)
#   --bin DIR          dir holding liascape-scene-worker (default <crate>/target/release, built unless --no-build)
#   --core DIR         run the worker against this core lib dir (LD_LIBRARY_PATH) instead of its linked one —
#                      a fork working tree's build, or an old core for a before/after
#   --no-build         use --bin / target/release as is
#   --reuse DIR        skip the runs; re-score DIR
#
# Isolation as scene_health.sh: RLIMIT_CORE 1, no WAYLAND_DISPLAY / DISPLAY, PipeWire / Pulse pointed at nothing,
# the scene's localStorage under its results dir; WPENGINE_PARTICLE_SEED=7 so particles land the same each run.
set -u -o pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CRATE=$(cd "$HERE/../.." && pwd -P)
REPO=$(cd "$CRATE/../.." && pwd -P)

DIR=$HOME/.local/share/Steam/steamapps/workshop/content/431960
ONLY=
LIMIT=0
SHOTS=0.5,2,5
SHOT_WIDTH=640
CORE=
TIMEOUT=90
RESULTS=
REPORT_DIR=$REPO/docs/player/reports
ASSETS=
BIN=
BUILD=1
REUSE=

die() {
    echo "scene_preview: $*" >&2
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
    --shots) SHOTS=$2; shift ;;
    --shot-width) SHOT_WIDTH=$2; shift ;;
    --core) CORE=$2; shift ;;
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
        echo "scene_preview: skipping $id: resolves into a steamcmd cache" >&2
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
    RESULTS=${RESULTS:-/tmp/liascape-scene-preview-$(date +%Y%m%d-%H%M%S)}
    mkdir -p "$RESULTS" || die "can't create $RESULTS"
    RESULTS=$(realpath -- "$RESULTS")
    case "$RESULTS/" in "$REPO"/*) die "--results must be outside the repo (captures are never committed)" ;; esac
fi

unset LD_LIBRARY_PATH # the stray one on this machine breaks native links (player-core.md)

run_all() {
    if [[ -z $BIN ]]; then
        BIN=$CRATE/target/release
        if ((BUILD)); then
            echo "scene_preview: building release liascape-scene-worker…" >&2
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
    export XDG_RUNTIME_DIR=$priv/run PIPEWIRE_RUNTIME_DIR=$priv/run PIPEWIRE_REMOTE=liascape-scene-preview-none
    export PULSE_SERVER=unix:$priv/run/no-pulse DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
    unset WAYLAND_DISPLAY DISPLAY WPENGINE_HEALTH
    export WPENGINE_PARTICLE_SEED=7
    local core_lib=
    if [[ -n $CORE ]]; then
        core_lib=$(realpath -- "$CORE") || die "no such core dir: $CORE"
        [[ -f $core_lib/liblinux-wallpaperengine-core.so ]] || die "no liblinux-wallpaperengine-core.so in $CORE"
    fi

    jq -n --arg dir "$DIR" --arg assets "$ASSETS" --arg worker "$worker" --arg shots "$SHOTS" --argjson shot_width "$SHOT_WIDTH" --arg core "$core_lib" \
        --arg started "$(date -Iseconds)" --arg commit "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)$(git -C "$REPO" diff --quiet 2>/dev/null || echo +dirty)" \
        --arg lwe "$(if [[ -n $core_lib ]]; then echo "dev core $core_lib"; else cat "$(dirname "$(readlink -f "$(ldd "$worker" | awk '/liblinux-wallpaperengine-core/ {print $3}')")")/../REV" 2>/dev/null; fi)" \
        --arg pin "$(jq -r .rev "$REPO/third_party/lwe/PIN" 2>/dev/null | cut -c1-12)" \
        --arg gpu "$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1)" \
        '{dir:$dir, assets:$assets, worker:$worker, shots:$shots, shot_width:$shot_width, core:$core, started:$started, commit:$commit, lwe:$lwe, pin:$pin, gpu:$gpu}' \
        >"$RESULTS/run.json"

    local n=0 t_start=$SECONDS id out t0 code
    for id in "${ITEMS[@]}"; do
        n=$((n + 1))
        out=$RESULTS/scenes/$id
        mkdir -p "$out"
        t0=$(date +%s%3N)
        LIASCAPE_SCENE_STORAGE_DIR=$out/storage LD_LIBRARY_PATH=$core_lib prlimit --core=1:1 \
            timeout -k 10 "$TIMEOUT" "$worker" --lwe-smoke "$DIR/$id" --assets "$ASSETS" --out "$out" \
            --seconds 1 --shots "$SHOTS" --shot-width "$SHOT_WIDTH" >"$out/smoke.json" 2>"$out/stderr.log"
        code=$?
        jq -n --arg id "$id" --argjson code "$code" --argjson ms "$(($(date +%s%3N) - t0))" \
            '{id:$id, exit:$code, wall_ms:$ms}' >"$out/exit.json"
        echo "scene_preview: [$n/${#ITEMS[@]}] $id → exit $code" >&2
    done
    echo "scene_preview: ${#ITEMS[@]} scenes in $((SECONDS - t_start)) s" >&2
}

[[ -z $REUSE ]] && run_all

# the scorer needs numpy, Pillow and OpenCV: the system python3 when it has them, else the flake's nixpkgs
PY=(python3 -I)
if ! python3 -c 'import numpy, PIL, cv2' 2>/dev/null; then
    pyenv=$(nix build --no-link --print-out-paths --impure --expr \
        "(builtins.getFlake \"path:$REPO\").inputs.nixpkgs.legacyPackages.\${builtins.currentSystem}.python3.withPackages (p: [p.numpy p.pillow p.opencv4])" 2>/dev/null) ||
        die "no python3 with numpy + Pillow + OpenCV (and the nix fallback failed)"
    PY=("$pyenv/bin/python3" -I)
fi
REPORT_ARGS=(--results "$RESULTS" --dir "$DIR")
[[ $REPORT_DIR != - ]] && REPORT_ARGS+=(--report-dir "$REPORT_DIR")
"${PY[@]}" "$HERE/scene_preview_report.py" "${REPORT_ARGS[@]}" || die "the report failed"
