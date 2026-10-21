//! lp-player library crate: modules shared between the `lp-player` binary and its tests.
//!
//! Modules so far: the event log (`log`), audio units (`units`), clocks (`clock`), the
//! Animator (`anim`), the node graph (`graph`), the GPU core (`gfx`), the libmpv wrapper
//! (`mpv`) and the frame sources (`sources`). Later tasks append modules here — see
//! `.claude/rules/player-core.md` for the map.

pub mod anim;
pub mod clock;
pub mod gfx;
pub mod graph;
pub mod log;
pub mod mpv;
pub mod sources;
pub mod units;
