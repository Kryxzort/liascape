//! The bridge between the graph's `Source` nodes and live [`Source`]s (R32): the only
//! place a node turns into a decoder/texture, so the recipes (`crate::recipes`) and the
//! command API only ever talk to the graph.
//!
//! One loop iteration (the runtime's, and `tests/common::Harness::tick`'s):
//! `Animator::tick` → `Graph::set` each value → `Graph::drain_changes` →
//! [`SourceHost::sync`] → [`SourceHost::update`] → [`SourceHost::events`] → recipes →
//! compose. `sync` must run **before** `update` in every iteration: `update` mirrors what
//! the sources report back into the graph, and a command set since the last iteration has
//! to reach its source first or the mirror would overwrite it with the old value.

use std::collections::{BTreeMap, BTreeSet};
use std::os::fd::RawFd;

use serde_json::{Map, Value, json};

use super::{ColorSource, MpvSource, SnapshotSource, Source, SourceEvent};
use crate::anim::PropPath;
use crate::gfx::{Gfx, Tex};
use crate::graph::props::{self, PropValue};
use crate::graph::{Graph, NodeKind};
use crate::log::{self, Level};

/// Observed values mirrored into the graph after every `update` (`Graph::set_observed`).
/// `kind` too: an `MpvSource` infers image/video from the file (and corrects it after
/// load), and recipes decide what is a still by it.
const MIRRORED: [&str; 7] = [
    "kind", "ready", "duration", "time_pos", "width", "height", "paused",
];

struct Hosted {
    src: Box<dyn Source>,
    wake: Option<RawFd>,
}

/// Owns one live [`Source`] per graph `Source` node.
pub struct SourceHost {
    /// Merged into every `MpvSource::open`'s opts (e.g. `{"ao": "null"}` in tests — R26 —
    /// or the player bus `audio_device`, Task 14). Node props win over these.
    base_opts: Map<String, Value>,
    sources: BTreeMap<String, Hosted>,
    /// Nodes whose source failed to open synchronously: not retried until the node goes.
    failed: BTreeSet<String>,
    events: Vec<(String, SourceEvent)>,
    /// Sources whose node is gone, mid two-phase teardown (R51): silent, no longer
    /// hosted (not in `ids`/`texture`/`wake_fds`), dropped by `update` once ready.
    dying: Vec<(String, Hosted, std::time::Instant)>,
    /// Time spent opening sources since the last `take_open_time` (opening is synchronous
    /// — mpv init + render context; the `loop` probe reports it apart).
    open_time: std::time::Duration,
}

impl SourceHost {
    pub fn new(base_opts: Map<String, Value>) -> SourceHost {
        SourceHost {
            base_opts,
            sources: BTreeMap::new(),
            failed: BTreeSet::new(),
            events: Vec::new(),
            dying: Vec::new(),
            open_time: std::time::Duration::ZERO,
        }
    }

