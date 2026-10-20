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

**Enforced by:** the core invariant stated in `.claude/rules/player-core.md`; the actual
stream-lifecycle code that holds to it (source/graph/transition sequencing) is Task N
(planned) — not yet written.

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

**Enforced by:** `units::GainSlot::AntiClick` exists as a gain slot Task 4 added, so later
code has somewhere to put this ramp — the ramp's actual timing and the hold-boundary
sequencing that triggers it is Task N (planned, the transition/hold-state machine), not
yet written.
