<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### GPU budget and VRAM (Task 8)

Per-output scene fps, the worker GPU budget (owner: "GPU budget = a setting, default
auto-throttle"), the per-scene VRAM guard and the system low-VRAM rule (owner: "VRAM, round 3").
Code: `scene/budget.rs` (pure), `vram.rs` (measuring + the pure low-VRAM rule), `sources/scene.rs`
(`observe_budget`, `stop_for_vram`), `redraw.rs` (the present gate), `runtime.rs`
(`feed_scene_budgets`, `vram_tick`, `VramState`), `sources/host.rs` (`suspend_media` /
`resume_media`), `probe/vram.rs`, the worker's `gputimer.rs`.

- **Rates.** `demand` = the max over the showing outputs of `eff_fps(scene_fps, refresh)`
  (Task 5); the scene **ticks at `min(demand, the budget's cap)`** (`SceneSource::tick_hz`;
  `demand_hz()`, `throttle_cap()`). A demand at or below the cap lifts it (`scene.unthrottled
  {reason: demand}`). Every change is live on the same worker (the next tick is scheduled on the
  new period).
- **Per-output present gate (`redraw.rs`, Wayland and `--redraw-policy content`).** One worker
  serves every output (D1), so a new scene frame wakes output `<c>` at most
  `eff(out:<c>.scene_fps, refresh)` times per second: `Redraw::mark_shown_gated(routes, changed,
  now, period)` (`routes` = `redraw::Routes::of(graph)`, F6b) (the runtime's `scene_gate_period`: `Some(1/eff)` for a hosted scene, `None` for
  anything else) lets a scene frame through on a grid of that period (`GATE_SLACK` 2 ms early is
  on time; a whole period behind restarts the grid at now); an early frame is **deferred to its
  slot** (`gate_due`, promoted at the top of every `render_paced` by `promote_due`) — never
  dropped, so the last frame before a pause is still drawn. An output woken by anything else (a
  video it shows, an animation — a transition presents every callback) shows the scene's newest
  frame with it. Headless every-tick composing is unaffected. Unit
  `scene_frames_wake_each_output_at_its_scene_fps` (RED with the gate bypassed: DP-2 60 instead of
  15).
- **A scene at the refresh is paced by frame callbacks, not the gate (Task 14, on-machine).** On
  an output with frame callbacks (Wayland) whose `eff(scene_fps, refresh)` is its refresh
  (`scene_fps` 0 or ≥ it), `redraw::scene_gate_period(scene_fps, refresh, callbacks)` is `None` —
  ungated — and while such a scene plays at that rate (`SceneSource::clock_running`, `tick_hz` ≥ the
  refresh: not paused, not throttled below it, not holding a crashed worker's frame) the output
  **presents on every frame callback** like an animation (`runtime::scene_paces_output` →
  `render_paced`'s `animating`). Why both: the gate's grid (1 / the *rounded* refresh, 6.944 ms for
  143.981 Hz) drifted against the vblank, and whenever its slot fell after a callback the output
  went idle and presented off-callback at the slot — measured with `scene_fps 0`: DP-1 144
  presents/s but **0 of 288 intervals paced** for ~20 s at a time, DP-2 235–239.5 presents/s with
  ~100 idle gaps/s. Ungated alone fixed DP-1 but not DP-2: the worker's frames come on the loop's
  clock (240.000 Hz) against a 239.76 Hz vblank, so presenting only on a *new* frame still left
  callbacks with nothing new (paced mean 3.4 ms on a 4.17 ms display — two presents in one refresh).
  After both: DP-1 6.94 ms (288/288 paced), DP-2 4.17 ms (478–480/480) for all four step-1 scenes
  (`tests/onmachine/scenes.sh outputs`); a repeat only when the two clocks slip (~once per 4 s at
  240 Hz). Below the refresh (30 fps on 144 Hz) the gate and content pacing are unchanged. Unit
  `scene_at_the_refresh_is_paced_by_frame_callbacks_not_the_gate` (RED: `Some(6.944 ms)` for
  scene_fps 0 on 144 Hz); the presenting half is runtime-only (no hermetic Wayland) — guarded by the
  on-machine step.
- **GPU time (`bin/liascape-scene-worker/gputimer.rs`).** One `GL_TIME_ELAPSED` query around each
  frame's rendering (scene + blit into the slot), read back **only once `QUERY_RESULT_AVAILABLE`**
  — normally a frame or two later — never waited on; ≤ `MAX_QUERIES` 4 in flight (all busy → that
  frame goes untimed); a driver refusing queries turns the timer off (`gpu_ms` stays `None`, and the
  budget then never throttles). `Frame.gpu_ms` = the newest measurement that finished since the
  previous frame (`None` when none did) — so each measurement is reported once. Synthetic knob
  `report_gpu_ms` (tests) stands in for it. Measured: the synthetic 1080p frame 0.03 ms. Cost:
  `transport_meets_the_spike_budget`'s worker CPU (144 fps, load ~4) read 6.6 / 6.0 % with the
  timer and 4.4 / 6.0 % with its `begin` disabled — load noise; counted (2026-10-28): the query
  costs 7 k user instructions per frame (~11 µs, ≈ 0.15 % at 144 fps — kept: the budget needs it),
  § "Frame transport" → "What the worker's CPU figure is".
- **The budget (`scene::budget::Budget`, pure; units `budget_halves_under_starvation_and_recovers`,
  `budget_ignores_misses_a_light_worker_cannot_cause`, `budget_floor_is_10`,
  `budget_demand_change_lifts_a_cap_it_meets`).** `observe(now, missed_pct, gpu_ms_p50,
  fps_actual) -> Option<new rate>`: **throttle** when `missed_pct` > `THROTTLE_MISSED_PCT` 2 %
  **and** `gpu_ms_p50 × fps_actual ≥ GPU_LOAD_MS_PER_S` 400 ms/s (a worker using < 40 % of the GPU
  is never the cause) → cap = max(`FLOOR_FPS` 10, fps_actual / 2), only if that lowers the rate;
  after any change no further cut for `SETTLE` 2 s (the miss window must hold only frames made at
  the new rate); **recover** after `RECOVER_AFTER` 5 s in a row below `RECOVER_MISSED_PCT` 0.5 %:
  cap × `STEP_UP` 1.25, each step after another calm 5 s; reaching the demand lifts the cap. A
  demand below the floor is never touched.
- **Feeding it (`Runtime::feed_scene_budgets`, every `OBSERVE_EVERY` 500 ms, real clock).**
  `missed_pct` = the worst, over **every** output (Phase 2 Task 14 — the GPU is shared; it
  was the outputs showing the scene, `Graph::outputs_of`: on-machine a ~6 ms/frame worker on
  DP-1 cost DP-2's 240 Hz video 71 missed frames in 2 s while the budget, reading DP-1 alone,
  eased the cap back up; `probe::frames::worst_missed_pct`, unit
  `budget_miss_rate_is_the_worst_output_not_only_the_scenes`), of the `frames` probe's paced
  window (`missed / count` over 2 s; no paced samples = 0). **Open (TODO):** the throttle stops
  at the GPU-load guard (400 ms/s) — on this machine a single heavy draw at 220–260 ms/s still
  cost the 240 Hz output 33–38 missed frames per 2 s (the worker's low-priority context isn't
  preempted mid-draw; with explicit sync off each swap waits for the GPU on the loop). The scene adds
  its **own** missed frames (deviation from the plan's text, which only counts the outputs): a
  worker latching under `DEFICIT_RATIO` 90 % of its tick rate over a whole 2 s window at that rate
  (`rate_since`: reset by a rate change, the load's first frame, an un-pause) counts its deficit
  percentage — an output presenting below its refresh (a 30 fps scene on 144 Hz) has idle gaps
  between presents, so `paced` never sees its misses. `gpu_ms_p50` / `fps_actual` = the worker's
  `Frame.gpu_ms` and the frames latched over the last 2 s. Skipped while paused, stepped, not
  loaded or stopped. `player.scene_throttle` false → any cap lifted at once
  (`scene.unthrottled {reason: off}`), fixed fps.
- **Events (comp `scene`):** `scene.throttled {id, fps_from, fps_to, demand, gpu_ms, fps_actual,
  missed_pct}` (warn) on every cut; `scene.throttle_eased {id, fps_from, fps_to, demand,
  missed_pct}` (info) on a step up still below the demand; `scene.unthrottled {id, fps_from,
  fps_to, reason: recovered|off|demand}` (info).
- **Per-scene VRAM guard (`player.scene_vram_limit_mib`, 0 = off, the default).** Each sample
  (below), a scene worker whose own VRAM is over the limit for `Timing::scene_hold` (2 s — a
  load's transient peak isn't a reason) is stopped: `SceneSource::stop_for_vram(used, limit)` —
  `scene.vram_exceeded {id, path, pid, used_mib, limit_mib}` (warn), the worker `stop()`ped
  (quit, reaped), `SourceEvent::Error {"<path>: stopped: used 1800 MiB > limit 1536 MiB of VRAM
  (vram_exceeded)"}` → `source.error` (so the backend advances a rotation / a single wallpaper
  keeps its last frame), but **never a crash**: no restart, no crash record, no `worker.broken`,
  `workers` probe `state` not `broken` and `vram_stopped {used_mib, limit_mib}`. The last frame
  stays shown — **from one imported slot** (2026-10-28, `release_ring_but_shown`): a dmabuf lives
  while anyone holds it, so the stopped worker's whole ring (~3 × the export size of GPU memory)
  stayed alive through our imports; now every slot but the shown one is dropped, the frames still
  queued from it are forgotten (`Latch::forget_worker` — a queued frame of a dropped slot must never
  latch) and the shown one is never released (`tests/scene.rs::vram_stopped_scene_keeps_only_its_shown_slot`:
  slots 3 → 1, the held frame pixel-identical for 1 s, a `path` change then brings a new ring; RED
  before: 3 slots). Not a copy into a plain texture: same memory, and `stop_for_vram` needs no GL. A
  `path` change starts a new worker (clears it; its first latched frame drops the kept slot); raising
  the limit doesn't restart a stopped one. Guard-relevant pids: workers not stopped.
- **Measuring (`vram.rs`).** `vram::Probe` — `sample(pids) -> Sample {total_mib, free_mib, procs:
  Option<{pid: MiB}>}` — chosen by **`LIASCAPE_PLAYER_VRAM_PROBE`**: `auto` (default: the first that
  works of) **NVML** (`libnvidia-ml.so.1` **dlopened** — tried by soname, then
  `/run/opengl-driver/lib`, `/usr/lib{,64}`, `/usr/lib/x86_64-linux-gnu`; never linked;
  `nvmlDeviceGetMemoryInfo` of the GPU our own pid runs on (else device 0) +
  `nvmlDeviceGet{Graphics,Compute}RunningProcesses_v3|_v2` per pid, summed over devices) →
  **DRM** (AMD `/sys/class/drm/card*/device/mem_info_vram_{total,used}`, the largest card; per
  process `/proc/<pid>/fdinfo/*` — `drm-resident-*` > `drm-memory-*` > `drm-total-*` for regions
  `vram*`/`local*`, each `drm-client-id` once — AMD and Intel) → **`nvidia-smi`** (plain output:
  the memory line + the process table; `--query-compute-apps` lists compute processes only, never
  a GL client like ours; every `NVIDIA_SMI_INTERVAL` 3 s at most) | `nvml` | `drm` |
  `nvidia-smi` | `none` | **`fake:<file>`** (tests: a JSON `{total_mib, free_mib, procs: {"<pid>":
  MiB}}` read at every sample; a missing/bad file = no sample). An Intel GPU exposes no
  `mem_info_vram_*` sysfs, so it has no system total: no probe (`vram` probe `probe: none` + the
  reason) and neither rule acts — a gap for Intel discrete cards, noted. `vram::Monitor` runs the probe on its own thread **`lia-vram`**
  (every `Timing::interval`, 1 s), never the loop (NVML ~1 ms, `nvidia-smi` ~50 ms); the loop
  hands it the pids (the compositor + live scene workers) and reads the newest sample each tick.
  It runs only while a rule needs it (low mode not `off`, or a limit with a scene, or a hold);
  `none` answers once and its thread exits. Measured on this machine (NVML 595.84): total 8192,
  the compositor 17.7 MiB, a synthetic scene worker 33 MiB; `nvidia-smi` agrees (17 / 33).
- **The low-VRAM rule (`vram::LowVram`, pure; `player.vram_low_mode` `stop` (default) | `pause` |
  `off`).** Thresholds relative to the card: **low** = free < `low_mib(total)` = max(512 MiB,
  5 % of total), held `enter_hold` **3 s** with no sample at/above it → `Engage`; **free again** =
  free − reserve ≥ `resume_mib(total)` = low + max(1024 MiB, 10 %), held the resume hold
  (**10 s**, base) → `Release`; a dip under it restarts the hold. **Reserve** = what our resumed
  sources will take back: `stop` mode = our processes' VRAM at the engage (per-process numbers), or
  without them the rise of free VRAM in `settle` (2 s) after the stop; `pause` = 0. So memory we
  freed ourselves never reads as "free again" (no stop → resume → low loop). **Anti-flap:** an
  engage within `FLAP_WINDOW` 60 s of the last release doubles the resume hold (≤
  `RESUME_HOLD_MAX` 160 s); `FLAP_RESET` 5 min without one resets it. No sample for
  `UNAVAILABLE_RELEASE` 30 s while engaged → release (a dead probe never keeps the wallpaper
  stopped); a pending dip with a failed sample starts over. 8 GiB card: low < 512 MiB free,
  resume at ≥ 1536 MiB (+ reserve). Timing for tests: `LIASCAPE_PLAYER_VRAM_TIMING=<interval>,<enter>,
  <resume>,<settle>,<scene_hold>` (ms). Units `low_vram_never_flaps_under_light_load`,
  `low_vram_engages_after_hold_and_resumes_with_hysteresis`,
  `low_vram_reserve_is_measured_without_per_process_numbers`, `low_vram_backs_off_when_it_flaps`,
  `low_vram_releases_when_the_probe_dies`, `thresholds_scale_with_the_card`, the parsers.
- **The hold (`Runtime::vram_tick` / `drive_vram_hold`, every tick, real clock only — inert in
  stepped mode).** `Engage` → `VramHold {mode, phase}` and the player is **paused** —
  `update_player_paused` composes `player.paused || vram hold` (the graph's `player.paused`, the
  user's, is never written: a user pause made meanwhile survives the release) — so R75/R88 apply
  unchanged: every source with audio ramps out on its `gain.pause` gate, time freezes, transitions
  freeze; `player.vram_low_active` (observed) true; `vram.low {mode, free_mib, total_mib, low_mib,
  resume_mib, resume_hold_ms}` (warn). **`stop`:** once no gate is still ramping and ≥ ANTICLICK +
  AUDIO_SETTLE_TAIL passed, `SourceHost::suspend_media(gfx)` drops **every video/image/scene
  source's decoder or worker** (the two-phase teardown, the reaper — never a blocking free): the
  node stays, a `SnapshotSource` still of its last frame is shown in its place
  (`SourceHost::texture` falls back to it), cores still being made are dropped, and **media nodes
  created meanwhile wait unopened** (`suspend_new`); `vram.stopped {sources, ms}` (warn),
  `source.suspended {id, source_kind, position}` each. `Release` → `vram.recovered {reason:
  free|no_sample|off, free_mib, total_mib, held_ms, mode}`; `stop`: `resume_media()` — each
  suspended source reopens on the next `sync` **at the position it had** (`resume_at`, applied
  when it really opens — an async open re-reads the node then), effectively paused (the hold still
  stands), its stand-in shown and the graph mirror + its `Ready` held back (it was ready: not news)
  until its first frame (`source.resumed {id}`); `vram.resuming {sources}`; once none is pending
  (or `VRAM_RESUME_WAIT` 5 s) the hold goes → `vram.resumed {sources, pending, resume_ms,
  held_ms}`, `vram_low_active` false, the pause lets go → the R88 resume (flow-gated ramp-in).
  `pause`: Release → the hold goes at once. Mode changes apply live: `off` while held releases;
  `pause` → `stop` frees now; `stop` → `pause` gives the sources back and stays paused.
  **Applies to every source kind** (colour/snapshot have no GPU memory worth freeing and are left
  alone); a scene's worker is a new process after a resume (a new pid; a resume is not a crash).
- **Probe `vram`** (`probe/vram.rs`): `{probe (nvml|drm|nvidia-smi|fake|none, null = not
  running), sample {total_mib, free_mib, used_mib, procs}, error, sampled_ms_ago, mode, rule
  {state normal|pending|low|recovering, reserve_mib, low_mib, resume_mib, enter_hold_ms,
  resume_hold_ms}, hold {mode, phase pausing|held|resuming, since_ms, suspended}, suspended (ids),
  resuming (count), scene_limit_mib, scenes [{id, pid, used_mib, over_ms, stopped}]}`. **`workers`**
  adds `fps_demand`, `gpu_ms_p50`, `gpu_ms_p95`, `throttle {cap, demand, since_ms}` (null =
  unthrottled), `vram_stopped {used_mib, limit_mib}`; `fps_target` is the effective rate.
  **`cpu {total_ms, threads {name: ms}}`** (F4, `sources::scene::proc_cpu`: the worker process's
  `utime + stime` from `/proc/<pid>/task/*/stat`, threads summed by name — cumulative, so two
  probes give a rate; `null` without a live worker). Measured (release, headless 1920×1080@144,
  `scene_fps` 30, private PipeWire at a 64-frame quantum): Kimi 2371103399 (sound) 6.0 % of a core —
  renderer `liascape-scene-` 3.5, PipeWire `data-loop.0` 2.2 (no_audio: 4.3 / 2.8 / 1.2 — the
  stream keeps its callbacks, gated); Bunk 2134765860 2.6 %; Emilia 1726902114 1.2 %. `perf` of
  Kimi (samples): the render thread 66 % (by library over the whole worker: NVIDIA's GL driver
  54 %, LWE 25 %, EGL 6 %), PipeWire's data loop 17 %, `lia-scene-audio` 5 %, the protocol thread
  4 %; LWE's mp3 decode (`mp_decode_layer3` …) ~5 %, PipeWire's plumbing ~3 %, ours
  (`Dsp::process`, `SegmentMeter::feed` — until the loudness cap —, `BlockMeter`, `fill`) ~3.5 %
  of the worker ≈ 0.2 % of a core. So a scene's worker CPU is
  LWE's per frame (≈ legacy LWE's, § phase2 report 1.3), linear in `scene_fps`: the plan's 5 %
  holds for light scenes at 30 fps, not for heavy ones at 144–240 (TODO F4: bound per class).
- **Tests.** `tests/scene.rs::scene_budget_throttles_live_and_recovers` (harness: the
  `report_gpu_ms` knob at 20 ms, 10 % misses fed through `observe_budget` with a virtual clock →
  cap ≈ 15, latched 15 ± 2/s, a calm 5 s step × 1.25, `auto` off back to 30 ± 2/s, same pid; a
  light worker's real GPU time > 0 and < 5 ms is never throttled; RED with the rate not applied:
  "ticks at the cap 30.0"). `tests/api.rs` (real clock): `per_output_scene_fps_gates_presents`
  (`--redraw-policy content`, VIRTUAL-1 scene_fps 60 / VIRTUAL-2 15, one scene on both → measured
  59.9 / 15.0 presents/s; RED with the gate bypassed: 59.4 / 59.4), `scene_fps_change_is_live_same_pid`
  (30/30 → 60/30 → 60/0(=refresh 60) → 15/15, measured exactly those, `fps_target` within 0.5 s,
  one `worker.spawned`, no restart). Both judge each output's presents against `min(gate, the
  frames the scene latched in the same window)` (`gate_rates` / `GateRates::check`, the latched
  rate ≥ ½ the scene's) rather than the absolute gate — TODO F5: once in a parallel suite run
  VIRTUAL-2 at 60 fell outside 60 ± 3; RED with the gate bypassed (`scene_gate_period` → `None`):
  "VIRTUAL-2: 59.95 presents/s, want 15.00", "60/30 VIRTUAL-2: 59.95, want 30.00". `scene_over_vram_limit_is_stopped_not_crashed` (fake probe:
  no limit by default at 5000 MiB; a spike shorter than the 1 s hold ignored; over it → stopped
  after 1.11 s with the UI text, no crash record/restart, the last frame captured),
  `low_vram_stop_frees_and_resumes_every_source` (a video + a scene: `vram.low` after the hold,
  both freed, the scene worker gone, stills on both outputs, time frozen, a video created
  meanwhile waits unopened; free again → both reopen at their positions, a new worker,
  `pending: 0`; RED before the resume-position fix: the video restarted at 0.07 s instead of
  0.83), `low_vram_pause_mode_pauses_without_freeing` (same worker throughout; a user pause made
  during the hold survives the release). Every test server runs `LIASCAPE_PLAYER_VRAM_PROBE=none` unless
  it sets a fake (`tests/api.rs::die_with_parent`, `tests/supervise.rs::guard`) — hermetic tests
  never see this machine's real VRAM.

**For Task 11 (the backend) — what to wire (names, units, defaults; all live, all `set` on the
`player` node unless noted):**

| setting (UI) | player-side | type / unit | default | notes |
|---|---|---|---|---|
| GPU budget: auto-throttle on/off | `player.scene_throttle` | bool | `true` | off = fixed fps; a cap in force lifts at once |
| per-monitor scene fps (`SceneMonitors[*].Fps`) | `out:<connector>.scene_fps` | f64 fps, 0–480, 0 = the output's refresh | `30` | per output, live (already Task 5); the backend's coalescible `scene_fps:<name>` |
| VRAM guard: toggle + limit | `player.scene_vram_limit_mib` | f64 MiB, 0–1048576, **0 = off** | `0` | toggle off → send 0; on → the limit (owner's suggestion 1536) |
| when the GPU's VRAM runs low | `player.vram_low_mode` | enum `stop` \| `pause` \| `off` | `stop` | thresholds fixed in the player (above) |

Events the backend should subscribe to: **`scene.vram_exceeded {id, path, pid, used_mib,
limit_mib}`** → treat the scene like broken for playback (advance a rotation / keep the preview)
but **do not** `MarkCrashed` — show "stopped: used X MiB > limit Y" (the same text arrives as the
`source.error` reason, which the backend sees for any failed source; distinguish by the
`vram_exceeded` event or the reason's `(vram_exceeded)` suffix); **`vram.low {mode, free_mib,
total_mib}`** / **`vram.resumed`** (optional: a UI status line "paused: VRAM low"); `scene.throttled
{id, fps_from, fps_to}` / `scene.unthrottled` (optional, diagnostics). Observed:
`player.vram_low_active` (bool). The backend must NOT treat the low-VRAM pause as a user pause
(`player.paused` stays false) and must not re-assert anything when it ends. Diagnose with `ctl
probe '{"name":"vram"}'` and `'{"name":"workers"}'`.
