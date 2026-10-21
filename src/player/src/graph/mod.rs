//! The node graph (spec §4.2 "Blocks", §4.3 "Recipes", §9 "`state` query"): the player's
//! single source of truth. Every output, layer, source and effect is a [`Node`] with typed
//! properties ([`props::PropValue`]) that the command API (Task 12) sets/gets/animates and
//! the renderer (Task 9) reads. [`Graph::snapshot`] is the `state` query's payload.
//!
//! **Id scheme:** outputs are `out:<connector>` (e.g. `out:DP-1`); every output auto-creates
//! a `lay:<connector>:main` [`Layer`](NodeKind::Layer) alongside it (destroyed with the
//! output). Everything else auto-ids as `src<n>` / `lay<n>` / `fx<n>` (independent counters,
//! starting at 1) unless the caller supplies an explicit id. The [`Player`](NodeKind::Player)
//! singleton (id `player`) exists from [`Graph::new`] and is never created or destroyed
//! through [`Graph::create`]/[`Graph::destroy`].
//!
//! **Property paths** ([`PropPath`]) are `"<node id>.<prop name>"`, split at the *first*
//! `.` — node ids never contain `.` (though they may contain `:`), so `"src7.gain.xfade"`
//! splits to node `src7`, prop `gain.xfade` (see `crate::anim`'s doc comment for this exact
//! rule). `gain.<slot>` is special: valid only on [`Source`](NodeKind::Source) nodes, with
//! `<slot>` parsed via `GainSlot::from_str` — every other property name goes through the
//! static schema in [`props`].
//!
//! **Aliases**, resolved by [`Graph::resolve`] and transparently by [`Graph::set`]/
//! [`Graph::get`]:
//! - `out:*` — every output, sorted by id.
//! - `lay:*:main` — every main layer, sorted by id.
//! - `cur:<connector>` / `cur:*` — the source currently shown by that output's (or every
//!   output's, deduplicated) main layer: if `content` is a `Source`, that id; if `content`
//!   is an `Effect`, its `to` (the incoming side); if `content` is unset, no entry.
//! - `srcs:<connector>` / `srcs:*` (Task 12, R50) — every `Source` whose picture is on that
//!   output (a layer of it shows it directly or as either side of an effect) **or** that an
//!   in-flight transition on it holds (its pending B, held A's) — snapshots and graves
//!   excluded. Where global settings (`gain.user`, `no_audio`, `speed`, …) go, so a
//!   setting changed mid-transition also reaches the B that is about to take over. The
//!   transition part comes from [`Graph::set_transition_sources`], refreshed by the runtime
//!   after every `Transitions` start/cancel/tick. `srcs:*` also includes the wallpaper
//!   parked while no output exists ([`Graph::set_parked`], R60).
//! - anything else is tried as a concrete node id.
//!
//! `set` on a multi-resolution path (e.g. `out:*.paused`) applies to every resolved node.
//! `get` on one that resolves to more than one node is `ambiguous` — there is no single
//! value to return.
//!
//! **Errors** ([`ApiError`]) always carry a `hint` naming either the doc anchor for this
//! section or the `ctl` command to inspect. Codes: `no_such_node`, `no_such_prop`,
//! `bad_type`, `out_of_range`, `read_only`, `ambiguous`, `unsupported`, `io` (the last
//! reserved for a future task's persistence/socket I/O — nothing in this module produces
//! it).
//!
//! **`drain_changes`** returns every `(PropPath, PropValue)` applied by `set` since the
//! last drain, in call order (one entry per resolved node for a multi-resolution `set`) —
//! the runtime (a later task) forwards these to whatever `PropHook` a live source has
//! registered. Property seeding done by `create` is *not* a change: there is no live
//! source yet for a hook to receive it.
//!
//! **`picture_rev`** (Task 13) counts every mutation that can change a picture — `create`,
//! `destroy`, and every `set` except a `gain.<slot>` (audio only); never `set_observed`.
//! The Wayland redraw policy (`crate::redraw`) compares it with the revision each output
//! last presented, so a static wallpaper costs no frames.

pub mod props;

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value};

pub use props::{Fit, PropDef, PropType, PropValue};

use crate::anim::PropPath;
use crate::units::{GainSlot, Gains};

/// What a [`Node`] is. `Player` is a singleton (id `player`, created by [`Graph::new`]);
/// every other kind is created via [`Graph::create`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Player,
    Output,
    Layer,
    Source,
    Effect,
}

impl NodeKind {
    fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Player => "player",
            NodeKind::Output => "output",
            NodeKind::Layer => "layer",
            NodeKind::Source => "source",
            NodeKind::Effect => "effect",
        }
    }
}

/// An error from the graph's command surface — goes over the wire as `{code, message,
/// hint}` (spec §9: "errors say what failed, with which inputs, and where to look").
#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub hint: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {} ({})", self.code, self.message, self.hint)
    }
}

impl std::error::Error for ApiError {}

fn no_such_node(id: &str) -> ApiError {
    ApiError {
        code: "no_such_node",
        message: format!("no such node: {id:?}"),
        hint: "run `lp-player ctl state` to see the live graph".to_string(),
    }
}

fn ambiguous(alias: &str) -> ApiError {
    ApiError {
        code: "ambiguous",
        message: format!("{alias:?} resolves to more than one node"),
        hint: "use a concrete node id for `get` (`set` applies to every resolution instead)"
            .to_string(),
    }
}

fn unsupported(msg: impl Into<String>) -> ApiError {
    ApiError {
        code: "unsupported",
        message: msg.into(),
        hint: "see .claude/rules/player-core.md \u{a7} Graph & properties".to_string(),
    }
}

