//! Task 11: the transition recipe on the real GPU + libmpv, driven by the loop harness
//! (`tests/common/harness.rs`: SteppedClock paced by wall time — R33 — virtual outputs
//! `VIRTUAL-n` at 640×360, every source `ao: "null"` — R26).
//!
//! Gain/progress assertions sample at exact virtual instants (`tick_to`) and are exact;
//! playback-coupled ones (align End, frame-index corners) allow ± 1 frame (33 ms) / ± 1
//! marker step. Skips (prints `SKIP: …`) only without an EGL device or a catalogue.

mod common;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use common::harness::{FRAME, Harness, from_ms, ms, start_of};
use common::{ClipSpec, ensure_clip};
use lp_player::recipes::TransitionEventKind;
use lp_player::sources::SourceEvent;
use lp_player::units::SILENT_DB;
use serde_json::json;

const RED_10S: ClipSpec = ClipSpec::Solid {
    rgb: [255, 0, 0],
    secs: 10.0,
    tone_hz: 440.0,
    tone_dbfs: -20.0,
};
const BLUE_10S: ClipSpec = ClipSpec::Solid {
    rgb: [0, 0, 255],
    secs: 10.0,
    tone_hz: 660.0,
    tone_dbfs: -20.0,
};
const GREEN_10S: ClipSpec = ClipSpec::Solid {
    rgb: [0, 255, 0],
    secs: 10.0,
    tone_hz: 550.0,
    tone_dbfs: -20.0,
};
const RED_3S: ClipSpec = ClipSpec::Solid {
    rgb: [255, 0, 0],
    secs: 3.0,
    tone_hz: 440.0,
    tone_dbfs: -20.0,
};

fn red10() -> PathBuf {
    ensure_clip("tr_red_10s", RED_10S)
}
fn blue10() -> PathBuf {
    ensure_clip("tr_blue_10s", BLUE_10S)
}
fn green10() -> PathBuf {
    ensure_clip("tr_green_10s", GREEN_10S)
}
fn idx(frames: u32) -> PathBuf {
    ensure_clip(
        &format!("tr_frame_index_{frames}"),
        ClipSpec::FrameIndex { frames },
    )
}
/// R92 review: [`idx`]'s exact visual pattern, with a real audio track — for a B whose
/// onset-wait (`b_has_audio`) must still hold (a plain [`idx`] clip genuinely has no
/// audio stream, so R92's fix correctly skips the wait for it now).
fn idx_with_audio(frames: u32) -> PathBuf {
    ensure_clip(
        &format!("tr_frame_index_audio_{frames}"),
        ClipSpec::FrameIndexWithAudio {
            frames,
            tone_hz: 440.0,
        },
    )
}
fn s(p: &std::path::Path) -> &str {
    p.to_str().unwrap()
}

fn close(got: f64, want: f64, tol: f64, what: &str) {
    assert!((got - want).abs() <= tol, "{what}: {got} vs {want} ± {tol}");
}

const MS: fn(u64) -> Duration = Duration::from_millis;

#[test]
fn full_live_gains() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 1000, "method": "full-live", "align": "now"
    }));
    let b = h.to_of(&corr);
    let t0 = start_of(&h.wait_event(&corr, "transition.started", MS(5000)));

    h.tick_to(t0 + MS(500));
    let fx = h.content("VIRTUAL-1");
    close(
        h.f64(&format!("{a}.gain.xfade")),
        -3.0103,
        0.01,
        "A.gain.xfade at 500 ms",
    );
    close(
        h.f64(&format!("{fx}.progress")),
        0.5,
        0.01,
        "fx.progress at 500 ms",
    );
    assert!(!h.bool(&format!("{a}.paused")) && !h.bool(&format!("{b}.paused")));
    // R85 (Task 16c): B's own xfade-in is held until real audio confirms (bounded by
    // `ONSET_TIMEOUT` = 150 ms) — its exact midpoint value now depends on when mpv's
    // audio-out actually restarted (measured ~19 ms on the owner's machine), not t0, so
    // only assert it is genuinely under way rather than the exact equal-power value: even
    // at the worst-case 150 ms deferral it's at progress (500-150)/1000 = 0.35, well
    // inside this window.
    let b_mid = h.f64(&format!("{b}.gain.xfade"));
    assert!(
        b_mid > SILENT_DB + 1.0 && b_mid < -0.1,
        "B.gain.xfade at 500 ms should be mid-ramp, not silent or already at 0 dB: {b_mid}"
    );

    h.tick_to(t0 + MS(1000));
    h.wait_event(&corr, "transition.done", MS(1000));
    h.tick();
    assert_eq!(h.cur("*"), vec![b.clone()]);
    assert!(!h.exists(&a), "A must be destroyed after the handoff");
    assert!(h.host.get(&a).is_none(), "A's live source must be dropped");
    assert!(!h.exists(&fx), "the effect node must be destroyed");
    close(h.gain(&b), 0.0, 1e-9, "B at 0 dB after the transition");
}

#[test]
fn reveal_holds_a_silent() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&idx(300), json!({"loop": true}), &["VIRTUAL-1"]);
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 1000, "method": "reveal"
    }));
    let b = h.to_of(&corr);
    let t0 = start_of(&h.wait_event(&corr, "transition.started", MS(5000)));

    h.tick_to(t0 + MS(100));
    assert!(
        h.bool(&format!("{a}.paused")),
        "A is held (paused) at 100 ms"
    );
    assert!(h.gain(&a) <= -90.0, "held A is silent: {} dB", h.gain(&a));
    // The held picture is a still copy of A's frame (fx.from = a snapshot of A).
    let fx = h.content("VIRTUAL-1");
    let shot = h.str(&format!("{fx}.from"));
    assert_eq!(h.str(&format!("{shot}.kind")), "snapshot");
    assert_eq!(h.str(&format!("{shot}.of")), a);
    let held = h.corner(&shot).expect("held picture");
    let tp_held = h.f64(&format!("{a}.time_pos"));
    let mut b_gain = vec![h.f64(&format!("{b}.gain.xfade"))];
    // 10 steps, one 30 fps frame apart (a playing A would advance ~10 markers).
    for i in 0..10 {
        let next = h.now() + FRAME;
        h.tick_to(next);
        assert_eq!(
            h.corner(&shot),
            Some(held),
            "A's held picture changed at step {i}"
        );
        let tp = h.f64(&format!("{a}.time_pos"));
        assert_eq!(
            tp, tp_held,
            "A's playback moved at step {i}: held A must be paused"
        );
        assert!(h.gain(&a) <= -90.0);
        assert!(h.bool(&format!("{a}.paused")));
        assert!(!h.bool(&format!("{b}.paused")), "B plays live in reveal");
        b_gain.push(h.f64(&format!("{b}.gain.xfade")));
    }
    assert!(
        b_gain.windows(2).all(|w| w[1] >= w[0]),
        "B's gain must rise: {b_gain:?}"
    );
    assert!(
        b_gain.last().unwrap() > &(b_gain[0] + 0.5),
        "B's gain must rise: {b_gain:?}"
    );
}

