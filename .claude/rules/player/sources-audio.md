---
paths:
  - "src/player/src/sources/**"
  - "src/player/src/mpv/**"
  - "src/player/src/audio/**"
  - "src/player/src/onset.rs"
  - "src/player/src/probe/audio.rs"
  - "src/player/tests/sources.rs"
  - "src/player/tests/common/pw.rs"
  - "src/player/tests/onmachine/bus.sh"
---

# liascape-player: sources and the audio bus

Crate-wide rules (units, graph, composition, memory) are in `.claude/rules/player/core.md`; scene sources in
`.claude/rules/player/scenes.md`. Walkthroughs and measurements: `docs/player/modules/sources.md`,
`docs/player/modules/audio-bus.md`.

## The Source contract (`src/player/src/sources/mod.rs`)
- `update` never blocks and returns whether the texture changed. `texture()` keeps the last good frame forever — a
  stalled, reloading or ended source shows its last frame, never black.
- `apply` validates with `graph::props::validate_value` (same codes and order as `Graph::set`). A string with an
  interior NUL is `out_of_range`, never stripped; a live `kind` change is `unsupported`. Every writable prop,
  `path` included, applies live.
- `read` serves cached/observed values only — never a synchronous mpv call. An applied value reads back at once and
  reverts if mpv later rejects it.
- `SourceEvent::Error` = the source is broken; `Rejected{prop, reason}` = one write refused and reverted, the source
  plays on.
- Render only through the context the source was opened on (`GlKeepAlive::is_for`); a foreign `Gfx` gets no render
  and one `Error` (libmpv through a foreign context is UB). `update`/`open` take a `make_current` guard. Guard
  `src/player/tests/sources.rs` `update_with_foreign_context_is_refused`.
- A source texture holds the image's top row at texture row 0; render mpv with `MPV_RENDER_PARAM_FLIP_Y = 0` and
  never flip in a source (composition flips once). Guard `source_texture_holds_image_top_at_t0`.

## mpv core options (`src/player/src/sources/mpv.rs`)
- Keep `keep-open=yes` with `keep-open-pause=no` (else `pause` flips at EOF and a seek back stays frozen), `idle=yes`,
  `volume=100`, `volume-gain-min=-96`, `keepaspect=no`, `opengl-pbo=no`, `config=no`.
- Keep `dither=ordered`: the default blue-noise dither builds its matrix on the CPU in every new render context.
- Keep `gpu-hwdec-interop=no` on the core; only a render-worker attach sets an interop (below).
- Keep `SCRIPT_TRIMS` (no built-in Lua scripts or bindings) and `CLIPBOARD_OFF` (`clipboard-backends=` empty), both
  best-effort via `set_optional` so an older libmpv still opens. With a clipboard, mpv opens its own X/Wayland
  connection per core, and a dropped X server `exit(1)`s the player from Xlib's default handler. Guards
  `builtin_scripts_are_not_loaded`, `no_clipboard_backend_per_core`, `src/player/tests/api.rs`
  `losing_the_x_server_never_kills_the_player`, unit `unknown_trim_option_never_breaks_a_core`.
- Apply every writable prop not in `opts` at its schema default at open, so `read` and mpv agree from the start.
  Guard `defaults_applied_at_open_match_mpv`.
- Error codes at open: wrong type `bad_type`; bad value or one mpv rejects `out_of_range`; unknown mpv option
  `unsupported`; `io` only for real setup failures. A missing file is `Ok` from `open`, then `Error` naming the path.

## Async core calls
- After `open`, every `apply` uses `mpv_set_property_async` / `mpv_command_async`: a synchronous call from the
  render thread waits on vo_libmpv (tens of ms). `mpv_get_string`/`mpv_get_f64` are for tests and probes only.
  Guard `apply_never_blocks_the_render_thread`.
- A failed reply becomes `Rejected` and reverts `props` only if no newer apply of that prop is in flight.
- Coalesce gains: at most one `volume-gain` request in flight, the latest sum sent on its reply — a per-frame ramp
  must not flood mpv's reply queue, and the final value must land.
- Gains go to `volume-gain` as `units::mpv_volume_gain(Gains::effective_db())`; `open` pushes the initial sum.
- In tests, `settle()` (until `requests_in_flight() == 0`) before a raw mpv read.

