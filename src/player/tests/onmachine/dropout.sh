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
#   3. `method: reveal` (A held and silent via a 30 ms ramp + settle tail then paused, B
#      rises `sin(x*pi/2)` from the Running instant): same no-drops/no-micro_gaps check,
#      plus an onset check (below) on B's rise — exercises the full-live/reveal half of
#      Task 16c's R85 fix (the held-onset-ramp path), not just frozen's handoff.
#   4. Task 16c (R85/R88): a player-level pause then resume on a *plain* (non-transition)
#      playing source — `ctl set player.paused true` then `false`. `Runtime`'s pause-
#      anticlick gate registers its own dropout window (minted `corr`, carried on
#      `player.pause_gate`'s log event, same pattern as 2b's retire) spanning the whole
#      pause-silence-resume gesture: must show no drops/micro_gaps either, and the
#      resume's onset must be ramped (below), not an instant jump to full level.
#   Onset check (R85, invariant #8): for every case with a real onset (1, 3, 4 above, and
#   2's handoff) — not 2b, a pure offset with no onset at all — the first 10 ms after
#   audio first becomes audible (crosses -85 dBFS) must stay ≥ 6 dB under the ramp's own
#   settled (post-ramp) level: a clean 30 ms ramp (linear or equal-power) does; the
#   original bug (B's ramp starting at the instant of un-pause, before mpv's audio-out had
#   actually restarted) did not — see `check_onset_ramped` below.
#   System state: the default sink is `easyeffects_sink` before and after (never changed
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

# R85/invariant #8 onset check: in the absolute t_mono_ms window [$1,$2], find the first
# sample crossing above -85 dBFS (comfortably above the -96 silence floor, comfortably
# below any of this script's clips) after being below it, then require every sample in
# the following 10 ms to stay >= 6 dB under the "steady" (settled, well past the 30 ms
# ramp) level sampled at [onset+40, onset+200] ms. A clean linear or equal-power 30 ms
# ramp satisfies this easily (at 10/30 progress: linear is ~9.5 dB down, equal-power sin
# is ~6.0 dB down); an unramped jump straight to the settled level does not. $3 is a label
# for the output. No audio crossing -85 dBFS in the window is reported, not failed (the
# search window may be wider than where the clip's own onset actually falls).
check_onset_ramped() {
    local from=$1 to=$2 label=$3
    local win onset_ms steady bad
    win=$(ctl probe "{\"name\":\"meter.window\",\"args\":{\"from_ms\":$from,\"to_ms\":$to}}") \
        || fail "meter.window ($label)"
    onset_ms=$(jq -r '[.samples[] | select(.[1] > -85)] | if length == 0 then "" else .[0][0] end' <<<"$win")
    if [[ -z $onset_ms ]]; then
        echo "onset check ($label): no audio above -85 dBFS in [$from,$to] ms — skipped"
        return 0
    fi
    steady=$(jq -r --argjson o "$onset_ms" \
        '[.samples[] | select(.[0] >= ($o+40) and .[0] <= ($o+200)) | .[1]] | (if length == 0 then -96 else max end)' \
        <<<"$win")
    bad=$(jq -c --argjson o "$onset_ms" --argjson s "$steady" \
        '[.samples[] | select(.[0] >= $o and .[0] < ($o+10) and .[1] > ($s-6))]' <<<"$win")
    if [[ $(jq 'length' <<<"$bad") -gt 0 ]]; then
        echo "FAIL: onset check ($label): unramped onset at ${onset_ms} ms (steady ${steady} dBFS, window [$from,$to]): $bad" >&2
        jq -c '{median_db,min_db,max_db,count}' <<<"$win" >&2
        return 1
    fi
    echo "ok: onset check ($label): ramped cleanly (onset ${onset_ms} ms, steady ${steady} dBFS)"
}

