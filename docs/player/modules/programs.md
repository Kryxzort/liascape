<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Programs (Phase 3; plan `docs/superpowers/plans/2026-10-29-liascape-player-phase3-programs.md`)
A rotation is a graph node `prog:<name>` (kind `program`, `recipes/program/`) — its settings are live properties,
and the recipe turns them into `transition` requests on the player clock. It never renders and never touches a
source; the transition recipe stays the one place a switch happens. The contract it reproduces is
`player-adapter.md` § Rotation (the C# `PlayerHelper` rotation, each Rust function naming the C# it ports).
- **Pure parts:** `rule.rs` (`item_rule` = `ItemPlayRule`, `max_reached`, `still_min_reached`, `min_reached`,
  `retime_remaining` = `UpdateTimedSettings`' arithmetic), `order.rs` (`Order`: cycles, shuffle with a new cycle's
  first ≠ the old one's last, history ≤ 100, random, `reorder` = `ReorderPlaylist`; a step is *planned* and only
  *committed* when its B starts — no C# pre-fetch), `pick.rs` (`TransitionCfg`, `pick` = `PickEffect` +
  `PickDuration`; params = the catalogue's uniform defaults, `Catalogue::defaults`). Seeded by the node's `seed`
  (`Rng`, SplitMix64); the snapshot keeps its state (`ProgramSnap.rng`), so a restarted player's shuffles and
  picks go on instead of replaying from `seed` (F7).
- **Node schema** (`graph::props`, `NodeKind::Program`, auto-id `prog<n>`): settable `outputs` (Str `out:*`, fixed
  after create), `items` (`PropValue::Items` — `[{path, props?, skip?}]`, ≤ 10 000, non-empty paths, `props` keys
  checked as `Source` create props; errors name `items[i]`), `defaults` (Source create props), `order`
  `sequential|shuffle`, `mode` `timer|on_end` (on_end), `interval_ms` / `max_ms` (0–359 999 000, 0), `separate_scenes`
  (true), `scenes_after_ms` (1 800 000), `transition` (`{enabled, effects, shuffle, duration_ms, duration_max_ms,
  method}`, `{enabled:false}`), `seed`; observed (read-only) `phase` (`idle|playing|holding|armed|switching|backoff|
  parked|empty`), `index`, `path`, `next_path`, `played_ms`, `remaining_ms`. A program node never moves
  `picture_rev`/`demand_rev` on create/destroy. `create`/`set` on it → `Programs::configure` (live); `destroy` stops
  the rotation and leaves the picture (a pre-Running armed switch is cancelled).
- **Verbs:** `program.play|next|prev|random` (Command API). `transition.scheduled` carries `origin: "api" |
  "program:<id>"` (`TransitionReq::origin`; the `transition` verb always sets `api`). `state.programs`, the
  `programs` probe (+ each item's `skip|broken|failed`), `hello.capabilities` + `program`.
- **Events** (comp `program`): `program.created|destroyed {id}`, `program.current {id, index, path, from, reason,
  corr}` (reason `play|timer|end|max|scenes_after|next|prev|random|broken|vram|failed_skip|items`), `program.armed`,
  `program.held` (debug), `program.failed {id, path, reason, backoff_ms}` (warn), `program.skipped {id, path, why}`,
  `program.empty {id}` (warn), `program.idle`, `program.requested` (debug).
- **Transition events reach the programs** with the tick after `Transitions::tick` (R47): the `transition`/`cancel`
  verbs and an output removal *stash* the outbox (`Runtime::stash_tr_events`) instead of dropping it.
- **The engine** (`Programs::tick`, Task 3; `Runtime::tick_programs` in `finish_tick` right after
  `Transitions::tick`, stepped and real clock alike; actions run by `Runtime::run_program_actions` through
  `Transitions::start` — or `transition_parked` with no output — never a second code path):
  - **Clock:** `PlayClock` adds the player clock's advance (`Runtime::now`: monotonic, pause-excised) — play time and
    the countdown stop with the picture (user pause, low-VRAM hold) and never see a wall-clock jump. Play time is
    wall clock (never speed-scaled); the timer countdown is scaled by the current source's `speed`.
  - **Commit** at `transition.started` of the program's corr (B current: `Order::commit`, play time 0 from that
    instant, `program.current` with `at_ms`); a `handoff` commits a step whose `started` was missed. Own supersedes
    are ignored (the pending corr is already replaced); another client's `cancelled` drops the pending step.
  - **Timer** (`mode: timer`): at `remaining ≤ 0` (`interval_ms > 0`) → `align: now`, mid-video; a 1-item program
    only restarts its countdown.
  - **On end** (`mode: on_end`, `interval_ms` = the minimum): the playing item's `item_rule`. Max reached → `align:
    now` (an armed end switch's B is taken — the recipe supersedes it). A still/scene: `still_min_reached` → `align:
    now` (`scenes_after` with separate timing, else `end`). A video: once its effect handed off, `min_reached(played,
    loop remaining = (duration − time_pos)/speed)` → `align: end` (`program.armed`); else held (`program.held`, A's
    `loop` set) and re-checked every tick, so the request goes in during the loop that reaches the minimum. The end
    switch is armed only after the current effect's handoff (a request during a Running effect would commit it early
    — the C# `DoVideoEndWait` waited for the overlay too) and never while parked (a parked A never ends).
  - **B's props:** `defaults` ∪ the item's `props` (item wins) + `path`, + `loop: true` under `on_end` with a minimum
    (a short clip loops until the reaching loop). The effect: `pick` (sequential/shuffle/duration range), `last_effect`
    updated at the request (as `PickEffect`).
  - **Breaks:** an `Error` from the current item's source → the next playable item at once, `align: now` — reason
    `vram` for a VRAM stop (`(vram_exceeded)` in the reason; not marked), else `broken` (the path is marked and
    passed over; `program.skipped`).
  - **Failures never spin:** `transition.failed` (or a refused request) → `program.failed {backoff_ms}`, the ladder
    `BACKOFF_MS` 1/2/4/8/16/30 s while failures continue (a handoff resets it), the path marked `failed` (passed over
    until the items change), then the next playable item (`failed_skip`). Nothing playable → `program.empty` once
    (until a commit); when every playable item has failed, the marks are cleared and they are retried at the ladder's
    pace (≤ 6 requests a minute).
  - **Another client's switch:** while a non-program transition is in flight the program requests nothing by itself;
    if the outputs then show another source (`cur:<first output>`), an item's path becomes current (reason `items`),
    anything else makes the program `idle` (until a verb).
  - **User switches** (`program.next|prev|random|play`, Task 4): always `align: now` with the program's pick (a cut
    with `keep_pause` while `player.paused`; the rotation clock stays frozen), superseding an armed switch (the
    recipe aborts it). `next` while armed takes the armed B (`AdvanceAndLaunch`'s pre-fetch); a verb while the
    program's own `align: now` request has not started goes on from *that* step (`Order::plan_after`: ten `next`s
    in a burst land ten items on, the history as if each had played); during a Running effect the recipe commits
    B and `next` goes to the item after it. `prev` at the session's first item → `{corr: null}`, an armed switch
    left alone.
  - **Live edits** (`Programs::configure` diffs the old cfg against the new): `interval_ms` → `retime_remaining`
    (timer); under `on_end` a new minimum or a new `transition` cancels an armed switch (`program.disarmed`, debug)
    and the next tick re-arms it to the same B (`rearm`; a held one re-checks the new minimum); `on_end → timer`
    cancels the armed switch and starts the countdown in full; `timer → on_end` arms per the rule on the next tick;
    `max_ms` / `separate_scenes` / `scenes_after_ms` are read by the next tick; `items` / `order` →
    `Order::reorder` (the current item kept, or finishing without a replay; history `[current]`; play time and
    countdown kept), and an armed B that is no longer a playable item, or no longer the new order's next (a reorder, an
    undo), is cancelled (the abort restores A's loop) and re-planned; an edit that changes only items' `props` or `skip`
    never re-orders or touches the history, and a `skip` going true → false clears that item's own broken / failed
    mark (a crashed scene whitelisted: the backend is the authority); a shuffled `from: index` shuffles the rest of its
    cycle; `defaults` / item `props` reach the next B only. An edit never resets the play time.
  - **Pause, holds, parking** (Task 5): the clock is `Runtime::now`, so a user pause, the low-VRAM hold and the
    cover hold (Task 6, `cover_hold_freezes_a_program`) stop play time and the countdown — and **no rule starts a
    switch under a hold** (Task 11: `Programs::tick(…, held)`; a timer / maximum / scenes-after rule an edit made true
    meanwhile — a maximum below the time played — waits for the resume, `live_max_edit_while_paused_waits_for_the_resume`).
    `state.programs[].can_prev` says whether `program.prev` would switch (counting a switch on its way), so the backend's
    `previous` at the first item leaves a user pause alone. Parked (no output, R60) the program's phase is `parked` and it follows
    `while_parked` (O2, a Program prop, live): `rotate` (default — today's backend) keeps both clocks counting,
    timer/max/scenes-after switches go through `transition_parked` (each replaces the parked wallpaper and commits at
    once; no sooner than `PARKED_MIN_PLAY_MS` = 1 s after the last commit, so an image at minimum 0 can't switch
    every tick), an end-of-video switch waits for an output (a parked A never ends); `hold` stops both clocks and
    the rules until an output returns. An output added mid-switch is adopted by the recipe as usual.
  - **`keep`** (a Program prop, Bool, default false, settable + kept in `program.json`; `state.programs[].keep`; owner
    2026-11-10 "keybind toggle to infinite loop current wallpaper" — the backend's `liascape loop-current`): while true
    no rotation rule fires (timer, end, maximum, scenes-after, still-image minimum — `tick` step 7 is skipped), the timer's
    countdown stands, and a video item's `loop` is kept on (a short clip would otherwise end and stand). Set true while
    an end switch is armed → it is cancelled (`program.disarmed {why: keep}`, A loops on). User verbs still switch and
    the keep holds the new item; a broken item / failed B still moves on. Set false → the item starts over for the
    rules: `played_ms` 0 and the countdown a full interval (a long keep never trips the maximum the instant it ends).
    Tests: `tests/program.rs::keep_holds_the_current_item_and_loops_it` / `keep_stops_the_timer_and_resets_it_when_lifted`.
  - **Persistence** (`recipes/program/store.rs`, designer call 4): `<state>/program.json` = `{version: 1, rev,
    programs: [{id, props (settable, as `get` returns them), order: {items, idx, shuffle}}]}`, written on
    `lia-snapshot` (`Writer::send_file`, before the snapshot queued with it) only when a definition changed
    (create/set/destroy, a play, a cycle's reshuffle — `Programs::def_dirty`; at startup too, and always on a clean
    exit) — never by the 2 s refresh. The snapshot's `programs: [ProgramSnap {id, rev, index, history,
    history_index, current_path, played_ms, remaining_ms, last_effect, failures, broken}]` (additive, `VERSION` 1)
    carries the dynamic half; while a program plays (player not paused) the snapshot refreshes every 2 s like a
    video. `--restore`: after the snapshot's sources, each `program.json` program is created again and
    `Programs::restore` gives it its order and — when its first output (or the parked slot) shows its saved
    `current_path` — its cursor, history and clocks (`program.restored {reanchored}`); a `rev` that differs from
    `program.json`'s (a crash between the two writes) re-anchors the cursor on `current_path` (history `[current]`);
    anything else leaves it `idle` (`program.restore_mismatch`). Its first tick arms per the rule (an `on_end`
    video re-arms `align: end` — the snapshot saved an armed switch as A where it plays). The supervisor's 4th
    restart in a minute (no `--restore`) comes back without programs. `stop` (and `quit`, after its final
    write) destroys every program (`stop_all`).
  - **Playlist start** (Task 5b, O4, plan § Playlist start; `recipes/program/resume.rs`): Program props `key`
    (Str, `name:<saved name>` | `bar`, "" = none) and `start_mode` (`start_over` default | `resume`, live — read at
    the next start only, never jumps the current play). `program.play {id, from?: start|resume|index, index?,
    keep_pause?}` (no `from` = `index` with an index, else `start`) applies `resume::plan_start`: `start` →
    sequential: the first playable item; shuffle: a fresh permutation whose first ≠ the last item played; `index` →
    that item at 0 (an explicit play-from beats the setting); `resume` → the key's resume point exactly (order,
    cursor, history, `position` = its `time_pos`, play time, countdown — `program.current {resumed: true}`; the
    countdown is re-timed to the interval it plays under now: a point keeps `countdown_ms`, the timer interval its
    `remaining_ms` counted down from (none under `on_end`), and `resume::resumed_remaining` applies
    `retime_remaining` (elapsed kept, used up → a full interval; no countdown ran → a full interval — TODO F6:
    the raw value switched at once after a playlist saved under on_end / a short timer, `tests/program.rs::
    resume_retimes_a_countdown_saved_under_other_settings`), a point
    whose items changed re-anchored by the reorder rule (its item at its time if still there, else the item after
    its old place at 0), none → as `start`; `resume` while the same key's playlist plays → `{corr: null, resumed:
    true}`, nothing switched (a pause stays — the backend lifts it, I1). Resume points: `<state>/resume.json`
    (≤ 50 keys, least recently put dropped; written on `lia-snapshot` when changed), put whatever the mode when a
    keyed program is destroyed, `stop`ped, replaced (its `key` changes — the adapter sets `key` before `items`) and
    on `quit`; loaded at every start. **`serve --restore --session-start`** (boot / `liascape restore`; the
    supervisor gives it to its first child only, never to a restart): a `start_over` program's saved item is taken
    off the snapshot before the restore (never created) and the program starts per `plan_start(start)` with a cut;
    a `resume` one restores exactly and logs `program.current {resumed: true}`. A crash restart or upgrade restores
    exactly whatever the mode.
  - Tests: `tests/program.rs` (27 stepped/real-clock API tests: timer/speed/1-item/on-end/min-hold/max/0-off/scenes
    after/separate off/images/commit at effect start/cut at A's end/effect pick/failures/all unplayable/skip/broken/
    VRAM/pause/every switch combo; Task 4's 18: the history contract through the verbs, prev at the start, next while
    armed / during an effect, the `next` storm, the keep_pause cut, 1-item next/random, every live edit, item edits)
    + `recipes::program` unit tests.
