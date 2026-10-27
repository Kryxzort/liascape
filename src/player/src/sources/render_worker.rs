//! Phase 2 render worker (`.claude/rules/player-core.md` § Sources "Render worker"): one
//! `lp-render` thread with its own EGL context in the compositor's share group owns every
//! worker-mode `MpvSource`'s libmpv render context — its creation, its first render (shader
//! compile, scaler LUTs, FBO setup: 6–20 ms on the loop before) and every later render into
//! textures the loop adopts once complete — so the loop only composes finished textures.
//!
//! The loop keeps everything else of the source (the core's event pump, the async applies,
//! `read`, load fencing, Ready, the front/back it shows). The two sides meet in one
//! [`Exchange`] per source — a mutex never held across an mpv call (mpv invokes the render
//! update callback with its own locks held; the callback only writes this worker's eventfd).
//!
//! **Texture ownership** is what keeps a frame from tearing: a texture is the worker's (its
//! free list, the one it renders into) or the loop's (front, back, a frame waiting for its
//! fence) — never both. The worker renders only into its own, inserts a fence + `glFlush`,
//! polls that fence (`glClientWaitSync(…, 0)`, every [`FENCE_POLL`] while a frame is on the
//! GPU), then publishes the frame (`Exchange::ready`, replacing — and taking back — an older one the loop
//! never adopted) and writes the source's eventfd (a `dup`, so a dropped source can never leave
//! it writing a reused fd number). The loop gives textures back through [`ExState::returned`],
//! with a **release fence** when it sampled them (a replaced front): the worker renders into a
//! returned texture only once that fence has signalled (polled too). No blocking GL wait
//! anywhere — `glWaitSync`/a blocking `glClientWaitSync` across contexts holds NVIDIA's
//! process-wide driver lock for the GPU work's duration (measured: renders on the other thread
//! stalled for seconds under parallel tests).

use std::collections::{BTreeMap, HashMap};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use glow::HasContext;
use serde_json::{Value, json};

use super::mpv::{get_proc_address, on_wake, reset_gl};
use super::reaper;
use crate::gfx::gl::{new_fbo, new_tex};
use crate::gfx::{Fbo, Gfx, SharedContext, Tex};
use crate::log::{self, Level};
use crate::mpv::{Handle, RenderContext, WeakClient};

/// How long the worker waits on its own fence before publishing anyway (the loop then holds
/// the frame until `glClientWaitSync(…, 0)` says it signalled). A render that isn't done in
/// this time is broken anyway; never seen.
const FENCE_WAIT: Duration = Duration::from_millis(100);

/// How often a frame still on the GPU is re-checked (`glClientWaitSync(…, 0)`). Each check
/// past the frame's completion is latency the loop sees. Measured (release, hermetic, a
/// 1080p120 clip at 2× on a content-paced 240 Hz output, 4 runs per cell, interleaved;
/// `missed` = present intervals > 1.5 refresh periods): 1 ms → median 3.3 / 3.2 / 5.0
/// missed/s (steady 2× / 2× ± 0.05 / random 1.6–2.4×), the loop renderer 2.2 / 3.3 / 3.2,
/// **250 µs → 1.8 / 2.0 / 2.5**; worker CPU the same either way (1080p30 4.3–5.3 %, 4K60
/// 24–27 % of a core in both).
const FENCE_POLL: Duration = Duration::from_micros(250);

/// The worker's poll backstop with nothing on the GPU (jobs, sizes and every render
/// context's update callback write its eventfd).
const IDLE_POLL: Duration = Duration::from_millis(100);

/// Free textures a slot keeps around for reuse beyond the ones in flight (3 in steady state:
/// the loop's front, the newest frame, one to render into).
const FREE_KEEP: usize = 2;

/// How long an `lp-open` job waits for the worker to make a render context. The core travels
/// with the request: a job that gives up fails its source (`source.error`) and the lane frees
/// what it made and reaps the core itself. 10 s = the transition's own wait for B's first frame
/// (`recipes::transition`): waiting longer can't help a switch. The hwdec interop's init runs in
/// this wait (a CUDA context, 40–70 ms; a heavily loaded machine once took > 3 s — the old bound
/// — for the process's first, which `warm_cuda` now takes at startup).
const ATTACH_WAIT: Duration = Duration::from_secs(10);

/// An attach or free at least this slow is logged at info (`render_worker.attach` /
/// `.free {lane, ms}`), else at debug.
const SLOW_JOB_MS: f64 = 100.0;

/// Test-only fault injection, `LP_PLAYER_TEST_RENDER_WORKER_FAULT` (comma-separated, read once):
/// - `slow-flush` — sleep [`SLOW_FLUSH`] between a render pass and its `glFlush`, so every frame
///   stays unsubmitted that long (a slow GPU submission; the fences must keep it out of sight);
/// - `no-fence` — publish each frame right after its render, before the flush and without a
///   fence (what the sync objects exist to prevent). Measured: NO visible effect on NVIDIA 595
///   even with `slow-flush` — the driver serializes access to a shared texture across the share
///   group itself (the same process-wide lock § Sources "Render worker" works around), so the
///   loop never read a texture with the worker's commands for it still unsubmitted. The fences
///   stay: the GL spec (and Mesa) only guarantee another context's changes once they completed;
/// - `publish-early` — hand the loop each target BEFORE rendering into it ([`SLOW_FLUSH`] later):
///   the texture-ownership rule broken (a texture is the worker's until its frame is finished);
/// - `no-context` — the thread reports a failed start right after its context was made (what a
///   driver refusing the shared context looks like): `serve` must fall back to the loop
///   (`tests/api.rs::render_worker_unavailable_falls_back_to_the_loop`);
/// - `panic` — panic at the first render (a bug or an allocation `expect` on `lp-render`): the
///   player must fail like a lost compositor, not freeze (`tests/api.rs::
///   render_worker_death_fails_the_player`).
///
/// The torn-frame guard (`tests/api.rs::render_worker_never_composes_a_torn_frame`) is GREEN
/// as is and with `slow-flush`, RED with `publish-early`.
#[derive(Clone, Copy, Default)]
struct Faults {
    slow_flush: bool,
    no_fence: bool,
    publish_early: bool,
    no_context: bool,
    panic: bool,
}

/// [`Faults`]' `slow-flush` / `publish-early` delay.
const SLOW_FLUSH: Duration = Duration::from_millis(30);