## Property mapping pitfalls
- `cache: true` → mpv `auto`, never `yes` (that RAM-caches every local file).
- `demuxer_*_mib` fractional values go as exact bytes (mpv rejects `1.5MiB`); 0 = mpv's default.
- `fps_cap` never reaches a still: `want_vf` sends `fps=<n>` only when the current load isn't a still, re-pushed
  when mpv's `current-tracks/video/image` corrects the guess — libavfilter's `fps` never emits an image's single
  frame. Guards `fps_cap_never_stalls_an_image`, `src/player/tests/api.rs` `fps_cap_never_stalls_a_still_any_kind`.
- `mpv_af` always appends `@liascape-tempo:scaletempo2` (unless the chain has `scaletempo*`/`rubberband`) so mpv
  never rebuilds the audio chain when `speed` crosses 1× (a rebuild is an audible hole). `read("af")` keeps the
  graph value. Guard unit `af_always_carries_a_tempo_filter`.
- `no_audio` → `aid no`/`auto` (`auto` re-inits the AO after a no-audio start). Guard
  `start_muted_then_unmute_live`.

## Hardware decoding
- A source rendered on the loop decodes in copy modes only: `mpv_hwdec(v, None)` maps every interop name to its
  `-copy` twin and `auto` to `nvdec-copy,vaapi-copy,auto-copy`. Never let an interop init run on the loop (a CUDA
  context per switch) and never let `auto` reach `vulkan-copy` (a process-wide driver lock without X). Guards unit
  `hwdec_maps_to_copy_modes_only`, `src/player/tests/api.rs` `t20d_hwdec_switch_never_stalls_the_loop`.
- On the render worker, use the interop `render_worker::hwdec_interop_for` picks from `GL_VENDOR` (NVIDIA `cuda`,
  AMD/Intel `vaapi`, else none) — never mpv's `auto` interop, which loads every interop eagerly. Each zero-copy
  decoder is followed by its copy twin. `LIASCAPE_PLAYER_HWDEC_INTEROP=off` restores copy modes.
  Guards `hwdec_maps_to_the_loaded_interop_on_the_worker`, `hwdec_interop_follows_the_gpu_and_the_env`,
  `hardware_decoding_matches_software_in_both_render_modes`.
- Set the interop (`gpu-hwdec-interop`) only for an async attach (`host::wants_hwdec_interop`: not stills, not
  copy/`no`); an attach that falls back to the loop sets `no` again. `vulkan`, `vdpau`, `amf` stay copy.
- Lane 0 dlopens `libcuda.so.1` (soname, then `/run/opengl-driver/lib`) before any interop: libmpv's RUNPATH lacks
  that dir.

## Load fencing and events
- Only the current load counts: ignore a superseded load's FILE_LOADED, PLAYBACK_RESTART, END_FILE (errors
  included), `eof-reached` and `time-pos`; count `time-pos`/`eof-reached` only after the current load's restart.
  Guards `path_change_before_first_pump_shows_only_new_file`, `stale_load_error_is_not_reported_for_new_path`.
- `Ready` = the current load's PLAYBACK_RESTART and a frame rendered after its FILE_LOADED, in either order —
  requiring the frame after the restart can wait forever on a paused clip or image.
- `Ended` comes from `eof-reached` (keep-open sends no END_FILE), once per play-through, never with `loop`, never
  for an image, and only after `Ready` (`ended_held`). Guard `ended_holds_last_frame`.
- A paused source, image or ended clip whose only frame vo_libmpv dropped is re-fetched with a seek after
  `REFETCH_AFTER` (backing off); never a playing source, never stepped mode. Guards
  `dropped_first_frame_of_a_paused_source_or_image_still_readies`, `clip_ended_before_any_render_readies_then_ends`.
- Until `Ready`, render into the staging `back` target; promote it to `front` in the update that pushes `Ready`.
  Swap a resized target only after a successful render. Reset GL state after every mpv render (libmpv leaves its
  own).

## Audio onset (invariant #8, `src/player/src/onset.rs`)
- Un-pausing arms `AudioFlowing`; confirm on the next `audio-pts` change (observe it only while armed) or by
  `confirm_flowing_by_time` (real time, or picture advancing `NO_AUDIO_MEDIA_ADVANCE` with no audio). Fire at once
  for stepped mode, images, `no_audio`, `has_audio == false`. A `path` load or audio re-route re-arms it.
