//! `vram` (Phase 2 Task 8): what the VRAM rules see and do — the sampler (`probe` nvml | drm |
//! nvidia-smi | fake | none, or null while no rule needs it), the newest sample (`total_mib`,
//! `free_mib`, `used_mib`, our `procs`), the low-VRAM rule (`mode`, `state` normal | pending |
//! low | recovering, `low_mib`, `resume_mib`, `reserve_mib`, the holds), the hold (`phase`,
//! `suspended`, `since_ms`), and per scene its worker's VRAM against `scene_limit_mib`.

use std::time::Instant;

use serde_json::{Value, json};

use crate::graph::{ApiError, PropValue};
use crate::runtime::{HoldPhase, Runtime};

pub fn vram(rt: &mut Runtime, _: &Value) -> Result<Value, ApiError> {
    let now = Instant::now();
    let get = |k: &str| rt.graph.get(&crate::anim::PropPath(format!("player.{k}")));
    let mode = match get("vram_low_mode") {
        Ok(PropValue::Str(s)) => s,
        _ => String::new(),
    };
    let limit = match get("scene_vram_limit_mib") {
        Ok(PropValue::F64(f)) => f,
        _ => 0.0,
    };
    let (sample, error, age_ms) = match &rt.vram.last {
        Some((at, Ok(s))) => (
            Some(s.clone()),
            None,
            Some(now.saturating_duration_since(*at).as_secs_f64() * 1e3),
        ),
        Some((at, Err(e))) => (
            None,
            Some(e.clone()),
            Some(now.saturating_duration_since(*at).as_secs_f64() * 1e3),
        ),
        None => (None, None, None),
    };
    let hold = rt.vram.hold.as_ref().map(|h| {
        json!({
            "mode": h.mode,
            "phase": match h.phase {
                HoldPhase::Pausing { .. } => "pausing",
                HoldPhase::Held => "held",
                HoldPhase::Resuming { .. } => "resuming",
            },
            "since_ms": now.saturating_duration_since(h.since).as_secs_f64() * 1e3,
            "suspended": h.suspended,
        })
    });
    let scenes: Vec<Value> = rt
        .host
        .scene_ids()
        .into_iter()
        .filter_map(|id| {
            let sc = rt.host.scene(&id)?;
            let pid = sc.pid();
            let used = sample
                .as_ref()
                .and_then(|s| s.procs.as_ref())
                .and_then(|m| pid.and_then(|p| m.get(&p)))
                .copied();
            Some(json!({
                "id": id,
                "pid": pid,
                "used_mib": used,
                "over_ms": rt.vram.over_since.get(&id)
                    .map(|t| now.saturating_duration_since(*t).as_secs_f64() * 1e3),
                "stopped": sc.vram_stopped()
                    .map(|(u, l)| json!({"used_mib": u, "limit_mib": l})),
            }))
        })
        .collect();
    Ok(json!({
        "probe": rt.vram.monitor.as_ref().map(|m| m.probe()),
        "sample": sample.as_ref().map(|s| s.to_json()),
        "error": error,
        "sampled_ms_ago": age_ms,
        "mode": mode,
        "rule": rt.vram.low.to_json(sample.as_ref().map(|s| s.total_mib)),
        "hold": hold,
        "suspended": rt.host.suspended_ids(),
        "resuming": rt.host.resuming_count(),
        "scene_limit_mib": limit,
        "scenes": scenes,
    }))
}
