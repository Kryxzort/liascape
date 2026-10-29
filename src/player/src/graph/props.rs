//! The property schema (spec §4.2 "Source"/"Output"/"Layer"/"Effect" blocks, §10): what
//! properties each [`crate::graph::NodeKind`] has, their JSON shape, their writable range
//! (where one exists), their default, and whether they're read-only.
//!
//! [`PropValue`] is the typed value a property holds inside the graph. The wire format
//! (command API, Task 12) is `serde_json::Value`; [`from_json`]/[`PropValue::to_json`] are
//! the two conversions between the two, done **with the property's declared [`PropType`] in
//! hand** — a bare JSON number is ambiguous between [`PropValue::F64`] and
//! [`PropValue::I64`], and only the schema (not the JSON payload) can say which one a given
//! property means. [`crate::graph::Graph::set`]/[`crate::graph::Graph::create`] both end up
//! calling [`validate_value`] (the former with a value already typed by the caller, the
//! latter via [`from_json`] first) — this is the single place that decides `bad_type` vs
//! `out_of_range` vs a clean pass.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{ApiError, NodeKind};
use crate::units::GainSlot;

/// A property's value, already typed to its schema's [`PropType`]. Stored directly in the
/// graph (`Node::props`); never serialized/deserialized generically (an `untagged` enum
/// derive would make `F64` vs `I64` ambiguous from JSON, which is exactly the ambiguity
/// [`from_json`] exists to resolve using the schema) — convert via [`from_json`]/
/// [`PropValue::to_json`] instead.
#[derive(Debug, Clone, PartialEq)]
pub enum PropValue {
    Bool(bool),
    F64(f64),
    I64(i64),
    Str(String),
    List(Vec<f64>),
    Map(serde_json::Map<String, Value>),
    /// A program's `items` (Phase 3).
    Items(Vec<ProgramItem>),
}

/// One item of a program (Phase 3, `prog:<name>.items`): a file, the `Source` create props
/// where it differs from the program's `defaults` (B's props = `defaults` with these merged
/// over them, shallowly), and whether the rotation passes it over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProgramItem {
    pub path: String,
    #[serde(default)]
    pub props: Map<String, Value>,
    #[serde(default)]
    pub skip: bool,
}

/// The most items a program holds.
pub const PROGRAM_ITEMS_MAX: usize = 10_000;

/// The longest program interval / limit (the backend's 0…359 999 s clamp), in ms.
pub const PROGRAM_MS_MAX: f64 = 359_999_000.0;

impl PropValue {
    /// Converts to the `serde_json::Value` the command API sends over the wire.
    pub fn to_json(&self) -> Value {
        match self {
            PropValue::Bool(b) => Value::Bool(*b),
            PropValue::F64(f) => serde_json::json!(f),
            PropValue::I64(i) => serde_json::json!(i),
            PropValue::Str(s) => Value::String(s.clone()),
            PropValue::List(v) => serde_json::json!(v),
            PropValue::Map(m) => Value::Object(m.clone()),
            PropValue::Items(v) => serde_json::to_value(v).unwrap_or(Value::Null),
        }
    }
}

/// The shape a property's value must have. Carried by [`PropDef`], looked up via
/// [`schema_for`]/[`schema_for_kind`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropType {
    Bool,
    F64,
    I64,
    Str,
    /// A string restricted to one of these lowercase variants (e.g. `fit`'s
    /// `fill|fit|stretch|crop`).
    Enum(&'static [&'static str]),
    /// A 3-element numeric list (`color`'s `[r,g,b]`).
    List3,
    /// A 4-element numeric list, with `viewport`'s own range rules (`[x,y,w,h]`, each in
    /// `[0,1]`, `w,h > 0`) applied by [`check_list`] — the only `List4`-typed property.
    List4,
    Map,
    /// A program's item list ([`ProgramItem`]s, ≤ [`PROGRAM_ITEMS_MAX`]; each `props` key a
    /// `Source` create prop, typed as a create would type it).
    Items,
    /// A map of `Source` create props (a program's `defaults`), checked like an item's.
    SourceProps,
    /// A program's `transition` (`recipes::program::TransitionCfg::from_map`).
    Transition,
}

