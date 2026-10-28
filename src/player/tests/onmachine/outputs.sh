#!/usr/bin/env bash
# On-machine check for liascape-player's Wayland backend (Task 13): one wlr-layer-shell surface
# per wl_output, the frame-timing probe, and hotplug through Hyprland. Task 16 adds: the
# mixed-content check (a video on one output, a static colour on the other → that one stays
# idle, also while the first animates), output props surviving a replug, and a crash →
# supervisor restart → restore on the real outputs.
#
#   bash src/player/tests/onmachine/outputs.sh        # exit 0 = pass
#
# What it touches, and how it puts it back (see .claude/rules/player-core.md § Wayland):
# - draws solid colours / a synthetic test clip on every monitor (briefly on the overlay
#   layer for the grim pixel check, otherwise on the background layer);
# - warps the cursor over the (overlay) surface to check pointer input, then puts it back
#   where it was (also from the trap);
# - disables DP-1 with `hyprctl eval hl.monitor{…disabled=true}` and re-enables it with the
#   EXACT recorded mode/position/scale (never `preferred,auto`); a trap restores the recorded
#   layout on any exit (failure, Ctrl-C) and verifies `hyprctl monitors -j` matches it;
# - stops the legacy wallpaper (mpvpaper) first and leaves it stopped;
# - runs its own `liascape-player serve` (supervised: SERVE_PID is the supervisor, PLAYER_PID the
#   compositor child that owns the surfaces) with a private XDG_RUNTIME_DIR (socket +
#   instance lock — other lanes' headless servers are unaffected) and RLIMIT_CORE 1 (the
#   deliberate SIGSEGV reaches no core dump handler / crash notification), and stops it on
#   exit, so no layer surface stays on screen.
#
# Env: LIASCAPE_PLAYER_BIN (default: build target/release/liascape-player via the flake devShell),
# OUT_A / OUT_B (default DP-1 / DP-2), HZ_A / HZ_B (144 / 240),
# MEAN_A / MEAN_B (6.9 / 4.2 ms), TOL_MS (0.5).
set -u -o pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CRATE=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$CRATE/../.." && pwd)
OUT_A=${OUT_A:-DP-1}
OUT_B=${OUT_B:-DP-2}
HZ_A=${HZ_A:-144}
HZ_B=${HZ_B:-240}
MEAN_A=${MEAN_A:-6.9}
MEAN_B=${MEAN_B:-4.2}
TOL_MS=${TOL_MS:-0.5}

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/liascape-outputs.XXXXXX")
RT=$SCRATCH/run
STATE=$SCRATCH/state
mkdir -m 700 "$RT" "$STATE"
REAL_RT=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
WL=${WAYLAND_DISPLAY:-wayland-1}
[[ $WL == /* ]] || WL=$REAL_RT/$WL
LAYOUT=$SCRATCH/layout.json
WS=$SCRATCH/workspaces.json
SERVE_PID=
PLAYER_PID=
FAILED=0
CURSOR=

say() { printf '[outputs] %s\n' "$*"; }
fail() {
    printf '[outputs] FAIL: %s\n' "$*"
    FAILED=1
    exit 1
}

NORM='[.[] | {name, width, height, refreshRate, x, y, scale, transform}] | sort_by(.name)'
WSNORM='{ws: ([.[] | {id, monitor}] | sort_by(.id))}'

# liascape-player with its private runtime dir; the real compositor through an absolute socket.
lp() {
    env -u LD_LIBRARY_PATH XDG_RUNTIME_DIR="$RT" XDG_STATE_HOME="$STATE" WAYLAND_DISPLAY="$WL" \
        "$BIN" "$@"
}
ctl() { lp ctl --timeout-ms 8000 "$@"; }

layout_now() { hyprctl monitors -j | jq -c "$NORM"; }

restore_layout() {
    [[ -s $LAYOUT ]] || return 0
    local want now
    want=$(jq -c "$NORM" "$LAYOUT")
    now=$(layout_now)
    if [[ $now != "$want" ]]; then
        say "restoring the recorded monitor layout"
        jq -c '.[]' "$LAYOUT" | while read -r m; do
            local name cur
            name=$(jq -r .name <<<"$m")
            cur=$(hyprctl monitors -j | jq -c --arg n "$name" \
                '[.[] | select(.name == $n) | {name, width, height, refreshRate, x, y, scale, transform}][0]')
            [[ $cur == "$(jq -c '{name, width, height, refreshRate, x, y, scale, transform}' <<<"$m")" ]] && continue
            local lua
            lua=$(jq -r '"hl.monitor({ output = \"\(.name)\", mode = \"\(.width)x\(.height)@\(.refreshRate)\", position = \"\(.x)x\(.y)\", scale = \(.scale)"
                + (if .transform != 0 then ", transform = \(.transform)" else "" end) + ", disabled = false })"' <<<"$m")
            say "  hyprctl eval '$lua'"
            hyprctl eval "$lua" >/dev/null
        done
        for _ in $(seq 1 50); do
            [[ $(layout_now) == "$want" ]] && break
            sleep 0.1
        done
    fi
    now=$(layout_now)
    if [[ $now == "$want" ]]; then
        say "layout verified identical to the record: $now"
    else
        say "LAYOUT MISMATCH after restore: want $want, have $now"
        FAILED=1
    fi
    # Workspace → monitor placement (Hyprland moves workspaces off a disabled monitor and
    # back on re-enable; fix any that didn't come back).
    if [[ -s $WS ]]; then
        jq -c '.ws[]' "$WS" | while read -r w; do
            local id mon now_mon
            id=$(jq -r .id <<<"$w")
            mon=$(jq -r .monitor <<<"$w")
            now_mon=$(hyprctl workspaces -j | jq -r --argjson i "$id" '.[] | select(.id == $i) | .monitor')
            if [[ -n $now_mon && $now_mon != "$mon" ]]; then
                say "  moving workspace $id back to $mon"
                hyprctl dispatch moveworkspacetomonitor "$id" "$mon" >/dev/null 2>&1 ||
                    hyprctl eval "hl.dispatch(hl.dsp.workspace.move({ workspace = \"$id\", monitor = \"$mon\" }))" >/dev/null 2>&1
            fi
        done
        say "workspaces now: $(hyprctl workspaces -j | jq -c "$WSNORM")"
    fi
}

stop_serve() {
    [[ -n $SERVE_PID ]] || return 0
    if kill -0 "$SERVE_PID" 2>/dev/null; then
        ctl quit >/dev/null 2>&1
        for _ in $(seq 1 50); do
            kill -0 "$SERVE_PID" 2>/dev/null || break
            sleep 0.1
        done
        kill -TERM "$SERVE_PID" 2>/dev/null && sleep 1
        kill -KILL "$SERVE_PID" 2>/dev/null
    fi
    wait "$SERVE_PID" 2>/dev/null
    SERVE_STATUS=$?
    SERVE_PID=
}

cursor_to() { hyprctl eval "hl.dispatch(hl.dsp.cursor.move({ x = $1, y = $2 }))" >/dev/null; }

restore_cursor() {
    [[ -n $CURSOR ]] || return 0
    # Focus follows the cursor across monitors: give focus back first (a monitor focus
    # may warp the cursor), then the cursor.
    local f
    f=$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')
    if [[ -n $FOCUS && $f != "$FOCUS" ]]; then
        hyprctl eval "hl.dispatch(hl.dsp.focus({ monitor = \"$FOCUS\" }))" >/dev/null
    fi
    cursor_to "$(jq -r .x <<<"$CURSOR")" "$(jq -r .y <<<"$CURSOR")"
    sleep 0.1
    say "cursor restored to $(hyprctl cursorpos), focused monitor $(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name') (was $FOCUS)"
    CURSOR=
}

cleanup() {
    local rc=$?
    restore_cursor
    stop_serve
    restore_layout
    # No liascape-player surface existed before we started (checked): none may be left.
    if hyprctl layers -j | jq -e '[.. | objects | select(.namespace? == "liascape-player")] | length > 0' >/dev/null; then
        say "WARNING: an liascape-player layer surface is still mapped"
        FAILED=1
    fi
    if [[ $FAILED != 0 || $rc != 0 ]]; then
        say "serve log tail ($SCRATCH/serve.log):"
        tail -n 15 "$SCRATCH/serve.log" 2>/dev/null | sed 's/^/    /'
        say "RESULT: FAIL (scratch kept in $SCRATCH)"
        exit 1
    fi
    say "RESULT: PASS"
    # Our own mktemp dir (test clips, logs) is kept only on failure.
    if command -v trash >/dev/null; then trash "$SCRATCH"; else say "scratch: $SCRATCH"; fi
    exit 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ------------------------------------------------------------------ preconditions
command -v hyprctl >/dev/null || fail "hyprctl not found (this check needs Hyprland)"
for t in jq grim python3 ffmpeg prlimit; do command -v "$t" >/dev/null || fail "$t not found"; done
hyprctl monitors -j >"$LAYOUT" || fail "hyprctl monitors failed (HYPRLAND_INSTANCE_SIGNATURE set?)"
hyprctl workspaces -j | jq -c "$WSNORM" >"$WS"
FOCUS=$(jq -r '.[] | select(.focused) | .name' "$LAYOUT")
say "recorded layout: $(jq -c "$NORM" "$LAYOUT")"
for o in "$OUT_A" "$OUT_B"; do
    jq -e --arg n "$o" 'any(.[]; .name == $n)' "$LAYOUT" >/dev/null || fail "monitor $o not present"
done

OTHER=$(hyprctl layers -j | jq -c '[.. | objects | select(.namespace? == "liascape-player") | .pid] | unique')
[[ $OTHER == "[]" ]] || fail "another liascape-player (pid $OTHER) already draws on this session; quit it first (ctl quit)"

if pgrep -x mpvpaper >/dev/null; then
    say "stopping the legacy wallpaper (mpvpaper)"
    curl -s -X POST 127.0.0.1:5174/stop >/dev/null
    for _ in $(seq 1 50); do pgrep -x mpvpaper >/dev/null || break; sleep 0.1; done
    pgrep -x mpvpaper >/dev/null && fail "mpvpaper still running after /stop"
fi

if [[ -z ${LIASCAPE_PLAYER_BIN:-} ]]; then
    say "building liascape-player (release)"
    (cd "$REPO" && env -u LD_LIBRARY_PATH nix develop -c cargo build -q --release \
        --manifest-path src/player/Cargo.toml) || fail "cargo build failed"
    BIN=$CRATE/target/release/liascape-player
else
    BIN=$LIASCAPE_PLAYER_BIN
fi
[[ -x $BIN ]] || fail "no liascape-player binary at $BIN"

# Test media: synthetic clips (content doesn't matter).
CLIP240=$SCRATCH/clip240.mp4
CLIP60=$SCRATCH/clip60.mp4
ffmpeg -v error -f lavfi -i testsrc2=size=640x360:rate=240 -t 12 -c:v libx264 -preset ultrafast \
    -pix_fmt yuv420p "$CLIP240" || fail "ffmpeg (240 fps clip)"
ffmpeg -v error -f lavfi -i testsrc2=size=640x360:rate=60 -t 12 -c:v libx264 -preset ultrafast \
    -pix_fmt yuv420p "$CLIP60" || fail "ffmpeg (60 fps clip)"

# ------------------------------------------------------------------ helpers
centre_rgb() { # <output> [fx fy] → "r g b" of the pixel at (fx·w, fy·h), default the centre
    grim -o "$1" -t ppm - | FX=${2:-0.5} FY=${3:-0.5} python3 -c '
import sys
d = sys.stdin.buffer.read()
parts, i = [], 0
while len(parts) < 4:
    while d[i:i+1].isspace(): i += 1
    if d[i:i+1] == b"#":
        while d[i:i+1] != b"\n": i += 1
        continue
    j = i
    while not d[j:j+1].isspace(): j += 1
    parts.append(d[i:j]); i = j
i += 1
import os
w, h = int(parts[1]), int(parts[2])
o = i + (int(h * float(os.environ["FY"])) * w + int(w * float(os.environ["FX"]))) * 3
print(d[o], d[o+1], d[o+2])'
}
near() { # <"r g b"> <r> <g> <b>
    read -r r g b <<<"$1"
    (( r >= $2 - 12 && r <= $2 + 12 && g >= $3 - 12 && g <= $3 + 12 && b >= $4 - 12 && b <= $4 + 12 ))
}
centre_is() { # <output> <r> <g> <b> → the centre pixel, else the one at (¼ w, ¾ h) — the
    # owner's shell can put a popup over the centre (a notification did, on the overlay
    # level) — retried for ~1.2 s; prints what it saw
    local px px2
    for _ in $(seq 1 6); do
        px=$(centre_rgb "$1")
        near "$px" "$2" "$3" "$4" && { echo "$px"; return 0; }
        px2=$(centre_rgb "$1" 0.25 0.75)
        near "$px2" "$2" "$3" "$4" && { echo "$px2 at (¼ w, ¾ h); centre $px is covered"; return 0; }
        sleep 0.2
    done
    echo "$px, $px2 at (¼ w, ¾ h) (overlay-level surfaces on $1: $(hyprctl layers -j | jq -c --arg o "$1" '[.[$o].levels."3"[]? | {namespace, x, y, w, h}]'))"
    return 1
}
layer_level() { # <output> → hyprctl level of OUR player's surface on it ("" if none)
    hyprctl layers -j | jq -r --arg o "$1" --argjson pid "${PLAYER_PID:-0}" \
        '.[$o].levels // {} | to_entries[] | select(any(.value[]; .namespace == "liascape-player" and .pid == $pid)) | .key' | head -n1
}
wait_level() { # <output> <level>
    for _ in $(seq 1 30); do [[ $(layer_level "$1") == "$2" ]] && return 0; sleep 0.1; done
    return 1
}
frames() { ctl probe '{"name":"frames"}'; }
reset_frames() { ctl probe '{"name":"frames","args":{"reset":true}}' >/dev/null; }
fstat() { # <json> <output> <jq path under the output>
    jq -r --arg o "$2" ".outputs[] | select(.name == \$o) | $3" <<<"$1"
}
check_mean() { # <label> <json> <output> <want_ms>
    local mean count p95 max missed
    mean=$(fstat "$2" "$3" .paced.mean_ms)
    count=$(fstat "$2" "$3" .paced.count)
    p50=$(fstat "$2" "$3" .paced.p50_ms)
    p95=$(fstat "$2" "$3" .paced.p95_ms)
    max=$(fstat "$2" "$3" .paced.max_ms)
    missed=$(fstat "$2" "$3" .paced.missed)
    say "$1 $3: mean $mean ms p50 $p50 p95 $p95 max $max count $count missed $missed (want $4 ± $TOL_MS)"
    python3 -c "import sys; m=float('$mean' if '$mean' != 'null' else 'nan'); sys.exit(0 if abs(m-$4) <= $TOL_MS and $count >= 50 else 1)" ||
        fail "$1 $3: mean present interval $mean ms (count $count), want $4 ± $TOL_MS"
}
create_color() { ctl create "{\"kind\":\"source\",\"props\":{\"kind\":\"color\",\"color\":$1}}" | jq -r .id; }
create_video() { ctl create "{\"kind\":\"source\",\"props\":{\"path\":\"$1\",\"loop\":true}}" | jq -r .id; }
show() { ctl set "{\"path\":\"lay:$1:main.content\",\"value\":\"$2\"}" >/dev/null || fail "set lay:$1:main.content"; }
wait_ready() { # <source id>
    for _ in $(seq 1 100); do
        [[ $(ctl get "{\"path\":\"$1.ready\"}" | jq -r .value) == true ]] && return 0
        sleep 0.05
    done
    fail "$1 never became ready"
}

# ------------------------------------------------------------------ 1. serve on Wayland
# Not through `lp` (a function call in the background would fork a subshell): `env` execs
# liascape-player, so $! is liascape-player's own pid — the supervisor, which the trap stops; the
# compositor child (PLAYER_PID, from hello) owns the surfaces hyprctl reports.
# The crash in section 7 is deliberate: RLIMIT_CORE 1 makes the kernel skip the core dump
# handler (systemd-coredump → the desktop's crash notification) — `prlimit` execs, so $!
# stays the supervisor's pid.
prlimit --core=1:1 env -u LD_LIBRARY_PATH XDG_RUNTIME_DIR="$RT" XDG_STATE_HOME="$STATE" \
    WAYLAND_DISPLAY="$WL" "$BIN" serve --ao null --log-level debug >"$SCRATCH/serve.log" 2>&1 &
SERVE_PID=$!
for _ in $(seq 1 100); do
    [[ -S $RT/livepaper/liascape-player.sock ]] && break
    kill -0 "$SERVE_PID" 2>/dev/null || fail "liascape-player serve exited early"
    sleep 0.1
done
[[ -S $RT/livepaper/liascape-player.sock ]] || fail "no liascape-player socket after 10 s"
HELLO=$(ctl hello) || fail "ctl hello: $HELLO"
[[ $(jq -r .backend <<<"$HELLO") == wayland ]] || fail "backend is $(jq -r .backend <<<"$HELLO"), want wayland"
PLAYER_PID=$(jq -r .pid <<<"$HELLO")
[[ $(jq -r .supervisor_pid <<<"$HELLO") == "$SERVE_PID" ]] ||
    fail "hello.supervisor_pid $(jq -r .supervisor_pid <<<"$HELLO") is not serve's pid $SERVE_PID"
say "supervised: supervisor $SERVE_PID, compositor $PLAYER_PID"

STATE_JSON=$(ctl state) || fail "ctl state"
for pair in "$OUT_A:$HZ_A" "$OUT_B:$HZ_B"; do
    o=${pair%%:*}
    hz=${pair##*:}
    got=$(jq -r --arg id "out:$o" '.graph[$id].refresh_hz' <<<"$STATE_JSON")
    [[ $got == "$hz" ]] || fail "out:$o refresh_hz = $got, want $hz"
    say "out:$o refresh_hz $got, $(jq -r --arg id "out:$o" '.graph[$id] | "\(.width)x\(.height)"' <<<"$STATE_JSON")"
    wait_level "$o" 0 || fail "no liascape-player layer surface on the background level of $o"
done
say "layer surfaces mapped on the background level (hyprctl layers)"

# ------------------------------------------------------------------ 2. colours + pixel check
RED=$(create_color '[255,0,0]')
BLUE=$(create_color '[0,0,255]')
show "$OUT_A" "$RED"
show "$OUT_B" "$BLUE"
ctl set '{"path":"out:*.layer","value":"overlay"}' >/dev/null || fail "set out:*.layer overlay"
for o in "$OUT_A" "$OUT_B"; do wait_level "$o" 3 || fail "$o did not move to the overlay level live"; done
sleep 0.3
PA=$(centre_is "$OUT_A" 255 0 0) || fail "$OUT_A centre is $PA, want red"
PB=$(centre_is "$OUT_B" 0 0 255) || fail "$OUT_B centre is $PB, want blue"
say "centre pixels: $OUT_A = $PA, $OUT_B = $PB"
# Pointer: the surface takes pointer input (input region = whole surface). Warp the cursor
# over it while it is on top, read out:<c>.pointer, put the cursor back.
CURSOR=$(hyprctl cursorpos -j | jq -c '{x, y}')
AX=$(jq -r --arg n "$OUT_A" '.[] | select(.name == $n) | .x' "$LAYOUT")
AY=$(jq -r --arg n "$OUT_A" '.[] | select(.name == $n) | .y' "$LAYOUT")
pointer_is() { # <x> <y> → wait until out:OUT_A.pointer == [x, y, 0]
    for _ in $(seq 1 30); do
        [[ $(ctl get "{\"path\":\"out:$OUT_A.pointer\"}" | jq -c '.value | map(round)') == "[$1,$2,0]" ]] && return 0
        sleep 0.05
    done
    return 1
}
BX=$(jq -r --arg n "$OUT_B" '.[] | select(.name == $n) | .x' "$LAYOUT")
BY=$(jq -r --arg n "$OUT_B" '.[] | select(.name == $n) | .y' "$LAYOUT")
cursor_to $((AX + 960)) $((AY + 540)) # enters our DP-1 surface
pointer_is 960 540 || fail "out:$OUT_A.pointer is $(ctl get "{\"path\":\"out:$OUT_A.pointer\"}" | jq -c .value), want [960,540,0] after enter"
# A warp inside the surface: Hyprland's simulated move sends wl_pointer.motion without a
# wl_pointer.frame (real devices always frame), so the motion is delivered with the next
# frame — the leave when the cursor goes to the other monitor.
cursor_to $((AX + 100)) $((AY + 200))
cursor_to $((BX + 960)) $((BY + 540))
pointer_is 100 200 || fail "out:$OUT_A.pointer is $(ctl get "{\"path\":\"out:$OUT_A.pointer\"}" | jq -c .value), want [100,200,0] (motion, then leave)"
PEV=$(ctl logs '{"kind_prefix":"input.pointer"}' | jq -c '[.events[] | select(.output == "'"$OUT_A"'") | .event] | unique')
say "pointer: out:$OUT_A.pointer [960,540,0] on enter → [100,200,0] after motion + leave; input.pointer events $PEV"
jq -e 'index("enter") != null and index("motion") != null and index("leave") != null' <<<"$PEV" >/dev/null ||
    fail "input.pointer events missing enter/motion/leave: $PEV"
restore_cursor

ctl set '{"path":"out:*.layer","value":"background"}' >/dev/null || fail "set out:*.layer background"
for o in "$OUT_A" "$OUT_B"; do wait_level "$o" 0 || fail "$o did not return to the background level"; done
say "layer change applied live: overlay → background"

# ------------------------------------------------------------------ 3. static colour = idle
sleep 0.5
F0=$(frames)
sleep 1
F1=$(frames)
for o in "$OUT_A" "$OUT_B"; do
    idle=$(fstat "$F1" "$o" .idle)
    d=$(( $(fstat "$F1" "$o" .totals.presents) - $(fstat "$F0" "$o" .totals.presents) ))
    say "static colour $o: idle $idle, presents in 1 s: $d"
    [[ $idle == true ]] || fail "$o is not idle on a static colour"
    (( d <= 1 )) || fail "$o presented $d frames in 1 s of a static colour"
done

# ------------------------------------------------------------------ 4. pacing: animation
ctl animate '{"path":"lay:*:main.opacity","from":1,"to":0.97,"duration_ms":6000}' >/dev/null ||
    fail "animate opacity"
sleep 0.5
reset_frames
sleep 2.5
FA=$(frames)
check_mean "animation" "$FA" "$OUT_A" "$MEAN_A"
check_mean "animation" "$FA" "$OUT_B" "$MEAN_B"
sleep 3.2 # let it finish
ctl set '{"path":"lay:*:main.opacity","value":1}' >/dev/null

# ------------------------------------------------------------------ 5. pacing: playing video
V240=$(create_video "$CLIP240")
wait_ready "$V240"
show "$OUT_A" "$V240"
show "$OUT_B" "$V240"
sleep 0.5
reset_frames
sleep 2.5
FV=$(frames)
check_mean "video 240 fps" "$FV" "$OUT_A" "$MEAN_A"
check_mean "video 240 fps" "$FV" "$OUT_B" "$MEAN_B"
V60=$(create_video "$CLIP60")
wait_ready "$V60"
show "$OUT_A" "$V60"
show "$OUT_B" "$V60"
ctl destroy "{\"id\":\"$V240\"}" >/dev/null
sleep 0.5
reset_frames
sleep 2.5
FV6=$(frames)
for o in "$OUT_A" "$OUT_B"; do
    fps=$(fstat "$FV6" "$o" .all.fps)
    say "video 60 fps $o: presents/s $fps, all-interval mean $(fstat "$FV6" "$o" .all.mean_ms) ms, idle $(fstat "$FV6" "$o" .idle)"
    python3 -c "import sys; sys.exit(0 if 50 <= float('$fps') <= 70 else 1)" ||
        fail "$o presented $fps frames/s of a 60 fps clip (content-paced: want ≈ 60)"
done

# ------------------------------------------------------------------ 5b. mixed content
# The 60 fps clip on OUT_A only, a static colour on OUT_B: OUT_B stays idle while OUT_A
# presents ≈ 60/s — and while an opacity animation runs on OUT_A's layer alone, OUT_A
# presents at its refresh and OUT_B still doesn't (the animation counts for OUT_A only).
show "$OUT_B" "$BLUE"
sleep 0.5
M0=$(frames)
sleep 1
M1=$(frames)
dA=$(( $(fstat "$M1" "$OUT_A" .totals.presents) - $(fstat "$M0" "$OUT_A" .totals.presents) ))
dB=$(( $(fstat "$M1" "$OUT_B" .totals.presents) - $(fstat "$M0" "$OUT_B" .totals.presents) ))
say "mixed content, 1 s: $OUT_A (60 fps clip) $dA presents, $OUT_B (static colour) $dB presents, idle $(fstat "$M1" "$OUT_B" .idle)"
(( dA >= 50 && dA <= 70 )) || fail "$OUT_A presented $dA frames in 1 s of a 60 fps clip"
(( dB <= 1 )) || fail "$OUT_B presented $dB frames in 1 s of a static colour next to a video"
[[ $(fstat "$M1" "$OUT_B" .idle) == true ]] || fail "$OUT_B is not idle next to a video"
ctl animate "{\"path\":\"lay:$OUT_A:main.opacity\",\"from\":1,\"to\":0.97,\"duration_ms\":4000}" >/dev/null ||
    fail "animate lay:$OUT_A:main.opacity"
sleep 0.3
reset_frames
N0=$(frames)
sleep 2
N1=$(frames)
dB=$(( $(fstat "$N1" "$OUT_B" .totals.presents) - $(fstat "$N0" "$OUT_B" .totals.presents) ))
check_mean "animation on $OUT_A only" "$N1" "$OUT_A" "$MEAN_A"
say "animation on $OUT_A only: $OUT_B presented $dB frames in 2 s (idle $(fstat "$N1" "$OUT_B" .idle))"
(( dB <= 1 )) || fail "$OUT_A's animation woke $OUT_B ($dB presents in 2 s)"
sleep 2
ctl set "{\"path\":\"lay:$OUT_A:main.opacity\",\"value\":1}" >/dev/null

# ------------------------------------------------------------------ 6. hotplug
show "$OUT_A" "$RED"
show "$OUT_B" "$BLUE"
ctl destroy "{\"id\":\"$V60\"}" >/dev/null
# Output props survive the replug: OUT_A goes to the bottom layer before it's unplugged.
ctl set "{\"path\":\"out:$OUT_A.layer\",\"value\":\"bottom\"}" >/dev/null || fail "set out:$OUT_A.layer bottom"
wait_level "$OUT_A" 1 || fail "$OUT_A did not move to the bottom level"
sleep 0.3
say "hotplug: disabling $OUT_A"
hyprctl eval "hl.monitor({ output = \"$OUT_A\", disabled = true })" >/dev/null
gone=0
for _ in $(seq 1 50); do
    if ! ctl state | jq -e --arg id "out:$OUT_A" '.graph | has($id)' >/dev/null; then gone=1; break; fi
    sleep 0.1
done
[[ $gone == 1 ]] || fail "out:$OUT_A still in the graph after disabling it"
kill -0 "$SERVE_PID" 2>/dev/null || fail "liascape-player died when $OUT_A went away"
H=$(ctl hello) || fail "player unresponsive after $OUT_A went away"
[[ $(jq -r .pid <<<"$H") == "$PLAYER_PID" ]] || fail "the compositor restarted when $OUT_A went away (pid $(jq -r .pid <<<"$H"))"
S2=$(ctl state)
say "after unplug: outputs $(jq -c '[.outputs[].name]' <<<"$S2"), sources $(jq -c .sources <<<"$S2")"
say "hotplug: re-enabling $OUT_A with its recorded mode"
LUA=$(jq -r --arg n "$OUT_A" '.[] | select(.name == $n) | "hl.monitor({ output = \"\(.name)\", mode = \"\(.width)x\(.height)@\(.refreshRate)\", position = \"\(.x)x\(.y)\", scale = \(.scale)"
    + (if .transform != 0 then ", transform = \(.transform)" else "" end) + ", disabled = false })"' "$LAYOUT")
say "  hyprctl eval '$LUA'"
hyprctl eval "$LUA" >/dev/null
back=0
for _ in $(seq 1 80); do
    if ctl state | jq -e --arg id "out:$OUT_A" '.graph | has($id)' >/dev/null; then back=1; break; fi
    sleep 0.1
done
[[ $back == 1 ]] || fail "out:$OUT_A did not come back"
S3=$(ctl state)
CONTENT=$(jq -r --arg l "lay:$OUT_A:main" '.graph[$l].content' <<<"$S3")
say "after replug: lay:$OUT_A:main.content = $CONTENT (cur:$OUT_B = $BLUE)"
[[ $CONTENT == "$BLUE" ]] || fail "re-added $OUT_A shows $CONTENT, want the current wallpaper $BLUE"
LAYER=$(jq -r --arg o "out:$OUT_A" '.graph[$o].layer' <<<"$S3")
[[ $LAYER == bottom ]] || fail "re-added out:$OUT_A.layer = $LAYER, want its remembered bottom"
wait_level "$OUT_A" 1 || fail "no layer surface on the bottom level of re-added $OUT_A"
say "replug kept out:$OUT_A.layer = bottom (hyprctl level 1)"
ctl set '{"path":"out:*.layer","value":"overlay"}' >/dev/null
for o in "$OUT_A" "$OUT_B"; do wait_level "$o" 3 || fail "$o not on overlay"; done
sleep 0.4
PA=$(centre_is "$OUT_A" 0 0 255) || fail "re-added $OUT_A centre is $PA, want blue (the current wallpaper)"
say "re-added $OUT_A centre pixel = $PA"
ctl set '{"path":"out:*.layer","value":"background"}' >/dev/null
for o in "$OUT_A" "$OUT_B"; do wait_level "$o" 0 || fail "$o not back on background"; done
NOW=$(layout_now)
[[ $NOW == "$(jq -c "$NORM" "$LAYOUT")" ]] || fail "layout after replug differs: $NOW"
say "layout after replug identical to the record"
jq -r 'select(.kind == "output.added" or .kind == "output.removed") | "  \(.kind) \(.output) content=\(.content // "-")"' \
    "$STATE"/livepaper/liascape-player/events.jsonl 2>/dev/null

# ------------------------------------------------------------------ 7. crash → restart → restore
# Both outputs show BLUE now. SIGSEGV the compositor: the supervisor restarts it with
# --restore; the new one draws BLUE on both outputs again (new pid, background level).
sleep 0.4 # the debounced snapshot (250 ms) has the last change
OLD=$PLAYER_PID
T0=$(date +%s%N)
kill -SEGV "$OLD"
NEWHELLO=
for _ in $(seq 1 300); do
    NEWHELLO=$(lp ctl --timeout-ms 200 hello 2>/dev/null) && [[ $(jq -r .pid <<<"$NEWHELLO") != "$OLD" ]] && break
    NEWHELLO=
    sleep 0.005
done
T1=$(date +%s%N)
[[ -n $NEWHELLO ]] || fail "no restarted player after SIGSEGV"
PLAYER_PID=$(jq -r .pid <<<"$NEWHELLO")
say "crash → restart: new compositor $PLAYER_PID answered hello $(( (T1 - T0) / 1000000 )) ms after SIGSEGV; restart $(jq -c .restart <<<"$NEWHELLO")"
(( (T1 - T0) / 1000000 <= 1500 )) || fail "restart took more than 1.5 s"
for o in "$OUT_A" "$OUT_B"; do wait_level "$o" 0 || fail "restarted player has no surface on the background level of $o"; done
S4=$(ctl state)
for o in "$OUT_A" "$OUT_B"; do
    c=$(jq -r --arg l "lay:$o:main" '.graph[$l].content' <<<"$S4")
    col=$(jq -c --arg c "$c" '.graph[$c].color | map(round)' <<<"$S4")
    [[ $col == "[0,0,255]" ]] || fail "restored $o shows $c (colour $col), want blue"
done
ctl set '{"path":"out:*.layer","value":"overlay"}' >/dev/null
for o in "$OUT_A" "$OUT_B"; do wait_level "$o" 3 || fail "$o not on overlay after the restart"; done
sleep 0.4
PA=$(centre_is "$OUT_A" 0 0 255) || fail "restored $OUT_A centre is $PA, want blue"
PB=$(centre_is "$OUT_B" 0 0 255) || fail "restored $OUT_B centre is $PB, want blue"
say "restored centre pixels: $OUT_A = $PA, $OUT_B = $PB"
ctl set '{"path":"out:*.layer","value":"background"}' >/dev/null
for o in "$OUT_A" "$OUT_B"; do wait_level "$o" 0 || fail "$o not back on background"; done
jq -r 'select(.kind | startswith("supervisor.") or startswith("snapshot.restored")) | "  \(.kind) \(del(.t_wall, .t_mono_ms, .comp, .level, .kind, .corr) | tostring)"' \
    "$STATE"/livepaper/liascape-player/events.jsonl 2>/dev/null

# ------------------------------------------------------------------ 8. quit
ctl quit >/dev/null || fail "ctl quit"
for _ in $(seq 1 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
kill -0 "$SERVE_PID" 2>/dev/null && fail "liascape-player still running 5 s after quit"
wait "$SERVE_PID"
st=$?
SERVE_PID=
[[ $st == 0 ]] || fail "liascape-player exited $st after quit"
say "quit: exit 0"
exit 0
