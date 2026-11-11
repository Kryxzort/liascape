<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### Transitions with scenes (Task 9)

The recipe stays kind-agnostic: a scene B is held in `srcs:` by its transition (its worker spawns
at the first `sync` after `start` refreshed `srcs:` — in the harness one tick later than in the
runtime, whose `refresh_srcs` runs right after the request), opened paused it readies with its
first frame (one tick), its onset waits for the worker's `AudioFlowing` like a video's (none when
it has no sound); reveal/frozen hold a scene A by a `SnapshotSource` blit of its latched frame
and pause it at `t0 + 45 ms` (its worker gets no tick and latches nothing after that); a scene
is never a still (`is_still`) but **never ends** (`never_ends` = still | scene).
- **The one rule added (`recipes/transition.rs::never_ends`).** `align: end` on a lead A that
  never ends is `Now` at once (it waited out `ALIGN_SLACK` — 10 s — before: a scene has duration
  0 and never emits `Ended`, so the M2 fallback was the only way out, logging
  `transition.align_fallback`); End leaves such an A's (inert) `loop` alone; `follows_a_end`
  skips it. The same rule in the runtime's parked path (`transition_parked`: a parked scene A →
  handed off at once, § Runtime "No output left"). This is what the backend's restore-aligned switches
  send when the playing item is a scene (a scene never ends: its rotation moves it on itself).
