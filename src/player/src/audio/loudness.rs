//! Scene loudness, learned on first play (Phase 2, owner decision: "measure a scene's
//! integrated loudness over its first ~60 s of play (from the worker's stream on the bus),
//! store it in the index like a video's `loudness*`, apply normalization from then on").
//! `.claude/rules/player-core.md` § Scene worker → "Scene loudness".
//!
//! ITU-R BS.1770-4 / EBU R128, split across the two processes:
//!
//! - **the worker** ([`SegmentMeter`]) K-weights the scene's sound **before its gain** (a user
//!   volume, mute or the normalization itself never biases it) and reports one [`Segment`] per
//!   100 ms of audio it really played: the channel-summed K-weighted mean square + the sample
//!   peak. Only buffers that pulled the scene's sound into a real stream count — paused,
//!   `no_audio`, a fade-out and the PipeWire-down fallback timer add nothing;
//! - **the compositor** ([`Learner`], one per scene source, surviving worker restarts) builds
//!   the 400 ms gating blocks (75 % overlap = 4 consecutive segments), keeps those above the
//!   absolute gate (−70 LUFS) and, once they cover the window ([`WINDOW_ENV`], 60 s of
//!   **audible** play — a silent stretch doesn't count), integrates them with the relative gate
//!   (−10 LU) → `scene.loudness {complete: true}`. A source that ends (switched away,
//!   destroyed, its path changed) with at least a third of the window reports what it has
//!   (`complete: false`).
//!
//! **Refined across plays** (owner 2026-10-28: "60s to normalize for rest of scene, keep
//! measuring to get a more accurate measure when the scene is played in future (probably add
//! a max cap …)"): the blocks are kept as a histogram (0.1 LU bins, −70…+5 LUFS) — exactly
//! what BS.1770's relative gate needs, and two of them add — reported with every
//! `scene.loudness` as `state` and stored by the backend; the next play's source is seeded
//! with it (`loudness_seed`) and continues the same integration. Reports: at the window
//! (seed included), after each further window of audible play, at the end for what's left,
//! and once at the cap ([`CAP_ENV`], 30 min of audible play over every session) — after which
//! nothing more is measured (the worker stops metering).

use std::collections::VecDeque;

/// The worker's stream rate (the K-weighting coefficients below are for it).
pub const RATE: u32 = 48_000;
/// One segment = 100 ms (the gating blocks' hop).
pub const SEGMENT_FRAMES: usize = RATE as usize / 10;
pub const SEGMENT_S: f64 = 0.1;
/// Segments per 400 ms gating block.
const BLOCK_SEGMENTS: usize = 4;
/// BS.1770-4's absolute gate.
pub const ABS_GATE_LUFS: f64 = -70.0;
/// BS.1770-4's relative gate (below the absolute-gated mean).
pub const REL_GATE_LU: f64 = -10.0;
/// The learning window in seconds of audible play (tests shorten it); default
/// [`DEFAULT_WINDOW_S`].
pub const WINDOW_ENV: &str = "LP_PLAYER_LOUDNESS_WINDOW_S";
pub const DEFAULT_WINDOW_S: f64 = 60.0;

/// The window for the value of [`WINDOW_ENV`]: a positive number of seconds, else 60.
pub fn window_s(v: Option<&str>) -> f64 {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(DEFAULT_WINDOW_S)
}

/// The cap: total audible seconds measured over every play of a scene, after which nothing
/// more is measured (owner: "probably add a max cap for people who will never change
/// wallpaper") — 30 min; tests shorten it. Never below the window.
pub const CAP_ENV: &str = "LP_PLAYER_LOUDNESS_CAP_S";
pub const DEFAULT_CAP_S: f64 = 1800.0;

/// The cap for the value of [`CAP_ENV`]: a positive number of seconds, else 1800.
pub fn cap_s(v: Option<&str>) -> f64 {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(DEFAULT_CAP_S)
}

/// Loudness (LUFS) of a channel-summed K-weighted mean square.
pub fn lufs_of(power: f64) -> f64 {
    if power <= 0.0 {
        f64::NEG_INFINITY
    } else {
        -0.691 + 10.0 * power.log10()
    }
}