#[test]
fn frozen_silent_then_b_starts() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&idx(300), json!({"loop": true}), &["VIRTUAL-1"]);
    // R92 review: B must genuinely have an audio track for this test's onset-wait
    // assertions to mean anything — a plain `idx(300)` (no audio at all) now correctly
    // skips the wait entirely (`b_has_audio`), which is the fix this test's sibling,
    // `tests/api.rs::r92_transition_onto_video_with_no_audio_skips_onset_wait`, covers.
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&idx_with_audio(300)), "loop": true},
        "effect_id": "fade", "duration_ms": 1000, "method": "frozen"
    }));
    let b = h.to_of(&corr);
    let t0 = start_of(&h.wait_event(&corr, "transition.started", MS(5000)));

    h.tick_to(t0 + MS(100));
    let shot = h.str(&format!("{}.from", h.content("VIRTUAL-1")));
    assert_eq!(
        h.str(&format!("{shot}.of")),
        a,
        "A's picture is held as a snapshot"
    );
    let (ca, cb) = (h.corner(&shot).unwrap(), h.corner(&b).unwrap());
    let tp_held = h.f64(&format!("{a}.time_pos"));
    assert!(cb <= 1, "B holds its first frame (marker 0 ± 1), got {cb}");
    for i in 0..10 {
        for id in [&a, &b] {
            assert!(h.bool(&format!("{id}.paused")), "{id} paused at step {i}");
            assert!(h.gain(id) <= -90.0, "{id} silent: {} dB", h.gain(id));
        }
        let tp = h.f64(&format!("{a}.time_pos"));
        assert_eq!(
            tp, tp_held,
            "A's playback moved at step {i}: held A must be paused"
        );
        assert_eq!(
            h.corner(&shot),
            Some(ca),
            "A's held picture changed at step {i}"
        );
        assert_eq!(h.corner(&b), Some(cb), "B's held frame changed at step {i}");
        let next = h.now() + FRAME;
        h.tick_to(next);
    }

    let th = from_ms(h.wait_event(&corr, "transition.handoff", MS(2000)).at_ms);
    assert!(!h.bool(&format!("{b}.paused")), "B starts at the end");
    // R85 (Task 16c): this is the exact bug the owner reported — B un-pauses at handoff
    // with essentially no lead time, so its anti-click ramp-in now waits for real audio
    // (`SourceEvent::AudioFlowing`) instead of starting at the un-pause instant. Right at
    // the 30 ms mark it must still be silent (never an unramped/early onset); it must
    // still reach 0 dB well within `ONSET_TIMEOUT` (150 ms) + the ramp itself (30 ms).
    h.tick_to(th + MS(30));
    close(
        h.gain(&b),
        SILENT_DB,
        1e-6,
        "B still silent at 30 ms: onset waits for real audio",
    );
    let ok = h.tick_until(MS(500), |h| (h.gain(&b) - 0.0).abs() < 1e-6);
    assert!(ok, "B never reached 0 dB (onset never confirmed/timed out)");
    let ok = h.tick_until(MS(1000), |h| h.corner(&b).is_some_and(|c| c >= cb + 5));
    assert!(
        ok,
        "B never advanced after the end (corner {:?})",
        h.corner(&b)
    );
}

#[test]
fn align_end_full_live() {
    // VIRTUAL-2 starts empty; it's only used to observe A's real end (below).
    let Some(mut h) = Harness::new(&["VIRTUAL-1", "VIRTUAL-2"]) else {
        return;
    };
    let a = h.play(
        &ensure_clip("tr_red_3s", RED_3S),
        json!({"loop": true}),
        &["VIRTUAL-1"],
    );
    let t_req = h.now();
    let remaining_ms = (h.f64(&format!("{a}.duration")) - h.f64(&format!("{a}.time_pos"))) * 1000.0;
    let corr = h.start(json!({
        "outputs": "out:VIRTUAL-1", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 1000, "method": "full-live", "align": "end"
    }));
    h.tick();
    assert!(
        !h.bool(&format!("{a}.loop")),
        "A's last iteration: loop off while waiting"
    );
    let started = h.wait_event(&corr, "transition.started", MS(6000));
    let progress_one = ms(start_of(&started)) + 1000.0;
    // It waited for A: the effect began ≈ (A's remaining − 1 s) after the request.
    assert!(
        started.at_ms - ms(t_req) >= remaining_ms - 1000.0 - 100.0,
        "full-live End must wait for A: started {:.0} ms after the request, A had {:.0} ms left",
        started.at_ms - ms(t_req),
        remaining_ms
    );
    // Ground truth for "A's end" is A's own `Ended`. The start instant is fixed now; show
    // A on VIRTUAL-2 too, so the handoff keeps it alive (a source still shown elsewhere is
    // never destroyed) and its end can be observed.
    // A's end = its `Ended`, or — once the handoff has restored its loop (R43, below) —
    // the wrap into its next iteration: whichever comes first marks the boundary.
    h.show("VIRTUAL-2", &a);
    let mut last_tp = h.f64(&format!("{a}.time_pos"));
    let mut wrapped_at = None;
    while h.event(&corr, "transition.handoff").is_none()
        || (h.src_event_at(&a, |e| *e == SourceEvent::Ended).is_none() && wrapped_at.is_none())
    {
        assert!(
            h.now() < t_req + MS(8000),
            "A never ended / no handoff: {:?}",
            h.tr_events
        );
        h.tick();
        let tp = h.f64(&format!("{a}.time_pos"));
        if wrapped_at.is_none() && tp + 0.5 < last_tp {
            wrapped_at = Some(ms(h.now()));
        }
        last_tp = tp;
    }
    let ended = h
        .src_event_at(&a, |e| *e == SourceEvent::Ended)
        .map(ms)
        .into_iter()
        .chain(wrapped_at)
        .fold(f64::INFINITY, f64::min);
    let handoff = h.event(&corr, "transition.handoff").expect("handoff");
    println!(
        "align_end_full_live: progress=1 − A's end = {:+.1} ms (handoff tick {:+.1} ms)",
        progress_one - ended,
        handoff.at_ms - ended
    );
    assert!(
        (progress_one - ended).abs() <= 33.4,
        "fx.progress reaches 1 at {progress_one:.1} ms, A's end at {ended:.1} ms"
    );
    // R43: A is still shown on VIRTUAL-2, so the handoff gives it back — playing, audible,
    // its own loop — instead of leaving it faded out with the End's loop change.
    let th = from_ms(handoff.at_ms);
    h.tick_to(th + MS(30));
    h.tick();
    assert!(h.exists(&a), "A still shown on VIRTUAL-2: never destroyed");
    assert!(!h.bool(&format!("{a}.paused")), "A plays on VIRTUAL-2");
    assert!(h.bool(&format!("{a}.loop")), "A's own loop is back");
    close(h.gain(&a), 0.0, 1e-9, "A audible again on VIRTUAL-2");
    assert_eq!(h.cur("VIRTUAL-2"), vec![a.clone()]);
}

