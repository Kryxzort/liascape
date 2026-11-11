<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## GFX / EGL

`src/gfx/egl.rs` + `src/gfx/gl.rs` (spec §5.1 "Graphics"): desktop OpenGL (core profile)
via EGL — chosen so the compositor can host LWE core if ever needed, since LWE core
renders with desktop GL loaded through glad (`docs/player/spikes/lwe-core.md` §2). `Gfx`
owns the EGL display + context and the `glow::Context` loaded through it; `Gfx::new_offscreen`
builds a surfaceless one (used by every GPU test today), `Gfx::new_wayland` +
`Gfx::window_target` build a real one on a `wl_surface` (first exercised by Task 13's
Wayland backend — two latent bugs found then, see § Wayland → NVIDIA/EGL notes).
`Gfx::make_current_surfaceless` and `WindowTarget::set_swap_interval` (Task 13) are the
window path's two extra knobs.

**`Gfx` and `WindowTarget` share EGL teardown via `Rc<Shared>`, not a borrow.** `Shared`
(private, `egl.rs`) holds the EGL instance + `Display` + `Context` and is the one thing
whose `Drop` actually tears EGL down (`eglMakeCurrent(none)` → `eglDestroyContext` →
`eglTerminate`). `Gfx::window_target` clones `self.shared` into the `WindowTarget` it
returns, rather than handing back a `&'a Gfx`-tied borrow — a borrow would force a
self-referential struct the moment the runtime stores one `Gfx` and its live
`WindowTarget` side by side per output, which is exactly how it's used. This means
`Shared::drop` runs exactly once, whenever the *last* clone goes away, regardless of
whether the `Gfx` or the `WindowTarget` is dropped first. **Reviewed finding this
replaced:** an earlier version put `display`/`context` directly on `Gfx` with its own
eager `Drop`, while `WindowTarget` kept only a *copy* of the `Display` value and a
separately-`Rc`'d EGL instance — nothing kept the owning `Gfx` alive, so dropping it
first `eglTerminate`d the display while a `WindowTarget` about to call
`eglDestroySurface` on it was still around: undefined behaviour. `gfx::GlKeepAlive` (`Gfx::keep_alive()`, Task 10) is a
third holder of the same `Rc<Shared>`, for sources that must free GL objects in `Drop`
(§ Sources).

**One `EGLDisplay` per process, refcounted terminate.** Every surfaceless `Gfx` gets the
*same* `EGLDisplay` (`EGL_DEFAULT_DISPLAY` on one platform) and `eglInitialize` isn't
reference-counted (EGL 1.5), so `Shared::drop` keeps a process-wide per-display user count
(`display_acquire`/`display_release`) and calls `eglTerminate` only for the last user; it
also only unbinds the context if *its own* context is the current one. Found in Task 10's
fix round: the old unconditional terminate destroyed every other `Gfx`'s non-current
context and made later `eglMakeCurrent` fail with `EGL_NOT_INITIALIZED` — invisible until
a source first switched contexts with a second `Gfx` alive (and a latent race between
parallel GPU tests). Pinned by `tests/gfx_basic.rs::two_gfx_on_one_display_survive_each_others_drop`. `make_current`/`swap`
still take `gfx: &Gfx` (API shape unchanged) and read `gfx.shared.{egl,context}` — a
`WindowTarget` created from a *different* `Gfx` would mismatch display/context and EGL
itself rejects that, same as before.

