//! AI-optimised structured event log (spec §9).
//!
//! JSON Lines, one object per event: `{"t_mono_ms":f64,"t_wall":"RFC3339","comp":str,
//! "level":str,"kind":str,"corr":str|null, …fields}` — `fields` keys are merged at the
//! top level. `t_mono_ms` is milliseconds since process start from a monotonic clock
//! (`Instant`); `t_wall` is RFC3339 wall time. Rotated at `DEFAULT_ROTATE_BYTES`
//! (events.jsonl → events.1.jsonl → events.2.jsonl, oldest dropped).
//!
//! The public surface (`init`/`event`/`recent`/`new_corr`) talks to one process-global
//! `Logger` behind a `OnceLock`, safe to call from any thread. `Logger::init_with_limit`
//! is the same machinery with an injectable rotation threshold, kept crate-private for
//! tests so they don't fight over the single global instance.
//!
//! Disk I/O failures (write/flush, or rotation) are never silent: each is counted
//! (`write_failures()`) and diagnosed with one `eprintln!` per failure *burst* (not per
//! event), while the event itself still lands in the in-memory ring. A rotation failure
//! specifically detaches the writer first — disk logging is suspended rather than risk
//! appending further events into a file that was just renamed out from under the old
//! handle. See `rotate`'s doc comment for why.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Default rotation threshold: 20 MiB. Exceeding this on `events.jsonl` shifts
/// `events.jsonl` → `events.1.jsonl` → `events.2.jsonl` (oldest dropped), so at most
/// three files exist.
pub const DEFAULT_ROTATE_BYTES: u64 = 20 * 1024 * 1024;

const RING_CAPACITY: usize = 10_000;
const EVENTS_FILE: &str = "events.jsonl";
const ROTATED_1: &str = "events.1.jsonl";
const ROTATED_2: &str = "events.2.jsonl";

/// Log severity, serialized lowercase (`"error"`, `"warn"`, `"info"`, `"debug"`,
/// `"trace"`). Declaration order is severity order: `Error` is the most severe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

/// Correlation id tying together every event of one operation (a transition, a source
/// load, a worker restart). Serializes as a plain JSON string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CorrId(pub String);

/// Filter for `recent()`: all `Some`/non-default fields must match.
#[derive(Debug, Clone)]
pub struct LogFilter {
    pub comp: Option<String>,
    pub corr: Option<String>,
    pub min_level: Level,
    pub kind_prefix: Option<String>,
}

impl Default for LogFilter {
    fn default() -> Self {
        LogFilter {
            comp: None,
            corr: None,
            min_level: Level::Trace,
            kind_prefix: None,
        }
    }
}

/// One correlation-id counter, shared by every prefix (`new_corr("tr")` →
/// `CorrId("tr-1")`, `CorrId("tr-2")`, …).
static CORR_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Mints a fresh correlation id of the form `"<prefix>-<n>"`, e.g. `"tr-12"`.
pub fn new_corr(prefix: &str) -> CorrId {
    let n = CORR_COUNTER.fetch_add(1, Ordering::Relaxed);
    CorrId(format!("{prefix}-{n}"))
}

struct LoggerState {
    start: Instant,
    dir: PathBuf,
    level: Level,
    /// `None` means disk logging is currently suspended (a rotation failure left no file
    /// it's safe to keep appending to) — `write_line` diagnoses this on every call rather
    /// than touching a stale handle. See `rotate`.
    writer: Option<BufWriter<File>>,
    current_size: u64,
    rotate_bytes: u64,
    ring: VecDeque<Value>,
    /// Count of events that did not reach disk (write/flush failure, or disk logging
    /// suspended after a rotation failure). Surfaced via `Logger::write_failures`.
    write_failures: u64,
    /// Whether we're mid-failure-burst — gates the `eprintln!` in `note_write_failure` to
    /// once per burst instead of once per event.
    write_failure_streak: bool,
}

/// One event log: a buffered JSONL writer behind a mutex, plus an in-memory ring of
/// the last `RING_CAPACITY` events for `recent()`. `Send + Sync` via the `Mutex`.
pub(crate) struct Logger {
    state: Mutex<LoggerState>,
}

