# Spike: wallpiper as a second, independent source of real-WE reference frames

## Context

- Status: done 2026-11-06. Branch `wallpiper`, merged into `lp-player`.
- Goal: a second way to run the real Wallpaper Engine and capture frames, to cross-check the first reference
  set (`docs/player/spikes/we-proton.md`, `scripts/dev/we-ref-capture.sh`: WE in its own `-playInWindow` window
  inside a headless gamescope). Where two independent WE runs agree, the reference is solid. Where they
  disagree, we want to know why.
- [wallpiper](https://github.com/ejalxndr/wallpiper) (MIT) runs WE as a real desktop wallpaper under Proton. Its
  parts:
  - a `dwmapi.dll` shim dropped next to `wallpaper64.exe` fakes `Progman`, hooks `GetCursorPos`, hides WE's
    windows and translates the tray;
  - an `LD_PRELOAD` carries a guardian, cursor forwarding and font redirects;
  - a Vulkan layer exports WE's swapchain images as dmabufs to a "portal" (a `wlr-layer-shell` background
    surface on sway/Hyprland, or a GNOME/KDE extension).
- Code: `scripts/dev/we-ref-wallpiper.sh`, `scripts/dev/wallpiper-scope-pids.patch` and
  `src/player/tests/onmachine/scene_we_crosscheck.py`.
- Frames: `docs/player/reports/we-ref-wallpiper/<id>/` (960 px JPEGs + manifest, the same layout as `we-ref/`).
  Side-by-sides (first set | wallpiper | ours | |wp − first| ×4) are in `we-ref-wallpiper/sbs/<id>.jpg`.

## Verdict

**It runs headless and is useful as a second reference.** It also settled the owner's colour question, below.

- 20 scenes captured. On scenes with no fast motion, wallpiper and the first set agree to within run-to-run noise.
  That includes the Ultra HDR look of 3019192537 and 3395587987.
- **wallpiper's frames side with the plain-Proton reference on colour and contrast, not with ours.** The mean
  luma, the luma standard deviation and the mean saturation match to the third decimal (table below).
  wallpiper reads WE's swapchain image directly: no compositor, no gamescope and no colour management. So
  gamescope's colour handling is not what makes the first set contrasty.
- **Correction (2026-11-06, `we-proton.md` "The FP16 swap chain"): the cause is DXVK, not a WE look.** At Ultra
  WE presents a `bloom` + `hdr` scene through an FP16 (scRGB) swap chain holding lin () of the picture, which
  Windows sRGB-encodes for an SDR display. DXVK, on a surface with no HDR colour space, shows it raw, and
  wallpiper's layer reads DXVK's blit output, so it agrees with the gamescope set. Re-encoded, both match ours
  (2–4 / 255); `enabled` matches ours with `WPENGINE_HDR=0`. The owner's Windows look is Ultra too. The
  original reading follows.
- **The cause is WE's own Ultra post-processing.** The same two scenes captured with `postprocessing=enabled`
  instead of `ultra` match ours: 0.067 and 0.157, against 0.59 and 0.51 at Ultra. If Windows looks like ours,
  WE on Windows is not running the Ultra post-processing path for those scenes.
  - The owner's Windows `config.json` has five user profiles: the two main ones are at Ultra (240 fps, MSAA x8),
    the other three at medium, with `postprocessing: enabled`. The owner uses a main one (Ultra).
  - The next thing to check: which profile the Windows session actually loads, or whether WE drops Ultra's HDR
    pass on that machine. That is owner-side.
- **Video textures still crash.** All 7 video scenes tried crash. Every one of the 7 minidumps faults at
  `wallpaper64.exe+0x121a8d`, the same address as the first set: the MF media engine path under Proton.
  wallpiper does not fix it.
  - Its TROUBLESHOOTING points at GE-Proton's `winegstreamer`. That is a download, so I didn't try it.
- **wallpiper is better on the pointer at t = 0.5 s.** Its `GetCursorPos` hook gives WE the cursor from the
  first frame, as a real desktop does. The first set's xdotool nudge lands only after load, so its 0.5 s frames
  of parallax scenes are still easing in from (0, 0). For 2951169110, 3289734539 and 3309103316, the 0.5 s
  score is 0.39–0.60. At 2 s and 5 s it is 0.003–0.04, which is identical.
