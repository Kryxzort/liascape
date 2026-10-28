//! The Task 11 loop harness (R4 + R32 + R33): Graph + Animator + SteppedClock + Gfx +
//! `SourceHost` + `Transitions` + Composer. One [`Harness::tick`] is the runtime's loop
//! iteration: `anim.tick` → `graph.set` each → `drain_changes` → `host.sync` →
//! `host.update` → `transitions.tick(host.events())` → compose every virtual output
//! (`VIRTUAL-n`, 640×360) into its own FBO.
//!
//! **Clock pacing (R33).** mpv plays in wall time, so each tick waits ≤ one 30 fps frame
//! on the sources' wake fds and steps the `SteppedClock` by the measured wall delta.
//! [`Harness::tick_to`] lands exactly on a virtual instant (a capped step; the remainder
//! is carried into the next tick, so the clock never drifts from wall time).
//!
//! **One harness at a time.** Every `Harness` holds a process-wide lock for its whole
//! life: these tests are coupled to wall-clock playback, and a dozen of them decoding
//! 1080p in parallel starve each other's mpv cores (measured: frames dropped, a paused
//! source's redraw landing > 60 ms late) — load this player never sees.
#![allow(dead_code)]

use std::sync::{Mutex, MutexGuard};

use std::os::fd::RawFd;
use std::time::{Duration, Instant};

use liascape_player::anim::{Animator, PropPath};
use liascape_player::clock::{Clock, SteppedClock};
use liascape_player::gfx::{Catalogue, Composer, Fbo, Gfx, Tex};
use liascape_player::graph::{Graph, NodeKind, PropValue};
use liascape_player::log::CorrId;
use liascape_player::recipes::{TransitionEvent, TransitionEventKind, TransitionReq, Transitions};
use liascape_player::sources::{RenderWorker, SourceEvent, SourceHost};
use serde_json::{Map, Value, json};

use super::{headless_gl, read_rgba};

pub const OUT_W: u32 = 640;
pub const OUT_H: u32 = 360;
/// One 30 fps frame (the test clips' rate).
pub const FRAME: Duration = Duration::from_micros(33_333);
/// The longest a tick waits for a wake fd: one 60 Hz refresh (≤ one 30 fps frame, R33).
/// Pumping at exactly the clips' 30 fps aliases with mpv's frame timing and drops frames;
/// a real output refreshes at ≥ 60 Hz.
pub const TICK_WAIT: Duration = Duration::from_micros(16_667);
/// The shortest gap between ticks. Without it a gain ramp turns into a tick storm: every
/// gain push gets an mpv reply, the reply wakes the fd, the next tick pushes again
/// (measured: ~650 ticks in 30 ms).
pub const MIN_TICK: Duration = Duration::from_millis(2);

pub struct Harness {
    pub gfx: Gfx,
    pub cat: Catalogue,
    pub composer: Composer,
    pub graph: Graph,
    pub anim: Animator,
    pub clock: SteppedClock,
    pub host: SourceHost,
    pub tr: Transitions,
    /// `(out:<name>, target texture, its FBO)`.
    pub outputs: Vec<(String, Tex, Fbo)>,
    /// Every source event, with the tick time it was seen at.
    pub src_events: Vec<(Duration, String, SourceEvent)>,
    pub tr_events: Vec<TransitionEvent>,
    pub ticks: u64,
    last_wall: Instant,
    debt: Duration,
    /// Declared last: dropped after every source is gone.
    _serial: MutexGuard<'static, ()>,
}

static SERIAL: Mutex<()> = Mutex::new(());

fn p(s: &str) -> PropPath {
    PropPath(s.to_string())
}

fn wait_fds(fds: &[RawFd], d: Duration) {
    if fds.is_empty() {
        std::thread::sleep(d);
        return;
    }
    let mut pfds: Vec<libc::pollfd> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    let ms = d.as_millis().max(1) as i32;
    unsafe { libc::poll(pfds.as_mut_ptr(), pfds.len() as libc::nfds_t, ms) };
}