#[test]
fn align_end_reveal_starts_at_end() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    // A = 90 frames (3 s), so "A's held frame = its last frame" is checkable (marker 89).
    let a = h.play(&idx(90), json!({"loop": true}), &["VIRTUAL-1"]);
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 1000, "method": "reveal", "align": "end"
    }));
    let started = h.wait_event(&corr, "transition.started", MS(6000));
    let ended = h
        .src_event_at(&a, |e| *e == SourceEvent::Ended)
        .expect("A's Ended event");
    println!(
        "align_end_reveal: started − A's Ended = {:+.1} ms",
        started.at_ms - ms(ended)
    );
    assert!(
        (started.at_ms - ms(ended)).abs() <= 33.4,
        "reveal End starts at A's Ended: started {} ms, Ended {} ms",
        started.at_ms,
        ms(ended)
    );
    h.tick_to(from_ms(started.at_ms) + MS(100));
    // An ended A already holds its last frame (keep-open): it is held as itself.
    let from = h.str(&format!("{}.from", h.content("VIRTUAL-1")));
    assert_eq!(from, a, "an ended A needs no snapshot");
    let c = h.corner(&from).expect("held picture");
    assert!(
        (88..=90).contains(&c),
        "A holds its last frame (89 ± 1), got {c}"
    );
    assert!(h.bool(&format!("{a}.paused")) && h.gain(&a) <= -90.0);
}

#[test]
fn short_a_holds_last_frame() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&idx(15), json!({"loop": true}), &["VIRTUAL-1"]);
    // Request right after A wraps, so the loop change lands long before A's end.
    let ok = h.tick_until(MS(2000), |h| h.corner(&a).is_some_and(|c| c <= 3));
    assert!(ok, "A never wrapped");
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 2000, "method": "full-live", "align": "end"
    }));
    let b = h.to_of(&corr);
    h.tick();
    let mut last = h.corner(&a).unwrap();
    let mut b_ready = None;
    while h.event(&corr, "transition.handoff").is_none() {
        assert!(h.now() < MS(60_000), "no handoff: {:?}", h.tr_events);
        h.tick();
        if b_ready.is_none() {
            b_ready = h.src_event_at(&b, |e| *e == SourceEvent::Ready);
        }
        if let Some(c) = h.corner(&a) {
            assert!(c + 1 >= last, "A rewound: corner {c} after {last}");
            last = last.max(c);
        }
    }
    let started = h.event(&corr, "transition.started").unwrap();
    let b_ready = b_ready.expect("B Ready");
    println!(
        "short_a: started − B ready = {:+.1} ms, A held marker {last}",
        started.at_ms - ms(b_ready)
    );
    assert!(
        started.at_ms - ms(b_ready) <= 33.4,
        "A shorter than the effect: starts as soon as B is ready ({} ms vs Ready {} ms)",
        started.at_ms,
        ms(b_ready)
    );
    assert!(
        (13..=15).contains(&last),
        "A holds its last frame (14 ± 1), got {last}"
    );
}

#[test]
fn image_align_end_is_now() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let img = ensure_clip(
        "tr_image",
        ClipSpec::Image {
            rgb: [200, 100, 50],
        },
    );
    let a = h.play(&img, json!({}), &["VIRTUAL-1"]);
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"kind": "color", "color": [0, 255, 0]},
        "effect_id": "fade", "duration_ms": 300, "method": "reveal", "align": "end"
    }));
    h.tick();
    assert!(
        h.event(&corr, "transition.started").is_some(),
        "End on an image A is Now: started within one tick; events: {:?}",
        h.tr_events
    );
    h.wait_event(&corr, "transition.done", MS(2000));
    let b = h.to_of(&corr);
    assert_eq!(h.cur("VIRTUAL-1"), vec![b]);
    assert!(!h.exists(&a));
    let px = h.out_corner("VIRTUAL-1");
    assert!(px[1] > 250 && px[0] < 5, "output shows B (green): {px:?}");
}

#[test]
fn bad_target_keeps_a() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let gain0 = h.gain(&a);
    let empty = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-media/tr_empty.mkv");
    std::fs::create_dir_all(empty.parent().unwrap()).unwrap();
    std::fs::write(&empty, b"").unwrap();

    for (path, align) in [
        ("/nonexistent/lp-player-tr-missing.mkv".to_string(), "now"),
        (s(&empty).to_string(), "end"),
    ] {
        let corr = h.start(json!({
            "outputs": "out:*", "to": {"path": path, "loop": true},
            "effect_id": "fade", "duration_ms": 500, "method": "reveal", "align": align
        }));
        let b = h.to_of(&corr);
        if align == "end" {
            assert!(
                !h.bool(&format!("{a}.loop")),
                "waiting on End turns A's loop off"
            );
        }
        let mut failed = None;
        for _ in 0..2000 {
            h.tick();
            assert_eq!(h.cur("*"), vec![a.clone()], "A stays current ({path})");
            assert_eq!(h.gain(&a), gain0, "A's gain never changes ({path})");
            assert!(!h.bool(&format!("{a}.paused")), "A never paused ({path})");
            failed = h.event(&corr, "transition.failed");
            if failed.is_some() || h.now() > MS(30_000) {
                break;
            }
        }
        match failed.map(|e| e.kind) {
            Some(TransitionEventKind::Failed { path: p, reason }) => {
                assert_eq!(p, path);
                assert!(
                    !reason.is_empty() && reason.contains(&path),
                    "reason: {reason}"
                );
            }
            other => panic!(
                "no transition.failed for {path}: {other:?}; {:?}",
                h.tr_events
            ),
        }
        assert!(!h.exists(&b), "the failed B is destroyed");
        h.tick();
        assert!(h.bool(&format!("{a}.loop")), "A's loop restored ({path})");
        assert_eq!(h.gain(&a), gain0);
        assert!(!h.bool(&format!("{a}.paused")));
        assert_eq!(h.content("VIRTUAL-1"), a);
    }
}

