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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

use super::scene::{OutputDemand, SceneSource};
use super::{
    ColorSource, MpvSource, PreparedCore, RenderWorker, SnapshotSource, Source, SourceEvent,
};
use crate::anim::PropPath;
use crate::gfx::{Gfx, Tex};
use crate::graph::ApiError;
use crate::graph::props::{self, PropValue};
use crate::graph::{Graph, NodeKind};
use crate::log::{self, Level};

/// Observed values mirrored into the graph after every `update` (`Graph::set_observed`).
/// `kind` too: an `MpvSource` infers image/video from the file (and corrects it after
/// load), and recipes decide what is a still by it. `has_audio` (R92): what mpv actually
/// resolved — distinct from `no_audio` (our own request) — so a video with literally no
/// audio track is never mistaken for one that merely has audio disabled.
const MIRRORED: [&str; 9] = [
    "kind",
    "ready",
    "duration",
    "time_pos",
    "width",
    "height",
    "paused",
    "has_audio",
    // Phase 2 Task 10: a scene past its restart budget (the snapshot saves it).
    "broken",
];

struct Hosted {
    src: Box<dyn Source>,
    wake: Option<RawFd>,
    /// The value last mirrored into the graph per [`MIRRORED`] prop (Phase 2 Task 14): an
    /// unchanged one isn't written again. A scene updates on every frame and the mirror used
    /// to format, parse and resolve nine paths per update — the bulk of the compositor's CPU
    /// per worker (perf, on-machine). Cleared whenever a change is forwarded to the source,
    /// so a `set` the source refuses is still mirrored back exactly as before.
    mirrored: [Option<PropValue>; MIRRORED.len()],
}

/// Nothing mirrored yet.
const UNMIRRORED: [Option<PropValue>; MIRRORED.len()] = [const { None }; MIRRORED.len()];

/// Phase 2 Task 8 (low VRAM, mode `stop`): a media source whose decoder/worker was dropped to
/// free GPU memory while its node stays in the graph ([`SourceHost::suspend_media`]).
struct Suspended {
    /// Where it was (`time_pos`; `None` = the node's own `position`).
    position: Option<f64>,
    /// It had shown its first frame (its reopened twin's `Ready` is then no news).
    was_ready: bool,
    /// A still of its last frame, shown in its place until the reopened source has one.
    stand_in: Option<SnapshotSource>,
}

/// A source reopened by [`SourceHost::resume_media`] whose first frame isn't in yet.
struct Resuming {
    was_ready: bool,
    stand_in: Option<SnapshotSource>,
}

/// I5 (final review): wakes the loop when an async open's core is ready.
pub type OpenWaker = Arc<dyn Fn() + Send + Sync>;

type OpenSlot = Arc<Mutex<Option<Result<PreparedCore, ApiError>>>>;

/// An mpv source whose core is being created on a worker thread (`MpvSource::
/// prepare_core`); it becomes a hosted source — from its node's props *at that moment* —
/// on the first `sync` after the worker is done.
struct Opening {
    slot: OpenSlot,
    /// The audio route generation its core was prepared with (I7).
    route_gen: u64,
}

/// Async opens submitted and not finished yet (queued + being made, process-wide) —
/// `finish_teardown` waits for them (bounded) and the runtime counts a straggler as a
/// reaper straggler.
static OPENING: AtomicUsize = AtomicUsize::new(0);

/// Queued opens whose node went before a worker got to them: skipped, no core made.
static OPEN_SKIPPED: AtomicUsize = AtomicUsize::new(0);

/// Whether a source opened from `node` gets the render worker's hwdec GL interop (`interop`,
/// § Sources "Hardware decoding"): only when its `hwdec` (as the node says when the open is
/// submitted) would decode zero-copy through it — not `no`/unset, not a `-copy` mode or
/// `auto-copy`, not a decoder this interop can't show — and it isn't an image (mpv decodes
/// stills in software). The interop's init (a CUDA context per render context on NVIDIA:
/// 85–220 ms of an `lia-render` lane, ~60 MiB of VRAM) is paid for nothing otherwise. A later
/// live `hwdec` change keeps working either way: without the interop `mpv_hwdec` asks for the
/// copy modes.
fn wants_hwdec_interop(node: &[(String, PropValue)], interop: &str) -> bool {
    let get = |k: &str| match node.iter().find(|(n, _)| n == k).map(|(_, v)| v) {
        Some(PropValue::Str(s)) => s.as_str(),
        _ => "",
    };
    if get("kind") == "image" || super::mpv::infer_kind(get("path")) == "image" {
        return false;
    }
    let hw = get("hwdec");
    super::mpv::mpv_hwdec(hw, Some(interop)) != super::mpv::mpv_hwdec(hw, None)
}

/// I5: async opens still queued or creating a core.
pub fn opening_pending() -> usize {
    OPENING.load(Ordering::SeqCst)
}

/// TODO "No explicit cap on concurrent `lia-open` worker threads": at most this many mpv
/// cores are made at once; the rest of a burst waits in submission order — before, a burst
/// spun up one thread per create (16 at once, measured). Measured (release, hermetic
/// headless, a burst of 16 paused 1080p creates, 3 rounds per cap): every core made and
/// opened after 102–166 ms at 1, **61–80 at 2**, 58–71 at 4, 23–70 uncapped; every source
/// ready ~0.5 s whatever the cap (the first frames dominate); the loop's open share in one
/// stretch 3–5, **2–8**, 11–24, 13–29 ms — fewer finished cores land in the same `sync`.
pub const MAX_OPEN_WORKERS: usize = 2;

