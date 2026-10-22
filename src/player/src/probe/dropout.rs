//! The reference-based dropout detector (Task 15; spec §5.3, §9 "debug mode"): a port of
//! the proven `scripts/lp_audiowatch.py` monitor (2026-10-20, found the cubic-volume-sag,
//! speed-step micro-gap and ready-timeout-silence bugs documented in
//! `docs/player/debugging.md`). It compares what the player's audio bus actually output
//! (the 1 ms [`crate::audio::meter::Meter`] window, Task 14) against what it SHOULD have
//! output (the transition's sources, decoded from their logged positions, weighted by the
//! *recorded* gain schedule) — so a real dropout is flagged while silence that's in the
//! content, or intended by a held transition method (reveal/frozen), is not.
//!
//! **R70 — why a recorded schedule, not `Animator::value_at` after the fact.** The brief
//! sketched reconstructing each source's gain from `Animator::value_at`, but an
//! animation's entry is only guaranteed to answer for *its own* target path, and by the
//! time this probe's worker thread runs (after `transition.done`, off the loop — R71) the
//! source may already be destroyed/buried (graveyard) and its animations gone outright
//! (`cancel`/a later `add()` on the same path supersedes permanently — `anim.rs`). So the
//! runtime instead records each live source's `Graph::effective_gain_db` once per tick
//! into [`GainHistory`], a small per-source ring on the **log's `t_mono_ms` clock**
//! (`log::mono_now`, never `Runtime::now()` — which may be the stepped/virtual clock and
//! would disagree with the meter's real-time samples), independent of whether the node
//! itself still exists. `transition.started` carries each source's id/path/`time_pos` at
//! that instant ([`crate::recipes::transition::AudioSourceSnapshot`]); [`expected_envelope`]
//! takes both.
//!
//! **R71 — never blocks the loop.** After `transition.done`, if `player.debug` is on, the
//! runtime snapshots the meter window + the recorded gain schedule (cheap, synchronous,
//! main thread) and hands the owned snapshot to a spawned `std::thread` that does the
//! `ffmpeg` decode + [`analyse`] and then `log::event("probe", Info, "probe.dropout",
//! …)`s the result — which reaches subscribers exactly the way every other cross-thread
//! event does (the bus thread's `audio.bus.*` events, §Audio bus): `log::event` is
//! thread-safe, and the tap pings the loop's own wake fd. No new channel/plumbing needed.
//! `probe {"name":"dropout","args":{"corr":…}}` (registered in `probe/mod.rs`) runs the
//! same path on demand: it replies `{"status":"pending","corr"}` at once (never defers
//! the reply the way `step` does — simpler, and sufficient since the result is an event
//! anyway) and the `probe.dropout` event follows once the worker thread finishes. If the
//! meter is unavailable (bus down, `--ao null`) the event (or, for the on-demand verb, the
//! reply) says so with `skipped` instead of running anything.
//!
//! ## Review fix round (binding controller rulings, kept distinct from the task-15 brief)
//!
//! **R76 — mean, not median, dB error.** The brief's text says the lag search minimises
//! the *median* absolute dB error; [`DropoutReport::fit_db`] has always been, and stays,
//! the **mean** (power-domain-correct arithmetic mean of `|observed − expected − offset|`
//! over the qualifying bins) — exact parity with the proven `lp_audiowatch.py` reference
//! (`refcheck`'s `err = sum(...) / len(pairs)`), which the brief's own text misdescribes.
//! `offset_db` is the one place a *median* is used (robust against one outlier bin). Kept
//! deliberately; flagged here rather than "fixed" to match a brief that was itself wrong.
//!
//! **R77 — the lag-search guard scales with the window, not a bare constant.** A fixed
//! `MIN_LAG_PAIRS = 3` let a near-silent window pick an arbitrary "best" lag; the Python
//! reference uses a flat 50, too strict for these mostly sub-second windows. The guard is
//! now `max(10, min(50, qualifying_bins / 2))`, where `qualifying_bins` = how many of
//! `expected`'s own bins are audible (`> −60 dB`) at all — independent of the lag or of
//! the capture's own plausibility, so it's the same number for every lag candidate. A lag
//! whose *actual* paired-bin count falls short is skipped; if **no** lag clears the guard,
//! [`analyse`] returns [`FitStatus::Insufficient`] with `lag_ms: 0`, `fit_db: 0.0`,
//! `offset_db: 0.0` and **no** drops/micro-gaps — a report that can't trust its own
//! alignment must not invent findings on top of it. `DropoutReport` stays serde-stable
//! (no field changes, only the new additive `fit` field): old consumers that don't look
//! at `fit` see exactly the same shape as before.
//!
//! **R78 — speed and loop wrap.** [`AudioSourceSnapshot`] now carries `speed`, `loop_`
//! (serializes `"loop"`) and `duration`, snapshotted alongside `path`/`position`.
//! [`expected_envelope`]/[`expected_envelopes`] decode each source's **file-time** span
//! (`window length × speed`, mpv's scaletempo keeping pitch — so the decoded power bins
//! are the time-compressed/expanded envelope) and resample it onto the window's own 10 ms
//! (or, for the fine envelope, 1 ms) grid at `⌊k·speed⌋`; a looping source whose window
//! crosses its own `duration` is decoded in wrap-around segments (`decode_wrapped`) so the
//! envelope stays continuous across the loop boundary instead of silently truncating. The
//! −500 ms pre-roll rebase ([`spawn_analysis`]) scales by `speed` too, and wraps into
//! `[0, duration)` for a looping source instead of going negative.
//!
//! **R79 — bounded concurrent analyses, tracked ffmpeg children.** At most
//! [`MAX_CONCURRENT_ANALYSES`] decode+analyse passes run at once (a small
//! `Mutex<usize>` + `Condvar` gate, not a queue — a refused request is told `skipped:
//! "busy"` immediately, synchronously, never queued); every ffmpeg child this module
//! spawns is registered by pid (`FFMPEG_CHILDREN`) and given `PR_SET_PDEATHSIG(SIGKILL)`
//! (same technique as `tests/api.rs`'s `die_with_parent`) so it can never outlive this
//! process even if killed outright. [`shutdown`] (called from `Runtime`'s own shutdown,
//! mirroring `sources::reaper::shutdown`) kills every still-tracked child immediately
//! (no point waiting one out) then waits up to its `timeout` for every gate slot to free,
//! logging + returning the straggler count.
//!
//! **R80 — the micro-gap comparison is 1 ms-accurate, not a 10 ms zero-order hold.** The
//! frozen-method micro-gap the owner flagged (`at_ms` ≈ 35 ms after a 1000 ms effect's own
//! end, relative to the window's start) sat right at A's 30 ms anti-click ramp to silence
//! — comparing a 1 ms observed sample against its *whole 10 ms bin's* expected level (one
//! gain value, held for the entire bin) makes a steep ramp's quiet tail look like a
//! dropout even when nothing actually glitched. [`mix_envelope_fine`] recomputes the
//! expected level at 1 ms resolution: the same 10 ms **source-power** bin (drops, at 10 ms
//! resolution, are unaffected and keep using it directly), but the **gain** evaluated at
//! that exact millisecond via [`gain_lin_interp_at`] — linear interpolation **in
//! amplitude** between [`GainHistory`]'s recorded ticks, not a held/stepped value. Only
//! `micro_gaps` uses this ([`analyse_with_fine`]); `drops` and the lag search are
//! unchanged. If a micro-gap still appears after this fix, it is real (see
//! `docs/player/debugging.md`'s "frozen-method micro-gap" row for what to report).

