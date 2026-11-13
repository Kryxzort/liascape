# Sources: mpv, SourceHost, render worker

Covers `src/player/src/sources/` (`mod.rs`, `mpv.rs`, `host.rs`, `render_worker.rs`, `reaper.rs`, `color.rs`,
`snapshot.rs`) and `src/player/src/mpv/`. Rules: `.claude/rules/player/sources-audio.md` (the Source contract,
mpv options, async calls, hwdec, load fencing, onset, teardown, `SourceHost`, render worker). Scene sources:
[scene-source.md](scene-source.md).

## `MpvSource`

One mpv core and one render context per source, opened in two halves: `prepare_core` (eventfd, `mpv_create`,
fixed options, `mpv_initialize`, observers; no GL, `Send`) on an `lia-open` thread, then `open_with_core` on the
loop (render context, props, `loadfile`). `open` runs both in a row (stepped mode, tests, the harness). The load
is async: a missing file opens fine, then reports `Error` naming the path and mpv's last error line.

Why some fixed options are what they are:

- `dither=ordered` — the default blue-noise dither builds its matrix on the CPU in every new render context's
  first render, ~25–30 ms on the loop per switch.
- No built-in Lua scripts or bindings (`SCRIPT_TRIMS`): each is a Lua VM on its own thread serving an OSD nobody
  can open on a wallpaper. Trimmed, a playing core drops from 28 to 22 threads and a core's create + destroy from
  37–47 ms to 4–6 ms of CPU.
- `clipboard-backends=` empty (`CLIPBOARD_OFF`): mpv ≥ 0.40 starts a clipboard in every core — its own
  Wayland data-control connection, or without `WAYLAND_DISPLAY` its own X connection. When that X server goes
  away, Xlib's default I/O error handler `exit(1)`s from mpv's thread and atexit tears EGL down under the loop's
  GL (SIGSEGV). Nothing in the player needs X. An explicit `vdpau` decoder still opens X through its driver.
- Both trims are best-effort (`set_optional`) so an older libmpv still opens; skipped names log
  `mpv.options_skipped` once.

**Async core calls.** `render.h` forbids the render thread from waiting on core functions: the core may be
waiting for a frame to be rendered, so a synchronous `mpv_set_property` stalls until vo_libmpv's timeout
(measured 4–72 ms per call). After open every apply is `mpv_set_property_async`/`mpv_command_async` (worst
measured 120–160 µs). Gains coalesce to one `volume-gain` request in flight, the latest sum sent on its reply —
mpv's reply queue holds 1000 entries and a per-frame ramp would flood it.

## Property map pitfalls

- `cache: true` → `auto` (mpv's normal policy); `yes` would RAM-cache every local wallpaper.
- `demuxer_*_mib` → bytes (mpv rejects `1.5MiB`); 0 = mpv's default 150/50 MiB.
- `fps_cap` never reaches a still: libavfilter's `fps` emits a frame only once it knows how long it lasts, and an
  image at `image-display-duration=inf` gives neither a next pts nor a timed EOF — its one frame went in and
  nothing came out, so capped images never became `Ready`. `want_vf` decides from the kind at open, then mpv's
  `current-tracks/video/image` flag re-pushes `vf` when the extension guessed wrong.
- `af` always ends in `@liascape-tempo:scaletempo2` (unless it has `scaletempo*`/`rubberband`): with pitch
  correction mpv adds its own tempo filter only while `speed` ≠ 1, and each add/drop rebuilds the audio chain —
  3–5 ms of digital silence, measured 22 holes in 40 s of 0.9 ↔ 1.0 toggles (the UI slider steps 0.1, so every drag
  across 1× hit it). With ours present the chain is built once; at 1× scaletempo2 is bit-exact.
- `no_audio` → `aid no`/`auto`; `auto` re-inits the AO even after a no-audio start.

## Hardware decoding

Where the render context lives decides the mode:

- **On the loop** (worker off, stepped, harness, synchronous opens): copy modes only, `gpu-hwdec-interop=no`;
  `mpv_hwdec(v, None)` maps every interop name to its `-copy` twin and `auto` to
  `nvdec-copy,vaapi-copy,auto-copy`. Two traps this avoids: mpv's default interop creates a CUDA context inside
  `mpv_render_context_create` on our loop whenever libmpv can load `libcuda.so.1` (65–90 ms per switch, whatever
  `hwdec` says); and mpv's own `auto` order reaches `vulkan-copy`, whose `vkCreateDevice` holds an NVIDIA
  process-wide lock every GL call on the loop waits on — 230–320 ms per switch when no X server is reachable
  (headless tests, an Xwayland-less session; 7–22 ms with one). An explicit `vulkan` keeps that limit.
- **On the render worker** (default for real-clock sources): zero-copy through the interop
  `render_worker::hwdec_interop_for` picks from `GL_VENDOR` (NVIDIA `cuda`, AMD/Intel `vaapi`, else none) — never
  mpv's `auto` interop, which on the render API loads every interop eagerly (on NVIDIA a second CUDA context via
  nvidia-vaapi-driver). The interop is set on the core only for an attach the loop doesn't wait for and a source
  that would decode zero-copy (`host::wants_hwdec_interop`); each zero-copy decoder is followed by its copy twin,
  so a failed interop falls back to copy, never software. `vulkan`, `vdpau` and `amf` stay copy (mpv's GL renderer
  has no Vulkan interop). `LIASCAPE_PLAYER_HWDEC_INTEROP=off` restores copy modes; `cuda|vaapi|drmprime|all` forces.
