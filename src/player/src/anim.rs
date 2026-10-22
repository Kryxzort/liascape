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
//! **Last-added wins, permanently — `add()` supersedes.** At most one animation can ever
//! be live on a given [`PropPath`] at a time: calling `add()` for a target that already has
//! an animation **removes that earlier one outright** — exactly as if [`Animator::cancel`]
//! had been called on it (it never emits again, and if it had already queued a completion
//! in [`Animator::finished`] that hasn't been drained yet, that queued completion is
//! retracted too). This is what makes "last-added wins" hold *forever*, not just per-tick:
//! there is no shadowed older animation waiting to resurface once the newer one finishes,
//! so `tick` and `value_at` can never disagree about which animation is live on a target.
//! A finished animation's final value is held by `value_at` only until it is cancelled or a
//! newer `add()` on the same path supersedes it (same thing, from the target's point of
//! view).

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
/// increasing order (purely for log/debug traceability — `Animator` no longer needs to
/// rank by id, since `add()` enforces at most one live animation per target).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AnimId(pub u64);

struct Entry {
    id: AnimId,
    anim: Animation,
    /// Set once this entry has had its one final-value emission from `tick`. A `done`
    /// entry is kept — not removed — so `value_at` can keep answering with its final
    /// value, until it is cancelled or a newer `add()` on the same target supersedes it.
    done: bool,
}

