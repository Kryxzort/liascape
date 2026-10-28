# lp-player — the "utopia player" — design

Status: **approved by owner 2026-10-20** (with TransitionMethod kept) — next: implementation plan · Date: 2026-10-20 · Repo: livepaper-pro (branch `transitions-reveal`)

Items marked **(my call)** were decided by the designer, not the owner; the owner can override any of them.
Everything else was stated or confirmed by the owner.

---

## 1. Intent — what this is and why

livepaper plays live wallpapers today by orchestrating **four separate programs**: `mpvpaper` (videos),
`lp-transition` (the transition overlay), one `linux-wallpaperengine` (LWE) process **per monitor** (scenes), and
`lp-audio` (scene-audio volume control), all driven by the C# backend over sockets, files and process signals.

Every switch moves an *audible, visible* stream from one program to another (mpvpaper-A → overlay-A → overlay-B →
mpvpaper-B), coordinated by wall-clock timing across processes. Each race in that handoff has needed its own
workaround, and the workarounds now dominate the player code. Recent measured examples, all fixed with patches
rather than removed at the root:

- cubic volume curves sagging every crossfade by ~17 dB (commit `6f0433a`)
- a 3–4 ms silence on A at transition start from speed-tracking a *second copy* of A (`04533a8`)
- a 3.5 s cross-process ready-file timeout cutting A under a silent overlay → 446 ms of silence (`04533a8`)
- a killed overlay leaving mpvpaper parked paused → ~4.5 s silent and frozen (`04533a8`)
- mpvpaper's memory leak → a restart daemon; NixOS `.mpvpaper-wrapped` process matching; VRAM pile-ups

