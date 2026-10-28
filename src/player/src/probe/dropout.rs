//! The reference-based dropout detector (Task 15; spec §5.3, §9 "debug mode"): a port of
//! the proven `scripts/liascape_audiowatch.py` monitor (2026-10-20, found the cubic-volume-sag,
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
//! over the qualifying bins) — exact parity with the proven `liascape_audiowatch.py` reference
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
//! unchanged. **Superseded by R94 below** — a micro-gap can still appear after this fix
//! and not be real; see R94 for the remaining edge case and what actually distinguishes
//! a real one.
//!
//! **R94 (Task 16d review) — the micro-gap pass ignores a ramp's own edge; `drops`
//! unchanged.** Even with R80's 1 ms-accurate comparison, a `GainLinear` ramp (linear in
//! *amplitude*; invariant #2/#4) has an **unbounded dB slope in its last fraction of a
//! millisecond** — measured directly (`tests/onmachine/dropout.sh` @ both 60 Hz and 240
//! Hz, after Task 16d's 1 kHz fast gain timer made the *real* push rate no longer the
//! bottleneck): a 30 ms ramp's true dB value crosses from −58 dB to −96 dB within its
//! last 0.04 ms of real time (`10^(-58/20)` vs `10^(-96/20)` amplitude, both converted
//! back to a ramp-progress fraction — see this module's test
//! `micro_gap_pass_ignores_a_ramp_edge_misaligned_by_one_ms`'s own sanity check for the
//! numbers). No alignment the 10 ms-bin lag search offers, and no real push/capture
//! jitter (sub-ms, but still ≫ 0.04 ms), can land exactly on that edge — so comparing
//! `observed` against `fine_expected` *at that one instant* produces a false `micro_gap`
//! that is the **detector's own alignment limit**, not a real glitch in the audio. Fixed
//! by [`STEADY_NEIGHBOURHOOD_MS`] (2 ms): a 1 ms sample only counts toward a micro-gap if
//! the expected level stays audible (> −45 dB) for its *whole* ±2 ms neighbourhood, not
//! just at that exact instant — a ramp edge never has that (its own neighbourhood crosses
//! into silence), while a genuine hole in otherwise-steady audio does (both sides stay
//! audible), so it's untouched. `drops` (10 ms bins) and the lag search are unaffected —
//! only the `micro_gaps` pass gained this guard. Tests:
//! `micro_gap_pass_ignores_a_ramp_edge_misaligned_by_one_ms` (a realistic sub-bin
//! misalignment at a ramp edge is never flagged — RED without the guard, pinned by its
//! own inline sanity check of the raw pre-guard condition),
//! `micro_gap_pass_still_flags_a_hole_shortly_before_a_ramp_starts` (a real 4 ms hole
//! whose own ±2 ms neighbourhood never touches a ramp 5 ms away is still flagged exactly
//! once), `injected_4ms_gap_is_flagged_as_exactly_one_micro_gap_not_a_drop` (`tests/
//! dropout.rs`, unaffected — its whole neighbourhood is steady). **If a micro-gap still
//! appears after this fix, check first whether it sits at a ramp edge** (the expected
//! level within ±2 ms of it crosses the −45 dB line) before treating it as real; see
//! `docs/player/debugging.md`'s "ramp-edge micro-gap" row.
//!
//! **Task 16d (R96 + the effect-start finding) — alignment is exact to 1 ms; the auto-run
//! sees the whole window.** Intermittent `frozen` findings at effect start (a 4 ms / 61 dB
//! micro-gap at A's ramp bottom with `lag_ms` 10; once, @240 Hz, a 30 ms / 73 dB *drop*
//! with `lag_ms` 40) were proven to be this module's own alignment, not the audio: the
//! meter and an independent `parec` capture of the bus monitor both showed A's full 30 ms
//! ramp in all 24 reproduced runs. Three causes, three fixes (none loosens a threshold):
//! 1. **Window grid** ([`bin_observed`]): the meter was binned on the *absolute* 10 ms
//!    grid while `expected` starts at the window's own sub-10 ms phase φ — "lag 10" meant
//!    10 − φ, and the micro-gap pass then applied a full 10 ms. Coarse bins are now also
//!    the power mean of the 1 ms envelope ([`coarse_from_fine`]), the same reduction the
//!    meter side gets, instead of the gain held at each bin's start.
//! 2. **R96, 1 ms lag** ([`refine_lag`]): the coarse best ± [`REFINE_RADIUS_MS`], scored
//!    by the same error sample by sample against the fine envelope; the meter is then
//!    re-binned at that lag for `drops`/`fit_db`/`offset_db`, and the micro-gap pass uses
//!    it. `lag_ms` is reported at 1 ms.
//! 3. **Complete window** ([`request_analysis`]/[`run_due`]): the debug auto-trigger
//!    snapshotted the meter at `transition.done`, so the capture ended at B's ramp while
//!    `expected` ran another 500 ms — a lag pushing B's ramp off the captured data scored
//!    better. Analyses now start at `done + WINDOW_POST + CAPTURE_MARGIN`.
//!
//! **Why this can't mask a real cut:** the lag is pinned by whatever edges and level the
//! window has *as a whole* (A's steady tone, B's onset), so an instant cut at one edge
//! can't drag it far enough to explain itself — the cut's expected-audible bins then pair
//! with true silence and are flagged (`tests/dropout.rs::an_unramped_cut_at_effect_start_
//! is_flagged`; an injected 4 ms hole still flags exactly once,
//! `refined_lag_still_flags_an_injected_4ms_gap`). `probe dropout {corr, dump}` writes
//! every input + the report for offline replay ([`write_dump`]).
//!
//! **Phase 2 Task 14 (on-machine, 720 switches with scenes) — two more detector edges.**
//! 1. **A ramp edge's own bin.** One lag serves the whole window; a scene's stream reached
//!    the bus ~3 ms later than its schedule while A's video pinned the lag, so B's ramp-in
//!    started 7 ms into a 10 ms bin whose expected power mean was just audible (> −55 dB)
//!    while the observed bin was still silent: a 10 ms "drop" ~40 dB under at the very
//!    start of a correctly shaped ramp (4 of 20 frozen V→S switches at 60 Hz). A drop bin
//!    now needs both neighbouring expected bins audible too — the 10 ms analogue of the
//!    micro-gap pass's steady neighbourhood. A late onset or a hole spans steady bins and
//!    is still flagged (`ramp_in_that_never_comes_is_still_a_drop`; RED before:
//!    `ramp_in_a_few_ms_late_is_not_a_drop`, a drop at 1560 len 10).
//! 2. **The meter's missed cycles** ([`drop_meter_discontinuities`]): the bus meter's
//!    capture, while it ran on the non-real-time `lia-bus` thread, skipped graph cycles under
//!    load — a timestamp jump followed by −96 blocks (since then RT, `audio::meter`; this
//!    stays the safety net for a meter without RT scheduling). Those samples are left out and reported as
//!    `unmeasured`, never as a gap (`meter_discontinuity_is_unmeasured_not_a_gap`; RED
//!    before: a 2 ms micro-gap at 132). A contiguous hole is still a micro-gap.

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
/// R94 (controller ruling): how far either side of a 1 ms sample the micro-gap pass's
/// steady-state guard checks — see `analyse_inner`'s `is_steady`.
const STEADY_NEIGHBOURHOOD_MS: i64 = 2;
/// The probe's window around a transition (R71): `transition.started` − this, `.done` +
/// this.
pub const WINDOW_PRE: Duration = Duration::from_millis(500);
pub const WINDOW_POST: Duration = Duration::from_millis(500);
/// Lag search range (0..=25 × 10 ms = 0..=250 ms), inclusive, matching the brief.
const MAX_LAG_BINS: i64 = 25;
/// R96 (controller ruling): how far either side of the coarse (10 ms-step) best lag the
/// 1 ms refinement searches ([`refine_lag`]).
const REFINE_RADIUS_MS: i64 = 10;
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
    /// The lag (ms) that best aligns `observed` to `expected`: 1 ms resolution when a
    /// fine envelope was given ([`analyse_with_fine`], production — R96), else 10 ms
    /// steps ([`analyse`]).
    pub lag_ms: u32,
    /// Mean absolute dB error at that lag, after `offset_db` — how good the fit is. R76
    /// (review fix round): the brief's text says "median" here; this has always been,
    /// and stays, the **mean** — exact parity with `liascape_audiowatch.py`'s `refcheck`, which
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
    /// Stretches the meter itself didn't capture: its timestamps jump (a missed graph
    /// cycle of the capture) — from the sample before the jump through
    /// [`UNMEASURED_TAIL_MS`] after it. Excluded from `drops`/`micro_gaps` and the fit;
    /// `under_db` is 0. A real hole on the bus is contiguous in time and never lands here.
    pub unmeasured: Vec<Drop>,
}

