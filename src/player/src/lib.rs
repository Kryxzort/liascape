//! lp-player library crate: modules shared between the `lp-player` binary and its tests.
//!
//! This task wires up the event log (`log`) and audio units (`units`). Later tasks
//! append modules here (clock, graph, gfx, mpv, …) — see `.claude/rules/player-core.md`
//! for the map.

pub mod log;
pub mod units;
