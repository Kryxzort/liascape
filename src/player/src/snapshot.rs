//! The persisted state snapshot (spec §4.1 "Supervision"; Task 16, R74): what the player
//! shows, written to `<state>/snapshot.json` so a restarted player (`serve --restore`, the
//! supervisor's respawn after a crash) comes back with the same wallpaper at the same place.
//!
//! **Content.** `version` ([`VERSION`]), `saved_unix_ms`; `player` — the Player node's
//! settable props (`debug`); `outputs` — per present connector: its main layer's `content`
//! (a source id from `sources`, or `null`), its settable output props (`layer`, `paused`)
//! and its main layer's settings (`fit`, `viewport`, `opacity`); `output_props` — the
//! remembered props of connectors that are not present (an unplugged monitor keeps its
//! `layer`); `sources` — per referenced source: `kind`, `path`, `position`, `paused`,
//! `speed`, `loop`, `gains` (every set slot except the transient `xfade`/`anticlick`) and
//! every other settable per-source prop (`color`, `hwdec`, `no_audio`, …); `parked` — the
//! R60 parked wallpaper (`{id, resume_paused, connector}`), if any.
//!
//! **Excluded:** transient nodes — effects, `snapshot`-kind sources, graves, held A's,
//! every in-flight transition's scaffolding. **A transition in flight is saved as its
//! target B** on the outputs it covers: B's own props, playing (`paused: false` — the
//! recipe holds B paused only until it starts), `xfade`/`anticlick` left out (0 dB), and
//! its position (= its requested start until it has started playing). A numeric prop that
//! is animating is saved at the animation's **target** (R41) — never mid-ramp; once the
//! animation is over, the prop's own value (a `set` after it must win —
//! `Animator::live_target_of`).
//!
//! **Positions** are what the source reports (`time_pos`, once ready; before that the
//! requested `position`). `--restore` seeks to the saved position exactly — no
//! elapsed-since-save compensation: the snapshot is refreshed every [`REFRESH`] while a
//! video plays, so a restart resumes ≤ 2 s (plus the restart) behind, never ahead.
//!
//! **Writing** (`Writer`): atomic — `snapshot.json.tmp` written + `fsync`ed, renamed over
//! `snapshot.json`, the directory `fsync`ed — on a writer thread (`lp-snapshot`), so an
//! `fsync` never stalls the render loop. When to write is the runtime's call (§ Snapshot in
//! `.claude/rules/player-core.md`): [`DEBOUNCE`] after the first unsaved graph change,
//! every [`REFRESH`] while a video plays, and once more on a clean exit.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::anim::{Animator, PropPath};
use crate::graph::props::schema_for_kind;
use crate::graph::{Graph, NodeKind, PropType, PropValue};
use crate::log::{self, Level};
use crate::recipes::TransitionStatus;

/// The snapshot format this player writes and reads; any other `version` is invalid.
pub const VERSION: u32 = 1;
/// The snapshot file in the state dir.
pub const FILE: &str = "snapshot.json";
/// Where an invalid snapshot is moved for inspection (the next write replaces `FILE`).
pub const INVALID_FILE: &str = "snapshot.invalid.json";
const TMP_FILE: &str = "snapshot.json.tmp";
/// A change is saved this long after the first unsaved change (a burst = one write).
pub const DEBOUNCE: Duration = Duration::from_millis(250);
/// While a video plays, the snapshot is refreshed this often (positions move without a
/// graph change).
pub const REFRESH: Duration = Duration::from_secs(2);

/// Gain slots that are recipe/anti-click scaffolding, restored at 0 dB.
const TRANSIENT_GAINS: [&str; 2] = ["xfade", "anticlick"];
/// Source props stored as `SourceSnap` fields (not in its `props`).
const SOURCE_FIELDS: [&str; 6] = ["kind", "path", "paused", "speed", "loop", "position"];