/// Power-domain mean of dB values, back to dB (`10·log10(mean(10^(d/10)))`) — never a
/// plain arithmetic mean of the dB values themselves (that would be biased quiet).
fn pw_mean_db(vals: &[f64]) -> f64 {
    debug_assert!(!vals.is_empty());
    let lin_sum: f64 = vals.iter().map(|d| 10f64.powf(d / 10.0)).sum();
    10.0 * (lin_sum / vals.len() as f64).log10()
}

/// `t + ms` for a signed millisecond offset; `None` if that would go negative (there's
/// no instant before the recording started). Used by the micro-gap pass's steady-state
/// neighbourhood check (R94).
fn offset_ms(t: Duration, ms: i64) -> Option<Duration> {
    if ms >= 0 {
        Some(t + Duration::from_millis(ms as u64))
    } else {
        t.checked_sub(Duration::from_millis((-ms) as u64))
    }
}

/// Port of `liascape_audiowatch.py`'s `refcheck` (the reference-based half): aligns `observed`
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

/// A meter timestamp step longer than this is a missed capture cycle (blocks are 1 ms).
const METER_STEP_MAX: Duration = Duration::from_micros(1500);
/// How long after a meter discontinuity its samples are still left out: the capture hands
/// back silence for the cycles right after the ones it missed (measured: 2 blocks).
pub const UNMEASURED_TAIL_MS: u64 = 4;

/// Phase 2 Task 14: splits `observed` into the samples the meter really captured in
/// sequence and the stretches it didn't. A bus meter capture that isn't real-time (it ran
/// on the `lia-bus` main loop until Task 14; a session without rtkit still has no RT) misses
/// graph cycles under load — its timestamps jump
/// (measured 2.3–22 ms) and the blocks right after read −96 (what PipeWire hands a stream
/// that missed its cycles), and the block before the jump joins two non-adjacent pieces.
/// None of that is the bus: from the sample before a jump through `UNMEASURED_TAIL_MS`
/// after it is left out, and reported as one `unmeasured` entry (`under_db` 0). A real
/// hole on the bus is contiguous −96 blocks with contiguous timestamps — never here.
fn drop_meter_discontinuities(
    observed: &[(Duration, f64)],
    origin: Duration,
) -> (Vec<(Duration, f64)>, Vec<Drop>) {
    let mut cut: Vec<(Duration, Duration)> = Vec::new();
    for w in observed.windows(2) {
        if w[1].0.saturating_sub(w[0].0) > METER_STEP_MAX {
            let (from, to) = (w[0].0, w[1].0 + Duration::from_millis(UNMEASURED_TAIL_MS));
            match cut.last_mut() {
                Some(last) if from <= last.1 => last.1 = last.1.max(to),
                _ => cut.push((from, to)),
            }
        }
    }
    if cut.is_empty() {
        return (observed.to_vec(), Vec::new());
    }
    let kept = observed
        .iter()
        .filter(|(t, _)| !cut.iter().any(|(a, b)| t >= a && t < b))
        .copied()
        .collect();
    let ms = |t: Duration| t.as_secs_f64() * 1000.0;
    let unmeasured = cut
        .iter()
        .map(|(a, b)| Drop {
            at_ms: (ms(*a) - ms(origin)).floor() as i64,
            len_ms: (ms(*b) - ms(*a)).round() as u32,
            under_db: 0.0,
        })
        .collect();
    (kept, unmeasured)
}

