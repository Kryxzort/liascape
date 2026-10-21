//! The verbs (spec §4.2 "Command API"): generic graph verbs (`create`/`destroy`/`set`/
//! `get`/`animate`), thin recipe verbs (`transition`/`cancel`), queries (`state`/`logs`/
//! `probe`/`effects`/`hello`), `capture`, lifecycle (`stop`/`quit`), and the headless-only
//! `step` + `headless.*`. Each verb is documented, with a `ctl` example, in
//! `.claude/rules/player-core.md` § Command API — keep [`VERBS`] and that table in step.

use std::time::Duration;

use serde_json::{Map, Value, json};

use super::proto::{self, arg_f64, arg_str, bad_request, opt_f64, opt_str};
use crate::anim::{AnimUnit, Animation, Curve, PropPath};
use crate::graph::{ApiError, NodeKind, PropType, PropValue, props};
use crate::headless::OutputInfo;
use crate::log::{self, Level, LogFilter};
use crate::recipes::TransitionReq;
use crate::runtime::Runtime;
use crate::units::db_to_lin;

type Handler = fn(&mut Runtime, u64, &Value) -> Result<Value, ApiError>;

/// Every verb: name, handler, one-line summary (`hello` lists them).
pub const VERBS: &[(&str, Handler, &str)] = &[
    ("hello", hello, "version, pid, capabilities, clock, verbs"),
    ("create", create, "create a node {kind, id?, props}"),
    ("destroy", destroy, "destroy a node {id}"),
    (
        "set",
        set,
        "set a property {path, value} (aliases apply to every match)",
    ),
    ("get", get, "read a property {path}"),
    (
        "animate",
        animate,
        "animate a numeric property {path, to, duration_ms, curve?, from?, unit?}",
    ),
    (
        "transition",
        transition,
        "A→B transition recipe {…TransitionReq} → {corr, to}",
    ),
    ("cancel", cancel, "cancel an in-flight transition {corr}"),
    (
        "state",
        state,
        "the live graph, transitions, clock, outputs",
    ),
    (
        "subscribe",
        subscribe,
        "stream events whose kind starts with a topic {topics}",
    ),
    (
        "capture",
        capture,
        "write an output or source texture to PNG {target, path}",
    ),
    (
        "logs",
        logs,
        "recent event-log records {comp?, corr?, min_level?, kind_prefix?, limit?}",
    ),
    (
        "probe",
        probe,
        "run a probe {name, args?} (`probe {name:\"list\"}`)",
    ),
    ("effects", effects, "the transition effect catalogue ids"),
    (
        "stop",
        stop,
        "silence + destroy every source, empty every layer",
    ),
    ("quit", quit, "stop, then exit"),
    (
        "step",
        step_placeholder,
        "advance the stepped clock {ms} (stepped clock only)",
    ),
    (
        "headless.add_output",
        add_output,
        "add a virtual output {name, width, height, hz}",
    ),
    (
        "headless.remove_output",
        remove_output,
        "remove a virtual output {name}",
    ),
];

fn verb_names() -> Vec<&'static str> {
    VERBS.iter().map(|(n, _, _)| *n).collect()
}

/// Handle one request. `None` = the reply is deferred (`step`); the runtime sends it.
pub fn handle(
    rt: &mut Runtime,
    client: u64,
    req: &proto::Request,
) -> Option<Result<Value, ApiError>> {
    if req.cmd == "step" {
        return match step_args(rt, &req.args)
            .and_then(|dt| rt.queue_step(client, req.id.clone(), dt))
        {
            Ok(()) => None,
            Err(e) => Some(Err(e)),
        };
    }
    let Some((_, f, _)) = VERBS.iter().find(|(n, _, _)| *n == req.cmd) else {
        return Some(Err(proto::no_such_verb(&req.cmd, &verb_names())));
    };
    Some(f(rt, client, &req.args))
}

fn hint(s: &str) -> String {
    s.to_string()
}

// ---------------------------------------------------------------- queries

fn hello(rt: &mut Runtime, _: u64, _: &Value) -> Result<Value, ApiError> {
    let mut caps = vec!["video", "image", "color", "transition"];
    if rt.backend.kind() == "headless" {
        caps.push("headless");
    }
    if rt.stepped() {
        caps.push("stepped");
    }
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "protocol": 1,
        "capabilities": caps,
        "clock": rt.clock_name(),
        "backend": rt.backend.kind(),
        "verbs": verb_names(),
    }))
}

