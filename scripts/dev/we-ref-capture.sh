#!/usr/bin/env bash
# we-ref-capture.sh — reference frames from the REAL Wallpaper Engine (Steam app 431960, Windows build) run under
# Proton inside a headless gamescope, so Liascape's renderer has a goal picture to diff against
# (src/player/tests/onmachine/scene_we_compare.sh). Nothing appears on the real outputs, nothing is heard.
#
#   scripts/dev/we-ref-capture.sh 3184155462                          # frames at 0.5, 2, 5 s
#   scripts/dev/we-ref-capture.sh 3184155462 --times 1,2,3,5
#   scripts/dev/we-ref-capture.sh 3516174947 --prop newproperty30=1   # a user property (JSON value, else a string)
#   scripts/dev/we-ref-capture.sh 3463520581 --pointer 400,300:3400,1800   # pointer path, native scene px
#   scripts/dev/we-ref-capture.sh --batch [--limit N] [--skip-done]  # every scene of the Workshop folder
#   scripts/dev/we-ref-capture.sh --setup | --stop
#
# Options:
#   --times T,T…     scene times of the frames, seconds after WE's first non-black frame (default 0.5,2,5)
#   --seconds N      shorthand for --times N
#   --prop k=v       user property (repeatable); written into WE's config.json before WE starts (WE ignores
#                    `-control applyProperties` on a window without its UI, so every scene is a fresh start)
#   --pointer X,Y | X0,Y0:X1,Y1   the cursor (native scene px, y down, like the worker's --pointer): parked at
#                    X0,Y0 before the scene opens, then moved in a straight line to X1,Y1 by the last frame
#   --pointer-time A-B   move the pointer between scene seconds A and B only (default 0-<last time>): parked
#                    before, still after — e.g. a 1 s drag then frames while a cursor ripple settles
#   --fps N          WE's frame-rate limit and gamescope's refresh (default 30, the worker's pace). Frame-time-
#                    dependent effects differ with it (cursorripple's force is ~ frametime: weaker at 240 fps)
#   --builtin-d3dcompiler  keep Wine's d3dcompiler_47 (default: Microsoft's, from /mnt/Windows, with a native
#                    override — WE compiles its shaders at run time). Fonts: the Windows ones, linked into the prefix
#   --we-setting k=v WE's own setting (config.json general.user, repeatable), e.g. videohardwareacceleration=false
#   --desktop        render at the full 1920x1080 "desktop" (WE's cover fit) instead of the canvas's own aspect
#   --tag NAME       a variant (other props / pointer / --desktop): PNGs into <out>/NAME/<id>, JPEGs into
#                    <docs>/<id>/NAME — the compare's default refs stay the plain captures
#   --repeat N       capture the scene N times (fresh starts) — the determinism check; runs land in r1…rN
#   --batch          all scene items of ~/.local/share/Steam/steamapps/workshop/content/431960 (sorted by id)
#   --only ID,ID…    with --batch: only these; --limit N: the first N; --skip-done: skip ids with a manifest
#   --out DIR        full-size PNGs (default ~/.cache/liascape/we-ref/captures; never the repo)
#   --docs DIR       small JPEGs (960 px) + manifest.json per id (default <repo>/docs/player/reports/we-ref);
#                    "-" = none
#   --proton DIR     the Proton build (default Steam's "Proton - Experimental")
#   --keep           leave WE running after the last scene (debugging; --stop ends it)
#
# How (docs/player/spikes/we-proton.md): umu-run (steam-run FHS) starts wallpaper64.exe from a symlink farm of the
# WE install (the Windows drive's 2.8.485 when mounted, else a reflink copy of /@steam's) with its own
# config.json, in a dedicated prefix (~/.cache/liascape/we-ref/pfx, never Steam's compatdata), inside
# `gamescope --backend headless`. wine's Pulse and ALSA drivers are disabled (no audio device at all). The scene is
# opened with `-control openWallpaper -file … -playInWindow Ref`, frames come from `gamescopectl screenshot`, the
# cursor is moved with xdotool on gamescope's Xwayland. Steam needn't be running: WE's renderer never loads
# steam_api.
set -u -o pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
TOOL=(python3 -I "$HERE/we_ref_tool.py")