/// Owns every in-flight (and recently finished, until cancelled/superseded) animation.
/// Single-threaded: driven from the render loop via `&mut self` calls.
///
/// **Invariant:** at most one `Entry` exists per distinct [`PropPath`] at any time — see
/// [`Animator::add`]. `tick`/`value_at` rely on this to never have to choose between two
/// live animations on the same target.
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

    /// Adds a new animation, returning its id. **Supersedes** any existing animation on
    /// the same target: that earlier entry is removed exactly as [`cancel`](Self::cancel)
    /// would remove it (it will never emit again), and if it already had a completion
    /// sitting in the undrained `finished()` queue, that completion is retracted — a
    /// superseded animation must never surface a stale `finished()` event for an id a
    /// caller no longer has any reason to recognise.
    pub fn add(&mut self, a: Animation) -> AnimId {
        if let Some(pos) = self.entries.iter().position(|e| e.anim.target == a.target) {
            let superseded_id = self.entries.remove(pos).id;
            self.finished_queue.retain(|(id, _)| *id != superseded_id);
        }

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

    /// Cancels the animation currently targeting `path`, if any.
    pub fn cancel_target(&mut self, path: &PropPath) {
        self.entries.retain(|e| &e.anim.target != path);
    }

    /// Advances to `now`, returning the values to apply this tick: one `(target, value)`
    /// per live (not yet finished) animation whose `start` has arrived. An animation whose
    /// `now >= start + duration` emits its exact final value this call, then is marked
    /// finished (reported via `finished()`) and never emitted again.
    pub fn tick(&mut self, now: Duration) -> Vec<(PropPath, f64)> {
        let mut out = Vec::new();
        let mut newly_finished = Vec::new();
        for (i, e) in self.entries.iter().enumerate() {
            if e.done || now < e.anim.start {
                continue; // already finished, or hasn't begun yet: emit nothing
            }
            out.push((e.anim.target.clone(), e.anim.emitted_value(now)));
            if now >= e.anim.end() {
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
    /// cancelled, and not superseded by a later `add()` on the same target) since the
    /// last call.
    pub fn finished(&mut self) -> Vec<(AnimId, Option<CorrId>)> {
        std::mem::take(&mut self.finished_queue)
    }

    /// What `path` would be showing at time `t`, for the dropout probe: the value `path`'s
    /// (at most one, by the `Animator` invariant) animation would emit at `t`, if its
    /// `start <= t` — finished or not (a finished animation's `end()` is in the past, so
    /// its `progress` at `t` is clamped to `1.0`, i.e. its final value). Returns `None` if
    /// no animation on `path` has started by `t` (including if `path` has no animation at
    /// all). Because `add()` always supersedes, this can never disagree with what the most
    /// recent `tick()` emitted for `path`.
    pub fn value_at(&self, path: &PropPath, t: Duration) -> Option<f64> {
        self.entries
            .iter()
            .find(|e| &e.anim.target == path && e.anim.start <= t)
            .map(|e| e.anim.emitted_value(t))
    }

    /// Whether an animation that has started by `now` and isn't finished yet targets a
    /// path `pred` accepts — the redraw policy's "something moves" (Task 13,
    /// `crate::redraw::animating`). A finished animation holding its final value doesn't
    /// count: it emits nothing more.
    pub fn any_live(&self, now: Duration, pred: impl Fn(&PropPath) -> bool) -> bool {
        self.entries
            .iter()
            .any(|e| !e.done && e.anim.start <= now && pred(&e.anim.target))
    }

    /// [`target_of`](Self::target_of), but only while the animation is **live** (not yet
    /// started, or running) — a finished one is ignored: the property's own value is then
    /// the truth (a direct `set` after the animation finished must win). For callers that
    /// fall back to the current value (the snapshot, anti-click ramps).
    pub fn live_target_of(&self, path: &PropPath) -> Option<f64> {
        self.entries
            .iter()
            .find(|e| &e.anim.target == path && !e.done)
            .map(|e| e.anim.emitted_value(e.anim.end()))
    }

    /// The correlation id of the animation on `path` (started or not), if any — lets a
    /// caller tell whether an animation it added is still the one on `path` (not
    /// superseded by a later `add`).
    pub fn corr_of(&self, path: &PropPath) -> Option<&CorrId> {
        self.entries
            .iter()
            .find(|e| &e.anim.target == path)
            .and_then(|e| e.anim.corr.as_ref())
    }

    /// The value the animation on `path` ends at (what it emits at its own end — for a
    /// `GainLinear` animation, that end in dB), whether it has started, is running, or has
    /// finished and is holding it. `None` when nothing animates `path` (never added, or
    /// cancelled/superseded away). R41: a recipe that records a property to restore it
    /// later records *this* when an animation is in flight, not the instantaneous value —
    /// otherwise a restore lands mid-ramp and leaves the property there for good.
    pub fn target_of(&self, path: &PropPath) -> Option<f64> {
        self.entries
            .iter()
            .find(|e| &e.anim.target == path)
            .map(|e| e.anim.emitted_value(e.anim.end()))
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
    fn target_of_is_the_end_value() {
        let mut a = Animator::new();
        let p = PropPath("src1.progress".to_string());
        assert_eq!(a.target_of(&p), None);
        a.add(anim("src1.progress", 0.2, 0.9, 100, 1000, Curve::Linear));
        // Before it starts, mid-way, and after it finished: always the end value.
        let near = |v: Option<f64>| v.is_some_and(|v| (v - 0.9).abs() < 1e-12);
        assert!(near(a.target_of(&p)));
        assert!(near(a.live_target_of(&p)), "not started yet: live");
        a.tick(Duration::from_millis(600));
        assert!(near(a.target_of(&p)), "mid-way");
        a.tick(Duration::from_millis(5000));
        assert!(near(a.target_of(&p)), "finished, holding");
        assert_eq!(a.live_target_of(&p), None, "finished: not live");

        // GainLinear: the end in dB; an equal-power-out from 0 to k ends at k·cos(π/2) = 0
        // → silent, a ramp in to 1.0 ends at 0 dB.
        let g = PropPath("src1.gain.xfade".to_string());
        a.add(Animation {
            unit: AnimUnit::GainLinear,
            ..anim("src1.gain.xfade", 0.0, 0.5, 0, 1000, Curve::EqualPowerOut)
        });
        assert_eq!(a.target_of(&g), Some(SILENT_DB));
        a.add(Animation {
            unit: AnimUnit::GainLinear,
            ..anim("src1.gain.xfade", 0.1, 1.0, 0, 30, Curve::Linear)
        });
        assert!(
            a.target_of(&g).unwrap().abs() < 1e-12,
            "superseding ramp ends at 0 dB"
        );
        a.cancel_target(&g);
        assert_eq!(a.target_of(&g), None);
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
        // Two animations added on the same target without an explicit cancel_target: the
        // second add() must immediately supersede (remove) the first, so only the newer
        // one is ever live, tick-by-tick and at completion.
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
    fn supersede_is_permanent_no_handback_to_shadowed_animation() {
        // Regression for the critical review finding: a long-running animation A on a
        // target, superseded by a short animation B on the same target (no explicit
        // cancel_target). Once B finishes, A must never resurface on a later tick — there
        // is no "shadowed" A left to hand control back to, because add() removed it
        // outright. A must never emit, and must never appear in finished() (including: no
        // stale completion surfacing later for an id the caller no longer has reason to
        // recognise).
        let mut a = Animator::new();
        let path = PropPath("fx2.progress".to_string());
        let old = a.add(anim("fx2.progress", 0.0, 1.0, 0, 10_000, Curve::Linear)); // long A
        let newer = a.add(anim("fx2.progress", 0.0, 0.3, 0, 200, Curve::Linear)); // short B

        // Drive past B's end.
        let at_end = a.tick(Duration::from_millis(200));
        assert_eq!(at_end, vec![(path.clone(), 0.3)], "B's exact final value");
        let fin = a.finished();
        assert_eq!(
            fin,
            vec![(newer, None)],
            "only B finishes; A must not appear"
        );

        // Tick again, much later: the old buggy behaviour would fall through to A here
        // (A hasn't "finished" by its own clock yet at 10s duration) and emit A's
        // part-way value, re-litigating a target that had already settled. The fixed
        // behaviour: nothing emits for this target ever again.
        let later = a.tick(Duration::from_millis(5_000));
        assert!(
            later.is_empty(),
            "A must not resurface once B (the superseding animation) has finished"
        );
        assert!(
            a.finished().is_empty(),
            "A must never surface its own finished() event"
        );

        let much_later = a.tick(Duration::from_millis(50_000));
        assert!(much_later.is_empty());
        assert!(a.finished().is_empty());

        let _ = old; // kept only to document which id is the superseded one
    }

    #[test]
    fn value_at_agrees_with_tick_after_supersede() {
        // value_at must never disagree with what tick() actually emitted for a target —
        // the exact failure mode the critical review caught (tick and value_at used
        // different "which animation is live" logic before the fix).
        let mut a = Animator::new();
        let path = PropPath("fx2.progress".to_string());
        a.add(anim("fx2.progress", 0.0, 1.0, 0, 10_000, Curve::Linear)); // long A
        a.add(anim("fx2.progress", 0.0, 0.3, 0, 200, Curve::Linear)); // short B

        let at_end = a.tick(Duration::from_millis(200));
        assert_eq!(at_end, vec![(path.clone(), 0.3)]);

        assert_eq!(
            a.value_at(&path, Duration::from_millis(200)),
            Some(0.3),
            "value_at at the tick instant must match what tick just emitted"
        );
        assert_eq!(
            a.value_at(&path, Duration::from_millis(5_000)),
            Some(0.3),
            "value_at well after must still hold B's final value, never fall back to A"
        );
        assert_eq!(a.value_at(&path, Duration::from_millis(50_000)), Some(0.3));
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

        // A more recently added animation on the same path supersedes (removes) the old
        // one outright, for value_at too, even though the old one was never explicitly
        // cancelled by the caller.
        let newer = a.add(anim("fx2.progress", 0.0, 0.4, 1000, 1000, Curve::Linear));
        assert_eq!(a.value_at(&path, Duration::from_millis(1500)), Some(0.2));

        // Cancelling the newer one does NOT fall back to the superseded older one — it
        // was removed, permanently, the instant `newer` was added. No entry is left on
        // this path at all.
        a.cancel(newer);
        assert_eq!(
            a.value_at(&path, Duration::from_millis(1500)),
            None,
            "the superseded animation must not resurface after its superseder is cancelled"
        );
    }
}
