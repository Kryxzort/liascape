# liascape-player invariants

The numbered rules the player must never violate, each with why and what guards it. Covers the whole crate
(`src/player/`); the must/never bullets that implement them are in `.claude/rules/player/*.md`, the mechanisms in
`docs/player/modules/`.

## 1. Never hand off an audible or visible stream between owners

Closing one decoder or output while opening its replacement always leaves a moment where "nothing plays yet" or
"the old one already stopped" has to be hidden by timing — the legacy engine's silence gaps and frozen frames. Only
ramping gain and opacity on streams that keep running removes the seam: B is created paused at −96 dB and only ramps
up; a source is destroyed only after its gain reached −96 dB (or it was paused), never while a layer shows it.
Guards: `tests/transition.rs` `cut_without_effect`, `handoff_no_seam`, `rapid_interrupt_chain`,
`cancel_running_snaps_back`; `tests/api.rs` `switches_never_compose_a_hole`.

## 2. Gains are dB; never ramp a percent

mpv's `volume` and PulseAudio stream volumes are cubic (`volume=50` → −18.07 dB): ramping or summing percentages
neither sounds like a steady fade nor composes across gain stages (user, override, normalize, mute, auto-mute,
crossfade, anti-click, pause). Every gain is dB inside the player, converted only at each edge with that edge's curve
(`units::mpv_volume_gain`, `units::pulse_volume_from_db`). Guards: units `gains_sum`, `mpv_clamp`, `pulse_cubic`.

## 3. Silent = −96 dB

One floor (`units::SILENT_DB`) so every slot, clamp and "is it off" comparison agrees; it equals mpv's
`volume-gain-min`. A slot at the floor dominates the sum down to exactly −96. Guards: `gains_sum`, `mpv_clamp`.

## 4. A hold boundary uses a ≤ 30 ms anti-click gain ramp

Starting or stopping audio instantaneously clicks; 30 ms removes the discontinuity without reading as a fade. Cuts,
commits, cancels, restores, holds, retires and parks all ramp over 30 ms, and no gain animation is shorter whatever
the effect's duration. Ramps are pushed by the 1 kHz gain timer, so a 30 ms ramp is ~30 steps even at 60 Hz (on the
main tick alone it was 1–2, and mpv snapped to the end). Guards: `zero_duration_gains_still_ramp_30ms`,
`frozen_silent_then_b_starts`, `tests/api.rs::gain_fast_timer_dense_pushes_at_60hz`.

## 5. Audio follows the picture

A held picture is silent, a live one is heard; hearing a frozen frame or seeing a silent live one reads as a glitch,
and it is what makes the transition methods distinct:

| method | picture | audio |
|---|---|---|
| full-live | both play | equal-power crossfade A→B |
| reveal | A held, B live | A ramped out in 30 ms then paused; B rises over the effect |
| frozen | A held, B on its first frame | silent through the effect; B ramps in at the end |

A source still shown on an output outside the transition keeps playing and stays audible; the transitioning output
holds a snapshot copy. A source a layer still shows is never left paused or silent by release. Guards:
`full_live_gains` (−3.0103 dB each at the midpoint), `reveal_holds_a_silent`, `shared_a_untouched`,
`align_end_full_live`.

## 6. A new transition commits the in-flight one: never park, never stack

