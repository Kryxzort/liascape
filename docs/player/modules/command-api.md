# Command API, `ctl` and the event log

Covers `src/player/src/api/` (`proto.rs`, `server.rs`, `handlers.rs`), `src/player/src/ctl.rs`,
`src/player/src/probe/` and `src/player/src/log.rs`. Rules: `.claude/rules/player/runtime-api.md` § Command API
and `.claude/rules/player/core.md` § Event log. The verbs, their args and errors are in `handlers.rs`; probes are
listed by `ctl probe '{"name":"list"}'`.

## Wire format

JSON Lines over the unix socket ([runtime.md](runtime.md) § Paths):

- request `{"id":N,"cmd":"<verb>","args":{…}}` (`args` optional, `id` any JSON value, echoed);
- reply `{"id":N,"ok":true,"result":…}` or `{"id":N,"ok":false,"error":{"code","message","hint"}}` — an
  unparseable line gets `"id":null`;
- event (after `subscribe` with kind prefixes, `""` = all) `{"event":"<kind>","corr","t_mono_ms","t_wall","comp",
  "level",…fields}` — the event-log record with `kind` renamed. Events a command causes arrive before its reply.

`liascape-player ctl [--timeout-ms N] <verb> ['<json>']` prints the result as pretty JSON (exit 0) or the error
object (exit 1, also for no player, bad JSON args or no reply within the timeout, default 10 s).
`ctl subscribe <prefix…>` streams events until Ctrl-C or the player exits.

## Contracts worth knowing before reading `handlers.rs`

- `hello` = `{version, pid (the compositor child), supervisor_pid, restart, protocol, capabilities, clock,
  backend, verbs, health}`. `capabilities` gate optional features (`scene` only when the worker and WE's assets
  dir resolve, `outbox`, `program`, …). `health` entries are `{ok, reason, …}` with `ok: null` = not known yet;
  `crate::health` documents each, and `liascape-player health` prints them without a running player.
- `create {kind: source|layer|effect|program}`; `destroy` returns `{ramp_ms}` (30 for an audible source ramped
  out first, else 0); outputs, main layers and `player` can't be created or destroyed.
- `set`/`get`/`animate` take a `PropPath` with aliases ([graph-properties.md](graph-properties.md)); `animate`
  works on numbers and gain slots, `unit: gain_linear` only on `gain.*`, and logs `anim.done {corr}`.
- `transition` takes a `TransitionReq` ([transitions.md](transitions.md)) and replies `{corr, to}` (`parked:
  true` with no output). `cancel {corr}` after handoff is `unsupported`.
- `step {ms}` and `capture {target, path}` reply late: nothing more is read from that client until they do
  (per-client FIFO), so a pipelined `step` + `capture` captures the post-step frame. Steps from different clients
  queue up to `STEP_QUEUE_MAX`, then `busy`.
- `outbox.read`/`outbox.ack` and the `program.*` verbs: [persistence.md](persistence.md), [programs.md](programs.md).
- `headless.*` verbs fake outputs, the pointer and the cover source for tests.

## Isolation (`api/server.rs`)

Non-blocking, edge-triggered client sockets. Per wake a client gets ≤ `READ_BUDGET` (256 KiB) read and ≤
`LINES_PER_WAKE` (32) requests handled, the rest next iteration round robin; a line over `MAX_LINE` → `bad_request`
and close; garbage JSON → `bad_request`, connection kept; a peer EOF still gets every queued reply. More than
`MAX_BACKLOG` (16 MiB) unsent (a dead subscriber, a client not reading replies) drops the client
(`api.client_dropped`). The tap buffers ≤ 50 000 events between iterations, oldest dropped (`tap_dropped`). Under a
40 000-request flood the well-behaved client's worst reply stays under 500 ms.

## Event log (`log.rs`)

`<state>/events.jsonl`, one record per line: `{t_mono_ms, t_wall, comp, level, kind, corr, …fields}` with the
fields merged at top level. `t_mono_ms` counts from `log::mono_start()` (process start, never wall time). The file
rotates before a line would pass 20 MiB (`events.1.jsonl`, `events.2.jsonl`; at most three files). `recent()`
serves the last 10 000 events from memory (the `logs` verb), independent of rotation and lost on restart; a filter
(`comp`, `corr`, `min_level`, `kind_prefix`) returns the newest `limit` matches in chronological order. A disk
failure is counted and printed once per streak; the event still lands in the ring.

The tap (`log::set_tap`, the `subscribe` side) is asked `wants(level, kind)` first and gets records even below the
file's level threshold: a subscriber asks by kind (e.g. `source.position` is debug).

## Global settings and the backend

The backend sends every global setting (`gain.user`, `no_audio`, `speed`, `hwdec`, `fps_cap`, `cache`,
`demuxer_*`, `af`, `audio_delay`, scene settings) as `set srcs:*.<prop>` (or `srcs:<connector>`), per-item
overrides to the item's own source id, layer settings (`fit`, `viewport`) to `lay:*:main`.

## Probes worth knowing

- `sources` — what each live source really runs (`mpv_volume_gain`, `mpv_pause`, `requests_in_flight`,
  `mpv_hwdec`/`mpv_hwdec_current`, `mpv_audio_device`, step status, `effective_paused`), plus `dying`,
  `reaper_pending`, `opening`, `open_pool`, `render_worker`. Its `mpv_*` fields are synchronous mpv reads, which is
  why they live only here.
- `loop` — tick timing, `max_busy_ms`/`max_busy_at` (the longest synchronous stretch and what it was since
  `{"reset": true}`), the opt-in scheduler accounting ([runtime.md](runtime.md) § Bounds and costs), the gain timer,
  `bounds`.
- `frames` ([wayland.md](wayland.md)), `bus` and `meter.window` ([audio-bus.md](audio-bus.md)), `memory`
  ([runtime.md](runtime.md) § Memory), `snapshot`, `workers`/`vram` (scenes), `cover`, `automute`, `programs`.
- `dropout {corr, dump?}` — the reference-based dropout detector; the report follows as a `probe.dropout` event
  ([debugging.md](../debugging.md)). It analyses only once the meter has captured the whole window plus margin;
  each ffmpeg decode is killed after `DECODE_TIMEOUT` (20 s) and a window over `MAX_ANALYSIS_WINDOW` (120 s) is
  skipped. Decodes are spawned without `pre_exec` through `setpriv --pdeathsig KILL -- ffmpeg`: forking the
  compositor cost 2–10 ms per decode and the in-process bus missed whole graph cycles meanwhile, so the detector
  was recording the dropouts it caused.

## Debugging order

`ctl state` → `ctl logs '{"corr":"tr-12"}'` (one operation's whole story) or `'{"min_level":"warn"}'` → `ctl
probe` (`sources`, `loop`) → `ctl capture` → replay on `serve --headless --clock stepped --ao null`.
`LIASCAPE_PLAYER_MPV_LOG=v` prints every core's mpv log as `[mpv <file> <t_mono s>] …`, stamped when the loop
pumped the line — a burst at one instant means nothing pumped that source meanwhile. Audio symptoms:
`docs/player/debugging.md`.
