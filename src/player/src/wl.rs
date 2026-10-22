//! Wayland outputs (spec §4.2 "Output", §5.1 "Graphics"; Task 13): one
//! `zwlr_layer_surface_v1` per `wl_output`, rendered through the one EGL context
//! ([`Gfx::new_wayland`]) and presented on each output's own frame callbacks.
//!
//! - **Surface:** namespace `lp-player`, layer from `out:<c>.layer` (default `background`;
//!   moved live with `set_layer` — layer-shell v2+, else the surface is re-created),
//!   anchored to all four edges, exclusive zone −1 (ignores other surfaces' zones, covers
//!   the whole output), keyboard interactivity none, input region = the whole surface
//!   (pointer accepted for Phase 2's mouse-reactive sources), opaque region = the whole
//!   surface (every pixel is written with alpha 1).
//! - **Names** come from `wl_output` v4 `name` (`DP-1`); without one, `WL-<global id>`.
//!   Size = the current mode (rotated by the transform), refresh = the current mode's
//!   mHz rounded to Hz (`refresh_hz`, 143 981 mHz → 144); the exact mHz paces the probe.
//! - **Rendering:** each output owns an offscreen RGBA8 texture + FBO (`target` — the
//!   composer draws there; also `picture` for `capture`) and a [`WindowTarget`] on its
//!   `wl_surface` (swap interval 0). `present` blits the FBO to the window's back buffer,
//!   forces alpha to 1, requests a frame callback and swaps (which commits). The output
//!   can take its next frame when that callback arrives ([`FrameState::ready`]). A failed
//!   swap (no commit) keeps the one requested callback for the next commit — never a
//!   second request — and backs off ([`present_backoff`]: 100 ms, then 1 s while it keeps
//!   failing; `frames` probe `present_failed`/`retry_in_ms`).
//! - **Hotplug:** a new `wl_output` → a surface + [`OutputChange::Added`]; a removed one →
//!   [`OutputChange::Removed`] and its GPU side freed in [`OutputBackend::process`] with the
//!   context current (surfaceless), window target before `wl_surface`. A `closed` layer
//!   surface whose output still exists is re-created. The runtime runs the same add/remove
//!   path as headless hotplug (R59 adopt / R60 retire-park).
//! - **Pointer:** enter/leave/motion/press/release → [`PointerSample`]s (the runtime stores
//!   `out:<c>.pointer` `[x, y, buttons]`) and `input.pointer` debug events (motion at most
//!   10/s per output, `suppressed` counts the rest). The cursor is set to the default
//!   shape on enter (`wp_cursor_shape_v1` when the compositor has it).
//!
//! See `.claude/rules/player-core.md` § Wayland.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use glow::HasContext;
use serde_json::json;
use smithay_client_toolkit as sctk;

use sctk::compositor::{CompositorHandler, CompositorState, FrameCallbackData, Region};
use sctk::output::{OutputHandler, OutputState};
use sctk::reexports::calloop_wayland_source::WaylandSource;
use sctk::reexports::client::globals::registry_queue_init;
use sctk::reexports::client::protocol::{wl_output, wl_pointer, wl_seat, wl_surface};
use sctk::reexports::client::{Connection, Proxy, QueueHandle};
use sctk::reexports::protocols::wp::cursor_shape::v1::client::wp_cursor_shape_device_v1::{
    Shape, WpCursorShapeDeviceV1,
};
use sctk::registry::{ProvidesRegistryState, RegistryState};
use sctk::seat::pointer::cursor_shape::CursorShapeManager;
use sctk::seat::pointer::{PointerEvent, PointerEventKind, PointerHandler};
use sctk::seat::{Capability, SeatHandler, SeatState};
use sctk::shell::WaylandSurface;
use sctk::shell::wlr_layer::{
    Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
    LayerSurfaceConfigure, SurfaceKind,
};

use crate::gfx::{Fbo, Gfx, Tex, WindowTarget};
use crate::headless::{FrameState, OutputBackend, OutputChange, OutputInfo, PointerSample};
use crate::log::{self, Level};

/// The layer-shell namespace every lp-player surface uses (`hyprctl layers`).
pub const NAMESPACE: &str = "lp-player";
/// Pointer motion events logged per output at most this often.
const MOTION_LOG_EVERY: Duration = Duration::from_millis(100);

// ------------------------------------------------------------------ pure mappings

