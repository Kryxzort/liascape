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
3. **A farm per Workshop item**, `~/.cache/liascape/we-ref/ws/<id>`: symlinked files with a real copy of
   `shaders/`.
   - WE compiles a scene's shaders into the item's `shaders/blobsSM40/`. My first run wrote 60 blobs into
     3516174947's real Workshop folder; I trashed them and restored the folder. The farm keeps the Workshop
     folder read-only from now on.
   - The farm also keeps the cache between captures. 3184155462's first frame took 17 s on the first run and
     6.5 s on every run after.
4. **The launch.** The command is `gamescope --backend headless -W w -H h -w w -h h -r 30 -- child.sh`, and
   `child.sh` runs `steam-run umu-run wallpaper64.exe -control openWallpaper -file Z:\…\project.json -playInWindow Ref -width w -height h -x 0 -y 0 -borderless`.
   - **umu**: `~/.local/share/lutris/runtime/umu/umu-run`, version 1.4.4. It runs under `steam-run` because
     umu's pressure-vessel probe needs an FHS on NixOS, as the `.exe` binfmt handler does too.
   - **Environment**:
     - `PROTONPATH=/@steam/SteamLibrary/steamapps/common/Proton - Experimental`
       (`experimental-11.0-20261027b`)
     - `WINEPREFIX=~/.cache/liascape/we-ref/pfx`
     - `GAMEID=umu-liascape-we-ref`
     - `UMU_RUNTIME_UPDATE=0`
     - `WINEDLLOVERRIDES=winepulse.drv=d;winealsa.drv=d`
     - `PULSE_SERVER=unix:/nonexistent`
   - The first instance takes the `-control openWallpaper` itself: WE starts and opens the scene. Giving it
     `project.json` matters. A first instance given `scene.pkg` looked for a loose `scene.json` and showed
     nothing.
   - **The window is the canvas's own aspect**, fitted into 1920 × 1080. 3516174947's 3440 × 1440 canvas gets
     1920 × 804, for example. WE then shows exactly the canvas, as our worker renders it, so nothing has to
     be aligned. `--desktop` gives the 16:9 desktop view instead (WE's cover fit).
5. **The time base.** Screenshots are requested two at a time until one has a picture. A black PNG always encodes
   to the same size, so "clearly bigger than the first black one" needs no image decoding.
   - The first one with a picture is t = 0. It is stamped at its request, to within about 0.15 s.
   - The frame for T is requested at t0 + T (`gamescopectl screenshot <path>`, the next composited frame).
   - gamescope holds only one pending screenshot. A request made before the last PNG was written replaced it,
     and two frames went missing that way. So each request now waits for the previous file, up to 0.5 s.
     `late_ms` / `t_actual` in the manifest record what that cost, and the compare renders ours at
     `t_actual`.
6. **The pointer.** `xdotool mousemove` on gamescope's Xwayland: Wine sees it, and parallax follows. It is parked at
   the canvas centre, where the worker puts it, unless `--pointer X0,Y0[:X1,Y1]` is given (native scene px,
   y down, as the worker's). `--pointer-time A-B` limits the move to scene seconds A–B.
7. **The stop.** SIGTERM to gamescope, a wait of up to 10 s for every process under it, then SIGKILL for
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
