//! The transition recipe (spec §4.3 "Transition A→B"; §10 Transitions — the three
//! `TransitionMethod`s and "audio follows the picture"). A state machine per request:
//!
//! ```text
//! start() ─▶ Scheduled ─▶ WaitingReady ─▶ WaitingStart ─▶ Running ─▶ Handoff ─▶ Done
//!            (B created     (B's Ready)     (align instant;  (effect     (layers→B, fx +
//!             paused, −96)                   snapshot ready)  animating)  A released)
//!   pre-Running: superseded / cancelled / B failed → B destroyed, A restored exactly
//!   Running:     a new start commits it (→ Handoff); cancel / B failed → snap back to A
//! ```
//!
//! It only ever issues graph `create`/`set`/`destroy` and `Animator::add` — nothing here
//! renders or talks to a live source (`SourceHost` and the compositor do that). See
//! `.claude/rules/player-core.md` § Transition recipe for the rules (methods' audio,
//! align, interrupt/cancel/failure, shared A) and `docs/player/invariants.md` #5/#6.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::anim::{AnimUnit, Animation, Animator, Curve, PropPath};
use crate::graph::{ApiError, Graph, NodeKind, PropValue};
use crate::log::{self, CorrId, Level};
use crate::sources::SourceEvent;
use crate::units::{GainSlot, SILENT_DB, db_to_lin};

/// Every audio start/stop at a hold boundary (and every commit/snap-back ramp) takes this
/// long (invariant #4: ≤ 30 ms).
pub const ANTICLICK: Duration = Duration::from_millis(30);
/// B that hasn't produced its first frame by then fails the transition (never park).
pub const READY_TIMEOUT: Duration = Duration::from_secs(10);
/// reveal/frozen `align: end` on a shared, *looping* A (no `Ended` comes): the snapshot is
/// taken once A's iteration has at most this long left — its last frame is showing.
const LAST_FRAME_WINDOW_S: f64 = 0.05;

/// Which sides hold their frame during the effect (spec §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    /// Both play; equal-power crossfade.
    #[default]
    FullLive,
    /// A holds (silent), B plays with its gain rising sin(x·π/2) over the effect.
    Reveal,
    /// A holds, B holds its first frame; silent through the effect; B starts at the end.
    Frozen,
}

/// When the effect runs relative to A.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    /// As soon as B is ready.
    #[default]
    Now,
    /// At A's end: full-live *ends* there, reveal/frozen/cut *start* there.
    End,
}

/// One transition request (the command API's `transition` verb, Task 12).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionReq {
    /// Output alias (`out:*`, `out:DP-1`, …).
    pub outputs: String,
    /// B's `Source` create props, incl. `path` (or `kind: "color"` + `color`).
    pub to: Map<String, Value>,
    /// A catalogue effect id; `None` = a cut (30 ms ramp down A, swap, 30 ms ramp up B).
    #[serde(default)]
    pub effect_id: Option<String>,
    #[serde(default)]
    pub params: Map<String, Value>,
    #[serde(default)]
    pub duration_ms: u32,
    #[serde(default)]
    pub method: Method,
    #[serde(default)]
    pub align: Align,
}

/// Where a transition is in its life (module doc diagram).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Scheduled,
    WaitingReady,
    WaitingStart,
    Running,
    Handoff,
    Done,
}

impl Phase {
    fn pre_running(self) -> bool {
        matches!(
            self,
            Phase::Scheduled | Phase::WaitingReady | Phase::WaitingStart
        )
    }
}

/// One outbox entry (R37): written to the event log too, forwarded to API subscribers by
/// the runtime. Serializes flat: `{"corr", "at_ms", "event": "transition.…", …fields}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TransitionEvent {
    pub corr: CorrId,
    /// The player clock when it happened.
    pub at_ms: f64,
    #[serde(flatten)]
    pub kind: TransitionEventKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event")]
pub enum TransitionEventKind {
    #[serde(rename = "transition.scheduled")]
    Scheduled {
        outputs: Vec<String>,
        /// B's source node id.
        to: String,
        path: String,
        method: Method,
        align: Align,
        effect_id: Option<String>,
        duration_ms: u32,
    },
    #[serde(rename = "transition.started")]
    Started {
        method: Method,
        effect_id: Option<String>,
        /// The effect's own start instant (= `at_ms`, except `align: end` full-live may
        /// start up to one tick in the past so `progress` reaches 1 exactly at A's end).
        start_ms: f64,
    },
    /// B is the layers' content now; A's removal is scheduled.
    #[serde(rename = "transition.handoff")]
    Handoff { to: String, from: Vec<String> },
    #[serde(rename = "transition.done")]
    Done { to: String },
    #[serde(rename = "transition.cancelled")]
    Cancelled { reason: String },
    #[serde(rename = "transition.failed")]
    Failed { path: String, reason: String },
}

impl TransitionEventKind {
    pub fn name(&self) -> &'static str {
        match self {
            TransitionEventKind::Scheduled { .. } => "transition.scheduled",
            TransitionEventKind::Started { .. } => "transition.started",
            TransitionEventKind::Handoff { .. } => "transition.handoff",
            TransitionEventKind::Done { .. } => "transition.done",
            TransitionEventKind::Cancelled { .. } => "transition.cancelled",
            TransitionEventKind::Failed { .. } => "transition.failed",
        }
    }
}

/// A live transition, for `state`/probes/tests.
#[derive(Debug, Clone, Serialize)]
pub struct TransitionStatus {
    pub corr: CorrId,
    pub phase: Phase,
    pub method: Method,
    pub outputs: Vec<String>,
    /// B.
    pub to: String,
    /// The outgoing sources (one per distinct A).
    pub from: Vec<String>,
    /// Sources this transition keeps paused on purpose: a pending B, held A's, a frozen
    /// B, snapshots.
    pub held: Vec<String>,
}

