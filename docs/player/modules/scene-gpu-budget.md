# Scene GPU budget and VRAM

Covers `src/player/src/scene/budget.rs`, `src/player/src/vram.rs`, the scene present gate in `redraw.rs`, the
worker's `gputimer.rs`, and the runtime's `feed_scene_budgets` / `vram_tick` with `SourceHost::suspend_media` /
`resume_media`. Rules: `.claude/rules/player/scene-gpu.md`.

## Per-output present gate

One worker serves every output, so each output's presents of the scene's frames are gated at
`eff(out:<c>.scene_fps, refresh)` (`Redraw::mark_shown_gated`, a grid of that period with `GATE_SLACK` 2 ms; a
whole period behind restarts the grid). An early frame is deferred to its slot, never dropped, so the last frame
before a pause is still drawn. An output woken by anything else shows the scene's newest frame with it.

A scene at the refresh on a frame-callback output is ungated (`scene_gate_period` = `None`) and, while its clock runs
at that rate, presents on every callback like an animation (`scene_paces_output`). Both halves are needed: the gate's
grid (1 / the rounded refresh, 6.944 ms for 143.981 Hz) drifted against the vblank and left the output presenting
off-callback (0 of 288 intervals paced for ~20 s at a time); and the worker's frames arrive on the loop's 240.000 Hz
clock against a 239.76 Hz vblank, so presenting only on a new frame left callbacks with nothing new. With both: DP-1
6.94 ms (288/288 paced), DP-2 4.17 ms (478–480/480). The presenting half has no hermetic test (no Wayland); the
on-machine `src/player/tests/onmachine/scenes.sh outputs` step guards it.

## The budget (`scene::budget::Budget`, pure)

The scene ticks at min(demand, the budget's cap). Every `OBSERVE_EVERY` (500 ms, real clock) `observe` gets
`missed_pct`, the worker's `gpu_ms_p50` and `fps_actual`:

- **Throttle** when misses > `THROTTLE_MISSED_PCT` (2 %) and `gpu_ms_p50 × fps_actual ≥ GPU_LOAD_MS_PER_S`
  (400 ms/s — a worker using < 40 % of the GPU is never the cause): cap = max(`FLOOR_FPS` 10, fps_actual / 2), then
  no further cut for 2 s so the miss window holds only frames made at the new rate.
- **Recover** after `RECOVER_AFTER` (5 s) calm (< 0.5 %): × `STEP_UP` (1.25) per calm 5 s; reaching the demand lifts
  the cap. `player.scene_throttle` false lifts any cap at once.
- `missed_pct` is the worst over every output's paced window (the GPU is shared: a heavy worker on one output cost
  another output's 240 Hz video 71 missed frames in 2 s while the scene's own output looked fine), plus the scene's
  own deficit — a worker latching under `DEFICIT_RATIO` (90 %) of its tick rate over a whole 2 s window — because an
  output presenting below its refresh has idle gaps between presents and `paced` never sees its misses.
- Open limit: below the 400 ms/s guard a single heavy draw (220–260 ms/s) still costs a 240 Hz output 33–38 missed
  frames per 2 s — the worker's low-priority context isn't preempted mid-draw.

GPU time: one `GL_TIME_ELAPSED` query per frame, read only once available (≤ `MAX_QUERIES` 4 in flight; all busy →
untimed), never waited on. A driver refusing queries turns it off and the budget then never throttles.

## Per-scene VRAM guard (`player.scene_vram_limit_mib`, 0 = off)

A worker over the limit for 2 s (a load's transient peak isn't a reason) is stopped, not crashed:
`scene.vram_exceeded` (an outbox fact), `SourceEvent::Error` with a reason ending `(vram_exceeded)` so the backend
advances a rotation without marking the item crashed; no restart, no record. The last frame stays shown from one
imported slot: a dmabuf lives while anyone holds it, so keeping the whole ring kept ~3 × the export size of GPU
memory alive; the other slots are dropped and their queued frames forgotten. A `path` change starts a new worker;
raising the limit doesn't restart a stopped one.

