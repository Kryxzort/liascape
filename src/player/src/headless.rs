//! Outputs (spec §4.2 "Output", §9 "headless deterministic mode"): the [`OutputBackend`]
//! abstraction the runtime renders through, and its first implementation — [`Headless`],
//! virtual outputs rendered offscreen (R46). The Wayland backend (`crate::wl`, Task 13:
//! one layer-shell surface per `wl_output`, its own fd in the loop, presents paced by
//! frame callbacks) implements the same trait and feeds the same hotplug path.
//!
//! Headless outputs are named `VIRTUAL-1`, `VIRTUAL-2`, … in `--outputs` order; the
//! `headless.add_output` / `headless.remove_output` verbs hotplug more at any time.
//! Presenting is a no-op: an output's picture is its offscreen texture, which `capture`
//! writes to PNG.

use glow::HasContext;

use crate::gfx::{Fbo, Gfx, Tex};
use crate::graph::ApiError;

/// One output as the backend sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputInfo {
    /// Connector name (`DP-1`, `VIRTUAL-1`); the graph node is `out:<name>`.
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Refresh rounded to whole Hz (the graph's `refresh_hz`).
    pub hz: u32,
    /// Exact refresh in mHz (`wl_output` mode; headless: `hz × 1000`) — frame pacing.
    pub refresh_mhz: u32,
}

/// Hotplug, as the runtime consumes it ([`OutputBackend::take_changes`]).
#[derive(Debug, Clone, PartialEq)]
pub enum OutputChange {
    Added(OutputInfo),
    Removed(String),
    /// Same output, new size/refresh (a mode change, a configure with another size).
    Changed(OutputInfo),
}

/// Frame pacing state of one output on a paced backend ([`OutputBackend::frame_state`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameState {
    /// It can take a frame now: configured, a render target exists, no frame callback
    /// outstanding.
    pub ready: bool,
    /// A frame callback is outstanding (the last present hasn't been shown yet).
    pub pending: bool,
    /// Frame callbacks received so far.
    pub callbacks: u64,
    /// Presents that failed (`eglSwapBuffers`) since the output appeared (Task 16).
    pub failures: u64,
    /// After a failed present the output backs off (100 ms, then 1 s while it keeps
    /// failing): how long until it may try again; `None` = not backing off.
    pub retry_in_ms: Option<f64>,
}

/// The pointer over an output's surface ([`OutputBackend::take_pointer`]): surface
/// pixels, buttons as a bitmask (bit 0 left, 1 right, 2 middle, 3 side, 4 extra).
#[derive(Debug, Clone, PartialEq)]
pub struct PointerSample {
    pub output: String,
    pub x: f64,
    pub y: f64,
    pub buttons: u32,
}

