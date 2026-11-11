<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Scene worker

Phase 2 (plan `docs/superpowers/plans/2026-10-27-liascape-player-phase2-scene-worker.md`, Tasks
1–13 plus the scene-properties editor and loudness learning; spec §4.1, §5.2, §6.3; evidence
`docs/player/spikes/dmabuf.md`; only the on-machine battery, Task 14, is still to run). A WE scene
renders in its own `liascape-scene-worker` process — **one per scene source, shared by every output
showing it** (D1) — the compositor drives it over a socket and samples its frames.
`src/worker/` is the compositor side, `src/bin/liascape-scene-worker/` the worker. This section is
organised by the task that built each part; the subsections below are the as-built source of
truth where they disagree with the plan or with the Task 3 text directly under this paragraph.
Map: protocol + lifecycle (here) · "Frame transport" · "LWE core" · "The `scene` Source kind" ·
"Real scenes" · "Scene audio" · "Scene loudness" · "GPU budget and VRAM" · "Transitions with
scenes" · "Crash policy" · "Scene corpus" · "Scene health".

**Protocol (`worker/proto.rs`, `PROTOCOL` 5 — bumped by Task 6, audio, twice by scene loudness and by the stereo
visualiser input (`Tick.input` = `AudioInput {rate, s16}`: the frames since the last tick, 16-bit stereo LE, base64;
it was 1024 u8 mono samples); the
shapes below are Task 3's plus the additions named inline and in the later subsections: `Start` also
carries `id`, `gain_db`, `no_audio`, `speed`, `properties`, `loudness`; `ToWorker::Speed`, `ToWorker::LoudnessMeter`; `FromWorker::Loudness`).** One JSON object per `SOCK_SEQPACKET`
datagram, ≤ `MAX_MSG` (64 KiB), fds on the same datagram via `SCM_RIGHTS` (≤ `MAX_FDS` 8).
Internally tagged by **`msg`** (snake_case variant name — not `t`, which `Tick`/`Frame` use
for scene time): `{"msg":"tick","seq":3,"t":0.02,"input":null}`. `ToWorker`: `start {path,
assets_dir, steam_dir, position, paused, audio, max_size, synthetic, properties}`, `tick {seq,
t, input}`, `release {slot}` (+ optional release fence fd), `gain`, `paused`, `no_audio`,
`route`, `pointer {x, y, buttons}` (native scene px), `set_property {name, value}` (Task 7),
`resize {max_size}`, `ping {seq}`, `quit`. `FromWorker`: `hello
{protocol, pid, features, sync}` (first message; `features` ⊂ `stub|synthetic|lwe`, `sync` =
`fence|fdpoll|none`), `buffer {slot, w, h, fourcc, modifier, planes}` (+ one fd per plane),
`frame {slot, seq, t, gpu_ms}` (+ acquire fence fd, none in fdpoll), `ready {native,
has_audio, wants_audio_input}`, `has_audio`, `audio_flowing`, `envelope`, `property_set {name,
ok, reason}` (Task 7), `pong`, `error {reason, fatal}`, `context_lost`, `log`.
`AudioRoute` = `"null"|"default"|{"device":"…"}`; a `modifier` is a JSON integer (u64, exact).
`proto::send` refuses > 64 KiB / > 8 fds (`InvalidInput`), sends `MSG_NOSIGNAL` (a gone peer
is `EPIPE`, never SIGPIPE); `proto::recv` never blocks — `Ok(None)` nothing queued,
`Err(UnexpectedEof)` peer gone, `Err(InvalidData)` an oversized/garbage/unknown datagram (it
is consumed and its fds closed; the next one parses). Received fds are `CLOEXEC`.

