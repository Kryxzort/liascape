<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

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
- **Audio response** (`patches/lwe/0045`, B8): `wp_context_audio_input_push(ctx, f32 interleaved, frames, channels,
  rate)` feeds WE's spectrum (`g_AudioSpectrum*`, `engine.registerAudioBuffers`, audio-driven emitters);
  `wp_context_audio_spectrum(ctx, 16|32|64, 0 left|1 right|2 average, out)` reads it. The worker pushes the
  system audio it gets in each `Tick.input` (48 kHz stereo, every frame in order: `Scene::push_input`, render thread,
  before the frame) — Left and Right apart (the Leftovers batch; the legacy u8 `wp_audio_input_mix` is unused).
  Smoke: `--lwe-smoke … --tone HZ` feeds a synthetic sine the same way (nothing plays); `--tone-channel left|right`,
  `--tone noise` (white, −6 dBFS RMS), `--tone-sweep HZ1`; the JSON's `spectrum` = the 16-band left/right the scene saw.
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
  `LIASCAPE_WE_ASSETS_DIR`; RED on c3a7d68); `HOST_API_TEST_ONLY=<substring>` runs a subset.
  **0022 (2026-11-02, batch B2): object alpha/colour live, `g_Color4` = (colour, alpha)** (audit E2, E3).
  `CPass::setupUniforms` binds `g_Brightness`/`g_UserAlpha`/`g_Alpha`/`g_Color`/`g_Color4`/`g_CompositeColor`
  by address (passing the `const T&` getters picked the by-value overloads: frozen at setup); `CImage` keeps
  `m_color4` = (colour, alpha), refreshed every `render()` (it was the colour value's own w: 1, or 0 after a Vec3
  write). **0023: keyframe animations play** (G01, G02): `PropertyAnimation` (`Data/Model/`, decoded from
  wallpaper64.exe 2.8.485 — the commit message has the addresses) parsed by `DynamicValueParser::parseAnimation`
  for any value with `animation` (object properties and effect constants alike); the values parsed while a scene
  is parsed are listed on `Scene::animatedValues` (an `AnimationCollector`, with each value's alive flag) and
  `CScene::advanceAnimations` advances + writes them every frame **before** the script tick (`UpdateSource::
  Animation`). Bezier per segment: control points (A.front.x/2, A+front.y), (1+B.back.x/2, B+back.y), x solved by
  ≤ 24 Newton/bisection steps; `step` holds; whole frames blended linearly; `loop`/`mirror`/`single`,
  `startpaused` (never advances — no `getAnimation` yet, B10), `wraploop`, `relative` (only an "x y z" string
  value adds). Not done: `timeofday`, `options.parent`/`children`, `random`, events, the SceneScript animation
  API. `host_api_test`: `object_uniforms_are_live`, `keyframes_drive_alpha`, `keyframes_move_origin` (white
  squares — a colour string without a '.' is 0..255 — red channel = alpha × 255; the first ships its own
  `g_Color4` shader in the scene folder; RED on 8902c4a).
  **0024–0028 (2026-11-03, batch B3): particle core semantics** (audit P1, P3–P8, P13, P14, P16, P18, P19, P38;
  "B3 result" in its § 5). **0024:** one particle RNG per scene (`CScene::getParticleRng`, WE's scene+0x1f08);
  `randomframe` = one draw from it (it was seeded by the slot address); `WPENGINE_PARTICLE_SEED` seeds it. **0025:**
  `colorrandom` = one `t` for R, G, B; `exponent` (`pow(rand, e)`) in lifetime/size/colour/alpha/velocity/
  rotation/angularvelocity random; lifetime ≥ 0.001 s. **0026:** `starttime` (a float) prewarms on setup in
  0.05 s steps (0.2 s from maxcount 500), at least one step; the `rate` override = the system's playback speed
  (`dt *= max(rate, 0.01)`: motion, ageing, emission); `count` multiplies every emitter's rate (+ a mapsequence
  count) unless flags 0x20, and the pool stays `maxcount`; the overrides are read live (alpha and size still
  apply at spawn, as in WE); box and sphere share one emitter timer (delay, duration, periodic windows that
  reload the burst; the burst adds to the frame's emission); a hidden system with particles is cleared and its
  emitters reloaded (shown again = fresh, bursts replay, no 0.1 s catch-up); operators run on the system's own
  clock (`m_simTime`, prewarm included). The 0.1 s dt cap stays (P37, B11). **0027:** `colorn` = an HSV shift of
  colorrandom's min/max by (colorn − the system's reference colour: first colorrandom mid-point, else colorchange
  start, else white), only when set, flags lack 8 and it differs by ≥ 0.9/255; a system without a colour source
  spawns at colorn; re-evaluated every step. **0028:** `SPRITESHEETBLEND` unless particle flags bit 1 or
  `randomframe` (`SPRITESHEETBLENDNPOT` not done). `host_api_test`: `particle_count_rate_and_prewarm`,
  `particle_colorrandom_one_t`, `particle_colorn_hsv_shift`, `particle_hide_resets_and_overrides_live` (additive
  8/255 or 4/255 grey stacks at fixed points of a 64×32 scene, so the red channel counts particles; need
  `LIASCAPE_WE_ASSETS_DIR`; all RED on d4969e4).
  **0029 (2026-11-03, batch B5): parallax and camera as in WE** (audit G10–G12, G14/E1, G15–G19; "B5 result" in its
  § 5; decoded: camera update GH 0x1401b8af0, render-loop offset GH 0x1401b9b50, shake GH 0x1401c7680, zoom in the
  tick GH 0x1401afbf0). `CScene::updateCamera` (each frame, before animations and scripts): the parallax target
  `(W·(0.5(1−infl) + mx·infl), H·(0.5(1−infl) + (1−my)·infl))` (pointer clamped 0..1, y up) + the camera position,
  eased by `k = min(1, (1 − delay/3)·10·dt)` (delay ≤ 0 snaps; the delay was read as a bool → k = 0, 14 of 25
  scenes frozen); the position starts at the centre. `CScene::getParallaxOffset(object)` = `(root.origin − pos)·
  amount·root.parallaxDepth` (root = topmost ancestor; depth 0 stays; `parallaxDepth` defaults to 1 1 and every
  object has one, `ObjectData::groupParallaxDepth`), zero while `cameraparallax` (live) is off; CImage/CParticle
  translate by it in the world (y flipped: LWE's world is y down). `g_ParallaxPosition` = pos / size, clamped 0..1
  (0.5 0.5 at the start, frozen while parallax is off). `Camera::setViewAdjust`: `getLookAt()` = the lookAt ·
  scale(`general.zoom` × the active camera object's `zoom`) · translate(−shake); the active camera object = the last
  `"camera"` object that is visible with visible parents (`ObjectData::cameraZoom`). Shake: `(cos t, sin 1.333t)`,
  `t = speed²·g_Time`, length^(roughness³) unless ≤ 0.001 or 1, × amplitude·0.01·H. fov/nearz/farz come from
  `general` (the 2D ortho keeps its 0..1000 depth); WE's defaults (amount 0.5, delay 0.1, influence 0.5; shake
  3 / 0.5 / 1). Not done: a camera object's origin (pan), camera paths, `g_EffectTextureProjectionMatrix` (E6),
  CText ignores the offset (B4). **The worker keeps LWE's pointer at the scene's centre until the host sends one**
  (`lwe::Scene::first_render`; `pointer: Option` in main.rs) — at (0,0) a parallax scene sat pulled to a corner.
  `host_api_test`: `parallax_follows_the_pointer`, `parallax_position_uniform`, `camera_zoom_and_shake` (8×8 squares
  on a 64×32 scene, a fake `wp_mouse_input`; all RED on 93438d4).
  **0030 (2026-11-03, batch B6): the hierarchy as in WE** (audit G03, G04 particles, P36, G31; "B6 result" in its
  § 5; decoded: effectively visible GH 0x1401b50e0, image model matrix GH 0x1402277d0, alignment offset GH
  0x140230a80). `CScene::isEffectivelyVisible(object)` = its own `visible` AND every ancestor's (groups read
  `groupVisible`), live; CImage, CText, CParticle (render + the hidden-system reset) and the active camera object
  ask it. `CImage::shouldRenderFinalPass` no longer reads the visibility: it is decided once while the passes are
  built, so an image hidden at load (itself or a parent) sent its last pass into an FBO for good and never showed
  when a property or script turned it on. `CObject::resolveTransform`/`localTransform` (moved from CImage; a
  particle's own scale/angles now count) give a particle system its origin, scale and z angle under its parents,
  resolved every frame (`CParticle::refreshTransform`: a moving, animated or scripted parent or origin carries the
  system; world-space control points stay put); its own x/y angles stay its own. An aligned image turns and scales
  about its origin (`m_scenePivot`), not the shifted quad's centre. Not done: text parent transforms (CText, B4), a
  sound object under a hidden parent. `host_api_test`: `hidden_parent_hides_children`, `particle_follows_its_parent`,
  `aligned_layer_turns_about_its_origin` (all RED on 9f64193).
  **0031–0036 (2026-11-03, batch B9): small uniform, property and shader fixes** (audit "B9 result" in its § 5).
  **0031:** `g_Frametime` (`Context::frameTime`, the frame's dt), `g_PointerState` (`CScene::getPointerState`: xy 1
  while the left button of the host's `wp_mouse_input` is down, z 1 on the press frame), `g_Daytime` and
  `engine.timeOfDay` (`Context::daytime`, the local wall-clock time of day in [0, 1), every frame), `g_Time` =
  `Context::shaderTime` (renderTime wrapped at 432000 s, as WE). **0032:** the bloom passes' `bloomstrength`/
  `bloomthreshold`/`bloomtint` constants are `connect`ed to `general`'s values (live; `bloomtint` parsed, default
  1 1 1); the bloom image is built when `bloom` is on or bound to a user property and the render loop skips it while
  off (read per frame); a build failure is logged, not fatal. **0033:** uniform annotation defaults: a string float is
  that float, a number vector broadcasts, an int string never throws; malformed `[COMBO]` JSON stays skipped (WE's
  parser is strict too). **0034:** `ShaderUnit::applyFragmentVaryingDeclarations` declares in a fragment unit each
  varying it uses that only its vertex unit declares. **0035:** a textinput default has no JSON quotes; the
  property listing lists it (`WP_PROPERTY_TYPE_TEXT_INPUT` 8, `wp_project_property_text_input`); combo values keep
  non-integer numbers; `WP_PROPERTY_TYPE_FILE` is 5 (was 4 = BOOLEAN). **0036:** `CPass::userTextureName`: a
  non-system usertexture is its scenetexture property's value (at pass build; empty → the slot's fallback, no log).
  `host_api_test`: `engine_uniforms_are_fed`, `bloom_is_live_and_tinted`, `annotation_defaults_parse`,
  `fragment_gets_vertex_varyings`, `properties_list_as_written`, `usertexture_reads_its_property` (a solid layer with
  its own `b9` shader; all RED on 602de79, built against the new headers).
  **0037 (2026-11-03, E41): effect `visible` is live.** `CImage` builds every effect that can be visible
  (`effectCanBeVisible`: true now, bound to a property, or scripted), tags each pass with its effect
  (`m_passEffects`; base/tint/colour-blend passes nullptr) and keeps its built blending (`m_passBlending`).
  `render ()` compares the effects' `visible` with the chain's (`effectVisibilityChanged`) and on a change calls
  `updateActivePasses` (the running passes in `m_activePasses`, blending reset then moved first → last running pass,
  main/sub FBO reset, `setupPasses` over them). A script on an effect's `visible` is queued as
  `effect_<id>_<index>_visible_<object>`. A passthrough layer with no visible effect returns early. Hidden effects
  that can't compile now log "Leaving out effect" at load (they did nothing before either). `host_api_test`:
  `effect_visible_is_live` (two chained effects bound to bools toggled both ways; RED on 94cfc2e).
  `--lwe-smoke … --prop-at T name=value` without `--audio-dump` now sets the property `T` s into the frames and
  writes `lwe-smoke-before-<T>s.png` first.
  **0038–0044 (2026-11-03, batch B10): the SceneScript API.** `ScriptableObjectAdapter` keeps one JS object per
  layer (`m_instances`; unknown names go to a per-layer `extras` object) and has ILayer methods (`getEffect`,
  `getTextureAnimation`, `getParent/getChildren`, `getAnimation`, sound `play/stop/pause/isPlaying`) plus the classes
  IEffect, ITextureAnimation (`CRenderable::detachTextureAnimation`: the layer's own clock, `CPass` reads
  `getTextureAnimationTime`) and IAnimation (`PropertyAnimation::play/pause/stop/…`). Groups/camera objects are
  `Objects::CGroup`, `CSound` is a `ScriptableObject`. `CScene::getLayers` (scene.json order) backs
  `getLayer (n)`/`enumerateLayers`/`sortLayer`. `Scene::scriptsReachEffects` (the scene JSON names `getEffect`)
  builds every effect; `Scene::usesMedia` answers `wp_project_uses_media`. `ScriptEngine::dispatchEvent` reaches
  property modules and text layers (`__textLayers[id]._events`); text scripts' `thisLayer` is the real layer.
  Effect-visible scripts get `thisObject` = IEffect (`LoadedModule::effect`); shader-constant scripts are queued
  as `effect_<id>_<i>_pass_<n>_<name>_<object>`. Cursor: `CScene::updateCursorEvents` after the script tick →
  `CImage::hitTest` (drawing space: parallax/rotation undone, not the zoom) → `ScriptEngine::cursorFrame`
  (enter/leave/move to all solid hits, down/up/click to the shown ones). localStorage: builtins.js over
  `__storage.read/write`, flushed after a tick, file `<storage dir>/<workshop id>.json`. New C API:
  `wp_project_notify_track_metadata_extra`, `wp_project_notify_media_status`, `wp_project_uses_media`,
  `wp_config_set_storage_dir`. Worker: `media.rs` (thread `lia-scene-media`, MPRIS over the session bus once a
  second, only for `wp_project_uses_media` scenes, `LIASCAPE_SCENE_MEDIA=0` off; http(s) art fetched once with
  `curl` into `$XDG_CACHE_HOME/liascape/media-art`), applied in `lwe::Scene::render`; storage dir
  `LIASCAPE_SCENE_STORAGE_DIR` else `$XDG_STATE_HOME/liascape/scene-storage` (`--lwe-smoke`: `<out>/storage`).
  `cargo run --example fake_mpris -- <state.json>` is a fake MPRIS player for media smokes (run it under
  `dbus-run-session`). `host_api_test`: `layer_api_reaches_layers`, `script_effect_and_property_changes`,
  `text_script_is_a_real_layer`, `media_events_reach_scripts`, `effect_script_this_object_is_the_effect`,
  `script_plays_a_keyframe_animation`, `cursor_events_reach_layers`, `local_storage_persists`,
  `script_controls_a_sound` (45/45).
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
  [--prop name=value]… [--prop-at T name=value]… [--pointer X0,Y0:X1,Y1]`** (`--prop`: a user property before the build, like
  `scene_props`; `--prop-at`: set T s into the dump, live; the dump renders at 30 fps of scene time meanwhile,
  so 0018's playlists advance; `--pointer`: a scripted pointer, native scene px y down as the host feeds it, in a
  straight line from the first point at frame 1 to the second at the last — for a trail / cursor-follow
  direction, 2026-11-04) renders a
  real scene offscreen (frames at 30 fps of scene time, paced to the wall clock: libmpv decodes video
  textures in real time, so an unpaced run showed 3426575339 / 3432876246 / 3556794116 black; `--unpaced`
  for the old as-fast-as-possible run), writes `lwe-smoke-1s.png`/`-3s.png`
  (upright, opaque) and prints one JSON line (`native`, `load_ms`, `build_ms`, `frame_ms_*` with a
  `glFinish` per frame, `lit_pixels`, `changed_pixels_1s_to_end`, `gl_error`, `audio_driver`,
  `audio_streams`, `audio_peak` of 0.5 s pulled); exit 0 = rendered and animating. It also writes
  **`<out>/health.json`** (2026-11-04): unless `WPENGINE_HEALTH` is already set (then the caller owns that file, raw),
  the smoke sets it to `<out>/health.jsonl` before the load and gathers the core's records (fork patch 0061, § "Scene
  health") into `{scene, smoke (its JSON line or error), events, counts}` — on a failed load too. Measured
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