/// The connector name for an output: `wl_output` v4 `name`, made safe for a node id
/// (`.`, `:`, `*` and whitespace → `-`); `WL-<global id>` when there is none.
pub fn output_name(name: Option<&str>, global_id: u32) -> String {
    match name.map(str::trim) {
        Some(n) if !n.is_empty() => n
            .chars()
            .map(|c| {
                if c == '.' || c == ':' || c == '*' || c.is_whitespace() {
                    '-'
                } else {
                    c
                }
            })
            .collect(),
        _ => format!("WL-{global_id}"),
    }
}

/// Whole Hz from a mode's mHz (143 981 → 144, 239 760 → 240); unknown (≤ 0) → 60.
pub fn hz_from_mhz(mhz: i32) -> u32 {
    if mhz <= 0 {
        60
    } else {
        ((mhz as f64 / 1000.0).round() as u32).max(1)
    }
}

/// The exact refresh in mHz; unknown (≤ 0) → 60 000.
pub fn mhz_or_default(mhz: i32) -> u32 {
    if mhz <= 0 { 60_000 } else { mhz as u32 }
}

/// A mode's pixel size as the surface sees it: swapped for a 90°/270° transform.
pub fn oriented_dims(dims: (i32, i32), transform: wl_output::Transform) -> (u32, u32) {
    use wl_output::Transform as T;
    let (w, h) = (dims.0.max(0) as u32, dims.1.max(0) as u32);
    match transform {
        T::_90 | T::_270 | T::Flipped90 | T::Flipped270 => (h, w),
        _ => (w, h),
    }
}

/// `out:<c>.layer` → the layer-shell layer.
pub fn layer_from_str(s: &str) -> Option<Layer> {
    match s {
        "background" => Some(Layer::Background),
        "bottom" => Some(Layer::Bottom),
        "top" => Some(Layer::Top),
        "overlay" => Some(Layer::Overlay),
        _ => None,
    }
}

/// A Linux input button code (`BTN_*`) → its bit in `out:<c>.pointer`'s mask.
/// How long an output waits before presenting again after `streak` failed presents in a
/// row: 100 ms after the first, then 1 s (no swap storm at the refresh rate).
pub fn present_backoff(streak: u32) -> Duration {
    match streak {
        0 => Duration::ZERO,
        1 => Duration::from_millis(100),
        _ => Duration::from_secs(1),
    }
}

pub fn button_bit(code: u32) -> u32 {
    match code {
        0x110 => 1,  // BTN_LEFT
        0x111 => 2,  // BTN_RIGHT
        0x112 => 4,  // BTN_MIDDLE
        0x113 => 8,  // BTN_SIDE
        0x114 => 16, // BTN_EXTRA
        _ => 0,
    }
}

// ------------------------------------------------------------------ state

/// The GPU side of one output's surface. Dropped before the surface it renders to
/// (field order in [`WlOut`] / [`Dead`]): the `wl_egl_window` must go first.
struct Gl {
    target: WindowTarget,
    tex: Tex,
    fbo: Fbo,
    /// Buffer size in pixels.
    size: (u32, u32),
}

/// A surface on its way out (output removed, or the compositor closed it): freed in
/// `process` with the context current.
struct Dead {
    gl: Option<Gl>,
    _surface: Option<LayerSurface>,
}

struct WlOut {
    info: OutputInfo,
    wl_output: wl_output::WlOutput,
    scale: i32,
    layer: Layer,
    // `gl` before `surface`: drop order.
    gl: Option<Gl>,
    surface: Option<LayerSurface>,
    /// Surface size from the last configure (logical); `None` until the first.
    configured: Option<(u32, u32)>,
    frame_pending: bool,
    /// A frame callback was requested on the surface but no commit has carried it yet
    /// (the swap failed): the next present must not request another one.
    frame_armed: bool,
    callbacks: u64,
    /// Failed presents in a row, total, and when the next attempt may run.
    fail_streak: u32,
    failures: u64,
    retry_at: Option<Instant>,
    /// The buffer size a window target last failed to build at (not retried until the
    /// size changes — no error storm).
    gl_failed: Option<(u32, u32)>,
    /// Wants a fresh frame (reported once via `take_redraws`).
    redraw: bool,
    buttons: u32,
    motion_logged: Option<Instant>,
    motion_suppressed: u64,
}

impl WlOut {
    fn is_surface(&self, s: &wl_surface::WlSurface) -> bool {
        self.surface.as_ref().is_some_and(|l| l.wl_surface() == s)
    }

