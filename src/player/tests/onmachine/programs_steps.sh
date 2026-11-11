# Steps of programs.sh (sourced; see its header). Each step_<name> starts what it needs and leaves
# <results>/<name>.json. Bounds are the plan's (Task 12) unless a comment says otherwise.

FADE='"enabled":true,"effects":["fade"],"shuffle":false,"duration_ms":1000,"duration_max_ms":1000'
ROT_ORIGIN='program:prog:main'
FRAME_MS=33.4 # one frame of the 30 fps clips (the report's `pred` column: from a `position` stale by ≤ 100 ms, loose)
# F3 (2026-11-04): the handoff is due one clip frame after `source.ended` (A's last frame presented); it may be
# held at most one output frame (DP-1 144 Hz: 6.9 ms, + the `Ended` poll's slack) and never cut (−3 ms).
HANDOFF_HOLD_MS=10
HANDOFF_CUT_MS=-3
B_LATE_START_MS=20 # a late B's effect starts at the tick that sees it ready (+ that tick's slack)

# ------------------------------------------------------------------ small helpers
items_json() { jq -nc '[$ARGS.positional[] | {path: .}]' --args "$@"; }
scene_item() { jq -nc --arg p "$1" '{path:$p, props:{kind:"scene"}}'; }
paths_json() { jq -nc '$ARGS.positional' --args "$@"; }
prog_create() { # <props json>: replaces prog:main on every output, then plays it
    ctl destroy '{"id":"prog:main"}' >/dev/null 2>&1
    ctl create "$(jq -nc --argjson p "$1" '{kind:"program", id:"prog:main", props:({outputs:"out:*"} + $p)}')" >/dev/null || die "create prog:main: $1"
    ctl program.play '{"id":"prog:main"}' >/dev/null || die "program.play"
}
commits_since() { # <epoch> [reason] → program.current since then, from the event file (not the ring)
    report events "$(evdir)" "$1" 99999999999 program.current | jq --arg r "${2:-}" '[.[] | select($r == "" or .reason == $r)] | length'
}
wait_commits() { # <epoch> <n> <timeout s> [reason]
    local i
    for ((i = 0; i < $3; i++)); do
        (($(commits_since "$1" "${4:-}") >= $2)) && return 0
        sleep 1
    done
    return 1
}
ev_first() { # <kind> <epoch> → that event's first occurrence since then, or empty
    report events "$(evdir)" "$2" 99999999999 "$1" | jq -c --arg k "$1" '[.[] | select(.kind == $k)][0] // empty'
}
wait_ev() { # <kind> <epoch> <timeout s> → the event
    local i e
    for ((i = 0; i < $3 * 10; i++)); do
        e=$(ev_first "$1" "$2")
        [[ -n $e ]] && { echo "$e"; return 0; }
        sleep 0.1
    done
    return 1
}
shown_path() { # the path on an output's main layer
    local id
    id=$(ctl get "{\"path\":\"lay:$1:main.content\"}" | jq -r .value)
    ctl get "{\"path\":\"$id.path\"}" | jq -r .value
}
active_ws() { hyprctl monitors -j | jq -r --arg m "$1" '.[] | select(.name == $m) | .activeWorkspace.id'; }
assert_mine() { # <pid>: exe is our player, its XDG_RUNTIME_DIR ours — before any signal
    local exe
    exe=$(readlink "/proc/$1/exe" 2>/dev/null)
    [[ $exe == "$BIN" ]] || die "pid $1 is $exe, not $BIN"
    tr '\0' '\n' <"/proc/$1/environ" | grep -qxF "XDG_RUNTIME_DIR=$RT" || die "pid $1 is not on $RT"
}
be_play() { # <settings json> <path>… (`/playlist/play`, the bar's own request)
    local s=$1
    shift
    bpost /playlist/play "$(jq -nc --argjson s "$s" --argjson p "$(paths_json "$@")" '{paths:$p, settings:$s}')" >/dev/null || die "/playlist/play"
    wait_prog '.id == "prog:main" and (.phase | IN("playing", "holding", "armed", "switching"))' 20 || die "the program never played: $(prog)"
    the_player_pid || die "no player after /playlist/play"
}
be_rotation() { # <switch at end true/false> <interval s> [start mode]
    be_setting GlobalSwitchWhenVideoEnds "$1"
    be_setting GlobalIntervalSeconds "$2"
    be_setting GlobalMaxPlaySeconds 0
    be_setting GlobalPlaylistStart "\"${3:-start_over}\""
}

