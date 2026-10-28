//! Pitch-preserving time stretch for a scene's sound (Task 6; owner decision round 2: a
//! scene's `speed` scales its animation AND its audio, pitch kept). WSOLA — waveform-similarity
//! overlap-add, the family of mpv's `scaletempo`/`scaletempo2`: the output is built from 20 ms
//! Hann-windowed input segments overlapped by half (a 10 ms hop); segment `j` is taken near
//! input time `j × speed × hop`, at the offset (±10 ms) whose start best matches the natural
//! continuation of segment `j − 1` (normalised cross-correlation, a coarse search on every 4th
//! sample then a full-resolution refine), so periodic sound keeps its phase across the joins.
//!
//! **Exactly 1× is a passthrough**: the samples are pulled straight into the output, bit-exact
//! and without added latency. Leaving 1× starts WSOLA at the current input position with the
//! next 10 ms as the first overlap (continuous); returning to 1× continues the passthrough at
//! the natural continuation of the last segment, where the overlap-add would have given the
//! input itself (window halves sum to 1) — continuous both ways.

/// Interleaved channels (stereo, like the stream).
pub const CH: usize = 2;
/// Synthesis hop (10 ms at 48 kHz).
pub const HOP: usize = 480;
/// Segment (window) length: two hops.
pub const WIN: usize = 2 * HOP;
/// Search radius around a segment's nominal position (±10 ms: half a period down to 50 Hz).
pub const SEARCH: usize = 480;
/// The coarse search's decimation.
const DECIM: usize = 4;

/// Where the stretcher reads the scene's sound: always fills `out` (interleaved stereo).
pub trait Pull: Send {
    fn pull(&mut self, out: &mut [f32]);
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    /// 1×: the next input frame to output.
    Pass,
    /// The last segment's start and the (ideal) input position it stands for.
    Wsola { prev: i64, nominal: f64 },
}

pub struct Stretch {
    /// Input frames from `in_start` on (interleaved).
    inbuf: Vec<f32>,
    in_start: i64,
    /// Pass mode: the next input frame to output.
    pos: i64,
    mode: Mode,
    /// The second half of the last segment, windowed (`HOP` frames).
    tail: Vec<f32>,
    window: Vec<f32>,
    /// Produced and not handed out yet (a WSOLA step makes `HOP` frames at once).
    out: Vec<f32>,
    out_read: usize,
    /// Mono scratch for the search.
    mono_ref: Vec<f32>,
}

impl Default for Stretch {
    fn default() -> Self {
        Stretch::new()
    }
}

/// `speed` that counts as exactly 1× (the UI and the graph send exact values).
fn is_unit(speed: f64) -> bool {
    (speed - 1.0).abs() < 1e-9
}

