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
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use glow::HasContext;
use serde_json::{Map, Value};

use super::render_worker::{Attached, Frame, RenderWorker, SyncFence};
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

/// The AO used when `opts` names none (spec §5.3). `serve` routes it into the player bus
/// (`audio_device` = `audio::bus::DEVICE`, Task 14).
pub const DEFAULT_AO: &str = "pipewire";

// Observed-property ids (`mpv_observe_property` reply_userdata).
const OBS_TIME_POS: u64 = 1;
const OBS_DURATION: u64 = 2;
const OBS_DWIDTH: u64 = 3;
const OBS_DHEIGHT: u64 = 4;
const OBS_EOF: u64 = 5;
const OBS_PAUSE: u64 = 6;
const OBS_IMAGE: u64 = 7;
const OBS_IDLE: u64 = 8;
/// Task 16c (R85): "real audio flowing" detector — see `MpvSource::arm_audio_flowing`.
const OBS_AUDIO_PTS: u64 = 9;
/// R92 (review of Task 16c/16d): does the *file* actually have an audio track mpv
/// selected? See `MpvSource::has_audio`'s doc.
const OBS_AUDIO_SELECTED: u64 = 10;
/// The longest a two-phase teardown waits for the core to go idle before freeing anyway.
const TEARDOWN_MAX: Duration = Duration::from_millis(500);

/// TODO "mpv's built-in Lua scripts per core": what libmpv would otherwise load into every
/// core at `mpv_initialize`. Each built-in script runs its own Lua VM on its own thread
/// (`lua/<name>`) and observes properties / registers bindings for an OSD, a console and
/// menus no one can open on a wallpaper (no input ever reaches a core). Measured (hermetic
/// headless, 1080p30 h264, mpv 0.41, release): a playing core had 28 threads, 6 of them
/// scripts (`commands`, `console`, `context_menu`, `positioning`, `select`, `stats`;
/// `auto_profiles` stays out at `auto` without conditional profiles, `osc`/`ytdl_hook` are
/// already off in libmpv) → 22. Applied best-effort by [`set_optional`]: a libmpv that
/// predates one of these names still opens (`mpv.options_skipped`, once per process).
pub(crate) const SCRIPT_TRIMS: [(&str, &str); 10] = [
    // No user scripts (`~/.config/mpv/scripts`; `config=no` already keeps the config dir
    // out — explicit, so no default can bring them back).
    ("load-scripts", "no"),
    // libmpv's own default already (the on-screen controller script); explicit.
    ("osc", "no"),
    ("load-stats-overlay", "no"),
    ("load-console", "no"),
    ("load-auto-profiles", "no"),
    ("load-select", "no"),
    ("load-commands", "no"),
    ("load-positioning", "no"),
    ("load-context-menu", "no"),
    // The built-in key/mouse bindings (mpv's input.conf) — parsed per core, never used.
    ("input-builtin-bindings", "no"),
];

/// No native clipboard per core. mpv ≥ 0.40 starts one at `mpv_initialize` (backends
/// `wayland`, `x11`, `vo` by default): with `WAYLAND_DISPLAY` its own `ext-data-control`
/// connection to the compositor (+ a thread, fed every clipboard change of the session),
/// without it and with a reachable `DISPLAY` its own X connection (+ a thread). A wallpaper
/// never reads the clipboard — and the X one killed the player: when that connection drops
/// (the X server goes away), mpv's clipboard thread `XCloseDisplay`s it, Xlib's default I/O
/// error handler calls `exit(1)` from that thread, and its atexit handlers tear NVIDIA's EGL
/// down under the loop → SIGSEGV (`tests/api.rs::losing_the_x_server_never_kills_the_player`).
/// An empty list = no backend at all. Best-effort like [`SCRIPT_TRIMS`]: an mpv that predates
/// the clipboard has no such option and nothing to turn off.
pub(crate) const CLIPBOARD_OFF: [(&str, &str); 1] = [("clipboard-backends", "")];

/// Set each of `opts` on a core before `mpv_initialize`, skipping any this libmpv rejects
/// (an unknown name on an older mpv — they are trims, never needed for correctness).
/// Returns the skipped ones as `"<name>: <mpv error>"`.
pub(crate) fn set_optional(handle: &Handle, opts: &[(&str, &str)]) -> Vec<String> {
    opts.iter()
        .filter_map(|(k, v)| handle.set_option(k, v).err().map(|e| format!("{k}: {e}")))
        .collect()
}

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
pub(crate) unsafe extern "C" fn get_proc_address(
    _ctx: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if unsafe { CStr::from_ptr(name) }.to_bytes() == b"glFenceSync" {
        return stub_fence_sync as *mut c_void;
    }
    unsafe { eglGetProcAddress(name) }
}

/// Wakeup + render-update callback (any mpv thread): bump the eventfd whose number is the
/// callback context. Only `write(2)` — no mpv calls, no allocation, never blocks
/// (`EFD_NONBLOCK`; a saturated counter just means "already signalled").
pub(crate) unsafe extern "C" fn on_wake(ctx: *mut c_void) {
    let fd = ctx as usize as RawFd;
    let one: u64 = 1;
    unsafe { libc::write(fd, &one as *const u64 as *const c_void, 8) };
}

/// `"image"` for common still-image extensions, else `"video"`. Refined after load by
/// mpv's own `current-tracks/video/image` flag.
pub(crate) fn infer_kind(path: &str) -> &'static str {
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

/// Task 20d (R107): the hardware decoders `auto` tries, in order, ahead of mpv's own copy
/// list. mpv 0.41's own order is `vulkan, nvdec, vaapi, vulkan-copy, nvdec-copy, …` — with no
/// GL interop (below) `auto` would pick `vulkan-copy`, which on NVIDIA costs more CPU than
/// `nvdec-copy` (1080p30: 14.4 vs 9.8 %, 4K60: 80 vs 56 % of a core), shows its first frame
/// later (~700 vs ~450 ms) and, without a reachable X server, holds a driver lock our GL
/// calls wait on for 230–320 ms per switch. On AMD/Intel `nvdec-copy` fails at once (no
/// libcuda) and `vaapi-copy` is the normal pick; anything else falls through to mpv's list.
const AUTO_COPY: [&str; 2] = ["nvdec-copy", "vaapi-copy"];

/// The zero-copy decoders a render context that loaded `gpu-hwdec-interop=<interop>` can show
/// (`auto`'s preference first): the CUDA interop takes nvdec's/cuda's frames, the VAAPI one
/// vaapi's, drmprime v4l2m2m's. Every other interop decoder has no GL interop on our EGL
/// renderer (`vulkan` needs mpv's Vulkan renderer, `vdpau` GLX, `amf` D3D/Vulkan) — always its
/// copy twin.
fn zero_copy_decoders(interop: Option<&str>) -> &'static [&'static str] {
    match interop {
        Some("cuda") => &["nvdec", "cuda"],
        Some("vaapi") => &["vaapi"],
        Some("drmprime") => &["v4l2m2m"],
        Some("all") => &["nvdec", "vaapi", "cuda", "v4l2m2m"],
        _ => &[],
    }
}

/// The mpv `hwdec` value for a graph `hwdec`, given the `gpu-hwdec-interop` the source's
/// render context loaded (`interop`; § Sources "Hardware decoding").
///
/// **`interop: None` — copy modes only (Task 20d, R107).** A render context on the LOOP
/// (render worker off, stepped mode, a synchronous open) runs `gpu-hwdec-interop=no`: mpv's
/// render context runs every hwdec interop's init inside the render thread, and with
/// `gpu-hwdec-interop=auto` it loads the CUDA interop (a CUDA context) in
/// `mpv_render_context_create` itself: 65–90 ms per switch whenever libcuda is loadable, even
/// with `hwdec=no`. So the hardware decoder is used in its copy mode: `""`/`no` → `no`;
/// `auto`, `auto-safe`, `yes`, `auto-copy`, `auto-copy-safe`, `auto-unsafe`,
/// `auto-copy-unsafe` → [`AUTO_COPY`] + mpv's `auto-copy[-safe|-unsafe]`; an interop name
/// (every mpv 0.41 decoder with a `-copy` twin: `nvdec`, `cuda`, `vaapi`, `vdpau`, `vulkan`,
/// `amf`, `v4l2m2m`) → its `-copy` twin; anything else (a `-copy` mode, a name mpv doesn't
/// know — mpv rejects it and the prop reverts, R45) passes through unchanged.
///
/// **`interop: Some(i)` — zero-copy on the render worker.** The render context lives on the
/// `lp-render` thread, so the interop's init costs that thread, not the loop. A decoder the
/// interop can show ([`zero_copy_decoders`]) is asked for as itself, **followed by its copy
/// twin** (an interop that failed to load — no libcuda yet — or a codec the GPU can't do in
/// zero-copy falls back to the copy, never to software); `auto`, `auto-safe`, `yes`,
/// `auto-unsafe` put the interop's decoders ahead of the copy list (`cuda`: `nvdec,
/// nvdec-copy,vaapi-copy,auto-copy`); the `auto-copy*` family stays copy (asked for
/// explicitly); every other interop name → its copy twin as above.
///
/// A comma list maps element by element (duplicates dropped, order kept). The graph keeps the
/// user's value (`read("hwdec")`); the `sources` probe shows both (`mpv_hwdec`,
/// `mpv_hwdec_current`) and the source's `hwdec_interop`.
pub fn mpv_hwdec(value: &str, interop: Option<&str>) -> String {
    let zero = zero_copy_decoders(interop);
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        if !out.iter().any(|o| o == s) {
            out.push(s.to_string());
        }
    };
    for e in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        match e {
            "auto" | "auto-copy" | "auto-safe" | "yes" | "auto-copy-safe" | "auto-unsafe"
            | "auto-copy-unsafe" => {
                if !e.starts_with("auto-copy") {
                    // `cuda` names the same decoder as `nvdec` (mpv's older alias): auto
                    // asks for it once.
                    for z in zero.iter().filter(|z| **z != "cuda") {
                        push(z);
                    }
                }
                for a in AUTO_COPY {
                    push(a);
                }
                push(match e {
                    "auto" | "auto-copy" => "auto-copy",
                    "auto-unsafe" | "auto-copy-unsafe" => "auto-copy-unsafe",
                    _ => "auto-copy-safe",
                });
            }
            "nvdec" | "cuda" | "vaapi" | "vdpau" | "vulkan" | "amf" | "v4l2m2m" => {
                if zero.contains(&e) {
                    push(e);
                }
                push(&format!("{e}-copy"))
            }
            other => push(other),
        }
    }
    if out.is_empty() {
        "no".to_string()
    } else {
        out.join(",")
    }
}

