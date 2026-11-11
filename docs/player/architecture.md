# liascape-player architecture

Covers the whole Rust player (`src/player/`) and how the C# backend drives it (`src/backend/Player/`). Design
authority for the original why: `docs/superpowers/specs/2026-10-20-utopia-player-design.md`. Mechanism lives in
`.claude/rules/player/*.md` (rules) and `docs/player/modules/*.md` (walkthroughs); why a rule can't be broken lives in
[invariants.md](invariants.md). When this map and those disagree, they are right.

`liascape-player` replaces mpvpaper + `liascape-transition` + per-monitor `linux-wallpaperengine` + `liascape-audio`
with one process tree that owns every wallpaper type, on every monitor, with every transition. The backend selects
it with `AppSettings.PlayerEngine` (`legacy` by default, `liascape-player` opt-in).

## The invariant everything follows from

> Never hand an audible or visible stream from one owner to another. Only ramp gains and opacities on streams that
> keep running.

A stream that will be heard starts silent (−96 dB) and ramps up; a stream is destroyed only after it was ramped to
silence. Transitions blend textures inside one process on one clock — never a decoder, window or audio stream
handed between programs — so no moment of "nothing plays yet" or "the old one already stopped" has to be hidden by
timing. The other twelve invariants refine it ([invariants.md](invariants.md)).

## Process model

```text
liascape-player serve (supervisor, src/supervise.rs) — fork+execs before any thread/EGL/PipeWire exists;
│  waits, forwards signals, restarts a crashed child with --restore (5 per 60 s)
└─ compositor child — one calloop loop (src/runtime.rs):
     graph · animator + clocks · effects + composer · transition recipe · programs · signals ·
     command API + probes · audio bus · snapshot/outbox writer
     in-process sources: video/image via libmpv (core made on lia-open, rendered on lia-render lanes),
       colour, still copies, and the compositor half of each scene
     threads: lia-open, lia-render, lia-mpv-reaper, lia-bus, lia-snapshot, lia-vram, lia-sysmon,
       lia-cover, lia-cursor, lia-mpris, lia-capture, lia-egl-free, lia-worker-reap
   │ JSON Lines on $XDG_RUNTIME_DIR/liascape/liascape-player.sock ◀── C# backend, ctl
   │ wlr-layer-shell surfaces (src/wl.rs) or --headless virtual outputs (src/headless.rs)
   └─ liascape-scene-worker — one process per scene source, shared by every output showing it:
        LWE's core renders into a 3-slot dmabuf ring with sync_file fences both ways; its sound is
        its own stream on the player bus; a crash or hang costs only that scene
```

One worker per scene source rather than per output halves GPU time and VRAM and keeps the animation in sync across
monitors; per-output frame rates survive as a present gate in the compositor. Video, image and colour stay
in-process.

## Block model

Every feature is a combination of these blocks; there is no feature-specific plumbing elsewhere.

| block | one job | code |
|---|---|---|
| Source | frames (+ optional audio), play/pause/seek/speed/loop, `gain.<slot>` | `src/player/src/sources/`, `src/player/src/mpv/`, `src/player/src/worker/` |
| Output | one monitor `out:<connector>`; size, refresh, layer; hotplug | `src/player/src/graph/`, `wl.rs`, `headless.rs` |
| Layer | what an output shows: fit/viewport/opacity over a Source or an Effect | `graph/props.rs`, `gfx/compose.rs` |
| Effect | a gl-transitions shader over two textures | `gfx/effects.rs` (compiles `transitions/`, never edits it) |
| Gain | a source's level in dB; slots sum | `units.rs` |
| Animator / Clock | move any property along a curve; pause-excised time | `anim.rs`, `clock.rs`, `Runtime::now` |
| Recipe / Program | the only places policy lives: the A→B transition and the rotation (`prog:<name>`, which only requests transitions) | `recipes/transition.rs`, `recipes/program/` |
| Signal | an observed outside fact: covered outputs, foreign audio | `signal/` |
| Command API / Probe | create/destroy/set/get/animate/subscribe/capture; measure everything live | `api/`, `ctl.rs`, `probe/` |

## One switch, end to end

A single wallpaper is the backend's `transition` request; a rotation is the player's own (`Programs::tick` →
`Transitions::start` with `origin: "program:prog:main"`), so it runs the same with the app closed.