WR=${WE_REF_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/liascape/we-ref}
WORKSHOP=$HOME/.local/share/Steam/steamapps/workshop/content/431960
WE_WIN="/mnt/Windows/Program Files (x86)/Steam/steamapps/common/wallpaper_engine"
WE_LINUX=/@steam/SteamLibrary/steamapps/common/wallpaper_engine
PROTON="/@steam/SteamLibrary/steamapps/common/Proton - Experimental"
UMU=$HOME/.local/share/lutris/runtime/umu/umu-run
TIMES=0.5,2,5
PROPS=()
POINTER=
PTIME=
FPS=30
USE_WIN_D3DC=1
USE_WIN_FONTS=1
WE_SETTINGS=()
DESKTOP=0
REPEAT=1
BATCH=0
ONLY=
LIMIT=0
SKIP_DONE=0
OUT=
DOCS=$REPO/docs/player/reports/we-ref
KEEP=0
TAG=
MODE=capture
IDS=()

die() {
    echo "we-ref: $*" >&2
    exit 2
}
log() { echo "we-ref: $*" >&2; }
usage() {
    sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1
    exit "${1:-0}"
}

while (($#)); do
    case $1 in
    --times) TIMES=$2; shift ;;
    --seconds) TIMES=$2; shift ;;
    --prop) PROPS+=("$2"); shift ;;
    --pointer) POINTER=$2; shift ;;
    --pointer-time) PTIME=$2; shift ;;
    --fps) FPS=$2; shift ;;
    --we-setting) WE_SETTINGS+=("$2"); shift ;;
    --builtin-d3dcompiler) USE_WIN_D3DC=0 ;;
    --desktop) DESKTOP=1 ;;
    --repeat) REPEAT=$2; shift ;;
    --batch) BATCH=1 ;;
    --only) ONLY=$2; shift ;;
    --limit) LIMIT=$2; shift ;;
    --skip-done) SKIP_DONE=1 ;;
    --out) OUT=$2; shift ;;
    --docs) DOCS=$2; shift ;;
    --proton) PROTON=$2; shift ;;
    --keep) KEEP=1 ;;
    --tag) TAG=$2; shift ;;
    --setup) MODE=setup ;;
    --stop) MODE=stop ;;
    -h | --help) usage 0 ;;
    -*) echo "unknown option $1" >&2; usage 2 ;;
    *) IDS+=("$1") ;;
    esac
    shift
done