- **libcuda:** libmpv's nixpkgs RUNPATH lacks `/run/opengl-driver/lib`, so lane 0 dlopens `libcuda.so.1` by soname,
  else from that dir, before any interop — a loaded soname satisfies every later lookup.

Measured (release, 1920×1080 headless, `hwdec: auto`, copy vs zero-copy): 4K60 process CPU 49 % → 7 % of a core,
loop max busy steady 9.8 → 1.4 ms; 1080p30 7.8 → 3.2 %; first frame ~330 ms either way; the attach on its lane
2 ms → 112 ms (91–155), which is why lanes exist. Each interop source costs ~60 MiB VRAM (its CUDA context). In
copy mode, steady 1080p30 on two outputs: `no` 27.7 %, `nvdec-copy` 9.8 %, `vulkan-copy` 14.4 % of a core; first
frame of a cold source `no` 319 ms, `nvdec-copy` 438, `vaapi-copy` 642, `vulkan-copy` 698 — hence `nvdec-copy` first.
AMD/Intel `vaapi` zero-copy is unmeasured.

## Load fencing and events

Every `loadfile` is async; its reply carries the playlist entry id and START_FILE/END_FILE carry the entry they
belong to, so events and observed props are attributed to a load and a superseded load's events are dropped.
`Ready` needs the current load's PLAYBACK_RESTART and a frame rendered after its FILE_LOADED in either order:
restart-first happens for paused clips and images, frame-first for most playing videos. `Position` comes from
`time-pos`, rate-limited to 100 ms. mpv reports a `time-pos` only when it differs from the last one it sent, and
the one sent between FILE_LOADED and the first PLAYBACK_RESTART is the start's seek target: when the frame the load
lands on has that same time (a paused source at an exact frame, a clip restored on its last frame) no change
follows, so that value is kept and adopted at the restart; otherwise `time_pos` stays unknown and reads as the
graph's 0.0 (a snapshot then saves 0). On a looping file `time-pos` drops to 0 while the last frame is still shown;
frame 0 follows one frame later (33.9–34.3 ms at 30 fps) — the transition recipe anchors loop boundaries on it.

**Dropped first frame.** vo_libmpv drops a frame the API user didn't render within 200 ms and stops reporting it.
A playing source sends the next one; a paused source (a pending B), an image or a clip already at its end has no
next frame, so if the loop was busy past 200 ms it never became Ready and the switch failed after 10 s.
`refetch_lost_frame` seeks to the same position after `REFETCH_AFTER` (300 ms, backing off ×2 to 2.4 s) — a new
PLAYBACK_RESTART, the same frame, no FILE_LOADED. Never for a playing source (it would restart a merely slow
decode), never in stepped mode. `source.frame_refetched` logs it.

**`AudioFlowing`.** Un-pausing arms it; the next `audio-pts` change confirms (observed only while armed: it
changes at the audio-buffer rate and woke the loop all day; the first notification after `observe` is the current
value and is skipped). `audio-pts` includes the audio driver delay and doesn't move while paused, unlike
`time-pos`. Also confirmed by real time since the first change (a stream that stalls right after starting), or by
the picture advancing `NO_AUDIO_MEDIA_ADVANCE` (0.1 s) while `audio-pts` is unavailable (no track selected yet, or
the track already ended) — with audio playing the picture can't run ahead of it. A path load or audio re-route
re-arms it.

**`has_audio`** is observed via `aid`, which always holds a value (`auto`, a track id, `no`) and so re-notifies;
`current-tracks/audio/id` never re-notifies for an audio-less file. Unknown reads `true` so a real wait is never
skipped.

## Rendering, wakeups, teardown

