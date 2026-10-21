//! Video and image sources through libmpv's OpenGL render API (spec §4.2 "Source", §5.1
//! libmpv gotchas, §5.3 audio). One [`MpvSource`] = one mpv core + one render context,
//! rendering each new frame into its own FBO texture at the video's native display size.
//!
//! See `.claude/rules/player-core.md` § Sources for the gotchas this encodes (vo=libmpv,
//! render-context teardown with GL current, FLIP_Y, the `glFenceSync` stub, `volume` at
//! 100 + `volume-gain` in dB, async-only core calls after `open`, load fencing, `ao=null`
//! in tests, the wake-fd contract).

use std::collections::{BTreeMap, HashMap};
use std::ffi::{CStr, c_char, c_void};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use glow::HasContext;
use serde_json::{Map, Value};

use super::{Source, SourceEvent, bad_type, io_error, num, out_of_range, unsupported};
use crate::gfx::{Fbo, Gfx, GlKeepAlive, Tex};
use crate::graph::props::{self, PropValue};
use crate::graph::{ApiError, NodeKind};
use crate::mpv::ffi::mpv_error as me;
use crate::mpv::{
    EndReason, Event, Format, Handle, MpvError, PropData, RenderContext, error_string,
};
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
/// API path, accumulates — a slow leak of sync objects in a long-running wallpaper.
/// Handing mpv a `glFenceSync` that returns 0 (a null sync) turns that bookkeeping off.
///
/// Why a null fence is safe: mpv null-checks the fence it gets back before storing it or
/// waiting on it (no `glClientWaitSync` on 0), and `glDeleteSync(0)` is a GL no-op. What
/// mpv's GL fences actually guard is *buffer reuse*: (a) direct rendering (`vd-lavc-dr`,
/// decoder frames in GL-mapped buffers) — on the render API that needs
/// `MPV_RENDER_PARAM_ADVANCED_CONTROL`, which lp-player never passes; (b) `opengl-pbo`
/// uploads, where a PBO could be rewritten while the GPU still reads it — lp-player pins
/// `opengl-pbo=no` (mpv's default) in `open`. **Neither may be enabled while this stub is in
/// place.**
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

/// An mpv failure as an `ApiError`: a rejected value → `out_of_range`, an unknown or
/// unavailable property/feature → `unsupported`, anything else (setup, loading, AO/VO
/// init, out of memory) → `io`.
fn api_err(e: MpvError) -> ApiError {
    let msg = format!("libmpv: {e}");
    match e.code {
        me::MPV_ERROR_OPTION_FORMAT
        | me::MPV_ERROR_OPTION_ERROR
        | me::MPV_ERROR_PROPERTY_FORMAT
        | me::MPV_ERROR_PROPERTY_ERROR
        | me::MPV_ERROR_INVALID_PARAMETER
        | me::MPV_ERROR_COMMAND => out_of_range(msg),
        me::MPV_ERROR_OPTION_NOT_FOUND
        | me::MPV_ERROR_PROPERTY_NOT_FOUND
        | me::MPV_ERROR_PROPERTY_UNAVAILABLE
        | me::MPV_ERROR_UNSUPPORTED
        | me::MPV_ERROR_NOT_IMPLEMENTED => unsupported(msg),
        _ => io_error(msg),
    }
}