    /// A present failed: back off ([`present_backoff`]) and say when it retries.
    fn present_failed(&mut self, e: String) -> String {
        self.fail_streak += 1;
        self.failures += 1;
        let back = present_backoff(self.fail_streak);
        self.retry_at = Some(Instant::now() + back);
        format!(
            "{e} (failure {} in a row; retrying in {} ms)",
            self.fail_streak,
            back.as_millis()
        )
    }

    /// The surface is new (or re-created): nothing pending, nothing armed.
    fn reset_frames(&mut self) {
        self.frame_pending = false;
        self.frame_armed = false;
        self.retry_at = None;
        self.fail_streak = 0;
    }
}

/// The sctk handler state (the event queue's data): outputs, seats, pointer.
pub struct WlState {
    registry: RegistryState,
    output_state: OutputState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    seat_state: SeatState,
    cursor_shape: Option<CursorShapeManager>,
    qh: QueueHandle<WlState>,
    outs: Vec<WlOut>,
    dead: Vec<Dead>,
    changes: Vec<OutputChange>,
    pointers: Vec<(wl_pointer::WlPointer, Option<WpCursorShapeDeviceV1>)>,
    samples: Vec<PointerSample>,
}

/// The Wayland [`OutputBackend`].
pub struct Wayland {
    conn: Connection,
    pub(crate) state: WlState,
}

fn wl_err(what: &str, e: impl std::fmt::Display) -> String {
    format!("{what}: {e}")
}

impl Wayland {
    /// Connect to `$WAYLAND_DISPLAY`, bind the globals, and create a surface per output
    /// already present (two roundtrips: output info, then the first configures). The
    /// returned event source goes into the runtime's loop; its queue dispatches into
    /// [`Wayland::state`] (`as_wayland_mut`).
    pub fn connect() -> Result<(Wayland, WaylandSource<WlState>), String> {
        let conn = Connection::connect_to_env().map_err(|e| {
            format!(
                "can't connect to the Wayland display (WAYLAND_DISPLAY={:?}): {e}; run \
                 inside a Wayland session, or use `serve --headless`",
                std::env::var("WAYLAND_DISPLAY").unwrap_or_default()
            )
        })?;
        let (globals, mut queue) =
            registry_queue_init::<WlState>(&conn).map_err(|e| wl_err("wl_registry", e))?;
        let qh = queue.handle();
        let compositor =
            CompositorState::bind(&globals, &qh).map_err(|e| wl_err("wl_compositor", e))?;
        let layer_shell = LayerShell::bind(&globals, &qh).map_err(|e| {
            format!(
                "the compositor has no zwlr_layer_shell_v1 ({e}); lp-player needs a \
                 wlr-layer-shell compositor (Hyprland, Sway, river, Wayfire, KDE) — or run \
                 `serve --headless`"
            )
        })?;
        let cursor_shape = CursorShapeManager::bind(&globals, &qh).ok();
        let mut state = WlState {
            registry: RegistryState::new(&globals),
            output_state: OutputState::new(&globals, &qh),
            compositor,
            layer_shell,
            seat_state: SeatState::new(&globals, &qh),
            cursor_shape,
            qh,
            outs: Vec::new(),
            dead: Vec::new(),
            changes: Vec::new(),
            pointers: Vec::new(),
            samples: Vec::new(),
        };
        for _ in 0..2 {
            queue
                .roundtrip(&mut state)
                .map_err(|e| wl_err("initial roundtrip", e))?;
        }
        log::event(
            "wl",
            Level::Info,
            "wl.connected",
            None,
            json!({
                "outputs": state.outs.iter().map(|o| o.info.name.clone()).collect::<Vec<_>>(),
                "cursor_shape": state.cursor_shape.is_some(),
            }),
        );
        let source = WaylandSource::new(conn.clone(), queue);
        Ok((Wayland { conn, state }, source))
    }

    /// The raw `wl_display*` for [`Gfx::new_wayland`].
    pub fn display_ptr(&self) -> *mut c_void {
        self.conn.backend().display_ptr().cast()
    }

    fn out(&self, name: &str) -> Option<&WlOut> {
        self.state.outs.iter().find(|o| o.info.name == name)
    }
}

impl WlState {
    fn out_mut(&mut self, name: &str) -> Option<&mut WlOut> {
        self.outs.iter_mut().find(|o| o.info.name == name)
    }

