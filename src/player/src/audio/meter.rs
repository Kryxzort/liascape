//! The bus meter (spec §5.3: "the probes tap the bus monitor: the real, server-side mix of
//! exactly the player's audio and nothing else"; Task 14). A PipeWire capture stream on the
//! `lp-player-bus` monitor (48 kHz F32, stereo, a 10 ms quantum requested via
//! `node.latency = 480/48000`) turns every 1 ms of the bus mix into one dBFS value and keeps
//! the last 4 minutes of them in a ring of `(t_mono, dbfs_1ms)`.
//!
//! - **`dbfs_1ms` = max-channel RMS:** each channel's RMS over the 48 frames of one
//!   millisecond, the loudest channel wins, `20·log10(rms)` floored at
//!   [`SILENT_DB`](crate::units::SILENT_DB) (−96). Not a mono sum: summing cancels
//!   anti-phase content and reads a one-sided channel 6 dB low, which a dropout detector
//!   would take for a dip. A full-scale sine reads −3.01 dBFS (RMS = peak − 3 dB).
//! - **`t_mono`** is on the player's monotonic clock — the same base as every event's
//!   `t_mono_ms` (`log::mono_start`), so Task 15 can line meter samples up against
//!   transition events. A block's time = its graph cycle's start (`pw_time.now`,
//!   CLOCK_MONOTONIC) + its first frame's offset in that buffer; a block spanning two buffers
//!   is stamped at its first frame.
//! - The capture's `process` callback runs on the bus's own `lp-bus` thread
//!   (`main_loop.iterate()`) — not a separate RT data thread, since nothing here sets
//!   `RT_PROCESS` (see `bus.rs`'s module doc) — and never blocks: blocks go to a
//!   callback-local staging buffer, moved into the ring under a `try_lock` (a reader copying
//!   a window just delays them to the next cycle).
//!
//! [`Meter::available`] is false when the bus is down, the stream isn't streaming, or the
//! newest sample is more than [`STALE`] old — consumers (the dropout detector) must report
//! themselves unavailable then, never pass silently.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::units::SILENT_DB;

/// Frames per meter block at the bus rate (1 ms at 48 kHz).
pub const BLOCK_FRAMES: usize = 48;
/// How much history the ring keeps.
pub const RING_SPAN: Duration = Duration::from_secs(240);
/// Ring capacity: one entry per millisecond of [`RING_SPAN`].
pub const RING_LEN: usize = 240_000;
/// A meter whose newest sample is older than this is not [`Meter::available`].
pub const STALE: Duration = Duration::from_millis(500);
/// Staging capacity in the RT callback (blocks) — 10 s of backlog before anything is lost.
const STAGING_LEN: usize = 10_000;

/// Max-channel RMS of one block in dBFS: `sum_sq[c]` = Σ x² of channel `c` over `frames`.
pub fn block_dbfs(sum_sq: &[f64], frames: usize) -> f64 {
    if frames == 0 {
        return SILENT_DB;
    }
    let ms = sum_sq.iter().copied().fold(0.0, f64::max) / frames as f64;
    if ms <= 0.0 {
        return SILENT_DB;
    }
    (10.0 * ms.log10()).max(SILENT_DB)
}

/// Splits an interleaved stream into 1 ms blocks (pure; unit-tested without PipeWire).
#[derive(Debug, Clone)]
pub struct BlockMeter {
    channels: usize,
    rate: u32,
    block: usize,
    sum_sq: Vec<f64>,
    n: usize,
    /// ns time of the current partial block's first frame.
    t0: i64,
}

