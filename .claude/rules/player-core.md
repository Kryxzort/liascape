---
paths:
  - "src/player/**"
---

## lp-player (the "utopia player")

`lp-player` is the Rust crate (binary + lib, edition 2024) that will replace mpvpaper +
`lp-transition` + per-monitor LWE + `lp-audio` with one process that owns every wallpaper
type, on every monitor, with every transition. Design: `docs/superpowers/specs/2026-10-20-utopia-player-design.md`.
This file covers only what exists in the crate so far; later tasks append their own
sections below as they add modules (clock, graph, gfx, mpv, sources, recipes, api,
wl, headless, audio, probe, supervise, runtime — see the design's §file map).

**The core invariant (everything else follows from this):** never hand an audible or
visible stream from one owner to another — only ramp gains/opacities on streams that keep
running. A stream that will be heard starts silent and ramps up; a stream is only
destroyed after being ramped to silence. If this holds, dropouts and visual seams can't
happen regardless of timing.

## Module map

- `src/main.rs` — CLI entry point: `--version`, `serve` (§ Runtime; without `--headless`
  = real Wayland outputs, § Wayland; supervised unless `--no-supervise`, § Supervisor),
  `ctl` (§ Command API); any other invocation prints usage and exits 2.
- `src/lib.rs` — module wiring only (`pub mod …;` lines). Add new
  `pub mod` lines here as later tasks add files; don't put logic in this file.
- `src/log.rs` — the event log (below).
- `src/units.rs` — audio units (below).
- `src/mpv/` — libmpv FFI (`ffi.rs`, bindgen output) + safe wrapper (`mod.rs`). § Sources.
- `src/sources/` — the `Source` trait, `MpvSource` (video/image), `ColorSource`,
  `SnapshotSource`, and `SourceHost` (graph nodes ↔ live sources). § Sources.
- `src/recipes/` — programs built only from the blocks; `transition.rs` (Task 11).
  § Transition recipe.
- `src/runtime.rs` — the running player: one calloop loop, ticks, stepped mode,
  hotplug, stop/quit. § Runtime.
- `src/headless.rs` — the `OutputBackend` trait + `Headless` virtual outputs. § Runtime.
- `src/wl.rs` — the Wayland backend: one wlr-layer-shell surface per `wl_output`
  (Task 13). § Wayland.
- `src/redraw.rs` — the redraw policy of frame-paced (Wayland) outputs. § Wayland.
- `src/api/` — `proto.rs` (wire shapes), `server.rs` (socket, clients, event tap),
  `handlers.rs` (the verbs). `src/ctl.rs` — the shell client. `src/paths.rs` — socket
  and state paths. § Command API.
- `src/probe/` — the probe registry (`mod.rs`: `list`, `sources`, `loop`; `frames.rs`:
  `frames`, Task 13; `audio.rs`: `bus`, `meter.window`, Task 14; Task 15 adds more;
  `memory.rs`: `memory`, Task 20b).
  § Command API.
- `src/audio/` — the player audio bus (`bus.rs`) + bus meter (`meter.rs`), `Audio` (what
  `serve` runs, `mod.rs`). § Audio bus.
- `src/supervise.rs` — the supervisor (`serve` without `--no-supervise`): spawns, waits
  for and restarts the compositor child (Task 16). § Supervisor.
- `src/snapshot.rs` — the persisted state snapshot (`<state>/snapshot.json`, `--restore`)
  + its writer thread (Task 16). § Snapshot.
- `src/mem.rs` — process memory (`/proc/self/status`, glibc `mallinfo2`/`malloc_info`)
  and the allocator policy `serve` applies first thing (Task 20b). § Memory.
- `src/onset.rs` — invariant #8's one onset helper (`PendingOnset`/`Onsets`: ramp-ins held
  until the source's audio flows, bounded by `ONSET_TIMEOUT`) and the one "can it be heard"
  predicate (`has_audio`, `audible`). § Runtime "Onsets" (final review I6/M12).

**`build.rs`** (Task 10) runs bindgen over `mpv/client.h` + `mpv/render.h` +
`mpv/render_gl.h`, found through pkg-config `mpv` (≥ client API 2.0; this machine has
mpv 0.41 / API 2.5), allowlisting `mpv_.*` functions/types and `MPV_.*` vars. C enums are
generated as **module consts** (`mpv_event_id::MPV_EVENT_FILE_LOADED`), never Rust
`enum`s — a value a newer libmpv adds can't become UB. pkg-config also emits the
`-lmpv` + `-L` that nixpkgs auto-rpaths (same mechanism as `khronos-egl`'s `static`
feature, § GFX / EGL). The flake's `lp-player` derivation already carries
`rustPlatform.bindgenHook` (libclang) + `pkg-config` + `mpv-unwrapped`, and the devShell
inherits them, so neither needed a change.

## Event log

JSON Lines, one object per event, schema:

```json
{"t_mono_ms": 123.4, "t_wall": "2026-10-20T12:00:00.000Z", "comp": "mpv", "level": "info", "kind": "source.load", "corr": "tr-12", "...fields": "merged at top level"}
```

- `t_mono_ms` — `f64` milliseconds since the logger's init (`log::mono_start()`, the first
  thing `serve` does — effectively process start), from `Instant` (a true monotonic clock,
  never wall time) — monotonic across every event in a process, even across rotation. The
  supervisor's own lines (`log::append_detached`) use the supervisor's clock. Not to be
  confused with the transition events' `at_ms`/`start_ms`, which are on the
  **pause-excised player clock** (`Runtime::now`, invariant #7).
- `t_wall` — RFC3339 wall time (`time::OffsetDateTime::now_utc()` +
  `format_description::well_known::Rfc3339`).
- `comp` — the emitting component (`&'static str`, e.g. `"mpv"`, `"graph"`).
- `level` — `Level` (`Error|Warn|Info|Debug|Trace`), serialized **lowercase**
  (`"error"`…`"trace"`). Declaration order is severity order: `Error` is most severe,
  `Trace` least — `Level` derives `Ord` from that, and both the logger's own threshold
  (set in `init`) and `LogFilter::min_level` compare against it directly (`event_level <=
  threshold` → keep).
- `kind` — a dotted event name (e.g. `"source.load"`, `"transition.start"`).
Freeform below `kind` by convention, not enforced.
- `corr` — `CorrId` (newtype `String`, serializes as a bare JSON string) or `null`. One
  correlation id ties together every event of one operation (a transition, a source load,
  a worker restart). Mint one with `log::new_corr(prefix)` → `"<prefix>-<n>"` (e.g.
  `new_corr("tr")` → `"tr-12"`); the counter is global across all prefixes, not per-prefix.
- `fields` (the `serde_json::Value` passed to `event`/`log::event`) — **must** serialize to
  a JSON object; its keys are merged at the top level alongside the fixed keys above. A
  field that collides with a fixed key (`comp`, `level`, …) silently overwrites it — pick
  field names that don't.

**Call it via the global, not `Logger` directly.** `log::init(dir, level)` sets up the
process-global logger (creates/appends `events.jsonl` in `dir`); `log::event(...)` and
`log::recent(...)` read/write it. `init` may only succeed once per process — a second call
returns `Err` (`io::ErrorKind::AlreadyExists`), never panics, so a second subsystem racing
to initialize logging can't take the process down. `event`/`recent` are no-ops (silently
drop / return `vec![]`) before `init` has run, so early callers don't need to guard every
call site. All of this is behind one `Mutex`, safe to call from any thread (the render loop
and the socket server both will).

**Rotation.** `events.jsonl` rotates when the *next* line would push it past
`DEFAULT_ROTATE_BYTES` (20 MiB = `20 * 1024 * 1024`, checked anticipatorily — the
check happens before the write, not after): `events.jsonl` → `events.1.jsonl` →
`events.2.jsonl` (oldest dropped), so at most 3 files ever exist. The threshold is
injectable (`Logger::init_with_limit`, crate-private) purely so tests can rotate in
milliseconds instead of writing a real 20 MiB — production code only ever goes through
`log::init`, which always uses `DEFAULT_ROTATE_BYTES`.

**`recent(filter, limit)`** — the in-memory side of the log: the last 10 000 events (a
ring buffer, oldest dropped first) filtered by `LogFilter { comp, corr, min_level,
kind_prefix }` (every `Some`/non-default field must match; `kind_prefix` is a
`str::starts_with` match on `kind`), returning up to `limit` matches **oldest-first**
within the most recent window — i.e. if more than `limit` events match, you get the
*newest* `limit` of them, but still in chronological order. This ring is independent of
what has or hasn't been rotated to disk — it survives rotation (rotation only touches the
files) and does not survive a process restart (nothing on disk is structured for random
access; re-reading history from `events*.jsonl` is a future task's problem, not `recent`'s).

**Disk I/O failures are never silent.** A write/flush failure (disk full, permissions) and
a rotation failure are both counted in `write_failures` (surfaced via `log::write_failures()`
/ `Logger::write_failures`) and diagnosed with one `eprintln!` — on the *first* failure of a
burst, not once per event, with a matching "recovered" line when writes start succeeding
again — so a sustained failure doesn't spam stderr. The event itself still lands in the
in-memory ring either way; `recent()` is unaffected by disk trouble. A **rotation** failure
is handled more conservatively than a plain write/flush failure: `rotate` detaches
`state.writer` (sets it to `None`) and resets `current_size` to `0` *before* attempting to
reopen the fresh `events.jsonl`, so if that reopen fails (e.g. a transient EMFILE/ENOSPC/
permission blip right after the renames already succeeded), the old handle — which by then
refers to whatever got renamed to `events.1.jsonl` — is never written through again. Disk
logging stays suspended (every event after that is diagnosed/counted, never silently
dropped, never appended into the wrong file) until the process restarts; `write_line`
checks `writer.is_none()` up front so it doesn't retry rotation or touch a stale handle on
every subsequent event.

**Tap (Task 12).** `log::set_tap(Some(Arc<dyn Tap>))` installs one process-wide consumer of
every event — the command API's `subscribe`. `Tap::wants(level, kind)` is asked first
(cheap prefix check); only then is the record built, **even below the logger's level
threshold** (a subscriber asks for kinds; the file keeps its level — e.g. `source.position`
is `debug`), and `Tap::send(&record)` gets it *after* the logger's lock is released. The
record is exactly what the log stores (`kind`, `corr`, `t_mono_ms`, …); the API renames
`kind` → `event` on the wire. `send` must only queue: it runs on whatever thread logged.
`Logger::record(…, for_tap)` is the shared builder (`Logger::event` is now test-only).

**Gotcha:** `init`/`event`/`recent`/`new_corr`/`write_failures`/`set_tap` are the only public API — `Logger` and
`Logger::init_with_limit` are `pub(crate)`, used only by `log.rs`'s own tests so each test
gets an independent instance instead of fighting over the one process-global `OnceLock`.
Don't reach for `Logger` from outside `log.rs`; if you need a log in a test elsewhere in
the crate, that's a sign `log::init` should be called once from that test binary's setup,
not that `Logger` should become more public.

## Units

`src/units.rs` (spec §5.3): **gains are dB everywhere inside the player; convert only at
the edge, with that edge's own curve.** mpv's `volume` and PulseAudio stream volumes are
cubic (measured `volume=50` → −18.07 dB), so the player drives mpv via `volume-gain`
(exact dB) and keeps `volume` at 100 — see `units::mpv_volume_gain` /
`units::pulse_volume_from_db`. `units::SILENT_DB` (−96) is the one floor everything
clamps to; `units::Gains` sums `GainSlot`s (`user`/`override`/`normalize`/`mute`/
`automute`/`xfade`/`anticlick`/`pause`, lowercase in `gain.<slot>` paths and JSON) in dB.
`pause` is the player-pause gate's own slot (final review I2, § Runtime) — like `xfade`/
`anticlick` it is transient and never saved in the snapshot.
Crossfades use `units::equal_power` (cos/sin). See `docs/player/invariants.md` #2–#4.

## Clocks and Animation

`src/clock.rs` (spec §4.2 "Clock"): `Clock::now() -> Duration`. `MonoClock` wraps
`Instant`; `SteppedClock` only advances on `step(&self, d)` (tests); `OutputClock::new(base:
Rc<dyn Clock>)` adds `pause`/`resume` per output — paused time is excised, never just
unfrozen-and-jumped. All three are `Cell`-based, single-threaded, not `Send`/`Sync`.

`src/anim.rs` (spec §4.2 "Animator", §4.3 recipes): `Animator::tick(now)` moves every
`Animation` (`target: PropPath`, `from`/`to`, `start`/`duration`, `curve: Curve`, `unit:
AnimUnit`, `corr`) along `value = from + (to-from)*curve.eval(progress)`. Curves: `Linear`,
`Smoothstep` (`x²(3-2x)`), `EqualPowerOut`/`EqualPowerIn` (reuse `units::equal_power`'s
cos/sin), `Step`. `eval` always clamps `x` to `[0,1]` first.

- **`AnimUnit::GainLinear`** means `from`/`to` are **linear** amplitudes; the value `tick`/
  `value_at` actually emit is `lin_to_db` of the curve output — so a `GainLinear` anim from
  `0`→`1` emits `SILENT_DB` at its own `start`, not mid-ramp.
- **Nothing before `start`.** `tick` emits nothing for an animation whose `start` hasn't
  arrived yet; `value_at(path, t)` returns `None` only when no animation on `path` has
  started by `t`, otherwise the value that animation would emit at `t` (held at its final
  value once finished, until cancelled or superseded).
- **One final value, exactly once.** The tick where `now >= start + duration` emits the
  exact final value, reports `(AnimId, corr)` via `finished()`, and never emits that
  animation again.
- **`target_of(path)`** (Task 11 fix round, R41) — the value the animation on `path` *ends*
  at (dB for `GainLinear`), started or not, finished or not; `None` when nothing animates
  it. Recipes record this — not the instantaneous value — when they save a property to
  restore later, so a restore never lands mid-ramp.
- **`has_live_gain(now, horizon)`** (R90; M1 of the final review): a not-finished `gain.*`
  animation that has started or starts within `horizon` — the fast gain timer's arm condition
  (the caller passes one main tick period). `len()`/`retain_targets(keep)` (the runtime drops
  animations on nodes that are gone — a never-started placeholder would otherwise stay forever).
- **`compress_to(path, corr, now, end)`** (the `align: end` compression, § Transition recipe →
  Align): the live animation `corr` added on `path` finishes at `end` instead of later — the rest
  of its progress is rescaled in time (new `duration` = (end − now)/(1 − x₀), `start` moved back
  so x(now) = x₀): value continuous, same curve. In place (same id); a not-started one keeps its
  start (≤ `end`); never a finished one, never later, never another corr's.
- **`add()` supersedes, permanently.** `Animator` holds at most one live animation per
  `PropPath` — `add()`ing a second animation on a target **removes** the earlier one
  outright (same as `cancel()`; retracting its completion from the `finished()` queue too,
  if it was already sitting there undrained). There is no "shadowed" animation left to
  hand control back to once the newer one finishes, so `tick` and `value_at` can never
  disagree about which animation is live on a target. (A prior design let the newer one
  merely *shadow* the older per-tick, which let the older one resurface once the newer
  finished — a reviewed-and-rejected bug, not the intended behaviour.)

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
this doc section or the `lp-player ctl state`/`ctl ...` command to inspect. Order of checks
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

**Output props.** `name`/`width`/`height`/`refresh_hz` (read-only; kept current with
`set_observed` on a mode change), `layer` = `background|bottom|top|overlay` (live, §
Wayland), `paused`, `pointer` (read-only `[x, y, buttons]`, observed — § Wayland).

**Observed values and node accessors (Task 11).** `Graph::set_observed(path, v)` writes
what a live source *reports* (`SourceHost` mirrors `ready`/`duration`/`time_pos`/`width`/
`height`/`paused`): same resolution and type checks as `set`, but it bypasses `read_only`
and is **never** recorded in `drain_changes` — an observation must not be forwarded back to
the source as a command. `kind_of(id)`, `ids_of(kind)`, `props_of(id)` (every prop + set
`gain.<slot>`s, what a source is opened from) and `effective_gain_db(id)` are plain reads.
`Source.kind` also allows `snapshot`, with read-only `of` (seeded at create).

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
  again (idempotently) in `sync_sources`, which runs after *every* dispatch
  (`after_dispatch`, not only a timer/`step`) so a plain `set player.paused` reaches the
  sources at once, between ticks.
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

## GFX / EGL

`src/gfx/egl.rs` + `src/gfx/gl.rs` (spec §5.1 "Graphics"): desktop OpenGL (core profile)
via EGL — chosen so the compositor can host LWE core if ever needed, since LWE core
renders with desktop GL loaded through glad (`docs/player/spikes/lwe-core.md` §2). `Gfx`
owns the EGL display + context and the `glow::Context` loaded through it; `Gfx::new_offscreen`
builds a surfaceless one (used by every GPU test today), `Gfx::new_wayland` +
`Gfx::window_target` build a real one on a `wl_surface` (first exercised by Task 13's
Wayland backend — two latent bugs found then, see § Wayland → NVIDIA/EGL notes).
`Gfx::make_current_surfaceless` and `WindowTarget::set_swap_interval` (Task 13) are the
window path's two extra knobs.

**`Gfx` and `WindowTarget` share EGL teardown via `Rc<Shared>`, not a borrow.** `Shared`
(private, `egl.rs`) holds the EGL instance + `Display` + `Context` and is the one thing
whose `Drop` actually tears EGL down (`eglMakeCurrent(none)` → `eglDestroyContext` →
`eglTerminate`). `Gfx::window_target` clones `self.shared` into the `WindowTarget` it
returns, rather than handing back a `&'a Gfx`-tied borrow — a borrow would force a
self-referential struct the moment the runtime stores one `Gfx` and its live
`WindowTarget` side by side per output, which is exactly how it's used. This means
`Shared::drop` runs exactly once, whenever the *last* clone goes away, regardless of
whether the `Gfx` or the `WindowTarget` is dropped first. **Reviewed finding this
replaced:** an earlier version put `display`/`context` directly on `Gfx` with its own
eager `Drop`, while `WindowTarget` kept only a *copy* of the `Display` value and a
separately-`Rc`'d EGL instance — nothing kept the owning `Gfx` alive, so dropping it
first `eglTerminate`d the display while a `WindowTarget` about to call
`eglDestroySurface` on it was still around: undefined behaviour. `gfx::GlKeepAlive` (`Gfx::keep_alive()`, Task 10) is a
third holder of the same `Rc<Shared>`, for sources that must free GL objects in `Drop`
(§ Sources).