impl Stretch {
    pub fn new() -> Stretch {
        // Periodic Hann: w[i] + w[i + HOP] = 1 for every i (a constant overlap-add).
        let window = (0..WIN)
            .map(|i| {
                (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / WIN as f64).cos()) as f32
            })
            .collect();
        Stretch {
            inbuf: Vec::new(),
            in_start: 0,
            pos: 0,
            mode: Mode::Pass,
            tail: Vec::new(),
            window,
            out: Vec::new(),
            out_read: 0,
            mono_ref: vec![0.0; HOP],
        }
    }

    /// Input frames pulled so far.
    pub fn pulled(&self) -> i64 {
        self.in_start + (self.inbuf.len() / CH) as i64
    }

    /// Passthrough right now (1× and nothing pending from a stretch).
    #[cfg(test)]
    pub fn passthrough(&self) -> bool {
        self.mode == Mode::Pass
    }

    fn ensure(&mut self, upto: i64, src: &mut dyn Pull) {
        let have = self.pulled();
        if upto > have {
            let n = (upto - have) as usize * CH;
            let at = self.inbuf.len();
            self.inbuf.resize(at + n, 0.0);
            src.pull(&mut self.inbuf[at..]);
        }
    }

    fn trim(&mut self, keep_from: i64) {
        let k = keep_from.min(self.pulled());
        if k > self.in_start {
            let n = (k - self.in_start) as usize * CH;
            self.inbuf.drain(..n);
            self.in_start = k;
        }
    }

    fn at(&self, frame: i64, ch: usize) -> f32 {
        self.inbuf[(frame - self.in_start) as usize * CH + ch]
    }

    fn mono(&self, frame: i64) -> f32 {
        let i = (frame - self.in_start) as usize * CH;
        self.inbuf[i] + self.inbuf[i + 1]
    }

    /// Fill `out` (interleaved stereo) at `speed`, pulling what it needs from `src`.
    pub fn produce(&mut self, out: &mut [f32], speed: f64, src: &mut dyn Pull) {
        let n = out.len() / CH;
        let mut w = 0;
        while w < n {
            if self.out_read < self.out.len() {
                let k = ((self.out.len() - self.out_read) / CH).min(n - w);
                out[w * CH..(w + k) * CH]
                    .copy_from_slice(&self.out[self.out_read..self.out_read + k * CH]);
                self.out_read += k * CH;
                w += k;
                if self.out_read == self.out.len() {
                    self.out.clear();
                    self.out_read = 0;
                }
                continue;
            }
            match self.mode {
                Mode::Pass if is_unit(speed) => {
                    let buffered = (self.pulled() - self.pos).max(0) as usize;
                    if buffered > 0 {
                        let k = buffered.min(n - w);
                        let s = (self.pos - self.in_start) as usize * CH;
                        out[w * CH..(w + k) * CH].copy_from_slice(&self.inbuf[s..s + k * CH]);
                        self.pos += k as i64;
                        w += k;
                        self.trim(self.pos);
                    } else {
                        // Bit-exact passthrough: straight from the scene into the output.
                        src.pull(&mut out[w * CH..n * CH]);
                        self.pos += (n - w) as i64;
                        self.inbuf.clear();
                        self.in_start = self.pos;
                        w = n;
                    }
                }
                Mode::Pass => {
                    // Leave 1× at `pos`: as if a segment had started a hop earlier, its
                    // windowed second half (the next hop of input) is the first overlap.
                    let p = self.pos;
                    self.ensure(p + HOP as i64, src);
                    self.tail.clear();
                    for i in 0..HOP {
                        let wv = self.window[HOP + i];
                        for c in 0..CH {
                            self.tail.push(wv * self.at(p + i as i64, c));
                        }
                    }
                    self.mode = Mode::Wsola {
                        prev: p - HOP as i64,
                        nominal: (p - HOP as i64) as f64,
                    };
                }
                Mode::Wsola { prev, .. } if is_unit(speed) => {
                    // Back to 1× at the last segment's natural continuation: what the
                    // overlap-add would give there is the input itself.
                    self.pos = prev + HOP as i64;
                    self.tail.clear();
                    self.mode = Mode::Pass;
                    self.trim(self.pos);
                }
                Mode::Wsola { prev, nominal } => self.step(prev, nominal, speed, src),
            }
        }
    }

    /// One WSOLA step: `HOP` output frames into `self.out`.
    fn step(&mut self, prev: i64, nominal: f64, speed: f64, src: &mut dyn Pull) {
        let nominal = nominal + speed * HOP as f64;
        let center = nominal.round() as i64;
        let lo = (center - SEARCH as i64).max(self.in_start);
        let hi = (center + SEARCH as i64).max(lo);
        // The reference: the natural continuation of the last segment (its second half's
        // input), which the new segment's first half overlaps.
        let r0 = prev + HOP as i64;
        self.ensure((hi + WIN as i64).max(r0 + HOP as i64), src);
        for i in 0..HOP {
            self.mono_ref[i] = self.mono(r0 + i as i64);
        }
        let k = self.best_offset(lo, hi, center);
        for i in 0..HOP {
            let wv = self.window[i];
            for c in 0..CH {
                let v = self.tail[i * CH + c] + wv * self.at(k + i as i64, c);
                self.out.push(v);
            }
        }
        for i in 0..HOP {
            let wv = self.window[HOP + i];
            for c in 0..CH {
                self.tail[i * CH + c] = wv * self.at(k + (HOP + i) as i64, c);
            }
        }
        self.mode = Mode::Wsola { prev: k, nominal };
        // Keep what the next step (its search can't go below `nominal − SEARCH`) or a return
        // to 1× (`k + HOP`) may read.
        self.trim((k + HOP as i64).min(nominal.floor() as i64 - SEARCH as i64));
    }

    /// The candidate start in `lo..=hi` whose first hop best matches `mono_ref`.
    fn best_offset(&self, lo: i64, hi: i64, center: i64) -> i64 {
        let ref_energy: f32 = self.mono_ref.iter().map(|x| x * x).sum();
        if ref_energy < 1e-12 {
            return center.clamp(lo, hi);
        }
        let score = |k: i64, step: usize| -> f32 {
            let (mut dot, mut en) = (0.0f32, 0.0f32);
            let mut i = 0;
            while i < HOP {
                let c = self.mono(k + i as i64);
                dot += c * self.mono_ref[i];
                en += c * c;
                i += step;
            }
            dot / (en + 1e-9).sqrt()
        };
        let mut best = (f32::MIN, center.clamp(lo, hi));
        let mut k = lo;
        while k <= hi {
            let s = score(k, DECIM);
            if s > best.0 {
                best = (s, k);
            }
            k += DECIM as i64;
        }
        let coarse = best.1;
        let mut best = (f32::MIN, coarse);
        for k in (coarse - DECIM as i64 + 1).max(lo)..=(coarse + DECIM as i64 - 1).min(hi) {
            let s = score(k, 1);
            if s > best.0 {
                best = (s, k);
            }
        }
        best.1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic, non-periodic signal (the bit-exactness check).
    struct Noise {
        n: u64,
    }

    impl Pull for Noise {
        fn pull(&mut self, out: &mut [f32]) {
            for v in out.iter_mut() {
                self.n = self
                    .n
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                *v = ((self.n >> 40) as f32 / (1u64 << 24) as f32) - 0.5;
            }
        }
    }

    /// A stereo sine at `hz`, amplitude `amp`; counts the frames pulled.
    pub(crate) struct Sine {
        pub phase: f64,
        pub hz: f64,
        pub amp: f32,
        pub pulled: u64,
    }

    impl Pull for Sine {
        fn pull(&mut self, out: &mut [f32]) {
            for fr in out.chunks_exact_mut(CH) {
                let v = self.amp * (self.phase.sin() as f32);
                fr.fill(v);
                self.phase += 2.0 * std::f64::consts::PI * self.hz / 48_000.0;
                self.pulled += 1;
            }
        }
    }

    fn run(
        st: &mut Stretch,
        src: &mut dyn Pull,
        frames: usize,
        speed: f64,
        chunk: usize,
    ) -> Vec<f32> {
        let mut out = Vec::new();
        let mut left = frames;
        while left > 0 {
            let k = chunk.min(left);
            let mut b = vec![0.0; k * CH];
            st.produce(&mut b, speed, src);
            out.extend_from_slice(&b);
            left -= k;
        }
        out
    }

    #[test]
    fn time_stretch_is_bit_exact_at_1x() {
        let mut want = vec![0.0; 9000 * CH];
        Noise { n: 7 }.pull(&mut want);
        let mut st = Stretch::new();
        let mut src = Noise { n: 7 };
        // Odd chunk sizes, like a PipeWire graph whose quantum changes.
        let mut got = Vec::new();
        for (i, k) in [64usize, 256, 1, 1000, 480, 333].iter().cycle().enumerate() {
            if got.len() >= want.len() {
                break;
            }
            let k = (*k).min((want.len() - got.len()) / CH);
            let mut b = vec![0.0; k * CH];
            st.produce(&mut b, 1.0, &mut src);
            got.extend_from_slice(&b);
            assert!(i < 1000);
        }
        assert!(got == want, "1x must be a bit-exact passthrough");
        assert!(st.passthrough());
    }

    /// Zero crossings per second of channel 0 (rising), over `x`.
    fn freq(x: &[f32]) -> f64 {
        let mono: Vec<f32> = x.chunks_exact(CH).map(|f| f[0]).collect();
        let ups: Vec<usize> = (1..mono.len())
            .filter(|&i| mono[i - 1] < 0.0 && mono[i] >= 0.0)
            .collect();
        let (a, b) = (ups[0], *ups.last().unwrap());
        (ups.len() - 1) as f64 * 48_000.0 / (b - a) as f64
    }

    /// Level per 25 ms block: exactly 11 periods of 440 Hz, so a clean tone reads the same in
    /// every block whatever its phase (−9.03 dBFS at amplitude 0.5); a WSOLA join that
    /// cancels (the classic "flutter") shows as a dip.
    fn block_db(x: &[f32]) -> Vec<f32> {
        x.chunks_exact(1200 * CH)
            .map(|b| lp_player::audio::meter::dbfs_block(b, CH))
            .collect()
    }

    /// Owner: a scene's speed scales its audio with the pitch kept. A 440 Hz tone (a period
    /// of 109.09 frames — no hop is a whole number of periods, so the search must align the
    /// joins) stays 440 Hz at 0.5×, 1.5×, 0.73× and the 0.1×/4× ends of the range, its level
    /// stays steady, and the input is consumed at `speed` × the output.
    #[test]
    fn time_stretch_keeps_pitch_level_and_rate() {
        for speed in [0.5, 1.5, 0.73, 0.1, 4.0] {
            let mut st = Stretch::new();
            let mut src = Sine {
                phase: 0.0,
                hz: 440.0,
                amp: 0.5,
                pulled: 0,
            };
            let out = run(&mut st, &mut src, 48_000 * 2, speed, 256);
            let f = freq(&out[48_000 * CH / 2..]);
            let blocks = block_db(&out[4800 * CH..]);
            let (lo, hi) = blocks
                .iter()
                .fold((f32::MAX, f32::MIN), |(a, b), &v| (a.min(v), b.max(v)));
            let rate = src.pulled as f64 / (48_000.0 * 2.0);
            println!(
                "speed {speed}: {f:.2} Hz, 25 ms blocks {lo:.3}..{hi:.3} dBFS, consumed {rate:.4}x"
            );
            assert!(
                (f - 440.0).abs() < 440.0 * 0.002,
                "pitch kept at {speed}x: {f}"
            );
            assert!(
                lo > -9.03 - 0.2 && hi < -9.03 + 0.2,
                "level steady at {speed}x: {lo}..{hi}"
            );
            assert!(
                (rate - speed).abs() < speed * 0.02 + 0.03,
                "consumed {rate} at {speed}x"
            );
        }
    }

    /// Speed changes mid-stream (1 → 1.5 → 0.5 → 1, at awkward points) are continuous: no
    /// sample step larger than the tone's own largest, and 1× is a passthrough again after.
    #[test]
    fn time_stretch_speed_changes_are_continuous() {
        let mut st = Stretch::new();
        let mut src = Sine {
            phase: 0.0,
            hz: 440.0,
            amp: 0.5,
            pulled: 0,
        };
        let mut out = Vec::new();
        for (frames, speed) in [(3001, 1.0), (7777, 1.5), (5003, 0.5), (9000, 1.0)] {
            out.extend(run(&mut st, &mut src, frames, speed, 200));
        }
        let max_step = 0.5 * 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
        let worst = out
            .chunks_exact(CH)
            .map(|f| f[0])
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        println!("largest sample step {worst:.5} (tone's own {max_step:.5})");
        assert!(
            worst < max_step * 1.5,
            "a discontinuity: {worst} vs {max_step}"
        );
        assert!(st.passthrough(), "back to a passthrough at 1x");
        // The level across the joins: every 25 ms block within 0.2 dB of the tone's.
        for (i, db) in block_db(&out).iter().enumerate() {
            assert!((db + 9.03).abs() < 0.2, "block {i}: {db} dBFS");
        }
    }
}
