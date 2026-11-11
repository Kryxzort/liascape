<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### Scene audio (Task 6)

A scene's sound is a PipeWire stream of its own worker on the player bus, driven by the
compositor's dB gains exactly like a video's `volume-gain` — the invariants (#1–#8) hold for
scenes unchanged. Worker side `src/bin/liascape-scene-worker/{audio,stretch}.rs`; compositor side
`sources/scene.rs`; the dropout reference `probe/dropout.rs` (`SceneEnvelopes`).

- **Protocol (`PROTOCOL` 2; 3 since scene loudness added `FromWorker::Loudness`, 4 since its cap added `Start.loudness` + `ToWorker::LoudnessMeter` — § "Scene loudness").** `Start` gained `id` (the source id), `gain_db` (default −96),
  `no_audio`, `speed`; `ToWorker::Speed {speed}` is new; `Gain`/`NoAudio`/`Speed` are
  **folded into the restart's `Start`** by `WorkerHost` (recorded while connected too, like
  `SetProperty`) — a restarted worker resumes at the same level/mute/speed. The worker's
  `paused` now means *play no audio*: the effective pause, or always in stepped mode (a stepped
  scene never sends `Paused {false}`). `FromWorker::AudioFlowing`, `Envelope {t0_ms,
  dbfs_1ms}` (`t0_ms` on `CLOCK_MONOTONIC`).
- **The stream** (thread `lia-scene-audio`, its own PipeWire main loop, which sends the
  envelope/`AudioFlowing`; the process callback runs on PipeWire's **data thread with
  `RT_PROCESS`** — real-time priority through the client's `module-rt`, `SCHED_RR` measured on
  `data-loop.0` — 2026-10-28, see "RT process callback" below): playback, F32 stereo 48 kHz, `node.name =
  liascape-player-scene.<id>`, `node.description = "liascape-player scene"`, `application.name =
  liascape-player`, `media.role = Wallpaper`, `node.latency = 256/48000` (requested — PipeWire
  rewrites the prop to the running quantum in `pw-dump`), `state.restore-props/target =
  false`; the route: `Device("pipewire/liascape-player-bus")` → `target.object = liascape-player-bus` +
  `node.dont-reconnect` (the compositor re-routes us, never WirePlumber), `Default` → no target,
  `Null` (`--ao null`) → a real-time timer thread pulling and discarding (so `AudioFlowing`,
  envelopes and the scene's sound clock work in hermetic tests). The thread **starts only once a
  sound is installed** (`Renderer::install_audio`: the load said `has_audio` — LWE stream count >
  0, synthetic `has_audio`) and opens the stream at once — silent then (gate shut, gain ramping
  from 0); a scene without sound has **no audio thread at all** (found by
  `transport_meets_the_spike_budget`: an always-on null timer took the worker from ~3.4–5.4 % to
  7.2 % CPU; until 2026-10-28 the thread still started at `Start` and polled for a sound 50×/s,
  0.06 % CPU for nothing — `tests/scene.rs::audio_thread_only_for_a_scene_with_sound`, RED
  before: `lia-scene-audio` in a soundless worker); a PipeWire that can't be reached →
  the same timer (keeps the sound in step with the picture, reports **no** flow), retried every
  1 s; a `Route` change fades the old stream out on the gate (≤ 100 ms bound), then rebuilds.
- **The signal path per buffer (`audio::Dsp`, pure, unit-tested):** pull (LWE's
  `wp_context_audio_pull`, or the synthetic `Tone` — `tone_hz`/`tone_dbfs` peak, `has_audio`)
  through the time stretch → **gate** → envelope → **gain** → **clip**.
  - **Clip**: every sample clamped to ±1 after the gain — Wallpaper Engine's device clip (mediaextensions64.dll's
    miniaudio: `noClip` off + an f32 device → its clip loop, the Leftovers batch), which comes after each sound's
    `volume²` and the wallpaper's level, so a lower gain (the user's level, the normalization) still leaves peaks
    whole. Unit `output_clips_at_full_scale_after_the_gain`.
  - **Gain**: the compositor's `Gain {db}` (`Gains::effective_db()` of the source's `gain.*`
    slots, sent on every slot change — the 1 kHz `push_gain` path included — and re-sent at
    every `Ready`), interpolated **linearly in amplitude** from the previous to the latest across
    one buffer (`(i+1)/n`, last sample exact); ≤ −96 dB is exact `0.0` (`audio::gain_lin`).
  - **Gate** — the worker's own 30 ms linear anti-click (`ANTICLICK_FRAMES` 1440, counted in
    whole frames so its ends are exact): open while the scene *plays* (a source installed, not
    paused, not `no_audio`, not quitting), closed otherwise. **When the stream is silent anyway**
    (applied and target gain both 0) it jumps — so the normal "compositor ramps, then pauses"
    pulls not one sample more (no decode drift) and an un-pause at −96 starts at once. It is what
    fades a restarted worker in at its folded `Start.gain_db`, and an audible pause / mute /
    route change / quit out (still pulling for those 30 ms). `no_audio` on → ≤ −90 dB within
    100 ms (measured −96 in every block 100–350 ms after).
  - **Pull lock**: the source sits in a `Mutex`; the callback `try_lock`s (a miss = silence
    for that buffer: only at install/remove); the renderer `remove()`s it (waiting for a pull in
    flight) before an LWE scene is dropped (`fatal`) — *stop pulling before `wp_context_destroy`*.
