---
paths:
  - "src/player/src/bin/liascape-scene-worker/**"
  - "src/player/src/scene/mod.rs"
  - "src/player/src/scene/assets.rs"
  - "src/player/src/scene/pointer.rs"
  - "src/player/src/scene/synthetic.rs"
  - "src/player/src/worker/**"
  - "src/player/src/sources/scene.rs"
  - "src/player/src/gfx/dmabuf.rs"
  - "src/player/src/signal/cursor.rs"
  - "src/player/src/probe/workers.rs"
  - "src/player/tests/scene.rs"
  - "src/player/tests/worker.rs"
  - "src/player/tests/onmachine/scene*"
---

# liascape-player: WE scenes — the worker and the `scene` source

One worker process per scene source, shared by every output showing it; the compositor drives it over a
socket and samples its dmabuf frames. Crate-wide rules: [core.md](core.md); the LWE core, its build, fonts and
shader cache: [scene-lwe.md](scene-lwe.md); scene sound and loudness: [scene-audio.md](scene-audio.md); GPU budget and
VRAM: [scene-gpu.md](scene-gpu.md); backend side: [player-adapter.md](../backend/player-adapter.md).
Walkthroughs: `docs/player/modules/scene-worker.md`, `docs/player/modules/scene-source.md`,
`docs/player/modules/scene-frame-transport.md`, `docs/player/modules/scene-crash-policy.md`.

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
- `wake_fd()` is stable across restarts; register a dup. `poll(now)` never blocks; call it on every wake and every
  tick (time must pass for a hang to show).
- Count as hung only when the worker is the reason no frame comes: don't age ticks while it is starved
  of slots (ping it instead, bounded at `STARVE_LIMIT_FACTOR` × hang timeout), and give everything a fresh
  timeout after a host stall (gap > `hang_timeout / 2`). Guards: `tests/worker.rs::starved_worker_is_not_hung`,
  `starved_worker_that_hangs_is_still_killed`, `starved_forever_is_killed_after_the_starve_limit`,
  `host_stall_is_not_a_hang`, `worker_freeze_while_the_host_polls_is_hung`,
  `tests/scene.rs::gpu_stall_that_starves_the_worker_is_not_a_hang`.
- A worker is starting until its first `Frame`: one late for `Hello` whose CPU time or major faults still move, or
  late for a ping while it pages in (major faults, IO wait `D`; CPU work then is the `LoadGate`'s), is not hung (up
  to `HELLO_TIMEOUT_MAX_FACTOR` × `HELLO_TIMEOUT` from its spawn); one that stopped moving is. Guards:
  `tests/worker.rs::slow_start_is_not_a_hang`, `slow_first_render_is_not_a_hang`, `busy_first_render_is_hung`,
  `stuck_start_is_hung`, `endless_start_is_hung_at_the_cap`.
- Fold `Start`/`Paused`/`Resize`/`Route`/`SetProperty`/`Gain`/`NoAudio`/`Speed`/`LoudnessMeter` into the
  restart's `Start` so a restart never resumes stale. Guard: `restart_start_folds_live_changes`.
