//! Programs (spec §4.2 "Program", §4.3 "Video-end-aligned advance"): a rotation is a graph
//! node `prog:<name>` whose settings are live properties; this recipe reads it and, on the
//! player clock, requests `transition`s on its outputs — which item, which effect, when. It
//! never renders and never touches a source.
//!
//! - [`rule`] — the per-item play rules (minimum / maximum / scene timing) and the
//!   countdown's retime (pure).
//! - [`order`] — the play order: cycles, shuffle, history, random, reorder (pure, seeded).
//! - [`pick`] — the effect / duration / method of one switch (pure, seeded).
//! - [`store`] — `program.json` (configuration + order) and the snapshot's dynamic half.
//! - [`resume`] — per-playlist resume points and the playlist start rules (O4).

pub mod order;
pub mod pick;
pub mod resume;
pub mod rule;
pub mod store;

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::anim::PropPath;
use crate::graph::{ApiError, Graph, ProgramItem, PropValue};
use crate::log::{self, CorrId, Level};
use crate::recipes::transition::{Align, TransitionEvent, TransitionEventKind, TransitionReq};
use crate::sources::SourceEvent;

pub use order::{Order, Step, StepWhy};
pub use pick::{Pick, TransitionCfg};
pub use rule::{ItemRule, NEVER_MS, PlayKind};

/// A small seedable RNG (SplitMix64): a program's shuffles, random picks and effect picks
/// are reproducible from its `seed` (tests pin it). Not for anything secret.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`n > 0`; `0` for `n == 0`), without modulo bias.
    pub fn below(&mut self, n: usize) -> usize {
        if n <= 1 {
            return 0;
        }
        let n = n as u64;
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let x = self.next_u64();
            if x < zone {
                return (x % n) as usize;
            }
        }
    }

    /// Fisher–Yates.
    pub fn shuffle<T>(&mut self, xs: &mut [T]) {
        for i in (1..xs.len()).rev() {
            let j = self.below(i + 1);
            xs.swap(i, j);
        }
    }
}

// ---------------------------------------------------------------- the program nodes

/// The failure ladder (designer call 8): the backoff after the n-th switch failure in a row,
/// then 30 s for as long as failures continue. A handoff resets it.
pub const BACKOFF_MS: [u64; 6] = [1000, 2000, 4000, 8000, 16000, 30000];

/// While parked under `while_parked: rotate`, a program switches no sooner than this after
/// its last commit: a parked switch commits at once (nothing to wait for), so a rule that
/// is reached at once (an image with minimum 0) would otherwise switch every tick. The
/// backend's tick polled ≤ 1 s apart.
pub const PARKED_MIN_PLAY_MS: f64 = 1000.0;

/// What a program is doing (`prog:<id>.phase`, `state.programs[].phase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgPhase {
    /// Nothing played yet (or what plays isn't one of its items): waits for a verb.
    Idle,
    Playing,
    /// A video held below its minimum play time (the request goes in during the loop that
    /// reaches it).
    Holding,
    /// An end-of-video switch is requested (`align: end`) and waits for A's end.
    Armed,
    /// A switch is requested and not started yet.
    Switching,
    /// Failed switches in a row: waiting out the backoff.
    Backoff,
    /// No output exists (R60): the program's item is parked.
    Parked,
    /// Nothing playable.
    Empty,
}

impl ProgPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            ProgPhase::Idle => "idle",
            ProgPhase::Playing => "playing",
            ProgPhase::Holding => "holding",
            ProgPhase::Armed => "armed",
            ProgPhase::Switching => "switching",
            ProgPhase::Backoff => "backoff",
            ProgPhase::Parked => "parked",
            ProgPhase::Empty => "empty",
        }
    }
}

/// One program as `state.programs[]` reports it (the `programs` probe adds each item's
/// flags).
#[derive(Debug, Clone, Serialize)]
pub struct ProgramStatus {
    pub id: String,
    pub phase: ProgPhase,
    /// What plays (its item path), `null` before the first play.
    pub path: Option<String>,
    /// Its place in `items` (−1 = none).
    pub index: i64,
    /// The switch requested (armed or in flight): its path.
    pub next: Option<String>,
    /// That switch's transition corr.
    pub corr: Option<String>,
    pub armed_align: Option<Align>,
    /// How many items.
    pub items: usize,
    /// The play order (a shuffle cycle's order when shuffled).
    pub order: Vec<String>,
    pub history: Vec<String>,
    pub history_index: usize,
    pub played_ms: f64,
    pub remaining_ms: f64,
    pub backoff_ms: u64,
    pub failures: u32,
    pub last_effect: Option<String>,
    /// Items marked broken (a broken scene): passed over from then on.
    pub broken: Vec<String>,
}

/// A program's configuration, read from its node's settable props.
#[derive(Debug, Clone, PartialEq)]
pub struct ProgCfg {
    pub outputs: String,
    pub items: Vec<ProgramItem>,
    pub defaults: Map<String, Value>,
    pub shuffle: bool,
    /// `mode: on_end` ("Switch when video ends"); `false` = the plain timer.
    pub on_end: bool,
    pub interval_ms: u64,
    pub max_ms: u64,
    pub separate_scenes: bool,
    pub scenes_after_ms: u64,
    pub transition: TransitionCfg,
    pub seed: u64,
    /// `while_parked: hold` — both clocks stop while no output shows the item (O2).
    pub hold_parked: bool,
    /// The playlist's identity (its resume point's key; "" = none).
    pub key: String,
    /// `start_mode: resume` ("When the playlist starts again": resume where it left off).
    pub start_resume: bool,
}

impl ProgCfg {
    /// The node's props (already schema-checked by the graph).
    pub fn read(g: &Graph, id: &str) -> Option<ProgCfg> {
        let props: BTreeMap<String, PropValue> = g.props_of(id)?.into_iter().collect();
        let s = |k: &str| match props.get(k) {
            Some(PropValue::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let ms = |k: &str| match props.get(k) {
            Some(PropValue::F64(f)) => f.max(0.0).round() as u64,
            Some(PropValue::I64(i)) => (*i).max(0) as u64,
            _ => 0,
        };
        let map = |k: &str| match props.get(k) {
            Some(PropValue::Map(m)) => m.clone(),
            _ => Map::new(),
        };
        Some(ProgCfg {
            outputs: s("outputs"),
            items: match props.get("items") {
                Some(PropValue::Items(v)) => v.clone(),
                _ => Vec::new(),
            },
            defaults: map("defaults"),
            shuffle: s("order") == "shuffle",
            on_end: s("mode") != "timer",
            interval_ms: ms("interval_ms"),
            max_ms: ms("max_ms"),
            separate_scenes: !matches!(props.get("separate_scenes"), Some(PropValue::Bool(false))),
            scenes_after_ms: ms("scenes_after_ms"),
            transition: TransitionCfg::from_map(&map("transition")).unwrap_or_default(),
            seed: match props.get("seed") {
                Some(PropValue::I64(i)) => *i as u64,
                _ => 0,
            },
            hold_parked: s("while_parked") == "hold",
            key: s("key"),
            start_resume: s("start_mode") == "resume",
        })
    }

    pub fn paths(&self) -> Vec<String> {
        self.items.iter().map(|i| i.path.clone()).collect()
    }
}

/// A rotation's play clock: the player clock's advance since the last tick
/// (`Runtime::now` — monotonic, `CLOCK_MONOTONIC`-based, so it excludes suspend, and
/// pause-excised). Play time and the countdown add exactly this; a wall-clock jump never
/// reaches them.
#[derive(Debug, Clone, Default)]
pub struct PlayClock {
    last: Option<Duration>,
}

impl PlayClock {
    /// The player-clock time since the previous call (zero on the first).
    pub fn advance(&mut self, now: Duration) -> Duration {
        let d = self.last.map(|l| now.saturating_sub(l)).unwrap_or_default();
        self.last = Some(now);
        d
    }
}

/// Why a program switched (`program.current.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Play,
    Timer,
    End,
    Max,
    ScenesAfter,
    Next,
    Prev,
    Random,
    Broken,
    Vram,
    FailedSkip,
    Items,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Play => "play",
            Reason::Timer => "timer",
            Reason::End => "end",
            Reason::Max => "max",
            Reason::ScenesAfter => "scenes_after",
            Reason::Next => "next",
            Reason::Prev => "prev",
            Reason::Random => "random",
            Reason::Broken => "broken",
            Reason::Vram => "vram",
            Reason::FailedSkip => "failed_skip",
            Reason::Items => "items",
        }
    }
}