OUT=${OUT:-$WR/captures}
case "$(realpath -m -- "$OUT")/" in "$REPO"/*) die "--out must be outside the repo (full-size PNGs are never committed)" ;; esac
mkdir -p "$WR" "$OUT"
exec 9>"$WR/lock"
flock -n 9 || die "another we-ref-capture is running ($WR/lock)"

STEAM_RUN=$(command -v steam-run) || die "no steam-run on PATH (umu's pressure-vessel needs its FHS on NixOS)"
[[ -f $UMU ]] || die "no umu-run at $UMU"
[[ -f $PROTON/toolmanifest.vdf ]] || die "not a Proton build: $PROTON"
XDOTOOL=$(command -v xdotool || nix build --no-link --print-out-paths nixpkgs#xdotool 2>/dev/null | sed 's|$|/bin/xdotool|')
[[ -x ${XDOTOOL:-} ]] || XDOTOOL=

# ------------------------------------------------------------------ the WE install: a farm, never written through
WE=$WR/we
setup() {
    local src ver
    if [[ -f $WE_WIN/wallpaper64.exe ]]; then src=$WE_WIN; else src=$WE_LINUX; fi
    [[ -f $src/wallpaper64.exe ]] || die "no Wallpaper Engine install found ($WE_WIN, $WE_LINUX)"
    ver=$(jq -r .version "$src/version.json" 2>/dev/null)
    if [[ -f $WE/.source && $(cat "$WE/.source") == "$src|$ver" ]]; then return 0; fi
    if [[ -e $WE ]]; then
        command -v trash >/dev/null || die "$WE is stale and there's no trash(1) to move it away"
        trash "$WE" || die "can't trash the stale $WE"
    fi
    mkdir -p "$WE"
    log "building $WE from $src ($ver)"
    local e b
    for e in "$src"/*; do
        b=$(basename "$e")
        case $b in config.json | log.txt | config_backups | projects) continue ;; esac
        if [[ $src == "$WE_LINUX" ]]; then
            cp -a --reflink=auto "$e" "$WE/" # same btrfs: free, and WE may write logs into bin/
        elif [[ -d $e && $b != ui ]]; then
            cp -as "$e" "$WE/" # a tree of symlinks (the Windows drive is read-only)
        else
            ln -s "$e" "$WE/$b"
        fi
    done
    mkdir -p "$WE/projects"
    # our config.json starts from the Linux-side install's (written under Proton, user "steamuser")
    if [[ -f $WE_LINUX/config.json ]]; then cp "$WE_LINUX/config.json" "$WR/config.base.json"; else cp "$src/config.json" "$WR/config.base.json"; fi
    echo "$src|$ver" >"$WE/.source"
}

# Microsoft's shader compiler and the Windows fonts, from the owner's own Windows install (read-only), into this
# private prefix only — so WE compiles its HLSL with FXC as on Windows (Wine's builtin d3dcompiler is vkd3d-shader,
# which differs on loose HLSL) and text uses the real fonts and fallback chain. Nothing else is taken from Windows.
WIN_SYS=/mnt/Windows/Windows
D3DC=builtin
FONTS=proton
trust_setup() {
    local pfx=$WR/pfx/pfx/drive_c/windows s32 bak f b
    [[ -d $pfx/system32 ]] || return 0 # the prefix is made on the first launch; the next run sets it up
    s32=$pfx/system32
    bak=$WR/pfx-builtin-bak
    if ((USE_WIN_D3DC)) && [[ -f $WIN_SYS/System32/D3DCompiler_47.dll ]]; then
        if ! cmp -s "$WIN_SYS/System32/D3DCompiler_47.dll" "$s32/d3dcompiler_47.dll"; then
            mkdir -p "$bak"
            [[ -f $s32/d3dcompiler_47.dll ]] && mv -f "$s32/d3dcompiler_47.dll" "$bak/d3dcompiler_47.dll"
            cp "$WIN_SYS/System32/D3DCompiler_47.dll" "$s32/d3dcompiler_47.dll"
        fi
        D3DC=native-ms
    fi
    if ((USE_WIN_FONTS)) && [[ -d $WIN_SYS/Fonts ]]; then
        if [[ ! -f $pfx/Fonts/.from-windows ]]; then
            mkdir -p "$bak/Fonts"
            for f in "$WIN_SYS"/Fonts/*; do
                [[ -f $f ]] || continue
                b=$(basename "$f" | tr '[:upper:]' '[:lower:]')
                [[ -e $pfx/Fonts/$b && ! -L $pfx/Fonts/$b ]] && mv -f "$pfx/Fonts/$b" "$bak/Fonts/$b" # Proton's stand-in
                ln -sfn "$f" "$pfx/Fonts/$b"                                                          # a link: no 560 MB copy
            done
            : >"$pfx/Fonts/.from-windows"
        fi
        FONTS=windows
    fi
}

# ------------------------------------------------------------------ one WE session in a headless gamescope
GS_PID=
SESSION=
GS_ENV=
wait_for() { # timeout_ms cmd… — poll every 10 ms
    local t=$1 s
    shift
    s=$(date +%s%3N)
    until "$@"; do
        (($(date +%s%3N) - s > t)) && return 1
        sleep 0.01
    done
}
descendants() {
    local p=$1 c
    for c in $(cat /proc/"$p"/task/*/children 2>/dev/null); do
        echo "$c"
        descendants "$c"
    done
}
stop_session() {
    [[ -n $GS_PID ]] || return 0
    local pids p n=0
    pids=$(descendants "$GS_PID")
    # WE first (Wine ends a process on SIGTERM): umu then winds the prefix down and gamescope follows its child
    # out; TERM to gamescope alone left it hanging until the KILL
    for p in $pids; do [[ $(cat /proc/"$p"/comm 2>/dev/null) == wallpaper64.exe ]] && kill -TERM "$p" 2>/dev/null; done
    while ((n < 40)) && kill -0 "$GS_PID" 2>/dev/null; do
        sleep 0.2
        n=$((n + 1))
    done
    kill -TERM "$GS_PID" 2>/dev/null
    n=0
    while ((n < 50)); do
        local alive=0
        for p in $GS_PID $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
        ((alive)) || break
        sleep 0.2
        n=$((n + 1))
    done
    for p in $GS_PID $pids; do
        if kill -0 "$p" 2>/dev/null; then
            log "pid $p still up 10 s after TERM: KILL"
            kill -KILL "$p" 2>/dev/null
        fi
    done
    GS_PID=
}
trap 'stop_session' EXIT
trap 'exit 130' INT TERM

