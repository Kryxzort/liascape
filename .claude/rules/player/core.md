---
paths:
  - "src/player/**"
---

# liascape-player crate: cross-cutting rules

The core invariant: never hand an audible or visible stream from one owner to another — only ramp gains and
opacities on streams that keep running. The numbered invariants live in `docs/player/invariants.md`; read the one
you touch before changing a recipe, a source or the runtime.

## Where things are
- `.claude/rules/player/gfx-wayland.md` — EGL, `Gfx`, capture, the Wayland backend, redraw policy, GPU tests.
- `.claude/rules/player/sources-audio.md` — mpv sources, `SourceHost`, render worker, reaper, the audio bus.
- `.claude/rules/player/runtime-api.md` — the runtime loop, command API, probes, signals.
- `.claude/rules/player/scenes.md` — scene worker, scene sources, GPU budget, loudness.
- Rotation and reconnection semantics (C# side): `.claude/rules/backend/player-adapter.md`.
- How each module works, with measurements that still hold: `docs/player/modules/<name>.md` (snapshot, outbox and
  supervisor: `docs/player/modules/persistence.md`; memory: `docs/player/modules/runtime.md`).
- Design and the block model: `docs/player/architecture.md`.

## Build and test
- Run the suite as `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo test -q`: the shell's stray
  `LD_LIBRARY_PATH` breaks native links; never "fix" a link or EGL problem by setting it or
  `__EGL_VENDOR_LIBRARY_DIRS`.
- Keep `src/player/src/lib.rs` to `pub mod` lines only; put logic in the module.
- `src/player/build.rs` generates mpv C enums as module consts, never Rust `enum`s — a value a newer libmpv adds
  must not become UB. Keep the allowlist `mpv_.*` / `MPV_.*`.

## Event log (`src/player/src/log.rs`)
- Log through `log::init` / `log::event` / `log::recent` / `log::new_corr` / `log::set_tap` only; `Logger` is
  `pub(crate)` for `log.rs`'s own tests. A test elsewhere calls `log::init` once in its binary's setup.
- `log::init` succeeds once per process; a second call returns `Err(AlreadyExists)` — never make it panic.
  `event`/`recent` are no-ops before `init`, so callers need no guard.
- Give every event of one operation (a transition, a source load, a worker restart) one corr id from
  `log::new_corr(prefix)` (`"<prefix>-<n>"`, one global counter).
- Pass `fields` as a JSON object; never name a field after a fixed key (`comp`, `level`, `kind`, `corr`,
  `t_mono_ms`, `t_wall`) — it silently overwrites it.
- `t_mono_ms` is the process monotonic clock (`log::mono_start`); transition `at_ms`/`start_ms` are the
  pause-excised player clock (`Runtime::now`). Never compare the two directly.
- `Level` order is severity order (`Error` < `Trace` via `Ord`); keep it so when adding a level.
- A `Tap::send` runs on whichever thread logged and after the logger's lock is released: it must only queue. The tap
  gets events below the file's level threshold on purpose (a subscriber asks by kind).
- Disk failures are counted (`write_failures`) and printed once per streak; after a failed rotation disk logging
  stays suspended until restart (`writer` is `None`) — never write through the old handle.
- The supervisor appends with `log::append_detached` (one `O_APPEND` write, never rotates, its own clock).

## Units (`src/player/src/units.rs`)
- Keep gains in dB inside the player; convert only at the edge with that edge's curve: mpv via `volume-gain`
  (`units::mpv_volume_gain`) with `volume` fixed at 100, PulseAudio via `units::pulse_volume_from_db`. mpv's
  `volume` and Pulse volumes are cubic — never ramp them.
- Clamp to `units::SILENT_DB` (−96) for silence; `Gains::effective_db` sums `GainSlot`s and clamps.
- Crossfade with `units::equal_power`. `xfade`, `anticlick` and `pause` slots are transient: never save them in the
  snapshot.

## Clocks and animation (`clock.rs`, `anim.rs`)
- Clocks are `Cell`-based and not `Send`/`Sync`; keep them on the loop thread. `OutputClock` excises paused time,
  never jumps it.
- `AnimUnit::GainLinear` animates linear amplitude and emits dB (`lin_to_db`): a 0→1 ramp emits `SILENT_DB` at its
  start.
- An animation emits nothing before its `start`; it emits its exact final value once and reports it in `finished()`.
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
  in `drain_changes` — an observation must never be forwarded back to the source as a command.
- Node creation is never a change in `drain_changes`.
- Animator ticks write through `Graph::set_animated`, which does not move `picture_rev`; `gain.<slot>` sets don't
  either. Anything else that can change a picture must move `picture_rev` (the redraw policy depends on it).
- `Graph::snapshot()` lists every schema prop for every node, defaults included; never omit an unset prop.
- Player pause: never write `player.paused` into each source's `paused`. `SourceHost` applies `node.paused ||
  player.paused`; the node's own `paused` stays what a `set` or the recipe put there, so a recipe-held source comes
  back held on resume. The `paused` mirror in `SourceHost::update` is suspended while the player is paused.
- `Runtime::now` excises player-paused time; call `update_player_paused` before `now` is read in `tick`/
  `begin_step`, and again in `sync_sources`, so a pause freezes the same tick. In stepped mode gate the virtual-time
  advance on it too (mpv stays paused there).
- `effective_paused` is a `sources` probe field only — never add it as a graph prop.

## Effects (`src/player/src/gfx/effects.rs`)
- Never edit anything under `transitions/` for this crate: the assets are shared with the UI. Adapt at load time
  (`rewrite_header`, the `//<<BODY>>` splice in `Catalogue::program`); a driver needing a GLSL prelude gets it there.
- `rewrite_header` must fail loud when `#version 300 es` is missing from either wrapper or the precision line is
  missing from `wrap.frag.template` — the asset changed shape.
- An unknown uniform `type` in the manifest fails at `Catalogue::load`, not at draw time.
- A failed effect compile is cached (`Catalogue::failed`), logged once, and drawn as a cut at progress 0.5 — never
  re-compiled per frame, never a transparent frame. Guard `src/player/tests/compose.rs`
  `uncompilable_effect_draws_a_cut_not_black`.
- `EffectProgram::draw` draws into whatever FBO/viewport is bound and restores no state; the caller owns the target.
- When no catalogue resolves (the `nix build` sandbox has no `transitions/`), tests skip through
  `tests/common::catalogue_dir`; the runtime still serves cuts (`Catalogue::empty`).

## Composition (`src/player/src/gfx/compose.rs`)
- Keep `compose_output` stateless with respect to frames: a missing texture draws transparent. Holding the last
  good frame is the source's job.
- Flip exactly once: `flip_v = true` only on the plain-`Source` → target blit; `false` for `render_side`'s inputs
  (the effect wrapper flips them) and for the effect result → target. A second flip turns every transition upside
  down. Guard `src/player/tests/compose.rs` `effect_progress_endpoints_match_plain_source` (a Y-uniform test can't
  catch it).
- Coordinates are GL bottom-left for placement; never flip placement.
- Draw premultiplied (`rgb * opacity`, `a * opacity`) with `GL_ONE, GL_ONE_MINUS_SRC_ALPHA` onto transparent black.
- Apply layer opacity in the separate result → target pass; the effect shader has no opacity input.
- Keep `fit_rect` exact `f64`; round to whole pixels only at the `gl.viewport` call.
- The `textures` closure takes an explicit lifetime (`Option<&'t Tex>`) tied to the registry; the elided form can't
  be satisfied by a registry-backed closure.
- `Composer::last_missing` reports holes in a visible layer (the seam probe); a recipe must never show a source
  before it is `Ready`. Guards `src/player/tests/compose.rs` `last_missing_names_every_hole_in_a_visible_layer`,
  `src/player/tests/api.rs` `switches_never_compose_a_hole`.

## Memory (`src/player/src/mem.rs`)
- `mem::apply_policy` is the first line of `runtime::serve`, before any mpv core exists: fixed
  `M_MMAP_THRESHOLD` (`mem::MMAP_THRESHOLD`) so freed mpv frame pools don't stay in glibc arenas. A caller's own
  `MALLOC_MMAP_THRESHOLD_` / `GLIBC_TUNABLES` value wins; `LIASCAPE_PLAYER_MALLOC=glibc` skips the policy (A/B).
- `malloc_trim(0)` runs on the `lia-mpv-reaper` thread after each batch (`mem::trim_after_reap`), never on the loop
  and never once `reaper::shutdown` started.
- Don't add an arena cap (`M_ARENA_MAX`): no gain, more lock contention.
- Diagnose RSS growth with the `memory` probe: live bytes flat + `free_bytes` growing = retention, live growing =
  a leak. Guard `src/player/tests/api.rs` `t20b_switch_loop_rss_stays_flat`.

## Outbox (`src/player/src/outbox.rs`)
- Append a fact the backend must store even when not listening with `outbox::with_seq(kind, &mut fields)` at the
  point it is logged; it adds `outbox_seq` to the live event. Without `outbox::install` (harnesses) it is a no-op.
- Every backend handler of an outbox kind must be idempotent: a fact can arrive live and again from the drain.
- `seq` stays monotonic across restarts and is written first in each line so reads skip without parsing; a failed
  append uses no seq.
- Never `fsync` an append; compaction runs on `lia-snapshot` and never `fsync`s under the outbox lock (the loop may
  append meanwhile).
- The file is bounded (`OUTBOX_MAX` unacked); a read past dropped entries reports `dropped_before`.
- Guards: unit tests in `outbox.rs`; `src/player/tests/api.rs` `outbox_persists_across_restart_and_acks`,
  `outbox_is_bounded`, `live_events_carry_outbox_seq`.

## Snapshot (`src/player/src/snapshot.rs`)
- The player is the one authority for `player.paused`; it is restored from the snapshot and the backend never
  re-asserts it.
- Never save effects, `snapshot`-kind sources, graves, held A's or any transition scaffolding. Save an in-flight
  transition as its target B — except an `align: end` one before Running, saved as A. Guard unit
  `aligned_pending_transition_is_saved_as_a`.
- Save an animating value at `Animator::live_target_of` while live, else the value itself.
- Queue the final snapshot on `quit`/SIGTERM/`loop.failed` before `stop_all` empties the graph, then freeze.
- Write via temp + `fsync` + rename + dir `fsync` on `lia-snapshot` only; never on the loop. A switch's reply never
  waits for it — the adapter reconciles after a restart (`.claude/rules/backend/player-adapter.md`).
- `--restore` never crash-loops on a bad file: corrupt/unknown version/dangling ref → `snapshot.invalid`, file moved
  aside, start empty. Restore the exact saved position (no elapsed-time compensation).
- A restored playing video starts at `gain.anticlick` −96 with a not-yet-started ramp (corr `restore-fade`)
  re-added at `source.ready` — invariant #8. Restored ids are fresh; never assume saved ids survive.
- `Writer::runner()` queues other jobs (outbox compaction) on the same thread; `finish` sends an explicit `Stop`.
- Test knob `LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS` slows every write deterministically.

## Supervisor (`src/player/src/supervise.rs`)
- `serve` without `--no-supervise` fork+execs `/proc/self/exe serve --supervised …` before any thread, GL context or
  PipeWire connection exists; the supervisor never binds the socket, takes the lock or touches EGL/PipeWire.
  `--session-start` goes to the first child only.
- The child sets `PR_SET_PDEATHSIG(SIGTERM)` then re-checks `getppid()`. Guard
  `src/player/tests/supervise.rs` `supervisor_sigkill_reaps_child_fast`.
- Keep the two startup failures apart: `ServeError::Startup` (exit 1: lock held, bad socket/state dir) is never
  retried; `ServeError::NoCompositor` (`EXIT_NO_COMPOSITOR`) retries with doubling backoff up to
  `COMPOSITOR_WAIT_BUDGET`, never against the crash budget. Guard `gives_up_without_compositor_after_backoff`.
- Exit 0/1/2 end supervision; a signal, panic (101), `EXIT_RUNTIME` or any other code restarts at once with
  `--restore`. 5 restarts per 60 s, the 6th gives up (`EXIT_GAVE_UP`); from the 4th restart in the window start
  without `--restore`.
- The restarted child logs `supervisor.restart` first and repeats it in `hello.restart` — a reconnecting client
  can't see events from before it subscribed.
- SIGTERM/SIGINT are forwarded; after `STOP_WAIT` the child is SIGKILLed. During the no-compositor backoff a signal
  exits at once (`sleep_unless_stopped`). Guard `sigterm_during_compositor_backoff_exits_at_once`.
- `make_sent_faults_fatal` (first thing in `serve`) re-raises a sent SIGSEGV/SIGBUS; Rust's handler alone survives a
  `kill -SEGV`.
- Tests set `RLIMIT_CORE` 1 on every spawned process (0 still runs systemd-coredump and pops crash dialogs);
  `src/player/tests/api.rs` runs `--no-supervise`. Knobs: `LIASCAPE_PLAYER_TEST_CRASH=startup`,
  `LIASCAPE_PLAYER_TEST_COMPOSITOR_WAIT_MS`.
- Never `fork` the serve process (see `.claude/rules/player/sources-audio.md` § Audio bus); the supervisor's
  `pre_exec` is the one allowed in it.
