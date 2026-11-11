# The `scene` source kind

Covers `src/player/src/sources/scene.rs` (`SceneSource`), scene handling in `sources/host.rs`, `scene/assets.rs`,
`scene/pointer.rs`, `signal/cursor.rs` and the visualiser half of `audio/sysmon.rs`. Rules:
`.claude/rules/player/scenes.md` § The `scene` source kind, § Transitions with scenes. Process side:
[scene-worker.md](scene-worker.md); crash handling: [scene-crash-policy.md](scene-crash-policy.md).

A scene is a graph `Source` like any other (`create {kind: source, props: {kind: scene, path: <item folder>, …}}`):
the transition recipe, aliases, snapshot and adapter stay kind-agnostic; only places that meant "can be heard" or
"never ends" learned about scenes (`onset::kind_has_audio`, `never_ends`).

## Opening and demand

`SourceHost` opens a scene on the loop, never the `lia-open` pool (no core to make, and the worker's PDEATHSIG
follows the spawning thread). A non-synthetic scene without a resolved WE assets dir fails at open with the
resolver's hint and spawns no worker — never a 1×1 render loop.

Every `sync` ends with each scene's demand (`host::demand_for`: the outputs from `Graph::outputs_of`, i.e. where
`srcs:` holds it — shown or held by a transition), cached per `Graph::demand_rev`: recomputing it per sync (once per
worker frame) was the top of the compositor's profile mid-transition. The worker is spawned at the first demand
that names an output, so its ring is exported at the right size; a node created but not shown has no worker.
`max_size` = the largest width and height over those outputs (a change sends `Resize`, re-exported without a black
frame). With every output unplugged (parked) nothing changes.

**Rates.** The scene ticks at the highest `scene_rate(scene_fps, refresh)` over its outputs: `scene_fps` is WE's
`fps` (default 15, 0 = the refresh) and is not capped by the refresh — WE's own render loop sleeps so that `fps`
frames fill each second and presents without waiting for vsync, so a scene runs at `fps` even above the monitor's
refresh. Each output presents its frames at most at `eff_fps(scene_fps, refresh)` (≤ its refresh;
[scene-gpu-budget.md](scene-gpu-budget.md)). `ToWorker::Rate` tells LWE the demand so a simulation effect
(cursor ripple) steps at it whatever rate ticks arrive at.

## Clock, Ready, pause

