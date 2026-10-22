#!/usr/bin/env bash
# Task 15 on-machine check: the reference-based dropout detector, with REAL audio on the
# owner's PipeWire session. Exit 0 = pass. Spec §5.3, §9 "debug mode";
# .claude/rules/player-core.md § Audio bus / § Command API; docs/player/debugging.md.
#
#   1. `serve --headless --debug` (R71: debug mode on) plays a 440 Hz tone (clip A), then a
#      1000 ms full-live fade to a 660 Hz tone (clip B): once `transition.done` fires, the
#      auto-triggered probe delivers `probe.dropout {corr, report}` within a few seconds —
#      lag 0-250 ms, fit < 2 dB, no drops, no micro_gaps (the crossfade is clean, real audio).
#   2. A second transition, `method: frozen` (A held, B held+silent through the effect,
#      B starts only at handoff): its `probe.dropout` must report no drops for the window —
#      the held silence is intended by the method, not a bug, even though both clips are
#      loud files.
#   3. System state: the default sink is `easyeffects_sink` before and after (never changed
#      by this script — only the bus's own re-target logic ever touches *its* routing, and
#      nothing here triggers a default-sink change at all); no `lp-player-bus` sink is left
#      (serve owns it; serve is quit at the end; a trap covers failure/interrupt too).
#
# Isolation: its own temp XDG_RUNTIME_DIR (the lp-player socket) + XDG_STATE_HOME;
# PipeWire/Pulse still reach the owner's real session via PIPEWIRE_RUNTIME_DIR /
# PULSE_SERVER; --headless with WAYLAND_DISPLAY unset. LP_PLAYER_BIN=<path> skips the build.
set -uo pipefail
unset LD_LIBRARY_PATH WAYLAND_DISPLAY

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
UID_=$(id -u)
export PIPEWIRE_RUNTIME_DIR=/run/user/$UID_
export PULSE_SERVER=unix:/run/user/$UID_/pulse/native

fail() {
    echo "FAIL: $*" >&2
    exit 1
}
ok() { echo "ok: $*"; }
sink_count() { pactl list sinks short | awk '$2=="lp-player-bus"' | wc -l; }

# ---------------------------------------------------------------- build + preconditions
BIN=${LP_PLAYER_BIN:-$REPO/src/player/target/debug/lp-player}
if [[ -z ${LP_PLAYER_BIN:-} ]]; then
    (cd "$REPO" && nix develop -c cargo build -q --manifest-path src/player/Cargo.toml --bin lp-player) \
        2> >(grep -v "Git tree .* is dirty" >&2) || fail "build"
fi
[[ -x $BIN ]] || fail "no binary at $BIN"
for t in pactl jq ffmpeg; do command -v "$t" >/dev/null || fail "missing $t"; done

# The legacy wallpaper must not play during the run (owner instruction); leave it stopped.
if pgrep -x mpvpaper >/dev/null; then
    curl -s -X POST 127.0.0.1:5174/stop >/dev/null
    for _ in $(seq 30); do pgrep -x mpvpaper >/dev/null || break; sleep 0.1; done
fi
pgrep -x mpvpaper >/dev/null && fail "legacy mpvpaper still running"
[[ $(sink_count) == 0 ]] || fail "an lp-player-bus sink already exists (another player?)"

ORIG=$(pactl get-default-sink)
echo "default sink before: $ORIG"
[[ $ORIG == easyeffects_sink ]] || fail "default sink is '$ORIG', expected easyeffects_sink \
(this check never changes it — fix the session first, or adjust the expectation if the \
owner's default has genuinely changed)"

TMP=$(mktemp -d /tmp/lp-dropout.XXXXXX)
export XDG_RUNTIME_DIR=$TMP/run XDG_STATE_HOME=$TMP/state
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_STATE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
SERVE_PID=