`player.scene_vram_stop_shows` `nothing` hides that slot instead (`SceneSource::shows_nothing`: `texture()` is
`None`, so the outputs draw what an empty output draws, black; a rotation's effect runs from black). The slot is
kept, one frame at the export size, so switching back to `last_frame` on a stopped scene shows its frame again; the
seam probe doesn't count the deliberate blank (`note_composed`).

### What scenes use

The `vram` probe's `scenes[].used_mib` (NVML, the worker's own process) for 96 Workshop scenes, each alone on a
private headless player at 1920×1080, the highest of 8 one-second samples after Ready (a scene's samples lie within 3 %
of each other). Median 517 MiB, p90 1503, p95 2103, max 3832; ≤ 1 GiB: 79 (82 %), ≤ 1.5 GiB: 87 (91 %), ≤ 2 GiB: 90
(94 %). At 3840×2160 the ten scenes between 1.2 and 2.3 GiB used 26–67 MiB more (the bigger export ring), none
crossing 2 GiB that hadn't already. Hence the backend's default cap of 2 GiB (`AppSettings.SceneVramLimitMib`).
Workshop id and MiB, highest first:

```
3233141951 3832, 2921510865 3642, 3509243656 3047, 3042865984 2209, 3326873240 2103, 3516174947 2075
3414858021 1693, 2883756643 1651, 3243449890 1631, 3219908811 1503, 3163060610 1456, 2388299037 1451
3363252053 1429, 3042492564 1181, 3419466417 1078, 3463520581 1045, 3479521040 1025, 3046119914 1013
3022080536 861, 3104056709 846, 3276522107 842, 1864677589 836, 2932157836 806, 1195626192 799
2325974975 797, 3366535880 796, 3184155462 782, 3489263099 775, 3013489778 773, 2064316482 748
3174556087 745, 3289734539 732, 2511663284 723, 3490034653 695, 2890767643 670, 2375914945 661
3319542538 615, 2542468435 610, 3445973124 601, 3432876246 600, 3395587987 592, 2679248947 589
3089687436 582, 2134765860 564, 3028473503 537, 2561227934 530, 3516106265 524, 3556794116 524
3480481965 509, 2815800031 488, 1556245028 478, 3749550751 468, 3413117423 468, 2886313155 466
3354740764 464, 2694785040 440, 3019192537 432, 2672425887 387, 2288455459 382, 3422383300 365
3426575339 356, 1264170639 322, 2469881470 319, 3029971128 316, 2828233985 311, 2371103399 308
3134525336 302, 3432999904 301, 3309103316 282, 2189783622 280, 2290002190 272, 3023509773 272
3291729669 266, 2683776412 264, 1160682576 244, 2951169110 227, 2783122117 214, 3422085307 196
1797172968 191, 3477054430 184, 2905264428 180, 1934084447 172, 3291745179 154, 1155728109 136
1174926427 128, 1726902114 125, 1884904087 121, 2182433068 120, 3387433141 106, 2219762084 106
3478602089 103, 2638125030 102, 2679885269 101, 3593587273 81, 2047150134 65, 3461192631 47
```

## Measuring VRAM (`vram.rs`)

`LIASCAPE_PLAYER_VRAM_PROBE`: `auto` (default: the first that works of) NVML (`libnvidia-ml.so.1` dlopened by soname,
then `/run/opengl-driver/lib` and the usual lib dirs — never linked; memory info of the GPU our pid runs on plus
graphics and compute processes per pid) → DRM (AMD `mem_info_vram_*` sysfs; per process `/proc/<pid>/fdinfo`
`drm-*` regions, AMD and Intel) → `nvidia-smi` (its plain process table; `--query-compute-apps` never lists a GL
client like ours) | `nvml` | `drm` | `nvidia-smi` | `none` | `fake:<file>` (tests). An Intel GPU exposes no system
total, so neither rule acts there. The probe runs on `lia-vram` every second (NVML ~1 ms, `nvidia-smi` ~50 ms) and
only while a rule needs it; the loop reads the newest sample. Test servers run with `none` unless they set a fake.