- **Time stretch (`stretch::Stretch`, owner decision: speed scales the sound, pitch kept).**
  WSOLA: 20 ms periodic-Hann segments (`WIN` 960) overlapped by half (`HOP` 480), segment `j`
  taken near input `j·speed·HOP` at the ±10 ms (`SEARCH` 480) offset whose first hop best
  matches the last segment's natural continuation (normalised cross-correlation of the L+R
  mono, a coarse pass on every 4th sample/candidate, then a ±3 full-resolution refine). **At
  exactly 1× it is a passthrough** — pulled straight into the output, bit-exact, no added
  latency; leaving 1× starts WSOLA at the current position (the next hop is the first overlap),
  returning continues at the last segment's natural continuation (the overlap-add would give the
  input there: the window halves sum to 1) — continuous both ways. The scene clock and the
  stream both follow `speed` (the `Speed` message; stepped: never). Measured (unit, 440 Hz,
  period 109.09 frames — no hop is whole periods): pitch 440.01 Hz at 0.5×/1.5×/0.1×/4×
  (440.06 at 0.73×), 25 ms-block level −9.031 ± 0.003 dB (amplitude 0.5), input consumed at
  speed + 0.01 (the look-ahead), the largest sample step across 1→1.5→0.5→1 switches 0.02879 vs
  the tone's own 0.02880. RED (search disabled → nominal positions): 419.99 Hz and −9.86 dB at
  0.5×. On the real scene's sound (2371103399, `--lwe-smoke --audio-dump 6`): no exact-silent
  1 ms block in the input or in the 0.5×/1.5× output.
