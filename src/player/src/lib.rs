//! lp-player library crate: modules shared between the `lp-player` binary and its tests.
//!
//! Modules so far: the event log (`log`), audio units (`units`), the audio bus + meter
//! (`audio`), clocks (`clock`), the Animator (`anim`), the node graph (`graph`), the GPU core
//! (`gfx`), the libmpv wrapper (`mpv`), the frame sources (`sources`), the recipes built from
//! them (`recipes`), the running player (`runtime`) with its outputs (`headless`, `wl`) and
//! their redraw policy (`redraw`), command API (`api`), probes (`probe`), socket/state paths
//! (`paths`), shell client (`ctl`), the supervisor (`supervise`) and the state snapshot
//! (`snapshot`). Later tasks append modules here — see
//! `.claude/rules/player-core.md` for the map.

pub mod anim;
pub mod api;
pub mod audio;
pub mod clock;
pub mod ctl;
pub mod gfx;
pub mod graph;
pub mod headless;
pub mod log;
pub mod mpv;
pub mod onset;
pub mod paths;
pub mod probe;
pub mod recipes;
pub mod redraw;
pub mod runtime;
pub mod snapshot;
pub mod sources;
pub mod supervise;
pub mod units;
pub mod wl;
