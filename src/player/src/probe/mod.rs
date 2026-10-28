//! Probes (spec §4.2 "Probe", §9): named measurements the `probe {name, args}` verb runs
//! against the live runtime. A registry ([`PROBES`]); later tasks add their own (Task 13:
//! `frames`, Task 15: the dropout detector) as files in this directory plus one entry here.
//!
//! - `list` — every probe with a one-line description.
//! - `sources` — per hosted source: kind, path, ready, paused (the node's own raw value),
//!   `effective_paused` (`paused || player.paused`, Task 16b, R75), time_pos, duration,
//!   the graph's effective gain, the live source's own gain slots, mpv's actual
//!   `volume-gain` and in-flight requests (libmpv sources), stepped-mode virtual time,
//!   last event.
//! - `loop` — tick rate, recent tick durations + phases, the longest busy stretch since the
//!   last reset (`args: {"reset": true}` clears it after reading), wakes, clients.
//! - `frames` (`frames.rs`, Task 13) — per output, rolling present intervals (paced:
//!   mean/p50/p95/max/count/missed; all: + fps), idle, frame callback state.
//! - `bus`, `meter.window` (`audio.rs`, Task 14) — the player audio bus and its meter.
//! - `dropout` (`dropout.rs`, Task 15) — the reference-based dropout detector; runs on a
//!   worker thread and replies `pending`, delivering `probe.dropout` as an event.
//! - `snapshot` (`snapshot.rs`, Task 16) — the state snapshot: what would be saved now,
//!   when it's next written, writer counters.
//! - `vram` (`vram.rs`, Phase 2 Task 8) — the VRAM sampler, the low-VRAM rule's state and
//!   hold, each scene worker's VRAM against `player.scene_vram_limit_mib`.
//! - `memory` (`memory.rs`, Task 20b) — RSS + glibc malloc in-use vs retained, arena
//!   count; `args: {"trim": true}` runs `malloc_trim(0)` and reports the RSS it gave back.