fn analyse_inner(
    observed: &[(Duration, f64)],
    expected: &[(Duration, f64)],
    fine_expected: Option<&[(Duration, f64)]>,
) -> DropoutReport {
    let insufficient = || DropoutReport {
        lag_ms: 0,
        fit_db: 0.0,
        offset_db: 0.0,
        fit: FitStatus::Insufficient,
        drops: Vec::new(),
        micro_gaps: Vec::new(),
        unmeasured: Vec::new(),
    };
    if expected.is_empty() {
        return insufficient();
    }
    let origin = expected[0].0;
    // Phase 2 Task 14: the meter's own missed cycles are unmeasured, never a hole.
    let (kept, unmeasured) = drop_meter_discontinuities(observed, origin);
    let observed: &[(Duration, f64)] = &kept;
    let fine_expected = fine_expected.filter(|f| !f.is_empty());
    let n = expected.len() as i64;
    // Task 16d: with a fine envelope, each coarse bin is the power mean of its own 1 ms
    // values (`coarse_from_fine`) — the same reduction the observed side gets (a power
    // mean of its 1 ms samples per bin). `mix_envelope`'s bin holds the gain at the
    // bin's *start* across all 10 ms, which on a ramp is up to a whole bin louder/
    // quieter than what that bin really averages to: a systematic edge bias the lag
    // search then "corrects" with a wrong lag.
    let exp: Vec<f64> = match fine_expected {
        Some(fine) => coarse_from_fine(fine, expected),
        None => expected.iter().map(|(_, v)| *v).collect(),
    };

    // R77 (review fix round): the guard scales with the window instead of a bare
    // constant — see the module docs. Independent of lag/capture: just how many of
    // `expected`'s own bins are audible at all.
    let qualifying = exp.iter().filter(|&&e| e > -60.0).count();
    let min_pairs = (qualifying / 2).clamp(10, 50);

    // Bin the raw observed samples onto the expected grid (sparse — a gap in the meter
    // leaves a bin with no entry at all, never a fabricated silence). Task 16d: the
    // grid is `expected`'s own (`origin` + 10 ms·k), never the absolute 10 ms grid —
    // see `bin_observed`.
    let cap0 = bin_observed(observed, origin, 0);

    // Lag search: minimise the mean absolute dB error (after a median offset) over bins
    // where expected is audible and the capture isn't implausibly loud (> -90 filters
    // noise-floor junk out of the fit, same as the Python reference).
    let mut best: Option<(f64, i64, f64)> = None; // (err, lag, offset)
    for lag in 0..=MAX_LAG_BINS {
        if lag >= n {
            continue;
        }
        let Some((err, off)) = bin_fit(&cap0, &exp, lag, min_pairs) else {
            continue;
        };
        if best.is_none_or(|(be, _, _)| err < be) {
            best = Some((err, lag, off));
        }
    }
    let Some((coarse_fit, coarse_lag, coarse_off)) = best else {
        // No lag had enough reliably-paired bins to trust an alignment at all — report
        // that plainly rather than guessing a lag of 0 and flagging findings on top of
        // it (R77).
        return insufficient();
    };

    // R96 (controller ruling): refine the lag to 1 ms on the fine envelope, ±10 ms
    // around the coarse best — a 10 ms lag step misaligns a steep ramp edge by up to
    // 5 ms, far beyond R94's ±2 ms steady-state guard. Then re-bin the observed side at
    // that exact lag, so `drops`/`fit_db`/`offset_db` are computed on the same
    // alignment the micro-gap pass uses.
    // Final review (minor): one alignment for everything — if the refined lag's re-binned
    // capture can't be fitted (too few pairs), the *whole* coarse alignment stands (lag,
    // capture, fit and offset together), never a refined capture scored with the coarse
    // fit.
    let coarse = || {
        (
            coarse_lag * BIN_MS,
            cap0.clone(),
            coarse_lag,
            coarse_fit,
            coarse_off,
        )
    };
    let (lag_ms, cap, drop_lag, fit_db, offset_db) = match fine_expected {
        Some(fine) => {
            let lag_ms = refine_lag(observed, fine, coarse_lag * BIN_MS, min_pairs);
            let cap = bin_observed(observed, origin, lag_ms);
            match bin_fit(&cap, &exp, 0, min_pairs) {
                Some((fit, off)) => (lag_ms, cap, 0, fit, off),
                None => coarse(),
            }
        }
        None => coarse(),
    };

    // Drops: runs of 10 ms bins at least 15 dB under an audible expected level.
    // Phase 2 Task 14: a bin counts only when its neighbours are expected audible too — the
    // first/last bin of a sound (a ramp-in starting late in its bin, a ramp-out's tail) is
    // the edge one stream's few ms of latency against another's lag moves across; a
    // genuine gap or a late onset spans steady bins and is still flagged
    // (`ramp_in_that_never_comes_is_still_a_drop`, `an_unramped_cut_…`).
    let capb = |k: i64| cap.get(&k).copied();
    let audible = |k: i64| -> bool {
        k >= 0 && (k as usize) < exp.len() && exp[k as usize] + offset_db > -55.0
    };
    let is_drop = |k: i64| -> Option<f64> {
        let e = exp[k as usize] + offset_db;
        let c = capb(k + drop_lag)?;
        (audible(k) && audible(k - 1) && audible(k + 1) && c < e - 15.0).then_some(e - c)
    };
    let mut drops = Vec::new();
    let mut k = 0i64;
    while k < n - drop_lag {
        if is_drop(k).is_some() {
            let start = k;
            let mut worst = 0.0f64;
            let mut j = k;
            while j < n - drop_lag {
                match is_drop(j) {
                    Some(under) => {
                        worst = worst.max(under);
                        j += 1;
                    }
                    None => break,
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
    // (shifted by the same — R96: 1 ms-refined — lag, in continuous time) instead of
    // holding the coarse bin's value across its whole 10 ms span.
    let fine_origin = fine_expected.and_then(|f| f.first()).map(|(t, _)| *t);
    let lag_dur = Duration::from_millis(lag_ms.max(0) as u64);
    let mut micro_gaps = Vec::new();
    let mut run: Vec<(Duration, f64, f64)> = Vec::new();
    let flush = |run: &mut Vec<(Duration, f64, f64)>, out: &mut Vec<Drop>| {
        if run.len() >= 2 {
            let start = run[0].0;
            let at_ms = (start.as_millis() as i64) - (origin.as_millis() as i64);
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
    // R94 (controller ruling): the expected level AT one exact instant, fine or coarse
    // (the same lookup the pre-R94 code ran inline) — pulled out so the steady-state
    // guard below can reuse it at the neighbouring instants too.
    let expected_at = |t: Duration| -> Option<f64> {
        match (fine_expected, fine_origin) {
            (Some(fine), Some(fine_origin)) => t
                .checked_sub(lag_dur)
                .and_then(|t_exp| t_exp.checked_sub(fine_origin))
                .and_then(|rel| fine.get(rel.as_millis() as usize))
                .map(|(_, v)| v + offset_db),
            _ => {
                let k = t.checked_sub(origin)?.as_millis() as i64 / BIN_MS - coarse_lag;
                if k >= 0 && (k as usize) < exp.len() {
                    Some(exp[k as usize] + offset_db)
                } else {
                    None
                }
            }
        }
    };
    // R94 (controller ruling): a 1 ms sample counts toward a micro-gap only if the
    // EXPECTED level stays "steady" — audible (> −45 dB) for its *whole*
    // `STEADY_NEIGHBOURHOOD_MS` neighbourhood, not just at that exact instant. A
    // linear-amplitude anti-click ramp's dB curve has an unbounded slope in its very
    // last fraction of a millisecond (invariant #2: `GainLinear` is linear in
    // *amplitude*; dB is logarithmic) — measured directly: a 30 ms ramp's dB value
    // crosses from −58 dB to −96 dB within its last 0.04 ms, far below anything the
    // lag search or real push/capture jitter can align to. A false micro-gap right
    // there is the *detector's* own alignment limit, not a real audio glitch —
    // excluding ramp edges from counting is not loosening what counts as a real one: a
    // genuine hole in otherwise-steady audio has a steady neighbourhood on both sides
    // and is untouched (`injected_4ms_gap_is_flagged_...`,
    // `micro_gap_pass_still_flags_a_hole_shortly_before_a_ramp_starts`).
    let is_steady = |t: Duration| -> bool {
        for dm in -STEADY_NEIGHBOURHOOD_MS..=STEADY_NEIGHBOURHOOD_MS {
            let Some(tt) = offset_ms(t, dm) else {
                return false;
            };
            match expected_at(tt) {
                Some(e) if e > -45.0 => {}
                _ => return false,
            }
        }
        true
    };
    for (t, d) in observed {
        let e = expected_at(*t);
        match e {
            Some(e) if e > -45.0 && *d < e - 35.0 && is_steady(*t) => run.push((*t, *d, e)),
            _ => flush(&mut run, &mut micro_gaps),
        }
    }
    flush(&mut run, &mut micro_gaps);

    DropoutReport {
        lag_ms: lag_ms as u32,
        fit_db,
        offset_db,
        fit: FitStatus::Ok,
        drops,
        micro_gaps,
        unmeasured,
    }
}

/// Task 16d: bins `observed` onto `expected`'s own 10 ms grid — bin `k` holds the
/// samples in `[origin + shift + 10k, origin + shift + 10k + 10)` ms, power-averaged.
/// **Never the absolute 10 ms grid** (the pre-16d `⌊t/10⌋ − ⌊origin/10⌋`): the
/// window starts at an arbitrary sub-10 ms phase φ (`transition.started` − 500 ms), so
/// that grid paired expected bin `k` with observed samples φ ms *earlier* — a lag of
/// "10 ms" then really meant 10 − φ, which the micro-gap pass applied as a full 10 ms
/// in continuous time: measured on-machine, φ ≈ 8 ms turned a true ~2 ms lag into a
/// reported 10 ms one and flagged the bottom of A's clean anti-click ramp as a 4 ms
/// micro-gap. `shift` (ms, ≥ 0) re-bins at a 1 ms-refined lag (R96).
fn bin_observed(
    observed: &[(Duration, f64)],
    origin: Duration,
    shift_ms: i64,
) -> HashMap<i64, f64> {
    let base = origin + Duration::from_millis(shift_ms.max(0) as u64);
    let mut bins: HashMap<i64, Vec<f64>> = HashMap::new();
    for (t, db) in observed {
        if let Some(rel) = t.checked_sub(base) {
            bins.entry(rel.as_millis() as i64 / BIN_MS)
                .or_default()
                .push(*db);
        }
    }
    bins.into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k, pw_mean_db(&v)))
        .collect()
}

/// Task 16d: `expected`'s grid re-derived from the 1 ms `fine` envelope — bin `k` is the
/// power mean of every fine value in `[t_k, t_k + 10 ms)` (`t_k` = `expected[k]`'s own
/// time), i.e. the same reduction [`bin_observed`] applies to the meter's 1 ms samples.
/// A bin with no fine values keeps `expected`'s own value.
fn coarse_from_fine(fine: &[(Duration, f64)], expected: &[(Duration, f64)]) -> Vec<f64> {
    let origin = expected[0].0;
    let mut sums = vec![(0.0f64, 0usize); expected.len()];
    for (t, db) in fine {
        let Some(rel) = t.checked_sub(origin) else {
            continue;
        };
        let k = rel.as_millis() as usize / BIN_MS as usize;
        if let Some(slot) = sums.get_mut(k) {
            slot.0 += 10f64.powf(db / 10.0);
            slot.1 += 1;
        }
    }
    sums.iter()
        .zip(expected)
        .map(|(&(sum, count), (_, e))| {
            if count == 0 {
                *e
            } else {
                let p = sum / count as f64;
                if p > 1e-14 { 10.0 * p.log10() } else { -140.0 }
            }
        })
        .collect()
}

/// The lag search's fit at one bin lag: `(mean |c − e − offset|, offset)` over bins
/// where expected is audible (> −60 dB) and the capture plausible (> −90 dB), with the
/// median `c − e` as the offset — `None` below `min_pairs` paired bins (R77).
fn bin_fit(cap: &HashMap<i64, f64>, exp: &[f64], lag: i64, min_pairs: usize) -> Option<(f64, f64)> {
    let n = exp.len() as i64;
    let mut pairs: Vec<(f64, f64)> = Vec::new();
    for k in 0..(n - lag).max(0) {
        if let Some(&c) = cap.get(&(k + lag)) {
            let e = exp[k as usize];
            if e > -60.0 && c > -90.0 {
                pairs.push((c, e));
            }
        }
    }
    if pairs.len() < min_pairs {
        return None;
    }
    let mut diffs: Vec<f64> = pairs.iter().map(|(c, e)| c - e).collect();
    diffs.sort_by(f64::total_cmp);
    let off = diffs[diffs.len() / 2];
    let err = pairs.iter().map(|(c, e)| (c - e - off).abs()).sum::<f64>() / pairs.len() as f64;
    Some((err, off))
}

/// R96 (controller ruling): the coarse lag refined to 1 ms — every whole-ms lag within
/// [`REFINE_RADIUS_MS`] of `coarse_ms` (clamped to the search range), scored by the
/// same error as the coarse search (mean |c − e − median offset| over audible-expected,
/// plausible-capture pairs) but sample by sample: each 1 ms meter sample against the
/// fine envelope at `t − lag`. Ties keep the smaller lag; a candidate with fewer than
/// `min_pairs` pairs is skipped, and if none qualifies the coarse lag stands.
fn refine_lag(
    observed: &[(Duration, f64)],
    fine: &[(Duration, f64)],
    coarse_ms: i64,
    min_pairs: usize,
) -> i64 {
    let fine_origin = fine[0].0;
    let lo = (coarse_ms - REFINE_RADIUS_MS).max(0);
    let hi = (coarse_ms + REFINE_RADIUS_MS).min(MAX_LAG_BINS * BIN_MS);
    let mut best: Option<(f64, i64)> = None;
    let mut diffs: Vec<f64> = Vec::with_capacity(observed.len());
    let mut sorted: Vec<f64> = Vec::with_capacity(observed.len());
    for lag in lo..=hi {
        let lag_dur = Duration::from_millis(lag as u64);
        diffs.clear();
        for (t, c) in observed {
            let e = t
                .checked_sub(lag_dur)
                .and_then(|t_exp| t_exp.checked_sub(fine_origin))
                .and_then(|rel| fine.get(rel.as_millis() as usize))
                .map(|(_, v)| *v);
            if let Some(e) = e
                && e > -60.0
                && *c > -90.0
            {
                diffs.push(c - e);
            }
        }
        if diffs.len() < min_pairs {
            continue;
        }
        sorted.clear();
        sorted.extend_from_slice(&diffs);
        sorted.sort_by(f64::total_cmp);
        let off = sorted[sorted.len() / 2];
        let err = diffs.iter().map(|d| (d - off).abs()).sum::<f64>() / diffs.len() as f64;
        if best.is_none_or(|(be, _)| err < be) {
            best = Some((err, lag));
        }
    }
    best.map_or(coarse_ms, |(_, lag)| lag)
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
    /// Phase 2 Task 6: a scene's reference — its worker's own envelope over the window (1 ms
    /// pre-gain dBFS on the log clock, [`SceneEnvelopes`]) instead of a decoded file (a
    /// scene folder has none). Already in window time (speed included).
    pub envelope: Option<Vec<(Duration, f32)>>,
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
/// `scripts/liascape_audiowatch.py`).
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
    run_ffmpeg_bounded(start_s, decode_s, path, DECODE_TIMEOUT)
}

fn run_ffmpeg_bounded(
    start_s: f64,
    decode_s: f64,
    path: &Path,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
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
    let mut child = cmd.spawn()?;
    let pid = child.id();
    register_child(pid);
    // M8 (final review): bounded — a decode that hangs (a stale network path) is killed
    // after DECODE_TIMEOUT instead of holding an analysis slot forever. stdout/stderr are
    // drained on their own threads so a full pipe can't stall the child meanwhile.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(o) = stdout.as_mut() {
            let _ = std::io::Read::read_to_end(o, &mut b);
        }
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(e) = stderr.as_mut() {
            let _ = std::io::Read::read_to_end(e, &mut b);
        }
        b
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("ffmpeg decode timed out after {timeout:?}"),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => break Err(e),
        }
    };
    unregister_child(pid);
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    status.map(|status| std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// M8: the longest one ffmpeg decode may run before it's killed.
const DECODE_TIMEOUT: Duration = Duration::from_secs(20);
/// M8: the longest window one analysis decodes (a pause gate's window spans the whole
/// pause; one 1 ms fine-envelope entry per ms, decoded audio for every source) — longer
/// ones are skipped (`skipped: "window_too_long"`), never decoded into memory.
pub(crate) const MAX_ANALYSIS_WINDOW: Duration = Duration::from_secs(120);

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
/// as `liascape_audiowatch.py`'s `refcheck` — and returns BOTH the coarse (10 ms; lag search +
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
        .map(|s| match &s.envelope {
            Some(env) => envelope_power_bins(env, window),
            None => decode_power_bins(&s.path, s.position, dur_s, s.speed, s.duration, s.looped),
        })
        .collect();
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let coarse = mix_envelope(&ids, &decoded, gain_schedule, window);
    let fine = mix_envelope_fine(&ids, &decoded, gain_schedule, window);
    (coarse, fine)
}

// --------------------------------------------------------------------- runtime wiring

/// How long a source's gain history is kept — comfortably past the brief's "≥ 30 s".
const HISTORY_SPAN: Duration = Duration::from_secs(40);
/// C1 (final review): how long a *dead* source's track (its node destroyed — retired,
/// released, stopped) outlives its last reading. A transition's analysis runs only once
/// its window's post-roll is captured (`done + WINDOW_POST + CAPTURE_MARGIN`, after the
/// outgoing A is usually already gone) and `probe dropout` can be asked again a little
/// later, so a track can't be dropped the instant its source dies — but it must go
/// eventually: ids are never reused, so without this every switch leaked its A's track.
pub(crate) const DEAD_LINGER: Duration = Duration::from_secs(30);
/// C1: global caps — however fast sources come and go (rapid "next" floods), the history
/// never holds more than this many tracks or samples (24 B each: ≤ ~3 MiB). Over a cap the
/// least recently seen *dead* track goes first, then the oldest samples of the longest
/// track.
pub(crate) const MAX_TRACKS: usize = 64;
pub(crate) const MAX_TOTAL_SAMPLES: usize = 131_072;
/// C1: one track never holds more than this many samples (a gain that changes on every
/// 1 kHz push for longer than this keeps only its newest ~32 s).
const MAX_TRACK_SAMPLES: usize = 32_768;

/// One source's recorded gain, run-length encoded (C1): a run of identical readings is
/// kept as its first and its latest sample (the latest one's time moves forward), so a
/// steady source costs two entries instead of one per tick, and both lookups
/// ([`gain_at`]'s nearest-previous, [`gain_lin_interp_at`]'s interpolation) see exactly
/// what per-tick recording gave them — the sample before a change is still the previous
/// tick's.
#[derive(Default)]
struct Track {
    samples: VecDeque<(Duration, f64)>,
    /// The last time this source was among the recorded readings (alive).
    last_seen: Duration,
}

/// Per-source `effective_gain_db` history, recorded every `Runtime` tick (and every fast
/// gain push), on the log's `t_mono_ms` clock (R70). Bounded (C1): per track by
/// [`HISTORY_SPAN`] + [`MAX_TRACK_SAMPLES`], dead tracks by [`DEAD_LINGER`], in total by
/// [`MAX_TRACKS`] + [`MAX_TOTAL_SAMPLES`].
#[derive(Default)]
pub(crate) struct GainHistory {
    tracks: HashMap<String, Track>,
}

impl GainHistory {
    pub(crate) fn new() -> GainHistory {
        GainHistory::default()
    }

    /// Record one tick's readings — every live source's, so a track missing from them
    /// belongs to a source that is gone (dropped [`DEAD_LINGER`] after its last reading).
    pub(crate) fn record(&mut self, t: Duration, readings: impl Iterator<Item = (String, f64)>) {
        for (id, db) in readings {
            let track = self.tracks.entry(id).or_default();
            track.last_seen = t;
            let s = &mut track.samples;
            let n = s.len();
            if n >= 2 && s[n - 1].1 == db && s[n - 2].1 == db {
                s[n - 1].0 = t; // the run goes on: move its end forward
            } else {
                s.push_back((t, db));
            }
            // The front sample is only needed while it defines the value at the span's
            // edge: drop it once the next one is itself older than the span.
            while s.len() >= 2 && t.saturating_sub(s[1].0) > HISTORY_SPAN {
                s.pop_front();
            }
            while s.len() > MAX_TRACK_SAMPLES {
                s.pop_front();
            }
        }
        self.tracks
            .retain(|_, tr| t.saturating_sub(tr.last_seen) <= DEAD_LINGER);
        self.enforce_caps(t);
    }

    fn enforce_caps(&mut self, t: Duration) {
        loop {
            let total: usize = self.tracks.values().map(|tr| tr.samples.len()).sum();
            if self.tracks.len() <= MAX_TRACKS && total <= MAX_TOTAL_SAMPLES {
                return;
            }
            // The least recently seen dead track first.
            let dead = self
                .tracks
                .iter()
                .filter(|(_, tr)| tr.last_seen < t)
                .min_by_key(|(_, tr)| tr.last_seen)
                .map(|(id, _)| id.clone());
            if let Some(id) = dead {
                self.tracks.remove(&id);
                continue;
            }
            if self.tracks.len() > MAX_TRACKS {
                // Every track is live (more live sources than the cap — never in practice):
                // the one seen longest ago, deterministically.
                let id = self
                    .tracks
                    .iter()
                    .min_by(|a, b| a.1.last_seen.cmp(&b.1.last_seen).then(a.0.cmp(b.0)))
                    .map(|(id, _)| id.clone());
                if let Some(id) = id {
                    self.tracks.remove(&id);
                }
                continue;
            }
            // Live tracks only, still over the sample cap: trim the longest one's oldest.
            if let Some(tr) = self.tracks.values_mut().max_by_key(|tr| tr.samples.len()) {
                let excess = (total - MAX_TOTAL_SAMPLES).min(tr.samples.len().saturating_sub(2));
                if excess == 0 {
                    return;
                }
                tr.samples.drain(..excess);
            } else {
                return;
            }
        }
    }

    /// `(tracks, samples)` currently held — the `loop` probe's bound evidence (C1).
    pub(crate) fn stats(&self) -> (usize, usize) {
        (
            self.tracks.len(),
            self.tracks.values().map(|tr| tr.samples.len()).sum(),
        )
    }

    /// A clone of the recorded tracks for exactly these ids (cheap — bounded by the caps
    /// above), handed to the worker thread.
    pub(crate) fn snapshot(&self, ids: &[String]) -> GainSchedule {
        ids.iter()
            .map(|id| {
                let track = self
                    .tracks
                    .get(id)
                    .map(|t| t.samples.iter().copied().collect())
                    .unwrap_or_default();
                (id.clone(), track)
            })
            .collect()
    }
}

/// Phase 2 Task 6: the most scene envelopes kept (a few scenes live at once + the dead ones
/// lingering for their post-roll analysis).
const MAX_ENVELOPE_TRACKS: usize = 16;
/// One scene's envelope entries at most (1 ms each: the last [`HISTORY_SPAN`]).
const MAX_ENVELOPE_SAMPLES: usize = 40_000;

/// Each scene source's own sound before its gain — the worker's `Envelope` (1 ms max-channel
/// RMS dBFS, on the log clock) — kept like [`GainHistory`]: a scene has no file to decode, so
/// this is its dropout reference ([`SourceWindow::envelope`]). Bounded per track by
/// [`MAX_ENVELOPE_SAMPLES`], dead tracks by [`DEAD_LINGER`], in total by
/// [`MAX_ENVELOPE_TRACKS`].
#[derive(Default)]
pub(crate) struct SceneEnvelopes {
    tracks: HashMap<String, (VecDeque<(Duration, f32)>, Duration)>,
}

impl SceneEnvelopes {
    pub(crate) fn new() -> SceneEnvelopes {
        SceneEnvelopes::default()
    }

    /// Append `id`'s new entries (oldest first) at log time `now`.
    pub(crate) fn record(&mut self, id: &str, entries: Vec<(Duration, f32)>, now: Duration) {
        let tr = self.tracks.entry(id.to_string()).or_default();
        tr.1 = now;
        tr.0.extend(entries);
        while tr.0.len() > MAX_ENVELOPE_SAMPLES {
            tr.0.pop_front();
        }
    }

    /// Mark the live scenes seen at `now`; drop dead tracks after [`DEAD_LINGER`] and the
    /// least recently seen past [`MAX_ENVELOPE_TRACKS`].
    pub(crate) fn retain_live(&mut self, live: &[String], now: Duration) {
        for id in live {
            if let Some(tr) = self.tracks.get_mut(id) {
                tr.1 = now;
            }
        }
        self.tracks
            .retain(|_, tr| now.saturating_sub(tr.1) <= DEAD_LINGER);
        while self.tracks.len() > MAX_ENVELOPE_TRACKS {
            let Some(id) = self
                .tracks
                .iter()
                .min_by_key(|(_, tr)| tr.1)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            self.tracks.remove(&id);
        }
    }

    /// `id`'s entries inside `window` (`None` = not a scene / nothing recorded).
    pub(crate) fn window(
        &self,
        id: &str,
        window: (Duration, Duration),
    ) -> Option<Vec<(Duration, f32)>> {
        let tr = self.tracks.get(id)?;
        Some(
            tr.0.iter()
                .filter(|(t, _)| *t >= window.0 && *t < window.1)
                .copied()
                .collect(),
        )
    }

    /// `(tracks, samples)` — the `loop` probe's bounds.
    pub(crate) fn stats(&self) -> (usize, usize) {
        (
            self.tracks.len(),
            self.tracks.values().map(|tr| tr.0.len()).sum(),
        )
    }
}

/// A scene's 10 ms **power** bins over `window` from its 1 ms dBFS envelope (Task 6): each
/// bin the mean power of the entries inside it; a bin with none is silent (the scene's
/// sound wasn't on its stream then).
fn envelope_power_bins(env: &[(Duration, f32)], window: (Duration, Duration)) -> Vec<f64> {
    let n = (window.1.saturating_sub(window.0).as_secs_f64() * 100.0).round() as usize;
    let mut sum = vec![0.0f64; n];
    let mut cnt = vec![0u32; n];
    for (t, db) in env {
        let Some(off) = t.checked_sub(window.0) else {
            continue;
        };
        let k = (off.as_secs_f64() * 1000.0) as usize / BIN_MS as usize;
        if k < n {
            sum[k] += if *db as f64 <= SILENT_DB {
                0.0
            } else {
                10f64.powf(*db as f64 / 10.0)
            };
            cnt[k] += 1;
        }
    }
    sum.iter()
        .zip(&cnt)
        .map(|(s, c)| if *c > 0 { s / *c as f64 } else { 0.0 })
        .collect()
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

    /// Recorded windows (bounded by `MAX_PENDING`) — the `loop` probe's `bounds`.
    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }

    pub(crate) fn get(&self, corr: &str) -> Option<&PendingTransition> {
        self.map.get(corr)
    }

    /// R93 (review): how many recorded windows are still open (`done_mono.is_none()`) —
    /// the `loop` probe's own evidence that nothing (a transition, `retire`, the R88
    /// pause gate) left a window dangling. A gate abandoned mid-flight
    /// (`Runtime::abandon_pause_gate`) must close its window outright rather than leave
    /// it open forever, so this returns to whatever it was before that gate opened.
    pub(crate) fn open_count(&self) -> usize {
        self.map.values().filter(|p| p.done_mono.is_none()).count()
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

fn snapshot_window(
    s: &AudioSourceSnapshot,
    scenes: &SceneEnvelopes,
    window: (Duration, Duration),
) -> SourceWindow {
    SourceWindow {
        envelope: scenes.window(&s.id, window),
        id: s.id.clone(),
        path: PathBuf::from(&s.path),
        position: rebase_position(s.position, s.speed, s.duration, s.loop_),
        speed: s.speed,
        looped: s.loop_,
        duration: s.duration,
    }
}

/// Task 16d: how long past a window's end (`done + WINDOW_POST`) an analysis waits before
/// it snapshots the meter, so the window's last samples have been delivered (a meter
/// block lands one graph cycle after its own time — 1.3 ms at this machine's 64-frame
/// quantum, ~21 ms at a 1024-frame one).
pub(crate) const CAPTURE_MARGIN: Duration = Duration::from_millis(100);

/// One analysis waiting for its window to be fully captured ([`request_analysis`]).
pub(crate) struct DueAnalysis {
    corr: CorrId,
    due: Duration,
    dump: Option<PathBuf>,
}

/// Task 16d: run `corr`'s analysis once the meter has captured its **whole** window —
/// at once if it already has (or there's nothing to wait for: stepped clock, no meter),
/// else queued until `done + WINDOW_POST + CAPTURE_MARGIN` ([`run_due`], from every
/// tick). The auto-trigger used to snapshot the meter at `transition.done` itself, so
/// the 500 ms post-roll was never checked and the lag search saw a capture that ended
/// at B's ramp while `expected` ran on: measured on-machine (@240 Hz), it picked a lag
/// that pushed B's ramp bins off the end of the capture (40 ms, the last lag still
/// clearing the R77 pair guard) and flagged A's clean anti-click ramp as a 30 ms drop.
pub(crate) fn request_analysis(rt: &mut Runtime, corr: CorrId, dump: Option<PathBuf>) {
    let Some(pending) = rt.dropout_windows.get(&corr.0) else {
        return;
    };
    let Some(done) = pending.done_mono else {
        return;
    };
    let due = done + WINDOW_POST + CAPTURE_MARGIN;
    let now = log::mono_now().unwrap_or_default();
    if now >= due || rt.stepped() || rt.audio.meter_unavailable().is_some() {
        let pending = pending.clone();
        spawn_analysis(rt, corr, &pending, dump);
    } else {
        rt.dropout_due.push(DueAnalysis { corr, due, dump });
    }
}

/// Task 16d: starts every queued [`request_analysis`] whose window is now fully captured
/// (called from `Runtime::tick`; a no-op with nothing queued).
pub(crate) fn run_due(rt: &mut Runtime) {
    if rt.dropout_due.is_empty() {
        return;
    }
    let now = log::mono_now().unwrap_or_default();
    let (ready, waiting): (Vec<DueAnalysis>, Vec<DueAnalysis>) =
        std::mem::take(&mut rt.dropout_due)
            .into_iter()
            .partition(|d| now >= d.due);
    rt.dropout_due = waiting;
    for d in ready {
        if let Some(pending) = rt.dropout_windows.get(&d.corr.0).cloned() {
            spawn_analysis(rt, d.corr, &pending, d.dump);
        }
    }
}

/// Snapshot the meter + gain schedule for `pending`'s window (main thread, cheap) and
/// run the decode + [`analyse_with_fine`] on a spawned thread, delivering
/// `probe.dropout {corr, report}` (or `{corr, skipped}`) via `log::event` once it's
/// done — R71, never blocks the caller. A no-op if `pending` hasn't reached
/// `transition.done` yet. R79: refuses (`skipped: "busy"`) rather than queues past
/// [`MAX_CONCURRENT_ANALYSES`] concurrent analyses.
fn spawn_analysis(rt: &Runtime, corr: CorrId, pending: &PendingTransition, dump: Option<PathBuf>) {
    let Some(done_mono) = pending.done_mono else {
        return;
    };
    let window = (
        pending.started_mono.saturating_sub(WINDOW_PRE),
        done_mono + WINDOW_POST,
    );
    if window.1.saturating_sub(window.0) > MAX_ANALYSIS_WINDOW {
        log::event(
            "probe",
            Level::Info,
            "probe.dropout",
            Some(corr),
            json!({ "skipped": "window_too_long",
                    "window_ms": window.1.saturating_sub(window.0).as_secs_f64() * 1000.0,
                    "max_ms": MAX_ANALYSIS_WINDOW.as_secs_f64() * 1000.0 }),
        );
        return;
    }
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
        sources.push(snapshot_window(s, &rt.scene_envelopes, window));
    }
    sources.push(snapshot_window(&pending.b, &rt.scene_envelopes, window));
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let schedule = rt.gain_history.snapshot(&ids);
    std::thread::spawn(move || {
        let _slot = SlotGuard;
        let (expected, fine) = expected_envelopes(&sources, &schedule, window);
        let report = analyse_with_fine(&observed, &expected, &fine);
        if let Some(path) = dump {
            write_dump(
                &path, &corr, window, &sources, &schedule, &observed, &expected, &fine, &report,
            );
        }
        log::event(
            "probe",
            Level::Info,
            "probe.dropout",
            Some(corr),
            json!({ "report": report }),
        );
    });
}

/// Task 16d: `probe dropout {corr, dump}` writes every input the analysis saw (the 1 ms
/// meter samples, both expected envelopes, the recorded gain schedule, the sources'
/// rebased positions) plus the report to `dump` (an absolute path) — the raw evidence
/// for "is this flagged gap real or the detector's own alignment", reproducible offline.
/// Times are `t_mono_ms`. Best effort: a write failure is logged, never fatal.
#[allow(clippy::too_many_arguments)]
fn write_dump(
    path: &Path,
    corr: &CorrId,
    window: (Duration, Duration),
    sources: &[SourceWindow],
    schedule: &GainSchedule,
    observed: &[(Duration, f64)],
    expected: &[(Duration, f64)],
    fine: &[(Duration, f64)],
    report: &DropoutReport,
) {
    let ms = |d: &Duration| d.as_secs_f64() * 1000.0;
    let env =
        |e: &[(Duration, f64)]| -> Vec<(f64, f64)> { e.iter().map(|(t, v)| (ms(t), *v)).collect() };
    let sched: HashMap<&String, Vec<(f64, f64)>> =
        schedule.iter().map(|(id, tr)| (id, env(tr))).collect();
    let srcs: Vec<Value> = sources
        .iter()
        .map(|s| json!({ "id": s.id, "path": s.path, "position": s.position, "speed": s.speed }))
        .collect();
    let body = json!({
        "corr": corr,
        "window_ms": [ms(&window.0), ms(&window.1)],
        "sources": srcs,
        "schedule": sched,
        "observed": env(observed),
        "expected": env(expected),
        "fine": env(fine),
        "report": report,
    });
    if let Err(e) = std::fs::write(path, body.to_string()) {
        log::event(
            "probe",
            Level::Warn,
            "probe.dropout_dump_failed",
            Some(corr.clone()),
            json!({ "path": path.display().to_string(), "error": e.to_string() }),
        );
    }
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
    let dump = match args.get("dump") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) if Path::new(d).is_absolute() => Some(PathBuf::from(d)),
        Some(_) => {
            return Err(bad(
                "dropout's `dump` must be an absolute path string".into()
            ));
        }
    };
    request_analysis(rt, CorrId(corr.to_string()), dump);
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

    /// Phase 2 Task 6: a scene's reference is its worker's own envelope (no file to decode):
    /// the expected mix is that envelope × the recorded gain schedule, in window time; ms the
    /// worker sent nothing for are silent; the history keeps a dead scene for its post-roll,
    /// then drops it.
    #[test]
    fn dropout_uses_scene_envelope_as_reference() {
        let window = (ms(1000), ms(1400));
        // −23 dBFS steady (a −20 dBFS-peak tone), nothing from 1350 ms on.
        let env: Vec<(Duration, f32)> = (900..1350).map(|t| (ms(t), -23.0f32)).collect();
        let mut scenes = SceneEnvelopes::new();
        scenes.record("s", env, ms(1350));
        let got = scenes.window("s", window).unwrap();
        assert_eq!(got.len(), 350, "only the window's entries");
        assert!(scenes.window("video", window).is_none());
        let src = SourceWindow {
            id: "s".into(),
            path: PathBuf::from("/a/scene/folder"),
            position: 0.0,
            speed: 1.0,
            looped: false,
            duration: None,
            envelope: Some(got),
        };
        let mut schedule = GainSchedule::new();
        // 0 dB, then a −6 dB step at 1200 ms.
        schedule.insert(
            "s".into(),
            vec![(ms(0), 0.0), (ms(1199), 0.0), (ms(1200), -6.0)],
        );
        let (coarse, fine) = expected_envelopes(&[src], &schedule, window);
        assert_eq!(coarse.len(), 40);
        for (t, db) in &coarse {
            let want = if *t < ms(1200) {
                -23.0
            } else if *t < ms(1350) {
                -29.0
            } else {
                -140.0
            };
            assert!((db - want).abs() < 1.5, "{t:?}: {db} vs {want}");
        }
        assert_eq!(fine.len(), 400);
        assert!((fine[100].1 + 23.0).abs() < 1.5, "{:?}", fine[100]);
        // Dead: kept for its post-roll, then dropped.
        scenes.retain_live(&[], ms(1350) + DEAD_LINGER);
        assert_eq!(scenes.stats().0, 1);
        scenes.retain_live(&[], ms(1351) + DEAD_LINGER);
        assert_eq!(scenes.stats(), (0, 0));
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
        let s = || "s".to_string();
        h.record(ms(0), std::iter::once((s(), -6.0)));
        h.record(ms(10), std::iter::once((s(), -5.0)));
        let late = HISTORY_SPAN.as_millis() as u64 + 1000;
        h.record(ms(late), std::iter::once((s(), -3.0)));
        let snap = h.snapshot(&[s()]);
        let track = &snap["s"];
        // Only what defines the value from the span's edge on is kept.
        assert_eq!(track.len(), 2, "{track:?}");
        assert_eq!(track[0].1, -5.0);
        assert_eq!(gain_at(Some(track), ms(late)), -3.0);
    }

    #[test]
    fn gain_history_run_length_keeps_lookups_exact() {
        let mut h = GainHistory::new();
        let s = || "s".to_string();
        for i in 0..1000u64 {
            h.record(ms(i), std::iter::once((s(), 0.0)));
        }
        for (k, i) in (1000..1030u64).enumerate() {
            h.record(ms(i), std::iter::once((s(), -(k as f64))));
        }
        for i in 1030..2000u64 {
            h.record(ms(i), std::iter::once((s(), SILENT_DB)));
        }
        let snap = h.snapshot(&[s()]);
        let track = &snap["s"];
        assert!(
            track.len() <= 34,
            "a steady run must not cost one entry per tick: {}",
            track.len()
        );
        // The sample right before the ramp is still the previous tick's 0 dB.
        assert_eq!(gain_at(Some(track), ms(999)), 0.0);
        assert_eq!(gain_at(Some(track), ms(500)), 0.0);
        assert_eq!(gain_at(Some(track), ms(1010)), -10.0);
        assert_eq!(gain_at(Some(track), ms(1500)), SILENT_DB);
        let mid = gain_lin_interp_at(Some(track), ms(500));
        assert!((mid - 1.0).abs() < 1e-12, "{mid}");
    }

    #[test]
    fn gain_history_forgets_dead_sources_and_stays_bounded() {
        // C1: 10 000 simulated create → record → destroy cycles (ids never reused, like
        // `src<n>`): the map must stay bounded by the caps, and a dead track must go
        // once DEAD_LINGER has passed.
        let mut h = GainHistory::new();
        let mut t = 0u64;
        for n in 0..10_000u64 {
            let id = format!("src{n}");
            for _ in 0..40 {
                t += 1;
                h.record(
                    ms(t),
                    [("live".to_string(), 0.0), (id.clone(), -((t % 7) as f64))].into_iter(),
                );
            }
            let (tracks, samples) = h.stats();
            assert!(tracks <= MAX_TRACKS, "tracks {tracks} after {n} cycles");
            assert!(
                samples <= MAX_TOTAL_SAMPLES,
                "samples {samples} after {n} cycles"
            );
        }
        // Long after the last cycle only the live source is left.
        let later = t + DEAD_LINGER.as_millis() as u64 + 10;
        h.record(ms(later), std::iter::once(("live".to_string(), 0.0)));
        assert_eq!(
            h.stats().0,
            1,
            "dead tracks must be dropped after DEAD_LINGER"
        );
        assert!(h.stats().1 <= 2);
    }

    #[test]
    fn a_hung_decode_is_killed_at_its_timeout() {
        // M8: ffmpeg reading a FIFO nobody writes blocks forever — bounded, it's killed.
        if std::process::Command::new(FFMPEG)
            .arg("-version")
            .output()
            .is_err()
        {
            println!("SKIP: no ffmpeg");
            return;
        }
        let dir = std::env::temp_dir().join(format!("liascape-dropout-fifo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("never.wav");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let t = Instant::now();
        let r = run_ffmpeg_bounded(0.0, 1.0, &fifo, Duration::from_millis(300));
        let took = t.elapsed();
        let _ = std::fs::remove_file(&fifo);
        assert!(took < Duration::from_secs(3), "not bounded: {took:?}");
        let e = r.expect_err("a hung decode must fail");
        assert_eq!(e.kind(), std::io::ErrorKind::TimedOut, "{e}");
        assert!(
            FFMPEG_CHILDREN.lock().unwrap().is_empty(),
            "child left registered"
        );
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

    /// The true, continuous `GainLinear` curve (invariant #2/#4): flat 0 dB, ramps
    /// linearly *in amplitude* to silence over `dur_ms` starting at `start_ms`, flat
    /// silent after. `t_ms` may be fractional (a sub-ms-shifted "observed" copy below).
    fn ramp_curve(t_ms: f64, start_ms: f64, dur_ms: f64) -> f64 {
        let p = t_ms - start_ms;
        if p <= 0.0 {
            0.0
        } else if p >= dur_ms {
            SILENT_DB
        } else {
            crate::units::lin_to_db(1.0 - p / dur_ms)
        }
    }

    #[test]
    // R94 (controller ruling): a ramp edge whose observed copy is shifted by exactly
    // 1 ms — a realistic sub-bin capture/push misalignment, nothing the 10 ms lag
    // search can correct for — must never be flagged. The curve's own slope is
    // unbounded in its last fraction of a millisecond (ramp_curve's doc), so a 1 ms
    // misalignment there is exactly the scenario the steady-state guard exists for.
    fn micro_gap_pass_ignores_a_ramp_edge_misaligned_by_one_ms() {
        const START_MS: f64 = 500.0;
        const DUR_MS: f64 = 30.0;
        // The curve's own slope: for THIS 30 ms ramp, a bare 1 ms shift lands its
        // mismatch inside a single 1 ms-wide window (`-29.5 dB` at p=29 to the floor
        // at p=30) — never 2 *consecutive* samples, so the pre-guard code (which only
        // ever flags a run of >= 2) wouldn't have flagged it either; that's not this
        // guard's doing, it's `flush`'s existing `run.len() >= 2` rule. A 2 ms shift
        // reliably spans two: sanity-checked below against the exact pre-guard
        // condition (`e > -45 && d < e - 35`), independent of `analyse_with_fine`,
        // before asserting the guarded result — proving this shift really would have
        // been flagged without the fix.
        const SHIFT_MS: f64 = 2.0;
        let sample_at = |t: f64| ramp_curve(t, START_MS, DUR_MS);
        let raw_hit = |t: f64| {
            let e = sample_at(t);
            let d = sample_at(t + SHIFT_MS);
            e > -45.0 && d < e - 35.0
        };
        assert!(
            raw_hit(528.0) && raw_hit(529.0),
            "sanity: a {SHIFT_MS} ms shift must raw-flag >= 2 consecutive samples \
             (528, 529) or this test doesn't exercise the guard at all"
        );

        let fine: Vec<(Duration, f64)> = (0..1000u64)
            .map(|t| (ms(t), ramp_curve(t as f64, START_MS, DUR_MS)))
            .collect();
        let coarse: Vec<(Duration, f64)> = (0..100i64)
            .map(|k| {
                (
                    ms((k * 10) as u64),
                    ramp_curve((k * 10) as f64, START_MS, DUR_MS),
                )
            })
            .collect();
        for shift in [-SHIFT_MS, SHIFT_MS] {
            let observed: Vec<(Duration, f64)> = (0..1000u64)
                .map(|t| (ms(t), ramp_curve(t as f64 + shift, START_MS, DUR_MS)))
                .collect();
            let report = analyse_with_fine(&observed, &coarse, &fine);
            assert!(
                report.micro_gaps.is_empty(),
                "shift {shift} ms: a ramp edge misaligned by a couple of ms must not \
                 be flagged: {:?}",
                report.micro_gaps
            );
        }
    }

    #[test]
    // R94 (controller ruling): a genuine 4 ms hole in otherwise-steady audio, placed
    // 5 ms *before* an unrelated ramp starts, must still be flagged — the hole's own
    // ±2 ms neighbourhood never touches the ramp (2 ms < the 5 ms gap between them), so
    // the steady-state guard must not suppress it. Proves the guard is scoped to ramp
    // edges, not "any audio near a ramp."
    fn micro_gap_pass_still_flags_a_hole_shortly_before_a_ramp_starts() {
        const HOLE_START_MS: i64 = 400;
        const HOLE_LEN_MS: i64 = 4;
        const RAMP_START_MS: f64 = (HOLE_START_MS + HOLE_LEN_MS + 5) as f64; // 409 ms
        const DUR_MS: f64 = 30.0;
        let fine: Vec<(Duration, f64)> = (0..1000u64)
            .map(|t| (ms(t), ramp_curve(t as f64, RAMP_START_MS, DUR_MS)))
            .collect();
        let coarse: Vec<(Duration, f64)> = (0..100i64)
            .map(|k| {
                (
                    ms((k * 10) as u64),
                    ramp_curve((k * 10) as f64, RAMP_START_MS, DUR_MS),
                )
            })
            .collect();
        let mut observed: Vec<(Duration, f64)> = (0..1000u64)
            .map(|t| (ms(t), ramp_curve(t as f64, RAMP_START_MS, DUR_MS)))
            .collect();
        for sample in &mut observed[HOLE_START_MS as usize..(HOLE_START_MS + HOLE_LEN_MS) as usize]
        {
            sample.1 = SILENT_DB;
        }
        let report = analyse_with_fine(&observed, &coarse, &fine);
        assert_eq!(
            report.micro_gaps.len(),
            1,
            "the hole must still be flagged: {:?}",
            report.micro_gaps
        );
        assert_eq!(report.micro_gaps[0].at_ms, HOLE_START_MS);
        assert_eq!(report.micro_gaps[0].len_ms, HOLE_LEN_MS as u32);
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