impl BlockMeter {
    pub fn new(rate: u32, channels: u32) -> BlockMeter {
        let channels = channels.max(1) as usize;
        BlockMeter {
            channels,
            rate: rate.max(1),
            block: (rate as usize / 1000).max(1),
            sum_sq: vec![0.0; channels],
            n: 0,
            t0: 0,
        }
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// Feed interleaved `samples` whose first frame plays at `t_ns`; every block completed
    /// is pushed to `out` as `(ns of its first frame, dbfs)`. A trailing partial block is
    /// carried into the next call (stamped at its own first frame).
    pub fn feed(&mut self, samples: &[f32], t_ns: i64, out: &mut Vec<(i64, f32)>) {
        let ns_per_frame = 1e9 / self.rate as f64;
        for (i, frame) in samples.chunks_exact(self.channels).enumerate() {
            if self.n == 0 {
                self.t0 = t_ns + (i as f64 * ns_per_frame) as i64;
            }
            for (acc, &x) in self.sum_sq.iter_mut().zip(frame) {
                *acc += (x as f64) * (x as f64);
            }
            self.n += 1;
            if self.n == self.block {
                out.push((self.t0, block_dbfs(&self.sum_sq, self.n) as f32));
                self.sum_sq.iter_mut().for_each(|s| *s = 0.0);
                self.n = 0;
            }
        }
    }
}

/// The 4-minute history: `(t_ms on the log clock, dbfs)`, oldest first.
#[derive(Debug)]
pub struct Ring {
    buf: VecDeque<(f64, f32)>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring {
            buf: VecDeque::with_capacity(cap.min(RING_LEN)),
            cap: cap.max(1),
        }
    }

    pub fn push(&mut self, t_ms: f64, db: f32) {
        if self.buf.len() == self.cap {
            self.buf.pop_front();
        }
        self.buf.push_back((t_ms, db));
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn last(&self) -> Option<(f64, f32)> {
        self.buf.back().copied()
    }

    /// Every sample with `from_ms <= t <= to_ms`, oldest first.
    pub fn window(&self, from_ms: f64, to_ms: f64) -> Vec<(f64, f32)> {
        let start = self.buf.partition_point(|(t, _)| *t < from_ms);
        self.buf
            .range(start..)
            .take_while(|(t, _)| *t <= to_ms)
            .copied()
            .collect()
    }
}

/// State shared by the RT capture callback (writer) and [`Meter`] (readers).
pub(crate) struct MeterShared {
    pub ring: Mutex<Ring>,
    /// The capture stream is in `Streaming`.
    pub streaming: AtomicBool,
    /// Why the meter can't run (stream error, bus down), if it can't.
    pub error: Mutex<Option<String>>,
    /// CLOCK_MONOTONIC ns at the log clock's zero (`log::mono_start`).
    pub base_ns: i64,
    /// Blocks dropped because the staging buffer overflowed (never expected).
    pub dropped: AtomicU64,
    /// Frames in the last captured buffer (the graph quantum the meter runs at).
    pub last_frames: AtomicU64,
}

impl MeterShared {
    pub fn new() -> MeterShared {
        let base_ns = match crate::log::mono_now() {
            Some(since) => mono_ns() - since.as_nanos() as i64,
            None => mono_ns(),
        };
        MeterShared {
            ring: Mutex::new(Ring::new(RING_LEN)),
            streaming: AtomicBool::new(false),
            error: Mutex::new(None),
            base_ns,
            dropped: AtomicU64::new(0),
            last_frames: AtomicU64::new(0),
        }
    }

    pub fn set_error(&self, e: impl Into<String>) {
        if let Ok(mut g) = self.error.lock() {
            *g = Some(e.into());
        }
    }
}

/// CLOCK_MONOTONIC in ns (what `Instant` and PipeWire's `pw_time.now` both use on Linux).
pub fn mono_ns() -> i64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec * 1_000_000_000 + ts.tv_nsec
}

/// The RT side: one per capture stream (the stream listener's user data).
pub(crate) struct MeterRt {
    pub shared: Arc<MeterShared>,
    pub blocks: BlockMeter,
    staging: Vec<(i64, f32)>,
}

impl MeterRt {
    pub fn new(shared: Arc<MeterShared>, rate: u32, channels: u32) -> MeterRt {
        MeterRt {
            shared,
            blocks: BlockMeter::new(rate, channels),
            staging: Vec::with_capacity(STAGING_LEN),
        }
    }