/// One 100 ms of played audio: Σ over channels of the K-weighted mean square, and the
/// largest |sample| (pre-gain, linear).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    pub power: f64,
    pub peak: f32,
}

/// One biquad (transposed direct form II, f64 state).
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Biquad {
    const fn new(b: [f64; 3], a: [f64; 2]) -> Biquad {
        Biquad { b, a, z: [0.0; 2] }
    }

    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// BS.1770-4's K-weighting at 48 kHz: the head's high shelf, then the RLB high-pass.
fn k_weighting() -> [Biquad; 2] {
    [
        Biquad::new(
            [1.535_124_859_586_97, -2.691_696_189_406_38, 1.198_392_810_852_85],
            [-1.690_659_293_182_41, 0.732_480_774_215_85],
        ),
        Biquad::new([1.0, -2.0, 1.0], [-1.990_047_454_833_98, 0.990_072_250_366_21]),
    ]
}

/// The worker's half: interleaved samples in, a [`Segment`] per 100 ms out. Pure.
#[derive(Debug, Clone)]
pub struct SegmentMeter {
    channels: usize,
    filters: Vec<[Biquad; 2]>,
    sum: Vec<f64>,
    n: usize,
    peak: f32,
}

impl SegmentMeter {
    pub fn new(channels: usize) -> SegmentMeter {
        let channels = channels.max(1);
        SegmentMeter {
            channels,
            filters: vec![k_weighting(); channels],
            sum: vec![0.0; channels],
            n: 0,
            peak: 0.0,
        }
    }

    /// Feed interleaved `samples` the scene really played; every completed 100 ms goes to
    /// `out`. A partial segment carries into the next call.
    pub fn feed(&mut self, samples: &[f32], out: &mut Vec<Segment>) {
        for frame in samples.chunks_exact(self.channels) {
            for ((x, f), acc) in frame.iter().zip(&mut self.filters).zip(&mut self.sum) {
                let shelved = f[0].run(*x as f64);
                let y = f[1].run(shelved);
                *acc += y * y;
                self.peak = self.peak.max(x.abs());
            }
            self.n += 1;
            if self.n == SEGMENT_FRAMES {
                let power = self.sum.iter().sum::<f64>() / SEGMENT_FRAMES as f64;
                out.push(Segment {
                    power,
                    peak: self.peak,
                });
                self.sum.iter_mut().for_each(|s| *s = 0.0);
                self.n = 0;
                self.peak = 0.0;
            }
        }
    }
}

/// What a source reports (`scene.loudness`): the integration over every session measured so
/// far (its seed + this source's own play).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Learned {
    /// Integrated loudness (gated), LUFS.
    pub lufs: f64,
    /// Sample peak over everything measured, dBFS (≤ the true peak).
    pub peak_dbfs: f64,
    /// Audible seconds measured over every session (blocks above the absolute gate × 100 ms).
    pub seconds: f64,
    /// Seconds of audio this source played (segments received), audible or not.
    pub played_s: f64,
    /// At least the window was measured (else a partial, at the source's end).
    pub complete: bool,
    /// Audible seconds measured by this source (the rest came from its seed).
    pub session_s: f64,
    /// The cap was reached: measuring stopped for good.
    pub capped: bool,
}

/// The histogram's bins: [`HIST_STEP`] LU wide from [`ABS_GATE_LUFS`] up to +5 LUFS (a block
/// louder than that lands in the last bin). The standard trick for an integrated loudness
/// that can be continued: BS.1770's relative gate needs every block's loudness, which the
/// counts per 0.1 LU keep to ±0.05 LU — and two histograms add.
pub const HIST_STEP: f64 = 0.1;
pub const HIST_BINS: usize = 750;
/// The state's format version (`state_json`).
const STATE_V: u64 = 1;

fn bin_of(lufs: f64) -> usize {
    (((lufs - ABS_GATE_LUFS) / HIST_STEP).floor().max(0.0) as usize).min(HIST_BINS - 1)
}

/// A bin's block power (its centre's loudness).
fn bin_power(i: usize) -> f64 {
    10f64.powf((ABS_GATE_LUFS + (i as f64 + 0.5) * HIST_STEP + 0.691) / 10.0)
}

