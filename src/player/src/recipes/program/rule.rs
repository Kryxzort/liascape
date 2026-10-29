//! A rotation's per-item play rules (pure): what a playing item plays before the program
//! moves on, ported from `PlayerHelper`'s rotation arithmetic (`player-adapter.md`
//! § Rotation, the owner-approved model of 2026-10-28). Every value is wall-clock ms on the
//! player clock; **0 = off** everywhere.
//!
//! - `mode: timer` ("Switch when video ends" off): `interval_ms` is a plain countdown,
//!   speed-scaled; nothing here applies but [`retime_remaining`].
//! - `mode: on_end`: `interval_ms` is the **minimum** and `max_ms` the **maximum**;
//!   [`item_rule`] turns them (and the scene timing) into the playing item's own
//!   [`ItemRule`].

/// What an item is, for its rule (`PlayerHelper.PlayKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayKind {
    Video,
    Image,
    Scene,
}

/// Never reached, and never overflows `played + remaining` (`PlayerHelper.NeverMs`).
pub const NEVER_MS: u64 = u64::MAX / 4;

/// A loop ending within this of the minimum counts as reaching it
/// (`PlayerHelper.MinPlayToleranceMs`).
pub const MIN_SLACK_MS: u64 = 150;

/// The playing item's limits under `on_end`: `min_ms` (a video plays at least this long,
/// then switches at its next end; for an item that never ends, reaching it IS its end;
/// [`NEVER_MS`] = it stays until a user switch or the maximum) and `max_ms` (the cap, even
/// mid-video; 0 = none).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ItemRule {
    pub min_ms: u64,
    pub max_ms: u64,
}

/// `PlayerHelper.ItemPlayRule` — the whole table: video `(min, max)`; separate scene timing
/// on → scene / image `(after or NEVER, 0)`; off → scene `(min or NEVER, max)`, image
/// `(min, max)`.
pub fn item_rule(
    kind: PlayKind,
    min_ms: u64,
    max_ms: u64,
    separate: bool,
    scenes_after_ms: u64,
) -> ItemRule {
    let (min_ms, max_ms) = match kind {
        PlayKind::Video => (min_ms, max_ms),
        _ if separate => (
            if scenes_after_ms > 0 {
                scenes_after_ms
            } else {
                NEVER_MS
            },
            0,
        ),
        PlayKind::Scene => (if min_ms > 0 { min_ms } else { NEVER_MS }, max_ms),
        PlayKind::Image => (min_ms, max_ms),
    };
    ItemRule { min_ms, max_ms }
}

/// `PlayerHelper.MaxPlayReached`: the item played its maximum → the rotation advances now
/// (align now, even mid-video). Only under `on_end`, only with something to rotate to.
pub fn max_reached(on_end: bool, can_rotate: bool, played_ms: u64, max_ms: u64) -> bool {
    on_end && can_rotate && max_ms > 0 && played_ms >= max_ms
}

/// A still's end under `on_end` — an item that never ends switches once its rule's
/// minimum is reached: `PlayerHelper.SceneMinReached` for a scene (a minimum of 0 never
/// fires; `item_rule` never gives one) and `HoldForMinPlay`'s still-image branch for an
/// image (minimum 0 → at once). [`NEVER_MS`] is never reached. A video is never a still.
pub fn still_min_reached(
    on_end: bool,
    can_rotate: bool,
    kind: PlayKind,
    played_ms: u64,
    min_ms: u64,
) -> bool {
    if !on_end || !can_rotate {
        return false;
    }
    match kind {
        PlayKind::Video => false,
        PlayKind::Scene => min_ms > 0 && min_ms < NEVER_MS && played_ms >= min_ms,
        PlayKind::Image => min_ms == 0 || (min_ms < NEVER_MS && played_ms >= min_ms),
    }
}

/// `PlayerHelper.MinPlayReached`: the loop playing now reaches the minimum — what played +
/// what is left of this loop (wall clock at A's speed) + [`MIN_SLACK_MS`] ≥ min. No end
/// known (`None`) → the play time alone (`played ≥ min`; the C# poll added the slack here
/// too, a ≤ 1 s poll's tolerance the tick doesn't need). A minimum of 0 is always reached.
pub fn min_reached(played_ms: u64, loop_remaining_ms: Option<u64>, min_ms: u64) -> bool {
    if min_ms == 0 {
        return true;
    }
    match loop_remaining_ms {
        Some(rem) => played_ms
            .saturating_add(rem)
            .saturating_add(MIN_SLACK_MS)
            >= min_ms,
        None => played_ms >= min_ms,
    }
}