impl Logger {
    /// Opens (or appends to) `events.jsonl` in `dir`, rotating at `rotate_bytes`.
    /// Public to the crate only — production code goes through the global `init`;
    /// this is what tests use to get an independent instance per test.
    pub(crate) fn init_with_limit(
        dir: &Path,
        level: Level,
        rotate_bytes: u64,
    ) -> io::Result<Logger> {
        fs::create_dir_all(dir)?;
        let path = dir.join(EVENTS_FILE);
        let file = open_append(&path)?;
        let current_size = file.metadata()?.len();

        Ok(Logger {
            state: Mutex::new(LoggerState {
                start: Instant::now(),
                dir: dir.to_path_buf(),
                level,
                writer: Some(BufWriter::new(file)),
                current_size,
                rotate_bytes,
                ring: VecDeque::new(),
                write_failures: 0,
                write_failure_streak: false,
            }),
        })
    }

    /// Total events that failed to reach disk since this logger was created — write/flush
    /// failures, plus any event logged while disk logging is suspended after a rotation
    /// failure. These events are still visible via `recent()` (the in-memory ring is
    /// unaffected); only the file on disk is missing them.
    pub(crate) fn write_failures(&self) -> u64 {
        self.state.lock().unwrap().write_failures
    }

    #[cfg(test)]
    pub(crate) fn event(
        &self,
        comp: &'static str,
        level: Level,
        kind: &str,
        corr: Option<CorrId>,
        fields: Value,
    ) {
        self.record(comp, level, kind, corr, fields, false);
    }

    /// Builds the event record; writes it (file + ring) when `level` passes the logger's
    /// threshold. Returns the record only when `for_tap` (a [`Tap`] wants it — built even
    /// below the threshold, so a subscriber can ask for e.g. debug-level kinds).
    pub(crate) fn record(
        &self,
        comp: &'static str,
        level: Level,
        kind: &str,
        corr: Option<CorrId>,
        fields: Value,
        for_tap: bool,
    ) -> Option<Value> {
        // Mutex::lock only fails if a prior panic poisoned it; propagating that panic
        // is the right call here (a bug elsewhere, not something the logger can fix).
        let mut state = self.state.lock().unwrap();
        let keep = level <= state.level;
        if !keep && !for_tap {
            return None;
        }

        let t_mono_ms = state.start.elapsed().as_secs_f64() * 1000.0;
        let t_wall = wall_time_rfc3339();

        let mut obj = Map::new();
        obj.insert("t_mono_ms".to_string(), json!(t_mono_ms));
        obj.insert("t_wall".to_string(), json!(t_wall));
        obj.insert("comp".to_string(), json!(comp));
        obj.insert(
            "level".to_string(),
            serde_json::to_value(level).expect("Level always serializes"),
        );
        obj.insert("kind".to_string(), json!(kind));
        obj.insert(
            "corr".to_string(),
            corr.map(|c| Value::String(c.0)).unwrap_or(Value::Null),
        );
        if let Value::Object(extra) = fields {
            for (k, v) in extra {
                obj.insert(k, v);
            }
        }

        let value = Value::Object(obj);
        let out = for_tap.then(|| value.clone());
        if keep {
            write_line(&mut state, &value);
            state.ring.push_back(value);
            if state.ring.len() > RING_CAPACITY {
                state.ring.pop_front();
            }
        }
        out
    }

    /// Returns up to `limit` matching events, most-recent window, oldest first.
    pub(crate) fn recent(&self, filter: &LogFilter, limit: usize) -> Vec<Value> {
        let state = self.state.lock().unwrap();
        let matched: Vec<Value> = state
            .ring
            .iter()
            .filter(|v| filter_matches(v, filter))
            .cloned()
            .collect();
        let start = matched.len().saturating_sub(limit);
        matched[start..].to_vec()
    }
}

fn filter_matches(entry: &Value, filter: &LogFilter) -> bool {
    let Some(obj) = entry.as_object() else {
        return false;
    };

    if let Some(comp) = &filter.comp
        && obj.get("comp").and_then(Value::as_str) != Some(comp.as_str())
    {
        return false;
    }
    if let Some(corr) = &filter.corr
        && obj.get("corr").and_then(Value::as_str) != Some(corr.as_str())
    {
        return false;
    }
    if let Some(prefix) = &filter.kind_prefix {
        let kind = obj.get("kind").and_then(Value::as_str).unwrap_or("");
        if !kind.starts_with(prefix.as_str()) {
            return false;
        }
    }

    let level: Level = obj
        .get("level")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_value(Value::String(s.to_string())).ok())
        .unwrap_or(Level::Trace);
    level <= filter.min_level
}