#[test]
fn rapid_interrupt_chain() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    // Videos load in ~100 ms (so a start 100 ms later mostly supersedes); a colour is
    // ready in one tick (so the next start commits it) — both paths get exercised.
    let targets = [
        json!({"path": s(&blue10()), "loop": true}),
        json!({"kind": "color", "color": [0, 255, 0]}),
        json!({"path": s(&green10()), "loop": true}),
    ];
    // Offset so the 10th (the one left to finish) is a held method (reveal): R38's
    // "paused only while held" is exercised through a natural handoff too.
    let methods = ["full-live", "reveal", "frozen"];

    let check = |h: &Harness, when: &str| {
        let live = h.live();
        assert!(
            live.len() <= 2,
            "{when}: {} live sources: {live:?}",
            live.len()
        );
        let allowed: BTreeSet<String> = h.tr.status().into_iter().flat_map(|s| s.held).collect();
        for p in h.paused() {
            assert!(
                allowed.contains(&p),
                "{when}: {p} is paused outside any held method; status {:?}",
                h.tr.status()
            );
        }
    };

    let mut last_b = String::new();
    for i in 0..10 {
        let corr = h.start(json!({
            "outputs": "out:*", "to": targets[i % 3],
            "effect_id": "fade", "duration_ms": 1000, "method": methods[(i + 1) % 3]
        }));
        last_b = h.to_of(&corr);
        let until = h.now() + MS(100);
        while h.now() < until {
            h.tick_toward(until);
            check(&h, &format!("after start #{i}"));
        }
    }
    let ok = h.tick_until(MS(5000), |h| {
        check(h, "settling");
        h.tr.status().is_empty()
    });
    assert!(ok, "the chain never settled: {:?}", h.tr.status());
    let commits = h
        .tr_events
        .iter()
        .filter(|e| {
            matches!(
                e.kind,
                TransitionEventKind::Handoff {
                    committed: true,
                    ..
                }
            )
        })
        .count();
    let supersedes = h
        .tr_events
        .iter()
        .filter(|e| matches!(&e.kind, TransitionEventKind::Cancelled { reason } if reason == "superseded"))
        .count();
    println!("rapid_interrupt_chain: {commits} commits, {supersedes} supersedes");
    assert!(commits >= 1, "no start ever committed a running transition");
    assert!(
        supersedes >= 1,
        "no start ever superseded a waiting transition"
    );
    h.tick();
    assert_eq!(
        h.cur("*"),
        vec![last_b.clone()],
        "the 10th target is current"
    );
    assert_eq!(
        h.sources(),
        vec![last_b.clone()],
        "exactly one source remains"
    );
    assert_eq!(
        h.host.ids(),
        vec![last_b],
        "exactly one live source remains"
    );
}

#[test]
fn cut_without_effect() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": null, "duration_ms": 0
    }));
    let b = h.to_of(&corr);
    let only_current_audible = |h: &Harness| {
        let cur = h.cur("VIRTUAL-1");
        for s in h.sources() {
            if !cur.contains(&s) {
                assert!(
                    h.gain(&s) <= SILENT_DB + 1e-9,
                    "{s} is audible ({} dB) but {cur:?} is current",
                    h.gain(&s)
                );
            }
        }
    };
    let started = loop {
        h.tick();
        only_current_audible(&h);
        if let Some(e) = h.event(&corr, "transition.started") {
            break e;
        }
        assert!(h.now() < MS(10_000), "never started: {:?}", h.tr_events);
    };
    let t0 = from_ms(started.at_ms);
    while h.now() < t0 + MS(30) {
        h.tick_toward(t0 + MS(30));
        only_current_audible(&h);
    }
    assert_eq!(h.content("VIRTUAL-1"), b, "the picture swaps at 30 ms");
    while h.now() < t0 + MS(60) {
        h.tick_toward(t0 + MS(60));
        only_current_audible(&h);
    }
    let done = h
        .event(&corr, "transition.done")
        .expect("cut done by 60 ms");
    println!("cut: done − started = {:.1} ms", done.at_ms - started.at_ms);
    assert!(
        done.at_ms - started.at_ms <= 60.0 + 1e-6,
        "cut took {} ms",
        done.at_ms - started.at_ms
    );
    close(h.gain(&b), 0.0, 1e-9, "B at 0 dB");
    h.tick();
    assert_eq!(h.sources(), vec![b]);
}

#[test]
fn handoff_no_seam() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&idx(300)), "loop": true},
        "effect_id": "fade", "duration_ms": 500, "method": "full-live"
    }));
    let b = h.to_of(&corr);
    h.wait_event(&corr, "transition.started", MS(5000));
    let fx = h.content("VIRTUAL-1");
    assert_eq!(h.str(&format!("{fx}.to")), b);

    let mut samples: Vec<(f64, i32)> = Vec::new(); // (ms, B's corner marker)
    let mut handoff_idx = None;
    let mut out_vs_b = Vec::new();
    let end = h.now() + MS(900);
    while h.now() < end {
        h.tick();
        let c = h.corner(&b).expect("B texture") as i32;
        samples.push((ms(h.now()), c));
        if handoff_idx.is_none() && h.event(&corr, "transition.handoff").is_some() {
            handoff_idx = Some(samples.len() - 1);
            assert_eq!(h.content("VIRTUAL-1"), b, "same source after the handoff");
        }
        if handoff_idx.is_some() {
            out_vs_b.push((h.out_corner("VIRTUAL-1")[0] as i32, c));
        }
    }
    let hi = handoff_idx.expect("handoff within 900 ms");
    assert!(hi > 0);
    for (i, w) in samples.windows(2).enumerate() {
        let (dt, di) = (w[1].0 - w[0].0, w[1].1 - w[0].1);
        // "1 ± 1 per 30 fps frame": up to 2 within any one frame interval.
        let max = (dt / ms(FRAME)).ceil() as i32 + 1;
        assert!(
            (0..=max).contains(&di),
            "B's frame went {} → {} over {dt:.1} ms{} (allowed 0..={max})",
            w[0].1,
            w[1].1,
            if i + 1 == hi {
                " ACROSS THE HANDOFF"
            } else {
                ""
            }
        );
    }
    let (first, last) = (samples[0], samples[samples.len() - 1]);
    let expect = (last.0 - first.0) / ms(FRAME);
    assert!(
        ((last.1 - first.1) as f64 - expect).abs() <= 2.5,
        "B advanced {} frames in {:.0} ms (≈{expect:.1} expected)",
        last.1 - first.1,
        last.0 - first.0
    );
    for (o, c) in out_vs_b {
        assert!(
            (o - c).abs() <= 1,
            "output shows B's live frame: out {o} vs B {c}"
        );
    }
}