/// `PlayerHelper.UpdateTimedSettings`' countdown arithmetic: a new interval keeps the time
/// already elapsed — `elapsed = max(0, old − remaining)`; `remaining = elapsed ≥ new ? new
/// : new − elapsed` (an interval already used up starts a full new one, as today).
pub fn retime_remaining(old_interval_ms: u64, remaining_ms: u64, new_interval_ms: u64) -> u64 {
    let elapsed = old_interval_ms.saturating_sub(remaining_ms);
    if elapsed >= new_interval_ms {
        new_interval_ms
    } else {
        new_interval_ms - elapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_rule_table() {
        let r = |min_ms, max_ms| ItemRule { min_ms, max_ms };
        // video: (min, max), whatever the scene timing
        assert_eq!(item_rule(PlayKind::Video, 5000, 9000, true, 3000), r(5000, 9000));
        assert_eq!(item_rule(PlayKind::Video, 5000, 9000, false, 3000), r(5000, 9000));
        assert_eq!(item_rule(PlayKind::Video, 0, 0, true, 0), r(0, 0));
        // separate on: scene / image (after or NEVER, 0)
        assert_eq!(item_rule(PlayKind::Scene, 5000, 9000, true, 3000), r(3000, 0));
        assert_eq!(item_rule(PlayKind::Image, 5000, 9000, true, 3000), r(3000, 0));
        assert_eq!(item_rule(PlayKind::Scene, 5000, 9000, true, 0), r(NEVER_MS, 0));
        assert_eq!(item_rule(PlayKind::Image, 5000, 9000, true, 0), r(NEVER_MS, 0));
        // separate off: scene (min or NEVER, max), image (min, max)
        assert_eq!(item_rule(PlayKind::Scene, 0, 9000, false, 3000), r(NEVER_MS, 9000));
        assert_eq!(item_rule(PlayKind::Scene, 5000, 9000, false, 3000), r(5000, 9000));
        assert_eq!(item_rule(PlayKind::Image, 0, 9000, false, 3000), r(0, 9000));
        assert_eq!(item_rule(PlayKind::Image, 5000, 0, false, 3000), r(5000, 0));
    }

    #[test]
    fn max_and_min_predicates() {
        assert!(max_reached(true, true, 3000, 3000));
        assert!(!max_reached(true, true, 2999, 3000));
        assert!(!max_reached(false, true, 9_000_000, 3000));
        assert!(!max_reached(true, false, 9_000_000, 3000));
        assert!(!max_reached(true, true, 9_000_000, 0));
        assert!(min_reached(4000, Some(850), 5000));
        assert!(!min_reached(4000, Some(849), 5000));
        assert!(min_reached(0, Some(0), 0));
        assert!(min_reached(5000, None, 5000));
        assert!(!min_reached(4999, None, 5000));
        assert!(!min_reached(315_360_000_000, Some(3_600_000), NEVER_MS)); // 10 years played
        assert!(still_min_reached(true, true, PlayKind::Scene, 3000, 3000));
        assert!(!still_min_reached(true, true, PlayKind::Scene, 2999, 3000));
        assert!(!still_min_reached(true, true, PlayKind::Scene, u64::MAX / 8, NEVER_MS));
        assert!(!still_min_reached(true, true, PlayKind::Scene, 9_000_000, 0));
        assert!(still_min_reached(true, true, PlayKind::Image, 0, 0));
        assert!(still_min_reached(true, true, PlayKind::Image, 3000, 3000));
        assert!(!still_min_reached(true, true, PlayKind::Image, u64::MAX / 8, NEVER_MS));
        assert!(!still_min_reached(true, true, PlayKind::Video, 9_000_000, 3000));
        assert!(!still_min_reached(false, true, PlayKind::Scene, 9_000_000, 3000));
        assert!(!still_min_reached(true, false, PlayKind::Image, 9_000_000, 3000));
    }

    #[test]
    fn retime_remaining_both_branches() {
        assert_eq!(retime_remaining(10000, 4000, 20000), 14000);
        assert_eq!(retime_remaining(10000, 4000, 5000), 5000);
        // remaining above the old interval (never negative elapsed)
        assert_eq!(retime_remaining(1000, 4000, 5000), 5000);
        assert_eq!(retime_remaining(10000, 10000, 0), 0);
    }
}
