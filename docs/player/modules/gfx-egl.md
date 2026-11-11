# GFX: EGL, GL helpers, capture

Covers `src/player/src/gfx/egl.rs`, `gfx/gl.rs` and `src/player/src/api/capture.rs`. Rules:
`.claude/rules/player/gfx-wayland.md` § EGL ownership, § GL helpers, § Capture, § GPU tests.

## Why desktop GL through EGL

The compositor uses desktop OpenGL (core profile) via EGL so it could host LWE's core, which renders desktop GL
through glad (`docs/player/spikes/lwe-core.md`). `Gfx` owns the display, the context and a `glow::Context`;
`Gfx::new_offscreen` makes a surfaceless one (tests, headless, scene workers), `Gfx::new_wayland` +
`Gfx::window_target` a real one on a `wl_surface`, `Gfx::share_context` a second context in the same share group
(the render worker's lanes).

## Ownership

`Shared` (the EGL instance, display, context) is the one thing whose `Drop` tears EGL down. `Gfx`, every
`WindowTarget` and every `GlKeepAlive` hold an `Rc<Shared>`, so teardown runs once, after the last holder, in any
drop order. A `&Gfx`-tied borrow would make the runtime's per-output `Gfx` + `WindowTarget` pair self-referential,
and a copied `Display` let a dropped `Gfx` `eglTerminate` under a live surface. `GlKeepAlive` exists for sources
that must free GL objects in `Drop` without a `&Gfx`.

Every surfaceless `Gfx` gets the same `EGLDisplay`, and `eglInitialize` isn't refcounted (EGL 1.5): `Shared`
keeps a per-display user count (`display_acquire`/`display_release`) and terminates for the last user only, and
unbinds a context only if it is the current one. An unconditional terminate destroyed every other `Gfx`'s
context, failing their next `eglMakeCurrent` with `EGL_NOT_INITIALIZED`.

## Display selection and linking

Offscreen tries `EGL_PLATFORM_SURFACELESS_MESA` first (works on NVIDIA through glvnd), then
`EGL_EXT_platform_device` devices, software-only devices last. Both go through `eglGetPlatformDisplayEXT`
fetched by name: glvnd's core `eglGetPlatformDisplay` dispatch knows only KHR-registered platforms and returns
`EGL_BAD_PARAMETER` for the Mesa surfaceless token. `EGL_KHR_surfaceless_context` is checked by name so a driver
lacking it says so.

`khronos-egl` uses its `static` feature: `dynamic` `dlopen`s a bare `libEGL.so.1`, which nix's auto-rpath doesn't
cover (only `-L` dirs a real link used get rpathed), while `static` runs pkg-config and emits a real link line
that does. So nothing needs `LD_LIBRARY_PATH` or `__EGL_VENDOR_LIBRARY_DIRS` at build or test time — in the
devShell or the `nix build` check phase. The cost: a system without `libEGL` fails in the dynamic linker before
`main`; every later failure (no ICD, no GPU, `eglInitialize`) is a clean `Err`, which tests turn into
`SKIP: no EGL device` (or a failure under `LIASCAPE_REQUIRE_GPU=1`).

## Orientation of read-backs

`tests/common::read_rgba` reads GL's bottom-left origin unflipped; `Gfx::write_png` flips to PNG's top-down
order; `write_png_source` writes a source texture (image top already at row 0) without a flip, so a source
capture is upright too.

## Capture off the loop

`capture` only starts a read-back on the loop: `glReadPixels` into a pixel-pack buffer, a fence, `glFlush`. The GPU
copies in command order, so the picture is the one at the request and stepped captures stay deterministic. The
loop polls the fence (timeout 0) after every dispatch and on a 1 ms timer, maps the buffer and hands the mapping to
`lia-capture`, which flips, encodes and writes; the loop unmaps it on its own context and keeps it as the spare for
that size (`SPARE_IDLE`, 10 s). The reply is deferred like `step`'s.

Every GL call stays on the loop's context: reading back on `lia-capture` through its own shared context stalled
the loop 29–47 ms at that context's first `eglMakeCurrent` (NVIDIA's process-wide lock). Measured on a 3840×1080
output (debug): the capture request costs the loop 4.5–5.0 ms the first time at a size (the driver pins the new
buffer's memory) and 0.07–0.10 ms for every repeat; a synchronous version held the loop ~810 ms including the PNG
encode. PNGs use fdeflate `Compression::Fast` (39–112 ms vs 820–875 ms for `Balanced` on a 3840×1080 frame).

## GPU tests

Every GPU precondition goes through `tests/common::skip_gpu` (via `headless_gl` and `catalogue_dir`): the
catalogue counts too, because nearly every GPU test also needs `transitions/`. On a machine without a GPU the
suite passes with SKIP lines; `LIASCAPE_REQUIRE_GPU=1` turns each into a failure naming the reason. Simulate a
GPU-less machine with `__EGL_VENDOR_LIBRARY_FILENAMES=/nonexistent` (glvnd then finds no driver).
