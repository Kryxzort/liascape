<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Supervisor

`src/supervise.rs` + `main.rs` (spec §4.1 "Supervision"; Task 16, R72/R73). `liascape-player
serve …` **is the supervisor** unless `--no-supervise`: before any thread, GL context or
PipeWire connection exists it fork+execs `/proc/self/exe serve --supervised [--restore]
[--restarted <spec>] <the user's options>` (`--session-start` only on the first child — a restart is a recovery,
never a playlist start) (argv[0] kept; the child sets its comm back to
`liascape-player` — exec of `/proc/self/exe` would make it `exe`), then only waits and forwards
signals. It never binds the socket or takes the instance lock (the child does, as before),
never touches EGL/PipeWire, has no socket. `/proc/self/exe` means a restart runs the same
binary as the supervisor even after a rebuild replaced the file.

- **Child setup (between fork and exec):** empty signal mask (the supervisor blocks
  SIGCHLD/SIGINT/SIGTERM for `sigtimedwait`), `PR_SET_PDEATHSIG(SIGTERM)` then `getppid()`
  re-checked — a supervisor killed outright (SIGKILL) never leaves an orphan player: the
  child gets SIGTERM and quits cleanly.
- **Startup-failure classes (Task 16b) — two, never conflated.** `ServeError::Startup`
  (exit **1**): another instance already holds the lock, or the socket/state dir is
  unusable — waiting never fixes either, so this is a **clean exit, never retried**
  (`classify`), same as 0/2. `ServeError::NoCompositor` (exit **`EXIT_NO_COMPOSITOR`**,
  5): the compositor/EGL genuinely isn't available *yet* — `wl::Wayland::connect`
  failing (no `WAYLAND_DISPLAY`, `wl_display` connect refused) or `Gfx::new_wayland`/
  `Gfx::new_offscreen` failing (EGL init before a GPU driver/device is ready). The two
  can look identical from outside (`liascape-player serve --ao null` on a session starting
  before its compositor) but need opposite handling: "already running" burning the crash
  budget would just waste restarts on something a restart can't fix, while a hard exit 1
  on "not ready yet" would mean `liascape-player` loses every boot race against its own
  compositor coming up a moment later.
- **Clean exits end supervision** (`classify`): child exit 0 (quit, SIGTERM/SIGINT), 1
  (`ServeError::Startup`, above), 2 (usage). The supervisor exits with the same code.