mod audio;
pub mod dropout;
pub mod frames;
mod memory;
mod snapshot;
mod vram;
mod workers;

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
        "per source: kind, path, ready, paused, effective_paused, time_pos, gains \
         (graph + live + mpv), last event",
    ),
    (
        "loop",
        loop_stats,
        "tick rate, recent tick durations/phases, max busy ms since reset, wakes, clients",
    ),
    (
        "frames",
        frames::frames,
        "per output: present intervals (mean/p50/p95/max/count/missed), fps, idle, callbacks",
    ),
    (
        "snapshot",
        snapshot::snapshot,
        "the state snapshot: what would be saved now, next write, writes/failures",
    ),
    (
        "bus",
        audio::bus,
        "the player audio bus: state, device, latency, target sink, meter status",
    ),
    (
        "meter.window",
        audio::meter_window,
        "bus meter samples {last_ms | from_ms,to_ms}: [[t_ms, dbfs_1ms]…] + median/min/max/gap",
    ),
    (
        "memory",
        memory::memory,
        "RSS + glibc malloc in-use vs retained bytes, arena count; {trim: true} runs \
         malloc_trim(0) and reports what it gave back",
    ),
    (
        "vram",
        vram::vram,
        "VRAM (Task 8): the sampler, the newest sample, the low-VRAM rule and its hold, each \
         scene worker against the per-scene limit",
    ),
    (
        "workers",
        workers::workers,
        "per scene source: its lp-scene-worker (pid, state, restarts, sync, format, export \
         and native size, fps target/actual, latched, stale reuses, queued, last error)",
    ),
    (
        "dropout",
        dropout::probe,
        "re-run the reference dropout detector for a recent transition {corr}: replies \
         pending, result follows as a probe.dropout event",
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
        // R75: `paused` above is the node's own raw value (recipe/user intent — never
        // corrupted by the player-level override); this is what the live source is
        // actually held at (`node.paused || player.paused`). Task 16c review fix: read
        // `player.paused` straight off the graph here, never `rt.player_paused()` (the
        // cached runtime field) — a pipelined `set player.paused` + `probe sources` in the
        // same batch saw the *stale* cached value (it's only refreshed at the top of the
        // next tick/step), even though `get`/`state` already read it live.
        let player_paused_live = matches!(
            rt.graph.get(&crate::anim::PropPath("player.paused".into())),
            Ok(PropValue::Bool(true))
        );
        o.insert(
            "effective_paused".into(),
            json!(g("paused") == json!(true) || player_paused_live),
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
            o.insert(
                "mpv_audio_device".into(),
                json!(m.mpv_get_string("audio-device")),
            );
            o.insert(
                "mpv_audio_delay".into(),
                json!(m.mpv_get_f64("audio-delay")),
            );
            // I7: whether mpv has a live audio output at all (it drops it when the AO
            // can't open — e.g. PipeWire was down — and gets it back on a re-route).
            o.insert(
                "mpv_current_ao".into(),
                json!(m.mpv_get_string("current-ao")),
            );
            // Task 20b: which decoder mpv really picked (`hwdec: auto` resolves per file).
            o.insert(
                "mpv_hwdec_current".into(),
                json!(m.mpv_get_string("hwdec-current")),
            );
            // Task 20d: what we asked mpv for (`sources::mpv::mpv_hwdec` — copy modes unless
            // the render context loaded a GL interop on the render worker: `hwdec_interop`).
            o.insert("mpv_hwdec".into(), json!(m.mpv_get_string("hwdec")));
            o.insert("hwdec_interop".into(), json!(m.hwdec_interop()));
            o.insert("requests_in_flight".into(), json!(m.requests_in_flight()));
            // How often its dropped first frame was asked for again (`REFETCH_AFTER`, sources/mpv.rs).
            o.insert("frame_refetches".into(), json!(m.frame_refetches()));
            // Phase 2: where it renders, and the worker's timings for it.
            o.insert("render_mode".into(), json!(m.render_mode()));
            o.insert("render".into(), m.render_stats());
            o.insert("stepped".into(), json!(m.is_stepped()));
            o.insert(
                "step_status".into(),
                json!(format!("{:?}", m.step_status())),
            );
        }
        if let Some(s) = rt.host.scene(&id) {
            // Phase 2 Task 5: a scene's worker side (the `workers` probe has the rest).
            o.insert("pid".into(), json!(s.pid()));
            o.insert("scene_time".into(), json!(s.scene_time()));
            o.insert("latched_t".into(), json!(s.latched_t()));
            o.insert("fps_target".into(), json!(s.tick_hz()));
            o.insert("export_size".into(), json!(s.size()));
            o.insert("native".into(), json!(s.native()));
            o.insert(
                "step_status".into(),
                json!(format!("{:?}", s.step_status())),
            );
            o.insert("error".into(), json!(s.error().or(s.broken())));
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
        "opening": rt.host.opening(),
        "open_pool": crate::sources::host::open_pool_stats(),
        "render_worker": rt.host.render_worker().map(|w| w.stats()),
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
        "max_busy_excl_open_ms": s.max_busy_excl_open_ms,
        "max_open_ms": s.max_open_ms,
        "max_request_ms": s.max_request_ms,
        "max_request_cmd": s.max_request_cmd,
        "iterations": s.iterations,
        "wakes": s.wakes,
        "wake_pending": rt.wake_pending,
        "wake_fds": rt.host.wake_fds().len(),
        "clients": rt.server.clients.len(),
        "subscribed_topics": rt.server.topics(),
        "tap_dropped": rt.tap.dropped(),
        "reaper_pending": reaper::pending(),
        "uptime_ms": rt.started.elapsed().as_secs_f64() * 1000.0,
        // R90 (Task 16d): the fast (>= 1 kHz) gain-only timer — armed iff a `gain.*`
        // animation exists (never under the stepped clock). `recent_gain_pushes`:
        // [t_mono_ms, db] pairs, oldest first, bounded.
        "gain_timer_armed": rt.gain_timer_armed(),
        "gain_ticks": s.gain_ticks,
        "gain_pushes": s.gain_pushes,
        // R93: open player-pause anticlick gates (`PauseGate`) — must drop to 0 once a
        // gated source is destroyed/retired, never leaked. `dropout_windows_open`: how
        // many recorded audio windows (transitions, retires, pause gates) are still
        // open — a gate abandoned mid-flight must close its window, not leave it open.
        "pause_gates": rt.pause_gate_count(),
        "dropout_windows_open": rt.dropout_windows.open_count(),
        // C1 (final review): every per-source collection's size — a long run of switches
        // must leave each of these bounded (the "long-run bounds" evidence).
        "bounds": rt.bounds(),
        "recent_gain_pushes": s.recent_gain_pushes
            .iter()
            .map(|(t, db)| json!([t, db]))
            .collect::<Vec<_>>(),
    });
    if args.get("reset").and_then(Value::as_bool) == Some(true) {
        rt.stats.max_busy_ms = 0.0;
        rt.stats.max_busy_excl_open_ms = 0.0;
        rt.stats.max_open_ms = 0.0;
        rt.stats.max_request_ms = 0.0;
        rt.stats.max_request_cmd.clear();
    }
    Ok(v)
}