# R80 diagnostics: if a micro_gap appears, dump the raw 1 ms meter samples around it (not
# just the summary) so the report can cite exact numbers rather than guessing — never
# silently discarded. Called *before* any pass/fail assertion on the gap count, so a
# failure still has the raw evidence printed above it.
dump_micro_gap_diagnostics() {
    local corr=$1 report=$2 label=$3
    local n
    n=$(jq '.micro_gaps | length' <<<"$report")
    ((n > 0)) || return 0
    local started_t
    started_t=$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"transition.started\"}" \
        | jq -r '.events[0].t_mono_ms // empty')
    if [[ -z $started_t ]]; then
        # Not a transition (plain retire / player-pause-gate): try each one's own
        # window-start-equivalent log event.
        started_t=$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"source.retire\"}" \
            | jq -r '.events[0].t_mono_ms // empty')
    fi
    echo "=== $label micro_gap diagnostics (corr=$corr, window-start-equivalent t_mono_ms=$started_t) ==="
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
dump_micro_gap_diagnostics "$CORR1" "$REPORT1" "full-live"
((DROPS1 == 0)) || fail "full-live crossfade flagged $DROPS1 drop(s): $(jq -c .drops <<<"$REPORT1")"
((GAPS1 == 0)) || fail "full-live crossfade flagged $GAPS1 micro_gap(s): $(jq -c .micro_gaps <<<"$REPORT1")"
ok "full-live: lag $LAG1 ms, fit $FIT1 dB, 0 drops, 0 micro_gaps"

# No onset check here: full-live's A stays audible (ramping down, not silent) for the
# *whole* crossfade, so the bus never approaches silence anywhere near B's onset — a
# silence-threshold onset detector has nothing to lock onto (confirmed on-machine: the
# very first sample in any search window near `started` is already near A+B's mixed
# level, long before B's own un-pause). drops/micro_gaps == 0 above is full-live's real
# coverage; the onset check's own coverage of the held-onset-ramp path (R85) comes from
# frozen's handoff (below, genuinely silent beforehand) and reveal (silent once A's own
# offset settles, below).

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
GAPS2=$(jq '.micro_gaps | length' <<<"$REPORT2")
echo "frozen report: $(jq -c '{lag_ms, fit_db, drops: (.drops|length), micro_gaps: (.micro_gaps|length)}' <<<"$REPORT2")"
dump_micro_gap_diagnostics "$CORR2" "$REPORT2" "frozen"
((DROPS2 == 0)) || fail "frozen's intended held silence was flagged as $DROPS2 drop(s): $(jq -c .drops <<<"$REPORT2")"
# Task 16c (R85): before the fix this was the owner's "flicker of silence" itself — a
# micro_gap right at the handoff un-pause. Now asserted, not just dumped if present.
((GAPS2 == 0)) || fail "frozen handoff flagged $GAPS2 micro_gap(s) (the R85 bug, unfixed): $(jq -c .micro_gaps <<<"$REPORT2")"
ok "frozen: 0 drops, 0 micro_gaps for the handoff onset"

# R85 onset check: frozen's B starts (and its onset ramp is held) from `transition.
# handoff`, not `.started` — the whole point of this method/bug.
HANDOFF2=$(ctl logs "{\"corr\":\"$CORR2\",\"kind_prefix\":\"transition.handoff\"}" \
    | jq -r '.events[0].t_mono_ms')
check_onset_ramped "$((${HANDOFF2%.*} - 10))" "$((${HANDOFF2%.*} + 300))" "frozen" \
    || fail "frozen onset check (see stderr above)"

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
((GAPS3 == 0)) || fail "plain retire ramp flagged $GAPS3 micro_gap(s): $(jq -c .micro_gaps <<<"$REPORT3")"
ok "retire: 0 drops, 0 micro_gaps for the anti-click ramp (pure offset, no onset to check)"

# ---------------------------------------------------------------- 3. reveal: A fades, B rises
# method: reveal — A ramps to silence over 30 ms + the settle tail then pauses
# (requirement #2's A-offset path), B rises `sin(x*pi/2)` from the Running instant with
# the same held-onset-ramp treatment as full-live (R85) — covers the other half of the
# fix case 2 (frozen) doesn't: B's onset here isn't delayed to a handoff at all, so this
# also proves the fix doesn't regress the already-clean reveal/full-live case.
TR3=$(ctl transition "{\"outputs\":\"out:*\",\"to\":{\"path\":\"$CLIP_B\",\"loop\":true},\
\"effect_id\":\"fade\",\"duration_ms\":1000,\"method\":\"reveal\"}") \
    || fail "reveal transition: $TR3"