    /// One captured buffer (`t_ns` = its first frame). RT-safe: no allocation while the
    /// staging buffer has room, never blocks on the ring.
    pub fn process(&mut self, samples: &[f32], t_ns: i64) {
        let frames = samples.len() / self.blocks.channels();
        self.shared
            .last_frames
            .store(frames as u64, Ordering::Relaxed);
        let before = self.staging.len();
        if before + frames / BLOCK_FRAMES + 2 > STAGING_LEN {
            // The ring has been locked for ~10 s straight: drop the oldest backlog.
            let n = self.staging.len();
            self.staging.clear();
            self.shared.dropped.fetch_add(n as u64, Ordering::Relaxed);
        }
        self.blocks.feed(samples, t_ns, &mut self.staging);
        if let Ok(mut ring) = self.shared.ring.try_lock() {
            let base = self.shared.base_ns;
            for (t, db) in self.staging.drain(..) {
                ring.push((t - base) as f64 / 1e6, db);
            }
        }
    }
}

/// A running meter on the bus monitor ([`Meter::start`]).
pub struct Meter {
    pub(crate) shared: Arc<MeterShared>,
    /// Stops the capture stream when the meter goes.
    pub(crate) stop: Option<Box<dyn FnOnce() + Send>>,
}

/// What the `bus` probe reports about the meter.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeterStatus {
    pub available: bool,
    pub streaming: bool,
    pub samples: usize,
    pub last_ms: Option<f64>,
    pub quantum_frames: u64,
    pub dropped: u64,
    pub error: Option<String>,
}

impl Meter {
    /// Start metering `bus`'s monitor (the capture stream lives on the bus's PipeWire
    /// thread). Samples arrive within a few cycles; until then `available()` is false.
    pub fn start(bus: &super::Bus) -> Meter {
        let shared = Arc::new(MeterShared::new());
        let stop = bus.start_meter(shared.clone());
        Meter { shared, stop }
    }

    /// Every `(t_mono, dbfs_1ms)` with `from <= t_mono <= to`, oldest first.
    pub fn window(&self, from: Duration, to: Duration) -> Vec<(Duration, f64)> {
        let ring = self.shared.ring.lock().unwrap_or_else(|e| e.into_inner());
        ring.window(from.as_secs_f64() * 1000.0, to.as_secs_f64() * 1000.0)
            .into_iter()
            .map(|(t, db)| (Duration::from_secs_f64(t.max(0.0) / 1000.0), db as f64))
            .collect()
    }

    /// Streaming, and the newest sample is fresh (≤ [`STALE`] old).
    pub fn available(&self) -> bool {
        self.status().available
    }

    pub fn status(&self) -> MeterStatus {
        let streaming = self.shared.streaming.load(Ordering::Relaxed);
        let (samples, last) = {
            let ring = self.shared.ring.lock().unwrap_or_else(|e| e.into_inner());
            (ring.len(), ring.last().map(|(t, _)| t))
        };
        let error = self.shared.error.lock().ok().and_then(|e| e.clone());
        let now_ms = (mono_ns() - self.shared.base_ns) as f64 / 1e6;
        let fresh = last.is_some_and(|t| now_ms - t <= STALE.as_secs_f64() * 1000.0);
        MeterStatus {
            available: streaming && fresh && error.is_none(),
            streaming,
            samples,
            last_ms: last,
            quantum_frames: self.shared.last_frames.load(Ordering::Relaxed),
            dropped: self.shared.dropped.load(Ordering::Relaxed),
            error,
        }
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f64, peak: f64, frames: usize, ch: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(frames * ch);
        for i in 0..frames {
            let x = peak * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin();
            for _ in 0..ch {
                v.push(x as f32);
            }
        }
        v
    }

