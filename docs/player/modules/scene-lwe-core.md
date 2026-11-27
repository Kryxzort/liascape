# LWE core in the scene worker

Covers `src/player/src/bin/liascape-scene-worker/lwe.rs` and `render.rs`, `src/player/src/scene/fonts.rs`, `src/player/build.rs`'s LWE link,
`scripts/lwe.sh`, `patches/lwe/` and `third_party/lwe/`. Rules: `.claude/rules/player/scene-lwe.md`, `.claude/rules/player/scenes.md` §
Corpus and health tooling. The pin, the patch series (one row per patch with its why) and the resync recipe live in
`UPSTREAM.md` § linux-wallpaperengine — not repeated here.

The worker renders Wallpaper Engine scenes with the core library of linux-wallpaperengine's `next-v2` branch, from
the owner's fork plus the `patches/lwe/` series.

## Where the core comes from

`third_party/lwe/PIN` → the flake's `lwe-src` (a fixed-output fetch of the fork at `rev`, submodules included) →
`lwe-core` (CMake, the `linux-wallpaperengine-core` target only — `all` would build the GLFW viewer and CEF objects)
= `lib/liblinux-wallpaperengine-core.so*`, its headers and `REV`. The package and the devShell set
`LIASCAPE_LWE_CORE_DIR` to it. Outside Nix, `scripts/lwe.sh fetch prepare build` does the same under `build/`;
`install.sh` copies the `.so` into `<prefix>/lib/liascape/` and builds the worker with
`LIASCAPE_LWE_RPATH='$ORIGIN/../../lib/liascape'`.

A `LWE_DEV_SRC` build has `REV` = `dev:<dir>`, which `core_is_the_pinned_one` skips. A fork commit not pushed yet can
still satisfy the flake's fixed-output fetch: build the exact tree, check `nix hash path` equals the PIN's `nix_hash`,
and add it with `nix-store --add-fixed --recursive sha256` (only that machine builds until the branch is pushed). The
headers use struct tags as type names, hence the hand-written C calls in `lwe.rs`.

## The host API the worker relies on

- **Audio without a device.** `wp_config_set_audio_output` before `wp_context_create` gives a `HostAudioDriver`: no
  SDL audio, no device. `wp_context_audio_pull` returns the mix of every stream at its sound object's `volume²`, F32
  interleaved, always the frames asked for, and never waits for decoding (an empty queue is silence), so the worker
  may call it from its RT callback. Not pulling = paused; frames pulled per second of the host clock = the speed,
  which is how the worker's stretch scales audio with the scene. `wp_context_audio_stream_count` counts sound
  objects that can play (one slot each for life, including one held at volume 0) — 0 until the first
  `wp_render_frame`. Stop pulling before `wp_context_destroy`. A mono source reaches each stereo channel at −3 dB.
- **Sound objects play by Wallpaper Engine's rules** (decompiled: `docs/player/spikes/we-sound-semantics.md`): one
  random file per start, `loop`/`random`/`single` modes, `volume²` live from user properties, the schedule on the
  host's render time (so it follows the worker's clock, speed and pause). `WPENGINE_SOUND_SEED` makes picks
  deterministic. The offline estimate models the same rules ([scene-loudness.md](scene-loudness.md)).
- **Video textures** decode with FFmpeg (a `wp-video` thread each, no audio) into their texture through one
  YUV → RGB draw (`GLPlayer`). They play on the scene clock (the context's render time: the host's speed and pauses),
  loop without a gap and keep IVideoTexture's controls. A pass plays the videos in its slots (the scene, each image's
  own); a video file's path in a slot streams that file (MP4 or Matroska only). Decoding starts as the build creates
  the texture and a player's first render waits ≤ 500 ms for its first frame, so the first picture shows the videos.
  The worker gives the core the compositor's interop (`hwdec_interop_for`) and `hwdec` list (`mpv_hwdec`), or `no`
  with copy modes (`wp_context_set_video_hwdec`); the core opens only the devices the list leads to, once per process: CUDA on the
  GPU's primary context, shared by every video. With the `cuda` interop a CUDA frame reaches the plane textures on the
  GPU (`cuGraphicsGLRegisterImage`, libcuda by soname: the worker loads it first, `cuInit` beside the build); other
  hardware frames go through memory, a stream the hardware refuses decodes in software. Two 1080p videos: 446 MiB,
  `source.ready` ~290 ms with both in it. The worker quits with `_exit` (libcuda's exit
  handler frees the context under the decoder threads).