/// Writes one line, rotating first if it would push `events.jsonl` past the limit.
/// Every failure path — a write/flush error, or a rotation failure — goes through
/// `note_write_failure` instead of silently dropping the event from disk.
fn write_line(state: &mut LoggerState, value: &Value) {
    if state.writer.is_none() {
        // A prior rotation failure already suspended disk logging; don't retry rotation
        // or touch a nonexistent handle on every single event.
        note_write_failure(state, "disk logging is suspended after an earlier failure");
        return;
    }

    let line = serde_json::to_string(value).unwrap_or_default();
    let bytes = line.len() as u64 + 1; // + newline

    if state.current_size + bytes > state.rotate_bytes
        && let Err(err) = rotate(state, &open_fresh_events_file)
    {
        note_write_failure(
            state,
            &format!("log rotation failed, disk logging suspended: {err}"),
        );
        return;
    }

    // `rotate` only ever returns `Ok` with `writer` set to `Some`, and we returned early
    // above if it was `None` and rotation wasn't attempted (or was attempted and failed,
    // in which case we already returned) — so this is always `Some` here.
    let writer = state
        .writer
        .as_mut()
        .expect("writer is Some: checked above, or just set by a successful rotate()");

    match writeln!(writer, "{line}").and_then(|()| writer.flush()) {
        Ok(()) => {
            state.current_size += bytes;
            if state.write_failure_streak {
                eprintln!(
                    "lp-player: log writes to disk recovered after {} failure(s) so far",
                    state.write_failures
                );
                state.write_failure_streak = false;
            }
        }
        Err(err) => {
            note_write_failure(state, &format!("log write failed: {err}"));
        }
    }
}

/// Records one event that failed to reach disk: increments `write_failures` always, but
/// only `eprintln!`s on the first failure of a burst (cleared again on the next success)
/// so a sustained failure (disk full, suspended logging) doesn't spam stderr once per
/// event.
fn note_write_failure(state: &mut LoggerState, msg: &str) {
    state.write_failures += 1;
    if !state.write_failure_streak {
        eprintln!(
            "lp-player: {msg} (event kept in the in-memory ring only; {} disk write failure(s) so far)",
            state.write_failures
        );
        state.write_failure_streak = true;
    }
}

/// Shifts `events.jsonl` → `events.1.jsonl` → `events.2.jsonl` (oldest dropped), then opens
/// a fresh `events.jsonl` via `open_fresh` (a seam so tests can force the reopen to fail
/// without needing real disk/permission failures). At most 3 files exist after this
/// returns successfully.
///
/// **Safety on failure:** `state.writer` is set to `None` — and `state.current_size` to
/// `0` — *before* calling `open_fresh`, not after. If `open_fresh` fails (its own doc:
/// renames already succeeded, e.g. a transient EMFILE/ENOSPC/permission blip right at the
/// reopen), any previously-open handle now refers to whatever was just renamed to
/// `events.1.jsonl` — continuing to write through it would silently corrupt that file and
/// blow past `rotate_bytes` forever. Detaching first guarantees that can never happen: on
/// error, `writer` stays `None` (disk logging suspended, diagnosed by the caller) rather
/// than ever pointing at a stale, renamed-away file.
fn rotate(
    state: &mut LoggerState,
    open_fresh: &dyn Fn(&Path) -> io::Result<File>,
) -> io::Result<()> {
    if let Some(writer) = state.writer.as_mut() {
        writer.flush()?;
    }

    let p0 = state.dir.join(EVENTS_FILE);
    let p1 = state.dir.join(ROTATED_1);
    let p2 = state.dir.join(ROTATED_2);

    if p2.exists() {
        fs::remove_file(&p2)?;
    }
    if p1.exists() {
        fs::rename(&p1, &p2)?;
    }
    if p0.exists() {
        fs::rename(&p0, &p1)?;
    }

    state.writer = None;
    state.current_size = 0;

    let file = open_fresh(&p0)?;
    state.writer = Some(BufWriter::new(file));
    Ok(())
}