impl Harness {
    /// A harness with one 640×360 virtual output per name (`"VIRTUAL-1"`, …). `None` (and a
    /// printed `SKIP`) without an EGL device or a `transitions/` catalogue.
    pub fn new(outputs: &[&str]) -> Option<Harness> {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let gfx = headless_gl()?;
        let dir = super::catalogue_dir()?;
        let cat = Catalogue::load(&dir).expect("Catalogue::load");
        let composer = Composer::new(&gfx).expect("Composer::new");
        let mut graph = Graph::new();
        let mut outs = Vec::new();
        for name in outputs {
            let id = format!("out:{name}");
            let mut props = Map::new();
            props.insert("width".into(), json!(OUT_W));
            props.insert("height".into(), json!(OUT_H));
            graph
                .create(NodeKind::Output, Some(id.clone()), props)
                .expect("create output");
            let tex = gfx.tex(OUT_W, OUT_H);
            let fbo = gfx.fbo(&tex);
            outs.push((id, tex, fbo));
        }
        let mut base = Map::new();
        base.insert("ao".into(), json!("null")); // R26: silent test runs
        // Phase 2 Task 5: `kind: scene` sources play the synthetic renderer (D7) through
        // this crate's worker binary; crash records stay in a private dir.
        base.insert(
            "scene_worker".into(),
            json!(env!("CARGO_BIN_EXE_liascape-scene-worker")),
        );
        base.insert("allow_synthetic".into(), json!(true));
        let crashes =
            std::env::temp_dir().join(format!("liascape-harness-crashes-{}", std::process::id()));
        base.insert("scene_crash_dir".into(), json!(crashes));
        let mut host = SourceHost::new(base);
        // `LIASCAPE_PLAYER_RENDER_WORKER=on` (the switch `serve` reads): every source renders on a
        // worker sharing this context, as in the real-clock runtime (§ Sources "Render worker").
        if liascape_player::runtime::render_worker_enabled(None) {
            host.set_render_worker(Some(RenderWorker::start(&gfx).expect("render worker")));
        }
        Some(Harness {
            gfx,
            cat,
            composer,
            graph,
            anim: Animator::new(),
            clock: SteppedClock::new(),
            host,
            tr: Transitions::new(),
            outputs: outs,
            src_events: Vec::new(),
            tr_events: Vec::new(),
            ticks: 0,
            last_wall: Instant::now(),
            debt: Duration::ZERO,
            _serial: serial,
        })
    }

    pub fn now(&self) -> Duration {
        self.clock.now()
    }

    /// One iteration, the clock step capped at `cap` (R33).
    pub fn tick_capped(&mut self, cap: Option<Duration>) {
        let since = self.last_wall.elapsed();
        if since < MIN_TICK {
            std::thread::sleep(MIN_TICK - since);
        }
        let since = self.last_wall.elapsed();
        if since < TICK_WAIT {
            wait_fds(&self.host.wake_fds(), TICK_WAIT - since);
        }
        let wall = Instant::now();
        let mut d = wall - self.last_wall + self.debt;
        self.last_wall = wall;
        self.debt = Duration::ZERO;
        if let Some(c) = cap
            && d > c
        {
            self.debt = d - c;
            d = c;
        }
        self.clock.step(d);
        self.run();
    }

    pub fn tick(&mut self) {
        self.tick_capped(None);
    }

    /// One iteration that never steps past `t`.
    pub fn tick_toward(&mut self, t: Duration) {
        let cap = t.saturating_sub(self.now());
        self.tick_capped(Some(cap));
    }

    /// Tick until the clock is exactly `t`.
    pub fn tick_to(&mut self, t: Duration) {
        while self.now() < t {
            self.tick_toward(t);
        }
    }

    /// Tick until `done` (checked after every tick) or `timeout` of player time.
    pub fn tick_until(
        &mut self,
        timeout: Duration,
        mut done: impl FnMut(&Harness) -> bool,
    ) -> bool {
        let end = self.now() + timeout;
        loop {
            self.tick();
            if done(self) {
                return true;
            }
            if self.now() >= end {
                return false;
            }
        }
    }