fn state(rt: &mut Runtime, _: u64, _: &Value) -> Result<Value, ApiError> {
    let outputs: Vec<Value> = rt
        .backend
        .outputs()
        .iter()
        .map(|o| {
            json!({"name": o.name, "width": o.width, "height": o.height, "hz": o.hz,
                   "refresh_mhz": o.refresh_mhz})
        })
        .collect();
    Ok(json!({
        "graph": rt.graph.snapshot(),
        "transitions": rt.tr.status(),
        "clock": {"mode": rt.clock_name(), "now_ms": rt.now().as_secs_f64() * 1000.0},
        "outputs": outputs,
        "backend": rt.backend.kind(),
        "sources": rt.host.ids(),
        "parked": rt.parked.as_ref().map(|p| p.id.clone()),
    }))
}

fn effects(rt: &mut Runtime, _: u64, _: &Value) -> Result<Value, ApiError> {
    Ok(json!({ "ids": rt.cat.ids() }))
}

fn logs(_: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let min_level = match opt_str(args, "min_level")? {
        None => Level::Trace,
        Some(l) => serde_json::from_value(json!(l)).map_err(|_| {
            bad_request(format!(
                "min_level {l:?}: expected error|warn|info|debug|trace"
            ))
        })?,
    };
    let filter = LogFilter {
        comp: opt_str(args, "comp")?.map(str::to_string),
        corr: opt_str(args, "corr")?.map(str::to_string),
        min_level,
        kind_prefix: opt_str(args, "kind_prefix")?.map(str::to_string),
    };
    let limit = opt_f64(args, "limit")?
        .unwrap_or(200.0)
        .clamp(1.0, 10_000.0) as usize;
    Ok(json!({ "events": log::recent(&filter, limit) }))
}

fn probe(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let name = arg_str(args, "name")?;
    let pargs = args.get("args").cloned().unwrap_or_else(|| json!({}));
    crate::probe::run(rt, name, &pargs)
}

fn subscribe(rt: &mut Runtime, client: u64, args: &Value) -> Result<Value, ApiError> {
    let topics: Vec<String> = args
        .get("topics")
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request("args.topics must be a list of kind prefixes".into()))?
        .iter()
        .map(|t| {
            t.as_str()
                .map(str::to_string)
                .ok_or_else(|| bad_request(format!("topic {t} is not a string")))
        })
        .collect::<Result<_, _>>()?;
    let Some(c) = rt.server.clients.get_mut(&client) else {
        return Err(bad_request("no such client".into()));
    };
    for t in topics {
        if !c.subs.contains(&t) {
            c.subs.push(t);
        }
    }
    let subs = c.subs.clone();
    rt.tap.set_topics(rt.server.topics());
    Ok(json!({ "topics": subs }))
}

// ---------------------------------------------------------------- graph verbs

fn parse_kind(k: &str) -> Result<NodeKind, ApiError> {
    match k {
        "source" => Ok(NodeKind::Source),
        "layer" => Ok(NodeKind::Layer),
        "effect" => Ok(NodeKind::Effect),
        "output" => Err(proto::unsupported(
            "outputs come from the compositor (Wayland) or headless.add_output".into(),
            "headless: `lp-player ctl headless.add_output '{\"name\":\"VIRTUAL-3\",\"width\":\
             1920,\"height\":1080,\"hz\":60}'`",
        )),
        "player" => Err(proto::unsupported(
            "`player` is a singleton".into(),
            "set its properties instead (`player.debug`)",
        )),
        other => Err(bad_request(format!(
            "kind {other:?}: expected source|layer|effect"
        ))),
    }
}

fn create(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let kind = parse_kind(arg_str(args, "kind")?)?;
    let id = opt_str(args, "id")?.map(str::to_string);
    let props = match args.get("props") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(other) => {
            return Err(bad_request(format!(
                "args.props must be an object, got {other}"
            )));
        }
    };
    if let Some(i) = &id
        && (i.is_empty() || i.contains('.') || i.contains('*'))
    {
        return Err(bad_request(format!(
            "id {i:?}: ids are non-empty and contain no `.` or `*`"
        )));
    }
    if kind == NodeKind::Effect
        && let Some(eid) = props.get("effect_id")
    {
        check_effect(rt, eid)?;
    }
    let id = rt.graph.create(kind, id, props)?;
    Ok(json!({ "id": id }))
}

