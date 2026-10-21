//! Sources (spec §4.2 "Source"): the things that produce the textures the compositor
//! (`gfx::compose`) draws and the audio streams whose dB gains recipes ramp.
//!
//! - [`MpvSource`] (`mpv.rs`) — video and image files through libmpv's render API.
//! - [`ColorSource`] (`color.rs`) — a solid colour.
//!
//! Every source implements [`Source`]. The runtime (Task 12) owns them, forwards graph
//! property changes (`graph::Graph::drain_changes`) to [`Source::apply`], calls
//! [`Source::update`] each tick (never blocks), and turns [`Source::poll_events`] into
//! the command API's `ready`/`ended`/`position`/`error` events. See
//! `.claude/rules/player-core.md` § Sources.

pub mod color;
pub mod mpv;

pub use color::ColorSource;
pub use mpv::MpvSource;

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
    /// Loading or decoding failed; `reason` names the path.
    Error { reason: String },
}

/// One frame producer. Property names and value types are the graph's `Source` schema
/// (`graph::props`); `apply` validates through the same gate the graph uses.
pub trait Source {
    /// `"video"`, `"image"` or `"color"`.
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
}

pub(crate) fn unsupported(msg: impl Into<String>) -> ApiError {
    ApiError {
        code: "unsupported",
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