/// What the recipe changed on an A, for exact restoration (cancel/failure before
/// handoff). Only the first change of each is recorded.
#[derive(Debug, Default)]
struct Orig {
    looped: Option<bool>,
    paused: Option<bool>,
    gains: Vec<(&'static str, f64)>,
}

/// One distinct outgoing source and the requested layers that show it (R34).
#[derive(Debug)]
struct Side {
    /// `None`: those layers showed nothing.
    a: Option<String>,
    layers: Vec<String>,
    /// Still shown by a layer outside the request: never paused, ramped, loop-changed or
    /// destroyed by this transition (its audio follows its picture elsewhere).
    shared: bool,
    /// reveal/frozen: the `snapshot` source holding A's picture (A itself, when not
    /// shared, is ramped silent and paused behind it).
    held: Option<String>,
    fx: Option<String>,
    orig: Orig,
}

struct Tr {
    corr: CorrId,
    method: Method,
    align: Align,
    effect_id: Option<String>,
    params: Map<String, Value>,
    dur: Duration,
    outputs: Vec<String>,
    b: String,
    b_path: String,
    sides: Vec<Side>,
    /// The side whose A drives `align: end` (first requested output's).
    lead: Option<usize>,
    phase: Phase,
    created: Duration,
    t0: Duration,
    /// reveal/frozen: when the held A's are paused (after their anti-click ramp).
    pause_at: Option<Duration>,
    /// cut: when the picture swaps.
    swap_at: Option<Duration>,
    /// Handoff → Done once this has passed (and A's grave is empty).
    settle_until: Duration,
    // `align: end` tracking of the lead A.
    /// Earliest estimate of A's iteration end (player-clock seconds): every observation
    /// `now + (duration − time_pos)/speed` is ≥ the true end (time_pos lags), so the
    /// minimum is the tightest.
    end_est: Option<f64>,
    /// A's frame interval in media seconds (smallest positive `time_pos` step seen).
    frame_dt: Option<f64>,
    last_tp: Option<f64>,
    last_speed: Option<f64>,
    wrapped: bool,
    skip_iteration: bool,
    evaluated: bool,
    snap_pending: bool,
}

impl Tr {
    fn lead_a(&self) -> Option<&str> {
        self.lead.and_then(|i| self.sides[i].a.as_deref())
    }
}

/// A source waiting to be destroyed once its ramp to silence is over.
struct Grave {
    id: String,
    at: Duration,
    corr: CorrId,
    outputs: Vec<String>,
}

enum Outcome {
    Cancelled(&'static str),
    Failed(String),
}

/// Every in-flight transition, the graveyard, and the event outbox.
#[derive(Default)]
pub struct Transitions {
    active: Vec<Tr>,
    graves: Vec<Grave>,
    /// Sources currently holding their end (`Ended` seen, not re-armed) → time_pos then.
    ended: BTreeMap<String, f64>,
    outbox: Vec<TransitionEvent>,
    prev_now: Duration,
}

fn path(id: &str, prop: &str) -> PropPath {
    PropPath(format!("{id}.{prop}"))
}

fn get_str(g: &Graph, id: &str, prop: &str) -> String {
    match g.get(&path(id, prop)) {
        Ok(PropValue::Str(s)) => s,
        _ => String::new(),
    }
}

fn get_f64(g: &Graph, id: &str, prop: &str) -> Option<f64> {
    match g.get(&path(id, prop)) {
        Ok(PropValue::F64(f)) => Some(f),
        Ok(PropValue::I64(i)) => Some(i as f64),
        _ => None,
    }
}

fn get_bool(g: &Graph, id: &str, prop: &str) -> bool {
    matches!(g.get(&path(id, prop)), Ok(PropValue::Bool(true)))
}

fn is_source(g: &Graph, id: &str) -> bool {
    g.kind_of(id) == Some(NodeKind::Source)
}

fn gain_db(g: &Graph, id: &str, slot: &str) -> f64 {
    get_f64(g, id, &format!("gain.{slot}")).unwrap_or(0.0)
}

/// No timeline to align to: an image, a colour, a snapshot, or no known duration.
fn is_still(g: &Graph, id: &str) -> bool {
    matches!(
        get_str(g, id, "kind").as_str(),
        "image" | "color" | "snapshot"
    ) || get_f64(g, id, "duration").unwrap_or(0.0) <= 0.0
}

fn secs(d: Duration) -> f64 {
    d.as_secs_f64()
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Set one property, logging (never panicking on) a failure — e.g. a layer whose output
/// was unplugged mid-transition.
fn gset(g: &mut Graph, corr: &CorrId, id: &str, prop: &str, v: PropValue) {
    if let Err(e) = g.set(&path(id, prop), v) {
        log::event(
            "transition",
            Level::Warn,
            "transition.graph_error",
            Some(corr.clone()),
            json!({ "path": format!("{id}.{prop}"), "error": e.to_string() }),
        );
    }
}

/// Animate `id.gain.<slot>` in linear amplitude (`AnimUnit::GainLinear` → emits dB).
#[allow(clippy::too_many_arguments)]
fn anim_gain(
    anim: &mut Animator,
    corr: &CorrId,
    id: &str,
    slot: &str,
    from: f64,
    to: f64,
    start: Duration,
    dur: Duration,
    curve: Curve,
) {
    anim.add(Animation {
        target: path(id, &format!("gain.{slot}")),
        from,
        to,
        start,
        duration: dur,
        curve,
        unit: AnimUnit::GainLinear,
        corr: Some(corr.clone()),
    });
}

/// Ramp a gain slot from its current value to `to_db` (linear amplitude). Always added,
/// so it supersedes whatever was animating that slot.
#[allow(clippy::too_many_arguments)]
fn ramp_slot(
    g: &Graph,
    anim: &mut Animator,
    corr: &CorrId,
    id: &str,
    slot: &str,
    to_db: f64,
    start: Duration,
    dur: Duration,
) {
    let from = db_to_lin(gain_db(g, id, slot));
    anim_gain(
        anim,
        corr,
        id,
        slot,
        from,
        db_to_lin(to_db),
        start,
        dur,
        Curve::Linear,
    );
}

/// Destroy a node and drop every animation the recipe may have on it.
fn destroy_node(g: &mut Graph, anim: &mut Animator, id: &str) {
    for slot in GainSlot::ALL {
        anim.cancel_target(&path(id, &format!("gain.{}", slot.as_str())));
    }
    anim.cancel_target(&path(id, "progress"));
    let _ = g.destroy(id);
}

/// Is `id` shown by any layer (directly, or as either side of the layer's effect),
/// skipping the layers in `except`?
fn shown_outside(g: &Graph, id: &str, except: &[String]) -> bool {
    g.ids_of(NodeKind::Layer).iter().any(|l| {
        if except.contains(l) {
            return false;
        }
        let c = get_str(g, l, "content");
        c == id
            || (g.kind_of(&c) == Some(NodeKind::Effect)
                && (get_str(g, &c, "from") == id || get_str(g, &c, "to") == id))
    })
}

fn api_err(code: &'static str, message: String) -> ApiError {
    ApiError {
        code,
        message,
        hint: "see .claude/rules/player-core.md \u{a7} Transition recipe; `lp-player ctl state` \
               shows the live graph"
            .to_string(),
    }
}

fn resolve_outputs(g: &Graph, alias: &str) -> Result<Vec<String>, ApiError> {
    let mut ids = g.resolve(alias);
    if ids.is_empty() {
        return Err(api_err(
            "no_such_node",
            format!("outputs {alias:?} resolves to no output"),
        ));
    }
    if let Some(bad) = ids
        .iter()
        .find(|id| g.kind_of(id) != Some(NodeKind::Output))
    {
        return Err(api_err(
            "unsupported",
            format!("outputs {alias:?} resolves to {bad:?}, which is not an output"),
        ));
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn main_layer(output: &str) -> String {
    format!("lay:{}:main", output.strip_prefix("out:").unwrap_or(output))
}

/// One side per distinct A on the requested outputs (R34).
fn build_sides(g: &Graph, outputs: &[String]) -> Vec<Side> {
    let layers: Vec<String> = outputs
        .iter()
        .map(|o| main_layer(o))
        .filter(|l| g.kind_of(l).is_some())
        .collect();
    let mut sides: Vec<Side> = Vec::new();
    for l in &layers {
        let connector = l
            .strip_prefix("lay:")
            .and_then(|s| s.strip_suffix(":main"))
            .unwrap_or("");
        let a = g.resolve(&format!("cur:{connector}")).into_iter().next();
        match sides.iter_mut().find(|s| s.a == a) {
            Some(s) => s.layers.push(l.clone()),
            None => sides.push(Side {
                a,
                layers: vec![l.clone()],
                shared: false,
                held: None,
                fx: None,
                orig: Orig::default(),
            }),
        }
    }
    for s in &mut sides {
        s.shared = s.a.as_deref().is_some_and(|a| shown_outside(g, a, &layers));
    }
    sides
}

fn note_gain(side: &mut Side, g: &Graph, a: &str, slot: &'static str) {
    if !side.orig.gains.iter().any(|(s, _)| *s == slot) {
        side.orig.gains.push((slot, gain_db(g, a, slot)));
    }
}

impl Transitions {
    pub fn new() -> Transitions {
        Transitions::default()
    }

    /// Accept a request: validate it, create B (paused at its start, `gain.xfade` = −96,
    /// shared by every requested output), resolve any in-flight transition on an
    /// overlapping output (R35/R36: pre-Running → superseded, A restored; Running →
    /// committed, B becomes the new A), and capture A per output. Nothing visible changes
    /// until B is ready.
    pub fn start(
        &mut self,
        req: TransitionReq,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) -> Result<CorrId, ApiError> {
        let outputs = resolve_outputs(g, &req.outputs)?;
        if req.effect_id.as_deref() == Some("") {
            return Err(api_err(
                "out_of_range",
                "effect_id must be a catalogue id, or null for a cut".to_string(),
            ));
        }
        let kind = req.to.get("kind").and_then(Value::as_str).unwrap_or("");
        let b_path = req
            .to
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if kind == "snapshot" {
            return Err(api_err(
                "unsupported",
                "a transition's target can't be a snapshot source".to_string(),
            ));
        }
        if kind != "color" && b_path.is_empty() {
            return Err(api_err(
                "out_of_range",
                "to.path must name a file (or set to.kind = \"color\")".to_string(),
            ));
        }
        let mut props = req.to.clone();
        props.insert("paused".into(), json!(true));
        props.insert("gain.xfade".into(), json!(SILENT_DB));
        let b = g.create(NodeKind::Source, None, props)?;
        let corr = log::new_corr("tr");

        // Never park, never stack (invariant #6).
        let mut i = 0;
        while i < self.active.len() {
            let overlaps = self.active[i].outputs.iter().any(|o| outputs.contains(o));
            let phase = self.active[i].phase;
            if overlaps && phase.pre_running() {
                let mut tr = self.active.remove(i);
                self.abort(&mut tr, g, anim, now, Outcome::Cancelled("superseded"));
            } else if overlaps && phase == Phase::Running {
                let mut tr = self.active.remove(i);
                self.commit(&mut tr, g, anim, now);
                self.active.insert(i, tr);
                i += 1;
            } else {
                i += 1;
            }
        }

        let sides = build_sides(g, &outputs);
        let lead = sides.iter().position(|s| s.a.is_some());
        let mut tr = Tr {
            corr: corr.clone(),
            method: req.method,
            align: req.align,
            effect_id: req.effect_id.clone(),
            params: req.params.clone(),
            dur: Duration::from_millis(req.duration_ms as u64),
            outputs: outputs.clone(),
            b: b.clone(),
            b_path: b_path.clone(),
            sides,
            lead,
            phase: Phase::Scheduled,
            created: now,
            t0: now,
            pause_at: None,
            swap_at: None,
            settle_until: now,
            end_est: None,
            frame_dt: None,
            last_tp: None,
            last_speed: None,
            wrapped: false,
            skip_iteration: false,
            evaluated: false,
            snap_pending: false,
        };
        // align: end — A's current iteration is its last (unless shared, R34, or a still).
        if req.align == Align::End
            && let Some(li) = lead
        {
            let side = &mut tr.sides[li];
            if let Some(a) = side.a.clone()
                && !side.shared
                && !is_still(g, &a)
                && get_bool(g, &a, "loop")
            {
                side.orig.looped = Some(true);
                gset(g, &corr, &a, "loop", PropValue::Bool(false));
            }
        }
        self.emit(
            &corr,
            now,
            TransitionEventKind::Scheduled {
                outputs,
                to: b,
                path: b_path,
                method: req.method,
                align: req.align,
                effect_id: req.effect_id,
                duration_ms: req.duration_ms,
            },
        );
        self.active.push(tr);
        Ok(corr)
    }

    /// Cancel an in-flight transition (R35): before Running → B destroyed and A restored
    /// exactly; Running → snap back to A (A unpaused, its gains back over 30 ms, B ramped
    /// to silence then destroyed). After handoff there is nothing to cancel.
    pub fn cancel(
        &mut self,
        corr: &CorrId,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) -> Result<(), ApiError> {
        let Some(i) = self.active.iter().position(|t| &t.corr == corr) else {
            return Err(api_err(
                "no_such_node",
                format!("no in-flight transition {:?}", corr.0),
            ));
        };
        match self.active[i].phase {
            p if p.pre_running() => {
                let mut tr = self.active.remove(i);
                self.abort(&mut tr, g, anim, now, Outcome::Cancelled("cancelled"));
                Ok(())
            }
            Phase::Running => {
                let mut tr = self.active.remove(i);
                self.snap_back(&mut tr, g, anim, now, Outcome::Cancelled("cancelled"));
                Ok(())
            }
            _ => Err(api_err(
                "unsupported",
                format!(
                    "transition {:?} already handed off to {}; nothing to cancel",
                    corr.0, self.active[i].b
                ),
            )),
        }
    }

    /// Advance every transition. Call once per loop iteration, after `SourceHost::update`,
    /// with that iteration's source events and the same `now` the animator ticked with.
    pub fn tick(
        &mut self,
        g: &mut Graph,
        anim: &mut Animator,
        events: &[(String, SourceEvent)],
        now: Duration,
    ) {
        for (id, ev) in events {
            match ev {
                SourceEvent::Ended => {
                    let tp = get_f64(g, id, "time_pos").unwrap_or(0.0);
                    self.ended.insert(id.clone(), tp);
                }
                SourceEvent::Ready => {
                    self.ended.remove(id);
                }
                SourceEvent::Position(t) => {
                    if self.ended.get(id).is_some_and(|e| *t + 1e-3 < *e) {
                        self.ended.remove(id);
                    }
                }
                SourceEvent::Error { .. } => {}
            }
        }
        self.ended.retain(|id, _| is_source(g, id));
        self.bury(g, anim, now);

        let mut i = 0;
        while i < self.active.len() {
            let mut tr = self.active.remove(i);
            if self.step(&mut tr, g, anim, events, now) {
                self.active.insert(i, tr);
                i += 1;
            }
        }
        self.prev_now = now;
    }

    /// Drain the event outbox (R37).
    pub fn drain_events(&mut self) -> Vec<TransitionEvent> {
        std::mem::take(&mut self.outbox)
    }

    /// Every live transition.
    pub fn status(&self) -> Vec<TransitionStatus> {
        self.active
            .iter()
            .map(|t| {
                let mut held: Vec<String> = t.sides.iter().filter_map(|s| s.held.clone()).collect();
                let b_held = t.phase.pre_running()
                    || (t.phase == Phase::Running
                        && (t.method == Method::Frozen || t.effect_id.is_none()));
                if b_held {
                    held.push(t.b.clone());
                }
                if t.phase == Phase::Running
                    && t.effect_id.is_some()
                    && t.method != Method::FullLive
                {
                    held.extend(
                        t.sides
                            .iter()
                            .filter(|s| !s.shared)
                            .filter_map(|s| s.a.clone()),
                    );
                }
                TransitionStatus {
                    corr: t.corr.clone(),
                    phase: t.phase,
                    method: t.method,
                    outputs: t.outputs.clone(),
                    to: t.b.clone(),
                    from: t.sides.iter().filter_map(|s| s.a.clone()).collect(),
                    held,
                }
            })
            .collect()
    }

    fn emit(&mut self, corr: &CorrId, now: Duration, kind: TransitionEventKind) {
        let ev = TransitionEvent {
            corr: corr.clone(),
            at_ms: ms(now),
            kind,
        };
        let mut fields = serde_json::to_value(&ev)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        fields.remove("event");
        fields.remove("corr");
        let level = match ev.kind {
            TransitionEventKind::Failed { .. } => Level::Warn,
            _ => Level::Info,
        };
        log::event(
            "transition",
            level,
            ev.kind.name(),
            Some(corr.clone()),
            Value::Object(fields),
        );
        self.outbox.push(ev);
    }

    fn emit_outcome(&mut self, tr: &Tr, now: Duration, outcome: Outcome) {
        let kind = match outcome {
            Outcome::Cancelled(r) => TransitionEventKind::Cancelled {
                reason: r.to_string(),
            },
            Outcome::Failed(reason) => TransitionEventKind::Failed {
                path: tr.b_path.clone(),
                reason,
            },
        };
        self.emit(&tr.corr, now, kind);
    }

    /// Destroy every grave whose ramp is over (unless something shows it again).
    fn bury(&mut self, g: &mut Graph, anim: &mut Animator, now: Duration) {
        let graves = std::mem::take(&mut self.graves);
        for gr in graves {
            if gr.at > now {
                self.graves.push(gr);
            } else if is_source(g, &gr.id) && !shown_outside(g, &gr.id, &[]) {
                destroy_node(g, anim, &gr.id);
            }
        }
    }

    fn graves_on(&self, outputs: &[String]) -> bool {
        self.graves
            .iter()
            .any(|gr| gr.outputs.iter().any(|o| outputs.contains(o)))
    }

    /// One transition's step; `false` = it's over (drop it).
    fn step(
        &mut self,
        tr: &mut Tr,
        g: &mut Graph,
        anim: &mut Animator,
        events: &[(String, SourceEvent)],
        now: Duration,
    ) -> bool {
        if tr.phase == Phase::Scheduled {
            tr.phase = Phase::WaitingReady;
        }
        if tr.phase.pre_running() || tr.phase == Phase::Running {
            let failure = if !is_source(g, &tr.b) {
                Some(format!("{}: source destroyed", tr.b))
            } else {
                events.iter().find_map(|(id, e)| match e {
                    SourceEvent::Error { reason } if *id == tr.b => Some(reason.clone()),
                    _ => None,
                })
            };
            if let Some(reason) = failure {
                if tr.phase == Phase::Running {
                    self.snap_back(tr, g, anim, now, Outcome::Failed(reason));
                } else {
                    self.abort(tr, g, anim, now, Outcome::Failed(reason));
                }
                return false;
            }
        }
        if tr.phase.pre_running() {
            track_lead(tr, g, now);
        }

        if tr.phase == Phase::WaitingReady {
            let ready = get_bool(g, &tr.b, "ready")
                || events
                    .iter()
                    .any(|(id, e)| *id == tr.b && *e == SourceEvent::Ready);
            if !ready {
                if now.saturating_sub(tr.created) >= READY_TIMEOUT {
                    let reason = format!(
                        "{}: no first frame within {} s",
                        tr.b_path,
                        READY_TIMEOUT.as_secs()
                    );
                    self.abort(tr, g, anim, now, Outcome::Failed(reason));
                    return false;
                }
                return true;
            }
            tr.phase = Phase::WaitingStart;
            tr.wrapped = false;
        }

        if tr.phase == Phase::WaitingStart {
            // A commit's ramp-outs on these outputs finish first: never three audible.
            if self.graves_on(&tr.outputs) {
                return true;
            }
            if tr.snap_pending {
                let ready = tr
                    .sides
                    .iter()
                    .filter_map(|s| s.held.as_deref())
                    .all(|h| get_bool(g, h, "ready"));
                if !ready {
                    return true;
                }
                tr.snap_pending = false;
                self.begin_running(tr, g, anim, now, now);
            } else {
                let Some(t0) = self.start_instant(tr, g, now) else {
                    return true;
                };
                // Only a picture that can still change needs a copy: not a still
                // (image/colour), not an A that has ended (it holds its last frame).
                let to_copy: Vec<usize> = if tr.effect_id.is_some() && tr.method != Method::FullLive
                {
                    (0..tr.sides.len())
                        .filter(|&i| {
                            tr.sides[i]
                                .a
                                .as_deref()
                                .is_some_and(|a| !is_still(g, a) && !self.ended.contains_key(a))
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                if !to_copy.is_empty() {
                    // reveal/frozen hold A's picture as a still copy of the frame on
                    // screen now ("held where it is"). Pausing a source doesn't freeze
                    // its texture: a paused mpv presents its queued frames late
                    // (measured: 2–3 frames, ~100 ms after the pause, time_pos already
                    // frozen). A shared A keeps playing elsewhere anyway (R34). Stills
                    // and ended A's can't change and are held as themselves. The
                    // effect starts once the copies exist (next iteration).
                    for i in to_copy {
                        let side = &mut tr.sides[i];
                        if let Some(a) = side.a.clone() {
                            let mut p = Map::new();
                            p.insert("kind".into(), json!("snapshot"));
                            p.insert("of".into(), json!(a));
                            p.insert("paused".into(), json!(true));
                            match g.create(NodeKind::Source, None, p) {
                                Ok(id) => side.held = Some(id),
                                Err(e) => log::event(
                                    "transition",
                                    Level::Warn,
                                    "transition.graph_error",
                                    Some(tr.corr.clone()),
                                    json!({ "create": "snapshot", "error": e.to_string() }),
                                ),
                            }
                        }
                    }
                    tr.snap_pending = true;
                    return true;
                }
                self.begin_running(tr, g, anim, t0, now);
            }
        }

        if tr.phase == Phase::Running {
            if tr.pause_at.is_some_and(|p| now >= p) {
                tr.pause_at = None;
                let corr = tr.corr.clone();
                for side in &mut tr.sides {
                    if let (false, Some(a)) = (side.shared, side.a.clone())
                        && is_source(g, &a)
                    {
                        if side.orig.paused.is_none() {
                            side.orig.paused = Some(get_bool(g, &a, "paused"));
                        }
                        gset(g, &corr, &a, "paused", PropValue::Bool(true));
                    }
                }
            }
            match tr.effect_id {
                None => {
                    if tr.swap_at.is_some_and(|s| now >= s) {
                        self.swap(tr, g, anim, now);
                    }
                }
                Some(_) => {
                    if now >= tr.t0 + tr.dur {
                        self.handoff(tr, g, anim, now);
                    }
                }
            }
        }

        if tr.phase == Phase::Handoff
            && now >= tr.settle_until
            && !self.graves.iter().any(|gr| gr.corr == tr.corr)
        {
            tr.phase = Phase::Done;
            let to = tr.b.clone();
            self.emit(&tr.corr, now, TransitionEventKind::Done { to });
            return false;
        }
        true
    }

    /// The start instant once it has come (`None` = keep waiting).
    fn start_instant(&self, tr: &mut Tr, g: &Graph, now: Duration) -> Option<Duration> {
        let first = !tr.evaluated;
        tr.evaluated = true;
        if tr.align == Align::Now {
            return Some(now);
        }
        let Some(li) = tr.lead else {
            return Some(now);
        };
        let Some(a) = tr.sides[li].a.clone() else {
            return Some(now);
        };
        if !is_source(g, &a) || is_still(g, &a) {
            return Some(now); // `End` on an image (or a vanished A) is `Now`
        }
        let shared_loop = tr.sides[li].shared && get_bool(g, &a, "loop");
        let ended = self.ended.contains_key(&a);
        let full_live = tr.effect_id.is_some() && tr.method == Method::FullLive;
        if !full_live {
            // reveal / frozen / cut START at A's end.
            if ended {
                return Some(now);
            }
            if shared_loop
                && (tr.wrapped
                    || tr
                        .end_est
                        .is_some_and(|e| e - secs(now) <= LAST_FRAME_WINDOW_S))
            {
                return Some(now);
            }
            return None;
        }
        // full-live ENDS at A's end: start at end − duration.
        let d = secs(tr.dur);
        if first && shared_loop {
            let speed = get_f64(g, &a, "speed").unwrap_or(1.0).max(0.01);
            let len = get_f64(g, &a, "duration").unwrap_or(0.0) / speed;
            if tr.end_est.is_some_and(|e| e - d < secs(now)) && len >= d {
                // Too late for this iteration of a looping shared A: align to the next.
                tr.skip_iteration = true;
                tr.wrapped = false;
            }
        }
        if tr.skip_iteration {
            if !tr.wrapped {
                return None;
            }
            tr.skip_iteration = false;
        }
        if ended {
            return Some(now); // already holding its last frame
        }
        // `time_pos` is the shown frame's pts, so every sample over-estimates the end by
        // its offset inside that frame (0…one frame): the true end lies in
        // [end_est − frame, end_est]. Aim at the middle — error ≤ half a frame.
        let speed = get_f64(g, &a, "speed").unwrap_or(1.0).max(0.01);
        let half_frame = tr.frame_dt.map_or(0.0, |f| f / speed / 2.0);
        let t = tr.end_est? - half_frame - d;
        if t > secs(now) {
            return None;
        }
        if first {
            return Some(now); // A shorter than the effect (or B late): start right away
        }
        // At most one tick late: start the effect on schedule so it ends exactly at A's end.
        Some(Duration::from_secs_f64(t.max(0.0)).max(self.prev_now))
    }

    fn begin_running(
        &mut self,
        tr: &mut Tr,
        g: &mut Graph,
        anim: &mut Animator,
        t0: Duration,
        now: Duration,
    ) {
        tr.phase = Phase::Running;
        tr.t0 = t0;
        let corr = tr.corr.clone();
        let b = tr.b.clone();
        self.emit(
            &corr,
            now,
            TransitionEventKind::Started {
                method: tr.method,
                effect_id: tr.effect_id.clone(),
                start_ms: ms(t0),
            },
        );
        let Some(eid) = tr.effect_id.clone() else {
            // Cut: 30 ms ramp down A, swap, 30 ms ramp up B. On `align: end` A has
            // already ended: no ramp on A, swap at once.
            let lead_ended = tr.lead_a().is_some_and(|a| self.ended.contains_key(a));
            let has_a = tr
                .sides
                .iter()
                .any(|s| !s.shared && s.a.as_deref().is_some_and(|a| is_source(g, a)));
            let ramp_a = has_a && !(tr.align == Align::End && lead_ended);
            for side in &mut tr.sides {
                if let (false, Some(a)) = (side.shared, side.a.clone())
                    && is_source(g, &a)
                {
                    note_gain(side, g, &a, "anticlick");
                    if ramp_a {
                        ramp_slot(g, anim, &corr, &a, "anticlick", SILENT_DB, t0, ANTICLICK);
                    } else {
                        gset(g, &corr, &a, "gain.anticlick", PropValue::F64(SILENT_DB));
                    }
                }
            }
            let swap = if ramp_a { t0 + ANTICLICK } else { t0 };
            tr.swap_at = Some(swap);
            tr.settle_until = swap + ANTICLICK;
            anim_gain(
                anim,
                &corr,
                &b,
                "xfade",
                0.0,
                1.0,
                swap,
                ANTICLICK,
                Curve::Linear,
            );
            return;
        };

        for side in &mut tr.sides {
            let from = side.held.clone().or(side.a.clone()).unwrap_or_default();
            let mut p = Map::new();
            p.insert("effect_id".into(), json!(eid));
            p.insert("from".into(), json!(from));
            p.insert("to".into(), json!(b));
            p.insert("params".into(), Value::Object(tr.params.clone()));
            match g.create(NodeKind::Effect, None, p) {
                Ok(fx) => {
                    for l in &side.layers {
                        gset(g, &corr, l, "content", PropValue::Str(fx.clone()));
                    }
                    anim.add(Animation {
                        target: path(&fx, "progress"),
                        from: 0.0,
                        to: 1.0,
                        start: t0,
                        duration: tr.dur,
                        curve: Curve::Linear,
                        unit: AnimUnit::Scalar,
                        corr: Some(corr.clone()),
                    });
                    side.fx = Some(fx);
                }
                Err(e) => log::event(
                    "transition",
                    Level::Warn,
                    "transition.graph_error",
                    Some(corr.clone()),
                    json!({ "create": "effect", "error": e.to_string() }),
                ),
            }
        }

        let d = tr.dur;
        match tr.method {
            Method::FullLive => {
                gset(g, &corr, &b, "paused", PropValue::Bool(false));
                anim_gain(
                    anim,
                    &corr,
                    &b,
                    "xfade",
                    0.0,
                    1.0,
                    t0,
                    d,
                    Curve::EqualPowerIn,
                );
                for side in &mut tr.sides {
                    if let (false, Some(a)) = (side.shared, side.a.clone())
                        && is_source(g, &a)
                    {
                        note_gain(side, g, &a, "xfade");
                        // k·cos(x·π/2): equal-power out from wherever A's xfade is now.
                        let k = db_to_lin(gain_db(g, &a, "xfade"));
                        anim_gain(
                            anim,
                            &corr,
                            &a,
                            "xfade",
                            0.0,
                            k,
                            t0,
                            d,
                            Curve::EqualPowerOut,
                        );
                    }
                }
            }
            Method::Reveal | Method::Frozen => {
                for side in &mut tr.sides {
                    if let (false, Some(a)) = (side.shared, side.a.clone())
                        && is_source(g, &a)
                    {
                        note_gain(side, g, &a, "anticlick");
                        ramp_slot(g, anim, &corr, &a, "anticlick", SILENT_DB, t0, ANTICLICK);
                    }
                }
                tr.pause_at = Some(t0 + ANTICLICK);
                if tr.method == Method::Reveal {
                    gset(g, &corr, &b, "paused", PropValue::Bool(false));
                    anim_gain(
                        anim,
                        &corr,
                        &b,
                        "xfade",
                        0.0,
                        1.0,
                        t0,
                        d,
                        Curve::EqualPowerIn,
                    );
                }
            }
        }
    }

    /// Point every requested layer at B and drop the effects/snapshots.
    fn layers_to_b(&self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator) {
        let corr = tr.corr.clone();
        for side in &mut tr.sides {
            for l in &side.layers {
                if g.kind_of(l).is_some() {
                    gset(g, &corr, l, "content", PropValue::Str(tr.b.clone()));
                }
            }
            if let Some(fx) = side.fx.take() {
                destroy_node(g, anim, &fx);
            }
            if let Some(h) = side.held.take() {
                destroy_node(g, anim, &h);
            }
        }
    }

    /// Release every A after the picture moved to B; returns their ids.
    fn release_all(
        &mut self,
        tr: &Tr,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) -> Vec<String> {
        let mut from = Vec::new();
        for side in &tr.sides {
            if let Some(a) = &side.a {
                from.push(a.clone());
                self.release(tr, g, anim, a, now);
            }
        }
        from
    }

    /// A no longer shown by these layers: if nothing else shows it, destroy it once it's
    /// silent — now if it's paused or already at −96 dB, else after a 30 ms ramp.
    fn release(&mut self, tr: &Tr, g: &mut Graph, anim: &mut Animator, a: &str, now: Duration) {
        if !is_source(g, a) || self.graves.iter().any(|gr| gr.id == a) {
            return;
        }
        if shown_outside(g, a, &[]) {
            return; // still on another output: its picture (and audio) stay
        }
        let silent = get_bool(g, a, "paused")
            || g.effective_gain_db(a)
                .is_some_and(|db| db <= SILENT_DB + 1e-9);
        let at = if silent {
            now
        } else {
            ramp_slot(g, anim, &tr.corr, a, "anticlick", SILENT_DB, now, ANTICLICK);
            now + ANTICLICK
        };
        self.graves.push(Grave {
            id: a.to_string(),
            at,
            corr: tr.corr.clone(),
            outputs: tr.outputs.clone(),
        });
    }

    /// Effect finished (progress = 1): layers → B, fx destroyed, A released. Frozen: B
    /// starts now, with a 30 ms anti-click ramp in.
    fn handoff(&mut self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator, now: Duration) {
        self.layers_to_b(tr, g, anim);
        let (corr, b) = (tr.corr.clone(), tr.b.clone());
        tr.settle_until = now;
        if tr.method == Method::Frozen && is_source(g, &b) {
            gset(g, &corr, &b, "gain.anticlick", PropValue::F64(SILENT_DB));
            gset(g, &corr, &b, "gain.xfade", PropValue::F64(0.0));
            gset(g, &corr, &b, "paused", PropValue::Bool(false));
            anim_gain(
                anim,
                &corr,
                &b,
                "anticlick",
                0.0,
                1.0,
                now,
                ANTICLICK,
                Curve::Linear,
            );
            tr.settle_until = now + ANTICLICK;
        }
        let from = self.release_all(tr, g, anim, now);
        tr.phase = Phase::Handoff;
        self.emit(&corr, now, TransitionEventKind::Handoff { to: b, from });
    }

    /// Cut: the picture swaps to B (A is silent by now), B unpauses into its ramp.
    fn swap(&mut self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator, now: Duration) {
        self.layers_to_b(tr, g, anim);
        let (corr, b) = (tr.corr.clone(), tr.b.clone());
        gset(g, &corr, &b, "paused", PropValue::Bool(false));
        let from = self.release_all(tr, g, anim, now);
        tr.phase = Phase::Handoff;
        self.emit(&corr, now, TransitionEventKind::Handoff { to: b, from });
    }

    /// Interrupt of a Running transition (brief step 7): B becomes current at once (held B
    /// unpaused, its gains → 0 dB over 30 ms), A ramped to silence over 30 ms and destroyed.
    fn commit(&mut self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator, now: Duration) {
        self.layers_to_b(tr, g, anim);
        let (corr, b) = (tr.corr.clone(), tr.b.clone());
        if is_source(g, &b) {
            gset(g, &corr, &b, "paused", PropValue::Bool(false));
            ramp_slot(g, anim, &corr, &b, "xfade", 0.0, now, ANTICLICK);
            if gain_db(g, &b, "anticlick") != 0.0 {
                ramp_slot(g, anim, &corr, &b, "anticlick", 0.0, now, ANTICLICK);
            }
        }
        tr.pause_at = None;
        tr.settle_until = now + ANTICLICK;
        let from = self.release_all(tr, g, anim, now);
        tr.phase = Phase::Handoff;
        self.emit(&corr, now, TransitionEventKind::Handoff { to: b, from });
    }

    /// Put back exactly what the recipe changed on this side's A.
    fn restore(
        &self,
        side: &mut Side,
        corr: &CorrId,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) {
        let Some(a) = side.a.clone() else {
            return;
        };
        if !is_source(g, &a) {
            return;
        }
        let orig = std::mem::take(&mut side.orig);
        if let Some(l) = orig.looped {
            gset(g, corr, &a, "loop", PropValue::Bool(l));
            if l && self.ended.contains_key(&a) {
                // It ended only because we turned its loop off: resume the loop.
                gset(g, corr, &a, "position", PropValue::F64(0.0));
            }
        }
        if let Some(p) = orig.paused {
            gset(g, corr, &a, "paused", PropValue::Bool(p));
        }
        for (slot, db) in orig.gains {
            ramp_slot(g, anim, corr, &a, slot, db, now, ANTICLICK);
        }
    }

    /// Before Running (superseded / cancelled / B failed): B destroyed (it's paused and
    /// silent), A restored exactly; nothing visible changed.
    fn abort(
        &mut self,
        tr: &mut Tr,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
        outcome: Outcome,
    ) {
        for side in &mut tr.sides {
            if let Some(h) = side.held.take() {
                destroy_node(g, anim, &h);
            }
        }
        if is_source(g, &tr.b) {
            destroy_node(g, anim, &tr.b);
        }
        for side in &mut tr.sides {
            self.restore(side, &tr.corr, g, anim, now);
        }
        self.emit_outcome(tr, now, outcome);
    }

    /// Running (cancelled / B failed mid-effect): the layers show A again, A unpaused and
    /// its gains ramped back over 30 ms, B ramped to silence then destroyed.
    fn snap_back(
        &mut self,
        tr: &mut Tr,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
        outcome: Outcome,
    ) {
        let corr = tr.corr.clone();
        for side in &mut tr.sides {
            let a = side.a.clone().unwrap_or_default();
            for l in &side.layers {
                if g.kind_of(l).is_some() {
                    gset(g, &corr, l, "content", PropValue::Str(a.clone()));
                }
            }
            if let Some(fx) = side.fx.take() {
                destroy_node(g, anim, &fx);
            }
            if let Some(h) = side.held.take() {
                destroy_node(g, anim, &h);
            }
        }
        tr.pause_at = None;
        for side in &mut tr.sides {
            self.restore(side, &corr, g, anim, now);
        }
        let b = tr.b.clone();
        if is_source(g, &b) {
            if get_bool(g, &b, "paused") {
                destroy_node(g, anim, &b);
            } else {
                anim.cancel_target(&path(&b, "gain.xfade"));
                ramp_slot(g, anim, &corr, &b, "anticlick", SILENT_DB, now, ANTICLICK);
                self.graves.push(Grave {
                    id: b,
                    at: now + ANTICLICK,
                    corr: corr.clone(),
                    outputs: tr.outputs.clone(),
                });
            }
        }
        self.emit_outcome(tr, now, outcome);
    }
}

/// `align: end` bookkeeping for the lead A (see `Tr::end_est`).
fn track_lead(tr: &mut Tr, g: &Graph, now: Duration) {
    let Some(a) = tr.lead_a().map(str::to_string) else {
        return;
    };
    let (Some(tp), Some(dur)) = (get_f64(g, &a, "time_pos"), get_f64(g, &a, "duration")) else {
        return;
    };
    if dur <= 0.0 {
        return;
    }
    let speed = get_f64(g, &a, "speed").unwrap_or(1.0).max(0.01);
    let paused = get_bool(g, &a, "paused");
    if let Some(l) = tr.last_tp
        && tp > l + 1e-4
        && tp - l < 0.25
    {
        tr.frame_dt = Some(tr.frame_dt.map_or(tp - l, |f| f.min(tp - l)));
    }
    if tr.last_tp.is_some_and(|l| tp + 1e-3 < l) {
        tr.wrapped = true; // looped (or seeked back): a new iteration
        tr.end_est = None;
    }
    if paused || tr.last_speed.is_some_and(|s| (s - speed).abs() > 1e-9) {
        tr.end_est = None;
    }
    tr.last_tp = Some(tp);
    tr.last_speed = Some(speed);
    if paused {
        return;
    }
    let est = secs(now) + (dur - tp).max(0.0) / speed;
    tr.end_est = Some(tr.end_est.map_or(est, |e| e.min(est)));
}