/// BS.1770's gated integration over a histogram of block loudness (already absolute-gated).
fn integrate(hist: &[u64]) -> Option<f64> {
    let (mut e, mut n) = (0.0, 0u64);
    for (i, c) in hist.iter().enumerate().filter(|(_, c)| **c > 0) {
        e += *c as f64 * bin_power(i);
        n += c;
    }
    if n == 0 {
        return None;
    }
    let rel = lufs_of(e / n as f64) + REL_GATE_LU;
    let (mut e, mut n) = (0.0, 0u64);
    for (i, c) in hist.iter().enumerate().filter(|(_, c)| **c > 0) {
        if ABS_GATE_LUFS + (i as f64 + 0.5) * HIST_STEP > rel {
            e += *c as f64 * bin_power(i);
            n += c;
        }
    }
    (n > 0).then(|| lufs_of(e / n as f64))
}

/// A seed (`state_json` of an earlier session) → (histogram, linear peak); `None` = malformed.
fn parse_state(v: &serde_json::Value) -> Option<(Vec<u64>, f32)> {
    if v.get("v")?.as_u64()? != STATE_V {
        return None;
    }
    let first = v.get("first")?.as_u64()? as usize;
    let counts = v.get("counts")?.as_array()?;
    if first.checked_add(counts.len())? > HIST_BINS {
        return None;
    }
    let mut hist = vec![0u64; HIST_BINS];
    for (i, c) in counts.iter().enumerate() {
        hist[first + i] = c.as_u64()?;
    }
    let peak = match v.get("peak_dbfs") {
        Some(p) if p.is_null() => 0.0,
        Some(p) => 10f64.powf(p.as_f64()? / 20.0) as f32,
        None => 0.0,
    };
    Some((hist, peak))
}

/// The compositor's half: segments in, the gated integration out. One per scene source,
/// **seeded** with the state stored after earlier plays (`with_seed`), so each play refines
/// the same measurement; reports when the audible play over every session reaches the window,
/// after each further window of this source's audible play, at the cap (then measuring stops
/// for good) and at the end ([`finish`](Self::finish)) for what's left.
#[derive(Debug, Clone)]
pub struct Learner {
    window_s: f64,
    cap_s: f64,
    recent: VecDeque<f64>,
    /// Block counts per 0.1 LU bin: the seed's + this source's.
    hist: Vec<u64>,
    /// Blocks in `hist` (above the absolute gate): every session's.
    blocks: u64,
    seed_blocks: u64,
    /// `blocks` at the last report (the seed's at the start).
    reported_blocks: u64,
    peak: f32,
    segments: u64,
    /// Nothing more is taken: the cap was reached, or the source ended.
    done: bool,
    capped: bool,
}

impl Learner {
    pub fn new(window_s: f64) -> Learner {
        Learner {
            window_s,
            cap_s: DEFAULT_CAP_S.max(window_s),
            recent: VecDeque::with_capacity(BLOCK_SEGMENTS),
            hist: vec![0; HIST_BINS],
            blocks: 0,
            seed_blocks: 0,
            reported_blocks: 0,
            peak: 0.0,
            segments: 0,
            done: false,
            capped: false,
        }
    }

    /// The total audible seconds after which measuring stops (never below the window).
    pub fn with_cap(mut self, cap_s: f64) -> Learner {
        self.cap_s = cap_s.max(self.window_s);
        self.check_cap();
        self
    }

    /// Continue an earlier measurement (`state_json` of the last report stored in the index);
    /// `None` or a malformed state = start from nothing.
    pub fn with_seed(mut self, seed: Option<&serde_json::Value>) -> Learner {
        let Some((hist, peak)) = seed.and_then(parse_state) else {
            return self;
        };
        self.blocks = hist.iter().sum();
        self.seed_blocks = self.blocks;
        self.reported_blocks = self.blocks;
        self.hist = hist;
        self.peak = peak;
        self.check_cap();
        self
    }

    fn check_cap(&mut self) {
        if self.audible_s() + 1e-9 >= self.cap_s {
            self.done = true;
            self.capped = true;
        }
    }

    pub fn window_s(&self) -> f64 {
        self.window_s
    }