#[test]
fn shared_a_untouched() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1", "VIRTUAL-2"]) else {
        return;
    };
    let a = h.play(
        &idx(300),
        json!({"loop": true}),
        &["VIRTUAL-1", "VIRTUAL-2"],
    );
    let g0 = (
        h.f64(&format!("{a}.gain.xfade")),
        h.f64(&format!("{a}.gain.anticlick")),
        h.gain(&a),
    );
    let corr = h.start(json!({
        "outputs": "out:VIRTUAL-1", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 1000, "method": "frozen"
    }));
    let b = h.to_of(&corr);
    let untouched = |h: &Harness, when: &str| {
        assert!(h.exists(&a), "{when}: A destroyed");
        assert!(!h.bool(&format!("{a}.paused")), "{when}: A paused");
        assert!(h.bool(&format!("{a}.loop")), "{when}: A's loop changed");
        let g = (
            h.f64(&format!("{a}.gain.xfade")),
            h.f64(&format!("{a}.gain.anticlick")),
            h.gain(&a),
        );
        assert_eq!(g, g0, "{when}: A's gains changed");
        assert_eq!(
            h.cur("VIRTUAL-2"),
            vec![a.clone()],
            "{when}: A left VIRTUAL-2"
        );
    };
    let mut held: Option<(String, u8)> = None;
    // A's frame when the snapshot node appeared: the host copies A's texture as it stands
    // at the end of that iteration (next `sync`, before any new frame renders).
    let mut copied_from: Option<(String, u8)> = None;
    let mut a_corners = Vec::new();
    let mut v2_corners = Vec::new();
    while h.event(&corr, "transition.done").is_none() {
        assert!(h.now() < MS(30_000), "never done: {:?}", h.tr_events);
        h.tick();
        untouched(&h, "during");
        if copied_from.is_none()
            && let Some(sn) = h
                .sources()
                .into_iter()
                .find(|s| h.str(&format!("{s}.kind")) == "snapshot")
        {
            copied_from = Some((sn, h.corner(&a).unwrap()));
        }
        a_corners.push(h.corner(&a).unwrap());
        v2_corners.push(h.out_corner("VIRTUAL-2")[0]);
        let content = h.content("VIRTUAL-1");
        if h.str(&format!("{content}.effect_id")) == "fade" {
            let from = h.str(&format!("{content}.from"));
            assert_ne!(
                from, a,
                "frozen on a shared A holds a snapshot, not A itself"
            );
            assert_eq!(h.str(&format!("{from}.kind")), "snapshot");
            let c = h.corner(&from).expect("snapshot texture");
            match &held {
                None => {
                    let (sn, at_copy) = copied_from.clone().expect("snapshot seen");
                    assert_eq!(sn, from);
                    assert_eq!(
                        c, at_copy,
                        "the snapshot is A's frame at the hold instant (marker {at_copy})"
                    );
                    held = Some((from, c));
                }
                Some((id, c0)) => {
                    assert_eq!(id, &from);
                    assert_eq!(c, *c0, "VIRTUAL-1's held picture changed");
                }
            }
        }
    }
    let (snap, _) = held.expect("the effect ran with a snapshot");
    h.tick();
    untouched(&h, "after");
    assert_eq!(h.cur("VIRTUAL-1"), vec![b]);
    assert!(!h.exists(&snap), "the snapshot is destroyed at handoff");
    assert!(
        a_corners.last().unwrap() > &(a_corners[0] + 10),
        "A kept advancing: {:?}",
        (a_corners[0], a_corners.last())
    );
    assert!(
        v2_corners.last().unwrap() > &(v2_corners[0] + 10),
        "VIRTUAL-2 kept advancing: {:?}",
        (v2_corners[0], v2_corners.last())
    );
}

/// R35: cancel mid-effect → snap back to A (A's gains back to 0 dB within 30 ms, B ramped
/// out and destroyed).
#[test]
fn cancel_running_snaps_back() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 1000, "method": "full-live"
    }));
    let b = h.to_of(&corr);
    let t0 = start_of(&h.wait_event(&corr, "transition.started", MS(5000)));
    h.tick_to(t0 + MS(400));
    assert!(h.gain(&a) < -1.0, "A is fading out mid-effect");
    let tc = h.now();
    h.cancel(&corr);
    match h.event(&corr, "transition.cancelled").map(|e| e.kind) {
        Some(TransitionEventKind::Cancelled { reason }) => assert_eq!(reason, "cancelled"),
        other => panic!("no cancelled event: {other:?}"),
    }
    assert_eq!(h.content("VIRTUAL-1"), a, "the picture snaps back to A");
    let mut b_gain = vec![h.gain(&b)];
    while h.now() < tc + MS(30) {
        h.tick_toward(tc + MS(30));
        if h.exists(&b) {
            b_gain.push(h.gain(&b));
        }
    }
    close(h.gain(&a), 0.0, 1e-9, "A back at 0 dB 30 ms after cancel");
    assert!(
        b_gain.windows(2).all(|w| w[1] <= w[0]),
        "B only ramps down: {b_gain:?}"
    );
    // B's ramp ends at +30 ms: it's destroyed in that same iteration (its −96 dB went to
    // the source first, in that iteration's sync).
    assert!(!h.exists(&b), "B destroyed once its ramp reached silence");
    h.tick();
    assert!(h.host.get(&b).is_none());
    assert_eq!(h.sources(), vec![a]);
}

