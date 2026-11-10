# Spike: real Wallpaper Engine under Proton, headless, as the goal reference

## Context

- Status: done 2026-11-06. Branch `we-ref`, merged into `lp-player`.
- Goal: get the real Wallpaper Engine (Steam app 431960, the Windows build) to render scenes on this machine with
  nothing on the owner's outputs and nothing audible, and capture frames at known scene times. Liascape's LWE-based
  renderer then has a goal picture to diff against, instead of the authors' previews.
- Machine: NixOS (Hyprland, Wayland), RTX 3070 Ti, NVIDIA 595.84. Steam was running (`pgrep -x steam`); it is never
  touched, and the result doesn't need it.
- Code:
  - `scripts/dev/we-ref-capture.sh` with its helper `scripts/dev/we_ref_tool.py`: the capture.
  - `src/player/tests/onmachine/scene_we_compare.sh` with `scene_we_report.py`: the diff against our render.
  - The scene worker's `--lwe-smoke` gained `--pointer-time A-B`, so a pointer path can be replayed on our side.
- Results:
  - the frames and manifests: `docs/player/reports/we-ref/<id>/`
  - the ranking: `docs/player/reports/scene-we-ref.md`

## Verdict: it works, offscreen. Each scene costs about 12 s and 2.3 GB of RAM

Real WE 2.8.485 renders every scene tried, 3D ones included, inside `gamescope --backend headless`. It uses its
own prefix and its own `config.json`. It does not need Steam, and it never writes to Steam's or the Windows
drive's files.

## How it runs (what `we-ref-capture.sh` does)

1. **The WE install is a symlink farm**, `~/.cache/liascape/we-ref/we`.
   - It is built from the Windows drive's install, 2.8.485, at
     `/mnt/Windows/Program Files (x86)/Steam/steamapps/common/wallpaper_engine`. That drive is mounted
     read-only.
   - `cp -as` copies every directory as real directories holding symlinks to the files. `ui/` is a single
     symlink. `config.json`, `log.txt`, `config_backups/` and `projects/` are left out.
   - WE writes `log.txt` and our `config.json` into the farm, never through to the source.
   - Without the Windows drive, the script falls back to a reflink copy of `/@steam/…/wallpaper_engine`, which
     is 2.8.42 and on the same btrfs, so the copy is free.
2. **Our `config.json`.** It starts from the Linux-side install's, written under Proton as user `steamuser`.
   - Render settings: preset / postprocessing / shadows / volumetrics **ultra**, reflections on, **MSAA x8**
     (the owner's Windows setting), **fps 30** (the worker's pace).
   - Every `playback*` is set to `run`. One of them is "pause when another app is fullscreen", and the capture
     window is fullscreen.
   - Media integration is off, the log is verbose, and no wallpaper or playlist is selected.
   - User properties go into `wproperties[<file>][Ref|Monitor0]`, the place WE's UI stores them.
     `-control applyProperties` is ignored on a running window without WE's UI (§ Findings), so every scene
     starts fresh.
3. **From the owner's Windows install, into this prefix only:**
   - Microsoft's `System32/D3DCompiler_47.dll`, with the builtin moved to `pfx-builtin-bak/`.
   - Links to `Windows/Fonts`, with Proton's stand-ins moved aside.
   - See § Trust. `--builtin-d3dcompiler` keeps Wine's compiler.
4. **A farm per Workshop item**, `~/.cache/liascape/we-ref/ws/<id>`: symlinked files, without the item's own
   `shaders/blobs*`.
   - WE compiles a scene's shaders into the item's `shaders/blobsSM40/`, or the shared `assets/shaders/` cache.
     My first run (2.8.42) wrote 60 blobs into 3516174947's real Workshop folder; I trashed them and restored the
     folder. The farm keeps the Workshop folder read-only from now on.
   - The Workshop's blobs were written by earlier WE runs under Proton. They are left out, and WE compiles
     whatever it lacks afresh.
   - The farm also keeps the cache between captures. 3184155462's first frame took 17 s on the first run and
     6.5 s on every run after.