/// The `af` chain mpv runs for graph `af` (the user's chain, e.g. the backend's loudnorm): that
/// chain plus a permanent `scaletempo2` (label `@lp-tempo`). With pitch correction on (mpv's
/// default) mpv adds its own tempo filter only while `speed` ≠ 1 and drops it at exactly 1× —
/// and every add/drop rebuilds the audio chain (its `userspeed` + format `convert` stages): 3–5 ms
/// of digital silence each, ~200 ms later at the sink (speed storm: 22 holes in 40 s of 0.9↔1.0
/// toggles, none for 0.9↔1.1). mpv hands the speed to the last filter of the chain that takes it,
/// so with ours there the chain is built once and never changes; at 1× scaletempo2 is bit-exact
/// (measured: output identical to the source, zero lag). A chain that already has a tempo filter
/// (`scaletempo*`, `rubberband`) is left as it is — that filter takes the speed instead.
/// `read("af")` keeps the graph value.
pub fn mpv_af(value: &str) -> String {
    let af = value.trim();
    let has_tempo = af.split(',').any(|f| {
        let f = f.trim();
        let f = match f.split_once(':') {
            Some((label, rest)) if label.starts_with('@') => rest,
            _ => f,
        };
        let name = f.split_once('=').map_or(f, |(n, _)| n);
        matches!(name, "scaletempo" | "scaletempo2" | "rubberband")
    });
    if has_tempo {
        af.to_string()
    } else if af.is_empty() {
        TEMPO_AF.to_string()
    } else {
        format!("{af},{TEMPO_AF}")
    }
}

/// The tempo filter [`mpv_af`] keeps in every chain.
const TEMPO_AF: &str = "@lp-tempo:scaletempo2";

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
    /// A stepped-mode `seek` ([`MpvSource::step_seek`]).
    Step,
    /// The teardown `stop` ([`Source::begin_teardown`]).
    Stop,
}

/// Where a stepped-mode frame request is ([`MpvSource::step_status`]).
#[derive(Debug, Clone, PartialEq)]
pub enum StepStatus {
    /// The frame for the requested position is in the texture (or nothing was asked and
    /// the source is ready).
    Done,
    /// Still waiting — for what (`"ready"`, `"seek reply"`, `"playback restart"`,
    /// `"frame"`), for error messages.
    Pending(&'static str),
    /// The source can't produce it (load error, seek rejected, core gone): don't wait.
    Broken(String),
}

/// One stepped-mode seek in flight.
#[derive(Debug)]
struct StepSeek {
    target: f64,
    req: u64,
    replied: bool,
    /// PLAYBACK_RESTART seen after the seek's reply (the reply always precedes the seek's
    /// own restart: mpv completes the `seek` command before the playloop executes it).
    restarted: bool,
    /// A frame rendered after that restart (the target frame, or mpv's redraw of it).
    rendered: bool,
    /// A NEW frame (not a redraw) rendered after the reply — the target frame, whether it came
    /// before or after the restart. mpv queues it to the VO in the same playloop iteration that
    /// then emits PLAYBACK_RESTART, so the loop can render it before it pumps the event (under
    /// load: every step); a frame rendered after the restart was then only mpv's REDRAW of it,
    /// which doesn't always follow (measured: never at 2.8 s of a 3 s clip with its loop off) —
    /// the step waited out `STEP_TIMEOUT`.
    target_frame: bool,
    error: Option<String>,
}

/// One FBO-backed render target.
type Target = (Tex, Fbo);

/// I5 (final review): an mpv core created, configured and initialized by
/// [`MpvSource::prepare_core`] — on any thread — and not yet given a render context or a
/// file. [`MpvSource::open_with_core`] turns it into a source on the loop thread; dropped
/// unused (its node went away while it was being prepared), its wakeup callback is cleared
/// and the core handed to the reaper before its eventfd closes.
pub struct PreparedCore {
    handle: Option<Handle>,
    wake: Option<OwnedFd>,
    /// Phase 2: its render context already lives on the render worker
    /// ([`PreparedCore::attach_render`]).
    render: Option<Attached>,
    /// The `gpu-hwdec-interop` that render context loaded (zero-copy hwdec; `None` = copy
    /// modes, [`mpv_hwdec`]).
    interop: Option<&'static str>,
}

// SAFETY: libmpv's client API is thread-safe (`client.h`); a prepared core is only ever
// moved between threads, never used from two at once (a render context attached to it is
// the render worker's, which only it touches).
unsafe impl Send for PreparedCore {}

impl PreparedCore {
    /// Phase 2 (render worker): give this core's rendering to `worker` — it creates the render
    /// context on its own context (`RenderWorker::attach`, which this waits for — call it on
    /// an `lp-open` thread, never the loop). A worker that can't leaves the core as it was:
    /// the source then renders on the loop. Only a timed-out attach (the core stayed with
    /// the worker, which reaps it) is an error.
    ///
    /// `interop`: load the worker's hwdec GL interop (`RenderWorker::hwdec_interop`) into
    /// the render context — zero-copy hardware decoding (§ Sources "Hardware decoding"). Its
    /// init (a CUDA context on NVIDIA, 85–220 ms) runs in `mpv_render_context_create`, i.e. on
    /// the worker; so only an attach the LOOP doesn't wait for may ask (the `lp-open` job —
    /// never a synchronous open, which waits for this reply on the loop), and only for a
    /// source that will decode in hardware (the caller knows its `hwdec` and kind).
    pub fn attach_render(
        mut self,
        worker: &Arc<RenderWorker>,
        interop: bool,
    ) -> Result<Self, ApiError> {
        let (Some(h), Some(fd)) = (
            self.handle.take(),
            self.wake.as_ref().map(|w| w.as_raw_fd()),
        ) else {
            return Ok(self);
        };
        // Read by `mpv_render_context_create` (prepare_core set `no`; an option set after
        // `mpv_initialize` is the `options/` property — no render context exists yet).
        let interop = worker
            .hwdec_interop()
            .filter(|_| interop)
            .filter(|i| h.set_option("gpu-hwdec-interop", i).is_ok());
        match worker.attach(h, fd) {
            Ok((h, att)) => {
                self.handle = Some(h);
                self.render = Some(att);
                self.interop = interop;
                Ok(self)
            }
            Err(Some(h)) => {
                // Rendering on the loop after all: no interop init there (Task 20d).
                if interop.is_some() {
                    let _ = h.set_option("gpu-hwdec-interop", "no");
                }
                self.handle = Some(h);
                Ok(self)
            }
            Err(None) => {
                // The core's wakeup callback still writes this eventfd until the worker
                // clears it: keep the fd open for good rather than let its number be reused.
                if let Some(w) = self.wake.take() {
                    let _ = w.into_raw_fd();
                }
                Err(io_error(
                    "render worker didn't answer in time; the mpv core was handed to it",
                ))
            }
        }
    }
}

impl Drop for PreparedCore {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            // No write to the eventfd once this returns; the fd closes after (field drop).
            unsafe { h.set_wakeup_callback(None, ptr::null_mut()) };
            match self.render.take() {
                // The worker frees the render context (its context current), then reaps.
                Some(att) => {
                    if let Err(Some(h)) = att.free(Some(h), Vec::new()) {
                        // Worker gone (at exit, or it died): never free a render context
                        // without its context — leak it, silent.
                        let _ = h.command_async(0, &["stop"]);
                        std::mem::forget(h);
                        super::render_worker::note_leaked();
                    }
                }
                None => super::reaper::reap(h),
            }
        }
    }
}

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

    // Phase 2 (render worker, § Sources "Render worker"): `Some` = the render context lives
    // on the worker; `render`/`front`/`back` above stay `None` and these hold the textures
    // the worker handed over (it owns their FBOs and deletes them).
    worker: Option<Attached>,
    /// The `gpu-hwdec-interop` the worker's render context loaded (zero-copy hwdec: `hwdec`
    /// asks for the interop decoders first, `mpv_hwdec`); `None` = copy modes (every
    /// loop-rendered source, and a worker one opened without it).
    hwdec_interop: Option<&'static str>,
    w_front: Option<Tex>,
    w_back: Option<Tex>,
    /// The newest frame taken from the worker whose fence hadn't signalled yet.
    w_pending: Option<Frame>,
    /// The size last told to the worker.
    w_size: Option<(u32, u32)>,
    /// Frames whose fence wasn't signalled when first seen (kept the previous frame).
    w_adopt_deferred: u64,
    w_adopted: u64,
    /// FILE_LOADED events pumped (every one, current load or not — the worker's weak client
    /// counts the same), and that count at the current load's FILE_LOADED: a worker frame
    /// tagged with it was rendered after that FILE_LOADED.
    fl_seen: u64,
    loaded_fl: Option<u64>,
    /// An `Ended` held back until this load's `Ready` (either renderer: a render stalled past a
    /// short clip's end must not report the end of a source that never showed a frame).
    ended_held: bool,

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
    /// When the current load (re)started, and when its lost frame was last asked for again
    /// ([`REFETCH_AFTER`]); `refetches` counts those requests (process lifetime, `sources` probe).
    restarted_at: Option<Instant>,
    refetched_at: Option<(Instant, Duration)>,
    refetches: u32,

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
    /// The current load failed (cleared by the next load): stepped mode doesn't wait on it.
    load_failed: Option<String>,

    /// Stepped (deterministic headless) mode, R48: mpv itself stays paused for good;
    /// `paused`/`position` are stored (logical, what the graph says) but not sent — the
    /// runtime shows each step's frame with [`MpvSource::step_seek`].
    stepped: bool,
    step: Option<StepSeek>,

    // Two-phase teardown (R51, `Source::begin_teardown`).
    /// A START_FILE was ever seen (a VO may exist).
    started_any: bool,
    /// mpv reported `idle-active` = true after the last file ended (its VO is gone).
    /// Starts false ("unknown"): only a notification after an END_FILE sets it.
    idle_after_end: bool,
    /// When `begin_teardown` was called.
    teardown_at: Option<Instant>,
    /// When the teardown `stop` was sent, and its request id.
    teardown: Option<(Instant, u64)>,
    /// The core is idle (VO uninitialised) after that `stop`: freeing the render context
    /// won't wait on the playloop.
    idle_after_stop: bool,
    /// Seconds ADDED to every `audio_delay` the graph sets before it reaches mpv's
    /// `audio-delay` (opt `audio_delay_bias`; `serve` passes −bus latency, Task 14).
    /// `read("audio_delay")` stays the graph's value.
    audio_delay_bias: f64,
    /// Task 16c (R85): armed by `apply("paused", false)` on a source that was paused —
    /// waiting for `audio-pts` to actually move before reporting [`SourceEvent::AudioFlowing`].
    /// `audio-pts` ("Current audio playback position... takes into account the audio
    /// driver delay", man mpv) only changes once samples are really flowing — unlike
    /// `time-pos`, it does not move while held/paused, so the very next change after
    /// arming is the real thing, not a stale carry-over.
    ///
    /// **Measured on-machine (review fix round, 4 runs): not quite true.** `audio-pts`'s
    /// *first* change after an un-pause lands anywhere from ~4 ms to ~65 ms later (highly
    /// variable), and — regardless of how long that itself took — the bus meter then
    /// shows a further ~12–33 ms of true digital silence *after* that change before any
    /// real sample arrives (one run: change at +65 ms, first real audio at +85 ms; another:
    /// change at +34 ms, first real audio at +67 ms). So
    /// `audio-pts` changing reflects the decoder/demuxer position catching up, not the AO
    /// actually emitting samples yet — a ramp gated on the first change alone (or even a
    /// minimum delay since *arming*, tried first and also measured insufficient here)
    /// still reproduces the exact bug R85 exists to fix. Fixed by requiring
    /// [`FLOWING_CONFIRM_MARGIN`] of real time *since that first change itself* (see its
    /// own doc) before trusting it — `audio-pts` changing at all is still required (a
    /// never-playing/stuck core must never falsely confirm), it just isn't trusted the
    /// instant it happens, and the recipe/runtime's own `ONSET_TIMEOUT` (150 ms) remains
    /// the outer safety net regardless.
    awaiting_flowing: bool,
    /// When `audio-pts` was *first* seen to change since arming (`Instant`, paired with
    /// [`FLOWING_CONFIRM_MARGIN`]) — `None` until that first change.
    flowing_confirmed_at: Option<Instant>,
    /// M4: `audio-pts` is observed (only while `awaiting_flowing`), and the value of its
    /// first notification since observing — mpv reports the current value right away on
    /// `observe`, which is not a change.
    pts_observed: bool,
    flowing_last_pts: Option<f64>,
    /// While armed: the media position when the wait began (the first `time-pos` seen
    /// since arming), and whether `audio-pts` was last reported *unavailable* — mpv has no
    /// audio playing then (none selected, or the track already ended). Both together decide
    /// [`NO_AUDIO_MEDIA_ADVANCE`]'s "the picture plays on without any audio" confirmation.
    flowing_arm_pos: Option<f64>,
    audio_pts_unavailable: bool,
    /// R92 (review of Task 16c/16d): whether the *current load* actually has an audio
    /// track mpv selected — unlike `no_audio` (our own request to disable it) or
    /// `kind == "video"` (just "this isn't a still image"), this is what mpv itself
    /// resolved after the file loaded: the observed `aid` property (`OBS_AUDIO_SELECTED`
    /// — a track number = has one, the literal `"no"` = none, `"auto"` = not resolved
    /// yet; `current-tracks/audio/id` was tried first and never re-notifies for a file
    /// without audio). `None` = not yet known (no file loaded, or no notification
    /// seen yet for this load) — every caller treats that as "has audio" (the
    /// conservative default: never falsely skip a ramp/wait a real stream needs).
    /// Without this, a video file with literally no audio stream (common for subtly
    /// silent wallpapers) made every onset (R85) and R88 pause/resume wait the full
    /// `ONSET_TIMEOUT` and log a warning, forever, since the old check
    /// (`kind == "video" && !no_audio`) can't tell "disabled" apart from "never had
    /// one". Reset to `None` on every new load (`StartFile`); set from `on_prop`.
    has_audio: Option<bool>,
}

