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
//!   (`complete: false`); the backend keeps the longest measurement until a complete one.

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

/// What a source learned (`scene.loudness`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Learned {
    /// Integrated loudness (gated), LUFS.
    pub lufs: f64,
    /// Sample peak over what was measured, dBFS (≤ the true peak).
    pub peak_dbfs: f64,
    /// Audible seconds measured (blocks above the absolute gate × 100 ms).
    pub seconds: f64,
    /// Seconds of audio played (segments received), audible or not.
    pub played_s: f64,
    /// The whole window was measured (else a partial, at the source's end).
    pub complete: bool,
}

/// The compositor's half: segments in, the gated integration out once the window is covered.
#[derive(Debug, Clone)]
pub struct Learner {
    window_s: f64,
    recent: VecDeque<f64>,
    /// Block powers above the absolute gate (≤ window × 10 of them: learning stops there).
    blocks: Vec<f64>,
    peak: f32,
    segments: u64,
    done: bool,
}

impl Learner {
    pub fn new(window_s: f64) -> Learner {
        Learner {
            window_s,
            recent: VecDeque::with_capacity(BLOCK_SEGMENTS),
            blocks: Vec::new(),
            peak: 0.0,
            segments: 0,
            done: false,
        }
    }

    pub fn window_s(&self) -> f64 {
        self.window_s
    }

    /// A partial needs this much audible play (a third of the window: 20 s by default).
    pub fn min_s(&self) -> f64 {
        self.window_s / 3.0
    }

    /// Learned already (nothing more is taken).
    pub fn done(&self) -> bool {
        self.done
    }

    /// Audible seconds so far.
    pub fn audible_s(&self) -> f64 {
        self.blocks.len() as f64 * SEGMENT_S
    }

    pub fn played_s(&self) -> f64 {
        self.segments as f64 * SEGMENT_S
    }

    /// The gated integrated loudness of what was measured so far (`None`: nothing above the
    /// absolute gate — a silent scene).
    pub fn integrated(&self) -> Option<f64> {
        if self.blocks.is_empty() {
            return None;
        }
        let mean = |it: &mut dyn Iterator<Item = f64>| {
            let (s, n) = it.fold((0.0, 0usize), |(s, n), p| (s + p, n + 1));
            (n > 0).then(|| s / n as f64)
        };
        let ungated = mean(&mut self.blocks.iter().copied())?;
        let rel = lufs_of(ungated) + REL_GATE_LU;
        let gated = mean(&mut self.blocks.iter().copied().filter(|p| lufs_of(*p) > rel))?;
        Some(lufs_of(gated))
    }

    fn learned(&self, complete: bool) -> Option<Learned> {
        let lufs = self.integrated()?;
        Some(Learned {
            lufs,
            peak_dbfs: if self.peak > 0.0 {
                20.0 * (self.peak as f64).log10()
            } else {
                f64::NEG_INFINITY
            },
            seconds: self.audible_s(),
            played_s: self.played_s(),
            complete,
        })
    }

    /// Take one segment; `Some` exactly once, when the audible play reached the window.
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
        if lufs_of(block) <= ABS_GATE_LUFS {
            return None;
        }
        self.blocks.push(block);
        self.peak = self.peak.max(seg.peak);
        if self.audible_s() + 1e-9 < self.window_s {
            return None;
        }
        self.done = true;
        self.learned(true)
    }

    /// The source ends (switched away, destroyed, its path changed): a partial when at least
    /// [`min_s`](Self::min_s) was audible and nothing was learned yet. Learning stops.
    pub fn finish(&mut self) -> Option<Learned> {
        if self.done {
            return None;
        }
        self.done = true;
        if self.audible_s() + 1e-9 < self.min_s() {
            return None;
        }
        self.learned(false)
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
        assert!(l.done() && l.finish().is_none(), "nothing more after learning");
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
