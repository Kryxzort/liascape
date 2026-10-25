//! The `frames` probe (Task 13): per output, a rolling window of **present intervals** —
//! the time between two consecutive presents — so frame pacing is measured, not guessed.
//!
//! Two windows per output, both the last [`WINDOW`]:
//! - `paced` — intervals between presents made **back to back**: the second present was
//!   drawn on the first one's frame callback without the output going idle in between.
//!   This is the output's own refresh pacing (≈ 6.94 ms at 144 Hz, ≈ 4.17 ms at 240 Hz
//!   while something animates). `missed` counts paced intervals longer than 1.5 refresh
//!   periods — a vblank the output should have presented on and didn't.
//! - `all` — every interval, idle gaps included, plus `fps` (presents per second over the
//!   window): the content-driven rate (a 60 fps video ≈ 60, a static colour ≈ 0).
//!
//! `idle: true` = the output can take a frame (no callback outstanding) but has nothing new
//! to show (redraw policy, `crate::redraw`). `args: {"reset": true}` clears the windows
//! and the `missed` total after reading (like `loop`'s reset). Failed presents (Task 16):
//! `totals.present_failed`, `last_present_error`, and `retry_in_ms` while the backend backs
//! off (`crate::wl::present_backoff`).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::graph::ApiError;
use crate::runtime::Runtime;

/// How far back the windows reach.
pub const WINDOW: Duration = Duration::from_secs(2);
/// Samples kept per window at most (2 s at 1000 Hz).
const MAX_SAMPLES: usize = 2048;
/// A paced interval longer than this many refresh periods is a missed frame.
const MISSED_FACTOR: f64 = 1.5;

/// One window's numbers.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub count: usize,
    pub mean_ms: Option<f64>,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub max_ms: Option<f64>,
    /// Intervals longer than 1.5 refresh periods (meaningful for `paced` only).
    pub missed: usize,
}

/// Present timing of one output.
#[derive(Debug, Clone)]
pub struct FrameStats {
    period_ms: f64,
    last_present: Option<Instant>,
    /// A frame-ready pass found nothing to draw since the last present: the next present
    /// starts a new run (its interval is not a pacing sample).
    idle: bool,
    paced: VecDeque<(Instant, f64)>,
    all: VecDeque<(Instant, f64)>,
    /// When the windows were last reset (for `fps` over a not-yet-full window).
    since: Instant,
    pub presents: u64,
    pub missed_total: u64,
    pub idle_gaps: u64,
    /// Presents that returned an error, and the last error (Task 16, review item c).
    pub present_failed: u64,
    pub last_present_error: Option<String>,
}

impl FrameStats {
    /// Stats for an output refreshing at `refresh_mhz` (0 = unknown → 60 Hz).
    pub fn new(refresh_mhz: u32, now: Instant) -> FrameStats {
        let mut s = FrameStats {
            period_ms: 0.0,
            last_present: None,
            idle: false,
            paced: VecDeque::new(),
            all: VecDeque::new(),
            since: now,
            presents: 0,
            missed_total: 0,
            idle_gaps: 0,
            present_failed: 0,
            last_present_error: None,
        };
        s.set_refresh(refresh_mhz);
        s
    }

    /// The output's refresh changed (mode change).
    pub fn set_refresh(&mut self, refresh_mhz: u32) {
        let mhz = if refresh_mhz == 0 {
            60_000
        } else {
            refresh_mhz
        };
        self.period_ms = 1_000_000.0 / mhz as f64;
    }

    pub fn period_ms(&self) -> f64 {
        self.period_ms
    }

    /// A frame was presented at `at`.
    pub fn on_present(&mut self, at: Instant) {
        if let Some(prev) = self.last_present {
            let ms = at.saturating_duration_since(prev).as_secs_f64() * 1000.0;
            push(&mut self.all, at, ms);
            if self.idle {
                self.idle_gaps += 1;
            } else {
                push(&mut self.paced, at, ms);
                if ms > MISSED_FACTOR * self.period_ms {
                    self.missed_total += 1;
                }
            }
        }
        self.presents += 1;
        self.last_present = Some(at);
        self.idle = false;
        self.prune(at);
    }

    /// A present failed with `error` (the backend backs off; see `frames` `retry_in_ms`).
    pub fn on_present_failed(&mut self, error: &str) {
        self.present_failed += 1;
        self.last_present_error = Some(error.to_string());
    }

    /// The output could take a frame but had nothing new to show.
    pub fn on_idle(&mut self) {
        self.idle = true;
    }

    pub fn is_idle(&self) -> bool {
        self.idle
    }

    pub fn last_present(&self) -> Option<Instant> {
        self.last_present
    }