use std::collections::{HashMap, VecDeque};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};

use crate::graph::ApiError;
use crate::log::{self, CorrId, Level};
use crate::recipes::transition::AudioSourceSnapshot;
use crate::runtime::Runtime;
use crate::units::{SILENT_DB, db_to_lin};

/// Bin width for the whole algorithm (lag search, drops): 10 ms, matching the Python
/// reference.
const BIN_MS: i64 = 10;
/// The probe's window around a transition (R71): `transition.started` − this, `.done` +
/// this.
pub const WINDOW_PRE: Duration = Duration::from_millis(500);
pub const WINDOW_POST: Duration = Duration::from_millis(500);
/// Lag search range (0..=25 × 10 ms = 0..=250 ms), inclusive, matching the brief.
const MAX_LAG_BINS: i64 = 25;
/// Review fix round, R79: at most this many decode+analyse passes run at once (ffmpeg
/// decode is the expensive part — two full-resolution decodes is already real CPU/IO
/// load off the loop thread). A request beyond this is refused with `skipped: "busy"`
/// rather than queued — the caller (debug mode's auto-trigger, or `ctl probe dropout`)
/// can just try again once one finishes.
const MAX_CONCURRENT_ANALYSES: usize = 2;
/// A `(time, dB)` envelope — the shared shape of `observed`/`expected`/the fine
/// envelope, factored out purely to keep [`expected_envelopes`]'s signature readable
/// (clippy `type_complexity`).
type Envelope = Vec<(Duration, f64)>;

// --------------------------------------------------------------------- analyse()

/// One flagged run of bins/samples under the expected level.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Drop {
    /// Milliseconds relative to `expected`'s first entry (in the live probe, that's
    /// `transition.started` − [`WINDOW_PRE`] — i.e. **not** quite "relative to effect
    /// start" at the byte level, but the wiring in [`spawn_analysis`] rebases `position`s
    /// so `expected`'s own zero already *is* the window's start; see that function).
    pub at_ms: i64,
    pub len_ms: u32,
    /// How far under `expected + offset` the run got, in dB (the worst bin/sample in it).
    pub under_db: f64,
}

/// Whether [`analyse`]/[`analyse_with_fine`] found a reliable alignment at all (R77,
/// review fix round). Additive field — `DropoutReport` otherwise serializes exactly as
/// before, so an older consumer that never looks at `fit` sees no change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FitStatus {
    /// A lag cleared the guard (§ module docs, R77); `lag_ms`/`fit_db`/`offset_db` and any
    /// `drops`/`micro_gaps` are meaningful.
    Ok,
    /// No lag had enough qualifying paired bins to trust — `lag_ms: 0`, `fit_db: 0.0`,
    /// `offset_db: 0.0`, `drops`/`micro_gaps` empty, *not* "no dropout found": "couldn't
    /// check." Never flag a finding on top of an alignment that isn't trustworthy.
    Insufficient,
}

/// What [`analyse`] found.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DropoutReport {
    /// The lag (ms, 10 ms steps) that best aligns `observed` to `expected`.
    pub lag_ms: u32,
    /// Mean absolute dB error at that lag, after `offset_db` — how good the fit is. R76
    /// (review fix round): the brief's text says "median" here; this has always been,
    /// and stays, the **mean** — exact parity with `lp_audiowatch.py`'s `refcheck`, which
    /// the brief's text misdescribed. See the module docs.
    pub fit_db: f64,
    /// Median `observed − expected` at the chosen lag (a level mismatch, e.g. a
    /// miscalibrated bus gain, isn't itself a dropout).
    pub offset_db: f64,
    /// R77 (review fix round): `Insufficient` when no lag had enough reliably-paired
    /// bins to trust — see [`FitStatus`].
    pub fit: FitStatus,
    /// 10 ms-bin-granularity gaps the aligned, offset-corrected observed level falls
    /// ≥ 15 dB under an audible (> −55 dB) expected level.
    pub drops: Vec<Drop>,
    /// Finer, ≥ 2 ms runs of raw (1 ms) observed samples ≥ 35 dB under their 10 ms
    /// expected bin while that bin is audible (> −45 dB) — catches a dropout too short to
    /// move a whole 10 ms bin's power average.
    pub micro_gaps: Vec<Drop>,
}

/// Power-domain mean of dB values, back to dB (`10·log10(mean(10^(d/10)))`) — never a
/// plain arithmetic mean of the dB values themselves (that would be biased quiet).
fn pw_mean_db(vals: &[f64]) -> f64 {
    debug_assert!(!vals.is_empty());
    let lin_sum: f64 = vals.iter().map(|d| 10f64.powf(d / 10.0)).sum();
    10.0 * (lin_sum / vals.len() as f64).log10()
}

/// This duration's 10 ms bin index on an absolute, arbitrary-origin grid (integer
/// milliseconds, never float seconds — avoids a boundary sample flooring into the wrong
/// bin from floating-point noise).
fn bin10(d: Duration) -> i64 {
    (d.as_millis() as i64) / BIN_MS
}

/// Port of `lp_audiowatch.py`'s `refcheck` (the reference-based half): aligns `observed`
/// (raw, ~1 ms-resolution bus-meter samples) against `expected` (10 ms power bins, e.g.
/// from [`expected_envelope`]) by searching a 0–250 ms lag, then flags both coarse
/// (10 ms-bin) drops and fine (sub-bin) micro-gaps against that same coarse `expected` —
/// the brief's exact signature, kept for the 5 task-15 synthetic tests and any other
/// caller with no finer envelope to offer. [`analyse_with_fine`] is the R80 fix-round
/// entry point production wiring ([`spawn_analysis`]) actually uses.
pub fn analyse(observed: &[(Duration, f64)], expected: &[(Duration, f64)]) -> DropoutReport {
    analyse_inner(observed, expected, None)
}

/// Like [`analyse`], but `fine_expected` (e.g. from [`mix_envelope_fine`]/
/// [`expected_envelopes`] — 1 ms-resolution, same time origin as `expected`) is used for
/// the micro-gap pass instead of holding `expected`'s 10 ms bin value across the whole
/// bin (R80, review fix round: that zero-order hold is what turned a legitimate 30 ms
/// anti-click ramp's quiet tail into a false micro-gap). `drops` and the lag search are
/// unaffected — they still use the coarse `expected` only.
pub fn analyse_with_fine(
    observed: &[(Duration, f64)],
    expected: &[(Duration, f64)],
    fine_expected: &[(Duration, f64)],
) -> DropoutReport {
    analyse_inner(observed, expected, Some(fine_expected))
}