/// What the runtime needs from a set of outputs. One implementation per platform:
/// [`Headless`] and the Wayland backend (`crate::wl::Wayland`).
pub trait OutputBackend {
    /// `"headless"` / `"wayland"` (for `hello`/`state`).
    fn kind(&self) -> &'static str;
    /// Every output currently present.
    fn outputs(&self) -> Vec<OutputInfo>;
    /// Outputs added/removed since the last call, in order.
    fn take_changes(&mut self) -> Vec<OutputChange>;
    /// The framebuffer the compositor draws output `name` into.
    fn target(&self, name: &str) -> Option<&Fbo>;
    /// Output `name`'s current picture (what `capture` writes).
    fn picture(&self, name: &str) -> Option<&Tex>;
    /// Show what was just drawn into [`target`](Self::target) (headless: nothing to do).
    fn present(&mut self, gfx: &Gfx, name: &str) -> Result<(), String>;
    /// Presents are paced by the compositor (Wayland frame callbacks): the runtime then
    /// draws an output only when [`frame_state`](Self::frame_state) says it can take a
    /// frame and its picture changed (`crate::redraw`). `false` (headless) = compose every
    /// output on every tick.
    fn paced(&self) -> bool {
        false
    }
    /// Pacing state of output `name` (`None` on an unpaced backend).
    fn frame_state(&self, _name: &str) -> Option<FrameState> {
        None
    }
    /// Do the GPU-side work hotplug and configures left pending (create/resize window
    /// targets, free removed outputs with the context current). Called before every
    /// [`take_changes`](Self::take_changes).
    fn process(&mut self, _gfx: &Gfx) {}
    /// Outputs that need a fresh frame whatever their content (configured, resized,
    /// re-created surface), since the last call.
    fn take_redraws(&mut self) -> Vec<String> {
        Vec::new()
    }
    /// Move output `name` to compositor layer `layer` (`background|bottom|top|overlay`),
    /// live (`out:<c>.layer`). Headless: nothing to move.
    fn set_layer(&mut self, _name: &str, _layer: &str) -> Result<(), String> {
        Ok(())
    }
    /// Pointer samples since the last call (`out:<c>.pointer`).
    fn take_pointer(&mut self) -> Vec<PointerSample> {
        Vec::new()
    }
    /// The headless backend, for the `headless.*` verbs.
    fn as_headless_mut(&mut self) -> Option<&mut Headless> {
        None
    }
    /// The Wayland backend, for its event-queue dispatch.
    fn as_wayland_mut(&mut self) -> Option<&mut crate::wl::Wayland> {
        None
    }
}

struct VOut {
    info: OutputInfo,
    tex: Tex,
    fbo: Fbo,
}

/// Virtual outputs, each an offscreen RGBA8 texture + FBO.
pub struct Headless {
    outs: Vec<VOut>,
    changes: Vec<OutputChange>,
    /// `--redraw-policy content` (Task 16): pace like Wayland — present only when the redraw
    /// policy (`crate::redraw`) says the picture changed; every output can always take a
    /// frame (there are no frame callbacks). Default: compose every output every tick.
    content_paced: bool,
}

fn bad(msg: String) -> ApiError {
    ApiError {
        code: "out_of_range",
        message: msg,
        hint: "outputs are `<W>x<H>@<Hz>` with W,H in 1–16384 and Hz in 1–1000; names are \
               non-empty, without `.`, `:`, `*` or spaces; `lp-player ctl state` lists them"
            .into(),
    }
}

/// Parse `--outputs` (`1920x1080@60,640x360@144`) into `(width, height, hz)` triples.
pub fn parse_outputs(s: &str) -> Result<Vec<(u32, u32, u32)>, String> {
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let err = || format!("bad output {part:?}: expected <W>x<H>@<Hz>, e.g. 1920x1080@60");
        let (size, hz) = part.split_once('@').ok_or_else(err)?;
        let (w, h) = size.split_once('x').ok_or_else(err)?;
        let (w, h, hz): (u32, u32, u32) = (
            w.parse().map_err(|_| err())?,
            h.parse().map_err(|_| err())?,
            hz.parse().map_err(|_| err())?,
        );
        check_dims(w, h, hz).map_err(|e| e.message)?;
        out.push((w, h, hz));
    }
    if out.is_empty() {
        return Err("--outputs needs at least one <W>x<H>@<Hz>".into());
    }
    Ok(out)
}

fn check_dims(w: u32, h: u32, hz: u32) -> Result<(), ApiError> {
    if !(1..=16384).contains(&w) || !(1..=16384).contains(&h) || !(1..=1000).contains(&hz) {
        return Err(bad(format!("output {w}x{h}@{hz} is out of range")));
    }
    Ok(())
}

impl Headless {
    /// `VIRTUAL-1`… one per spec, each queued as an [`OutputChange::Added`].
    pub fn new(gfx: &Gfx, specs: &[(u32, u32, u32)]) -> Headless {
        let mut h = Headless {
            outs: Vec::new(),
            changes: Vec::new(),
            content_paced: false,
        };
        for (i, &(w, ht, hz)) in specs.iter().enumerate() {
            let info = OutputInfo {
                name: format!("VIRTUAL-{}", i + 1),
                width: w,
                height: ht,
                hz,
                refresh_mhz: hz * 1000,
            };
            h.add(gfx, info).expect("validated by parse_outputs");
        }
        h
    }

