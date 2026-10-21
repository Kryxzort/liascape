//! A held still copy of another source's frame (R34): what reveal/frozen transitions show
//! as their outgoing side while it is held. A shared A must keep playing on its other
//! output, and even a paused mpv source still presents queued frames after the pause
//! (measured 2–3 frames, ~100 ms late) — a copy is the only picture guaranteed not to move.
//!
//! Graph shape: a `Source` node with `kind = "snapshot"` and read-only `of` = the source
//! node id whose texture is copied. [`super::SourceHost`] builds it the moment it first
//! sees the node, by copying `of`'s current texture (`glBlitFramebuffer`, GL 3.3 core) —
//! the copy keeps texture row order, so it's image-top-at-`t = 0` like every source
//! (R25). `Ready` immediately; never changes, never ends, no audio (gains are stored and do
//! nothing).

use std::collections::BTreeMap;

use glow::HasContext;

use super::{Source, SourceEvent, unsupported};
use crate::gfx::{Gfx, GlKeepAlive, Tex};
use crate::graph::props::{self, PropValue};
use crate::graph::{ApiError, NodeKind};

/// A frozen copy of another source's texture, taken at construction.
pub struct SnapshotSource {
    tex: Option<(Tex, GlKeepAlive)>,
    of: String,
    props: BTreeMap<String, PropValue>,
    pending: Vec<SourceEvent>,
}

impl SnapshotSource {
    /// Copy `from` (the current texture of source `of`, if it has one yet) through `gfx`'s
    /// context. `from = None` gives a snapshot with no texture (draws transparent, R19).
    pub fn new(gfx: &Gfx, of: &str, from: Option<&Tex>) -> SnapshotSource {
        let mut props = BTreeMap::new();
        for (name, pd) in props::schema_for_kind(NodeKind::Source) {
            if !pd.readonly {
                props.insert(name.to_string(), pd.default);
            }
        }
        props.insert("kind".into(), PropValue::Str("snapshot".into()));
        let tex = from.and_then(|src| {
            let keep = gfx.keep_alive();
            let cur = keep.make_current();
            if !cur.is_current() {
                return None;
            }
            let dst = gfx.tex(src.w, src.h);
            let read = gfx.fbo(src);
            let draw = gfx.fbo(&dst);
            let (w, h) = (src.w as i32, src.h as i32);
            unsafe {
                gfx.gl
                    .bind_framebuffer(glow::READ_FRAMEBUFFER, Some(read.id));
                gfx.gl
                    .bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(draw.id));
                gfx.gl.disable(glow::SCISSOR_TEST);
                gfx.gl.blit_framebuffer(
                    0,
                    0,
                    w,
                    h,
                    0,
                    0,
                    w,
                    h,
                    glow::COLOR_BUFFER_BIT,
                    glow::NEAREST,
                );
                gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
                gfx.gl.delete_framebuffer(read.id);
                gfx.gl.delete_framebuffer(draw.id);
            }
            drop(cur);
            Some((dst, keep))
        });
        SnapshotSource {
            tex,
            of: of.to_string(),
            props,
            pending: vec![SourceEvent::Ready],
        }
    }

    /// The source node this is a copy of.
    pub fn of(&self) -> &str {
        &self.of
    }
}

impl Source for SnapshotSource {
    fn kind(&self) -> &'static str {
        "snapshot"
    }

    fn update(&mut self, _gfx: &Gfx) -> bool {
        false
    }

    fn texture(&self) -> Option<&Tex> {
        self.tex.as_ref().map(|(t, _)| t)
    }

    fn size(&self) -> (u32, u32) {
        self.tex.as_ref().map_or((0, 0), |(t, _)| (t.w, t.h))
    }

    fn apply(&mut self, prop: &str, v: &PropValue) -> Result<(), ApiError> {
        props::validate_value(NodeKind::Source, prop, v, true)?;
        if let ("kind", PropValue::Str(k)) = (prop, v)
            && k != "snapshot"
        {
            return Err(unsupported(format!(
                "can't change a live snapshot source to {k:?}; create a new source"
            )));
        }
        // Everything else is stored (an alias/global `set` never fails on a held still)
        // and does nothing.
        self.props.insert(prop.to_string(), v.clone());
        Ok(())
    }

    fn read(&self, prop: &str) -> Option<PropValue> {
        let (w, h) = self.size();
        match prop {
            "ready" => Some(PropValue::Bool(true)),
            "of" => Some(PropValue::Str(self.of.clone())),
            "width" if w > 0 => Some(PropValue::I64(w as i64)),
            "height" if h > 0 => Some(PropValue::I64(h as i64)),
            "width" | "height" | "duration" | "time_pos" => None,
            _ if prop.starts_with("gain.") => {
                Some(self.props.get(prop).cloned().unwrap_or(PropValue::F64(0.0)))
            }
            _ => self.props.get(prop).cloned(),
        }
    }

    fn poll_events(&mut self) -> Vec<SourceEvent> {
        std::mem::take(&mut self.pending)
    }
}

impl Drop for SnapshotSource {
    fn drop(&mut self) {
        if let Some((tex, gl)) = self.tex.take() {
            let cur = gl.make_current();
            if cur.is_current() {
                gl.delete_texture(&tex);
            }
        }
    }
}