fn analyse_inner(
    observed: &[(Duration, f64)],
    expected: &[(Duration, f64)],
    fine_expected: Option<&[(Duration, f64)]>,
) -> DropoutReport {
    if expected.is_empty() {
        return DropoutReport {
            lag_ms: 0,
            fit_db: 0.0,
            offset_db: 0.0,
            fit: FitStatus::Insufficient,
            drops: Vec::new(),
            micro_gaps: Vec::new(),
        };
    }
    let origin = bin10(expected[0].0);
    let exp: Vec<f64> = expected.iter().map(|(_, v)| *v).collect();
    let n = exp.len() as i64;

    // Bin the raw observed samples onto the expected grid (sparse — a gap in the meter
    // leaves a bin with no entry at all, never a fabricated silence).
    let mut cap_bins: HashMap<i64, Vec<f64>> = HashMap::new();
    for (t, db) in observed {
        cap_bins.entry(bin10(*t) - origin).or_default().push(*db);
    }
    let capb = |k: i64| -> Option<f64> {
        cap_bins
            .get(&k)
            .filter(|v| !v.is_empty())
            .map(|v| pw_mean_db(v))
    };

    // R77 (review fix round): the guard scales with the window instead of a bare
    // constant — see the module docs. Independent of lag/capture: just how many of
    // `expected`'s own bins are audible at all.
    let qualifying = exp.iter().filter(|&&e| e > -60.0).count();
    let min_pairs = (qualifying / 2).clamp(10, 50);

    // Lag search: minimise the mean absolute dB error (after a median offset) over bins
    // where expected is audible and the capture isn't implausibly loud (> -90 filters
    // noise-floor junk out of the fit, same as the Python reference).
    let mut best: Option<(f64, i64, f64)> = None; // (err, lag, offset)
    for lag in 0..=MAX_LAG_BINS {
        if lag >= n {
            continue;
        }
        let mut pairs: Vec<(f64, f64)> = Vec::new();
        for k in 0..(n - lag) {
            if let Some(c) = capb(k + lag) {
                let e = exp[k as usize];
                if e > -60.0 && c > -90.0 {
                    pairs.push((c, e));
                }
            }
        }
        if pairs.len() < min_pairs {
            continue;
        }
        let mut diffs: Vec<f64> = pairs.iter().map(|(c, e)| c - e).collect();
        diffs.sort_by(f64::total_cmp);
        let off = diffs[diffs.len() / 2];
        let err = pairs.iter().map(|(c, e)| (c - e - off).abs()).sum::<f64>() / pairs.len() as f64;
        if best.is_none_or(|(be, _, _)| err < be) {
            best = Some((err, lag, off));
        }
    }
    let Some((fit_db, lag, offset_db)) = best else {
        // No lag had enough reliably-paired bins to trust an alignment at all — report
        // that plainly rather than guessing a lag of 0 and flagging findings on top of
        // it (R77).
        return DropoutReport {
            lag_ms: 0,
            fit_db: 0.0,
            offset_db: 0.0,
            fit: FitStatus::Insufficient,
            drops: Vec::new(),
            micro_gaps: Vec::new(),
        };
    };

    // Drops: runs of 10 ms bins at least 15 dB under an audible expected level.
    let mut drops = Vec::new();
    let mut k = 0i64;
    while k < n - lag {
        let e = exp[k as usize] + offset_db;
        let c = capb(k + lag);
        if e > -55.0 && c.is_some_and(|c| c < e - 15.0) {
            let start = k;
            let mut worst = 0.0f64;
            let mut j = k;
            while j < n - lag {
                let ej = exp[j as usize] + offset_db;
                match capb(j + lag) {
                    Some(cj) if ej > -55.0 && cj < ej - 15.0 => {
                        worst = worst.max(ej - cj);
                        j += 1;
                    }
                    _ => break,
                }
            }
            drops.push(Drop {
                at_ms: start * BIN_MS,
                len_ms: ((j - start) * BIN_MS) as u32,
                under_db: worst,
            });
            k = j;
        } else {
            k += 1;
        }
    }

    // Micro-gaps: raw (sub-bin) observed samples far under their expected level at that
    // exact instant. R80: when a `fine_expected` (1 ms resolution) is available, use it
    // (shifted by the same lag, in continuous time) instead of holding the coarse bin's
    // value across its whole 10 ms span.
    let fine_origin = fine_expected.and_then(|f| f.first()).map(|(t, _)| *t);
    let lag_dur = Duration::from_millis((lag * BIN_MS).max(0) as u64);
    let mut micro_gaps = Vec::new();
    let mut run: Vec<(Duration, f64, f64)> = Vec::new();
    let flush = |run: &mut Vec<(Duration, f64, f64)>, out: &mut Vec<Drop>| {
        if run.len() >= 2 {
            let start = run[0].0;
            let at_ms = (start.as_millis() as i64) - (expected[0].0.as_millis() as i64);
            let len_ms = run.len() as u32; // ~1 ms-spaced samples (the bus meter's own rate)
            let under_db = run.iter().map(|(_, d, e)| e - d).fold(0.0, f64::max);
            out.push(Drop {
                at_ms,
                len_ms,
                under_db,
            });
        }
        run.clear();
    };
    for (t, d) in observed {
        let e = match (fine_expected, fine_origin) {
            (Some(fine), Some(fine_origin)) => t
                .checked_sub(lag_dur)
                .and_then(|t_exp| t_exp.checked_sub(fine_origin))
                .and_then(|rel| fine.get(rel.as_millis() as usize))
                .map(|(_, v)| v + offset_db),
            _ => {
                let k = bin10(*t) - origin - lag;
                if k >= 0 && (k as usize) < exp.len() {
                    Some(exp[k as usize] + offset_db)
                } else {
                    None
                }
            }
        };
        match e {
            Some(e) if e > -45.0 && *d < e - 35.0 => run.push((*t, *d, e)),
            _ => flush(&mut run, &mut micro_gaps),
        }
    }
    flush(&mut run, &mut micro_gaps);

    DropoutReport {
        lag_ms: (lag * BIN_MS) as u32,
        fit_db,
        offset_db,
        fit: FitStatus::Ok,
        drops,
        micro_gaps,
    }
}

// --------------------------------------------------------------- expected_envelope()

