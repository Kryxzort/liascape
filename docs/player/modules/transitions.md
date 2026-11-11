# Transition recipe

Covers `src/player/src/recipes/transition.rs` and `src/player/src/onset.rs`. Rules:
`.claude/rules/player/runtime-api.md` § Transition recipe; invariants #1, #4–#8 in `docs/player/invariants.md`.

`Transitions::start`/`cancel`/`tick` only issue graph `create`/`set`/`destroy` and Animator calls. A
`TransitionReq` is `{outputs (alias), to (B's create props), effect_id (None = cut), params, duration_ms, method:
full-live|reveal|frozen, align: now|end, origin}`.

## State machine

```text
start() → Scheduled → WaitingReady → WaitingStart → Running → Handoff → Done
          B created    B Ready        align instant;  effect     layers → B, fx and
          paused,      (READY_TIMEOUT, snapshots ready; animating  snapshots destroyed,
          xfade −96    LOADING_READY_ no graves on              A released → graveyard
                       TIMEOUT while   the outputs
                       B `loading`)
pre-Running ── superseded / cancel / B failed ──▶ abort: B destroyed, A restored exactly
Running     ── new start on an overlapping output ──▶ commit (→ Handoff)
Running     ── cancel / B failed ──▶ snap back to A
```

With no A on any requested output (after supersedes ran) the request runs as a cut whatever effect it asked for;
an A on any one output keeps the effect.

## Per method

t0 = effect start, D = duration, gains animated in linear amplitude (`AnimUnit::GainLinear`), never shorter than
30 ms (D = 0 cuts the picture at once; `done` waits for the gains).

| method | picture | A (not shared) | B |
|---|---|---|---|
| full-live | fx `from = A` | `gain.xfade` k·cos over max(D, 30 ms), k = its current level | unpaused at t0; `gain.xfade` sin over max(D, 30 ms), held for audio |
| reveal | fx `from` = snapshot of A | `gain.anticlick` → −96 in 30 ms, paused after `AUDIO_SETTLE_TAIL` more | unpaused at t0; xfade sin, held for audio |
| frozen | fx `from` = snapshot of A | as reveal | stays paused on its first frame at −96; at handoff unpaused, anticlick 30 ms ramp in, held for audio |
| cut | swap at t0 + 30 ms (t0 if no A was ramped) | playing → anticlick −96 over 30 ms; ended/paused → set at once | unpaused at the swap, xfade 0→1 over 30 ms; never held |

**Held onsets.** A held cell un-pauses B at −96 and records a `PendingOnset`; the ramp is added only when B's
`AudioFlowing` arrives, starting at that instant (never backdated), or after `ONSET_TIMEOUT` (150 ms,
`transition.onset_timeout`). mpv/PipeWire's audio-out restart lags an un-pause by ~19 ms, so a ramp started at the
un-pause ran its early part on no audio. `onset::has_audio` (`video`/`scene`, not `no_audio`, `has_audio` not
false) skips the wait for anything that can't be heard. `done` waits for an outstanding onset; `commit_unseen`
drops a pending onset instead (nothing shows B any more).

**A's hold-then-pause** lands `AUDIO_SETTLE_TAIL` (15 ms) after its 30 ms ramp because the gain push is async
and mpv buffers audio a few ms behind the graph value. It is a measured fixed tail, not a confirmation.

reveal/frozen snapshot only an A whose picture can still change; a still (by kind: image, colour, snapshot) or an
A that has ended is held as itself. With snapshots the effect starts one iteration later (the copy opens on the
host's next `sync`).

## Align

`now` = when B is ready. `end`: the lead A is the first requested output's A; a lead that never ends (still,
scene) or is absent starts now. A non-shared A gets `loop=false` at `start` (restored on cancel/failure, and
rewound if it ended because of it).