# ------------------------------------------------------------------ step 1 — dropout across program switches
dropout_cell() { # <cell> <method> <props json> <seconds per switch>
    local cell=$1 method=$2 props=$3 per=$4 t0 t1 c
    serve_ready_for_cell
    props=$(jq -c --arg m "$method" --argjson t "{$FADE}" '. + {transition: ($t + {method: $m})}' <<<"$props")
    t0=$(now)
    prog_create "$props"
    say "cell $cell × $method: $SWITCHES switches (~$((SWITCHES * per)) s)"
    wait_commits "$t0" $((SWITCHES + 1)) $((SWITCHES * per * 2 + 60)) \
        || note "$cell × $method: only $(commits_since "$t0") commits in the time allowed"
    t1=$(now)
    ctl destroy '{"id":"prog:main"}' >/dev/null
    sleep 6 # the last switch's dropout probe
    c=$(report dropout "$(evdir)" "$t0" "$t1" "$cell" "$method" "$RESULTS/dropout-records.jsonl")
    echo "$c" >>"$RESULTS/dropout-cells.jsonl"
    local n="$cell × $method"
    check "$n commits" "$(jq -r .commits <<<"$c")" "≥ $SWITCHES" "$(pyb "$(jq -r .commits <<<"$c") >= $SWITCHES")" "$c"
    check "$n every scheduled switch done" "$(jq -r '"\(.done)/\(.scheduled)"' <<<"$c")" "all but the last + end switches a maximum superseded" \
        "$(pyb "$(jq -r .scheduled <<<"$c") - $(jq -r .done <<<"$c") - $(jq -r '.outcomes["cancelled:superseded"] // 0' <<<"$c") <= 1")"
    check "$n drops" "$(jq -r .drops <<<"$c")" "0" "$(pyb "$(jq -r .drops <<<"$c") == 0")"
    check "$n micro_gaps" "$(jq -r .micro_gaps <<<"$c")" "0" "$(pyb "$(jq -r .micro_gaps <<<"$c") == 0")"
    check "$n seams" "$(jq -r '"\(.seams) runs, \(.seam_frames) frames"' <<<"$c")" "0" "$(pyb "$(jq -r .seams <<<"$c") == 0")"
    note "$n: analysed $(jq -r .analysed <<<"$c")/$(jq -r .done <<<"$c"), skipped $(jq -c .skipped <<<"$c"), dirs $(jq -c .dirs <<<"$c"), reasons $(jq -c .reasons <<<"$c"), unmeasured $(jq -r .unmeasured <<<"$c"), fit_insufficient $(jq -r .fit_insufficient <<<"$c")"
    if [[ $method == full-live && $(jq -r .align_end_n <<<"$c") -gt 0 ]]; then
        local m
        m=$(jq -r .handoff_vs_a_end_pred_max_ms <<<"$c")
        check "$n handoff vs A's end" "$m ms (p95 $(jq -r .handoff_vs_a_end_pred_p95_ms <<<"$c"), n $(jq -r .align_end_n <<<"$c"))" "≤ $FRAME_MS ms" "$(pyb "$m <= $FRAME_MS")"
        local lo hi
        lo=$(jq -r .handoff_vs_a_last_frame_min_ms <<<"$c"); hi=$(jq -r .handoff_vs_a_last_frame_max_ms <<<"$c")
        check "$n handoff vs the end of A's last frame" "$lo … $hi ms (n $(jq -r .handoff_vs_a_ended_n <<<"$c"))" \
            "$HANDOFF_CUT_MS … +$HANDOFF_HOLD_MS ms (never cut, held ≤ one output frame)" "$(pyb "$lo >= $HANDOFF_CUT_MS and $hi <= $HANDOFF_HOLD_MS")"
    fi
    # A B not ready by the planned start (2026-11-11: the 3840×1080 Kimi scene takes ~2.5 s to build, the scenes
    # cell gives it ~2 s) is not a precision sample: by design (docs/player/modules/transitions.md § Align) its effect starts as B
    # becomes ready and A holds its last frame for the difference — checked as that.
    if [[ $method == full-live && $(jq -r '.b_late_n // 0' <<<"$c") -gt 0 ]]; then
        local wlo whi
        wlo=$(jq -r .b_late_start_after_ready_min_ms <<<"$c"); whi=$(jq -r .b_late_start_after_ready_max_ms <<<"$c")
        check "$n late B: the effect starts as B becomes ready" \
            "$(jq -r .b_late_n <<<"$c") late (≤ $(jq -r .b_late_max_ms <<<"$c") ms), started $wlo … $whi ms after B's ready" \
            "0 … $B_LATE_START_MS ms" "$(pyb "$wlo >= -1 and $whi <= $B_LATE_START_MS")"
    fi
}
# The user's own switches (switch-over checklist, design §10 "manual next/prev, random, next pressed mid-transition"):
# a program that never switches by itself (a 1 h timer) driven by program.next / prev / random, and every 5th switch a
# second next 0.4 s into the effect (it supersedes the first mid-transition). Same detector + seam checks as a cell.
dropout_manual_cell() { # <method> <items json>
    local method=$1 items=$2 t0 t1 c i act acts=(program.next program.prev program.random program.next)
    serve_ready_for_cell
    t0=$(now)
    prog_create "$(jq -nc --argjson it "$items" --arg m "$method" --argjson t "{$FADE}" \
        '{items:$it, mode:"timer", interval_ms:3600000, transition:($t + {method:$m})}')"
    sleep 4
    say "cell manual × $method: $SWITCHES user switches (~$((SWITCHES * 4)) s)"
    for ((i = 0; i < SWITCHES; i++)); do
        act=${acts[$((i % 4))]}
        ctl "$act" '{"id":"prog:main"}' >/dev/null || note "manual × $method: $act failed at $i"
        if ((i % 5 == 4)); then
            sleep 0.4
            ctl program.next '{"id":"prog:main"}' >/dev/null || note "manual × $method: the mid-effect next failed at $i"
        fi
        sleep 3.6
    done
    t1=$(now)
    ctl destroy '{"id":"prog:main"}' >/dev/null
    sleep 6
    c=$(report dropout "$(evdir)" "$t0" "$t1" manual "$method" "$RESULTS/dropout-records.jsonl")
    echo "$c" >>"$RESULTS/dropout-cells.jsonl"
    local n="manual × $method"
    check "$n commits" "$(jq -r .commits <<<"$c")" "≥ $SWITCHES" "$(pyb "$(jq -r .commits <<<"$c") >= $SWITCHES")" "$c"
    check "$n none failed" "$(jq -c .outcomes <<<"$c")" "no failed / none" "$(jq -r 'if ((.outcomes.failed // 0) + (.outcomes.none // 0)) <= 1 then 1 else 0 end' <<<"$c")"
    check "$n drops" "$(jq -r .drops <<<"$c")" "0" "$(pyb "$(jq -r .drops <<<"$c") == 0")"
    check "$n micro_gaps" "$(jq -r .micro_gaps <<<"$c")" "0" "$(pyb "$(jq -r .micro_gaps <<<"$c") == 0")"
    check "$n seams" "$(jq -r '"\(.seams) runs, \(.seam_frames) frames"' <<<"$c")" "0" "$(pyb "$(jq -r .seams <<<"$c") == 0")"
    note "$n: analysed $(jq -r .analysed <<<"$c")/$(jq -r .done <<<"$c"), skipped $(jq -c .skipped <<<"$c"), dirs $(jq -c .dirs <<<"$c"), reasons $(jq -c .reasons <<<"$c"), unmeasured $(jq -r .unmeasured <<<"$c"), fit_insufficient $(jq -r .fit_insufficient <<<"$c")"
}
serve_ready_for_cell() { kill -0 "${SERVE_PID:-0}" 2>/dev/null || serve_up ${P3_SERVE_ARGS---debug}; }
step_dropout() {
    step_begin dropout
    : >"$RESULTS/dropout-records.jsonl"
    : >"$RESULTS/dropout-cells.jsonl"
    serve_up ${P3_SERVE_ARGS---debug}
    local t1 t2 t3 e1 e2 e3 m1 m2 m3 s1 cell method
    t1=$(mk_clip tone30a testsrc2 30 30 330 640x360); t2=$(mk_clip tone30b testsrc 30 30 440 640x360); t3=$(mk_clip tone30c smptebars 30 30 550 640x360)
    e1=$(mk_clip tone4a testsrc2 30 4 330 640x360); e2=$(mk_clip tone4b testsrc 30 4 440 640x360); e3=$(mk_clip tone4c smptebars 30 4 550 640x360)
    m1=$(mk_clip tone10a testsrc2 30 10 330 640x360); m2=$(mk_clip tone10b testsrc 30 10 440 640x360); m3=$(mk_clip tone10c smptebars 30 10 550 640x360)
    local rec_pid=
    if [[ -n ${P3_RECORD:-} ]]; then # an independent recording of the private sink (a micro-gap: real or the meter's?)
        env "${PW_ENV[@]}" pw-record --target hermetic-sink -P '{ stream.capture.sink = true }' --rate 48000 --channels 2 --format f32 "$P3_RECORD" &
        rec_pid=$!
    fi
    IFS=, read -ra cells <<<"$CELLS"
    IFS=, read -ra meths <<<"$METHODS"
    for cell in "${cells[@]}"; do
        for method in "${meths[@]}"; do
            case $cell in
                timer) dropout_cell timer "$method" "{\"items\":$(items_json "$t1" "$t2" "$t3"),\"mode\":\"timer\",\"interval_ms\":6000}" 6 ;;
                onend) dropout_cell onend "$method" "{\"items\":$(items_json "$e1" "$e2" "$e3"),\"mode\":\"on_end\",\"interval_ms\":0}" 4 ;;
                onendmax) dropout_cell onendmax "$method" "{\"items\":$(items_json "$m1" "$m2" "$m3"),\"mode\":\"on_end\",\"interval_ms\":0,\"max_ms\":3000}" 4 ;;
                manual) dropout_manual_cell "$method" "[$(scene_item "$SC_KIMI"),{\"path\":\"$t1\"},$(scene_item "$SC_EMILIA"),{\"path\":\"$t2\"},{\"path\":\"$(mk_png manual-still 'color=c=teal:size=1920x1080')\"},{\"path\":\"$t3\"}]" ;;
                scenes) dropout_cell scenes "$method" "{\"items\":[$(scene_item "$SC_KIMI"),{\"path\":\"$e1\"},$(scene_item "$SC_EMILIA"),{\"path\":\"$e2\"}],\"mode\":\"on_end\",\"interval_ms\":0,\"separate_scenes\":true,\"scenes_after_ms\":6000}" 6 ;;
                *) die "unknown cell $cell" ;;
            esac
        done
    done
    [[ -n $rec_pid ]] && { kill -INT "$rec_pid"; wait "$rec_pid" 2>/dev/null; }
    serve_down
    step_end
}