CORR3=$(jq -r .corr <<<"$TR3")
EV4=$(wait_for_report "$CORR3" 10 10) || fail "reveal: wait_for_report (see stderr above)"
echo "reveal probe.dropout: $EV4"
[[ $(jq -r 'has("skipped")' <<<"$EV4") == false ]] || fail "probe.dropout skipped: $(jq -r .skipped <<<"$EV4")"
REPORT4=$(jq -c .report <<<"$EV4")
DROPS4=$(jq '.drops | length' <<<"$REPORT4")
GAPS4=$(jq '.micro_gaps | length' <<<"$REPORT4")
echo "reveal report: $(jq -c '{lag_ms, fit_db, drops: (.drops|length), micro_gaps: (.micro_gaps|length)}' <<<"$REPORT4")"
dump_micro_gap_diagnostics "$CORR3" "$REPORT4" "reveal"
((DROPS4 == 0)) || fail "reveal flagged $DROPS4 drop(s): $(jq -c .drops <<<"$REPORT4")"
((GAPS4 == 0)) || fail "reveal flagged $GAPS4 micro_gap(s): $(jq -c .micro_gaps <<<"$REPORT4")"
ok "reveal: 0 drops, 0 micro_gaps"
# Unlike full-live, reveal's A *does* go silent quickly (its own 30 ms ramp + the
# requirement #2 settle tail, same as frozen's A-hold) — search from there, not from
# `started` itself, so the window begins on a genuinely silent bus (A paused, B still
# waiting), the same premise frozen's handoff check relies on.
STARTED3=$(ctl logs "{\"corr\":\"$CORR3\",\"kind_prefix\":\"transition.started\"}" \
    | jq -r '.events[0].t_mono_ms')
check_onset_ramped "$((${STARTED3%.*} + 45))" "$((${STARTED3%.*} + 400))" "reveal" \
    || fail "reveal onset check (see stderr above)"

# Isolate the player-pause/resume case from the current wallpaper (TR3's B, still
# playing/looping): stop every live source so the bus is silent before SRC_P exists. The
# dropout detector explicitly doesn't model a second audible source on the bus
# (debugging.md), and this script restores nothing afterward anyway (no playlist state
# to preserve — `--headless`, never the owner's real session).
ctl stop >/dev/null || fail "stop before the pause/resume case"

# ---------------------------------------------------------------- 4. player pause/resume
# Task 16c (R85/R88): a plain (non-transition) playing source, paused then resumed via
# `player.paused` — `Runtime`'s anticlick gate must ramp it to silence before the real
# mpv pause lands (requirement #2) and ramp it back in only once `AudioFlowing` confirms
# real audio again (R85), never an instant cut either way.
SRC_P=$(ctl create "{\"kind\":\"source\",\"props\":{\"path\":\"$CLIP_A\",\"loop\":true}}" | jq -r .id) \
    || fail "create pause-test source"
for _ in $(seq 50); do
    T=$(ctl get "{\"path\":\"$SRC_P.time_pos\"}" 2>/dev/null | jq -r '.value // 0')
    jq -e --argjson t "${T:-0}" -n '$t >= 1.0' >/dev/null && break
    sleep 0.1
done
jq -e --argjson t "${T:-0}" -n '$t >= 1.0' >/dev/null || fail "pause-test source never reached 1.0 s (time_pos $T)"
ok "pause-test source playing (440 Hz), time_pos $T s"

ctl set '{"path":"player.paused","value":true}' >/dev/null || fail "set player.paused true"
for _ in $(seq 50); do
    P=$(ctl probe '{"name":"sources"}' | jq -r --arg id "$SRC_P" \
        '.sources[] | select(.id == $id) | .mpv_pause')
    [[ $P == yes ]] && break
    sleep 0.05