fn faults() -> Faults {
    static F: std::sync::OnceLock<Faults> = std::sync::OnceLock::new();
    *F.get_or_init(|| {
        let v = std::env::var("LP_PLAYER_TEST_RENDER_WORKER_FAULT").unwrap_or_default();
        let has = |k: &str| v.split(',').any(|p| p.trim() == k);
        let f = Faults {
            slow_flush: has("slow-flush"),
            no_fence: has("no-fence"),
            publish_early: has("publish-early"),
            no_context: has("no-context"),
            panic: has("panic"),
        };
        if f.slow_flush || f.no_fence || f.publish_early || f.no_context || f.panic {
            log::event(
                "render",
                Level::Warn,
                "render_worker.test_fault",
                None,
                json!({ "slow_flush": f.slow_flush, "no_fence": f.no_fence,
                        "publish_early": f.publish_early, "no_context": f.no_context,
                        "panic": f.panic }),
            );
        }
        f
    })
}

/// The env knob for zero-copy hardware decoding on the worker (§ Sources "Hardware decoding"):
/// unset/`on` = the GPU's own interop ([`hwdec_interop_for`]), `off` = copy modes only (the
/// Task 20d behaviour — the A/B and escape hatch), or an mpv `gpu-hwdec-interop` name
/// (`cuda`, `vaapi`, `drmprime`, `all`) to force one.
pub const HWDEC_INTEROP_ENV: &str = "LP_PLAYER_HWDEC_INTEROP";

/// Which mpv `gpu-hwdec-interop` a render context made on the worker loads, from the worker
/// context's `GL_VENDOR` and [`HWDEC_INTEROP_ENV`]: NVIDIA → `cuda` (nvdec straight into GL
/// textures), AMD/Intel → `vaapi` (dmabuf import); anything else (llvmpipe, nouveau, …) →
/// `None`. Never mpv's `auto`: for the render API that loads EVERY interop at
/// `mpv_render_context_create` — on NVIDIA also `vaapi` through nvidia-vaapi-driver, a second
/// CUDA context per source. One interop is loaded eagerly per render context either way (mpv
/// has no on-demand loading for libmpv), so the caller skips it for a source that won't use
/// it (`hwdec` no, an image).
pub fn hwdec_interop_for(gl_vendor: &str, env: Option<&str>) -> Option<&'static str> {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("off" | "no" | "0" | "false") => return None,
        Some("cuda") => return Some("cuda"),
        Some("vaapi") => return Some("vaapi"),
        Some("drmprime") => return Some("drmprime"),
        Some("all") => return Some("all"),
        Some("" | "on" | "1" | "true" | "yes") | None => {}
        Some(other) => eprintln!(
            "lp-player: {HWDEC_INTEROP_ENV}={other:?} ignored (expected on|off|cuda|vaapi|drmprime|all)"
        ),
    }
    let v = gl_vendor.to_ascii_lowercase();
    if v.contains("nvidia") {
        Some("cuda")
    } else if v.contains("amd") || v.contains("ati ") || v.contains("intel") {
        Some("vaapi")
    } else {
        None
    }
}

/// `dlopen` libcuda for the CUDA interop (never closed): by soname, else from the NixOS driver
/// dir. `Some(where)` once loaded, `None` = no libcuda (no CUDA interop then).
fn preload_libcuda() -> Option<(&'static str, LibHandle)> {
    const TRY: [(&str, &std::ffi::CStr); 2] = [
        ("libcuda.so.1", c"libcuda.so.1"),
        (
            "/run/opengl-driver/lib/libcuda.so.1",
            c"/run/opengl-driver/lib/libcuda.so.1",
        ),
    ];
    TRY.iter().find_map(|(name, c)| {
        let h = unsafe { libc::dlopen(c.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        (!h.is_null()).then_some((*name, LibHandle(h)))
    })
}

/// A `dlopen` handle (never closed).
#[derive(Clone, Copy, PartialEq)]
struct LibHandle(*mut libc::c_void);

/// `cuInit(0)` through the preloaded libcuda — the process's first CUDA initialisation, done on
/// lane 0 right after it started (the loop doesn't wait for it), so the first render context
/// with the CUDA interop doesn't pay the driver's initialisation on top of its own (measured
/// here: `cuInit` 20–32 ms; an interop attach itself 85–220 ms). Returns (cuInit's result, ms); `None` without the symbol.
fn warm_cuda(lib: LibHandle) -> Option<(i32, f64)> {
    let f = unsafe { libc::dlsym(lib.0, c"cuInit".as_ptr()) };
    if f.is_null() {
        return None;
    }
    // SAFETY: `CUresult cuInit(unsigned int Flags)` (cuda.h), callable from any thread.
    let cu_init: unsafe extern "C" fn(u32) -> i32 = unsafe { std::mem::transmute(f) };
    let t = Instant::now();
    let rc = unsafe { cu_init(0) };
    Some((rc, t.elapsed().as_secs_f64() * 1000.0))
}

/// A GL sync object handed between the two contexts (sync objects are shared across a share
/// group). Held as its pointer value: `GLsync` is a raw pointer, not `Send`.
#[derive(Debug)]
pub(crate) struct SyncFence(usize);

impl SyncFence {
    /// `glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE)` on `gl`'s context (the caller flushes).
    pub(crate) fn insert(gl: &glow::Context) -> Option<SyncFence> {
        unsafe { gl.fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0) }
            .ok()
            .map(|f| SyncFence(f.0 as usize))
    }

    fn raw(&self) -> glow::NativeFence {
        glow::NativeFence(self.0 as *mut _)
    }

    /// Non-blocking: has it signalled? (`glClientWaitSync(…, 0, 0)`; a failed wait — an
    /// invalid sync — counts as signalled, never as a frame held forever.)
    pub(crate) fn signalled(&self, gl: &glow::Context) -> bool {
        let r = unsafe { gl.client_wait_sync(self.raw(), 0, 0) };
        r != glow::TIMEOUT_EXPIRED
    }

    pub(crate) fn delete(self, gl: &glow::Context) {
        unsafe { gl.delete_sync(self.raw()) };
    }
}

/// One complete frame on its way to the loop.
pub(crate) struct Frame {
    pub tex: Tex,
    /// Signalled once the render finished on the GPU (the worker already waited for it; the
    /// loop re-checks without blocking).
    pub fence: Option<SyncFence>,
    /// FILE_LOADED events mpv had emitted when this render started (§ "Load fencing").
    pub file_loaded: u64,
}

/// What the loop and the worker share for one source.
#[derive(Default)]
pub(crate) struct ExState {
    /// Loop → worker: the size to render at (`MpvSource::target_size`).
    pub size: Option<(u32, u32)>,
    /// Loop → worker: textures given back, with a release fence when the loop sampled them.
    pub returned: Vec<(Tex, Option<SyncFence>)>,
    /// Worker → loop: the newest complete frame not adopted yet.
    pub ready: Option<Frame>,
    /// Worker → loop: the last render failure (mpv's error), for `last_error_log`.
    pub error: Option<String>,
    // Probe counters (worker-side).
    pub renders: u64,
    pub first_render_ms: Option<f64>,
    pub max_render_ms: f64,
    pub last_render_ms: f64,
    /// Frames replaced by a newer one before the loop adopted them.
    pub superseded: u64,
}

pub(crate) struct Exchange {
    m: Mutex<ExState>,
}

impl Exchange {
    pub(crate) fn lock(&self) -> MutexGuard<'_, ExState> {
        self.m.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A core whose render context lives on the worker (`PreparedCore`/`MpvSource`) — on one of
/// its lanes, for good (a render context is bound to the GL context it was created on).
pub(crate) struct Attached {
    pub id: u64,
    pub lane: usize,
    pub ex: Arc<Exchange>,
    pub worker: Arc<RenderWorker>,
}

impl Attached {
    /// Free this slot, then reap `core`, on its lane. `Err` = the lane is gone (the caller
    /// leaks the core rather than freeing a render context without its context).
    pub(crate) fn free(
        &self,
        core: Option<Handle>,
        fences: Vec<SyncFence>,
    ) -> Result<(), Option<Handle>> {
        let lane = &self.worker.lanes[self.lane];
        let _ = lane
            .live
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            });
        match lane.send(Job::Free {
            id: self.id,
            core: core.map(SendHandle),
            fences,
        }) {
            Ok(()) => Ok(()),
            Err(Job::Free { core, .. }) => Err(core.map(|c| c.0)),
            Err(_) => Err(None),
        }
    }
}

