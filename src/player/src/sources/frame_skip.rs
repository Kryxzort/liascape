//! Decoder-side frame skipping for a fast `speed` (`docs/player/modules/sources.md` § Fast
//! speeds): when a video at `speed` > 1 asks the decoder for more frames per second than it
//! sustains, mpv's VO drops nearly every frame as late — the decoder stays saturated, so its
//! frames arrive late however many are dropped, and mpv's "degrade to 10 fps" floor is all
//! that is shown (measured: a 3840×2160@120 H.264 clip at ~105 Mbps on NVDEC at 2× presented
//! 10–16 frames/s, ~107 ms apart). Skipping the decode of non-reference frames
//! (`vd-lavc-skipframe=nonref`) drops the same frames in every GOP before they cost anything:
//! the decoder keeps up and the picture stays evenly paced at the asked speed (the same clip:
//! 121 frames/s at 2×, 180 at 3×). Non-reference frames are the only ones safe to skip — no
//! other frame is decoded from them, so skipping never corrupts the picture (`bidir` skips
//! referenced B-frames too).
//!
//! The policy only ever skips at `speed` > 1 and only once mpv proved it can't keep up
//! (sustained VO drops), so normal speed and every decoder fast enough are unchanged. It
//! remembers how fast the decoder was when it gave up (frames delivered per second over the
//! clip's frame rate = the fastest `speed` it sustains) and stops skipping once `speed` is
//! back under that.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// The mpv `vd-lavc-skipframe` value while skipping.
pub const SKIP: &str = "nonref";
/// The mpv `vd-lavc-skipframe` value otherwise (mpv's own default).
pub const NO_SKIP: &str = "default";

/// The drops are judged over this much playback.
const WINDOW: Duration = Duration::from_secs(1);
/// …once it spans at least this much (a shorter one is a burst, not a trend).
const MIN_SPAN: Duration = Duration::from_millis(500);
/// VO drops per second that count as "can't keep up" — measured 140–170/s with the decoder
/// saturated, 0 when it keeps up.
const DROPS_PER_S: f64 = 10.0;
/// …and at least this share of the frames mpv's VO got (a few drops of a fast stream are
/// timing noise, not a saturated decoder).
const DROP_SHARE: f64 = 0.1;
/// After switching skipping on or off, the drops of the switch itself are not a trend.
const SETTLE: Duration = Duration::from_millis(500);
/// Stop skipping below this share of the speed the decoder sustained without it. Over 1: the
/// rate is measured as mpv starts falling behind and reads up to ~8 % low (the 4K120 clip:
/// 1.41× measured, 1.53× sustained). A release that was too eager falls behind again and skips
/// again within about a second, at that speed for good (a release also needs a slower speed
/// than the one skipping started at), so it can never flap.
const RELEASE_MARGIN: f64 = 1.1;
/// With no frame rate known (no capacity), stop skipping below this share of the speed it
/// started at.
const RELEASE_FALLBACK: f64 = 0.75;
/// `speed` at or below this never skips.
const NORMAL_SPEED: f64 = 1.0 + 1e-6;

/// One source's skip state. Feed it with [`FrameSkip::update`] (cheap; every loop update).
#[derive(Debug, Default)]
pub struct FrameSkip {
    on: bool,
    /// The fastest `speed` the decoder sustained without skipping (frames delivered per
    /// second ÷ the clip's frame rate), measured when skipping started.
    capacity: Option<f64>,
    /// The `speed` skipping started at.
    on_speed: f64,
    /// (when, cumulative VO drops, cumulative frames shown) within [`WINDOW`].
    samples: VecDeque<(Instant, u64, u64)>,
    changed_at: Option<Instant>,
}

impl FrameSkip {
    /// Whether frames are skipped now.
    pub fn on(&self) -> bool {
        self.on
    }

    /// The decoder's measured capacity in `speed` units, while skipping.
    pub fn capacity(&self) -> Option<f64> {
        self.capacity
    }

    /// A new load: its decoder may well keep up. Returns `true` when skipping was on (the
    /// caller sends [`NO_SKIP`]).
    pub fn reset(&mut self) -> bool {
        let was = self.on;
        *self = FrameSkip::default();
        was
    }