    fn run(&mut self) {
        let now = self.clock.now();
        self.ticks += 1;
        for (path, v) in self.anim.tick(now) {
            if let Err(e) = self.graph.set(&path, PropValue::F64(v)) {
                panic!(
                    "animator wrote {} = {v} at {now:?}: {e} — an animation outlived its node",
                    path.0
                );
            }
        }
        let changes = self.graph.drain_changes();
        // This harness doesn't model player-level pause (R75): always unpaused. Tests for
        // that go through the full binary (`tests/api.rs`), which drives it via `Runtime`.
        self.host.sync(&self.gfx, &self.graph, &changes, false);
        self.host.update(&self.gfx, &mut self.graph);
        let evs = self.host.events();
        for (id, e) in &evs {
            self.src_events.push((now, id.clone(), e.clone()));
        }
        self.tr.tick(&mut self.graph, &mut self.anim, &evs, now);
        self.tr_events.extend(self.tr.drain_events());
        // The runtime's `refresh_srcs`: a transition's held B/A's are part of `srcs:` (a
        // scene B's demand — the outputs it will show on — comes from it).
        let (held, graves) = self.tr.held_sources();
        self.graph.set_transition_sources(held, graves);
        let host = &self.host;
        let textures = |id: &str| host.texture(id);
        for (id, _, fbo) in &self.outputs {
            self.composer
                .compose_output(&self.gfx, &self.graph, &mut self.cat, id, &textures, fbo)
                .unwrap_or_else(|e| panic!("compose {id}: {e}"));
        }
    }

    // ---- graph helpers ----

    /// Create a `Source` node from JSON props.
    pub fn source(&mut self, props: Value) -> String {
        self.graph
            .create(
                NodeKind::Source,
                None,
                props.as_object().expect("props object").clone(),
            )
            .expect("create source")
    }

    /// A synthetic scene source (Phase 2, D7): `common::synthetic_scene(name, spec)` as a
    /// `kind: scene` node with `extra` props. Not shown anywhere yet.
    pub fn scene(
        &mut self,
        name: &str,
        spec: &liascape_player::scene::synthetic::SyntheticSpec,
        extra: Value,
    ) -> String {
        let dir = super::synthetic_scene(name, spec);
        let mut props = extra.as_object().cloned().unwrap_or_default();
        props.insert("kind".into(), json!("scene"));
        props.insert("path".into(), json!(dir.to_str().expect("utf-8 path")));
        self.source(Value::Object(props))
    }

    /// The live scene source of node `id`.
    pub fn scene_src(&self, id: &str) -> &liascape_player::sources::scene::SceneSource {
        self.host.scene(id).expect("a hosted scene source")
    }

    /// A graph-only output `out:<name>` (`w`×`h`, not composed by this harness) — a demand
    /// for scenes shown on it.
    pub fn add_graph_output(&mut self, name: &str, w: u32, h: u32) {
        let mut props = Map::new();
        props.insert("width".into(), json!(w));
        props.insert("height".into(), json!(h));
        self.graph
            .create(NodeKind::Output, Some(format!("out:{name}")), props)
            .expect("create output");
    }

    pub fn show(&mut self, output: &str, id: &str) {
        self.graph
            .set(
                &p(&format!("lay:{output}:main.content")),
                PropValue::Str(id.to_string()),
            )
            .expect("set layer content");
    }

    /// Create a source from `path` (+ `extra` props), show it on `outputs`, wait until it's
    /// ready and has played a few frames.
    pub fn play(&mut self, path: &std::path::Path, extra: Value, outputs: &[&str]) -> String {
        let mut props = extra.as_object().cloned().unwrap_or_default();
        props.insert("path".into(), json!(path.to_str().expect("utf-8 path")));
        let id = self.source(Value::Object(props));
        for o in outputs {
            self.show(o, &id);
        }
        self.wait_ready(&id);
        let t = self.now() + Duration::from_millis(150);
        self.tick_to(t);
        id
    }

    pub fn wait_ready(&mut self, id: &str) {
        let ok = self.tick_until(Duration::from_secs(5), |h| h.bool(&format!("{id}.ready")));
        assert!(ok, "{id} never became ready; events: {:?}", self.src_events);
    }

    pub fn get(&self, path: &str) -> Option<PropValue> {
        self.graph.get(&p(path)).ok()
    }

    pub fn f64(&self, path: &str) -> f64 {
        match self.get(path) {
            Some(PropValue::F64(f)) => f,
            Some(PropValue::I64(i)) => i as f64,
            other => panic!("{path}: not a number: {other:?}"),
        }
    }

    pub fn bool(&self, path: &str) -> bool {
        matches!(self.get(path), Some(PropValue::Bool(true)))
    }

    pub fn str(&self, path: &str) -> String {
        match self.get(path) {
            Some(PropValue::Str(s)) => s,
            _ => String::new(),
        }
    }

