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
        h.f64(&format!("{b}.gain.xfade")),
        -3.0103,
        0.01,
        "B.gain.xfade at 500 ms",
    );
    close(
        h.f64(&format!("{fx}.progress")),
        0.5,
        0.01,
        "fx.progress at 500 ms",
    );
    assert!(!h.bool(&format!("{a}.paused")) && !h.bool(&format!("{b}.paused")));

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
    let corr = h.start(json!({
        "outputs": "out:*", "to": {"path": s(&idx(300)), "loop": true},
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
    h.tick_to(th + MS(30));
    close(h.gain(&b), 0.0, 1e-6, "B at 0 dB 30 ms after the end");
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
    h.show("VIRTUAL-2", &a);
    let c = corr.clone();
    let ok = h.tick_until(MS(4000), |h| {
        h.src_event_at(&a, |e| *e == SourceEvent::Ended).is_some()
            && h.event(&c, "transition.handoff").is_some()
    });
    assert!(ok, "A never ended / no handoff: {:?}", h.tr_events);
    let ended = ms(h.src_event_at(&a, |e| *e == SourceEvent::Ended).unwrap());
    let handoff = h.event(&corr, "transition.handoff").expect("handoff");
    println!(
        "align_end_full_live: progress=1 − A's Ended = {:+.1} ms (handoff tick {:+.1} ms)",
        progress_one - ended,
        handoff.at_ms - ended
    );
    assert!(
        (progress_one - ended).abs() <= 33.4,
        "fx.progress reaches 1 at {progress_one:.1} ms, A's Ended at {ended:.1} ms"
    );
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
    let targets = [blue10(), green10()];
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
            "outputs": "out:*", "to": {"path": s(&targets[i % 2]), "loop": true},
            "effect_id": "fade", "duration_ms": 1000, "method": methods[i % 3]
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
    let mut a_corners = Vec::new();
    let mut v2_corners = Vec::new();
    while h.event(&corr, "transition.done").is_none() {
        assert!(h.now() < MS(30_000), "never done: {:?}", h.tr_events);
        h.tick();
        untouched(&h, "during");
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
                None => held = Some((from, c)),
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
