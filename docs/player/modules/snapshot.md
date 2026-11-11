<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Snapshot

`src/snapshot.rs` + `Runtime` (spec §4.1; Task 16, R74). What the player shows, persisted
to `<state>/snapshot.json` so a restarted player comes back with the same wallpaper at the
same place.

- **Format (`version` 1, pretty JSON):** `saved_unix_ms`; `player` (settable Player props:
  `debug`, `paused` — the player is the one authority for pause, restored with the snapshot;
  the backend never re-asserts it, I3); `outputs` — per present connector `{content: <source key>|null, props
  (settable output props ≠ default: layer, paused), layer (main layer fit, viewport,
  opacity)}`; `output_props` — remembered props of connectors not present; `sources` — per
  referenced source `{kind, path, position, paused, speed, loop, gains (set slots except
  xfade/anticlick), props (every other settable source prop: color, hwdec, fps_cap, cache,
  demuxer_*, af, no_audio, audio_delay), playing, transition_target, broken (Phase 2 Task
  10: a scene past its restart budget — only when true; restored as its preview, no worker)}`;
  `parked` — `{id,
  resume_paused, connector}`; `programs` (Phase 3, only when there is one) — each program's dynamic state
  (§ Programs "Persistence"; its configuration is `program.json`, written by the same thread). Source keys are references inside the file only: a restore
  mints fresh ids (`snapshot.restored.ids` maps old → new).
- **Excluded:** effects, `snapshot`-kind sources, sources no output shows (graves, held A's,
  anything created but not shown), every in-flight transition's scaffolding. **A transition
  in flight is saved as its target B** on the outputs it covers (`transition_target: true`,
  `paused: false`, no xfade/anticlick, its position = its requested start until it plays) —
  **except an `align: end` one before Running** (2026-10-28), saved as **A where it plays**: B
  restored at once cut A's remaining play short, and the backend re-arms the switch on the
  restarted player (player-adapter.md § Reconnection; A keeps the `loop: false` its wait set —
  without a backend it holds its last frame). `TransitionStatus.align` (also in `state`'s
  `transitions`) carries it. Unit `aligned_pending_transition_is_saved_as_a` (RED: `bnew`).
  An effect shown without a transition is saved as its `to` side.
- **Values:** an animating number (gain, opacity, speed) is saved at the animation's target
  while it is **live** (`Animator::live_target_of`), else the value itself — a finished
  animation's target is stale once something `set` the prop (outputs.sh caught 0.97
  restored after `animate` → 0.97 then `set` 1). Position = `time_pos` once a video is
  ready, else the requested `position`.
- **When:** `DEBOUNCE` 250 ms after the first unsaved change (any drained graph change or
  `picture_rev` move — sets, creates, destroys; a burst is one write, a continuous
  animation can't postpone it; a one-shot calloop timer wakes a stepped-clock loop), every
  `REFRESH` 2 s while a video plays (positions move without changes), at startup (a fresh
  start must not leave an older session's snapshot for the next crash), and once more on
  exit: `quit`/SIGTERM and the `loop.failed` path queue the **final** snapshot *before*
  `stop_all` empties the graph, then no more writes (`frozen`) — so a later `serve
  --restore` brings back what was on screen; `stop` itself is a change → an empty snapshot.
- **Writing:** on the `lia-snapshot` thread (latest queued wins): `snapshot.json.tmp` +
  `fsync`, rename, `fsync` the dir — a crash mid-write leaves the previous file. Failures:
  `snapshot.write_failed` once per streak (+ hint), `write_recovered`; `snapshot.saved
  {bytes, write_ms}` at debug. The writer is joined in `shutdown`. **The window is the
  backend's to close:** a write lags a switch by the debounce + its fsync (2.4 s once under
  I/O load), so a crash in it restores the wallpaper before the switch; a switch's reply can't
  wait for an fsync, so the adapter compares what a restarted player shows with what it last
  switched to and switches back (player-adapter.md § Reconnection, `ReconcileShown`).
  **Test knob** `LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS=N`: every write takes N ms more (counted in
  `write_ms` / the probe's `last_write_ms`) — a snapshot that lags and a slow clean quit,
  deterministically (the adapter IT).
- **`--restore`:** missing file → `snapshot.none`; unreadable/corrupt JSON/unknown
  `version`/dangling reference → `snapshot.invalid {reason, moved_to}`, the file moved to
  `snapshot.invalid.json`, the player starts empty (never a crash loop over a bad file).
  Otherwise, after the initial outputs exist: player props; each saved connector that is
  present gets its output props, main-layer settings and content at the saved position
  (**exactly** the saved position — no elapsed-time compensation; the 2 s refresh bounds
  the drift); a saved connector that is missing keeps its props for when it appears, and its
  content — unless a present output shows it — is **parked for that connector**
  (`Parked::connector`; shown when that connector appears, before any other rule; only one
  wallpaper can be parked — further ones `snapshot.dropped`); the saved parked wallpaper is
  shown on the outputs that show nothing, else parked again; a present connector the
  snapshot didn't know shows the current wallpaper (as hotplug would). Then
  `snapshot.restored {sources, outputs, age_ms, parked, ids}`. A value the schema rejects
  is `snapshot.prop_rejected` / `snapshot.source_failed` and skipped.
- **Audio on restore (core invariant):** a restored playing video starts at
  `gain.anticlick` −96 with a *not-yet-started* animation to 0 dB (corr `restore-fade`);
  at `source.ready` that animation is re-added from now (30 ms ramp in). Until then
  `target_of` reports 0 dB, so a transition starting meanwhile records (R41) the 0 dB it is
  heading to; a recipe's own anticlick ramp supersedes it (the restore fade then does
  nothing); parking cancels it (unpark ramps from −96).
- **`snapshot` probe:** `{path, writes, failures, last_write_ms, since_last_write_ms,
  due_in_ms, frozen, current}` — `current` is what would be written now.
- **Other jobs on `lia-snapshot`:** `Writer::runner()` hands out a `Runner` that queues a closure on the writer thread
  (the outbox's compaction, § Outbox); a batch runs them first, then the state files, then the snapshot. `finish` sends
  a `Stop` job (a `Runner` keeps the channel open, so the thread can't wait for every sender to go).
