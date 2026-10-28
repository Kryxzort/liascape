//! EGL display/context plumbing (spec §5.1 "Graphics"): desktop OpenGL (core profile) via
//! EGL, chosen so the compositor can host LWE core if ever needed (LWE core renders with
//! desktop GL, loaded through glad — `docs/player/spikes/lwe-core.md` §2).
//!
//! [`Gfx`] owns the EGL display + context and the [`glow::Context`] loaded through it.
//! There are two ways to build one:
//!
//! - [`Gfx::new_offscreen`] — surfaceless (no window, no compositor): used by every GPU
//!   test and by any worker that renders into FBOs only. This is the path exercised by
//!   this task's test.
//! - [`Gfx::new_wayland`] + [`Gfx::window_target`] — a real `wl_surface` on a real Wayland
//!   compositor, driven by the Wayland backend (`crate::wl`, Task 13) — exercised
//!   on-machine by `tests/onmachine/outputs.sh` (no automated test can reach a compositor).
//!
//! Both paths request the same context: EGL 1.5, desktop OpenGL (`eglBindAPI
//! (EGL_OPENGL_API)`, not OpenGL ES), core profile, version 3.3 — matched to what LWE
//! core's own glad loader expects and to what this machine's NVIDIA 595.84 driver was
//! proven to hand out in the Phase 0 spike.
//!
//! **Static linking, not dynamic (deviation from the brief's first-choice).** The brief
//! asked for `khronos-egl`'s `dynamic` feature (`dlopen("libEGL.so.1")` at runtime) with
//! `static` as the documented fallback "if dynamic causes trouble". It did: a bare-name
//! `dlopen` only searches a binary's own RPATH/RUNPATH (plus `LD_LIBRARY_PATH` and the
//! system cache) — and on this Nix setup, a library that's merely a `buildInputs` /
//! dev-shell `-L` entry never ends up on that RPATH *unless something actually links
//! against it*, because the auto-rpath nixpkgs' `cc`-wrapper adds is driven by what the
//! linker invocation was actually given, not by ambient `NIX_LDFLAGS`. Measured: with
//! `dynamic`, `cargo test --test gfx_basic` under exactly the documented command
//! (`env -u LD_LIBRARY_PATH nix develop -c …`) failed to even `dlopen` `libEGL.so.1` —
//! "SKIP: no EGL device" — and only started working after manually exporting
//! `LD_LIBRARY_PATH=<libglvnd store path>` *and* `__EGL_VENDOR_LIBRARY_DIRS=/run/
//! opengl-driver/share/glvnd/egl_vendor.d`, neither of which the documented command (or
//! the owner's real login/systemd-user session, checked directly) sets. `static` instead
//! goes through `khronos-egl`'s `build.rs`, which calls the `pkg-config` crate's
//! `probe("egl")` — the same mechanism `wayland-egl`/`wayland-sys` already use in this
//! crate's dependency tree (and the reason *their* libraries, unlike EGL under `dynamic`,
//! already showed up correctly in the test binary's `RUNPATH`). That `probe()` call emits
//! real `cargo:rustc-link-lib=EGL` + `cargo:rustc-link-search` directives, which *do* flow
//! into the actual link invocation, which *does* get auto-rpath'd. Net effect: the test
//! binary carries a correct RPATH to the exact `libglvnd` store path with no extra env
//! vars needed — the documented command just works. The only remaining runtime
//! requirement (`__EGL_VENDOR_LIBRARY_DIRS` pointing at a vendor's `egl_vendor.d`, or an
//! equivalent default baked into the system's `libEGL.so.1`) is unaffected by this choice
//! either way, and is exactly the condition [`Gfx::new_offscreen`] already turns into a
//! clean `Err` rather than a crash when it's absent (the sandboxed `nix build` case).

use std::cell::Cell;
use std::ffi::{CStr, c_void};
use std::os::raw::c_char;
use std::ptr;
use std::rc::Rc;

use khronos_egl as egl;

/// `EGL_PLATFORM_SURFACELESS_MESA` (Mesa extension enum; not part of core EGL, so
/// `khronos-egl` doesn't define it). Value from the Khronos EGL registry.
const PLATFORM_SURFACELESS_MESA: egl::Enum = 0x31DD;

/// `EGL_PLATFORM_DEVICE_EXT` (`EGL_EXT_platform_device`). Same reasoning as above.
const PLATFORM_DEVICE_EXT: egl::Enum = 0x313F;

/// `EGL_PLATFORM_WAYLAND_KHR` (`EGL_KHR_platform_wayland`). Used by [`Gfx::new_wayland`].
const PLATFORM_WAYLAND_KHR: egl::Enum = 0x31D8;

/// The concrete EGL instance type this module works with everywhere: EGL **statically**
/// linked (`khronos-egl`'s `static` feature, which resolves `libEGL` at build time via
/// `pkg-config` — see the module-level note on why `dynamic` was tried first and dropped).
/// Implements EGL 1.5 unconditionally (`get_platform_display`, `create_image`, …) since
/// that's compiled in, not probed at runtime.
pub(crate) type EglInstance = egl::Instance<egl::Static>;

/// `EGL_CONTEXT_PRIORITY_LEVEL_IMG` and its levels (`EGL_IMG_context_priority`).
const CONTEXT_PRIORITY_LEVEL_IMG: egl::Int = 0x3100;

/// GPU scheduling priority asked for a context (`EGL_IMG_context_priority`; Phase 2 Task 4:
/// scene workers ask for `Low`; compositor contexts keep the driver default — see
/// [`OffscreenOpts`]). The driver may grant less
/// (or ignore it); [`Gfx::context_priority`] says what was granted. NVIDIA 595 grants both
/// unprivileged (spike `dmabuf.md` §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    High,
    Medium,
    Low,
}

impl Priority {
    fn to_egl(self) -> egl::Int {
        match self {
            Priority::High => 0x3101,
            Priority::Medium => 0x3102,
            Priority::Low => 0x3103,
        }
    }

    fn from_egl(v: egl::Int) -> Option<Priority> {
        match v {
            0x3101 => Some(Priority::High),
            0x3102 => Some(Priority::Medium),
            0x3103 => Some(Priority::Low),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Priority::High => "high",
            Priority::Medium => "medium",
            Priority::Low => "low",
        }
    }
}

/// [`Gfx::new_offscreen_with`]'s options. Default = the compositor's: no priority asked.
///
/// **Why not `High` for the compositor (the plan's call):** it was tried. With `High` the
/// render worker's `tests/api.rs::render_worker_never_composes_a_torn_frame` delivered 13–72
/// capture rounds (3 of 4 runs under its bound), without the attribute 21–53 (1 of 3) — on a
/// machine at load average ~21, so not distinguishable from load; the spike saw no effect
/// either. Raising every compositor context (and so the Phase 1 render worker's neighbour)
/// for no measured gain wasn't worth the risk: the compositor keeps the driver default
/// (`Medium` on NVIDIA) and only the scene worker is lowered — the ordering the spike wanted.
#[derive(Debug, Clone, Copy, Default)]
pub struct OffscreenOpts {
    pub priority: Option<Priority>,
    /// Phase 2 Task 10: ask for a context that **reports** a GPU reset instead of rendering
    /// garbage after one — robust buffer access + `LOSE_CONTEXT_ON_RESET` (EGL 1.5 /
    /// `EGL_KHR_create_context`, else `EGL_EXT_create_context_robustness`), plus
    /// `EGL_GENERATE_RESET_ON_VIDEO_MEMORY_PURGE_NV` where listed (NVIDIA purges VRAM on
    /// suspend/resume and VT switches). A driver refusing it falls back to a plain context;
    /// [`Gfx::loses_context_on_reset`] says what was granted, [`Gfx::reset_status`] polls it.
    /// The scene worker asks for it (a lost context = a crash restart); compositor contexts
    /// don't.
    pub robust: bool,
}