/// R35 exact restore: a transition waiting on `End` (A's loop turned off) that is
/// cancelled — or superseded — puts A's loop back.
#[test]
fn cancel_waiting_restores_a() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let req = json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 500, "method": "reveal", "align": "end"
    });
    let corr = h.start(req.clone());
    let b = h.to_of(&corr);
    assert!(h.tick_until(MS(3000), |h| h.bool(&format!("{b}.ready"))));
    h.tick();
    assert!(!h.bool(&format!("{a}.loop")));
    h.cancel(&corr);
    assert!(matches!(
        h.event(&corr, "transition.cancelled").map(|e| e.kind),
        Some(TransitionEventKind::Cancelled { reason }) if reason == "cancelled"
    ));
    assert!(h.bool(&format!("{a}.loop")), "cancel restores A's loop");
    assert!(!h.exists(&b));

    // Superseded while waiting: the new request proceeds from A, with A restored.
    let first = h.start(req);
    h.tick();
    assert!(!h.bool(&format!("{a}.loop")));
    let second = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&green10()), "loop": true},
        "effect_id": "fade", "duration_ms": 300, "method": "full-live"
    }));
    assert!(matches!(
        h.event(&first, "transition.cancelled").map(|e| e.kind),
        Some(TransitionEventKind::Cancelled { reason }) if reason == "superseded"
    ));
    assert!(h.bool(&format!("{a}.loop")), "supersede restores A's loop");
    h.wait_event(&second, "transition.done", MS(5000));
    assert_eq!(h.cur("*"), vec![h.to_of(&second)]);
}

/// R41 (fix round 1 #1): a restore puts a gain back to the TARGET of the animation that
/// was moving it when it was recorded, never to the mid-ramp value. T1 (frozen) hands off
/// — B1's anticlick ramps −96 → 0 dB over 30 ms — and 5 ms later T2 (a colour, ready in
/// one tick; a cut, which records B1's anticlick before ramping it down) begins; T2 is
/// cancelled → B1 must end at 0 dB, not the −15.6 dB it was at.
#[test]
fn restore_targets_not_mid_ramp() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let t1 = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&idx(300)), "loop": true},
        "effect_id": "fade", "duration_ms": 300, "method": "frozen"
    }));
    let b1 = h.to_of(&t1);
    let th = from_ms(h.wait_event(&t1, "transition.handoff", MS(5000)).at_ms);
    let t2 = h.start(json!({
        "outputs": "out:*", "to": {"kind": "color", "color": [0, 255, 0]},
        "effect_id": null
    }));
    h.tick_to(th + MS(5));
    assert!(
        h.event(&t2, "transition.started").is_some(),
        "T2 began 5 ms after T1's handoff: {:?}",
        h.tr_events
    );
    let mid = h.f64(&format!("{b1}.gain.anticlick"));
    assert!(
        mid > SILENT_DB && mid < -3.0,
        "B1's ramp-in was mid-way: {mid} dB"
    );
    h.cancel(&t2);
    let tc = h.now();
    h.tick_to(tc + MS(40));
    close(
        h.f64(&format!("{b1}.gain.anticlick")),
        0.0,
        1e-9,
        "B1's anticlick back to its target, not the recorded mid-ramp value",
    );
    close(h.gain(&b1), 0.0, 1e-9, "B1 fully audible");
    assert_eq!(h.cur("VIRTUAL-1"), vec![b1]);
}

/// R34 (fix round 1 #2a): `align: end` on a shared looping A (VIRTUAL-1 + VIRTUAL-2),
/// transition on VIRTUAL-1 only. full-live ends — frozen starts — at A's iteration
/// boundary (± 1 frame); A's loop never changes; A is never paused, silenced or destroyed
/// and stays current (and audible) on VIRTUAL-2. Frozen holds A's last frame.
#[test]
fn shared_a_align_end_boundary() {
    for method in ["full-live", "frozen"] {
        let Some(mut h) = Harness::new(&["VIRTUAL-1", "VIRTUAL-2"]) else {
            return;
        };
        let a = h.play(&idx(90), json!({"loop": true}), &["VIRTUAL-1", "VIRTUAL-2"]);
        let g0 = h.gain(&a);
        let corr = h.start(json!({
            "outputs": "out:VIRTUAL-1", "to": {"path": s(&blue10()), "loop": true},
            "effect_id": "fade", "duration_ms": 1000, "method": method, "align": "end"
        }));
        let b = h.to_of(&corr);
        // The visible boundary: the tick A's texture goes from its last frame to frame 0
        // (mpv's time_pos drops a frame earlier, while the last frame is still shown).
        let mut wraps = Vec::new();
        let mut last_c = h.corner(&a).unwrap();
        let mut held_marker = None;
        while h.event(&corr, "transition.done").is_none() {
            assert!(
                h.now() < MS(30_000),
                "{method}: never done: {:?}",
                h.tr_events
            );
            h.tick();
            assert!(h.exists(&a), "{method}: A destroyed");
            assert!(!h.bool(&format!("{a}.paused")), "{method}: A paused");
            assert!(h.bool(&format!("{a}.loop")), "{method}: A's loop changed");
            assert_eq!(h.gain(&a), g0, "{method}: A's gain changed");
            assert_eq!(
                h.cur("VIRTUAL-2"),
                vec![a.clone()],
                "{method}: A left VIRTUAL-2"
            );
            let c = h.corner(&a).unwrap();
            if c < 10 && last_c > 80 {
                wraps.push(ms(h.now()));
            }
            last_c = c;
            let fx = h.content("VIRTUAL-1");
            if held_marker.is_none() && h.str(&format!("{fx}.effect_id")) == "fade" {
                let from = h.str(&format!("{fx}.from"));
                if from != a {
                    held_marker = h.corner(&from);
                }
            }
        }
        // The effect can finish a moment before the visible wrap: keep watching A.
        let watch_end = h.now() + MS(300);
        while h.now() < watch_end {
            h.tick();
            let c = h.corner(&a).unwrap();
            if c < 10 && last_c > 80 {
                wraps.push(ms(h.now()));
            }
            last_c = c;
        }
        let started = h.event(&corr, "transition.started").unwrap();
        let instant = if method == "full-live" {
            ms(start_of(&started)) + 1000.0 // the effect ENDS at the boundary
        } else {
            started.at_ms // the effect STARTS at the boundary
        };
        let err = wraps
            .iter()
            .map(|w| instant - w)
            .min_by(|x, y| x.abs().total_cmp(&y.abs()))
            .unwrap_or_else(|| panic!("{method}: A never wrapped"));
        println!("shared_a_align_end_boundary {method}: instant − A's visible wrap = {err:+.1} ms");
        assert!(
            err.abs() <= 33.4,
            "{method}: {err:+.1} ms from A's iteration boundary"
        );
        if method == "frozen" {
            let m = held_marker.expect("frozen holds a snapshot of the shared A");
            assert!(
                (87..=90).contains(&m),
                "frozen holds A's last frame (89 ± 1), got {m}"
            );
        }
        h.tick();
        assert_eq!(h.cur("VIRTUAL-1"), vec![b]);
        assert_eq!(h.cur("VIRTUAL-2"), vec![a.clone()]);
        assert!(!h.bool(&format!("{a}.paused")) && h.bool(&format!("{a}.loop")));
    }
}

