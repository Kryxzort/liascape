# Steps of scenes.sh (sourced; see its header). Each step_<name> starts its own serve and leaves
# <results>/<name>.json. Bounds are the plan's (Task 14) unless a comment says otherwise.

step_explore() {
    step_begin explore
    serve_up "${EXPLORE_MODE:-wayland}"
    echo "EXPLORE RT=$RT PSTATE=$PSTATE PW=$PW_DIR SCRATCH=$SCRATCH" >&2
    sleep "${EXPLORE_S:-900}"
    step_end
}

SYN_FI='{"pattern":"frame_index","native":[1920,1080]}'

# ------------------------------------------------------------------ step 1 — outputs
# Synthetic + the three spike scenes on DP-1 and DP-2: grim pixels non-blank on the overlay
# layer; paced mean 6.9 ± 0.5 / 4.2 ± 0.5 ms at scene_fps 0; worker CPU < 5 %; compositor CPU
# ≤ +1 % per worker vs the video baseline; a cursor warp moves the synthetic pointer_dot; Bunk's
# bars move with a tone (played into the PRIVATE PipeWire — nothing reaches the speakers).
step_outputs() {
    step_begin outputs
    serve_up wayland
    local syn clip240 col v base_vid base_anim
    syn=$(mk_scene fi "$SYN_FI")
    clip240=$(mk_clip clip240 testsrc2 240 20 0 640x360)

    # Baselines (compositor CPU, 5 s): the plan's video baseline (a 240 fps clip on both outputs
    # → presents at each refresh, decoded in the compositor) and a decode-free one (a colour with
    # an opacity animation → the same presents, no media) — the scene's own transport cost is
    # read against the second.
    v=$(create_video "$clip240"); wait_ready "$v" || die "clip never ready"
    show $OUT_A "$v"; show $OUT_B "$v"
    sleep 1.5
    base_vid=$(cpu_pct "$PLAYER_PID" 5)
    col=$(create_color '[40,40,40]')
    show $OUT_A "$col"; show $OUT_B "$col"
    destroy "$v"
    ctl animate '{"path":"lay:*:main.opacity","from":1,"to":0.97,"duration_ms":9000}' >/dev/null
    sleep 1.5
    base_anim=$(cpu_pct "$PLAYER_PID" 5)
    sleep 2.6
    ctl set '{"path":"lay:*:main.opacity","value":1}' >/dev/null
    note "compositor CPU baselines: 240 fps clip on both outputs $base_vid %, colour + opacity animation $base_anim % (one core)"

    local name path id w wpid fr m1 m2 c1 c2 cw cc st1 st2 cw30
    for name in synthetic emilia-1726902114 kimi-2371103399 bunk-2134765860; do
        case $name in
            synthetic) path=$syn ;;
            emilia-*) path=$SC_EMILIA ;;
            kimi-*) path=$SC_KIMI ;;
            bunk-*) path=$SC_BUNK ;;
        esac
        id=$(create_scene "$path")
        show $OUT_A "$id"; show $OUT_B "$id"
        wait_ready "$id" 20 || { check "$name ready" no "≤ 20 s" 0; continue; }
        ctl set '{"path":"out:*.scene_fps","value":0}' >/dev/null
        sleep 2
        wpid=$(worker_of "$id" | jq -r .pid)
        reset_frames
        read -r cc cw < <(cpu_pct2 "$PLAYER_PID" "$wpid" 5)
        fr=$(frames)
        w=$(worker_of "$id")
        m1=$(fstat "$fr" $OUT_A .paced.mean_ms); c1=$(fstat "$fr" $OUT_A .paced.count)
        m2=$(fstat "$fr" $OUT_B .paced.mean_ms); c2=$(fstat "$fr" $OUT_B .paced.count)
        say "$name: native $(jq -c .native <<<"$w") export $(jq -c .size <<<"$w") fps $(jq -r .fps_actual <<<"$w") gpu_ms_p50 $(jq -r .gpu_ms_p50 <<<"$w") $OUT_A $(fstat "$fr" $OUT_A '.paced | tostring') $OUT_B $(fstat "$fr" $OUT_B '.paced | tostring')"
        check "$name $OUT_A paced mean (scene_fps 0)" "$(fnum "$m1" 3) ms (n $c1, p95 $(fnum "$(fstat "$fr" $OUT_A .paced.p95_ms)" 2), missed $(fstat "$fr" $OUT_A .paced.missed))" "6.9 ± 0.5 ms" \
            "$([[ $c1 -ge 50 ]] && within "$m1" 6.944 0.5 || echo 0)"
        check "$name $OUT_B paced mean (scene_fps 0)" "$(fnum "$m2" 3) ms (n $c2, p95 $(fnum "$(fstat "$fr" $OUT_B .paced.p95_ms)" 2), missed $(fstat "$fr" $OUT_B .paced.missed))" "4.2 ± 0.5 ms" \
            "$([[ $c2 -ge 50 ]] && within "$m2" 4.171 0.5 || echo 0)"
        check "$name worker CPU (scene_fps 0 → $(jq -r .fps_target <<<"$w") fps)" "$cw %" "< 5 %" "$(le "$cw" 4.999)"
        check "$name compositor CPU − video baseline" "$(fnum "$(python3 -c "print($cc-$base_vid)")" 2) % ($cc %)" "≤ +1 %" "$(le "$(python3 -c "print($cc-$base_vid)")" 1)" \
            "{\"compositor\":$cc,\"base_video\":$base_vid,\"base_anim\":$base_anim}"
        note "$name compositor CPU − animation baseline (no decode): $(fnum "$(python3 -c "print($cc-$base_anim)")" 2) %"
        # The default rate (30 fps) for comparison.
        ctl set '{"path":"out:*.scene_fps","value":30}' >/dev/null
        sleep 1.5
        cw30=$(cpu_pct "$wpid" 5)
        check "$name worker CPU (scene_fps 30, the default)" "$cw30 %" "< 5 %" "$(le "$cw30" 4.999)"
        on_overlay
        grim_png $OUT_A "$RESULTS/outputs-$name-$OUT_A.png"
        grim_png $OUT_B "$RESULTS/outputs-$name-$OUT_B.png"
        on_background
        st1=$(img_stats "$RESULTS/outputs-$name-$OUT_A.png"); st2=$(img_stats "$RESULTS/outputs-$name-$OUT_B.png")
        if [[ $name == synthetic ]]; then
            # frame_index is ~99.7 % one grey by design: "our picture is on screen" = the grey
            # (32, 32, 32) at the centre (else the owner's desktop or black would be there).
            for o in $OUT_A $OUT_B; do
                local px
                px=$(python3 -c "from PIL import Image; im=Image.open('$RESULTS/outputs-$name-$o.png').convert('RGB'); print(*im.getpixel((im.width//2, im.height//2)))")
                check "$name grim $o shows the scene (overlay)" "centre $px" "(32, 32, 32) ± 6" \
                    "$(python3 -c "print(1 if all(abs(int(v)-32) <= 6 for v in '$px'.split()) else 0)")"
            done
        else
            check "$name grim $OUT_A non-blank (overlay)" "$st1" "luma sd ≥ 2, top colour < 99 %" "$(jq -r 'if .blank then 0 else 1 end' <<<"$st1")"
            check "$name grim $OUT_B non-blank (overlay)" "$st2" "luma sd ≥ 2, top colour < 99 %" "$(jq -r 'if .blank then 0 else 1 end' <<<"$st2")"
        fi
        show $OUT_A "$col"; show $OUT_B "$col"
        destroy "$id"
        sleep 1
    done

    # Pointer: a pointer_dot scene (red dot on blue) filled on DP-1; the cursor enters DP-1's
    # surface (overlay), moves to (480, 270), leaves to DP-2 (Hyprland's warp delivers the motion
    # with the leave — outputs.sh) → the dot is drawn at (480, 270) of the 1920×1080 ring.
    local pd ax ay bx by pos cap
    pd=$(create_scene "$(mk_scene pointer '{"pattern":"pointer_dot","native":[1920,1080],"rgb":[255,0,0],"rgb2":[0,0,255]}')")
    show $OUT_A "$pd"
    wait_ready "$pd" 20 || die "pointer scene never ready"
    on_overlay
    CURSOR=$(hyprctl cursorpos -j | jq -c '{x, y}')
    FOCUS=$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')
    ax=$(hyprctl monitors -j | jq -r --arg n $OUT_A '.[] | select(.name == $n) | .x'); ay=$(hyprctl monitors -j | jq -r --arg n $OUT_A '.[] | select(.name == $n) | .y')
    bx=$(hyprctl monitors -j | jq -r --arg n $OUT_B '.[] | select(.name == $n) | .x'); by=$(hyprctl monitors -j | jq -r --arg n $OUT_B '.[] | select(.name == $n) | .y')
    cursor_to $((ax + 960)) $((ay + 540)); sleep 0.3
    cursor_to $((ax + 480)) $((ay + 270)); sleep 0.1
    cursor_to $((bx + 960)) $((by + 540)); sleep 0.5
    restore_cursor
    on_background
    pos=$(ctl get "{\"path\":\"out:$OUT_A.pointer\"}" | jq -c .value)
    cap=$RESULTS/outputs-pointer-src.png
    ctl capture "{\"target\":\"$pd\",\"path\":\"$cap\"}" >/dev/null
    local dot
    dot=$(python3 - "$cap" <<'PY'
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB"); w, h = im.size; px = im.load()
xs = ys = n = 0
for y in range(0, h):
    for x in range(0, w):
        r, g, b = px[x, y]
        if r > 200 and b < 60: xs += x; ys += y; n += 1
print(json.dumps({"size": [w, h], "n": n, "x": round(xs / n, 1) if n else None, "y": round(ys / n, 1) if n else None}))
PY
)
    say "pointer: out:$OUT_A.pointer $pos, worker pointer $(worker_of "$pd" | jq -c .pointer), dot $dot"
    check "synthetic pointer_dot follows a cursor warp" "dot at ($(jq -r .x <<<"$dot"), $(jq -r .y <<<"$dot")), out.pointer $pos" "(480, 270) ± 3 px" \
        "$(jq -r 'if .n > 100 and ((.x - 480) | fabs) <= 3 and ((.y - 270) | fabs) <= 3 then 1 else 0 end' <<<"$dot")"
    show $OUT_A "$col"; destroy "$pd"

    # Bunk's visualiser bars: input_dbfs and the picture with and without a sound playing on the
    # (private) default sink. Pink noise so every band moves.
    local bk noise q0 q1 d0 d1 i
    bk=$(create_scene "$SC_BUNK")
    show $OUT_A "$bk"; show $OUT_B "$bk"
    wait_ready "$bk" 20 || die "Bunk never ready"
    sleep 2
    q0=$(worker_of "$bk" | jq -c '{wants_audio_input, input_dbfs}')
    for i in 0 1 2 3 4; do ctl capture "{\"target\":\"$bk\",\"path\":\"$RESULTS/outputs-bunk-quiet-$i.png\"}" >/dev/null; sleep 0.25; done
    noise=$MEDIA/pink.wav
    [[ -s $noise ]] || ffmpeg -nostdin -v error -y -f lavfi -i "anoisesrc=color=pink:amplitude=0.25:duration=8" -ac 2 -ar 48000 "$noise"
    env "${PW_ENV[@]}" pw-play "$noise" &
    TONE_PID=$!
    sleep 2
    q1=$(worker_of "$bk" | jq -c '{wants_audio_input, input_dbfs}')
    for i in 0 1 2 3 4; do ctl capture "{\"target\":\"$bk\",\"path\":\"$RESULTS/outputs-bunk-sound-$i.png\"}" >/dev/null; sleep 0.25; done
    wait "$TONE_PID" 2>/dev/null; TONE_PID=
    d0=$(python3 -c "import statistics,sys; print(statistics.mean(float(x) for x in sys.argv[1:]))" $(for i in 1 2 3 4; do img_diff "$RESULTS/outputs-bunk-quiet-$((i-1)).png" "$RESULTS/outputs-bunk-quiet-$i.png"; done))
    d1=$(python3 -c "import statistics,sys; print(statistics.mean(float(x) for x in sys.argv[1:]))" $(for i in 1 2 3 4; do img_diff "$RESULTS/outputs-bunk-sound-$((i-1)).png" "$RESULTS/outputs-bunk-sound-$i.png"; done))
    say "Bunk: quiet $q0 frame-to-frame diff $(fnum "$d0" 3); with sound $q1 diff $(fnum "$d1" 3)"
    check "Bunk visualiser input with a sound playing" "input_dbfs $(jq -r .input_dbfs <<<"$q1") (quiet $(jq -r .input_dbfs <<<"$q0"))" "> −40 dBFS, wants_audio_input" \
        "$(jq -r 'if .wants_audio_input and (.input_dbfs // -96) > -40 then 1 else 0 end' <<<"$q1")"
    check "Bunk's picture moves more with sound (bars)" "mean frame diff $(fnum "$d1" 3) vs $(fnum "$d0" 3) quiet" "with > quiet × 1.5" \
        "$(python3 -c "print(1 if $d1 > $d0 * 1.5 else 0)")"
    destroy "$bk"
    serve_down

    # For scale: the legacy engine (the installed linux-wallpaperengine, which renders and
    # presents in one process) on the same scenes, on DP-1 alone, silent (+ SDL's dummy audio
    # driver: nothing can reach the speakers), CPU over 5 s after 6 s of warm-up.
    local lwe lpid lc fps
    lwe=$(command -v linux-wallpaperengine) || { note "no linux-wallpaperengine installed: legacy CPU not measured"; step_end; return; }
    for name in emilia-1726902114 kimi-2371103399 bunk-2134765860; do
        path=$WS/${name#*-}
        for fps in 30 144; do
            SDL_AUDIODRIVER=dummy prlimit --core=1:1 "$lwe" --silent --noautomute --no-fullscreen-pause --fps "$fps" \
                --assets-dir "$(lp scene-check | jq -r .assets_dir)" \
                --screen-root $OUT_A --bg "$path" >"$RESULTS/outputs-legacy-$name-$fps.log" 2>&1 &
            lpid=$!
            sleep 6
            if kill -0 "$lpid" 2>/dev/null; then
                lc=$(cpu_pct "$lpid" 5)
                note "legacy linux-wallpaperengine $name at --fps $fps on $OUT_A: $lc % CPU (one process: render + present)"
            else
                note "legacy linux-wallpaperengine $name at --fps $fps exited early"
            fi
            kill "$lpid" 2>/dev/null
            for _ in $(seq 30); do kill -0 "$lpid" 2>/dev/null || break; sleep 0.1; done
            kill -KILL "$lpid" 2>/dev/null
            wait "$lpid" 2>/dev/null
        done
    done
    step_end
}

