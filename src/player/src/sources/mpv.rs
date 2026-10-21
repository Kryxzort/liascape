//! Video and image sources through libmpv's OpenGL render API (spec §4.2 "Source", §5.1
//! libmpv gotchas, §5.3 audio). One [`MpvSource`] = one mpv core + one render context,
//! rendering each new frame into its own FBO texture at the video's native display size.
//!
//! See `.claude/rules/player-core.md` § Sources for the gotchas this encodes (vo=libmpv,
//! render-context teardown with GL current, FLIP_Y, the `glFenceSync` stub, `volume` at
//! 100 + `volume-gain` in dB, `ao=null` in tests, the wake-fd contract).

use std::collections::BTreeMap;
use std::ffi::{CStr, c_char, c_void};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use glow::HasContext;
use serde_json::{Map, Value};

use super::{Source, SourceEvent, io_error, num, unsupported};
use crate::gfx::{Fbo, Gfx, GlKeepAlive, Tex};
use crate::graph::props::{self, PropValue};
use crate::graph::{ApiError, NodeKind};
use crate::mpv::{EndReason, Event, Format, Handle, MpvError, PropData, RenderContext};
use crate::units::{GainSlot, Gains, mpv_volume_gain};

/// Largest texture edge a source renders at; bigger videos are scaled down (aspect kept).
pub const MAX_TEXTURE_EDGE: u32 = 4096;

/// `Position` events are rate-limited to this interval (~10 Hz).
const POSITION_INTERVAL: Duration = Duration::from_millis(100);

/// The AO used when `opts` names none (spec §5.3; the bus `audio-device` arrives in Task 14).
pub const DEFAULT_AO: &str = "pipewire";

// Observed-property ids (`mpv_observe_property` reply_userdata).
const OBS_TIME_POS: u64 = 1;
const OBS_DURATION: u64 = 2;
const OBS_DWIDTH: u64 = 3;
const OBS_DHEIGHT: u64 = 4;
const OBS_EOF: u64 = 5;
const OBS_PAUSE: u64 = 6;
const OBS_IMAGE: u64 = 7;

/// mpv's own defaults, restored when a `demuxer_*_mib` property is set to 0 ("unset" —
/// the legacy engine's convention: `AppSettings` only passes `--demuxer-max-*` when > 0).
const DEMUXER_MAX_DEFAULT: &str = "150MiB";
const DEMUXER_BACK_DEFAULT: &str = "50MiB";

unsafe extern "C" {
    // libEGL is linked through khronos-egl's `static` feature (pkg-config `egl`).
    fn eglGetProcAddress(procname: *const c_char) -> *mut c_void;
}

/// Fence-leak mitigation. Technique from mpvpaper 1.9, PR #132 (manv-3), GPL-3.0:
/// libmpv's GL renderer creates a `glFenceSync` per rendered frame that, on the render
/// API path, accumulates instead of being waited on and deleted — a slow leak of sync
/// objects in a long-running wallpaper. Handing mpv a `glFenceSync` that returns 0 (a null
/// sync) makes it skip fence bookkeeping entirely. Safe here because the frame is sampled
/// by the compositor in the *same* GL context that rendered it, so GL's in-order command
/// stream already guarantees the render finished before the sample — no fence needed.
unsafe extern "C" fn stub_fence_sync(_condition: u32, _flags: u32) -> *mut c_void {
    FENCE_STUB_CALLS.fetch_add(1, Ordering::Relaxed);
    ptr::null_mut()
}

static FENCE_STUB_CALLS: AtomicU64 = AtomicU64::new(0);

/// How many times libmpv (any source in this process) has called the `glFenceSync` stub —
/// evidence the fence-leak mitigation is actually on mpv's path (probe/debug + tests).
pub fn fence_stub_calls() -> u64 {
    FENCE_STUB_CALLS.load(Ordering::Relaxed)
}