/// R49 for every way an effect id gets in (`transition`, `create`, `set`): a non-empty
/// string must name a catalogue effect.
fn check_effect(rt: &Runtime, v: &Value) -> Result<(), ApiError> {
    match v.as_str() {
        Some(eid) if !eid.is_empty() && !rt.cat.ids().iter().any(|i| i == eid) => Err(ApiError {
            code: "no_such_effect",
            message: format!("effect_id {eid:?} is not in the catalogue"),
            hint: hint("`lp-player ctl effects` lists every id; `effect_id: null` is a cut"),
        }),
        _ => Ok(()),
    }
}

fn destroy(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let id = arg_str(args, "id")?;
    match rt.graph.kind_of(id) {
        Some(NodeKind::Output) => {
            return Err(proto::unsupported(
                format!("{id} is an output; outputs follow the compositor"),
                "headless: `lp-player ctl headless.remove_output '{\"name\":\"VIRTUAL-2\"}'`",
            ));
        }
        Some(NodeKind::Layer) if id.ends_with(":main") => {
            return Err(proto::unsupported(
                format!("{id} is an output's main layer; it goes with its output"),
                "empty it instead: `set {\"path\":\"<layer>.content\",\"value\":\"\"}`",
            ));
        }
        _ => {}
    }
    if rt.graph.kind_of(id).is_none() {
        rt.graph.destroy(id)?; // the graph's own no_such_node
    }
    // A source is ramped out first if it can be heard (core invariant); `ramp_ms` says
    // how long until it's gone (0 = gone now).
    let ramp = rt.retire(id);
    Ok(json!({ "ramp_ms": ramp.as_secs_f64() * 1000.0 }))
}

/// The node kind a broadcast alias addresses — `srcs:*`, `cur:*`, `out:*`, `lay:*:main`,
/// and `srcs:<c>`/`cur:<c>` of an output that exists. `None` for anything else (an
/// unknown connector stays `no_such_node`).
fn wildcard_kind(rt: &Runtime, node_ref: &str) -> Option<NodeKind> {
    match node_ref {
        "srcs:*" | "cur:*" => Some(NodeKind::Source),
        "out:*" => Some(NodeKind::Output),
        "lay:*:main" => Some(NodeKind::Layer),
        _ => {
            let c = node_ref
                .strip_prefix("srcs:")
                .or_else(|| node_ref.strip_prefix("cur:"))?;
            (rt.graph.kind_of(&format!("out:{c}")) == Some(NodeKind::Output))
                .then_some(NodeKind::Source)
        }
    }
}

/// `set {path, value}`. A **wildcard** alias that matches nothing right now (a global
/// setting sent to `srcs:*` while nothing plays) is still checked against its kind's
/// schema and then succeeds with `targets: []` — a broadcast to nobody isn't an error.
fn set(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let path = arg_str(args, "path")?;
    let value = args
        .get("value")
        .ok_or_else(|| bad_request("args.value is required".into()))?;
    if path
        .split_once('.')
        .is_some_and(|(_, prop)| prop == "effect_id")
    {
        check_effect(rt, value)?;
    }
    if let Some((node_ref, prop)) = path.split_once('.')
        && let Some(kind) = wildcard_kind(rt, node_ref)
        && rt.graph.resolve(node_ref).is_empty()
    {
        crate::graph::Graph::typed_for_set(kind, prop, value)?;
        return Ok(json!({ "targets": [] }));
    }
    let targets = rt.graph.set_json(&PropPath(path.to_string()), value)?;
    Ok(json!({ "targets": targets }))
}

fn get(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let path = arg_str(args, "path")?;
    let v = rt.graph.get(&PropPath(path.to_string()))?;
    Ok(json!({ "value": v.to_json() }))
}

fn parse_curve(s: &str) -> Result<Curve, ApiError> {
    match s.to_ascii_lowercase().replace('-', "_").as_str() {
        "linear" => Ok(Curve::Linear),
        "smoothstep" => Ok(Curve::Smoothstep),
        "equal_power_out" => Ok(Curve::EqualPowerOut),
        "equal_power_in" => Ok(Curve::EqualPowerIn),
        "step" => Ok(Curve::Step),
        _ => Err(bad_request(format!(
            "curve {s:?}: expected linear|smoothstep|equal_power_out|equal_power_in|step"
        ))),
    }
}