- **A slow scene load is waited for (`LOADING_READY_TIMEOUT`, corpus under load,
  2026-11-03).** `WaitingReady` fails a B with no first frame at `READY_TIMEOUT` (10 s) —
  unless B's observed `loading` is true (§ "The `scene` Source kind" → `loading`): then it waits
  up to **50 s** from the request (`transition.waiting_load {b, path, waited_ms, limit_ms}`, info,
  once), A playing on untouched meanwhile. A B that stops loading without a frame fails at that
  tick; past 50 s → `failed` "`<path>`: no first frame within 50 s (still loading)". 50 s sits
  under the backend's own 60 s non-aligned wait (`LiascapePlayerMedia.WaitSwitch`), so the
  backend gets the player's verdict, never its own timeout + `cancel`. Measured (private headless
  player, 3 GPU-heavy scenes playing on the other outputs, Ready = create → `ready`): 2883756643
  7.1 s quiet (6.8 s with only the GPU load; a cold page cache or a parallel read of 3 other
  `scene.pkg` on the same NVMe: no change), 13.1 s with 24 CPU-bound threads, 16.4–19.8 s with 48
  — every such switch failed before. End to end (same setup, 48 busy threads, a full-live fade
  from a light scene to 2883756643, 2 runs each): HEAD `transition.failed` "no first frame within
  10 s" at 10.2 / 10.3 s; with this, `transition.waiting_load` at 10 s then `transition.started`
  at 17.3 / 17.6 s. 2890767643 1.5 s quiet, 2.6–3.6 s loaded (its 18.7 s in the
  Phase 2 battery was not reproduced by CPU, GPU, cold-cache or I/O load — VRAM pressure is the
  remaining suspect, not pushed for). **What's playing is not at stake:** the three playing scenes
  latched 71–77 frames/s together (target 90, CPU-starved by the 48 threads) without B loading and
  72–73 while it loaded — one more runnable thread among ~60; a `nice`/`SCHED_IDLE` build (the
  TODO's idea) would only have stretched B's load ~10× under contention (its thread would get
  ~1/10 of a fair share), so it is not done. Tests: unit
  `loading_b_is_waited_for_past_the_ready_timeout` (not loading → fails at 10 s; loading, Ready at
  25 s → starts then; loading forever → fails at 50 s "(still loading)"; stops loading at 14 s →
  fails at 14 s), `tests/transition.rs::slow_loading_scene_b_is_waited_for` (real worker, an
  11.5 s synthetic load: started after it, no `transition.failed`, A current and its gain
  unchanged meanwhile, 0 restarts, `loading` false after; RED: `no first frame within 10 s`).
- **Tests** (`tests/transition.rs`, harness, synthetic `frame_index` scenes, frame-index videos
  without audio so every B onset is immediate and every gain exact): `v_to_s_each_method`,
  `s_to_v_each_method`, `s_to_s_each_method` (`combo`: full-live — both sides keep producing
  frames, `gain.xfade` −3.0103 ± 0.05 dB each at the midpoint; reveal — fx `from` = a snapshot
  pixel-identical to A's frame at the copy, A paused ≥ t0 + 45 ms, a scene A sent no tick and
  latched nothing after it, B's xfade rising to −3.0103 at the midpoint; frozen — B on its first
  frame, paused and silent through the effect, at 0 dB 30 ms after the handoff, then playing;
  every method — progress forced to 0 / 1 composes exactly the plain sides (±1, the
  `effect_progress_endpoints_match_plain_source` property with live textures), done → B alone,
  a scene A's worker reaped), `align_end_video_a_to_scene_b` (full-live ends at A's end ±
  17 ms, measured +9.0; reveal/frozen start at its `Ended`, +0.0), `scene_a_align_end_starts_at_once`
  (S→V/S→S, every method + a cut: started ≤ 3 ticks after B's `Ready` — counted in ticks, not
  time; RED with the rule removed: never started in 8 s), `shared_scene_a_is_untouched` (A on
  VIRTUAL-2 too: never paused/ramped/loop-changed, kept rendering; snapshot constant on
  VIRTUAL-1), `scene_b_load_error_keeps_a` (missing folder via the real worker's folder check,
  synthetic `fail: load` / `fail: build`: `transition.failed` naming the folder, A untouched, no
  restart, no crash record), `scene_b_worker_crash_mid_effect_still_hands_off` (SIGKILL at
  progress 0.5, full-live and frozen: B's texture never None, no `transition.failed`, normal
  handoff, one restart, a new pid, no crash record, B's scene time continuous),
  `scene_b_broken_mid_effect_snaps_back` (every worker crashes 700 ms after its start → broken
  after 3 restarts mid-effect → `transition.failed` "…broken…", snap-back to A within 30 ms, A
  playing again, B destroyed, one crash record; S→S reveal and V→S full-live),
  `mixed_kind_interrupt_chain_every_tick` (invariant #6 per tick over 10 scene/video starts,
  gaps by condition: one tick / 100 ms / until Running). Unit
  `scene_lead_a_align_end_starts_now` (every method + a cut; RED: End turned the scene's loop off
  and nothing started). `tests/api.rs` (real clock): `scene_switch_storm_reaps_workers` (Review
  Focus #5: 10 S→S starts 100 ms apart, ≤ 2 unpaused at every poll; settled → within 1 s one
  worker, the 10th's, every earlier pid gone, `reaping` 0), `rapid_interrupt_chain_mixed_kinds`
  (V, S, V, S… through the runtime: `state` polled, paused ⊆ `transitions[].held`, commits and
  supersedes, the 10th alone, other workers reaped), `parked_scene_align_end_hands_off_at_once`.
- **Gotchas found writing them.** A paused **video** A still presents 2–3 queued frames
  (`time_pos` moves ~30 ms after the pause — why the snapshot exists); a paused **scene** A stops
  exactly (the latch gate). A scene worker's first frame takes > 100 ms (its EGL setup alone), so
  a chain of plain 100 ms gaps only ever supersedes — the chains choose their gaps by condition.
  A `Tick.t` is the compositor's clock, so a restarted worker's frames continue the scene time
  whatever its `Start.position` — Task 10 stops that clock at the held frame for the outage, so the
  restart resumes exactly there (`crash_holds_last_frame_and_resumes_at_position`).
- **For Task 10** (done — § "Crash policy (Task 10)" below). A crash mid-effect holds B's last
  frame and restarts it (budget 3 in 60 s); broken → `SourceEvent::Error` → the recipe's snap-back
  (pre-Running: abort); a B that crashes before its first frame waits for the restarted worker's
  (its `Ready` comes from it) — and shows its preview meanwhile if anything samples it.
