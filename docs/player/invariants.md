# lp-player invariants

Numbered, load-bearing rules the player must never violate. Each has a reason and the
thing that currently stops a regression — honest about what's enforced today versus what
still depends on a later task.

## 1. Never hand off an audible or visible stream between owners

**Why:** handing a live stream from one owner to another (closing the old decoder/output
while opening a new one to replace it) is exactly the failure mode spike `04533a8`
measured — silence gaps, a speed-tracked second copy, a killed overlay leaving mpvpaper
parked paused. Only ramping gain/opacity on a stream that keeps running the whole time
removes the seam entirely, because there's never a moment where "nothing is playing yet"
or "the old thing already stopped" has to be hidden by timing.

**Enforced by:** the core invariant stated in `.claude/rules/player-core.md`, and (Task 11)
`recipes::transition`: B is created paused at −96 dB and only ramps up; a source is only
destroyed from the recipe's graveyard after its gain reached −96 dB (or it was paused),
never while a layer still shows it. Tests (`tests/transition.rs`): `cut_without_effect`
(no source but the current one is ever above −96 dB), `handoff_no_seam` (B is the same
stream before and after the handoff), `rapid_interrupt_chain`, `cancel_running_snaps_back`.

## 2. Gains are dB; never ramp a percent

**Why:** mpv's `volume` property and PulseAudio/PipeWire-pulse stream volumes are cubic in
linear amplitude, not linear — measured `volume=50` → −18.07 dB. Ramping or summing raw
percentages produces a curve that doesn't sound like a steady fade and clips
unpredictably once more than one gain stage is involved. Tracking every gain in dB and
converting only at each device's edge (with that edge's correct curve) is the only way
multiple gain stages (user, override, normalize, mute, auto-mute, crossfade, anti-click)
compose predictably.

**Enforced by:** `units::Gains` (sums all slots in dB), `units::db_to_lin`/`lin_to_db`,
`units::mpv_volume_gain` (mpv edge, exact dB, clamp only), `units::pulse_volume_from_db`
(PulseAudio edge, cubic curve) — all added in Task 4. Tests: `gains_sum`, `mpv_clamp`,
`pulse_cubic`.

## 3. Silent = −96 dB

**Why:** the player needs one agreed floor for "silent" so every gain slot, clamp, and
"is this stream effectively off" comparison across the whole crate means the same thing.
−96 dB matches mpv's own `volume-gain-min`, so the mpv edge needs no separate floor.

**Enforced by:** `units::SILENT_DB` (the single source of truth for the floor),
`Gains::effective_db`'s clamp (a slot at or below `SILENT_DB`, e.g. `Mute`, always
dominates the sum down to exactly `-96.0`), `db_to_lin`'s `<= SILENT_DB → 0.0` branch —
all Task 4. Tests: `gains_sum` (Mute at −96 dominates), `mpv_clamp`.

## 4. A hold boundary uses a ≤ 30 ms anti-click gain ramp

**Why:** starting or stopping audio instantaneously at a hold boundary (pausing/resuming a
side during a transition) produces an audible click — a discontinuity in the waveform at
the moment the stream starts or stops being audible. A short (≤ 30 ms) gain ramp through
the `AntiClick` slot removes the discontinuity without being long enough to read as a
fade.

**Enforced by:** `units::GainSlot::AntiClick` (Task 4) and `recipes::transition`'s
`ANTICLICK` (30 ms) ramps (Task 11): reveal/frozen ramp A's `gain.anticlick` to −96 dB
before pausing it; frozen unpauses B into a 30 ms ramp-in; cuts, commits, cancels and
restores all ramp over 30 ms. Tests: `reveal_holds_a_silent`, `frozen_silent_then_b_starts`
(B at 0 dB exactly 30 ms after the end), `cut_without_effect`, `cancel_running_snaps_back`.
Caveat: the ramp is stepped once per loop iteration (≈ 4 steps at 144 Hz, 1–2 in the 60 Hz
test harness) — a per-sample ramp would need the audio edge (Task 14).

## 5. Audio follows the picture

**Why:** owner decision (spec §10 "Transitions"): a side whose frame is held is silent; a
live side is heard. Hearing a frozen picture (or seeing a silent live one) reads as a
glitch, and it is what makes the three `TransitionMethod`s distinct:

| method | picture | audio |
|---|---|---|
| full-live | both play | equal-power crossfade A→B (`cos`/`sin`, linear-amplitude) |
| reveal | A held, B live | A ramped to −96 dB in 30 ms then paused; B rises `sin(x·π/2)` over the effect |
| frozen | A held, B held at its first frame | silent through the effect; B unpaused at the end with a 30 ms ramp-in |

A source still shown on an output outside the transition keeps its audio — its picture
is still live there (R34): it is never paused, ramped, loop-changed or destroyed, and the
held picture on the transitioning output is a `snapshot` copy instead.

**Enforced by:** `recipes::transition::Transitions::begin_running`/`handoff`. Tests:
`full_live_gains` (−3.0103 dB each at the midpoint), `reveal_holds_a_silent`,
`frozen_silent_then_b_starts`, `shared_a_untouched`.

## 6. A new transition commits the in-flight one: never park, never stack

**Why:** the legacy engine's worst failures were a transition left half-done — mpvpaper
parked paused, ~4.5 s silent and frozen (`04533a8`) — and overlapping effects stacking. A
new request on an output with a transition in flight therefore resolves it completely,
at once, before proceeding: still waiting (B loading / waiting for A's end) → it is
**superseded** (B destroyed, A restored exactly — loop, gains, pause); already running →
it is **committed** (B becomes current immediately, held B unpaused, A ramped to −96 dB in
30 ms and destroyed) and the new request proceeds from B. Any output overlap handles the
whole in-flight transition (R36) — never a partial state. A B that fails (load error,
timeout, destroyed) before its handoff snaps back to A with `transition.failed`, so a bad
file can never leave the screen black or the audio silent.

**Enforced by:** `Transitions::start` (supersede/commit), `cancel`, `tick` (failure →
`abort`/`snap_back`), and the graveyard (a new transition waits until the committed A's
ramp-out is over, so at most two streams play per output). Tests: `rapid_interrupt_chain`
(10 starts 100 ms apart: ≤ 2 unpaused sources after every tick, no unexplained paused
source, the 10th target ends current and alone), `bad_target_keeps_a`,
`cancel_waiting_restores_a`, `cancel_running_snaps_back`.

