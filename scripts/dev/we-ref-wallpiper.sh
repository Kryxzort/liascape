#!/usr/bin/env bash
# we-ref-wallpiper.sh — a SECOND, independent source of real-Wallpaper-Engine reference frames: WE run by wallpiper
# (github.com/ejalxndr/wallpiper, MIT: Proton + a dwmapi.dll shim + an LD_PRELOAD + a Vulkan layer that hands WE's
# swapchain to a "portal" as dmabufs) inside a headless sway, frames taken with `wallpiperctl capture`.
# The first reference set is scripts/dev/we-ref-capture.sh (WE in its own window, -playInWindow, in a headless
# gamescope). This one runs WE the way it runs on a desktop: as the wallpaper of a monitor. Same scene times,
# same render settings, same manifest layout, so src/player/tests/onmachine/scene_we_compare.sh --refs <out> works.
# See docs/player/spikes/wallpiper-ref.md.
#
#   scripts/dev/we-ref-wallpiper.sh --setup                 # the WE farm, item copies dir, Proton wrapper (once)
#   scripts/dev/we-ref-wallpiper.sh 3184155462 3516174947   # frames at 0.5, 2, 5 s
#   scripts/dev/we-ref-wallpiper.sh 3463520581 --pointer 400,300:3400,1800
#
# Options (as we-ref-capture.sh where they overlap):
#   --times T,T…   scene times (s after WE's first non-flat frame; default 0.5,2,5)
#   --prop k=v     user property (repeatable), written into WE's config.json before WE starts
#   --pointer X,Y | X0,Y0:X1,Y1   native scene px (y down); default the canvas centre reached by a 4 px nudge
#   --pointer-time A-B            move the pointer between scene seconds A and B only
#   --fps N        WE's frame-rate limit (default 30)
#   --we-setting k=v   WE's own setting (config.json general.user)
#   --tag NAME     PNGs into <out>/NAME/<id>, JPEGs into <docs>/<id>/NAME
#   --root DIR     wallpiper's tree (default ~/.cache/liascape/we-ref-wallpiper): src/ (the built checkout), the
#                  fake Steam root steam/ (WE farm, compatdata/431960 = OUR prefix, item copies), proton/, tmp/ …
#   --out DIR      full-size PNGs (default <root>/captures; never the repo)
#   --docs DIR     960 px JPEGs + manifest per id (default <repo>/docs/player/reports/we-ref-wallpiper; "-" = none)
#   --proton DIR   Proton build (default Steam's "Proton - Experimental", as the first set)
#   --timeout S    first-picture limit per scene (default 60; the very first run also builds the prefix)
#   --keep-item-blobs  keep the shader blobs a Workshop item ships (shaders/blobs*). Default: left out, so WE
#                  compiles them with the Microsoft d3dcompiler_47 it ships, as the first set does since 7401e56
#   --wallpiper-fonts  upstream wallpiper's font handling: Proton's fonts, with arial/tahoma/times/cour redirected
#                  to the host's fontconfig sans/serif/mono. Default: the Windows fonts (read-only, from the owner's
#                  Windows drive) linked into OUR prefix, like the first set, and the redirect off
#
# Safety (the source review is in the spike doc):
#   - wallpiperd derives everything from WALLPIPER_STEAM_ROOT: we point it at <root>/steam, so its prefix
#     (steamapps/compatdata/431960), the config.json it writes and the dwmapi.dll it drops next to wallpaper64.exe
#     all land in our tree — never Steam's compatdata or a real WE install.
#   - upstream wallpiperd SIGTERMs EVERY process named wallpaper64.exe on the box when it stops (and won't start WE
#     while one exists). <root>/src carries scripts/dev/wallpiper-scope-pids.patch: only processes carrying its
#     own WALLPIPER_GUARDIAN_PID. The script refuses an unpatched build.
#   - tray off (WALLPIPER_TRAY_OPTS=notray) and a private D-Bus; sway's only output is HEADLESS-1; no audio
#     (Wine's pulse/alsa drivers disabled, PULSE_SERVER nowhere, private XDG_RUNTIME_DIR).
#   - the WE install is a farm of the Windows drive's 2.8.485: real directories, files under 2 MB copied, big ones
#     (dll/exe/pak/textures) symlinked. Workshop items are reflink copies (WE writes shader blobs into them).
set -u -o pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
TOOL=(python3 -I "$HERE/we_ref_tool.py")