/// One source feeding the expected mix: its graph id (must match a [`GainSchedule`] key),
/// its decoded file path, and its playback position (file-seconds) **at the window's own
/// start** (`window.0` of whatever window it's later decoded against — the probe wiring
/// in [`spawn_analysis`] rebases the position recorded at `transition.started`, which is
/// effect start, by subtracting [`WINDOW_PRE`] (scaled by `speed`, R78)).
#[derive(Debug, Clone, PartialEq)]
pub struct SourceWindow {
    pub id: String,
    pub path: PathBuf,
    pub position: f64,
    /// R78 (review fix round): playback speed at snapshot time. The decoded **file-time**
    /// span covering one window is `(window length) × speed` — mpv's scaletempo keeps
    /// pitch, so file time genuinely advances `speed`× the window's own time; the decoded
    /// power bins are that time-compressed/expanded envelope, resampled back onto the
    /// window's own 10 ms (or 1 ms, for the fine envelope) grid.
    pub speed: f64,
    /// R78: whether the source loops. A window whose file-time span crosses `duration` is
    /// decoded in wrap-around segments ([`decode_wrapped`]) instead of silently treating
    /// the wrap as EOF and padding silence.
    pub looped: bool,
    /// R78: the source's own duration (file-seconds) at snapshot time, when known.
    /// `None` disables wrap handling even if `looped` is set — nothing to wrap against.
    pub duration: Option<f64>,
}

/// One source's recorded `(t, effective_gain_db)` history, oldest first, on the log's
/// `t_mono_ms` clock.
pub type GainTrack = Vec<(Duration, f64)>;
/// Recorded schedules for every source feeding one transition's expected mix, keyed by
/// graph id.
pub type GainSchedule = HashMap<String, GainTrack>;

/// Nearest-previous lookup: the last recorded dB at or before `t`; the track's first
/// entry if `t` precedes everything recorded (the source had been at that level all
/// along, as far as we know); [`SILENT_DB`] if the id has no track at all — a source we
/// never recorded is treated as silent, never guessed loud. Used by the coarse
/// [`mix_envelope`] (one gain value held across each whole 10 ms bin); the fine envelope
/// uses [`gain_lin_interp_at`] instead (R80).
fn gain_at(track: Option<&GainTrack>, t: Duration) -> f64 {
    let Some(track) = track.filter(|t| !t.is_empty()) else {
        return SILENT_DB;
    };
    let idx = track.partition_point(|(ts, _)| *ts <= t);
    if idx == 0 {
        track[0].1
    } else {
        track[idx - 1].1
    }
}

/// Linear interpolation **in amplitude** (R80, review fix round) between the two
/// [`GainHistory`] ticks bracketing `t` — unlike [`gain_at`]'s nearest-previous/held
/// value, this tracks a ramp continuously between ticks instead of snapping to the
/// last-recorded ones. Before the first recorded tick, or with no track at all:
/// [`SILENT_DB`] (never guessed loud — same rule as `gain_at`); at or after the last
/// tick: held there (nothing newer is known).
fn gain_lin_interp_at(track: Option<&GainTrack>, t: Duration) -> f64 {
    let Some(track) = track.filter(|t| !t.is_empty()) else {
        return db_to_lin(SILENT_DB);
    };
    let idx = track.partition_point(|(ts, _)| *ts <= t);
    if idx == 0 {
        return db_to_lin(track[0].1);
    }
    if idx >= track.len() {
        return db_to_lin(track[track.len() - 1].1);
    }
    let (t0, db0) = track[idx - 1];
    let (t1, db1) = track[idx];
    if t1 <= t0 {
        return db_to_lin(db0);
    }
    let frac = t.saturating_sub(t0).as_secs_f64() / (t1 - t0).as_secs_f64();
    let a0 = db_to_lin(db0);
    let a1 = db_to_lin(db1);
    a0 + (a1 - a0) * frac
}

/// `ffmpeg` resolved from `PATH` (never a hard-coded store path — same rule as
/// `scripts/lp_audiowatch.py`).
const FFMPEG: &str = "ffmpeg";

/// R79 (review fix round): ffmpeg children this module has spawned and not yet reaped —
/// [`shutdown`] kills every one of these outright rather than waiting it out; each is
/// also given `PR_SET_PDEATHSIG(SIGKILL)` at spawn (same technique as `tests/api.rs`'s
/// `die_with_parent`), so a hard-killed player can never leave one running either way.
static FFMPEG_CHILDREN: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn register_child(pid: u32) {
    FFMPEG_CHILDREN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(pid);
}

fn unregister_child(pid: u32) {
    let mut g = FFMPEG_CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = g.iter().position(|&p| p == pid) {
        g.swap_remove(i);
    }
}

/// Sends every still-tracked decode child `SIGKILL` (R79: `shutdown`'s first move).
fn kill_all_children() {
    let g = FFMPEG_CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
    for &pid in g.iter() {
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
}

/// Spawn-and-wait one ffmpeg decode (R79): tracked by pid for the call's lifetime
/// ([`register_child`]/[`unregister_child`]) and `PR_SET_PDEATHSIG(SIGKILL)`'d so it
/// can't outlive this process even on an abrupt exit.
fn run_ffmpeg(start_s: f64, decode_s: f64, path: &Path) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new(FFMPEG);
    cmd.arg("-v")
        .arg("error")
        .arg("-ss")
        .arg(format!("{:.3}", start_s.max(0.0)))
        .arg("-t")
        .arg(format!("{decode_s:.3}"))
        .arg("-i")
        .arg(path)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("48000")
        .arg("-f")
        .arg("f32le")
        .arg("-");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    let pid = child.id();
    register_child(pid);
    let out = child.wait_with_output();
    unregister_child(pid);
    out
}

/// Decode `path` from `start_s` for `dur_s` seconds of **file time** into one **linear
/// power** value (`mean(x²)`) per 10 ms bin, mono 48 kHz — padding silence before
/// file-start and past EOF/a decode failure, same convention as the Python reference's
/// `decode_env`. Never panics: a missing file, a bad path or no `ffmpeg` on `PATH` all
/// just come back silent (logged once, rate-limited, as `probe.dropout_decode_failed`),
/// since this runs off the main loop and must not take the player down over a
/// stale/renamed wallpaper file.
fn decode_plain(path: &Path, start_s: f64, dur_s: f64) -> Vec<f64> {
    let n_bins = (dur_s * 100.0).round().max(0.0) as usize;
    let pad_s = (-start_s).max(0.0);
    let decode_s = (dur_s - pad_s).max(0.0);
    let pad_bins = ((pad_s * 100.0).round() as usize).min(n_bins);
    let mut bins = vec![0.0f64; pad_bins];
    if decode_s > 0.0 && !path.as_os_str().is_empty() {
        match run_ffmpeg(start_s.max(0.0), decode_s, path) {
            Ok(o) if o.status.success() => {
                let samples: Vec<f32> = o
                    .stdout
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();
                const PER_BIN: usize = 480; // 48 kHz * 10 ms
                let mut i = 0;
                while bins.len() < n_bins && i + PER_BIN <= samples.len() {
                    let seg = &samples[i..i + PER_BIN];
                    let p =
                        seg.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / PER_BIN as f64;
                    bins.push(p);
                    i += PER_BIN;
                }
            }
            Ok(o) => decode_failed(path, &String::from_utf8_lossy(&o.stderr)),
            Err(e) => decode_failed(path, &e.to_string()),
        }
    }
    bins.resize(n_bins, 0.0);
    bins
}