/// The whole snapshot (module doc).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    #[serde(default)]
    pub saved_unix_ms: u64,
    #[serde(default)]
    pub player: Map<String, Value>,
    /// Present connector → what it shows.
    #[serde(default)]
    pub outputs: BTreeMap<String, OutputSnap>,
    /// Connectors not present → their remembered output props.
    #[serde(default)]
    pub output_props: BTreeMap<String, Map<String, Value>>,
    /// Saved source id → the source (ids are only references inside this file; a restore
    /// mints fresh ids).
    #[serde(default)]
    pub sources: BTreeMap<String, SourceSnap>,
    #[serde(default)]
    pub parked: Option<ParkedSnap>,
}

/// One present output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputSnap {
    /// A key of [`Snapshot::sources`], or `None` (the output showed nothing).
    pub content: Option<String>,
    /// Settable output props (`layer`, `paused`) that differ from their defaults.
    #[serde(default)]
    pub props: Map<String, Value>,
    /// The main layer's settings (`fit`, `viewport`, `opacity`).
    #[serde(default)]
    pub layer: Map<String, Value>,
}

/// One source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceSnap {
    pub kind: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub paused: bool,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(rename = "loop", default)]
    pub looped: bool,
    /// Set gain slots in dB, `xfade`/`anticlick` excluded.
    #[serde(default)]
    pub gains: BTreeMap<String, f64>,
    /// Every other settable per-source prop.
    #[serde(default)]
    pub props: Map<String, Value>,
    /// It was a playing video when saved (diagnostic).
    #[serde(default)]
    pub playing: bool,
    /// It was the target B of an in-flight transition (saved as if the transition had
    /// completed).
    #[serde(default)]
    pub transition_target: bool,
}

fn one() -> f64 {
    1.0
}

/// The R60 parked wallpaper.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParkedSnap {
    /// A key of [`Snapshot::sources`].
    pub id: String,
    /// Whether it stays paused when shown again.
    pub resume_paused: bool,
    /// The connector it was parked for (shown when that connector appears), if any.
    #[serde(default)]
    pub connector: Option<String>,
}

impl SourceSnap {
    /// The `create` props that recreate this source (`position` = the saved position).
    pub fn create_props(&self) -> Map<String, Value> {
        let mut m = self.props.clone();
        m.insert("kind".into(), json!(self.kind));
        if !self.path.is_empty() {
            m.insert("path".into(), json!(self.path));
        }
        m.insert("position".into(), json!(self.position));
        m.insert("paused".into(), json!(self.paused));
        m.insert("speed".into(), json!(self.speed));
        m.insert("loop".into(), json!(self.looped));
        for (slot, db) in &self.gains {
            m.insert(format!("gain.{slot}"), json!(db));
        }
        m
    }
}

/// What [`capture`] reads.
pub struct Capture<'a> {
    pub graph: &'a Graph,
    pub anim: &'a Animator,
    pub transitions: &'a [TransitionStatus],
    /// The parked wallpaper (its live id) — `resume_paused` is what it's saved with.
    pub parked: Option<ParkedSnap>,
    /// Remembered props of connectors that are not present.
    pub remembered: &'a BTreeMap<String, Map<String, Value>>,
}

fn get_str(g: &Graph, id: &str, prop: &str) -> String {
    match g.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::Str(s)) => s,
        _ => String::new(),
    }
}

fn get_bool(g: &Graph, id: &str, prop: &str) -> bool {
    matches!(
        g.get(&PropPath(format!("{id}.{prop}"))),
        Ok(PropValue::Bool(true))
    )
}

fn get_f64(g: &Graph, id: &str, prop: &str) -> Option<f64> {
    match g.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::F64(f)) => Some(f),
        Ok(PropValue::I64(i)) => Some(i as f64),
        _ => None,
    }
}

/// `id`'s settable props of `kind` (minus `skip`), numbers at their animation target.
/// `non_default`: only those that differ from the schema default.
fn persistent(
    g: &Graph,
    anim: &Animator,
    id: &str,
    kind: NodeKind,
    skip: &[&str],
    non_default: bool,
) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, pd) in schema_for_kind(kind) {
        if pd.readonly || skip.contains(&name) {
            continue;
        }
        let path = PropPath(format!("{id}.{name}"));
        let Ok(mut v) = g.get(&path) else {
            continue;
        };
        if matches!(pd.ty, PropType::F64)
            && let Some(t) = anim.live_target_of(&path)
        {
            v = PropValue::F64(t);
        }
        if non_default && v == pd.default {
            continue;
        }
        out.insert(name.to_string(), v.to_json());
    }
    out
}