/// `get_proc_address` for `mpv_render_context_create`: everything from
/// `eglGetProcAddress`, except `glFenceSync` → [`stub_fence_sync`].
unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    if unsafe { CStr::from_ptr(name) }.to_bytes() == b"glFenceSync" {
        return stub_fence_sync as *mut c_void;
    }
    unsafe { eglGetProcAddress(name) }
}

/// Wakeup + render-update callback (any mpv thread): bump the eventfd whose number is the
/// callback context. Only `write(2)` — no mpv calls, no allocation, never blocks
/// (`EFD_NONBLOCK`; a saturated counter just means "already signalled").
unsafe extern "C" fn on_wake(ctx: *mut c_void) {
    let fd = ctx as usize as RawFd;
    let one: u64 = 1;
    unsafe { libc::write(fd, &one as *const u64 as *const c_void, 8) };
}

/// `"image"` for common still-image extensions, else `"video"`. Refined after load by
/// mpv's own `current-tracks/video/image` flag.
fn infer_kind(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff" | "jxl" | "avif" | "heic"
        | "qoi" | "tga" => "image",
        _ => "video",
    }
}

fn mpv_err(e: MpvError) -> ApiError {
    io_error(format!("libmpv: {e}"))
}

fn yes_no(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

/// A libmpv-backed video/image [`Source`].
pub struct MpvSource {
    // Teardown order is explicit in `Drop` (render ctx with GL current → core → fd).
    render: Option<RenderContext>,
    handle: Option<Handle>,
    wake: OwnedFd,
    gl: GlKeepAlive,
    target: Option<(Tex, Fbo)>,

    kind: &'static str,
    path: String,
    /// Last applied value of every writable property (seeded with schema defaults).
    props: BTreeMap<String, PropValue>,
    gains: Gains,

    // Observed mpv state.
    time_pos: Option<f64>,
    duration: Option<f64>,
    dsize: (i64, i64),
    paused: Option<bool>,
    file_loaded: bool,
    ready: bool,
    ended_sent: bool,
    dead: bool,
    last_pos_emit: Option<Instant>,
    last_error_log: Option<String>,
    pending: Vec<SourceEvent>,
}

impl MpvSource {
    /// Create an mpv core rendering through `gfx`'s GL context and start loading `path`
    /// (asynchronously: success/failure arrives as `Ready` / `Error`).
    ///
    /// `opts`: any writable `Source` property from the graph schema (`paused`, `loop`,
    /// `speed`, `gain.<slot>`, `hwdec`, …; `position` becomes the start time), plus:
    /// - `ao` — mpv audio output, default [`DEFAULT_AO`] (tests pass `"null"`, R26);
    /// - `audio_device` — mpv `audio-device` (the player bus, Task 14);
    /// - `kind` — `"video"` | `"image"`; default inferred from the extension.
    ///
    /// `path` in `opts` is ignored (the argument wins); read-only and unknown names are
    /// rejected with the graph's own error codes.
    pub fn open(gfx: &Gfx, path: &str, opts: &Map<String, Value>) -> Result<MpvSource, ApiError> {
        let kind = match opts.get("kind") {
            None => infer_kind(path),
            Some(Value::String(k)) if k == "video" => "video",
            Some(Value::String(k)) if k == "image" => "image",
            Some(other) => {
                return Err(unsupported(format!(
                    "MpvSource kind must be \"video\" or \"image\", got {other}"
                )));
            }
        };
        let opt_str = |k: &str| -> Result<Option<&str>, ApiError> {
            match opts.get(k) {
                None => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.as_str())),
                Some(other) => Err(unsupported(format!("{k} must be a string, got {other}"))),
            }
        };
        let ao = opt_str("ao")?.unwrap_or(DEFAULT_AO).to_string();
        let audio_device = opt_str("audio_device")?.map(str::to_string);

        // The eventfd is created before the core, so as a local it drops *after* it: on an
        // early-return error path the core (and its wakeup callback) is gone before the
        // fd closes — the callback can never write to a closed (or reused) fd number.
        let raw_fd = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
        if raw_fd < 0 {
            return Err(io_error(format!(
                "eventfd: {}",
                std::io::Error::last_os_error()
            )));
        }
        let wake = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let wake_ctx = raw_fd as usize as *mut c_void;
        let handle = Handle::create().map_err(mpv_err)?;
        let fixed: [(&str, &str); 14] = [
            ("vo", "libmpv"),
            ("config", "no"),
            ("terminal", "no"),
            ("keep-open", "yes"),
            // Stay alive after a load error / for a later `path` change.
            ("idle", "yes"),
            ("volume", "100"),
            ("volume-gain-min", "-96"),
            // Images hold forever; harmless for videos (only single-frame images use it).
            ("image-display-duration", "inf"),
            // The texture is the frame itself; fit/crop happen in the compositor.
            ("keepaspect", "no"),
            ("osd-level", "0"),
            ("ytdl", "no"),
            ("input-default-bindings", "no"),
            ("audio-client-name", "lp-player"),
            ("ao", &ao),
        ];
        for (k, v) in fixed {
            handle.set_option(k, v).map_err(mpv_err)?;
        }
        if let Some(dev) = &audio_device {
            handle.set_option("audio-device", dev).map_err(mpv_err)?;
        }
        handle.initialize().map_err(mpv_err)?;
        handle.request_log_messages("error").map_err(mpv_err)?;
        for (id, name, f) in [
            (OBS_TIME_POS, "time-pos", Format::F64),
            (OBS_DURATION, "duration", Format::F64),
            (OBS_DWIDTH, "dwidth", Format::I64),
            (OBS_DHEIGHT, "dheight", Format::I64),
            (OBS_EOF, "eof-reached", Format::Flag),
            (OBS_PAUSE, "pause", Format::Flag),
            (OBS_IMAGE, "current-tracks/video/image", Format::Flag),
        ] {
            handle.observe(id, name, f).map_err(mpv_err)?;
        }

        // SAFETY: the fd stays open until after the core is destroyed (see Drop).
        unsafe { handle.set_wakeup_callback(Some(on_wake), wake_ctx) };

        // SAFETY: gfx's context is current on this thread (true for every Gfx's lifetime);
        // Drop frees the render context with it current and before the core.
        let render =
            unsafe { RenderContext::create(&handle, get_proc_address) }.map_err(mpv_err)?;
        unsafe { render.set_update_callback(Some(on_wake), wake_ctx) };

        let mut writable = BTreeMap::new();
        for (name, pd) in props::schema_for_kind(NodeKind::Source) {
            if !pd.readonly {
                writable.insert(name.to_string(), pd.default);
            }
        }
        writable.insert("kind".into(), PropValue::Str(kind.into()));
        writable.insert("path".into(), PropValue::Str(path.into()));

        let mut src = MpvSource {
            render: Some(render),
            handle: Some(handle),
            wake,
            gl: gfx.keep_alive(),
            target: None,
            kind,
            path: path.to_string(),
            props: writable,
            gains: Gains::new(),
            time_pos: None,
            duration: None,
            dsize: (0, 0),
            paused: None,
            file_loaded: false,
            ready: false,
            ended_sent: false,
            dead: false,
            last_pos_emit: None,
            last_error_log: None,
            pending: Vec::new(),
        };
        // The initial gain sum (0 dB unless opts say otherwise) is pushed explicitly so
        // mpv's volume-gain always mirrors `gains`, never its own default.
        src.push_gain()?;

        for (k, v) in opts {
            match k.as_str() {
                "ao" | "audio_device" | "kind" | "path" => {}
                "position" => {
                    let t = v.as_f64().ok_or_else(|| {
                        unsupported(format!("position must be a number, got {v}"))
                    })?;
                    src.core()
                        .set_property("start", &t.to_string())
                        .map_err(mpv_err)?;
                    src.props.insert("position".into(), PropValue::F64(t));
                }
                _ => {
                    let pv = json_prop(k, v)?;
                    src.apply(k, &pv)?;
                }
            }
        }
        src.load(path)?;
        Ok(src)
    }

    /// The eventfd the runtime polls (Task 12): it becomes readable whenever mpv has a new
    /// event or a new frame. On readability call [`Source::poll_events`] and
    /// [`Source::update`] — each drains the fd first, so a signal arriving mid-call is
    /// never lost.
    pub fn wake_fd(&self) -> RawFd {
        self.wake.as_raw_fd()
    }

    /// Read a raw mpv property as a string (probe/debug + tests). Synchronous core call —
    /// not for the per-frame path.
    pub fn mpv_get_string(&self, name: &str) -> Option<String> {
        self.handle.as_ref()?.get_property(name)
    }

    /// Read a raw mpv property as a double (probe/debug + tests). Synchronous core call.
    pub fn mpv_get_f64(&self, name: &str) -> Option<f64> {
        self.handle.as_ref()?.get_property_f64(name)
    }

    fn core(&self) -> &Handle {
        self.handle.as_ref().expect("mpv core lives until Drop")
    }

    fn drain_wake(&self) {
        let mut buf = 0u64;
        unsafe {
            libc::read(
                self.wake.as_raw_fd(),
                &mut buf as *mut u64 as *mut c_void,
                8,
            )
        };
    }

    fn load(&mut self, path: &str) -> Result<(), ApiError> {
        self.core()
            .command(&["loadfile", path, "replace"])
            .map_err(mpv_err)?;
        self.path = path.to_string();
        self.props
            .insert("path".into(), PropValue::Str(path.into()));
        self.file_loaded = false;
        self.ready = false;
        self.ended_sent = false;
        self.time_pos = None;
        self.duration = None;
        Ok(())
    }

    fn push_gain(&self) -> Result<(), ApiError> {
        self.core()
            .set_property_f64("volume-gain", mpv_volume_gain(self.gains.effective_db()))
            .map_err(mpv_err)
    }

    fn set(&self, name: &str, value: &str) -> Result<(), ApiError> {
        self.core().set_property(name, value).map_err(mpv_err)
    }

    fn mark_ended(&mut self) {
        if !self.ended_sent && self.kind != "image" {
            self.ended_sent = true;
            self.pending.push(SourceEvent::Ended);
        }
    }

    /// Process every queued mpv event (never blocks) into cached state + `pending`.
    fn pump(&mut self) {
        if self.dead {
            return;
        }
        loop {
            let ev = self.core().wait_event(0.0);
            match ev {
                Event::None => break,
                Event::FileLoaded => self.file_loaded = true,
                Event::EndFile {
                    reason: EndReason::Eof,
                    ..
                } => self.mark_ended(),
                Event::EndFile {
                    reason: EndReason::Error,
                    error,
                } => {
                    let mut reason = format!("{}: {}", self.path, crate::mpv::error_string(error));
                    if let Some(log) = self.last_error_log.take() {
                        reason.push_str(&format!(" ({log})"));
                    }
                    self.pending.push(SourceEvent::Error { reason });
                }
                Event::LogMessage { prefix, text, .. } => {
                    self.last_error_log = Some(format!("{prefix}: {}", text.trim_end()));
                }
                Event::PropertyChange { id, value, .. } => self.on_prop(id, value),
                Event::Shutdown => {
                    self.dead = true;
                    self.pending.push(SourceEvent::Error {
                        reason: format!("{}: mpv core shut down", self.path),
                    });
                    break;
                }
                _ => {}
            }
        }
    }

    fn on_prop(&mut self, id: u64, value: PropData) {
        match (id, value) {
            (OBS_TIME_POS, PropData::F64(t)) => {
                self.time_pos = Some(t);
                let due = self
                    .last_pos_emit
                    .is_none_or(|at| at.elapsed() >= POSITION_INTERVAL);
                if due {
                    self.last_pos_emit = Some(Instant::now());
                    self.pending.push(SourceEvent::Position(t));
                }
            }
            (OBS_TIME_POS, _) => self.time_pos = None,
            (OBS_DURATION, PropData::F64(d)) => self.duration = Some(d),
            (OBS_DURATION, _) => self.duration = None,
            (OBS_DWIDTH, PropData::I64(w)) => self.dsize.0 = w,
            (OBS_DHEIGHT, PropData::I64(h)) => self.dsize.1 = h,
            (OBS_EOF, PropData::Flag(true)) => self.mark_ended(),
            // Seeked back / looped / reloaded: the next end is a new play-through.
            (OBS_EOF, PropData::Flag(false)) => self.ended_sent = false,
            (OBS_PAUSE, PropData::Flag(p)) => self.paused = Some(p),
            (OBS_IMAGE, PropData::Flag(img)) => {
                self.kind = if img { "image" } else { "video" };
                self.props
                    .insert("kind".into(), PropValue::Str(self.kind.into()));
            }
            _ => {}
        }
    }

    /// Native display size, capped at [`MAX_TEXTURE_EDGE`] (aspect kept). `None` until
    /// mpv has reported `dwidth`/`dheight`.
    fn target_size(&self) -> Option<(u32, u32)> {
        let (w, h) = self.dsize;
        if w <= 0 || h <= 0 {
            return None;
        }
        let (w, h) = (w as f64, h as f64);
        let scale = (MAX_TEXTURE_EDGE as f64 / w.max(h)).min(1.0);
        Some((
            ((w * scale).round() as u32).max(1),
            ((h * scale).round() as u32).max(1),
        ))
    }
}