    /// Info for `output` from sctk's [`OutputState`]: name, oriented size, refresh.
    fn info_of(&self, output: &wl_output::WlOutput) -> Option<(OutputInfo, i32)> {
        let i = self.output_state.info(output)?;
        let mode = i.modes.iter().find(|m| m.current).or(i.modes.first());
        let (width, height, mhz) = match mode {
            Some(m) => {
                let (w, h) = oriented_dims(m.dimensions, i.transform);
                (w, h, m.refresh_rate)
            }
            None => {
                let (w, h) = i.logical_size.unwrap_or((0, 0));
                let s = i.scale_factor.max(1);
                ((w * s).max(0) as u32, (h * s).max(0) as u32, 0)
            }
        };
        Some((
            OutputInfo {
                name: output_name(i.name.as_deref(), i.id),
                width,
                height,
                hz: hz_from_mhz(mhz),
                refresh_mhz: mhz_or_default(mhz),
            },
            i.scale_factor.max(1),
        ))
    }

    /// A fresh layer surface for `output` on `layer` (initial commit: no buffer).
    fn make_surface(&self, output: &wl_output::WlOutput, layer: Layer) -> LayerSurface {
        let qh = &self.qh;
        let surface = self.compositor.create_surface(qh);
        let ls = self.layer_shell.create_layer_surface(
            qh,
            surface,
            layer,
            Some(NAMESPACE),
            Some(output),
        );
        ls.set_anchor(Anchor::TOP | Anchor::BOTTOM | Anchor::LEFT | Anchor::RIGHT);
        ls.set_exclusive_zone(-1);
        ls.set_keyboard_interactivity(KeyboardInteractivity::None);
        ls.set_size(0, 0);
        // Input region: left at the default (infinite = the whole surface) — pointer in.
        ls.commit();
        ls
    }

    fn bury(&mut self, gl: Option<Gl>, surface: Option<LayerSurface>) {
        if gl.is_some() || surface.is_some() {
            self.dead.push(Dead {
                gl,
                _surface: surface,
            });
        }
    }

    fn pointer_log(&mut self, idx: usize, what: &str, x: f64, y: f64, button: Option<u32>) {
        let o = &mut self.outs[idx];
        if what == "motion" {
            let now = Instant::now();
            if o.motion_logged
                .is_some_and(|t| now.duration_since(t) < MOTION_LOG_EVERY)
            {
                o.motion_suppressed += 1;
                return;
            }
            o.motion_logged = Some(now);
        }
        let suppressed = std::mem::take(&mut o.motion_suppressed);
        log::event(
            "wl",
            Level::Debug,
            "input.pointer",
            None,
            json!({ "output": o.info.name, "event": what, "x": x, "y": y,
                    "buttons": o.buttons, "button": button, "suppressed": suppressed }),
        );
    }
}

// ------------------------------------------------------------------ OutputBackend