/// What output `out_id` (`out:<c>`) shows, as a source to save: an in-flight transition's
/// B (then `true`), else its main layer's source, or the `to` side of an effect there.
fn content_of(g: &Graph, out_id: &str, trs: &[TransitionStatus]) -> Option<(String, bool)> {
    if let Some(t) = trs.iter().find(|t| t.outputs.iter().any(|o| o == out_id))
        && g.kind_of(&t.to) == Some(NodeKind::Source)
    {
        return Some((t.to.clone(), true));
    }
    let c = out_id.strip_prefix("out:").unwrap_or(out_id);
    let mut content = get_str(g, &format!("lay:{c}:main"), "content");
    if g.kind_of(&content) == Some(NodeKind::Effect) {
        content = get_str(g, &content, "to");
    }
    (g.kind_of(&content) == Some(NodeKind::Source) && get_str(g, &content, "kind") != "snapshot")
        .then_some((content, false))
}

fn source_snap(g: &Graph, anim: &Animator, id: &str, target_b: bool) -> SourceSnap {
    let kind = get_str(g, id, "kind");
    let ready = get_bool(g, id, "ready");
    let paused = get_bool(g, id, "paused");
    let position = if ready && kind == "video" {
        get_f64(g, id, "time_pos").unwrap_or(0.0)
    } else {
        get_f64(g, id, "position").unwrap_or(0.0)
    };
    let speed_path = PropPath(format!("{id}.speed"));
    let speed = anim
        .live_target_of(&speed_path)
        .or_else(|| get_f64(g, id, "speed"))
        .unwrap_or(1.0);
    let mut gains = BTreeMap::new();
    for (name, v) in g.props_of(id).unwrap_or_default() {
        let Some(slot) = name.strip_prefix("gain.") else {
            continue;
        };
        if TRANSIENT_GAINS.contains(&slot) {
            continue;
        }
        let db = anim
            .live_target_of(&PropPath(format!("{id}.{name}")))
            .or(match v {
                PropValue::F64(f) => Some(f),
                _ => None,
            });
        if let Some(db) = db {
            gains.insert(slot.to_string(), db);
        }
    }
    SourceSnap {
        playing: kind == "video" && ready && !paused,
        path: get_str(g, id, "path"),
        position: if position.is_finite() {
            position.max(0.0)
        } else {
            0.0
        },
        paused: !target_b && paused,
        speed,
        looped: get_bool(g, id, "loop"),
        gains,
        props: persistent(g, anim, id, NodeKind::Source, &SOURCE_FIELDS, false),
        transition_target: target_b,
        kind,
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The snapshot of the graph now (module doc for what's in and out).
pub fn capture(c: &Capture) -> Snapshot {
    let g = c.graph;
    let mut snap = Snapshot {
        version: VERSION,
        saved_unix_ms: unix_ms(),
        player: persistent(g, c.anim, "player", NodeKind::Player, &[], false),
        outputs: BTreeMap::new(),
        output_props: c.remembered.clone(),
        sources: BTreeMap::new(),
        parked: None,
    };
    // id → saved as a transition target
    let mut wanted: BTreeMap<String, bool> = BTreeMap::new();
    for out in g.ids_of(NodeKind::Output) {
        let conn = out.strip_prefix("out:").unwrap_or(&out).to_string();
        let content = content_of(g, &out, c.transitions);
        if let Some((id, b)) = &content {
            let e = wanted.entry(id.clone()).or_insert(false);
            *e |= *b;
        }
        snap.output_props.remove(&conn);
        snap.outputs.insert(
            conn.clone(),
            OutputSnap {
                content: content.map(|(id, _)| id),
                props: persistent(g, c.anim, &out, NodeKind::Output, &[], true),
                layer: persistent(
                    g,
                    c.anim,
                    &format!("lay:{conn}:main"),
                    NodeKind::Layer,
                    &["output", "content"],
                    false,
                ),
            },
        );
    }
    let parked = c
        .parked
        .clone()
        .filter(|pk| g.kind_of(&pk.id) == Some(NodeKind::Source));
    if let Some(pk) = &parked {
        wanted.entry(pk.id.clone()).or_insert(false);
    }
    for (id, b) in wanted {
        let mut s = source_snap(g, c.anim, &id, b);
        if let Some(pk) = parked.as_ref().filter(|pk| pk.id == id) {
            s.paused = pk.resume_paused;
            s.playing = false;
        }
        snap.sources.insert(id, s);
    }
    snap.parked = parked;
    snap
}

impl Snapshot {
    /// Whether a video was playing when it was taken (the periodic refresh runs then).
    pub fn any_playing(&self) -> bool {
        self.sources.values().any(|s| s.playing)
    }

    /// Every source id an output or the parked slot refers to.
    pub fn referenced(&self) -> BTreeSet<String> {
        self.outputs
            .values()
            .filter_map(|o| o.content.clone())
            .chain(self.parked.as_ref().map(|p| p.id.clone()))
            .collect()
    }

    /// The pretty JSON written to disk.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = serde_json::to_vec_pretty(self).unwrap_or_default();
        b.push(b'\n');
        b
    }

    /// Parse a snapshot file's bytes: valid JSON, `version` == [`VERSION`], every
    /// reference resolvable — else why not.
    pub fn parse(bytes: &[u8]) -> Result<Snapshot, String> {
        let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("not JSON: {e}"))?;
        match v.get("version").and_then(Value::as_u64) {
            Some(n) if n == VERSION as u64 => {}
            Some(n) => {
                return Err(format!(
                    "unknown version {n} (this player reads version {VERSION})"
                ));
            }
            None => return Err("no numeric `version` field".into()),
        }
        let s: Snapshot =
            serde_json::from_value(v).map_err(|e| format!("bad snapshot shape: {e}"))?;
        if let Some(r) = s.referenced().iter().find(|r| !s.sources.contains_key(*r)) {
            return Err(format!("refers to source {r:?}, which isn't in `sources`"));
        }
        Ok(s)
    }
}

/// Read `<dir>/snapshot.json`: `Ok(None)` when there is none, `Err(reason)` when it can't
/// be used (unreadable, corrupt, unknown version).
pub fn load(dir: &Path) -> Result<Option<Snapshot>, String> {
    let path = dir.join(FILE);
    match fs::read(&path) {
        Ok(b) => Snapshot::parse(&b).map(Some),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("can't read {}: {e}", path.display())),
    }
}