/// An mpv core moved between threads. SAFETY: libmpv's client API is thread-safe
/// (`client.h`); whoever holds this is the only user of the handle.
struct SendHandle(Handle);
unsafe impl Send for SendHandle {}

/// The worker's answer to an attach: the core back, and the slot id + exchange (or why not).
type AttachReply = (SendHandle, Result<(u64, Arc<Exchange>), String>);

enum Job {
    /// Make a render context (+ weak client) for `core`; reply with the core back.
    Attach {
        core: SendHandle,
        loop_wake: OwnedFd,
        reply: SyncSender<AttachReply>,
    },
    /// Free slot `id` (render context with this context current, weak client, every texture),
    /// delete `fences`, then hand `core` to the reaper.
    Free {
        id: u64,
        core: Option<SendHandle>,
        fences: Vec<SyncFence>,
    },
}

#[derive(Default)]
struct Stats {
    slots: usize,
    attaches: u64,
    attach_ms_max: f64,
    renders: u64,
    render_ms_max: f64,
    first_render_ms_max: f64,
    frees: u64,
    free_ms_max: f64,
    fence_wait_ms_max: f64,
    fence_timeouts: u64,
    passes: u64,
}

struct State {
    jobs: std::collections::VecDeque<Job>,
    closing: bool,
    /// The thread is gone: nothing more is accepted.
    exited: bool,
    /// The thread panicked (why): see [`RenderWorker::died`].
    died: Option<String>,
    stats: Stats,
}