impl OutputBackend for Wayland {
    fn kind(&self) -> &'static str {
        "wayland"
    }

    fn outputs(&self) -> Vec<OutputInfo> {
        self.state.outs.iter().map(|o| o.info.clone()).collect()
    }

    fn take_changes(&mut self) -> Vec<OutputChange> {
        std::mem::take(&mut self.state.changes)
    }

    fn target(&self, name: &str) -> Option<&Fbo> {
        self.out(name)?.gl.as_ref().map(|g| &g.fbo)
    }

    fn picture(&self, name: &str) -> Option<&Tex> {
        self.out(name)?.gl.as_ref().map(|g| &g.tex)
    }

    fn present(&mut self, gfx: &Gfx, name: &str) -> Result<(), String> {
        let qh = self.state.qh.clone();
        let o = self
            .state
            .out_mut(name)
            .ok_or_else(|| format!("no output {name:?}"))?;
        let (Some(gl), Some(surface)) = (o.gl.as_ref(), o.surface.as_ref()) else {
            return Err(format!("output {name:?} has no surface yet"));
        };
        if let Err(e) = gl.target.make_current(gfx) {
            return Err(o.present_failed(e));
        }
        let (w, h) = (gl.size.0 as i32, gl.size.1 as i32);
        unsafe {
            let g = &gfx.gl;
            // compose_output leaves the viewport/scissor/blend wherever its last draw was.
            g.disable(glow::SCISSOR_TEST);
            g.viewport(0, 0, w, h);
            g.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(gl.fbo.id));
            g.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
            // The context was first made current surfaceless (`Gfx::new_wayland`), so the
            // default framebuffer's draw/read buffers start as GL_NONE and stay so when a
            // window surface is bound later (EGL_KHR_surfaceless_context): every write to
            // FBO 0 was silently dropped (measured: back buffer read back all zeros).
            g.draw_buffer(glow::BACK);
            g.blit_framebuffer(
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
            g.bind_framebuffer(glow::FRAMEBUFFER, None);
            // The composite is premultiplied over transparent black: its RGB already is
            // the picture over black. Force alpha 1 so the compositor never blends what's
            // below (the opaque region promises it).
            g.color_mask(false, false, false, true);
            g.clear_color(0.0, 0.0, 0.0, 1.0);
            g.clear(glow::COLOR_BUFFER_BIT);
            g.color_mask(true, true, true, true);
        }
        // `wl_surface.frame` is double-buffered state: it must be requested before the
        // commit that eglSwapBuffers makes, and it rides on that commit. If the swap fails
        // (no commit), the request stays pending for the next commit — so request it only
        // when none is armed, and count the frame as pending only once a commit succeeded.
        if !o.frame_armed {
            let ws = surface.wl_surface();
            ws.frame(&qh, FrameCallbackData(ws.clone()));
        }
        let swapped = gl.target.swap(gfx);
        o.frame_armed = true;
        match swapped {
            Ok(()) => {
                o.frame_armed = false;
                o.frame_pending = true;
                o.fail_streak = 0;
                o.retry_at = None;
                Ok(())
            }
            Err(e) => Err(o.present_failed(e)),
        }
    }

    fn paced(&self) -> bool {
        true
    }

    fn frame_state(&self, name: &str) -> Option<FrameState> {
        let o = self.out(name)?;
        let usable = o.gl.is_some() && o.surface.is_some() && o.configured.is_some();
        let now = Instant::now();
        let retry_in = o.retry_at.filter(|t| *t > now).map(|t| t - now);
        Some(FrameState {
            ready: usable && !o.frame_pending && retry_in.is_none(),
            pending: o.frame_pending,
            callbacks: o.callbacks,
            failures: o.failures,
            retry_in_ms: retry_in.map(|d| d.as_secs_f64() * 1000.0),
        })
    }

    fn process(&mut self, gfx: &Gfx) {
        let st = &mut self.state;
        // 1. Free what's dead — window target (EGL surface + wl_egl_window) before its
        //    wl_surface, with the context current but on no surface.
        if !st.dead.is_empty() {
            if st.dead.iter().any(|d| d.gl.is_some())
                && let Err(e) = gfx.make_current_surfaceless()
            {
                log::event(
                    "wl",
                    Level::Warn,
                    "wl.gl_error",
                    None,
                    json!({ "error": e }),
                );
            }
            for d in st.dead.drain(..) {
                if let Some(gl) = d.gl {
                    unsafe {
                        gfx.gl.delete_framebuffer(gl.fbo.id);
                        gfx.gl.delete_texture(gl.tex.id);
                    }
                    drop(gl.target);
                }
            }
        }
        // 2. Re-create surfaces the compositor closed (the output is still there).
        for i in 0..st.outs.len() {
            if st.outs[i].surface.is_none() {
                let ls = st.make_surface(&st.outs[i].wl_output, st.outs[i].layer);
                let o = &mut st.outs[i];
                o.surface = Some(ls);
                o.configured = None;
                o.reset_frames();
                log::event(
                    "wl",
                    Level::Info,
                    "wl.surface_recreated",
                    None,
                    json!({ "output": o.info.name }),
                );
            }
        }
        // 3. Window targets for configured surfaces; resize on a new size.
        let compositor = st.compositor.clone();
        for o in &mut st.outs {
            let (Some((lw, lh)), Some(surface)) = (o.configured, o.surface.as_ref()) else {
                continue;
            };
            let scale = o.scale.max(1) as u32;
            let size = (lw * scale, lh * scale);
            if size.0 == 0
                || size.1 == 0
                || o.gl.as_ref().is_some_and(|g| g.size == size)
                || o.gl_failed == Some(size)
            {
                continue;
            }
            let ws = surface.wl_surface();
            ws.set_buffer_scale(scale as i32);
            if let Ok(region) = Region::new(&compositor) {
                region.add(0, 0, lw as i32, lh as i32);
                ws.set_opaque_region(Some(region.wl_region()));
            }
            let r = match o.gl.take() {
                Some(mut gl) => {
                    gl.target.resize(size.0, size.1);
                    // The FBO/texture deletes + creates need the context current: make it
                    // explicitly this window's (it is on whatever surface presented last,
                    // or surfaceless) — never rely on what happens to be bound (review d).
                    match gl.target.make_current(gfx) {
                        Ok(()) => {
                            unsafe {
                                gfx.gl.delete_framebuffer(gl.fbo.id);
                                gfx.gl.delete_texture(gl.tex.id);
                            }
                            gl.tex = gfx.tex(size.0, size.1);
                            gl.fbo = gfx.fbo(&gl.tex);
                            gl.size = size;
                            Ok(gl)
                        }
                        Err(e) => {
                            o.gl = Some(gl); // keep the old size's targets
                            Err(e)
                        }
                    }
                }
                // `set_swap_interval` makes the new window current before tex/fbo are made.
                None => gfx
                    .window_target(ws.id().as_ptr().cast(), size.0, size.1)
                    .and_then(|target| {
                        target.set_swap_interval(gfx, 0)?;
                        let tex = gfx.tex(size.0, size.1);
                        let fbo = gfx.fbo(&tex);
                        Ok(Gl {
                            target,
                            tex,
                            fbo,
                            size,
                        })
                    }),
            };
            match r {
                Ok(gl) => {
                    o.gl = Some(gl);
                    o.gl_failed = None;
                    o.redraw = true;
                    o.reset_frames();
                    log::event(
                        "wl",
                        Level::Info,
                        "wl.surface_ready",
                        None,
                        json!({ "output": o.info.name, "width": size.0, "height": size.1,
                                "scale": scale, "layer": format!("{:?}", o.layer) }),
                    );
                    if (o.info.width, o.info.height) != size {
                        o.info.width = size.0;
                        o.info.height = size.1;
                        st.changes.push(OutputChange::Changed(o.info.clone()));
                    }
                }
                Err(e) => {
                    o.gl_failed = Some(size);
                    log::event(
                        "wl",
                        Level::Error,
                        "wl.gl_error",
                        None,
                        json!({ "output": o.info.name, "width": size.0, "height": size.1,
                                "error": e }),
                    )
                }
            }
        }
    }

    fn take_redraws(&mut self) -> Vec<String> {
        self.state
            .outs
            .iter_mut()
            .filter_map(|o| std::mem::take(&mut o.redraw).then(|| o.info.name.clone()))
            .collect()
    }

    fn set_layer(&mut self, name: &str, layer: &str) -> Result<(), String> {
        let l = layer_from_str(layer).ok_or_else(|| format!("unknown layer {layer:?}"))?;
        let st = &mut self.state;
        let Some(i) = st.outs.iter().position(|o| o.info.name == name) else {
            return Err(format!("no output {name:?}"));
        };
        let o = &mut st.outs[i];
        if o.layer == l {
            return Ok(());
        }
        o.layer = l;
        let v2 = o.surface.as_ref().is_some_and(|s| match s.kind() {
            SurfaceKind::Wlr(w) => w.version() >= 2,
            _ => false,
        });
        // Not mapped yet (no configure / no first frame): a `set_layer` + bare commit then
        // was lost on Hyprland 0.56 (a re-plugged output whose remembered layer was applied
        // right after the surface was made stayed on background — measured). Re-create
        // the surface on the new layer instead: nothing is on screen yet.
        let mapped = o.configured.is_some() && o.gl.is_some();
        if v2 && mapped {
            let s = o.surface.as_ref().expect("checked");
            s.set_layer(l);
            s.commit(); // double-buffered: applies at this commit, the buffer is kept
            o.redraw = true;
        } else {
            // layer-shell v1 has no set_layer (or not mapped yet): re-create the surface
            // on the new layer (`process`).
            let (gl, surface) = (o.gl.take(), o.surface.take());
            o.configured = None;
            st.bury(gl, surface);
        }
        log::event(
            "wl",
            Level::Info,
            "wl.layer",
            None,
            json!({ "output": name, "layer": layer, "recreated": !(v2 && mapped) }),
        );
        Ok(())
    }

    fn take_pointer(&mut self) -> Vec<PointerSample> {
        std::mem::take(&mut self.state.samples)
    }

    fn as_wayland_mut(&mut self) -> Option<&mut Wayland> {
        Some(self)
    }
}