    #[test]
    fn sine_rms_is_peak_minus_3db() {
        let mut m = BlockMeter::new(48_000, 2);
        let mut out = Vec::new();
        // 1 kHz: exactly 48 frames per period, so every 1 ms block holds one full period.
        m.feed(&sine(48_000, 1000.0, 0.1, 4800, 2), 0, &mut out);
        assert_eq!(out.len(), 100);
        for (_, db) in &out {
            assert!((*db as f64 - (-23.0103)).abs() < 0.01, "{db}");
        }
    }

    #[test]
    fn silence_floors_at_minus_96() {
        let mut m = BlockMeter::new(48_000, 2);
        let mut out = Vec::new();
        m.feed(&vec![0.0; 480 * 2], 0, &mut out);
        assert_eq!(out.len(), 10);
        assert!(out.iter().all(|(_, db)| *db as f64 == SILENT_DB));
        assert_eq!(block_dbfs(&[1e-12, 0.0], 48), SILENT_DB);
    }

    #[test]
    fn max_channel_not_mono_sum() {
        // Anti-phase L/R: a mono sum would cancel to silence.
        let mut v = sine(48_000, 1000.0, 0.5, 480, 2);
        for f in v.chunks_exact_mut(2) {
            f[1] = -f[0];
        }
        let mut m = BlockMeter::new(48_000, 2);
        let mut out = Vec::new();
        m.feed(&v, 0, &mut out);
        assert!(out.iter().all(|(_, db)| (*db as f64 + 9.03).abs() < 0.01));
        // Left only: reads the left channel's level, not 6 dB below it.
        let mut v = sine(48_000, 1000.0, 0.5, 480, 2);
        for f in v.chunks_exact_mut(2) {
            f[1] = 0.0;
        }
        let mut out = Vec::new();
        BlockMeter::new(48_000, 2).feed(&v, 0, &mut out);
        assert!(out.iter().all(|(_, db)| (*db as f64 + 9.03).abs() < 0.01));
    }

    #[test]
    fn blocks_carry_across_buffers_with_first_frame_times() {
        let mut m = BlockMeter::new(48_000, 2);
        let mut out = Vec::new();
        // 70 frames at t=0 → one block (t=0) + 22 carried; 26 more at t=70 frames → block 2
        // stamped at frame 48 (= 1 ms).
        m.feed(&vec![0.1; 70 * 2], 0, &mut out);
        assert_eq!(out.len(), 1);
        let t70 = (70.0 * 1e9 / 48_000.0) as i64;
        m.feed(&vec![0.1; 26 * 2], t70, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, 0);
        assert_eq!(out[1].0, 1_000_000);
    }

    #[test]
    fn ring_keeps_newest_and_windows_inclusive() {
        let mut r = Ring::new(5);
        for i in 0..8 {
            r.push(i as f64, -(i as f32));
        }
        assert_eq!(r.len(), 5);
        assert_eq!(r.window(0.0, 100.0).first().unwrap().0, 3.0);
        let w = r.window(4.0, 6.0);
        assert_eq!(
            w.iter().map(|x| x.0).collect::<Vec<_>>(),
            vec![4.0, 5.0, 6.0]
        );
        assert!(r.window(8.5, 9.0).is_empty());
        assert_eq!(r.last(), Some((7.0, -7.0)));
    }

    #[test]
    fn rt_process_lands_in_ring_on_the_log_clock() {
        let shared = Arc::new(MeterShared::new());
        let mut rt = MeterRt::new(shared.clone(), 48_000, 2);
        let t = shared.base_ns + 5_000_000; // 5 ms after the clock's zero
        rt.process(&vec![0.0; 480 * 2], t);
        let ring = shared.ring.lock().unwrap();
        assert_eq!(ring.len(), 10);
        let w = ring.window(0.0, 1e9);
        assert!(
            (w[0].0 - 5.0).abs() < 1e-9 && (w[9].0 - 14.0).abs() < 1e-9,
            "{w:?}"
        );
        assert_eq!(shared.last_frames.load(Ordering::Relaxed), 480);
    }
}