5. **The launch.** The command is `gamescope --backend headless -W w -H h -w w -h h -r 30 -- child.sh`, and
   `child.sh` runs `steam-run umu-run wallpaper64.exe -control openWallpaper -file Z:\…\project.json -playInWindow Ref -width w -height h -x 0 -y 0 -borderless`.
   - **umu**: `~/.local/share/lutris/runtime/umu/umu-run`, version 1.4.4. It runs under `steam-run` because
     umu's pressure-vessel probe needs an FHS on NixOS, as the `.exe` binfmt handler does too.
   - **Environment**:
     - `PROTONPATH=/@steam/SteamLibrary/steamapps/common/Proton - Experimental`
       (`experimental-11.0-20261027b`)
     - `WINEPREFIX=~/.cache/liascape/we-ref/pfx`
     - `GAMEID=umu-liascape-we-ref`
     - `UMU_RUNTIME_UPDATE=0`
     - `WINEDLLOVERRIDES=winepulse.drv=d;winealsa.drv=d;d3dcompiler_47=n`
     - `PULSE_SERVER=unix:/nonexistent`
   - The first instance takes the `-control openWallpaper` itself: WE starts and opens the scene. Giving it
     `project.json` matters. A first instance given `scene.pkg` looked for a loose `scene.json` and showed
     nothing.
   - **The window is the canvas's own aspect**, fitted into 1920 × 1080. 3516174947's 3440 × 1440 canvas gets
     1920 × 804, for example. WE then shows exactly the canvas, as our worker renders it, so nothing has to
     be aligned. `--desktop` gives the 16:9 desktop view instead (WE's cover fit).
6. **The time base.** Screenshots are requested two at a time until one has a picture. A black PNG always encodes
   to the same size, so "clearly bigger than the first black one" needs no image decoding.
   - The first one with a picture is t = 0. It is stamped at its request, to within about 0.15 s.
   - The frame for T is requested at t0 + T (`gamescopectl screenshot <path>`, the next composited frame).
   - gamescope holds only one pending screenshot. A request made before the last PNG was written replaced it,
     and two frames went missing that way. So each request now waits for the previous file, up to 0.5 s.
     `late_ms` / `t_actual` in the manifest record what that cost.
   - **That t = 0 isn't WE's scene time** (§ "The scene clock"): WE's clock was already 0.1–1.1 s along at it, a
     different amount every run. Since 2026-11-06 the scene shows its own clock in a strip along the bottom, each
     frame's `scene_time` is read from it, and the compare renders ours at that time.
7. **The pointer.** `xdotool mousemove` on gamescope's Xwayland: Wine sees it, and parallax follows. It is parked at
   the canvas centre, where the worker puts it, unless `--pointer X0,Y0[:X1,Y1]` is given (native scene px,
   y down, as the worker's). `--pointer-time A-B` limits the move to scene seconds A–B.
   - A parked pointer is reached by a 4 px move in the first 0.3 s, and the compare replays that move.
   - WE takes no pointer position until it sees a motion event after the scene has loaded. Without the move,
     parallax scenes sat 15–140 px off ours (3309103316: 47 px, 2951169110: 135 px); with it, 0.2 px.
8. **The stop.** SIGTERM to gamescope, a wait of up to 10 s for every process under it, then SIGKILL for
   whatever is left. The script only kills the PIDs it started.

## Answers

1. **Runner.**
   - **Proton Experimental via umu-run** works.
   - `compatibilitytools.d/proton-cachyos-slr` is a dangling symlink: its store path was garbage-collected.
     The newer `/nix/store/…proton-cachyos-slr-11.0.20261015-1` isn't GC-rooted, so I didn't build on it.
   - UMU-Proton-10.0-4 and plain Wine weren't needed, so I didn't try them.
   - **Steam isn't needed.**
     - `wallpaper64.exe` has no `steam_api` import; only `wallpaperui.exe`, the UI, and `bin/steam_api64.dll`
       use it.
     - The Proton log shows `steam_api64.dll` never loaded, and WE's log has no "Steam init" line under our
       runs.
     - Proton's own `steam.exe` shim loads `lsteamclient` and unloads it at once.
     - Steam was running throughout but was never logged into or changed by this.
   - `GAMEID` isn't 431960 on purpose. With `umu-431960`, the process environment named Steam's
     `compatdata/431960` as `STEAM_COMPAT_DATA_PATH`. The prefix used was still ours, and the compatdata
     timestamps were unchanged, but I took no chance.
2. **Rendering without desktop integration.**
   - `-playInWindow Ref` + `-borderless` in a headless gamescope works.
   - `-monitor 0` also renders, because gamescope's screen is WE's monitor. It isn't used.
   - Nothing reaches the owner's outputs. The only trace on the host is gamescope's PipeWire screencast node,
     `.gamescope-wrapped`: a video source with no audio, gone when the session ends.
3. **Frames.** `gamescopectl screenshot <path>` writes a PNG of the composited output; with the window's size as
   the output, that is the window. A 1080p frame takes about 140 ms to land.
4. **Cursor and properties.**
   - **Cursor:** yes, xdotool on gamescope's Xwayland. Parallax and cursor ripple respond.
   - **Properties:** yes, through `config.json` `wproperties` before the start. 3516174947's lens size at 2.0
     zoomed in as expected.
   - **Not working:** `-control applyProperties -location Ref` (and with `-monitor 0`) changes nothing on a
     running wallpaper. The likely reason is that it is relayed through the UI process, which never runs here.
5. **Costs**, per scene (the manifests):
   - Wall time: 14.2 s on average (83 scenes that didn't crash) from launch to the last frame at 0.5 / 2 / 5 s. The first frame lands about
     8.6 s on average (6.5 s typical, up to 39 s while a big scene's shaders compile the first time; cached in the item farm after that), and that is mostly Proton and WE start-up. Each session's stop waits up to 10 s
     more.
   - CPU: about 24.5 s (about 2 cores) over a run.
   - RAM: 1.9 GB on average (2.3 GB at most) RSS under gamescope.
   - VRAM: about 470 MiB on average (2.0 GB at most); gamescope itself takes about 50 MiB for WE.
   - Prefix: created once, about 30–40 s and about 1 GB.
   - Audio: silent. Wine has no audio driver (mmdevapi: "No driver from pulse,alsa,oss,coreaudio could be
     initialized"); `pactl list clients` shows no Wine client while WE runs.
6. **Determinism.** Two runs are close but not identical; ours, seeded, are identical. Measured as the mean
   |run 1 − run n| over RGB (0–255), with `--repeat 3`:

   | scene | what moves | mean | max |
   |---|---|---|---|
   | 1155728109 | nearly static | 0.16 | 64–95 |
   | 2371103399 | | 0.6–0.9 | |
   | 3516174947 | a random camera path, a prompt box | 0.9–3.1 | |

   - What varies: WE's particles and random choices are unseeded, and t = 0 is within one probe interval
     (about 0.15 s).
   - So a WE-vs-ours score below about 0.05 is noise. A difference has to stand out from a second WE run to
     count, which is what the ripple measurement does.

## Trust: how close is Proton's WE to Windows'?

The owner asked how we know Proton reproduces Windows. Class by class:

- **The shader compiler: the same as on Windows.**
  - WE loads the `d3dcompiler_47.dll` it ships in `bin\` (Microsoft, 10.0.26100.7705) by path. The Proton log
    (`WE_REF_DEBUG=1`) shows `Loaded …\we\bin\d3dcompiler_47.dll … native` when WE compiles, so Wine's own
    compiler (vkd3d-shader) is never involved.
  - Most shaders aren't compiled here at all. They come from `assets/shaders/blobsSM40/`, the cache that came with
    the Windows install (721 blobs, compiled on Windows).
  - Test: Microsoft's own `System32/D3DCompiler_47.dll` from the Windows install was copied into the prefix's
    system32 with `d3dcompiler_47=n` (Proton's builtin is in `~/.cache/liascape/we-ref/pfx-builtin-bak/`). The
    capture script does this by default now. Every blob WE had compiled before was recompiled, and all 63 came
    out byte-identical. So the compiler never was a difference.
  - `shaders_compiled` in each manifest counts what WE compiled here: 3 scenes, 3–13 shaders each.
  - WE doesn't load d3dcompiler_43.
- **Fonts: now the Windows ones.**
  - The Windows install's `Windows/Fonts` (396 files, 563 MB) are linked, not copied, into the prefix's
    `windows/Fonts`. Proton's same-name stand-ins are moved to `pfx-builtin-bak/Fonts/`.
  - This matters for the 19 scenes that name Windows system fonts (`systemfont_arial`, `_consolas`, `_comicsans`,
    `_calibri`, `_cambria`). In 3354740764, before the swap, the "Your Image / GIF" label and the Notepad text
    were drawn in Proton's stand-ins. After it, they are in the real Comic Sans and Consolas.
  - Scenes whose fonts are packed in them didn't change (3414858021, 3516174947).
  - Our renderer has to find those faces on Linux, so a glyph difference in those 19 scenes is a font question.
    The report's `reference` column flags them.
- **Everything else, before vs after the swap** (83 scenes, mean |after − before| at 2 s and 5 s):
  - The median is 2.0, inside the run-to-run noise of 0.2–3. Above that, the scenes have random motion
    (2783122117 scrolling, 2561227934 random light shafts) or a clock (the minutes moved).
  - None changed because of the compiler.
- **Video textures:** WE crashes on them under Proton (§ Findings). There is no Proton reference for those 13
  scenes.
- **The clock and date:** Wine's wall clock, at the time of the capture.
- **Rendering:** DXVK (D3D11 → Vulkan) on the same GPU and driver.
  - DXVK is conformant enough for WE's D3D11 that nothing has looked wrong. But it isn't Microsoft's D3D11, so
    precision corner cases (sRGB, blending of NaN or negative values) could differ.
  - The owner's check by eye against Windows (`docs/player/reports/we-ref/compare/`) is the final word.
- **HDR scenes at Ultra: Proton shows them too dark. Fixed in the capture (2026-11-06).** See the next section.
- **Settings:** our `config.json` is Ultra / MSAA x8. (The owner's Windows `config.json` turned out to say
  `msaa` **x2**, `preset` / `postprocessing` ultra, `fps` 30. MSAA changes geometry edges only, not colour; the
  references stay at x8 until a recapture is worth it.) The frame rate is 30 instead of
  their 240, and frame-time-dependent effects differ with it (the cursor ripple, § Findings).

## The FP16 swap chain: why the HDR scenes looked darker under Proton

The first references showed 3019192537 and 3395587987 far darker and more saturated than ours (a deep red sky and
a near-black foreground; a deep blue face). The owner's Windows WE (Ultra, SDR BenQ panels) shows them like ours.
The reference was wrong, not our renderer.

**What WE does (decoded from wallpaper64.exe 2.8.485, `all.c`).**
- With "postprocessing" at `ultra`, the project classifier (GH 0x14013f860) sets the renderer flag 0x2000 for a scene
  whose `general` has `bloom` and `hdr` both literally `true` (gap audit 0098).
- The renderer creates its flip-model swap chain with format **10, R16G16B16A16_FLOAT**, when that flag is set, else
  0x1c R8G8B8A8_UNORM (GH 0x14015a0f0, the desc at `local_2a8`; GH 0x140141520 passes `(flags >> 13) & 1` in).
  It never calls `SetColorSpace1`. The back buffer's render target view has no desc, so it is the buffer's own format.
- The scene's last pass is `combine_hdr_upsample` (`combine_srgb` with bloom off), chosen in GH 0x1401afbf0. Both
  write `lin ()` of the picture, the sRGB-to-linear curve, times g_RenderVar0.x, which is 1 on an SDR display (the
  defaults at +0x228 of GH 0x140141520; only an HDR10 output sets it from the SDR white level, GH 0x14015a0f0).
- On Windows an FP16 swap chain is scRGB (linear). For an SDR display, Windows clips it to 0..1 and sRGB-encodes it,
  so the `lin ()` round-trips and the scene looks as composed. That is what the owner sees, and what ours draws
  (LWE's `combine_hdr_upsample_linear` skips `lin ()` and writes the composed picture into an 8-bit target).

**What Proton did.**
- DXVK maps an FP16 swap chain to scRGB only if the Vulkan surface offers an HDR colour space
  (`DxgiSwapChain::UpdateColorSpace` falls back to G22 otherwise). gamescope's headless surface offers only
  `SRGB_NONLINEAR` (the Proton log: `Presenter: … VK_FORMAT_B8G8R8A8_UNORM, VK_COLOR_SPACE_SRGB_NONLINEAR_KHR`). Our
  gamescope has no WSI layer (nixpkgs ships it separately), so `--hdr-debug-force-support` changed nothing.
- So DXVK's blit treats the linear values as sRGB-encoded ones and copies them as they are. The frames show
  `lin (picture)`. Measured: WE ≈ lin (ours) to a mean |Δ| of 2.7 / 255, where WE vs ours was 39 / 31.
- Only these 4 of the 96 references were affected (2542468435, 3019192537, 3395587987, 3509243656: the only ones
  with literal `bloom` and `hdr`). Every other scene uses an 8-bit swap chain and was presented exactly. 2511663284
  has `hdr` but no bloom, so it is LDR in WE. 3490034653 is LDR (`hdr` false): its difference is something else.
- MSAA x8 is the owner's main Windows profile's setting too.
- **wallpiper doesn't escape it** (`wallpiper-ref.md`). Its Vulkan layer reads the Vulkan swap-chain image,
  which is DXVK's blit output: the same raw linear values. So its Ultra frames match these to the third decimal,
  and they are dark for the same reason. It is DXVK on any surface without an HDR colour space, not gamescope.
- **The two post-processing tiers, checked against ours** (mean |Δ| / 255 at 2 s and 5 s, 480 × 270):

  | | 3019192537 | 3395587987 |
  |---|---|---|
  | Ultra, raw (both sources) | 38–39 | 30–32 |
  | Ultra, re-encoded (gamescope / wallpiper) vs ours (default, HDR chain) | 2.7–3.4 / 2.2–2.3 | 2.7–3.2 / 2.4–3.9 |
  | wallpiper `postprocessing=enabled` vs ours (default) | 4.7–4.8 | 7.9–8.0 |
  | wallpiper `postprocessing=enabled` vs ours with `WPENGINE_HDR=0` (LDR chain) | 0.5–0.6 | 0.5–0.8 |

  So WE at Ultra, as Windows shows it, is ours by default (WE's HDR bloom chain, B13). WE at `enabled` is ours
  with `WPENGINE_HDR=0` (the LDR chain). The tiers differ in bloom only. Neither is the dark picture.

**The fix (in `we-ref-capture.sh`).**
- For a scene that gets the FP16 swap chain, `we_ref_tool.py scrgb` sRGB-encodes each frame after the capture, which
  is what Windows does to it. The raw frames stay in `<capture>/fp16-raw/`. The manifest gets `swap_chain`, and the
  report's `reference` column says `FP16 swap chain: re-encoded`.
- It's exact except for one loss. DXVK already wrote the linear values into 8 bits, so the darkest tones (below
  about 13 / 255 sRGB) are banded.
- The 4 scenes were recaptured with it. Corrected vs ours at 2 s, mean |Δ|: 3019192537 39.1 → 3.5,
  3395587987 31.4 → 2.1. 2542468435 then still differed. That one was ours: WE multiplies an image's colour by its
  `brightness` when the renderer runs HDR (GH 0x1402321d0; fork patch "an HDR scene's image brightness scales its
  draw colour"), and its single layer has brightness 1.15 on a shader with no g_Brightness term (gap audit E42).
- `--gamescope-arg` passes extra gamescope options (recorded in the manifest), for the next experiment of this kind.

## The scene clock: each frame's real scene time

WE's scene clock (the `g_Time` every shader sees, a SceneScript's `engine.runtime`, the timeline keyframes) is not at
0 when the capture's t = 0 frame comes in. The first agents measured it from scenes with intros: 0.19–1.1 s ahead, a
different amount every run (2672425887's demon fades in on frames 62–78 at 30 fps; its 2 s frame caught the fade done
or not). So scenes with intros, fades and phases (the "time" rows of the report) differed for the capture's sake.

**Nothing outside the frames tells it.** WE's `log.txt` stamps whole seconds; the probe sees black, Wine's flat window
background, then a picture, and none of those is the clock's 0.

**So the scene shows it.** `we-ref-capture.sh` opens a private copy of the item (`~/.cache/liascape/we-ref/ws-clock/<id>`:
links to the Workshop files, never the folder itself) whose scene has one more layer, drawn last: a strip along the
bottom edge, 1.2 % of the frame's height, 26 cells across. The first cell is lit, the last unlit, the 24 between are
`floor(g_Time * 1000)` in binary, most significant first (`we_ref_tool.py` CLOCK, its own shader
`liascape_clock.frag`). Its vertex shader writes clip space directly, so zoom, camera shake and parallax never move
it. A lit cell is grey 0.5, under any HDR bloom threshold; the read takes the threshold halfway between the two guard
cells, so a dimmed or re-encoded (FP16) frame still reads.

- **The test scene first** (`~/.cache/liascape/we-ref/probe-scenes/timeprobe`, capture-only, with `--burst`: frames
  back to back from t = 0). `g_Time` read from the strip and a SceneScript's `engine.runtime` (a layer's alpha =
  `runtime % 10 / 10`) agreed to the ms in all 20 frames, and `g_Time − request time` held at 0.14–0.21 s over 4 s:
  the clock runs at the wall clock's rate.
- **Our worker** renders the test scene's strip at exactly the shot time (0.5, 1, 2, 4.2 s → 0.500, 1.000, 2.000,
  4.200), so "ours at T" means `g_Time` = T.
- **Real scenes**: 2672425887 read 0.09 s ahead in one run; 1155728109, 3354740764 0.39–0.40 s; 3019192537 0.90 s.
- **The strip doesn't touch the picture.** Captures with and without it, mean |Δ| above the crop: 0.15 (the run-to-run
  noise of 1155728109 is 0.16), and the band just above the strip differs no more than the top half.
- **Where it can't be read:** a frame where the scene itself is black at the bottom. Such a shot gets
  `scene_time_estimated`: its request time plus the median offset of the frames that were read. A `"fullscreen":
  true` model for the strip left 3276522107 all black, and placing it at a perspective camera's centre lost
  3509243656's strip.
- **3D scenes: the strip rides on the full-screen layer** (2026-11-06). In a perspective scene WE never shows the
  plain strip layer: 3276522107 and 3477054430 read in no frame even from private copies with their post-processing
  layers removed (`captures/clkexp/c3276-nopp`, `c3477-nodith`), and 3509243656 only now and then. So when a
  perspective scene has a full-screen layer (a model with `"fullscreen": true`, shown by default), the strip is that
  layer's last effect (`we_ref_tool.py` CLOCK_FX_FRAG: the input passed through, the bottom 1.2 % of the layer's UV
  overwritten), and no strip layer is added. The layer's output is the frame, so it reads: 3 of 3 frames in all three
  3D scenes (`clkexp/c3276-fx`, `c3477-fx`, then the default captures). In an HDR scene the strip is inside what the
  scene's bloom reads: 3509243656's (threshold 0.46, feather 0.88) spread 0.5 cells 120 px up the frame, so there
  the cells are lit at 0.22 (~56 / 255 after the re-encode; 0.08 landed at 22, under the read's 40). Its frames now
  read even inside the black intro (the 0.5 s frame was at WE's 4.6 s: the probe's first picture comes late).
- **The manifest**: `shots[].scene_time` (+ `scene_time_estimated`), `scene_clock` {strip, crop, read, of,
  offset_median}. `--burst S` adds frames back to back with their scene times (`burst[]`, and the probe's frames
  before t = 0). `--no-clock` captures the item itself.
- **The compare** (`scene_we_compare.sh`) renders ours at each shot's `scene_time` (to the worker's 1/30 s frame)
  and leaves the bottom 3 % (the strip and any bloom around it) out of both pictures. The side-by-sides label
  each row with it.

**The wall clock, too.** Wine's clock is the host's, so a clock text, a script's `Date` or a day/night scene shows the
capture's hour. The compare now runs ours under libfaketime at WE's wall time when its scene clock read 0 (each PNG's
mtime minus its `scene_time`, `we_ref_tool.py wall0`). 2134765860 (day/night, captured and rendered in the
evening) went 0.46 → 0.005, and the clock texts show the capture's minute on both sides.

**The fonts, too.** The capture gives WE the Windows install's fonts. The compare now gives ours the same faces through
a private fontconfig file of its run (`--windows-fonts`, default `/mnt/Windows/Windows/Fonts` when mounted; nothing
installed or copied). 3354740764's notepad then wraps exactly as WE's: its text is `systemfont_consolas` at 4 pt in a
195.5 px box, and this system's stand-in, Inconsolata (0.50 em wide), fits 24 characters where Consolas (0.55 em)
fits 21. That was the whole wrapping difference, not the layout (our layout with Consolas breaks every line where WE
does).

## Findings for the renderer

- **3184155462, cursor ripple ("liquid" much stronger than on Windows).** WE's own ripple depends on the frame
  rate.
  - The cause: `cursorripple_apply_force.frag` multiplies each frame's pointer delta by
    `timeAmt = min(1/30, g_Frametime)/0.02`, so the force added per second scales with frame time.
  - The measurement: a 1 s drag (200,1600 → 1600,1600, parallax off), watereffect on vs off, mean |on − off| in
    the path's band:

    | | peak | noise floor |
    |---|---|---|
    | WE at 30 fps | 5.6 at t = 2.1 s | 2.0 |
    | ours at 30 fps | 3.7 | 0 (deterministic) |
    | WE at 120 fps | 0.6 | |

  - At a matched 30 fps, ours is about WE's strength, with the same shape and the same masked area.
  - The owner's Windows WE is set to **fps 240**. The thing to check is the frame rate and `g_Frametime` our
    player gives the scene, not the effect's constants. See `docs/player/reports/we-ref/3184155462/ripple-diff.jpg`.
- **Video textures crash WE under Proton.**
  - 11 of the 96 scenes crash on load: 2883756643, 2886313155, 3028473503, 3046119914, 3089687436,
    3243449890, 3326873240, 3413117423, 3426575339, 3432876246, 3432999904. 2890767643 and 3556794116
    crashed on the recapture.
  - The crash is an access violation at `wallpaper64.exe+0x121a8d`, called back from Proton's
    `mfmediaengine.dll` (the Media Foundation Media Engine, which WE uses for video textures). Their frames
    show WE's crash dialog, and the manifests have `we_crashed`.
  - Nothing tried helped: UMU-Proton-10.0-4, proton-cachyos 11.0-20261015, `videohardwareacceleration`
    off, and `videoframework` `mfEngine`.
  - The way forward would be Windows' own Media Foundation DLLs from the owner's Windows install in the
    prefix (a follow-up, not tried).
  - These scenes are listed apart in the report, unranked.
- **Parallax was a capture fault, not ours.** Once WE sees the pointer (the nudge), parallax scenes register
  to ours within a pixel (ECC affine fit: 3309103316 at cc 0.9998). The parallax offsets match.
- **The first frame.** Wine paints a new window's background, a flat colour, before WE's first present. A
  probe that took that for t = 0 made a slow-loading scene black at 0.5 / 2 s. The probe now ignores flat
  frames, and every scene was recaptured with it.
- **3516174947, lens size.**
  - At its default 0.75, WE shows more than the canvas. At the canvas aspect there are black borders all round;
    on a 16:9 desktop, cover fit gives bars top and bottom (132 px of 1080 each, the 0.125 that zoom 0.75
    predicts).
  - Our letterbox is WE's behaviour. The preview is an editor capture at zoom 1.
- Everything else: `docs/player/reports/scene-we-ref.md`.

## Blockers / not done

- **Music-reactive scenes, such as 3445973124 with music.** Wine has no audio device, so WE's visualiser input is
  silent, as ours is in the smoke.
  - What it would take: a private PipeWire instance (its own `PIPEWIRE_RUNTIME_DIR`, `pipewire` +
    `pipewire-pulse`, a null sink as the default), with `winepulse` enabled and pointed at it, and a track or
    tone played into that sink. WE loopback-captures the default output.
  - I didn't build it.
- **3414858021 "WEDNESDAY" clipping** needs a Wednesday.
  - libfaketime (`FAKETIME=-2d`, `LD_PRELOAD` through umu and pressure-vessel) did not reach Wine's clock: the
    frame still said FRIDAY 6 NOV.
  - On any Wednesday, run `scripts/dev/we-ref-capture.sh 3414858021 --tag wednesday`. Today's capture
    (FRIDAY, right-aligned) is in `we-ref/3414858021/`.
- **No owner-only steps are needed.** If the Windows drive isn't mounted, the farm is built from the 2.8.42
  Linux-side copy instead. Running on a Wednesday is the owner's call.

## Commands

```bash
scripts/dev/we-ref-capture.sh 3184155462 --times 1,2,3,5
scripts/dev/we-ref-capture.sh 3516174947 --tag lens1 --prop newproperty30=1
scripts/dev/we-ref-capture.sh 3184155462 --tag drag --times 0.9,1.5,2,2.5,3,4 --pointer 800,1080:3040,1080 --pointer-time 1-2
scripts/dev/we-ref-capture.sh --batch --skip-done            # every scene not yet captured
bash src/player/tests/onmachine/scene_we_compare.sh --first 3184155462
```
