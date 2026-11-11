<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Wayland
`src/wl.rs` + `src/redraw.rs` + `src/probe/frames.rs` (spec §4.2 "Output", §5.1
"Graphics"; Task 13). `liascape-player serve` without `--headless` draws the wallpaper on every
monitor of `$WAYLAND_DISPLAY` (a `wlr-layer-shell` compositor: Hyprland, Sway, …).

**Hyprland's `FALLBACK` output is not an output** (`wl::is_placeholder_output`, Phase 3 Task 12): with every monitor
disabled Hyprland advertises a headless `FALLBACK` `wl_output` within ~100 ms. It is logged (`wl.placeholder_output`) and
ignored, so the player parks (R60) and `while_parked: hold` holds.

**Backend.** `Wayland::connect()` (sctk 0.21, `default-features = false, features =
["calloop"]` — no xkbcommon, a keyboard is never used) binds `wl_compositor`,
`zwlr_layer_shell_v1` (missing → `Err` naming the compositors that have it and
`--headless`), `wp_cursor_shape_manager_v1` (optional), `zwlr_foreign_toplevel_manager_v1`
(only as the cover fallback source, § Signals), sctk's `OutputState`/`SeatState`,
then does two roundtrips (output info → surfaces created; first configures). Then
`Gfx::new_wayland(display_ptr)` — **one EGL context for every output and every source**
(R17 `Rc<Shared>`; mpv renders through it as before). The event queue goes into the loop as
a `calloop_wayland_source::WaylandSource` (it flushes + `prepare_read`s before each sleep,
so events EGL's own queue reads off the socket are never stranded); its callback dispatches
into `Wayland::state` via `as_wayland_mut`, and `process` dispatches libwayland's default
queue — EGL's proxies — every iteration (Task 20e, NVIDIA notes below). **sctk handlers only record** (outputs,
configures, frame callbacks, pointer); GPU work and graph changes run after the dispatch:
`apply_output_changes` (`backend.process(gfx)` → hotplug), `pointer_events`, `render_paced`.

**One surface per `wl_output`** (`WlState::make_surface`):

| what | value |
|---|---|
| namespace | `liascape-player` (`hyprctl layers`) |
| layer | `out:<c>.layer` (`background` default, `bottom`, `top`, `overlay`) — **live**: `set_layer` + a bare commit (layer-shell v2+, surface mapped); on v1, or while the surface isn't mapped yet (no configure / no window target), the surface is **re-created** on the new layer — on Hyprland 0.56 a `set_layer` before mapping was lost (a re-plugged output's remembered layer stayed background; measured, Task 16) |
| anchor / size | all four edges, size 0×0 → the compositor's configure size (× integer `wl_output` scale via `set_buffer_scale`) |
| exclusive zone | −1 (covers the whole output, ignores bars' zones) |
| keyboard | none |
| input region | default = the whole surface (pointer accepted) |
| opaque region | the whole surface (every pixel is written with alpha 1) |

Names come from `wl_output` v4 `name` (`output_name`: `.`/`:`/`*`/spaces → `-`; none →
`WL-<global id>`); size = the current mode rotated by the transform (`oriented_dims`);
`refresh_hz` = the current mode's mHz rounded (`hz_from_mhz`: 143 981 → 144, 239 760 →
240, 0 → 60), `refresh_mhz` exact. A size from the first configure that differs (scale) →
`OutputChange::Changed`. Fractional scaling (`wp_fractional_scale_v1` + viewporter) is not
implemented: a fractional output renders at the ceiling integer scale (the owner's
outputs are scale 1). Pure mappings are unit-tested in `wl.rs`.