ROOT=${XDG_CACHE_HOME:-$HOME/.cache}/liascape/we-ref-wallpiper
WORKSHOP=$HOME/.local/share/Steam/steamapps/workshop/content/431960
WE_WIN="/mnt/Windows/Program Files (x86)/Steam/steamapps/common/wallpaper_engine"
WE_LINUX=/@steam/SteamLibrary/steamapps/common/wallpaper_engine
PROTON="/@steam/SteamLibrary/steamapps/common/Proton - Experimental"
TIMES=0.5,2,5
PROPS=()
POINTER=
PTIME=
FPS=30
WE_SETTINGS=()
TAG=
OUT=
DOCS=$REPO/docs/player/reports/we-ref-wallpiper
TIMEOUT=60
ITEM_BLOBS=0
WP_FONTS=0
MODE=capture
IDS=()

die() {
    echo "we-ref-wp: $*" >&2
    exit 2
}
log() { echo "we-ref-wp: $*" >&2; }
usage() {
    sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1
    exit "${1:-0}"
}

while (($#)); do
    case $1 in
    --times) TIMES=$2; shift ;;
    --prop) PROPS+=("$2"); shift ;;
    --pointer) POINTER=$2; shift ;;
    --pointer-time) PTIME=$2; shift ;;
    --fps) FPS=$2; shift ;;
    --we-setting) WE_SETTINGS+=("$2"); shift ;;
    --tag) TAG=$2; shift ;;
    --root) ROOT=$2; shift ;;
    --out) OUT=$2; shift ;;
    --docs) DOCS=$2; shift ;;
    --proton) PROTON=$2; shift ;;
    --timeout) TIMEOUT=$2; shift ;;
    --keep-item-blobs) ITEM_BLOBS=1 ;;
    --wallpiper-fonts) WP_FONTS=1 ;;
    --setup) MODE=setup ;;
    -h | --help) usage 0 ;;
    -*) echo "unknown option $1" >&2; usage 2 ;;
    *) IDS+=("$1") ;;
    esac
    shift
done