**`WorkerHost` (`worker/mod.rs`) — one worker process, supervised.**
`WorkerSpec::new(id, bin, start)` = production defaults (`args` [], `env` [],
`hang_timeout` `HANG_TIMEOUT` 2 s, `budget` 3 per 60 s, `crash_dir` `paths::crash_dir()` =
`<state>/crashes/`); tests set `args: ["--stub"]`, a short budget/timeout, a private dir.
States: `Starting` (spawned, no `Hello`) → `Running` (the host answers `Hello` with the
spec's `Start`) → on a crash `Restarting {attempt}` → `Running` …, or `Broken {reason}`, or
`Stopped`. `poll(now)` never blocks: drains output + messages, runs the heartbeat, reaps,
restarts — call it on every wake **and** regularly (time must pass for a hang to show).
Events: `Msg(FromWorker, fds)` (everything but `Pong`), `Exited {signal|code}` (every
process end, hung or not), `Hung {waited_ms}`, `Restarted {attempt}`, `Broken {record}`.
- **Spawn = `posix_spawn` on the calling thread** (glibc: `clone(CLONE_VM|CLONE_VFORK)`, no
  page-table copy of the compositor — measured 0.24–0.35 ms per `spawn()` in the test
  binary), not `fork` on an `lia-open` pool thread as the plan had it: **`PR_SET_PDEATHSIG`
  fires when the spawning *thread* exits** (`prctl(2)`), and the pool's threads exit when
  idle — every worker would die with them. So Task 5 spawns from the loop thread. The vfork
  holds the loop until the child execs: 0.2–0.7 ms per spawn measured (bpftrace on `clone`,
  2026-11-02), more when the child waits for a core — TODO F5; a long-lived `lia-spawn` thread
  would take it off the loop but makes the pid arrive late (every `kill`/`waitpid`/reap path
  would have to wait for it), not done. The worker
  sets `PR_SET_PDEATHSIG(SIGKILL)` itself, first thing, then exits 3 unless `getppid()` ==
  `--parent-pid` (the parent died before the prctl). Child fds: socket end at **fd 3**
  (`--fd 3`), stdout + stderr on one pipe (the log tail), stdin `/dev/null`; the parent's
  copies are `CLOEXEC` and renumbered ≥ 10 first, so no `dup2` clobbers another and fd 3 never
  equals its source (an `adddup2(3, 3)` would keep `CLOEXEC`). Empty signal mask + default
  dispositions for SIGPIPE/INT/TERM/HUP/QUIT/CHLD/USR1/USR2/ALRM (the compositor blocks
  SIGINT/SIGTERM for its signalfd). Env = the compositor's + `spec.env` (overriding).
- **`wake_fd()` is an epoll fd** over the current socket + output pipe — stable across
  restarts (a dup of the old socket would read EOF forever after a restart: a busy loop),
  readable whenever `poll` has work. The host owns it; register a dup, like mpv wake fds.
- **Crash = socket EOF or the process gone** (`waitpid(pid, WNOHANG)`; spike §6). A process
  that closed its socket but lives on is SIGKILLed after 1 s. On reap: output drained to
  EOF (so a crash's last stderr lines make the record), `Exited`, then the budget:
  `RestartBudget::admit(history, now)` (sliding window, unit `budget_window_slides`) →
  respawn with the **last `Start` at `set_resume_position`** → `Restarted {attempt}` (1, 2,
  3), or `Broken` + a crash record. `restarts(now)` = (in the window, total).
- **Heartbeat.** `send` records every `Tick` (answered by any `Frame` with `seq` ≥ it) and
  `Ping`; the oldest unanswered one older than `hang_timeout` → SIGKILL + `Hung` (+ `Exited`
  once reaped, then the restart policy). No ticks flowing → `Ping` every `PING_INTERVAL`
  (1 s), **shortened to `hang_timeout / 2`** so a hang is always seen within 1.5 ×
  `hang_timeout` (the plan's 1 s ping could not meet `hang_after_ms 100, hang_timeout 300 →
  Hung ≤ 600 ms`); the cadence counts from the last `Tick`/`Ping` sent (`last_beat`) — other
  traffic (gains, the pointer) never postpones a ping. No `Hello` within `HELLO_TIMEOUT` (5 s,
  or `hang_timeout` if longer) = hung too. The worker keeps answering while LWE loads + builds
  (its `lia-scene-proto` thread answers pings during a load, bounded — § "Real scenes (Task 7)").
  **"Hung" = the worker is the reason no frame comes** (2026-10-29, the suspend false-kills —
  `docs/player/reports/phase2.md` § 8), so two waits are not counted:
  - **Starved of slots.** The host tracks the worker's ring (the latest `Buffer` set — a new
    size starts a new ring: a ring is exported whole before any frame of it, a `resize` always
    changes the size) and the slots it holds (a `Frame` named it, no `Release` sent yet). While
    it holds **every** slot, the worker can't render a tick (the renderer waits in `recv` for a
    `Release`) — its outstanding ticks are re-stamped each poll (their age doesn't count) and
    its liveness is the **ping** (sent while starved even with ticks outstanding; the idle
    renderer answers it — and, robust, polls `glGetGraphicsResetStatus` on it, since a starved
    renderer renders no frame to poll after). Bounded: starved with a tick waiting for more than
    **`STARVE_LIMIT_FACTOR` (5) × `hang_timeout`** (10 s) = hung all the same (`worker.hung
    {starved_ms}`) — slots that never come back (a fence that never signals: a dead GPU
    timeline) are recovered by a restart's fresh ring. Paused (no ticks) holds slots freely.
  - **Reads and reaping follow readiness (F6b).** `poll` = `poll_io(now, true)`: one
    `epoll_wait` of the host's own set, then only the readable socket / pipe is read;
    `waitpid` on every poll once the worker is ending (EOF on either, or killed), else at most
    every `REAP_CHECK` (100 ms). `poll_io(now, false)` (the caller's epoll just said the host's
    fd isn't readable) skips the reads, keeping the heartbeat and the reaping.
  - **The host's own stall.** A gap between two `poll`s longer than **`host_stall_gap` =
    `hang_timeout / 2`** (1 s; production polls at the loop's tick rate, ≤ 17 ms apart) means the
    compositor itself didn't run (blocked in the driver while the whole GPU was busy): every
    outstanding tick/ping (and a pending `Hello`) gets a fresh `hang_timeout` from that poll,
    `worker.host_stalled {gap_ms, outstanding, hello}` (info). A worker that freezes while the
    host keeps polling is judged exactly as before. Suspend time itself never counted
    (`Instant` = `CLOCK_MONOTONIC`, stopped in S3).
  Tests (`tests/worker.rs`, stub `ring:3` / `freeze_*`): `starved_worker_is_not_hung` (4 ×
  the timeout with every slot held: no `Hung`, the waiting tick framed into the released slot at
  once — RED before: `Hung {waited_ms: 302}`), `starved_worker_that_hangs_is_still_killed`
  (`hang_after_ms 600`: `Hung` within 900–1150 ms — the usual bound), `starved_forever_is_killed_after_the_starve_limit`,
  `host_stall_is_not_a_hang` (no poll for 900 ms, the worker back 150 ms after the host — RED
  before: `Hung {waited_ms: 900}`, incident 2's signature), `worker_freeze_while_the_host_polls_is_hung`
  (< 400 ms); `tests/scene.rs::gpu_stall_that_starves_the_worker_is_not_a_hang` (the real
  renderer, synthetic `gpu_stall: [500, 1500]` at a 300 ms timeout: a 1.5 s latch gap, 0
  restarts, frames flow again from the same worker — RED before: 3 restarts).
- **`send` while not connected** (before `Hello`, `Restarting`, `Broken`, `Stopped`):
  `Start`/`Paused`/`Resize`/`Route`/`SetProperty` are **folded into the restart's `Start`**
  and accepted (`Ok`) — a restart never resumes with a stale pause/size/route/property;
  `SetProperty` is folded while connected too — everything else is
  `NotConnected` (the caller re-sends gains/pointer after the new worker's `Ready`).
  `WouldBlock` = the worker isn't reading (socket buffer full). Unit
  `restart_start_folds_live_changes`.
- **Fatal errors are not crashes.** A worker that can't play (`error {fatal: true}`: no GPU,
  load/build failed, protocol mismatch — a `Hello` with another `protocol` is turned into one
  by the host) stays up, idle, until `quit`; the caller stops it. No restart loop, no crash
  record (plan Review Focus #1).
- **`stop()` / `Drop` never block** (`stop_never_blocks`: < 5 ms): `quit` is sent, the
  process goes to `worker::reap` — one `lia-worker-reap` thread, started on demand, gone when
  nothing is dying — which reaps it and SIGKILLs it at `STOP_GRACE` (500 ms) if it's still
  there. `reap::pending()` for probes.
- **Log tail:** the last `LOG_TAIL` (50) lines of worker output + `log` messages (as
  `[level] line`), oldest first, across restarts (a `--- liascape-player: worker …; restart N ---`
  marker between processes); a line is cut at 4 KiB; ≤ 256 KiB read per `poll`. stderr and
  `log` messages interleave arbitrarily. `stop()` drains the pipe first (non-blocking), so a fatal
  error's own stderr line — written just before the `error` that made the host stop it — stays in
  the tail (Task 13: it was lost before, 3/3 runs). **`ctl probe '{"name":"workers","args":
  {"log_tail":true}}'`** shows every scene's tail (kept after a fatal stop, across restarts) — LWE's
  own output (missing assets, shader warnings, `Replaced … with compat …`) for a scene that loads
  but renders wrong, not only for one that crashed (Task 13; guard: the tail half of
  `tests/api.rs::missing_scene_folder_fails_without_crash_record`).
- **Crash record** `<crash_dir>/<scene-id>-<unix_ms>.json` (`-<n>` on a same-ms collision;
  written via a temp + rename) = `{scene_id (the item folder's name), id (source), path,
  reason, signal|code, restarts (in the window), total_restarts, uptime_ms, t_wall,
  log_tail}`; past `MAX_CRASH_RECORDS` (20) the oldest (mtime) go. `worker::write_crash_record`.
- **`kill_for_restart(why)`** (Task 10): SIGKILL the live worker as a crash — the usual
  `Exited` → restart/broken path follows, with `why` leading the restart's and the record's reason
  (`"GL context lost, killed by signal 9"`); `worker.killed {id, pid, why}`. For `ContextLost`.
- Events (comp `worker`, one corr `wk-N` per host): `worker.spawned {id, pid, bin, attempt}`,
  `.ready {pid, protocol, features, sync, ms}`, `.exited {pid, signal, code, hung,
  uptime_ms}`, `.hung {pid, waited_ms, hello}`, `.restart {attempt, prev_pid, pid, why}`,
  `.killed {pid, why}`,
  `.broken {reason, record, restarts}`, `.stopped`, `.bad_message`, `.spawn_failed`,
  `.record_failed`. `source.broken` is the source's view (§ "The `scene` Source kind" → Errors).

**`liascape-scene-worker --fd N --parent-pid P [--stub]`.** `--stub` (tests, no GPU): `hello
{features: [stub], sync: none}`, answers `ping`/`tick` (a slot-0 `frame` without fd), logs
each `start`'s position (`stub: start position <p>`), scripted by `LIASCAPE_SCENE_WORKER_TEST`
(comma-separated): `crash_after_ms:N` (`stub: crashing` to stderr, `RLIMIT_CORE` 1 —
no systemd-coredump/DrKonqi —, `abort()`), `hang_after_ms:N` (stops answering), `ring:N` (N
`buffer`s on `start` — 64×64, no fds —, each tick framed into a free slot, the newest tick held
while the host has them all: slot starvation without a GPU), `freeze_after_ms:N` + `freeze_ms:M`
(N ms after `hello` stops reading for M ms, then carries on), `exit_code:N`
(exit N at `crash_after_ms`, else right after `hello`), `ignore_quit` (ignores `quit` **and**
EOF — only SIGKILL ends it), `spam_stderr:N`. The worker sets its socket `CLOEXEC`
(nothing it starts may hold it: EOF is the crash signal).

**Build feature `lwe` — default ON** (Tasks 1–2; § "LWE core" below). `build.rs` emits
`cargo::rustc-link-arg-bin=liascape-scene-worker=` `-L$LIASCAPE_LWE_CORE_DIR/lib
-llinux-wallpaperengine-core -Wl,-rpath,<$LIASCAPE_LWE_RPATH or $LIASCAPE_LWE_CORE_DIR/lib>` (the
compositor binary never links LWE — `tests/lwe_build.rs::worker_links_the_core` checks both);
without `LIASCAPE_LWE_CORE_DIR`, or with one lacking the `.so`, the build fails naming the devShell,
`scripts/lwe.sh` and `--no-default-features`. `--no-default-features`: the worker runs `--stub`
and the synthetic renderer only (`install.sh --no-scenes`). **`paths::scene_worker_bin()`**: `$LIASCAPE_SCENE_WORKER_BIN` (used only if
it names a file) → `liascape-scene-worker` next to `/proc/self/exe` (dev `target/<profile>/`, the
flake's `$out/bin` — the wrapper's `.liascape-player-wrapped` sits there too) → `PATH`; unit
`scene_worker_resolution_order`.

**Tests (`tests/worker.rs`, no GPU, stub only):** `proto_roundtrip_with_fds`,
`proto_rejects_oversized_and_garbage`, `spawn_handshake_hello` (+ spawn cost < 50 ms),
`worker_exit_is_seen_with_its_signal`, `worker_exit_code_is_seen`,
`hang_is_detected_by_heartbeat`, `restarts_three_times_then_broken`,
`restart_resends_start_at_resume_position`, `stop_never_blocks`, `worker_dies_with_its_parent`
(the test binary re-execs itself as the parent — `helper_spawn_and_wait`, env
`LIASCAPE_WORKER_TEST_HELPER` — with an `ignore_quit` stub so only PDEATHSIG can end it; RED with
the prctl removed: the worker outlived its SIGKILLed parent by 2 s),
`log_tail_and_crash_records_are_bounded`. **Gotcha:** a sibling test's `posix_spawn` holds a
copy of every fd for the µs between its clone and exec — `CLOEXEC` fds included — so a test
that closes one end and reads EOF must `poll` for the hang-up first.
