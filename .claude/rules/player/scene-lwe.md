---
paths:
  - "src/player/build.rs"
  - "src/player/src/bin/liascape-scene-worker/lwe.rs"
  - "src/player/src/bin/liascape-scene-worker/render.rs"
  - "src/player/src/scene/fonts.rs"
  - "src/player/src/gfx/shader_cache.rs"
  - "src/player/tests/lwe_build.rs"
  - "patches/lwe/**"
  - "third_party/lwe/**"
  - "scripts/lwe.sh"
---

# liascape-player: the LWE core in the scene worker

The worker and the `scene` source: [scenes.md](scenes.md); the core's build and pin from the packaging side:
`.claude/rules/build-and-packaging.md` § LWE core (scenes). How it works: `docs/player/modules/scene-lwe-core.md`.

## Build and pin
- Only `liascape-scene-worker` links LWE (`cargo::rustc-link-arg-bin`); the compositor binary never does.
  Guard: `tests/lwe_build.rs::worker_links_the_core`.
- Feature `lwe` is default; without `LIASCAPE_LWE_CORE_DIR` the build fails by design (`--no-default-features`: stub +
  synthetic). A RUNPATH into the Nix store is rooted by the build (`root_core`, build-and-packaging.md § LWE core (scenes)).
- The pin lives in `third_party/lwe/PIN`; `UPSTREAM.md` § linux-wallpaperengine owns the patch series and
  resync recipe. Guards: `tests/lwe_build.rs::core_is_the_pinned_one`, `pin_matches_flake`.
- Patch work: `LWE_DEV_SRC=<fork> bash scripts/lwe.sh build test`. Inside the devShell override
  `LIASCAPE_LWE_CORE_DIR` to a writable dir — the devShell's points at the read-only store.
- The LWE headers are C++-only: declare the C calls by hand in `bin/liascape-scene-worker/lwe.rs`; keep
  `patches/lwe/tests/host_api_test.cpp` C++.
- Never copy WE's JS classes (`<assets>/scripts/jsclasses`, `<assets>/scripts/jsmodules`) into the repo or fork: LWE
  reads them from the assets dir at run time.

## The host's side of the core (`render.rs`)
- Load a real scene's project (`render::load_project`: no GL) on `lia-scene-preload` beside the EGL setup, from
  the host's `--preload` argv (`worker::preload_args`); the `Start` stays the authority (a mismatch loads again).
  Create no GL object or QuickJS runtime there. Guard: `tests/scene.rs::real_scene_project_loads_beside_the_egl_setup`.
- Hand LWE the texture upload context as a `gfx::ShareRecipe` (`lwe::Scene::set_upload_context`, looked up with
  `dlsym`): its `wp-tex-upload` thread makes the context, never the render thread.
- Give the core the compositor's interop and `hwdec` (`wp_context_set_video_hwdec`, mpv's names: its FFmpeg decoder
  opens only the devices the list leads to) and load libcuda first for `cuda`. A scene's videos share one CUDA device
  on the primary context and play on the scene clock (`docs/decisions.md` § Decode scene video textures with FFmpeg,
  not mpv). Guards: `tests/scene.rs::real_scene_worker_loads_libcuda_for_video_textures`, host_api_test
  `video_players_load_only_the_hosts_interop`, `video_players_share_one_cuda_context`, `video_texture_plays_on_the_scene_clock`.
- Give LWE the shader text cache dir `gfx::shader_cache::lwe_dir` (`wp_config_set_shader_cache_dir`); keep it out of
  the user's cache in tests (`tests/common` sets `LIASCAPE_SCENE_SHADER_CACHE_DIR`) and on-machine scripts (their
  private dir). Guards: `tests/scene.rs::real_workers_keep_the_shader_cache_in_the_tests_dir`, `host_api_test`
  `shader_cache_reuses_text_work`.

## Fonts (`scene/fonts.rs`)
- Resolve a scene's fonts through fontconfig like any app (`docs/decisions.md` § "Scene fonts come from fontconfig, not a
  Windows install"): the worker adds `scene::fonts::ALIASES` (`<accept>` only, never `<prefer>`: an installed original
  wins) and `LIASCAPE_SCENE_FONT_DIRS` to its own fontconfig before the build (`render::scene_fonts`); never read a
  Windows partition, never ship or copy a Microsoft font.
- Keep `scene::fonts`' `systemfont_*` table equal to the core's `TextFonts::systemFont`.
- Report stand-ins in `Ready.fonts` → `scene.fonts`; tests see only their fixture fonts (`tests/common` drops
  `LIASCAPE_SCENE_FONT_DIRS`). Guards: `tests/scene.rs::scene_text_reports_the_family_fontconfig_matched`,
  `tests/api.rs::scene_font_stand_ins_reach_the_event_and_probe`, probe-sidebar `lib:fontStandIn:*`.