/// Move an unusable snapshot aside (`snapshot.invalid.json`) for inspection.
pub fn set_aside(dir: &Path) -> Option<PathBuf> {
    let to = dir.join(INVALID_FILE);
    fs::rename(dir.join(FILE), &to).ok().map(|()| to)
}

/// Atomic write: tmp file + `fsync`, rename over [`FILE`], `fsync` the directory.
pub fn write_atomic(dir: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(TMP_FILE);
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, dir.join(FILE))?;
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Counters the writer thread keeps (the `snapshot` probe).
#[derive(Debug, Default)]
pub struct WriterStats {
    pub writes: AtomicU64,
    pub failures: AtomicU64,
    /// Duration of the last successful write, µs.
    pub last_write_us: AtomicU64,
}

/// The snapshot writer thread: the latest snapshot sent wins (older pending ones are
/// skipped), each written atomically.
pub struct Writer {
    tx: Option<mpsc::Sender<Vec<u8>>>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub dir: PathBuf,
    pub stats: Arc<WriterStats>,
}

impl Writer {
    pub fn start(dir: &Path) -> Writer {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let stats = Arc::new(WriterStats::default());
        let (d, st) = (dir.to_path_buf(), stats.clone());
        let thread = std::thread::Builder::new()
            .name("lp-snapshot".into())
            .spawn(move || writer_loop(rx, &d, &st))
            .map_err(|e| {
                log::event(
                    "snapshot",
                    Level::Error,
                    "snapshot.write_failed",
                    None,
                    json!({ "error": format!("no writer thread: {e}") }),
                )
            })
            .ok();
        Writer {
            tx: thread.is_some().then_some(tx),
            thread,
            dir: dir.to_path_buf(),
            stats,
        }
    }

