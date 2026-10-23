//! Safe(ish) libmpv wrapper (spec §5.1): [`Handle`] (one `mpv_handle` core) and
//! [`RenderContext`] (its OpenGL render context). Only what the sources need — options,
//! properties, commands, property observation, events, and the render API.
//!
//! **Threading.** Nothing here is `Send`: lp-player drives each core from its single render
//! thread (spec §4.1), the same thread that calls the render API. `render.h` ("Threading")
//! forbids that thread from *waiting* on any core function not marked "Safe to be called
//! from mpv render API threads": the core can itself be waiting on the render thread
//! (vo_libmpv's flip waits for `mpv_render_context_render`; after a load/seek the core
//! waits for that first frame to be shown), so a synchronous `mpv_set_property`/
//! `mpv_command`/`mpv_get_property` from the render thread stalls until vo_libmpv's
//! timeout breaks the cycle — measured 4–72 ms per call on this machine
//! (`tests/sources.rs::apply_never_blocks_the_render_thread` against the first,
//! synchronous version). So:
//! - **live path** — [`Handle::set_property_async`], [`Handle::set_property_f64_async`],
//!   [`Handle::command_async`] (render-thread-safe per `client.h`); results come back as
//!   [`Event::SetPropertyReply`] / [`Event::CommandReply`] through `wait_event(0.0)`;
//! - **synchronous calls** ([`Handle::set_property`], [`Handle::command`],
//!   [`Handle::get_property`], …) only during setup before the first `loadfile` (no VO
//!   exists yet, so the core can't be waiting on the render thread) and in tests/probes.
//!
//! Interior NUL bytes are rejected (`MPV_ERROR_INVALID_PARAMETER`), never stripped — a
//! stripped path would silently name a different file.
//!
//! **Teardown order (caller's job, see `sources::mpv::MpvSource`'s `Drop`):** free the
//! [`RenderContext`] first, with the GL context it was created on current, *then* drop the
//! [`Handle`]. libmpv requires the render context to be gone before the core is destroyed.

pub mod ffi;

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::fmt;
use std::ptr::{self, NonNull};

use ffi::{mpv_end_file_reason as efr, mpv_event_id as ev, mpv_format as fmt_};

/// A libmpv error code, with mpv's own description (`mpv_error_string`) and what was
/// being attempted.
#[derive(Debug, Clone)]
pub struct MpvError {
    pub code: c_int,
    pub context: String,
}

impl MpvError {
    fn new(code: c_int, context: impl Into<String>) -> Self {
        MpvError {
            code,
            context: context.into(),
        }
    }
}

/// `mpv_error_string` for a raw libmpv error code.
pub fn error_string(code: c_int) -> String {
    unsafe {
        let s = ffi::mpv_error_string(code);
        if s.is_null() {
            format!("mpv error {code}")
        } else {
            CStr::from_ptr(s).to_string_lossy().into_owned()
        }
    }
}

impl fmt::Display for MpvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.context, error_string(self.code))
    }
}

impl std::error::Error for MpvError {}

fn check(code: c_int, context: impl FnOnce() -> String) -> Result<(), MpvError> {
    if code < 0 {
        Err(MpvError::new(code, context()))
    } else {
        Ok(())
    }
}

fn cstr(s: &str) -> Result<CString, MpvError> {
    CString::new(s).map_err(|_| {
        MpvError::new(
            ffi::mpv_error::MPV_ERROR_INVALID_PARAMETER,
            format!("{s:?} contains a NUL byte"),
        )
    })
}

/// The value format to observe a property in ([`Handle::observe`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Flag,
    I64,
    F64,
    Str,
}

impl Format {
    fn raw(self) -> fmt_::Type {
        match self {
            Format::Flag => fmt_::MPV_FORMAT_FLAG,
            Format::I64 => fmt_::MPV_FORMAT_INT64,
            Format::F64 => fmt_::MPV_FORMAT_DOUBLE,
            Format::Str => fmt_::MPV_FORMAT_STRING,
        }
    }
}

/// An observed property's new value. `None` = the property is currently unavailable
/// (mpv sends `MPV_FORMAT_NONE`, e.g. `duration` before a file is loaded).
#[derive(Debug, Clone, PartialEq)]
pub enum PropData {
    None,
    Flag(bool),
    I64(i64),
    F64(f64),
    Str(String),
}

/// Why a file stopped (`mpv_end_file_reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    Eof,
    Stop,
    Quit,
    Error,
    Redirect,
    Other(u32),
}