/// Cores leaked because the worker was gone when their render context had to be freed
/// ([`note_leaked`]): never destroyed (that would need a render context freed with its GL
/// context current first). Counted as stragglers at quit, so the process `_exit`s instead of
/// running libmpv's static destructors under them.
static LEAKED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A core whose render context lived on a worker that is gone was leaked (stopped, silent).
pub(crate) fn note_leaked() {
    LEAKED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// What one lane's thread and every [`RenderWorker`] handle share.
struct Inner {
    state: Mutex<State>,
    /// Woken by jobs, by the loop (size changes, textures given back) and by every render
    /// context's update callback (`on_wake`, the fd number is the callback context). Never
    /// closed (`into_raw_fd`): a render context leaked at a timed-out shutdown may still write it.
    fd: RawFd,
    done: Mutex<Option<(mpsc::Receiver<()>, JoinHandle<()>)>>,
    /// Slots handed to this lane and not freed yet, counted by the callers (an attach on its
    /// way counts already): what [`RenderWorker::attach`] balances on.
    live: AtomicUsize,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wake(&self) {
        let one: u64 = 1;
        unsafe { libc::write(self.fd, &one as *const u64 as *const libc::c_void, 8) };
    }

    fn send(&self, job: Job) -> Result<(), Job> {
        {
            let mut s = self.lock();
            if s.exited {
                return Err(job);
            }
            s.jobs.push_back(job);
        }
        self.wake();
        Ok(())
    }
}

/// How many lanes (`lp-render` threads, one EGL context each) the worker runs, unless
/// [`RENDER_LANES_ENV`] says otherwise (1–[`MAX_LANES`]). A render context is created on — and
/// for good bound to — one lane, and its creation blocks that lane: with the hwdec GL interop
/// that is the interop's init (the CUDA context: 85–220 ms per attach measured) — on ONE thread, the playing wallpaper froze for it at every switch (measured: its
/// longest frame interval 34 → 66–74 ms at 30 fps, i.e. 1–2 frames lost right before each
/// transition). A new source goes to the lane with the fewest live sources, so B's attach (and
/// later A's free — `mpv_render_context_free` destroys the CUDA context too) runs beside A,
/// never in front of it. Two lanes cover one wallpaper on every output (A on one, B on the
/// other, ping-pong); a third covers a switch while the previous one's A is still fading out
/// (a rapid switch) or a second wallpaper on another output. Only with the interop: without it
/// an attach costs < 1 ms and the worker runs one lane. Each lane costs a thread, ~4.5 MiB RSS
/// (its context) and 50–110 ms more at startup (its first `eglMakeCurrent`).
pub const RENDER_LANES: usize = 3;

/// [`RENDER_LANES`]' upper bound.
pub const MAX_LANES: usize = 6;

/// The env knob for the lane count (`1`–[`MAX_LANES`]; measurement and troubleshooting).
pub const RENDER_LANES_ENV: &str = "LP_PLAYER_RENDER_LANES";

fn lanes_wanted() -> usize {
    match std::env::var(RENDER_LANES_ENV) {
        Ok(v) if !v.trim().is_empty() => match v.trim().parse::<usize>() {
            Ok(n) if (1..=MAX_LANES).contains(&n) => n,
            _ => {
                eprintln!("lp-player: {RENDER_LANES_ENV}={v:?} ignored (expected 1–{MAX_LANES})");
                RENDER_LANES
            }
        },
        _ => RENDER_LANES,
    }
}

/// The render worker (one per player): handles on its `lp-render` lanes. Every source it
/// renders holds one (`Attached`), so the threads outlive them all; when the last handle goes
/// (the runtime's and every source's) each lane finishes its queued frees and exits by itself
/// — [`RenderWorker::shutdown`] is the bounded wait for that at `quit`.
pub struct RenderWorker {
    lanes: Vec<Arc<Inner>>,
    /// The mpv `gpu-hwdec-interop` this worker's render contexts load (zero-copy hardware
    /// decoding), or `None` (copy modes only) — [`hwdec_interop_for`], decided on the first
    /// lane's own context at start.
    interop: Option<&'static str>,
}

impl Drop for RenderWorker {
    /// The last handle: every lane finishes its queued frees, destroys its context and exits
    /// — waited for here (bounded), so no `lp-render` thread is still inside the driver when
    /// the process exits (NVIDIA's atexit teardown under a live GL thread crashed a test
    /// binary at exit). In the player this is after [`RenderWorker::shutdown`] (a no-op then).
    fn drop(&mut self) {
        self.shutdown(SHUTDOWN_WAIT);
    }
}

/// [`RenderWorker`]'s `Drop` waits this long for its threads.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

impl RenderWorker {
    /// Start the worker: one lane, and with a hwdec interop [`RENDER_LANES`], each on its own
    /// context shared with `gfx`'s (`Gfx::share_context`). The first lane failing is the worker
    /// failing; a later one only leaves fewer lanes (logged).
    pub fn start(gfx: &Gfx) -> Result<Arc<RenderWorker>, String> {
        let (first, interop) = spawn_lane(gfx, 0)?;
        // Without the interop an attach costs well under a millisecond (no init to hide):
        // one lane, as before.
        let want = if interop.is_some() { lanes_wanted() } else { 1 };
        let mut lanes = vec![first];
        for i in 1..want {
            match spawn_lane(gfx, i) {
                Ok((lane, _)) => lanes.push(lane),
                Err(e) => {
                    log::event(
                        "render",
                        Level::Warn,
                        "render_worker.lane_failed",
                        None,
                        json!({ "lane": i, "reason": e }),
                    );
                    break;
                }
            }
        }
        Ok(Arc::new(RenderWorker { lanes, interop }))
    }

    /// The `gpu-hwdec-interop` a render context made on this worker loads (`None`: none —
    /// hardware decoding in copy modes). See [`hwdec_interop_for`].
    pub fn hwdec_interop(&self) -> Option<&'static str> {
        self.interop
    }

    /// Wake lane `lane` (a source's new size, textures given back).
    pub(crate) fn wake_lane(&self, lane: usize) {
        if let Some(l) = self.lanes.get(lane) {
            l.wake();
        }
    }

    /// Give `core`'s rendering to the worker: the lane with the fewest live sources (ties: the
    /// first) creates the render context (its context current, update callback on its
    /// eventfd) and a weak FILE_LOADED client. Called on an `lp-open` thread (it waits).
    /// `Err(core)` = the worker can't (gone, failed — logged); the caller renders on the loop
    /// instead. `Err(None)`: the wait timed out and the core stays with the lane, which frees
    /// what it made and reaps it.
    pub(crate) fn attach(
        self: &Arc<Self>,
        core: Handle,
        loop_wake: RawFd,
    ) -> Result<(Handle, Attached), Option<Handle>> {
        let Some(lane) = (0..self.lanes.len())
            .filter(|&i| !self.lanes[i].lock().exited)
            .min_by_key(|&i| (self.lanes[i].live.load(Ordering::SeqCst), i))
        else {
            return Err(Some(core));
        };
        let inner = &self.lanes[lane];
        let dup = unsafe { libc::fcntl(loop_wake, libc::F_DUPFD_CLOEXEC, 0) };
        if dup < 0 {
            return Err(Some(core));
        }
        let loop_wake = unsafe { OwnedFd::from_raw_fd(dup) };
        let (reply, rx) = mpsc::sync_channel(1);
        inner.live.fetch_add(1, Ordering::SeqCst);
        let undo = || {
            let _ = inner
                .live
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                    Some(n.saturating_sub(1))
                });
        };
        if let Err(Job::Attach { core, .. }) = inner.send(Job::Attach {
            core: SendHandle(core),
            loop_wake,
            reply,
        }) {
            undo();
            return Err(Some(core.0));
        }
        match rx.recv_timeout(ATTACH_WAIT) {
            // The core comes back with the reply: the caller owns it again.
            Ok((core, Ok((id, ex)))) => Ok((
                core.0,
                Attached {
                    id,
                    lane,
                    ex,
                    worker: Arc::clone(self),
                },
            )),
            Ok((core, Err(e))) => {
                undo();
                log::event(
                    "render",
                    Level::Warn,
                    "render_worker.attach_failed",
                    None,
                    json!({ "reason": e, "lane": lane }),
                );
                Err(Some(core.0))
            }
            Err(_) => {
                // The lane frees what it made and reaps the core when its reply fails.
                undo();
                log::event(
                    "render",
                    Level::Warn,
                    "render_worker.attach_failed",
                    None,
                    json!({ "reason": "timed out", "lane": lane,
                            "waited_ms": ATTACH_WAIT.as_millis() as u64 }),
                );
                Err(None)
            }
        }
    }

    /// Why an `lp-render` lane died (it panicked), if one did — the runtime then fails like
    /// a lost compositor (§ Sources "Render worker" → "Failure").
    pub fn died(&self) -> Option<String> {
        self.lanes.iter().find_map(|l| l.lock().died.clone())
    }

    /// Stop: every lane finishes its queued jobs (frees) and exits once no slot is left; wait
    /// up to `timeout` for all of them. Returns the slots still alive (render contexts not
    /// freed) plus the cores leaked because a lane was gone ([`note_leaked`]) — stragglers
    /// either way.
    pub fn shutdown(&self, timeout: Duration) -> usize {
        for l in &self.lanes {
            l.lock().closing = true;
            l.wake();
        }
        let deadline = Instant::now() + timeout;
        for l in &self.lanes {
            let done = l.done.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some((rx, thread)) = done
                && rx
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .is_ok()
            {
                let _ = thread.join();
            }
        }
        self.lanes
            .iter()
            .map(|l| l.lock().stats.slots)
            .sum::<usize>()
            + LEAKED.load(Ordering::SeqCst)
    }

    /// The `sources` probe's `render_worker`: the lanes summed (counts) / maxed (timings), and
    /// each lane's own.
    pub fn stats(&self) -> Value {
        let mut sum = Stats::default();
        let (mut queued, mut closing, mut exited, mut died) = (0usize, false, true, None);
        let mut per = Vec::new();
        for l in &self.lanes {
            let s = l.lock();
            let st = &s.stats;
            sum.slots += st.slots;
            sum.attaches += st.attaches;
            sum.attach_ms_max = sum.attach_ms_max.max(st.attach_ms_max);
            sum.renders += st.renders;
            sum.render_ms_max = sum.render_ms_max.max(st.render_ms_max);
            sum.first_render_ms_max = sum.first_render_ms_max.max(st.first_render_ms_max);
            sum.frees += st.frees;
            sum.free_ms_max = sum.free_ms_max.max(st.free_ms_max);
            sum.fence_wait_ms_max = sum.fence_wait_ms_max.max(st.fence_wait_ms_max);
            sum.fence_timeouts += st.fence_timeouts;
            sum.passes += st.passes;
            queued += s.jobs.len();
            closing |= s.closing;
            exited &= s.exited;
            if died.is_none() {
                died = s.died.clone();
            }
            per.push(json!({
                "slots": st.slots,
                "live": l.live.load(Ordering::SeqCst),
                "attaches": st.attaches,
                "attach_ms_max": st.attach_ms_max,
                "renders": st.renders,
                "frees": st.frees,
                "free_ms_max": st.free_ms_max,
                "exited": s.exited,
            }));
        }
        json!({
            "slots": sum.slots,
            "queued_jobs": queued,
            "attaches": sum.attaches,
            "attach_ms_max": sum.attach_ms_max,
            "renders": sum.renders,
            "render_ms_max": sum.render_ms_max,
            "first_render_ms_max": sum.first_render_ms_max,
            "frees": sum.frees,
            "free_ms_max": sum.free_ms_max,
            "fence_wait_ms_max": sum.fence_wait_ms_max,
            "fence_timeouts": sum.fence_timeouts,
            "passes": sum.passes,
            "closing": closing,
            "exited": exited,
            "died": died,
            "leaked": LEAKED.load(Ordering::SeqCst),
            "hwdec_interop": self.interop,
            "lanes": per,
        })
    }
}