gs_env() { [[ -s $GS_ENV ]] && grep -q '^DISPLAY=' "$GS_ENV" && grep -q '^GAMESCOPE_WAYLAND_DISPLAY=' "$GS_ENV"; }
we_up() { pgrep -x -P "$(descendants "$GS_PID" | tr '\n' ',' | sed 's/,$//')" wallpaper64.exe >/dev/null 2>&1; }
genv() { sed -n "s/^$1=//p" "$GS_ENV"; }

# start_session W H <windows path of the wallpaper file>: gamescope (output = the window), WE opening the scene
start_session() {
    local w=$1 h=$2 wfile=$3
    SESSION=$WR/session
    mkdir -p "$SESSION"
    GS_ENV=$SESSION/gs.env
    : >"$GS_ENV"
    cat >"$SESSION/child.sh" <<EOF
#!/usr/bin/env bash
env | grep -E '^(DISPLAY|GAMESCOPE_WAYLAND_DISPLAY)=' >"$GS_ENV"
cd "$WE"
exec "$STEAM_RUN" "$UMU" "$WE/wallpaper64.exe" -control openWallpaper -file "$wfile" -playInWindow Ref -width $w -height $h -x 0 -y 0 -borderless
EOF
    chmod +x "$SESSION/child.sh"
    (
        export WINEPREFIX=$WR/pfx PROTONPATH=$PROTON UMU_RUNTIME_UPDATE=0
        export GAMEID=umu-liascape-we-ref # not 431960: Proton mustn't associate this run with Steam's WE
        export WINEDLLOVERRIDES="winepulse.drv=d;winealsa.drv=d" PULSE_SERVER=unix:/nonexistent
        if [[ $D3DC == native-ms ]]; then WINEDLLOVERRIDES+=";d3dcompiler_47=n"; else WINEDLLOVERRIDES+=";d3dcompiler_47=b"; fi
        if [[ -n ${WE_REF_DEBUG:-} ]]; then # a Proton log (+seh, +loaddll …) into the session dir
            export PROTON_LOG=1 PROTON_LOG_DIR=$SESSION
        else
            export PROTON_LOG=0 WINEDEBUG=-all DXVK_LOG_LEVEL=none
        fi
        unset WAYLAND_DISPLAY
        exec setsid gamescope --backend headless -W "$w" -H "$h" -w "$w" -h "$h" -r "$FPS" -- "$SESSION/child.sh"
    ) >"$SESSION/gamescope.log" 2>&1 &
    GS_PID=$!
    wait_for 20000 gs_env || { log "gamescope never started (see $SESSION/gamescope.log)"; return 1; }
}

