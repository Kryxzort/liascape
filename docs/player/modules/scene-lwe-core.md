# LWE core in the scene worker

Covers `src/player/src/bin/liascape-scene-worker/lwe.rs` and `render.rs`, `src/player/src/scene/fonts.rs`, `src/player/build.rs`'s LWE link,
`scripts/lwe.sh`, `patches/lwe/` and `third_party/lwe/`. Rules: `.claude/rules/player/scenes.md` § Build, § Corpus
and health tooling. The pin, the patch series (one row per patch with its why) and the resync recipe live in
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

Patch work: `LWE_DEV_SRC=<fork checkout> bash scripts/lwe.sh build test` builds a working tree in place (`REV` =
`dev:<dir>`, which `core_is_the_pinned_one` skips). Inside the devShell `LIASCAPE_LWE_CORE_DIR` points at the
read-only store, so override it to a writable dir. A fork commit not pushed yet can still satisfy the flake's
fixed-output fetch: build the exact tree, check `nix hash path` equals the PIN's `nix_hash`, and add it with
`nix-store --add-fixed --recursive sha256` (only that machine builds until the branch is pushed).

The headers are C++-only (struct tags used as type names), so `lwe.rs` declares the ~20 C calls it uses by hand,
and `patches/lwe/tests/host_api_test.cpp` stays C++.

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
- **Video textures** play in libmpv (`GLPlayer`), muted with no audio track (`aid=no`), so they open no audio
  output: one that can't connect holds mpv's core thread 20–30 s in its cleanup. The render thread takes the frame
  size from observed properties and never calls `mpv_get_property` while drawing, since a get waits for that thread.
  mpv picks `hwdec=auto`; on NVIDIA the worker loads libcuda before the build (a nixpkgs libmpv can't find it
  alone), so videos decode with nvdec through mpv's CUDA interop, as wherever libmpv finds libcuda: shown ~0.13 s
  after the scene's first frame, for ~90 ms of the build and ~275 MiB of VRAM per video (its CUDA context alone is
  160). Without it they fall to `vulkan-copy` (~120 MiB), black ~0.75 s after the first frame, past 1 s under load.
- **Scripts.** Property scripts and SceneScript run in LWE's QuickJS. Wallpaper Engine's own JS classes are read at
  run time from the assets dir (`scripts/jsclasses/`, `scripts/jsmodules/`) and must never be copied into the repo
  or the fork.
- **Visualiser input:** `wp_context_audio_input_push` feeds WE's spectrum from the system audio the worker gets in
  each `Tick.input`, left and right apart. **Pointer:** `wp_mouse_input`, `wp_project_pointer_jump`,
  `wp_project_set_frame_rate` (the demand). **Media:** scenes that use media events (`wp_project_uses_media`) get
  MPRIS state from `lia-scene-media`; localStorage persists under `LIASCAPE_SCENE_STORAGE_DIR` (default
  `$XDG_STATE_HOME/liascape/scene-storage`).
- A project whose renderer build threw renders nothing ever again (no crash on the next call); a missing project
  file loads NULL.

## Rendering a real scene (`render.rs`)

`check_folder` first (on the preload thread, beside the EGL setup: [scene-worker.md](scene-worker.md) § The worker
binary): a missing dir (deleted, a dangling link, or Steam still downloading) or no `project.json` is a
fatal `load failed`. Then load (NULL → `load failed`, a truncated `scene.pkg` or an unsupported project), apply
`Start.properties`, `first_render` into a 1×1 scratch FBO (≤ 1 → `renderer build failed`), a native-sized FBO for
LWE (its final quad sets `glViewport(0,0,sceneW,sceneH)`), the ring at `cover_size`, then `Ready {native,
has_audio, wants_audio_input}`. Each frame renders into the native FBO and `glBlitFramebuffer`s into the slot (scissor
off first — LWE leaves its state), no flip, alpha forced to 1. Every failure is fatal: no restart, no crash record.

