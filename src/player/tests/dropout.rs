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
    DropoutReport, FitStatus, GainSchedule, SourceWindow, analyse, analyse_with_fine,
    expected_envelope,
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
/// plausible over 2000 ms instead of running away positive). Review fix round, R77:
/// the coefficient was re-tuned (and the window extended from 650 ms to 2000 ms) so the
/// window still has enough reliably-paired bins to clear the new, window-scaled lag
/// guard even with its 446 ms drop silencing a big chunk of it — see that test's own
/// comment.
fn curve_b(k: i64) -> f64 {
    -25.0 + 0.0005 * (k * k) as f64
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
    // Review fix round, R77: extended from the original 650 ms window to 2000 ms (200
    // bins) — the 446 ms drop alone silences 44-45 of a 650-bin-ms window's bins for the
    // lag search's own "is this bin's capture plausible" filter, which the OLD flat
    // `MIN_LAG_PAIRS = 3` guard didn't care about but the new window-scaled guard does
    // (it wants at least half of `expected`'s audible bins to have actually paired, up
    // to 50). A 650 ms window where 68% of it is one drop is a pathological ratio no
    // real transition produces; 2000 ms with the same 446 ms drop (23%) is realistic and
    // leaves plenty of good signal to anchor the fit on either side of it.
    let expected: Vec<(Duration, f64)> = (0..=200)
        .map(|k| (ms((k * 10) as u64), curve_b(k)))
        .collect();
    let mut observed: Vec<(Duration, f64)> = (0..=2000u64)
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
    assert_eq!(report.fit, FitStatus::Ok, "report = {report:?}");
    assert_eq!(report.drops.len(), 1, "drops = {:?}", report.drops);
    let d = &report.drops[0];
    assert!(
        (400..=480).contains(&(d.len_ms as i64)),
        "len_ms = {}, report = {report:?}",
        d.len_ms
    );
    assert_eq!(d.at_ms, 100, "report = {report:?}");
}

#[test]
fn sparse_window_is_insufficient_and_flags_nothing() {
    // R77 (review fix round): only ~8 audible bins in the whole window — nowhere near
    // enough to trust a lag/offset fit against. The report must say so plainly
    // (`fit: Insufficient`, `lag_ms: 0`) rather than guess a lag and flag findings on
    // top of a fit it can't actually vouch for.
    let expected: Vec<(Duration, f64)> = (0..8).map(|k| (ms(k * 10), -20.0)).collect();
    let observed: Vec<(Duration, f64)> = (0..80u64).map(|t| (ms(t), -20.0)).collect();
    let report = analyse(&observed, &expected);
    assert_eq!(report.fit, FitStatus::Insufficient, "report = {report:?}");
    assert_eq!(report.lag_ms, 0, "report = {report:?}");
    assert_eq!(report.fit_db, 0.0, "report = {report:?}");
    assert_eq!(report.offset_db, 0.0, "report = {report:?}");
    assert!(report.drops.is_empty(), "drops = {:?}", report.drops);
    assert!(
        report.micro_gaps.is_empty(),
        "micro_gaps = {:?}",
        report.micro_gaps
    );
}

// ------------------------------------------- Task 16d: R96 1 ms lag + window-grid fix

/// A synthetic copy of the on-machine frozen window (`tests/onmachine/dropout.sh`,
/// case 2): A steady at −20 dB until 500 ms, a 30 ms linear-*amplitude* anti-click ramp
/// to silence (`GainLinear`, invariant #2), held silence, then B's 30 ms ramp-in at
/// 1567 ms and B steady — the expected level at window-relative `t` ms.
fn frozen_curve(t: f64) -> f64 {
    let a = if t < 500.0 {
        1.0
    } else if t < 530.0 {
        1.0 - (t - 500.0) / 30.0
    } else {
        0.0
    };
    let b = if t < 1567.0 {
        0.0
    } else if t < 1597.0 {
        (t - 1567.0) / 30.0
    } else {
        1.0
    };
    let p = 0.01 * (a * a + b * b); // −20 dB
    if p > 1e-14 { 10.0 * p.log10() } else { -140.0 }
}