/// One node: its kind, id, every schema property it has (seeded with defaults at creation —
/// see [`Node::with_defaults`]), and — for [`NodeKind::Source`] only — its gain slots.
/// `gain_slots` is a plain `BTreeMap` rather than a `units::Gains` because `Gains` exposes
/// no way to enumerate which slots are set (only `get`/`effective_db`), and
/// `Graph::snapshot`'s "only set slots" rule needs exactly that enumeration; a fresh
/// `Gains` is built from this map on demand for `effective_db`.
#[derive(Debug, Clone)]
struct Node {
    kind: NodeKind,
    id: String,
    props: BTreeMap<String, PropValue>,
    gain_slots: BTreeMap<GainSlot, f64>,
}

impl Node {
    fn with_defaults(kind: NodeKind, id: String) -> Self {
        let mut props = BTreeMap::new();
        for (name, pd) in props::schema_for_kind(kind) {
            props.insert(name.to_string(), pd.default);
        }
        Node {
            kind,
            id,
            props,
            gain_slots: BTreeMap::new(),
        }
    }

    fn snapshot_obj(&self) -> Value {
        let mut obj = Map::new();
        obj.insert(
            "kind".to_string(),
            Value::String(self.kind.as_str().to_string()),
        );
        for (k, v) in &self.props {
            obj.insert(k.clone(), v.to_json());
        }
        if self.kind == NodeKind::Source {
            let mut gain_obj = Map::new();
            let mut gains = Gains::new();
            for (slot, db) in &self.gain_slots {
                gain_obj.insert(slot.as_str().to_string(), serde_json::json!(db));
                gains.set(*slot, *db);
            }
            obj.insert("gain".to_string(), Value::Object(gain_obj));
            obj.insert(
                "gain_effective_db".to_string(),
                serde_json::json!(gains.effective_db()),
            );
        }
        Value::Object(obj)
    }
}

/// The player's single source of truth: every output, layer, source and effect, as a flat
/// map of id -> [`Node`]. Single-threaded (spec §4.1 — driven from the render loop / command
/// handler), so this carries no interior mutability or locking of its own.
pub struct Graph {
    nodes: BTreeMap<String, Node>,
    next_src: u64,
    next_lay: u64,
    next_fx: u64,
    changes: Vec<(PropPath, PropValue)>,
    /// `out:<connector>` → sources in-flight transitions on that output hold (pending B,
    /// held A's) — the non-layer half of the `srcs:` alias (see the module doc).
    tr_sources: BTreeMap<String, BTreeSet<String>>,
    /// Released sources waiting to be destroyed: never part of `srcs:` via `tr_sources`.
    tr_graves: BTreeSet<String>,
    /// The wallpaper parked while no output exists (R60): part of `srcs:*`.
    parked: Option<String>,
    /// Picture-affecting mutations so far (see the module doc).
    picture_rev: u64,
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}

impl Graph {
    /// A fresh graph containing only the `player` singleton (`debug` = `false`, `version` =
    /// [`env!("CARGO_PKG_VERSION")`], `pid` = [`std::process::id`]).
    pub fn new() -> Self {
        let mut player = Node::with_defaults(NodeKind::Player, "player".to_string());
        player.props.insert(
            "version".to_string(),
            PropValue::Str(env!("CARGO_PKG_VERSION").to_string()),
        );
        player
            .props
            .insert("pid".to_string(), PropValue::I64(std::process::id() as i64));

        let mut nodes = BTreeMap::new();
        nodes.insert("player".to_string(), player);

        Graph {
            nodes,
            next_src: 0,
            next_lay: 0,
            next_fx: 0,
            changes: Vec::new(),
            tr_sources: BTreeMap::new(),
            tr_graves: BTreeSet::new(),
            parked: None,
            picture_rev: 0,
        }
    }

    /// Picture-affecting mutations so far: bumped by `create`, `destroy` and every `set`
    /// except `gain.<slot>`; never by `set_observed` (the redraw policy, `crate::redraw`).
    pub fn picture_rev(&self) -> u64 {
        self.picture_rev
    }

    /// Creates a node of `kind`. `id` is required (and used verbatim) for `Output`;
    /// otherwise `None` auto-mints `src<n>`/`lay<n>`/`fx<n>` (independent counters). `props`
    /// is validated (type + range, via [`props::from_json`] then [`props::validate_value`])
    /// before anything is created — a bad entry means nothing is created, not a half-built
    /// node. `enforce_readonly` is off for this initial seeding, so e.g. a future task can
    /// seed `Output.width`/`height` from the real Wayland output at creation time. Creating
    /// an `Output` also creates its `lay:<connector>:main` [`Layer`] (`output` set, `content`
    /// left at its default-unset `""`). Returns the id actually used.
    pub fn create(
        &mut self,
        kind: NodeKind,
        id: Option<String>,
        props: Map<String, Value>,
    ) -> Result<String, ApiError> {
        if kind == NodeKind::Player {
            return Err(unsupported(
                "player is a singleton created by Graph::new, not Graph::create",
            ));
        }

        let new_id = self.mint_id(kind, id)?;
        if self.nodes.contains_key(&new_id) {
            return Err(unsupported(format!("node {new_id:?} already exists")));
        }

        let mut coerced = Vec::with_capacity(props.len());
        for (k, v) in &props {
            coerced.push((k.clone(), Self::validate_create_prop(kind, k, v)?));
        }

        let mut node = Node::with_defaults(kind, new_id.clone());
        for (k, pv) in coerced {
            if let Some(slot_name) = k.strip_prefix("gain.") {
                if let (Ok(slot), PropValue::F64(db)) = (slot_name.parse::<GainSlot>(), &pv) {
                    node.gain_slots.insert(slot, *db);
                }
            } else {
                node.props.insert(k, pv);
            }
        }
        self.nodes.insert(new_id.clone(), node);
        self.picture_rev += 1;

        if kind == NodeKind::Output {
            let connector = new_id.strip_prefix("out:").unwrap_or(&new_id);
            let lay_id = format!("lay:{connector}:main");
            let mut lay_props = Map::new();
            lay_props.insert("output".to_string(), Value::String(new_id.clone()));
            // "Err means nothing was created" must hold for the Output too: if the nested
            // main-layer create fails for any reason (today, only a pre-existing node
            // already sitting on the reserved `lay:<connector>:main` id), roll back the
            // Output we just inserted rather than leaving a layer-less Output committed.
            if let Err(e) = self.create(NodeKind::Layer, Some(lay_id), lay_props) {
                self.nodes.remove(&new_id);
                return Err(e);
            }
        }

        Ok(new_id)
    }

