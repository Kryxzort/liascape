<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Graph & properties

`src/graph/mod.rs` + `src/graph/props.rs` (spec §4.2 "Blocks", §4.3 "Recipes", §9 "`state`
query"): the player's single source of truth. Every output, layer, source and effect is a
`Node` with typed properties (`graph::PropValue`); `Graph::snapshot()` is the `state`
query's payload, `Graph::create`/`destroy`/`set`/`get` are what Task 12's command API
calls into.

**Id scheme.** Outputs are `out:<connector>` (e.g. `out:DP-1`), given explicitly — there's
no sensible auto-id for a connector name. Creating an output **also creates**
`lay:<connector>:main`, a `Layer` with `output` set and `content` left at its default-unset
`""`; destroying the output destroys that layer too. Everything else auto-ids as `src<n>` /
`lay<n>` / `fx<n>` (independent counters starting at 1) when no id is given, or uses the
caller's id verbatim otherwise. The `Player` singleton (id `player`) exists from
`Graph::new()` and is never created or destroyed through `create`/`destroy`.

**Path splitting.** A `PropPath` (`crate::anim::PropPath`) is `"<node id>.<prop name>"`,
split at the **first** `.` — node ids never contain `.` (though they may contain `:`), so
`"src7.gain.xfade"` splits to node `src7`, prop `gain.xfade`. `gain.<slot>` is the one
dynamic property name: valid only on `Source` nodes, `<slot>` parsed via
`units::GainSlot::from_str`; every other name goes through the static per-`NodeKind`
schema in `props.rs` (`schema_for`/`schema_for_kind`).

**Aliases**, resolved by `Graph::resolve` and transparently by `set`/`get`:
- `out:*` — every output, sorted by id.
- `lay:*:main` — every main layer, sorted by id.
- `cur:<connector>` / `cur:*` — the source currently shown by that output's (or every
  output's, deduplicated) main layer: if `content` is a `Source`, that id; if `content` is
  an `Effect`, its `to` (the incoming side, mid-transition); if `content` is unset or
  dangling, no entry.
- `srcs:<connector>` / `srcs:*` (Task 12, R50) — every `Source` whose picture is on that
  output (any layer with `output` = it, or its main layer, showing it directly or as either
  side of an effect) **or** that an in-flight transition on it holds (pending B, held
  A's) — `kind: snapshot` nodes and the recipe's graves excluded. The transition half is
  pushed by the runtime (`Graph::set_transition_sources(by_output, graves)`, from
  `Transitions::held_sources()`) after every `start`/`cancel`/`tick`. **This is where
  global settings go** (§ Command API).
- anything else is tried as a concrete node id.

`set` on a multi-resolution path (e.g. `out:*.paused`) applies to **every** resolved node —
validated across all of them before any is mutated, so a failing alias expansion changes
nothing. `get` on one that resolves to more than one node is `ambiguous`: there's no single
value to return.

**Error codes** (`ApiError { code, message, hint }`, `Serialize` + `Display` +
`std::error::Error`): `no_such_node`, `no_such_prop`, `bad_type`, `out_of_range`,
`read_only`, `ambiguous`, `unsupported`, `io` (the last reserved for a future task's
persistence/socket I/O; nothing in `graph/` produces it yet). `hint` always names either
this doc section or the `liascape-player ctl state`/`ctl ...` command to inspect. Order of checks
on a `set`: `no_such_prop` (including `gain.*` on a non-`Source`, or an unparseable slot)
beats `read_only` beats `bad_type`/`out_of_range` — a caller never learns their value's
shape is wrong on a property they weren't allowed to touch in the first place.

**`set_json(path, &Value)`** (Task 12) is `set` from a raw wire value: each resolved node's
value is typed through its own schema (`gain.<slot>` → dB number), same check order
(`no_such_prop` > `read_only` > `bad_type`/`out_of_range`) and all-or-nothing rule; it
returns the node ids it applied to (the API's `set` → `{targets}`).

**`drain_changes()`** returns every `(PropPath, PropValue)` applied by `set` since the last
call, in call order (one entry per resolved node for a multi-resolution `set`). Node
creation is **never** a change — there's no live source yet for a runtime hook to forward
it to. The runtime (a later task) drains this every tick and forwards each entry to
whatever `PropHook` the target source has registered; nothing in `graph/` talks to a live
source directly.

**`picture_rev()` (Task 13)** counts mutations that can change a picture: `create`,
`destroy`, and every `set` except `gain.<slot>`; never `set_observed`. The Wayland redraw
policy compares it with the revision an output last presented (§ Wayland).

**Player props (Phase 2).** `scene_assets` / `scene_assets_resolved` (Task 7);
`scene_throttle` (bool, default true — the GPU budget), `scene_vram_limit_mib` (MiB, 0 = off —
the per-scene VRAM guard), `vram_low_mode` (`stop`|`pause`|`off`, default `stop` — the low-VRAM
rule), observed `vram_low_active` (Task 8; § Scene worker → "GPU budget and VRAM (Task 8)").
**Phase 3:** `pause_when_covered` (`off`|`fullscreen`|`maximized`, default `off` — the backend asserts the
user's setting, default `maximized`; live; kept by the snapshot) and observed `cover_hold_active` (§ Signals).

**Output props.** `name`/`width`/`height`/`refresh_hz` (read-only; kept current with
`set_observed` on a mode change), `layer` = `background|bottom|top|overlay` (live, §
Wayland), `paused`, `pointer` (read-only `[x, y, buttons]`, observed — § Wayland),
`scene_fps` (Phase 2 Task 5: the frame rate scenes shown here render at — WE's `fps`: 0–480, default
**15** (WE's own, 2026-11-06; was 30), **not capped by the refresh** (the scene ticks at it, the output
presents at most at its refresh), 0 = the refresh; live — § Scene worker → "The `scene` Source kind"). Observed `covered`
(`none|maximized|fullscreen|unavailable`) and `covered_by` (`{app_id, pid}` / `{}`) — the covered
Signal (Phase 3 Task 6, § Signals).

**Observed values and node accessors (Task 11).** `Graph::set_observed(path, v)` writes
what a live source *reports* (`SourceHost` mirrors `ready`/`duration`/`time_pos`/`width`/
`height`/`paused`): same resolution and type checks as `set`, but it bypasses `read_only`
and is **never** recorded in `drain_changes` — an observation must not be forwarded back to
the source as a command. `kind_of(id)`, `ids_of(kind)`, `props_of(id)` (every prop + set
`gain.<slot>`s, what a source is opened from) and `effective_gain_db(id)` are plain reads.
`Source.kind` also allows `snapshot`, with read-only `of` (seeded at create), and (Phase 2
Task 5) `scene` — plus `Source.preview` (Str) and (Task 10) read-only `Source.broken` (Bool:
observed — a scene past its restart budget —, seeded at create by a snapshot restore). `outputs_of(id)` is the inverse of
`srcs:<c>` (a scene's demand). § Scene worker → "The `scene` Source kind".

**Snapshot shape.** `Graph::snapshot()` is one JSON object keyed by node id; each node's
object has `kind` plus **every** schema property (defaults included — a property is never
omitted for being unset, so "every node with every property" holds without special-casing).
`Source` nodes additionally get `gain` (an object of only the gain slots that have been
set, in dB — unset slots don't appear) and `gain_effective_db` (their dB sum via
`units::Gains::effective_db`, clamped to `[-96, 12]`).

**Player node `paused` (Task 16b, R75) — player-level pause.** A second, writable bool
prop (default `false`) alongside `debug`, persisted in the snapshot's `player` object the
same generic way (`snapshot::persistent`, no special-casing needed). "Features must
compose" + "audio follows the picture" (project rules): pausing while a transition is
in flight must not desync the two sides — the recipe un-pausing B when its effect starts
is untouched (R41/the recipe's own holds still work exactly as before), so the pause
can't just be `node.paused` on every source, or a resume would un-pause a source the
*recipe* is deliberately holding.

- **Effective pause.** `SourceHost` applies `node.paused || player.paused` to every
  video/image (and colour/snapshot, harmlessly) source it hosts (`sources/host.rs`
  `sync`/`open`) — never the node's raw value. The node's own `paused` is **never**
  touched by this: it stays exactly what a `set`/the recipe put there, so a recipe-held
  source (reveal/frozen) comes back held after a resume purely because its own
  `node.paused` is still `true` (the recipe's own logic, completely unaware of
  `player.paused`) — and so `release`/`is_still`'s own reads of `paused` (and every other
  recipe decision keyed on it) are never corrupted by the override. The one place that
  *would* corrupt it — `SourceHost::update`'s `paused` mirror (a hosted source's real,
  OR'd state echoed back into the graph) — is suspended while `player_paused`; it
  resumes the instant it's unpaused, so a genuine mpv-initiated flip (the pre-existing,
  rare reason the mirror exists at all) is never missed outside the override window.
- **Frozen time.** `Runtime::now()` excises every interval spent `player.paused` — the
  same pause/resume algebra as `clock::OutputClock` (not reused directly: this is one
  global pause, not a per-output clock needing its own `Rc<dyn Clock>`), inlined as two
  fields (`paused_at`, `pause_offset`) on `Runtime`. The Animator and `Transitions::tick`
  only ever see this `now`, so a transition's progress, gain ramps, `align:end` waits and
  handoff timers all stop and resume exactly where they were — the recipe itself needs no
  awareness of `player.paused` at all. `update_player_paused()` (one graph read, a no-op
  if unchanged) runs at the top of `tick`/`begin_step`, *before* `now` is read for
  `run_anims` — a pause applied this tick/step freezes it too, not one tick later — and
  again (idempotently) in `sync_sources`, which runs after every dispatch that brought a
  change (`after_dispatch` → `sync_due`, not only a timer/`step` — F6b) so a plain `set
  player.paused` reaches the sources at once, between ticks.
- **Stepped mode.** mpv itself stays paused for good regardless (§ Sources "Stepped
  mode"), so `mpv_pause` can't show the override there; instead `Runtime::begin_step`'s
  virtual-media-time advance is gated on `!player_paused` too (alongside the existing
  per-node `!paused`) — `lt.t` (and so the seek target) doesn't move, and `step_seek` (§
  Runtime "Stepped mode", "skipped when the target is unchanged") naturally no-ops.
- **Observability.** `get`/`state` show `player.paused` directly (an ordinary prop); the
  `sources` probe adds `effective_paused` (`node.paused || player.paused`, read from the
  graph, independent of the live source) alongside the unchanged, node-raw `paused` —
  deliberately a probe-only field, not a second graph property, so nothing with
  `srcs:*.paused` semantics ever needs to know effective pause exists.
