//! Clocks (spec §4.2 "Clock"): the time bases the Animator and the render loop read from.
//!
//! Three clocks, one trait:
//! - [`MonoClock`] — wraps [`Instant`], the real wall-clock-rate clock production code uses.
//! - [`SteppedClock`] — a deterministic clock driven entirely by [`SteppedClock::step`], for
//!   tests that need exact, reproducible timings instead of real elapsed time.
//! - [`OutputClock`] — wraps any [`Clock`] and adds `pause`/`resume`: while paused, `now()`
//!   is frozen, so "pause when covered" (§4.2's Signal → Clock recipe) can stop exactly one
//!   output's time base without touching the base clock or any other output's `OutputClock`.
//!
//! All three are driven from the single-threaded render loop, so interior mutability here is
//! [`Cell`], not a `Mutex` — none of these types are `Send`/`Sync`, and none need to be.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// A time base: `now()` returns elapsed time since some clock-defined zero point.
pub trait Clock {
    fn now(&self) -> Duration;
}

/// Wraps [`Instant`]: real, monotonic, wall-clock-rate time since construction. The
/// production clock — nothing here is deterministic, so it carries no tests of its own
/// beyond "it compiles and never goes backwards".
pub struct MonoClock {
    start: Instant,
}

impl MonoClock {
    pub fn new() -> Self {
        MonoClock {
            start: Instant::now(),
        }
    }
}

impl Default for MonoClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonoClock {
    fn now(&self) -> Duration {
        self.start.elapsed()
    }
}

/// A deterministic clock for tests: `now()` only ever changes when [`step`](Self::step) is
/// called, so a test can assert exact timings instead of racing real time.
pub struct SteppedClock {
    now: Cell<Duration>,
}

impl SteppedClock {
    pub fn new() -> Self {
        SteppedClock {
            now: Cell::new(Duration::ZERO),
        }
    }

    /// Advances this clock's `now()` by `d`.
    pub fn step(&self, d: Duration) {
        self.now.set(self.now.get() + d);
    }
}

impl Default for SteppedClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SteppedClock {
    fn now(&self) -> Duration {
        self.now.get()
    }
}

/// Wraps a base [`Clock`] with `pause`/`resume`. While paused, `now()` is frozen at the
/// value it had the instant `pause()` was called, no matter how far the base clock
/// advances; `resume()` folds the paused interval into a running offset so `now()` picks
/// up exactly where it left off instead of jumping forward by the paused duration.
///
/// This is the per-output clock: "pause when covered" (§4.2) pauses one output's
/// `OutputClock` and nothing else — the base clock (and every other output's
/// `OutputClock` sharing it) keeps running untouched.
pub struct OutputClock {
    base: Rc<dyn Clock>,
    /// Total time excised so far across every completed pause/resume cycle.
    offset: Cell<Duration>,
    /// `Some(base_time_at_pause)` while paused; `None` while running.
    paused_at: Cell<Option<Duration>>,
}

impl OutputClock {
    pub fn new(base: Rc<dyn Clock>) -> Self {
        OutputClock {
            base,
            offset: Cell::new(Duration::ZERO),
            paused_at: Cell::new(None),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.paused_at.get().is_some()
    }

    /// Freezes `now()` at its current value. A no-op if already paused.
    pub fn pause(&self) {
        if self.paused_at.get().is_none() {
            self.paused_at.set(Some(self.base.now()));
        }
    }

    /// Unfreezes `now()`, excising the time spent paused. A no-op if not paused.
    pub fn resume(&self) {
        if let Some(paused_base) = self.paused_at.take() {
            let elapsed_while_paused = self.base.now().saturating_sub(paused_base);
            self.offset.set(self.offset.get() + elapsed_while_paused);
        }
    }

    pub fn now(&self) -> Duration {
        let base_now = match self.paused_at.get() {
            Some(paused_base) => paused_base,
            None => self.base.now(),
        };
        base_now.saturating_sub(self.offset.get())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stepped_clock() {
        let c = SteppedClock::new();
        c.step(Duration::from_millis(16));
        c.step(Duration::from_millis(16));
        c.step(Duration::from_millis(16));
        assert_eq!(c.now(), Duration::from_millis(48));
    }

    #[test]
    fn output_clock_pause() {
        let base = Rc::new(SteppedClock::new());
        base.step(Duration::from_millis(100));

        let out = OutputClock::new(base.clone() as Rc<dyn Clock>);
        assert_eq!(out.now(), Duration::from_millis(100));

        out.pause();
        assert!(out.is_paused());
        base.step(Duration::from_millis(50));
        assert_eq!(
            out.now(),
            Duration::from_millis(100),
            "now() must stay frozen while paused even though the base clock advanced"
        );

        out.resume();
        assert!(!out.is_paused());
        base.step(Duration::from_millis(10));
        assert_eq!(
            out.now(),
            Duration::from_millis(110),
            "resume must excise the paused interval, not just unfreeze"
        );
    }

    #[test]
    fn output_clock_pause_is_idempotent() {
        // Calling pause()/resume() when already in that state must not double-count the
        // offset (a real caller might pause twice if two signals fire, e.g. "covered" and
        // "fullscreen" both triggering the same output).
        let base = Rc::new(SteppedClock::new());
        let out = OutputClock::new(base.clone() as Rc<dyn Clock>);

        out.resume(); // not paused yet: no-op
        assert_eq!(out.now(), Duration::ZERO);

        out.pause();
        base.step(Duration::from_millis(20));
        out.pause(); // already paused: no-op, must not re-sample base.now()
        base.step(Duration::from_millis(30));
        assert_eq!(out.now(), Duration::ZERO);

        out.resume();
        assert_eq!(out.now(), Duration::ZERO);
        base.step(Duration::from_millis(5));
        assert_eq!(out.now(), Duration::from_millis(5));
    }

    #[test]
    fn mono_clock_never_goes_backwards() {
        let c = MonoClock::new();
        let t1 = c.now();
        std::thread::sleep(Duration::from_millis(1));
        let t2 = c.now();
        assert!(t2 >= t1);
    }
}
