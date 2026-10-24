//! The `memory` probe (Task 20b): RSS + glibc malloc accounting (`crate::mem`) — splits a
//! growing RSS into *in use* (`in_use_bytes + mmap_bytes`: something still owns it — a
//! leak) vs *retained* (`free_bytes`: freed, held by the arenas). `args: {"trim": true}`
//! runs `malloc_trim(0)` and reports the RSS before/after — what retention alone costs.
//! NOTE: that trim runs ON THE LOOP THREAD (a debug probe): with hundreds of MiB retained
//! it can take far longer than a frame (3.9 ms with ~40 MiB) and drop frames.

use std::time::Instant;

use serde_json::{Value, json};

use crate::graph::ApiError;
use crate::mem;
use crate::runtime::Runtime;
use crate::sources::{host, reaper};

/// `probe {name: "memory", args?: {trim?: bool}}`.
pub fn memory(rt: &mut Runtime, args: &Value) -> Result<Value, ApiError> {
    let before = mem::proc_status();
    let malloc = mem::malloc_stats();
    let mut v = json!({
        "proc": before,
        "malloc": malloc,
        "policy": mem::policy(),
        // Monotonic (the log ring is bounded): the soak's switch counter.
        "transitions_done_total": crate::log::transitions_done_total(),
        "live_sources": rt.host.ids().len(),
        "dying_sources": rt.host.dying(),
        "opening": host::opening_pending(),
        "reaper_pending": reaper::pending(),
    });
    if args.get("trim").and_then(Value::as_bool) == Some(true) {
        let t = Instant::now();
        let released = mem::trim();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        v["trim"] = json!({
            "released": released,
            "ms": ms,
            "proc_after": mem::proc_status(),
            "malloc_after": mem::malloc_stats(),
        });
    }
    Ok(v)
}