/// A loop too short to decode this many laps within one window is almost certainly a
/// misconfigured/zero `duration` — bail to padding silence rather than spinning ffmpeg
/// hundreds of times (R78).
const MAX_LOOP_SEGMENTS: usize = 64;

/// Decodes `span_s` seconds of **file time** starting at `start_s`, wrapping at
/// `duration` when `looped` is set (R78: "when loop is on and the window crosses EOF,
/// decode in segments wrapping to 0") — each segment stays within one lap, so
/// [`decode_plain`]'s own past-EOF padding never fires mid-loop. Falls back to a single
/// [`decode_plain`] call (unchanged behaviour, including negative-`start_s` padding)
/// when not looping or the duration isn't known.
fn decode_wrapped(
    path: &Path,
    start_s: f64,
    span_s: f64,
    duration: Option<f64>,
    looped: bool,
) -> Vec<f64> {
    let Some(d) = duration.filter(|d| looped && *d > 0.0) else {
        return decode_plain(path, start_s, span_s);
    };
    let n_bins = (span_s * 100.0).round().max(0.0) as usize;
    let mut cur = start_s.rem_euclid(d);
    let mut remaining = span_s;
    let mut bins = Vec::with_capacity(n_bins);
    let mut laps = 0;
    while remaining > 1e-6 && laps < MAX_LOOP_SEGMENTS {
        let seg_len = (d - cur).min(remaining);
        bins.append(&mut decode_plain(path, cur, seg_len));
        remaining -= seg_len;
        cur = 0.0;
        laps += 1;
    }
    bins.resize(n_bins, 0.0);
    bins
}

/// Resamples FILE-time power bins (10 ms each) onto the window's own 10 ms grid at
/// `speed` (R78): window bin `k` reads file bin `⌊k·speed⌋`, clamped to the last decoded
/// bin past EOF/silence padding. Pure — unit-tested without ffmpeg.
fn resample_to_window(file_bins: &[f64], n_window_bins: usize, speed: f64) -> Vec<f64> {
    (0..n_window_bins)
        .map(|k| {
            let idx = ((k as f64) * speed).floor().max(0.0) as usize;
            file_bins.get(idx).copied().unwrap_or(0.0)
        })
        .collect()
}

static DECODE_WARN_LAST: Mutex<Option<Instant>> = Mutex::new(None);
const DECODE_WARN_EVERY: Duration = Duration::from_secs(5);

fn decode_failed(path: &Path, reason: &str) {
    let mut last = DECODE_WARN_LAST.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    if last.is_some_and(|t| now.duration_since(t) < DECODE_WARN_EVERY) {
        return;
    }
    *last = Some(now);
    drop(last);
    log::event(
        "probe",
        Level::Warn,
        "probe.dropout_decode_failed",
        None,
        json!({ "path": path.display().to_string(), "reason": reason }),
    );
}

/// `decode_wrapped` + [`resample_to_window`] (R78): the window-time, speed/loop-aware
/// decode behind both [`expected_envelope`] and the fine envelope — one ffmpeg decode per
/// source, shared by [`expected_envelopes`].
fn decode_power_bins(
    path: &Path,
    start_s: f64,
    dur_s: f64,
    speed: f64,
    duration: Option<f64>,
    looped: bool,
) -> Vec<f64> {
    let speed = if speed > 0.0 { speed } else { 1.0 };
    let file_span_s = dur_s * speed;
    let file_bins = decode_wrapped(path, start_s, file_span_s, duration, looped);
    let n_window_bins = (dur_s * 100.0).round().max(0.0) as usize;
    resample_to_window(&file_bins, n_window_bins, speed)
}

/// The pure half of [`expected_envelope`] — mixes already-decoded linear power bins by the
/// recorded gain schedule. Separated out so the gain-weighting math (what actually makes a
/// held/frozen transition's silence come out silent in the expected mix even when the
/// underlying file is loud — R70/R71) is unit-testable without a subprocess.
fn mix_envelope(
    ids: &[String],
    decoded: &[Vec<f64>],
    gain_schedule: &GainSchedule,
    window: (Duration, Duration),
) -> Vec<(Duration, f64)> {
    let n_bins = decoded.iter().map(Vec::len).max().unwrap_or(0);
    let mut out = Vec::with_capacity(n_bins);
    for k in 0..n_bins {
        let t = window.0 + Duration::from_millis((k as u64) * BIN_MS as u64);
        let mut total = 0.0f64;
        for (i, id) in ids.iter().enumerate() {
            let g = gain_at(gain_schedule.get(id), t);
            let lin = db_to_lin(g);
            let p = decoded[i].get(k).copied().unwrap_or(0.0);
            total += p * lin * lin;
        }
        let db = if total > 1e-14 {
            10.0 * total.log10()
        } else {
            -140.0
        };
        out.push((t, db));
    }
    out
}

/// The 1 ms-resolution twin of [`mix_envelope`] (R80, review fix round): the same decoded
/// per-source 10 ms **power** bins (drops still compare against the coarse envelope
/// built from these, unaffected), but the **gain** evaluated at each exact millisecond
/// via [`gain_lin_interp_at`] instead of held across the whole 10 ms bin. Used only for
/// the micro-gap pass ([`analyse_with_fine`]).
fn mix_envelope_fine(
    ids: &[String],
    decoded: &[Vec<f64>],
    gain_schedule: &GainSchedule,
    window: (Duration, Duration),
) -> Vec<(Duration, f64)> {
    let total_ms = window.1.saturating_sub(window.0).as_millis() as usize;
    let mut out = Vec::with_capacity(total_ms);
    for ms in 0..total_ms {
        let t = window.0 + Duration::from_millis(ms as u64);
        let bin = ms / BIN_MS as usize;
        let mut total = 0.0f64;
        for (i, id) in ids.iter().enumerate() {
            let g = gain_lin_interp_at(gain_schedule.get(id), t);
            let p = decoded[i].get(bin).copied().unwrap_or(0.0);
            total += p * g * g;
        }
        let db = if total > 1e-14 {
            10.0 * total.log10()
        } else {
            -140.0
        };
        out.push((t, db));
    }
    out
}

/// `expected_envelope(src_paths_and_positions, gain_schedule, window) -> Vec<(Duration,
/// f64)>` (the brief's signature): the coarse (10 ms) half of [`expected_envelopes`] —
/// kept as its own entry point for the task-15 synthetic/integration tests.
pub fn expected_envelope(
    sources: &[SourceWindow],
    gain_schedule: &GainSchedule,
    window: (Duration, Duration),
) -> Vec<(Duration, f64)> {
    expected_envelopes(sources, gain_schedule, window).0
}