/// Start one lane: its shared context, eventfd and `lp-render` thread; returns once the thread
/// made the context current (with the hwdec interop it picked on it).
fn spawn_lane(gfx: &Gfx, lane: usize) -> Result<(Arc<Inner>, Option<&'static str>), String> {
    let ctx = gfx.share_context()?;
    let raw = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
    if raw < 0 {
        return Err(format!("eventfd: {}", std::io::Error::last_os_error()));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) }.into_raw_fd();
    // Before any render context exists (nothing else can be writing it): closed again if
    // the lane never starts.
    let close_fd = || unsafe {
        libc::close(fd);
    };
    let inner = Arc::new(Inner {
        state: Mutex::new(State {
            jobs: Default::default(),
            closing: false,
            exited: false,
            died: None,
            stats: Stats::default(),
        }),
        fd,
        done: Mutex::new(None),
        live: AtomicUsize::new(0),
    });
    let (tx, rx) = mpsc::channel();
    let (ok_tx, ok_rx) = mpsc::channel::<Result<Option<&'static str>, String>>();
    let me = Arc::clone(&inner);
    let thread = std::thread::Builder::new()
        .name("lp-render".into())
        .spawn(move || {
            // A panic here must never leave a silent, frozen lane behind: the slots' render
            // contexts are dropped by the unwind (this context still current), the lane is
            // marked gone (every later attach/free is refused — new sources go to another lane
            // or render on the loop, freed cores are leaked silent) and `died` makes the
            // runtime fail like a lost compositor (exit 3, restarted with `--restore`).
            let r =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| me.run(ctx, ok_tx, lane)));
            let mut s = me.lock();
            s.exited = true;
            if let Err(p) = r {
                let reason = p
                    .downcast_ref::<&str>()
                    .map(|m| m.to_string())
                    .or_else(|| p.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "panic".into());
                s.died = Some(reason.clone());
                // The unwind dropped every slot (render contexts freed, this context
                // current); their cores stay with their sources, leaked when those go.
                let slots = std::mem::take(&mut s.stats.slots);
                drop(s);
                log::event(
                    "render",
                    Level::Error,
                    "render_worker.died",
                    None,
                    json!({ "reason": reason, "slots": slots }),
                );
            } else {
                drop(s);
            }
            let _ = tx.send(());
        })
        .map_err(|e| {
            close_fd();
            format!("spawn lp-render: {e}")
        })?;
    let interop = match ok_rx.recv() {
        Ok(Ok(interop)) => interop,
        Ok(Err(e)) => {
            let _ = thread.join();
            close_fd();
            return Err(e);
        }
        Err(_) => {
            let _ = thread.join();
            close_fd();
            return Err("lp-render exited during startup".into());
        }
    };
    *inner.done.lock().unwrap_or_else(|e| e.into_inner()) = Some((rx, thread));
    Ok((inner, interop))
}

// ---------------------------------------------------------------------- the thread

