# lp-player architecture

`lp-player` is the Rust compositor that is replacing mpvpaper + `lp-transition` + per-monitor
`linux-wallpaperengine` (LWE) + `lp-audio` with one process that owns every wallpaper type, on
every monitor, with every transition. Design authority:
`docs/superpowers/specs/2026-10-20-utopia-player-design.md` (read for *why*; this doc is the map
for *where* and *how to debug*). Status: **Phase 1 core implemented** (compositor, video/image/
colour sources, all three transition methods, Wayland outputs, audio bus, supervisor + snapshot,
the C# backend adapter) — see `docs/TODO.md` → "lp-player" for exactly what's done vs pending.
The backend's `AppSettings.PlayerEngine` defaults to `legacy`; `lp-player` is opt-in and
experimental until the switch-over bar (§6 below) is met.

This file links to the per-module detail instead of duplicating it:
`.claude/rules/player-core.md` (the Rust crate, one `##` section per module) and
`.claude/rules/player-adapter.md` (the C# adapter, `src/livepaper/Player/`) are the sources of
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
   left off.

---

## 2. One-screen map

### Process model

```
┌──────────────────────── lp-player (one process tree, supervised) ────────────────────────┐
│ supervisor (src/supervise.rs) — fork+execs before any thread/EGL/PipeWire exists; never    │
│   binds the socket, never touches EGL/audio; waits, forwards signals, restarts on a crash  │
│   with --restore (budget: 5 restarts / 60 s, then gives up)                                │
│   │                                                                                         │
│   └─ compositor child — the one calloop event loop (src/runtime.rs):                       │
│        Graph (src/graph/) · Animator + Clocks (src/anim.rs, src/clock.rs) ·                │
│        gl-transitions Effects (src/gfx/effects.rs) · Composer (src/gfx/compose.rs) ·        │
│        Transition recipe (src/recipes/transition.rs) · Command API (src/api/) · Probes      │
│        (src/probe/) · Audio bus (src/audio/) · Snapshot writer (src/snapshot.rs)            │
│        in-process sources: video/image via libmpv (src/sources/mpv.rs, src/mpv/),           │
│        colour (src/sources/color.rs), still-frame copies (src/sources/snapshot.rs)          │
└──────────────▲──────────────────────────────────────────────────▲─────────────────────────┘
               │ JSON Lines, one unix socket                       │ EGL + Wayland (src/wl.rs),
               │ $XDG_RUNTIME_DIR/livepaper/lp-player.sock          │ or --headless virtual
               │                                                   │ outputs (src/headless.rs)
    livepaper backend (C#, src/livepaper/Player/) ──────────▶  wlr-layer-shell outputs
    AppSettings.PlayerEngine = legacy | lp-player              (one surface per wl_output)
```

Phase 1 has **no worker processes** — scenes and web wallpapers (Phase 2/4) will run in their own
isolated worker per output, handing GPU frames to the compositor over dmabuf (proven feasible by
the Phase 0 spikes, `docs/player/spikes/{lwe-core,dmabuf}.md`); until then every source lives
in-process inside the compositor, which is also why a scene item is simply skipped under
`PlayerEngine=lp-player` today (exactly like `AllowScenes=false`).

### Block model

Every feature is only ever a combination of these blocks (spec §4.2) — there is no
feature-specific plumbing anywhere else in the crate:

| Block | One job | File |
|---|---|---|
| **Source** | produce frames (+ optional audio); uniform play/pause/seek/speed/loop controls, `gain.<slot>` | `src/player/src/sources/{mpv,color,snapshot,host}.rs`, `src/player/src/mpv/` |
| **Output** | one monitor (`out:<connector>`); size/refresh/layer; appears/disappears with hotplug | `src/player/src/graph/{mod,props}.rs`, `src/player/src/wl.rs` / `src/player/src/headless.rs` |
| **Layer** | what an output shows: fit/viewport/opacity over a `Source` or an `Effect` | `src/player/src/graph/props.rs`, `src/player/src/gfx/compose.rs` |
| **Effect** | a gl-transitions shader over two textures + parameters | `src/player/src/gfx/effects.rs` (compiles `transitions/`, never edits it) |
| **Gain** | a source's audio level in dB; slots (`user`/`override`/`normalize`/`mute`/`automute`/`xfade`/`anticlick`) sum in dB | `src/player/src/units.rs` (`Gains`), `src/player/src/graph/props.rs` |
| **Animator** | move any property over time along a curve (linear/smoothstep/equal-power/step) | `src/player/src/anim.rs` |
| **Clock** | a time base; pausable per-output or globally | `src/player/src/clock.rs`, `Runtime`'s player-pause fields |
| **Program / Recipe** | the only place policy lives, built only from the blocks above; today: the transition A→B recipe | `src/player/src/recipes/transition.rs` |
| **Command API** | create/destroy/set/get/animate/subscribe/probe/capture | `src/player/src/api/{proto,server,handlers}.rs`, `src/player/src/ctl.rs` |
| **Probe** | measure: live sources, loop health, frame pacing, the audio bus/meter, the snapshot writer | `src/player/src/probe/{mod,frames,audio,snapshot}.rs` |

**Signal** (spec §4.2: "other audio playing" → auto-mute, "window fullscreen" → auto-pause) is
specified but **not implemented yet** — it is Phase 3 (§6). Today the equivalent decisions
(auto-mute) are still made by the legacy C# `AudioMonitor`, outside the player, for both engines.

---

## 3. One wallpaper switch, end to end

Every switch — a manual next/prev, a timed tick, a video-end advance, `--restore` — goes through
the exact same path: the backend never talks to a source directly, only to the recipe via the
Command API.

```
C# backend (PlayerHelper → LpPlayerMedia.Switch, player-adapter.md § Dispatch points)
  │ "transition" request, JSON Lines over $XDG_RUNTIME_DIR/livepaper/lp-player.sock
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

**Every tick** (the one calloop loop, `src/player/src/runtime.rs`, "Who runs what"): `Animator::tick` →
`Graph::set` → due destroys → `sync_sources` (`SourceHost::sync`, forwards drained graph changes
to the live mpv/colour sources) → `update_sources` (`SourceHost::update`, pulls back `Ready`/
`Ended`/`Position`/`Error` events, mirrors observed values) → `Transitions::tick(those events)`
(advances the state machine, drains its own events) → `refresh_srcs` → `Composer::compose_output`
per output → present (`src/player/src/wl.rs` frame callback, or the headless backend's no-op).

**Every event**, the moment it's produced, goes through `log::event` (→ `events.jsonl` +
the in-memory `recent()` ring, `src/player/src/log.rs`) and the Command API's tap (`src/player/src/api/server.rs`),
which flushes it to every subscribed `ctl subscribe`/socket client **before** that command's own
reply is sent. The backend's `LpPlayerClient` background event connection
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
| Transition methods, align, interrupt/cancel, sharing, hotplug adoption | `src/player/src/recipes/transition.rs` | § Transition recipe | `src/player/tests/transition.rs` |
| The event loop, hotplug, stepped clock, retire/park | `src/player/src/runtime.rs`, `src/player/src/headless.rs` | § Runtime | `src/player/tests/api.rs` |
| Command API verbs, error codes, `ctl` | `src/player/src/api/{proto,server,handlers}.rs`, `src/player/src/ctl.rs` | § Command API | `src/player/tests/api.rs` |
| Wayland surfaces, layer-shell layer, pointer, frame pacing | `src/player/src/wl.rs`, `src/player/src/redraw.rs` | § Wayland | `src/player/tests/onmachine/outputs.sh` |
| The audio bus, re-targeting, the meter | `src/player/src/audio/{bus,meter}.rs` | § Audio bus | `src/player/tests/onmachine/bus.sh`, `src/player/tests/api.rs::bus_*` |
| Crash restart, startup-failure classification | `src/player/src/supervise.rs` | § Supervisor | `src/player/tests/supervise.rs` |
| State persistence / `--restore` | `src/player/src/snapshot.rs` | § Snapshot | `src/player/tests/supervise.rs` (restore cases) |
| The C# side of a setting / dispatch point | `src/livepaper/Player/*.cs` | `.claude/rules/player-adapter.md` | `scripts/test-lp-player-adapter.sh`, `--lp-player-selftest` |
| Reference-based dropout detection (landing via Task 15/16c, lane B) | `src/player/src/probe/dropout.rs`, `scripts/lp_audiowatch.py` | `docs/player/debugging.md` (same lane) | `src/player/tests/dropout.rs` |

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
   lp-player serve --headless --outputs 1920x1080@60 --clock stepped --ao null   # deterministic
   lp-player serve                                                                # real Wayland + audio
   ```
2. **`lp-player ctl state`** — the whole live graph: what each output shows
   (`lay:<connector>:main.content`, the `cur:` alias), every source's
   `ready`/`paused`/`time_pos`/`gain_effective_db`, and every live transition's phase + held
   sources.
3. **`lp-player ctl logs '{"corr":"tr-12"}'`** — one switch's whole story in order:
   `scheduled` → `started` → `handoff` → `done`, or exactly where it stopped
   (`cancelled {reason}` / `failed {path,reason}`). The adapter log and `LpPlayerMedia.LastCorr`
   (`.claude/rules/player-adapter.md` § Debugging) name the corr id for "the switch that just happened."
   `ctl logs '{"min_level":"warn"}'` lists everything that went wrong, process-wide.
4. **Probes** (`ctl probe '{"name":"<name>"}'`):
   - `sources` — what each source actually runs (mpv's real `volume-gain`, `pause`, unanswered
     async requests, stepped status) vs what the graph says it should.
   - `frames` — present-interval pacing per output (mean/p95/missed), whether an output is idle.
   - `bus` / `meter.window {"last_ms":1000}` — the audio bus's health and a window of its real
     dBFS (what the wallpapers actually output, nothing else).
   - `dropout` — lands with Task 15/16c (lane B, not yet in this history): a reference-based
     report (lag, fit, flagged drops/micro-gaps) auto-emitted after every `transition.done` once
     `player.debug` is on; see `docs/player/debugging.md` (same lane) for the symptom → probe →
     cause playbook once it lands.
5. **`lp-player ctl capture '{"target":"out:DP-1","path":"/tmp/x.png"}'`** — look at the actual
   pixels of an output, a layer, or a source.
6. **`lp-player ctl set '{"path":"player.debug","value":true}'`** (or `--debug` at startup, once
   that flag lands with the same lane) raises logging detail and turns on the always-on-in-debug
   probes above.
7. Every command and query is available as JSON from a shell (`lp-player ctl <verb> '<args>'`,
   `--timeout-ms` to override the 10 s default) — nothing here needs the GUI, mpv's own IPC, or a
   monitor plugged in.

---

## 6. Deliberately not done yet — Phase 2–6 roadmap

Phase 1 ships video, image and colour sources, every transition method, Wayland outputs, the
audio bus, crash recovery, and the backend adapter — behind `PlayerEngine: legacy | lp-player`,
default `legacy`. Everything below is scoped out of Phase 1 on purpose (design spec §12), not
missed:

- **Scenes are skipped**, exactly like `AllowScenes=false` (`PlayerEngine.ScenesPlayable`) — LWE
  is not vendored yet. **Phase 2** vendors LWE's `next-v2` branch (pinned commit; the approach and
  its required local patches were proven by the Phase 0 spike,
  `docs/player/spikes/lwe-core.md`) as a library inside **one worker process per output**, handing
  the compositor GPU frames over dmabuf with `sync_file` fences in both directions (proven on
  NVIDIA proprietary by `docs/player/spikes/dmabuf.md`: latch-only-already-signalled, never
  `eglWaitSync` on a worker fence). A worker crash holds that output's last frame and restarts
  (≤ 3× / 60 s, then marked broken) — every other output, video and audio stays unaffected. All
  three transition methods extend to scenes with no new effect-gating logic.
- **Web wallpapers** (WE `web` items via CEF/LWE's `webhelper`) are not started. **Phase 4**,
  optional build module (CEF is hundreds of MB), gated on resolving the NVIDIA LINEAR-dmabuf
  external-only risk the design spec flags for it.
- **Programs and Signals stay in the C# backend.** Rotation, advance/wait-on-end, shuffle,
  history, `--restore` replay and auto-mute are still driven by the backend adapter
  (`.claude/rules/player-adapter.md`) over the Command API, not by an in-process `Program`/`Signal`. **Phase 3**
  moves them into the player (retiring the backend's timer/monitor/restart daemons,
  `pending_action.txt`, pid-file ownership) and adds the auto-mute Signal that meters each foreign
  PipeWire stream individually (never the mix) and excludes the player's own bus by *ownership*,
  targeting **≤ 100 ms** reaction (§4.4; a probe-measured switch-over criterion).
- **Per-monitor is a player capability, not a user-facing feature yet.** The graph already
  supports independent per-output content (`out:<connector>`, its own main layer) and this is
  provable today via `ctl`/headless tests; nothing in the Electron UI exposes assigning different
  wallpapers, rotations, or next/prev/mute scope per output. That UI work is a separate follow-up
  project, brainstormed on its own (`docs/TODO.md` → "Follow-up projects"), after switch-over.
- **The switch-over bar itself (design spec §11) is not met and not attempted yet**: zero
  dropouts/seams across the full compose matrix for ≥ 50 consecutive switches per mode, full
  parity with every setting verified live, proven crash isolation, an 8 h soak with flat RSS/VRAM,
  auto-mute ≤ 100 ms, and a scene corpus no worse than today. **Task 20** (next) runs the Phase 1
  on-machine battery and soak for what Phase 1 *does* cover (video/image/colour, all transition
  methods, both outputs) and reports in `docs/player/reports/phase1.md`; the full bar can't be
  met until Phases 2–4 land.
- **Phase 5** is the switch-over itself once the bar holds: flip `PlayerEngine`'s default, delete
  the legacy path (the mpvpaper launch code, `lp-transition`, `lp-audio`, per-monitor LWE process
  management, and the backend code that drove them) and this doc's "legacy" framing along with it.
- **Phase 6** (ongoing after switch-over): the scene-compatibility programme — import worthwhile
  upstream LWE pull requests as labelled patches (`patches/lwe/*.patch`, see `UPSTREAM.md`), fix
  scenes from the owner's corpus, and track per-scene status. This is livepaper's stated
  differentiator beyond upstream LWE (design spec §2 goal 10) and is corpus-driven, never a
  switch-over blocker beyond "no worse than today."