- **full-live** ends at A's end: start = end − D, where end is the minimum over ticks of
  `now + (duration − time_pos)/speed` (`time_pos` = the shown frame's pts, mirrored every tick). It aims at the raw
  minimum: a half-frame "centring" made the handoff land 10–14 ms before A's last frame had its full duration. The
  handoff now lands 0…one output frame after `Ended` plus one clip frame. A speed change rescales the minimum
  (`t + (end − t)·s0/s1`) rather than restart from a `time_pos` that may be 100 ms stale (`Position` is
  rate-limited). A start instant missed between two ticks is backdated ≤ one tick; one already past at the first
  evaluation starts at once and A holds its last frame for the difference (`Tr::end_hold`).
- **The effect follows A's end** (`follow_a_end`, every Running tick): when a speed-up moves A's end earlier by
  more than `COMPRESS_MIN_GAIN` (10 ms), the effect's remaining progress and both xfade ramps are compressed to the
  new end with `Animator::compress_to` (value continuous, same curve), never to less than `COMPRESS_FLOOR`
  (100 ms) left and never under the 30 ms gain floor. Never stretched: after a slow-down the effect ends before A,
  invisibly. Measured over a 60-seed speed-drag storm: −4.6…+10.8 ms vs A's end (uncompressed, up to +391 ms).
- **reveal/frozen/cut** start at A's `Ended` (tracked from events, so an A that ended before the request counts).
- **A shared looping A** keeps its loop and sends no `Ended`. Its boundaries anchor on mpv's `time_pos` drop, which
  happens while the last frame is still shown: boundary = drop + one frame (+ k·length). reveal/frozen copy A's
  last frame at the drop tick and start at the boundary (+0.0 ms vs the visible wrap); full-live ends on the
  first reachable boundary once a drop was seen (before that, the `time_pos` estimate runs ~17 ms ahead).
- **Bounded:** an A that never reaches its end (errored without `Ended`, stalled, no duration) starts the effect
  after its remaining play time + `ALIGN_SLACK` (10 s), `transition.align_fallback`. An A `Error` counts as ended
  at once. The wait is on the player clock, so a pause freezes it.

## Interrupt, cancel, failure

`start` creates B first, then resolves every in-flight transition sharing an output: pre-Running → abort
(`cancelled {reason: "superseded"}`; A's loop restored without a rewind, so the new request proceeds from A as it
is); Running → commit (layers → B, fx/snapshots destroyed, B to 0 dB over 30 ms, A released,
`handoff {committed: true}`); Handoff → left to settle. Only then is A captured. It also force-starts any other
transition's pending onset on a node it is about to capture as A, so two transitions never fight one gain slot.

`cancel`: pre-Running → abort (an A that ended only because `end` turned its loop off is rewound); Running → snap
back (layers → A, A's gains ramped back over 30 ms, B to −96 then destroyed); after handoff → `unsupported`.
Restores are exact: each gain is recorded as `Animator::live_target_of` while a ramp is live, else the current
value. B `Error`, destruction or no Ready in time → the same abort or snap-back with `transition.failed`; after
handoff B's errors aren't the recipe's business. `restore_a` un-pausing an A the recipe had held puts its anticlick
at −96 and holds the ramp for its audio like an onset.

## Release and graveyard

At handoff/commit each A is released: still shown by some layer → restored (playing, audible, its own loop);
paused → destroyed at once; at −96 → buried; its own xfade landing at −96 within 30 ms → buried then; else ramped
to −96 over 30 ms, then buried. A grave a layer shows again in time is restored. Graves are processed at the top of
`tick` so a source's final −96 dB reaches it in that iteration's `sync` before the node goes. A transition can't
enter Running while a grave on its outputs is pending: at most two streams per output. `transition.done` = settle
time passed and no graves left.

A shown by a layer outside the request is never paused, ramped, loop-changed or destroyed; reveal/frozen hold it
via a snapshot. Mixing two audible wallpapers is out of scope (`docs/TODO.md`).

## Events and hotplug

Per corr, in order: `transition.scheduled` (with `origin`), `.started {start_ms, a, b}` (`a`/`b` are audio
snapshots for the dropout detector; `start_ms` may be ≤ one tick before `at_ms`), `.handoff {committed}`, `.done`
— or `.cancelled`/`.failed` after `scheduled`/`started`. Times are on the player clock. `held_sources()` feeds the
`srcs:` alias's transition half.

`adopt_output(new, like)`: the newest transition covering `like` takes `new` onto that output's side and carries it
through every later phase. `drop_output`: a side left with no layer destroys its fx/snapshot and releases its A;
the lead is re-picked if its side went; a transition left with no output commits at once (`commit_unseen`) and
returns its B for the runtime to park or retire.

## Tests

`tests/transition.rs` uses `tests/common/harness.rs` (graph, animator, stepped clock, `Gfx`, `SourceHost`,
composer; `VIRTUAL-n` 640×360, `ao: null`). Each harness tick waits ≥ 2 ms (`MIN_TICK`: otherwise a gain ramp
becomes a tick storm, since every push's mpv reply wakes the fd) and steps the clock by the wall delta; `tick_to`
carries the excess so virtual time never drifts from mpv's. `FrameIndex` markers alias neighbours in limited range
(4 reads as 3): compare ± 1.
