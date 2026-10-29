//! The verbs (spec §4.2 "Command API"): generic graph verbs (`create`/`destroy`/`set`/
//! `get`/`animate`), thin recipe verbs (`transition`/`cancel`, `program.*`), queries (`state`/`logs`/
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
use crate::units::{GainSlot, db_to_lin};

type Handler = fn(&mut Runtime, u64, &Value) -> Result<Value, ApiError>;

/// Every verb: name, handler, one-line summary (`hello` lists them).
pub const VERBS: &[(&str, Handler, &str)] = &[
    (
        "hello",
        hello,
        "version, pid, supervisor_pid, restart, capabilities, clock, verbs",
    ),
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
        "program.play",
        program_play,
        "a program plays item {id, index?: 0, keep_pause?} → {corr, path, index}",
    ),
    (
        "program.next",
        program_next,
        "a program's next item {id, keep_pause?} → {corr, path} (null = nothing to do)",
    ),
    (
        "program.prev",
        program_prev,
        "a program's previous item (its history) {id, keep_pause?} → {corr, path}",
    ),
    (
        "program.random",
        program_random,
        "a program's random item {id, keep_pause?} → {corr, path}",
    ),
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
        capture_placeholder,
        "write an output or source texture to PNG {target, path} (replies once written)",
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
    (
        "headless.pointer",
        headless_pointer,
        "a virtual pointer {output, x, y, buttons?} over a headless output (surface pixels)",
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
    if req.cmd == "capture" {
        return capture(rt, client, &req.id, &req.args);
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
    let mut caps = vec!["video", "image", "color", "transition", "program"];
    // Phase 2: scenes play when the worker binary resolves (Task 5) and WE's assets dir does
    // (Task 7 — `player.scene_assets_resolved`), unless synthetic scenes are allowed.
    if rt.scenes_available().is_ok() {
        caps.push("scene");
    }
    // A scene source's `loudness_key` prop (one loudness measurement per audio configuration):
    // the backend sends it only to a player that has it.
    caps.push("scene_loudness_key");
    if rt.backend.kind() == "headless" {
        caps.push("headless");
    }
    if rt.stepped() {
        caps.push("stepped");
    }
    let hwdec = {
        let w = rt.host.render_worker();
        crate::health::hwdec_json(w.is_some(), w.and_then(|w| w.hwdec_interop()))
    };
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "protocol": 1,
        "capabilities": caps,
        "clock": rt.clock_name(),
        "backend": rt.backend.kind(),
        "verbs": verb_names(),
        // Task 16: `pid` is this compositor (the supervisor's child when supervised).
        "supervisor_pid": rt.supervised.as_ref().map(|s| s.pid),
        "restart": rt.restart_event,
        // which optional pieces work here, and why not (crate::health) — the backend's warning icons
        "health": {
            "effects": crate::health::effects_json(rt.cat.dir(), rt.cat.ids().len()),
            "vram": crate::health::vram_cached(),
            "hwdec_interop": hwdec,
            "scenes": crate::health::scenes_json(rt.scenes_available()),
        },
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
        // Phase 3: every program (`recipes::program`)
        "programs": rt.programs.status(),
        "clock": {"mode": rt.clock_name(), "now_ms": rt.now().as_secs_f64() * 1000.0},
        "outputs": outputs,
        "backend": rt.backend.kind(),
        "sources": rt.host.ids(),
        "parked": rt.parked.as_ref().map(|p| p.id.clone()),
        // Phase 2 Task 5: every scene source's worker (the `workers` probe's entries).
        "workers": rt.host.workers_info(),
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
        "program" => Ok(NodeKind::Program),
        "output" => Err(proto::unsupported(
            "outputs come from the compositor (Wayland) or headless.add_output".into(),
            "headless: `liascape-player ctl headless.add_output '{\"name\":\"VIRTUAL-3\",\"width\":\
             1920,\"height\":1080,\"hz\":60}'`",
        )),
        "player" => Err(proto::unsupported(
            "`player` is a singleton".into(),
            "set its properties instead (`player.debug`)",
        )),
        other => Err(bad_request(format!(
            "kind {other:?}: expected source|layer|effect|program"
        ))),
    }
}