/// Opens `events.jsonl` for appending (process startup: continue whatever was already
/// there across a restart).
fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Opens a fresh (truncated) `events.jsonl` — used by `rotate` once the old file has
/// already been renamed away, so there's nothing to preserve.
fn open_fresh_events_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
}

fn wall_time_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// The process-global logger. Set once by `init`; every other call to `init` after
/// that returns an error instead of panicking.
static GLOBAL: OnceLock<Logger> = OnceLock::new();

/// Initializes the global event log: `events.jsonl` under `dir`, rotated at
/// `DEFAULT_ROTATE_BYTES`. Safe to call from any thread; may only succeed once —
/// a second call returns an error without touching the first logger.
pub fn init(dir: &Path, level: Level) -> io::Result<()> {
    let logger = Logger::init_with_limit(dir, level, DEFAULT_ROTATE_BYTES)?;
    GLOBAL.set(logger).map_err(|_| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "log::init called more than once",
        )
    })
}

/// Emits one event to the global log. A no-op (not a panic) if `init` hasn't run yet
/// — callers that log speculatively before startup finishes don't need to guard this.
/// If a [`Tap`] is installed and [`Tap::wants`] the event, it also gets the record —
/// after the logger's lock is released.
pub fn event(comp: &'static str, level: Level, kind: &str, corr: Option<CorrId>, fields: Value) {
    let Some(logger) = GLOBAL.get() else {
        return;
    };
    let tap = TAP
        .read()
        .ok()
        .and_then(|t| t.clone())
        .filter(|t| t.wants(level, kind));
    if let Some(rec) = logger.record(comp, level, kind, corr, fields, tap.is_some())
        && let Some(t) = tap
    {
        t.send(&rec);
    }
}

/// A live consumer of every event (the command API's `subscribe`, Task 12). Installed
/// with [`set_tap`]; called from whatever thread logs, so it must only queue (never block,
/// never log itself).
pub trait Tap: Send + Sync {
    /// Cheap pre-filter, asked before the record is built: forward this event?
    fn wants(&self, level: Level, kind: &str) -> bool;
    /// One event record — the same object the log stores (`kind`, `corr`, `t_mono_ms`, …).
    fn send(&self, record: &Value);
}

static TAP: RwLock<Option<Arc<dyn Tap>>> = RwLock::new(None);

/// Install (or with `None` remove) the process-wide [`Tap`]. Events reach it whether or
/// not they pass the logger's own level threshold — a subscriber asks for kinds, the log
/// file keeps its level.
pub fn set_tap(tap: Option<Arc<dyn Tap>>) {
    if let Ok(mut t) = TAP.write() {
        *t = tap;
    }
}

/// Returns up to `limit` recent events from the global log matching `filter`, oldest
/// first. Returns an empty vec if `init` hasn't run yet.
pub fn recent(filter: &LogFilter, limit: usize) -> Vec<Value> {
    GLOBAL
        .get()
        .map(|logger| logger.recent(filter, limit))
        .unwrap_or_default()
}

/// The instant `t_mono_ms` counts from (the global logger's start) — `None` before `init`.
/// Anything that timestamps on "the player's monotonic clock" (the bus meter, Task 14)
/// uses this base, so its times line up with every event's `t_mono_ms`.
pub fn mono_start() -> Option<Instant> {
    GLOBAL
        .get()
        .and_then(|l| l.state.lock().ok().map(|s| s.start))
}

/// Now on the `t_mono_ms` clock (`None` before `init`).
pub fn mono_now() -> Option<std::time::Duration> {
    mono_start().map(|s| s.elapsed())
}