/// `animate {path, to, duration_ms, curve?, from?, unit?}`: one animation per resolved
/// node, starting now. Numeric (`F64`) properties and gain slots only. `unit`:
/// `scalar` (default — `from`/`to` in the property's own unit, dB for gains) or
/// `gain_linear` (`from`/`to` linear amplitude, emitted as dB). Returns `{corr,
/// targets}`; `anim.done {corr}` is logged as each finishes.
fn animate(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let path = arg_str(args, "path")?;
    let to = arg_f64(args, "to")?;
    let dur = arg_f64(args, "duration_ms")?;
    if !(0.0..=3_600_000.0).contains(&dur) {
        return Err(bad_request("duration_ms must be 0–3600000".into()));
    }
    let curve = parse_curve(opt_str(args, "curve")?.unwrap_or("linear"))?;
    let unit = match opt_str(args, "unit")?.unwrap_or("scalar") {
        "scalar" => AnimUnit::Scalar,
        "gain_linear" => AnimUnit::GainLinear,
        u => {
            return Err(bad_request(format!(
                "unit {u:?}: expected scalar|gain_linear"
            )));
        }
    };
    let from = opt_f64(args, "from")?;
    let (node_ref, prop) = path
        .split_once('.')
        .ok_or_else(|| bad_request(format!("path {path:?} needs <node>.<prop>")))?;
    if unit == AnimUnit::GainLinear && !prop.starts_with("gain.") {
        return Err(bad_request(format!(
            "unit gain_linear is for gain slots (`<source>.gain.<slot>`), not {prop:?}; \
             use unit scalar"
        )));
    }
    let targets = rt.graph.resolve(node_ref);
    if targets.is_empty() {
        return Err(ApiError {
            code: "no_such_node",
            message: format!("no such node: {node_ref:?}"),
            hint: hint("run `lp-player ctl state` to see the live graph"),
        });
    }
    // Validate every target first (numeric, writable, `to` in range) — all or nothing.
    let mut starts = Vec::new();
    for id in &targets {
        let kind = rt.graph.kind_of(id).expect("resolved");
        let numeric = prop.starts_with("gain.")
            || props::schema_for(kind, prop).is_some_and(|d| matches!(d.ty, PropType::F64));
        if !numeric {
            props::validate_value(kind, prop, &PropValue::F64(to), true)?;
            return Err(ApiError {
                code: "bad_type",
                message: format!("{id}.{prop} is not a numeric property; only numbers animate"),
                hint: hint(
                    "animate numbers and gain slots (`src1.gain.user`, `fx1.progress`, \
                            `lay:DP-1:main.opacity`)",
                ),
            });
        }
        let emitted = |v: f64| match unit {
            AnimUnit::Scalar => v,
            AnimUnit::GainLinear => crate::units::lin_to_db(v),
        };
        props::validate_value(kind, prop, &PropValue::F64(emitted(to)), true)?;
        if let Some(f) = from {
            props::validate_value(kind, prop, &PropValue::F64(emitted(f)), true)?;
        }
        let cur = match rt.graph.get(&PropPath(format!("{id}.{prop}")))? {
            PropValue::F64(f) => f,
            PropValue::I64(i) => i as f64,
            _ => 0.0,
        };
        let start = from.unwrap_or(match unit {
            AnimUnit::Scalar => cur,
            AnimUnit::GainLinear => db_to_lin(cur),
        });
        starts.push(start);
    }
    let corr = log::new_corr("an");
    let now = rt.now();
    for (id, start) in targets.iter().zip(starts) {
        rt.anim.add(Animation {
            target: PropPath(format!("{id}.{prop}")),
            from: start,
            to,
            start: now,
            duration: Duration::from_secs_f64(dur / 1000.0),
            curve,
            unit,
            corr: Some(corr.clone()),
        });
    }
    log::event(
        "runtime",
        Level::Info,
        "anim.start",
        Some(corr.clone()),
        json!({ "path": path, "targets": targets, "to": to, "duration_ms": dur }),
    );
    Ok(json!({ "corr": corr, "targets": targets }))
}

// ---------------------------------------------------------------- recipes

fn transition(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let req: TransitionReq = serde_json::from_value(args.clone()).map_err(|e| {
        bad_request(format!(
            "transition args: {e} (fields: outputs, to, effect_id?, params?, duration_ms?, \
             method? full-live|reveal|frozen, align? now|end)"
        ))
    })?;
    if let Some(eid) = &req.effect_id {
        check_effect(rt, &json!(eid))?;
    }
    let now = rt.now();
    let corr = rt.tr.start(req, &mut rt.graph, &mut rt.anim, now)?;
    rt.tr.drain_events(); // logged → subscribers via the tap
    rt.refresh_srcs();
    let to = rt
        .tr
        .status()
        .into_iter()
        .find(|s| s.corr == corr)
        .map(|s| s.to);
    Ok(json!({ "corr": corr, "to": to }))
}