shot() { # path — request a frame (the file lands ~150 ms later)
    GAMESCOPE_WAYLAND_DISPLAY=$(genv GAMESCOPE_WAYLAND_DISPLAY) gamescopectl screenshot "$1" >/dev/null 2>&1
}
wait_file() { wait_for 5000 test -s "$1" && sleep 0.05; }

pointer_at() { # x y (window px)
    [[ -n $XDOTOOL ]] || return 0
    DISPLAY=$(genv DISPLAY) "$XDOTOOL" mousemove "$1" "$2" >/dev/null 2>&1
}

# ------------------------------------------------------------------ one scene
capture_one() { # id run_dir
    local id=$1 rd=$2 dir=$WORKSHOP/$1 cw ch kind w h file wfile
    [[ -f $dir/project.json ]] || { log "$id: no project.json"; return 1; }
    read -r cw ch kind < <("${TOOL[@]}" canvas "$dir") || { log "$id: can't read the canvas"; return 1; }
    if ((DESKTOP)); then
        w=1920 h=1080
    else # the canvas's own aspect, fitted into 1920x1080: WE then shows exactly the canvas, as our worker renders it
        read -r w h < <(awk -v cw="$cw" -v ch="$ch" 'BEGIN{s=1920/cw; if (1080/ch<s) s=1080/ch; w=int(cw*s/2+0.5)*2; h=int(ch*s/2+0.5)*2; print w, h}')
    fi
    # WE writes compiled shaders into the item's shaders/blobs*/: it gets a farm of the item (symlinked files) so the
    # Workshop folder is never written. The Workshop's own blobs are left out — they were compiled by whatever WE
    # ran there (under Proton: Wine's d3dcompiler); WE compiles them afresh with the compiler set up below.
    local farm=$WR/ws/$id f
    if [[ ! -f $farm/project.json ]]; then
        mkdir -p "$farm/shaders"
        (cd "$dir" && find . -path './shaders/blobs*' -prune -o -type d -print) | while IFS= read -r f; do mkdir -p "$farm/$f"; done
        (cd "$dir" && find . -path './shaders/blobs*' -prune -o ! -type d -print) | while IFS= read -r f; do ln -s "$dir/${f#./}" "$farm/$f"; done
        [[ -f $farm/project.json ]] || { log "$id: can't build $farm"; return 1; }
    fi
    dir=$farm
    file=$(jq -r '.file // "scene.json"' "$dir/project.json")
    # open project.json: WE resolves its `file` (a first instance given scene.pkg looked for a loose scene.json)
    wfile="Z:${dir//\//\\}\\project.json"
    mkdir -p "$rd"
    WE_REF_FPS=$FPS WE_REF_SETTINGS="$(printf '%s\n' "${WE_SETTINGS[@]}")" "${TOOL[@]}" config "$WR/config.base.json" "$WE/config.json" "Z:$dir/$file" "${PROPS[@]}" || return 1

    local p0x= p0y= p1x= p1y= sx sy
    sx=$(awk -v a="$w" -v b="$cw" 'BEGIN{print a/b}')
    sy=$(awk -v a="$h" -v b="$ch" 'BEGIN{print a/b}')
    # no --pointer: the canvas centre, where the worker puts it (a corner would pull parallax off-centre).
    # A parked pointer is reached by a 4 px move in the first 0.3 s: WE takes no pointer position until it sees a
    # motion event after the scene loads (parallax scenes sat 15-140 px off without it; with it, 0.2 px).
    local pointer=${POINTER:-$((cw / 2)),$((ch / 2))} ptime=$PTIME
    IFS=',:' read -r p0x p0y p1x p1y <<<"$pointer"
    if [[ -z $p1x ]]; then
        p1x=$p0x p1y=$p0y p0x=$((p0x - 4)) p0y=$((p0y - 4))
        pointer="$p0x,$p0y:$p1x,$p1y"
        [[ -z $ptime ]] && ptime=0-0.3
    fi

    local t_launch t_up t0 tlast dumps0
    dumps0=$(find "$WE" -maxdepth 1 -name '*.mdmp' | wc -l) # WE's crash handler writes a minidump + a dialog
    # shaders WE had to compile itself (not in the Windows install's cache): real .dxs files in the farms
    local blobs0
    blobs0=$(find "$WE/assets" "$WR/ws/$id" -type f -name '*.dxs' 2>/dev/null | wc -l)
    t_launch=$(date +%s%3N)
    start_session "$w" "$h" "$wfile" || return 1
    [[ -n $p0x ]] && pointer_at "$(awk -v v="$p0x" -v s="$sx" 'BEGIN{print int(v*s)}')" "$(awk -v v="$p0y" -v s="$sy" 'BEGIN{print int(v*s)}')"
    # the first non-black frame: requests kept 2 deep (gamescope writes one PNG per ~140 ms, in order, each from
    # the next composited frame), each stamped at request. Black frames all encode to the same size, so a file
    # clearly bigger than the first black one has a picture (python only looks at the first, to know it's black).
    local i=0 k=0 f mx mean sd t_req=() ok=0 black=0 sz deadline=$(($(date +%s%3N) + 45000))
    local pd=$WR/probe # reused: files truncated, never deleted (gamescope overwrites them)
    mkdir -p "$pd"
    for f in "$pd"/*.png "$rd"/t*s.png; do [[ -f $f ]] && : >"$f"; done
    while (($(date +%s%3N) < deadline)) && kill -0 "$GS_PID" 2>/dev/null; do
        if ((i - k < 2)); then
            t_req[i]=$(date +%s%3N)
            shot "$pd/p$i.png"
            i=$((i + 1))
        fi
        while ((k < i)) && [[ -s $pd/p$k.png ]]; do
            sleep 0.02
            sz=$(stat -c %s "$pd/p$k.png")
            if ((black == 0)); then
                read -r mx mean sd < <("${TOOL[@]}" stat "$pd/p$k.png" 2>/dev/null || echo 0 0 0)
                ((mx > 8)) && { [[ ${sd%.*} -ge 3 ]] || ((${mean%.*} < 40 && mx > 24)); } && { ok=1; break 2; }
                black=$sz
            elif ((sz > black + black / 4 + 4096)); then
                # a picture, unless it is flat: Wine paints a new window's background (one colour) before WE's
                # first present, and a loading scene shows black after it — that flash isn't t = 0
                read -r mx mean sd < <("${TOOL[@]}" stat "$pd/p$k.png" 2>/dev/null || echo 0 0 0)
                # (a dark scene — a night sky, a 3D room — is flat too, but dark with some light in it)
                if [[ ${sd%.*} -ge 3 ]] || ((${mean%.*} < 40 && mx > 24)); then ok=1; break 2; fi
            fi
            k=$((k + 1))
        done
        ((i - k >= 2)) && (($(date +%s%3N) - t_req[k] > 3000)) && k=$((k + 1)) # a dropped request
        sleep 0.02
    done
    ((ok)) || { log "$id: no picture within 45 s"; stop_session; return 1; }
    i=$k
    t0=${t_req[i]}
    t_up=$((t0 - t_launch))

    # frames at t0 + T; the pointer walks its path in 33 ms steps meanwhile
    local last mover= pa pb
    last=$(tr ',' '\n' <<<"$TIMES" | sort -g | tail -1)
    pa=0 pb=$last
    [[ -n $ptime ]] && IFS=- read -r pa pb <<<"$ptime"
    if [[ -n $p0x && ($p0x != "$p1x" || $p0y != "$p1y") ]]; then
        (
            while :; do
                el=$(($(date +%s%3N) - t0))
                read -r x y < <(awk -v e="$el" -v A="$pa" -v B="$pb" -v a="$p0x" -v b="$p0y" -v c="$p1x" -v d="$p1y" -v sx="$sx" -v sy="$sy" \
                    'BEGIN{u=(e/1000-A)/(B-A); if(u<0)u=0; if(u>1)u=1; printf "%d %d\n", (a+(c-a)*u)*sx, (b+(d-b)*u)*sy}')
                pointer_at "$x" "$y"
                ((el > ${pb%.*} * 1000 + 1500)) && break
                sleep 0.016
            done
        ) &
        mover=$!
    fi
    local T tag at shots=() gpu_mib prev=
    for T in $(tr ',' '\n' <<<"$TIMES" | sort -g); do
        at=$(awk -v t0="$t0" -v T="$T" 'BEGIN{printf "%d", t0 + T*1000}')
        while (($(date +%s%3N) < at)); do sleep 0.01; done
        tag=$(awk -v T="$T" 'BEGIN{printf "%g", T}')
        # gamescope holds one pending screenshot: a request made before the last one was written replaces it.
        # So wait for the previous file (<= 0.5 s; late_ms records what that cost).
        [[ -n ${prev:-} ]] && wait_for 500 test -s "$prev"
        f=$rd/t${tag}s.png
        local tr
        tr=$(date +%s%3N)
        shot "$f"
        prev=$f
        shots+=("$(jq -n --arg t "$tag" --argjson late "$((tr - at))" '{t:($t|tonumber), late_ms:$late, t_actual:(($t|tonumber) + $late/1000 | . * 1000 | round / 1000)}')")
    done
    for T in $(tr ',' '\n' <<<"$TIMES"); do
        f=$rd/t$(awk -v T="$T" 'BEGIN{printf "%g", T}')s.png
        wait_file "$f" || log "$id: frame at ${T}s missing"
    done
    [[ -n $mover ]] && { kill "$mover" 2>/dev/null; wait "$mover" 2>/dev/null; }
    # cost: RSS and CPU time of everything under gamescope (gamescope, Xwayland, wine, WE) at the last frame
    local rss_mib cpu_s
    read -r rss_mib cpu_s < <(for p in $GS_PID $(descendants "$GS_PID"); do
        [[ -r /proc/$p/stat ]] || continue
        echo "$(awk '/^VmRSS/ {print $2}' /proc/"$p"/status 2>/dev/null || echo 0) $(awk '{print $14+$15}' /proc/"$p"/stat)"
    done | awk -v hz="$(getconf CLK_TCK)" '{r+=$1; c+=$2} END{printf "%d %.1f\n", r/1024, c/hz}')
    gpu_mib=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null |
        awk -F', *' -v ps=" $(descendants "$GS_PID" | tr '\n' ' ') $GS_PID " 'index(ps, " "$1" ") {s+=$2} END{print s+0}')
    tlast=$(($(date +%s%3N) - t_launch))
    local compiled
    compiled=$(($(find "$WE/assets" "$WR/ws/$id" -type f -name '*.dxs' 2>/dev/null | wc -l) - blobs0))
    local crashed=false
    (($(find "$WE" -maxdepth 1 -name '*.mdmp' | wc -l) > dumps0)) && crashed=true
    ((KEEP)) || stop_session
    jq -n --arg id "$id" --arg kind "$kind" --argjson canvas "[$cw,$ch]" --argjson window "[$w,$h]" \
        --arg we "$(cut -d'|' -f2 "$WE/.source")" --arg proton "$(cat "$PROTON/version" 2>/dev/null)" \
        --argjson props "$(printf '%s\n' "${PROPS[@]}" | jq -R -s 'split("\n") | map(select(length>0))')" \
        --arg tag "$TAG" --arg pointer "$pointer" --arg ptime "$ptime" --argjson fps "$FPS" --arg d3dc "$D3DC" --argjson compiled "$compiled" --arg fonts "$FONTS" --argjson crashed "$crashed" --argjson we_settings "$(printf '%s\n' "${WE_SETTINGS[@]}" | jq -R -s 'split("\n") | map(select(length>0))')" --argjson up_ms "$t_up" --argjson wall_ms "$tlast" --argjson gpu_mib "${gpu_mib:-0}" --argjson rss_mib "${rss_mib:-0}" --argjson cpu_s "${cpu_s:-0}" \
        --argjson shots "[$(IFS=,; echo "${shots[*]}")]" --arg when "$(date -Iseconds)" \
        '{id:$id, tag:$tag, desktop:('"$DESKTOP"' == 1), kind:$kind, canvas:$canvas, window:$window, we:$we, proton:$proton, props:$props, pointer:$pointer, pointer_time:$ptime, fps:$fps, d3dcompiler:$d3dc, shaders_compiled:$compiled, fonts:$fonts, clock:"Wine wall clock", we_settings:$we_settings,
          we_crashed:$crashed, first_frame_ms:$up_ms, wall_ms:$wall_ms, we_gpu_mib:$gpu_mib, rss_mib:$rss_mib, cpu_s:$cpu_s, shots:$shots, captured:$when,
          time_base:"seconds after the first non-black frame (one probe interval, ~0.15 s); shot t was requested late_ms after t (t_actual) and lands on the next composited frame"}' >"$rd/manifest.json"
    log "$id: first frame after $((t_up))ms, done in ${tlast}ms → $rd$([[ $crashed == true ]] && echo " — WE CRASHED (its dialog is in the frames)")"
}

publish() { # id run_dir — small JPEGs + manifest into the docs tree
    [[ $DOCS == - ]] && return 0
    local id=$1 rd=$2 d=$DOCS/$1${TAG:+/$TAG} f
    mkdir -p "$d"
    for f in "$rd"/t*s.png; do
        [[ -f $f ]] && "${TOOL[@]}" jpeg "$f" "$d/$(basename "${f%.png}").jpg" 960
    done
    cp "$rd/manifest.json" "$d/manifest.json"
}

# ------------------------------------------------------------------ main
case $MODE in
setup) setup; log "ready: $WE ($(cut -d'|' -f2 "$WE/.source"))"; exit 0 ;;
stop) exit 0 ;; # sessions never outlive their run unless --keep; the lock above proves none is running
esac
setup
trust_setup

if ((BATCH)); then
    forbidden() { case "$(realpath -m -- "$1")/" in */steamcmd_workshop/*) return 0 ;; esac; return 1; }
    forbidden "$WORKSHOP" && die "refusing a steamcmd_workshop cache"
    for d in "$WORKSHOP"/*/; do
        d=${d%/}
        id=$(basename "$d")
        [[ -f $d/project.json ]] || continue
        [[ $(jq -r '(.type // "") | ascii_downcase' "$d/project.json" 2>/dev/null) == scene ]] || continue
        [[ -n $ONLY && ",$ONLY," != *",$id,"* ]] && continue
        ((SKIP_DONE)) && [[ -f $DOCS/$id/manifest.json ]] && continue
        IDS+=("$id")
        ((LIMIT > 0 && ${#IDS[@]} >= LIMIT)) && break
    done
fi
((${#IDS[@]})) || usage 2

n=0 fails=0
for id in "${IDS[@]}"; do
    n=$((n + 1))
    [[ $id =~ ^[0-9]+$ ]] || { log "skipping $id: not a workshop id"; continue; }
    if ((REPEAT > 1)); then
        for r in $(seq 1 "$REPEAT"); do capture_one "$id" "$OUT/$id/r$r" || fails=$((fails + 1)); done
    else
        if [[ -n $TAG ]]; then rd=$OUT/$TAG/$id; else rd=$OUT/$id; fi
        if capture_one "$id" "$rd"; then publish "$id" "$rd"; else fails=$((fails + 1)); fi
    fi
    log "[$n/${#IDS[@]}] $id"
done
((fails)) && log "$fails capture(s) failed"
exit $((fails > 0))
