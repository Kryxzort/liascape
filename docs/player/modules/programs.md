# Programs (player-side rotation)

Covers `src/player/src/recipes/program/` (`mod.rs` engine, `rule.rs`, `order.rs`, `pick.rs`, `store.rs`,
`resume.rs`). Rules: `.claude/rules/player/runtime-api.md` § Programs. The contract it reproduces is the C#
rotation in `.claude/rules/backend/player-adapter.md`; each pure Rust function names the C# it ports
(`item_rule` = `ItemPlayRule`, `retime_remaining` = `UpdateTimedSettings`, `Order::reorder` = `ReorderPlaylist`,
`pick` = `PickEffect` + `PickDuration`).

A program is a graph node `prog:<name>` whose settings are live props; the recipe turns them into `transition`
requests on the player clock. `create`/`set` → `Programs::configure`; `destroy` stops the rotation and leaves the
picture (an armed pre-Running switch is cancelled). Randomness is seeded from the node's `seed` (SplitMix64) and
its state is in the snapshot, so a restarted player's shuffles continue instead of replaying.

## The engine (`Programs::tick`)

Runs right after `Transitions::tick` on both clocks; its actions go through `Transitions::start` (or
`transition_parked`). Transition events reach it on the next tick, which is why the `transition`/`cancel` verbs
and output removal stash the outbox instead of dropping it.

- **Clocks.** Play time and countdown advance with `Runtime::now`, so a user pause, the low-VRAM hold and the
  cover hold stop them and a wall-clock jump never shows. Play time is wall rate; the timer countdown is scaled by
  the current source's `speed`. No rule starts a switch under a hold; a rule an edit made true meanwhile waits for
  the resume.
- **Commit** at the program's own `transition.started` (B becomes current, play time 0 from that instant); a
  `handoff` commits a step whose `started` was missed. A step is planned, never pre-fetched. Another client's
  `cancelled` drops the pending step; another client's switch makes the program request nothing until it settles,
  then either an item's path is current (reason `items`) or the program goes `idle`.
- **Timer** (`mode: timer`, `interval_ms > 0`): countdown at 0 → `align: now`, mid-video. A 1-item program only
  restarts its countdown.
- **On end** (`mode: on_end`, `interval_ms` = the minimum): max reached → `align: now`. A still or scene past its
  minimum → `align: now` (the `scenes_after_ms` rule with separate scene timing). A video, once its effect handed
  off: minimum reachable within the current loop → `align: end` (`program.armed`), else held with `loop` on and
  re-checked every tick, so the request goes in during the loop that reaches the minimum. Arming waits for the
  current effect's handoff (a request during a Running effect would commit it early) and never happens while
  parked (a parked A never ends).
- **B's props:** `defaults` ∪ the item's `props` (item wins) + `path`, plus `loop: true` under `on_end` with a
  minimum so a short clip loops until the reaching loop.
- **Breaks:** an `Error` from the current item → the next playable item at once (`align: now`), reason `vram`
  for a VRAM stop (not marked), else `broken` (marked and passed over).
- **Failures never spin:** `transition.failed` or a refused request → `program.failed {backoff_ms}` on the ladder
  `BACKOFF_MS` (1, 2, 4, 8, 16, 30 s; a handoff resets it), the path marked failed until the items change, then the
  next playable item. Nothing playable → `program.empty` once. When every playable item has failed the marks are
  cleared and retried at the ladder's pace (≤ 6 requests a minute).
- **User verbs** (`program.next|prev|random|play`) are always `align: now` with the program's effect pick (a cut
  with `keep_pause` while paused; the rotation clock stays frozen) and supersede an armed switch. `next` while
  armed takes the armed B; a verb while the program's own `now` request hasn't started goes on from that step
  (`Order::plan_after`: ten `next`s in a burst land ten items on); during a Running effect the recipe commits B
  and `next` goes past it. `prev` at the session's first item → `{corr: null}`; `state.programs[].can_prev` tells
  the backend beforehand, so its "previous" leaves a user pause alone.
- **Live edits** diff the old configuration against the new: `interval_ms` retimes the countdown; under `on_end` a
  new minimum or `transition` cancels an armed switch and re-arms it to the same B next tick; `on_end → timer`
  starts a full countdown; `items`/`order` reorder keeping the current item (history `[current]`, clocks kept) and
  cancel an armed B that is no longer next. An edit to only items' `props`/`skip` never reorders, and `skip`
  going false clears that item's broken/failed mark (the backend is the authority). An edit never resets play time.
- **Parked** (no output): phase `parked`, behaviour per `while_parked`: `rotate` keeps both clocks and switches
  through `transition_parked` (no sooner than `PARKED_MIN_PLAY_MS` after the last commit, so a 0-minimum image
  can't switch every tick; end-of-video switches wait for an output); `hold` stops clocks and rules.
- **`keep`:** no rotation rule fires, the countdown stands, a video item keeps `loop` on, an armed end switch is
  cancelled (`program.disarmed {why: keep}`). User verbs still switch and the keep holds the new item; a broken
  item or failed B still moves on. Lifting it resets play time and gives a full countdown, so a long keep never
  trips the maximum the instant it ends.

## Persistence

- `<state>/program.json` = each program's settable props and order, written on `lia-snapshot` only when a
  definition changed (`Programs::def_dirty`), at startup and on a clean exit — never by the 2 s refresh. Its `rev`
  pairs it with the snapshot's dynamic half (`ProgramSnap`: cursor, history, current path, clocks, last effect,
  failures, broken).
- `--restore` re-creates each program, then gives it its cursor and clocks when its first output (or the parked
  slot) shows its saved `current_path` (`program.restored`). A `rev` mismatch (a crash between the two writes)
  re-anchors the cursor on `current_path`; anything else leaves it `idle` (`program.restore_mismatch`). Its first
  tick re-arms per the rule (the snapshot saved an armed end switch as A where it plays). The supervisor's
  no-restore restart comes back without programs.

## Playlist start and resume points

Program props `key` (`name:<saved name>` | `bar` | "") and `start_mode` (`start_over` | `resume`, read at the next
start only). `program.play {from?: start|resume|index}` applies `resume::plan_start`: `start` → sequential: the
first playable item; shuffle: a fresh permutation whose first ≠ the last played. `index` → that item at 0.
`resume` → the key's resume point exactly (order, cursor, history, `position`, play time), with the countdown
re-timed by `resume::resumed_remaining` to the interval it plays under now (used up → a full interval); a point
whose items changed re-anchors by the reorder rule; none → as `start`. `resume` of the playlist already playing
switches nothing (`{corr: null, resumed: true}`) and leaves a pause for the backend to lift.

Resume points live in `<state>/resume.json` (≤ 50 keys, least recently put dropped), put whatever the mode when a
keyed program is destroyed, stopped, re-keyed (the adapter sets `key` before `items`) and on `quit`.
`serve --restore --session-start` (boot, `liascape restore`; first supervised child only) removes a `start_over`
program's saved item from the snapshot before the restore and starts it per `plan_start(start)` with a cut; a
`resume` program restores exactly. A crash restart or upgrade restores exactly whatever the mode.
