#!/usr/bin/env bash
# Task 14 on-machine check: the player audio bus + bus meter, with REAL audio on the owner's
# PipeWire session (R56). Exit 0 = pass. Spec §5.3; .claude/rules/player-core.md § Audio bus.
#
#   1. `serve` creates the bus: `pactl list sinks short` has exactly one lp-player-bus; the
#      identity contract (pw-dump + `pactl list sink-inputs`); `pw-link -l` shows the bus
#      playback linked to the default sink; Bus::latency() <= 1 quantum + 5 ms.
#   2. A Solid clip (440 Hz, -20 dBFS peak) plays through the bus: `meter.window
#      {last_ms:1000}` median within -23 +- 3 dBFS; its mpv runs
#      audio-device=pipewire/lp-player-bus and audio-delay = -latency.
#   3. default_sink_change_retargets: `pactl set-default-sink <other>` -> the bus playback is
#      linked to <other> within 1 s, `audio.bus.retargeting` -> `audio.bus.up` are logged, the
#      meter's own timestamps show no gap > 50 ms across the switch; then back to the original.
#   4. System state (R57): the default sink is restored exactly (trap ... EXIT, also on failure
#      or interrupt) and no lp-player-bus sink is left (the bus belongs to serve; serve is
#      stopped on exit). Every per-stream routing entry (default metadata `target.node` /
#      `target.object` on any node serve owned — the bus re-targets set them) is cleared, also
#      on failure. WirePlumber saved no stream target for lp-player from our re-targets (the
#      bus streams carry state.restore-target=false — a saved target would pin every later
#      lp-player/mpv stream to that sink); if one ever appears, the trap clears it too.
#
# Isolation (R55): its own temp XDG_RUNTIME_DIR (the lp-player socket) + XDG_STATE_HOME;
# PipeWire/Pulse still reach the owner's real session via PIPEWIRE_RUNTIME_DIR / PULSE_SERVER;
# --headless with WAYLAND_DISPLAY unset. LP_PLAYER_BIN=<path> skips the build.
set -uo pipefail
unset LD_LIBRARY_PATH WAYLAND_DISPLAY

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
WP_STATE=${XDG_STATE_HOME:-$HOME/.local/state}/wireplumber/stream-properties
UID_=$(id -u)
export PIPEWIRE_RUNTIME_DIR=/run/user/$UID_
export PULSE_SERVER=unix:/run/user/$UID_/pulse/native

fail() {
    echo "FAIL: $*" >&2
    exit 1
}
ok() { echo "ok: $*"; }
now_ms() { date +%s%3N; }
sink_count() { pactl list sinks short | awk '$2=="lp-player-bus"' | wc -l; }

# The bus playback's FL and FR output ports both linked to sink $1 (`pw-link -l`).
linked_to() {
    pw-link -l | awk -v sink="$1" '
        /^[^ ]/ { port = $0 }
        /^  \|-> / {
            if (port ~ /^lp-player-bus\.playback:output_F[LR]$/) {
                split($2, a, ":"); if (a[1] == sink) n[port] = 1
            }
        }
        END { exit !(("lp-player-bus.playback:output_FL" in n) && ("lp-player-bus.playback:output_FR" in n)) }'
}