const FROZEN_WINDOW_MS: u64 = 2100;

/// `(observed, coarse, fine)` for [`frozen_curve`] with the window starting at
/// `origin_ms` (any sub-10 ms phase, like the real `transition.started − 500 ms`), the
/// meter delayed by `lag_ms` and 3 dB under expected (the real bus offset), sampled every
/// 1 ms at a sub-ms phase and floored at the meter's −96 dB, optionally only up to
/// window-relative `observed_until_ms` (the auto-trigger snapshotting the meter at
/// `transition.done`, before the window's post-roll was captured). `coarse` holds the
/// level at each bin's start, as `mix_envelope`'s nearest-previous gain does.
#[allow(clippy::type_complexity)]
fn frozen_fixture(
    origin_ms: f64,
    lag_ms: f64,
    observed_until_ms: Option<f64>,
) -> (
    Vec<(Duration, f64)>,
    Vec<(Duration, f64)>,
    Vec<(Duration, f64)>,
) {
    let at = |rel: f64| Duration::from_secs_f64((origin_ms + rel) / 1000.0);
    let fine: Vec<(Duration, f64)> = (0..FROZEN_WINDOW_MS)
        .map(|k| (at(k as f64), frozen_curve(k as f64)))
        .collect();
    let coarse: Vec<(Duration, f64)> = (0..FROZEN_WINDOW_MS / 10)
        .map(|k| (at((k * 10) as f64), frozen_curve((k * 10) as f64)))
        .collect();
    let until = observed_until_ms.unwrap_or(FROZEN_WINDOW_MS as f64);
    let observed: Vec<(Duration, f64)> = (0..FROZEN_WINDOW_MS)
        .map(|k| k as f64 + 0.42)
        .filter(|rel| *rel <= until)
        .map(|rel| (at(rel), (frozen_curve(rel - lag_ms) - 3.0).max(SILENT_DB)))
        .collect();
    (observed, coarse, fine)
}

#[test]
fn refined_lag_recovers_a_23ms_lag_with_no_micro_gap() {
    // R96: a true 23 ms lag — between two 10 ms steps — on a window full of steep ramp
    // edges. The coarse search can only say 20 (or 30); the micro-gap pass applying
    // that in continuous time misaligns A's ramp bottom by 3+ ms, past R94's ±2 ms
    // guard. Refined to 1 ms it lands on 23 ± 1 and nothing is flagged.
    let (observed, coarse, fine) = frozen_fixture(0.0, 23.0, None);
    let report = analyse_with_fine(&observed, &coarse, &fine);
    assert!(
        (22..=24).contains(&report.lag_ms),
        "lag_ms {} not 23 ± 1: {report:?}",
        report.lag_ms
    );
    assert!(report.drops.is_empty(), "drops = {:?}", report.drops);
    assert!(
        report.micro_gaps.is_empty(),
        "micro_gaps = {:?}",
        report.micro_gaps
    );
    assert!(
        (report.offset_db + 3.0).abs() < 0.5,
        "offset {}",
        report.offset_db
    );
}

#[test]
fn refined_lag_still_flags_an_injected_4ms_gap() {
    // R96 must not absorb a real hole: the same 23 ms-lag window with 4 ms of true
    // silence in B's steady tone is still exactly one 4 ms micro-gap, at the hole.
    let (mut observed, coarse, fine) = frozen_fixture(0.0, 23.0, None);
    for s in observed
        .iter_mut()
        .filter(|(t, _)| (1800..1804).contains(&(t.as_millis() as u64)))
    {
        s.1 = SILENT_DB;
    }
    let report = analyse_with_fine(&observed, &coarse, &fine);
    assert!((22..=24).contains(&report.lag_ms), "{report:?}");
    assert!(report.drops.is_empty(), "drops = {:?}", report.drops);
    assert_eq!(
        report.micro_gaps.len(),
        1,
        "micro_gaps = {:?}",
        report.micro_gaps
    );
    assert_eq!(report.micro_gaps[0].at_ms, 1800);
    assert_eq!(report.micro_gaps[0].len_ms, 4);
}

