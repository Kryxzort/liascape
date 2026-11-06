#!/usr/bin/env bash
# The WE-reference compare: renders every scene that has a real-Wallpaper-Engine capture
# (scripts/dev/we-ref-capture.sh → <refs>/<id>/{manifest.json, t<T>s.png}) through the scene worker's `--lwe-smoke`
# at the same scene times, with the same user properties and pointer path, and scores each pair
# (scene_we_report.py: the preview compare's measures, no alignment — both frames are the whole canvas).
# Ranks the scenes worst first into docs/player/reports/scene-we-ref.{md,json}, side-by-sides
# (WE | ours | |diff| x4) into the results dir and, small, into docs/player/reports/we-ref/sbs/.
#
# Where the preview compare asks "does it look like the author's poster", this asks "does it look like WE": the
# goal picture. Still a ranked list, not pass/fail (WE's particles are unseeded, its time base is +-80 ms).
#
#   bash src/player/tests/onmachine/scene_we_compare.sh                         # every captured scene
#   bash src/player/tests/onmachine/scene_we_compare.sh --only 3184155462 --refs ~/.cache/liascape/we-ref/captures/rip-drag
#   bash src/player/tests/onmachine/scene_we_compare.sh --reuse /tmp/liascape-scene-we-<stamp>   # re-score
#
# Options:
#   --refs DIR         the captures (default ~/.cache/liascape/we-ref/captures)
#   --dir DIR          Workshop content folder (default ~/.local/share/Steam/steamapps/workshop/content/431960);
#                      REFUSED when it is (or resolves into) a steamcmd_workshop cache
#   --only ID[,ID…]    only these ids;  --limit N: the first N
#   --first ID[,ID…]   list these first in the report whatever their score
#   --timeout S        per-scene wall limit (default 90)
#   --results DIR      default /tmp/liascape-scene-we-<stamp> (never the repo)
#   --report-dir DIR   default <repo>/docs/player/reports ("-" = the results dir only)
#   --sbs-dir DIR      default <repo>/docs/player/reports/we-ref/sbs ("-" = none)
#   --assets DIR, --bin DIR, --core DIR, --no-build, --reuse DIR   as scene_preview_compare.sh
set -u -o pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CRATE=$(cd "$HERE/../.." && pwd -P)
REPO=$(cd "$CRATE/../.." && pwd -P)

REFS=${XDG_CACHE_HOME:-$HOME/.cache}/liascape/we-ref/captures
DIR=$HOME/.local/share/Steam/steamapps/workshop/content/431960
ONLY=
FIRST=
LIMIT=0
CORE=
TIMEOUT=90
RESULTS=
REPORT_DIR=$REPO/docs/player/reports
SBS_DIR=$REPO/docs/player/reports/we-ref/sbs
ASSETS=
BIN=
BUILD=1
REUSE=

die() {
    echo "scene_we: $*" >&2
    exit 2
}
usage() {
    sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1
    exit "${1:-0}"
}

while (($#)); do
    case $1 in
    --refs) REFS=$2; shift ;;
    --dir) DIR=$2; shift ;;
    --only) ONLY=$2; shift ;;
    --first) FIRST=$2; shift ;;
    --limit) LIMIT=$2; shift ;;
    --core) CORE=$2; shift ;;
    --timeout) TIMEOUT=$2; shift ;;
    --results) RESULTS=$2; shift ;;
    --report-dir) REPORT_DIR=$2; shift ;;
    --sbs-dir) SBS_DIR=$2; shift ;;
    --assets) ASSETS=$2; shift ;;
    --bin) BIN=$2; shift ;;
    --no-build) BUILD=0 ;;
    --reuse) REUSE=$2; shift ;;
    -h | --help) usage 0 ;;
    *) echo "unknown option $1" >&2; usage 2 ;;
    esac
    shift
done

