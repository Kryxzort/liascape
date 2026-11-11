# Audio bus and meter

Covers `src/player/src/audio/` (`bus.rs`, `meter.rs`, `mod.rs`). Rules: `.claude/rules/player/sources-audio.md`
§ Audio bus, § Async streams and latency, § Meter, § Never fork the serve process. Auto-mute and `sysmon`:
[signals.md](signals.md).

Every wallpaper's audio goes to one in-process PipeWire loopback sink owned by the player, forwarded at 0 dB to
the user's current default sink (EasyEffects chains keep working). The meter captures the bus monitor: exactly
what the wallpapers output and nothing else — the dropout detector's input and auto-mute's self-exclusion.

```text
 mpv src (audio-device=pipewire/liascape-player-bus) ─┐
 scene worker stream ─────────────────────────────────┼─▶ liascape-player-bus ─(loopback, same cycle)─▶ liascape-player-bus.playback ─▶ default sink
                                                         Audio/Sink                                   Stream/Output/Audio (re-targeted)
                                                          └─ monitor ─▶ liascape-player-bus.meter (capture)
```

Identity (auto-mute and the backend exclude the bus by it): playback `node.name = liascape-player-bus.playback`,
`application.name = liascape-player`, `media.role = Wallpaper`; sink `node.name = liascape-player-bus`,
`node.description = "liascape-player bus"`, `audio.position = [FL FR]`. mpv streams also carry
`application.name = liascape-player`, so exclusion goes by ownership or target, never that name alone.

## Sessions

The `lia-bus` thread runs its own PipeWire main loop and runs the bus as sessions (`bus::session`): two roundtrips
(globals, then the `default` metadata) → `libpipewire-module-loopback` (declared by hand; not in pipewire-sys's
wrapper) → wait until the playback links to a sink (≤ `CREATE_TIMEOUT`, 5 s) → measure latency → `audio.bus.up`.
`Bus::route()` = `(up, generation)` in one atomic word, polled every tick by `Runtime::track_bus_route`, which
re-routes every source (`SourceHost::set_audio_route`).

- A session that fails or a core error ends it (`audio.bus.down`), sources move to mpv's default device, and the
  thread retries with backoff (0.5 s doubling to 10 s) until a new session is up; then every source goes back onto
  the bus with its ramp-in held on `gain.pause` until its rebuilt audio chain flows. On a core error the loopback
  module unloads itself; destroying it too was a double free.
- The first session is no different: a boot where WirePlumber isn't up yet must not leave the process without a
  bus, and must not block `serve` (the bounded wait is in [runtime.md](runtime.md)). Meanwhile sources play on
  mpv's default device — under a daemon with no session manager mpv's own stream isn't linked either, so a video
  shows its first frame and waits for its audio clock. The `bus` probe says `down`, `connecting: true` and why.
- `--ao` other than pipewire or `LIASCAPE_PLAYER_BUS=off` → no bus at all, never retried.
- Shutdown destroys every source before `Audio::close`, so no stream is moved to the default sink on the way out.

Setup takes 83–93 ms on the private test PipeWire; a normal session start is well inside `BUS_STARTUP_WAIT`.

## Re-targeting

The bus follows `default.audio.sink` the way pavucontrol moves a stream: default-metadata `target.node` (id) and
`target.object` (serial) on the playback node, which beats the node's own `node.target`. A default naming the bus
itself is ignored. Retargeting is driven by "last requested vs default", never by the momentary link set: links
churn while WirePlumber relinks, and other clients' captures of the playback are links too (the legacy engine's
`parec` re-triggered retargets in a loop until only `Audio/Sink` targets were counted).

Session policies win and are never fought: EasyEffects ("process all output streams") rewrites `target.object` on
every output stream the moment anyone moves it, and re-issuing oscillated. The bus tracks every `target.object`
write on its playback in order; after its own echo, a different value is another client's → `audio.bus.moved`
(warn), probe `overridden: true`, no retry until the default changes again. A manual move is the same case.
Measured: relinked 25–107 ms after `pactl set-default-sink`; the meter's largest gap across it 28–30 ms.

WirePlumber's `state-stream` keys saved targets by `application.name` — the same key as every mpv source — so
our retargets would be saved as a user choice and pinned onto later streams. Every bus stream therefore sets
`state.restore-props = false` and `state.restore-target = false`, and the context never sets `application.id`
(it changes the key).

## Async streams and latency

`set_async_streams_env` makes every PipeWire stream of the process (mpv AOs, loopback halves, meter, probes; scene
workers inherit it and set it too) an async node: no consumer waits for it inside a graph cycle. With synchronous
links, a stream deactivating (a worker's quit, mpv's AO reset on every pause, a teardown) hit a libpipewire race:
the client marks itself inactive at once, the server drops it from the bus's dependency count only after a
roundtrip, and a cycle starting in that window waits for it anyway → the graph xruns and the sink gets one
quantum of zeros. Profiled: 7 of 7 lost cycles in 60 switches had that signature; with async producers 0 of 60.
module-loopback's own `PW_STREAM_FLAG_ASYNC` marked only the client side; the property is what the server reads.

`Bus::latency()` = the loopback's measured latency (an inaudible −60 dBFS impulse watched at the bus monitor and
at the playback's output, median of 3; measured 0 samples — the loopback runs in the capture's cycle) plus
`ASYNC_HOPS` (2) quanta for the async hops: 2.67 ms at a 64-frame quantum. Sources get `audio_delay_bias =
−latency`, so mpv's A/V sync compensates.

## Meter

A capture of the bus monitor, 48 kHz F32 stereo, requesting 10 ms (the graph runs at the smallest request —
64 frames on the owner's machine, Quickshell asks for it). `dbfs_1ms` per 1 ms block is the loudest channel's RMS,
floored at −96; a full-scale sine reads −3.01. Never a mono sum: anti-phase content cancels and a one-sided
channel reads 6 dB low, a fake dip for a dropout detector. A 4 min ring of `(t_mono_ms, dB)`; block times come
from the cycle's `pw_buffer.time`. The callback runs on PipeWire's RT data thread: on the non-RT `lia-bus` loop it
missed whole cycles whenever a switch loaded the machine (245 of 301 on-machine switches).

## Tests

Recording tests run a private, hermetic PipeWire + WirePlumber (`tests/common/pw.rs`: own runtime/config/state
dirs, no D-Bus, WirePlumber's `policy` profile so no device monitor opens hardware, one null sink, `module-rt`).
Without RT a 64-frame quantum skips cycles on its own, which looks exactly like the async race.
`LIASCAPE_TEST_PW_PROFILE=<dir>` makes `mpv_source_teardown_never_skips_bus_cycles` save the server's profile,
`pw-dump`, the player's events and the recording. `src/player/tests/onmachine/bus.sh` exercises the real session:
it first learns whether a session policy moves streams (a silent control stream), then expects either a plain
retarget or `audio.bus.moved` + `overridden`, exactly one `retargeting` per default change, meter gap ≤ 50 ms,
and restores every default and metadata target it touched.