    fn validate_create_prop(
        kind: NodeKind,
        prop: &str,
        raw: &Value,
    ) -> Result<PropValue, ApiError> {
        if let Some(slot_name) = prop.strip_prefix("gain.") {
            if kind != NodeKind::Source || slot_name.parse::<GainSlot>().is_err() {
                return Err(props::no_such_prop(prop));
            }
            return props::from_json(prop, PropType::F64, raw);
        }

        let pd = props::schema_for(kind, prop).ok_or_else(|| props::no_such_prop(prop))?;
        let pv = props::from_json(prop, pd.ty, raw)?;
        props::validate_value(kind, prop, &pv, false)?;
        Ok(pv)
    }

    fn mint_id(&mut self, kind: NodeKind, id: Option<String>) -> Result<String, ApiError> {
        match (kind, id) {
            (NodeKind::Output, Some(id)) => Ok(id),
            (NodeKind::Output, None) => Err(unsupported(
                "Output requires an explicit id, e.g. create(Output, Some(\"out:DP-1\"), ..)",
            )),
            (NodeKind::Source, Some(id)) => Ok(id),
            (NodeKind::Source, None) => {
                self.next_src += 1;
                Ok(format!("src{}", self.next_src))
            }
            (NodeKind::Layer, Some(id)) => Ok(id),
            (NodeKind::Layer, None) => {
                self.next_lay += 1;
                Ok(format!("lay{}", self.next_lay))
            }
            (NodeKind::Effect, Some(id)) => Ok(id),
            (NodeKind::Effect, None) => {
                self.next_fx += 1;
                Ok(format!("fx{}", self.next_fx))
            }
            (NodeKind::Player, _) => unreachable!("guarded by the caller"),
        }
    }

    /// Destroys a node by its exact id (no alias resolution). Destroying an `Output` also
    /// destroys its `lay:<connector>:main` layer. The `player` singleton can never be
    /// destroyed.
    pub fn destroy(&mut self, id: &str) -> Result<(), ApiError> {
        if id == "player" {
            return Err(unsupported("the player singleton cannot be destroyed"));
        }
        let node = self.nodes.remove(id).ok_or_else(|| no_such_node(id))?;
        self.picture_rev += 1;
        if node.kind == NodeKind::Output {
            let connector = id.strip_prefix("out:").unwrap_or(id);
            self.nodes.remove(&format!("lay:{connector}:main"));
        }
        Ok(())
    }

    /// Sets one property. `path`'s node-id part is resolved via [`Graph::resolve`] first, so
    /// this works on aliases too (`out:*.paused` pauses every output) — every resolution is
    /// validated before any of them is mutated, so a failing alias expansion changes
    /// nothing. Every successful application is recorded in `drain_changes`'s queue, one
    /// entry per resolved node, in resolution order.
    pub fn set(&mut self, path: &PropPath, value: PropValue) -> Result<(), ApiError> {
        let (node_ref, prop) = split_path(path)?;
        let targets = self.resolve(node_ref);
        if targets.is_empty() {
            return Err(no_such_node(node_ref));
        }
        for id in &targets {
            // `resolve` must never hand back a dangling id, but this is the one place a
            // future resolve bug would otherwise turn into a panic instead of an error —
            // treat a missing node as `no_such_node`, not an invariant violation.
            let kind = self.nodes.get(id).ok_or_else(|| no_such_node(id))?.kind;
            props::validate_value(kind, prop, &value, true)?;
        }
        for id in &targets {
            self.apply_set(id, prop, value.clone(), true);
        }
        Ok(())
    }

    /// [`Graph::set`] from a raw wire value (the command API's `set`): each resolved node's
    /// value is typed through its own schema (`gain.<slot>` → dB number) — same resolution,
    /// same check order (`no_such_prop` > `read_only` > `bad_type`/`out_of_range`), same
    /// all-or-nothing rule. Returns the node ids it applied to.
    pub fn set_json(&mut self, path: &PropPath, raw: &Value) -> Result<Vec<String>, ApiError> {
        let (node_ref, prop) = split_path(path)?;
        let targets = self.resolve(node_ref);
        if targets.is_empty() {
            return Err(no_such_node(node_ref));
        }
        let mut vals = Vec::with_capacity(targets.len());
        for id in &targets {
            let kind = self.nodes.get(id).ok_or_else(|| no_such_node(id))?.kind;
            vals.push(Self::typed_for_set(kind, prop, raw)?);
        }
        for (id, v) in targets.iter().zip(vals) {
            self.apply_set(id, prop, v, true);
        }
        Ok(targets)
    }

    /// Type + validate a raw wire value for `kind.prop` exactly as [`Graph::set_json`] does
    /// (without needing a node) — the API uses it to check a broadcast whose alias matches
    /// nothing yet.
    pub fn typed_for_set(kind: NodeKind, prop: &str, raw: &Value) -> Result<PropValue, ApiError> {
        let ty = if prop.starts_with("gain.") {
            PropType::F64
        } else {
            let pd = props::schema_for(kind, prop).ok_or_else(|| props::no_such_prop(prop))?;
            // read_only beats bad_type: check it on a value of the right shape first.
            props::validate_value(kind, prop, &pd.default, true)?;
            pd.ty
        };
        if prop.starts_with("gain.") {
            // no_such_prop (wrong kind / slot) beats bad_type.
            props::validate_value(kind, prop, &PropValue::F64(0.0), true)?;
        }
        let v = props::from_json(prop, ty, raw)?;
        props::validate_value(kind, prop, &v, true)?;
        Ok(v)
    }