# ---------------------------------------------------------------- mute the test tones
# Controller instruction (same rationale as dropout.sh): mutes ONLY the bus's own
# forwarding stream (`node.name == lp-player-bus.playback`) — never the mpv streams
# feeding the bus — so the meter (which reads the bus sink's own monitor, upstream of
# this forwarding stream) measures exactly what it would unmuted. LP_TEST_AUDIBLE=1
# skips this.
bus_playback_index() {
    pactl -f json list sink-inputs 2>/dev/null \
        | jq -r '.[] | select(.properties["node.name"] == "lp-player-bus.playback") | .index' \
        | head -1
}
MUTE_LOOP_PID=
MUTE_STATE_FILE=
start_mute_watcher() {
    [[ -n ${LP_TEST_AUDIBLE:-} ]] && return
    MUTE_STATE_FILE=$TMP/mute_state
    (
        recorded=0
        while true; do
            idx=$(bus_playback_index)
            if [[ -n $idx ]]; then
                if [[ $recorded == 0 ]]; then
                    # A controller-side watcher may already be muting every
                    # lp-player-bus.playback stream — record whether *we* are the one
                    # flipping it so cleanup only unmutes what we muted.
                    was_muted=$(pactl -f json list sink-inputs 2>/dev/null \
                        | jq -r --argjson i "$idx" '.[] | select(.index==$i) | .mute')
                    [[ $was_muted == false ]] && echo muted_by_us > "$MUTE_STATE_FILE"
                    recorded=1
                fi
                pactl set-sink-input-mute "$idx" 1 2>/dev/null
            fi
            sleep 0.2
        done
    ) &
    MUTE_LOOP_PID=$!
}
stop_mute_watcher_and_restore() {
    [[ -n $MUTE_LOOP_PID ]] || return
    kill "$MUTE_LOOP_PID" 2>/dev/null
    wait "$MUTE_LOOP_PID" 2>/dev/null
    MUTE_LOOP_PID=
    if [[ -f $MUTE_STATE_FILE ]]; then
        idx=$(bus_playback_index)
        [[ -n $idx ]] && pactl set-sink-input-mute "$idx" 0 2>/dev/null
    fi
}

# ---------------------------------------------------------------- build + preconditions
BIN=${LP_PLAYER_BIN:-$REPO/src/player/target/debug/lp-player}
if [[ -z ${LP_PLAYER_BIN:-} ]]; then
    (cd "$REPO" && nix develop -c cargo build -q --manifest-path src/player/Cargo.toml --bin lp-player) \
        2> >(grep -v "Git tree .* is dirty" >&2) || fail "build"
fi
[[ -x $BIN ]] || fail "no binary at $BIN"
for t in pactl pw-link pw-dump jq ffmpeg; do command -v "$t" >/dev/null || fail "missing $t"; done

# The legacy wallpaper must not play during the run (owner instruction); leave it stopped.
if pgrep -x mpvpaper >/dev/null; then
    curl -s -X POST 127.0.0.1:5174/stop >/dev/null
    for _ in $(seq 30); do pgrep -x mpvpaper >/dev/null || break; sleep 0.1; done
fi
pgrep -x mpvpaper >/dev/null && fail "legacy mpvpaper still running"
[[ $(sink_count) == 0 ]] || fail "an lp-player-bus sink already exists (another player?)"

ORIG=$(pactl get-default-sink)
[[ -n $ORIG && $ORIG != lp-player-bus ]] || fail "unexpected default sink '$ORIG'"
echo "default sink before: $ORIG"

TMP=$(mktemp -d /tmp/lp-bus.XXXXXX)
export XDG_RUNTIME_DIR=$TMP/run XDG_STATE_HOME=$TMP/state
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_STATE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
SERVE_PID=
OWNED= # node ids serve owned (bus playback/sink, meter, latency probes, mpv streams)
start_mute_watcher