/// A JSON `opts` value typed through the graph schema (`gain.<slot>` → dB number).
fn json_prop(name: &str, v: &Value) -> Result<PropValue, ApiError> {
    if name.starts_with("gain.") {
        return v.as_f64().map(PropValue::F64).ok_or_else(|| ApiError {
            code: "bad_type",
            message: format!("{name}: expected a number (dB), got {v}"),
            hint: "see .claude/rules/player-core.md \u{a7} Graph & properties".to_string(),
        });
    }
    let pd = props::schema_for(NodeKind::Source, name).ok_or_else(|| props::no_such_prop(name))?;
    props::from_json(name, pd.ty, v)
}

/// Undo the GL state libmpv's renderer leaves behind, so the compositor (which sets its
/// own blend/viewport/program per draw) starts from defaults.
fn reset_gl_state(gfx: &Gfx) {
    unsafe {
        let gl = &gfx.gl;
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        gl.use_program(None);
        gl.bind_vertex_array(None);
        gl.bind_buffer(glow::ARRAY_BUFFER, None);
        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, None);
        gl.disable(glow::BLEND);
        gl.disable(glow::SCISSOR_TEST);
        gl.color_mask(true, true, true, true);
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
        gl.pixel_store_i32(glow::UNPACK_ROW_LENGTH, 0);
        gl.pixel_store_i32(glow::PACK_ALIGNMENT, 4);
    }
}