/// Task 16c (R85 review fix round): the real time required *after* `audio-pts`'s first
/// post-un-pause change before it's trusted as "audio is really flowing" — see
/// `awaiting_flowing`'s doc for the measurement (observed 12–33 ms of continued silence
/// after that first change, across 4 on-machine runs; a 25 ms margin still left a ~2.6 ms
/// residual gap in the worst of those). 40 ms gives real margin over the worst case seen
/// while staying small against `ONSET_TIMEOUT` (150 ms), so a source whose restart is
/// genuinely slower than this still gets its ramp started by the outer timeout rather
/// than this constant silently absorbing an even larger lag.
const FLOWING_CONFIRM_MARGIN: Duration = Duration::from_millis(40);

/// mpv's VO waits 200 ms for the API user to render a frame (vo_libmpv `flip_page`), then drops it
/// (`next_frame = NULL`: `mpv_render_context_update` stops reporting `UPDATE_FRAME`). A paused source or
/// an image whose only frame went unrendered — the loop or the render worker busy past that, or the
/// size (`dwidth`/`dheight`) not pumped yet — has no next frame: it never became Ready. After this long
/// restarted without a staged frame it asks mpv for the frame again (`refetch_lost_frame`), backing off
/// ×2 per try up to `REFETCH_MAX`.
const REFETCH_AFTER: Duration = Duration::from_millis(300);
const REFETCH_MAX: Duration = Duration::from_millis(2400);