**Rendering + present.** Each output owns an offscreen RGBA8 texture + FBO (`target`:
`Composer::compose_output` draws there; also `picture` → `capture`) and a `WindowTarget`
(swap interval 0) built in `process(gfx)` once the surface is configured (resized in place
on a new size; a failed build isn't retried at the same size). `present`: make the window
current, disable scissor + full viewport (compose leaves them at its last sub-rect),
`glDrawBuffer(GL_BACK)`, blit FBO → back buffer, clear **alpha only** to 1 (the composite
is premultiplied over transparent black, so its RGB already is the picture over black),
request a frame callback, `eglSwapBuffers` (= attach + full damage + commit). The output
is `ready` (`FrameState`) again when that callback arrives.

**Failed presents (Task 16, review c).** `wl_surface.frame` is double-buffered state that
rides on the next commit, which `eglSwapBuffers` makes — so it has to be requested before
the swap. A swap that fails makes no commit and leaves that request pending: the output
keeps it **armed** (`WlOut::frame_armed`, cleared by the callback or a successful swap) and
never requests a second one; `frame_pending` is set only once a swap succeeded. A failed
present (`make_current` or swap) backs off — `present_backoff`: 100 ms after the first,
then 1 s while it keeps failing (`frame_state.ready` is false meanwhile, `retry_in_ms`) —
and is logged rate-limited (`output.present_failed`, ≤ 1 per 5 s per output with
`suppressed`); the `frames` probe shows `totals.present_failed`, `last_present_error`,
`retry_in_ms`. **Resize (review d):** the FBO/texture re-create on a new size makes the
window's context current explicitly first (on failure the old targets are kept, the size
marked failed); a new window target is current from `set_swap_interval` on.

**Frame pacing + redraw policy (decided — `redraw.rs`).** Every output presents on its own
frame callbacks at its own refresh; nothing waits on another output. An output that can
take a frame is drawn only if, since its last present: `Graph::picture_rev` moved (any
create/destroy/non-gain set other than the Animator's — conservative, wakes every output
once), an **animated value changed on a node it shows** (the Animator's per-tick sets go
through `Graph::set_animated`, which doesn't move `picture_rev`; `Redraw::mark_nodes` marks
only the outputs whose `shown_nodes` — `out:<c>`, its main layer, that layer's content
(source or effect), the effect's sides — contain the animated node, so the final value is
drawn too), a source it shows has a new texture (`SourceHost::take_changed`), the backend
asked (configure/resize/re-created surface), **or something animates on it**
(`animating_on`: a started, unfinished, non-gain animation on one of its `shown_nodes` —
transitions, opacity ramps): then it presents on *every* callback, even between two
animator ticks. **Per output (Task 16, review a):** an animation on DP-1's layer never
wakes DP-2 — before, one global "animating" flag (and the animated sets' `picture_rev`
bumps) presented every output at its refresh. Otherwise it is **idle** — no frame drawn,
no callback requested, `frames` probe `idle: true` — so a static colour or image costs
nothing, and a playing video presents at its own frame rate (each frame at the next
refresh — same latency as redrawing every vblank, without the duplicates). Headless keeps
composing every tick (`paced() == false`) unless `--redraw-policy content` (then it uses
this policy with every output always able to take a frame — no frame callbacks, so an
animating output presents on every loop pass; `mixed_content_static_output_stays_idle`).

**Idle animator timer (decided: keep).** The R47 tick timer keeps ticking at the max output
Hz even when every output is idle: ≈ 23 µs per idle tick (measured, Task 13), ~0 % CPU.
Stopping it when nothing animates would need every animation start, transition phase,
step and stop deadline to re-arm it — more ways to stall than it saves.

**`frames` probe** (`probe/frames.rs`, rolling 2 s windows per output): `paced` = intervals
between presents made back to back (the second drawn on the first one's callback, no idle
in between) → mean/p50/p95/max/count + `missed` (> 1.5 refresh periods); `all` = every
interval + `fps`; `idle`, `frame_pending`, totals (`presents`, `callbacks`, `missed`,
`idle_gaps`). Measured on the owner's machine (`outputs.sh`, release build, background
layer, the owner's windows covering it) — table below.