fn cancel(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let corr = log::CorrId(arg_str(args, "corr")?.to_string());
    let now = rt.now();
    rt.tr.cancel(&corr, &mut rt.graph, &mut rt.anim, now)?;
    rt.tr.drain_events();
    rt.refresh_srcs();
    Ok(json!({}))
}

// ---------------------------------------------------------------- capture

fn capture(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let target = arg_str(args, "target")?;
    let path = arg_str(args, "path")?;
    if !path.starts_with('/') {
        return Err(bad_request(format!(
            "path {path:?} must be absolute (the player's cwd isn't yours)"
        )));
    }
    let io = |e: std::io::Error| ApiError {
        code: "io",
        message: format!("writing {path}: {e}"),
        hint: hint("check the directory exists and is writable"),
    };
    // An output (or its main layer): the last composed frame.
    let out_name = target.strip_prefix("out:").or_else(|| {
        target
            .strip_prefix("lay:")
            .and_then(|l| l.strip_suffix(":main"))
    });
    if let Some(name) = out_name {
        let Some(tex) = rt.backend.picture(name) else {
            return Err(ApiError {
                code: "no_such_node",
                message: format!("no output {name:?}"),
                hint: hint("`lp-player ctl state` lists the outputs"),
            });
        };
        rt.gfx.write_png(tex, path).map_err(io)?;
        return Ok(json!({ "path": path, "width": tex.w, "height": tex.h }));
    }
    // A source: its current texture, upright.
    if rt.graph.kind_of(target) == Some(NodeKind::Source) {
        let Some(tex) = rt.host.texture(target) else {
            return Err(ApiError {
                code: "unsupported",
                message: format!("source {target} has no frame yet"),
                hint: hint("wait for `source.ready` (stepped clock: `step` first)"),
            });
        };
        rt.gfx.write_png_source(tex, path).map_err(io)?;
        return Ok(json!({ "path": path, "width": tex.w, "height": tex.h }));
    }
    Err(ApiError {
        code: "no_such_node",
        message: format!("capture target {target:?} is not an output, main layer or source"),
        hint: hint("targets: `out:<name>`, `lay:<name>:main`, or a source id (`ctl state`)"),
    })
}

// ---------------------------------------------------------------- lifecycle

fn stop(rt: &mut Runtime, _: u64, _: &Value) -> Result<Value, ApiError> {
    let instant = rt.stepped();
    let ids = rt.stop_all(instant);
    Ok(json!({ "stopping": ids }))
}

fn quit(rt: &mut Runtime, _: u64, _: &Value) -> Result<Value, ApiError> {
    rt.begin_quit("quit");
    Ok(json!({}))
}

fn step_placeholder(_: &mut Runtime, _: u64, _: &Value) -> Result<Value, ApiError> {
    unreachable!("`step` is handled before the table (deferred reply)")
}

fn step_args(rt: &Runtime, args: &Value) -> Result<Duration, ApiError> {
    if !rt.stepped() {
        return Err(proto::unsupported(
            "step needs the stepped clock".into(),
            "start the player with `lp-player serve --headless --clock stepped`",
        ));
    }
    let ms = arg_f64(args, "ms")?;
    if !(0.0..=600_000.0).contains(&ms) {
        return Err(bad_request("ms must be 0–600000".into()));
    }
    Ok(Duration::from_secs_f64(ms / 1000.0))
}

// ---------------------------------------------------------------- headless

fn headless_err() -> ApiError {
    proto::unsupported(
        "headless.* verbs need the headless backend".into(),
        "start the player with `lp-player serve --headless`",
    )
}

fn add_output(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let hz = opt_f64(args, "hz")?.unwrap_or(60.0) as u32;
    let info = OutputInfo {
        name: arg_str(args, "name")?.to_string(),
        width: arg_f64(args, "width")? as u32,
        height: arg_f64(args, "height")? as u32,
        hz,
        refresh_mhz: hz.saturating_mul(1000),
    };
    let name = info.name.clone();
    let gfx = &rt.gfx;
    rt.backend
        .as_headless_mut()
        .ok_or_else(headless_err)?
        .add(gfx, info)?;
    rt.apply_output_changes();
    Ok(json!({ "id": format!("out:{name}") }))
}

fn remove_output(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let name = arg_str(args, "name")?.to_string();
    let gfx = &rt.gfx;
    rt.backend
        .as_headless_mut()
        .ok_or_else(headless_err)?
        .remove(gfx, &name)?;
    rt.apply_output_changes();
    Ok(json!({}))
}