    /// The transition half of the `srcs:` alias (R50): `by_output` maps `out:<connector>`
    /// to the sources in-flight transitions on it hold (pending B, held A's); `graves` are
    /// released sources about to be destroyed, never included through this map. Replaces
    /// the previous value; the runtime calls it after every `Transitions` start/cancel/tick.
    pub fn set_transition_sources(
        &mut self,
        by_output: BTreeMap<String, BTreeSet<String>>,
        graves: BTreeSet<String>,
    ) {
        self.tr_sources = by_output;
        self.tr_graves = graves;
    }

    /// The wallpaper the runtime parked because no output is left (R60) — silent and
    /// paused, but still a target of `srcs:*` so global settings keep reaching it.
    pub fn set_parked(&mut self, id: Option<String>) {
        self.parked = id;
    }

    /// Writes an **observed** value (what a live source reports: `ready`, `duration`,
    /// `time_pos`, `width`, `height`, and `paused` as mpv reports it — mirrored by
    /// `sources::SourceHost::update`). Same resolution and type/range validation as
    /// [`Graph::set`], but it bypasses the `read_only` check and is **not** recorded in
    /// [`Graph::drain_changes`]: an observation must never be forwarded back to the source
    /// it came from as if it were a command.
    pub fn set_observed(&mut self, path: &PropPath, value: PropValue) -> Result<(), ApiError> {
        let (node_ref, prop) = split_path(path)?;
        let targets = self.resolve(node_ref);
        if targets.is_empty() {
            return Err(no_such_node(node_ref));
        }
        for id in &targets {
            let kind = self.nodes.get(id).ok_or_else(|| no_such_node(id))?.kind;
            props::validate_value(kind, prop, &value, false)?;
        }
        for id in &targets {
            self.apply_set(id, prop, value.clone(), false);
        }
        Ok(())
    }

    /// The kind of node `id` (exact id, no alias resolution), or `None` if there is none.
    pub fn kind_of(&self, id: &str) -> Option<NodeKind> {
        self.nodes.get(id).map(|n| n.kind)
    }

    /// Every node id of `kind`, sorted.
    pub fn ids_of(&self, kind: NodeKind) -> Vec<String> {
        self.nodes
            .values()
            .filter(|n| n.kind == kind)
            .map(|n| n.id.clone())
            .collect()
    }

    /// Every property of node `id` (exact id) with its current value, plus — for a
    /// `Source` — one `gain.<slot>` entry per gain slot that has been set. What
    /// `sources::SourceHost` opens a live source from.
    pub fn props_of(&self, id: &str) -> Option<Vec<(String, PropValue)>> {
        let node = self.nodes.get(id)?;
        let mut out: Vec<(String, PropValue)> = node
            .props
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (slot, db) in &node.gain_slots {
            out.push((format!("gain.{}", slot.as_str()), PropValue::F64(*db)));
        }
        Some(out)
    }

    /// A `Source` node's summed gain in dB (`units::Gains::effective_db`, clamped to
    /// `[-96, 12]`) — the same number `snapshot()` reports as `gain_effective_db`. `None`
    /// for a missing or non-`Source` node.
    pub fn effective_gain_db(&self, id: &str) -> Option<f64> {
        let node = self.nodes.get(id)?;
        if node.kind != NodeKind::Source {
            return None;
        }
        let mut gains = Gains::new();
        for (slot, db) in &node.gain_slots {
            gains.set(*slot, *db);
        }
        Some(gains.effective_db())
    }

    fn apply_set(&mut self, id: &str, prop: &str, value: PropValue, record: bool) {
        if let Some(slot_name) = prop.strip_prefix("gain.") {
            if let (Ok(slot), PropValue::F64(db)) = (slot_name.parse::<GainSlot>(), &value)
                && let Some(node) = self.nodes.get_mut(id)
            {
                node.gain_slots.insert(slot, *db);
            }
        } else if let Some(node) = self.nodes.get_mut(id) {
            node.props.insert(prop.to_string(), value.clone());
        }
        if record {
            if !prop.starts_with("gain.") {
                self.picture_rev += 1;
            }
            self.changes.push((PropPath(format!("{id}.{prop}")), value));
        }
    }

    /// Gets one property. `path`'s node-id part is resolved via [`Graph::resolve`] first: no
    /// resolution is `no_such_node`, more than one is `ambiguous` (there's no single value
    /// to return), exactly one proceeds normally.
    pub fn get(&self, path: &PropPath) -> Result<PropValue, ApiError> {
        let (node_ref, prop) = split_path(path)?;
        let targets = self.resolve(node_ref);
        match targets.len() {
            0 => Err(no_such_node(node_ref)),
            1 => self.get_one(&targets[0], prop),
            _ => Err(ambiguous(node_ref)),
        }
    }

    fn get_one(&self, id: &str, prop: &str) -> Result<PropValue, ApiError> {
        // Same defense-in-depth as `set`: a dangling id from `resolve` must surface as
        // `no_such_node`, never a panic.
        let Some(node) = self.nodes.get(id) else {
            return Err(no_such_node(id));
        };
        if let Some(slot_name) = prop.strip_prefix("gain.") {
            if node.kind != NodeKind::Source {
                return Err(props::no_such_prop(prop));
            }
            let slot: GainSlot = slot_name.parse().map_err(|_| props::no_such_prop(prop))?;
            return Ok(PropValue::F64(
                node.gain_slots.get(&slot).copied().unwrap_or(0.0),
            ));
        }
        node.props
            .get(prop)
            .cloned()
            .ok_or_else(|| props::no_such_prop(prop))
    }