/// `EGL_CONTEXT_OPENGL_ROBUST_ACCESS` (EGL 1.5 / `EGL_KHR_create_context`).
const CONTEXT_OPENGL_ROBUST_ACCESS: egl::Int = 0x31B2;
/// `EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY` (EGL 1.5 / `_KHR`).
const CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY: egl::Int = 0x31BD;
/// `EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT` (`EGL_EXT_create_context_robustness`).
const CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT: egl::Int = 0x3138;
/// `EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT` (`EGL_EXT_create_context_robustness`).
const CONTEXT_OPENGL_ROBUST_ACCESS_EXT: egl::Int = 0x30BF;
/// `EGL_LOSE_CONTEXT_ON_RESET` (core and `_EXT`).
const LOSE_CONTEXT_ON_RESET: egl::Int = 0x31BF;
/// `EGL_GENERATE_RESET_ON_VIDEO_MEMORY_PURGE_NV` (`EGL_NV_robustness_video_memory_purge`).
const GENERATE_RESET_ON_VIDEO_MEMORY_PURGE_NV: egl::Int = 0x334C;
/// `GL_RESET_NOTIFICATION_STRATEGY` / `GL_LOSE_CONTEXT_ON_RESET` (GL 4.5 / `KHR_robustness`).
const GL_RESET_NOTIFICATION_STRATEGY: u32 = 0x8256;
const GL_LOSE_CONTEXT_ON_RESET: u32 = 0x8252;

/// Opaque `EGLDeviceEXT` handle (`EGL_EXT_device_base`). Not a `khronos-egl` type — that
/// extension predates EGL 1.5 and isn't part of the crate's core API, so this module talks
/// to it through raw `eglGetProcAddress` function pointers, same as `host.cpp`'s spike.
type EglDeviceExt = *mut c_void;

/// The EGL display + context pair, and the EGL API handle used to tear them down —
/// everything [`Gfx`] and every [`WindowTarget`] made from it need to keep calling EGL,
/// and everything that must be released, in order, exactly once, no matter which of
/// those owners happens to drop last.
///
/// **Reference-counted (`Rc`), not borrowed.** A `WindowTarget` tied to `&'a Gfx` would
/// force a self-referential struct the moment the runtime stores a `Gfx` and its
/// `WindowTarget` side by side in the same per-output struct (which it does — one output
/// owns one `Gfx` and one live `WindowTarget` together). `Rc` sidesteps that: `Gfx` and
/// every `WindowTarget` it creates hold their own clone of the *same* `Shared`, so
/// `Shared::drop` — the `eglMakeCurrent(none)` → `eglDestroyContext` → `eglTerminate`
/// sequence — runs exactly once, whenever the *last* clone goes away, regardless of
/// whether the `Gfx` or a `WindowTarget` dropped first. (Reviewed finding: an earlier
/// version of this module put `display`/`context` directly on `Gfx` with its own `Drop`,
/// while `WindowTarget` kept only a *copy* of the `Display` value — nothing kept the
/// owning `Gfx` alive, so dropping it first `eglTerminate`d the display while a
/// `WindowTarget` still referencing it was about to call `eglDestroySurface` on it:
/// undefined behaviour. This `Shared` type is the fix.)
struct Shared {
    egl: EglInstance,
    display: egl::Display,
    context: egl::Context,
}

impl Drop for Shared {
    fn drop(&mut self) {
        // Test-only, deterministic signal that this teardown actually ran (and when) —
        // real EGL implementations aren't reliably strict about rejecting calls on a
        // terminated display (observed directly: `eglQueryString` kept succeeding on this
        // driver even after a manual, out-of-band `eglTerminate` on the same display), so
        // counting here, rather than probing EGL's own post-teardown behaviour, is what
        // makes the covering test below able to fail at all if this ownership fix ever
        // regresses.
        #[cfg(test)]
        SHARED_DROP_COUNT.with(|c| c.set(c.get() + 1));

        // Release the context before destroying it (a no-op if something else is already
        // current on this thread) and terminate the display. Best-effort: there is no
        // meaningful recovery from any of these failing during teardown, and panicking in
        // `drop` would just mask whatever error got us here.
        //
        // Only release the context if it's *this* one that's current: another Gfx on the
        // same display may be current here, and unbinding it would pull the rug from
        // under it. Terminate only when this is the display's last user (see
        // `display_release`).
        if self.egl.get_current_context() == Some(self.context) {
            let _ = self.egl.make_current(self.display, None, None, None);
        }
        let _ = self.egl.destroy_context(self.display, self.context);
        let _life = display_lifecycle();
        if display_release(self.display) {
            let _ = self.egl.terminate(self.display);
        }
    }
}

/// Held across "initialize + count a user" and across "uncount + terminate", so the two never
/// interleave: before, a `Gfx` dropped on one thread could `eglTerminate` the shared display
/// between another thread's `eglInitialize` and its `display_acquire` — that thread's display
/// was then uninitialized under it (`EGL_NOT_INITIALIZED` at its next `eglCreateContext`;
/// found by the Phase 2 render-worker tests, one test's teardown overlapping the next one's
/// setup — the "latent race between parallel GPU tests" Task 10 noted).
static DISPLAY_LIFECYCLE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn display_lifecycle() -> std::sync::MutexGuard<'static, ()> {
    DISPLAY_LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Live [`Shared`]s per EGL display handle. **Every surfaceless `Gfx` in a process gets the
/// same `EGLDisplay`** (`EGL_DEFAULT_DISPLAY` on one platform), and `eglInitialize` is not
/// reference-counted (EGL 1.5), so an unconditional `eglTerminate` in one `Gfx`'s drop
/// tore the display down under every other live `Gfx` on it: their non-current contexts
/// were destroyed and any later `eglMakeCurrent` failed with `EGL_NOT_INITIALIZED` (found
/// in Task 10's fix round, when a source first switched contexts with a second `Gfx`
/// alive — `tests/gfx_basic.rs::two_gfx_on_one_display_survive_each_others_drop`).
static DISPLAY_USERS: std::sync::Mutex<Vec<(usize, usize)>> = std::sync::Mutex::new(Vec::new());

fn display_acquire(d: egl::Display) {
    let key = d.as_ptr() as usize;
    let mut users = DISPLAY_USERS.lock().unwrap_or_else(|e| e.into_inner());
    match users.iter_mut().find(|(k, _)| *k == key) {
        Some((_, n)) => *n += 1,
        None => users.push((key, 1)),
    }
}

/// Drops one user of `d`; true when it was the last (the caller then terminates).
fn display_release(d: egl::Display) -> bool {
    let key = d.as_ptr() as usize;
    let mut users = DISPLAY_USERS.lock().unwrap_or_else(|e| e.into_inner());
    match users.iter().position(|(k, _)| *k == key) {
        Some(i) => {
            users[i].1 -= 1;
            if users[i].1 == 0 {
                users.swap_remove(i);
                true
            } else {
                false
            }
        }
        None => true,
    }
}

#[cfg(test)]
std::thread_local! {
    /// How many times `Shared::drop` has run on this test thread. Reset and read by
    /// `tests::shared_egl_state_outlives_gfx_when_another_clone_exists` — see there.
    static SHARED_DROP_COUNT: Cell<u32> = const { Cell::new(0) };
}