- The source never times out the wait; callers bound it with `onset::ONSET_TIMEOUT`. Guard
  `src/player/tests/api.rs` `audio_less_b_never_times_out_its_onset_any_method_or_align`.
- Use the one predicate `onset::has_audio` everywhere; never copy it. `has_audio` is observed via `aid` (not
  `current-tracks/audio/id`, which never re-notifies for an audio-less file) and ignored while `no_audio` is on.
  Guard `has_audio_reflects_real_track_presence`.

## Wakeup, fence stub, teardown
- Both mpv callbacks only `write(2)` to one nonblocking eventfd; on readability call `poll_events()` and `update()`,
  each draining the fd first.
- The `get_proc_address` given to mpv stubs `glFenceSync` to 0 (mpv otherwise leaks syncs). Never enable
  `opengl-pbo` or pass `ADVANCED_CONTROL` while the stub exists. Guard `fence_sync_stub_is_used`.
- Free the render context with its GL context current and before `mpv_terminate_destroy`; sources hold a
  `GlKeepAlive` for that. If the context can't be made current, stop the core and leak it — never free against the
  wrong context. Guard `source_outlives_gfx_safely`.
- Teardown is two-phase: `begin_teardown` sends an async `stop` (after the last gain push reached mpv, so −96 lands
  first) and moves the source to `dying`; drop it once `teardown_ready` (idle decided from event order) or
  `TEARDOWN_MAX`. Guards `src/player/tests/api.rs` `rapid_create_destroy_never_stalls`,
  `destroy_never_stalls_the_loop`.
- `mpv_terminate_destroy` runs on the `lia-mpv-reaper` thread. A straggler at `reaper::shutdown` is an undestroyed
  core, never a trim. Guards in `src/player/src/sources/reaper.rs`.

## SourceHost (`src/player/src/sources/host.rs`)
- `SourceHost` is the only place a node becomes a live source. Each iteration `sync` must run before `update`, or
  the mirror overwrites a command not yet forwarded.
- Mirror only changed observed values (via `Graph::set_observed_on`); clear a source's mirror memory whenever a
  change is forwarded to it, so a refused `set` is still mirrored back.
- Update only woken sources on a wake (`update_only`); the tick updates all. Run `sync_sources` only when
  `Runtime::sync_due`.
- Async opens: `prepare_core` on the `OpenPool` (≤ `MAX_OPEN_WORKERS` `lia-open` threads), then `open_with_core` on
  the loop from the node's current props. A queued job holds its node weakly (destroyed = skipped); a panicking job
  doesn't kill its worker. Stepped mode and harnesses open synchronously. Guards
  `src/player/tests/api.rs` `i5_open_burst_is_capped_and_none_lost`, unit
  `open_pool_caps_concurrency_in_order_and_loses_none`.
- `ColorSource` accepts and stores every writable prop (an alias `set` must never fail on a colour) and creates its
  texture lazily on the first `update`.
- Use `SnapshotSource` to hold a still picture: pausing mpv doesn't freeze its texture (queued frames still
  present). Guard `snapshot_copies_frame_and_orientation`.
- `set_audio_route` re-routes every mpv source with `audio-device`, `audio-delay`, then `aid no` + `aid auto` — an
  `audio-device` change alone leaves no AO after the server died.

## Render worker (`src/player/src/sources/render_worker.rs`)
- Real clock only: stepped mode, harnesses and synchronous opens render on the loop
  (`src/player/tests/api.rs` `stepped_is_deterministic`).
- Lanes own render contexts for their whole life; a source never moves lanes. With an interop run `RENDER_LANES`
  lanes so B's attach never runs in front of A's renders; attach to the lane with the fewest live sources.
- The `Exchange` mutex is never held across an mpv call. The worker renders only into textures it owns, fences and
  waits before publishing; the loop adopts a frame only when its fence has signalled, and returns sampled textures
  with a release fence. Guard `render_worker_never_composes_a_torn_frame`.