/// Total events that failed to reach disk in the global log (write/flush failures, or
/// disk logging suspended after a rotation failure) — see the module doc. `0` if `init`
/// hasn't run yet. Every failure is also diagnosed on stderr once per failure burst.
pub fn write_failures() -> u64 {
    GLOBAL.get().map(Logger::write_failures).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_dir(tag: &str) -> PathBuf {
        let n = DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "lp-player-log-test-{}-{tag}-{n}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn line_schema() {
        let dir = unique_dir("line-schema");
        let logger =
            Logger::init_with_limit(&dir, Level::Trace, DEFAULT_ROTATE_BYTES).expect("init logger");

        logger.event("test", Level::Info, "kind.one", None, json!({"a": 1}));
        logger.event(
            "test",
            Level::Info,
            "kind.two",
            Some(CorrId("tr-1".to_string())),
            json!({"b": 2}),
        );

        let events = logger.recent(&LogFilter::default(), 10);
        assert_eq!(events.len(), 2);

        let e0 = events[0].as_object().expect("object");
        let mut keys: Vec<&str> = e0.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = vec!["t_mono_ms", "t_wall", "comp", "level", "kind", "corr", "a"];
        expected.sort_unstable();
        assert_eq!(keys, expected);

        assert_eq!(e0["comp"], "test");
        assert_eq!(e0["level"], "info");
        assert_eq!(e0["kind"], "kind.one");
        assert!(e0["corr"].is_null());
        assert_eq!(e0["a"], 1);
        assert!(e0["t_mono_ms"].as_f64().is_some());
        assert!(e0["t_wall"].as_str().unwrap().contains('T'));

        let e1 = events[1].as_object().expect("object");
        assert_eq!(e1["corr"], "tr-1");
        assert_eq!(e1["b"], 2);

        let t0 = e0["t_mono_ms"].as_f64().unwrap();
        let t1 = e1["t_mono_ms"].as_f64().unwrap();
        assert!(t1 >= t0, "t_mono_ms must be monotonic: {t0} then {t1}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_for_tap_below_threshold() {
        let dir = unique_dir("tap-below");
        let logger =
            Logger::init_with_limit(&dir, Level::Info, DEFAULT_ROTATE_BYTES).expect("init");
        // Below the threshold: no record unless a tap asks, and never in the ring/file.
        assert!(
            logger
                .record("test", Level::Debug, "k.debug", None, json!({}), false)
                .is_none()
        );
        let rec = logger
            .record("test", Level::Debug, "k.debug", None, json!({"x": 1}), true)
            .expect("record for the tap");
        assert_eq!(rec["kind"], "k.debug");
        assert_eq!(rec["x"], 1);
        assert!(rec["t_mono_ms"].as_f64().is_some());
        assert!(logger.recent(&LogFilter::default(), 10).is_empty());
        // At/above it: written, and handed to the tap too.
        let rec = logger
            .record("test", Level::Info, "k.info", None, json!({}), true)
            .expect("record");
        assert_eq!(rec["kind"], "k.info");
        assert_eq!(logger.recent(&LogFilter::default(), 10).len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_filters_by_corr() {
        let dir = unique_dir("recent-corr");
        let logger =
            Logger::init_with_limit(&dir, Level::Trace, DEFAULT_ROTATE_BYTES).expect("init");

        logger.event(
            "test",
            Level::Info,
            "k",
            Some(CorrId("a".to_string())),
            json!({}),
        );
        logger.event(
            "test",
            Level::Info,
            "k",
            Some(CorrId("b".to_string())),
            json!({}),
        );
        logger.event(
            "test",
            Level::Info,
            "k",
            Some(CorrId("a".to_string())),
            json!({}),
        );

        let filter = LogFilter {
            corr: Some("a".to_string()),
            ..Default::default()
        };
        let events = logger.recent(&filter, 10);

        assert_eq!(
            events.len(),
            2,
            "expected 2 events with corr=a, got {events:?}"
        );
        assert_eq!(events[0]["corr"], "a");
        assert_eq!(events[1]["corr"], "a");
        assert!(
            events[0]["t_mono_ms"].as_f64().unwrap() <= events[1]["t_mono_ms"].as_f64().unwrap(),
            "results must be in chronological order"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_at_20_mib() {
        let dir = unique_dir("rotate");
        // Small injected threshold — the mechanism is identical at any size, and this
        // keeps the test fast instead of writing a real 21 MiB.
        let limit = 1024u64;
        let logger = Logger::init_with_limit(&dir, Level::Trace, limit).expect("init");

        let filler = "x".repeat(200);
        for i in 0..40u32 {
            logger.event(
                "test",
                Level::Info,
                "fill",
                None,
                json!({"i": i, "pad": filler}),
            );
        }

        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();

        assert!(
            names.contains(&"events.jsonl".to_string()),
            "missing events.jsonl, got {names:?}"
        );
        assert!(
            names.contains(&"events.1.jsonl".to_string()),
            "missing events.1.jsonl, got {names:?}"
        );
        assert!(names.len() <= 3, "at most 3 files may exist, got {names:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_rotate_limit_is_20_mib() {
        assert_eq!(DEFAULT_ROTATE_BYTES, 20 * 1024 * 1024);
    }

    #[test]
    fn write_failures_are_counted_not_silent() {
        // /dev/full always fails writes with ENOSPC — a realistic, portable (Linux-only,
        // which matches this whole project) stand-in for "disk full" without needing a
        // real full disk. Construct the Logger directly (same-module private field
        // access) so the writer can point at /dev/full instead of a real temp file.
        let dev_full = Path::new("/dev/full");
        let file = match OpenOptions::new().write(true).open(dev_full) {
            Ok(f) => f,
            Err(err) => {
                eprintln!(
                    "skipping write_failures_are_counted_not_silent: /dev/full unavailable ({err})"
                );
                return;
            }
        };

        let logger = Logger {
            state: Mutex::new(LoggerState {
                start: Instant::now(),
                dir: unique_dir("write-fail"),
                level: Level::Trace,
                writer: Some(BufWriter::new(file)),
                current_size: 0,
                rotate_bytes: DEFAULT_ROTATE_BYTES,
                ring: VecDeque::new(),
                write_failures: 0,
                write_failure_streak: false,
            }),
        };

        logger.event("test", Level::Info, "k", None, json!({}));
        logger.event("test", Level::Info, "k", None, json!({}));

        assert!(
            logger.write_failures() >= 1,
            "disk write failures must be counted, not silently dropped"
        );

        // current_size must stay truthful: never credited for bytes that didn't actually
        // land on disk.
        assert_eq!(
            logger.state.lock().unwrap().current_size,
            0,
            "current_size must not advance past bytes that failed to write"
        );

        // The ring is unaffected by disk failures — both events are still visible.
        let events = logger.recent(&LogFilter::default(), 10);
        assert_eq!(
            events.len(),
            2,
            "events stay in the in-memory ring even when the disk write fails"
        );
    }

    #[test]
    fn rotation_failure_never_writes_through_stale_fd() {
        let dir = unique_dir("rotation-fail");
        let logger =
            Logger::init_with_limit(&dir, Level::Trace, DEFAULT_ROTATE_BYTES).expect("init");

        logger.event("test", Level::Info, "before", None, json!({}));

        // Force the *final* reopen in rotate() to fail, simulating a transient failure
        // right after the renames already succeeded (e.g. EMFILE, a permission blip, a
        // race with another process) — the scenario a real OpenOptions call can hit but
        // that can't be forced portably through real filesystem permissions in a test.
        {
            let mut state = logger.state.lock().unwrap();
            let err = rotate(&mut state, &|_p: &Path| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "forced for test",
                ))
            })
            .expect_err("forced rotation should fail");
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);

            assert!(
                state.writer.is_none(),
                "writer must be detached on a rotation failure, never left pointing at the \
                 just-renamed file"
            );
            assert_eq!(
                state.current_size, 0,
                "current_size must be reset alongside detaching the writer"
            );
        }

        assert!(
            dir.join("events.1.jsonl").exists(),
            "rotation got far enough to rename events.jsonl away before the reopen failed"
        );
        assert!(
            !dir.join("events.jsonl").exists(),
            "no events.jsonl should exist until a rotation succeeds"
        );

        // Further events must not panic, must not silently vanish, and critically must
        // never be appended into the renamed file through the stale handle.
        logger.event("test", Level::Info, "after-failure", None, json!({}));

        assert!(
            logger.write_failures() >= 1,
            "events logged while disk logging is suspended must be diagnosed, not silently \
             dropped"
        );

        let events = logger.recent(&LogFilter::default(), 10);
        assert_eq!(
            events.len(),
            2,
            "both events stay visible via the in-memory ring"
        );

        let on_disk = fs::read_to_string(dir.join("events.1.jsonl")).unwrap();
        assert!(
            !on_disk.contains("after-failure"),
            "must never write through a stale fd into the renamed file: {on_disk:?}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_twice_returns_error() {
        let dir = unique_dir("global-init");

        let first = init(&dir, Level::Info);
        assert!(first.is_ok(), "first init call must succeed: {first:?}");

        let second = init(&dir, Level::Info);
        assert!(
            second.is_err(),
            "second init call must return an error, not panic"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
