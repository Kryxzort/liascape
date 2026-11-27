---
paths:
  - "src/player/src/audio/**"
  - "src/player/src/probe/audio.rs"
  - "src/player/tests/common/pw.rs"
  - "src/player/tests/onmachine/bus.sh"
---

# liascape-player: the audio bus, real-time threads and the meter

Crate-wide rules (units, never fork) are in `.claude/rules/player/core.md`; mpv sources in
`.claude/rules/player/sources.md`. Walkthrough and measurements: `docs/player/modules/audio-bus.md`; audio symptom →
probe recipes: `docs/player/debugging.md`.

## Audio bus (`src/player/src/audio/bus.rs`)
- Keep the identity constants in `audio::bus` verbatim (`SINK_NAME`, `PLAYBACK_NAME`, `APP_NAME`, `MEDIA_ROLE`,
  `SINK_DESCRIPTION`): auto-mute excludes the bus by them. mpv streams share `application.name`, so exclude by
  ownership/target, never by that name alone.
- Start the bus (`Audio::start` in `runtime::serve`) only after the socket bind and the compositor connection: a
  second instance or a start still waiting for its compositor must never load a sink into the session.
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
  skips cycles on its own. rtkit refuses bursts the suite itself makes, so a refused daemon or player is started again
  (`common::pw::RT_WAIT`) and a recording test calls `require_rt_graph` before it records. Tests never touch the
  owner's PipeWire.

## Real-time graph threads (`src/player/src/audio/rt.rs`)
- `module-rt` is `nofail` and rtkit refuses a user's requests past 25 in 20 s, so `RtWatch` (thread `lia-rt`, started by
  `Audio::start` whenever sources play through PipeWire) re-asks rtkit for every `data-loop.*` thread still SCHED_OTHER
  after `SETTLE`, on the `BACKOFF` ladder (first past the 20 s window, then every 5 min), one request per thread per
  step — never faster, or the retries make a burst themselves. Set `RLIMIT_RTTIME` ≤ rtkit's `RTTimeUSecMax` first.
- Report it in `hello.health.realtime` (`ok: false`, `state: "off"` while any thread is refused) and the `bus` probe's
  `realtime`; the meter's `callback_policy` is read live. Guard `src/player/tests/api.rs`
  `a_graph_thread_refused_real_time_asks_rtkit_again` (uses up the rtkit budget with `common::pw::RtkitFlood`).

## Meter (`src/player/src/audio/meter.rs`)
- The capture callback runs on PipeWire's RT data thread (`RT_PROCESS`), never blocks or allocates (`try_lock`,
  staging buffer). Guard `meter_capture_runs_on_the_rt_data_thread`.
- Meter per channel and take the loudest (never a mono sum: anti-phase cancels); floor at `SILENT_DB`; timestamps
  on the `t_mono_ms` clock.
- An unavailable meter answers `meter.window` with an `unsupported` error saying why — never an empty "all quiet".

## On-machine check
- `bash src/player/tests/onmachine/bus.sh` (real audio, run manually) must restore the default sink and clear every
  metadata target it set, even when interrupted.
