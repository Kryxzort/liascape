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

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
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
/// A lag needs at least this many qualifying (expected > −60 dB) paired bins to be
/// considered — guards against a near-silent window picking an arbitrary "best" lag.
const MIN_LAG_PAIRS: usize = 3;

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

/// What [`analyse`] found.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DropoutReport {
    /// The lag (ms, 10 ms steps) that best aligns `observed` to `expected`.
    pub lag_ms: u32,
    /// Mean absolute dB error at that lag, after `offset_db` — how good the fit is.
    pub fit_db: f64,
    /// Median `observed − expected` at the chosen lag (a level mismatch, e.g. a
    /// miscalibrated bus gain, isn't itself a dropout).
    pub offset_db: f64,
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
/// (10 ms-bin) drops and fine (sub-bin) micro-gaps. Both slices must be oldest-first and
/// share a common time base (the probe wiring uses the log's `t_mono_ms` clock
/// throughout); `at_ms` in the result is relative to `expected`'s first entry.
pub fn analyse(observed: &[(Duration, f64)], expected: &[(Duration, f64)]) -> DropoutReport {
    if expected.is_empty() {
        return DropoutReport {
            lag_ms: 0,
            fit_db: 0.0,
            offset_db: 0.0,
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
        if pairs.len() < MIN_LAG_PAIRS {
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
    let (fit_db, lag, offset_db) = best.unwrap_or((0.0, 0, 0.0));

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

    // Micro-gaps: raw (sub-bin) observed samples far under their 10 ms expected bin.
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
        let k = bin10(*t) - origin - lag;
        let e = if k >= 0 && (k as usize) < exp.len() {
            Some(exp[k as usize] + offset_db)
        } else {
            None
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
        drops,
        micro_gaps,
    }
}

// --------------------------------------------------------------- expected_envelope()

/// One source feeding the expected mix: its graph id (must match a [`GainSchedule`] key),
/// its decoded file path, and its playback position (file-seconds) **at the window's own
/// start** (`window.0` of whatever window it's later decoded against — the probe wiring
/// in [`spawn_analysis`] rebases the position recorded at `transition.started`, which is
/// effect start, by subtracting [`WINDOW_PRE`]).
#[derive(Debug, Clone, PartialEq)]
pub struct SourceWindow {
    pub id: String,
    pub path: PathBuf,
    pub position: f64,
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
/// never recorded is treated as silent, never guessed loud.
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

/// `ffmpeg` resolved from `PATH` (never a hard-coded store path — same rule as
/// `scripts/lp_audiowatch.py`).
const FFMPEG: &str = "ffmpeg";

/// Decode `path` from `start_s` for `dur_s` seconds into one **linear power** value
/// (`mean(x²)`) per 10 ms bin, mono 48 kHz — padding silence before file-start and past
/// EOF/a decode failure, same convention as the Python reference's `decode_env`. Never
/// panics: a missing file, a bad path or no `ffmpeg` on `PATH` all just come back silent
/// (logged once, rate-limited, as `probe.dropout_decode_failed`), since this runs off the
/// main loop and must not take the player down over a stale/renamed wallpaper file.
fn decode_power_bins(path: &Path, start_s: f64, dur_s: f64) -> Vec<f64> {
    let n_bins = (dur_s * 100.0).round().max(0.0) as usize;
    let pad_s = (-start_s).max(0.0);
    let decode_s = (dur_s - pad_s).max(0.0);
    let pad_bins = ((pad_s * 100.0).round() as usize).min(n_bins);
    let mut bins = vec![0.0f64; pad_bins];
    if decode_s > 0.0 && !path.as_os_str().is_empty() {
        let out = Command::new(FFMPEG)
            .args([
                "-v",
                "error",
                "-ss",
                &format!("{:.3}", start_s.max(0.0)),
                "-t",
                &format!("{decode_s:.3}"),
                "-i",
            ])
            .arg(path)
            .args(["-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"])
            .output();
        match out {
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

/// `expected_envelope(src_paths_and_positions, gain_schedule, window) -> Vec<(Duration,
/// f64)>` (the brief's signature): decode each source once (`ffmpeg -ss <pos> -t <len>`,
/// 10 ms power bins), multiply each by `db_to_lin(gain)²` per source per bin (from the
/// recorded schedule, sampled per bin's own instant) and sum, same as
/// `lp_audiowatch.py`'s `refcheck`.
pub fn expected_envelope(
    sources: &[SourceWindow],
    gain_schedule: &GainSchedule,
    window: (Duration, Duration),
) -> Vec<(Duration, f64)> {
    let dur_s = window.1.saturating_sub(window.0).as_secs_f64();
    let decoded: Vec<Vec<f64>> = sources
        .iter()
        .map(|s| decode_power_bins(&s.path, s.position, dur_s))
        .collect();
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    mix_envelope(&ids, &decoded, gain_schedule, window)
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

/// Snapshot the meter + gain schedule for `pending`'s window (main thread, cheap) and
/// run the decode + [`analyse`] on a spawned thread, delivering `probe.dropout {corr,
/// report}` (or `{corr, skipped}`) via `log::event` once it's done — R71, never blocks
/// the caller. A no-op if `pending` hasn't reached `transition.done` yet.
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
    let observed = meter.window(window.0, window.1);
    let mut sources = Vec::with_capacity(pending.a.len() + 1);
    for s in &pending.a {
        sources.push(SourceWindow {
            id: s.id.clone(),
            path: PathBuf::from(&s.path),
            position: s.position - WINDOW_PRE.as_secs_f64(),
        });
    }
    sources.push(SourceWindow {
        id: pending.b.id.clone(),
        path: PathBuf::from(&pending.b.path),
        position: pending.b.position - WINDOW_PRE.as_secs_f64(),
    });
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let schedule = rt.gain_history.snapshot(&ids);
    std::thread::spawn(move || {
        let expected = expected_envelope(&sources, &schedule, window);
        let report = analyse(&observed, &expected);
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
        let bins = decode_power_bins(Path::new(""), -0.05, 0.1);
        assert_eq!(bins.len(), 10);
        assert!(bins.iter().all(|&p| p == 0.0));
    }
}
