# Scene switch time — real Wallpaper Engine under Proton against liascape-player

A dated measurement (2026-11-20), not the current state: how long a switch to a scene takes from the request to the
new scene's first frame on screen and to its complete picture, in Wallpaper Engine (WE) under Proton and in ours, for
the scenes `src/player/tests/onmachine/scene_load.py` times. Native Windows is not measured yet (`docs/TODO.md` #97).
Script: `src/player/tests/onmachine/scene_load_we.py` (its docstring is the method in full).

- **Run:** 2026-11-20 night, lp-player `820a6818` (libcuda in the scene worker) + this script, release build, LWE pin
  `45fdd43`. `93222912`, which landed after the runs, only narrows the video interops, and its own measurement
  (`docs/TODO.md` #104) saw no change. WE 2.8.797 under Proton Experimental 11.0-20261027b (the we-ref setup:
  `scripts/dev/we-ref-capture.sh`, Ultra preset, MSAA x8, Microsoft's d3dcompiler, no audio device), in a headless
  gamescope at 1920 x 1080 and 60 Hz, WE's fps 60. Ours: a private headless player (no display, no audio) on a
  1920 x 1080 @ 60 output, `scene_fps` 60. Machine: i9-12900K, RTX 3070 Ti (NVIDIA 595.84).
- **Scenes:** 3042492564, 3163060610, 2388299037 (scene_load.py's three) and 3426575339 (two full-screen video
  textures; ours only — video textures crash WE under Proton, `docs/player/spikes/we-proton.md`).

## Method

**The switch.** Both sides start on the same probe scene A (a flat magenta clear colour with WE's scene clock as a
strip along the bottom, so every frame A renders differs from the last) and switch to the Workshop scene B.

- **WE:** WE's own `-control openWallpaper`, sent by a second `wallpaper64.exe` started inside the session's
  pressure-vessel container (`nsenter`) and Wine server, the path WE's UI uses. A second `umu-run` makes its own
  container and Wine server, so it starts a second WE instead of reaching the first. The sender itself takes
  0.4–1.2 s to start under Wine, which a click in WE's UI doesn't pay. So WE's times run from `opened`: WE's first
  open of B's `project.json` (inotify on the Workshop folder). A's last rendered frame comes 27 ms before to 41 ms
  after it, median 2 ms before, so `opened` is the moment WE acts on the request.
- **Ours:** a `transition` request (a cut, `align: now`) for B, as the backend sends a switch. Times run from the
  request.

**The detector, the same on both sides.** Frames are reduced to a 240 x 135 grey picture. A frame is `a` (flat
magenta above the strip), `flat` (any flat frame: black, a window background) or `pic`.

- `first` is the first `pic` frame after the request: B's first frame on screen, or the first frame of a crossfade
  into it.
- `complete` is the first frame in which at most 3 % of the 24 x 15 tiles that hold content in B's settled picture
  (4 s after `first`) are still empty. It catches a video or texture that arrives late. It also catches a scene's own
  scripted intro (text fading in), so read it per scene (§ Results).
- WE's frames are read from its window on gamescope's Xwayland with MIT-SHM (`XShmGetImage`). One read plus the
  reduction takes ~2.5 ms, and a read is taken every 5–8 ms.
- Ours are the player's own `capture` of the output: the last composed frame, written as a PNG into `/dev/shm` and
  reduced on a second thread. Requests go back to back, 2–5 ms apart, and each frame is stamped at its request.

**Resolution and bias.** Each `first` comes with the read before it (`first_prev`), which still showed the old
picture. The gap is 5–8 ms for WE (median 6) and 2–5 ms for ours (median 4).

- WE's read sees the window once Xwayland has the present. gamescope shows it at its next 60 Hz refresh (+0–17 ms),
  and a Windows desktop compositor (DWM) does the same. Ours reads the frame the player composed, which a real output
  shows at its next refresh. Neither side counts the refresh.
- **Measuring costs both sides.** Ours: the capture loop slows the load by 1–67 ms (median 30), against the same
  runs with events only (`--no-capture`). WE: a read every 4 ms makes Xwayland copy the window back from the GPU each
  time, which slows WE's switch by 12–82 ms (median 37), against runs that read every 50 ms (`--period 0.05`;
  6 cold, 6 boot, 10 warm per scene).
- **So the comparable numbers are estimates.**
  - WE ≈ the 50 ms runs' `first` minus 25 ms, half the read interval. Only one frame in 12 is read, so these runs
    cost WE little; the error is ±25 ms per load and less for a median.
  - Ours ≈ `transition.started` from the event-only runs plus 35 ms. In every capture-on load the detector saw B
    33–38 ms after that event, so the offset is solid.
  - About 30 of those 35 ms are probably the cut's swap at t0 + 30 ms (`docs/player/modules/transitions.md`, the
    cut row): A's 30 ms anticlick ramp runs first. The cut skips the ramp only for an A that ended, is paused or sits
    at −96 dB (`recipes/transition.rs`). The probe A has no sound, but its gain isn't −96, so it is ramped.