// ------------------------------------------------------------------ sctk handlers

impl CompositorHandler for WlState {
    fn scale_factor_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: i32,
    ) {
        // The output's own scale is tracked through `update_output`.
    }

    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        surface: &wl_surface::WlSurface,
        _: u32,
    ) {
        if let Some(o) = self.outs.iter_mut().find(|o| o.is_surface(surface)) {
            o.frame_pending = false;
            o.frame_armed = false;
            o.callbacks += 1;
        }
    }

    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for WlState {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, output: wl_output::WlOutput) {
        let Some((info, scale)) = self.info_of(&output) else {
            return;
        };
        if self.outs.iter().any(|o| o.info.name == info.name) {
            log::event(
                "wl",
                Level::Warn,
                "wl.duplicate_output",
                None,
                json!({ "output": info.name }),
            );
            return;
        }
        let surface = self.make_surface(&output, Layer::Background);
        self.changes.push(OutputChange::Added(info.clone()));
        self.outs.push(WlOut {
            info,
            wl_output: output,
            scale,
            layer: Layer::Background,
            gl: None,
            surface: Some(surface),
            configured: None,
            frame_pending: false,
            frame_armed: false,
            callbacks: 0,
            fail_streak: 0,
            failures: 0,
            retry_at: None,
            gl_failed: None,
            redraw: true,
            buttons: 0,
            motion_logged: None,
            motion_suppressed: 0,
        });
    }

    fn update_output(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        let Some((info, scale)) = self.info_of(&output) else {
            return;
        };
        let Some(o) = self.outs.iter_mut().find(|o| o.wl_output == output) else {
            return;
        };
        o.scale = scale;
        let (old_w, old_h) = (o.info.width, o.info.height);
        let same = info.hz == o.info.hz
            && info.refresh_mhz == o.info.refresh_mhz
            && (info.width, info.height) == (old_w, old_h);
        if !same {
            o.info.hz = info.hz;
            o.info.refresh_mhz = info.refresh_mhz;
            o.info.width = info.width;
            o.info.height = info.height;
            o.redraw = true;
            self.changes.push(OutputChange::Changed(o.info.clone()));
        }
    }

    fn output_destroyed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        let Some(i) = self.outs.iter().position(|o| o.wl_output == output) else {
            return;
        };
        let mut o = self.outs.remove(i);
        self.changes
            .push(OutputChange::Removed(o.info.name.clone()));
        let (gl, surface) = (o.gl.take(), o.surface.take());
        self.bury(gl, surface);
    }
}

