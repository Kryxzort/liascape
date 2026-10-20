//! lp-player library crate: modules shared between the `lp-player` binary and its tests.
//!
//! This task only wires up the event log (`log`). Later tasks append modules here
//! (units, clock, graph, gfx, mpv, …) — see `.claude/rules/player-core.md` for the map.

pub mod log;