/// GPU context handle: the EGL display + context (via the shared [`Shared`], see its doc
/// comment for why it's `Rc` rather than a borrow) plus the [`glow::Context`] loaded
/// through it.
///
/// Not `Send`/`Sync`: an EGL context (like any GL context) is only valid to use from the
/// thread that made it current, and nothing here tries to migrate it. Same rationale as
/// `clock.rs`'s `Cell`-based clocks.
pub struct Gfx {
    pub gl: glow::Context,
    shared: Rc<Shared>,
    config: egl::Config,
    /// Which EGL display-selection path produced the display — surfaced for diagnostics
    /// (logged by callers, asserted on by nothing) and spelled out exactly as the brief's
    /// reference spike (`host.cpp`) labels its own two paths.
    pub path: String,
    /// Lazily-created, reused VAO (core profile requires *some* VAO bound even for a
    /// fullscreen-triangle draw built entirely from `gl_VertexID`; see [`Gfx::empty_vao`]).
    pub(crate) empty_vao: Cell<Option<glow::VertexArray>>,
    /// The context priority the driver granted (`None`: no `EGL_IMG_context_priority`).
    priority: Option<Priority>,
}

impl Gfx {
    /// Surfaceless desktop-GL 3.3 core context: no window, no native display at all.
    /// Display selection, in order (mirrors `spikes/lwe-core/host.cpp`'s `egl_init`, proven
    /// on this machine's NVIDIA 595.84 — `docs/player/spikes/lwe-core.md` §2):
    ///
    /// 1. `EGL_PLATFORM_SURFACELESS_MESA` (via `eglGetPlatformDisplayEXT`, `EGL_DEFAULT_
    ///    DISPLAY` native handle — see [`get_platform_display_ext`] for why the `EXT` entry
    ///    point, not core `eglGetPlatformDisplay`) — present on this driver through glvnd,
    ///    and the one that actually worked in the spike.
    /// 2. Else `EGL_EXT_platform_device`: enumerate devices with `eglQueryDevicesEXT`,
    ///    skip a device exposing only `EGL_MESA_device_software` unless it's the last one
    ///    (software fallback ranks behind real hardware, exactly like the spike), and try
    ///    `eglGetPlatformDisplayEXT(EGL_PLATFORM_DEVICE_EXT, device, …)` + `eglInitialize`
    ///    on each until one succeeds.
    ///
    /// Requires `EGL_KHR_surfaceless_context` on the chosen display (so `eglMakeCurrent`
    /// with `EGL_NO_SURFACE` is actually legal) — present on NVIDIA, checked explicitly and
    /// reported by name if missing rather than failing downstream with an opaque
    /// `eglMakeCurrent` error.
    ///
    /// Returns `Err` (never panics) for every failure mode, including "no GPU/EGL device
    /// available at all" — the case `tests/common::headless_gl` turns into a clean test
    /// skip, and the case that must not fail `nix build .#lp-player`'s sandboxed check
    /// phase (no `/dev/dri` there).
    pub fn new_offscreen() -> Result<Gfx, String> {
        Gfx::new_offscreen_with(OffscreenOpts::default())
    }

    /// [`new_offscreen`](Self::new_offscreen) with options: the context priority (a scene
    /// worker asks for `Low`; the compositor's default is `High`).
    pub fn new_offscreen_with(opts: OffscreenOpts) -> Result<Gfx, String> {
        let egl = load_egl()?;

        let client_ext = egl
            .query_string(None, egl::EXTENSIONS)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();

        // Initialize + count this user under one lock (`DISPLAY_LIFECYCLE`).
        let life = display_lifecycle();
        let (display, path) = pick_offscreen_display(&egl, &client_ext)?;

        require_surfaceless_context(&egl, display, &path)?;

        let config = choose_config(&egl, display, egl::PBUFFER_BIT)?;
        let (context, priority) = create_prioritized_context(
            &egl,
            display,
            config,
            opts.priority,
            opts.robust,
            &path,
        )?;

        egl.make_current(display, None, None, Some(context))
            .map_err(|e| format!("eglMakeCurrent (surfaceless) failed: {e}"))?;

        let gl = load_gl(&egl);

        display_acquire(display);
        drop(life);
        Ok(Gfx {
            gl,
            shared: Rc::new(Shared {
                egl,
                display,
                context,
            }),
            config,
            path,
            empty_vao: Cell::new(None),
            priority,
        })
    }

    /// The context priority the driver granted (`None` without `EGL_IMG_context_priority`).
    pub fn context_priority(&self) -> Option<Priority> {
        self.priority
    }

    /// Phase 2 Task 10: this context reports a GPU reset (its reset notification strategy is
    /// `LOSE_CONTEXT_ON_RESET` — [`OffscreenOpts::robust`] was granted), so
    /// [`reset_status`](Self::reset_status) means something. Reads GL state: call with this
    /// context current.
    pub fn loses_context_on_reset(&self) -> bool {
        unsafe {
            use glow::HasContext;
            self.gl.get_parameter_i32(GL_RESET_NOTIFICATION_STRATEGY) as u32
                == GL_LOSE_CONTEXT_ON_RESET
        }
    }

    /// Phase 2 Task 10: `glGetGraphicsResetStatus` (GL 4.5 / `KHR`/`ARB_robustness`, looked up
    /// once): `0` (`GL_NO_ERROR`) while the context is fine, else the reset it suffered
    /// (`GUILTY`/`INNOCENT`/`UNKNOWN_CONTEXT_RESET`, or `PURGED_CONTEXT_RESET_NV` after an
    /// NVIDIA video-memory purge) — the context is lost then and must be recreated. `None`
    /// when the driver has no such entry point. Cheap (no GPU sync); this context current.
    pub fn reset_status(&self) -> Option<u32> {
        use std::sync::OnceLock;
        static PROC: OnceLock<usize> = OnceLock::new();
        let p = *PROC.get_or_init(|| {
            ["glGetGraphicsResetStatus", "glGetGraphicsResetStatusKHR", "glGetGraphicsResetStatusARB"]
                .iter()
                .find_map(|n| self.shared.egl.get_proc_address(n).map(|f| f as usize))
                .unwrap_or(0)
        });
        if p == 0 {
            return None;
        }
        let f: unsafe extern "system" fn() -> u32 = unsafe { std::mem::transmute(p) };
        Some(unsafe { f() })
    }

    /// This context's EGL instance, display and context (Phase 2 `gfx::dmabuf`).
    pub(crate) fn egl_parts(&self) -> (&EglInstance, egl::Display, egl::Context) {
        (&self.shared.egl, self.shared.display, self.shared.context)
    }

    /// Whether this context's display lists `ext`.
    pub fn has_display_ext(&self, ext: &str) -> bool {
        let list = self
            .shared
            .egl
            .query_string(Some(self.shared.display), egl::EXTENSIONS)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        has_ext(&list, ext)
    }

