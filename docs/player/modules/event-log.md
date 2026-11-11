<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Event log

JSON Lines, one object per event, schema:

```json
{"t_mono_ms": 123.4, "t_wall": "2026-10-20T12:00:00.000Z", "comp": "mpv", "level": "info", "kind": "source.load", "corr": "tr-12", "...fields": "merged at top level"}
```

- `t_mono_ms` — `f64` milliseconds since the logger's init (`log::mono_start()`, the first
  thing `serve` does — effectively process start), from `Instant` (a true monotonic clock,
  never wall time) — monotonic across every event in a process, even across rotation. The
  supervisor's own lines (`log::append_detached`) use the supervisor's clock. Not to be
  confused with the transition events' `at_ms`/`start_ms`, which are on the
  **pause-excised player clock** (`Runtime::now`, invariant #7).
- `t_wall` — RFC3339 wall time (`time::OffsetDateTime::now_utc()` +
  `format_description::well_known::Rfc3339`).
- `comp` — the emitting component (`&'static str`, e.g. `"mpv"`, `"graph"`).
- `level` — `Level` (`Error|Warn|Info|Debug|Trace`), serialized **lowercase**
  (`"error"`…`"trace"`). Declaration order is severity order: `Error` is most severe,
  `Trace` least — `Level` derives `Ord` from that, and both the logger's own threshold
  (set in `init`) and `LogFilter::min_level` compare against it directly (`event_level <=
  threshold` → keep).
- `kind` — a dotted event name (e.g. `"source.load"`, `"transition.start"`).
Freeform below `kind` by convention, not enforced.
- `corr` — `CorrId` (newtype `String`, serializes as a bare JSON string) or `null`. One
  correlation id ties together every event of one operation (a transition, a source load,
  a worker restart). Mint one with `log::new_corr(prefix)` → `"<prefix>-<n>"` (e.g.
  `new_corr("tr")` → `"tr-12"`); the counter is global across all prefixes, not per-prefix.
- `fields` (the `serde_json::Value` passed to `event`/`log::event`) — **must** serialize to
  a JSON object; its keys are merged at the top level alongside the fixed keys above. A
  field that collides with a fixed key (`comp`, `level`, …) silently overwrites it — pick
  field names that don't.

**Call it via the global, not `Logger` directly.** `log::init(dir, level)` sets up the
process-global logger (creates/appends `events.jsonl` in `dir`); `log::event(...)` and
`log::recent(...)` read/write it. `init` may only succeed once per process — a second call
returns `Err` (`io::ErrorKind::AlreadyExists`), never panics, so a second subsystem racing
to initialize logging can't take the process down. `event`/`recent` are no-ops (silently
drop / return `vec![]`) before `init` has run, so early callers don't need to guard every
call site. All of this is behind one `Mutex`, safe to call from any thread (the render loop
and the socket server both will).

**Rotation.** `events.jsonl` rotates when the *next* line would push it past
`DEFAULT_ROTATE_BYTES` (20 MiB = `20 * 1024 * 1024`, checked anticipatorily — the
check happens before the write, not after): `events.jsonl` → `events.1.jsonl` →
`events.2.jsonl` (oldest dropped), so at most 3 files ever exist. The threshold is
injectable (`Logger::init_with_limit`, crate-private) purely so tests can rotate in
milliseconds instead of writing a real 20 MiB — production code only ever goes through
`log::init`, which always uses `DEFAULT_ROTATE_BYTES`.

**`recent(filter, limit)`** — the in-memory side of the log: the last 10 000 events (a
ring buffer, oldest dropped first) filtered by `LogFilter { comp, corr, min_level,
kind_prefix }` (every `Some`/non-default field must match; `kind_prefix` is a
`str::starts_with` match on `kind`), returning up to `limit` matches **oldest-first**
within the most recent window — i.e. if more than `limit` events match, you get the
*newest* `limit` of them, but still in chronological order. This ring is independent of
what has or hasn't been rotated to disk — it survives rotation (rotation only touches the
files) and does not survive a process restart (nothing on disk is structured for random
access; re-reading history from `events*.jsonl` is a future task's problem, not `recent`'s).

**Disk I/O failures are never silent.** A write/flush failure (disk full, permissions) and
a rotation failure are both counted in `write_failures` (surfaced via `log::write_failures()`
/ `Logger::write_failures`) and diagnosed with one `eprintln!` — on the *first* failure of a
burst, not once per event, with a matching "recovered" line when writes start succeeding
again — so a sustained failure doesn't spam stderr. The event itself still lands in the
in-memory ring either way; `recent()` is unaffected by disk trouble. A **rotation** failure
is handled more conservatively than a plain write/flush failure: `rotate` detaches
`state.writer` (sets it to `None`) and resets `current_size` to `0` *before* attempting to
reopen the fresh `events.jsonl`, so if that reopen fails (e.g. a transient EMFILE/ENOSPC/
permission blip right after the renames already succeeded), the old handle — which by then
refers to whatever got renamed to `events.1.jsonl` — is never written through again. Disk
logging stays suspended (every event after that is diagnosed/counted, never silently
dropped, never appended into the wrong file) until the process restarts; `write_line`
checks `writer.is_none()` up front so it doesn't retry rotation or touch a stale handle on
every subsequent event.

**Tap (Task 12).** `log::set_tap(Some(Arc<dyn Tap>))` installs one process-wide consumer of
every event — the command API's `subscribe`. `Tap::wants(level, kind)` is asked first
(cheap prefix check); only then is the record built, **even below the logger's level
threshold** (a subscriber asks for kinds; the file keeps its level — e.g. `source.position`
is `debug`), and `Tap::send(&record)` gets it *after* the logger's lock is released. The
record is exactly what the log stores (`kind`, `corr`, `t_mono_ms`, …); the API renames
`kind` → `event` on the wire. `send` must only queue: it runs on whatever thread logged.
`Logger::record(…, for_tap)` is the shared builder (`Logger::event` is now test-only).

**Gotcha:** `init`/`event`/`recent`/`new_corr`/`write_failures`/`set_tap` are the only public API — `Logger` and
`Logger::init_with_limit` are `pub(crate)`, used only by `log.rs`'s own tests so each test
gets an independent instance instead of fighting over the one process-global `OnceLock`.
Don't reach for `Logger` from outside `log.rs`; if you need a log in a test elsewhere in
the crate, that's a sign `log::init` should be called once from that test binary's setup,
not that `Logger` should become more public.