/// One property's full schema entry: its shape, whether `set` may touch it, its numeric
/// range (if any — only `F64` properties the brief gives an exact range for carry one), and
/// the value a freshly-created node starts with.
#[derive(Debug, Clone)]
pub struct PropDef {
    pub ty: PropType,
    pub readonly: bool,
    /// `(lo, hi)` inclusive, checked against the value's `f64`. `None` means "typed but not
    /// range-checked" (e.g. `position`, `fps_cap` — the brief gives no range for them).
    pub range: Option<(f64, f64)>,
    /// The exact substring an `out_of_range` hint must contain for this property — kept as
    /// a literal rather than formatted from `range`, because `f64`'s `Display` drops a
    /// trailing `.0` (`format!("{}", 4.0)` is `"4"`, not `"4.0"`) and the brief's test
    /// asserts the hint contains the literal text `"0.1–4.0"`.
    pub range_hint: Option<&'static str>,
    pub default: PropValue,
}

fn def(ty: PropType, readonly: bool, default: PropValue) -> PropDef {
    PropDef {
        ty,
        readonly,
        range: None,
        range_hint: None,
        default,
    }
}

fn ranged(
    ty: PropType,
    range: (f64, f64),
    range_hint: &'static str,
    default: PropValue,
) -> PropDef {
    PropDef {
        ty,
        readonly: false,
        range: Some(range),
        range_hint: Some(range_hint),
        default,
    }
}