    pub fn cap_s(&self) -> f64 {
        self.cap_s
    }

    /// A partial needs this much audible play (a third of the window: 20 s by default).
    pub fn min_s(&self) -> f64 {
        self.window_s / 3.0
    }

    /// What has to be left unreported for a report at the end (a twelfth of the window: 5 s by
    /// default) — a quick switch costs no index write.
    pub fn end_min_s(&self) -> f64 {
        self.window_s / 12.0
    }

    /// Nothing more is taken (capped, or ended).
    pub fn done(&self) -> bool {
        self.done
    }

    /// The cap was reached (measuring stopped for good, the worker needn't meter).
    pub fn capped(&self) -> bool {
        self.capped
    }

    /// Audible seconds over every session (the seed's + this source's).
    pub fn audible_s(&self) -> f64 {
        self.blocks as f64 * SEGMENT_S
    }

    /// Audible seconds the seed brought.
    pub fn seed_s(&self) -> f64 {
        self.seed_blocks as f64 * SEGMENT_S
    }

    /// Audible seconds this source measured.
    pub fn session_s(&self) -> f64 {
        (self.blocks - self.seed_blocks) as f64 * SEGMENT_S
    }

    pub fn played_s(&self) -> f64 {
        self.segments as f64 * SEGMENT_S
    }

    /// The gated integrated loudness of everything measured so far (`None`: nothing above the
    /// absolute gate — a silent scene).
    pub fn integrated(&self) -> Option<f64> {
        integrate(&self.hist)
    }

    /// What the backend stores and seeds the next play with: `{v: 1, first, counts, peak_dbfs}`
    /// — the non-zero span of the histogram (bin `first + i` holds the blocks between −70 +
    /// 0.1·(first + i) and 0.1 LU above), and the sample peak (null = none).
    pub fn state_json(&self) -> serde_json::Value {
        let first = self.hist.iter().position(|c| *c > 0).unwrap_or(0);
        let last = self.hist.iter().rposition(|c| *c > 0).map_or(first, |l| l + 1);
        serde_json::json!({
            "v": STATE_V,
            "first": first,
            "counts": &self.hist[first..last],
            "peak_dbfs": (self.peak > 0.0).then(|| 20.0 * (self.peak as f64).log10()),
        })
    }

    fn learned(&mut self) -> Option<Learned> {
        let lufs = self.integrated()?;
        self.reported_blocks = self.blocks;
        Some(Learned {
            lufs,
            peak_dbfs: if self.peak > 0.0 {
                20.0 * (self.peak as f64).log10()
            } else {
                f64::NEG_INFINITY
            },
            seconds: self.audible_s(),
            played_s: self.played_s(),
            complete: self.audible_s() + 1e-9 >= self.window_s,
            session_s: self.session_s(),
            capped: self.capped,
        })
    }

    /// The audible seconds at which the next report is due: the window, then each further
    /// window, never past the cap.
    fn next_report_s(&self) -> f64 {
        let reported = self.reported_blocks as f64 * SEGMENT_S;
        let next = if reported + 1e-9 < self.window_s {
            self.window_s
        } else {
            reported + self.window_s
        };
        next.min(self.cap_s)
    }

    /// Take one segment; `Some` when a report is due (the window reached, a further window
    /// measured, the cap).
    pub fn push(&mut self, seg: Segment) -> Option<Learned> {
        if self.done || !seg.power.is_finite() || seg.power < 0.0 {
            return None;
        }
        self.segments += 1;
        if self.recent.len() == BLOCK_SEGMENTS {
            self.recent.pop_front();
        }
        self.recent.push_back(seg.power);
        if self.recent.len() < BLOCK_SEGMENTS {
            return None;
        }
        let block = self.recent.iter().sum::<f64>() / BLOCK_SEGMENTS as f64;
        let l = lufs_of(block);
        if l <= ABS_GATE_LUFS {
            return None;
        }
        self.hist[bin_of(l)] += 1;
        self.blocks += 1;
        self.peak = self.peak.max(seg.peak);
        if self.audible_s() + 1e-9 < self.next_report_s() {
            return None;
        }
        self.check_cap();
        self.learned()
    }

