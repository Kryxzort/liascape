# Runtime: the serve process and its loop

Covers `src/player/src/runtime.rs`, `headless.rs`, `paths.rs`, `mem.rs` and `serve` in `main.rs`. Rules:
`.claude/rules/player/runtime-api.md` (loop, outputs, stepped clock) and `.claude/rules/player/core.md`
(memory, graph pause). Invariants are numbered in `docs/player/invariants.md`.

## `serve` and its exit codes

`liascape-player serve [--headless [--outputs 1920x1080@60,…] [--redraw-policy content|every_tick]] [--clock
real|stepped] [--ao <ao>] [--socket <path>] [--log-level <l>] [--render-worker on|off] [--restore
[--session-start]] [--no-supervise] [--debug]`. Without `--headless` it draws on the Wayland outputs and refuses
`--outputs`. Unless `--no-supervise` the process you start is the supervisor and the compositor is its child
([persistence.md](persistence.md) § Supervisor).

| code | meaning | supervised |
|---|---|---|
| 0 | clean: `quit`, SIGTERM, SIGINT | ends supervision |
| 1 | refused at startup (`ServeError::Startup`: lock held, unusable socket/state dir) | never retried |
| 2 | usage | ends supervision |
| 3 | `EXIT_RUNTIME`: the compositor connection was lost mid-run (`loop.failed`) | restarted |
| 4 | `EXIT_GAVE_UP`: the supervisor gave up (crash budget or compositor wait) | — |
| 5 | `EXIT_NO_COMPOSITOR`: compositor/EGL not available yet | retried with backoff |

With the default AO (`pipewire`) the bus thread starts right after the socket bind and the compositor
connection, so a second instance or a start before the compositor never loads a sink. `serve` waits at most
`BUS_STARTUP_WAIT` (500 ms) for the first bus session — inside the backend's 1 s spawn probe — then runs the loop
regardless; sources opened meanwhile play on mpv's default device and move onto the bus when it comes up
([audio-bus.md](audio-bus.md)). `--ao null` (every test) means no bus at all.

## Paths and the single instance

Socket: `$LIASCAPE_PLAYER_SOCKET`, else `$XDG_RUNTIME_DIR/liascape/liascape-player.sock` (else
`/run/user/<uid>/…`), mode 0600. State and event log: `$XDG_STATE_HOME/liascape/liascape-player/`. The instance
lock is `<socket>.lock`, `flock`ed for the process lifetime and holding the owner's pid; a lock taken on a file
its previous owner unlinked meanwhile is detected (inode vs path) and retried. Holding the lock, the winner knows
any socket file is a dead owner's. Socket and lock are removed on every exit path after binding (`SocketFile`,
`remove_now` before `_exit`).

## The loop

One calloop `EventLoop<Runtime>`: the listener and one edge-triggered source per client, one level-triggered
source per wake fd (a `dup`), a `Ping` for log events from other threads, a `signalfd` (SIGINT/SIGTERM blocked
before any thread exists → a clean `quit`), on the real clock a `Timer` at the fastest output's refresh
(`tick_period`, recomputed on hotplug, skipping ahead after an overrun), and on Wayland the connection.

Tick order: `Animator::tick` → `Graph::set` (a set on a gone node cancels its animation, `anim.dropped`) → due
destroys → `sync_sources` → `update_sources` → `Transitions::tick` with every source event since the last tick →
programs → `refresh_srcs` → compose and present the outputs that are due. After every dispatch: graph changes
sync to sources when `Runtime::sync_due` (a pending change, a `picture_rev`/`demand_rev` move, an open in flight,
a pause gate, a retire or park settling, the stepped clock) and only the woken sources update
(`SourceHost::update_only`). Each worker frame is a wake, so anything a wake does is paid per worker per frame.

### The fast gain timer

Evaluated only on the main tick, a 30 ms anti-click ramp gets one or two values at 60 Hz: mpv holds each, then
snaps to the end (measured 5–7 ms micro-gaps at 60 Hz, 2 ms at 240 Hz). A second timer at `GAIN_TICK_PERIOD`
(1 ms) evaluates only `gain.*` animations (`Animator::tick_gains`) and pushes straight to the source
(`SourceHost::push_gain`). It is armed from `sync_sources` while `gain_work_pending` (a started or imminent gain
ramp not frozen by the pause, a teardown ramp, a pause gate mid-ramp) and drops itself the moment none remain.
The `loop` probe shows `gain_timer_armed`, `gain_ticks`, `gain_pushes` and `recent_gain_pushes` (the last
`GAIN_PUSH_HISTORY` pushes) — logging a 1 kHz push would build a JSON object even below the log threshold.

### Three clocks for gains

- The player clock (`Runtime::now`) excises player-paused time: the recipe's slots (`xfade`, `anticlick`) and
  every non-gain animation run on it, so a pause freezes a transition exactly.
- `teardown_anim` (retire and park ramps, `pending_destroy` deadlines) and `setting_anim` (user setting slots,
  `GainSlot::is_setting`) run on the unpaused base clock: a destroy, `stop`, output removal or a 30 ms
  `animate srcs:*.gain.mute` completes while paused instead of racing the resume's ramp-in.
- The pause gate (`PauseGate`, slot `gain.pause`) ramps on wall time: at the pause a playing source ramps out then
  pauses; resume = un-pause, wait for `AudioFlowing` (≤ `ONSET_TIMEOUT`), ramp in. A re-pause turns a resuming gate
  back from where it is. Node-paused, audio-less, retiring and parked sources are skipped.