# ------------------------------------------------------------------ step 2 — the app closed
step_appclosed() {
    step_begin appclosed
    local c1 c2 c3 img
    c1=$(mk_clip tone40a testsrc2 30 40 330 640x360); c2=$(mk_clip tone40b testsrc 30 40 440 640x360); c3=$(mk_clip tone40c smptebars 30 40 550 640x360)
    img=$(mk_png still1 'color=c=teal:size=1920x1080')
    be_up
    be_rotation false 30
    be_play '{"Order":0}' "$c1" "$c2" "$c3" "$img"
    be_down
    local left t0 t1 s want
    left=$(be_procs | wc -l)
    check "no liascape-backend after the app closes" "$left" "0" "$(pyb "$left == 0")"
    t0=$(now)
    say "the app is closed; rotating for $APP_MIN min"
    sleep $((APP_MIN * 60))
    t1=$(now)
    s=$(report switches "$(evdir)" "$t0" "$t1")
    echo "$s" >"$RESULTS/appclosed-switches.json"
    want=$(python3 -c "print(int(($t1-$t0)//31))") # a timer counts from the commit
    check "every expected switch present" "$(jq -r .currents <<<"$s")" "≥ $want (window $(jq -r .window_s <<<"$s") s)" "$(pyb "$(jq -r .currents <<<"$s") >= $want")"
    check "spacing" "$(jq -c .spacing_ms <<<"$s")" "min ≥ 29 s, max ≤ 31 s" "$(pyb "$(jq -r '.spacing_ms.min // 0' <<<"$s") >= 29000 and $(jq -r '.spacing_ms.max // 99999' <<<"$s") <= 31000")"
    check "every switch from the program" "$(jq -c .origins <<<"$s")" "only $ROT_ORIGIN" "$(jq -e --arg o "$ROT_ORIGIN" '.origins | keys == [$o]' <<<"$s" >/dev/null && echo 1 || echo 0)"
    check "no failed switch" "$(jq -r '"\(.failed) failed, \(.program_failed) program.failed"' <<<"$s")" "0" "$(pyb "$(jq -r '.failed + .program_failed' <<<"$s") == 0")"
    check "no player restart" "$(jq -r .player_started <<<"$s")" "0" "$(pyb "$(jq -r .player_started <<<"$s") == 0")"
    left=$(be_procs | wc -l)
    check "still no backend after the rotation" "$left" "0" "$(pyb "$left == 0")"
    # CLI keybinds with no app: each runs in a one-shot CLI and reaches the program
    local k r ts
    for k in "next:next" "previous:prev" "random:random"; do
        ts=$(now)
        be_cli "${k%%:*}"
        r=$(wait_commits "$ts" 1 8 "${k##*:}" && echo 1 || echo 0)
        check "keybind ${k%%:*}" "$(commits_since "$ts" "${k##*:}") commit(s), reason ${k##*:}" "≥ 1 within 8 s" "$r"
        sleep 3
    done
    be_cli toggle-pause
    sleep 0.5
    r=$(ctl get '{"path":"player.paused"}' | jq -r .value)
    check "keybind toggle-pause" "paused $r" "true" "$(b01 "$r")"
    be_cli toggle-pause
    sleep 0.5
    r=$(ctl get '{"path":"player.paused"}' | jq -r .value)
    check "keybind toggle-pause again" "paused $r" "false" "$([[ $r == false ]] && echo 1 || echo 0)"
    local g0 g1
    g0=$(pget defaults | jq -r '."gain.user" // 0')
    be_cli volume down
    sleep 1
    g1=$(pget defaults | jq -r '."gain.user" // 0')
    check "keybind volume down" "gain.user $g0 → $g1 dB" "lower" "$(pyb "$g1 < $g0")"
    left=$(be_procs | wc -l)
    check "the keybind CLIs exited" "$left" "0" "$(pyb "$left == 0")"
    quit_player
    step_end
}

# ------------------------------------------------------------------ step 3 — crash and restore
crash_once() { # <label> <jq predicate on the program, the moment to kill>
    local label=$1 pred=$2 before pid t0 after np i ai ap
    wait_prog "$pred" 40 || { check "$label reached its moment" "$(prog)" "$pred" 0; return; }
    before=$(prog)
    pid=$(ctl hello | jq -r .pid)
    assert_mine "$pid"
    t0=$(now)
    kill -SEGV "$pid"
    np=
    for ((i = 0; i < 200; i++)); do
        np=$(ctl hello 2>/dev/null | jq -r '.pid // empty')
        [[ -n $np && $np != "$pid" ]] && break
        np=
        sleep 0.1
    done
    [[ -n $np ]] || { check "$label came back" "no" "≤ 20 s" 0; return; }
    PLAYER_PID=$np
    wait_prog '.phase | IN("playing", "holding", "armed", "switching")' 10
    sleep 0.5
    after=$(prog)
    ai=$(jq -r .index <<<"$after"); ap=$(jq -r .path <<<"$after")
    check "$label back at its item" "index $(jq -r .index <<<"$before") → $ai" "same item" \
        "$([[ $ap == "$(jq -r .path <<<"$before")" ]] && echo 1 || echo 0)" \
        "$(jq -nc --argjson b "$before" --argjson a "$after" '{before:$b, after:$a}')"
    note "$label: compositor $pid → $np in $(python3 -c "print(round($(now)-$t0,2))") s; phase $(jq -r .phase <<<"$before") → $(jq -r .phase <<<"$after"); played $(jq -r .played_ms <<<"$before") → $(jq -r .played_ms <<<"$after") ms; remaining $(jq -r .remaining_ms <<<"$before") → $(jq -r .remaining_ms <<<"$after") ms"
    CRASH_T0=$t0
}
step_crash() {
    step_begin crash
    local c=() n
    for n in 1 2 3 4; do c+=("$(mk_clip tone15-$n testsrc2 30 15 $((n * 110 + 220)) 640x360)"); done
    be_up
    be_rotation false 8
    be_play '{"Order":0}' "${c[@]}"
    local i
    for i in 1 2 3; do
        crash_once "timer crash $i" '.phase == "playing" and .remaining_ms > 3000 and .remaining_ms < 6000 and (.played_ms > 1500)'
        # the rotation goes on: the next commit is the timer's, not a re-play
        wait_commits "$CRASH_T0" 1 15 timer
        check "timer crash $i: rotation continues" "$(commits_since "$CRASH_T0" timer) timer commit(s), $(commits_since "$CRASH_T0" play) play" "≥ 1, 0 play" \
            "$(pyb "$(commits_since "$CRASH_T0" timer) >= 1 and $(commits_since "$CRASH_T0" play) == 0")"
        sleep 25 # < 4 restarts a minute (the supervisor's 4th comes back without programs)
    done
    be_rotation true 0
    be_play '{"Order":0}' "${c[@]}"
    local aligned
    for i in 1 2; do
        crash_once "armed crash $i" '.phase == "armed" and (.played_ms > 1500) and (.played_ms < 10000)'
        wait_prog '.phase == "armed"' 10 && aligned=1 || aligned=0
        check "armed crash $i: re-armed by itself" "$(prog | jq -r .phase)" "armed" "$aligned"
        wait_commits "$CRASH_T0" 1 20 end
        local nowc
        nowc=$(report events "$(evdir)" "$CRASH_T0" 99999999999 transition.scheduled | jq '[.[] | select(.kind == "transition.scheduled" and .align == "now")] | length')
        check "armed crash $i: 0 align:now after the restart" "$nowc" "0" "$(pyb "$nowc == 0")"
        check "armed crash $i: ended at its clip's end" "$(commits_since "$CRASH_T0" end) end commit(s)" "≥ 1" "$(pyb "$(commits_since "$CRASH_T0" end) >= 1")"
        sleep 25
    done
    # `ctl quit` + `liascape restore`, per start mode (§ Playlist start's row "boot")
    local mode order cur_i cur_p ts first fi fp fr
    for mode in "start_over:0:sequential" "start_over:1:shuffle" "resume:0:sequential"; do
        IFS=: read -r sm order nm <<<"$mode"
        be_up
        be_rotation false 8 "$sm"
        be_play "{\"Order\":$order}" "${c[@]}"
        ts=$(now)
        wait_commits "$ts" 2 30 timer
        wait_prog '.phase == "playing" and (.played_ms > 2000) and (.remaining_ms > 2000)' 15
        cur_i=$(prog | jq -r .index); cur_p=$(prog | jq -r .path)
        local pos0
        pos0=$(ctl get "{\"path\":\"$(ctl get "{\"path\":\"lay:$OUT_B:main.content\"}" | jq -r .value).time_pos\"}" | jq -r .value)
        be_down
        quit_player
        ts=$(now)
        be_cli restore
        the_player_pid || { check "$sm $nm: restore answers" no "≤ 20 s" 0; continue; }
        first=$(wait_ev program.current "$ts" 10)
        fi=$(jq -r '.index // empty' <<<"$first"); fp=$(jq -r '.path // empty' <<<"$first"); fr=$(jq -r '.resumed // false' <<<"$first")
        sleep 1
        local shown
        shown=$(shown_path "$OUT_B")
        case $sm:$nm in
            start_over:sequential)
                check "restore start over, sequential" "index $fi (was $cur_i)" "item 1 (index 0)" "$(pyb "'$fi' == '0' and '$fp' == '${c[0]}' and '$shown' == '${c[0]}'")" ;;
            start_over:shuffle)
                check "restore start over, shuffle" "$(basename "$fp") (was $(basename "$cur_p"))" "a fresh shuffle: first ≠ the last played" "$(pyb "'$fp' != '$cur_p' and '$shown' == '$fp'")" ;;
            resume:*)
                local pos1 d
                pos1=$(ctl get "{\"path\":\"$(ctl get "{\"path\":\"lay:$OUT_B:main.content\"}" | jq -r .value).time_pos\"}" | jq -r .value)
                d=$(python3 -c "print(round(abs($pos1-$pos0),2))")
                check "restore resume" "$(basename "$fp") resumed=$fr, position $pos0 → $pos1" "exact item, resumed, position within 5 s" "$(pyb "'$fp' == '$cur_p' and '$fr' == 'true' and $d <= 5")" ;;
        esac
        sc=$(report events "$(evdir)" "$ts" "$(now)" source.created | jq --arg p "$cur_p" '[.[] | select(.path == $p)] | length')
        [[ $sm == start_over ]] && [[ $fp != "$cur_p" ]] && check "restore $sm $nm: the old item never shown" "$sc source(s) of it" "0" "$(pyb "$sc == 0")"
        quit_player
    done
    step_end
}

