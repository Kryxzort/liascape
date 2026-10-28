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

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::anim::{AnimUnit, Animation, Animator, Curve, PropPath};
use crate::graph::{ApiError, Graph, NodeKind, PropValue};
use crate::log::{self, CorrId, Level};
use crate::onset::{Onsets, PendingOnset};
use crate::sources::SourceEvent;
use crate::units::{GainSlot, SILENT_DB, db_to_lin};

/// Every audio start/stop at a hold boundary (and every commit/snap-back ramp) takes this
/// long (invariant #4: ≤ 30 ms).
pub const ANTICLICK: Duration = Duration::from_millis(30);
/// B that hasn't produced its first frame by then fails the transition (never park).
pub const READY_TIMEOUT: Duration = Duration::from_secs(10);
/// R85: the onset bound — one constant for every onset path (`crate::onset`, I6).
pub use crate::onset::ONSET_TIMEOUT;
/// M2 (final review): an `align: end` wait never outlasts A's remaining play time (at its
/// speed) by more than this — an A that errors mid-file, stalls, or has no known end falls
/// back to starting now (`transition.align_fallback`), so rotation never silently stops.
pub const ALIGN_SLACK: Duration = Duration::from_secs(10);
/// Requirement #2 (Task 16c): the extra tail *after* a ramp-to-silence's own 30 ms before
/// the source is actually paused — gain pushes are async and mpv's own audio buffering
/// lags the graph value (dropout evidence: a ramp paused exactly at its nominal end
/// truncated its last ~6 ms in the audio actually output). 15 ms is comfortably ≥ 2× the
/// measured truncation while staying small against `ANTICLICK` itself; tuned against
/// `tests/onmachine/dropout.sh`'s onset/micro_gap checks, not derived from a single mpv
/// property (no generic "gain reply has landed in the audio domain" signal exists — the
/// recipe only ever sees `SourceEvent`s, never mpv's own request-latency bookkeeping).
pub const AUDIO_SETTLE_TAIL: Duration = Duration::from_millis(15);
/// Frame interval assumed until one is observed (the clips' 30 fps).
const DEFAULT_FRAME_S: f64 = 1.0 / 30.0;
/// full-live `align: end` compression (`Transitions::follow_a_end`): a running effect is
/// finished early only when A's end moved more than this before the effect's end — the
/// end estimate's own refinements (≤ ½ frame) never retime anything.
const COMPRESS_MIN_GAIN: Duration = Duration::from_millis(10);
/// …and never to less than this much remaining effect (or what remains, if less): an A
/// whose end is already here holds its last frame ≤ this long rather than the picture
/// cutting — an imperceptible hold, against up to D before.
const COMPRESS_FLOOR: Duration = Duration::from_millis(100);

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
    /// Before the effect runs (A still shows; a cancel restores A exactly).
    pub fn pre_running(self) -> bool {
        matches!(
            self,
            Phase::Scheduled | Phase::WaitingReady | Phase::WaitingStart
        )
    }
}

/// A source's identity + playback position at some instant (R70): what the dropout
/// detector (Task 15, `probe::dropout`) needs to decode the matching stretch of the file
/// and weight it by the recorded gain schedule. `position` is the observed `time_pos`
/// (seconds); `path` is the graph `path` — both read straight off the graph, never a
/// synchronous mpv call. Review fix round, R78: also carries `speed`, `loop_` (wire name
/// `"loop"`) and `duration`, so the dropout detector can map window time to FILE time at
/// this source's own speed and wrap a looping decode at this `duration` instead of
/// treating every window-crossing-EOF as silence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioSourceSnapshot {
    pub id: String,
    pub path: String,
    pub position: f64,
    pub speed: f64,
    #[serde(rename = "loop")]
    pub loop_: bool,
    pub duration: Option<f64>,
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
        /// R70 (Task 15, the dropout detector): every distinct outgoing A (one per
        /// `Side`, in request order — not shared/held distinction, the recipe's own A id
        /// regardless of whether a snapshot is fronting it), each with its graph `path`
        /// and observed `time_pos` (seconds) at this instant.
        a: Vec<AudioSourceSnapshot>,
        /// B, the same shape.
        b: AudioSourceSnapshot,
    },
    /// B is the layers' content now; A's removal is scheduled. `committed`: cut short by
    /// a newer request (invariant #6) rather than reaching its end.
    #[serde(rename = "transition.handoff")]
    Handoff {
        to: String,
        from: Vec<String>,
        committed: bool,
    },
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
    /// `end`: waits for A's end — before Running, A is what shows (the snapshot saves A).
    pub align: Align,
    pub outputs: Vec<String>,
    /// B.
    pub to: String,
    /// The outgoing sources (one per distinct A).
    pub from: Vec<String>,
    /// Sources this transition keeps paused on purpose: a pending B, held A's, a frozen
    /// B, snapshots, and its graves (released A's / ramped-out B's not destroyed yet).
    pub held: Vec<String>,
}

/// What the recipe changed on a source, for exact restoration (cancel/failure, or the
/// source turning out to be shown elsewhere — R43). Only the first change of each is
/// recorded, and a gain is recorded as the *target* of whatever animation was moving it
/// then (R41), never a mid-ramp value.
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
    /// When the gain animations begun at t0 end (≥ t0 + 30 ms whatever the duration, R42).
    gain_end: Duration,
    /// When the effect's picture ends (handoff): t0 + D, earlier once compressed.
    end_at: Duration,
    /// full-live `align: end`: how long A was meant to hold its last frame at the effect's
    /// end when it started (s) — 0 on schedule; > 0 when A was already shorter than D (or B
    /// late) at the first evaluation. Only a later *move* of A's end compresses the effect.
    end_hold: Option<f64>,
    /// The effect was compressed (a pending B onset then ramps within the new end).
    compressed: bool,
    // `align: end` tracking of the lead A.
    /// Earliest estimate of A's iteration end (player-clock seconds): every observation
    /// `now + (duration − time_pos)/speed` is ≥ the true end (time_pos lags), so the
    /// minimum is the tightest.
    end_est: Option<f64>,
    /// A's frame interval in media seconds (smallest positive `time_pos` step seen).
    frame_dt: Option<f64>,
    last_tp: Option<f64>,
    last_speed: Option<f64>,
    /// Looping A: when `time_pos` last dropped back (player-clock s). mpv already counts
    /// the next iteration while the LAST frame is still on screen, so the visible
    /// boundary is one frame after this (measured 33.9–34.3 ms at 30 fps).
    drop_at: Option<f64>,
    /// `time_pos` dropped in this very iteration (the last frame is on screen now).
    dropped_now: bool,
    /// Looping A, full-live: the boundary chosen for the effect to end on.
    target_end: Option<f64>,
    /// Looping A, reveal/frozen/cut: the boundary to start at (last frame copied).
    boundary: Option<f64>,
    skip_iteration: bool,
    evaluated: bool,
    /// reveal/frozen: the snapshots have been created (they're waited on until ready).
    copies_made: bool,
    /// R85 (Task 16c): B's onset ramp, held until real audio confirms (or times out).
    /// `None` once started, or never needed (a cut never goes through this path).
    onset: Option<PendingOnset>,
    /// M2: when an `align: end` wait gives up on A's end and starts anyway (player clock;
    /// `None` = not computed yet / recompute — after a speed change or a new lead).
    align_deadline: Option<Duration>,
}

impl Tr {
    fn lead_a(&self) -> Option<&str> {
        self.lead.and_then(|i| self.sides[i].a.as_deref())
    }
}

/// A source waiting to be destroyed once its ramp to silence is over. `orig` is what the
/// recipe changed on it: if a layer shows it again before then, it's restored (R43).
struct Grave {
    id: String,
    at: Duration,
    corr: CorrId,
    outputs: Vec<String>,
    orig: Orig,
}

