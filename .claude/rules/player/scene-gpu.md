---
paths:
  - "src/player/src/scene/budget.rs"
  - "src/player/src/vram.rs"
  - "src/player/src/redraw.rs"
  - "src/player/src/probe/vram.rs"
  - "src/player/src/bin/liascape-scene-worker/gputimer.rs"
---

# liascape-player: scene GPU budget, VRAM limit and the low-VRAM hold

The worker and the `scene` source: [scenes.md](scenes.md); the backend's settings for these:
[player-adapter.md](../backend/player-adapter.md) § Scenes and loudness. How it works: `docs/player/modules/scene-gpu-budget.md`.

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
- Under `player.scene_vram_stop_shows` `nothing` a VRAM-stopped scene hides that slot (`SceneSource::shows_nothing`,
  never dropped, so the choice is live both ways) and the seam probe skips it; a layer waiting for a picture takes
  that blank as one (`SceneSource::hides_a_picture`). Guards: `tests/api.rs::scene_over_vram_limit_can_show_nothing`,
  `output_added_while_a_vram_stop_shows_nothing_keeps_the_scene`.
- Compose the low-VRAM hold into the effective pause (never `player.paused`); `stop` mode suspends every media source
  and resumes each at its position; the reserve keeps freed memory from reading as free. Guards:
  `low_vram_never_flaps_under_light_load`, `low_vram_releases_when_the_probe_dies`,
  `tests/api.rs::low_vram_stop_frees_and_resumes_every_source`, `low_vram_pause_mode_pauses_without_freeing`.
- Count only this player's own pids in the reserve (compositor, scene workers, spare) and keep it to the held sources
  that can still come back: one replaced by a transition, retired or destroyed drops its share at once
  (`Runtime::vram_gone`, `LowVram::set_reserve`) and never reopens; `stop` clears the hold. Resume at low +
  `RESUME_MARGIN_MIB`; anti-flap's doubling hold is the loop guard, never a wider bar. Guards:
  `low_vram_high_usage_resumes_at_the_resume_bar`, `low_vram_reserve_follows_the_held_sources`,
  `tests/api.rs::low_vram_apply_while_held_plays_once_memory_allows`, `low_vram_stop_clears_the_hold`,
  `low_vram_replaced_source_drops_its_reserve`.
- Say what the hold keeps and why: `hello.vram_hold` / `state.vram_hold`, `vram.held {sources, reason, free_mib,
  needed_mib}` / `vram.released {reason}` → the backend's WS `vram-hold` → the now-playing line. Guards: the low_vram
  tests above, adapter IT § "the low-VRAM hold is visible", probe-matrix `vram:held`.
