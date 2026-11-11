<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Command API

`src/api/` + `src/ctl.rs` (spec §4.2 "Command API", §8/§9; Task 12). JSON Lines over the
unix socket (§ Runtime → Paths):

- request `{"id":N,"cmd":"<verb>","args":{…}}` — `args` optional, `id` any JSON value
  (echoed back)
- reply `{"id":N,"ok":true,"result":…}` | `{"id":N,"ok":false,"error":{"code","message",
  "hint"}}` — **every error has a hint saying what to do next**; an unparseable line gets
  `"id":null`
- event (after `subscribe`) `{"event":"<kind>","corr":…,"t_mono_ms":…,"t_wall","comp",
  "level",…fields}` — the event-log record with `kind` renamed. Events a command causes are
  delivered **before** its reply on the same connection (the tap is flushed before every
  reply).

**`ctl`:** `liascape-player ctl [--timeout-ms N] <verb> ['<json args>']` prints the result as
pretty JSON, exit 0 — or the error object (stdout), exit 1 (also for no player / bad JSON
args / **no reply within `--timeout-ms`, default 10 000** → `timeout`, hint: pass a longer
`--timeout-ms`; all with a hint). `liascape-player ctl subscribe <prefix…>` prints events one
JSON object per line until Ctrl-C, without a timeout; when the player exits it prints a
note on stderr and exits 0 (or stdout closes).

