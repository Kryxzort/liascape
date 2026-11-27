---
paths:
  - "src/player/**"
---

# liascape-player crate: cross-cutting rules

The core invariant: never hand an audible or visible stream from one owner to another — only ramp gains and
opacities on streams that keep running. The numbered invariants live in `docs/player/invariants.md`; read the one
you touch before changing a recipe, a source or the runtime.

## Where things are
- Area rules load by path: `.claude/rules/player/gfx-wayland.md` (EGL, effects, composition, Wayland, redraw),
  `.claude/rules/player/sources.md` (mpv sources, `SourceHost`, render worker, onset), `.claude/rules/player/audio-bus.md`
  (the bus, RT threads, meter), `.claude/rules/player/runtime-api.md` (loop, outputs, signals, command API),
  `.claude/rules/player/recipes.md` (transition recipe, programs), `.claude/rules/player/persistence.md` (snapshot,
  outbox, supervisor, memory), `.claude/rules/player/scenes.md` (scene worker and source; LWE core:
  `.claude/rules/player/scene-lwe.md`; sound and loudness: `.claude/rules/player/scene-audio.md`; GPU and VRAM:
  `.claude/rules/player/scene-gpu.md`). Rotation semantics (C# side): `.claude/rules/backend/player-adapter.md`.
- How each module works, with measurements that still hold: `docs/player/modules/<name>.md`; design and the block
  model: `docs/player/architecture.md`.

## Build and test
- Run the suite as `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo test -q`: the shell's stray
  `LD_LIBRARY_PATH` breaks native links; never "fix" a link or EGL problem by setting it or
  `__EGL_VENDOR_LIBRARY_DIRS`.
- Keep `src/player/src/lib.rs` to `pub mod` lines only (plus the one `#[cfg(test)] mod test_tmp;`); put logic in the module.
- `src/player/build.rs` generates mpv C enums as module consts, never Rust `enum`s — a value a newer libmpv adds
  must not become UB. Keep the allowlist `mpv_.*` / `MPV_.*`.
- Never `fork` the serve process: spawn children with `posix_spawn` (std `Command` without `pre_exec`/uid/gid, or by
  hand like `WorkerHost::spawn`) and get a death signal another way (`setpriv --pdeathsig`, or the child sets it).
  Copying the address space makes the bus and mpv's AOs miss graph cycles. The supervisor's `pre_exec` and the offline
  `scene-loudness` CLI's run outside serve.

## Event log (`src/player/src/log.rs`)
- Log through `log::init` / `log::event` / `log::recent` / `log::new_corr` / `log::set_tap`; a test calls `log::init`
  once in its binary's setup. A second `init` returns `Err(AlreadyExists)` — never make it panic; `event`/`recent` are
  no-ops before `init`.
- Give every event of one operation (a transition, a source load, a worker restart) one corr id from
  `log::new_corr(prefix)`.
- Pass `fields` as a JSON object; never name a field after a fixed key (`comp`, `level`, `kind`, `corr`,
  `t_mono_ms`, `t_wall`) — it silently overwrites it (use `source_kind`).
- `t_mono_ms` is the process monotonic clock (`log::mono_start`); transition `at_ms`/`start_ms` are the
  pause-excised player clock (`Runtime::now`). Never compare the two directly.
- Keep `Level`'s order its severity order (`Error` < `Trace` via `Ord`) when adding a level.
- A `Tap::send` runs on whichever thread logged, after the logger's lock is released: it must only queue. The tap
  gets events below the file's level threshold on purpose (a subscriber asks by kind).
- After a failed rotation disk logging stays suspended until restart (`writer` is `None`) — never write through the
  old handle.

## Units (`src/player/src/units.rs`)
- Keep gains in dB inside the player; convert only at the edge with that edge's curve: mpv via `volume-gain`
  (`units::mpv_volume_gain`) with `volume` fixed at 100, PulseAudio via `units::pulse_volume_from_db`. mpv's
  `volume` and Pulse volumes are cubic — never ramp them.
- Clamp to `units::SILENT_DB` (−96) for silence; `Gains::effective_db` sums `GainSlot`s and clamps.
- Crossfade with `units::equal_power`. `xfade`, `anticlick` and `pause` slots are transient: never save them in the
  snapshot.

## Clocks and animation (`clock.rs`, `anim.rs`)
- Keep clocks on the loop thread (`Cell`-based, not `Send`). `OutputClock` excises paused time, never jumps it.
- `AnimUnit::GainLinear` animates linear amplitude and emits dB (`lin_to_db`): a 0→1 ramp emits `SILENT_DB` at its
  start. An animation emits nothing before its `start`; it emits its exact final value once and reports it in `finished()`.
- `Animator::add` on a path that already animates removes the old animation outright (and its undrained
  completion) — never reintroduce "shadowing", where the older one resurfaces after the newer finishes.
- When saving a property to restore later, record `Animator::live_target_of` (where a LIVE ramp ends), never the
  instantaneous value (a restore would land mid-ramp) and never `target_of` (a finished animation's target is stale
  once something `set` the prop). Guard: `restore_uses_live_target_not_a_stale_finished_one`.
- `compress_to` rescales a live animation in place (same id, value continuous); never use it to lengthen one or on
  another corr's animation.
- The runtime drops animations on gone nodes (`retain_targets`); a never-started placeholder would otherwise live
  forever.

## Graph and properties (`src/player/src/graph/`)
- The graph is the single source of truth; only `SourceHost` turns nodes into live sources — nothing in `graph/`
  talks to a source.
- Node ids never contain `.`; a `PropPath` splits at the first `.` (`src7.gain.xfade`). `gain.<slot>` is the only
  dynamic prop and only on `Source` nodes; every other prop goes through the schema in `graph/props.rs`.
- Creating `out:<c>` also creates `lay:<c>:main`; destroying it destroys the layer. Never create or destroy the
  `player` node through `create`/`destroy`.
- Put global settings on `srcs:*` (every source shown or held by an in-flight transition, snapshot sources and
  graves excluded); the runtime refreshes the transition half with `Graph::set_transition_sources`.
- A multi-node `set` validates every resolved node before mutating any; a `get` resolving to several is `ambiguous`.
- Keep the error check order `no_such_prop` > `read_only` > `bad_type`/`out_of_range` in `set`, `set_json` and
  `props::validate_value` — a caller never learns a value's shape on a prop it may not touch.
- Write what a live source reports with `set_observed` / `set_observed_on` only: it bypasses `read_only` and is never
  in `drain_changes` — an observation must never be forwarded back to the source as a command. Node creation is never
  a change in `drain_changes` either.
- Animator ticks write through `Graph::set_animated`, which does not move `picture_rev`; `gain.<slot>` sets don't
  either. Anything else that can change a picture must move `picture_rev` (the redraw policy depends on it).
- `Graph::snapshot()` lists every schema prop for every node, defaults included; never omit an unset prop.
- Player pause: never write `player.paused` into each source's `paused`. `SourceHost` applies `node.paused ||
  player.paused`; the node's own `paused` stays what a `set` or the recipe put there, so a recipe-held source comes
  back held on resume. The `paused` mirror in `SourceHost::update` is suspended while the player is paused.
- `Runtime::now` excises player-paused time (except a still-frame switch's, `runtime-api.md` § Runtime loop) and
  `Runtime::rotation_now` all of it; call `update_player_paused` before `now` is read in `tick`/`begin_step`, and
  again in `sync_sources`, so a pause freezes the same tick. In stepped mode gate the media's virtual-time advance
  on `player_paused`, never on `now` (mpv stays paused there).
- `effective_paused` is a `sources` probe field only — never add it as a graph prop.
