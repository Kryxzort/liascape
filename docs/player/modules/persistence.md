# Persistence and restart: snapshot, outbox, supervisor

Covers `src/player/src/snapshot.rs`, `outbox.rs`, `supervise.rs` and their wiring in `runtime.rs`/`main.rs`.
Rules: `.claude/rules/player/core.md` § Snapshot, § Outbox, § Supervisor. The backend's side of a restart:
`.claude/rules/backend/player-adapter.md`.

## Snapshot (`<state>/snapshot.json`)

What the player shows, so a restarted player comes back with the same wallpaper at the same place.

- **Content.** `player` (settable player props: `debug`, `paused`, the cover/automute/VRAM settings); per present
  connector its content (a source key), non-default output props and main-layer settings; `output_props` of
  absent connectors; per referenced source its kind, path, position, paused, speed, loop, set gain slots
  (transient `xfade`/`anticlick`/`pause` excluded), every other settable prop, `transition_target`, and
  `broken` for a scene past its restart budget; `parked`; each program's dynamic state (its definition is
  `program.json`, [programs.md](programs.md)). Source keys are references inside the file only: a restore mints
  fresh ids (`snapshot.restored.ids` maps old → new).
- **In-flight transitions** are saved as their target B (`transition_target: true`, unpaused, at B's requested
  start until it plays) — except an `align: end` one before Running, saved as A where it plays: restoring B at
  once would cut A's remaining play short, and the backend re-arms the switch on the restarted player. An effect
  shown without a transition is saved as its `to` side.
- **When.** `DEBOUNCE` (250 ms) after the first unsaved change (any drained graph change or `picture_rev` move;
  a burst is one write and a continuous animation can't postpone it), every `REFRESH` (2 s) while a video or
  program plays, at startup (a fresh start must not leave an older session's file for the next crash), and the
  final one on exit — queued before `stop_all` empties the graph, then `frozen`. `stop` itself is a change, so it
  saves an empty snapshot.
- **The crash window is the backend's to close.** A write lags a switch by the debounce plus its `fsync` (2.4 s
  seen under I/O load), so a crash inside it restores the previous wallpaper. A switch reply can't wait for an
  `fsync`; the adapter compares what a restarted player shows with what it last switched to and switches back.
- **Restore.** After the initial outputs exist: player props; each present saved connector gets its props,
  layer settings and content at exactly the saved position (the 2 s refresh bounds the drift); an absent saved
  connector keeps its props and its content is parked for that connector (`Parked::connector`, shown first when
  it appears; only one wallpaper can be parked — others log `snapshot.dropped`); a present connector the file
  didn't know shows the current wallpaper. A value the schema rejects is skipped (`snapshot.prop_rejected`,
  `snapshot.source_failed`).
- **Audio on restore.** A restored playing video starts at `gain.anticlick` −96 with a not-yet-started ramp to
  0 dB (corr `restore-fade`), re-added from now once it is `Ready` and its audio flows. Until then `target_of`
  reports 0 dB, so a transition starting meanwhile records where it is heading; a recipe's own anticlick ramp
  supersedes it; parking cancels it.
- **`lia-snapshot` thread.** Latest queued job wins; it also runs the outbox compaction (`Writer::runner`) and
  writes `program.json`/`resume.json` before the snapshot queued with them. `finish` sends an explicit `Stop`
  because a `Runner` keeps the channel open.

## Outbox (`<state>/outbox.jsonl`)

Facts the backend must store even when it isn't listening (app closed while the player rotates by itself, a
reconnect gap): `source.broken` (the item is marked crashed), `scene.loudness` (the index) and
`scene.vram_exceeded` (UI text). They are appended where they are logged (`outbox::with_seq`), and the live event
carries `outbox_seq` so the backend acks what it handled live. The backend drains it on every (re)subscription.

- Lines are `{"seq":N,"t_wall":…,"kind":…,"fields":{…}}` with `seq` written first by hand (serde_json sorts keys)
  so a read skips lines without parsing. At open `seq` continues after the newest of the last line,
  `outbox.state.json`'s `last_seq` and its `acked`, so an acked, compacted-empty file still continues.