- **Targets.** Until `Ready` every frame renders into a staging `back` target, promoted to `front` in the update
  that pushes `Ready`: until then the front keeps the old file's last frame. Size = mpv's display size, long edge
  ≤ 4096; a resized target swaps only after a successful render. `MPV_RENDER_PARAM_FLIP_Y = 0` into our FBO puts
  the image top at texture row 0 (mpv's FLIP_Y=1 is for a default framebuffer).
- **Wakeups.** Both mpv callbacks `write(2)` to one nonblocking eventfd (the fd number is the callback context:
  no allocation, no mpv call). `poll_events()` and `update()` each drain the fd first, so a signal arriving
  mid-call re-arms it.
- **Fence stub.** The `get_proc_address` given to mpv returns a stub `glFenceSync` that returns 0 (technique from
  mpvpaper, credited in `CREDITS.md`): libmpv's render path otherwise accumulates sync objects. Safe because mpv
  null-checks fences and `glDeleteSync(0)` is a no-op; what mpv's fences guard is buffer reuse for direct
  rendering (`ADVANCED_CONTROL`) and PBO uploads (`opengl-pbo`), neither of which may be enabled with the stub.
- **Teardown in two phases.** `begin_teardown` sends an async `stop` once the last gain push reached mpv (so −96
  lands first) and moves the source to `dying`; it drops once mpv is idle, decided from event order (no
  START_FILE ever seen, or an `idle-active` after the last END_FILE), or after `TEARDOWN_MAX` (500 ms). With the VO
  still live, `mpv_render_context_free` waits on the playloop (21–32 ms measured). The core then goes to the
  `lia-mpv-reaper` thread for `mpv_terminate_destroy` (30–240 ms) and a `malloc_trim` after each batch. Around a
  playing video's destroy the loop is busy 1.7–3.0 ms.

## `SourceHost`

The only place a node becomes a live source: `sync` opens/drops sources and forwards drained changes, `update`
updates them and mirrors observed values into the graph. Only changed observed values are written (a scene
updates every frame, and nine path-resolving `set_observed`s per update were the compositor's largest per-worker
cost); the mirror memory is cleared on every forward so a refused `set` is still mirrored back.

**Async opens.** Cores are made by `OpenPool`: a FIFO served by at most `MAX_OPEN_WORKERS` (2) `lia-open` threads,
spawned on demand and gone when idle. A queued job holds its node weakly, so a switch storm's superseded B's are
skipped without making a core; the source opens from the node's current props, so a change made while queued
lands. A burst of 16 creates: all made in 61–80 ms at cap 2, loop open share 2–8 ms (uncapped: 13–29 ms, because
more finished cores land in one `sync`).

`ColorSource` is a 1×1 texture made on the first `update`. `SnapshotSource` copies another source's texture once:
pausing mpv doesn't freeze a texture (a paused core still presents 2–3 queued frames, ~100 ms). `set_audio_route`
sends `audio-device`, `audio-delay`, then `aid no` + `aid auto`: a dead audio server takes mpv's AO with it and
deselects the track, so a device change alone leaves no AO.

## Render worker (`render_worker.rs`)

`lia-render` lanes own every real-clock `MpvSource`'s render context — creation, first render (shader compile,
LUTs), every render, the free — so the loop only adopts finished textures. Each lane has its own context in the
compositor's share group (`Gfx::share_context`), current for the lane's whole life, and its own glow with real
fences; mpv still gets the fence stub.

- **Lanes.** A render context's creation blocks its lane, and with an interop that is a CUDA context
  (85–220 ms). On one lane the playing wallpaper froze for it at every switch (A's longest frame interval
  34 → 66–74 ms at 30 fps). With an interop there are `RENDER_LANES` (3; `LIASCAPE_PLAYER_RENDER_LANES` 1–6) and an
  attach goes to the lane with the fewest live sources: two lanes cover one wallpaper ping-ponging across a switch,
  the third a switch while the previous A still fades or a second wallpaper. Without an interop an attach costs
  < 1 ms and one lane runs. Each extra lane costs a thread, ~4.5 MiB RSS and 50–110 ms at startup.
- **Hand-off.** The loop keeps the core (events, applies, `read`, load fencing, Ready). The worker renders only
  into textures it owns, fences, waits and then publishes; the loop adopts a frame only when its fence has
  signalled (else keeps the previous one) and re-binds the texture (share-group visibility). A texture the loop
  sampled goes back with a release fence the worker waits on.
- **Ready with a worker.** Frames are tagged with the FILE_LOADED count the worker saw through a weak client (every
  other event masked, so its `wait_event` never takes the core lock). A frame counts for the current load iff its
  tag equals the count at that load's FILE_LOADED — mpv's own event order, not the loop's pump time, so an image
  whose only frame rendered before the loop pumped FILE_LOADED still becomes Ready.
- **Free.** `Drop` hands the core and textures to the worker: render context freed with the lane's context current
  (interop uninit and its CUDA context included), weak client destroyed, textures deleted, then the core to the
  reaper. No GL on the loop.

## Tests

`tests/sources.rs` media come from `tests/common::ensure_clip` (ffmpeg into `target/test-media/`, regenerated only
when the spec stamp differs): 1920×1080@30 H.264 built in RGB and converted with an explicit, tagged BT.709
limited-range matrix, so solid colours come back within ±3 and `FrameIndex` markers within ±1.