    /// Desktop-GL 3.3 core context on a real Wayland display, via
    /// `eglGetPlatformDisplayEXT(EGL_PLATFORM_WAYLAND_KHR, display_ptr, …)` (see
    /// [`get_platform_display_ext`] for why the `EXT` entry point, not core
    /// `eglGetPlatformDisplay`) — same context config as
    /// [`new_offscreen`](Self::new_offscreen) but with `EGL_WINDOW_BIT` in the config's
    /// surface type (a pbuffer-only config can't back a window surface).
    ///
    /// `display_ptr` is a raw `*mut wl_display` from `libwayland-client` (the caller's
    /// Wayland connection) — this module never links or depends on `wayland-client`
    /// itself, it only hands the pointer straight to EGL.
    ///
    /// The context starts current with no surface, so the default framebuffer's draw buffer
    /// is `GL_NONE` until set: a caller drawing to a window must `glDrawBuffer(GL_BACK)`
    /// (the Wayland backend does, in `present`). Wired up by `crate::wl` (Task 13).
    pub fn new_wayland(display_ptr: *mut c_void) -> Result<Gfx, String> {
        let egl = load_egl()?;

        let display =
            get_platform_display_ext(&egl, PLATFORM_WAYLAND_KHR, display_ptr).map_err(|e| {
                format!("eglGetPlatformDisplayEXT(EGL_PLATFORM_WAYLAND_KHR) failed: {e}")
            })?;
        let life = display_lifecycle();
        egl.initialize(display)
            .map_err(|e| format!("eglInitialize (wayland) failed: {e}"))?;

        // `EGL_KHR_surfaceless_context` is the offscreen path's requirement (it's what
        // makes `EGL_NO_SURFACE` legal); the window path always has a real surface, so it
        // is never checked here.
        let path = "EGL_PLATFORM_WAYLAND_KHR".to_string();

        let config = choose_config(&egl, display, egl::WINDOW_BIT)?;
        let (context, priority) =
            create_prioritized_context(&egl, display, config, None, false, &path)?;

        egl.make_current(display, None, None, Some(context))
            .map_err(|e| format!("eglMakeCurrent (wayland, no surface yet) failed: {e}"))?;

        let gl = load_gl(&egl);

        display_acquire(display);
        drop(life);
        Ok(Gfx {
            gl,
            shared: Rc::new(Shared {
                egl,
                display,
                context,
            }),
            config,
            path,
            empty_vao: Cell::new(None),
            priority,
        })
    }

    /// Make this context current with no surface — e.g. before destroying a window target
    /// that may be the current draw surface (Task 13: a removed `wl_output`), so its
    /// `eglDestroySurface` is immediate and GL deletes still have a context. Needs
    /// `EGL_KHR_surfaceless_context` (present on NVIDIA's Wayland platform too).
    pub fn make_current_surfaceless(&self) -> Result<(), String> {
        self.shared
            .egl
            .make_current(self.shared.display, None, None, Some(self.shared.context))
            .map_err(|e| format!("eglMakeCurrent (surfaceless) failed: {e}"))
    }

    /// Create a window-backed render target for a `wl_surface` (raw `*mut wl_surface`
    /// from `libwayland-client`), sized `w`×`h`. Only valid on a [`Gfx`] built with
    /// [`new_wayland`](Self::new_wayland) (the config it chose has `EGL_WINDOW_BIT`;
    /// an offscreen `Gfx`'s pbuffer-only config would fail `eglCreatePlatformWindowSurface`).
    ///
    /// The returned [`WindowTarget`] clones this `Gfx`'s shared EGL state (see [`Shared`])
    /// rather than borrowing it — the two are meant to be stored side by side (one output
    /// owns one `Gfx` and one `WindowTarget`) and dropped in whichever order the owning
    /// struct's fields happen to drop in, safely either way.
    ///
    /// First exercised by Task 13's Wayland backend (`crate::wl`, on-machine
    /// `tests/onmachine/outputs.sh`).
    pub fn window_target(
        &self,
        wl_surface_ptr: *mut c_void,
        w: u32,
        h: u32,
    ) -> Result<WindowTarget, String> {
        if w == 0 || h == 0 {
            return Err(format!("window_target: size must be non-zero, got {w}x{h}"));
        }

        let egl_window = unsafe {
            wayland_egl::WlEglSurface::new_from_raw(wl_surface_ptr.cast(), w as i32, h as i32)
        }
        .map_err(|e| format!("wl_egl_window_create failed: {e}"))?;

        let surface = unsafe {
            self.shared.egl.create_platform_window_surface(
                self.shared.display,
                self.config,
                egl_window.ptr().cast_mut(),
                // khronos-egl requires an ATTRIB_NONE-terminated list (an empty slice is
                // rejected as EGL_BAD_PARAMETER — found when Task 13 first ran this).
                &[egl::ATTRIB_NONE],
            )
        }
        .map_err(|e| format!("eglCreatePlatformWindowSurface failed: {e}"))?;

        Ok(WindowTarget {
            shared: self.shared.clone(),
            surface,
            egl_window,
        })
    }
}

/// A window-backed EGL surface for one `wl_surface`, created by [`Gfx::window_target`].
/// Holds its own clone of the owning `Gfx`'s [`Shared`] EGL state (display + context +
/// the EGL API handle) — **not** a borrow of the `Gfx` — specifically so this struct and
/// the `Gfx` it came from can be dropped in either order: whichever of the two drops last
/// is the one whose `Shared` clone actually reaches zero and runs `Shared::drop`
/// (`eglTerminate` etc.), so the display is always still valid when this type's own
/// `Drop` calls `eglDestroySurface` on it, no matter the order. See [`Shared`]'s doc
/// comment for the bug this replaced.
///
/// Owns the `wl_egl_window` (via [`wayland_egl::WlEglSurface`]) and the `EGLSurface` built
/// from it; both are released on `Drop`, in the order EGL requires (surface, then the
/// `wl_egl_window` through `WlEglSurface`'s own `Drop` — which per that crate's contract
/// must happen *before* the underlying `wl_surface` is destroyed, a constraint owned by
/// whoever holds the `wl_surface`, i.e. Task 13's output code, not this struct).
pub struct WindowTarget {
    shared: Rc<Shared>,
    surface: egl::Surface,
    egl_window: wayland_egl::WlEglSurface,
}

impl WindowTarget {
    /// Resize the backing `wl_egl_window` (and therefore the `EGLSurface`) to `w`×`h`.
    /// No origin displacement (`dx`/`dy` both `0`) — the surface keeps its top-left corner.
    pub fn resize(&self, w: u32, h: u32) {
        self.egl_window.resize(w as i32, h as i32, 0, 0);
    }

    /// Make this target's surface current for both draw and read on the calling thread,
    /// using `gfx`'s context. `gfx` must be the same [`Gfx`] this target was created from
    /// (or at least one sharing its EGL display) — EGL itself would reject the mismatch.
    pub fn make_current(&self, gfx: &Gfx) -> Result<(), String> {
        gfx.shared
            .egl
            .make_current(
                self.shared.display,
                Some(self.surface),
                Some(self.surface),
                Some(gfx.shared.context),
            )
            .map_err(|e| format!("eglMakeCurrent (window) failed: {e}"))
    }

    /// `eglSwapInterval` for this surface (made current first). `0` = `eglSwapBuffers`
    /// never blocks on the compositor: the Wayland backend paces every output with its own
    /// frame callbacks instead, so a 144 Hz output's swap can't hold up a 240 Hz one on the
    /// same thread (Task 13).
    pub fn set_swap_interval(&self, gfx: &Gfx, interval: i32) -> Result<(), String> {
        self.make_current(gfx)?;
        gfx.shared
            .egl
            .swap_interval(self.shared.display, interval)
            .map_err(|e| format!("eglSwapInterval({interval}) failed: {e}"))
    }

    /// Present the back buffer (`eglSwapBuffers`).
    pub fn swap(&self, gfx: &Gfx) -> Result<(), String> {
        gfx.shared
            .egl
            .swap_buffers(self.shared.display, self.surface)
            .map_err(|e| format!("eglSwapBuffers failed: {e}"))
    }
}

