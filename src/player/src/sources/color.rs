//! A solid-colour [`Source`] (spec §4.2 "Source": colour). Its texture is 1×1 — sampled
//! with `LINEAR`/`CLAMP_TO_EDGE` anywhere it's the colour, at any output size. Ready
//! immediately; never ends; no audio (its gains are stored, and do nothing).

use std::collections::BTreeMap;

use glow::HasContext;

use super::{Source, SourceEvent, unsupported};
use crate::gfx::{Gfx, GlKeepAlive, Tex};
use crate::graph::props::{self, PropValue};
use crate::graph::{ApiError, NodeKind};

/// A solid colour, `[r, g, b]` in 0–255 (the graph's `color` property).
pub struct ColorSource {
    rgb: [u8; 3],
    /// Created lazily on the first `update` (construction has no `Gfx`); `gl` keeps its
    /// context alive so `Drop` can delete it in the right context.
    tex: Option<(Tex, GlKeepAlive)>,
    dirty: bool,
    /// Every writable property's last applied value (seeded with schema defaults).
    props: BTreeMap<String, PropValue>,
    pending: Vec<SourceEvent>,
}

fn clamp_u8(x: f64) -> u8 {
    x.round().clamp(0.0, 255.0) as u8
}

impl ColorSource {
    pub fn new(rgb: [u8; 3]) -> ColorSource {
        let mut props = BTreeMap::new();
        for (name, pd) in props::schema_for_kind(NodeKind::Source) {
            if !pd.readonly {
                props.insert(name.to_string(), pd.default);
            }
        }
        props.insert("kind".into(), PropValue::Str("color".into()));
        props.insert(
            "color".into(),
            PropValue::List(rgb.iter().map(|&c| c as f64).collect()),
        );
        ColorSource {
            rgb,
            tex: None,
            dirty: true,
            props,
            pending: vec![SourceEvent::Ready],
        }
    }
}

impl Source for ColorSource {
    fn kind(&self) -> &'static str {
        "color"
    }

    fn update(&mut self, gfx: &Gfx) -> bool {
        if !self.dirty {
            return false;
        }
        let (tex, _) = self
            .tex
            .get_or_insert_with(|| (gfx.tex(1, 1), gfx.keep_alive()));
        let fbo = gfx.fbo(tex);
        let [r, g, b] = self.rgb.map(|c| c as f32 / 255.0);
        unsafe {
            gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
            gfx.gl.disable(glow::SCISSOR_TEST);
            gfx.gl.clear_color(r, g, b, 1.0);
            gfx.gl.clear(glow::COLOR_BUFFER_BIT);
            gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            gfx.gl.delete_framebuffer(fbo.id);
        }
        self.dirty = false;
        true
    }

    fn texture(&self) -> Option<&Tex> {
        self.tex.as_ref().map(|(t, _)| t)
    }

    fn size(&self) -> (u32, u32) {
        self.tex.as_ref().map_or((0, 0), |(t, _)| (t.w, t.h))
    }

    fn apply(&mut self, prop: &str, v: &PropValue) -> Result<(), ApiError> {
        // Same gate as the graph (also rejects unknown `gain.<slot>` names).
        props::validate_value(NodeKind::Source, prop, v, true)?;
        match (prop, v) {
            ("kind", PropValue::Str(k)) if k != "color" => {
                return Err(unsupported(format!(
                    "can't change a live color source to {k:?}; create a new source"
                )));
            }
            ("color", PropValue::List(c)) => {
                let rgb = [clamp_u8(c[0]), clamp_u8(c[1]), clamp_u8(c[2])];
                if rgb != self.rgb {
                    self.rgb = rgb;
                    self.dirty = true;
                }
            }
            // Every other writable property (transport, gains, decoder knobs) is accepted
            // and stored so a global/alias `set` never fails on a colour layer; a still
            // colour has nothing for them to do.
            _ => {}
        }
        self.props.insert(prop.to_string(), v.clone());
        Ok(())
    }

    fn read(&self, prop: &str) -> Option<PropValue> {
        match prop {
            "ready" => Some(PropValue::Bool(true)),
            "width" | "height" => Some(PropValue::I64(1)),
            "duration" | "time_pos" => None,
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

impl Drop for ColorSource {
    fn drop(&mut self) {
        if let Some((tex, gl)) = self.tex.take() {
            let cur = gl.make_current();
            if cur.is_current() {
                gl.delete_texture(&tex);
            }
        }
    }
}