**One `EGLDisplay` per process, refcounted terminate.** Every surfaceless `Gfx` gets the
*same* `EGLDisplay` (`EGL_DEFAULT_DISPLAY` on one platform) and `eglInitialize` isn't
reference-counted (EGL 1.5), so `Shared::drop` keeps a process-wide per-display user count
(`display_acquire`/`display_release`) and calls `eglTerminate` only for the last user; it
also only unbinds the context if *its own* context is the current one. Found in Task 10's
fix round: the old unconditional terminate destroyed every other `Gfx`'s non-current
context and made later `eglMakeCurrent` fail with `EGL_NOT_INITIALIZED` — invisible until
a source first switched contexts with a second `Gfx` alive (and a latent race between
parallel GPU tests). Pinned by `tests/gfx_basic.rs::two_gfx_on_one_display_survive_each_others_drop`. `make_current`/`swap`
still take `gfx: &Gfx` (API shape unchanged) and read `gfx.shared.{egl,context}` — a
`WindowTarget` created from a *different* `Gfx` would mismatch display/context and EGL
itself rejects that, same as before.

**Display-selection order** (`Gfx::new_offscreen`, mirrors `spikes/lwe-core/host.cpp`'s
`egl_init`, proven on this machine's NVIDIA 595.84):

1. `EGL_PLATFORM_SURFACELESS_MESA` (`EGL_DEFAULT_DISPLAY` native handle) — present on this
   driver through glvnd, and the one that actually works here.
2. Else `EGL_EXT_platform_device`: enumerate devices via `eglQueryDevicesEXT`, skip a
   device exposing only `EGL_MESA_device_software` unless it's the last one, try each
   until `eglGetPlatformDisplayEXT` + `eglInitialize` both succeed.

Both steps go through **`eglGetPlatformDisplayEXT`, fetched by name via
`eglGetProcAddress`, not `khronos-egl`'s core `get_platform_display`.** Measured on this
machine (glvnd 1.7.0 + NVIDIA 595.84): the *core* EGL 1.5 entry point returns
`EGL_BAD_PARAMETER` for the Mesa-defined `EGL_PLATFORM_SURFACELESS_MESA` token even though
that token is listed in the client extension string — glvnd's core dispatch only
recognizes a fixed set of KHR-registered platforms. The `EXT`-suffixed entry point (what
`EGL_EXT_platform_base`/`EGL_MESA_platform_surfaceless` actually define, and what
`host.cpp`'s spike uses) doesn't have this restriction. `Gfx::new_wayland` uses the same
`EXT` call for consistency, not because it needs to.

**Surfaceless requires `EGL_KHR_surfaceless_context`** on the chosen display (present on
NVIDIA) — checked explicitly before `eglMakeCurrent(…, EGL_NO_SURFACE, EGL_NO_SURFACE,
…)`, so a driver missing it reports exactly that by name instead of an opaque
`eglMakeCurrent` failure downstream.

**`khronos-egl`: `static` feature, not `dynamic` (deviation from the original call).**
`dynamic` (`dlopen("libEGL.so.1")` at runtime) was tried first, as the brief asked. It
failed under the documented build/test command (`env -u LD_LIBRARY_PATH nix develop -c
cargo test …`): a bare-name `dlopen` only searches a binary's RPATH/RUNPATH, `LD_LIBRARY_
PATH`, and the system cache, and nixpkgs' auto-rpath mechanism only rpaths a `-L` directory
that an actual link invocation used — an ambient `NIX_LDFLAGS` entry from a `buildInputs`
dev-shell package (`libGL`/libglvnd) never reaches the link line on its own. `static`
instead runs `khronos-egl`'s `build.rs`, which calls the `pkg-config` crate's
`probe("egl")` — the same mechanism `wayland-egl`/`wayland-sys` already use in this
dependency tree — which *does* emit real `cargo:rustc-link-lib=EGL` +
`cargo:rustc-link-search`, which *does* get auto-rpath'd. Net effect: `cargo test --test
gfx_basic` under the exact documented command needs no extra environment variables, on
this machine or (verified) inside `nix build .#lp-player`'s sandboxed check phase.

**No build-time linking means no runtime graceful-failure path for "library missing"** —
with `static`, a system lacking `libEGL` entirely fails at the dynamic linker before
`main` runs, not as a `Result::Err` `Gfx::new_offscreen` could report. Every failure
*after* that point (no vendor ICD, no GPU, `eglInitialize` failing) is still a clean `Err`,
never a panic — this is the condition `tests/common::headless_gl` turns into a printed
`"SKIP: no EGL device"` plus a `return`, and it's what keeps a sandboxed `nix build`'s
check phase from failing over a missing `/dev/dri`.

**Texture defaults** (`Gfx::tex`): `GL_RGBA8`, `LINEAR` min/mag filtering, `CLAMP_TO_EDGE`
wrap on both axes — fixed, no per-call knobs. `Gfx::fbo` wraps a `Tex` at
`GL_COLOR_ATTACHMENT0` and panics on an incomplete attachment (a programming error, not a
recoverable runtime condition). `Gfx::empty_vao` is created once per `Gfx` and reused —
core profile requires some VAO bound even for a fullscreen-triangle draw built entirely
from `gl_VertexID` (Task 8's concern; this task only exposes the VAO so Task 8 doesn't
reinvent it).

**`read_rgba` origin: GL bottom-left.** `tests/common::read_rgba(gfx, tex, x, y)` reads
through `glReadPixels`, whose native coordinate system has `(0, 0)` at the texture's
*bottom-left* corner — the same convention `gl_FragCoord` uses. It is **not** flipped.
Every later task reading pixels back for assertions inherits this origin.

**`write_png_source(tex, path)`** (Task 12) is the same readback *without* the flip, for a
raw source texture (image top already at row 0, R25) — `capture` of a source is upright
too. **`Catalogue::empty()`** (Task 12): no effects (no `transitions/` resolved) — the
runtime still serves cuts.

**`write_png` orientation: top-down, flipped from GL's own order.** `Gfx::write_png` reads
the whole texture (bottom-left origin, same as `read_rgba`) and flips rows before encoding,
so row 0 of the PNG file is the *top* of the image — the standard convention every common
image viewer and format assumes. `read_rgba` and `write_png` therefore disagree about
orientation on purpose: one matches GL, the other matches PNG, and neither re-flips what
the other already flipped.

**Build note: no `LD_LIBRARY_PATH`.** Thanks to `static` linking (above), nothing in
`gfx/` needs `LD_LIBRARY_PATH` or `__EGL_VENDOR_LIBRARY_DIRS` set at build *or* test time —
the plain `env -u LD_LIBRARY_PATH nix develop -c cargo test …` from the global constraints
is sufficient. Don't reach for either env var to "fix" a `gfx` build/test problem; if
`cargo test --test gfx_basic` prints `"SKIP: no EGL device"` on a machine that does have a
GPU, that's a real `Gfx::new_offscreen` failure (check the error string it prints) — not a
missing environment variable.

## Effects

`src/gfx/effects.rs` (spec §5.1 "Graphics": "the gl-transitions GLSL catalogue
(`transitions/`) is reused and adapted to the core-profile wrapper"): the effect
catalogue — `Catalogue` (`resolve_dir`/`load`/`ids`/`program`) and `EffectProgram`
(`draw`) — that compiles the repo's shared `transitions/` assets (122 effects, also used
by the Electron UI's WebGL previews) into desktop-GL 3.3 core programs.

**Never edit anything under `transitions/` for this crate.** Those assets are shared with
the UI; this module's whole job is adapting them at load time (header rewrite, body
splice), never changing them in place. If a future gl-transitions body genuinely fails to
compile under desktop GL 3.3 core, the fix belongs in this module's assembly step (e.g. a
small compatibility prelude), never in `transitions/` itself.

**Directory resolution** (`Catalogue::resolve_dir`), in order:

1. `LP_TRANSITIONS_DIR` env var.
2. `~/.local/share/livepaper-web/transitions` (the Electron UI's installed copy).
3. The repo's own `transitions/`, found by walking up from the current exe's path and,
   failing that, from `CARGO_MANIFEST_DIR` (a build-time constant — this is what makes
   `cargo test` find it even before any exe-relative candidate would resolve).

Each candidate is only accepted if it actually contains a `manifest.json`. Returns `None`
if nothing resolves — true inside `nix build .#lp-player`'s sandboxed check phase, where
`src/player` is built without its sibling `transitions/` directory present (the flake's
`lp-player` derivation sets `src = ./src/player`, nothing wider). Every test in
`tests/effects_all.rs` treats `None` the same way `tests/common::headless_gl` treats no
EGL device: print `"SKIP: ..."` and return, never fail the build over it.

**A failing effect is cached (final review M3).** `Catalogue::program` caches a load/compile
failure (`Catalogue::failed(id)`), logs `effects.compile_failed {id, error}` once and returns the
error at once afterwards; `Composer` then draws the effect as a **cut at the midpoint** (`from`
below progress 0.5, `to` from it) — never the transparent/black frame it used to present while
re-reading and re-compiling the body every frame. `tests/compose.rs::
uncompilable_effect_draws_a_cut_not_black` (a catalogue copy with a broken body).

**Header rewrite + fail-loud rule** (`rewrite_header`, applied to `wrap.vert` and
`wrap.frag.template` in `Catalogue::load`): replace the exact first line `#version 300
es` with `#version 330 core`, then delete a `precision highp float;` line if present.
The version-line check is mandatory for **both** files — its absence means the shared
asset changed shape under this code, and `rewrite_header` returns `Err` naming the file
rather than silently handing back malformed GLSL. The precision-line deletion is
conditional per file: `wrap.frag.template` is required to have one (fails loud if it ever
loses it); `wrap.vert` genuinely never has one (it only emits `gl_Position`/`vUv`), so its
absence there is not an error. Per-effect bodies (`glsl/<id>.glsl`) are spliced into the
rewritten `wrap.frag.template` at its `//<<BODY>>` placeholder, lazily, in
`Catalogue::program` — `Catalogue::load` itself never reads `glsl/`.

**Measured: no compatibility shim needed on this machine (NVIDIA 595.84).** One body
(`glsl/TVStatic.glsl`) declares GLSL ES precision qualifiers (`highp float noise(...)` and
several `highp float` locals) unconditionally rather than guarding them behind `#ifdef
GL_ES` the way most of the catalogue does — on paper a candidate to fail once the version
line is rewritten to desktop GLSL 330 core, which doesn't define those qualifiers by
default. Verified directly (temporarily forcing the qualifiers away with a `#define
highp`/etc. prelude and re-running `all_compile`, then without it): this driver accepts
`lowp`/`mediump`/`highp` as reserved, no-op keywords unconditionally, so all 122 effects
compile with no prelude at all. If a different driver ever needs one, the seam is
`Catalogue::program`'s shader assembly, not `transitions/`.

**Uniform type mapping** (`UniformKind`, resolved once per uniform at `Catalogue::load`
time from the manifest's `type` string — an unrecognised type fails loudly immediately,
not later at draw time): `bool` → `glUniform1i(0/1)`, `int` → `1i`, `ivec2` → `2i`,
`float`/`vec2`/`vec3`/`vec4` → the matching `Nf`. `fromTex`/`toTex` are always bound at
texture units 0/1 respectively, `progress`/`ratio` always set as floats. A param value
from the caller's `serde_json::Map` may be the manifest-shaped array (`default` is always
an array, even for a scalar — e.g. a `bool` default is `[0.0]`/`[1.0]`, never a literal
JSON `true`/`false`) or a bare number/bool, treated as a 1-element array either way; a
name missing from the map (or present but empty) falls back to that uniform's manifest
default. A param name the effect doesn't declare is never looked at (`EffectProgram::draw`
only iterates its own declared uniforms, never the caller's map keys) — "unknown param
names are ignored" falls out of that, with no special-case code. A uniform location the
driver optimised away (`glGetUniformLocation` returned `None` at link time) is skipped
silently, never an error.

**Draw-into-bound-FBO contract** (`EffectProgram::draw`): draws into whatever
framebuffer/viewport is already bound when called — it never binds or queries a
framebuffer, never touches the viewport, and restores no GL state afterwards. It binds
the crate-wide empty VAO (`Gfx::empty_vao`) and issues one `glDrawArrays(TRIANGLES, 0,
3)` — the fullscreen-triangle vertex shader needs no attributes, only `gl_VertexID`. What
it leaves bound for the next caller to either rely on or overwrite: this program
(`glUseProgram`), `from`/`to` at texture units 0/1 (unit 1 left active), and the empty
VAO. The caller (Task 9's layer compositor) owns the target FBO/viewport entirely.

## Composition

`src/gfx/compose.rs` (spec §4.2 "Layer"/"Effect", §4.3 span/mirror recipes): the per-output
frame builder — `Composer::compose_output` draws one output's main layer (`lay:<connector>
:main`) into a caller-owned target `Fbo`, applying `fit`/`viewport`/`opacity`, blending a
two-source `Effect` when `content` points at one. `fit_rect` (a pure free function) and
`UvRect` are unit-tested with no GPU at all; `Composer` is the stateful half (the blit
shader program, plus cached per-size intermediates for effects).

**R19 — no frame memory in this module.** A missing texture (the caller's `textures`
closure returning `None`) always draws as fully transparent — for a plain `Source` layer,
and for either side of an `Effect`. Keeping the last good frame when a source stalls is
the *Source*'s job (Task 10), never this module's: `compose_output` is purely `(graph
state, live textures) -> one composited frame`, called fresh every time.

**R20 — the exact API.** The brief's free `compose_output` function is a method on
`Composer`, which owns the small blit/transform shader (`BlitProgram`, compiled once in
`Composer::new`) and caches the two input intermediates + one result intermediate an
`Effect` layer needs, keyed by `(width, height)` in a `HashMap` — a process drives a
small, effectively-fixed set of output sizes, so entries are created lazily and never
evicted. `fit_rect(src: (u32,u32), dst: (u32,u32), fit: Fit, viewport: [f64;4]) -> UvRect`
stays a pure free function exactly as specified.

**Fit semantics** — all four modes reduce to one per-axis rule (`axis`): given the
viewport-selected *effective* source size on that axis and that axis's scale factor,
either the scaled source overflows the output axis (crop: output axis filled completely,
visible source fraction shrinks and centres) or underflows it (pad: whole source visible,
centred, transparent bars on both sides).

| `fit` | meaning | scale factor(s) fed to `axis` | mpv equivalent |
|---|---|---|---|
| `fill` | covers the output, crops the excess | one shared scale, `max` of the two per-axis ratios | `panscan=1.0` |
| `fit` | contains, letterbox/pillarbox bars | one shared scale, `min` of the two per-axis ratios | `panscan=0.0` |
| `stretch` | ignores aspect, always fills exactly | independent per-axis exact-fit ratio (both axes land in the overflow/exact branch, frac `1.0`) | — |
| `crop` | source pixels 1:1, centred | fixed at `1.0`; each axis decides crop-vs-pad independently | — |

**Viewport / spanning.** `Layer.viewport` (already range-checked by `graph::props` to
`x,y ∈ [0,1]`, `w,h ∈ (0,1]`) selects a normalised sub-rectangle of the *source* before
`fit` ever runs — `fit_rect`'s "effective source size" is `(src_w * viewport.w, src_h *
viewport.h)`, and every returned `uv` is that sub-rectangle's own coordinates re-expressed
in the full texture's `[0,1]` space (`viewport.xy + local * viewport.wh`). Spanning one
source across two outputs is exactly two layers with the same `content`/`fit` and
complementary viewports (`DP-1`: `[0,0,0.5,1]`, `DP-2`: `[0.5,0,0.5,1]`).

**Coordinate conventions — GL bottom-left origin, matching `tests/common::read_rgba`.**
Both halves of `UvRect` (`uv` into the source, `dst` into the output, pixels) use `(0,0)`
as the bottom-left corner. **Placement** (`fit_rect`/`axis`'s math, and `dst`'s effect on
`gl.viewport`) is never flipped — bars/crop/centring land at the same screen position
regardless of which texture is sampled.

**Sampling is a separate concern, and it *is* flipped — but exactly once per source,
on exactly one of this module's three draw sites, never more.** A raw, caller-supplied
source texture is assumed uploaded in standard top-down/PNG row order (buffer row 0 =
image top), which GL's own texel addressing places at `t = 0` — the bottom-left-origin
"bottom." Sampled uncorrected anywhere, a plain `Source` layer would render upside down.
`compose.rs`'s own blit shader (`BLIT_VERT_SRC`/`BLIT_FRAG_SRC`, a from-scratch
fullscreen-triangle shader, not a reuse of `wrap.vert`) carries a `flip_v` uniform that is
`true` for exactly **one** call site and `false` everywhere else:

- **`Composer::compose_output`'s plain-`Source` branch (raw texture → target directly):
  `flip_v = true`.** Nothing else downstream corrects orientation for this draw, so it
  must.
- **`render_side`'s `from`/`to` passes (raw texture → an effect's intermediate):
  `flip_v = false`.** The intermediate is consumed next by
  `effects::EffectProgram::draw`, which *unconditionally* applies
  `transitions/wrap.frag.template`'s own `getFromColor`/`getToColor` flip (untouched —
  this crate never edits `transitions/`) when it samples `fromTex`/`toTex`. Pre-flipping
  here too would compose two flips into the identity (flip∘flip = no correction at all),
  silently reintroducing the upside-down bug for every transition while leaving plain
  `Source` layers correct.
- **The effect's "result" intermediate → target, end of `draw_effect`: `flip_v =
  false`.** `EffectProgram::draw` already applied the one necessary correction (the
  previous point) when it wrote this texture; it's already in finished/screen
  orientation, so a further flip here would un-correct it.

**This exact double-flip shipped once** in this module's first attempt at fixing the
orientation bug (`flip_v = true` on `render_side` too, by the same, wrong "every raw
source needs correcting" reasoning) — caught by review, not by any test running at the
time, because the only Y-asymmetric test then (`y_axis_orientation_matches_image_top`)
only exercises a plain `Source` layer; a Y-uniform-coloured effect test
(`effect_fade_midpoint_through_graph`) can't distinguish a flip from no flip at all.
The actual regression test for this (`tests/compose.rs::
effect_progress_endpoints_match_plain_source`) asserts the property that matters: a
transition at `progress = 0`/`1` must be pixel-identical (every row, Y-asymmetric
sources) to the plain `Source` layer it starts/ends on — for both a full `stretch` and a
`viewport`-restricted case.

**Premultiplied-alpha opacity.** Every draw (`draw_rect`) goes through the blit shader,
which outputs premultiplied colour (`rgb * opacity`, `a * opacity`) and blends with
`glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA)` onto a target already cleared to transparent
black. A fully-opaque red source at `opacity = 0.5` writes `(0.5, 0, 0, 0.5)` — read back
as `rgb ≈ (127, 0, 0)` directly, no separate "composite over black" step needed, because
premultiplied colour already *is* the correct final RGB over a black backdrop. A real
on-screen present (a later task) composites this premultiplied buffer over whatever's
actually behind the output; this module only has to get the premultiplied maths right
once, consistently, for every draw it issues (plain source, each effect input, and the
effect's own blended result).

**Effect compositing.** For `content` pointing at an `Effect` node (`fx*`), `draw_effect`:
renders `from` and `to` each into their own output-sized intermediate under the layer's
*shared* `fit`/`viewport` (`render_side` — both sides of a transition share one on-screen
transform, since the transition happens at one screen position regardless of which side
currently dominates); binds a third ("result") intermediate and calls
`EffectProgram::draw(gfx, &from_tex, &to_tex, progress, ratio = width/height, &params)`
with blending explicitly disabled (a straight overwrite into a just-cleared, fully
transparent target); then blits that result into the real `target` at identity `uv`
(`[0,0,1,1]`, since the result intermediate already *is* the final-output composition
pixel-for-pixel) and the layer's `opacity`. A third intermediate is needed specifically
because `EffectProgram::draw` has no opacity input of its own — it always draws fully
opaque (or whatever alpha the effect shader itself produces) — so opacity has to be
applied in this separate pass afterwards instead of folded into the effect draw.

**A missing effect input is a transparent intermediate, not a literal 1×1 texture.**
R19/R20 describe a missing effect-side input as "a transparent 1×1 texture" — implemented
here as *clearing that side's output-sized intermediate to transparent and simply not
drawing into it*. These are observably identical to anything that only ever samples the
texture (every sample reads `(0,0,0,0)` either way, regardless of the texture's actual
resolution), and this way avoids keeping a real 1×1 `Tex` object around just for the
degenerate case.

**Which `content` kind applies** is decided by trying `graph.get("{content}.effect_id")`:
`Ok` means `content` is an `Effect` (only `Effect` nodes have that property); `Err`
`no_such_prop` means some other node kind — in every case the schema allows for
`Layer.content`, that's a `Source`; `Err` `no_such_node` means `content` is dangling
(destroyed mid-transition — the same situation `graph::Graph`'s own `cur:` alias already
handles), treated the same as an empty `content`: nothing more is drawn, target stays
transparent.

**Lifetime deviation from the brief's literal `textures` signature.** The brief writes
`textures: &dyn Fn(&str) -> Option<&Tex>`, but Rust's elision rule for a bare
`Fn(&str) -> Option<&Tex>` trait bound ties the output reference's lifetime to the
*input* `&str`'s (`for<'a> Fn(&'a str) -> Option<&'a Tex>`) — no closure backed by a
longer-lived registry (`move |id| registry.get(id)`, the only sensible implementation)
can satisfy that, since the trait object would have to hand back a reference valid for
*any* caller-chosen `'a`, up to and including `'static`. Confirmed directly: that exact
closure fails to coerce with "one type is more general than the other" / "requires that
`registry` is borrowed for `'static`". `Composer::compose_output`/`draw_effect` instead
take an explicit lifetime parameter (`textures: &dyn Fn(&str) -> Option<&'t Tex>`), tying
the output to *the registry's* lifetime — what every real implementation actually
provides — while every call site is still spelled exactly `&dyn Fn(&str) -> Option<&Tex>`
(the `'t` is inferred, never written out).