impl Drop for WindowTarget {
    fn drop(&mut self) {
        // Destroy the EGLSurface first; `egl_window`'s own `Drop` (wl_egl_window_destroy)
        // then runs automatically right after, per `wayland_egl::WlEglSurface`'s contract.
        // `self.shared` is guaranteed still valid here even if the owning `Gfx` (and every
        // other clone) has already been dropped — that's the whole point of holding a
        // clone rather than a borrow; see `Shared`'s doc comment.
        let _ = self
            .shared
            .egl
            .destroy_surface(self.shared.display, self.surface);
    }
}

/// Keeps a [`Gfx`]'s EGL display + context alive (a clone of its [`Shared`], exactly like
/// [`WindowTarget`]) and lets a `Drop` impl — which never gets a `&Gfx` — make that
/// context current and delete GL objects in it. Built by [`Gfx::keep_alive`].
///
/// Exists for Task 10's libmpv sources: `mpv_render_context_free` must run with the GL
/// context it was created on current (lp-transition gotcha, spec §5.1), and the source's
/// FBO/texture must be deleted in that context too — regardless of whether the owning
/// `Gfx` was dropped first. Holding this makes the drop order irrelevant: the EGL context
/// can't be torn down while a source still owns objects in it.
#[derive(Clone)]
pub struct GlKeepAlive {
    shared: Rc<Shared>,
    delete_textures: Option<unsafe extern "system" fn(i32, *const u32)>,
    delete_framebuffers: Option<unsafe extern "system" fn(i32, *const u32)>,
}

/// While alive, the [`GlKeepAlive`]'s context is current on this thread; on drop, whatever
/// was current before [`GlKeepAlive::make_current`] is restored (nothing changes at all
/// in the common case where the context was already current).
pub struct CurrentGuard<'a> {
    keep: &'a GlKeepAlive,
    /// `Some(prev)` only if `make_current` actually switched contexts; `prev` is the
    /// previously-current `(display, context, draw, read)`, or `None` if nothing was.
    #[allow(clippy::type_complexity)]
    restore: Option<
        Option<(
            egl::Display,
            Option<egl::Context>,
            Option<egl::Surface>,
            Option<egl::Surface>,
        )>,
    >,
    ok: bool,
}

impl CurrentGuard<'_> {
    /// Whether the context is actually current (false only if `eglMakeCurrent` failed —
    /// callers then skip GL calls rather than issue them against the wrong context).
    pub fn is_current(&self) -> bool {
        self.ok
    }
}

impl Drop for CurrentGuard<'_> {
    fn drop(&mut self) {
        let Some(prev) = self.restore.take() else {
            return;
        };
        let egl = &self.keep.shared.egl;
        let _ = match prev {
            Some((d, c, draw, read)) => egl.make_current(d, draw, read, c),
            None => egl.make_current(self.keep.shared.display, None, None, None),
        };
    }
}

impl GlKeepAlive {
    /// Make this context current (surfaceless if it wasn't already current with a surface)
    /// until the returned guard drops.
    pub fn make_current(&self) -> CurrentGuard<'_> {
        let egl = &self.shared.egl;
        if egl.get_current_context() == Some(self.shared.context) {
            return CurrentGuard {
                keep: self,
                restore: None,
                ok: true,
            };
        }
        let prev = egl.get_current_display().map(|d| {
            (
                d,
                egl.get_current_context(),
                egl.get_current_surface(egl::DRAW),
                egl.get_current_surface(egl::READ),
            )
        });
        let ok = egl
            .make_current(self.shared.display, None, None, Some(self.shared.context))
            .is_ok();
        CurrentGuard {
            keep: self,
            restore: Some(prev),
            ok,
        }
    }

    /// Whether `gfx` is the very context this keep-alive belongs to (same `Shared`). A
    /// source must only ever render through the context it was created on — rendering
    /// libmpv through another one is undefined behaviour (`render.h`).
    pub fn is_for(&self, gfx: &Gfx) -> bool {
        Rc::ptr_eq(&self.shared, &gfx.shared)
    }

    /// `glDeleteTextures` on `tex`. Call only while a [`CurrentGuard`] is current.
    pub fn delete_texture(&self, tex: &super::Tex) {
        if let Some(f) = self.delete_textures {
            let id = tex.id.0.get();
            unsafe { f(1, &id) };
        }
    }

    /// `glDeleteFramebuffers` on `fbo`. Call only while a [`CurrentGuard`] is current.
    pub fn delete_fbo(&self, fbo: &super::Fbo) {
        if let Some(f) = self.delete_framebuffers {
            let id = fbo.id.0.get();
            unsafe { f(1, &id) };
        }
    }
}

impl Gfx {
    /// A [`GlKeepAlive`] for this `Gfx`'s context (see there).
    pub fn keep_alive(&self) -> GlKeepAlive {
        let egl = &self.shared.egl;
        // SAFETY: both are core GL 1.1/3.0 entry points with exactly these signatures.
        let load = |name: &str| {
            egl.get_proc_address(name).map(|f| unsafe {
                std::mem::transmute::<
                    extern "system" fn(),
                    unsafe extern "system" fn(i32, *const u32),
                >(f)
            })
        };
        GlKeepAlive {
            shared: Rc::clone(&self.shared),
            delete_textures: load("glDeleteTextures"),
            delete_framebuffers: load("glDeleteFramebuffers"),
        }
    }

    /// Phase 2 (render worker): a second desktop-GL 3.3 core context in **this** context's
    /// share group — same `EGLDisplay` (one per process: NVIDIA, § GFX / EGL; the display's
    /// user count goes up, so `eglTerminate` waits for it too), same config,
    /// `share_context` = this one — for another thread to make current **surfaceless**
    /// ([`SharedContext::make_current`]). Textures and sync objects made in either context
    /// are visible to both; FBOs/VAOs (container objects) are not. Created here on the
    /// owner's thread, then moved to the thread that uses it.
    pub fn share_context(&self) -> Result<SharedContext, String> {
        let egl = load_egl()?;
        let display = self.shared.display;
        let display_ext = egl
            .query_string(Some(display), egl::EXTENSIONS)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !has_ext(&display_ext, "EGL_KHR_surfaceless_context") {
            return Err(format!(
                "EGL_KHR_surfaceless_context missing on display ({}); a render worker needs it",
                self.path
            ));
        }
        egl.bind_api(egl::OPENGL_API)
            .map_err(|e| format!("eglBindAPI(EGL_OPENGL_API) failed: {e}"))?;
        let attribs = [
            egl::CONTEXT_MAJOR_VERSION,
            3,
            egl::CONTEXT_MINOR_VERSION,
            3,
            egl::CONTEXT_OPENGL_PROFILE_MASK,
            egl::CONTEXT_OPENGL_CORE_PROFILE_BIT,
            egl::NONE,
        ];
        let context = egl
            .create_context(display, self.config, Some(self.shared.context), &attribs)
            .map_err(|e| format!("eglCreateContext (shared, desktop GL 3.3 core) failed: {e}"))?;
        display_acquire(display);
        Ok(SharedContext {
            egl,
            display,
            context,
        })
    }
}

/// A context in another [`Gfx`]'s share group ([`Gfx::share_context`]) for a worker thread:
/// made current there surfaceless for the thread's life. `Drop` (on that thread) unbinds it
/// if current, destroys it and releases the display (terminating it if this was its last
/// user — `display_release`).
pub struct SharedContext {
    egl: EglInstance,
    display: egl::Display,
    context: egl::Context,
}

