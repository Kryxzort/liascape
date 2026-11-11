# Scene worker: protocol and process lifecycle

Covers `src/player/src/worker/` (`proto.rs`, `mod.rs`, `reap`) and the process side of
`src/player/src/bin/liascape-scene-worker/` (`main.rs`). Rules: `.claude/rules/player/scenes.md` § Protocol,
§ Worker host lifecycle, § Build. Siblings: [scene-frame-transport.md](scene-frame-transport.md),
[scene-source.md](scene-source.md), [scene-crash-policy.md](scene-crash-policy.md),
[scene-lwe-core.md](scene-lwe-core.md), [scene-audio.md](scene-audio.md), [scene-loudness.md](scene-loudness.md),
[scene-gpu-budget.md](scene-gpu-budget.md). Measurements: `docs/player/spikes/dmabuf.md`.

A Wallpaper Engine scene renders in its own `liascape-scene-worker` process — one per scene source, shared by every
output showing it. The compositor drives it over a socket and samples its dmabuf frames, so an LWE crash, hang or
GPU reset never takes the compositor with it.

## Protocol (`worker/proto.rs`)

One JSON object per `SOCK_SEQPACKET` datagram (≤ `MAX_MSG`, 64 KiB), fds on the same datagram via `SCM_RIGHTS`
(≤ `MAX_FDS`, 8), internally tagged by `msg`. `Hello {protocol, pid, features, sync}` comes first; the host answers
with `Start`. Scene time `t` in `Tick`/`Frame` is the compositor's scene clock. `Tick.input` carries the visualiser's
system audio since the last tick (stereo s16, base64). `AudioRoute` is `"null" | "default" | {"device": …}`; a dmabuf
`modifier` is an exact u64. `send` refuses oversize, uses `MSG_NOSIGNAL` (a gone peer is `EPIPE`, never SIGPIPE);
`recv` never blocks and consumes a bad datagram (closing its fds) so the next one parses. Received fds are
`CLOEXEC`.

## `WorkerHost` (`worker/mod.rs`)

States: `Starting` (no `Hello`) → `Running` → on a crash `Restarting {attempt}` → `Running`, or `Broken`, or
`Stopped`. `poll(now)` never blocks: it reads only what epoll says is readable, runs the heartbeat, reaps and
restarts; `waitpid` runs every poll only once the worker is ending, else every `REAP_CHECK` (100 ms).

- **Spawn** is `posix_spawn` (glibc's `CLONE_VM|CLONE_VFORK`: no page-table copy of the compositor, 0.2–0.7 ms of
  loop time). It runs on the loop because `PR_SET_PDEATHSIG` fires when the spawning thread exits and pool threads
  exit when idle. A long-lived spawn thread would take the vfork off the loop but make the pid arrive late for every
  kill/reap path; not done. The child gets the socket at fd 3, stdout+stderr on one pipe (the log tail), stdin
  `/dev/null`; the parent's copies are renumbered ≥ 10 first so no `dup2` clobbers another and fd 3 never equals its
  source (an `adddup2(3, 3)` would keep `CLOEXEC`). Signal mask empty and dispositions default (the compositor blocks
  SIGINT/SIGTERM for its signalfd).
- **`wake_fd()`** is an epoll fd over the current socket and pipe, stable across restarts: a dup of the old socket
  would read EOF forever after a restart.
- **Crash** = socket EOF or the process gone; a process that closed its socket but lives on is SIGKILLed after 1 s.
  On reap the output is drained to EOF (so the crash's last stderr lines make the record), then the budget (3 per
  sliding 60 s) admits a respawn with the last `Start` at the resume position, or the source breaks
  ([scene-crash-policy.md](scene-crash-policy.md)).
- **Folding.** `Start`, `Paused`, `Resize`, `Route`, `SetProperty`, `Gain`, `NoAudio`, `Speed` and `LoudnessMeter`
  are recorded even while connected and folded into the restart's `Start`, so a restart never resumes with a stale
  pause, size, route, property, level or meter. Other messages while not connected are `NotConnected`; the caller
  re-sends gains and the pointer after the new worker's `Ready`. `WouldBlock` = the worker isn't reading.
- **Fatal errors are not crashes.** `error {fatal: true}` (no GPU, load or build failed, protocol mismatch — a
  `Hello` with another `protocol` is turned into one by the host) leaves the worker idle until `quit`: no restart, no
  crash record.
- **`stop()`/`Drop`** send `quit` and hand the pid to the `lia-worker-reap` thread (started on demand), which
  SIGKILLs at `STOP_GRACE` (500 ms). `stop` drains the pipe first so a fatal error's own stderr line stays in the
  tail. `kill_for_restart(why)` SIGKILLs a live worker as a crash with `why` leading the record's reason.
- **Log tail:** the last `LOG_TAIL` (50) lines of output and `log` messages across restarts, with a marker line
  between processes; `ctl probe '{"name":"workers","args":{"log_tail":true}}'` shows it — LWE's own warnings for a
  scene that loads but renders wrong, not only for one that crashed.