**Round-pixels-only-at-the-GL-call rule.** `fit_rect`/`axis` stay exact `f64` throughout
(so their own unit tests can assert precise fractions, e.g. the `fill_crops` 0.7407 uv
span) — only `draw_rect`/`clear_transparent`/`render_side`, right where they call
`gl.viewport`, round `UvRect::dst` to whole pixels.

## Sources

`src/sources/` + `src/mpv/` (spec §4.2 "Source", §5.1 libmpv gotchas, §5.3 audio): the
frame producers the compositor samples (`Source::texture`) and the audio streams recipes
ramp (`gain.<slot>`). `trait Source { kind, update(&Gfx) -> bool, texture, size, apply,
read, poll_events }`; `SourceEvent::{Ready, Ended, Position(f64), Error{reason},
Rejected{prop, reason}}` — `Error` = the source is broken (load/decode failure, foreign
context, core gone); `Rejected` = one property write was refused and reverted, the source
plays on (R45).

**Contract every source keeps.**
- `update` **never blocks** and returns whether the texture changed. `texture()` keeps
  the last good frame forever (R19's other half — `gfx::compose` has no frame memory):
  a stalled/reloading/ended source shows its last frame, never black.
- `apply(prop, v)` first runs `graph::props::validate_value(Source, …)` — same codes and
  check order as `Graph::set` (`no_such_prop` > `read_only` > `bad_type`/`out_of_range`);
  a string with an interior NUL is `out_of_range` (never stripped — a stripped path would
  name a different file); a live `kind` change is `unsupported` (create a new source).
  Every writable property is live (project rule "settings apply live"), including `path`.
- `read(prop)` serves **cached/observed values only** — never a synchronous mpv call.
  `None` = unset/unknown (an image's `duration`, `time_pos` before playback,
  `width`/`height` before mpv reports a size). An applied value reads back immediately;
  if mpv later rejects it, it reverts (see "Async core calls").
- `update` only ever renders through the context the source was opened on:
  `GlKeepAlive::is_for(gfx)` (`Rc::ptr_eq` on `Shared`) — a different `Gfx` gets no
  render (libmpv through a foreign context is UB, `render.h`) and one `Error` event.
  `update` and `open` both take a `GlKeepAlive::make_current()` guard (a no-op when the
  context already is current), so another `Gfx` being current never misdirects GL calls.
- **Orientation (R25): a source texture holds the image's TOP row at texture row 0**
  (`t = 0`, GL's bottom row) — what `gfx::compose`'s single flip expects. `MpvSource`
  renders with `MPV_RENDER_PARAM_FLIP_Y = 0` into its FBO and that lands exactly so on
  this build (mpv's "normal" render orientation is top-down; FLIP_Y=1 is for a GL
  default framebuffer). Pinned by `tests/sources.rs::source_texture_holds_image_top_at_t0`
  (top-red/bottom-blue clip: low y red, high y blue). Never flip in a source.

**`MpvSource::open(gfx, path, opts)`** — one mpv core + one render context per source. Since
the final review (I5) it is two halves: **`MpvSource::prepare_core(opts)`** — eventfd,
`mpv_create`, the fixed options, `mpv_initialize`, the observers, the wakeup callback; no GL,
no node props; `Send` (`PreparedCore`, dropped unused = callback cleared + core to the reaper)
— and **`MpvSource::open_with_core(gfx, path, opts, core)`** on the loop thread (render
context, every property applied, `start`, `loadfile`). `SourceHost` runs the first half on an
`lp-open` worker thread in the real-clock runtime (§ Sources "`SourceHost`"); `open` = both in a
row (stepped mode, tests, the harness).
Fixed options: `vo=libmpv`, `config=no`, `terminal=no`, `keep-open=yes` (an ended video
holds its last frame) **with `keep-open-pause=no`** (keep-open's default also flips
`pause` at EOF — `read("paused")` would then disagree with the graph and a seek back
after the end would stay frozen), `idle=yes` (the core survives a load error / waits for
a `path` change), `volume=100`, `volume-gain-min=-96`, `image-display-duration=inf` (set
always — it only affects single-frame images), `keepaspect=no` (the texture *is* the
frame; fit is the compositor's), `opengl-pbo=no` (required by the fence stub, below),
`osd-level=0`, `ytdl=no`, `input-default-bindings=no`, `audio-client-name=lp-player`,
**`dither=ordered`** (I5: the default `fruit` dither builds its blue-noise matrix on the CPU in
every new render context's first render — measured ~25–30 ms on the loop per switch; ordered
dithering of the same 8-bit target is visually equivalent), **`gpu-hwdec-interop=no`** (Task 20d:
no hwdec GL interop init on the loop — "Hardware decoding" below), and with opt `shader_cache_dir`
(`serve` passes `<state>/shader-cache`) `gpu-shader-cache=yes` + `gpu-shader-cache-dir`.
**No built-in scripts or bindings (`sources::mpv::SCRIPT_TRIMS`, TODO "mpv's built-in Lua scripts
per core"):** `load-scripts=no`, `osc=no`, `load-stats-overlay=no`, `load-console=no`,
`load-auto-profiles=no`, `load-select=no`, `load-commands=no`, `load-positioning=no`,
`load-context-menu=no`, `input-builtin-bindings=no` (`ytdl=no` above covers `ytdl_hook`). Each
built-in script is a Lua VM on its own thread (`lua/<name>`) serving an OSD, console or menu no one
can open on a wallpaper. Set **best-effort** (`set_optional`): a libmpv that predates a name (older
mpv lacks some `load-*`) still opens — the skipped ones are logged once per process as
`mpv.options_skipped {skipped}` (info). **Measured** (mpv 0.41): a playing 1080p30 core had 28
threads, 6 of them scripts (`commands`, `console`, `context_menu`, `positioning`, `select`, `stats`
— `auto_profiles` stays out at `auto` without conditional profiles, `osc`/`ytdl_hook` were already
off in libmpv) → **22**; one core's create + initialize + destroy (libmpv via ctypes, 40 cores × 3
rounds) **37–47 → 3.7–5.7 ms CPU**, `mpv_terminate_destroy` median 0.8–1.3 → 0.4–0.6 ms; a live
idle core's RSS ~1.3 MiB (3.5 on first touch) → 0.1 MiB; the loop's open share
(`i5_switch_loop_busy` `max_open_ms`) 3.6–7.5 → 0.8–3.9 ms (open_with_core's synchronous
property sets no longer queue behind six script clients registering on the core). The scripts
used no measurable CPU in steady playback (0 ms in 10 s), so this is per-switch only; the switch's
loop busy is still the render context + first render (§ Runtime "Switch cost"). Guards:
`tests/sources.rs::builtin_scripts_are_not_loaded` (every option reads back `no`, no `lua/*`/`js/*`
thread in the test process; RED before: `load-scripts` `yes`, 6 script threads per core), unit
`unknown_trim_option_never_breaks_a_core`.
`opts` = any writable `Source` property (`position` → mpv `start`), plus `ao` (default
`pipewire`), `audio_device` (mpv `audio-device`; `serve` passes the bus, § Audio bus),
`audio_delay_bias` (seconds **added** to every `audio_delay` before it reaches mpv's
`audio-delay`; `serve` passes −`Bus::latency()`; `read("audio_delay")` stays the graph
value), `kind` (`video`|`image`, default from the
extension, then corrected by mpv's `current-tracks/video/image` flag after load).
**Every writable property not in `opts` is applied at its schema default**, so `read`
and mpv agree from the first moment. Error codes: a wrong-typed opt (`kind: 5`, `ao: 5`,
`position: "x"`) is `bad_type`; a bad value (`kind: "color"`) or one mpv rejects at open
(`af: "no_such_filter"`) is `out_of_range`; an unknown/unavailable mpv option/property is
`unsupported`; `io` is kept for real setup/load/I/O failures (mpv init, render-context
create, eventfd). `open` is synchronous only *before* the first `loadfile` (no VO exists
yet, so nothing can wait on the render thread); the load itself is async: a missing or
broken file is `Ok` from `open`, then `Error{reason}` naming the path plus mpv's last
error-log line.

**Async core calls (render thread).** `render.h` forbids the render thread from waiting
on core functions not marked render-thread-safe: the core can be waiting on the render
thread (vo_libmpv's flip waits for `mpv_render_context_render`; after a load/seek the
core waits for that first frame to be shown), so a synchronous `mpv_set_property`/
`mpv_command` stalls until vo_libmpv's timeout — **measured 4–72 ms per call** with the
first, synchronous version (`apply_never_blocks_the_render_thread`: 80 ms without
`update()`, a seek, 240 gain applies). After `open`, every `apply` uses
`mpv_set_property_async`/`mpv_command_async` (`client.h`: "Safe to be called from mpv
render API threads") with a reply id: measured worst apply 120–160 µs in that same test.
A reply with an error becomes `SourceEvent::Rejected{prop, reason}` (R45; `prop` = the
graph property, `gain` for the summed gain push) naming the mpv property/command, the value
and the graph property (`af=no_such_filter_lp (af): …`), and
`props` reverts to the previous value (only if no newer apply of that property is in
flight). **Gains are coalesced:** at most one `volume-gain` request is in flight; gain
changes while it is pending only mark it dirty and the latest sum is sent when the reply
arrives — a per-frame gain ramp can't flood mpv's 1000-entry reply queue, and the final
value always lands. `MpvSource::requests_in_flight()` (0 = everything applied has
reached mpv) is for probes/tests; `mpv_get_string`/`mpv_get_f64` are synchronous and
**tests/probes only**.

**Property map** (graph name → mpv): `loop` → `loop-file` `inf`/`no`; `paused` → `pause`
(observed `pause` changes are mirrored back into `read`); `speed`; `position` → `seek <t>
absolute exact` (or `start` before the current file has loaded; a `path` change resets
`start` to `none`); `hwdec` → `sources::mpv::mpv_hwdec(v)` (copy modes only — "Hardware
decoding" below); `fps_cap` → `vf` `fps=<n>` / `""`; `cache` →
**`auto`** for `true` (mpv's normal policy — what the legacy engine runs with
DisableCache=false; `yes` would RAM-cache every local wallpaper) and `no` for `false`;
`demuxer_max_mib`/`demuxer_back_mib` → `demuxer-max-bytes`/`demuxer-max-back-bytes`
`<n>MiB` (a fractional MiB goes as exact bytes — mpv rejects `1.5MiB`; `0` = unset →
mpv's default 150/50 MiB, the legacy engine's convention); `af` → `sources::mpv::mpv_af(v)`
(below); `no_audio` → `aid`
`no`/`auto` (`auto` re-inits the AO even after a no-audio start — `current-ao` and
`audio-out-params` come up, `start_muted_then_unmute_live`; the `aid` *property* then
reads the picked track id, e.g. `"1"` — `options/aid` reads `"auto"`); `audio_delay` →
`audio-delay`.

**A tempo filter is always in the chain (speed storm).** `mpv_af` hands mpv the graph's `af`
plus `@lp-tempo:scaletempo2` (left out when the chain already has `scaletempo*`/`rubberband`).
With pitch correction on (mpv's default) mpv adds its own tempo filter only while `speed` ≠ 1 and
drops it at exactly 1×, and each add/drop rebuilds the audio chain (its `userspeed` stage and a
s16↔float `convert`, mpv's af log): **3–5 ms of digital silence each, ~200 ms later at the sink** —
measured on the bus meter, 22 holes in 40 s of 0.9↔1.0 toggles, none for 0.9↔1.1 (the UI's speed
slider steps 0.1, so every drag across 1× and every release at 1× lands there). mpv gives the speed
to the last filter of the chain that takes it, so with ours present the chain is built once and
never rebuilt; at 1× scaletempo2 is bit-exact (output identical to the source, zero lag).
`read("af")` keeps the graph value. Unit `af_always_carries_a_tempo_filter`, `tests/sources.rs::
defaults_applied_at_open_match_mpv`.

**Gains → `volume-gain`, `volume` stays 100.** Every `gain.<slot>` apply recomputes
`units::Gains::effective_db()` and sets mpv `volume-gain` = `units::mpv_volume_gain(db)`
(exact dB; `volume` is cubic — § Units; mpv stores it single-precision, so it reads back
within ~1e-6 dB). `volume-gain-min=-96` is what lets mpv accept the −96 dB floor. `open`
pushes the initial sum too, so mpv never runs at its own default.

**Hardware decoding (Task 20d, R107) — copy modes, never GL interop.** Every core runs
`gpu-hwdec-interop=no` and `apply("hwdec", v)` sends `mpv_hwdec(v)`: `""`/`no` → `no`;
`auto`/`auto-copy` → `nvdec-copy,vaapi-copy,auto-copy` (`auto-safe`/`yes`/`auto-copy-safe` → the
same with `auto-copy-safe`, `auto-unsafe`/`auto-copy-unsafe` → with `auto-copy-unsafe`); an interop
name (every mpv 0.41 decoder with a `-copy` twin: `nvdec`, `cuda`, `vaapi`, `vdpau`, `vulkan`,
`amf`, `v4l2m2m`) → its `-copy` twin; anything else (a `-copy` mode, or a name this mpv doesn't
know — e.g. `drm` isn't in 0.41's list: mpv rejects it and the prop reverts, R45) unchanged; lists
element by element (a unit test asserts no accepted value comes out as an interop decoder). On
AMD/Intel this turns `auto`'s zero-copy `vaapi` into `vaapi-copy` too (same trade-off below). `read("hwdec")` keeps the user's value;
the `sources` probe has `mpv_hwdec` (the request) and `mpv_hwdec_current` (the pick). **Why:**
(1) mpv's render context runs hwdec interop init on the render thread — our loop — and with
mpv's default `gpu-hwdec-interop=auto` it creates the **CUDA interop (a CUDA context) inside
`mpv_render_context_create`** whenever libmpv can load `libcuda.so.1`: 65–90 ms per switch,
*whatever `hwdec` says* (also `no`). libmpv's RUNPATH lacks `/run/opengl-driver/lib` (nixpkgs
adds it to `bin/mpv` only), so the dev/install binary fails that load (`ffmpeg: Cannot load
libcuda.so.1` once per source — harmless now) while the flake wrapper's
`LD_LIBRARY_PATH=/run/opengl-driver/lib` (R86) made it succeed; it also succeeds in any process
where libavutil already loaded libcuda for `nvdec-copy` (glibc matches the soname) — so before
this, `nvdec-copy` cost 66–138 ms per switch from its second switch on, and the UI's `nvdec`/`vaapi`
silently decoded in software in the dev binary. (2) mpv 0.41's own `auto` order is `vulkan, nvdec,
vaapi, vulkan-copy, nvdec-copy, …`, so without interop it picks `vulkan-copy`: each new core's
`vkCreateDevice` (mpv's core thread, `select_and_set_hwdec → av_hwdevice_ctx_create`) holds an
NVIDIA driver lock (a process-wide PI mutex) that every GL entry point on our loop waits on —
230–320 ms per switch — **only when no X server is reachable** (`DISPLAY` unset/dead: headless
tests, an Xwayland-less session; with the session's Xwayland reachable 7–22 ms, which is why the
live run and `cargo test` — both inherit `DISPLAY=:1` — never showed it; a nested headless sway
without `DISPLAY` does). Not layers/ICDs (`NODEVICE_SELECT`, `VK_LOADER_LAYERS_DISABLE`, an
NVIDIA-only ICD list changed nothing): driver-internal. An explicit `vulkan`/`vulkan-copy` keeps
that limit (driver; documented, not worked around). **Measured** (hermetic headless 2 × 1080p60,
1080p30 h264 clips, fade 500 ms, 6 switches per mode in one process, no `DISPLAY`; max loop busy
per switch, ms):

| `hwdec` | dev env before → after | libcuda on the path (flake wrapper) before → after |
|---|---|---|
| `no` | 10–34 → 10–47 | 74–157 (CUDA interop) → 14–49 |
| `auto` | 264–300 (`vulkan-copy`) → 12–42 (`nvdec-copy`) | 79–95 (`nvdec` interop) → 11–40 (`nvdec-copy`) |
| `nvdec` | 10–89, **software** → 8–42 (`nvdec-copy`) | 85–98 (`nvdec`) → 13–50 (`nvdec-copy`) |
| `vaapi` | 9–39, **software** → 10–43 (`vaapi-copy`) | 72–94, software → 18–40 (`vaapi-copy`) |
| `nvdec-copy` | 21, then 81–115 → 10–33 | 72–83 → 10–33 |
| `vulkan` / `vulkan-copy` | 72–82 (software) / 261–284 → 273–313 / 267–297 (no X; with X 7–22) | — |

**The trade-off (Phase 1):** copy modes download each frame and mpv uploads it on the loop like
software decoding. Steady state, one source on both outputs, % of one core: 1080p30 `no` 27.7,
`nvdec-copy` 9.8, `vaapi-copy` 26.0 (nvidia-vaapi-driver), `vulkan-copy` 14.4, `nvdec` interop
7.4; 4K60 `no` 111, `nvdec-copy` 55.6, `vulkan-copy` 80.1, `nvdec` interop 11.3 (loop max busy at
4K60: `no` 8.1, `nvdec-copy` 12.8, interop 2.8 ms). First frame of a cold source (1080p): `no` 319,
`nvdec-copy` 438, `vaapi-copy` 642, `vulkan-copy` 698 ms — hence `nvdec-copy` ahead of mpv's
`vulkan-copy` in `auto`. Zero-copy interop comes back with the Phase 2 render worker (§ Runtime
"Switch cost"), whose thread owns render-context creation. Guards:
`tests/api.rs::t20d_hwdec_switch_never_stalls_the_loop` (dev env + libcuda env, `DISPLAY`/
`WAYLAND_DISPLAY` removed; warm median < 50 ms — fixed medians 16–36 ms, the traps ≥ 65 — and
never an interop mode; RED before: 286, 91, 85, 88 ms), `tests/sources.rs::property_map_reaches_mpv`, unit `hwdec_maps_to_copy_modes_only`.

**Load fencing (live `path` changes).** Every `loadfile` is async; its reply carries the
new playlist entry id (`playlist_entry_id` from the result map), START_FILE/END_FILE carry
the entry they belong to, and FILE_LOADED / PLAYBACK_RESTART / observed properties are
attributed to the entry between its START_FILE and END_FILE. Only the **current** load
(newest `loadfile`'s entry, while mpv is playing it) counts: a superseded load's
FILE_LOADED, PLAYBACK_RESTART, END_FILE (incl. ERROR — never reported under the new path),
`eof-reached` and `time-pos` are ignored; `time-pos`/`eof-reached` count only after the
current load's PLAYBACK_RESTART (a value delivered right after a path change may still
describe the old file). Pinned by `path_change_before_first_pump_shows_only_new_file` and
`stale_load_error_is_not_reported_for_new_path` (both RED against the first version: Ready
fired on the old file's red frame; the old file's load error was reported under the new
path), plus `path_change_to_missing_then_back` and `path_change_is_live`.

**Events.** `Ready` once per load = the current load's PLAYBACK_RESTART **and** one of
its frames rendered after its FILE_LOADED, **in either order** — both happen (measured:
restart-first for paused clips and images; frame-first in 2 of 3 runs for a playing
video). Requiring "a render *after* the restart" could wait forever on a paused source or
an image whose single frame happened to render first. `Ended` once per play-through, from `eof-reached` (with `keep-open=yes` mpv
never sends END_FILE/EOF; that path is handled too) — re-armed when `eof-reached` goes
false (seek back/loop); never with `loop=true`, never for an image; a seek back after the
end plays again and ends again (`ended_holds_last_frame`). `Position(t)` from observed
`time-pos`, rate-limited to 100 ms. `Error` from END_FILE/ERROR of the current load, a
foreign-context `update`, or a core shutdown; a failed async property/command request is
`Rejected` (R45). **Looping files:** mpv's `time-pos` drops back to 0 while the *last*
frame is still on screen; the visible boundary (frame 0) follows one frame later (measured
33.9–34.3 ms at 30 fps).

**`AudioFlowing` (Task 16c, R85, invariant #8) — real audio output confirmed, not just
un-paused.** `apply("paused", false)` on a source that was paused arms a wait
(`awaiting_flowing`) rather than assuming audio starts the instant mpv's `pause` flips:
the owner's "flicker of silence" report measured mpv/PipeWire's own audio-out restart
lagging an un-pause by ~19 ms (Task 15's dropout detector), so a caller that starts an
onset gain ramp at the instant of un-pause runs most of the ramp's early portion on no
audio at all. Fires immediately (never actually waits) for: stepped mode (`self.stepped`
— the core is paused for good there, § "Stepped mode" below; audio is always silent, so
nothing to confirm — including the stepped-logical `"paused"` branch itself, which still
arms/fires through the same `arm_audio_flowing` so a caller holding a ramp on a stepped
source's un-pause is never stuck), an image, or `no_audio`. Otherwise armed: the next
`audio-pts` property change (`OBS_AUDIO_PTS` — **observed only while armed** since the final
review (M4): `observe` on arm, `unobserve` on confirm/disarm; it changes at the audio-buffer
rate and woke the loop all day; the first notification after `observe` is the current value
and is skipped) reports it —
man mpv: "Current audio playback position... takes into account the audio driver delay"
— unlike `time-pos`, it doesn't move while held/paused, so the very next change after
arming is the real thing. `load` (a `path` change) resets `awaiting_flowing` — a new load
supersedes everything — and **arms it again when the load plays** (not paused; final review I6:
a restored source's fade-in waits for it), as does an audio re-route
(`MpvSource::set_audio_route`, I7). Callers (the transition recipe, `Runtime`'s player-pause gain)
bound the wait themselves (`recipes::transition::ONSET_TIMEOUT`) — the source itself
never times out; it either confirms or waits. **Two confirmations no further `audio-pts` change
brings** (`MpvSource::confirm_flowing_by_time`, after every pump — every tick; TODO "onset_timeout on
audio-less videos"): the margin is **real time** since the first change (it used to need a *later*
change, so a stream that stalls right after starting never confirmed), and **the picture plays on
without any audio** — `audio-pts` reported *unavailable* (mpv plays no audio: none selected yet —
an audio-less file whose `aid` hadn't resolved — or the selected track already ended, e.g. a 30 ms
track on a 4 s video) while the media position moved `NO_AUDIO_MEDIA_ADVANCE` (0.1 s, a wrap counts)
since arming — with audio playing, mpv's clock is the audio, so the picture can't run ahead of it.
Nothing will be heard, so the ramp may start. RED before: every onset onto such a B waited out the
150 ms and logged `transition.onset_timeout` (all 6 method × align cells with a 30 ms track);
`tests/api.rs::audio_less_b_never_times_out_its_onset_any_method_or_align` (no audio stream, a
short track, then a 16-request switch storm; also asserts no `runtime.onset_timeout`). A core that
never plays (no change, position stuck) still never confirms.

**`has_audio` (R92, review of Task 16c/16d) — does the *file* genuinely have an audio
track, mirrored into the graph like `kind`/`ready`.** Distinct from `no_audio` (our own
request, `aid=no`) and from `kind == "video"` (just "not a still): a video with no audio
*stream at all* used to be indistinguishable from one with audio merely disabled, so
every onset/R88 resume on it waited the full `ONSET_TIMEOUT` and logged a warning, every
time. Observed via `aid` (`OBS_AUDIO_SELECTED`, `Format::Str`) — not `current-tracks/
audio/id`, tried first and found to never re-notify for a genuinely audio-less file
(unavailable before *and* after load isn't a value transition mpv bothers to re-signal;
measured directly, `tests/sources.rs::has_audio_reflects_real_track_presence`). `aid`
always holds a real value (`"auto"` pre-resolution, then a track number or the literal
`"no"`), so it reliably transitions even on the very first load. The observation is
*ignored* while `no_audio` is on (an observed `"no"` then says nothing about the file,
only about our own request) — `has_audio` keeps whatever it last knew until `no_audio`
is off again and `aid` re-resolves for real. `None`/unknown (no file loaded yet, or no
notification seen for this load) reads `true` (the schema default) — the conservative
"don't falsely skip a real wait" choice. `arm_audio_flowing` fires immediately (no wait)
when `has_audio == Some(false)`, same bucket as `no_audio`/image/stepped above;
the one predicate, `crate::onset::has_audio` (`kind == video && !no_audio && has_audio !=
false`), carries the same check for the recipe and the runtime (final review M12 merged the
copies).

**Render targets: front + back.** `front` is what `texture()` returns. Until the current
load is `Ready`, every frame (including any leftover of a superseded load) renders into a
staging `back` target; at `Ready` the back is promoted to the front in the same `update`
that pushes the event — so the texture at `Ready` is the new file's first frame, and
until then the front still holds the old file's last frame (never a blank, never a stale
redraw). After `Ready`, frames render straight into the front. Size: native display size
(`dwidth`/`dheight`, observed), capped at 4096 on the long edge (aspect kept); a target is
reallocated on a size change — render into the new one, swap only on success (a failed
render keeps the old frame). After each render `reset_gl_state` unbinds FBO/program/VAO/
buffer/texture, disables blend + scissor, resets colour mask and pixel-store alignment —
libmpv leaves its own state behind.

**Wakeup contract (Task 12 polls this).** `mpv_set_wakeup_callback` and
`mpv_render_context_set_update_callback` both `write(2)` to one `EFD_NONBLOCK` eventfd
(the fd number is the callback context — no allocation, no mpv calls in the callback);
`MpvSource::wake_fd()` exposes it. On readability call `poll_events()` **and**
`update()`; each drains the fd first, then pumps every queued mpv event
(`wait_event(0)` — events and async replies), so a signal arriving mid-call re-arms the
fd and nothing is lost. `update` uses `mpv_render_context_update` (level-triggered
`UPDATE_FRAME`) and renders only when a frame is waiting, with
`BLOCK_FOR_TARGET_TIME=0`; no `ADVANCED_CONTROL`.

**Teardown with GL current (lp-transition gotcha).** `mpv_render_context_free` must run
with its GL context current and before `mpv_terminate_destroy`. Sources get no `&Gfx` in
`Drop`, so they hold a `gfx::GlKeepAlive` (`Gfx::keep_alive()`): an `Rc<Shared>` clone
(same pattern as `WindowTarget`) that keeps the EGL context alive past the `Gfx`, plus
`make_current()` (a guard that restores whatever was current before; a no-op when the
context already is), `is_for(gfx)`, and `glDelete{Textures,Framebuffers}` pointers.
`MpvSource::drop`: make current → free render ctx → delete both FBOs/textures → clear
wakeup cb → **hand the core to the reaper** → close eventfd (in `open`, the eventfd is
created before the core so error-path locals drop in the same order). **Teardown never stalls the loop (R51), in
two phases.** (1) When a node goes, `SourceHost::sync` calls `Source::begin_teardown()`
(default: `true` = drop now). `MpvSource` sends `stop` (async) and returns `false`: the
host moves it to a `dying` list (no longer in `ids`/`texture`/`wake_fds`; silent from the
stop on). (2) `SourceHost::update` drops it once `teardown_ready()` — mpv idle after the stop
(idle ⇒ the VO is uninitialised), the core dead, or 500 ms (`TEARDOWN_MAX`). "Idle" is
decided from event order, never from a stale initial value (item 14): the `stop` is only
sent once the last gain push reached mpv (stopping cuts the audio — the final −96 dB lands
first); at its reply the core counts as idle if no START_FILE was ever seen (a START_FILE
would precede the reply, so no VO exists) or the last file ended and `idle-active` = true
was reported *after* that END_FILE; otherwise the stop's own END_FILE + an `idle-active`
notification after the reply are waited for. `rapid_create_destroy_never_stalls` (20×
create + destroy at once, before the VO is up) guards it. Then `Drop` frees the render
context — fast now: with the VO live, `mpv_render_context_free` waits on the playloop
(**measured 21–32 ms** for a playing 1080p clip) — and hands the core to the **reaper**
(`sources/reaper.rs`): one background thread runs `mpv_terminate_destroy` (30–240 ms
measured), started on first use, then `malloc_trim(0)` once its queue is empty (§ Memory); the wakeup callback is cleared first (mpv invokes it
under the same lock, so nothing writes the eventfd after that). `reaper::shutdown(timeout)`
(`quit`: after `SourceHost::finish_teardown(500 ms)`, ≤ 2 s) closes the queue, waits and
returns the stragglers (logged `mpv.reaper_stragglers`); later drops destroy
synchronously. `reaper::pending()`/`SourceHost::dying()` for probes. Pinned by
`tests/api.rs::destroy_never_stalls_the_loop`: max loop busy around the destroy of a
playing video 1.7–3.0 ms (5 runs); RED with a synchronous core destroy 29.6 ms, with the
reaper but a one-phase drop 21–32 ms (flaky against the 20 ms bound). Drop order vs the `Gfx` is irrelevant —
pinned by `source_outlives_gfx_safely`; dropping with another context current switches
and restores (`update_with_foreign_context_is_refused`). If the context somehow can't be
made current, the core is sent `stop` (silent), both callbacks are cleared, and it's
leaked rather than freed against the wrong context.

**Fence-leak mitigation** (technique from mpvpaper 1.9, PR #132 by manv-3, GPL-3.0;
credited in Task 19): the `get_proc_address` given to `mpv_render_context_create` returns
a stub for `glFenceSync` that returns 0 (a null sync); everything else comes from
`eglGetProcAddress`. libmpv's render-API path otherwise accumulates sync objects. **Why
it's safe:** mpv null-checks the fence before storing it or calling `glClientWaitSync` on
it, and `glDeleteSync(0)` is a GL no-op — so the stub just turns fence bookkeeping off.
What mpv's fences actually guard is buffer reuse: (a) direct rendering (`vd-lavc-dr`),
which on the render API needs `MPV_RENDER_PARAM_ADVANCED_CONTROL` — never passed; (b) PBO
uploads (`opengl-pbo`), where a PBO could be rewritten while the GPU still reads it —
pinned `opengl-pbo=no` (mpv's default) in `open`. **Neither may be enabled while the stub
is in place.** `sources::mpv::fence_stub_calls()` counts stub calls;
`fence_sync_stub_is_used` proves libmpv really calls it, and `first_frame_and_ready`
checks no GL error is left behind.

**Stepped mode (`opts.stepped: true`, Task 12, R48).** The core is paused for good
(`pause=yes` set before the first load); `paused` and `position` applies are **stored
only** (logical — what the graph says, mirrored back unchanged; observed `pause` is not
mirrored), and `eof-reached`/EOF never emit `Ended`. The runtime drives frames:
`step_seek(t)` sends `seek <t:.6> absolute exact` (async), and `step_status()` is `Done`
once the seek's reply, then a PLAYBACK_RESTART, then a rendered frame have been seen
(mpv completes the `seek` command before the playloop executes it, so the reply always
precedes that seek's restart), `Pending(what)` meanwhile, `Broken(reason)` for a load error
/ rejected seek / dead core (not waited on). `step_end(at_end)` queues `Ended` when the
virtual time first reaches a non-looping end (a paused exact seek to the end never sets
`eof-reached` — measured) and re-arms it once back before the end. `step_target()`,
`is_ready()`, `is_stepped()` for the runtime/probes. `Source::as_mpv`/`as_mpv_mut`
(default `None`) + `SourceHost::mpv`/`mpv_mut`/`wake_fds_by_id`/`open_failed` reach it.

**`ColorSource::new([r,g,b])`** (0–255, the graph's `color`): a 1×1 `RGBA8` texture
(LINEAR + CLAMP_TO_EDGE → the colour everywhere), created lazily on the first `update`
(construction has no `Gfx`) and repainted only when `color` changes (never through a
foreign context). `Ready` is queued at construction (first `poll_events`). Every other
writable property is accepted and stored (so an alias/global `set` never fails on a
colour layer) and does nothing.

**`SourceHost` (`sources/host.rs`, R32) — the only place a graph node becomes a live
source.** `SourceHost::new(base_opts)` (merged into every `MpvSource::open`, e.g. `{"ao":
"null"}` in tests). Per loop iteration, in this order: `sync(gfx, graph, changes)` drops
sources whose node is gone, opens one for every new `Source` node from `props_of` (`color` →
`ColorSource`, `snapshot` → `SnapshotSource` of `of`'s *current* texture, else `MpvSource`;
colour/snapshot get every writable prop applied so `read` agrees with the node), then
forwards each drained change to `apply` (skipping sources it just opened — their props
already include it); a refused `apply` is logged (`source.rejected`) and queued as
`SourceEvent::Rejected` (R45), a failed open as `SourceEvent::Error` (not retried until the
node goes). `update(gfx, graph)` updates every source, collects its events, then mirrors
observed values (`kind` — MpvSource's inferred/corrected image|video —, `ready`,
`duration`, `time_pos`, `width`, `height`, `paused`) with `Graph::set_observed`. **`sync` must precede `update`** each iteration, or the mirror would
overwrite a command not yet forwarded. `events()` drains `(node id, event)`; `texture(id)`
is the compositor's closure; `wake_fds()` (mpv sources) is what the runtime polls; `get`/
`ids` for probes/tests.

**Async opens (final review I5).** With `SourceHost::set_async_open(Some(waker))` (the
real-clock runtime; its waker is a calloop ping) a new mpv node's core is made on an `lp-open`
thread (`MpvSource::prepare_core`, base opts only); the node is `opening` (not hosted: no
texture, no events, `open_failed` false) until a later `sync` finds the worker's result and
opens the source from the node's **current** props (so a change made meanwhile is never lost);
a worker error is the same `SourceEvent::Error` + `failed` as a synchronous one; a node gone
meanwhile drops the result (`PreparedCore::drop` → reaper). `finish_teardown` waits (bounded)
for outstanding workers; `host::opening_pending()` counts toward `mpv.reaper_stragglers`. R29
`Ready` semantics are unchanged (still the first frame of the current load). Stepped mode and
the harnesses open synchronously. **Bounded (TODO "No explicit cap on concurrent `lp-open`
worker threads"):** the cores are made by `host::OpenPool` — a FIFO queue served by at most
`MAX_OPEN_WORKERS` (2) `lp-open` threads, spawned on demand and gone once the queue is empty
(an idle player has none); before, every create spawned its own thread (a burst of 16 = 16 at
once). A queued job holds its slot **weakly**: a node destroyed before a worker gets to it is
skipped (no core made — `open_pool.skipped`), so a switch storm's superseded B's cost nothing; a
running one holds it strongly (a node gone meanwhile drops the result → reaper, as before); a
prop changed while queued lands because the source still opens from the node's current props.
`finish_teardown`'s wait is then the ≤ 2 cores in progress. A job that panics doesn't kill its
worker; a pool that can't start a thread with none running hands the open back (synchronous).
**Measured** (release, hermetic headless, a burst of 16 paused 1080p creates, 3 rounds per cap):
all made + opened 102–166 ms at cap 1, **61–80 at 2**, 58–71 at 4, 23–70 uncapped; all ready ~0.5 s
whatever the cap (first frames dominate); the loop's longest open share 3–5, **2–8**, 11–24, 13–29
ms (more finished cores land in one `sync` the higher the cap). Guards: `tests/api.rs::
i5_open_burst_is_capped_and_none_lost` (16 creates in one write: peak ≤ 2, every kept one opens
and readies, the 3 destroyed while queued are skipped or opened-and-retired — measured: all 3
skipped —, the one un-paused while queued plays, quit with a second burst queued exits in ~40 ms
with no straggler; RED before: 16 at once), unit `open_pool_caps_concurrency_in_order_and_loses_none`,
`open_pool_survives_a_panicking_job_and_restarts_after_idle`.

**Audio re-route (final review I7).** `SourceHost::set_audio_route(device, bias)` — the bus went
down (`None`: mpv's default device) or came back (`Some(bus device)`, bias = −latency): base
opts change for new sources, every hosted mpv source gets `MpvSource::set_audio_route` (async
`audio-device`, a changed `audio-delay`, then `aid no` + `aid auto` — a dead server takes mpv's
AO with it and mpv deselects the track, so an `audio-device` change alone left
`current-ao` unset; measured), and a core still being prepared with the old route is re-routed
when it opens.

**`SnapshotSource` (`sources/snapshot.rs`)** — a still copy (`glBlitFramebuffer`, row order
kept → image-top at `t = 0`) of another source's texture taken at creation; `Ready` at
once; never changes; no audio. It exists because pausing doesn't freeze a texture: a paused
mpv still presents its queued frames (measured 2–3 frames, ~100 ms after the pause, with
`time_pos` already frozen). The transition recipe holds reveal/frozen pictures with it.
Pinned by `tests/sources.rs::snapshot_copies_frame_and_orientation` (pixel-identical,
image top at low y, constant while the source advances).

**Tests (`tests/sources.rs`) — always `ao: "null"` (R26)**, so a run is silent on the
owner's speakers; `audio-params`/`current-ao` still populate with the null AO. Raw mpv
reads after an `apply` first `settle()` (pump until `requests_in_flight() == 0`). Media
come from `tests/common::ensure_clip(name, ClipSpec)`: ffmpeg from PATH →
`target/test-media/`, generated once (regenerated only if the `<name>.spec` stamp
differs), via a temp name + rename, serialised by a mutex. Videos are 1920×1080@30
`libx264` `yuv420p`, built in `rgb24` and converted once with an explicit BT.709
limited-range matrix **and tagged** so mpv decodes with the same matrix — solid colours
come back within ±3 (YUV round trip + mpv's output dither), `FrameIndex`'s neutral-grey
`(n,n,n)` marker within ±1 (ffmpeg itself decodes frame 119's marker as 118). Audio for
`Solid` is PCM s16le (exact level).

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
          xfade −96    (10 s timeout) ready; no                  A released → graveyard
                                      graves on outputs
pre-Running  ── superseded / cancel / B failed ──▶ abort: B destroyed, A restored exactly
Running      ── new start on an overlapping output ──▶ commit (→ Handoff)
Running      ── cancel / B failed ──▶ snap back to A
```

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
`transition.onset_timeout`. `recipes::transition::b_has_audio` (= `crate::onset::has_audio`: kind == `video` && not
`no_audio` && not `has_audio == false`, R92) skips the whole mechanism for a `color`/`image`/`snapshot` B, or one explicitly
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

**Align.** `Now` = when B is ready. `End` (lead A = the first requested output's A; a
still/absent A → `Now`): non-shared A gets `loop=false` at `start` (restored on
cancel/failure — and seeked to 0 if it ended because of it). full-live *ends* at A's end:
start = end − D, where end is the minimum over ticks of `now + (duration − time_pos)/speed`
minus half a frame (`time_pos` is the shown frame's pts, so each sample over-estimates by
0…1 frame; the frame step is the smallest `time_pos` increment) — measured within ±17 ms of
A's real `Ended`; a speed change **rescales** that minimum (`t + (end − t)·s0/s1`, still an
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


## Runtime

`src/runtime.rs` + `src/headless.rs` (spec §4.1/§4.2, §9 "headless deterministic mode";
Task 12). `lp-player serve --headless [--outputs 1920x1080@60[,…]] [--clock real|stepped]
[--ao <mpv ao>] [--socket <path>] [--log-level error|warn|info|debug|trace] [--restore]
[--no-supervise] [--redraw-policy content|every_tick]` — defaults `1920x1080@60`, `real`,
mpv's lp-player default ao (`pipewire`), `info`. `serve` is **supervised** unless
`--no-supervise` (§ Supervisor: the process you start is the supervisor, the compositor is
its child); `--restore` recreates `<state>/snapshot.json` (§ Snapshot);
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
and no audio bus is created (§ Audio bus). With the default AO, `serve` creates the bus
right after binding the socket (a second instance exits before touching PipeWire) and
adds `audio_device` + `audio_delay_bias` to the base opts.
Without `--headless` it draws on the compositor's outputs (§ Wayland); `--outputs` is
then refused (exit 2).

**Paths (`src/paths.rs`).** Socket `$LP_PLAYER_SOCKET`, else
`$XDG_RUNTIME_DIR/livepaper/lp-player.sock` (else `/run/user/<uid>/…`); the socket is
made `0600`, its dir `0700` — **only** if we created that dir or it's the default
`…/livepaper` (a `--socket`/`LP_PLAYER_SOCKET` in someone else's directory is never
chmod-ed). State/event log `$XDG_STATE_HOME/livepaper/lp-player/` (default
`~/.local/state/livepaper/lp-player/`). **Single instance = a lock file:** `<socket>.lock`
(`lp-player.lock`, `0600`) is `flock(LOCK_EX|LOCK_NB)`-ed for the process lifetime and
holds the owner's pid; the loser exits 1 with `lp-player is already running (pid N) on
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
`stop`. So a rotation keeps its place invisibly and the *last* target is what the next output
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
warn keys, hosted/opening/dying sources, `open_queued` (opens waiting for an `lp-open` worker),
transitions/graves/ended/restore onsets). `GainHistory`
is run-length encoded (a steady source = two samples), drops a dead source's track
`DEAD_LINGER` (30 s) after its last reading (its post-roll analysis needs it), and is capped at
`MAX_TRACKS` 64 / `MAX_TOTAL_SAMPLES` 131 072 (least recently seen dead track first). Test:
`tests/api.rs::c1_long_run_switches_stay_bounded` (200 switches + destroys: 64 tracks, ~4 200
samples, everything else ≤ 4), `probe::dropout` unit test (10 000 simulated cycles).

**Switch cost and the Phase 2 render worker (final review I5).** Per switch, measured
(`tests/api.rs::i5_switch_loop_busy`, a cut/fade to a fresh 1080p clip, 10 switches ×2 runs):
**before** max loop busy 32–54 ms (median 36–44), synchronous open 3–14 ms; **after** (core on
the `lp-open` worker, `dither=ordered`, the shader cache) 8–26 ms (median 17–19), open 1–8 ms.
**Residual:** the render-context creation (+ props + `loadfile`, 1–8 ms) and the new context's
first `render_into` (6–20 ms: shader compile/link — cached binaries help little on this
NVIDIA driver, which already has its own disk cache — scaler LUTs, texture/FBO setup) still run
on the loop, i.e. one to five missed frames at 240 Hz on every output per switch; Task 20's
pacing criterion should exclude the switch frame. **Phase 2 plan:** a render worker thread with
its own EGL context in the compositor's share group owns every `MpvSource`'s render context —
creation, first render, and every later render into a shared texture (with a sync fence per
frame) — so the loop only samples finished textures; the same thread is where dmabuf imports
from the scene/web workers land. Until then the loop counts the open share apart
(`max_open_ms`). These numbers hold for every `hwdec` since Task 20d (copy modes, no GL interop
init in the render context — § Sources "Hardware decoding"; before, `hwdec=auto` cost 230–320 ms
and a loadable libcuda 65–90 ms per switch).

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

**Tests (`tests/api.rs`).** Spawn the real binary (`env!("CARGO_BIN_EXE_lp-player")`)
with `serve --headless --outputs 640x360@60,320x180@60 --clock stepped --ao null` (some
add `--clock real`), temp `XDG_RUNTIME_DIR`/`XDG_STATE_HOME` under `std::env::temp_dir()`
(never the real ones); the `Serve` guard kills the child on drop (also on panic), and
every spawned `serve`/`ctl` child gets `PR_SET_PDEATHSIG(SIGKILL)` (`die_with_parent`) so
an aborted/killed test run never leaves a stray server behind. One server at a time
(process-wide lock, handed between the two servers of a two-run test). Skips only without
EGL or a catalogue. **Gotcha:** in `state.graph` a source node's `kind` is its *Source*
kind (`video`/`image`/`color`/`snapshot` — the schema prop overwrites the node kind in the
snapshot); recognise sources by `gain_effective_db`. And a log `fields` key named like a
fixed key (`kind`, `corr`, …) overwrites it — `source.open`/`.teardown` say `source_kind`.

## Command API

`src/api/` + `src/ctl.rs` (spec §4.2 "Command API", §8/§9; Task 12). JSON Lines over the
unix socket (§ Runtime → Paths):

- request `{"id":N,"cmd":"<verb>","args":{…}}` — `args` optional, `id` any JSON value
  (echoed back)
- reply `{"id":N,"ok":true,"result":…}` | `{"id":N,"ok":false,"error":{"code","message",
  "hint"}}` — **every error has a hint saying what to do next**; an unparseable line gets
  `"id":null`
- event (after `subscribe`) `{"event":"<kind>","corr":…,"t_mono_ms":…,"t_wall","comp",
  "level",…fields}` — the event-log record with `kind` renamed. Events a command causes are
  delivered **before** its reply on the same connection (the tap is flushed before every
  reply).

**`ctl`:** `lp-player ctl [--timeout-ms N] <verb> ['<json args>']` prints the result as
pretty JSON, exit 0 — or the error object (stdout), exit 1 (also for no player / bad JSON
args / **no reply within `--timeout-ms`, default 10 000** → `timeout`, hint: pass a longer
`--timeout-ms`; all with a hint). `lp-player ctl subscribe <prefix…>` prints events one
JSON object per line until Ctrl-C, without a timeout; when the player exits it prints a
note on stderr and exits 0 (or stdout closes).

| verb | args | result | errors (besides `bad_request`) | `ctl` example |
|---|---|---|---|---|
| `hello` | — | `{version, pid (the compositor — the supervisor's child when supervised), supervisor_pid (null unsupervised), restart (the `supervisor.restart` fields this child logged, or null), protocol: 1, capabilities: [video, image, color, transition, headless?, stepped?], clock, backend, verbs}` | — | `ctl hello` |
| `create` | `{kind: source\|layer\|effect, id?, props?}` | `{id}` | graph codes; `no_such_effect` (an effect's `effect_id`); `unsupported` (output/player) | `ctl create '{"kind":"source","props":{"path":"/w/a.mp4","loop":true}}'` |
| `destroy` | `{id}` | `{ramp_ms}` — an audible source is ramped out first (30), else gone now (0) | `no_such_node`; `unsupported` (an output or main layer) | `ctl destroy '{"id":"src3"}'` |
| `set` | `{path, value}` (aliases: every match) | `{targets: [ids]}` | graph codes; `no_such_effect` (`<fx>.effect_id`) | `ctl set '{"path":"srcs:*.gain.user","value":-6}'` |
| `get` | `{path}` (must resolve to one node) | `{value}` | graph codes, `ambiguous` | `ctl get '{"path":"cur:DP-1.time_pos"}'` |
| `animate` | `{path, to, duration_ms, curve?: linear\|smoothstep\|equal_power_out\|equal_power_in\|step, from?, unit?: scalar\|gain_linear}` — numbers + gain slots; starts now; `from` defaults to the current value and is range-checked like `to`; `gain_linear` only on `gain.*` | `{corr, targets}` (a broadcast alias matching nothing: `targets: []`, like `set` — M13); `anim.done {corr}` per finished animation | `bad_type` (non-numeric), `out_of_range` (`to`/`from`), `bad_request` (unit), graph codes | `ctl animate '{"path":"lay:DP-1:main.opacity","to":0,"duration_ms":500}'` |
| `transition` | `TransitionReq` (§ Transition recipe): `{outputs, to, effect_id?, params?, duration_ms?, method?, align?}` | `{corr, to: B's id}` (`parked: true` when no output exists — § Runtime, I4) | `no_such_effect` (not in the catalogue — hint: `ctl effects`), recipe codes | `ctl transition '{"outputs":"out:*","to":{"path":"/w/b.mp4"},"effect_id":"fade","duration_ms":1000}'` |
| `cancel` | `{corr}` | `{}` | `no_such_node`, `unsupported` (after handoff) | `ctl cancel '{"corr":"tr-12"}'` |
| `state` | — | `{graph (Graph::snapshot), transitions (status), clock {mode, now_ms}, outputs [{name,width,height,hz,refresh_mhz}], backend (headless\|wayland), sources (hosted ids), parked}` | — | `ctl state` |
| `subscribe` | `{topics: [kind prefix…]}` (`""` = all; additive) | `{topics}` | — | `ctl subscribe transition. source.` |
| `capture` | `{target: out:<n> \| lay:<n>:main \| <source id>, path (absolute)}` | `{path, width, height}` | `no_such_node`, `unsupported` (no frame yet), `io` | `ctl capture '{"target":"out:DP-1","path":"/tmp/dp1.png"}'` |
| `logs` | `{comp?, corr?, min_level?, kind_prefix?, limit? (200, ≤ 10000)}` | `{events: [records, oldest first]}` | — | `ctl logs '{"corr":"tr-12"}'` |
| `probe` | `{name, args?}` | the probe's result | `no_such_probe` | `ctl probe '{"name":"sources"}'` |
| `effects` | — | `{ids}` (catalogue order; `[]` without `transitions/`) | — | `ctl effects` |
| `stop` | — | `{stopping: [ids]}` | — | `ctl stop` |
| `quit` | — | `{}` (then the process exits 0) | — | `ctl quit` |
| `step` | `{ms}` (0–600000) | `{now_ms}` (deferred until every frame is in; the client's later requests wait for it) | `unsupported` (real clock), `timeout`, `busy` (64 queued) | `ctl step '{"ms":16}'` |
| `headless.add_output` | `{name, width, height, hz? (60)}` | `{id: out:<name>}` | `out_of_range`, `unsupported` (exists / not headless) | `ctl headless.add_output '{"name":"VIRTUAL-3","width":1920,"height":1080,"hz":60}'` |
| `headless.remove_output` | `{name}` | `{}` | `no_such_node`, `unsupported` | `ctl headless.remove_output '{"name":"VIRTUAL-2"}'` |

**Error codes** beyond the graph's (§ Graph & properties): `bad_request` (not JSON / no
`cmd` / bad args), `no_such_verb` (hint lists every verb), `no_such_effect`,
`no_such_probe`, `timeout` (a step's frames; `ctl`'s reply wait), `busy` (step queue
full), `io` (capture write, ctl connect).

**Event kinds** (subscribe by prefix): `transition.scheduled|started|handoff|done|
cancelled|failed|graph_error` (the recipe's outbox, R37), `source.ready|ended|position`
(runtime, `position` is debug-level ~10 Hz, every change in stepped mode),
`source.retire|parked|unparked` (runtime), `source.error|rejected|open|teardown|drop`
(host), `transition.output_adopted`, `output.added|removed|changed|layer_failed|
present_failed`, `wl.connected|surface_ready|surface_closed|surface_recreated|layer|
gl_error|duplicate_output|pointer_error|driver_env|default_queue_failed` (the last two Task
20e), `input.pointer` (debug), `loop.failed`,
`anim.start|done|dropped`,
`api.client_connected|closed|dropped|tap_overflow`, `player.started|stopped|quitting|exit`,
`step.timeout`, `mpv.reaped`, `mpv.trimmed` (debug, Task 20b), `mpv.reaper_stragglers`,
`mpv.options_skipped` (a script trim this libmpv doesn't know, once per process), `effects.missing`,
`supervisor.restart` (the restarted child, first thing) | `child_exited|giving_up|
stop_timeout|spawn_failed` (the supervisor, appended to the shared log),
`snapshot.restored|none|invalid|dropped|source_failed|prop_rejected|saved (debug)|
write_failed|write_recovered`, `test.crash`,
`audio.bus.up|down|retargeting|retarget_failed|moved|latency_shots|latency_unmeasured|thread_panicked`,
`audio.meter.started`, `audio.meter.scratch_exceeded` (T14 residual — a negotiated quantum
exceeded the meter's RT scratch cap, chunked rather than reallocated), `probe.dropout`
(Task 15 — `{corr, report}` or `{corr, skipped}`; review fix round: `report.fit` is
`"ok"`/`"insufficient"`, `skipped` can be `"busy"` when 2 analyses are already running —
R77/R79, `docs/player/debugging.md`), `probe.dropout_decode_failed`,
`probe.dropout_analysis_stragglers` (R79 fix round — `Runtime::shutdown`'s bounded join
of in-flight dropout analyses, mirroring `mpv.reaper_stragglers`),
`compose.failed`, and (final review) `onset.held|started` (debug), `runtime.onset_timeout`,
`transition.align_fallback`, `effects.compile_failed`, `audio.bus.reconnecting|reconnect_failed|
sources_rerouted`, `supervisor.stopped`, `probe.dropout {skipped: "window_too_long"}` — i.e.
every event-log kind
(log warnings included). Every event has `corr` (or null) and `t_mono_ms`.

**Global settings go to `srcs:*` (R50).** The backend (Task 17) sends every global setting
— `gain.user`, `no_audio`, `speed`, `hwdec`, `fps_cap`, `cache`, `demuxer_*`, `af`,
`audio_delay` — as `set srcs:*.<prop>` (or `srcs:<connector>` per output), never `cur:*`:
`cur:` misses the pending B of an in-flight transition, which would then take over with
the old value (project rule "settings apply live"). Per-item overrides target the item's
own source id. Layer settings (`fit`, `viewport`) go to `lay:*:main`. A `set` on a
broadcast alias (`srcs:*`, `cur:*`, `out:*`, `lay:*:main`, and `srcs:<c>`/`cur:<c>` of an
output that exists) that matches nothing right now is still type-checked against that
kind's schema and succeeds with `targets: []` (a broadcast to nobody isn't an error); an
unknown connector or a concrete id that doesn't exist is `no_such_node`. With no output
left, `srcs:*` is exactly the parked wallpaper (§ Runtime → Outputs).

**Probes (`src/probe/`).** `dropout` analyses are bounded (final review M8): each ffmpeg
decode is killed after 20 s (`DECODE_TIMEOUT`), and a window longer than 120 s
(`MAX_ANALYSIS_WINDOW`, e.g. a pause gate spanning a long pause) is skipped
(`probe.dropout {skipped: "window_too_long"}`) instead of decoded into memory; if the 1 ms-refined
lag can't be fitted the whole coarse alignment stands (lag, capture, fit, offset together).
`list`; `sources` — per hosted source `{id, kind, path, ready,
paused, loop, speed, time_pos, duration, gain_effective_db (graph), gains (the live
source's own slots), live_kind, size, mpv_volume_gain, mpv_pause, requests_in_flight,
stepped, step_status, virtual_t, last_event}` + `dying` (sources mid-teardown),
`reaper_pending` (`mpv_*` are synchronous mpv reads — probe
only); `loop` — `{clock, tick_period_ms, ticks, tick_hz_last_s, last_tick_ms,
recent_ticks_ms, max_tick_ms_recent, last_phases {sync_ms, transitions_ms, render_ms,
total_ms}, max_busy_ms (longest synchronous stretch since the last
`args: {"reset": true}` — a tick, a step, the post-dispatch sync, or one client's requests; before
the speed storm request handlers were left out), max_request_ms + max_request_cmd (the slowest single
request handler and its verb, same reset), max_busy_excl_open_ms + max_open_ms (the same with the
loop's share of source opens taken out / that share alone — render context + props +
`loadfile`; the core itself is made on the `lp-open` worker, § Sources), iterations, wakes, wake_pending, wake_fds, clients,
subscribed_topics, tap_dropped, reaper_pending, uptime_ms, gain_timer_armed, gain_ticks,
gain_pushes, pause_gates, dropout_windows_open, bounds (§ Runtime "Bounds"),
recent_gain_pushes}`; `sources` also has `mpv_current_ao` and top-level `opening` + `open_pool`
`{cap, workers, running, queued, peak, skipped, pending}` (the `lp-open` pool, § Sources "Async
opens"); `frames` (Task 13,
`probe/frames.rs`) — `{backend, policy (content|every_tick), window_ms (2000),
explicit_sync ({env, value, source: policy|env}, null headless — Task 20e),
default_queue_dispatched (events from libwayland's default queue; null headless), outputs:
[{name, hz, refresh_mhz, period_ms, idle, frame_pending, since_present_ms, paced {count,
mean_ms, p50_ms, p95_ms, max_ms, missed}, all {… + fps}, totals {presents, callbacks,
missed, idle_gaps}}]}`, `args: {"reset": true}` clears the windows after reading (§
Wayland → Frame pacing; Task 16 adds `totals.present_failed`, `last_present_error`,
`retry_in_ms`); `bus` and `meter.window` (§ Audio bus); `dropout` (Task 15,
`probe/dropout.rs`) — `{corr, dump?}` → `{status: "pending", corr}`, the reference-based
dropout detector's result following as a `probe.dropout {corr, report}` event (never
deferred like `step`'s reply; `docs/player/debugging.md`). Task 16d: the analysis runs
only once the meter has captured the whole window (`done + WINDOW_POST +
CAPTURE_MARGIN`, queued in `Runtime::dropout_due` and started from `tick` — the debug
auto-trigger used to snapshot at `transition.done` and never saw the post-roll); the
meter is binned on `expected`'s own grid (never the absolute 10 ms one — the window's
sub-10 ms phase skewed every lag), coarse bins are power means of the 1 ms envelope, and
the lag is refined to 1 ms (R96, ±10 ms) before drops/micro-gaps; `dump` (absolute path)
writes every analysis input + the report as JSON for offline replay; `memory` (Task 20b,
`probe/memory.rs`) — `{proc {rss_kib, hwm_kib, rss_anon_kib, rss_file_kib, threads},
malloc {arena_bytes, mmap_bytes, mmap_chunks, in_use_bytes, free_bytes,
top_releasable_bytes, arenas}, policy {applied, mmap_threshold, trim_after_reap, trims,
trim_ms_total, trim_ms_max, allocator (glibc|other), mmap_threshold_source (policy|env|null),
env_unknown_value}, transitions_done_total (monotonic switch counter), live_sources,
dying_sources, opening, reaper_pending (0 only after the batch's trim)}`,
`args: {"trim": true}` adds `trim {released, ms, proc_after, malloc_after}` — that trim runs on
the LOOP thread (debug probe; with hundreds of MiB retained it can drop a frame) (§ Memory);
`sources` also has `mpv_hwdec_current` (what `hwdec: auto` resolved to) and `mpv_hwdec` (what we
asked for — copy modes, Task 20d); `snapshot` (Task 16,
`probe/snapshot.rs`) — `{path, writes, failures, last_write_ms, since_last_write_ms,
due_in_ms, frozen, current (what would be saved now)}`. `sources` also has
`mpv_audio_device` / `mpv_audio_delay` (what mpv really runs). A new probe = a file here +
one `PROBES` entry.

**Isolation (`api/server.rs`).** Non-blocking, edge-triggered client sockets; per wake a
client gets ≤ 256 KiB read and ≤ 32 requests handled (the rest next iteration, round
robin); a line over 1 MiB → `bad_request` + close; garbage JSON → `bad_request` (kept); a
peer EOF still gets every queued reply before the close; > 16 MiB of unsent output (a
dead/slow subscriber, or a client not reading replies) → dropped with
`api.client_dropped {client, reason}`. The tap buffers ≤ 50 000 events between iterations
(oldest dropped, `tap_dropped`). `bad_client_isolated` pins all of this (the good client's
worst reply stays < 500 ms during a 40 000-request flood).

**Debugging with `ctl` (AI recipe).**
1. `ctl state` — what is on each output (`lay:<c>:main.content`, `cur:`), every source's
   `ready/paused/time_pos/gain_effective_db`, live `transitions` (phase, held).
2. `ctl logs '{"corr":"tr-12"}'` — one operation's whole story (a transition's
   scheduled→started→handoff→done, or where it stopped: `cancelled`/`failed {reason}`);
   `ctl logs '{"min_level":"warn"}'` for everything that went wrong.
3. `ctl probe '{"name":"sources"}'` — what each live source actually runs (mpv's real
   `volume-gain`, `pause`, unanswered requests, step status); `ctl probe '{"name":"loop"}'`
   — is the loop ticking at the refresh, how long ticks take, did anything stall it.
4. `ctl capture '{"target":"out:DP-1","path":"/tmp/x.png"}'` — look at the picture.
5. Reproduce deterministically: `serve --headless --clock stepped --ao null`, replay the
   commands, `step`, `capture`.
6. Audio specifically (a dropout, a glitchy fade): `docs/player/debugging.md` — symptom →
   probe/log query → likely cause, seeded with the bugs the reference monitor
   (`probe dropout`, Task 15) found in the legacy engine, plus `meter.window`/`bus`.

## Wayland

`src/wl.rs` + `src/redraw.rs` + `src/probe/frames.rs` (spec §4.2 "Output", §5.1
"Graphics"; Task 13). `lp-player serve` without `--headless` draws the wallpaper on every
monitor of `$WAYLAND_DISPLAY` (a `wlr-layer-shell` compositor: Hyprland, Sway, …).

**Backend.** `Wayland::connect()` (sctk 0.21, `default-features = false, features =
["calloop"]` — no xkbcommon, a keyboard is never used) binds `wl_compositor`,
`zwlr_layer_shell_v1` (missing → `Err` naming the compositors that have it and
`--headless`), `wp_cursor_shape_manager_v1` (optional), sctk's `OutputState`/`SeatState`,
then does two roundtrips (output info → surfaces created; first configures). Then
`Gfx::new_wayland(display_ptr)` — **one EGL context for every output and every source**
(R17 `Rc<Shared>`; mpv renders through it as before). The event queue goes into the loop as
a `calloop_wayland_source::WaylandSource` (it flushes + `prepare_read`s before each sleep,
so events EGL's own queue reads off the socket are never stranded); its callback dispatches
into `Wayland::state` via `as_wayland_mut`, and `process` dispatches libwayland's default
queue — EGL's proxies — every iteration (Task 20e, NVIDIA notes below). **sctk handlers only record** (outputs,
configures, frame callbacks, pointer); GPU work and graph changes run after the dispatch:
`apply_output_changes` (`backend.process(gfx)` → hotplug), `pointer_events`, `render_paced`.

**One surface per `wl_output`** (`WlState::make_surface`):

| what | value |
|---|---|
| namespace | `lp-player` (`hyprctl layers`) |
| layer | `out:<c>.layer` (`background` default, `bottom`, `top`, `overlay`) — **live**: `set_layer` + a bare commit (layer-shell v2+, surface mapped); on v1, or while the surface isn't mapped yet (no configure / no window target), the surface is **re-created** on the new layer — on Hyprland 0.56 a `set_layer` before mapping was lost (a re-plugged output's remembered layer stayed background; measured, Task 16) |
| anchor / size | all four edges, size 0×0 → the compositor's configure size (× integer `wl_output` scale via `set_buffer_scale`) |
| exclusive zone | −1 (covers the whole output, ignores bars' zones) |
| keyboard | none |
| input region | default = the whole surface (pointer accepted) |
| opaque region | the whole surface (every pixel is written with alpha 1) |

Names come from `wl_output` v4 `name` (`output_name`: `.`/`:`/`*`/spaces → `-`; none →
`WL-<global id>`); size = the current mode rotated by the transform (`oriented_dims`);
`refresh_hz` = the current mode's mHz rounded (`hz_from_mhz`: 143 981 → 144, 239 760 →
240, 0 → 60), `refresh_mhz` exact. A size from the first configure that differs (scale) →
`OutputChange::Changed`. Fractional scaling (`wp_fractional_scale_v1` + viewporter) is not
implemented: a fractional output renders at the ceiling integer scale (the owner's
outputs are scale 1). Pure mappings are unit-tested in `wl.rs`.

**Rendering + present.** Each output owns an offscreen RGBA8 texture + FBO (`target`:
`Composer::compose_output` draws there; also `picture` → `capture`) and a `WindowTarget`
(swap interval 0) built in `process(gfx)` once the surface is configured (resized in place
on a new size; a failed build isn't retried at the same size). `present`: make the window
current, disable scissor + full viewport (compose leaves them at its last sub-rect),
`glDrawBuffer(GL_BACK)`, blit FBO → back buffer, clear **alpha only** to 1 (the composite
is premultiplied over transparent black, so its RGB already is the picture over black),
request a frame callback, `eglSwapBuffers` (= attach + full damage + commit). The output
is `ready` (`FrameState`) again when that callback arrives.

**Failed presents (Task 16, review c).** `wl_surface.frame` is double-buffered state that
rides on the next commit, which `eglSwapBuffers` makes — so it has to be requested before
the swap. A swap that fails makes no commit and leaves that request pending: the output
keeps it **armed** (`WlOut::frame_armed`, cleared by the callback or a successful swap) and
never requests a second one; `frame_pending` is set only once a swap succeeded. A failed
present (`make_current` or swap) backs off — `present_backoff`: 100 ms after the first,
then 1 s while it keeps failing (`frame_state.ready` is false meanwhile, `retry_in_ms`) —
and is logged rate-limited (`output.present_failed`, ≤ 1 per 5 s per output with
`suppressed`); the `frames` probe shows `totals.present_failed`, `last_present_error`,
`retry_in_ms`. **Resize (review d):** the FBO/texture re-create on a new size makes the
window's context current explicitly first (on failure the old targets are kept, the size
marked failed); a new window target is current from `set_swap_interval` on.

**Frame pacing + redraw policy (decided — `redraw.rs`).** Every output presents on its own
frame callbacks at its own refresh; nothing waits on another output. An output that can
take a frame is drawn only if, since its last present: `Graph::picture_rev` moved (any
create/destroy/non-gain set other than the Animator's — conservative, wakes every output
once), an **animated value changed on a node it shows** (the Animator's per-tick sets go
through `Graph::set_animated`, which doesn't move `picture_rev`; `Redraw::mark_nodes` marks
only the outputs whose `shown_nodes` — `out:<c>`, its main layer, that layer's content
(source or effect), the effect's sides — contain the animated node, so the final value is
drawn too), a source it shows has a new texture (`SourceHost::take_changed`), the backend
asked (configure/resize/re-created surface), **or something animates on it**
(`animating_on`: a started, unfinished, non-gain animation on one of its `shown_nodes` —
transitions, opacity ramps): then it presents on *every* callback, even between two
animator ticks. **Per output (Task 16, review a):** an animation on DP-1's layer never
wakes DP-2 — before, one global "animating" flag (and the animated sets' `picture_rev`
bumps) presented every output at its refresh. Otherwise it is **idle** — no frame drawn,
no callback requested, `frames` probe `idle: true` — so a static colour or image costs
nothing, and a playing video presents at its own frame rate (each frame at the next
refresh — same latency as redrawing every vblank, without the duplicates). Headless keeps
composing every tick (`paced() == false`) unless `--redraw-policy content` (then it uses
this policy with every output always able to take a frame — no frame callbacks, so an
animating output presents on every loop pass; `mixed_content_static_output_stays_idle`).

**Idle animator timer (decided: keep).** The R47 tick timer keeps ticking at the max output
Hz even when every output is idle: ≈ 23 µs per idle tick (measured, Task 13), ~0 % CPU.
Stopping it when nothing animates would need every animation start, transition phase,
step and stop deadline to re-arm it — more ways to stall than it saves.

**`frames` probe** (`probe/frames.rs`, rolling 2 s windows per output): `paced` = intervals
between presents made back to back (the second drawn on the first one's callback, no idle
in between) → mean/p50/p95/max/count + `missed` (> 1.5 refresh periods); `all` = every
interval + `fps`; `idle`, `frame_pending`, totals (`presents`, `callbacks`, `missed`,
`idle_gaps`). Measured on the owner's machine (`outputs.sh`, release build, background
layer, the owner's windows covering it):

| source (two runs) | DP-1 (143.981 Hz) paced mean / p95 / max | DP-2 (239.76 Hz) paced mean / p95 / max |
|---|---|---|
| opacity animation | 6.942, 6.946 / 7.77, 7.24 / 9.9, 8.1 ms; 0, 0 missed of 288 | 4.169, 4.171 / 4.78, 4.42 / 6.7, 5.5 ms; 3, 0 missed of 480 |
| 240 fps test clip | 6.945, 6.947 / 7.93, 7.67 / 14.5, 8.4 ms; 3, 0 missed | 4.203, 4.176 / 4.91, 4.51 / 11.5, 5.6 ms; 4, 0 missed |
| 60 fps test clip | 60.0 presents/s (content-paced, idle between frames) | 60.0 presents/s |
| static colour | idle, 0 presents/s | idle, 0 presents/s |
| mixed (Task 16): 60 fps clip on DP-1, static colour on DP-2 | 62–64 presents/s | idle, 0 presents in 1 s |
| mixed + opacity animation on DP-1's layer only (two runs) | 6.944, 6.943 / 7.95, 7.86 / 8.5, 8.6 ms; 0 missed of 288 | idle, 0 presents in 2 s |

(Run 1 ran while another lane's test suite was busy on the machine — its outliers.)
Hyprland keeps sending frame callbacks to fully covered surfaces (a full-screen top-layer
surface on DP-1, a fullscreen window on DP-2): pacing above was measured that way.

**Hotplug.** A new `wl_output` → a surface + `OutputChange::Added`; a removed one →
`Removed`, its GPU side moved to a dead list and freed in `process` with the context made
current **surfaceless** (`Gfx::make_current_surfaceless`, so `eglDestroySurface` is immediate
and the FBO/texture deletes have a context), window target before its `wl_surface` (field
order `gl` then `surface`). A `closed` layer surface whose output stays is re-created
(`wl.surface_recreated`). The runtime runs the **same** add/remove path as headless
hotplug (§ Runtime → Outputs: R59 adopt into a live transition, else `cur:` of the first
output that has one — the same-wallpaper default the brief asks for —, else unpark; R60
retire/park), plus `redraw.forget` + fresh `FrameStats`. A re-plugged connector gets its
remembered output props back (`layer` …, Task 16 — before, it came back on `background`);
a connector never seen starts at the defaults. Verified on-machine: `out:DP-1.layer =
bottom` → unplug → replug → `bottom`, hyprctl level 1.

**Pointer.** sctk `PointerHandler`: enter/leave/motion/press/release on our surface →
`PointerSample {output, x, y, buttons}` (surface pixels = logical × scale; buttons: bit 0
left, 1 right, 2 middle, 3 side, 4 extra; leave clears buttons, keeps x/y) → the runtime
`set_observed`s `out:<c>.pointer` (never a picture change, never forwarded to sources yet —
Phase 2's mouse-reactive scenes read it) and `input.pointer {output, event, x, y, buttons,
button, suppressed}` is logged at debug (motion ≤ 10/s per output; `suppressed` counts the
rest). On enter the cursor is set to the default shape (`wp_cursor_shape_v1`), else the
compositor keeps whatever cursor it had. Axis events are ignored.

**NVIDIA / EGL notes (595.84, egl-wayland2 1.0.2, Hyprland 0.56.2 — measured).**
- **`glDrawBuffer(GL_BACK)` before writing FBO 0.** `Gfx::new_wayland` makes the context
  current surfaceless first; per `EGL_KHR_surfaceless_context` the default framebuffer's
  draw/read buffers then start as `GL_NONE` and stay so when a window surface is bound —
  every blit/clear to FBO 0 was silently dropped (back buffer read back `[0,0,0,0]`, the
  surface showed nothing, no GL error). `present` sets it every time.
- **`eglCreatePlatformWindowSurface` attrib list must be `ATTRIB_NONE`-terminated**:
  khronos-egl rejects an empty slice as `EGL_BAD_PARAMETER` (the Task 7 code passed `&[]`;
  fixed in `Gfx::window_target`).
- **Swap interval 0** on every window (`WindowTarget::set_swap_interval`): with the
  default 1, `eglSwapBuffers` on the 144 Hz output would block the single loop thread and
  drag the 240 Hz output down; pacing is ours (frame callbacks).
- **Explicit sync is off by default (Task 20e) — it leaked a queued event per present.**
  With it on, egl-wayland2 binds `wp_linux_drm_syncobj_manager_v1` (+ `wp_fifo_manager_v1`,
  `wp_commit_timing_manager_v1`) and sets acquire/release points per swap (seen with
  `WAYLAND_DEBUG=client`). **egl-wayland2 ≤ 1.0.2** (NVIDIA 595's) then keeps each
  swapchain's `wl_buffer`s on a per-swapchain event queue (`EGLSurface(<id>/<ptr>)`) that it
  only dispatches *without* explicit sync — and Hyprland sends `wl_buffer.release` for every
  present anyway, so one ~224 B `wl_closure` per present stayed queued for good, allocated by
  our own `wl_display_read_events` (heaptrack: all the growth under `wl_closure_init` ←
  `wl_connection_demarshal` ← `wl_display_read_events` ← `WaylandSource::before_handle_events`).
  Measured 224.1 B/present (colour fade, 384 presents/s), the 1 h live soak's ~2 MiB/min of
  in-use heap (1080p60 + 24 fps content on two outputs; minutes without a switch grew as
  fast — per present, not per switch). Upstream's fix (egl-wayland2 6235dd8, after 1.0.2)
  moves those buffers to libwayland's **default queue** — which wayland-rs never dispatches
  (all its proxies live on its own queue), so with that build the leak was the same
  (224.4 B/present, built from upstream main) until we dispatch it too. Two parts, both in
  `wl.rs`: **(1)** `apply_driver_env` (first thing in `serve`, Wayland only, before any
  thread — it `setenv`s): `__NV_DISABLE_EXPLICIT_SYNC=1` unless the caller set it (a set
  value wins; `0` keeps explicit sync); egl-wayland2 then waits for the GPU at each swap
  (`glFinish` — the compositor is on an NVIDIA GPU, so no implicit sync) and dispatches its
  swapchain queue itself. Cost, two outputs 240/144 Hz mid-crosswarp (two runs): loop tick
  p99 0.13–0.32 → ~1.6 ms, max 0.7–2.2 → 2.3–3.5 ms (< the 4.17 ms budget), 0 missed frames,
  same CPU; 240 Hz interval p95 4.7–4.8 → 5.0–5.4 ms. **(2)** `Wayland::dispatch_default_queue`
  (`wl_display_dispatch_pending`, step 0 of `process`, every loop iteration): what a normal
  libwayland app does in its main loop and EGL relies on; events on proxies without a
  listener are just freed. With explicit sync off nothing lands there per frame
  (`default_queue_dispatched` stays 0). Cells (B/present): 1.0.2 + explicit (before) 224.1;
  1.0.2 + off (default now) −0.0; upstream main + explicit, no drain 224.4, with drain 0.1;
  1.0.2 + explicit kept by the user 224.1 — a driver bug we can't reach (the queue pointer is
  egl-wayland2's), hence the default. When the driver ships an egl-wayland2 with 6235dd8,
  `__NV_DISABLE_EXPLICIT_SYNC=0` brings explicit sync back leak-free. `wl.driver_env {env,
  value, source: policy|env}` (info) at startup; `frames` probe `explicit_sync` (same
  object) + `default_queue_dispatched`. Guard: `tests/api.rs::
  t20e_wayland_present_heap_stays_flat` (opt-in `LP_PLAYER_TEST_WAYLAND=<socket>` — it draws
  on that compositor for ~25 s; SKIP otherwise): a 60 s colour fade on every output, heap
  growth per present over 10 s < 32 B (GREEN 2.3 ×2; RED with `__NV_DISABLE_EXPLICIT_SYNC=0`
  226.6 B/present). **Damage:** every present redraws the whole surface and `eglSwapBuffers`
  posts full damage — no buffer-age/partial damage.
- The EGL config has alpha 8, so the buffer is ARGB: alpha is forced to 1 at present (and
  the opaque region set) so the compositor never blends what's below the wallpaper.

**`tests/onmachine/outputs.sh` (run manually, exit 0 = pass; Hyprland + DP-1/DP-2 by
default, `OUT_A`/`OUT_B`/`HZ_*`/`MEAN_*`/`TOL_MS` to adapt).** Builds the release binary
(or `LP_PLAYER_BIN`), makes synthetic ffmpeg clips, stops the legacy wallpaper (`/stop`,
waits for no `mpvpaper`), then runs `serve --ao null` with a **private
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME`** (its own socket + instance lock — lanes running
`serve --headless` are unaffected) and an **absolute** `WAYLAND_DISPLAY`
(`$XDG_RUNTIME_DIR/wayland-1` of the session; `hyprctl`/`grim` keep the real runtime dir).
Checks: `hello.backend == wayland`; `out:DP-1` 144 Hz, `out:DP-2` 240 Hz; our namespace on
the background level (`hyprctl layers -j`); red/blue `lay:<c>:main.content` → `out:*.layer
= overlay` (the owner's windows cover the background) → `grim -o <c>` centre pixels →
pointer (cursor warped over DP-1 → `out:DP-1.pointer` = `[960,540,0]` then `[100,200,0]`,
`input.pointer` enter+motion) → back to `background`, level verified; static colour idle;
pacing with an opacity animation and a 240 fps clip (6.9 ± 0.5 / 4.2 ± 0.5 ms, ≥ 50
samples); a 60 fps clip ≈ 60 presents/s; hotplug: `hyprctl eval 'hl.monitor({ output =
"DP-1", disabled = true })'` (this Hyprland has a Lua config: **`hyprctl keyword` is
refused** — "keyword can't work with non-legacy parsers. Use eval." — and re-enabling needs
an explicit **`disabled = false`**) → `out:DP-1` gone, player alive → re-enabled with the
**recorded** mode/position/scale (never `preferred,auto`) → `out:DP-1` back showing
`cur:DP-2` with its remembered `layer` (`bottom`, set before the unplug), pixel verified,
layout identical to the record; **mixed content** (Task 16: 60 fps clip on DP-1, colour on
DP-2 → DP-2 idle, then an opacity animation on DP-1 only → DP-1 paced 6.9 ms, DP-2 still 0
presents); **crash → restart** (`kill -SEGV` the compositor child → `hello` from a new pid
≤ 1.5 s — measured 151/164 ms — both outputs restored, pixels verified, background level
again); `ctl quit` → exit 0. `serve` runs supervised: `SERVE_PID` is the supervisor,
`PLAYER_PID` (`hello.pid`) the child that owns the surfaces (layer checks use it). It runs
under `prlimit --core=1:1`: RLIMIT_CORE 1 makes the kernel skip the piped core handler
(with 0, systemd-coredump still runs and DrKonqi pops a crash notification). Pixel checks
fall back to the (¼ w, ¾ h) pixel if the centre is covered (the owner's shell put a
notification popup over DP-2's centre on the overlay level). **Safety:**
an `EXIT` trap restores the focused monitor + cursor, kills `serve` (no lp-player layer may
remain — checked), re-applies any monitor that differs from the record with its exact
values and verifies `hyprctl monitors -j` matches, and moves workspaces back to their
recorded monitors. Socket paths must stay < 108 bytes: the script uses `mktemp` in
`$TMPDIR`/`/tmp`, not a long scratch path.

## Audio bus

`src/audio/` (spec §5.3 "(my call) Player audio bus", §4.4 auto-mute; Task 14). Every
wallpaper's audio goes to one in-process PipeWire loopback sink owned by the player — the
**bus** — forwarded at 0 dB to the user's current default sink (EasyEffects chains keep
working); the **meter** captures the bus monitor: exactly what the wallpapers output, and
nothing else (the dropout detector, Task 15, and auto-mute's self-exclusion, Task 17).

```text
 mpv src1 (audio-device=pipewire/lp-player-bus) ─┐
 mpv src2 ─────────────────────────────────────┼─▶ lp-player-bus ──(same cycle)──▶ lp-player-bus.playback ──▶ default sink
    …                                          ─┘   Audio/Sink        loopback      Stream/Output/Audio          (re-targeted on
                                                        │                            node.target = default         default.audio.sink
                                                        └─ monitor ──▶ lp-player-bus.meter (capture, the Meter)   changes)
```

**Identity contract (Task 17's auto-mute excludes the bus by it — verbatim):** playback
stream `node.name = lp-player-bus.playback`, `application.name = lp-player`, `media.role =
Wallpaper`; sink `node.name = lp-player-bus`, `node.description = "lp-player bus"`,
`media.class = Audio/Sink`, `audio.position = [FL FR]`. Constants in `audio::bus`
(`PLAYBACK_NAME`, `APP_NAME`, `MEDIA_ROLE`, `SINK_NAME`, `SINK_DESCRIPTION`). The meter is
`lp-player-bus.meter` (a capture stream). Note mpv streams also carry `application.name =
lp-player` (`audio-client-name`) — auto-mute must exclude by ownership/target, not that name
alone (spec §4.4).

**`Bus::create()`** (serve startup only; measured ~0.2 s, `Err` after 10 s — the thread
stops at its next wait): thread `lp-bus` runs its own
PipeWire main loop + context + core (nothing uses `RT_PROCESS`: every callback runs on that
thread; capture buffers carry their cycle time, `pw_buffer.time`). Two roundtrips (globals,
then the `default` metadata's properties) → `default.audio.sink` → `pw_context_load_module(
"libpipewire-module-loopback", args)` (declared by hand — not in pipewire-sys's
`wrapper.h`) with `capture.props = {media.class = Audio/Sink, node.name = lp-player-bus,
node.description = "lp-player bus", audio.position = [FL FR]}` and `playback.props =
{node.target = target.object = <default>, identity…}` → waits until the playback is linked
to a sink → **latency** → `Ok`. `Bus::device()` = `pipewire/lp-player-bus`;
`Bus::state()` = `Up | Retargeting | Down`; `Bus::info()` = everything the `bus` probe shows.
`LP_PLAYER_BUS=off` disables it.

**Re-target.** The bus thread watches `default.audio.sink` (a default naming the bus itself
is ignored — it would loop) and moves the playback the way pavucontrol does: default
metadata `target.node` (node id) + `target.object` (serial, `Spa:Id`) on the playback node
→ WirePlumber relinks (metadata beats the node's own `node.target`). `audio.bus.retargeting
{from, to}` → (link to `to` seen in the registry) `audio.bus.up {device, latency_ms, target,
from, retarget_ms}`; not linked within 3 s → `audio.bus.retarget_failed {to, linked}`
(warn; not retried until the default changes again). **Driven by "last requested vs
default", never by the momentary link set:** links churn while WirePlumber relinks, and
other clients' captures of the playback are links too — the legacy AudioMonitor's `parec`
attaches to every sink-input, and counting it re-issued retargets in a loop (found here;
`Seen::linked_targets` counts `Audio/Sink` nodes only). **Session policies win, never
fought.** On this machine EasyEffects 8.2.9 ("process all output streams") re-writes
`target.object` = its sink on *every* output stream the moment anyone moves it (verified
with a plain `pw-cat` stream: moved to any other sink, it's back on `easyeffects_sink`
within ms). Fighting that (re-issuing because "not linked to the default") oscillated. The
bus tracks every `target.object` write on its playback in order (`Seen::meta_events`): its
own write echoes back first; a later different value is another client's → `audio.bus.moved
{requested, target (that client's choice), linked_now}` (warn), `bus` probe `overridden:
true`, `target` = where it really is, and no retry until the default changes again (a
retarget in flight completes as `audio.bus.up {requested, target, overridden: true}`).
Someone moving it by hand (pavucontrol) is the same case. WirePlumber's
`linking.follow-default-target = true` (this machine) also moves a stream whose metadata
target was the default when the default changes, so a retarget back often completes at
once (`retarget_ms` ≈ 0). Measured: relinked 25–107 ms after `pactl set-default-sink`;
the meter's largest gap across it 28–30 ms (the bus subgraph changes driver; one 1 ms block
of the bus may come out quiet then — `bus.sh` prints the count).

**WirePlumber state opt-out (found in this task).** WirePlumber's `state-stream` keys
saved volumes/targets by `application.name` — the same key (`Output/Audio:application.name:
lp-player`) as every mpv source. Without care, our metadata re-targets were saved as a
"user choice" target and would be restored onto any later lp-player stream without its own
target (e.g. mpv in the fallback), pinning it to a stale sink. Every bus stream therefore
carries `state.restore-props = false` + `state.restore-target = false` (the bus also
always starts at 0 dB). `bus.sh` asserts no `target` gets saved. Don't set
`application.id` on the context: it changes the key.

**Latency rule.** `Bus::latency()` = what the bus adds, measured once at creation with an
impulse: a probe stream plays one −60 dBFS sample (inaudible) into the bus while two
captures watch the bus monitor (`stream.capture.sink`) and the bus playback's *output*
(`target.object = lp-player-bus.playback` — WirePlumber links stream→stream); both are
checked wired correctly first (else both would see the same signal and read 0), the
arrival-time difference (same graph cycles → same clock) over 3 shots, median kept;
`audio.bus.latency_shots {shots_ms, quantum_frames}` (debug). **Measured on this machine
(PipeWire 1.6.9): 0 samples** — module-loopback triggers its playback from the capture's
process (same cycle); the method reads an injected `target.delay.sec = 0.010` as
9.999997 ms, so 0 is real. Gate (brief): ≤ 1 quantum + 5 ms. Sources get `audio_delay_bias
= −latency` at open (§ Sources: the source's own `audio_delay` **adds** to it), so a
non-zero bus latency on another PipeWire would be compensated; today it's 0.

**Meter.** `Meter::start(&bus)` (a capture stream on the bus thread: 48 kHz F32 stereo,
`node.latency = 480/48000` — a 10 ms *request*; the graph runs at the smallest request, on
this machine 64 frames because the owner's Quickshell asks for it). `dbfs_1ms` = per 1 ms
block (48 frames) the **max-channel** RMS (each channel's RMS, loudest wins — a mono sum
cancels anti-phase content and reads a one-sided channel 6 dB low, a fake dip for a dropout
detector), `20·log10`, floored at `units::SILENT_DB` (−96); a full-scale sine reads −3.01.
Ring: 4 min (240 000 entries) of `(t_mono, dbfs_1ms)`; `t_mono` is the **`t_mono_ms` clock**
(`log::mono_start()`; block time = its cycle's `pw_buffer.time` + its first frame's offset).
The callback never blocks (staging buffer + `try_lock`). `Meter::window(from, to)`,
`Meter::available()` (streaming, newest sample ≤ 500 ms old, no error), `Meter::status()`.

**Probes.** `bus` → `{state, device, latency_ms, latency_samples, quantum_ms, target,
default_sink, requested, overridden, playback_node, sink_node, retargets, reason, now_ms,
meter {available,
streaming, samples, last_ms, quantum_frames, dropped, error}}` (`now_ms` on the `t_mono_ms`
clock). `meter.window {last_ms} | {from_ms, to_ms} [, samples: false]` → `{from_ms, to_ms,
count, median_db, min_db, max_db, max_gap_ms, first_ms, last_ms, samples: [[t_ms, db]…]}`;
an unavailable meter is an **`unsupported` error saying why** (never an empty "all quiet").

**Fallback.** `--ao <anything but pipewire>` → no bus (`--ao null` would only add a sink to
the owner's session for nothing). `Bus::create` failing (PipeWire unreachable, module
missing, never linked) → `audio.bus.down {reason}` (warn), sources keep mpv's default
device (no `audio_device`, no bias), the meter is unavailable. Both are logged exactly
once; `ctl probe '{"name":"bus"}'` says why. **A connection lost later is re-created (final
review I7):** the `lp-bus` thread runs the bus as *sessions* (`bus::session`) — a core error ends
one (`audio.bus.down {reason}`; the loopback module is *not* destroyed by us then: it unloads
itself on a core error, and destroying it too was a measured double free), sources are re-routed
to mpv's default device (`Bus::route()` = `(up, generation)`, polled by `Runtime::
track_bus_route` every tick → `SourceHost::set_audio_route`, `audio.bus.sources_rerouted`), and
the bus retries with backoff (0.5 s, doubling ≤ 10 s; `audio.bus.reconnecting {attempt}`,
`.reconnect_failed {reason}`) until a new session is up (`audio.bus.up {reconnected: true,
generation}`; latency re-measured; the meter's capture stream re-created on the same
`MeterShared`) — then every source goes back onto the bus with its ramp-in held on `gain.pause`
until its rebuilt audio chain flows (invariant #8). The first session's setup failing is still
`Bus::create`'s error (no bus for the process — the fallback above). Shutdown: `Runtime::shutdown` destroys every source first, then
`Audio::close` (`audio.bus.down {reason: "shutdown"}`), so no stream is moved to the default
sink on the way out; a killed player's sink goes with its PipeWire connection.

**Tests.** `tests/api.rs::bus_down_falls_back_to_default_device` (PipeWire made
unreachable: empty `PIPEWIRE_RUNTIME_DIR` + bogus `PIPEWIRE_REMOTE`; image source, so
silent), `ao_null_runs_without_bus`, **`i7_bus_reconnects_after_pipewire_restart`** — a
*private, hermetic* PipeWire + WirePlumber (`PrivatePw`: own runtime/config/state dirs, no
D-Bus, WirePlumber's `policy` profile so no ALSA/Bluetooth/V4L2 monitor ever opens a device,
one null sink; skipped without the binaries; the owner's PipeWire is never touched): tone on
the bus → both daemons killed → `down` + sources on `auto` → restarted → `up {reconnected}` +
sources back on `pipewire/lp-player-bus` with a live AO, the tone on the bus again, the ramp-in
`onset.started {slot: pause, reason: flowed}`; unit tests in `meter.rs` (RMS/floor/max-channel/
carry/ring/clock) and `bus.rs` (args, default parsing). **On-machine: `bash
src/player/tests/onmachine/bus.sh`** (exit 0 = pass; real audio, R56): its own temp
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME` for the lp-player socket while PipeWire/Pulse reach the
real session (`PIPEWIRE_RUNTIME_DIR=/run/user/$UID`, `PULSE_SERVER=unix:/run/user/$UID/
pulse/native`), `--headless`, `WAYLAND_DISPLAY` unset (R55); stops a legacy mpvpaper first;
a `trap … EXIT` restores the default sink exactly and checks no `lp-player-bus` sink is left
(R57), deletes every `target.node`/`target.object` metadata entry on the nodes serve owned
(live ones before quitting, dangling ones after — never an id another node reuses) and, if
WirePlumber ever saved a `target` for lp-player, clears it (silent stream + `target.object
-1`) — so a failed or interrupted run never leaves routing changed (verified with a SIGTERM
mid-retarget). It checks the identity (pw-dump + `pactl list sink-inputs`), `pw-link -l`,
the latency gate, a 440 Hz −20 dBFS clip's meter median (−23 ± 3; measured −22.98…−23.03),
the source's mpv device/delay, `default_sink_change_retargets` and the WirePlumber state.
**`default_sink_change_retargets`** first learns the session's policy with a control
stream (a silent `pw-cat` moved to the new sink by metadata): no policy → the bus must be
linked to the new sink and stay; a policy (here: EasyEffects) → the bus's links to the new
sink must be *created* within 1 s (caught by a `pw-link -m -l` capture: the policy
re-points it within ms, faster than polling `pw-link -l` can see), then `audio.bus.moved`
to the policy's sink + `overridden` reported. Both: exactly one `audio.bus.retargeting` per
default change (no fight), `audio.bus.up {requested}` ≤ 1 s, meter gap ≤ 50 ms across it
(measured 8–34 ms), and back to the original default within 1 s.

## Supervisor

`src/supervise.rs` + `main.rs` (spec §4.1 "Supervision"; Task 16, R72/R73). `lp-player
serve …` **is the supervisor** unless `--no-supervise`: before any thread, GL context or
PipeWire connection exists it fork+execs `/proc/self/exe serve --supervised [--restore]
[--restarted <spec>] <the user's options>` (argv[0] kept; the child sets its comm back to
`lp-player` — exec of `/proc/self/exe` would make it `exe`), then only waits and forwards
signals. It never binds the socket or takes the instance lock (the child does, as before),
never touches EGL/PipeWire, has no socket. `/proc/self/exe` means a restart runs the same
binary as the supervisor even after a rebuild replaced the file.

- **Child setup (between fork and exec):** empty signal mask (the supervisor blocks
  SIGCHLD/SIGINT/SIGTERM for `sigtimedwait`), `PR_SET_PDEATHSIG(SIGTERM)` then `getppid()`
  re-checked — a supervisor killed outright (SIGKILL) never leaves an orphan player: the
  child gets SIGTERM and quits cleanly.
- **Startup-failure classes (Task 16b) — two, never conflated.** `ServeError::Startup`
  (exit **1**): another instance already holds the lock, or the socket/state dir is
  unusable — waiting never fixes either, so this is a **clean exit, never retried**
  (`classify`), same as 0/2. `ServeError::NoCompositor` (exit **`EXIT_NO_COMPOSITOR`**,
  5): the compositor/EGL genuinely isn't available *yet* — `wl::Wayland::connect`
  failing (no `WAYLAND_DISPLAY`, `wl_display` connect refused) or `Gfx::new_wayland`/
  `Gfx::new_offscreen` failing (EGL init before a GPU driver/device is ready). The two
  can look identical from outside (`lp-player serve --ao null` on a session starting
  before its compositor) but need opposite handling: "already running" burning the crash
  budget would just waste restarts on something a restart can't fix, while a hard exit 1
  on "not ready yet" would mean `lp-player` loses every boot race against its own
  compositor coming up a moment later.
- **Clean exits end supervision** (`classify`): child exit 0 (quit, SIGTERM/SIGINT), 1
  (`ServeError::Startup`, above), 2 (usage). The supervisor exits with the same code.
- **`EXIT_NO_COMPOSITOR` gets its own backoff, not the crash budget:** [`run`]'s loop
  retries with a doubling delay — `COMPOSITOR_WAIT_INITIAL_DELAY` 0.5 s, then 1 s, 2 s,
  4 s, … — logging `supervisor.waiting_for_compositor {pid, uptime_ms, delay_ms,
  waited_ms, budget_ms}` (warn) before each sleep, until the *next* delay would push the
  running total past `compositor_wait_budget()` (`COMPOSITOR_WAIT_BUDGET` 30 s in
  production; the test-only env knob `LP_PLAYER_TEST_COMPOSITOR_WAIT_MS` shortens it so a
  test doesn't really wait 30 s) — then `supervisor.giving_up {reason: "no_compositor",
  pid, waited_ms, budget_ms, hint}` (error) and exit `EXIT_GAVE_UP` (4 — the same code the
  crash-loop budget gives up with, distinguished by `reason`). Never counted against
  `Budget`'s 5-per-60s (no `supervisor.child_exited`/`.restart` logged for these
  attempts); a later real crash (`Exit::Abnormal`) resets the backoff streak back to its
  start, since it's an independent concern. Test: `tests/supervise.rs::
  gives_up_without_compositor_after_backoff` (a bogus `WAYLAND_DISPLAY`, the short test
  budget: 2 retries then give-up).
- **Crashes are restarted immediately:** death by a signal, a Rust panic (101),
  `EXIT_RUNTIME` 3 (the compositor connection was lost mid-run — `ServeError::Runtime`; if
  the compositor is really gone the restarted child gets `EXIT_NO_COMPOSITOR` instead,
  which the backoff above handles — never ends supervision outright), any other code. The
  new child gets `--restore` (restores the snapshot, § Snapshot) and `--restarted
  signal=N|code=N,count,total,died_ms,prev_pid,restore`, and logs
  **`supervisor.restart {signal|code, count, total, since_ms, prev_pid, restore}`**
  (warn) as its first event after the log opens (R73; `since_ms` = from the supervisor
  seeing the death, `CLOCK_MONOTONIC`, to that event). `hello.restart` repeats those fields
  — a client that reconnects after a restart (the backend adapter, Task 17) can't receive
  an event logged before it subscribed, so it reads `hello.restart` or `ctl logs
  '{"kind_prefix":"supervisor."}'`.
- **Budget:** 5 restarts per sliding 60 s (`Budget`); the 6th crash in the window →
  `supervisor.giving_up {signal|code, pid, restarts, window_s, hint}` (error) and exit 4.
  From the 4th restart in the window the child starts **without** `--restore` (a snapshot
  that crashes the player at startup must not take supervision down; `restore: false` in
  `supervisor.restart`).
- **Stop:** SIGTERM/SIGINT to the supervisor are forwarded to the child; it waits ≤ 10 s
  (`STOP_WAIT`; then SIGKILL, `supervisor.stop_timeout`) and exits with the child's status
  — never a restart. During the no-compositor backoff (no child) a SIGTERM/SIGINT ends it at
  once, exit 0, `supervisor.stopped` (`sleep_unless_stopped` = `sigtimedwait`, final review M9;
  `tests/supervise.rs::sigterm_during_compositor_backoff_exits_at_once`).
- **The supervisor's log lines** (`supervisor.child_exited {pid, signal|code, uptime_ms}`
  warn on every crash, `giving_up`, `stop_timeout`, `spawn_failed`) are appended to the
  shared `events.jsonl` with `log::append_detached` (one `O_APPEND` write per line, never
  rotates; `t_mono_ms` is the supervisor's own clock, `comp: "supervisor"`), plus one
  stderr line per restart / give-up.
- **A sent SIGSEGV/SIGBUS is a crash** (`make_sent_faults_fatal`, first thing in `serve`):
  Rust's runtime handles SIGSEGV/SIGBUS for its stack-overflow check and, for anything else,
  resets the handler and *returns* — a real fault re-faults and dies, but a `kill -SEGV`
  (si_code ≤ 0) was survived once (measured: the child kept running). Our handler re-raises
  a sent one with the default action and hands real faults back to Rust's handler.
- **Measured restart latency** (SIGSEGV → `hello` answers from the new pid): headless tests
  145–200 ms (`crash_restores`, `RLIMIT_CORE` 1), on-machine Wayland 151 / 164 ms
  (`outputs.sh`); `since_ms` 25–35 ms; the rest is the kernel tearing the old process down
  (+ ~200 ms more when systemd-coredump takes a core: 232–259 ms measured with cores on)
  and the new child's startup (~50 ms headless). On Wayland the old surfaces vanish with the
  old process, so the desktop behind shows for that ~0.2 s.
- **Test knob:** `LP_PLAYER_TEST_CRASH=startup` → every child logs `test.crash` and aborts
  right after `supervisor.restart` (`gives_up_after_5_in_60s`). Tests set `RLIMIT_CORE` 1
  for every spawned process: the kernel then skips a piped `core_pattern` entirely ("RLIMIT_CORE
  is set to 1, aborting core"); with 0, systemd-coredump still runs and the desktop's crash
  handler (DrKonqi) pops a notification per crash.
- **Tests** (`tests/supervise.rs`, supervised headless real clock): `crash_restores`,
  `clean_quit_not_restarted` (quit; SIGTERM to the supervisor; SIGTERM to the child),
  `gives_up_after_5_in_60s`, `gives_up_without_compositor_after_backoff` (Task 16b: bogus
  `WAYLAND_DISPLAY`, the short test budget — 2 retries then give-up, never the crash
  budget's own events), `corrupt_snapshot_starts_empty`,
  `transition_in_flight_restores_as_b`, `parked_restores_parked`,
  `output_props_survive_replug`, `supervisor_sigkill_reaps_child_fast` (Task 16b: SIGKILL
  the supervisor, assert the compositor child is gone within 300 ms — asserted directly,
  no fallback kill of ours in the way; `Sup::drop`'s own, much more generous, teardown
  fallback never gets the chance to mask a PDEATHSIG regression here). `tests/api.rs` runs
  `--no-supervise` (its pid/lock/SIGTERM checks are about the compositor itself);
  `wayland_serve_args_and_missing_compositor` now also passes `--no-supervise` for its
  "not available yet" (exit `EXIT_NO_COMPOSITOR`, Task 16b) assertion — the supervised
  retry-then-give-up case is `gives_up_without_compositor_after_backoff`'s job, above.

## Snapshot

`src/snapshot.rs` + `Runtime` (spec §4.1; Task 16, R74). What the player shows, persisted
to `<state>/snapshot.json` so a restarted player comes back with the same wallpaper at the
same place.

- **Format (`version` 1, pretty JSON):** `saved_unix_ms`; `player` (settable Player props:
  `debug`, `paused` — the player is the one authority for pause, restored with the snapshot;
  the backend never re-asserts it, I3); `outputs` — per present connector `{content: <source key>|null, props
  (settable output props ≠ default: layer, paused), layer (main layer fit, viewport,
  opacity)}`; `output_props` — remembered props of connectors not present; `sources` — per
  referenced source `{kind, path, position, paused, speed, loop, gains (set slots except
  xfade/anticlick), props (every other settable source prop: color, hwdec, fps_cap, cache,
  demuxer_*, af, no_audio, audio_delay), playing, transition_target}`; `parked` — `{id,
  resume_paused, connector}`. Source keys are references inside the file only: a restore
  mints fresh ids (`snapshot.restored.ids` maps old → new).
- **Excluded:** effects, `snapshot`-kind sources, sources no output shows (graves, held A's,
  anything created but not shown), every in-flight transition's scaffolding. **A transition
  in flight is saved as its target B** on the outputs it covers (`transition_target: true`,
  `paused: false`, no xfade/anticlick, its position = its requested start until it plays);
  an effect shown without a transition is saved as its `to` side.
- **Values:** an animating number (gain, opacity, speed) is saved at the animation's target
  while it is **live** (`Animator::live_target_of`), else the value itself — a finished
  animation's target is stale once something `set` the prop (outputs.sh caught 0.97
  restored after `animate` → 0.97 then `set` 1). Position = `time_pos` once a video is
  ready, else the requested `position`.
- **When:** `DEBOUNCE` 250 ms after the first unsaved change (any drained graph change or
  `picture_rev` move — sets, creates, destroys; a burst is one write, a continuous
  animation can't postpone it; a one-shot calloop timer wakes a stepped-clock loop), every
  `REFRESH` 2 s while a video plays (positions move without changes), at startup (a fresh
  start must not leave an older session's snapshot for the next crash), and once more on
  exit: `quit`/SIGTERM and the `loop.failed` path queue the **final** snapshot *before*
  `stop_all` empties the graph, then no more writes (`frozen`) — so a later `serve
  --restore` brings back what was on screen; `stop` itself is a change → an empty snapshot.
- **Writing:** on the `lp-snapshot` thread (latest queued wins): `snapshot.json.tmp` +
  `fsync`, rename, `fsync` the dir — a crash mid-write leaves the previous file. Failures:
  `snapshot.write_failed` once per streak (+ hint), `write_recovered`; `snapshot.saved
  {bytes, write_ms}` at debug. The writer is joined in `shutdown`.
- **`--restore`:** missing file → `snapshot.none`; unreadable/corrupt JSON/unknown
  `version`/dangling reference → `snapshot.invalid {reason, moved_to}`, the file moved to
  `snapshot.invalid.json`, the player starts empty (never a crash loop over a bad file).
  Otherwise, after the initial outputs exist: player props; each saved connector that is
  present gets its output props, main-layer settings and content at the saved position
  (**exactly** the saved position — no elapsed-time compensation; the 2 s refresh bounds
  the drift); a saved connector that is missing keeps its props for when it appears, and its
  content — unless a present output shows it — is **parked for that connector**
  (`Parked::connector`; shown when that connector appears, before any other rule; only one
  wallpaper can be parked — further ones `snapshot.dropped`); the saved parked wallpaper is
  shown on the outputs that show nothing, else parked again; a present connector the
  snapshot didn't know shows the current wallpaper (as hotplug would). Then
  `snapshot.restored {sources, outputs, age_ms, parked, ids}`. A value the schema rejects
  is `snapshot.prop_rejected` / `snapshot.source_failed` and skipped.
- **Audio on restore (core invariant):** a restored playing video starts at
  `gain.anticlick` −96 with a *not-yet-started* animation to 0 dB (corr `restore-fade`);
  at `source.ready` that animation is re-added from now (30 ms ramp in). Until then
  `target_of` reports 0 dB, so a transition starting meanwhile records (R41) the 0 dB it is
  heading to; a recipe's own anticlick ramp supersedes it (the restore fade then does
  nothing); parking cancels it (unpark ramps from −96).
- **`snapshot` probe:** `{path, writes, failures, last_write_ms, since_last_write_ms,
  due_in_ms, frozen, current}` — `current` is what would be written now.

## Memory

`src/mem.rs` + `src/probe/memory.rs` + the reaper (Task 20b). **The allocator policy**
(`mem::apply_policy`, the first line of `runtime::serve`, before any mpv core exists; the outcome is
logged as `mem.policy` right after `log::init`, Warn on an unknown `LP_PLAYER_MALLOC` value):

- **Fixed mmap threshold, `mem::MMAP_THRESHOLD` = 128 KiB** (`mallopt(M_MMAP_THRESHOLD)`,
  which also turns glibc's dynamic adjustment off). glibc starts at 128 KiB but raises the
  threshold to the size of any mmapped chunk that is freed (≤ 32 MiB): after the first mpv
  core is destroyed, a 1080p frame-pool buffer (~3 MiB) or demuxer block no longer gets its
  own mapping but comes from one of ~57 per-thread arenas (8 × cores max), and an arena
  keeps what it frees. Fixed, an allocation ≥ 128 KiB that no free chunk of its arena fits
  gets its own mapping (fresh `mmap`, unmapped by `free`) instead of growing the arena. The caller's own choice wins (`MALLOC_MMAP_THRESHOLD_`, or
  `glibc.malloc.mmap_threshold` in `GLIBC_TUNABLES`).
- **`malloc_trim(0)` after each reaper batch** (`mem::trim_after_reap`, on the
  `lp-mpv-reaper` thread once its queue is empty — never the loop): the smaller chunks a
  destroyed core frees still fragment the arenas (+0.35 MiB retained per switch with the
  threshold alone); the trim returns those pages. Measured ≤ 2.4 ms (1.4 ms mean) per
  switch with the threshold in place; `mpv.trimmed {ms, released, rss_kib}` (debug).
- **No arena cap.** `M_ARENA_MAX` 4 on top changed little (373 vs 380 MiB after 300
  switches) and adds lock contention across the ~30 decoder/demux/audio threads.
- **`LP_PLAYER_MALLOC=glibc`** skips the whole policy (A/B; the regression test's RED run);
  `memory` probe `policy.applied` says which is in effect.

**Measured** (hermetic headless, 2 × 1080p outputs, `--ao null`, a fade to an alternating
1080p30 clip every 1 s): 200 switches with glibc's defaults grew RSS 159 → 922 MiB while
malloc's in-use bytes stayed flat at ~300 MiB and its free (retained) bytes went 1 → 614
MiB — allocator retention, not a leak; `hwdec=auto` (mpv picks `vulkan-copy` here)
1.2–1.6 GiB. With the policy: 364 → 380 MiB over 300 switches (`hwdec=auto` 451 → 457 MiB
over 200). CPU: idle playback unchanged (13.75 vs 14.03 s per 60 s); a 1 s switch loop costs
~4 % more process CPU (161.7 → 168.1 s per 313 s, ~21 ms CPU per switch: fresh pages for each
new core's pools + the trim). Diagnose
with the `memory` probe: *live* (`in_use_bytes + mmap_bytes`) flat + `free_bytes` growing
= retention; live growing = a real leak (then `loop` → `bounds`, `reaper_pending`,
`dying_sources`, `opening`; growing on Wayland only, per *present* rather than per switch —
minutes without a switch grow as fast — = an event queue nobody dispatches, § Wayland →
NVIDIA notes, Task 20e). Guard: `tests/api.rs::t20b_switch_loop_rss_stays_flat` (20
fades between two 1080p clips: RSS growth over the last 16 < 10 % and an on-demand trim
gives back < 5 % of RSS — near-vacuous under the policy, growth is the meaningful check; with `LP_PLAYER_MALLOC=glibc` 32 % / 13.6 % → fails).
`docs/player/debugging.md` row "RSS grows per switch".