    /// The source ends (switched away, destroyed, its path changed): a report of what's left
    /// unreported (≥ [`end_min_s`](Self::end_min_s)) once the play over every session reached
    /// [`min_s`](Self::min_s). Learning stops.
    pub fn finish(&mut self) -> Option<Learned> {
        if self.done {
            return None;
        }
        self.done = true;
        let unreported = (self.blocks - self.reported_blocks) as f64 * SEGMENT_S;
        if self.audible_s() + 1e-9 < self.min_s() || unreported + 1e-9 < self.end_min_s() {
            return None;
        }
        self.learned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stereo sine (`hz`, peak `dbfs` on both channels), `secs` long, through the meter.
    fn sine_segments(hz: f64, dbfs: f64, secs: f64, channels: usize) -> Vec<Segment> {
        let amp = 10f64.powf(dbfs / 20.0);
        let n = (secs * RATE as f64) as usize;
        let mut buf = Vec::with_capacity(n * channels);
        for i in 0..n {
            let v = (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / RATE as f64).sin()) as f32;
            for _ in 0..channels {
                buf.push(v);
            }
        }
        let mut m = SegmentMeter::new(channels);
        let mut out = Vec::new();
        // In odd-sized buffers, as a stream delivers them.
        for c in buf.chunks(257 * channels) {
            m.feed(c, &mut out);
        }
        out
    }

    fn integrate(segs: &[Segment]) -> Option<f64> {
        let mut l = Learner::new(1e9);
        for s in segs {
            l.push(*s);
        }
        l.integrated()
    }

    /// EBU Tech 3341 case 1/2: a stereo 1 kHz sine at −23 dBFS (and −33) reads −23.0 (−33.0)
    /// LUFS ± 0.1; BS.1770's definition: a 997 Hz 0 dBFS sine on ONE channel is −3.01.
    #[test]
    fn stereo_1khz_sine_reads_its_level_in_lufs() {
        for db in [-23.0, -33.0, -20.0] {
            let l = integrate(&sine_segments(1000.0, db, 5.0, 2)).unwrap();
            assert!((l - db).abs() < 0.1, "{db} dBFS → {l} LUFS");
        }
        let mono = integrate(&sine_segments(997.0, 0.0, 5.0, 1)).unwrap();
        assert!((mono + 3.01).abs() < 0.1, "{mono}");
    }

    /// K-weighting: 100 Hz reads lower than 1 kHz (the RLB high-pass), 4 kHz higher (the shelf
    /// — about +2.7 dB at 4 kHz per the filter's response).
    #[test]
    fn k_weighting_shapes_the_spectrum() {
        let at = |hz| integrate(&sine_segments(hz, -20.0, 3.0, 2)).unwrap();
        let (low, mid, high) = (at(30.0), at(1000.0), at(4000.0));
        assert!(low < mid - 1.0, "30 Hz {low} vs 1 kHz {mid}");
        assert!(high > mid + 2.0 && high < mid + 4.0, "4 kHz {high} vs 1 kHz {mid}");
    }

    /// The absolute gate: silence between sound never pulls the result down (and isn't
    /// counted as audible); the relative gate: a long quiet passage (> 10 LU below) is
    /// excluded too (EBU Tech 3341 case 3/4-like).
    #[test]
    fn gating_excludes_silence_and_quiet_passages() {
        let mut segs = sine_segments(1000.0, -20.0, 10.0, 2);
        segs.extend(sine_segments(1000.0, -200.0, 10.0, 2)); // digital silence
        segs.extend(sine_segments(1000.0, -20.0, 10.0, 2));
        let l = integrate(&segs).unwrap();
        assert!((l + 20.0).abs() < 0.1, "{l}");
        let mut learner = Learner::new(1e9);
        for s in &segs {
            learner.push(*s);
        }
        assert!((learner.audible_s() - 20.0).abs() < 0.5, "{}", learner.audible_s());
        assert!((learner.played_s() - 30.0).abs() < 0.2);
        // 36 s loud + 24 s at −45 dBFS (25 LU below): the quiet part is gated out.
        let mut segs = sine_segments(1000.0, -20.0, 36.0, 2);
        segs.extend(sine_segments(1000.0, -45.0, 24.0, 2));
        let l = integrate(&segs).unwrap();
        assert!((l + 20.0).abs() < 0.2, "{l}");
        // −20 / −26 alternating (6 LU apart, within the gate): both count → between them.
        let mut segs = Vec::new();
        for _ in 0..5 {
            segs.extend(sine_segments(1000.0, -20.0, 2.0, 2));
            segs.extend(sine_segments(1000.0, -26.0, 2.0, 2));
        }
        let l = integrate(&segs).unwrap();
        let want = lufs_of((10f64.powf(-20.0 / 10.0) + 10f64.powf(-26.0 / 10.0)) / 2.0) + 0.691;
        assert!((l - want).abs() < 0.3, "{l} vs {want}");
    }