/// Decodes each source once (`ffmpeg -ss <pos> -t <len>`; R78: `<pos>`/`<len>` are
/// FILE-time, scaled by the source's own `speed` and wrapped at `duration` when
/// `looped`), multiplies each by `db_to_lin(gain)²` per source per bin and sums — same
/// as `lp_audiowatch.py`'s `refcheck` — and returns BOTH the coarse (10 ms; lag search +
/// `drops`) and fine (1 ms; R80's micro-gap pass) expected envelopes from that one
/// decode.
pub fn expected_envelopes(
    sources: &[SourceWindow],
    gain_schedule: &GainSchedule,
    window: (Duration, Duration),
) -> (Envelope, Envelope) {
    let dur_s = window.1.saturating_sub(window.0).as_secs_f64();
    let decoded: Vec<Vec<f64>> = sources
        .iter()
        .map(|s| decode_power_bins(&s.path, s.position, dur_s, s.speed, s.duration, s.looped))
        .collect();
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let coarse = mix_envelope(&ids, &decoded, gain_schedule, window);
    let fine = mix_envelope_fine(&ids, &decoded, gain_schedule, window);
    (coarse, fine)
}

// --------------------------------------------------------------------- runtime wiring

/// How long a source's gain history is kept — comfortably past the brief's "≥ 30 s".
const HISTORY_SPAN: Duration = Duration::from_secs(40);

/// Per-source `effective_gain_db` history, one entry per `Runtime` tick, on the log's
/// `t_mono_ms` clock (R70).
#[derive(Default)]
pub(crate) struct GainHistory {
    tracks: HashMap<String, VecDeque<(Duration, f64)>>,
}

impl GainHistory {
    pub(crate) fn new() -> GainHistory {
        GainHistory::default()
    }

    /// Record one tick's readings, pruning entries older than [`HISTORY_SPAN`] (per
    /// source, so a source that stops changing isn't forgotten just because others tick).
    pub(crate) fn record(&mut self, t: Duration, readings: impl Iterator<Item = (String, f64)>) {
        for (id, db) in readings {
            let track = self.tracks.entry(id).or_default();
            track.push_back((t, db));
            while track
                .front()
                .is_some_and(|(ts, _)| t.saturating_sub(*ts) > HISTORY_SPAN)
            {
                track.pop_front();
            }
        }
    }

    /// A clone of the recorded tracks for exactly these ids (cheap — bounded by
    /// [`HISTORY_SPAN`] × tick rate), handed to the worker thread.
    pub(crate) fn snapshot(&self, ids: &[String]) -> GainSchedule {
        ids.iter()
            .map(|id| {
                let track = self
                    .tracks
                    .get(id)
                    .map(|t| t.iter().copied().collect())
                    .unwrap_or_default();
                (id.clone(), track)
            })
            .collect()
    }
}

/// What's known about one transition's audio window, from `transition.started` and
/// (once it arrives) `transition.done` — enough to run [`spawn_analysis`] without
/// touching the graph/recipe again (both may be long gone by the time the worker thread
/// runs).
#[derive(Debug, Clone)]
pub(crate) struct PendingTransition {
    /// `log::mono_now()` when `transition.started` was seen.
    pub started_mono: Duration,
    pub a: Vec<AudioSourceSnapshot>,
    pub b: AudioSourceSnapshot,
    /// `log::mono_now()` when `transition.done` was seen; `None` while still running.
    pub done_mono: Option<Duration>,
}

/// Bounded (by count, not time — a transition is cheap to keep) record of recent
/// transitions' windows, for the auto-trigger and the on-demand `probe dropout` alike.
#[derive(Default)]
pub(crate) struct PendingWindows {
    order: VecDeque<String>,
    map: HashMap<String, PendingTransition>,
}

const MAX_PENDING: usize = 64;

impl PendingWindows {
    pub(crate) fn new() -> PendingWindows {
        PendingWindows::default()
    }

    pub(crate) fn started(
        &mut self,
        corr: String,
        started_mono: Duration,
        a: Vec<AudioSourceSnapshot>,
        b: AudioSourceSnapshot,
    ) {
        if !self.map.contains_key(&corr) {
            self.order.push_back(corr.clone());
            while self.order.len() > MAX_PENDING {
                if let Some(old) = self.order.pop_front() {
                    self.map.remove(&old);
                }
            }
        }
        self.map.insert(
            corr,
            PendingTransition {
                started_mono,
                a,
                b,
                done_mono: None,
            },
        );
    }

    pub(crate) fn done(&mut self, corr: &str, done_mono: Duration) {
        if let Some(p) = self.map.get_mut(corr) {
            p.done_mono = Some(done_mono);
        }
    }

    pub(crate) fn get(&self, corr: &str) -> Option<&PendingTransition> {
        self.map.get(corr)
    }
}

/// R79 (review fix round): a small gate, not a queue — at most
/// [`MAX_CONCURRENT_ANALYSES`] decode+analyse passes run at once; a request beyond that
/// is refused immediately (`skipped: "busy"`), never queued.
struct AnalysisGate {
    active: Mutex<usize>,
    cv: Condvar,
}

static ANALYSIS_GATE: AnalysisGate = AnalysisGate {
    active: Mutex::new(0),
    cv: Condvar::new(),
};

fn try_acquire_slot() -> bool {
    let mut n = ANALYSIS_GATE
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if *n >= MAX_CONCURRENT_ANALYSES {
        false
    } else {
        *n += 1;
        true
    }
}

fn release_slot() {
    let mut n = ANALYSIS_GATE
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *n = n.saturating_sub(1);
    drop(n);
    ANALYSIS_GATE.cv.notify_all();
}

/// Frees the gate slot on drop — panic-safe: a panicking analysis thread still frees its
/// slot for the next request rather than leaking it forever.
struct SlotGuard;

// `std::ops::Drop`, fully qualified: this module's own `struct Drop` (a flagged run,
// above) shadows the prelude's trait by name within this file.
impl std::ops::Drop for SlotGuard {
    fn drop(&mut self) {
        release_slot();
    }
}

/// R79 (review fix round): kills every still-tracked ffmpeg child immediately (no point
/// waiting one out — the process is on its way down), then waits up to `timeout` for
/// every gate slot to free — mirrors `sources::reaper::shutdown`. Returns how many
/// analyses are still running when the wait ends (0 = all done); `Runtime::shutdown`
/// logs a straggler count the same way it does for the mpv reaper.
pub fn shutdown(timeout: Duration) -> usize {
    kill_all_children();
    let guard = ANALYSIS_GATE
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let (guard, _timed_out) = ANALYSIS_GATE
        .cv
        .wait_timeout_while(guard, timeout, |n| *n > 0)
        .unwrap_or_else(|e| e.into_inner());
    *guard
}

