# Scene audio

Covers `src/player/src/bin/liascape-scene-worker/audio.rs` (stream, `Dsp`) and `stretch.rs` (WSOLA), and the audio
half of `src/player/src/sources/scene.rs`. Rules: `.claude/rules/player/scenes.md` § Scene audio; invariants #8 and
#11 in `docs/player/invariants.md`.

A scene's sound is a PipeWire stream of its own worker on the player bus, driven by the compositor's dB gains
exactly like a video's `volume-gain`; every audio invariant holds for scenes unchanged.

## The stream

Thread `lia-scene-audio` runs its own PipeWire main loop; the process callback runs on PipeWire's RT data thread
(`RT_PROCESS`). Playback is F32 stereo 48 kHz, `node.name = liascape-player-scene.<id>`, `application.name =
liascape-player`, `media.role = Wallpaper`, `state.restore-props/target = false`, and an async node (see
[audio-bus.md](audio-bus.md) § Async streams). Route `Device(bus)` → `target.object = liascape-player-bus` +
`node.dont-reconnect` (the compositor re-routes, never WirePlumber); `Default` → no target; `Null` (`--ao null`) → a
real-time timer that pulls and discards, so `AudioFlowing`, envelopes and the sound clock work in hermetic tests.
PipeWire unreachable → the same timer (no flow reported), retried every 1 s. A route change fades the old stream out
on the gate, then rebuilds.

The thread starts only once a sound is installed (LWE's stream count > 0); a soundless scene has no audio thread at
all — an always-on null timer cost the worker ~2 % CPU for nothing.

**Why RT:** at a 64-frame quantum (1.33 ms per cycle) a normal-priority callback scheduled late under load misses
cycles: one quantum of silence on the bus at random times, `pw-top` ERR on the scene stream only. mpv's AO already
used `RT_PROCESS`. The callback owns the `Dsp`; the main loop never locks it while streaming (no priority inversion),
the envelope and loudness segments leave through a `try_lock` outbox, `AudioFlowing` and the level are atomics.

## Signal path per buffer (`audio::Dsp`)

pull (LWE's `wp_context_audio_pull`, or the synthetic tone) → time stretch → gate → envelope/loudness meter → gain →
clip.

- **Gain:** the compositor's `Gain {db}` (`Gains::effective_db()`, sent on every slot change including the 1 kHz
  path, re-sent at every `Ready`), interpolated linearly in amplitude across one buffer; ≤ −96 dB is exact 0.
- **Gate:** the worker's own 30 ms linear anti-click (`ANTICLICK_FRAMES`, whole frames so its ends are exact), open
  while the scene plays (not paused, not `no_audio`, not quitting). When the stream is silent anyway (applied and
  target gain both 0) it jumps, so "compositor ramps, then pauses" pulls not one sample more (no decode drift) and an
  un-pause at −96 starts at once. It fades a restarted worker in at its folded gain and an audible pause, mute, route
  change or quit out.
- **Clip** at ±1 after the gain: Wallpaper Engine's device clip (miniaudio with an f32 device), which comes after
  each sound's `volume²` and the wallpaper's level — so a lower gain still leaves peaks whole.
- **Pull lock:** the callback `try_lock`s the pull source (a miss = one buffer of silence, only at install/remove);
  the renderer removes it before an LWE scene is dropped — never pull after `wp_context_destroy`.

## Time stretch (`stretch::Stretch`)

Speed scales a scene's sound with pitch kept. WSOLA: 20 ms periodic-Hann segments overlapped by half, each taken at
the ±10 ms offset whose first hop best matches the previous segment's natural continuation (normalised
cross-correlation of L+R, coarse pass then a ±3 refine). At exactly 1× it is a bit-exact passthrough with no added
latency; leaving or returning to 1× is continuous. Measured on a 440 Hz tone at 0.1×–4×: pitch 440.01 Hz, level
within ±0.003 dB. A debug build's WSOLA step (~0.35 ms) misses 64-frame cycles away from 1× — measure release.

## `AudioFlowing`

Worker: an arming counter (a playing `Start`, `Paused {false}`, `NoAudio {false}`, a `Route`); the first buffer after
it that pulled the scene's sound into a real stream (not the fallback timer, not before the load) sends one.
Compositor: armed on open-unpaused, un-pause, `no_audio` off, route or path change; reported once the load is shown
and not paused. Known window: a message from an earlier arming arriving after a re-arm counts (≤ a few ms) — the
protocol has no epoch.

## Quit

`Control::quit`: the gate closes (at once if silent), then once the stream's level is exactly 0 the stream leaves
the graph before the exit — `set_active(false)` + a roundtrip, `SETTLE_INACTIVE` (20 ms), disconnect + a roundtrip,
all within `CLOSE_MAX` (200 ms, under the host's `STOP_GRACE`). Exiting with the stream active cost the bus whole
cycles of silence in every S→S switch; with the clean leave plus async links, 0 in 60.

## Envelope

1 ms max-channel RMS of the gated, pre-gain samples, batched every 50 blocks and stamped with the buffer's play time,
mapped by the compositor onto the log's `t_mono_ms` and filed into `SceneEnvelopes` (bounded per scene and in
tracks). The dropout detector uses it as the scene's expected signal instead of an ffmpeg decode (S→S lag 2–3 ms,
fit 0.06 dB). A video's reference reads a mono clip ~3 dB hot (mpv upmixes mono at −3 dB per channel; the `-ac 1`
decode doesn't), so V↔S fits show 1.2–1.6 dB and a −2 dB `offset_db` that the fit absorbs.

## Measured

Private PipeWire at a 64-frame quantum: a −20 dBFS tone scene reads −23.01 dB on the bus; `animate gain.user` 0 → −20
over 300 ms lands as a staircase-free dB-linear ramp; full-live crossfades of equal-level tones keep bus power within
±0.13 dB (V→S), ±0.23 (S→S), ±0.96 (S→V, the video's onset hold). A real scene with sound at 1×/1.5×/0.5× (release
worker): no silent 1 ms block in 5 s, 5–6.5 % of a core. `liascape-scene-worker --lwe-smoke … --audio-dump S` dumps
the real sound in and the stretch out at 0.5×/1.5× with silent-block counts.
