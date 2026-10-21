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

- `src/main.rs` — CLI entry point. Only `--version` is real (prints `lp-player <version>`
  from `CARGO_PKG_VERSION`); every other invocation, including no args, is a stub that
  prints `"not implemented yet"` to stderr and exits 2. Later tasks replace the stub
  branch with `serve`/`ctl`.
- `src/lib.rs` — module wiring only (`pub mod …;` lines). Add new
  `pub mod` lines here as later tasks add files; don't put logic in this file.
- `src/log.rs` — the event log (below).
- `src/units.rs` — audio units (below).
- `src/mpv/` — libmpv FFI (`ffi.rs`, bindgen output) + safe wrapper (`mod.rs`). § Sources.
- `src/sources/` — the `Source` trait, `MpvSource` (video/image), `ColorSource`. § Sources.

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

- `t_mono_ms` — `f64` milliseconds since process start, from `Instant` (a true monotonic
  clock, never wall time) — monotonic across every event in a process, even across
  rotation.
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

**Gotcha:** `init`/`event`/`recent`/`new_corr`/`write_failures` are the only public API — `Logger` and
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
`automute`/`xfade`/`anticlick`, lowercase in `gain.<slot>` paths and JSON) in dB.
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

**`drain_changes()`** returns every `(PropPath, PropValue)` applied by `set` since the last
call, in call order (one entry per resolved node for a multi-resolution `set`). Node
creation is **never** a change — there's no live source yet for a runtime hook to forward
it to. The runtime (a later task) drains this every tick and forwards each entry to
whatever `PropHook` the target source has registered; nothing in `graph/` talks to a live
source directly.

**Snapshot shape.** `Graph::snapshot()` is one JSON object keyed by node id; each node's
object has `kind` plus **every** schema property (defaults included — a property is never
omitted for being unset, so "every node with every property" holds without special-casing).
`Source` nodes additionally get `gain` (an object of only the gain slots that have been
set, in dB — unset slots don't appear) and `gain_effective_db` (their dB sum via
`units::Gains::effective_db`, clamped to `[-96, 12]`).

## GFX / EGL

`src/gfx/egl.rs` + `src/gfx/gl.rs` (spec §5.1 "Graphics"): desktop OpenGL (core profile)
via EGL — chosen so the compositor can host LWE core if ever needed, since LWE core
renders with desktop GL loaded through glad (`docs/player/spikes/lwe-core.md` §2). `Gfx`
owns the EGL display + context and the `glow::Context` loaded through it; `Gfx::new_offscreen`
builds a surfaceless one (used by every GPU test today), `Gfx::new_wayland` +
`Gfx::window_target` build a real one on a `wl_surface` (implemented to compile against a
stable API now, first exercised by Task 13 — R16).

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
read, poll_events }`; `SourceEvent::{Ready, Ended, Position(f64), Error{reason}}`.

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

**`MpvSource::open(gfx, path, opts)`** — one mpv core + one render context per source.
Fixed options: `vo=libmpv`, `config=no`, `terminal=no`, `keep-open=yes` (an ended video
holds its last frame) **with `keep-open-pause=no`** (keep-open's default also flips
`pause` at EOF — `read("paused")` would then disagree with the graph and a seek back
after the end would stay frozen), `idle=yes` (the core survives a load error / waits for
a `path` change), `volume=100`, `volume-gain-min=-96`, `image-display-duration=inf` (set
always — it only affects single-frame images), `keepaspect=no` (the texture *is* the
frame; fit is the compositor's), `opengl-pbo=no` (required by the fence stub, below),
`osd-level=0`, `ytdl=no`, `input-default-bindings=no`, `audio-client-name=lp-player`.
`opts` = any writable `Source` property (`position` → mpv `start`), plus `ao` (default
`pipewire`), `audio_device` (the bus, Task 14), `kind` (`video`|`image`, default from the
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
A reply with an error becomes `SourceEvent::Error{reason}` naming the mpv property/
command, the value and the graph property (`af=no_such_filter_lp (af): …`), and
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
`start` to `none`); `hwdec` (`""` → `no`); `fps_cap` → `vf` `fps=<n>` / `""`; `cache` →
**`auto`** for `true` (mpv's normal policy — what the legacy engine runs with
DisableCache=false; `yes` would RAM-cache every local wallpaper) and `no` for `false`;
`demuxer_max_mib`/`demuxer_back_mib` → `demuxer-max-bytes`/`demuxer-max-back-bytes`
`<n>MiB` (a fractional MiB goes as exact bytes — mpv rejects `1.5MiB`; `0` = unset →
mpv's default 150/50 MiB, the legacy engine's convention); `af`; `no_audio` → `aid`
`no`/`auto` (`auto` re-inits the AO even after a no-audio start — `current-ao` and
`audio-out-params` come up, `start_muted_then_unmute_live`; the `aid` *property* then
reads the picked track id, e.g. `"1"` — `options/aid` reads `"auto"`); `audio_delay` →
`audio-delay`.

**Gains → `volume-gain`, `volume` stays 100.** Every `gain.<slot>` apply recomputes
`units::Gains::effective_db()` and sets mpv `volume-gain` = `units::mpv_volume_gain(db)`
(exact dB; `volume` is cubic — § Units; mpv stores it single-precision, so it reads back
within ~1e-6 dB). `volume-gain-min=-96` is what lets mpv accept the −96 dB floor. `open`
pushes the initial sum too, so mpv never runs at its own default.

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
failed async request, a foreign-context `update`, or a core shutdown.

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
wakeup cb → destroy core → close eventfd (in `open`, the eventfd is created before the
core so error-path locals drop in the same order). Drop order vs the `Gfx` is irrelevant —
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

**`ColorSource::new([r,g,b])`** (0–255, the graph's `color`): a 1×1 `RGBA8` texture
(LINEAR + CLAMP_TO_EDGE → the colour everywhere), created lazily on the first `update`
(construction has no `Gfx`) and repainted only when `color` changes (never through a
foreign context). `Ready` is queued at construction (first `poll_events`). Every other
writable property is accepted and stored (so an alias/global `set` never fails on a
colour layer) and does nothing.

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