impl Inner {
    /// The lane's thread. Lane 0 also picks the worker's hwdec interop (on its own context).
    fn run(
        &self,
        ctx: SharedContext,
        ok: mpsc::Sender<Result<Option<&'static str>, String>>,
        lane: usize,
    ) {
        if let Err(e) = ctx.make_current() {
            let _ = ok.send(Err(e));
            return;
        }
        let faults = faults();
        if faults.no_context {
            let _ = ok.send(Err("test fault no-context: no shared context".into()));
            return;
        }
        let gl = ctx.load_gl();
        let interop = if lane == 0 {
            let vendor = unsafe { gl.get_parameter_string(glow::VENDOR) };
            let mut interop =
                hwdec_interop_for(&vendor, std::env::var(HWDEC_INTEROP_ENV).ok().as_deref());
            // The CUDA interop needs libcuda, which libmpv loads by soname — and a nixpkgs
            // libmpv's RUNPATH lacks the NixOS driver dir (libavutil has it; the flake wrapper
            // adds it to LD_LIBRARY_PATH). Loaded here once, any later soname lookup finds it:
            // the dev / install binary gets the interop from its first source on, like the
            // wrapper.
            let libcuda = matches!(interop, Some("cuda" | "all")).then(preload_libcuda);
            if libcuda == Some(None) {
                interop = None;
            }
            log::event(
                "render",
                Level::Info,
                "render_worker.hwdec_interop",
                None,
                json!({ "gl_vendor": vendor, "interop": interop,
                        "libcuda": libcuda.flatten().map(|(name, _)| name) }),
            );
            (interop, libcuda.flatten().map(|(_, h)| h))
        } else {
            (None, None)
        };
        let (interop, libcuda) = interop;
        let _ = ok.send(Ok(interop));
        if let Some((rc, ms)) = libcuda.and_then(warm_cuda) {
            log::event(
                "render",
                if rc == 0 { Level::Info } else { Level::Warn },
                "render_worker.cuda_init",
                None,
                json!({ "result": rc, "ms": ms }),
            );
        }
        let mut slots: BTreeMap<u64, Slot> = BTreeMap::new();
        // Rendered, flushed, fence not signalled yet: (slot, frame, render ms, rendered at).
        let mut inflight: Vec<(u64, Frame, f64, Instant)> = Vec::new();
        let mut next_id = 1u64;
        loop {
            let mut pfd = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // A frame on the GPU is polled every FENCE_POLL (never a blocking
            // `glClientWaitSync`: on NVIDIA 595 that wait holds the driver's process-wide lock,
            // so every other thread's GL — the compositor's included — queues behind the GPU
            // work); idle, the eventfd alone wakes it (100 ms backstop).
            let wait = if inflight.is_empty() {
                IDLE_POLL
            } else {
                FENCE_POLL
            };
            let ts = libc::timespec {
                tv_sec: 0,
                tv_nsec: wait.as_nanos() as libc::c_long,
            };
            unsafe { libc::ppoll(&mut pfd, 1, &ts, std::ptr::null()) };
            let mut buf = 0u64;
            unsafe { libc::read(self.fd, &mut buf as *mut u64 as *mut libc::c_void, 8) };
            let (jobs, closing) = {
                let mut s = self.lock();
                (std::mem::take(&mut s.jobs), s.closing)
            };
            for job in jobs {
                match job {
                    Job::Attach {
                        core,
                        loop_wake,
                        reply,
                    } => {
                        let t = Instant::now();
                        // Quitting: no new render context (the core goes back; nobody will
                        // show it — its open is being dropped too).
                        let r = if closing {
                            Err("render worker is closing".to_string())
                        } else {
                            Slot::create(&core.0, loop_wake, self.fd)
                        };
                        let ms = t.elapsed().as_secs_f64() * 1000.0;
                        log::event(
                            "render",
                            if ms >= SLOW_JOB_MS {
                                Level::Info
                            } else {
                                Level::Debug
                            },
                            "render_worker.attach",
                            None,
                            json!({ "lane": lane, "ms": ms, "ok": r.is_ok() }),
                        );
                        match r {
                            Ok(slot) => {
                                let id = next_id;
                                next_id += 1;
                                let ex = Arc::clone(&slot.ex);
                                slots.insert(id, slot);
                                if let Err(mpsc::SendError((core, _))) =
                                    reply.send((core, Ok((id, ex))))
                                {
                                    // The `lp-open` job gave up: undo, reap the core here.
                                    if let Some(s) = slots.remove(&id) {
                                        s.free(&gl);
                                    }
                                    reaper::reap(core.0);
                                }
                                let mut s = self.lock();
                                s.stats.attaches += 1;
                                s.stats.attach_ms_max = s.stats.attach_ms_max.max(ms);
                            }
                            Err(e) => {
                                if let Err(mpsc::SendError((core, _))) = reply.send((core, Err(e)))
                                {
                                    reaper::reap(core.0);
                                }
                            }
                        }
                    }
                    Job::Free { id, core, fences } => {
                        let t = Instant::now();
                        inflight.retain_mut(|(sid, f, _, _)| {
                            if *sid == id
                                && let Some(fence) = f.fence.take()
                            {
                                fence.delete(&gl);
                            }
                            *sid != id
                        });
                        if let Some(s) = slots.remove(&id) {
                            s.free(&gl);
                        }
                        for f in fences {
                            f.delete(&gl);
                        }
                        if let Some(c) = core {
                            reaper::reap(c.0);
                        }
                        let ms = t.elapsed().as_secs_f64() * 1000.0;
                        log::event(
                            "render",
                            if ms >= SLOW_JOB_MS {
                                Level::Info
                            } else {
                                Level::Debug
                            },
                            "render_worker.free",
                            None,
                            json!({ "lane": lane, "ms": ms }),
                        );
                        let mut s = self.lock();
                        s.stats.frees += 1;
                        s.stats.free_ms_max = s.stats.free_ms_max.max(ms);
                    }
                }
            }
            self.lock().stats.slots = slots.len();
            if closing && slots.is_empty() {
                break;
            }
            // One render pass: every slot with a frame due and none on the GPU renders (a frame
            // mpv queues meanwhile stays pending — level-triggered), one flush for them all.
            let mut rendered = 0u64;
            let mut render_max = 0f64;
            for (id, slot) in slots.iter_mut() {
                if inflight.iter().any(|(sid, ..)| sid == id) {
                    continue;
                }
                if let Some((mut f, ms)) = slot.render(&gl) {
                    rendered += 1;
                    render_max = render_max.max(ms);
                    if faults.no_fence {
                        if let Some(fence) = f.fence.take() {
                            fence.delete(&gl);
                        }
                        slot.publish(&gl, f, ms);
                        continue;
                    }
                    inflight.push((*id, f, ms, Instant::now()));
                }
            }
            if rendered > 0 {
                if faults.slow_flush {
                    std::thread::sleep(SLOW_FLUSH);
                }
                unsafe { gl.flush() };
            }
            // Publish every frame whose fence signalled (polled, `timeout 0`); one still not
            // done after FENCE_WAIT goes anyway — the loop re-checks its fence before using it.
            let mut wait_max = 0f64;
            let mut timeouts = 0u64;
            let mut first_max = 0f64;
            let mut i = 0;
            while i < inflight.len() {
                let (_, f, _, at) = &inflight[i];
                let done = f.fence.as_ref().is_none_or(|fence| fence.signalled(&gl));
                let late = at.elapsed() >= FENCE_WAIT;
                if !done && !late {
                    i += 1;
                    continue;
                }
                let (id, f, ms, at) = inflight.swap_remove(i);
                timeouts += u64::from(!done);
                wait_max = wait_max.max(at.elapsed().as_secs_f64() * 1000.0);
                if let Some(slot) = slots.get_mut(&id)
                    && let Some(first) = slot.publish(&gl, f, ms)
                {
                    first_max = first_max.max(first);
                    // A render context's first render (shaders, LUTs; with the interop also
                    // its texture registration) — on the timeline next to `.attach`/`.free`.
                    log::event(
                        "render",
                        if first >= SLOW_JOB_MS {
                            Level::Info
                        } else {
                            Level::Debug
                        },
                        "render_worker.first_render",
                        None,
                        json!({ "lane": lane, "slot": id, "ms": first }),
                    );
                }
            }
            if rendered > 0 || wait_max > 0.0 {
                let mut s = self.lock();
                s.stats.passes += 1;
                s.stats.renders += rendered;
                s.stats.render_ms_max = s.stats.render_ms_max.max(render_max);
                s.stats.first_render_ms_max = s.stats.first_render_ms_max.max(first_max);
                s.stats.fence_wait_ms_max = s.stats.fence_wait_ms_max.max(wait_max);
                s.stats.fence_timeouts += timeouts;
            }
        }
        for (_, f, _, _) in inflight {
            if let Some(fence) = f.fence {
                fence.delete(&gl);
            }
        }
        drop(slots);
        drop(gl);
        drop(ctx);
    }
}