- **`SceneClock`:** scene seconds advancing at `speed`, paused intervals excised, starting only once the load's
  first frame is shown (like a video's `time_pos`, nothing passes while the worker starts). A live `position` set
  jumps it. `Tick.t` is the clock at send; `time_pos` reads it.
- **Ready** = the load's first latched frame, at exactly `position`: before it exactly one tick is sent, paused or
  not. One `Ready` per load; a worker restart is not a load, a `path` change is.
- **Pause** (the effective one: node, player, holds) stops ticks and latching at once — a frame in flight at the
  pause never latches, so the held texture is exactly the one shown when it applied. A paused mpv video still
  presents 2–3 queued frames; a paused scene doesn't, which is why only videos need the recipe's snapshot to freeze.
  A `position` set while paused ticks once at the new time.
- **`path`** (live) = a new worker on the new folder (the old frame stays until the new one latches), clock back to
  0, `Ready` again — not a crash.
- **Stepped mode:** no self-ticking; `step_to(t)` sends one tick at `t`, and the step is done when the latched
  frame's seq ≥ that tick's seq. Never compare `t`: it crosses JSON twice and serde_json's float parsing can land an
  ulp off (a step at `t = 0.192` never finished).
- `AudioFlowing` comes from the worker's stream ([scene-audio.md](scene-audio.md)), at once when the scene has no
  sound or the clock is stepped.

Prop semantics: `kind` change and `color` → `unsupported`; `loop`, `hwdec`, `fps_cap`, `cache`, `demuxer_*`, `af`,
`audio_delay`, `preview` are stored only; `gain.*`, `no_audio` and `speed` drive the worker's stream. Observed:
`ready`, `time_pos`, `duration` 0, `width`/`height` (export size), `has_audio` (from the worker's `Ready`, `true`
until then), `loading`, `broken`.

## Transitions with scenes

A scene B is held in `srcs:` by its transition, so its worker spawns at `start`; opened paused it readies with its
first frame. reveal/frozen hold a scene A by a snapshot of its latched frame. A scene is never a still but never
ends: `align: end` on a lead A that is a scene starts now (it has no duration and no `Ended`, so it used to wait out
`ALIGN_SLACK`), and the parked path hands off at once. A crash mid-effect holds B's frame and restarts it; a B that
breaks mid-effect fails the transition and snaps back.

A slow scene load is waited for: `WaitingReady` fails a B with no first frame at `READY_TIMEOUT` (10 s) unless its
observed `loading` is true, then up to `LOADING_READY_TIMEOUT` (50 s), with A playing untouched. 50 s sits under the
backend's own 60 s wait, so the backend gets the player's verdict. A heavy scene's load measured 7 s quiet and
13–20 s with 24–48 CPU-bound threads; scenes already playing kept their frame rate while it loaded. Running the
load at a lower CPU priority would only stretch it ~10× under contention, so it isn't done.

Test gotcha: a worker's first frame takes > 100 ms (its EGL setup alone), so an interrupt chain with plain 100 ms
gaps only ever supersedes; choose gaps by condition.

## Assets, properties, inputs

- **WE assets dir** (`scene/assets.rs`): the first dir holding `shaders/genericimage2.vert` among
  `player.scene_assets` → `LIASCAPE_WE_ASSETS_DIR` → each Steam root and every library its `libraryfolders.vdf`
  lists → `<lib>/steamapps/common/wallpaper_engine/assets`; the error names every candidate tried.
  `player.scene_assets` is live (`Runtime::update_scene_assets`; observed `scene_assets_resolved`). The `scene`
  capability = the worker resolves and (assets or synthetic scenes allowed); `liascape-player scene-check` prints
  the same verdict plus whether the worker was built with LWE.
- **User properties:** `scene_props` (a map) goes as `Start.properties` (applied after load, before the first
  frame) and live as `SetProperty` per changed entry, typed by JSON shape (bool, number, `[r,g,b(,a)]` 0–1,
  string). A removed key keeps its value until the scene reopens — LWE has no reset, so the backend sends defaults
  explicitly.
- **Pointer.** Surface samples go through each scene-showing output's `fit_rect` inverse (`scene::pointer`;
  nothing in a letterbox bar) into native scene px, y down. A sample that entered the output is a jump
  (`wp_project_pointer_jump`): WE polls the cursor over the whole desktop and never sees one, so a stroke from where
  it left would draw. LWE's pointer stays at the scene centre until the first sample (at 0,0 a parallax scene sat
  pulled into a corner).
- **Desktop pointer** (`signal/cursor.rs`): WE reads `GetCursorPos` over the whole desktop every frame, other
  monitors included. On Hyprland `lia-cursor` polls the read-only `cursorpos` request (no Wayland protocol gives a
  client the global pointer) at the highest demand of the unpaused scenes, parked when there are none; the position
  goes through each output's desktop rect and the layer's fit unclamped (off the scene on another monitor). The
  surface pointer then only contributes buttons. No reading, a failed request or not Hyprland → the surface
  pointer, its next sample a jump. `LIASCAPE_PLAYER_POINTER_SOURCE=hyprland|surface`. Cost at 240 polls/s:
  `lia-cursor` ~1.4 % of a core, Hyprland ~0.6 %.
- **Visualiser input** (`sysmon`): every application playback stream `admit()` lets through (the plug point for a
  per-app list; loopback halves with `node.virtual` excluded, they would double-count) gets a passive capture that
  never reconnects or falls back (never the microphone). Each keeps `RING_FRAMES` stereo frames placed on the graph
  clock; `visual_since` mixes the streams that delivered recently by their place on that clock into one stereo
  stream. The runtime runs it only while a ready scene `wants_audio_input` (project.json
  `general.supportsaudioprocessing`); each such scene keeps its own cursor and gets its frames with its next tick,
  which the worker pushes to LWE in order. Streams playing to a non-default sink count too (WE hears everything
  that plays).