/// Invariant #6 (fix round 1 #2b): a start on an output whose transition is Running
/// commits it, for every method — T1's B unpaused at once, its xfade/anticlick at 0 dB
/// within 30 ms (rising monotonically), a frozen B released from its hold (advances); T1's
/// A ramped out from where it was (monotone, no jump) and destroyed. T2 waits on B's end
/// (seconds away), so it touches nothing on B while the commit ramps run.
#[test]
fn commit_running_each_method() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    for method in ["full-live", "reveal", "frozen"] {
        let a = h.cur("VIRTUAL-1")[0].clone();
        let t1 = h.start(json!({
            "outputs": "out:*", "to": {"path": s(&idx(300)), "loop": true},
            "effect_id": "fade", "duration_ms": 1000, "method": method
        }));
        let b = h.to_of(&t1);
        let t0 = start_of(&h.wait_event(&t1, "transition.started", MS(5000)));
        h.tick_to(t0 + MS(300));
        let a_gain0 = h.gain(&a);
        let b_corner0 = h.corner(&b).unwrap();
        let t2 = h.start(json!({
            "outputs": "out:*", "to": {"kind": "color", "color": [0, 255, 0]},
            "effect_id": "fade", "duration_ms": 500, "method": "reveal", "align": "end"
        }));
        let tc = h.now();
        assert!(
            matches!(
                h.event(&t1, "transition.handoff").map(|e| e.kind),
                Some(TransitionEventKind::Handoff {
                    committed: true,
                    ..
                })
            ),
            "{method}: T1 committed"
        );
        assert_eq!(h.content("VIRTUAL-1"), b, "{method}: B current at once");
        assert!(
            !h.bool(&format!("{b}.paused")),
            "{method}: B unpaused at commit"
        );
        let mut a_gain = vec![a_gain0];
        let mut b_x = vec![h.f64(&format!("{b}.gain.xfade"))];
        let mut b_ac = vec![h.f64(&format!("{b}.gain.anticlick"))];
        while h.now() < tc + MS(30) {
            h.tick_toward(tc + MS(30));
            if h.exists(&a) {
                a_gain.push(h.gain(&a));
            }
            b_x.push(h.f64(&format!("{b}.gain.xfade")));
            b_ac.push(h.f64(&format!("{b}.gain.anticlick")));
        }
        close(
            *b_x.last().unwrap(),
            0.0,
            1e-9,
            &format!("{method}: B xfade at +30 ms"),
        );
        close(
            *b_ac.last().unwrap(),
            0.0,
            1e-9,
            &format!("{method}: B anticlick at +30 ms"),
        );
        close(h.gain(&b), 0.0, 1e-9, &format!("{method}: B audible"));
        assert!(
            b_x.windows(2).all(|w| w[1] >= w[0]),
            "{method}: B xfade rises: {b_x:?}"
        );
        assert!(
            b_ac.windows(2).all(|w| w[1] >= w[0]),
            "{method}: B anticlick: {b_ac:?}"
        );
        assert!(
            a_gain.windows(2).all(|w| w[1] <= w[0] + 1e-9),
            "{method}: A ramps out from where it was: {a_gain:?}"
        );
        h.tick();
        assert!(!h.exists(&a), "{method}: T1's A destroyed");
        let ok = h.tick_until(MS(1000), |h| {
            h.corner(&b).is_some_and(|c| c >= b_corner0 + 5)
        });
        assert!(ok, "{method}: B plays after the commit");
        h.cancel(&t2); // T2 turned B's loop off for its End wait; put it back
        assert!(h.bool(&format!("{b}.loop")));
        assert!(h.tick_until(MS(1000), |h| h.tr.status().is_empty()));
    }
}