The owner's goal is a **"utopia player"**: one player that owns every wallpaper type, on every monitor, with every
transition, and is **silence-free and seamless by construction, not by timing**. It should be built from small,
focused, abstract building blocks so that future features are new combinations of existing parts ("reuse the
footpaths instead of building new roads"), not new special-case code. It must stay easy to keep up to date with the
upstream projects it absorbs, and be documented and debuggable in a way optimised for AI models working on it.

### The one invariant everything follows

> **Never hand an audible or visible stream from one owner to another. Only change gains and opacities on streams
> that keep running.**

A stream that will be heard is started silent (−96 dB) and ramped up; a stream is only destroyed after it has been
ramped to silence. Transitions only ever blend *textures* inside one process on one clock. If this holds, dropouts
and visual seams cannot happen regardless of timing.

---

## 2. Goals, non-goals, anti-goals

### Goals
1. **One player process** (`lp-player`, **my call** on the name) replacing mpvpaper, `lp-transition`, the per-monitor
   LWE processes and `lp-audio`.
2. **Every wallpaper type as a texture source**: video, image, scene (WE scene via LWE), web (WE web wallpaper via
   Chromium/CEF), solid colour. All transitions work between any two types (V↔V, V↔S, S↔S, + image, + web) with any
   effect.
3. **Per-monitor wallpapers** (owner's to-do), plus mirroring and spanning one source across monitors — as a
   **player capability**, proven via the CLI and headless tests. **(my call)** The *user-facing* per-monitor feature
   (UI to assign wallpapers/playlists per output, per-output rotation, which monitor next/prev/mute act on, per-output
   `/current` + preview, `--restore` of per-output sessions, hotplug defaults) is a **separate follow-up project
   after switch-over**, brainstormed on its own. Until then the backend drives "the same wallpaper on every output",
   exactly as today.
4. **Least possible interruption** (owner): a crashing scene/web wallpaper never affects other monitors or videos;
   the affected monitor holds its last frame while the worker restarts.
5. **Composable architecture** (owner): small blocks with one job each; features are recipes (§4).
6. **Feature parity** with today's player, including "settings apply live" and "features must compose" (§10).
7. **Upstream-trackable** (owner): code categorised by origin so catching up with upstream is mechanical (§7).
8. **AI-optimised docs and debug mode** (owner) (§8, §9).
9. Absorb mpvpaper's strengths: per-output layer-shell surfaces, choice of layer, auto-pause/auto-stop when hidden,
   pause when a window is fullscreen/maximized/active (wlr-foreign-toplevel), no leaks.
10. Improve WE scene compatibility beyond upstream LWE as a distinguishing feature of livepaper (owner) — last phase.

### Non-goals
- Rewriting LWE's scene engine. It is vendored and patched, not reimplemented (§6).
- Changing the Electron UI, library, scrapers, Steam integration or settings storage beyond what parity needs.
- X11 sessions and compositors without `wlr-layer-shell` (GNOME). Same reach as mpvpaper today.
- WE "application" wallpapers (native executables).

### Anti-goals (would be a failure even if it "works")
- Any audible dropout or visible seam at a switch, in any mode — measured, not assumed (§11).
- Reintroducing cross-process timing coordination for anything on screen or audible.
- Feature-specific plumbing that a new feature can't reuse (one-off code paths per mode/type).
- Forking LWE so far from upstream that its future fixes can't be pulled in.
- A crash in scene/web code blanking every monitor.
- Volume handled as percentages anywhere inside the player (gains are dB; conversion only at the edge, §5.3).

---

## 3. Constraints

- **Platform**: Wayland, `wlr-layer-shell` compositors (Hyprland, Sway, river, Wayfire, KDE Plasma). Owner's machine:
  NixOS, Hyprland, **NVIDIA proprietary**, two 1920×1080 outputs (DP-1 @144 Hz, DP-2 @240 Hz). NVIDIA is the
  primary target and the riskiest for GPU buffer sharing (§12).
- **Packaging**: must build via the existing Nix flake **and** `scripts/install.sh` (Arch/Ubuntu/Fedora). The native
  toolchain is already a hard requirement; `cargo`/`rustc` join it. **(my call)** `scripts/PKGBUILD` and
  `scripts/build-appimage.sh` are out of scope: they still build the pre-rewrite Avalonia app and are already broken
  (`.claude/rules/distribution.md`). Fixing them is separate work.
- **(my call)** Build requirements follow the project's "never silently degrade" rule (commit `e93df0e`):
  - The **scene worker** (vendored LWE core: CMake, glm, FFmpeg, GL, …) builds by default. If its dependencies are
    missing, `install.sh` **hard-fails** with per-distro instructions, unless the user passes an explicit
    `--no-scenes`. That flag hides scenes in the UI, as `AllowScenes=false` does today.
  - The **web worker** (CEF, hundreds of MB) is **opt-in** (`--with-web`). Without it, web items stay hidden as today.
- **Licence**: mpvpaper and linux-wallpaperengine are both **GPL-3.0** (verified in their `LICENSE` files). `lp-player`
  is therefore GPL-3.0. The C# backend talks to it over a socket and stays a separate program. *The livepaper repo
  currently has no LICENSE file at all — owner's decision, outside this design.*
- **Project rules** (CLAUDE.md, apply to all of this): features must compose; settings apply live to the playing
  wallpaper; self-test everything; test with the Steam workshop folder `431960` (SFW) or synthetic ffmpeg clips —
  **never** the steamcmd cache; never kill/reinstall/relaunch the owner's running app — build and let them run it.
- **Upstream reality** (checked 2026-10-20):
  - LWE `master` last commit **2026-06-09**; **0 PRs merged since 2026-06-20**; 39 open PRs, 240 open issues.
    Maintainer's draft PR **#609**, branch **`next-v2`** (head `ddea3b4`, 2026-08-03; contains all of master),
    splits LWE into `core` (a C library that renders a wallpaper into a host-provided framebuffer), `frontend`,
    `webhelper` (CEF), `dev-viewer`, `common`. Unfinished, unmerged.
  - LWE has no AI-contribution policy and runs CodeRabbit (an AI reviewer) on PRs. Seven Claude-assisted PRs exist;
    none merged, but nothing at all has been merged in four months.
  - mpvpaper: active (1.9 in July 2026, commits through 2026-08-28), ~2 k lines of C.
- **The owner's library** (`431960`): 219 video, 96 scene, 5 web wallpapers.

---

## 4. Architecture — the building blocks

### 4.1 Process model (decided — least interruption)

```
┌──────────────────────────── lp-player (compositor, never runs risky code) ─────────────────────────────┐
│ Outputs (one layer-shell surface per monitor) · Layers · Effects · Animator · Clocks · Gains · Probes   │
│ In-process sources: Video/Image (libmpv render API), Colour                                            │
│ Command API (unix socket) ◀───────────── livepaper backend (C#)                                        │
└──────────▲──────────────────────────────▲─────────────────────────────────────────────────────────────┘
           │ GPU frames (dmabuf) + audio  │
   ┌───────┴────────┐            ┌────────┴───────┐
   │ scene worker   │            │ web worker     │   one worker process per running scene/web source
   │ (LWE core lib) │            │ (CEF via LWE   │   crash → that output holds its last frame,
   └────────────────┘            │  webhelper)    │   worker restarts; nothing else is affected
                                 └────────────────┘
```

- The **compositor** owns the screens, the clock(s), the effects and all gain decisions. It contains no
  wallpaper-format parsing beyond what libmpv does.
- **Scene and web sources run in worker processes** and hand frames to the compositor as GPU buffers (dmabuf /
  EGLImage) with sync. On a worker crash the compositor keeps showing the last frame (or the item's preview image),
  restarts the worker, and reports the crash (§6.3).
- **Video and image sources stay in-process** (libmpv is mature; keeping them in-process gives exact timing and audio
  control). The source interface is identical for in-process and worker sources, so a video source can be moved into
  a worker later without touching anything else.
- **Supervision**: if the compositor itself dies, a minimal supervisor restarts it in under a second and it restores
  from its own last persisted state snapshot. The mechanism is the builder's choice; there must be no dependency on
  the C# backend being alive.

### 4.2 Blocks (each does one job; features are only ever combinations of these)

| Block | One job | Notes |
|---|---|---|
| **Source** | produce frames (+ optional audio) | video, image, scene, web, colour. Uniform controls: play/pause/seek/speed/loop/end-behaviour, plus `gain_db`. Emits events: `ready` (first frame), `ended`, `error`, `position`. |
| **Output** | one monitor | name, size, refresh, layer (background/bottom/…). Appears/disappears with hotplug. |
| **Layer** | what an output shows | ordered sources with transform (fill/fit/crop/stretch/position/viewport-offset for spanning) and opacity. |
| **Effect** | a shader over N textures + parameters | gl-transitions effects are effects with a `progress` parameter; filters (blur, tint, …) are effects too. |
| **Gain** | audio level of a source in dB | the only audio control. Mute = gain to −96 dB. Auto-mute, loudness normalisation, user volume, per-item overrides and crossfades all compose as gain contributions (summed in dB). |
| **Animator** | move any parameter over time along a curve | effect progress, opacity, gain, transform. Curves: linear, smoothstep, equal-power pair, … |
| **Clock** | time base | per output (and per source where needed); pause-when-covered pauses one output's clock. |
| **Signal** | an external input as a value | "other app is playing audio" (auto-mute), "window fullscreen on output X" (auto-pause), "MPRIS active". Feeds gains/clocks via rules, not special code. |
| **Program** | a schedule of commands reacting to events | playlists, timed rotation, advance-on-end, wait-for-end, shuffle, history. Runs inside the player, so rotation keeps going with the backend closed. |
| **Command API** | create/destroy nodes, set/animate properties, subscribe to events, query state | the backend composes features from these; no feature-specific verbs are required in the player. Convenience verbs (e.g. `transition`) are allowed only as thin recipes over the generic ones. |
| **Probe** | measure | per-gain and master audio meters, dropout detector, frame timing, seam measurement (§9). |

### 4.3 Recipes (examples showing the footpaths)

- **Transition A→B** on an output = create source B (gain −96 dB, paused until `ready`) · add to the layer under an
  effect node with A and B as inputs · on `ready`: start B · animate `effect.progress` 0→1 and the equal-power gain
  pair over the duration · on completion remove A. No second copy of A, nothing parked, no ready files.
- **Video-end-aligned advance** = Program listens for A's `position` and starts the recipe above so `progress` reaches
  1 exactly at A's end, on the player's own clock (replaces `DoVideoEndWait`, `--align-a-end`, the lead/slack
  estimates and `LastCoverMs`).
- **Per-monitor wallpapers** = one layer per output with its own sources/programs. **Mirror** = one source referenced
  by several layers. **Span** = one source, several outputs, per-output viewport offsets.
- **Same wallpaper on several outputs (parity with today) — (my call):**
  - **videos/images**: one shared source (one decode, one audio stream), mirrored to every output. This is what
    mpvpaper `*` does today.
  - **scenes**: **one worker per output**. This keeps today's per-monitor fps and keeps crash isolation per monitor.
- **Audibility rule — (my call):** a wallpaper shown on several outputs is **heard once**. For a scene, the audible
  instance is the one on the primary output (today's `LweMonitors.IsPrimary`); the others run at gain −96 dB.
  Distinct wallpapers on distinct outputs (the follow-up project) are all audible by default. Which ones should be
  heard is decided in that project.
- **Auto-mute** = Signal("other audio") → gain contribution. **Pause when fullscreen** = Signal("fullscreen on X") →
  pause that output's clock.
- **Live settings** = setting a property on a running node. Every setting maps to a property (§10), so "settings
  apply live" holds by construction.

### 4.4 The backend's role after the switch

The C# backend keeps the library, scrapers, Steam, settings storage and the web API for the UI, and translates UI
actions into player commands. The player owns playback state, including the session snapshot that `--restore`
replays. **(my call)** Playlist/rotation logic moves into the player as a Program (Phase 3), which retires the timer
daemon, `pending_action.txt`, `timer.pid`/`gui_timer.pid` ownership and the restart daemon. Until Phase 3 the
backend drives rotation through the Command API and the player's events. Auto-mute detection (today's
`AudioMonitor` + detached `--monitor` daemon) also becomes a player Signal in Phase 3. It must exclude the player's
own audio streams.

**Auto-mute must react in ≤ 100 ms (owner: "wallpaper engine had it almost instant").** Measured cause of today's
slowness (2026-10-20), independent of `AutoMuteDelayMs`:
- `AudioMonitor` spawns one `parec --monitor-stream` per new stream **without `--latency-msec`**.
- PipeWire's pulse layer then delivers capture data in **2-second fragments** (`pulse.default.frag = 96000/48000`):
  first data after **2020 ms**.
- Even with `--latency-msec=10`, spawning a process per stream costs ~**780 ms** before first data.

The Signal must therefore:
- **meter each foreign stream individually, never the mix**. Today's per-stream `--monitor-stream` method exists
  because metering the mix made auto-mute hear the wallpaper itself and oscillate (owner, 2026-10-20). Keep that
  property.
- recognise the player's own audio **by ownership, not by name**: the PipeWire node and client ids the player
  created (its sources, workers and the bus). Today's `application.name = "mpv"` match is fragile, since any other
  mpv the user runs is wrongly ignored.
- run **in-process** on a **persistent** audio-server connection (libpulse or libpipewire), no process per stream
- attach a peak meter (small fragments, e.g. 10 ms) the instant a stream-create event arrives
- decide on its first fragments

Target: ≤ 100 ms from another app's first audible sample to the wallpaper's mute gain reaching −96 dB (with delay 0).
A probe measures this, and it is a switch-over criterion. WE achieves near-instant via per-session peak meters on
Windows; this is the Linux equivalent.

---

## 5. Rendering and audio rules

### 5.1 Graphics
- **(my call)** The compositor uses **desktop OpenGL (core profile) via EGL**, because LWE's core renders with desktop
  GL (glad). libmpv's render API supports it. The gl-transitions GLSL catalogue (`transitions/`) is reused and adapted
  to the core-profile wrapper. Shared assets stay in `transitions/` (the UI previews use them too).
- One layer-shell surface per output; layer configurable (default background). **(my call)** Pointer input is
  accepted (keyboard never), for parity: LWE is launched today without `--disable-mouse`, so mouse-reactive scenes
  respond on the bare desktop. The compositor forwards pointer position and buttons to scene/web sources in each
  source's own coordinates (transform- and span-adjusted), and to both sides during a transition. Video/image
  sources ignore it.
- **Present at the output's refresh rate**; sources update at their own rate. A missed source frame never stalls the
  compositor.
- libmpv gotchas carried over from `lp-transition`: `vo=libmpv`, and free the render context with its GL context
  current.

### 5.2 Frames from workers
- Workers render into GPU buffers exported as dmabuf; the compositor imports them as EGLImages/textures.
- **Decided by the Phase 0 spike** (`docs/player/spikes/dmabuf.md`, NVIDIA 595.84):
  - **dmabuf + `sync_file` fences in both directions** (worker → "frame ready", compositor → "buffer released").
  - Measured: 124,238 frames with 0 stale/torn/out-of-order; 144.0 fps; worker 1.4–1.6 % CPU; 0.10 ms p50
    transport latency.
- **Latch policy: the compositor samples only the newest frame whose fence has *already signalled*.** It never
  `eglWaitSync`s on a worker fence. Waiting queues the compositor behind the worker's GPU job, which measured
  143.18 fps under a 3.7 ms/frame worker load and lets a hung worker stall every output. Latch-signalled measured
  144.00 fps at the same load.
- The fallback, when fences are unavailable, is the worker waiting on its *own* `sync_file` before handing the
  frame over (1.3 % CPU). A `glFinish` handshake burns 64 % of a core under GPU load; CPU copy failed. Neither is
  used.
- A worker frame not ready in time → the compositor reuses the previous frame (never blocks, never shows black).
- Crash isolation verified: a worker SIGKILLed with its fence unsignalled still had the fence signal, and the held
  frame stayed intact.

### 5.3 Audio
- Each source owns its audio output stream (libmpv instance; LWE core audio in the scene worker; CEF audio in the web
  worker). PipeWire/PulseAudio mixes them.
- **(my call) Player audio bus.**
  - The player creates its own virtual sink, the *lp-player bus*. **Every** player audio stream targets it, both
    in-process and from workers.
  - The bus forwards at 0 dB to the user's current default sink and follows default-sink changes, so chains such as
    EasyEffects keep working.
  - Two uses:
    - the probes tap the bus monitor: the real, server-side mix of exactly the player's audio and nothing else
    - auto-mute's Signal excludes everything on the bus, a clean replacement for today's `application.name`
      filtering
  - If the bus can't be created, the player falls back to direct streams, and the dropout detector reports itself
    unavailable instead of passing silently.
- **Gain is dB everywhere inside the player.** Convert only at the edge, with the correct curve for that edge:
  - mpv → `volume-gain` (exact dB; measured), with `volume` fixed at the user level or 100
  - LWE → its internal float multiplier
  - PulseAudio stream volumes → `pa_sw_volume_from_linear`, **never** `pct/100` (cubic; measured −18 dB at 50 %)
- Crossfades are **equal-power** (cos/sin) by default.
- **Stream continuity**: an audio stream that will be heard is opened while silent and kept running until it has been
  ramped to silence. Audio is never started or stopped while audible. (This removes the AO-buffer and speed-change
  hiccups measured in `04533a8`: the player never speed-tracks a second copy of anything.)
- Loudness normalisation (today: per-item measured `loudnorm` values in the library index) becomes a per-source gain
  contribution or an `af` on that source. Same targets as today.

---

## 6. Scenes and web wallpapers

### 6.1 Scenes — LWE core as a library, in a worker
- Vendor LWE at branch `next-v2` (pin the exact commit; today `ddea3b4`, which contains all of `master`) and build
  its `core` library. The public C API already fits:
  - host-provided GL proc address, time counter and audio input mix
  - `wp_project_load_folder`, `wp_project_hint_size`, `wp_project_set_output_framebuffer`, `wp_render_frame`
  - live property setters `wp_project_property_set_*` and mouse input
  - media playback-state and album-art notifications
- The scene worker hosts one project, renders into the exported buffer, runs the scene's audio, and obeys the same
  Source controls and gain. The worker's per-output fps is a property; today's launch-only `LweMonitors` fps/primary
  limitation disappears.
- Scene properties become live-settable from the UI later (a natural recipe; not required for parity).
- **Today's scene machinery becomes obsolete**: per-monitor LWE processes, `--screenshot`/grim captures, the reveal-only
  effect gate, `SceneTransitionDelayMs`, `lp-audio` + PID mapping + stream-restore correction, truncated-name and
  cmdline process matching, `_prelaunchPidsToKill`. A scene's `ready` event replaces the fixed load delay.

### 6.2 Web wallpapers — optional module, last
- WE `web` items (5 in the owner's library; currently filtered as "unplayable" by `SteamWorkshopScraper` /
  `WallpaperEngineScraper`) render via CEF using LWE's `webhelper` code, in their own worker. CEF is large (hundreds
  of MB): web support is an optional build module and package. Without it, web items stay hidden as today.

### 6.3 Crash and failure policy
- A worker crash or hang (missed heartbeat): that output keeps its last frame (or the preview image if no frame
  arrived). The worker restarts up to 3 times within 60 s, resuming at the last position.
- After that, the source is marked **broken**: event to the backend, persisted crash record with the scene id, the
  exit signal and the last N log lines. The backend's existing skip/advance logic (`OnSceneCrashed`/`IsSkippedPath`)
  applies.
- Other outputs, videos and audio are never affected.

---

## 7. Upstream tracking layout

```
src/player/                 lp-player compositor (our code)
src/player-workers/scene/   scene worker (our code around LWE core)
src/player-workers/web/     web worker (our code around LWE webhelper/CEF)
third_party/lwe/            linux-wallpaperengine, vendored verbatim at a pinned upstream commit
patches/lwe/NNNN-*.patch    our changes to LWE, one topic per patch, each with a header:
                              Origin: ours | upstream-PR #NNN (author) | upstream-issue #NNN
                              Why: … · Status: candidate-for-upstream | local-only
UPSTREAM.md                 per vendored repo: URL, pinned commit, patch list, how to rebase, last sync date
```

- **Credit for others' work (owner: "cleanly crediting them")**:
  - Every imported upstream change is stored in `git format-patch` form, keeping the original `From:` author, date
    and message, plus trailers:
    - `Upstream-PR: <url>` or `Upstream-Commit: <sha>`
    - `Origin: upstream-PR | upstream-commit | ours`
    - `Adapted-by: livepaper` when modified
  - `CREDITS.md` at the repo root is **generated** from those headers and from `UPSTREAM.md` by
    `scripts/gen-credits.py`, and a test fails when it is stale. It lists, per upstream project: each imported
    change, its author (name + GitHub handle), link, a one-line summary, our patch file and the licence. A second
    section lists techniques adopted from mpvpaper, with upstream file and commit.
  - Upstream `LICENSE`/`AUTHORS` files stay untouched in `third_party/`.
  - The patch headers are GPL-3.0 §5(a)'s "notice that you modified it, with a date".
  - Code merged directly into our own commits carries `Co-authored-by:` trailers.
- **LWE**: vendored, not forked. Catching up = bump the pin → re-apply patches (scripted) → fix conflicts → run the
  scene test corpus (§11). Unmerged upstream PRs worth having are imported as patches with
  `Origin: upstream-PR` and credited in `CREDITS.md`. Candidates seen 2026-10-20:
  - #692 particle "None" on text objects
  - #625 puppet-warp skeletal animation
  - #677 Wayland outputs locked to half refresh
  - #631 hardening binary parsers against malformed Workshop assets
  - #694 PulseAudio capture-stream leak
- **mpvpaper**: absorbed, not vendored (small; its value is techniques). `UPSTREAM.md` records the mpvpaper commit
  last reviewed and which techniques were adopted, with GPL attribution (e.g. the 1.9 `glFenceSync` leak workaround
  if libmpv still needs it). A periodic review of mpvpaper's changelog replaces a code sync.
- `lp-transition` and `lp-audio` are our own code and are retired by this project (their useful parts move into
  `src/player/`).

---

## 8. Documentation (AI-tuned)

- **Path-scoped Claude rules**, one per component (`.claude/rules/player-*.md`, `paths:` frontmatter matching that
  component's directories): purpose, the blocks it implements, invariants, gotchas with measured evidence, how to test
  it. Same style as the existing `player.md`, but kept per component so a model loads only what it touches.
- `docs/player/architecture.md`: the block model, the process model and the recipes (§4), with the invariant first.
- `docs/player/invariants.md`: a short numbered list, each item with *why* and *how it is enforced or tested*. For
  example: never hand off an audible stream; gains are dB; never ramp a percent; worker frames never block the
  compositor; every setting is a live property.
- `docs/player/debugging.md`: a playbook — symptom → which probe or log query shows it → likely cause. Seeded with
  today's findings: audio dropouts, seams, worker crashes, wrong output, NVIDIA buffer import.
- `UPSTREAM.md` (§7). The existing `.claude/rules/player.md`, `CLAUDE.md` and `README.md` are updated at switch-over;
  legacy sections are deleted with the legacy code.
- Docs ship in the same commit as the behaviour they describe.

---

## 9. Debug mode (AI-optimised)

Goal: a model can find out *what happened and why* from text, deterministically, without a human watching the screen.

- **Structured event log**: JSON Lines, one schema, monotonic timestamps (plus wall time), component, level, and a
  **correlation id per operation** (a transition, a source load, a worker restart), so one switch's whole story is
  one filter. Default concise; verbose levels per component. Location under the runtime/cache dir; rotated.
- **`state` query**: the full live graph as JSON — outputs, layers, sources (type, position, speed, loop, ready),
  every gain contribution in dB, clocks, effect parameters, workers (pid, health, restarts).
- **Probes, always available in debug mode**:
  - audio meter per gain node and on the master mix the player produces
  - **dropout detector**: *observed* = the player bus monitor (§5.3). This is real post-server audio, so it catches
    what a gain-schedule check can't: buffer discontinuities, stream-create volume resets, stream-restore poisoning.
    *Expected* = the gain schedule × the sources' own content level. In debug/test mode the content level is decoded
    from the source files at each source's logged positions, the method proven in `lp_audiowatch.py` (fit ±1.5 dB).
    Latency is aligned by cross-correlation; it is constant per stream, and simpler than today's because the bus
    holds only player audio. Flags runs ≥ 2 ms that sit ≥ 35 dB under expected, plus 10 ms bins ≥ 15 dB under.
    Content silence (e.g. an OP's silent tail) is never flagged, because the reference is silent too.
  - frame timing per output (present intervals, missed source frames)
  - seam measurement at handoffs
  - every probe result is also an event, so tests can assert on it
- **Frame capture**: any output, layer or texture to PNG on command, so a model can look at the result.
- **Headless deterministic mode**:
  - offscreen EGL and virtual outputs of given sizes
  - a fake, steppable clock
  - render N frames to image files and audio to a WAV file
  - same inputs give the same outputs, so tests run without a monitor or the owner's session
- **CLI** (`lp-player ctl …`): every command, query and event subscription from a shell, with JSON output.
- **Errors say what failed, with which inputs, and where to look** (doc anchor or log query).

---

## 10. Parity inventory (must all work before switch-over)

Map every current capability to properties/recipes. Today's sources of truth: `.claude/rules/session.md`,
`player.md`, `library.md`, `AppSettings`.

- **Modes**: single apply, Play All playlist, timed playlist (interval), advance-on-video-end, wait-for-video-end,
  combined interval + advance, shuffle (no immediate repeat), random, `--restore`, history prev/next.
- **Keybind actions**: `toggle-mute`, `toggle-pause`, `stop`, `play`, `toggle-play`, `next-wallpaper`,
  `previous-wallpaper`, `random`, `volume-up`/`volume-down` (±5, persisted).
- **Playback settings, all live**: Loop; NoAudio; Volume; Speed; per-item volume/speed overrides (effective =
  override ?? global); VideoScale fill/fit; VideoFps cap; HwDec; DisableCache; demuxer max/back bytes; loudness
  normalisation and target LUFS; AutoMute (+ delays, threshold, MPRIS-only); user mute vs auto-mute semantics.
- **Transitions**: effect list, duration and duration range, shuffle/sequential, per-playlist override vs global,
  enable/disable, and **`TransitionMethod` stays, with all three modes** (owner: some people prefer seeing the very
  last frame of the outgoing wallpaper and the very first frame of the incoming one). In the block model a method is
  just which sides of the transition **hold their frame**:
  - **full-live**: neither side holds; both play through the effect.
  - **reveal**: A holds its frame; B plays live.
  - **frozen**: A holds its frame; B holds its first frame (its clock paused) and starts playing when the effect ends.

  "Hold frame" = the side's source is paused (after its ≤ 30 ms anti-click ramp); its last texture stays on screen.

  **Audio follows the picture** (owner): a side whose frame is held is **silent**; a live side is heard.

  | method | picture | audio |
  |---|---|---|
  | full-live | both play | equal-power crossfade A→B |
  | reveal | A holds its frame, B live | A silent; B's audio **rises with the reveal** (sin curve over the effect) — **(my call)**; the alternative is B at full from the start, which is today's behaviour |
  | frozen | A holds, B holds its first frame | **silent through the effect**; B's audio starts when B starts playing at the end |

  - **On a video-end advance**, full-live *ends* the effect at A's end (as today). Reveal and frozen *start* the
    effect at A's end, so A's held frame is genuinely its **last** frame and A's audio has already ended (owner:
    "reveal ends on A's last frame, nothing to crossfade").
  - **On a manual/early switch**, A's frame is held where it is and its audio stops at that instant.
  - **Anti-click rule**: any audio start or stop at a hold boundary uses a ≤ 30 ms gain ramp. This is not a crossfade;
    it is the minimum that avoids a click, and it keeps the stream-continuity invariant.
  - The silence in frozen mode, and A's silence in reveal, are the modes' meaning, not dropouts. The detector's
    expected model encodes them.
  - Works identically for video, image, scene and web sources.
  - No "reveal-capable effects only" gate: B is a live texture, so every effect works with every method (today's
    gate existed only because B was revealed through transparency).
  - **Today's app differs** and is tracked in `docs/TODO.md`: reveal/frozen video-end advances fire ~effect + warmup
    *before* A's end (A frozen several seconds early); reveal hard-cuts A's audio and starts B at full.
- **Scenes**: AllowScenes, LweVolume, per-monitor fps, primary-output audio, mouse-reactive scenes, scene crash →
  skip/advance.
- **Images** (incl. imported images, zoom-to-fill) as sources.
- **UI integration**: `/current` (path, position, playing), the in-app wallpaper preview synced to the live position
  (`WallpaperBgAllTabs`), events to the UI over the existing WebSocket.
- **Retired with evidence** (not ported):
  - restart daemon / `RestartIntervalSeconds` / `RestartOnSwitchOnly` — after a soak test shows flat RSS and VRAM
  - `TransitionLagOffsetMs`, `SceneTransitionDelayMs`, `LweSilent` (already dead)
- **Compose matrix to verify**:
  - transition × {pure-timed, advance-on-end, wait-for-end, manual next/prev, random, restore, next pressed
    mid-transition}
  - × {V→V, V→S, S→V, S→S, image, web}
  - × {same wallpaper on all monitors} (per-monitor is verified at player level via CLI/headless, not in the UI)
  - × {muted, auto-muted, paused, speed ≠ 1, loop on/off, clip shorter than the effect}

---

## 11. Switch-over bar (my proposal; owner deferred) and testing

Switch the default to `lp-player` and delete the legacy path only when all of these hold on the owner's machine:

1. **Zero dropouts** reported by the built-in detector across the compose matrix (§10), for ≥ 50 consecutive switches
   per mode, and zero visible seams by the seam probe.
2. **Full parity** (§10), with every setting verified live on a playing wallpaper.
3. **Crash isolation proven**: a deliberately crashing scene worker never changes the other output's frames or audio
   (probe-verified), and recovery works.
4. **Soak**: 8 h mixed playlist with flat RSS/VRAM (this retires the restart daemon) and no stuck states.
4b. ~~**Auto-mute reaction ≤ 100 ms**~~ — **PARKED (owner, 2026-10-28)**: auto-mute stays the backend's `AudioMonitor`
    (legacy quick win: ~65–76 ms to first audio); not part of the switch-over bar while parked.
5. **Scene corpus**: the scene test set renders at least as well as current LWE: same set of scenes start, none
   newly blank.

**The owner has approved taking over the live wallpaper session for these batteries** (2026-10-20): starting and
stopping lp-player, 50+ switches per mode, deliberate worker crashes, the 8 h soak. Leave the session in whatever
state the tests end in (project memory "no restore after test"); report results.

Testing approach: headless deterministic tests for blocks and recipes in CI-like local runs; on-machine probe-driven
runs for the matrix; a scene corpus runner (headless render of each scene in `431960` to PNG + a blank/garbage check,
results tracked per scene id).

---

## 12. Order of work and risks

The project is several sub-projects, in this order. Each ships behind a backend setting (**(my call)**
`PlayerEngine: legacy | lp-player`, default legacy) so today's player keeps working until the switch-over bar is met.

0. **Spikes (throwaway, decide feasibility)**
   - (a) build LWE `next-v2` core and render one scene into our framebuffer offscreen
   - (b) share GPU buffers worker → compositor on **NVIDIA proprietary** with correct sync
   - (c) libmpv render in core-profile GL with `volume-gain` crossfade in-process
1. **Compositor + video/image/colour sources**: outputs, layers, effects, gains, animator, clocks, command API, debug
   mode and headless mode, transitions V↔V, per-monitor; backend adapter behind the setting.
2. **Scene worker**: LWE core, dmabuf frames, scene audio as a gain, crash policy; all transitions with scenes.
3. **Programs and Signals in the player**: rotation, advance/wait-on-end, shuffle, history, restore,
   pause-when-covered (the in-player auto-mute Signal is **PARKED**, owner 2026-10-28); retire the timer, monitor and restart daemons, `pending_action.txt` and pid-file ownership.
4. **Web worker** (optional module).
5. **Switch-over**: meet §11, flip the default, delete legacy code and docs (mpvpaper launch path, `lp-transition`,
   `lp-audio`, LWE process management, the related backend code).
6. **Scene compatibility programme** (ongoing): import worthwhile upstream PRs as patches, fix scenes from the
   corpus, track per-scene status.

**Risks and fallbacks**
- *`next-v2` doesn't build or regresses scenes* → the spike finds out first. Fallback: vendor `master` and write a
  thinner embedding patch ourselves (more patch surface).
- *dmabuf sharing unreliable on NVIDIA* → Fallback 1: CPU-copy frames over shared memory (costlier, still isolated).
  Fallback 2: in-process scenes with fast compositor restart (loses isolation; the owner prefers isolation, so this is
  last resort and must be raised with the owner).
- *Desktop-GL port of the effect catalogue* → mechanical; verify every effect renders in headless mode against today's
  output.
- *A worker can starve the compositor's GPU time* (spike: one worker at ~90 % GPU halves the compositor to 120 Hz;
  raising the compositor's EGL context priority had no effect) → Phase 2 needs a **worker GPU budget**: a
  per-worker frame-rate cap tied to its output's refresh, plus GPU-time telemetry with throttling.
- *NVIDIA marks LINEAR dmabufs external-only*, and the compositor's core-profile context lacks
  `GL_OES_EGL_image_external` → Phase 4 must check CEF's export format/modifiers before planning the web worker.
- *Not yet exercised by the spike*: a worker GPU hang, suspend/VT-switch memory purge, several workers/outputs at
  once, DP-1. These go into Phase 2's tests.
- *LWE core needs local patches* (spike: `docs/player/spikes/lwe-core.md`), all in `patches/lwe/`:
  - CMake version detection without `.git`
  - a stray `gmpxx.h` include, and a glm include dir
  - **a host audio-output driver**: the core only offers linear 0–128 volume and a hard mute that also pauses
    decoding, both incompatible with §5.3's dB gains and ramps; est. 150–200 lines
- *LWE renderer failure handling*: the worker must treat a 1×1 project size after the first render as a failed
  renderer build and never call `wp_render_frame` again, which otherwise segfaults. It must also pass the
  assets dir explicitly, because Steam auto-detection fails when WE sits in a secondary Steam library.
- *Scope creep in scene compatibility* → it's the last phase and corpus-driven; it never blocks switch-over beyond
  "no worse than today".

---

## 13. Left to the builder

- The Rust module and crate layout. Rust is **(my call)** for the compositor: memory safety for the part that must
  never crash, and strong compile-time checks for AI-written code. Workers are C++ around LWE.
- Choice of crates/libraries (Wayland client, EGL/GL loader, libmpv bindings).
- Exact wire format and schemas of the Command API, events and logs (JSON lines over a unix socket under
  `$XDG_RUNTIME_DIR/livepaper/` is **(my call)** as the starting point).
- Supervision mechanism details, heartbeat intervals, restart back-off.
- Internal threading model, frame pacing implementation, and sync mechanism details post-spike.
- Test framework and how the scene corpus runner reports.
- Exact split of the Claude rules files and docs pages.

---

## Calls made by the designer (please check)

1. Name `lp-player`; source under `src/player/` + `src/player-workers/`; stays in the livepaper repo.
2. Compositor in Rust; workers in C++. (Owner explicitly delegated the language choice to the designer.)
3. Desktop OpenGL core profile (to host LWE core) instead of GLES.
4. Videos/images in-process; scenes and web in isolated workers.
5. Playlists and rotation move into the player (Phase 3; auto-mute parked), retiring the backend daemons.
6. ~~`TransitionMethod` retired~~ → **owner: keep all three modes**, with audio following the picture (held = silent).
   My calls within that: in reveal, B's audio rises with the reveal; ≤ 30 ms anti-click ramps at hold boundaries.
7. Switch-over bar as in §11, including the 8 h soak that retires the restart daemon.
8. Build behind a `PlayerEngine` setting; legacy stays the default until switch-over.
9. Command API = JSON lines over a unix socket.
10. Web wallpapers as an optional build module, implemented last.
11. Player audio bus (own virtual sink) as the probe tap and the auto-mute exclusion.
12. Per-monitor is a player capability now; the user-facing per-monitor feature is a separate follow-up project.
13. Same wallpaper on N outputs: shared source for video/image, one worker per output for scenes; heard once
    (primary output).
14. Pointer input forwarded to scenes/web for parity with today's mouse-reactive scenes.
15. Packaging scope: flake + `install.sh` only; scene worker builds by default and hard-fails without explicit
    `--no-scenes`; web opt-in.
