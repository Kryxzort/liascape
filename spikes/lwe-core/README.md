# Spike: LWE `next-v2` core, offscreen, in our GL context

Throwaway code for Phase 0 spike (a) of lp-player. Findings: `docs/player/spikes/lwe-core.md`.

It builds linux-wallpaperengine's `core` library from branch `next-v2` at `ddea3b4` and drives it from
`host.cpp`. The host owns the surfaceless EGL desktop-GL 3.3 core context, the loop, the clock and the FBO.

## Build

```bash
bash spikes/lwe-core/build.sh          # clone (if missing) + core library + host
bash spikes/lwe-core/build.sh host     # rebuild only the host
```

- `build.sh` re-executes itself inside `env -u LD_LIBRARY_PATH nix develop <repo>`.
- It resolves the missing packages from the repo flake's locked nixpkgs with
  `nix build --inputs-from <repo> --print-out-paths`.
- Outputs (all gitignored):
  - `lwe/`: the upstream checkout
  - `build/lwe/lib/liblinux-wallpaperengine-core.so`: the core library
  - `build/lwe-core-host`: our host
  - `out/`: full-resolution frames and logs

## Run

```bash
W=~/.local/share/Steam/steamapps/workshop/content/431960
A=/mnt/Games/Steam/SteamLibrary/steamapps/common/wallpaper_engine/assets   # this machine
env -u LD_LIBRARY_PATH spikes/lwe-core/build/lwe-core-host $W/<id> --assets $A --out spikes/lwe-core/out/<id> --fps 60 --native
```

- `--assets` is required on this machine. Here, Wallpaper Engine is installed in a secondary Steam library, and
  the core's Steam auto-detection only looks for `appmanifest_431960.acf` in the main Steam directory.
- The header of `host.cpp` lists every option. The ones the probes use:
  - `--clock fake --pause F:N`: freeze time
  - `--second DIR [--second-context]`: two projects in one process
  - `--volume-at`, `--mute-at`, `--unmute-at`: live audio control
  - `--audio-input noise`: feed the visualiser
  - `--live-prop F:K=V`: set a property while running
  - `--keep-going`: crash probe after a failed first render

## Files

- `host.cpp`: the host. It does the following:
  - creates the EGL context: `EGL_PLATFORM_SURFACELESS_MESA` first, then `EGL_EXT_platform_device`
  - calls `wp_*` in this order:
    1. `wp_config_create` → `wp_context_create` → `wp_context_set_gl_proc_address` / `_time_counter` /
       `_audio_input_mix`
    2. `wp_project_load_folder` → `wp_project_hint_size`
    3. frame 0 into a 1×1 scratch FBO (this builds the renderer); `wp_project_get_width/height` gives the scene size
    4. `wp_project_set_output_framebuffer` (our FBO, at scene size)
    5. each frame: `wp_render_update_time` + `wp_render_frame`
  - after each frame, blits our FBO into a 1920×1080 output with cover-fit and a vertical flip
  - writes PNGs and prints measurements
- `build.sh`: the build recipe (see the findings doc for the dependency list).
- `shots/`: downscaled frames used in the findings doc.
- `.gitignore`: ignores `lwe/`, `build/` and `out/`.