/// R78 (review fix round): rebases a snapshot's `position` by [`WINDOW_PRE`] scaled by
/// its own `speed` (file time, not window time — `expected_envelope` always works in
/// file time for the decode). If the source loops, the shifted result wraps into
/// `[0, duration)` instead of going negative: a negative pre-roll on a looping source
/// isn't "before file start", it's the tail of the lap before this one.
fn rebase_position(position: f64, speed: f64, duration: Option<f64>, looped: bool) -> f64 {
    let shifted = position - WINDOW_PRE.as_secs_f64() * speed;
    if looped && let Some(d) = duration.filter(|d| *d > 0.0) {
        return shifted.rem_euclid(d);
    }
    shifted
}

fn snapshot_window(s: &AudioSourceSnapshot) -> SourceWindow {
    SourceWindow {
        id: s.id.clone(),
        path: PathBuf::from(&s.path),
        position: rebase_position(s.position, s.speed, s.duration, s.loop_),
        speed: s.speed,
        looped: s.loop_,
        duration: s.duration,
    }
}

/// Snapshot the meter + gain schedule for `pending`'s window (main thread, cheap) and
/// run the decode + [`analyse_with_fine`] on a spawned thread, delivering
/// `probe.dropout {corr, report}` (or `{corr, skipped}`) via `log::event` once it's
/// done — R71, never blocks the caller. A no-op if `pending` hasn't reached
/// `transition.done` yet. R79: refuses (`skipped: "busy"`) rather than queues past
/// [`MAX_CONCURRENT_ANALYSES`] concurrent analyses.
pub(crate) fn spawn_analysis(rt: &Runtime, corr: CorrId, pending: &PendingTransition) {
    let Some(done_mono) = pending.done_mono else {
        return;
    };
    let window = (
        pending.started_mono.saturating_sub(WINDOW_PRE),
        done_mono + WINDOW_POST,
    );
    if let Some(why) = rt.audio.meter_unavailable() {
        log::event(
            "probe",
            Level::Info,
            "probe.dropout",
            Some(corr),
            json!({ "skipped": why }),
        );
        return;
    }
    let Some(meter) = rt.audio.meter() else {
        return; // meter_unavailable() is None only with a meter (audio/mod.rs contract)
    };
    if !try_acquire_slot() {
        log::event(
            "probe",
            Level::Info,
            "probe.dropout",
            Some(corr),
            json!({ "skipped": "busy" }),
        );
        return;
    }
    let observed = meter.window(window.0, window.1);
    let mut sources = Vec::with_capacity(pending.a.len() + 1);
    for s in &pending.a {
        sources.push(snapshot_window(s));
    }
    sources.push(snapshot_window(&pending.b));
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let schedule = rt.gain_history.snapshot(&ids);
    std::thread::spawn(move || {
        let _slot = SlotGuard;
        let (expected, fine) = expected_envelopes(&sources, &schedule, window);
        let report = analyse_with_fine(&observed, &expected, &fine);
        log::event(
            "probe",
            Level::Info,
            "probe.dropout",
            Some(corr),
            json!({ "report": report }),
        );
    });
}