# ------------------------------------------------------------------ step 2 — dropout matrix
# V→S, S→V, S→S × {full-live, reveal, frozen} × align now, + V→S align end; synthetic tone
# scenes (and the SFW scene with sound, 2371103399, at 240 Hz); SWITCHES per direction and cell
# at 60 Hz and 240 Hz (headless outputs: the bus + meter + detector are the player's own, on the
# private PipeWire). Pass: drops 0, micro_gaps 0, onset — the loudest 1 ms of the first 10 ms
# after B's ramp-in started ≤ the settled level + 6 dB.
DROP_RECS=
# One switch: transition to $1 (create props JSON) with method $2, align $3; waits for the
# auto-triggered (`--debug`) `probe.dropout` of its corr and appends a record.
drop_switch() {
    local to=$1 method=$2 align=$3 label=$4 hz=$5 dir=$6 r corr ev i t_done t_on settled peak rec
    r=$(ctl transition "$(jq -nc --argjson to "$to" --arg m "$method" --arg a "$align" \
        '{outputs:"out:*", to:$to, effect_id:"fade", duration_ms:1000, method:$m, align:$a}')") || {
        say "transition failed: $r"; return 1; }
    corr=$(jq -r .corr <<<"$r")
    ev=
    for ((i = 0; i < 400; i++)); do # ≤ 40 s (align end waits for A's end)
        ev=$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"probe.dropout\"}" | jq -c '.events[-1] // empty')
        [[ -n $ev ]] && break
        ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"transition.failed\"}" | jq -e '.events | length > 0' >/dev/null && break
        kill -0 "$SERVE_PID" 2>/dev/null || die "serve died"
        sleep 0.1
    done
    local tl
    tl=$(ctl logs "{\"corr\":\"$corr\",\"limit\":200}")
    t_done=$(jq -r '[.events[] | select(.kind == "transition.done")][0].t_mono_ms // empty' <<<"$tl")
    t_on=$(jq -r '[.events[] | select(.kind == "onset.started")][0].t_mono_ms // empty' <<<"$tl")
    [[ -n $t_on ]] || t_on=$(jq -r '[.events[] | select(.kind == "transition.handoff")][0].t_mono_ms // empty' <<<"$tl")
    # Onset: the loudest 1 ms in the first 10 ms of B's ramp-in vs the louder of B's settled
    # level (median 100–450 ms after done) and what already played just before it (A, in a
    # full-live crossfade of real music) — an overshoot/click shows over both.
    settled=null peak=null
    local before=null meter_gap=null
    if [[ -n $t_done && -n $t_on ]]; then
        local w
        w=$(ctl probe "{\"name\":\"meter.window\",\"args\":{\"from_ms\":$(python3 -c "print($t_on - 50)"),\"to_ms\":$(python3 -c "print($t_done + 450)")}}" 2>/dev/null)
        settled=$(jq -r --argjson d "$t_done" '[.samples[] | select(.[0] >= ($d + 100)) | .[1]] | sort | if length == 0 then null else .[length / 2 | floor] end' <<<"$w")
        peak=$(jq -r --argjson o "$t_on" '[.samples[] | select(.[0] >= $o and .[0] < ($o + 10)) | .[1]] | if length == 0 then null else max end' <<<"$w")
        before=$(jq -r --argjson o "$t_on" '[.samples[] | select(.[0] < $o) | .[1]] | if length == 0 then null else max end' <<<"$w")
        # The meter's own continuity (a capture that missed a cycle jumps its timestamps):
        # the longest step between consecutive 1 ms samples of the whole window.
        meter_gap=$(jq -r '[.samples | range(1; length) as $i | (.[$i][0] - .[$i - 1][0])] | max // null' <<<"$w")
    fi
    rec=$(jq -nc --arg label "$label" --argjson hz "$hz" --arg dir "$dir" --arg m "$method" --arg a "$align" --arg corr "$corr" \
        --argjson ev "${ev:-null}" --argjson tl "$tl" --argjson settled "${settled:-null}" --argjson peak "${peak:-null}" \
        --argjson before "${before:-null}" --argjson mgap "${meter_gap:-null}" '
        {label:$label, hz:$hz, dir:$dir, method:$m, align:$a, corr:$corr,
         outcome: ([$tl.events[] | select(.kind | test("^transition\\.(done|failed|cancelled)$")) | .kind][0] // "timeout"),
         skipped: ($ev.skipped // null), fit: ($ev.report.fit // null), fit_db: ($ev.report.fit_db // null),
         lag_ms: ($ev.report.lag_ms // null),
         drops: (if $ev.report then ($ev.report.drops | length) else null end),
         micro_gaps: (if $ev.report then ($ev.report.micro_gaps | length) else null end),
         unmeasured: (if $ev.report then (($ev.report.unmeasured // []) | length) else null end),
         drop_list: ($ev.report.drops // []), gap_list: ($ev.report.micro_gaps // []),
         unmeasured_list: ($ev.report.unmeasured // []),
         onset_peak_db: $peak, settled_db: $settled, before_db: $before, meter_max_step_ms: $mgap,
         onset_ref_db: (if $settled == null then null else ([$settled, ($before // -96)] | max) end),
         onset_ok: (if $peak == null or $settled == null then null else ($peak <= ([$settled, ($before // -96)] | max) + 6) end),
         onset_timeouts: ([$tl.events[] | select(.kind | endswith("onset_timeout"))] | length)}')
    echo "$rec" >>"$DROP_RECS"
    jq -r '"    \(.label) \(.dir) \(.method)/\(.align): \(.outcome) drops \(.drops) gaps \(.micro_gaps) fit \(.fit) \(.fit_db // "" | tostring | .[0:5]) onset \(.onset_peak_db // "-" | tostring | .[0:6])/\(.settled_db // "-" | tostring | .[0:6])\(if .skipped then " SKIPPED " + .skipped else "" end)"' <<<"$rec" >&2
}
drop_cell() { # <label> <hz> <method> <align> <n per direction> <A props> <A kind> <B props> <B kind>
    local label=$1 hz=$2 m=$3 al=$4 n=$5 a=$6 ak=$7 b=$8 bk=$9 i
    # Start on A with a cut (not counted), then alternate A→B / B→A.
    ctl transition "$(jq -nc --argjson to "$a" '{outputs:"out:*", to:$to}')" >/dev/null
    sleep 2.5
    for ((i = 0; i < n; i++)); do
        drop_switch "$b" "$m" "$al" "$label" "$hz" "$ak→$bk"
        if [[ $al == end ]]; then
            drop_switch "$a" "$m" now "$label-return" "$hz" "$bk→$ak"
        else
            drop_switch "$a" "$m" "$al" "$label" "$hz" "$bk→$ak"
        fi
    done
}
step_dropout() {
    step_begin dropout
    DROP_RECS=$RESULTS/dropout-switches.jsonl
    : >"$DROP_RECS"
    local v vs s1 s2 kimi va vend hz m n=$SWITCHES half
    v=$(mk_clip tone440 "color=c=0x204060" 30 6 440 320x180)
    vs=$(mk_clip tone440short "color=c=0x406020" 30 3 440 320x180)
    s1=$(mk_scene tone660 '{"pattern":"solid","rgb":[200,40,40],"native":[1920,1080],"has_audio":true,"tone_hz":660,"tone_dbfs":-20}')
    s2=$(mk_scene tone550 '{"pattern":"solid","rgb":[40,40,200],"native":[1920,1080],"has_audio":true,"tone_hz":550,"tone_dbfs":-20}')
    va=$(jq -nc --arg p "$v" '{path:$p, loop:true}')
    vend=$(jq -nc --arg p "$vs" '{path:$p, loop:true}')
    s1=$(jq -nc --arg p "$s1" '{kind:"scene", path:$p}')
    s2=$(jq -nc --arg p "$s2" '{kind:"scene", path:$p}')
    kimi=$(jq -nc --arg p "$SC_KIMI" '{kind:"scene", path:$p}')
    half=$(( (n + 1) / 2 ))
    for hz in ${DROP_HZ:-60 240}; do
        serve_up "headless:640x360@$hz"
        for m in full-live reveal frozen; do
            say "cell $hz Hz V↔S $m (synthetic tone scene)"
            drop_cell VS "$hz" "$m" now "$n" "$va" V "$s1" S
            say "cell $hz Hz S↔S $m"
            drop_cell SS "$hz" "$m" now "$half" "$s1" S "$s2" S
        done
        for m in full-live reveal frozen; do
            say "cell $hz Hz V→S align end $m"
            drop_cell VSend "$hz" "$m" end "$n" "$vend" V "$s1" S
        done
        if [[ $hz == 240 ]]; then
            for m in full-live reveal frozen; do
                say "cell $hz Hz V↔S $m (real scene with sound, 2371103399)"
                drop_cell VSreal "$hz" "$m" now "$half" "$va" V "$kimi" S
                say "cell $hz Hz S↔S $m (real ↔ synthetic)"
                drop_cell SSreal "$hz" "$m" now "$half" "$kimi" S "$s1" S
            done
        fi
        serve_down
    done
    # Summary per (hz, label, dir, method, align).
    jq -s 'group_by([.hz, .label, .dir, .method, .align]) | map({hz: .[0].hz, label: .[0].label, dir: .[0].dir,
        method: .[0].method, align: .[0].align, switches: length,
        done: ([.[] | select(.outcome == "transition.done")] | length),
        analysed: ([.[] | select(.drops != null)] | length),
        skipped: ([.[] | select(.skipped != null)] | length),
        drops: ([.[].drops // 0] | add), micro_gaps: ([.[].micro_gaps // 0] | add),
        unmeasured: ([.[].unmeasured // 0] | add),
        onset_bad: ([.[] | select(.onset_ok == false)] | length),
        onset_unchecked: ([.[] | select(.onset_ok == null)] | length),
        onset_timeouts: ([.[].onset_timeouts] | add),
        fit_insufficient: ([.[] | select(.fit != null and .fit != "ok")] | length),
        worst_onset_margin_db: ([.[] | select(.onset_ok != null) | (.onset_peak_db - .onset_ref_db)] | max),
        meter_discontinuities: ([.[] | select((.meter_max_step_ms // 0) > 1.6)] | length)})' \
        "$DROP_RECS" >"$RESULTS/dropout-cells.json"
    jq -c '.[]' "$RESULTS/dropout-cells.json" | while read -r c; do
        check "dropout $(jq -r '"\(.hz) Hz \(.label) \(.dir) \(.method)/\(.align)"' <<<"$c")" \
            "$(jq -r '"\(.switches) switches, done \(.done), analysed \(.analysed), drops \(.drops), micro_gaps \(.micro_gaps), onset over +6 dB \(.onset_bad) (worst \(.worst_onset_margin_db // "-" | tostring | .[0:5]) dB, unchecked \(.onset_unchecked)), onset timeouts \(.onset_timeouts), meter discontinuities \(.meter_discontinuities), unmeasured stretches \(.unmeasured)"' <<<"$c")" \
            "drops 0, micro_gaps 0, onset ≤ settled + 6 dB, every switch done + analysed" \
            "$(jq -r 'if .drops == 0 and .micro_gaps == 0 and .onset_bad == 0 and .done == .switches and .analysed == .switches then 1 else 0 end' <<<"$c")" "$c"
    done
    step_end
}

# ------------------------------------------------------------------ onsetrec (F7: frozen S→S onsets, recorded)
# F7's check: frozen S→S switches between two synthetic tone scenes on a headless output at
# ONSET_HZ (default 240), each analysed by the player's own dropout detector (`drop_switch`) AND
# an independent `pw-record` of the private sink's monitor for the whole run. Per recorded onset
# (a tone after ≥ 200 ms of silence): the 1 ms RMS envelope of its first 40 ms against the ideal
# 30 ms linear-amplitude ramp — a "hole" is ≥ 1 ms more than 20 dB under the ramp after the first
# 2 ms — and every run of ≥ 16 samples of EXACT silence inside sound anywhere in the recording
# (a skipped graph cycle: whole 64-frame quanta of zeros at the sink). A detector micro-gap with
# no recorded hole is the meter's; a recorded hole is real. ONSET_METHOD (default frozen) also
# runs full-live/reveal (the zero-run count is then the measure: their onsets overlap).
step_onsetrec() {
    step_begin onsetrec
    DROP_RECS=$RESULTS/onsetrec-switches.jsonl
    : >"$DROP_RECS"
    local hz=${ONSET_HZ:-240} n=${SWITCHES:-20} m=${ONSET_METHOD:-frozen} s1 s2 i wav=$RESULTS/onsetrec.wav
    s1=$(mk_scene tone660 '{"pattern":"solid","rgb":[200,40,40],"native":[1920,1080],"has_audio":true,"tone_hz":660,"tone_dbfs":-20}')
    s2=$(mk_scene tone550 '{"pattern":"solid","rgb":[40,40,200],"native":[1920,1080],"has_audio":true,"tone_hz":550,"tone_dbfs":-20}')
    s1=$(jq -nc --arg p "$s1" '{kind:"scene", path:$p}')
    s2=$(jq -nc --arg p "$s2" '{kind:"scene", path:$p}')
    serve_up "headless:640x360@$hz"
    env "${PW_ENV[@]}" pw-record --target hermetic-sink -P '{ stream.capture.sink = true }' --rate 48000 --channels 2 --format f32 "$wav" &
    TONE_PID=$!
    sleep 1
    ctl transition "$(jq -nc --argjson to "$s1" '{outputs:"out:*", to:$to}')" >/dev/null
    sleep 2.5
    for ((i = 0; i < n; i++)); do
        drop_switch "$s2" "$m" now SS "$hz" "S→S"
        drop_switch "$s1" "$m" now SS "$hz" "S→S"
    done
    sleep 1
    kill -INT "$TONE_PID" 2>/dev/null; wait "$TONE_PID" 2>/dev/null; TONE_PID=
    ctl logs '{"limit":100000,"min_level":"debug"}' >"$RESULTS/onsetrec-events.json" 2>/dev/null
    serve_down
    local res
    res=$(python3 - "$wav" "$DROP_RECS" "$RESULTS/onsetrec-onsets.jsonl" <<'PYA'
import sys, json, math, array
wav, recs, out = sys.argv[1:4]
# pw-record writes a WAV with an f32 data chunk: find "data" and read floats.
raw = open(wav, "rb").read()
k = raw.find(b"data")
data = array.array("f"); data.frombytes(raw[k + 8: k + 8 + ((len(raw) - k - 8) // 8) * 8])
L = data[0::2]
B = 48  # 1 ms
blocks = [math.sqrt(sum(x * x for x in L[i:i + B]) / B) for i in range(0, len(L) - B, B)]
db = [20 * math.log10(b) if b > 1e-9 else -180.0 for b in blocks]
full = sorted(v for v in db if v > -40)[len([v for v in db if v > -40]) // 2] if any(v > -40 for v in db) else -23.0
onsets = []
quiet = 0
i = 0
while i < len(db):
    if db[i] < -90:
        quiet += 1
        i += 1
        continue
    if quiet >= 200:
        # sample-accurate start
        s0 = i * B
        while s0 > 0 and abs(L[s0 - 1]) > 1e-6:
            s0 -= 1
        env = []
        for m in range(40):
            seg = L[s0 + m * B: s0 + (m + 1) * B]
            r = math.sqrt(sum(x * x for x in seg) / len(seg)) if seg else 0
            env.append(20 * math.log10(r) if r > 1e-9 else -180.0)
        ideal = [full + 20 * math.log10(min(1.0, (m + 0.5) / 30.0)) for m in range(40)]
        holes = [m for m in range(2, 40) if env[m] < ideal[m] - 20]
        onsets.append({"t_s": round(s0 / 48000, 4), "holes_ms": holes, "env": [round(v, 1) for v in env], "ideal": [round(v, 1) for v in ideal]})
    quiet = 0
    i += 1
with open(out, "w") as f:
    for o in onsets:
        f.write(json.dumps(o) + "\n")
zero_runs = []
z = 0
while z < len(L):
    if L[z] == 0.0:
        e = z
        while e < len(L) and L[e] == 0.0:
            e += 1
        if 16 <= e - z < 4800 and z > 200 and e < len(L) - 200 \
                and any(L[x] != 0.0 for x in range(z - 200, z)) and any(L[x] != 0.0 for x in range(e, e + 200)):
            zero_runs.append([round(z / 48000, 4), e - z])
        z = e
    else:
        z += 1
gaps = [json.loads(l) for l in open(recs)]
det = [(j, r["gap_list"]) for j, r in enumerate(gaps) if r.get("micro_gaps")]
print(json.dumps({"onsets": len(onsets), "with_holes": [(j, o["t_s"], o["holes_ms"]) for j, o in enumerate(onsets) if o["holes_ms"]],
                  "zero_runs": zero_runs, "switches": len(gaps), "detector_gaps": det, "full_db": round(full, 2)}))
PYA
    ) || die "onset analysis failed"
    say "onsetrec: $res"
    check "$m S→S at $hz Hz: the recorded sink has no hole" "$(jq -c '{onsets, with_holes, zero_runs}' <<<"$res")" \
        "no onset > 20 dB under its ramp, no run of exact silence inside sound" \
        "$(jq -r 'if (.with_holes | length) == 0 and (.zero_runs | length) == 0 and .switches > 0 then 1 else 0 end' <<<"$res")" "$res"
    note "detector micro-gaps on those switches (with no recorded hole: the meter's own capture): $(jq -c '.detector_gaps' <<<"$res")"
    step_end
}

# ------------------------------------------------------------------ step 3 — crash isolation
# DP-1 a playing 240 fps video with a steady tone, DP-2 a scene. Per scene (synthetic, and the
# real 1726902114): 5 SIGKILLs and 2 hangs (SIGSTOP — the host's heartbeat kills it), ≥ 21 s
# apart (the budget is 3 restarts per 60 s — this never breaks it); then a synthetic crash loop
# to broken. Bounds: DP-1 paced p95 ≤ baseline × 1.10 and missed ≤ baseline + 1 in the 2 s after
# each event, DP-1's tone without a 10 ms bin 15 dB under its level (drops 0); DP-2 holds its
# frame (two grims during the outage identical) and recovers (scene.resumed) ≤ 2 s real /
# ≤ 0.5 s synthetic.
worker_pid_checked() { # the worker pid of scene $1, only if it is OUR compositor's child
    local w ppid
    w=$(worker_of "$1" | jq -r '.pid // empty')
    [[ -n $w ]] || return 1
    ppid=$(awk '{print $4}' "/proc/$w/stat" 2>/dev/null)
    [[ $ppid == "$PLAYER_PID" ]] || { say "worker $w is not our compositor's child (ppid $ppid)"; return 1; }
    echo "$w"
}
meter_drops() { # <from_ms> <to_ms> → JSON {level_db, drops (10 ms bins ≥ 15 dB under), min_bin_db, max_step_ms}
    ctl probe "{\"name\":\"meter.window\",\"args\":{\"from_ms\":$1,\"to_ms\":$2}}" | python3 -c '
import sys, json, math
w = json.load(sys.stdin); s = w.get("samples") or []
bins = {}
for t, db in s: bins.setdefault(int(t // 10), []).append(10 ** (db / 10))
vals = [10 * math.log10(sum(v) / len(v)) if sum(v) > 0 else -96 for _, v in sorted(bins.items())][1:-1]
lvl = sorted(vals)[len(vals) // 2] if vals else None
steps = [s[i][0] - s[i - 1][0] for i in range(1, len(s))]
print(json.dumps({"level_db": lvl, "drops": sum(1 for v in vals if lvl is not None and v < lvl - 15),
    "min_bin_db": min(vals) if vals else None, "max_step_ms": max(steps) if steps else None, "bins": len(vals)}))'
}
crash_events() { # <scene label> <scene id> <bound recover s>
    local label=$1 id=$2 bound=$3 ev w t0 g1 g2 resumed rec fr p95 miss md lb
    local base base_p95 base_miss
    reset_frames; sleep 2.2; base=$(frames)
    base_p95=$(fstat "$base" $OUT_A .paced.p95_ms); base_miss=$(fstat "$base" $OUT_A .paced.missed)
    say "$label baseline $OUT_A: $(fstat "$base" $OUT_A '.paced | tostring')"
    note "$label baseline $OUT_A paced p95 $base_p95 ms, missed $base_miss (2 s)"
    CRASH_BASE_P95=$base_p95 CRASH_BASE_MISS=$base_miss
    for ev in kill kill hang kill hang kill kill; do
        w=$(worker_pid_checked "$id") || { check "$label $ev: worker found" none "a worker" 0; continue; }
        ctl probe '{"name":"loop","args":{"reset":true}}' >/dev/null
        reset_frames
        t0=$(now_ms)
        if [[ $ev == kill ]]; then kill -KILL "$w"; else kill -STOP "$w"; fi
        grim_png $OUT_B "$RESULTS/crash-$label-g1.png"
        grim_png $OUT_B "$RESULTS/crash-$label-g2.png"
        local tg=$(now_ms)
        sleep 2.2
        fr=$(frames)
        p95=$(fstat "$fr" $OUT_A .paced.p95_ms); miss=$(fstat "$fr" $OUT_A .paced.missed)
        # Recovery: the scene's resume (its first frame of the new worker latched).
        for _ in $(seq 40); do
            resumed=$(events_since "$t0" "scene.resumed" | jq -r --arg id "$id" '[.[] | select(.id == $id)][0].t_mono_ms // empty')
            [[ -n $resumed ]] && break
            sleep 0.1
        done
        local exited
        exited=$(events_since "$t0" "worker.exited" | jq -r '.[0].t_mono_ms // empty')
        rec=$(python3 -c "print(round(($resumed - ${exited:-$t0}) / 1000, 3) if '$resumed' else 'none')")
        md=$(meter_drops "$(python3 -c "print($t0 - 100)")" "$(python3 -c "print($t0 + 2400)")")
        local held
        held=$(img_diff "$RESULTS/crash-$label-g1.png" "$RESULTS/crash-$label-g2.png")
        local res_before_g2=0
        [[ -n $resumed ]] && python3 -c "import sys; sys.exit(0 if $resumed < $tg else 1)" && res_before_g2=1
        say "$label $ev (pid $w): recovered ${rec}s after the worker's exit; $OUT_A p95 $p95 missed $miss; tone $md; $OUT_B grims diff $held (resumed before 2nd grim: $res_before_g2); loop max_busy $(ctl probe '{"name":"loop"}' | jq -r .max_busy_ms)"
        check "$label $ev: $OUT_A paced p95 / missed" "p95 $(fnum "$p95" 2) ms, missed $miss (baseline $(fnum "$base_p95" 2) / $base_miss)" "p95 ≤ baseline × 1.10, missed ≤ baseline + 1" \
            "$(python3 -c "print(1 if $p95 <= $base_p95 * 1.10 and $miss <= $base_miss + 1 else 0)")"
        check "$label $ev: $OUT_A tone drops" "$(jq -r '"\(.drops) (level \(.level_db | tostring | .[0:6]) dB, min bin \(.min_bin_db | tostring | .[0:6]), meter max step \(.max_step_ms | tostring | .[0:4]) ms)"' <<<"$md")" "0" \
            "$(jq -r 'if .drops == 0 and .bins > 100 then 1 else 0 end' <<<"$md")"
        if [[ $res_before_g2 == 1 ]]; then
            note "$label $ev: the new worker's frame latched before the 2nd grim — hold check n/a for this event"
        else
            check "$label $ev: $OUT_B holds its frame" "grim diff $held" "identical (0)" "$(python3 -c "print(1 if float('$held') == 0 else 0)")"
        fi
        check "$label $ev: recovery (worker exit → scene.resumed)" "${rec} s" "≤ $bound s" "$([[ $rec != none ]] && le "$rec" "$bound" || echo 0)"
        sleep 19
    done
}
step_crash() {
    step_begin crash
    serve_up wayland
    local clip v syn sid em eid loop lid t0 b wn
    clip=$(mk_clip clip240tone testsrc2 240 30 440 640x360)
    syn=$(mk_scene fi "$SYN_FI")
    v=$(create_video "$clip"); wait_ready "$v" || die "video never ready"
    show $OUT_A "$v"
    sid=$(create_scene "$syn")
    show $OUT_B "$sid"
    wait_ready "$sid" 20 || die "synthetic scene never ready"
    on_overlay
    sleep 2
    crash_events synthetic "$sid" 0.5
    eid=$(create_scene "$SC_EMILIA")
    show $OUT_B "$eid"
    wait_ready "$eid" 20 || die "real scene never ready"
    destroy "$sid"
    sleep 3
    crash_events real-1726902114 "$eid" 2
    # A crash loop to broken (every worker aborts 1.2 s after its start).
    lid=$(create_scene "$(mk_scene crashloop '{"pattern":"frame_index","native":[1920,1080],"crash_after_ms":1200}')")
    show $OUT_B "$lid"
    destroy "$eid"
    t0=$(now_ms)
    local worst_p95=0 worst_miss=0 fr
    for _ in $(seq 8); do
        reset_frames; sleep 2.1; fr=$(frames)
        worst_p95=$(python3 -c "print(max($worst_p95, $(fstat "$fr" $OUT_A .paced.p95_ms)))")
        worst_miss=$(python3 -c "print(max($worst_miss, $(fstat "$fr" $OUT_A .paced.missed)))")
        b=$(events_since "$t0" "source.broken" | jq -c '.[0] // empty')
        [[ -n $b ]] && break
    done
    say "crash loop: broken $(jq -c '{restarts, signal, shows, record}' <<<"${b:-null}")"
    [[ -n ${b:-} ]] || b='{}'
    check "crash loop → broken" "$(jq -c '{restarts, shows}' <<<"$b")" "source.broken after 3 restarts" "$(jq -r 'if .restarts == 3 then 1 else 0 end' <<<"$b")"
    check "crash loop: $OUT_A paced p95 / missed (worst 2 s window)" "p95 $(fnum "$worst_p95" 2), missed $worst_miss (baseline $(fnum "$CRASH_BASE_P95" 2) / $CRASH_BASE_MISS)" "p95 ≤ baseline × 1.10, missed ≤ baseline + 1" \
        "$(python3 -c "print(1 if $worst_p95 <= $CRASH_BASE_P95 * 1.10 and $worst_miss <= $CRASH_BASE_MISS + 1 else 0)")"
    md=$(meter_drops "$t0" "$(now_ms)")
    check "crash loop: $OUT_A tone drops" "$(jq -c '{drops, level_db, max_step_ms}' <<<"$md")" "0" "$(jq -r 'if .drops == 0 then 1 else 0 end' <<<"$md")"
    sleep 0.5
    grim_png $OUT_B "$RESULTS/crash-broken-g1.png"; sleep 1; grim_png $OUT_B "$RESULTS/crash-broken-g2.png"
    check "broken: $OUT_B holds the last frame" "grim diff $(img_diff "$RESULTS/crash-broken-g1.png" "$RESULTS/crash-broken-g2.png"), stats $(img_stats "$RESULTS/crash-broken-g1.png")" "identical, not blank" \
        "$(python3 -c "print(1 if float('$(img_diff "$RESULTS/crash-broken-g1.png" "$RESULTS/crash-broken-g2.png")') == 0 else 0)")"
    wn=$(workers_json | jq '[.workers[] | select(.pid != null)] | length')
    check "broken: no live worker" "$wn" "0" "$([[ $wn == 0 ]] && echo 1 || echo 0)"
    on_background
    serve_down
    step_end
}

# ------------------------------------------------------------------ shared: loop tick p99
# The `loop` probe keeps the last 8 tick durations + the tick counter, so polling it every
# ~25 ms over the socket gives every tick exactly once (deduplicated by tick number).
tick_stats() { # <seconds> → JSON {ticks, p50, p99, max}
    python3 - "$RT/liascape/liascape-player.sock" "$1" <<'PY'
import json, socket, sys, time
path, secs = sys.argv[1], float(sys.argv[2])
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(path)
f = s.makefile("rwb")
seen = {}
end = time.time() + secs
i = 0
while time.time() < end:
    i += 1
    f.write((json.dumps({"id": i, "cmd": "probe", "args": {"name": "loop"}}) + "\n").encode()); f.flush()
    while True:
        r = json.loads(f.readline())
        if r.get("id") == i: break
    v = r["result"]; n = v["ticks"]
    for k, d in enumerate(v["recent_ticks_ms"]): seen[n - k] = d
    time.sleep(0.02)
d = sorted(seen.values())
q = lambda p: d[min(len(d) - 1, int(p * len(d)))] if d else None
print(json.dumps({"ticks": len(d), "p50": q(0.5), "p99": q(0.99), "max": d[-1] if d else None}))
PY
}

# ------------------------------------------------------------------ step 4 — GPU budget
# A synthetic worker with ~3.7 ms of GPU per frame at 144 fps on DP-1 (scene_fps 0) while DP-2
# presents a 240 fps clip: DP-2 paced p95 ≤ 4.6 ms and no throttle. ~6.2 ms per frame:
# scene.throttled within 4 s and DP-2 p95 ≤ 5.0 ms after. The loop's tick p99 is recorded with
# explicit sync off (the player's default, `frames.explicit_sync`). gpu_work is calibrated from
# the worker's own GL_TIME_ELAPSED (gpu_ms_p50) — it scales linearly.
gpu_scene() { # <gpu_work> → scene id shown on OUT_A
    local d id
    d=$(mk_scene "gpu$1" "{\"pattern\":\"frame_index\",\"native\":[1920,1080],\"gpu_work\":$1}")
    id=$(create_scene "$d")
    show $OUT_A "$id"
    wait_ready "$id" 20 || die "gpu scene $1 never ready"
    echo "$id"
}
step_budget() {
    step_begin budget
    serve_up wayland
    local clip v col fr base t0 id gp k w37 w62 g ts thr p95 cur
    clip=$(mk_clip clip240 testsrc2 240 20 0 640x360)
    v=$(create_video "$clip"); wait_ready "$v" || die "clip never ready"
    col=$(create_color '[40,40,40]')
    show $OUT_A "$col"; show $OUT_B "$v"
    ctl set "{\"path\":\"out:$OUT_A.scene_fps\",\"value\":0}" >/dev/null
    note "explicit sync: $(frames | jq -c .explicit_sync)"
    sleep 2
    reset_frames; sleep 2.2; base=$(frames)
    ts=$(tick_stats 5)
    note "baseline (no scene): $OUT_B paced $(fstat "$base" $OUT_B '.paced | tostring'); loop ticks $ts"
    # Calibrate.
    id=$(gpu_scene 2500)
    sleep 4
    gp=$(worker_of "$id" | jq -r .gpu_ms_p50)
    k=$(python3 -c "print($gp / 2500)")
    w37=$(python3 -c "print(round(3.7 / $k))"); w62=$(python3 -c "print(round(6.2 / $k))")
    note "calibration: gpu_work 2500 → gpu_ms_p50 $gp ms at $(worker_of "$id" | jq -r .fps_actual) fps → 3.7 ms = $w37, 6.2 ms = $w62"
    show $OUT_A "$col"; destroy "$id"; sleep 1
    # ~3.7 ms: no throttle, DP-2 unaffected.
    t0=$(now_ms)
    id=$(gpu_scene "$w37")
    sleep 4
    reset_frames; sleep 2.2; fr=$(frames)
    ts=$(tick_stats 5)
    sleep 2
    g=$(worker_of "$id")
    thr=$(events_since "$t0" "scene.throttled" | jq 'length')
    say "3.7 ms: worker $(jq -c '{gpu_ms_p50, gpu_ms_p95, fps_actual, fps_target, throttle}' <<<"$g"); $OUT_A $(fstat "$fr" $OUT_A '.paced | tostring'); $OUT_B $(fstat "$fr" $OUT_B '.paced | tostring'); ticks $ts"
    p95=$(fstat "$fr" $OUT_B .paced.p95_ms)
    check "~3.7 ms/frame: $OUT_B paced p95" "$(fnum "$p95" 2) ms (missed $(fstat "$fr" $OUT_B .paced.missed); worker gpu_ms_p50 $(jq -r .gpu_ms_p50 <<<"$g"), $(jq -r .fps_actual <<<"$g") fps)" "≤ 4.6 ms" "$(le "$p95" 4.6)"
    check "~3.7 ms/frame: no throttle" "$thr scene.throttled, throttle $(jq -c .throttle <<<"$g")" "0" "$([[ $thr == 0 ]] && jq -r 'if .throttle == null then 1 else 0 end' <<<"$g" || echo 0)"
    note "~3.7 ms/frame: loop tick p99 $(jq -r .p99 <<<"$ts") ms, max $(jq -r .max <<<"$ts") ms over $(jq -r .ticks <<<"$ts") ticks (explicit sync off)"
    show $OUT_A "$col"; destroy "$id"; sleep 1.5
    # ~6.2 ms: throttled within 4 s.
    t0=$(now_ms)
    id=$(gpu_scene "$w62")
    local tr=
    for _ in $(seq 100); do
        tr=$(events_since "$t0" "scene.throttled" | jq -c '.[0] // empty')
        [[ -n $tr ]] && break
        sleep 0.1
    done
    local rdy dt=never
    rdy=$(events_since "$t0" "source.ready" | jq -r --arg id "$id" '[.[] | select(.id == $id)][0].t_mono_ms // empty')
    say "6.2 ms: throttled $(jq -c . <<<"${tr:-null}") (ready at $rdy)"
    [[ -n $tr && -n $rdy ]] && dt=$(python3 -c "print(round(($(jq -r .t_mono_ms <<<"$tr") - $rdy) / 1000, 2))")
    check "~6.2 ms/frame: scene.throttled" "$dt s after Ready $(jq -c '{fps_from, fps_to, gpu_ms, missed_pct}' <<<"${tr:-null}")" "≤ 4 s" \
        "$([[ $dt != never ]] && le "$dt" 4 || echo 0)"
    sleep 2.5
    reset_frames; sleep 2.2; fr=$(frames)
    ts=$(tick_stats 5)
    g=$(worker_of "$id")
    p95=$(fstat "$fr" $OUT_B .paced.p95_ms)
    say "6.2 ms after the throttle: worker $(jq -c '{gpu_ms_p50, fps_actual, fps_target, throttle}' <<<"$g"); $OUT_B $(fstat "$fr" $OUT_B '.paced | tostring'); ticks $ts"
    check "~6.2 ms/frame after the throttle: $OUT_B paced p95" "$(fnum "$p95" 2) ms (missed $(fstat "$fr" $OUT_B .paced.missed); scene at $(jq -r .fps_actual <<<"$g") fps)" "≤ 5.0 ms" "$(le "$p95" 5.0)"
    note "~6.2 ms/frame: loop tick p99 $(jq -r .p99 <<<"$ts") ms, max $(jq -r .max <<<"$ts") ms over $(jq -r .ticks <<<"$ts") ticks"
    # Auto-throttle off lifts the cap (live).
    ctl set '{"path":"player.scene_throttle","value":false}' >/dev/null
    sleep 2.5
    cur=$(worker_of "$id" | jq -c '{fps_target, throttle}')
    check "scene_throttle off lifts the cap" "$cur" "throttle null, fps_target 144" "$(jq -r 'if .throttle == null and .fps_target > 140 then 1 else 0 end' <<<"$cur")"
    show $OUT_A "$col"; destroy "$id"
    serve_down
    step_end
}

# ------------------------------------------------------------------ step 5 — several workers
# Distinct scenes per output + S→S on both outputs at once (real scenes: every switch done, the
# old workers reaped). Transport: the compositor's CPU per worker vs a decode-free baseline with
# the same presents (synthetic workers at the refresh), ≤ 0.6 % of a core per worker.
step_workers() {
    step_begin workers
    serve_up wayland
    local col a b ca cb t0 n s1 s2 s3 s4 i1 i2 base2 cpu2 basef cpu4 per2 per4 w ib2 kb2 ic2 kc2 ibf kbf ic4 kc4
    col=$(create_color '[40,40,40]')
    show $OUT_A "$col"; show $OUT_B "$col"
    # Real scenes, one per output, then S→S on both at once.
    a=$(create_scene "$SC_EMILIA"); b=$(create_scene "$SC_BUNK")
    show $OUT_A "$a"; show $OUT_B "$b"
    wait_ready "$a" 20 && wait_ready "$b" 20 || die "real scenes never ready"
    sleep 3
    w=$(workers_json)
    say "two real scenes: $(jq -c '[.workers[] | {id, pid, fps_actual, size}]' <<<"$w")"
    check "two distinct real scenes, two workers" "$(jq -c '[.workers[] | select(.pid != null) | {id, fps_actual}]' <<<"$w")" "2 workers at ~30 fps" \
        "$(jq -r 'if ([.workers[] | select(.pid != null and .fps_actual >= 27)] | length) == 2 then 1 else 0 end' <<<"$w")"
    t0=$(now_ms)
    ca=$(ctl transition "$(jq -nc --arg o "out:$OUT_A" --arg p "$SC_KIMI" '{outputs:$o, to:{kind:"scene", path:$p}, effect_id:"fade", duration_ms:1500}')" | jq -r .corr)
    cb=$(ctl transition "$(jq -nc --arg o "out:$OUT_B" --arg p "$SC_EMILIA" '{outputs:$o, to:{kind:"scene", path:$p}, effect_id:"fade", duration_ms:1500}')" | jq -r .corr)
    for _ in $(seq 150); do
        n=$(events_since "$t0" "transition.done" | jq --arg a "$ca" --arg b "$cb" '[.[] | select(.corr == $a or .corr == $b)] | length')
        [[ $n == 2 ]] && break
        sleep 0.1
    done
    sleep 1.5
    w=$(workers_json)
    say "after S→S on both: done $n/2, $(jq -c '{workers: [.workers[] | {id, pid, path: (.path | split("/") | last)}], reaping}' <<<"$w")"
    check "S→S on both outputs at once (real scenes)" "done $n/2, live workers $(jq '[.workers[] | select(.pid != null)] | length' <<<"$w"), reaping $(jq .reaping <<<"$w")" "both done, 2 workers, 0 reaping" \
        "$(jq -r --arg n "$n" 'if $n == "2" and ([.workers[] | select(.pid != null)] | length) == 2 and .reaping == 0 then 1 else 0 end' <<<"$w")"
    note "failed/cancelled in that switch: $(events_since "$t0" "transition." | jq -c '[.[] | select(.event == "transition.failed" or .event == "transition.cancelled") | {event, reason}]')"
    show $OUT_A "$col"; show $OUT_B "$col"
    for i in $(workers_json | jq -r '.workers[].id'); do destroy "$i"; done
    sleep 2

    # Transport. Synthetic frame_index workers at the refresh (scene_fps 0) — no audio, ~0 GPU.
    ctl set '{"path":"out:*.scene_fps","value":0}' >/dev/null
    s1=$(mk_scene t1 "$SYN_FI"); s2=$(mk_scene t2 "$SYN_FI"); s3=$(mk_scene t3 "$SYN_FI"); s4=$(mk_scene t4 "$SYN_FI")
    ctl animate '{"path":"lay:*:main.opacity","from":1,"to":0.97,"duration_ms":9000}' >/dev/null
    sleep 1.5
    read -r base2 ib2 kb2 < <(cpu_insns "$PLAYER_PID" 5)
    sleep 2.6
    ctl set '{"path":"lay:*:main.opacity","value":1}' >/dev/null
    i1=$(create_scene "$s1"); i2=$(create_scene "$s2")
    show $OUT_A "$i1"; show $OUT_B "$i2"
    wait_ready "$i1" 20 && wait_ready "$i2" 20 || die "synthetic scenes never ready"
    sleep 2
    read -r cpu2 ic2 kc2 < <(cpu_insns "$PLAYER_PID" 5)
    per2=$(python3 -c "print(round(($cpu2 - $base2) / 2, 2))")
    say "transport, 2 workers: compositor $cpu2 % vs $base2 % (colour + animation) → $per2 % per worker; Ginsn/s user (kernel) $ic2 ($kc2) vs $ib2 ($kb2); $(workers_json | jq -c '[.workers[] | {fps_actual}]')"
    check "transport per worker (2 workers at 144/240 fps)" "$per2 % ($cpu2 − $base2 baseline, / 2)" "≤ 0.6 % of a core" "$(le "$per2" 0.6)"
    # 4 workers: an 8 s full-live fade S→S on both outputs, vs the same fade colour → colour.
    show $OUT_A "$col"; show $OUT_B "$col"
    destroy "$i1"; destroy "$i2"; sleep 2
    ctl transition '{"outputs":"out:*","to":{"kind":"color","color":[60,60,60]},"effect_id":"fade","duration_ms":8000}' >/dev/null
    sleep 1.5
    read -r basef ibf kbf < <(cpu_insns "$PLAYER_PID" 5)
    sleep 2.5
    i1=$(create_scene "$s1"); i2=$(create_scene "$s2")
    show $OUT_A "$i1"; show $OUT_B "$i2"
    wait_ready "$i1" 20 && wait_ready "$i2" 20 || die "synthetic scenes never ready"
    sleep 1
    ctl transition "$(jq -nc --arg o "out:$OUT_A" --arg p "$s3" '{outputs:$o, to:{kind:"scene", path:$p}, effect_id:"fade", duration_ms:8000}')" >/dev/null
    ctl transition "$(jq -nc --arg o "out:$OUT_B" --arg p "$s4" '{outputs:$o, to:{kind:"scene", path:$p}, effect_id:"fade", duration_ms:8000}')" >/dev/null
    sleep 1.5
    n=$(workers_json | jq '[.workers[] | select(.pid != null)] | length')
    read -r cpu4 ic4 kc4 < <(cpu_insns "$PLAYER_PID" 5)
    per4=$(python3 -c "print(round(($cpu4 - $basef) / 4, 2))")
    say "transport, $n workers mid-fade: compositor $cpu4 % vs $basef % (colour → colour fade) → $per4 % per worker; Ginsn/s user (kernel) $ic4 ($kc4) vs $ibf ($kbf)"
    note "instructions (G/s, user (kernel)): 2 workers $ic2 ($kc2) vs $ib2 ($kb2); $n workers mid-fade $ic4 ($kc4) vs $ibf ($kbf)"
    check "transport per worker ($n workers, S→S full-live on both outputs)" "$per4 % ($cpu4 − $basef baseline, / 4)" "≤ 0.6 % of a core" "$([[ $n == 4 ]] && le "$per4" 0.6 || echo 0)"
    sleep 3
    serve_down
    step_end
}

# ------------------------------------------------------------------ transport (step 5's CPU part, headless)
# Step 5's two transport measurements on headless outputs (VIRTUAL-1 @144, VIRTUAL-2 @240 — the
# real outputs' rates), so they need no session and can be A/B'd between builds: compositor CPU
# per synthetic worker steady (2 workers) and mid-fade (4 workers, an S→S full-live fade on both
# outputs), each against a decode-free baseline with the same presents. TRANSPORT_ROUNDS
# (default 3) alternating rounds; PERF_S > 0 also records `perf` of the compositor mid-fade
# (PERF_CG: the call-graph mode, default dwarf — a release build has no frame pointers).
# CPU % of the compositor over $2 s plus its user-space instructions retired in that window
# (`perf stat`, in G/s, summed over the hybrid CPU's core + atom PMUs — far steadier than CPU
# time on a shared, frequency-scaling machine).
# PERF_SUDO=1 also counts kernel instructions (`instructions:k`, root only here): a third column,
# else "null" — syscalls (worker messages, fences, epoll) are CPU time the user count misses.
cpu_insns() {
    local f=$SCRATCH/insns.$$ c ev=instructions:u sudo=()
    [[ ${PERF_SUDO:-0} == 1 ]] && { sudo=(sudo); ev=instructions:u,instructions:k; }
    "${sudo[@]}" "$(nix shell nixpkgs#perf -c sh -c 'command -v perf')" stat -x, -e "$ev" -o "$f" -p "$1" -- sleep "$2" >/dev/null 2>&1 &
    local pp=$!
    c=$(cpu_pct "$1" "$2")
    wait "$pp"
    printf '%s %s %s\n' "$c" "$(awk -F, -v s="$2" '$3 ~ /instructions(:|\/)u/ {n += $1} END {printf "%.3f", n / s / 1e9}' "$f")" \
        "$(awk -F, -v s="$2" '$3 ~ /instructions(:|\/)k/ {n += $1; k = 1} END {if (k) printf "%.3f", n / s / 1e9; else print "null"}' "$f")"
}
# The loop's own counters (`probe loop`), and their rates per second between two of them.
loop_counts() { ctl probe '{"name":"loop"}' | jq -c '{iterations, wakes, ticks, gain_ticks}'; }
loop_rates() { jq -nc --argjson a "$1" --argjson b "$2" --argjson s "$3" '$b | with_entries(.value = ((.value - $a[.key]) / $s | round))'; }
# PERF_S > 0: `perf record` the compositor for PERF_S s in round 1's colour fade (`basefade`) and
# mid-fade (`midfade`) windows → <results>/transport-<name>.perf (PERF_SUDO=1: as root, with kernel
# samples — this machine's perf_event_paranoid 2 allows user-only; PERF_TRACE=1: `perf trace -s` of the
# main thread's syscalls instead → transport-<name>.trace).
transport_perf() {
    ((${PERF_S:-0} > 0 && r == 1)) || return 0
    local o=$RESULTS/transport-$1.perf sudo=()
    [[ ${PERF_SUDO:-0} == 1 ]] && sudo=(sudo)
    if [[ ${PERF_TRACE:-0} == 1 ]]; then # the main thread's syscalls instead (counts, times)
        sudo "$(nix shell nixpkgs#perf -c sh -c 'command -v perf')" trace ${PERF_TRACE_ARGS:--s} -t "$PLAYER_PID" -o "${o%.perf}.trace" \
            -- sleep "$PERF_S" >/dev/null 2>&1 &
    else
        "${sudo[@]}" "$(nix shell nixpkgs#perf -c sh -c 'command -v perf')" record -q --call-graph "${PERF_CG:-dwarf}" \
            -o "$o" -p "$PLAYER_PID" -- sleep "$PERF_S" >/dev/null 2>&1 &
    fi
    perf_pid=$!
}
step_transport() {
    step_begin transport
    local OUT_A=VIRTUAL-1 OUT_B=VIRTUAL-2 r rounds=${TRANSPORT_ROUNDS:-3}
    serve_up "headless:1920x1080@144,1920x1080@240"
    local col s1 s2 s3 s4 i1 i2 base2 cpu2 basef cpu4 per2 per4 n perf_pid= all2=() all4=() l0 l4 lbf ib2 ic2 ibf ic4 kb2 kc2 kbf kc4
    col=$(create_color '[40,40,40]')
    ctl set '{"path":"out:*.scene_fps","value":0}' >/dev/null
    s1=$(mk_scene t1 "$SYN_FI"); s2=$(mk_scene t2 "$SYN_FI"); s3=$(mk_scene t3 "$SYN_FI"); s4=$(mk_scene t4 "$SYN_FI")
    for ((r = 1; r <= rounds; r++)); do
        show $OUT_A "$col"; show $OUT_B "$col"
        ctl animate '{"path":"lay:*:main.opacity","from":1,"to":0.97,"duration_ms":9000}' >/dev/null
        sleep 1.5
        read -r base2 ib2 kb2 < <(cpu_insns "$PLAYER_PID" 5)
        sleep 2.6
        ctl set '{"path":"lay:*:main.opacity","value":1}' >/dev/null
        i1=$(create_scene "$s1"); i2=$(create_scene "$s2")
        show $OUT_A "$i1"; show $OUT_B "$i2"
        wait_ready "$i1" 20 && wait_ready "$i2" 20 || die "synthetic scenes never ready"
        sleep 2
        read -r cpu2 ic2 kc2 < <(cpu_insns "$PLAYER_PID" 5)
        per2=$(python3 -c "print(round(($cpu2 - $base2) / 2, 2))")
        show $OUT_A "$col"; show $OUT_B "$col"
        destroy "$i1"; destroy "$i2"; sleep 2
        ctl transition '{"outputs":"out:*","to":{"kind":"color","color":[60,60,60]},"effect_id":"fade","duration_ms":8000}' >/dev/null
        sleep 1.5
        transport_perf basefade
        l0=$(loop_counts)
        read -r basef ibf kbf < <(cpu_insns "$PLAYER_PID" 5)
        lbf=$(loop_rates "$l0" "$(loop_counts)" 5)
        [[ -n $perf_pid ]] && wait "$perf_pid"
        perf_pid=
        sleep 2.5
        i1=$(create_scene "$s1"); i2=$(create_scene "$s2")
        show $OUT_A "$i1"; show $OUT_B "$i2"
        wait_ready "$i1" 20 && wait_ready "$i2" 20 || die "synthetic scenes never ready"
        sleep 1
        ctl transition "$(jq -nc --arg o "out:$OUT_A" --arg p "$s3" '{outputs:$o, to:{kind:"scene", path:$p}, effect_id:"fade", duration_ms:8000}')" >/dev/null
        ctl transition "$(jq -nc --arg o "out:$OUT_B" --arg p "$s4" '{outputs:$o, to:{kind:"scene", path:$p}, effect_id:"fade", duration_ms:8000}')" >/dev/null
        sleep 1.5
        n=$(workers_json | jq '[.workers[] | select(.pid != null)] | length')
        transport_perf midfade
        l0=$(loop_counts)
        read -r cpu4 ic4 kc4 < <(cpu_insns "$PLAYER_PID" 5)
        l4=$(loop_rates "$l0" "$(loop_counts)" 5)
        [[ -n $perf_pid ]] && wait "$perf_pid"
        perf_pid=
        per4=$(python3 -c "print(round(($cpu4 - $basef) / 4, 2))")
        say "round $r: 2 workers $cpu2 vs $base2 % → $per2 % per worker; $n workers mid-fade $cpu4 vs $basef % → $per4 % per worker; Ginsn/s user (kernel): 2 workers $ic2 ($kc2) vs $ib2 ($kb2), mid-fade $ic4 ($kc4) vs $ibf ($kbf); loop/s mid-fade $l4 vs $lbf"
        jq -nc --argjson r "$r" --argjson c2 "$cpu2" --argjson b2 "$base2" --argjson c4 "$cpu4" --argjson bf "$basef" \
            --argjson i2 "${ic2:-null}" --argjson ib2 "${ib2:-null}" --argjson i4 "${ic4:-null}" --argjson ibf "${ibf:-null}" \
            --argjson l4 "${l4:-null}" --argjson lbf "${lbf:-null}" \
            --argjson k2 "${kc2:-null}" --argjson kb2 "${kb2:-null}" --argjson k4 "${kc4:-null}" --argjson kbf "${kbf:-null}" \
            '{round:$r, cpu2:$c2, base2:$b2, cpu4:$c4, basef:$bf, insn2:$i2, insn_base2:$ib2, insn4:$i4, insn_basef:$ibf,
              kinsn2:$k2, kinsn_base2:$kb2, kinsn4:$k4, kinsn_basef:$kbf, loop4:$l4, loop_basef:$lbf}' >>"$RESULTS/transport-rounds.jsonl"
        all2+=("$per2"); all4+=("$per4")
        sleep 7
        show $OUT_A "$col"; show $OUT_B "$col"
        for i in $(workers_json | jq -r '.workers[].id'); do destroy "$i"; done
        sleep 2
    done
    local m2 m4
    m2=$(python3 -c "import statistics,sys; print(round(statistics.median(map(float, sys.argv[1:])), 2))" "${all2[@]}")
    m4=$(python3 -c "import statistics,sys; print(round(statistics.median(map(float, sys.argv[1:])), 2))" "${all4[@]}")
    check "transport per worker steady (2 workers, 144/240 Hz headless), median of $rounds" "$m2 % (rounds: ${all2[*]})" "≤ 0.6 % of a core" "$(le "$m2" 0.6)"
    check "transport per worker mid-fade (4 workers), median of $rounds" "$m4 % (rounds: ${all4[*]})" "≤ 0.6 % of a core" "$(le "$m4" 0.6)"
    serve_down
    step_end
}

# ------------------------------------------------------------------ step 6 — pause on a scripted scene
# Paused 10 s → the first frame after the resume continues where the scene stopped (patch 0005:
# a script's setTimeout/setInterval run on the scene's own clock, which a pause excises). Exact on
# the synthetic frame_index (scene time + seq), compared by picture on Bunk (32 scripts).
# scene_fps 5, so a capture right after the next frame latched is that frame.
latched_n() { worker_of "$1" | jq -r '.latched'; }
step_pause() {
    step_begin pause
    serve_up "headless:1920x1080@60"
    ctl set '{"path":"out:*.scene_fps","value":5}' >/dev/null
    local label path id n0 tb ta c d_step d_10s d_res d_held t_before t_after
    for label in synthetic bunk-2134765860; do
        case $label in synthetic) path=$(mk_scene pausefi "$SYN_FI") ;; *) path=$SC_BUNK ;; esac
        id=$(create_scene "$path")
        show VIRTUAL-1 "$id"
        wait_ready "$id" 20 || die "$label never ready"
        sleep 3
        c=$RESULTS/pause-$label
        # Controls: two consecutive frames, and two frames 10 s apart, unpaused.
        n0=$(latched_n "$id"); ctl capture "{\"target\":\"$id\",\"path\":\"$c-n0.png\"}" >/dev/null
        for _ in $(seq 100); do [[ $(latched_n "$id") != "$n0" ]] && break; sleep 0.01; done
        ctl capture "{\"target\":\"$id\",\"path\":\"$c-n1.png\"}" >/dev/null
        sleep 10
        ctl capture "{\"target\":\"$id\",\"path\":\"$c-n10.png\"}" >/dev/null
        d_step=$(img_diff "$c-n0.png" "$c-n1.png"); d_10s=$(img_diff "$c-n0.png" "$c-n10.png")
        # Pause (the player's own pause), 10 s, resume.
        ctl set '{"path":"player.paused","value":true}' >/dev/null
        sleep 0.6
        tb=$(worker_of "$id" | jq -c '{latched, latched_t, scene_time}')
        ctl capture "{\"target\":\"$id\",\"path\":\"$c-p0.png\"}" >/dev/null
        sleep 10
        ctl capture "{\"target\":\"$id\",\"path\":\"$c-p1.png\"}" >/dev/null
        n0=$(jq -r .latched <<<"$tb")
        ctl set '{"path":"player.paused","value":false}' >/dev/null
        for _ in $(seq 300); do [[ $(latched_n "$id") != "$n0" ]] && break; sleep 0.005; done
        ctl capture "{\"target\":\"$id\",\"path\":\"$c-r1.png\"}" >/dev/null
        ta=$(worker_of "$id" | jq -c '{latched, latched_t, scene_time}')
        d_res=$(img_diff "$c-p0.png" "$c-r1.png"); d_held=$(img_diff "$c-p0.png" "$c-p1.png")
        t_before=$(jq -r .latched_t <<<"$tb"); t_after=$(jq -r .latched_t <<<"$ta")
        say "$label: before $tb, after $ta; diffs: held $d_held, resume $d_res, one frame $d_step, 10 s $d_10s"
        check "$label: held through the 10 s pause" "diff $d_held" "identical (0)" "$(python3 -c "print(1 if float('$d_held') == 0 else 0)")"
        # The resumed clock ticks at once (its grid slot passed during the pause): the first
        # frame is ≤ one tick (0.2 s) of scene time after the held one — never the 10 s paused.
        # (≤ 0.5 s: the capture poll can land on the second frame after the resume.)
        check "$label: scene time continues (not +10 s)" "latched_t $t_before → $t_after" "0 < Δ ≤ 0.5 s (≪ the 10 s paused)" "$(python3 -c "d = $t_after - $t_before; print(1 if 0 < d <= 0.5 else 0)")"
        if [[ $label == synthetic ]]; then
            local m0 m1
            m0=$(python3 -c "from PIL import Image; print(list(Image.open('$c-p0.png').convert('RGB').getpixel((10,10))))")
            m1=$(python3 -c "from PIL import Image; print(list(Image.open('$c-r1.png').convert('RGB').getpixel((10,10))))")
            check "$label: first frame after the resume is the next seq" "marker $m0 → $m1" "+1" "$(python3 -c "a=$m0; b=$m1; print(1 if (b[0]+256*b[1]) - (a[0]+256*a[1]) == 1 else 0)")"
        else
            check "$label: first frame after the resume ≈ the last before" "diff $(fnum "$d_res" 3) (one frame unpaused $(fnum "$d_step" 3), 10 s apart $(fnum "$d_10s" 3))" "≤ one frame × 1.5 + 0.05" \
                "$(python3 -c "print(1 if $d_res <= $d_step * 1.5 + 0.05 else 0)")"
        fi
        destroy "$id"; sleep 1
    done
    serve_down
    step_end
}

# ------------------------------------------------------------------ step 7 — soak
# SOAK_MIN minutes on both real outputs: 2 videos, 2 synthetic scenes, 2 SFW scenes, a switch
# every 30 s (out:*), methods and effects rotating. Bounds: compositor RSS slope ≤ 0.5 MiB/min
# (after a 10 min warm-up), live workers ≤ 2 (+ dying) at every sample, each scene worker's VRAM
# flat ± 10 % across its plays, no worker after `ctl stop`.
soak_sample() { # → one JSON line
    local rec wj vj smi
    rec=$(python3 - "$PLAYER_PID" <<'PY'
import sys, json, subprocess
pid = sys.argv[1]
rss = hwm = None
for line in open(f"/proc/{pid}/status"):
    if line.startswith("VmRSS:"): rss = int(line.split()[1])
    if line.startswith("VmHWM:"): hwm = int(line.split()[1])
kids = subprocess.run(["pgrep", "-P", pid, "-x", "liascape-scene-worker"], capture_output=True, text=True).stdout.split()
print(json.dumps({"rss_kib": rss, "hwm_kib": hwm, "worker_children": [int(k) for k in kids]}))
PY
)
    wj=$(workers_json); vj=$(ctl probe '{"name":"vram"}')
    smi=$(nvidia-smi -q -d PIDS 2>/dev/null | python3 -c '
import sys, json, re
out = {}; pid = None
for line in sys.stdin:
    m = re.search(r"Process ID\s*:\s*(\d+)", line)
    if m: pid = m.group(1)
    m = re.search(r"Used GPU Memory\s*:\s*(\d+)\s*MiB", line)
    if m and pid: out[pid] = int(m.group(1)); pid = None
print(json.dumps(out))')
    [[ -n $smi ]] || smi='{}'
    jq -nc --argjson t "$1" --argjson r "$rec" --argjson w "$wj" --argjson v "$vj" --argjson smi "$smi" --argjson n "$2" \
        '{t_s:$t, switches:$n, rss_kib:$r.rss_kib, hwm_kib:$r.hwm_kib, children:$r.worker_children,
          workers:[$w.workers[] | {id, pid, path:(.path | split("/") | last), state}], reaping:$w.reaping,
          vram_procs:($v.sample.procs // null), vram_free:($v.sample.free_mib // null), smi:$smi}'
}
step_soak() {
    step_begin soak
    serve_up wayland
    local v1 v2 y1 y2 items methods effects
    v1=$(mk_clip soak1080 testsrc2 30 20 440 1920x1080)
    v2=$(mk_clip soak720 smptebars 60 12 330 1280x720)
    y1=$(mk_scene soak-a '{"pattern":"frame_index","native":[1920,1080],"has_audio":true,"tone_hz":550,"tone_dbfs":-20}')
    y2=$(mk_scene soak-b '{"pattern":"split_tb","rgb":[200,60,60],"rgb2":[60,60,200],"native":[2560,1440]}')
    items=("video:$v1" "scene:$y1" "scene:$SC_EMILIA" "video:$v2" "scene:$y2" "scene:$SC_KIMI")
    methods=(full-live reveal frozen)
    mapfile -t effects < <(ctl effects | jq -r '.ids[]' | grep -E '^(fade|crosswarp|wipeLeft|Dreamy|circleopen|directionalwarp)$')
    ((${#effects[@]})) || effects=(fade)
    local samples=$RESULTS/soak-samples.jsonl switches=$RESULTS/soak-switches.jsonl
    : >"$samples"; : >"$switches"; : >"$RESULTS/soak-outcomes.jsonl"
    local t_start t_end now_s next_sw=0 n=0 to item kind path m e corr= line
    t_start=$(date +%s)
    t_end=$((t_start + SOAK_MIN * 60))
    say "soak: ${#items[@]} items, methods ${methods[*]}, effects ${effects[*]}, $SOAK_MIN min"
    while (( $(date +%s) < t_end )); do
        kill -0 "$SERVE_PID" 2>/dev/null || die "serve died during the soak"
        now_s=$(date +%s)
        if (( now_s >= next_sw )); then
            # The previous switch's outcome (its last transition.* event), 30 s on.
            if [[ -n $corr ]]; then
                jq -nc --arg corr "$corr" --arg out "$(ctl logs "{\"corr\":\"$corr\",\"kind_prefix\":\"transition.\"}" | jq -r '.events[-1].kind // "none"')" \
                    '{corr:$corr, outcome:$out}' >>"$RESULTS/soak-outcomes.jsonl"
            fi
            item=${items[$((n % ${#items[@]}))]}; kind=${item%%:*}; path=${item#*:}
            m=${methods[$((n % ${#methods[@]}))]}; e=${effects[$((n % ${#effects[@]}))]}
            if [[ $kind == video ]]; then to=$(jq -nc --arg p "$path" '{path:$p, loop:true}'); else to=$(jq -nc --arg p "$path" '{kind:"scene", path:$p}'); fi
            corr=$(ctl transition "$(jq -nc --argjson to "$to" --arg m "$m" --arg e "$e" '{outputs:"out:*", to:$to, effect_id:$e, duration_ms:1000, method:$m}')" | jq -r '.corr // empty')
            jq -nc --argjson n "$n" --arg item "$(basename "$path")" --arg m "$m" --arg e "$e" --arg corr "$corr" --argjson t "$((now_s - t_start))" \
                '{n:$n, t_s:$t, item:$item, method:$m, effect:$e, corr:$corr}' >>"$switches"
            n=$((n + 1)); next_sw=$((now_s + 30))
            if (( n % 20 == 0 )); then say "soak: $n switches, RSS $(awk '/VmRSS/ {print $2}' /proc/"$PLAYER_PID"/status) KiB"; fi
        fi
        line=$(soak_sample "$((now_s - t_start))" "$n") && echo "$line" >>"$samples"
        sleep 5
    done
    # Outcomes of the last 20 switches (older ones may have left the in-memory log ring).
    local outcomes errs left a
    outcomes=$(jq -r '.outcome' "$RESULTS/soak-outcomes.jsonl" | sort | uniq -c | tr '\n' ' ')
    note "switch outcomes (each switch's last transition event, 30 s on): $outcomes"
    local bad
    bad=$(jq -s '[.[] | select(.outcome != "transition.done")] | length' "$RESULTS/soak-outcomes.jsonl")
    check "every switch done" "$bad of $(jq -s length "$RESULTS/soak-outcomes.jsonl") not transition.done ($outcomes)" "0" "$([[ $bad == 0 ]] && echo 1 || echo 0)"
    errs=$(ctl logs '{"min_level":"warn","limit":10000}' | jq -c '[.events[] | .kind] | group_by(.) | map({(.[0]): length}) | add // {}')
    note "warn+ events still in the ring at the end: $errs"
    # Stop → no worker.
    ctl stop >/dev/null
    sleep 2
    left=$(pgrep -P "$PLAYER_PID" -x liascape-scene-worker | tr '\n' ' ')
    check "no worker after ctl stop (2 s)" "${left:-none}" "none" "$([[ -z $left ]] && echo 1 || echo 0)"
    a=$(python3 - "$samples" "$switches" <<'PY'
import sys, json, statistics
S = [json.loads(l) for l in open(sys.argv[1])]
W = [json.loads(l) for l in open(sys.argv[2])]
def slope(pts):
    if len(pts) < 3: return None
    xs, ys = zip(*pts); mx, my = statistics.mean(xs), statistics.mean(ys)
    return sum((x - mx) * (y - my) for x, y in pts) / sum((x - mx) ** 2 for x in xs)
rss = [(s["t_s"] / 60, s["rss_kib"] / 1024) for s in S if s["rss_kib"]]
warm = [p for p in rss if p[0] >= 10] or rss
live = [len([w for w in s["workers"] if w["pid"]]) for s in S]
excess = [s["t_s"] for s in S if len([w for w in s["workers"] if w["pid"]]) > 2 + (s["reaping"] or 0)]
plays = {}
for s in S:
    for w in s["workers"]:
        if not w["pid"]: continue
        p = str(w["pid"]); v = (s["vram_procs"] or {}).get(p) or s["smi"].get(p)
        if v: plays.setdefault((w["path"], p), []).append(v)
per_item = {}
for (path, pid), vs in sorted(plays.items(), key=lambda kv: min(i for i, s in enumerate(S) for w in s["workers"] if str(w["pid"]) == kv[0][1])):
    if len(vs) >= 2: per_item.setdefault(path, []).append(statistics.median(vs))
flat = {k: {"plays": len(v), "first": v[0], "min": min(v), "max": max(v),
            "dev_pct": round(max(abs(x - v[0]) for x in v) / v[0] * 100, 1)} for k, v in per_item.items()}
ws = slope(warm); al = slope(rss)
print(json.dumps({"samples": len(S), "switches": len(W), "minutes": round(S[-1]["t_s"] / 60, 1) if S else 0,
    "rss_first_mib": round(rss[0][1], 1) if rss else None, "rss_last_mib": round(rss[-1][1], 1) if rss else None,
    "rss_slope_mib_min": round(ws, 3) if ws is not None else None,
    "rss_slope_all_mib_min": round(al, 3) if al is not None else None,
    "max_live_workers": max(live) if live else None, "samples_over_2_plus_dying": len(excess), "over_at_s": excess[:10],
    "vram": flat, "vram_max_dev_pct": max([f["dev_pct"] for f in flat.values()] or [0])}))
PY
)
    echo "$a" >"$RESULTS/soak-analysis.json"
    say "soak analysis: $a"
    check "compositor RSS slope (after 10 min)" "$(jq -r .rss_slope_mib_min <<<"$a") MiB/min ($(jq -r .rss_first_mib <<<"$a") → $(jq -r .rss_last_mib <<<"$a") MiB over $(jq -r .minutes <<<"$a") min, $(jq -r .switches <<<"$a") switches)" "≤ 0.5 MiB/min" \
        "$(le "$(jq -r '.rss_slope_mib_min' <<<"$a")" 0.5)"
    check "live workers ≤ 2 + dying at every sample" "max $(jq -r .max_live_workers <<<"$a"), over the bound in $(jq -r .samples_over_2_plus_dying <<<"$a") of $(jq -r .samples <<<"$a") samples" "0 samples over" \
        "$(jq -r 'if .samples_over_2_plus_dying == 0 then 1 else 0 end' <<<"$a")"
    check "per-worker VRAM flat across plays" "$(jq -c '.vram | map_values({plays, first, min, max, dev_pct})' <<<"$a")" "± 10 %" \
        "$(jq -r 'if (.vram | length) > 0 and .vram_max_dev_pct <= 10 then 1 else 0 end' <<<"$a")"
    serve_down
    step_end
}