```text
backend (PlayerHelper → LiascapePlayerMedia.Switch) ── transition ──▶ api/handlers.rs → Transitions::start
  B created paused at −96 dB (a bad request changes nothing); an in-flight transition on an overlapping
  output is superseded or committed first                                → transition.scheduled
  WaitingReady (B's first frame) → WaitingStart (align: now at once; end: timed to A's end)
                                                                         → transition.started
  Running: fx.progress 0→1 and the method's gain pair (full-live crossfade; reveal: A ramped out and held;
  frozen: both held, B silent until the end)
  Handoff: layers → B; A restored if shown elsewhere, else ramped to −96 and buried
                                                                         → transition.handoff
  Done once every grave is buried                                        → transition.done
  (or transition.cancelled / transition.failed — a failing B snaps back to A, never black or silent)
```

Every tick runs the animator, syncs graph changes into sources, collects their events, advances transitions and
programs, then composes and presents the outputs that are due ([modules/runtime.md](modules/runtime.md)). Every
event goes to `events.jsonl`, the in-memory ring and every subscribed client before the reply of the command that
caused it; the backend's event connection completes its waits from them ([adapter.md](adapter.md)).

## Where to change what

| area | rule | walkthrough | tests |
|---|---|---|---|
| dB math, clocks, animation, graph, event log, snapshot, outbox, supervisor, memory | `.claude/rules/player/core.md` | [graph-properties](modules/graph-properties.md), [persistence](modules/persistence.md), [runtime](modules/runtime.md) | unit tests, `src/player/tests/supervise.rs` |
| EGL, composition, effects, Wayland, frame pacing, capture | `.claude/rules/player/gfx-wayland.md` | [gfx-egl](modules/gfx-egl.md), [composition](modules/composition.md), [wayland](modules/wayland.md) | `src/player/tests/{gfx_basic,compose,effects_all}.rs`, `src/player/tests/onmachine/outputs.sh` |
| mpv sources, hwdec, render worker, audio bus, meter | `.claude/rules/player/sources-audio.md` | [sources](modules/sources.md), [audio-bus](modules/audio-bus.md) | `src/player/tests/sources.rs`, `src/player/tests/onmachine/bus.sh` |
| loop, transitions, programs, signals, command API, probes | `.claude/rules/player/runtime-api.md` | [runtime](modules/runtime.md), [transitions](modules/transitions.md), [programs](modules/programs.md), [signals](modules/signals.md), [command-api](modules/command-api.md) | `src/player/tests/{api,transition,program,automute}.rs` |
| scenes: worker, transport, LWE, audio, loudness, GPU/VRAM, crashes | `.claude/rules/player/scenes.md` | `modules/scene-*.md` | `src/player/tests/{worker,scene,lwe_build,scene_loudness}.rs` |
| the C# side of a setting, rotation semantics | `.claude/rules/backend/player-adapter.md` | [adapter](adapter.md) | `scripts/test-liascape-player-adapter.sh`, `player-selftest` |
| audio symptoms, dropout detection | — | [debugging](debugging.md) | `src/player/tests/dropout.rs`, `src/player/tests/onmachine/dropout.sh` |

A setting always has two ends: the graph property (every writable property is live on the player side by
construction) and the adapter's resolver pass that sends it to each source with that source's own value.

## Debugging

Everything is observable from text: `ctl state`, `ctl logs '{"corr":…}'`, `ctl probe`, `ctl capture`, and a
deterministic replay on `serve --headless --clock stepped --ao null`
([modules/command-api.md](modules/command-api.md) § Debugging order). `player.debug` (or `serve --debug`) runs the
dropout detector after every transition; [debugging.md](debugging.md) maps audio symptoms to probes.

## Not built

- **Web wallpapers** (WE `web` items through CEF): not started; would use the scene-worker pattern and is gated on
  NVIDIA's LINEAR dmabufs being external-only.
- **Per-monitor content in the UI:** the graph already supports independent content per output (provable through
  `ctl`), but nothing in the app assigns different wallpapers, rotations or controls per output.
- **The switch-over bar** (design spec §11: zero dropouts and seams across the compose matrix for ≥ 50 switches per
  mode, full live-settings parity, proven crash isolation, an 8 h soak with flat RSS and VRAM, a scene corpus no
  worse than the legacy engine) is not yet met; only then does `PlayerEngine` default to `liascape-player` and the
  legacy path go. Dated results: `docs/player/reports/`.
- **Scene compatibility** is an ongoing, corpus-driven programme of LWE patches (`patches/lwe/`, `UPSTREAM.md`),
  measured by the corpus and health runners ([modules/scene-lwe-core.md](modules/scene-lwe-core.md)).
