---
paths:
  - "src/player/**"
---

## liascape-player (the "utopia player")

`liascape-player` is the Rust crate (binary + lib, edition 2024) that will replace mpvpaper +
`liascape-transition` + per-monitor LWE + `liascape-audio` with one process that owns every wallpaper
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
  `ctl` (§ Command API), `scene-check` (§ Scene worker → "Real scenes"), `scene-loudness` (§ Scene worker →
  "Scene loudness" → "Offline estimate"), `health` (below); any other
  invocation prints usage and exits 2.
- `src/health.rs` — feature health (owner 2026-10-28, "make missing libraries fail loudly"): which optional
  pieces work here and why not, each `{ok, reason, …}` (`ok` null = not known): `effects` (the catalogue —
  none / empty / unloadable → every switch is a cut), `vram` (one sample of `vram::probe_from_env` — none →
  the VRAM limit and low-VRAM rule can't act; run once at serve start on the `lia-health` thread, `hello`
  never waits: `{ok: null, pending: true}` until it answered), `hwdec_interop` (the render worker's GL interop —
  none → copy-mode hwdec), `scenes` (`Runtime::scenes_available`). `hello.health` carries all four;
  `liascape-player health` prints `{effects, vram}` (no render worker without a GL context) for when no player runs —
  the backend's `/health/features` (web-backend.md). Unit tests in the module.
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
  `handlers.rs` (the verbs), `capture.rs` (`capture`'s readback + encode off the loop). `src/ctl.rs` — the shell client. `src/paths.rs` — socket
  and state paths. § Command API.
- `src/probe/` — the probe registry (`mod.rs`: `list`, `sources`, `loop`; `frames.rs`:
  `frames`, Task 13; `audio.rs`: `bus`, `meter.window`, Task 14; Task 15 adds more;
  `memory.rs`: `memory`, Task 20b; `workers.rs`: `workers`, Phase 2; `vram.rs`: `vram`, Task 8).
  § Command API.
- `src/audio/` — the player audio bus (`bus.rs`) + bus meter (`meter.rs`), `loudness.rs` (scene
  loudness learned on first play and refined on every play, one measurement per path in the `Book` — § Scene
  worker → "Scene loudness"), `Audio` (what
  `serve` runs, `mod.rs`). § Audio bus. `sysmon.rs` — the scene visualiser's system-audio
  input (Phase 2 Task 7, § Scene worker → "Real scenes").
- `src/supervise.rs` — the supervisor (`serve` without `--no-supervise`): spawns, waits
  for and restarts the compositor child (Task 16). § Supervisor.
- `src/snapshot.rs` — the persisted state snapshot (`<state>/snapshot.json`, `--restore`)
  + its writer thread (Task 16). § Snapshot.
- `src/mem.rs` — process memory (`/proc/self/status`, glibc `mallinfo2`/`malloc_info`)
  and the allocator policy `serve` applies first thing (Task 20b). § Memory.
- `src/onset.rs` — invariant #8's one onset helper (`PendingOnset`/`Onsets`: ramp-ins held
  until the source's audio flows, bounded by `ONSET_TIMEOUT`) and the one "can it be heard"
  predicate (`has_audio`, `audible`). § Runtime "Onsets" (final review I6/M12).
- `src/worker/` — Phase 2: the compositor side of the scene worker (`proto.rs` wire
  protocol, `mod.rs` `WorkerHost` lifecycle, `dmabuf.rs` `ImportedRing`/`Latch`).
  `src/bin/liascape-scene-worker/` — the worker binary (second `[[bin]]`; `ring.rs`,
  `synthetic.rs`). `src/scene/` — pure scene helpers (`cover_size`, the synthetic spec,
  `assets.rs` WE's assets dir, `pointer.rs` output → scene coordinates, `pkg.rs` the `scene.pkg` reader,
  `loudness_estimate.rs` the offline loudness estimate — § Scene worker → "Scene loudness" → "Offline estimate").
  `src/sources/scene.rs` — `SceneSource`. `src/gfx/dmabuf.rs` — dmabuf export/import +
  native fences on `Gfx`. `src/bin/liascape-scene-worker/lwe.rs` — LWE's core (feature `lwe`);
  `render.rs` — a real scene in the worker (Task 7); `audio.rs` + `stretch.rs` — the scene's
  sound as a stream on the player bus, time-stretched (Task 6); `gputimer.rs` — per-frame
  `GL_TIME_ELAPSED` (Task 8). `src/scene/budget.rs` — the worker GPU budget (Task 8).
- `src/vram.rs` — VRAM measurement (NVML dlopened / DRM sysfs+fdinfo / `nvidia-smi` / a fake) on
  the `lia-vram` thread and the pure low-VRAM rule (Phase 2 Task 8); `src/probe/vram.rs` — the
  `vram` probe.
  § Scene worker → "GPU budget and VRAM (Task 8)".

**`build.rs`** (Task 10) runs bindgen over `mpv/client.h` + `mpv/render.h` +
`mpv/render_gl.h`, found through pkg-config `mpv` (≥ client API 2.0; this machine has
mpv 0.41 / API 2.5), allowlisting `mpv_.*` functions/types and `MPV_.*` vars. C enums are
generated as **module consts** (`mpv_event_id::MPV_EVENT_FILE_LOADED`), never Rust
`enum`s — a value a newer libmpv adds can't become UB. pkg-config also emits the
`-lmpv` + `-L` that nixpkgs auto-rpaths (same mechanism as `khronos-egl`'s `static`
feature, § GFX / EGL). The flake's `liascape-player` derivation already carries
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

**Output props.** `name`/`width`/`height`/`refresh_hz` (read-only; kept current with
`set_observed` on a mode change), `layer` = `background|bottom|top|overlay` (live, §
Wayland), `paused`, `pointer` (read-only `[x, y, buttons]`, observed — § Wayland),
`scene_fps` (Phase 2 Task 5: the frame rate scenes shown here render at, 0–480, default 30,
0 = the refresh; live — § Scene worker → "The `scene` Source kind").

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
this machine or (verified) inside `nix build .#liascape-player`'s sandboxed check phase.

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

**`write_png*` compress with fdeflate's `Compression::Fast`** (Task 13): when `capture` still wrote
on the loop, the default `Balanced` held it 820–875 ms for a 3840×1080 scene frame (release) —
every output froze; `Fast` 39–112 ms (now the reply's latency). Guard
`tests/gfx_basic.rs::write_png_is_fast_enough_for_the_loop` (readback + encode < 0.7 × a `Balanced`
encode alone on a noisy 1080p frame, pixels round-trip; RED with `Balanced`: 1845 vs 1923 ms in the
debug build; fixed it reads 0.45–0.51 × in a debug build — the old ½ bound failed about every other run).

**`capture` never stalls the loop (2026-10-28, `api/capture.rs`).** The handler only *starts* the
readback — `Gfx::start_read_back`: `glReadPixels` into a `GL_PIXEL_PACK_BUFFER` (`STREAM_READ`) + a
fence + `glFlush`; the GPU copies in command order, so the picture is the one at the request (stepped
captures stay deterministic). `Runtime::pump_captures` polls the fence (`Gfx::map_read_back`,
`client_wait_sync` timeout 0) after every dispatch and on a 1 ms calloop timer while one is on the
GPU (a stepped loop has no tick), maps the buffer and hands the mapping (`MappedPixels`, `Send`:
plain memory valid until unmapped) to the **`lia-capture`** thread (started with the first capture,
idle on its channel until shutdown), which flips/encodes/writes straight from it; the loop then
unmaps the buffer (`Gfx::end_read_back`, its own context, after the thread dropped its view), keeps
it as the **spare** for the next capture of that size (freed after `SPARE_IDLE` 10 s unused, or by a
capture of another size) and sends the reply (`finish_captures`, woken by a calloop ping). The reply
is deferred like `step`'s (`client.awaiting`; per-client FIFO — a request pipelined behind a capture
is answered after it). A thread that can't start → the encode runs on the loop (as before). `quit`
writes every capture in flight first (`Capturer::shutdown`: its GPU copy ≤ 1 s, then the encode).
`loop` probe `bounds.captures_in_flight`. `write_png` / `write_png_source` (tests, `--lwe-smoke`)
stay synchronous (`Gfx::read_back` + `Readback`). **Every GL call stays on the loop's context:** a
GPU copy read back on `lia-capture`'s own shared context (tried) stalled the loop 29–47 ms — the
NVIDIA driver's process-wide lock around a new context's first `eglMakeCurrent`. **Measured** (debug,
`--clock real`, a playing 1080p clip on a 3840×1080 output; the capture request / the loop's max
busy around it): before 810 ms; a synchronous readback alone 1.6–10 ms each time (the GPU wait + a
16 MB copy into fresh pages); now the **first** capture at a size 4.5–5.0 ms (3840×1080) / 0.5–0.9
ms (1920×1080) — the driver pins the new buffer's memory at its first `glReadPixels` (2.7–7.6 ms
for 16 MB, measured without the spare: every capture paid it) — and **every repeat 0.07–0.10 ms**
(loop max busy 0.3–1.2 ms, other work); the reply after 0.76–1.2 s (the debug encode). Guard
`tests/api.rs::capture_encodes_off_the_loop` (an output and a source, twice each: the capture's
request < 10 ms for a first capture at a size, < 1 ms for a repeat, the loop's longest stretch
around each < 10 ms — the loop's own debug ticks reach ~2 ms, so the request is the capture's
measure —, the PNG complete at the reply, a pipelined `probe` answered after it; RED before: 810
ms; a synchronous readback's repeats read 2.5–3.0).

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

**`LIASCAPE_REQUIRE_GPU=1` — a run that must have a GPU fails instead of skipping (TODO
"`LIASCAPE_REQUIRE_GPU` test mode").** Every GPU-test precondition goes through one helper,
`tests/common::skip_gpu(reason)`: unset (default — the `nix build` sandbox, a GPU-less dev box) it
prints `SKIP: <reason>` and the test returns (passes); set to anything but empty/`0` it **panics**
with `LIASCAPE_REQUIRE_GPU is set but a GPU test would skip: <reason>`. Its callers: `headless_gl` (no EGL
device) and `catalogue_dir` (no `transitions/` — decided: covered too, because nearly every GPU test
— `api`, `supervise`, `transition`, `compose`, `effects_all` — also needs the catalogue, so a GPU CI
without it would still skip almost everything silently), i.e. `api`/`supervise`'s `can_run`, the
transition `Harness`, `compose`/`effects_all`'s `setup`, `sources`, `gfx_basic`, and `t20e`'s catalogue
check; the one lib unit test needing EGL (`gfx::egl` `shared_egl_state_outlives_gfx_…`) applies the same
rule inline. **Not covered, on purpose** (not GPU preconditions): the opt-in Wayland test
(`LIASCAPE_PLAYER_TEST_WAYLAND`), `i7`'s private PipeWire binaries, `credits`' python3/repo, `dropout`'s
ffmpeg-less unit test; `ensure_clip` already panics without ffmpeg. **Measured** (a GPU-less machine
simulated with `__EGL_VENDOR_LIBRARY_FILENAMES=/nonexistent/…` — glvnd finds no driver, `new_offscreen`
fails exactly like on one): the whole suite passed in ~3 s with 133 `SKIP: no EGL device` lines; with
`LIASCAPE_REQUIRE_GPU=1` the same 133 tests fail (8 targets), everything else passes. Guard:
`tests/gfx_basic.rs::require_gpu_turns_a_missing_gpu_into_a_failure` (re-runs `clear_readback` in a
child with the vendor hidden: unset/`0`/empty → passes with `SKIP`, `1` → fails naming the reason;
RED with the pre-change binary: `LIASCAPE_REQUIRE_GPU=1` passed, 2/2 tests ok).

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

1. `LIASCAPE_TRANSITIONS_DIR` env var.
2. `~/.local/lib/liascape/transitions` (the default install, `install.sh`).
3. The repo's own `transitions/`, found by walking up from the current exe's path and,
   failing that, from `CARGO_MANIFEST_DIR` (a build-time constant — this is what makes
   `cargo test` find it even before any exe-relative candidate would resolve).

Each candidate is only accepted if it actually contains a `manifest.json`. Returns `None`
if nothing resolves — true inside `nix build .#liascape-player`'s sandboxed check phase, where
`src/player` is built without its sibling `transitions/` directory present (the flake's
`liascape-player` derivation sets `src = ./src/player`, nothing wider). Every test in
`tests/effects_all.rs` treats `None` the same way `tests/common::headless_gl` treats no
EGL device: print `"SKIP: ..."` and return, never fail the build over it — unless
`LIASCAPE_REQUIRE_GPU=1` (§ GFX / EGL: `tests/common::catalogue_dir` then fails the test).

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
`lia-open` worker thread in the real-clock runtime (§ Sources "`SourceHost`"); `open` = both in a
row (stepped mode, tests, the harness).
Fixed options: `vo=libmpv`, `config=no`, `terminal=no`, `keep-open=yes` (an ended video
holds its last frame) **with `keep-open-pause=no`** (keep-open's default also flips
`pause` at EOF — `read("paused")` would then disagree with the graph and a seek back
after the end would stay frozen), `idle=yes` (the core survives a load error / waits for
a `path` change), `volume=100`, `volume-gain-min=-96`, `image-display-duration=inf` (set
always — it only affects single-frame images), `keepaspect=no` (the texture *is* the
frame; fit is the compositor's), `opengl-pbo=no` (required by the fence stub, below),
`osd-level=0`, `ytdl=no`, `input-default-bindings=no`, `audio-client-name=liascape-player`,
**`dither=ordered`** (I5: the default `fruit` dither builds its blue-noise matrix on the CPU in
every new render context's first render — measured ~25–30 ms on the loop per switch; ordered
dithering of the same 8-bit target is visually equivalent), **`gpu-hwdec-interop=no`** (Task 20d:
no hwdec GL interop init on the loop; a render-worker attach that wants zero-copy sets the worker's
interop before its render context exists — "Hardware decoding" below), and with opt `shader_cache_dir`
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
**No native clipboard (`sources::mpv::CLIPBOARD_OFF`: `clipboard-backends=` — an empty list, set
best-effort the same way).** mpv ≥ 0.40 starts a clipboard in every core at `mpv_initialize`
(default backends `wayland`, `x11`, `vo`): with `WAYLAND_DISPLAY` its own `ext-data-control`
connection to the compositor + a thread (fed every clipboard change of the session — every test
server inherited the owner's and so connected to the live Hyprland), without it and with a reachable
`DISPLAY` its own **X connection** + a thread (named after its creator, `lia-open`). That one crashed
the player (2026-10-26, rapid-switch repro, `--headless` without `WAYLAND_DISPLAY`): when the X
connection drops, mpv's clipboard thread `XCloseDisplay`s it → `XSync` fails → Xlib's *default* I/O
error handler `exit(1)`s from that thread → the atexit handlers tear NVIDIA's EGL down under the
loop's GL → **SIGSEGV** in `glBindFramebuffer` (stderr `X connection to :1 broken (explicit kill or
server shutdown)`; core dump: two cores' clipboard threads in `XCloseDisplay`, the reaper idle — both
live connections broke at once, 2 ms after an Electron's scope ended: most likely a UI-matrix shard's
private `Xvfb -displayfd`, which comes up as `:1` on this machine, going away with its shard; the
switches were incidental — 48 rapid-switch runs against a private Xvfb never broke a connection).
Nothing in the player needs X: with this set, a core has no X or Wayland connection of its own.
Guards: `tests/api.rs::losing_the_x_server_never_kills_the_player` (`DISPLAY` = a
private `Xvfb` on a display nothing uses — never `-displayfd`, which took the session's `:1` —, no
`WAYLAND_DISPLAY`, a playing `hwdec=auto` video; the X server killed →
the player plays on, switches, quits 0; RED before: SIGSEGV within ms; SKIP without `Xvfb`),
`tests/sources.rs::no_clipboard_backend_per_core` (`current-clipboard-backend` unavailable,
`options/clipboard-backends` empty; RED before: `wayland` under the session's environment). **Not
covered:** a decoder that talks to X itself (an explicit `vdpau`/`vdpau-copy`) opens its own
connection through its driver; `auto` resolves to `nvdec-copy` here (none — the guard runs it).
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
`start` to `none`); `hwdec` → `sources::mpv::mpv_hwdec(v, interop)` (copy modes unless the
source's render context loaded the render worker's GL interop — "Hardware decoding" below);
`fps_cap` → `vf` `fps=<n>` / `""` — **never on a still** (`want_vf`/`push_vf`, below); `cache` →
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

**An fps cap never reaches a still (2026-10-28).** mpv's `fps` video filter (libavfilter's) emits a
frame only once it knows how long it lasts — the next frame's pts or a timed EOF; an image shown with
`image-display-duration=inf` gives neither, so its one frame went in and the chain reported EOF with
no frame out (mpv `--msg-level=vf=v`: `filter input EOF` → `filter output EOF`, nothing rendered).
With `VideoFpsCap` > 0 every image item stayed `ready: false` (size 0) and its switch sat in
`waiting_ready` until the 10 s failure. Now `MpvSource::want_vf` sends `fps=<n>` only when the
current load isn't a still (`vf_still`: the `kind` at open, `infer_kind` of a new `path` — set before
its `loadfile`, async requests run in order —, then mpv's `current-tracks/video/image` flag, which
re-pushes the `vf` when the guess was wrong: a misnamed still loses the filter and its frame comes
through, an animated "image" gets the cap); `push_vf` skips an unchanged value. The node keeps
`fps_cap` (`read` = the cap). Player-side, so any client is safe. Scenes and colours only store
`fps_cap` (unaffected). Guards: `tests/sources.rs::fps_cap_never_stalls_an_image` (open capped, live
cap, image → video (capped, `vf` has `fps`) → image by `path`, a `.dat` still; RED: never Ready;
the flag's re-push removed → the `.dat` case RED), `tests/api.rs::fps_cap_never_stalls_a_still_any_kind`
(both clocks: `srcs:*.fps_cap` + capped image/colour/scene/video B's each hand off and show; RED:
stepped `step: no frame within 2 s … waiting for ready`).

**A tempo filter is always in the chain (speed storm).** `mpv_af` hands mpv the graph's `af`
plus `@liascape-tempo:scaletempo2` (left out when the chain already has `scaletempo*`/`rubberband`).
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

**Hardware decoding (Task 20d, R107; zero-copy on the render worker since 2026-10-27).** Two
cases, by where the source's render context lives: **on the render worker** (the default for
every real-clock source) it decodes zero-copy through a GL interop — "Zero-copy on the render
worker" below; **on the loop** (worker off, stepped mode, the harness, any synchronous open) it
decodes in copy modes, never GL interop — the rest of this paragraph. Such a core runs
`gpu-hwdec-interop=no` and `apply("hwdec", v)` sends `mpv_hwdec(v, None)`: `""`/`no` → `no`;
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

**The trade-off (Phase 1):** copy modes download each frame and mpv uploads it like software
decoding (on the loop then; on the worker's lane since Phase 2). Steady state, one source on both
outputs, % of one core: 1080p30 `no` 27.7,
`nvdec-copy` 9.8, `vaapi-copy` 26.0 (nvidia-vaapi-driver), `vulkan-copy` 14.4, `nvdec` interop
7.4; 4K60 `no` 111, `nvdec-copy` 55.6, `vulkan-copy` 80.1, `nvdec` interop 11.3 (loop max busy at
4K60: `no` 8.1, `nvdec-copy` 12.8, interop 2.8 ms). First frame of a cold source (1080p): `no` 319,
`nvdec-copy` 438, `vaapi-copy` 642, `vulkan-copy` 698 ms — hence `nvdec-copy` ahead of mpv's
`vulkan-copy` in `auto`. Guards (the loop path): `tests/api.rs::t20d_hwdec_switch_never_stalls_the_loop`
(dev env + libcuda env, `DISPLAY`/`WAYLAND_DISPLAY` removed, both render modes; warm median < 50
ms — fixed medians 16–36 ms, the traps ≥ 65 — and never an interop mode on a loop-rendered source;
RED before: 286, 91, 85, 88 ms), `tests/sources.rs::property_map_reaches_mpv`, unit
`hwdec_maps_to_copy_modes_only`.

**Zero-copy on the render worker (2026-10-27; TODO "Zero-copy hwdec back").** A render context
on an `lia-render` lane (§ "Render worker" below) loads the GPU's GL interop, so nvdec/vaapi frames
go straight into GL textures — the interop's init (a CUDA context per render context on NVIDIA)
runs in `mpv_render_context_create` on the lane, which the loop never waits for.
- **Which interop** (`render_worker::hwdec_interop_for`, on lane 0's own context at start, logged
  `render_worker.hwdec_interop {gl_vendor, interop, libcuda}`): `GL_VENDOR` NVIDIA → `cuda`,
  AMD/Intel → `vaapi`, anything else (llvmpipe, nouveau) → none (copy modes, one lane). Never mpv's
  `auto`, which for the render API loads EVERY interop eagerly (no on-demand loading in libmpv) — on
  NVIDIA also `vaapi` via nvidia-vaapi-driver, a second CUDA context per source. Env
  `LIASCAPE_PLAYER_HWDEC_INTEROP`: unset/`on` = that, `off` = Task 20d's copy modes exactly (one lane, no
  preload — the A/B and escape hatch), `cuda|vaapi|drmprime|all` to force one.
- **libcuda.** The CUDA interop dlopens `libcuda.so.1` from libmpv, whose nixpkgs RUNPATH lacks
  `/run/opengl-driver/lib` (above), so lane 0 dlopens it first (by soname, else that path — a
  loaded soname satisfies every later lookup): the dev/install binary gets the interop from its
  first source on, like the flake wrapper; then `cuInit(0)` (`render_worker.cuda_init {result,
  ms}`, 20–32 ms measured) after the loop stopped waiting for the lane. No libcuda → no interop.
- **Which sources.** Only an attach the loop doesn't wait for: the `lia-open` job
  (`PreparedCore::attach_render(worker, true)`) of a source whose node `hwdec` (when the open is
  submitted) would decode zero-copy through that interop and that isn't an image
  (`host::wants_hwdec_interop` — `""`/`no`, `-copy`, `auto-copy*` and stills skip the 85–220 ms
  and ~60 MiB VRAM). It sets `gpu-hwdec-interop=<interop>` on the core (an option after
  `mpv_initialize` = the `options/` property, read when the render context is created) before the
  attach; an attach that falls back to the loop sets `no` again. A synchronous open (the loop
  waits for its attach: the harness, a pool that couldn't start a thread) never asks.
  `MpvSource::hwdec_interop` (probe `hwdec_interop`) then maps `hwdec` with `mpv_hwdec(v,
  Some(i))`: a decoder the interop can show first, **each followed by its copy twin** (an interop
  that failed to init, or a codec the GPU can't do zero-copy, falls back to the copy, never to
  software) — `cuda`: `auto` → `nvdec,nvdec-copy,vaapi-copy,auto-copy`, `nvdec` →
  `nvdec,nvdec-copy`, `vaapi` → `vaapi-copy`; `vaapi`: `auto` → `vaapi,nvdec-copy,vaapi-copy,
  auto-copy`; `auto-copy*` stays copy. A live `hwdec` change keeps working either way (a source
  opened without the interop maps to copy modes). **`vulkan` stays `vulkan-copy`**: mpv's GL
  renderer has no Vulkan interop (it needs mpv's Vulkan renderer), and the X-less driver lock
  above (`vkCreateDevice` on mpv's core thread) is process-wide: with the render worker the loop
  stays free (busy 1–29 ms per switch) but the lanes wait on it — A's longest frame interval
  270–790 ms per switch, the same on the pre-change binary (driver limit, unchanged; the default
  `auto` never picks it). In 2 of 11 such runs a `vulkan` B never showed a first frame (10 s;
  0 of 8 on the pre-change binary, same code path — not investigated). `vdpau` (GLX) and `amf`
  likewise stay copy.
- **GL state, fences, teardown.** The CUDA interop registers mpv's own plane textures with the
  lane's context current (current for the lane's whole life) and copies each decoded frame into
  them with CUDA — ordering that copy before its own GL sampling is mpv's job, exactly as in its
  VO; mpv then renders into our RGBA8 target on the lane, and our `glFenceSync` after that render covers
  every GL command of it — the loop only ever samples our target, adopted once that fence
  signalled. `reset_gl` touches bindings only (mpv rebinds what it needs). `Slot::free` drops the
  render context first — interop uninit, texture unregistration and its CUDA context, the lane's
  context current — then the weak client and textures, and only then hands the core to the reaper.
  The fence stub stays — zero-copy frames come out whole under it (the guards below) — and so
  does `opengl-pbo=no`.
- **Lanes.** One lane would run B's attach (85–220 ms) in front of A's renders: A's longest frame
  interval while B opened 34 → 66–74 ms at 30 fps (1–2 frames lost before every transition). With
  an interop the worker runs three (§ "Render worker" → Lanes): measured 34–54 ms again (copy
  modes 34–66).
- **Measured** (release, hermetic `serve --headless --clock real --ao null --outputs
  1920x1080@60`, no `DISPLAY`, synthetic testsrc2 h264 clips, the machine shared with other
  agents' suites; `LIASCAPE_PLAYER_HWDEC_INTEROP=off` vs on, alternated per run, 4 rounds at load
  10–20; `hwdec: auto`; median (range)):

  | | copy (`off`, Task 20d) | zero-copy (`on`) |
  |---|---|---|
  | 4K60 CPU, % of one core: process / loop / `lia-render` | 49.4 (33.2–56.3) / 4.8 / 26.5 | **6.8 (5.6–8.9)** / 1.1 / 1.9 |
  | 4K60 loop max busy, steady (ms) | 9.8 (3.8–16.9) | 1.4 (1.2–1.6) |
  | 1080p30 CPU, process | 7.8 (5.3–9.6) | **3.2 (2.4–4.1)** |
  | loop max busy per switch, warm (36) | 0.7 (0.2–6.3) | 0.3 (0.2–6.7) |
  | first frame (request → B `Ready`, 40) | 329.7 (300.5–500.6) | 326.3 (296.1–410.6) |
  | A's longest frame interval while B opens (30 fps) | 34.8 (33.9–65.7) | 34.3 (33.9–54.3) |
  | the attach on its lane | 1.9 (0.3–2.9) | 111.7 (91.9–155.3) |

  The same per switch in ONE server (copy and zero-copy blocks alternating, n = 30 each, load
  16–28): loop busy 0.3 (0.2–6.8) vs 0.4 (0.2–3.8) ms, first frame 319.5 vs 318.8 ms, A's longest
  interval 34.4 vs 34.6 ms. Under heavy load (40–48) both modes had loop stretches of 0.1 s to
  seconds (copy ≤ 0.65 s, zero-copy up to 5.6 s in one run); under `strace -ff` (7 runs, load
  23–46) the loop thread never waited ≥ 30 ms in a futex or ioctl while a lane attached or freed —
  CPU starvation, not the driver lock (the Task 20d trap showed the loop in `FUTEX_LOCK_PI`), but
  not excluded for every load. Memory, 1080p playing: RSS 395 → 370 MiB, VRAM +60 MiB per
  interop source. `loop.long_busy` (debug) puts such a stretch on the log timeline.
- **Guards:** `tests/api.rs::t20d_hwdec_switch_never_stalls_the_loop` (worker on: every hardware
  hwdec decodes `nvdec` with `hwdec_interop: cuda`, warm medians 2.2–3.0 ms against the 50 ms
  bound; off: copy modes, 7.7–19.1), `tests/sources.rs::hardware_decoding_matches_software_in_both_render_modes`
  (orientation, colours ±3, a seek's frame marker ±1, frames advancing — zero-copy on the worker,
  copy on the loop), `tests/api.rs::render_worker_never_composes_a_torn_frame` (its `hwdec: auto`
  cases, also under `slow-flush`), unit `hwdec_maps_to_the_loaded_interop_on_the_worker`,
  `hwdec_maps_to_copy_modes_only`, `render_worker::tests::hwdec_interop_follows_the_gpu_and_the_env`.
- **Costs / risks:** ~60 MiB VRAM per playing interop source (its CUDA context; RSS −25 MiB, no
  copy buffers), both sides of a transition; AMD/Intel `vaapi` interop is unmeasured here (NVIDIA
  only); a fourth wallpaper live at once (three outputs with different wallpapers + a switch)
  shares a lane, and the one sharing B's lane holds its frame for B's attach.

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

**A dropped first frame is asked for again (`REFETCH_AFTER`).** mpv's VO waits 200 ms for the API
user to render a frame (vo_libmpv `flip_page`), then drops it — `mpv_render_context_update` stops
reporting `UPDATE_FRAME`, so the "level-triggered" pending frame is gone. A playing source sends its next
frame anyway; a **paused** one (a transition's pending B, held paused until Ready), an **image**, or a clip
already **at its end** (keep-open holds it — a short clip that played out unrendered) has no next frame: if its only frame went unrendered — the loop busy past 200 ms (a burst of switches and
teardowns with every `/settings`'s live sets landing on the opening B's, the debug build, a loaded
machine; the render worker can't render either until the loop has passed it the size) — it never became
Ready and the transition failed after 10 s (`no first frame within 10 s`). Measured: UI matrix
`race:settingsDuringApply` 4/4 on the debug player; a direct repro (8 transitions 5–80 ms apart + a `set`
of `gain.user`/`speed` on each B, hwdec auto, debug build) 3/8, render worker on or off. `refetch_lost_frame`
(every `update`): a paused source or image whose current load restarted `REFETCH_AFTER` (300 ms) ago with
no frame staged → `seek <time_pos> absolute exact` — the same frame again, a new `PLAYBACK_RESTART`, no
FILE_LOADED (the worker's frame tag still matches) — backing off ×2 up to 2.4 s; never a playing source
(re-seeking a merely slow one would restart its decode), never stepped mode. `source.frame_refetched
{path, pos, since_restart_ms, dsize}` (info, comp `mpv`), `sources` probe `frame_refetches`. After: repro
0/10 (6 of them needed one refetch, size already known — the loop simply hadn't rendered in time), the
matrix cell GREEN. Guard: `tests/sources.rs::dropped_first_frame_of_a_paused_source_or_image_still_readies`
(open, no `update` for 800 ms, then Ready with that frame; RED in both render modes: only `Position(0.0)`) and
`clip_ended_before_any_render_readies_then_ends` (a 1 s clip, no `update` for 1.8 s). **`Ended` waits for
`Ready` in both renderers** (`ended_held`, pushed right after Ready): the loop renderer used to report the end
of a source that never showed a frame first (`ended_holds_last_frame` failed once in a loaded run).

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

**Teardown with GL current (liascape-transition gotcha).** `mpv_render_context_free` must run
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
synchronously. **A straggler is a core not destroyed yet, never a trim (TODO "Reaper trim at
shutdown"):** once shutdown has started no batch is trimmed (the process is exiting), and a trim
already running when the wait ends doesn't count — `shutdown` reports `undestroyed`, while
`pending()` (probes, t20b) still drops only after its batch's trim. Before, `PENDING` dropped after
the trim, so a slow trim during `quit` read as a straggler (and the `_exit` path). The reaper is a
generic `Reaper<T>` (one `lia-mpv-reaper` instance) so its rules are unit-tested with slow fakes:
`a_trim_in_flight_at_shutdown_is_no_straggler` (RED: 1 straggler), `no_trim_once_shutdown_started`
(RED: waited 580 ms for a 200 ms destroy + a 400 ms trim), `a_destroy_slower_than_the_wait_is_a_straggler`,
`batches_trim_once_and_reap_after_shutdown_is_synchronous`. `reaper::pending()`/`SourceHost::dying()` for probes. Pinned by
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
once the seek's reply, then a PLAYBACK_RESTART and the target frame have been seen
(mpv completes the `seek` command before the playloop executes it, so the reply always
precedes that seek's restart). **The frame may come before the restart:** mpv queues it to
the VO in the playloop iteration that then emits PLAYBACK_RESTART, so the loop can render it
before it pumps the event (under load: every step) — a **new** frame (not
`next_frame_is_redraw`) rendered after the reply counts (`StepSeek::target_frame`), as does any
frame after the restart; a redraw before the restart is the previous step's picture and never
counts; completing on that early frame, the restart handler reads `time-pos` once
synchronously (stepped only: the core is paused and its frame rendered) so the step still
returns a settled state. Before, only a frame after the restart did — mpv's redraw of the
target, which didn't always follow (2.8 s into a 3 s clip with its loop off: `step` timed
out, 8/8 loaded runs). A source the step had to wait to **open** gets a fresh `STEP_TIMEOUT`
for its seek once ready (`StepWait::opened` — under load an open alone took ~2 s).
`Pending(what)` meanwhile, `Broken(reason)` for a load error
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
`ColorSource`, `snapshot` → `SnapshotSource` of `of`'s *current* texture, `scene` →
`SceneSource` (Phase 2 Task 5 — then every scene's demand, § Scene worker), else `MpvSource`;
colour/snapshot get every writable prop applied so `read` agrees with the node), then
forwards each drained change to `apply` (skipping sources it just opened — their props
already include it); a refused `apply` is logged (`source.rejected`) and queued as
`SourceEvent::Rejected` (R45), a failed open as `SourceEvent::Error` (not retried until the
node goes). `update(gfx, graph)` updates every source, collects its events, then mirrors
observed values (`kind` — MpvSource's inferred/corrected image|video —, `ready`,
`duration`, `time_pos`, `width`, `height`, `paused`) with `Graph::set_observed`. **`sync` must precede `update`** each iteration, or the mirror would
overwrite a command not yet forwarded. **Only changed values are written** (Phase 2 Task 14): each
hosted source remembers what it last mirrored per prop and skips an unchanged one; the memory is
cleared whenever a change is forwarded to that source (`sync`'s applies, `force_paused`, the R75
recompute), so a `set` the source refuses is still mirrored back. A scene updates every frame, and
nine `format!` + path-resolve + `set_observed`s per update were the largest share of the
compositor's CPU per scene worker (perf, on-machine); measured two synthetic workers at 240 + 144
fps, headless: process 19.2 / 19.6 % → 15.4 / 15.0 %. The mirror writes through
`Graph::set_observed_on(id, prop, v)` (exact id: no path `format!`/split/resolve — F6b).
`update_only(gfx, graph, ids)` is `update` for those ids only (F6b: a wake's update — below). `events()` drains `(node id, event)`; `texture(id)`
is the compositor's closure; `wake_fds()` (mpv sources) is what the runtime polls; `get`/
`ids` for probes/tests.

**Per-frame cost (F6b, 2026-10-29).** Each worker frame is a loop wake (twice when its fence
hadn't signalled at the `Frame`), so everything a wake does is paid per worker per frame — at
the refresh, ~200 times a second per worker. What a wake does now, and why:
- **Only the woken source updates.** The calloop callback of a source's wake fd records its id
  (`Runtime::woken`); `after_dispatch` runs `update_woken_sources` → `SourceHost::update_only`
  (+ those scenes' envelopes and visualiser input); the tick (every refresh of the fastest
  output) still updates every source (`update_sources`, which also forgets gone ids). Before,
  every wake updated every source — a `recvmsg`, an `epoll_wait`, the mirror reads per scene:
  work per worker that grew with the number of workers.
- **`sync_sources` only when due** (`Runtime::sync_due`): a pending graph change, a
  `picture_rev`/`demand_rev` move since the last sync, `SourceHost::sync_pending` (an async open
  in flight, a low-VRAM stop/resume), a pause gate, a retire or a settling park, or the stepped
  clock. Otherwise only `arm_gain_timer_if_needed` runs. The tick's own `sync_sources` is
  unconditional, so anything internal still runs at the tick rate.
- **What each output shows is cached** (`redraw::Routes`, rebuilt only when `Graph::demand_rev`
  moves): `mark_shown_gated`, `mark_nodes`, `animating_on` and `scene_paces_output` read each
  output's `shown`/`nodes`/`scene_fps`/`refresh_hz` from it instead of re-deriving them from the
  graph (path `format!`s, alias resolution, cloned strings) per output per wake — Wayland's
  `render_paced` asked on every iteration for every ready output.
- **A scene's update reads only what is ready** — `epoll_drain` says whether the worker host's
  epoll fd fired; `WorkerHost::poll_io(now, io)` then `epoll_wait`s its own set and reads only
  the socket / output pipe that are readable (before: a `read` and a `recvmsg` that found
  nothing on every poll), and `waitpid`s every poll only once the worker is ending (socket or
  pipe EOF, killed), else at most every `REAP_CHECK` (100 ms). The GL context is made current
  only for what needs it (events, a queued frame, the preview): on NVIDIA `eglGetCurrentContext`
  alone is a `getpid` syscall.
- **No `eglWaitSync` on an acquire fence that has signalled.** A `Frame` whose fence already
  polls readable drops it at once (no epoll entry to add and remove, no poll at the latch); a
  latched fence is only taken off the epoll set. The spike's "free safety net" cost ~10 syscalls
  (fd dups, `getpid`) and a semaphore ioctl per frame on NVIDIA.
- **A soundless scene's gain pushes are only folded** (`SceneSource::send_gain`: `has_audio`
  false → `WorkerHost::fold`, no message) — its worker never opens a stream, and a fade pushed it
  a message per millisecond; `gain_sent` stays what the worker last got, so a later `HasAudio
  {on: true}` (or a restart's `Ready`) sends the current value.
- **Fewer allocations per write:** `props::schema_for` reads a table built once per kind
  (`schema_table`) instead of rebuilding the whole schema per lookup; `Graph::apply_set`
  overwrites an existing key in place; the dropout probe's 1 kHz gain history reads
  `Graph::source_gains_db` (no id clones).
Measured (`scenes.sh transport`, 4 synthetic workers mid-fade at 144 + 240 Hz, headless, excess
user + kernel instructions over the colour fade): 0.40–0.42 → 0.14–0.21 G/s; main-thread
syscalls per worker frame ~56 → ~29 (`perf trace`). What is left per frame is the transport
itself: the `Frame` `recvmsg`, the `Tick` and `Release` `sendmsg`s, and the release fence —
NVIDIA's `eglCreateSync` + `eglDupNativeFenceFDANDROID` alone is ~12 syscalls (fd dups,
`getpid`) plus a semaphore ioctl. Tried and dropped: a worker thread that waits for each
frame's fence and sends the `Frame` after it (one compositor wake per frame instead of ~1.5) —
no gain left in the compositor's instructions once a wake was cheap, for +2 worker context
switches per frame.

**Async opens (final review I5).** With `SourceHost::set_async_open(Some(waker))` (the
real-clock runtime; its waker is a calloop ping) a new mpv node's core is made on an `lia-open`
thread (`MpvSource::prepare_core`, base opts only); the node is `opening` (not hosted: no
texture, no events, `open_failed` false) until a later `sync` finds the worker's result and
opens the source from the node's **current** props (so a change made meanwhile is never lost);
a worker error is the same `SourceEvent::Error` + `failed` as a synchronous one; a node gone
meanwhile drops the result (`PreparedCore::drop` → reaper). `finish_teardown` waits (bounded)
for outstanding workers; `host::opening_pending()` counts toward `mpv.reaper_stragglers`. R29
`Ready` semantics are unchanged (still the first frame of the current load). Stepped mode and
the harnesses open synchronously. **Bounded (TODO "No explicit cap on concurrent `lia-open`
worker threads"):** the cores are made by `host::OpenPool` — a FIFO queue served by at most
`MAX_OPEN_WORKERS` (2) `lia-open` threads, spawned on demand and gone once the queue is empty
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

**Render worker (Phase 2, `sources/render_worker.rs`; `serve --render-worker on|off`, env
`LIASCAPE_PLAYER_RENDER_WORKER`; **default on** since 2026-10-26 — `off` renders every source on the loop as before).** `lia-render` threads (**lanes**, below) own
every *worker-mode* `MpvSource`'s render context — creation, the first render (shader compile,
LUTs), every later render, the free — so the loop only adopts finished textures and composes.
- **Context.** `Gfx::share_context` makes another context on the **same** `EGLDisplay` (one per
  process, refcounted terminate — § GFX / EGL), same config, `share_context` = the compositor's;
  each lane makes its own current **surfaceless** for its whole life and loads its **own** glow (real
  `glFenceSync`/`glClientWaitSync`). mpv still gets `get_proc_address` with the fence stub;
  `opengl-pbo=no` stays.
- **Lanes (2026-10-27, with zero-copy hwdec).** A render context is bound to the context it was
  created on, and its creation blocks that lane — with the hwdec GL interop that is the interop's
  init (a CUDA context, 85–220 ms per attach measured). On ONE thread the playing wallpaper froze
  for it at every switch (A's longest frame interval while B opened: 34 → 66–74 ms at 30 fps).
  So with an interop the worker runs `render_worker::RENDER_LANES` (3; env
  `LIASCAPE_PLAYER_RENDER_LANES` 1–6) lanes, each its own thread + context + eventfd, and
  `RenderWorker::attach` puts a new source on the lane with the fewest live sources (`Inner::live`,
  counted by the callers — an attach on its way counts; ties → the first): B's attach and later A's
  free (`mpv_render_context_free` destroys the CUDA context too) run beside A, never in front of it
  (A's longest interval back to 34–54 ms, as in copy mode). Two lanes cover one wallpaper on
  every output (ping-pong), the third a switch while the previous A still fades out or a second
  wallpaper on another output; a source never moves. Without an interop (`hwdec_interop` null:
  not NVIDIA/AMD/Intel, or `LIASCAPE_PLAYER_HWDEC_INTEROP=off`) an attach costs < 1 ms and the worker
  runs one lane, as before. Cost per extra lane: a thread, ~4.5 MiB RSS, 50–110 ms more at
  startup (its first `eglMakeCurrent`, before `player.started`). `Attached {id, lane, ex, worker}`
  frees/wakes on its own lane; `died`/`shutdown`/`stats` cover every lane (`stats` sums counts,
  maxes timings, and lists `lanes: [{slots, live, attaches, attach_ms_max, renders, frees,
  free_ms_max, exited}]`). `render_worker.attach` / `.free {lane, ms}` / `.first_render {lane,
  slot, ms}` (info from 100 ms, else debug); `ATTACH_WAIT` 10 s (was 3: the process's first interop attach once took > 3 s on a
  heavily loaded machine — the transition waits 10 s for B anyway).
- **Split.** The loop keeps the core: event pump, async applies, `read`, load fencing, Ready, the
  front/back textures it shows. The `lia-open` job hands its freshly prepared core to the worker
  (`RenderWorker::attach`, the job waits) which creates the render context with the update callback
  on the worker's eventfd, then the loop's `open_with_core` only applies props + `loadfile`.
- **Hand-off (per source `Exchange`, a mutex never held across an mpv call).** Loop → worker: the
  target size (observed `dwidth`/`dheight`, capped), textures given back. Worker → loop: the
  newest complete frame (an unadopted older one goes back to the free list — the latest COMPLETE
  frame wins), a render error. The worker renders only into textures it owns (never the loop's
  front/back/unadopted frame); after each render `glFenceSync` + `glFlush`, it waits on that fence
  itself (client wait, bounded) and only then publishes + writes a `dup` of the source's eventfd.
  The loop adopts a frame only when `glClientWaitSync(fence, 0, 0)` reports it signalled (else it
  keeps the previous one and re-checks next iteration) — never a half-rendered frame; the sampler
  re-binds the texture (GL share-group visibility rule). A texture the loop sampled (a replaced
  front) goes back with a **release fence** (+ `glFlush`) that the worker `glWaitSync`s before
  rendering into it again. `SnapshotSource` blits `texture()` = an adopted (complete) front.
- **Load fencing / Ready.** Every frame is tagged with the number of FILE_LOADED events mpv had
  emitted when its render started — counted by the worker through a **weak client** on the core
  (`mpv_create_weak_client`, every event but FILE_LOADED masked off, no observed properties, so its
  `wait_event(0)` never touches the core lock); the loop counts the same broadcast events and a
  frame is "of the current load, rendered after its FILE_LOADED" iff its tag equals the count at
  the current load's FILE_LOADED. Same rule as the loop renderer, but on mpv's own event order
  instead of the loop's pump time — a single-frame image/paused clip whose only frame the worker
  rendered before the loop pumped FILE_LOADED would otherwise never become Ready. front/back
  promotion, orientation (FLIP_Y = 0) and `reset_gl_state` (on the worker's context) unchanged.
  A size change re-renders mpv's current frame at the new size (tagged like the frame it redraws).
- **Teardown.** Two-phase as before; `Drop` clears the core's wakeup callback and hands the core +
  every texture it holds to the worker (`Free`): render context freed with the worker's context
  current, weak client destroyed, textures/FBOs deleted, then the core to the reaper — no GL on the
  loop. A `PreparedCore` dropped with a render context attached goes the same way. `quit`:
  `finish_teardown`, then `render_worker::shutdown`, then `reaper::shutdown`.
- **Real clock only** (like async opens): stepped mode and the harnesses render on the loop
  (`stepped_is_deterministic` untouched); a source opened synchronously in real-clock mode renders
  on the loop too — the two modes mix per source. Audio is untouched.

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
  (`Rng`, SplitMix64).
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
    countdown kept), and an armed B that is no longer a playable item is cancelled (the abort restores A's loop)
    and re-planned; `defaults` / item `props` reach the next B only. An edit never resets the play time.
  - **Pause, holds, parking** (Task 5): the clock is `Runtime::now`, so a user pause and the low-VRAM hold stop
    play time and the countdown. Parked (no output, R60) the program's phase is `parked` and it follows
    `while_parked` (O2, a Program prop, live): `rotate` (default — today's backend) keeps both clocks counting,
    timer/max/scenes-after switches go through `transition_parked` (each replaces the parked wallpaper and commits at
    once; no sooner than `PARKED_MIN_PLAY_MS` = 1 s after the last commit, so an image at minimum 0 can't switch
    every tick), an end-of-video switch waits for an output (a parked A never ends); `hold` stops both clocks and
    the rules until an output returns. An output added mid-switch is adopted by the recipe as usual.
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
    cursor, history, `position` = its `time_pos`, play time, countdown — `program.current {resumed: true}`), a point
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

**`ctl`:** `liascape-player ctl [--timeout-ms N] <verb> ['<json args>']` prints the result as
pretty JSON, exit 0 — or the error object (stdout), exit 1 (also for no player / bad JSON
args / **no reply within `--timeout-ms`, default 10 000** → `timeout`, hint: pass a longer
`--timeout-ms`; all with a hint). `liascape-player ctl subscribe <prefix…>` prints events one
JSON object per line until Ctrl-C, without a timeout; when the player exits it prints a
note on stderr and exits 0 (or stdout closes).

| verb | args | result | errors (besides `bad_request`) | `ctl` example |
|---|---|---|---|---|
| `hello` | — | `{version, pid (the compositor — the supervisor's child when supervised), supervisor_pid (null unsupervised), restart (the `supervisor.restart` fields this child logged, or null), protocol: 1, capabilities: [video, image, color, transition, program, scene? (the worker resolves — Task 5 — and WE's assets dir does, or synthetic scenes are allowed — Task 7), headless?, stepped?], clock, backend, verbs, health {effects, vram, hwdec_interop, scenes} (each `{ok, reason, …}`, `crate::health`)}` | — | `ctl hello` |
| `create` | `{kind: source\|layer\|effect\|program, id?, props?}` (a program without `seed` gets the wall clock's nanos) | `{id}` | graph codes; `no_such_effect` (an effect's `effect_id`); `unsupported` (output/player) | `ctl create '{"kind":"source","props":{"path":"/w/a.mp4","loop":true}}'` |
| `destroy` | `{id}` | `{ramp_ms}` — an audible source is ramped out first (30), else gone now (0) | `no_such_node`; `unsupported` (an output or main layer) | `ctl destroy '{"id":"src3"}'` |
| `set` | `{path, value}` (aliases: every match) | `{targets: [ids]}` | graph codes; `no_such_effect` (`<fx>.effect_id`) | `ctl set '{"path":"srcs:*.gain.user","value":-6}'` |
| `get` | `{path}` (must resolve to one node) | `{value}` | graph codes, `ambiguous` | `ctl get '{"path":"cur:DP-1.time_pos"}'` |
| `animate` | `{path, to, duration_ms, curve?: linear\|smoothstep\|equal_power_out\|equal_power_in\|step, from?, unit?: scalar\|gain_linear}` — numbers + gain slots; starts now; `from` defaults to the current value and is range-checked like `to`; `gain_linear` only on `gain.*` | `{corr, targets}` (a broadcast alias matching nothing: `targets: []`, like `set` — M13); `anim.done {corr}` per finished animation | `bad_type` (non-numeric), `out_of_range` (`to`/`from`), `bad_request` (unit), graph codes | `ctl animate '{"path":"lay:DP-1:main.opacity","to":0,"duration_ms":500}'` |
| `transition` | `TransitionReq` (§ Transition recipe): `{outputs, to, effect_id?, params?, duration_ms?, method?, align?}` | `{corr, to: B's id}` (`parked: true` when no output exists — § Runtime, I4) | `no_such_effect` (not in the catalogue — hint: `ctl effects`), recipe codes | `ctl transition '{"outputs":"out:*","to":{"path":"/w/b.mp4"},"effect_id":"fade","duration_ms":1000}'` |
| `cancel` | `{corr}` | `{}` | `no_such_node`, `unsupported` (after handoff) | `ctl cancel '{"corr":"tr-12"}'` |
| `program.play` | `{id, from?: "start"\|"resume"\|"index", index?, keep_pause?: false}` (§ Programs "Playlist start"; no `from` = `index` with an index, else `start`) | `{corr, path, index, resumed}` — `corr` null + `resumed: true` = the same key's playlist already plays (nothing switched) | `no_such_node` (no such program), `unsupported` (empty program — hint: the `programs` probe), `out_of_range` (index), `bad_request` (`from`) | `ctl program.play '{"id":"prog:main","from":"resume"}'` |
| `program.next` / `program.prev` / `program.random` | `{id, keep_pause?: false}` | `{corr, path, index}` — `corr`/`path` null = nothing to do (previous at the session's first item, nothing playable) | `no_such_node`, `unsupported` (empty) | `ctl program.next '{"id":"prog:main"}'` |
| `state` | — | `{graph (Graph::snapshot), transitions (status), programs (§ Programs, `ProgramStatus`), clock {mode, now_ms}, outputs [{name,width,height,hz,refresh_mhz}], backend (headless\|wayland), sources (hosted ids), parked, workers (the `workers` probe's entries, Task 5)}` | — | `ctl state` |
| `subscribe` | `{topics: [kind prefix…]}` (`""` = all; additive) | `{topics}` | — | `ctl subscribe transition. source.` |
| `capture` | `{target: out:<n> \| lay:<n>:main \| <source id>, path (absolute)}` | `{path, width, height}` — deferred until the file is written (the client's later requests wait, like `step`'s); the picture is the one at the request | `no_such_node`, `unsupported` (no frame yet), `io` | `ctl capture '{"target":"out:DP-1","path":"/tmp/dp1.png"}'` |
| `logs` | `{comp?, corr?, min_level?, kind_prefix?, limit? (200, ≤ 10000)}` | `{events: [records, oldest first]}` | — | `ctl logs '{"corr":"tr-12"}'` |
| `probe` | `{name, args?}` | the probe's result | `no_such_probe` | `ctl probe '{"name":"sources"}'` |
| `effects` | — | `{ids}` (catalogue order; `[]` without `transitions/`) | — | `ctl effects` |
| `stop` | — | `{stopping: [ids]}` | — | `ctl stop` |
| `quit` | — | `{}` (then the process exits 0) | — | `ctl quit` |
| `step` | `{ms}` (0–600000) | `{now_ms}` (deferred until every frame is in; the client's later requests wait for it) | `unsupported` (real clock), `timeout`, `busy` (64 queued) | `ctl step '{"ms":16}'` |
| `headless.add_output` | `{name, width, height, hz? (60)}` | `{id: out:<name>}` | `out_of_range`, `unsupported` (exists / not headless) | `ctl headless.add_output '{"name":"VIRTUAL-3","width":1920,"height":1080,"hz":60}'` |
| `headless.remove_output` | `{name}` | `{}` | `no_such_node`, `unsupported` | `ctl headless.remove_output '{"name":"VIRTUAL-2"}'` |
| `headless.pointer` | `{output, x, y, buttons? (0)}` — surface px from the top-left (Task 7) | `{scenes: [ids the pointer reached]}` | `no_such_node`, `out_of_range`, `unsupported` | `ctl headless.pointer '{"output":"VIRTUAL-1","x":960,"y":540}'` |

**Error codes** beyond the graph's (§ Graph & properties): `bad_request` (not JSON / no
`cmd` / bad args), `no_such_verb` (hint lists every verb), `no_such_effect`,
`no_such_probe`, `timeout` (a step's frames; `ctl`'s reply wait), `busy` (step queue
full), `io` (capture write, ctl connect).

**Event kinds** (subscribe by prefix): `transition.scheduled|started|handoff|done|
cancelled|failed|graph_error` (the recipe's outbox, R37), `source.ready|ended|position`
(runtime, `position` is debug-level ~10 Hz, every change in stepped mode),
`source.retire|parked|unparked` (runtime), `source.error|rejected|open|teardown|drop`
(host), `source.broken` (a scene past its restart budget, § Scene worker), `scene.context_lost|resuming|
resumed|preview|preview_failed|restored_broken` (Task 10, § Scene worker → "Crash policy"),
`worker.killed`, `gfx.context_robust`, `transition.output_adopted`, `output.added|removed|changed|layer_failed|
present_failed`, `wl.connected|surface_ready|surface_closed|surface_recreated|layer|
gl_error|duplicate_output|pointer_error|driver_env|default_queue_failed` (the last two Task
20e), `input.pointer` (debug), `loop.failed`,
`anim.start|done|dropped`,
`api.client_connected|closed|dropped|tap_overflow`, `player.started|stopped|quitting|exit`,
`step.timeout`, `source.frame_refetched`, `render_worker.started|unavailable|stopped|died|
attach_failed|lane_failed|hwdec_interop|cuda_init|attach|free|first_render` (§ Sources "Render
worker", "Hardware decoding"), `loop.long_busy {ms, open_ms}` (debug: a synchronous loop stretch
≥ 50 ms, to line a hitch up with what else happened), `mpv.reaped`, `mpv.trimmed` (debug, Task 20b), `mpv.reaper_stragglers`,
`mpv.options_skipped` (a script trim this libmpv doesn't know, once per process), `effects.missing`,
`supervisor.restart` (the restarted child, first thing) | `child_exited|giving_up|
stop_timeout|spawn_failed` (the supervisor, appended to the shared log),
`snapshot.restored|none|invalid|dropped|source_failed|prop_rejected|saved (debug)|
write_failed|write_recovered`, `test.crash`,
`audio.bus.up|down|not_ready|retargeting|retarget_failed|moved|latency_shots|latency_unmeasured|thread_panicked`,
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
`loadfile`; the core itself is made on the `lia-open` worker, § Sources), iterations, wakes, wake_pending, wake_fds, clients,
subscribed_topics, tap_dropped, reaper_pending, uptime_ms, gain_timer_armed, gain_ticks,
gain_pushes, pause_gates, dropout_windows_open, bounds (§ Runtime "Bounds"),
recent_gain_pushes}`; `sources` also has `mpv_current_ao` and top-level `opening` + `open_pool`
`{cap, workers, running, queued, peak, skipped, pending}` (the `lia-open` pool, § Sources "Async
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
`sources` also has `mpv_hwdec_current` (what `hwdec: auto` resolved to), `mpv_hwdec` (what we
asked for — copy modes, Task 20d, unless the render context loaded the worker's GL interop) and
`hwdec_interop` (that interop, or null), plus top-level `render_worker` (null with the worker
off: summed lane counters, `hwdec_interop`, `lanes` — § Sources "Render worker"); `snapshot` (Task 16,
`probe/snapshot.rs`) — `{path, writes, failures, last_write_ms, since_last_write_ms,
due_in_ms, frozen, current (what would be saved now)}`. `sources` also has
`mpv_audio_device` / `mpv_audio_delay` (what mpv really runs); `workers` (Phase 2 Task 5,
`probe/workers.rs`) — one entry per scene source's worker (§ Scene worker; `args: {"log_tail":
true}` adds each one's `log_tail`, Task 13); `vram` (Phase 2
Task 8, `probe/vram.rs`) — the VRAM sampler, the low-VRAM rule and its hold, each scene worker
against the per-scene limit (§ Scene worker → "GPU budget and VRAM (Task 8)"). A new probe = a
file here + one `PROBES` entry.

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
6. What an mpv core itself did (a VO that gave up waiting for a render, a decoder that never opened):
   `LIASCAPE_PLAYER_MPV_LOG=v` in `serve`'s environment prints every core's mpv log to stderr
   (`liascape-player-serve.log` under the backend) as `[mpv <file> <t_mono s>] <level> <prefix>: <text>` — the
   time is when the loop PUMPED the line, not when mpv logged it: a burst of lines at one instant means
   nothing pumped that source meanwhile. Without it only `error` lines are requested.
7. Audio specifically (a dropout, a glitchy fade): `docs/player/debugging.md` — symptom →
   probe/log query → likely cause, seeded with the bugs the reference monitor
   (`probe dropout`, Task 15) found in the legacy engine, plus `meter.window`/`bus`.

## Wayland

`src/wl.rs` + `src/redraw.rs` + `src/probe/frames.rs` (spec §4.2 "Output", §5.1
"Graphics"; Task 13). `liascape-player serve` without `--headless` draws the wallpaper on every
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
| namespace | `liascape-player` (`hyprctl layers`) |
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
  t20e_wayland_present_heap_stays_flat` (opt-in `LIASCAPE_PLAYER_TEST_WAYLAND=<socket>` — it draws
  on that compositor for ~25 s; SKIP otherwise): a 60 s colour fade on every output, heap
  growth per present over 10 s < 32 B (GREEN 2.3 ×2; RED with `__NV_DISABLE_EXPLICIT_SYNC=0`
  226.6 B/present). **Damage:** every present redraws the whole surface and `eglSwapBuffers`
  posts full damage — no buffer-age/partial damage.
- The EGL config has alpha 8, so the buffer is ARGB: alpha is forced to 1 at present (and
  the opaque region set) so the compositor never blends what's below the wallpaper.

**`tests/onmachine/outputs.sh` (run manually, exit 0 = pass; Hyprland + DP-1/DP-2 by
default, `OUT_A`/`OUT_B`/`HZ_*`/`MEAN_*`/`TOL_MS` to adapt).** Builds the release binary
(or `LIASCAPE_PLAYER_BIN`), makes synthetic ffmpeg clips, stops the legacy wallpaper (`/stop`,
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
an `EXIT` trap restores the focused monitor + cursor, kills `serve` (no liascape-player layer may
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
 mpv src1 (audio-device=pipewire/liascape-player-bus) ─┐
 mpv src2 ─────────────────────────────────────┼─▶ liascape-player-bus ──(same cycle)──▶ liascape-player-bus.playback ──▶ default sink
    …                                          ─┘   Audio/Sink        loopback      Stream/Output/Audio          (re-targeted on
                                                        │                            node.target = default         default.audio.sink
                                                        └─ monitor ──▶ liascape-player-bus.meter (capture, the Meter)   changes)
```

**Identity contract (Task 17's auto-mute excludes the bus by it — verbatim):** playback
stream `node.name = liascape-player-bus.playback`, `application.name = liascape-player`, `media.role =
Wallpaper`; sink `node.name = liascape-player-bus`, `node.description = "liascape-player bus"`,
`media.class = Audio/Sink`, `audio.position = [FL FR]`. Constants in `audio::bus`
(`PLAYBACK_NAME`, `APP_NAME`, `MEDIA_ROLE`, `SINK_NAME`, `SINK_DESCRIPTION`). The meter is
`liascape-player-bus.meter` (a capture stream). Note mpv streams also carry `application.name =
liascape-player` (`audio-client-name`) — auto-mute must exclude by ownership/target, not that name
alone (spec §4.4).

**`Bus::start()`** (serve startup only; **never blocks** — `Err` only for
`LIASCAPE_PLAYER_BUS=off` or no thread): thread `lia-bus` runs its own
PipeWire main loop + context + core (nothing uses `RT_PROCESS`: every callback runs on that
thread; capture buffers carry their cycle time, `pw_buffer.time`). Two roundtrips (globals,
then the `default` metadata's properties) → `default.audio.sink` → `pw_context_load_module(
"libpipewire-module-loopback", args)` (declared by hand — not in pipewire-sys's
`wrapper.h`) with `capture.props = {media.class = Audio/Sink, node.name = liascape-player-bus,
node.description = "liascape-player bus", audio.position = [FL FR]}` and `playback.props =
{node.target = target.object = <default>, identity…}` → waits until the playback is linked
to a sink (≤ `CREATE_TIMEOUT` 5 s) → **latency** → up: `audio.bus.up {device, latency_ms,
latency_samples, quantum_ms, target, reconnected, generation, setup_ms}` (logged by the bus
thread for every session). `setup_ms` measured 83–93 ms on the private test PipeWire; on the
owner's session the old startup's `wl.connected` → `audio.bus.up` (EGL + catalogue + the bus,
in a row) was 176–300 ms in 45 of 50 starts since 2026-10-22 — and 963 ms – 13 s in the other 5
(one the cold boot below). `Bus::wait_up(started, deadline)` is serve's bounded wait for the
first session (below). `Bus::device()` = `pipewire/liascape-player-bus`;
`Bus::state()` = `Up | Retargeting | Down`; `Bus::route()` = `(up, generation)` (one atomic
word, so a reader never sees half a change); `Bus::info()` = everything the `bus` probe shows.
`LIASCAPE_PLAYER_BUS=off` disables it (no thread, no retry).

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
liascape-player`) as every mpv source. Without care, our metadata re-targets were saved as a
"user choice" target and would be restored onto any later liascape-player stream without its own
target (e.g. mpv in the fallback), pinning it to a stale sink. Every bus stream therefore
carries `state.restore-props = false` + `state.restore-target = false` (the bus also
always starts at 0 dB). `bus.sh` asserts no `target` gets saved. Don't set
`application.id` on the context: it changes the key.

**Latency rule.** `Bus::latency()` = what the bus adds, measured once at creation with an
impulse: a probe stream plays one −60 dBFS sample (inaudible) into the bus while two
captures watch the bus monitor (`stream.capture.sink`) and the bus playback's *output*
(`target.object = liascape-player-bus.playback` — WirePlumber links stream→stream); both are
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
The callback never blocks or allocates (staging buffer + `try_lock`) and runs on PipeWire's
**real-time data thread** (`RT_PROCESS`, Phase 2 Task 14 — `data-loop.0`, `SCHED_RR` via
rtkit): on the non-RT `lia-bus` main loop it missed whole graph cycles whenever a switch loaded
the machine (a worker spawning, a source torn down) — measured in 245 of 301 on-machine
switches, each a timestamp jump of 1–5 quanta plus silent blocks the dropout detector has to
call `unmeasured`. Guard `tests/api.rs::meter_capture_runs_on_the_rt_data_thread` (RED:
`lia-bus`, `other`). `Meter::window(from, to)`,
`Meter::available()` (streaming, newest sample ≤ 500 ms old, no error), `Meter::status()`.

**Probes.** `bus` → `{state, device, latency_ms, latency_samples, quantum_ms, target,
default_sink, requested, overridden, playback_node, sink_node, retargets, connecting (down and
the thread still setting up / retrying; `false` with no bus at all), generation, reason (while
down: what it waits for — "connecting to PipeWire", "PipeWire connected; waiting … for a
session manager (WirePlumber) to link the bus loopback", or the last failure), now_ms,
meter {available,
streaming, samples, last_ms, quantum_frames, dropped, error, callback_thread, callback_policy
(other|fifo|rr)}}` (`now_ms` on the `t_mono_ms`
clock). `meter.window {last_ms} | {from_ms, to_ms} [, samples: false]` → `{from_ms, to_ms,
count, median_db, min_db, max_db, max_gap_ms, first_ms, last_ms, samples: [[t_ms, db]…]}`;
an unavailable meter is an **`unsupported` error saying why** (never an empty "all quiet").

**Fallback.** `--ao <anything but pipewire>` → no bus (`--ao null` would only add a sink to
the owner's session for nothing) and `LIASCAPE_PLAYER_BUS=off` → none either: logged once
(`audio.bus.down {reason}`), never retried. Otherwise the bus is never given up on.
**Cold boot (2026-10-29, the owner's machine):** Hyprland's `liascape restore` started the
player before WirePlumber was up; `serve` blocked 10 s in the old `Bus::create` (the loopback
never linked) with the socket bound but the loop not running — every `hello` timed out, the
backend failed requests fast and the restore's switch failed (no wallpaper) — and that first
failure was final: no bus for the whole process although PipeWire was up seconds later. Now:
the bus thread starts right after the bind and the compositor connection (a start still waiting
for its compositor never loads a sink into the session on every retry) and connects in the
background while EGL and the catalogue come up; `serve` waits for its first session at most **`BUS_STARTUP_WAIT` = 500 ms**
from that start (a normal start is up well inside it — the numbers above — so its sources open
straight onto the bus; on a boot where the audio server isn't ready it delays the first answer
by at most that — under the backend's 1 s spawn probe (`Reachable`'s `hello`; a timeout opens
its 3 s stall breaker) —, measured `hello` 644–707 ms after spawn vs 210–247 ms when the server isn't
there at all, 5212 ms before), then runs the loop regardless (`audio.bus.not_ready {waited_ms,
reason}`, warn, if the session is still setting up). A first session that fails (PipeWire
unreachable: at once; no session manager linking the loopback: after `CREATE_TIMEOUT`) is
`audio.bus.down {reason}` (warn) and goes into the I7 backoff below like a lost connection; a
first session that comes up after the wait ran out, or any later one, is `audio.bus.up
{reconnected: true, generation}` and moves every source onto the bus by the route. Meanwhile
sources play on mpv's default device (no `audio_device`, no bias) — under a daemon without a
session manager mpv's own stream isn't linked either, so a video shows its first frame and its
clock (the audio's) waits until WirePlumber links it —, scene workers' streams take the default
route (`ToWorker::Route` onto the bus later), the meter is unavailable (`audio bus down
(<reason>)`; its capture stream starts with the session), and `ctl probe '{"name":"bus"}'` says
`down`, `connecting: true` and why. A quit during the setup exits at once (its waits end on the
`Bus` drop; measured 70 ms). **A connection lost later is re-created (final
review I7):** the `lia-bus` thread runs the bus as *sessions* (`bus::session`) — a core error ends
one (`audio.bus.down {reason}`; the loopback module is *not* destroyed by us then: it unloads
itself on a core error, and destroying it too was a measured double free), sources are re-routed
to mpv's default device (`Bus::route()` = `(up, generation)`, polled by `Runtime::
track_bus_route` every tick → `SourceHost::set_audio_route`, `audio.bus.sources_rerouted`), and
the bus retries with backoff (0.5 s, doubling ≤ 10 s; `audio.bus.reconnecting {attempt}`,
`.reconnect_failed {reason}`) until a new session is up (`audio.bus.up {reconnected: true,
generation}`; latency re-measured; the meter's capture stream re-created on the same
`MeterShared`) — then every source goes back onto the bus with its ramp-in held on `gain.pause`
until its rebuilt audio chain flows (invariant #8). The first session's setup failing takes
the same path (above). Shutdown: `Runtime::shutdown` destroys every source first, then
`Audio::close` (`audio.bus.down {reason: "shutdown"}`), so no stream is moved to the default
sink on the way out; a killed player's sink goes with its PipeWire connection.

**Tests.** `tests/api.rs::bus_down_falls_back_to_default_device` (PipeWire made
unreachable: empty `PIPEWIRE_RUNTIME_DIR` + bogus `PIPEWIRE_REMOTE`; image source, so
silent; down + `connecting`, then it keeps retrying — `reconnecting`/`reconnect_failed`, never
up), `ao_null_runs_without_bus`, the cold boot (private PipeWire, `PrivatePw::start_daemon` /
`start_session_manager` start the two daemons apart):
`bus_comes_up_when_pipewire_starts_after_the_player` (nothing running at spawn; RED before: the
bus never came up in 20 s), `serve_answers_at_once_while_wireplumber_isnt_up_yet` (the daemon
without WirePlumber; RED before: `hello` 5212 ms after spawn) — both: `hello` < 2 s after spawn,
the bus probe down + `connecting`, a looping video created and on screen on mpv's default
device, then the audio server started → `audio.bus.up {reconnected: true}` on its own, the
video on `pipewire/liascape-player-bus` with a live AO, its tone on the meter, the ramp-in
`onset.started {slot: pause, reason: flowed}` —, `scene_moves_onto_a_bus_that_comes_up_late`
(a tone scene's worker on the `default` route, then `{device: …bus}`, same pid, the tone on the
bus), `quit_while_the_bus_waits_for_wireplumber_is_prompt`;
**`i7_bus_reconnects_after_pipewire_restart`** (also: a normal start's first session is
`reconnected: false`, no `not_ready`) — a *private, hermetic* PipeWire + WirePlumber (`PrivatePw`: own runtime/config/state dirs, no
D-Bus, WirePlumber's `policy` profile so no ALSA/Bluetooth/V4L2 monitor ever opens a device,
one null sink; skipped without the binaries; the owner's PipeWire is never touched): tone on
the bus → both daemons killed → `down` + sources on `auto` → restarted → `up {reconnected}` +
sources back on `pipewire/liascape-player-bus` with a live AO, the tone on the bus again, the ramp-in
`onset.started {slot: pause, reason: flowed}`; unit tests in `meter.rs` (RMS/floor/max-channel/
carry/ring/clock) and `bus.rs` (args, default parsing). **On-machine: `bash
src/player/tests/onmachine/bus.sh`** (exit 0 = pass; real audio, R56): its own temp
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME` for the liascape-player socket while PipeWire/Pulse reach the
real session (`PIPEWIRE_RUNTIME_DIR=/run/user/$UID`, `PULSE_SERVER=unix:/run/user/$UID/
pulse/native`), `--headless`, `WAYLAND_DISPLAY` unset (R55); stops a legacy mpvpaper first;
a `trap … EXIT` restores the default sink exactly and checks no `liascape-player-bus` sink is left
(R57), deletes every `target.node`/`target.object` metadata entry on the nodes serve owned
(live ones before quitting, dangling ones after — never an id another node reuses) and, if
WirePlumber ever saved a `target` for liascape-player, clears it (silent stream + `target.object
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

`src/supervise.rs` + `main.rs` (spec §4.1 "Supervision"; Task 16, R72/R73). `liascape-player
serve …` **is the supervisor** unless `--no-supervise`: before any thread, GL context or
PipeWire connection exists it fork+execs `/proc/self/exe serve --supervised [--restore]
[--restarted <spec>] <the user's options>` (`--session-start` only on the first child — a restart is a recovery,
never a playlist start) (argv[0] kept; the child sets its comm back to
`liascape-player` — exec of `/proc/self/exe` would make it `exe`), then only waits and forwards
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
  can look identical from outside (`liascape-player serve --ao null` on a session starting
  before its compositor) but need opposite handling: "already running" burning the crash
  budget would just waste restarts on something a restart can't fix, while a hard exit 1
  on "not ready yet" would mean `liascape-player` loses every boot race against its own
  compositor coming up a moment later.
- **Clean exits end supervision** (`classify`): child exit 0 (quit, SIGTERM/SIGINT), 1
  (`ServeError::Startup`, above), 2 (usage). The supervisor exits with the same code.
- **`EXIT_NO_COMPOSITOR` gets its own backoff, not the crash budget:** [`run`]'s loop
  retries with a doubling delay — `COMPOSITOR_WAIT_INITIAL_DELAY` 0.5 s, then 1 s, 2 s,
  4 s, … — logging `supervisor.waiting_for_compositor {pid, uptime_ms, delay_ms,
  waited_ms, budget_ms}` (warn) before each sleep, until the *next* delay would push the
  running total past `compositor_wait_budget()` (`COMPOSITOR_WAIT_BUDGET` 30 s in
  production; the test-only env knob `LIASCAPE_PLAYER_TEST_COMPOSITOR_WAIT_MS` shortens it so a
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
- **Test knob:** `LIASCAPE_PLAYER_TEST_CRASH=startup` → every child logs `test.crash` and aborts
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
  the supervisor; the child's PDEATHSIG SIGTERM — its `player.quitting {why: signal}` — must be
  stamped ≤ 300 ms after it (measured 3.5–10.3 ms under CPU + IO load), and the child must
  exit on its own within 30 s — its clean quit fsyncs the final snapshot, 0.1–11.8 s under IO
  load, which failed the old 300 ms bound on the whole exit; asserted directly, no fallback kill
  of ours in the way, so `Sup::drop`'s own teardown fallback never masks a PDEATHSIG
  regression). Snapshot preconditions wait `SNAPSHOT_WAIT` (20 s, condition-based). `tests/api.rs` runs
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
  demuxer_*, af, no_audio, audio_delay), playing, transition_target, broken (Phase 2 Task
  10: a scene past its restart budget — only when true; restored as its preview, no worker)}`;
  `parked` — `{id,
  resume_paused, connector}`; `programs` (Phase 3, only when there is one) — each program's dynamic state
  (§ Programs "Persistence"; its configuration is `program.json`, written by the same thread). Source keys are references inside the file only: a restore
  mints fresh ids (`snapshot.restored.ids` maps old → new).
- **Excluded:** effects, `snapshot`-kind sources, sources no output shows (graves, held A's,
  anything created but not shown), every in-flight transition's scaffolding. **A transition
  in flight is saved as its target B** on the outputs it covers (`transition_target: true`,
  `paused: false`, no xfade/anticlick, its position = its requested start until it plays) —
  **except an `align: end` one before Running** (2026-10-28), saved as **A where it plays**: B
  restored at once cut A's remaining play short, and the backend re-arms the switch on the
  restarted player (player-adapter.md § Reconnection; A keeps the `loop: false` its wait set —
  without a backend it holds its last frame). `TransitionStatus.align` (also in `state`'s
  `transitions`) carries it. Unit `aligned_pending_transition_is_saved_as_a` (RED: `bnew`).
  An effect shown without a transition is saved as its `to` side.
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
- **Writing:** on the `lia-snapshot` thread (latest queued wins): `snapshot.json.tmp` +
  `fsync`, rename, `fsync` the dir — a crash mid-write leaves the previous file. Failures:
  `snapshot.write_failed` once per streak (+ hint), `write_recovered`; `snapshot.saved
  {bytes, write_ms}` at debug. The writer is joined in `shutdown`. **The window is the
  backend's to close:** a write lags a switch by the debounce + its fsync (2.4 s once under
  I/O load), so a crash in it restores the wallpaper before the switch; a switch's reply can't
  wait for an fsync, so the adapter compares what a restarted player shows with what it last
  switched to and switches back (player-adapter.md § Reconnection, `ReconcileShown`).
  **Test knob** `LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS=N`: every write takes N ms more (counted in
  `write_ms` / the probe's `last_write_ms`) — a snapshot that lags and a slow clean quit,
  deterministically (the adapter IT).
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
logged as `mem.policy` right after `log::init`, Warn on an unknown `LIASCAPE_PLAYER_MALLOC` value):

- **Fixed mmap threshold, `mem::MMAP_THRESHOLD` = 128 KiB** (`mallopt(M_MMAP_THRESHOLD)`,
  which also turns glibc's dynamic adjustment off). glibc starts at 128 KiB but raises the
  threshold to the size of any mmapped chunk that is freed (≤ 32 MiB): after the first mpv
  core is destroyed, a 1080p frame-pool buffer (~3 MiB) or demuxer block no longer gets its
  own mapping but comes from one of ~57 per-thread arenas (8 × cores max), and an arena
  keeps what it frees. Fixed, an allocation ≥ 128 KiB that no free chunk of its arena fits
  gets its own mapping (fresh `mmap`, unmapped by `free`) instead of growing the arena. The caller's own choice wins (`MALLOC_MMAP_THRESHOLD_`, or
  `glibc.malloc.mmap_threshold` in `GLIBC_TUNABLES`).
- **`malloc_trim(0)` after each reaper batch** (`mem::trim_after_reap`, on the
  `lia-mpv-reaper` thread once its queue is empty — never the loop): the smaller chunks a
  destroyed core frees still fragment the arenas (+0.35 MiB retained per switch with the
  threshold alone); the trim returns those pages. Measured ≤ 2.4 ms (1.4 ms mean) per
  switch with the threshold in place; `mpv.trimmed {ms, released, rss_kib}` (debug). Skipped
  once `reaper::shutdown` has started (exiting — § Sources "Teardown").
- **No arena cap.** `M_ARENA_MAX` 4 on top changed little (373 vs 380 MiB after 300
  switches) and adds lock contention across the ~30 decoder/demux/audio threads.
- **`LIASCAPE_PLAYER_MALLOC=glibc`** skips the whole policy (A/B; the regression test's RED run);
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
gives back < 5 % of RSS — near-vacuous under the policy, growth is the meaningful check; with `LIASCAPE_PLAYER_MALLOC=glibc` 32 % / 13.6 % → fails).
`docs/player/debugging.md` row "RSS grows per switch".

## Scene worker

Phase 2 (plan `docs/superpowers/plans/2026-10-27-liascape-player-phase2-scene-worker.md`, Tasks
1–13 plus the scene-properties editor and loudness learning; spec §4.1, §5.2, §6.3; evidence
`docs/player/spikes/dmabuf.md`; only the on-machine battery, Task 14, is still to run). A WE scene
renders in its own `liascape-scene-worker` process — **one per scene source, shared by every output
showing it** (D1) — the compositor drives it over a socket and samples its frames.
`src/worker/` is the compositor side, `src/bin/liascape-scene-worker/` the worker. This section is
organised by the task that built each part; the subsections below are the as-built source of
truth where they disagree with the plan or with the Task 3 text directly under this paragraph.
Map: protocol + lifecycle (here) · "Frame transport" · "LWE core" · "The `scene` Source kind" ·
"Real scenes" · "Scene audio" · "Scene loudness" · "GPU budget and VRAM" · "Transitions with
scenes" · "Crash policy" · "Scene corpus".

**Protocol (`worker/proto.rs`, `PROTOCOL` 4 — bumped by Task 6, audio, and twice by scene loudness; the
shapes below are Task 3's plus the additions named inline and in the later subsections: `Start` also
carries `id`, `gain_db`, `no_audio`, `speed`, `properties`, `loudness`; `ToWorker::Speed`, `ToWorker::LoudnessMeter`; `FromWorker::Loudness`).** One JSON object per `SOCK_SEQPACKET`
datagram, ≤ `MAX_MSG` (64 KiB), fds on the same datagram via `SCM_RIGHTS` (≤ `MAX_FDS` 8).
Internally tagged by **`msg`** (snake_case variant name — not `t`, which `Tick`/`Frame` use
for scene time): `{"msg":"tick","seq":3,"t":0.02,"input":null}`. `ToWorker`: `start {path,
assets_dir, steam_dir, position, paused, audio, max_size, synthetic, properties}`, `tick {seq,
t, input}`, `release {slot}` (+ optional release fence fd), `gain`, `paused`, `no_audio`,
`route`, `pointer {x, y, buttons}` (native scene px), `set_property {name, value}` (Task 7),
`resize {max_size}`, `ping {seq}`, `quit`. `FromWorker`: `hello
{protocol, pid, features, sync}` (first message; `features` ⊂ `stub|synthetic|lwe`, `sync` =
`fence|fdpoll|none`), `buffer {slot, w, h, fourcc, modifier, planes}` (+ one fd per plane),
`frame {slot, seq, t, gpu_ms}` (+ acquire fence fd, none in fdpoll), `ready {native,
has_audio, wants_audio_input}`, `has_audio`, `audio_flowing`, `envelope`, `property_set {name,
ok, reason}` (Task 7), `pong`, `error {reason, fatal}`, `context_lost`, `log`.
`AudioRoute` = `"null"|"default"|{"device":"…"}`; a `modifier` is a JSON integer (u64, exact).
`proto::send` refuses > 64 KiB / > 8 fds (`InvalidInput`), sends `MSG_NOSIGNAL` (a gone peer
is `EPIPE`, never SIGPIPE); `proto::recv` never blocks — `Ok(None)` nothing queued,
`Err(UnexpectedEof)` peer gone, `Err(InvalidData)` an oversized/garbage/unknown datagram (it
is consumed and its fds closed; the next one parses). Received fds are `CLOEXEC`.

**`WorkerHost` (`worker/mod.rs`) — one worker process, supervised.**
`WorkerSpec::new(id, bin, start)` = production defaults (`args` [], `env` [],
`hang_timeout` `HANG_TIMEOUT` 2 s, `budget` 3 per 60 s, `crash_dir` `paths::crash_dir()` =
`<state>/crashes/`); tests set `args: ["--stub"]`, a short budget/timeout, a private dir.
States: `Starting` (spawned, no `Hello`) → `Running` (the host answers `Hello` with the
spec's `Start`) → on a crash `Restarting {attempt}` → `Running` …, or `Broken {reason}`, or
`Stopped`. `poll(now)` never blocks: drains output + messages, runs the heartbeat, reaps,
restarts — call it on every wake **and** regularly (time must pass for a hang to show).
Events: `Msg(FromWorker, fds)` (everything but `Pong`), `Exited {signal|code}` (every
process end, hung or not), `Hung {waited_ms}`, `Restarted {attempt}`, `Broken {record}`.
- **Spawn = `posix_spawn` on the calling thread** (glibc: `clone(CLONE_VM|CLONE_VFORK)`, no
  page-table copy of the compositor — measured 0.24–0.35 ms per `spawn()` in the test
  binary), not `fork` on an `lia-open` pool thread as the plan had it: **`PR_SET_PDEATHSIG`
  fires when the spawning *thread* exits** (`prctl(2)`), and the pool's threads exit when
  idle — every worker would die with them. So Task 5 spawns from the loop thread. The worker
  sets `PR_SET_PDEATHSIG(SIGKILL)` itself, first thing, then exits 3 unless `getppid()` ==
  `--parent-pid` (the parent died before the prctl). Child fds: socket end at **fd 3**
  (`--fd 3`), stdout + stderr on one pipe (the log tail), stdin `/dev/null`; the parent's
  copies are `CLOEXEC` and renumbered ≥ 10 first, so no `dup2` clobbers another and fd 3 never
  equals its source (an `adddup2(3, 3)` would keep `CLOEXEC`). Empty signal mask + default
  dispositions for SIGPIPE/INT/TERM/HUP/QUIT/CHLD/USR1/USR2/ALRM (the compositor blocks
  SIGINT/SIGTERM for its signalfd). Env = the compositor's + `spec.env` (overriding).
- **`wake_fd()` is an epoll fd** over the current socket + output pipe — stable across
  restarts (a dup of the old socket would read EOF forever after a restart: a busy loop),
  readable whenever `poll` has work. The host owns it; register a dup, like mpv wake fds.
- **Crash = socket EOF or the process gone** (`waitpid(pid, WNOHANG)`; spike §6). A process
  that closed its socket but lives on is SIGKILLed after 1 s. On reap: output drained to
  EOF (so a crash's last stderr lines make the record), `Exited`, then the budget:
  `RestartBudget::admit(history, now)` (sliding window, unit `budget_window_slides`) →
  respawn with the **last `Start` at `set_resume_position`** → `Restarted {attempt}` (1, 2,
  3), or `Broken` + a crash record. `restarts(now)` = (in the window, total).
- **Heartbeat.** `send` records every `Tick` (answered by any `Frame` with `seq` ≥ it) and
  `Ping`; the oldest unanswered one older than `hang_timeout` → SIGKILL + `Hung` (+ `Exited`
  once reaped, then the restart policy). No ticks flowing → `Ping` every `PING_INTERVAL`
  (1 s), **shortened to `hang_timeout / 2`** so a hang is always seen within 1.5 ×
  `hang_timeout` (the plan's 1 s ping could not meet `hang_after_ms 100, hang_timeout 300 →
  Hung ≤ 600 ms`); the cadence counts from the last `Tick`/`Ping` sent (`last_beat`) — other
  traffic (gains, the pointer) never postpones a ping. No `Hello` within `HELLO_TIMEOUT` (5 s,
  or `hang_timeout` if longer) = hung too. The worker keeps answering while LWE loads + builds
  (its `lia-scene-proto` thread answers pings during a load, bounded — § "Real scenes (Task 7)").
  **"Hung" = the worker is the reason no frame comes** (2026-10-29, the suspend false-kills —
  `docs/player/reports/phase2.md` § 8), so two waits are not counted:
  - **Starved of slots.** The host tracks the worker's ring (the latest `Buffer` set — a new
    size starts a new ring: a ring is exported whole before any frame of it, a `resize` always
    changes the size) and the slots it holds (a `Frame` named it, no `Release` sent yet). While
    it holds **every** slot, the worker can't render a tick (the renderer waits in `recv` for a
    `Release`) — its outstanding ticks are re-stamped each poll (their age doesn't count) and
    its liveness is the **ping** (sent while starved even with ticks outstanding; the idle
    renderer answers it — and, robust, polls `glGetGraphicsResetStatus` on it, since a starved
    renderer renders no frame to poll after). Bounded: starved with a tick waiting for more than
    **`STARVE_LIMIT_FACTOR` (5) × `hang_timeout`** (10 s) = hung all the same (`worker.hung
    {starved_ms}`) — slots that never come back (a fence that never signals: a dead GPU
    timeline) are recovered by a restart's fresh ring. Paused (no ticks) holds slots freely.
  - **Reads and reaping follow readiness (F6b).** `poll` = `poll_io(now, true)`: one
    `epoll_wait` of the host's own set, then only the readable socket / pipe is read;
    `waitpid` on every poll once the worker is ending (EOF on either, or killed), else at most
    every `REAP_CHECK` (100 ms). `poll_io(now, false)` (the caller's epoll just said the host's
    fd isn't readable) skips the reads, keeping the heartbeat and the reaping.
  - **The host's own stall.** A gap between two `poll`s longer than **`host_stall_gap` =
    `hang_timeout / 2`** (1 s; production polls at the loop's tick rate, ≤ 17 ms apart) means the
    compositor itself didn't run (blocked in the driver while the whole GPU was busy): every
    outstanding tick/ping (and a pending `Hello`) gets a fresh `hang_timeout` from that poll,
    `worker.host_stalled {gap_ms, outstanding, hello}` (info). A worker that freezes while the
    host keeps polling is judged exactly as before. Suspend time itself never counted
    (`Instant` = `CLOCK_MONOTONIC`, stopped in S3).
  Tests (`tests/worker.rs`, stub `ring:3` / `freeze_*`): `starved_worker_is_not_hung` (4 ×
  the timeout with every slot held: no `Hung`, the waiting tick framed into the released slot at
  once — RED before: `Hung {waited_ms: 302}`), `starved_worker_that_hangs_is_still_killed`
  (`hang_after_ms 600`: `Hung` within 900–1150 ms — the usual bound), `starved_forever_is_killed_after_the_starve_limit`,
  `host_stall_is_not_a_hang` (no poll for 900 ms, the worker back 150 ms after the host — RED
  before: `Hung {waited_ms: 900}`, incident 2's signature), `worker_freeze_while_the_host_polls_is_hung`
  (< 400 ms); `tests/scene.rs::gpu_stall_that_starves_the_worker_is_not_a_hang` (the real
  renderer, synthetic `gpu_stall: [500, 1500]` at a 300 ms timeout: a 1.5 s latch gap, 0
  restarts, frames flow again from the same worker — RED before: 3 restarts).
- **`send` while not connected** (before `Hello`, `Restarting`, `Broken`, `Stopped`):
  `Start`/`Paused`/`Resize`/`Route`/`SetProperty` are **folded into the restart's `Start`**
  and accepted (`Ok`) — a restart never resumes with a stale pause/size/route/property;
  `SetProperty` is folded while connected too — everything else is
  `NotConnected` (the caller re-sends gains/pointer after the new worker's `Ready`).
  `WouldBlock` = the worker isn't reading (socket buffer full). Unit
  `restart_start_folds_live_changes`.
- **Fatal errors are not crashes.** A worker that can't play (`error {fatal: true}`: no GPU,
  load/build failed, protocol mismatch — a `Hello` with another `protocol` is turned into one
  by the host) stays up, idle, until `quit`; the caller stops it. No restart loop, no crash
  record (plan Review Focus #1).
- **`stop()` / `Drop` never block** (`stop_never_blocks`: < 5 ms): `quit` is sent, the
  process goes to `worker::reap` — one `lia-worker-reap` thread, started on demand, gone when
  nothing is dying — which reaps it and SIGKILLs it at `STOP_GRACE` (500 ms) if it's still
  there. `reap::pending()` for probes.
- **Log tail:** the last `LOG_TAIL` (50) lines of worker output + `log` messages (as
  `[level] line`), oldest first, across restarts (a `--- liascape-player: worker …; restart N ---`
  marker between processes); a line is cut at 4 KiB; ≤ 256 KiB read per `poll`. stderr and
  `log` messages interleave arbitrarily. `stop()` drains the pipe first (non-blocking), so a fatal
  error's own stderr line — written just before the `error` that made the host stop it — stays in
  the tail (Task 13: it was lost before, 3/3 runs). **`ctl probe '{"name":"workers","args":
  {"log_tail":true}}'`** shows every scene's tail (kept after a fatal stop, across restarts) — LWE's
  own output (missing assets, shader warnings, `Replaced … with compat …`) for a scene that loads
  but renders wrong, not only for one that crashed (Task 13; guard: the tail half of
  `tests/api.rs::missing_scene_folder_fails_without_crash_record`).
- **Crash record** `<crash_dir>/<scene-id>-<unix_ms>.json` (`-<n>` on a same-ms collision;
  written via a temp + rename) = `{scene_id (the item folder's name), id (source), path,
  reason, signal|code, restarts (in the window), total_restarts, uptime_ms, t_wall,
  log_tail}`; past `MAX_CRASH_RECORDS` (20) the oldest (mtime) go. `worker::write_crash_record`.
- **`kill_for_restart(why)`** (Task 10): SIGKILL the live worker as a crash — the usual
  `Exited` → restart/broken path follows, with `why` leading the restart's and the record's reason
  (`"GL context lost, killed by signal 9"`); `worker.killed {id, pid, why}`. For `ContextLost`.
- Events (comp `worker`, one corr `wk-N` per host): `worker.spawned {id, pid, bin, attempt}`,
  `.ready {pid, protocol, features, sync, ms}`, `.exited {pid, signal, code, hung,
  uptime_ms}`, `.hung {pid, waited_ms, hello}`, `.restart {attempt, prev_pid, pid, why}`,
  `.killed {pid, why}`,
  `.broken {reason, record, restarts}`, `.stopped`, `.bad_message`, `.spawn_failed`,
  `.record_failed`. `source.broken` is the source's view (§ "The `scene` Source kind" → Errors).

**`liascape-scene-worker --fd N --parent-pid P [--stub]`.** `--stub` (tests, no GPU): `hello
{features: [stub], sync: none}`, answers `ping`/`tick` (a slot-0 `frame` without fd), logs
each `start`'s position (`stub: start position <p>`), scripted by `LIASCAPE_SCENE_WORKER_TEST`
(comma-separated): `crash_after_ms:N` (`stub: crashing` to stderr, `RLIMIT_CORE` 1 —
no systemd-coredump/DrKonqi —, `abort()`), `hang_after_ms:N` (stops answering), `ring:N` (N
`buffer`s on `start` — 64×64, no fds —, each tick framed into a free slot, the newest tick held
while the host has them all: slot starvation without a GPU), `freeze_after_ms:N` + `freeze_ms:M`
(N ms after `hello` stops reading for M ms, then carries on), `exit_code:N`
(exit N at `crash_after_ms`, else right after `hello`), `ignore_quit` (ignores `quit` **and**
EOF — only SIGKILL ends it), `spam_stderr:N`. The worker sets its socket `CLOEXEC`
(nothing it starts may hold it: EOF is the crash signal).

**Build feature `lwe` — default ON** (Tasks 1–2; § "LWE core" below). `build.rs` emits
`cargo::rustc-link-arg-bin=liascape-scene-worker=` `-L$LIASCAPE_LWE_CORE_DIR/lib
-llinux-wallpaperengine-core -Wl,-rpath,<$LIASCAPE_LWE_RPATH or $LIASCAPE_LWE_CORE_DIR/lib>` (the
compositor binary never links LWE — `tests/lwe_build.rs::worker_links_the_core` checks both);
without `LIASCAPE_LWE_CORE_DIR`, or with one lacking the `.so`, the build fails naming the devShell,
`scripts/lwe.sh` and `--no-default-features`. `--no-default-features`: the worker runs `--stub`
and the synthetic renderer only (`install.sh --no-scenes`). **`paths::scene_worker_bin()`**: `$LIASCAPE_SCENE_WORKER_BIN` (used only if
it names a file) → `liascape-scene-worker` next to `/proc/self/exe` (dev `target/<profile>/`, the
flake's `$out/bin` — the wrapper's `.liascape-player-wrapped` sits there too) → `PATH`; unit
`scene_worker_resolution_order`.

**Tests (`tests/worker.rs`, no GPU, stub only):** `proto_roundtrip_with_fds`,
`proto_rejects_oversized_and_garbage`, `spawn_handshake_hello` (+ spawn cost < 50 ms),
`worker_exit_is_seen_with_its_signal`, `worker_exit_code_is_seen`,
`hang_is_detected_by_heartbeat`, `restarts_three_times_then_broken`,
`restart_resends_start_at_resume_position`, `stop_never_blocks`, `worker_dies_with_its_parent`
(the test binary re-execs itself as the parent — `helper_spawn_and_wait`, env
`LIASCAPE_WORKER_TEST_HELPER` — with an `ignore_quit` stub so only PDEATHSIG can end it; RED with
the prctl removed: the worker outlived its SIGKILLed parent by 2 s),
`log_tail_and_crash_records_are_bounded`. **Gotcha:** a sibling test's `posix_spawn` holds a
copy of every fd for the µs between its clone and exec — `CLOEXEC` fds included — so a test
that closes one end and reads EOF must `poll` for the hang-up first.

### Frame transport (Task 4)

The spike's mechanism (`dmabuf.md` §2, §9), reproduced: a worker-owned ring of **3**
`GL_RGBA8` textures exported once, imported once, `sync_file` fences both ways, and the
compositor **latches only the newest frame whose acquire fence has already signalled**.

**GPU side (`gfx/dmabuf.rs`, methods on `Gfx` — its own file, not `egl.rs`, which other
Phase 2 work also extends; `Gfx::egl_parts()` is the crate-private accessor it uses).**
`export_dmabuf(&Tex) -> Exported {desc, fds, image}` (`eglCreateImage(EGL_GL_TEXTURE_2D)` →
`eglExportDMABUFImageQueryMESA` + `eglExportDMABUFImageMESA`; one fd per plane even when
NVIDIA returns the same fd twice; the `EglImage` is kept with the slot, like the spike's
producer — returning it is a deviation from the plan's `-> DmabufDesc`). `import_dmabuf(&DmabufDesc,
fds) -> ImportedTex` (`eglCreateImage(EGL_LINUX_DMA_BUF_EXT, EGL_NO_CONTEXT)` with
`MODIFIER_LO/HI` per plane, then `glEGLImageTargetTexture2DOES` on a fresh texture with the
`Gfx::tex` defaults — LINEAR, CLAMP_TO_EDGE; the fds are closed after, the image holds its
own reference; `ImportedTex` deletes its texture on its own context (`GlKeepAlive`) and then
destroys the image). `dmabuf_modifiers(fourcc) -> [(modifier, external_only)]`
(`eglQueryDmaBufModifiersEXT`; empty without it). `native_fence()` (`eglCreateSync(
EGL_SYNC_NATIVE_FENCE_ANDROID)` + **`glFlush` before** `eglDupNativeFenceFDANDROID`; never
waits). `gpu_wait_fence(fd)` (`eglWaitSync`: the GPU waits, never the CPU; EGL owns the fd,
closed here on failure). `has_native_fences()`, `has_display_ext(ext)`. Every extension
entry point is looked up once per process (`OnceLock`). `DRM_FORMAT_ABGR8888` = `AB24`;
`gfx::dmabuf::Plane` is also `proto::Plane`.

**Context priority (`EGL_IMG_context_priority`).** `Gfx::new_offscreen_with(OffscreenOpts
{priority: Option<Priority>})`: the scene worker asks for **`Low`** (where the display lists
the extension; a refusal with the attribute retries without), logged `gfx.context_priority
{requested, granted, path}` and as `gfx: context priority requested low, granted low` in the
worker's log tail. **The compositor's contexts (`new_offscreen()`, `new_wayland()`,
`share_context`) keep the driver default** (`Medium` here), not the plan's `High`: tried, the
render worker's `render_worker_never_composes_a_torn_frame` read 13–72 capture rounds with
`High` vs 21–53 without on a machine at load ~21 — indistinguishable from load, and the spike
saw no effect either, so the Phase 1 contexts stay as they were and only the worker is
lowered (the ordering the spike wanted). `Gfx::context_priority()` = what was granted
(`eglQueryContext`). Test `worker_context_is_low_priority`. **That api test is
load-sensitive** (its distinct-capture bound failed once with the compositor exactly as on the
base commit) — rerun it on a quiet machine before blaming a change.

**The worker's renderer (`liascape-scene-worker` without `--stub`).** `hello {features:
[synthetic] (+ lwe), sync}` — `sync: fdpoll` when `LIASCAPE_SCENE_SYNC=fdpoll` or the display
lacks `EGL_ANDROID_native_fence_sync`, else `fence`; then a log line with the granted
priority. `start`: not `synthetic` → a real WE scene through LWE (§ "Real scenes (Task 7)";
built without LWE → a **fatal** error); `synthetic` without `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1` in its env → fatal;
`<path>/liascape-synthetic.json` unreadable or `fail: load` → fatal; `fail: build` → fatal; else
ring of 3 at `scene::cover_size(native, max_size)` → three `buffer` messages → `ready
{native, has_audio, wants_audio_input}`. A fatal error leaves it idle until `quit`. `tick`
→ the newest pending tick is rendered (older ones are answered by its `frame`: the host's
heartbeat pops every seq ≤ it) into a slot the compositor doesn't hold, after waiting on
that slot's release fence (`fence`: `eglWaitSync`; `fdpoll`: `poll` ≤ 1 s); no free slot →
it waits for a `release`. Then **alpha forced to 1** (colour mask alpha-only + clear —
LWE's core leaves 0 in every pixel) and `frame {slot, seq, t}` + an acquire fence, or in
`fdpoll` the worker `poll`s its own fence (≤ 2 s) and sends no fd; no native fence at all →
a bounded `glClientWaitSync` — **never `glFinish`** (spike §5: it spins a core under load).
No flip (R25: image top at texture row 0). Slot ids are unique per worker lifetime (0, 1,
2, then 3… for a re-export) so a later ring can't be confused with this one; `resize`
re-exports the ring (Task 5, below). `gpu_ms` = the worker's `GL_TIME_ELAPSED` of an earlier
frame, never waited for (Task 8, § "GPU budget and VRAM"). Synthetic and env knobs (`crash_after_ms`,
`hang_after_ms`, `gpu_stall`) both apply.

**Compositor side: `worker/dmabuf.rs` + `sources/scene.rs`.**
- `validate_modifier(fourcc, modifier, table)`: refuses a modifier the display can't sample
  as `GL_TEXTURE_2D` — absent, or **external-only (LINEAR on NVIDIA)** — with an error naming
  `docs/player/spikes/dmabuf.md §1`; an empty table (no query extension) lets the import
  decide. Unit `external_only_modifier_is_refused`.
- `ImportedRing {generation}` — one worker process's slots, imported once each (validated
  first). `Latch` — `push(slot, seq, t, acquire)` per `frame`; `latch(release_fence)` picks
  the **newest queued frame whose fd polls readable** (no fd = fdpoll = ready); older queued
  ones are released **without** a fence (never sampled); the previously latched slot is
  released with `release_fence()` created right then (it orders after every draw that
  sampled it); the latched frame's (already signalled) acquire fd comes back only to leave
  the source's epoll set — **no `gpu_wait_fence`** (F6b: the spike's "free safety net" was ~10
  syscalls and a semaphore ioctl per frame on NVIDIA; a fence that polls readable is done), and
  a `Frame` whose fence has already signalled is queued without it (`fence_signalled`).
  Nothing ready → `stale_reuses` += 1, the previous
  frame stays (never black, never a wait). `forget_worker()` (a restart): queued frames
  dropped, the shown frame kept but marked never-to-be-released (the new worker never had
  that slot), `generation` + 1. Units `latch_takes_newest_signalled_and_releases_the_rest`,
  `forget_worker_keeps_the_frame_and_never_releases_it` (pipes as fences). **`gen` is a
  reserved keyword in edition 2024** — the field is `generation`.
- `SceneSource` (Task 4: the texture path, driven directly; Task 5 makes it a graph
  `Source`). `SceneOpts::new(path, worker_bin)` (30 ticks/s, 1920×1080 demand, LWE, …;
  tests: `synthetic`, `tick_hz` 144, the env gate, a private crash dir). `open` **refuses a
  display without `EGL_EXT_image_dma_buf_import(_modifiers)`, `EGL_ANDROID_native_fence_sync`
  or `EGL_KHR_wait_sync`** (no CPU-copy path is built — spike §5) and spawns the worker (from
  a long-lived thread: PDEATHSIG). `update(gfx)` never blocks: `host.poll` → `buffer`s
  imported into the current generation's ring (an import/validation error is `error()`), `frame`s
  pushed, `ready` starts ticking, a fatal worker `error` → `error()` + `host.stop()`; then one
  `latch` (old generations' rings dropped at the first latch of a newer one;
  `set_resume_position(t)` of every latched frame, so a restart resumes there); releases sent;
  then at most one `tick {seq, t}` when due at `tick_hz`, **≤ `MAX_INFLIGHT` 2 unanswered**,
  skip-ahead when behind (never a burst). Scene time = `position` + wall time since open (Task
  5: the pause-excised clock). `texture()` = the latched slot — **it survives the worker's
  death** (spike §6) and, after a restart, stays the dead worker's frame until the new
  worker's first frame latches. `broken()` (budget spent; mapped to `Error` + `source.broken`, Task 10) is
  separate from `error()` (can't play). `stats()` (`latched`, `stale_reuses`, `superseded`,
  `queued`, `ticks_sent`, `frames_received`, `tick_send_failures`, `restarts`, `rings`,
  `latched_gen`), `latencies_ms()` (last 1024 tick → latch), `wake_fd()`, `pid()`,
  `size()` (export size), `native()`, `sync()`, `log_tail()`.
- `scene::cover_size(native, demand)` — aspect kept, smallest size covering `demand`
  (rounded; never under it on either axis), never above native, long edge ≤ 4096. Unit
  `cover_size_examples` (the plan's five + portrait, the cap, degenerate input).
- `scene::synthetic::SyntheticSpec` (`liascape-synthetic.json`, every field defaulted): `pattern`
  `frame_index` (top-left 64² = `marker_rgb(seq)` = `(seq & 255, seq >> 8 & 255, 0)`, bottom-
  right 16² = `grad_rgb(x, y, seq)`, rest grey 32) | `solid` | `split_tb` (top `rgb`, bottom
  `rgb2`) | `pointer_dot` | `input_level`; `native`, `alpha` (drawn with it; the worker forces
  1), `gpu_work` (a pixel-neutral loop: 2500 ≈ 3 ms, 4000 ≈ 6 ms per 1080p frame here),
  `tone_*`/`has_audio` (Task 6), `crash_after_ms`, `hang_after_ms`, `fail: load|build`,
  `gpu_stall: [after_ms, for_ms]` (frames in that window carry a stand-in acquire fence — a pipe,
  written when the window ends, after the real fence was waited for — as if the GPU finished
  nothing: the compositor latches none and starves the worker; the 2026-10-29 suspend false-hang).
  `tests/common::synthetic_scene(name, &spec)` writes `target/test-media/scenes/<name>/`
  (`project.json` type scene, 16-byte `scene.pkg`, 1×1 `preview.png`, `liascape-synthetic.json`).

**Measured** (`tests/scene.rs::transport_meets_the_spike_budget`, 5 s per config, 1920×1080,
144 ticks/s, every latched frame read back and checked; RTX 3070 Ti / NVIDIA 595.84, the
machine shared with other agents' tests; the spike's numbers for comparison):

| config | delivered fps | stale / torn / out-of-order | worker CPU | compositor `update` CPU | tick → latch p50 / p99 |
|---|---|---|---|---|---|
| trivial frame | **143.98** (spike 143.98) | **0 / 0 / 0** | **1.60 %** (1.48) | **1.77 %** (transport ≈ 0.54 % of 4.04) | 1.18 / 1.41 ms (incl. the test loop's 1 ms poll) |
| ~3 ms GPU per frame (`gpu_work` 2500) | **143.98** (144.00 at 3.7 ms) | **0 / 0 / 0** | 1.60 % (1.38) | 1.81 % | 4.21 / 5.25 ms |

**What the worker's CPU figure is (2026-10-28, the test's red full-suite runs settled).** The
same work — a constant **175–178 k user instructions and 4 wake-ups per frame** (debug worker;
~102 k release) — read anywhere from 2.1 to 25 % of a core, because CPU time per frame is set by
the machine, not the worker: **core type** (pinned: 214–231 µs a frame on a P-core, 276–290 on an
E-core of this i9-12900K — unpinned runs land in between), **clock** (`powersave`/HWP: the cores of
a light periodic load sit at 0.8–1.4 GHz on a quiet machine — 350 k user cycles a frame read 7.6 %
at load 3, 3.0 % when other load kept the clocks up) and **memory contention** (12
memory-streaming processes: the same 175 k instructions in 5.4 M user cycles, 25 %). Per-thread
(P-core, debug, load ~4): renderer 2.0–2.3 %, `lia-scene-proto` 0.9 % (Task 7's protocol thread:
one extra hop per message — the bulk of the growth since Task 4's 1.6 %; it is what answers pings
during a load), `lia-scene-audio` 0.06 % (now gone for a soundless scene, § "Scene audio").
Feature A/B (P-core, 2 × 5 s each, instructions per frame): the `GL_TIME_ELAPSED` query 7 k
(~11 µs, ≈ 0.15 %), `glGetGraphicsResetStatus` 0, the idle audio thread 0 instructions (0.06 %
CPU); log-tail reading is the compositor's, loudness segments exist only for a stream. GPU
contention (a second worker at `gpu_work` 6000) +20 %. So the test now measures the cost of the
work: the worker pinned to the P-cores (`performance_cores`, `/sys/devices/cpu_core/cpus`),
`schedstat` ns per thread, the **median of 1 s windows** over ≥ 5 s (up to 15 s while over
budget); it asserts the work — user instructions per frame < 250 k (`perf_event_open`, 1.4× the
measured) and voluntary wake-ups < 4.5 — and the CPU budget; a CPU figure over budget with that
work in budget is printed as `MACHINE, NOT WORK` (with the cycles) rather than failed — on a
machine without counters the CPU budget must hold as measured. The compositor's `update` cost is
this thread's CPU time (`CLOCK_THREAD_CPUTIME_ID`, preemption excluded), judged the same way.

Under ~6 ms of GPU per frame (`latch_never_waits_on_an_unsignalled_fence`, 2212 updates in
2 s): `update` p50 10 µs, p99 78 µs, max 103 µs, 1935 stale reuses — the latch never waits.
`transport_never_shows_stale_torn_or_out_of_order`: 600 of 600 ticks latched, 0 bad. Four
workers at once: `update` cost 48 µs per iteration vs 21 µs for one (≤ 4.5× asserted).
Negative control (mutation: every queued frame treated as ready, no `gpu_wait_fence`): the
transport test went RED at once — `frame 143: marker [141, 0, 0]`, the slot's previous
frame, exactly the spike's `nosync` signature.

**Tests (`tests/scene.rs`, GPU; SKIP without EGL; one at a time — a process lock — so their
rate/timing assertions don't fight each other):** `transport_never_shows_stale_torn_or_out_of_order`,
`latch_never_waits_on_an_unsignalled_fence` (asserts p99 ≤ 1 ms and max < 4 ms — "every update
≤ 1 ms" from the plan, robust to scheduler noise on a shared machine; a fence wait would cost a
frame's GPU time, ~6 ms), `killed_worker_keeps_last_frame` (zero budget: SIGKILL → 20
readbacks over 2 s identical, same texture), `restart_replaces_ring_after_first_new_frame`
(same texture + pixels until the new generation latches, then a new texture, one ring, seq
continues), `fdpoll_fallback_is_equally_correct` (300 frames), `scene_texture_holds_image_top_at_t0`,
`scene_frame_is_opaque`, `huge_native_scene_exports_at_cover_size` (7467×4200 → 1920×1080),
`four_workers_latch_independently` (a wall-time ratio of `update` costs: load-sensitive, failed
once 269 vs 57 µs in a full run, passed alone), `transport_meets_the_spike_budget`,
`audio_thread_only_for_a_scene_with_sound`, `context_priorities_compositor_high_worker_low`.

**What Task 5 builds on:** (done — § "The `scene` Source kind (Task 5)" below).

### LWE core (Tasks 1–2)

linux-wallpaperengine `next-v2`'s core library, from the owner's fork (D3) — `UPSTREAM.md`
§ linux-wallpaperengine is the source of truth for the pin, the patch series and the resync recipe.
- **Where it comes from.** `third_party/lwe/PIN` (JSON) → the flake's `lwe-src`
  (`fetchFromGitHub` of the fork at `rev`, submodules, `nix_hash`) → `lwe-core` (CMake, the
  `linux-wallpaperengine-core` target only — `all` would build the GLFW dev-viewer/CEF
  webhelper objects; ~50 s at 8 jobs) = `lib/liblinux-wallpaperengine-core.so*` +
  `include/linux-wallpaperengine/*.h` + `REV`. The `liascape-player` package and the **devShell** set
  `LIASCAPE_LWE_CORE_DIR` to it (first entry into the devShell after a pin bump builds it). Outside
  Nix: `scripts/lwe.sh fetch prepare build` (clone into `~/.cache/liascape/src/lwe-<rev>`,
  every submodule verified against the PIN; a copy without VCS dirs in `build/lwe-src-<rev>`;
  built in `build/lwe-build-<rev>`; installed to `build/lwe-core`, `-j${LWE_JOBS:-8}`).
  `install.sh` does that, copies the `.so*` into `<prefix>/lib/liascape/` and builds
  the worker with `LIASCAPE_LWE_RPATH='$ORIGIN/../../lib/liascape'`.
- **Patch work.** `LWE_DEV_SRC=<fork checkout> bash scripts/lwe.sh build test` builds a working
  tree in place (`build/lwe-build-dev`, incremental; `REV` = `dev:<dir>`, which
  `core_is_the_pinned_one` skips), then `LIASCAPE_LWE_CORE_DIR=$PWD/build/lwe-core cargo …`.
  `bash scripts/lwe.sh --nix …` runs any command inside the devShell. **Gotcha:** the devShell sets
  `LIASCAPE_LWE_CORE_DIR` to the pinned store path, so `lwe.sh --nix build` installs into `/nix/store` and fails
  (`Read-only file system`) — run `nix develop -c bash -c 'LIASCAPE_LWE_CORE_DIR=$PWD/build/lwe-core-dev
  LWE_DEV_SRC=… bash scripts/lwe.sh build test'` instead. **A fork commit not pushed yet** (0018, 2026-10-29):
  `LWE_REPO=<local fork clone> bash scripts/lwe.sh fetch patches verify` regenerates the series from it, and
  the flake's `lwe-src` (a fixed-output fetch) is satisfied without GitHub by adding the exact tree to the store:
  the previous rev's `-source` store path copied, the new patch `git apply`d, `nix hash path` = the PIN's
  `nix_hash`, `nix-store --add-fixed --recursive sha256 <dir named source>`. Only this machine builds until
  the branch is pushed.
- **The patched API** (`patches/lwe/0003`): `wp_config_set_audio_output(cfg, {sample_rate,
  channels})` before `wp_context_create` → the context uses `HostAudioDriver`: no SDL audio
  subsystem, no device. `wp_context_audio_pull(ctx, float*, frames)` = the sum of every stream, each
  at its sound object's `volume²` (0018; unity before), F32 interleaved, always `frames` (silence where nothing is decoded; 0 on an SDL context
  / null buffer); it **never waits for decoding** (an empty packet queue = silence for that pull),
  so the worker may call it from its PipeWire process callback. Not pulling = paused (the read
  threads wait on full queues); the frames pulled per second of the host's clock = the speed, so
  Task 6's scaletempo stage pulls `speed × frames` and stretches them (owner: scene speed scales
  animation AND audio, pitch-corrected). `config.volume` and the mute check's pause still exist
  but the worker never sets them (dB gains are ours). A mono source reaches each stereo channel at
  −3 dB (FFmpeg's default mono→stereo rematrix — measured 0.354 for a 0.5 sine).
  `wp_context_audio_stream_count` (0 until the first `wp_render_frame` builds the scene's sound
  objects; since 0018 = the sound objects that can play — one slot each for life, also one held at volume 0
  — so the worker's `has_audio` still opens the stream for a scene whose only sound waits on a property),
  `wp_context_audio_driver_name` (`"host"|"sdl"`). Stop pulling before
  `wp_context_destroy`. **0004:** a project whose renderer build threw renders nothing ever again
  (no SIGSEGV on the 2nd call), size stays 1×1. **0005:** `engine.setTimeout/setInterval` run on
  the context's `renderTime` (the host clock), a clock going back reschedules them. **0006:** a mono
  sound on a stereo output corrupted the heap in `resampleAudio` (found by 0003's test).
  **0007–0014** (2026-10-28) are upstream **`main`** fixes cherry-picked onto the fork (`main` diverged from
  `next-v2`; `base` stays `next-v2` — UPSTREAM.md lists which of `main`'s 13 commits were picked and why the
  rest weren't): #618, #619, #613, #677 (its `GLPlayer` half), #674, #652 (`padding` as a vec2 / a number
  broadcasts), #634, #692 (`"particle": null|"None"` on a text object). **0015:** `JsonExtensions::optional`
  is `noexcept` — a wrong-typed optional value is now absent/default + `Ignoring "<key>": …` instead of a
  `terminate` (the C API's `try`/`catch` never saw it). **0016:** a path no mountpoint has exactly is matched
  ignoring ASCII case (`Found X as Y (case differs)`; exact matches everywhere first). **0017:** an image
  effect whose pass can't be built is left out (`Leaving out effect …`) — the object used to be dropped.
  **0018 (2026-10-29): sound objects play by Wallpaper Engine's rules** (the decompiled spec,
  `docs/player/spikes/we-sound-semantics.md` § 4; until then LWE started every file of an object at once at
  unity gain and ignored `volume`, `startsilent`, `mintime`/`maxtime`): `sound` = a string or a list; every
  start plays ONE file picked uniformly at random (repeats allowed; `WPENGINE_SOUND_SEED` = deterministic
  picks); each stream at `volume²` — a `DynamicValue` (literal, `{user, value}`, `{name, condition}`),
  unclamped (2 = ×4), applied per stream in `HostAudioDriver::pull`; `loop` (also absent/unknown) = one file
  loops natively, several back to back (the next pick when the driver mixed the last sample — not a container
  duration, which an mp3 without a header gets wrong by seconds); `random` = + a uniform `mintime`..`maxtime`
  silence (defaults 1 / 5 s) counted from the file's end; `single` = one file once; the schedule ticks in
  `CScene::renderFrame` on `renderTime` (follows the worker's clock, speed and pause; a muted object's
  schedule freezes); a property change sets the gain at the next pull (no ramp, like WE), a rise from 0
  starts a stopped non-`single` object, a fall to 0 keeps it running silently; `startsilent` never starts
  (LWE's SceneScript has no sound methods — `CSound::play()` is the hook for when it does); spatialization
  (WE pans by the object's x when set) not done. Each start opens the picked file on the render thread:
  measured 22 ms for 3289734539's 40 MB WAV from its `scene.pkg` (once per file, every ~4 min), 1–2 ms
  for an mp3. Also fixed: `decodeFrame`'s leftover-packet counter was a static shared by all streams.
  **0019:** `Configuration` initialises `baseOnly`/`noSolidFinal`/`passLog` (heap garbage before: a non-zero
  `noSolidFinal` dropped every solid layer's final draw, so solid layers came and went per process).
  **0020 (2026-10-29, batch B1): property scripts run** (`docs/player/spikes/we-lwe-gap-audit.md` S1–S9,
  S33–S35, S38). Module = `JS_EVAL_FLAG_COMPILE_ONLY` → `JS_EvalFunction` → `JS_GetModuleNamespace` (LWE
  kept the Promise: nothing ran and `null` was written every frame). Queued modules evaluate on the next
  `ScriptEngine::tick` (scene complete), in queue order, then `init(value)` each, then
  `applyUserProperties(<all user properties>)` once, then `update(value)` every tick; undefined/null returns
  write nothing; Vec3/Vec4 keep z/w; `thisLayer`/`thisObject` = a `const` prepended to each module's first
  line (`globalThis.__thisLayerBinding` at evaluation). scale/angles/visible register the rendered values
  (not `group*`); a text's `text` script runs only as the layer script. **The JS classes are WE's own, read
  at run time from the assets dir** (`scripts/jsclasses/baseclasses.js` evaluated first as a global script,
  `import 'WEMath'|'WEColor'|'WEVector'` → `scripts/jsmodules/<lowercase>.js`); never copy them into the repo
  or the fork. Without them: bare `Vec2/3/4` constructors (logged), modules don't resolve. C++ only marshals
  (`ScriptEngine::newVec` = `new VecN(…)` of WE's class); the native Vec/WEMath/WEColor adapters are gone.
  `createScriptProperties` = WE's builder (defaults) with the stored values (`__storedScriptProperties`, live)
  laid over it (builtins.js). The layer adapter reads/writes registered properties (+ `name`); engine
  functions work (registration + `JS_CFUNC_generic_magic`); timer callbacks are owned. **0021:** a name the
  layer lacks reads `undefined` without a log line (0020's getter logged per miss). Script errors log
  `ScriptEngine [<prop>_<id>.<fn>]: …` + stack, ≤ 5 per script. Still missing (B10): layer methods
  (`getTextureAnimation`, `getAnimation`, `size`), `registerAudioBuffers`, cursor/media events,
  `engine.userProperties`, `createLayer`, sound layers. `host_api_test`: `update_moves_the_property`,
  `init_runs_first_and_modules_load`, `undefined_leaves_the_property` (solid squares on a 64×32 scene, need
  `LIASCAPE_WE_ASSETS_DIR`; RED on 45ed25c); `HOST_API_TEST_ONLY=<substring>` runs a subset.
  `host_api_test`: `case_insensitive_asset_lookup` (a folder and a generated `scene.pkg`; RED: load NULL),
  `odd_text_fields_load` (string/number/array `padding`, `"particle": "None"`; RED: SIGABRT). These moved the
  scene corpus from 86 to 92 ok (§ "Scene corpus").
- **The headers are C++-only** (struct tags used as type names), so `lwe.rs` declares the ~20
  calls it uses by hand (`unsafe extern "C"`), and `patches/lwe/tests/host_api_test.cpp` is C++.
- **`lwe.rs`** (feature `lwe`): `Scene::load(dir, assets)` (config with the explicit assets dir +
  the host audio output at 48 kHz stereo, context with our `eglGetProcAddress` and a `Cell<f32>`
  clock, `wp_project_load_folder`; NULL → `Err("load failed")`), `first_render(scratch_fbo)` →
  native size or `Err` when ≤ 1, `render(t, fbo)` (native-sized FBO; no flip, alpha 0 — the caller
  forces 1), `pull_audio`, `audio_streams`, `audio_driver`. Task 7's `render.rs` builds on it.
  **`liascape-scene-worker --lwe-smoke <scene> --assets <dir> --out <dir> [--seconds S] [--audio-dump S]
  [--prop name=value]… [--prop-at T name=value]…`** (`--prop`: a user property before the build, like
  `scene_props`; `--prop-at`: set T s into the dump, live; the dump renders at 30 fps of scene time meanwhile,
  so 0018's playlists advance) renders a
  real scene offscreen (frames at 30 fps of scene time), writes `lwe-smoke-1s.png`/`-3s.png`
  (upright, opaque) and prints one JSON line (`native`, `load_ms`, `build_ms`, `frame_ms_*` with a
  `glFinish` per frame, `lit_pixels`, `changed_pixels_1s_to_end`, `gl_error`, `audio_driver`,
  `audio_streams`, `audio_peak` of 0.5 s pulled); exit 0 = rendered and animating. Measured
  (release, RTX 3070 Ti): 2371103399 3840×1080 build 735 ms, 0.81 ms/frame, 0 GL errors, 1 sound
  stream through the host driver; 1726902114 2048×1423 build 126 ms, 0.14 ms/frame.
- **Assets-free scenes (D7 probe):** a scene of only a clear colour (`patches/lwe/tests/fixtures/
  min-scene`, 64×32) builds and renders **without** WE's `assets/` (centre pixel = the clear
  colour) — usable as a hermetic real-LWE fixture; anything with an image/particle/effect needs
  `assets/shaders/*`. `fail-scene` (an object whose parent doesn't exist) loads, then its build
  throws — the deterministic broken-build fixture.
- **Tests.** `bash scripts/lwe.sh test` (`host_api_test.cpp`, `SDL_AUDIODRIVER=dummy`; EGL tests
  SKIP without a surfaceless context; the audio-mix test needs `LIASCAPE_WE_ASSETS_DIR`):
  `host_output_replaces_sdl`, `pull_without_streams_is_silence`,
  `render_after_failed_build_returns` (RED unpatched: SIGSEGV), `min_scene_renders_without_assets`,
  `host_pull_mixes_scene_sound_at_unity_gain` (a generated looping mono WAV: peak 0.354 on both
  channels, 5 blocks without a gap; RED before 0006: `double free or corruption`); 0018 (generated
  stereo tones, a render + a pull per 20 ms of the fake clock; all RED on the 0017 core):
  `loop_plays_one_file_at_a_time` (two files: never both, both picked, back to back with 0 quiet blocks;
  the string `sound` form loops), `random_waits_mintime_to_maxtime` (gaps 0.44–0.78 s for 0.4..0.8),
  `volume_is_squared_and_live` (0.5 on a 0.8 tone → 0.200; a slider 0 → 2 starts its object at ×4; 2 → 1
  steps at the very next pull), `startsilent_and_volume_rise` (no slot, silent; a bool raising a `single`
  never starts it, a `loop` starts at once; back to 0 = silent),
  `sdl_stays_default_without_host_output`, `pull_on_sdl_context_returns_zero`.
  `tests/lwe_build.rs` (core tests SKIP without `LIASCAPE_LWE_CORE_DIR`, FAIL then under
  `LIASCAPE_REQUIRE_SCENES=1`; repo tests SKIP in the flake's sandbox): `core_exports_only_wp_symbols`
  (⊇ `tests/fixtures/lwe_exports.txt`, 70), `core_is_the_pinned_one` (`REV` = PIN.rev),
  `worker_links_the_core` (NEEDED + RUNPATH; the compositor binary links no LWE),
  `patch_headers_are_complete`, `pin_matches_flake` (the flake reads the PIN; the last patch is
  PIN.rev's commit).

### The `scene` Source kind (Task 5)

A WE scene is a graph `Source` like any other: `create {kind: source, props: {kind: scene,
path: <item folder>, position?, paused?, speed?, preview?}}`. The transition recipe, aliases
(`srcs:`/`cur:`), the snapshot and the adapter stay kind-agnostic; only the places that
hard-coded `kind == "video"` learned about `scene`.

- **Schema.** `Source.kind` enum + `scene`; `Source.preview` (Str, the item's preview image —
  stored on every kind, shown by Task 10's crash policy); `Output.scene_fps` (F64 0–480, default **30** = D5,
  `0` = that output's refresh). `Graph::outputs_of(id)` = the inverse of `srcs:<c>` (every
  `out:<c>` whose `srcs:` holds `id` — shown there, or held there by a transition).
  `onset::kind_has_audio(kind)` = `video | scene` (`has_audio`, `audible`, the restore fade,
  the snapshot's `playing` and the periodic refresh all go through it).
- **`SourceHost`.** `kind: scene` → `SceneSource::open(gfx, id, node, base_opts)` on the loop
  (never the `lia-open` pool: no core to make, and the worker's PDEATHSIG follows the spawning
  thread). Base opts (`serve` fills them): `scene_worker` (`paths::scene_worker_bin()`; none →
  the open fails naming it), `allow_synthetic` (only when `serve` runs with
  `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`: a folder with `liascape-synthetic.json` plays the synthetic
  renderer, and the worker gets the env too), `scene_crash_dir` (`<state>/crashes`),
  `scene_assets` (Task 7), `ao`/`audio_device` (the `Start.audio` route: `null` → `Null`, the
  bus device → `Device`, else `Default`), `stepped` (`MpvSource::open_with_core` skips the
  `scene_*`/`allow_synthetic` keys — the base opts reach every mpv source too; without that
  every video failed `no_such_prop`). **Every `sync` ends with each scene's
  demand** (`host::demand_for(graph, id)` → `[OutputDemand {name, width, height, refresh_hz,
  scene_fps}]` from `outputs_of`) — **cached per `Graph::demand_rev`** (F6b, Phase 2 battery):
  `sync` runs after every dispatch, i.e. once per worker frame, and recomputing `outputs_of`
  (every output × every layer, `format!`s, `BTreeSet`s) for every scene there was the top of the
  compositor's profile mid-transition (main thread: `SourceHost::sync` 17.7 % of samples, 4
  synthetic workers mid-fade, headless 144 + 240 Hz). `demand_rev` (with a per-graph uid) moves on
  `create`/`destroy`, a layer's `output`/`content`, an effect's `from`/`to`, a source's `kind`, an
  output's `width`/`height`/`refresh_hz`/`scene_fps` (set or observed, only when the value
  differs), and a *changed* `set_transition_sources`/`set_parked` — never on what animates
  (`fx.progress`, `opacity`, `gain.*`) or a source observes; unit
  `demand_rev_moves_on_routing_changes_only`. `set_demand` itself still runs every sync with the
  cached value (it also applies a budget rate change and spawns a worker a restart / path change
  left without). `SourceHost::demand_computes` counts recomputes. **The worker is spawned at the first demand that names an
  output** (so the ring is exported at the right size from the start; a node created but not
  shown has no worker); `max_size` = the largest width and height over the outputs (the cover
  size covers each), tick rate = max `eff_fps(scene_fps, refresh)` (`scene_fps` capped at the
  refresh; 0 → the refresh; neither known → 30; Task 8 adds the GPU cap); a change of
  `max_size` sends **`Resize`** (stats `resizes`); no output at all (every output unplugged —
  parked) changes nothing. `set_audio_route` re-routes scenes too (`ToWorker::Route`).
  `SourceHost::scene(id)`/`scene_mut(id)`, `workers_info()`; `Source::as_scene(_mut)`.
- **The wake fd** is the source's **own epoll fd** (stable across spawns and path changes)
  over the current `WorkerHost::wake_fd()` **plus each queued frame's acquire fence, one-shot**
  (`EPOLLIN|EPOLLONESHOT`; `update` drains the epoll first, so a signalled fence wakes the loop
  once, never in a busy loop; closing the fd — superseded/latched — removes it; the latched
  one is `DEL`ed before `gpu_wait_fence` takes it). Found by the stepped determinism test: a
  frame whose fence hadn't signalled when its `Frame` woke the loop was latched only at the
  step's 2 s deadline (a stepped loop has no timer) — 60 steps took 155 s; after: ~20 ms each.
- **Scene clock (`SceneClock`, unit `scene_clock_excises_pauses_and_scales_by_speed`).** Scene
  seconds that advance at **`speed`** (owner decision round 2: speed scales a scene's
  animation; the pitch-corrected audio half is Task 6's), with paused intervals **excised**
  (never stopped-and-jumped). It runs only once the load's **first frame** is shown (like a
  video's `time_pos`, nothing passes while the worker starts), while not `paused` and not
  stepped. A live `speed` set re-rates from now; a live `position` set jumps it; `time_pos` =
  the clock. `Tick.t` = the clock at send.
- **Ready = the first latched frame of a load**, at exactly `position`: before it, exactly
  **one tick** (`t = position`) is sent, paused or not — then the clock starts and ticks flow
  at the tick rate (grid-scheduled, `TICK_SLACK` 2 ms early is on time, a whole period behind
  skips ahead, ≤ `MAX_INFLIGHT` 2). `ready` = loaded; one `Ready` per load (a worker restart is
  not a load; a `path` change is). `AudioFlowing` is reported at once (after Ready, on an
  un-pause) when the worker said `has_audio: false` or in stepped mode; a scene with audio
  reports it from its stream (Task 6). `Position` events ~10 Hz while playing.
- **Pause.** `paused` (the effective one, `node.paused || player.paused` — R75 composes it in
  `SourceHost` exactly as for videos) **stops ticks and latching at once**: a frame in flight at
  the pause never latches, so the held texture is exactly the one shown when it applied (no
  paused-mpv frame drift); the worker gets `Paused` (Task 6 stops pulling audio). Exceptions:
  the load's first frame (a scene opened paused shows it — exactly one tick), and a `position`
  set while paused (`exact_pending`: one tick at the new time, its frame latches). Resume
  continues the clock where it stopped. Player pause, parking (pause + −96 via the runtime)
  and hotplug need no scene code beyond this.
- **`path` (live)** = a new worker on the new folder (`WorkerHost` dropped: `quit`, reaped off
  the loop; `Latch::forget_worker()` — the old frame stays shown, never released, until the new
  worker's first frame latches), clock back to 0, `Ready` again; not a crash (`restarts` 0,
  `spawns` + 1), no crash record.
- **Re-export (`resize {max_size}` in the worker).** The worker computes the new
  `cover_size(native, max_size)`; equal to the current ring → nothing; else a new ring with
  fresh slot ids (3 more), its `buffer`s, and the old ring dropped (the compositor's imports of
  the old slots keep their memory — a dmabuf lives while anyone holds it). The compositor
  imports the new set into the **same generation's** ring; once a frame of the new set latched
  it drops that ring's other slots (`ImportedRing::retain_slots`; `latest_set`). The texture is
  never `None` in between.
- **Stepped mode.** No self-ticking: `begin_step` gives a scene the same virtual time as a
  video (`LocalTime`, advanced by `ms × speed` while not paused/player-paused; no duration, so
  never clamped) and calls `SceneSource::step_to(t)` — one tick at exactly `t` unless the
  target is unchanged; `check_step` waits (non-blocking, the fence wake above) for
  `step_status() == Done` = **the latched frame's seq ≥ the step's tick seq** (by seq, never by
  comparing `t`: it crosses JSON twice and serde_json's default float parsing can land an ulp
  off — found: a step never finished at `t = 0.192`), `Pending("ready")` while the worker
  starts (a worker that came up mid-step gets a fresh `STEP_TIMEOUT`, like an mpv open),
  `Broken` on an error. Seqs (= frame_index markers) are deterministic: one tick per step that
  moves `t`.
- **Errors.** A fatal worker `error` → `SourceEvent::Error {"<path>: <reason>"}` + the worker
  stopped (no restart loop, no crash record); `broken` (restart budget spent) → also `Error`,
  plus ONE `source.broken {id, path, scene_id, reason, restarts, record, signal|code}` (error,
  comp `source`; the fields from the crash record the host just wrote — Phase 2 Task 11, what the
  backend adapter marks the item crashed from: player-adapter.md § Scenes; Task 10 added
  `total_restarts`, `uptime_ms`, `shows` and the rest of the crash policy — § "Crash policy (Task
  10)"); either holds until `path` changes. Test `tests/api.rs::source_broken_event_names_the_scene`
  (a synthetic scene crashing every 100 ms, real clock: one event, `restarts: 3`, `signal: 6`, the
  record on disk; RED before: no event in 20 s).
- **Property semantics:** `path` live (above); `paused` freezes; `position` = scene time at
  start/restore/crash resume, a live set jumps; `speed` scales the clock (stepped: the step
  advance does); `kind` change → `unsupported` (both ways: `MpvSource` refuses `scene`);
  `color` → `unsupported`; `loop`, `hwdec`, `fps_cap`, `cache`, `demuxer_*`, `af`,
  `audio_delay`, `preview` stored; `gain.*`, `no_audio` and `speed` drive the worker's stream (§ "Scene
  audio (Task 6)"). Observed:
  `kind` `scene`, `ready`, `time_pos` (the clock), `duration` 0, `width`/`height` (export
  size), `has_audio` (the worker's `Ready`, `true` until then — R92), `paused`.
- **Snapshot.** A scene is saved like a video: position = `time_pos` once ready, `playing`
  (`kind_has_audio`), refreshed every 2 s while it plays (`Runtime::media_playing`); a restore
  recreates it at that position on a fresh worker (the old one died with its compositor) — a
  broken one is saved `broken: true` and restored as its preview, no worker (Task 10).
- **Probes / API.** `hello.capabilities` has `scene` when `paths::scene_worker_bin()`
  resolves and (Task 7) an assets dir does, unless synthetic scenes are allowed; `state.workers`
  = the `workers` probe's entries; `workers` (`probe/workers.rs`) — per scene source `{id, path,
  pid, state (not_spawned|starting|running|restarting N|broken|stopped), restarts_60s,
  total_restarts, sync, fourcc (e.g. `AB24`), modifier (hex), size (export), native, max_size
  (demand), fps_target, fps_actual (latched in the last second), paused, stepped, ready,
  scene_time, latched_t, latched, stale_reuses, queued, ticks_sent, frames_received, resizes,
  buffer_sets, spawns, rings, last_error}` + `reaping` (Task 10 adds `broken`,
  `restored_broken`, `resuming`, `context_losses`, `preview {path, open, shown, error}`; `state`
  is `broken` for a restored-broken scene with no worker); `sources` adds for a scene `pid,
  scene_time, latched_t, fps_target, export_size, native, step_status, error`.
- **Task 4's direct path** is `SceneSource::open_opts(gfx, SceneOpts)` (spawns at once unless
  `defer_spawn`); `SceneOpts` gained `paused`, `speed`, `stepped`, `assets_dir`, `audio`,
  `defer_spawn`. `SceneStats` gained `resizes`, `buffer_sets`, `spawns`, `slots`.

**Tests.** `tests/scene.rs` (Harness — the harness's base opts now carry `scene_worker`,
`allow_synthetic` and a private crash dir, its `run` refreshes `srcs:`'s transition half like
the runtime, and it has `scene(name, spec, extra)`, `scene_src(id)`, `add_graph_output`):
`scene_ready_is_first_latched_frame` (seq 0 at `t = 5.0`, one Ready, export 640×360),
`paused_scene_readies_with_its_first_frame` (1 tick, identical for 1 s),
`pause_freezes_picture_exactly` (paused with a tick in flight: no latch after the apply; RED
with the latch gate removed), `scene_clock_follows_speed_and_position` (2× and 0.5× live, a
jump to 100 s), `scene_tick_rate_follows_demand` (30 → 60 /s live, same pid),
`path_change_restarts_worker_and_holds_frame`, `demand_change_reexports_without_black` (+ a
2560×1440 graph output: one Resize, two buffer sets, one ring of 3 slots after; RED before the
worker's re-export). `tests/api.rs`: `scene_capability_state_and_workers_probe`,
`player_pause_freezes_scene` (real clock), `stepped_scene_is_deterministic` (two servers, 60
steps: byte-identical captures, `latched_t` = 59 × 0.016, 60 ticks; 60 steps < 15 s — RED
155 s before the fence wake), `scene_create_and_destroy_never_stall_the_loop` (max busy ≤ 3
ms around each, worker gone ≤ 600 ms), `scene_parks_and_resumes_on_hotplug` (Review Focus #4),
`capture_scene_source_is_upright`. `tests/supervise.rs`: `scene_snapshot_restores_at_position`
(SIGSEGV → restored within ±2 s, new worker, the old one gone; RED with the periodic refresh
video-only). Units: `scene_clock_excises_pauses_and_scales_by_speed`, `eff_fps_and_demand`,
`scene_kind_in_schema_and_kind_change_unsupported` (sources/scene.rs),
`kind_has_audio_counts_scenes` (onset.rs), `outputs_of` in `srcs_alias_layers_pending_and_exclusions`.

**For Tasks 6/9/11.** Task 6: `SceneSource::apply` stores `gain.*`/`no_audio` — send the
effective dB as `Gain` from there (the 1 kHz `push_gain` path calls `apply` too; F6b: a scene
whose `Ready.has_audio` was false only folds it into the restart's `Start`) and re-send
gain/`NoAudio` after a restart's `Ready` (`WorkerEvent::Restarted` → `worker_ready = false`;
hook the next `FromWorker::Ready`); `FromWorker::AudioFlowing` → push
`SourceEvent::AudioFlowing` when `flow_armed` (armed at open-unpaused, un-pause, path change);
`set_audio_route` already sends `Route`. Task 9: kind-agnostic already — a scene B is held in
`srcs:` by the transition (so its worker spawns at `start`), opened paused it readies with its
first frame (exactly one tick), un-paused it plays; `is_still` is false for a scene;
`SnapshotSource` blits its latched texture. Task 11: `create {kind: scene, path, position,
paused, preview}`; `hello.capabilities` `scene`; `state.workers`; `set out:<c>.scene_fps`
(live, same pid).

### Real scenes (Task 7)

LWE renders a real Workshop scene inside the worker; the compositor resolves WE's assets,
forwards the pointer, feeds the visualiser and passes user properties through.

- **Assets dir (`scene/assets.rs`).** `resolve(explicit, home)` = the first dir holding
  `shaders/genericimage2.vert` among: `player.scene_assets` (explicit) → `LIASCAPE_WE_ASSETS_DIR` →
  each Steam root (`~/.local/share/Steam`, `~/.steam/{steam,root}`, the two Flatpak paths) and
  every library its `steamapps/libraryfolders.vdf` (or `config/…`) lists →
  `<lib>/steamapps/common/wallpaper_engine/assets`. `Err` names every candidate tried + `HINT`
  (`LIASCAPE_WE_ASSETS_DIR` / `player.scene_assets`). This machine: workshop in the primary
  library, WE in `/mnt/Games/Steam/SteamLibrary`. `parse_libraryfolders(&str)` (KeyValues
  `"path"` values, comments and escapes handled), `steam_root_of_item(dir)` (canonicalized —
  a `local/<id>` symlink resolves — prefix before `steamapps/workshop/content/431960/<id>`;
  sent as `Start.steam_dir`, LWE's `backgrounds_dir`; `next-v2` resolves no project
  dependency yet, so it is recorded only). Units `vdf_paths_parsed`,
  `assets_found_in_secondary_library`, `missing_assets_error_names_every_candidate`,
  `steam_root_of_symlinked_local_item`.
- **Player props.** `player.scene_assets` (Str, "" = auto; live) →
  `Runtime::update_scene_assets` (from `sync_sources`, a no-op unless it changed; also at
  startup) re-resolves into the scene base opts `scene_assets` / `scene_assets_error` and the
  read-only `player.scene_assets_resolved` ("" = none); event `scene.assets {requested,
  resolved, error}`. `Runtime::scenes_available()` = the worker resolves **and** (assets or
  `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`): `hello`'s `scene` capability. **`liascape-player
  scene-check [--assets <dir>]`** prints `{worker, features, assets_dir, ok, reason}`, exit
  0/1 — the same rule plus "the worker was built with LWE" (`liascape-scene-worker --features`
  prints its feature list).
- **No assets (Review Focus #2).** `SceneSource::open` of a non-synthetic scene without
  `scene_assets` fails at once (`unsupported`, the resolver's error naming
  `LIASCAPE_WE_ASSETS_DIR` / `player.scene_assets`) → `source.error`, **no worker spawned** —
  never a 1×1 render loop.
- **The worker's two threads** (three since Task 6: + `lia-scene-audio`, § "Scene audio").
  The renderer (main thread: GL, ring, LWE) and
  `lia-scene-proto`, which reads the socket and hands messages over a channel. While the
  renderer is inside a load + build (`LoadGate`: a cold LWE build took up to 2.8 s) the
  protocol thread answers `Ping` itself — bounded by `LIASCAPE_SCENE_LOAD_TIMEOUT_MS` (30 s), after
  which pings go to the stuck renderer and the host's heartbeat sees a hang; a `Quit`/EOF
  during a load `_exit(0)`s at once. Nothing is exported, sent or latched before the build
  finished (`Buffer`s + `Ready` come after it). Messages that arrive meanwhile (`Resize`,
  `Pointer`, `SetProperty`) queue and apply after. Synthetic knob `load_ms` simulates the slow
  build. Test `slow_scene_load_keeps_the_heartbeat` (1.5 s load, 300 ms hang timeout → Ready,
  0 restarts; RED with the cover off: 3 restarts, never ready).
- **`render.rs` `LweScene`.** `check_folder` first: a missing dir (`does not exist (deleted,
  a dangling link, or Steam is still downloading it)`) or no `project.json` (`Steam is still
  downloading it?`) → fatal `load failed: …`; no assets → fatal with the hint. Then
  `lwe::Scene::load_in` (NULL → `load failed: <dir> (a truncated scene.pkg or an unsupported
  project)`), the `Start.properties`, `first_render` into a 1×1 scratch FBO (≤ 1 →
  `renderer build failed … (assets: <dir>)`, never rendered again), a **native-sized** FBO for
  LWE (its final quad uses `glViewport(0,0,sceneW,sceneH)`), the ring at
  `cover_size(native, max_size)`, `Ready {native, has_audio: LWE stream count > 0,
  wants_audio_input: project.json general.supportsaudioprocessing}`. Each frame:
  `wp_render_update_time` + `wp_render_frame` into the native FBO, then `glBlitFramebuffer`
  into the slot (LINEAR when scaling; scissor off first — LWE leaves its state), **no flip**,
  alpha forced to 1; a GL error LWE left is logged (`lwe: GL error …`, first 10). Every
  failure is a fatal error (no restart, no crash record — Review Focus #1).
- **Pointer (mouse on).** `out:<c>.pointer` samples (Wayland, or **`headless.pointer
  {output, x, y, buttons?}`**) → `Runtime::forward_pointer`: for every scene in `srcs:<c>`
  (both sides mid-transition), `fit_rect(native, output, lay.fit, lay.viewport)` →
  `scene::pointer::to_source_uv` (the inverse; `None` in a letterbox bar — not forwarded) →
  `to_native_px` → `SceneSource::set_pointer` → `ToWorker::Pointer` in native px, y down
  (re-sent after a restart's `Ready`). The worker hands it to LWE's `wp_mouse_input` (`CScene`
  divides by its size; our button bits = `WP_MOUSE_INPUT_BUTTON_*`); the synthetic
  `pointer_dot` scales it to the ring. Unit `pointer_maps_through_fill_and_viewport`.
- **Visualiser input (D4: all system audio, as a mix of streams — `audio/sysmon.rs`).**
  `SysMon::start()` (thread `lia-sysmon`, own PipeWire loop) taps every `Stream/Output/Audio`
  node `admit()` lets through — **the plug point for a per-app white/blacklist**; today all but
  loopback halves (`node.virtual`, which would double-count, e.g. our bus playback) — with a
  passive capture `liascape-player-visualiser.<id>` (`target.object` = its serial,
  `node.dont-reconnect` + `node.dont-fallback`: never the microphone), keeping its last 1024
  mono samples; `frame()` sums the streams that delivered within 150 ms → 1024 u8 (centre
  128). Read-only, no routing changes; a lost connection retries every 1 s. The runtime
  (`feed_visualisers`, start of `update_sources`) runs it only while ≥ 1 ready scene
  `wants_audio_input`, puts the frame on each such scene's next `Tick.input` (others get
  `null`), and drops it on a helper thread when none wants it. The worker hands it to LWE's
  `wp_audio_input_mix`; the synthetic `input_level` draws the RMS (`input_level()`). Probe
  `workers` → `wants_audio_input`, `input_dbfs`. Units `admit_takes_app_playback_streams_only`,
  `mix_frame_sums_streams_at_their_newest_sample`. Deviation from the plan's text: streams
  playing to a non-default sink are mixed too (WE's "everything that plays").
- **User properties (the editor's worker side).** Source prop **`scene_props`** (Map name →
  value; stored on every kind) is sent as `Start.properties` (applied after the load, before
  the first frame — so re-applied at every open) and, live, each new/changed entry as
  `ToWorker::SetProperty {name, value}` (`WorkerHost` folds it into the restart's `Start`).
  The worker: bool → `wp_project_property_set_boolean_by_name`, number → `…slider…`,
  `[r,g,b(,a)]` 0–1 → `…color…`, string → `…value…` (LWE parses by type: text, combo key,
  `"r g b"`); answers `PropertySet {name, ok, reason}` → event `scene.property` + probe
  `workers.properties`. A removed key keeps its value until the scene is opened again (LWE
  has no reset — the backend sends the default explicitly). Synthetic: `rgb`/`rgb2` (`[r,g,b]`
  0–255) and `color` (= `rgb` in WE's colour encoding, `[r,g,b]` 0–1 — what the backend's editor
  sends for a `color` property; unit `colour_props_take_bytes_or_we_unit_floats`). The UI/backend
  editor (done: library.md § "Scene properties", player-adapter.md § Scenes) reads `project.json`
  `general.properties`, persists per item in `LibMeta` and sets the whole map as `scene_props` at
  create and live (`set <src>.scene_props {…}`, the resolver's per-source value).
- **Probe `workers`** adds `assets_dir`, `steam_dir`, `wants_audio_input`, `input_dbfs`,
  `pointer`, `properties`.
- **Measured** (debug worker, release LWE core, RTX 3070 Ti, stepped 30 fps of scene time,
  `real_scenes_render_and_animate`): 1726902114 2048×1423 → exported 1920×1334, Ready 177 ms;
  2371103399 3840×1080 (covers 1920×1080 only at native width) Ready 795 ms; 2134765860 (Bunk)
  1920×1080 Ready 857 ms; all non-blank, opaque, animating, 0 GL errors. Bunk shows LWE
  fidelity gaps (a pixelated lower block, tiny clock) — Phase 6 corpus items, not embedding.
- **Tests.** `tests/scene.rs`: `slow_scene_load_keeps_the_heartbeat`,
  `min_scene_renders_through_the_worker` (real LWE, hermetic: `patches/lwe/tests/fixtures/
  min-scene`, an empty assets dir → 64×32, clear colour 51 102 153 255),
  `renderer_build_failure_is_broken_not_a_segfault` (`fail-scene`: fatal, 0 restarts, no
  record, the worker exits after quit), `missing_or_half_downloaded_scene_fails_cleanly`
  (gone / no project.json / truncated scene.json), opt-in `real_scenes_render_and_animate`
  (`LIASCAPE_PLAYER_TEST_SCENES=<…/431960>`, else SKIP; FAIL under `LIASCAPE_REQUIRE_SCENES=1`; frames to
  `LIASCAPE_PLAYER_TEST_SCENES_OUT`). `tests/api.rs`: `no_assets_dir_hides_scenes_and_errors_with_hint`
  (+ `scene-check` exit 1, `set player.scene_assets` live; RED with the open check removed: a
  worker spawned), `missing_scene_folder_fails_without_crash_record`,
  `pointer_reaches_scene_in_source_coords` (RED with the forwarding removed),
  `scene_props_apply_at_open_and_live`, `visualiser_input_reaches_only_scenes_that_want_it`
  (private PipeWire, a `pw-cat` tone → −9.0 dBFS at the scene; no capture node without a scene
  that wants it). Unit `restart_start_folds_live_changes` covers `SetProperty`.

**For Tasks 9/11 and the properties editor.** (Task 6 is done — § "Scene audio (Task 6)"
below.) Task 9: nothing
scene-specific in the pointer/visualiser paths (both sides of a transition are fed). Task 11:
`ScenesAvailable` = `hello.capabilities` `scene`, else `liascape-player scene-check` (exit + JSON
`reason`); set `player.scene_assets` from a setting if one is added; scenes `create` may carry
`scene_props`. Editor (done, above): reads `general.properties`, persists per item, sends `set
<src>.scene_props` (whole map); `scene.property` refusals are not subscribed (they log).

### Scene audio (Task 6)

A scene's sound is a PipeWire stream of its own worker on the player bus, driven by the
compositor's dB gains exactly like a video's `volume-gain` — the invariants (#1–#8) hold for
scenes unchanged. Worker side `src/bin/liascape-scene-worker/{audio,stretch}.rs`; compositor side
`sources/scene.rs`; the dropout reference `probe/dropout.rs` (`SceneEnvelopes`).

- **Protocol (`PROTOCOL` 2; 3 since scene loudness added `FromWorker::Loudness`, 4 since its cap added `Start.loudness` + `ToWorker::LoudnessMeter` — § "Scene loudness").** `Start` gained `id` (the source id), `gain_db` (default −96),
  `no_audio`, `speed`; `ToWorker::Speed {speed}` is new; `Gain`/`NoAudio`/`Speed` are
  **folded into the restart's `Start`** by `WorkerHost` (recorded while connected too, like
  `SetProperty`) — a restarted worker resumes at the same level/mute/speed. The worker's
  `paused` now means *play no audio*: the effective pause, or always in stepped mode (a stepped
  scene never sends `Paused {false}`). `FromWorker::AudioFlowing`, `Envelope {t0_ms,
  dbfs_1ms}` (`t0_ms` on `CLOCK_MONOTONIC`).
- **The stream** (thread `lia-scene-audio`, its own PipeWire main loop, which sends the
  envelope/`AudioFlowing`; the process callback runs on PipeWire's **data thread with
  `RT_PROCESS`** — real-time priority through the client's `module-rt`, `SCHED_RR` measured on
  `data-loop.0` — 2026-10-28, see "RT process callback" below): playback, F32 stereo 48 kHz, `node.name =
  liascape-player-scene.<id>`, `node.description = "liascape-player scene"`, `application.name =
  liascape-player`, `media.role = Wallpaper`, `node.latency = 256/48000` (requested — PipeWire
  rewrites the prop to the running quantum in `pw-dump`), `state.restore-props/target =
  false`; the route: `Device("pipewire/liascape-player-bus")` → `target.object = liascape-player-bus` +
  `node.dont-reconnect` (the compositor re-routes us, never WirePlumber), `Default` → no target,
  `Null` (`--ao null`) → a real-time timer thread pulling and discarding (so `AudioFlowing`,
  envelopes and the scene's sound clock work in hermetic tests). The thread **starts only once a
  sound is installed** (`Renderer::install_audio`: the load said `has_audio` — LWE stream count >
  0, synthetic `has_audio`) and opens the stream at once — silent then (gate shut, gain ramping
  from 0); a scene without sound has **no audio thread at all** (found by
  `transport_meets_the_spike_budget`: an always-on null timer took the worker from ~3.4–5.4 % to
  7.2 % CPU; until 2026-10-28 the thread still started at `Start` and polled for a sound 50×/s,
  0.06 % CPU for nothing — `tests/scene.rs::audio_thread_only_for_a_scene_with_sound`, RED
  before: `lia-scene-audio` in a soundless worker); a PipeWire that can't be reached →
  the same timer (keeps the sound in step with the picture, reports **no** flow), retried every
  1 s; a `Route` change fades the old stream out on the gate (≤ 100 ms bound), then rebuilds.
- **The signal path per buffer (`audio::Dsp`, pure, unit-tested):** pull (LWE's
  `wp_context_audio_pull`, or the synthetic `Tone` — `tone_hz`/`tone_dbfs` peak, `has_audio`)
  through the time stretch → **gate** → envelope → **gain**.
  - **Gain**: the compositor's `Gain {db}` (`Gains::effective_db()` of the source's `gain.*`
    slots, sent on every slot change — the 1 kHz `push_gain` path included — and re-sent at
    every `Ready`), interpolated **linearly in amplitude** from the previous to the latest across
    one buffer (`(i+1)/n`, last sample exact); ≤ −96 dB is exact `0.0` (`audio::gain_lin`).
  - **Gate** — the worker's own 30 ms linear anti-click (`ANTICLICK_FRAMES` 1440, counted in
    whole frames so its ends are exact): open while the scene *plays* (a source installed, not
    paused, not `no_audio`, not quitting), closed otherwise. **When the stream is silent anyway**
    (applied and target gain both 0) it jumps — so the normal "compositor ramps, then pauses"
    pulls not one sample more (no decode drift) and an un-pause at −96 starts at once. It is what
    fades a restarted worker in at its folded `Start.gain_db`, and an audible pause / mute /
    route change / quit out (still pulling for those 30 ms). `no_audio` on → ≤ −90 dB within
    100 ms (measured −96 in every block 100–350 ms after).
  - **Pull lock**: the source sits in a `Mutex`; the callback `try_lock`s (a miss = silence
    for that buffer: only at install/remove); the renderer `remove()`s it (waiting for a pull in
    flight) before an LWE scene is dropped (`fatal`) — *stop pulling before `wp_context_destroy`*.
- **Time stretch (`stretch::Stretch`, owner decision: speed scales the sound, pitch kept).**
  WSOLA: 20 ms periodic-Hann segments (`WIN` 960) overlapped by half (`HOP` 480), segment `j`
  taken near input `j·speed·HOP` at the ±10 ms (`SEARCH` 480) offset whose first hop best
  matches the last segment's natural continuation (normalised cross-correlation of the L+R
  mono, a coarse pass on every 4th sample/candidate, then a ±3 full-resolution refine). **At
  exactly 1× it is a passthrough** — pulled straight into the output, bit-exact, no added
  latency; leaving 1× starts WSOLA at the current position (the next hop is the first overlap),
  returning continues at the last segment's natural continuation (the overlap-add would give the
  input there: the window halves sum to 1) — continuous both ways. The scene clock and the
  stream both follow `speed` (the `Speed` message; stepped: never). Measured (unit, 440 Hz,
  period 109.09 frames — no hop is whole periods): pitch 440.01 Hz at 0.5×/1.5×/0.1×/4×
  (440.06 at 0.73×), 25 ms-block level −9.031 ± 0.003 dB (amplitude 0.5), input consumed at
  speed + 0.01 (the look-ahead), the largest sample step across 1→1.5→0.5→1 switches 0.02879 vs
  the tone's own 0.02880. RED (search disabled → nominal positions): 419.99 Hz and −9.86 dB at
  0.5×. On the real scene's sound (2371103399, `--lwe-smoke --audio-dump 6`): no exact-silent
  1 ms block in the input or in the 0.5×/1.5× output.
- **`AudioFlowing` (invariant #8).** Worker: an arming counter (a `Start` that plays, `Paused
  {false}`, `NoAudio {false}`, a `Route`); the first buffer after it that *pulled the scene's
  sound into a real stream* (not the fallback timer, not before the load) sends one. Compositor:
  `flow_armed` (open-unpaused, un-pause, `no_audio` off, a route change, a path change) + the
  worker's message (`flow_seen`) → `SourceEvent::AudioFlowing` once the load is shown and not
  paused; at once (no wait) when stepped, `has_audio: false`, or `no_audio`. Known window: an
  `AudioFlowing` from an *earlier* arming that arrives after a re-arm counts (≤ a few ms: the
  worker resumes pulling at its next callback) — no epoch in the protocol.
- **Quit.** `Control::quit(200 ms)`: playing = false → the gate closes (at once if silent),
  then the process exits once the stream's level (`applied × gate`) is exactly 0 — on `Quit`,
  on EOF, and on a quit during a load (`_exit` after it). The compositor's retire ramp
  normally made it silent already: destroy of a playing tone scene measured 28 ms from −1 dB to
  silence on the bus, then the node is gone. **Then the stream leaves the graph before the exit
  (F7):** `set_active(false)` + a core roundtrip, `SETTLE_INACTIVE` 20 ms, `disconnect` + a
  roundtrip (all within `CLOSE_MAX` 200 ms — under the host's `STOP_GRACE`; the audio thread then
  parks, never reconnecting). Exiting with the stream active in the graph cost the bus whole graph
  cycles of exact silence at the sink in *every* S→S switch (B's sound: 64–384 samples; frozen 60/61,
  full-live 30/30 — `tests/onmachine/scenes.sh onsetrec` records the sink independently); a bare
  disconnect of the active stream still 18/60; deactivate-first leaves 2–8 single cycles per 60
  full-live/reveal switches (0/121 frozen), at the deactivation — PipeWire's graph change through
  the in-process loopback (TODO F7). Test `tests/api.rs::scene_worker_exit_never_skips_bus_cycles`
  (RED 6/6 switches).
- **Envelope → dropout reference.** 1 ms max-channel RMS dBFS of the gated, pre-gain samples
  (`audio::meter::BlockMeter`; `meter::dbfs_block` is the shared one-block form), batched every
  50 blocks, stamped with the buffer's play time (`CLOCK_MONOTONIC` now + one buffer). The
  compositor maps it onto the log's `t_mono_ms` (the meter's clock) and keeps ≤ 10 s
  (`take_envelope`); `Runtime::record_scene_envelopes` (every `update_sources`) files it into
  `SceneEnvelopes` (≤ 40 000 entries per scene, dead ones kept `DEAD_LINGER`, ≤ 16 tracks;
  `loop` probe bounds `scene_envelope_tracks/samples`); `SourceWindow.envelope` → the
  expected mix uses it instead of an ffmpeg decode (`envelope_power_bins`: 10 ms power means,
  silent where nothing arrived). Measured: S→S `probe dropout` lag 2–3 ms, fit 0.06 dB, offset
  0.0. **Pre-existing, found here:** a video's reference reads its mono clip ~3 dB hot (mpv
  upmixes mono → stereo at −3 dB per channel; the `-ac 1` decode doesn't), so V↔S fits show
  1.2–1.6 dB and a −2 dB `offset_db` (absorbed; no drops) — the video side, not the scene's.
- **RT process callback (the `scene_gain_ramp_reaches_the_bus` flake, 2026-10-28).** The flake
  (~2/10: one 10 ms bin −44.3 dB after the ramp settled at −43, failing the monotonic check) was a
  **real dropout on the bus**, not the meter: the 1 ms samples showed one block −45.4 and the next
  exact −96 (one 64-frame quantum of silence, contiguous timestamps) at a random time — not at the
  ramp — and `pw-top` counted **ERR on `liascape-player-scene.*` only** (bus, its playback and the meter
  0): the worker's stream missed graph cycles. Its process callback ran on the non-real-time
  `lia-scene-audio` main-loop thread; at the 64-frame quantum this machine and the private
  PipeWire run (1.33 ms per cycle), a normal-priority thread scheduled late under load ~4 misses
  one. mpv's AO uses `RT_PROCESS` (why videos never showed it). Fix: `RT_PROCESS` (`bus::
  connect_with`); the callback owns the `Dsp` (`Arc<Mutex<Dsp>>`, never locked by the main loop
  while streaming — no priority inversion), the envelope goes through `Outbox` (`try_lock`; a held
  lock leaves the blocks for the next buffer) and `AudioFlowing`/the level are atomics; the route
  close checks `Control::level()`. Measured (private PipeWire, 60 ramp cycles ≈ 100 s at load ~4,
  same build with the flag toggled): without RT 7 xruns, 3 failing dips; with RT **0 xruns, 0
  dips**; the test 20/20 after. The Task 10 commit's base had the same code (`audio.rs` unchanged
  since Task 6). **A second, measurement-side hazard found with it:** the bus meter's own capture
  (then on the non-RT `lia-bus` thread — RT since Phase 2 Task 14, § Audio bus → Meter) once missed a cycle — a 2.3 ms timestamp gap whose
  block joins two non-adjacent sine pieces (~1 dB off); the test now leaves out a 10 ms bin that
  isn't time-contiguous (≤ 2 allowed) — a dropout on the bus is contiguous −96 blocks and still
  fails.
- **Probe `workers` → `audio`**: `{route, gain_db, no_audio, has_audio, speed, flow_armed,
  flows, envelope_dbfs, envelope_blocks}`.
- **Measured** (private PipeWire, 64-frame graph quantum): a −20 dBFS tone scene on the bus
  −23.01 dB (power mean); an `animate gain.user` 0 → −20 over 300 ms lands as a dB-linear
  staircase-free ramp (10 ms bins −23.0 … −43.0, ≤ 0.7 dB per bin); full-live crossfades with
  equal-level unrelated tones keep the bus power within ±0.13 (V→S), ±0.23 (S→S), ±0.96 dB
  (S→V, the video's onset hold) of steady through a 1 s fade — equal power holds. The real scene
  2371103399 at 1×/1.5×/0.5× on the bus: **release worker** 0 silent 1 ms blocks in 5 s each,
  CPU 5.4 / 6.5 / 5.1 % of a core (the audio thread 1.5 / 2.5 / 1.9 %); a **debug** worker's
  WSOLA step (~0.35 ms) misses 64-frame cycles — 1–2 ms holes every 10–20 ms at ≠ 1× (none at
  1×; audio thread 5–14 %). Ship/measure release.
- **Tests.** Worker units (`cargo test --bin liascape-scene-worker`): `gain_change_ramps_across_one_buffer`,
  `silent_db_is_exact_zero`, `gain_matches_db_to_lin`, `envelope_of_full_scale_sine_is_minus_3_01`,
  `gate_declicks_only_an_audible_stream`, `audio_flowing_once_per_arming`,
  `time_stretch_is_bit_exact_at_1x`, `time_stretch_keeps_pitch_level_and_rate`,
  `time_stretch_speed_changes_are_continuous` (RED with a stepped gain / no gate / no search).
  Lib: `restart_start_folds_live_changes` (+ Gain/NoAudio/Speed), `dropout_uses_scene_envelope_as_reference`.
  `tests/api.rs` (private PipeWire `tests/common/pw.rs::PrivatePw` — moved from `api.rs`;
  SKIP without the binaries): `scene_audio_on_bus_with_identity`, `scene_gain_ramp_reaches_the_bus`,
  `scene_no_audio_toggle_is_live`, `scene_crossfades_are_equal_power_on_the_bus` (V→S, S→S,
  S→V + `probe dropout` each: fit ok, no drops/micro-gaps), `scene_pause_park_and_destroy_on_the_bus`,
  `scene_reroutes_after_pipewire_restart` (the I7 pattern: back on the bus, `gain.pause` ramp-in
  `reason: flowed`, same worker); `--ao null`: `scene_audio_flowing_gates_every_onset` (frozen
  V→S, full-live S→S onto a scene with and without sound, unpark, reveal snap-back, R88 resume —
  each `onset.started {reason: flowed}` after the scene's own `source.audio_flowing`, no
  `onset_timeout`; RED with the worker's `AudioFlowing` suppressed: `reason: timeout`); opt-in
  `real_scene_sound_on_the_bus` (`LIASCAPE_PLAYER_TEST_SCENES`, 2371103399; set `LIASCAPE_SCENE_WORKER_BIN`
  to a release worker for the numbers above). Diagnostic: `liascape-scene-worker --lwe-smoke …
  --audio-dump S` (real sound in, the stretch at 0.5×/1.5× out, raw F32 files + silent-block
  counts).
- **For Tasks 8/9/10/11 + loudness.** Task 9: nothing audio-specific left — a scene B's onset
  waits for its flow like a video's. Task 10: a crash restart resumes at the folded gain, faded
  in over 30 ms by the gate (the crash itself cuts — the process is gone); `Ready` re-sends the
  gain. Loudness learned on first play: done — not from the `SceneEnvelopes` track (1 ms
  max-channel RMS, no K-weighting) but from the worker's own K-weighted segments, § "Scene
  loudness" below. Task 11: `no_audio`/`gain.*`/`speed` on a scene are live like a video's.

### Scene loudness (learned on first play, refined on every play)

Owner decision (Phase 2 plan, "Loudness: learn on first play"): a scene's integrated loudness is measured
over its first ~60 s of play from its worker's own stream, stored in the item's index like a video's
`loudness*`, and normalizes the scene from then on. **Refined (owner 2026-10-28: "60s to normalize for
rest of scene, keep measuring to get a more accurate measure when the scene is played in future (probably
add a max cap for people who will never change wallpaper)")**: measuring goes on past the window and on
every later play, continuing ONE integration over all of them, until a cap. The player measures and
reports; the backend stores and applies (player-adapter.md § Scenes → "Loudness"). Code:
`audio/loudness.rs` (pure), the worker's `audio.rs` (`Dsp`), `sources/scene.rs` (`Learner` per source),
`PROTOCOL` **4** (3: `FromWorker::Loudness`; 4: `Start.loudness` + `ToWorker::LoudnessMeter`).

- **BS.1770-4 / EBU R128, split across the two processes.** The worker's `SegmentMeter` K-weights (the
  standard's 48 kHz shelf + RLB high-pass biquads; the worker's stream is always 48 kHz stereo) the
  scene's sound **after the time stretch, before the gate and the gain** — what it really plays, never
  biased by a user volume, a mute or the normalization itself — and sends one `Segment {power, peak}`
  per 100 ms (channel-summed K-weighted mean square + sample peak) as `FromWorker::Loudness {segments}`
  (sent from the audio thread's main loop, taken from the RT callback through the `Outbox` by
  `try_lock`, like the envelope). **Only buffers that pulled the scene's sound into a real stream
  count:** `plays` (not paused — the worker's `paused` is the effective one, player pause included —,
  not `no_audio`, not a fade-out, not quitting) and `real` (a PipeWire stream or the `--ao null` timer,
  never the PipeWire-down fallback). A stepped clock never plays sound, so it never measures. The
  compositor's `Learner` (one per scene **path**, shared by its sources through the `Book` — "One
  measurement per path" below —, **kept across worker restarts**) forms the 400 ms gating blocks from 4 consecutive segments (75 % overlap), keeps
  those above the absolute gate (−70 LUFS) and integrates with the relative gate (−10 LU):
  `lufs = −0.691 + 10·log10(mean of the gated blocks)`. A stereo 1 kHz sine at −20 dBFS peak reads
  −20.0 LUFS (EBU Tech 3341 case 1 −23 → −23.0; a 997 Hz 0 dBFS mono sine −3.01).
- **What's kept: a histogram, not the blocks** (the standard trick for a continuable integration).
  BS.1770's relative gate is computed from the mean of ALL blocks, so two sessions can't be combined
  from their results (a quiet play then a loud one: the loud one gates the quiet out — −20, where a
  seconds-weighted energy mean of the two results says −25.8). Each block's loudness goes into a
  **0.1 LU bin over −70…+5 LUFS** (750 counts; louder → the last bin); the integration runs over the
  bins at their centres (±0.05 LU per block), and two histograms simply add. The **state** = `{v: 1,
  first, counts: [the non-zero span], peak_dbfs}` (`Learner::state_json`, typically a few hundred
  numbers) — what the backend stores and hands the next play back.
- **Seeded plays.** Source prop **`loudness_seed`** (Map; `{}` = none) = a stored state: a `Learner`
  starts from it (`with_seed`: its counts, peak, audible seconds) and continues the SAME integration.
  Read at open — and used only when the player holds less of that path itself (next bullet); a live
  set follows the same rule (`Book::reseed`: adopted only if it covers more audible play, who measures
  unchanged — never counted twice, never shrunk; the backend only sets it at create); a `path` change
  drops it (the old folder's). A malformed seed is ignored (measured from nothing).
  Each session forms its own first block (its first 3 segments start none: 0.3 s less than one long
  run).
- **One measurement per path (`audio::loudness::Book`, 2026-10-29).** The backend reads the seed from
  its index at create, which can lag the player: `stop_now` → `/apply` of the same scene created the new
  source before the backend had stored the stopped one's end-of-play report (stored off its event
  thread), so it continued the report before — the stretch between the two lost (adapter IT, 2 of 3
  runs); a rest too short to report at the end (< a twelfth of the window) never reached the index at
  all. So the compositor keeps its own: `SourceHost` owns one `Book` (path → `Learner` + the live
  sources of the path, in open order), every `SceneSource` joins its path at open / `path` change and
  leaves it at teardown / `path` change / drop. **The key is the canonical folder**
  (`sources::scene::loudness_key`: `fs::canonicalize`, else the path as given — computed at the join, never
  per segment), so `/home/…` vs its physical path, a trailing slash and a `local/<id>` symlink are one entry.
  **A source opening with no seed** (`loudness_seed` absent — and every `path` change) **on a folder no
  source plays drops that folder's idle entry first** (`Book::forget_idle`): the backend has nothing for the
  item — deleted and re-added, a Workshop update —, so a stale measurement isn't continued; a stale-but-present
  seed keeps the reopen-continues rule. Trade-off (decided by the review): a first play shorter than its first
  report (no index state yet) reopened right away starts over instead of continuing — nothing double-counted,
  at most that rest lost. **A source continues the path's measurement** — live
  (a transition A → A' of one scene: A''s open takes A's live state; also a reopen during a real-clock `stop`'s
  fade-out, when the stopped source is still a node — then it makes no end report) or last left (a reopen: no wait,
  no index round trip — the bound on a switch is 0 ms) — **unless its seed covers more audible play**
  (another lineage: after a compositor restart, the index edited) — then the seed is adopted. A seed is
  never merged into a learner, only one of the two kept, and every report the backend stored came from
  the book's lineage (or the one adopted): **no block is ever counted twice**. **One live source of a path
  measures — the head** (`Book::push`): a source joining a path that plays is **pending until its first
  segment** — A measures on while A' loads its worker, is paused or waiting, is restored broken or past its
  restart budget (no worker: it never sounds) — and only then takes over (A's segments are dropped from
  A''s first one on: the same sound twice — A's leave then reports nothing). A member that joined *before*
  the head never takes over by sounding. When the head leaves, the newest member that joined before it
  measures on (it was playing), else the newest pending one; a pending member leaving reports nothing and
  starts no session; a source alone on its path measures at once. A meter switched off at the cap comes
  back on if the path's measurement stops being capped (`update` re-checks every 250 ms while it's off).
  Taking over starts a session (`Learner::begin_session`: `seed_s` = what's measured so far, the block
  forming and `played_s` start over, the unreported rest stays unreported — the next report includes
  it, once). The measuring source's leave reports what's left (`finish`, the thresholds below); the
  learner stays for a reopen — up to `BOOK_IDLE_KEEP` (64) paths without a live source, the least
  recently left dropped beyond (that one falls back to the backend's seed). In memory only: a
  compositor crash/restart behaves as before (below).
- **Per audio configuration (`loudness_key`, 2026-10-29; docs/TODO.md "Offline scene loudness → integration").**
  Source prop **`loudness_key`** (Str, `""` = unknown) = the backend's fingerprint of the scene's sound under its
  `scene_props` (the offline estimator's, below). The book's entry is **(canonical path, key)**
  (`sources::scene::book_key`: the path alone for `""`, else `path\u{1f}key`), so two configurations of one scene
  never share a histogram. Read at open; a **live change** (`change_loudness_key`): `leave` the old key (its rest
  reported WITH the old key — `finish`, the usual thresholds), `join` the new one WITHOUT `forget_idle` (a
  configuration played earlier — toggled back — continues its own measurement), the seed cleared (it was the old
  configuration's; the backend sends the new one's right after: `reseed`, adopted only if it covers more), the meter
  re-checked, and **the worker's segments of the next `KEY_CHANGE_SETTLE` (500 ms, wall clock from the `set`) dropped**
  (the worker applies the new `scene_props` within a frame, but the stream's buffers still carry the old mix). The
  same key again changes nothing. A `path` change clears it (the old folder's). `hello.capabilities` carries
  **`scene_loudness_key`** (the backend sends the prop only to a player that has it). `scene.loudness` carries `key`;
  the `workers` probe's `loudness` carries `key` + `dropped` (segments dropped while settling). Api
  `scene_loudness_key_change_never_shares_a_histogram` (k1 → k2: k1's end report with key k1, k2 from 0 s, 3 segments
  dropped in the first 350 ms, k2's window report = its own play minus the settle; k2 → k1 continues k1's 3.0 s; the
  same key again: no report) — RED before (no `key`, one measurement per path).
- **The window = audible play.** `LIASCAPE_PLAYER_LOUDNESS_WINDOW_S` (default 60; tests 1–6) seconds of
  blocks **above the absolute gate** — a silent stretch doesn't count, a paused or muted one isn't
  even measured. **Reports** (`scene.loudness {id, path, key, lufs, peak_dbfs, seconds, session_s, seed_s,
  played_s, complete, capped, window_s, cap_s, state}`, info, comp `scene` — each one cumulative over
  every play): when the audible seconds over every play (seed included) reach the window; then after
  **each further window** of audible play (60 s); **at the end** (`finish` — destroyed, switched away,
  retired, its `path` changed) for what's left unreported if ≥ a twelfth of the window (5 s — a quick
  switch costs no index write) and the total is ≥ a third of the window (20 s); and once **at the cap**.
  `seconds` = audible seconds over every play, `session_s` = this source's, `seed_s` = the seed's,
  `played_s` = segments this source received (audible or not) — `seed_s`/`session_s`/`played_s` are of
  the measuring source's session (since it joined or took over), `complete` = `seconds` ≥ the window
  (else a partial: switched away early on a first play), `peak_dbfs` = the sample peak over every play
  (≤ the true peak; null if none). So a first play normalizes after 60 s (as before) and keeps refining.
- **The cap.** `LIASCAPE_PLAYER_LOUDNESS_CAP_S` (default **1800** = 30 min of audible play over every play;
  never below the window; tests 3): reached → one last report (`capped: true`) and measuring stops for
  good: the compositor sends **`ToWorker::LoudnessMeter {on: false}`** (folded into a restart's
  `Start.loudness`) and the worker stops K-weighting (`Dsp`: `st.meter`) — no `Loudness` message any
  more. A seed already at the cap → `Start.loudness: false` from the first moment, nothing metered,
  nothing reported. Why 30 min: the integrated loudness of a scene's sound has converged long before
  (its loops/variations are minutes long at most); past that the bins only grow, a wallpaper that's
  never switched away would accumulate and keep a (small) DSP + 10 messages/s going forever.
- **Silence:** a scene without sound (no stream: `has_audio` false) sends no segments; a stream of
  digital silence or anything under −70 LUFS has no gated block → never an event, nothing stored,
  never normalized.
- **Edge cases.** Speed ≠ 1: measured after the pitch-kept stretch, which keeps the level (2×
  measured −19.99 for the −20 tone); the window is wall seconds of audio. A worker crash/hang loses at
  most the partial segment in flight (the `Learner` lives in the compositor; the restarted worker's
  segments continue it). A **compositor** crash/restart loses what this source measured since its last
  report (the restored source — its `loudness_seed` is the one it was created with — continues from
  that seed; the backend keeps whichever report covers more seconds, so until the restored one passes
  the stored one its reports are ignored, then it replaces it: bounded loss, never a double count).
  Two sources of one scene at once (a transition to the same item): the newer continues the older's
  live measurement from its first segment and only it measures from then (the `Book` — the older one's
  part after the hand-over isn't measured: the same sound; nothing is lost or added twice). Paused/`no_audio`: not
  measured (above); `gain.mute`/`gain.user` −96: still measured (the content plays, pre-gain).
- **Applying it** is the backend's: the scene source's **`gain.normalize`** slot (the summed `Gains`
  → the worker's stream; § Units) — set at create from the stored value, live through `animate` (a
  setting slot: `Runtime::setting_anim`, unpaused clock — it lands while paused too).
- **Probe `workers` → `loudness`**: `{seconds (audible, every play), session_s, seed_s, played_s,
  lufs (so far, null = nothing audible), done (capped or ended), capped, window_s, cap_s, measuring
  (this source is its path's measuring one — the `Book`; the other values are the path's), received
  (segments the worker sent, measured or not — stands still once the meter is off), meter (the worker
  meters), key (its `loudness_key`), dropped (segments dropped settling after a key change)}`.
- **Tests.** Units `audio::loudness` (`stereo_1khz_sine_reads_its_level_in_lufs`,
  `k_weighting_shapes_the_spectrum`, `gating_excludes_silence_and_quiet_passages`,
  `silence_learns_nothing_and_the_window_is_audible_play`,
  `a_source_ending_early_reports_a_partial_from_a_third_of_the_window`, `window_knob` — RED by
  mutation: K-weighting bypassed + gates off → 5 of 6 fail); worker `loudness_segments_count_only_played_sound`
  (pre-gain, none paused / on the fallback timer). `tests/api.rs` (`--ao null --clock real`, the
  window 1–6 s): `scene_loudness_is_learned_once_after_its_window` (−20 ± 1 LUFS, once, after ≥ the
  window; at 2× with a −30 dB `gain.user` too), `silent_scene_learns_no_loudness` (no stream /
  digital silence), `paused_and_muted_play_never_counts_toward_loudness` (player pause and
  `no_audio`: audible time still), `scene_ended_early_reports_a_partial_loudness`,
  `scene_loudness_survives_a_worker_restart` (SIGKILL at 1.5 of 3 s: learned < 2.8 s after) — RED
  before: 5 of 5 failed (no event / no progress). **Refinement (2026-10-28):** units
  `histogram_merge_across_sessions_equals_one_long_integration` (5 levels incl. silence, 4 splits:
  seeded session 2 vs one exact block integration < 0.1 LU), `relative_gate_is_recomputed_across_quiet_and_loud_sessions`
  (−38 for 30 s then −20 for 10 s → −20, either order), `reports_each_further_window_and_at_the_end`,
  `cap_stops_measuring`, `state_round_trips_and_a_bad_seed_is_ignored` (RED against the API with the old
  semantics: 5 of 5); worker `loudness_segments_count_only_played_sound` + meter off; lib
  `restart_start_folds_live_changes` + `LoudnessMeter`; api `scene_loudness_is_learned_once_after_its_window`
  (now: not again before the next window, and a report at the end), `scene_loudness_accumulates_over_two_plays`
  (−20 then −23 dBFS plays of one folder, the second seeded with the first's state → `seed_s`/`session_s`,
  the energy mean of both within 0.3 LU), `scene_loudness_stops_at_the_cap` (window 1, cap 3: reports at
  1/2/3 s, `capped`, `received` stands still, nothing at the end; seeded at the cap → nothing metered) —
  RED by mutation: seed ignored + cap off → both fail; the meter-off message suppressed → the cap test
  fails (`received` 36 → more). **The book (2026-10-29):** units `book_reopen_continues_the_last_source_never_twice`
  (seeded with the window's report → continues the end; the up-to-date seed → the same, not twice; a
  rest too short to report kept and reported once; a longer seed adopted), `book_hands_a_live_measurement_to_the_newest_source`,
  `book_keeps_a_bounded_number_of_idle_paths`; api `scene_reopen_continues_the_end_of_play_measurement`
  (destroy → a create seeded with the window's report continues the end's 3.0 s, not 2.0; the up-to-date
  seed doesn't double it; a second source beside a playing one continues its live 4.0 s, `measuring`
  moves to it, its report = `seed_s` + `session_s`, the first reports nothing at its end) — RED before:
  the reopen read 2.0 s. **Review fixes (2026-10-29):** units `book_hands_a_live_measurement_over_at_the_newest_sources_first_segment`,
  `book_head_leaving_passes_to_an_older_member_first_then_a_pending_one`, `book_reseed_adopts_only_more_and_keeps_the_head`,
  `book_forgets_an_idle_path_only_without_live_sources`, `book_idle_eviction_is_least_recently_left`; api
  `scene_silent_second_source_leaves_the_playing_one_measuring` (A' paused on VIRTUAL-2: A measures on, A' takes over
  at its first sound with everything so far as its seed, A measures again after A' goes),
  `scene_live_seed_on_a_two_source_path_never_shrinks_it`, `scene_path_changes_and_folder_spellings_share_one_measurement`
  (a symlink + trailing slash = X's measurement; `path` onto X pending then measuring, back onto Y afresh, X back to A),
  `scene_reopen_continues_the_end_of_play_measurement` (C pending until shown); harness `tests/scene.rs`
  `dropped_scene_source_hands_its_loudness_over` (`Drop`), `scene_meter_comes_back_on_when_the_path_is_no_longer_capped`
  (per-source caps — only `SceneOpts` can make a path uncap).

**Offline estimate (2026-10-29; `scene/loudness_estimate.rs`, `scene/pkg.rs`, `liascape-player scene-loudness`).**
What the learner above would measure, computed from the scene's files before it plays — so a scene can be
normalized from its first second. Wired into the backend 2026-10-29 (player-adapter.md § Scenes → "Loudness" → "Per
audio configuration"; web-backend.md § Scene loudness): run on import / at startup / from Settings, and on every
property commit (its fingerprint = the source's `loudness_key`).
- **`scene.pkg`** (`scene::pkg::Pkg`, read-only; LWE's `PackageParser`): little-endian `u32 n + n bytes` header
  `PKGV00xx`, `u32 count`, `count × {u32 n + name, u32 offset, u32 length}`, then the data — an entry is
  `[end of the table + offset, + length)`. Every `scene.pkg` of the owner's library (96, headers `PKGV0001`…`0024`)
  parses with one layout: entries contiguous from offset 0, the last ending exactly at EOF. Lookup exact, else
  ASCII-case-insensitive (fork patch 0016's rule). `pkg::build` writes one (fixtures).
- **What plays, by [`Model`]** — both models play Wallpaper Engine 2.8.485's decompiled rules
  (`docs/player/spikes/we-sound-semantics.md`), which LWE plays since fork patch 0018 (§ "LWE core"): stream
  amplitude = `volume²` (unclamped), a bound property's value (slider = its value, bool = 1/0, `{name,
  condition}` = 1 iff equal: LWE's `DynamicValue` rule — WE's own conversion not decompiled), `sound` a string
  or a list, absent/unknown `playbackmode` = `loop`, `loop` = one random file at a time back-to-back
  (time-weighted like a playlist, in listed order), `random` = one random file at a time + the mean of
  `mintime`/`maxtime` (defaults 1 / 5 s) of silence, `single` = one random file once (the first stands in),
  `startsilent` = silent. `lwe` (default) = what the player plays; `we` = the same plan, kept for the
  fingerprint's prefix and its notes (a `startsilent` under `we` is `low` — a WE script could start it; under
  `lwe` certain: LWE's SceneScript has no sound methods; the scripts note is `we`'s). Before 0018 `lwe` was
  LWE's old behaviour (every file of an object at once, unity gain, `volume` and user properties ignored).
- **Per-file stats, cached** (`FileStats`, `Cache`): each file decoded ONCE by ffmpeg (`PATH`; a package entry
  piped through stdin; `-ac 2 -ar 48000 f32le`, so a mono file is at −3 dB per channel like LWE's resampler;
  ≤ 1800 s; 120 s timeout, PDEATHSIG) and reduced through the live `SegmentMeter` to per-100 ms K-weighted powers +
  peaks; kept in memory and in `$XDG_CACHE_HOME/liascape/scene-loudness/<fnv64(key)>.json` (key = path + size +
  mtime, + entry name/offset/length for a package). A re-estimate for other properties is a re-mix: no decode.
- **Mix → the live learner.** Segment power of the mix = Σ gain² · power (K-weighting is linear; unrelated sounds'
  cross terms average out over 100 ms — the same tone twice would be under-read by up to 3 dB, a documented limit),
  peak = Σ gain · peak (a bound), simulated over ≥ 60 s (several loops of different lengths: 4 × the longest, so
  their phases mix; ≤ 1800 s; `--horizon S` = exactly the first S s), fed to `Learner` itself → the SAME
  `state_json` (`state`) the live learner continues, + `seed.state` scaled to `--seed-seconds` (default 10 s,
  largest-remainder counts) — the weight an estimated seed should carry.
- **Fingerprint** (`fingerprint`): `<model>-<fnv64>` over `SOUND_SEMANTICS` and the active tracks (object,
  pattern, files, gain to 1e-4), order-free: property changes that don't touch audio (colours, visual toggles)
  never change it, one that changes a sound's level or which sounds play always does. **`SOUND_SEMANTICS`** = how
  the player plays sound objects: 1 = LWE before 0018, **2** = 0018 (2026-10-29) — every fingerprint changed
  with it, so nothing keyed by a fingerprint continues a measurement of the old sound. Bump it whenever the
  player's sound semantics change. The backend stores every scene's loudness by it (`sceneLoudness[<fingerprint>]`,
  library.md § Loudness) and keys the player's measurement with it (`loudness_key`, above).
- **CLI** `liascape-player scene-loudness <scene dir> [--assets <dir>] [--props '<scene_props json>'] [--model
  lwe|we] [--seed-seconds S] [--horizon S] [--cache <dir>|--no-cache]` → one JSON line `{path, estimated: true,
  model, fingerprint, lufs, peak_dbfs, audible_s, horizon_s, state, seed {weight_s, state}, confidence {level
  high|medium|low, notes}, sounds [{id, name, files, playbackmode, volume, gain, active, silent}], files [{file,
  duration_s, lufs}], cache {hits, disk_hits, decodes}, ms}`; exit 1 = not a scene / unreadable (`{path, error}`).
  Measured: 80–250 ms per scene with one 1.5–4 min mp3 (decode), a re-mix from the disk cache 0.2–1.9 ms in-process (`ms`; + the process start).
- **Validated (since 0018, 2026-10-29)** against the patched LWE's real output: `WPENGINE_SOUND_SEED=7
  liascape-scene-worker --lwe-smoke <scene> --assets … --out … --audio-dump 45` (the 1× dump = what the worker's
  meter sees; the dump renders at 30 fps meanwhile, so playlists advance) of 20 scenes, measured through the same
  estimator (the dump as a one-shot WAV) vs `--horizon 45`: within ±0.10 LU in 17, ±0.25 in 18, median −0.05;
  the two outliers are random picks, not rules — 3174556087 (`random`, 11 files) −0.91 and 3013489778 (`loop`, 5)
  −0.65: the estimate's 45 s is the FIRST listed file, the player picked another; with the picked file
  (identified by correlation) −0.08 / −0.04 → all 20 within ±0.15, 19 within ±0.10, median −0.04. The old
  outlier 3289734539 (vocal + instrumental at once, −2.64) is −0.06 (it plays one of them: the dump = 0.49 ×
  the instrumental, residual −147 dB). Over a full horizon a multi-file object's estimate is the time-weighted
  expectation; a first live report reflects one pick. Behaviour checks on real scenes (dump fits, same tools):
  2951169110 = "believe in you" × 1.0 + the orchestral × 0 until `--prop-at 15 orchestralversion=1` → both × 1.0
  from 15 s; 3276522107 (LWE can't load it — corpus `load_failed`; its sound objects in a bare scene): wind/inside
  0.49, rain 0.25, train 0 → × 1.0 after `--prop-at 10 musictrainride1000eyes=1`; 2375914945 `musicvolume` 0.8 vs 2
  = ×6.250 = +15.92 dB (peak 2.04: the raw scene sound goes over 0 dBFS, the worker's gain stage follows);
  2886313155 (`random`, 1..5 s) over 480 s: gaps 1.98 / 4.85 s from each file's end.
  *Before 0018* (the old `lwe` model vs the unpatched LWE, 53 scenes): ±0.10 LU in 46, the vocal+instrumental
  case −2.64. Against the live learner's stored state (pre-0018 sound): 2375914945 −16.59 vs −16.58,
  3422085307 −5.11 vs −5.12, 2371103399 −14.57 vs −15.18 — those stored states are stale for 8 of the 10
  measured scenes now (docs/TODO.md).
- **`lufs_if_coherent`**: tracks of equal length (± 0.5 s, ≥ 5 s) of different objects start together and may be
  versions of one recording (since 0018 the files of ONE object never play together); `mix_with(…, coherent: true)` sums them in amplitude (`(Σ gain·√power)²`) — the upper bound; a
  `low` note says so.
- **Tests** (units, `scene::pkg` + `scene::loudness_estimate`): `generated_pkg_round_trips`,
  `reads_an_entry_from_a_file`, `garbage_and_truncation_are_refused`; `sine_at_minus_20_dbfs_reads_minus_20_lufs`,
  `simultaneous_sounds_mix_as_a_power_sum` (vs the really summed signal ≤ 0.05 LU),
  `volume_forms_and_property_bindings`, `audio_property_changes_the_fingerprint_a_visual_one_never` (a bool bound
  to one of two sounds: fingerprint changes, the estimate drops by that sound's power; a colour: unchanged; `lwe`:
  follows it the same way), `fingerprint_carries_the_sound_semantics`, `lwe_plays_like_we_and_loops_mix_over_the_horizon`
  (equal plans; a multi-file loop is one track at volume²; `single` once; an unknown mode loops; the string form),
  `random_mode_is_a_time_weighted_mix` (vs the real concatenation ≤ 0.05 LU), `startsilent_and_zero_volume_are_silent`, `scaled_seed_is_a_valid_learner_state`,
  `cache_reuses_stats_in_memory_and_on_disk`, `packaged_scene_end_to_end` (ffmpeg; SKIP without it: a generated
  `scene.pkg` with a stereo and a mono WAV, −20.0 LUFS, the property turning the second on, no re-decode),
  `equal_length_files_get_a_coherent_bound` (one recording twice: power sum +3.01, the bound +6.02 = the real mix);
  `tests/scene_loudness.rs::scene_loudness_cli_estimates_a_packaged_scene` (the binary: `state`/`seed.state` load as
  learner seeds, a colour keeps the fingerprint and decodes nothing in a new process — the disk cache —, the bool
  changes it to the files' power sum, `lwe` follows it like `we`, exit 1 / 2).

### GPU budget and VRAM (Task 8)

Per-output scene fps, the worker GPU budget (owner: "GPU budget = a setting, default
auto-throttle"), the per-scene VRAM guard and the system low-VRAM rule (owner: "VRAM, round 3").
Code: `scene/budget.rs` (pure), `vram.rs` (measuring + the pure low-VRAM rule), `sources/scene.rs`
(`observe_budget`, `stop_for_vram`), `redraw.rs` (the present gate), `runtime.rs`
(`feed_scene_budgets`, `vram_tick`, `VramState`), `sources/host.rs` (`suspend_media` /
`resume_media`), `probe/vram.rs`, the worker's `gputimer.rs`.

- **Rates.** `demand` = the max over the showing outputs of `eff_fps(scene_fps, refresh)`
  (Task 5); the scene **ticks at `min(demand, the budget's cap)`** (`SceneSource::tick_hz`;
  `demand_hz()`, `throttle_cap()`). A demand at or below the cap lifts it (`scene.unthrottled
  {reason: demand}`). Every change is live on the same worker (the next tick is scheduled on the
  new period).
- **Per-output present gate (`redraw.rs`, Wayland and `--redraw-policy content`).** One worker
  serves every output (D1), so a new scene frame wakes output `<c>` at most
  `eff(out:<c>.scene_fps, refresh)` times per second: `Redraw::mark_shown_gated(routes, changed,
  now, period)` (`routes` = `redraw::Routes::of(graph)`, F6b) (the runtime's `scene_gate_period`: `Some(1/eff)` for a hosted scene, `None` for
  anything else) lets a scene frame through on a grid of that period (`GATE_SLACK` 2 ms early is
  on time; a whole period behind restarts the grid at now); an early frame is **deferred to its
  slot** (`gate_due`, promoted at the top of every `render_paced` by `promote_due`) — never
  dropped, so the last frame before a pause is still drawn. An output woken by anything else (a
  video it shows, an animation — a transition presents every callback) shows the scene's newest
  frame with it. Headless every-tick composing is unaffected. Unit
  `scene_frames_wake_each_output_at_its_scene_fps` (RED with the gate bypassed: DP-2 60 instead of
  15).
- **A scene at the refresh is paced by frame callbacks, not the gate (Task 14, on-machine).** On
  an output with frame callbacks (Wayland) whose `eff(scene_fps, refresh)` is its refresh
  (`scene_fps` 0 or ≥ it), `redraw::scene_gate_period(scene_fps, refresh, callbacks)` is `None` —
  ungated — and while such a scene plays at that rate (`SceneSource::clock_running`, `tick_hz` ≥ the
  refresh: not paused, not throttled below it, not holding a crashed worker's frame) the output
  **presents on every frame callback** like an animation (`runtime::scene_paces_output` →
  `render_paced`'s `animating`). Why both: the gate's grid (1 / the *rounded* refresh, 6.944 ms for
  143.981 Hz) drifted against the vblank, and whenever its slot fell after a callback the output
  went idle and presented off-callback at the slot — measured with `scene_fps 0`: DP-1 144
  presents/s but **0 of 288 intervals paced** for ~20 s at a time, DP-2 235–239.5 presents/s with
  ~100 idle gaps/s. Ungated alone fixed DP-1 but not DP-2: the worker's frames come on the loop's
  clock (240.000 Hz) against a 239.76 Hz vblank, so presenting only on a *new* frame still left
  callbacks with nothing new (paced mean 3.4 ms on a 4.17 ms display — two presents in one refresh).
  After both: DP-1 6.94 ms (288/288 paced), DP-2 4.17 ms (478–480/480) for all four step-1 scenes
  (`tests/onmachine/scenes.sh outputs`); a repeat only when the two clocks slip (~once per 4 s at
  240 Hz). Below the refresh (30 fps on 144 Hz) the gate and content pacing are unchanged. Unit
  `scene_at_the_refresh_is_paced_by_frame_callbacks_not_the_gate` (RED: `Some(6.944 ms)` for
  scene_fps 0 on 144 Hz); the presenting half is runtime-only (no hermetic Wayland) — guarded by the
  on-machine step.
- **GPU time (`bin/liascape-scene-worker/gputimer.rs`).** One `GL_TIME_ELAPSED` query around each
  frame's rendering (scene + blit into the slot), read back **only once `QUERY_RESULT_AVAILABLE`**
  — normally a frame or two later — never waited on; ≤ `MAX_QUERIES` 4 in flight (all busy → that
  frame goes untimed); a driver refusing queries turns the timer off (`gpu_ms` stays `None`, and the
  budget then never throttles). `Frame.gpu_ms` = the newest measurement that finished since the
  previous frame (`None` when none did) — so each measurement is reported once. Synthetic knob
  `report_gpu_ms` (tests) stands in for it. Measured: the synthetic 1080p frame 0.03 ms. Cost:
  `transport_meets_the_spike_budget`'s worker CPU (144 fps, load ~4) read 6.6 / 6.0 % with the
  timer and 4.4 / 6.0 % with its `begin` disabled — load noise; counted (2026-10-28): the query
  costs 7 k user instructions per frame (~11 µs, ≈ 0.15 % at 144 fps — kept: the budget needs it),
  § "Frame transport" → "What the worker's CPU figure is".
- **The budget (`scene::budget::Budget`, pure; units `budget_halves_under_starvation_and_recovers`,
  `budget_ignores_misses_a_light_worker_cannot_cause`, `budget_floor_is_10`,
  `budget_demand_change_lifts_a_cap_it_meets`).** `observe(now, missed_pct, gpu_ms_p50,
  fps_actual) -> Option<new rate>`: **throttle** when `missed_pct` > `THROTTLE_MISSED_PCT` 2 %
  **and** `gpu_ms_p50 × fps_actual ≥ GPU_LOAD_MS_PER_S` 400 ms/s (a worker using < 40 % of the GPU
  is never the cause) → cap = max(`FLOOR_FPS` 10, fps_actual / 2), only if that lowers the rate;
  after any change no further cut for `SETTLE` 2 s (the miss window must hold only frames made at
  the new rate); **recover** after `RECOVER_AFTER` 5 s in a row below `RECOVER_MISSED_PCT` 0.5 %:
  cap × `STEP_UP` 1.25, each step after another calm 5 s; reaching the demand lifts the cap. A
  demand below the floor is never touched.
- **Feeding it (`Runtime::feed_scene_budgets`, every `OBSERVE_EVERY` 500 ms, real clock).**
  `missed_pct` = the worst, over **every** output (Phase 2 Task 14 — the GPU is shared; it
  was the outputs showing the scene, `Graph::outputs_of`: on-machine a ~6 ms/frame worker on
  DP-1 cost DP-2's 240 Hz video 71 missed frames in 2 s while the budget, reading DP-1 alone,
  eased the cap back up; `probe::frames::worst_missed_pct`, unit
  `budget_miss_rate_is_the_worst_output_not_only_the_scenes`), of the `frames` probe's paced
  window (`missed / count` over 2 s; no paced samples = 0). **Open (TODO):** the throttle stops
  at the GPU-load guard (400 ms/s) — on this machine a single heavy draw at 220–260 ms/s still
  cost the 240 Hz output 33–38 missed frames per 2 s (the worker's low-priority context isn't
  preempted mid-draw; with explicit sync off each swap waits for the GPU on the loop). The scene adds
  its **own** missed frames (deviation from the plan's text, which only counts the outputs): a
  worker latching under `DEFICIT_RATIO` 90 % of its tick rate over a whole 2 s window at that rate
  (`rate_since`: reset by a rate change, the load's first frame, an un-pause) counts its deficit
  percentage — an output presenting below its refresh (a 30 fps scene on 144 Hz) has idle gaps
  between presents, so `paced` never sees its misses. `gpu_ms_p50` / `fps_actual` = the worker's
  `Frame.gpu_ms` and the frames latched over the last 2 s. Skipped while paused, stepped, not
  loaded or stopped. `player.scene_throttle` false → any cap lifted at once
  (`scene.unthrottled {reason: off}`), fixed fps.
- **Events (comp `scene`):** `scene.throttled {id, fps_from, fps_to, demand, gpu_ms, fps_actual,
  missed_pct}` (warn) on every cut; `scene.throttle_eased {id, fps_from, fps_to, demand,
  missed_pct}` (info) on a step up still below the demand; `scene.unthrottled {id, fps_from,
  fps_to, reason: recovered|off|demand}` (info).
- **Per-scene VRAM guard (`player.scene_vram_limit_mib`, 0 = off, the default).** Each sample
  (below), a scene worker whose own VRAM is over the limit for `Timing::scene_hold` (2 s — a
  load's transient peak isn't a reason) is stopped: `SceneSource::stop_for_vram(used, limit)` —
  `scene.vram_exceeded {id, path, pid, used_mib, limit_mib}` (warn), the worker `stop()`ped
  (quit, reaped), `SourceEvent::Error {"<path>: stopped: used 1800 MiB > limit 1536 MiB of VRAM
  (vram_exceeded)"}` → `source.error` (so the backend advances a rotation / a single wallpaper
  keeps its last frame), but **never a crash**: no restart, no crash record, no `worker.broken`,
  `workers` probe `state` not `broken` and `vram_stopped {used_mib, limit_mib}`. The last frame
  stays shown — **from one imported slot** (2026-10-28, `release_ring_but_shown`): a dmabuf lives
  while anyone holds it, so the stopped worker's whole ring (~3 × the export size of GPU memory)
  stayed alive through our imports; now every slot but the shown one is dropped, the frames still
  queued from it are forgotten (`Latch::forget_worker` — a queued frame of a dropped slot must never
  latch) and the shown one is never released (`tests/scene.rs::vram_stopped_scene_keeps_only_its_shown_slot`:
  slots 3 → 1, the held frame pixel-identical for 1 s, a `path` change then brings a new ring; RED
  before: 3 slots). Not a copy into a plain texture: same memory, and `stop_for_vram` needs no GL. A
  `path` change starts a new worker (clears it; its first latched frame drops the kept slot); raising
  the limit doesn't restart a stopped one. Guard-relevant pids: workers not stopped.
- **Measuring (`vram.rs`).** `vram::Probe` — `sample(pids) -> Sample {total_mib, free_mib, procs:
  Option<{pid: MiB}>}` — chosen by **`LIASCAPE_PLAYER_VRAM_PROBE`**: `auto` (default: the first that
  works of) **NVML** (`libnvidia-ml.so.1` **dlopened** — tried by soname, then
  `/run/opengl-driver/lib`, `/usr/lib{,64}`, `/usr/lib/x86_64-linux-gnu`; never linked;
  `nvmlDeviceGetMemoryInfo` of the GPU our own pid runs on (else device 0) +
  `nvmlDeviceGet{Graphics,Compute}RunningProcesses_v3|_v2` per pid, summed over devices) →
  **DRM** (AMD `/sys/class/drm/card*/device/mem_info_vram_{total,used}`, the largest card; per
  process `/proc/<pid>/fdinfo/*` — `drm-resident-*` > `drm-memory-*` > `drm-total-*` for regions
  `vram*`/`local*`, each `drm-client-id` once — AMD and Intel) → **`nvidia-smi`** (plain output:
  the memory line + the process table; `--query-compute-apps` lists compute processes only, never
  a GL client like ours; every `NVIDIA_SMI_INTERVAL` 3 s at most) | `nvml` | `drm` |
  `nvidia-smi` | `none` | **`fake:<file>`** (tests: a JSON `{total_mib, free_mib, procs: {"<pid>":
  MiB}}` read at every sample; a missing/bad file = no sample). An Intel GPU exposes no
  `mem_info_vram_*` sysfs, so it has no system total: no probe (`vram` probe `probe: none` + the
  reason) and neither rule acts — a gap for Intel discrete cards, noted. `vram::Monitor` runs the probe on its own thread **`lia-vram`**
  (every `Timing::interval`, 1 s), never the loop (NVML ~1 ms, `nvidia-smi` ~50 ms); the loop
  hands it the pids (the compositor + live scene workers) and reads the newest sample each tick.
  It runs only while a rule needs it (low mode not `off`, or a limit with a scene, or a hold);
  `none` answers once and its thread exits. Measured on this machine (NVML 595.84): total 8192,
  the compositor 17.7 MiB, a synthetic scene worker 33 MiB; `nvidia-smi` agrees (17 / 33).
- **The low-VRAM rule (`vram::LowVram`, pure; `player.vram_low_mode` `stop` (default) | `pause` |
  `off`).** Thresholds relative to the card: **low** = free < `low_mib(total)` = max(512 MiB,
  5 % of total), held `enter_hold` **3 s** with no sample at/above it → `Engage`; **free again** =
  free − reserve ≥ `resume_mib(total)` = low + max(1024 MiB, 10 %), held the resume hold
  (**10 s**, base) → `Release`; a dip under it restarts the hold. **Reserve** = what our resumed
  sources will take back: `stop` mode = our processes' VRAM at the engage (per-process numbers), or
  without them the rise of free VRAM in `settle` (2 s) after the stop; `pause` = 0. So memory we
  freed ourselves never reads as "free again" (no stop → resume → low loop). **Anti-flap:** an
  engage within `FLAP_WINDOW` 60 s of the last release doubles the resume hold (≤
  `RESUME_HOLD_MAX` 160 s); `FLAP_RESET` 5 min without one resets it. No sample for
  `UNAVAILABLE_RELEASE` 30 s while engaged → release (a dead probe never keeps the wallpaper
  stopped); a pending dip with a failed sample starts over. 8 GiB card: low < 512 MiB free,
  resume at ≥ 1536 MiB (+ reserve). Timing for tests: `LIASCAPE_PLAYER_VRAM_TIMING=<interval>,<enter>,
  <resume>,<settle>,<scene_hold>` (ms). Units `low_vram_never_flaps_under_light_load`,
  `low_vram_engages_after_hold_and_resumes_with_hysteresis`,
  `low_vram_reserve_is_measured_without_per_process_numbers`, `low_vram_backs_off_when_it_flaps`,
  `low_vram_releases_when_the_probe_dies`, `thresholds_scale_with_the_card`, the parsers.
- **The hold (`Runtime::vram_tick` / `drive_vram_hold`, every tick, real clock only — inert in
  stepped mode).** `Engage` → `VramHold {mode, phase}` and the player is **paused** —
  `update_player_paused` composes `player.paused || vram hold` (the graph's `player.paused`, the
  user's, is never written: a user pause made meanwhile survives the release) — so R75/R88 apply
  unchanged: every source with audio ramps out on its `gain.pause` gate, time freezes, transitions
  freeze; `player.vram_low_active` (observed) true; `vram.low {mode, free_mib, total_mib, low_mib,
  resume_mib, resume_hold_ms}` (warn). **`stop`:** once no gate is still ramping and ≥ ANTICLICK +
  AUDIO_SETTLE_TAIL passed, `SourceHost::suspend_media(gfx)` drops **every video/image/scene
  source's decoder or worker** (the two-phase teardown, the reaper — never a blocking free): the
  node stays, a `SnapshotSource` still of its last frame is shown in its place
  (`SourceHost::texture` falls back to it), cores still being made are dropped, and **media nodes
  created meanwhile wait unopened** (`suspend_new`); `vram.stopped {sources, ms}` (warn),
  `source.suspended {id, source_kind, position}` each. `Release` → `vram.recovered {reason:
  free|no_sample|off, free_mib, total_mib, held_ms, mode}`; `stop`: `resume_media()` — each
  suspended source reopens on the next `sync` **at the position it had** (`resume_at`, applied
  when it really opens — an async open re-reads the node then), effectively paused (the hold still
  stands), its stand-in shown and the graph mirror + its `Ready` held back (it was ready: not news)
  until its first frame (`source.resumed {id}`); `vram.resuming {sources}`; once none is pending
  (or `VRAM_RESUME_WAIT` 5 s) the hold goes → `vram.resumed {sources, pending, resume_ms,
  held_ms}`, `vram_low_active` false, the pause lets go → the R88 resume (flow-gated ramp-in).
  `pause`: Release → the hold goes at once. Mode changes apply live: `off` while held releases;
  `pause` → `stop` frees now; `stop` → `pause` gives the sources back and stays paused.
  **Applies to every source kind** (colour/snapshot have no GPU memory worth freeing and are left
  alone); a scene's worker is a new process after a resume (a new pid; a resume is not a crash).
- **Probe `vram`** (`probe/vram.rs`): `{probe (nvml|drm|nvidia-smi|fake|none, null = not
  running), sample {total_mib, free_mib, used_mib, procs}, error, sampled_ms_ago, mode, rule
  {state normal|pending|low|recovering, reserve_mib, low_mib, resume_mib, enter_hold_ms,
  resume_hold_ms}, hold {mode, phase pausing|held|resuming, since_ms, suspended}, suspended (ids),
  resuming (count), scene_limit_mib, scenes [{id, pid, used_mib, over_ms, stopped}]}`. **`workers`**
  adds `fps_demand`, `gpu_ms_p50`, `gpu_ms_p95`, `throttle {cap, demand, since_ms}` (null =
  unthrottled), `vram_stopped {used_mib, limit_mib}`; `fps_target` is the effective rate.
  **`cpu {total_ms, threads {name: ms}}`** (F4, `sources::scene::proc_cpu`: the worker process's
  `utime + stime` from `/proc/<pid>/task/*/stat`, threads summed by name — cumulative, so two
  probes give a rate; `null` without a live worker). Measured (release, headless 1920×1080@144,
  `scene_fps` 30, private PipeWire at a 64-frame quantum): Kimi 2371103399 (sound) 6.0 % of a core —
  renderer `liascape-scene-` 3.5, PipeWire `data-loop.0` 2.2 (no_audio: 4.3 / 2.8 / 1.2 — the
  stream keeps its callbacks, gated); Bunk 2134765860 2.6 %; Emilia 1726902114 1.2 %. `perf` of
  Kimi (samples): the render thread 66 % (by library over the whole worker: NVIDIA's GL driver
  54 %, LWE 25 %, EGL 6 %), PipeWire's data loop 17 %, `lia-scene-audio` 5 %, the protocol thread
  4 %; LWE's mp3 decode (`mp_decode_layer3` …) ~5 %, PipeWire's plumbing ~3 %, ours
  (`Dsp::process`, `SegmentMeter::feed` — until the loudness cap —, `BlockMeter`, `fill`) ~3.5 %
  of the worker ≈ 0.2 % of a core. So a scene's worker CPU is
  LWE's per frame (≈ legacy LWE's, § phase2 report 1.3), linear in `scene_fps`: the plan's 5 %
  holds for light scenes at 30 fps, not for heavy ones at 144–240 (TODO F4: bound per class).
- **Tests.** `tests/scene.rs::scene_budget_throttles_live_and_recovers` (harness: the
  `report_gpu_ms` knob at 20 ms, 10 % misses fed through `observe_budget` with a virtual clock →
  cap ≈ 15, latched 15 ± 2/s, a calm 5 s step × 1.25, `auto` off back to 30 ± 2/s, same pid; a
  light worker's real GPU time > 0 and < 5 ms is never throttled; RED with the rate not applied:
  "ticks at the cap 30.0"). `tests/api.rs` (real clock): `per_output_scene_fps_gates_presents`
  (`--redraw-policy content`, VIRTUAL-1 scene_fps 60 / VIRTUAL-2 15, one scene on both → measured
  59.9 / 15.0 presents/s; RED with the gate bypassed: 59.4 / 59.4), `scene_fps_change_is_live_same_pid`
  (30/30 → 60/30 → 60/0(=refresh 60) → 15/15, measured exactly those, `fps_target` within 0.5 s,
  one `worker.spawned`, no restart), `scene_over_vram_limit_is_stopped_not_crashed` (fake probe:
  no limit by default at 5000 MiB; a spike shorter than the 1 s hold ignored; over it → stopped
  after 1.11 s with the UI text, no crash record/restart, the last frame captured),
  `low_vram_stop_frees_and_resumes_every_source` (a video + a scene: `vram.low` after the hold,
  both freed, the scene worker gone, stills on both outputs, time frozen, a video created
  meanwhile waits unopened; free again → both reopen at their positions, a new worker,
  `pending: 0`; RED before the resume-position fix: the video restarted at 0.07 s instead of
  0.83), `low_vram_pause_mode_pauses_without_freeing` (same worker throughout; a user pause made
  during the hold survives the release). Every test server runs `LIASCAPE_PLAYER_VRAM_PROBE=none` unless
  it sets a fake (`tests/api.rs::die_with_parent`, `tests/supervise.rs::guard`) — hermetic tests
  never see this machine's real VRAM.

**For Task 11 (the backend) — what to wire (names, units, defaults; all live, all `set` on the
`player` node unless noted):**

| setting (UI) | player-side | type / unit | default | notes |
|---|---|---|---|---|
| GPU budget: auto-throttle on/off | `player.scene_throttle` | bool | `true` | off = fixed fps; a cap in force lifts at once |
| per-monitor scene fps (`SceneMonitors[*].Fps`) | `out:<connector>.scene_fps` | f64 fps, 0–480, 0 = the output's refresh | `30` | per output, live (already Task 5); the backend's coalescible `scene_fps:<name>` |
| VRAM guard: toggle + limit | `player.scene_vram_limit_mib` | f64 MiB, 0–1048576, **0 = off** | `0` | toggle off → send 0; on → the limit (owner's suggestion 1536) |
| when the GPU's VRAM runs low | `player.vram_low_mode` | enum `stop` \| `pause` \| `off` | `stop` | thresholds fixed in the player (above) |

Events the backend should subscribe to: **`scene.vram_exceeded {id, path, pid, used_mib,
limit_mib}`** → treat the scene like broken for playback (advance a rotation / keep the preview)
but **do not** `MarkCrashed` — show "stopped: used X MiB > limit Y" (the same text arrives as the
`source.error` reason, which the backend sees for any failed source; distinguish by the
`vram_exceeded` event or the reason's `(vram_exceeded)` suffix); **`vram.low {mode, free_mib,
total_mib}`** / **`vram.resumed`** (optional: a UI status line "paused: VRAM low"); `scene.throttled
{id, fps_from, fps_to}` / `scene.unthrottled` (optional, diagnostics). Observed:
`player.vram_low_active` (bool). The backend must NOT treat the low-VRAM pause as a user pause
(`player.paused` stays false) and must not re-assert anything when it ends. Diagnose with `ctl
probe '{"name":"vram"}'` and `'{"name":"workers"}'`.

### Transitions with scenes (Task 9)

The recipe stays kind-agnostic: a scene B is held in `srcs:` by its transition (its worker spawns
at the first `sync` after `start` refreshed `srcs:` — in the harness one tick later than in the
runtime, whose `refresh_srcs` runs right after the request), opened paused it readies with its
first frame (one tick), its onset waits for the worker's `AudioFlowing` like a video's (none when
it has no sound); reveal/frozen hold a scene A by a `SnapshotSource` blit of its latched frame
and pause it at `t0 + 45 ms` (its worker gets no tick and latches nothing after that); a scene
is never a still (`is_still`) but **never ends** (`never_ends` = still | scene).
- **The one rule added (`recipes/transition.rs::never_ends`).** `align: end` on a lead A that
  never ends is `Now` at once (it waited out `ALIGN_SLACK` — 10 s — before: a scene has duration
  0 and never emits `Ended`, so the M2 fallback was the only way out, logging
  `transition.align_fallback`); End leaves such an A's (inert) `loop` alone; `follows_a_end`
  skips it. The same rule in the runtime's parked path (`transition_parked`: a parked scene A →
  handed off at once, § Runtime "No output left"). This is what the backend's restore-aligned switches
  send when the playing item is a scene (a scene never ends: its rotation moves it on itself).
- **Tests** (`tests/transition.rs`, harness, synthetic `frame_index` scenes, frame-index videos
  without audio so every B onset is immediate and every gain exact): `v_to_s_each_method`,
  `s_to_v_each_method`, `s_to_s_each_method` (`combo`: full-live — both sides keep producing
  frames, `gain.xfade` −3.0103 ± 0.05 dB each at the midpoint; reveal — fx `from` = a snapshot
  pixel-identical to A's frame at the copy, A paused ≥ t0 + 45 ms, a scene A sent no tick and
  latched nothing after it, B's xfade rising to −3.0103 at the midpoint; frozen — B on its first
  frame, paused and silent through the effect, at 0 dB 30 ms after the handoff, then playing;
  every method — progress forced to 0 / 1 composes exactly the plain sides (±1, the
  `effect_progress_endpoints_match_plain_source` property with live textures), done → B alone,
  a scene A's worker reaped), `align_end_video_a_to_scene_b` (full-live ends at A's end ±
  17 ms, measured +9.0; reveal/frozen start at its `Ended`, +0.0), `scene_a_align_end_starts_at_once`
  (S→V/S→S, every method + a cut: started ≤ 3 ticks after B's `Ready` — counted in ticks, not
  time; RED with the rule removed: never started in 8 s), `shared_scene_a_is_untouched` (A on
  VIRTUAL-2 too: never paused/ramped/loop-changed, kept rendering; snapshot constant on
  VIRTUAL-1), `scene_b_load_error_keeps_a` (missing folder via the real worker's folder check,
  synthetic `fail: load` / `fail: build`: `transition.failed` naming the folder, A untouched, no
  restart, no crash record), `scene_b_worker_crash_mid_effect_still_hands_off` (SIGKILL at
  progress 0.5, full-live and frozen: B's texture never None, no `transition.failed`, normal
  handoff, one restart, a new pid, no crash record, B's scene time continuous),
  `scene_b_broken_mid_effect_snaps_back` (every worker crashes 700 ms after its start → broken
  after 3 restarts mid-effect → `transition.failed` "…broken…", snap-back to A within 30 ms, A
  playing again, B destroyed, one crash record; S→S reveal and V→S full-live),
  `mixed_kind_interrupt_chain_every_tick` (invariant #6 per tick over 10 scene/video starts,
  gaps by condition: one tick / 100 ms / until Running). Unit
  `scene_lead_a_align_end_starts_now` (every method + a cut; RED: End turned the scene's loop off
  and nothing started). `tests/api.rs` (real clock): `scene_switch_storm_reaps_workers` (Review
  Focus #5: 10 S→S starts 100 ms apart, ≤ 2 unpaused at every poll; settled → within 1 s one
  worker, the 10th's, every earlier pid gone, `reaping` 0), `rapid_interrupt_chain_mixed_kinds`
  (V, S, V, S… through the runtime: `state` polled, paused ⊆ `transitions[].held`, commits and
  supersedes, the 10th alone, other workers reaped), `parked_scene_align_end_hands_off_at_once`.
- **Gotchas found writing them.** A paused **video** A still presents 2–3 queued frames
  (`time_pos` moves ~30 ms after the pause — why the snapshot exists); a paused **scene** A stops
  exactly (the latch gate). A scene worker's first frame takes > 100 ms (its EGL setup alone), so
  a chain of plain 100 ms gaps only ever supersedes — the chains choose their gaps by condition.
  A `Tick.t` is the compositor's clock, so a restarted worker's frames continue the scene time
  whatever its `Start.position` — Task 10 stops that clock at the held frame for the outage, so the
  restart resumes exactly there (`crash_holds_last_frame_and_resumes_at_position`).
- **For Task 10** (done — § "Crash policy (Task 10)" below). A crash mid-effect holds B's last
  frame and restarts it (budget 3 in 60 s); broken → `SourceEvent::Error` → the recipe's snap-back
  (pre-Running: abort); a B that crashes before its first frame waits for the restarted worker's
  (its `Ready` comes from it) — and shows its preview meanwhile if anything samples it.

### Crash policy (Task 10)

Spec §6.3 / the plan's Global Constraints, end to end: a worker crash or hang keeps the source's
last frame (or its preview if none arrived), restarts **up to 3 times within 60 s resuming at the
held position**, then the source is **broken** (event, persisted crash record, the backend's
skip/advance applies). Other outputs, videos and audio are never touched. Code:
`sources/scene.rs` (`hold_for_restart`, the preview, `ContextLost`), `worker/mod.rs`
(`kill_for_restart`), `snapshot.rs` (`broken`), the worker's `main.rs` (robust context,
`context_lost`), `gfx/egl.rs` (`OffscreenOpts::robust`).

- **Resume at the held frame (exactly).** A `Tick.t` is the compositor's scene clock, so before
  this the clock ran on through a restart (spawn + EGL + export + first frame ≈ 0.1–0.3 s) and the
  restarted worker's first frame jumped that far ahead of the frozen picture. Now
  `hold_for_restart` — on `Hung`, `Exited` and again at `Restarted` (after
  `Latch::forget_worker`, so a frame of the dead worker that latched between a hang and the reap
  is the final one) — **stops the clock at the held frame's `t`** (or at the clock after a
  `position` set the frame didn't show yet: `clock_jumped`) and sets `resuming = Some(held
  generation)`; `Start.position` carries it too (`set_resume_position`). While resuming,
  `tick()` sends exactly **one tick at that `t`** (after the new worker's `Ready`); the clock runs
  again when a frame of a **later generation** latched (`on_latched`): `scene.resuming {id, t,
  attempt}` / `scene.resumed {id, t, seq}` (info). `time_pos` is frozen through the outage (never
  a jump; it may step back ≤ one tick + latency to the held frame's `t` at the kill, or by the
  hang timeout after a hang — the picture froze there). Paused through the crash: no tick until
  the un-pause (the held frame is exact), then the resume tick; a `position` set while paused
  ticks at once (`exact_pending`) and that frame ends the resume. Stepped: untouched (the step
  re-sends its own tick). The GPU budget skips a resuming scene. Measured
  (`crash_holds_last_frame_and_resumes_at_position`, 30 fps): killed at `time_pos` 3.0054, held
  `t` 2.9710, first new frame `t` 2.9710 (RED before: 3.1482 — the outage).
- **The preview when nothing is on screen.** A worker that dies (`Exited`/`Hung`/`Restarted`/
  `Broken`) with no frame latched sets `preview_wanted`; the next `update` opens the `preview`
  prop (Source `preview`, `SceneOpts::preview`) as an internal **paused, silent image
  `MpvSource`** (`ao: null`, `no_audio`, `kind: image` — any format mpv reads: the backend sends
  `preview.jpg|png|gif|webp`), its wake fd in the source's epoll; `texture()` = the latched frame,
  else the preview's texture once it rendered (`preview_shown()`), else `None`. The first worker
  frame retires it (`MpvSource`'s two-phase teardown, `preview_dying`; `SceneSource::
  begin_teardown`/`teardown_ready` wait for it, R51). **Cost:** the open is synchronous on the loop
  (an mpv core + render context + its first render, ~10–30 ms) — only on these crash paths and a
  restored broken scene, never for a normal load. No preview set / a failed open or load →
  `scene.preview_failed {id, preview, reason}` (warn), never retried, nothing shown (as before).
  `scene.preview {id, preview, open_ms}` (info). A live `preview` change re-points a shown one.
  Stepped: a broken scene's `step_status` is `Pending("preview")` until its preview is on screen
  (a step's capture shows it), then `Broken`. Test `crash_before_first_frame_shows_preview`
  (every worker crashes at start: only the preview ever shows, before and after the break).
- **Broken** (budget spent, unchanged mechanics): `SourceEvent::Error` + ONE `source.broken {id,
  path, scene_id, reason, restarts, record, signal|code, total_restarts, uptime_ms, shows:
  last_frame|preview|nothing}` (the shape Task 11's backend reads; fields added only). The source
  then holds its last frame (or the preview), **silent** (no worker, no stream; `has_audio` reads
  `false` and `AudioFlowing` is immediate — nothing waits on a broken scene), its clock frozen.
  Source prop **`broken`** (Bool, **read-only**, observed — `SourceHost::MIRRORED`): `state` /
  `get <id>.broken`; `workers` probe `broken`, `state: broken`. A `path` change clears it (a new
  worker, a fresh budget). Tests `tests/api.rs::broken_after_three_restarts_in_60s` (the event,
  every crash-record field — `scene_id`, `id`, `path`, `reason` "… after 3 restarts within 60 s",
  `signal` 6, `restarts`/`total_restarts` 3, `uptime_ms`, `t_wall`, `log_tail` with the worker's
  `stub: crashing` and the `restart 3` marker —, `source.error`, `broken` observed, no 5th spawn,
  the last frame on the output), `source_broken_event_names_the_scene` (Task 11).
- **`ContextLost` = a crash restart.** The worker's context is created **robust**
  (`OffscreenOpts::robust`: robust access + `LOSE_CONTEXT_ON_RESET`, + `EGL_GENERATE_RESET_ON_
  VIDEO_MEMORY_PURGE_NV` where listed — NVIDIA purges VRAM on suspend/resume and VT switches;
  `gfx.context_robust {requested, granted, attribs, granted_attribs, path}`; the worker logs
  `gfx: robust context granted|not available`), and polls `Gfx::reset_status()`
  (`glGetGraphicsResetStatus`, no GPU sync) after every frame: non-zero → `ContextLost`, renders
  nothing more, fades its stream (≤ 200 ms) and waits to be killed (exits 4 itself after 5 s).
  The compositor: `scene.context_lost {id, path, pid}` (warn) + `WorkerHost::kill_for_restart("GL
  context lost")` — SIGKILL, `worker.killed {id, pid, why}`, then the ordinary path: the restart
  (its `why` / log-tail marker "GL context lost, killed by signal 9"), through the **same budget**
  (4 within 60 s = broken, the record's `reason` naming it). Judgement call: the protocol carries
  no reset kind, so an innocent reset counts like a guilty one — one suspend/resume is one
  restart, far inside the budget. Test `context_lost_is_a_restart` (synthetic
  `context_lost_after_ms: 600` — every worker reports it: frame held, restart 1 names it, broken
  after 3 with the record's reason). Real detection is on-machine only (a GPU reset can't be
  triggered hermetically); `workers` probe `context_losses`.
- **Hang timeout knob `LIASCAPE_SCENE_WORKER_HANG_MS`** (`sources::scene::HANG_ENV`, read at each
  scene's open in the compositor's environment; a positive whole number of ms, else
  `HANG_TIMEOUT` 2 s — unit `hang_timeout_knob`). Tests run 300. `tests/api.rs::
  hang_is_killed_and_restarted` (`hang_after_ms` 1500: `worker.hung` after 304 ms — RED: 2005 —,
  `worker.restart {why: "hung, killed by signal 9"}`, the hung pid gone, frames from the new
  worker past the held `t`; 303 ms after the 2026-10-29 heartbeat change — the same bound).
- **A suspend is not a hang (2026-10-29).** Both on-machine suspends killed a live worker as hung
  (`phase2.md` § 8): after the resume the compositor held every slot (latched + queued frames
  whose fences hadn't signalled while the GPU woke) and the worker sat idle waiting for a
  `Release` (incident 1, `waited_ms 2001`); and NVIDIA's kernel-notifier VRAM save blocked the
  compositor's own loop for ~6.4 s, whose first heartbeat after the thaw found a tick that old
  (incident 2, `waited_ms 6438`). The heartbeat now leaves out a **starved** worker's tick age
  (pinged instead, bounded at 5 × the timeout) and the time of a **host stall** — § "WorkerHost"
  → Heartbeat. A real hang keeps its bound (the api test above; `tests/worker.rs::
  starved_worker_that_hangs_is_still_killed`). The robust renderer also polls the reset status on
  every ping, so a purge it sees while starved is a `ContextLost` restart (on-machine only).
- **Snapshot: a broken scene restores as its preview.** `SourceSnap.broken` (saved only when true,
  `skip_serializing_if`), `create_props` seeds `broken: true` (read-only, seeded by `create` like
  `of`); `SceneSource::open` sees it → `restored_broken`, `broken` set, **no worker is ever
  spawned** (`set_demand` skips), the preview opened at once (`scene.restored_broken {id, path,
  preview}`, warn), no `Error`/`source.broken` again (the backend already marked the item), no
  restore fade (`!s.broken` in `restored_source`'s audible check). A source error marks the
  snapshot dirty (`update_sources`: a break is no graph change, and a scene that never readied
  isn't refreshed by the 2 s rule). Without this a player restart gave a crash-looping scene a
  fresh budget every time. Unit `broken_scene_is_saved_and_recreated_broken`; supervise
  `broken_scene_restores_as_preview` (saved `broken`, SIGSEGV → restored `broken`, its preview on
  the output, `workers` `state: broken` / `pid: null`, no `worker.spawned` for it).
- **Other outputs are never touched.** `tests/api.rs::crash_never_touches_other_outputs`
  (`--redraw-policy content`: VIRTUAL-1 a looping frame-index video, VIRTUAL-2 a scene killed 4
  times — 3 restarts, then broken —, 1.2 s apart): VIRTUAL-1's presents per window within ±2/s of
  its own baseline window and no frame held longer than the baseline's longest + one 60 Hz tick
  (measured 29.4–31.3 fps, max 35–38 ms vs baseline 30.0 / 36.9), its `time_pos` advancing at 1×,
  its gains/paused/loop/speed and `lay:VIRTUAL-1:main.content` unchanged, no event about it; loop
  `max_busy` ≤ 5 ms around it all (measured 2.4–3.8; render worker off: the video renders on
  the loop, 6–9 ms stretches without any kill, so the bound is that no-kill maximum + 5 ms —
  measured +2.2 at most, the restart handled in the same tick). This one was GREEN before Task 10 too — a
  guard: the isolation came from Tasks 3–5.
- **For the backend (Task 11's adapter — not changed here):** nothing it relies on changed shape
  (`source.broken` only gained fields). New facts it may use: `<src>.broken` (read-only, in
  `state`) and `source.broken.shows`; a player restart brings a broken scene back **broken** (its
  preview, no worker) — so after a restart `broken: true` on the shown scene is expected, and
  re-applying the same item needs a new source (a `transition`; a same-path `set` is a no-op), as
  whitelisting already does; a scene can also break from repeated GPU context losses (the record's
  `reason` starts "GL context lost") — it is marked crashed like any other break.
- **No core handler (Task 13).** The worker sets its own soft `RLIMIT_CORE` to 1 right after the
  PDEATHSIG check (`skip_core_handler`, never above the hard limit): the kernel then skips a piped
  `core_pattern`, so a scene that crashes LWE never reaches systemd-coredump or pops a desktop crash
  notification (the corpus' first run: 16 of them for its 4 broken scenes — 4 crashes each). The
  crash record + log tail are the diagnostics. `LIASCAPE_SCENE_WORKER_COREDUMP=1` (in the compositor's
  environment, inherited) keeps the inherited limit, for debugging LWE with a core. Test
  `tests/api.rs::scene_worker_crashes_skip_the_core_handler` (`/proc/<worker>/limits`: 1, and the
  inherited limit with the opt-out; RED before: unlimited, inherited from the test).

### Scene corpus (Task 13)

`src/player/tests/onmachine/scene_corpus.sh` (+ `scene_corpus_report.py`, hand-written diagnoses in
`scene_corpus_notes.json`) plays every `type: scene` item of a Workshop folder (default the 431960
library; **refuses `~/.cache/liascape/steamcmd_workshop`**, also after resolving each item's
symlinks) on a **private** `serve --no-supervise --headless --outputs 1920x1080@60 --clock real
--ao null` (own runtime/state/cache/config dirs + socket under the results dir, no Wayland/X,
PipeWire/Pulse/D-Bus pointed at nothing, `LIASCAPE_PLAYER_VRAM_PROBE=none`, `prlimit --core=1:1`), one
scene at a time: destroy the previous one and wait for its worker pid to go, `create {kind: scene,
path}` with **no preview** (a crash can't pass for a picture), `set lay:*:main.content` (a cut),
poll `probe workers` until `ready` / `broken` / `last_error` / 20 s, capture the source at Ready
+1 s, +2.3 s and +4 s (the off-grid middle one: ticks run on a 30 fps grid of scene time, so a loop
whose period divides 3 s — found: 3593587273 — repeats its +1 s frame at +4 s), read the rates
(`fps_actual`, `gpu_ms_p50`) **before** the +4 s capture (a `capture` encoded its PNG on the loop until 2026-10-28 — kept, harmless),
then `probe workers
{"log_tail": true}` + the worker's VmHWM + its `nvidia-smi` line. A background `ctl subscribe
source. worker. scene.` gives `ready_ms` = `worker.spawned` → `source.ready`. Classes (first match):
`load_failed` (fatal `load failed` / never opened), `renderer_failed`, `broken`, `timeout`, `crashed`
(Ready but restarted), `blank` (+4 s luma stddev < 2 or ≥ 99 % one colour), `static`,
`ok` (`static` = all three captures identical). Results (captures, records.jsonl, events.jsonl, serve.log) go to `/tmp/liascape-scene-corpus-<stamp>`
(never the repo — captures aren't committed); the report to `docs/player/reports/scene-corpus.{md,json}`
(items by Workshop id only). `--only`, `--limit`, `--reuse <results>` (re-report / legacy only),
`--no-build`, `--bin`, `--assets`. **`--ab-legacy --legacy-output <out>`** runs the installed
`linux-wallpaperengine --screen-root <out> --screenshot …` per scene — it draws on the real output,
so it is **owner-run only**; the report then lists scenes that start there but not here.
**The report's run (2026-10-28, LWE `40eacc9`, 96 scenes, 506 s):** 92 ok, 1 static (a still image + a sound
— by design), 3 load_failed (3D/perspective scenes next-v2 can't parse), 0 blank/broken/crashed/timeout. The
first run (LWE `c5c2cad`: 86 ok, 1 blank, 4 load_failed, 4 broken) found five LWE causes, every one reproducing
with `--lwe-smoke` (LWE's core alone); four are fixed by fork patches 0012/0014–0017 (§ "LWE core"), the 3D
one is a Phase 6 item in `docs/TODO.md`. The runs also found three
player fixes: the stopped worker's last stderr line (§ `WorkerHost` "Log tail"), the core handler
(above) and `capture`'s PNG compression (§ GFX / EGL `write_png`) — the 0.85 s capture stall had
even made the GPU budget throttle two heavy 4K scenes (15–17 ms/frame) in an earlier run: the loop's
stall read as missed frames; with `Fast` none is throttled. Diagnosing a
scene LWE kills: `nix shell nixpkgs#gdb` + `liascape-scene-worker --lwe-smoke <dir> --assets <dir> --out
<dir>` under gdb (`catch throw` shows LWE's caught load failures; ignore the throws under
`Configuration::detectSteamDir`, LWE's Steam-dir probe, which also prints the harmless `Cannot find
appmanifest_431960.acf …` lines in every tail).