ROOT=$(realpath -m -- "$ROOT")
OUT=${OUT:-$ROOT/captures}
case "$(realpath -m -- "$OUT")/" in "$REPO"/*) die "--out must be outside the repo" ;; esac
case "$(realpath -m -- "$WORKSHOP")/" in */steamcmd_workshop/*) die "refusing a steamcmd_workshop cache" ;; esac
BIN=$ROOT/src/build/release
FAKE=$ROOT/steam
WE=$FAKE/steamapps/common/wallpaper_engine
ITEMS=$FAKE/steamapps/workshop/content/431960
mkdir -p "$ROOT" "$OUT"
exec 9>"$ROOT/lock"
flock -n 9 || die "another we-ref-wallpiper is running ($ROOT/lock)"

# sway + Xwayland for the headless session, from nixpkgs when not installed
# (resolved once into <root>/tools.env: `nix build nixpkgs#…` re-resolves the registry's nixpkgs, which can hang)
nixbin() {
    local v
    v=$(command -v "$1" 2>/dev/null) && { echo "$v"; return; }
    v=$(sed -n "s|^$1=||p" "$ROOT/tools.env" 2>/dev/null)
    [[ -x $v ]] && { echo "$v"; return; }
    v=$(timeout 120 nix build --no-link --print-out-paths "nixpkgs#$2" 2>/dev/null | head -1 | sed "s|\$|/bin/$1|")
    [[ -x $v ]] && echo "$1=$v" >>"$ROOT/tools.env"
    echo "$v"
}
SWAY=$(nixbin sway sway)
XWAYLAND=$(nixbin Xwayland xwayland)
SWAYMSG=$(dirname "$SWAY")/swaymsg
[[ -x $SWAY && -x $XWAYLAND && -x $SWAYMSG ]] || die "no sway / Xwayland (nix build nixpkgs#sway nixpkgs#xwayland)"
command -v steam-run >/dev/null || die "no steam-run on PATH (Proton needs an FHS on NixOS)"

setup() {
    [[ -x $BIN/wallpiperd && -x $BIN/wallpiperctl && -x $BIN/wallpiper-portal-sway ]] ||
        die "no wallpiper build in $ROOT/src (clone, apply scripts/dev/wallpiper-scope-pids.patch, make build-core build-sway: see the spike doc)"
    grep -q 'spawned_by_us' "$ROOT/src/programs/wallpiperd/process.c" 2>/dev/null ||
        die "$ROOT/src lacks scripts/dev/wallpiper-scope-pids.patch: upstream wallpiperd kills every wallpaper64.exe on the box"
    [[ -f $PROTON/proton && -f $PROTON/toolmanifest.vdf ]] || die "not a Proton build: $PROTON"
    # wallpiperd execs "<WALLPIPER_PROTON_BIN> run <exe>" and finds Wine's builtin dwmapi.dll at <that dir>/files/…
    mkdir -p "$ROOT/proton"
    ln -sfn "$PROTON/files" "$ROOT/proton/files"
    # steam-run mounts a private tmpfs on /tmp, but wallpiper's Vulkan layer and preload talk to the portal over
    # hard-coded /tmp sockets (/tmp/wallpiper-capture.sock, /tmp/wallpiper-portal-sway-ctl.sock): a copy of
    # steam-run's bwrap script with the host /tmp bound instead (nothing else changed)
    local sr
    sr=$(readlink -f "$(command -v steam-run)")
    grep -qx '  --tmpfs /tmp' "$sr" || die "steam-run ($sr) changed: no '--tmpfs /tmp' line to replace"
    sed 's|^  --tmpfs /tmp$|  --bind /tmp /tmp|' "$sr" >"$ROOT/proton/steam-run-hosttmp"
    chmod +x "$ROOT/proton/steam-run-hosttmp"
    cat >"$ROOT/proton/proton" <<EOF
#!/usr/bin/env bash
# Valve's Proton script inside steam-run (NixOS needs an FHS), host /tmp visible. wallpiperd sets WINEDLLOVERRIDES=dwmapi=n,b; we add
# Wine's audio drivers off.
export WINEDLLOVERRIDES="\${WINEDLLOVERRIDES:+\$WINEDLLOVERRIDES;}winepulse.drv=d;winealsa.drv=d"
# Proton's "run" verb starts the exe through its steam.exe shim, and that loads \$HOME/.steam/sdk64/steamclient.so,
# the NATIVE Steam client library: upstream wallpiper so registers WE (SteamAppId 431960) with the owner's running
# Steam. We never load it: "runinprefix" runs wine directly (WE's renderer never loads steam_api). Our HOME has no
# .steam, so a first "run" (only to build the prefix) dies at steam.exe's assert, harmlessly.
export SteamAppId=0 SteamGameId=0 STEAM_COMPAT_APP_ID=0
if [[ \${1:-} == run ]]; then
    shift
    [[ -f \$STEAM_COMPAT_DATA_PATH/version ]] || "$ROOT/proton/steam-run-hosttmp" "$PROTON/proton" run wineboot.exe -u
    cd "\$(dirname "\$1")" || exit 1 # WE's own directory, as steam.exe would
    set -- runinprefix "\$@"
    # "run" would also have added the overrides its prefix setup computes: DXVK, vkd3d-proton, dxvk-nvapi native
    # (without them runinprefix gives WE Wine's wined3d)
    export WINEDLLOVERRIDES="\$WINEDLLOVERRIDES;d3d11=n;d3d10core=n;d3d9=n;dxgi=n;d3d12=n;d3d12core=n;nvapi64=n;nvofapi64=n;nvapi=n;nvcuda=b;steam.exe=b;winebth.sys=d;opencl=n,d"
fi
exec "$ROOT/proton/steam-run-hosttmp" "$PROTON/proton" "\$@"
EOF
    chmod +x "$ROOT/proton/proton"
    mkdir -p "$FAKE/steamapps/compatdata/431960" "$ITEMS" "$ROOT/tmp" "$ROOT/state" "$ROOT/home" "$ROOT/sessions"
    local src ver
    if [[ -f $WE_WIN/wallpaper64.exe ]]; then src=$WE_WIN; else src=$WE_LINUX; fi
    ver=$(jq -r .version "$src/version.json" 2>/dev/null)
    if [[ ! -f $WE/.source || $(cat "$WE/.source") != "$src|$ver" ]]; then
        [[ -e $WE ]] && { trash "$WE" || die "can't trash the stale $WE"; }
        mkdir -p "$WE"
        log "building $WE from $src ($ver)"
        local e b
        for e in "$src"/*; do
            b=$(basename "$e")
            case $b in config.json | log.txt | config_backups | projects) continue ;; esac
            if [[ $src == "$WE_LINUX" ]]; then
                cp -a --reflink=auto "$e" "$WE/"
            elif [[ -d $e && $b != ui ]]; then
                cp -as "$e" "$WE/"
            else
                ln -s "$e" "$WE/$b"
            fi
        done
        # files WE might rewrite in place (bin/playliststate.bin, shader blobs …) must not write through a symlink
        # into the Windows drive: everything under 2 MB becomes a real copy (~220 MB of 1.5 GB)
        find "$WE" -type l ! -path "$WE/ui" -print0 | while IFS= read -r -d '' l; do
            t=$(readlink "$l")
            [[ -f $t ]] && (($(stat -c %s "$t") < 2000000)) && cp --remove-destination "$t" "$l"
        done
        mkdir -p "$WE/projects"
        echo "$src|$ver" >"$WE/.source"
    fi
    [[ -f $ROOT/config.base.json ]] || cp "$WE_LINUX/config.json" "$ROOT/config.base.json" 2>/dev/null ||
        cp "$src/config.json" "$ROOT/config.base.json"
    # wallpiperd builds its font redirects from `fc-match`: a stub that fails turns them off
    mkdir -p "$ROOT/nofc"
    printf '#!/bin/sh\nexit 1\n' >"$ROOT/nofc/fc-match"
    chmod +x "$ROOT/nofc/fc-match"
    FONTS=proton
    local fdir=$FAKE/steamapps/compatdata/431960/pfx/drive_c/windows/Fonts f b
    if ((WP_FONTS)); then
        FONTS=proton+wallpiper-redirect
    elif [[ -d /mnt/Windows/Windows/Fonts && -d $fdir ]]; then
        if [[ ! -f $fdir/.from-windows ]]; then
            mkdir -p "$ROOT/pfx-fonts-bak"
            for f in /mnt/Windows/Windows/Fonts/*; do
                [[ -f $f ]] || continue
                b=$(basename "$f" | tr '[:upper:]' '[:lower:]')
                [[ -e $fdir/$b && ! -L $fdir/$b ]] && mv -f "$fdir/$b" "$ROOT/pfx-fonts-bak/$b" # Proton's stand-in
                ln -sfn "$f" "$fdir/$b"
            done
            : >"$fdir/.from-windows"
        fi
        FONTS=windows
    fi
}

descendants() {
    local p=$1 c
    for c in $(cat /proc/"$p"/task/*/children 2>/dev/null); do
        echo "$c"
        descendants "$c"
    done
}
wait_for() { # timeout_ms cmd…
    local t=$1 s
    shift
    s=$(date +%s%3N)
    until "$@"; do
        (($(date +%s%3N) - s > t)) && return 1
        sleep 0.05
    done
}

