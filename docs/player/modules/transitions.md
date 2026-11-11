<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Transition recipe

`src/recipes/transition.rs` (spec §4.3 "Transition A→B", §10 Transitions; invariants #1,
#4, #5, #6). `Transitions::start(TransitionReq, graph, anim, now) -> CorrId` /
`cancel(corr, graph, anim, now)` / `tick(graph, anim, &host.events(), now)` /
`drain_events()` / `status()`. It only issues graph `create`/`set`/`destroy` and
`Animator::add`/`cancel_target` — no rendering, no source access, no per-kind code.
`TransitionReq { outputs (alias), to (B's create props incl. path, or kind color),
effect_id (None = cut), params, duration_ms, method: full-live|reveal|frozen, align:
now|end }` deserializes from the API's JSON (all but `outputs`/`to` default).

**State machine** (one per request):

```text
start() → Scheduled → WaitingReady → WaitingStart → Running → Handoff → Done
          B created    B Ready /      align instant;  effect     layers → B, fx +
          paused,      graph ready    snapshots       animating  snapshots destroyed,
          xfade −96    (10 s timeout; ready; no                  A released → graveyard
                       50 s while B   graves on outputs
                       `loading`)
pre-Running  ── superseded / cancel / B failed ──▶ abort: B destroyed, A restored exactly
Running      ── new start on an overlapping output ──▶ commit (→ Handoff)
Running      ── cancel / B failed ──▶ snap back to A
```

**From nothing** (owner's list, `Transitions::start`): no A on any requested output, once the
supersede above has run → the request's effect is dropped and it runs as a cut, whichever client or
program asked (the events carry `effect_id: null`): B appears on its first frame with the 30 ms audio
ramp. An A on any one requested output keeps the effect. `effect_from_nothing_is_a_cut`,
`effect_stays_with_any_a_and_superseding_from_nothing_stays_a_cut`; matrix `fromNothing:noEffect`.

**Per method** (t0 = effect start; D = duration; all gains in linear amplitude,
`AnimUnit::GainLinear`):

| method | picture | A (not shared) | B |
|---|---|---|---|
| full-live | fx `from = A` | `gain.xfade` k·cos over max(D, 30 ms) (`EqualPowerOut`, k = its current level) | unpaused at t0; `gain.xfade` sin over max(D, 30 ms) (`EqualPowerIn`) — **held** (R85, below) |
| reveal | fx `from =` snapshot of A | `gain.anticlick` → −96 in 30 ms + `AUDIO_SETTLE_TAIL`, *then* paused (requirement #2, below) | unpaused at t0; `gain.xfade` sin over max(D, 30 ms) — **held** (R85) |
| frozen | fx `from =` snapshot of A | as reveal | stays paused (first frame, −96); at handoff: anticlick −96 + xfade 0, unpaused, anticlick ramp to 0 dB in 30 ms — **held** (R85) |
| cut (`effect_id` null) | swap at t0+30 ms (t0 if no A was ramped) | per A: still playing → anticlick → −96 over [t0, t0+30]; ended/paused → set at once | unpaused at the swap; xfade 0→1 linear over 30 ms → done at t0+60 — never held (R85 applies only to an onset that follows an un-pause; a cut's B was never paused by the recipe in a way that needs confirming — it's created paused and unpaused exactly once, same instant as its ramp) |

**R42:** gain animations never run shorter than 30 ms, whatever D is (D = 0 cuts the
picture instantly; `done` waits for the gains). `zero_duration_gains_still_ramp_30ms`.

**R85 (Task 16c, invariant #8) — "held" B-onset ramps wait for real audio.** Each "held"
cell above doesn't call `Animator::add` at the same instant it un-pauses B; it unpauses,
sets the gain to `SILENT_DB`, and records a `PendingOnset { id, slot, from, to, dur,
curve, requested }` on the `Tr` (`tr.onset`) — a transition has at most one at a time.
`Transitions::tick`'s own event loop resolves it the instant a `SourceEvent::AudioFlowing`
for that id arrives (`start_onset`: *now* adds the `Animation`, with `start` = the
confirmation instant, never backdated to the un-pause); `step()`'s own top-of-call check
resolves it unconfirmed once `ONSET_TIMEOUT` (150 ms) passes, logging
`transition.onset_timeout`. `recipes::transition::b_has_audio` (= `crate::onset::has_audio`: kind `video` or `scene` (Phase 2
Task 5) && not `no_audio` && not `has_audio == false`, R92) skips the whole mechanism for a `color`/`image`/`snapshot` B, or one explicitly
muted — nothing to confirm, ramp it in at once exactly as before this task
(`schedule_onset` is the one seam every call site goes through). `Phase::Handoff`'s
`transition.done` check requires `tr.onset.is_none()` too — never fires while a
confirmed-but-still-ramping (or still-unconfirmed) onset is outstanding; every
`settle_until` write downstream of a `begin_running`/`handoff` that scheduled one uses
`.max()`, never a plain assignment, so a *later*, unrelated settle-time recompute
(`handoff`'s own, `commit`'s, `commit_unseen`'s) can't accidentally shorten the wait for
an onset that resolved earlier and is still mid-ramp (`commit_unseen` is the one
exception — nothing shows B any more there, so a still-pending onset is dropped outright,
never started, rather than extending `done` for a ramp nobody will ever hear).
`Transitions::start` also force-starts any *other* transition's still-pending onset on a
node about to become *this* request's outgoing A (`cur:<connector>`, the same set
`build_sides` computes) — the node is about to be captured and ramped by someone else;
leaving the first onset to resolve invisibly later would fight whatever the second
transition does to the same `gain` slot. `commit` (a `frozen` transition interrupted
mid-Running, B still genuinely paused) creates its own `PendingOnset` the same way
`handoff`'s Frozen branch does, rather than ramping immediately like every other
`commit` case — the one place besides `begin_running`/`handoff` where B's `paused` is
a *real* edge, not a re-assertion of something already false.

**Requirement #2 (Task 16c, invariant #8) — A's hold-then-pause waits for the ramp to
settle, not just its nominal 30 ms.** `tr.pause_at` (reveal/frozen's A-hold) is
`t0 + ANTICLICK + AUDIO_SETTLE_TAIL` (15 ms), not `t0 + ANTICLICK` — the gain push
reaching mpv is async and mpv's own audio buffering lags the graph value by a few ms, so
the pause must not land before the ramp has actually settled. `AUDIO_SETTLE_TAIL` is a
measured fixed tail (documented at its `pub const`), not a live confirmation — no
`SourceEvent` reports "this gain push has landed in the audio actually output" the way
`AudioFlowing` does for an onset. **This fix is real but doesn't close every A-hold
dropout**: on-machine evidence (`docs/player/debugging.md`'s offset row) shows a
different, ~5–7 ms gap at A's ramp tail that occurs *before* `pause_at` even fires —
root-caused to the `Animator`'s tick-rate coarseness on a 30 ms ramp (invariant #4's own
caveat), not the pause timing this fix controls — **resolved since** by R90's 1 kHz gain timer
(Task 16d) and the detector's own R94/R96 alignment fixes (`docs/player/invariants.md` #8).

`fx.progress` is Linear 0→1 over [t0, t0+D]; handoff happens on the first tick ≥ t0+D (`Tr::end_at`;
earlier once a full-live `align: end` effect is compressed — Align below).
reveal/frozen snapshot only an A whose picture can still change: a still (by **kind** —
image/colour/snapshot; a video is never a still, even with no known duration) or an A that
has ended (it holds its last frame) is held as itself. With snapshots the effect starts one
iteration later (the host opens the copy on its next `sync`).

**Align.** `Now` = when B is ready. `End` (lead A = the first requested output's A; an A
that never ends — a still or a **scene** (`never_ends`, Phase 2 Task 9: no duration, no
`Ended`) — or an absent A → `Now`, at once, never the `ALIGN_SLACK` fallback; its loop is left
alone): non-shared A gets `loop=false` at `start` (restored on
cancel/failure — and seeked to 0 if it ended because of it). full-live *ends* at A's end:
start = end − D, where end is the minimum over ticks of `now + (duration − time_pos)/speed`
(`time_pos` is the shown frame's pts, mirrored into the graph every tick, so the minimum is
taken right after a frame change and sits within a tick of the true end; the frame step is
the smallest `time_pos` increment). **F3 (2026-11-04): no longer minus half a frame** — that
"centring" assumed samples anywhere inside a frame and made the handoff land 10–14 ms
*before* A's last frame had had its 33 ms (the Phase 3 battery: 7–20 ms after `Ended`), B
drawn over a frame the clip still owned; aimed at the raw minimum it lands 0…one output frame
after `Ended` + one clip frame (`tests/api.rs::align_end_hands_off_as_a_last_frame_ends`, 144 Hz
headless, real libmpv: before −9.8…−13.7 ms, after within [−1, +1] output frame); a speed change **rescales** that minimum (`t + (end − t)·s0/s1`, still an
over-estimate) instead of restarting it from a `time_pos` that may be 100 ms stale (`Position` is
rate-limited — under a continuous drag no fresh sample arrived between two changes and the effect
started late; `align_end_tracks_a_speed_dragged_continuously`). If the start instant passed between
two ticks the effect starts backdated (≤ one tick) so it still ends on time; if it's already past
at the first evaluation (A shorter than D, or B late) it starts at once and A holds its last frame
for the difference (`Tr::end_hold`, by design). **The effect keeps ending with A
(`Transitions::follow_a_end`, every Running tick; TODO "speed-up inside the last D"):** a speed-up
that moves A's end earlier — before the start (the start instant jumped into the past: it starts at
once) or mid-effect (a global speed reaches A through `srcs:*`) — **compresses the effect's
remaining progress** to A's new end (+ `end_hold`), and A's/B's xfade ramps with it (audio follows
the picture; a still-pending B onset ramps within the new end). `Animator::compress_to` only
rescales the rest of each animation in time: value continuous at that instant, same curve, final
value at the new end. Judged on the raw `end_est` (a move > `COMPRESS_MIN_GAIN` 10 ms; the centring
never reads as one), aimed at the centred end, never to less than `COMPRESS_FLOOR` (100 ms) of
remaining effect (an A whose end is already here holds ≤ 100 ms instead of the picture cutting),
R42's 30 ms gain floor kept; `transition.compressed {a, end_ms, to_end_ms, a_end_ms, hold_ms,
speed}` (info). **Never stretched:** after a slow-down the effect ends before A — invisible (B is
fully shown) and D stays the longest it runs. Handoff = `Tr::end_at` (t0 + D unless compressed).
Measured: the 60-seed drag storm ends −4.6…+10.8 ms vs A (RED, uncompressed: up to +391 ms); unit
`align_end_speed_up_mid_effect_compresses_to_a_end` (RED +1113 ms), `…_inside_last_d_of_the_wait_ends_with_a`
(RED +1426), `align_end_compression_keeps_the_hold_and_never_stretches`, `anim::compress_to_keeps_value_and_shape`;
real libmpv `tests/api.rs::align_end_speed_up_mid_effect_hands_off_at_a_end` (stepped, `srcs:*.speed`
4× 300 ms in; RED +892 ms). A shared looping A (boundary cached, TODO) isn't followed. reveal/frozen/cut *start*
at A's `Ended` (tracked from events: set on `Ended`, cleared on `Ready` or a `Position`
going back — so an A that ended before the request counts too). Shared looping A (loop
untouched, no `Ended`): full-live aims at the current iteration's end, or the next one if
that is already too close. **Looping (shared) A boundaries are anchored on mpv's
`time_pos` drop** (it drops while the last frame is still shown — § Sources): boundary =
drop + one frame (+ k·length for later ones); reveal/frozen copy A's last frame at the drop
tick and start at the boundary (measured +0.0 ms vs the visible wrap); full-live, if a
drop has been seen, ends on the first reachable boundary, else uses the uncentred `time_pos`
estimate (on a looping file it runs ahead of the picture: −17 ms measured). The ½-frame
centring is for an A that ends (measured −0.8…+12 ms vs `Ended`). **Bounded (final review
M2):** an A that never reaches its end — it errored without `Ended`, stalled, or has no known
duration — doesn't hold the switch forever: after A's remaining play time at its speed +
`ALIGN_SLACK` (10 s; `Tr::align_deadline`, re-derived after a speed change or a new lead) the
effect starts now (`transition.align_fallback {a, deadline_ms}`); an A `Error` counts as ended
for alignment at once. The wait is on the player clock, so a player pause still freezes it.
**Restores hold their onset (I6):** `restore_a` un-pausing an A the recipe had held (reveal/
frozen snap-back, a grave shown again) sets its anticlick to −96 and holds the ramp back
(`Transitions::restore_onsets`, `crate::onset::Onsets`) until A's audio flows; `start` forces a
pending one on a node it captures.

**Interrupt / cancel / failure** (R35/R36, invariant #6): `start` first creates B (a bad
request changes nothing), then resolves every in-flight transition sharing any output:
pre-Running → `abort` (`transition.cancelled {reason:"superseded"}`; A's loop restored
**without** a rewind — the new request proceeds from A as it is, R44); Running → `commit`
(layers → B, fx/snapshots destroyed, B unpaused with xfade/anticlick → 0 dB over 30 ms, A
released; `transition.handoff {committed: true}`); Handoff → left to settle. Only then is A captured (so it's the restored A, or the
committed B). `cancel`: pre-Running → `abort` ("cancelled"; an A that ended only because End turned its
loop off is rewound so it loops on, R44); Running → `snap_back` (layers → A, A restored
with gains ramped back over 30 ms, B → −96 over 30 ms then destroyed); after handoff →
`unsupported`. **Restores are exact (R41):** each gain is recorded as
`Animator::live_target_of` its slot when a ramp is **still live** (a predecessor's
ramp-in, a commit's ramp, a snap-back), else its current value — **not** `target_of`
(Task 16b fix round): `target_of` keeps returning a *finished* animation's held end
value even after a later direct `set` on that same path (a settings change landing after
a ramp completed), which would make a restore land back on the stale target instead of
what the `set` actually put there; `live_target_of` returns `None` once the animation is
done, so `note_gain`'s `unwrap_or_else(|| gain_db(…))` fallback correctly reads the
`set`'s value instead. Two call sites (`note_gain`'s own target; `release`'s "is A's own
fade-out about to land within 30 ms" check) both switched; unit test
`recipes::transition::tests::restore_uses_live_target_not_a_stale_finished_one`
(animate a gain to −20 dB, let it finish, `set` it to −6 directly, start + cancel a
transition → restores to −6, never the stale −20). B's `Rejected` events are ignored
(R45) — only `Error` fails it. B `Error` / destroyed / no Ready in 10 s before handoff → the same
abort or snap-back with `transition.failed {path, reason}`; after handoff B's errors aren't
the recipe's business; A's errors are ignored (its texture holds its last frame).

**Release + graveyard.** At handoff/commit each A is released: if any layer still shows it
(directly or as an effect side) it's **restored** — playing, audible, its own loop (R43);
else if it's paused it's destroyed at once (never a paused source outside a held method);
at −96 dB it's buried for the next iteration; if its own xfade lands at −96 within 30 ms
it's buried then (no second ramp); otherwise its anticlick ramps to −96 over 30 ms and
it's buried then. A grave a layer shows again by its time is restored instead of destroyed
(R43). Sharing is also re-evaluated at `begin_running`: a side newly shown elsewhere gets
back what was changed (End's loop) and is left alone. The
graveyard is processed at the *top* of `tick`, so a source's final −96 dB always reaches it
(that iteration's `sync`) before its node is destroyed. A transition can't enter Running
while a grave on its outputs is pending — at most two streams play per output.
`transition.done` = settle time passed (frozen/cut ramp-ins) and no graves left.

**Shared A (R34).** A per output = what its layer shows; one effect per distinct A (all `to =
B`). An A shown by a layer outside the request is never paused, ramped, loop-changed or
destroyed (its audio follows its picture there); reveal/frozen hold it via a snapshot.
Mixing policy for two audible wallpapers is out of scope (docs/TODO.md).

**Events (R37)** — outbox + `log::event("transition", …)`, each `{corr, at_ms, event,
…}` — `at_ms`/`start_ms` on the **pause-excised player clock** (`Runtime::now`), not
`t_mono_ms`: `transition.scheduled {outputs, to, path, method, align, effect_id, duration_ms}`,
`.started {method, effect_id, start_ms, a, b}` (`start_ms` may be ≤ one tick before `at_ms`, see
Align; `a`/`b` = each outgoing A's and B's `AudioSourceSnapshot` for the dropout detector, R70), `.handoff {to, from, committed}`, `.done {to}`, `.cancelled {reason}`, `.failed {path,
reason}`. Order per corr: scheduled, started, handoff, done — or scheduled[, started],
cancelled|failed. `status()` lists live transitions with `held` = sources paused on
purpose (pending B, held A's, frozen B, snapshots) plus its graves. `held_sources()`
(Task 12) → (`out:<c>` → {B, A's} per live transition, every grave): the `srcs:` alias's
transition half.

**Hotplug (Task 12 fix round, R59/R60).** `adopt_output(new, like, g)`: the newest live
transition covering output `like` takes `new` as one of its outputs — its main layer joins
`like`'s side (so that A is not shared), its content = what the transition shows (A
pre-Running, the side's fx while Running — A for a cut —, B after handoff); everything
later (handoff, commit, cancel/snap-back, failure) treats it like the original layers.
`drop_output(out, g, anim, now)` (the layer is already gone): the output leaves every
live transition; a side left with no layer destroys its fx/snapshot and `release`s its A
(restored if shown elsewhere, else ramped out → grave); the lead is re-picked (its End
tracking reset) if its side went; a transition left with **no** output is committed at
once by `commit_unseen` (effects go, A's released, `transition.handoff {committed:
true}`, Done when its graves are buried) leaving B exactly as it is — returns those
`(corr, B)` for the runtime to park or retire.

**Tests (`tests/transition.rs`, harness `tests/common/harness.rs`)** — Graph + Animator +
SteppedClock + Gfx + SourceHost + Transitions + Composer, virtual outputs `VIRTUAL-n`
640×360, `ao: "null"`. Each tick waits ≥ 2 ms (`MIN_TICK`: otherwise a gain ramp becomes a
tick storm — every push's mpv reply wakes the fd) and ≤ 16.7 ms on the sources' wake fds,
and steps the clock by the wall delta (R33); `tick_to(t)` lands exactly on `t` (the excess is carried, so
virtual time never drifts from mpv's wall time). One harness at a time (a process-wide lock
it holds): a dozen parallel 1080p decoders starve each other's mpv cores. `FrameIndex`
markers alias neighbours (limited-range luma: 4 reads as 3, 11 as 10) — ± 1 marker. Pure
state-machine rules (R44 seek, cut per-A ramps, video-is-never-a-still, held A destroyed at
handoff) are unit-tested graph-only in `recipes/transition.rs` (synthetic events, no GPU).