impl LayerShellHandler for WlState {
    fn closed(&mut self, _: &Connection, _: &QueueHandle<Self>, layer: &LayerSurface) {
        let Some(i) = self
            .outs
            .iter()
            .position(|o| o.surface.as_ref() == Some(layer))
        else {
            return;
        };
        let o = &mut self.outs[i];
        log::event(
            "wl",
            Level::Info,
            "wl.surface_closed",
            None,
            json!({ "output": o.info.name }),
        );
        let (gl, surface) = (o.gl.take(), o.surface.take());
        o.configured = None;
        o.reset_frames();
        self.bury(gl, surface); // re-created in `process` if the output stays
    }

    fn configure(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _: u32,
    ) {
        let Some(o) = self
            .outs
            .iter_mut()
            .find(|o| o.surface.as_ref() == Some(layer))
        else {
            return;
        };
        let scale = o.scale.max(1) as u32;
        let (mut w, mut h) = configure.new_size;
        if w == 0 {
            w = (o.info.width / scale).max(1);
        }
        if h == 0 {
            h = (o.info.height / scale).max(1);
        }
        if o.configured != Some((w, h)) {
            o.configured = Some((w, h));
            o.redraw = true;
        }
    }
}

impl SeatHandler for WlState {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}

    fn new_capability(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability != Capability::Pointer {
            return; // keyboard interactivity is none: never a keyboard
        }
        match self.seat_state.get_pointer(qh, &seat) {
            Ok(p) => {
                let shape = self
                    .cursor_shape
                    .as_ref()
                    .map(|m| m.get_shape_device(&p, qh));
                self.pointers.push((p, shape));
            }
            Err(e) => log::event(
                "wl",
                Level::Warn,
                "wl.pointer_error",
                None,
                json!({ "error": e.to_string() }),
            ),
        }
    }

    fn remove_capability(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Pointer {
            for (p, shape) in self.pointers.drain(..) {
                if let Some(s) = shape {
                    s.destroy();
                }
                p.release();
            }
        }
    }

    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
}