### Retire and park

`Runtime::retire` (the `destroy` verb, `stop`, output removal) ramps an audible source's `gain.anticlick` to −96
over 30 ms and destroys the node one tick after the ramp ends: that tick's sync carries the final −96 dB, while a
same-tick destroy dropped the source at about −6 dB. A silent source goes at once. Parking pauses one tick after
its ramp for the same reason. `source.teardown {gain_db}` records the level a source went at.

## Stepped clock

No timer. `step {ms}` advances a `SteppedClock`, runs animator, destroys, sync and update, then gives every mpv
source a virtual media time: created at its first step at its graph `position`, advanced by `ms × speed` while
the graph says `paused: false`, reset by `position`/`path` changes, wrapped by `loop` or clamped at `duration`
(the first step at the end queues `Ended`, since a paused exact seek never reports EOF). Videos are seeked
(`step_seek`, skipped when the target is unchanged); images and not-yet-ready sources are waited for `Ready`. The
step waits without blocking the loop (`PendingStep`, re-checked after every dispatch) until every wait is done,
bounded by `STEP_TIMEOUT` (2 s) with a `timeout` naming each pending source. A source the step had to open gets a
fresh timeout for its seek. Audio is silent (mpv stays paused).

## Outputs, hotplug and parking

`OutputBackend` is implemented by `Headless` (`VIRTUAL-n` textures, `present` a no-op, composes every tick unless
`--redraw-policy content`) and `wl::Wayland`. Hotplug from either runs `apply_output_changes`:

- **Added:** re-apply the connector's remembered `out:` props (`Runtime::out_props`), then show the wallpaper
  parked for that connector by a restore, else join the live transition covering another output
  (`Transitions::adopt_output` — it then shows A, the effect or B as that transition does and is carried through
  its commit/cancel), else show `cur:` of the first output, else unpark the parked wallpaper.
- **Removed:** every transition drops the output (`drop_output`; one left with no output commits at once via
  `commit_unseen`), then whatever only that output showed or held is retired so no invisible audible source
  survives. With no output left the last current wallpaper is parked: ramped to −96, paused, still in `srcs:*`
  (`Graph::set_parked`) so global settings reach it.
- **No output, `transition` arrives:** `Runtime::transition_parked` creates B paused and silent and replaces the
  parked wallpaper (reply `parked: true`), so a rotation keeps its place invisibly. An `align: end` request
  waits for an output unless the parked A `never_ends` (scene or still).

## stop and quit

`stop`: cancel every transition (`reason: "stopped"`), reset the animators, forget the parked wallpaper, empty
every layer, destroy effects, retire every source (stepped: −96 and destroyed at once), then clear
`player.paused`. `quit` (and SIGINT/SIGTERM): queue the final snapshot, `stop`, wait for the destroys (≤ 120 ms),
`SourceHost::finish_teardown(500 ms)`, `render_worker::shutdown`, `reaper::shutdown(2 s)`. A core still being
destroyed after that (`mpv.reaper_stragglers`) makes the process `_exit(0)` after removing socket and lock, so
libmpv/ffmpeg/EGL destructors never run under it.

## Bounds and costs

`probe loop` → `bounds` lists every per-source collection. `GainHistory` (the dropout probe's 1 kHz gain record)
is run-length encoded, keeps a dead source's track `DEAD_LINGER` (30 s) for its post-roll analysis and is capped
at `MAX_TRACKS` (64) / `MAX_TOTAL_SAMPLES` (131 072). 200 switches with destroys end at 64 tracks, ~4 200 samples
and every other collection ≤ 4.

Loop busy per switch with the render worker on (release, warm): median 0.3–0.4 ms, under 7 ms worst; the core is
made on an `lia-open` thread and the render context lives on an `lia-render` lane ([sources.md](sources.md)).
Synchronous loop stretches ≥ 50 ms log `loop.long_busy` (debug). With `probe loop {"account": true}` each stretch
also reads the loop thread's CPU clock, run delay and context switches: `own_ms` = wall minus time runnable
without a core, `self_ms` = `own_ms` minus `driver_blocked_ms` (sleeps inside `runtime::driver_call`, i.e. dmabuf
imports waiting on NVIDIA's global resource-manager lock held by another process).

## Memory (`mem.rs`)

glibc raises its mmap threshold to the size of any freed mmapped chunk (≤ 32 MiB). After the first mpv core is
destroyed, 1080p frame pools then come from per-thread arenas (~57 of them), which keep what they free:
200 switches grew RSS 159 → 922 MiB while live bytes stayed ~300 MiB. `mem::apply_policy` fixes the threshold at
128 KiB; `malloc_trim(0)` after each reaper batch returns the small fragments (≤ 2.4 ms per switch, off the loop).
With both, 300 switches go 364 → 380 MiB; idle CPU is unchanged and a 1 s switch loop costs ~4 % more process
CPU (fresh pages per core plus the trim). `M_ARENA_MAX` 4 on top changed nothing measurable (373 vs 380 MiB).
`LIASCAPE_PLAYER_MALLOC=glibc` skips the policy for an A/B. In the `memory` probe, live bytes
(`in_use_bytes + mmap_bytes`) flat with `free_bytes` growing is retention; live growing is a leak — check
`loop` → `bounds`, `reaper_pending`, dying and opening sources; growth per present on Wayland only is an
undispatched event queue ([wayland.md](wayland.md) § NVIDIA). `{"trim": true}` trims on the loop thread.