# Nodes of the running serve (its in-process loopback/meter and its mpv streams).
serve_nodes() {
    [[ -n $SERVE_PID ]] || return 0
    # Node → its client (`client.id`) → that client's `application.process.id`.
    pw-dump | jq -r --arg p "$SERVE_PID" '
        [.[] | select(.type == "PipeWire:Interface:Client")
             | select((.info.props["application.process.id"] // "" | tostring) == $p) | .id] as $mine
        | .[] | select(.type == "PipeWire:Interface:Node")
        | select((.info.props["client.id"] // -1) as $c | $mine | index($c)) | .id'
}
note_nodes() { OWNED="$OWNED $(serve_nodes | tr '\n' ' ')"; }
live_node() { pw-dump | jq -e --argjson i "$1" 'any(.[]; .id == $i and .type == "PipeWire:Interface:Node")' >/dev/null; }
# "subject key" for every target.* entry in the default metadata.
target_entries() {
    pw-metadata -n default 2>/dev/null | sed -n "s/^update: id:\([0-9]*\) key:'\(target\.[a-z]*\)'.*/\1 \2/p"
}
# Delete target.* entries on subjects $@ (only for ids that are still ours or dangling).
clear_targets() {
    local id k n=0
    for id in "$@"; do
        while read -r k; do
            [[ -n $k ]] || continue
            pw-metadata -d -- "$id" "$k" >/dev/null && n=$((n + 1))
        done < <(target_entries | awk -v id="$id" '$1 == id { print $2 }')
    done
    echo "$n"
}
wp_saved_target() {
    [[ -f $WP_STATE ]] && grep -E '^[^=]*:application\.(name|id):lp-player=' "$WP_STATE" | grep -q '"target"'
}
# WirePlumber saves "no target" for lp-player's key when a stream with that key gets
# target.object = -1: a silent stream (/dev/zero, never restored/saved props of its own).
wp_clear_saved_target() {
    timeout 8 pw-cat --playback --raw --rate 48000 --channels 2 --format f32 \
        -P '{ application.name = lp-player node.name = lp-player-state-cleanup state.restore-props = false }' \
        /dev/zero >/dev/null 2>&1 &
    local pid=$! id=
    for _ in $(seq 30); do
        id=$(pw-dump | jq -r '.[] | select(.type == "PipeWire:Interface:Node" and .info.props["node.name"] == "lp-player-state-cleanup") | .id' | head -1)
        [[ -n $id ]] && break
        sleep 0.1
    done
    [[ -n $id ]] && pw-metadata -- "$id" target.object -1 Spa:Id >/dev/null
    for _ in $(seq 40); do wp_saved_target || break; sleep 0.1; done
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
}

cleanup() {
    local rc=$?
    stop_mute_watcher_and_restore
    [[ -n ${MON_PID:-} ]] && kill "$MON_PID" 2>/dev/null
    if [[ -n ${CONTROL_PID:-} ]]; then
        [[ -n ${CONTROL_ID:-} ]] && pw-metadata -d -- "$CONTROL_ID" >/dev/null 2>&1
        kill "$CONTROL_PID" 2>/dev/null
        wait "$CONTROL_PID" 2>/dev/null
    fi
    if [[ -n $SERVE_PID ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
        note_nodes
        # shellcheck disable=SC2086 # word-split on purpose: one id per arg
        clear_targets $OWNED >/dev/null
        "$BIN" ctl quit >/dev/null 2>&1
        for _ in $(seq 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
        kill -9 "$SERVE_PID" 2>/dev/null
        wait "$SERVE_PID" 2>/dev/null
    fi
    SERVE_PID=
    # Routing entries left on a node serve owned (normally PipeWire drops a removed subject's
    # metadata): delete them unless the id was already reused by someone else's node.
    local id left=() n
    for id in $(tr ' ' '\n' <<<"$OWNED" | sort -un); do
        target_entries | awk -v id="$id" '$1 == id { f = 1 } END { exit !f }' || continue
        if live_node "$id"; then
            echo "note: target metadata on id $id kept (id now belongs to another node)"
        else
            left+=("$id")
        fi
    done
    if ((${#left[@]})); then
        n=$(clear_targets "${left[@]}")
        echo "cleared $n leftover target entries on ids ${left[*]}"
        # Re-verify: clear_targets's own pw-metadata -d exit status isn't proof the entry is
        # actually gone (a stale id, a race with PipeWire dropping it itself) — look again,
        # on the interrupted path too (this runs from the EXIT trap either way).
        local still=()
        for id in "${left[@]}"; do
            target_entries | awk -v id="$id" '$1 == id { f = 1 } END { exit !f }' && still+=("$id")
        done
        if ((${#still[@]})); then
            echo "FAIL: routing metadata still on ids ${still[*]} after clear_targets: $(target_entries)" >&2
            rc=1
        else
            echo "routing metadata on serve's nodes: none left"
        fi
    else
        echo "routing metadata on serve's nodes: none left"
    fi
    pactl set-default-sink "$ORIG"
    local after
    after=$(pactl get-default-sink)
    echo "default sink after: $after (before: $ORIG)"
    if [[ $after != "$ORIG" ]]; then
        echo "FAIL: default sink not restored" >&2
        rc=1
    fi
    for _ in $(seq 30); do [[ $(sink_count) == 0 ]] && break; sleep 0.1; done
    if [[ $(sink_count) != 0 ]]; then
        echo "FAIL: an lp-player-bus sink is still loaded" >&2
        rc=1
    else
        echo "no lp-player-bus sink left"
    fi
    if wp_saved_target; then
        echo "FAIL: WirePlumber had saved a stream target for lp-player; clearing it" >&2
        rc=1
        wp_clear_saved_target
        wp_saved_target && echo "FAIL: could not clear it: $(grep 'lp-player=' "$WP_STATE")" >&2
    fi
    if [[ $rc == 0 ]]; then
        rm -rf "$TMP"
        echo PASS
    else
        echo "kept $TMP (serve.err, state/livepaper/lp-player/events.jsonl)"
    fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

ctl() { "$BIN" ctl "$@"; }

# 20 s, 320x180, stereo 440 Hz sine at -20 dBFS peak (amplitude 0.1), PCM s16le (exact level).
CLIP=$TMP/tone440.mkv
ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=0x204060:s=320x180:r=30:d=20" \
    -f lavfi -i "aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*440*t):s=48000:d=20" \
    -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le "$CLIP" || fail "ffmpeg"

# ---------------------------------------------------------------- 1. the bus exists
"$BIN" serve --headless --outputs 640x360@60 --log-level debug >"$TMP/serve.out" 2>"$TMP/serve.err" &
SERVE_PID=$!
SOCK=$XDG_RUNTIME_DIR/livepaper/lp-player.sock
for _ in $(seq 150); do [[ -S $SOCK ]] && break; sleep 0.1; done
[[ -S $SOCK ]] || fail "serve never bound $SOCK: $(cat "$TMP/serve.err")"
ctl hello >/dev/null || fail "hello"
note_nodes

BUS=$(ctl probe '{"name":"bus"}') || fail "probe bus: $BUS"
[[ $(jq -r .state <<<"$BUS") == up ]] || fail "bus not up: $BUS"
[[ $(jq -r .device <<<"$BUS") == pipewire/lp-player-bus ]] || fail "device: $BUS"
LAT=$(jq -r .latency_ms <<<"$BUS")
QMS=$(jq -r .quantum_ms <<<"$BUS")
echo "Bus::latency() = $LAT ms ($(jq -r .latency_samples <<<"$BUS") samples; quantum $QMS ms; target $(jq -r .target <<<"$BUS"))"
jq -e --argjson l "$LAT" --argjson q "$QMS" -n '$l <= $q + 5' >/dev/null \
    || fail "latency $LAT ms > 1 quantum ($QMS ms) + 5 ms"
ok "latency gate: $LAT ms <= $QMS + 5 ms"

[[ $(sink_count) == 1 ]] || fail "pactl list sinks short: $(sink_count) lp-player-bus sinks"
ok "pactl list sinks short has lp-player-bus"

DUMP=$(pw-dump)
node_prop() { # node.name, prop
    jq -r --arg n "$1" --arg p "$2" \
        '[.[] | select(.type == "PipeWire:Interface:Node" and .info.props["node.name"] == $n)]
         | if length == 1 then .[0].info.props[$p] // "<unset>" else "<\(length) nodes>" end' <<<"$DUMP"
}
[[ $(node_prop lp-player-bus.playback application.name) == lp-player ]] || fail "playback application.name: $(node_prop lp-player-bus.playback application.name)"
[[ $(node_prop lp-player-bus.playback media.role) == Wallpaper ]] || fail "playback media.role: $(node_prop lp-player-bus.playback media.role)"
[[ $(node_prop lp-player-bus.playback media.class) == Stream/Output/Audio ]] || fail "playback media.class: $(node_prop lp-player-bus.playback media.class)"
[[ $(node_prop lp-player-bus media.class) == Audio/Sink ]] || fail "sink media.class: $(node_prop lp-player-bus media.class)"
[[ $(node_prop lp-player-bus node.description) == "lp-player bus" ]] || fail "sink node.description: $(node_prop lp-player-bus node.description)"
SI=$(pactl -f json list sink-inputs | jq -c '[.[] | select(.properties["node.name"] == "lp-player-bus.playback")]')
[[ $(jq length <<<"$SI") == 1 ]] || fail "pactl sink-inputs with node.name lp-player-bus.playback: $SI"
[[ $(jq -r '.[0].properties["application.name"]' <<<"$SI") == lp-player ]] || fail "sink-input application.name: $SI"
[[ $(jq -r '.[0].properties["media.role"]' <<<"$SI") == Wallpaper ]] || fail "sink-input media.role: $SI"
ok "identity: playback {node.name lp-player-bus.playback, application.name lp-player, media.role Wallpaper}, sink {lp-player-bus, \"lp-player bus\"}"

linked_to "$ORIG" || fail "bus playback not linked to the default sink $ORIG: $(pw-link -l | grep -A2 'lp-player-bus.playback:')"
ok "pw-link: lp-player-bus.playback -> $ORIG"

# ---------------------------------------------------------------- 2. tone through the bus
TR=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$CLIP\",\"loop\":true}}") || fail "transition: $TR"
SRC=$(jq -r .to <<<"$TR")
for _ in $(seq 100); do
    T=$(ctl get "{\"path\":\"$SRC.time_pos\"}" 2>/dev/null | jq -r '.value // 0')
    jq -e --argjson t "${T:-0}" -n '$t >= 1.5' >/dev/null && break
    sleep 0.1
done
jq -e --argjson t "${T:-0}" -n '$t >= 1.5' >/dev/null || fail "source never reached 1.5 s (time_pos $T)"
note_nodes

W=$(ctl probe '{"name":"meter.window","args":{"last_ms":1000}}') || fail "meter.window: $W"
MED=$(jq -r .median_db <<<"$W")
echo "meter last 1000 ms: count $(jq -r .count <<<"$W"), median $MED, min $(jq -r .min_db <<<"$W"), max $(jq -r .max_db <<<"$W") dBFS"
jq -e --argjson m "$MED" -n '$m >= -26 and $m <= -20' >/dev/null || fail "median $MED dBFS not within -23 +- 3"
ok "meter median $MED dBFS within -23 +- 3"

SP=$(ctl probe '{"name":"sources"}') || fail "probe sources"
DEV=$(jq -r --arg s "$SRC" '.sources[] | select(.id == $s) | .mpv_audio_device' <<<"$SP")
DLY=$(jq -r --arg s "$SRC" '.sources[] | select(.id == $s) | .mpv_audio_delay' <<<"$SP")
[[ $DEV == pipewire/lp-player-bus ]] || fail "source mpv audio-device '$DEV'"
jq -e --argjson d "$DLY" --argjson l "$LAT" -n '(($d * 1000) + $l | fabs) < 0.01' >/dev/null \
    || fail "source mpv audio-delay $DLY s != -$LAT ms"
ok "source mpv: audio-device $DEV, audio-delay $DLY s"
pw-link -l | grep -A3 '^lp-player-bus:playback_FL$' | grep -q '|<-' || fail "nothing linked into lp-player-bus:playback_FL"
ok "pw-link: a stream feeds lp-player-bus"

# ---------------------------------------------------------------- 3. default_sink_change_retargets
# The bus re-points its playback at the new default (metadata target.object, like
# pavucontrol). A session policy may re-point output streams itself — on this machine
# EasyEffects ("process all output streams") puts every output stream back on its sink. The
# bus must not fight that: it reports `audio.bus.moved` + `overridden` and stops. A control
# stream (silent, moved the same way) tells which case this session is in.
OTHER=$(pactl list sinks short | awk -v a="$ORIG" '$2 != "lp-player-bus" && $2 != a { print $2; exit }')
[[ -n $OTHER ]] || fail "no second sink to retarget to"

# Names of the Audio/Sink nodes node $1 is linked into (pw-dump), space-separated.
sinks_of() {
    pw-dump | jq -r --arg n "$1" '
        (map(select(.type == "PipeWire:Interface:Node")) | map({key: (.id | tostring), value: .info.props}) | from_entries) as $nodes
        | [.[] | select(.type == "PipeWire:Interface:Link") | .info as $l
           | select($nodes[($l["output-node-id"] | tostring)]["node.name"] == $n)
           | $nodes[($l["input-node-id"] | tostring)] | select(.["media.class"] == "Audio/Sink") | .["node.name"]]
        | unique | join(" ")'
}
serial_of() { pw-dump | jq -r --arg n "$1" '.[] | select(.type == "PipeWire:Interface:Node" and .info.props["node.name"] == $n) | .info.props["object.serial"]' | head -1; }
CONTROL_PID= CONTROL_ID=
# Where a plain output stream moved to sink $1 by metadata ends up after 1 s.
control_sink() {
    timeout 10 pw-cat --playback --raw --rate 48000 --channels 2 --format f32 \
        -P '{ node.name = lp-bus-test-control application.name = lp-bus-test state.restore-props = false state.restore-target = false }' \
        /dev/zero >/dev/null 2>&1 &
    CONTROL_PID=$!
    for _ in $(seq 30); do
        CONTROL_ID=$(pw-dump | jq -r '.[] | select(.type == "PipeWire:Interface:Node" and .info.props["node.name"] == "lp-bus-test-control") | .id' | head -1)
        [[ -n $CONTROL_ID ]] && break
        sleep 0.1
    done
    [[ -n $CONTROL_ID ]] || return 1
    sleep 0.3
    pw-metadata -- "$CONTROL_ID" target.object "$(serial_of "$1")" Spa:Id >/dev/null
    sleep 1
    sinks_of lp-bus-test-control
    pw-metadata -d -- "$CONTROL_ID" >/dev/null
    kill "$CONTROL_PID" 2>/dev/null
    wait "$CONTROL_PID" 2>/dev/null
    CONTROL_PID=
}

# Links the bus playback's FL and FR ports got created to sink $1, in a `pw-link -m -l`
# capture ($2): a session policy may re-point the stream within milliseconds, faster than
# polling `pw-link -l` can see, so the creation events are the proof.
created_link_to() {
    awk -v sink="$1" '
        $3 == "|->" || $3 == "|<-" || $2 == "|->" || $2 == "|<-" {
            if ($1 == "+" && $3 == "|->" && port ~ /^lp-player-bus\.playback:output_F[LR]$/) {
                split($5, a, ":"); if (a[1] == sink) n[port] = 1
            }
            next
        }
        $1 == "+" || $1 == "*" || $1 == "-" || $1 == "=" { port = $3 }
        END { exit !(("lp-player-bus.playback:output_FL" in n) && ("lp-player-bus.playback:output_FR" in n)) }' "$2"
}
MON=$TMP/links.mon
pw-link -m -l -I >"$MON" 2>/dev/null &
MON_PID=$!
sleep 0.3
TM=$(ctl probe '{"name":"bus"}' | jq -r .now_ms)
T0=$(now_ms)
pactl set-default-sink "$OTHER"
SEEN=
while (($(now_ms) - T0 <= 1000)); do
    [[ -z $SEEN ]] && linked_to "$OTHER" && SEEN=$(($(now_ms) - T0))
    sleep 0.02
done
kill "$MON_PID" 2>/dev/null
wait "$MON_PID" 2>/dev/null
CREATED=no
created_link_to "$OTHER" "$MON" && CREATED=yes
STEADY=$(sinks_of lp-player-bus.playback)
POLICY=$(control_sink "$OTHER") || fail "control stream never appeared"
BUSP=$(ctl probe '{"name":"bus"}')
echo "default -> $OTHER: links bus playback -> $OTHER created within 1 s: $CREATED (seen by polling after ${SEEN:-never} ms); at +1 s on '$STEADY'; a control stream moved to $OTHER ends on '$POLICY'"
echo "bus probe: $(jq -c '{state, target, requested, overridden, retargets}' <<<"$BUSP")"

EV=$(ctl logs '{"kind_prefix":"audio.bus.","limit":500}') || fail "logs"
RT=$(jq -r --argjson t "$TM" --arg to "$OTHER" '[.events[] | select(.t_mono_ms >= $t and .kind == "audio.bus.retargeting" and .to == $to)] | .[0].t_mono_ms // empty' <<<"$EV")
UP=$(jq -r --argjson r "${RT:-1e18}" --arg to "$OTHER" '[.events[] | select(.t_mono_ms >= $r and .kind == "audio.bus.up" and .requested == $to)] | .[0].t_mono_ms // empty' <<<"$EV")
[[ -n $RT && -n $UP ]] || fail "expected audio.bus.retargeting -> audio.bus.up for $OTHER: $(jq -c '[.events[] | {kind, t_mono_ms, to, requested, target}]' <<<"$EV")"
jq -e -n --argjson r "$RT" --argjson u "$UP" --argjson t "$TM" '$u - $t <= 1000' >/dev/null \
    || fail "audio.bus.up came $(jq -n --argjson u "$UP" --argjson t "$TM" '$u - $t') ms after the switch (> 1 s)"
NRT=$(jq --argjson t "$TM" '[.events[] | select(.t_mono_ms >= $t and .kind == "audio.bus.retargeting")] | length' <<<"$EV")
((NRT == 1)) || fail "$NRT audio.bus.retargeting events for one default change (fighting?)"
ok "events: audio.bus.retargeting @ $RT ms -> audio.bus.up @ $UP ms (requested $OTHER), one retarget"
if [[ $POLICY == "$OTHER" ]]; then
    [[ $STEADY == "$OTHER" ]] || fail "no session policy, yet the bus playback is on '$STEADY', not $OTHER"
    [[ $(jq -r .target <<<"$BUSP") == "$OTHER" && $(jq -r .overridden <<<"$BUSP") == false ]] || fail "bus probe: $BUSP"
    [[ $CREATED == yes ]] || fail "no link bus playback -> $OTHER was created within 1 s"
    ok "bus playback re-linked to $OTHER within 1 s and stays there"
else
    [[ $CREATED == yes ]] || fail "no link bus playback -> $OTHER was created within 1 s"
    MOVED=$(jq -c --argjson t "$TM" '[.events[] | select(.t_mono_ms >= $t and .kind == "audio.bus.moved")] | .[0] // empty' <<<"$EV")
    [[ -n $MOVED && $(jq -r .target <<<"$MOVED") == "$POLICY" ]] || fail "policy moved the bus to '$POLICY' but no matching audio.bus.moved: $MOVED"
    [[ $STEADY == "$POLICY" ]] || fail "bus playback on '$STEADY', the session policy's sink is '$POLICY'"
    [[ $(jq -r .target <<<"$BUSP") == "$POLICY" && $(jq -r .overridden <<<"$BUSP") == true ]] || fail "bus probe doesn't report the override: $BUSP"
    ok "bus playback re-linked to $OTHER within 1 s; the session policy then put it on $POLICY (as it does every output stream) — reported, not fought"
fi

FROM=$(jq -n --argjson t "$TM" '$t - 300')
TO=$(jq -n --argjson u "$UP" '$u + 800')
W=$(ctl probe "{\"name\":\"meter.window\",\"args\":{\"from_ms\":$FROM,\"to_ms\":$TO}}") || fail "meter.window: $W"
GAP=$(jq '[.samples as $s | range(1; $s | length) | $s[.][0] - $s[. - 1][0]] | max' <<<"$W")
HEAD=$(jq --argjson f "$FROM" '.samples[0][0] - $f' <<<"$W")
TAIL=$(jq --argjson t "$TO" '$t - .samples[-1][0]' <<<"$W")
QUIET=$(jq '[.samples[] | select(.[1] < -40)] | length' <<<"$W")
echo "meter across the switch [$FROM, $TO] ms: count $(jq .count <<<"$W"), max gap $GAP ms, head $HEAD ms, tail $TAIL ms, min $(jq .min_db <<<"$W") dBFS, median $(jq .median_db <<<"$W") dBFS, blocks < -40 dBFS: $QUIET"
jq -e -n --argjson g "$GAP" --argjson h "$HEAD" --argjson t "$TAIL" '$g <= 50 and $h <= 50 and $t <= 50' >/dev/null \
    || fail "meter gap across the retarget: max gap $GAP ms, head $HEAD ms, tail $TAIL ms (limit 50)"
ok "meter kept producing across the retarget (max gap $GAP ms)"

# Back to the original default.
EXPECT=$ORIG
[[ $POLICY != "$OTHER" ]] && EXPECT=$POLICY
TM=$(ctl probe '{"name":"bus"}' | jq -r .now_ms)
T0=$(now_ms)
pactl set-default-sink "$ORIG"
until [[ $(sinks_of lp-player-bus.playback) == "$EXPECT" ]] \
    && [[ $(ctl probe '{"name":"bus"}' | jq -r .requested) == "$ORIG" ]]; do
    (($(now_ms) - T0 > 1000)) && fail "after the default went back to $ORIG: bus playback on '$(sinks_of lp-player-bus.playback)', bus $(ctl probe '{"name":"bus"}' | jq -c '{target, requested}')"
    sleep 0.02
done
ok "default -> $ORIG: bus playback on $EXPECT after $(($(now_ms) - T0)) ms, requested $ORIG"
sleep 1.5 # WirePlumber saves stream state after a timeout
if [[ -f $WP_STATE ]] && grep -E '^[^=]*:application\.(name|id):lp-player=' "$WP_STATE" | grep -q '"target"'; then
    fail "WirePlumber saved a stream target for lp-player: $(grep 'lp-player=' "$WP_STATE")"
fi
ok "WirePlumber saved no lp-player stream target"
note_nodes
# shellcheck disable=SC2086
N=$(clear_targets $OWNED)
# The re-targets above left target.node/target.object on the bus playback: they must go.
((N >= 2)) || fail "expected the bus playback's target entries to be cleared, cleared $N (owned ids:$OWNED)"
PBID=$(ctl probe '{"name":"bus"}' | jq -r .playback_node)
target_entries | awk -v id="$PBID" '$1 == id { f = 1 } END { exit f }' || fail "target metadata still on the bus playback ($PBID)"
ok "cleared $N per-stream target entries on serve's nodes before quitting"

# ---------------------------------------------------------------- 4. clean exit
ctl quit >/dev/null || fail "quit"
for _ in $(seq 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
kill -0 "$SERVE_PID" 2>/dev/null && fail "serve still running 5 s after quit"
wait "$SERVE_PID"
RC=$?
SERVE_PID=
((RC == 0)) || fail "serve exited $RC"
ok "serve quit cleanly"
for id in $(tr ' ' '\n' <<<"$OWNED" | sort -un); do
    if target_entries | awk -v id="$id" '$1 == id { f = 1 } END { exit !f }' && ! live_node "$id"; then
        fail "target metadata left on removed node $id: $(target_entries | awk -v id="$id" '$1 == id')"
    fi
done
ok "no target metadata left on serve's nodes"
