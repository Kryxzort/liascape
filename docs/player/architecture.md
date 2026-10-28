# liascape-player architecture

`liascape-player` is the Rust compositor that is replacing mpvpaper + `liascape-transition` + per-monitor
`linux-wallpaperengine` (LWE) + `liascape-audio` with one process that owns every wallpaper type, on
every monitor, with every transition. Design authority:
`docs/superpowers/specs/2026-10-20-utopia-player-design.md` (read for *why*; this doc is the map
for *where* and *how to debug*). Status: **Phase 1 core implemented** (compositor, video/image/
colour sources, all three transition methods, Wayland outputs, audio bus, supervisor + snapshot,
the C# backend adapter) and **Phase 2 implemented** (WE scenes in `liascape-scene-worker` processes; only
its on-machine battery, plan Task 14, is still to run) — see `docs/TODO.md` → "liascape-player" for
exactly what's done vs pending.
The backend's `AppSettings.PlayerEngine` defaults to `legacy`; `liascape-player` is opt-in and
experimental until the switch-over bar (§6 below) is met.

This file links to the per-module detail instead of duplicating it:
`.claude/rules/player-core.md` (the Rust crate, one `##` section per module) and
`.claude/rules/player-adapter.md` (the C# adapter, `src/backend/Player/`) are the sources of
truth for mechanism; `docs/player/invariants.md` is the sources of truth for *why* a rule can't be
broken. If this doc and either of those disagree, the rules file is right — fix this one.

---

## 1. The invariant everything else follows from

> **Never hand an audible or visible stream from one owner to another. Only ramp gains and
> opacities on streams that keep running.**

A stream that will be heard starts silent (−96 dB) and ramps up; a stream is only destroyed after
it has been ramped to silence (or was already paused/silent). Transitions blend *textures* inside
one process, on one clock — never hand off a decoder, a window, or an audio stream between two
programs. If this holds, dropouts and visual seams can't happen regardless of timing, because
there is never a moment where "nothing is playing yet" or "the old thing already stopped" needs
to be hidden by a race against wall-clock timing. This is what replaces the legacy engine's whole
failure class (cubic volume sag, speed-tracked second copies, ready-file timeouts, a killed
overlay leaving mpvpaper parked — see the design spec §1 for the measured incidents).

**The other invariants** (`docs/player/invariants.md`, each with its own *why* + *enforced by*):

1. Never hand off an audible/visible stream between owners (above).
2. Gains are dB everywhere inside the player; never ramp a percent (`src/player/src/units.rs`).
3. Silent = −96 dB, the one floor everything clamps to (`units::SILENT_DB`).
4. A hold boundary (pause/resume at a transition handoff) uses a ≤ 30 ms anti-click gain ramp.
5. Audio follows the picture: a held frame is silent, a live frame is heard.
6. A new transition on an output commits or supersedes whatever is already in flight there —
   never parked, never stacked.
7. Player-level pause freezes picture, audio *and* time together, and resumes exactly where it
   left off (its own anti-click gate on a dedicated `gain.pause` slot; teardown still completes
   while paused; `stop` ends the pause with the session).
8. No audio onset or offset without a ramp the listener can hear — every ramp-in waits for the
   source's audio to really flow (`src/player/src/onset.rs`, the one helper every un-pause path
   uses), every ramp-out settles before the pause/destroy lands.
9. A crashed scene keeps its picture, resumes where it froze, and touches nothing else (a
   scene that keeps crashing is broken, silent, held — and stays broken across a player restart).
10. A worker frame never blocks the compositor: it latches only a frame whose acquire fence has
    already signalled, never `eglWaitSync`s on a worker fence, and reuses the previous frame
    (never black, never a wait) when none is ready.
11. A worker's audio is a gain on a stream that keeps running: the scene's sound is one
    PipeWire stream per worker, opened silent, driven only by dB `Gain` pushes, closed only after
    it was ramped to silence — the compositor never hands scene audio between owners.

---

## 2. One-screen map

### Process model