fn yes_no(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

/// What an in-flight async request was, so its reply can be reported/reverted.
struct Request {
    /// e.g. `af=no_such_filter (af)` — what an `Error` event names.
    what: String,
    kind: ReqKind,
}

enum ReqKind {
    /// A property apply: on failure restore `prop`'s previous value in `props` (only if
    /// no newer apply of the same prop is in flight).
    Prop {
        prop: String,
        prev: Option<PropValue>,
    },
    /// The coalesced `volume-gain` push (at most one in flight).
    Gain,
    /// A `loadfile`.
    Load,
}

/// One FBO-backed render target.
type Target = (Tex, Fbo);

/// A libmpv-backed video/image [`Source`].
pub struct MpvSource {
    // Teardown order is explicit in `Drop` (render ctx with GL current → core → fd).
    render: Option<RenderContext>,
    handle: Option<Handle>,
    wake: OwnedFd,
    gl: GlKeepAlive,
    /// What `texture()` returns: the last good frame of the last *ready* load.
    front: Option<Target>,
    /// Staging target for frames of a load that isn't `Ready` yet (and stale frames of a
    /// load that's being replaced) — so the front keeps the old frame until the new
    /// file's first frame is actually there.
    back: Option<Target>,
    /// `back` holds a frame of the current load, rendered after its FILE_LOADED.
    back_valid: bool,

    kind: &'static str,
    path: String,
    /// Last applied value of every writable property (seeded with schema defaults).
    props: BTreeMap<String, PropValue>,
    gains: Gains,
    /// `false` only inside `open` (synchronous setup, before any file is loaded); after
    /// that every core call is async — see `mpv/mod.rs` "Threading".
    live: bool,

    // Async request bookkeeping.
    next_req: u64,
    inflight: HashMap<u64, Request>,
    /// prop → newest in-flight request id that set it (revert only the newest).
    prop_req: HashMap<String, u64>,
    gain_inflight: bool,
    gain_dirty: bool,
    /// The value `apply` just replaced, handed to the request `track` records.
    prev_value: Option<PropValue>,

    // Load fencing: only events of the *current* load count.
    /// Request id of the newest `loadfile`.
    load_req: u64,
    /// Playlist entry id of the newest load (from its `loadfile` reply).
    want_entry: Option<i64>,
    /// Entry mpv is currently playing (START_FILE … END_FILE).
    playing_entry: Option<i64>,
    file_loaded: bool,
    restarted: bool,

    // Observed mpv state (of the current load).
    time_pos: Option<f64>,
    duration: Option<f64>,
    dsize: (i64, i64),
    ready: bool,
    ended_sent: bool,
    dead: bool,
    ctx_error_sent: bool,
    last_pos_emit: Option<Instant>,
    last_error_log: Option<String>,
    pending: Vec<SourceEvent>,
}

impl MpvSource {
    /// Create an mpv core rendering through `gfx`'s GL context and start loading `path`
    /// (asynchronously: success/failure arrives as `Ready` / `Error`).
    ///
    /// `opts`: any writable `Source` property from the graph schema (`paused`, `loop`,
    /// `speed`, `gain.<slot>`, `hwdec`, …; `position` becomes the start time) — every
    /// writable property not given is applied at its **schema default**, so `read` and
    /// mpv agree from the start — plus:
    /// - `ao` — mpv audio output, default [`DEFAULT_AO`] (tests pass `"null"`, R26);
    /// - `audio_device` — mpv `audio-device` (the player bus, Task 14);
    /// - `kind` — `"video"` | `"image"`; default inferred from the extension.
    ///
    /// `path` in `opts` is ignored (the argument wins); read-only and unknown names are
    /// rejected with the graph's own error codes; a value mpv rejects here is
    /// `out_of_range`/`unsupported` (setup is synchronous — no file is loaded yet).
    pub fn open(gfx: &Gfx, path: &str, opts: &Map<String, Value>) -> Result<MpvSource, ApiError> {
        if path.contains('\0') {
            return Err(out_of_range(format!("path {path:?} contains a NUL byte")));
        }
        let kind = match opts.get("kind") {
            None => infer_kind(path),
            Some(Value::String(k)) if k == "video" => "video",
            Some(Value::String(k)) if k == "image" => "image",
            Some(Value::String(k)) => {
                return Err(out_of_range(format!(
                    "MpvSource kind must be \"video\" or \"image\", got {k:?}"
                )));
            }
            Some(other) => return Err(bad_type(format!("kind must be a string, got {other}"))),
        };
        let opt_str = |k: &str| -> Result<Option<&str>, ApiError> {
            match opts.get(k) {
                None => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.as_str())),
                Some(other) => Err(bad_type(format!("{k} must be a string, got {other}"))),
            }
        };
        let ao = opt_str("ao")?.unwrap_or(DEFAULT_AO).to_string();
        let audio_device = opt_str("audio_device")?.map(str::to_string);

        // Type every remaining opt up front (bad shapes fail before any mpv work).
        let mut given: BTreeMap<String, PropValue> = BTreeMap::new();
        let mut start: Option<f64> = None;
        for (k, v) in opts {
            match k.as_str() {
                "ao" | "audio_device" | "kind" | "path" => {}
                "position" => {
                    start =
                        Some(v.as_f64().ok_or_else(|| {
                            bad_type(format!("position must be a number, got {v}"))
                        })?);
                }
                _ => {
                    given.insert(k.clone(), json_prop(k, v)?);
                }
            }
        }

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
        let handle = Handle::create().map_err(api_err)?;
        let fixed: [(&str, &str); 16] = [
            ("vo", "libmpv"),
            ("config", "no"),
            ("terminal", "no"),
            ("keep-open", "yes"),
            // keep-open's default also *pauses* at EOF; the graph never asked for that,
            // and a paused-at-end source would ignore a later seek back.
            ("keep-open-pause", "no"),
            // Stay alive after a load error / for a later `path` change.
            ("idle", "yes"),
            ("volume", "100"),
            ("volume-gain-min", "-96"),
            // Images hold forever; harmless for videos (only single-frame images use it).
            ("image-display-duration", "inf"),
            // The texture is the frame itself; fit/crop happen in the compositor.
            ("keepaspect", "no"),
            // Required by the glFenceSync stub (see `stub_fence_sync`).
            ("opengl-pbo", "no"),
            ("osd-level", "0"),
            ("ytdl", "no"),
            ("input-default-bindings", "no"),
            ("audio-client-name", "lp-player"),
            ("ao", &ao),
        ];
        for (k, v) in fixed {
            handle.set_option(k, v).map_err(api_err)?;
        }
        if let Some(dev) = &audio_device {
            handle.set_option("audio-device", dev).map_err(api_err)?;
        }
        handle.initialize().map_err(api_err)?;
        handle.request_log_messages("error").map_err(api_err)?;
        for (id, name, f) in [
            (OBS_TIME_POS, "time-pos", Format::F64),
            (OBS_DURATION, "duration", Format::F64),
            (OBS_DWIDTH, "dwidth", Format::I64),
            (OBS_DHEIGHT, "dheight", Format::I64),
            (OBS_EOF, "eof-reached", Format::Flag),
            (OBS_PAUSE, "pause", Format::Flag),
            (OBS_IMAGE, "current-tracks/video/image", Format::Flag),
        ] {
            handle.observe(id, name, f).map_err(api_err)?;
        }

        // SAFETY: the fd stays open until after the core is destroyed (see Drop).
        unsafe { handle.set_wakeup_callback(Some(on_wake), wake_ctx) };

        // The render context must be created with *this* Gfx's context current — don't
        // assume it is (another Gfx may have been made current since).
        let gl = gfx.keep_alive();
        let render = {
            let cur = gl.make_current();
            if !cur.is_current() {
                return Err(io_error("can't make the source's GL context current"));
            }
            // SAFETY: context current (above); Drop frees the render context with it
            // current and before the core.
            unsafe { RenderContext::create(&handle, get_proc_address) }.map_err(api_err)?
        };
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
            gl,
            front: None,
            back: None,
            back_valid: false,
            kind,
            path: path.to_string(),
            props: writable,
            gains: Gains::new(),
            live: false,
            next_req: 1,
            inflight: HashMap::new(),
            prop_req: HashMap::new(),
            gain_inflight: false,
            gain_dirty: false,
            prev_value: None,
            load_req: 0,
            want_entry: None,
            playing_entry: None,
            file_loaded: false,
            restarted: false,
            time_pos: None,
            duration: None,
            dsize: (0, 0),
            ready: false,
            ended_sent: false,
            dead: false,
            ctx_error_sent: false,
            last_pos_emit: None,
            last_error_log: None,
            pending: Vec::new(),
        };
        // The initial gain sum (0 dB unless opts say otherwise) is pushed explicitly so
        // mpv's volume-gain always mirrors `gains`, never its own default.
        src.push_gain()?;
        // Every writable property: the given value, else the schema default — so `read`
        // never disagrees with what mpv is actually running.
        for (name, pd) in props::schema_for_kind(NodeKind::Source) {
            if pd.readonly || matches!(name, "kind" | "path" | "position" | "color") {
                continue;
            }
            let v = given.remove(name).unwrap_or(pd.default);
            src.apply(name, &v)?;
        }
        // What's left: gain slots, plus names apply() rejects with the graph's own codes.
        for (k, v) in given {
            src.apply(&k, &v)?;
        }
        if let Some(t) = start {
            src.core()
                .set_property("start", &t.to_string())
                .map_err(api_err)?;
            src.props.insert("position".into(), PropValue::F64(t));
        }
        src.live = true;
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

    /// Async mpv requests not yet answered (plus a coalesced gain push still owed).
    /// Probe/debug + tests: 0 means every `apply` so far has reached mpv.
    pub fn requests_in_flight(&self) -> usize {
        self.inflight.len() + self.gain_dirty as usize
    }

    /// Read a raw mpv property as a string. **Synchronous core call — tests/probes only,
    /// never on the live render path** (see `mpv/mod.rs` "Threading"); `read` serves
    /// cached/observed values instead.
    pub fn mpv_get_string(&self, name: &str) -> Option<String> {
        self.handle.as_ref()?.get_property(name)
    }

    /// Read a raw mpv property as a double. Synchronous — tests/probes only.
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

    fn req_id(&mut self) -> u64 {
        let id = self.next_req;
        self.next_req += 1;
        id
    }

    /// Set an mpv property for graph property `prop`: synchronous during `open`, async
    /// (render-thread safe) after. `prop` names what a failure reverts.
    fn set(&mut self, prop: &str, name: &str, value: &str) -> Result<(), ApiError> {
        if !self.live {
            return self.core().set_property(name, value).map_err(api_err);
        }
        let id = self.req_id();
        self.core()
            .set_property_async(id, name, value)
            .map_err(api_err)?;
        self.track(id, format!("{name}={value} ({prop})"), prop);
        Ok(())
    }

    fn set_f64(&mut self, prop: &str, name: &str, value: f64) -> Result<(), ApiError> {
        if !self.live {
            return self.core().set_property_f64(name, value).map_err(api_err);
        }
        let id = self.req_id();
        self.core()
            .set_property_f64_async(id, name, value)
            .map_err(api_err)?;
        self.track(id, format!("{name}={value} ({prop})"), prop);
        Ok(())
    }

    fn command(&mut self, prop: &str, args: &[&str]) -> Result<(), ApiError> {
        if !self.live {
            return self.core().command(args).map_err(api_err);
        }
        let id = self.req_id();
        self.core().command_async(id, args).map_err(api_err)?;
        self.track(id, format!("{} ({prop})", args.join(" ")), prop);
        Ok(())
    }

    /// Remember request `id` for `prop`. `apply` has already stored the new value, so the
    /// value to revert to on failure is the one recorded by `apply` before it (`prev`).
    fn track(&mut self, id: u64, what: String, prop: &str) {
        let prev = self.prev_value.take();
        self.prop_req.insert(prop.to_string(), id);
        self.inflight.insert(
            id,
            Request {
                what,
                kind: ReqKind::Prop {
                    prop: prop.to_string(),
                    prev,
                },
            },
        );
    }

    /// Load `path` (async `loadfile replace`). Everything per-load resets; the front
    /// texture is kept until the new file's first frame is shown (`Ready`).
    fn load(&mut self, path: &str) -> Result<(), ApiError> {
        let id = self.req_id();
        self.core()
            .command_async(id, &["loadfile", path, "replace"])
            .map_err(api_err)?;
        self.inflight.insert(
            id,
            Request {
                what: format!("loadfile {path}"),
                kind: ReqKind::Load,
            },
        );
        self.load_req = id;
        self.want_entry = None;
        self.path = path.to_string();
        self.props
            .insert("path".into(), PropValue::Str(path.into()));
        self.file_loaded = false;
        self.restarted = false;
        self.ready = false;
        self.back_valid = false;
        self.ended_sent = false;
        self.time_pos = None;
        self.duration = None;
        Ok(())
    }

    /// Push `gains.effective_db()` to mpv `volume-gain`. Live: coalesced — at most one
    /// request in flight; changes made meanwhile are sent (latest value only) when it's
    /// answered, so a per-frame gain ramp can't flood mpv's reply queue.
    fn push_gain(&mut self) -> Result<(), ApiError> {
        let db = mpv_volume_gain(self.gains.effective_db());
        if !self.live {
            return self
                .core()
                .set_property_f64("volume-gain", db)
                .map_err(api_err);
        }
        if self.gain_inflight {
            self.gain_dirty = true;
            return Ok(());
        }
        let id = self.req_id();
        self.core()
            .set_property_f64_async(id, "volume-gain", db)
            .map_err(api_err)?;
        self.inflight.insert(
            id,
            Request {
                what: format!("volume-gain={db}"),
                kind: ReqKind::Gain,
            },
        );
        self.gain_inflight = true;
        self.gain_dirty = false;
        Ok(())
    }

    /// The current load's entry is the one mpv is playing.
    fn is_current(&self) -> bool {
        self.want_entry.is_some() && self.playing_entry == self.want_entry
    }

    fn mark_ended(&mut self) {
        if !self.ended_sent && self.kind != "image" {
            self.ended_sent = true;
            self.pending.push(SourceEvent::Ended);
        }
    }

    fn load_error(&mut self, detail: String) {
        let mut reason = format!("{}: {detail}", self.path);
        if let Some(log) = self.last_error_log.take() {
            reason.push_str(&format!(" ({log})"));
        }
        self.pending.push(SourceEvent::Error { reason });
    }

    /// An async request's reply.
    fn on_reply(&mut self, id: u64, error: i32, entry: Option<i64>) {
        let Some(req) = self.inflight.remove(&id) else {
            return;
        };
        match req.kind {
            ReqKind::Gain => {
                self.gain_inflight = false;
                if error < 0 {
                    self.pending.push(SourceEvent::Error {
                        reason: format!("{}: {}", req.what, error_string(error)),
                    });
                }
                if self.gain_dirty {
                    // Only a local failure (queue full) can error here; the next gain
                    // apply retries, and the dirty flag keeps it owed meanwhile.
                    if self.push_gain().is_err() {
                        self.gain_dirty = true;
                    }
                }
            }
            ReqKind::Load => {
                if id != self.load_req {
                    return; // superseded by a newer load
                }
                if error < 0 {
                    self.load_error(format!("loadfile failed: {}", error_string(error)));
                } else {
                    self.want_entry = entry;
                }
            }
            ReqKind::Prop { prop, prev } => {
                let newest = self.prop_req.get(&prop) == Some(&id);
                if newest {
                    self.prop_req.remove(&prop);
                }
                if error < 0 {
                    if newest {
                        match prev {
                            Some(p) => self.props.insert(prop, p),
                            None => self.props.remove(&prop),
                        };
                    }
                    self.pending.push(SourceEvent::Error {
                        reason: format!("{}: {}", req.what, error_string(error)),
                    });
                }
            }
        }
    }

    /// Process every queued mpv event (never blocks) into cached state + `pending`.
    /// File-scoped events count only for the current load's playlist entry (fencing):
    /// a superseded load's FILE_LOADED / PLAYBACK_RESTART / END_FILE / eof / time-pos
    /// are ignored.
    fn pump(&mut self) {
        if self.dead {
            return;
        }
        loop {
            let ev = self.core().wait_event(0.0);
            match ev {
                Event::None => break,
                Event::CommandReply {
                    id,
                    error,
                    playlist_entry_id,
                } => self.on_reply(id, error, playlist_entry_id),
                Event::SetPropertyReply { id, error } => self.on_reply(id, error, None),
                Event::StartFile { entry } => {
                    self.playing_entry = Some(entry);
                    if self.is_current() {
                        self.file_loaded = false;
                        self.restarted = false;
                        self.time_pos = None;
                        self.duration = None;
                    }
                }
                Event::FileLoaded => {
                    if self.is_current() {
                        self.file_loaded = true;
                    }
                }
                Event::PlaybackRestart => {
                    if self.is_current() && self.file_loaded {
                        self.restarted = true;
                    }
                }
                Event::EndFile {
                    reason,
                    error,
                    entry,
                } => {
                    let current = self.want_entry == Some(entry);
                    if self.playing_entry == Some(entry) {
                        self.playing_entry = None;
                    }
                    match reason {
                        EndReason::Eof if current && self.restarted => self.mark_ended(),
                        EndReason::Error if current => {
                            self.load_error(error_string(error));
                        }
                        _ => {}
                    }
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
        // Playback-scoped values only once the current load has (re)started — a value
        // delivered after a path change may still describe the previous file.
        let live = self.is_current() && self.restarted;
        match (id, value) {
            (OBS_TIME_POS, PropData::F64(t)) if live => {
                self.time_pos = Some(t);
                let due = self
                    .last_pos_emit
                    .is_none_or(|at| at.elapsed() >= POSITION_INTERVAL);
                if due {
                    self.last_pos_emit = Some(Instant::now());
                    self.pending.push(SourceEvent::Position(t));
                }
            }
            (OBS_DURATION, PropData::F64(d)) if self.is_current() => self.duration = Some(d),
            (OBS_DWIDTH, PropData::I64(w)) => self.dsize.0 = w,
            (OBS_DHEIGHT, PropData::I64(h)) => self.dsize.1 = h,
            (OBS_EOF, PropData::Flag(true)) if live => self.mark_ended(),
            // Seeked back / looped: the next end is a new play-through.
            (OBS_EOF, PropData::Flag(false)) if self.is_current() => self.ended_sent = false,
            (OBS_PAUSE, PropData::Flag(p)) => {
                self.props.insert("paused".into(), PropValue::Bool(p));
            }
            (OBS_IMAGE, PropData::Flag(img)) if self.is_current() => {
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
        return v
            .as_f64()
            .map(PropValue::F64)
            .ok_or_else(|| bad_type(format!("{name}: expected a number (dB), got {v}")));
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

fn delete_target(gfx: &Gfx, (tex, fbo): Target) {
    unsafe {
        gfx.gl.delete_framebuffer(fbo.id);
        gfx.gl.delete_texture(tex.id);
    }
}

/// Render mpv's pending frame into `slot` at `w`×`h`: reuses the target if the size
/// matches, else renders into a fresh one and swaps it in only on success (a failed
/// render never replaces a good frame).
fn render_into(
    gfx: &Gfx,
    render: &RenderContext,
    slot: &mut Option<Target>,
    (w, h): (u32, u32),
) -> Result<(), MpvError> {
    let reuse = matches!(slot, Some((t, _)) if t.w == w && t.h == h);
    let fresh = (!reuse).then(|| {
        let t = gfx.tex(w, h);
        let f = gfx.fbo(&t);
        (t, f)
    });
    let fbo = match (&fresh, &*slot) {
        (Some((_, f)), _) | (None, Some((_, f))) => f.id.0.get(),
        (None, None) => unreachable!("reuse implies a target"),
    };
    // R25: FLIP_Y = 0 lands the image's top row at texture row 0 (t = 0) — the raw
    // source layout `gfx::compose` expects (pinned by tests/sources.rs).
    let res = unsafe { render.render(fbo, w, h, glow::RGBA8, false) };
    reset_gl_state(gfx);
    match (res, fresh) {
        (Ok(()), Some(new)) => {
            if let Some(old) = slot.replace(new) {
                delete_target(gfx, old);
            }
            Ok(())
        }
        (Ok(()), None) => Ok(()),
        (Err(e), fresh) => {
            if let Some(new) = fresh {
                delete_target(gfx, new);
            }
            Err(e)
        }
    }
}

impl Source for MpvSource {
    fn kind(&self) -> &'static str {
        self.kind
    }

    fn update(&mut self, gfx: &Gfx) -> bool {
        self.drain_wake();
        self.pump();
        // Rendering libmpv through any context but its own is UB (render.h): refuse.
        if !self.gl.is_for(gfx) {
            if !self.ctx_error_sent {
                self.ctx_error_sent = true;
                self.pending.push(SourceEvent::Error {
                    reason: format!(
                        "{}: update() called with a Gfx from a different GL context than \
                         the source was opened on; not rendering",
                        self.path
                    ),
                });
            }
            return false;
        }
        let cur = self.gl.make_current(); // a no-op unless another context is current
        if !cur.is_current() {
            return false;
        }
        let Some(render) = self.render.as_ref() else {
            return false;
        };
        let mut changed = false;
        // Level-triggered: if we skip (size unknown yet), the frame stays pending.
        if render.frame_pending()
            && let Some(size) = self.target_size()
        {
            if self.ready {
                match render_into(gfx, render, &mut self.front, size) {
                    Ok(()) => changed = true,
                    Err(e) => self.last_error_log = Some(e.to_string()),
                }
            } else {
                // Not ready yet (or a superseded load's leftovers): stage it.
                match render_into(gfx, render, &mut self.back, size) {
                    Ok(()) => {
                        if self.is_current() && self.file_loaded {
                            self.back_valid = true;
                        }
                    }
                    Err(e) => self.last_error_log = Some(e.to_string()),
                }
            }
        }
        // Ready = the current load has (re)started AND one of its frames is staged, in
        // either order (both occur; a paused source/image may never render again after
        // its one frame). Promote it to the front in the same step, so the texture at
        // `Ready` is always the new file's first frame — never the old file's, never blank.
        if !self.ready && self.restarted && self.back_valid {
            if let Some(new) = self.back.take()
                && let Some(old) = self.front.replace(new)
            {
                delete_target(gfx, old);
            }
            self.back_valid = false;
            self.ready = true;
            self.pending.push(SourceEvent::Ready);
            changed = true;
        }
        drop(cur);
        changed
    }

    fn texture(&self) -> Option<&Tex> {
        self.front.as_ref().map(|(t, _)| t)
    }

    fn size(&self) -> (u32, u32) {
        self.front.as_ref().map_or((0, 0), |(t, _)| (t.w, t.h))
    }

    fn apply(&mut self, prop: &str, v: &PropValue) -> Result<(), ApiError> {
        props::validate_value(NodeKind::Source, prop, v, true)?;
        if let PropValue::Str(s) = v
            && s.contains('\0')
        {
            return Err(out_of_range(format!("{prop}: {s:?} contains a NUL byte")));
        }
        if let Some(slot) = prop.strip_prefix("gain.") {
            let slot: GainSlot = slot.parse().map_err(|_| props::no_such_prop(prop))?;
            self.gains.set(slot, num(v));
            return self.push_gain();
        }
        let b = matches!(v, PropValue::Bool(true));
        let s = match v {
            PropValue::Str(s) => s.clone(),
            _ => String::new(),
        };
        // Store the new value now (read() reflects an apply immediately); `track` hands
        // the previous one to the request so an async rejection can restore it.
        let prev = self.props.insert(prop.to_string(), v.clone());
        self.prev_value = prev.clone();
        let res = match prop {
            "kind" if s != self.kind => Err(unsupported(format!(
                "can't change a live {} source to {s:?}; create a new source",
                self.kind
            ))),
            "kind" => Ok(()),
            "color" => Err(unsupported(format!(
                "`color` applies to colour sources, not a {} source",
                self.kind
            ))),
            "path" => {
                // A `start` left by an early `position` belongs to the previous load.
                self.set("path", "start", "none")
                    .and_then(|()| self.load(&s))
            }
            "paused" => self.set(prop, "pause", yes_no(b)),
            "speed" => self.set_f64(prop, "speed", num(v)),
            "loop" => self.set(prop, "loop-file", if b { "inf" } else { "no" }),
            "position" => {
                let t = num(v).to_string();
                if self.is_current() && self.file_loaded {
                    self.command(prop, &["seek", &t, "absolute", "exact"])
                } else {
                    // Not loaded yet: becomes the start time of the pending load.
                    self.set(prop, "start", &t)
                }
            }
            "hwdec" => {
                let h = if s.is_empty() { "no" } else { s.as_str() };
                self.set(prop, "hwdec", h)
            }
            "fps_cap" => {
                let n = num(v);
                let vf = if n > 0.0 {
                    format!("fps={n}")
                } else {
                    String::new()
                };
                self.set(prop, "vf", &vf)
            }
            // `true` = mpv's normal caching policy (`auto`, what the legacy engine runs
            // with DisableCache=false); `false` = forced off (legacy DisableCache=true).
            "cache" => self.set(prop, "cache", if b { "auto" } else { "no" }),
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
                self.set(prop, name, &val)
            }
            "af" => self.set(prop, "af", &s),
            // `auto` re-inits the AO even after a no-audio start (legacy engine finding).
            "no_audio" => self.set(prop, "aid", if b { "no" } else { "auto" }),
            "audio_delay" => self.set_f64(prop, "audio-delay", num(v)),
            other => Err(unsupported(format!(
                "{other} has no live mapping on a {} source",
                self.kind
            ))),
        };
        self.prev_value = None;
        if res.is_err() {
            // Synchronous failure: nothing reached mpv; restore what read() reported.
            match prev {
                Some(p) => self.props.insert(prop.to_string(), p),
                None => self.props.remove(prop),
            };
        }
        res
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
        // 1. Render context + our FBOs/textures, with the GL context current
        //    (lp-transition gotcha). `gl` keeps the EGL context alive even if the Gfx is
        //    already gone, and the guard restores whatever was current before.
        let cur = self.gl.make_current();
        if cur.is_current() {
            drop(self.render.take());
            for (tex, fbo) in [self.front.take(), self.back.take()].into_iter().flatten() {
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
                let _ = h.command_async(0, &["stop"]);
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