    /// Clear both windows and the `missed` total (the run in progress continues).
    pub fn reset(&mut self, now: Instant) {
        self.paced.clear();
        self.all.clear();
        self.missed_total = 0;
        self.since = now;
    }

    fn prune(&mut self, now: Instant) {
        for q in [&mut self.paced, &mut self.all] {
            while q
                .front()
                .is_some_and(|(t, _)| now.saturating_duration_since(*t) > WINDOW)
            {
                q.pop_front();
            }
        }
    }

    /// The paced window as of `now`.
    pub fn paced(&self, now: Instant) -> Summary {
        summarize(&self.paced, now, self.period_ms)
    }

    /// The all-intervals window as of `now`.
    pub fn all(&self, now: Instant) -> Summary {
        summarize(&self.all, now, self.period_ms)
    }

    /// Presents per second over the window (or since the last reset, if shorter).
    pub fn fps(&self, now: Instant) -> f64 {
        let span = now.saturating_duration_since(self.since).min(WINDOW);
        let n = self
            .all
            .iter()
            .filter(|(t, _)| now.saturating_duration_since(*t) <= WINDOW)
            .count();
        if span.is_zero() {
            0.0
        } else {
            n as f64 / span.as_secs_f64()
        }
    }
}

fn push(q: &mut VecDeque<(Instant, f64)>, at: Instant, ms: f64) {
    q.push_back((at, ms));
    if q.len() > MAX_SAMPLES {
        q.pop_front();
    }
}

