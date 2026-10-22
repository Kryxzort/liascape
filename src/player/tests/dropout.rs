//! Task 15: the reference-based dropout detector — synthetic-envelope tests of
//! [`analyse`] (port of `scripts/lp_audiowatch.py`'s `refcheck`), plus one integration
//! test of [`expected_envelope`]'s `ffmpeg` decode path against a real synthetic clip.
//! Pure-function unit tests of the gain-weighting math (`mix_envelope`, `gain_at`) and the
//! runtime-wiring pieces (`GainHistory`, `PendingWindows`) live in
//! `src/probe/dropout.rs`'s own `#[cfg(test)]` block instead (whitebox, private items).
//!
//! No GPU, no PipeWire, no running player needed here — `analyse` and `expected_envelope`
//! are plain functions over `Vec<(Duration, f64)>`.

mod common;

use std::time::Duration;

use common::{ClipSpec, ensure_clip};
use lp_player::probe::dropout::{
    DropoutReport, GainSchedule, SourceWindow, analyse, expected_envelope,
};
use lp_player::units::{SILENT_DB, db_to_lin};

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

/// A non-degenerate "crossfade-ish" shape for the lag-search tests: strictly convex, so
/// no wrong lag can be explained away by a constant offset (a flat or linear envelope
/// can — see the module doc's reasoning in `probe/dropout.rs`).
fn curve_a(k: i64) -> f64 {
    -30.0 + 0.03 * (k * k) as f64
}

/// A gentler version of [`curve_a`] for the longer `big_hole` window (keeps levels
/// plausible over 650 ms instead of running away positive).
fn curve_b(k: i64) -> f64 {
    -25.0 + 0.004 * (k * k) as f64
}

#[test]
fn clean_crossfade_reports_the_lag_and_a_tight_fit_with_no_drops() {
    let expected: Vec<(Duration, f64)> = (0..=30)
        .map(|k| (ms((k * 10) as u64), curve_a(k)))
        .collect();
    // Observed: the same piecewise-10ms-constant curve, delayed 30 ms, sampled every
    // 1 ms like the real bus meter.
    let observed: Vec<(Duration, f64)> = (0..=320u64)
        .map(|t| {
            let k = (t as i64 - 30).div_euclid(10);
            (ms(t), curve_a(k))
        })
        .collect();
    let report = analyse(&observed, &expected);
    assert_eq!(report.lag_ms, 30, "report = {report:?}");
    assert!(report.fit_db < 0.5, "fit_db = {}", report.fit_db);
    assert!(report.drops.is_empty(), "drops = {:?}", report.drops);
}

#[test]
fn injected_4ms_gap_is_flagged_as_exactly_one_micro_gap_not_a_drop() {
    let expected: Vec<(Duration, f64)> = (0..=30)
        .map(|k| (ms((k * 10) as u64), curve_a(k)))
        .collect();
    let mut observed: Vec<(Duration, f64)> = (0..=300u64)
        .map(|t| {
            let k = (t / 10) as i64;
            (ms(t), curve_a(k))
        })
        .collect();
    // Zero 4 ms of observed at +130 ms, in otherwise-loud content.
    for sample in &mut observed[130..134] {
        sample.1 = SILENT_DB;
    }
    let report = analyse(&observed, &expected);
    assert_eq!(report.lag_ms, 0, "report = {report:?}");
    assert!(report.drops.is_empty(), "drops = {:?}", report.drops);
    assert_eq!(
        report.micro_gaps.len(),
        1,
        "micro_gaps = {:?}",
        report.micro_gaps
    );
    assert_eq!(report.micro_gaps[0].len_ms, 4);
    assert_eq!(report.micro_gaps[0].at_ms, 130);
}

#[test]
fn content_silence_not_flagged_as_a_dropout() {
    // The content itself is silent (−140 dB) — observed matching it is not a dropout.
    let expected: Vec<(Duration, f64)> = (0..=30).map(|k| (ms((k * 10) as u64), -140.0)).collect();
    let observed: Vec<(Duration, f64)> = (0..=300u64).map(|t| (ms(t), SILENT_DB)).collect();
    let report = analyse(&observed, &expected);
    assert!(report.drops.is_empty(), "drops = {:?}", report.drops);
    assert!(
        report.micro_gaps.is_empty(),
        "micro_gaps = {:?}",
        report.micro_gaps
    );
}