#[test]
fn window_phase_does_not_skew_the_lag() {
    // Task 16d, the on-machine failure itself (`dropout.sh` frozen @60 and @240 Hz:
    // `lag_ms` 10, a 4 ms / 61 dB micro-gap at A's ramp bottom, `at_ms` 532): the window
    // starts 7.9 ms past a 10 ms boundary and the true lag is 2 ms. Binning the meter on
    // the absolute 10 ms grid paired each expected bin with samples 7.9 ms early, so the
    // search said 10 ms (really +2.1) and the micro-gap pass then shifted the fine
    // envelope a full 10 ms — 8 ms off at the ramp's steepest point.
    for origin in [3967.9, 3118.17, 3057.86, 4000.0] {
        let (observed, coarse, fine) = frozen_fixture(origin, 2.0, None);
        let report = analyse_with_fine(&observed, &coarse, &fine);
        assert!(
            (1..=3).contains(&report.lag_ms),
            "origin {origin}: lag_ms {} (true 2): {report:?}",
            report.lag_ms
        );
        assert!(report.drops.is_empty(), "origin {origin}: {report:?}");
        assert!(report.micro_gaps.is_empty(), "origin {origin}: {report:?}");
    }
}

#[test]
fn truncated_capture_does_not_pull_the_lag() {
    // Task 16d, the @240 Hz on-machine failure (`lag_ms` 40, a 30 ms / 73 dB *drop* at
    // `at_ms` 500 — A's whole anti-click ramp "observed silent"): the auto-trigger used
    // to snapshot the meter at `transition.done`, so the capture ended at B's ramp end
    // while `expected` ran 500 ms further. The real audio was ramped (meter + an
    // independent `parec` capture agree). Whatever window the analysis gets, the lag
    // must stay the true one and A's ramp must not be flagged.
    for origin in [3967.9, 4000.0] {
        let (observed, coarse, fine) = frozen_fixture(origin, 2.0, Some(1600.0));
        let report = analyse_with_fine(&observed, &coarse, &fine);
        assert!(
            (1..=3).contains(&report.lag_ms),
            "origin {origin}: {report:?}"
        );
        assert!(report.drops.is_empty(), "origin {origin}: {report:?}");
        assert!(report.micro_gaps.is_empty(), "origin {origin}: {report:?}");
    }
}

