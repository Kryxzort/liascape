//! `workers` (Phase 2 Task 5): one entry per scene source — its `lp-scene-worker` and the
//! frame transport (`SceneSource::worker_info`): `{id, path, pid, state (not_spawned |
//! starting | running | restarting N | broken | stopped), restarts_60s, total_restarts,
//! sync (fence|fdpoll), fourcc, modifier, size (export), native, max_size (the demand),
//! fps_target, fps_actual (frames latched in the last second), paused, stepped, ready,
//! scene_time, latched_t, latched, stale_reuses, queued, ticks_sent, frames_received,
//! resizes, buffer_sets, spawns, rings, last_error}` + `reaping` (stopped workers not
//! reaped yet). Task 8 adds the GPU fields.

use serde_json::{Value, json};

use crate::graph::ApiError;
use crate::runtime::Runtime;

pub fn workers(rt: &mut Runtime, _: &Value) -> Result<Value, ApiError> {
    Ok(json!({
        "workers": rt.host.workers_info(),
        "reaping": crate::worker::reap::pending(),
    }))
}