- **As the future experimental backend (TODO "render a scene with real WE"): promising, but not as shipped.**
  - The dmabuf export is the shape we want. It holds 30 fps, with 1.6 GB RSS and about 440 MiB VRAM per
    instance.
  - Upstream is desktop software. It kills every `wallpaper64.exe` on the box when it stops. It registers WE
    with the user's Steam client. Its frame grab is upside down. It runs one instance per user (fixed `/tmp`
    sockets). The source review below has the details.
  - Borrow the pieces: the Vulkan capture layer and the `GetCursorPos` / Progman shim. Don't adopt the daemon.

## Source review (pinned `6319fe337cf2`, 2026-09-28; 296 files, about 16 k lines of own C)

Read before building: the Makefile, `wallpiperd` (all), `wallpiperctl`, `protocol/`, the ELF preload, the
COFF shim and the Vulkan layer's I/O paths. There is no network code. The only `http` strings are D-Bus
introspection DTDs. Nothing calls `sudo` except `make install-gnome`.

Risky as shipped, and what this harness does about it:

1. **Everything hangs off the real Steam root.**
   - The prefix is `<steam>/steamapps/compatdata/431960`: Steam's own WE prefix.
   - It writes `config.json` into the WE install when none exists.
   - It syncs `distribution/` into the install.
   - It copies `dwmapi.dll` next to `wallpaper64.exe`, which modifies the install.
   - `wallpiperctl` resolves Workshop ids under the Steam root.
   - → `WALLPIPER_STEAM_ROOT` points at a fake root in our tree.
2. **The global kill.**
   - `wp_cleanup()` SIGTERMs, then SIGKILLs, **every** process named `wallpaper64.exe` (or with
     `webwallpaper64.exe` in its command line) on the machine.
   - `wp_renderer_swap()` won't start WE while any of them exists.
   - The first set's capture runs exactly such processes.
   - → `scripts/dev/wallpiper-scope-pids.patch`: the `/proc` scans only match processes that carry this
     daemon's `WALLPIPER_GUARDIAN_PID`. The script refuses an unpatched build.
3. **The Steam client.**
   - wallpiperd sets `SteamAppId/SteamGameId=431960` and starts WE with Proton's `run` verb.
   - That goes through Proton's `steam.exe`, which loads `$HOME/.steam/sdk64/steamclient.so`, the native Steam
     client library. So upstream registers WE with the user's running Steam.
   - With a HOME that has no `.steam`, `steam.exe` asserts (`steamclient_main.c:375`) and WE never starts.
   - → The Proton wrapper uses `runinprefix` (plain wine) with app id 0 and the DLL overrides `run` would have
     set: DXVK, vkd3d-proton, dxvk-nvapi. Without those, WE got Wine's wined3d.
   - The first set's umu path loads the real `steamclient.so` via the real HOME. It "unloads at once", but it
     does load it.
4. **The tray.** The default `native` tray registers a StatusNotifierItem on the session D-Bus, which would put
   an icon in the owner's bar. → `WALLPIPER_TRAY_OPTS=notray` and a private `dbus-run-session`.
5. **The Hyprland portal** talks to `$HYPRLAND_INSTANCE_SIGNATURE`, the owner's compositor. It calls
   `hyprctl monitors` and polls `cursorpos` 60 times a second. → I used the sway portal in a headless sway.
   It has no cursor query, so we write the cursor file ourselves.
6. **Fixed paths.**
   - `/tmp/wallpiper-capture.sock` and `/tmp/wallpiper-portal-<name>-ctl.sock` are hard-coded, so there is
     one session per user.
   - Logs go to `/tmp/wallpiperd-renderer.log`, `/tmp/wallpiperd-portal-*.log` and
     `/tmp/wallpiper-siphon.log`.
   - The shim writes `C:\dwmapi_shim_debug.log` into the prefix.
   - Font cache: `~/.cache/wallpiper/fonts`. → HOME is our tree.
7. **The guardian preload** SIGKILLs every Wine process it was loaded into once wallpiperd's PID is gone. That
   is handy, but it is abrupt.
8. **Fonts.**
   - wallpiperd rewrites the host's `fc-match sans-serif/serif/monospace` (here Noto Sans, Noto Serif, Hack),
     renamed in their name tables, and serves them as `arial/arialbd/tahoma/tahomabd/times/cour/courbd.ttf`.
   - So "Arial" is never Arial.
   - → Off by default: an `fc-match` stub that fails. The Windows fonts are linked into our prefix, as the first
     set does. `--wallpiper-fonts` keeps upstream's behaviour.