A transition left half-done (the legacy engine's paused, silent overlay) and stacked effects are the failures to
prevent. A new request on an overlapping output resolves the in-flight one at once: still waiting → superseded (B
destroyed, A restored exactly); running → committed (B current, A ramped out). A B that fails before handoff snaps
back to A with `transition.failed`, so a bad file never leaves the screen black or silent. The graveyard keeps at most
two streams per output. Guards: `rapid_interrupt_chain` (≤ 2 unpaused sources after every tick),
`commit_running_each_method`, `b_error_mid_effect_snaps_back`, `bad_target_keeps_a`,
`mixed_kind_interrupt_chain_every_tick`, `tests/api.rs::scene_switch_storm_reaps_workers`.

## 7. Pause freezes everything — picture, audio and time — and resume continues exactly

A pause that reached only the sources would desync a transition (A frozen, B playing); a resume that restarted a
transition or jumped a position would be as visible. So the player pause composes with each source's own pause
(`node.paused || player.paused || holds`, the node's value untouched, so recipe-held sources stay held), the player
clock excises paused time (effects, ramps, `align: end` waits and rotations freeze), and a playing source with audio
ramps out on its own `gain.pause` gate before mpv pauses and ramps back in once its audio flows. Teardown ramps and
user-setting ramps run on the unpaused clock, so a destroy, `stop` or mute completes while paused. The cover hold and
the low-VRAM hold are pauses of the same kind and never write `player.paused`; `stop` clears it. Guards:
`player_pause_freezes_full_live_transition`, `player_pause_freezes_frozen_hold`,
`player_pause_freezes_align_end_wait`, `player_pause_ramps_a_plain_source`, `r93_destroy_mid_gate_never_leaks`,
`stepped_player_pause_never_opens_a_gate`, `i2_switch_while_gated_never_leaves_a_playing_source_silent`,
`setting_gain_ramp_lands_while_paused`, `cut_while_paused_swaps_at_once`.

## 8. No audio onset or offset without a ramp the listener can hear

A 30 ms ramp assumes audio is flowing when it starts and keeps flowing until it ends. Un-pausing mpv doesn't restart
PipeWire's output at once (~19 ms of true silence measured), and a gain push lags the graph by a few ms. So:

- **Onset:** every un-pause-then-ramp path (a transition's B, a restored A, unpark, a restored source's fade-in, the
  pause gate's resume, a re-route after a PipeWire restart) holds its ramp in `onset::Onsets` until the source's
  `AudioFlowing` (≤ `ONSET_TIMEOUT`, 150 ms), started at that instant. A source that can't be heard
  (`onset::has_audio` false) ramps at once.
- **Offset:** a ramp to silence followed by a pause lands the pause `AUDIO_SETTLE_TAIL` (15 ms) after the ramp —
  a measured fixed tail, since nothing reports when a gain push reached the audio actually output.

Guards: units `frozen_onset_waits_for_audio_flowing`, `onset_timeout_ramps_anyway`,
`a_pause_waits_for_audio_settle_tail`; `tests/api.rs::i6_every_onset_waits_for_flowing_audio`,
`audio_less_b_never_times_out_its_onset_any_method_or_align`, `scene_audio_flowing_gates_every_onset`; on-machine
`src/player/tests/onmachine/dropout.sh` (0 drops and micro-gaps at 60 and 240 Hz).

## 9. A crashed scene keeps its picture, resumes where it froze, and touches nothing else

A scene renders in its own process so LWE crashing, hanging or losing its GL context can't take anything down. The
source keeps its last frame (or its preview), the scene clock stops at that frame so the restarted worker continues
from it, and after 3 restarts in 60 s the scene is broken — silent, its picture held, a crash record written,
`source.broken` logged. Other outputs, videos, the bus and the loop are never affected, and a player restart never
resurrects a broken scene into a fresh crash loop. Guards: `tests/scene.rs::crash_holds_last_frame_and_resumes_at_position`,
`crash_before_first_frame_shows_preview`, `context_lost_is_a_restart`; `tests/api.rs::crash_never_touches_other_outputs`,
`broken_after_three_restarts_in_60s`; `tests/supervise.rs::broken_scene_restores_as_preview`.

## 10. A worker frame never blocks the compositor

A worker can be arbitrarily slow. If the compositor ever waited for its frame (a fence wait, `glFinish`, a blocking
read), one heavy scene would stall the loop that presents every output and drives every ramp. The latch takes the
newest frame whose fence already signalled and otherwise keeps what it has; spawning, stopping and reaping never
block; the worker itself never `glFinish`es. Guards: `tests/scene.rs::latch_never_waits_on_an_unsignalled_fence`
(update p99 ≤ 1 ms with ~6 ms of GPU per frame), `transport_never_shows_stale_torn_or_out_of_order`,
`tests/api.rs::scene_create_and_destroy_never_stall_the_loop`.

## 11. A worker's audio is a gain on a stream that keeps running

Invariant #1 for a scene's sound: the worker's stream is opened silent and left alone; the compositor ramps it in dB
like a video's `volume-gain`, the worker's own 30 ms gate covers what the compositor can't (pause, mute, route
change, quit), and the stream closes only once the level reaching the bus is exactly 0. The one unavoidable cut is a
crash (the process is gone; #9). Guards: worker units `gain_change_ramps_across_one_buffer`,
`gate_declicks_only_an_audible_stream`, `audio_flowing_once_per_arming`; `tests/api.rs`
`scene_gain_ramp_reaches_the_bus`, `scene_crossfades_are_equal_power_on_the_bus`,
`scene_worker_exit_never_skips_bus_cycles`.

## 12. A rotation's clock is the player's: it never advances while the picture is paused or held

A rotation counted on `Runtime::now` can't see a user pause, a hold, a suspend or a wall-clock jump as time passing,
and no rule starts a switch under a hold. With no output it does what `while_parked` says. Guards:
`tests/program.rs` `pause_freezes_the_rotation`, `cover_hold_freezes_a_program`,
`parked_keeps_rotating_invisibly_by_default`, `parked_hold_mode_holds_and_resumes`,
`live_max_edit_while_paused_waits_for_the_resume`.

## 13. One owner of a session's schedule: the player; the backend only requests

Two schedulers caused the legacy engine's double switches. The backend loads a program, edits its properties, sends
verbs and mirrors `program.current`; it never decides a switch is due, so closing the app changes nothing about a
rotation. Guards: the adapter integration test's origin check (every switch of a session is `origin:
program:prog:main`), the `legacy rotation path reached` guard in `PlayerHelper`.