    /// One observation: `speed` now, mpv's cumulative VO drops (`frame-drop-count`) and the
    /// cumulative frames rendered, and the clip's frame rate (`container-fps`) if known.
    /// Returns the new state when it changes (the caller sends [`SKIP`] / [`NO_SKIP`]).
    pub fn update(
        &mut self,
        now: Instant,
        speed: f64,
        drops: u64,
        shown: u64,
        fps: Option<f64>,
    ) -> Option<bool> {
        if speed <= NORMAL_SPEED {
            self.samples.clear();
            return self.on.then(|| self.switch(now, false));
        }
        if self.on {
            let floor = self
                .capacity
                .map_or(self.on_speed * RELEASE_FALLBACK, |c| c * RELEASE_MARGIN);
            return (speed < floor && speed < self.on_speed).then(|| self.switch(now, false));
        }
        // Settling after a switch, or a counter that went backwards (mpv restarted it): the
        // window starts over from here.
        let settling = self
            .changed_at
            .is_some_and(|t| now.duration_since(t) < SETTLE);
        if settling
            || self
                .samples
                .back()
                .is_some_and(|&(_, d, s)| drops < d || shown < s)
        {
            self.samples.clear();
        }
        self.samples.push_back((now, drops, shown));
        if settling {
            return None;
        }
        while self
            .samples
            .get(1)
            .is_some_and(|&(t, ..)| now.duration_since(t) >= WINDOW)
        {
            self.samples.pop_front();
        }
        let &(t0, d0, s0) = self.samples.front()?;
        let span = now.duration_since(t0);
        if span < MIN_SPAN {
            return None;
        }
        let secs = span.as_secs_f64();
        let (dropped, got) = ((drops - d0) as f64, (drops - d0 + shown - s0) as f64);
        if dropped / secs < DROPS_PER_S || dropped < DROP_SHARE * got {
            return None;
        }
        self.capacity = fps.filter(|f| *f > 0.0).map(|f| got / secs / f);
        self.on_speed = speed;
        Some(self.switch(now, true))
    }