/// The async opens' pool (`lia-open` threads).
static OPEN_POOL: OpenPool = OpenPool::new("lia-open", MAX_OPEN_WORKERS);

/// The async-open pool (`sources` probe `open_pool`): `cap`, live `workers`, jobs
/// `running`/`queued`, `peak` (most workers alive at once, process lifetime), `skipped`
/// (queued opens whose node went first), `pending` (= [`opening_pending`]).
pub fn open_pool_stats() -> Value {
    let mut v = OPEN_POOL.stats();
    v["skipped"] = json!(OPEN_SKIPPED.load(Ordering::SeqCst));
    v["pending"] = json!(opening_pending());
    v
}

/// A job for an [`OpenPool`].
pub(crate) type PoolJob = Box<dyn FnOnce() + Send>;

/// A bounded FIFO executor: jobs start in submission order on at most `cap` threads named
/// `name`, spawned on demand; a worker exits as soon as the queue is empty, so an idle
/// player keeps no `lia-open` thread. A job that panics doesn't take its worker down.
pub(crate) struct OpenPool {
    name: &'static str,
    cap: usize,
    state: Mutex<PoolState>,
}

struct PoolState {
    queue: std::collections::VecDeque<PoolJob>,
    workers: usize,
    running: usize,
    peak: usize,
}

