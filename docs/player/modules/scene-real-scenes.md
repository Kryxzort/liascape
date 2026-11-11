<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

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
  during a load `_exit(0)`s at once. **Past the bound a load that makes progress stays covered**
  (corpus under load, 2026-11-03): each covered `Ping` samples the renderer thread's CPU time
  (`/proc/self/task/<tid>/schedstat`, first field; the gate is made on the renderer thread); while
  it advanced within the last `bound / LOAD_PROGRESS_DIV` (3 → 10 s) the ping is still answered,
  up to `LOAD_TIMEOUT_MAX_FACTOR` (4) × the bound (120 s) in all. Why: LWE's build is that one
  thread on the CPU (a heavy scene, 2883756643: 3.5–4.9 s of CPU at any load, the worker's other
  threads near 0 meanwhile); on a saturated CPU it waits in the run queue — LWE's core alone
  (`--lwe-smoke`): 6.3 s wall quiet, 21 s at 3 runnable threads per CPU, 28 s at 5 (13.9 s
  queued), so with scenes playing too a fixed 30 s killed a starved load as hung, restarted it
  from scratch (as starved) and broke the scene. A deadlocked load sleeps (its CPU time stops),
  a starved one keeps getting slices (longest gap measured at 5 per CPU: 1.3 s, sampled every
  100 ms); a load spinning forever is still cut at the cap. No schedstat (`None`) = the old fixed
  bound. Test `starved_scene_load_outlasts_the_load_timeout` (bound 1 s, hang timeout 300 ms;
  synthetic `load_busy` — `load_ms` spent as 5 ms bursts every 20 ms: a 2.5 s busy load → Ready,
  0 restarts; asleep 2.5 s → killed as hung within the bound + 1.2 s; busy 6 s → killed at the
  4 s cap; RED with the fixed bound: the busy load killed at ~1.3 s, restarted). Nothing is exported, sent or latched before the build
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
  A sample that **entered** the output (Wayland `enter`, `headless.pointer {entered: true}`)
  goes as `Pointer {jump: true}` → `wp_project_pointer_jump` (fork 0106): WE polls the cursor
  on the whole desktop and never sees a jump, so the scene's `g_PointerPositionLast` takes the
  new position too (cursorripple drew a saturated stroke along it). `ToWorker::Rate {hz}` =
  the outputs' demand (before the GPU budget's cap), on `Ready` and each demand change →
  `wp_project_set_frame_rate` (fork 0105): a simulation effect (cursorripple) steps at it
  whatever rate the ticks arrive at. Probe `workers`: `pointer_jumps`, `rate_sent`. API
  `pointer_enter_is_a_jump_and_rate_is_the_demand`.
