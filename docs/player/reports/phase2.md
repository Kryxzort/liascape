# liascape-player Phase 2 — on-machine battery report (Task 14)

Branch `liascape-player` (worktree of the Task 14 run), battery on `4f1040f` + the fixes it found (§ 10). Builds per step:
step 1 on `0743b77` (F1); steps 3 and 4 (before) on `5139419` (F1–F3); steps 4 (after) and 6 on `9550127` (+ F5); steps 2, 5
and 7 — the final numbers — on `d7d412b` (every fix). Release builds throughout. Machine: i9-12900K, RTX 3070 Ti (NVIDIA 595.84), Hyprland 0.56.2, DP-1 143.981 Hz +
DP-2 239.760 Hz (1920×1080 each), PipeWire 1.6.9. Run 2026-10-28/29 overnight, unattended, while other agents'
test lanes shared the machine (load 2–4; one other lane's `liascape-player` was on the GPU during steps 4–5).

**Battery:** `src/player/tests/onmachine/scenes.sh` (+ `scenes_steps.sh`; also `battery.sh scenes <step…>`) —
`outputs | dropout | crash | budget | workers | pause | soak`. Its own `liascape-player serve` (private runtime/state dirs,
socket, instance lock; `RLIMIT_CORE` 1), on the real Wayland session for steps 1, 3, 4, 5, 7 and on headless outputs
(60 Hz / 240 Hz) for steps 2 and 6. **No audio ever reached the owner's speakers:** every step runs a private,
hermetic PipeWire + WirePlumber (the `PrivatePw` recipe — own dirs, `policy` profile, one null sink — plus
`libpipewire-module-rt`, so its graph is real-time like the session's) and points the bus, mpv, the scene workers and
the visualiser tap at it; the visualiser's test noise is played into that private graph (the plan's "a `pw-play` tone
on the default sink" — deviation, deliberately). Results (gitignored): `src/player/tests/onmachine/results/phase2/`
(`<step>.json` = every check `{name, value, bound, pass}`; `dropout-switches.jsonl` = every switch;
`soak-samples.jsonl`; images). Test media: synthetic (ffmpeg clips, `liascape-synthetic.json` scenes) and the SFW Workshop
folder `~/.local/share/Steam/steamapps/workshop/content/431960` only.

## Summary

| step | verdict | the numbers |
|---|---|---|
| 1 outputs | **PASS bar worker CPU** (26/31) | paced 6.94 / 4.17 ms on DP-1 / DP-2 for all four scenes at `scene_fps 0` (after fix F1); pixels, pointer, visualiser PASS; worker CPU < 5 % only for the synthetic and Emilia at 30 fps — real scenes cost what LWE costs (§ 1.3) |
| 2 dropout | **PASS bar one micro-gap** (38/39) | 720 switches at 60 + 240 Hz, V→S / S→V / S→S × full-live / reveal / frozen + align end, synthetic and real (Kimi) scenes: 720 done, **0 drops**, **1 micro-gap** (3 ms, 240 Hz S→S frozen — F7), onset worst +1.1 dB (bound +6); run 1 had 9 drops + 1 gap, all detector artefacts (F2) |
| 3 crash isolation | **PASS** (56/56) | 5 SIGKILLs + 2 hangs per scene, crash loop → broken: DP-1 p95 7.87–8.35 ms vs baseline 8.10–8.17, missed ≤ 1; DP-1 tone 0 drops; DP-2 held (grim identical); recovery 0.12–0.13 s synthetic, 0.20–0.25 s real |
| 4 GPU budget | **FAIL** (2/5) | throttles in 1.2 s at 6.2 ms/frame, `scene_throttle` off lifts it live; but DP-2's 240 Hz clip misses frames with any heavy single-draw worker (p95 6.9–9.1 ms) — finding F5 (budget part fixed, the rest open) |
| 5 several workers | **PASS bar mid-transition CPU** (3/4) | distinct real scenes + S→S on both outputs: done 2/2, old workers reaped; compositor CPU per worker steady **0.1 %** (bound 0.6; was 2.9 % before F6), but 2.75–4.05 % per worker mid-fade with 4 workers (open, F6b) |
| 6 pause (scripted scene) | **PASS** (6/6) | held identical through 10 s; synthetic: next seq exactly +1, scene time +0.12 s; Bunk (32 scripts): first frame after the resume differs from the last before as much as one unpaused frame does |
| 7 soak 1 h | **PASS** (5/5) | 116 switches, all `transition.done`; RSS slope **0.174 MiB/min** after 10 min (bound 0.5; plateau 323–450 MiB); ≤ 2 live workers at all 691 samples; per-worker VRAM identical across 19 plays each; no worker 2 s after `ctl stop`; 0 warn events |
| 8 VT switch / suspend | not run (owner) | checklist § 8 |
| corpus A/B vs legacy | **0 regressions** | 96 scenes: 90 ok, 1 static (by design), 3 load_failed (the known 3D scenes), 2 timeouts under load 12–14 (both ready alone: 6.1 / 1.5 s); legacy starts 54 of 96 — **none starts under legacy but not here**, 37 start here but not under legacy |

**Product findings: 7** (§ 10) — F1 scene pacing at the refresh (fixed), F2 the dropout detector's ramp-edge
bins and the meter's missed cycles (fixed), F3 the bus meter not real-time (fixed — its remaining gaps proven
measurement-only), F5 the GPU budget blind to other outputs (fixed in part), F6 compositor CPU per worker (fixed for
the steady state, 2.9 → 0.1 %; mid-transition open), F4 real scenes' worker CPU (open), F7 one frozen-handoff
micro-gap (open) — plus a corpus-runner bug that hid every scene failing under legacy (§ 9, fixed). Battery-script bugs found and fixed while running it are
listed in § 11 (none of them changed a product verdict).

## 1. Outputs (step 1)

`scenes.sh outputs`: baselines first (compositor CPU, 5 s): a 240 fps clip on both outputs **55.8 %** of a core (the
plan's "video baseline"), a colour with an opacity animation (same presents, no decode) **26.8 %**. Then per scene:
shown on both outputs, `out:*.scene_fps 0` (= each output's refresh; the worker ticks at the max, 240), 2 s settle,
5 s measurement.

### 1.1 Pacing — PASS after fix F1

| scene | DP-1 paced mean / p95 / missed (n) | DP-2 paced mean / p95 / missed (n) |
|---|---|---|
| synthetic `frame_index` | 6.943 / 7.97 / 0 (288) | 4.169 / 5.03 / 1 (480) |
| 1726902114 (Emilia, 2048×1423) | 6.939 / 8.16 / 0 (288) | 4.169 / 4.89 / 2 (480) |
| 2371103399 (Kimi, 3840×1080, sound) | 6.943 / 8.19 / 0 (288) | 4.179 / 5.10 / 2 (478) |
| 2134765860 (Bunk, scripts + visualiser) | 6.939 / 8.30 / 0 (288) | 4.175 / 5.09 / 1 (479) |

Bound 6.9 ± 0.5 / 4.2 ± 0.5 ms, n ≥ 50: all PASS. **RED before F1** (same run, base build): DP-1 had **0 of 288**
paced samples for ~20 s windows at a time and DP-2 presented at 235–239.5 fps with ~100 idle gaps per second — the
per-output present gate's grid (1 / the *rounded* refresh) drifted against the vblank, so every few frames a scene
frame landed just after a callback and waited a whole period (§ 10 F1).

### 1.2 Pixels, pointer, visualiser — PASS

- grim of both outputs with our surfaces on the overlay layer: Emilia / Kimi / Bunk luma sd 42–67, top colour share
  ≤ 0.8 % (non-blank); the synthetic `frame_index` (99.7 % one grey by design) showed its grey (32, 32, 32) at the
  centre on both outputs.
- `pointer_dot`: the cursor warped onto DP-1 (overlay), to (480, 270), off to DP-2 → `out:DP-1.pointer`
  `[480, 270, 0]` and the dot drawn at exactly (480.0, 270.0) of the 1920×1080 ring.
- Bunk (wants audio input): `input_dbfs` **−96 → −30.2** with pink noise playing (bound > −40), its picture's mean
  frame-to-frame difference **0.026 vs 0.003** quiet (bars moving; bound > × 1.5).

### 1.3 CPU — worker over budget on real scenes (finding F4); compositor PASS

| scene | worker CPU at 240 fps (`scene_fps 0`) | at 30 fps (default) | compositor − video baseline | − animation baseline |
|---|---|---|---|---|
| synthetic | **4.0 %** | **1.2 %** | −27.2 % | +1.8 % |
| Emilia 1726902114 | 7.2 % ✗ | **2.2 %** | −26.2 % | +2.8 % |
| Kimi 2371103399 (sound) | 26.0 % ✗ | 10.2 % ✗ | −27.2 % | +1.8 % |
| Bunk 2134765860 (visualiser) | 25.6 % ✗ | 6.6 % ✗ | −21.8 % | +7.2 % (incl. `lia-sysmon`) |

Bound: worker < 5 %, compositor ≤ +1 % per worker vs the video baseline (all PASS — a scene costs the compositor far
less than decoding a 240 fps clip; against the decode-free animation baseline a worker adds 1.8–2.8 %, Bunk 7.2 %
with the visualiser tap). **The worker bound holds for the synthetic and for Emilia at 30 fps only.** For scale, the
installed legacy `linux-wallpaperengine` (one process rendering and presenting, `--silent`, DP-1 only):

| scene | legacy at 30 fps | legacy at 144 fps | liascape-player worker per frame | legacy per frame |
|---|---|---|---|---|
| Emilia | 1.6 % | 4.4 % | 0.30 ms (240 fps) / 0.73 ms (30) | 0.31 ms (144) / 0.53 ms (30) |
| Kimi | 5.8 % | 15.0 % | 1.08 ms (240) / 3.4 ms (30, **with its sound**) | 1.04 ms (144) / 1.9 ms (30, silent) |
| Bunk | — exits at start | — | 1.07 ms (240) / 2.2 ms (30, with the visualiser) | — (LWE terminates: `json type_error.302`) |

So per rendered frame the worker costs what LWE itself costs (the main render thread ≈ 0.8 ms of CPU per frame for
Kimi/Bunk); the excess at 30 fps is the scene's sound (Kimi: PipeWire data thread ~2 %, decode + stretch) and the
visualiser (Bunk). The < 5 % bound came from the transport spike's trivial frame and can't hold for heavy real scenes
at 240 fps; the default 30 fps is what the owner runs. Finding F4 (open): the audio path's share (decode at 1×
through LWE's own resampler + our stretch passthrough) and a per-scene CPU line in the `workers` probe.

## 2. Dropout matrix (step 2)

`scenes.sh dropout`: headless outputs (one 640×360 output at 60 Hz, then at 240 Hz, `--debug` so every
`transition.done` runs the reference dropout detector, `probe dropout`), the player's own bus + meter on the private
real-time PipeWire. Media: a 440 Hz video (6 s, looping; a 3 s one for align end), synthetic tone scenes (660 / 550 Hz,
−20 dBFS), and at 240 Hz the SFW scene with sound 2371103399 (Kimi) against the video and against a synthetic scene.
20 switches per direction and cell (10 for the real-scene cells), fade 1 s; `V↔S` alternates V→S and S→V. Per switch:
`transition.done`, the detector's `drops` / `micro_gaps` / (new, F2) `unmeasured`, and the **onset check** — the loudest
1 ms of the first 10 ms after B's ramp-in started ≤ max(settled, level before) + 6 dB.

**Final run (build `d7d412b`): 720 switches — 720 done, 720 analysed (fit ok), 0 onset timeouts, drops 0,
micro_gaps 1, onset over +6 dB 0** (worst margin +1.1 dB). 38 of 39 cells PASS; the FAIL is one 3 ms micro-gap in
240 Hz S→S frozen (F7). Per cell, the three runs (run 1 = the base detector; run 2 = with F2; final = F2 + F3 + F6):
drops / micro_gaps / unmeasured (run 1 has no `unmeasured` yet — its column counts switches with a meter timestamp
jump > 1.6 ms):

| Hz | cell | method/align | n | run 1: drops/gaps/unmeas. | run 2 (F2): drops/gaps/unmeas. | final (F2+F3): drops/gaps/unmeas. | worst onset margin (dB) | verdict |
|---|---|---|---|---|---|---|---|---|
| 60 | SS S→S | full-live/now | 20 | 0/0/20 | 0/0/20 | 0/0/20 | +0.1 | PASS |
| 60 | SS S→S | reveal/now | 20 | 0/0/20 | 0/0/20 | 0/0/20 | -6.6 | PASS |
| 60 | SS S→S | frozen/now | 20 | 3/0/20 | 0/0/22 | 0/0/20 | -9.9 | PASS |
| 60 | VS S→V | full-live/now | 20 | 0/0/20 | 0/0/24 | 0/0/20 | +0.0 | PASS |
| 60 | VS S→V | reveal/now | 20 | 0/0/20 | 0/0/22 | 0/0/20 | -36.1 | PASS |
| 60 | VS S→V | frozen/now | 20 | 1/0/2 | 0/0/22 | 0/0/20 | -9.6 | PASS |
| 60 | VS V→S | full-live/now | 20 | 0/0/1 | 0/0/24 | 0/0/9 | +0.0 | PASS |
| 60 | VS V→S | reveal/now | 20 | 0/0/1 | 0/0/7 | 0/0/4 | -6.5 | PASS |
| 60 | VS V→S | frozen/now | 20 | 4/0/0 | 0/0/17 | 0/0/6 | -10.2 | PASS |
| 60 | VSend V→S | full-live/end | 20 | 0/0/0 | 0/0/5 | 0/0/6 | +0.1 | PASS |
| 60 | VSend V→S | reveal/end | 20 | 0/0/0 | 0/0/0 | 0/0/0 | -7.1 | PASS |
| 60 | VSend V→S | frozen/end | 20 | 0/0/0 | 0/0/0 | 0/0/0 | -10.1 | PASS |
| 60 | VSend-return S→V | full-live/now | 20 | 0/0/20 | 0/0/20 | 0/0/20 | +0.0 | PASS |
| 60 | VSend-return S→V | reveal/now | 20 | 0/0/20 | 0/0/21 | 0/0/20 | -36.3 | PASS |
| 60 | VSend-return S→V | frozen/now | 20 | 0/0/6 | 0/0/21 | 0/0/20 | -9.6 | PASS |
| 240 | SS S→S | full-live/now | 20 | 0/0/20 | 0/0/20 | 0/0/20 | +0.1 | PASS |
| 240 | SS S→S | reveal/now | 20 | 0/0/20 | 0/0/20 | 0/0/20 | -1.2 | PASS |
| 240 | SS S→S | frozen/now | 20 | 0/0/20 | 0/2/20 | 0/1/20 | -10.1 | FAIL |
| 240 | SSreal S→S | full-live/now | 20 | 0/0/20 | 0/0/20 | 0/0/20 | +1.1 | PASS |
| 240 | SSreal S→S | reveal/now | 20 | 1/0/20 | 0/0/20 | 0/0/20 | -1.0 | PASS |
| 240 | SSreal S→S | frozen/now | 20 | 0/0/20 | 0/0/21 | 0/0/19 | -10.2 | PASS |
| 240 | VS S→V | full-live/now | 20 | 0/0/20 | 0/0/20 | 0/0/20 | -0.0 | PASS |
| 240 | VS S→V | reveal/now | 20 | 0/0/20 | 0/0/22 | 0/0/21 | -36.2 | PASS |
| 240 | VS S→V | frozen/now | 20 | 0/1/13 | 0/0/22 | 0/0/24 | -9.7 | PASS |
| 240 | VS V→S | full-live/now | 20 | 0/0/2 | 0/0/1 | 0/0/4 | +0.1 | PASS |
| 240 | VS V→S | reveal/now | 20 | 0/0/0 | 0/0/12 | 0/0/7 | -1.3 | PASS |
| 240 | VS V→S | frozen/now | 20 | 0/0/0 | 0/0/17 | 0/0/6 | -10.0 | PASS |
| 240 | VSend V→S | full-live/end | 20 | 0/0/0 | 0/0/15 | 0/0/9 | +0.1 | PASS |
| 240 | VSend V→S | reveal/end | 20 | 0/0/0 | 0/0/0 | 0/0/0 | -1.4 | PASS |
| 240 | VSend V→S | frozen/end | 20 | 0/0/0 | 0/0/0 | 0/0/0 | -9.9 | PASS |
| 240 | VSend-return S→V | full-live/now | 20 | 0/0/20 | 0/0/21 | 0/0/21 | +0.0 | PASS |
| 240 | VSend-return S→V | reveal/now | 20 | 0/0/20 | 0/0/21 | 0/0/20 | -36.3 | PASS |
| 240 | VSend-return S→V | frozen/now | 20 | 0/0/20 | 0/0/21 | 0/0/20 | -9.8 | PASS |
| 240 | VSreal S→V | full-live/now | 10 | 0/0/10 | 0/0/12 | 0/0/10 | +0.6 | PASS |
| 240 | VSreal S→V | reveal/now | 10 | 0/0/10 | 0/0/10 | 0/0/10 | -36.3 | PASS |
| 240 | VSreal S→V | frozen/now | 10 | 0/0/10 | 0/0/10 | 0/0/11 | -9.9 | PASS |
| 240 | VSreal V→S | full-live/now | 10 | 0/0/1 | 0/0/0 | 0/0/0 | +0.0 | PASS |
| 240 | VSreal V→S | reveal/now | 10 | 0/0/1 | 0/0/1 | 0/0/0 | -1.3 | PASS |
| 240 | VSreal V→S | frozen/now | 10 | 0/0/0 | 0/0/0 | 0/0/1 | -44.1 | PASS |

**RED → GREEN.** Run 1's 9 drops (frozen V→S ×4, S→V ×1, S→S ×3 at 60 Hz, SSreal reveal ×1 at 240 Hz) and 1
micro-gap were all the detector's (F2): every drop sat on the first bin of B's ramp-in, 3 ms late against A's lag,
and the micro-gap right after a meter timestamp jump. With F2 they are gone (runs 2 and final: 0 drops in 1440
switches).

**`unmeasured` (the meter's own missed cycles) — measurement, not audio:** 571 → 508 stretches in 720 switches (491
switches), one per switch that tears a scene's stream down (S→V, S→S: 20/20), at 24–27 ms after that worker stopped
— its stream leaving the graph. Proof that the audio is continuous there (`e9`, a private RT PipeWire, 3 rounds of a
full-live S→S): an independent `pw-record` of the sink shows B's steady 550 Hz tone across the instant the meter's
timestamps jump (2.3–5 ms) with no phase step above 0.02 rad over ~2.5 s — one skipped 64-frame graph cycle would step
it by 1.68 rad. So the graph never skipped; the meter's capture did. F3 (the meter on the RT data thread) removed the
`lia-bus` main loop as one cause (571 → 508) but not this one; the detector simply doesn't judge those few ms.

## 3. Crash isolation (step 3) — PASS (56/56)

DP-1: a 240 fps clip with a steady 440 Hz tone (on the private bus); DP-2: the scene; our surfaces on the overlay
layer. Per scene seven events ≥ 21 s apart (kill, kill, hang, kill, hang, kill, kill — the budget is 3 restarts per
60 s, never broken here; a hang = SIGSTOP, the host's 2 s heartbeat kills it), then a synthetic crash loop
(`crash_after_ms 1200`) to broken. Per event, the 2.2 s after it:

| scene | DP-1 paced p95 (baseline) | DP-1 missed (baseline) | DP-1 tone: 10 ms bins ≥ 15 dB under | DP-2 grim held | recovery (`worker.exited` → `scene.resumed`) |
|---|---|---|---|---|---|
| synthetic ×7 | 8.08–8.35 ms (8.17) | 0–1 (2) | 0 (level −23.0 dB, meter step ≤ 1.00 ms) | identical, 7/7 | **0.122–0.134 s** (bound 0.5) |
| 1726902114 ×7 | 7.87–8.31 ms (8.10) | 0–1 (0) | 0 | identical, 2/2 hangs (on the 5 kills the new worker's frame latched before the 2nd grim — n/a) | **0.204–0.249 s** (bound 2) |
| crash loop → broken | worst window 8.13 ms | 1 | 0 | identical after `source.broken` (`restarts: 3`, `shows: last_frame`) | no live worker after |

(p95 ≤ baseline × 1.10 and missed ≤ baseline + 1: every event PASS. The tone check reads the bus meter directly —
`meter.window` 10 ms power bins vs their median — since the dropout detector's windows are per transition.)

## 4. GPU budget (step 4) — FAIL, finding F5

DP-2 plays a 240 fps clip (no scene), DP-1 a synthetic worker with `gpu_work` calibrated from its own
`GL_TIME_ELAPSED` (`gpu_ms_p50`), `out:DP-1.scene_fps 0` (demand 144). Baseline without a scene: DP-2 paced p95
4.59–4.66 ms, 0–3 missed / 2 s; loop tick p99 0.20–0.57 ms.

| | before F5 (`budget.before-fix.json`) | after F5 (final) | bound |
|---|---|---|---|
| calibration: `gpu_work` 2500 → | 3.94 ms at 63 fps | 4.09 ms at 58 fps | (spike: ≈ 3 ms) |
| ~3.7 ms/frame: throttled? | yes, to 75 fps (its own deficit) | yes, to 60 fps | no throttle ✗ |
| ~3.7 ms/frame: DP-2 paced p95 / missed | 7.36 ms / 28 | 6.92 ms / 33 | ≤ 4.6 ms ✗ |
| ~6.2 ms/frame: `scene.throttled` after Ready | 1.21 s (missed_pct 26.8 = its own deficit) | 1.23 s (**missed_pct 72.6** = DP-2's misses) | ≤ 4 s ✓ |
| ~6.2 ms/frame, after: scene fps / DP-2 p95 / missed | 54 fps (eased back up) / 8.66 ms / 71 | 43 fps / 9.05 ms / 38 | p95 ≤ 5.0 ms ✗ |
| loop tick p99 / max (explicit sync off) | 1.86 / 3.97 ms; 1.88 / 6.33 ms | 1.35 / 3.97 ms; 1.58 / 6.14 ms | recorded |
| `scene_throttle` off → cap lifted, 144 fps | ✓ | ✓ | ✓ |

What this shows: (1) the GPU here can't do what the spike did — `gpu_work` 2500 took ~4 ms (spike ≈ 3) and the
worker reached only 58–63 fps of its 144 demand by itself; the card sat in P3 at 1140 of 2100 MHz with another lane's
player on it, so "3.7 ms at 144 fps without a throttle" isn't reachable in this state. (2) **A heavy single-draw
worker costs the 240 Hz output frames at only 220–260 ms/s of GPU** (the worker's low-priority context isn't
preempted mid-draw on NVIDIA; with explicit sync off each swap waits for the GPU on the loop — the 4–6 ms tick
maxima). (3) **The budget was blind to it (fixed, F5):** it read only the outputs showing the scene, so DP-2's
misses never counted and after the first cut it eased the cap back up while DP-2 kept missing (71 / 2 s). Now it
reads every output (the throttle event's `missed_pct` 72.6 is DP-2's), but it stops cutting at its GPU-load guard
(400 ms/s), above where this machine already drops frames — open, § 10 F5.

## 5. Several workers (step 5) — function PASS, transport FAIL (finding F6)

- Emilia on DP-1 + Bunk on DP-2 (two workers, 30 fps each), then **S→S on both outputs at once** (DP-1 → Kimi,
  DP-2 → Emilia, fade 1.5 s): both `transition.done`, then exactly 2 live workers, `reaping` 0, no
  failed/cancelled event. PASS.
- Transport — compositor CPU against a decode-free baseline with the same presents (synthetic `frame_index` workers,
  no audio, `scene_fps 0`), 5 s each:

  | build | 2 workers (144 + 240 fps) vs colour + animation | 4 workers mid-fade (S→S on both) vs colour → colour fade |
  |---|---|---|
  | before F6 (`workers.before-fix.json`) | 29.2 vs 23.4 % → **2.9 % per worker** | 49.6 vs 35.8 % → 3.45 % per worker |
  | final, run 1 | 29.8 vs 29.6 % → **0.1 %** | 48.6 vs 32.4 % → 4.05 % |
  | final, run 2 | 28.8 vs 28.6 % → **0.1 %** | 47.0 vs 36.0 % → 2.75 % |

  Bound 0.6 % (the spike's 0.54 % at 144 fps measured the scene `update`'s thread time, not the whole process).
  Steady state PASS after F6 (the per-frame graph mirror); mid-transition still over — § 10 F6. The baselines alone
  vary 23–36 % between runs, so single numbers are ±1–2 %.

## 6. Pause on a scripted scene (step 6) — PASS (6/6)

Headless 1920×1080@60, `scene_fps 5` (so a capture right after the next frame latched is that frame), the player's
own pause (`player.paused`), 10 s:

| scene | held through 10 s (capture diff) | latched scene time before → after | first frame after vs last before | controls |
|---|---|---|---|---|
| synthetic `frame_index` | 0.0000 | 13.412 → 13.534 s (+0.12, not +10) | marker 67 → **68** (exactly the next seq) | — |
| Bunk 2134765860 (32 scripts) | 0.0000 | 13.812 → 13.823 s | diff 0.008 | one unpaused frame 0.002, 10 s apart 0.009 |

Patch 0005 (timers on the scene clock) holds: no burst of fired timers, no clock jump. Bunk's picture changes little
over 10 s anyway (its 10 s-apart diff is only 0.009), so its picture check is weak; the scene-time check carries it.

## 7. Soak (step 7)

`scenes.sh soak --minutes 60` on both real outputs (final build `d7d412b`): six items in rotation — a 1080p30 clip
with a 440 Hz tone, a synthetic `frame_index` scene with a 550 Hz tone, Emilia 1726902114, a 720p60 clip with a
330 Hz tone, a synthetic 2560×1440 `split_tb` scene, Kimi 2371103399 (sound) — one `transition out:*` every 30 s, the
method rotating full-live → reveal → frozen and the effect over `fade`, `crosswarp`, `wipeLeft`, `Dreamy`,
`circleopen`, `directionalwarp`. Sampled every 5 s: the compositor's VmRSS/HWM, the workers (probe + `pgrep -P`), the
`vram` probe's per-process MiB and `nvidia-smi -q -d PIDS`.

| check | value | bound | |
|---|---|---|---|
| every switch `transition.done` (each corr read 30 s on) | 116 switches, 115 read: 115 done | all | PASS |
| compositor RSS slope after the 10 min warm-up | **0.174 MiB/min** (0.211 over the whole hour); 266.5 MiB at start, plateau from 10 min: min 320–324, max 448–450 MiB per 10 min | ≤ 0.5 MiB/min (Phase 1: 0.31) | PASS |
| live workers per sample | max 2, never above 2 + dying (691 samples) | ≤ 2 + dying | PASS |
| per-worker VRAM across plays (`vram` probe, NVML) | synthetic 33.06 / 33.06 MiB, Emilia 124.25, Kimi 274.31 — identical in all 18–19 plays | ± 10 % | PASS |
| workers 2 s after `ctl stop` | none | none | PASS |
| warn+ events in the log ring at the end | none | — | — |

An earlier soak on `5139419` (before F6) is kept as `soak*.run1.*`: same workers/VRAM result, RSS −1.9 MiB/min (its
peak fell from 447 to 377 MiB over the hour); its two "FAIL"s were the battery's own (an absolute-value slope bound;
switch outcomes read from `.event` instead of `.kind`), fixed before this run.

## 8. Owner-run checklist (VT switch / suspend — run 2026-10-29, see the results at the end)

The battery never suspends, switches VTs or logs out. These are what the robust worker context
(`gfx.context_robust`, `EGL_GENERATE_RESET_ON_VIDEO_MEMORY_PURGE_NV`) and the crash policy are
built for; they can only be checked by hand. With `liascape-player` as the engine and a real scene
playing on both outputs (e.g. 2371103399 — it has sound — on DP-1, 1726902114 on DP-2):

1. **VT switch.** `Ctrl+Alt+F3`, wait 10 s, back to the session's VT. Expect: both outputs show
   the scene again within ~2 s; `liascape-player ctl logs '{"kind_prefix":"scene."}'` shows either
   nothing (no purge) or `scene.context_lost` → `worker.killed {why: "GL context lost"}` →
   `worker.restart` → `scene.resumed` per scene; never `source.broken`; the scene's sound comes
   back faded in (no click). `ctl probe '{"name":"workers"}'` → `context_losses` ≤ 1 per scene,
   `restarts_60s` ≤ 1.
2. **Suspend / resume.** `systemctl suspend`, wake after ≥ 30 s. Expect the same as (1): a purge
   is one restart per scene (far inside the 3-per-60-s budget), the picture before the first new
   frame is the held last frame (never black, never the desktop), the transition/rotation timers
   continue (`ctl state` → no transition stuck in `waiting_ready`).
3. **Suspend twice within a minute** (the budget edge): still no `source.broken` — two context
   losses are two restarts.
4. **Videos alongside** (a video on DP-1, a scene on DP-2) through (1)/(2): the video is
   unaffected by the scene's restart (`ctl probe '{"name":"frames"}'` on DP-1 normal right after).
5. If anything breaks: `ctl probe '{"name":"workers","args":{"log_tail":true}}'` (the worker's
   `gfx: robust context granted|not available` line and its last stderr) and
   `~/.local/state/liascape/liascape-player/crashes/*.json` — file it in `docs/TODO.md` → liascape-player.

**Results (2026-10-29, run by an agent with `sudo -n`; one scene, 2371103399, on both outputs).**
- **Suspend** (`rtcwake -m mem -s 20`, 05:55 IST): survived. The robust context did **not** report a reset
  (no `scene.context_lost`); after the wake the worker never answered its tick — most likely stuck inside a GL
  call after NVIDIA's VRAM purge, before it polls `glGetGraphicsResetStatus` — so the heartbeat took it:
  `worker.hung {waited_ms: 2003}` → SIGKILL → `worker.restart {attempt: 1}` → `worker.ready` 216 ms →
  `scene.resumed` at the held frame's `t` (74.944, exact), 0.9 s after the kill. The held frame stayed on screen
  through it; no `source.broken`. Cost vs. the designed path: ~2 s more frozen frame (the hang timeout) than a
  `context_lost` would have taken. Open: make the worker notice a purge before it blocks (TODO).
- **VT switch** (`chvt` away and back, 05:57): **Hyprland 0.56.2 aborted** on the way back — not the player.
  aquamarine's restore of both CRTCs failed (`atomic drm request: failed to commit: Invalid argument` → `drm: crtc
  64/83 failed restore`; the kernel logged `nvidia-drm … Flip event timeout on head 0`), then an app window (an
  `xdg_surface` destroy — the player only has layer surfaces) was unmapped, its close-animation snapshot
  (`makeSnapshotFB` → `beginSimple`) hit an assert with no usable render target → SIGABRT
  (`~/.cache/hyprland/hyprlandCrashReport1745.txt`; two plugins loaded). The player did what it should: its
  Wayland connection broke → `loop.failed` → exit 3 → the supervisor waited for the compositor → reconnected to
  the restarted Hyprland in 1.3 s and restored its snapshot. Workaround: avoid VT switches on this
  NVIDIA + Hyprland setup; a suspend is fine. Not re-run (it takes the session down).
- (3) suspend twice and (4) video alongside: not run.

## 9. Scene corpus — fresh run + A/B against the legacy engine

`scene_corpus.sh` (fresh, release build of this branch, LWE `40eacc9`) on the 96 scenes of the SFW folder, then
`--ab-legacy --legacy-output DP-1` (the installed `linux-wallpaperengine`, `--silent`, `SDL_AUDIODRIVER=dummy`,
`--screenshot` after 4 s, drawing on DP-1). Report regenerated: `docs/player/reports/scene-corpus.{md,json}`.

- **liascape-player:** 90 ok, 1 static (2783122117 — a still image with a sound, by design), 3 load_failed (3276522107,
  3477054430, 3509243656 — the 3D/perspective scenes `next-v2` can't parse, the known Phase 6 item),
  **2 timeout** (2883756643, 2890767643 — both `ok` in the previous run with Ready 6.7 s / 1.7 s; this run shared the
  machine with the soak and another lane's UI matrix at load 12–14: re-run alone at that load, 2890767643 readied in
  18.7 s and 2883756643 timed out again; re-run on a quiet machine (load 1.4, between the two soaks): **ready in 6.1 s and 1.5 s** — load, not the
  scene). 0 blank / broken / crashed. Ready median 1.15 s.
- **A/B:** legacy starts **54 of 96**; **0 scenes start under legacy but not here**; **37 start here but not under
  legacy** — 16 where LWE dies at start (SIGABRT ×13 — Bunk 2134765860's `json type_error.302` terminate is one —,
  SIGSEGV ×2, exit 1 ×1; three more exit-1s are the 3D scenes, which fail here too) and 21 where its 4 s screenshot
  is blank. The 5 scenes not `ok` here (2 timeouts, 3 load_failed) all fail under legacy too.
- **A corpus-runner bug found (fixed, `a5f4dab`):** a legacy run with no screenshot (LWE exited) wrote no record at
  all (`screenshot:($png | select(length > 0))` empties the whole jq object), so the first A/B silently covered only
  77 of 96 — exactly the scenes that fail under legacy were missing. Fixed, the 19 re-run, merged.

## 10. Findings

Each fix is its own commit with a test (RED → GREEN); the open ones are filed in `docs/TODO.md` → liascape-player →
"Phase 2 battery findings".

### F1 — a scene at the refresh missed every few vblanks (FIXED, `0743b77` "Pace Scenes At The Refresh On Frame Callbacks")

**Symptom (step 1, base build):** `scene_fps 0` (= the refresh) on DP-1/DP-2: DP-1 **0 of 288** paced samples for
~20 s windows at a time; DP-2 235–239.5 fps with ~100 idle gaps/s. **Cause:** the per-output present gate (Task 8)
lets a scene frame through on a grid of 1 / `eff_fps` — at the refresh that's 1 / the *rounded* Hz (144, 240), which
drifts against the real vblank (143.981, 239.760), so a frame regularly landed just after a callback and waited a
whole period (an idle gap, which also breaks the "paced" chain). Ungating alone left DP-2 presenting off-callback
(paced mean 3.4 ms). **Fix:** `redraw::scene_gate_period` returns no gate when frame callbacks pace the output and the
scene runs at (or above) its refresh, and `Runtime::scene_paces_output` makes such an output present on every
callback (like an animation) — the frame callback is the clock. **RED → GREEN:** unit
`scene_at_the_refresh_is_paced_by_frame_callbacks_not_the_gate` (RED: `Some(6.944 ms)`); on-machine DP-1 0/288 →
288/288 at 6.94 ms, DP-2 → 478–480/480 at 4.17 ms for all four scenes (§ 1.1); `per_output_scene_fps_gates_presents`
and `scene_fps_change_is_live_same_pid` still pass. Open idea (TODO): tick the worker from the frame callbacks / the
exact refresh, so content and vblank never beat.

### F2 — the dropout detector's own edges (FIXED, `9131127` "Ignore Meter Gaps And Late Ramp Edges In The Dropout Detector")

**Symptom (step 2, first run, 720 switches):** 34/39 cells; the FAILs were 10 ms "drops" ~40–50 dB under at `at_ms` ≈
1510 (frozen V→S at 60 Hz: 4 of 20) and 2 ms micro-gaps right after meter timestamp jumps. **Cause (dumps,
`probe dropout {dump}`):** (a) one lag serves the whole window; the scene B's stream reached the bus ~3 ms later than
its gain schedule while A's video pinned the lag, so B's ramp-in started 7 ms into a 10 ms bin whose expected power
mean was just audible (> −55 dB) while the observed bin was still silent — the edge of a correctly shaped ramp, not a
gap; (b) the bus meter missed graph cycles (a 2.3–7.7 ms timestamp jump — whole quanta — followed by −96 blocks),
which the micro-gap pass read as a hole. **Fix:** a drop bin needs both neighbouring expected bins audible (the 10 ms
analogue of the micro-gap pass's R94 steady neighbourhood); samples around a meter discontinuity are left out and
reported in a new `unmeasured` list. **RED → GREEN:** `tests/dropout.rs::ramp_in_a_few_ms_late_is_not_a_drop` (RED: a
drop at 1560 len 10, 50 dB — the on-machine signature), `ramp_in_that_never_comes_is_still_a_drop` (a 60 ms late onset
still is one), `meter_discontinuity_is_unmeasured_not_a_gap` (RED with the filter off: a 2 ms micro-gap at 132; a
contiguous hole still is one). Every existing detector test passes. Re-run: 38/39 (§ 2).

### F3 — the bus meter ran non-real-time (FIXED, `5139419` "Run The Bus Meter On The Real-Time Data Thread"; the main cause of its gaps turned out measurement-only)

**Symptom:** after F2, `unmeasured` stretches in 517 of 720 switches — at B's worker spawn (~20–50 ms into the window)
and at A's teardown (~1550 ms): *every* switch that tore a scene down had one. **Cause:** the meter's capture callback
ran on the bus's own `lia-bus` main loop (no `RT_PROCESS`), which also handles the registry/link churn of a stream
appearing or vanishing — the capture missed whole cycles exactly when a switch happens, so the detector was blind at
the instants that matter. The callback was already RT-safe (no allocation, `try_lock`). **Fix:** `RT_PROCESS` on the
meter's capture; the `bus` probe reports `meter.callback_thread` / `callback_policy`. **RED → GREEN:**
`tests/api.rs::meter_capture_runs_on_the_rt_data_thread` (RED: `lia-bus`, `other`; GREEN: `data-loop.0`, `rr`);
the bus/meter/scene-audio/dropout api tests 14/14. On-machine: the crash step's DP-1 meter max step 1.00 ms through
15 worker kills/hangs; the final step-2 run: 508 `unmeasured` stretches (571 before) — **F3 removed one cause, not the main one**: the rest is the capture missing cycles when another stream leaves the graph, proven measurement-only (§ 2, the `pw-record` phase check).

### F4 — real scenes' worker CPU over the 5 % bound (OPEN)

§ 1.3: per frame the worker costs what LWE costs (Kimi/Bunk ≈ 1.07 ms of CPU per frame at 240 fps, legacy LWE 1.04
at 144); at the default 30 fps Kimi 10.2 % (with its sound: decode + our stream), Bunk 6.6 % (the visualiser), Emilia
2.2 %. The plan's bound came from the transport spike's trivial frame. TODO: profile the scene-audio path at 1×, add
the worker's own CPU to the `workers` probe, re-state the bound per scene class.

### F5 — the GPU budget was blind to other outputs (FIXED in part, `9550127` "Count Every Output's Missed Frames In The Scene GPU Budget"; rest OPEN)

§ 4. **Fixed:** the budget read only the outputs showing the scene; DP-2's misses (a 240 Hz video next to a heavy
DP-1 scene) never counted and after one cut the cap eased back up (DP-2: 71 missed / 2 s). Now
`probe::frames::worst_missed_pct` over every output (unit `budget_miss_rate_is_the_worst_output_not_only_the_scenes`;
on-machine the throttle's `missed_pct` 26.8 → 72.6 — DP-2's). **Open:** (a) the throttle stops at its GPU-load guard
(400 ms/s) while one heavy draw at 220–260 ms/s already costs the 240 Hz output 33–38 missed frames per 2 s — the
worker's low-priority context isn't preempted mid-draw, and with explicit sync off each swap waits for the GPU on the
loop (tick max 4–6 ms); (b) the plan's "3.7 ms at 144 fps, no throttle" isn't reachable while the card sits in P3
(1140 of 2100 MHz) with another process on it — re-measure on a quiet machine. Real scenes' `gpu_ms_p50` is 0.95 ms
median (corpus), so this bites only very heavy scenes.

### F6 — compositor CPU per worker 2.9–3.45 % vs 0.6 % (FIXED for the steady state, `d7d412b` "Mirror Only Changed Source Values Into The Graph"; mid-transition OPEN)

§ 5. `perf` of the compositor with two synthetic workers (headless, 240 + 144 fps): the cost is not the dmabuf
transport but **graph bookkeeping** — `SourceHost::update` mirrored all nine observed props of every source into the
graph after every update (a scene updates every frame), each a `format!` + path split + resolve + `BTreeMap` insert
(top of the profile: `memcmp`, `BTreeMap::insert`, `free`, `split_path`, `format_inner`, `schema_for_kind`,
`set_observed`, `resolve`). **Fix:** each hosted source remembers what it last mirrored and skips an unchanged value
(cleared whenever a change is forwarded to it, so a refused `set` is still mirrored back). **RED → GREEN** (`perf` A/B, the same headless setup, alternating builds): process CPU 19.2 / 19.6 % → **15.4 /
15.0 %**; on-machine step 5 re-run twice: **0.1 % per worker** steady (bound 0.6 — PASS; was 2.9 %), but **2.75 /
4.05 % per worker mid-fade** (4 workers, S→S on both outputs; was 3.45) — during a transition the runtime recomputes
`srcs:` and each scene's demand on every sync (`Graph::get`, `srcs_for_connector`, path `format!`s top the remaining
profile): open, TODO F6b. Regression suites: lib 223, `sources` 32, `transition` 31, `scene` 29 (`four_workers_…`
failed once at load 12 — its documented load sensitivity — and passed alone), api subset (pause / scene / broken /
restore / snapshot / stepped) 48 — all pass.

### F7 — one 3 ms micro-gap at a frozen S→S handoff, 240 Hz (OPEN)

1 of 20 switches in the final run (2 of 20 in run 2, 0 in run 1): `at_ms` 1512–1515, 3 ms, ~60 dB under, right where
B's anti-click ramp-in starts after the handoff and ~10 ms before the meter's timestamp jump of A's stream leaving
(`unmeasured` at 1519–1525). Not resolved: it may be the scene worker's gate opening a few ms after its
`AudioFlowing` (a real 3 ms hole at B's onset — the onset check, which looks at levels, passes) or the same capture
disturbance starting a cycle before its timestamp jump. Next step: § 2's `pw-record` phase check on a frozen S→S at
240 Hz (B's tone onset instead of a steady tone) — TODO F7.

## 11. Battery-script bugs (fixed while running; no product verdict depended on them)

- `mk_clip` built a broken lavfi source when the source string already had options (`color=c=…`).
- Legacy LWE exited at once without `--assets-dir`; the battery passes liascape-player's own resolution.
- The synthetic `frame_index` scene is 99.7 % one grey by design — the pixel check reads its centre instead of the
  generic "non-blank" rule.
- A private PipeWire started from a backgrounded shell function leaked (its `$!` was the subshell's) — started
  directly now, and killed by exact pid.
- The private PipeWire ran non-real-time: its own graph missed cycles under load (meter steps 2.3 ms with −96 blocks
  in between, the whole graph at once) — `libpipewire-module-rt` added (data loop `SCHED_RR` via rtkit, logged).
- `--results` given relative: `ctl capture` paths are the player's (absolute) — the pause step captured nothing on its
  first run; `RESULTS` is made absolute now.
- The first soak's RSS bound took the slope's absolute value (a shrinking RSS failed), and its switch outcomes read
  `.event` where `ctl logs` records carry `.kind` ("20 unknown"); now a signed bound and every switch's outcome
  recorded 30 s on.
- The pause step's first "+ one tick" bound was wrong: a resumed scene ticks at once (its grid slot passed during the
  pause) — the property is "continuous, not +10 s".