// SAFETY: an EGL context may be created on one thread and made current on another, as long
// as it is never current on two threads at once. A `SharedContext` is created on the owner's
// thread, moved once to its worker thread and only ever made current (and destroyed) there.
unsafe impl Send for SharedContext {}

impl SharedContext {
    /// `eglMakeCurrent(display, NO_SURFACE, NO_SURFACE, context)` on the calling thread.
    pub fn make_current(&self) -> Result<(), String> {
        self.egl
            .make_current(self.display, None, None, Some(self.context))
            .map_err(|e| format!("eglMakeCurrent (shared, surfaceless) failed: {e}"))
    }

    /// A glow context loaded through `eglGetProcAddress` — the worker's own GL loader (real
    /// `glFenceSync`, never libmpv's stubbed table). Call with this context current.
    pub fn load_gl(&self) -> glow::Context {
        load_gl(&self.egl)
    }
}

impl Drop for SharedContext {
    fn drop(&mut self) {
        if self.egl.get_current_context() == Some(self.context) {
            let _ = self.egl.make_current(self.display, None, None, None);
        }
        let _ = self.egl.destroy_context(self.display, self.context);
        let _life = display_lifecycle();
        if display_release(self.display) {
            let _ = self.egl.terminate(self.display);
        }
    }
}

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

/// Hand back the statically-linked EGL 1.5 API. Infallible (the `Result` is kept purely
/// so every call site uses the same `let egl = load_egl()?;` shape as every other
/// fallible step in [`Gfx::new_offscreen`]/[`Gfx::new_wayland`]) — with `static` linking,
/// a missing `libEGL` would fail the dynamic linker before `main` ever runs, not show up
/// here as a value to handle.
fn load_egl() -> Result<EglInstance, String> {
    Ok(egl::Instance::new(egl::Static))
}

/// `true` iff `ext` appears as a whole, space-separated token in `list` — the standard EGL/
/// GL extension-string contract (substring matches are wrong: `"EGL_FOO"` must not match a
/// query for `"EGL_FO"`).
fn has_ext(list: &str, ext: &str) -> bool {
    list.split_whitespace().any(|tok| tok == ext)
}

/// Implements the brief's exact fallback order. See [`Gfx::new_offscreen`]'s doc comment.
fn pick_offscreen_display(
    egl: &EglInstance,
    client_ext: &str,
) -> Result<(egl::Display, String), String> {
    if has_ext(client_ext, "EGL_MESA_platform_surfaceless")
        && let Ok(display) =
            get_platform_display_ext(egl, PLATFORM_SURFACELESS_MESA, ptr::null_mut())
        && egl.initialize(display).is_ok()
    {
        return Ok((display, "EGL_PLATFORM_SURFACELESS_MESA".to_string()));
    }

    if has_ext(client_ext, "EGL_EXT_platform_device") {
        let devices = query_devices_ext(egl)?;
        let n = devices.len();
        for (i, device) in devices.into_iter().enumerate() {
            let dev_ext = query_device_string_ext(egl, device, egl::EXTENSIONS);
            // Rank a software-only device behind every other candidate, same as the spike:
            // skip it unless it's the last (and therefore only remaining) option.
            if has_ext(&dev_ext, "EGL_MESA_device_software") && i + 1 < n {
                continue;
            }
            if let Ok(display) = get_platform_display_ext(egl, PLATFORM_DEVICE_EXT, device)
                && egl.initialize(display).is_ok()
            {
                return Ok((display, format!("EGL_PLATFORM_DEVICE_EXT (device {i})")));
            }
        }
    }

    Err(
        "no surfaceless EGL display available (neither EGL_MESA_platform_surfaceless nor \
         EGL_EXT_platform_device produced a display that would initialize)"
            .to_string(),
    )
}

/// `eglGetPlatformDisplayEXT` (`EGL_EXT_platform_base`), called directly through a raw
/// function pointer rather than `khronos-egl`'s core `get_platform_display`.
///
/// **Why not the core function.** EGL 1.5 standardizes `eglGetPlatformDisplay` (no `EXT`
/// suffix) to work with any platform enum, core or extension. Measured on this machine
/// (glvnd 1.7.0 + NVIDIA 595.84): calling the *core* entry point with the Mesa-defined
/// `EGL_PLATFORM_SURFACELESS_MESA` token returns `EGL_BAD_PARAMETER` even though that
/// token is listed in the client extension string — glvnd's core dispatch only recognizes
/// platform tokens from a fixed set of KHR-registered platforms, not vendor/MESA ones. The
/// `EXT`-suffixed entry point (which predates EGL 1.5 and is what `EGL_EXT_platform_base`
/// and `EGL_MESA_platform_surfaceless` actually define) does not have this restriction and
/// is what `spikes/lwe-core/host.cpp`'s `egl_init` uses for exactly this reason. Mirrored
/// here for both offscreen paths and for `new_wayland`, rather than mixing core and EXT
/// calls depending on which platform token happens to work through which entry point.
fn get_platform_display_ext(
    egl: &EglInstance,
    platform: egl::Enum,
    native_display: *mut c_void,
) -> Result<egl::Display, String> {
    type GetPlatformDisplayExtFn = unsafe extern "C" fn(
        platform: egl::Enum,
        native_display: *mut c_void,
        attrib_list: *const egl::Int,
    ) -> *mut c_void;

    let raw = egl
        .get_proc_address("eglGetPlatformDisplayEXT")
        .ok_or_else(|| {
            "eglGetPlatformDisplayEXT not available (EGL_EXT_platform_base missing)".to_string()
        })?;
    // SAFETY: see `query_devices_ext` — same ABI-compatibility argument.
    let get_platform_display_ext: GetPlatformDisplayExtFn = unsafe { std::mem::transmute(raw) };

    // SAFETY: `native_display` is whatever the caller already validated for the chosen
    // platform (a null `EGL_DEFAULT_DISPLAY`, an `EGLDeviceEXT` handle, or a `wl_display`
    // pointer); `attrib_list` is `NULL`, which this extension's spec defines as "no
    // attributes", same as `host.cpp`'s calls.
    let display_ptr = unsafe { get_platform_display_ext(platform, native_display, ptr::null()) };
    if display_ptr.is_null() {
        let err = egl
            .get_error()
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_string());
        Err(err)
    } else {
        // SAFETY: a non-null return from `eglGetPlatformDisplayEXT` is a valid `EGLDisplay`.
        Ok(unsafe { egl::Display::from_ptr(display_ptr) })
    }
}

/// `eglQueryDevicesEXT` (`EGL_EXT_device_base`/`EGL_EXT_device_enumeration`) — not in
/// `khronos-egl`'s core API, fetched by name via `eglGetProcAddress` and called directly,
/// same as `spikes/lwe-core/host.cpp`'s `egl_init`.
fn query_devices_ext(egl: &EglInstance) -> Result<Vec<EglDeviceExt>, String> {
    type QueryDevicesExtFn = unsafe extern "C" fn(
        max_devices: egl::Int,
        devices: *mut EglDeviceExt,
        num_devices: *mut egl::Int,
    ) -> egl::Boolean;

    let raw = egl.get_proc_address("eglQueryDevicesEXT").ok_or_else(|| {
        "eglQueryDevicesEXT not available (EGL_EXT_device_enumeration missing)".to_string()
    })?;
    // SAFETY: `eglGetProcAddress` for a name advertised by `EGL_EXT_platform_device`'s
    // sibling extension is documented to return a pointer callable with that extension's
    // published C signature; `extern "system"` and `extern "C"` are the same ABI on Linux.
    let query_devices: QueryDevicesExtFn = unsafe { std::mem::transmute(raw) };

    const MAX_DEVICES: usize = 16;
    let mut devices: Vec<EglDeviceExt> = vec![ptr::null_mut(); MAX_DEVICES];
    let mut count: egl::Int = 0;
    // SAFETY: `devices` has capacity `MAX_DEVICES`, matching the `max_devices` argument.
    let ok = unsafe { query_devices(MAX_DEVICES as egl::Int, devices.as_mut_ptr(), &mut count) };
    if ok != egl::TRUE {
        return Err("eglQueryDevicesEXT failed".to_string());
    }
    devices.truncate(count.max(0) as usize);
    Ok(devices)
}

