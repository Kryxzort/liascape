//! `SceneSource` — a WE scene rendered by an `liascape-scene-worker` process (Phase 2; `.claude/
//! rules/player-core.md` § Scene worker). Task 4 built the **texture path**: spawn the
//! worker ([`WorkerHost`]), import its exported ring once ([`ImportedRing`]), tick it, latch
//! only frames whose fence already signalled ([`Latch`]) and return each replaced slot with a
//! release fence. The latched texture survives the worker's death (spike §6); a restarted
//! worker's new ring replaces the old one only once its first frame latched.
//!
//! Task 5 makes it a graph [`Source`] (`kind: scene`): opened by `SourceHost` from the node's
//! props ([`SceneSource::open`]), the worker spawned at the first [`set_demand`] that names an
//! output (the ring is exported at the cover size of the largest output showing it), ticked
//! at the outputs' `eff(scene_fps, refresh)`, on a **scene clock** that excises paused time
//! and advances at `speed` ([`SceneClock`]); `paused` stops ticks and latching at once (the
//! held texture is exact); `Ready` = the first latched frame of a load; a live `path` change
//! = a new worker on the new folder with the old frame held until its first frame; stepped
//! mode ticks exactly the step's scene time ([`step_to`]).
//!
//! Task 8: the tick rate is `min(demand, the GPU budget's cap)` ([`observe_budget`] — the
//! runtime feeds it every 500 ms; `scene::budget`), the worker's per-frame GPU time arrives in
//! `Frame.gpu_ms`, and the per-scene VRAM guard stops a worker over its limit
//! ([`stop_for_vram`] — reported like an error, never a crash).
//!
//! Imports, latching and release fences run on the caller's (the loop's) context — plan
//! "Render worker interplay": a one-off import per slot and an fd poll per frame, so no
//! share-group rebind and no extra thread hop.
//!
//! [`set_demand`]: SceneSource::set_demand
//! [`step_to`]: SceneSource::step_to
//! [`observe_budget`]: SceneSource::observe_budget
//! [`stop_for_vram`]: SceneSource::stop_for_vram

use std::collections::{BTreeMap, VecDeque};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use super::{MpvSource, Source, SourceEvent, StepStatus, unsupported};
use crate::audio::loudness::{self, Book, Learned, Learner, SharedBook};
use crate::gfx::dmabuf::DmabufDesc;
use crate::gfx::{Gfx, GlKeepAlive, Tex};
use crate::graph::props::{self, PropValue};
use crate::graph::{ApiError, NodeKind};
use crate::log::{self, Level};
use crate::scene::budget::Budget;
use crate::units::{GainSlot, Gains};
use crate::worker::dmabuf::{ImportedRing, Latch};
use crate::worker::proto::{AudioRoute, FromWorker, ToWorker};
use crate::worker::{
    HANG_TIMEOUT, RestartBudget, WorkerEvent, WorkerHost, WorkerSpec, WorkerState,
};

/// Most ticks in flight (sent, no `Frame` yet): a slow worker isn't flooded, and one tick
/// is always queued behind the frame it's rendering.
const MAX_INFLIGHT: u64 = 2;

/// A tick due within this much is sent now (the loop's own tick jitter must not cost a
/// frame when the scene runs at the loop's rate).
const TICK_SLACK: Duration = Duration::from_millis(2);

/// The scene frame rate when nothing says otherwise (D5: LWE's default).
pub const DEFAULT_SCENE_FPS: f64 = 30.0;

/// `Position` events at most this often (like `MpvSource`).
const POSITION_EVERY: Duration = Duration::from_millis(100);

/// Envelope entries (1 ms each) kept for the runtime between drains (10 s: a caller that never
/// drains — a harness — holds a bounded amount).
const ENVELOPE_KEEP: usize = 10_000;

/// The window the GPU budget's inputs are taken over (the `frames` probe's miss window).
const BUDGET_WINDOW: Duration = Duration::from_secs(2);

/// A scene latching under this fraction of its tick rate is missing its own frames (Task 8).
const DEFICIT_RATIO: f64 = 0.9;

/// F4: a process's CPU time from `/proc/<pid>/task/*/stat` (`utime + stime`): `{total_ms,
/// threads: {name: ms}}` (threads summed by name), `None` if it is gone.
pub fn proc_cpu(pid: u32) -> Option<Value> {
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64;
    let mut threads = Map::new();
    let mut total = 0.0;
    for t in std::fs::read_dir(format!("/proc/{pid}/task")).ok()?.flatten() {
        let Ok(st) = std::fs::read_to_string(t.path().join("stat")) else {
            continue;
        };
        let (Some(a), Some(b)) = (st.find('('), st.rfind(')')) else {
            continue;
        };
        let name = &st[a + 1..b];
        let f: Vec<&str> = st[b + 2..].split_whitespace().collect();
        let ticks = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        let ms = (ticks(11) + ticks(12)) / hz * 1e3;
        total += ms;
        let e = threads.entry(name.to_string()).or_insert(json!(0.0));
        *e = json!(e.as_f64().unwrap_or(0.0) + ms);
    }
    Some(json!({"total_ms": total, "threads": threads}))
}

/// One output showing a scene ([`SceneSource::set_demand`]).
#[derive(Debug, Clone, PartialEq)]
pub struct OutputDemand {
    /// `out:<connector>`.
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// The output's refresh (0 = unknown).
    pub refresh_hz: f64,
    /// `out:<c>.scene_fps` (0 = the refresh).
    pub scene_fps: f64,
}

/// The frame rate a scene runs at for one output: `scene_fps`, never above the refresh;
/// `0` = the refresh; neither known → [`DEFAULT_SCENE_FPS`].
pub fn eff_fps(scene_fps: f64, refresh_hz: f64) -> f64 {
    let r = if scene_fps <= 0.0 {
        refresh_hz
    } else if refresh_hz > 0.0 {
        scene_fps.min(refresh_hz)
    } else {
        scene_fps
    };
    if r > 0.0 { r } else { DEFAULT_SCENE_FPS }
}

/// What the ring is exported for and how fast the scene ticks, from every output showing
/// it: `max_size` = the largest width and height (so the cover size covers each output),
/// tick rate = the highest [`eff_fps`]. `None` for no output.
pub fn demand_of(outs: &[OutputDemand]) -> Option<([u32; 2], f64)> {
    if outs.is_empty() {
        return None;
    }
    let w = outs.iter().map(|o| o.width).max().unwrap_or(0).max(1);
    let h = outs.iter().map(|o| o.height).max().unwrap_or(0).max(1);
    let hz = outs
        .iter()
        .map(|o| eff_fps(o.scene_fps, o.refresh_hz))
        .fold(0.0, f64::max);
    Some(([w, h], hz))
}

/// The scene clock (plan Task 5): scene seconds that advance at `speed` while running, with
/// paused intervals excised — never stopped-and-jumped. Pure (the caller passes `now`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneClock {
    /// Scene time at `since` (or the frozen time while stopped).
    base: f64,
    /// Running since this instant; `None` = stopped.
    since: Option<Instant>,
    speed: f64,
}

impl SceneClock {
    /// Stopped at `position`.
    pub fn new(position: f64, speed: f64) -> SceneClock {
        SceneClock {
            base: position,
            since: None,
            speed,
        }
    }

    pub fn now(&self, now: Instant) -> f64 {
        match self.since {
            Some(s) => self.base + now.saturating_duration_since(s).as_secs_f64() * self.speed,
            None => self.base,
        }
    }

    pub fn running(&self) -> bool {
        self.since.is_some()
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }

    /// Start (from where it stopped) or stop (keeping the time it reached).
    pub fn set_running(&mut self, run: bool, now: Instant) {
        if run == self.running() {
            return;
        }
        self.base = self.now(now);
        self.since = run.then_some(now);
    }

    /// A new rate from `now` on (the time so far is kept).
    pub fn set_speed(&mut self, speed: f64, now: Instant) {
        self.base = self.now(now);
        if self.since.is_some() {
            self.since = Some(now);
        }
        self.speed = speed;
    }

    /// Jump to scene time `t` (a `position` set).
    pub fn jump(&mut self, t: f64, now: Instant) {
        self.base = t;
        if self.since.is_some() {
            self.since = Some(now);
        }
    }
}

/// How to open a scene. [`SceneSource::open`] fills it from a graph node; tests drive
/// [`SceneSource::open_opts`] directly.
#[derive(Debug, Clone)]
pub struct SceneOpts {
    /// The source id (logs, crash records).
    pub id: String,
    /// The item folder.
    pub path: PathBuf,
    pub worker_bin: PathBuf,
    pub tick_hz: f64,
    /// The largest output's size (the ring is exported at `scene::cover_size`).
    pub max_size: [u32; 2],
    /// Render `liascape-synthetic.json` (tests; the worker also needs
    /// `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`).
    pub synthetic: bool,
    /// Scene time at start (s).
    pub position: f64,
    pub paused: bool,
    pub speed: f64,
    /// Stepped clock: tick only what [`SceneSource::step_to`] asks for.
    pub stepped: bool,
    /// WE's `assets/` (Task 7: resolved by the compositor, `scene::assets`; `None` = none —
    /// a real scene then fails with the hint).
    pub assets_dir: Option<String>,
    /// The Steam library the item lives in (`scene::assets::steam_root_of_item`).
    pub steam_dir: Option<String>,
    /// The scene's user properties (`scene_props`), applied at every (re)start.
    pub properties: Map<String, Value>,
    pub audio: AudioRoute,
    pub env: Vec<(String, String)>,
    pub budget: RestartBudget,
    pub hang_timeout: Duration,
    pub crash_dir: PathBuf,
    /// Spawn the worker at the first [`SceneSource::set_demand`] naming an output instead of
    /// at open (the graph path: the ring is exported at the right size from the start).
    pub defer_spawn: bool,
    /// The item's preview image (Task 10: shown while no worker frame exists after a crash,
    /// and for a scene restored broken). Empty = none.
    pub preview: String,
    /// Scene loudness learning: seconds of audible play to learn over (`audio::loudness`,
    /// `LIASCAPE_PLAYER_LOUDNESS_WINDOW_S`; 60 by default).
    pub loudness_window_s: f64,
    /// The total audible seconds (every play) after which nothing more is measured
    /// (`LIASCAPE_PLAYER_LOUDNESS_CAP_S`; 1800 by default).
    pub loudness_cap_s: f64,
    /// The measurement of earlier plays to continue (`loudness_seed`: the state the backend
    /// stored from the last `scene.loudness`), if any — unless the player's own [`Book`] holds
    /// more of this path.
    pub loudness_seed: Option<Value>,
    /// The book of scene measurements this source shares with every other source of the
    /// compositor (`SourceHost`'s); `None` = a private one (tests driving `open_opts`).
    pub loudness_book: Option<SharedBook>,
}

impl SceneOpts {
    /// Defaults: 30 ticks/s (D5), a 1920×1080 demand, LWE (not synthetic), position 0,
    /// playing at 1×, production restart budget / hang timeout / crash dir, spawned at open.
    pub fn new(path: impl Into<PathBuf>, worker_bin: impl Into<PathBuf>) -> SceneOpts {
        SceneOpts {
            id: "scene".into(),
            path: path.into(),
            worker_bin: worker_bin.into(),
            tick_hz: DEFAULT_SCENE_FPS,
            max_size: [1920, 1080],
            synthetic: false,
            position: 0.0,
            paused: false,
            speed: 1.0,
            stepped: false,
            assets_dir: None,
            steam_dir: None,
            properties: Map::new(),
            audio: AudioRoute::Null,
            env: Vec::new(),
            budget: RestartBudget::default(),
            hang_timeout: HANG_TIMEOUT,
            crash_dir: crate::paths::crash_dir(),
            defer_spawn: false,
            preview: String::new(),
            loudness_window_s: loudness::DEFAULT_WINDOW_S,
            loudness_cap_s: loudness::DEFAULT_CAP_S,
            loudness_seed: None,
            loudness_book: None,
        }
    }