    /// A silent scene learns nothing (no event, ever); the window counts audible play only.
    #[test]
    fn silence_learns_nothing_and_the_window_is_audible_play() {
        let mut l = Learner::new(3.0);
        for s in sine_segments(1000.0, -200.0, 10.0, 2) {
            assert!(l.push(s).is_none());
        }
        assert_eq!(l.integrated(), None);
        assert!(l.finish().is_none(), "silent: no partial either");
        let mut l = Learner::new(3.0);
        let segs = sine_segments(1000.0, -20.0, 5.0, 2);
        let mut hits = Vec::new();
        for (i, s) in segs.iter().enumerate() {
            if let Some(x) = l.push(*s) {
                hits.push((i, x));
            }
        }
        assert_eq!(hits.len(), 1, "once: {hits:?}");
        let (i, x) = hits[0];
        // 3 s audible: the first block needs 4 segments, then one per segment.
        assert_eq!(i, 32, "at segment {i}");
        assert!(x.complete && (x.lufs + 20.0).abs() < 0.1 && (x.seconds - 3.0).abs() < 1e-6);
        assert!((x.peak_dbfs + 20.0).abs() < 0.01, "{}", x.peak_dbfs);
        // Measuring goes on (the next report after another window, or at the end).
        assert!(!l.done());
        let end = l.finish().expect("the 1.7 s since, at the end");
        assert!((end.seconds - 4.7).abs() < 1e-6 && end.complete, "{end:?}");
        assert!(l.done() && l.finish().is_none(), "nothing more after the end");
    }

    /// Ending early: a partial from a third of the window on, nothing below it.
    #[test]
    fn a_source_ending_early_reports_a_partial_from_a_third_of_the_window() {
        let mut l = Learner::new(6.0);
        for s in sine_segments(1000.0, -20.0, 1.5, 2) {
            assert!(l.push(s).is_none());
        }
        assert!(l.finish().is_none(), "1.5 s < 2 s");
        let mut l = Learner::new(6.0);
        for s in sine_segments(1000.0, -26.0, 3.0, 2) {
            assert!(l.push(s).is_none());
        }
        let p = l.finish().expect("a partial");
        assert!(!p.complete && (p.lufs + 26.0).abs() < 0.1, "{p:?}");
        assert!(p.seconds > 2.0 && p.seconds < 3.0, "{p:?}");
    }

    /// The exact BS.1770 integration of `segs` (every gating block kept as is — no histogram):
    /// the reference a merged histogram is held to.
    /// Also the audible seconds (blocks above the absolute gate).
    fn exact(segs: &[Segment]) -> (f64, f64) {
        let p: Vec<f64> = segs.iter().map(|s| s.power).collect();
        let blocks: Vec<f64> = p
            .windows(BLOCK_SEGMENTS)
            .map(|w| w.iter().sum::<f64>() / BLOCK_SEGMENTS as f64)
            .filter(|b| lufs_of(*b) > ABS_GATE_LUFS)
            .collect();
        let secs = blocks.len() as f64 * SEGMENT_S;
        let mean = blocks.iter().sum::<f64>() / blocks.len() as f64;
        let rel = lufs_of(mean) + REL_GATE_LU;
        let g: Vec<f64> = blocks.into_iter().filter(|b| lufs_of(*b) > rel).collect();
        (lufs_of(g.iter().sum::<f64>() / g.len() as f64), secs)
    }

