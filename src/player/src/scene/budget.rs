//! The worker GPU budget (Phase 2 Task 8; owner decision "GPU budget = a setting, default
//! auto-throttle"): when the outputs showing a scene miss compositor frames **and** the
//! scene's own worker is busy enough on the GPU to be the cause, that scene's frame rate is
//! lowered stepwise; once the outputs present cleanly again it is raised back to what they
//! ask for. Pure (the caller passes `now` and the measurements; `SceneSource::observe_budget`
//! feeds it every [`OBSERVE_EVERY`] from the runtime).
//!
//! The rule (plan Task 8, "Interfaces"):
//! - **throttle** when the showing outputs missed more than [`THROTTLE_MISSED_PCT`] of their
//!   frames over the last 2 s (the `frames` probe's window) **and** the worker's GPU time per
//!   second of scene — `gpu_ms_p50 × fps_actual` — is at least [`GPU_LOAD_MS_PER_S`] (a worker
//!   using < 40 % of the GPU can't be what starves the compositor: a light scene is never
//!   throttled for misses something else caused): cap = `max(FLOOR_FPS, fps_actual / 2)`.
//!   After any change the next decrease waits [`SETTLE`] (the 2 s miss window must hold
//!   only frames made at the new rate before it can say the new rate is still too high).
//! - **recover** after [`RECOVER_AFTER`] in a row below [`RECOVER_MISSED_PCT`] missed: cap ×
//!   [`STEP_UP`], each further step after another calm [`RECOVER_AFTER`]; reaching the demand
//!   lifts the cap (unthrottled).
//! - The cap never raises the rate above the demand and never lowers it below
//!   [`FLOOR_FPS`] (a demand below the floor is never touched).

use std::time::Duration;

/// How often the runtime feeds every scene's budget.
pub const OBSERVE_EVERY: Duration = Duration::from_millis(500);
/// Missed frames (percent of the showing outputs' paced presents over 2 s) above which a
/// GPU-heavy scene is throttled.
pub const THROTTLE_MISSED_PCT: f64 = 2.0;
/// Missed frames below which the outputs count as presenting cleanly (recovery).
pub const RECOVER_MISSED_PCT: f64 = 0.5;
/// The worker's GPU time per second (`gpu_ms_p50 × fps_actual`, ms/s) at or above which it
/// can be the cause of missed frames (40 % of the GPU).
pub const GPU_LOAD_MS_PER_S: f64 = 400.0;
/// The lowest rate the budget ever caps a scene to.
pub const FLOOR_FPS: f64 = 10.0;
/// Calm time before each step back up.
pub const RECOVER_AFTER: Duration = Duration::from_secs(5);
/// Each recovery step multiplies the cap by this.
pub const STEP_UP: f64 = 1.25;
/// After a change, no further decrease for this long (the miss window's length).
pub const SETTLE: Duration = Duration::from_secs(2);

/// One scene's budget: the rate its outputs ask for (`demand`) and the cap the GPU budget
/// put on it (`None` = unthrottled).
#[derive(Debug, Clone, PartialEq)]
pub struct Budget {
    demand: f64,
    cap: Option<f64>,
    /// Since when the outputs present cleanly (< `RECOVER_MISSED_PCT`), while capped.
    calm_since: Option<Duration>,
    /// The last change (throttle or step).
    changed_at: Option<Duration>,
}

impl Budget {
    pub fn new(demand: f64) -> Budget {
        Budget {
            demand,
            cap: None,
            calm_since: None,
            changed_at: None,
        }
    }

    /// The outputs ask for another rate. A cap at or above it is lifted (`true` = it was).
    pub fn set_demand(&mut self, demand: f64) -> bool {
        self.demand = demand;
        if self.cap.is_some_and(|c| c >= demand - 1e-9) {
            self.lift();
            return true;
        }
        false
    }

    pub fn demand(&self) -> f64 {
        self.demand
    }

    /// The cap (`None` = unthrottled).
    pub fn cap(&self) -> Option<f64> {
        self.cap
    }

    /// The rate the scene ticks at: `min(demand, cap)`.
    pub fn rate(&self) -> f64 {
        self.cap.map_or(self.demand, |c| c.min(self.demand))
    }

    /// Drop the cap (the setting turned the budget off, or the demand fell under it).
    pub fn lift(&mut self) {
        self.cap = None;
        self.calm_since = None;
        self.changed_at = None;
    }