#[test]
fn held_method_silence_not_flagged_as_a_dropout() {
    // The frozen-method schedule (R71): both A's and B's recorded gain is SILENT_DB
    // throughout the effect — even though their decoded content is loud (0.1 linear
    // power ≈ −10 dB) — computed through the same `db_to_lin` the production
    // `mix_envelope` uses, so a regression in the "silence floor" guarantee would show
    // up here too, not only in `probe/dropout.rs`'s own `mix_envelope` unit test.
    let loud_power = 0.1;
    let g = db_to_lin(SILENT_DB);
    let mixed_power = loud_power * g * g + loud_power * g * g;
    let expected_db = if mixed_power > 1e-14 {
        10.0 * mixed_power.log10()
    } else {
        -140.0
    };
    let expected: Vec<(Duration, f64)> = (0..=30)
        .map(|k| (ms((k * 10) as u64), expected_db))
        .collect();
    let observed: Vec<(Duration, f64)> = (0..=300u64).map(|t| (ms(t), SILENT_DB)).collect();
    let report = analyse(&observed, &expected);
    assert!(report.drops.is_empty(), "drops = {:?}", report.drops);
    assert!(
        report.micro_gaps.is_empty(),
        "micro_gaps = {:?}",
        report.micro_gaps
    );
}

#[test]
fn big_hole_is_flagged_as_one_drop_of_about_440_to_450ms() {
    let expected: Vec<(Duration, f64)> = (0..=65)
        .map(|k| (ms((k * 10) as u64), curve_b(k)))
        .collect();
    let mut observed: Vec<(Duration, f64)> = (0..=650u64)
        .map(|t| {
            let k = (t / 10) as i64;
            (ms(t), curve_b(k))
        })
        .collect();
    // 446 ms of silence: t = 100..=545.
    for sample in &mut observed[100..=545] {
        sample.1 = SILENT_DB;
    }
    let report = analyse(&observed, &expected);
    assert_eq!(report.drops.len(), 1, "drops = {:?}", report.drops);
    let d = &report.drops[0];
    assert!(
        (400..=480).contains(&(d.len_ms as i64)),
        "len_ms = {}, report = {report:?}",
        d.len_ms
    );
    assert_eq!(d.at_ms, 100, "report = {report:?}");
}

// ----------------------------------------------------------- expected_envelope() (ffmpeg)

#[test]
fn ffmpeg_decode_reads_the_sine_tones_true_level() {
    // A −20 dBFS sine on both channels (RMS = peak − 3 dB ≈ −23 dBFS as *stereo audio*)
    // — but `ensure_clip`'s `Solid` tone is identical on both channels, and ffmpeg's
    // `-ac 1` downmix for exactly-correlated stereo is power-preserving (1/√2 per
    // channel, not a plain 0.5/0.5 average): measured directly against the
    // pre-downmix stream, the mono decode's peak comes out at `0.1*√2`, i.e. **+3.01 dB**
    // over the stereo peak — so the 10 ms power bin reads ≈ the ORIGINAL −20 dBFS peak's
    // own RMS, not −23. This is the exact `ffmpeg … -ac 1 …` command the brief and
    // `scripts/lp_audiowatch.py` both specify (no extra `-af pan=…`), so the level is kept
    // as ffmpeg really produces it rather than papering over the downmix with a filter
    // neither the brief nor the ported reference uses.
    let path = ensure_clip(
        "dropout_tone",
        ClipSpec::Solid {
            rgb: [0, 0, 0],
            secs: 1.0,
            tone_hz: 1000.0,
            tone_dbfs: -20.0,
        },
    );
    let src = SourceWindow {
        id: "a".into(),
        path,
        position: 0.0,
    };
    let mut schedule: GainSchedule = GainSchedule::new();
    schedule.insert("a".into(), vec![(Duration::ZERO, 0.0)]); // 0 dB: no suppression
    let window = (ms(100), ms(800));
    let env = expected_envelope(&[src], &schedule, window);
    assert!(!env.is_empty());
    for (i, (_, db)) in env.iter().enumerate() {
        assert!(
            (*db - (-20.0)).abs() < 1.5,
            "bin {i}: {db} dB, expected ≈ −20 dB (measured: ffmpeg's correlated-stereo \
             downmix, +3 dB over the −23 dB a true stereo RMS would read)"
        );
    }
    let mid = env[env.len() / 2].1;
    assert!((mid - (-20.0)).abs() < 0.5, "mid bin = {mid} dB");
}

/// Trivial sanity on the report shape itself (serializes, round-trips the Debug impl a
/// reader of `probe.dropout` events would see).
#[test]
fn dropout_report_is_debug_and_eq() {
    let r1: DropoutReport = analyse(&[], &[]);
    let r2 = analyse(&[], &[]);
    assert_eq!(r1, r2);
    assert_eq!(r1.lag_ms, 0);
}