- Appends: `O_APPEND`, one `write` per line from any thread under one mutex, never `fsync`ed (a crash keeps the
  page cache; a power loss can lose the newest lines). A torn last line found at open is terminated and skipped.
- Bound: `OUTBOX_MAX` (2000) unacked. Compaction runs once the file holds `COMPACT_SLACK` (200) lines past the
  bound, and at open when it is past the bound or holds acked lines. `dropped_before` in a read = the first seq kept
  when entries past `after` were lost (`dropped_through` is persisted for compactions).
- `outbox.ack {seq}` moves `acked` at once (reads skip ≤ seq) and queues a compaction on `lia-snapshot`: unacked
  entries to a temp file + `fsync`, state file atomically, then under the lock the lines appended since are copied
  over, the temp renamed and the append handle reopened; the directory is `fsync`ed after. A crash before the
  rename leaves the old file and the new state: acked lines are skipped and compacted at the next open.
- Delivery is at-least-once (live, then again from the drain, or again after a crash before the ack).

## Supervisor

`serve` without `--no-supervise` fork+execs `/proc/self/exe serve --supervised [--restore] [--restarted <spec>]
<the user's options>` before any thread, GL context or PipeWire connection exists, then only waits and forwards
signals. `/proc/self/exe` means a restart runs the same binary even after a rebuild replaced the file; the child
sets its comm back to `liascape-player`.

- **Two startup failures, opposite handling.** `ServeError::Startup` (exit 1: lock held, bad socket/state dir) —
  waiting never fixes it, so it ends supervision like 0 and 2. `ServeError::NoCompositor` (exit 5: Wayland connect
  or EGL init failed) — the compositor may be a moment away, so it is retried with a doubling delay from
  `COMPOSITOR_WAIT_INITIAL_DELAY` (0.5 s) until the next delay would pass `COMPOSITOR_WAIT_BUDGET` (30 s), then
  `supervisor.giving_up {reason: "no_compositor"}` and exit 4. These attempts never count against the crash budget;
  a real crash resets the backoff.
- **Crashes** — a signal, a panic (101), `EXIT_RUNTIME` (3) or any other code — restart at once with `--restore`.
  Budget: 5 restarts per sliding 60 s; the 6th gives up with exit 4. From the 4th restart in the window the child
  starts without `--restore`, so a snapshot that crashes the player at startup can't take supervision down.
  `--session-start` goes to the first child only: a restart is a recovery, never a playlist start.
- **The restarted child logs `supervisor.restart {signal|code, count, total, since_ms, prev_pid, restore}` first**
  and repeats it in `hello.restart`: a reconnecting client can't receive an event logged before it subscribed.
- **Stop.** SIGTERM/SIGINT are forwarded; after `STOP_WAIT` (10 s) the child is SIGKILLed; the supervisor exits
  with the child's status. During the compositor backoff there is no child and a signal exits at once.
- **Orphans.** The child sets `PR_SET_PDEATHSIG(SIGTERM)` and re-checks `getppid()`: a SIGKILLed supervisor
  gets its child to quit cleanly within milliseconds (the clean quit's final snapshot `fsync` can take seconds
  under I/O load).
- **A sent SIGSEGV/SIGBUS is a crash** (`make_sent_faults_fatal`): Rust's handler resets and returns for a fault
  it doesn't own, so a real fault re-faults and dies but a `kill -SEGV` (si_code ≤ 0) was survived.
- **Log.** The supervisor appends `supervisor.*` lines to the shared `events.jsonl` with
  `log::append_detached` (its own clock, never rotates), plus one stderr line per restart or give-up.
- **Restart latency:** SIGSEGV → `hello` from the new pid 145–200 ms headless, ~150–165 ms on Wayland (the
  desktop shows through for that long); most of it is the kernel tearing the old process down and the new
  child's startup. A systemd-coredump capture adds ~200 ms, which is why tests set `RLIMIT_CORE` 1 (0 still runs
  the piped core handler and pops a crash dialog).