```
┌──────────────────────── liascape-player (one process tree, supervised) ────────────────────────┐
│ supervisor (src/supervise.rs) — fork+execs before any thread/EGL/PipeWire exists; never    │
│   binds the socket, never touches EGL/audio; waits, forwards signals, restarts on a crash  │
│   with --restore (budget: 5 restarts / 60 s, then gives up)                                │
│   │                                                                                         │
│   └─ compositor child — the one calloop event loop (src/runtime.rs):                       │
│        Graph (src/graph/) · Animator + Clocks (src/anim.rs, src/clock.rs) ·                │
│        gl-transitions Effects (src/gfx/effects.rs) · Composer (src/gfx/compose.rs) ·        │
│        Transition recipe (src/recipes/transition.rs) · Command API (src/api/) · Probes      │
│        (src/probe/, incl. the dropout detector probe/dropout.rs) · Audio bus (src/audio/,  │
│        re-created after a PipeWire restart) · Snapshot writer (src/snapshot.rs)             │
│        in-process sources: video/image via libmpv (src/sources/mpv.rs, src/mpv/; the core  │
│          is created on an `lia-open` worker thread, the GL half on the loop),                │
│        colour (src/sources/color.rs), still-frame copies (src/sources/snapshot.rs),        │
│        scenes (src/sources/scene.rs — the compositor half of a scene worker, below)        │
│      + threads: `lia-render` (mpv render contexts), `lia-vram` (VRAM sampling, src/vram.rs), │
│        `lia-sysmon` (system-audio tap for scene visualisers, src/audio/sysmon.rs)           │
└────▲─────────────▲──────────────────────────────────────────────▲─────────────────────────┘
     │             │ JSON Lines, one unix socket                   │ EGL + Wayland (src/wl.rs),
     │             │ $XDG_RUNTIME_DIR/livepaper/liascape-player.sock      │ or --headless virtual
     │             │                                               │ outputs (src/headless.rs)
     │  livepaper backend (C#, src/backend/Player/) ─────────▶  wlr-layer-shell outputs
     │  AppSettings.PlayerEngine = legacy | liascape-player             (one surface per wl_output)
     │
     │ SOCK_SEQPACKET (JSON datagrams + fds) · dmabuf frames + sync_file fences
┌────┴───────────────────────────────────────────────────────────────────────────────────────┐
│ liascape-scene-worker — one process PER SCENE SOURCE (shared by every output showing it), spawned │
│   by the compositor (posix_spawn, PDEATHSIG-tied to it), watched by a heartbeat:            │
│   LWE `next-v2` core (src/bin/liascape-scene-worker/) renders into a 3-slot exported dmabuf ring │
│   on its own low-priority GL context; its sound is a stream of its own on the player bus.   │
│   A crash/hang/GL-context loss costs only that scene: last frame held, restart ≤ 3× / 60 s, │
│   then broken. Crash records: <state>/crashes/*.json.                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

A scene (Phase 2) runs in its own `liascape-scene-worker` **process per scene source** — not per output:
the same scene on two monitors is one worker, one ring, one set of ticks (owner decision D1; the
per-output fps is a present gate in the compositor, `out:<c>.scene_fps`). The compositor drives it
with `Tick {t}` requests on **its own scene clock** (so pause, speed and stepped mode are exact),
the worker answers `Frame {slot}` + an acquire fence, and the compositor latches only frames whose
fence already signalled (invariant #10), samples the imported texture like any other source's, and
returns a release fence. Frame transport, the crash policy, audio, the GPU budget and the VRAM rules
are in `.claude/rules/player-core.md` § Scene worker. Video, image and colour sources still live
in-process; web wallpapers (Phase 4) will use the same worker pattern. A scene needs the worker
binary **and** Wallpaper Engine's `assets/` directory (resolved from the Steam libraries or
`LIASCAPE_WE_ASSETS_DIR` / `player.scene_assets`) — without them `hello.capabilities` lacks `scene` and
the backend skips scene items exactly like `AllowScenes=false` (`PlayerEngine.ScenesPlayable`).

### Block model

Every feature is only ever a combination of these blocks (spec §4.2) — there is no
feature-specific plumbing anywhere else in the crate:

| Block | One job | File |
|---|---|---|
| **Source** | produce frames (+ optional audio); uniform play/pause/seek/speed/loop controls, `gain.<slot>` | `src/player/src/sources/{mpv,color,snapshot,scene,host}.rs`, `src/player/src/mpv/`, `src/player/src/worker/` |
| **Output** | one monitor (`out:<connector>`); size/refresh/layer; appears/disappears with hotplug | `src/player/src/graph/{mod,props}.rs`, `src/player/src/wl.rs` / `src/player/src/headless.rs` |
| **Layer** | what an output shows: fit/viewport/opacity over a `Source` or an `Effect` | `src/player/src/graph/props.rs`, `src/player/src/gfx/compose.rs` |
| **Effect** | a gl-transitions shader over two textures + parameters | `src/player/src/gfx/effects.rs` (compiles `transitions/`, never edits it) |
| **Gain** | a source's audio level in dB; slots (`user`/`override`/`normalize`/`mute`/`automute`/`xfade`/`anticlick`) sum in dB | `src/player/src/units.rs` (`Gains`), `src/player/src/graph/props.rs` |
| **Animator** | move any property over time along a curve (linear/smoothstep/equal-power/step) | `src/player/src/anim.rs` |
| **Clock** | a time base; pausable per-output or globally | `src/player/src/clock.rs`, `Runtime`'s player-pause fields |
| **Program / Recipe** | the only place policy lives, built only from the blocks above; today: the transition A→B recipe | `src/player/src/recipes/transition.rs` |
| **Command API** | create/destroy/set/get/animate/subscribe/probe/capture | `src/player/src/api/{proto,server,handlers}.rs`, `src/player/src/ctl.rs` |
| **Probe** | measure: live sources, loop health, frame pacing, the audio bus/meter, the snapshot writer, scene workers, VRAM | `src/player/src/probe/{mod,frames,audio,snapshot,memory,workers,vram}.rs` |

### Memory

Every switch creates one mpv core (decoder/demux/audio threads, 1080p frame pools) and
destroys another, so the process's allocator sees a constant churn of multi-MiB buffers.
glibc's defaults keep that memory: its dynamic mmap threshold rises past a frame buffer
after the first core is freed, and the per-thread arenas then retain each peak (Task 20's
soak: +6.4 MiB/min; 200 hermetic switches: RSS 159 → 922 MiB with live memory flat).
`serve` therefore fixes the threshold at 128 KiB before any mpv core exists, and the mpv
reaper `malloc_trim(0)`s after each batch of destroyed cores (off the loop) — 364 → 380 MiB
over 300 switches (`src/player/src/mem.rs`, `.claude/rules/player-core.md` § Memory). The
`memory` probe splits RSS into live vs retained; `LIASCAPE_PLAYER_MALLOC=glibc` turns the policy
off for an A/B. On Wayland a second, per-*present* leak sat underneath (Task 20e: live
in-use +2 MiB/min). NVIDIA egl-wayland2 ≤ 1.0.2 with explicit sync leaves one
`wl_buffer.release` (~224 B) queued per present on a queue nobody dispatches. `serve` sets
`__NV_DISABLE_EXPLICIT_SYNC=1` unless the caller chose a value, and the Wayland backend
dispatches libwayland's default queue every iteration, because upstream's driver fix moves
the buffers there (`src/player/src/wl.rs`, `.claude/rules/player-core.md` § Wayland → NVIDIA
notes).

**Signal** (spec §4.2: "other audio playing" → auto-mute, "window fullscreen" → auto-pause) is
specified but **not implemented yet** — it is Phase 3 (§6), and its auto-mute half is **PARKED**
(owner, 2026-10-28). Today the equivalent decisions (auto-mute) are made by the C# `AudioMonitor`,
outside the player, for both engines.

---

## 3. One wallpaper switch, end to end

Every switch — a manual next/prev, a timed tick, a video-end advance, `--restore` — goes through
the exact same path: the backend never talks to a source directly, only to the recipe via the
Command API.

```
C# backend (PlayerHelper → LiascapePlayerMedia.Switch, player-adapter.md § Dispatch points)
  │ "transition" request, JSON Lines over $XDG_RUNTIME_DIR/livepaper/liascape-player.sock
  ▼