    /// Resolves an alias or concrete id to the node ids it addresses (see the module doc
    /// comment for the alias rules). Never errors — an unresolvable id/alias is an empty
    /// vec; `set`/`get` turn that into `no_such_node`.
    pub fn resolve(&self, alias: &str) -> Vec<String> {
        match alias {
            "out:*" => self
                .nodes
                .values()
                .filter(|n| n.kind == NodeKind::Output)
                .map(|n| n.id.clone())
                .collect(),
            "lay:*:main" => self
                .nodes
                .values()
                .filter(|n| n.kind == NodeKind::Layer && n.id.ends_with(":main"))
                .map(|n| n.id.clone())
                .collect(),
            "cur:*" => {
                let mut set = std::collections::BTreeSet::new();
                for n in self.nodes.values().filter(|n| n.kind == NodeKind::Output) {
                    if let Some(connector) = n.id.strip_prefix("out:") {
                        for s in self.cur_for_connector(connector) {
                            set.insert(s);
                        }
                    }
                }
                set.into_iter().collect()
            }
            "srcs:*" => {
                let mut set = BTreeSet::new();
                for n in self.nodes.values().filter(|n| n.kind == NodeKind::Output) {
                    if let Some(connector) = n.id.strip_prefix("out:") {
                        set.extend(self.srcs_for_connector(connector));
                    }
                }
                if let Some(p) = &self.parked
                    && self.kind_of(p) == Some(NodeKind::Source)
                {
                    set.insert(p.clone());
                }
                set.into_iter().collect()
            }
            _ => {
                if let Some(connector) = alias.strip_prefix("srcs:") {
                    self.srcs_for_connector(connector).into_iter().collect()
                } else if let Some(connector) = alias.strip_prefix("cur:") {
                    self.cur_for_connector(connector)
                } else if self.nodes.contains_key(alias) {
                    vec![alias.to_string()]
                } else {
                    vec![]
                }
            }
        }
    }

    /// What `lay:<connector>:main` currently shows, per the `cur:` alias rule: the `Source`
    /// id directly, the `to` side if it's showing through an `Effect`, or nothing if
    /// `content` is unset or dangling.
    fn cur_for_connector(&self, connector: &str) -> Vec<String> {
        let Some(layer) = self.nodes.get(&format!("lay:{connector}:main")) else {
            return vec![];
        };
        let Some(PropValue::Str(content)) = layer.props.get("content") else {
            return vec![];
        };
        if content.is_empty() {
            return vec![];
        }
        match self.nodes.get(content) {
            Some(n) if n.kind == NodeKind::Source => vec![content.clone()],
            Some(n) if n.kind == NodeKind::Effect => match n.props.get("to") {
                // `to` must itself resolve to a real node — an effect whose incoming side
                // was destroyed mid-transition (ordinary operation, not a corner case)
                // must fall through to "nothing shown", never hand back a dangling id for
                // `set`/`get` to choke on.
                Some(PropValue::Str(to)) if !to.is_empty() && self.nodes.contains_key(to) => {
                    vec![to.clone()]
                }
                _ => vec![],
            },
            _ => vec![],
        }
    }

    /// The `srcs:<connector>` alias (module doc): sources shown by any layer of the output
    /// (directly or as an effect side) plus what in-flight transitions on it hold —
    /// snapshots and (transition-held) graves excluded; empty for an unknown output.
    fn srcs_for_connector(&self, connector: &str) -> BTreeSet<String> {
        let out = format!("out:{connector}");
        let mut set = BTreeSet::new();
        if !self.nodes.contains_key(&out) {
            return set;
        }
        let str_prop = |n: &Node, k: &str| match n.props.get(k) {
            Some(PropValue::Str(s)) => s.clone(),
            _ => String::new(),
        };
        for l in self.nodes.values().filter(|n| n.kind == NodeKind::Layer) {
            if str_prop(l, "output") != out && l.id != format!("lay:{connector}:main") {
                continue;
            }
            let content = str_prop(l, "content");
            match self.nodes.get(&content) {
                Some(n) if n.kind == NodeKind::Source => {
                    set.insert(content.clone());
                }
                Some(n) if n.kind == NodeKind::Effect => {
                    set.insert(str_prop(n, "from"));
                    set.insert(str_prop(n, "to"));
                }
                _ => {}
            }
        }
        if let Some(held) = self.tr_sources.get(&out) {
            set.extend(
                held.iter()
                    .filter(|id| !self.tr_graves.contains(*id))
                    .cloned(),
            );
        }
        set.retain(|id| {
            self.nodes
                .get(id)
                .is_some_and(|n| n.kind == NodeKind::Source && str_prop(n, "kind") != "snapshot")
        });
        set
    }

    /// The full live graph as JSON (spec §9's `state` query): one entry per node id, each
    /// holding `kind` plus every schema property (defaults included — nothing is omitted
    /// for being unset), and — for `Source` nodes only — `gain` (an object of only the gain
    /// slots that have been set, in dB) and `gain_effective_db` (their dB sum, clamped via
    /// `units::Gains::effective_db`).
    pub fn snapshot(&self) -> Value {
        let mut top = Map::new();
        for (id, node) in &self.nodes {
            top.insert(id.clone(), node.snapshot_obj());
        }
        Value::Object(top)
    }

    /// Drains and returns every `(PropPath, PropValue)` applied by `set` since the last
    /// call, in call order. Node creation never appears here (see the module doc comment).
    pub fn drain_changes(&mut self) -> Vec<(PropPath, PropValue)> {
        std::mem::take(&mut self.changes)
    }
}