/// `eglQueryDeviceStringEXT`, same rationale as [`query_devices_ext`]. Returns `""` (never
/// an error) on any failure to load or call it — callers only use this to check extension
/// membership via [`has_ext`], and an empty string simply never matches.
fn query_device_string_ext(egl: &EglInstance, device: EglDeviceExt, name: egl::Int) -> String {
    type QueryDeviceStringExtFn =
        unsafe extern "C" fn(device: EglDeviceExt, name: egl::Int) -> *const c_char;

    let Some(raw) = egl.get_proc_address("eglQueryDeviceStringEXT") else {
        return String::new();
    };
    // SAFETY: see `query_devices_ext`.
    let query_device_string: QueryDeviceStringExtFn = unsafe { std::mem::transmute(raw) };
    // SAFETY: `device` came from a successful `eglQueryDevicesEXT` call using the same
    // loaded function table.
    let ptr = unsafe { query_device_string(device, name) };
    if ptr.is_null() {
        String::new()
    } else {
        // SAFETY: EGL guarantees a NUL-terminated string valid for the call's duration;
        // it's copied into an owned `String` before returning.
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned()
    }
}

/// `EGL_KHR_surfaceless_context` gate for the offscreen path — required so
/// `eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)` is legal at all. Checked
/// explicitly (rather than letting a missing-surface `eglMakeCurrent` fail opaquely) so a
/// misconfigured driver reports exactly what's missing.
fn require_surfaceless_context(
    egl: &EglInstance,
    display: egl::Display,
    path: &str,
) -> Result<(), String> {
    let display_ext = egl
        .query_string(Some(display), egl::EXTENSIONS)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if has_ext(&display_ext, "EGL_KHR_surfaceless_context") {
        Ok(())
    } else {
        Err(format!(
            "EGL_KHR_surfaceless_context missing on display ({path}); offscreen rendering requires it"
        ))
    }
}

/// Pick the first EGL config matching desktop-GL rendering with 8-bit RGBA and the given
/// `surface_type_bit` (`EGL_PBUFFER_BIT` for offscreen, `EGL_WINDOW_BIT` for a Wayland
/// window surface).
fn choose_config(
    egl: &EglInstance,
    display: egl::Display,
    surface_type_bit: egl::Int,
) -> Result<egl::Config, String> {
    let attribs = [
        egl::SURFACE_TYPE,
        surface_type_bit,
        egl::RENDERABLE_TYPE,
        egl::OPENGL_BIT,
        egl::RED_SIZE,
        8,
        egl::GREEN_SIZE,
        8,
        egl::BLUE_SIZE,
        8,
        egl::ALPHA_SIZE,
        8,
        egl::NONE,
    ];
    egl.choose_first_config(display, &attribs)
        .map_err(|e| format!("eglChooseConfig failed: {e}"))?
        .ok_or_else(|| "no matching EGL config (RGBA8, desktop GL)".to_string())
}

/// Request desktop OpenGL (`eglBindAPI(EGL_OPENGL_API)` — not OpenGL ES) and create a
/// core-profile 3.3 context. `EGL_CONTEXT_MAJOR_VERSION`/`MINOR_VERSION` 3/3 +
/// `EGL_CONTEXT_OPENGL_PROFILE_MASK` = `EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT`, matching the
/// Phase 0 spike's proven-working attribs exactly (`host.cpp`, `egl_init`).
fn create_core_3_3_context(
    egl: &EglInstance,
    display: egl::Display,
    config: egl::Config,
) -> Result<egl::Context, String> {
    egl.bind_api(egl::OPENGL_API)
        .map_err(|e| format!("eglBindAPI(EGL_OPENGL_API) failed: {e}"))?;

    let attribs = [
        egl::CONTEXT_MAJOR_VERSION,
        3,
        egl::CONTEXT_MINOR_VERSION,
        3,
        egl::CONTEXT_OPENGL_PROFILE_MASK,
        egl::CONTEXT_OPENGL_CORE_PROFILE_BIT,
        egl::NONE,
    ];
    egl.create_context(display, config, None, &attribs)
        .map_err(|e| format!("eglCreateContext (desktop GL 3.3 core) failed: {e}"))
}

/// [`create_core_3_3_context`], asking for `want` (if any) when the display has
/// `EGL_IMG_context_priority` (a refusal with the attribute falls back to none); returns the
/// granted level (`eglQueryContext`). An explicit request is logged as
/// `gfx.context_priority {requested, granted, path}`.
fn create_prioritized_context(
    egl: &EglInstance,
    display: egl::Display,
    config: egl::Config,
    want: Option<Priority>,
    robust: bool,
    path: &str,
) -> Result<(egl::Context, Option<Priority>), String> {
    let ext = egl
        .query_string(Some(display), egl::EXTENSIONS)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if robust {
        return create_robust_context(egl, display, config, want, &ext, path);
    }
    if !has_ext(&ext, "EGL_IMG_context_priority") {
        return Ok((create_core_3_3_context(egl, display, config)?, None));
    }
    let Some(want) = want else {
        let context = create_core_3_3_context(egl, display, config)?;
        let granted = egl
            .query_context(display, context, CONTEXT_PRIORITY_LEVEL_IMG)
            .ok()
            .and_then(Priority::from_egl);
        return Ok((context, granted));
    };
    egl.bind_api(egl::OPENGL_API)
        .map_err(|e| format!("eglBindAPI(EGL_OPENGL_API) failed: {e}"))?;
    let attribs = [
        egl::CONTEXT_MAJOR_VERSION,
        3,
        egl::CONTEXT_MINOR_VERSION,
        3,
        egl::CONTEXT_OPENGL_PROFILE_MASK,
        egl::CONTEXT_OPENGL_CORE_PROFILE_BIT,
        CONTEXT_PRIORITY_LEVEL_IMG,
        want.to_egl(),
        egl::NONE,
    ];
    let context = match egl.create_context(display, config, None, &attribs) {
        Ok(c) => c,
        Err(_) => create_core_3_3_context(egl, display, config)?,
    };
    let granted = egl
        .query_context(display, context, CONTEXT_PRIORITY_LEVEL_IMG)
        .ok()
        .and_then(Priority::from_egl);
    crate::log::event(
        "gfx",
        crate::log::Level::Info,
        "gfx.context_priority",
        None,
        serde_json::json!({"requested": want.name(), "granted": granted.map(|p| p.name()),
                           "path": path}),
    );
    Ok((context, granted))
}