    /// Effective gain (dB) of a source node.
    pub fn gain(&self, id: &str) -> f64 {
        self.graph
            .effective_gain_db(id)
            .unwrap_or_else(|| panic!("{id} is not a source node"))
    }

    pub fn exists(&self, id: &str) -> bool {
        self.graph.kind_of(id).is_some()
    }

    pub fn cur(&self, output: &str) -> Vec<String> {
        self.graph.resolve(&format!("cur:{output}"))
    }

    pub fn content(&self, output: &str) -> String {
        self.str(&format!("lay:{output}:main.content"))
    }

    pub fn sources(&self) -> Vec<String> {
        self.graph.ids_of(NodeKind::Source)
    }

    /// Unpaused source nodes (R38's "live").
    pub fn live(&self) -> Vec<String> {
        self.sources()
            .into_iter()
            .filter(|s| !self.bool(&format!("{s}.paused")))
            .collect()
    }

    pub fn paused(&self) -> Vec<String> {
        self.sources()
            .into_iter()
            .filter(|s| self.bool(&format!("{s}.paused")))
            .collect()
    }

    // ---- pixels ----

    /// Red channel of a source texture's top-left 64×64 block (`FrameIndex`'s marker; image
    /// top is at low y in a raw source texture — R25).
    pub fn corner(&self, id: &str) -> Option<u8> {
        self.host
            .texture(id)
            .map(|t| read_rgba(&self.gfx, t, 32, 32)[0])
    }

    /// An output's top-left pixel (screen top = high y in `read_rgba`'s coordinates).
    pub fn out_corner(&self, output: &str) -> [u8; 4] {
        let (_, tex, _) = self
            .outputs
            .iter()
            .find(|(id, _, _)| id == &format!("out:{output}"))
            .expect("no such virtual output");
        read_rgba(&self.gfx, tex, 6, OUT_H - 6)
    }

    // ---- transitions ----

    pub fn start(&mut self, req: Value) -> CorrId {
        let req: TransitionReq = serde_json::from_value(req).expect("TransitionReq");
        let now = self.now();
        let corr = self
            .tr
            .start(req, &mut self.graph, &mut self.anim, now)
            .expect("Transitions::start");
        self.tr_events.extend(self.tr.drain_events());
        corr
    }

    pub fn cancel(&mut self, corr: &CorrId) {
        let now = self.now();
        self.tr
            .cancel(corr, &mut self.graph, &mut self.anim, now)
            .expect("Transitions::cancel");
        self.tr_events.extend(self.tr.drain_events());
    }

    pub fn event(&self, corr: &CorrId, name: &str) -> Option<TransitionEvent> {
        self.tr_events
            .iter()
            .find(|e| &e.corr == corr && e.kind.name() == name)
            .cloned()
    }

    pub fn wait_event(&mut self, corr: &CorrId, name: &str, timeout: Duration) -> TransitionEvent {
        let c = corr.clone();
        let n = name.to_string();
        self.tick_until(timeout, |h| h.event(&c, &n).is_some());
        self.event(corr, name).unwrap_or_else(|| {
            panic!(
                "no {name} for {corr:?} within {timeout:?}; transition events: {:?}",
                self.tr_events
            )
        })
    }

    /// B's node id (from the `scheduled` event).
    pub fn to_of(&self, corr: &CorrId) -> String {
        match self.event(corr, "transition.scheduled").map(|e| e.kind) {
            Some(TransitionEventKind::Scheduled { to, .. }) => to,
            _ => panic!("no scheduled event for {corr:?}"),
        }
    }

    /// When a source event matching `pred` was first seen for `id`.
    pub fn src_event_at(&self, id: &str, pred: impl Fn(&SourceEvent) -> bool) -> Option<Duration> {
        self.src_events
            .iter()
            .find(|(_, s, e)| s == id && pred(e))
            .map(|(t, _, _)| *t)
    }
}

pub fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

pub fn from_ms(ms: f64) -> Duration {
    Duration::from_secs_f64(ms / 1000.0)
}

/// `started.start_ms` as a `Duration`.
pub fn start_of(ev: &TransitionEvent) -> Duration {
    match &ev.kind {
        TransitionEventKind::Started { start_ms, .. } => from_ms(*start_ms),
        other => panic!("not a started event: {other:?}"),
    }
}