src/api/handlers.rs — validates into a TransitionReq, calls
recipes::transition::Transitions::start(req, graph, anim, now)
  │ creates B now (graph `create`: paused, gain.xfade at −96 dB) — a bad request changes nothing
  │ resolves any transition already in flight on an overlapping output first (supersede/commit)
  ▼
transition.scheduled {outputs, to, path, method, align, effect_id, duration_ms}   ◀── emitted here
  ▼
state machine (src/recipes/transition.rs, driven by Transitions::tick each loop iteration):
  Scheduled → WaitingReady (B's Source::Ready) → WaitingStart (align:now fires at once;
              align:end waits for A's own Ended/position-based end estimate)
  ▼
transition.started {method, effect_id, start_ms}                                  ◀── emitted here
  ▼
  Running — Animator ramps fx.progress 0→1 and the method's own gain pair (full-live: equal-power
            crossfade both playing; reveal: A ramped silent then held, B's gain rises with the
            reveal; frozen: both held, B silent until it starts at the end) — § Transition recipe
            "Per method" table has the exact ramps
  ▼
  Handoff — layers now point at B; A is released (restored if another layer still shows it, else
            ramped to −96 dB and buried in the graveyard one tick after its gain actually reaches
            mpv — never torn down early)
  ▼
transition.handoff {to, from, committed}                                          ◀── emitted here
  ▼
  Done — once every grave from this transition is buried
  ▼