9. **The capture API** (`wallpiperctl capture <ch> <png>`, `egl_capture.c`) writes `glReadPixels` rows
   bottom-up, so the PNG is **upside down**. The layer surface itself is upright (checked with grim). → The
   script flips its frames.
10. Not a risk, but worth knowing:
    - the README recommends a clean WE install, and its build vendors a `tcc` that cross-compiles the COFF shim;
    - `install-gnome` runs `sudo make install` and `ldconfig`, and `install-wallpiperd` writes `~/.local/bin`.
    - Neither was used.

## Setup (what `we-ref-wallpiper.sh --setup` builds; nothing system-wide)

```bash
git clone https://github.com/ejalxndr/wallpiper /tmp/claude-1000/wallpiper/src
git -C /tmp/claude-1000/wallpiper/src checkout --detach 6319fe337cf2d4081e5d82d59ff9887c7089292e
git -C /tmp/claude-1000/wallpiper/src apply "$PWD/scripts/dev/wallpiper-scope-pids.patch"
cd /tmp/claude-1000/wallpiper/src && nix-shell -I nixpkgs=flake:nixpkgs -p gcc gnumake pkg-config dbus \
  vulkan-headers vulkan-loader wayland wayland-protocols wayland-scanner libGL libgbm libx11 libxrandr fontconfig \
  --run 'make build-core build-sway'           # binaries in build/release; no make install
cd - && scripts/dev/we-ref-wallpiper.sh --root /tmp/claude-1000/wallpiper --setup
```

- **WE install.** It is a farm of the Windows drive's 2.8.485, the version the first set uses.
  - Real directories hold real copies of every file under 2 MB (about 220 MB of 1.5 GB). Larger
    dll/exe/pak/texture files are symlinks, and `ui/` is a single symlink.
  - WE writes shader blobs into `assets/shaders/blobsSM40` and rewrites `bin/playliststate.bin`. Neither may
    write through a link.
  - `/mnt/Windows` is mounted **rw** at the moment, not ro. The 2.8.42 Linux copy could have been reflinked,
    but it is a different version.
- **Workshop items** are reflink copies (free on this btrfs).
  - The shader blobs the item ships (`shaders/blobs*`) are left out, so WE compiles them with the Microsoft
    `d3dcompiler_47` it ships in `bin\`. That is the same input as the first set since `7401e56`.
  - `--keep-item-blobs` keeps them.
- **steam-run hides `/tmp`.** It mounts a private tmpfs there, and wallpiper's layer and preload need the host's
  `/tmp` sockets. So the Proton wrapper runs a copy of steam-run's bwrap script with that one line changed to
  `--bind /tmp /tmp`. The root also lives under `/tmp/claude-1000`.
- **Proton** is Steam's "Proton - Experimental" (`experimental-11.0-20261027b`), as the first set uses. The
  prefix is our own (330 MB), built on the first run.
- **Session.**
  - `dbus-run-session sway` runs with `WLR_BACKENDS=headless`: one `HEADLESS-1` output at the canvas's own
    aspect fitted into 1920 × 1080, which is the first set's window size. It has its own `XDG_RUNTIME_DIR` and
    `xwayland force`.
  - Its config `exec`s wallpiperd with `WALLPIPER_PORTAL=sway`, the fake root, `notray`, the wrapper as
    `WALLPIPER_PROTON_BIN` and HOME in our tree.
  - Audio: Wine's pulse/alsa drivers are disabled, and `PULSE_SERVER` goes nowhere.
  - Nothing appears on the owner's outputs. sway's only output is headless, and grim on it shows the layer
    surface.
- **The scene** is selected the way WE's UI stores it: `selectedwallpapers.Monitor0.file = <item>/scene.pkg` in
  `config.json`, along with the first set's render settings (Ultra, MSAA x8, 30 fps; `we_ref_tool.py config`).
  - Giving the first instance `-control openWallpaper … -monitor 0` stopped WE from starting its renderer at
    all.
  - `wallpiperctl set` execs Proton's wine binary directly, which has no FHS on NixOS.
- **Frames.** `wallpiperctl capture 0 <png>` grabs the dmabuf the portal holds, which is WE's own swapchain
  image (`B8G8R8A8_UNORM`). It takes about 0.26–0.4 s, then the frame is flipped.
  - t = 0 is the first non-flat grab (one probe about every 0.2 s), as in the first set.
  - Frames are taken at 0.5 / 2 / 5 s. `late_ms`, `capture_ms` and `t_actual` go into the manifest.
- **Pointer.** We write the canvas centre in screen pixels (plus the first set's 4 px nudge) as two int32s into
  `$WALLPIPER_TEMP_DIR/wallpiper-cursor`. The shim's `GetCursorPos` hook reads it every 16 ms. WE sees it from
  its first frame. A corner test confirmed it (2951169110 with the pointer at 0,0 versus the centre: mean |Δ|
  2.4 against 45).
- **Stop.**
  - SIGTERM goes to wallpiperd. With the patch, its cleanup touches only its own renderers.
  - The script waits up to 12 s for its `*.exe` processes, then runs `swaymsg exit`.
  - Anything left of the session's tree, or any process carrying this wallpiperd's guardian PID, gets TERM,
    then KILL.

Commands:

```bash
scripts/dev/we-ref-wallpiper.sh --root /tmp/claude-1000/wallpiper 3019192537 3395587987 3490034653
scripts/dev/we-ref-wallpiper.sh --root /tmp/claude-1000/wallpiper --tag pp-enabled --we-setting postprocessing=enabled 3019192537
bash src/player/tests/onmachine/scene_we_compare.sh --refs /tmp/claude-1000/wallpiper/captures --no-build \
  --bin <a release target dir> --results /tmp/…/ours --report-dir - --sbs-dir - --only <ids>   # ours at wallpiper's times