    fn switch(&mut self, now: Instant, on: bool) -> bool {
        self.on = on;
        if !on {
            self.capacity = None;
        }
        self.samples.clear();
        self.changed_at = Some(now);
        on
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A [`FrameSkip`] fed at 60 updates per second ([`Sim::run`]).
    struct Sim {
        f: FrameSkip,
        now: Instant,
        drops: f64,
        shown: f64,
    }

    impl Sim {
        fn new() -> Sim {
            Sim {
                f: FrameSkip::default(),
                now: Instant::now(),
                drops: 0.0,
                shown: 0.0,
            }
        }

        /// `secs` at `speed` with `drop_rate` VO drops and `show_rate` frames shown per
        /// second; every state change with its time.
        fn run(
            &mut self,
            secs: f64,
            speed: f64,
            drop_rate: f64,
            show_rate: f64,
            fps: Option<f64>,
        ) -> Vec<(f64, bool)> {
            let mut out = Vec::new();
            let dt = 1.0 / 60.0;
            let mut t = 0.0;
            while t < secs {
                self.now += Duration::from_secs_f64(dt);
                self.drops += drop_rate * dt;
                self.shown += show_rate * dt;
                t += dt;
                if let Some(on) =
                    self.f
                        .update(self.now, speed, self.drops as u64, self.shown as u64, fps)
                {
                    out.push((t, on));
                }
            }
            out
        }
    }

    #[test]
    fn normal_speed_never_skips_however_much_is_dropped() {
        let mut s = Sim::new();
        assert!(s.run(5.0, 1.0, 170.0, 10.0, Some(120.0)).is_empty());
        assert!(s.run(5.0, 0.5, 170.0, 10.0, Some(120.0)).is_empty());
        assert!(!s.f.on());
    }

    #[test]
    fn a_decoder_that_keeps_up_never_skips() {
        let mut s = Sim::new();
        assert!(s.run(5.0, 2.0, 0.0, 240.0, Some(120.0)).is_empty());
        // A few drops of a fast stream (under DROP_SHARE / DROPS_PER_S) are noise.
        assert!(s.run(5.0, 2.0, 8.0, 232.0, Some(120.0)).is_empty());
        assert!(s.run(5.0, 4.0, 20.0, 460.0, Some(120.0)).is_empty());
    }

    #[test]
    fn a_saturated_decoder_skips_within_a_second_and_remembers_its_capacity() {
        let mut s = Sim::new();
        let ch = s.run(3.0, 2.0, 170.0, 13.0, Some(120.0));
        assert_eq!(ch.len(), 1, "{ch:?}");
        assert!(ch[0].1 && ch[0].0 <= 1.1, "{ch:?}");
        let cap = s.f.capacity().unwrap();
        assert!((cap - 183.0 / 120.0).abs() < 0.05, "{cap}");
        // Skipping fixed it (no drops): stays on at that speed.
        assert!(s.run(5.0, 2.0, 0.0, 120.0, Some(120.0)).is_empty());
        assert!(s.f.on());
    }

    #[test]
    fn skipping_follows_speed_down_and_up() {
        let mut s = Sim::new();
        s.run(2.0, 2.0, 170.0, 13.0, Some(120.0));
        assert!(s.f.on());
        // Down, still over the decoder's capacity (1.525 × 1.1): keeps skipping.
        assert!(s.run(1.0, 1.75, 0.0, 105.0, Some(120.0)).is_empty());
        // Under it: plays every frame again, at once.
        let ch = s.run(0.1, 1.6, 0.0, 192.0, Some(120.0));
        assert_eq!(ch.first().map(|c| c.1), Some(false), "{ch:?}");
        // Back up past it: the drops return and it skips again.
        let ch = s.run(2.0, 3.0, 170.0, 10.0, Some(120.0));
        assert_eq!(ch.iter().map(|c| c.1).collect::<Vec<_>>(), [true], "{ch:?}");
        // Normal speed always plays every frame.
        let ch = s.run(0.1, 1.0, 0.0, 120.0, Some(120.0));
        assert_eq!(ch.first().map(|c| c.1), Some(false), "{ch:?}");
    }

    #[test]
    fn a_release_that_was_too_eager_skips_again_and_stays_on_at_that_speed() {
        let mut s = Sim::new();
        s.run(2.0, 2.0, 170.0, 13.0, Some(120.0));
        let ch = s.run(0.1, 1.6, 0.0, 192.0, Some(120.0));
        assert_eq!(ch.first().map(|c| c.1), Some(false), "{ch:?}");
        // 1.6× was too fast after all: on again…
        let ch = s.run(2.0, 1.6, 150.0, 30.0, Some(120.0));
        assert_eq!(ch.iter().map(|c| c.1).collect::<Vec<_>>(), [true], "{ch:?}");
        // …and it stays on at 1.6× although the capacity it measured (1.5) × 1.1 is above.
        assert!(s.run(5.0, 1.6, 0.0, 96.0, Some(120.0)).is_empty());
        assert!(s.f.on());
    }

    #[test]
    fn a_capacity_over_the_start_speed_still_skips_until_speed_drops() {
        // Capacity measured at 1.9 (the window caught a burst) while skipping started at
        // 2×: × 1.1 is above 2, yet only a slower speed releases.
        let mut s = Sim::new();
        s.run(2.0, 2.0, 60.0, 168.0, Some(120.0));
        assert!(s.f.on() && s.f.capacity().unwrap() * RELEASE_MARGIN > 2.0);
        assert!(s.run(3.0, 2.0, 0.0, 120.0, Some(120.0)).is_empty());
        assert!(s.run(3.0, 2.1, 0.0, 126.0, Some(120.0)).is_empty());
        let ch = s.run(0.1, 1.9, 0.0, 228.0, Some(120.0));
        assert_eq!(ch.first().map(|c| c.1), Some(false), "{ch:?}");
    }

    #[test]
    fn without_a_frame_rate_it_releases_at_a_share_of_its_start_speed() {
        let mut s = Sim::new();
        s.run(2.0, 2.0, 170.0, 13.0, None);
        assert!(s.f.on() && s.f.capacity().is_none());
        assert!(s.run(1.0, 1.6, 0.0, 96.0, None).is_empty());
        let ch = s.run(0.1, 1.45, 0.0, 174.0, None);
        assert_eq!(ch.first().map(|c| c.1), Some(false), "{ch:?}");
    }

    #[test]
    fn the_drops_of_a_switch_itself_are_not_a_trend() {
        let mut s = Sim::new();
        s.run(2.0, 2.0, 170.0, 13.0, Some(120.0));
        s.run(0.1, 1.0, 0.0, 120.0, Some(120.0));
        assert!(!s.f.on());
        // A short burst right after switching off, then clean: never back on.
        assert!(s.run(0.4, 1.2, 200.0, 0.0, Some(120.0)).is_empty());
        assert!(s.run(3.0, 1.2, 0.0, 144.0, Some(120.0)).is_empty());
    }

    #[test]
    fn a_counter_restart_is_not_counted_as_drops() {
        let mut s = Sim::new();
        s.run(2.0, 2.0, 0.0, 240.0, Some(120.0));
        // mpv restarts its counters (a new play-through): the window starts over.
        s.drops = 0.0;
        s.shown = 0.0;
        assert!(s.run(2.0, 2.0, 0.0, 240.0, Some(120.0)).is_empty());
    }

    #[test]
    fn reset_drops_everything_a_new_load_must_not_inherit() {
        let mut s = Sim::new();
        s.run(2.0, 2.0, 170.0, 13.0, Some(120.0));
        assert!(s.f.reset());
        assert!(!s.f.on() && s.f.capacity().is_none());
        assert!(!s.f.reset());
    }
}
