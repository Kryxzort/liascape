---
paths:
  - "src/player/src/bin/liascape-scene-worker/**"
  - "src/player/src/scene/**"
  - "src/player/src/worker/**"
  - "src/player/src/sources/scene.rs"
  - "src/player/src/gfx/dmabuf.rs"
  - "src/player/src/vram.rs"
  - "src/player/src/redraw.rs"
  - "src/player/src/audio/loudness.rs"
  - "src/player/src/signal/cursor.rs"
  - "src/player/src/probe/workers.rs"
  - "src/player/src/probe/vram.rs"
  - "src/player/build.rs"
  - "src/player/tests/scene.rs"
  - "src/player/tests/worker.rs"
  - "src/player/tests/lwe_build.rs"
  - "src/player/tests/scene_loudness.rs"
  - "src/player/tests/onmachine/scene*"
  - "patches/lwe/**"
  - "third_party/lwe/**"
  - "scripts/lwe.sh"
---

# liascape-player: WE scenes (`liascape-scene-worker`)

One worker process per scene source, shared by every output showing it; the compositor drives it over a
socket and samples its dmabuf frames. Crate-wide rules: [core.md](core.md); transitions/runtime:
[runtime-api.md](runtime-api.md); backend side: [player-adapter.md](../backend/player-adapter.md).
Walkthroughs: `docs/player/modules/scene-worker.md` and its siblings (`docs/player/modules/scene-frame-transport.md`,
`docs/player/modules/scene-lwe-core.md`, `docs/player/modules/scene-crash-policy.md`, …).
Measurements: `docs/player/spikes/dmabuf.md`, `docs/player/spikes/lwe-core.md`, `docs/player/reports/phase2.md`.

## Protocol (`worker/proto.rs`)
- Bump `PROTOCOL` on any message shape change; the host turns a `Hello` with another protocol into a fatal error.
- Tag messages with `msg`, never `t` (`Tick`/`Frame` use `t` for scene time). One JSON object per
  `SOCK_SEQPACKET` datagram, ≤ `MAX_MSG`, fds via `SCM_RIGHTS` ≤ `MAX_FDS`; send with `MSG_NOSIGNAL`.
- `proto::recv` never blocks; a garbage datagram is consumed (its fds closed) and the next one parses.

## Worker host lifecycle (`worker/mod.rs`)
- Spawn with `posix_spawn` from a thread that outlives the worker (the loop): `PR_SET_PDEATHSIG` fires when
  the spawning thread exits, so never spawn from an `lia-open` pool thread. Open scene sources on the loop
  for the same reason. Guard: `tests/worker.rs::worker_dies_with_its_parent`.
- The worker sets PDEATHSIG first, exits 3 if `getppid()` ≠ `--parent-pid`, then sets soft `RLIMIT_CORE` 1
  (`skip_core_handler`) so a crash never reaches systemd-coredump; `LIASCAPE_SCENE_WORKER_COREDUMP=1` opts out.
  Guard: `tests/api.rs::scene_worker_crashes_skip_the_core_handler`.
- Child fds: socket at fd 3, parent copies `CLOEXEC` and renumbered ≥ 10 before `dup2`; empty signal mask
  and default dispositions (the compositor blocks SIGINT/SIGTERM). The worker keeps its socket `CLOEXEC`:
  EOF is the crash signal.
- `wake_fd()` is an epoll fd over the current socket + pipe, stable across restarts; register a dup.
- `poll(now)` never blocks; call it on every wake and every tick (time must pass for a hang to show).
- Count as hung only when the worker is the reason no frame comes: don't age ticks while it is starved
  of slots (ping it instead, bounded at `STARVE_LIMIT_FACTOR` × hang timeout), and give everything a fresh
  timeout after a host stall (gap > `hang_timeout / 2`). Guards: `tests/worker.rs::starved_worker_is_not_hung`,
  `starved_worker_that_hangs_is_still_killed`, `starved_forever_is_killed_after_the_starve_limit`,
  `host_stall_is_not_a_hang`, `worker_freeze_while_the_host_polls_is_hung`,
  `tests/scene.rs::gpu_stall_that_starves_the_worker_is_not_a_hang`.
- Fold `Start`/`Paused`/`Resize`/`Route`/`SetProperty`/`Gain`/`NoAudio`/`Speed`/`LoudnessMeter` into the
  restart's `Start` so a restart never resumes stale. Guard: `restart_start_folds_live_changes`.