    /// Bring the live sources in line with the graph:
    /// 1. drop every source whose node is gone (or is no longer a `Source`);
    /// 2. open a source for every `Source` node not hosted yet, from the node's current
    ///    props (`kind` `color` → [`ColorSource`], `snapshot` → [`SnapshotSource`] of
    ///    `of`'s current texture, anything else → [`MpvSource`]);
    /// 3. forward each change addressed to a hosted source to [`Source::apply`] — except
    ///    to sources opened in step 2, whose props already include them. A refused
    ///    write is logged and queued as [`SourceEvent::Rejected`] (the source is fine,
    ///    R45); a failed open as [`SourceEvent::Error`].
    pub fn sync(&mut self, gfx: &Gfx, graph: &Graph, changes: &[(PropPath, PropValue)]) {
        let gone: Vec<String> = self
            .sources
            .keys()
            .filter(|id| graph.kind_of(id) != Some(NodeKind::Source))
            .cloned()
            .collect();
        for id in gone {
            if let Some(mut h) = self.sources.remove(&id) {
                // What the live source still plays at as it goes (must be silent — the
                // runtime ramps an audible source out before destroying its node).
                let mut gains = crate::units::Gains::new();
                for slot in crate::units::GainSlot::ALL {
                    if let Some(PropValue::F64(db)) = h.src.read(&format!("gain.{}", slot.as_str()))
                    {
                        gains.set(slot, db);
                    }
                }
                log::event(
                    "host",
                    Level::Info,
                    "source.teardown",
                    None,
                    json!({ "id": id, "source_kind": h.src.kind(), "gain_db": gains.effective_db() }),
                );
                if h.src.begin_teardown() {
                    drop(h);
                    log::event(
                        "host",
                        Level::Debug,
                        "source.drop",
                        None,
                        json!({ "id": id }),
                    );
                } else {
                    self.dying.push((id, h, std::time::Instant::now()));
                }
            }
        }
        self.failed
            .retain(|id| graph.kind_of(id) == Some(NodeKind::Source));

        let mut opened = BTreeSet::new();
        for id in graph.ids_of(NodeKind::Source) {
            if self.sources.contains_key(&id) || self.failed.contains(&id) {
                continue;
            }
            let Some(node) = graph.props_of(&id) else {
                continue;
            };
            let t_open = std::time::Instant::now();
            let opened_src = self.open(gfx, &node);
            self.open_time += t_open.elapsed();
            match opened_src {
                Ok(h) => {
                    log::event(
                        "host",
                        Level::Debug,
                        "source.open",
                        None,
                        json!({ "id": id, "source_kind": h.src.kind() }),
                    );
                    self.sources.insert(id.clone(), h);
                    opened.insert(id);
                }
                Err(reason) => {
                    self.error(&id, reason);
                    self.failed.insert(id);
                }
            }
        }

        for (path, v) in changes {
            let Some((id, prop)) = path.0.split_once('.') else {
                continue;
            };
            if opened.contains(id) {
                continue;
            }
            let Some(h) = self.sources.get_mut(id) else {
                continue;
            };
            if let Err(e) = h.src.apply(prop, v) {
                let reason = format!("apply {prop}: {e}");
                log::event(
                    "host",
                    Level::Warn,
                    "source.rejected",
                    None,
                    json!({ "id": id, "prop": prop, "reason": reason }),
                );
                self.events.push((
                    id.to_string(),
                    SourceEvent::Rejected {
                        prop: prop.to_string(),
                        reason,
                    },
                ));
            }
        }
    }