- **`AudioFlowing` (invariant #8).** Worker: an arming counter (a `Start` that plays, `Paused
  {false}`, `NoAudio {false}`, a `Route`); the first buffer after it that *pulled the scene's
  sound into a real stream* (not the fallback timer, not before the load) sends one. Compositor:
  `flow_armed` (open-unpaused, un-pause, `no_audio` off, a route change, a path change) + the
  worker's message (`flow_seen`) → `SourceEvent::AudioFlowing` once the load is shown and not
  paused; at once (no wait) when stepped, `has_audio: false`, or `no_audio`. Known window: an
  `AudioFlowing` from an *earlier* arming that arrives after a re-arm counts (≤ a few ms: the
  worker resumes pulling at its next callback) — no epoch in the protocol.
- **Quit.** `Control::quit(200 ms)`: playing = false → the gate closes (at once if silent),
  then the process exits once the stream's level (`applied × gate`) is exactly 0 — on `Quit`,
  on EOF, and on a quit during a load (`_exit` after it). The compositor's retire ramp
  normally made it silent already: destroy of a playing tone scene measured 28 ms from −1 dB to
  silence on the bus, then the node is gone. **Then the stream leaves the graph before the exit
  (F7):** `set_active(false)` + a core roundtrip, `SETTLE_INACTIVE` 20 ms, `disconnect` + a
  roundtrip (all within `CLOSE_MAX` 200 ms — under the host's `STOP_GRACE`; the audio thread then
  parks, never reconnecting). Exiting with the stream active in the graph cost the bus whole graph
  cycles of exact silence at the sink in *every* S→S switch (B's sound: 64–384 samples; frozen 60/61,
  full-live 30/30 — `tests/onmachine/scenes.sh onsetrec` records the sink independently); a bare
  disconnect of the active stream still 18/60; deactivate-first left 2–8 single cycles per 60
  full-live/reveal switches (0/121 frozen — B still silent at that instant, so invisible), at the
  deactivation. **That residual was a libpipewire race on a synchronous link (2026-11-04):** the
  worker's stream is now an **async node** (`node.async = true` in its props; § Audio bus → "Async
  streams"), so the bus never waits for it and its deactivation can't cost a cycle: 0 runs in 60
  full-live switches (two release runs, the server's profiler: 0 xrun cycles). Tests
  `tests/api.rs::scene_worker_exit_never_skips_bus_cycles` (full-live, 20 switches; RED 6/6 before
  the clean leave, 1 in ~10 before async), `bus_producers_link_asynchronously`.
- **Envelope → dropout reference.** 1 ms max-channel RMS dBFS of the gated, pre-gain samples
  (`audio::meter::BlockMeter`; `meter::dbfs_block` is the shared one-block form), batched every
  50 blocks, stamped with the buffer's play time (`CLOCK_MONOTONIC` now + one buffer). The
  compositor maps it onto the log's `t_mono_ms` (the meter's clock) and keeps ≤ 10 s
  (`take_envelope`); `Runtime::record_scene_envelopes` (every `update_sources`) files it into
  `SceneEnvelopes` (≤ 40 000 entries per scene, dead ones kept `DEAD_LINGER`, ≤ 16 tracks;
  `loop` probe bounds `scene_envelope_tracks/samples`); `SourceWindow.envelope` → the
  expected mix uses it instead of an ffmpeg decode (`envelope_power_bins`: 10 ms power means,
  silent where nothing arrived). Measured: S→S `probe dropout` lag 2–3 ms, fit 0.06 dB, offset
  0.0. **Pre-existing, found here:** a video's reference reads its mono clip ~3 dB hot (mpv
  upmixes mono → stereo at −3 dB per channel; the `-ac 1` decode doesn't), so V↔S fits show
  1.2–1.6 dB and a −2 dB `offset_db` (absorbed; no drops) — the video side, not the scene's.
- **RT process callback (the `scene_gain_ramp_reaches_the_bus` flake, 2026-10-28).** The flake
  (~2/10: one 10 ms bin −44.3 dB after the ramp settled at −43, failing the monotonic check) was a
  **real dropout on the bus**, not the meter: the 1 ms samples showed one block −45.4 and the next
  exact −96 (one 64-frame quantum of silence, contiguous timestamps) at a random time — not at the
  ramp — and `pw-top` counted **ERR on `liascape-player-scene.*` only** (bus, its playback and the meter
  0): the worker's stream missed graph cycles. Its process callback ran on the non-real-time
  `lia-scene-audio` main-loop thread; at the 64-frame quantum this machine and the private
  PipeWire run (1.33 ms per cycle), a normal-priority thread scheduled late under load ~4 misses
  one. mpv's AO uses `RT_PROCESS` (why videos never showed it). Fix: `RT_PROCESS` (`bus::
  connect_with`); the callback owns the `Dsp` (`Arc<Mutex<Dsp>>`, never locked by the main loop
  while streaming — no priority inversion), the envelope goes through `Outbox` (`try_lock`; a held
  lock leaves the blocks for the next buffer) and `AudioFlowing`/the level are atomics; the route
  close checks `Control::level()`. Measured (private PipeWire, 60 ramp cycles ≈ 100 s at load ~4,
  same build with the flag toggled): without RT 7 xruns, 3 failing dips; with RT **0 xruns, 0
  dips**; the test 20/20 after. The Task 10 commit's base had the same code (`audio.rs` unchanged
  since Task 6). **A second, measurement-side hazard found with it:** the bus meter's own capture
  (then on the non-RT `lia-bus` thread — RT since Phase 2 Task 14, § Audio bus → Meter) once missed a cycle — a 2.3 ms timestamp gap whose
  block joins two non-adjacent sine pieces (~1 dB off); the test now leaves out a 10 ms bin that
  isn't time-contiguous (≤ 2 allowed) — a dropout on the bus is contiguous −96 blocks and still
  fails.
- **Probe `workers` → `audio`**: `{route, gain_db, no_audio, has_audio, speed, flow_armed,
  flows, envelope_dbfs, envelope_blocks}`.
- **Measured** (private PipeWire, 64-frame graph quantum): a −20 dBFS tone scene on the bus
  −23.01 dB (power mean); an `animate gain.user` 0 → −20 over 300 ms lands as a dB-linear
  staircase-free ramp (10 ms bins −23.0 … −43.0, ≤ 0.7 dB per bin); full-live crossfades with
  equal-level unrelated tones keep the bus power within ±0.13 (V→S), ±0.23 (S→S), ±0.96 dB
  (S→V, the video's onset hold) of steady through a 1 s fade — equal power holds. The real scene
  2371103399 at 1×/1.5×/0.5× on the bus: **release worker** 0 silent 1 ms blocks in 5 s each,
  CPU 5.4 / 6.5 / 5.1 % of a core (the audio thread 1.5 / 2.5 / 1.9 %); a **debug** worker's
  WSOLA step (~0.35 ms) misses 64-frame cycles — 1–2 ms holes every 10–20 ms at ≠ 1× (none at
  1×; audio thread 5–14 %). Ship/measure release.
- **Tests.** Worker units (`cargo test --bin liascape-scene-worker`): `gain_change_ramps_across_one_buffer`,
  `silent_db_is_exact_zero`, `gain_matches_db_to_lin`, `envelope_of_full_scale_sine_is_minus_3_01`,
  `gate_declicks_only_an_audible_stream`, `audio_flowing_once_per_arming`,
  `time_stretch_is_bit_exact_at_1x`, `time_stretch_keeps_pitch_level_and_rate`,
  `time_stretch_speed_changes_are_continuous` (RED with a stepped gain / no gate / no search).
  Lib: `restart_start_folds_live_changes` (+ Gain/NoAudio/Speed), `dropout_uses_scene_envelope_as_reference`.
  `tests/api.rs` (private PipeWire `tests/common/pw.rs::PrivatePw` — moved from `api.rs`;
  SKIP without the binaries): `scene_audio_on_bus_with_identity`, `scene_gain_ramp_reaches_the_bus`,
  `scene_no_audio_toggle_is_live`, `scene_crossfades_are_equal_power_on_the_bus` (V→S, S→S,
  S→V + `probe dropout` each: fit ok, no drops/micro-gaps), `scene_pause_park_and_destroy_on_the_bus`,
  `scene_reroutes_after_pipewire_restart` (the I7 pattern: back on the bus, `gain.pause` ramp-in
  `reason: flowed`, same worker); `--ao null`: `scene_audio_flowing_gates_every_onset` (frozen
  V→S, full-live S→S onto a scene with and without sound, unpark, reveal snap-back, R88 resume —
  each `onset.started {reason: flowed}` after the scene's own `source.audio_flowing`, no
  `onset_timeout`; RED with the worker's `AudioFlowing` suppressed: `reason: timeout`); opt-in
  `real_scene_sound_on_the_bus` (`LIASCAPE_PLAYER_TEST_SCENES`, 2371103399; set `LIASCAPE_SCENE_WORKER_BIN`
  to a release worker for the numbers above). Diagnostic: `liascape-scene-worker --lwe-smoke …
  --audio-dump S` (real sound in, the stretch at 0.5×/1.5× out, raw F32 files + silent-block
  counts).
- **For Tasks 8/9/10/11 + loudness.** Task 9: nothing audio-specific left — a scene B's onset
  waits for its flow like a video's. Task 10: a crash restart resumes at the folded gain, faded
  in over 30 ms by the gate (the crash itself cuts — the process is gone); `Ready` re-sends the
  gain. Loudness learned on first play: done — not from the `SceneEnvelopes` track (1 ms
  max-channel RMS, no K-weighting) but from the worker's own K-weighted segments, § "Scene
  loudness" below. Task 11: `no_audio`/`gain.*`/`speed` on a scene are live like a video's.