- **Scripts.** Property scripts and SceneScript run in LWE's QuickJS, with WE's own JS classes read from the assets dir.
- **Visualiser input:** `wp_context_audio_input_push` feeds WE's spectrum from the system audio the worker gets in
  each `Tick.input`, left and right apart. **Pointer:** `wp_mouse_input`, `wp_project_pointer_jump`,
  `wp_project_set_frame_rate` (the demand). **Media:** scenes that use media events (`wp_project_uses_media`) get
  MPRIS state from `lia-scene-media`; localStorage persists under `LIASCAPE_SCENE_STORAGE_DIR` (default
  `$XDG_STATE_HOME/liascape/scene-storage`).
- A project whose renderer build threw renders nothing ever again (no crash on the next call); a missing project
  file loads NULL.

## Rendering a real scene (`render.rs`)

`check_folder` first (on the preload thread: [scene-worker.md](scene-worker.md) § The worker binary): a missing dir
or no `project.json` is a fatal `load failed`. Then load (NULL → `load failed`), apply
`Start.properties`, `first_render` into a 1×1 scratch FBO (≤ 1 → `renderer build failed`), a native-sized FBO for
LWE (its final quad sets `glViewport(0,0,sceneW,sceneH)`), the ring at `cover_size`, then `Ready {native,
has_audio, wants_audio_input}`. Each frame renders into the native FBO and `glBlitFramebuffer`s into the slot (scissor
off first — LWE leaves its state), no flip, alpha forced to 1. Every failure is fatal: no restart, no crash record.