- Count FILE_LOADED with a weak client (every other event masked) and tag frames with it; Ready uses that tag.
- `Drop` hands the core and textures to the worker (`Free`); no GL on the loop. Quit order: `finish_teardown`, then
  `render_worker::shutdown`, then `reaper::shutdown`.

## Stepped mode
- The core stays paused; `paused`/`position` are stored only. `step_status` is `Done` after the seek reply and a new
  frame (or any frame after the restart); a redraw before the restart never counts.

## Audio bus (`src/player/src/audio/bus.rs`)
- Keep the identity constants in `audio::bus` verbatim (`SINK_NAME`, `PLAYBACK_NAME`, `APP_NAME`, `MEDIA_ROLE`,
  `SINK_DESCRIPTION`): auto-mute excludes the bus by them. mpv streams share `application.name`, so exclude by
  ownership/target, never by that name alone.
- `Bus::start` never blocks; serve waits for the first session at most `BUS_STARTUP_WAIT`, then runs regardless.
  Never give up on the bus (except `--ao` ≠ pipewire or `LIASCAPE_PLAYER_BUS=off`): failures retry with backoff.
- Drive retargeting by "last requested vs default", never by the momentary link set. Never fight a session policy
  (EasyEffects) or a manual move: report `audio.bus.moved` / `overridden` and wait for the next default change.
- Set `state.restore-props = false` and `state.restore-target = false` on every bus stream, and never set
  `application.id` on the context — WirePlumber would save our retargets as user choices.
- On a core error don't destroy the loopback module (it unloads itself; destroying it double-frees). Sources go to
  mpv's default device via `Bus::route()` and come back with their ramp-in held on `gain.pause`.
- `Runtime::shutdown` destroys every source before `Audio::close`, so nothing moves to the default sink on exit.
- Guards: `src/player/tests/api.rs` `bus_down_falls_back_to_default_device`, `ao_null_runs_without_bus`,
  `bus_comes_up_when_pipewire_starts_after_the_player`, `serve_answers_at_once_while_wireplumber_isnt_up_yet`,
  `quit_while_the_bus_waits_for_wireplumber_is_prompt`, `i7_bus_reconnects_after_pipewire_restart`.

## Async streams and latency
- `audio::bus::set_async_streams_env` sets `PIPEWIRE_PROPS` `node.async = true` while serve is single-threaded:
  with synchronous links a stream deactivating (pause, teardown, worker quit) skips a whole graph cycle. Guards
  `bus_producers_link_asynchronously`, `scene_worker_exit_never_skips_bus_cycles`,
  `mpv_source_teardown_never_skips_bus_cycles`.
- `Bus::latency()` = the measured loopback latency plus `ASYNC_HOPS` quanta; sources get `audio_delay_bias =
  −latency` and a source's own `audio_delay` adds to it (`read("audio_delay")` stays the graph value).
- Recording tests need the private PipeWire with `module-rt` (`src/player/tests/common/pw.rs`): a non-RT data thread
  skips cycles on its own. Tests never touch the owner's PipeWire.

## Meter (`src/player/src/audio/meter.rs`)
- The capture callback runs on PipeWire's RT data thread (`RT_PROCESS`), never blocks or allocates (`try_lock`,
  staging buffer). Guard `meter_capture_runs_on_the_rt_data_thread`.
- Meter per channel and take the loudest (never a mono sum: anti-phase cancels); floor at `SILENT_DB`; timestamps
  on the `t_mono_ms` clock.
- An unavailable meter answers `meter.window` with an `unsupported` error saying why — never an empty "all quiet".

## Never fork the serve process
- Spawn children with `posix_spawn` (std `Command` without `pre_exec`/uid/gid, or by hand like `WorkerHost::spawn`)
  and get a death signal another way (`setpriv --pdeathsig`, or the child sets it). Copying the address space makes
  the bus and mpv's AOs miss graph cycles. The offline `scene-loudness` CLI's `pre_exec` runs outside serve.

## Tests
- `src/player/tests/sources.rs` always opens with `ao: "null"` so runs are silent. Media come from
  `tests/common::ensure_clip` (BT.709 limited-range tagged; colours ±3, frame marker ±1).
- `bash src/player/tests/onmachine/bus.sh` (real audio, run manually) must restore the default sink and clear every
  metadata target it set, even when interrupted.