case "$(realpath -m -- "$DIR")/" in */steamcmd_workshop/*) die "refusing $DIR: a steamcmd_workshop cache is never test media" ;; esac
[[ -d $DIR ]] || die "no such folder: $DIR"
[[ -d $REFS ]] || die "no captures in $REFS (scripts/dev/we-ref-capture.sh)"
DIR=$(realpath -- "$DIR")

ITEMS=()
for m in "$REFS"/*/manifest.json; do
    [[ -f $m ]] || continue
    id=$(basename "$(dirname "$m")")
    [[ -n $ONLY && ",$ONLY," != *",$id,"* ]] && continue
    [[ -f $DIR/$id/project.json ]] || { echo "scene_we: skipping $id: not in $DIR" >&2; continue; }
    ITEMS+=("$id")
    ((LIMIT > 0 && ${#ITEMS[@]} >= LIMIT)) && break
done
((${#ITEMS[@]})) || die "no captured scenes in $REFS${ONLY:+ matching --only $ONLY}"

if [[ -n $REUSE ]]; then
    RESULTS=$(realpath -- "$REUSE")
    [[ -f $RESULTS/run.json ]] || die "--reuse $REUSE: no run.json there"
else
    RESULTS=${RESULTS:-/tmp/liascape-scene-we-$(date +%Y%m%d-%H%M%S)}
    mkdir -p "$RESULTS" || die "can't create $RESULTS"
    RESULTS=$(realpath -- "$RESULTS")
    case "$RESULTS/" in "$REPO"/*) die "--results must be outside the repo (captures are never committed)" ;; esac
fi

unset LD_LIBRARY_PATH # the stray one on this machine breaks native links (player-core.md)

run_all() {
    if [[ -z $BIN ]]; then
        BIN=$CRATE/target/release
        if ((BUILD)); then
            echo "scene_we: building release liascape-scene-worker…" >&2
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
    export XDG_RUNTIME_DIR=$priv/run PIPEWIRE_RUNTIME_DIR=$priv/run PIPEWIRE_REMOTE=liascape-scene-we-none
    export PULSE_SERVER=unix:$priv/run/no-pulse DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
    unset WAYLAND_DISPLAY DISPLAY WPENGINE_HEALTH
    export WPENGINE_PARTICLE_SEED=7
    local core_lib=
    if [[ -n $CORE ]]; then
        core_lib=$(realpath -- "$CORE") || die "no such core dir: $CORE"
        [[ -f $core_lib/liblinux-wallpaperengine-core.so ]] || die "no liblinux-wallpaperengine-core.so in $CORE"
    fi
    local m0=$REFS/${ITEMS[0]}/manifest.json
    jq -n --arg dir "$DIR" --arg refs "$REFS" --arg assets "$ASSETS" --arg worker "$worker" --arg core "$core_lib" \
        --arg started "$(date -Iseconds)" --arg commit "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)$(git -C "$REPO" diff --quiet 2>/dev/null || echo +dirty)" \
        --arg pin "$(jq -r .rev "$REPO/third_party/lwe/PIN" 2>/dev/null | cut -c1-12)" \
        --arg gpu "$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1)" \
        --arg we "$(jq -r .we "$m0")" --arg proton "$(jq -r .proton "$m0" | awk '{print $2}')" \
        '{dir:$dir, refs:$refs, assets:$assets, worker:$worker, core:$core, started:$started, commit:$commit, pin:$pin, gpu:$gpu, we:$we, proton:$proton}' \
        >"$RESULTS/run.json"

    local n=0 t_start=$SECONDS id out t0 code m shots width args
    for id in "${ITEMS[@]}"; do
        n=$((n + 1))
        m=$REFS/$id/manifest.json
        out=$RESULTS/scenes/$id
        mkdir -p "$out"
        shots=$(jq -r '[.shots[] | (.t_actual // .t) | . * 10 | round / 10 | tostring] | unique | join(",")' "$m")
        width=$(jq -r '.window[0]' "$m")
        args=(--shots "$shots" --shot-width "$width")
        while IFS= read -r p; do [[ -n $p ]] && args+=(--prop "$p"); done < <(jq -r '.props[]?' "$m")
        p=$(jq -r '.pointer // ""' "$m")
        if [[ -n $p ]]; then
            [[ $p == *:* ]] || p="$p:$p"
            args+=(--pointer "$p")
            pt=$(jq -r '.pointer_time // ""' "$m")
            [[ -n $pt ]] && args+=(--pointer-time "$pt")
        fi
        t0=$(date +%s%3N)
        LIASCAPE_SCENE_STORAGE_DIR=$out/storage LD_LIBRARY_PATH=$core_lib prlimit --core=1:1 \
            timeout -k 10 "$TIMEOUT" "$worker" --lwe-smoke "$DIR/$id" --assets "$ASSETS" --out "$out" \
            --seconds 1 "${args[@]}" >"$out/smoke.json" 2>"$out/stderr.log"
        code=$?
        jq -n --arg id "$id" --argjson code "$code" --argjson ms "$(($(date +%s%3N) - t0))" \
            '{id:$id, exit:$code, wall_ms:$ms}' >"$out/exit.json"
        echo "scene_we: [$n/${#ITEMS[@]}] $id → exit $code" >&2
    done
    echo "scene_we: ${#ITEMS[@]} scenes in $((SECONDS - t_start)) s" >&2
}

[[ -z $REUSE ]] && run_all

PY=(python3 -I)
if ! python3 -c 'import numpy, PIL, cv2' 2>/dev/null; then
    pyenv=$(nix build --no-link --print-out-paths --impure --expr \
        "(builtins.getFlake \"path:$REPO\").inputs.nixpkgs.legacyPackages.\${builtins.currentSystem}.python3.withPackages (p: [p.numpy p.pillow p.opencv4])" 2>/dev/null) ||
        die "no python3 with numpy + Pillow + OpenCV (and the nix fallback failed)"
    PY=("$pyenv/bin/python3" -I)
fi
ARGS=(--results "$RESULTS" --refs "$REFS" --first "$FIRST")
[[ $REPORT_DIR != - ]] && ARGS+=(--report-dir "$REPORT_DIR")
[[ $SBS_DIR != - ]] && ARGS+=(--sbs-dir "$SBS_DIR")
"${PY[@]}" "$HERE/scene_we_report.py" "${ARGS[@]}" || die "the report failed"