- A fatal `error` (can't play) is not a crash: no restart, no crash record; the caller stops the worker. Nor is an
  exit 127 (`worker::LOADER_FAILED`) before `Hello`: the host sends a fatal `RENDERER_MISSING` and marks the renderer
  missing (`worker::renderer`) until a worker's `Hello` or the probe's start clears it (the facts and what the backend
  does: `docs/player/modules/scene-crash-policy.md`). Guards:
  `tests/api.rs::worker_without_its_core_fails_without_crash_record`, `missing_renderer_is_found_again_by_the_probe`.
- `stop()`/`Drop` never block: send `quit`, hand the pid to `worker::reap`; drain the pipe first (a fatal error's
  stderr line stays in the tail). Guards: `tests/worker.rs::stop_never_blocks`, `tests/api.rs::missing_scene_folder_fails_without_crash_record`.
- End the worker with `_exit` once a scene may be live (`exit` runs driver exit handlers under LWE's video threads), log
  with `elog!`, never `eprintln!`, keep `exit_on_panic`. Guard: `tests/scene.rs::real_worker_with_video_textures_ends_cleanly`.
- Test gotcha: a sibling's `posix_spawn` briefly holds every fd (CLOEXEC too): `poll` for the hang-up before EOF.
- Keep ≤ 1 spare worker (`worker::spare`, scene-worker.md § The spare worker); its death is never a crash; adopt it
  only when launched like the scene (`sources::scene::launch_for`), reap it at once when a setting changes that; drop
  an adopted one whose load stalls for a fresh worker, never as a crash (`WorkerHost::watch_adopted_load`). Read "a
  scene is coming" from `Programs::rotation_scenes`, never a backend prop. Guards: `tests/worker.rs`, `tests/api.rs`,
  `tests/supervise.rs` `spare_*`.

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

## The `scene` source kind
- Compute scene demand only when `Graph::demand_rev` moves; never move `demand_rev` on animated values or
  observations. Guard: `demand_rev_moves_on_routing_changes_only`.
- Spawn the worker at the first demand naming an output (export at the right size); `Resize` on a
  `max_size` change re-exports into the same generation without a `None` texture. Guard:
  `tests/scene.rs::demand_change_reexports_without_black`.
- Ready = the load's first latched frame; send exactly one tick at `position` before it, paused or not.
- Pause stops ticks and latching at once (a frame in flight never latches). Guard: `tests/scene.rs::pause_freezes_picture_exactly`.
- The scene clock runs at `speed`, excises pauses, and starts at the first shown frame. Guard: `scene_clock_excises_pauses_and_scales_by_speed`.
- Judge step completion by seq (latched seq ≥ the step's tick seq), never by comparing `t` (JSON floats).
- `kind` change and `color` on a scene → `unsupported`; a `path` or `scene_dir` change = a new worker, not a crash.
- `scene_dir` = the folder the worker loads (a preset's base scene); identity — events, crash records, the loudness
  Book, snapshot — stays `path`. Guards: `tests/api.rs::scene_dir_plays_under_its_own_path`, `presets_of_one_scene_measure_apart`.
- A non-synthetic scene without a resolved assets dir fails at open with the hint and spawns no worker.
  Guard: `tests/api.rs::no_assets_dir_hides_scenes_and_errors_with_hint`.
- Every load failure (missing folder, no `project.json`, build failed) is fatal, never a restart loop.
  Guard: `tests/scene.rs::renderer_build_failure_is_broken_not_a_segfault`.
- The worker's `lia-scene-proto` thread answers pings during a load; past `LIASCAPE_SCENE_LOAD_TIMEOUT_MS` it
  keeps covering while the renderer's CPU time advances (≤ `LOAD_TIMEOUT_MAX_FACTOR` × the bound). Guards:
  `tests/scene.rs::slow_scene_load_keeps_the_heartbeat`, `starved_scene_load_outlasts_the_load_timeout`.
- `scene_fps` is WE's `fps`: tick at it uncapped by the refresh (default 15, 0 = refresh), each output presenting at most
  `eff(scene_fps, refresh)`; at 1–20 the core steps particles in halves, as WE. Guards: `tests/api.rs::scene_fps_is_wes_rate_above_the_refresh`,
  host_api_test `particle_half_steps_below_21_fps`; vs WE: `src/player/tests/onmachine/scene_fps_quirks.py`, `scene_particle_halfsteps.py`.
- Keep LWE's pointer at the scene centre until the host sends one. A pointer entering an output is a jump
  (`wp_project_pointer_jump`). Guard: `tests/api.rs::pointer_enter_is_a_jump_and_rate_is_the_demand`.
- Desktop pointer (`signal/cursor.rs`) polls Hyprland only while an unpaused scene wants it; fall back to the
  surface pointer. Guard: `tests/api.rs::desktop_pointer_from_a_fake_hyprland`.
- `scene_props` apply after load and live via `SetProperty`; a removed key keeps its value until reopened. A
  `scenetexture` set to an image or video file's absolute path shows that file in its slot (send it at open); one
  that doesn't load, or is over the caps, keeps the slot's texture — never widen the formats or caps without the
  core's (`docs/player/modules/scene-source.md` § Assets, properties, inputs).
  Guards: `tests/api.rs::scene_props_apply_at_open_and_live`, host_api_test `usertexture_loads_an_image_file`, `usertexture_caps_an_image_file`, `usertexture_plays_a_video_file`.
- Run the visualiser capture only while a ready scene `wants_audio_input`; never capture `node.virtual`
  streams or the microphone. Guard: `tests/api.rs::visualiser_input_reaches_only_scenes_that_want_it`.
- Never let a create/destroy stall the loop. Guard: `tests/api.rs::scene_create_and_destroy_never_stall_the_loop`.

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
- A crash never touches other outputs, their picture or their sound. Guards: `tests/api.rs::crash_never_touches_other_outputs`, `a_scene_workers_crash_never_drops_another_outputs_tone`.
- Hang timeout knob: `LIASCAPE_SCENE_WORKER_HANG_MS`. Guard: `tests/api.rs::hang_is_killed_and_restarted`.

## Transitions with scenes
- A scene never ends (`never_ends`): `align: end` on a scene lead A starts now. Guards:
  `scene_lead_a_align_end_starts_now`, `tests/transition.rs::scene_a_align_end_starts_at_once`.
- A scene B crashing mid-effect still hands off; a B broken mid-effect snaps back. Guards:
  `tests/transition.rs::scene_b_worker_crash_mid_effect_still_hands_off`, `scene_b_broken_mid_effect_snaps_back`.
- Interrupt-chain tests wait by condition (`.claude/rules/testing.md` § liascape-player tests). Guard:
  `tests/api.rs::scene_switch_storm_reaps_workers`.

## Corpus and health tooling
- Run `src/player/tests/onmachine/scene_corpus.sh` / `scene_health.sh` on a private headless player; they
  refuse the steamcmd cache. Never commit captures; reports go to `docs/player/reports/scene-corpus.md` and
  `docs/player/reports/scene-health.md`.
- Reproduce an LWE failure with `liascape-scene-worker --lwe-smoke <scene> --assets <dir> --out <dir>`
  (writes `health.json`); under gdb ignore throws in `Configuration::detectSteamDir`.