enum Outcome {
    /// A newer request took over; it proceeds from A as it is now (R44: no rewind).
    Superseded,
    /// Cancelled; A stays current.
    Cancelled,
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
    /// I6 (final review): `restore_a`'s un-pause-then-ramp-in onsets (a snap-back, a
    /// cancelled/failed/superseded switch, a grave shown again) — held until the restored
    /// A's audio flows, like every other onset.
    restore_onsets: Onsets,
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

/// R70: `id`'s path + observed `time_pos` right now, for the dropout detector's gain
/// schedule — falls back to the (writable) `position` target, then `0.0`, so a source
/// that hasn't produced its first frame yet (B, just created) still gets a sane start
/// point instead of `None` collapsing to a silent gap in the recorded schedule. R78
/// (review fix round): also reads `speed`/`loop`/`duration` off the graph at this same
/// instant. `pub(crate)` so `Runtime::retire` (R79's plain-retire dropout window) can
/// reuse the exact same snapshot shape without duplicating it.
pub(crate) fn snapshot_source(g: &Graph, id: &str) -> AudioSourceSnapshot {
    AudioSourceSnapshot {
        id: id.to_string(),
        path: get_str(g, id, "path"),
        position: get_f64(g, id, "time_pos")
            .or_else(|| get_f64(g, id, "position"))
            .unwrap_or(0.0),
        speed: get_f64(g, id, "speed").unwrap_or(1.0),
        loop_: get_bool(g, id, "loop"),
        duration: get_f64(g, id, "duration").filter(|d| *d > 0.0),
    }
}

fn gain_db(g: &Graph, id: &str, slot: &str) -> f64 {
    get_f64(g, id, &format!("gain.{slot}")).unwrap_or(0.0)
}

/// A picture that never changes: an image, a colour or a snapshot — by kind (mirrored
/// from the live source). A video is never a still, even before its duration is known.
fn is_still(g: &Graph, id: &str) -> bool {
    matches!(
        get_str(g, id, "kind").as_str(),
        "image" | "color" | "snapshot"
    )
}

/// A source that never reaches an end — a still, or a scene (Phase 2 Task 9: a scene has
/// no duration and never emits `Ended`; its `loop` is stored, inert). `align: end` on such
/// a lead A is `Now`, and End leaves its loop alone. Unlike a still, a scene's picture
/// changes: reveal/frozen still hold it by a snapshot (`changing_sides` uses `is_still`).
pub(crate) fn never_ends(g: &Graph, id: &str) -> bool {
    is_still(g, id) || get_str(g, id, "kind") == "scene"
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

/// R85: actually start a held onset ramp — called once [`SourceEvent::AudioFlowing`]
/// confirms real audio, or [`ONSET_TIMEOUT`] passes. Bumps `settle_until` so a Handoff's
/// `transition.done` can't fire before this ramp (started here, possibly well after the
/// nominal effect end) actually finishes.
fn start_onset(tr: &mut Tr, anim: &mut Animator, now: Duration, reason: &str) {
    let Some(mut onset) = tr.onset.take() else {
        return;
    };
    if tr.compressed && tr.phase == Phase::Running {
        // the effect was compressed to A's new end (`follow_a_end`): ramp in by then
        onset.dur = onset
            .dur
            .min(tr.gain_end.saturating_sub(now))
            .max(ANTICLICK);
    }
    let dur = onset.dur;
    onset.start(anim, now, reason);
    tr.settle_until = tr.settle_until.max(now + dur);
}

/// R85: does `id` have real audio worth holding an onset ramp for? Only a live `video`
/// source (not `no_audio`, R92: and not confirmed to have no actual audio track —
/// `has_audio`, defaulting `true` until a real source observes otherwise) ever reports
/// [`SourceEvent::AudioFlowing`] — `MpvSource::apply` fires it immediately for everything
/// else (stepped mode, no audio track, no audio stream in the file at all), and a
/// `color`/`image`/`snapshot` source (no `MpvSource` behind it at all) never fires it in
/// the first place. Checking here too (never scheduling a [`PendingOnset`] for one) avoids
/// relying on a 150 ms [`ONSET_TIMEOUT`] for the completely ordinary case of a plain cut-
/// like fade onto a colour/image B, **or onto a video that simply has no audio stream**
/// (R92: before this check, every such B waited the full timeout and logged a warning,
/// every time) — ramp it in at once instead.
fn b_has_audio(g: &Graph, id: &str) -> bool {
    crate::onset::has_audio(g, id)
}

/// Un-pause `id` and either hold its onset ramp (R85, real audio) or start it at once (no
/// audio to wait for) — the one seam every B-onset call site (full-live/reveal at
/// `begin_running`, frozen at `handoff`, a `frozen` commit interrupt) goes through.
#[allow(clippy::too_many_arguments)]
fn schedule_onset(
    tr: &mut Tr,
    g: &Graph,
    anim: &mut Animator,
    id: String,
    slot: &'static str,
    from: f64,
    to: f64,
    dur: Duration,
    curve: Curve,
    now: Duration,
) {
    if b_has_audio(g, &id) {
        crate::onset::held(&id, slot, Some(tr.corr.clone()));
        tr.onset = Some(PendingOnset {
            id,
            slot,
            from,
            to,
            dur,
            curve,
            requested: now,
            corr: Some(tr.corr.clone()),
        });
    } else {
        anim_gain(anim, &tr.corr, &id, slot, from, to, now, dur, curve);
    }
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
        hint: "see .claude/rules/player-core.md \u{a7} Transition recipe; `liascape-player ctl state` \
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

/// Record `a.gain.<slot>` in `orig` (first change only): the target of the animation
/// *still moving* it, if one is live, else its current value (R41). `live_target_of`
/// (not `target_of`) is deliberate (Task 16b): a *finished* animation's held target must
/// never win over a later direct `set` on the same path — that `set` is the newer truth.
fn note_gain(orig: &mut Orig, g: &Graph, anim: &Animator, a: &str, slot: &'static str) {
    if !orig.gains.iter().any(|(s, _)| *s == slot) {
        let v = anim
            .live_target_of(&path(a, &format!("gain.{slot}")))
            .unwrap_or_else(|| gain_db(g, a, slot));
        orig.gains.push((slot, v));
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
                self.abort(&mut tr, g, anim, now, Outcome::Superseded);
            } else if overlaps && phase == Phase::Running {
                let mut tr = self.active.remove(i);
                self.commit(&mut tr, g, anim, now);
                self.active.insert(i, tr);
                i += 1;
            } else {
                i += 1;
            }
        }

        // R85: a node with another (unrelated, e.g. already-handed-off) transition's own
        // pending onset is about to become *this* request's outgoing "A" — force that
        // onset to start right now rather than leaving it to resolve invisibly later and
        // fight whatever this transition does to the same gain slot (`note_gain`/`release`
        // need a *live* animation to read a target from, not a silent gap). `build_sides`
        // below computes the exact same `cur:<connector>` set.
        let incoming: Vec<String> = outputs
            .iter()
            .filter_map(|o| {
                g.resolve(&format!("cur:{}", o.strip_prefix("out:").unwrap_or(o)))
                    .into_iter()
                    .next()
            })
            .collect();
        for tr in &mut self.active {
            if tr.onset.as_ref().is_some_and(|o| incoming.contains(&o.id)) {
                start_onset(tr, anim, now, "forced");
            }
        }
        for id in &incoming {
            self.restore_onsets.force(id, anim, now);
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
            gain_end: now,
            end_at: now,
            end_hold: None,
            compressed: false,
            end_est: None,
            frame_dt: None,
            last_tp: None,
            last_speed: None,
            drop_at: None,
            dropped_now: false,
            target_end: None,
            boundary: None,
            skip_iteration: false,
            evaluated: false,
            copies_made: false,
            onset: None,
            align_deadline: None,
        };
        // align: end — A's current iteration is its last (unless shared, R34, or it never
        // ends: a still or a scene).
        if req.align == Align::End
            && let Some(li) = lead
        {
            let side = &mut tr.sides[li];
            if let Some(a) = side.a.clone()
                && !side.shared
                && !never_ends(g, &a)
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
                self.abort(&mut tr, g, anim, now, Outcome::Cancelled);
                Ok(())
            }
            Phase::Running => {
                let mut tr = self.active.remove(i);
                self.snap_back(&mut tr, g, anim, now, Outcome::Cancelled);
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
                // M2: an A that errored mid-file holds its last frame and makes no more
                // sound — for `align: end` it has ended (never waited on forever).
                SourceEvent::Error { .. } => {
                    if self.active.iter().any(|t| t.lead_a() == Some(id.as_str())) {
                        let tp = get_f64(g, id, "time_pos").unwrap_or(0.0);
                        self.ended.insert(id.clone(), tp);
                    }
                }
                SourceEvent::Rejected { .. } => {}
                // R85: the onset ramp this id was waiting on (if any) starts now, for real.
                SourceEvent::AudioFlowing => {
                    for tr in &mut self.active {
                        if tr.onset.as_ref().is_some_and(|o| &o.id == id) {
                            start_onset(tr, anim, now, "flowed");
                        }
                    }
                }
            }
        }
        self.ended.retain(|id, _| is_source(g, id));
        self.restore_onsets.retain(|id| is_source(g, id));
        self.restore_onsets.tick(events, anim, now, "transition");
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

    /// Drop `id`'s held restore onset (someone else — retire, park — owns its anticlick
    /// now).
    pub fn cancel_restore_onset(&mut self, id: &str) {
        self.restore_onsets.cancel(id);
    }

    /// `(live transitions, graves, ended-tracking entries, restore onsets)` — the `loop`
    /// probe's long-run `bounds` (C1).
    pub fn bounds(&self) -> (usize, usize, usize, usize) {
        (
            self.active.len(),
            self.graves.len(),
            self.ended.len(),
            self.restore_onsets.len(),
        )
    }

    /// Drain the event outbox (R37).
    pub fn drain_events(&mut self) -> Vec<TransitionEvent> {
        std::mem::take(&mut self.outbox)
    }

    /// R59 — a newly added output joins the live transition covering `like` (an existing
    /// output): its main layer becomes one of that transition's layers (on `like`'s side,
    /// so `like`'s A is not "shown outside" the request), it shows what the transition
    /// shows now — A before Running, the effect while Running (A until the swap for a cut),
    /// B after handoff — and cancel/failure/commit/handoff treat it like the original
    /// outputs. `None` = no live transition covers `like` (the caller applies `cur:`).
    pub fn adopt_output(&mut self, output: &str, like: &str, g: &mut Graph) -> Option<CorrId> {
        let tr = self
            .active
            .iter_mut()
            .rev()
            .find(|t| t.phase != Phase::Done && t.outputs.iter().any(|o| o == like))?;
        let corr = tr.corr.clone();
        if tr.outputs.iter().any(|o| o == output) {
            return Some(corr);
        }
        let (layer, like_layer) = (main_layer(output), main_layer(like));
        let content = match tr.phase {
            Phase::Handoff | Phase::Done => tr.b.clone(),
            phase => match tr.sides.iter_mut().find(|s| s.layers.contains(&like_layer)) {
                Some(side) => {
                    side.layers.push(layer.clone());
                    match (phase, &side.fx) {
                        (Phase::Running, Some(fx)) => fx.clone(),
                        _ => side.a.clone().unwrap_or_default(),
                    }
                }
                None => get_str(g, &like_layer, "content"),
            },
        };
        tr.outputs.push(output.to_string());
        tr.outputs.sort();
        gset(g, &corr, &layer, "content", PropValue::Str(content.clone()));
        log::event(
            "transition",
            Level::Info,
            "transition.output_adopted",
            Some(corr.clone()),
            json!({ "output": output, "like": like, "content": content }),
        );
        Some(corr)
    }

    /// R60 — output `output` is gone (its main layer already destroyed with it). Every live
    /// transition on it forgets it; a side left with no layer drops its effect/snapshot and
    /// releases its A (restored if shown elsewhere, else ramped out and destroyed); a
    /// transition left with no output at all is committed at once — the effects go, the
    /// A's are released, and B keeps its gains and pause state for the caller to park or
    /// retire (nothing shows it). Returns `(corr, B)` of every transition so committed.
    pub fn drop_output(
        &mut self,
        output: &str,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) -> Vec<(CorrId, String)> {
        let layer = main_layer(output);
        let mut committed = Vec::new();
        let mut active = std::mem::take(&mut self.active);
        for tr in &mut active {
            if !tr.outputs.iter().any(|o| o == output) {
                continue;
            }
            tr.outputs.retain(|o| o != output);
            if matches!(tr.phase, Phase::Handoff | Phase::Done) {
                continue;
            }
            for i in 0..tr.sides.len() {
                if !tr.sides[i].layers.contains(&layer) {
                    continue;
                }
                tr.sides[i].layers.retain(|l| l != &layer);
                if tr.sides[i].layers.is_empty() {
                    if let Some(fx) = tr.sides[i].fx.take() {
                        destroy_node(g, anim, &fx);
                    }
                    if let Some(h) = tr.sides[i].held.take() {
                        destroy_node(g, anim, &h);
                    }
                    let (corr, outs, gain_end) = (tr.corr.clone(), tr.outputs.clone(), tr.gain_end);
                    self.release(&corr, &outs, gain_end, &mut tr.sides[i], g, anim, now);
                    tr.sides[i].a = None;
                }
            }
            if tr.lead.is_some_and(|i| tr.sides[i].a.is_none()) {
                tr.lead = tr.sides.iter().position(|s| s.a.is_some());
                tr.end_est = None;
                tr.last_tp = None;
                tr.frame_dt = None;
                tr.drop_at = None;
                tr.target_end = None;
                tr.boundary = None;
                tr.align_deadline = None;
            }
            if tr.outputs.is_empty() {
                self.commit_unseen(tr, g, anim, now);
                committed.push((tr.corr.clone(), tr.b.clone()));
            }
        }
        self.active = active;
        committed
    }

    /// A transition nothing shows any more (every output gone): handoff now, committed —
    /// effects/snapshots destroyed, A's released, B left exactly as it is.
    fn commit_unseen(&mut self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator, now: Duration) {
        self.layers_to_b(tr, g, anim);
        tr.pause_at = None;
        // R85: a reveal/full-live onset from an earlier `begin_running` may still be
        // pending here — but nothing shows B any more ("B left exactly as it is"), so
        // there is no audible reason left to wait on it: drop it without ever starting the
        // ramp (B's gain stays exactly where `begin_running` set it, silent). Don't use the
        // onset's own `dur` (up to the whole effect duration) to extend this transition's
        // `done` for a ramp nobody will ever hear.
        tr.onset = None;
        tr.settle_until = now;
        let from = self.release_all(tr, g, anim, now);
        tr.phase = Phase::Handoff;
        let (corr, b) = (tr.corr.clone(), tr.b.clone());
        self.emit(
            &corr,
            now,
            TransitionEventKind::Handoff {
                to: b,
                from,
                committed: true,
            },
        );
    }

    /// What the `srcs:` alias needs (R50): per requested output (`out:<c>`), the sources
    /// each live transition holds — its B and its outgoing A's — plus every grave (released
    /// sources about to be destroyed). The runtime hands this to
    /// `Graph::set_transition_sources` after every start/cancel/tick.
    pub fn held_sources(&self) -> (BTreeMap<String, BTreeSet<String>>, BTreeSet<String>) {
        let mut by_output: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for t in &self.active {
            for o in &t.outputs {
                let e = by_output.entry(o.clone()).or_default();
                e.insert(t.b.clone());
                e.extend(t.sides.iter().filter_map(|s| s.a.clone()));
            }
        }
        let graves = self.graves.iter().map(|g| g.id.clone()).collect();
        (by_output, graves)
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
                held.extend(
                    self.graves
                        .iter()
                        .filter(|gr| gr.corr == t.corr)
                        .map(|gr| gr.id.clone()),
                );
                TransitionStatus {
                    corr: t.corr.clone(),
                    phase: t.phase,
                    method: t.method,
                    align: t.align,
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
            Outcome::Superseded => TransitionEventKind::Cancelled {
                reason: "superseded".into(),
            },
            Outcome::Cancelled => TransitionEventKind::Cancelled {
                reason: "cancelled".into(),
            },
            Outcome::Failed(reason) => TransitionEventKind::Failed {
                path: tr.b_path.clone(),
                reason,
            },
        };
        self.emit(&tr.corr, now, kind);
    }

    /// Destroy every grave whose ramp is over. One that a layer shows again is not
    /// destroyed but restored — playing, audible, its own loop (R43).
    fn bury(&mut self, g: &mut Graph, anim: &mut Animator, now: Duration) {
        let graves = std::mem::take(&mut self.graves);
        for gr in graves {
            if gr.at > now {
                self.graves.push(gr);
            } else if !is_source(g, &gr.id) {
                // already gone
            } else if shown_outside(g, &gr.id, &[]) {
                self.restore_a(&gr.id, gr.orig, false, &gr.corr, g, anim, now);
            } else {
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
        // R85: an onset ramp still waiting past its bound starts anyway — never held
        // open indefinitely for a confirmation that may never arrive.
        if let Some(onset) = &tr.onset
            && onset.timed_out(now)
        {
            crate::onset::log_timeout("transition", onset, now);
            start_onset(tr, anim, now, "timeout");
        }
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
        }

        if tr.phase == Phase::WaitingStart {
            // A commit's ramp-outs on these outputs finish first: never three audible.
            if self.graves_on(&tr.outputs) {
                return true;
            }
            // A shared looping A on `End` (reveal/frozen/cut start at its boundary): the
            // drop marks its last frame on screen; the boundary is one frame later.
            if tr.dropped_now && tr.boundary.is_none() && self.lead_loops_shared(tr, g) {
                tr.boundary = tr.drop_at.map(|d| d + frame_s(tr, g));
            }
            let instant = self.start_instant(tr, g, now);
            // reveal/frozen hold each A whose picture can still change as a still copy of
            // the frame on screen ("held where it is"): pausing a source doesn't freeze its
            // texture (a paused mpv presents queued frames ~100 ms late, measured 2–3
            // frames), and a shared A keeps playing elsewhere anyway (R34). Stills and
            // ended A's can't change and are held as themselves. The copy is taken at the
            // start instant — or, for a shared looping A on `End`, while its last frame
            // shows (the effect then starts at the boundary). The host makes the copy on
            // its next `sync`; the effect starts once every copy is ready.
            if !tr.copies_made {
                let to_copy = self.changing_sides(tr, g);
                if !to_copy.is_empty() {
                    // A shared looping A on `End`: copy at the drop (its last frame is on
                    // screen), start one frame later at the boundary.
                    let at_loop_end = tr.dropped_now && self.lead_loops_shared(tr, g);
                    if instant.is_none() && !at_loop_end {
                        return true;
                    }
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
                    tr.copies_made = true;
                    return true;
                }
            }
            let copies_ready = tr
                .sides
                .iter()
                .filter_map(|s| s.held.as_deref())
                .all(|h| get_bool(g, h, "ready"));
            if !copies_ready {
                return true;
            }
            let Some(t0) = instant else {
                return true;
            };
            self.begin_running(tr, g, anim, t0, now);
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
                    self.follow_a_end(tr, g, anim, now);
                    if now >= tr.end_at {
                        self.handoff(tr, g, anim, now);
                    }
                }
            }
        }

        if tr.phase == Phase::Handoff
            && tr.onset.is_none() // R85: never Done while B's onset ramp is still pending
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
        if !is_source(g, &a) || never_ends(g, &a) {
            // `End` on an A that never ends (an image, a scene) or a vanished A is `Now` —
            // never a wait for ALIGN_SLACK's fallback.
            return Some(now);
        }
        // M2: never wait for an end that doesn't come (A errored without `Ended`, stalled,
        // no known duration): A's remaining play time at its speed + ALIGN_SLACK, then
        // start now. Recomputed after a speed change or a new lead (`align_deadline`).
        let deadline = *tr.align_deadline.get_or_insert_with(|| {
            let speed = get_f64(g, &a, "speed").unwrap_or(1.0).max(0.01);
            let remaining = match (get_f64(g, &a, "duration"), get_f64(g, &a, "time_pos")) {
                (Some(d), Some(t)) if d > 0.0 => ((d - t).max(0.0) / speed).min(86_400.0),
                _ => 0.0,
            };
            now + Duration::from_secs_f64(remaining) + ALIGN_SLACK
        });
        if now >= deadline && !self.ended.contains_key(&a) {
            log::event(
                "transition",
                Level::Warn,
                "transition.align_fallback",
                Some(tr.corr.clone()),
                json!({ "a": a, "at_ms": ms(now), "deadline_ms": ms(deadline),
                        "hint": "A never reached its end (error, stall or no duration); started now" }),
            );
            return Some(now);
        }
        let shared_loop = tr.sides[li].shared && get_bool(g, &a, "loop");
        let ended = self.ended.contains_key(&a);
        let full_live = tr.effect_id.is_some() && tr.method == Method::FullLive;
        if !full_live {
            // reveal / frozen / cut START at A's end.
            if ended {
                return Some(now);
            }
            // A shared looping A never ends: start at its iteration boundary — one frame
            // after the drop at which its last frame was copied.
            if shared_loop && tr.boundary.is_some_and(|b| secs(now) >= b) {
                return Some(now);
            }
            return None;
        }
        // full-live ENDS at A's end: start at end − duration.
        let d = secs(tr.dur);
        let now_s = secs(now);
        let end = if shared_loop {
            let speed = get_f64(g, &a, "speed").unwrap_or(1.0).max(0.01);
            let len = (get_f64(g, &a, "duration").unwrap_or(0.0) / speed).max(frame_s(tr, g));
            if let Some(b) = tr.target_end {
                b
            } else if let Some(dr) = tr.drop_at {
                // Boundaries are drop + frame + k·length: the first one still reachable.
                let mut b = dr + frame_s(tr, g);
                while b - d < now_s {
                    b += len;
                }
                tr.target_end = Some(b);
                b
            } else {
                // No drop seen yet: the time_pos estimate, uncentred — on a looping file
                // time_pos runs ahead of the picture (measured: the minimum lands ~half a
                // frame before the visible boundary).
                let e = tr.end_est?;
                if first && e - d < now_s && len >= d {
                    tr.skip_iteration = true; // too late for this iteration: the next one
                }
                if tr.skip_iteration {
                    return None;
                }
                e
            }
        } else {
            if ended {
                return Some(now); // already holding its last frame
            }
            centered_end(tr, g, &a)?
        };
        let t = end - d;
        if t > now_s {
            return None;
        }
        if first {
            return Some(now); // A shorter than the effect (or B late): start right away
        }
        // At most one tick late: start the effect on schedule so it ends exactly at A's end.
        // Planned to end with A (no hold): a speed-up that moved the start instant further
        // into the past is made up by compressing the effect (`follow_a_end`).
        tr.end_hold = Some(0.0);
        Some(Duration::from_secs_f64(t.max(0.0)).max(self.prev_now))
    }