cleanup() {
    local rc=$?
    if [[ -n $SERVE_PID ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
        "$BIN" ctl quit >/dev/null 2>&1
        for _ in $(seq 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
        kill -9 "$SERVE_PID" 2>/dev/null
        wait "$SERVE_PID" 2>/dev/null
    fi
    SERVE_PID=
    for _ in $(seq 30); do [[ $(sink_count) == 0 ]] && break; sleep 0.1; done
    if [[ $(sink_count) != 0 ]]; then
        echo "FAIL: an lp-player-bus sink is still loaded" >&2
        rc=1
    else
        echo "no lp-player-bus sink left"
    fi
    local after
    after=$(pactl get-default-sink)
    echo "default sink after: $after (before: $ORIG)"
    if [[ $after != "$ORIG" ]]; then
        echo "FAIL: default sink changed (was never touched by this script)" >&2
        rc=1
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

# Two 6 s tone clips, -20 dBFS peak, stereo (identical channels — see tests/dropout.rs's
# ffmpeg_decode_reads_the_sine_tones_true_level for the measured +3 dB correlated-stereo
# downmix this implies for the probe's own decode).
CLIP_A=$TMP/tone440.mkv
CLIP_B=$TMP/tone660.mkv
for spec in "$CLIP_A 440" "$CLIP_B 660"; do
    read -r path hz <<<"$spec"
    ffmpeg -nostdin -hide_banner -loglevel error -y \
        -f lavfi -i "color=c=0x204060:s=320x180:r=30:d=6" \
        -f lavfi -i "aevalsrc=0.1*sin(2*PI*${hz}*t)|0.1*sin(2*PI*${hz}*t):s=48000:d=6" \
        -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le "$path" || fail "ffmpeg ($path)"
done

# ---------------------------------------------------------------- serve --debug
"$BIN" serve --headless --outputs 640x360@60 --debug --log-level debug \
    >"$TMP/serve.out" 2>"$TMP/serve.err" &
SERVE_PID=$!
SOCK=$XDG_RUNTIME_DIR/livepaper/lp-player.sock
for _ in $(seq 150); do [[ -S $SOCK ]] && break; sleep 0.1; done
[[ -S $SOCK ]] || fail "serve never bound $SOCK: $(cat "$TMP/serve.err")"
ctl hello >/dev/null || fail "hello"
[[ $(ctl get '{"path":"player.debug"}' | jq -r .value) == true ]] || fail "player.debug not true after --debug"
ok "serve up, player.debug = true"

# A plays first (a cut — no effect_id — just to get a real, advancing A on screen).
TR0=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$CLIP_A\",\"loop\":true}}") \
    || fail "initial transition: $TR0"
SRC_A=$(jq -r .to <<<"$TR0")
for _ in $(seq 50); do
    T=$(ctl get "{\"path\":\"$SRC_A.time_pos\"}" 2>/dev/null | jq -r '.value // 0')
    jq -e --argjson t "${T:-0}" -n '$t >= 1.0' >/dev/null && break
    sleep 0.1
done
jq -e --argjson t "${T:-0}" -n '$t >= 1.0' >/dev/null || fail "A never reached 1.0 s (time_pos $T)"
ok "A playing (440 Hz), time_pos $T s"

# Waits up to $2 s for `transition.done` on corr $1, then up to $3 s more for its
# `probe.dropout`, and prints the report JSON on stdout. Returns non-zero (diagnostic on
# stderr) on timeout — never `exit`/`fail` directly: this runs inside a `$(...)`
# substitution at the call site, where `exit` would only kill the subshell, not the script.
wait_for_report() {
    local corr=$1 done_timeout=$2 probe_timeout=$3 i
    for ((i = 0; i < done_timeout * 10; i++)); do
        ctl logs "{\"corr\":\"$corr\"}" 2>/dev/null \
            | jq -e '.events[] | select(.kind == "transition.done")' >/dev/null 2>&1 && break
        sleep 0.1
    done
    if ((i >= done_timeout * 10)); then
        echo "corr $corr: no transition.done within ${done_timeout}s" >&2
        return 1
    fi
    for ((i = 0; i < probe_timeout * 10; i++)); do
        local ev
        ev=$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"probe.dropout\"}" 2>/dev/null \
            | jq -c '.events[-1] // empty')
        if [[ -n $ev ]]; then
            echo "$ev"
            return 0
        fi
        sleep 0.1
    done
    echo "corr $corr: no probe.dropout within ${probe_timeout}s after transition.done" >&2
    return 1
}

# ---------------------------------------------------------------- 1. full-live, clean crossfade
TR1=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$CLIP_B\",\"loop\":true},\
\"effect_id\":\"fade\",\"duration_ms\":1000,\"method\":\"full-live\"}") \
    || fail "full-live transition: $TR1"
CORR1=$(jq -r .corr <<<"$TR1")
EV1=$(wait_for_report "$CORR1" 10 10) || fail "full-live: wait_for_report (see stderr above)"
echo "full-live probe.dropout: $EV1"
[[ $(jq -r 'has("skipped")' <<<"$EV1") == false ]] || fail "probe.dropout skipped: $(jq -r .skipped <<<"$EV1")"
REPORT1=$(jq -c .report <<<"$EV1")
LAG1=$(jq -r .lag_ms <<<"$REPORT1")
FIT1=$(jq -r .fit_db <<<"$REPORT1")
DROPS1=$(jq '.drops | length' <<<"$REPORT1")
GAPS1=$(jq '.micro_gaps | length' <<<"$REPORT1")
echo "full-live report: lag_ms=$LAG1 fit_db=$FIT1 drops=$DROPS1 micro_gaps=$GAPS1"
jq -e -n --argjson l "$LAG1" '$l >= 0 and $l <= 250' >/dev/null || fail "lag_ms $LAG1 outside 0..250"
jq -e -n --argjson f "$FIT1" '$f < 2.0' >/dev/null || fail "fit_db $FIT1 >= 2.0"
((DROPS1 == 0)) || fail "full-live crossfade flagged $DROPS1 drop(s): $(jq -c .drops <<<"$REPORT1")"
((GAPS1 == 0)) || fail "full-live crossfade flagged $GAPS1 micro_gap(s): $(jq -c .micro_gaps <<<"$REPORT1")"
ok "full-live: lag $LAG1 ms, fit $FIT1 dB, 0 drops, 0 micro_gaps"

# ---------------------------------------------------------------- 2. frozen: held silence
TR2=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$CLIP_A\",\"loop\":true},\
\"effect_id\":\"fade\",\"duration_ms\":1000,\"method\":\"frozen\"}") \
    || fail "frozen transition: $TR2"