/// R35 (fix round 1 #2c): B fails mid-effect → snap back to A with `transition.failed`.
/// Deterministic failure: B's `path` is swapped live for a missing file mid-effect, so
/// mpv reports that load's error as B's `Error` (`path` in the event is B's requested
/// path; `reason` names the file that failed).
#[test]
fn b_error_mid_effect_snaps_back() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&idx(300), json!({"loop": true}), &["VIRTUAL-1"]);
    for method in ["reveal", "full-live"] {
        let b_path = s(&blue10()).to_string();
        let t = h.start(json!({
            "outputs": "out:*", "to": {"path": b_path, "loop": true},
            "effect_id": "fade", "duration_ms": 1000, "method": method
        }));
        let b = h.to_of(&t);
        let t0 = start_of(&h.wait_event(&t, "transition.started", MS(5000)));
        h.tick_to(t0 + MS(200));
        let fx = h.content("VIRTUAL-1");
        let from = h.str(&format!("{fx}.from"));
        let missing = "/nonexistent/lp-player-tr-mid-effect.mkv";
        h.graph
            .set(
                &lp_player::anim::PropPath(format!("{b}.path")),
                lp_player::graph::PropValue::Str(missing.into()),
            )
            .unwrap();
        let failed = h.wait_event(&t, "transition.failed", MS(3000));
        match failed.kind {
            TransitionEventKind::Failed { path, reason } => {
                assert_eq!(path, b_path, "{method}");
                assert!(reason.contains(missing), "{method}: reason {reason}");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(h.content("VIRTUAL-1"), a, "{method}: back to A");
        assert!(!h.exists(&fx), "{method}: fx destroyed");
        if from != a {
            assert!(!h.exists(&from), "{method}: snapshot destroyed");
        }
        assert!(!h.bool(&format!("{a}.paused")), "{method}: A unpaused");
        let tf = h.now();
        h.tick_to(tf + MS(30));
        close(h.f64(&format!("{a}.gain.xfade")), 0.0, 1e-9, method);
        close(h.f64(&format!("{a}.gain.anticlick")), 0.0, 1e-9, method);
        close(
            h.gain(&a),
            0.0,
            1e-9,
            &format!("{method}: A back at its recorded gains"),
        );
        h.tick();
        assert!(!h.exists(&b), "{method}: B destroyed after its ramp-out");
        assert_eq!(h.sources(), vec![a.clone()]);
    }
}

/// R35 (fix round 1 #2d): cancelling reveal / frozen mid-effect → A unpaused, its
/// anticlick back to 0 dB over 30 ms (monotone), no snapshot left alive, B gone.
#[test]
fn cancel_held_methods_restore_a() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    let a = h.play(&idx(300), json!({"loop": true}), &["VIRTUAL-1"]);
    for method in ["reveal", "frozen"] {
        let t = h.start(json!({
            "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
            "effect_id": "fade", "duration_ms": 1000, "method": method
        }));
        let b = h.to_of(&t);
        let t0 = start_of(&h.wait_event(&t, "transition.started", MS(5000)));
        h.tick_to(t0 + MS(200));
        assert!(
            h.bool(&format!("{a}.paused")) && h.gain(&a) <= -90.0,
            "{method}: A held"
        );
        let snap = h.str(&format!("{}.from", h.content("VIRTUAL-1")));
        assert_eq!(h.str(&format!("{snap}.kind")), "snapshot");
        h.cancel(&t);
        let tc = h.now();
        assert_eq!(h.content("VIRTUAL-1"), a, "{method}");
        assert!(!h.exists(&snap), "{method}: no snapshot left");
        assert!(!h.bool(&format!("{a}.paused")), "{method}: A unpaused");
        // A 30 ms linear ramp, not a jump: exactly 1/3 of the way (−9.54 dB) at +10 ms.
        let mut ac = vec![h.f64(&format!("{a}.gain.anticlick"))];
        h.tick_to(tc + MS(10));
        let third = h.f64(&format!("{a}.gain.anticlick"));
        close(
            third,
            -9.542,
            0.01,
            &format!("{method}: anticlick at +10 ms"),
        );
        ac.push(third);
        while h.now() < tc + MS(30) {
            h.tick_toward(tc + MS(30));
            ac.push(h.f64(&format!("{a}.gain.anticlick")));
        }
        assert!(
            ac.windows(2).all(|w| w[1] >= w[0]),
            "{method}: ramps up: {ac:?}"
        );
        close(
            *ac.last().unwrap(),
            0.0,
            1e-9,
            &format!("{method}: anticlick at +30 ms"),
        );
        close(h.gain(&a), 0.0, 1e-9, method);
        h.tick();
        assert!(!h.exists(&b), "{method}: B gone");
        assert_eq!(h.sources(), vec![a.clone()]);
    }
}

/// R42 (fix round 1 #3): with `duration_ms: 0` the picture may cut, but no gain moves
/// faster than a 30 ms ramp — sampled every 5 ms, the linear amplitude of every source
/// never changes faster than a sin ramp over 30 ms ((π/2)/30 per ms).
#[test]
fn zero_duration_gains_still_ramp_30ms() {
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let max_slope = std::f64::consts::FRAC_PI_2 / 30.0 * 1.02; // per ms
    for (method, to) in [("full-live", blue10()), ("reveal", green10())] {
        let a = h.cur("VIRTUAL-1")[0].clone();
        let t = h.start(json!({
            "outputs": "out:*", "to": {"path": s(&to), "loop": true},
            "effect_id": "fade", "duration_ms": 0, "method": method
        }));
        let b = h.to_of(&t);
        let mut series: Vec<(String, Vec<(f64, f64)>)> =
            vec![(a.clone(), Vec::new()), (b.clone(), Vec::new())];
        while h.event(&t, "transition.done").is_none() {
            assert!(h.now() < MS(30_000), "{method}: never done");
            let next = h.now() + MS(5);
            h.tick_to(next);
            for (id, v) in &mut series {
                if h.exists(id) {
                    v.push((ms(h.now()), lp_player::units::db_to_lin(h.gain(id))));
                }
            }
        }
        for (id, v) in &series {
            for w in v.windows(2) {
                let slope = (w[1].1 - w[0].1).abs() / (w[1].0 - w[0].0);
                assert!(
                    slope <= max_slope,
                    "{method}: {id}'s gain moved {:.3} → {:.3} in {:.1} ms (faster than a 30 ms ramp)",
                    w[0].1,
                    w[1].1,
                    w[1].0 - w[0].0
                );
            }
        }
        close(h.gain(&b), 0.0, 1e-9, &format!("{method}: B at 0 dB"));
        assert_eq!(h.cur("VIRTUAL-1"), vec![b]);
    }
}

/// R45 (fix round 1 #8): a property B refuses mid-transition (`af` mpv rejects
/// asynchronously; a live `kind` change MpvSource refuses at once) is a `Rejected` event,
/// not a failure — the transition completes.
#[test]
fn rejected_prop_on_b_keeps_transition() {
    use lp_player::anim::PropPath;
    use lp_player::graph::PropValue;
    let Some(mut h) = Harness::new(&["VIRTUAL-1"]) else {
        return;
    };
    h.play(&red10(), json!({"loop": true}), &["VIRTUAL-1"]);
    let t = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&blue10()), "loop": true},
        "effect_id": "fade", "duration_ms": 600, "method": "full-live"
    }));
    let b = h.to_of(&t);
    let t0 = start_of(&h.wait_event(&t, "transition.started", MS(5000)));
    h.tick_to(t0 + MS(100));
    h.graph
        .set(
            &PropPath(format!("{b}.af")),
            PropValue::Str("no_such_filter_lp".into()),
        )
        .unwrap();
    h.graph
        .set(
            &PropPath(format!("{b}.kind")),
            PropValue::Str("image".into()),
        )
        .unwrap();
    h.wait_event(&t, "transition.done", MS(3000));
    assert!(
        h.event(&t, "transition.failed").is_none(),
        "{:?}",
        h.tr_events
    );
    for prop in ["af", "kind"] {
        assert!(
            h.src_events.iter().any(|(_, id, e)| id == &b
                && matches!(e, SourceEvent::Rejected { prop: p, .. } if p == prop)),
            "B's refused {prop} is reported as Rejected: {:?}",
            h.src_events
        );
    }
    assert_eq!(h.cur("VIRTUAL-1"), vec![b]);
}