- **WE's frame limiter (2026-11-06, decoded from wallpaper64.exe 2.8.485).** The render loop
  (FUN_140141520) sleeps each frame so that `fps` frames fill each second (`fps` = `general.user.fps`
  at window +0x18c, read by FUN_1401461e0; a 1 s budget split over the frames left, `Sleep` in ms,
  QueryPerformanceCounter; 0 = no limit) and presents with `IDXGISwapChain1::Present1(0,
  DXGI_PRESENT_ALLOW_TEARING)` — no vsync wait — so a scene runs at `fps` even above the monitor's
  refresh (DWM shows the newest frame each vblank). The UI slider is 10..`runtime.frequencymax`;
  default 15 (the loader's value when unset; the first-run preset "medium"). (The `clamp(round(1000/fps)
  ·0.5, 6, 100)` FUN_14006dd90 stores is the **audio capture thread's** `Sleep` between reads, not
  the frame limiter.) Ours: `scene_rate` (above) = `scene_fps` uncapped → the tick rate and
  `ToWorker::Rate`; default 15. API `scene_fps_is_wes_rate_above_the_refresh`.
- **The desktop pointer (audit C6, 2026-11-06; `signal/cursor.rs`).** WE reads `GetCursorPos` every
  frame over the whole desktop (other monitors and windows included) → `ScreenToClient` of the
  wallpaper's window ÷ its size (outside 0..1 off it). Ours: on Hyprland, the `lia-cursor` thread
  polls the read-only `cursorpos` request on `.socket.sock` (no Wayland protocol gives a client the
  global pointer; socket2 has no cursor event) at the highest `demand_hz` of the unpaused scenes —
  parked (no requests) when there is none; a reading is published only when it moved, so the
  loop's check is one atomic load. `Runtime::pointer_events` → `desktop_pointer_forward`: the point
  through each output's `OutputBackend::desktop_rect` (xdg-output logical position/size; headless:
  `pos`) into its pixels (`cursor::desktop_to_output`), then the layer's fit **unclamped**
  (`scene::pointer::to_source_uv_unclamped`: on the other monitor it lies off the scene); a scene
  on several outputs takes the one the cursor is on, else its first by name. It runs on a new
  reading, a button change, or every `cursor::REFRESH` (250 ms: places new scenes, re-derives the
  rate). A scene's first position is a jump; nothing else is (no enter jumps while it reads). The
  surface's samples then give only the buttons (OR over outputs; a press is seen only over the
  bare desktop) and still set `out:<c>.pointer`. **Fallback:** no reading yet / a failed request
  (no socket, Hyprland gone; retried every 2 s) / not Hyprland → the surface pointer as before,
  its next sample a jump (`pointer.desktop_lost`). `LIASCAPE_PLAYER_POINTER_SOURCE` = `hyprland` |
  `surface`; default Hyprland on Wayland when `HYPRLAND_INSTANCE_SIGNATURE` is set, surface
  headless. Events `pointer.source`, `pointer.desktop`, `pointer.desktop_lost`; probe **`pointer`**
  `{source, in_use, ok, reason, rate_hz, pos, polls, changes, fails, request_us_mean, forwards,
  jumps}`. Cost (owner's machine, 240 polls/s): `lia-cursor` ~1.4 % of a core, Hyprland ~0.6 % (audit "Frame
  limiter and desktop pointer result"); none while every scene is paused. API
  `desktop_pointer_from_a_fake_hyprland`; units in `signal::cursor`, `scene::pointer`.
- **Visualiser input (D4: all system audio, as a mix of streams — `audio/sysmon.rs`).**
  `SysMon::start()` (thread `lia-sysmon`, own PipeWire loop) taps every `Stream/Output/Audio`
  node `admit()` lets through — **the plug point for a per-app white/blacklist**; today all but
  loopback halves (`node.virtual`, which would double-count, e.g. our bus playback) — with a
  passive capture `liascape-player-visualiser.<id>` (`target.object` = its serial,
  `node.dont-reconnect` + `node.dont-fallback`: never the microphone), keeping its last
  `RING_FRAMES` (4096) **stereo** frames on the graph clock (`Ring::push`: `pw_buffer.time` → a 48 kHz frame
  index; a buffer within a quantum of the ring's end continues it, a skipped one leaves silence, a jump back starts
  over). `visual_since(cursor)` mixes the streams that delivered within 150 ms **by their place on that clock**
  (`Mix::advance`: up to the oldest stream's end, never more than 4096 frames behind the newest — a buffer late this
  cycle is summed in place next time; ±1 per channel) into one stereo stream (`MIX_FRAMES` 8192 kept) and returns the
  frames after the reader's cursor (a first read: the newest 2048). Read-only, no routing changes; a lost connection
  retries every 1 s. The runtime (`feed_visualisers`, start of `update_sources`) runs it only while ≥ 1 ready scene
  `wants_audio_input`; each such scene source keeps its own cursor and appends what it gets (newest
  `AUDIO_INPUT_MAX_FRAMES` 4096), sent with its next `Tick.input` (`AudioInput`; others get `null`); the monitor is
  dropped on a helper thread when none wants it. The worker accumulates the ticks' frames and pushes them to LWE in
  order (`wp_context_audio_input_push`, 2 channels, 48 kHz); the synthetic `input_level` draws their RMS
  (`input_level()`). Probe `workers` → `wants_audio_input`, `input_dbfs`. Units
  `admit_takes_app_playback_streams_only`, `visual_mix_is_stereo_and_clock_aligned`, `ring_follows_the_clock`,
  proto `audio_input_keeps_both_channels`. Deviation from the plan's text: streams playing to a non-default sink are
  mixed too (WE's "everything that plays").
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