The worker's log tail says where a load went: `gfx: context … in E ms` (the EGL setup before `Hello`) and `lwe:
loaded <dir> in A ms, built in B ms (… ms in all; preloaded, waited W ms)` (A = context + project load, run beside
the EGL setup, W = what the `Start` still waited for it, B = the renderer build with its first frame). `src/player/tests/onmachine/scene_load.py` times a whole apply
(create → `worker.spawned` → the worker's Hello → `source.ready`) on a private headless player, cold, warm and
after-a-boot.

## Texture uploads

NVIDIA converts a texture's pixels on the CPU of the thread that calls `glTexImage2D` (~1.6 GB/s; from a pixel
buffer object slower still): on the render thread a scene's large JPEG / PNG textures cost their whole conversion
before the first frame (~160 ms of 3042492564's, ~200 ms of 3163060610's). With a core that has
`wp_context_set_gl_upload_context` (looked up at run time; without it nothing changes), `lwe::Scene::set_upload_context`
hands LWE a `gfx::ShareRecipe` (`Gfx::share_recipe`: this context's priority and robustness — EGL refuses to share
across reset strategies). LWE's `wp-tex-upload` thread starts once a scene's deferred JPEG / PNG images reach 64 MB
(`TextureUploads::kStartBytes`; below that the thread, its context and its uploads beside the render thread's GL
calls cost more than they save, and those images upload on the render thread) and makes the shared context there
(an `eglCreateContext` costs ~20–30 ms, which on the render thread every scene would pay). Each decode job uploads
its pixels on it, waits (decodes queuing uploads without waiting gained less), and returns a fence that
`finishUpload` `glWaitSync`s on the GPU before the texture is first sampled. DXT and raw textures still upload
where they are created. Measured (warm first frame, against the pin): 3042492564 571 → 480 ms, 3163060610 468 → 426.

## Shader cache

`wp_config_set_shader_cache_dir` (fork patch) keeps the core's shader text work across launches: each shader unit's
WE text passes (`ShaderUnit::compile`, kind `unit`) and each vertex + fragment pair's translation to GLSL 330 by
glslang + SPIRV-Cross (`toGlsl`, kind `glsl`). Both are pure functions of their input texts, and a scene repeats both
at every launch and many times within one build (one effect shader serves many passes: 253 programs, 68 distinct, in
3042492564). The worker points it at `$XDG_CACHE_HOME/liascape/lwe-shaders` (`gfx::shader_cache::lwe_dir`;
`LIASCAPE_SCENE_SHADER_CACHE_DIR` overrides, empty = off; tests point it into their temp dirs). One LZ4 file per
entry, `<hash>.<kind>`, holding the core's ELF build id (the core links with `--build-id`), every key text and every
value: a hit needs all of them byte-equal, so another core build, a hash collision or a torn or corrupt file is a
miss that redoes the work and rewrites the entry. A `unit` key is everything `compile` reads (the preprocessed text,
the three combo maps, the linked unit's text and combos), so the combos and defines are part of it. Writes go to a
temporary file renamed into place. While the health report (or the shader sweep's capture) is on, reads are
skipped: its records come from the work itself. The unit's preprocessing (includes, uniform parsing, texture
formats) still runs at every load: it resolves textures and builds the pass's parameters. NVIDIA's own disk cache
(`gfx/shader_cache.rs`) covers the GL compile of the same text. About 8 KB an entry; the whole library's 3426
distinct pairs come to tens of MB.

Without WE's `assets/` only a scene of a clear colour builds (`patches/lwe/tests/fixtures/min-scene`, the hermetic
real-LWE fixture); anything with an image, particle or effect needs `assets/shaders`. `fail-scene` (an object whose
parent doesn't exist) loads, then its build throws — the deterministic broken-build fixture.

## Fonts

The core's text asks fontconfig for every font (fork patch 0091, `TextLayout.cpp`): a `systemfont_*` name is WE's
Windows file, looked up as one pattern of its family then the metric twins the core lists itself (`systemfont_consolas`:
Consolas, Inconsolata, DejaVu Sans Mono, monospace; WE knows eight names, any other is Arial), and a character the font
lacks goes down WE's fallback chain (Arial, Segoe UI Emoji, Arial Unicode MS, Segoe UI, Twemoji, Segoe UI Symbol,
Microsoft YaHei, Malgun Gothic). Scene fonts are fonts like any app's (`docs/decisions.md` § "Scene fonts come from
fontconfig, not a Windows install"): the real family when it is installed (the core web fonts come from the distro's
package), else an open stand-in. A stand-in's metrics change wrapping (3354740764's notepad: Inconsolata fits 24
characters on a line where Consolas fits 21), so the worker adds, before the build sets the text layers up
(`render::scene_fonts`): the alias rules compiled in from
`src/player/fontconfig/liascape-scene-fonts.conf` (`scene::fonts::ALIASES`, `FcConfigParseAndLoadFromMemory`: an
`<accept>` per family fontconfig has no metric alias for, Consolas → Cascadia Mono, Segoe UI → Selawik, Comic Sans MS →
Comic Neue, so an installed original still wins), and each folder of `LIASCAPE_SCENE_FONT_DIRS` as an application font
dir (the flake's wrapper names its font packages; a distro install has them system-wide). Both live in the worker's own
fontconfig configuration only: no other app sees them, and a spare worker started earlier carries the same ones (they
come with the binary and the compositor's environment). fontconfig is looked up with `dlsym`, never linked (it is the
core's dependency). Only a scene with a text object starts fontconfig (`render::SceneText`, from its `scene.json`): building
the configuration takes about 0.17 s, which the core's own text setup would pay at that point anyway, and a scene without
text never touches fontconfig or its cache.

After the build the worker asks fontconfig the same question for each system font the scene's text objects name
(`scene::fonts::requested`, `stand_ins`) and reports the ones shown with another family in `Ready.fonts`; the source
logs `scene.fonts` at every load (an empty list clears an old report), the backend keeps it with the item
(`LibMeta.FontStandIns`) and the Library sidebar shows "Uses Consolas, shown with Cascadia Mono". The worker's log says
what it added (`fonts: aliases added; …`) and each stand-in (`fonts: Consolas shown with Cascadia Mono`), and LWE's
`CText: '<layer>' (<id>) font <name> -> <file>` which face each text took.

## Diagnosing a scene

- `liascape-scene-worker --lwe-smoke <scene> --assets <dir> --out <dir> [--seconds S] [--audio-dump S] [--prop
  name=value]… [--prop-at T name=value]… [--pointer X0,Y0:X1,Y1] [--tone HZ]` renders LWE's core alone offscreen at
  30 fps of scene time, paced to the wall clock (libmpv decodes video textures in real time; unpaced runs showed
  them black), writes upright PNGs and one JSON line (load/build ms, frame ms, lit and changed pixels, GL error,
  audio streams and peak), exit 0 = rendered and animating. It also writes `<out>/health.json`.
- **Health report** (`WPENGINE_HEALTH=<path>`, fork patches): off unless set (one relaxed atomic load per call site).
  On, the core appends JSON lines naming what a scene silently loses — dropped objects and effects, shader errors
  attributed to their layer/effect/shader, missing assets, script errors with their source line, unsupported
  features, and every layer's on-canvas box at frames 1 and 31. `src/player/tests/onmachine/scene_health.sh` runs
  `--lwe-smoke` over every library scene and ranks them by canvas share lost, tallying causes by signature so fixes
  batch; report in `docs/player/reports/scene-health.md`.
- **Corpus** (`src/player/tests/onmachine/scene_corpus.sh`): plays every library scene on a private headless player
  with no preview (a crash can't pass for a picture) and classifies it (`load_failed`, `renderer_failed`, `broken`,
  `timeout`, `crashed`, `blank`, `static`, `ok`) from captures at Ready +1 s, +2.3 s and +4 s (the off-grid middle
  one catches loops whose period divides 3 s). Report in `docs/player/reports/scene-corpus.md`. Both scripts refuse
  the steamcmd cache and keep captures out of the repo.
- Under gdb (`nix shell nixpkgs#gdb`) `catch throw` shows LWE's caught load failures; ignore the throws under
  `Configuration::detectSteamDir` (its Steam-dir probe, which also prints the harmless `Cannot find
  appmanifest_431960.acf` lines in every tail).

## Tests

`bash scripts/lwe.sh test` runs `host_api_test.cpp` (EGL tests skip without a surfaceless context; audio-mix and
WE-asset tests need `LIASCAPE_WE_ASSETS_DIR`; `HOST_API_TEST_ONLY=<substring>` runs a subset).
`src/player/tests/lwe_build.rs` checks the exported symbols, that the core is the pinned one, that only the worker
links it, and that the PIN matches the flake; core tests skip without `LIASCAPE_LWE_CORE_DIR` and fail instead under
`LIASCAPE_REQUIRE_SCENES=1`.