/// An owned copy of one `mpv_event` (strings copied out before the next `wait_event`
/// invalidates mpv's buffers).
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// No event pending (`wait_event` timed out).
    None,
    Shutdown,
    LogMessage {
        prefix: String,
        level: String,
        text: String,
    },
    /// A playlist entry starts loading (`playlist_entry_id`).
    StartFile {
        entry: i64,
    },
    EndFile {
        reason: EndReason,
        /// The libmpv error code when `reason == Error` (`mpv_error`), else 0.
        error: c_int,
        /// Which playlist entry ended.
        entry: i64,
    },
    FileLoaded,
    PlaybackRestart,
    PropertyChange {
        id: u64,
        name: String,
        value: PropData,
    },
    /// Reply to [`Handle::command_async`] `id`; `error` < 0 = mpv rejected it.
    /// `playlist_entry_id` is filled from the result map when present (`loadfile`).
    CommandReply {
        id: u64,
        error: c_int,
        playlist_entry_id: Option<i64>,
    },
    /// Reply to [`Handle::set_property_async`]/[`Handle::set_property_f64_async`] `id`.
    SetPropertyReply {
        id: u64,
        error: c_int,
    },
    /// Any other event id (raw `mpv_event_id`).
    Other(u32),
}

/// `result["playlist_entry_id"]` from a command reply's result node, if it's a map that
/// has one (`loadfile` returns `{playlist_entry_id: <int>}`).
unsafe fn node_entry_id(node: &ffi::mpv_node) -> Option<i64> {
    if node.format != fmt_::MPV_FORMAT_NODE_MAP {
        return None;
    }
    let list = unsafe { node.u.list.as_ref() }?;
    for i in 0..list.num.max(0) as usize {
        let key = unsafe { CStr::from_ptr(*list.keys.add(i)) };
        let val = unsafe { &*list.values.add(i) };
        if key.to_bytes() == b"playlist_entry_id" && val.format == fmt_::MPV_FORMAT_INT64 {
            return Some(unsafe { val.u.int64 });
        }
    }
    None
}

