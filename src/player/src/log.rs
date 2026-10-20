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

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
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
    writer: BufWriter<File>,
    current_size: u64,
    rotate_bytes: u64,
    ring: VecDeque<Value>,
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
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let current_size = file.metadata()?.len();

        Ok(Logger {
            state: Mutex::new(LoggerState {
                start: Instant::now(),
                dir: dir.to_path_buf(),
                level,
                writer: BufWriter::new(file),
                current_size,
                rotate_bytes,
                ring: VecDeque::new(),
            }),
        })
    }

    pub(crate) fn event(
        &self,
        comp: &'static str,
        level: Level,
        kind: &str,
        corr: Option<CorrId>,
        fields: Value,
    ) {
        // Mutex::lock only fails if a prior panic poisoned it; propagating that panic
        // is the right call here (a bug elsewhere, not something the logger can fix).
        let mut state = self.state.lock().unwrap();
        if level > state.level {
            return;
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
        write_line(&mut state, &value);

        state.ring.push_back(value);
        if state.ring.len() > RING_CAPACITY {
            state.ring.pop_front();
        }
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
fn write_line(state: &mut LoggerState, value: &Value) {
    let line = serde_json::to_string(value).unwrap_or_default();
    let bytes = line.len() as u64 + 1; // + newline

    if state.current_size + bytes > state.rotate_bytes
        && let Err(err) = rotate(state)
    {
        eprintln!("lp-player: log rotation failed: {err}");
    }

    if writeln!(state.writer, "{line}").is_ok() && state.writer.flush().is_ok() {
        state.current_size += bytes;
    }
}

/// Shifts `events.jsonl` → `events.1.jsonl` → `events.2.jsonl` (oldest dropped), then
/// reopens a fresh `events.jsonl`. At most 3 files exist after this returns.
fn rotate(state: &mut LoggerState) -> io::Result<()> {
    state.writer.flush()?;

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

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&p0)?;
    state.writer = BufWriter::new(file);
    state.current_size = 0;
    Ok(())
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
pub fn event(comp: &'static str, level: Level, kind: &str, corr: Option<CorrId>, fields: Value) {
    if let Some(logger) = GLOBAL.get() {
        logger.event(comp, level, kind, corr, fields);
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
