//! The Animator (spec §4.2 "Animator", §4.3 recipes): moves any addressable parameter —
//! effect progress, opacity, a gain slot, a transform — over time along a [`Curve`]. Every
//! transition recipe in §4.3 is built on this: "animate `effect.progress` 0→1 and the
//! equal-power gain pair over the duration" is two or three [`Animation`]s added here, not
//! feature-specific code.
//!
//! **Animation value** = `from + (to - from) * curve.eval(progress)`, where `progress =
//! (now - start) / duration`, clamped to `[0, 1]` (a zero `duration` means `progress` is
//! `1` immediately — a one-shot "jump to value" animation that completes on its first
//! tick at or after `start`). For [`AnimUnit::GainLinear`], that interpolated value is a
//! **linear** amplitude and the value actually emitted (by [`Animator::tick`] and
//! [`Animator::value_at`]) is [`lin_to_db`] of it — so a `GainLinear` animation from `0` to
//! `1` emits [`crate::units::SILENT_DB`] at its own start, not part-way through a ramp from
//! silence.
//!
//! **Before `start`, an animation emits nothing** from [`Animator::tick`] — it simply
//! hasn't begun. [`Animator::value_at`] is the one exception used by the dropout probe: it
//! answers "what would this path be showing at time `t`", so it returns `None` only when no
//! eligible animation on that path has started by `t`; once started, it returns the value
//! that animation would emit at `t`, including after it has finished (its final value,
//! held, until the animation is cancelled or superseded by a more recently added one on the
//! same path).
//!
//! **One final value, exactly once.** `tick(now)` emits an animation's exact final value
//! the first time `now >= start + duration`, reports it via [`Animator::finished`], and
//! never emits that animation again.
//!
//! **Last-added wins.** Two (or more) animations can target the same [`PropPath`]
//! simultaneously if a caller `add()`s a second one without first `cancel_target`-ing the
//! first (e.g. a new transition starting while the previous one's tail is still animating
//! the same gain slot). `tick` emits **at most one value per target per tick** — the most
//! recently added ([`AnimId`] is a strictly increasing counter, so "most recently added" ==
//! "highest id") among that target's animations that haven't yet had their one final
//! emission. An older, shadowed animation on the same target is simply not evaluated or
//! advanced while shadowed; it still exists (and `value_at` still sees it, ranked behind
//! the newer one) until it is explicitly cancelled, or `cancel_target` clears the whole
//! target.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::log::CorrId;
use crate::units::{equal_power, lin_to_db};

/// Addresses one animatable property, e.g. `"src7.gain.xfade"`, `"fx2.progress"`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PropPath(pub String);

/// An easing curve mapping clamped progress `x` in `[0, 1]` to a shaped value, also in
/// `[0, 1]` for every curve here. `eval` clamps `x` first, so a caller passing a
/// slightly-out-of-range progress (e.g. floating-point drift past the end) never drives a
/// curve outside the domain it was designed for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Curve {
    /// `x`.
    Linear,
    /// `x^2 * (3 - 2x)` — zero slope at both ends.
    Smoothstep,
    /// `cos(x * pi/2)` — equal-power crossfade "outgoing" side (reuses
    /// [`units::equal_power`](crate::units::equal_power)'s `.0`).
    EqualPowerOut,
    /// `sin(x * pi/2)` — equal-power crossfade "incoming" side (reuses
    /// [`units::equal_power`](crate::units::equal_power)'s `.1`).
    EqualPowerIn,
    /// `0` for `x < 1`, `1` at `x >= 1` — an instantaneous switch at the animation's end.
    Step,
}