    /// A learner for this scene's loudness: the window, the cap and the seed (if any).
    fn learner(&self) -> Learner {
        Learner::new(self.loudness_window_s)
            .with_cap(self.loudness_cap_s)
            .with_seed(self.loudness_seed.as_ref())
    }
}

/// Transport counters (the `workers` probe).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SceneStats {
    pub latched: u64,
    pub stale_reuses: u64,
    pub superseded: u64,
    pub queued: usize,
    pub ticks_sent: u64,
    pub frames_received: u64,
    pub tick_send_failures: u64,
    pub restarts: u32,
    /// Imported rings alive (2 only between a restart and its first latched frame).
    pub rings: usize,
    /// Worker generation of the latched frame (bumps at each restart and path change).
    pub latched_gen: u32,
    /// `Resize` messages sent (a demand change that moved the largest output).
    pub resizes: u64,
    /// `Buffer` sets received (1 per worker process + 1 per re-export).
    pub buffer_sets: u64,
    /// Workers spawned for this source (1 + one per `path` change; restarts not counted).
    pub spawns: u64,
    /// Slots imported in the latched frame's ring (3 once a re-export's old ones went).
    pub slots: usize,
}

pub struct SceneSource {
    keep: GlKeepAlive,
    opts: SceneOpts,
    host: Option<WorkerHost>,
    /// Our own epoll fd over the current host's wake fd: stable across spawns and path
    /// changes (what `SourceHost` registers).
    wake: OwnedFd,
    rings: Vec<ImportedRing>,
    latch: Latch,
    modifiers: Vec<(u32, Vec<(u64, bool)>)>,
    tick_period: Duration,
    next_tick: Option<Instant>,
    seq: u64,
    inflight: u64,
    clock: SceneClock,
    paused: bool,
    /// The current load has shown its first frame (`Ready` sent).
    loaded: bool,
    /// The current load got its first tick (a paused scene gets exactly one).
    load_ticked: bool,
    /// A `position` set while paused: one tick at the new time is due…
    exact_pending: bool,
    /// …and frames up to this tick may latch while paused.
    exact_seq: Option<u64>,
    /// Stepped: the scene time the current step wants, and the tick sent for it.
    step_target: Option<f64>,
    step_seq: Option<u64>,
    worker_ready: bool,
    native: Option<[u32; 2]>,
    size: Option<(u32, u32)>,
    format: Option<(u32, u64)>,
    /// The latest `Buffer` set (generation, w, h, slot ids): after a re-export, the older
    /// slots of that generation go once one of these latched.
    latest_set: Option<(u32, u32, u32, Vec<u8>)>,
    has_audio: Option<bool>,
    /// Report `AudioFlowing` once known (an un-pause, a load that plays).
    flow_armed: bool,
    error: Option<String>,
    broken: Option<String>,
    sync: Option<String>,
    stats: SceneStats,
    props: BTreeMap<String, PropValue>,
    events: Vec<SourceEvent>,
    last_position: Option<Instant>,
    /// Ticks sent, by seq (≤ 64 kept), for the tick → latch latency.
    sent_at: VecDeque<(u64, Instant)>,
    /// The last 1024 tick → latch latencies (ms).
    latency_ms: VecDeque<f32>,
    /// Latch instants of the last second (`fps_actual`).
    latch_times: VecDeque<Instant>,
    /// Task 7: the scene reacts to audio (`Ready.wants_audio_input`) — the runtime feeds it.
    wants_audio_input: bool,
    /// The visualiser samples for the next tick (the runtime's latest system-audio frame).
    pending_input: Option<Vec<u8>>,
    /// RMS (dBFS) of the last input sent (`workers` probe `input_dbfs`).
    input_dbfs: Option<f64>,
    /// The pointer over the scene in native pixels + buttons (re-sent after a restart).
    pointer: Option<(f64, f64, u32)>,
    /// `PropertySet` outcomes: name → (ok, reason) (`workers` probe `properties`).
    prop_results: BTreeMap<String, (bool, Option<String>)>,
    /// Task 6: the source's `gain.*` slots; their sum goes to the worker's stream as `Gain`.
    gains: Gains,
    /// The last `Gain` sent (a change resends; a restart's `Ready` resends).
    gain_sent: Option<f64>,
    no_audio: bool,
    /// The worker said its stream carries the scene's sound again since `flow_armed`.
    flow_seen: bool,
    /// `AudioFlowing` messages from the worker (probe).
    flows: u64,
    /// The worker's envelope (pre-gain 1 ms dBFS) on the log clock, for the runtime's
    /// dropout reference ([`take_envelope`](Self::take_envelope)).
    envelope: VecDeque<(Duration, f32)>,
    /// The newest envelope block (probe) and how many arrived.
    envelope_last: Option<f32>,
    envelope_blocks: u64,
    /// Task 8: the rate the outputs ask for (`demand_of`); `opts.tick_hz` is what the scene
    /// ticks at = `min(demand, the GPU budget's cap)`.
    demand_hz: f64,
    /// Task 8: the worker GPU budget (`scene::budget`).
    budget: Budget,
    /// Since when the scene is throttled (probe).
    throttled_since: Option<Instant>,
    /// Since when the scene runs at its current rate, unpaused and loaded (its own frame
    /// deficit only counts once a whole budget window was made at it).
    rate_since: Option<Instant>,
    /// The worker's `Frame.gpu_ms` of the last [`BUDGET_WINDOW`].
    gpu_ms: VecDeque<(Instant, f32)>,
    /// Task 8 (VRAM guard): the worker was stopped for using more VRAM than the per-scene
    /// limit — `(used_mib, limit_mib)`; reported like an error, never a crash.
    vram_stopped: Option<(f64, f64)>,
    /// Task 10: the worker died with a frame on screen — the scene clock is stopped at that
    /// frame's `t` until a frame of a later worker generation (`> held`) latched: the restart
    /// resumes exactly where the picture froze. `Some(held generation)`.
    resuming: Option<u32>,
    /// The resume's one tick (at the held `t`) is out.
    resume_ticked: bool,
    /// A `position` set since the last latch: a restart resumes at the clock (the requested
    /// time), not at the held frame.
    clock_jumped: bool,
    /// Task 10: the `preview` image (an internal paused image `MpvSource`), shown by
    /// [`texture`](Self::texture) while no worker frame exists — opened when a worker dies
    /// before the first frame and for a scene restored broken; retired at the first frame.
    preview: Option<MpvSource>,
    /// A retired preview finishing its two-phase teardown (never a blocking free).
    preview_dying: Option<MpvSource>,
    /// The preview should show (a worker died with no frame on screen).
    preview_wanted: bool,
    /// The preview can't show (none set, or its open/load failed) — never retried.
    preview_error: Option<String>,
    /// Restored from a snapshot already broken: no worker is ever spawned (until `path`).
    restored_broken: bool,
    /// `ContextLost` reports (the worker's GL context was lost → a crash restart).
    context_losses: u32,
    /// Scene loudness learned on first play (`audio::loudness`): the worker's segments of the
    /// current path go into that path's measurement in the shared [`Book`] (kept across worker
    /// restarts and across sources of the same path — a reopen or a transition A → A'
    /// continues it).
    loudness: SharedBook,
    /// The path this source joined in `loudness` (`None` once it left: ended).
    loudness_key: Option<String>,
    /// The worker meters (its last `Start.loudness` / `LoudnessMeter`).
    meter_on: bool,
    /// When `update` last asked the book whether a meter that is off should be on again.
    meter_checked: Instant,
    /// Loudness segments the worker sent (every one, measured or not): the cap's meter-off shows
    /// as this standing still (the `workers` probe `loudness.received`).
    loudness_received: u64,
}

/// The hang-timeout knob (Task 10): a `Tick`/`Ping` unanswered this many ms = hung (tests
/// set 300; production leaves it unset = [`HANG_TIMEOUT`], 2 s).
pub const HANG_ENV: &str = "LIASCAPE_SCENE_WORKER_HANG_MS";

/// The hang timeout for the value of [`HANG_ENV`]: a positive whole number of ms, else
/// [`HANG_TIMEOUT`].
pub fn hang_timeout(v: Option<&str>) -> Duration {
    v.and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map_or(HANG_TIMEOUT, Duration::from_millis)
}

/// How often a source whose meter is off asks the book whether it should meter again.
const METER_RECHECK: Duration = Duration::from_millis(250);

/// A scene folder's key in the loudness [`Book`]: canonical where it resolves, else as given.
pub fn loudness_key(path: &std::path::Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// The shared loudness book (a panic elsewhere never poisons it for good: its state is plain
/// counts).
fn lock_book(b: &SharedBook) -> std::sync::MutexGuard<'_, Book> {
    b.lock().unwrap_or_else(|e| e.into_inner())
}

/// A source dropped without its teardown (tests) still leaves its path's measurement — else it
/// would stay the measuring one and the next source of the path would never measure.
impl Drop for SceneSource {
    fn drop(&mut self) {
        self.end_loudness();
    }
}