# ------------------------------------------------------------------ step 4 — cover
cover_case() { # <label> <how> : both outputs covered → held, frozen; uncovered → resumed
    local label=$1 how=$2 ts tm e lat frozen c1 g1 t0c rem0 rem1 r
    ts=$(now)
    open_window "lia-cov-a$how" "$(active_ws "$OUT_A")" "$how" >/dev/null
    open_window "lia-cov-b$how" "$(active_ws "$OUT_B")" "$how" >/dev/null
    tm=$(now)
    e=$(wait_ev cover.engaged "$ts" 5) || { check "$label: engaged" no "≤ 5 s" 0 "$(jq -nc --argjson c "$(ctl probe '{"name":"cover"}')" --argjson w "$(hyprctl clients -j | jq -c '[.[] | select(.class | startswith("lia-cov")) | {class, fullscreen, mapped, ws: .workspace.id}]')" '{cover:$c, windows:$w}')"; close_windows; return; }
    lat=$(python3 -c "
from datetime import datetime, timezone
s = '$(jq -r .t_wall <<<"$e")'.rstrip('Z'); h, _, f = s.partition('.')
t = datetime.strptime(h, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp() + float('0.' + (f or '0'))
print(round((t - $tm) * 1000))")
    check "$label: paused after both windows mapped" "$lat ms" "≤ 450 ms" "$(pyb "$lat <= 450")" "$e"
    frozen=$(source_paused_frozen)
    check "$label: every source paused, time_pos still" "$frozen" "true" "$(b01 "$frozen")"
    c1=$(cpu_pct "$PLAYER_PID" 5)
    g1=$(gpu_sm "$PLAYER_PID" 5)
    check "$label: compositor CPU drops" "$COVER_CPU0 % → $c1 %" "lower" "$(pyb "$c1 < $COVER_CPU0")"
    note "$label: compositor GPU SM $COVER_GPU0 % → $g1 %"
    t0c=$(now)
    rem0=$(prog | jq -r .remaining_ms)
    sleep 12 # longer than the 8 s interval
    rem1=$(prog | jq -r .remaining_ms)
    r=$(commits_since "$t0c")
    check "$label: the rotation does not advance" "$r commits, remaining $rem0 → $rem1 ms" "0, unchanged" "$(pyb "$r == 0 and abs($rem0 - $rem1) < 50")"
    ts=$(now)
    close_windows
    e=$(wait_ev cover.released "$ts" 5) && r=1 || r=0
    check "$label: released on uncover" "$(jq -r '.held_ms // "no"' <<<"${e:-{\}}")" "released" "$r"
    sleep 0.5
    r=$(source_playing)
    check "$label: plays again" "$r" "true" "$(b01 "$r")"
    wait_commits "$ts" 1 12 timer && r=1 || r=0
    check "$label: the rotation resumes" "$(commits_since "$ts" timer) commit(s)" "≥ 1 within 12 s" "$r"
}
step_cover() {
    step_begin cover
    save_cursor
    COVER_CLIP=$(mk_clip cover testsrc2 30 20 0 640x360)
    local c1 c2 c3
    c1=$(mk_clip tone30a testsrc2 30 30 330 640x360); c2=$(mk_clip tone30b testsrc 30 30 440 640x360); c3=$(mk_clip tone30c smptebars 30 30 550 640x360)
    be_up
    be_rotation false 8
    be_play '{"Order":0}' "$c1" "$c2" "$c3"
    sleep 2
    local mode
    mode=$(ctl get '{"path":"player.pause_when_covered"}' | jq -r .value)
    check "default settings (no PauseWhenCovered key)" "$mode" "maximized (O1)" "$([[ $mode == maximized ]] && echo 1 || echo 0)"
    COVER_CPU0=$(cpu_pct "$PLAYER_PID" 5)
    COVER_GPU0=$(gpu_sm "$PLAYER_PID" 5)
    cover_case "kitty fullscreen" kitty-fs
    cover_case "mpv fullscreen" mpv-fs
    cover_case "kitty maximized (default)" kitty-max
    # one output covered: keeps playing
    local ts h r
    ts=$(now)
    open_window lia-cov-one "$(active_ws "$OUT_A")" kitty-fs >/dev/null
    sleep 1.5
    h=$(ctl get '{"path":"player.cover_hold_active"}' | jq -r .value)
    r=$(source_playing)
    check "one output covered: keeps playing" "hold $h, playing $r" "false, true" "$([[ $h == false && $r == true ]] && echo 1 || echo 0)"
    wait_commits "$ts" 1 12 timer && r=1 || r=0
    check "one output covered: keeps rotating" "$(commits_since "$ts" timer) commit(s)" "≥ 1 within 12 s" "$r"
    close_windows
    restore_cursor
    be_down
    quit_player
    step_end
}

# ------------------------------------------------------------------ step 4b — no monitor
step_nomonitor() {
    step_begin nomonitor
    grep -qF "$MON_PRIMARY_DESC" "$HOME/.config/hypr/Kryxzort/System.lua" 2>/dev/null \
        || grep -rqF "EBV4L02353SL0" "$HOME/.config/hypr/Kryxzort/" || die "the monitor lines changed in System.lua"
    save_cursor
    local c1 c2 c3 m0 w0 ts s n
    c1=$(mk_clip tone30a testsrc2 30 30 330 640x360); c2=$(mk_clip tone30b testsrc 30 30 440 640x360); c3=$(mk_clip tone30c smptebars 30 30 550 640x360)
    m0=$(mon_state); w0=$(ws_state)
    be_up
    be_rotation false 6
    be_play '{"Order":0}' "$c1" "$c2" "$c3"
    sleep 3
    # keep rotating invisibly (the default)
    mon_flag 120
    watchdog_start
    mon_disable "$OUT_A"; sleep 1; mon_disable "$OUT_B"
    wait_prog '.phase == "parked"' 15 && n=1 || n=0
    check "both outputs off: parked" "$(prog | jq -r .phase)" "parked" "$n"
    ts=$(now)
    sleep 40
    s=$(report switches "$(evdir)" "$ts" "$(now)")
    echo "$s" >"$RESULTS/nomonitor-rotate.json"
    check "keeps rotating invisibly" "$(jq -r .parked <<<"$s") parked switches in 40 s" "5–7 (one per 6 s interval)" "$(pyb "5 <= $(jq -r .parked <<<"$s") <= 7")"
    local target
    target=$(prog | jq -r .path)
    ts=$(now)
    mon_enable_all
    mon_flag 120
    wait_prog '.phase != "parked"' 15 && n=1 || n=0
    sleep 1.5
    check "re-enabled: left parked" "$(prog | jq -r .phase)" "not parked" "$n"
    local shown ps
    shown=$(shown_path "$OUT_B"); ps=$(prog | jq -r .path)
    check "the current target shows on re-enable" "$(basename "$shown")" "the program's item" "$([[ $shown == "$ps" ]] && echo 1 || echo 0)"
    note "the target at re-enable was $(basename "$target"), the program is on $(basename "$ps") 1.5 s later"
    # Expert "Hold until a monitor returns"
    be_setting RotateWhileParked false
    sleep 1
    n=$(pget while_parked | jq -r .)
    check "Hold setting reached the program" "$n" "hold" "$([[ $n == hold ]] && echo 1 || echo 0)"
    wait_prog '.phase == "playing" and .remaining_ms > 3000' 10
    local p0
    mon_flag 120
    mon_disable "$OUT_A"; sleep 1; mon_disable "$OUT_B"
    wait_prog '.phase == "parked"' 15
    p0=$(prog | jq -r .path)
    ts=$(now)
    sleep 25
    s=$(commits_since "$ts")
    check "Hold: nothing switches" "$s commits in 25 s" "0" "$(pyb "$s == 0")"
    ts=$(now)
    mon_enable_all
    rm -f "$MON_FLAG"
    wait_prog '.phase != "parked"' 15
    sleep 1
    shown=$(shown_path "$OUT_B")
    check "Hold: the same item resumes" "$(basename "$shown")" "$(basename "$p0")" "$([[ $shown == "$p0" || $(commits_since "$ts") -gt 0 ]] && echo 1 || echo 0)"
    wait_commits "$ts" 1 12 timer && n=1 || n=0
    check "Hold: rotation resumes" "$(commits_since "$ts" timer) commit(s)" "≥ 1 within 12 s" "$n"
    sleep 2
    restore_cursor
    be_down
    quit_player
    local m1 w1
    m1=$(mon_state); w1=$(ws_state)
    check "monitors as before" "$m1" "$m0" "$([[ $m1 == "$m0" ]] && echo 1 || echo 0)"
    check "workspaces as before" "$w1" "$w0" "$([[ $w1 == "$w0" ]] && echo 1 || echo 0)"
    step_end
}

# ------------------------------------------------------------------ step 5 — soak
step_soak() {
    step_begin soak
    local c1 c2 c3 i1 i2 samples=$RESULTS/soak-samples.jsonl
    c1=$(mk_clip tone40a testsrc2 30 40 330 640x360); c2=$(mk_clip tone40b testsrc 30 40 440 640x360); c3=$(mk_clip tone40c smptebars 30 40 550 640x360)
    i1=$(mk_png still1 'color=c=teal:size=1920x1080'); i2=$(mk_png still2 'color=c=maroon:size=1920x1080')
    : >"$samples"
    serve_up
    local t0 end i m=(full-live reveal frozen) nsw=0
    t0=$(now)
    end=$(($(date +%s) + SOAK_MIN * 60))
    prog_create "{\"items\":[{\"path\":\"$c1\"},$(scene_item "$SC_EMILIA"),{\"path\":\"$i1\"},{\"path\":\"$c2\"},$(scene_item "$SC_BUNK"),{\"path\":\"$i2\"},{\"path\":\"$c3\"}],\"mode\":\"timer\",\"interval_ms\":30000,\"transition\":{$FADE,\"method\":\"full-live\"}}"
    while (($(date +%s) < end)); do
        for i in 1 2; do
            sleep 30
            nsw=$((nsw + 1))
            ctl set "$(jq -nc --argjson t "{$FADE}" --arg m "${m[$((nsw % 3))]}" '{path:"prog:main.transition", value:($t + {method:$m})}')" >/dev/null || note "method set failed at $nsw"
        done
        local rss v w h
        rss=$(awk '/VmRSS/ {print $2/1024}' "/proc/$PLAYER_PID/status" 2>/dev/null || echo null)
        v=$(smi_vram)
        w=$(ctl probe '{"name":"workers"}' | jq -c '[.workers[] | {pid, state: (.state // .phase // null)}]')
        h=$(ctl probe '{"name":"programs"}' | jq '[.programs[0].history // [] | length][0]')
        jq -nc --argjson t "$(($(date +%s) - ${t0%.*}))" --argjson rss "${rss:-null}" --argjson w "$w" --argjson h "${h:-0}" --argjson v "$v" --arg p "$PLAYER_PID" \
            '{t:$t, rss_mib:$rss, workers:($w|length), worker_list:$w, history:$h, vram_comp:($v[$p] // null),
              vram_total:(([$v[$p] // 0] + [$w[] | $v[.pid|tostring] // 0]) | add)}' >>"$samples"
    done
    local t1 s r
    t1=$(now)
    s=$(report switches "$(evdir)" "$t0" "$t1")
    echo "$s" | jq 'del(.paths, .current_events)' >"$RESULTS/soak-switches.json"
    r=$(python3 - "$samples" <<'EOF'
import json, sys, statistics as st
S = [json.loads(l) for l in open(sys.argv[1])]
warm = [s for s in S if s["t"] >= 900] or S  # 15 min of warm-up (caches, the first of each item)
def slope(xs, ys):
    mx, my = st.mean(xs), st.mean(ys)
    den = sum((x - mx) ** 2 for x in xs) or 1
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
tail = max(1, min(10, len(warm) // 3))
v = [s["vram_total"] for s in warm]
print(json.dumps({
    "samples": len(S), "rss_first": warm[0]["rss_mib"], "rss_last": warm[-1]["rss_mib"],
    "rss_slope_mib_min": round(slope([s["t"] / 60 for s in warm], [s["rss_mib"] for s in warm]), 3),
    "workers_max": max(s["workers"] for s in S), "history_max": max(s["history"] for s in S),
    "vram_head": st.median(v[:tail]), "vram_tail": st.median(v[-tail:]), "vram_min": min(v), "vram_max": max(v),
}))
EOF
)
    echo "$r" >"$RESULTS/soak-summary.json"
    check "compositor RSS slope" "$(jq -r .rss_slope_mib_min <<<"$r") MiB/min ($(jq -r .rss_first <<<"$r") → $(jq -r .rss_last <<<"$r") MiB)" "≤ 0.5" "$(pyb "$(jq -r .rss_slope_mib_min <<<"$r") <= 0.5")"
    check "worker count" "max $(jq -r .workers_max <<<"$r")" "≤ 2 + dying (≤ 3)" "$(pyb "$(jq -r .workers_max <<<"$r") <= 3")"
    check "VRAM flat" "median $(jq -r .vram_head <<<"$r") → $(jq -r .vram_tail <<<"$r") MiB" "± 10 %" "$(pyb "abs($(jq -r .vram_tail <<<"$r") - $(jq -r .vram_head <<<"$r")) <= 0.1 * max(1, $(jq -r .vram_head <<<"$r"))")"
    check "programs probe bounded" "history max $(jq -r .history_max <<<"$r")" "≤ 100" "$(pyb "$(jq -r .history_max <<<"$r") <= 100")"
    local want
    want=$(python3 -c "print(int(($t1-$t0)//31))")
    check "the rotation kept going" "$(jq -r .currents <<<"$s") commits, $(jq -r .failed <<<"$s") failed, $(jq -r .program_failed <<<"$s") program.failed, $(jq -r .player_started <<<"$s") restarts" "≥ $want, 0, 0, 0" \
        "$(pyb "$(jq -r .currents <<<"$s") >= $want and $(jq -r '.failed + .program_failed + .player_started' <<<"$s") == 0")"
    local seams
    seams=$(report events "$(evdir)" "$t0" "$t1" output.seam | jq '[.[] | select(.kind == "output.seam")] | length')
    check "seams (frames composed with a hole)" "$seams runs" "0" "$(pyb "${seams:-1} == 0")"
    serve_down
    step_end
}

# ------------------------------------------------------------------ step 6.2 / 6.3 — suspend, a VT switch (owner's checklist)
# A 30 s timer rotation with the app closed, then the machine is taken away mid-interval and given back. The player's
# clock (and so `at_ms`) is CLOCK_MONOTONIC: it stops while suspended, so every spacing in `at_ms` stays ~30 s — a
# catch-up switch on wake would show as a short one (plan Review Focus 5). A VT switch doesn't stop the clock; the
# rotation just has to carry on with no failure and no restart.
sleep_offset() { python3 -c "import time; print(time.clock_gettime(time.CLOCK_BOOTTIME) - time.clock_gettime(time.CLOCK_MONOTONIC))"; }
away_rotation_up() { # a 30 s timer rotation, the app closed, one switch seen, ~20 s left in the interval
    local c=() n
    for n in 1 2 3; do c+=("$(mk_clip tone40$1-$n testsrc2 30 40 $((n * 110 + 220)) 640x360)"); done
    be_up
    be_rotation false 30
    be_play '{"Order":0}' "${c[@]}"
    be_down
    AWAY_T0=$(now)
    wait_commits "$AWAY_T0" 1 40 || note "no switch seen before taking the machine away"
    sleep 10
    AWAY_PID=$(ctl hello | jq -r .pid)
    note "before: $(prog | jq -c '{index, phase, remaining_ms}')"
}
away_rotation_checks() { # <label> <epoch given back> <seconds away from the player clock>
    local s pid
    sleep 45 # the interval's rest + one more switch
    s=$(report switches "$(evdir)" "$AWAY_T0" "$(now)")
    echo "$s" >"$RESULTS/$STEP-switches.json"
    check "$1: a switch after it" "$(commits_since "$2") commit(s)" "≥ 1 within 45 s" "$(pyb "$(commits_since "$2") >= 1")"
    check "$1: spacing on the player clock" "$(jq -c .spacing_ms <<<"$s")" "min ≥ 29 s, max ≤ 31 s (no catch-up)" \
        "$(pyb "$(jq -r '.spacing_ms.min // 0' <<<"$s") >= 29000 and $(jq -r '.spacing_ms.max // 99999' <<<"$s") <= 31000")"
    check "$1: every switch from the program" "$(jq -c .origins <<<"$s")" "only $ROT_ORIGIN" "$(jq -e --arg o "$ROT_ORIGIN" '.origins | keys == [$o]' <<<"$s" >/dev/null && echo 1 || echo 0)"
    check "$1: no failed switch" "$(jq -r '"\(.failed) failed, \(.program_failed) program.failed"' <<<"$s")" "0" "$(pyb "$(jq -r '.failed + .program_failed' <<<"$s") == 0")"
    pid=$(ctl hello | jq -r '.pid // empty')
    check "$1: same player, no restart" "pid $AWAY_PID → ${pid:-none}, $(jq -r .player_started <<<"$s") started" "same, 0" \
        "$([[ $pid == "$AWAY_PID" && $(jq -r .player_started <<<"$s") == 0 ]] && echo 1 || echo 0)"
    check "$1: the program plays (outputs back, not parked)" "$(prog | jq -r .phase)" "playing / holding / armed / switching" \
        "$(prog | jq -e '.phase | IN("playing", "holding", "armed", "switching")' >/dev/null && echo 1 || echo 0)"
    note "$1: away ${3} s; $(jq -c '{currents, reasons, warn}' <<<"$s")"
}
step_suspend() {
    step_begin suspend
    away_rotation_up s
    local off0 off1 i tr slept
    off0=$(sleep_offset)
    sudo -n rtcwake -m no -s "$SUSPEND_S" >/dev/null || die "rtcwake: no wake alarm, not suspending"
    say "suspending for ${SUSPEND_S} s (rtcwake alarm set)"
    systemctl suspend || die "systemctl suspend"
    for ((i = 0; i < SUSPEND_S + 180; i++)); do # resumed once CLOCK_BOOTTIME − CLOCK_MONOTONIC has grown
        sleep 1
        off1=$(sleep_offset)
        (($(pyb "$off1 - $off0 > 5"))) && break
    done
    tr=$(now)
    slept=$(python3 -c "print(round($off1 - $off0, 1))")
    check "the machine slept" "$slept s" "≥ 5 s" "$(pyb "$slept >= 5")"
    sleep 5 # outputs / GPU settle
    away_rotation_checks "resume" "$tr" "$slept"
    quit_player
    step_end
}
step_vt() {
    step_begin vt
    away_rotation_up v
    local vt0 t1
    vt0=$(sudo -n fgconsole) || die "fgconsole"
    # the way back never depends on this script: a detached root timer returns to the session's VT
    sudo -n systemd-run --quiet --on-active=$((VT_S + 20)) --timer-property=AccuracySec=1s chvt "$vt0" || die "no watchdog, not switching"
    say "VT $vt0 → $((vt0 + 2)) for ${VT_S} s"
    sudo -n chvt $((vt0 + 2)) || die "chvt"
    sleep "$VT_S"
    sudo -n chvt "$vt0"
    t1=$(now)
    check "back on the session's VT" "$(sudo -n fgconsole)" "$vt0" "$([[ $(sudo -n fgconsole) == "$vt0" ]] && echo 1 || echo 0)"
    sleep 3
    away_rotation_checks "VT switch" "$t1" "$VT_S"
    quit_player
    step_end
}

# ------------------------------------------------------------------ Phase 2 § 8 — a scene through VT switch / suspend
# A real scene (Kimi, sound) on DP-2 and a looping video on DP-1, then: a VT switch, a suspend, two suspends within
# a minute (the restart budget's edge). After each: never `source.broken`, both outputs present frames again, the
# scene's worker running + ready, at most one restart per suspend/VT, the video's player untouched (same pid).
scene_away_up() {
    local v
    v=$(mk_clip tone60v testsrc2 30 60 440 1280x720)
    serve_up
    ctl transition "$(jq -nc --arg p "$v" '{outputs:"out:DP-1", to:{path:$p, loop:true}}')" >/dev/null
    ctl transition "$(jq -nc --arg p "$SC_KIMI" '{outputs:"out:DP-2", to:{kind:"scene", path:$p}}')" >/dev/null
    sleep 12
    SA_PID=$(ctl hello | jq -r .pid)
    SA_RESTARTS=0
    note "before: $(scene_away_state)"
}
scene_away_state() {
    jq -nc --argjson w "$(ctl probe '{"name":"workers"}')" --argjson f "$(ctl probe '{"name":"frames"}')" \
        '{workers: [$w.workers[] | {state, ready, restarts_60s, total_restarts, context_losses, fps_actual}],
          fps: [$f.outputs[] | {name, fps: .all.fps}]}'
}
scene_away_suspend() { # <seconds>
    local off0 off1 i
    off0=$(sleep_offset)
    sudo -n rtcwake -m no -s "$1" >/dev/null || die "rtcwake: no wake alarm, not suspending"
    say "suspending for $1 s"
    systemctl suspend || die "systemctl suspend"
    for ((i = 0; i < $1 + 180; i++)); do
        sleep 1
        off1=$(sleep_offset)
        (($(pyb "$off1 - $off0 > 5"))) && break
    done
    note "slept $(python3 -c "print(round($off1 - $off0, 1))") s"
}
scene_away_checks() { # <label> <restarts allowed>
    local s i ok=0 broken pid total
    for ((i = 0; i < 20; i++)); do # ≤ 10 s for both outputs to present again and the scene to be ready
        sleep 0.5
        s=$(scene_away_state)
        jq -e '(.fps | all(.fps >= 20)) and (.workers | length == 1 and all(.state == "running" and .ready))' <<<"$s" >/dev/null && { ok=1; break; }
    done
    check "$1: both outputs present + the scene running" "$(jq -c . <<<"$s") after $(python3 -c "print(($i + 1) / 2)") s" "≤ 10 s" "$ok"
    broken=$(ctl logs '{"kind_prefix":"source.broken"}' | jq '.events | length')
    check "$1: never source.broken" "$broken" "0" "$(pyb "$broken == 0")"
    total=$(jq '[.workers[].total_restarts] | add // 0' <<<"$s")
    check "$1: scene restarts" "$((total - SA_RESTARTS))" "≤ $2" "$(pyb "$total - $SA_RESTARTS <= $2")"
    SA_RESTARTS=$total
    pid=$(ctl hello | jq -r '.pid // empty')
    check "$1: same compositor (the video untouched)" "pid $SA_PID → ${pid:-none}" "same" "$([[ $pid == "$SA_PID" ]] && echo 1 || echo 0)"
    note "$1: scene/worker events $(ctl logs '{"kind_prefix":"scene."}' | jq -c '[.events[-6:][] | .kind]') $(ctl logs '{"kind_prefix":"worker."}' | jq -c '[.events[-6:][] | .kind]')"
}
step_sceneaway() {
    step_begin sceneaway
    scene_away_up
    local vt0
    vt0=$(sudo -n fgconsole) || die "fgconsole"
    sudo -n systemd-run --quiet --on-active=$((VT_S + 20)) --timer-property=AccuracySec=1s chvt "$vt0" || die "no watchdog, not switching"
    say "VT $vt0 → $((vt0 + 2)) for ${VT_S} s"
    sudo -n chvt $((vt0 + 2)) || die "chvt"
    sleep "$VT_S"
    sudo -n chvt "$vt0"
    sleep 1
    scene_away_checks "VT switch" 1
    sleep 10
    scene_away_suspend 30
    scene_away_checks "suspend" 1
    sleep 10
    scene_away_suspend 20
    sleep 5
    scene_away_suspend 20
    scene_away_checks "two suspends within a minute" 2
    serve_down
    step_end
}