impl Curve {
    pub fn eval(&self, x: f64) -> f64 {
        let x = x.clamp(0.0, 1.0);
        match self {
            Curve::Linear => x,
            Curve::Smoothstep => x * x * (3.0 - 2.0 * x),
            Curve::EqualPowerOut => equal_power(x).0,
            Curve::EqualPowerIn => equal_power(x).1,
            Curve::Step => {
                if x >= 1.0 {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}

/// What unit an animation's interpolated `from..to` value is in, and so how it must be
/// converted before being emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AnimUnit {
    /// Emitted as-is: the interpolated value is the value.
    Scalar,
    /// The interpolated value is a **linear** amplitude; the emitted value is
    /// [`lin_to_db`] of it. `from`/`to` are therefore linear gains (e.g. `0.0` = silent,
    /// `1.0` = unity), not dB.
    GainLinear,
}

/// One animation: moves `target` from `from` to `to` along `curve`, starting at `start`
/// and running for `duration` on whatever [`Clock`](crate::clock::Clock) the caller reads
/// `now` from. `corr` ties every event this animation produces back to the operation that
/// created it (a transition, a settings change).
#[derive(Debug, Clone)]
pub struct Animation {
    pub target: PropPath,
    pub from: f64,
    pub to: f64,
    pub start: Duration,
    pub duration: Duration,
    pub curve: Curve,
    pub unit: AnimUnit,
    pub corr: Option<CorrId>,
}

impl Animation {
    /// `progress` at `now`, clamped to `[0, 1]`. A zero `duration` is `1.0` as soon as
    /// `now >= start` (handled by the caller checking `start` first).
    fn progress(&self, now: Duration) -> f64 {
        if self.duration.is_zero() {
            1.0
        } else {
            let elapsed = now.saturating_sub(self.start);
            (elapsed.as_secs_f64() / self.duration.as_secs_f64()).clamp(0.0, 1.0)
        }
    }

    /// The raw interpolated value at `now` — in `unit`'s own space (linear for
    /// `GainLinear`, final units already for `Scalar`), before the `GainLinear` → dB
    /// conversion.
    fn raw_value(&self, now: Duration) -> f64 {
        let p = self.progress(now);
        let c = self.curve.eval(p);
        self.from + (self.to - self.from) * c
    }

    /// The value this animation emits at `now` (post dB-conversion for `GainLinear`).
    /// Does not check `start` — callers (`tick`/`value_at`) decide whether `now` is
    /// eligible at all.
    fn emitted_value(&self, now: Duration) -> f64 {
        let raw = self.raw_value(now);
        match self.unit {
            AnimUnit::Scalar => raw,
            AnimUnit::GainLinear => lin_to_db(raw),
        }
    }

    fn end(&self) -> Duration {
        self.start + self.duration
    }
}

/// Identifies one [`Animation`] added to an [`Animator`]. Ids are minted in strictly
/// increasing order, which `Animator` also uses as its "most recently added" ranking for
/// the last-added-wins rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AnimId(pub u64);

struct Entry {
    id: AnimId,
    anim: Animation,
    /// Set once this entry has had its one final-value emission from `tick`. A `done`
    /// entry is never selected as a target's winner again (freeing the target for the
    /// next most-recently-added entry, if any), but it is kept — not removed — so
    /// `value_at` can keep answering with its final value until it is cancelled or
    /// superseded.
    done: bool,
}

/// Owns every in-flight (and recently finished, until cancelled/superseded) animation.
/// Single-threaded: driven from the render loop via `&mut self` calls.
#[derive(Default)]
pub struct Animator {
    next_id: u64,
    entries: Vec<Entry>,
    finished_queue: Vec<(AnimId, Option<CorrId>)>,
}

impl Animator {
    pub fn new() -> Self {
        Animator {
            next_id: 1,
            entries: Vec::new(),
            finished_queue: Vec::new(),
        }
    }

    /// Adds a new animation, returning its id.
    pub fn add(&mut self, a: Animation) -> AnimId {
        let id = AnimId(self.next_id);
        self.next_id += 1;
        self.entries.push(Entry {
            id,
            anim: a,
            done: false,
        });
        id
    }

    /// Cancels one animation by id. A cancelled animation never appears in `finished()`.
    pub fn cancel(&mut self, id: AnimId) {
        self.entries.retain(|e| e.id != id);
    }

    /// Cancels every animation currently targeting `path` (winner and any shadowed ones).
    pub fn cancel_target(&mut self, path: &PropPath) {
        self.entries.retain(|e| &e.anim.target != path);
    }

    /// Advances to `now`, returning the values to apply this tick: at most one
    /// `(target, value)` per distinct target, from that target's most-recently-added
    /// not-yet-finished animation, and only once `now >= that animation's start`. An
    /// animation whose `now >= start + duration` emits its exact final value this call,
    /// then is marked finished (reported via `finished()`) and never emitted again.
    pub fn tick(&mut self, now: Duration) -> Vec<(PropPath, f64)> {
        // Pick, per target, the not-yet-finished entry with the highest id.
        let mut winner_of: HashMap<PropPath, usize> = HashMap::new();
        for (i, e) in self.entries.iter().enumerate() {
            if e.done {
                continue;
            }
            match winner_of.get(&e.anim.target) {
                Some(&j) if self.entries[j].id.0 >= e.id.0 => {}
                _ => {
                    winner_of.insert(e.anim.target.clone(), i);
                }
            }
        }

        let mut out = Vec::with_capacity(winner_of.len());
        let mut newly_finished = Vec::new();
        for &i in winner_of.values() {
            let anim = &self.entries[i].anim;
            if now < anim.start {
                continue; // hasn't begun yet: emit nothing
            }
            out.push((anim.target.clone(), anim.emitted_value(now)));
            if now >= anim.end() {
                newly_finished.push(i);
            }
        }

        for i in newly_finished {
            self.entries[i].done = true;
            let id = self.entries[i].id;
            let corr = self.entries[i].anim.corr.clone();
            self.finished_queue.push((id, corr));
        }

        out
    }

    /// Drains and returns every `(AnimId, Option<CorrId>)` that has completed (not
    /// cancelled) since the last call.
    pub fn finished(&mut self) -> Vec<(AnimId, Option<CorrId>)> {
        std::mem::take(&mut self.finished_queue)
    }

    /// What `path` would be showing at time `t`, for the dropout probe: the value that
    /// path's most-recently-added animation (by id) whose `start <= t` would emit at `t`
    /// — finished or not (a finished animation's `end()` is in the past, so its `progress`
    /// at `t` is clamped to `1.0`, i.e. its final value). Returns `None` if no animation
    /// on `path` has started by `t` (including if `path` has no animations at all).
    pub fn value_at(&self, path: &PropPath, t: Duration) -> Option<f64> {
        let mut best: Option<&Entry> = None;
        for e in &self.entries {
            if &e.anim.target != path || e.anim.start > t {
                continue;
            }
            match best {
                Some(b) if b.id.0 >= e.id.0 => {}
                _ => best = Some(e),
            }
        }
        best.map(|e| e.anim.emitted_value(t))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::SILENT_DB;

    fn anim(
        target: &str,
        from: f64,
        to: f64,
        start_ms: u64,
        dur_ms: u64,
        curve: Curve,
    ) -> Animation {
        Animation {
            target: PropPath(target.to_string()),
            from,
            to,
            start: Duration::from_millis(start_ms),
            duration: Duration::from_millis(dur_ms),
            curve,
            unit: AnimUnit::Scalar,
            corr: None,
        }
    }

    #[test]
    // The brief's exact Step 1 value (`0.70710678`) happens to be close enough to
    // `FRAC_1_SQRT_2` to trip clippy's `approx_constant` — keep the literal verbatim as
    // specified rather than swapping in the constant.
    #[allow(clippy::approx_constant)]
    fn curves() {
        assert!((Curve::Smoothstep.eval(0.5) - 0.5).abs() < 1e-12);
        assert!((Curve::EqualPowerIn.eval(0.5) - 0.70710678).abs() < 1e-7);
        assert_eq!(Curve::Linear.eval(1.7), 1.0);

        // Extra coverage for the other two curves + clamping, not explicitly required by
        // the brief's Step 1 list but cheap and directly relevant for an audio-critical
        // crate.
        assert!((Curve::EqualPowerOut.eval(0.5) - 0.70710678).abs() < 1e-7);
        assert_eq!(Curve::EqualPowerOut.eval(0.0), 1.0);
        assert_eq!(Curve::EqualPowerIn.eval(0.0), 0.0);
        assert_eq!(Curve::Step.eval(0.0), 0.0);
        assert_eq!(Curve::Step.eval(0.999), 0.0);
        assert_eq!(Curve::Step.eval(1.0), 1.0);
        assert_eq!(Curve::Step.eval(1.5), 1.0);
        assert_eq!(Curve::Linear.eval(-0.3), 0.0);
    }

    #[test]
    fn animator_gain_linear() {
        let mut a = Animator::new();
        a.add(Animation {
            target: PropPath("src7.gain.xfade".to_string()),
            from: 0.0,
            to: 1.0,
            start: Duration::ZERO,
            duration: Duration::from_millis(5000),
            curve: Curve::EqualPowerIn,
            unit: AnimUnit::GainLinear,
            corr: None,
        });

        let at_start = a.tick(Duration::ZERO);
        assert_eq!(at_start.len(), 1);
        assert_eq!(
            at_start[0].1, SILENT_DB,
            "GainLinear 0->1 must emit SILENT_DB at its own start"
        );

        let at_mid = a.tick(Duration::from_millis(2500));
        assert_eq!(at_mid.len(), 1);
        assert!(
            (at_mid[0].1 - (-3.0103)).abs() < 1e-3,
            "at 2500ms (progress 0.5) expected -3.0103 dB, got {}",
            at_mid[0].1
        );
    }

    #[test]
    fn final_value_once() {
        let mut a = Animator::new();
        let id = a.add(anim("fx2.progress", 0.0, 1.0, 0, 1000, Curve::Linear));

        let mid = a.tick(Duration::from_millis(500));
        assert_eq!(mid, vec![(PropPath("fx2.progress".to_string()), 0.5)]);
        assert!(a.finished().is_empty(), "not finished yet at 500ms");

        let end = a.tick(Duration::from_millis(1000));
        assert_eq!(end, vec![(PropPath("fx2.progress".to_string()), 1.0)]);
        let fin = a.finished();
        assert_eq!(fin, vec![(id, None)]);

        // After the end, tick must never emit it again, and finished() is drained.
        let after = a.tick(Duration::from_millis(1500));
        assert!(after.is_empty(), "must not re-emit a finished animation");
        assert!(a.finished().is_empty(), "finished() must be drained");
    }

    #[test]
    fn cancel_target_replaces() {
        let mut a = Animator::new();
        let path = PropPath("fx2.progress".to_string());
        a.add(anim("fx2.progress", 0.0, 1.0, 0, 1000, Curve::Linear));

        a.cancel_target(&path);
        // Asymmetric `to` (0.2, not 1.0) so the emitted value at any progress other than
        // 0 unambiguously identifies which animation emitted it.
        let second = a.add(anim("fx2.progress", 0.0, 0.2, 0, 1000, Curve::Linear));

        let tick = a.tick(Duration::from_millis(500));
        assert_eq!(
            tick,
            vec![(path.clone(), 0.1)],
            "only the replacement (added after cancel_target) must emit"
        );
        let fin = a.tick(Duration::from_millis(1000));
        assert_eq!(fin, vec![(path, 0.2)]);
        assert_eq!(a.finished(), vec![(second, None)]);
    }

    #[test]
    fn last_added_wins_without_cancel() {
        // Two animations on the same target, neither cancelled: tick must emit only the
        // most-recently-added one's value, at most once per target per tick.
        let mut a = Animator::new();
        let path = PropPath("fx2.progress".to_string());
        a.add(anim("fx2.progress", 0.0, 1.0, 0, 1000, Curve::Linear));
        let newer = a.add(anim("fx2.progress", 0.0, 0.2, 0, 1000, Curve::Linear));

        let tick = a.tick(Duration::from_millis(500));
        assert_eq!(
            tick,
            vec![(path.clone(), 0.1)],
            "must emit only the newer animation's value (0.2 * 0.5), not the older's (1.0 * 0.5)"
        );

        let end = a.tick(Duration::from_millis(1000));
        assert_eq!(end, vec![(path.clone(), 0.2)]);
        let fin = a.finished();
        assert_eq!(
            fin,
            vec![(newer, None)],
            "only the winning (newer) animation finishes"
        );
    }

    #[test]
    fn nothing_emitted_before_start() {
        let mut a = Animator::new();
        a.add(anim("fx2.progress", 0.0, 1.0, 1000, 1000, Curve::Linear));

        let early = a.tick(Duration::from_millis(500));
        assert!(early.is_empty(), "must emit nothing before start");

        let on_time = a.tick(Duration::from_millis(1500));
        assert_eq!(on_time, vec![(PropPath("fx2.progress".to_string()), 0.5)]);
    }

    #[test]
    fn value_at_semantics() {
        let mut a = Animator::new();
        let path = PropPath("fx2.progress".to_string());
        a.add(anim("fx2.progress", 0.0, 1.0, 1000, 1000, Curve::Linear));

        // Before the earliest animation on this path starts: None.
        assert_eq!(a.value_at(&path, Duration::from_millis(500)), None);
        // No animation at all on an unrelated path: None.
        assert_eq!(
            a.value_at(&PropPath("nope".to_string()), Duration::ZERO),
            None
        );

        // Mid-flight: the interpolated value, without needing a tick() call first.
        assert_eq!(a.value_at(&path, Duration::from_millis(1500)), Some(0.5));

        // Past the end (finished, whether or not tick() has been called): held at the
        // final value.
        assert_eq!(a.value_at(&path, Duration::from_millis(5000)), Some(1.0));

        // Drive it through tick() to actually finish it, then confirm value_at still
        // holds the final value afterward.
        a.tick(Duration::from_millis(2000));
        assert_eq!(a.value_at(&path, Duration::from_millis(9000)), Some(1.0));

        // A more recently added animation on the same path supersedes the old one for
        // value_at too, even though the old one was never cancelled.
        let newer = a.add(anim("fx2.progress", 0.0, 0.4, 1000, 1000, Curve::Linear));
        assert_eq!(a.value_at(&path, Duration::from_millis(1500)), Some(0.2));

        // Cancelling the newer one falls back to the older one again.
        a.cancel(newer);
        assert_eq!(a.value_at(&path, Duration::from_millis(1500)), Some(0.5));
    }
}
