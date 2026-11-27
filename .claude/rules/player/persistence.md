---
paths:
  - "src/player/src/snapshot.rs"
  - "src/player/src/outbox.rs"
  - "src/player/src/supervise.rs"
  - "src/player/src/mem.rs"
  - "src/player/src/main.rs"
  - "src/player/src/runtime.rs"
  - "src/player/src/sources/reaper.rs"
  - "src/player/src/probe/snapshot.rs"
  - "src/player/src/probe/memory.rs"
  - "src/player/tests/supervise.rs"
---

# liascape-player: snapshot, outbox, supervisor, memory

How they work: `docs/player/modules/persistence.md` (memory: `docs/player/modules/runtime.md`). The backend's side of a
restart: `.claude/rules/backend/player-adapter.md`.

## Snapshot (`src/player/src/snapshot.rs`)
- The player is the one authority for `player.paused`; it is restored from the snapshot and the backend never
  re-asserts it.
- Never save effects, `snapshot`-kind sources, graves, held A's or any transition scaffolding. Save an in-flight
  transition as its target B — except an `align: end` one before Running, saved as A. Guard unit
  `aligned_pending_transition_is_saved_as_a`.
- Save an animating value at `Animator::live_target_of` while live, else the value itself.
- Queue the final snapshot on `quit`/SIGTERM/`loop.failed` before `stop_all` empties the graph, then freeze.
- Write via temp + `fsync` + rename + dir `fsync` on `lia-snapshot` only; never on the loop. A switch's reply never
  waits for it — the adapter reconciles after a restart.
- `--restore` never crash-loops on a bad file: corrupt/unknown version/dangling ref → `snapshot.invalid`, file moved
  aside, start empty. Restore the exact saved position (no elapsed-time compensation).
- A restored playing video starts at `gain.anticlick` −96 with a not-yet-started ramp (corr `restore-fade`)
  re-added at `source.ready` — invariant #8. Restored ids are fresh; never assume saved ids survive.
- Put restored content on its layer only once the source has a picture (`Runtime::show_when_ready` /
  `show_pending`: a texture — its first frame or a restarting scene's preview), never at once; a scene restored
  `broken` shows its preview at once. Count a waiting layer as showing its source (`cur:`, `srcs:`,
  `state.outputs[].pending`, the snapshot). A `transition` (`Runtime::start_switch`; an `align: end` one keeps a
  waiting video as its A; a refused one changes nothing, its timeout still counted from the start), a `content` set,
  `stop` or the output going ends the wait and retires a source no layer waits for. A scene broken during the wait
  shows its broken display; another failure with no picture, or the timeout (paused by a hold), retires it. Guards:
  `src/player/tests/api.rs` `restore_waits_for_ready_no_seam`, `restore_pending_is_cancelled_by_a_switch`,
  `restore_broken_scene_shows_its_preview`, `restore_pending_dropped_on_error`, `restore_pending_times_out`,
  `restore_pending_outlives_a_refused_switch`, `restore_preview_shows_while_the_worker_restarts`,
  `src/player/tests/supervise.rs` `restore_wait_survives_a_low_vram_hold`.
- Slow every write deterministically in a test with `LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS`.

## Outbox (`src/player/src/outbox.rs`)
- Append a fact the backend must store even when not listening with `outbox::with_seq(kind, &mut fields)` at the
  point it is logged; it adds `outbox_seq` to the live event (a no-op without `outbox::install`, in harnesses).
- Every backend handler of an outbox kind must be idempotent: a fact can arrive live and again from the drain.
- `seq` stays monotonic across restarts and is written first in each line so reads skip without parsing; a failed
  append uses no seq.
- Never `fsync` an append; compaction runs on `lia-snapshot` and never `fsync`s under the outbox lock (the loop may
  append meanwhile). The file is bounded (`OUTBOX_MAX` unacked); a read past dropped entries reports `dropped_before`.
- Guards: unit tests in `outbox.rs`; `src/player/tests/api.rs` `outbox_persists_across_restart_and_acks`,
  `outbox_is_bounded`, `live_events_carry_outbox_seq`.

## Supervisor (`src/player/src/supervise.rs`)
- `serve` without `--no-supervise` fork+execs `/proc/self/exe serve --supervised …` before any thread, GL context or
  PipeWire connection exists; the supervisor never binds the socket, takes the lock or touches EGL/PipeWire, and logs
  with `log::append_detached` (one `O_APPEND` write, never rotates). `--session-start` goes to the first child only.
- The child sets `PR_SET_PDEATHSIG(SIGTERM)` then re-checks `getppid()`. Guard
  `src/player/tests/supervise.rs` `supervisor_sigkill_reaps_child_fast`.
- Keep the two startup failures apart: `ServeError::Startup` (exit 1: lock held, bad socket/state dir) is never
  retried; `ServeError::NoCompositor` (`EXIT_NO_COMPOSITOR`) retries with doubling backoff up to
  `COMPOSITOR_WAIT_BUDGET`, never against the crash budget. Guard `gives_up_without_compositor_after_backoff`.
- Exit 0/1/2 end supervision; a signal, panic (101), `EXIT_RUNTIME` or any other code restarts at once with
  `--restore`. 5 restarts per 60 s, the 6th gives up (`EXIT_GAVE_UP`); from the 4th restart in the window start
  without `--restore`.
- The restarted child logs `supervisor.restart` first and repeats it in `hello.restart` — a reconnecting client
  can't see events from before it subscribed.
- SIGTERM/SIGINT are forwarded; after `STOP_WAIT` the child is SIGKILLed. During the no-compositor backoff a signal
  exits at once (`sleep_unless_stopped`). Guard `sigterm_during_compositor_backoff_exits_at_once`.
- `make_sent_faults_fatal` (first thing in `serve`) re-raises a sent SIGSEGV/SIGBUS; Rust's handler alone survives a
  `kill -SEGV`.
- Tests set `RLIMIT_CORE` 1 on every spawned process (0 still runs systemd-coredump and pops crash dialogs);
  `src/player/tests/api.rs` runs `--no-supervise`. Knobs: `LIASCAPE_PLAYER_TEST_CRASH=startup`,
  `LIASCAPE_PLAYER_TEST_COMPOSITOR_WAIT_MS`.

## Memory (`src/player/src/mem.rs`)
- `mem::apply_policy` is the first line of `runtime::serve`, before any mpv core exists: fixed
  `M_MMAP_THRESHOLD` (`mem::MMAP_THRESHOLD`) so freed mpv frame pools don't stay in glibc arenas. A caller's own
  `MALLOC_MMAP_THRESHOLD_` / `GLIBC_TUNABLES` value wins; `LIASCAPE_PLAYER_MALLOC=glibc` skips the policy (A/B).
- `malloc_trim(0)` runs on the `lia-mpv-reaper` thread after each batch (`mem::trim_after_reap`), never on the loop
  and never once `reaper::shutdown` started. Never add an arena cap (`docs/decisions.md` § "Fix glibc's mmap
  threshold at 128 KiB and trim after each reaper batch").
- Read RSS growth with the `memory` probe: live bytes flat + `free_bytes` growing = retention, live growing = a leak.
  Guard `src/player/tests/api.rs` `t20b_switch_loop_rss_stays_flat`.