fn summarize(q: &VecDeque<(Instant, f64)>, now: Instant, period_ms: f64) -> Summary {
    let mut v: Vec<f64> = q
        .iter()
        .filter(|(t, _)| now.saturating_duration_since(*t) <= WINDOW)
        .map(|(_, ms)| *ms)
        .collect();
    let missed = v
        .iter()
        .filter(|ms| **ms > MISSED_FACTOR * period_ms)
        .count();
    if v.is_empty() {
        return Summary {
            count: 0,
            mean_ms: None,
            p50_ms: None,
            p95_ms: None,
            max_ms: None,
            missed,
        };
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    // Nearest-rank percentiles.
    let rank = |p: f64| v[((p * n as f64).ceil() as usize).clamp(1, n) - 1];
    Summary {
        count: n,
        mean_ms: Some(v.iter().sum::<f64>() / n as f64),
        p50_ms: Some(rank(0.50)),
        p95_ms: Some(rank(0.95)),
        max_ms: Some(v[n - 1]),
        missed,
    }
}

fn summary_json(s: &Summary) -> Value {
    json!({
        "count": s.count,
        "mean_ms": s.mean_ms,
        "p50_ms": s.p50_ms,
        "p95_ms": s.p95_ms,
        "max_ms": s.max_ms,
        "missed": s.missed,
    })
}

/// `probe {name: "frames", args?: {reset?}}`.
pub fn frames(rt: &mut Runtime, args: &Value) -> Result<Value, ApiError> {
    let now = Instant::now();
    let paced_backend = rt.backend.paced();
    let mut outs = Vec::new();
    for o in rt.backend.outputs() {
        let Some(st) = rt.frames.get(&o.name) else {
            continue;
        };
        let fs = rt.backend.frame_state(&o.name);
        let pending = fs.as_ref().is_some_and(|f| f.pending);
        let ready = fs.as_ref().is_none_or(|f| f.ready);
        let paced = st.paced(now);
        let mut all = summary_json(&st.all(now));
        all["fps"] = json!(st.fps(now));
        outs.push(json!({
            "name": o.name,
            "hz": o.hz,
            "refresh_mhz": o.refresh_mhz,
            "period_ms": st.period_ms(),
            "idle": paced_backend && ready && st.is_idle(),
            "frame_pending": pending,
            "since_present_ms": st.last_present().map(|t| now.saturating_duration_since(t).as_secs_f64() * 1000.0),
            "paced": summary_json(&paced),
            "all": all,
            "totals": {
                "presents": st.presents,
                "callbacks": fs.as_ref().map(|f| f.callbacks),
                "missed": st.missed_total,
                "idle_gaps": st.idle_gaps,
                "present_failed": st.present_failed,
            },
            "last_present_error": st.last_present_error,
            "retry_in_ms": fs.as_ref().and_then(|f| f.retry_in_ms),
        }));
    }
    if args.get("reset").and_then(Value::as_bool) == Some(true) {
        for st in rt.frames.values_mut() {
            st.reset(now);
        }
    }
    // Task 20e: NVIDIA explicit sync for this process and the default-queue drain.
    let default_queue = rt
        .backend
        .as_wayland_mut()
        .map(|w| w.default_queue_dispatched());
    Ok(json!({
        "backend": rt.backend.kind(),
        "policy": if paced_backend { "content" } else { "every_tick" },
        "window_ms": WINDOW.as_secs_f64() * 1000.0,
        "explicit_sync": crate::wl::driver_env_json(),
        "default_queue_dispatched": default_queue,
        "outputs": outs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: f64) -> Duration {
        Duration::from_secs_f64(n / 1000.0)
    }

    /// Present `n` frames `step_ms` apart starting at `t0 + start_ms`; returns the last time.
    fn run(s: &mut FrameStats, t0: Instant, start_ms: f64, step_ms: f64, n: usize) -> Instant {
        let mut t = t0 + ms(start_ms);
        for i in 0..n {
            t = t0 + ms(start_ms + step_ms * i as f64);
            s.on_present(t);
        }
        t
    }

    #[test]
    fn paced_144hz_run_measures_its_period() {
        let t0 = Instant::now();
        let mut s = FrameStats::new(143_981, t0);
        assert!((s.period_ms() - 6.945).abs() < 0.001);
        let end = run(&mut s, t0, 0.0, 6.945, 145);
        let p = s.paced(end);
        assert_eq!(p.count, 144);
        assert!((p.mean_ms.unwrap() - 6.945).abs() < 1e-6);
        assert!((p.p50_ms.unwrap() - 6.945).abs() < 1e-6);
        assert!((p.max_ms.unwrap() - 6.945).abs() < 1e-6);
        assert_eq!(p.missed, 0);
        assert_eq!(s.presents, 145);
    }

    #[test]
    fn a_skipped_vblank_is_missed() {
        let t0 = Instant::now();
        let mut s = FrameStats::new(240_000, t0);
        let mut t = run(&mut s, t0, 0.0, 4.1667, 20);
        t += ms(8.333); // two periods
        s.on_present(t);
        let p = s.paced(t);
        assert_eq!(p.missed, 1);
        assert_eq!(s.missed_total, 1);
        assert!((p.max_ms.unwrap() - 8.333).abs() < 0.01);
        assert!(p.p95_ms.unwrap() < 4.2, "one outlier in 20 stays above p95");
    }

    #[test]
    fn idle_gap_is_not_a_pacing_sample() {
        let t0 = Instant::now();
        let mut s = FrameStats::new(144_000, t0);
        let t = run(&mut s, t0, 0.0, 6.944, 10);
        s.on_idle();
        assert!(s.is_idle());
        let t2 = t + ms(500.0);
        s.on_present(t2); // content changed half a second later
        assert!(!s.is_idle());
        let p = s.paced(t2);
        assert_eq!(p.count, 9, "the 500 ms gap is not paced");
        assert_eq!(p.missed, 0);
        assert_eq!(s.idle_gaps, 1);
        let a = s.all(t2);
        assert_eq!(a.count, 10);
        assert!((a.max_ms.unwrap() - 500.0).abs() < 0.01);
    }

    #[test]
    fn window_rolls_and_reset_clears() {
        let t0 = Instant::now();
        let mut s = FrameStats::new(60_000, t0);
        let t = run(&mut s, t0, 0.0, 16.667, 300); // ~5 s
        let p = s.paced(t);
        assert!(
            p.count <= 121 && p.count >= 119,
            "≈ 2 s of 60 Hz, got {}",
            p.count
        );
        let fps = s.fps(t);
        assert!((fps - 60.0).abs() < 1.0, "fps {fps}");
        s.reset(t);
        assert_eq!(s.paced(t).count, 0);
        assert_eq!(s.paced(t).mean_ms, None);
        assert_eq!(s.missed_total, 0);
        let t2 = run(&mut s, t, 16.667, 16.667, 30);
        assert_eq!(s.paced(t2).count, 30, "the run continues across a reset");
        let fps = s.fps(t2);
        assert!((fps - 60.0).abs() < 3.0, "fps since reset {fps}");
    }

    #[test]
    fn unknown_refresh_is_60hz() {
        let s = FrameStats::new(0, Instant::now());
        assert!((s.period_ms() - 16.667).abs() < 0.001);
    }

    #[test]
    fn percentiles_are_nearest_rank() {
        let t0 = Instant::now();
        let mut s = FrameStats::new(1_000_000, t0); // 1 ms period: nothing counts as missed? no: >1.5 ms
        let mut t = t0;
        s.on_present(t);
        for i in 1..=20 {
            t += ms(i as f64);
            s.on_present(t);
        }
        let p = s.paced(t);
        assert_eq!(p.count, 20);
        assert_eq!(p.p50_ms.map(|v| v.round()), Some(10.0));
        assert_eq!(p.p95_ms.map(|v| v.round()), Some(19.0));
        assert_eq!(p.max_ms.map(|v| v.round()), Some(20.0));
        assert_eq!(p.missed, 19, "every interval above 1.5 ms");
    }
}
