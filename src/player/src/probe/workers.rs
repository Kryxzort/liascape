//! `workers` (Phase 2 Task 5): one entry per scene source — its `liascape-scene-worker` and the
//! frame transport (`SceneSource::worker_info`): `{id, path, pid, state (not_spawned |
//! starting | running | restarting N | broken | stopped), restarts_60s, total_restarts,
//! sync (fence|fdpoll), fourcc, modifier, size (export), native, max_size (the demand),
//! fps_target, fps_actual (frames latched in the last second), paused, stepped, ready,
//! scene_time, latched_t, latched, stale_reuses, queued, ticks_sent, frames_received,
//! resizes, buffer_sets, spawns, rings, last_error}` + `reaping` (stopped workers not
//! reaped yet). Task 8: `fps_target` is the effective rate (min(demand, the GPU budget's cap)),
//! plus `fps_demand`, `gpu_ms_p50`/`gpu_ms_p95` (the worker's GL_TIME_ELAPSED over 2 s),
//! `throttle {cap, demand, since_ms}` (null = unthrottled) and `vram_stopped {used_mib,
//! limit_mib}` (the per-scene VRAM guard stopped it). Task 13: `args: {"log_tail": true}` adds
//! each entry's `log_tail` — the worker's last 50 output lines (stderr + `log` messages, across
//! restarts, kept after a fatal stop), what a crash record carries, for a scene that didn't crash.

use serde_json::{Value, json};

use crate::graph::ApiError;
use crate::runtime::Runtime;

pub fn workers(rt: &mut Runtime, args: &Value) -> Result<Value, ApiError> {
    let mut workers = rt.host.workers_info();
    if args.get("log_tail").and_then(Value::as_bool) == Some(true) {
        for w in &mut workers {
            let tail = w["id"]
                .as_str()
                .and_then(|id| rt.host.scene(id))
                .map(crate::sources::scene::SceneSource::log_tail)
                .unwrap_or_default();
            w["log_tail"] = json!(tail);
        }
    }
    Ok(json!({
        "workers": workers,
        "reaping": crate::worker::reap::pending(),
    }))
}
