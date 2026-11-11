<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Audio bus

`src/audio/` (spec §5.3 "(my call) Player audio bus", §4.4 auto-mute; Task 14). Every
wallpaper's audio goes to one in-process PipeWire loopback sink owned by the player — the
**bus** — forwarded at 0 dB to the user's current default sink (EasyEffects chains keep
working); the **meter** captures the bus monitor: exactly what the wallpapers output, and
nothing else (the dropout detector, Task 15, and auto-mute's self-exclusion, Task 17).

```text
 mpv src1 (audio-device=pipewire/liascape-player-bus) ─┐
 mpv src2 ─────────────────────────────────────┼─▶ liascape-player-bus ──(same cycle)──▶ liascape-player-bus.playback ──▶ default sink
    …                                          ─┘   Audio/Sink        loopback      Stream/Output/Audio          (re-targeted on
                                                        │                            node.target = default         default.audio.sink
                                                        └─ monitor ──▶ liascape-player-bus.meter (capture, the Meter)   changes)
```

**Identity contract (Task 17's auto-mute excludes the bus by it — verbatim):** playback
stream `node.name = liascape-player-bus.playback`, `application.name = liascape-player`, `media.role =
Wallpaper`; sink `node.name = liascape-player-bus`, `node.description = "liascape-player bus"`,
`media.class = Audio/Sink`, `audio.position = [FL FR]`. Constants in `audio::bus`
(`PLAYBACK_NAME`, `APP_NAME`, `MEDIA_ROLE`, `SINK_NAME`, `SINK_DESCRIPTION`). The meter is
`liascape-player-bus.meter` (a capture stream). Note mpv streams also carry `application.name =
liascape-player` (`audio-client-name`) — auto-mute must exclude by ownership/target, not that name
alone (spec §4.4).

**`Bus::start()`** (serve startup only; **never blocks** — `Err` only for
`LIASCAPE_PLAYER_BUS=off` or no thread): thread `lia-bus` runs its own
PipeWire main loop + context + core (nothing uses `RT_PROCESS`: every callback runs on that
thread; capture buffers carry their cycle time, `pw_buffer.time`). Two roundtrips (globals,
then the `default` metadata's properties) → `default.audio.sink` → `pw_context_load_module(
"libpipewire-module-loopback", args)` (declared by hand — not in pipewire-sys's
`wrapper.h`) with `capture.props = {media.class = Audio/Sink, node.name = liascape-player-bus,
node.description = "liascape-player bus", audio.position = [FL FR]}` and `playback.props =
{node.target = target.object = <default>, identity…}` → waits until the playback is linked
to a sink (≤ `CREATE_TIMEOUT` 5 s) → **latency** → up: `audio.bus.up {device, latency_ms,
latency_samples, quantum_ms, target, reconnected, generation, setup_ms}` (logged by the bus
thread for every session). `setup_ms` measured 83–93 ms on the private test PipeWire; on the
owner's session the old startup's `wl.connected` → `audio.bus.up` (EGL + catalogue + the bus,
in a row) was 176–300 ms in 45 of 50 starts since 2026-10-22 — and 963 ms – 13 s in the other 5
(one the cold boot below). `Bus::wait_up(started, deadline)` is serve's bounded wait for the
first session (below). `Bus::device()` = `pipewire/liascape-player-bus`;
`Bus::state()` = `Up | Retargeting | Down`; `Bus::route()` = `(up, generation)` (one atomic
word, so a reader never sees half a change); `Bus::info()` = everything the `bus` probe shows.
`LIASCAPE_PLAYER_BUS=off` disables it (no thread, no retry).

**Re-target.** The bus thread watches `default.audio.sink` (a default naming the bus itself
is ignored — it would loop) and moves the playback the way pavucontrol does: default
metadata `target.node` (node id) + `target.object` (serial, `Spa:Id`) on the playback node
→ WirePlumber relinks (metadata beats the node's own `node.target`). `audio.bus.retargeting
{from, to}` → (link to `to` seen in the registry) `audio.bus.up {device, latency_ms, target,
from, retarget_ms}`; not linked within 3 s → `audio.bus.retarget_failed {to, linked}`
(warn; not retried until the default changes again). **Driven by "last requested vs
default", never by the momentary link set:** links churn while WirePlumber relinks, and
other clients' captures of the playback are links too — the legacy AudioMonitor's `parec`
attaches to every sink-input, and counting it re-issued retargets in a loop (found here;
`Seen::linked_targets` counts `Audio/Sink` nodes only). **Session policies win, never
fought.** On this machine EasyEffects 8.2.9 ("process all output streams") re-writes
`target.object` = its sink on *every* output stream the moment anyone moves it (verified
with a plain `pw-cat` stream: moved to any other sink, it's back on `easyeffects_sink`
within ms). Fighting that (re-issuing because "not linked to the default") oscillated. The
bus tracks every `target.object` write on its playback in order (`Seen::meta_events`): its
own write echoes back first; a later different value is another client's → `audio.bus.moved
{requested, target (that client's choice), linked_now}` (warn), `bus` probe `overridden:
true`, `target` = where it really is, and no retry until the default changes again (a
retarget in flight completes as `audio.bus.up {requested, target, overridden: true}`).
Someone moving it by hand (pavucontrol) is the same case. WirePlumber's
`linking.follow-default-target = true` (this machine) also moves a stream whose metadata
target was the default when the default changes, so a retarget back often completes at
once (`retarget_ms` ≈ 0). Measured: relinked 25–107 ms after `pactl set-default-sink`;
the meter's largest gap across it 28–30 ms (the bus subgraph changes driver; one 1 ms block
of the bus may come out quiet then — `bus.sh` prints the count).

**WirePlumber state opt-out (found in this task).** WirePlumber's `state-stream` keys
saved volumes/targets by `application.name` — the same key (`Output/Audio:application.name:
liascape-player`) as every mpv source. Without care, our metadata re-targets were saved as a
"user choice" target and would be restored onto any later liascape-player stream without its own
target (e.g. mpv in the fallback), pinning it to a stale sink. Every bus stream therefore
carries `state.restore-props = false` + `state.restore-target = false` (the bus also
always starts at 0 dB). `bus.sh` asserts no `target` gets saved. Don't set
`application.id` on the context: it changes the key.

**Latency rule.** `Bus::latency()` = what the bus adds, measured once at creation with an
impulse: a probe stream plays one −60 dBFS sample (inaudible) into the bus while two
captures watch the bus monitor (`stream.capture.sink`) and the bus playback's *output*
(`target.object = liascape-player-bus.playback` — WirePlumber links stream→stream); both are
checked wired correctly first (else both would see the same signal and read 0), the
arrival-time difference (same graph cycles → same clock) over 3 shots, median kept;
`audio.bus.latency_shots {shots_ms, quantum_frames}` (debug). **Measured on this machine
(PipeWire 1.6.9): 0 samples** — module-loopback triggers its playback from the capture's
process (same cycle); the method reads an injected `target.delay.sec = 0.010` as
9.999997 ms, so 0 is real. **Plus the async hops (F7, below): every stream of the process
is an async node, so the measurement's two captures each sit one cycle behind what they
watch (it still reads the loopback's own 0) and `ASYNC_HOPS` = 2 quanta (producer → bus,
playback → sink) are added — `latency_ms` 2.67 at the owner's 64-frame quantum.** Gate
(`bus.sh`): ≤ 2 hops + 1 quantum + 5 ms. Sources get `audio_delay_bias = −latency` at open
(§ Sources: the source's own `audio_delay` **adds** to it), so the hops are compensated for
mpv's A/V sync.

**Async streams (F7 residual, 2026-11-04).** `serve_main` sets the compositor's
`PIPEWIRE_PROPS` to `{ node.async = true }` (`audio::bus::set_async_streams_env`, while the
process is still single-threaded; scene workers inherit it and set the property themselves
too): every PipeWire stream connected in the process — mpv's AOs, the loopback halves, the
meter, the latency probes — is an **async node**, so no consumer waits for it inside a graph
cycle (it reads the buffer queued one cycle earlier) and its leaving can't stall anyone.
**Why (the "single lost 64-frame cycle" of F7 / Phase 3 F1 / the battery re-run's 23 zero
runs):** with synchronous links the bus's cycle counted every stream playing into it, and a
stream *deactivating* — a scene worker's quit (`set_active(false)`), mpv's
`pw_stream_set_active(false)` on every pause (its AO `reset`), its `pw_stream_destroy` at a
teardown — hit a libpipewire race: the client marks its own activation INACTIVE at once,
the server drops it from the bus's dependency count only after a protocol roundtrip, and a
driver cycle starting in that window skips the stream (inactive) yet the bus still waits for
it → the whole graph xruns and the sink gets exactly one quantum of zeros. Proven with the
server's profiler (`scenes.sh onsetrec` + `ONSET_PROFILE=1`, release, 240 Hz headless,
full-live S→S): 7 of 7 lost cycles in 60 switches were this signature (the bus
`not-triggered`, A's stream gone, B's `finished` a whole cycle late, `posjump 128`), each
1.5–6 ms after A's `worker.stopped`; with async producers **0 of 60 (two runs), 0 xrun
cycles**. The property is what the server reads: module-loopback's own `PW_STREAM_FLAG_ASYNC`
only marked the client side, which is why the bus's links were synchronous before. Guards:
`tests/api.rs::bus_producers_link_asynchronously` (`pw-dump`: every link into the bus is
`link.async`), `scene_worker_exit_never_skips_bus_cycles` (full-live, 20 switches, recorded
sink: 0 runs; RED 1 in ~10 switches before), `mpv_source_teardown_never_skips_bus_cycles`
(V→V, RED before). Cost: one quantum per hop (the latency rule above). **The recording tests need an RT
test server** (2026-11-05): the private daemon (`tests/common/pw.rs`) drives the graph, and at
this machine's 64-frame quantum (`/etc/pipewire/client.conf.d/99-lowlatency.conf` on every
client stream) a non-RT data thread there skipped whole cycles on its own (`pw-profiler`:
driver position +128) — failures that looked like this race; it loads `module-rt` (rtkit, so
`support.dbus = true`) like `scenes.sh`. `LIASCAPE_TEST_PW_PROFILE=<dir>` makes
`mpv_source_teardown_never_skips_bus_cycles` save the private server's profile, `pw-dump`,
the player's events and the recording there.

**Meter.** `Meter::start(&bus)` (a capture stream on the bus thread: 48 kHz F32 stereo,
`node.latency = 480/48000` — a 10 ms *request*; the graph runs at the smallest request, on
this machine 64 frames because the owner's Quickshell asks for it). `dbfs_1ms` = per 1 ms
block (48 frames) the **max-channel** RMS (each channel's RMS, loudest wins — a mono sum
cancels anti-phase content and reads a one-sided channel 6 dB low, a fake dip for a dropout
detector), `20·log10`, floored at `units::SILENT_DB` (−96); a full-scale sine reads −3.01.
Ring: 4 min (240 000 entries) of `(t_mono, dbfs_1ms)`; `t_mono` is the **`t_mono_ms` clock**
(`log::mono_start()`; block time = its cycle's `pw_buffer.time` + its first frame's offset).
The callback never blocks or allocates (staging buffer + `try_lock`) and runs on PipeWire's
**real-time data thread** (`RT_PROCESS`, Phase 2 Task 14 — `data-loop.0`, `SCHED_RR` via
rtkit): on the non-RT `lia-bus` main loop it missed whole graph cycles whenever a switch loaded
the machine (a worker spawning, a source torn down) — measured in 245 of 301 on-machine
switches, each a timestamp jump of 1–5 quanta plus silent blocks the dropout detector has to
call `unmeasured`. Guard `tests/api.rs::meter_capture_runs_on_the_rt_data_thread` (RED:
`lia-bus`, `other`). `Meter::window(from, to)`,
`Meter::available()` (streaming, newest sample ≤ 500 ms old, no error), `Meter::status()`.
**Never `fork` the serve process** (TODO F4): copying the compositor's address space takes
milliseconds, and the bus's in-process loopback and mpv's AOs miss graph cycles meanwhile (exact
silence at the sink). Spawn with `posix_spawn` — std `Command` without `pre_exec`/uid/gid, or by
hand like `WorkerHost::spawn` — and get a death signal some other way (the child sets it itself, or
`setpriv --pdeathsig`). Only the single-threaded supervisor uses a `pre_exec` hook.

**Probes.** `bus` → `{state, device, latency_ms, latency_samples, quantum_ms, target,
default_sink, requested, overridden, playback_node, sink_node, retargets, connecting (down and
the thread still setting up / retrying; `false` with no bus at all), generation, reason (while
down: what it waits for — "connecting to PipeWire", "PipeWire connected; waiting … for a
session manager (WirePlumber) to link the bus loopback", or the last failure), now_ms,
meter {available,
streaming, samples, last_ms, quantum_frames, dropped, error, callback_thread, callback_policy
(other|fifo|rr)}}` (`now_ms` on the `t_mono_ms`
clock). `meter.window {last_ms} | {from_ms, to_ms} [, samples: false]` → `{from_ms, to_ms,
count, median_db, min_db, max_db, max_gap_ms, first_ms, last_ms, samples: [[t_ms, db]…]}`;
an unavailable meter is an **`unsupported` error saying why** (never an empty "all quiet").

**Fallback.** `--ao <anything but pipewire>` → no bus (`--ao null` would only add a sink to
the owner's session for nothing) and `LIASCAPE_PLAYER_BUS=off` → none either: logged once
(`audio.bus.down {reason}`), never retried. Otherwise the bus is never given up on.
**Cold boot (2026-10-29, the owner's machine):** Hyprland's `liascape restore` started the
player before WirePlumber was up; `serve` blocked 10 s in the old `Bus::create` (the loopback
never linked) with the socket bound but the loop not running — every `hello` timed out, the
backend failed requests fast and the restore's switch failed (no wallpaper) — and that first
failure was final: no bus for the whole process although PipeWire was up seconds later. Now:
the bus thread starts right after the bind and the compositor connection (a start still waiting
for its compositor never loads a sink into the session on every retry) and connects in the
background while EGL and the catalogue come up; `serve` waits for its first session at most **`BUS_STARTUP_WAIT` = 500 ms**
from that start (a normal start is up well inside it — the numbers above — so its sources open
straight onto the bus; on a boot where the audio server isn't ready it delays the first answer
by at most that — under the backend's 1 s spawn probe (`Reachable`'s `hello`; a timeout opens
its 3 s stall breaker) —, measured `hello` 644–707 ms after spawn vs 210–247 ms when the server isn't
there at all, 5212 ms before), then runs the loop regardless (`audio.bus.not_ready {waited_ms,
reason}`, warn, if the session is still setting up). A first session that fails (PipeWire
unreachable: at once; no session manager linking the loopback: after `CREATE_TIMEOUT`) is
`audio.bus.down {reason}` (warn) and goes into the I7 backoff below like a lost connection; a
first session that comes up after the wait ran out, or any later one, is `audio.bus.up
{reconnected: true, generation}` and moves every source onto the bus by the route. Meanwhile
sources play on mpv's default device (no `audio_device`, no bias) — under a daemon without a
session manager mpv's own stream isn't linked either, so a video shows its first frame and its
clock (the audio's) waits until WirePlumber links it —, scene workers' streams take the default
route (`ToWorker::Route` onto the bus later), the meter is unavailable (`audio bus down
(<reason>)`; its capture stream starts with the session), and `ctl probe '{"name":"bus"}'` says
`down`, `connecting: true` and why. A quit during the setup exits at once (its waits end on the
`Bus` drop; measured 70 ms). **A connection lost later is re-created (final
review I7):** the `lia-bus` thread runs the bus as *sessions* (`bus::session`) — a core error ends
one (`audio.bus.down {reason}`; the loopback module is *not* destroyed by us then: it unloads
itself on a core error, and destroying it too was a measured double free), sources are re-routed
to mpv's default device (`Bus::route()` = `(up, generation)`, polled by `Runtime::
track_bus_route` every tick → `SourceHost::set_audio_route`, `audio.bus.sources_rerouted`), and
the bus retries with backoff (0.5 s, doubling ≤ 10 s; `audio.bus.reconnecting {attempt}`,
`.reconnect_failed {reason}`) until a new session is up (`audio.bus.up {reconnected: true,
generation}`; latency re-measured; the meter's capture stream re-created on the same
`MeterShared`) — then every source goes back onto the bus with its ramp-in held on `gain.pause`
until its rebuilt audio chain flows (invariant #8). The first session's setup failing takes
the same path (above). Shutdown: `Runtime::shutdown` destroys every source first, then
`Audio::close` (`audio.bus.down {reason: "shutdown"}`), so no stream is moved to the default
sink on the way out; a killed player's sink goes with its PipeWire connection.

**Tests.** `tests/api.rs::bus_down_falls_back_to_default_device` (PipeWire made
unreachable: empty `PIPEWIRE_RUNTIME_DIR` + bogus `PIPEWIRE_REMOTE`; image source, so
silent; down + `connecting`, then it keeps retrying — `reconnecting`/`reconnect_failed`, never
up), `ao_null_runs_without_bus`, the cold boot (private PipeWire, `PrivatePw::start_daemon` /
`start_session_manager` start the two daemons apart):
`bus_comes_up_when_pipewire_starts_after_the_player` (nothing running at spawn; RED before: the
bus never came up in 20 s), `serve_answers_at_once_while_wireplumber_isnt_up_yet` (the daemon
without WirePlumber; RED before: `hello` 5212 ms after spawn) — both: `hello` < 2 s after spawn,
the bus probe down + `connecting`, a looping video created and on screen on mpv's default
device, then the audio server started → `audio.bus.up {reconnected: true}` on its own, the
video on `pipewire/liascape-player-bus` with a live AO, its tone on the meter, the ramp-in
`onset.started {slot: pause, reason: flowed}` —, `scene_moves_onto_a_bus_that_comes_up_late`
(a tone scene's worker on the `default` route, then `{device: …bus}`, same pid, the tone on the
bus), `quit_while_the_bus_waits_for_wireplumber_is_prompt`;
**`i7_bus_reconnects_after_pipewire_restart`** (also: a normal start's first session is
`reconnected: false`, no `not_ready`) — a *private, hermetic* PipeWire + WirePlumber (`PrivatePw`: own runtime/config/state dirs, no
D-Bus, WirePlumber's `policy` profile so no ALSA/Bluetooth/V4L2 monitor ever opens a device,
one null sink; skipped without the binaries; the owner's PipeWire is never touched): tone on
the bus → both daemons killed → `down` + sources on `auto` → restarted → `up {reconnected}` +
sources back on `pipewire/liascape-player-bus` with a live AO, the tone on the bus again, the ramp-in
`onset.started {slot: pause, reason: flowed}`; unit tests in `meter.rs` (RMS/floor/max-channel/
carry/ring/clock) and `bus.rs` (args, default parsing). **On-machine: `bash
src/player/tests/onmachine/bus.sh`** (exit 0 = pass; real audio, R56): its own temp
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME` for the liascape-player socket while PipeWire/Pulse reach the
real session (`PIPEWIRE_RUNTIME_DIR=/run/user/$UID`, `PULSE_SERVER=unix:/run/user/$UID/
pulse/native`), `--headless`, `WAYLAND_DISPLAY` unset (R55); stops a legacy mpvpaper first;
a `trap … EXIT` restores the default sink exactly and checks no `liascape-player-bus` sink is left
(R57), deletes every `target.node`/`target.object` metadata entry on the nodes serve owned
(live ones before quitting, dangling ones after — never an id another node reuses) and, if
WirePlumber ever saved a `target` for liascape-player, clears it (silent stream + `target.object
-1`) — so a failed or interrupted run never leaves routing changed (verified with a SIGTERM
mid-retarget). It checks the identity (pw-dump + `pactl list sink-inputs`), `pw-link -l`,
the latency gate, a 440 Hz −20 dBFS clip's meter median (−23 ± 3; measured −22.98…−23.03),
the source's mpv device/delay, `default_sink_change_retargets` and the WirePlumber state.
**`default_sink_change_retargets`** first learns the session's policy with a control
stream (a silent `pw-cat` moved to the new sink by metadata): no policy → the bus must be
linked to the new sink and stay; a policy (here: EasyEffects) → the bus's links to the new
sink must be *created* within 1 s (caught by a `pw-link -m -l` capture: the policy
re-points it within ms, faster than polling `pw-link -l` can see), then `audio.bus.moved`
to the policy's sink + `overridden` reported. Both: exactly one `audio.bus.retargeting` per
default change (no fight), `audio.bus.up {requested}` ≤ 1 s, meter gap ≤ 50 ms across it
(measured 8–34 ms), and back to the original default within 1 s.