**Display-selection order** (`Gfx::new_offscreen`, mirrors `spikes/lwe-core/host.cpp`'s
`egl_init`, proven on this machine's NVIDIA 595.84):

1. `EGL_PLATFORM_SURFACELESS_MESA` (`EGL_DEFAULT_DISPLAY` native handle) — present on this
   driver through glvnd, and the one that actually works here.
2. Else `EGL_EXT_platform_device`: enumerate devices via `eglQueryDevicesEXT`, skip a
   device exposing only `EGL_MESA_device_software` unless it's the last one, try each
   until `eglGetPlatformDisplayEXT` + `eglInitialize` both succeed.

Both steps go through **`eglGetPlatformDisplayEXT`, fetched by name via
`eglGetProcAddress`, not `khronos-egl`'s core `get_platform_display`.** Measured on this
machine (glvnd 1.7.0 + NVIDIA 595.84): the *core* EGL 1.5 entry point returns
`EGL_BAD_PARAMETER` for the Mesa-defined `EGL_PLATFORM_SURFACELESS_MESA` token even though
that token is listed in the client extension string — glvnd's core dispatch only
recognizes a fixed set of KHR-registered platforms. The `EXT`-suffixed entry point (what
`EGL_EXT_platform_base`/`EGL_MESA_platform_surfaceless` actually define, and what
`host.cpp`'s spike uses) doesn't have this restriction. `Gfx::new_wayland` uses the same
`EXT` call for consistency, not because it needs to.

**Surfaceless requires `EGL_KHR_surfaceless_context`** on the chosen display (present on
NVIDIA) — checked explicitly before `eglMakeCurrent(…, EGL_NO_SURFACE, EGL_NO_SURFACE,
…)`, so a driver missing it reports exactly that by name instead of an opaque
`eglMakeCurrent` failure downstream.

**`khronos-egl`: `static` feature, not `dynamic` (deviation from the original call).**
`dynamic` (`dlopen("libEGL.so.1")` at runtime) was tried first, as the brief asked. It
failed under the documented build/test command (`env -u LD_LIBRARY_PATH nix develop -c
cargo test …`): a bare-name `dlopen` only searches a binary's RPATH/RUNPATH, `LD_LIBRARY_
PATH`, and the system cache, and nixpkgs' auto-rpath mechanism only rpaths a `-L` directory
that an actual link invocation used — an ambient `NIX_LDFLAGS` entry from a `buildInputs`
dev-shell package (`libGL`/libglvnd) never reaches the link line on its own. `static`
instead runs `khronos-egl`'s `build.rs`, which calls the `pkg-config` crate's
`probe("egl")` — the same mechanism `wayland-egl`/`wayland-sys` already use in this
dependency tree — which *does* emit real `cargo:rustc-link-lib=EGL` +
`cargo:rustc-link-search`, which *does* get auto-rpath'd. Net effect: `cargo test --test
gfx_basic` under the exact documented command needs no extra environment variables, on
this machine or (verified) inside `nix build .#liascape-player`'s sandboxed check phase.

**No build-time linking means no runtime graceful-failure path for "library missing"** —
with `static`, a system lacking `libEGL` entirely fails at the dynamic linker before
`main` runs, not as a `Result::Err` `Gfx::new_offscreen` could report. Every failure
*after* that point (no vendor ICD, no GPU, `eglInitialize` failing) is still a clean `Err`,
never a panic — this is the condition `tests/common::headless_gl` turns into a printed
`"SKIP: no EGL device"` plus a `return`, and it's what keeps a sandboxed `nix build`'s
check phase from failing over a missing `/dev/dri`.

**Texture defaults** (`Gfx::tex`): `GL_RGBA8`, `LINEAR` min/mag filtering, `CLAMP_TO_EDGE`
wrap on both axes — fixed, no per-call knobs. `Gfx::fbo` wraps a `Tex` at
`GL_COLOR_ATTACHMENT0` and panics on an incomplete attachment (a programming error, not a
recoverable runtime condition). `Gfx::empty_vao` is created once per `Gfx` and reused —
core profile requires some VAO bound even for a fullscreen-triangle draw built entirely
from `gl_VertexID` (Task 8's concern; this task only exposes the VAO so Task 8 doesn't
reinvent it).

**`read_rgba` origin: GL bottom-left.** `tests/common::read_rgba(gfx, tex, x, y)` reads
through `glReadPixels`, whose native coordinate system has `(0, 0)` at the texture's
*bottom-left* corner — the same convention `gl_FragCoord` uses. It is **not** flipped.
Every later task reading pixels back for assertions inherits this origin.

**`write_png_source(tex, path)`** (Task 12) is the same readback *without* the flip, for a
raw source texture (image top already at row 0, R25) — `capture` of a source is upright
too. **`Catalogue::empty()`** (Task 12): no effects (no `transitions/` resolved) — the
runtime still serves cuts.

**`write_png*` compress with fdeflate's `Compression::Fast`** (Task 13): when `capture` still wrote
on the loop, the default `Balanced` held it 820–875 ms for a 3840×1080 scene frame (release) —
every output froze; `Fast` 39–112 ms (now the reply's latency). Guard
`tests/gfx_basic.rs::write_png_is_fast_enough_for_the_loop` (readback + encode < 0.7 × a `Balanced`
encode alone on a noisy 1080p frame, pixels round-trip; RED with `Balanced`: 1845 vs 1923 ms in the
debug build; fixed it reads 0.45–0.51 × in a debug build — the old ½ bound failed about every other run).

**`capture` never stalls the loop (2026-10-28, `api/capture.rs`).** The handler only *starts* the
readback — `Gfx::start_read_back`: `glReadPixels` into a `GL_PIXEL_PACK_BUFFER` (`STREAM_READ`) + a
fence + `glFlush`; the GPU copies in command order, so the picture is the one at the request (stepped
captures stay deterministic). `Runtime::pump_captures` polls the fence (`Gfx::map_read_back`,
`client_wait_sync` timeout 0) after every dispatch and on a 1 ms calloop timer while one is on the
GPU (a stepped loop has no tick), maps the buffer and hands the mapping (`MappedPixels`, `Send`:
plain memory valid until unmapped) to the **`lia-capture`** thread (started with the first capture,
idle on its channel until shutdown), which flips/encodes/writes straight from it; the loop then
unmaps the buffer (`Gfx::end_read_back`, its own context, after the thread dropped its view), keeps
it as the **spare** for the next capture of that size (freed after `SPARE_IDLE` 10 s unused, or by a
capture of another size) and sends the reply (`finish_captures`, woken by a calloop ping). The reply
is deferred like `step`'s (`client.awaiting`; per-client FIFO — a request pipelined behind a capture
is answered after it). A thread that can't start → the encode runs on the loop (as before). `quit`
writes every capture in flight first (`Capturer::shutdown`: its GPU copy ≤ 1 s, then the encode).
`loop` probe `bounds.captures_in_flight`. `write_png` / `write_png_source` (tests, `--lwe-smoke`)
stay synchronous (`Gfx::read_back` + `Readback`). **Every GL call stays on the loop's context:** a
GPU copy read back on `lia-capture`'s own shared context (tried) stalled the loop 29–47 ms — the
NVIDIA driver's process-wide lock around a new context's first `eglMakeCurrent`. **Measured** (debug,
`--clock real`, a playing 1080p clip on a 3840×1080 output; the capture request / the loop's max
busy around it): before 810 ms; a synchronous readback alone 1.6–10 ms each time (the GPU wait + a
16 MB copy into fresh pages); now the **first** capture at a size 4.5–5.0 ms (3840×1080) / 0.5–0.9
ms (1920×1080) — the driver pins the new buffer's memory at its first `glReadPixels` (2.7–7.6 ms
for 16 MB, measured without the spare: every capture paid it) — and **every repeat 0.07–0.10 ms**
(loop max busy 0.3–1.2 ms, other work); the reply after 0.76–1.2 s (the debug encode). Guard
`tests/api.rs::capture_encodes_off_the_loop` (an output and a source, twice each: the capture's
request < 10 ms for a first capture at a size, < 1 ms for a repeat, the loop's longest stretch
around each < 10 ms — the loop's own debug ticks reach ~2 ms, so the request is the capture's
measure —, the PNG complete at the reply, a pipelined `probe` answered after it; RED before: 810
ms; a synchronous readback's repeats read 2.5–3.0).

**`write_png` orientation: top-down, flipped from GL's own order.** `Gfx::write_png` reads
the whole texture (bottom-left origin, same as `read_rgba`) and flips rows before encoding,
so row 0 of the PNG file is the *top* of the image — the standard convention every common
image viewer and format assumes. `read_rgba` and `write_png` therefore disagree about
orientation on purpose: one matches GL, the other matches PNG, and neither re-flips what
the other already flipped.

**Build note: no `LD_LIBRARY_PATH`.** Thanks to `static` linking (above), nothing in
`gfx/` needs `LD_LIBRARY_PATH` or `__EGL_VENDOR_LIBRARY_DIRS` set at build *or* test time —
the plain `env -u LD_LIBRARY_PATH nix develop -c cargo test …` from the global constraints
is sufficient. Don't reach for either env var to "fix" a `gfx` build/test problem; if
`cargo test --test gfx_basic` prints `"SKIP: no EGL device"` on a machine that does have a
GPU, that's a real `Gfx::new_offscreen` failure (check the error string it prints) — not a
missing environment variable.

**`LIASCAPE_REQUIRE_GPU=1` — a run that must have a GPU fails instead of skipping (TODO
"`LIASCAPE_REQUIRE_GPU` test mode").** Every GPU-test precondition goes through one helper,
`tests/common::skip_gpu(reason)`: unset (default — the `nix build` sandbox, a GPU-less dev box) it
prints `SKIP: <reason>` and the test returns (passes); set to anything but empty/`0` it **panics**
with `LIASCAPE_REQUIRE_GPU is set but a GPU test would skip: <reason>`. Its callers: `headless_gl` (no EGL
device) and `catalogue_dir` (no `transitions/` — decided: covered too, because nearly every GPU test
— `api`, `supervise`, `transition`, `compose`, `effects_all` — also needs the catalogue, so a GPU CI
without it would still skip almost everything silently), i.e. `api`/`supervise`'s `can_run`, the
transition `Harness`, `compose`/`effects_all`'s `setup`, `sources`, `gfx_basic`, and `t20e`'s catalogue
check; the one lib unit test needing EGL (`gfx::egl` `shared_egl_state_outlives_gfx_…`) applies the same
rule inline. **Not covered, on purpose** (not GPU preconditions): the opt-in Wayland test
(`LIASCAPE_PLAYER_TEST_WAYLAND`), `i7`'s private PipeWire binaries, `credits`' python3/repo, `dropout`'s
ffmpeg-less unit test; `ensure_clip` already panics without ffmpeg. **Measured** (a GPU-less machine
simulated with `__EGL_VENDOR_LIBRARY_FILENAMES=/nonexistent/…` — glvnd finds no driver, `new_offscreen`
fails exactly like on one): the whole suite passed in ~3 s with 133 `SKIP: no EGL device` lines; with
`LIASCAPE_REQUIRE_GPU=1` the same 133 tests fail (8 targets), everything else passes. Guard:
`tests/gfx_basic.rs::require_gpu_turns_a_missing_gpu_into_a_failure` (re-runs `clear_readback` in a
child with the vendor hidden: unset/`0`/empty → passes with `SKIP`, `1` → fails naming the reason;
RED with the pre-change binary: `LIASCAPE_REQUIRE_GPU=1` passed, 2/2 tests ok).