- **Crash record** `<state>/crashes/<scene-id>-<unix_ms>.json` (temp + rename): source id, path, reason,
  signal/code, restarts, uptime, log tail; the oldest beyond `MAX_CRASH_RECORDS` (20) are removed.

## The heartbeat

Every `Tick` (answered by any `Frame` with `seq` ≥ it) and `Ping` is recorded; the oldest unanswered one older than
the hang timeout (`HANG_TIMEOUT` 2 s, `LIASCAPE_SCENE_WORKER_HANG_MS`) → SIGKILL + `Hung`. With no ticks flowing a
`Ping` goes every `hang_timeout / 2` (so a hang shows within 1.5 × the timeout), counted from the last tick or ping
sent — other traffic never postpones it. No `Hello` within `HELLO_TIMEOUT` (5 s) is a hang too.

"Hung" means the worker is the reason no frame comes, so two waits don't count:

- **Starved of slots.** The host tracks the worker's ring and the slots it holds (named by a `Frame`, not yet
  released). Holding every slot, the worker can't render — its outstanding ticks are re-stamped each poll and its
  liveness is the ping (the idle renderer answers it, and checks the GPU reset status on it). Bounded at
  `STARVE_LIMIT_FACTOR` (5) × the timeout: slots that never come back (a fence that never signals) are recovered by a
  restart's fresh ring.
- **The host's own stall.** A gap between two polls longer than `hang_timeout / 2` means the compositor didn't run
  (blocked in the driver, e.g. NVIDIA's VRAM save around a suspend took ~6.4 s): every outstanding tick, ping and
  pending `Hello` gets a fresh timeout from that poll (`worker.host_stalled`). Suspend time itself never counts
  (`CLOCK_MONOTONIC` stops in S3).

## The worker binary

`liascape-scene-worker --fd N --parent-pid P [--stub]`. It sets `PR_SET_PDEATHSIG(SIGKILL)` first, exits 3 if
`getppid()` ≠ `--parent-pid` (the parent died before the prctl), then sets its soft `RLIMIT_CORE` to 1 so an LWE
crash never reaches systemd-coredump or a desktop crash dialog (`LIASCAPE_SCENE_WORKER_COREDUMP=1` keeps the
inherited limit). It keeps its socket `CLOEXEC`: nothing it starts may hold it, since EOF is the crash signal.

- **Threads.** The renderer (main thread: GL, ring, LWE), `lia-scene-proto` (reads the socket, hands messages over a
  channel), `lia-scene-audio` (only for a scene with sound, [scene-audio.md](scene-audio.md)), `lia-scene-media`
  (MPRIS for scenes that use media events). While the renderer is inside a load + build (`LoadGate`; a cold build
  took up to 2.8 s, a heavy scene's ~5 s of CPU) the protocol thread answers pings itself, bounded by
  `LIASCAPE_SCENE_LOAD_TIMEOUT_MS` (30 s). Past the bound a load that still makes progress — the renderer thread's
  CPU time (`/proc/self/task/<tid>/schedstat`) advanced within the last third of the bound — stays covered, up to
  `LOAD_TIMEOUT_MAX_FACTOR` (4) × the bound. LWE's build is one thread on the CPU and a saturated machine queues it
  (6.3 s quiet, 21–28 s at 3–5 runnable threads per CPU); a deadlocked load sleeps, so its CPU time stops. A `Quit`
  or EOF during a load `_exit(0)`s at once; `Resize`/`Pointer`/`SetProperty` queue and apply after it.
- **`--stub`** (tests, no GPU) answers pings and ticks with fd-less frames and is scripted by
  `LIASCAPE_SCENE_WORKER_TEST` (`crash_after_ms`, `hang_after_ms`, `ring:N` for slot starvation, `freeze_after_ms`
  + `freeze_ms`, `exit_code`, `ignore_quit`, `spam_stderr`). Without `--stub`, a folder holding
  `liascape-synthetic.json` plays the synthetic renderer when `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`
  (`scene::synthetic::SyntheticSpec`: patterns, `gpu_work`, tones, `load_ms`, `fail`, `gpu_stall`,
  `context_lost_after_ms`); `tests/common::synthetic_scene` writes such a folder.
- **Build.** Only this binary links LWE's core (`cargo::rustc-link-arg-bin`); the compositor never does. Without
  feature `lwe` (`--no-default-features`, `install.sh --no-scenes`) it runs the stub and the synthetic renderer only.
  `paths::scene_worker_bin()` = `$LIASCAPE_SCENE_WORKER_BIN` (if it names a file) → next to `/proc/self/exe` → `PATH`.

**Test gotcha:** a sibling test's `posix_spawn` holds a copy of every fd, `CLOEXEC` ones included, for the
microseconds between its clone and exec — a test that closes one end and expects EOF must `poll` for the hang-up
first.
