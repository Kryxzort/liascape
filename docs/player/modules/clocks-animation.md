<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Clocks and Animation

`src/clock.rs` (spec §4.2 "Clock"): `Clock::now() -> Duration`. `MonoClock` wraps
`Instant`; `SteppedClock` only advances on `step(&self, d)` (tests); `OutputClock::new(base:
Rc<dyn Clock>)` adds `pause`/`resume` per output — paused time is excised, never just
unfrozen-and-jumped. All three are `Cell`-based, single-threaded, not `Send`/`Sync`.

`src/anim.rs` (spec §4.2 "Animator", §4.3 recipes): `Animator::tick(now)` moves every
`Animation` (`target: PropPath`, `from`/`to`, `start`/`duration`, `curve: Curve`, `unit:
AnimUnit`, `corr`) along `value = from + (to-from)*curve.eval(progress)`. Curves: `Linear`,
`Smoothstep` (`x²(3-2x)`), `EqualPowerOut`/`EqualPowerIn` (reuse `units::equal_power`'s
cos/sin), `Step`. `eval` always clamps `x` to `[0,1]` first.

- **`AnimUnit::GainLinear`** means `from`/`to` are **linear** amplitudes; the value `tick`/
  `value_at` actually emit is `lin_to_db` of the curve output — so a `GainLinear` anim from
  `0`→`1` emits `SILENT_DB` at its own `start`, not mid-ramp.
- **Nothing before `start`.** `tick` emits nothing for an animation whose `start` hasn't
  arrived yet; `value_at(path, t)` returns `None` only when no animation on `path` has
  started by `t`, otherwise the value that animation would emit at `t` (held at its final
  value once finished, until cancelled or superseded).
- **One final value, exactly once.** The tick where `now >= start + duration` emits the
  exact final value, reports `(AnimId, corr)` via `finished()`, and never emits that
  animation again.
- **`target_of(path)`** (Task 11 fix round, R41) — the value the animation on `path` *ends*
  at (dB for `GainLinear`), started or not, finished or not; `None` when nothing animates
  it. Recipes record this — not the instantaneous value — when they save a property to
  restore later, so a restore never lands mid-ramp.
- **`has_live_gain(now, horizon)`** (R90; M1 of the final review): a not-finished `gain.*`
  animation that has started or starts within `horizon` — the fast gain timer's arm condition
  (the caller passes one main tick period). `len()`/`retain_targets(keep)` (the runtime drops
  animations on nodes that are gone — a never-started placeholder would otherwise stay forever).
- **`compress_to(path, corr, now, end)`** (the `align: end` compression, § Transition recipe →
  Align): the live animation `corr` added on `path` finishes at `end` instead of later — the rest
  of its progress is rescaled in time (new `duration` = (end − now)/(1 − x₀), `start` moved back
  so x(now) = x₀): value continuous, same curve. In place (same id); a not-started one keeps its
  start (≤ `end`); never a finished one, never later, never another corr's.
- **`add()` supersedes, permanently.** `Animator` holds at most one live animation per
  `PropPath` — `add()`ing a second animation on a target **removes** the earlier one
  outright (same as `cancel()`; retracting its completion from the `finished()` queue too,
  if it was already sitting there undrained). There is no "shadowed" animation left to
  hand control back to once the newer one finishes, so `tick` and `value_at` can never
  disagree about which animation is live on a target. (A prior design let the newer one
  merely *shadow* the older per-tick, which let the older one resurface once the newer
  finished — a reviewed-and-rejected bug, not the intended behaviour.)
