//! The `snapshot` probe (Task 16): the state snapshot `--restore` would load
//! (`crate::snapshot`) — what would be saved right now (`current`), when the next write is
//! due, and the writer thread's counters.

use std::sync::atomic::Ordering;
use std::time::Instant;

use serde_json::{Value, json};

use crate::graph::ApiError;
use crate::runtime::Runtime;
use crate::snapshot::FILE;

/// `probe {name: "snapshot"}`.
pub fn snapshot(rt: &mut Runtime, _: &Value) -> Result<Value, ApiError> {
    let now = Instant::now();
    let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
    let st = &rt.snap.writer.stats;
    Ok(json!({
        "path": rt.snap.writer.dir.join(FILE).display().to_string(),
        "writes": st.writes.load(Ordering::Relaxed),
        "failures": st.failures.load(Ordering::Relaxed),
        "last_write_ms": st.last_write_us.load(Ordering::Relaxed) as f64 / 1000.0,
        "since_last_write_ms": rt.snap.last_write.map(|t| ms(now.saturating_duration_since(t))),
        "due_in_ms": rt.snap.due.map(|t| ms(t.saturating_duration_since(now))),
        "frozen": rt.snap.frozen,
        "current": rt.capture_snapshot(),
    }))
}