/// The robustness attributes this display takes (empty = none it can grant): robust access +
/// `LOSE_CONTEXT_ON_RESET` through EGL 1.5 / `EGL_KHR_create_context`, else the `_EXT` tokens,
/// plus the NVIDIA video-memory-purge reset where listed.
fn robustness_attribs(egl: &EglInstance, display: egl::Display, ext: &str) -> Vec<egl::Int> {
    let version = egl
        .query_string(Some(display), egl::VERSION)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let v15 = version
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .and_then(|v| {
            let mut it = v.split('.');
            Some((it.next()?.parse::<u32>().ok()?, it.next()?.parse::<u32>().ok()?))
        })
        .is_some_and(|(maj, min)| (maj, min) >= (1, 5));
    let mut a = if v15 || has_ext(ext, "EGL_KHR_create_context") {
        vec![
            CONTEXT_OPENGL_ROBUST_ACCESS,
            egl::TRUE as egl::Int,
            CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY,
            LOSE_CONTEXT_ON_RESET,
        ]
    } else if has_ext(ext, "EGL_EXT_create_context_robustness") {
        vec![
            CONTEXT_OPENGL_ROBUST_ACCESS_EXT,
            egl::TRUE as egl::Int,
            CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT,
            LOSE_CONTEXT_ON_RESET,
        ]
    } else {
        return Vec::new();
    };
    if has_ext(ext, "EGL_NV_robustness_video_memory_purge") {
        a.extend([GENERATE_RESET_ON_VIDEO_MEMORY_PURGE_NV, egl::TRUE as egl::Int]);
    }
    a
}

/// [`create_prioritized_context`] with the robustness attributes (Task 10, the scene worker):
/// tried with the priority, then robust without the NV purge reset, then without robustness
/// (the plain priority path) — a driver that refuses any of it still gets a context.
/// `gfx.context_robust {requested, attribs, granted_attribs, path}` (info).
fn create_robust_context(
    egl: &EglInstance,
    display: egl::Display,
    config: egl::Config,
    want: Option<Priority>,
    ext: &str,
    path: &str,
) -> Result<(egl::Context, Option<Priority>), String> {
    let prio_ext = has_ext(ext, "EGL_IMG_context_priority");
    let robust = robustness_attribs(egl, display, ext);
    egl.bind_api(egl::OPENGL_API)
        .map_err(|e| format!("eglBindAPI(EGL_OPENGL_API) failed: {e}"))?;
    let attempt = |extra: &[egl::Int]| {
        let mut a = vec![
            egl::CONTEXT_MAJOR_VERSION,
            3,
            egl::CONTEXT_MINOR_VERSION,
            3,
            egl::CONTEXT_OPENGL_PROFILE_MASK,
            egl::CONTEXT_OPENGL_CORE_PROFILE_BIT,
        ];
        if let Some(w) = want.filter(|_| prio_ext) {
            a.extend([CONTEXT_PRIORITY_LEVEL_IMG, w.to_egl()]);
        }
        a.extend_from_slice(extra);
        a.push(egl::NONE);
        egl.create_context(display, config, None, &a).ok()
    };
    // The NV purge pair is the last two entries when present.
    let without_purge = if robust.len() > 4 { &robust[..4] } else { &robust[..] };
    let mut granted_attribs = "none";
    let mut context = None;
    if !robust.is_empty() {
        context = attempt(&robust).map(|c| {
            granted_attribs = "all";
            c
        });
        if context.is_none() && robust.len() > 4 {
            context = attempt(without_purge).map(|c| {
                granted_attribs = "no_purge";
                c
            });
        }
    }
    let context = match context.or_else(|| attempt(&[])) {
        Some(c) => c,
        None => create_core_3_3_context(egl, display, config)?,
    };
    let granted = if prio_ext {
        egl.query_context(display, context, CONTEXT_PRIORITY_LEVEL_IMG)
            .ok()
            .and_then(Priority::from_egl)
    } else {
        None
    };
    crate::log::event(
        "gfx",
        crate::log::Level::Info,
        "gfx.context_robust",
        None,
        serde_json::json!({"requested": want.map(|p| p.name()),
                           "granted": granted.map(|p| p.name()),
                           "attribs": robust.len() / 2, "granted_attribs": granted_attribs,
                           "path": path}),
    );
    Ok((context, granted))
}

/// Load every GL entry point through `eglGetProcAddress`, using the context that's already
/// current on this thread (`glow::Context::from_loader_function` reads `GL_VERSION`
/// immediately, which panics if no context is current — callers must `make_current` first).
fn load_gl(egl: &EglInstance) -> glow::Context {
    unsafe {
        glow::Context::from_loader_function(|name| {
            egl.get_proc_address(name)
                .map_or(ptr::null(), |f| f as *const c_void)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Covers the reviewed finding: `WindowTarget` must keep `Gfx`'s EGL display/context
    /// alive by holding a real `Rc<Shared>` clone, not a borrow or a copied `Display`
    /// value, so dropping the `Gfx` first never tears down a display a `WindowTarget`
    /// still needs. `WindowTarget` itself needs a real `wl_surface` to construct (not
    /// available in a unit test — same reasoning as every other test touching the
    /// Wayland path, R16), so this test exercises the ownership mechanism `WindowTarget`
    /// relies on directly: clone `Gfx`'s `shared` field exactly as `window_target` does,
    /// drop the `Gfx`, and prove the shared EGL display is still genuinely usable through
    /// the surviving clone — not merely that `Rc::strong_count` arithmetic looks right.
    #[test]
    fn shared_egl_state_outlives_gfx_when_another_clone_exists() {
        let gfx = match Gfx::new_offscreen() {
            Ok(gfx) => gfx,
            // `LP_REQUIRE_GPU` (same rule as `tests/common::skip_gpu`): a run that must
            // have a GPU fails instead of skipping.
            Err(e)
                if std::env::var_os("LP_REQUIRE_GPU")
                    .is_some_and(|v| !v.is_empty() && v != "0") =>
            {
                panic!("LP_REQUIRE_GPU is set but a GPU test would skip: no EGL device ({e})")
            }
            Err(_) => {
                println!("SKIP: no EGL device");
                return;
            }
        };

        SHARED_DROP_COUNT.with(|c| c.set(0));

        // What `WindowTarget::shared` holds after `window_target()` returns.
        let kept_alive = gfx.shared.clone();
        assert_eq!(
            Rc::strong_count(&kept_alive),
            2,
            "gfx and kept_alive must both hold the shared EGL state before gfx drops"
        );

        drop(gfx);

        assert_eq!(
            Rc::strong_count(&kept_alive),
            1,
            "dropping gfx must release its own strong reference, and only its own"
        );
        // The actual regression this covers: if `WindowTarget` only copied the `Display`
        // value instead of cloning the `Rc<Shared>`, dropping `gfx` here would have run
        // `Shared::drop` (eglMakeCurrent-none / eglDestroyContext / eglTerminate)
        // immediately, even though `kept_alive` — standing in for a live `WindowTarget` —
        // still needs that display. Counting `Shared::drop` runs (rather than probing
        // EGL's own post-teardown behaviour — observed directly to be unreliable here:
        // `eglQueryString` kept succeeding on this driver even after a manual, out-of-band
        // `eglTerminate`) is what makes this a real, deterministic regression test.
        assert_eq!(
            SHARED_DROP_COUNT.with(|c| c.get()),
            0,
            "Shared::drop must not run while kept_alive still holds a reference"
        );
        // Secondary, real-world sanity check: the display is still usable too.
        assert!(
            kept_alive
                .egl
                .query_string(Some(kept_alive.display), egl::EXTENSIONS)
                .is_ok(),
            "display must still be initialized while a strong reference survives Gfx's drop"
        );

        // Last reference: `Shared::drop` must run here, exactly once.
        drop(kept_alive);
        assert_eq!(
            SHARED_DROP_COUNT.with(|c| c.get()),
            1,
            "Shared::drop must run exactly once, when the last reference goes"
        );
    }
}