- A fatal `error` (can't play) is not a crash: no restart, no crash record; the caller stops the worker.
- `stop()`/`Drop` never block: send `quit`, hand the pid to the `worker::reap` thread. Drain the pipe
  first so a fatal error's stderr line stays in the log tail. Guards: `tests/worker.rs::stop_never_blocks`,
  `tests/api.rs::missing_scene_folder_fails_without_crash_record`.
- Test gotcha: a sibling test's `posix_spawn` briefly holds copies of every fd (CLOEXEC too) — `poll` for
  the hang-up before reading EOF.

## Build (`build.rs`, LWE core)
- Only `liascape-scene-worker` links LWE (`cargo::rustc-link-arg-bin`); the compositor binary never does.
  Guard: `tests/lwe_build.rs::worker_links_the_core`.
- Feature `lwe` is default; without `LIASCAPE_LWE_CORE_DIR` the build fails by design. `--no-default-features`
  = stub + synthetic only.
- The pin lives in `third_party/lwe/PIN`; `UPSTREAM.md` § linux-wallpaperengine owns the patch series and
  resync recipe. Guards: `tests/lwe_build.rs::core_is_the_pinned_one`, `pin_matches_flake`.
- Patch work: `LWE_DEV_SRC=<fork> bash scripts/lwe.sh build test`. Inside the devShell override
  `LIASCAPE_LWE_CORE_DIR` to a writable dir — the devShell's points at the read-only store.
- The LWE headers are C++-only: declare the C calls by hand in `bin/liascape-scene-worker/lwe.rs`; keep
  `patches/lwe/tests/host_api_test.cpp` C++.
- Never copy WE's JS classes (`<assets>/scripts/jsclasses`, `<assets>/scripts/jsmodules`) into the repo or fork: LWE reads them
  from the assets dir at run time.
- Bump `SOUND_SEMANTICS` (`scene/loudness_estimate.rs`) whenever the player's sound-object semantics
  change, so no fingerprint continues a measurement of the old sound. Guard:
  `fingerprint_carries_the_sound_semantics`.
- Stop pulling audio before `wp_context_destroy`.

## Frame transport (`gfx/dmabuf.rs`, `worker/dmabuf.rs`, `sources/scene.rs`)
- Latch only the newest frame whose acquire fence already polls readable; release older queued frames
  without a fence; never wait on a fence on the loop (no `gpu_wait_fence` for a signalled fence). Nothing
  ready → reuse the previous frame (never black, never a wait). Guards:
  `latch_takes_newest_signalled_and_releases_the_rest`, `tests/scene.rs::latch_never_waits_on_an_unsignalled_fence`,
  `transport_never_shows_stale_torn_or_out_of_order`.
- Never use `glFinish` in the worker (spins a core under load): fence, fdpoll, or a bounded `glClientWaitSync`.
- Force alpha to 1 in the worker (LWE leaves 0); no flip (image top at texture row 0). Guards:
  `tests/scene.rs::scene_frame_is_opaque`, `scene_texture_holds_image_top_at_t0`.
- Refuse external-only modifiers (LINEAR on NVIDIA) and displays lacking dmabuf import, native fence sync
  or wait sync — there is no CPU-copy path. Guard: `external_only_modifier_is_refused`.
- Destroy imported `EglImage`s via `free_image_off_thread`, never on the loop (NVIDIA's global RM lock).
  Imports stay on the loop inside `runtime::driver_call` so their sleeps are accounted apart.
- After a restart, `Latch::forget_worker()` keeps the shown frame but never releases it (the new worker
  never had that slot). Keep slot ids unique per worker lifetime. Guards:
  `forget_worker_keeps_the_frame_and_never_releases_it`, `tests/scene.rs::killed_worker_keeps_last_frame`,
  `restart_replaces_ring_after_first_new_frame`.
- Keep ≤ `MAX_INFLIGHT` unanswered ticks and skip ahead when behind (never burst).
- Add each queued frame's acquire fence to the source's epoll one-shot, so a signalled fence wakes a stepped
  loop. Guard: `tests/api.rs::stepped_scene_is_deterministic`.
- Ask for a low-priority context only in the worker; compositor contexts keep the driver default.
  Guard (load-sensitive, rerun on a quiet machine): `tests/scene.rs::worker_context_is_low_priority`.
- Field is `generation`, not `gen` (reserved in edition 2024).

## The `scene` source kind
- Compute scene demand only when `Graph::demand_rev` moves; never move `demand_rev` on animated values or
  observations. Guard: `demand_rev_moves_on_routing_changes_only`.
- Spawn the worker at the first demand naming an output (export at the right size); `Resize` on a
  `max_size` change re-exports into the same generation without a `None` texture. Guard:
  `tests/scene.rs::demand_change_reexports_without_black`.
- Ready = the load's first latched frame; send exactly one tick at `position` before it, paused or not.
- Pause stops ticks and latching at once (a frame in flight never latches). Guard:
  `tests/scene.rs::pause_freezes_picture_exactly`.
- The scene clock runs at `speed`, excises pauses, and starts at the first shown frame. Guard:
  `scene_clock_excises_pauses_and_scales_by_speed`.
- Judge step completion by seq (latched seq ≥ the step's tick seq), never by comparing `t` (JSON floats).
- `kind` change and `color` on a scene → `unsupported`; `path` change = a new worker, not a crash.
- A non-synthetic scene without a resolved assets dir fails at open with the hint and spawns no worker.
  Guard: `tests/api.rs::no_assets_dir_hides_scenes_and_errors_with_hint`.
- Every load failure (missing folder, no `project.json`, build failed) is fatal, never a restart loop.
  Guard: `tests/scene.rs::renderer_build_failure_is_broken_not_a_segfault`.
- The worker's `lia-scene-proto` thread answers pings during a load; past `LIASCAPE_SCENE_LOAD_TIMEOUT_MS` it
  keeps covering while the renderer's CPU time advances (≤ `LOAD_TIMEOUT_MAX_FACTOR` × the bound). Guards:
  `tests/scene.rs::slow_scene_load_keeps_the_heartbeat`, `starved_scene_load_outlasts_the_load_timeout`.
- `scene_fps` is WE's `fps`: tick at it uncapped by the refresh (default 15, 0 = refresh); each output
  presents at most `eff(scene_fps, refresh)`. Guard: `tests/api.rs::scene_fps_is_wes_rate_above_the_refresh`.
- Keep LWE's pointer at the scene centre until the host sends one. A pointer entering an output is a jump
  (`wp_project_pointer_jump`). Guard: `tests/api.rs::pointer_enter_is_a_jump_and_rate_is_the_demand`.
- Desktop pointer (`signal/cursor.rs`) polls Hyprland only while an unpaused scene wants it; fall back to the
  surface pointer. Guard: `tests/api.rs::desktop_pointer_from_a_fake_hyprland`.
- `scene_props` apply after load and live via `SetProperty`; a removed key keeps its value until reopened.
  Guard: `tests/api.rs::scene_props_apply_at_open_and_live`.
- Run the visualiser capture only while a ready scene `wants_audio_input`; never capture `node.virtual`
  streams or the microphone. Guard: `tests/api.rs::visualiser_input_reaches_only_scenes_that_want_it`.
- Never let a create/destroy stall the loop. Guard: `tests/api.rs::scene_create_and_destroy_never_stall_the_loop`.

## Scene audio (`bin/liascape-scene-worker/audio.rs`, `stretch.rs`)
- Start the audio thread only once a sound is installed; a soundless scene has no audio thread. Guard:
  `tests/scene.rs::audio_thread_only_for_a_scene_with_sound`.
- Run the process callback with `RT_PROCESS`; the callback owns the `Dsp` and the main loop never locks it
  while streaming (`try_lock` only). Guard: `tests/api.rs::scene_gain_ramp_reaches_the_bus`.
- Make the stream an async node (`node.async`) and leave the graph cleanly before exit (deactivate,
  settle, disconnect, all within `STOP_GRACE`). Guards: `tests/api.rs::scene_worker_exit_never_skips_bus_cycles`,
  `bus_producers_link_asynchronously`.
- Signal path: pull → stretch → gate → envelope → gain → clip at ±1 after the gain (WE's device clip).
  The gate jumps when the stream is silent anyway (no decode drift). Guards: `output_clips_at_full_scale_after_the_gain`,
  `gate_declicks_only_an_audible_stream`.
- The stretch is a bit-exact passthrough at exactly 1×. Guard: `time_stretch_is_bit_exact_at_1x`.
- Send `AudioFlowing` once per arming, only from a buffer that pulled real sound into a real stream. Guard:
  `tests/api.rs::scene_audio_flowing_gates_every_onset`.
- Measure audio CPU with a release worker: a debug WSOLA misses 64-frame cycles.

## Scene loudness (`audio/loudness.rs`)
- Meter after the stretch, before gate and gain; count only buffers that play into a real stream (never
  paused, `no_audio`, fallback timer, stepped). Guard: `loudness_segments_count_only_played_sound`.
- Keep a histogram, not results (BS.1770's relative gate needs all blocks). Guard:
  `histogram_merge_across_sessions_equals_one_long_integration`.
- One measurement per (canonical folder, `loudness_key`) in the `Book`: one live source measures (the
  head); a seed is adopted only if it covers more audible play, never merged — no block counted twice.
  Guards: `book_reopen_continues_the_last_source_never_twice`,
  `tests/api.rs::scene_path_changes_and_folder_spellings_share_one_measurement`,
  `scene_loudness_key_change_never_shares_a_histogram`.
- On a live `loudness_key` change report the old key's rest under the old key, join the new key without
  `Book::forget_idle`, and drop segments for `KEY_CHANGE_SETTLE` (the stream still carries the old mix). Guard:
  `tests/api.rs::scene_loudness_key_change_never_shares_a_histogram`.
- Stop metering at the cap (`LoudnessMeter {on: false}`). Guards: `cap_stops_measuring`,
  `tests/api.rs::scene_loudness_stops_at_the_cap`.
- A report never moves the playing source's `gain.normalize` (the backend applies it once per play). Guard:
  `tests/api.rs::scene_loudness_is_learned_once_after_its_window`.

## GPU budget and VRAM (`scene/budget.rs`, `vram.rs`, `redraw.rs`)
- Gate each output's scene presents on its own `scene_fps` grid, deferring early frames, never dropping.
  A scene at the refresh on a frame-callback output is ungated and presents every callback. Guards:
  `scene_frames_wake_each_output_at_its_scene_fps`, `scene_at_the_refresh_is_paced_by_frame_callbacks_not_the_gate`,
  `tests/api.rs::per_output_scene_fps_gates_presents`.
- Throttle only when misses exceed `THROTTLE_MISSED_PCT` and the worker uses ≥ `GPU_LOAD_MS_PER_S`; read
  misses from the worst output, not only the scene's. Guards: `budget_ignores_misses_a_light_worker_cannot_cause`,
  `budget_miss_rate_is_the_worst_output_not_only_the_scenes`, `tests/scene.rs::scene_budget_throttles_live_and_recovers`.
- Never wait on a `GL_TIME_ELAPSED` query; read it once available.
- Run VRAM probes on `lia-vram`, never the loop; dlopen NVML, never link it.
- A scene over `scene_vram_limit_mib` is stopped, not crashed (no restart, no record), keeping only its shown
  slot. Guards: `tests/api.rs::scene_over_vram_limit_is_stopped_not_crashed`,
  `tests/scene.rs::vram_stopped_scene_keeps_only_its_shown_slot`.
- The low-VRAM hold composes into the effective pause (never `player.paused`); `stop` mode suspends every
  media source and resumes each at its position; the reserve keeps freed memory from reading as free.
  Guards: `low_vram_never_flaps_under_light_load`, `low_vram_releases_when_the_probe_dies`,
  `tests/api.rs::low_vram_stop_frees_and_resumes_every_source`, `low_vram_pause_mode_pauses_without_freeing`.

## Crash policy
- A crash or hang holds the last frame (else the preview), restarts ≤ 3 in 60 s at the held frame's `t`
  (`hold_for_restart` stops the clock), then the source is broken: silent, held, `source.broken` once.
  Guards: `tests/scene.rs::crash_holds_last_frame_and_resumes_at_position`, `crash_before_first_frame_shows_preview`,
  `tests/api.rs::broken_after_three_restarts_in_60s`, `source_broken_event_names_the_scene`.
- Open the preview only on crash paths and restored-broken scenes (it is synchronous on the loop).
- `ContextLost` = a crash restart through the same budget (`kill_for_restart`). Guard:
  `tests/scene.rs::context_lost_is_a_restart`.
- Save `broken: true` in the snapshot and restore it as its preview with no worker, so a restart never
  gives a crash-looping scene a fresh budget. Guards: `broken_scene_is_saved_and_recreated_broken`,
  `tests/supervise.rs::broken_scene_restores_as_preview`.
- `loading` is true only while a live worker is inside its load. Guard: `tests/scene.rs::scene_loading_spans_the_load_only`.
- A crash never touches other outputs. Guard: `tests/api.rs::crash_never_touches_other_outputs`.
- Hang timeout knob: `LIASCAPE_SCENE_WORKER_HANG_MS`. Guard: `tests/api.rs::hang_is_killed_and_restarted`.

## Transitions with scenes
- A scene never ends (`never_ends`): `align: end` on a scene lead A starts now. Guards:
  `scene_lead_a_align_end_starts_now`, `tests/transition.rs::scene_a_align_end_starts_at_once`.
- A scene B crashing mid-effect still hands off; a B broken mid-effect snaps back. Guards:
  `tests/transition.rs::scene_b_worker_crash_mid_effect_still_hands_off`, `scene_b_broken_mid_effect_snaps_back`.
- Write interrupt-chain tests with gaps by condition, not fixed 100 ms (a worker's first frame takes longer).
  Guard: `tests/api.rs::scene_switch_storm_reaps_workers`.

## Corpus and health tooling
- Run `src/player/tests/onmachine/scene_corpus.sh` / `scene_health.sh` on a private headless player; they
  refuse the steamcmd cache. Never commit captures; reports go to `docs/player/reports/scene-corpus.md` and
  `docs/player/reports/scene-health.md`. `--ab-legacy` draws on a real output: owner-run only.
- Reproduce an LWE failure with `liascape-scene-worker --lwe-smoke <scene> --assets <dir> --out <dir>`
  (writes `health.json`); under gdb ignore throws in `Configuration::detectSteamDir`.