    /// A full-live `align: end` effect whose lead A it keeps ending with — the lead A, if
    /// it is ours (not shared: a shared looping A's boundaries are cached, TODO) and a
    /// kind that ends (not a still, not a scene).
    fn follows_a_end(&self, tr: &Tr, g: &Graph) -> Option<String> {
        if tr.effect_id.is_none() || tr.method != Method::FullLive || tr.align != Align::End {
            return None;
        }
        let side = &tr.sides[tr.lead?];
        let a = side.a.clone()?;
        (!side.shared && is_source(g, &a) && !never_ends(g, &a)).then_some(a)
    }

    /// full-live `align: end`, Running: the effect ends with A — a speed-up that moves A's
    /// end earlier (dragged by the user's per-item slider before the effect started, or a
    /// global speed reaching A through `srcs:*` mid-effect) compresses the effect's
    /// REMAINING progress to A's new end (plus the hold it started with, `end_hold`), and
    /// the gain ramps with it (audio follows the picture). `Animator::compress_to` rescales
    /// time only: the picture and the gains continue from where they are, along the same
    /// curves, never jump. Before, a fixed-length effect ended after A and A held its last
    /// frame for the difference (up to 0.5 s seen under random 0.25–4× drags). Never
    /// stretched: after a slow-down the effect ends before A, which is invisible (B is fully
    /// shown) and keeps the requested D as the longest it runs.
    fn follow_a_end(&mut self, tr: &mut Tr, g: &Graph, anim: &mut Animator, now: Duration) {
        let Some(hold) = tr.end_hold else {
            return;
        };
        let Some(a) = self.follows_a_end(tr, g) else {
            return;
        };
        track_lead(tr, g, now);
        // Moved? Judged on the raw estimate (an over-estimate by ≤ 1 frame, so an effect
        // scheduled on the centred end is never "late" by its own centring); aimed at the
        // centred end, like the start (`start_instant`).
        let (Some(raw), Some(a_end)) = (tr.end_est, centered_end(tr, g, &a)) else {
            return; // paused / no duration: nothing to follow
        };
        if raw + hold > secs(tr.end_at) - secs(COMPRESS_MIN_GAIN) {
            return;
        }
        let want = a_end + hold;
        let floor = now + COMPRESS_FLOOR.min(tr.end_at.saturating_sub(now));
        let target = Duration::from_secs_f64(want.max(0.0)).max(floor);
        if target + COMPRESS_MIN_GAIN > tr.end_at {
            return;
        }
        let corr = tr.corr.clone();
        for side in &tr.sides {
            if let Some(fx) = &side.fx {
                anim.compress_to(&path(fx, "progress"), &corr, now, target);
            }
        }
        // R42: the gains still never move faster than a 30 ms ramp from t0.
        let gain_target = target.max(tr.t0 + ANTICLICK).min(tr.gain_end);
        if gain_target < tr.gain_end {
            for side in &tr.sides {
                if let (false, Some(sa)) = (side.shared, side.a.as_deref()) {
                    anim.compress_to(&path(sa, "gain.xfade"), &corr, now, gain_target);
                }
            }
            // B's ramp-in, if it has started (a pending one is fitted when it starts)
            if tr.onset.is_none()
                && anim.compress_to(&path(&tr.b, "gain.xfade"), &corr, now, gain_target)
            {
                tr.settle_until = tr.settle_until.min(gain_target.max(now));
            }
            tr.gain_end = gain_target;
        }
        log::event(
            "transition",
            Level::Info,
            "transition.compressed",
            Some(corr),
            json!({ "a": a, "at_ms": ms(now), "end_ms": ms(tr.end_at), "to_end_ms": ms(target),
                    "a_end_ms": a_end * 1000.0, "hold_ms": hold * 1000.0,
                    "speed": get_f64(g, &a, "speed") }),
        );
        tr.end_at = target;
        tr.compressed = true;
    }