- **`EXIT_NO_COMPOSITOR` gets its own backoff, not the crash budget:** [`run`]'s loop
  retries with a doubling delay — `COMPOSITOR_WAIT_INITIAL_DELAY` 0.5 s, then 1 s, 2 s,
  4 s, … — logging `supervisor.waiting_for_compositor {pid, uptime_ms, delay_ms,
  waited_ms, budget_ms}` (warn) before each sleep, until the *next* delay would push the
  running total past `compositor_wait_budget()` (`COMPOSITOR_WAIT_BUDGET` 30 s in
  production; the test-only env knob `LIASCAPE_PLAYER_TEST_COMPOSITOR_WAIT_MS` shortens it so a
  test doesn't really wait 30 s) — then `supervisor.giving_up {reason: "no_compositor",
  pid, waited_ms, budget_ms, hint}` (error) and exit `EXIT_GAVE_UP` (4 — the same code the
  crash-loop budget gives up with, distinguished by `reason`). Never counted against
  `Budget`'s 5-per-60s (no `supervisor.child_exited`/`.restart` logged for these
  attempts); a later real crash (`Exit::Abnormal`) resets the backoff streak back to its
  start, since it's an independent concern. Test: `tests/supervise.rs::
  gives_up_without_compositor_after_backoff` (a bogus `WAYLAND_DISPLAY`, the short test
  budget: 2 retries then give-up).
- **Crashes are restarted immediately:** death by a signal, a Rust panic (101),
  `EXIT_RUNTIME` 3 (the compositor connection was lost mid-run — `ServeError::Runtime`; if
  the compositor is really gone the restarted child gets `EXIT_NO_COMPOSITOR` instead,
  which the backoff above handles — never ends supervision outright), any other code. The
  new child gets `--restore` (restores the snapshot, § Snapshot) and `--restarted
  signal=N|code=N,count,total,died_ms,prev_pid,restore`, and logs
  **`supervisor.restart {signal|code, count, total, since_ms, prev_pid, restore}`**
  (warn) as its first event after the log opens (R73; `since_ms` = from the supervisor
  seeing the death, `CLOCK_MONOTONIC`, to that event). `hello.restart` repeats those fields
  — a client that reconnects after a restart (the backend adapter, Task 17) can't receive
  an event logged before it subscribed, so it reads `hello.restart` or `ctl logs
  '{"kind_prefix":"supervisor."}'`.
- **Budget:** 5 restarts per sliding 60 s (`Budget`); the 6th crash in the window →
  `supervisor.giving_up {signal|code, pid, restarts, window_s, hint}` (error) and exit 4.
  From the 4th restart in the window the child starts **without** `--restore` (a snapshot
  that crashes the player at startup must not take supervision down; `restore: false` in
  `supervisor.restart`).
- **Stop:** SIGTERM/SIGINT to the supervisor are forwarded to the child; it waits ≤ 10 s
  (`STOP_WAIT`; then SIGKILL, `supervisor.stop_timeout`) and exits with the child's status
  — never a restart. During the no-compositor backoff (no child) a SIGTERM/SIGINT ends it at
  once, exit 0, `supervisor.stopped` (`sleep_unless_stopped` = `sigtimedwait`, final review M9;
  `tests/supervise.rs::sigterm_during_compositor_backoff_exits_at_once`).
- **The supervisor's log lines** (`supervisor.child_exited {pid, signal|code, uptime_ms}`
  warn on every crash, `giving_up`, `stop_timeout`, `spawn_failed`) are appended to the
  shared `events.jsonl` with `log::append_detached` (one `O_APPEND` write per line, never
  rotates; `t_mono_ms` is the supervisor's own clock, `comp: "supervisor"`), plus one
  stderr line per restart / give-up.
- **A sent SIGSEGV/SIGBUS is a crash** (`make_sent_faults_fatal`, first thing in `serve`):
  Rust's runtime handles SIGSEGV/SIGBUS for its stack-overflow check and, for anything else,
  resets the handler and *returns* — a real fault re-faults and dies, but a `kill -SEGV`
  (si_code ≤ 0) was survived once (measured: the child kept running). Our handler re-raises
  a sent one with the default action and hands real faults back to Rust's handler.
- **Measured restart latency** (SIGSEGV → `hello` answers from the new pid): headless tests
  145–200 ms (`crash_restores`, `RLIMIT_CORE` 1), on-machine Wayland 151 / 164 ms
  (`outputs.sh`); `since_ms` 25–35 ms; the rest is the kernel tearing the old process down
  (+ ~200 ms more when systemd-coredump takes a core: 232–259 ms measured with cores on)
  and the new child's startup (~50 ms headless). On Wayland the old surfaces vanish with the
  old process, so the desktop behind shows for that ~0.2 s.
- **Test knob:** `LIASCAPE_PLAYER_TEST_CRASH=startup` → every child logs `test.crash` and aborts
  right after `supervisor.restart` (`gives_up_after_5_in_60s`). Tests set `RLIMIT_CORE` 1
  for every spawned process: the kernel then skips a piped `core_pattern` entirely ("RLIMIT_CORE
  is set to 1, aborting core"); with 0, systemd-coredump still runs and the desktop's crash
  handler (DrKonqi) pops a notification per crash.
- **Tests** (`tests/supervise.rs`, supervised headless real clock): `crash_restores`,
  `clean_quit_not_restarted` (quit; SIGTERM to the supervisor; SIGTERM to the child),
  `gives_up_after_5_in_60s`, `gives_up_without_compositor_after_backoff` (Task 16b: bogus
  `WAYLAND_DISPLAY`, the short test budget — 2 retries then give-up, never the crash
  budget's own events), `corrupt_snapshot_starts_empty`,
  `transition_in_flight_restores_as_b`, `parked_restores_parked`,
  `output_props_survive_replug`, `supervisor_sigkill_reaps_child_fast` (Task 16b: SIGKILL
  the supervisor; the child's PDEATHSIG SIGTERM — its `player.quitting {why: signal}` — must be
  stamped ≤ 300 ms after it (measured 3.5–10.3 ms under CPU + IO load), and the child must
  exit on its own within 30 s — its clean quit fsyncs the final snapshot, 0.1–11.8 s under IO
  load, which failed the old 300 ms bound on the whole exit; asserted directly, no fallback kill
  of ours in the way, so `Sup::drop`'s own teardown fallback never masks a PDEATHSIG
  regression). Snapshot preconditions wait `SNAPSHOT_WAIT` (20 s, condition-based). `tests/api.rs` runs
  `--no-supervise` (its pid/lock/SIGTERM checks are about the compositor itself);
  `wayland_serve_args_and_missing_compositor` now also passes `--no-supervise` for its
  "not available yet" (exit `EXIT_NO_COMPOSITOR`, Task 16b) assertion — the supervised
  retry-then-give-up case is `gives_up_without_compositor_after_backoff`'s job, above.