impl OpenPool {
    pub(crate) const fn new(name: &'static str, cap: usize) -> OpenPool {
        OpenPool {
            name,
            cap,
            state: Mutex::new(PoolState {
                queue: std::collections::VecDeque::new(),
                workers: 0,
                running: 0,
                peak: 0,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PoolState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queue `job`, starting a worker if fewer than `cap` run. `Err(job)` = no worker
    /// exists and none could be started (the caller runs it some other way).
    pub(crate) fn submit(&'static self, job: PoolJob) -> Result<(), PoolJob> {
        let mut s = self.lock();
        if s.workers < self.cap {
            // Spawned under the lock: the new worker's first `lock` waits for this one.
            let spawned = std::thread::Builder::new()
                .name(self.name.into())
                .spawn(move || self.work());
            match spawned {
                Ok(_) => {
                    s.workers += 1;
                    s.peak = s.peak.max(s.workers);
                }
                Err(_) if s.workers == 0 => return Err(job),
                Err(_) => {} // a running worker gets to it
            }
        }
        s.queue.push_back(job);
        Ok(())
    }

    fn work(&self) {
        loop {
            let job = {
                let mut s = self.lock();
                match s.queue.pop_front() {
                    Some(j) => {
                        s.running += 1;
                        j
                    }
                    None => {
                        s.workers -= 1;
                        return;
                    }
                }
            };
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
            self.lock().running -= 1;
        }
    }

    pub(crate) fn stats(&self) -> Value {
        let s = self.lock();
        json!({
            "cap": self.cap,
            "workers": s.workers,
            "running": s.running,
            "queued": s.queue.len(),
            "peak": s.peak,
        })
    }

    /// Jobs waiting for a worker (bounds).
    pub(crate) fn queued(&self) -> usize {
        self.lock().queue.len()
    }
}

/// Async opens waiting for an `lia-open` worker (`loop` probe `bounds.open_queued`).
pub fn open_queued() -> usize {
    OPEN_POOL.queued()
}

/// Owns one live [`Source`] per graph `Source` node.
pub struct SourceHost {
    /// Merged into every `MpvSource::open`'s opts (e.g. `{"ao": "null"}` in tests — R26 —
    /// or the player bus `audio_device`, Task 14). Node props win over these.
    base_opts: Map<String, Value>,
    /// Every scene path's loudness measurement, shared by the scene sources of that path
    /// (`audio::loudness::Book`: a reopen or a transition A → A' continues it).
    loudness: crate::audio::loudness::SharedBook,
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
    /// Sources whose texture changed since the last `take_changed` (Task 13: the redraw
    /// policy wakes only the outputs showing them).
    changed: BTreeSet<String>,
    /// R75 (Task 16b): the last `player_paused` [`SourceHost::sync`] saw. While true, the
    /// `paused` mirror in [`SourceHost::update`] is suspended — every hosted source's
    /// live `paused` is the OR'd *effective* value (what actually reached the source),
    /// not the node's own intention, and mirroring that back would corrupt what the
    /// recipe/user asked for (see `sync`'s doc).
    player_paused: bool,
    /// Task 16c (R88): ids `Runtime`'s player-pause anticlick gate is still ramping down —
    /// excluded from the `player_paused` OR composition below (treated as if
    /// `player_paused` were `false` for them specifically) until the gate itself decides
    /// the ramp has settled and calls [`SourceHost::force_paused`]. Set each tick by
    /// `Runtime` via [`SourceHost::set_pause_exclusions`]; consulted only inside `sync`.
    pause_exclusions: BTreeSet<String>,
    /// I5: `Some` = open mpv cores on a worker thread (the real-clock runtime); `None` =
    /// synchronously (stepped mode — determinism — and the test harnesses).
    async_open: Option<OpenWaker>,
    opening: BTreeMap<String, Opening>,
    /// I7: bumped by every `set_audio_route` (a core prepared before it is re-routed).
    route_gen: u64,
    /// Phase 2: async opens hand their core's rendering to this worker (§ Sources "Render
    /// worker"); `None` = every mpv source renders on the loop.
    render_worker: Option<Arc<RenderWorker>>,
    /// Task 8 (low VRAM, `stop`): media sources dropped to free GPU memory, by node id…
    suspended: BTreeMap<String, Suspended>,
    /// …new media nodes are not opened meanwhile (they open at the resume)…
    suspend_new: bool,
    /// …and reopened ones still waiting for their first frame (stand-in shown, the mirror and
    /// their `Ready` held back).
    resuming: BTreeMap<String, Resuming>,
    /// Where each reopened source starts (its `position` for the open only).
    resume_at: BTreeMap<String, f64>,
}

impl SourceHost {
    pub fn new(base_opts: Map<String, Value>) -> SourceHost {
        SourceHost {
            base_opts,
            loudness: crate::audio::loudness::Book::shared(),
            sources: BTreeMap::new(),
            failed: BTreeSet::new(),
            events: Vec::new(),
            dying: Vec::new(),
            open_time: std::time::Duration::ZERO,
            changed: BTreeSet::new(),
            player_paused: false,
            pause_exclusions: BTreeSet::new(),
            async_open: None,
            opening: BTreeMap::new(),
            route_gen: 0,
            render_worker: None,
            suspended: BTreeMap::new(),
            suspend_new: false,
            resuming: BTreeMap::new(),
            resume_at: BTreeMap::new(),
        }
    }

    /// Phase 2 Task 8 (the low-VRAM rule, mode `stop`): drop every video/image/scene source's
    /// decoder or worker to free its GPU memory — the node stays, a still of its last frame is
    /// shown in its place (`texture`), and media nodes created meanwhile wait unopened. The
    /// caller has paused and silenced them first (the player pause). Returns the ids.
    pub fn suspend_media(&mut self, gfx: &Gfx) -> Vec<String> {
        self.suspend_new = true;
        let ids: Vec<String> = self
            .sources
            .iter()
            .filter(|(_, h)| h.src.as_mpv().is_some() || h.src.as_scene().is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            let Some(mut h) = self.sources.remove(id) else {
                continue;
            };
            let position = match h.src.read("time_pos") {
                Some(PropValue::F64(t)) => Some(t),
                _ => None,
            };
            let ready = matches!(h.src.read("ready"), Some(PropValue::Bool(true)));
            // A source still resuming from an earlier stop keeps that stand-in.
            let earlier = self.resuming.remove(id);
            let stand_in = match h.src.texture() {
                Some(t) => Some(SnapshotSource::new(gfx, id, Some(t))),
                None => earlier.and_then(|r| r.stand_in),
            };
            self.suspended.insert(
                id.clone(),
                Suspended {
                    position,
                    was_ready: ready,
                    stand_in,
                },
            );
            log::event(
                "host",
                Level::Info,
                "source.suspended",
                None,
                json!({ "id": id, "source_kind": h.src.kind(), "position": position }),
            );
            if h.src.begin_teardown() {
                drop(h);
            } else {
                self.dying.push((id.clone(), h, std::time::Instant::now()));
            }
        }
        // Cores still being made: dropped (their result goes to the reaper), opened at the
        // resume from the node.
        for id in std::mem::take(&mut self.opening).into_keys() {
            self.suspended.insert(
                id,
                Suspended {
                    position: None,
                    was_ready: false,
                    stand_in: None,
                },
            );
        }
        ids
    }

    /// Task 8: the low VRAM is over — every suspended source reopens (next `sync`) at the
    /// position it had, its stand-in shown until its first frame; new media nodes open again.
    /// Returns the ids.
    pub fn resume_media(&mut self) -> Vec<String> {
        self.suspend_new = false;
        let mut ids = Vec::new();
        for (id, sus) in std::mem::take(&mut self.suspended) {
            if let Some(t) = sus.position {
                self.resume_at.insert(id.clone(), t);
            }
            self.resuming.insert(
                id.clone(),
                Resuming {
                    was_ready: sus.was_ready,
                    stand_in: sus.stand_in,
                },
            );
            ids.push(id);
        }
        ids
    }

    /// Suspended sources (Task 8; probes).
    pub fn suspended_ids(&self) -> Vec<String> {
        self.suspended.keys().cloned().collect()
    }

    /// Reopened sources still waiting for their first frame (Task 8).
    pub fn resuming_count(&self) -> usize {
        self.resuming.len()
    }

    /// Whether media sources are suspended now (new ones wait).
    pub fn media_suspended(&self) -> bool {
        self.suspend_new
    }

    /// I7 (final review): the audio bus went down (`device = None`: mpv's default device)
    /// or came back (`Some(bus device)`, `bias` = −bus latency) — every source opened from
    /// now on uses it, and every hosted mpv source is re-routed live. Returns the ids
    /// re-routed.
    pub fn set_audio_route(&mut self, device: Option<String>, bias: f64) -> Vec<String> {
        self.route_gen += 1;
        match &device {
            Some(d) => {
                self.base_opts.insert("audio_device".into(), json!(d));
                self.base_opts
                    .insert("audio_delay_bias".into(), json!(bias));
            }
            None => {
                self.base_opts.remove("audio_device");
                self.base_opts.remove("audio_delay_bias");
            }
        }
        let mut n = Vec::new();
        for (id, h) in &mut self.sources {
            // A scene's worker stream follows the route too (its `Start` for a restart).
            if let Some(s) = h.src.as_scene_mut() {
                s.set_audio_route(device.as_deref());
                n.push(id.clone());
                continue;
            }
            let Some(m) = h.src.as_mpv_mut() else {
                continue;
            };
            n.push(id.clone());
            if let Err(e) = m.set_audio_route(device.as_deref(), bias) {
                log::event(
                    "host",
                    Level::Warn,
                    "source.rejected",
                    None,
                    json!({ "id": id, "prop": "audio_device", "reason": e.to_string() }),
                );
            }
        }
        n
    }

    /// I5 (final review): create mpv cores off the loop. `waker` is called (from the
    /// worker) when a core is ready, so the loop picks it up at once; the source then opens
    /// on the next `sync` (render context, props, `loadfile` — the GL half stays on the
    /// loop thread). `None` = synchronous opens (the default).
    pub fn set_async_open(&mut self, waker: Option<OpenWaker>) {
        self.async_open = waker;
    }

    /// Phase 2 (§ Sources "Render worker"): render every mpv source opened asynchronously
    /// from now on on `worker` (its `lia-open` job attaches the core there). Synchronous opens
    /// (stepped mode, the harnesses, a pool that can't start a thread) keep rendering on the
    /// loop. `None` = off.
    pub fn set_render_worker(&mut self, worker: Option<Arc<RenderWorker>>) {
        self.render_worker = worker;
    }

    pub fn render_worker(&self) -> Option<&Arc<RenderWorker>> {
        self.render_worker.as_ref()
    }

    /// Sources whose core is still being created (probes/bounds).
    pub fn opening(&self) -> usize {
        self.opening.len()
    }

    /// Task 16c (R88): set the ids `Runtime`'s player-pause anticlick gate is still
    /// ramping down this tick — `sync` treats `player_paused` as `false` for exactly
    /// these ids (never touching the node's own `paused`, same as every other R75 path)
    /// until the gate calls [`SourceHost::force_paused`]. Cheap to call every tick even
    /// when empty (the common case).
    pub fn set_pause_exclusions(&mut self, ids: BTreeSet<String>) {
        self.pause_exclusions = ids;
    }

    /// Task 16c (R88): push `paused` straight to one hosted source, bypassing the
    /// `player_paused`/node composition entirely — used only by `Runtime`'s player-pause
    /// anticlick gate, once *it* (real wall-clock timed, never the possibly-frozen player
    /// clock) decides the ramp has settled enough to actually pause, or that a resume
    /// should un-pause right away. A rejection is logged/queued exactly like `sync`'s own.
    pub fn force_paused(&mut self, id: &str, paused: bool) {
        let Some(h) = self.sources.get_mut(id) else {
            return;
        };
        h.mirrored = UNMIRRORED;
        if let Err(e) = h.src.apply("paused", &PropValue::Bool(paused)) {
            let reason = format!("apply paused: {e}");
            log::event(
                "host",
                Level::Warn,
                "source.rejected",
                None,
                json!({ "id": id, "prop": "paused", "reason": reason }),
            );
            self.events.push((
                id.to_string(),
                SourceEvent::Rejected {
                    prop: "paused".to_string(),
                    reason,
                },
            ));
        }
    }

    /// R90 (Task 16d): a direct, scoped forward of one already-graph-set gain change to
    /// its hosted source — the fast gain timer's own ≥ 1 kHz channel
    /// (`Runtime::gain_fast_tick`), bypassing the ordinary per-tick [`sync`](Self::sync)
    /// entirely (no source opens, no gone-source scan, no `player_paused` composition —
    /// gain is never composed with it, unlike `paused`). Same direct-apply bypass
    /// pattern as [`force_paused`](Self::force_paused). A source not yet hosted (mid-
    /// open, or its node vanished the instant before) is silently skipped: the ordinary
    /// `sync` catches up once/if it exists, same as any other graph change reaching a
    /// never-hosted id. A rejection is logged/queued exactly like `sync`'s own (the
    /// source is fine, R45).
    pub fn push_gain(&mut self, id: &str, prop: &str, v: &PropValue) {
        let Some(h) = self.sources.get_mut(id) else {
            return;
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

    /// Bring the live sources in line with the graph:
    /// 1. drop every source whose node is gone (or is no longer a `Source`);
    /// 2. open a source for every `Source` node not hosted yet, from the node's current
    ///    props (`kind` `color` → [`ColorSource`], `snapshot` → [`SnapshotSource`] of
    ///    `of`'s current texture, anything else → [`MpvSource`]) — its initial `paused`
    ///    is the *effective* one (R75: `node.paused || player_paused`), not the node's
    ///    raw value;
    /// 3. forward each change addressed to a hosted source to [`Source::apply`] — except
    ///    to sources opened in step 2, whose props already include them; a `paused`
    ///    change is composed with `player_paused` the same way. A refused write is
    ///    logged and queued as [`SourceEvent::Rejected`] (the source is fine, R45); a
    ///    failed open as [`SourceEvent::Error`];
    /// 4. if `player_paused` itself changed since the last call, push every *other*
    ///    hosted source's recomputed effective `paused` too (step 3 above only reaches a
    ///    source whose own node changed this call).
    ///
    /// R75's effective pause is intentionally never written into `self.props["paused"]`
    /// as the node's own truth would be: `Source::apply("paused", …)` is still the single
    /// channel (mpv's real `pause` ends up OR'd either way — there's only one mpv
    /// property to tell), but the *mirror* back into the graph (`SourceHost::update`) is
    /// suspended for `paused` while `player_paused` is true, so the OR'd value a hosted
    /// source now reports never overwrites the node's own `paused` — which the recipe
    /// (and `release`/`is_still`'s own reads of it) depends on staying exactly what it
    /// set, pause or no pause.
    pub fn sync(
        &mut self,
        gfx: &Gfx,
        graph: &Graph,
        changes: &[(PropPath, PropValue)],
        player_paused: bool,
    ) {
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
        let alive = |id: &String| graph.kind_of(id) == Some(NodeKind::Source);
        self.suspended.retain(|id, _| alive(id));
        self.resuming.retain(|id, _| alive(id));
        self.resume_at.retain(|id, _| alive(id));
        // I5: a node gone while its core is still being made — the worker's result is
        // dropped with the slot (`PreparedCore::drop` hands the core to the reaper).
        self.opening
            .retain(|id, _| graph.kind_of(id) == Some(NodeKind::Source));

        let mut opened = BTreeSet::new();
        // I5: cores the workers finished since the last sync become sources now, from
        // their nodes' *current* props (every change while opening is already in them).
        let ready: Vec<String> = self
            .opening
            .iter()
            .filter(|(_, o)| o.slot.lock().unwrap_or_else(|e| e.into_inner()).is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in ready {
            let Some(o) = self.opening.remove(&id) else {
                continue;
            };
            let stale_route = o.route_gen != self.route_gen;
            let result = o
                .slot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .expect("filtered on is_some");
            let Some(mut node) = graph.props_of(&id) else {
                continue;
            };
            if let Some(t) = self.resume_at.remove(&id) {
                patch_position(&mut node, t);
            }
            let t_open = std::time::Instant::now();
            let opened_src = result
                .map_err(|e| e.to_string())
                .and_then(|core| self.open_mpv(gfx, &node, player_paused, Some(core)));
            self.open_time += t_open.elapsed();
            match opened_src {
                Ok(mut h) => {
                    // I7: the bus went down/up while this core was being made — its
                    // `audio-device` is the old one.
                    if stale_route && let Some(m) = h.src.as_mpv_mut() {
                        let dev = self
                            .base_opts
                            .get("audio_device")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let bias = self
                            .base_opts
                            .get("audio_delay_bias")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0);
                        let _ = m.set_audio_route(dev.as_deref(), bias);
                    }
                    log::event(
                        "host",
                        Level::Debug,
                        "source.open",
                        None,
                        json!({ "id": id, "source_kind": h.src.kind(), "async": true }),
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
        for id in graph.ids_of(NodeKind::Source) {
            if self.sources.contains_key(&id)
                || self.failed.contains(&id)
                || self.opening.contains_key(&id)
                || self.suspended.contains_key(&id)
            {
                continue;
            }
            let Some(mut node) = graph.props_of(&id) else {
                continue;
            };
            // Task 8: while media is suspended (low VRAM), a new video/image/scene waits.
            if self.suspend_new && is_media(&node) {
                self.suspended.insert(
                    id.clone(),
                    Suspended {
                        position: None,
                        was_ready: false,
                        stand_in: None,
                    },
                );
                continue;
            }
            // A reopened source starts where it was suspended (kept until it really opens: an
            // async open reads the node again when its core is ready).
            if let Some(&t) = self.resume_at.get(&id) {
                patch_position(&mut node, t);
            }
            if self.start_async_open(&id, &node) {
                continue;
            }
            self.resume_at.remove(&id);
            let t_open = std::time::Instant::now();
            let opened_src = self.open(gfx, &id, &node, player_paused);
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
            // R75: a node-level `paused` change is composed with the current
            // `player_paused` before it reaches the source — the source only ever sees
            // the effective value. Task 16c (R88): an id the pause-anticlick gate is still
            // ramping down is excluded from that OR — `player_paused` reads as `false`
            // for it specifically until the gate itself calls `force_paused`.
            let effective = (prop == "paused").then_some(PropValue::Bool(
                matches!(v, PropValue::Bool(true))
                    || (player_paused && !self.pause_exclusions.contains(id)),
            ));
            let apply_v = effective.as_ref().unwrap_or(v);
            h.mirrored = UNMIRRORED;
            if let Err(e) = h.src.apply(prop, apply_v) {
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

        // R75: `player_paused` itself changed — every *other* hosted source (one whose
        // own `paused` didn't just change above, and that wasn't just opened with the
        // right value already) needs its effective pause recomputed and pushed too.
        if player_paused != self.player_paused {
            for id in graph.ids_of(NodeKind::Source) {
                if opened.contains(&id)
                    || changes.iter().any(|(p, _)| p.0 == format!("{id}.paused"))
                {
                    continue;
                }
                let Some(h) = self.sources.get_mut(&id) else {
                    continue;
                };
                let node_paused = matches!(
                    graph.get(&PropPath(format!("{id}.paused"))),
                    Ok(PropValue::Bool(true))
                );
                let effective = PropValue::Bool(
                    node_paused || (player_paused && !self.pause_exclusions.contains(&id)),
                );
                h.mirrored = UNMIRRORED;
                if let Err(e) = h.src.apply("paused", &effective) {
                    let reason = format!("apply paused: {e}");
                    log::event(
                        "host",
                        Level::Warn,
                        "source.rejected",
                        None,
                        json!({ "id": id, "prop": "paused", "reason": reason }),
                    );
                    self.events.push((
                        id,
                        SourceEvent::Rejected {
                            prop: "paused".to_string(),
                            reason,
                        },
                    ));
                }
            }
        }
        self.player_paused = player_paused;

        // Phase 2 Task 5: every scene's demand — the outputs showing it now (their sizes,
        // refresh, `scene_fps`). The first one naming an output spawns its worker (here, on
        // the loop thread: the worker's PDEATHSIG follows the spawning thread); a change of
        // the largest output re-exports its ring; no output (parked) changes nothing.
        for (id, h) in &mut self.sources {
            if let Some(s) = h.src.as_scene_mut() {
                s.set_demand(&demand_for(graph, id));
            }
        }
    }

    fn open(
        &self,
        gfx: &Gfx,
        id: &str,
        node: &[(String, PropValue)],
        player_paused: bool,
    ) -> Result<Hosted, String> {
        let get = |k: &str| node.iter().find(|(n, _)| n == k).map(|(_, v)| v);
        let s = |k: &str| match get(k) {
            Some(PropValue::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let kind = s("kind");
        // R75: the source is opened already effectively paused if either the node asked
        // for it or `player_paused` is on — never just the node's raw value.
        let node_paused = matches!(get("paused"), Some(PropValue::Bool(true)));
        let effective_paused = node_paused || player_paused;
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
            "scene" => {
                // Opened with the *effective* pause (R75), like every other kind.
                let mut n = node.to_vec();
                n.retain(|(k, _)| k != "paused");
                n.push(("paused".into(), PropValue::Bool(effective_paused)));
                let src = SceneSource::open(gfx, id, &n, &self.base_opts, &self.loudness)
                    .map_err(|e| e.to_string())?;
                let wake = Some(src.wake_fd());
                return Ok(Hosted {
                    src: Box::new(src),
                    wake,
                    mirrored: UNMIRRORED,
                });
            }
            _ => return self.open_mpv(gfx, node, player_paused, None),
        };
        // Colour/snapshot: store every writable prop so `read` (and the mirror) agrees with
        // the node from the start (e.g. `paused`) — `paused` itself gets the effective
        // value (R75), same as the mpv path above.
        for (k, v) in &writable {
            if !matches!(k.as_str(), "kind" | "color") {
                if k == "paused" {
                    let _ = src.apply(k, &PropValue::Bool(effective_paused));
                } else {
                    let _ = src.apply(k, v);
                }
            }
        }
        Ok(Hosted {
            src,
            wake: None,
            mirrored: UNMIRRORED,
        })
    }

    /// The `MpvSource` for `node`: its opts (base + every writable prop, `paused` the
    /// effective one, R75), on `core` if one was prepared off the loop (I5), else a core
    /// made here.
    fn open_mpv(
        &self,
        gfx: &Gfx,
        node: &[(String, PropValue)],
        player_paused: bool,
        core: Option<PreparedCore>,
    ) -> Result<Hosted, String> {
        let get = |k: &str| node.iter().find(|(n, _)| n == k).map(|(_, v)| v);
        let s = |k: &str| match get(k) {
            Some(PropValue::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let node_paused = matches!(get("paused"), Some(PropValue::Bool(true)));
        let mut opts = self.base_opts.clone();
        for (k, v) in node.iter().filter(|(k, _)| {
            k.starts_with("gain.")
                || props::schema_for(NodeKind::Source, k).is_some_and(|d| !d.readonly)
        }) {
            if !matches!(k.as_str(), "kind" | "path" | "color") {
                opts.insert(k.clone(), v.to_json());
            }
        }
        opts.insert("paused".into(), json!(node_paused || player_paused));
        // `video` is the schema default, so only an explicit `image` is passed on;
        // MpvSource infers from the extension and corrects itself after load.
        if s("kind") == "image" {
            opts.insert("kind".into(), json!("image"));
        }
        // A synchronous open still renders on the worker when there is one (the harness; a
        // pool that couldn't start a thread) — every source of a player renders in one place.
        // Without the hwdec interop: this thread (the loop) waits for the attach, and the
        // interop's init would be its wait (§ Sources "Hardware decoding").
        let m = match (core, &self.render_worker) {
            (Some(core), _) => MpvSource::open_with_core(gfx, &s("path"), &opts, core),
            (None, Some(w)) => MpvSource::prepare_core(&opts)
                .and_then(|core| core.attach_render(w, false))
                .and_then(|core| MpvSource::open_with_core(gfx, &s("path"), &opts, core)),
            (None, None) => MpvSource::open(gfx, &s("path"), &opts),
        }
        .map_err(|e| e.to_string())?;
        let wake = Some(m.wake_fd());
        Ok(Hosted {
            src: Box::new(m),
            wake,
            mirrored: UNMIRRORED,
        })
    }

    /// I5: start making `id`'s mpv core on a worker thread, if opens are async and it is
    /// an mpv source. `false` = open it synchronously instead.
    fn start_async_open(&mut self, id: &str, node: &[(String, PropValue)]) -> bool {
        let Some(waker) = self.async_open.clone() else {
            return false;
        };
        let kind = node
            .iter()
            .find(|(n, _)| n == "kind")
            .and_then(|(_, v)| match v {
                PropValue::Str(s) => Some(s.as_str()),
                _ => None,
            })
            .unwrap_or("");
        // A scene opens on the loop (no core to make: its worker is spawned at its first
        // demand, from this thread — PDEATHSIG follows the spawning thread).
        if matches!(kind, "color" | "snapshot" | "scene") {
            return false;
        }
        let slot: OpenSlot = Arc::new(Mutex::new(None));
        // The job holds the slot weakly while queued: a node gone before a worker gets to
        // it (its `Opening` dropped by `sync`/`finish_teardown`) is skipped — no core made.
        // Once running it holds it strongly; a node gone meanwhile drops the result with
        // the last reference (`PreparedCore::drop` → reaper), as before.
        let weak = Arc::downgrade(&slot);
        let opts = self.base_opts.clone();
        let worker = self.render_worker.clone();
        let interop = worker
            .as_ref()
            .and_then(|w| w.hwdec_interop())
            .is_some_and(|i| wants_hwdec_interop(node, i));
        OPENING.fetch_add(1, Ordering::SeqCst);
        let job: PoolJob = Box::new(move || {
            let Some(slot) = weak.upgrade() else {
                OPEN_SKIPPED.fetch_add(1, Ordering::SeqCst);
                OPENING.fetch_sub(1, Ordering::SeqCst);
                return;
            };
            // Phase 2: the render context is made on the render worker too, not the loop —
            // with the hwdec GL interop when the source will decode in hardware (its init
            // waits on this thread and costs the worker, never the loop).
            let r = MpvSource::prepare_core(&opts).and_then(|core| match &worker {
                Some(w) => core.attach_render(w, interop),
                None => Ok(core),
            });
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
            drop(slot);
            OPENING.fetch_sub(1, Ordering::SeqCst);
            waker();
        });
        if OPEN_POOL.submit(job).is_err() {
            OPENING.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        self.opening.insert(
            id.to_string(),
            Opening {
                slot,
                route_gen: self.route_gen,
            },
        );
        true
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
    /// R75: the `paused` mirror is skipped entirely while `player_paused` — every hosted
    /// source's live `paused` is then the OR'd effective value, not the node's own
    /// intention, and mirroring it back would corrupt that (`sync`'s doc).
    pub fn update(&mut self, gfx: &Gfx, graph: &mut Graph) {
        self.reap_dying(false);
        let mut new_events = Vec::new();
        let mut resumed = Vec::new();
        for (id, h) in &mut self.sources {
            if h.src.update(gfx) {
                self.changed.insert(id.clone());
            }
            // Task 8: a source reopened after a low-VRAM stop is the same wallpaper: until its
            // first frame the graph keeps what it knew (no mirror) and the stand-in shows.
            let resuming = self.resuming.get(id);
            if let Some(r) = resuming
                && matches!(h.src.read("ready"), Some(PropValue::Bool(true)))
                && h.src.texture().is_some()
            {
                resumed.push((id.clone(), r.was_ready));
            }
            for ev in h.src.poll_events() {
                if ev == SourceEvent::Ready && resuming.is_some_and(|r| r.was_ready) {
                    continue; // it was ready before the stop: not news
                }
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
            for (i, prop) in MIRRORED.iter().enumerate() {
                if *prop == "paused" && self.player_paused {
                    continue;
                }
                if resuming.is_some() {
                    continue;
                }
                if let Some(v) = h.src.read(prop) {
                    if h.mirrored[i].as_ref() == Some(&v) {
                        continue;
                    }
                    let _ = graph.set_observed(&PropPath(format!("{id}.{prop}")), v.clone());
                    h.mirrored[i] = Some(v);
                }
            }
        }
        self.events.extend(new_events);
        for (id, _) in resumed {
            self.resuming.remove(&id);
            self.changed.insert(id.clone());
            log::event(
                "host",
                Level::Info,
                "source.resumed",
                None,
                json!({ "id": id }),
            );
        }
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

    /// Sources whose texture changed (a new frame, a colour repaint) since the last call.
    pub fn take_changed(&mut self) -> BTreeSet<String> {
        std::mem::take(&mut self.changed)
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
        // I5: cores still being made go too (a worker finishing later hands its core to
        // the reaper itself); queued ones are skipped at once, so the wait below is the
        // ≤ MAX_OPEN_WORKERS cores in progress (2–8 ms each).
        self.opening.clear();
        while opening_pending() > 0 && t.elapsed() < max {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
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

    /// The live texture of source node `id` (the compositor's `textures` closure) — or, for a
    /// source suspended/resuming after a low-VRAM stop (Task 8), the still of its last frame.
    pub fn texture(&self, id: &str) -> Option<&Tex> {
        self.sources
            .get(id)
            .and_then(|h| h.src.texture())
            .or_else(|| {
                self.suspended
                    .get(id)
                    .and_then(|s| s.stand_in.as_ref())
                    .or_else(|| self.resuming.get(id).and_then(|r| r.stand_in.as_ref()))
                    .and_then(|st| st.texture())
            })
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

    /// Set (`Some`) or remove (`None`) one base opt for sources opened from now on (Task 7:
    /// `scene_assets` / `scene_assets_error` follow `player.scene_assets` live).
    pub fn set_base_opt(&mut self, key: &str, v: Option<Value>) {
        match v {
            Some(v) => {
                self.base_opts.insert(key.to_string(), v);
            }
            None => {
                self.base_opts.remove(key);
            }
        }
    }

    pub fn base_opt(&self, key: &str) -> Option<&Value> {
        self.base_opts.get(key)
    }

    /// Ids of every hosted scene source.
    pub fn scene_ids(&self) -> Vec<String> {
        self.sources
            .iter()
            .filter(|(_, h)| h.src.as_scene().is_some())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// The live scene source for node `id`, if it is one (stepped mode, probes, tests).
    pub fn scene(&self, id: &str) -> Option<&SceneSource> {
        self.sources.get(id).and_then(|h| h.src.as_scene())
    }

    pub fn scene_mut(&mut self, id: &str) -> Option<&mut SceneSource> {
        self.sources.get_mut(id).and_then(|h| h.src.as_scene_mut())
    }

    /// Every hosted scene's worker (the `workers` probe, `state.workers`).
    pub fn workers_info(&self) -> Vec<Value> {
        self.sources
            .values()
            .filter_map(|h| h.src.as_scene().map(SceneSource::worker_info))
            .collect()
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

/// `node`'s `position` for an open (a source resumed after a low-VRAM stop — Task 8).
fn patch_position(node: &mut Vec<(String, PropValue)>, t: f64) {
    node.retain(|(k, _)| k != "position");
    node.push(("position".into(), PropValue::F64(t)));
}

/// A video/image/scene node (what a low-VRAM stop suspends — Task 8): not colour/snapshot.
fn is_media(node: &[(String, PropValue)]) -> bool {
    !matches!(
        node.iter().find(|(k, _)| k == "kind").map(|(_, v)| v),
        Some(PropValue::Str(k)) if k == "color" || k == "snapshot"
    )
}

/// What the outputs showing source `id` ask of it (Phase 2 Task 5): each `out:<c>` in
/// `graph.outputs_of(id)` with its size, refresh and `scene_fps`.
pub fn demand_for(graph: &Graph, id: &str) -> Vec<OutputDemand> {
    let num = |o: &str, p: &str| match graph.get(&PropPath(format!("{o}.{p}"))) {
        Ok(PropValue::I64(i)) => i as f64,
        Ok(PropValue::F64(f)) => f,
        _ => 0.0,
    };
    graph
        .outputs_of(id)
        .into_iter()
        .map(|o| OutputDemand {
            width: num(&o, "width").max(0.0) as u32,
            height: num(&o, "height").max(0.0) as u32,
            refresh_hz: num(&o, "refresh_hz"),
            scene_fps: num(&o, "scene_fps"),
            name: o,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{OpenPool, PoolJob};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn leak(cap: usize) -> &'static OpenPool {
        Box::leak(Box::new(OpenPool::new("lia-open-test", cap)))
    }

    fn wait_idle(pool: &OpenPool) {
        let t = Instant::now();
        while pool.stats()["workers"] != 0 {
            assert!(t.elapsed() < Duration::from_secs(5), "{}", pool.stats());
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// TODO "No explicit cap on concurrent `lia-open` worker threads": a burst of 20 jobs
    /// (each 5 ms) never runs more than `cap` at once, starts them in submission order,
    /// loses none, and leaves no worker behind once the queue is empty.
    #[test]
    fn open_pool_caps_concurrency_in_order_and_loses_none() {
        let pool = leak(2);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicUsize::new(0));
        for i in 0..20 {
            let (running, peak, started, done) =
                (running.clone(), peak.clone(), started.clone(), done.clone());
            let job: PoolJob = Box::new(move || {
                let n = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                started.lock().unwrap().push(i);
                std::thread::sleep(Duration::from_millis(5));
                running.fetch_sub(1, Ordering::SeqCst);
                done.fetch_add(1, Ordering::SeqCst);
            });
            assert!(pool.submit(job).is_ok());
        }
        assert!(pool.stats()["workers"].as_u64().unwrap() <= 2);
        wait_idle(pool);
        assert_eq!(done.load(Ordering::SeqCst), 20, "jobs lost");
        assert_eq!(
            peak.load(Ordering::SeqCst),
            2,
            "never more than the cap at once"
        );
        assert_eq!(pool.stats()["peak"], 2);
        assert_eq!(pool.stats()["queued"], 0);
        // FIFO start order: with two workers, job i starts within one place of i.
        let order = started.lock().unwrap().clone();
        for (pos, i) in order.iter().enumerate() {
            assert!(pos.abs_diff(*i) <= 1, "start order {order:?}");
        }
    }

    /// A job that panics doesn't take its worker down: later jobs still run, and the pool
    /// starts workers again after going idle.
    #[test]
    fn open_pool_survives_a_panicking_job_and_restarts_after_idle() {
        let pool = leak(1);
        let done = Arc::new(AtomicUsize::new(0));
        assert!(
            pool.submit(Box::new(|| panic!("job panics (expected)")))
                .is_ok()
        );
        let d = done.clone();
        assert!(
            pool.submit(Box::new(move || {
                d.fetch_add(1, Ordering::SeqCst);
            }))
            .is_ok()
        );
        wait_idle(pool);
        assert_eq!(done.load(Ordering::SeqCst), 1);
        let d = done.clone();
        assert!(
            pool.submit(Box::new(move || {
                d.fetch_add(1, Ordering::SeqCst);
            }))
            .is_ok()
        );
        wait_idle(pool);
        assert_eq!(done.load(Ordering::SeqCst), 2);
        assert_eq!(pool.stats()["running"], 0);
    }
}