transition.done {to}                                                              ◀── emitted here
  (at any point instead: transition.cancelled {reason} | transition.failed {path, reason} —
   a bad/erroring B before handoff always snaps back to A, never a black/silent screen)
```

**Every tick** (the one calloop loop, `src/player/src/runtime.rs`, "Who runs what"): bus route
check (re-route sources after a PipeWire restart) → `Animator::tick` (+ the teardown ramps on the
unpaused clock) → `Graph::set` → due destroys → `sync_sources` (the R88 player-pause gate's state
machine, then `SourceHost::sync`: forwards drained graph changes to the live mpv/colour sources,
finishes async opens) → `update_sources` (`SourceHost::update`, pulls back `Ready`/`Ended`/
`Position`/`Error`/`AudioFlowing` events, mirrors observed values) → held onsets resolved
(`crate::onset`) → `Transitions::tick(those events)` (advances the state machine, drains its own
events) → `refresh_srcs` → `Composer::compose_output` per output → present
(`src/player/src/wl.rs` frame callback, or the headless backend's no-op). Gain ramps also run on
a second, 1 kHz timer (R90 — armed only while a gain ramp is actually moving) so a 30 ms ramp is
~30 pushes, not one per output refresh.

**Every event**, the moment it's produced, goes through `log::event` (→ `events.jsonl` +
the in-memory `recent()` ring, `src/player/src/log.rs`) and the Command API's tap (`src/player/src/api/server.rs`),
which flushes it to every subscribed `ctl subscribe`/socket client **before** that command's own
reply is sent. The backend's `LiascapePlayerClient` background event connection
(`.claude/rules/player-adapter.md` § Event flow) records each `corr`'s terminal outcome — `"handoff"` |
`"cancelled:<reason>"` | `"failed:<reason>"` — so `SwitchAndWait`/`WaitCorr` can complete and
`PlayerHelper.PostSwitch` can run.

---

## 4. Where to change what

| Feature area | File(s) | Rules section | Tests |
|---|---|---|---|
| dB math, gain slots, mpv/Pulse edge curves | `src/player/src/units.rs` | `.claude/rules/player-core.md` § Units | its own unit tests (`gains_sum`, `mpv_clamp`, `pulse_cubic`) |
| Animation curves, per-property ramps | `src/player/src/anim.rs` | § Clocks and Animation | its own unit tests |
| Graph nodes/properties/aliases, `state`/`get`/`set` semantics | `src/player/src/graph/{mod,props}.rs` | § Graph & properties | its own unit tests |
| EGL/GL context lifetime, offscreen targets | `src/player/src/gfx/{egl,gl}.rs` | § GFX / EGL | `src/player/tests/gfx_basic.rs` |
| A gl-transitions effect fails to compile / needs a new uniform type | `src/player/src/gfx/effects.rs` (never `transitions/` itself — shared with the UI) | § Effects | `src/player/tests/effects_all.rs` |
| Layer fit/viewport/opacity, effect blending, Y-flip | `src/player/src/gfx/compose.rs` | § Composition | `src/player/tests/compose.rs` |
| Video/image playback, mpv property map, async calls | `src/player/src/sources/mpv.rs`, `src/player/src/mpv/` | § Sources | `src/player/tests/sources.rs` |
| Colour / still-frame (snapshot) sources | `src/player/src/sources/{color,snapshot}.rs` | § Sources | `src/player/tests/sources.rs` |
| Graph node ↔ live source wiring | `src/player/src/sources/host.rs` | § Sources ("`SourceHost`") | `src/player/tests/sources.rs`, `src/player/tests/api.rs` |
| Scene worker lifecycle: spawn, heartbeat/hang, restart budget, crash records, the wire protocol | `src/player/src/worker/{mod,proto}.rs`, `src/player/src/bin/liascape-scene-worker/main.rs` | § Scene worker | `src/player/tests/worker.rs` (stub worker, no GPU) |
| Scene frame transport: dmabuf export/import, fences, the latch, cover size | `src/player/src/worker/dmabuf.rs`, `src/player/src/gfx/dmabuf.rs`, `src/player/src/bin/liascape-scene-worker/{ring,synthetic}.rs`, `src/player/src/scene/mod.rs` | § Scene worker → "Frame transport" | `src/player/tests/scene.rs` (`latch_never_waits_on_an_unsignalled_fence`, `transport_never_shows_stale_torn_or_out_of_order`) |
| A scene as a graph source: clock, pause, Ready, demand, errors, snapshot | `src/player/src/sources/scene.rs`, `src/player/src/sources/host.rs` | § Scene worker → "The `scene` Source kind" | `src/player/tests/scene.rs`, `src/player/tests/api.rs::scene_*` |
| Real scenes: LWE in the worker, WE's assets dir, pointer, visualiser input, scene properties | `src/player/src/bin/liascape-scene-worker/{lwe,render}.rs`, `src/player/src/scene/{assets,pointer}.rs`, `src/player/src/audio/sysmon.rs` | § Scene worker → "LWE core", "Real scenes" | `src/player/tests/scene.rs`, `src/player/tests/lwe_build.rs`, `patches/lwe/tests/host_api_test.cpp` (`scripts/lwe.sh test`) |
| Scene audio: the worker's bus stream, dB gain, gate, pitch-kept time stretch | `src/player/src/bin/liascape-scene-worker/{audio,stretch}.rs`, `src/player/src/probe/dropout.rs` (`SceneEnvelopes`) | § Scene worker → "Scene audio" | worker units, `src/player/tests/api.rs::scene_*_on_the_bus` (private PipeWire) |
| Scene loudness learned on first play | `src/player/src/audio/loudness.rs` (`Learner`), `src/player/src/sources/scene.rs`, the worker's `audio.rs` (`SegmentMeter`) | § Scene worker → "Scene loudness" | `src/player/tests/api.rs::scene_loudness_*` |
| Scene fps, the GPU budget (auto-throttle), the per-scene VRAM limit, the low-VRAM pause/stop | `src/player/src/scene/budget.rs`, `src/player/src/vram.rs`, `src/player/src/redraw.rs`, `src/player/src/runtime.rs` (`feed_scene_budgets`, `vram_tick`) | § Scene worker → "GPU budget and VRAM" | `src/player/tests/scene.rs::scene_budget_throttles_live_and_recovers`, `src/player/tests/api.rs::low_vram_*`, `scene_over_vram_limit_is_stopped_not_crashed` |
| Transitions to/from scenes (all four V/S combos), `never_ends` | `src/player/src/recipes/transition.rs` | § Scene worker → "Transitions with scenes" | `src/player/tests/transition.rs` (`v_to_s_each_method`, `s_to_v_each_method`, `s_to_s_each_method`) |
| Scene crash policy: hold + resume at the held frame, preview, broken, GL context loss | `src/player/src/sources/scene.rs`, `src/player/src/worker/mod.rs`, `src/player/src/snapshot.rs` | § Scene worker → "Crash policy"; `docs/player/invariants.md` #9 | `src/player/tests/scene.rs::crash_holds_last_frame_and_resumes_at_position`, `src/player/tests/api.rs::broken_after_three_restarts_in_60s` |
| Scene corpus (every installed Workshop scene) | `src/player/tests/onmachine/scene_corpus.sh` | § Scene worker → "Scene corpus"; `docs/player/reports/scene-corpus.md` | itself (owner/on-machine) |
| Vendored LWE core, its patch series, the pin | `third_party/lwe/PIN`, `patches/lwe/`, `scripts/lwe.sh`, `UPSTREAM.md` | § Scene worker → "LWE core" | `src/player/tests/lwe_build.rs`, `src/player/tests/credits.rs` |
| Transition methods, align, interrupt/cancel, sharing, hotplug adoption | `src/player/src/recipes/transition.rs` | § Transition recipe | `src/player/tests/transition.rs` |
| The event loop, hotplug, stepped clock, retire/park | `src/player/src/runtime.rs`, `src/player/src/headless.rs` | § Runtime | `src/player/tests/api.rs` |
| Command API verbs, error codes, `ctl` | `src/player/src/api/{proto,server,handlers}.rs`, `src/player/src/ctl.rs` | § Command API | `src/player/tests/api.rs` |
| Wayland surfaces, layer-shell layer, pointer, frame pacing | `src/player/src/wl.rs`, `src/player/src/redraw.rs` | § Wayland | `src/player/tests/onmachine/outputs.sh` |
| The audio bus, re-targeting, the meter | `src/player/src/audio/{bus,meter}.rs` | § Audio bus | `src/player/tests/onmachine/bus.sh`, `src/player/tests/api.rs::bus_*` |
| Crash restart, startup-failure classification | `src/player/src/supervise.rs` | § Supervisor | `src/player/tests/supervise.rs` |
| State persistence / `--restore` | `src/player/src/snapshot.rs` | § Snapshot | `src/player/tests/supervise.rs` (restore cases) |
| The C# side of a setting / dispatch point | `src/backend/Player/*.cs` | `.claude/rules/player-adapter.md` | `scripts/test-liascape-player-adapter.sh`, `--liascape-player-selftest` |
| Reference-based dropout detection | `src/player/src/probe/dropout.rs`, `scripts/liascape_audiowatch.py` | `docs/player/debugging.md` | `src/player/tests/dropout.rs`, `src/player/tests/onmachine/dropout.sh` |
| Process memory, the glibc allocator policy, the `memory` probe | `src/player/src/mem.rs`, `src/player/src/probe/memory.rs`, `src/player/src/sources/reaper.rs` | `.claude/rules/player-core.md` § Memory | `src/player/tests/api.rs::t20b_switch_loop_rss_stays_flat`, `battery.sh soak --hermetic` |
| Wayland EGL driver environment (NVIDIA explicit sync), libwayland default-queue drain | `src/player/src/wl.rs` (`apply_driver_env`, `Wayland::dispatch_default_queue`) | `.claude/rules/player-core.md` § Wayland → NVIDIA notes | `src/player/tests/api.rs::t20e_wayland_present_heap_stays_flat` (opt-in `LIASCAPE_PLAYER_TEST_WAYLAND`) |
| Onset waits (ramp-ins on flowing audio), the "can it be heard" predicate | `src/player/src/onset.rs` | `docs/player/invariants.md` #8 | its own unit tests, `src/player/tests/api.rs::i6_*` |

A change to a **setting** always needs two ends: the graph property (above) *and* the adapter
dispatch point that targets it (`.claude/rules/player-adapter.md` § Targeting, § Dispatch points) — "settings
apply live" (project rule) means every writable property is live by construction on the player
side, but the backend still has to send the `set` to the right alias (`srcs:*`, a per-item source
id, or `lay:*:main`) when the setting changes.

---

## 5. Debug mode quickstart

An AI agent (or a human) can find out *what happened and why* from text alone, without watching
the screen:

1. **Reproduce deterministically**, or attach to the real session:
   ```
   liascape-player serve --headless --outputs 1920x1080@60 --clock stepped --ao null   # deterministic
   liascape-player serve                                                                # real Wayland + audio
   ```
2. **`liascape-player ctl state`** — the whole live graph: what each output shows
   (`lay:<connector>:main.content`, the `cur:` alias), every source's
   `ready`/`paused`/`time_pos`/`gain_effective_db`, and every live transition's phase + held
   sources.
3. **`liascape-player ctl logs '{"corr":"tr-12"}'`** — one switch's whole story in order:
   `scheduled` → `started` → `handoff` → `done`, or exactly where it stopped
   (`cancelled {reason}` / `failed {path,reason}`). The adapter log and `LiascapePlayerMedia.LastCorr`
   (`.claude/rules/player-adapter.md` § Debugging) name the corr id for "the switch that just happened."
   `ctl logs '{"min_level":"warn"}'` lists everything that went wrong, process-wide.
4. **Probes** (`ctl probe '{"name":"<name>"}'`):
   - `sources` — what each source actually runs (mpv's real `volume-gain`, `pause`, unanswered
     async requests, stepped status) vs what the graph says it should.
   - `frames` — present-interval pacing per output (mean/p95/missed), whether an output is idle.
   - `bus` / `meter.window {"last_ms":1000}` — the audio bus's health and a window of its real
     dBFS (what the wallpapers actually output, nothing else).
   - `dropout {"corr":"tr-12"}` — a reference-based report (lag, fit, flagged drops/micro-gaps)
     for a transition/retire/pause window, emitted as `probe.dropout`; auto-run after every
     `transition.done` while `player.debug` is on. `docs/player/debugging.md` is the symptom →
     probe → cause playbook.
   - `loop` — tick/busy timing (`max_busy_ms`, `max_open_ms`), the gain timer, and `bounds`:
     the size of every per-source collection (a long run of switches must leave them bounded).
   - `memory` — RSS + glibc malloc's live vs retained bytes and arena count (`{"trim":true}`
     shows what a `malloc_trim(0)` gives back): "RSS grows" → leak or allocator retention.
5. **`liascape-player ctl capture '{"target":"out:DP-1","path":"/tmp/x.png"}'`** — look at the actual
   pixels of an output, a layer, or a source.
6. **`liascape-player ctl set '{"path":"player.debug","value":true}'`** (or `serve --debug`) turns on
   the dropout auto-trigger above; `--log-level debug` adds the debug events (`onset.held`/
   `onset.started`, `source.position`, `player.pause_gate_opened`, …) to the log.
7. Every command and query is available as JSON from a shell (`liascape-player ctl <verb> '<args>'`,
   `--timeout-ms` to override the 10 s default) — nothing here needs the GUI, mpv's own IPC, or a
   monitor plugged in.

---

## 6. Deliberately not done yet — Phase 2–6 roadmap

Phase 1 shipped video, image and colour sources, every transition method, Wayland outputs, the
audio bus, crash recovery, and the backend adapter; Phase 2 added WE scenes — behind
`PlayerEngine: legacy | liascape-player`, default `legacy`. What is left below was scoped out on purpose
(design spec §12), not missed:

- **Done early from Phase 2: the render worker** (2026-10-26, default on) — every mpv source's render context
  lives on an `lia-render` thread in the compositor's share group; the loop only adopts finished, fenced frames
  (`.claude/rules/player-core.md` § Sources "Render worker"). Since 2026-10-27 hardware decoding on it is
  zero-copy: the render contexts load the GPU's GL interop (CUDA on NVIDIA, VAAPI on AMD/Intel), whose init
  runs on one of three `lia-render` lanes beside the playing wallpaper's — never the loop, never in front of A
  (§ Sources "Hardware decoding").
- **Phase 2 — WE scenes: done, except the on-machine battery (plan Task 14, run by the owner).** A scene is
  a graph `Source` of `kind: scene`, rendered by LWE's `next-v2` core (vendored from the owner's fork,
  `third_party/lwe/PIN`, patches in `patches/lwe/`) inside **one `liascape-scene-worker` process per scene source,
  shared by every output showing it** (the design spec said one per output; the owner chose shared — D1 in
  the plan — which halves GPU time and VRAM and keeps the animation in sync across monitors; per-output fps
  survives as a present gate). The worker hands the compositor GPU frames over dmabuf with `sync_file`
  fences in both directions (proven on NVIDIA proprietary by `docs/player/spikes/dmabuf.md`): the compositor
  latches only an already-signalled frame and never `eglWaitSync`s on a worker fence (invariant #10). A
  worker crash, hang or GL-context loss holds the last frame (or the item's preview), restarts the worker
  resuming at the held scene time (≤ 3× / 60 s), then marks the scene **broken** — silent, held, written
  to `<state>/crashes/*.json`, `source.broken` for the backend to skip/advance, and stays broken across a
  player restart (invariant #9); every other output, video and audio is unaffected. Built and tested
  end to end: the scene audio stream (a dB gain on a stream that keeps running, pitch-preserving speed,
  invariant #11), all three transition methods across V→S / S→V / S→S, a per-output scene fps, an
  auto-throttling GPU budget, a per-scene VRAM limit and a system low-VRAM pause/stop (`player.vram_low_mode`),
  mouse input and the system-audio visualiser feed, the scene properties editor (`scene_props`, live),
  loudness learned over a scene's first 60 s of audible play (`scene.loudness`, applied by the backend as
  `gain.normalize`), the backend adapter (`ScenesPlayable`, settings wired live, `LweMonitors` fps live) and
  UI matrix cells. The corpus runner (`src/player/tests/onmachine/scene_corpus.sh`) played all 96 Workshop
  scenes of the owner's library: 86 ok, every failure an LWE-core bug; with the fork's patches 0012–0017
  (2026-10-28) 92 ok + 1 still-by-design, the 3 left are 3D scenes (Phase 6;
  `docs/player/reports/scene-corpus.md`). **Still open for Phase 2:** the on-machine battery and its report
  (Task 14 — outputs, dropout V↔S, crash isolation on real outputs, GPU budget under a heavy worker, soak,
  VT-switch/suspend). Deferred beyond Phase 2: the `g_Daytime` uniform (LWE's core never updates it; it
  stays 0), web wallpapers (Phase 4), core-side scene fixes (Phase 6). Scenes
  need the worker binary **and** WE's `assets/` (else `hello.capabilities` omits `scene` and scene items are
  skipped like `AllowScenes=false`); `install.sh --no-scenes` builds without the LWE core.
- **Web wallpapers** (WE `web` items via CEF/LWE's `webhelper`) are not started. **Phase 4**,
  optional build module (CEF is hundreds of MB), gated on resolving the NVIDIA LINEAR-dmabuf
  external-only risk the design spec flags for it.
- **Programs and Signals stay in the C# backend.** Rotation, advance/wait-on-end, shuffle,
  history, `--restore` replay and auto-mute are still driven by the backend adapter
  (`.claude/rules/player-adapter.md`) over the Command API, not by an in-process `Program`/`Signal`. **Phase 3**
  moves them into the player (retiring the backend's timer/monitor/restart daemons,
  `pending_action.txt`, pid-file ownership). The in-player auto-mute Signal (per-stream metering, the player's
  own bus excluded by *ownership*, ≤ 100 ms) is **PARKED** (owner, 2026-10-28): auto-mute stays the backend's
  `AudioMonitor` for both engines, and is not part of the switch-over bar while parked.
- **Per-monitor is a player capability, not a user-facing feature yet.** The graph already
  supports independent per-output content (`out:<connector>`, its own main layer) and this is
  provable today via `ctl`/headless tests; nothing in the Electron UI exposes assigning different
  wallpapers, rotations, or next/prev/mute scope per output. That UI work is a separate follow-up
  project, brainstormed on its own (`docs/TODO.md` → "Follow-up projects"), after switch-over.
- **The switch-over bar itself (design spec §11) is not met and not attempted yet**: zero
  dropouts/seams across the full compose matrix for ≥ 50 consecutive switches per mode, full
  parity with every setting verified live, proven crash isolation, an 8 h soak with flat RSS/VRAM
  (auto-mute ≤ 100 ms parked), and a scene corpus no worse than today. The Phase 1 on-machine battery
  and soak ran for what Phase 1 covered (video/image/colour; `docs/player/reports/phase1.md`: dropouts
  0/0, soak 0.31 MiB/min); Phase 2's (plan Task 14) is the owner's to run and report in
  `docs/player/reports/phase2.md`; the scene-corpus comparison against the legacy engine
  (`scene_corpus.sh --ab-legacy`, owner-run — it draws on a real output) is also still open. The full bar
  can't be met until Phases 3–4 land.
- **Phase 5** is the switch-over itself once the bar holds: flip `PlayerEngine`'s default, delete
  the legacy path (the mpvpaper launch code, `liascape-transition`, `liascape-audio`, per-monitor LWE process
  management, and the backend code that drove them) and this doc's "legacy" framing along with it.
- **Phase 6** (ongoing after switch-over): the scene-compatibility programme — import worthwhile
  upstream LWE pull requests as labelled patches (`patches/lwe/*.patch`, see `UPSTREAM.md`), fix
  scenes from the owner's corpus, and track per-scene status. This is livepaper's stated
  differentiator beyond upstream LWE (design spec §2 goal 10) and is corpus-driven, never a
  switch-over blocker beyond "no worse than today."