fn epoll_new() -> Result<OwnedFd, String> {
    let fd = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
    if fd < 0 {
        return Err(format!("epoll: {}", std::io::Error::last_os_error()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn epoll_ctl(ep: &OwnedFd, op: i32, fd: RawFd) {
    epoll_ctl_ev(ep, op, fd, libc::EPOLLIN as u32);
}

fn epoll_ctl_ev(ep: &OwnedFd, op: i32, fd: RawFd, events: u32) {
    let mut ev = libc::epoll_event {
        events,
        u64: fd as u64,
    };
    unsafe { libc::epoll_ctl(ep.as_raw_fd(), op, fd, &mut ev) };
}

/// Consume what `ep` reports (never blocks): a one-shot fence entry that fired is disarmed,
/// so a signalled fence wakes the loop once, never in a busy loop.
fn epoll_drain(ep: &OwnedFd) {
    let mut evs = [libc::epoll_event { events: 0, u64: 0 }; 16];
    unsafe { libc::epoll_wait(ep.as_raw_fd(), evs.as_mut_ptr(), evs.len() as i32, 0) };
}

impl SceneSource {
    /// Open the scene of graph node `id` (`kind: scene`) from its props (`path`,
    /// `position`, `paused` — the effective one —, `speed`, the rest stored) and `base`
    /// (`SourceHost`'s base opts: `scene_worker` (the binary; else
    /// [`crate::paths::scene_worker_bin`]), `allow_synthetic` (a folder with
    /// `liascape-synthetic.json` plays the synthetic renderer, D7 — tests only), `scene_assets`,
    /// `scene_crash_dir`, `ao`/`audio_device` (the route), `stepped`). The worker is
    /// spawned at the first [`set_demand`](Self::set_demand) naming an output.
    pub fn open(
        gfx: &Gfx,
        id: &str,
        node: &[(String, PropValue)],
        base: &Map<String, Value>,
        book: &SharedBook,
    ) -> Result<SceneSource, ApiError> {
        let get = |k: &str| node.iter().find(|(n, _)| n == k).map(|(_, v)| v);
        let s = |k: &str| match get(k) {
            Some(PropValue::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let f = |k: &str, d: f64| match get(k) {
            Some(v) => super::num(v),
            None => d,
        };
        let bs = |k: &str| base.get(k).and_then(Value::as_str).map(str::to_string);
        let bb = |k: &str| base.get(k).and_then(Value::as_bool).unwrap_or(false);
        let bin = bs("scene_worker")
            .map(PathBuf::from)
            .or_else(crate::paths::scene_worker_bin)
            .ok_or_else(|| {
                unsupported(
                    "scenes need liascape-scene-worker: none found (LIASCAPE_SCENE_WORKER_BIN, next to \
                     liascape-player, PATH)",
                )
            })?;
        let path = s("path");
        let allow_synthetic = bb("allow_synthetic");
        let mut o = SceneOpts::new(&path, bin);
        o.id = id.to_string();
        o.synthetic = allow_synthetic && Path::new(&path).join("liascape-synthetic.json").is_file();
        if allow_synthetic {
            o.env
                .push(("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES".into(), "1".into()));
        }
        o.position = f("position", 0.0);
        o.paused = matches!(get("paused"), Some(PropValue::Bool(true)));
        o.speed = f("speed", 1.0);
        o.stepped = bb("stepped");
        o.assets_dir = bs("scene_assets").filter(|a| !a.is_empty());
        // Task 7 (Review Focus #2): no WE assets → a real scene can't build (a 1×1 render
        // loop otherwise): refuse it here, naming how to point the player at them.
        if !o.synthetic && o.assets_dir.is_none() {
            return Err(unsupported(format!(
                "can't play scene {path}: {}",
                bs("scene_assets_error").unwrap_or_else(|| crate::scene::assets::HINT.into())
            )));
        }
        o.steam_dir = crate::scene::assets::steam_root_of_item(Path::new(&path))
            .map(|p| p.to_string_lossy().into_owned());
        if let Some(PropValue::Map(m)) = get("scene_props") {
            o.properties = m.clone();
        }
        if let Some(d) = bs("scene_crash_dir") {
            o.crash_dir = PathBuf::from(d);
        }
        o.audio = match (bs("ao").as_deref(), bs("audio_device")) {
            (Some("null"), _) => AudioRoute::Null,
            (_, Some(d)) => AudioRoute::Device(d),
            _ => AudioRoute::Default,
        };
        o.defer_spawn = true;
        o.hang_timeout = hang_timeout(std::env::var(HANG_ENV).ok().as_deref());
        o.loudness_window_s = loudness::window_s(std::env::var(loudness::WINDOW_ENV).ok().as_deref());
        o.loudness_cap_s = loudness::cap_s(std::env::var(loudness::CAP_ENV).ok().as_deref());
        if let Some(PropValue::Map(m)) = get("loudness_seed")
            && !m.is_empty()
        {
            o.loudness_seed = Some(Value::Object(m.clone()));
        }
        o.loudness_book = Some(book.clone());
        o.preview = s("preview");
        let mut src = SceneSource::open_opts(gfx, o).map_err(super::io_error)?;
        // Task 10: a scene the snapshot saved broken (past its restart budget before the
        // player restarted) comes back as its preview with no worker — never a fresh crash
        // loop on every player restart. A `path` change plays again.
        if matches!(get("broken"), Some(PropValue::Bool(true))) {
            src.restored_broken = true;
            src.broken =
                Some("broken before the player restarted (restored as its preview)".into());
            src.preview_wanted = true;
            src.ensure_preview(gfx);
            log::event(
                "scene",
                Level::Warn,
                "scene.restored_broken",
                None,
                json!({"id": id, "path": path, "preview": src.opts.preview}),
            );
        }
        // Task 6: the stream starts at the node's gain and mute (the worker is spawned later,
        // at the first demand, with them in its `Start`).
        for (k, v) in node {
            if let Some(slot) = k
                .strip_prefix("gain.")
                .and_then(|s| s.parse::<GainSlot>().ok())
            {
                src.gains.set(slot, super::num(v));
            }
        }
        src.no_audio = matches!(get("no_audio"), Some(PropValue::Bool(true)));
        for (k, v) in node {
            if k.starts_with("gain.")
                || props::schema_for(NodeKind::Source, k).is_some_and(|d| !d.readonly)
            {
                src.props.insert(k.clone(), v.clone());
            }
        }
        src.props
            .insert("kind".into(), PropValue::Str("scene".into()));
        src.props
            .insert("paused".into(), PropValue::Bool(src.paused));
        Ok(src)
    }

    /// Open from explicit opts. `Err` = this display can't import dmabufs or make native
    /// fences (both required — no CPU-copy path is built), or the worker can't be spawned.
    /// Spawn from a long-lived thread (the loop): the worker's `PR_SET_PDEATHSIG` follows
    /// the spawning thread.
    pub fn open_opts(gfx: &Gfx, opts: SceneOpts) -> Result<SceneSource, String> {
        for ext in [
            "EGL_EXT_image_dma_buf_import",
            "EGL_EXT_image_dma_buf_import_modifiers",
            "EGL_ANDROID_native_fence_sync",
            "EGL_KHR_wait_sync",
        ] {
            if !gfx.has_display_ext(ext) {
                return Err(format!(
                    "scenes need {ext} on the compositor's EGL display (docs/player/spikes/dmabuf.md §1)"
                ));
            }
        }
        let mut src = SceneSource {
            keep: gfx.keep_alive(),
            host: None,
            wake: epoll_new()?,
            rings: vec![ImportedRing::new(0)],
            latch: Latch::new(),
            modifiers: Vec::new(),
            tick_period: Duration::from_secs_f64(1.0 / opts.tick_hz.clamp(1.0, 1000.0)),
            next_tick: None,
            seq: 0,
            inflight: 0,
            clock: SceneClock::new(opts.position, opts.speed),
            paused: opts.paused,
            loaded: false,
            load_ticked: false,
            exact_pending: false,
            exact_seq: None,
            step_target: None,
            step_seq: None,
            worker_ready: false,
            native: None,
            size: None,
            format: None,
            latest_set: None,
            has_audio: None,
            flow_armed: !opts.paused,
            error: None,
            broken: None,
            sync: None,
            stats: SceneStats::default(),
            props: BTreeMap::new(),
            events: Vec::new(),
            last_position: None,
            sent_at: VecDeque::new(),
            latency_ms: VecDeque::new(),
            latch_times: VecDeque::new(),
            wants_audio_input: false,
            pending_input: None,
            input_dbfs: None,
            pointer: None,
            prop_results: BTreeMap::new(),
            gains: Gains::new(),
            gain_sent: None,
            no_audio: false,
            flow_seen: false,
            flows: 0,
            envelope: VecDeque::new(),
            envelope_last: None,
            envelope_blocks: 0,
            demand_hz: opts.tick_hz,
            budget: Budget::new(opts.tick_hz),
            throttled_since: None,
            rate_since: None,
            gpu_ms: VecDeque::new(),
            vram_stopped: None,
            resuming: None,
            resume_ticked: false,
            clock_jumped: false,
            preview: None,
            preview_dying: None,
            preview_wanted: false,
            preview_error: None,
            restored_broken: false,
            context_losses: 0,
            loudness: opts.loudness_book.clone().unwrap_or_else(Book::shared),
            loudness_key: None,
            meter_on: true,
            meter_checked: Instant::now(),
            loudness_received: 0,
            opts,
        };
        src.join_loudness();
        if !src.opts.defer_spawn {
            src.spawn()?;
        }
        Ok(src)
    }

    fn spawn(&mut self) -> Result<(), String> {
        let start = ToWorker::Start {
            path: self.opts.path.to_string_lossy().into_owned(),
            assets_dir: self.opts.assets_dir.clone(),
            steam_dir: self.opts.steam_dir.clone(),
            position: self.clock.now(Instant::now()),
            // The worker's `paused` = play no audio: a stepped clock never plays any.
            paused: self.paused || self.opts.stepped,
            audio: self.opts.audio.clone(),
            max_size: self.opts.max_size,
            synthetic: self.opts.synthetic,
            properties: self.opts.properties.clone(),
            id: self.opts.id.clone(),
            gain_db: self.gains.effective_db(),
            no_audio: self.no_audio,
            speed: if self.opts.stepped {
                1.0
            } else {
                self.clock.speed()
            },
            // A measurement already at its cap: nothing to meter.
            loudness: !self.loudness_capped(),
        };
        self.meter_on = !self.loudness_capped();
        self.gain_sent = Some(self.gains.effective_db());
        let mut spec = WorkerSpec::new(self.opts.id.clone(), self.opts.worker_bin.clone(), start);
        spec.env = self.opts.env.clone();
        spec.budget = self.opts.budget;
        spec.hang_timeout = self.opts.hang_timeout;
        spec.crash_dir = self.opts.crash_dir.clone();
        let host = WorkerHost::spawn(spec).map_err(|e| format!("scene worker: {e}"))?;
        epoll_ctl(&self.wake, libc::EPOLL_CTL_ADD, host.wake_fd());
        self.host = Some(host);
        self.stats.spawns += 1;
        Ok(())
    }

    /// The scene clock runs once the load's first frame (at `position`) is shown, while not
    /// paused and not stepped — like a video's `time_pos`, nothing passes while it loads.
    fn clock_should_run(&self) -> bool {
        self.loaded && !self.paused && !self.opts.stepped && self.resuming.is_none()
    }

    /// The outputs showing this scene now (`SourceHost::sync`, every iteration): the ring is
    /// exported at the cover size of the largest (a change → `Resize`; the worker re-exports
    /// and the old frame stays until the first new one latched), ticks at the highest
    /// [`eff_fps`]. The first call naming an output spawns the worker. No output (all
    /// unplugged — parked) changes nothing.
    pub fn set_demand(&mut self, outs: &[OutputDemand]) {
        let Some((max, hz)) = demand_of(outs) else {
            return;
        };
        let hz = hz.clamp(1.0, 1000.0);
        if (hz - self.demand_hz).abs() > 1e-9 {
            let from = self.opts.tick_hz;
            self.demand_hz = hz;
            if self.budget.set_demand(hz) {
                self.unthrottled(from, hz, "demand");
            }
        }
        self.apply_rate();
        if max != self.opts.max_size {
            self.opts.max_size = max;
            if let Some(h) = self.host.as_mut() {
                let _ = h.send(&ToWorker::Resize { max_size: max }, &[]);
                self.stats.resizes += 1;
            }
        }
        if self.host.is_none()
            && self.error.is_none()
            && self.broken.is_none()
            && let Err(e) = self.spawn()
        {
            self.fail(e);
        }
    }

    /// The tick rate = `min(demand, the budget's cap)` (Task 8), live: the next tick is
    /// scheduled on the new period.
    fn apply_rate(&mut self) {
        let hz = self.budget.rate().clamp(1.0, 1000.0);
        if (hz - self.opts.tick_hz).abs() > 1e-9 {
            self.opts.tick_hz = hz;
            self.tick_period = Duration::from_secs_f64(1.0 / hz);
            self.rate_since = self.rate_since.map(|_| Instant::now());
        }
    }

    /// Task 8 (the VRAM guard): the worker used `used_mib` > `limit_mib` of VRAM — stop it.
    /// Reported like a broken scene (`SourceEvent::Error` "stopped: used X MiB > limit Y MiB",
    /// so a rotation advances / a single wallpaper keeps its last frame) plus
    /// `scene.vram_exceeded`, but never a crash: no restart, no crash record, nothing marks it
    /// crashed. The last frame stays shown; a `path` change starts a new worker.
    pub fn stop_for_vram(&mut self, used_mib: f64, limit_mib: f64) {
        if self.vram_stopped.is_some() || self.host.is_none() {
            return;
        }
        log::event(
            "scene",
            Level::Warn,
            "scene.vram_exceeded",
            None,
            json!({"id": self.opts.id, "path": self.opts.path, "pid": self.pid(),
                   "used_mib": used_mib, "limit_mib": limit_mib}),
        );
        if let Some(h) = self.host.as_mut() {
            h.stop();
        }
        self.release_ring_but_shown();
        self.vram_stopped = Some((used_mib, limit_mib));
        let reason = format!(
            "stopped: used {used_mib:.0} MiB > limit {limit_mib:.0} MiB of VRAM (vram_exceeded)"
        );
        if self.error.is_none() {
            self.events.push(SourceEvent::Error {
                reason: format!("{}: {reason}", self.opts.path.display()),
            });
            self.error = Some(reason);
        }
    }

    /// The worker is gone for good (a VRAM stop): every imported slot but the one on screen is
    /// dropped — a dmabuf lives while anyone holds it, so the stopped worker's ring (~3 × the
    /// export size of GPU memory) stayed alive through our imports. Frames still queued from
    /// it are forgotten (one of a dropped slot must never latch: it has no texture any more);
    /// the shown frame stays, never released (`Latch::forget_worker`). A `path` change brings
    /// a new worker whose first latched frame drops this last slot too.
    fn release_ring_but_shown(&mut self) {
        self.latch.forget_worker();
        match self.latch.current() {
            Some((slot, _, _, generation)) => {
                self.rings.retain(|r| r.generation == generation);
                for r in &mut self.rings {
                    r.retain_slots(&[slot]);
                }
            }
            None => self.rings.clear(), // nothing shown (the preview, or nothing)
        }
        self.latest_set = None;
    }

    /// The VRAM guard stopped this scene: `(used_mib, limit_mib)`.
    pub fn vram_stopped(&self) -> Option<(f64, f64)> {
        self.vram_stopped
    }

    /// Task 8: one GPU-budget observation (the runtime, every `budget::OBSERVE_EVERY`):
    /// `missed_pct` = the worst miss rate of the outputs showing this scene over the last 2 s,
    /// `now` the caller's monotonic time (tests pass a virtual one). `auto` off (`player.
    /// scene_throttle` false) lifts any cap at once — fixed fps. Skipped while the scene can't
    /// render (paused, stepped, not loaded, stopped): its numbers say nothing then.
    pub fn observe_budget(&mut self, now: Duration, missed_pct: f64, auto: bool) {
        let from = self.opts.tick_hz;
        if !auto {
            if self.budget.cap().is_some() {
                self.budget.lift();
                self.apply_rate();
                self.unthrottled(from, self.opts.tick_hz, "off");
            }
            return;
        }
        if self.paused
            || self.opts.stepped
            || !self.loaded
            || self.host.is_none()
            || self.error.is_some()
            || self.broken.is_some()
            || self.resuming.is_some()
        {
            return;
        }
        let inst = Instant::now();
        let (p50, _) = self.gpu_ms_stats(inst);
        let fps = self.fps_over(inst, BUDGET_WINDOW);
        // The scene's own missed frames count too: a worker delivering under 90 % of its rate
        // over a whole window at that rate (on an output presenting below its refresh — a
        // 30 fps scene on 144 Hz — the output has no back-to-back presents to miss).
        let deficit = match self.rate_since {
            Some(t)
                if inst.saturating_duration_since(t) >= BUDGET_WINDOW
                    && fps < DEFICIT_RATIO * self.opts.tick_hz =>
            {
                (1.0 - fps / self.opts.tick_hz) * 100.0
            }
            _ => 0.0,
        };
        let missed_pct = missed_pct.max(deficit);
        if self
            .budget
            .observe(now, missed_pct, p50.unwrap_or(0.0), fps)
            .is_none()
        {
            return;
        }
        self.apply_rate();
        let to = self.opts.tick_hz;
        if to < from {
            log::event(
                "scene",
                Level::Warn,
                "scene.throttled",
                None,
                json!({"id": self.opts.id, "fps_from": from, "fps_to": to,
                       "demand": self.demand_hz, "gpu_ms": p50, "fps_actual": fps,
                       "missed_pct": missed_pct}),
            );
            self.throttled_since.get_or_insert(inst);
        } else if self.budget.cap().is_none() {
            self.unthrottled(from, to, "recovered");
        } else {
            log::event(
                "scene",
                Level::Info,
                "scene.throttle_eased",
                None,
                json!({"id": self.opts.id, "fps_from": from, "fps_to": to,
                       "demand": self.demand_hz, "missed_pct": missed_pct}),
            );
        }
    }

    /// `scene.unthrottled {id, fps_from, fps_to, reason}`: `recovered` (calm steps reached the
    /// demand), `off` (the setting), `demand` (the outputs now ask for no more than the cap).
    fn unthrottled(&mut self, from: f64, to: f64, reason: &str) {
        self.throttled_since = None;
        log::event(
            "scene",
            Level::Info,
            "scene.unthrottled",
            None,
            json!({"id": self.opts.id, "fps_from": from, "fps_to": to, "reason": reason}),
        );
    }

    /// Median and 95th percentile of the worker's GPU time per frame over the last 2 s.
    fn gpu_ms_stats(&self, now: Instant) -> (Option<f64>, Option<f64>) {
        let mut v: Vec<f64> = self
            .gpu_ms
            .iter()
            .filter(|(t, _)| now.saturating_duration_since(*t) <= BUDGET_WINDOW)
            .map(|(_, ms)| *ms as f64)
            .collect();
        if v.is_empty() {
            return (None, None);
        }
        v.sort_by(f64::total_cmp);
        let n = v.len();
        let rank = |p: f64| v[((p * n as f64).ceil() as usize).clamp(1, n) - 1];
        (Some(rank(0.5)), Some(rank(0.95)))
    }

    /// Frames latched per second over the last `window`.
    fn fps_over(&self, now: Instant, window: Duration) -> f64 {
        let n = self
            .latch_times
            .iter()
            .filter(|t| now.saturating_duration_since(**t) <= window)
            .count();
        n as f64 / window.as_secs_f64()
    }

    /// Whether the scene clock runs (loaded, not paused, not stepped, not holding a crashed
    /// worker's frame) — i.e. new frames keep coming at `tick_hz`.
    pub fn clock_running(&self) -> bool {
        self.clock_should_run()
    }

    /// The rate the outputs ask for (before the GPU budget's cap).
    pub fn demand_hz(&self) -> f64 {
        self.demand_hz
    }

    /// The GPU budget's cap (`None` = unthrottled).
    pub fn throttle_cap(&self) -> Option<f64> {
        self.budget.cap()
    }

    /// Median / p95 GPU time per frame over the last 2 s (the worker's `GL_TIME_ELAPSED`).
    pub fn gpu_ms(&self) -> (Option<f64>, Option<f64>) {
        self.gpu_ms_stats(Instant::now())
    }

    /// Stepped mode: show exactly scene time `t` (one tick, unless that frame is shown or
    /// asked for already). [`step_status`](Self::step_status) says when it latched.
    pub fn step_to(&mut self, t: f64) {
        if self.step_target == Some(t) {
            return;
        }
        self.step_target = Some(t);
        self.step_seq = None;
        self.clock.jump(t, Instant::now());
    }

    pub fn step_status(&self) -> StepStatus {
        if let Some(e) = self.error.as_ref().or(self.broken.as_ref()) {
            // A broken scene's preview is still coming (a step's capture shows it).
            if self.broken.is_some() && self.preview_pending() {
                return StepStatus::Pending("preview");
            }
            return StepStatus::Broken(e.clone());
        }
        if !self.worker_ready {
            return StepStatus::Pending("ready");
        }
        // By the tick's seq, never by comparing `t`: it crosses JSON twice (serde_json's
        // default float parsing may land one ulp off).
        match (self.step_target, self.step_seq, self.latch.current()) {
            (Some(_), Some(s), Some((_, seq, _, g)))
                if seq >= s && g == self.latch.generation() && self.loaded =>
            {
                StepStatus::Done
            }
            (None, _, _) if self.loaded => StepStatus::Done,
            _ => StepStatus::Pending("frame"),
        }
    }

    /// The current load has shown its first frame.
    pub fn is_ready(&self) -> bool {
        self.loaded
    }

    fn latch_allowed(&self) -> bool {
        self.opts.stepped || !self.paused || !self.loaded || self.exact_seq.is_some()
    }

    fn on_event(&mut self, gfx: &Gfx, now: Instant, ev: WorkerEvent) {
        match ev {
            WorkerEvent::Msg(m, fds) => self.on_message(gfx, now, m, fds),
            WorkerEvent::Restarted { attempt } => {
                self.stats.restarts += 1;
                self.latch.forget_worker();
                self.worker_ready = false;
                self.inflight = 0;
                self.step_seq = None;
                if !self.loaded {
                    self.load_ticked = false; // the first frame's tick died with it
                }
                if self.exact_seq.is_some() {
                    self.exact_seq = None;
                    self.exact_pending = true;
                }
                // The held frame is final now (queued ones were dropped): resume at its `t`.
                if let Some(t) = self.hold_for_restart(now) {
                    if let Some(h) = self.host.as_mut() {
                        h.set_resume_position(t);
                    }
                    log::event(
                        "scene",
                        Level::Info,
                        "scene.resuming",
                        None,
                        json!({"id": self.opts.id, "t": t, "attempt": attempt}),
                    );
                }
                self.want_preview_if_blank();
            }
            WorkerEvent::Broken { record } => {
                self.want_preview_if_blank();
                let reason = format!("scene worker broken (crash record {})", record.display());
                if self.broken.is_none() {
                    // The source is broken until its path changes. `source.broken` (Phase 2 Task 11,
                    // the event half of Task 10): the backend marks the item crashed from it.
                    self.log_broken(&record);
                    self.events.push(SourceEvent::Error {
                        reason: reason.clone(),
                    });
                }
                self.broken = Some(reason);
            }
            // The picture froze with the worker: so does the scene clock (a restart resumes
            // there); nothing on screen → the preview.
            WorkerEvent::Exited { .. } | WorkerEvent::Hung { .. } => {
                self.hold_for_restart(now);
                self.want_preview_if_blank();
            }
        }
    }

    /// Task 10: the worker is gone with a frame on screen — stop the scene clock at that
    /// frame's `t` (or at the clock, after a `position` set the frame didn't show yet) until a
    /// later generation's frame latched ([`on_latched`](Self::on_latched)). Idempotent (an
    /// old frame latching between a hang and the reap moves the held `t`; the `Restarted`
    /// call takes the final one). `None` = nothing to hold (no frame yet — the load logic
    /// re-ticks the start —, or stepped: the step re-sends its own tick).
    fn hold_for_restart(&mut self, now: Instant) -> Option<f64> {
        if !self.loaded || self.opts.stepped {
            return None;
        }
        let t = match (self.clock_jumped, self.latched_t()) {
            (false, Some(t)) => t,
            _ => self.clock.now(now),
        };
        self.clock.set_running(false, now);
        self.clock.jump(t, now);
        let held = self.latch.current().map_or(0, |c| c.3);
        if self.resuming.is_none_or(|g| g < held) {
            self.resuming = Some(held);
        }
        self.resume_ticked = false;
        Some(t)
    }

    /// A worker died and nothing is on screen: the preview should show.
    fn want_preview_if_blank(&mut self) {
        if self.latch.current().is_none() {
            self.preview_wanted = true;
        }
    }

    /// The preview should show but isn't on screen yet (and can still come).
    fn preview_pending(&self) -> bool {
        self.preview_wanted
            && self.latch.current().is_none()
            && self.preview_error.is_none()
            && !self.opts.preview.is_empty()
            && self.preview.as_ref().is_none_or(|p| p.texture().is_none())
    }

    /// Open the preview image (once): a paused, silent image `MpvSource` on this context —
    /// synchronous on the loop (an mpv core + render context + first render, ~10–30 ms), so
    /// only on the crash paths (a worker died before the first frame, a restored broken
    /// scene), never for a normal load.
    fn ensure_preview(&mut self, gfx: &Gfx) {
        if !self.preview_wanted
            || self.preview.is_some()
            || self.preview_error.is_some()
            || self.latch.current().is_some()
        {
            return;
        }
        if self.opts.preview.is_empty() {
            self.preview_error = Some("no preview set".into());
            return;
        }
        let mut o = Map::new();
        o.insert("ao".into(), json!("null"));
        o.insert("kind".into(), json!("image"));
        o.insert("paused".into(), json!(true));
        o.insert("no_audio".into(), json!(true));
        let t = Instant::now();
        match MpvSource::open(gfx, &self.opts.preview, &o) {
            Ok(p) => {
                epoll_ctl(&self.wake, libc::EPOLL_CTL_ADD, p.wake_fd());
                log::event(
                    "scene",
                    Level::Info,
                    "scene.preview",
                    None,
                    json!({"id": self.opts.id, "preview": self.opts.preview,
                           "open_ms": t.elapsed().as_secs_f64() * 1e3}),
                );
                self.preview = Some(p);
            }
            Err(e) => self.preview_failed(e.to_string()),
        }
    }

    fn preview_failed(&mut self, reason: String) {
        log::event(
            "scene",
            Level::Warn,
            "scene.preview_failed",
            None,
            json!({"id": self.opts.id, "preview": self.opts.preview, "reason": reason}),
        );
        self.preview_error = Some(reason);
    }

    /// The preview's per-update work: open it when wanted, render it, retire it once a worker
    /// frame is on screen, finish a retired one's teardown. Whether the shown texture changed.
    fn update_preview(&mut self, gfx: &Gfx) -> bool {
        let mut changed = false;
        if self.preview_wanted {
            self.ensure_preview(gfx);
        }
        if let Some(p) = self.preview.as_mut() {
            if p.update(gfx) && self.latch.current().is_none() {
                changed = true;
            }
            let mut failed = None;
            for ev in p.poll_events() {
                if let SourceEvent::Error { reason } = ev {
                    failed = Some(reason);
                }
            }
            if let Some(r) = failed {
                self.preview_failed(r);
            }
        }
        if self.latch.current().is_some() {
            self.preview_wanted = false;
            self.retire_preview();
        }
        if self.preview_dying.as_mut().is_some_and(|p| p.teardown_ready()) {
            self.preview_dying = None;
        }
        changed
    }

    /// Start the preview's two-phase teardown (a worker frame replaced it, or the source goes).
    fn retire_preview(&mut self) {
        let Some(mut p) = self.preview.take() else {
            return;
        };
        epoll_ctl(&self.wake, libc::EPOLL_CTL_DEL, p.wake_fd());
        if !p.begin_teardown() {
            // At most one dies at a time (a preview only ever opens before a first frame).
            self.preview_dying = Some(p);
        }
    }

    fn on_message(&mut self, gfx: &Gfx, now: Instant, m: FromWorker, fds: Vec<OwnedFd>) {
        match m {
            FromWorker::Hello { sync, .. } => self.sync = Some(sync),
            FromWorker::Buffer {
                slot,
                w,
                h,
                fourcc,
                modifier,
                planes,
            } => {
                let generation = self.latch.generation();
                if !self.rings.iter().any(|r| r.generation == generation) {
                    self.rings.push(ImportedRing::new(generation));
                }
                match &mut self.latest_set {
                    Some((g, lw, lh, slots)) if *g == generation && (*lw, *lh) == (w, h) => {
                        slots.push(slot)
                    }
                    _ => {
                        self.latest_set = Some((generation, w, h, vec![slot]));
                        self.stats.buffer_sets += 1;
                    }
                }
                let table = self.modifier_table(gfx, fourcc);
                let desc = DmabufDesc {
                    w,
                    h,
                    fourcc,
                    modifier,
                    planes,
                };
                let ring = self
                    .rings
                    .iter_mut()
                    .find(|r| r.generation == generation)
                    .unwrap();
                match ring.import(gfx, slot, &desc, fds, &table) {
                    Ok(()) => {
                        self.size = Some((w, h));
                        self.format = Some((fourcc, modifier));
                    }
                    Err(e) => self.fail(e),
                }
            }
            FromWorker::Frame {
                slot,
                seq,
                t,
                gpu_ms,
            } => {
                self.stats.frames_received += 1;
                if let Some(ms) = gpu_ms.filter(|ms| ms.is_finite() && *ms >= 0.0) {
                    self.gpu_ms.push_back((now, ms));
                }
                while self
                    .gpu_ms
                    .front()
                    .is_some_and(|(at, _)| now.saturating_duration_since(*at) > BUDGET_WINDOW)
                {
                    self.gpu_ms.pop_front();
                }
                self.inflight = self.seq.saturating_sub(seq + 1);
                let acquire = fds.into_iter().next();
                if let Some(f) = &acquire {
                    // Wake the loop when it signals (once): a frame whose fence wasn't ready
                    // at its `Frame` must not wait for the next tick — a stepped loop has none.
                    // Closing the fd (superseded/latched) removes the entry.
                    epoll_ctl_ev(
                        &self.wake,
                        libc::EPOLL_CTL_ADD,
                        f.as_raw_fd(),
                        (libc::EPOLLIN | libc::EPOLLONESHOT) as u32,
                    );
                }
                self.latch.push(slot, seq, t, acquire);
            }
            FromWorker::Ready {
                native,
                has_audio,
                wants_audio_input,
            } => {
                self.native = Some(native);
                self.has_audio = Some(has_audio);
                self.wants_audio_input = wants_audio_input;
                self.worker_ready = true;
                if self.next_tick.is_none() || !self.paused {
                    self.next_tick = Some(now);
                }
                // A (re)started worker gets the pointer it missed.
                if let (Some((x, y, buttons)), Some(h)) = (self.pointer, self.host.as_mut()) {
                    let _ = h.send(&ToWorker::Pointer { x, y, buttons }, &[]);
                }
                // …and the stream's gain (its `Start` carried the folded one; resent in case
                // a push was refused while it wasn't connected).
                self.gain_sent = None;
                self.send_gain();
            }
            FromWorker::HasAudio { on } => self.has_audio = Some(on),
            FromWorker::AudioFlowing => {
                self.flows += 1;
                if self.flow_armed {
                    self.flow_seen = true;
                }
            }
            FromWorker::Envelope { t0_ms, dbfs_1ms } => self.on_envelope(t0_ms, &dbfs_1ms),
            FromWorker::Loudness { segments } => {
                self.loudness_received += segments.len() as u64;
                let reports: Vec<Learned> = match self.loudness_key.as_deref() {
                    Some(key) => {
                        let mut b = lock_book(&self.loudness);
                        segments
                            .into_iter()
                            .filter_map(|seg| b.push(key, &self.opts.id, seg))
                            .collect()
                    }
                    None => Vec::new(),
                };
                for l in reports {
                    self.report_loudness(l);
                }
                // The cap reached (by this source or another of the path): the worker stops
                // metering (folded into a restart's Start).
                if self.meter_on && self.loudness_capped() {
                    self.send_loudness_meter();
                }
            }
            FromWorker::PropertySet { name, ok, reason } => {
                log::event(
                    "scene",
                    if ok { Level::Info } else { Level::Warn },
                    "scene.property",
                    None,
                    json!({"id": self.opts.id, "name": name, "ok": ok, "reason": reason}),
                );
                self.prop_results.insert(name, (ok, reason));
            }
            // Task 10: the worker's GL context is gone (a GPU reset, an NVIDIA video-memory
            // purge after suspend): it can't render again — a crash restart, through the
            // budget, its record naming the cause.
            FromWorker::ContextLost => {
                self.context_losses += 1;
                log::event(
                    "scene",
                    Level::Warn,
                    "scene.context_lost",
                    None,
                    json!({"id": self.opts.id, "path": self.opts.path, "pid": self.pid()}),
                );
                if let Some(h) = self.host.as_mut() {
                    h.kill_for_restart("GL context lost");
                }
            }
            FromWorker::Error { reason, fatal } => {
                if fatal {
                    self.fail(reason);
                    if let Some(h) = self.host.as_mut() {
                        h.stop();
                    }
                } else {
                    log::event(
                        "scene",
                        Level::Warn,
                        "scene.worker_error",
                        None,
                        json!({"id": self.opts.id, "reason": reason}),
                    );
                }
            }
            _ => {}
        }
    }

    /// `source.broken {id, path, scene_id, reason, signal|code, restarts, record,
    /// total_restarts, uptime_ms, shows}` — the fields from the crash record the host just
    /// wrote (a small file; read once, at the break); `shows` (Task 10) = what stays on screen:
    /// `last_frame` | `preview` | `nothing`.
    fn log_broken(&self, record: &std::path::Path) {
        let rec: Value = std::fs::read(record)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        let mut ev = json!({
            "id": self.opts.id,
            "path": self.opts.path,
            "scene_id": rec.get("scene_id").cloned().unwrap_or(Value::Null),
            "reason": rec.get("reason").cloned().unwrap_or(Value::Null),
            "restarts": rec.get("restarts").cloned().unwrap_or(Value::Null),
            "record": record,
        });
        for k in ["signal", "code", "total_restarts", "uptime_ms"] {
            if let Some(v) = rec.get(k) {
                ev[k] = v.clone();
            }
        }
        // Task 10: what the output keeps showing — the last frame, else the preview image.
        ev["shows"] = json!(if self.latch.current().is_some() {
            "last_frame"
        } else if self.opts.preview.is_empty() || self.preview_error.is_some() {
            "nothing"
        } else {
            "preview"
        });
        log::event("source", Level::Error, "source.broken", None, ev);
    }

    fn modifier_table(&mut self, gfx: &Gfx, fourcc: u32) -> Vec<(u64, bool)> {
        if let Some((_, t)) = self.modifiers.iter().find(|(f, _)| *f == fourcc) {
            return t.clone();
        }
        let t = gfx.dmabuf_modifiers(fourcc);
        self.modifiers.push((fourcc, t.clone()));
        t
    }

    fn fail(&mut self, reason: String) {
        log::event(
            "scene",
            Level::Error,
            "scene.error",
            None,
            json!({"id": self.opts.id, "path": self.opts.path, "reason": reason}),
        );
        if self.error.is_none() {
            self.events.push(SourceEvent::Error {
                reason: format!("{}: {reason}", self.opts.path.display()),
            });
            self.error = Some(reason);
        }
    }

    fn send_tick(&mut self, now: Instant, t: f64) -> Option<u64> {
        let host = self.host.as_mut()?;
        let seq = self.seq;
        let input = self.pending_input.take().filter(|_| self.wants_audio_input);
        let dbfs = input.as_deref().map(crate::scene::synthetic::input_dbfs);
        let tick = ToWorker::Tick { seq, t, input };
        match host.send(&tick, &[]) {
            Ok(()) => {
                if dbfs.is_some() {
                    self.input_dbfs = dbfs;
                }
                self.seq += 1;
                self.inflight += 1;
                self.stats.ticks_sent += 1;
                self.load_ticked = true;
                if self.sent_at.len() == 64 {
                    self.sent_at.pop_front();
                }
                self.sent_at.push_back((seq, now));
                Some(seq)
            }
            Err(_) => {
                self.stats.tick_send_failures += 1;
                None
            }
        }
    }

    fn tick(&mut self, now: Instant) {
        if self.host.is_none()
            || !self.worker_ready
            || self.error.is_some()
            || self.broken.is_some()
        {
            return;
        }
        if self.opts.stepped {
            if let Some(t) = self.step_target
                && self.step_seq.is_none()
            {
                self.step_seq = self.send_tick(now, t);
            }
            return;
        }
        if !self.loaded {
            // The load's first frame, at its start time (the clock waits for it): exactly
            // one tick, paused or not.
            if !self.load_ticked {
                let t = self.clock.now(now);
                self.send_tick(now, t);
            }
            return;
        }
        if self.paused {
            let t = self.clock.now(now);
            if self.exact_pending {
                self.exact_seq = self.send_tick(now, t);
                self.exact_pending = self.exact_seq.is_none();
            }
            return;
        }
        if self.resuming.is_some() {
            // Task 10: one tick at the held `t` (the clock is stopped there); the clock runs
            // again once its frame latched.
            if !self.resume_ticked {
                let t = self.clock.now(now);
                self.resume_ticked = self.send_tick(now, t).is_some();
            }
            return;
        }
        if self.inflight >= MAX_INFLIGHT {
            return;
        }
        let Some(next) = self.next_tick else { return };
        if now + TICK_SLACK < next {
            return;
        }
        let t = self.clock.now(now);
        self.send_tick(now, t);
        let mut n = next + self.tick_period;
        if n <= now {
            n = now + self.tick_period; // a whole period behind: skip ahead, never burst
        }
        self.next_tick = Some(n);
    }

    fn change_path(&mut self, path: String) {
        // A new worker on the new folder; the old frame stays shown (foreign: never
        // released) until the new worker's first frame latches. Not a crash.
        if let Some(h) = self.host.take() {
            epoll_ctl(&self.wake, libc::EPOLL_CTL_DEL, h.wake_fd());
            drop(h); // `quit`, reaped off the loop
        }
        self.latch.forget_worker();
        self.end_loudness();
        // The seed was the old folder's measurement: the new one continues what the book has
        // of the new folder, else starts from nothing (the next worker's `Start` meters again).
        self.opts.loudness_seed = None;
        self.opts.path = PathBuf::from(&path);
        self.join_loudness();
        self.opts.synthetic = self
            .opts
            .env
            .iter()
            .any(|(k, v)| k == "LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES" && v == "1")
            && Path::new(&path).join("liascape-synthetic.json").is_file();
        self.opts.steam_dir = crate::scene::assets::steam_root_of_item(Path::new(&path))
            .map(|p| p.to_string_lossy().into_owned());
        self.wants_audio_input = false;
        self.pending_input = None;
        self.input_dbfs = None;
        self.prop_results.clear();
        let now = Instant::now();
        self.clock.set_running(false, now);
        self.clock.jump(0.0, now);
        self.worker_ready = false;
        self.inflight = 0;
        self.loaded = false;
        self.load_ticked = false;
        self.exact_pending = false;
        self.exact_seq = None;
        self.step_seq = None;
        self.native = None;
        self.has_audio = None;
        self.error = None;
        self.broken = None;
        self.vram_stopped = None;
        self.restored_broken = false;
        self.resuming = None;
        self.resume_ticked = false;
        self.clock_jumped = false;
        self.rate_since = None;
        self.gpu_ms.clear();
        self.sync = None;
        self.flow_armed = !self.paused;
        self.flow_seen = false;
        self.next_tick = None;
        if let Err(e) = self.spawn() {
            self.fail(e);
        }
    }

    /// The pointer over this scene (Task 7, mouse on), in the scene's **native pixels** (y
    /// down from the image's top) — the runtime maps an output's `out:<c>.pointer` through the
    /// layer's fit (`scene::pointer`). Kept for a restarted worker.
    pub fn set_pointer(&mut self, x: f64, y: f64, buttons: u32) {
        if self.pointer == Some((x, y, buttons)) {
            return;
        }
        self.pointer = Some((x, y, buttons));
        if self.worker_ready
            && let Some(h) = self.host.as_mut()
        {
            let _ = h.send(&ToWorker::Pointer { x, y, buttons }, &[]);
        }
    }

    /// The last pointer handed to the worker (native pixels + buttons).
    pub fn pointer(&self) -> Option<(f64, f64, u32)> {
        self.pointer
    }

    /// The scene reacts to audio (its `Ready` said so): the runtime feeds it system audio.
    pub fn wants_audio_input(&self) -> bool {
        self.wants_audio_input && self.worker_ready && self.error.is_none()
    }

    /// The visualiser samples (≤ 1024 u8, centre 128) for the next tick (the latest wins).
    pub fn set_input(&mut self, samples: Vec<u8>) {
        self.pending_input = Some(samples);
    }

    /// `scene_props` changed: each new or changed entry goes to the worker (and into the
    /// restart's `Start` — `WorkerHost` folds it); a removed entry keeps its value until the
    /// scene is opened again (LWE has no "reset to default").
    fn set_properties(&mut self, m: &Map<String, Value>) {
        for (k, v) in m {
            if self.opts.properties.get(k) == Some(v) {
                continue;
            }
            self.opts.properties.insert(k.clone(), v.clone());
            let msg = ToWorker::SetProperty {
                name: k.clone(),
                value: v.clone(),
            };
            // Not spawned yet: the first `Start` carries it.
            if let Some(h) = self.host.as_mut() {
                let _ = h.send(&msg, &[]);
            }
        }
        self.opts.properties.retain(|k, _| m.contains_key(k));
    }

    /// The player bus went down (`None`: the default device) or came back: the worker's
    /// stream moves (Task 6 plays it; the route is kept for a restart's `Start`).
    pub fn set_audio_route(&mut self, device: Option<&str>) {
        if matches!(self.opts.audio, AudioRoute::Null) {
            return;
        }
        let route = match device {
            Some(d) => AudioRoute::Device(d.to_string()),
            None => AudioRoute::Default,
        };
        self.opts.audio = route.clone();
        if let Some(h) = self.host.as_mut() {
            let _ = h.send(&ToWorker::Route { audio: route }, &[]);
        }
        // Invariant #8: the rebuilt stream reports when the scene's sound is on it again.
        self.arm_flowing();
    }

    /// Wait for the worker's `AudioFlowing` before reporting `SourceEvent::AudioFlowing`
    /// (an un-pause, `no_audio` off, a route change, a load that plays).
    fn arm_flowing(&mut self) {
        if !self.paused {
            self.flow_armed = true;
            self.flow_seen = false;
        }
    }

    /// Send the effective gain (the sum of the `gain.*` slots) if it changed.
    fn send_gain(&mut self) {
        let db = self.gains.effective_db();
        if self.gain_sent == Some(db) {
            return;
        }
        self.gain_sent = Some(db);
        if let Some(h) = self.host.as_mut() {
            // Not connected: folded into the restart's `Start` (resent at its `Ready`).
            let _ = h.send(&ToWorker::Gain { db }, &[]);
        }
    }

    /// The worker's envelope batch: `t0_ms` on `CLOCK_MONOTONIC` → the log's `t_mono_ms`
    /// clock (the meter's), one entry per 1 ms block.
    fn on_envelope(&mut self, t0_ms: f64, dbfs: &[f32]) {
        self.envelope_blocks += dbfs.len() as u64;
        self.envelope_last = dbfs.last().copied().or(self.envelope_last);
        let Some(log_now) = log::mono_now() else {
            return; // no event log (a harness): nothing to align it with
        };
        let offset_ms = crate::audio::meter::mono_ns() as f64 / 1e6 - log_now.as_secs_f64() * 1e3;
        let t0 = t0_ms - offset_ms;
        for (i, db) in dbfs.iter().enumerate() {
            let t = t0 + i as f64;
            if t >= 0.0 {
                self.envelope
                    .push_back((Duration::from_secs_f64(t / 1e3), *db));
            }
        }
        while self.envelope.len() > ENVELOPE_KEEP {
            self.envelope.pop_front();
        }
    }

    /// `scene.loudness {id, path, lufs, peak_dbfs, seconds, session_s, seed_s, played_s,
    /// complete, capped, window_s, cap_s, state}` — the integration over every play so far
    /// (`seconds` audible, `session_s` of them this source's); the backend stores it in the
    /// item's index (`state` seeds the next play) and normalizes the scene by it.
    fn report_loudness(&self, l: Learned) {
        log::event(
            "scene",
            Level::Info,
            "scene.loudness",
            None,
            json!({"id": self.opts.id, "path": self.opts.path, "lufs": l.lufs,
                   "peak_dbfs": l.peak_dbfs.is_finite().then_some(l.peak_dbfs),
                   "seconds": l.seconds, "session_s": l.session_s,
                   "seed_s": l.seed_s, "played_s": l.played_s,
                   "complete": l.complete, "capped": l.capped,
                   "window_s": l.window_s, "cap_s": l.cap_s,
                   "state": l.state}),
        );
    }

    /// Join the current path's measurement in the book: continue it (a reopen, a second source
    /// of a playing scene) unless the backend's seed covers more (`Book::join`).
    /// The key is the canonical path (`/home` vs its physical path, a trailing slash, a
    /// `local/<id>` symlink: one entry), else the path as given. Without a seed (the backend has
    /// nothing for the item) an idle entry of the path is dropped first (`Book::forget_idle`).
    fn join_loudness(&mut self) {
        let key = loudness_key(&self.opts.path);
        let mut b = lock_book(&self.loudness);
        if self.opts.loudness_seed.is_none() {
            b.forget_idle(&key);
        }
        b.join(&key, &self.opts.id, self.opts.learner());
        drop(b);
        self.loudness_key = Some(key);
    }

    /// `f` of this path's measurement (a fresh one once the source left its path).
    fn with_learner<R>(&self, f: impl FnOnce(&Learner) -> R) -> R {
        let b = lock_book(&self.loudness);
        match self.loudness_key.as_deref().and_then(|k| b.learner(k)) {
            Some(l) => f(l),
            None => f(&self.opts.learner()),
        }
    }

    fn loudness_capped(&self) -> bool {
        self.with_learner(Learner::capped)
    }

    /// Tell the worker whether to meter (off once the measurement is capped).
    fn send_loudness_meter(&mut self) {
        let on = !self.loudness_capped();
        self.meter_on = on;
        if let Some(h) = self.host.as_mut() {
            let _ = h.send(&ToWorker::LoudnessMeter { on }, &[]);
        }
    }

    /// The source stops playing its current path (destroyed, or `path` changed): leaves the
    /// path's measurement — what's left unreported, if enough and if it was the measuring one
    /// (`Book::leave`). Idempotent.
    fn end_loudness(&mut self) {
        let Some(key) = self.loudness_key.take() else {
            return;
        };
        let end = lock_book(&self.loudness).leave(&key, &self.opts.id);
        if let Some(l) = end {
            self.report_loudness(l);
        }
    }

    /// Envelope entries since the last call (`(t on the log clock, dBFS)`, oldest first):
    /// the runtime keeps them as this scene's dropout reference.
    pub fn take_envelope(&mut self) -> Vec<(Duration, f32)> {
        self.envelope.drain(..).collect()
    }

    fn set_paused(&mut self, paused: bool) {
        if paused == self.paused {
            return;
        }
        let now = Instant::now();
        self.paused = paused;
        self.clock.set_running(self.clock_should_run(), now);
        // The worker's `paused` = play no audio (a stepped clock never plays any).
        if let Some(h) = self.host.as_mut()
            && !self.opts.stepped
        {
            let _ = h.send(&ToWorker::Paused { paused }, &[]);
        }
        if paused {
            self.exact_pending = false;
            self.exact_seq = None;
            self.flow_seen = false;
            self.rate_since = None;
        } else {
            self.next_tick = Some(now);
            self.arm_flowing();
            self.rate_since = self.loaded.then_some(now);
        }
    }

    fn on_latched(&mut self, now: Instant, l: crate::worker::dmabuf::Latched) {
        self.rings.retain(|r| r.generation >= l.generation);
        if let Some((g, _, _, slots)) = &self.latest_set
            && *g == l.generation
            && slots.contains(&l.slot)
            && let Some(r) = self.rings.iter_mut().find(|r| r.generation == *g)
        {
            r.retain_slots(slots);
        }
        if let Some(h) = self.host.as_mut() {
            h.set_resume_position(l.t);
        }
        if let Some(&(_, at)) = self.sent_at.iter().find(|(s, _)| *s == l.seq) {
            if self.latency_ms.len() == 1024 {
                self.latency_ms.pop_front();
            }
            self.latency_ms.push_back(at.elapsed().as_secs_f32() * 1e3);
        }
        self.latch_times.push_back(now);
        while self
            .latch_times
            .front()
            .is_some_and(|t| now.duration_since(*t) > BUDGET_WINDOW)
        {
            self.latch_times.pop_front();
        }
        if self.exact_seq.is_some_and(|s| l.seq >= s) {
            self.exact_seq = None;
        }
        self.clock_jumped = false;
        if self.resuming.is_some_and(|g| l.generation > g) {
            // Task 10: the restarted worker's first frame (at the held `t`) is on screen.
            self.resuming = None;
            self.clock.set_running(self.clock_should_run(), now);
            self.next_tick = Some(now + self.tick_period);
            self.rate_since = (!self.paused).then_some(now);
            log::event(
                "scene",
                Level::Info,
                "scene.resumed",
                None,
                json!({"id": self.opts.id, "t": l.t, "seq": l.seq}),
            );
        }
        if !self.loaded && l.generation == self.latch.generation() {
            self.loaded = true;
            self.rate_since = (!self.paused).then_some(now);
            self.events.push(SourceEvent::Ready);
            self.clock.set_running(self.clock_should_run(), now);
            self.next_tick = Some(now + self.tick_period);
        }
    }

    /// The latched frame (kept through a worker crash, restart and path change); `None`
    /// before the first.
    pub fn texture(&self) -> Option<&Tex> {
        match self.latch.current() {
            Some((slot, _, _, generation)) => self
                .rings
                .iter()
                .find(|r| r.generation == generation)?
                .tex(slot),
            // Task 10: no worker frame (a crash before the first one, a restored broken
            // scene) — the preview image, once it rendered.
            None => self.preview.as_ref().and_then(|p| p.texture()),
        }
    }

    /// The preview image is what [`texture`](Self::texture) shows.
    pub fn preview_shown(&self) -> bool {
        self.latch.current().is_none()
            && self.preview.as_ref().is_some_and(|p| p.texture().is_some())
    }

    /// `ContextLost` reports so far.
    pub fn context_losses(&self) -> u32 {
        self.context_losses
    }

    /// The latched frame's tick `seq`.
    pub fn latched_seq(&self) -> Option<u64> {
        self.latch.current().map(|c| c.1)
    }

    /// The latched frame's scene time.
    pub fn latched_t(&self) -> Option<f64> {
        self.latch.current().map(|c| c.2)
    }

    /// The scene clock now (stepped: the step's time).
    pub fn scene_time(&self) -> f64 {
        self.clock.now(Instant::now())
    }

    /// The export size (`Buffer` w×h).
    pub fn size(&self) -> Option<(u32, u32)> {
        self.texture().map(|t| (t.w, t.h)).or(self.size)
    }

    /// The scene's native size (`Ready`).
    pub fn native(&self) -> Option<[u32; 2]> {
        self.native
    }

    /// `Hello.sync`: `fence` | `fdpoll`.
    pub fn sync(&self) -> Option<&str> {
        self.sync.as_deref()
    }

    /// Why this scene can't play (a fatal worker error, an import refused).
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// The worker crashed past its restart budget (also reported as `SourceEvent::Error`).
    pub fn broken(&self) -> Option<&str> {
        self.broken.as_deref()
    }

    pub fn pid(&self) -> Option<u32> {
        self.host.as_ref().and_then(WorkerHost::pid)
    }

    /// Readable when [`update`](Self::update) has worker input (stable across restarts and
    /// path changes: our own epoll fd over the current worker's).
    pub fn wake_fd(&self) -> RawFd {
        self.wake.as_raw_fd()
    }

    pub fn log_tail(&self) -> Vec<String> {
        self.host
            .as_ref()
            .map(WorkerHost::log_tail)
            .unwrap_or_default()
    }

    /// The tick rate the outputs ask for.
    pub fn tick_hz(&self) -> f64 {
        self.opts.tick_hz
    }

    /// The size the ring is exported for (the largest output).
    pub fn max_size(&self) -> [u32; 2] {
        self.opts.max_size
    }

    /// The last ≤ 1024 tick → latch latencies, ms (tick sent → its frame latched here).
    pub fn latencies_ms(&self) -> Vec<f32> {
        self.latency_ms.iter().copied().collect()
    }

    pub fn stats(&self) -> SceneStats {
        let l = self.latch.stats();
        SceneStats {
            latched: l.latched,
            stale_reuses: l.stale_reuses,
            superseded: l.superseded,
            queued: self.latch.queued(),
            rings: self.rings.iter().filter(|r| !r.is_empty()).count(),
            latched_gen: self.latch.current().map_or(0, |c| c.3),
            slots: self
                .latch
                .current()
                .and_then(|c| self.rings.iter().find(|r| r.generation == c.3))
                .map_or(0, ImportedRing::len),
            ..self.stats
        }
    }

    /// The `workers` probe's entry (and `state.workers`).
    pub fn worker_info(&self) -> Value {
        let now = Instant::now();
        let st = self.stats();
        let audio = json!({
            "route": self.opts.audio,
            "gain_db": self.gains.effective_db(),
            "no_audio": self.no_audio,
            "has_audio": self.has_audio,
            "speed": self.clock.speed(),
            "flow_armed": self.flow_armed,
            "flows": self.flows,
            "envelope_dbfs": self.envelope_last,
            "envelope_blocks": self.envelope_blocks,
        });
        let (state, restarts_60s, total_restarts) = match &self.host {
            Some(h) => {
                let (w, t) = h.restarts(now);
                let s = match h.state() {
                    WorkerState::Starting => "starting".to_string(),
                    WorkerState::Running => "running".to_string(),
                    WorkerState::Restarting { attempt } => format!("restarting {attempt}"),
                    WorkerState::Broken { .. } => "broken".to_string(),
                    WorkerState::Stopped => "stopped".to_string(),
                };
                (s, w, t)
            }
            // Task 10: restored broken (no worker is ever spawned).
            None if self.broken.is_some() => ("broken".to_string(), 0, 0),
            None => ("not_spawned".to_string(), 0, 0),
        };
        let fps_actual = self
            .latch_times
            .iter()
            .filter(|t| now.duration_since(**t) <= Duration::from_secs(1))
            .count();
        let (gpu_p50, gpu_p95) = self.gpu_ms_stats(now);
        let mut v = json!({
            "id": self.opts.id,
            "path": self.opts.path,
            "pid": self.pid(),
            "state": state,
            "restarts_60s": restarts_60s,
            "total_restarts": total_restarts,
            "sync": self.sync,
            "fourcc": self.format.map(|(f, _)| String::from_utf8_lossy(&f.to_le_bytes()).into_owned()),
            "modifier": self.format.map(|(_, m)| format!("{m:#018x}")),
            "size": self.size(),
            "native": self.native,
            "max_size": self.opts.max_size,
            "fps_target": self.opts.tick_hz,
            "fps_actual": fps_actual,

            "paused": self.paused,
            "stepped": self.opts.stepped,
            "ready": self.loaded,
            "scene_time": self.scene_time(),
            "latched_t": self.latched_t(),
            "latched": st.latched,
            "stale_reuses": st.stale_reuses,
            "queued": st.queued,
            "ticks_sent": st.ticks_sent,
            "frames_received": st.frames_received,
            "resizes": st.resizes,
            "buffer_sets": st.buffer_sets,
            "spawns": st.spawns,
            "rings": st.rings,
            "last_error": self.error.as_ref().or(self.broken.as_ref()),
            // Task 7
            "assets_dir": self.opts.assets_dir,
            "steam_dir": self.opts.steam_dir,
            "wants_audio_input": self.wants_audio_input,
            "input_dbfs": self.input_dbfs,
            "pointer": self.pointer.map(|(x, y, b)| json!([x, y, b])),
            "properties": self.prop_results.iter().map(|(k, (ok, reason))| {
                (k.clone(), json!({"ok": ok, "reason": reason}))
            }).collect::<Map<String, Value>>(),
            // Task 6
            "audio": audio,
        });
        // F4 (Phase 2 battery): the worker process's own CPU, cumulative (two probes give a
        // rate) — whole and per thread name (`lia-scene-audio`, PipeWire's `data-loop.0`, LWE's).
        v["cpu"] = json!(self.pid().and_then(proc_cpu));
        // Task 8: the GPU budget and the VRAM guard.
        v["fps_demand"] = json!(self.demand_hz);
        v["gpu_ms_p50"] = json!(gpu_p50);
        v["gpu_ms_p95"] = json!(gpu_p95);
        v["throttle"] = json!(self.budget.cap().map(|cap| json!({
            "cap": cap,
            "demand": self.demand_hz,
            "since_ms": self
                .throttled_since
                .map(|t| now.saturating_duration_since(t).as_secs_f64() * 1e3),
        })));
        v["vram_stopped"] = json!(
            self.vram_stopped
                .map(|(used, limit)| json!({"used_mib": used, "limit_mib": limit}))
        );
        // Task 10: the crash policy.
        v["broken"] = json!(self.broken.is_some());
        v["restored_broken"] = json!(self.restored_broken);
        v["resuming"] = json!(self.resuming.is_some());
        v["context_losses"] = json!(self.context_losses);
        let measuring = self.loudness_key.as_deref().is_some_and(|k| {
            lock_book(&self.loudness).measuring(k, &self.opts.id)
        });
        let mut lv = self.with_learner(|l| {
            json!({
                "seconds": l.audible_s(),
                "session_s": l.session_s(),
                "seed_s": l.seed_s(),
                "played_s": l.played_s(),
                "lufs": l.integrated(),
                "done": l.done(),
                "capped": l.capped(),
                "window_s": l.window_s(),
                "cap_s": l.cap_s(),
            })
        });
        lv["measuring"] = json!(measuring);
        lv["received"] = json!(self.loudness_received);
        lv["meter"] = json!(self.meter_on);
        v["loudness"] = lv;
        v["preview"] = json!({
            "path": self.opts.preview,
            "open": self.preview.is_some(),
            "shown": self.preview_shown(),
            "error": self.preview_error,
        });
        v
    }
}

impl Source for SceneSource {
    fn kind(&self) -> &'static str {
        "scene"
    }

    /// Never blocks: worker messages, imports, latching (not while paused, beyond the first
    /// frame of a load or a paused seek's frame), releases, the next tick. Returns whether
    /// the texture changed. Call on every wake of [`wake_fd`](SceneSource::wake_fd) and at
    /// least at the tick rate.
    fn update(&mut self, gfx: &Gfx) -> bool {
        if !self.keep.is_for(gfx) {
            return false;
        }
        let keep = self.keep.clone();
        let guard = keep.make_current();
        if !guard.is_current() {
            return false;
        }
        let now = Instant::now();
        epoll_drain(&self.wake);
        let evs = match self.host.as_mut() {
            Some(h) => h.poll(now),
            None => Vec::new(),
        };
        for ev in evs {
            self.on_event(gfx, now, ev);
        }
        // A meter that is off (the path's measurement was capped) comes back on once the path's
        // measurement isn't capped any more — another source of the path adopted a seed with
        // more room, or this one now measures a path whose learner was replaced. Asked at most
        // every `METER_RECHECK` (a capped scene would otherwise lock the book every frame).
        if !self.meter_on
            && self.loudness_key.is_some()
            && now.duration_since(self.meter_checked) >= METER_RECHECK
        {
            self.meter_checked = now;
            if !self.loudness_capped() {
                self.send_loudness_meter();
            }
        }
        let mut changed = false;
        if self.preview_wanted || self.preview.is_some() || self.preview_dying.is_some() {
            changed |= self.update_preview(gfx);
        }
        if self.latch_allowed()
            && let Some(mut l) = self.latch.latch(|| gfx.native_fence().ok())
        {
            // Already signalled — a free safety net, never a wait (spike §2 step 2).
            if let Some(fd) = l.acquire.take() {
                epoll_ctl(&self.wake, libc::EPOLL_CTL_DEL, fd.as_raw_fd());
                let _ = gfx.gpu_wait_fence(fd);
            }
            self.on_latched(now, l);
            changed = true;
        }
        let releases = self.latch.take_releases();
        if let Some(h) = self.host.as_mut() {
            for (slot, fence) in releases {
                let fds: Vec<BorrowedFd> = fence.iter().map(|f| f.as_fd()).collect();
                let _ = h.send(&ToWorker::Release { slot }, &fds);
            }
        }
        self.tick(now);
        if self.flow_armed
            && self.loaded
            && !self.paused
            && (self.opts.stepped
                || self.has_audio == Some(false)
                || self.no_audio
                || self.broken.is_some()
                || self.flow_seen)
        {
            // Nothing to hear (stepped: never real audio; no sound; muted) — nothing to wait
            // for; else the worker said the scene's sound is on its stream (Task 6).
            self.flow_armed = false;
            self.flow_seen = false;
            self.events.push(SourceEvent::AudioFlowing);
        }
        if self.loaded
            && !self.paused
            && !self.opts.stepped
            && self
                .last_position
                .is_none_or(|t| now.duration_since(t) >= POSITION_EVERY)
        {
            self.last_position = Some(now);
            self.events.push(SourceEvent::Position(self.clock.now(now)));
        }
        changed
    }

    fn texture(&self) -> Option<&Tex> {
        SceneSource::texture(self)
    }

    fn size(&self) -> (u32, u32) {
        SceneSource::size(self).unwrap_or((0, 0))
    }

    fn apply(&mut self, prop: &str, v: &PropValue) -> Result<(), ApiError> {
        props::validate_value(NodeKind::Source, prop, v, true)?;
        let b = matches!(v, PropValue::Bool(true));
        let now = Instant::now();
        match prop {
            "kind" => {
                if !matches!(v, PropValue::Str(k) if k == "scene") {
                    return Err(kind_change_unsupported(v));
                }
            }
            "color" => {
                return Err(unsupported(
                    "`color` applies to colour sources, not a scene source",
                ));
            }
            "path" => {
                if let PropValue::Str(p) = v
                    && Path::new(p) != self.opts.path
                {
                    self.change_path(p.clone());
                }
            }
            "paused" => self.set_paused(b),
            "position" => {
                let t = super::num(v);
                if self.opts.stepped {
                    // The runtime's step drives the clock (`step_to`).
                } else {
                    self.clock.jump(t, now);
                    self.clock_jumped = true;
                    // Paused: show the new time's frame (once the load's first one is in).
                    if self.paused && self.load_ticked {
                        self.exact_pending = true;
                    }
                }
            }
            // Stepped: the runtime's step advances by `ms × speed` itself (and plays no
            // audio). Else the clock re-rates, and the worker time-stretches the sound to it,
            // pitch kept (owner decision; Task 6).
            "speed" if !self.opts.stepped => {
                let sp = super::num(v);
                self.clock.set_speed(sp, now);
                if let Some(h) = self.host.as_mut() {
                    let _ = h.send(&ToWorker::Speed { speed: sp }, &[]);
                }
            }
            // Task 6: the effective dB on every slot change (the 1 kHz `push_gain` path too).
            p if p.starts_with("gain.") => {
                if let Ok(slot) = p["gain.".len()..].parse::<GainSlot>() {
                    self.gains.set(slot, super::num(v));
                    self.send_gain();
                }
            }
            "no_audio" => {
                if b != self.no_audio {
                    self.no_audio = b;
                    if let Some(h) = self.host.as_mut() {
                        let _ = h.send(&ToWorker::NoAudio { on: b }, &[]);
                    }
                    if !b {
                        self.arm_flowing();
                    }
                }
            }
            // Task 10: a new preview image (the item's thumbnail changed): a shown one follows.
            "preview" => {
                if let PropValue::Str(p) = v
                    && *p != self.opts.preview
                {
                    self.opts.preview = p.clone();
                    self.preview_error = None;
                    if let Some(pv) = self.preview.as_mut()
                        && pv.apply("path", v).is_err()
                    {
                        self.retire_preview();
                    }
                }
            }
            // Task 7: the scene's user properties, live (`wp_project_property_set_*`).
            "scene_props" => {
                if let PropValue::Map(m) = v {
                    self.set_properties(m);
                }
            }
            // A new seed (the backend sets it at create; a live one is rare): the measurement
            // restarts from it — what this source measured since its last report is dropped
            // (it may be in the seed already: never counted twice).
            "loudness_seed" => {
                if let PropValue::Map(m) = v {
                    let seed = (!m.is_empty()).then(|| Value::Object(m.clone()));
                    if seed != self.opts.loudness_seed {
                        self.opts.loudness_seed = seed;
                        if let Some(key) = self.loudness_key.as_deref() {
                            lock_book(&self.loudness).reseed(key, &self.opts.id, self.opts.learner());
                        }
                        self.send_loudness_meter();
                    }
                }
            }
            // Everything else (loop, hwdec, fps_cap, cache, demuxer_*, af, audio_delay,
            // preview) is stored: a global `set` never fails on a scene, and a scene has
            // nothing for them to do.
            _ => {}
        }
        self.props.insert(prop.to_string(), v.clone());
        Ok(())
    }

    fn read(&self, prop: &str) -> Option<PropValue> {
        if let Some(slot) = prop
            .strip_prefix("gain.")
            .and_then(|s| s.parse::<GainSlot>().ok())
        {
            return Some(PropValue::F64(self.gains.get(slot)));
        }
        match prop {
            "kind" => Some(PropValue::Str("scene".into())),
            "ready" => Some(PropValue::Bool(self.loaded)),
            "duration" => Some(PropValue::F64(0.0)),
            "time_pos" => Some(PropValue::F64(self.scene_time())),
            "width" => SceneSource::size(self).map(|(w, _)| PropValue::I64(w as i64)),
            "height" => SceneSource::size(self).map(|(_, h)| PropValue::I64(h as i64)),
            // A broken scene (no worker, Task 10) is never heard: nothing to wait for.
            "has_audio" => Some(PropValue::Bool(
                self.broken.is_none() && self.has_audio.unwrap_or(true),
            )),
            "paused" => Some(PropValue::Bool(self.paused)),
            // Task 10: past the restart budget (or restored so) — observed into the graph.
            "broken" => Some(PropValue::Bool(self.broken.is_some())),
            "color" => None,
            _ => self.props.get(prop).cloned(),
        }
    }

    fn poll_events(&mut self) -> Vec<SourceEvent> {
        std::mem::take(&mut self.events)
    }

    /// The worker quits now (never blocks); a preview image goes through `MpvSource`'s own
    /// two-phase teardown (R51) before this source may be dropped.
    fn begin_teardown(&mut self) -> bool {
        self.end_loudness();
        if let Some(h) = self.host.take() {
            epoll_ctl(&self.wake, libc::EPOLL_CTL_DEL, h.wake_fd());
            drop(h); // `quit`, reaped off the loop
        }
        // A second dying preview is rare (one only ever opens before a first frame).
        self.preview_dying = None;
        self.retire_preview();
        self.preview_dying.is_none()
    }

    fn teardown_ready(&mut self) -> bool {
        if self.preview_dying.as_mut().is_some_and(|p| !p.teardown_ready()) {
            return false;
        }
        self.preview_dying = None;
        true
    }

    fn as_scene(&self) -> Option<&SceneSource> {
        Some(self)
    }

    fn as_scene_mut(&mut self) -> Option<&mut SceneSource> {
        Some(self)
    }
}

/// A live `kind` change away from `scene` (or onto it — `MpvSource` refuses that side).
pub fn kind_change_unsupported(v: &PropValue) -> ApiError {
    let to = match v {
        PropValue::Str(s) => s.as_str(),
        _ => "?",
    };
    unsupported(format!(
        "can't change a live scene source to {to:?}; create a new source"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// F4: the `workers` probe's `cpu` — a live process's CPU, whole and per thread name, and
    /// growing with the work it does; a pid that's gone is `None`.
    #[test]
    fn proc_cpu_reads_a_process_and_its_threads() {
        // Other tests' threads come and go in this process: judge one thread of our own.
        let me = std::process::id();
        let (busy_tx, busy_rx) = std::sync::mpsc::channel();
        let (end_tx, end_rx) = std::sync::mpsc::channel::<()>();
        let h = std::thread::Builder::new()
            .name("f4-cpu-probe".into())
            .spawn(move || {
                let t = Instant::now();
                let mut x = 0u64;
                while t.elapsed() < Duration::from_millis(80) {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                }
                std::hint::black_box(x);
                busy_tx.send(()).unwrap();
                let _ = end_rx.recv();
            })
            .unwrap();
        busy_rx.recv().unwrap();
        let v = proc_cpu(me).expect("this process");
        end_tx.send(()).unwrap();
        h.join().unwrap();
        let ms = v["threads"]["f4-cpu-probe"].as_f64().expect("the thread by name");
        assert!(ms >= 40.0, "80 ms busy read as {ms} ms: {v}");
        let sum: f64 = v["threads"]
            .as_object()
            .unwrap()
            .values()
            .map(|t| t.as_f64().unwrap())
            .sum();
        assert!((sum - v["total_ms"].as_f64().unwrap()).abs() < 1e-6, "{v}");
        assert!(proc_cpu(u32::MAX - 1).is_none());
    }

    #[test]
    fn scene_clock_excises_pauses_and_scales_by_speed() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut c = SceneClock::new(5.0, 1.0);
        assert_eq!(c.now(at(1000)), 5.0, "stopped until started");
        c.set_running(true, at(0));
        assert!((c.now(at(500)) - 5.5).abs() < 1e-9);
        c.set_running(false, at(1000));
        assert!(
            (c.now(at(3000)) - 6.0).abs() < 1e-9,
            "paused time is excised"
        );
        c.set_running(true, at(3000));
        assert!(
            (c.now(at(3500)) - 6.5).abs() < 1e-9,
            "no jump at the resume"
        );
        c.set_speed(2.0, at(3500));
        assert!(
            (c.now(at(4000)) - 7.5).abs() < 1e-9,
            "×2 from the change on"
        );
        c.jump(1.0, at(4000));
        assert!(
            (c.now(at(4250)) - 1.5).abs() < 1e-9,
            "a jump keeps running at speed"
        );
        c.set_running(false, at(4250));
        c.set_speed(0.5, at(9000));
        assert!(
            (c.now(at(9000)) - 1.5).abs() < 1e-9,
            "a speed change while stopped"
        );
        c.set_running(true, at(9000));
        assert!((c.now(at(10000)) - 2.0).abs() < 1e-9);
    }

    /// Task 10: `LIASCAPE_SCENE_WORKER_HANG_MS` sets the hang timeout (tests: 300); unset, empty,
    /// zero or garbage → the production `HANG_TIMEOUT` (2 s).
    #[test]
    fn hang_timeout_knob() {
        assert_eq!(hang_timeout(Some("300")), Duration::from_millis(300));
        assert_eq!(hang_timeout(Some(" 750 ")), Duration::from_millis(750));
        for v in [None, Some(""), Some("0"), Some("-5"), Some("2s"), Some("x")] {
            assert_eq!(hang_timeout(v), HANG_TIMEOUT, "{v:?}");
        }
    }

    #[test]
    fn eff_fps_and_demand() {
        assert_eq!(eff_fps(30.0, 60.0), 30.0);
        assert_eq!(eff_fps(144.0, 60.0), 60.0, "never above the refresh");
        assert_eq!(eff_fps(0.0, 144.0), 144.0, "0 = the refresh");
        assert_eq!(eff_fps(45.0, 0.0), 45.0, "unknown refresh");
        assert_eq!(eff_fps(0.0, 0.0), DEFAULT_SCENE_FPS);
        let o = |w, h, hz, fps| OutputDemand {
            name: "out:X".into(),
            width: w,
            height: h,
            refresh_hz: hz,
            scene_fps: fps,
        };
        assert_eq!(demand_of(&[]), None);
        assert_eq!(
            demand_of(&[o(1920, 1080, 60.0, 30.0), o(1080, 1920, 144.0, 60.0)]),
            Some(([1920, 1920], 60.0)),
            "covers every output; the fastest wins"
        );
    }

    #[test]
    fn scene_kind_in_schema_and_kind_change_unsupported() {
        let kind = props::schema_for(NodeKind::Source, "kind").unwrap();
        let ok = PropValue::Str("scene".into());
        props::validate_value(NodeKind::Source, "kind", &ok, true).expect("scene is a kind");
        assert!(matches!(kind.ty, props::PropType::Enum(v) if v.contains(&"scene")));
        let e = kind_change_unsupported(&PropValue::Str("video".into()));
        assert_eq!(e.code, "unsupported");
        assert!(e.message.contains("create a new source"), "{e}");
        // `preview` is a Source prop; `scene_fps` an Output one (D5: 30, 0–480).
        assert!(props::schema_for(NodeKind::Source, "preview").is_some());
        let fps = props::schema_for(NodeKind::Output, "scene_fps").unwrap();
        assert_eq!(fps.default, PropValue::F64(30.0));
        let e = props::validate_value(NodeKind::Output, "scene_fps", &PropValue::F64(481.0), true)
            .unwrap_err();
        assert_eq!(e.code, "out_of_range");
    }
}
