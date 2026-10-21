//! Sources (spec §4.2 "Source"): the things that produce the textures the compositor
//! (`gfx::compose`) draws and the audio streams whose dB gains recipes ramp.
//!
//! - [`MpvSource`] (`mpv.rs`) — video and image files through libmpv's render API.
//! - [`ColorSource`] (`color.rs`) — a solid colour.
//! - [`SnapshotSource`] (`snapshot.rs`) — a held still copy of another source's frame
//!   (R34: what reveal/frozen show for an outgoing side that keeps playing elsewhere).
//! - [`SourceHost`] (`host.rs`) — owns one live source per graph `Source` node: opens/
//!   drops them as nodes come and go, forwards property changes, mirrors observed values
//!   back into the graph, and collects events (R32).
//!
//! Every source implements [`Source`]. [`SourceHost`] owns them: it forwards graph
//! property changes (`graph::Graph::drain_changes`) to [`Source::apply`], calls
//! [`Source::update`] each tick (never blocks), and collects [`Source::poll_events`] for
//! the recipes and the command API's `ready`/`ended`/`position`/`error` events. See
//! `.claude/rules/player-core.md` § Sources.

pub mod color;
pub mod host;
pub mod mpv;
pub mod reaper;
pub mod snapshot;

pub use color::ColorSource;
pub use host::SourceHost;
pub use mpv::{MpvSource, StepStatus};
pub use snapshot::SnapshotSource;

use crate::gfx::{Gfx, Tex};
use crate::graph::{ApiError, PropValue};

/// What a source reports (spec §4.2: `ready` (first frame), `ended`, `error`, `position`).
#[derive(Debug, Clone, PartialEq)]
pub enum SourceEvent {
    /// The first frame of the current file is in [`Source::texture`] (once per load).
    Ready,
    /// Playback reached the end (once per play-through; never with `loop = true`, never
    /// for an image). The last frame stays in the texture.
    Ended,
    /// Playback position in seconds (rate-limited to ~10 Hz).
    Position(f64),
    /// Loading or decoding failed (or the source can't run at all); `reason` names the
    /// path. The source is broken until something changes.
    Error { reason: String },
    /// A property write was refused (synchronously by `apply`, or later by mpv's async
    /// reply) and reverted; the source itself is fine and keeps playing (R45). `prop` is
    /// the graph property (`gain` for the summed gain push).
    Rejected { prop: String, reason: String },
}

/// One frame producer. Property names and value types are the graph's `Source` schema
/// (`graph::props`); `apply` validates through the same gate the graph uses.
pub trait Source {
    /// `"video"`, `"image"`, `"color"` or `"snapshot"`.
    fn kind(&self) -> &'static str;
    /// Render a new frame into the texture if one is available. **Never blocks**; returns
    /// whether the texture changed.
    fn update(&mut self, gfx: &Gfx) -> bool;
    /// The last good frame — kept forever once one exists (a stalled source never goes
    /// black; R19's other half). `None` until the first frame.
    fn texture(&self) -> Option<&Tex>;
    /// The texture's size, `(0, 0)` before the first frame.
    fn size(&self) -> (u32, u32);
    /// Apply one property change live.
    fn apply(&mut self, prop: &str, v: &PropValue) -> Result<(), ApiError>;
    /// Read one property; `None` = unset/unknown (e.g. an image's `duration`).
    fn read(&self, prop: &str) -> Option<PropValue>;
    /// Drain the events produced since the last call.
    fn poll_events(&mut self) -> Vec<SourceEvent>;
    /// Start tearing this source down without blocking (R51) — called when its node is
    /// gone. `true` = it can be dropped right away; `false` = keep it (silent) and poll
    /// [`Source::teardown_ready`] until it can.
    fn begin_teardown(&mut self) -> bool {
        true
    }
    /// After `begin_teardown` returned `false`: can it be dropped now without blocking?
    fn teardown_ready(&mut self) -> bool {
        true
    }
    /// The libmpv source behind this, if it is one (probes, stepped mode).
    fn as_mpv(&self) -> Option<&MpvSource> {
        None
    }
    fn as_mpv_mut(&mut self) -> Option<&mut MpvSource> {
        None
    }
}

pub(crate) fn unsupported(msg: impl Into<String>) -> ApiError {
    ApiError {
        code: "unsupported",
        message: msg.into(),
        hint: "see .claude/rules/player-core.md \u{a7} Sources".to_string(),
    }
}

pub(crate) fn bad_type(msg: impl Into<String>) -> ApiError {
    ApiError {
        code: "bad_type",
        message: msg.into(),
        hint: "see .claude/rules/player-core.md \u{a7} Sources".to_string(),
    }
}

pub(crate) fn out_of_range(msg: impl Into<String>) -> ApiError {
    ApiError {
        code: "out_of_range",
        message: msg.into(),
        hint: "see .claude/rules/player-core.md \u{a7} Sources".to_string(),
    }
}

pub(crate) fn io_error(msg: impl Into<String>) -> ApiError {
    ApiError {
        code: "io",
        message: msg.into(),
        hint: "see .claude/rules/player-core.md \u{a7} Sources".to_string(),
    }
}

/// A numeric [`PropValue`] as `f64` (the schema already rejected non-numbers).
pub(crate) fn num(v: &PropValue) -> f64 {
    match v {
        PropValue::F64(f) => *f,
        PropValue::I64(i) => *i as f64,
        _ => 0.0,
    }
}