/// One source's render state on the worker.
struct Slot {
    render: Option<RenderContext>,
    weak: Option<WeakClient>,
    ex: Arc<Exchange>,
    loop_wake: OwnedFd,
    /// Every texture this slot made (wherever it is now) and its worker-side FBO.
    targets: HashMap<u32, (Tex, Fbo)>,
    /// Textures the worker may render into (+ the loop's release fence, if it sampled them).
    free: Vec<(u32, Option<SyncFence>)>,
    /// FILE_LOADED events seen on the weak client.
    file_loaded: u64,
    /// Size and tag of the last frame rendered (a size change re-renders it).
    last: Option<((u32, u32), u64)>,
    /// The weak client saw SHUTDOWN (the core is going): render nothing more.
    dead: bool,
}

fn tex_copy(t: &Tex) -> Tex {
    Tex {
        id: t.id,
        w: t.w,
        h: t.h,
    }
}

impl Slot {
    fn create(core: &Handle, loop_wake: OwnedFd, worker_fd: RawFd) -> Result<Slot, String> {
        // SAFETY: the core is alive (its owner waits for this reply) and outlives the weak
        // client and the render context (the slot is freed before the core is reaped).
        let weak = unsafe { WeakClient::create(core.raw()) }.map_err(|e| e.to_string())?;
        let render = unsafe { RenderContext::create_raw(core.raw(), get_proc_address) }
            .map_err(|e| e.to_string())?;
        // SAFETY: the worker's eventfd is never closed.
        unsafe { render.set_update_callback(Some(on_wake), worker_fd as usize as *mut _) };
        Ok(Slot {
            render: Some(render),
            weak: Some(weak),
            ex: Arc::new(Exchange {
                m: Mutex::new(ExState::default()),
            }),
            loop_wake,
            targets: HashMap::new(),
            free: Vec::new(),
            file_loaded: 0,
            last: None,
            dead: false,
        })
    }

    /// Render a due frame (mpv has a new one, or the size changed since the last): returns it
    /// (fenced, not yet flushed) and the render's CPU time.
    fn render(&mut self, gl: &glow::Context) -> Option<(Frame, f64)> {
        if self.dead {
            return None;
        }
        if faults().panic {
            panic!("test fault panic: lp-render panicked in a render");
        }
        if let Some(w) = &self.weak {
            let ev = w.poll();
            self.file_loaded += ev.file_loaded;
            if ev.shutdown {
                self.dead = true;
                return None;
            }
        }
        let (size, returned) = {
            let mut st = self.ex.lock();
            (st.size, std::mem::take(&mut st.returned))
        };
        for (t, fence) in returned {
            self.free.push((t.id.0.get(), fence));
        }
        // Called every pass, like the loop renderer did every update (it also runs mpv's
        // render-thread dispatch queue); level-triggered — a frame we can't render yet
        // (no size) stays pending.
        let pending = self.render.as_ref()?.frame_pending();
        let size = size?;
        let redraw = !pending && self.last.is_some_and(|(s, _)| s != size);
        if !pending && !redraw {
            return None;
        }
        // A redraw shows the frame it re-renders, so it keeps that frame's tag: ours (a size
        // change) and mpv's own (`MPV_RENDER_FRAME_INFO_REDRAW` — the VO re-presents its
        // current frame; after a path change that's the OLD file's last frame, queued after
        // the new FILE_LOADED: measured, a red→green path change promoted red with the plain
        // "rendered after FILE_LOADED" tag once the worker rendered it late). Only a genuinely
        // new frame takes the FILE_LOADED count: mpv drops a superseded load's queued frames
        // when it ends (VO reset), so a new one pending after FILE_LOADED is the new file's.
        let repeat = !pending || self.render.as_ref()?.next_frame_is_redraw();
        let tag = match (repeat, self.last) {
            (true, Some((_, t))) => t,
            _ => self.file_loaded,
        };
        let id = self.take_free(gl, size);
        let (tex, fbo) = self.targets.get(&id).expect("a free target is known");
        let fbo = fbo.id.0.get();
        let tex = tex_copy(tex);
        let early = faults().publish_early;
        if early {
            let f = Frame {
                tex: tex_copy(&tex),
                fence: None,
                file_loaded: tag,
            };
            self.publish(gl, f, 0.0);
            std::thread::sleep(SLOW_FLUSH);
        }
        let t = Instant::now();
        let render = self.render.as_ref()?;
        // R25: FLIP_Y = 0 — image top at texture row 0, like the loop renderer.
        let res = unsafe { render.render(fbo, size.0, size.1, glow::RGBA8, false) };
        reset_gl(gl);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        match res {
            Ok(()) if early => {
                self.last = Some((size, tag));
                None
            }
            Ok(()) => {
                self.last = Some((size, tag));
                Some((
                    Frame {
                        tex,
                        fence: SyncFence::insert(gl),
                        file_loaded: tag,
                    },
                    ms,
                ))
            }
            Err(e) => {
                self.free.push((id, None));
                self.ex.lock().error = Some(e.to_string());
                None
            }
        }
    }