**The seam probe** (design §11 "zero visible seams by the seam probe"; 2026-11-05, switch-over
checklist `docs/player/reports/switch-over.md`): `Composer::last_missing()` names what the last
`compose_output` drew transparent although the output's VISIBLE main layer (`opacity > 0`)
pointed at it — a plain source or either effect side with no texture (R19), or a dangling
`content`; an empty layer / `opacity 0` is never a seam. The runtime (`note_composed`, both
render paths) counts it per output: `frames` probe `totals.seam_frames` / `seam_runs` +
`last_seam` (never cleared by `reset`), each run logged once — `output.seam {output, missing}`
(warn) and `output.seam_end {output, frames}` (info) at the next whole frame. By the recipes
nothing shown ever lacks a texture (B is shown only once `Ready`, a crashed scene holds its
frame), so any count is a hole the viewer saw; only a raw `set lay:*.content` of a source that
isn't ready yet makes one on purpose. Guards: `tests/compose.rs::last_missing_names_every_hole_in_a_visible_layer`,
`probe::frames` unit `seam_runs_count_frames_and_edges`, `tests/api.rs::switches_never_compose_a_hole`
(the first show, video / scene / image / colour into each other × every method, a 12-switch
storm superseding mid-effect: 0 seam frames; the control — a raw `set` before `Ready` — counts
and logs). Batteries: `programs.sh dropout` (per cell `seams`), `soak`, `scenes.sh dropout`
(per serve `seams`).

| source (two runs) | DP-1 (143.981 Hz) paced mean / p95 / max | DP-2 (239.76 Hz) paced mean / p95 / max |
|---|---|---|
| opacity animation | 6.942, 6.946 / 7.77, 7.24 / 9.9, 8.1 ms; 0, 0 missed of 288 | 4.169, 4.171 / 4.78, 4.42 / 6.7, 5.5 ms; 3, 0 missed of 480 |
| 240 fps test clip | 6.945, 6.947 / 7.93, 7.67 / 14.5, 8.4 ms; 3, 0 missed | 4.203, 4.176 / 4.91, 4.51 / 11.5, 5.6 ms; 4, 0 missed |
| 60 fps test clip | 60.0 presents/s (content-paced, idle between frames) | 60.0 presents/s |
| static colour | idle, 0 presents/s | idle, 0 presents/s |
| mixed (Task 16): 60 fps clip on DP-1, static colour on DP-2 | 62–64 presents/s | idle, 0 presents in 1 s |
| mixed + opacity animation on DP-1's layer only (two runs) | 6.944, 6.943 / 7.95, 7.86 / 8.5, 8.6 ms; 0 missed of 288 | idle, 0 presents in 2 s |