    /// Queue `bytes` for writing (replacing anything not written yet).
    pub fn send(&self, bytes: Vec<u8>) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(bytes);
        }
    }

    /// Write whatever is queued and stop the thread (clean exit).
    pub fn finish(&mut self) {
        self.tx = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.finish();
    }
}

fn writer_loop(rx: mpsc::Receiver<Vec<u8>>, dir: &Path, st: &WriterStats) {
    let mut failing = false;
    while let Ok(mut bytes) = rx.recv() {
        while let Ok(newer) = rx.try_recv() {
            bytes = newer;
        }
        let t = Instant::now();
        match write_atomic(dir, &bytes) {
            Ok(()) => {
                st.writes.fetch_add(1, Ordering::Relaxed);
                let us = t.elapsed().as_micros() as u64;
                st.last_write_us.store(us, Ordering::Relaxed);
                if failing {
                    failing = false;
                    log::event(
                        "snapshot",
                        Level::Info,
                        "snapshot.write_recovered",
                        None,
                        json!({ "failures": st.failures.load(Ordering::Relaxed) }),
                    );
                }
                log::event(
                    "snapshot",
                    Level::Debug,
                    "snapshot.saved",
                    None,
                    json!({ "bytes": bytes.len(), "write_ms": us as f64 / 1000.0 }),
                );
            }
            Err(e) => {
                st.failures.fetch_add(1, Ordering::Relaxed);
                if !failing {
                    failing = true;
                    log::event(
                        "snapshot",
                        Level::Warn,
                        "snapshot.write_failed",
                        None,
                        json!({ "dir": dir.display().to_string(), "error": e.to_string(),
                                "hint": "the state dir must be writable (XDG_STATE_HOME); \
                                         a restart can only restore the last good snapshot" }),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anim::{AnimUnit, Animation, Curve};
    use crate::recipes::{Method, Phase};

    fn p(s: &str) -> PropPath {
        PropPath(s.to_string())
    }

    fn src(g: &mut Graph, id: &str, props: Value) -> String {
        let Value::Object(m) = props else { panic!() };
        g.create(NodeKind::Source, Some(id.into()), m).unwrap()
    }

    /// DP-1 shows `a` (a playing video at 3.5 s), DP-2 shows `b` (a colour).
    fn graph() -> Graph {
        let mut g = Graph::new();
        for o in ["out:DP-1", "out:DP-2"] {
            g.create(NodeKind::Output, Some(o.into()), Map::new())
                .unwrap();
        }
        src(
            &mut g,
            "a",
            json!({"path": "/w/a.mp4", "loop": true, "speed": 1.5, "gain.user": -6.0,
                   "gain.xfade": -96.0, "hwdec": "vaapi"}),
        );
        src(&mut g, "b", json!({"kind": "color", "color": [0, 0, 255]}));
        g.set_observed(&p("a.ready"), PropValue::Bool(true))
            .unwrap();
        g.set_observed(&p("a.time_pos"), PropValue::F64(3.5))
            .unwrap();
        g.set(&p("lay:DP-1:main.content"), PropValue::Str("a".into()))
            .unwrap();
        g.set(&p("lay:DP-2:main.content"), PropValue::Str("b".into()))
            .unwrap();
        g
    }

    fn cap(g: &Graph, anim: &Animator, trs: &[TransitionStatus]) -> Snapshot {
        capture(&Capture {
            graph: g,
            anim,
            transitions: trs,
            parked: None,
            remembered: &BTreeMap::new(),
        })
    }

    #[test]
    fn captures_outputs_sources_and_props() {
        let mut g = graph();
        g.set(&p("out:DP-2.layer"), PropValue::Str("overlay".into()))
            .unwrap();
        g.set(&p("lay:DP-1:main.fit"), PropValue::Str("crop".into()))
            .unwrap();
        g.set(&p("player.debug"), PropValue::Bool(true)).unwrap();
        let s = cap(&g, &Animator::new(), &[]);
        assert_eq!(s.version, VERSION);
        assert_eq!(s.player["debug"], json!(true));
        assert_eq!(s.outputs["DP-1"].content.as_deref(), Some("a"));
        assert_eq!(s.outputs["DP-2"].content.as_deref(), Some("b"));
        assert_eq!(s.outputs["DP-2"].props["layer"], json!("overlay"));
        assert!(s.outputs["DP-1"].props.is_empty(), "defaults left out");
        assert_eq!(s.outputs["DP-1"].layer["fit"], json!("crop"));
        let a = &s.sources["a"];
        assert_eq!((a.kind.as_str(), a.path.as_str()), ("video", "/w/a.mp4"));
        assert_eq!(a.position, 3.5, "time_pos once ready");
        assert!(a.looped && !a.paused && a.playing);
        assert_eq!(a.speed, 1.5);
        assert_eq!(a.gains.get("user"), Some(&-6.0));
        assert!(!a.gains.contains_key("xfade"), "transient slot left out");
        assert_eq!(a.props["hwdec"], json!("vaapi"));
        assert!(!a.props.contains_key("time_pos") && !a.props.contains_key("ready"));
        assert_eq!(s.sources["b"].props["color"], json!([0.0, 0.0, 255.0]));
        assert!(s.any_playing());
        // Round trip through the file format.
        let back = Snapshot::parse(&s.to_bytes()).unwrap();
        assert_eq!(back, s);
        // The create props recreate the source.
        let cp = a.create_props();
        assert_eq!(cp["position"], json!(3.5));
        assert_eq!(cp["gain.user"], json!(-6.0));
        let mut g2 = Graph::new();
        g2.create(NodeKind::Source, None, cp).unwrap();
    }

    #[test]
    fn effects_snapshots_and_unshown_sources_are_excluded() {
        let mut g = graph();
        src(&mut g, "hidden", json!({"path": "/w/h.mp4"}));
        src(&mut g, "snap", json!({"kind": "snapshot"}));
        let mut fx = Map::new();
        fx.insert("effect_id".into(), json!("fade"));
        fx.insert("from".into(), json!("snap"));
        fx.insert("to".into(), json!("b"));
        g.create(NodeKind::Effect, Some("fx1".into()), fx).unwrap();
        g.set(&p("lay:DP-1:main.content"), PropValue::Str("fx1".into()))
            .unwrap();
        let s = cap(&g, &Animator::new(), &[]);
        assert_eq!(
            s.outputs["DP-1"].content.as_deref(),
            Some("b"),
            "an effect is saved as its `to` side"
        );
        let ids: Vec<&str> = s.sources.keys().map(String::as_str).collect();
        assert_eq!(ids, ["b"], "no effect, snapshot or unshown source");
    }

    #[test]
    fn in_flight_transition_is_saved_as_b() {
        let mut g = graph();
        // Pre-running B: created paused, xfade −96, its start at 1.25 s.
        src(
            &mut g,
            "bnew",
            json!({"path": "/w/b.mp4", "paused": true, "position": 1.25,
                   "gain.xfade": -96.0, "gain.anticlick": -96.0}),
        );
        let tr = TransitionStatus {
            corr: log::CorrId("tr-1".into()),
            phase: Phase::WaitingReady,
            method: Method::FullLive,
            outputs: vec!["out:DP-1".into()],
            to: "bnew".into(),
            from: vec!["a".into()],
            held: vec!["bnew".into()],
        };
        let s = cap(&g, &Animator::new(), &[tr]);
        assert_eq!(s.outputs["DP-1"].content.as_deref(), Some("bnew"));
        assert_eq!(s.outputs["DP-2"].content.as_deref(), Some("b"));
        let b = &s.sources["bnew"];
        assert!(b.transition_target);
        assert!(!b.paused, "B plays once the transition is over");
        assert_eq!(b.position, 1.25, "not started: its requested start");
        assert!(b.gains.is_empty(), "xfade/anticlick restored at 0 dB");
        assert!(
            !s.sources.contains_key("a"),
            "A (only on DP-1) is gone with it"
        );
    }

    #[test]
    fn animated_values_are_saved_at_their_target() {
        let g = graph();
        let mut anim = Animator::new();
        anim.add(Animation {
            target: p("a.gain.user"),
            from: 1.0,
            to: crate::units::db_to_lin(-20.0),
            start: Duration::ZERO,
            duration: Duration::from_secs(10),
            curve: Curve::Linear,
            unit: AnimUnit::GainLinear,
            corr: None,
        });
        anim.add(Animation {
            target: p("lay:DP-1:main.opacity"),
            from: 1.0,
            to: 0.25,
            start: Duration::ZERO,
            duration: Duration::from_secs(10),
            curve: Curve::Linear,
            unit: AnimUnit::Scalar,
            corr: None,
        });
        let s = cap(&g, &anim, &[]);
        assert!((s.sources["a"].gains["user"] + 20.0).abs() < 1e-6);
        assert_eq!(s.outputs["DP-1"].layer["opacity"], json!(0.25));
        // Finished, then set directly: the set value wins (outputs.sh found 0.97 restored
        // after `animate` to 0.97 + `set` 1).
        let mut g = g;
        anim.tick(Duration::from_secs(11));
        g.set(&p("lay:DP-1:main.opacity"), PropValue::F64(1.0))
            .unwrap();
        let s = cap(&g, &anim, &[]);
        assert_eq!(s.outputs["DP-1"].layer["opacity"], json!(1.0));
    }

    #[test]
    fn parked_and_remembered_outputs() {
        let mut g = Graph::new();
        src(&mut g, "pk", json!({"path": "/w/p.mp4", "paused": true}));
        let mut remembered = BTreeMap::new();
        let mut props = Map::new();
        props.insert("layer".into(), json!("top"));
        remembered.insert("DP-1".to_string(), props);
        let s = capture(&Capture {
            graph: &g,
            anim: &Animator::new(),
            transitions: &[],
            parked: Some(ParkedSnap {
                id: "pk".into(),
                resume_paused: false,
                connector: Some("DP-1".into()),
            }),
            remembered: &remembered,
        });
        assert!(s.outputs.is_empty());
        assert_eq!(s.output_props["DP-1"]["layer"], json!("top"));
        let pk = s.parked.clone().unwrap();
        assert_eq!(pk.connector.as_deref(), Some("DP-1"));
        assert!(!s.sources["pk"].paused, "saved with its resume state");
        assert_eq!(Snapshot::parse(&s.to_bytes()).unwrap(), s);
    }

    #[test]
    fn invalid_files_are_rejected_with_a_reason() {
        let e = Snapshot::parse(b"{not json").unwrap_err();
        assert!(e.contains("not JSON"), "{e}");
        let e = Snapshot::parse(br#"{"version": 99}"#).unwrap_err();
        assert!(e.contains("unknown version 99"), "{e}");
        let e = Snapshot::parse(br#"{"sources": {}}"#).unwrap_err();
        assert!(e.contains("version"), "{e}");
        let e = Snapshot::parse(br#"{"version": 1, "outputs": {"DP-1": {"content": "ghost"}}}"#)
            .unwrap_err();
        assert!(e.contains("ghost"), "{e}");
        let e = Snapshot::parse(br#"{"version": 1, "sources": {"a": {"kind": 3}}}"#).unwrap_err();
        assert!(e.contains("bad snapshot shape"), "{e}");
        assert!(
            Snapshot::parse(br#"{"version": 1}"#).is_ok(),
            "empty is valid"
        );
    }

    #[test]
    fn atomic_write_load_and_set_aside() {
        let dir = std::env::temp_dir().join(format!("lp-snap-unit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(load(&dir).unwrap(), None, "no file: nothing to restore");
        let s = cap(&graph(), &Animator::new(), &[]);
        let mut w = Writer::start(&dir);
        w.send(b"stale".to_vec());
        w.send(s.to_bytes());
        w.finish();
        assert_eq!(load(&dir).unwrap(), Some(s));
        assert!(!dir.join(TMP_FILE).exists(), "tmp renamed into place");
        fs::write(dir.join(FILE), b"garbage").unwrap();
        assert!(load(&dir).is_err());
        assert_eq!(set_aside(&dir), Some(dir.join(INVALID_FILE)));
        assert_eq!(load(&dir).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