## The low-VRAM rule (`vram::LowVram`, pure) and its hold

`player.vram_low_mode` = `stop` (default) | `pause` | `off`. Low = free < max(512 MiB, 5 % of total) for 3 s →
engage. Free again = free − reserve ≥ low + 256 MiB for 10 s → release; a dip restarts the hold. The
reserve is what our resumed sources will take back (our processes' VRAM at the engage, matched by pid: the
compositor, its scene workers, its spare, never another `liascape-player`; or the rise of free VRAM in the 2 s after
the stop; 0 for `pause`), so memory we freed never reads as free — no stop → resume → low loop. The margin is small on
purpose: a wider bar leaves a 3.6 GB scene on an 8 GB card unable to resume after a dip,
and anti-flap below is the loop guard. An
engage within `FLAP_WINDOW` (60 s) of the last release doubles the resume hold (≤ `RESUME_HOLD_MAX`, 160 s). No sample
for `UNAVAILABLE_RELEASE` (30 s) while engaged releases: a dead probe never keeps the wallpaper stopped. Test timing:
`LIASCAPE_PLAYER_VRAM_TIMING=<interval>,<enter>,<resume>,<settle>,<scene_hold>` (ms).

The hold (real clock only) composes into the effective pause, so the pause gates ramp the audio and time freezes,
while `player.paused` — the user's — is never written. `stop` then, once the gates settled, drops every
video/image/scene source's decoder or worker through the normal two-phase teardown; each node stays and shows a
`SnapshotSource` still of its last frame, and media nodes created meanwhile wait unopened. Release reopens each at
the position it had, effectively paused, its stand-in shown and its `Ready` held back until its first frame; the hold
goes once none is pending (or after 5 s) and the ordinary flow-gated resume follows. Mode changes are live (`off`
releases; `pause` → `stop` frees now; `stop` → `pause` gives sources back and stays paused). A scene's worker after a
resume is a new process, not a crash.

The reserve follows the held sources (`Runtime::vram_follow_hold`, every tick while held). `settle` after the stop
each stopped source gets a share: a scene its worker's VRAM at the engage, the videos and images what the compositor
freed (its use then − now) plus the spare's; without per-process numbers the measured reserve split evenly. A source
on its way out (`Runtime::vram_gone`: the A a live transition is replacing on every output it shows, a handed-off B whose
handoff still settles included; a grave; a retired or destroyed one) drops
its share at once (`LowVram::set_reserve` re-judges against the newest sample) and is never reopened: it stays its
still until its node goes, and to an `align: end` switch off it, it has ended (forgotten if it is wanted again and reopens). A source created while held waits with
no share. So a switch made during a hold plays as soon as the memory there is fits it, never held for memory its
replaced sources would have taken back. `stop` clears the hold and starts the rule over.

What the hold keeps from playing and how much free VRAM it waits for (`needed_mib` = the resume bar + the reserve) is
in `hello.vram_hold` / `state.vram_hold`, the `vram` probe's `hold`, and the events `vram.held` (again whenever the
sources or `needed_mib` change, or free VRAM moved 32 MiB) and `vram.released {reason: free | no_sample | off | stopped}`. The backend shows it on
the now-playing line (WS `vram-hold`, `/current.vramHold`).

## Worker CPU

The `workers` probe's `cpu` (the worker's `utime + stime` from `/proc/<pid>/task/*/stat`, threads summed by name,
cumulative) gives a rate from two probes. Measured (release, 1920×1080@144, `scene_fps` 30): a scene with sound 6.0 %
of a core (renderer 3.5, PipeWire data loop 2.2), lighter scenes 1.2–2.6 %. The render thread dominates (NVIDIA's GL
driver ~54 % of the worker's samples, LWE ~25 %); the player's own DSP is ≈ 0.2 % of a core. A scene's CPU is LWE's
per frame and linear in `scene_fps`.
