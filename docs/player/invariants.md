# liascape-player invariants

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
restores all ramp over 30 ms, and no gain animation is shorter than 30 ms whatever the
effect's duration (R42). Tests: `reveal_holds_a_silent`, `frozen_silent_then_b_starts`
(B at 0 dB exactly 30 ms after the end), `cut_without_effect`, `cancel_running_snaps_back`,
`zero_duration_gains_still_ramp_30ms` (duration 0: no gain moves faster than a 30 ms ramp),
`cancel_held_methods_restore_a`, unit `cut_end_ramps_each_playing_a`.
**Resolved (R90, Task 16d):** the ramp used to be stepped once per *output refresh* loop
iteration (≈ 4 steps at 144 Hz, 1–2 at 60 Hz) — mpv held each pushed `volume-gain` value
for most of a 30 ms ramp's span, then snapped straight to the end (measured: 5–7 ms
`micro_gaps`, ~60 dB under, at 60 Hz). A second, independent calloop timer at ≥ 1 kHz
(`runtime::GAIN_TICK_PERIOD`), armed only while a `gain.*` animation exists and
self-disarmed the instant none remain, now evaluates and pushes gain values at that rate
regardless of the output refresh — `Runtime::gain_fast_tick`,
`Animator::tick_gains`/`has_live_gain`, `SourceHost::push_gain`,
`.claude/rules/player-core.md` § Runtime "The fast gain timer". A 30 ms ramp now produces
29–30 distinct pushes even at 60 Hz (`tests/api.rs::gain_fast_timer_dense_pushes_at_60hz`,
floor 15 — 5× the main timer's 2–3 — so a busy desktop can't flake it);
`dropout.sh` at both 60 Hz and 240 Hz (`DROPOUT_OUTPUT_HZ`) reports 0 drops/micro_gaps
across every case (with Task 16d's detector alignment fixes, #8). Still stepped mode only: between steps, exactly like every other
property (no "real time" for the fast timer to drive there); still frozen, not advanced,
while `player.paused` (R75/invariant #7) — the fast timer keeps firing but does no work
while paused, rather than re-emitting a stale value (`gain_fast_timer_paused_makes_no_
progress`).

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

A source a layer still shows is never left paused or silent by a transition: release and
the graveyard restore it (R43).

**Enforced by:** `recipes::transition::Transitions::begin_running`/`handoff`/`release`.
Tests: `full_live_gains` (−3.0103 dB each at the midpoint), `reveal_holds_a_silent`,
`frozen_silent_then_b_starts`, `shared_a_untouched`, `shared_a_align_end_boundary`,
`align_end_full_live` (A still on VIRTUAL-2 comes back audible with its loop).

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
source, the 10th target ends current and alone; ≥ 1 commit and ≥ 1 supersede happen),
`commit_running_each_method`, `b_error_mid_effect_snaps_back`, `bad_target_keeps_a`,
`cancel_waiting_restores_a`, `cancel_running_snaps_back`, `restore_targets_not_mid_ramp`
(R41), unit `supersede_does_not_rewind_cancel_does` (R44), `held_a_destroyed_at_handoff`.
With scenes (Phase 2 Task 9): `mixed_kind_interrupt_chain_every_tick` (the same per-tick
assertions over scene/video targets), `tests/api.rs::rapid_interrupt_chain_mixed_kinds` and
`scene_switch_storm_reaps_workers` (every superseded scene B's worker reaped),
`scene_b_load_error_keeps_a`, `scene_b_broken_mid_effect_snaps_back` (a worker past its restart
budget mid-effect is a failed B: snap-back), `scene_b_worker_crash_mid_effect_still_hands_off`
(a restartable crash is not).

## 7. Pause freezes everything — picture, audio and time — and resume continues exactly

**Why:** "features must compose" + "audio follows the picture" (project rules): the
backend already paused by setting a source's own `paused` prop, but the transition
recipe un-pauses B the instant its effect starts Running (R34/§10) — a player-level
pause landing mid-transition would desync the two sides (A frozen, B playing) unless it
reached every moving part, not just the one prop a naive implementation would touch.
Resuming has to continue from exactly where it stopped — a transition that restarted, or
a video whose position jumped, would be as visible a glitch as the desync itself.

**Enforced by:** a second, writable Player node prop `paused` (R75, Task 16b), composed
rather than substituted for the node-level one:
- **Picture + audio:** `SourceHost` applies `node.paused || player.paused` to every
  video/image source (`sources/host.rs`) — never touching the node's own `paused`, so a
  recipe-held source (reveal/frozen) stays held after a resume purely because its own
  `paused` never moved; the node mirror is suspended while paused so the OR'd (effective)
  state a hosted source now reports can't corrupt it back.
- **Time:** `Runtime::now()` excises every paused interval (two fields, same algebra as
  `clock::OutputClock`'s pause/resume) — the Animator and `Transitions::tick` only ever
  see this clock, so a transition's progress, gain ramps, `align:end` waits and handoff
  timers all stop and resume exactly where they were, with the recipe itself needing no
  awareness that `player.paused` exists at all. Stepped mode: the per-source virtual
  media time (`Runtime::begin_step`'s `lt.t`) is gated on `player_paused` too, so a
  stepped source can't advance (or reach its own natural end) while paused either.

**Tests** (`tests/api.rs`): `player_pause_freezes_full_live_transition` (pause at
progress ≈ 0.5, step a full second: progress/both gains/both `time_pos` unchanged, both
`effective_paused` via `probe sources`; resume continues forward and completes —
`player.paused` visible throughout via `get`/`state`/`probe sources`),
`player_pause_freezes_frozen_hold` (pause mid-hold: A/B stay held exactly as `frozen`
left them, the handoff doesn't fire 4 s of virtual time past `duration_ms`, resume
completes and B's own handoff — never the override — unpauses it),
`player_pause_freezes_align_end_wait` (pause during a `WaitingStart` wait: A — playing,
not recipe-held — never reaches its own end while paused so `transition.started` never
fires, resume lets it arrive and start normally).

**R88 (Task 16c) — a *plain* source (not recipe-held) pauses/resumes with the same
anticlick ramp as invariant #8, not an instant mpv `pause`.** The composition above still
applies instantly to `node.paused`'s OR for a transition-held source (the three tests
above are unaffected — a transition-held source is never gate-eligible, see `source_has_
audio`/`held_sources` exclusion in `Runtime::drive_pause_gates_pre_sync`); a source with
real audio that isn't currently part of any transition instead gets `Runtime`'s player-
pause anticlick gate: ramp `gain.anticlick` to silence (+ the same settle tail as #8) over
real wall-clock time — deliberately `Instant`, not `Runtime::now()`, which this very
invariant freezes the instant `player.paused` does — *then* the mpv `pause` lands
(`SourceHost::force_paused`, bypassing the normal `node.paused || player.paused`
composition via a temporary exclusion, `SourceHost::pause_exclusions`); resume un-pauses
at once and ramps back in once `SourceEvent::AudioFlowing` confirms (#8 again), bounded by
`ONSET_TIMEOUT`. A source with no audio, or already paused, is untouched (instant, as
before this task). Test: `tests/api.rs::player_pause_ramps_a_plain_source` (`--clock
real` — the gate's own wall-clock timing has nothing to pace against under `--clock
stepped`'s virtual time; now explicitly inert there regardless — see the stepped-mode
note below — not merely harmless by accident of every existing test pausing
mid-transition).

**R93 (review of Task 16c/16d) — the gate must never outlive or race its source's own
teardown, and must never run under the stepped clock.** Three fixes, found writing
`tests/api.rs::r93_destroy_mid_gate_never_leaks`:
- **Abandon on retire/destroy.** `Runtime::retire` (the single path behind `destroy`,
  `stop`, and output removal) calls `Runtime::abandon_pause_gate(id)` as its very first
  line, in every state (`Pausing`/`Paused`/`AwaitingFlow`/`Resuming`) — closing the
  gate's own dropout-probe window and removing it from `pause_gates`/`pause_gate_corr`
  *before* `retire` adds its own Animator-based ramp on the same `gain.anticlick` path.
  Without this a still-open gate kept writing that path directly underneath `retire`'s
  ramp (two writers, "safe" only by incidental drain order), and a gate in a
  non-writing state (`Paused`/`AwaitingFlow`) was never cleaned up at all — a permanent
  leak plus a dropout window left open forever.
- **Never re-opened for a `pending_destroy` id.** The abandon above isn't enough by
  itself: `drive_pause_gates_pre_sync`'s "new eligible sources" scan could re-create a
  *second* gate for the same id one `sync_sources` call later (found exactly this way —
  `destroy` issued with zero delay right after `set player.paused true`), whose wall-clock
  `Resuming` ramp then drove the source straight back to 0 dB while `retire`'s own,
  frozen-time ramp sat stuck — the node tore down fully audible. Fixed by excluding every
  id in `pending_destroy` from that scan, the same way a transition-held id already is.
  A defensive per-tick backstop also abandons any gate whose node is simply gone
  (`graph.kind_of(id) != Source`), independent of which path destroyed it.
- **Stepped clock: explicitly inert.** `drive_pause_gates_pre_sync` bails on
  `self.stepped()` as its first line — a gate is never opened there (mpv stays paused
  for good in stepped mode anyway; the gate's wall-clock ramp has nothing to pace
  against), rather than happening to be harmless only because every existing stepped
  test pauses mid-transition. Test: `tests/api.rs::
  stepped_player_pause_never_opens_a_gate`.

Probe (`loop`): `pause_gates` (open gate count, must return to 0),
`dropout_windows_open` (recorded audio windows — transitions, retires, gates — still
without a `transition.done`/`.done()`; a leaked gate window is the only thing that could
leave this nonzero after a destroy settles). `player.pause_gate_opened` (debug-level,
logged when a gate opens, carrying its `corr`) makes a still-open gate's window
discoverable without waiting for it to complete normally.

**Final review (I1, I2) — the gate on its own slot; teardown on the unpaused clock; pause
ends with the session.**
- **`gain.pause`** (`units::GainSlot::Pause`): the gate ramps its own slot, never
  `gain.anticlick` (which the recipe, `retire` and `park` ramp on the other clock). So it gates
  every *playing* source with audio — a source waiting on a pending `align: end` switch (the
  advance-on-end mode: before, that A was "busy" and paused with an unramped cut), both sides of a
  running full-live crossfade, a ramping grave — and a transition taking a gated source over has
  nothing to restore (before, an abandoned gate left `anticlick` at −96: a superseded/failed/
  cancelled switch restored A silent). Only sources already silent are skipped (node-paused —
  what reveal/frozen hold —, no audio, retiring, parked). At the pause edge a playing, ready
  source gets the `Pausing` ramp; one that becomes eligible later (opened, un-paused by the
  recipe, unparked — all composed paused already) starts `Paused` at −96, so its resume is the
  same flow-gated ramp-in. A re-pause turns a `Resuming` gate straight back from where it is (and
  a `Pausing` one resumes from its current level — before, it restarted from −96). Tests:
  `tests/api.rs::i2_pause_while_align_end_pending_is_ramped_both_ways`,
  `i2_switch_while_gated_never_leaves_a_playing_source_silent`.
- **Teardown completes while paused.** `retire` (destroy / stop / output removal) and `park` ramp
  on the **unpaused** base clock (`Runtime::teardown_anim`, `pending_destroy` and park settling
  on `ClockKind::now`, pushed by the fast timer too), and a source ramping out is excluded from
  the pause composition until it's gone. A source the pause already holds paused is silent and
  goes at once. Before, these waited on the frozen `Runtime::now` — a destroyed source kept its
  decoder until resume, then un-paused audibly for 30 ms with no picture.
- **`stop` clears `player.paused`** (legacy semantics: a stop ends the session), and the backend
  clears it for a new session (Apply / ApplyPlaylist / a cold Launch); a rotation keeps it. A user
  next/prev/random made while paused resumes first (the owner's default) or — with the
  `KeepPauseOnSwitch` setting — keeps it: the switch is then a cut, and a cut whose A is already
  silent (the pause gate holds a playing A at −96) swaps at once instead of waiting for the resume
  (`tests/api.rs::cut_while_paused_swaps_at_once`). Tests: `tests/api.rs::i1_pause_stop_then_switch_plays`, `r93_destroy_mid_gate_never_leaks`
  (now: torn down while still paused), `scripts/test-liascape-player-adapter.sh` (I1 cases).
- **The low-VRAM hold is a pause too (Phase 2 Task 8).** While the GPU's VRAM is low
  (`player.vram_low_mode` `stop`/`pause`, `crate::vram`), the runtime's effective player pause is
  `player.paused || vram hold` — so every rule above applies unchanged (gates ramp out, time and
  transitions freeze, the resume is the flow-gated ramp-in); `player.paused` itself is never
  written (a user pause made meanwhile survives the release). In `stop` mode the paused, silent
  media sources are then torn down (two-phase, the reaper) and reopened at their positions before
  the hold lets go; a still of each one's last frame is shown meanwhile, so the picture never goes
  black. `tests/api.rs::low_vram_stop_frees_and_resumes_every_source`,
  `low_vram_pause_mode_pauses_without_freeing`.

## 8. No audio onset or offset without a ramp the listener can hear — ramps run on audio that is actually flowing

**Why:** invariant #4's ≤ 30 ms anti-click ramp assumes the stream is already producing
audio the instant the ramp starts (an onset) or keeps producing it until the ramp ends (an
offset). Neither is true for real hardware: un-pausing mpv doesn't mean PipeWire's output
has actually restarted yet (owner's "flicker of silence" report, Task 15's dropout
detector measured ~19 ms of true digital silence after un-pause before any audio at all,
with the ramp's early portion simply never produced — `docs/player/debugging.md`'s
frozen-onset row), and a gain push reaching mpv is itself async, lagging the graph value
by a few ms (measured ~6 ms truncation of a ramp-to-silence's last moments, right before a
pause cut it off). Starting/trusting a ramp against the *graph clock* alone — never
checking whether the *device* is actually there yet — produces exactly the symptom this
whole invariant exists to prevent: an unramped click (onset) or a truncated tail
(offset), despite invariant #4's ramp nominally running the whole time.

**Enforced by (Task 16c):**
- **Onset (R85).** `SourceEvent::AudioFlowing` (`sources/mod.rs`) — `MpvSource` arms it on
  a genuine paused → un-paused edge (`apply("paused", false)`) and fires it once
  `audio-pts` actually changes (man mpv: "takes into account the audio driver delay",
  unlike `time-pos`, which doesn't distinguish a held stream from the audio-out restart
  lag) — immediately for a source with no audio track, an image, or stepped mode (mpv
  stays paused for good there; audio is always silent, so there's nothing to wait for).
  `recipes::transition::Transitions` holds every B-onset ramp (reveal/full-live at
  `Running`; frozen at `handoff`; a `frozen` interrupted mid-Running, in `commit`) as a
  `PendingOnset` — gain set to `SILENT_DB` and the source un-paused, but the `Animator`
  ramp itself not added — until `AudioFlowing` arrives or `ONSET_TIMEOUT` (150 ms) passes
  (logged `transition.onset_timeout`); a B with no real audio (`color`/`image`/`snapshot`,
  or `no_audio`) skips the wait entirely (`recipes::transition::b_has_audio`) — ramping
  it at once is already correct, nothing to confirm. A node with its own still-pending
  onset captured as a *different* transition's outgoing side (`Transitions::start`) has
  it force-started immediately, never left to resolve invisibly underneath whatever that
  new transition does to the same gain slot. `Runtime`'s player-pause gate (invariant #7's
  R88) reuses the same primitive for a resume.
  **R92 (review):** "no audio track" above originally only meant `no_audio` (our own
  request) — a `kind == "video"` file that simply has no audio *stream at all* still
  counted as "has audio" and waited the full `ONSET_TIMEOUT` every single time, logging
  `transition.onset_timeout` on every onset. Fixed by a third, genuinely observed signal,
  `has_audio` (`MpvSource`, mirrored into the graph like `kind`/`ready`): mpv's `aid`
  property — not `current-tracks/audio/id`, tried first and found to never re-notify for
  a file that has no track at all before *or* after load (measured directly,
  `tests/sources.rs::has_audio_reflects_real_track_presence` failed against it) — always
  has a real value (`"auto"` pre-resolution, then a track number or the literal `"no"`),
  so it reliably transitions even for the very first load. Ignored while `no_audio` is
  on (that's *our* request, not the file's own content) so the two signals never
  conflate. Defaults `true` (unknown ⇒ has audio, the conservative "don't falsely skip a
  real wait" choice) until a real source observes otherwise. `b_has_audio`/
  `Runtime::source_has_audio` both gained the extra `&& has_audio` check. Tests:
  `recipes::transition::b_has_audio_false_skips_onset_wait_entirely` (unit, synthetic),
  `tests/api.rs::r92_transition_onto_video_with_no_audio_skips_onset_wait` +
  `r92_pause_gate_skips_video_with_no_audio` (real GPU + libmpv, real clock).
  **Nothing (more) to hear (2026-10-25, TODO "onset_timeout on audio-less videos").** A
  selected audio track that stops producing — a 30 ms track on a 4 s video, a stream that
  stalls right after starting — or an audio-less file whose `aid` hadn't resolved yet still
  waited out the 150 ms and warned: the source only confirmed on a *later* `audio-pts`
  change. `MpvSource::confirm_flowing_by_time` (every tick) now also confirms (a) once
  `FLOWING_CONFIRM_MARGIN` of real time passed since the first change, and (b) when
  `audio-pts` is *unavailable* (mpv plays no audio) while the picture moved
  `NO_AUDIO_MEDIA_ADVANCE` (0.1 s of media) since arming — with audio playing, the audio
  is mpv's clock, so the picture can't run ahead of it. A core that never plays still
  never confirms. Test: `tests/api.rs::audio_less_b_never_times_out_its_onset_any_method_or_align`
  (RED before: all 6 method × align cells with the short track timed out).
- **Offset (requirement #2).** A ramp-to-silence immediately followed by a pause/destroy
  waits for the ramp's nominal duration *plus* `AUDIO_SETTLE_TAIL` (15 ms — comfortably ≥
  2× the measured ~6 ms truncation, small against the 30 ms ramp itself) before the pause
  actually lands: `recipes::transition`'s `tr.pause_at` (reveal/frozen's A-hold) and
  `Runtime`'s player-pause gate's `Pausing → Paused` transition both add this tail. No
  single mpv property reports "this gain push has landed in the audio actually output"
  (the recipe/runtime only ever see `SourceEvent`s, never mpv's own async request
  bookkeeping), so this is a measured fixed tail, not derived from a live confirmation —
  documented here rather than invented in place, and tuned against
  `tests/onmachine/dropout.sh`'s onset/micro_gap checks, not a single property read.

**Tests:** unit (`recipes::transition`, synthetic events, no GPU) —
`frozen_onset_waits_for_audio_flowing` (no `Animator` target at all until `AudioFlowing`,
`transition.done` waits for it too), `onset_timeout_ramps_anyway`,
`full_live_onset_waits_for_audio_flowing`, `a_pause_waits_for_audio_settle_tail` (ramp
done at `ANTICLICK` but not yet paused; paused once `AUDIO_SETTLE_TAIL` elapses too).
Real GPU + libmpv (`tests/transition.rs`): `frozen_silent_then_b_starts` (B stays exactly
`SILENT_DB` at the old "30 ms after the end" mark; reaches 0 dB well within
`ONSET_TIMEOUT` + the ramp), `full_live_gains` (B's midpoint is only asserted "genuinely
mid-ramp", not the exact equal-power value, since the real onset lag shifts it slightly),
`restore_targets_not_mid_ramp` (a node with its own pending onset captured as another
transition's A gets it force-started, so `note_gain`'s live-target read has something
real to capture). On-machine (`tests/onmachine/dropout.sh`, real audio): full-live,
frozen, reveal, a plain retire, and the `Runtime` player-pause gate (below) each assert
`drops == 0` and `micro_gaps == 0`, plus an onset check (first 10 ms after audio appears
must not exceed the ramp's own settled level by > 6 dB) for every case with a real onset.
**Green since Task 16d.** History (`docs/player/debugging.md`'s frozen rows): the onset fix
(R85) eliminated the original ~15–35 ms unramped-click window; the ~5–7 ms residual
`micro_gaps` Task 16c left on A's offset and B's onset was the `Animator`'s tick-rate
coarseness, closed by R90's 1 kHz gain timer (#4). The intermittent effect-start findings
that remained (a 4 ms / 61 dB micro-gap at A's ramp bottom with `lag_ms` 10, or a 30 ms /
73 dB "A's whole ramp silent" drop with `lag_ms` 40) were proven **not real**: the bus
meter *and* an independent `parec` capture of the bus monitor showed A's full 30 ms ramp
in all 24 reproduced runs, with A's mpv pause requested only after ramp + settle tail.
They were the detector's own alignment — the meter binned on the absolute 10 ms grid
instead of `expected`'s, a 10 ms-step lag (R96: now refined to 1 ms) and an auto-trigger
that analysed before the window's post-roll was captured — all fixed in
`probe/dropout.rs` without loosening any threshold (an instant cut injected at effect start
is still a 30 ms drop: `tests/dropout.rs::an_unramped_cut_at_effect_start_is_flagged`).
`dropout.sh` passes every case at 60 Hz and 240 Hz.

**Scenes (Phase 2 Task 6).** A scene's sound is its worker's own PipeWire stream, so the
same rules hold through `SceneSource`: `SourceEvent::AudioFlowing` waits for the worker's
`AudioFlowing` (the first stream buffer after an un-pause / `no_audio` off / route change / a
start that plays that pulled the scene's sound), at once for a scene without sound, stepped or
muted; the worker's own 30 ms gate fades anything that stops while audible and never pulls a
sample more when the compositor already ramped to silence; its process exits only once its
stream's level is exactly 0. Tests: `tests/api.rs::scene_audio_flowing_gates_every_onset`
(every onset path onto a scene `reason: flowed`, no `onset_timeout`),
`scene_crossfades_are_equal_power_on_the_bus`, `scene_pause_park_and_destroy_on_the_bus`,
`scene_reroutes_after_pipewire_restart` (`.claude/rules/player-core.md` § Scene worker →
"Scene audio (Task 6)").

**Final review (I6) — one onset helper for every path.** `src/player/src/onset.rs`:
`PendingOnset` (held ramp: `start` at the confirmation instant, never backdated; bounded by
`ONSET_TIMEOUT`), `Onsets` (a holder: `schedule` / `tick(events)` / `force` / `cancel`),
`has_audio` + `audible` (the one "can it be heard" predicate — `is_silent` used to ignore
`no_audio`/`has_audio`), `onset.held` / `onset.started {reason: flowed|timeout|forced|no_audio,
held_ms}` (debug) as the evidence. Every un-pause-then-ramp path uses it: the recipe's B onsets
(as before), `restore_a` (snap-back, a cancelled/failed/superseded switch, a grave shown again —
an A the recipe had held paused gets its anticlick ramp held, `Transitions::restore_onsets`),
unpark (`Runtime::onsets`), a restored source's fade-in (starts once it is `Ready` **and** its
audio flows — `MpvSource` now arms `AudioFlowing` on every load that plays, not only on an
un-pause), the R88 resume (same flow test + bound, on the gate's wall clock) and a re-route after
a PipeWire restart (`gain.pause` held until the rebuilt audio chain flows). `audio-pts` is observed
only while a confirmation is armed (its first notification after `observe` is the current value,
not a change). Test: `tests/api.rs::i6_every_onset_waits_for_flowing_audio` (unpark, snap-back,
R88 resume, frozen B, restore fade-in: each `onset.started` is `reason: flowed` and preceded by
that source's own `source.audio_flowing`).


## 9. A crashed scene keeps its picture, resumes where it froze, and touches nothing else

**Why:** spec §6.3 / the Phase 2 crash policy. A scene renders in a separate process
(`liascape-scene-worker`) precisely so that LWE crashing, hanging or losing its GL context can't take
the wallpaper — or anything else — down with it. The picture must never go black or jump: the
source keeps the last frame it latched (or, if none ever arrived, the item's preview image),
the scene clock stops at that frame for the outage so the restarted worker continues exactly
from it, and a scene that keeps crashing (3 restarts within 60 s) stops being retried — broken,
silent, its last frame / preview held, a crash record written and `source.broken` logged (the
backend advances a rotation from it). Another output, a video, the audio bus and the loop are
never affected. A player restart must not resurrect a broken scene into a fresh crash loop.

**Enforced by:** `sources::scene::SceneSource` (`hold_for_restart`: the clock stopped at the held
`t`, one resume tick, the clock released at the first frame of the next worker generation; the
internal preview `MpvSource`; `ContextLost` → `WorkerHost::kill_for_restart`; read-only
`broken`), `worker::WorkerHost` (restart budget, crash record), `snapshot` (`broken: true` →
restored as the preview, no worker). Tests: `tests/scene.rs::crash_holds_last_frame_and_resumes_at_position`
(the first new frame's `t` equals the held one; RED: +0.18 s), `crash_before_first_frame_shows_preview`,
`context_lost_is_a_restart`, `killed_worker_keeps_last_frame`, `restart_replaces_ring_after_first_new_frame`;
`tests/api.rs::crash_never_touches_other_outputs`, `hang_is_killed_and_restarted`,
`broken_after_three_restarts_in_60s`, `source_broken_event_names_the_scene`;
`tests/supervise.rs::broken_scene_restores_as_preview`; mid-transition:
`tests/transition.rs::scene_b_worker_crash_mid_effect_still_hands_off`,
`scene_b_broken_mid_effect_snaps_back` (`.claude/rules/player-core.md` § Scene worker → "Crash
policy (Task 10)").

## 10. A worker frame never blocks the compositor

**Why:** a scene worker renders on the same GPU as the compositor and can be arbitrarily slow
(a heavy 4K scene, a driver stall, a hang). If the compositor ever *waited* for a worker's frame —
`eglWaitSync` on the worker's fence, `glFinish`, a blocking read of the socket, "wait for the next
frame" — one slow scene would stall the one event loop that presents **every** output and drives
every video and audio ramp: missed frames and audio dropouts on screens that show nothing of the
scene. Spike `docs/player/spikes/dmabuf.md` §5 measured the alternatives (an implicit-sync or
no-fence read shows the slot's *previous* frame; a blocking fence wait costs the worker's whole
frame time on the loop). So the rule is one-directional: the compositor takes what is already
done and otherwise keeps what it has.

**Enforced by:** `worker::dmabuf::Latch::latch` — of the queued frames it picks the newest whose
acquire fence **already polls readable** (no fd = fdpoll mode = the worker waited on its own
fence), releases the older ones without a fence (never sampled), and when nothing is ready counts a
`stale_reuses` and leaves the previous frame in place — never black, never a wait. The only
GPU-side wait on a worker fence is `gpu_wait_fence` on a fence that is *already signalled* (a safety
net, free by construction). `SceneSource::update` is non-blocking everywhere (`WorkerHost::poll`,
`proto::recv` return `Ok(None)`; a full socket is `WouldBlock`, not a wait), the worker is spawned
(`posix_spawn`) and stopped (`reap` thread) without blocking, and a restarted worker's ring only
replaces the old one once its first frame latched (the old texture is shown until then). The
worker side of the same rule: it never `glFinish`es (fence, or its own fdpoll, or a bounded
`glClientWaitSync`). Tests: `tests/scene.rs::latch_never_waits_on_an_unsignalled_fence` (a worker
doing ~6 ms of GPU per frame: every `SceneSource::update` p99 ≤ 1 ms, max < 4 ms, `stale_reuses` >
0 — a fence wait would cost the frame's GPU time), `transport_never_shows_stale_torn_or_out_of_order`
(RED by mutation — every queued frame treated as ready: `frame 143: marker [141, 0, 0]`, the slot's
previous frame), `fdpoll_fallback_is_equally_correct`, `four_workers_latch_independently`,
`killed_worker_keeps_last_frame`; units `worker::dmabuf::latch_takes_newest_signalled_and_releases_the_rest`,
`forget_worker_keeps_the_frame_and_never_releases_it`, `external_only_modifier_is_refused`;
`tests/api.rs::scene_create_and_destroy_never_stall_the_loop` (max loop busy ≤ 3 ms around a scene's
creation and destruction). See `.claude/rules/player-core.md` § Scene worker → "Frame transport (Task 4)".

## 11. A worker's audio is a gain on a stream that keeps running

**Why:** invariant #1 applied to a scene's sound. LWE decodes and mixes the scene's audio inside the
worker, so the scene's sound necessarily leaves the worker as its **own** PipeWire stream on the
player bus. If the compositor controlled that sound by creating or destroying streams (or the worker
by starting a stream when the scene "begins to be heard"), a switch would have a moment of "nothing
playing yet" or "the old thing already stopped" — exactly the seam the player exists to remove. So the
stream is opened silent and left alone; the *compositor* ramps it in dB like any video's
`volume-gain`, and the stream is only closed once the level reaching the bus is exactly zero.

**Enforced by:** the worker's `audio::Dsp` — pull (LWE's host audio driver, patch 0003; pitch-kept
time-stretch, bit-exact at 1×) → a 30 ms linear-amplitude **gate** (open while the scene plays; a pause,
`no_audio`, a route change or a quit fades it, counted in whole frames) → **gain** (the compositor's
`Gain {db}` — the source's `gain.*` slots summed in dB, interpolated linearly in amplitude across one
buffer; ≤ −96 dB is exact `0.0`). `Gain`/`NoAudio`/`Speed` are folded into a restart's `Start`, so a
restarted worker resumes at the same level, faded in by the gate. The process callback runs on
PipeWire's data thread with `RT_PROCESS` (a normal-priority thread dropped one 64-frame cycle at
random — a real dropout on the bus). Closing waits for level 0 (`Control::quit`, ≤ 200 ms); the
compositor's retire ramp has normally made it silent already. Onsets follow invariant #8: the worker
sends one `AudioFlowing` per arming only after a buffer really pulled the scene's sound into a real
stream, and the recipe's ramp-in waits for it. Scene audio is *not* handed over on a crash (the
process is gone — that is the one unavoidable cut, covered by #9). Tests: worker units
`gain_change_ramps_across_one_buffer`, `silent_db_is_exact_zero`, `gate_declicks_only_an_audible_stream`,
`audio_flowing_once_per_arming`, `time_stretch_speed_changes_are_continuous`; `tests/api.rs` (private
PipeWire) `scene_audio_on_bus_with_identity`, `scene_gain_ramp_reaches_the_bus` (a dB-linear
staircase-free ramp on the bus; 0 xruns with `RT_PROCESS`), `scene_no_audio_toggle_is_live`,
`scene_crossfades_are_equal_power_on_the_bus` (V→S, S→S, S→V, each with `probe dropout`: no
drops/micro-gaps), `scene_pause_park_and_destroy_on_the_bus`, `scene_reroutes_after_pipewire_restart`,
and `--ao null` `scene_audio_flowing_gates_every_onset` (each `onset.started` is `reason: flowed`;
RED with the worker's `AudioFlowing` suppressed: `reason: timeout`). See `.claude/rules/player-core.md`
§ Scene worker → "Scene audio (Task 6)".