SESSION_PID=
S=
# everything this session started: sway's tree, plus the Wine processes, which leave it (wineserver and friends are
# reparented) but carry WALLPIPER_GUARDIAN_PID=<our wallpiperd>
session_pids() {
    local p wpd
    p=$(descendants "$SESSION_PID")
    echo "$p"
    wpd=$(for q in $p; do [[ $(cat /proc/"$q"/comm 2>/dev/null) == wallpiperd ]] && echo "$q"; done)
    [[ -n $wpd ]] || return 0
    for q in /proc/[0-9]*; do
        [[ -O $q ]] || continue
        { tr '\0' '\n' <"$q/environ"; } 2>/dev/null | grep -qx "WALLPIPER_GUARDIAN_PID=$wpd" && echo "${q#/proc/}"
    done
}
stop_session() {
    [[ -n $SESSION_PID ]] || return 0
    local pids p n alive wpd
    pids=$(session_pids | sort -un)
    # wallpiperd's own shutdown: TERM its renderers (only its own: the patch), then the portal; Wine processes it
    # started carry a guardian preload that ends them when wallpiperd is gone
    wpd=$(for p in $pids; do [[ $(cat /proc/"$p"/comm 2>/dev/null) == wallpiperd ]] && echo "$p"; done)
    [[ -n $wpd ]] && kill -TERM $wpd 2>/dev/null
    n=0
    while ((n < 60)); do
        alive=0
        for p in $pids; do
            [[ $(cat /proc/"$p"/comm 2>/dev/null) == *.exe || $p == "$wpd" ]] && kill -0 "$p" 2>/dev/null && alive=1
        done
        ((alive)) || break
        sleep 0.2
        n=$((n + 1))
    done
    [[ -f $S/env ]] && env $(cat "$S/env") "$SWAYMSG" exit >/dev/null 2>&1
    n=0
    while ((n < 50)); do
        alive=0
        for p in $SESSION_PID $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
        ((alive)) || break
        sleep 0.2
        n=$((n + 1))
    done
    for p in $SESSION_PID $pids; do
        if kill -0 "$p" 2>/dev/null; then
            kill -TERM "$p" 2>/dev/null
        fi
    done
    sleep 1
    for p in $SESSION_PID $pids; do
        if kill -0 "$p" 2>/dev/null; then
            log "pid $p ($(cat /proc/"$p"/comm 2>/dev/null)) still up after TERM: KILL"
            kill -KILL "$p" 2>/dev/null
        fi
    done
    SESSION_PID=
}
trap 'stop_session' EXIT
trap 'exit 130' INT TERM

