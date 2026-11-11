<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### Crash policy (Task 10)

Spec §6.3 / the plan's Global Constraints, end to end: a worker crash or hang keeps the source's
last frame (or its preview if none arrived), restarts **up to 3 times within 60 s resuming at the
held position**, then the source is **broken** (event, persisted crash record, the backend's
skip/advance applies). Other outputs, videos and audio are never touched. Code:
`sources/scene.rs` (`hold_for_restart`, the preview, `ContextLost`), `worker/mod.rs`
(`kill_for_restart`), `snapshot.rs` (`broken`), the worker's `main.rs` (robust context,
`context_lost`), `gfx/egl.rs` (`OffscreenOpts::robust`).

- **Resume at the held frame (exactly).** A `Tick.t` is the compositor's scene clock, so before
  this the clock ran on through a restart (spawn + EGL + export + first frame ≈ 0.1–0.3 s) and the
  restarted worker's first frame jumped that far ahead of the frozen picture. Now
  `hold_for_restart` — on `Hung`, `Exited` and again at `Restarted` (after
  `Latch::forget_worker`, so a frame of the dead worker that latched between a hang and the reap
  is the final one) — **stops the clock at the held frame's `t`** (or at the clock after a
  `position` set the frame didn't show yet: `clock_jumped`) and sets `resuming = Some(held
  generation)`; `Start.position` carries it too (`set_resume_position`). While resuming,
  `tick()` sends exactly **one tick at that `t`** (after the new worker's `Ready`); the clock runs
  again when a frame of a **later generation** latched (`on_latched`): `scene.resuming {id, t,
  attempt}` / `scene.resumed {id, t, seq}` (info). `time_pos` is frozen through the outage (never
  a jump; it may step back ≤ one tick + latency to the held frame's `t` at the kill, or by the
  hang timeout after a hang — the picture froze there). Paused through the crash: no tick until
  the un-pause (the held frame is exact), then the resume tick; a `position` set while paused
  ticks at once (`exact_pending`) and that frame ends the resume. Stepped: untouched (the step
  re-sends its own tick). The GPU budget skips a resuming scene. Measured
  (`crash_holds_last_frame_and_resumes_at_position`, 30 fps): killed at `time_pos` 3.0054, held
  `t` 2.9710, first new frame `t` 2.9710 (RED before: 3.1482 — the outage).
- **The preview when nothing is on screen.** A worker that dies (`Exited`/`Hung`/`Restarted`/
  `Broken`) with no frame latched sets `preview_wanted`; the next `update` opens the `preview`
  prop (Source `preview`, `SceneOpts::preview`) as an internal **paused, silent image
  `MpvSource`** (`ao: null`, `no_audio`, `kind: image` — any format mpv reads: the backend sends
  `preview.jpg|png|gif|webp`), its wake fd in the source's epoll; `texture()` = the latched frame,
  else the preview's texture once it rendered (`preview_shown()`), else `None`. The first worker
  frame retires it (`MpvSource`'s two-phase teardown, `preview_dying`; `SceneSource::
  begin_teardown`/`teardown_ready` wait for it, R51). **Cost:** the open is synchronous on the loop
  (an mpv core + render context + its first render, ~10–30 ms) — only on these crash paths and a
  restored broken scene, never for a normal load. No preview set / a failed open or load →
  `scene.preview_failed {id, preview, reason}` (warn), never retried, nothing shown (as before).
  `scene.preview {id, preview, open_ms}` (info). A live `preview` change re-points a shown one.
  Stepped: a broken scene's `step_status` is `Pending("preview")` until its preview is on screen
  (a step's capture shows it), then `Broken`. Test `crash_before_first_frame_shows_preview`
  (every worker crashes at start: only the preview ever shows, before and after the break).
- **Broken** (budget spent, unchanged mechanics): `SourceEvent::Error` + ONE `source.broken {id,
  path, scene_id, reason, restarts, record, signal|code, total_restarts, uptime_ms, shows:
  last_frame|preview|nothing}` (the shape Task 11's backend reads; fields added only). The source
  then holds its last frame (or the preview), **silent** (no worker, no stream; `has_audio` reads
  `false` and `AudioFlowing` is immediate — nothing waits on a broken scene), its clock frozen.
  Source prop **`broken`** (Bool, **read-only**, observed — `SourceHost::MIRRORED`): `state` /
  `get <id>.broken`; `workers` probe `broken`, `state: broken`. A `path` change clears it (a new
  worker, a fresh budget). Tests `tests/api.rs::broken_after_three_restarts_in_60s` (the event,
  every crash-record field — `scene_id`, `id`, `path`, `reason` "… after 3 restarts within 60 s",
  `signal` 6, `restarts`/`total_restarts` 3, `uptime_ms`, `t_wall`, `log_tail` with the worker's
  `stub: crashing` and the `restart 3` marker —, `source.error`, `broken` observed, no 5th spawn,
  the last frame on the output), `source_broken_event_names_the_scene` (Task 11).
- **`loading`** (Bool, **read-only**, observed — `SourceHost::MIRRORED`; `false` on every other
  kind): `SceneSource::loading()` = no first frame latched, no error, not broken, and a worker
  `Starting` / `Running` / `Restarting` — a live worker inside its load + build. It never stays
  true for a hung worker (the heartbeat kills it within `hang_timeout` once the worker's `LoadGate`
  stops covering it, below; past the budget it is `broken`) nor for a failed load (`error`). Also
  in the `workers` probe. The transition recipe waits longer for a B that reports it (§ "Transitions
  with scenes"). Test `tests/scene.rs::scene_loading_spans_the_load_only` (true from the open
  through a 1.2 s load, false at Ready and at a fatal `fail: load`).
- **`ContextLost` = a crash restart.** The worker's context is created **robust**
  (`OffscreenOpts::robust`: robust access + `LOSE_CONTEXT_ON_RESET`, + `EGL_GENERATE_RESET_ON_
  VIDEO_MEMORY_PURGE_NV` where listed — NVIDIA purges VRAM on suspend/resume and VT switches;
  `gfx.context_robust {requested, granted, attribs, granted_attribs, path}`; the worker logs
  `gfx: robust context granted|not available`), and polls `Gfx::reset_status()`
  (`glGetGraphicsResetStatus`, no GPU sync) after every frame: non-zero → `ContextLost`, renders
  nothing more, fades its stream (≤ 200 ms) and waits to be killed (exits 4 itself after 5 s).
  The compositor: `scene.context_lost {id, path, pid}` (warn) + `WorkerHost::kill_for_restart("GL
  context lost")` — SIGKILL, `worker.killed {id, pid, why}`, then the ordinary path: the restart
  (its `why` / log-tail marker "GL context lost, killed by signal 9"), through the **same budget**
  (4 within 60 s = broken, the record's `reason` naming it). Judgement call: the protocol carries
  no reset kind, so an innocent reset counts like a guilty one — one suspend/resume is one
  restart, far inside the budget. Test `context_lost_is_a_restart` (synthetic
  `context_lost_after_ms: 600` — every worker reports it: frame held, restart 1 names it, broken
  after 3 with the record's reason). Real detection is on-machine only (a GPU reset can't be
  triggered hermetically); `workers` probe `context_losses`.
- **Hang timeout knob `LIASCAPE_SCENE_WORKER_HANG_MS`** (`sources::scene::HANG_ENV`, read at each
  scene's open in the compositor's environment; a positive whole number of ms, else
  `HANG_TIMEOUT` 2 s — unit `hang_timeout_knob`). Tests run 300. `tests/api.rs::
  hang_is_killed_and_restarted` (`hang_after_ms` 1500: `worker.hung` after 304 ms — RED: 2005 —,
  `worker.restart {why: "hung, killed by signal 9"}`, the hung pid gone, frames from the new
  worker past the held `t`; 303 ms after the 2026-10-29 heartbeat change — the same bound).
- **A suspend is not a hang (2026-10-29).** Both on-machine suspends killed a live worker as hung
  (`phase2.md` § 8): after the resume the compositor held every slot (latched + queued frames
  whose fences hadn't signalled while the GPU woke) and the worker sat idle waiting for a
  `Release` (incident 1, `waited_ms 2001`); and NVIDIA's kernel-notifier VRAM save blocked the
  compositor's own loop for ~6.4 s, whose first heartbeat after the thaw found a tick that old
  (incident 2, `waited_ms 6438`). The heartbeat now leaves out a **starved** worker's tick age
  (pinged instead, bounded at 5 × the timeout) and the time of a **host stall** — § "WorkerHost"
  → Heartbeat. A real hang keeps its bound (the api test above; `tests/worker.rs::
  starved_worker_that_hangs_is_still_killed`). The robust renderer also polls the reset status on
  every ping, so a purge it sees while starved is a `ContextLost` restart (on-machine only).
- **Snapshot: a broken scene restores as its preview.** `SourceSnap.broken` (saved only when true,
  `skip_serializing_if`), `create_props` seeds `broken: true` (read-only, seeded by `create` like
  `of`); `SceneSource::open` sees it → `restored_broken`, `broken` set, **no worker is ever
  spawned** (`set_demand` skips), the preview opened at once (`scene.restored_broken {id, path,
  preview}`, warn), no `Error`/`source.broken` again (the backend already marked the item), no
  restore fade (`!s.broken` in `restored_source`'s audible check). A source error marks the
  snapshot dirty (`update_sources`: a break is no graph change, and a scene that never readied
  isn't refreshed by the 2 s rule). Without this a player restart gave a crash-looping scene a
  fresh budget every time. Unit `broken_scene_is_saved_and_recreated_broken`; supervise
  `broken_scene_restores_as_preview` (saved `broken`, SIGSEGV → restored `broken`, its preview on
  the output, `workers` `state: broken` / `pid: null`, no `worker.spawned` for it).
- **Other outputs are never touched.** `tests/api.rs::crash_never_touches_other_outputs`
  (`--redraw-policy content`: VIRTUAL-1 a looping frame-index video, VIRTUAL-2 a scene killed 4
  times — 3 restarts, then broken —, 1.2 s apart): VIRTUAL-1's presents per window within ±2/s of
  its own baseline window and no frame held longer than the baseline's longest + one 60 Hz tick
  (measured 29.4–31.3 fps, max 35–38 ms vs baseline 30.0 / 36.9), its `time_pos` advancing at 1×,
  its gains/paused/loop/speed and `lay:VIRTUAL-1:main.content` unchanged, no event about it; loop
  `max_busy` ≤ 5 ms around it all (measured 2.4–3.8; render worker off: the video renders on
  the loop, 6–9 ms stretches without any kill, so the bound is that no-kill maximum + 5 ms —
  measured +2.2 at most, the restart handled in the same tick). This one was GREEN before Task 10 too — a
  guard: the isolation came from Tasks 3–5.
- **For the backend (Task 11's adapter — not changed here):** nothing it relies on changed shape
  (`source.broken` only gained fields). New facts it may use: `<src>.broken` (read-only, in
  `state`) and `source.broken.shows`; a player restart brings a broken scene back **broken** (its
  preview, no worker) — so after a restart `broken: true` on the shown scene is expected, and
  re-applying the same item needs a new source (a `transition`; a same-path `set` is a no-op), as
  whitelisting already does; a scene can also break from repeated GPU context losses (the record's
  `reason` starts "GL context lost") — it is marked crashed like any other break.
- **No core handler (Task 13).** The worker sets its own soft `RLIMIT_CORE` to 1 right after the
  PDEATHSIG check (`skip_core_handler`, never above the hard limit): the kernel then skips a piped
  `core_pattern`, so a scene that crashes LWE never reaches systemd-coredump or pops a desktop crash
  notification (the corpus' first run: 16 of them for its 4 broken scenes — 4 crashes each). The
  crash record + log tail are the diagnostics. `LIASCAPE_SCENE_WORKER_COREDUMP=1` (in the compositor's
  environment, inherited) keeps the inherited limit, for debugging LWE with a core. Test
  `tests/api.rs::scene_worker_crashes_skip_the_core_handler` (`/proc/<worker>/limits`: 1, and the
  inherited limit with the opt-out; RED before: unlimited, inherited from the test).