/// `probe {"name":"dropout","args":{"corr":"tr-12"}}` — re-runs the detector for a
/// recently-completed transition on demand (R71): async-safe by replying `pending` at
/// once and letting the worker thread's `log::event` deliver `probe.dropout` as usual,
/// rather than deferring the reply the way `step` does (simpler, and the result is an
/// event either way).
pub(super) fn probe(rt: &mut Runtime, args: &Value) -> Result<Value, ApiError> {
    let bad = |message: String| ApiError {
        code: "bad_request",
        message,
        hint: "`ctl probe '{\"name\":\"dropout\",\"args\":{\"corr\":\"tr-1\"}}'`; find a \
               corr with `ctl logs '{\"kind_prefix\":\"transition.\"}'`"
            .into(),
    };
    let Some(corr) = args.get("corr").and_then(Value::as_str) else {
        return Err(bad("dropout needs args: {\"corr\": \"tr-N\"}".into()));
    };
    let Some(pending) = rt.dropout_windows.get(corr) else {
        return Err(ApiError {
            code: "no_such_node",
            message: format!("no recorded transition window for corr {corr:?}"),
            hint: format!(
                "only the last {MAX_PENDING} transitions' windows are kept; check \
                 `ctl logs '{{\"corr\":\"{corr}\"}}'`"
            ),
        });
    };
    if pending.done_mono.is_none() {
        return Err(ApiError {
            code: "unsupported",
            message: format!("transition {corr:?} hasn't reached transition.done yet"),
            hint: "subscribe to `transition.done` and retry, or let the auto-trigger run \
                   (`set player.debug true`)"
                .into(),
        });
    }
    if let Some(why) = rt.audio.meter_unavailable() {
        return Err(ApiError {
            code: "unsupported",
            message: format!("bus meter unavailable: {why}"),
            hint: "`ctl probe '{\"name\":\"bus\"}'` shows why".into(),
        });
    }
    let corr_id = CorrId(corr.to_string());
    let pending = pending.clone();
    spawn_analysis(rt, corr_id, &pending);
    Ok(json!({ "status": "pending", "corr": corr }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn gain_at_is_nearest_previous_and_silent_when_unknown() {
        let mut schedule: GainSchedule = HashMap::new();
        schedule.insert(
            "a".into(),
            vec![(ms(0), -96.0), (ms(100), -20.0), (ms(200), -6.0)],
        );
        assert_eq!(gain_at(schedule.get("a"), ms(0)), -96.0);
        assert_eq!(gain_at(schedule.get("a"), ms(50)), -96.0);
        assert_eq!(gain_at(schedule.get("a"), ms(100)), -20.0);
        assert_eq!(gain_at(schedule.get("a"), ms(150)), -20.0);
        assert_eq!(gain_at(schedule.get("a"), ms(999)), -6.0);
        // Before a track's first recorded instant: held at its first known value.
        schedule.insert("late".into(), vec![(ms(100), -5.0), (ms(200), -1.0)]);
        assert_eq!(gain_at(schedule.get("late"), ms(0)), -5.0);
        // No track at all (never recorded): silent, never guessed loud.
        assert_eq!(gain_at(schedule.get("b_absent"), ms(0)), SILENT_DB);
        schedule.insert("empty".into(), Vec::new());
        assert_eq!(gain_at(schedule.get("empty"), ms(0)), SILENT_DB);
    }

    #[test]
    fn mix_envelope_sums_squared_linear_gain_per_source() {
        // Two sources, flat 0 dB gain throughout: the mix is just their summed power.
        let ids = vec!["a".to_string(), "b".to_string()];
        let decoded = vec![vec![0.01, 0.01], vec![0.03, 0.03]];
        let mut schedule: GainSchedule = HashMap::new();
        schedule.insert("a".into(), vec![(ms(0), 0.0)]);
        schedule.insert("b".into(), vec![(ms(0), 0.0)]);
        let window = (ms(0), ms(20));
        let env = mix_envelope(&ids, &decoded, &schedule, window);
        assert_eq!(env.len(), 2);
        let want = 10.0 * (0.04f64).log10();
        assert!((env[0].1 - want).abs() < 1e-9, "{}", env[0].1);
    }

    #[test]
    fn mix_envelope_silent_gain_suppresses_loud_content_to_the_floor() {
        // The held-method case (R71): both sources' gain is SILENT_DB throughout even
        // though the decoded content is loud (0.1 linear power ≈ −10 dB) — the mix must
        // still land at (or under) the floor, never leak the content's real level through.
        let ids = vec!["a".to_string(), "b".to_string()];
        let loud = vec![0.1; 30];
        let decoded = vec![loud.clone(), loud];
        let mut schedule: GainSchedule = HashMap::new();
        schedule.insert("a".into(), vec![(ms(0), SILENT_DB)]);
        schedule.insert("b".into(), vec![(ms(0), SILENT_DB)]);
        let window = (ms(0), ms(300));
        let env = mix_envelope(&ids, &decoded, &schedule, window);
        assert_eq!(env.len(), 30);
        for (_, db) in &env {
            assert!(*db <= -55.0, "held-method mix leaked through: {db}");
        }
    }

    #[test]
    fn pending_windows_evicts_oldest_past_the_cap() {
        let mut p = PendingWindows::new();
        let b = |n: usize| AudioSourceSnapshot {
            id: format!("b{n}"),
            path: String::new(),
            position: 0.0,
            speed: 1.0,
            loop_: false,
            duration: None,
        };
        for i in 0..MAX_PENDING + 5 {
            p.started(format!("tr-{i}"), ms(i as u64), Vec::new(), b(i));
        }
        assert!(p.get("tr-0").is_none(), "oldest must have been evicted");
        assert!(p.get(&format!("tr-{}", MAX_PENDING + 4)).is_some());
        assert_eq!(p.map.len(), MAX_PENDING);
    }

    #[test]
    fn gain_history_prunes_past_its_span() {
        let mut h = GainHistory::new();
        h.record(ms(0), std::iter::once(("s".to_string(), -6.0)));
        h.record(
            ms(HISTORY_SPAN.as_millis() as u64 + 1000),
            std::iter::once(("s".to_string(), -3.0)),
        );
        let snap = h.snapshot(&["s".to_string()]);
        let track = &snap["s"];
        assert_eq!(track.len(), 1, "the stale entry must have been pruned");
        assert_eq!(track[0].1, -3.0);
    }

    #[test]
    fn decode_power_bins_pads_silence_before_file_start() {
        // A negative start (position before the file's own 0) must pad with silence
        // rather than erroring or shifting the later bins.
        let bins = decode_power_bins(Path::new(""), -0.05, 0.1, 1.0, None, false);
        assert_eq!(bins.len(), 10);
        assert!(bins.iter().all(|&p| p == 0.0));
    }

    // ------------------------------------------------------------- R78: speed/resample

    #[test]
    fn resample_to_window_picks_file_bin_floor_k_times_speed() {
        let file_bins = vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0];
        assert_eq!(
            resample_to_window(&file_bins, 4, 1.0),
            vec![0.0, 1.0, 2.0, 3.0]
        );
        assert_eq!(
            resample_to_window(&file_bins, 4, 2.0),
            vec![0.0, 2.0, 4.0, 6.0]
        );
        // Past the decoded tail: clamped to silence, never an index panic.
        assert_eq!(resample_to_window(&file_bins, 10, 1.0)[9], 0.0);
    }

    // --------------------------------------------------------- R80: fine gain + micro-gap

    #[test]
    fn gain_lin_interp_at_interpolates_in_amplitude_between_ticks() {
        let track: GainTrack = vec![(ms(0), 0.0), (ms(100), SILENT_DB)];
        let a0 = gain_lin_interp_at(Some(&track), ms(0));
        let a_mid = gain_lin_interp_at(Some(&track), ms(50));
        let a_end = gain_lin_interp_at(Some(&track), ms(100));
        assert!((a0 - 1.0).abs() < 1e-9, "{a0}");
        // Exactly half-way IN AMPLITUDE, not in dB (dB is logarithmic — its midpoint
        // would read far quieter than this).
        let want_mid = (1.0 + db_to_lin(SILENT_DB)) / 2.0;
        assert!((a_mid - want_mid).abs() < 1e-9, "{a_mid} vs {want_mid}");
        assert!((a_end - db_to_lin(SILENT_DB)).abs() < 1e-9, "{a_end}");
        // No track at all / before the first tick: silent, never guessed loud.
        assert!((gain_lin_interp_at(None, ms(0)) - db_to_lin(SILENT_DB)).abs() < 1e-9);
    }

    #[test]
    fn fine_resolution_micro_gap_pass_does_not_flag_a_clean_anticlick_ramp() {
        // R80 (review fix round): a legitimate 30 ms ramp-to-silence (anti-click),
        // flat before and after. The OLD coarse (10 ms zero-order-hold) comparison
        // mistakes its tail for a dropout, because the bin containing the ramp's end
        // reads the bin-START's (pre-ramp) gain across its whole 10 ms span even
        // though most of that same bin, in reality, is already silent. The fix
        // compares against the gain at each exact millisecond instead.
        let ids = vec!["a".to_string()];
        let decoded = vec![vec![0.1; 100]]; // flat source power, 100 × 10 ms = 1000 ms
        let mut schedule: GainSchedule = HashMap::new();
        schedule.insert(
            "a".into(),
            vec![(ms(0), 0.0), (ms(502), 0.0), (ms(532), SILENT_DB)],
        );
        let window = (ms(0), ms(1000));
        let coarse = mix_envelope(&ids, &decoded, &schedule, window);
        let fine = mix_envelope_fine(&ids, &decoded, &schedule, window);
        let observed: Vec<(Duration, f64)> = fine.clone(); // matches the fine truth exactly

        let old = analyse(&observed, &coarse);
        assert!(
            !old.micro_gaps.is_empty(),
            "sanity: the coarse-only path should still show the artifact this fix \
             removes (if this fails, the fixture no longer reproduces it): {old:?}"
        );

        let fixed = analyse_with_fine(&observed, &coarse, &fine);
        assert!(
            fixed.micro_gaps.is_empty(),
            "a clean anti-click ramp must not be flagged once the comparison is \
             1 ms-accurate: {:?}",
            fixed.micro_gaps
        );
    }

    // ------------------------------------------------------------ R79: bounded analyses

    #[test]
    fn analysis_gate_caps_concurrency_at_two() {
        assert!(try_acquire_slot());
        assert!(try_acquire_slot());
        assert!(
            !try_acquire_slot(),
            "a third concurrent analysis must be refused"
        );
        release_slot();
        assert!(
            try_acquire_slot(),
            "releasing one slot must free it for the next"
        );
        release_slot();
        release_slot();
    }
}