fn delete_target(gfx: &Gfx, (tex, fbo): (Tex, Fbo)) {
    unsafe {
        gfx.gl.delete_framebuffer(fbo.id);
        gfx.gl.delete_texture(tex.id);
    }
}

impl Source for MpvSource {
    fn kind(&self) -> &'static str {
        self.kind
    }

    fn update(&mut self, gfx: &Gfx) -> bool {
        self.drain_wake();
        self.pump();
        let Some(render) = self.render.as_ref() else {
            return false;
        };
        // Level-triggered: if we skip (size unknown yet), the frame stays pending.
        if !render.frame_pending() {
            return false;
        }
        let Some((w, h)) = self.target_size() else {
            return false;
        };
        let reuse = matches!(&self.target, Some((t, _)) if t.w == w && t.h == h);
        let fresh = (!reuse).then(|| {
            let t = gfx.tex(w, h);
            let f = gfx.fbo(&t);
            (t, f)
        });
        let fbo = match (&fresh, &self.target) {
            (Some((_, f)), _) | (None, Some((_, f))) => f.id.0.get(),
            (None, None) => unreachable!("reuse implies a target"),
        };
        // R25: FLIP_Y = 0 lands the image's top row at texture row 0 (t = 0) — the raw
        // source layout `gfx::compose` expects (pinned by tests/sources.rs).
        let res = unsafe { render.render(fbo, w, h, glow::RGBA8, false) };
        reset_gl_state(gfx);
        match res {
            Ok(()) => {
                if let Some(new) = fresh
                    && let Some(old) = self.target.replace(new)
                {
                    delete_target(gfx, old);
                }
            }
            Err(e) => {
                // Keep the last good frame; a resized-but-failed target is discarded.
                if let Some(new) = fresh {
                    delete_target(gfx, new);
                }
                self.last_error_log = Some(e.to_string());
                return false;
            }
        }
        if self.file_loaded && !self.ready {
            self.ready = true;
            self.pending.push(SourceEvent::Ready);
        }
        true
    }

    fn texture(&self) -> Option<&Tex> {
        self.target.as_ref().map(|(t, _)| t)
    }

    fn size(&self) -> (u32, u32) {
        self.target.as_ref().map_or((0, 0), |(t, _)| (t.w, t.h))
    }

    fn apply(&mut self, prop: &str, v: &PropValue) -> Result<(), ApiError> {
        props::validate_value(NodeKind::Source, prop, v, true)?;
        if let Some(slot) = prop.strip_prefix("gain.") {
            let slot: GainSlot = slot.parse().map_err(|_| props::no_such_prop(prop))?;
            self.gains.set(slot, num(v));
            return self.push_gain();
        }
        let b = |v: &PropValue| matches!(v, PropValue::Bool(true));
        let s = |v: &PropValue| match v {
            PropValue::Str(s) => s.clone(),
            _ => String::new(),
        };
        match prop {
            "kind" => {
                if s(v) != self.kind {
                    return Err(unsupported(format!(
                        "can't change a live {} source to {:?}; create a new source",
                        self.kind,
                        s(v)
                    )));
                }
            }
            "color" => {
                return Err(unsupported(format!(
                    "`color` applies to colour sources, not a {} source",
                    self.kind
                )));
            }
            "path" => {
                // A `start` left by an early `position` belongs to the previous load.
                self.set("start", "none")?;
                self.load(&s(v))?;
            }
            "paused" => self.set("pause", yes_no(b(v)))?,
            "speed" => self
                .core()
                .set_property_f64("speed", num(v))
                .map_err(mpv_err)?,
            "loop" => self.set("loop-file", if b(v) { "inf" } else { "no" })?,
            "position" => {
                let t = num(v);
                if self.file_loaded {
                    self.core()
                        .command(&["seek", &t.to_string(), "absolute", "exact"])
                        .map_err(mpv_err)?;
                } else {
                    // Not loaded yet: becomes the start time of the pending load.
                    self.set("start", &t.to_string())?;
                }
            }
            "hwdec" => {
                let h = s(v);
                self.set("hwdec", if h.is_empty() { "no" } else { &h })?;
            }
            "fps_cap" => {
                let n = num(v);
                let vf = if n > 0.0 {
                    format!("fps={n}")
                } else {
                    String::new()
                };
                self.set("vf", &vf)?;
            }
            "cache" => self.set("cache", yes_no(b(v)))?,
            "demuxer_max_mib" | "demuxer_back_mib" => {
                let n = num(v);
                let name = if prop == "demuxer_max_mib" {
                    "demuxer-max-bytes"
                } else {
                    "demuxer-max-back-bytes"
                };
                // mpv's byte-size parser rejects a fractional suffix (`1.5MiB` →
                // "unsupported format"), so a fractional MiB goes as exact bytes.
                let val = if n > 0.0 && n.fract() == 0.0 {
                    format!("{n}MiB")
                } else if n > 0.0 {
                    format!("{}", (n * 1048576.0).round() as i64)
                } else if prop == "demuxer_max_mib" {
                    DEMUXER_MAX_DEFAULT.to_string()
                } else {
                    DEMUXER_BACK_DEFAULT.to_string()
                };
                self.set(name, &val)?;
            }
            "af" => self.set("af", &s(v))?,
            // `auto` re-inits the AO even after a no-audio start (legacy engine finding).
            "no_audio" => self.set("aid", if b(v) { "no" } else { "auto" })?,
            "audio_delay" => self
                .core()
                .set_property_f64("audio-delay", num(v))
                .map_err(mpv_err)?,
            other => {
                return Err(unsupported(format!(
                    "{other} has no live mapping on a {} source",
                    self.kind
                )));
            }
        }
        self.props.insert(prop.to_string(), v.clone());
        Ok(())
    }

    fn read(&self, prop: &str) -> Option<PropValue> {
        if let Some(slot) = prop.strip_prefix("gain.") {
            let slot: GainSlot = slot.parse().ok()?;
            return Some(PropValue::F64(self.gains.get(slot)));
        }
        match prop {
            "kind" => Some(PropValue::Str(self.kind.into())),
            "ready" => Some(PropValue::Bool(self.ready)),
            "duration" if self.kind == "image" => None,
            "duration" => self.duration.map(PropValue::F64),
            "time_pos" => self.time_pos.map(PropValue::F64),
            "position" => self
                .time_pos
                .map(PropValue::F64)
                .or_else(|| self.props.get("position").cloned()),
            "width" => self.target_size().map(|(w, _)| PropValue::I64(w as i64)),
            "height" => self.target_size().map(|(_, h)| PropValue::I64(h as i64)),
            "paused" => self
                .paused
                .map(PropValue::Bool)
                .or_else(|| self.props.get("paused").cloned()),
            "color" => None,
            _ => self.props.get(prop).cloned(),
        }
    }

    fn poll_events(&mut self) -> Vec<SourceEvent> {
        self.drain_wake();
        self.pump();
        std::mem::take(&mut self.pending)
    }
}