start_session() { # W H
    local w=$1 h=$2
    S=$ROOT/sessions/current
    [[ -e $S ]] && trash "$S"
    mkdir -p "$S/xdg"
    chmod 700 "$S/xdg"
    cat >"$S/sway.cfg" <<EOF
output * mode --custom ${w}x${h}@${FPS}Hz position 0 0
output * bg #000000 solid_color
xwayland force
default_border none
focus_follows_mouse no
seat seat0 hide_cursor 100
exec $S/inner.sh
EOF
    cat >"$S/inner.sh" <<EOF
#!/usr/bin/env bash
env | grep -E '^(WAYLAND_DISPLAY|DISPLAY|SWAYSOCK|XDG_RUNTIME_DIR)=' >"$S/env"
export WALLPIPER_PORTAL=sway WALLPIPER_STEAM_ROOT="$FAKE" WALLPIPER_PROTON_BIN="$ROOT/proton/proton"
export WALLPIPER_TEMP_DIR="$ROOT/tmp" WALLPIPER_RUNTIME_DIR="$ROOT/state" WALLPIPER_TRAY_OPTS=notray
export HOME="$ROOT/home"
((WP_FONTS)) || export PATH="$ROOT/nofc:\$PATH"
if [[ -n "\${WE_REF_DEBUG:-}" ]]; then export PROTON_LOG=1 PROTON_LOG_DIR="$S"; else export PROTON_LOG=0 WINEDEBUG=-all DXVK_LOG_LEVEL=none; fi
exec "$BIN/wallpiperd" >"$S/wallpiperd.log" 2>&1
EOF
    chmod +x "$S/inner.sh"
    (
        export XDG_RUNTIME_DIR=$S/xdg PATH=$(dirname "$SWAY"):$(dirname "$XWAYLAND"):$PATH
        unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE HYPRLAND_CMD SWAYSOCK I3SOCK DBUS_SESSION_BUS_ADDRESS \
            PIPEWIRE_REMOTE XDG_SESSION_ID XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP NIRI_SOCKET
        export PULSE_SERVER=unix:/nonexistent WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1
        exec setsid dbus-run-session -- "$SWAY" -c "$S/sway.cfg"
    ) >"$S/sway.log" 2>&1 &
    SESSION_PID=$!
    wait_for 15000 test -S "$ROOT/tmp/wallpiperd-ctl.sock" -a -s "$S/env" || { log "sway/wallpiperd never came up ($S)"; return 1; }
}