    /// A free target of `size` (made if there's none; free ones of another size are deleted).
    fn take_free(&mut self, gl: &glow::Context, size: (u32, u32)) -> u32 {
        let mut i = 0;
        while i < self.free.len() {
            let id = self.free[i].0;
            let fits = self
                .targets
                .get(&id)
                .is_some_and(|(t, _)| (t.w, t.h) == size);
            if fits {
                i += 1;
                continue;
            }
            let (_, fence) = self.free.swap_remove(i);
            if let Some(f) = fence {
                f.delete(gl);
            }
            self.delete_target(gl, id);
        }
        // Only a target whose release fence has signalled (the loop's last reads of it are
        // done) — polled, never waited on server-side: a `glWaitSync` on another context's
        // fence put that dependency into this context's GPU queue, and on NVIDIA 595 a fence
        // whose context went away (or one never flushed) then stalled this queue for good —
        // measured: a worker's `eglDestroyContext` stuck in an ioctl at exit while every other
        // thread's GL calls (renders in other workers) waited behind it. One not ready yet
        // stays free for later; a fresh target is made instead (rare: a release is a tick old
        // by the time the next frame renders).
        if let Some(i) = self
            .free
            .iter()
            .rposition(|(_, f)| f.as_ref().is_none_or(|f| f.signalled(gl)))
        {
            let (id, fence) = self.free.remove(i);
            if let Some(f) = fence {
                f.delete(gl);
            }
            return id;
        }
        let tex = new_tex(gl, size.0, size.1);
        let fbo = new_fbo(gl, &tex);
        let id = tex.id.0.get();
        self.targets.insert(id, (tex, fbo));
        id
    }

    fn delete_target(&mut self, gl: &glow::Context, id: u32) {
        if let Some((tex, fbo)) = self.targets.remove(&id) {
            unsafe {
                gl.delete_framebuffer(fbo.id);
                gl.delete_texture(tex.id);
            }
        }
    }

    /// Hand `f` (complete) to the loop; an older frame it never adopted comes back. Returns
    /// the render time if this was the slot's first frame.
    fn publish(&mut self, gl: &glow::Context, f: Frame, ms: f64) -> Option<f64> {
        let (old, first) = {
            let mut st = self.ex.lock();
            st.renders += 1;
            st.last_render_ms = ms;
            st.max_render_ms = st.max_render_ms.max(ms);
            let first = st.first_render_ms.is_none();
            if first {
                st.first_render_ms = Some(ms);
            }
            let old = st.ready.replace(f);
            if old.is_some() {
                st.superseded += 1;
            }
            (old, first)
        };
        if let Some(old) = old {
            if let Some(fence) = old.fence {
                fence.delete(gl);
            }
            // Never sampled by the loop: no release fence needed.
            self.free.push((old.tex.id.0.get(), None));
        }
        while self.free.len() > FREE_KEEP {
            let (id, fence) = self.free.remove(0);
            if let Some(fence) = fence {
                fence.delete(gl);
            }
            self.delete_target(gl, id);
        }
        let one: u64 = 1;
        unsafe {
            libc::write(
                self.loop_wake.as_raw_fd(),
                &one as *const u64 as *const libc::c_void,
                8,
            )
        };
        first.then_some(ms)
    }

    /// Render context freed (this context current — the worker's whole life), weak client
    /// destroyed, every texture/FBO and fence deleted. The caller reaps the core after.
    fn free(mut self, gl: &glow::Context) {
        drop(self.render.take());
        drop(self.weak.take());
        let ready = self.ex.lock().ready.take();
        if let Some(Frame { fence: Some(f), .. }) = ready {
            f.delete(gl);
        }
        for (t, f) in std::mem::take(&mut self.ex.lock().returned) {
            let _ = t;
            if let Some(f) = f {
                f.delete(gl);
            }
        }
        for (_, f) in std::mem::take(&mut self.free) {
            if let Some(f) = f {
                f.delete(gl);
            }
        }
        let ids: Vec<u32> = self.targets.keys().copied().collect();
        for id in ids {
            self.delete_target(gl, id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::hwdec_interop_for;

    /// The interop follows the GPU (one per render context, never mpv's load-everything
    /// `auto`); the env knob turns it off or forces one.
    #[test]
    fn hwdec_interop_follows_the_gpu_and_the_env() {
        for (vendor, env, want) in [
            ("NVIDIA Corporation", None, Some("cuda")),
            ("NVIDIA Corporation", Some(""), Some("cuda")),
            ("NVIDIA Corporation", Some("on"), Some("cuda")),
            ("NVIDIA Corporation", Some("off"), None),
            ("NVIDIA Corporation", Some("0"), None),
            ("NVIDIA Corporation", Some("vaapi"), Some("vaapi")),
            ("NVIDIA Corporation", Some("bogus"), Some("cuda")),
            ("AMD", None, Some("vaapi")),
            ("Intel", None, Some("vaapi")),
            ("Mesa", None, None),
            ("Mesa", Some("cuda"), Some("cuda")),
            ("Mesa", Some("all"), Some("all")),
            ("nouveau", None, None),
        ] {
            assert_eq!(hwdec_interop_for(vendor, env), want, "{vendor} {env:?}");
        }
    }
}