**Conditions.**

| | WE | ours |
|---|---|---|
| cold (first load ever) | a fresh WE session per load: every shader WE compiled hidden (`assets/shaders/blobsSM50` moved aside, B's farm blobs dropped; WE recompiled 36–77 shaders for B), a private NVIDIA shader disk cache emptied, B's files and WE's assets dropped from the page cache (`posix_fadvise` DONTNEED, no root) | NVIDIA's cache and the core's shader cache emptied, B's files, WE's assets, the worker and its core dropped from the page cache |
| boot (first load after a reboot) | a fresh session, the files dropped, every cache kept | the files dropped, the caches kept |
| warm | B again in the same session (B → A → B) | B again (a new worker each time) |

## Results

Times are ms, median (p25–p75). Ours: 10 cold, 6 boot and 10 warm loads per scene in each of three runs (capture on;
events only; events only with `player.scene_spare` on, the product default once scenes play). WE: the same counts
reading every 4 ms, plus the 50 ms runs. WE's times run from `opened`, ours from the request.

**Request to B's first frame on screen.** WE ≈ and ours ≈ as defined above.

| scene | load | WE | ours | ours, spare | ours − WE | spare − WE |
|---|---|---|---|---|---|---|
| 3042492564 | cold | 1281 (1234–1302) | 1018 (1005–1047) | 934 (904–994) | -263 | -347 |
| 3042492564 | boot | 726 (702–744) | 517 (509–518) | 434 (423–465) | -209 | -292 |
| 3042492564 | warm | 566 (543–577) | 534 (517–551) | 400 (388–401) | -32 | -166 |
| 3163060610 | cold | 1129 (1115–1160) | 868 (867–884) | 1249 (1018–3849) † | -261 | +120 † |
| 3163060610 | boot | 710 (703–720) | 509 (480–530) | 401 (385–414) | -202 | -309 |
| 3163060610 | warm | 525 (489–540) | 467 (450–484) | 350 (349–366) | -58 | -176 |
| 2388299037 | cold | 910 (880–939) | 776 (767–800) | 650 (638–700) | -134 | -260 |
| 2388299037 | boot | 694 (680–703) | 543 (529–575) | 451 (414–466) | -151 | -243 |
| 2388299037 | warm | 531 (514–541) | 534 (500–563) | 417 (416–442) | +2 | -114 |
| 3426575339 | cold | crashes | 563 (553–590) | 400 (372–423) | – | – |
| 3426575339 | boot | crashes | 508 (495–530) | 377 (355–397) | – | – |
| 3426575339 | warm | crashes | 450 (450–480) | 350 (334–352) | – | – |

† With the spare, 3163060610's cold loads included 4.2, 11.8, 38 and 2.8 s. In each, the adopted spare stayed inside
its load the whole time, with no crash or restart; the rest took 0.8–1.3 s. Two reruns never reproduced it: 12 cold
loads the same way took 0.67–1.13 s (median 0.73), and 6 with `scene_load.py --spare` took 0.69–0.78 s. The cause is
unknown, possibly something else busy on the machine at that moment.

**What the detector saw** (a read every 4 ms for WE, with the capture loop on for ours; both late by their measuring
cost above):

| scene | load | WE black | WE first | WE complete | ours first | ours complete |
|---|---|---|---|---|---|---|
| 3042492564 | cold | 59 (55–63) | 1307 (1296–1323) | 1431 (1363–1666) | 1074 (1068–1082) | 1194 (1100–1210) |
| 3042492564 | boot | 57 (56–59) | 795 (778–809) | 891 (810–1162) | 584 (583–585) | 716 (617–721) |
| 3042492564 | warm | 45 (39–47) | 624 (597–670) | 790 (688–1018) | 556 (543–568) | 641 (567–681) |
| 3163060610 | cold | 58 (55–63) | 1164 (1144–1185) | 1164 (1144–1185) | 902 (901–916) | 902 (901–916) |
| 3163060610 | boot | 62 (59–85) | 738 (730–786) | 738 (730–786) | 531 (521–540) | 531 (521–540) |
| 3163060610 | warm | 45 (41–48) | 597 (570–634) | 597 (570–634) | 514 (505–516) | 514 (505–516) |
| 2388299037 | cold | 56 (48–59) | 922 (915–944) | 922 (915–944) | 819 (801–835) | 819 (801–835) |
| 2388299037 | boot | 55 (48–57) | 731 (712–754) | 731 (712–754) | 568 (554–580) | 568 (554–580) |
| 2388299037 | warm | 39 (35–42) | 613 (574–628) | 613 (574–628) | 536 (534–543) | 536 (534–543) |
| 3426575339 | cold | crashes | crashes | crashes | 581 (552–591) | 581 (552–591) |
| 3426575339 | boot | crashes | crashes | crashes | 513 (502–533) | 513 (502–533) |
| 3426575339 | warm | crashes | crashes | crashes | 484 (480–501) | 484 (480–501) |

- **WE black:** the window turns black. WE drops A as soon as it opens B.
- **Warm, ours and WE are about even without the spare:** ours 58 ms sooner to 2 ms later. With the spare, ours is
  114–176 ms sooner. That holds although ours starts a new worker process for every switch and WE reuses its warm
  process.
- **After a boot and cold, ours is sooner on every scene.** After a boot: 150–210 ms (240–310 with the spare). Cold:
  135–265 ms (260–350 with the spare, but for †).
- **WE goes black during the switch; ours never does.**
  - WE stops drawing A when it opens B's `project.json`: A's last frame comes 27 ms before to 41 ms after the open,
    median 2 ms before.
  - The window is black from 39–62 ms after the open until B's first frame: 0.5–1.2 s of black.
  - Ours keeps A on screen until B's first frame is ready, then cuts.
- **What a cold load costs over warm.**
  - WE: 380–715 ms (WE ≈). It recompiled 36–77 shaders with FXC per scene, and built its first DXVK pipelines.
  - Ours: 240–480 ms for the three scenes and 110 ms for the video scene. That is NVIDIA's compiles and the core's
    shader text work (`docs/TODO.md` #48).
  - After a boot (files dropped, caches kept): WE 160–185 ms over warm, ours −20 to +60 ms. WE's cold and boot loads
    are also a fresh WE process's first switch, which adds to them.
- **Complete picture.**
  - 3042492564's clock and date text fade in by script: 100–170 ms after the first frame in WE, 85–130 ms in ours.
  - The other WE scenes are complete in their first frame.
  - 3426575339's two videos are already in our first frame (nvdec decodes them inside the build, commit
    `820a6818`), so its first frame is its complete picture.
- **The WE sender** (a second `wallpaper64.exe` under Wine) takes 0.36–0.42 s from its start to WE's open in a warm
  session, and 1.15–1.24 s in a fresh one. This is not counted above. A click in WE's UI reaches WE over IPC in a few
  ms.

## Candidates (not queued)

- Count an A with no sound at all as silent in the cut: a scene without sound objects, an image, or a colour. Such a
  cut would swap at t0, 30 ms sooner. The ramp only protects A's audio.
- Cold loads: the first NVIDIA compiles and the core's preprocessing, `docs/TODO.md` #48. They are ours' largest
  remaining cost over warm (240–480 ms). WE pays more here, so this is no gap to WE.
- Nothing to copy from WE's switch. It shows black for 0.5–1.2 s on every switch; ours holds A until B's first
  frame.
- Find the † loads: rerun `ours --spare` cold until one is slow. The script now records the worker's
  `load_ms` / `build_ms`, and the log tail of any load over 2 s.

## Caveats

- **Proton is not Windows.** DXVK turns WE's D3D11 into Vulkan and compiles its pipelines on first use. Wine's file
  and process layers add their own cost. Windows may be faster or slower; #97 keeps the native measurement.
- **The disks differ.** WE's install and assets are on the Windows partition (ntfs3, a different NVMe). Our worker
  and WE's assets copy that ours uses are on btrfs. The Workshop items are the same files for both. Cold and boot
  read through different filesystems.
- **The page-cache drop is not a reboot.** Pages another process maps stay (WE's own binaries, ours: the compositor),
  as for an app that is already running.
- **`complete` also catches a scene's scripted intro.** 3042492564's late text is its own script, not loading. Only a
  video or texture that arrives late is a loading cost.
- **One machine, one night, an otherwise idle desktop.** Another agent's measurements ran between these runs under
  the same test lock, never at the same time.