    fn open(&self, gfx: &Gfx, node: &[(String, PropValue)]) -> Result<Hosted, String> {
        let get = |k: &str| node.iter().find(|(n, _)| n == k).map(|(_, v)| v);
        let s = |k: &str| match get(k) {
            Some(PropValue::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let kind = s("kind");
        // Writable props (and set gain slots) a source is opened with / receives.
        let writable: Vec<&(String, PropValue)> = node
            .iter()
            .filter(|(k, _)| {
                k.starts_with("gain.")
                    || props::schema_for(NodeKind::Source, k).is_some_and(|d| !d.readonly)
            })
            .collect();
        let mut src: Box<dyn Source> = match kind.as_str() {
            "color" => {
                let rgb = match get("color") {
                    Some(PropValue::List(c)) if c.len() == 3 => {
                        [c[0], c[1], c[2]].map(|x| x.round().clamp(0.0, 255.0) as u8)
                    }
                    _ => [0, 0, 0],
                };
                Box::new(ColorSource::new(rgb))
            }
            "snapshot" => {
                let of = s("of");
                let from = self.sources.get(&of).and_then(|h| h.src.texture());
                Box::new(SnapshotSource::new(gfx, &of, from))
            }
            _ => {
                let mut opts = self.base_opts.clone();
                for (k, v) in &writable {
                    if !matches!(k.as_str(), "kind" | "path" | "color") {
                        opts.insert(k.clone(), v.to_json());
                    }
                }
                // `video` is the schema default, so only an explicit `image` is passed on;
                // MpvSource infers from the extension and corrects itself after load.
                if kind == "image" {
                    opts.insert("kind".into(), json!("image"));
                }
                let m = MpvSource::open(gfx, &s("path"), &opts).map_err(|e| e.to_string())?;
                let wake = Some(m.wake_fd());
                return Ok(Hosted {
                    src: Box::new(m),
                    wake,
                });
            }
        };
        // Colour/snapshot: store every writable prop so `read` (and the mirror) agrees with
        // the node from the start (e.g. `paused`).
        for (k, v) in &writable {
            if !matches!(k.as_str(), "kind" | "color") {
                let _ = src.apply(k, v);
            }
        }
        Ok(Hosted { src, wake: None })
    }

    fn error(&mut self, id: &str, reason: String) {
        log::event(
            "host",
            Level::Warn,
            "source.error",
            None,
            json!({ "id": id, "reason": reason }),
        );
        self.events
            .push((id.to_string(), SourceEvent::Error { reason }));
    }

    /// Update every source (render a pending frame — never blocks), collect its events,
    /// then mirror its observed values (`ready`, `duration`, `time_pos`, `width`, `height`,
    /// `paused` as the source reports it) into the graph via `Graph::set_observed` — never
    /// a change, so nothing loops back. An unknown value (`None`) leaves the graph as is.
    pub fn update(&mut self, gfx: &Gfx, graph: &mut Graph) {
        self.reap_dying(false);
        let mut new_events = Vec::new();
        for (id, h) in &mut self.sources {
            h.src.update(gfx);
            for ev in h.src.poll_events() {
                match &ev {
                    SourceEvent::Error { reason } => log::event(
                        "host",
                        Level::Warn,
                        "source.error",
                        None,
                        json!({ "id": id, "reason": reason }),
                    ),
                    SourceEvent::Rejected { prop, reason } => log::event(
                        "host",
                        Level::Warn,
                        "source.rejected",
                        None,
                        json!({ "id": id, "prop": prop, "reason": reason }),
                    ),
                    _ => {}
                }
                new_events.push((id.clone(), ev));
            }
            for prop in MIRRORED {
                if let Some(v) = h.src.read(prop) {
                    let _ = graph.set_observed(&PropPath(format!("{id}.{prop}")), v);
                }
            }
        }
        self.events.extend(new_events);
    }

    /// Drop every dying source whose teardown is ready (all of them with `force`).
    fn reap_dying(&mut self, force: bool) {
        let mut i = 0;
        while i < self.dying.len() {
            if force || self.dying[i].1.src.teardown_ready() {
                let (id, h, at) = self.dying.remove(i);
                drop(h);
                log::event(
                    "host",
                    Level::Debug,
                    "source.drop",
                    None,
                    json!({ "id": id, "teardown_ms": at.elapsed().as_secs_f64() * 1000.0 }),
                );
            } else {
                i += 1;
            }
        }
    }

    /// Time spent in synchronous source opens since the last call (loop accounting).
    pub fn take_open_time(&mut self) -> std::time::Duration {
        std::mem::take(&mut self.open_time)
    }

    /// Sources still mid-teardown (probes).
    pub fn dying(&self) -> usize {
        self.dying.len()
    }

    /// Finish every pending teardown: poll for up to `max`, then drop the rest anyway
    /// (shutdown).
    pub fn finish_teardown(&mut self, max: std::time::Duration) {
        let t = std::time::Instant::now();
        while !self.dying.is_empty() && t.elapsed() < max {
            self.reap_dying(false);
            if !self.dying.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        self.reap_dying(true);
    }

    /// Drain every event since the last call, as `(source node id, event)`, in order.
    pub fn events(&mut self) -> Vec<(String, SourceEvent)> {
        std::mem::take(&mut self.events)
    }

    /// The live texture of source node `id` (the compositor's `textures` closure).
    pub fn texture(&self, id: &str) -> Option<&Tex> {
        self.sources.get(id).and_then(|h| h.src.texture())
    }

    /// The live source for node `id` (probes/tests).
    pub fn get(&self, id: &str) -> Option<&dyn Source> {
        self.sources.get(id).map(|h| h.src.as_ref())
    }

    /// The live libmpv source for node `id`, if it is one (probes, stepped mode).
    pub fn mpv(&self, id: &str) -> Option<&MpvSource> {
        self.sources.get(id).and_then(|h| h.src.as_mpv())
    }

    pub fn mpv_mut(&mut self, id: &str) -> Option<&mut MpvSource> {
        self.sources.get_mut(id).and_then(|h| h.src.as_mpv_mut())
    }

    /// Whether node `id`'s source failed to open (not retried until the node goes).
    pub fn open_failed(&self, id: &str) -> bool {
        self.failed.contains(id)
    }

    /// `(node id, wake fd)` of every hosted source that has one — the runtime registers
    /// these with its event loop (by dup, so a source closing its fd never leaves a stale
    /// registration behind).
    pub fn wake_fds_by_id(&self) -> Vec<(String, RawFd)> {
        self.sources
            .iter()
            .filter_map(|(id, h)| h.wake.map(|fd| (id.clone(), fd)))
            .collect()
    }

    /// Ids of every hosted source.
    pub fn ids(&self) -> Vec<String> {
        self.sources.keys().cloned().collect()
    }

    /// Every hosted source's wakeup fd (the runtime polls these; readable → run an
    /// iteration). Colour/snapshot sources have none.
    pub fn wake_fds(&self) -> Vec<RawFd> {
        self.sources.values().filter_map(|h| h.wake).collect()
    }
}