impl PointerHandler for WlState {
    fn pointer_frame(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for ev in events {
            let Some(i) = self.outs.iter().position(|o| o.is_surface(&ev.surface)) else {
                continue;
            };
            let scale = self.outs[i].scale.max(1) as f64;
            let (x, y) = (ev.position.0 * scale, ev.position.1 * scale);
            let (what, button) = match ev.kind {
                PointerEventKind::Enter { serial } => {
                    if let Some((_, Some(dev))) = self.pointers.iter().find(|(p, _)| p == pointer) {
                        dev.set_shape(serial, Shape::Default);
                    }
                    ("enter", None)
                }
                PointerEventKind::Leave { .. } => {
                    self.outs[i].buttons = 0;
                    ("leave", None)
                }
                PointerEventKind::Motion { .. } => ("motion", None),
                PointerEventKind::Press { button, .. } => {
                    self.outs[i].buttons |= button_bit(button);
                    ("press", Some(button))
                }
                PointerEventKind::Release { button, .. } => {
                    self.outs[i].buttons &= !button_bit(button);
                    ("release", Some(button))
                }
                PointerEventKind::Axis { .. } => continue,
            };
            self.samples.push(PointerSample {
                output: self.outs[i].info.name.clone(),
                x,
                y,
                buttons: self.outs[i].buttons,
            });
            self.pointer_log(i, what, x, y, button);
        }
    }
}

impl ProvidesRegistryState for WlState {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    sctk::registry_handlers![OutputState, SeatState];
}

sctk::delegate_registry!(WlState);
sctk::delegate_dispatch2!(WlState);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_from_wl_output_v4_name() {
        assert_eq!(output_name(Some("DP-1"), 42), "DP-1");
        assert_eq!(output_name(Some("HDMI-A-1"), 7), "HDMI-A-1");
        assert_eq!(output_name(None, 42), "WL-42", "no v4 name");
        assert_eq!(output_name(Some("  "), 3), "WL-3");
        assert_eq!(
            output_name(Some("odd name.v:2*"), 1),
            "odd-name-v-2-",
            "node ids can't hold `.`, `:`, `*` or spaces"
        );
    }

    #[test]
    fn refresh_maps_from_the_current_mode_mhz() {
        assert_eq!(hz_from_mhz(143_981), 144);
        assert_eq!(hz_from_mhz(239_760), 240);
        assert_eq!(hz_from_mhz(59_940), 60);
        assert_eq!(hz_from_mhz(60_000), 60);
        assert_eq!(hz_from_mhz(0), 60, "virtual output without a refresh");
        assert_eq!(hz_from_mhz(-1), 60);
        assert_eq!(hz_from_mhz(400), 1, "never 0 Hz");
        assert_eq!(mhz_or_default(143_981), 143_981);
        assert_eq!(mhz_or_default(0), 60_000);
    }

    #[test]
    fn rotated_outputs_swap_dims() {
        use wl_output::Transform as T;
        assert_eq!(oriented_dims((1920, 1080), T::Normal), (1920, 1080));
        assert_eq!(oriented_dims((1920, 1080), T::_90), (1080, 1920));
        assert_eq!(oriented_dims((1920, 1080), T::Flipped270), (1080, 1920));
        assert_eq!(oriented_dims((1920, 1080), T::_180), (1920, 1080));
    }

    #[test]
    fn layers_and_buttons() {
        assert_eq!(layer_from_str("background"), Some(Layer::Background));
        assert_eq!(layer_from_str("bottom"), Some(Layer::Bottom));
        assert_eq!(layer_from_str("top"), Some(Layer::Top));
        assert_eq!(layer_from_str("overlay"), Some(Layer::Overlay));
        assert_eq!(layer_from_str("Overlay"), None);
        // Every schema variant maps (the graph and the backend can't drift apart).
        let schema = crate::graph::props::schema_for_kind(crate::graph::NodeKind::Output);
        let (_, def) = schema
            .iter()
            .find(|(n, _)| *n == "layer")
            .expect("layer prop");
        if let crate::graph::PropType::Enum(vs) = def.ty {
            for v in vs {
                assert!(layer_from_str(v).is_some(), "{v} has no layer-shell layer");
            }
        } else {
            panic!("layer is an enum");
        }
        assert_eq!(button_bit(0x110), 1);
        assert_eq!(button_bit(0x111), 2);
        assert_eq!(button_bit(0x112), 4);
        assert_eq!(button_bit(0x113), 8);
        assert_eq!(button_bit(0x114), 16);
        assert_eq!(button_bit(0x115), 0);
    }

    #[test]
    fn failed_presents_back_off() {
        assert_eq!(present_backoff(0), Duration::ZERO);
        assert_eq!(present_backoff(1), Duration::from_millis(100));
        assert_eq!(present_backoff(2), Duration::from_secs(1));
        assert_eq!(present_backoff(50), Duration::from_secs(1));
    }
}
