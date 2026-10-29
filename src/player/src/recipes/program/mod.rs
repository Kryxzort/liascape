//! Programs (spec §4.2 "Program", §4.3 "Video-end-aligned advance"): a rotation is a graph
//! node `prog:<name>` whose settings are live properties; this recipe reads it and, on the
//! player clock, requests `transition`s on its outputs — which item, which effect, when. It
//! never renders and never touches a source.
//!
//! - [`rule`] — the per-item play rules (minimum / maximum / scene timing) and the
//!   countdown's retime (pure).
//! - [`order`] — the play order: cycles, shuffle, history, random, reorder (pure, seeded).
//! - [`pick`] — the effect / duration / method of one switch (pure, seeded).

pub mod order;
pub mod pick;
pub mod rule;

pub use order::{Order, Step, StepWhy};
pub use pick::{Pick, TransitionCfg};
pub use rule::{ItemRule, NEVER_MS, PlayKind};

/// A small seedable RNG (SplitMix64): a program's shuffles, random picks and effect picks
/// are reproducible from its `seed` (tests pin it). Not for anything secret.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`n > 0`; `0` for `n == 0`), without modulo bias.
    pub fn below(&mut self, n: usize) -> usize {
        if n <= 1 {
            return 0;
        }
        let n = n as u64;
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let x = self.next_u64();
            if x < zone {
                return (x % n) as usize;
            }
        }
    }

    /// Fisher–Yates.
    pub fn shuffle<T>(&mut self, xs: &mut [T]) {
        for i in (1..xs.len()).rev() {
            let j = self.below(i + 1);
            xs.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_is_seeded_and_uniform() {
        let (mut a, mut b) = (Rng::new(9), Rng::new(9));
        for _ in 0..10 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        let mut counts = [0u32; 6];
        for _ in 0..6000 {
            counts[a.below(6)] += 1;
        }
        assert!(counts.iter().all(|c| (850..1150).contains(c)), "{counts:?}");
        assert_eq!(a.below(0), 0);
        assert_eq!(a.below(1), 0);
    }
}