done
[[ $P == yes ]] || fail "pause-test source never actually paused (mpv_pause=$P)"
ok "pause-test source paused (gate ramped it down first — see corr below)"

ctl set '{"path":"player.paused","value":false}' >/dev/null || fail "set player.paused false"
RESUMED_T=$(ctl logs '{"kind_prefix":"player.paused","limit":10}' \
    | jq -r '[.events[] | select(.paused == false)] | last | .t_mono_ms // empty')
[[ -n $RESUMED_T ]] || fail "no runtime.player.paused{paused:false} event logged"
for _ in $(seq 50); do
    P=$(ctl probe '{"name":"sources"}' | jq -r --arg id "$SRC_P" \
        '.sources[] | select(.id == $id) | .mpv_pause')
    [[ $P == no ]] && break
    sleep 0.05
done
[[ $P == no ]] || fail "pause-test source never un-paused (mpv_pause=$P)"
ok "pause-test source un-paused (resume request t_mono_ms=$RESUMED_T)"

CORR_P=
for _ in $(seq 100); do
    CORR_P=$(ctl logs '{"kind_prefix":"player.pause_gate","limit":20}' \
        | jq -r --arg id "$SRC_P" '[.events[] | select(.id == $id)] | last | .corr // empty')
    [[ -n $CORR_P ]] && break
    sleep 0.1
done
[[ -n $CORR_P ]] || fail "no corr recorded for player.pause_gate of $SRC_P (gate never completed resume?)"
echo "pause/resume corr: $CORR_P"
sleep 1.0
ctl probe "{\"name\":\"dropout\",\"args\":{\"corr\":\"$CORR_P\"}}" >/dev/null \
    || fail "probe dropout (pause/resume, corr $CORR_P)"
EV5=
for _ in $(seq 100); do
    EV5=$(ctl logs "{\"corr\":\"$CORR_P\",\"kind_prefix\":\"probe.dropout\"}" 2>/dev/null \
        | jq -c '.events[-1] // empty')
    [[ -n $EV5 ]] && break
    sleep 0.1
done
[[ -n $EV5 ]] || fail "pause/resume: no probe.dropout within 10s"
echo "pause/resume probe.dropout: $EV5"
[[ $(jq -r 'has("skipped")' <<<"$EV5") == false ]] || fail "pause/resume probe.dropout skipped: $(jq -r .skipped <<<"$EV5")"
REPORT5=$(jq -c .report <<<"$EV5")
DROPS5=$(jq '.drops | length' <<<"$REPORT5")
GAPS5=$(jq '.micro_gaps | length' <<<"$REPORT5")
echo "pause/resume report: $(jq -c '{lag_ms, fit_db, drops: (.drops|length), micro_gaps: (.micro_gaps|length)}' <<<"$REPORT5")"
dump_micro_gap_diagnostics "$CORR_P" "$REPORT5" "pause/resume"
((DROPS5 == 0)) || fail "pause/resume flagged $DROPS5 drop(s): $(jq -c .drops <<<"$REPORT5")"
((GAPS5 == 0)) || fail "pause/resume flagged $GAPS5 micro_gap(s): $(jq -c .micro_gaps <<<"$REPORT5")"
ok "pause/resume: 0 drops, 0 micro_gaps for the whole gesture"
check_onset_ramped "$((${RESUMED_T%.*} - 10))" "$((${RESUMED_T%.*} + 300))" "pause-resume" \
    || fail "pause/resume onset check (see stderr above)"
ctl destroy "{\"id\":\"$SRC_P\"}" >/dev/null || fail "destroy pause-test source"

# ---------------------------------------------------------------- final: clean exit
ctl quit >/dev/null || fail "quit"
for _ in $(seq 50); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.1; done
kill -0 "$SERVE_PID" 2>/dev/null && fail "serve still running 5 s after quit"
wait "$SERVE_PID"
RC=$?
SERVE_PID=
((RC == 0)) || fail "serve exited $RC"
ok "serve quit cleanly"