    /// Use the content redraw policy instead of composing every tick (`--redraw-policy
    /// content`; a test/diagnostic knob for the policy without a compositor).
    pub fn set_content_paced(&mut self, on: bool) {
        self.content_paced = on;
    }

    /// Hotplug a virtual output (`headless.add_output`).
    pub fn add(&mut self, gfx: &Gfx, info: OutputInfo) -> Result<(), ApiError> {
        let n = &info.name;
        if n.is_empty() || n.contains(['.', ':', '*', ' ', '\t', '\n']) {
            return Err(bad(format!(
                "output name {n:?} is not a valid connector name"
            )));
        }
        check_dims(info.width, info.height, info.hz)?;
        if self.outs.iter().any(|o| &o.info.name == n) {
            return Err(ApiError {
                code: "unsupported",
                message: format!("output {n:?} already exists"),
                hint: "`lp-player ctl state` lists the outputs; remove it first with \
                       headless.remove_output"
                    .into(),
            });
        }
        let tex = gfx.tex(info.width, info.height);
        let fbo = gfx.fbo(&tex);
        self.changes.push(OutputChange::Added(info.clone()));
        self.outs.push(VOut { info, tex, fbo });
        Ok(())
    }

    /// Unplug a virtual output (`headless.remove_output`).
    pub fn remove(&mut self, gfx: &Gfx, name: &str) -> Result<(), ApiError> {
        let Some(i) = self.outs.iter().position(|o| o.info.name == name) else {
            return Err(ApiError {
                code: "no_such_node",
                message: format!("no headless output {name:?}"),
                hint: "`lp-player ctl state` lists the outputs (`out:<name>`)".into(),
            });
        };
        let o = self.outs.remove(i);
        unsafe {
            gfx.gl.delete_framebuffer(o.fbo.id);
            gfx.gl.delete_texture(o.tex.id);
        }
        self.changes.push(OutputChange::Removed(name.to_string()));
        Ok(())
    }
}

impl OutputBackend for Headless {
    fn kind(&self) -> &'static str {
        "headless"
    }

    fn outputs(&self) -> Vec<OutputInfo> {
        self.outs.iter().map(|o| o.info.clone()).collect()
    }

    fn take_changes(&mut self) -> Vec<OutputChange> {
        std::mem::take(&mut self.changes)
    }

    fn target(&self, name: &str) -> Option<&Fbo> {
        self.outs
            .iter()
            .find(|o| o.info.name == name)
            .map(|o| &o.fbo)
    }

    fn picture(&self, name: &str) -> Option<&Tex> {
        self.outs
            .iter()
            .find(|o| o.info.name == name)
            .map(|o| &o.tex)
    }

    fn present(&mut self, _gfx: &Gfx, _name: &str) -> Result<(), String> {
        Ok(())
    }

    fn paced(&self) -> bool {
        self.content_paced
    }

    fn frame_state(&self, name: &str) -> Option<FrameState> {
        (self.content_paced && self.outs.iter().any(|o| o.info.name == name)).then_some(
            FrameState {
                ready: true,
                pending: false,
                callbacks: 0,
                failures: 0,
                retry_in_ms: None,
            },
        )
    }

    fn as_headless_mut(&mut self) -> Option<&mut Headless> {
        Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_outputs_forms() {
        assert_eq!(
            parse_outputs("640x360@60,320x180@144").unwrap(),
            vec![(640, 360, 60), (320, 180, 144)]
        );
        assert!(parse_outputs("").is_err());
        assert!(parse_outputs("640x360").is_err());
        assert!(parse_outputs("0x360@60").is_err());
        assert!(parse_outputs("640x360@0").is_err());
    }
}