    /// Feed `segs` to `l`, collecting every report.
    fn feed(l: &mut Learner, segs: &[Segment]) -> Vec<Learned> {
        segs.iter().filter_map(|s| l.push(*s)).collect()
    }

    /// Owner (2026-10-28): "keep measuring to get a more accurate measure when the scene is
    /// played in future". A session seeded with the previous one's state (its histogram) ends
    /// where ONE long integration over both would — within 0.1 LU — for any split.
    #[test]
    fn histogram_merge_across_sessions_equals_one_long_integration() {
        let mut segs = Vec::new();
        for (db, secs) in [
            (-20.0, 8.0),
            (-31.0, 6.0),
            (-24.0, 9.0),
            (-200.0, 3.0),
            (-17.0, 4.0),
        ] {
            segs.extend(sine_segments(1000.0, db, secs, 2));
        }
        let (want, one) = exact(&segs);
        for split in [40, 95, 160, 230] {
            let mut a = Learner::new(5.0).with_cap(1e9);
            feed(&mut a, &segs[..split]);
            let _ = a.finish();
            let st = a.state_json();
            // The seed carries the first session's blocks; the next continues them.
            let mut b = Learner::new(5.0).with_cap(1e9).with_seed(Some(&st));
            feed(&mut b, &segs[split..]);
            let got = b.integrated().unwrap();
            assert!(
                (got - want).abs() < 0.1,
                "split {split}: {got} vs one integration {want}"
            );
            // Each session forms its own first block: the second session's first 3
            // segments start no block (0.3 s fewer audible seconds than one long run).
            let secs = b.audible_s();
            assert!(
                secs <= one + 1e-9 && secs > one - 0.35,
                "split {split}: {secs} vs {one}"
            );
            assert!((b.seed_s() - a.audible_s()).abs() < 1e-9, "seed seconds");
        }
    }

    /// The relative gate is recomputed over ALL sessions: a quiet first play followed by a
    /// loud one gates the quiet part out (−20), where combining the two results (a seconds-
    /// weighted energy mean, −25.8) or keeping the first (−38) would be wrong.
    #[test]
    fn relative_gate_is_recomputed_across_quiet_and_loud_sessions() {
        let quiet = sine_segments(1000.0, -38.0, 30.0, 2);
        let loud = sine_segments(1000.0, -20.0, 10.0, 2);
        let mut a = Learner::new(5.0).with_cap(1e9);
        feed(&mut a, &quiet);
        assert!((a.integrated().unwrap() + 38.0).abs() < 0.1);
        let st = a.state_json();
        let mut b = Learner::new(5.0).with_cap(1e9).with_seed(Some(&st));
        assert_eq!(feed(&mut b, &loud).len(), 1, "after a window of its own");
        let got = b.integrated().unwrap();
        assert!((got + 20.0).abs() < 0.1, "{got}");
        let last = b.finish().expect("the rest, at the end");
        assert!((last.lufs + 20.0).abs() < 0.1 && last.complete, "{last:?}");
        // The other order: the quiet session after the loud one changes nothing.
        let mut a = Learner::new(5.0).with_cap(1e9);
        feed(&mut a, &loud);
        let mut b = Learner::new(5.0)
            .with_cap(1e9)
            .with_seed(Some(&a.state_json()));
        feed(&mut b, &quiet);
        assert!(
            (b.integrated().unwrap() + 20.0).abs() < 0.1,
            "{:?}",
            b.integrated()
        );
    }