    /// The lead A is shared and looping (so it never ends; End aligns to its boundaries).
    fn lead_loops_shared(&self, tr: &Tr, g: &Graph) -> bool {
        tr.lead.is_some_and(|i| tr.sides[i].shared)
            && tr.lead_a().is_some_and(|a| get_bool(g, a, "loop"))
    }

    /// Sides whose A needs a still copy to be held (reveal/frozen only): a picture that
    /// can still change — not a still, not an A that has ended.
    fn changing_sides(&self, tr: &Tr, g: &Graph) -> Vec<usize> {
        if tr.effect_id.is_none() || tr.method == Method::FullLive {
            return Vec::new();
        }
        (0..tr.sides.len())
            .filter(|&i| {
                tr.sides[i].a.as_deref().is_some_and(|a| {
                    is_source(g, a) && !is_still(g, a) && !self.ended.contains_key(a)
                })
            })
            .collect()
    }

    fn begin_running(
        &mut self,
        tr: &mut Tr,
        g: &mut Graph,
        anim: &mut Animator,
        t0: Duration,
        now: Duration,
    ) {
        // Sharing can change while waiting (R43): a side now shown outside the request is
        // left alone — and gets back whatever was already changed on it (End's loop) — and
        // one no longer shown elsewhere is ours to hold.
        let layers: Vec<String> = tr.sides.iter().flat_map(|s| s.layers.clone()).collect();
        for side in &mut tr.sides {
            let Some(a) = side.a.clone() else {
                continue;
            };
            let shared = is_source(g, &a) && shown_outside(g, &a, &layers);
            if shared && !side.shared {
                let orig = std::mem::take(&mut side.orig);
                self.restore_a(&a, orig, false, &tr.corr, g, anim, now);
            }
            side.shared = shared;
        }

        tr.phase = Phase::Running;
        tr.t0 = t0;
        tr.end_at = t0 + tr.dur;
        // An effect started at once (A already shorter than D, ended, B late, the M2
        // fallback) keeps the last-frame hold it starts with; only a later move of A's
        // end compresses it (`follow_a_end`).
        if tr.end_hold.is_none() && self.follows_a_end(tr, g).is_some() {
            // against the raw estimate, like `follow_a_end`'s check: the ½-frame centring
            // appears once a frame step is seen and must not read as a move
            tr.end_hold = tr.end_est.map(|e| (secs(tr.end_at) - e).max(0.0));
        }
        // R42: gains never move faster than a 30 ms ramp, whatever the duration (the
        // picture may still cut instantly).
        let gd = tr.dur.max(ANTICLICK);
        tr.gain_end = t0 + gd;
        let corr = tr.corr.clone();
        let b = tr.b.clone();
        let a_snapshots: Vec<AudioSourceSnapshot> = tr
            .sides
            .iter()
            .filter_map(|s| s.a.clone())
            .map(|a| snapshot_source(g, &a))
            .collect();
        let b_snapshot = snapshot_source(g, &b);
        self.emit(
            &corr,
            now,
            TransitionEventKind::Started {
                method: tr.method,
                effect_id: tr.effect_id.clone(),
                start_ms: ms(t0),
                a: a_snapshots,
                b: b_snapshot,
            },
        );
        let Some(eid) = tr.effect_id.clone() else {
            // Cut: 30 ms ramp down A, swap, 30 ms ramp up B — decided per A: one that has
            // ended (End), is paused or is already silent (the player pause's gate holds a
            // playing source at −96 — a cut made while paused swaps at once instead of
            // waiting for the resume on the frozen clock) just gets the slot set.
            let mut ramped = false;
            for side in &mut tr.sides {
                if let (false, Some(a)) = (side.shared, side.a.clone())
                    && is_source(g, &a)
                {
                    note_gain(&mut side.orig, g, anim, &a, "anticlick");
                    let silent = g
                        .effective_gain_db(&a)
                        .is_some_and(|db| db <= SILENT_DB + 1e-9);
                    if self.ended.contains_key(&a) || get_bool(g, &a, "paused") || silent {
                        gset(g, &corr, &a, "gain.anticlick", PropValue::F64(SILENT_DB));
                    } else {
                        ramp_slot(g, anim, &corr, &a, "anticlick", SILENT_DB, t0, ANTICLICK);
                        ramped = true;
                    }
                }
            }
            let swap = if ramped { t0 + ANTICLICK } else { t0 };
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

        match tr.method {
            Method::FullLive => {
                // R85: B is un-paused now, but its xfade-in ramp waits for real audio
                // (`SourceEvent::AudioFlowing`) — un-pausing at the instant the gain ramp
                // starts runs most of the ramp on no audio at all (the owner's "flicker
                // of silence"), since mpv/PipeWire's own output restart measurably lags.
                gset(g, &corr, &b, "paused", PropValue::Bool(false));
                schedule_onset(
                    tr,
                    g,
                    anim,
                    b.clone(),
                    "xfade",
                    0.0,
                    1.0,
                    gd,
                    Curve::EqualPowerIn,
                    now,
                );
                for side in &mut tr.sides {
                    if let (false, Some(a)) = (side.shared, side.a.clone())
                        && is_source(g, &a)
                    {
                        note_gain(&mut side.orig, g, anim, &a, "xfade");
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
                            gd,
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
                        note_gain(&mut side.orig, g, anim, &a, "anticlick");
                        ramp_slot(g, anim, &corr, &a, "anticlick", SILENT_DB, t0, ANTICLICK);
                    }
                }
                // Requirement #2 (Task 16c): A isn't actually paused until its ramp has
                // settled in the audio *output*, not just the graph's own ANTICLICK
                // schedule — gain pushes are async and mpv's audio buffering lags the
                // graph value by a few ms (dropout evidence: a ramp paused right at its
                // nominal end truncated its last ~6 ms in the real output).
                tr.pause_at = Some(t0 + ANTICLICK + AUDIO_SETTLE_TAIL);
                if tr.method == Method::Reveal {
                    // R85: same held-onset treatment as full-live, above.
                    gset(g, &corr, &b, "paused", PropValue::Bool(false));
                    schedule_onset(
                        tr,
                        g,
                        anim,
                        b.clone(),
                        "xfade",
                        0.0,
                        1.0,
                        gd,
                        Curve::EqualPowerIn,
                        now,
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
        tr: &mut Tr,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) -> Vec<String> {
        let mut from = Vec::new();
        for i in 0..tr.sides.len() {
            if let Some(a) = tr.sides[i].a.clone() {
                from.push(a);
            }
            self.release(
                &tr.corr,
                &tr.outputs,
                tr.gain_end,
                &mut tr.sides[i],
                g,
                anim,
                now,
            );
        }
        from
    }

    /// A no longer shown by these layers. Shown by some other layer → restored to how it
    /// was (playing, audible, its own loop — R43). Otherwise destroyed once silent: at once
    /// if paused; next iteration if already at −96 dB (its final value reaches the source
    /// first); when its xfade lands at −96 if that's within 30 ms; else after a 30 ms
    /// anti-click ramp.
    #[allow(clippy::too_many_arguments)]
    fn release(
        &mut self,
        corr: &CorrId,
        outputs: &[String],
        gain_end: Duration,
        side: &mut Side,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) {
        let Some(a) = side.a.clone() else {
            return;
        };
        if !is_source(g, &a) || self.graves.iter().any(|gr| gr.id == a) {
            return;
        }
        let mut orig = std::mem::take(&mut side.orig);
        if shown_outside(g, &a, &[]) {
            self.restore_a(&a, orig, false, corr, g, anim, now);
            return;
        }
        if get_bool(g, &a, "paused") {
            destroy_node(g, anim, &a);
            return;
        }
        let at = if g
            .effective_gain_db(&a)
            .is_some_and(|db| db <= SILENT_DB + 1e-9)
        {
            now
        } else if anim
            .live_target_of(&path(&a, "gain.xfade"))
            .is_some_and(|t| t <= SILENT_DB)
            && gain_end > now
            && gain_end - now <= ANTICLICK
        {
            gain_end // its own fade-out lands within 30 ms: no second ramp on top
        } else {
            note_gain(&mut orig, g, anim, &a, "anticlick");
            ramp_slot(g, anim, corr, &a, "anticlick", SILENT_DB, now, ANTICLICK);
            now + ANTICLICK
        };
        self.graves.push(Grave {
            id: a,
            at,
            corr: corr.clone(),
            outputs: outputs.to_vec(),
            orig,
        });
    }

    /// Effect finished (progress = 1): layers → B, fx destroyed, A released. Frozen: B
    /// starts now, with a 30 ms anti-click ramp in.
    fn handoff(&mut self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator, now: Duration) {
        self.layers_to_b(tr, g, anim);
        let (corr, b) = (tr.corr.clone(), tr.b.clone());
        // R85: never move `settle_until` backward (see `commit_unseen`'s note) — reveal's
        // onset (begin_running, possibly resolved via `ONSET_TIMEOUT` well before this
        // method's own natural handoff) may still be mid-ramp.
        tr.settle_until = tr.settle_until.max(now).max(tr.gain_end);
        if tr.method == Method::Frozen && is_source(g, &b) {
            // R85: this is *the* bug the owner reported — B has been paused through the
            // whole effect; at handoff it un-pauses with essentially zero lead time for
            // mpv/PipeWire's audio-out to actually restart before a ramp needs it. Hold
            // the anticlick ramp-in until `SourceEvent::AudioFlowing` confirms it (or
            // `ONSET_TIMEOUT`), never at the instant of un-pause.
            gset(g, &corr, &b, "gain.anticlick", PropValue::F64(SILENT_DB));
            gset(g, &corr, &b, "gain.xfade", PropValue::F64(0.0));
            gset(g, &corr, &b, "paused", PropValue::Bool(false));
            schedule_onset(
                tr,
                g,
                anim,
                b.clone(),
                "anticlick",
                0.0,
                1.0,
                ANTICLICK,
                Curve::Linear,
                now,
            );
        }
        let from = self.release_all(tr, g, anim, now);
        tr.phase = Phase::Handoff;
        self.emit(
            &corr,
            now,
            TransitionEventKind::Handoff {
                to: b,
                from,
                committed: false,
            },
        );
    }

    /// Cut: the picture swaps to B (A is silent by now), B unpauses into its ramp.
    fn swap(&mut self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator, now: Duration) {
        self.layers_to_b(tr, g, anim);
        let (corr, b) = (tr.corr.clone(), tr.b.clone());
        gset(g, &corr, &b, "paused", PropValue::Bool(false));
        let from = self.release_all(tr, g, anim, now);
        tr.phase = Phase::Handoff;
        self.emit(
            &corr,
            now,
            TransitionEventKind::Handoff {
                to: b,
                from,
                committed: false,
            },
        );
    }

    /// Interrupt of a Running transition (brief step 7): B becomes current at once (held B
    /// unpaused, its gains → 0 dB over 30 ms), A ramped to silence over 30 ms and destroyed.
    fn commit(&mut self, tr: &mut Tr, g: &mut Graph, anim: &mut Animator, now: Duration) {
        self.layers_to_b(tr, g, anim);
        let (corr, b) = (tr.corr.clone(), tr.b.clone());
        if is_source(g, &b) {
            // R85: a `frozen` transition interrupted mid-Running still has B genuinely
            // paused (it only ever un-pauses at its own handoff) — committing it here is
            // the same real un-pause/onset-wait as `handoff`'s Frozen branch, never an
            // immediate ramp. reveal/full-live already un-paused B back at `begin_running`
            // (its own onset, possibly still pending — left alone: it resolves exactly as
            // scheduled, committing changes nothing about *when* B's audio is real).
            let was_paused = get_bool(g, &b, "paused");
            gset(g, &corr, &b, "paused", PropValue::Bool(false));
            if was_paused && tr.onset.is_none() {
                gset(g, &corr, &b, "gain.xfade", PropValue::F64(0.0));
                let from = db_to_lin(gain_db(g, &b, "anticlick"));
                schedule_onset(
                    tr,
                    g,
                    anim,
                    b.clone(),
                    "anticlick",
                    from,
                    1.0,
                    ANTICLICK,
                    Curve::Linear,
                    now,
                );
            } else if tr.onset.is_none() {
                ramp_slot(g, anim, &corr, &b, "xfade", 0.0, now, ANTICLICK);
                if gain_db(g, &b, "anticlick") != 0.0 {
                    ramp_slot(g, anim, &corr, &b, "anticlick", 0.0, now, ANTICLICK);
                }
            }
        }
        tr.pause_at = None;
        // R85: `.max` — never shorten a reveal/full-live onset's already-committed wait.
        tr.settle_until = tr.settle_until.max(now + ANTICLICK);
        let from = self.release_all(tr, g, anim, now);
        tr.phase = Phase::Handoff;
        self.emit(
            &corr,
            now,
            TransitionEventKind::Handoff {
                to: b,
                from,
                committed: true,
            },
        );
    }

    /// Put back exactly what the recipe changed on `a`: loop, pause, and each gain slot
    /// (ramped over 30 ms to its recorded target, R41). `seek_if_ended`: an A whose loop
    /// we turned off and that has ended because of it is rewound so it loops on — only when
    /// it stays current (cancel/failure); a superseded A is proceeded from as it is (R44).
    #[allow(clippy::too_many_arguments)]
    fn restore_a(
        &mut self,
        a: &str,
        orig: Orig,
        seek_if_ended: bool,
        corr: &CorrId,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) {
        if !is_source(g, a) {
            return;
        }
        if let Some(l) = orig.looped {
            gset(g, corr, a, "loop", PropValue::Bool(l));
            if l && seek_if_ended && self.ended.contains_key(a) {
                gset(g, corr, a, "position", PropValue::F64(0.0));
            }
        }
        // I6 (invariant #8): an A the recipe held paused (reveal/frozen) and now un-pauses
        // must not ramp back in before its audio restarts — hold the anticlick ramp-in
        // (silent until then) like every other onset; the other slots ramp at once, gated
        // by it.
        let unpausing = orig.paused == Some(false) && get_bool(g, a, "paused");
        if let Some(p) = orig.paused {
            gset(g, corr, a, "paused", PropValue::Bool(p));
        }
        for (slot, db) in orig.gains {
            if unpausing && slot == "anticlick" && crate::onset::has_audio(g, a) {
                gset(g, corr, a, "gain.anticlick", PropValue::F64(SILENT_DB));
                self.restore_onsets.schedule(
                    g,
                    anim,
                    PendingOnset {
                        id: a.to_string(),
                        slot: "anticlick",
                        from: 0.0,
                        to: db_to_lin(db),
                        dur: ANTICLICK,
                        curve: Curve::Linear,
                        requested: now,
                        corr: Some(corr.clone()),
                    },
                    now,
                );
            } else {
                ramp_slot(g, anim, corr, a, slot, db, now, ANTICLICK);
            }
        }
    }

    fn restore(
        &mut self,
        side: &mut Side,
        seek_if_ended: bool,
        corr: &CorrId,
        g: &mut Graph,
        anim: &mut Animator,
        now: Duration,
    ) {
        let orig = std::mem::take(&mut side.orig);
        if let Some(a) = side.a.clone() {
            self.restore_a(&a, orig, seek_if_ended, corr, g, anim, now);
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
        let seek = !matches!(outcome, Outcome::Superseded);
        for side in &mut tr.sides {
            self.restore(side, seek, &tr.corr, g, anim, now);
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
            self.restore(side, true, &corr, g, anim, now);
        }
        let b = tr.b.clone();
        if is_source(g, &b) {
            if get_bool(g, &b, "paused") {
                destroy_node(g, anim, &b);
            } else {
                let mut orig = Orig::default();
                note_gain(&mut orig, g, anim, &b, "anticlick");
                anim.cancel_target(&path(&b, "gain.xfade"));
                ramp_slot(g, anim, &corr, &b, "anticlick", SILENT_DB, now, ANTICLICK);
                self.graves.push(Grave {
                    id: b,
                    at: now + ANTICLICK,
                    corr: corr.clone(),
                    outputs: tr.outputs.clone(),
                    orig,
                });
            }
        }
        self.emit_outcome(tr, now, outcome);
    }
}

/// A's iteration end (player-clock s), centred: `time_pos` is the shown frame's pts, so
/// every `end_est` sample over-estimates by its offset inside that frame (0…one frame) —
/// the true end lies in [end_est − frame, end_est]; aim at the middle (error ≤ ½ frame).
fn centered_end(tr: &Tr, g: &Graph, a: &str) -> Option<f64> {
    let speed = get_f64(g, a, "speed").unwrap_or(1.0).max(0.01);
    let half_frame = tr.frame_dt.map_or(0.0, |f| f / speed / 2.0);
    Some(tr.end_est? - half_frame)
}

/// The lead A's frame interval in player-clock seconds (observed, else 30 fps).
fn frame_s(tr: &Tr, g: &Graph) -> f64 {
    let speed = tr
        .lead_a()
        .and_then(|a| get_f64(g, a, "speed"))
        .unwrap_or(1.0)
        .max(0.01);
    tr.frame_dt.unwrap_or(DEFAULT_FRAME_S) / speed
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
    tr.dropped_now = false;
    if tr.last_tp.is_some_and(|l| tp + 1e-3 < l) {
        // Looped (or seeked back): a new iteration.
        tr.end_est = None;
        tr.drop_at = Some(secs(now));
        tr.dropped_now = true;
    }
    if let Some(s0) = tr.last_speed
        && (s0 - speed).abs() > 1e-9
    {
        // A's remaining media now plays at `speed`: rescale the converged estimate's remaining
        // wall time by s0/speed (still ≥ the true end, so the minimum keeps refining it). Never
        // restart it from `time_pos`, which may be ~100 ms stale (`Position` is rate-limited) —
        // under a continuous drag a fresh sample often never arrived between two changes and the
        // effect started late (speed storm).
        let n = secs(now);
        tr.end_est = tr.end_est.map(|e| n + (e - n).max(0.0) * s0 / speed);
        tr.align_deadline = None; // M2: re-derive the fallback from the new speed
    }
    if paused {
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

/// Graph-only state-machine tests: synthetic sources (observed props set by hand, events
/// fed directly) — deterministic, no GPU, no mpv. The GPU/libmpv behaviour is covered by
/// `tests/transition.rs`.
#[cfg(test)]
mod tests {
    use super::*;

    struct H {
        g: Graph,
        anim: Animator,
        tr: Transitions,
        now: Duration,
        changes: Vec<(PropPath, PropValue)>,
        events: Vec<TransitionEvent>,
    }

    impl H {
        fn new(outputs: &[&str]) -> H {
            let mut g = Graph::new();
            for o in outputs {
                let mut p = Map::new();
                p.insert("width".into(), json!(640));
                p.insert("height".into(), json!(360));
                g.create(NodeKind::Output, Some(format!("out:{o}")), p)
                    .unwrap();
            }
            H {
                g,
                anim: Animator::new(),
                tr: Transitions::new(),
                now: Duration::ZERO,
                changes: Vec::new(),
                events: Vec::new(),
            }
        }

        /// A playing, ready video source shown on `outputs`.
        fn video(&mut self, outputs: &[&str], dur: f64, tp: f64) -> String {
            let mut p = Map::new();
            p.insert("path".into(), json!("/a.mkv"));
            p.insert("loop".into(), json!(true));
            let id = self.g.create(NodeKind::Source, None, p).unwrap();
            self.observe(&id, "ready", PropValue::Bool(true));
            self.observe(&id, "duration", PropValue::F64(dur));
            self.observe(&id, "time_pos", PropValue::F64(tp));
            for o in outputs {
                self.g
                    .set(
                        &path(&format!("lay:{o}:main"), "content"),
                        PropValue::Str(id.clone()),
                    )
                    .unwrap();
            }
            id
        }

        fn observe(&mut self, id: &str, prop: &str, v: PropValue) {
            self.g.set_observed(&path(id, prop), v).unwrap();
        }

        fn start(&mut self, req: Value) -> CorrId {
            let req: TransitionReq = serde_json::from_value(req).unwrap();
            let c = self
                .tr
                .start(req, &mut self.g, &mut self.anim, self.now)
                .unwrap();
            self.changes.extend(self.g.drain_changes());
            self.events.extend(self.tr.drain_events());
            c
        }

        fn tick(&mut self, ms: u64, events: &[(String, SourceEvent)]) {
            self.now += Duration::from_millis(ms);
            for (p, v) in self.anim.tick(self.now) {
                self.g.set(&p, PropValue::F64(v)).unwrap();
            }
            self.changes.extend(self.g.drain_changes());
            self.tr.tick(&mut self.g, &mut self.anim, events, self.now);
            self.changes.extend(self.g.drain_changes());
            self.events.extend(self.tr.drain_events());
        }

        fn b_of(&self, corr: &CorrId) -> String {
            self.events
                .iter()
                .find_map(|e| match &e.kind {
                    TransitionEventKind::Scheduled { to, .. } if &e.corr == corr => {
                        Some(to.clone())
                    }
                    _ => None,
                })
                .unwrap()
        }

        fn has(&self, corr: &CorrId, name: &str) -> bool {
            self.events
                .iter()
                .any(|e| &e.corr == corr && e.kind.name() == name)
        }

        fn bool(&self, id: &str, prop: &str) -> bool {
            get_bool(&self.g, id, prop)
        }

        fn set_to(&self, id: &str, prop: &str) -> bool {
            let p = path(id, prop);
            self.changes.iter().any(|(q, _)| *q == p)
        }
    }

    fn req(to: &str, method: &str, align: &str, effect: Option<&str>) -> Value {
        json!({
            "outputs": "out:*", "to": {"path": to}, "effect_id": effect,
            "duration_ms": 500, "method": method, "align": align
        })
    }

    /// R44: superseding an End-wait whose A already ended restores A's loop without a
    /// rewind (the new request proceeds from A's held last frame); cancelling one (A stays
    /// current) rewinds it so it loops on.
    #[test]
    fn supersede_does_not_rewind_cancel_does() {
        let mut h = H::new(&["V1"]);
        let a = h.video(&["V1"], 3.0, 2.0);
        let t1 = h.start(req("/b1.mkv", "reveal", "end", Some("fade")));
        h.tick(16, &[]);
        assert!(!h.bool(&a, "loop"), "End turns A's loop off");
        // A ends while T1's B is still loading (no Ready ever comes).
        h.tick(16, &[(a.clone(), SourceEvent::Ended)]);
        h.changes.clear();
        h.start(req("/b2.mkv", "full-live", "now", Some("fade")));
        assert!(h.has(&t1, "transition.cancelled"));
        assert!(h.bool(&a, "loop"), "supersede restores the loop");
        assert!(
            !h.set_to(&a, "position"),
            "supersede must not rewind A: {:?}",
            h.changes
        );

        let t3 = h.start(req("/b3.mkv", "frozen", "end", Some("fade")));
        assert!(!h.bool(&a, "loop"));
        h.changes.clear();
        h.tr.cancel(&t3, &mut h.g, &mut h.anim, h.now).unwrap();
        h.changes.extend(h.g.drain_changes());
        assert!(h.bool(&a, "loop"), "cancel restores the loop");
        assert!(
            h.set_to(&a, "position"),
            "cancel rewinds an A that ended only because its loop was off"
        );
    }

    /// Item 10: a video whose duration isn't known yet is not a still — reveal/frozen hold
    /// it with a snapshot (a still would be held as itself).
    #[test]
    fn video_with_unknown_duration_is_snapshot_held() {
        let mut h = H::new(&["V1"]);
        let a = h.video(&["V1"], 0.0, 0.0);
        let t = h.start(req("/b.mkv", "reveal", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        let snaps: Vec<String> =
            h.g.ids_of(NodeKind::Source)
                .into_iter()
                .filter(|s| get_str(&h.g, s, "kind") == "snapshot")
                .collect();
        assert_eq!(snaps.len(), 1, "a video A is held by a snapshot");
        assert_eq!(get_str(&h.g, &snaps[0], "of"), a);
        assert!(
            !h.has(&t, "transition.started"),
            "starts once the copy is ready"
        );
    }

    /// Item 5: cut + End — the lead A has ended (no ramp), but another output's A is still
    /// playing and must be ramped, not hard-muted.
    #[test]
    fn cut_end_ramps_each_playing_a() {
        let mut h = H::new(&["V1", "V2"]);
        let a1 = h.video(&["V1"], 3.0, 2.9);
        let a2 = h.video(&["V2"], 10.0, 1.0);
        let t = h.start(req("/b.mkv", "full-live", "end", None));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        assert!(!h.has(&t, "transition.started"), "waits for A1's end");
        h.tick(16, &[(a1.clone(), SourceEvent::Ended)]);
        assert!(h.has(&t, "transition.started"));
        assert_eq!(
            gain_db(&h.g, &a1, "anticlick"),
            SILENT_DB,
            "ended A1: set at once"
        );
        assert!(
            gain_db(&h.g, &a2, "anticlick") > SILENT_DB,
            "playing A2 is ramped, not hard-muted"
        );
        assert_eq!(
            h.anim.target_of(&path(&a2, "gain.anticlick")),
            Some(SILENT_DB),
            "A2 ramps to −96"
        );
        h.tick(10, &[]);
        let mid = gain_db(&h.g, &a2, "anticlick");
        assert!(mid > SILENT_DB && mid < 0.0, "A2 mid-ramp at +10 ms: {mid}");
    }

    /// M2 (final review): an `align: end` A that never reaches its end (stalled — its
    /// `time_pos` stops moving — or errored without `Ended`) doesn't hold the switch
    /// forever: after its remaining play time + ALIGN_SLACK it starts anyway
    /// (`transition.align_fallback`), not before.
    #[test]
    fn align_end_falls_back_when_a_never_ends() {
        let mut h = H::new(&["V1"]);
        let _a = h.video(&["V1"], 10.0, 2.0); // 8 s left, and it never moves
        let t = h.start(req("/b.mkv", "full-live", "end", None));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        let mut waited = 0u64;
        while waited < 17_500 {
            h.tick(100, &[]);
            waited += 100;
        }
        assert!(
            !h.has(&t, "transition.started"),
            "fell back before remaining (8 s) + slack (10 s)"
        );
        for _ in 0..10 {
            h.tick(100, &[]);
        }
        assert!(h.has(&t, "transition.started"), "never fell back");
    }

    /// Phase 2 Task 9: a scene never ends (no duration, no `Ended`) — an `align: end` lead A
    /// that is a scene is `Now` at once, like a still, for every method, instead of waiting
    /// out ALIGN_SLACK (10 s) and logging `transition.align_fallback`. Its (stored, inert)
    /// `loop` isn't touched. Unlike a still, reveal/frozen still hold it by a snapshot (its
    /// picture changes).
    #[test]
    fn scene_lead_a_align_end_starts_now() {
        for (method, effect) in [
            ("full-live", Some("fade")),
            ("reveal", Some("fade")),
            ("frozen", Some("fade")),
            ("full-live", None),
        ] {
            let mut h = H::new(&["V1"]);
            let a = h.video(&["V1"], 0.0, 4.2);
            h.g.set(&path(&a, "path"), PropValue::Str("/scenes/123".into()))
                .unwrap();
            // (kind is creation-only on a live source; the graph-only harness can set it)
            h.g.set(&path(&a, "kind"), PropValue::Str("scene".into()))
                .unwrap();
            let t = h.start(req("/b.mkv", method, "end", effect));
            assert!(
                h.bool(&a, "loop"),
                "{method}: End must not turn a scene's loop off"
            );
            let b = h.b_of(&t);
            h.observe(&b, "ready", PropValue::Bool(true));
            h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
            if method == "reveal" || method == "frozen" {
                let snap =
                    h.g.ids_of(NodeKind::Source)
                        .into_iter()
                        .find(|s| get_str(&h.g, s, "kind") == "snapshot")
                        .unwrap_or_else(|| panic!("{method}: a scene A is held by a snapshot"));
                assert_eq!(get_str(&h.g, &snap, "of"), a);
                h.observe(&snap, "ready", PropValue::Bool(true));
                h.tick(16, &[(snap.clone(), SourceEvent::Ready)]);
            }
            assert!(
                h.has(&t, "transition.started"),
                "{method}/{effect:?}: a scene lead A must start at once, not wait out ALIGN_SLACK"
            );
        }
    }

    /// Speed storm: A's speed dragged every 90 ms while `align: end` waits (`time_pos` arriving
    /// every 100 ms, as the rate-limited `Position` event does). Once the effect runs A's speed
    /// holds (the UI's drag then moves B). The effect must END at A's real end — resetting the
    /// end estimate on every change and re-deriving it from a `time_pos` up to 100 ms stale kept
    /// it from converging: after a slow-down the effect started late, A frozen on its last frame
    /// and its audio cut mid-fade. The one lateness allowed is physical: a speed-up that moves the
    /// start instant into the past (before that change) — a fixed-length effect can't make it up.
    #[test]
    fn align_end_tracks_a_speed_dragged_continuously() {
        for seed in 1u64..=60 {
            let mut h = H::new(&["V1"]);
            let a = h.video(&["V1"], 40.0, 0.0);
            let mut r = req("/b.mkv", "full-live", "end", Some("fade"));
            r["duration_ms"] = json!(2000);
            let t = h.start(r);
            let b = h.b_of(&t);
            h.observe(&b, "ready", PropValue::Bool(true));
            h.tick(4, &[(b.clone(), SourceEvent::Ready)]);
            let (mut pos, mut speed, mut lcg) = (0.0f64, 1.0f64, seed);
            let (mut since_speed, mut since_obs, mut changed_at) = (0u64, 0u64, 0.0f64);
            let mut started = None;
            for _ in 0..40_000 {
                h.tick(4, &[]);
                pos += 0.004 * speed;
                since_speed += 4;
                since_obs += 4;
                if since_obs >= 100 {
                    since_obs = 0;
                    h.observe(&a, "time_pos", PropValue::F64(pos.min(40.0)));
                }
                started = h.events.iter().find_map(|e| match &e.kind {
                    TransitionEventKind::Started { start_ms, .. } if e.corr == t => Some(*start_ms),
                    _ => None,
                });
                if started.is_some() {
                    break;
                }
                if since_speed >= 90 {
                    since_speed = 0;
                    lcg = lcg
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    speed = 0.25 + 3.75 * ((lcg >> 33) as f64 / (1u64 << 31) as f64);
                    h.g.set(&path(&a, "speed"), PropValue::F64(speed)).unwrap();
                    changed_at = secs(h.now) * 1000.0;
                }
            }
            let start_ms = started.expect("the effect never started");
            let a_end_ms = secs(h.now) * 1000.0 + (40.0 - pos).max(0.0) / speed * 1000.0;
            let err = start_ms + 2000.0 - a_end_ms;
            let unavoidable = (changed_at - (a_end_ms - 2000.0)).max(0.0);
            assert!(
                err > -20.0 && err < unavoidable + 10.0,
                "seed {seed}: the effect would end {err:+.0} ms vs A's end (A at {speed:.2}x; \
                 {unavoidable:.0} ms of it unavoidable)"
            );
            // …and a start pushed into the past is made up: the effect is compressed to A's
            // end (TODO "speed-up inside the last D"), at worst COMPRESS_FLOOR after the start
            let handoff_ms = run_to_handoff(&mut h, &t, &a, &mut pos, speed, &mut since_obs);
            let end_err = handoff_ms - a_end_ms;
            let floor_late = (start_ms + ms(COMPRESS_FLOOR) - a_end_ms).max(0.0);
            // a lateness below COMPRESS_MIN_GAIN (+ the raw estimate's ½ frame) is left alone;
            // measured over the 60 seeds: −4.6…+10.8 ms (RED, uncompressed: up to +391 ms)
            assert!(
                end_err > -20.0 && end_err < floor_late + ms(COMPRESS_MIN_GAIN) + 5.0,
                "seed {seed}: the effect ENDS {end_err:+.0} ms vs A's end (A at {speed:.2}x, \
                 started {err:+.0} ms late)"
            );
        }
    }

    /// Drive a full-live `align: end` transition (A playing at `speed`, `time_pos` observed
    /// every 100 ms) until its handoff; returns the handoff instant (ms, player clock).
    fn run_to_handoff(
        h: &mut H,
        t: &CorrId,
        a: &str,
        pos: &mut f64,
        speed: f64,
        since_obs: &mut u64,
    ) -> f64 {
        for _ in 0..10_000 {
            h.tick(4, &[]);
            *pos += 0.004 * speed;
            *since_obs += 4;
            if *since_obs >= 100 {
                *since_obs = 0;
                let dur = get_f64(&h.g, a, "duration").unwrap_or(0.0);
                h.observe(a, "time_pos", PropValue::F64(pos.min(dur)));
            }
            if let Some(at) = h.events.iter().find_map(|e| match &e.kind {
                TransitionEventKind::Handoff { .. } if &e.corr == t => Some(e.at_ms),
                _ => None,
            }) {
                return at;
            }
        }
        panic!("no handoff")
    }

    /// A synthetic playing A for the compression tests: its media position advances by the
    /// wall delta × speed, `time_pos` is observed every 100 ms (the rate-limited `Position`).
    struct PlayA {
        id: String,
        dur: f64,
        pos: f64,
        speed: f64,
        since_obs: u64,
    }

    impl PlayA {
        fn new(h: &mut H, dur: f64, pos: f64) -> PlayA {
            let id = h.video(&["V1"], dur, pos);
            PlayA {
                id,
                dur,
                pos,
                speed: 1.0,
                since_obs: 0,
            }
        }
        fn tick(&mut self, h: &mut H) {
            h.tick(4, &[]);
            self.pos = (self.pos + 0.004 * self.speed).min(self.dur);
            self.since_obs += 4;
            if self.since_obs >= 100 {
                self.since_obs = 0;
                h.observe(&self.id, "time_pos", PropValue::F64(self.pos));
            }
        }
        fn set_speed(&mut self, h: &mut H, s: f64) {
            self.speed = s;
            h.g.set(&path(&self.id, "speed"), PropValue::F64(s))
                .unwrap();
        }
        /// A's real end (ms, player clock) at its current speed.
        fn end_ms(&self, h: &H) -> f64 {
            secs(h.now) * 1000.0 + (self.dur - self.pos) / self.speed * 1000.0
        }
    }

    fn event_ms(h: &H, t: &CorrId, name: &str) -> Option<f64> {
        h.events
            .iter()
            .find(|e| &e.corr == t && e.kind.name() == name)
            .map(|e| e.at_ms)
    }

    /// Starts a 2 s full-live `align: end` fade onto a ready B over `a`.
    fn start_end_fade(h: &mut H) -> (CorrId, String) {
        let mut r = req("/b.mkv", "full-live", "end", Some("fade"));
        r["duration_ms"] = json!(2000);
        let t = h.start(r);
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(4, &[(b.clone(), SourceEvent::Ready)]);
        (t, b)
    }

    /// TODO "A speed-up inside the last D of an `align:end` wait / a global speed change
    /// mid-effect": A sped up 4× half a second into a 2 s full-live effect (its end moves
    /// from +1.5 s to +0.375 s) — the effect's REMAINING progress and both gain ramps are
    /// compressed to A's new end, continuously (no jump in `progress` or A's gain). RED
    /// before: the handoff came at t0 + 2 s, 1.11 s after A ended (A frozen on its last
    /// frame, still audible).
    #[test]
    fn align_end_speed_up_mid_effect_compresses_to_a_end() {
        let mut h = H::new(&["V1"]);
        let mut a = PlayA::new(&mut h, 10.0, 6.0);
        let (t, b) = start_end_fade(&mut h);
        let mut prev: Option<(f64, f64)> = None; // (progress, A xfade dB)
        let (mut max_dp, mut max_dg, mut sped) = (0.0f64, 0.0f64, None);
        while event_ms(&h, &t, "transition.handoff").is_none() {
            a.tick(&mut h);
            let Some(start) = event_ms(&h, &t, "transition.started") else {
                prev = None;
                continue;
            };
            if sped.is_none() && secs(h.now) * 1000.0 >= start + 500.0 {
                a.set_speed(&mut h, 4.0);
                sped = Some(a.end_ms(&h));
            }
            let fx = get_str(&h.g, "lay:V1:main", "content");
            if let Some(p) = get_f64(&h.g, &fx, "progress") {
                // linear amplitude: dB changes without bound towards silence
                let lin = db_to_lin(gain_db(&h.g, &a.id, "xfade"));
                if let Some((pp, pl)) = prev {
                    max_dp = max_dp.max((p - pp).abs());
                    max_dg = max_dg.max((lin - pl).abs());
                }
                prev = Some((p, lin));
            }
            assert!(secs(h.now) < 30.0, "no handoff");
        }
        let a_end = sped.expect("never sped up");
        let handoff = event_ms(&h, &t, "transition.handoff").unwrap();
        let err = handoff - a_end;
        assert!(
            err > -20.0 && err < 12.0,
            "the effect ends {err:+.0} ms vs A's end (RED: +1113)"
        );
        // compressed: 0.75 of progress over 375 ms ≈ 0.008 per tick (a restart would jump)
        assert!(
            max_dp < 0.02,
            "progress jumped by {max_dp:.3} in one 4 ms tick"
        );
        assert!(
            max_dg < 0.03,
            "A's xfade jumped by {max_dg:.3} (linear) in one 4 ms tick"
        );
        assert_eq!(
            h.anim.target_of(&path(&b, "gain.xfade")).map(|v| v.round()),
            Some(0.0),
            "B ramps in to 0 dB"
        );
        assert!(
            h.anim
                .value_at(
                    &path(&b, "gain.xfade"),
                    Duration::from_secs_f64(a_end / 1000.0 + 0.012)
                )
                .is_some_and(|v| v > -0.01),
            "B's ramp-in is complete by A's end"
        );
    }

    /// The same speed-up 0.3 s before the planned start (A's end moves from +2.3 s to
    /// +0.575 s — the start instant, end − D, is now 1.4 s in the past): the effect starts at
    /// once and runs compressed, ending with A. RED before: it ran the full 2 s, ending
    /// 1.43 s after A.
    #[test]
    fn align_end_speed_up_inside_last_d_of_the_wait_ends_with_a() {
        let mut h = H::new(&["V1"]);
        let mut a = PlayA::new(&mut h, 10.0, 5.0);
        let (t, _b) = start_end_fade(&mut h);
        while a.pos < 7.7 {
            a.tick(&mut h);
        }
        assert!(
            event_ms(&h, &t, "transition.started").is_none(),
            "waits for end − D"
        );
        a.set_speed(&mut h, 4.0);
        let a_end = a.end_ms(&h);
        while event_ms(&h, &t, "transition.handoff").is_none() {
            a.tick(&mut h);
            assert!(secs(h.now) < 30.0, "no handoff");
        }
        let handoff = event_ms(&h, &t, "transition.handoff").unwrap();
        let err = handoff - a_end;
        assert!(
            err > -20.0 && err < 12.0,
            "the effect ends {err:+.0} ms vs A's end (RED: +1426)"
        );
    }

    /// What compression must NOT change: an A already shorter than D when the effect
    /// starts keeps its designed last-frame hold (only a later move of A's end shortens the
    /// effect, by that move), and a slow-down never stretches an effect past D.
    #[test]
    fn align_end_compression_keeps_the_hold_and_never_stretches() {
        // A has 0.5 s left: the 2 s effect starts at once and A holds its last 1.5 s
        let mut h = H::new(&["V1"]);
        let mut a = PlayA::new(&mut h, 10.0, 9.5);
        let (t, _b) = start_end_fade(&mut h);
        let start = event_ms(&h, &t, "transition.started").expect("starts at once");
        while event_ms(&h, &t, "transition.handoff").is_none() {
            a.tick(&mut h);
        }
        let d = event_ms(&h, &t, "transition.handoff").unwrap() - start;
        assert!((d - 2000.0).abs() < 6.0, "short A: full D ({d:.0} ms)");

        // …the same, sped up 4× 100 ms in: A's end moves 300 ms earlier → so does the effect's
        let mut h = H::new(&["V1"]);
        let mut a = PlayA::new(&mut h, 10.0, 9.5);
        let (t, _b) = start_end_fade(&mut h);
        let start = event_ms(&h, &t, "transition.started").unwrap();
        while secs(h.now) * 1000.0 < start + 100.0 {
            a.tick(&mut h);
        }
        let before = a.end_ms(&h);
        a.set_speed(&mut h, 4.0);
        let moved = before - a.end_ms(&h);
        while event_ms(&h, &t, "transition.handoff").is_none() {
            a.tick(&mut h);
        }
        let d = event_ms(&h, &t, "transition.handoff").unwrap() - start;
        let e = d - (2000.0 - moved);
        assert!(
            e > -20.0 && e < 12.0,
            "short A sped up: D − {moved:.0} ms, got {d:.0} ms"
        );

        // on schedule, slowed to 0.5× mid-effect: still D (B is fully shown at its end)
        let mut h = H::new(&["V1"]);
        let mut a = PlayA::new(&mut h, 10.0, 6.0);
        let (t, _b) = start_end_fade(&mut h);
        while event_ms(&h, &t, "transition.started").is_none() {
            a.tick(&mut h);
        }
        let start = event_ms(&h, &t, "transition.started").unwrap();
        while secs(h.now) * 1000.0 < start + 500.0 {
            a.tick(&mut h);
        }
        a.set_speed(&mut h, 0.5);
        while event_ms(&h, &t, "transition.handoff").is_none() {
            a.tick(&mut h);
        }
        let d = event_ms(&h, &t, "transition.handoff").unwrap() - start;
        assert!(
            (d - 2000.0).abs() < 6.0,
            "slow-down: never stretched ({d:.0} ms)"
        );
    }

    /// M2: an A that errors mid-file counts as ended for alignment (it makes no more
    /// sound and holds its last frame) — the switch starts at once.
    #[test]
    fn align_end_a_error_counts_as_ended() {
        let mut h = H::new(&["V1"]);
        let a = h.video(&["V1"], 10.0, 2.0);
        let t = h.start(req("/b.mkv", "full-live", "end", None));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        assert!(!h.has(&t, "transition.started"));
        h.tick(
            16,
            &[(
                a.clone(),
                SourceEvent::Error {
                    reason: "decode".into(),
                },
            )],
        );
        h.tick(16, &[]);
        assert!(h.has(&t, "transition.started"));
    }

    /// Item 7: after a natural reveal handoff the held (paused) A is destroyed in the same
    /// iteration — never a paused source outside any held method.
    #[test]
    fn held_a_destroyed_at_handoff() {
        let mut h = H::new(&["V1"]);
        let a = h.video(&["V1"], 10.0, 1.0);
        let t = h.start(req("/b.mkv", "reveal", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        let snap =
            h.g.ids_of(NodeKind::Source)
                .into_iter()
                .find(|s| get_str(&h.g, s, "kind") == "snapshot")
                .expect("snapshot");
        h.observe(&snap, "ready", PropValue::Bool(true));
        h.tick(16, &[]);
        assert!(h.has(&t, "transition.started"));
        h.tick(100, &[]);
        assert!(h.bool(&a, "paused"), "A held");
        h.tick(500, &[]);
        assert!(h.has(&t, "transition.handoff"));
        assert!(
            h.g.kind_of(&a).is_none(),
            "held A destroyed in the handoff iteration"
        );
        assert!(h.g.kind_of(&snap).is_none());
    }

    /// Task 16b: `note_gain`'s R41 bookkeeping must use `Animator::live_target_of`, not
    /// `target_of` — a *finished* animation's stale target must never win over a later
    /// direct `set` on the same path. A's `gain.xfade` is animated to −20 dB and left to
    /// finish, then `set` directly to −6 dB (e.g. a settings change); starting a
    /// (non-shared) full-live transition records A's `gain.xfade` for restore, and
    /// cancelling it must restore −6 dB, never the stale −20 dB target.
    #[test]
    fn restore_uses_live_target_not_a_stale_finished_one() {
        let mut h = H::new(&["V1"]);
        let a = h.video(&["V1"], 10.0, 1.0);

        h.anim.add(Animation {
            target: path(&a, "gain.xfade"),
            from: 1.0,
            to: db_to_lin(-20.0),
            start: Duration::ZERO,
            duration: Duration::from_millis(100),
            curve: Curve::Linear,
            unit: AnimUnit::GainLinear,
            corr: None,
        });
        h.tick(200, &[]); // past the ramp's end: finished, holding −20 dB
        assert!((gain_db(&h.g, &a, "xfade") - (-20.0)).abs() < 1e-6);
        // A direct `set` after the ramp finished — e.g. a settings change — must win.
        h.g.set(&path(&a, "gain.xfade"), PropValue::F64(-6.0))
            .unwrap();
        assert!((gain_db(&h.g, &a, "xfade") - (-6.0)).abs() < 1e-9);

        let t = h.start(req("/b.mkv", "full-live", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        assert!(
            h.has(&t, "transition.started"),
            "full-live + now starts at once"
        );

        h.tr.cancel(&t, &mut h.g, &mut h.anim, h.now).unwrap();
        h.changes.extend(h.g.drain_changes());
        h.events.extend(h.tr.drain_events());
        h.tick(50, &[]); // past the 30 ms snap-back ramp

        let restored = gain_db(&h.g, &a, "xfade");
        assert!(
            (restored - (-6.0)).abs() < 0.5,
            "restore must land at the −6 dB direct set, not the stale −20 dB finished \
             target: {restored}"
        );
    }

    /// R85 (Task 16c): `frozen`'s B un-pauses at handoff with essentially zero lead time
    /// for real audio — its anticlick ramp-in must not start (no `Animator` target at
    /// all) until `SourceEvent::AudioFlowing` confirms it, even though the picture/graph
    /// clock has already moved well past the nominal handoff instant.
    #[test]
    fn frozen_onset_waits_for_audio_flowing() {
        let mut h = H::new(&["V1"]);
        let _a = h.video(&["V1"], 10.0, 1.0);
        let t = h.start(req("/b.mkv", "frozen", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        let snap =
            h.g.ids_of(NodeKind::Source)
                .into_iter()
                .find(|s| get_str(&h.g, s, "kind") == "snapshot")
                .expect("snapshot");
        h.observe(&snap, "ready", PropValue::Bool(true));
        h.tick(16, &[]);
        assert!(h.has(&t, "transition.started"));
        h.tick(600, &[]); // past duration_ms = 500: handoff fires
        assert!(h.has(&t, "transition.handoff"));
        assert!(!h.bool(&b, "paused"), "B un-paused at handoff");
        assert_eq!(
            gain_db(&h.g, &b, "anticlick"),
            SILENT_DB,
            "silent until real audio confirms"
        );
        assert_eq!(
            h.anim.target_of(&path(&b, "gain.anticlick")),
            None,
            "no ramp scheduled yet — un-pause alone must never start it"
        );
        assert!(
            !h.has(&t, "transition.done"),
            "done waits for the onset too"
        );

        // A few more ticks with no confirmation yet: still silent, still no ramp.
        h.tick(50, &[]);
        assert_eq!(gain_db(&h.g, &b, "anticlick"), SILENT_DB);
        assert_eq!(h.anim.target_of(&path(&b, "gain.anticlick")), None);

        // Real audio confirms: the ramp starts now (not backdated to the handoff instant).
        h.tick(5, &[(b.clone(), SourceEvent::AudioFlowing)]);
        assert_eq!(
            h.anim.target_of(&path(&b, "gain.anticlick")),
            Some(0.0),
            "the ramp is scheduled the instant audio is confirmed flowing"
        );
        h.tick(40, &[]); // past the 30 ms ramp
        assert!((gain_db(&h.g, &b, "anticlick") - 0.0).abs() < 1e-6);
        assert!(h.has(&t, "transition.done"), "done once the onset resolved");
    }

    /// R85: unconfirmed past [`ONSET_TIMEOUT`], the onset ramps anyway rather than holding
    /// the transition's `done` open forever.
    #[test]
    fn onset_timeout_ramps_anyway() {
        let mut h = H::new(&["V1"]);
        let _a = h.video(&["V1"], 10.0, 1.0);
        let t = h.start(req("/b.mkv", "frozen", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        let snap =
            h.g.ids_of(NodeKind::Source)
                .into_iter()
                .find(|s| get_str(&h.g, s, "kind") == "snapshot")
                .expect("snapshot");
        h.observe(&snap, "ready", PropValue::Bool(true));
        h.tick(16, &[]);
        h.tick(600, &[]); // handoff
        assert!(h.has(&t, "transition.handoff"));
        assert_eq!(h.anim.target_of(&path(&b, "gain.anticlick")), None);

        // No AudioFlowing ever arrives: past ONSET_TIMEOUT it ramps anyway.
        h.tick(200, &[]);
        assert_eq!(
            h.anim.target_of(&path(&b, "gain.anticlick")),
            Some(0.0),
            "timed out — ramps unconfirmed rather than holding forever"
        );
    }

    /// R92 (review of Task 16c/16d): a video `kind` that mpv itself resolved to have
    /// **no audio track at all** (`has_audio` observed `false` — distinct from
    /// `no_audio`, our own request) must skip the onset wait entirely, exactly like a
    /// colour/image B — `b_has_audio` must be false for it, so `schedule_onset` never
    /// creates a `PendingOnset` in the first place. Before this fix, `b_has_audio` only
    /// checked `kind == "video" && !no_audio`, which is true here too — the ramp would
    /// have stayed `None` (held) until `ONSET_TIMEOUT` (150 ms) elapsed and a
    /// `transition.onset_timeout` warning fired, every single time, for a file that was
    /// never going to send `AudioFlowing` at all. The fix's evidence is the *absence* of
    /// that wait: unlike `onset_timeout_ramps_anyway` above (which needs a 200 ms tick to
    /// reach the same final state), this reaches it on the very same tick as handoff.
    #[test]
    fn b_has_audio_false_skips_onset_wait_entirely() {
        let mut h = H::new(&["V1"]);
        let _a = h.video(&["V1"], 10.0, 1.0);
        let t = h.start(req("/b.mkv", "frozen", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.observe(&b, "has_audio", PropValue::Bool(false));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        let snap =
            h.g.ids_of(NodeKind::Source)
                .into_iter()
                .find(|s| get_str(&h.g, s, "kind") == "snapshot")
                .expect("snapshot");
        h.observe(&snap, "ready", PropValue::Bool(true));
        h.tick(16, &[]);
        h.tick(600, &[]); // handoff — no further ticks needed before the assertions below
        assert!(h.has(&t, "transition.handoff"));
        assert!(!h.bool(&b, "paused"), "B un-paused at handoff");
        assert_eq!(
            h.anim.target_of(&path(&b, "gain.anticlick")),
            Some(0.0),
            "no audio track: the ramp is scheduled immediately, same tick as handoff — \
             never held behind a PendingOnset waiting for AudioFlowing"
        );
        h.tick(ANTICLICK.as_millis() as u64 + 1, &[]);
        assert!(
            h.has(&t, "transition.done"),
            "done must not wait on an onset that was never scheduled"
        );
    }

    /// R85: `full-live`/`reveal` un-pause B at `Running`'s very start (effect duration
    /// ahead as lead time) — the same held-onset treatment applies there too.
    #[test]
    fn full_live_onset_waits_for_audio_flowing() {
        let mut h = H::new(&["V1"]);
        let _a = h.video(&["V1"], 10.0, 1.0);
        let t = h.start(req("/b.mkv", "full-live", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        assert!(h.has(&t, "transition.started"));
        assert!(!h.bool(&b, "paused"), "un-paused immediately at Running");
        assert_eq!(gain_db(&h.g, &b, "xfade"), SILENT_DB);
        assert_eq!(h.anim.target_of(&path(&b, "gain.xfade")), None);

        h.tick(5, &[(b.clone(), SourceEvent::AudioFlowing)]);
        assert_eq!(h.anim.target_of(&path(&b, "gain.xfade")), Some(0.0));
    }

    /// Requirement #2 (Task 16c): A's hold-then-pause (reveal/frozen) must not pause until
    /// its anticlick ramp has settled — `ANTICLICK` elapsing alone is not enough; the extra
    /// `AUDIO_SETTLE_TAIL` must pass too.
    #[test]
    fn a_pause_waits_for_audio_settle_tail() {
        let mut h = H::new(&["V1"]);
        let a = h.video(&["V1"], 10.0, 1.0);
        let t = h.start(req("/b.mkv", "reveal", "now", Some("fade")));
        let b = h.b_of(&t);
        h.observe(&b, "ready", PropValue::Bool(true));
        h.tick(16, &[(b.clone(), SourceEvent::Ready)]);
        let snap =
            h.g.ids_of(NodeKind::Source)
                .into_iter()
                .find(|s| get_str(&h.g, s, "kind") == "snapshot")
                .expect("snapshot");
        h.observe(&snap, "ready", PropValue::Bool(true));
        h.tick(16, &[]); // Running begins (t0 = now = 32 ms)
        assert!(h.has(&t, "transition.started"));

        h.tick(31, &[]); // now = 63: past the 30 ms ramp, before the settle tail (+15 ms)
        assert_eq!(gain_db(&h.g, &a, "anticlick"), SILENT_DB, "ramp is done");
        assert!(
            !h.bool(&a, "paused"),
            "must not pause until the settle tail elapses too"
        );

        h.tick(20, &[]); // now = 83: past ANTICLICK + AUDIO_SETTLE_TAIL (77)
        assert!(h.bool(&a, "paused"), "settle tail elapsed: paused now");
    }
}
