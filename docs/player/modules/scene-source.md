<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### The `scene` Source kind (Task 5)

A WE scene is a graph `Source` like any other: `create {kind: source, props: {kind: scene,
path: <item folder>, position?, paused?, speed?, preview?}}`. The transition recipe, aliases
(`srcs:`/`cur:`), the snapshot and the adapter stay kind-agnostic; only the places that
hard-coded `kind == "video"` learned about `scene`.

- **Schema.** `Source.kind` enum + `scene`; `Source.preview` (Str, the item's preview image —
  stored on every kind, shown by Task 10's crash policy); `Output.scene_fps` (F64 0–480, default **15** = WE's
  own default `fps` (2026-11-06; was 30 = D5), `0` = that output's refresh). `Graph::outputs_of(id)` = the inverse of `srcs:<c>` (every
  `out:<c>` whose `srcs:` holds `id` — shown there, or held there by a transition).
  `onset::kind_has_audio(kind)` = `video | scene` (`has_audio`, `audible`, the restore fade,
  the snapshot's `playing` and the periodic refresh all go through it).
- **`SourceHost`.** `kind: scene` → `SceneSource::open(gfx, id, node, base_opts)` on the loop
  (never the `lia-open` pool: no core to make, and the worker's PDEATHSIG follows the spawning
  thread). Base opts (`serve` fills them): `scene_worker` (`paths::scene_worker_bin()`; none →
  the open fails naming it), `allow_synthetic` (only when `serve` runs with
  `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`: a folder with `liascape-synthetic.json` plays the synthetic
  renderer, and the worker gets the env too), `scene_crash_dir` (`<state>/crashes`),
  `scene_assets` (Task 7), `ao`/`audio_device` (the `Start.audio` route: `null` → `Null`, the
  bus device → `Device`, else `Default`), `stepped` (`MpvSource::open_with_core` skips the
  `scene_*`/`allow_synthetic` keys — the base opts reach every mpv source too; without that
  every video failed `no_such_prop`). **Every `sync` ends with each scene's
  demand** (`host::demand_for(graph, id)` → `[OutputDemand {name, width, height, refresh_hz,
  scene_fps}]` from `outputs_of`) — **cached per `Graph::demand_rev`** (F6b, Phase 2 battery):
  `sync` runs after every dispatch, i.e. once per worker frame, and recomputing `outputs_of`
  (every output × every layer, `format!`s, `BTreeSet`s) for every scene there was the top of the
  compositor's profile mid-transition (main thread: `SourceHost::sync` 17.7 % of samples, 4
  synthetic workers mid-fade, headless 144 + 240 Hz). `demand_rev` (with a per-graph uid) moves on
  `create`/`destroy`, a layer's `output`/`content`, an effect's `from`/`to`, a source's `kind`, an
  output's `width`/`height`/`refresh_hz`/`scene_fps` (set or observed, only when the value
  differs), and a *changed* `set_transition_sources`/`set_parked` — never on what animates
  (`fx.progress`, `opacity`, `gain.*`) or a source observes; unit
  `demand_rev_moves_on_routing_changes_only`. `set_demand` itself still runs every sync with the
  cached value (it also applies a budget rate change and spawns a worker a restart / path change
  left without). `SourceHost::demand_computes` counts recomputes. **The worker is spawned at the first demand that names an
  output** (so the ring is exported at the right size from the start; a node created but not
  shown has no worker); `max_size` = the largest width and height over the outputs (the cover
  size covers each), tick rate = max `scene_rate(scene_fps, refresh)` (**WE's `fps`, not capped at the
  refresh** — below; 0 → the refresh; neither known → 15; Task 8 adds the GPU cap); each output's
  presents of the scene's frames stay gated at `eff_fps(scene_fps, refresh)` (≤ its refresh, `redraw`); a change of
  `max_size` sends **`Resize`** (stats `resizes`); no output at all (every output unplugged —
  parked) changes nothing. `set_audio_route` re-routes scenes too (`ToWorker::Route`).
  `SourceHost::scene(id)`/`scene_mut(id)`, `workers_info()`; `Source::as_scene(_mut)`.