/// Splits `"<node id>.<prop name>"` at the first `.` — node ids never contain `.` (they may
/// contain `:`), so the first `.` always ends the node id.
fn split_path(path: &PropPath) -> Result<(&str, &str), ApiError> {
    let s = path.0.as_str();
    match s.find('.') {
        Some(idx) => Ok((&s[..idx], &s[idx + 1..])),
        None => Err(ApiError {
            code: "no_such_prop",
            message: format!("prop path {s:?} has no '.' separating node id from property name"),
            hint: "paths look like \"<node id>.<prop name>\", e.g. \"src1.speed\"".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn out(g: &mut Graph, id: &str) -> String {
        g.create(NodeKind::Output, Some(id.to_string()), Map::new())
            .expect("create output")
    }

    fn src(g: &mut Graph, id: &str) -> String {
        g.create(NodeKind::Source, Some(id.to_string()), Map::new())
            .expect("create source")
    }

    fn p(path: &str) -> PropPath {
        PropPath(path.to_string())
    }

    #[test]
    fn create_and_alias() {
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        out(&mut g, "out:DP-2");

        assert_eq!(
            g.resolve("out:*"),
            vec!["out:DP-1".to_string(), "out:DP-2".to_string()]
        );
        assert_eq!(
            g.resolve("lay:DP-1:main"),
            vec!["lay:DP-1:main".to_string()]
        );
    }

    #[test]
    fn set_get_typed() {
        let mut g = Graph::new();
        src(&mut g, "src1");

        g.set(&p("src1.speed"), PropValue::F64(1.5)).expect("ok");
        assert_eq!(g.get(&p("src1.speed")).unwrap(), PropValue::F64(1.5));

        let err = g
            .set(&p("src1.speed"), PropValue::Str("fast".to_string()))
            .unwrap_err();
        assert_eq!(err.code, "bad_type");

        let err = g.set(&p("src1.speed"), PropValue::F64(9.0)).unwrap_err();
        assert_eq!(err.code, "out_of_range");
        assert!(err.hint.contains("0.1–4.0"), "hint was: {}", err.hint);
    }

    /// Task 13: the redraw policy's counter — a picture can only change through create,
    /// destroy or a non-gain set; gain slots and observations never wake an output.
    #[test]
    fn picture_rev_counts_picture_mutations_only() {
        let mut g = Graph::new();
        let r0 = g.picture_rev();
        out(&mut g, "out:DP-1");
        src(&mut g, "src1");
        let r1 = g.picture_rev();
        assert!(r1 >= r0 + 2, "create bumps ({r0} -> {r1})");
        g.set(&p("src1.gain.user"), PropValue::F64(-6.0)).unwrap();
        g.set_observed(&p("src1.time_pos"), PropValue::F64(1.0))
            .unwrap();
        g.set_observed(&p("out:DP-1.pointer"), PropValue::List(vec![1.0, 2.0, 1.0]))
            .unwrap();
        assert_eq!(
            g.picture_rev(),
            r1,
            "gain + observations are not picture changes"
        );
        g.set(&p("lay:DP-1:main.content"), PropValue::Str("src1".into()))
            .unwrap();
        assert_eq!(g.picture_rev(), r1 + 1);
        g.set(&p("out:DP-1.layer"), PropValue::Str("overlay".into()))
            .unwrap();
        assert_eq!(g.picture_rev(), r1 + 2);
        g.destroy("src1").unwrap();
        assert_eq!(g.picture_rev(), r1 + 3);
        let err = g
            .set(&p("out:DP-1.pointer"), PropValue::List(vec![0.0, 0.0, 0.0]))
            .unwrap_err();
        assert_eq!(err.code, "read_only", "pointer is observed, never set");
    }

    #[test]
    fn read_only() {
        let mut g = Graph::new();
        src(&mut g, "src1");
        let err = g.set(&p("src1.duration"), PropValue::F64(3.0)).unwrap_err();
        assert_eq!(err.code, "read_only");
    }

    #[test]
    fn cur_alias_follows_layer() {
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        src(&mut g, "src1");
        src(&mut g, "src2");

        g.set(
            &p("lay:DP-1:main.content"),
            PropValue::Str("src1".to_string()),
        )
        .unwrap();
        assert_eq!(g.resolve("cur:DP-1"), vec!["src1".to_string()]);

        g.set(
            &p("lay:DP-1:main.content"),
            PropValue::Str("src2".to_string()),
        )
        .unwrap();
        assert_eq!(g.resolve("cur:DP-1"), vec!["src2".to_string()]);
    }

    #[test]
    fn snapshot_roundtrip() {
        let mut g = Graph::new();
        src(&mut g, "src1");
        g.set(&p("src1.speed"), PropValue::F64(2.0)).unwrap();
        g.set(&p("src1.gain.user"), PropValue::F64(-6.0)).unwrap();
        g.set(&p("src1.gain.xfade"), PropValue::F64(-3.0103))
            .unwrap();

        let snap = g.snapshot();
        let node = &snap["src1"];
        assert_eq!(node["speed"], json!(2.0));
        assert_eq!(node["gain"]["user"], json!(-6.0));
        assert!((node["gain"]["xfade"].as_f64().unwrap() - (-3.0103)).abs() < 1e-6);
        assert!(
            node["gain"].get("override").is_none(),
            "unset slots must not appear"
        );
        let eff = node["gain_effective_db"].as_f64().unwrap();
        assert!((eff - (-9.0103)).abs() < 1e-3, "eff = {eff}");
    }

    #[test]
    fn main_layer_auto_create_and_destroy() {
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        assert_eq!(
            g.resolve("lay:DP-1:main"),
            vec!["lay:DP-1:main".to_string()]
        );

        g.destroy("out:DP-1").unwrap();
        assert!(g.resolve("out:DP-1").is_empty());
        assert!(
            g.resolve("lay:DP-1:main").is_empty(),
            "destroying the output must destroy its main layer"
        );
    }

    #[test]
    fn cur_through_effect_follows_to_side() {
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        src(&mut g, "src1");
        src(&mut g, "src2");

        let mut props = Map::new();
        props.insert("effect_id".to_string(), json!("wipe"));
        props.insert("from".to_string(), json!("src1"));
        props.insert("to".to_string(), json!("src2"));
        let fx = g.create(NodeKind::Effect, None, props).unwrap();
        assert_eq!(fx, "fx1");

        g.set(&p("lay:DP-1:main.content"), PropValue::Str(fx))
            .unwrap();
        assert_eq!(g.resolve("cur:DP-1"), vec!["src2".to_string()]);
    }

    #[test]
    fn cur_through_destroyed_effect_to_side_never_panics() {
        // Regression: destroying a transition's incoming side mid-effect (ordinary
        // operation, not a corner case) must never hand `set`/`get` a dangling id via the
        // `cur:` alias — `resolve` must come back empty, and `set`/`get` must turn that
        // into `no_such_node`, not panic.
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        src(&mut g, "src1");
        src(&mut g, "src2");

        let mut props = Map::new();
        props.insert("effect_id".to_string(), json!("wipe"));
        props.insert("from".to_string(), json!("src1"));
        props.insert("to".to_string(), json!("src2"));
        let fx = g.create(NodeKind::Effect, None, props).unwrap();
        g.set(&p("lay:DP-1:main.content"), PropValue::Str(fx))
            .unwrap();

        g.destroy("src2").unwrap();

        assert_eq!(
            g.resolve("cur:DP-1"),
            Vec::<String>::new(),
            "to-side destroyed: cur:DP-1 must resolve to nothing, not a dangling id"
        );
        assert_eq!(g.resolve("cur:*"), Vec::<String>::new());

        let err = g.get(&p("cur:DP-1.speed")).unwrap_err();
        assert_eq!(err.code, "no_such_node");
        let err = g.get(&p("cur:*.speed")).unwrap_err();
        assert_eq!(err.code, "no_such_node");

        let err = g
            .set(&p("cur:DP-1.speed"), PropValue::F64(2.0))
            .unwrap_err();
        assert_eq!(err.code, "no_such_node");
        let err = g.set(&p("cur:*.speed"), PropValue::F64(2.0)).unwrap_err();
        assert_eq!(err.code, "no_such_node");
    }

    #[test]
    fn cur_with_directly_dangling_content_is_empty() {
        // Same rule, one hop shorter: layer.content points straight at a Source (no
        // Effect in between) that then gets destroyed.
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        src(&mut g, "src1");

        g.set(
            &p("lay:DP-1:main.content"),
            PropValue::Str("src1".to_string()),
        )
        .unwrap();
        g.destroy("src1").unwrap();

        assert_eq!(g.resolve("cur:DP-1"), Vec::<String>::new());
        let err = g.get(&p("cur:DP-1.speed")).unwrap_err();
        assert_eq!(err.code, "no_such_node");
    }

    #[test]
    fn create_output_rolls_back_on_main_layer_id_collision() {
        // "Err means nothing was created" must hold across the auto-created main layer
        // too: if something already occupies the reserved `lay:<connector>:main` id,
        // creating the output must fail *and* leave no half-built Output behind.
        let mut g = Graph::new();
        g.create(
            NodeKind::Layer,
            Some("lay:DP-1:main".to_string()),
            Map::new(),
        )
        .expect("pre-occupy the reserved main-layer id");

        let err = g.create(NodeKind::Output, Some("out:DP-1".to_string()), Map::new());
        assert!(
            err.is_err(),
            "creating the output must fail: its main-layer id is already taken"
        );
        assert!(
            g.resolve("out:DP-1").is_empty(),
            "a failed create must not leave the Output committed"
        );
    }

    #[test]
    fn ambiguous_get_on_multi_resolution_alias() {
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        out(&mut g, "out:DP-2");

        let err = g.get(&p("out:*.paused")).unwrap_err();
        assert_eq!(err.code, "ambiguous");
    }

    #[test]
    fn set_on_alias_applies_to_every_resolution() {
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");
        out(&mut g, "out:DP-2");

        g.set(&p("out:*.paused"), PropValue::Bool(true)).unwrap();
        assert_eq!(g.get(&p("out:DP-1.paused")).unwrap(), PropValue::Bool(true));
        assert_eq!(g.get(&p("out:DP-2.paused")).unwrap(), PropValue::Bool(true));
    }

    #[test]
    fn drain_changes_in_order() {
        let mut g = Graph::new();
        src(&mut g, "src1");
        src(&mut g, "src2");
        // Creation itself must never be reported as a change.
        assert!(g.drain_changes().is_empty());

        g.set(&p("src1.speed"), PropValue::F64(2.0)).unwrap();
        g.set(&p("src2.speed"), PropValue::F64(1.5)).unwrap();

        let changes = g.drain_changes();
        assert_eq!(
            changes,
            vec![
                (p("src1.speed"), PropValue::F64(2.0)),
                (p("src2.speed"), PropValue::F64(1.5)),
            ]
        );
        assert!(g.drain_changes().is_empty(), "drain must empty the queue");
    }

    #[test]
    fn set_observed_bypasses_read_only_and_is_not_a_change() {
        let mut g = Graph::new();
        src(&mut g, "src1");
        g.set_observed(&p("src1.duration"), PropValue::F64(3.0))
            .expect("observed write of a read-only prop");
        assert_eq!(g.get(&p("src1.duration")).unwrap(), PropValue::F64(3.0));
        g.set_observed(&p("src1.paused"), PropValue::Bool(true))
            .unwrap();
        assert!(
            g.drain_changes().is_empty(),
            "observations must never be forwarded back to the source"
        );
        // Still type-checked.
        let err = g
            .set_observed(&p("src1.duration"), PropValue::Str("x".into()))
            .unwrap_err();
        assert_eq!(err.code, "bad_type");
        assert_eq!(
            g.set_observed(&p("nope.duration"), PropValue::F64(1.0))
                .unwrap_err()
                .code,
            "no_such_node"
        );
    }

    #[test]
    fn node_accessors() {
        let mut g = Graph::new();
        src(&mut g, "src1");
        out(&mut g, "out:DP-1");
        g.set(&p("src1.gain.xfade"), PropValue::F64(-96.0)).unwrap();
        g.set(&p("src1.gain.user"), PropValue::F64(-6.0)).unwrap();
        assert_eq!(g.kind_of("src1"), Some(NodeKind::Source));
        assert_eq!(g.kind_of("nope"), None);
        assert_eq!(g.ids_of(NodeKind::Source), vec!["src1".to_string()]);
        let props = g.props_of("src1").unwrap();
        assert!(props.contains(&("gain.xfade".to_string(), PropValue::F64(-96.0))));
        assert!(props.iter().any(|(k, _)| k == "path"));
        assert_eq!(g.effective_gain_db("src1"), Some(-96.0));
        assert_eq!(g.effective_gain_db("out:DP-1"), None);
    }

    #[test]
    fn gain_slot_parse_errors() {
        let mut g = Graph::new();
        src(&mut g, "src1");
        out(&mut g, "out:DP-1");

        let err = g
            .set(&p("src1.gain.bogus"), PropValue::F64(-6.0))
            .unwrap_err();
        assert_eq!(err.code, "no_such_prop");

        let err = g
            .set(&p("out:DP-1.gain.user"), PropValue::F64(-6.0))
            .unwrap_err();
        assert_eq!(
            err.code, "no_such_prop",
            "gain.* is only valid on Source nodes"
        );
    }

    #[test]
    fn viewport_range_and_shape() {
        let mut g = Graph::new();
        out(&mut g, "out:DP-1");

        let err = g
            .set(
                &p("lay:DP-1:main.viewport"),
                PropValue::List(vec![0.0, 0.0, 1.0]),
            )
            .unwrap_err();
        assert_eq!(err.code, "bad_type", "wrong length must be bad_type");

        let err = g
            .set(
                &p("lay:DP-1:main.viewport"),
                PropValue::List(vec![0.0, 0.0, 0.0, 1.0]),
            )
            .unwrap_err();
        assert_eq!(err.code, "out_of_range", "w must be > 0");

        g.set(
            &p("lay:DP-1:main.viewport"),
            PropValue::List(vec![0.25, 0.25, 0.5, 0.5]),
        )
        .unwrap();
    }

    #[test]
    fn unknown_node_hints_at_ctl_state() {
        let g = Graph::new();
        let err = g.get(&p("nope.foo")).unwrap_err();
        assert_eq!(err.code, "no_such_node");
        assert!(err.hint.contains("ctl state"), "hint was: {}", err.hint);
    }

    #[test]
    fn player_singleton_props() {
        let mut g = Graph::new();
        assert_eq!(
            g.get(&p("player.version")).unwrap(),
            PropValue::Str(env!("CARGO_PKG_VERSION").to_string())
        );
        let pid = g.get(&p("player.pid")).unwrap();
        assert!(matches!(pid, PropValue::I64(n) if n > 0));

        let err = g
            .set(&p("player.version"), PropValue::Str("x".to_string()))
            .unwrap_err();
        assert_eq!(err.code, "read_only");

        assert_eq!(g.get(&p("player.debug")).unwrap(), PropValue::Bool(false));
    }

    #[test]
    fn fit_enum_round_trip() {
        for s in ["fill", "fit", "stretch", "crop"] {
            let f: Fit = s.parse().unwrap();
            assert_eq!(f.to_string(), s);
        }
        assert!("zoom".parse::<Fit>().is_err());
    }

    #[test]
    fn srcs_alias_layers_pending_and_exclusions() {
        let mut g = Graph::new();
        out(&mut g, "out:A");
        out(&mut g, "out:B");
        let a = src(&mut g, "a");
        let b = src(&mut g, "b");
        let pend = src(&mut g, "pend");
        let grave = src(&mut g, "grave");
        let snap = g
            .create(
                NodeKind::Source,
                Some("snap".into()),
                json!({"kind": "snapshot", "of": "a"})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .unwrap();
        // A shows a directly; B shows an effect snap → b.
        g.set(&p("lay:A:main.content"), PropValue::Str(a.clone()))
            .unwrap();
        let fx = g
            .create(
                NodeKind::Effect,
                Some("fx".into()),
                json!({"from": snap, "to": b, "effect_id": "fade"})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .unwrap();
        g.set(&p("lay:B:main.content"), PropValue::Str(fx)).unwrap();
        assert_eq!(g.resolve("srcs:A"), vec!["a"]);
        assert_eq!(g.resolve("srcs:B"), vec!["b"], "snapshot excluded");
        // A transition on A holds a pending B and a grave.
        let mut held = BTreeMap::new();
        held.insert(
            "out:A".to_string(),
            [pend.clone(), grave.clone()].into_iter().collect(),
        );
        g.set_transition_sources(held, [grave.clone()].into_iter().collect());
        assert_eq!(g.resolve("srcs:A"), vec!["a", "pend"], "grave excluded");
        assert_eq!(g.resolve("srcs:*"), vec!["a", "b", "pend"]);
        assert!(g.resolve("srcs:NOPE").is_empty());
        // `set` on the alias reaches the pending one too.
        let t = g.set_json(&p("srcs:*.gain.user"), &json!(-6)).unwrap();
        assert_eq!(t, vec!["a", "b", "pend"]);
        assert_eq!(g.get(&p("pend.gain.user")).unwrap(), PropValue::F64(-6.0));
        assert_eq!(g.get(&p("grave.gain.user")).unwrap(), PropValue::F64(0.0));
    }

    #[test]
    fn set_json_types_and_check_order() {
        let mut g = Graph::new();
        out(&mut g, "out:A");
        src(&mut g, "s");
        assert_eq!(g.set_json(&p("s.speed"), &json!(2)).unwrap(), vec!["s"]);
        assert_eq!(g.get(&p("s.speed")).unwrap(), PropValue::F64(2.0));
        g.set_json(&p("s.color"), &json!([1, 2, 3])).unwrap();
        // read_only beats bad_type; no_such_prop beats both.
        assert_eq!(
            g.set_json(&p("s.ready"), &json!("x")).unwrap_err().code,
            "read_only"
        );
        assert_eq!(
            g.set_json(&p("s.nope"), &json!("x")).unwrap_err().code,
            "no_such_prop"
        );
        assert_eq!(
            g.set_json(&p("out:A.gain.user"), &json!(1))
                .unwrap_err()
                .code,
            "no_such_prop"
        );
        assert_eq!(
            g.set_json(&p("s.gain.user"), &json!("x")).unwrap_err().code,
            "bad_type"
        );
        assert_eq!(
            g.set_json(&p("s.speed"), &json!(99)).unwrap_err().code,
            "out_of_range"
        );
        assert_eq!(
            g.set_json(&p("nope.x"), &json!(1)).unwrap_err().code,
            "no_such_node"
        );
        assert!(
            g.drain_changes().len() == 2,
            "only the two good sets recorded"
        );
    }
}