(Run 1 ran while another lane's test suite was busy on the machine — its outliers.)
Hyprland keeps sending frame callbacks to fully covered surfaces (a full-screen top-layer
surface on DP-1, a fullscreen window on DP-2): pacing above was measured that way.

**Hotplug.** A new `wl_output` → a surface + `OutputChange::Added`; a removed one →
`Removed`, its GPU side moved to a dead list and freed in `process` with the context made
current **surfaceless** (`Gfx::make_current_surfaceless`, so `eglDestroySurface` is immediate
and the FBO/texture deletes have a context), window target before its `wl_surface` (field
order `gl` then `surface`). A `closed` layer surface whose output stays is re-created
(`wl.surface_recreated`). The runtime runs the **same** add/remove path as headless
hotplug (§ Runtime → Outputs: R59 adopt into a live transition, else `cur:` of the first
output that has one — the same-wallpaper default the brief asks for —, else unpark; R60
retire/park), plus `redraw.forget` + fresh `FrameStats`. A re-plugged connector gets its
remembered output props back (`layer` …, Task 16 — before, it came back on `background`);
a connector never seen starts at the defaults. Verified on-machine: `out:DP-1.layer =
bottom` → unplug → replug → `bottom`, hyprctl level 1.

**Pointer.** sctk `PointerHandler`: enter/leave/motion/press/release on our surface →
`PointerSample {output, x, y, buttons}` (surface pixels = logical × scale; buttons: bit 0
left, 1 right, 2 middle, 3 side, 4 extra; leave clears buttons, keeps x/y) → the runtime
`set_observed`s `out:<c>.pointer` (never a picture change, never forwarded to sources yet —
Phase 2's mouse-reactive scenes read it) and `input.pointer {output, event, x, y, buttons,
button, suppressed}` is logged at debug (motion ≤ 10/s per output; `suppressed` counts the
rest). On enter the cursor is set to the default shape (`wp_cursor_shape_v1`), else the
compositor keeps whatever cursor it had. Axis events are ignored.

**NVIDIA / EGL notes (595.84, egl-wayland2 1.0.2, Hyprland 0.56.2 — measured).**
- **`glDrawBuffer(GL_BACK)` before writing FBO 0.** `Gfx::new_wayland` makes the context
  current surfaceless first; per `EGL_KHR_surfaceless_context` the default framebuffer's
  draw/read buffers then start as `GL_NONE` and stay so when a window surface is bound —
  every blit/clear to FBO 0 was silently dropped (back buffer read back `[0,0,0,0]`, the
  surface showed nothing, no GL error). `present` sets it every time.
- **`eglCreatePlatformWindowSurface` attrib list must be `ATTRIB_NONE`-terminated**:
  khronos-egl rejects an empty slice as `EGL_BAD_PARAMETER` (the Task 7 code passed `&[]`;
  fixed in `Gfx::window_target`).
- **Swap interval 0** on every window (`WindowTarget::set_swap_interval`): with the
  default 1, `eglSwapBuffers` on the 144 Hz output would block the single loop thread and
  drag the 240 Hz output down; pacing is ours (frame callbacks).
- **Explicit sync is off by default (Task 20e) — it leaked a queued event per present.**
  With it on, egl-wayland2 binds `wp_linux_drm_syncobj_manager_v1` (+ `wp_fifo_manager_v1`,
  `wp_commit_timing_manager_v1`) and sets acquire/release points per swap (seen with
  `WAYLAND_DEBUG=client`). **egl-wayland2 ≤ 1.0.2** (NVIDIA 595's) then keeps each
  swapchain's `wl_buffer`s on a per-swapchain event queue (`EGLSurface(<id>/<ptr>)`) that it
  only dispatches *without* explicit sync — and Hyprland sends `wl_buffer.release` for every
  present anyway, so one ~224 B `wl_closure` per present stayed queued for good, allocated by
  our own `wl_display_read_events` (heaptrack: all the growth under `wl_closure_init` ←
  `wl_connection_demarshal` ← `wl_display_read_events` ← `WaylandSource::before_handle_events`).
  Measured 224.1 B/present (colour fade, 384 presents/s), the 1 h live soak's ~2 MiB/min of
  in-use heap (1080p60 + 24 fps content on two outputs; minutes without a switch grew as
  fast — per present, not per switch). Upstream's fix (egl-wayland2 6235dd8, after 1.0.2)
  moves those buffers to libwayland's **default queue** — which wayland-rs never dispatches
  (all its proxies live on its own queue), so with that build the leak was the same
  (224.4 B/present, built from upstream main) until we dispatch it too. Two parts, both in
  `wl.rs`: **(1)** `apply_driver_env` (first thing in `serve`, Wayland only, before any
  thread — it `setenv`s): `__NV_DISABLE_EXPLICIT_SYNC=1` unless the caller set it (a set
  value wins; `0` keeps explicit sync); egl-wayland2 then waits for the GPU at each swap
  (`glFinish` — the compositor is on an NVIDIA GPU, so no implicit sync) and dispatches its
  swapchain queue itself. Cost, two outputs 240/144 Hz mid-crosswarp (two runs): loop tick
  p99 0.13–0.32 → ~1.6 ms, max 0.7–2.2 → 2.3–3.5 ms (< the 4.17 ms budget), 0 missed frames,
  same CPU; 240 Hz interval p95 4.7–4.8 → 5.0–5.4 ms. **(2)** `Wayland::dispatch_default_queue`
  (`wl_display_dispatch_pending`, step 0 of `process`, every loop iteration): what a normal
  libwayland app does in its main loop and EGL relies on; events on proxies without a
  listener are just freed. With explicit sync off nothing lands there per frame
  (`default_queue_dispatched` stays 0). Cells (B/present): 1.0.2 + explicit (before) 224.1;
  1.0.2 + off (default now) −0.0; upstream main + explicit, no drain 224.4, with drain 0.1;
  1.0.2 + explicit kept by the user 224.1 — a driver bug we can't reach (the queue pointer is
  egl-wayland2's), hence the default. When the driver ships an egl-wayland2 with 6235dd8,
  `__NV_DISABLE_EXPLICIT_SYNC=0` brings explicit sync back leak-free. `wl.driver_env {env,
  value, source: policy|env}` (info) at startup; `frames` probe `explicit_sync` (same
  object) + `default_queue_dispatched`. Guard: `tests/api.rs::
  t20e_wayland_present_heap_stays_flat` (opt-in `LIASCAPE_PLAYER_TEST_WAYLAND=<socket>` — it draws
  on that compositor for ~25 s; SKIP otherwise): a 60 s colour fade on every output, heap
  growth per present over 10 s < 32 B (GREEN 2.3 ×2; RED with `__NV_DISABLE_EXPLICIT_SYNC=0`
  226.6 B/present). **Damage:** every present redraws the whole surface and `eglSwapBuffers`
  posts full damage — no buffer-age/partial damage.
- The EGL config has alpha 8, so the buffer is ARGB: alpha is forced to 1 at present (and
  the opaque region set) so the compositor never blends what's below the wallpaper.

**`tests/onmachine/outputs.sh` (run manually, exit 0 = pass; Hyprland + DP-1/DP-2 by
default, `OUT_A`/`OUT_B`/`HZ_*`/`MEAN_*`/`TOL_MS` to adapt).** Builds the release binary
(or `LIASCAPE_PLAYER_BIN`), makes synthetic ffmpeg clips, stops the legacy wallpaper (`/stop`,
waits for no `mpvpaper`), then runs `serve --ao null` with a **private
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME`** (its own socket + instance lock — lanes running
`serve --headless` are unaffected) and an **absolute** `WAYLAND_DISPLAY`
(`$XDG_RUNTIME_DIR/wayland-1` of the session; `hyprctl`/`grim` keep the real runtime dir).
Checks: `hello.backend == wayland`; `out:DP-1` 144 Hz, `out:DP-2` 240 Hz; our namespace on
the background level (`hyprctl layers -j`); red/blue `lay:<c>:main.content` → `out:*.layer
= overlay` (the owner's windows cover the background) → `grim -o <c>` centre pixels →
pointer (cursor warped over DP-1 → `out:DP-1.pointer` = `[960,540,0]` then `[100,200,0]`,
`input.pointer` enter+motion) → back to `background`, level verified; static colour idle;
pacing with an opacity animation and a 240 fps clip (6.9 ± 0.5 / 4.2 ± 0.5 ms, ≥ 50
samples); a 60 fps clip ≈ 60 presents/s; hotplug: `hyprctl eval 'hl.monitor({ output =
"DP-1", disabled = true })'` (this Hyprland has a Lua config: **`hyprctl keyword` is
refused** — "keyword can't work with non-legacy parsers. Use eval." — and re-enabling needs
an explicit **`disabled = false`**) → `out:DP-1` gone, player alive → re-enabled with the
**recorded** mode/position/scale (never `preferred,auto`) → `out:DP-1` back showing
`cur:DP-2` with its remembered `layer` (`bottom`, set before the unplug), pixel verified,
layout identical to the record; **mixed content** (Task 16: 60 fps clip on DP-1, colour on
DP-2 → DP-2 idle, then an opacity animation on DP-1 only → DP-1 paced 6.9 ms, DP-2 still 0
presents); **crash → restart** (`kill -SEGV` the compositor child → `hello` from a new pid
≤ 1.5 s — measured 151/164 ms — both outputs restored, pixels verified, background level
again); `ctl quit` → exit 0. `serve` runs supervised: `SERVE_PID` is the supervisor,
`PLAYER_PID` (`hello.pid`) the child that owns the surfaces (layer checks use it). It runs
under `prlimit --core=1:1`: RLIMIT_CORE 1 makes the kernel skip the piped core handler
(with 0, systemd-coredump still runs and DrKonqi pops a crash notification). Pixel checks
fall back to the (¼ w, ¾ h) pixel if the centre is covered (the owner's shell put a
notification popup over DP-2's centre on the overlay level). **Safety:**
an `EXIT` trap restores the focused monitor + cursor, kills `serve` (no liascape-player layer may
remain — checked), re-applies any monitor that differs from the record with its exact
values and verifies `hyprctl monitors -j` matches, and moves workspaces back to their
recorded monitors. Socket paths must stay < 108 bytes: the script uses `mktemp` in
`$TMPDIR`/`/tmp`, not a long scratch path.