fn create(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let kind = parse_kind(arg_str(args, "kind")?)?;
    let id = opt_str(args, "id")?.map(str::to_string);
    let mut props = match args.get("props") {
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
    if kind == NodeKind::Program && !props.contains_key("seed") {
        // a program's default seed: the wall clock at create (tests pin it)
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(1);
        props.insert("seed".into(), json!(nanos));
    }
    let id = rt.graph.create(kind, id, props)?;
    if kind == NodeKind::Program {
        let acts = rt.programs.configure(&id, &mut rt.graph);
        rt.run_program_actions(acts);
    }
    Ok(json!({ "id": id }))
}

/// R49 for every way an effect id gets in (`transition`, `create`, `set`): a non-empty
/// string must name a catalogue effect.
fn check_effect(rt: &Runtime, v: &Value) -> Result<(), ApiError> {
    match v.as_str() {
        Some(eid) if !eid.is_empty() && !rt.cat.ids().iter().any(|i| i == eid) => Err(ApiError {
            code: "no_such_effect",
            message: format!("effect_id {eid:?} is not in the catalogue"),
            hint: hint("`liascape-player ctl effects` lists every id; `effect_id: null` is a cut"),
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
                "headless: `liascape-player ctl headless.remove_output '{\"name\":\"VIRTUAL-2\"}'`",
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
    if rt.graph.kind_of(id) == Some(NodeKind::Program) {
        // the rotation stops; what plays stays on screen
        let acts = rt.programs.destroy(id);
        rt.run_program_actions(acts);
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
    // Phase 3: a program's settings are live — the program re-reads its node
    for t in &targets {
        if rt.graph.kind_of(t) == Some(NodeKind::Program) {
            let acts = rt.programs.configure(t, &mut rt.graph);
            rt.run_program_actions(acts);
        }
    }
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
    // M13 (final review): a broadcast alias that matches nothing right now is a broadcast
    // to nobody — `{targets: []}`, exactly like `set` — after the same schema check.
    if targets.is_empty()
        && let Some(kind) = wildcard_kind(rt, node_ref)
    {
        let numeric = prop.starts_with("gain.")
            || props::schema_for(kind, prop).is_some_and(|d| matches!(d.ty, PropType::F64));
        if !numeric {
            props::validate_value(kind, prop, &PropValue::F64(to), true)?;
            return Err(ApiError {
                code: "bad_type",
                message: format!(
                    "{node_ref}.{prop} is not a numeric property; only numbers animate"
                ),
                hint: hint("animate numbers and gain slots"),
            });
        }
        crate::graph::Graph::typed_for_set(kind, prop, &json!(to))?;
        return Ok(json!({ "corr": log::new_corr("an"), "targets": [] }));
    }
    if targets.is_empty() {
        return Err(ApiError {
            code: "no_such_node",
            message: format!("no such node: {node_ref:?}"),
            hint: hint("run `liascape-player ctl state` to see the live graph"),
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
    // a user setting ramps on the unpaused clock (`Runtime::setting_anim`): it lands while paused
    let setting = prop
        .strip_prefix("gain.")
        .and_then(|s| s.parse::<GainSlot>().ok())
        .is_some_and(|s| s.is_setting());
    let now = if setting { rt.base_now() } else { rt.now() };
    for (id, start) in targets.iter().zip(starts) {
        let a = Animation {
            target: PropPath(format!("{id}.{prop}")),
            from: start,
            to,
            start: now,
            duration: Duration::from_secs_f64(dur / 1000.0),
            curve,
            unit,
            corr: Some(corr.clone()),
        };
        if setting {
            rt.anim.cancel_target(&a.target);
            rt.setting_anim.add(a);
        } else {
            rt.setting_anim.cancel_target(&a.target);
            rt.anim.add(a);
        }
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
    let mut req: TransitionReq = serde_json::from_value(args.clone()).map_err(|e| {
        bad_request(format!(
            "transition args: {e} (fields: outputs, to, effect_id?, params?, duration_ms?, \
             method? full-live|reveal|frozen, align? now|end)"
        ))
    })?;
    if let Some(eid) = &req.effect_id {
        check_effect(rt, &json!(eid))?;
    }
    req.origin = crate::recipes::transition::ORIGIN_API.to_string();
    // I4 (final review): no output at all (R60 parked) — accepted, B replaces the parked
    // wallpaper (`Runtime::transition_parked`); never refused, so a rotation can't spin.
    if req.outputs.starts_with("out:") && rt.graph.ids_of(NodeKind::Output).is_empty() {
        let (corr, to) = rt.transition_parked(req)?;
        return Ok(json!({ "corr": corr, "to": to, "parked": true }));
    }
    let now = rt.now();
    let corr = rt.tr.start(req, &mut rt.graph, &mut rt.anim, now)?;
    rt.stash_tr_events(); // logged → subscribers via the tap; programs see them next tick
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
    rt.stash_tr_events();
    rt.refresh_srcs();
    Ok(json!({}))
}

// ---------------------------------------------------------------- programs (Phase 3)

fn opt_bool(args: &Value, key: &str) -> Result<bool, ApiError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(other) => Err(bad_request(format!(
            "args.{key} must be a bool, got {other}"
        ))),
    }
}

/// `program.<verb> {id, index?, keep_pause?}` — a thin recipe over `transition`: the
/// program picks the item and the effect, the transition recipe switches.
fn program_verb(rt: &mut Runtime, verb: &str, args: &Value) -> Result<Value, ApiError> {
    let id = arg_str(args, "id")?.to_string();
    let keep_pause = opt_bool(args, "keep_pause")?;
    let index = match opt_f64(args, "index")? {
        Some(i) if i < 0.0 || i.fract() != 0.0 => {
            return Err(bad_request(format!(
                "args.index {i}: a non-negative integer"
            )));
        }
        Some(i) => Some(i as usize),
        None => None,
    };
    let now = rt.now();
    let cat = &rt.cat;
    let acts = rt
        .programs
        .verb(verb, &id, index, keep_pause, &rt.graph, now, &|e| {
            cat.defaults(e)
        })?;
    let out = rt.run_program_actions(acts);
    Ok(rt.programs.verb_reply(&id, out))
}

fn program_play(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    program_verb(rt, "play", args)
}

fn program_next(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    program_verb(rt, "next", args)
}

fn program_prev(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    program_verb(rt, "prev", args)
}

fn program_random(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    program_verb(rt, "random", args)
}

// ---------------------------------------------------------------- capture

/// `capture`: the GPU readback is started here, on the loop (`Gfx::start_read_back`, never
/// waited for); the runtime maps it once the copy is done and `lia-capture` encodes and writes
/// it (`api::capture`). The reply is deferred until the file is complete (`None`; the runtime
/// answers it, the client's later requests wait — per-client FIFO, like `step`). Errors (bad
/// target/path, no frame) reply at once.
fn capture(
    rt: &mut Runtime,
    client: u64,
    id: &Value,
    args: &Value,
) -> Option<Result<Value, ApiError>> {
    match capture_start(rt, args) {
        Ok((path, readback)) => {
            rt.capture.submit(client, id.clone(), path.into(), readback);
            rt.pump_captures();
            None
        }
        Err(e) => Some(Err(e)),
    }
}

/// `capture`'s target resolved and its readback started (an output or its main layer: the
/// last composed frame, written top-down; a source: its current texture, already upright).
fn capture_start(
    rt: &mut Runtime,
    args: &Value,
) -> Result<(String, crate::gfx::PendingReadback), ApiError> {
    let target = arg_str(args, "target")?;
    let path = arg_str(args, "path")?;
    if !path.starts_with('/') {
        return Err(bad_request(format!(
            "path {path:?} must be absolute (the player's cwd isn't yours)"
        )));
    }
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
                hint: hint("`liascape-player ctl state` lists the outputs"),
            });
        };
        let spare = rt.capture.take_spare();
        return Ok((path.to_string(), rt.gfx.start_read_back(tex, true, spare)));
    }
    if rt.graph.kind_of(target) == Some(NodeKind::Source) {
        let Some(tex) = rt.host.texture(target) else {
            return Err(ApiError {
                code: "unsupported",
                message: format!("source {target} has no frame yet"),
                hint: hint("wait for `source.ready` (stepped clock: `step` first)"),
            });
        };
        let spare = rt.capture.take_spare();
        return Ok((path.to_string(), rt.gfx.start_read_back(tex, false, spare)));
    }
    Err(ApiError {
        code: "no_such_node",
        message: format!("capture target {target:?} is not an output, main layer or source"),
        hint: hint("targets: `out:<name>`, `lay:<name>:main`, or a source id (`ctl state`)"),
    })
}

fn capture_placeholder(_: &mut Runtime, _: u64, _: &Value) -> Result<Value, ApiError> {
    unreachable!("`capture` is handled before the table (deferred reply)")
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
            "start the player with `liascape-player serve --headless --clock stepped`",
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
        "start the player with `liascape-player serve --headless`",
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

/// Phase 2 Task 7: a virtual pointer over a headless output (what the Wayland backend's
/// pointer events do) — `out:<c>.pointer` and every scene shown there get it at once.
fn headless_pointer(rt: &mut Runtime, _: u64, args: &Value) -> Result<Value, ApiError> {
    let name = arg_str(args, "output")?.to_string();
    let (x, y) = (arg_f64(args, "x")?, arg_f64(args, "y")?);
    let buttons = opt_f64(args, "buttons")?.unwrap_or(0.0).max(0.0) as u32;
    rt.backend
        .as_headless_mut()
        .ok_or_else(headless_err)?
        .pointer(&name, x, y, buttons)?;
    let scenes = rt.pointer_events();
    Ok(json!({ "scenes": scenes }))
}