impl Drop for MpvSource {
    fn drop(&mut self) {
        // 1. Render context + our FBO/texture, with the GL context current (lp-transition
        //    gotcha). `gl` keeps the EGL context alive even if the Gfx is already gone.
        let cur = self.gl.make_current();
        if cur.is_current() {
            drop(self.render.take());
            if let Some((tex, fbo)) = self.target.take() {
                self.gl.delete_fbo(&fbo);
                self.gl.delete_texture(&tex);
            }
        } else {
            // Can't make the context current: freeing would run GL calls against the
            // wrong (or no) context. Leak the render context and the core (destroying a
            // core whose render context is still alive isn't allowed) rather than crash.
            // Stop playback first so the leaked core is at least silent (invariant: never
            // leave an audible stream behind).
            if let Some(h) = &self.handle {
                let _ = h.command(&["stop"]);
                unsafe { h.set_wakeup_callback(None, ptr::null_mut()) };
            }
            // Neither callback may outlive the eventfd (closed right after this).
            if let Some(r) = &self.render {
                unsafe { r.set_update_callback(None, ptr::null_mut()) };
            }
            std::mem::forget(self.render.take());
            std::mem::forget(self.handle.take());
        }
        drop(cur);
        // 2. The core: stops the wakeup callback before 3. the eventfd closes (field drop).
        if let Some(h) = &self.handle {
            unsafe { h.set_wakeup_callback(None, ptr::null_mut()) };
        }
        drop(self.handle.take());
    }
}
