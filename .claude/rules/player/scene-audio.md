---
paths:
  - "src/player/src/bin/liascape-scene-worker/audio.rs"
  - "src/player/src/bin/liascape-scene-worker/stretch.rs"
  - "src/player/src/audio/loudness.rs"
  - "src/player/src/scene/loudness_estimate.rs"
  - "src/player/src/scene/pkg.rs"
  - "src/player/tests/scene_loudness.rs"
---

# liascape-player: scene sound and scene loudness

The worker and the `scene` source: [scenes.md](scenes.md); the audio bus: [audio-bus.md](audio-bus.md); the backend's
loudness store: `.claude/rules/backend/library.md` § Loudness. How it works: `docs/player/modules/scene-audio.md`,
`docs/player/modules/scene-loudness.md`.

## Scene audio (`bin/liascape-scene-worker/audio.rs`, `stretch.rs`)
- Start the audio thread only once a sound is installed (at the load, or a `startsilent` one's first play: `HasAudio`,
  install on the compositor's `Gain`, `Renderer::watch_sound`); a soundless scene has none.
  Guards: `tests/scene.rs::audio_thread_only_for_a_scene_with_sound`, `tests/api.rs::a_scene_whose_sounds_all_start_silent_plays_what_its_script_starts`, `a_radio_turned_on_right_after_the_scene_is_applied_is_heard_at_once`.
- Run the process callback with `RT_PROCESS`; the callback owns the `Dsp` and the main loop never locks it
  while streaming (`try_lock` only). Guard: `tests/api.rs::scene_gain_ramp_reaches_the_bus`.
- Make the stream an async node (`node.async`) and leave the graph cleanly before exit (deactivate,
  settle, disconnect, all within `STOP_GRACE`). Stop pulling audio before `wp_context_destroy`. Guards:
  `tests/api.rs::scene_worker_exit_never_skips_bus_cycles`, `bus_producers_link_asynchronously`.
- Signal path: pull → stretch → gate → envelope → gain → clip at ±1 after the gain (WE's device clip).
  The gate jumps when the stream is silent anyway (no decode drift). Guards: `output_clips_at_full_scale_after_the_gain`,
  `gate_declicks_only_an_audible_stream`.
- The stretch is a bit-exact passthrough at exactly 1×. Guard: `time_stretch_is_bit_exact_at_1x`.
- Send `AudioFlowing` once per arming, only from a buffer that pulled real sound into a real stream. Guard:
  `tests/api.rs::scene_audio_flowing_gates_every_onset`.
- Measure audio CPU with a release worker: a debug WSOLA misses 64-frame cycles.

## Scene loudness (`audio/loudness.rs`, `scene/loudness_estimate.rs`)
- Bump `SOUND_SEMANTICS` (`scene/loudness_estimate.rs`) whenever the player's sound-object semantics change, so no
  fingerprint continues a measurement of the old sound. Guard: `fingerprint_carries_the_sound_semantics`.
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
