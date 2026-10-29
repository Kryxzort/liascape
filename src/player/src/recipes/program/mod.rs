//! Programs (spec §4.2 "Program", §4.3 "Video-end-aligned advance"): a rotation is a graph
//! node `prog:<name>` whose settings are live properties; this recipe reads it and, on the
//! player clock, requests `transition`s on its outputs — which item, which effect, when. It
//! never renders and never touches a source.
//!
//! - [`rule`] — the per-item play rules (minimum / maximum / scene timing) and the
//!   countdown's retime (pure).
//! - [`order`] — the play order: cycles, shuffle, history, random, reorder (pure, seeded).
//! - [`pick`] — the effect / duration / method of one switch (pure, seeded).

pub mod order;
pub mod pick;
pub mod rule;

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::graph::{ApiError, Graph, ProgramItem, PropValue};
use crate::log::{self, CorrId, Level};
use crate::recipes::transition::{Align, TransitionEvent, TransitionReq};
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
    /// No output shows the program's outputs (R60).
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
    /// Items marked broken (a broken scene): passed over until the list changes them.
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
        })
    }

    pub fn paths(&self) -> Vec<String> {
        self.items.iter().map(|i| i.path.clone()).collect()
    }
}

/// One program's live state.
#[derive(Debug)]
struct Prog {
    cfg: ProgCfg,
    order: Order,
    #[allow(dead_code)] // the engine's (Task 3)
    rng: Rng,
    played_ms: f64,
    remaining_ms: f64,
    last_effect: Option<String>,
    failures: u32,
    broken: BTreeSet<String>,
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

/// Every live program, by node id.
#[derive(Debug, Default)]
pub struct Programs {
    progs: BTreeMap<String, Prog>,
}

impl Programs {
    pub fn new() -> Programs {
        Programs::default()
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

    /// After a create or any `set` on `id`'s node: (re)read its configuration.
    pub fn configure(&mut self, id: &str, g: &mut Graph) -> Vec<ProgramAction> {
        let Some(cfg) = ProgCfg::read(g, id) else {
            return Vec::new();
        };
        match self.progs.get_mut(id) {
            Some(p) => {
                p.cfg = cfg;
            }
            None => {
                let order = Order::new(cfg.paths(), 0, cfg.shuffle);
                let rng = Rng::new(cfg.seed);
                self.progs.insert(
                    id.to_string(),
                    Prog {
                        cfg,
                        order,
                        rng,
                        played_ms: 0.0,
                        remaining_ms: 0.0,
                        last_effect: None,
                        failures: 0,
                        broken: BTreeSet::new(),
                    },
                );
                log::event("program", Level::Info, "program.created", None, json!({ "id": id }));
            }
        }
        Vec::new()
    }

    /// `destroy`: the rotation stops; what plays stays on screen.
    pub fn destroy(&mut self, id: &str) -> Vec<ProgramAction> {
        if self.progs.remove(id).is_some() {
            log::event("program", Level::Info, "program.destroyed", None, json!({ "id": id }));
        }
        Vec::new()
    }

    fn get_nonempty(&self, id: &str) -> Result<&Prog, ApiError> {
        let p = self.progs.get(id).ok_or_else(|| no_program(id))?;
        if p.cfg.items.is_empty() {
            return Err(empty_program(id));
        }
        Ok(p)
    }

    /// `program.play|next|prev|random` (Task 3/4 run them).
    pub fn verb(
        &mut self,
        verb: &str,
        id: &str,
        _index: Option<usize>,
        _keep_pause: bool,
        _g: &Graph,
    ) -> Result<Vec<ProgramAction>, ApiError> {
        self.get_nonempty(id)?;
        Err(ApiError {
            code: "unsupported",
            message: format!("program.{verb}: not yet"),
            hint: "Phase 3 Task 3 runs programs".to_string(),
        })
    }

    /// A verb's reply: the switch it started (`corr`/`path` null = nothing to do).
    pub fn verb_reply(&self, id: &str, started: Option<(CorrId, String)>) -> Value {
        let index = started.as_ref().and_then(|(_, path)| {
            self.progs
                .get(id)?
                .cfg
                .items
                .iter()
                .position(|i| &i.path == path)
        });
        json!({
            "corr": started.as_ref().map(|(c, _)| c.0.clone()),
            "path": started.map(|(_, p)| p),
            "index": index.map(|i| i as i64).unwrap_or(-1),
        })
    }

    /// The runtime started the switch a [`ProgramAction::Start`] asked for.
    pub fn on_requested(
        &mut self,
        _id: &str,
        _corr: CorrId,
        _step: Step,
        _reason: Reason,
        _parked: bool,
        _now: Duration,
    ) {
    }

    /// The runtime could not start it (B's create props refused).
    pub fn on_request_failed(
        &mut self,
        _id: &str,
        _step: Step,
        _reason: Reason,
        _err: &ApiError,
        _now: Duration,
    ) {
    }

    /// One tick (Task 3).
    pub fn tick(
        &mut self,
        _g: &mut Graph,
        _tr_events: &[TransitionEvent],
        _src_events: &[(String, SourceEvent)],
        _now: Duration,
        _parked: bool,
        _defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    ) -> Vec<ProgramAction> {
        Vec::new()
    }

    pub fn status(&self) -> Vec<ProgramStatus> {
        self.progs
            .iter()
            .map(|(id, p)| {
                let (history, hi) = p.order.history();
                ProgramStatus {
                    id: id.clone(),
                    phase: ProgPhase::Idle,
                    path: None,
                    index: -1,
                    next: None,
                    corr: None,
                    armed_align: None,
                    items: p.cfg.items.len(),
                    order: p.order.items().to_vec(),
                    history: history.to_vec(),
                    history_index: hi,
                    played_ms: p.played_ms,
                    remaining_ms: p.remaining_ms,
                    backoff_ms: 0,
                    failures: p.failures,
                    last_effect: p.last_effect.clone(),
                    broken: p.broken.iter().cloned().collect(),
                }
            })
            .collect()
    }

    /// The `programs` probe: [`Programs::status`] plus each item's flags.
    pub fn probe(&self) -> Value {
        let mut out = Vec::new();
        for (st, p) in self.status().into_iter().zip(self.progs.values()) {
            let mut v = serde_json::to_value(&st).unwrap_or(Value::Null);
            let items: Vec<Value> = p
                .cfg
                .items
                .iter()
                .map(|it| {
                    json!({"path": it.path, "skip": it.skip,
                           "broken": p.broken.contains(&it.path), "failed": false})
                })
                .collect();
            v["item_flags"] = Value::Array(items);
            out.push(v);
        }
        json!({ "programs": out })
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
