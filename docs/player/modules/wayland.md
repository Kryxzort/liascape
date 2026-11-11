# Wayland backend and frame pacing

Covers `src/player/src/wl.rs`, `src/player/src/redraw.rs` and `src/player/src/probe/frames.rs`. Rules:
`.claude/rules/player/gfx-wayland.md` (present, redraw policy, NVIDIA, hotplug, the on-machine check).

## Backend

`Wayland::connect` (sctk with only the calloop feature — no xkbcommon, no keyboard) binds `wl_compositor`,
`zwlr_layer_shell_v1`, optionally `wp_cursor_shape_manager_v1`, and `zwlr_foreign_toplevel_manager_v1` only when
it is the cover source ([signals.md](signals.md)); two roundtrips give output info then first configures. One EGL
context serves every output and every source. The queue runs in the loop as a `WaylandSource`, which flushes and
`prepare_read`s before each sleep so events EGL reads off the socket are never stranded.

One layer surface per `wl_output`: namespace `liascape-player`, all edges anchored at size 0×0 (the configure
decides), exclusive zone −1, no keyboard, default input region (pointer accepted), opaque region = the whole
surface. Names come from `wl_output` v4 `name` (`.`/`:`/`*`/spaces → `-`; none → `WL-<global id>`); size is the
current mode rotated by the transform; `refresh_hz` rounds the mode's mHz (143 981 → 144), `refresh_mhz` is exact.
Fractional scaling isn't implemented: such an output renders at the ceiling integer scale. Hyprland advertises a
headless `FALLBACK` output when every monitor is disabled; it is ignored so the player parks.

`out:<c>.layer` is live. On Hyprland a `set_layer` before the surface is mapped is lost, so v1 or an unmapped
surface is re-created on the new layer instead.

## Present

Each output owns an RGBA8 texture + FBO that compose draws into (also what `capture` reads) and a `WindowTarget`
built once the surface is configured. Present blits that FBO to the back buffer and swaps; the order and the
reasons are rules (`gfx-wayland.md` § Present). Two driver facts behind them: a context first made current
surfaceless starts with draw buffer `GL_NONE` and keeps it when a window surface is bound, so writes to FBO 0 were
silently dropped until `glDrawBuffer(GL_BACK)`; and swap interval 1 makes `eglSwapBuffers` on the 144 Hz output
block the one loop thread and drag the 240 Hz output down — pacing comes from frame callbacks instead.

`wl_surface.frame` rides on the swap's commit, so it is requested before the swap; a failed swap makes no commit
and leaves the request armed (`frame_armed`). Failed presents back off 100 ms, then 1 s while they keep failing;
the `frames` probe shows `present_failed`, `last_present_error`, `retry_in_ms`.

## Redraw policy

Every output presents on its own frame callbacks; an output is drawn only when something it shows changed (the
list is in the rule). Animated values go through `Graph::set_animated`, which doesn't move `picture_rev`;
`Redraw::mark_nodes` marks only outputs whose shown nodes (`out:<c>`, its main layer, the content, an effect's
sides) contain the animated node. A non-gain animation on an output presents it on every callback; a gain-only
animation never wakes a picture. An idle output requests no callback, so a static colour or image costs nothing
and a video presents at its own frame rate (each frame at the next refresh). Headless composes every tick unless
`--redraw-policy content`, which applies this policy with every output always able to take a frame.

The animator tick timer keeps running at the fastest refresh even when every output is idle: about 23 µs per idle
tick. Stopping it would need every animation start, transition phase, step and stop deadline to re-arm it.

Measured on the owner's outputs (release, background layer, covered by windows — Hyprland keeps sending frame
callbacks to covered surfaces):

| content | DP-1 143.98 Hz: paced mean / p95 | DP-2 239.76 Hz: paced mean / p95 |
|---|---|---|
| opacity animation | 6.94 / 7.2–7.8 ms, 0 missed of 288 | 4.17 / 4.4–4.8 ms, 0–3 missed of 480 |
| 240 fps clip | 6.95 / 7.7–7.9 ms | 4.18–4.20 / 4.5–4.9 ms |
| 60 fps clip | 60 presents/s, idle between frames | 60 presents/s |
| static colour | idle, 0 presents/s | idle |
| clip + opacity animation on DP-1 only | 6.94 ms paced | idle, 0 presents |

`frames` probe: per output, rolling 2 s windows. `paced` = intervals between back-to-back presents (the second drawn
on the first one's callback) with `missed` (> 1.5 refresh periods); `all` = every interval and `fps`; totals,
`idle`, and the seam counters (`seam_frames`, `seam_runs`, `last_seam`, logged as `output.seam` /
`output.seam_end`).

## Hotplug and pointer

A new `wl_output` gets a surface and runs the runtime's add path ([runtime.md](runtime.md) § Outputs); a removed
one runs the remove path, and its GPU side goes to a dead list freed with the context current surfaceless, window
target before its `wl_surface`. A connector seen before gets its remembered output props back (layer included).

Pointer enter/leave/motion/buttons on our surface become `PointerSample {output, x, y, buttons}` in surface pixels
(logical × scale; buttons bit 0 left, 1 right, 2 middle, 3 side, 4 extra; leave clears buttons and keeps x/y),
observed into `out:<c>.pointer` and forwarded to scenes. On enter the cursor is set to the default shape. Axis
events are ignored.

## NVIDIA: explicit sync and the default queue

With explicit sync on, egl-wayland2 ≤ 1.0.2 keeps each swapchain's `wl_buffer`s on its own event queue, which it
dispatches only without explicit sync; Hyprland sends `wl_buffer.release` for every present anyway, so one
~224-byte `wl_closure` per present stays queued forever (≈ 2 MiB/min of heap on two outputs). Upstream's fix moves
those buffers to libwayland's default queue, which wayland-rs never dispatches — the same leak until something
dispatches it. Hence both parts of the rule: `__NV_DISABLE_EXPLICIT_SYNC=1` by default (a caller's value wins;
egl-wayland2 then waits for the GPU at each swap and dispatches its own queue) and
`Wayland::dispatch_default_queue` every iteration (what a normal libwayland app does). Cost of explicit sync off,
two outputs at 240/144 Hz mid-effect: loop tick p99 0.13–0.32 → ~1.6 ms, max 2.3–3.5 ms (under the 4.17 ms budget),
0 missed frames. Once the driver ships an egl-wayland2 with the fix, `__NV_DISABLE_EXPLICIT_SYNC=0` restores
explicit sync without the leak. The `frames` probe shows `explicit_sync` and `default_queue_dispatched`.

Every present redraws the whole surface; there is no buffer-age path.