#[test]
fn an_unramped_cut_at_effect_start_is_flagged() {
    // The REAL defect the effect-start finding had to rule out: A's audio stopping at
    // effect start with no ramp. The fixed detector (window grid + R96) must flag it —
    // its precision gain can't mask a real cut: the lag is pinned by B's onset edge and
    // A's steady tone, and A's expected-audible ramp bins then pair with true silence.
    for origin in [3967.9, 4000.0] {
        let (mut observed, coarse, fine) = frozen_fixture(origin, 2.0, None);
        for s in observed.iter_mut() {
            let rel = s.0.as_secs_f64() * 1000.0 - origin;
            if (502.0..1569.0).contains(&rel) {
                s.1 = SILENT_DB;
            }
        }
        let report = analyse_with_fine(&observed, &coarse, &fine);
        assert!(
            report
                .drops
                .iter()
                .any(|d| (490..=510).contains(&d.at_ms) && d.len_ms >= 20),
            "origin {origin}: an instant cut at effect start must be a drop: {report:?}"
        );
    }
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
        speed: 1.0,
        looped: false,
        duration: None,
        envelope: None,
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

/// Builds (once) a 2 s clip, silent for its first second and a −20 dBFS 1 kHz tone for
/// its second, via the concat demuxer rather than a single `lavfi` filter graph — an
/// `if(lt(t,1),…)` expression needs comma-escaping inside the graph description that's
/// easy to get subtly wrong, while two one-second segments stitched with `-f concat -c
/// copy` need none.
fn ensure_speed_step_clip() -> std::path::PathBuf {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-media");
    std::fs::create_dir_all(&dir).expect("create target/test-media");
    let out = dir.join("dropout_speed_step.mkv");
    if out.exists() {
        return out;
    }
    let quiet = dir.join("dropout_speed_step_quiet.mkv");
    let loud = dir.join("dropout_speed_step_loud.mkv");
    let make = |path: &std::path::Path, audio: &str| {
        let status = std::process::Command::new("ffmpeg")
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"])
            .args(["-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=1"])
            .args(["-f", "lavfi", "-i", audio])
            .args([
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(path)
            .status()
            .expect("spawn ffmpeg");
        assert!(
            status.success(),
            "ffmpeg segment generation failed for {path:?}"
        );
    };
    make(&quiet, "anullsrc=r=48000:cl=mono:d=1");
    make(&loud, "aevalsrc=0.1*sin(2*PI*1000*t):s=48000:d=1");
    let list = dir.join("dropout_speed_step.ffconcat");
    std::fs::write(
        &list,
        format!("file '{}'\nfile '{}'\n", quiet.display(), loud.display()),
    )
    .expect("write concat list");
    let status = std::process::Command::new("ffmpeg")
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-c", "copy"])
        .arg(&out)
        .status()
        .expect("spawn ffmpeg concat");
    assert!(status.success(), "ffmpeg concat failed");
    out
}

#[test]
fn expected_envelope_maps_window_time_to_file_time_at_speed() {
    // R78 (review fix round): a source played at speed=2.0 has its FILE position
    // advance twice as fast as the window's own time (mpv's scaletempo keeps pitch, so
    // this is a genuine time-compression, not a pitch shift). A clip silent for its
    // first file-second and a tone for its second should show the level step at HALF
    // the window-time offset it would at speed=1.0 — window t=0.5s ↔ file t=1.0s, not
    // window t=1.0s.
    let path = ensure_speed_step_clip();
    let src = SourceWindow {
        id: "a".into(),
        path,
        position: 0.0,
        speed: 2.0,
        looped: false,
        duration: None,
        envelope: None,
    };
    let mut schedule: GainSchedule = GainSchedule::new();
    schedule.insert("a".into(), vec![(Duration::ZERO, 0.0)]);
    let window = (ms(0), ms(1000)); // 1 window-second = 2 file-seconds at speed 2.0
    let env = expected_envelope(&[src], &schedule, window);
    assert_eq!(env.len(), 100);
    let quiet_quarter = &env[..20];
    let loud_quarter = &env[80..];
    assert!(
        quiet_quarter.iter().all(|(_, db)| *db < -40.0),
        "first quarter (window t < 200 ms, file t < 400 ms) should still be silent: \
         {quiet_quarter:?}"
    );
    assert!(
        loud_quarter.iter().all(|(_, db)| *db > -30.0),
        "last quarter (window t ≥ 800 ms, file t ≥ 1600 ms) should already be audible: \
         {loud_quarter:?}"
    );
}

#[test]
fn expected_envelope_wraps_a_looping_source_across_its_duration() {
    // R78 (review fix round): a window spanning more than one lap of a short, looping
    // source must stay continuous across the wrap — no artificial silence where
    // `decode_power_bins` would otherwise treat crossing `duration` as "past EOF".
    let path = ensure_clip(
        "dropout_loop_tone",
        ClipSpec::Solid {
            rgb: [0, 0, 0],
            secs: 0.3,
            tone_hz: 1000.0,
            tone_dbfs: -20.0,
        },
    );
    let src = SourceWindow {
        id: "a".into(),
        path,
        position: 0.0,
        speed: 1.0,
        looped: true,
        duration: Some(0.3),
        envelope: None,
    };
    let mut schedule: GainSchedule = GainSchedule::new();
    schedule.insert("a".into(), vec![(Duration::ZERO, 0.0)]);
    let window = (ms(0), ms(700)); // > 2 laps of a 300 ms clip
    let env = expected_envelope(&[src], &schedule, window);
    assert_eq!(env.len(), 70);
    for (i, (_, db)) in env.iter().enumerate() {
        assert!(
            (*db - (-20.0)).abs() < 1.5,
            "bin {i} ({db} dB) should stay at the clip's own level across the loop wrap \
             — no false drop at t ≈ 300 ms / 600 ms"
        );
    }
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