unsafe fn owned(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

/// One mpv core (`mpv_create` … `mpv_terminate_destroy`).
pub struct Handle {
    raw: NonNull<ffi::mpv_handle>,
}

impl Handle {
    /// `mpv_create`. The core is not yet initialized — set pre-init options with
    /// [`Handle::set_option`], then call [`Handle::initialize`].
    pub fn create() -> Result<Handle, MpvError> {
        let raw = unsafe { ffi::mpv_create() };
        NonNull::new(raw)
            .map(|raw| Handle { raw })
            .ok_or_else(|| MpvError::new(ffi::mpv_error::MPV_ERROR_NOMEM, "mpv_create"))
    }

    pub fn raw(&self) -> *mut ffi::mpv_handle {
        self.raw.as_ptr()
    }

    /// `mpv_set_option_string` (before or after initialize).
    pub fn set_option(&self, name: &str, value: &str) -> Result<(), MpvError> {
        let (n, v) = (cstr(name)?, cstr(value)?);
        check(
            unsafe { ffi::mpv_set_option_string(self.raw(), n.as_ptr(), v.as_ptr()) },
            || format!("set option {name}={value}"),
        )
    }

    pub fn initialize(&self) -> Result<(), MpvError> {
        check(unsafe { ffi::mpv_initialize(self.raw()) }, || {
            "mpv_initialize".to_string()
        })
    }

    /// `mpv_set_property_string` — synchronous.
    pub fn set_property(&self, name: &str, value: &str) -> Result<(), MpvError> {
        let (n, v) = (cstr(name)?, cstr(value)?);
        check(
            unsafe { ffi::mpv_set_property_string(self.raw(), n.as_ptr(), v.as_ptr()) },
            || format!("set {name}={value}"),
        )
    }

    /// `mpv_set_property` with `MPV_FORMAT_DOUBLE` — synchronous, no string round trip.
    pub fn set_property_f64(&self, name: &str, value: f64) -> Result<(), MpvError> {
        let n = cstr(name)?;
        let mut v = value;
        check(
            unsafe {
                ffi::mpv_set_property(
                    self.raw(),
                    n.as_ptr(),
                    fmt_::MPV_FORMAT_DOUBLE,
                    &mut v as *mut f64 as *mut c_void,
                )
            },
            || format!("set {name}={value}"),
        )
    }

    /// `mpv_get_property_string`; `None` if the property is unavailable or unknown.
    pub fn get_property(&self, name: &str) -> Option<String> {
        let n = cstr(name).ok()?;
        unsafe {
            let p = ffi::mpv_get_property_string(self.raw(), n.as_ptr());
            if p.is_null() {
                return None;
            }
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            ffi::mpv_free(p as *mut c_void);
            Some(s)
        }
    }

    /// `mpv_get_property` as `MPV_FORMAT_DOUBLE`; `None` if unavailable/unknown.
    pub fn get_property_f64(&self, name: &str) -> Option<f64> {
        let n = cstr(name).ok()?;
        let mut v = 0f64;
        let rc = unsafe {
            ffi::mpv_get_property(
                self.raw(),
                n.as_ptr(),
                fmt_::MPV_FORMAT_DOUBLE,
                &mut v as *mut f64 as *mut c_void,
            )
        };
        (rc >= 0).then_some(v)
    }

    /// `mpv_command` (synchronous) with string arguments.
    pub fn command(&self, args: &[&str]) -> Result<(), MpvError> {
        let owned = args
            .iter()
            .map(|a| cstr(a))
            .collect::<Result<Vec<_>, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(ptr::null());
        check(
            unsafe { ffi::mpv_command(self.raw(), ptrs.as_mut_ptr()) },
            || format!("command {args:?}"),
        )
    }

    /// `mpv_command_async` — never waits on the core (render-thread safe). The outcome
    /// arrives as [`Event::CommandReply`] with `id`. Errors returned here are local
    /// (NUL in an argument, event queue full), never mpv's verdict on the command.
    pub fn command_async(&self, id: u64, args: &[&str]) -> Result<(), MpvError> {
        let owned = args
            .iter()
            .map(|a| cstr(a))
            .collect::<Result<Vec<_>, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(ptr::null());
        check(
            unsafe { ffi::mpv_command_async(self.raw(), id, ptrs.as_mut_ptr()) },
            || format!("command {args:?}"),
        )
    }

    /// `mpv_set_property_async` with `MPV_FORMAT_STRING` (mpv copies the value before
    /// returning). Outcome: [`Event::SetPropertyReply`] with `id`.
    pub fn set_property_async(&self, id: u64, name: &str, value: &str) -> Result<(), MpvError> {
        let (n, v) = (cstr(name)?, cstr(value)?);
        let mut vp: *const c_char = v.as_ptr();
        check(
            unsafe {
                ffi::mpv_set_property_async(
                    self.raw(),
                    id,
                    n.as_ptr(),
                    fmt_::MPV_FORMAT_STRING,
                    &mut vp as *mut *const c_char as *mut c_void,
                )
            },
            || format!("set {name}={value}"),
        )
    }

    /// `mpv_set_property_async` with `MPV_FORMAT_DOUBLE`.
    pub fn set_property_f64_async(&self, id: u64, name: &str, value: f64) -> Result<(), MpvError> {
        let n = cstr(name)?;
        let mut v = value;
        check(
            unsafe {
                ffi::mpv_set_property_async(
                    self.raw(),
                    id,
                    n.as_ptr(),
                    fmt_::MPV_FORMAT_DOUBLE,
                    &mut v as *mut f64 as *mut c_void,
                )
            },
            || format!("set {name}={value}"),
        )
    }

    /// `mpv_observe_property`: changes arrive as [`Event::PropertyChange`] with this `id`.
    pub fn observe(&self, id: u64, name: &str, format: Format) -> Result<(), MpvError> {
        let n = cstr(name)?;
        check(
            unsafe { ffi::mpv_observe_property(self.raw(), id, n.as_ptr(), format.raw()) },
            || format!("observe {name}"),
        )
    }

    /// `mpv_unobserve_property` — render-thread-safe (`client.h`), like `observe`.
    pub fn unobserve(&self, id: u64) -> Result<(), MpvError> {
        let r = unsafe { ffi::mpv_unobserve_property(self.raw(), id) };
        if r < 0 {
            return Err(MpvError::new(r, "unobserve"));
        }
        Ok(())
    }

    /// `mpv_request_log_messages` (`"no"`, `"fatal"`, `"error"`, `"warn"`, …).
    pub fn request_log_messages(&self, min_level: &str) -> Result<(), MpvError> {
        let l = cstr(min_level)?;
        check(
            unsafe { ffi::mpv_request_log_messages(self.raw(), l.as_ptr()) },
            || format!("request_log_messages {min_level}"),
        )
    }

    /// `mpv_set_wakeup_callback`. The callback runs on an arbitrary mpv thread and must
    /// not call any mpv function; `ctx` must stay valid until the callback is cleared
    /// (pass `None`) or the handle is destroyed.
    ///
    /// # Safety
    /// `ctx` must outlive the registration and be safe to use from another thread.
    pub unsafe fn set_wakeup_callback(
        &self,
        cb: Option<unsafe extern "C" fn(*mut c_void)>,
        ctx: *mut c_void,
    ) {
        unsafe { ffi::mpv_set_wakeup_callback(self.raw(), cb, ctx) }
    }

    /// `mpv_wait_event`; `timeout` 0.0 never blocks. Copies the event out.
    pub fn wait_event(&self, timeout: f64) -> Event {
        unsafe {
            let e = &*ffi::mpv_wait_event(self.raw(), timeout);
            match e.event_id {
                ev::MPV_EVENT_NONE => Event::None,
                ev::MPV_EVENT_SHUTDOWN => Event::Shutdown,
                ev::MPV_EVENT_LOG_MESSAGE => {
                    let m = &*(e.data as *const ffi::mpv_event_log_message);
                    Event::LogMessage {
                        prefix: owned(m.prefix),
                        level: owned(m.level),
                        text: owned(m.text),
                    }
                }
                ev::MPV_EVENT_START_FILE => {
                    let d = &*(e.data as *const ffi::mpv_event_start_file);
                    Event::StartFile {
                        entry: d.playlist_entry_id,
                    }
                }
                ev::MPV_EVENT_COMMAND_REPLY => {
                    let d = e.data as *const ffi::mpv_event_command;
                    Event::CommandReply {
                        id: e.reply_userdata,
                        error: e.error,
                        playlist_entry_id: d.as_ref().and_then(|d| node_entry_id(&d.result)),
                    }
                }
                ev::MPV_EVENT_SET_PROPERTY_REPLY => Event::SetPropertyReply {
                    id: e.reply_userdata,
                    error: e.error,
                },
                ev::MPV_EVENT_END_FILE => {
                    let d = &*(e.data as *const ffi::mpv_event_end_file);
                    let reason = match d.reason {
                        efr::MPV_END_FILE_REASON_EOF => EndReason::Eof,
                        efr::MPV_END_FILE_REASON_STOP => EndReason::Stop,
                        efr::MPV_END_FILE_REASON_QUIT => EndReason::Quit,
                        efr::MPV_END_FILE_REASON_ERROR => EndReason::Error,
                        efr::MPV_END_FILE_REASON_REDIRECT => EndReason::Redirect,
                        other => EndReason::Other(other),
                    };
                    Event::EndFile {
                        reason,
                        error: d.error,
                        entry: d.playlist_entry_id,
                    }
                }
                ev::MPV_EVENT_FILE_LOADED => Event::FileLoaded,
                ev::MPV_EVENT_PLAYBACK_RESTART => Event::PlaybackRestart,
                ev::MPV_EVENT_PROPERTY_CHANGE => {
                    let p = &*(e.data as *const ffi::mpv_event_property);
                    let value = if p.data.is_null() {
                        PropData::None
                    } else {
                        match p.format {
                            fmt_::MPV_FORMAT_FLAG => PropData::Flag(*(p.data as *const c_int) != 0),
                            fmt_::MPV_FORMAT_INT64 => PropData::I64(*(p.data as *const i64)),
                            fmt_::MPV_FORMAT_DOUBLE => PropData::F64(*(p.data as *const f64)),
                            fmt_::MPV_FORMAT_STRING => {
                                PropData::Str(owned(*(p.data as *const *const c_char)))
                            }
                            _ => PropData::None,
                        }
                    };
                    Event::PropertyChange {
                        id: e.reply_userdata,
                        name: owned(p.name),
                        value,
                    }
                }
                other => Event::Other(other),
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // After this returns no callback (wakeup) fires any more.
        unsafe { ffi::mpv_terminate_destroy(self.raw()) }
    }
}

/// `get_proc_address` signature `mpv_opengl_init_params` takes.
pub type GetProcAddress = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;

/// An OpenGL `mpv_render_context` bound to one [`Handle`].
///
/// **Must be dropped before its `Handle`, with the GL context it was created on current
/// on the calling thread** — `Drop` calls `mpv_render_context_free`, which releases GL
/// objects. `sources::mpv::MpvSource` guarantees both.
pub struct RenderContext {
    raw: NonNull<ffi::mpv_render_context>,
}

impl RenderContext {
    /// `mpv_render_context_create` with `MPV_RENDER_API_TYPE_OPENGL`.
    ///
    /// # Safety
    /// The GL context to render with must be current on this thread, `get_proc` must
    /// resolve GL functions for it, and the returned context must be dropped before
    /// `handle` (with that GL context current).
    pub unsafe fn create(handle: &Handle, get_proc: GetProcAddress) -> Result<Self, MpvError> {
        let mut init = ffi::mpv_opengl_init_params {
            get_proc_address: Some(get_proc),
            get_proc_address_ctx: ptr::null_mut(),
        };
        let mut params = [
            ffi::mpv_render_param {
                type_: ffi::mpv_render_param_type::MPV_RENDER_PARAM_API_TYPE,
                data: ffi::MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void,
            },
            ffi::mpv_render_param {
                type_: ffi::mpv_render_param_type::MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: &mut init as *mut _ as *mut c_void,
            },
            ffi::mpv_render_param {
                type_: ffi::mpv_render_param_type::MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        let mut raw = ptr::null_mut();
        let rc =
            unsafe { ffi::mpv_render_context_create(&mut raw, handle.raw(), params.as_mut_ptr()) };
        check(rc, || "mpv_render_context_create (OpenGL)".to_string())?;
        NonNull::new(raw)
            .map(|raw| RenderContext { raw })
            .ok_or_else(|| MpvError::new(ffi::mpv_error::MPV_ERROR_GENERIC, "render ctx null"))
    }

    /// `mpv_render_context_set_update_callback` — same rules as
    /// [`Handle::set_wakeup_callback`] (any thread, no mpv calls inside).
    ///
    /// # Safety
    /// `ctx` must outlive the registration and be safe to use from another thread.
    pub unsafe fn set_update_callback(
        &self,
        cb: Option<unsafe extern "C" fn(*mut c_void)>,
        ctx: *mut c_void,
    ) {
        unsafe { ffi::mpv_render_context_set_update_callback(self.raw.as_ptr(), cb, ctx) }
    }

    /// `mpv_render_context_update`: never blocks. True when a new video frame is waiting
    /// to be rendered (`MPV_RENDER_UPDATE_FRAME` — level-triggered: it stays set until a
    /// `render` consumes the frame).
    pub fn frame_pending(&self) -> bool {
        let flags = unsafe { ffi::mpv_render_context_update(self.raw.as_ptr()) };
        flags & ffi::mpv_render_update_flag::MPV_RENDER_UPDATE_FRAME as u64 != 0
    }

    /// `mpv_render_context_render` into GL framebuffer `fbo` (`w`×`h`, `internal_format`),
    /// with `MPV_RENDER_PARAM_FLIP_Y = flip_y` and `BLOCK_FOR_TARGET_TIME = 0` (never
    /// waits on mpv's frame clock).
    ///
    /// # Safety
    /// The render context's GL context must be current; `fbo` must be a complete
    /// framebuffer of that size in it.
    pub unsafe fn render(
        &self,
        fbo: u32,
        w: u32,
        h: u32,
        internal_format: u32,
        flip_y: bool,
    ) -> Result<(), MpvError> {
        let mut target = ffi::mpv_opengl_fbo {
            fbo: fbo as c_int,
            w: w as c_int,
            h: h as c_int,
            internal_format: internal_format as c_int,
        };
        let mut flip: c_int = flip_y as c_int;
        let mut block: c_int = 0;
        let mut params = [
            ffi::mpv_render_param {
                type_: ffi::mpv_render_param_type::MPV_RENDER_PARAM_OPENGL_FBO,
                data: &mut target as *mut _ as *mut c_void,
            },
            ffi::mpv_render_param {
                type_: ffi::mpv_render_param_type::MPV_RENDER_PARAM_FLIP_Y,
                data: &mut flip as *mut _ as *mut c_void,
            },
            ffi::mpv_render_param {
                type_: ffi::mpv_render_param_type::MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,
                data: &mut block as *mut _ as *mut c_void,
            },
            ffi::mpv_render_param {
                type_: ffi::mpv_render_param_type::MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        check(
            unsafe { ffi::mpv_render_context_render(self.raw.as_ptr(), params.as_mut_ptr()) },
            || "mpv_render_context_render".to_string(),
        )
    }
}

impl Drop for RenderContext {
    fn drop(&mut self) {
        unsafe {
            ffi::mpv_render_context_set_update_callback(self.raw.as_ptr(), None, ptr::null_mut());
            ffi::mpv_render_context_free(self.raw.as_ptr());
        }
    }
}