    /// Cadence: the first report when the audible play (seed included) reaches the window,
    /// then one per further window of audible play, and one at the end for what's left (≥ a
    /// twelfth of the window); a seeded source that already has the window reports after a
    /// window of its own play.
    #[test]
    fn reports_each_further_window_and_at_the_end() {
        let segs = sine_segments(1000.0, -20.0, 10.0, 2);
        let mut l = Learner::new(3.0).with_cap(1e9);
        let r = feed(&mut l, &segs);
        let at: Vec<f64> = r
            .iter()
            .map(|x| (x.seconds * 10.0).round() / 10.0)
            .collect();
        assert_eq!(at, vec![3.0, 6.0, 9.0], "{r:?}");
        assert!(r.iter().all(|x| x.complete && !x.capped));
        let end = l.finish().expect("what's left at the end (0.7 s ≥ 0.25 s)");
        assert!((end.seconds - 9.7).abs() < 0.05 && end.complete, "{end:?}");
        assert!(
            l.finish().is_none() && l.push(segs[0]).is_none(),
            "nothing after the end"
        );
        // Seeded with 9.7 s: the next report after 3 s more of this source's play.
        let mut s = Learner::new(3.0)
            .with_cap(1e9)
            .with_seed(Some(&l.state_json()));
        assert!((s.audible_s() - 9.7).abs() < 0.05);
        let r = feed(&mut s, &sine_segments(1000.0, -20.0, 4.0, 2));
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(
            (r[0].seconds - 12.7).abs() < 0.05 && (r[0].session_s - 3.0).abs() < 0.05,
            "{r:?}"
        );
        // Too little left at the end: nothing (a quick switch costs no index write).
        let mut q = Learner::new(3.0)
            .with_cap(1e9)
            .with_seed(Some(&l.state_json()));
        feed(&mut q, &sine_segments(1000.0, -20.0, 0.5, 2));
        assert!(q.finish().is_none(), "0.2 s < a twelfth of the window");
    }

    /// The cap: once the audible play measured over every session reaches it, one last report
    /// (`capped`) and nothing more is taken — a scene that's never switched away doesn't
    /// accumulate forever. A seed already at the cap measures nothing at all.
    #[test]
    fn cap_stops_measuring() {
        let mut l = Learner::new(2.0).with_cap(5.0);
        let r = feed(&mut l, &sine_segments(1000.0, -20.0, 12.0, 2));
        let last = r.last().unwrap();
        assert!(last.capped && (last.seconds - 5.0).abs() < 1e-9, "{r:?}");
        assert_eq!(r.iter().filter(|x| x.capped).count(), 1);
        assert!(
            l.done() && (l.audible_s() - 5.0).abs() < 1e-9,
            "stopped at the cap"
        );
        assert!(l.finish().is_none());
        let st = l.state_json();
        let mut s = Learner::new(2.0).with_cap(5.0).with_seed(Some(&st));
        assert!(s.done(), "a seed at the cap measures nothing");
        assert!(feed(&mut s, &sine_segments(1000.0, -20.0, 3.0, 2)).is_empty());
        assert!(s.finish().is_none());
        // A cap below the window is the window.
        assert_eq!(Learner::new(6.0).with_cap(2.0).cap_s(), 6.0);
    }

    /// The state round-trips (counts + peak); anything malformed is no seed.
    #[test]
    fn state_round_trips_and_a_bad_seed_is_ignored() {
        let mut l = Learner::new(2.0).with_cap(1e9);
        feed(&mut l, &sine_segments(1000.0, -26.0, 3.0, 2));
        let st = l.state_json();
        let s = Learner::new(2.0).with_cap(1e9).with_seed(Some(&st));
        assert_eq!(s.integrated(), l.integrated());
        assert_eq!(s.audible_s(), l.audible_s());
        assert_eq!(s.state_json(), st, "{st}");
        for bad in [
            serde_json::json!({}),
            serde_json::json!({"v": 2, "first": 0, "counts": [1]}),
            serde_json::json!({"v": 1, "first": 749, "counts": [1, 1]}),
            serde_json::json!({"v": 1, "first": 0, "counts": [-1]}),
            serde_json::json!("x"),
        ] {
            let s = Learner::new(2.0).with_cap(1e9).with_seed(Some(&bad));
            assert_eq!(s.audible_s(), 0.0, "{bad}");
        }
        assert_eq!(cap_s(None), 1800.0);
        assert_eq!(cap_s(Some("12")), 12.0);
        assert_eq!(cap_s(Some("0")), 1800.0);
    }

    #[test]
    fn window_knob() {
        assert_eq!(window_s(None), 60.0);
        assert_eq!(window_s(Some(" 3 ")), 3.0);
        assert_eq!(window_s(Some("0.5")), 0.5);
        for v in ["0", "-1", "x", "", "inf", "NaN"] {
            assert_eq!(window_s(Some(v)), 60.0, "{v}");
        }
    }
}
