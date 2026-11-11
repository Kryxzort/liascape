---
paths:
  - "src/player/src/gfx/**"
  - "src/player/src/wl.rs"
  - "src/player/src/redraw.rs"
  - "src/player/src/headless.rs"
  - "src/player/src/probe/frames.rs"
  - "src/player/src/api/capture.rs"
  - "src/player/tests/gfx_basic.rs"
  - "src/player/tests/compose.rs"
  - "src/player/tests/effects_all.rs"
  - "src/player/tests/common/mod.rs"
  - "src/player/tests/onmachine/outputs.sh"
---

# liascape-player: EGL, GL and the Wayland backend

Crate-wide rules (effects, composition, the graph) are in `.claude/rules/player/core.md`. Walkthroughs and
measurements: `docs/player/modules/gfx-egl.md`, `docs/player/modules/wayland.md`.

## EGL ownership (`src/player/src/gfx/egl.rs`)
- Share EGL teardown through `Rc<Shared>`: `Gfx`, every `WindowTarget` and every `GlKeepAlive` hold a clone, and
  only the last drop tears down. Never hand out a `&Gfx`-tied borrow or a copied `Display` — dropping `Gfx` first
  would `eglTerminate` under a live surface (UB).
- There is one `EGLDisplay` per process and `eglInitialize` is not refcounted: keep `display_acquire`/
  `display_release` and terminate only for the last user; unbind a context only if it is the current one. Guard
  `src/player/tests/gfx_basic.rs` `two_gfx_on_one_display_survive_each_others_drop`.
- Fetch `eglGetPlatformDisplayEXT` by name; never use `khronos-egl`'s core `get_platform_display` — glvnd's core
  dispatch rejects `EGL_PLATFORM_SURFACELESS_MESA` with `EGL_BAD_PARAMETER`.
- Display order for offscreen: surfaceless Mesa platform first, then `EGL_EXT_platform_device` (software devices
  last). Check `EGL_KHR_surfaceless_context` by name before a surfaceless `eglMakeCurrent`.
- Keep `khronos-egl`'s `static` feature: `dynamic` can't find `libEGL` under the nix devShell (no rpath). A missing
  `libEGL` therefore fails in the dynamic linker; every later failure must stay a clean `Err`, never a panic.