The worker's log tail says where a load went: `gfx: context … in E ms` (the EGL setup before `Hello`) and `lwe:
loaded <dir> in A ms, built in B ms (… ms in all; preloaded, waited W ms)` (A = context + project load, run beside
the EGL setup, W = what the `Start` still waited for it, B = the renderer build with its first frame).
`src/player/tests/onmachine/scene_load.py` times a whole apply (create → `source.ready`) cold, warm and after a boot.

## Texture uploads

NVIDIA converts a texture's pixels on the CPU of the thread that calls `glTexImage2D` (~1.6 GB/s): on the render
thread a scene's large JPEG / PNG textures cost their whole conversion before the first frame (~160–200 ms on large
scenes). With a core that has `wp_context_set_gl_upload_context` (looked up at run time), `lwe::Scene::set_upload_context`
hands LWE a `gfx::ShareRecipe` (this context's priority and robustness — EGL refuses to share across reset
strategies). LWE's `wp-tex-upload` thread starts once a scene's deferred JPEG / PNG images reach 64 MB
(`TextureUploads::kStartBytes`; below that it costs more than it saves) and makes the shared context there (~20–30 ms
the render thread would otherwise pay). Each upload returns a fence that `finishUpload` `glWaitSync`s on the GPU
before the texture is first sampled; DXT and raw textures upload where they are created. Measured warm first frame:
571 → 480 ms and 468 → 426 ms on two large scenes.

## Shader cache

`wp_config_set_shader_cache_dir` (fork patch) keeps the core's shader text work across launches: each shader unit's
WE text passes (`ShaderUnit::compile`, kind `unit`) and each vertex + fragment pair's translation to GLSL 330
(`toGlsl`, kind `glsl`) — pure functions of their input texts that a scene repeats at every launch and many times per
build (one large scene: 253 programs, 68 distinct). The worker points it at `$XDG_CACHE_HOME/liascape/lwe-shaders`
(`gfx::shader_cache::lwe_dir`; `LIASCAPE_SCENE_SHADER_CACHE_DIR` overrides, empty = off). One LZ4 file per entry,
`<hash>.<kind>`, holding the core's ELF build id, every key text and every value: a hit needs all of them byte-equal,
so another core build, a collision or a torn file is a miss that redoes the work. A `unit` key is everything
`compile` reads (text, combos, defines, the linked unit). While the health report is on, reads are skipped (its
records come from the work itself). NVIDIA's own disk cache (`gfx/shader_cache.rs`) covers the GL compile. About 8 KB
an entry; a whole library comes to tens of MB.

Without WE's `assets/` only a scene of a clear colour builds (`patches/lwe/tests/fixtures/min-scene`, the hermetic
real-LWE fixture); anything with an image, particle or effect needs `assets/shaders`. `fail-scene` (an object whose
parent doesn't exist) loads, then its build throws — the deterministic broken-build fixture.

## Fonts

The core's text asks fontconfig for every font (fork patch 0091, `TextLayout.cpp`): a `systemfont_*` name is WE's
Windows file, looked up as one pattern of its family then the metric twins the core lists itself (`systemfont_consolas`:
Consolas, Inconsolata, DejaVu Sans Mono, monospace; WE knows eight names, any other is Arial), and a character the font
lacks goes down WE's fallback chain (Arial, Segoe UI Emoji, …, Malgun Gothic). Scene fonts are fonts like any app's:
the real family when it is installed, else an open stand-in. A stand-in's metrics change wrapping (Inconsolata fits
24 characters on a line where Consolas fits 21), so the worker adds, before the build sets the text layers up
(`render::scene_fonts`): the alias rules compiled in from
`src/player/fontconfig/liascape-scene-fonts.conf` (`scene::fonts::ALIASES`, `FcConfigParseAndLoadFromMemory`: an
`<accept>` per family fontconfig has no metric alias for, Consolas → Cascadia Mono, Segoe UI → Selawik, Comic Sans MS →
Comic Neue, so an installed original still wins), and each folder of `LIASCAPE_SCENE_FONT_DIRS` as an application font
dir (the flake's wrapper names its font packages). Both live in the worker's own fontconfig configuration only (a
spare worker carries the same ones). Only a scene with a text object starts fontconfig (`render::SceneText`): building
the configuration takes about 0.17 s.

After the build the worker asks fontconfig the same question for each system font the scene's text objects name
(`scene::fonts::requested`, `stand_ins`) and reports the ones shown with another family in `Ready.fonts`; the source
logs `scene.fonts` at every load (an empty list clears an old report), the backend keeps it with the item
(`LibMeta.FontStandIns`) and the Library sidebar shows "Uses Consolas, shown with Cascadia Mono". The worker's log
names each stand-in, and LWE's `CText: '<layer>' (<id>) font <name> -> <file>` which face each text took.

## Diagnosing a scene

- `liascape-scene-worker --lwe-smoke <scene> --assets <dir> --out <dir>` (options: `usage()` in its `main.rs`) renders LWE's core
  alone offscreen at 30 fps of scene time, writes upright PNGs, one JSON line (load/build ms, frame ms, lit and changed
  pixels, GL error, audio) and `<out>/health.json`; exit 0 = rendered and animating.
- **Health report** (`WPENGINE_HEALTH=<path>`, fork patches): off unless set (one relaxed atomic load per call site).
  On, the core appends JSON lines naming what a scene silently loses — dropped objects and effects, shader errors
  attributed to their layer/effect/shader, missing assets, script errors with their source line, unsupported
  features, and every layer's on-canvas box at frames 1 and 31. `src/player/tests/onmachine/scene_health.sh` runs
  `--lwe-smoke` over every library scene and ranks them by canvas share lost.
- **Corpus** (`src/player/tests/onmachine/scene_corpus.sh`): plays every library scene on a private headless player
  with no preview (a crash can't pass for a picture) and classifies it (`load_failed`, `renderer_failed`, `broken`,
  `timeout`, `crashed`, `blank`, `static`, `ok`) from captures at Ready +1 s, +2.3 s and +4 s (the off-grid middle
  one catches loops whose period divides 3 s).
- Under gdb `catch throw` shows LWE's caught load failures; the throws under `Configuration::detectSteamDir` (and the
  `Cannot find appmanifest_431960.acf` lines in every tail) are its harmless Steam-dir probe.

## Tests

`bash scripts/lwe.sh test` runs `host_api_test.cpp` (EGL tests skip without a surfaceless context; audio-mix and
WE-asset tests need `LIASCAPE_WE_ASSETS_DIR`; `HOST_API_TEST_ONLY=<substring>` runs a subset) and
`puppet_test.cpp` (compiles in `Puppet.cpp`).
`src/player/tests/lwe_build.rs` checks the exported symbols, that the core is the pinned one, that only the worker
links it, and that the PIN matches the flake; core tests skip without `LIASCAPE_LWE_CORE_DIR` and fail instead under
`LIASCAPE_REQUIRE_SCENES=1`.