- **The wake fd** is the source's **own epoll fd** (stable across spawns and path changes)
  over the current `WorkerHost::wake_fd()` **plus each queued frame's acquire fence, one-shot**
  (`EPOLLIN|EPOLLONESHOT`; `update` drains the epoll first, so a signalled fence wakes the loop
  once, never in a busy loop; closing the fd — superseded/latched — removes it; the latched
  one is `DEL`ed before `gpu_wait_fence` takes it). Found by the stepped determinism test: a
  frame whose fence hadn't signalled when its `Frame` woke the loop was latched only at the
  step's 2 s deadline (a stepped loop has no timer) — 60 steps took 155 s; after: ~20 ms each.
- **Scene clock (`SceneClock`, unit `scene_clock_excises_pauses_and_scales_by_speed`).** Scene
  seconds that advance at **`speed`** (owner decision round 2: speed scales a scene's
  animation; the pitch-corrected audio half is Task 6's), with paused intervals **excised**
  (never stopped-and-jumped). It runs only once the load's **first frame** is shown (like a
  video's `time_pos`, nothing passes while the worker starts), while not `paused` and not
  stepped. A live `speed` set re-rates from now; a live `position` set jumps it; `time_pos` =
  the clock. `Tick.t` = the clock at send.
- **Ready = the first latched frame of a load**, at exactly `position`: before it, exactly
  **one tick** (`t = position`) is sent, paused or not — then the clock starts and ticks flow
  at the tick rate (grid-scheduled, `TICK_SLACK` 2 ms early is on time, a whole period behind
  skips ahead, ≤ `MAX_INFLIGHT` 2). `ready` = loaded; one `Ready` per load (a worker restart is
  not a load; a `path` change is). `AudioFlowing` is reported at once (after Ready, on an
  un-pause) when the worker said `has_audio: false` or in stepped mode; a scene with audio
  reports it from its stream (Task 6). `Position` events ~10 Hz while playing.
- **Pause.** `paused` (the effective one, `node.paused || player.paused` — R75 composes it in
  `SourceHost` exactly as for videos) **stops ticks and latching at once**: a frame in flight at
  the pause never latches, so the held texture is exactly the one shown when it applied (no
  paused-mpv frame drift); the worker gets `Paused` (Task 6 stops pulling audio). Exceptions:
  the load's first frame (a scene opened paused shows it — exactly one tick), and a `position`
  set while paused (`exact_pending`: one tick at the new time, its frame latches). Resume
  continues the clock where it stopped. Player pause, parking (pause + −96 via the runtime)
  and hotplug need no scene code beyond this.
- **`path` (live)** = a new worker on the new folder (`WorkerHost` dropped: `quit`, reaped off
  the loop; `Latch::forget_worker()` — the old frame stays shown, never released, until the new
  worker's first frame latches), clock back to 0, `Ready` again; not a crash (`restarts` 0,
  `spawns` + 1), no crash record.
- **Re-export (`resize {max_size}` in the worker).** The worker computes the new
  `cover_size(native, max_size)`; equal to the current ring → nothing; else a new ring with
  fresh slot ids (3 more), its `buffer`s, and the old ring dropped (the compositor's imports of
  the old slots keep their memory — a dmabuf lives while anyone holds it). The compositor
  imports the new set into the **same generation's** ring; once a frame of the new set latched
  it drops that ring's other slots (`ImportedRing::retain_slots`; `latest_set`). The texture is
  never `None` in between.
- **Stepped mode.** No self-ticking: `begin_step` gives a scene the same virtual time as a
  video (`LocalTime`, advanced by `ms × speed` while not paused/player-paused; no duration, so
  never clamped) and calls `SceneSource::step_to(t)` — one tick at exactly `t` unless the
  target is unchanged; `check_step` waits (non-blocking, the fence wake above) for
  `step_status() == Done` = **the latched frame's seq ≥ the step's tick seq** (by seq, never by
  comparing `t`: it crosses JSON twice and serde_json's default float parsing can land an ulp
  off — found: a step never finished at `t = 0.192`), `Pending("ready")` while the worker
  starts (a worker that came up mid-step gets a fresh `STEP_TIMEOUT`, like an mpv open),
  `Broken` on an error. Seqs (= frame_index markers) are deterministic: one tick per step that
  moves `t`.
- **Errors.** A fatal worker `error` → `SourceEvent::Error {"<path>: <reason>"}` + the worker
  stopped (no restart loop, no crash record); `broken` (restart budget spent) → also `Error`,
  plus ONE `source.broken {id, path, scene_id, reason, restarts, record, signal|code}` (error,
  comp `source`; the fields from the crash record the host just wrote — Phase 2 Task 11, what the
  backend adapter marks the item crashed from: player-adapter.md § Scenes; Task 10 added
  `total_restarts`, `uptime_ms`, `shows` and the rest of the crash policy — § "Crash policy (Task
  10)"); either holds until `path` changes. Test `tests/api.rs::source_broken_event_names_the_scene`
  (a synthetic scene crashing every 100 ms, real clock: one event, `restarts: 3`, `signal: 6`, the
  record on disk; RED before: no event in 20 s).
- **Property semantics:** `path` live (above); `paused` freezes; `position` = scene time at
  start/restore/crash resume, a live set jumps; `speed` scales the clock (stepped: the step
  advance does); `kind` change → `unsupported` (both ways: `MpvSource` refuses `scene`);
  `color` → `unsupported`; `loop`, `hwdec`, `fps_cap`, `cache`, `demuxer_*`, `af`,
  `audio_delay`, `preview` stored; `gain.*`, `no_audio` and `speed` drive the worker's stream (§ "Scene
  audio (Task 6)"). Observed:
  `kind` `scene`, `ready`, `time_pos` (the clock), `duration` 0, `width`/`height` (export
  size), `has_audio` (the worker's `Ready`, `true` until then — R92), `paused`.
- **Snapshot.** A scene is saved like a video: position = `time_pos` once ready, `playing`
  (`kind_has_audio`), refreshed every 2 s while it plays (`Runtime::media_playing`); a restore
  recreates it at that position on a fresh worker (the old one died with its compositor) — a
  broken one is saved `broken: true` and restored as its preview, no worker (Task 10).
- **Probes / API.** `hello.capabilities` has `scene` when `paths::scene_worker_bin()`
  resolves and (Task 7) an assets dir does, unless synthetic scenes are allowed; `state.workers`
  = the `workers` probe's entries; `workers` (`probe/workers.rs`) — per scene source `{id, path,
  pid, state (not_spawned|starting|running|restarting N|broken|stopped), restarts_60s,
  total_restarts, sync, fourcc (e.g. `AB24`), modifier (hex), size (export), native, max_size
  (demand), fps_target, fps_actual (latched in the last second), paused, stepped, ready,
  scene_time, latched_t, latched, stale_reuses, queued, ticks_sent, frames_received, resizes,
  buffer_sets, spawns, rings, last_error}` + `reaping` (Task 10 adds `broken`,
  `restored_broken`, `resuming`, `context_losses`, `preview {path, open, shown, error}`; `state`
  is `broken` for a restored-broken scene with no worker); `sources` adds for a scene `pid,
  scene_time, latched_t, fps_target, export_size, native, step_status, error`.
- **Task 4's direct path** is `SceneSource::open_opts(gfx, SceneOpts)` (spawns at once unless
  `defer_spawn`); `SceneOpts` gained `paused`, `speed`, `stepped`, `assets_dir`, `audio`,
  `defer_spawn`. `SceneStats` gained `resizes`, `buffer_sets`, `spawns`, `slots`.

**Tests.** `tests/scene.rs` (Harness — the harness's base opts now carry `scene_worker`,
`allow_synthetic` and a private crash dir, its `run` refreshes `srcs:`'s transition half like
the runtime, and it has `scene(name, spec, extra)`, `scene_src(id)`, `add_graph_output`):
`scene_ready_is_first_latched_frame` (seq 0 at `t = 5.0`, one Ready, export 640×360),
`paused_scene_readies_with_its_first_frame` (1 tick, identical for 1 s),
`pause_freezes_picture_exactly` (paused with a tick in flight: no latch after the apply; RED
with the latch gate removed), `scene_clock_follows_speed_and_position` (2× and 0.5× live, a
jump to 100 s), `scene_tick_rate_follows_demand` (30 → 60 /s live, same pid),
`path_change_restarts_worker_and_holds_frame`, `demand_change_reexports_without_black` (+ a
2560×1440 graph output: one Resize, two buffer sets, one ring of 3 slots after; RED before the
worker's re-export). `tests/api.rs`: `scene_capability_state_and_workers_probe`,
`player_pause_freezes_scene` (real clock), `stepped_scene_is_deterministic` (two servers, 60
steps: byte-identical captures, `latched_t` = 59 × 0.016, 60 ticks; 60 steps < 15 s — RED
155 s before the fence wake), `scene_create_and_destroy_never_stall_the_loop` (the longest
stretch's **self** time ≤ 3 ms around each — `probe loop {"account": true}`'s `max_busy_self_ms`
(own time minus sleeps inside dmabuf imports, the NVIDIA global-lock driver limit; TODO F5 (2)) —
and its `workers` probe outside the destroy window; `max_busy_own_ms`, not
the wall `max_busy_ms` (TODO F5: under the parallel suite the wall maximum, 3.25–3.56 ms, was the
loop thread runnable without a core — a pinned CPU hog reproduces it: wall 3.4 ms = 0.75 own + 2.7
waiting, the stretch the test's own `probe`; the scene's destroy itself is 0.03 ms) —; RED with 5 ms
of CPU or a 5 ms sleep injected into a scene's `begin_teardown`, idle or hogged, and with a 5 ms sleep next to (not in) each import;
worker gone ≤ 600 ms), `scene_parks_and_resumes_on_hotplug` (Review Focus #4),
`capture_scene_source_is_upright`. `tests/supervise.rs`: `scene_snapshot_restores_at_position`
(SIGSEGV → restored within ±2 s, new worker, the old one gone; RED with the periodic refresh
video-only). Units: `scene_clock_excises_pauses_and_scales_by_speed`, `eff_fps_and_demand`,
`scene_kind_in_schema_and_kind_change_unsupported` (sources/scene.rs),
`kind_has_audio_counts_scenes` (onset.rs), `outputs_of` in `srcs_alias_layers_pending_and_exclusions`.

**For Tasks 6/9/11.** Task 6: `SceneSource::apply` stores `gain.*`/`no_audio` — send the
effective dB as `Gain` from there (the 1 kHz `push_gain` path calls `apply` too; F6b: a scene
whose `Ready.has_audio` was false only folds it into the restart's `Start`) and re-send
gain/`NoAudio` after a restart's `Ready` (`WorkerEvent::Restarted` → `worker_ready = false`;
hook the next `FromWorker::Ready`); `FromWorker::AudioFlowing` → push
`SourceEvent::AudioFlowing` when `flow_armed` (armed at open-unpaused, un-pause, path change);
`set_audio_route` already sends `Route`. Task 9: kind-agnostic already — a scene B is held in
`srcs:` by the transition (so its worker spawns at `start`), opened paused it readies with its
first frame (exactly one tick), un-paused it plays; `is_still` is false for a scene;
`SnapshotSource` blits its latched texture. Task 11: `create {kind: scene, path, position,
paused, preview}`; `hello.capabilities` `scene`; `state.workers`; `set out:<c>.scene_fps`
(live, same pid).