    /// One observation at `now`: the showing outputs' `missed_pct` over the last 2 s, the
    /// worker's median GPU time per frame and the frames latched per second. Returns the new
    /// rate when it changed (equal to the demand = unthrottled again).
    pub fn observe(
        &mut self,
        now: Duration,
        missed_pct: f64,
        gpu_ms_p50: f64,
        fps_actual: f64,
    ) -> Option<f64> {
        let heavy = gpu_ms_p50 * fps_actual >= GPU_LOAD_MS_PER_S;
        if missed_pct > THROTTLE_MISSED_PCT && heavy {
            self.calm_since = None;
            let settled = self.changed_at.is_none_or(|t| now >= t + SETTLE);
            let to = (fps_actual / 2.0).max(FLOOR_FPS);
            if settled && to < self.rate() - 1e-9 {
                self.cap = Some(to);
                self.changed_at = Some(now);
                return Some(to);
            }
            return None;
        }
        let Some(cap) = self.cap else {
            return None;
        };
        if missed_pct >= RECOVER_MISSED_PCT {
            self.calm_since = None;
            return None;
        }
        let since = *self.calm_since.get_or_insert(now);
        if now < since + RECOVER_AFTER {
            return None;
        }
        let to = cap * STEP_UP;
        self.calm_since = Some(now);
        self.changed_at = Some(now);
        if to >= self.demand - 1e-9 {
            self.cap = None;
            Some(self.demand)
        } else {
            self.cap = Some(to);
            Some(to)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    /// Starved at 60 fps with a worker using 60 % of the GPU (10 ms × 60): halved to 30, then
    /// (still starving once the window settled) to 15; after 5 s clean, × 1.25 per calm 5 s
    /// back up to the demand, which lifts the cap.
    #[test]
    fn budget_halves_under_starvation_and_recovers() {
        let mut b = Budget::new(60.0);
        assert_eq!(b.observe(s(0), 0.0, 10.0, 60.0), None, "clean: nothing");
        assert_eq!(b.observe(s(500), 5.0, 10.0, 60.0), Some(30.0));
        assert_eq!(b.rate(), 30.0);
        assert_eq!(b.cap(), Some(30.0));
        // The 2 s miss window still holds 60 fps frames: no second cut yet.
        assert_eq!(b.observe(s(1000), 5.0, 14.0, 30.0), None);
        assert_eq!(b.observe(s(2000), 5.0, 14.0, 30.0), None);
        assert_eq!(b.observe(s(2500), 5.0, 14.0, 30.0), Some(15.0), "settled: halve again");
        // Misses between the thresholds: neither cut (not > 2 %) nor calm (not < 0.5 %).
        assert_eq!(b.observe(s(5000), 1.0, 14.0, 15.0), None);
        // Clean from 6 s: the first step at 11 s.
        let mut t = 6000;
        let mut steps = Vec::new();
        while t <= 60_000 {
            if let Some(r) = b.observe(s(t), 0.0, 14.0, b.rate()) {
                steps.push((t, r));
            }
            t += 500;
        }
        assert_eq!(steps[0], (11_000, 18.75), "{steps:?}");
        assert_eq!(steps[1], (16_000, 23.4375), "one step per calm 5 s: {steps:?}");
        assert_eq!(steps[2], (21_000, 29.296875), "{steps:?}");
        assert_eq!(steps[3], (26_000, 36.62109375), "{steps:?}");
        assert_eq!(steps.last().unwrap().1, 60.0, "back at the demand: {steps:?}");
        assert_eq!(b.cap(), None, "unthrottled");
        assert_eq!(b.rate(), 60.0);
    }

    /// A worker using 10 % of the GPU (5 ms × 20 fps = 100 ms/s) never throttles, whatever the
    /// outputs miss: something else starves them.
    #[test]
    fn budget_ignores_misses_a_light_worker_cannot_cause() {
        let mut b = Budget::new(30.0);
        for i in 0..200 {
            assert_eq!(b.observe(s(i * 500), 50.0, 5.0, 20.0), None);
        }
        assert_eq!(b.cap(), None);
        // Just under the load line (399 ms/s) still never; at it, it does.
        assert_eq!(b.observe(s(200_000), 50.0, 13.3, 30.0), None);
        assert_eq!(b.observe(s(200_500), 50.0, 400.0 / 30.0, 30.0), Some(15.0));
    }

    /// The cap never goes below 10 fps, and a demand below the floor is never touched.
    #[test]
    fn budget_floor_is_10() {
        let mut b = Budget::new(30.0);
        assert_eq!(b.observe(s(0), 10.0, 50.0, 12.0), Some(10.0), "12/2 → the floor");
        for i in 1..20 {
            assert_eq!(b.observe(s(i * 3000), 10.0, 50.0, 10.0), None, "never below 10");
        }
        assert_eq!(b.rate(), 10.0);
        let mut low = Budget::new(8.0);
        assert_eq!(low.observe(s(0), 50.0, 100.0, 8.0), None, "8 fps demand: untouched");
        assert_eq!(low.rate(), 8.0);
    }

    /// A demand change at or below the cap lifts it; a higher demand keeps it.
    #[test]
    fn budget_demand_change_lifts_a_cap_it_meets() {
        let mut b = Budget::new(60.0);
        assert_eq!(b.observe(s(0), 5.0, 10.0, 60.0), Some(30.0));
        assert!(!b.set_demand(144.0), "a higher demand keeps the cap");
        assert_eq!(b.rate(), 30.0);
        assert!(b.set_demand(24.0), "a demand under the cap lifts it");
        assert_eq!(b.cap(), None);
        assert_eq!(b.rate(), 24.0);
    }
}
