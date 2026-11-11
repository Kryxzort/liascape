<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Runtime

`src/runtime.rs` + `src/headless.rs` (spec §4.1/§4.2, §9 "headless deterministic mode";
Task 12). `liascape-player serve --headless [--outputs 1920x1080@60[,…]] [--clock real|stepped]
[--ao <mpv ao>] [--socket <path>] [--log-level error|warn|info|debug|trace] [--restore [--session-start]]
[--no-supervise] [--redraw-policy content|every_tick]` — defaults `1920x1080@60`, `real`,
mpv's liascape-player default ao (`pipewire`), `info`. `serve` is **supervised** unless
`--no-supervise` (§ Supervisor: the process you start is the supervisor, the compositor is
its child); `--restore` recreates `<state>/snapshot.json` (§ Snapshot) — with `--session-start` (a session
start, § Programs "Playlist start") each program starts per its `start_mode`;
`--redraw-policy content` (headless only) presents like Wayland — only when the picture
changed (§ Wayland → Frame pacing) — instead of composing every tick. **Exit codes:** 0
clean (quit / SIGTERM / SIGINT), 1 refused at startup, never retried (lock held, an
unusable socket/state dir — `ServeError::Startup`), 2 usage, 3 the compositor connection
was lost mid-run (`ServeError::Runtime`; restarted when supervised), 4 the supervisor
gave up (either the crash budget or `EXIT_NO_COMPOSITOR`'s own backoff, § Supervisor
"Startup-failure classes"), 5 (`EXIT_NO_COMPOSITOR`, Task 16b) the compositor/EGL isn't
available *yet* — `ServeError::NoCompositor`; retried with backoff when supervised,
exit 1 straight through with `--no-supervise`. **`--ao null` in
every test (R26)**: it becomes `SourceHost`'s base opts, so every mpv source is silent —
and no audio bus is created (§ Audio bus). With the default AO, `serve` starts the bus
thread right after binding the socket and connecting to the compositor (a second instance, and
a start whose compositor isn't up yet, exit before touching PipeWire), never blocking on it: a bounded wait (`runtime::BUS_STARTUP_WAIT`, 500 ms from that start)
before the loop runs, and only if the bus is up by then the base opts get `audio_device` +
`audio_delay_bias` — else sources open on mpv's default device and move onto the bus when it
comes up (§ Audio bus → Fallback).
Without `--headless` it draws on the compositor's outputs (§ Wayland); `--outputs` is
then refused (exit 2).

**Paths (`src/paths.rs`).** Socket `$LIASCAPE_PLAYER_SOCKET`, else
`$XDG_RUNTIME_DIR/liascape/liascape-player.sock` (else `/run/user/<uid>/…`); the socket is
made `0600`, its dir `0700` — **only** if we created that dir or it's the default
`…/liascape` (a `--socket`/`LIASCAPE_PLAYER_SOCKET` in someone else's directory is never
chmod-ed). State/event log `$XDG_STATE_HOME/liascape/liascape-player/` (default
`~/.local/state/liascape/liascape-player/`). **Single instance = a lock file:** `<socket>.lock`
(`liascape-player.lock`, `0600`) is `flock(LOCK_EX|LOCK_NB)`-ed for the process lifetime and
holds the owner's pid; the loser exits 1 with `liascape-player is already running (pid N) on
<socket>; stop it with ctl quit, or give this one another --socket` and never touches the
socket. A lock taken on a file its previous owner unlinked meanwhile is detected (inode vs
path) and retried. The winner (holding the lock, so any socket file is a dead owner's)
unlinks an existing path only if it **is a socket**, and refuses anything else with a
hint. Socket + lock file are removed on every exit path after binding (`SocketFile`
guard; `remove_now` before `_exit`). Pinned by `concurrent_starts_one_serves` (5 rounds of
two simultaneous starts; RED before: `bind …: Address already in use`). A unix socket path
must be < 108 bytes — tests use `std::env::temp_dir()`, not `target/`.

**One calloop loop (`EventLoop<'static, Runtime>`).** Sources: the listener + one
edge-triggered source per client (§ Command API), one level-triggered source per mpv wake
eventfd — a **`dup`** of the source's fd (`F_DUPFD_CLOEXEC`), so a dropped source closing
its fd can never leave a dangling or reused-number registration —, a `Ping` for log events
from other threads, a `signalfd` (SIGINT/SIGTERM blocked process-wide before any thread
exists → a clean `quit`), and on the real clock a `Timer` at the max output refresh
(`tick_period`, recomputed on hotplug; skips ahead if a tick overruns), and on Wayland the
connection (§ Wayland). A failing dispatch (the compositor went away) logs `loop.failed`,
silences + tears down every source (`stop_all(true)`, then the normal shutdown) and
`serve` returns `Err` (`ServeError::Runtime`, exit `EXIT_RUNTIME` 3 — restarted when
supervised).

**Who runs what (R47).** The **timer tick** is the only place time-driven work runs:
`Animator::tick` → `Graph::set` (a failed set — node gone — cancels that animation,
`anim.dropped`) → due `stop` destroys → `sync_sources` (`drain_changes` → `SourceHost::sync`
→ wake-fd registrations) → `update_sources` (`SourceHost::update`; `source.ready`/`.ended`/
`.position` logged) → `Transitions::tick(every source event since the last tick)` →
`refresh_srcs` → compose + present every output (paced outputs: only those due, §
Wayland). **A wake (mpv eventfd) only flags**;
after every dispatch the loop syncs pending graph changes to the sources and, if woken,
updates them (textures, events) — never animation or recipes (ticking on wakes
self-sustains: every gain push's reply wakes the fd). Handlers run inside the client's
callback and change only the graph/animator/recipe; their changes reach the sources in the
same iteration's post-dispatch sync.

**The fast gain timer (R90, Task 16d).** A ≤ 30 ms anti-click ramp (invariant #4)
evaluated only on the main timer is stepped once per *output refresh*, not once per
sample: at 60 Hz that's 1–2 `Animator::tick` calls over the whole ramp, so mpv's
`volume-gain` holds each pushed value for most of the ramp's span then snaps straight to
the end — measured (Task 16c/d): 5–7 ms `micro_gaps` at 60 Hz, 2 ms at 240 Hz. A second,
independent calloop `Timer` at `runtime::GAIN_TICK_PERIOD` (1 ms) fixes this —
**armed only while a gain ramp is actually moving** (`Runtime::gain_work_pending`, final review
M1: a `gain.*` animation that has started or starts within one main tick period
(`Animator::has_live_gain(now, horizon)`) and isn't frozen by the player pause, a teardown ramp
(`teardown_anim`, unpaused clock), or a pause gate mid-ramp — a restored source's placeholder
fade-in far in the future or a transition paused mid-ramp no longer keeps 1000 wakeups/s going;
`Runtime::arm_gain_timer_if_needed`, checked from `sync_sources`, so a handler's `animate`/
`transition` or the recipe's own `Transitions::tick` arms it within one loop iteration)
and **self-disarms** (`TimeoutAction::Drop`, from inside its own callback,
`Runtime::gain_fast_tick`) the instant none remain, including the one that armed it
finishing on that very call. Each fire: `Animator::tick_gains(now)` evaluates *only*
`gain.*`-targeted animations (`anim::is_gain_path` — shared with `redraw::audio_only`,
§ Wayland "Frame pacing") at the current (pause-adjusted) `Runtime::now`,
`Graph::set_animated` each, then forwards straight to the hosted source
(`SourceHost::push_gain` — the same direct-apply bypass as the R88 gate's
`force_paused`, skipping the ordinary per-tick `sync`'s source-open/gone scan and
`player_paused` composition, neither of which a gain push needs) and removes those
entries from the pending-changes queue (`Graph::drain_gain_changes`, a gain-scoped
partition of `self.changes`, leaving every other pending change untouched) so the next
ordinary `sync_sources` never replays what this call already hand-delivered (it would
otherwise re-walk `self.changes` and reapply every historical value once per normal tick
while a ramp is in flight — exactly the per-tick cost this timer exists to bound). The
main timer is unchanged (R47 still runs everything else at the output refresh; this
timer only ever touches gain paths).

- **Pause composes (R88/invariant #7).** `Runtime::now` is frozen while `player.paused`
  — re-evaluating `tick_gains` against an unchanged `now` would just keep re-emitting
  the same already-sent value, so the fire skips evaluating *entirely* while paused: zero
  pushes, zero `graph.set` calls, and (M1) the timer **disarms** for the pause unless a gate or
  teardown ramp is moving — verified by `tests/api.rs::gain_fast_timer_paused_makes_no_progress`
  (`gain_timer_armed: false` throughout the pause). A resume re-arms it from the next
  `sync_sources` (≤ one loop iteration). `gain_fast_tick`
  also calls `update_player_paused()` itself as its first line — a race found while
  building this: the timer can fire within the same dispatch batch as the client request
  that just paused, before `after_dispatch`'s own `sync_sources` gets to it, and the
  cached `player_paused` field would read stale otherwise.
- **Stepped clock: never armed.** `arm_gain_timer_if_needed` bails on `self.stepped()` —
  gains there are evaluated at step boundaries exactly like every other property
  (`begin_step`'s own `run_anims`); there is no "real time" between steps for a 1 ms
  timer to drive anything against.
- **Bounded cost.** The fast tick's own work is one bounded scan of the (small) Animator
  entry list (`has_live_gain`/`tick_gains`) — no allocation on the hot path beyond the
  small per-emitted-value `Vec`s every tick already produces (same shape as the existing
  `tick`). It only runs at all while a gain ramp is actually in flight (typically tens of
  ms), never as a steady-state background cost.
- **Probe (`loop`).** `gain_timer_armed`, `gain_ticks` (fire count), `gain_pushes` (total
  forwarded), `recent_gain_pushes` (bounded `[t_mono_ms, db]` history,
  `GAIN_PUSH_HISTORY` = 256) — the acceptance evidence for "dense pushes" without logging
  one event per 1 kHz tick (which would allocate a JSON object even below the log level
  threshold).

**Stepped clock (R48).** No timer. `step {ms}`: advance the `SteppedClock`, run the
animator + due destroys + `sync_sources` + `update_sources`, then give every mpv source a
**virtual media time**: created at its first step at its graph `position` (no advance that
step, whenever it was opened); later steps advance it by `ms × speed` while the graph says
`paused: false`; `position`/`path` changes reset it (`position` value / 0); `loop` → modulo
`duration`, else clamped at `duration` (the first step at the end queues `Ended` via
`step_end` — mpv never reports EOF for a paused seek). Videos are `step_seek`ed (skipped
when the target is unchanged); images and not-yet-ready sources are waited for `Ready`.
The step **waits without blocking the loop** (`PendingStep`, re-checked after every
dispatch, a one-shot `Timer` wakes it at the deadline) until every wait is `Done`/`Broken`
— bounded by `STEP_TIMEOUT` (2 s) → `timeout` error naming each pending source, its target
and what it waits for (the tick still runs) — then runs the rest of the tick and replies
`{now_ms}`. **Per-client FIFO (item 8):** while a client's `step` is deferred, nothing more
is read from it — the requests it pipelined behind the step are answered after it (so a
pipelined `step` + `capture` captures the post-step frame; `pipelined_step_then_capture`),
and a half-closed client still gets its deferred reply before the close
(`half_closed_client_gets_step_reply`). Steps from different clients queue (≤
`STEP_QUEUE_MAX` = 64, then `busy` with a hint) and run one after another — iteratively, a
step that needs no frames finishing at once. Source `Position` events in stepped mode
come on every `time-pos` change (it only moves on a step's seek), not on a wall-clock
throttle. **Determinism** = the same command script
gives byte-identical captures (`stepped_is_deterministic`: two servers, FrameIndex clip,
markers 9 and 60 at 0.304 s and 2.032 s). Audio is silent in stepped mode (mpv paused).

**Outputs (`OutputBackend`, R46).** `kind/outputs/take_changes/target/picture/present/
as_headless_mut`, plus (Task 13, defaulted for headless) `paced/frame_state/process/
take_redraws/set_layer/take_pointer/as_wayland_mut`. `OutputInfo` carries `hz` (rounded)
and `refresh_mhz` (exact); `OutputChange` is `Added | Removed | Changed` (size/refresh →
read-only props via `set_observed`, `output.changed`). `Headless`: `VIRTUAL-1…n` in
`--outputs` order, each an RGBA8 texture + FBO; `present` is a no-op, `capture` reads
`picture`; it composes every output on every tick (not paced). Hotplug
(`apply_output_changes` — `backend.process(gfx)` first —, after every dispatch and in the
`headless.*` handlers) creates/destroys `out:<name>` (+ its main layer,
`name/width/height/refresh_hz`); Wayland hotplug runs exactly this path:

- **Added (R59):** its **remembered output props** are re-applied first (Task 16:
  `Runtime::out_props` — the settable `out:` props, `layer`/`paused`, that differed from
  their defaults when that connector was removed, or that a restored snapshot saved for a
  connector that wasn't present; `output_props_survive_replug`). If the parked wallpaper
  was parked **for this connector** (`Parked::connector`, only set by a restore), it shows
  that. Else the new output **joins the live transition covering the first other
  output** (`Transitions::adopt_output`, `transition.output_adopted`): it becomes one of
  that transition's outputs on that output's side (so its A is not "shown outside"), shows
  what the transition shows now (A before Running, the effect while Running, B after
  handoff), and is carried through cancel/failure/commit/handoff like the others. Else it
  shows `cur:` of the first output that has one; else the **parked** wallpaper, if any
  (below). `output.added {content}` (corr = the adopting transition).
- **Removed (R60):** the node + layer go; every live transition forgets the output
  (`Transitions::drop_output` — a side left with no layer drops its effect/snapshot and
  releases its A; a transition left with **no** output is committed at once,
  `transition.handoff {committed: true}`). Then whatever that output alone showed or held —
  not shown by another layer, not held/pending in a transition, not a snapshot — is
  **retired** (30 ms ramp to −96, then destroyed): no invisible audible source survives,
  and `srcs:*` never targets it. **Unless no output is left:** then the last current
  wallpaper (a committed transition's B, else what the output showed) is **parked** —
  ramped to −96 over 30 ms, then paused (and a transition's `xfade` set to its final 0 dB);
  it stays in `srcs:*` (`Graph::set_parked`) so global settings still reach it, and is not
  audible. The next output that appears with nothing to show shows it, unpaused (unless it
  was paused before) and ramped back in over 30 ms (`source.parked`/`source.unparked`;
  `state.parked`). Tests: `hotplug_mid_transition`,
  `hotplug_added_before_running_joins_transition`,
  `hotplug_added_during_running_then_cancel`, `remove_output_retires_what_only_it_showed`,
  `remove_all_outputs_parks_and_readd_resumes`,
  `remove_all_outputs_mid_transition_commits_and_parks_b`.

**The player-pause gate (R88; final review I2)** — `docs/player/invariants.md` #7. Ramps its own
`gain.pause` slot on wall-clock time (`PauseGate`, `drive_pause_gates_pre_sync` /
`_post_update`), so it gates every playing source with audio whatever transition it's part of
(only node-paused, no-audio, retiring and parked sources are skipped); at the pause edge a playing
source ramps out then pauses, a source that becomes eligible while paused starts `Paused` at −96;
resume = un-pause, wait for `AudioFlowing` (bounded), ramp in; a re-pause turns a resuming gate
back from where it is. Nothing to restore when a transition takes a gated source over.

**Teardown on the unpaused clock (final review I1).** `retire`'s and `park`'s ramps run on
`Runtime::teardown_anim`, an Animator ticked with the **unpaused** base clock
(`ClockKind::now`, `Runtime::base_now`) by the main tick and the fast timer; `pending_destroy`
deadlines and park settling use the same clock, and a source ramping out (or into its park) is
excluded from the player-pause composition until it's done — so a destroy, `stop` or output
removal completes (decoder freed) while the player is paused. A source the pause already holds
paused is silent (`onset::audible`) and goes at once. **`stop` clears `player.paused`** (after
retiring, so held sources go silently first): a stop ends the session, the next wallpaper plays.
**User-setting ramps land while paused (UI matrix):** `animate` on a setting gain slot
(`GainSlot::is_setting` — `user`/`override`/`normalize`/`mute`/`automute`) goes to
`Runtime::setting_anim`, an Animator on the same unpaused base clock (ticked by the main tick and
the fast timer, part of `gain_work_pending`, saved by the snapshot at its live target, cleared by
`stop`); one writer per path — adding to either animator cancels the other's ramp on that path. The
backend mutes with a 30 ms `animate srcs:*.gain.mute`: on the frozen clock a mute while paused
reached no source until the resume, then raced the gate's ramp-in. The recipe's slots
(`xfade`/`anticlick`) and every non-gain animation keep the player clock.
`tests/api.rs::setting_gain_ramp_lands_while_paused`. **A cut while paused swaps at once:** the
cut sets an already-silent A's anticlick (effective gain at −96 — what the pause gate holds a playing
source at) instead of ramping it on the frozen clock, so the swap is due at once; `release` already
buries a silent A at once, so a cut over a paused fade commits and swaps too; B shows its first frame,
held by the pause (its xfade ramp-in and the gate run at the resume).
`tests/api.rs::cut_while_paused_swaps_at_once`.

**No output left: transitions are accepted (final review I4).** With zero outputs (R60 parked),
`transition` on an `out:` alias goes to `Runtime::transition_parked`: B is created paused and
silent and **replaces the parked wallpaper** (the old one is retired — paused and silent, so at
once), reply `{corr, to, parked: true}`, events `transition.scheduled {parked: true}` →
`.handoff {committed: true, parked: true}` → `.done`. An `align: end` request waits instead
(`Runtime::parked_req`; the parked A is paused, its end can't come) and hands off when an output
shows B (`unpark`), or is `.cancelled {reason: "superseded", parked: true}` by the next one / by
`stop` — **unless the parked A never ends** (a scene or a still, the recipe's `never_ends`; Phase 2
Task 9): then it is handed off at once like `align: now` (`tests/api.rs::
parked_scene_align_end_hands_off_at_once`; RED before: it waited for an output). So a rotation keeps its place invisibly and the *last* target is what the next output
shows. Test: `tests/api.rs::i4_transitions_while_no_output_replace_the_parked_wallpaper`.

**Onsets (final review I6).** `Runtime::onsets` (`crate::onset::Onsets`, player clock) holds the
unpark ramp-in until the source's audio flows; a restored source's fade-in (`fade_in`,
`FadeWait`) starts once it is `Ready` **and** flowing (or `ONSET_TIMEOUT` after `Ready`, logged
`runtime.onset_timeout`; at once without audio); `drive_onsets` resolves both from each tick's
events. The R88 resume uses the same flow test + bound on its wall clock; a bus re-route holds
`gain.pause` the same way (I7). `onset.held`/`onset.started {reason, held_ms}` (debug) for every
path.

**Bounds (C1).** `probe loop` → `bounds`: the size of every per-source collection (graph nodes,
`gain_history_tracks/samples`, animator entries, teardown ramps, pending destroys, onsets,
fade-ins, dropout windows/due analyses, pause gates, `last_event`, `local`, wake registrations,
warn keys, hosted/opening/dying sources, `open_queued` (opens waiting for an `lia-open` worker),
transitions/graves/ended/restore onsets). `GainHistory`
is run-length encoded (a steady source = two samples), drops a dead source's track
`DEAD_LINGER` (30 s) after its last reading (its post-roll analysis needs it), and is capped at
`MAX_TRACKS` 64 / `MAX_TOTAL_SAMPLES` 131 072 (least recently seen dead track first). Test:
`tests/api.rs::c1_long_run_switches_stay_bounded` (200 switches + destroys: 64 tracks, ~4 200
samples, everything else ≤ 4), `probe::dropout` unit test (10 000 simulated cycles).

**Switch cost and the Phase 2 render worker (final review I5).** Per switch, measured
(`tests/api.rs::i5_switch_loop_busy`, a cut/fade to a fresh 1080p clip, 10 switches ×2 runs):
**before** max loop busy 32–54 ms (median 36–44), synchronous open 3–14 ms; **after** (core on
the `lia-open` worker, `dither=ordered`, the shader cache) 8–26 ms (median 17–19), open 1–8 ms.
**Residual:** the render-context creation (+ props + `loadfile`, 1–8 ms) and the new context's
first `render_into` (6–20 ms: shader compile/link — cached binaries help little on this
NVIDIA driver, which already has its own disk cache — scaler LUTs, texture/FBO setup) still run
on the loop, i.e. one to five missed frames at 240 Hz on every output per switch; Task 20's
pacing criterion should exclude the switch frame. **Phase 2 (as built):** a render worker thread with
its own EGL context in the compositor's share group owns every `MpvSource`'s render context —
creation, first render, and every later render into a shared texture (with a sync fence per
frame) — so the loop only samples finished textures. (Scene workers' dmabuf imports and latches
deliberately do **not** go through that thread — they run on the loop's own context, § Scene worker →
"Frame transport"; the plan's "same thread" idea was dropped for the share-group rebind and the extra hop.)
Until the render worker landed the loop counts the open share apart
(`max_open_ms`). These numbers hold for every `hwdec` since Task 20d (copy modes, no GL interop
init in the render context — § Sources "Hardware decoding"; before, `hwdec=auto` cost 230–320 ms
and a loadable libcuda 65–90 ms per switch). **Done since (2026-10-26/27):** the render worker
owns every real-clock source's render context, and its hwdec GL interop init (the CUDA context)
runs on an `lia-render` lane, never the loop — zero-copy hardware decoding with the loop's busy per
switch unchanged (§ Sources "Hardware decoding" → "Zero-copy on the render worker").

**Retire = ramp, then destroy (item 10, core invariant).** `Runtime::retire(id)` — used by
the `destroy` verb, `stop` and output removal: an audible source (not paused, ready,
above −96 dB, a kind with audio) gets `gain.anticlick` ramped to −96 over 30 ms
(`source.retire {ramp_ms}`); the node is destroyed **one tick after** the ramp ends (that
tick's sync carries the final −96 dB to the live source — destroying in the same tick
would drop the source before it got it: measured, it was torn down at −6 dB); a silent
one goes at once. `MpvSource` then sends its teardown `stop` only once its last gain push
has reached mpv, and `source.teardown {id, source_kind, gain_db}` records the level it
went at (`destroy_ramps_audible_source_out` asserts ≤ −95.9 and a ramp seen in between).
Parking pauses one tick after its ramp for the same reason.

**Runtime ↔ snapshot/supervisor (Task 16).** `sync_sources` marks the snapshot dirty on
any drained change or `picture_rev` move; `after_dispatch` writes it when due (§
Snapshot); `begin_quit` and the `loop.failed` path queue the **final** snapshot before
`stop_all` empties the graph. The Animator's per-tick values go through
`Graph::set_animated` (recorded, but not a `picture_rev` move) and `Redraw::mark_nodes`
marks only the outputs showing the animated node (§ Wayland → Frame pacing).

**stop / quit.** `stop`: every live transition dropped (`transition.cancelled {reason:
"stopped"}`), animator reset, the parked wallpaper forgotten, every layer emptied,
effects destroyed, every source retired (stepped clock: set to −96 and destroyed at once —
virtual time won't move by itself). `quit` (and SIGINT/SIGTERM — `sigterm_is_a_clean_exit`):
`stop`, exit once the destroys are done (≤ 120 ms), `SourceHost::finish_teardown(500 ms)`,
then `reaper::shutdown(2 s)`; socket + lock removed, exit 0. **If an mpv core is still
being destroyed after that wait** (a straggler, logged `mpv.reaper_stragglers`), the
process leaves with `_exit(0)` (item 16): every log line is already flushed, socket + lock
are removed first, and atexit/static destructors (libmpv, ffmpeg, EGL) are skipped so they
can't run under the straggler and spoil the exit status.

**Rate-limited warnings.** `compose.failed` is logged at most once per (output, reason) per
5 s with `suppressed: n`; tap overflow (`EventTap` dropped events) is logged as
`api.tap_overflow {dropped_total}` likewise (from the loop — never from inside the tap).

**Tests (`tests/api.rs`).** Spawn the real binary (`env!("CARGO_BIN_EXE_liascape-player")`)
with `serve --headless --outputs 640x360@60,320x180@60 --clock stepped --ao null` (some
add `--clock real`), temp `XDG_RUNTIME_DIR`/`XDG_STATE_HOME` under `std::env::temp_dir()`
(never the real ones); the `Serve` guard kills the child on drop (also on panic), and
every spawned `serve`/`ctl` child gets `PR_SET_PDEATHSIG(SIGKILL)` (`die_with_parent`) so
an aborted/killed test run never leaves a stray server behind. One server at a time
(process-wide lock, handed between the two servers of a two-run test). Skips only without
EGL or a catalogue (fails instead under `LIASCAPE_REQUIRE_GPU=1`, § GFX / EGL). **Gotcha:** in `state.graph` a source node's `kind` is its *Source*
kind (`video`/`image`/`color`/`snapshot` — the schema prop overwrites the node kind in the
snapshot); recognise sources by `gain_effective_db`. And a log `fields` key named like a
fixed key (`kind`, `corr`, …) overwrites it — `source.open`/`.teardown` say `source_kind`.