/// Media seconds the picture must have played since an `AudioFlowing` wait was armed, with
/// `audio-pts` unavailable throughout, before "no audio is playing at all" is believed
/// (`MpvSource::confirm_flowing_by_time`): several frames at any frame rate, well inside
/// `ONSET_TIMEOUT` (150 ms) at 1×. A position that wraps (a loop) counts as moved.
const NO_AUDIO_MEDIA_ADVANCE: f64 = 0.1;

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
    /// - `audio_delay_bias` — seconds added to every `audio_delay` before it reaches mpv's
    ///   `audio-delay` (the bus's latency compensation: −`Bus::latency()`, Task 14);
    /// - `kind` — `"video"` | `"image"`; default inferred from the extension;
    /// - `stepped` — `true`: deterministic stepped mode (R48; mpv stays paused, frames come
    ///   from [`MpvSource::step_seek`] — see the field doc).
    ///
    /// `path` in `opts` is ignored (the argument wins); read-only and unknown names are
    /// rejected with the graph's own error codes; a value mpv rejects here is
    /// `out_of_range`/`unsupported` (setup is synchronous — no file is loaded yet).
    pub fn open(gfx: &Gfx, path: &str, opts: &Map<String, Value>) -> Result<MpvSource, ApiError> {
        let core = MpvSource::prepare_core(opts)?;
        MpvSource::open_with_core(gfx, path, opts, core)
    }

    /// I5 (final review): the part of [`open`](Self::open) that needs no GL context and no
    /// node props — the eventfd, `mpv_create`, the fixed options, `mpv_initialize`, the
    /// property observers and the wakeup callback — measured 2–8 ms per source, so the
    /// runtime runs it on a worker thread (`SourceHost`'s async open) and only the render
    /// context, the property applies and the `loadfile` stay on the loop
    /// ([`open_with_core`](Self::open_with_core)). Reads `ao`, `audio_device` and
    /// `shader_cache_dir` from `opts`; everything else is ignored here.
    pub fn prepare_core(opts: &Map<String, Value>) -> Result<PreparedCore, ApiError> {
        let opt_str = |k: &str| -> Result<Option<&str>, ApiError> {
            match opts.get(k) {
                None => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.as_str())),
                Some(other) => Err(bad_type(format!("{k} must be a string, got {other}"))),
            }
        };
        let ao = opt_str("ao")?.unwrap_or(DEFAULT_AO).to_string();
        let audio_device = opt_str("audio_device")?.map(str::to_string);
        // I5: mpv's GL shader cache — the first render of a new render context compiles
        // its shaders; with a cache dir the program binaries are reused across sources.
        let shader_cache_dir = opt_str("shader_cache_dir")?.map(str::to_string);

        // The eventfd outlives the core: `PreparedCore`/`MpvSource` clear the wakeup
        // callback and hand the core away before the fd closes.
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
        let fixed: [(&str, &str); 18] = [
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
            // I5: the default `fruit` dither builds its blue-noise matrix on the CPU in
            // the first render of every render context — measured ~25–30 ms on the loop
            // per switch (with it: first `update` 33–65 ms; `ordered`: 6–19 ms). Ordered
            // dithering of the same 8-bit target is visually equivalent for wallpapers.
            ("dither", "ordered"),
            // Task 20d (R107): no hwdec GL interop. mpv's default (`auto`) loads the CUDA
            // interop — a CUDA context — inside `mpv_render_context_create`, on the loop:
            // 65–90 ms per switch whenever libcuda is loadable (the flake wrapper's
            // LD_LIBRARY_PATH, or once libavutil loaded it for nvdec-copy), even with
            // `hwdec=no`. Hardware decoding runs in its copy mode instead (`mpv_hwdec`).
            ("gpu-hwdec-interop", "no"),
            ("ao", &ao),
        ];
        for (k, v) in fixed {
            handle.set_option(k, v).map_err(api_err)?;
        }
        // No built-in scripts/bindings (6 threads per core fewer), no clipboard (its own
        // X/Wayland connection + thread per core) — best-effort.
        let mut skipped = set_optional(&handle, &SCRIPT_TRIMS);
        skipped.extend(set_optional(&handle, &CLIPBOARD_OFF));
        if !skipped.is_empty() {
            static ONCE: std::sync::Once = std::sync::Once::new();
            ONCE.call_once(|| {
                crate::log::event(
                    "mpv",
                    crate::log::Level::Info,
                    "mpv.options_skipped",
                    None,
                    serde_json::json!({ "skipped": skipped }),
                )
            });
        }
        if let Some(dev) = &audio_device {
            handle.set_option("audio-device", dev).map_err(api_err)?;
        }
        if let Some(dir) = &shader_cache_dir {
            handle
                .set_option("gpu-shader-cache", "yes")
                .map_err(api_err)?;
            handle
                .set_option("gpu-shader-cache-dir", dir)
                .map_err(api_err)?;
        }
        handle.initialize().map_err(api_err)?;
        // Debug: LP_PLAYER_MPV_LOG=<mpv level, e.g. v> prints every core's mpv log to stderr (serve: its log
        // file) — what the core was doing, e.g. a VO that gave up waiting for a render.
        let diag = std::env::var("LP_PLAYER_MPV_LOG").ok();
        handle
            .request_log_messages(diag.as_deref().unwrap_or("error"))
            .map_err(api_err)?;
        for (id, name, f) in [
            (OBS_TIME_POS, "time-pos", Format::F64),
            (OBS_DURATION, "duration", Format::F64),
            (OBS_DWIDTH, "dwidth", Format::I64),
            (OBS_DHEIGHT, "dheight", Format::I64),
            (OBS_EOF, "eof-reached", Format::Flag),
            (OBS_PAUSE, "pause", Format::Flag),
            (OBS_IMAGE, "current-tracks/video/image", Format::Flag),
            (OBS_IDLE, "idle-active", Format::Flag),
            // `audio-pts` (OBS_AUDIO_PTS) is observed only while an `AudioFlowing`
            // confirmation is armed (M4): it changes at the audio-buffer rate, and every
            // change wakes the loop.
            (OBS_AUDIO_SELECTED, "aid", Format::Str),
        ] {
            handle.observe(id, name, f).map_err(api_err)?;
        }
        // SAFETY: the fd stays open until after the callback is cleared (PreparedCore /
        // MpvSource Drop).
        unsafe { handle.set_wakeup_callback(Some(on_wake), wake_ctx) };
        Ok(PreparedCore {
            handle: Some(handle),
            wake: Some(wake),
            render: None,
            interop: None,
        })
    }

    /// The loop-thread half of [`open`](Self::open) on a core from
    /// [`prepare_core`](Self::prepare_core): validate the node opts, create the render
    /// context (GL current), apply every property, `loadfile`.
    pub fn open_with_core(
        gfx: &Gfx,
        path: &str,
        opts: &Map<String, Value>,
        mut core: PreparedCore,
    ) -> Result<MpvSource, ApiError> {
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
        let stepped = match opts.get("stepped") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(other) => return Err(bad_type(format!("stepped must be a bool, got {other}"))),
        };
        let audio_delay_bias = match opts.get("audio_delay_bias") {
            None => 0.0,
            Some(v) => v.as_f64().filter(|f| f.is_finite()).ok_or_else(|| {
                bad_type(format!(
                    "audio_delay_bias must be a number of seconds, got {v}"
                ))
            })?,
        };

        // Type every remaining opt up front (bad shapes fail before any more mpv work).
        let mut given: BTreeMap<String, PropValue> = BTreeMap::new();
        let mut start: Option<f64> = None;
        for (k, v) in opts {
            match k.as_str() {
                "ao" | "audio_device" | "audio_delay_bias" | "kind" | "path" | "stepped"
                | "shader_cache_dir" => {}
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

        // The fd is declared first, so on an early return it closes *after* the core
        // (and its wakeup callback) is gone.
        let wake = core.wake.take().expect("a prepared core has its eventfd");
        let handle = core.handle.take().expect("a prepared core has its handle");
        // Phase 2: a render context made on the render worker (nothing to create here; from
        // now on `MpvSource::drop` hands it back to the worker).
        let worker = core.render.take();
        let hwdec_interop = core.interop.filter(|_| worker.is_some());
        drop(core);
        let wake_ctx = wake.as_raw_fd() as usize as *mut c_void;

        // The render context must be created with *this* Gfx's context current — don't
        // assume it is (another Gfx may have been made current since).
        let gl = gfx.keep_alive();
        let render = match &worker {
            Some(_) => None,
            None => {
                let cur = gl.make_current();
                if !cur.is_current() {
                    return Err(io_error("can't make the source's GL context current"));
                }
                // SAFETY: context current (above); Drop frees the render context with it
                // current and before the core.
                let r =
                    unsafe { RenderContext::create(&handle, get_proc_address) }.map_err(api_err)?;
                unsafe { r.set_update_callback(Some(on_wake), wake_ctx) };
                Some(r)
            }
        };

        let mut writable = BTreeMap::new();
        for (name, pd) in props::schema_for_kind(NodeKind::Source) {
            if !pd.readonly {
                writable.insert(name.to_string(), pd.default);
            }
        }
        writable.insert("kind".into(), PropValue::Str(kind.into()));
        writable.insert("path".into(), PropValue::Str(path.into()));

        let mut src = MpvSource {
            render,
            handle: Some(handle),
            wake,
            gl,
            front: None,
            back: None,
            back_valid: false,
            worker,
            hwdec_interop,
            w_front: None,
            w_back: None,
            w_pending: None,
            w_size: None,
            w_adopt_deferred: 0,
            w_adopted: 0,
            fl_seen: 0,
            loaded_fl: None,
            ended_held: false,
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
            restarted_at: None,
            refetched_at: None,
            refetches: 0,
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
            load_failed: None,
            stepped,
            step: None,
            started_any: false,
            idle_after_end: false,
            teardown_at: None,
            teardown: None,
            idle_after_stop: false,
            audio_delay_bias,
            awaiting_flowing: false,
            flowing_confirmed_at: None,
            pts_observed: false,
            flowing_last_pts: None,
            flowing_arm_pos: None,
            audio_pts_unavailable: false,
            has_audio: None,
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
        if stepped {
            // Paused for good; `props["paused"]` keeps the logical value.
            src.core().set_property("pause", "yes").map_err(api_err)?;
        }
        src.live = true;
        src.load(path)?;
        Ok(src)
    }

    /// I7 (final review): live re-route of this source's audio — `device` = mpv
    /// `audio-device` (`None` = `auto`, mpv's default device: the bus is down), `bias` =
    /// the new `audio_delay_bias` (−bus latency). mpv reloads its audio output on an
    /// `audio-device` change; async, like every live apply.
    pub fn set_audio_route(&mut self, device: Option<&str>, bias: f64) -> Result<(), ApiError> {
        self.prev_value = None;
        self.set("audio_device", "audio-device", device.unwrap_or("auto"))?;
        // A dead server takes mpv's audio output with it, and mpv then *deselects* the
        // audio track ("Audio: no audio") — an `audio-device` change alone doesn't bring it
        // back (measured: `current-ao` stayed unset after the bus returned, and so did a
        // plain `aid=auto`). Deselecting and re-selecting the track does: the audio chain
        // is rebuilt on the new device.
        if !matches!(self.props.get("no_audio"), Some(PropValue::Bool(true))) {
            for v in ["no", "auto"] {
                self.prev_value = self.props.get("no_audio").cloned();
                self.set("no_audio", "aid", v)?;
            }
            // Its audio restarts: a caller holding a ramp-in learns when it really flows.
            if !matches!(self.props.get("paused"), Some(PropValue::Bool(true))) {
                self.arm_audio_flowing();
            }
        }
        if (bias - self.audio_delay_bias).abs() > 1e-9 {
            self.audio_delay_bias = bias;
            let d = self.props.get("audio_delay").map_or(0.0, num) + bias;
            self.prev_value = self.props.get("audio_delay").cloned();
            self.set_f64("audio_delay", "audio-delay", d)?;
        }
        Ok(())
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

    /// Opened in stepped mode (`stepped: true`).
    pub fn is_stepped(&self) -> bool {
        self.stepped
    }

    /// The current load is `Ready` (its first frame is the texture).
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// Stepped mode (R48): show the frame at media time `t` — `seek <t> absolute exact`
    /// with mpv paused. [`MpvSource::step_status`] says when that frame is the texture.
    /// Only call once the source [`is_ready`](Self::is_ready).
    pub fn step_seek(&mut self, t: f64) -> Result<(), ApiError> {
        if !self.stepped {
            return Err(unsupported(format!(
                "{}: step_seek on a source not opened in stepped mode",
                self.path
            )));
        }
        // Fixed formatting: the same virtual time always becomes the same command.
        let ts = format!("{t:.6}");
        let id = self.req_id();
        self.core()
            .command_async(id, &["seek", &ts, "absolute", "exact"])
            .map_err(api_err)?;
        self.inflight.insert(
            id,
            Request {
                what: format!("seek {ts} absolute exact (step)"),
                kind: ReqKind::Step,
            },
        );
        self.step = Some(StepSeek {
            target: t,
            req: id,
            replied: false,
            restarted: false,
            rendered: false,
            target_frame: false,
            error: None,
        });
        Ok(())
    }

    /// The teardown `stop` — only once the last gain push has reached mpv (a coalesced
    /// one may still be owed): stopping cuts the audio, so the final −96 dB must land first.
    fn send_teardown_stop(&mut self) {
        if self.teardown.is_some() || self.gain_inflight || self.gain_dirty {
            return;
        }
        let id = self.req_id();
        if self.core().command_async(id, &["stop"]).is_err() {
            self.dead = true; // can't stop it: just let it go
            return;
        }
        self.inflight.insert(
            id,
            Request {
                what: "stop (teardown)".into(),
                kind: ReqKind::Stop,
            },
        );
        self.teardown = Some((Instant::now(), id));
    }

    /// Stepped mode: whether this step's virtual time is at the (non-looping) end. The
    /// first step at the end queues `Ended` (once per play-through, like the real clock);
    /// a step back before the end re-arms it.
    pub fn step_end(&mut self, at_end: bool) {
        if !self.stepped || self.kind == "image" {
            return;
        }
        if at_end && !self.ended_sent {
            self.ended_sent = true;
            self.pending.push(SourceEvent::Ended);
        } else if !at_end {
            self.ended_sent = false;
        }
    }

    /// The target of the last [`step_seek`](Self::step_seek), if one was issued for the
    /// current load.
    pub fn step_target(&self) -> Option<f64> {
        self.step.as_ref().map(|s| s.target)
    }

    /// Where the last [`step_seek`](Self::step_seek) is (or, with none issued, whether the
    /// source is ready).
    pub fn step_status(&self) -> StepStatus {
        if self.dead {
            return StepStatus::Broken(format!("{}: mpv core shut down", self.path));
        }
        if let Some(e) = &self.load_failed {
            return StepStatus::Broken(e.clone());
        }
        match &self.step {
            None if self.ready => StepStatus::Done,
            None => StepStatus::Pending("ready"),
            Some(s) => match (
                &s.error,
                s.replied,
                s.restarted,
                s.rendered || s.target_frame,
            ) {
                (Some(e), ..) => StepStatus::Broken(e.clone()),
                (None, false, ..) => StepStatus::Pending("seek reply"),
                (None, true, false, _) => StepStatus::Pending("playback restart"),
                (None, true, true, false) => StepStatus::Pending("frame"),
                (None, true, true, true) => StepStatus::Done,
            },
        }
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
        self.loaded_fl = None;
        self.ended_held = false;
        self.restarted = false;
        self.restarted_at = None;
        self.refetched_at = None;
        self.ready = false;
        self.back_valid = false;
        self.ended_sent = false;
        self.time_pos = None;
        self.duration = None;
        self.load_failed = None;
        self.step = None;
        self.disarm_audio_flowing();
        // A load that plays (not paused) starts audio too: arm so a caller holding a ramp
        // on it (a restored source's fade-in, I6) learns when its audio really flows.
        if !matches!(self.props.get("paused"), Some(PropValue::Bool(true))) {
            self.arm_audio_flowing();
        }
        Ok(())
    }

    /// Stop waiting for `AudioFlowing` and stop observing `audio-pts` (M4).
    fn disarm_audio_flowing(&mut self) {
        self.awaiting_flowing = false;
        self.flowing_confirmed_at = None;
        self.flowing_last_pts = None;
        self.flowing_arm_pos = None;
        self.audio_pts_unavailable = false;
        if self.pts_observed {
            self.pts_observed = false;
            if let Some(h) = &self.handle {
                let _ = h.unobserve(OBS_AUDIO_PTS);
            }
        }
    }

    /// R85: arm the wait for [`SourceEvent::AudioFlowing`] — called right after an
    /// un-pause request is queued. Nothing to wait for (fires at once) when: stepped mode
    /// (mpv stays paused for good there — audio is always silent, § Sources "Stepped
    /// mode"), no audio track (`no_audio` asked for `aid=no`), an image (no audio
    /// concept at all), or — R92 — the file itself genuinely has no audio track to begin
    /// with (`self.has_audio == Some(false)`; `None`/unknown still waits, the
    /// conservative default). Otherwise armed — `audio-pts`'s first change starts a
    /// [`FLOWING_CONFIRM_MARGIN`] countdown (`on_prop`) before it fires; the caller (a
    /// recipe/the runtime) bounds the whole wait itself (`ONSET_TIMEOUT`).
    fn arm_audio_flowing(&mut self) {
        let no_audio = matches!(self.props.get("no_audio"), Some(PropValue::Bool(true)));
        let no_track = self.has_audio == Some(false);
        if self.stepped || self.kind != "video" || no_audio || no_track {
            self.pending.push(SourceEvent::AudioFlowing);
            return;
        }
        self.awaiting_flowing = true;
        self.flowing_confirmed_at = None;
        self.flowing_last_pts = None;
        self.flowing_arm_pos = self.time_pos;
        if !self.pts_observed
            && let Some(h) = &self.handle
            && h.observe(OBS_AUDIO_PTS, "audio-pts", Format::F64).is_ok()
        {
            self.pts_observed = true;
            self.audio_pts_unavailable = false; // the fresh observe's first notification says
        }
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
        // Stepped: the virtual clock says when the end is reached (`step_end`) — a paused
        // exact seek to the end never sets mpv's `eof-reached`.
        if self.stepped {
            return;
        }
        if !self.ended_sent && self.kind != "image" {
            self.ended_sent = true;
            if !self.ready {
                // Pushed right after this load's Ready (`update` / `update_worker`): Ready always
                // precedes Ended. The loop renderer reported it first when its first frames were
                // dropped under load (`ended_holds_last_frame` failed once in a loaded full run).
                self.ended_held = true;
            } else {
                self.pending.push(SourceEvent::Ended);
            }
        }
    }

    fn load_error(&mut self, detail: String) {
        let mut reason = format!("{}: {detail}", self.path);
        if let Some(log) = self.last_error_log.take() {
            reason.push_str(&format!(" ({log})"));
        }
        self.load_failed = Some(reason.clone());
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
                    self.pending.push(SourceEvent::Rejected {
                        prop: "gain".into(),
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
            ReqKind::Stop => {
                // Already idle when the stop landed: no file was ever started (events come
                // in order: a START_FILE would precede this reply, so no VO exists), or the
                // last one ended and mpv reported idle after it. Otherwise the stop's own
                // END_FILE + idle notification follow.
                if self.playing_entry.is_none() && (!self.started_any || self.idle_after_end) {
                    self.idle_after_stop = true;
                }
            }
            ReqKind::Step => {
                if let Some(st) = self.step.as_mut()
                    && st.req == id
                {
                    st.replied = true;
                    if error < 0 {
                        st.error = Some(format!("{}: {}", req.what, error_string(error)));
                    }
                }
            }
            ReqKind::Prop { prop, prev } => {
                let newest = self.prop_req.get(&prop) == Some(&id);
                if newest {
                    self.prop_req.remove(&prop);
                }
                if error < 0 {
                    let reason = format!("{}: {}", req.what, error_string(error));
                    if newest {
                        match prev {
                            Some(p) => self.props.insert(prop.clone(), p),
                            None => self.props.remove(&prop),
                        };
                    }
                    self.pending.push(SourceEvent::Rejected { prop, reason });
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
                    self.started_any = true;
                    self.idle_after_end = false;
                    if self.is_current() {
                        self.file_loaded = false;
                        self.loaded_fl = None;
                        self.restarted = false;
                        self.restarted_at = None;
                        self.refetched_at = None;
                        self.time_pos = None;
                        self.duration = None;
                        self.has_audio = None;
                    }
                }
                Event::FileLoaded => {
                    // Counted for every load (the render worker's weak client sees the same
                    // broadcast events in the same order).
                    self.fl_seen += 1;
                    if self.is_current() {
                        self.file_loaded = true;
                        self.loaded_fl = Some(self.fl_seen);
                    }
                }
                Event::PlaybackRestart => {
                    if self.is_current() && self.file_loaded {
                        if !self.restarted {
                            self.restarted_at = Some(Instant::now());
                        }
                        self.restarted = true;
                        let mut settle = false;
                        if let Some(st) = self.step.as_mut()
                            && st.replied
                        {
                            st.restarted = true;
                            settle = st.target_frame && !st.rendered;
                        }
                        if settle {
                            // The target frame came before this restart (`StepSeek::target_frame`),
                            // so the step completes now — before mpv's async `time-pos`
                            // observation of that frame would arrive (a step must return a settled
                            // state: `player_pause_freezes_*` read time_pos across steps). Read it:
                            // stepped mode only, the core is paused and done seeking and its frame
                            // is rendered, so nothing waits on this thread.
                            if let Some(t) = self
                                .handle
                                .as_ref()
                                .and_then(|h| h.get_property_f64("time-pos"))
                            {
                                self.on_prop(OBS_TIME_POS, PropData::F64(t));
                            }
                        }
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
                Event::LogMessage {
                    prefix,
                    text,
                    level,
                    ..
                } => {
                    if std::env::var_os("LP_PLAYER_MPV_LOG").is_some() {
                        // [mpv <file> <t_mono s, when pumped — not when mpv logged it>] <level> <prefix>: <text>
                        eprintln!(
                            "[mpv {} {:.3}] {level} {prefix}: {}",
                            self.path.rsplit('/').next().unwrap_or(""),
                            crate::log::mono_start().map_or(0.0, |t| t.elapsed().as_secs_f64()),
                            text.trim_end()
                        );
                    }
                    if matches!(level.as_str(), "error" | "fatal") {
                        self.last_error_log = Some(format!("{prefix}: {}", text.trim_end()));
                    }
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
        self.confirm_flowing_by_time();
    }

    /// Confirmations that no further `audio-pts` change brings, checked after every pump
    /// (every `update`/`poll_events`, i.e. every tick):
    /// - **the margin is real time**, not "until the next change": once
    ///   [`FLOWING_CONFIRM_MARGIN`] has passed since the first change, confirm — an audio
    ///   stream that stalls right after starting sent no second change;
    /// - **the picture plays on without any audio**: `audio-pts` is unavailable (mpv plays
    ///   no audio — the selected track already ended, e.g. a 30 ms track on a 4 s video)
    ///   while the media position moved [`NO_AUDIO_MEDIA_ADVANCE`] since arming (with
    ///   audio playing, mpv's clock is the audio, so the picture doesn't run ahead of it).
    ///   Nothing will ever be heard, so the ramp may start: there is nothing to cut off.
    ///
    /// Before, only a LATER `audio-pts` change could confirm, so every onset on such a
    /// source waited out `ONSET_TIMEOUT` and logged `transition.onset_timeout` (TODO, the
    /// Task 20 re-run's 85). A core that never plays (no change, position stuck) still
    /// never confirms — the caller's timeout stays the backstop.
    fn confirm_flowing_by_time(&mut self) {
        if !self.awaiting_flowing {
            return;
        }
        let by_margin = self
            .flowing_confirmed_at
            .is_some_and(|t| t.elapsed() >= FLOWING_CONFIRM_MARGIN);
        let no_audio_playing = self.flowing_confirmed_at.is_none()
            && self.audio_pts_unavailable
            && matches!((self.flowing_arm_pos, self.time_pos),
                        (Some(a), Some(t)) if (t - a).abs() >= NO_AUDIO_MEDIA_ADVANCE);
        if by_margin || no_audio_playing {
            self.disarm_audio_flowing();
            self.pending.push(SourceEvent::AudioFlowing);
        }
    }

    fn on_prop(&mut self, id: u64, value: PropData) {
        // Playback-scoped values only once the current load has (re)started — a value
        // delivered after a path change may still describe the previous file.
        let live = self.is_current() && self.restarted;
        match (id, value) {
            (OBS_TIME_POS, PropData::F64(t)) if live => {
                self.time_pos = Some(t);
                if self.awaiting_flowing && self.flowing_arm_pos.is_none() {
                    self.flowing_arm_pos = Some(t);
                }
                // Stepped: `time-pos` only moves on a step's seek — report every change
                // (a wall-clock throttle would make the event stream timing-dependent).
                let due = self.stepped
                    || self
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
            (OBS_EOF, PropData::Flag(false)) if self.is_current() => {
                // Re-armed (a seek back, a loop): an end held back for Ready (worker mode)
                // no longer stands either.
                self.ended_sent = false;
                self.ended_held = false;
            }
            // Stepped: mpv is paused for good; `paused` stays the logical value.
            (OBS_PAUSE, PropData::Flag(p)) if !self.stepped => {
                self.props.insert("paused".into(), PropValue::Bool(p));
            }
            (OBS_IDLE, PropData::Flag(idle)) => {
                if idle && self.playing_entry.is_none() {
                    self.idle_after_end = true;
                }
                // Only an idle reported after the stop's reply counts (events arrive in
                // order, so an older notification is processed before that reply).
                if idle
                    && self.playing_entry.is_none()
                    && let Some((_, req)) = self.teardown
                    && !self.inflight.contains_key(&req)
                {
                    self.idle_after_stop = true;
                }
            }
            (OBS_IMAGE, PropData::Flag(img)) if self.is_current() => {
                self.kind = if img { "image" } else { "video" };
                self.props
                    .insert("kind".into(), PropValue::Str(self.kind.into()));
            }
            // R92: `aid` (the *resolved* audio track selection — "manpage: the special
            // value `no` means no track is selected") always has a real textual value
            // ("auto" pre-resolution, then either a track number or `no`), unlike
            // `current-tracks/audio/id`'s sub-path (tried first: a genuinely audio-less
            // file never generates a change-notification for it at all, since
            // "unavailable" before AND after load is not a value transition — measured
            // directly, `tests/sources.rs::has_audio_reflects_real_track_presence`
            // failed against that approach). `aid` reliably transitions away from
            // "auto" once mpv decides, for every load, including the very first.
            //
            // **Must not conflate with our own `no_audio` request** (which also drives
            // `aid` to `"no"`, § `apply`'s `"no_audio" => self.set(prop, "aid", …)`):
            // while `no_audio` is on, an observed `"no"` here says nothing about the
            // *file's* own content, so it's ignored — `has_audio` keeps whatever it last
            // genuinely knew (or stays `None`/unknown) until `no_audio` is off again and
            // `aid` re-resolves against the real file.
            (OBS_AUDIO_SELECTED, PropData::Str(s)) if self.is_current() => {
                let no_audio = matches!(self.props.get("no_audio"), Some(PropValue::Bool(true)));
                if !no_audio {
                    if s == "no" {
                        self.has_audio = Some(false);
                    } else if !s.is_empty() && s != "auto" {
                        self.has_audio = Some(true);
                    }
                }
            }
            // R85 (review fix round): the *first* change confirms something resumed
            // (decode/demux), but not reliably that the AO itself has yet — record it and
            // only fire once `FLOWING_CONFIRM_MARGIN` has passed *since that change*
            // (`awaiting_flowing`'s doc: real output measured arriving a further 12-20 ms
            // after it). `audio-pts` updates "more often than once per frame", so later
            // changes keep re-checking the margin; if none ever come, the caller's own
            // `ONSET_TIMEOUT` is the real backstop.
            // mpv reports `audio-pts` unavailable while no audio plays (none selected yet,
            // or the audio track already ended while the video goes on)
            (OBS_AUDIO_PTS, PropData::None) if self.awaiting_flowing => {
                self.audio_pts_unavailable = true;
            }
            (OBS_AUDIO_PTS, PropData::F64(v)) if live && self.awaiting_flowing => {
                self.audio_pts_unavailable = false;
                // M4: the first notification after `observe` is its current value, not a
                // change — remember it; only a different value counts.
                let Some(last) = self.flowing_last_pts.replace(v) else {
                    return;
                };
                if last == v {
                    return;
                }
                let confirmed_at = self.flowing_confirmed_at.get_or_insert_with(Instant::now);
                if confirmed_at.elapsed() >= FLOWING_CONFIRM_MARGIN {
                    self.disarm_audio_flowing();
                    self.pending.push(SourceEvent::AudioFlowing);
                }
            }
            _ => {}
        }
    }

    /// Phase 2 (render worker): `update`'s GL half when the render context lives on the
    /// worker — tell it the size, adopt the newest complete frame it handed over (only once
    /// its fence has signalled: else the previous frame stays, re-checked next call), front
    /// vs staging back and Ready promotion exactly as the loop renderer does, and give back
    /// every texture no longer held (a sampled one with a release fence).
    fn update_worker(&mut self, gfx: &Gfx) -> bool {
        let keep = self.gl.clone();
        let cur = keep.make_current();
        if !cur.is_current() {
            return false;
        }
        let Some(att) = self.worker.as_ref() else {
            return false;
        };
        let ex = Arc::clone(&att.ex);
        let (worker, lane) = (Arc::clone(&att.worker), att.lane);
        let gl = &gfx.gl;
        let size = self.target_size();
        let mut wake = false;
        let (frame, error) = {
            let mut st = ex.lock();
            if size != self.w_size {
                st.size = size;
                self.w_size = size;
                wake = true;
            }
            (st.ready.take(), st.error.take())
        };
        if let Some(e) = error {
            self.last_error_log = Some(e);
        }
        let mut give_back: Vec<(Tex, Option<SyncFence>)> = Vec::new();
        let mut sampled_released = false;
        if let Some(f) = frame
            && let Some(old) = self.w_pending.replace(f)
        {
            // Superseded before its fence signalled: never sampled.
            if let Some(fence) = old.fence {
                fence.delete(gl);
            }
            give_back.push((old.tex, None));
        }
        let mut changed = false;
        let signalled = self
            .w_pending
            .as_ref()
            .map(|f| f.fence.as_ref().is_none_or(|fence| fence.signalled(gl)));
        match signalled {
            Some(false) => self.w_adopt_deferred += 1,
            Some(true) => {
                let f = self.w_pending.take().expect("checked above");
                if let Some(fence) = f.fence {
                    fence.delete(gl);
                }
                self.w_adopted += 1;
                if self.ready {
                    if let Some(old) = self.w_front.replace(f.tex) {
                        give_back.push((old, SyncFence::insert(gl)));
                        sampled_released = true;
                    }
                    changed = true;
                } else {
                    // Not ready yet (or a superseded load's leftovers): stage it. Of the
                    // current load iff rendered after its FILE_LOADED (the worker's tag).
                    if let Some(old) = self.w_back.replace(f.tex) {
                        give_back.push((old, None));
                    }
                    self.back_valid = self.is_current()
                        && self.file_loaded
                        && self.loaded_fl == Some(f.file_loaded);
                }
            }
            None => {}
        }
        // Ready = restarted AND a frame of the current load staged, in either order — the
        // same rule as the loop renderer; the back becomes the front in this very call.
        if !self.ready && self.restarted && self.back_valid {
            if let Some(new) = self.w_back.take()
                && let Some(old) = self.w_front.replace(new)
            {
                give_back.push((old, SyncFence::insert(gl)));
                sampled_released = true;
            }
            self.back_valid = false;
            self.ready = true;
            self.pending.push(SourceEvent::Ready);
            if std::mem::take(&mut self.ended_held) {
                self.pending.push(SourceEvent::Ended);
            }
            changed = true;
        }
        if sampled_released {
            // The worker `glWaitSync`s these; another context can only wait on a flushed one.
            unsafe { gl.flush() };
        }
        if !give_back.is_empty() {
            ex.lock().returned.extend(give_back);
            wake = true;
        }
        if wake {
            worker.wake_lane(lane);
        }
        drop(cur);
        changed
    }

    /// `"worker"` (Phase 2 render worker) or `"loop"` — where this source renders (probe).
    pub fn render_mode(&self) -> &'static str {
        if self.worker.is_some() {
            "worker"
        } else {
            "loop"
        }
    }

    /// The `gpu-hwdec-interop` this source's render context loaded (`None`: copy modes) —
    /// probe `hwdec_interop`.
    pub fn hwdec_interop(&self) -> Option<&'static str> {
        self.hwdec_interop
    }

    /// The `sources` probe's per-source `render` object (worker-side timings + adoption
    /// counters; `null` for a loop-rendered source).
    pub fn render_stats(&self) -> Value {
        let Some(att) = &self.worker else {
            return Value::Null;
        };
        let st = att.ex.lock();
        serde_json::json!({
            "renders": st.renders,
            "first_render_ms": st.first_render_ms,
            "max_render_ms": st.max_render_ms,
            "last_render_ms": st.last_render_ms,
            "superseded": st.superseded,
            "adopted": self.w_adopted,
            "adopt_deferred": self.w_adopt_deferred,
        })
    }

    /// `Drop` for a worker-rendered source: no GL here — the core's wakeup callback is
    /// cleared (nothing writes the eventfd after this), then the core and the fence of a frame
    /// still waiting go to the worker, which frees the render context with its own context
    /// current, deletes every texture the slot made (including the ones this source held)
    /// and only then hands the core to the reaper.
    fn drop_worker(&mut self, att: Attached) {
        if let Some(h) = &self.handle {
            unsafe { h.set_wakeup_callback(None, ptr::null_mut()) };
        }
        let fences: Vec<SyncFence> = self
            .w_pending
            .take()
            .and_then(|f| f.fence)
            .into_iter()
            .collect();
        self.w_front = None;
        self.w_back = None;
        let core = self.handle.take();
        if let Err(Some(h)) = att.free(core, fences) {
            // Worker gone (at exit, or it died): leak the render context and the core, silent.
            let _ = h.command_async(0, &["stop"]);
            std::mem::forget(h);
            super::render_worker::note_leaked();
        }
    }

    /// A paused source, an image or a clip at its end, restarted [`REFETCH_AFTER`] ago with no frame staged: mpv gave
    /// up waiting for us to render its only frame and dropped it. Ask for it again — an exact seek
    /// to where it is (same frame, a new `PLAYBACK_RESTART`; no FILE_LOADED, so the worker's frame
    /// tag still matches). A playing source sends its next frame by itself, and re-seeking one that
    /// is merely slow would restart its decode, so it's never touched. Stepped mode seeks itself.
    fn refetch_lost_frame(&mut self) {
        // No next frame will come: an image, a paused source, a clip at its end (keep-open holds it).
        let still = self.kind == "image"
            || self.ended_sent
            || matches!(self.props.get("paused"), Some(PropValue::Bool(true)));
        if self.stepped
            || self.dead
            || self.ready
            || !self.restarted
            || self.back_valid
            || !still
            || !self.is_current()
        {
            return;
        }
        let Some(restarted_at) = self.restarted_at else {
            return;
        };
        let (since, wait) = self.refetched_at.unwrap_or((restarted_at, REFETCH_AFTER));
        if since.elapsed() < wait {
            return;
        }
        let pos = self.time_pos.unwrap_or(0.0).max(0.0);
        let ts = format!("{pos:.6}");
        let Some(h) = self.handle.as_ref() else {
            return;
        };
        // Untracked (id 0): a failure leaves it unready, and the next try or the caller's own
        // timeout (the transition recipe's 10 s) takes it from there.
        if h.command_async(0, &["seek", &ts, "absolute", "exact"])
            .is_err()
        {
            return;
        }
        self.refetches += 1;
        self.refetched_at = Some((Instant::now(), (wait * 2).min(REFETCH_MAX)));
        crate::log::event(
            "mpv",
            crate::log::Level::Info,
            "source.frame_refetched",
            None,
            serde_json::json!({
                "path": self.path,
                "pos": pos,
                "since_restart_ms": restarted_at.elapsed().as_secs_f64() * 1000.0,
                "dsize": [self.dsize.0, self.dsize.1],
            }),
        );
    }

    /// How many times a lost first frame was asked for again ([`REFETCH_AFTER`]).
    pub fn frame_refetches(&self) -> u32 {
        self.refetches
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
    reset_gl(&gfx.gl);
}

/// [`reset_gl_state`] on any context (the render worker's own after each render).
pub(crate) fn reset_gl(gl: &glow::Context) {
    unsafe {
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
        self.refetch_lost_frame();
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
        if self.worker.is_some() {
            return self.update_worker(gfx);
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
            // Stepped: a redraw re-presents the frame shown before (the previous step's), a new
            // frame after the seek's reply is the target (`StepSeek::target_frame`).
            let new_frame =
                self.step.as_ref().is_some_and(|st| st.replied) && !render.next_frame_is_redraw();
            if self.ready {
                match render_into(gfx, render, &mut self.front, size) {
                    Ok(()) => {
                        changed = true;
                        if let Some(st) = self.step.as_mut() {
                            st.rendered |= st.restarted;
                            st.target_frame |= new_frame;
                        }
                    }
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
            if std::mem::take(&mut self.ended_held) {
                self.pending.push(SourceEvent::Ended);
            }
            changed = true;
        }
        drop(cur);
        changed
    }

    fn texture(&self) -> Option<&Tex> {
        self.front
            .as_ref()
            .map(|(t, _)| t)
            .or(self.w_front.as_ref())
    }

    fn size(&self) -> (u32, u32) {
        self.texture().map_or((0, 0), |t| (t.w, t.h))
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
            // Stepped: logical only (mpv stays paused; the runtime seeks each step). A
            // paused -> un-paused edge still arms the R85 flowing-wait — which fires at
            // once (`arm_audio_flowing`'s own `self.stepped` check): there is never real
            // audio to wait for in stepped mode, so a recipe holding an onset ramp on
            // this id must not block on a confirmation that can never arrive.
            "paused" if self.stepped => {
                let was_paused = matches!(&prev, Some(PropValue::Bool(true)));
                if was_paused && !b {
                    self.arm_audio_flowing();
                }
                Ok(())
            }
            "position" if self.stepped => Ok(()),
            "paused" => {
                // R85: arm the real-audio-flowing wait on a genuine paused -> un-paused
                // edge, before the (async, so unconfirmed yet) un-pause request is even
                // sent — `prev` is what `apply` observed last, i.e. the value *before*
                // this call (captured above `self.props.insert`).
                let was_paused = matches!(&prev, Some(PropValue::Bool(true)));
                let r = self.set(prop, "pause", yes_no(b));
                if r.is_ok() && was_paused && !b {
                    self.arm_audio_flowing();
                }
                r
            }
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
            // Copy modes unless this render context loaded a GL interop (on the render
            // worker — `mpv_hwdec`, § Sources "Hardware decoding").
            "hwdec" => self.set(prop, "hwdec", &mpv_hwdec(&s, self.hwdec_interop)),
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
            "af" => self.set(prop, "af", &mpv_af(&s)),
            // `auto` re-inits the AO even after a no-audio start (legacy engine finding).
            "no_audio" => self.set(prop, "aid", if b { "no" } else { "auto" }),
            // The graph value is the user's offset; the bus compensation is added to it.
            "audio_delay" => {
                let d = num(v) + self.audio_delay_bias;
                self.set_f64(prop, "audio-delay", d)
            }
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
            // R92: unknown stays `None` (unmirrored) rather than an explicit `true` — the
            // graph's own schema default (`true`) already is the conservative "treat as
            // audio" fallback invariants #4/#8 need; no point mirroring a value we don't
            // actually know yet.
            "has_audio" => self.has_audio.map(PropValue::Bool),
            _ => self.props.get(prop).cloned(),
        }
    }

    fn poll_events(&mut self) -> Vec<SourceEvent> {
        self.drain_wake();
        self.pump();
        std::mem::take(&mut self.pending)
    }

    /// R51 phase 1: `stop` (async) — the file ends, mpv goes idle and uninitialises its
    /// VO, after which `mpv_render_context_free` no longer waits on the playloop (with the
    /// VO live it blocked the loop 21–32 ms for a playing 1080p clip, measured). The
    /// stream is silent from the stop on.
    fn begin_teardown(&mut self) -> bool {
        if self.dead || self.handle.is_none() {
            return true;
        }
        self.teardown_at = Some(Instant::now());
        self.send_teardown_stop();
        false
    }

    /// R51 phase 2: idle after the stop (or the core is gone, or [`TEARDOWN_MAX`] passed).
    fn teardown_ready(&mut self) -> bool {
        if !self.dead {
            self.drain_wake();
            self.pump();
            if self.teardown.is_none() {
                self.send_teardown_stop();
            }
        }
        self.dead
            || self.idle_after_stop
            || self
                .teardown_at
                .is_none_or(|at| at.elapsed() >= TEARDOWN_MAX)
    }

    fn as_mpv(&self) -> Option<&MpvSource> {
        Some(self)
    }

    fn as_mpv_mut(&mut self) -> Option<&mut MpvSource> {
        Some(self)
    }
}

impl Drop for MpvSource {
    fn drop(&mut self) {
        if let Some(att) = self.worker.take() {
            self.drop_worker(att);
            return;
        }
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
        // 2. The core: clear the wakeup callback (no write to the eventfd once this
        //    returns — mpv calls it under the same lock), then hand the core to the reaper
        //    thread (R51): `mpv_terminate_destroy` takes 30–240 ms (measured) and must never
        //    stall the render loop. 3. The eventfd closes right after (field drop).
        if let Some(h) = &self.handle {
            unsafe { h.set_wakeup_callback(None, ptr::null_mut()) };
        }
        if let Some(h) = self.handle.take() {
            super::reaper::reap(h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SCRIPT_TRIMS, mpv_af, mpv_hwdec, set_optional};
    use crate::mpv::Handle;

    /// TODO "mpv's built-in Lua scripts per core": the trims are best-effort — a name this
    /// libmpv doesn't know (an older mpv lacks some `load-*`) is skipped and reported, the
    /// rest still land and the core still initializes (no GL, no file: a bare core).
    #[test]
    fn unknown_trim_option_never_breaks_a_core() {
        let h = Handle::create().expect("mpv_create");
        let mut opts = SCRIPT_TRIMS.to_vec();
        opts.insert(3, ("load-no-such-script-lp", "no"));
        let skipped = set_optional(&h, &opts);
        assert_eq!(skipped.len(), 1, "{skipped:?}");
        assert!(
            skipped[0].starts_with("load-no-such-script-lp: "),
            "{skipped:?}"
        );
        h.set_option("vo", "null").expect("vo");
        h.set_option("ao", "null").expect("ao");
        h.initialize()
            .expect("mpv_initialize after a skipped option");
        for (name, want) in SCRIPT_TRIMS {
            assert_eq!(
                h.get_property(&format!("options/{name}")).as_deref(),
                Some(want),
                "options/{name}"
            );
        }
    }

    /// Speed storm: mpv's own tempo filter is inserted only while speed ≠ 1 and removed at
    /// exactly 1× — each rebuild of the audio chain cut 3–5 ms of digital silence into the
    /// output (22 holes in 40 s of 0.9↔1.0, none for 0.9↔1.1). A tempo filter in the chain
    /// we hand mpv takes the speed for good; a chain that already has one keeps the user's.
    #[test]
    fn af_always_carries_a_tempo_filter() {
        for (graph, mpv) in [
            ("", "@lp-tempo:scaletempo2"),
            ("  ", "@lp-tempo:scaletempo2"),
            ("lavfi=[anull]", "lavfi=[anull],@lp-tempo:scaletempo2"),
            (
                "lavfi=[loudnorm=I=-16]",
                "lavfi=[loudnorm=I=-16],@lp-tempo:scaletempo2",
            ),
            ("scaletempo2", "scaletempo2"),
            ("scaletempo=stride=30", "scaletempo=stride=30"),
            ("rubberband", "rubberband"),
            (
                "lavfi=[anull],rubberband=pitch=quality",
                "lavfi=[anull],rubberband=pitch=quality",
            ),
        ] {
            assert_eq!(mpv_af(graph), mpv, "af {graph:?}");
        }
    }

    /// Task 20d: never a GL interop mode; `auto` prefers nvdec/vaapi copies over mpv's own
    /// `vulkan-copy`-first list; the user's explicit choices keep their API.
    #[test]
    fn hwdec_maps_to_copy_modes_only() {
        for (graph, mpv) in [
            ("", "no"),
            ("no", "no"),
            (" , ", "no"),
            ("auto", "nvdec-copy,vaapi-copy,auto-copy"),
            ("auto-copy", "nvdec-copy,vaapi-copy,auto-copy"),
            ("auto-safe", "nvdec-copy,vaapi-copy,auto-copy-safe"),
            ("yes", "nvdec-copy,vaapi-copy,auto-copy-safe"),
            ("auto-copy-safe", "nvdec-copy,vaapi-copy,auto-copy-safe"),
            ("nvdec", "nvdec-copy"),
            ("vaapi", "vaapi-copy"),
            ("vulkan", "vulkan-copy"),
            ("cuda", "cuda-copy"),
            ("vdpau", "vdpau-copy"),
            ("v4l2m2m", "v4l2m2m-copy"),
            ("nvdec-copy", "nvdec-copy"),
            ("vulkan-copy", "vulkan-copy"),
            ("auto-unsafe", "nvdec-copy,vaapi-copy,auto-copy-unsafe"),
            ("auto-copy-unsafe", "nvdec-copy,vaapi-copy,auto-copy-unsafe"),
            ("amf", "amf-copy"),
            ("drm", "drm"),
            ("not_a_decoder", "not_a_decoder"),
            ("vaapi, nvdec-copy", "vaapi-copy,nvdec-copy"),
            ("vaapi,auto", "vaapi-copy,nvdec-copy,auto-copy"),
            ("nvdec,nvdec-copy", "nvdec-copy"),
        ] {
            assert_eq!(mpv_hwdec(graph, None), mpv, "hwdec {graph:?}");
            // A render context without a usable interop maps like none at all.
            assert_eq!(mpv_hwdec(graph, Some("no")), mpv, "hwdec {graph:?}");
        }
        // No value mpv 0.41 accepts may come out as an interop (non-copy) decoder.
        const INTEROP: [&str; 10] = [
            "auto",
            "auto-safe",
            "auto-unsafe",
            "yes",
            "nvdec",
            "cuda",
            "vaapi",
            "vdpau",
            "vulkan",
            "amf",
        ];
        for v in INTEROP
            .iter()
            .chain(&["v4l2m2m", "auto-copy", "nvdec,vaapi,vulkan"])
        {
            let m = mpv_hwdec(v, None);
            assert!(
                m.split(',')
                    .all(|e| !INTEROP.contains(&e) && e != "v4l2m2m"),
                "hwdec {v:?} → {m:?} keeps an interop decoder"
            );
        }
    }

    /// On the render worker with a loaded interop: the decoders it can show are asked for
    /// zero-copy, each followed by its copy twin (an interop that failed to load or a codec
    /// the GPU can't do falls back to the copy, never to software); `auto-copy*` stays copy;
    /// a decoder with no GL interop on our renderer (vulkan, vdpau, amf) or one another
    /// interop serves stays copy.
    #[test]
    fn hwdec_maps_to_the_loaded_interop_on_the_worker() {
        for (interop, graph, mpv) in [
            ("cuda", "", "no"),
            ("cuda", "no", "no"),
            ("cuda", "auto", "nvdec,nvdec-copy,vaapi-copy,auto-copy"),
            ("cuda", "yes", "nvdec,nvdec-copy,vaapi-copy,auto-copy-safe"),
            (
                "cuda",
                "auto-safe",
                "nvdec,nvdec-copy,vaapi-copy,auto-copy-safe",
            ),
            (
                "cuda",
                "auto-unsafe",
                "nvdec,nvdec-copy,vaapi-copy,auto-copy-unsafe",
            ),
            ("cuda", "auto-copy", "nvdec-copy,vaapi-copy,auto-copy"),
            (
                "cuda",
                "auto-copy-safe",
                "nvdec-copy,vaapi-copy,auto-copy-safe",
            ),
            ("cuda", "nvdec", "nvdec,nvdec-copy"),
            ("cuda", "cuda", "cuda,cuda-copy"),
            ("cuda", "nvdec-copy", "nvdec-copy"),
            ("cuda", "vaapi", "vaapi-copy"),
            ("cuda", "vulkan", "vulkan-copy"),
            ("cuda", "vdpau", "vdpau-copy"),
            ("cuda", "amf", "amf-copy"),
            ("cuda", "v4l2m2m", "v4l2m2m-copy"),
            ("cuda", "not_a_decoder", "not_a_decoder"),
            ("cuda", "vaapi,nvdec", "vaapi-copy,nvdec,nvdec-copy"),
            (
                "cuda",
                "nvdec,auto",
                "nvdec,nvdec-copy,vaapi-copy,auto-copy",
            ),
            ("vaapi", "auto", "vaapi,nvdec-copy,vaapi-copy,auto-copy"),
            ("vaapi", "vaapi", "vaapi,vaapi-copy"),
            ("vaapi", "nvdec", "nvdec-copy"),
            ("drmprime", "v4l2m2m", "v4l2m2m,v4l2m2m-copy"),
            (
                "drmprime",
                "auto",
                "v4l2m2m,nvdec-copy,vaapi-copy,auto-copy",
            ),
            (
                "all",
                "auto",
                "nvdec,vaapi,v4l2m2m,nvdec-copy,vaapi-copy,auto-copy",
            ),
        ] {
            assert_eq!(
                mpv_hwdec(graph, Some(interop)),
                mpv,
                "hwdec {graph:?} with interop {interop}"
            );
        }
        // Every zero-copy decoder asked for is followed by its copy twin.
        for interop in ["cuda", "vaapi", "drmprime", "all"] {
            for v in ["auto", "yes", "nvdec", "cuda", "vaapi", "v4l2m2m", "vulkan"] {
                let m = mpv_hwdec(v, Some(interop));
                let list: Vec<&str> = m.split(',').collect();
                for (i, e) in list.iter().enumerate() {
                    if ["nvdec", "cuda", "vaapi", "v4l2m2m"].contains(e) {
                        assert!(
                            list[i..].contains(&format!("{e}-copy").as_str())
                                || list[i..].iter().any(|x| x.starts_with("auto-copy")),
                            "{v:?} with {interop}: {m:?} has no copy fallback for {e}"
                        );
                    }
                    assert_ne!(*e, "vulkan", "{v:?} with {interop}: {m:?}");
                }
            }
        }
    }
}