CORR2=$(jq -r .corr <<<"$TR2")
EV2=$(wait_for_report "$CORR2" 10 10) || fail "frozen: wait_for_report (see stderr above)"
echo "frozen probe.dropout: $EV2"
[[ $(jq -r 'has("skipped")' <<<"$EV2") == false ]] || fail "probe.dropout skipped: $(jq -r .skipped <<<"$EV2")"
REPORT2=$(jq -c .report <<<"$EV2")
DROPS2=$(jq '.drops | length' <<<"$REPORT2")
echo "frozen report: $(jq -c '{lag_ms, fit_db, drops: (.drops|length), micro_gaps: (.micro_gaps|length)}' <<<"$REPORT2")"
((DROPS2 == 0)) || fail "frozen's intended held silence was flagged as $DROPS2 drop(s): $(jq -c .drops <<<"$REPORT2")"
ok "frozen: 0 drops for the intended held silence"

# ---------------------------------------------------------------- 3. clean exit
ctl quit >/dev/null || fail "quit"
for _ in $(seq 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
kill -0 "$SERVE_PID" 2>/dev/null && fail "serve still running 5 s after quit"
wait "$SERVE_PID"
RC=$?
SERVE_PID=
((RC == 0)) || fail "serve exited $RC"
ok "serve quit cleanly"
