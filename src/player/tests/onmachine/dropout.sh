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
#   2b. Review fix round (R80): a PLAIN retire — a bare source, not part of any
#      transition, `ctl destroy`'d while playing — gets the exact same 30 ms anti-click
#      ramp, and `Runtime::retire` registers it as a dropout window too (its own minted
#      `corr`, carried on `source.retire`'s log event). Probed on demand once the meter
#      has actually captured past the window's end: must show no drops either.
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

# R80 diagnostics: if a micro_gap still appears after the fix, dump the raw 1 ms meter
# samples around it (not just the summary) so the report can cite exact numbers rather
# than guessing — never silently discarded.
dump_micro_gap_diagnostics() {
    local corr=$1 report=$2 label=$3
    local n
    n=$(jq '.micro_gaps | length' <<<"$report")
    ((n > 0)) || return 0
    local started_t
    started_t=$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"transition.started\"}" \
        | jq -r '.events[0].t_mono_ms // empty')
    if [[ -z $started_t ]]; then
        # Not a transition (the plain-retire case): `source.retire`'s own t_mono_ms is
        # the window's `started_mono` equivalent.
        started_t=$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"source.retire\"}" \
            | jq -r '.events[0].t_mono_ms // empty')
    fi
    echo "=== $label micro_gap diagnostics (corr=$corr, transition.started t_mono_ms=$started_t) ==="
    jq -c '.micro_gaps[]' <<<"$report" | while read -r g; do
        local at len under from to
        at=$(jq -r .at_ms <<<"$g"); len=$(jq -r .len_ms <<<"$g"); under=$(jq -r .under_db <<<"$g")
        echo "micro_gap at_ms=$at (rel. window start = started_t - 500ms) len_ms=$len under_db=$under"
        if [[ -n $started_t ]]; then
            from=$(jq -n --argjson s "$started_t" --argjson a "$at" '($s - 500 + $a - 15)')
            to=$(jq -n --argjson s "$started_t" --argjson a "$at" --argjson l "$len" '($s - 500 + $a + $l + 15)')
            echo "  absolute meter window ~[$from, $to] ms (t_mono_ms):"
            ctl probe "{\"name\":\"meter.window\",\"args\":{\"from_ms\":$from,\"to_ms\":$to}}" \
                | jq -c '{median_db, min_db, max_db, max_gap_ms, count, samples}'
        fi
    done
    echo "=== end $label diagnostics ==="
}
dump_micro_gap_diagnostics "$CORR2" "$REPORT2" "frozen"

# ---------------------------------------------------------------- 2b. plain retire ramp
# A bare source (no transition at all) playing CLIP_B, destroyed outright: Runtime::retire
# ramps it to silence over 30 ms (same anti-click primitive every method uses) and mints
# its own dropout-probe corr (R79/R80 fix round) — exercising the fix outside the
# transition machinery entirely.
SRC_R=$(ctl create "{\"kind\":\"source\",\"props\":{\"path\":\"$CLIP_B\",\"loop\":true}}" | jq -r .id) \
    || fail "create retire-test source"
for _ in $(seq 50); do
    T=$(ctl get "{\"path\":\"$SRC_R.time_pos\"}" 2>/dev/null | jq -r '.value // 0')
    jq -e --argjson t "${T:-0}" -n '$t >= 1.0' >/dev/null && break
    sleep 0.1
done
jq -e --argjson t "${T:-0}" -n '$t >= 1.0' >/dev/null || fail "retire-test source never reached 1.0 s (time_pos $T)"
ok "retire-test source playing (660 Hz), time_pos $T s"
DESTROY_RES=$(ctl destroy "{\"id\":\"$SRC_R\"}") || fail "destroy retire-test source"
RAMP_R=$(jq -r .ramp_ms <<<"$DESTROY_RES")
echo "destroyed $SRC_R: ramp_ms=$RAMP_R"
CORR_R=
for _ in $(seq 20); do
    CORR_R=$(ctl logs '{"kind_prefix":"source.retire","limit":20}' \
        | jq -r --arg id "$SRC_R" '[.events[] | select(.id == $id)] | last | .corr // empty')
    [[ -n $CORR_R ]] && break
    sleep 0.1
done
[[ -n $CORR_R ]] || fail "no corr recorded for source.retire of $SRC_R"
echo "retire corr: $CORR_R"
# The probe's window ends 500 ms after the ramp (`done_mono + WINDOW_POST`); give the
# meter real wall-clock time to actually have captured that far before probing on demand.
sleep 1.0
ctl probe "{\"name\":\"dropout\",\"args\":{\"corr\":\"$CORR_R\"}}" >/dev/null \
    || fail "probe dropout (retire, corr $CORR_R)"
EV3=
for _ in $(seq 100); do
    EV3=$(ctl logs "{\"corr\":\"$CORR_R\",\"kind_prefix\":\"probe.dropout\"}" 2>/dev/null \
        | jq -c '.events[-1] // empty')
    [[ -n $EV3 ]] && break
    sleep 0.1
done
[[ -n $EV3 ]] || fail "retire: no probe.dropout within 10s"
echo "retire probe.dropout: $EV3"
[[ $(jq -r 'has("skipped")' <<<"$EV3") == false ]] || fail "retire probe.dropout skipped: $(jq -r .skipped <<<"$EV3")"
REPORT3=$(jq -c .report <<<"$EV3")
DROPS3=$(jq '.drops | length' <<<"$REPORT3")
GAPS3=$(jq '.micro_gaps | length' <<<"$REPORT3")
echo "retire report: $(jq -c '{lag_ms, fit, fit_db, drops: (.drops|length), micro_gaps}' <<<"$REPORT3")"
dump_micro_gap_diagnostics "$CORR_R" "$REPORT3" "retire"
((DROPS3 == 0)) || fail "plain retire ramp flagged $DROPS3 drop(s): $(jq -c .drops <<<"$REPORT3")"
ok "retire: 0 drops for the anti-click ramp ($GAPS3 micro_gap(s) — see report above; a \
non-empty micro_gaps here is the owner's original 'flicker of silence' complaint and is \
reported, not hidden, if it persists after the R80 fix"

# ---------------------------------------------------------------- 3. clean exit
ctl quit >/dev/null || fail "quit"
for _ in $(seq 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
kill -0 "$SERVE_PID" 2>/dev/null && fail "serve still running 5 s after quit"
wait "$SERVE_PID"
RC=$?
SERVE_PID=
((RC == 0)) || fail "serve exited $RC"
ok "serve quit cleanly"