/// Every property [`NodeKind`] defines, in the order given by the brief, with its default
/// value. A freshly-created [`crate::graph::Node`] seeds every one of these into its `props`
/// map (`crate::graph::Node::with_defaults`) — `crate::graph::Graph::snapshot`'s "every node
/// with every property" promise falls out of that for free, with no special-casing for
/// unset properties.
pub fn schema_for_kind(kind: NodeKind) -> Vec<(&'static str, PropDef)> {
    match kind {
        NodeKind::Player => vec![
            ("debug", def(PropType::Bool, false, PropValue::Bool(false))),
            // R75 (Task 16b): player-level pause. `SourceHost` applies an *effective*
            // pause (`node.paused || player.paused`) to every video/image source, and the
            // runtime excises paused time from the clock it feeds the Animator and
            // `Transitions` — see `.claude/rules/player-core.md` § Graph & properties
            // "Player node `paused`" and § Runtime "Player-level pause".
            ("paused", def(PropType::Bool, false, PropValue::Bool(false))),
            (
                "version",
                def(PropType::Str, true, PropValue::Str(String::new())),
            ),
            ("pid", def(PropType::I64, true, PropValue::I64(0))),
            // Phase 2 Task 7: WE's `assets/` dir for scenes ("" = auto: `LIASCAPE_WE_ASSETS_DIR`,
            // then every Steam library — `scene::assets`); live (the next scene opened uses
            // it). `scene_assets_resolved` = what is in use ("" = none found: no `scene`
            // capability, a scene source errors with the hint).
            (
                "scene_assets",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            (
                "scene_assets_resolved",
                def(PropType::Str, true, PropValue::Str(String::new())),
            ),
            // Phase 2 Task 8 (owner: "GPU budget = a setting, default auto-throttle"): `true`
            // = a scene whose worker starves its outputs is throttled stepwise and restored
            // (`scene::budget`); `false` = every scene ticks at exactly its outputs'
            // `eff(scene_fps, refresh)` (a cap in force is lifted at once). Live.
            (
                "scene_throttle",
                def(PropType::Bool, false, PropValue::Bool(true)),
            ),
            // Task 8, the per-scene VRAM guard: a scene worker using more than this many MiB of
            // VRAM (2 s in a row) is stopped — reported like a broken scene (`source.error`)
            // plus `scene.vram_exceeded`, never a crash record. 0 = off (the default; the
            // owner's suggestion when on: 1536). Live (the next sample applies it).
            (
                "scene_vram_limit_mib",
                ranged(
                    PropType::F64,
                    (0.0, 1_048_576.0),
                    "0–1048576",
                    PropValue::F64(0.0),
                ),
            ),
            // Task 8, the system low-VRAM rule (owner round 3): what happens while the GPU's
            // free VRAM is low (`crate::vram` thresholds, hysteresis + hold): `stop` (the
            // default) pauses everything and frees the sources' GPU memory (each shows a still
            // of its last frame), `pause` only pauses, `off` does nothing. Every source kind;
            // resumes once VRAM is free again. Live.
            (
                "vram_low_mode",
                def(
                    PropType::Enum(&["stop", "pause", "off"]),
                    false,
                    PropValue::Str("stop".to_string()),
                ),
            ),
            // Observed: the low-VRAM rule is holding the player (paused, and in `stop` mode the
            // sources' GPU memory freed).
            (
                "vram_low_active",
                def(PropType::Bool, true, PropValue::Bool(false)),
            ),
        ],
        NodeKind::Output => vec![
            (
                "name",
                def(PropType::Str, true, PropValue::Str(String::new())),
            ),
            ("width", def(PropType::I64, true, PropValue::I64(0))),
            ("height", def(PropType::I64, true, PropValue::I64(0))),
            ("refresh_hz", def(PropType::I64, true, PropValue::I64(0))),
            (
                "layer",
                def(
                    PropType::Enum(&["background", "bottom", "top", "overlay"]),
                    false,
                    PropValue::Str("background".to_string()),
                ),
            ),
            ("paused", def(PropType::Bool, false, PropValue::Bool(false))),
            // Task 13: the pointer over this output's surface, `[x, y, buttons]` in surface
            // pixels (buttons: bit 0 left, 1 right, 2 middle, 3 side, 4 extra) — observed
            // (`set_observed`) by the Wayland backend, for Phase 2's mouse-reactive sources.
            (
                "pointer",
                def(PropType::List3, true, PropValue::List(vec![0.0, 0.0, 0.0])),
            ),
            // Phase 2 Task 5: the frame rate scene sources shown here are rendered at (D5:
            // 30, LWE's default); 0 = this output's refresh. A scene shown on several
            // outputs ticks at the highest of their `eff(scene_fps, refresh_hz)`.
            (
                "scene_fps",
                ranged(PropType::F64, (0.0, 480.0), "0–480", PropValue::F64(30.0)),
            ),
        ],
        NodeKind::Layer => vec![
            (
                "output",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            (
                "content",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            (
                "fit",
                def(
                    PropType::Enum(&["fill", "fit", "stretch", "crop"]),
                    false,
                    PropValue::Str("fill".to_string()),
                ),
            ),
            (
                "viewport",
                def(
                    PropType::List4,
                    false,
                    PropValue::List(vec![0.0, 0.0, 1.0, 1.0]),
                ),
            ),
            (
                "opacity",
                ranged(PropType::F64, (0.0, 1.0), "0–1", PropValue::F64(1.0)),
            ),
        ],
        NodeKind::Source => vec![
            (
                "kind",
                def(
                    PropType::Enum(&["video", "image", "color", "snapshot", "scene"]),
                    false,
                    PropValue::Str("video".to_string()),
                ),
            ),
            (
                "path",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            ("paused", def(PropType::Bool, false, PropValue::Bool(false))),
            (
                "speed",
                ranged(PropType::F64, (0.1, 4.0), "0.1–4.0", PropValue::F64(1.0)),
            ),
            ("loop", def(PropType::Bool, false, PropValue::Bool(false))),
            ("position", def(PropType::F64, false, PropValue::F64(0.0))),
            (
                "color",
                def(PropType::List3, false, PropValue::List(vec![0.0, 0.0, 0.0])),
            ),
            // `snapshot` sources only: the source node whose texture was copied at
            // creation (`sources::SnapshotSource`). Fixed for the node's life, so
            // read-only (seeded by `Graph::create`, which doesn't enforce read-only).
            (
                "of",
                def(PropType::Str, true, PropValue::Str(String::new())),
            ),
            ("ready", def(PropType::Bool, true, PropValue::Bool(false))),
            // R92: what mpv actually selected once the file loaded — `true` (the
            // conservative default) until a real source observes otherwise. Distinct
            // from `no_audio` (our own request) and `kind` (video vs a still): this is
            // "does the file even have an audio track". See `sources::MpvSource::
            // has_audio`'s doc.
            (
                "has_audio",
                def(PropType::Bool, true, PropValue::Bool(true)),
            ),
            // Phase 2 Task 10: a `scene` past its restart budget (3 crashes within 60 s) —
            // observed from the live source; it shows its last frame (or its `preview`), silent,
            // no worker. Seeded `true` at create by a snapshot restore (read-only like `of`):
            // the scene comes back as its preview, no worker. A `path` change plays again.
            ("broken", def(PropType::Bool, true, PropValue::Bool(false))),
            ("duration", def(PropType::F64, true, PropValue::F64(0.0))),
            ("time_pos", def(PropType::F64, true, PropValue::F64(0.0))),
            ("width", def(PropType::I64, true, PropValue::I64(0))),
            ("height", def(PropType::I64, true, PropValue::I64(0))),
            (
                "hwdec",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            ("fps_cap", def(PropType::F64, false, PropValue::F64(0.0))),
            ("cache", def(PropType::Bool, false, PropValue::Bool(true))),
            (
                "demuxer_max_mib",
                def(PropType::F64, false, PropValue::F64(0.0)),
            ),
            (
                "demuxer_back_mib",
                def(PropType::F64, false, PropValue::F64(0.0)),
            ),
            (
                "af",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            (
                "no_audio",
                def(PropType::Bool, false, PropValue::Bool(false)),
            ),
            (
                "audio_delay",
                def(PropType::F64, false, PropValue::F64(0.0)),
            ),
            // Phase 2 Task 5: a `scene`'s still image (the item's preview), shown while no
            // worker frame exists (Task 10). Stored on every kind, used by scenes only.
            (
                "preview",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            // Phase 2 Task 7: a scene's user properties (`project.json` `general.properties`
            // name → value: bool, number, `[r,g,b]` 0–1, or a string LWE parses by type),
            // applied at every open and live (each changed entry → `wp_project_property_set_*`
            // in the worker). Stored on every kind, used by scenes only.
            (
                "scene_props",
                def(PropType::Map, false, PropValue::Map(serde_json::Map::new())),
            ),
            // A scene's loudness measured over its earlier plays (`audio::loudness` state —
            // the histogram the backend stored from the last `scene.loudness`), continued by
            // this source; `{}` = none. Read at open (and a live set restarts the measurement
            // from it); a `path` change drops it. Stored on every kind, used by scenes only.
            (
                "loudness_seed",
                def(PropType::Map, false, PropValue::Map(serde_json::Map::new())),
            ),
            // The scene's audio configuration (the offline estimate's `fingerprint` of its
            // `scene_props`; "" = unknown): the loudness measurement is kept per (path, key),
            // so two configurations never share a histogram. A live change leaves the old
            // key's measurement (its rest reported with that key), joins the new one and drops
            // 0.5 s of segments (the stream still carries the old mix). `scene.loudness`
            // carries it. Stored on every kind, used by scenes only.
            (
                "loudness_key",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
        ],
        // Phase 3: a rotation (`recipes::program`). Settable props are the program's live
        // configuration; the observed ones are what it does now (read-only).
        NodeKind::Program => {
            let ms = |d: f64| {
                ranged(
                    PropType::F64,
                    (0.0, PROGRAM_MS_MAX),
                    "0–359999000",
                    PropValue::F64(d),
                )
            };
            let mut transition = Map::new();
            transition.insert("enabled".into(), Value::Bool(false));
            vec![
                // which outputs it switches; fixed after create
                (
                    "outputs",
                    def(PropType::Str, true, PropValue::Str("out:*".to_string())),
                ),
                (
                    "items",
                    def(PropType::Items, false, PropValue::Items(Vec::new())),
                ),
                (
                    "defaults",
                    def(PropType::SourceProps, false, PropValue::Map(Map::new())),
                ),
                (
                    "order",
                    def(
                        PropType::Enum(&["sequential", "shuffle"]),
                        false,
                        PropValue::Str("sequential".to_string()),
                    ),
                ),
                (
                    "mode",
                    def(
                        PropType::Enum(&["timer", "on_end"]),
                        false,
                        PropValue::Str("on_end".to_string()),
                    ),
                ),
                ("interval_ms", ms(0.0)),
                ("max_ms", ms(0.0)),
                (
                    "separate_scenes",
                    def(PropType::Bool, false, PropValue::Bool(true)),
                ),
                ("scenes_after_ms", ms(1_800_000.0)),
                (
                    "transition",
                    def(PropType::Transition, false, PropValue::Map(transition)),
                ),
                // the RNG seed (shuffles, random picks, effect picks); `create` mints one
                // from the wall clock when none is given
                ("seed", def(PropType::I64, false, PropValue::I64(0))),
                // while no output shows its item (O2): keep rotating invisibly (today's
                // behaviour) or hold both clocks until an output returns
                (
                    "while_parked",
                    def(
                        PropType::Enum(&["rotate", "hold"]),
                        false,
                        PropValue::Str("rotate".to_string()),
                    ),
                ),
                // the playlist's identity (`name:<saved name>` | `bar`; "" = none): its resume
                // point is kept per key (§ Playlist start)
                (
                    "key",
                    def(PropType::Str, false, PropValue::Str(String::new())),
                ),
                // "When the playlist starts again" (O4): start over (default) | resume
                (
                    "start_mode",
                    def(
                        PropType::Enum(&["start_over", "resume"]),
                        false,
                        PropValue::Str("start_over".to_string()),
                    ),
                ),
                // observed
                (
                    "phase",
                    def(PropType::Str, true, PropValue::Str("idle".to_string())),
                ),
                ("index", def(PropType::I64, true, PropValue::I64(-1))),
                (
                    "path",
                    def(PropType::Str, true, PropValue::Str(String::new())),
                ),
                (
                    "next_path",
                    def(PropType::Str, true, PropValue::Str(String::new())),
                ),
                ("played_ms", def(PropType::F64, true, PropValue::F64(0.0))),
                (
                    "remaining_ms",
                    def(PropType::F64, true, PropValue::F64(0.0)),
                ),
            ]
        }
        NodeKind::Effect => vec![
            (
                "effect_id",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            (
                "from",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            (
                "to",
                def(PropType::Str, false, PropValue::Str(String::new())),
            ),
            (
                "progress",
                ranged(PropType::F64, (0.0, 1.0), "0–1", PropValue::F64(0.0)),
            ),
            (
                "params",
                def(PropType::Map, false, PropValue::Map(serde_json::Map::new())),
            ),
        ],
    }
}

/// Looks up one property's schema entry by name. `None` means `name` isn't a property of
/// `kind` at all (callers turn that into `no_such_prop`) — this never resolves `gain.<slot>`
/// paths, which aren't static schema entries (see [`validate_value`]).
pub fn schema_for(kind: NodeKind, name: &str) -> Option<PropDef> {
    schema_table(kind)
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, d)| d.clone())
}

/// [`schema_for_kind`], built once per kind (F6b: every property write is validated through
/// [`schema_for`] — a scene's mirror and each gain push included, several per worker frame —
/// and rebuilding the whole table, defaults and all, for each lookup was a measurable share
/// of the loop mid-transition).
fn schema_table(kind: NodeKind) -> &'static [(&'static str, PropDef)] {
    use std::sync::OnceLock;
    static TABLES: [OnceLock<Vec<(&'static str, PropDef)>>; 6] = [const { OnceLock::new() }; 6];
    let i = match kind {
        NodeKind::Player => 0,
        NodeKind::Output => 1,
        NodeKind::Layer => 2,
        NodeKind::Source => 3,
        NodeKind::Effect => 4,
        NodeKind::Program => 5,
    };
    TABLES[i].get_or_init(|| schema_for_kind(kind))
}

/// The single gate both `Graph::set` (value already typed) and `Graph::create` (value typed
/// via [`from_json`] first) pass every property write through. Order matters: `no_such_prop`
/// (name unknown, or `gain.*` on a non-`Source`/with an unparseable slot) beats `read_only`
/// beats `bad_type`/`out_of_range` — you can't tell a caller their value's shape is wrong on
/// a property they weren't allowed to touch in the first place.
///
/// `enforce_readonly` is `false` only from `Graph::create`'s initial-props path, so a
/// read-only property (`width`, `height`, …) can be seeded at creation time by whatever
/// later owns discovering the real value (the Wayland output enumeration, the mpv wrapper,
/// …) without that becoming a generally-writable property.
pub fn validate_value(
    kind: NodeKind,
    prop: &str,
    value: &PropValue,
    enforce_readonly: bool,
) -> Result<(), ApiError> {
    if let Some(slot_name) = prop.strip_prefix("gain.") {
        if kind != NodeKind::Source {
            return Err(no_such_prop(prop));
        }
        if slot_name.parse::<GainSlot>().is_err() {
            return Err(no_such_prop(prop));
        }
        return match value {
            PropValue::F64(_) => Ok(()),
            _ => Err(bad_type(prop, "a number (dB)")),
        };
    }

    let pd = schema_for(kind, prop).ok_or_else(|| no_such_prop(prop))?;
    if enforce_readonly && pd.readonly {
        return Err(read_only(prop));
    }
    check_type_and_range(prop, &pd, value)
}

fn check_type_and_range(prop: &str, pd: &PropDef, value: &PropValue) -> Result<(), ApiError> {
    match pd.ty {
        PropType::Bool => match value {
            PropValue::Bool(_) => Ok(()),
            _ => Err(bad_type(prop, "a bool")),
        },
        PropType::Str => match value {
            PropValue::Str(_) => Ok(()),
            _ => Err(bad_type(prop, "a string")),
        },
        PropType::Enum(variants) => match value {
            PropValue::Str(s) if variants.contains(&s.as_str()) => Ok(()),
            PropValue::Str(_) => Err(bad_type_enum(prop, variants)),
            _ => Err(bad_type(prop, "a string")),
        },
        PropType::F64 => {
            let n = numeric_f64(value).ok_or_else(|| bad_type(prop, "a number"))?;
            if let Some((lo, hi)) = pd.range
                && (n < lo || n > hi)
            {
                return Err(out_of_range(
                    prop,
                    pd.range_hint.unwrap_or("its declared range"),
                ));
            }
            Ok(())
        }
        PropType::I64 => match value {
            PropValue::I64(_) => Ok(()),
            PropValue::F64(f) if f.fract() == 0.0 => Ok(()),
            _ => Err(bad_type(prop, "an integer")),
        },
        PropType::Map => match value {
            PropValue::Map(_) => Ok(()),
            _ => Err(bad_type(prop, "an object")),
        },
        PropType::Items => match value {
            PropValue::Items(items) => check_items(prop, items),
            _ => Err(bad_type(prop, "a list of {path, props?, skip?}")),
        },
        PropType::SourceProps => match value {
            PropValue::Map(m) => check_source_props(prop, m),
            _ => Err(bad_type(prop, "an object of Source props")),
        },
        PropType::Transition => match value {
            PropValue::Map(m) => crate::recipes::program::TransitionCfg::from_map(m).map(|_| ()),
            _ => Err(bad_type(prop, "an object")),
        },
        PropType::List3 => check_list(prop, value, 3, false),
        PropType::List4 => check_list(prop, value, 4, true),
    }
}

/// A program's items: at most [`PROGRAM_ITEMS_MAX`], each with a non-empty path and valid
/// `Source` create props. Every error names the item (`items[3].props: …`).
fn check_items(prop: &str, items: &[ProgramItem]) -> Result<(), ApiError> {
    if items.len() > PROGRAM_ITEMS_MAX {
        return Err(out_of_range(prop, "at most 10000 items"));
    }
    for (i, it) in items.iter().enumerate() {
        if it.path.is_empty() {
            return Err(bad_type(&format!("{prop}[{i}].path"), "a non-empty path"));
        }
        check_source_props(&format!("{prop}[{i}].props"), &it.props)?;
    }
    Ok(())
}

/// Every key a `Source` create prop (`gain.<slot>` included), its value typed and
/// range-checked as a `Source` create would check it (read-only props may be seeded, as at
/// create). The error's message is prefixed with `at`.
fn check_source_props(at: &str, m: &Map<String, Value>) -> Result<(), ApiError> {
    for (k, v) in m {
        let typed = if let Some(slot) = k.strip_prefix("gain.") {
            if slot.parse::<GainSlot>().is_err() {
                Err(no_such_prop(k))
            } else {
                from_json(k, PropType::F64, v)
            }
        } else {
            match schema_for(NodeKind::Source, k) {
                None => Err(no_such_prop(k)),
                Some(pd) => from_json(k, pd.ty, v),
            }
        };
        typed
            .and_then(|pv| validate_value(NodeKind::Source, k, &pv, false))
            .map_err(|mut e| {
                e.message = format!("{at}: {}", e.message);
                e
            })?;
    }
    Ok(())
}

fn numeric_f64(value: &PropValue) -> Option<f64> {
    match value {
        PropValue::F64(f) => Some(*f),
        PropValue::I64(i) => Some(*i as f64),
        _ => None,
    }
}

/// Checks a `List`-typed value against its required length, and — for `viewport` (the only
/// `List4`) — the per-element range: `x,y` in `[0,1]`, `w,h` in `(0,1]` (never zero- or
/// negative-sized).
fn check_list(prop: &str, value: &PropValue, len: usize, viewport: bool) -> Result<(), ApiError> {
    let PropValue::List(v) = value else {
        return Err(bad_type(prop, &format!("a list of {len} numbers")));
    };
    if v.len() != len {
        return Err(bad_type(prop, &format!("a list of {len} numbers")));
    }
    if viewport {
        for (i, x) in v.iter().enumerate() {
            if i < 2 {
                if *x < 0.0 || *x > 1.0 {
                    return Err(out_of_range(prop, "x,y within 0–1"));
                }
            } else if *x <= 0.0 || *x > 1.0 {
                return Err(out_of_range(prop, "w,h within 0–1 (w,h must be > 0)"));
            }
        }
    }
    Ok(())
}

/// Converts a raw wire value into a [`PropValue`] of the given [`PropType`] — the ambiguity
/// [`from_json`] exists to resolve is that a bare JSON number (`9`, `9.0`) doesn't say on
/// its own whether it means [`PropValue::I64`] or [`PropValue::F64`]; only the schema does.
/// This only checks *shape* (errors are always `bad_type`) — range-checking happens
/// separately via [`validate_value`], which `Graph::create` calls right after this succeeds.
pub fn from_json(prop: &str, ty: PropType, v: &Value) -> Result<PropValue, ApiError> {
    match ty {
        PropType::Bool => v
            .as_bool()
            .map(PropValue::Bool)
            .ok_or_else(|| bad_type(prop, "a bool")),
        PropType::Str => v
            .as_str()
            .map(|s| PropValue::Str(s.to_string()))
            .ok_or_else(|| bad_type(prop, "a string")),
        PropType::Enum(variants) => {
            let s = v.as_str().ok_or_else(|| bad_type(prop, "a string"))?;
            if variants.contains(&s) {
                Ok(PropValue::Str(s.to_string()))
            } else {
                Err(bad_type_enum(prop, variants))
            }
        }
        PropType::F64 => v
            .as_f64()
            .map(PropValue::F64)
            .ok_or_else(|| bad_type(prop, "a number")),
        PropType::I64 => {
            if let Some(i) = v.as_i64() {
                Ok(PropValue::I64(i))
            } else if let Some(f) = v.as_f64() {
                if f.fract() == 0.0 {
                    Ok(PropValue::I64(f as i64))
                } else {
                    Err(bad_type(prop, "an integer"))
                }
            } else {
                Err(bad_type(prop, "an integer"))
            }
        }
        PropType::Map | PropType::SourceProps | PropType::Transition => v
            .as_object()
            .cloned()
            .map(PropValue::Map)
            .ok_or_else(|| bad_type(prop, "an object")),
        PropType::Items => {
            let arr = v
                .as_array()
                .ok_or_else(|| bad_type(prop, "a list of {path, props?, skip?}"))?;
            let mut items = Vec::with_capacity(arr.len());
            for (i, it) in arr.iter().enumerate() {
                if !it.is_object() {
                    return Err(bad_type(
                        &format!("{prop}[{i}]"),
                        "an object {path, props?, skip?}",
                    ));
                }
                items.push(serde_json::from_value(it.clone()).map_err(|e| {
                    bad_type(
                        &format!("{prop}[{i}]"),
                        &format!("{{path: string, props?: object, skip?: bool}} ({e})"),
                    )
                })?);
            }
            Ok(PropValue::Items(items))
        }
        PropType::List3 => json_to_list(prop, v, 3),
        PropType::List4 => json_to_list(prop, v, 4),
    }
}

fn json_to_list(prop: &str, v: &Value, len: usize) -> Result<PropValue, ApiError> {
    let arr = v
        .as_array()
        .ok_or_else(|| bad_type(prop, &format!("a list of {len} numbers")))?;
    if arr.len() != len {
        return Err(bad_type(prop, &format!("a list of {len} numbers")));
    }
    let mut out = Vec::with_capacity(len);
    for item in arr {
        out.push(
            item.as_f64()
                .ok_or_else(|| bad_type(prop, &format!("a list of {len} numbers")))?,
        );
    }
    Ok(PropValue::List(out))
}

pub(crate) fn no_such_prop(prop: &str) -> ApiError {
    ApiError {
        code: "no_such_prop",
        message: format!("no such property: {prop:?}"),
        hint: "see .claude/rules/player-core.md \u{a7} Graph & properties for the schema"
            .to_string(),
    }
}

fn read_only(prop: &str) -> ApiError {
    ApiError {
        code: "read_only",
        message: format!("{prop} is read-only"),
        hint: format!("{prop} is read-only; see `liascape-player ctl state` for its current value"),
    }
}

fn bad_type(prop: &str, expected: &str) -> ApiError {
    ApiError {
        code: "bad_type",
        message: format!("{prop}: wrong type"),
        hint: format!("{prop} expects {expected}"),
    }
}

fn bad_type_enum(prop: &str, variants: &[&str]) -> ApiError {
    ApiError {
        code: "bad_type",
        message: format!("{prop}: invalid value"),
        hint: format!("{prop} must be one of {}", variants.join("|")),
    }
}

fn out_of_range(prop: &str, hint_range: &str) -> ApiError {
    ApiError {
        code: "out_of_range",
        message: format!("{prop} is out of range"),
        hint: format!("{prop} must be within {hint_range}"),
    }
}

/// `fit`'s value, for typed consumers (the renderer, Task 9) that don't want to re-parse the
/// schema's enum strings themselves. The graph itself still stores `fit` as
/// `PropValue::Str` (validated against the same four lowercase strings by
/// [`check_type_and_range`]) — this is a convenience conversion at the read side, not a
/// second storage representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Fill,
    Fit,
    Stretch,
    Crop,
}

impl Fit {
    pub fn as_str(&self) -> &'static str {
        match self {
            Fit::Fill => "fill",
            Fit::Fit => "fit",
            Fit::Stretch => "stretch",
            Fit::Crop => "crop",
        }
    }
}

impl fmt::Display for Fit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned by [`Fit::from_str`] for a string that isn't one of the four lowercase
/// variants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseFitError(pub String);

impl fmt::Display for ParseFitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown fit: {:?}", self.0)
    }
}

impl std::error::Error for ParseFitError {}

impl FromStr for Fit {
    type Err = ParseFitError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "fill" => Ok(Fit::Fill),
            "fit" => Ok(Fit::Fit),
            "stretch" => Ok(Fit::Stretch),
            "crop" => Ok(Fit::Crop),
            other => Err(ParseFitError(other.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_round_trip() {
        for s in ["fill", "fit", "stretch", "crop"] {
            let f: Fit = s.parse().expect("every variant's str form must parse");
            assert_eq!(f.to_string(), s);
        }
        assert!("zoom".parse::<Fit>().is_err());
    }

    #[test]
    fn from_json_disambiguates_i64_vs_f64_by_schema() {
        let v = serde_json::json!(9);
        assert_eq!(
            from_json("x", PropType::F64, &v).unwrap(),
            PropValue::F64(9.0)
        );
        assert_eq!(
            from_json("x", PropType::I64, &v).unwrap(),
            PropValue::I64(9)
        );

        let frac = serde_json::json!(9.5);
        assert_eq!(
            from_json("x", PropType::F64, &frac).unwrap(),
            PropValue::F64(9.5)
        );
        assert_eq!(
            from_json("x", PropType::I64, &frac).unwrap_err().code,
            "bad_type"
        );
    }

    #[test]
    fn from_json_enum_rejects_unknown_variant() {
        let v = serde_json::json!("zoom");
        let err = from_json("fit", PropType::Enum(&["fill", "fit"]), &v).unwrap_err();
        assert_eq!(err.code, "bad_type");
        assert!(err.hint.contains("fill|fit"));
    }

    #[test]
    fn to_json_round_trip() {
        assert_eq!(PropValue::Bool(true).to_json(), serde_json::json!(true));
        assert_eq!(PropValue::F64(1.5).to_json(), serde_json::json!(1.5));
        assert_eq!(PropValue::I64(7).to_json(), serde_json::json!(7));
        assert_eq!(
            PropValue::Str("x".to_string()).to_json(),
            serde_json::json!("x")
        );
        assert_eq!(
            PropValue::List(vec![0.0, 1.0]).to_json(),
            serde_json::json!([0.0, 1.0])
        );
    }

    #[test]
    fn schema_for_kind_is_complete_for_every_kind() {
        // Sanity: every NodeKind has at least one property, and lookups agree with the
        // enumerable table (schema_for must never diverge from schema_for_kind).
        for kind in [
            NodeKind::Player,
            NodeKind::Output,
            NodeKind::Layer,
            NodeKind::Source,
            NodeKind::Effect,
        ] {
            let all = schema_for_kind(kind);
            assert!(!all.is_empty(), "{kind:?} has no properties");
            for (name, _) in &all {
                assert!(
                    schema_for(kind, name).is_some(),
                    "{kind:?}.{name} missing from schema_for"
                );
            }
        }
    }
}