cursor() { # x y (screen px) → wallpiper's cursor file (two int32), read by its GetCursorPos hook every 16 ms
    python3 -I -c 'import struct,sys; open(sys.argv[1],"r+b" if __import__("os").path.exists(sys.argv[1]) else "wb").write(struct.pack("<ii",int(float(sys.argv[2])),int(float(sys.argv[3]))))' \
        "$ROOT/tmp/wallpiper-cursor" "$1" "$2"
}
# the portal writes a PNG of the frame it holds (WE's swapchain image, imported as a dmabuf). Upstream writes it
# bottom-up (egl_capture.c: glReadPixels rows, no flip; the layer surface itself is upright): flip() fixes that
grab() { WALLPIPER_TEMP_DIR=$ROOT/tmp "$BIN/wallpiperctl" capture 0 "$1" >/dev/null 2>&1; }
flip() { python3 -I -c 'import sys; from PIL import Image; [Image.open(f).transpose(Image.FLIP_TOP_BOTTOM).save(f) for f in sys.argv[1:]]' "$@"; }
capture_one() { # id run_dir
    local id=$1 rd=$2 src=$WORKSHOP/$1 cw ch kind w h file wfile item
    [[ -f $src/project.json ]] || { log "$id: no project.json"; return 1; }
    read -r cw ch kind < <("${TOOL[@]}" canvas "$src") || { log "$id: can't read the canvas"; return 1; }
    read -r w h < <(awk -v cw="$cw" -v ch="$ch" 'BEGIN{s=1920/cw; if (1080/ch<s) s=1080/ch; w=int(cw*s/2+0.5)*2; h=int(ch*s/2+0.5)*2; print w, h}')
    item=$ITEMS/$id
    if [[ ! -f $item/.copied-blobs$ITEM_BLOBS ]]; then
        [[ -e $item ]] && { trash "$item" || { log "$id: can't trash the old $item"; return 1; }; }
        mkdir -p "$item"
        # a reflink copy (same btrfs: free; WE writes shader blobs into it, never into the Workshop folder)
        (cd "$src" && find . -mindepth 1 \( -path './shaders/blobs*' -a ! -path . \) -prune -o -print0) |
            while IFS= read -r -d '' f; do
                if [[ -d $src/$f ]]; then mkdir -p "$item/$f"
                elif ((ITEM_BLOBS)) || [[ $f != ./shaders/blobs* ]]; then cp -a --reflink=auto "$src/$f" "$item/$f"; fi
            done
        if ((ITEM_BLOBS)) && [[ -d $src/shaders ]]; then cp -a --reflink=auto "$src/shaders/." "$item/shaders/"; fi
        : >"$item/.copied-blobs$ITEM_BLOBS"
    fi
    file=$(jq -r '.file // "scene.json"' "$item/project.json")
    [[ -f $item/scene.pkg && ! -f $item/$file ]] && file=scene.pkg # WE's UI selects <dir>/scene.pkg for packed scenes
    wfile="Z:$item/$file"
    mkdir -p "$rd"
    for f in "$rd"/t*s.png "$rd"/probe*.png; do [[ -f $f ]] && trash "$f"; done
    WE_REF_FPS=$FPS WE_REF_SETTINGS="$(printf '%s\n' "${WE_SETTINGS[@]}")" "${TOOL[@]}" config "$ROOT/config.base.json" "$WE/config.json.tmp" "$wfile" "${PROPS[@]}" || return 1
    # the desktop path: the wallpaper selected for Monitor0 (as WE's UI stores it); wallpiper's own defaults
    jq --arg f "$wfile" '.steamuser.general.wallpaperconfig.selectedwallpapers = {Monitor0: {file: $f}}
        | .steamuser.general.user.uihardwareacceleration = false | .steamuser.general.user.adjustdwmcolormode = "disabled"' \
        "$WE/config.json.tmp" >"$WE/config.json" && trash "$WE/config.json.tmp"

    local sx sy p0x p0y p1x p1y pointer=${POINTER:-} ptime=$PTIME
    sx=$(awk -v a="$w" -v b="$cw" 'BEGIN{print a/b}')
    sy=$(awk -v a="$h" -v b="$ch" 'BEGIN{print a/b}')
    pointer=${pointer:-$((cw / 2)),$((ch / 2))}
    IFS=',:' read -r p0x p0y p1x p1y <<<"$pointer"
    if [[ -z $p1x ]]; then
        p1x=$p0x p1y=$p0y p0x=$((p0x - 4)) p0y=$((p0y - 4))
        pointer="$p0x,$p0y:$p1x,$p1y"
        [[ -z $ptime ]] && ptime=0-0.3
    fi
    cursor "$(awk -v v="$p0x" -v s="$sx" 'BEGIN{print v*s}')" "$(awk -v v="$p0y" -v s="$sy" 'BEGIN{print v*s}')"

    local t_launch dumps0 t0= t_up ok=0 i=0 tr
    dumps0=$(find "$WE" -maxdepth 1 -name '*.mdmp' | wc -l)
    t_launch=$(date +%s%3N)
    start_session "$w" "$h" || { stop_session; return 1; }
    local deadline=$((t_launch + TIMEOUT * 1000)) mx sd
    # t = 0: the first captured frame with a picture (not flat: Wine paints a window background first)
    while (($(date +%s%3N) < deadline)); do
        tr=$(date +%s%3N)
        if grab "$rd/probe.png"; then
            read -r mx _ sd < <("${TOOL[@]}" stat "$rd/probe.png" 2>/dev/null || echo 0 0 0)
            if ((mx > 8)) && [[ ${sd%.*} -ge 3 ]]; then ok=1; t0=$tr; break; fi
        fi
        i=$((i + 1))
        sleep 0.1
    done
    [[ -f $rd/probe.png ]] && trash "$rd/probe.png"
    local crashed=false
    (($(find "$WE" -maxdepth 1 -name '*.mdmp' | wc -l) > dumps0)) && crashed=true
    if ((!ok)); then
        log "$id: no picture within ${TIMEOUT} s$([[ $crashed == true ]] && echo " — WE CRASHED")"
        stop_session
        jq -n --arg id "$id" --argjson crashed "$crashed" --argjson canvas "[$cw,$ch]" --argjson window "[$w,$h]" \
            --arg when "$(date -Iseconds)" '{id:$id, source:"wallpiper", we_crashed:$crashed, no_picture:true, canvas:$canvas, window:$window, captured:$when}' >"$rd/manifest.json"
        return 1
    fi
    t_up=$((t0 - t_launch))

    local last mover= pa pb
    last=$(tr ',' '\n' <<<"$TIMES" | sort -g | tail -1)
    pa=0 pb=$last
    [[ -n $ptime ]] && IFS=- read -r pa pb <<<"$ptime"
    if [[ $p0x != "$p1x" || $p0y != "$p1y" ]]; then
        (
            while :; do
                el=$(($(date +%s%3N) - t0))
                read -r x y < <(awk -v e="$el" -v A="$pa" -v B="$pb" -v a="$p0x" -v b="$p0y" -v c="$p1x" -v d="$p1y" -v sx="$sx" -v sy="$sy" \
                    'BEGIN{u=(e/1000-A)/(B-A); if(u<0)u=0; if(u>1)u=1; printf "%d %d\n", (a+(c-a)*u)*sx, (b+(d-b)*u)*sy}')
                cursor "$x" "$y"
                ((el > ${pb%.*} * 1000 + 1500)) && break
                sleep 0.016
            done
        ) &
        mover=$!
    fi
    local T tag at shots=() f t_req t_done
    for T in $(tr ',' '\n' <<<"$TIMES" | sort -g); do
        at=$(awk -v t0="$t0" -v T="$T" 'BEGIN{printf "%d", t0 + T*1000}')
        while (($(date +%s%3N) < at)); do sleep 0.01; done
        tag=$(awk -v T="$T" 'BEGIN{printf "%g", T}')
        f=$rd/t${tag}s.png
        t_req=$(date +%s%3N)
        grab "$f" || log "$id: frame at ${T}s failed"
        t_done=$(date +%s%3N)
        shots+=("$(jq -n --arg t "$tag" --argjson late "$((t_req - at))" --argjson cap "$((t_done - t_req))" '{t:($t|tonumber), late_ms:$late, capture_ms:$cap, t_actual:(($t|tonumber) + $late/1000 | . * 1000 | round / 1000)}')")
    done
    [[ -n $mover ]] && { kill "$mover" 2>/dev/null; wait "$mover" 2>/dev/null; }
    local rss_mib cpu_s gpu_mib pids
    pids="$SESSION_PID $(session_pids | sort -un | tr '\n' ' ')"
    read -r rss_mib cpu_s < <(for p in $pids; do
        [[ -r /proc/$p/stat ]] || continue
        echo "$(awk '/^VmRSS/ {print $2}' /proc/"$p"/status 2>/dev/null || echo 0) $(awk '{print $14+$15}' /proc/"$p"/stat)"
    done | awk -v hz="$(getconf CLK_TCK)" '{r+=$1; c+=$2} END{printf "%d %.1f\n", r/1024, c/hz}')
    gpu_mib=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null |
        awk -F', *' -v ps=" $pids " 'index(ps, " "$1" ") {s+=$2} END{print s+0}')
    (($(find "$WE" -maxdepth 1 -name '*.mdmp' | wc -l) > dumps0)) && crashed=true
    local tlast=$(($(date +%s%3N) - t_launch))
    stop_session
    local pngs=()
    for f in "$rd"/t*s.png; do [[ -s $f ]] && pngs+=("$f"); done
    ((${#pngs[@]})) && flip "${pngs[@]}"
    jq -n --arg id "$id" --arg kind "$kind" --argjson canvas "[$cw,$ch]" --argjson window "[$w,$h]" \
        --arg we "$(cut -d'|' -f2 "$WE/.source")" --arg proton "$(cat "$PROTON/version" 2>/dev/null)" \
        --arg wallpiper "$(git -C "$ROOT/src" rev-parse --short HEAD 2>/dev/null)+scope-pids" \
        --argjson props "$(printf '%s\n' "${PROPS[@]}" | jq -R -s 'split("\n") | map(select(length>0))')" \
        --arg tag "$TAG" --arg pointer "$pointer" --arg ptime "$ptime" --argjson fps "$FPS" --argjson crashed "$crashed" \
        --argjson we_settings "$(printf '%s\n' "${WE_SETTINGS[@]}" | jq -R -s 'split("\n") | map(select(length>0))')" \
        --arg fonts "$FONTS" --argjson item_blobs "$ITEM_BLOBS" --argjson up_ms "$t_up" --argjson wall_ms "$tlast" --argjson gpu_mib "${gpu_mib:-0}" --argjson rss_mib "${rss_mib:-0}" --argjson cpu_s "${cpu_s:-0}" \
        --argjson shots "[$(IFS=,; echo "${shots[*]}")]" --arg when "$(date -Iseconds)" \
        '{id:$id, source:"wallpiper", wallpiper:$wallpiper, tag:$tag, desktop:false, kind:$kind, canvas:$canvas, window:$window, we:$we, proton:$proton, props:$props,
          pointer:$pointer, pointer_time:$ptime, fps:$fps, we_settings:$we_settings,
          d3dcompiler:"WE'"'"'s own bin\\d3dcompiler_47.dll (Microsoft)", fonts:$fonts, item_blobs:($item_blobs == 1), clock:"Wine wall clock", we_crashed:$crashed, first_frame_ms:$up_ms, wall_ms:$wall_ms,
          we_gpu_mib:$gpu_mib, rss_mib:$rss_mib, cpu_s:$cpu_s, shots:$shots, captured:$when,
          time_base:"seconds after the first non-flat captured frame (probe every ~0.2 s); shot t was requested late_ms after t (t_actual); wallpiperctl capture reads the frame the portal holds at the request"}' >"$rd/manifest.json"
    log "$id: first frame after ${t_up}ms, done in ${tlast}ms → $rd$([[ $crashed == true ]] && echo " — WE CRASHED")"
}

publish() { # id run_dir
    [[ $DOCS == - ]] && return 0
    local id=$1 rd=$2 d=$DOCS/$1${TAG:+/$TAG} f
    mkdir -p "$d"
    for f in "$rd"/t*s.png; do
        [[ -f $f ]] && "${TOOL[@]}" jpeg "$f" "$d/$(basename "${f%.png}").jpg" 960
    done
    cp "$rd/manifest.json" "$d/manifest.json"
}

setup
[[ $MODE == setup ]] && { log "ready: $ROOT ($(cut -d'|' -f2 "$WE/.source"))"; exit 0; }
((${#IDS[@]})) || usage 2
n=0 fails=0
for id in "${IDS[@]}"; do
    n=$((n + 1))
    [[ $id =~ ^[0-9]+$ ]] || { log "skipping $id: not a workshop id"; continue; }
    if [[ -n $TAG ]]; then rd=$OUT/$TAG/$id; else rd=$OUT/$id; fi
    if capture_one "$id" "$rd"; then publish "$id" "$rd"; else
        fails=$((fails + 1))
        [[ -f $rd/manifest.json && $DOCS != - ]] && { mkdir -p "$DOCS/$id${TAG:+/$TAG}"; cp "$rd/manifest.json" "$DOCS/$id${TAG:+/$TAG}/"; }
    fi
    log "[$n/${#IDS[@]}] $id"
done
((fails)) && log "$fails capture(s) failed"
exit $((fails > 0))