python3 -I src/player/tests/onmachine/scene_we_crosscheck.py --first docs/player/reports/we-ref \
  --wp docs/player/reports/we-ref-wallpiper --ours /tmp/…/ours --sbs-dir docs/player/reports/we-ref-wallpiper/sbs
```

## Costs (20 scenes that didn't crash, from the manifests)

| | wallpiper | first set (we-proton.md) |
|---|---|---|
| first picture after launch | 6.5 s average (3.7 s with cached blobs) | 8.6 s average (6.5 s typical) |
| launch → last frame | 12.8 s | 14.2 s |
| RSS (whole session) | 1.6 GB average, 2.0 GB max | 1.9 GB average, 2.3 GB max |
| VRAM (WE) | 440 MiB average, 1.0 GB max | about 470 MiB average |
| one frame grab | 0.26–0.4 s (PNG encode in the portal) | about 0.14 s |

## Cross-check (the trusted first set of `7401e56` vs wallpiper vs ours)

The scores use the report's measure (0.30 ssim + 0.20 hist + 0.20 edges + 0.30 local at 256 px; 0 = identical),
as the mean over 0.5 / 2 / 5 s. "Ours" is `liascape-scene-worker --lwe-smoke` at wallpiper's times (seed 7).
Noise floor: two WE runs of a static scene score under 0.02, and of a moving one about 0.05–0.1.

| id | wp ~ first | ours ~ first | ours ~ wp | verdict |
|---|---|---|---|---|
| 1155728109 | 0.007 | 0.018 | 0.018 | agree: solid reference |
| 2371103399 | 0.012 | 0.073 | 0.070 | agree: solid |
| 2828233985 | 0.059 | 0.053 | 0.057 | agree (0.5 s pointer ease only) |
| 3184155462 | 0.068 | 0.094 | 0.062 | agree: solid |
| **3019192537** | **0.046** | 0.600 | 0.584 | **both WE agree, contrasty Ultra HDR; with `postprocessing=enabled` WE ≈ ours (0.067)** |
| **3395587987** | **0.070** | 0.490 | 0.486 | **same: Ultra post-processing; `enabled` ≈ ours (0.157)** |
| **3490034653** | 0.118 | 0.435 | 0.391 | both WE agree at 2 s / 5 s (0.07–0.08), 0.5 s is the pointer; not the post-processing (`enabled` is 0.022 from Ultra) |
| 3509243656 | 0.061 | 0.380 | 0.372 | agree (0.004 at 0.5 s / 2 s, 0.18 at 5 s: motion); ours differs (0.84 at 5 s), a real one |
| 3354740764 | 0.158 | 0.549 | 0.550 | agree but for the clock (17:06 vs 17:50) and the moving light shafts. With the Windows fonts both show the real labels. Upstream wallpiper fonts (v1 run): 0.221 |
| 2951169110 | 0.223 | 0.032 | 0.024 | 0.5 s only (0.60; then 0.035): the first set's pointer still easing in; wallpiper = ours |
| 3289734539 | 0.172 | 0.031 | 0.020 | same: 0.48 at 0.5 s, then 0.015 |
| 3309103316 | 0.134 | 0.018 | 0.017 | same: 0.39 at 0.5 s, then 0.004 |
| 3219908811 | 0.332 | 0.248 | 0.110 | 0.5 s pointer, then 0.17–0.22: animation phase; wallpiper is closer to ours |
| 3233141951 | 0.323 | 0.269 | 0.151 | the clock, plus flame animation phase |
| 3414858021 | 0.282 | 0.260 | 0.208 | the clock / date text (wall time), plus the 0.5 s pointer |
| 2542468435 | 0.168 | 0.483 | 0.366 | 0.04 / 0.35 / 0.11 by time: a transient at 2 s; otherwise agree; ours differs |
| 3516174947 | 0.121 | 0.166 | 0.084 | random camera path (WE unseeded) |
| 3593587273 | 0.395 | 0.414 | 0.343 | a bouncing sprite at another phase (timing) |
| 2783122117 | 0.564 | 0.577 | 0.366 | the skeleton scroll at another phase in every run (timing) |
| 3276522107 | 0.320 | 0.435 | 0.306 | timing: moving train lights. Two wallpiper runs (with and without the item's own blobs) differ by 0.14–0.58 themselves |
| 3028473503, 3413117423 | – | – | – | video: WE crashed in both. wallpiper's capture holds the last good swapchain frame (grey, no video), not the crash dialog |

Colour statistics at 2 s (mean luma / luma σ / mean saturation, 0–1):

| id | first set (gamescope) | wallpiper (raw swapchain) | wallpiper, `postprocessing=enabled` | ours |
|---|---|---|---|---|
| 3019192537 | 0.204 / 0.210 / 0.760 | 0.205 / 0.209 / 0.757 | 0.389 / 0.273 / 0.667 | 0.374 / 0.261 / 0.660 |
| 3395587987 | 0.448 / 0.271 / 0.904 | 0.445 / 0.269 / 0.905 | 0.614 / 0.189 / 0.790 | 0.600 / 0.206 / 0.771 |
| 3490034653 | 0.384 / 0.299 / 0.345 | 0.387 / 0.296 / 0.349 | 0.390 / 0.296 / 0.346 | 0.423 / 0.297 / 0.356 |

What it means:

- **Disagreements between the two WE sources are never the compiler.** Both load WE's own Microsoft
  `d3dcompiler_47`, and both now recompile the item blobs.
- The disagreements are:
  - **time**: the phase of fast animations, and the wall-clock text;
  - **the pointer at 0.5 s**: wallpiper has the cursor from the start, like Windows;
  - **WE's unseeded randomness**: camera paths and particles;
  - **fonts**, only with upstream wallpiper's redirect.
- None of them looks more like Windows on rendering. On the pointer, wallpiper is the more Windows-like.
- **Where both agree and ours differs, the difference is ours** (3509243656, 2542468435, 3490034653 at 2 / 5 s,
  3354740764's sprite box). The exception is the Ultra HDR pair. There both WE runs agree with each other, but
  the owner reports that Windows looks like ours. The `postprocessing=enabled` captures reproduce ours, so the
  open question is which post-processing level the owner's Windows WE really renders with (see the verdict).
- Frames: `we-ref-wallpiper/<id>/`, variants `3019192537|3395587987|3490034653/pp-enabled/` and
  `3276522107/item-blobs/`, side-by-sides `we-ref-wallpiper/sbs/`.

## Blockers / not done

- **Video wallpapers.** They crash the same way. GE-Proton (what wallpiper recommends) would be a download,
  so it wasn't tried. Windows' own Media Foundation DLLs from `/mnt/Windows` are still the untried local option
  (the first spike's note).
- **Only 20 scenes plus variants**, not all 96. `--batch` wasn't ported; run it over ids from
  `ls docs/player/reports/we-ref` if wanted.
- **No owner-only step was needed.**
  - No Steam login: Steam's client library is never loaded.
  - No credentials.
  - The Windows drive is only read. Its fonts are linked into our prefix, not copied.