- A second context (`Gfx::share_context`, the render worker's lanes) must be on the same `EGLDisplay` and config.
- Make every GL call on the loop's context. A shared context made current on another thread stalls the loop on
  NVIDIA's process-wide lock at its first `eglMakeCurrent`; the render worker pays that once at startup only.

## GL helpers (`src/player/src/gfx/gl.rs`)
- `Gfx::tex` is RGBA8, LINEAR, CLAMP_TO_EDGE with no per-call knobs; `Gfx::fbo` panics on an incomplete attachment
  (a programming error).
- Reuse `Gfx::empty_vao` for fullscreen-triangle draws (core profile needs a bound VAO).
- `tests/common::read_rgba` is GL bottom-left origin and never flipped; `Gfx::write_png` flips to top-down PNG
  order; `write_png_source` writes a raw source texture (already image-top at row 0) without a flip. Never re-flip
  what the other already flipped.
- Encode PNGs with fdeflate `Compression::Fast`. Guard `src/player/tests/gfx_basic.rs`
  `write_png_is_fast_enough_for_the_loop`.

## Capture (`src/player/src/api/capture.rs`)
- Never read back synchronously on the loop for `capture`: `Gfx::start_read_back` (PBO + fence + flush), poll with
  `Gfx::map_read_back` (timeout 0) after every dispatch and on a 1 ms timer, encode on `lia-capture`, unmap on the
  loop with its own context (`Gfx::end_read_back`). Keep one spare PBO per size (`SPARE_IDLE`).
- The capture reply is deferred and per-client FIFO, like `step`'s. `quit` finishes every capture in flight
  (`Capturer::shutdown`). `write_png` / `write_png_source` stay synchronous for tests and `--lwe-smoke`.
- Guard `src/player/tests/api.rs` `capture_encodes_off_the_loop`.

## GPU tests
- Route every GPU precondition through `tests/common::skip_gpu` (via `headless_gl` / `catalogue_dir`): unset prints
  `SKIP:` and returns; `LIASCAPE_REQUIRE_GPU=1` panics instead. Never add a GPU test that skips on its own. Guard
  `src/player/tests/gfx_basic.rs` `require_gpu_turns_a_missing_gpu_into_a_failure`.
- Not GPU preconditions, not routed through it: the opt-in Wayland test (`LIASCAPE_PLAYER_TEST_WAYLAND`), private
  PipeWire binaries, ffmpeg (`ensure_clip` panics without it).
- `SKIP: no EGL device` on a machine with a GPU is a real `Gfx::new_offscreen` failure — read its error, don't
  reach for environment variables.

## Wayland backend (`src/player/src/wl.rs`)
- sctk handlers only record (outputs, configures, frame callbacks, pointer); GPU work and graph changes run after
  the dispatch (`apply_output_changes`, `pointer_events`, `render_paced`).
- One EGL context serves every output and every source (`Gfx::new_wayland`).
- Ignore Hyprland's headless `FALLBACK` output (`wl::is_placeholder_output`) so the player parks.
- A missing `zwlr_layer_shell_v1` is an `Err` naming the compositors that have it and `--headless`.
- One layer surface per `wl_output`: namespace `liascape-player`, all edges anchored, exclusive zone −1, no
  keyboard, opaque region = the whole surface. Fractional scale renders at the ceiling integer scale.
- `out:<c>.layer` is live: `set_layer` + commit on layer-shell v2+ with a mapped surface; otherwise re-create the
  surface on the new layer (a `set_layer` before mapping is lost on Hyprland).
- A re-plugged connector gets its remembered output props back. Guard `src/player/tests/supervise.rs`
  `output_props_survive_replug`.

## Present
- In `present`: make the window current, disable scissor, full viewport, `glDrawBuffer(GL_BACK)` every time, blit
  the FBO, clear alpha only to 1, request the frame callback, then `eglSwapBuffers`. Surfaceless-first contexts
  start with draw buffer `GL_NONE`, so skipping `glDrawBuffer` silently drops every write.
- Request the frame callback before the swap (it rides on the swap's commit). A failed swap leaves it armed
  (`frame_armed`): never request a second; set `frame_pending` only after a successful swap.
- Back off failed presents (`present_backoff`) and log `output.present_failed` rate-limited.
- On resize make the window's context current before re-creating the FBO; on failure keep the old targets.
- Use swap interval 0 on every window — interval 1 blocks the single loop thread and drags other outputs down.
- Terminate `eglCreatePlatformWindowSurface`'s attrib list with `ATTRIB_NONE`; an empty slice is
  `EGL_BAD_PARAMETER`.
- Alpha is forced to 1 at present (the EGL config is ARGB) so the compositor never blends what's behind.
- Every present is full damage; there is no buffer-age path.

## NVIDIA explicit sync and the default queue
- `wl::apply_driver_env` (first thing in `serve`, Wayland only, before any thread) sets
  `__NV_DISABLE_EXPLICIT_SYNC=1` unless the caller set it — egl-wayland2 ≤ 1.0.2 otherwise leaks one queued
  `wl_closure` per present. A caller's value wins.
- `Wayland::dispatch_default_queue` runs every loop iteration (step 0 of `process`): EGL's proxies live on
  libwayland's default queue, which wayland-rs never dispatches. Keep both parts.
- Guard `src/player/tests/api.rs` `t20e_wayland_present_heap_stays_flat` (opt-in, `LIASCAPE_PLAYER_TEST_WAYLAND`).

## Redraw policy (`src/player/src/redraw.rs`)
- Every output presents on its own frame callbacks; nothing waits on another output.
- Draw an output only if, since its last present, `picture_rev` moved, an animated value changed on a node it shows
  (`Redraw::mark_nodes`), a shown source has a new texture, the backend asked, or something non-gain animates on
  it (`animating_on`, then every callback). An animation on one output never wakes another.
- Otherwise the output is idle: no draw, no callback request.
- `shown_nodes` per output come from the `redraw::Routes` cache, rebuilt only when `Graph::demand_rev` moves; never
  re-derive from the graph per wake.
- Headless composes every tick unless `--redraw-policy content`. Guard `src/player/tests/api.rs`
  `mixed_content_static_output_stays_idle`.
- Keep the animator tick timer running when idle (decided): stopping it would need every start/phase/step/stop
  path to re-arm it.

## Hotplug and pointer
- A removed output's GPU side goes to a dead list, freed in `process` with the context current surfaceless
  (`Gfx::make_current_surfaceless`), window target before its `wl_surface` (field order `gl` then `surface`).
- Wayland hotplug runs the same add/remove path as headless hotplug in the runtime (adopt into a live transition,
  else the same wallpaper as the first output, else unpark; retire/park on remove), plus `redraw.forget`.
- A `closed` layer surface whose output remains is re-created (`wl.surface_recreated`).
- Pointer samples only `set_observed` `out:<c>.pointer` — never a picture change; motion logs are rate-limited.

## Seam probe (`src/player/src/probe/frames.rs`)
- Count `Composer::last_missing` per output in both render paths (`note_composed`); never clear `last_seam` on
  `reset`. Guard unit `seam_runs_count_frames_and_edges`.

## On-machine check (`src/player/tests/onmachine/outputs.sh`)
- Run it manually (exit 0 = pass). It uses a private `XDG_RUNTIME_DIR`/`XDG_STATE_HOME` and an absolute
  `WAYLAND_DISPLAY`, runs under `prlimit --core=1:1`, and its `EXIT` trap restores monitors, cursor and workspaces.
- On a Lua-config Hyprland use `hyprctl eval` (`keyword` is refused) and re-enable with an explicit
  `disabled = false` and the recorded mode — never `preferred,auto`.
- Keep socket paths under 108 bytes (`mktemp` in `$TMPDIR`/`/tmp`).
