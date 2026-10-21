//! Probes (spec §4.2 "Probe", §9): named measurements the `probe {name, args}` verb runs
//! against the live runtime. A registry ([`PROBES`]); later tasks add their own (Task 13:
//! `frames`, Task 15: the dropout detector) as files in this directory plus one entry here.
//!
//! - `list` — every probe with a one-line description.
//! - `sources` — per hosted source: kind, path, ready, paused, time_pos, duration, the
//!   graph's effective gain, the live source's own gain slots, mpv's actual `volume-gain`
//!   and in-flight requests (libmpv sources), stepped-mode virtual time, last event.
//! - `loop` — tick rate, recent tick durations + phases, the longest busy stretch since the
//!   last reset (`args: {"reset": true}` clears it after reading), wakes, clients.

use serde_json::{Map, Value, json};

use crate::graph::{ApiError, NodeKind, PropValue};
use crate::runtime::Runtime;
use crate::sources::reaper;
use crate::units::GainSlot;

pub type ProbeFn = fn(&mut Runtime, &Value) -> Result<Value, ApiError>;

/// Every probe: name, function, one-line description.
pub const PROBES: &[(&str, ProbeFn, &str)] = &[
    ("list", list, "every probe with a one-line description"),
    (
        "sources",
        sources,
        "per source: kind, path, ready, paused, time_pos, gains (graph + live + mpv), last event",
    ),
    (
        "loop",
        loop_stats,
        "tick rate, recent tick durations/phases, max busy ms since reset, wakes, clients",
    ),
];

/// Run probe `name`.
pub fn run(rt: &mut Runtime, name: &str, args: &Value) -> Result<Value, ApiError> {
    match PROBES.iter().find(|(n, _, _)| *n == name) {
        Some((_, f, _)) => f(rt, args),
        None => Err(ApiError {
            code: "no_such_probe",
            message: format!("unknown probe {name:?}"),
            hint: "`lp-player ctl probe '{\"name\":\"list\"}'` lists the probes".into(),
        }),
    }
}

fn list(_: &mut Runtime, _: &Value) -> Result<Value, ApiError> {
    let probes: Vec<Value> = PROBES
        .iter()
        .map(|(n, _, d)| json!({"name": n, "description": d}))
        .collect();
    Ok(json!({ "probes": probes }))
}

fn sources(rt: &mut Runtime, _: &Value) -> Result<Value, ApiError> {
    let mut out = Vec::new();
    for id in rt.host.ids() {
        let g = |prop: &str| {
            rt.graph
                .get(&crate::anim::PropPath(format!("{id}.{prop}")))
                .map(|v| v.to_json())
                .unwrap_or(Value::Null)
        };
        let mut o = Map::new();
        o.insert("id".into(), json!(id));
        for prop in [
            "kind", "path", "ready", "paused", "loop", "speed", "time_pos", "duration",
        ] {
            o.insert(prop.into(), g(prop));
        }
        o.insert(
            "gain_effective_db".into(),
            json!(rt.graph.effective_gain_db(&id)),
        );
        if let Some(src) = rt.host.get(&id) {
            let mut gains = Map::new();
            for slot in GainSlot::ALL {
                if let Some(PropValue::F64(db)) = src.read(&format!("gain.{}", slot.as_str())) {
                    gains.insert(slot.as_str().into(), json!(db));
                }
            }
            o.insert("gains".into(), Value::Object(gains));
            o.insert("live_kind".into(), json!(src.kind()));
            o.insert("size".into(), json!(src.size()));
        }
        if let Some(m) = rt.host.mpv(&id) {
            // Synchronous mpv reads: probes only (see sources/mpv.rs "Async core calls").
            o.insert(
                "mpv_volume_gain".into(),
                json!(m.mpv_get_f64("volume-gain")),
            );
            o.insert("mpv_pause".into(), json!(m.mpv_get_string("pause")));
            o.insert("requests_in_flight".into(), json!(m.requests_in_flight()));
            o.insert("stepped".into(), json!(m.is_stepped()));
            o.insert(
                "step_status".into(),
                json!(format!("{:?}", m.step_status())),
            );
        }
        if let Some(lt) = rt.local.get(&id) {
            o.insert("virtual_t".into(), json!(lt.t));
        }
        o.insert("last_event".into(), json!(rt.last_event.get(&id)));
        out.push(Value::Object(o));
    }
    let snapshots = rt
        .graph
        .ids_of(NodeKind::Source)
        .len()
        .saturating_sub(out.len());
    Ok(json!({
        "sources": out,
        "nodes_not_hosted": snapshots,
        "dying": rt.host.dying(),
        "reaper_pending": reaper::pending(),
    }))
}

fn loop_stats(rt: &mut Runtime, args: &Value) -> Result<Value, ApiError> {
    let s = &rt.stats;
    let recent: Vec<f64> = s.last_ticks.iter().rev().take(8).copied().collect();
    let v = json!({
        "clock": rt.clock_name(),
        "tick_period_ms": rt.tick_period.as_secs_f64() * 1000.0,
        "ticks": s.ticks,
        "tick_hz_last_s": s.tick_times.len(),
        "last_tick_ms": s.last_ticks.back(),
        "recent_ticks_ms": recent,
        "max_tick_ms_recent": s.last_ticks.iter().copied().fold(0.0, f64::max),
        "last_phases": s.last_phases,
        "max_busy_ms": s.max_busy_ms,
        "iterations": s.iterations,
        "wakes": s.wakes,
        "wake_pending": rt.wake_pending,
        "wake_fds": rt.host.wake_fds().len(),
        "clients": rt.server.clients.len(),
        "subscribed_topics": rt.server.topics(),
        "tap_dropped": rt.tap.dropped(),
        "reaper_pending": reaper::pending(),
        "uptime_ms": rt.started.elapsed().as_secs_f64() * 1000.0,
    });
    if args.get("reset").and_then(Value::as_bool) == Some(true) {
        rt.stats.max_busy_ms = 0.0;
    }
    Ok(v)
}