/// An action the runtime runs for a program (never a second code path: `Start` goes through
/// `Transitions::start`, or `Runtime::transition_parked` with no output).
#[derive(Debug)]
pub enum ProgramAction {
    /// Request this switch; the runtime reports its corr back ([`Programs::on_requested`]).
    Start {
        id: String,
        req: TransitionReq,
        step: Step,
        reason: Reason,
    },
    /// Cancel a pre-Running switch (the abort restores A's loop).
    Cancel { corr: CorrId },
}

/// A switch requested and not started yet.
#[derive(Debug, Clone)]
struct Pending {
    /// `None` until the runtime reports it ([`Programs::on_requested`]).
    corr: Option<CorrId>,
    step: Step,
    reason: Reason,
    align: Align,
    /// A resumed start: the play time and countdown B starts with (`None` = 0 and a full
    /// interval).
    resume: Option<(f64, Option<f64>)>,
}

/// One program's live state.
#[derive(Debug)]
struct Prog {
    cfg: ProgCfg,
    /// Paths with `skip: true`.
    skips: BTreeSet<String>,
    order: Order,
    rng: Rng,
    /// A play happened and the program follows what it shows.
    started: bool,
    /// The source showing the current item (B of the last committed switch).
    cur_src: Option<String>,
    /// The committed switch while its effect runs (until its handoff).
    running: Option<CorrId>,
    pending: Option<Pending>,
    /// An armed switch cancelled by a live edit (a new minimum or transition): the next
    /// arm goes to this same B.
    rearm: Option<Step>,
    /// A video held below its minimum (`program.held` logged).
    held: bool,
    clock: PlayClock,
    played_ms: f64,
    remaining_ms: f64,
    last_effect: Option<String>,
    failures: u32,
    backoff_ms: u64,
    /// The backoff's end and the reason the switch after it gets.
    backoff_until: Option<Duration>,
    /// Items whose switch failed (passed over until the items change, or every item failed).
    failed: BTreeSet<String>,
    /// Items whose source broke (a broken scene; passed over from then on).
    broken: BTreeSet<String>,
    empty_logged: bool,
    parked: bool,
    /// The play order changed by itself (a cycle's reshuffle): `program.json` is due.
    def_changed: bool,
    /// The key whose playlist plays now (set by a play; its resume point is put when the
    /// key changes).
    playing_key: Option<String>,
    /// Where the next requested B starts (a resumed start), seconds.
    start_position: Option<f64>,
}

fn no_program(id: &str) -> ApiError {
    ApiError {
        code: "no_such_node",
        message: format!("no program {id:?}"),
        hint: "`liascape-player ctl state` lists the programs (`state.programs`)".to_string(),
    }
}

fn empty_program(id: &str) -> ApiError {
    ApiError {
        code: "unsupported",
        message: format!("empty program {id:?}: it has no items"),
        hint: "set its items (`set prog:<name>.items`); `liascape-player ctl probe \
               '{\"name\":\"programs\"}'` shows each program"
            .to_string(),
    }
}

fn src_str(g: &Graph, id: &str, prop: &str) -> String {
    match g.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::Str(s)) => s,
        _ => String::new(),
    }
}

fn src_f64(g: &Graph, id: &str, prop: &str) -> Option<f64> {
    match g.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::F64(f)) => Some(f),
        Ok(PropValue::I64(i)) => Some(i as f64),
        _ => None,
    }
}

/// What the source plays, for its rule (`PlayerHelper.PlayKindOf`): the graph's `kind`
/// (the live source corrects an image's), else the path's extension.
fn play_kind(g: &Graph, src: &str) -> PlayKind {
    match src_str(g, src, "kind").as_str() {
        "scene" => PlayKind::Scene,
        "image" | "color" | "snapshot" => PlayKind::Image,
        "video" if crate::sources::mpv::infer_kind(&src_str(g, src, "path")) == "image" => {
            PlayKind::Image
        }
        _ => PlayKind::Video,
    }
}

/// What is left of the source's current loop, wall clock at its speed (ms); `None` = no
/// end known yet (`LiascapePlayerMedia.TimeRemaining`).
fn loop_remaining_ms(g: &Graph, src: &str) -> Option<u64> {
    let dur = src_f64(g, src, "duration").filter(|d| *d > 0.0)?;
    let tp = src_f64(g, src, "time_pos").unwrap_or(0.0);
    let speed = src_f64(g, src, "speed").filter(|s| *s > 0.0).unwrap_or(1.0);
    Some((((dur - tp).max(0.0) / speed) * 1000.0) as u64)
}

impl Prog {
    fn new(cfg: ProgCfg) -> Prog {
        let skips = cfg
            .items
            .iter()
            .filter(|i| i.skip)
            .map(|i| i.path.clone())
            .collect();
        let order = Order::new(cfg.paths(), 0, cfg.shuffle);
        let rng = Rng::new(cfg.seed);
        Prog {
            cfg,
            skips,
            order,
            rng,
            started: false,
            cur_src: None,
            running: None,
            pending: None,
            rearm: None,
            held: false,
            clock: PlayClock::default(),
            played_ms: 0.0,
            remaining_ms: 0.0,
            last_effect: None,
            failures: 0,
            backoff_ms: 0,
            backoff_until: None,
            failed: BTreeSet::new(),
            broken: BTreeSet::new(),
            empty_logged: false,
            parked: false,
            def_changed: false,
            playing_key: None,
            start_position: None,
        }
    }

    fn can_rotate(&self) -> bool {
        self.cfg.items.len() > 1
    }

    fn index_of(&self, path: &str) -> i64 {
        self.cfg
            .items
            .iter()
            .position(|i| i.path == path)
            .map(|i| i as i64)
            .unwrap_or(-1)
    }

    fn phase(&self) -> ProgPhase {
        if !self.started {
            return ProgPhase::Idle;
        }
        if self.backoff_until.is_some() {
            return ProgPhase::Backoff;
        }
        if let Some(p) = &self.pending {
            return match p.align {
                Align::End => ProgPhase::Armed,
                Align::Now => ProgPhase::Switching,
            };
        }
        if self.empty_logged {
            return ProgPhase::Empty;
        }
        if self.parked {
            return ProgPhase::Parked;
        }
        if self.held {
            return ProgPhase::Holding;
        }
        ProgPhase::Playing
    }

    /// The order's next playable item (`None` = nothing playable: `program.empty` once). A
    /// stretch where every playable item failed logs `empty` and starts the ladder over them
    /// again (the backoff keeps it from spinning).
    fn plan_next(&mut self, id: &str, now: Duration) -> Option<Step> {
        self.plan_next_from(id, now, None)
    }

    /// Whether `path` is passed over (`skip`, broken, failed).
    fn skipped(&self, path: &str) -> bool {
        self.skips.contains(path) || self.broken.contains(path) || self.failed.contains(path)
    }

    /// [`Prog::plan_next`], from the order as it will be once `after` commits (a switch
    /// still on its way: [`Order::plan_after`]).
    fn plan_next_from(&mut self, id: &str, now: Duration, after: Option<&Step>) -> Option<Step> {
        let (skips, broken, failed) = (&self.skips, &self.broken, &self.failed);
        let skip = |p: &str| skips.contains(p) || broken.contains(p) || failed.contains(p);
        let rng = &mut self.rng;
        let planned = match after {
            Some(prev) => self.order.plan_after(prev, |o| o.plan_next(&skip, rng)),
            None => self.order.plan_next(&skip, rng),
        };
        if let Some(s) = planned {
            return Some(s);
        }
        if !self.empty_logged {
            self.empty_logged = true;
            log::event(
                "program",
                Level::Warn,
                "program.empty",
                None,
                json!({ "id": id }),
            );
        }
        if !self.failed.is_empty() {
            // every playable item failed: retry them, at the ladder's pace
            self.failed.clear();
            if self.backoff_until.is_none() {
                self.backoff_until = Some(now + Duration::from_millis(self.backoff_ms.max(1000)));
            }
        }
        None
    }

    /// The rotation's next switch: the B of an armed switch a live edit cancelled (it is
    /// re-armed to the same B while it is still a playable item), else [`Prog::plan_next`].
    fn take_next(&mut self, id: &str, now: Duration) -> Option<Step> {
        if let Some(s) = self.rearm.take()
            && self.index_of(&s.path) >= 0
            && !self.skipped(&s.path)
        {
            return Some(s);
        }
        self.plan_next(id, now)
    }

