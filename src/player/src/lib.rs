//! lp-player library crate: modules shared between the `lp-player` binary and its tests.
//!
//! This task wires up the event log (`log`), audio units (`units`), clocks (`clock`) and
//! the Animator (`anim`). Later tasks append modules here (graph, gfx, mpv, …) — see
//! `.claude/rules/player-core.md` for the map.

pub mod anim;
pub mod clock;
pub mod graph;
pub mod log;
pub mod units;