| verb | args | result | errors (besides `bad_request`) | `ctl` example |
|---|---|---|---|---|
| `hello` | — | `{version, pid (the compositor — the supervisor's child when supervised), supervisor_pid (null unsupervised), restart (the `supervisor.restart` fields this child logged, or null), protocol: 1, capabilities: [video, image, color, transition, program, scene? (the worker resolves — Task 5 — and WE's assets dir does, or synthetic scenes are allowed — Task 7), headless?, stepped?, outbox (Phase 3 Task 9)], clock, backend, verbs, health {effects, vram, hwdec_interop, scenes} (each `{ok, reason, …}`, `crate::health`)}` | — | `ctl hello` |
| `create` | `{kind: source\|layer\|effect\|program, id?, props?}` (a program without `seed` gets the wall clock's nanos) | `{id}` | graph codes; `no_such_effect` (an effect's `effect_id`); `unsupported` (output/player) | `ctl create '{"kind":"source","props":{"path":"/w/a.mp4","loop":true}}'` |
| `destroy` | `{id}` | `{ramp_ms}` — an audible source is ramped out first (30), else gone now (0) | `no_such_node`; `unsupported` (an output or main layer) | `ctl destroy '{"id":"src3"}'` |
| `set` | `{path, value}` (aliases: every match) | `{targets: [ids]}` | graph codes; `no_such_effect` (`<fx>.effect_id`) | `ctl set '{"path":"srcs:*.gain.user","value":-6}'` |
| `get` | `{path}` (must resolve to one node) | `{value}` | graph codes, `ambiguous` | `ctl get '{"path":"cur:DP-1.time_pos"}'` |
| `animate` | `{path, to, duration_ms, curve?: linear\|smoothstep\|equal_power_out\|equal_power_in\|step, from?, unit?: scalar\|gain_linear}` — numbers + gain slots; starts now; `from` defaults to the current value and is range-checked like `to`; `gain_linear` only on `gain.*` | `{corr, targets}` (a broadcast alias matching nothing: `targets: []`, like `set` — M13); `anim.done {corr}` per finished animation | `bad_type` (non-numeric), `out_of_range` (`to`/`from`), `bad_request` (unit), graph codes | `ctl animate '{"path":"lay:DP-1:main.opacity","to":0,"duration_ms":500}'` |
| `transition` | `TransitionReq` (§ Transition recipe): `{outputs, to, effect_id?, params?, duration_ms?, method?, align?}` | `{corr, to: B's id}` (`parked: true` when no output exists — § Runtime, I4) | `no_such_effect` (not in the catalogue — hint: `ctl effects`), recipe codes | `ctl transition '{"outputs":"out:*","to":{"path":"/w/b.mp4"},"effect_id":"fade","duration_ms":1000}'` |
| `cancel` | `{corr}` | `{}` | `no_such_node`, `unsupported` (after handoff) | `ctl cancel '{"corr":"tr-12"}'` |
| `program.play` | `{id, from?: "start"\|"resume"\|"index", index?, keep_pause?: false}` (§ Programs "Playlist start"; no `from` = `index` with an index, else `start`) | `{corr, path, index, resumed}` — `corr` null + `resumed: true` = the same key's playlist already plays (nothing switched) | `no_such_node` (no such program), `unsupported` (empty program — hint: the `programs` probe), `out_of_range` (index), `bad_request` (`from`) | `ctl program.play '{"id":"prog:main","from":"resume"}'` |
| `program.next` / `program.prev` / `program.random` | `{id, keep_pause?: false}` | `{corr, path, index}` — `corr`/`path` null = nothing to do (previous at the session's first item, nothing playable) | `no_such_node`, `unsupported` (empty) | `ctl program.next '{"id":"prog:main"}'` |
| `automute.release` | — | `{released}` — § Signals → Auto-mute; false = not auto-muted, nothing done | — | `ctl automute.release` |
| `state` | — | `{graph (Graph::snapshot), transitions (status), programs (§ Programs, `ProgramStatus`), clock {mode, now_ms}, outputs [{name,width,height,hz,refresh_mhz}], backend (headless\|wayland), sources (hosted ids), parked, workers (the `workers` probe's entries, Task 5)}` | — | `ctl state` |
| `subscribe` | `{topics: [kind prefix…]}` (`""` = all; additive) | `{topics}` | — | `ctl subscribe transition. source.` |
| `capture` | `{target: out:<n> \| lay:<n>:main \| <source id>, path (absolute)}` | `{path, width, height}` — deferred until the file is written (the client's later requests wait, like `step`'s); the picture is the one at the request | `no_such_node`, `unsupported` (no frame yet), `io` | `ctl capture '{"target":"out:DP-1","path":"/tmp/dp1.png"}'` |
| `logs` | `{comp?, corr?, min_level?, kind_prefix?, limit? (200, ≤ 10000)}` | `{events: [records, oldest first]}` | — | `ctl logs '{"corr":"tr-12"}'` |
| `probe` | `{name, args?}` | the probe's result | `no_such_probe` | `ctl probe '{"name":"sources"}'` |
| `effects` | — | `{ids}` (catalogue order; `[]` without `transitions/`) | — | `ctl effects` |
| `stop` | — | `{stopping: [ids]}` | — | `ctl stop` |
| `quit` | — | `{}` (then the process exits 0) | — | `ctl quit` |
| `step` | `{ms}` (0–600000) | `{now_ms}` (deferred until every frame is in; the client's later requests wait for it) | `unsupported` (real clock), `timeout`, `busy` (64 queued) | `ctl step '{"ms":16}'` |
| `outbox.read` | `{after?: u64, limit?: 500 (1–2000)}` (Phase 3 Task 9, § Outbox) | `{events: [{seq, t_wall, kind, fields}] (unacked, seq > after, oldest first), last_seq (the newest ever appended, 0 = none), dropped_before: u64\|null (entries past `after` were dropped by the bound: everything before this seq)}` | `bad_request` (`after`/`limit` not a non-negative integer, `limit` 0) | `ctl outbox.read '{"after":12,"limit":100}'` |
| `outbox.ack` | `{seq}` — the backend stored every entry ≤ seq (a seq past the newest acks all) | `{}` (reads skip them at once; the file is compacted on `lia-snapshot`) | `bad_request` (no/bad `seq`) | `ctl outbox.ack '{"seq":14}'` |
| `headless.add_output` | `{name, width, height, hz? (60), x?, y?}` — `x, y`: its desktop position for the desktop pointer (default: right of the outputs before it, y 0; `--outputs` lays them out left to right) | `{id: out:<name>}` | `out_of_range`, `unsupported` (exists / not headless) | `ctl headless.add_output '{"name":"VIRTUAL-3","width":1920,"height":1080,"hz":60}'` |
| `headless.remove_output` | `{name}` | `{}` | `no_such_node`, `unsupported` | `ctl headless.remove_output '{"name":"VIRTUAL-2"}'` |
| `headless.pointer` | `{output, x, y, buttons? (0), entered? (false)}` — surface px from the top-left (Task 7); `entered` = the pointer came onto the output there (Wayland `enter`): the scene gets it as a jump, no stroke from where it left | `{scenes: [ids the pointer reached]}` | `no_such_node`, `out_of_range`, `unsupported` | `ctl headless.pointer '{"output":"VIRTUAL-1","x":960,"y":540}'` |
| `headless.cover` | `{output \| "*", state: none\|maximized\|fullscreen, app_id?, pid?}` — the fake cover source (Phase 3 Task 6, § Signals); read by the next tick | `{}` | `no_such_node`, `bad_request`, `unsupported` | `ctl headless.cover '{"output":"*","state":"fullscreen"}'` |

**Error codes** beyond the graph's (§ Graph & properties): `bad_request` (not JSON / no
`cmd` / bad args), `no_such_verb` (hint lists every verb), `no_such_effect`,
`no_such_probe`, `timeout` (a step's frames; `ctl`'s reply wait), `busy` (step queue
full), `io` (capture write, ctl connect).

**Event kinds** (subscribe by prefix): `transition.scheduled|started|handoff|done|
cancelled|failed|graph_error` (the recipe's outbox, R37), `source.ready|ended|position`
(runtime, `position` is debug-level ~10 Hz, every change in stepped mode),
`source.retire|parked|unparked` (runtime), `source.error|rejected|open|teardown|drop`
(host), `source.broken` (a scene past its restart budget, § Scene worker; it, `scene.loudness` and
`scene.vram_exceeded` carry `outbox_seq` — § Outbox), `outbox.dropped|write_failed|write_recovered|compacted (debug)`
(§ Outbox), `scene.context_lost|resuming|
resumed|preview|preview_failed|restored_broken` (Task 10, § Scene worker → "Crash policy"),
`worker.killed`, `gfx.context_robust`, `transition.output_adopted`, `output.added|removed|changed|layer_failed|
present_failed`, `wl.connected|surface_ready|surface_closed|surface_recreated|layer|
gl_error|duplicate_output|pointer_error|driver_env|default_queue_failed` (the last two Task
20e), `input.pointer` (debug), `loop.failed`,
`anim.start|done|dropped`,
`api.client_connected|closed|dropped|tap_overflow`, `player.started|stopped|quitting|exit`,
`step.timeout`, `source.frame_refetched`, `render_worker.started|unavailable|stopped|died|
attach_failed|lane_failed|hwdec_interop|cuda_init|attach|free|first_render` (§ Sources "Render
worker", "Hardware decoding"), `loop.long_busy {ms, wall_ms, site, open_ms, cmds?}` (+ the
accounting fields of `probe loop`'s `max_busy_at` when on; debug: a synchronous loop stretch ≥ 50 ms,
to line a hitch up with what else happened), `mpv.reaped`, `mpv.trimmed` (debug, Task 20b), `mpv.reaper_stragglers`,
`mpv.options_skipped` (a script trim this libmpv doesn't know, once per process), `effects.missing`,
`supervisor.restart` (the restarted child, first thing) | `child_exited|giving_up|
stop_timeout|spawn_failed` (the supervisor, appended to the shared log),
`snapshot.restored|none|invalid|dropped|source_failed|prop_rejected|saved (debug)|
write_failed|write_recovered`, `test.crash`,
`audio.bus.up|down|not_ready|retargeting|retarget_failed|moved|latency_shots|latency_unmeasured|thread_panicked`,
`audio.meter.started`, `audio.meter.scratch_exceeded` (T14 residual — a negotiated quantum
exceeded the meter's RT scratch cap, chunked rather than reallocated), `probe.dropout`
(Task 15 — `{corr, report}` or `{corr, skipped}`; review fix round: `report.fit` is
`"ok"`/`"insufficient"`, `skipped` can be `"busy"` when 2 analyses are already running —
R77/R79, `docs/player/debugging.md`), `probe.dropout_decode_failed`,
`probe.dropout_analysis_stragglers` (R79 fix round — `Runtime::shutdown`'s bounded join
of in-flight dropout analyses, mirroring `mpv.reaper_stragglers`),
`compose.failed`, and (final review) `onset.held|started` (debug), `runtime.onset_timeout`,
`transition.align_fallback`, `effects.compile_failed`, `audio.bus.reconnecting|reconnect_failed|
sources_rerouted`, `supervisor.stopped`, `probe.dropout {skipped: "window_too_long"}` — i.e.
every event-log kind
(log warnings included). Every event has `corr` (or null) and `t_mono_ms`.

**Global settings go to `srcs:*` (R50).** The backend (Task 17) sends every global setting
— `gain.user`, `no_audio`, `speed`, `hwdec`, `fps_cap`, `cache`, `demuxer_*`, `af`,
`audio_delay` — as `set srcs:*.<prop>` (or `srcs:<connector>` per output), never `cur:*`:
`cur:` misses the pending B of an in-flight transition, which would then take over with
the old value (project rule "settings apply live"). Per-item overrides target the item's
own source id. Layer settings (`fit`, `viewport`) go to `lay:*:main`. A `set` on a
broadcast alias (`srcs:*`, `cur:*`, `out:*`, `lay:*:main`, and `srcs:<c>`/`cur:<c>` of an
output that exists) that matches nothing right now is still type-checked against that
kind's schema and succeeds with `targets: []` (a broadcast to nobody isn't an error); an
unknown connector or a concrete id that doesn't exist is `no_such_node`. With no output
left, `srcs:*` is exactly the parked wallpaper (§ Runtime → Outputs).

**Probes (`src/probe/`).** `dropout` analyses are bounded (final review M8): each ffmpeg
decode is killed after 20 s (`DECODE_TIMEOUT`), and a window longer than 120 s
(`MAX_ANALYSIS_WINDOW`, e.g. a pause gate spanning a long pause) is skipped
(`probe.dropout {skipped: "window_too_long"}`) instead of decoded into memory; if the 1 ms-refined
lag can't be fitted the whole coarse alignment stands (lag, capture, fit, offset together).
**The detector must not touch what it measures (TODO F4):** each ffmpeg decode is
`posix_spawn`ed (std `Command` with **no `pre_exec`** — a `pre_exec` hook makes std `fork()` the
whole compositor) as `setpriv --pdeathsig KILL -- ffmpeg …` (util-linux; bare `ffmpeg` without
it: SIGPIPE on the closed stdout + the 20 s timeout bound an orphan). The fork cost 1.9–10.5 ms
per decode and the in-process bus (loopback + mpv's AO) missed whole graph cycles meanwhile:
`--debug` recordings held exact-silence runs of 64–576 frames right after every analysis (161 in
460 s on the Phase 3 battery). Guard `tests/api.rs::dropout_analysis_never_skips_bus_cycles`
(12 re-runs of one switch's analysis, the private sink recorded: no exact-silence run; RED 28–44).
`list`; `sources` — per hosted source `{id, kind, path, ready,
paused, loop, speed, time_pos, duration, gain_effective_db (graph), gains (the live
source's own slots), live_kind, size, mpv_volume_gain, mpv_pause, requests_in_flight,
stepped, step_status, virtual_t, last_event}` + `dying` (sources mid-teardown),
`reaper_pending` (`mpv_*` are synchronous mpv reads — probe
only); `loop` — `{clock, tick_period_ms, ticks, tick_hz_last_s, last_tick_ms,
recent_ticks_ms, max_tick_ms_recent, last_phases {sync_ms, transitions_ms, render_ms,
total_ms}, max_busy_ms (longest synchronous stretch since the last
`args: {"reset": true}` — a tick, a step, the post-dispatch sync, or one client's requests; before
the speed storm request handlers were left out), max_busy_at (that stretch: `{site:
tick|client|dispatch, wall_ms, open_ms, cmds?: [[verb, ms]…], phases?}`), accounting +
max_busy_own_ms + max_busy_own_at + max_busy_self_ms + max_busy_self_at + max_busy_cpu_ms (TODO F5 —
**scheduler accounting**, off until
`args: {"account": true}` turns it on for the process (`false` off): each stretch also reads the loop
thread's CPU clock (`CLOCK_THREAD_CPUTIME_ID`), its run delay (`/proc/thread-self/schedstat`, opened
once, `pread`) and its voluntary/involuntary switches (`getrusage(RUSAGE_THREAD)`) — four syscalls
per stretch, hence opt-in (F6b counts the loop's syscalls per frame). `own_ms` = wall − `waited_ms`
(runnable without a core) = work + blocking calls, what an idle machine would see; `cpu_ms`,
`preempted`, `blocked` in the `_at` objects. `driver_blocked_ms` (TODO F5 (2)) = the
time asleep inside `runtime::driver_call`s — only dmabuf imports, whose sleeps are NVIDIA's
global resource-manager lock held by another process — and `self_ms` = `own_ms` minus it;
`max_busy_self_ms`/`_at` track the longest by that. A stretch begun before accounting was on isn't
counted. `runtime::Stretch` / `Spent`), max_request_ms + max_request_cmd (the slowest single
request handler and its verb, same reset), max_busy_excl_open_ms + max_open_ms (the same with the
loop's share of source opens taken out / that share alone — render context + props +
`loadfile`; the core itself is made on the `lia-open` worker, § Sources), iterations, wakes, wake_pending, wake_fds, clients,
subscribed_topics, tap_dropped, reaper_pending, uptime_ms, gain_timer_armed, gain_ticks,
gain_pushes, pause_gates, dropout_windows_open, bounds (§ Runtime "Bounds"),
recent_gain_pushes}`; `sources` also has `mpv_current_ao` and top-level `opening` + `open_pool`
`{cap, workers, running, queued, peak, skipped, pending}` (the `lia-open` pool, § Sources "Async
opens"); `frames` (Task 13,
`probe/frames.rs`) — `{backend, policy (content|every_tick), window_ms (2000),
explicit_sync ({env, value, source: policy|env}, null headless — Task 20e),
default_queue_dispatched (events from libwayland's default queue; null headless), outputs:
[{name, hz, refresh_mhz, period_ms, idle, frame_pending, since_present_ms, paced {count,
mean_ms, p50_ms, p95_ms, max_ms, missed}, all {… + fps}, totals {presents, callbacks,
missed, idle_gaps}}]}`, `args: {"reset": true}` clears the windows after reading (§
Wayland → Frame pacing; Task 16 adds `totals.present_failed`, `last_present_error`,
`retry_in_ms`); `bus` and `meter.window` (§ Audio bus); `dropout` (Task 15,
`probe/dropout.rs`) — `{corr, dump?}` → `{status: "pending", corr}`, the reference-based
dropout detector's result following as a `probe.dropout {corr, report}` event (never
deferred like `step`'s reply; `docs/player/debugging.md`). Task 16d: the analysis runs
only once the meter has captured the whole window (`done + WINDOW_POST +
CAPTURE_MARGIN`, queued in `Runtime::dropout_due` and started from `tick` — the debug
auto-trigger used to snapshot at `transition.done` and never saw the post-roll); the
meter is binned on `expected`'s own grid (never the absolute 10 ms one — the window's
sub-10 ms phase skewed every lag), coarse bins are power means of the 1 ms envelope, and
the lag is refined to 1 ms (R96, ±10 ms) before drops/micro-gaps; `dump` (absolute path)
writes every analysis input + the report as JSON for offline replay; `memory` (Task 20b,
`probe/memory.rs`) — `{proc {rss_kib, hwm_kib, rss_anon_kib, rss_file_kib, threads},
malloc {arena_bytes, mmap_bytes, mmap_chunks, in_use_bytes, free_bytes,
top_releasable_bytes, arenas}, policy {applied, mmap_threshold, trim_after_reap, trims,
trim_ms_total, trim_ms_max, allocator (glibc|other), mmap_threshold_source (policy|env|null),
env_unknown_value}, transitions_done_total (monotonic switch counter), live_sources,
dying_sources, opening, reaper_pending (0 only after the batch's trim)}`,
`args: {"trim": true}` adds `trim {released, ms, proc_after, malloc_after}` — that trim runs on
the LOOP thread (debug probe; with hundreds of MiB retained it can drop a frame) (§ Memory);
`sources` also has `mpv_hwdec_current` (what `hwdec: auto` resolved to), `mpv_hwdec` (what we
asked for — copy modes, Task 20d, unless the render context loaded the worker's GL interop) and
`hwdec_interop` (that interop, or null), plus top-level `render_worker` (null with the worker
off: summed lane counters, `hwdec_interop`, `lanes` — § Sources "Render worker"); `snapshot` (Task 16,
`probe/snapshot.rs`) — `{path, writes, failures, last_write_ms, since_last_write_ms,
due_in_ms, frozen, current (what would be saved now)}`. `sources` also has
`mpv_audio_device` / `mpv_audio_delay` (what mpv really runs); `workers` (Phase 2 Task 5,
`probe/workers.rs`) — one entry per scene source's worker (§ Scene worker; `args: {"log_tail":
true}` adds each one's `log_tail`, Task 13); `vram` (Phase 2
Task 8, `probe/vram.rs`) — the VRAM sampler, the low-VRAM rule and its hold, each scene worker
against the per-scene limit (§ Scene worker → "GPU budget and VRAM (Task 8)"); `cover` (Phase 3
Task 6) — the covered Signal (§ Signals). A new probe = a file here + one `PROBES` entry.

**Isolation (`api/server.rs`).** Non-blocking, edge-triggered client sockets; per wake a
client gets ≤ 256 KiB read and ≤ 32 requests handled (the rest next iteration, round
robin); a line over 1 MiB → `bad_request` + close; garbage JSON → `bad_request` (kept); a
peer EOF still gets every queued reply before the close; > 16 MiB of unsent output (a
dead/slow subscriber, or a client not reading replies) → dropped with
`api.client_dropped {client, reason}`. The tap buffers ≤ 50 000 events between iterations
(oldest dropped, `tap_dropped`). `bad_client_isolated` pins all of this (the good client's
worst reply stays < 500 ms during a 40 000-request flood).

**Debugging with `ctl` (AI recipe).**
1. `ctl state` — what is on each output (`lay:<c>:main.content`, `cur:`), every source's
   `ready/paused/time_pos/gain_effective_db`, live `transitions` (phase, held).
2. `ctl logs '{"corr":"tr-12"}'` — one operation's whole story (a transition's
   scheduled→started→handoff→done, or where it stopped: `cancelled`/`failed {reason}`);
   `ctl logs '{"min_level":"warn"}'` for everything that went wrong.
3. `ctl probe '{"name":"sources"}'` — what each live source actually runs (mpv's real
   `volume-gain`, `pause`, unanswered requests, step status); `ctl probe '{"name":"loop"}'`
   — is the loop ticking at the refresh, how long ticks take, did anything stall it.
4. `ctl capture '{"target":"out:DP-1","path":"/tmp/x.png"}'` — look at the picture.
5. Reproduce deterministically: `serve --headless --clock stepped --ao null`, replay the
   commands, `step`, `capture`.
6. What an mpv core itself did (a VO that gave up waiting for a render, a decoder that never opened):
   `LIASCAPE_PLAYER_MPV_LOG=v` in `serve`'s environment prints every core's mpv log to stderr
   (`liascape-player-serve.log` under the backend) as `[mpv <file> <t_mono s>] <level> <prefix>: <text>` — the
   time is when the loop PUMPED the line, not when mpv logged it: a burst of lines at one instant means
   nothing pumped that source meanwhile. Without it only `error` lines are requested.
7. Audio specifically (a dropout, a glitchy fade): `docs/player/debugging.md` — symptom →
   probe/log query → likely cause, seeded with the bugs the reference monitor
   (`probe dropout`, Task 15) found in the legacy engine, plus `meter.window`/`bus`.