    /// Cancel an armed (`align: end`, not started) switch; its step is returned so a
    /// live edit can re-arm it to the same B.
    fn cancel_armed(&mut self, id: &str, why: &str, acts: &mut Vec<ProgramAction>) -> Option<Step> {
        if !self.pending.as_ref().is_some_and(|p| p.align == Align::End) {
            return None;
        }
        let p = self.pending.take()?;
        log::event(
            "program",
            Level::Debug,
            "program.disarmed",
            p.corr.clone(),
            json!({ "id": id, "next": p.step.path, "why": why }),
        );
        if let Some(c) = p.corr {
            acts.push(ProgramAction::Cancel { corr: c });
        }
        self.held = false;
        Some(p.step)
    }

    /// B's create props (`defaults` ∪ the item's props, item wins; its path; `loop` while an
    /// on-end minimum may hold it) and the transition picked for it.
    fn request(
        &mut self,
        id: &str,
        step: &Step,
        align: Align,
        cut: bool,
        defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> TransitionReq {
        let mut to = self.cfg.defaults.clone();
        if let Some(item) = self.cfg.items.iter().find(|i| i.path == step.path) {
            for (k, v) in &item.props {
                to.insert(k.clone(), v.clone());
            }
        }
        to.insert("path".into(), Value::String(step.path.clone()));
        if let Some(pos) = self.start_position.take().filter(|p| *p > 0.0) {
            to.insert("position".into(), json!(pos));
        }
        if self.cfg.on_end && self.cfg.interval_ms > 0 && self.can_rotate() {
            // a clip shorter than the minimum loops on until the loop that reaches it
            to.insert("loop".into(), Value::Bool(true));
        }
        let p = pick::pick(
            &self.cfg.transition,
            self.last_effect.as_deref(),
            defaults_of,
            &mut self.rng,
        );
        if let Some(e) = &p.picked {
            self.last_effect = Some(e.clone());
        }
        let (effect_id, params, duration_ms) = if cut {
            (None, Map::new(), 0)
        } else {
            (p.effect_id, p.params, p.duration_ms)
        };
        TransitionReq {
            outputs: self.cfg.outputs.clone(),
            to,
            effect_id,
            params,
            duration_ms,
            method: p.method,
            align,
            origin: format!("program:{id}"),
        }
    }

    fn start(
        &mut self,
        id: &str,
        step: Step,
        reason: Reason,
        align: Align,
        cut: bool,
        defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> ProgramAction {
        let req = self.request(id, &step, align, cut, defaults_of);
        self.pending = Some(Pending {
            corr: None,
            step: step.clone(),
            reason,
            align,
            resume: None,
        });
        self.held = false;
        ProgramAction::Start {
            id: id.to_string(),
            req,
            step,
            reason,
        }
    }

    /// B became current: the step is committed, the play time starts at 0.
    fn commit(&mut self, id: &str, b: Option<String>, corr: &CorrId, g: &Graph, now: Duration) {
        let Some(p) = self.pending.take() else { return };
        let from = self.order.current().map(str::to_string);
        let path = p.step.path.clone();
        self.def_changed |= p.step.reshuffles();
        self.order.commit(p.step);
        self.rearm = None;
        self.cur_src = b;
        let (played, remaining) = p.resume.unwrap_or((0.0, None));
        self.played_ms = played;
        self.remaining_ms = remaining.unwrap_or(self.cfg.interval_ms as f64);
        self.held = false;
        self.empty_logged = false;
        self.started = true;
        log::event(
            "program",
            Level::Info,
            "program.current",
            Some(corr.clone()),
            json!({ "id": id, "index": self.index_of(&path), "path": path, "from": from,
                    "reason": p.reason.as_str(), "corr": corr.0, "resumed": p.resume.is_some(),
                    "at_ms": now.as_secs_f64() * 1000.0,
                    "source": self.cur_src, "source_kind": self.cur_src.as_deref().map(|s| src_str(g, s, "kind")) }),
        );
    }

    /// Where its playlist is now ([`resume::ResumePoint`]): `None` unless it plays an item.
    fn resume_point(&self, g: &Graph) -> Option<resume::ResumePoint> {
        if !self.started {
            return None;
        }
        let path = self.order.current()?.to_string();
        let (history, hist_idx) = self.order.history();
        let time_pos = self
            .cur_src
            .as_deref()
            .and_then(|s| src_f64(g, s, "time_pos"))
            .unwrap_or(0.0);
        Some(resume::ResumePoint {
            order: self.order.items().to_vec(),
            idx: self.order.index(),
            history: history.to_vec(),
            hist_idx,
            path,
            time_pos,
            played_ms: self.played_ms.max(0.0) as u64,
            remaining_ms: self.remaining_ms.max(0.0) as u64,
            last_effect: self.last_effect.clone(),
            saved_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
        })
    }

    fn fail(&mut self, id: &str, path: &str, reason: &str, now: Duration) {
        self.pending = None;
        self.failures += 1;
        self.backoff_ms = BACKOFF_MS[(self.failures as usize - 1).min(BACKOFF_MS.len() - 1)];
        self.backoff_until = Some(now + Duration::from_millis(self.backoff_ms));
        self.failed.insert(path.to_string());
        log::event(
            "program",
            Level::Warn,
            "program.failed",
            None,
            json!({ "id": id, "path": path, "reason": reason, "backoff_ms": self.backoff_ms,
                    "failures": self.failures }),
        );
    }

    fn mark_broken(&mut self, id: &str, path: &str, why: &str) {
        if self.broken.insert(path.to_string()) {
            log::event(
                "program",
                Level::Info,
                "program.skipped",
                None,
                json!({ "id": id, "path": path, "why": why }),
            );
        }
    }

    /// The source the program's first output shows now (`cur:<c>`).
    fn shown(&self, g: &Graph) -> Option<String> {
        let out = g.resolve(&self.cfg.outputs).into_iter().next()?;
        let c = out.strip_prefix("out:")?;
        g.resolve(&format!("cur:{c}")).into_iter().next()
    }

    fn set_observed(&self, id: &str, g: &mut Graph) {
        let path = self.order.current().filter(|_| self.started).unwrap_or("");
        let next = self
            .pending
            .as_ref()
            .map(|p| p.step.path.as_str())
            .unwrap_or("");
        let vals = [
            ("phase", PropValue::Str(self.phase().as_str().to_string())),
            (
                "index",
                PropValue::I64(if path.is_empty() {
                    -1
                } else {
                    self.index_of(path)
                }),
            ),
            ("path", PropValue::Str(path.to_string())),
            ("next_path", PropValue::Str(next.to_string())),
            ("played_ms", PropValue::F64(self.played_ms.round())),
            ("remaining_ms", PropValue::F64(self.remaining_ms.round())),
        ];
        for (k, v) in vals {
            let _ = g.set_observed_on(id, k, v);
        }
    }

    fn status(&self, id: &str) -> ProgramStatus {
        let (history, hi) = self.order.history();
        let path = self
            .order
            .current()
            .filter(|_| self.started)
            .map(str::to_string);
        ProgramStatus {
            id: id.to_string(),
            phase: self.phase(),
            index: path.as_deref().map(|p| self.index_of(p)).unwrap_or(-1),
            path,
            next: self.pending.as_ref().map(|p| p.step.path.clone()),
            corr: self
                .pending
                .as_ref()
                .and_then(|p| p.corr.as_ref())
                .map(|c| c.0.clone()),
            armed_align: self.pending.as_ref().map(|p| p.align),
            items: self.cfg.items.len(),
            order: self.order.items().to_vec(),
            history: history.to_vec(),
            history_index: hi,
            played_ms: self.played_ms.round(),
            remaining_ms: self.remaining_ms.round(),
            backoff_ms: self.backoff_ms,
            failures: self.failures,
            last_effect: self.last_effect.clone(),
            broken: self.broken.iter().cloned().collect(),
        }
    }

    /// One tick of this program (see [`Programs::tick`]).
    #[allow(clippy::too_many_arguments)]
    fn tick(
        &mut self,
        id: &str,
        g: &mut Graph,
        tr_events: &[TransitionEvent],
        src_events: &[(String, SourceEvent)],
        now: Duration,
        parked: bool,
        foreign_busy: bool,
        defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> Vec<ProgramAction> {
        let mut acts = Vec::new();
        let mut dt = self.clock.advance(now).as_secs_f64() * 1000.0;
        self.parked = parked;
        // `while_parked: hold` (O2): both clocks and the rules stop until an output returns
        let frozen = parked && self.cfg.hold_parked;
        if frozen {
            dt = 0.0;
        }
        let cur_before = self.cur_src.clone();

        // 1. the transitions' outcomes
        for ev in tr_events {
            let ours = self
                .pending
                .as_ref()
                .is_some_and(|p| p.corr.as_ref() == Some(&ev.corr));
            match &ev.kind {
                TransitionEventKind::Started { b, .. } if ours => {
                    self.commit(id, Some(b.id.clone()), &ev.corr, g, now);
                    self.running = Some(ev.corr.clone());
                }
                TransitionEventKind::Handoff { to, .. } => {
                    if ours {
                        // a missed `started` (cut short by a newer request)
                        self.commit(id, Some(to.clone()), &ev.corr, g, now);
                    }
                    if ours || self.running.as_ref() == Some(&ev.corr) {
                        self.running = None;
                        self.failures = 0;
                        self.backoff_ms = 0;
                    }
                }
                TransitionEventKind::Cancelled { reason } if ours => {
                    // another client's request or `cancel` (the program's own supersedes
                    // replace `pending` before their events arrive): A stays
                    self.pending = None;
                    self.held = false;
                    if !self.cfg.on_end {
                        self.remaining_ms = self.cfg.interval_ms as f64;
                    }
                    log::event(
                        "program",
                        Level::Debug,
                        "program.request_cancelled",
                        Some(ev.corr.clone()),
                        json!({ "id": id, "reason": reason }),
                    );
                }
                TransitionEventKind::Cancelled { .. }
                    if self.running.as_ref() == Some(&ev.corr) =>
                {
                    self.running = None;
                }
                TransitionEventKind::Failed { path, reason } if ours => {
                    let path = if path.is_empty() {
                        self.pending
                            .as_ref()
                            .map(|p| p.step.path.clone())
                            .unwrap_or_default()
                    } else {
                        path.clone()
                    };
                    self.fail(id, &path, reason, now);
                }
                _ => {}
            }
        }
        if !self.started {
            self.set_observed(id, g);
            return acts;
        }

        // 2. the current item's source broke (a broken scene, a VRAM stop, a dead file)
        let mut broke: Option<Reason> = None;
        if let Some(cur) = self.cur_src.clone() {
            for (sid, ev) in src_events {
                if sid != &cur {
                    continue;
                }
                if let SourceEvent::Error { reason } = ev {
                    let path = self.order.current().unwrap_or("").to_string();
                    if reason.contains("(vram_exceeded)") {
                        broke = Some(Reason::Vram);
                    } else {
                        self.mark_broken(id, &path, "broken");
                        broke = Some(Reason::Broken);
                    }
                }
            }
        }

        // 3. what the outputs show: another client's switch took over
        if broke.is_none()
            && !parked
            && self.pending.is_none()
            && self.running.is_none()
            && let (Some(cur), Some(shown)) = (self.cur_src.clone(), self.shown(g))
            && shown != cur
        {
            let path = src_str(g, &shown, "path");
            self.held = false;
            if self.index_of(&path) >= 0 {
                // an item: it becomes current (the cursor re-seats there)
                if let Some(step) = self.order.plan_play(self.index_of(&path) as usize) {
                    self.pending = Some(Pending {
                        corr: None,
                        step,
                        reason: Reason::Items,
                        align: Align::Now,
                        resume: None,
                    });
                    let corr = CorrId(String::new());
                    self.commit(id, Some(shown), &corr, g, now);
                }
            } else {
                self.started = false;
                self.cur_src = None;
                log::event(
                    "program",
                    Level::Info,
                    "program.idle",
                    None,
                    json!({ "id": id, "shown": path }),
                );
                self.set_observed(id, g);
                return acts;
            }
        }

        // 4. the clocks: play time (wall clock, never speed-scaled) and the countdown (scaled
        // by what plays). B counts from its effect's start — a commit this tick starts at 0.
        if self.cur_src != cur_before {
            dt = 0.0;
        }
        if self.cur_src.is_some() {
            self.played_ms += dt;
            if !self.cfg.on_end {
                let speed = self
                    .cur_src
                    .as_deref()
                    .and_then(|s| src_f64(g, s, "speed"))
                    .filter(|s| *s > 0.0)
                    .unwrap_or(1.0);
                self.remaining_ms -= dt * speed;
            }
        }

        // 5. a broken current item moves on at once
        if let Some(reason) = broke {
            if let Some(p) = self.pending.take()
                && let Some(c) = p.corr
            {
                acts.push(ProgramAction::Cancel { corr: c });
            }
            if let Some(step) = self.plan_next(id, now) {
                acts.push(self.start(id, step, reason, Align::Now, false, defaults_of));
            }
            self.set_observed(id, g);
            return acts;
        }

        // 6. the failure ladder
        if let Some(until) = self.backoff_until {
            if now < until {
                self.set_observed(id, g);
                return acts;
            }
            self.backoff_until = None;
            if self.pending.is_none()
                && let Some(step) = self.plan_next(id, now)
            {
                acts.push(self.start(id, step, Reason::FailedSkip, Align::Now, false, defaults_of));
            }
            self.set_observed(id, g);
            return acts;
        }

        // 7. the rotation rules (player-adapter.md § Rotation); while parked they go on
        // under `rotate` (no sooner than PARKED_MIN_PLAY_MS apart) and stop under `hold`
        let in_flight_now = self.pending.as_ref().is_some_and(|p| p.align == Align::Now);
        let parked_wait = parked && (frozen || self.played_ms < PARKED_MIN_PLAY_MS);
        if !in_flight_now && !foreign_busy && !parked_wait && self.cur_src.is_some() {
            let can_rotate = self.can_rotate();
            let played = self.played_ms.max(0.0) as u64;
            if !self.cfg.on_end {
                // the plain timer ("Switch every"): align now, even mid-video
                if self.cfg.interval_ms > 0 && self.remaining_ms <= 0.0 {
                    if !can_rotate {
                        self.remaining_ms = self.cfg.interval_ms as f64;
                    } else if self.pending.is_none()
                        && let Some(step) = self.take_next(id, now)
                    {
                        acts.push(self.start(
                            id,
                            step,
                            Reason::Timer,
                            Align::Now,
                            false,
                            defaults_of,
                        ));
                    }
                }
            } else {
                let cur = self.cur_src.clone().unwrap_or_default();
                let kind = play_kind(g, &cur);
                let rule = rule::item_rule(
                    kind,
                    self.cfg.interval_ms,
                    self.cfg.max_ms,
                    self.cfg.separate_scenes,
                    self.cfg.scenes_after_ms,
                );
                if rule::max_reached(true, can_rotate, played, rule.max_ms) {
                    // the cap: now, with its transition; an armed end switch's B is taken
                    let armed = self.pending.take();
                    let step = match armed {
                        Some(p) => Some(p.step),
                        None => self.take_next(id, now),
                    };
                    if let Some(step) = step {
                        acts.push(self.start(
                            id,
                            step,
                            Reason::Max,
                            Align::Now,
                            false,
                            defaults_of,
                        ));
                    }
                } else if kind != PlayKind::Video {
                    if self.pending.is_none()
                        && rule::still_min_reached(true, can_rotate, kind, played, rule.min_ms)
                        && let Some(step) = self.take_next(id, now)
                    {
                        let reason = if self.cfg.separate_scenes {
                            Reason::ScenesAfter
                        } else {
                            Reason::End
                        };
                        acts.push(self.start(id, step, reason, Align::Now, false, defaults_of));
                    }
                } else if can_rotate && self.pending.is_none() && self.running.is_none() && !parked
                {
                    // a video: its end, once this loop reaches the minimum
                    if rule::min_reached(played, loop_remaining_ms(g, &cur), rule.min_ms) {
                        if let Some(step) = self.take_next(id, now) {
                            let path = step.path.clone();
                            acts.push(self.start(
                                id,
                                step,
                                Reason::End,
                                Align::End,
                                false,
                                defaults_of,
                            ));
                            log::event(
                                "program",
                                Level::Info,
                                "program.armed",
                                None,
                                json!({ "id": id, "next": path, "align": "end" }),
                            );
                        }
                    } else if !self.held {
                        self.held = true;
                        if !matches!(
                            g.get(&PropPath(format!("{cur}.loop"))),
                            Ok(PropValue::Bool(true))
                        ) {
                            let _ = g.set(&PropPath(format!("{cur}.loop")), PropValue::Bool(true));
                        }
                        log::event(
                            "program",
                            Level::Debug,
                            "program.held",
                            None,
                            json!({ "id": id, "path": self.order.current(),
                                    "until_played_ms": rule.min_ms }),
                        );
                    }
                }
            }
        }
        self.set_observed(id, g);
        acts
    }
}

/// Every live program, by node id.
#[derive(Debug, Default)]
pub struct Programs {
    progs: BTreeMap<String, Prog>,
    /// Every switch a program requested that may still be in flight (to tell another
    /// client's transitions from the programs' own; pruned to the live ones each tick).
    issued: std::collections::HashSet<CorrId>,
    /// A definition (config or play order) changed since `program.json` was last written.
    def_dirty: bool,
    /// `program.json`'s revision (bumped per write; the snapshot's state carries it).
    def_rev: u64,
    /// Per-playlist resume points (`resume.json`) and whether they changed since written.
    resume: resume::ResumeStore,
    resume_dirty: bool,
}

impl Programs {
    /// No program yet — and `program.json` due, so a fresh start never leaves an older
    /// session's file behind for a later `--restore`.
    pub fn new() -> Programs {
        Programs {
            def_dirty: true,
            ..Programs::default()
        }
    }

    /// `program.json` is due (a definition changed since the last write).
    pub fn def_dirty(&self) -> bool {
        self.def_dirty
    }

    /// Write `program.json` with the next snapshot whatever changed (a clean exit).
    pub fn mark_def_dirty(&mut self) {
        self.def_dirty = true;
    }

    /// Some program follows what it plays (its play time moves: the snapshot refreshes).
    pub fn any_started(&self) -> bool {
        self.progs.values().any(|p| p.started)
    }

    /// `program.json` now (a new revision; the dirty mark cleared).
    pub fn program_file(&mut self, g: &Graph) -> store::ProgramFile {
        self.def_rev += 1;
        self.def_dirty = false;
        let programs = self
            .progs
            .iter()
            .map(|(id, p)| {
                let props = store::SETTABLE
                    .iter()
                    .filter_map(|k| {
                        let v = g.get(&PropPath(format!("{id}.{k}"))).ok()?;
                        Some((k.to_string(), v.to_json()))
                    })
                    .collect();
                store::ProgramDef {
                    id: id.clone(),
                    props,
                    order: store::OrderSnap {
                        items: p.order.items().to_vec(),
                        idx: p.order.index(),
                        shuffle: p.order.shuffle(),
                    },
                }
            })
            .collect();
        store::ProgramFile {
            version: store::VERSION,
            rev: self.def_rev,
            programs,
        }
    }

    /// Each program's dynamic state for `snapshot.json`.
    pub fn snaps(&self) -> Vec<store::ProgramSnap> {
        self.progs
            .iter()
            .map(|(id, p)| {
                let (history, hi) = p.order.history();
                store::ProgramSnap {
                    id: id.clone(),
                    rev: self.def_rev,
                    index: p.order.index(),
                    history: history.to_vec(),
                    history_index: hi,
                    current_path: p.order.current().filter(|_| p.started).map(str::to_string),
                    played_ms: p.played_ms.round(),
                    remaining_ms: p.remaining_ms.round(),
                    last_effect: p.last_effect.clone(),
                    failures: p.failures,
                    broken: p.broken.iter().cloned().collect(),
                }
            })
            .collect()
    }

    /// `--restore`: a program [`configure`](Self::configure)d from `program.json` gets its
    /// saved order back and — when the outputs show its saved current item (`shown`, the
    /// restored source; the parked one with no output) — its cursor, history, play time
    /// and countdown; its first tick then arms per the rule (an end-of-video switch re-arms
    /// `align: end`). A snapshot of another revision re-anchors the cursor on the current
    /// item (history `[current]`). Anything else: `idle` (`program.restore_mismatch`).
    pub fn restore(
        &mut self,
        id: &str,
        def: &store::ProgramDef,
        snap: Option<&store::ProgramSnap>,
        file_rev: u64,
        shown: Option<String>,
        g: &mut Graph,
    ) {
        self.def_rev = self.def_rev.max(file_rev);
        let Some(p) = self.progs.get_mut(id) else {
            return;
        };
        let paths = p.cfg.paths();
        let saved_ok = store::same_items(&def.order.items, &paths);
        let items = if saved_ok {
            def.order.items.clone()
        } else {
            paths.clone()
        };
        let shuffle = p.cfg.shuffle;
        p.order = Order::from_parts(items.clone(), def.order.idx, shuffle, paths.clone(), Vec::new(), usize::MAX);
        let Some(sn) = snap else {
            p.set_observed(id, g);
            return;
        };
        let shown_path = shown.as_deref().map(|s| src_str(g, s, "path"));
        let cur = match &sn.current_path {
            Some(c) if shown_path.as_deref() == Some(c.as_str()) && items.contains(c) => c.clone(),
            other => {
                if other.is_some() {
                    log::event(
                        "program",
                        Level::Warn,
                        "program.restore_mismatch",
                        None,
                        json!({ "id": id, "saved": other, "shown": shown_path }),
                    );
                }
                p.set_observed(id, g);
                return;
            }
        };
        let exact = saved_ok && sn.rev == file_rev;
        let at = items.iter().position(|x| *x == cur).unwrap_or(0);
        p.order = if exact {
            Order::from_parts(items.clone(), sn.index, shuffle, paths.clone(), sn.history.clone(), sn.history_index)
        } else {
            Order::from_parts(items.clone(), at, shuffle, paths.clone(), vec![cur.clone()], 0)
        };
        if p.order.current() != Some(cur.as_str()) {
            p.order = Order::from_parts(items, at, shuffle, paths, vec![cur.clone()], 0);
        }
        p.started = true;
        p.cur_src = shown;
        p.played_ms = sn.played_ms.max(0.0);
        p.remaining_ms = sn.remaining_ms;
        p.last_effect = sn.last_effect.clone();
        p.failures = sn.failures;
        p.broken = sn.broken.iter().cloned().collect();
        log::event(
            "program",
            Level::Info,
            "program.restored",
            None,
            json!({ "id": id, "path": cur, "played_ms": p.played_ms,
                    "remaining_ms": p.remaining_ms, "reanchored": !exact }),
        );
        p.set_observed(id, g);
    }

    /// `stop` / `quit`: every program goes (what plays is the caller's to tear down).
    /// Returns their ids (graph nodes the caller destroys).
    pub fn destroy_all(&mut self, g: &Graph) -> Vec<String> {
        let ids = self.ids();
        for id in &ids {
            let _ = self.destroy(id, g);
        }
        ids
    }

    // ------------------------------------------------------------ playlist start (O4)

    /// `<state>/resume.json` (at startup, whatever `--restore`: a later Play resumes).
    pub fn load_resume(&mut self, dir: &std::path::Path) {
        self.resume = resume::ResumeStore::load(dir);
    }

    /// `resume.json` is due.
    pub fn resume_dirty(&self) -> bool {
        self.resume_dirty
    }

    /// `resume.json` now (the dirty mark cleared).
    pub fn resume_bytes(&mut self) -> Vec<u8> {
        self.resume_dirty = false;
        self.resume.to_bytes()
    }

    /// Keep where `id`'s playlist is (its key's resume point) — on stop, destroy, a key
    /// change (another playlist replaces it) and quit, whatever its `start_mode`.
    pub fn put_point(&mut self, id: &str, g: &Graph) {
        let Some(p) = self.progs.get(id) else { return };
        let key = p.playing_key.clone().unwrap_or_else(|| p.cfg.key.clone());
        if key.is_empty() {
            return;
        }
        let Some(pt) = p.resume_point(g) else { return };
        log::event(
            "program",
            Level::Debug,
            "program.resume_saved",
            None,
            json!({ "id": id, "key": key, "path": pt.path, "time_pos": pt.time_pos,
                    "played_ms": pt.played_ms }),
        );
        self.resume.put(&key, pt);
        self.resume_dirty = true;
    }

    /// `quit`: every keyed program's point (before the final write).
    pub fn put_all_points(&mut self, g: &Graph) {
        for id in self.ids() {
            self.put_point(&id, g);
        }
    }

    /// `program.play {id, from: "start" | "resume" | "index", index?, keep_pause?}` — the
    /// § Playlist start table (`resume::plan_start`). A missing `from` = `index` with an
    /// index, else `start`. `resume` while the same key's playlist plays → nothing switched
    /// (`Some(reply)` = the verb's reply as is). `cut`: no effect (`keep_pause` while
    /// paused; a session start).
    #[allow(clippy::too_many_arguments)]
    pub fn play(
        &mut self,
        id: &str,
        from: Option<&str>,
        index: Option<usize>,
        cut: bool,
        g: &Graph,
        defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> Result<(Vec<ProgramAction>, Option<Value>), ApiError> {
        let from = match (from, index) {
            (Some("start"), _) | (None, None) => resume::StartFrom::Start,
            (Some("resume"), _) => resume::StartFrom::Resume,
            (Some("index"), i) | (None, i @ Some(_)) => resume::StartFrom::Index(i.unwrap_or(0)),
            (Some(other), _) => {
                return Err(ApiError {
                    code: "bad_request",
                    message: format!("from {other:?}: expected start|resume|index"),
                    hint: "`program.play {\"id\": \"prog:main\", \"from\": \"resume\"}`".to_string(),
                });
            }
        };
        let stored = {
            let p = self.get_nonempty(id)?;
            if let resume::StartFrom::Index(i) = from
                && i >= p.cfg.items.len()
            {
                return Err(ApiError {
                    code: "out_of_range",
                    message: format!("index {i}: the program has {} items", p.cfg.items.len()),
                    hint: "`liascape-player ctl get prog:<name>.items`".to_string(),
                });
            }
            let key = p.cfg.key.clone();
            let same_playing = p.started
                && !key.is_empty()
                && p.playing_key.as_deref() == Some(key.as_str());
            if same_playing && from == resume::StartFrom::Resume {
                // it never stopped: keep playing where it is (a pause is the backend's, I1)
                let path = p.order.current().map(str::to_string);
                let index = path.as_deref().map(|x| p.index_of(x)).unwrap_or(-1);
                return Ok((
                    Vec::new(),
                    Some(json!({ "corr": null, "path": path, "index": index, "resumed": true })),
                ));
            }
            if same_playing {
                p.resume_point(g) // what plays now: a fresh shuffle won't start there
            } else if key.is_empty() {
                None
            } else {
                self.resume.get(&key).cloned()
            }
        };
        let p = self.progs.get_mut(id).ok_or_else(|| no_program(id))?;
        let paths = p.cfg.paths();
        let (skips, broken) = (&p.skips, &p.broken);
        let skip = |x: &str| skips.contains(x) || broken.contains(x);
        let Some(plan) =
            resume::plan_start(&paths, &skip, p.cfg.shuffle, from, stored.as_ref(), &mut p.rng)
        else {
            return Ok((Vec::new(), None));
        };
        p.order = plan.order;
        let Some(step) = p.order.plan_stay() else {
            return Ok((Vec::new(), None));
        };
        p.def_changed = true;
        p.started = true;
        p.backoff_until = None;
        p.rearm = None;
        p.failed.clear();
        p.playing_key = Some(p.cfg.key.clone());
        p.start_position = Some(plan.position);
        let act = p.start(id, step, Reason::Play, Align::Now, cut, defaults_of);
        if plan.resumed
            && let Some(pd) = p.pending.as_mut()
        {
            pd.resume = Some((plan.played_ms as f64, plan.remaining_ms.map(|r| r as f64)));
        }
        Ok((vec![act], None))
    }

    /// `serve --restore --session-start` (a boot / `liascape restore`, never a crash
    /// restart): a `start_over` program starts per `plan_start(Start)` — a cut to its first
    /// item (sequential) or a fresh shuffle whose first ≠ `last` (the item it was on); the
    /// runtime left that item uncreated. A `resume` one was restored exactly
    /// ([`Programs::restore`]) and says so (`program.current {resumed: true}`).
    pub fn session_start(
        &mut self,
        id: &str,
        last: Option<&str>,
        now: Duration,
        defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> Vec<ProgramAction> {
        let Some(p) = self.progs.get_mut(id) else {
            return Vec::new();
        };
        if p.cfg.start_resume {
            if p.started {
                p.playing_key = Some(p.cfg.key.clone());
                let path = p.order.current().unwrap_or("").to_string();
                log::event(
                    "program",
                    Level::Info,
                    "program.current",
                    None,
                    json!({ "id": id, "index": p.index_of(&path), "path": path, "from": null,
                            "reason": "play", "corr": null, "resumed": true,
                            "at_ms": now.as_secs_f64() * 1000.0, "source": p.cur_src }),
                );
            }
            return Vec::new();
        }
        let avoid = last.map(|l| resume::ResumePoint {
            path: l.to_string(),
            ..resume::ResumePoint::default()
        });
        let paths = p.cfg.paths();
        let (skips, broken) = (&p.skips, &p.broken);
        let skip = |x: &str| skips.contains(x) || broken.contains(x);
        let Some(plan) = resume::plan_start(
            &paths,
            &skip,
            p.cfg.shuffle,
            resume::StartFrom::Start,
            avoid.as_ref(),
            &mut p.rng,
        ) else {
            return Vec::new();
        };
        p.order = plan.order;
        let Some(step) = p.order.plan_stay() else {
            return Vec::new();
        };
        p.def_changed = true;
        p.started = true;
        p.playing_key = Some(p.cfg.key.clone());
        vec![p.start(id, step, Reason::Play, Align::Now, true, defaults_of)]
    }

    pub fn is_empty(&self) -> bool {
        self.progs.is_empty()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.progs.contains_key(id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.progs.keys().cloned().collect()
    }

    /// After a create or any `set` on `id`'s node: (re)read its configuration. Live: a new
    /// interval keeps the elapsed time (`retime_remaining`), new items or order reorder the
    /// play order (`Order::reorder`, the current item kept); the rest is read where it is
    /// used.
    pub fn configure(&mut self, id: &str, g: &mut Graph) -> Vec<ProgramAction> {
        let Some(cfg) = ProgCfg::read(g, id) else {
            return Vec::new();
        };
        let mut acts = Vec::new();
        self.def_dirty = true;
        // another playlist replaces this one (its key changes): keep where the old one was
        if let Some(p) = self.progs.get(id)
            && p.cfg.key != cfg.key
            && p.playing_key.as_deref() == Some(p.cfg.key.as_str())
        {
            self.put_point(id, g);
        }
        match self.progs.get_mut(id) {
            Some(p) => {
                let old = std::mem::replace(&mut p.cfg, cfg);
                if old.interval_ms != p.cfg.interval_ms && !p.cfg.on_end {
                    p.remaining_ms = rule::retime_remaining(
                        old.interval_ms,
                        p.remaining_ms.max(0.0) as u64,
                        p.cfg.interval_ms,
                    ) as f64;
                }
                if old.on_end && !p.cfg.on_end {
                    // on_end → timer: no end to wait for; the countdown starts in full
                    p.cancel_armed(id, "mode", &mut acts);
                    p.rearm = None;
                    p.held = false;
                    p.remaining_ms = p.cfg.interval_ms as f64;
                } else if old.on_end && p.cfg.on_end {
                    // a new minimum or transition re-arms an armed switch to the same B (a
                    // held one re-checks the new minimum on the next tick)
                    let min = old.interval_ms != p.cfg.interval_ms;
                    if (min || old.transition != p.cfg.transition)
                        && let Some(step) = p.cancel_armed(id, "rearm", &mut acts)
                    {
                        p.rearm = Some(step);
                    }
                    if min {
                        p.held = false;
                    }
                }
                if old.items != p.cfg.items || old.shuffle != p.cfg.shuffle {
                    let was_skipped = std::mem::take(&mut p.skips);
                    p.skips = p
                        .cfg
                        .items
                        .iter()
                        .filter(|i| i.skip)
                        .map(|i| i.path.clone())
                        .collect();
                    // an item the backend skipped and now lets play again (a crashed scene whitelisted):
                    // its own broken / failed mark goes too — the backend is the authority on that
                    for path in was_skipped.difference(&p.skips) {
                        p.broken.remove(path);
                        p.failed.remove(path);
                    }
                    let list_changed = old.paths() != p.cfg.paths();
                    if list_changed {
                        p.failed.clear();
                        p.empty_logged = false;
                    }
                    // only a new list or order re-orders: an item's props or skip flag alone (the
                    // backend's PushItem — a loudness measured, an override, a crash mark) reach
                    // the next B and the passing-over, never the order or the history
                    if list_changed || old.shuffle != p.cfg.shuffle {
                        let paths = p.cfg.paths();
                        if p.started {
                            p.order.reorder(&paths, p.cfg.shuffle, &mut p.rng);
                        } else {
                            p.order = Order::new(paths, 0, p.cfg.shuffle);
                        }
                    }
                    // an armed B that is no longer a playable item: cancelled, re-planned
                    // by the next tick (A's loop comes back with the abort)
                    let gone = |p: &Prog, path: &str| p.index_of(path) < 0 || p.skipped(path);
                    if let Some(armed) = p.pending.as_ref().filter(|x| x.align == Align::End)
                        && gone(p, &armed.step.path.clone())
                    {
                        p.cancel_armed(id, "items", &mut acts);
                    }
                    if p.rearm.as_ref().is_some_and(|s| gone(p, &s.path)) {
                        p.rearm = None;
                    }
                }
                p.set_observed(id, g);
            }
            None => {
                let p = Prog::new(cfg);
                p.set_observed(id, g);
                self.progs.insert(id.to_string(), p);
                log::event(
                    "program",
                    Level::Info,
                    "program.created",
                    None,
                    json!({ "id": id }),
                );
            }
        }
        acts
    }

    /// `destroy`: the rotation stops; what plays stays on screen (an armed switch that
    /// hasn't started is cancelled — A plays on).
    pub fn destroy(&mut self, id: &str, g: &Graph) -> Vec<ProgramAction> {
        let mut acts = Vec::new();
        self.put_point(id, g);
        if let Some(p) = self.progs.remove(id) {
            self.def_dirty = true;
            if let Some(c) = p.pending.and_then(|p| p.corr) {
                acts.push(ProgramAction::Cancel { corr: c });
            }
            log::event(
                "program",
                Level::Info,
                "program.destroyed",
                None,
                json!({ "id": id }),
            );
        }
        acts
    }

    fn get_nonempty(&mut self, id: &str) -> Result<&mut Prog, ApiError> {
        let p = self.progs.get_mut(id).ok_or_else(|| no_program(id))?;
        if p.cfg.items.is_empty() {
            return Err(empty_program(id));
        }
        Ok(p)
    }

    /// `program.play|next|prev|random {id, index?, keep_pause?}`. `play` starts at
    /// `index` (default 0); the user switches always go `align: now` with the program's
    /// pick (a cut with `keep_pause` while the player is paused).
    pub fn verb(
        &mut self,
        verb: &str,
        id: &str,
        keep_pause: bool,
        g: &Graph,
        now: Duration,
        defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> Result<Vec<ProgramAction>, ApiError> {
        let paused = matches!(
            g.get(&PropPath("player.paused".into())),
            Ok(PropValue::Bool(true))
        );
        let cut = keep_pause && paused;
        let p = self.get_nonempty(id)?;
        // A switch requested and not started: an armed one (`align: end`) is what `next`
        // takes (`AdvanceAndLaunch`'s pre-fetch); one on its way (`align: now`, e.g. the
        // previous `next` of a key-repeat burst) is where the user switch goes on from.
        let armed = p
            .pending
            .as_ref()
            .filter(|x| x.align == Align::End)
            .map(|x| x.step.clone());
        let on_way = p
            .pending
            .as_ref()
            .filter(|x| x.align == Align::Now)
            .map(|x| x.step.clone());
        let (step, reason) = match verb {
            "next" => {
                let step = match (armed, &on_way) {
                    (Some(s), _) => Some(s),
                    (None, Some(prev)) => p.plan_next_from(id, now, Some(prev)),
                    (None, None) => p.take_next(id, now),
                };
                (step, Reason::Next)
            }
            "prev" => {
                let step = match &on_way {
                    Some(prev) => p.order.plan_after(prev, |o| o.plan_back()),
                    None => p.order.plan_back(),
                };
                (step, Reason::Prev)
            }
            "random" => {
                let (skips, broken) = (&p.skips, &p.broken);
                let skip = |x: &str| skips.contains(x) || broken.contains(x);
                let rng = &mut p.rng;
                let step = match &on_way {
                    Some(prev) => p.order.plan_after(prev, |o| o.plan_random(&skip, rng)),
                    None => p.order.plan_random(&skip, rng),
                };
                (step, Reason::Random)
            }
            other => {
                return Err(ApiError {
                    code: "bad_request",
                    message: format!("program.{other}: no such verb"),
                    hint: "program.play|next|prev|random".to_string(),
                });
            }
        };
        let Some(step) = step else {
            return Ok(Vec::new());
        };
        p.started = true;
        p.backoff_until = None;
        p.rearm = None;
        // an armed switch is superseded by the new request (the recipe aborts it)
        Ok(vec![p.start(
            id,
            step,
            reason,
            Align::Now,
            cut,
            defaults_of,
        )])
    }

    /// A verb's reply: the switch it started (`corr`/`path` null = nothing to do).
    pub fn verb_reply(&self, id: &str, started: Option<(CorrId, String)>) -> Value {
        let index = started
            .as_ref()
            .and_then(|(_, path)| Some(self.progs.get(id)?.index_of(path)))
            .unwrap_or(-1);
        let resumed = started.is_some()
            && self
                .progs
                .get(id)
                .and_then(|p| p.pending.as_ref())
                .is_some_and(|x| x.resume.is_some());
        json!({
            "corr": started.as_ref().map(|(c, _)| c.0.clone()),
            "path": started.map(|(_, p)| p),
            "index": index,
            "resumed": resumed,
        })
    }

    /// The runtime started the switch a [`ProgramAction::Start`] asked for. `parked_b`: it
    /// went to `transition_parked` (no output) and replaced the parked wallpaper at once.
    pub fn on_requested(
        &mut self,
        id: &str,
        corr: CorrId,
        step: Step,
        reason: Reason,
        parked_b: Option<String>,
        g: &Graph,
        now: Duration,
    ) {
        self.issued.insert(corr.clone());
        let Some(p) = self.progs.get_mut(id) else {
            return;
        };
        let align = p.pending.as_ref().map(|x| x.align).unwrap_or(Align::Now);
        let resume = p.pending.as_ref().and_then(|x| x.resume);
        p.pending = Some(Pending {
            corr: Some(corr.clone()),
            step,
            reason,
            align,
            resume,
        });
        if let Some(b) = parked_b
            && align == Align::Now
        {
            p.commit(id, Some(b), &corr, g, now);
        }
        log::event(
            "program",
            Level::Debug,
            "program.requested",
            Some(corr),
            json!({ "id": id, "reason": reason.as_str(), "align": align }),
        );
    }

    /// The runtime could not start it (B's create props refused): a failure.
    pub fn on_request_failed(&mut self, id: &str, step: Step, err: &ApiError, now: Duration) {
        if let Some(p) = self.progs.get_mut(id) {
            p.fail(id, &step.path, &err.to_string(), now);
        }
    }

    /// One tick, after `Transitions::tick` (R47): the transitions' and sources' events, the
    /// clocks (`now` = the player clock), the rules. `parked` = no output exists;
    /// `active` = every in-flight transition's corr.
    #[allow(clippy::too_many_arguments)]
    pub fn tick(
        &mut self,
        g: &mut Graph,
        tr_events: &[TransitionEvent],
        src_events: &[(String, SourceEvent)],
        now: Duration,
        parked: bool,
        active: &[CorrId],
        defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> Vec<ProgramAction> {
        self.issued.retain(|c| active.contains(c));
        let foreign_busy = active.iter().any(|c| !self.issued.contains(c));
        let mut acts = Vec::new();
        for (id, p) in self.progs.iter_mut() {
            acts.extend(p.tick(
                id,
                g,
                tr_events,
                src_events,
                now,
                parked,
                foreign_busy,
                defaults_of,
            ));
        }
        self.collect_def_changes();
        acts
    }

    /// A program's order changed by itself (a reshuffle, a play): `program.json` is due.
    pub fn collect_def_changes(&mut self) {
        for p in self.progs.values_mut() {
            if std::mem::take(&mut p.def_changed) {
                self.def_dirty = true;
            }
        }
    }

    pub fn status(&self) -> Vec<ProgramStatus> {
        self.progs.iter().map(|(id, p)| p.status(id)).collect()
    }

    /// The `programs` probe: [`Programs::status`] plus each item's flags.
    pub fn probe(&self) -> Value {
        let mut out = Vec::new();
        for (id, p) in &self.progs {
            let mut v = serde_json::to_value(p.status(id)).unwrap_or(Value::Null);
            let items: Vec<Value> = p
                .cfg
                .items
                .iter()
                .map(|it| {
                    json!({"path": it.path, "skip": it.skip,
                           "broken": p.broken.contains(&it.path),
                           "failed": p.failed.contains(&it.path)})
                })
                .collect();
            v["item_flags"] = Value::Array(items);
            out.push(v);
        }
        json!({ "programs": out })
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;

    /// A clock whose wall time jumps 8 h while its monotonic time moves 10 ms (a suspend):
    /// only the monotonic delta reaches the rotation.
    struct FakeClock {
        wall: std::time::SystemTime,
        mono: Duration,
    }

    #[test]
    fn countdown_uses_the_monotonic_player_clock() {
        let mut fake = FakeClock {
            wall: std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000),
            mono: Duration::from_secs(5),
        };
        let mut clock = PlayClock::default();
        assert_eq!(
            clock.advance(fake.mono),
            Duration::ZERO,
            "the first call starts it"
        );
        let mut remaining = 3000.0_f64;
        fake.wall += Duration::from_secs(8 * 3600);
        fake.mono += Duration::from_millis(10);
        remaining -= clock.advance(fake.mono).as_secs_f64() * 1000.0;
        assert!((remaining - 2990.0).abs() < 1e-6, "{remaining}");
        let _ = fake.wall;
        // a clock that doesn't move (paused) adds nothing
        assert_eq!(clock.advance(fake.mono), Duration::ZERO);
    }
}

#[cfg(test)]
mod store_tests {
    use super::*;
    use crate::graph::NodeKind;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    /// A graph with `prog:main` over `a, b, c, d` and a source showing `b`.
    fn setup() -> (Graph, Programs, String) {
        let mut g = Graph::new();
        let items: Vec<Value> = ["a", "b", "c", "d"].iter().map(|p| json!({"path": p})).collect();
        let props = json!({"items": items, "seed": 1, "mode": "timer", "interval_ms": 9000});
        g.create(
            NodeKind::Program,
            Some("prog:main".into()),
            props.as_object().unwrap().clone(),
        )
        .unwrap();
        let src = g
            .create(NodeKind::Source, None, json!({"path": "b"}).as_object().unwrap().clone())
            .unwrap();
        let mut ps = Programs::new();
        ps.configure("prog:main", &mut g);
        (g, ps, src)
    }

    fn def(order: &[&str], idx: usize) -> store::ProgramDef {
        store::ProgramDef {
            id: "prog:main".into(),
            props: Map::new(),
            order: store::OrderSnap { items: v(order), idx, shuffle: false },
        }
    }

    fn snap(rev: u64) -> store::ProgramSnap {
        store::ProgramSnap {
            id: "prog:main".into(),
            rev,
            index: 3,
            history: v(&["c", "d", "a", "b"]),
            history_index: 3,
            current_path: Some("b".into()),
            played_ms: 1200.0,
            remaining_ms: 7800.0,
            ..store::ProgramSnap::default()
        }
    }

    #[test]
    fn program_json_restores_exactly_at_the_same_rev() {
        let (mut g, mut ps, src) = setup();
        ps.restore("prog:main", &def(&["c", "d", "a", "b"], 3), Some(&snap(5)), 5, Some(src), &mut g);
        let st = &ps.status()[0];
        assert_eq!(st.phase, ProgPhase::Playing);
        assert_eq!(st.order, v(&["c", "d", "a", "b"]));
        assert_eq!(st.history, v(&["c", "d", "a", "b"]));
        assert_eq!((st.history_index, st.played_ms, st.remaining_ms), (3, 1200.0, 7800.0));
    }

    #[test]
    fn program_json_rev_mismatch_reanchors() {
        let (mut g, mut ps, src) = setup();
        // program.json one write ahead of the snapshot: its order, the cursor on `b`
        ps.restore("prog:main", &def(&["d", "b", "a", "c"], 0), Some(&snap(4)), 5, Some(src), &mut g);
        let st = &ps.status()[0];
        assert_eq!(st.order, v(&["d", "b", "a", "c"]));
        assert_eq!(st.path.as_deref(), Some("b"));
        assert_eq!((st.history.clone(), st.history_index), (v(&["b"]), 0));
        assert_eq!(st.played_ms, 1200.0, "the clocks are kept");
    }

    #[test]
    fn item_props_edit_keeps_the_order_and_history() {
        let (mut g, mut ps, src) = setup();
        ps.restore("prog:main", &def(&["c", "d", "a", "b"], 3), Some(&snap(5)), 5, Some(src), &mut g);
        let before = ps.status()[0].clone();
        // the same list, one item's props and another's skip flag changed (PushItem)
        let items: Vec<Value> = ["a", "b", "c", "d"]
            .iter()
            .map(|p| match *p {
                "a" => json!({"path": p, "props": {"gain.user": -6.0}}),
                "c" => json!({"path": p, "skip": true}),
                _ => json!({"path": p}),
            })
            .collect();
        let v = crate::graph::PropValue::Items(serde_json::from_value(Value::Array(items)).unwrap());
        g.set(&PropPath("prog:main.items".into()), v).unwrap();
        ps.configure("prog:main", &mut g);
        let st = &ps.status()[0];
        assert_eq!(st.order, before.order, "no re-order");
        assert_eq!((st.history.clone(), st.history_index), (before.history, before.history_index));
        assert_eq!(st.path, before.path);
    }

    #[test]
    fn lifting_an_items_skip_clears_its_broken_mark() {
        let (mut g, mut ps, src) = setup();
        ps.restore("prog:main", &def(&["a", "b", "c", "d"], 1), Some(&snap(5)), 5, Some(src), &mut g);
        let set = |g: &mut Graph, skip_c: bool| {
            let items: Vec<Value> = ["a", "b", "c", "d"]
                .iter()
                .map(|p| json!({"path": p, "skip": *p == "c" && skip_c}))
                .collect();
            let v = crate::graph::PropValue::Items(serde_json::from_value(Value::Array(items)).unwrap());
            g.set(&PropPath("prog:main.items".into()), v).unwrap();
        };
        ps.progs.get_mut("prog:main").unwrap().broken.insert("c".into()); // its scene broke
        set(&mut g, true); // the backend marks it crashed
        ps.configure("prog:main", &mut g);
        assert!(ps.status()[0].broken.contains(&"c".to_string()));
        set(&mut g, false); // whitelisted
        ps.configure("prog:main", &mut g);
        assert!(ps.status()[0].broken.is_empty(), "plays again");
    }

    #[test]
    fn restore_mismatch_leaves_the_program_idle() {
        let (mut g, mut ps, _) = setup();
        let other = g
            .create(NodeKind::Source, None, json!({"path": "zzz"}).as_object().unwrap().clone())
            .unwrap();
        ps.restore("prog:main", &def(&["a", "b", "c", "d"], 1), Some(&snap(5)), 5, Some(other), &mut g);
        assert_eq!(ps.status()[0].phase, ProgPhase::Idle);
        // an order that no longer fits the items falls back to the bar order
        let (mut g, mut ps, src) = setup();
        ps.restore("prog:main", &def(&["x", "y"], 1), Some(&snap(5)), 5, Some(src), &mut g);
        let st = &ps.status()[0];
        assert_eq!(st.order, v(&["a", "b", "c", "d"]));
        assert_eq!(st.history, v(&["b"]), "re-anchored");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_is_seeded_and_uniform() {
        let (mut a, mut b) = (Rng::new(9), Rng::new(9));
        for _ in 0..10 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        let mut counts = [0u32; 6];
        for _ in 0..6000 {
            counts[a.below(6)] += 1;
        }
        assert!(counts.iter().all(|c| (850..1150).contains(c)), "{counts:?}");
        assert_eq!(a.below(0), 0);
        assert_eq!(a.below(1), 0);
    }
}
