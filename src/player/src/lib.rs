//! lp-player library crate: modules shared between the `lp-player` binary and its tests.
//!
//! Modules so far: the event log (`log`), audio units (`units`), clocks (`clock`), the
//! Animator (`anim`), the node graph (`graph`), the GPU core (`gfx`), the libmpv wrapper
//! (`mpv`), the frame sources (`sources`) and the recipes built from them (`recipes`). Later tasks append modules here — see
//! `.claude/rules/player-core.md` for the map.

pub mod anim;
pub mod clock;
pub mod gfx;
pub mod graph;
pub mod log;
pub mod mpv;
pub mod recipes;
pub mod sources;
pub mod units;
