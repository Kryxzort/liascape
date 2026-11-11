# Graph and properties

Covers `src/player/src/graph/` (`mod.rs`, `props.rs`): the player's single source of truth. Rules:
`.claude/rules/player/core.md` § Graph and properties. The schema itself (every prop, type, default, range) is
`props.rs`; read it there.

## Nodes and ids

Every output, layer, source, effect and program is a `Node` with typed props. Outputs are `out:<connector>`,
given explicitly; creating one also creates `lay:<connector>:main` with empty `content`. Other nodes auto-id as
`src<n>`/`lay<n>`/`fx<n>`/`prog<n>` (independent counters) or take the caller's id. The `player` node exists from
`Graph::new()`. Node ids may contain `:` but never `.`: a `PropPath` splits at the first `.`, so
`src7.gain.xfade` is node `src7`, prop `gain.xfade`.

## Aliases (`Graph::resolve`)

- `out:*`, `lay:*:main` — every output / main layer, sorted by id.
- `cur:<c>` / `cur:*` — the source an output's main layer shows: the source itself, an effect's `to` side
  mid-transition, nothing when `content` is unset or dangling.
- `srcs:<c>` / `srcs:*` — every source whose picture is on that output (any layer, directly or as either effect
  side) plus every source an in-flight transition on it holds (pending B, held A's); `snapshot` sources and the
  recipe's graves excluded. The transition half is pushed by the runtime after every start/cancel/tick
  (`Graph::set_transition_sources`), and a parked wallpaper stays in it (`Graph::set_parked`). Global settings go
  here because `cur:` misses an in-flight transition's pending B, which would then take over with the old value.
- Anything else is a concrete id.

A broadcast alias that matches nothing is still type-checked and succeeds with no targets; an unknown connector or
concrete id is `no_such_node`.

## Change tracking

- `drain_changes()` returns every `set` since the last call, one entry per resolved node, in order; the runtime
  forwards them through `SourceHost`. Creation is never a change (there is no live source yet to forward it to).
- `set_observed`/`set_observed_on` write what a live source reports (`ready`, `duration`, `time_pos`, size,
  `paused`, `kind`, `loading`, …), bypass `read_only` and never enter `drain_changes`.
- `set_animated` (the Animator's per-tick writes) and `gain.<slot>` sets don't move `picture_rev`; every other
  mutation that can change a picture does. The redraw policy compares it per output.
- `demand_rev` moves only on routing changes (what shows what, sizes, `scene_fps`); scene demand and the
  `redraw::Routes` cache are rebuilt only when it moves.

## Snapshot shape (`state.graph`)

One object keyed by node id; each node has `kind` plus every schema prop, defaults included. A source's `kind` prop
(`video`, `image`, `color`, `snapshot`, `scene`) overwrites the node kind there, so recognise sources by their extra
fields: `gain` (only the set slots, dB) and `gain_effective_db` (their sum, clamped to [−96, 12]).

## Player-level pause

`player.paused` is a writable bool the player owns (restored from the snapshot, never re-asserted by the backend).
It must not be written into each source's `paused`: the recipe holds sources paused on purpose (pending B, reveal
and frozen A's), and a resume would un-pause them. Instead:

- `SourceHost` applies `node.paused || player.paused || holds` to every source it hosts; the node keeps what a
  `set` or the recipe put there, so a recipe-held source comes back held after the resume. The holds are the cover
  hold and the low-VRAM hold (`Runtime::held`).
- The `paused` mirror (a source's real state echoed into the graph) is suspended while the player is paused, so the
  OR'd value never corrupts the node.
- `Runtime::now` excises paused time, so the Animator and the recipe freeze without knowing about the pause. In
  stepped mode the virtual-time advance is gated the same way.
- The `sources` probe shows `effective_paused` beside the node's raw `paused`; it is deliberately not a graph prop.
