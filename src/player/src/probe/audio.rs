//! Audio probes (Task 14; spec §5.3 "the probes tap the bus monitor").
//!
//! - `bus` — `{state, device, latency_ms, latency_samples, quantum_ms, target,
//!   default_sink, playback_node, sink_node, retargets, reason, now_ms, meter {available,
//!   streaming, samples, last_ms, quantum_frames, dropped, error}}`; `state: "down"` with
//!   `reason` when there's no bus (fallback / `--ao null`).
//! - `meter.window` — args `{last_ms}` or `{from_ms, to_ms}` (the `t_mono_ms` clock), plus
//!   `samples: false` to leave the list out → `{from_ms, to_ms, count, median_db, min_db,
//!   max_db, max_gap_ms, first_ms, last_ms, samples: [[t_ms, dbfs], …]}`. A meter that
//!   isn't available is an `unsupported` error saying why — never an empty "all quiet".

use std::time::Duration;

use serde_json::{Value, json};

use crate::graph::ApiError;
use crate::runtime::Runtime;

fn now_ms() -> f64 {
    crate::log::mono_now()
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub(super) fn bus(rt: &mut Runtime, _: &Value) -> Result<Value, ApiError> {
    let a = &rt.audio;
    let mut v = match &a.bus {
        Some(b) => serde_json::to_value(b.info()).unwrap_or(Value::Null),
        None => json!({
            "state": "down",
            "device": Value::Null,
            "reason": a.down_reason,
        }),
    };
    let meter = match a.meter() {
        Some(m) => serde_json::to_value(m.status()).unwrap_or(Value::Null),
        None => json!({ "available": false, "error": a.meter_unavailable() }),
    };
    v["meter"] = meter;
    v["now_ms"] = json!(now_ms());
    Ok(v)
}

fn bad(msg: String) -> ApiError {
    ApiError {
        code: "bad_request",
        message: msg,
        hint: "`ctl probe '{\"name\":\"meter.window\",\"args\":{\"last_ms\":1000}}'` or \
               `{\"from_ms\":…,\"to_ms\":…}` (t_mono_ms clock — see `ctl logs`)"
            .into(),
    }
}

pub(super) fn meter_window(rt: &mut Runtime, args: &Value) -> Result<Value, ApiError> {
    let num = |k: &str| args.get(k).and_then(Value::as_f64);
    let (from, to) = match (num("last_ms"), num("from_ms"), num("to_ms")) {
        (Some(l), None, None) if l >= 0.0 => {
            let now = now_ms();
            (now - l, now)
        }
        (None, Some(f), Some(t)) if t >= f => (f, t),
        _ => {
            return Err(bad(format!(
                "meter.window needs {{last_ms}} or {{from_ms, to_ms}} (to ≥ from, ≥ 0), got {args}"
            )));
        }
    };
    if let Some(why) = rt.audio.meter_unavailable() {
        return Err(ApiError {
            code: "unsupported",
            message: format!("bus meter unavailable: {why}"),
            hint: "`liascape-player ctl probe '{\"name\":\"bus\"}'` shows the bus state and why; \
                   `ctl logs '{\"kind_prefix\":\"audio.\"}'` its events"
                .into(),
        });
    }
    let Some(m) = rt.audio.meter() else {
        unreachable!("meter_unavailable() is None only with a meter");
    };
    let d = |ms: f64| Duration::from_secs_f64(ms.max(0.0) / 1000.0);
    let w = m.window(d(from), d(to));
    let ms: Vec<(f64, f64)> = w
        .iter()
        .map(|(t, db)| (t.as_secs_f64() * 1000.0, *db))
        .collect();
    let mut dbs: Vec<f64> = ms.iter().map(|(_, db)| *db).collect();
    dbs.sort_by(f64::total_cmp);
    let median = (!dbs.is_empty()).then(|| {
        let n = dbs.len();
        if n % 2 == 1 {
            dbs[n / 2]
        } else {
            (dbs[n / 2 - 1] + dbs[n / 2]) / 2.0
        }
    });
    let max_gap = ms
        .windows(2)
        .map(|p| p[1].0 - p[0].0)
        .fold(None, |a: Option<f64>, g| Some(a.map_or(g, |a| a.max(g))));
    let mut v = json!({
        "from_ms": from,
        "to_ms": to,
        "count": ms.len(),
        "median_db": median,
        "min_db": dbs.first(),
        "max_db": dbs.last(),
        "max_gap_ms": max_gap,
        "first_ms": ms.first().map(|x| x.0),
        "last_ms": ms.last().map(|x| x.0),
    });
    if args.get("samples").and_then(Value::as_bool) != Some(false) {
        v["samples"] = json!(ms.iter().map(|(t, db)| [*t, *db]).collect::<Vec<_>>());
    }
    Ok(v)
}
