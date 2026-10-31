//! The running player (spec §4.1/§4.2): one calloop loop that owns the graph, the
//! animator, the clock, the live sources, the transition recipe, the compositor and the
//! outputs, and serves the command API (`api/`). `liascape-player serve` is [`serve`].
//!
//! **Loop sources.** The listening socket + one edge-triggered source per client
//! (`api::server`), one level-triggered source per mpv wake eventfd (a `dup` of the
//! source's own fd, so dropping a source never leaves a dangling registration), a ping for
//! log events from other threads, a signalfd (SIGINT/SIGTERM → clean quit), — real
//! clock only — a timer at the max output refresh, and on Wayland the connection's fd
//! (`calloop-wayland-source`; frame callbacks, hotplug, configures, pointer).
//!
//! **Presenting.** Headless outputs compose on every tick. Wayland outputs are *paced*
//! (`OutputBackend::paced`): after every dispatch (and at the end of a tick) each output
//! that can take a frame (its last frame callback arrived) is composed + presented only if
//! its picture changed or something animates (`crate::redraw`) — else it stays idle.
//!
//! **Who runs what (R47).** The timer tick is the one place animation and the recipes
//! advance: `Animator::tick` → `Graph::set` → `drain_changes` → `SourceHost::sync` →
//! `SourceHost::update` → `Transitions::tick` (with every source event since the last
//! tick) → compose + present every output — the same order as
//! `tests/common/harness.rs`. An mpv wake only syncs + updates the sources (textures,
//! events); ticking on wakes would self-sustain (every gain push's reply wakes the fd).
//!
//! **Stepped clock (R48).** No timer: `step {ms}` advances the `SteppedClock`, runs the
//! animator + `sync`, seeks every video source to its own virtual media time (paused,
//! `seek <t> absolute exact`), waits (≤ [`STEP_TIMEOUT`], without blocking the loop) until
//! each one's frame is the texture, then runs the rest of the tick and replies — the same
//! command script always produces the same captures.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use calloop::generic::Generic;
use calloop::timer::{TimeoutAction, Timer};
use calloop::{EventLoop, Interest, LoopHandle, Mode, PostAction, RegistrationToken};
use serde_json::{Map, Value, json};

use crate::anim::{AnimUnit, Animation, Animator, Curve, PropPath};
use crate::api::server::{ClientFd, EventTap, Server};
use crate::api::{handlers, proto};
use crate::audio::Audio;
use crate::clock::{Clock, MonoClock, SteppedClock};
use crate::gfx::{Catalogue, Composer, Gfx};
use crate::graph::{ApiError, Graph, NodeKind, PropValue};
use crate::headless::{Headless, OutputBackend, OutputChange, OutputInfo};
use crate::log::{self, CorrId, Level};
use crate::onset::{self, ONSET_TIMEOUT, Onsets, PendingOnset};
use crate::probe::dropout::{self, GainHistory, PendingWindows};
use crate::probe::frames::FrameStats;
use crate::recipes::program::{ProgramAction, Programs};
use crate::recipes::transition::{ANTICLICK, AUDIO_SETTLE_TAIL};
use crate::recipes::{TransitionEventKind, Transitions};
use crate::redraw::{self, Redraw};
use crate::snapshot::{self, Snapshot};
use crate::sources::{SourceEvent, SourceHost, StepStatus, reaper};
use crate::supervise::{self, RestartInfo};
use crate::units::{SILENT_DB, db_to_lin, lin_to_db};

/// The longest a `step` waits for every video source's frame.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(2);
/// How long `quit` waits for the mpv reaper to destroy the last cores.
pub const REAPER_WAIT: Duration = Duration::from_secs(2);
/// Anti-click ramp used by `stop`/`quit` before sources are destroyed (invariant #4).
const STOP_RAMP: Duration = Duration::from_millis(30);
/// `serve`'s bounded wait (from the bus thread's start, after the bind and the compositor
/// connection) for the audio bus's first session before the loop runs (cold boot,
/// 2026-10-29: it waited up to 10 s, answering nothing). Long enough that a normal start opens its sources straight
/// onto the bus — its setup measured ~0.2 s and runs beside EGL and the catalogue —,
/// short enough that a boot whose PipeWire/WirePlumber isn't ready yet delays the first
/// answer by at most this — under the backend's 1 s spawn probe (`LiascapePlayerClient.
/// Reachable`'s `hello`, whose timeout opens its 3 s stall breaker: what failed the cold
/// boot's restore). A bus that comes up later moves the sources onto it.
pub const BUS_STARTUP_WAIT: Duration = Duration::from_millis(500);
/// R90 (Task 16d): the fast gain-only timer's period — independent of the output
/// refresh (which can be a single 60 Hz monitor), this is what turns a ≤ 30 ms
/// anti-click ramp (invariant #4) into a genuinely smooth push sequence in the real
/// audio output instead of the 1–2 `Animator::tick` evaluations a 60 Hz main tick alone
/// gives it (measured, Task 16c's report: held steps then an abrupt final jump, 5–7 ms
/// `micro_gaps`). See `.claude/rules/player-core.md` § Runtime "The fast gain timer".
const GAIN_TICK_PERIOD: Duration = Duration::from_millis(1);
/// R90: how many recent fast-timer gain pushes the `loop` probe keeps — a test/
/// diagnostic hook for counting or inspecting real pushes within a ramp without logging
/// one event per 1 kHz tick (which would allocate a JSON object even below the log
/// level threshold, exactly the per-tick cost R90 asks to bound).
const GAIN_PUSH_HISTORY: usize = 256;
/// How often a `capture`'s GPU readback is polled while it is in flight.
const CAPTURE_POLL: Duration = Duration::from_millis(1);
/// Steps that may wait behind the running one (one per client at most, by the FIFO).
pub const STEP_QUEUE_MAX: usize = 64;
/// Repeated warnings (same key) are logged at most this often (`warn_limited`).
const WARN_EVERY: Duration = Duration::from_secs(5);
/// Tick durations the `loop` probe keeps.
const TICK_HISTORY: usize = 64;

/// A synchronous loop stretch at least this long is logged (`loop.long_busy`, debug).
const LONG_BUSY: Duration = Duration::from_millis(50);
/// The corr of a restored source's pending fade-in (`Runtime::fade_in`).
const RESTORE_FADE: &str = "restore-fade";

/// `--clock`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockMode {
    Real,
    Stepped,
}

/// What `liascape-player serve` was asked to run.
#[derive(Debug, Clone)]
pub struct ServeOpts {
    /// `(width, height, hz)` per virtual output (`--outputs`), headless only.
    pub outputs: Vec<(u32, u32, u32)>,
    pub clock: ClockMode,
    /// mpv `ao` for every source (`--ao null` in tests — R26); `None` = mpv's default
    /// for liascape-player (`pipewire`).
    pub ao: Option<String>,
    pub socket: PathBuf,
    /// The socket's directory is ours to `chmod 0700` even if it exists (the default
    /// `$XDG_RUNTIME_DIR/liascape`); `false` for `--socket`/`LIASCAPE_PLAYER_SOCKET`.
    pub own_socket_dir: bool,
    pub state_dir: PathBuf,
    pub log_level: Level,
    /// Real outputs: one layer-shell surface per `wl_output` (`crate::wl`); `false` =
    /// headless virtual outputs from [`outputs`](Self::outputs).
    pub wayland: bool,
    /// `--restore`: recreate what `<state>/snapshot.json` saved (`crate::snapshot`).
    pub restore: bool,
    /// `--session-start` (with `--restore`; a boot / `liascape restore`, never a crash
    /// restart — the supervisor gives it to its first child only): each restored program
    /// starts per its `start_mode` (§ Playlist start) instead of where it was.
    pub session_start: bool,
    /// Run by the supervisor (`--supervised`, `crate::supervise`): its pid, and why this is
    /// a restart (`--restarted`).
    pub supervised: Option<Supervised>,
    /// Headless only: `--redraw-policy content` (present only on picture changes, like
    /// Wayland) instead of composing every output every tick.
    pub redraw_content: bool,
    /// `--debug`: starts with `player.debug = true` (Task 15 — the dropout probe's
    /// auto-trigger after every `transition.done`); equivalent to `set player.debug true`
    /// once running.
    pub debug: bool,
    /// Phase 2 (`--render-worker on|off`, env `LIASCAPE_PLAYER_RENDER_WORKER`): render mpv sources
    /// on the `lia-render` worker thread (§ Sources "Render worker"). Real clock only — the
    /// stepped clock renders on the loop whatever this says.
    pub render_worker: bool,
}

/// Phase 2: whether the render worker runs when neither `--render-worker` nor
/// `LIASCAPE_PLAYER_RENDER_WORKER` says (§ Sources "Render worker"). On since 2026-10-26: the
/// switch loop's warm median max_busy 16.3 → 1.3–3.6 ms, missed frames at 2× content on a
/// 240 Hz output 2.2–3.3 → 1.8–2.5/s, full suite green with it on and off, the UI matrix
/// 682/0 with it on. `off` stays the escape hatch.
pub const RENDER_WORKER_DEFAULT: bool = true;

/// The env knob for the render worker (`on`/`off`); `--render-worker` wins over it.
pub const RENDER_WORKER_ENV: &str = "LIASCAPE_PLAYER_RENDER_WORKER";

/// `on|off` (also `1|0`, `true|false`, `yes|no`).
pub fn parse_on_off(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "on" | "1" | "true" | "yes" => Some(true),
        "off" | "0" | "false" | "no" => Some(false),
        _ => None,
    }
}

/// `--render-worker` (if given), else `LIASCAPE_PLAYER_RENDER_WORKER` (an unparsable value is
/// ignored with a stderr note), else [`RENDER_WORKER_DEFAULT`].
pub fn render_worker_enabled(flag: Option<bool>) -> bool {
    if let Some(f) = flag {
        return f;
    }
    match std::env::var(RENDER_WORKER_ENV) {
        Ok(v) if !v.is_empty() => parse_on_off(&v).unwrap_or_else(|| {
            eprintln!("liascape-player serve: {RENDER_WORKER_ENV}={v:?} ignored (expected on|off)");
            RENDER_WORKER_DEFAULT
        }),
        _ => RENDER_WORKER_DEFAULT,
    }
}

/// This compositor runs under the supervisor (Task 16).
#[derive(Debug, Clone)]
pub struct Supervised {
    pub pid: u32,
    /// Set when this child replaces one that crashed.
    pub restart: Option<RestartInfo>,
}

/// Why `serve` failed: at startup, never retried by the supervisor — another instance
/// already holds the lock, or the socket/state dir is unusable (exit 1); at startup, but
/// worth retrying — the compositor/EGL genuinely isn't available *yet* (Task 16b: no
/// Wayland compositor running, EGL init failing before a GPU driver/device is ready; exit
/// [`supervise::EXIT_NO_COMPOSITOR`], backed off and eventually given up on by the
/// supervisor, § Supervisor "Startup-failure classes"); or while running (the compositor
/// connection was lost: exit [`supervise::EXIT_RUNTIME`] — restarted).
#[derive(Debug)]
pub enum ServeError {
    Startup(String),
    NoCompositor(String),
    Runtime(String),
}

impl ServeError {
    pub fn exit_code(&self) -> u8 {
        match self {
            ServeError::Startup(_) => 1,
            ServeError::NoCompositor(_) => supervise::EXIT_NO_COMPOSITOR,
            ServeError::Runtime(_) => supervise::EXIT_RUNTIME,
        }
    }
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeError::Startup(m) | ServeError::NoCompositor(m) | ServeError::Runtime(m) => {
                f.write_str(m)
            }
        }
    }
}

impl From<String> for ServeError {
    fn from(m: String) -> ServeError {
        ServeError::Startup(m)
    }
}

enum ClockKind {
    Real(MonoClock),
    Stepped(SteppedClock),
}

impl ClockKind {
    fn now(&self) -> Duration {
        match self {
            ClockKind::Real(c) => c.now(),
            ClockKind::Stepped(c) => c.now(),
        }
    }
}

/// Per-video-source virtual media time in stepped mode.
#[derive(Debug, Clone)]
pub(crate) struct LocalTime {
    /// Media seconds the source should show.
    pub t: f64,
    /// Steps it has been part of (it advances only from its second step on).
    pub steps: u64,
    /// A `position`/`path` change since the last step: start over from here.
    pub reset: Option<f64>,
}

/// One source a step waits on.
#[derive(Debug)]
struct StepWait {
    id: String,
    t: f64,
    video: bool,
    seeked: bool,
    done: bool,
    /// This step waited for the source to become ready (a fresh source opening).
    opened: bool,
}

/// A `step` in progress (the reply is sent when every wait is done).
struct PendingStep {
    client: u64,
    req: Value,
    deadline: Instant,
    waits: Vec<StepWait>,
    timer: Option<RegistrationToken>,
    /// Synchronous work so far (the waiting excluded) — the tick duration.
    work: Duration,
    /// Of that, the source sync (where dropped sources are torn down).
    sync: Duration,
}

/// The wallpaper kept while no output exists (R60).
#[derive(Debug, Clone)]
pub(crate) struct Parked {
    pub id: String,
    /// Its pause state to restore (a pending B always resumes playing).
    resume_paused: bool,
    /// When its park ramp is over (then it's paused); `None` = settled. On the *unpaused*
    /// base clock (I1: a park ramp completes even while the player is paused).
    settle_at: Option<Duration>,
    /// The ramp end has been reached once (its final value sent): pause next.
    armed: bool,
    /// The connector it was parked for (a restored snapshot's output that isn't present):
    /// that connector shows it when it appears, whatever else is on screen. `None` = the
    /// R60 "no output left" park (the next output shows it).
    pub connector: Option<String>,
}

/// I4 (final review): an `align: end` transition requested while no output exists — its
/// B already replaced the parked wallpaper; its handoff is reported when an output comes
/// back and shows it (the parked A is paused, so its end can't come before), or it is
/// superseded by the next parked request.
#[derive(Debug, Clone)]
pub(crate) struct ParkedReq {
    pub corr: CorrId,
    pub b: String,
    pub from: Option<String>,
}

/// A restored source's fade-in waiting to start (`Runtime::fade_in`, I6): it starts once
/// the source is `Ready` **and** its audio flows — or `ONSET_TIMEOUT` after `Ready`.
#[derive(Debug, Clone, Default)]
struct FadeWait {
    ready_at: Option<Duration>,
    flowed: bool,
}

/// When the snapshot is written (§ Snapshot): `due` = 250 ms after the first unsaved
/// change, `last_write` for the 2 s refresh while a video plays, `frozen` once the final
/// (clean-exit) snapshot is queued.
pub(crate) struct SnapState {
    pub writer: snapshot::Writer,
    pub due: Option<Instant>,
    pub last_write: Option<Instant>,
    pub seen_rev: u64,
    pub frozen: bool,
    timer: Option<RegistrationToken>,
}

/// Counters for the `loop` probe.
#[derive(Default)]
pub(crate) struct LoopStats {
    pub ticks: u64,
    pub wakes: u64,
    pub last_ticks: VecDeque<f64>,
    pub tick_times: VecDeque<Instant>,
    pub last_phases: Map<String, Value>,
    /// Longest stretch of synchronous loop work (a tick, a step, the post-dispatch
    /// source sync/update, one client's requests) since the last `probe loop {"reset": true}`.
    pub max_busy_ms: f64,
    /// The slowest single request handler (its verb) since the last reset — a client that
    /// waited on a reply sees this, whatever else the loop was doing (speed storm).
    pub max_request_ms: f64,
    pub max_request_cmd: String,
    /// The same with the synchronous source opens taken out (`max_open_ms` is those).
    pub max_busy_excl_open_ms: f64,
    pub max_open_ms: f64,
    pub iterations: u64,
    /// R90 (Task 16d): the fast gain timer's own fire count (armed periods only) and
    /// how many gain values it actually forwarded to a hosted source — the `loop`
    /// probe's own evidence that the fast path is doing (bounded) work, or sitting
    /// idle while disarmed.
    pub gain_ticks: u64,
    pub gain_pushes: u64,
    /// The last few `(t_mono_ms, db)` actually forwarded, capped at
    /// [`GAIN_PUSH_HISTORY`] — a test/diagnostic hook for counting or inspecting real
    /// pushes within a ramp.
    pub recent_gain_pushes: VecDeque<(f64, f64)>,
}

impl LoopStats {
    fn record(&mut self, d: Duration, open: Duration, phases: Map<String, Value>) {
        self.ticks += 1;
        self.last_ticks.push_back(d.as_secs_f64() * 1000.0);
        if self.last_ticks.len() > TICK_HISTORY {
            self.last_ticks.pop_front();
        }
        let now = Instant::now();
        self.tick_times.push_back(now);
        while self
            .tick_times
            .front()
            .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(1))
        {
            self.tick_times.pop_front();
        }
        self.last_phases = phases;
        self.busy(d, open);
    }

    /// One synchronous stretch `d`, of which `open` went into source opens.
    pub(crate) fn busy(&mut self, d: Duration, open: Duration) {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        // A stretch long enough to cost frames: on the log timeline (debug) so a hitch can be
        // lined up with what else happened then (`render_worker.attach`, `source.open`, …).
        if d >= LONG_BUSY {
            log::event(
                "runtime",
                Level::Debug,
                "loop.long_busy",
                None,
                json!({ "ms": ms(d), "open_ms": ms(open) }),
            );
        }
        self.max_busy_ms = self.max_busy_ms.max(ms(d));
        self.max_busy_excl_open_ms = self.max_busy_excl_open_ms.max(ms(d.saturating_sub(open)));
        self.max_open_ms = self.max_open_ms.max(ms(open));
    }

    /// One request handler's run time.
    pub(crate) fn request(&mut self, d: Duration, cmd: &str) {
        let ms = d.as_secs_f64() * 1000.0;
        if ms > self.max_request_ms {
            self.max_request_ms = ms;
            self.max_request_cmd = cmd.to_string();
        }
    }

    /// R90: records one fast-timer gain push (bounded history, [`GAIN_PUSH_HISTORY`]).
    pub(crate) fn record_gain_push(&mut self, t_mono_ms: f64, db: f64) {
        self.gain_pushes += 1;
        self.recent_gain_pushes.push_back((t_mono_ms, db));
        if self.recent_gain_pushes.len() > GAIN_PUSH_HISTORY {
            self.recent_gain_pushes.pop_front();
        }
    }
}

/// The player process's state. Fields are crate-visible for the verb handlers and probes.
pub struct Runtime {
    pub(crate) gfx: Gfx,
    pub(crate) cat: Catalogue,
    pub(crate) composer: Composer,
    pub(crate) graph: Graph,
    pub(crate) anim: Animator,
    clock: ClockKind,
    pub(crate) host: SourceHost,
    pub(crate) tr: Transitions,
    /// Phase 3: the rotations (`recipes::program`), ticked after `Transitions::tick`.
    pub(crate) programs: Programs,
    /// Transition events drained outside the tick (the `transition`/`cancel` verbs, an
    /// output removed): the programs see them with the next tick's.
    tr_backlog: Vec<crate::recipes::TransitionEvent>,
    pub(crate) backend: Box<dyn OutputBackend>,
    pub(crate) server: Server,
    pub(crate) tap: Arc<EventTap>,
    pub(crate) handle: LoopHandle<'static, Runtime>,
    pub(crate) stats: LoopStats,
    pub(crate) tick_period: Duration,
    /// Every source event since the last tick (handed to `Transitions::tick`).
    src_events: Vec<(String, SourceEvent)>,
    /// Last event per source, for the `sources` probe.
    pub(crate) last_event: BTreeMap<String, String>,
    wake_regs: BTreeMap<String, (RawFd, RegistrationToken)>,
    pub(crate) wake_pending: bool,
    /// F6b: the sources whose wake fd fired since the last update — `after_dispatch` updates
    /// only these (a worker frame wakes one source, not all of them); the tick updates all.
    woken: Vec<Rc<str>>,
    /// F6b: the graph's `demand_rev` at the last `sync_sources` (`sync_due`).
    synced_demand_rev: (u64, u64),
    step: Option<PendingStep>,
    step_queue: VecDeque<(u64, Value, Duration)>,
    /// `capture`'s readbacks in flight + `lia-capture` (encode + write); its replies are
    /// deferred (`api::capture`).
    pub(crate) capture: crate::api::capture::Capturer,
    /// The 1 ms timer polling a capture's GPU readback is armed.
    capture_timer: bool,
    pub(crate) local: BTreeMap<String, LocalTime>,
    /// `stop`/`quit`: sources to destroy once their anti-click ramp is over.
    /// `(ramp end, id, armed)`: armed at the first tick at/after the ramp end — whose sync
    /// sends the final −96 dB to the live source — and destroyed at the next one. The ramp
    /// end is on the *unpaused* base clock (I1): teardown completes while paused.
    pending_destroy: Vec<(Duration, String, bool)>,
    /// I1 (final review): teardown ramps — `retire` (destroy / stop / output removal) and
    /// `park` — on the **unpaused** base clock (`ClockKind::now`), so they finish while
    /// the player is paused (the main Animator's `Runtime::now` freezes then). Only ever
    /// holds `gain.anticlick` ramps of sources being retired/parked; a source in here is
    /// excluded from the player-pause composition until its ramp is done (it keeps
    /// playing into silence, then goes).
    teardown_anim: Animator,
    /// `animate` on a user-setting gain slot (`GainSlot::is_setting` — the backend's mute
    /// ramp, a volume fade) — on the **unpaused** base clock like `teardown_anim`: a setting
    /// changed while the player is paused must land (on the main Animator's frozen clock a
    /// keybind mute reached no source until the resume, then raced the pause gate's
    /// ramp-in). Inaudible meanwhile: the pause gate holds every playing source silent. One
    /// writer per path: adding here cancels the main Animator's ramp on it and vice versa.
    pub(crate) setting_anim: Animator,
    /// I6: the runtime's own held onsets (unpark) — `crate::onset`.
    onsets: Onsets,
    /// I4: an `align: end` request made while no output exists, waiting for one.
    parked_req: Option<ParkedReq>,
    /// I7: the bus route (`Bus::route`) the sources were last pointed at.
    pub(crate) bus_route: (bool, u64),
    /// `quit` requested: exit once the ramps are done (or this instant passes).
    quit_at: Option<Instant>,
    /// R60: the wallpaper parked while no output exists.
    pub(crate) parked: Option<Parked>,
    /// Rate-limited warnings: key → (last emitted, suppressed since).
    warned: BTreeMap<String, (Instant, u64)>,
    tap_dropped_seen: u64,
    pub(crate) started: Instant,
    /// Which paced outputs need a frame (Task 13).
    pub(crate) redraw: Redraw,
    /// F6b: what each output shows, cached per routing change (`redraw::Routes`).
    routes: crate::redraw::Routes,
    /// Present timing per output (the `frames` probe).
    pub(crate) frames: BTreeMap<String, FrameStats>,
    /// The player audio bus + its meter (Task 14), or why there is none.
    pub(crate) audio: Audio,
    /// Settable output props (`layer`, `paused`) of connectors that are not present —
    /// re-applied when the connector comes back (Task 16).
    pub(crate) out_props: BTreeMap<String, Map<String, Value>>,
    pub(crate) snap: SnapState,
    pub(crate) supervised: Option<Supervised>,
    /// The `supervisor.restart` fields this child logged at startup (`hello.restart`).
    pub(crate) restart_event: Option<Value>,
    /// Restored sources that start silent and ramp in over 30 ms once ready: each has a
    /// not-yet-started `gain.anticlick` animation to 0 dB ([`RESTORE_FADE`] corr), so a
    /// recipe recording its gains (R41) sees the 0 dB it is heading to.
    fade_in: BTreeMap<String, FadeWait>,
    /// R75 (Task 16b): the last `player.paused` [`Runtime::sync_sources`] saw — mirrors
    /// the graph's `player.paused` so [`Runtime::now`] and `SourceHost` don't have to
    /// read the graph on every call. `paused_at`/`pause_offset` excise paused time from
    /// `now()` exactly like [`crate::clock::OutputClock`]'s pause/resume (same algebra,
    /// inlined here rather than reused: this is one global pause, not a per-output clock
    /// needing its own `Rc<dyn Clock>`).
    pub(crate) player_paused: bool,
    /// `Some(base time at pause)` while paused; `None` while running.
    paused_at: Option<Duration>,
    /// Total time excised so far across every completed pause/resume cycle.
    pause_offset: Duration,
    /// Per-source `effective_gain_db` history, one entry per tick (Task 15, R70) — what
    /// `probe::dropout::expected_envelope` weights decoded source audio by. Recorded on
    /// the log's real `t_mono_ms` clock (`log::mono_now()`, § `record_gain_history`) —
    /// the same time base the bus meter's samples use — never `Runtime::now()`, which is
    /// the paused-adjusted animation/transition clock (R75) and would disagree with the
    /// meter during a player-level pause.
    pub(crate) gain_history: GainHistory,
    /// Phase 2 Task 6: each scene's own pre-gain envelope (its worker's `Envelope`) — a
    /// scene's dropout reference (it has no file to decode). Same clock and bounds rules.
    pub(crate) scene_envelopes: dropout::SceneEnvelopes,
    /// Recent transitions' audio windows (`transition.started`/`.done`), for the
    /// dropout probe's auto-trigger and its on-demand `probe dropout` verb.
    pub(crate) dropout_windows: PendingWindows,
    /// Task 16d: dropout analyses waiting for their window's post-roll to be captured
    /// (`probe::dropout::request_analysis`/`run_due`).
    pub(crate) dropout_due: Vec<dropout::DueAnalysis>,
    /// Task 16c (R88): per-source anticlick gate for player-level pause/resume — see
    /// [`PauseGate`]. Real wall-clock timed (`Instant`, never `Runtime::now()`, which
    /// freezes the instant `player.paused` does): the Animator/graph clock can't drive a
    /// ramp that has to run *while* time is otherwise frozen.
    pause_gates: BTreeMap<String, PauseGate>,
    /// The last `player_paused` [`Runtime::update_pause_gates`] itself saw — its own edge
    /// detection, independent of `update_player_paused`'s (R75) bookkeeping.
    pause_gate_prev: bool,
    /// The dropout-probe `corr` minted for each gate still open, from `Pausing` through
    /// `Resuming` — same pattern as `retire`'s own window (R79/R80), so `ctl probe
    /// '{"name":"dropout","args":{"corr":…}}'` can check a whole pause/resume cycle once
    /// it's done (`source.player_pause_gate`'s log event carries it).
    pause_gate_corr: BTreeMap<String, CorrId>,
    /// R90 (Task 16d): whether the fast (≥ 1 kHz) gain-only timer is currently
    /// registered with the event loop. Armed the moment any `gain.*` animation exists
    /// (`arm_gain_timer_if_needed`, checked from `sync_sources` — after every
    /// graph/animator change reaches it) and self-disarms (`TimeoutAction::Drop`, from
    /// inside its own callback) the instant none remain; never armed under the stepped
    /// clock (gains there are evaluated at step boundaries exactly like every other
    /// property — nothing "between steps" for a 1 ms timer to drive).
    gain_timer_armed: bool,
    /// Phase 2 Task 7: the visualiser's system-audio capture (D4), while ≥ 1 live scene wants
    /// audio input; dropped (off the loop) when none does.
    pub(crate) sysmon: Option<crate::audio::sysmon::SysMon>,
    /// Task 7: the `player.scene_assets` value the scene base opts were resolved for.
    scene_assets_for: Option<String>,
    /// Phase 2 Task 8: when the scenes' GPU budgets are fed next (`budget::OBSERVE_EVERY`).
    next_budget: Instant,
    /// Task 8: VRAM measurement, the per-scene limit and the low-VRAM rule.
    pub(crate) vram: VramState,
    /// Phase 3 Task 6: the covered Signal and the cover hold (`crate::signal`).
    pub(crate) cover: crate::signal::CoverRt,
    /// Phase 3 Task 14: the in-player auto-mute Signal (`crate::signal::automute`; behind
    /// `LIASCAPE_PLAYER_AUTOMUTE=1`).
    pub(crate) automute: crate::signal::automute::AutoMuteRt,
}

/// Phase 2 Task 8: the runtime's side of `crate::vram` (`Runtime::vram_tick`).
pub(crate) struct VramState {
    /// The `lia-vram` sampler, while a rule needs it.
    pub(crate) monitor: Option<crate::vram::Monitor>,
    pub(crate) timing: crate::vram::Timing,
    /// The last sample seen (`Monitor::latest`'s seq).
    seen: u64,
    pub(crate) low: crate::vram::LowVram,
    /// The rule holding the player (paused; in `stop` mode the media suspended).
    pub(crate) hold: Option<VramHold>,
    /// Scene id → since when its worker is over `player.scene_vram_limit_mib`.
    pub(crate) over_since: BTreeMap<String, Instant>,
    /// The newest sample (or why there is none) and when it was taken.
    pub(crate) last: Option<(Instant, Result<crate::vram::Sample, String>)>,
    /// The pids the sampler was last given.
    pids: Vec<u32>,
}

pub(crate) struct VramHold {
    /// `stop` | `pause`.
    pub(crate) mode: &'static str,
    pub(crate) phase: HoldPhase,
    pub(crate) since: Instant,
    /// What `stop` suspended.
    pub(crate) suspended: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum HoldPhase {
    /// Paused; in `stop` mode waiting for the pause gates to ramp out before suspending.
    Pausing { at: Instant },
    /// Holding (paused; `stop`: media suspended).
    Held,
    /// Released: the suspended media reopened, waiting for their first frames (≤
    /// `VRAM_RESUME_WAIT`) before the pause lets go.
    Resuming { at: Instant },
}

/// Task 8: how long a resume waits for the reopened sources' first frames before un-pausing
/// anyway.
const VRAM_RESUME_WAIT: Duration = Duration::from_secs(5);

/// Task 16c (R88) — see `pause_gates`' doc and `.claude/rules/player-core.md` § Runtime
/// "Player pause/resume anticlick gate". Final review (I2): the gate ramps its **own**
/// slot, `gain.pause` — never `gain.anticlick`, which the recipe, retire and park ramp on
/// other clocks — so it composes with every transition phase (a source waiting on an
/// `align: end` switch, both sides of a full-live crossfade, a ramping grave) and nothing
/// ever has to be restored when a transition takes a gated source over.
enum PauseGate {
    /// Ramping `gain.pause` toward [`SILENT_DB`] from `from_lin`; excluded from the
    /// `player_paused` OR composition (`SourceHost::set_pause_exclusions`) until done.
    Pausing { started: Instant, from_lin: f64 },
    /// Silent and actually paused (`gain.pause` −96; mpv paused).
    Paused,
    /// Un-paused (`force_paused(id, false)` already sent); waiting for
    /// [`SourceEvent::AudioFlowing`] (bounded by [`ONSET_TIMEOUT`]) — `crate::onset`.
    AwaitingFlow { requested: Instant },
    /// Ramping `gain.pause` back toward 0 dB from `from_lin`; removed once done.
    Resuming { started: Instant, from_lin: f64 },
}

impl PauseGate {
    /// Its `gain.pause` value now (wall clock), for a ramping state.
    fn ramp_db(&self) -> Option<f64> {
        match self {
            PauseGate::Pausing { started, from_lin } => {
                let t = (started.elapsed().as_secs_f64() / ANTICLICK.as_secs_f64()).min(1.0);
                Some(if t >= 1.0 {
                    SILENT_DB
                } else {
                    lin_to_db(*from_lin * (1.0 - t))
                })
            }
            PauseGate::Resuming { started, from_lin } => {
                let t = (started.elapsed().as_secs_f64() / ANTICLICK.as_secs_f64()).min(1.0);
                Some(lin_to_db(*from_lin + (1.0 - *from_lin) * t))
            }
            PauseGate::AwaitingFlow { .. } | PauseGate::Paused => None,
        }
    }

    /// Audio still flows through it (mpv not paused) while the player is paused.
    fn flowing(&self) -> bool {
        matches!(self, PauseGate::Pausing { .. } | PauseGate::Resuming { .. })
    }
}

fn p(s: &str) -> PropPath {
    PropPath(s.to_string())
}

/// Phase 2 Task 8: the present gate of scene source `src` on output `out` (connector name):
/// `1 / eff(out:<c>.scene_fps, refresh)`; `None` for any other source (never gated).
fn scene_gate_period(
    host: &crate::sources::SourceHost,
    src: &str,
    route: &crate::redraw::OutRoute,
    frame_callbacks: bool,
) -> Option<Duration> {
    host.scene(src)?;
    crate::redraw::scene_gate_period(route.scene_fps, route.refresh_hz, frame_callbacks)
}

/// Phase 2 Task 14: output `out` (with frame callbacks) shows a playing scene that renders at
/// its refresh (`scene_fps` 0 or ≥ the refresh, not throttled below it) — so it presents on
/// every frame callback, like an animation. The worker's frames come on the loop's own clock
/// (1 / the rounded refresh), never in phase with the vblank: presenting only when a new frame
/// had latched left the output idle at every callback that came just before one, and the next
/// frame then presented off the callback (measured on DP-2 at 240 Hz: ~100 idle gaps/s, paced
/// intervals 3.4 ms on a 4.17 ms display — two presents inside one refresh, one of them never
/// shown). At the refresh every callback has a frame to show anyway (a repeat only when the
/// two clocks slip, ~once per 4 s).
fn scene_paces_output(
    host: &crate::sources::SourceHost,
    route: &crate::redraw::OutRoute,
    frame_callbacks: bool,
) -> bool {
    if !frame_callbacks {
        return false;
    }
    let refresh = route.refresh_hz;
    route.shown.iter().any(|s| {
        host.scene(s).is_some_and(|sc| {
            sc.clock_running()
                && sc.tick_hz() + 0.5 >= refresh
                && scene_gate_period(host, s, route, true).is_none()
        })
    })
}

impl Runtime {
    pub(crate) fn stepped(&self) -> bool {
        matches!(self.clock, ClockKind::Stepped(_))
    }

    /// The player's own virtual time: [`ClockKind::now`], with every interval spent
    /// `player.paused` excised — never just frozen-and-jumped (R75). This is what the
    /// Animator and `Transitions::tick` read, so a transition's progress, gain ramps,
    /// `align:end` waits and handoff timers all stop and resume exactly where they were.
    pub(crate) fn now(&self) -> Duration {
        let base = self.clock.now();
        let frozen = self.paused_at.unwrap_or(base);
        frozen.saturating_sub(self.pause_offset)
    }

    /// The **unpaused** base clock (I1): what teardown ramps (`teardown_anim`), their
    /// destroy deadlines and park settling run on, so they complete while paused.
    pub(crate) fn base_now(&self) -> Duration {
        self.clock.now()
    }

    /// C1 / long-run bounds: the size of every per-source collection (`loop` probe).
    pub(crate) fn bounds(&self) -> Value {
        let (gh_tracks, gh_samples) = self.gain_history.stats();
        let (se_tracks, se_samples) = self.scene_envelopes.stats();
        let (active, graves, ended, restore_onsets) = self.tr.bounds();
        json!({
            "graph_nodes": self.graph.node_count(),
            "gain_history_tracks": gh_tracks,
            "gain_history_samples": gh_samples,
            "scene_envelope_tracks": se_tracks,
            "scene_envelope_samples": se_samples,
            "anim_entries": self.anim.len(),
            "teardown_anim_entries": self.teardown_anim.len(),
            "setting_anim_entries": self.setting_anim.len(),
            "pending_destroy": self.pending_destroy.len(),
            "onsets": self.onsets.len(),
            "fade_in": self.fade_in.len(),
            "dropout_windows": self.dropout_windows.len(),
            "dropout_due": self.dropout_due.len(),
            "pause_gates": self.pause_gates.len(),
            "pause_gate_corr": self.pause_gate_corr.len(),
            "last_event": self.last_event.len(),
            "local": self.local.len(),
            "wake_regs": self.wake_regs.len(),
            "warned": self.warned.len(),
            "hosted": self.host.ids().len(),
            "opening": self.host.opening(),
            "open_queued": crate::sources::host::open_queued(),
            "captures_in_flight": self.capture.in_flight(),
            "dying": self.host.dying(),
            "transitions": active,
            "graves": graves,
            "ended": ended,
            "restore_onsets": restore_onsets,
        })
    }

    pub(crate) fn clock_name(&self) -> &'static str {
        if self.stepped() { "stepped" } else { "real" }
    }

    pub(crate) fn player_paused(&self) -> bool {
        self.player_paused
    }

    /// R90: whether the fast gain timer is currently armed (the `loop` probe).
    pub(crate) fn gain_timer_armed(&self) -> bool {
        self.gain_timer_armed
    }

    /// R93: how many player-pause anticlick gates (`PauseGate`) are currently open (the
    /// `loop` probe) — a destroyed/retired gated source must leave this at 0 for it,
    /// never leaked.
    pub(crate) fn pause_gate_count(&self) -> usize {
        self.pause_gates.len()
    }

    /// Reacts to a `player.paused` change: freezes/unfreezes [`Runtime::now`]. Called at
    /// the very top of [`Runtime::tick`]/`begin_step` — *before* `now` is read for
    /// `run_anims`/`destroy_due` — so a pause applied this tick/step freezes it too,
    /// never one tick later (the effective-pause push to every hosted source still
    /// happens in [`Runtime::sync_sources`], which reads the now-current
    /// `self.player_paused` this set). Cheap when nothing changed (one graph read).
    fn update_player_paused(&mut self) {
        // Task 8: the low-VRAM rule holds the player paused too, and Phase 3 Task 6's cover hold
        // (composed, never written to `player.paused` — the user's own pause is untouched and
        // survives both).
        let now_paused = matches!(
            self.graph.get(&p("player.paused")),
            Ok(PropValue::Bool(true))
        ) || self.held();
        if now_paused != self.player_paused {
            let base = self.clock.now();
            if now_paused {
                self.paused_at.get_or_insert(base);
            } else if let Some(at) = self.paused_at.take() {
                self.pause_offset += base.saturating_sub(at);
            }
            self.player_paused = now_paused;
            log::event(
                "runtime",
                Level::Info,
                "player.paused",
                None,
                json!({ "paused": now_paused, "vram_hold": self.vram.hold.is_some(),
                        "cover_hold": self.cover_held() }),
            );
        }
    }

    /// A rule holds the player paused (the low-VRAM hold, the cover hold) — what
    /// `effective_paused` adds to `player.paused`.
    pub(crate) fn held(&self) -> bool {
        self.vram.hold.is_some() || self.cover_held()
    }

    /// `player.debug` (Task 15: gates the dropout probe's auto-trigger after
    /// `transition.done`; `serve --debug` or `set player.debug true`).
    pub(crate) fn debug_mode(&self) -> bool {
        matches!(
            self.graph.get(&p("player.debug")),
            Ok(PropValue::Bool(true))
        )
    }

    // ------------------------------------------------------------------ one tick

    /// One full iteration (real clock: the timer; stepped: the end of a `step`).
    pub(crate) fn tick(&mut self) {
        let t = Instant::now();
        self.cover_tick();
        self.automute_tick();
        self.update_player_paused();
        self.track_bus_route();
        let now = self.now();
        self.run_anims(now);
        self.record_gain_history();
        self.destroy_due(self.base_now());
        let t_sync = Instant::now();
        self.sync_sources();
        let sync_ms = t_sync.elapsed();
        self.finish_tick(t.elapsed(), sync_ms);
        self.feed_scene_budgets();
        self.vram_tick();
        dropout::run_due(self);
    }

    // ------------------------------------------------------------ Task 8: GPU budget, VRAM

    /// Every `budget::OBSERVE_EVERY`: each scene's GPU budget gets the worst miss rate (paced
    /// presents over the `frames` probe's 2 s window) of **every** output — the GPU is shared,
    /// so a heavy worker on one output starves another's presents (Phase 2 Task 14,
    /// `frames::worst_missed_pct`) — and
    /// `player.scene_throttle` (off = fixed fps, any cap lifted). Real clock only.
    fn feed_scene_budgets(&mut self) {
        let now = Instant::now();
        if self.stepped() || now < self.next_budget {
            return;
        }
        self.next_budget = now + crate::scene::budget::OBSERVE_EVERY;
        let auto = !matches!(
            self.graph.get(&p("player.scene_throttle")),
            Ok(PropValue::Bool(false))
        );
        let at = now.saturating_duration_since(self.started);
        let missed = crate::probe::frames::worst_missed_pct(self.frames.values(), now);
        for id in self.host.scene_ids() {
            if let Some(sc) = self.host.scene_mut(&id) {
                sc.observe_budget(at, missed, auto);
            }
        }
    }

    /// Task 8: the VRAM rules (`crate::vram`), every tick (cheap when off): run the sampler
    /// while a rule needs it (low-VRAM mode not `off`, or a per-scene limit with a scene
    /// playing), apply each new sample — scene workers over `player.scene_vram_limit_mib` for
    /// `scene_hold` are stopped (`SceneSource::stop_for_vram`), the low rule engages/releases
    /// the hold — and move the hold through its phases. Inert under the stepped clock (tests'
    /// determinism; the rule's holds are wall-clock).
    pub(crate) fn vram_tick(&mut self) {
        if self.stepped() {
            return;
        }
        let mode = match self.str_prop("player", "vram_low_mode").as_str() {
            "pause" => "pause",
            "off" => "off",
            _ => "stop",
        };
        let limit = match self.graph.get(&p("player.scene_vram_limit_mib")) {
            Ok(PropValue::F64(f)) => f,
            _ => 0.0,
        };
        let scenes = self.host.scene_ids();
        let need = mode != "off" || (limit > 0.0 && !scenes.is_empty()) || self.vram.hold.is_some();
        if !need {
            if self.vram.monitor.take().is_some() {
                self.vram.seen = 0;
                self.vram.last = None;
            }
            self.vram.over_since.clear();
            return;
        }
        let interval = self.vram.timing.interval;
        let monitor = self
            .vram
            .monitor
            .get_or_insert_with(|| crate::vram::Monitor::start(crate::vram::probe_from_env(), interval));
        // Our own processes: the compositor and every scene worker still running.
        let mut pids = vec![std::process::id()];
        let mut scene_pids = Vec::new();
        for id in &scenes {
            if let Some(sc) = self.host.scene(id)
                && sc.vram_stopped().is_none()
                && let Some(pid) = sc.pid()
            {
                pids.push(pid);
                scene_pids.push((id.clone(), pid));
            }
        }
        if pids != self.vram.pids {
            monitor.set_pids(pids.clone());
            self.vram.pids = pids.clone();
        }
        let latest = monitor.latest();
        if let Some((seq, at, r)) = latest
            && seq != self.vram.seen
        {
            self.vram.seen = seq;
            let t = at.saturating_duration_since(self.started);
            let action = match &r {
                Ok(s) => {
                    self.scene_vram_guard(s, limit, &scene_pids, at);
                    if mode == "off" {
                        None
                    } else {
                        let ours = s
                            .procs
                            .as_ref()
                            .map(|m| pids.iter().filter_map(|p| m.get(p)).sum::<f64>());
                        self.vram
                            .low
                            .observe(t, s.total_mib, s.free_mib, ours, mode == "stop")
                    }
                }
                Err(_) => self.vram.low.unavailable(t),
            };
            if let Ok(s) = &r {
                match action {
                    Some(crate::vram::Action::Engage) => self.vram_engage(mode, s),
                    Some(crate::vram::Action::Release) => self.vram_release("free", Some(s)),
                    None => {}
                }
            } else if action == Some(crate::vram::Action::Release) {
                self.vram_release("no_sample", None);
            }
            self.vram.last = Some((at, r));
        }
        if mode == "off" && self.vram.low.engaged() {
            self.vram.low.release(Instant::now().saturating_duration_since(self.started));
            self.vram_release("off", None);
        }
        self.drive_vram_hold(mode);
    }

    /// The per-scene limit on one sample: a worker over it for `scene_hold` is stopped.
    fn scene_vram_guard(
        &mut self,
        s: &crate::vram::Sample,
        limit: f64,
        scene_pids: &[(String, u32)],
        at: Instant,
    ) {
        if limit <= 0.0 {
            self.vram.over_since.clear();
            return;
        }
        let hold = self.vram.timing.scene_hold;
        for (id, pid) in scene_pids {
            let used = s.procs.as_ref().and_then(|m| m.get(pid)).copied();
            match used {
                Some(u) if u > limit => {
                    let since = *self.vram.over_since.entry(id.clone()).or_insert(at);
                    if at.saturating_duration_since(since) >= hold {
                        self.vram.over_since.remove(id);
                        if let Some(sc) = self.host.scene_mut(id) {
                            sc.stop_for_vram(u, limit);
                        }
                    }
                }
                _ => {
                    self.vram.over_since.remove(id);
                }
            }
        }
        self.vram
            .over_since
            .retain(|id, _| scene_pids.iter().any(|(i, _)| i == id));
    }

    fn vram_engage(&mut self, mode: &'static str, s: &crate::vram::Sample) {
        log::event(
            "vram",
            Level::Warn,
            "vram.low",
            None,
            json!({
                "mode": mode,
                "free_mib": s.free_mib,
                "total_mib": s.total_mib,
                "low_mib": crate::vram::low_mib(s.total_mib),
                "resume_mib": crate::vram::resume_mib(s.total_mib),
                "resume_hold_ms": self.vram.low.resume_hold().as_millis() as u64,
            }),
        );
        let now = Instant::now();
        match &mut self.vram.hold {
            // Still holding from a release in progress: back to holding.
            Some(h) => {
                h.mode = mode;
                if !matches!(h.phase, HoldPhase::Held) || !h.suspended.is_empty() {
                    h.phase = HoldPhase::Pausing { at: now };
                }
            }
            None => {
                self.vram.hold = Some(VramHold {
                    mode,
                    phase: HoldPhase::Pausing { at: now },
                    since: now,
                    suspended: Vec::new(),
                });
            }
        }
        let _ = self
            .graph
            .set_observed(&p("player.vram_low_active"), PropValue::Bool(true));
        self.update_player_paused();
    }

    fn vram_release(&mut self, reason: &str, s: Option<&crate::vram::Sample>) {
        let Some(h) = &mut self.vram.hold else {
            return;
        };
        log::event(
            "vram",
            Level::Info,
            "vram.recovered",
            None,
            json!({
                "reason": reason,
                "free_mib": s.map(|s| s.free_mib),
                "total_mib": s.map(|s| s.total_mib),
                "held_ms": h.since.elapsed().as_secs_f64() * 1e3,
                "mode": h.mode,
            }),
        );
        h.phase = HoldPhase::Resuming { at: Instant::now() };
        let reopened = self.host.resume_media();
        if !reopened.is_empty() {
            log::event(
                "vram",
                Level::Info,
                "vram.resuming",
                None,
                json!({ "sources": reopened }),
            );
        }
    }

    /// Move the hold on: `Pausing` → (`stop`: once every pause gate ramped out, the media
    /// suspended) `Held`; `Resuming` → done once the reopened sources showed a frame (or
    /// `VRAM_RESUME_WAIT`), the pause let go. A mode change while held applies at once.
    fn drive_vram_hold(&mut self, mode: &'static str) {
        let Some(h) = &mut self.vram.hold else {
            return;
        };
        if matches!(h.phase, HoldPhase::Held) && h.mode != mode && mode != "off" {
            // stop → pause: give the sources back, stay paused; pause → stop: free now.
            h.mode = mode;
            if mode == "pause" {
                h.suspended.clear();
                self.host.resume_media();
            } else {
                h.phase = HoldPhase::Pausing { at: Instant::now() };
            }
        }
        let gates_settled = !self
            .pause_gates
            .values()
            .any(|g| matches!(g, PauseGate::Pausing { .. }));
        match h.phase {
            HoldPhase::Pausing { at } => {
                if h.mode != "stop" {
                    h.phase = HoldPhase::Held;
                } else if gates_settled && at.elapsed() >= ANTICLICK + AUDIO_SETTLE_TAIL {
                    let ids = self.host.suspend_media(&self.gfx);
                    log::event(
                        "vram",
                        Level::Warn,
                        "vram.stopped",
                        None,
                        json!({ "sources": ids, "ms": at.elapsed().as_secs_f64() * 1e3 }),
                    );
                    let h = self.vram.hold.as_mut().expect("held");
                    h.suspended.extend(ids);
                    h.phase = HoldPhase::Held;
                }
            }
            HoldPhase::Held => {}
            HoldPhase::Resuming { at } => {
                let pending = self.host.resuming_count();
                if pending == 0 || at.elapsed() >= VRAM_RESUME_WAIT {
                    let since = h.since;
                    let resumed = std::mem::take(&mut h.suspended);
                    self.vram.hold = None;
                    log::event(
                        "vram",
                        Level::Info,
                        "vram.resumed",
                        None,
                        json!({
                            "sources": resumed,
                            "pending": pending,
                            "resume_ms": at.elapsed().as_secs_f64() * 1e3,
                            "held_ms": since.elapsed().as_secs_f64() * 1e3,
                        }),
                    );
                    let _ = self
                        .graph
                        .set_observed(&p("player.vram_low_active"), PropValue::Bool(false));
                    self.update_player_paused();
                }
            }
        }
    }

    /// I7 (final review): the bus lost its PipeWire connection (down — sources go to mpv's
    /// default device so they keep playing) or was re-created after one (up, a new
    /// generation — every source back onto the bus, the meter resumes on its own). Every
    /// hosted mpv source gets an async `audio-device` set, new ones open with the route.
    fn track_bus_route(&mut self) {
        let Some(bus) = &self.audio.bus else {
            return;
        };
        let route = bus.route();
        if route == self.bus_route {
            return;
        }
        let (dev, bias) = if route.0 {
            (Some(bus.device()), -bus.latency().as_secs_f64())
        } else {
            (None, 0.0)
        };
        self.bus_route = route;
        let ids = self.host.set_audio_route(dev.clone(), bias);
        // The re-route rebuilds each source's audio chain (its output died with the
        // server): invariant #8 — silent until its audio really flows, then 30 ms in, on
        // its own `gain.pause` slot (a player-pause gate, if one is open, owns that slot and
        // its resume does the same).
        let now = self.now();
        let mut held = 0;
        for id in &ids {
            // Down: the server is gone, nothing can flow until it's back (and the bus with
            // it — the up re-route holds the ramp then).
            if !route.0
                || self.player_paused
                || self.pause_gates.contains_key(id)
                || self.bool_prop(id, "paused")
                || !onset::has_audio(&self.graph, id)
            {
                continue;
            }
            let _ = self
                .graph
                .set(&p(&format!("{id}.gain.pause")), PropValue::F64(SILENT_DB));
            self.onsets.schedule(
                &self.graph,
                &mut self.anim,
                PendingOnset {
                    id: id.clone(),
                    slot: "pause",
                    from: 0.0,
                    to: 1.0,
                    dur: STOP_RAMP,
                    curve: Curve::Linear,
                    requested: now,
                    corr: None,
                },
                now,
            );
            held += 1;
        }
        log::event(
            "audio",
            Level::Info,
            "audio.bus.sources_rerouted",
            None,
            json!({ "device": dev.unwrap_or_else(|| "auto".into()), "sources": ids.len(),
                    "onsets_held": held, "generation": route.1 }),
        );
    }

    /// Task 6: every scene's new envelope entries into [`dropout::SceneEnvelopes`] (dead
    /// scenes linger for their post-roll analysis, then go).
    fn record_scene_envelopes(&mut self) {
        let Some(now) = log::mono_now() else { return };
        let ids = self.host.scene_ids();
        self.record_scene_envelopes_of(ids.iter().map(String::as_str));
        self.scene_envelopes.retain_live(&ids, now);
    }

    fn record_scene_envelopes_of<'a>(&mut self, ids: impl Iterator<Item = &'a str>) {
        let Some(now) = log::mono_now() else { return };
        for id in ids {
            if let Some(sc) = self.host.scene_mut(id) {
                let env = sc.take_envelope();
                if !env.is_empty() {
                    self.scene_envelopes.record(id, env, now);
                }
            }
        }
    }

    /// R70: one `effective_gain_db` reading per live `Source` node per tick, on the log's
    /// real `t_mono_ms` clock — **not** `self.now()`, which may be the stepped/virtual
    /// clock and would disagree with the bus meter's real-time samples.
    fn record_gain_history(&mut self) {
        let t = log::mono_now().unwrap_or_default();
        self.gain_history.record(t, self.graph.source_gains_db());
    }

    /// The second half of a tick: update sources, run the recipes on every source event
    /// since the last tick, compose + present every output.
    fn finish_tick(&mut self, before: Duration, sync: Duration) {
        let t = Instant::now();
        let now = self.now();
        self.update_sources();
        let t_tr = Instant::now();
        let evs = std::mem::take(&mut self.src_events);
        self.drive_onsets(&evs, now);
        self.tr.tick(&mut self.graph, &mut self.anim, &evs, now);
        // Already in the event log → subscribers via the tap; the dropout probe (Task 15,
        // R71) also watches for Started/Done here to track each transition's audio window.
        let mut tr_events = std::mem::take(&mut self.tr_backlog);
        tr_events.extend(self.tr.drain_events());
        self.record_dropout_windows(&tr_events);
        self.tick_programs(&tr_events, &evs, now);
        self.refresh_srcs();
        // R88 (Task 16c): resolve any `AwaitingFlow` gate against this tick's events —
        // the other half runs earlier, from `sync_sources` (see its doc).
        self.drive_pause_gates_post_update(&evs);
        let tr_d = t_tr.elapsed();
        let t_r = Instant::now();
        self.render();
        let render_d = t_r.elapsed();
        let total = before + t.elapsed();
        let mut phases = Map::new();
        let ms = |d: Duration| json!(d.as_secs_f64() * 1000.0);
        phases.insert("sync_ms".into(), ms(sync));
        phases.insert("transitions_ms".into(), ms(tr_d));
        phases.insert("render_ms".into(), ms(render_d));
        phases.insert("total_ms".into(), ms(total));
        let open = self.host.take_open_time();
        self.stats.record(total, open, phases);
    }

    fn run_anims(&mut self, now: Duration) {
        let mut moved = BTreeSet::new();
        for (path, v) in self.anim.tick(now) {
            if !redraw::audio_only(&path) {
                moved.insert(redraw::node_of(&path).to_string());
            }
            // Not a `picture_rev` move: only the outputs showing the node redraw (below).
            if let Err(e) = self.graph.set_animated(&path, PropValue::F64(v)) {
                // The node went away under the animation (destroyed, output unplugged).
                self.anim.cancel_target(&path);
                log::event(
                    "runtime",
                    Level::Debug,
                    "anim.dropped",
                    None,
                    json!({ "path": path.0, "error": e.to_string() }),
                );
            }
        }
        // I1: teardown ramps on the unpaused base clock (gain-only, never a redraw).
        for (path, v) in self.teardown_anim.tick(self.base_now()) {
            if self.graph.set_animated(&path, PropValue::F64(v)).is_err() {
                self.teardown_anim.cancel_target(&path);
            }
        }
        self.teardown_anim.finished();
        // user-setting ramps on the unpaused clock too (`setting_anim`)
        for (path, v) in self.setting_anim.tick(self.base_now()) {
            if self.graph.set_animated(&path, PropValue::F64(v)).is_err() {
                self.setting_anim.cancel_target(&path);
            }
        }
        // M1: an animation on a node that is gone never emits again (a placeholder that
        // never started would otherwise sit — and keep the gain timer armed — forever).
        let g = &self.graph;
        let alive = |p: &PropPath| g.kind_of(redraw::node_of(p)).is_some();
        self.anim.retain_targets(alive);
        self.teardown_anim.retain_targets(alive);
        self.setting_anim.retain_targets(alive);
        self.redraw.mark_nodes(self.routes.of(&self.graph), &moved);
        let done: Vec<_> = self
            .anim
            .finished()
            .into_iter()
            .chain(self.setting_anim.finished())
            .collect();
        for (_, corr) in done {
            if let Some(c) = corr
                && c.0.starts_with("an-")
            {
                log::event("runtime", Level::Info, "anim.done", Some(c), json!({}));
            }
        }
    }

    /// Drain the transition outbox outside the tick (already logged → subscribers via the
    /// tap); the programs get these events with the next tick's.
    pub(crate) fn stash_tr_events(&mut self) {
        let evs = self.tr.drain_events();
        self.tr_backlog.extend(evs);
    }

    /// Phase 3: the programs' tick (R47 order: after `Transitions::tick`, before
    /// `refresh_srcs`) and the switches it asks for.
    fn tick_programs(
        &mut self,
        tr_events: &[crate::recipes::TransitionEvent],
        src_events: &[(String, SourceEvent)],
        now: Duration,
    ) {
        if self.programs.is_empty() {
            return;
        }
        let parked = self.graph.ids_of(NodeKind::Output).is_empty();
        let active: Vec<CorrId> = self.tr.status().into_iter().map(|s| s.corr).collect();
        let cat = &self.cat;
        let acts = self.programs.tick(
            &mut self.graph,
            tr_events,
            src_events,
            now,
            parked,
            &active,
            &|id| cat.defaults(id),
        );
        self.run_program_actions(acts);
    }

    /// Run what a program asks for — through the same `Transitions::start` the `transition`
    /// verb uses (or `transition_parked` with no output). The last switch started: its corr
    /// and B's path (a verb's reply).
    pub(crate) fn run_program_actions(
        &mut self,
        acts: Vec<ProgramAction>,
    ) -> Option<(CorrId, String)> {
        if acts.is_empty() {
            return None;
        }
        let mut last = None;
        for a in acts {
            match a {
                ProgramAction::Start { id, req, step, reason } => {
                    let path = step.path.clone();
                    let parked = req.outputs.starts_with("out:")
                        && self.graph.ids_of(NodeKind::Output).is_empty();
                    let res = if parked {
                        self.transition_parked(req).map(|(c, b)| (c, Some(b)))
                    } else {
                        let now = self.now();
                        self.tr
                            .start(req, &mut self.graph, &mut self.anim, now)
                            .map(|c| (c, None))
                    };
                    let now = self.now();
                    match res {
                        Ok((corr, parked_b)) => {
                            self.programs.on_requested(
                                &id,
                                corr.clone(),
                                step,
                                reason,
                                parked_b,
                                &self.graph,
                                now,
                            );
                            last = Some((corr, path));
                        }
                        Err(e) => self.programs.on_request_failed(&id, step, &e, now),
                    }
                }
                ProgramAction::Cancel { corr } => {
                    let now = self.now();
                    let _ = self.tr.cancel(&corr, &mut self.graph, &mut self.anim, now);
                }
            }
        }
        self.stash_tr_events();
        self.refresh_srcs();
        last
    }

    /// Task 15 (R70/R71): track each transition's audio window from its own
    /// `transition.started`/`.done` events, and — once `done` arrives, if `player.debug`
    /// is on — kick off the dropout probe's auto-trigger (never blocks: it only snapshots
    /// cheap data and spawns a worker thread, `probe::dropout::spawn_analysis`).
    fn record_dropout_windows(&mut self, events: &[crate::recipes::TransitionEvent]) {
        if events.is_empty() {
            return;
        }
        let mono = log::mono_now().unwrap_or_default();
        for ev in events {
            match &ev.kind {
                TransitionEventKind::Started { a, b, .. } => {
                    self.dropout_windows
                        .started(ev.corr.0.clone(), mono, a.clone(), b.clone());
                }
                TransitionEventKind::Done { .. } => {
                    self.dropout_windows.done(&ev.corr.0, mono);
                    if self.debug_mode() {
                        // Task 16d: deferred until the window's post-roll is captured.
                        dropout::request_analysis(self, ev.corr.clone(), None);
                    }
                }
                _ => {}
            }
        }
    }

    /// Forward graph changes to the live sources (and keep the wake-fd registrations in
    /// line with the hosted sources).
    pub(crate) fn sync_sources(&mut self) {
        // Task 14: a source created while auto-muted (a handler's `create`, a program's or a
        // transition's B) comes up at −96 — set before its first sync opens it.
        if self.automute.muted {
            self.automute_enforce();
        }
        // R75: catch a `player.paused` change promptly even between ticks/steps — this
        // runs after every dispatch (`after_dispatch`), not only on a timer/`step`, so a
        // plain `set` pushes the effective pause to every source at once (a no-op if
        // `tick`/`begin_step` already called this for `now`'s sake this iteration).
        self.update_player_paused();
        self.update_scene_assets();
        let changes = self.graph.drain_changes();
        if !changes.is_empty() || self.graph.picture_rev() != self.snap.seen_rev {
            self.snap.seen_rev = self.graph.picture_rev();
            self.snapshot_dirty();
        }
        if self.stepped() {
            for (path, v) in &changes {
                if let Some((id, prop)) = path.0.split_once('.')
                    && let Some(lt) = self.local.get_mut(id)
                {
                    match (prop, v) {
                        ("position", PropValue::F64(t)) => lt.reset = Some(*t),
                        ("path", _) => lt.reset = Some(0.0),
                        _ => {}
                    }
                }
            }
        }
        for (path, v) in &changes {
            if let Some((id, "layer")) = path.0.split_once('.')
                && let Some(name) = id.strip_prefix("out:")
                && let PropValue::Str(layer) = v
                && let Err(e) = self.backend.set_layer(name, layer)
            {
                log::event(
                    "output",
                    Level::Warn,
                    "output.layer_failed",
                    None,
                    json!({ "output": id, "layer": layer, "error": e }),
                );
            }
        }
        // `update_player_paused` already ran at the top of this tick/step, before `now`
        // was read for `run_anims` — a pause applied this iteration freezes it too.
        // R88 (Task 16c): the pause-ramp gate's exclusion set must land *before* `sync`
        // composes `player_paused` for every source — a tick that both applies the edge
        // and calls `sync` (every tick does) must never let `sync` see an un-excluded
        // newly-eligible id even once, or it pauses it instantly before the gate exists.
        let mut exclude = self.drive_pause_gates_pre_sync();
        // I1: a source ramping out (retire) or into its park keeps playing into silence on
        // the unpaused clock — a pause landing mid-ramp must not cut it.
        exclude.extend(self.pending_destroy.iter().map(|(_, id, _)| id.clone()));
        if let Some(pk) = &self.parked
            && pk.settle_at.is_some()
        {
            exclude.insert(pk.id.clone());
        }
        self.host.set_pause_exclusions(exclude);
        self.synced_demand_rev = self.graph.demand_rev();
        self.host
            .sync(&self.gfx, &self.graph, &changes, self.player_paused);
        self.sync_wake_regs();
        self.arm_gain_timer_if_needed();
    }

    /// R90 (Task 16d): arms the fast (≥ 1 kHz) gain-only timer if it isn't already and
    /// at least one `gain.*` animation exists *or* an R88 pause gate is mid-ramp (fix
    /// round: the gate's own ramp isn't an Animator animation at all, so it needs its
    /// own arming condition — `has_active_pause_gate_ramp`). A no-op under the stepped
    /// clock (`self.stepped()`) — gains there are evaluated at step boundaries exactly
    /// like every other property (`begin_step`'s own `run_anims` call), never between
    /// them; there's no "real time" for a 1 ms timer to tick against anyway (and a
    /// gate never exists under stepped either, § invariant #7 R93). Called from
    /// `sync_sources` (both the main tick's own call and `after_dispatch`'s), so a gain
    /// animation a handler just added (`animate`, `transition`) or the recipe just added
    /// (`Transitions::tick`, one loop iteration later) is armed promptly. Cheap when
    /// it's a no-op: one bounded scan of the `Animator`'s own (small) entry list plus
    /// one of `pause_gates` (equally small), no allocation.
    pub(crate) fn arm_gain_timer_if_needed(&mut self) {
        if self.gain_timer_armed || self.stepped() || !self.gain_work_pending() {
            return;
        }
        self.gain_timer_armed = true;
        if let Err(e) = self.handle.insert_source(
            Timer::from_duration(GAIN_TICK_PERIOD),
            |deadline, _, rt: &mut Runtime| rt.gain_fast_tick(deadline),
        ) {
            self.gain_timer_armed = false;
            log::event(
                "runtime",
                Level::Warn,
                "loop.gain_timer_failed",
                None,
                json!({ "error": e.to_string() }),
            );
        }
    }

    /// Whether the fast gain timer has anything to push (M1, final review): a gain
    /// animation that is live **and moving** — started or starting within one main tick
    /// (the next main tick re-checks), and not frozen by the player pause (the main
    /// Animator's clock stops then; a teardown ramp's doesn't) — or a pause gate mid-ramp.
    /// A placeholder far in the future (a restored source's fade-in before `Ready`) or a
    /// transition paused mid-ramp no longer keeps 1000 wakeups/s going.
    fn gain_work_pending(&self) -> bool {
        let horizon = self.tick_period;
        (!self.player_paused && self.anim.has_live_gain(self.now(), horizon))
            || self.teardown_anim.has_live_gain(self.base_now(), horizon)
            || self.setting_anim.has_live_gain(self.base_now(), horizon)
            || self.has_active_pause_gate_ramp()
    }

    /// R90: one fire of the fast gain timer — evaluates only `gain.*` animations at the
    /// current (pause-adjusted) [`Runtime::now`], `graph.set`s each, then forwards just
    /// those changes straight to their hosted sources (`SourceHost::push_gain`, the same
    /// direct-apply bypass pattern as the R88 pause gate's `force_paused`) instead of
    /// the ordinary per-tick `sync` — which would also scan for opened/gone sources and
    /// compose `player_paused`, neither of which a gain push needs — then removes them
    /// from the pending-changes queue (`Graph::drain_gain_changes`) so the next ordinary
    /// `sync_sources` never replays what this call already hand-delivered. The main
    /// timer keeps doing everything else at the output refresh (R47 unchanged — this
    /// timer only ever touches gain paths).
    ///
    /// **Pause (R88/invariant #7).** While `player.paused`, [`Runtime::now`] is frozen
    /// (excised, never merely stopped-and-later-jumped) — calling `tick_gains` with an
    /// unchanged `now` would just keep re-emitting the same already-sent value, so
    /// *that* loop skips evaluating entirely while paused: zero Animator pushes for the
    /// whole pause. [`push_pause_gate_ramps`](Self::push_pause_gate_ramps) still runs
    /// unconditionally, though — a `Pausing` gate's ramp exists *because* the player is
    /// paused, and is deliberately wall-clock timed for exactly that reason.
    ///
    /// **Self-disarm.** The instant no `gain.*` animation remains *and* no pause gate
    /// is mid-ramp — including whichever of the two armed this very call, finishing on
    /// it — this returns `TimeoutAction::Drop`, removing its own calloop registration;
    /// `arm_gain_timer_if_needed` re-inserts a fresh one the next time either appears.
    fn gain_fast_tick(&mut self, deadline: Instant) -> TimeoutAction {
        self.stats.gain_ticks += 1;
        // A `set player.paused` reaching the graph and `Runtime::sync_sources` noticing
        // it (which is what actually freezes `now()` via `update_player_paused`) are two
        // separate steps in the main tick/`after_dispatch` path, but this timer is its
        // own calloop source: if it fires within the same dispatch batch as the client
        // request that just paused, *before* `after_dispatch` gets to run
        // `sync_sources`, the cached `self.player_paused` field would still read stale
        // (`false`) and `self.now()` would hand back the real, still-advancing clock
        // instead of the frozen one — exactly the race `drive_pause_gates_pre_sync`'s
        // own doc warns about for the R88 gate. Calling this directly (cheap: one graph
        // read, a no-op if nothing changed) closes it the same way the main `tick()`
        // does as its own first line.
        self.update_player_paused();
        // I1: teardown ramps run on the unpaused clock — pushed whether paused or not.
        for (path, v) in self.teardown_anim.tick_gains(self.base_now()) {
            if self.graph.set_animated(&path, PropValue::F64(v)).is_err() {
                self.teardown_anim.cancel_target(&path);
            }
        }
        for (path, v) in self.setting_anim.tick_gains(self.base_now()) {
            if self.graph.set_animated(&path, PropValue::F64(v)).is_err() {
                self.setting_anim.cancel_target(&path);
            }
        }
        if !self.player_paused {
            let now = self.now();
            for (path, v) in self.anim.tick_gains(now) {
                if let Err(e) = self.graph.set_animated(&path, PropValue::F64(v)) {
                    // The node went away under the animation (destroyed, output
                    // unplugged) — same handling as `run_anims`.
                    self.anim.cancel_target(&path);
                    log::event(
                        "runtime",
                        Level::Debug,
                        "anim.dropped",
                        None,
                        json!({ "path": path.0, "error": e.to_string() }),
                    );
                }
            }
        }
        // R90 fix round: the R88 pause gate's own ramp is deliberately *not* an
        // Animator animation at all (its `Pausing` state exists only while
        // `player.paused` — which is exactly what freezes `Runtime::now()`, R75 — so it
        // has to be wall-clock timed) — `tick_gains` above never touches it. Push its
        // current value here too, unconditionally (never gated on `player_paused`: a
        // `Pausing` ramp runs *while* paused, and a `Resuming` one starts the instant
        // it's un-paused, which can be before the next main tick even notices).
        self.push_pause_gate_ramps();

        let gains = self.graph.drain_gain_changes();
        if !gains.is_empty() {
            let t_mono_ms = log::mono_now().unwrap_or_default().as_secs_f64() * 1000.0;
            for (path, v) in &gains {
                let Some((id, prop)) = path.0.split_once('.') else {
                    continue;
                };
                self.host.push_gain(id, prop, v);
                if let PropValue::F64(db) = v {
                    self.stats.record_gain_push(t_mono_ms, *db);
                }
            }
            // R90 fix round: the dropout detector's `GainHistory` must be sampled at
            // the same (fast) rate as what's actually pushed, or its "expected"
            // envelope — held at the *coarse* bin's last recorded value for the
            // `drops` check (`gain_at`, nearest-previous) — goes stale mid-ramp:
            // measured on-machine, a 60 Hz `record_gain_history` (main tick only)
            // against a now-1 kHz-smooth real ramp produced false `drops` of 10–30 ms
            // / 16–52 dB at the exact point `GainLinear`'s dB curve steepens (most of
            // a linear-amplitude ramp's dB range lands in its last ~30% of progress —
            // invariant #2). Recording here too keeps the two in lockstep: only while
            // a gain animation or gate ramp is actually pushing (bounded bursts, same
            // lifetime as the fast timer itself), never a sustained 1 kHz cost.
            self.record_gain_history();
        }
        if !self.gain_work_pending() {
            self.gain_timer_armed = false;
            return TimeoutAction::Drop;
        }
        let next = deadline + GAIN_TICK_PERIOD;
        let now = Instant::now();
        TimeoutAction::ToInstant(if next <= now {
            now + GAIN_TICK_PERIOD
        } else {
            next
        })
    }

    /// R90 fix round: whether any R88 pause gate is currently mid-ramp (`Pausing` or
    /// `Resuming`) — the fast gain timer's other arming condition alongside
    /// `Animator::has_live_gain`, since the gate's ramp isn't an Animator animation.
    fn has_active_pause_gate_ramp(&self) -> bool {
        self.pause_gates.values().any(PauseGate::flowing)
    }

    /// R90 fix round: pushes the current wall-clock-computed `gain.pause` value for every
    /// open `Pausing`/`Resuming` gate — the same formula (`PauseGate::ramp_db`)
    /// `drive_pause_gates_pre_sync` uses for its own per-tick write, so the two never
    /// disagree. State transitions stay `drive_pause_gates_pre_sync`'s job alone.
    fn push_pause_gate_ramps(&mut self) {
        for (id, st) in &self.pause_gates {
            if let Some(db) = st.ramp_db() {
                let _ = self
                    .graph
                    .set(&p(&format!("{id}.gain.pause")), PropValue::F64(db));
            }
        }
    }

    fn sync_wake_regs(&mut self) {
        let live: BTreeMap<String, RawFd> = self.host.wake_fds_by_id().into_iter().collect();
        let gone: Vec<String> = self
            .wake_regs
            .iter()
            .filter(|(id, (fd, _))| live.get(*id) != Some(fd))
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
            if let Some((_, tok)) = self.wake_regs.remove(&id) {
                self.handle.remove(tok);
            }
        }
        for (id, fd) in live {
            if self.wake_regs.contains_key(&id) {
                continue;
            }
            // A dup: the registration owns its own fd, so the source closing its eventfd
            // can never leave a dangling (or reused-number) registration behind.
            let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if dup < 0 {
                continue;
            }
            let owned = unsafe { OwnedFd::from_raw_fd(dup) };
            let src = Generic::new(owned, Interest::READ, Mode::Level);
            let woke: Rc<str> = Rc::from(id.as_str());
            match self.handle.insert_source(src, move |_, _, rt: &mut Runtime| {
                rt.wake_pending = true;
                if !rt.woken.iter().any(|w| Rc::ptr_eq(w, &woke)) {
                    rt.woken.push(woke.clone());
                }
                rt.stats.wakes += 1;
                Ok(PostAction::Continue)
            }) {
                Ok(tok) => {
                    self.wake_regs.insert(id, (fd, tok));
                }
                Err(e) => log::event(
                    "runtime",
                    Level::Warn,
                    "loop.register_failed",
                    None,
                    json!({ "id": id, "error": e.to_string() }),
                ),
            }
        }
    }

    /// Update every source (render pending frames, never blocks), log + collect events.
    pub(crate) fn update_sources(&mut self) {
        self.woken.clear();
        self.feed_visualisers();
        self.host.update(&self.gfx, &mut self.graph);
        self.record_scene_envelopes();
        self.after_update(true);
    }

    /// F6b: a wake's update — only the sources whose wake fd fired (`woken`); the
    /// per-source bookkeeping of every other source waits for the next tick.
    fn update_woken_sources(&mut self) {
        let woken = std::mem::take(&mut self.woken);
        self.feed_visualisers_of(Some(&woken));
        self.host.update_only(&self.gfx, &mut self.graph, &woken);
        self.record_scene_envelopes_of(woken.iter().map(|w| &**w));
        self.woken = woken;
        self.woken.clear();
        self.after_update(false);
    }

    /// What follows a source update: the redraw marks of the sources that changed, their
    /// events (logged, queued for the recipes); `all` = a full pass (also forgets the
    /// per-source state of sources that are gone).
    fn after_update(&mut self, all: bool) {
        let changed = self.host.take_changed();
        // Phase 2 Task 8: a scene's new frame wakes each output at most at that output's
        // `eff(scene_fps, refresh)` (one worker serves every output showing it, D1).
        let host = &self.host;
        let callbacks = self.backend.kind() == "wayland";
        self.redraw.mark_shown_gated(
            self.routes.of(&self.graph),
            &changed,
            Instant::now(),
            |src, _, route| scene_gate_period(host, src, route, callbacks),
        );
        let mut errored = false;
        for (id, ev) in self.host.events() {
            let (kind, level, fields) = match &ev {
                SourceEvent::Ready => ("source.ready", Level::Info, json!({ "id": id })),
                SourceEvent::Ended => ("source.ended", Level::Info, json!({ "id": id })),
                SourceEvent::Position(t) => {
                    ("source.position", Level::Debug, json!({ "id": id, "t": t }))
                }
                // SourceHost already logged these (`source.error`/`source.rejected`).
                SourceEvent::Error { reason } => ("", Level::Warn, json!({ "reason": reason })),
                SourceEvent::Rejected { prop, reason } => {
                    ("", Level::Warn, json!({ "prop": prop, "reason": reason }))
                }
                // Task 16c, R85: logged at debug — common (every un-pause) and only
                // interesting when hunting an onset-timeout.
                SourceEvent::AudioFlowing => {
                    ("source.audio_flowing", Level::Debug, json!({ "id": id }))
                }
            };
            if !kind.is_empty() {
                log::event("source", level, kind, None, fields);
            }
            let name = match &ev {
                SourceEvent::Ready => "ready".to_string(),
                SourceEvent::Ended => "ended".to_string(),
                SourceEvent::Position(t) => format!("position {t:.3}"),
                SourceEvent::Error { reason } => format!("error: {reason}"),
                SourceEvent::Rejected { prop, reason } => format!("rejected {prop}: {reason}"),
                SourceEvent::AudioFlowing => "audio_flowing".to_string(),
            };
            self.last_event.insert(id.clone(), name);
            // Task 10: a source that broke (a scene past its restart budget is saved
            // `broken`) is news for the snapshot even when no graph change came with it.
            errored |= matches!(ev, SourceEvent::Error { .. });
            self.src_events.push((id, ev));
        }
        if errored {
            self.snapshot_dirty();
        }
        if all {
            self.last_event
                .retain(|id, _| self.graph.kind_of(id) == Some(NodeKind::Source));
            self.fade_in
                .retain(|id, _| self.graph.kind_of(id) == Some(NodeKind::Source));
        }
    }

    /// I6 (final review): resolve this iteration's held onsets — the runtime's own
    /// (`onsets`: unpark) and every restored source's fade-in (`fade_in`), which starts
    /// once the source is `Ready` **and** its audio flows (or `ONSET_TIMEOUT` after
    /// `Ready`; at once for a source with no audio). A restored source that errors
    /// instead has its placeholder dropped (M1).
    fn drive_onsets(&mut self, evs: &[(String, SourceEvent)], now: Duration) {
        let g = &self.graph;
        self.onsets
            .retain(|id| g.kind_of(id) == Some(NodeKind::Source));
        self.onsets.tick(evs, &mut self.anim, now, "runtime");
        if self.fade_in.is_empty() {
            return;
        }
        let mut start = Vec::new();
        let mut failed = Vec::new();
        for (id, w) in self.fade_in.iter_mut() {
            for (eid, ev) in evs {
                if eid != id {
                    continue;
                }
                match ev {
                    SourceEvent::Ready => {
                        w.ready_at.get_or_insert(now);
                    }
                    SourceEvent::AudioFlowing => w.flowed = true,
                    SourceEvent::Error { .. } => failed.push(id.clone()),
                    _ => {}
                }
            }
            let Some(ready_at) = w.ready_at else {
                continue;
            };
            let no_audio = !onset::has_audio(&self.graph, id);
            if w.flowed || no_audio {
                start.push((id.clone(), if no_audio { "no_audio" } else { "flowed" }));
            } else if now >= ready_at + ONSET_TIMEOUT {
                log::event(
                    "runtime",
                    Level::Warn,
                    "runtime.onset_timeout",
                    Some(CorrId(RESTORE_FADE.into())),
                    json!({ "id": id, "slot": "anticlick" }),
                );
                start.push((id.clone(), "timeout"));
            }
        }
        for id in failed {
            self.fade_in.remove(&id);
            if self.restore_fade_pending(&id) {
                self.anim.cancel_target(&p(&format!("{id}.gain.anticlick")));
            }
        }
        for (id, reason) in start {
            self.fade_in.remove(&id);
            self.start_restore_fade(&id, reason);
        }
    }

    /// Task 16c (R88): advance every player-pause anticlick gate (see [`PauseGate`]) and
    /// return the ids to exclude from the `player_paused` composition this sync (the
    /// gates still ramping down). Runs from [`Runtime::sync_sources`], *before*
    /// `SourceHost::sync` — a tick that both applies a `player.paused` edge and calls
    /// `sync` must never let `sync` compose the plain, un-excluded `player_paused` for a
    /// newly-eligible id even once, or it gets paused instantly, before the gate
    /// protecting it exists. Resolving `AwaitingFlow` needs this tick's events, so it
    /// stays in `drive_pause_gates_post_update` (from `finish_tick`).
    ///
    /// **Eligibility (final review I2).** Every source with audio that is playing (not
    /// node-paused — a source the recipe holds paused is silent already), not being
    /// retired, not parked. The gate ramps its own `gain.pause` slot, so it composes with
    /// whatever the recipe does to the same source on `xfade`/`anticlick` (a pending
    /// `align: end` switch's A, both sides of a running full-live crossfade, a ramping
    /// grave): the recipe's clock is frozen while paused, the gate's isn't, and the slots
    /// sum. At the pause edge a playing, ready source gets a `Pausing` ramp; a source
    /// that becomes eligible later (opened, un-paused by the recipe, unparked — all while
    /// the player is already paused, so composed paused at once) starts `Paused`
    /// (`gain.pause` −96, silent), so its resume is a flow-gated ramp in like every other.
    fn drive_pause_gates_pre_sync(&mut self) -> BTreeSet<String> {
        // R93: explicitly inert under the stepped clock — mpv stays paused for good there
        // and the gate's wall-clock ramp has nothing to pace against.
        if self.stepped() {
            return BTreeSet::new();
        }
        let want_paused = self.player_paused();
        let edge = want_paused != self.pause_gate_prev;
        self.pause_gate_prev = want_paused;

        let destroying: BTreeSet<String> = self
            .pending_destroy
            .iter()
            .map(|(_, id, _)| id.clone())
            .collect();
        let parked = self.parked.as_ref().map(|pk| pk.id.clone());
        // R93: a gate never outlives its node, and never competes with a teardown/park.
        let abandoned: Vec<String> = self
            .pause_gates
            .keys()
            .filter(|id| {
                self.graph.kind_of(id) != Some(NodeKind::Source)
                    || destroying.contains(*id)
                    || parked.as_deref() == Some(id.as_str())
            })
            .cloned()
            .collect();
        for id in abandoned {
            self.abandon_pause_gate(&id);
        }

        if want_paused {
            if edge {
                // A gate still resuming from the previous pause turns straight back.
                let mut repause = Vec::new();
                for (id, st) in self.pause_gates.iter_mut() {
                    match st {
                        PauseGate::Resuming { .. } => {
                            let from_lin = db_to_lin(st.ramp_db().unwrap_or(0.0));
                            *st = PauseGate::Pausing {
                                started: Instant::now(),
                                from_lin,
                            };
                        }
                        PauseGate::AwaitingFlow { .. } => {
                            repause.push(id.clone());
                            *st = PauseGate::Paused;
                        }
                        PauseGate::Pausing { .. } | PauseGate::Paused => {}
                    }
                }
                for id in repause {
                    self.host.force_paused(&id, true);
                }
            }
            for id in self.graph.ids_of(NodeKind::Source) {
                if self.pause_gates.contains_key(&id)
                    || destroying.contains(&id)
                    || parked.as_deref() == Some(id.as_str())
                    || !onset::has_audio(&self.graph, &id)
                    || self.bool_prop(&id, "paused")
                {
                    continue;
                }
                let corr = log::new_corr("pp");
                let mono = log::mono_now().unwrap_or_default();
                let a = crate::recipes::transition::snapshot_source(&self.graph, &id);
                let b = crate::recipes::transition::AudioSourceSnapshot {
                    id: String::new(),
                    path: String::new(),
                    position: 0.0,
                    speed: 1.0,
                    loop_: false,
                    duration: None,
                };
                self.dropout_windows
                    .started(corr.0.clone(), mono, vec![a], b);
                log::event(
                    "runtime",
                    Level::Debug,
                    "player.pause_gate_opened",
                    Some(corr.clone()),
                    json!({ "id": id, "playing": edge && self.bool_prop(&id, "ready") }),
                );
                self.pause_gate_corr.insert(id.clone(), corr);
                let st = if edge && self.bool_prop(&id, "ready") {
                    let from_db = match self.graph.get(&p(&format!("{id}.gain.pause"))) {
                        Ok(PropValue::F64(db)) => db,
                        _ => 0.0,
                    };
                    PauseGate::Pausing {
                        started: Instant::now(),
                        from_lin: db_to_lin(from_db),
                    }
                } else {
                    // Composed paused already (or never played): silent — hold it at −96
                    // so the resume ramps it in on flowing audio.
                    let _ = self
                        .graph
                        .set(&p(&format!("{id}.gain.pause")), PropValue::F64(SILENT_DB));
                    PauseGate::Paused
                };
                self.pause_gates.insert(id, st);
            }
        } else if edge {
            // Resume: every `Paused` gate un-pauses and waits for real audio (unless its
            // own node got paused meanwhile — a park — then it's silent for good: drop it,
            // `gain.pause` back to 0 dB while mpv stays paused); a `Pausing` one that never
            // reached its pause ramps back from where it is.
            let mut unpause_now = Vec::new();
            let mut drop_now = Vec::new();
            let node_paused: BTreeSet<String> = self
                .pause_gates
                .keys()
                .filter(|id| self.bool_prop(id, "paused"))
                .cloned()
                .collect();
            for (id, st) in self.pause_gates.iter_mut() {
                match st {
                    PauseGate::Paused if node_paused.contains(id) => drop_now.push(id.clone()),
                    PauseGate::Paused => {
                        unpause_now.push(id.clone());
                        *st = PauseGate::AwaitingFlow {
                            requested: Instant::now(),
                        };
                    }
                    PauseGate::Pausing { .. } => {
                        let from_lin = db_to_lin(st.ramp_db().unwrap_or(SILENT_DB));
                        *st = PauseGate::Resuming {
                            started: Instant::now(),
                            from_lin,
                        };
                    }
                    PauseGate::AwaitingFlow { .. } | PauseGate::Resuming { .. } => {}
                }
            }
            for id in unpause_now {
                onset::held(&id, "pause", self.pause_gate_corr.get(&id).cloned());
                self.host.force_paused(&id, false);
            }
            for id in drop_now {
                self.abandon_pause_gate(&id);
                let _ = self
                    .graph
                    .set(&p(&format!("{id}.gain.pause")), PropValue::F64(0.0));
            }
        }

        let mut exclude = BTreeSet::new();
        let mut to_pause = Vec::new();
        let mut to_drop = Vec::new();
        for (id, st) in &self.pause_gates {
            let Some(db) = st.ramp_db() else {
                continue;
            };
            let _ = self
                .graph
                .set(&p(&format!("{id}.gain.pause")), PropValue::F64(db));
            match st {
                PauseGate::Pausing { started, .. } => {
                    exclude.insert(id.clone());
                    // Requirement #2: the ramp's own 30 ms plus a settle tail before the
                    // source is actually paused (gain pushes are async).
                    if started.elapsed() >= ANTICLICK + AUDIO_SETTLE_TAIL {
                        to_pause.push(id.clone());
                    }
                }
                PauseGate::Resuming { started, .. } if started.elapsed() >= ANTICLICK => {
                    to_drop.push(id.clone());
                }
                _ => {}
            }
        }
        for id in to_pause {
            self.host.force_paused(&id, true);
            self.pause_gates.insert(id.clone(), PauseGate::Paused);
            exclude.remove(&id);
        }
        for id in to_drop {
            // The exact final value: this tick's `ramp_db` read the clock just before the
            // `elapsed() >= ANTICLICK` check did, so it can be a hair under 0 dB (−0.0003
            // measured under load) and nothing would ever write the slot again.
            let _ = self
                .graph
                .set(&p(&format!("{id}.gain.pause")), PropValue::F64(0.0));
            self.pause_gates.remove(&id);
            if let Some(corr) = self.pause_gate_corr.remove(&id) {
                let mono = log::mono_now().unwrap_or_default();
                self.dropout_windows.done(&corr.0, mono);
                log::event(
                    "runtime",
                    Level::Debug,
                    "player.pause_gate",
                    Some(corr),
                    json!({ "id": id }),
                );
            }
        }
        exclude
    }

    /// The other half of the R88 gate (see `drive_pause_gates_pre_sync`'s doc): resolve
    /// any `AwaitingFlow` gate against this tick's source events — the same flow test and
    /// bound as every onset (`crate::onset`), on the gate's own wall clock; logged
    /// `player.pause_resume_onset_timeout` if the bound is hit.
    fn drive_pause_gates_post_update(&mut self, evs: &[(String, SourceEvent)]) {
        if self.pause_gates.is_empty() {
            return;
        }
        for (id, st) in &mut self.pause_gates {
            let PauseGate::AwaitingFlow { requested } = st else {
                continue;
            };
            let flowing = onset::flowed(evs, id);
            let timed_out = requested.elapsed() >= ONSET_TIMEOUT;
            if !flowing && !timed_out {
                continue;
            }
            if !flowing {
                log::event(
                    "runtime",
                    Level::Warn,
                    "player.pause_resume_onset_timeout",
                    None,
                    json!({ "id": id, "waited_ms": requested.elapsed().as_secs_f64() * 1000.0 }),
                );
            }
            onset::started(
                id,
                "pause",
                if flowing { "flowed" } else { "timeout" },
                requested.elapsed(),
                self.pause_gate_corr.get(id).cloned(),
            );
            *st = PauseGate::Resuming {
                started: Instant::now(),
                from_lin: 0.0,
            };
        }
    }

    /// Feed the transition recipe's held sources into the `srcs:` alias (R50).
    pub(crate) fn refresh_srcs(&mut self) {
        let (by_output, graves) = self.tr.held_sources();
        self.graph.set_transition_sources(by_output, graves);
    }

    /// Compose + present every output (a paced backend: only those due, see
    /// [`render_paced`](Self::render_paced)).
    fn render(&mut self) {
        if self.backend.paced() {
            self.render_paced();
            return;
        }
        let host = &self.host;
        let textures = |id: &str| host.texture(id);
        for o in self.backend.outputs() {
            let Some(fbo) = self.backend.target(&o.name) else {
                continue;
            };
            let id = format!("out:{}", o.name);
            if let Err(e) = self.composer.compose_output(
                &self.gfx,
                &self.graph,
                &mut self.cat,
                &id,
                &textures,
                fbo,
            ) {
                let key = format!("compose.failed {id} {e}");
                warn_limited(
                    &mut self.warned,
                    key,
                    "compose",
                    "compose.failed",
                    json!({ "output": id, "error": e }),
                );
            }
        }
        let now = Instant::now();
        for o in self.backend.outputs() {
            match self.backend.present(&self.gfx, &o.name) {
                Ok(()) => self
                    .frames
                    .entry(o.name.clone())
                    .or_insert_with(|| FrameStats::new(o.refresh_mhz, now))
                    .on_present(now),
                Err(e) => {
                    if let Some(st) = self.frames.get_mut(&o.name) {
                        st.on_present_failed(&e);
                    }
                    log::event(
                        "output",
                        Level::Warn,
                        "output.present_failed",
                        None,
                        json!({ "output": o.name, "error": e }),
                    )
                }
            }
        }
    }

    /// Paced presenting (Wayland): every output that can take a frame (its last frame
    /// callback arrived) is composed + presented if its picture changed since its last
    /// present or something animates on it (`crate::redraw`); otherwise it goes idle. Runs
    /// after every dispatch and at the end of each tick.
    pub(crate) fn render_paced(&mut self) {
        let now = self.now();
        self.redraw.promote_due(Instant::now());
        let rev = self.graph.picture_rev();
        let callbacks = self.backend.kind() == "wayland";
        for o in self.backend.outputs() {
            if !self.backend.frame_state(&o.name).is_some_and(|f| f.ready) {
                continue;
            }
            let route = self.routes.of(&self.graph).get(&o.name);
            let animating = redraw::animating_on(&self.anim, now, route)
                || route.is_some_and(|r| scene_paces_output(&self.host, r, callbacks));
            let stats = self
                .frames
                .entry(o.name.clone())
                .or_insert_with(|| FrameStats::new(o.refresh_mhz, Instant::now()));
            if !self.redraw.wants(&o.name, rev, animating) {
                stats.on_idle();
                continue;
            }
            let id = format!("out:{}", o.name);
            {
                let Some(fbo) = self.backend.target(&o.name) else {
                    continue;
                };
                let host = &self.host;
                let textures = |sid: &str| host.texture(sid);
                if let Err(e) = self.composer.compose_output(
                    &self.gfx,
                    &self.graph,
                    &mut self.cat,
                    &id,
                    &textures,
                    fbo,
                ) {
                    warn_limited(
                        &mut self.warned,
                        format!("compose.failed {id} {e}"),
                        "compose",
                        "compose.failed",
                        json!({ "output": id, "error": e }),
                    );
                }
            }
            match self.backend.present(&self.gfx, &o.name) {
                Ok(()) => {
                    if let Some(st) = self.frames.get_mut(&o.name) {
                        st.on_present(Instant::now());
                    }
                    self.redraw.drawn(&o.name, rev);
                }
                Err(e) => {
                    if let Some(st) = self.frames.get_mut(&o.name) {
                        st.on_present_failed(&e);
                    }
                    warn_limited(
                        &mut self.warned,
                        format!("output.present_failed {id}"),
                        "output",
                        "output.present_failed",
                        json!({ "output": id, "error": e }),
                    )
                }
            }
        }
    }

    /// Pointer samples from the backend → `out:<c>.pointer` `[x, y, buttons]` (observed), and
    /// (Phase 2 Task 7, mouse on) every scene on that output — both sides mid-transition (the
    /// `srcs:<c>` alias) — gets it in its own native pixels, mapped back through the main
    /// layer's fit/viewport (`scene::pointer`); a point in a letterbox bar reaches nobody.
    /// Returns the scene ids reached.
    pub(crate) fn pointer_events(&mut self) -> Vec<String> {
        let mut reached = Vec::new();
        for s in self.backend.take_pointer() {
            let _ = self.graph.set_observed(
                &p(&format!("out:{}.pointer", s.output)),
                PropValue::List(vec![s.x, s.y, s.buttons as f64]),
            );
            reached.extend(self.forward_pointer(&s.output, s.x, s.y, s.buttons));
        }
        reached
    }

    fn forward_pointer(&mut self, output: &str, x: f64, y: f64, buttons: u32) -> Vec<String> {
        let num = |g: &Graph, path: String| match g.get(&p(&path)) {
            Ok(PropValue::I64(i)) => i as f64,
            Ok(PropValue::F64(f)) => f,
            _ => 0.0,
        };
        let (ow, oh) = (
            num(&self.graph, format!("out:{output}.width")),
            num(&self.graph, format!("out:{output}.height")),
        );
        if ow < 1.0 || oh < 1.0 {
            return Vec::new();
        }
        let lay = format!("lay:{output}:main");
        let fit = match self.graph.get(&p(&format!("{lay}.fit"))) {
            Ok(PropValue::Str(s)) => s.parse().unwrap_or(crate::graph::Fit::Fill),
            _ => crate::graph::Fit::Fill,
        };
        let viewport = match self.graph.get(&p(&format!("{lay}.viewport"))) {
            Ok(PropValue::List(v)) if v.len() == 4 => [v[0], v[1], v[2], v[3]],
            _ => [0.0, 0.0, 1.0, 1.0],
        };
        let mut reached = Vec::new();
        for id in self.graph.resolve(&format!("srcs:{output}")) {
            let Some(sc) = self.host.scene_mut(&id) else {
                continue;
            };
            let Some(native) = sc.native() else { continue };
            let rect = crate::gfx::compose::fit_rect(
                (native[0], native[1]),
                (ow as u32, oh as u32),
                fit,
                viewport,
            );
            if let Some(uv) = crate::scene::pointer::to_source_uv(&rect, x, y) {
                let (nx, ny) = crate::scene::pointer::to_native_px(uv, native);
                sc.set_pointer(nx, ny, buttons);
                reached.push(id);
            }
        }
        reached
    }

    /// Phase 2 Task 7 (D4): every live scene that wants audio input gets the latest frame of
    /// the system-audio mix (`audio::sysmon`) on its next tick. The capture runs only while
    /// at least one does; the last one gone drops it on a helper thread (its PipeWire thread
    /// is joined there, never on the loop).
    pub(crate) fn feed_visualisers(&mut self) {
        self.feed_visualisers_of(None);
    }

    /// `only` = a wake's update (F6b): just those sources get the latest samples (the
    /// monitor keeps running — the tick's full pass decides whether anyone still wants it).
    fn feed_visualisers_of(&mut self, only: Option<&[Rc<str>]>) {
        let wants = |id: &str| {
            self.host
                .scene(id)
                .is_some_and(crate::sources::scene::SceneSource::wants_audio_input)
        };
        let want: Vec<String> = match only {
            Some(ids) => ids
                .iter()
                .filter(|id| wants(id))
                .map(|id| id.to_string())
                .collect(),
            None => self
                .host
                .scene_ids()
                .into_iter()
                .filter(|id| wants(id))
                .collect(),
        };
        if want.is_empty() {
            if only.is_some() {
                return;
            }
            // the auto-mute Signal (Task 14) shares the capture: it keeps it running
            if self.automute_wants_monitor() {
                if let Some(m) = &self.sysmon {
                    m.set_visual(false);
                }
                return;
            }
            if let Some(m) = self.sysmon.take() {
                let _ = std::thread::Builder::new()
                    .name("lia-sysmon-stop".into())
                    .spawn(move || drop(m));
            }
            return;
        }
        let mon = self
            .sysmon
            .get_or_insert_with(crate::audio::sysmon::SysMon::start);
        mon.set_visual(true);
        let frame = mon.frame();
        for id in want {
            if let Some(s) = self.host.scene_mut(&id) {
                s.set_input(frame.clone());
            }
        }
    }

    /// Phase 2 Task 7: `player.scene_assets` → the scenes' base opts. Re-resolved whenever
    /// the prop changes ("" = auto: `LIASCAPE_WE_ASSETS_DIR`, then every Steam library); the result
    /// is `player.scene_assets_resolved` ("" = none — a scene then errors naming
    /// `LIASCAPE_WE_ASSETS_DIR` / `player.scene_assets`, and `hello` offers no `scene`).
    pub(crate) fn update_scene_assets(&mut self) {
        let want = match self.graph.get(&p("player.scene_assets")) {
            Ok(PropValue::Str(s)) => s,
            _ => String::new(),
        };
        if self.scene_assets_for.as_ref() == Some(&want) {
            return;
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let explicit = (!want.is_empty()).then(|| PathBuf::from(&want));
        let r = crate::scene::assets::resolve(explicit.as_deref(), &home);
        let resolved = match &r {
            Ok(d) => {
                self.host
                    .set_base_opt("scene_assets", Some(json!(d.display().to_string())));
                self.host.set_base_opt("scene_assets_error", None);
                d.display().to_string()
            }
            Err(e) => {
                self.host.set_base_opt("scene_assets", None);
                self.host.set_base_opt("scene_assets_error", Some(json!(e)));
                String::new()
            }
        };
        log::event(
            "scene",
            if r.is_ok() { Level::Info } else { Level::Warn },
            "scene.assets",
            None,
            json!({ "requested": want, "resolved": r.as_ref().ok(), "error": r.as_ref().err() }),
        );
        let _ = self
            .graph
            .set_observed(&p("player.scene_assets_resolved"), PropValue::Str(resolved));
        self.scene_assets_for = Some(want);
    }

    /// Whether `kind: scene` sources can play here: the worker binary resolves, and WE's
    /// assets dir does (unless synthetic test scenes are allowed — D7). `Err` = why not.
    pub fn scenes_available(&self) -> Result<(), String> {
        if crate::paths::scene_worker_bin().is_none() {
            return Err(
                "liascape-scene-worker not found (LIASCAPE_SCENE_WORKER_BIN, next to liascape-player, \
                        PATH)"
                    .into(),
            );
        }
        if self.host.base_opt("allow_synthetic").is_some()
            || self.host.base_opt("scene_assets").is_some()
        {
            return Ok(());
        }
        Err(self
            .host
            .base_opt("scene_assets_error")
            .and_then(Value::as_str)
            .unwrap_or(crate::scene::assets::HINT)
            .to_string())
    }

    // ------------------------------------------------------------------ outputs

    /// Apply the backend's hotplug (graph `out:<name>` + its main layer; the timer period
    /// follows the max refresh).
    ///
    /// **Added (R59/R60):** its remembered output props (`layer`, …) are re-applied (Task
    /// 16). If the parked wallpaper was parked *for this connector* (a restored snapshot's
    /// output that wasn't present), it shows that; else it joins the live transition
    /// covering the first other output, if any (`Transitions::adopt_output` — it shows
    /// what that transition shows and goes through cancel/commit/handoff with it); else it
    /// shows `cur:` of the first output that has one; else, if a wallpaper is parked (no
    /// output was left), it shows that, unpaused and ramped back in over 30 ms.
    ///
    /// **Removed (R60):** the node + layer go; every live transition forgets the output
    /// (`Transitions::drop_output` — one left with no output is committed); then whatever
    /// that output alone showed or held (not shown by another layer, not held by a
    /// transition) is ramped to silence and destroyed (`retire`) — except, when no output
    /// is left at all, the last current wallpaper (a committed transition's B, else what
    /// the output showed), which is parked.
    pub(crate) fn apply_output_changes(&mut self) {
        self.backend.process(&self.gfx);
        for ch in self.backend.take_changes() {
            match ch {
                OutputChange::Added(info) => {
                    self.redraw.forget(&info.name);
                    self.frames.insert(
                        info.name.clone(),
                        FrameStats::new(info.refresh_mhz, Instant::now()),
                    );
                    self.output_added(info)
                }
                OutputChange::Removed(name) => {
                    self.redraw.forget(&name);
                    self.frames.remove(&name);
                    self.output_removed(&name)
                }
                OutputChange::Changed(info) => self.output_changed(info),
            }
        }
        for name in self.backend.take_redraws() {
            self.redraw.mark(&name);
        }
        self.refresh_srcs();
        let max_hz = self
            .backend
            .outputs()
            .iter()
            .map(|o| o.hz)
            .max()
            .unwrap_or(60)
            .max(1);
        self.tick_period = Duration::from_secs_f64(1.0 / max_hz as f64);
    }

    fn output_added(&mut self, info: OutputInfo) {
        let id = format!("out:{}", info.name);
        let others = self.graph.ids_of(NodeKind::Output);
        let current = self.current_wallpaper();
        let mut props = Map::new();
        props.insert("name".into(), json!(info.name));
        props.insert("width".into(), json!(info.width));
        props.insert("height".into(), json!(info.height));
        props.insert("refresh_hz".into(), json!(info.hz));
        if let Err(e) = self.graph.create(NodeKind::Output, Some(id.clone()), props) {
            log::event(
                "output",
                Level::Warn,
                "output.graph_error",
                None,
                json!({ "output": id, "error": e.to_string() }),
            );
            return;
        }
        if let Some(props) = self.out_props.remove(&info.name) {
            self.apply_props(&id, &props);
        }
        let layer = format!("lay:{}:main.content", info.name);
        let own_parked = self
            .parked
            .as_ref()
            .is_some_and(|pk| pk.connector.as_deref() == Some(info.name.as_str()));
        let adopted = if own_parked {
            None
        } else {
            others
                .iter()
                .find_map(|o| self.tr.adopt_output(&id, o, &mut self.graph))
        };
        let content = if own_parked && let Some(pk) = self.unpark() {
            let _ = self.graph.set(&p(&layer), PropValue::Str(pk.clone()));
            Some(json!(pk))
        } else if adopted.is_some() {
            self.graph.get(&p(&layer)).ok().map(|v| v.to_json())
        } else if let Some(cur) = &current {
            let _ = self.graph.set(&p(&layer), PropValue::Str(cur.clone()));
            Some(json!(cur))
        } else if let Some(pk) = self.unpark() {
            let _ = self.graph.set(&p(&layer), PropValue::Str(pk.clone()));
            Some(json!(pk))
        } else {
            None
        };
        self.cover_mirror();
        log::event(
            "output",
            Level::Info,
            "output.added",
            adopted,
            json!({ "output": id, "width": info.width, "height": info.height,
                    "hz": info.hz, "content": content }),
        );
    }

    /// Same output, new size/refresh: the graph's read-only props follow (observed).
    fn output_changed(&mut self, info: OutputInfo) {
        let id = format!("out:{}", info.name);
        for (prop, v) in [
            ("width", info.width),
            ("height", info.height),
            ("refresh_hz", info.hz),
        ] {
            let _ = self
                .graph
                .set_observed(&p(&format!("{id}.{prop}")), PropValue::I64(v as i64));
        }
        if let Some(st) = self.frames.get_mut(&info.name) {
            st.set_refresh(info.refresh_mhz);
        }
        self.redraw.mark(&info.name);
        log::event(
            "output",
            Level::Info,
            "output.changed",
            None,
            json!({ "output": id, "width": info.width, "height": info.height, "hz": info.hz,
                    "refresh_mhz": info.refresh_mhz }),
        );
    }

    /// `set_json` every prop of `props` on node `id` (snapshot / remembered values; a value
    /// the schema rejects is logged and skipped).
    fn apply_props(&mut self, id: &str, props: &Map<String, Value>) {
        for (k, v) in props {
            if let Err(e) = self.graph.set_json(&p(&format!("{id}.{k}")), v) {
                log::event(
                    "runtime",
                    Level::Warn,
                    "snapshot.prop_rejected",
                    None,
                    json!({ "node": id, "prop": k, "value": v, "error": e.to_string() }),
                );
            }
        }
    }

    /// Output `out:<name>`'s settable props that differ from their defaults.
    fn output_props(&self, name: &str) -> Map<String, Value> {
        let mut m = Map::new();
        for (prop, pd) in crate::graph::props::schema_for_kind(NodeKind::Output) {
            if pd.readonly {
                continue;
            }
            if let Ok(v) = self.graph.get(&p(&format!("out:{name}.{prop}")))
                && v != pd.default
            {
                m.insert(prop.to_string(), v.to_json());
            }
        }
        m
    }

    fn output_removed(&mut self, name: &str) {
        let id = format!("out:{name}");
        let layer = format!("lay:{name}:main");
        // Its settings outlive it: re-applied if this connector comes back (Task 16).
        let props = self.output_props(name);
        if props.is_empty() {
            self.out_props.remove(name);
        } else {
            self.out_props.insert(name.to_string(), props);
        }
        // What only this output may have shown or held.
        let mut candidates: BTreeSet<String> = self.shown_by(&layer);
        let (held, _) = self.tr.held_sources();
        candidates.extend(held.get(&id).cloned().unwrap_or_default());
        let cur_before = self
            .graph
            .resolve(&format!("cur:{name}"))
            .into_iter()
            .next();
        let _ = self.graph.destroy(&id);
        let now = self.now();
        let committed = self
            .tr
            .drop_output(&id, &mut self.graph, &mut self.anim, now);
        self.stash_tr_events();
        self.refresh_srcs();
        log::event(
            "output",
            Level::Info,
            "output.removed",
            None,
            json!({ "output": id, "committed": committed.iter().map(|(c, _)| c.0.clone()).collect::<Vec<_>>() }),
        );
        if self.graph.ids_of(NodeKind::Output).is_empty() {
            let last = committed
                .last()
                .map(|(_, b)| (b.clone(), true))
                .or(cur_before.map(|c| (c, false)));
            if let Some((pk, was_pending)) = last
                && self.graph.kind_of(&pk) == Some(NodeKind::Source)
            {
                self.park(&pk, was_pending, None);
                candidates.remove(&pk);
            }
        } else {
            for (_, b) in &committed {
                candidates.insert(b.clone());
            }
        }
        let (held, graves) = self.tr.held_sources();
        let held: BTreeSet<String> = held.into_values().flatten().chain(graves).collect();
        for c in candidates {
            let is_src = self.graph.kind_of(&c) == Some(NodeKind::Source);
            if !is_src
                || self.parked.as_ref().is_some_and(|pk| pk.id == c)
                || held.contains(&c)
                || self.str_prop(&c, "kind") == "snapshot"
                || self.shown_anywhere(&c)
            {
                continue;
            }
            self.retire(&c);
        }
    }

    fn str_prop(&self, id: &str, prop: &str) -> String {
        match self.graph.get(&p(&format!("{id}.{prop}"))) {
            Ok(PropValue::Str(s)) => s,
            _ => String::new(),
        }
    }

    fn bool_prop(&self, id: &str, prop: &str) -> bool {
        matches!(
            self.graph.get(&p(&format!("{id}.{prop}"))),
            Ok(PropValue::Bool(true))
        )
    }

    /// The sources layer `layer` shows (directly, or as either side of its effect).
    fn shown_by(&self, layer: &str) -> BTreeSet<String> {
        redraw::shown_by(&self.graph, layer)
    }

    fn shown_anywhere(&self, id: &str) -> bool {
        self.graph
            .ids_of(NodeKind::Layer)
            .iter()
            .any(|l| self.shown_by(l).contains(id))
    }

    /// What a newly added output shows: `cur:` of the first output that has one.
    fn current_wallpaper(&self) -> Option<String> {
        self.graph
            .ids_of(NodeKind::Output)
            .iter()
            .filter_map(|o| o.strip_prefix("out:"))
            .find_map(|c| self.graph.resolve(&format!("cur:{c}")).into_iter().next())
    }

    /// I1: ramp `id`'s `gain.anticlick` from its current value to silence over 30 ms on
    /// the **unpaused** base clock (`teardown_anim`) — the retire/park teardown, which
    /// must finish while the player is paused. The main Animator's ramp on the same slot
    /// (and any held onset of it) is dropped: one writer.
    fn teardown_ramp(&mut self, id: &str) {
        let path = p(&format!("{id}.gain.anticlick"));
        let cur = match self.graph.get(&path) {
            Ok(PropValue::F64(f)) => f,
            _ => 0.0,
        };
        self.anim.cancel_target(&path);
        self.onsets.cancel(id);
        self.tr.cancel_restore_onset(id);
        let now = self.base_now();
        self.teardown_anim.add(Animation {
            target: path,
            from: db_to_lin(cur),
            to: 0.0,
            start: now,
            duration: STOP_RAMP,
            curve: Curve::Linear,
            unit: AnimUnit::GainLinear,
            corr: None,
        });
    }

    /// Drop every animation and held onset on `id` (it's going now).
    fn forget_source_anims(&mut self, id: &str) {
        for slot in crate::units::GainSlot::ALL {
            let path = p(&format!("{id}.gain.{}", slot.as_str()));
            self.anim.cancel_target(&path);
            self.teardown_anim.cancel_target(&path);
            self.setting_anim.cancel_target(&path);
        }
        self.onsets.cancel(id);
        self.tr.cancel_restore_onset(id);
        self.fade_in.remove(id);
    }

    /// R93 (review of Task 16c/16d): drop `id`'s player-pause gate (if any) outright —
    /// closing its own dropout-probe window — wherever a gated source is retired,
    /// destroyed or parked. The gate's `gain.pause` value is left as it is (the caller
    /// decides: retire/park ramp `anticlick` to silence on top of it; a resume on a
    /// node-paused source resets it while silent).
    fn abandon_pause_gate(&mut self, id: &str) {
        if self.pause_gates.remove(id).is_none() {
            return;
        }
        if let Some(corr) = self.pause_gate_corr.remove(id) {
            let mono = log::mono_now().unwrap_or_default();
            self.dropout_windows.done(&corr.0, mono);
        }
    }

    /// Remove a source without a click (core invariant, item 10): an audible one is ramped
    /// to −96 over 30 ms (`gain.anticlick`) and destroyed when the ramp is over; a silent
    /// one — including one the player-level pause holds paused (I1) — goes at once.
    /// Returns the ramp length. Used by `destroy`, `stop`, output removal. The ramp runs on
    /// the unpaused clock and the source is kept out of the pause composition meanwhile,
    /// so a retire completes (and frees its decoder) while the player is paused.
    pub(crate) fn retire(&mut self, id: &str) -> Duration {
        if let Some((at, _, _)) = self.pending_destroy.iter().find(|(_, i, _)| i == id) {
            return at.saturating_sub(self.base_now()); // already on its way out
        }
        // Its audio still flows while paused only through a gate mid-ramp — decided
        // before the gate goes (R93: retire becomes the sole writer from here).
        let flowing_gate = self.pause_gates.get(id).is_some_and(PauseGate::flowing);
        self.abandon_pause_gate(id);
        if self.graph.kind_of(id) != Some(NodeKind::Source) {
            let _ = self.graph.destroy(id);
            return Duration::ZERO;
        }
        if self.parked.as_ref().is_some_and(|pk| pk.id == id) {
            self.parked = None;
            self.graph.set_parked(None);
        }
        let effectively_paused = self.player_paused && !flowing_gate;
        let mut corr = None;
        let ramp = if !onset::audible(&self.graph, id, effectively_paused) {
            self.forget_source_anims(id);
            let _ = self.graph.destroy(id);
            Duration::ZERO
        } else {
            // R80: a plain retire's own 30 ms anti-click ramp is a dropout-probe window
            // too — same mechanism as a transition's A, with a silent/empty "B".
            let a = crate::recipes::transition::snapshot_source(&self.graph, id);
            let b = crate::recipes::transition::AudioSourceSnapshot {
                id: String::new(),
                path: String::new(),
                position: 0.0,
                speed: 1.0,
                loop_: false,
                duration: None,
            };
            let mono = log::mono_now().unwrap_or_default();
            let c = log::new_corr("rt");
            self.dropout_windows.started(c.0.clone(), mono, vec![a], b);
            // Real time: the ramp runs on the unpaused clock (I1).
            self.dropout_windows.done(&c.0, mono + STOP_RAMP);
            corr = Some(c);
            self.teardown_ramp(id);
            let at = self.base_now() + STOP_RAMP;
            self.pending_destroy.push((at, id.to_string(), false));
            STOP_RAMP
        };
        log::event(
            "runtime",
            Level::Debug,
            "source.retire",
            corr,
            json!({ "id": id, "ramp_ms": ramp.as_secs_f64() * 1000.0 }),
        );
        ramp
    }

    /// R60: no output is left — keep the current wallpaper, silent and paused, until one
    /// comes back. `pending_b`: it's a transition's B that was never shown (it starts
    /// playing when unparked, whatever its pause state now). `connector`: parked for that
    /// connector (a restored output that isn't present) — shown when it appears. The park
    /// ramp runs on the unpaused clock (I1).
    fn park(&mut self, id: &str, pending_b: bool, connector: Option<String>) {
        if self.fade_in.remove(id).is_some() && self.restore_fade_pending(id) {
            // Parked = silent; unpark ramps it in from −96.
            self.anim.cancel_target(&p(&format!("{id}.gain.anticlick")));
        }
        let flowing_gate = self.pause_gates.get(id).is_some_and(PauseGate::flowing);
        self.abandon_pause_gate(id);
        self.onsets.cancel(id);
        let resume_paused = !pending_b && self.bool_prop(id, "paused");
        let silent = !onset::audible(&self.graph, id, self.player_paused && !flowing_gate);
        if silent {
            self.anim.cancel_target(&p(&format!("{id}.gain.anticlick")));
            let _ = self.graph.set(
                &p(&format!("{id}.gain.anticlick")),
                PropValue::F64(SILENT_DB),
            );
        } else {
            self.teardown_ramp(id);
        }
        let settle_at = self.base_now() + if silent { Duration::ZERO } else { STOP_RAMP };
        self.parked = Some(Parked {
            id: id.to_string(),
            resume_paused,
            settle_at: Some(settle_at),
            armed: silent,
            connector,
        });
        self.graph.set_parked(Some(id.to_string()));
        self.settle_parked(self.base_now());
        log::event(
            "runtime",
            Level::Info,
            "source.parked",
            None,
            json!({ "id": id, "resume_paused": resume_paused,
                    "connector": self.parked.as_ref().and_then(|pk| pk.connector.clone()) }),
        );
    }

    /// Once the park ramp is over: pause it, and put a transition's `xfade` at its final
    /// 0 dB (silent anyway at anticlick −96) so unparking only has to ramp anticlick back.
    /// `now` is the unpaused base clock.
    fn settle_parked(&mut self, now: Duration) {
        let Some(pk) = self.parked.as_mut() else {
            return;
        };
        if pk.settle_at.is_none_or(|at| at > now) {
            return;
        }
        if !pk.armed {
            pk.armed = true; // this tick sends the final −96; pause on the next one
            return;
        }
        pk.settle_at = None;
        let id = pk.id.clone();
        let _ = self
            .graph
            .set(&p(&format!("{id}.paused")), PropValue::Bool(true));
        let xf = p(&format!("{id}.gain.xfade"));
        self.anim.cancel_target(&xf);
        let _ = self.graph.set(&xf, PropValue::F64(0.0));
    }

    /// Show the parked wallpaper again: unpaused (unless it was paused before), ramped
    /// back in over 30 ms — on audio that is actually flowing (I6: the ramp waits for
    /// `AudioFlowing`, bounded). Returns its id.
    fn unpark(&mut self) -> Option<String> {
        let pk = self.parked.take()?;
        self.graph.set_parked(None);
        if self.graph.kind_of(&pk.id) != Some(NodeKind::Source) {
            return None;
        }
        let id = pk.id.clone();
        let anticlick = p(&format!("{id}.gain.anticlick"));
        // The park ramp (if it's still running) stops here; `gain.pause` (a gate it had)
        // goes back to 0 dB while anticlick still holds it silent.
        self.teardown_anim.cancel_target(&anticlick);
        let _ = self
            .graph
            .set(&p(&format!("{id}.gain.pause")), PropValue::F64(0.0));
        let was_held = self.bool_prop(&id, "paused");
        let _ = self.graph.set(
            &p(&format!("{id}.paused")),
            PropValue::Bool(pk.resume_paused),
        );
        let now = self.now();
        let cur = match self.graph.get(&anticlick) {
            Ok(PropValue::F64(f)) => f,
            _ => SILENT_DB,
        };
        if was_held && !pk.resume_paused {
            // A real un-pause: silent until its audio flows, then 30 ms in.
            let _ = self.graph.set(&anticlick, PropValue::F64(SILENT_DB));
            self.onsets.schedule(
                &self.graph,
                &mut self.anim,
                PendingOnset {
                    id: id.clone(),
                    slot: "anticlick",
                    from: 0.0,
                    to: 1.0,
                    dur: STOP_RAMP,
                    curve: Curve::Linear,
                    requested: now,
                    corr: None,
                },
                now,
            );
        } else {
            // Unparked mid-park-ramp (still playing) or staying paused: ramp back from
            // where it is — no un-pause, nothing to wait for.
            self.anim.add(Animation {
                target: anticlick,
                from: db_to_lin(cur),
                to: 1.0,
                start: now,
                duration: STOP_RAMP,
                curve: Curve::Linear,
                unit: AnimUnit::GainLinear,
                corr: None,
            });
        }
        log::event(
            "runtime",
            Level::Info,
            "source.unparked",
            None,
            json!({ "id": id }),
        );
        self.finish_parked_req(&id);
        Some(id)
    }

    /// I4: the `align: end` request parked with `b` is handed off now (an output shows
    /// it), or cancelled if `b` is no longer the parked wallpaper.
    fn finish_parked_req(&mut self, shown: &str) {
        let Some(req) = self.parked_req.take() else {
            return;
        };
        let at_ms = self.now().as_secs_f64() * 1000.0;
        if req.b == shown {
            log::event(
                "transition",
                Level::Info,
                "transition.handoff",
                Some(req.corr.clone()),
                json!({ "at_ms": at_ms, "to": req.b, "from": req.from.into_iter().collect::<Vec<_>>(),
                        "committed": true, "parked": true }),
            );
            log::event(
                "transition",
                Level::Info,
                "transition.done",
                Some(req.corr),
                json!({ "at_ms": at_ms, "to": req.b, "parked": true }),
            );
        } else {
            log::event(
                "transition",
                Level::Info,
                "transition.cancelled",
                Some(req.corr),
                json!({ "at_ms": at_ms, "reason": "superseded", "parked": true }),
            );
        }
    }

    /// I4 (final review): a `transition` while **no output exists** (R60 parked). It is
    /// accepted: B is created paused and silent and becomes the parked wallpaper (the old
    /// one is retired — it's paused and silent, so it goes at once), so a rotation keeps
    /// its place and the *last* target is what an output shows when one comes back. An
    /// `align: now` request is handed off at once; an `align: end` one waits for that
    /// output (the parked A is paused — its end can't come before) unless the parked A
    /// never ends (a scene or a still: `Now`, Phase 2 Task 9), and a newer parked
    /// request supersedes it. Events: `transition.scheduled` → `.handoff {committed,
    /// parked}` → `.done` (or `.cancelled {reason: "superseded"}`), corr `tr-<n>`.
    pub(crate) fn transition_parked(
        &mut self,
        req: crate::recipes::TransitionReq,
    ) -> Result<(CorrId, String), ApiError> {
        let kind = req.to.get("kind").and_then(Value::as_str).unwrap_or("");
        let path = req.to.get("path").and_then(Value::as_str).unwrap_or("");
        let hint =
            "see .claude/rules/player-core.md \u{a7} Runtime \"Outputs\"; `liascape-player ctl state`";
        if req.effect_id.as_deref() == Some("") {
            return Err(ApiError {
                code: "out_of_range",
                message: "effect_id must be a catalogue id, or null for a cut".into(),
                hint: hint.into(),
            });
        }
        if kind == "snapshot" {
            return Err(ApiError {
                code: "unsupported",
                message: "a transition's target can't be a snapshot source".into(),
                hint: hint.into(),
            });
        }
        if kind != "color" && path.is_empty() {
            return Err(ApiError {
                code: "out_of_range",
                message: "to.path must name a file (or set to.kind = \"color\")".into(),
                hint: hint.into(),
            });
        }
        let mut props = req.to.clone();
        props.insert("paused".into(), json!(true));
        props.insert("gain.anticlick".into(), json!(SILENT_DB));
        let b = self.graph.create(NodeKind::Source, None, props)?;
        let corr = log::new_corr("tr");
        let at_ms = self.now().as_secs_f64() * 1000.0;
        log::event(
            "transition",
            Level::Info,
            "transition.scheduled",
            Some(corr.clone()),
            json!({ "at_ms": at_ms, "outputs": [], "to": b, "path": path, "method": req.method,
                    "align": req.align, "effect_id": req.effect_id,
                    "duration_ms": req.duration_ms, "parked": true, "origin": req.origin }),
        );
        let old = self.parked.take().map(|pk| pk.id);
        // Phase 2 Task 9: a parked A that never ends (a scene, a still) has no end to wait
        // for — `align: end` is `Now`, exactly as in the recipe (`never_ends`).
        let wait_end = req.align == crate::recipes::transition::Align::End
            && !old
                .as_deref()
                .is_some_and(|o| crate::recipes::transition::never_ends(&self.graph, o));
        self.graph.set_parked(None);
        if let Some(prev) = self.parked_req.take() {
            log::event(
                "transition",
                Level::Info,
                "transition.cancelled",
                Some(prev.corr),
                json!({ "at_ms": at_ms, "reason": "superseded", "parked": true }),
            );
        }
        self.parked = Some(Parked {
            id: b.clone(),
            resume_paused: false,
            settle_at: None,
            armed: true,
            connector: None,
        });
        self.graph.set_parked(Some(b.clone()));
        if let Some(old) = &old
            && old != &b
        {
            self.retire(old);
        }
        if wait_end {
            self.parked_req = Some(ParkedReq {
                corr: corr.clone(),
                b: b.clone(),
                from: old,
            });
        } else {
            log::event(
                "transition",
                Level::Info,
                "transition.handoff",
                Some(corr.clone()),
                json!({ "at_ms": at_ms, "to": b, "from": old.into_iter().collect::<Vec<_>>(),
                        "committed": true, "parked": true }),
            );
            log::event(
                "transition",
                Level::Info,
                "transition.done",
                Some(corr.clone()),
                json!({ "at_ms": at_ms, "to": b, "parked": true }),
            );
        }
        log::event(
            "runtime",
            Level::Info,
            "source.parked",
            Some(corr.clone()),
            json!({ "id": b, "resume_paused": false, "connector": null, "replaced": true }),
        );
        Ok((corr, b))
    }

    // ------------------------------------------------------------------ stop / quit

    /// `stop`: every in-flight transition is dropped (`transition.cancelled {reason:
    /// "stopped"}`), every layer emptied, every source ramped to silence over 30 ms
    /// (invariant #4) and then destroyed — a source the player pause holds paused is
    /// silent and goes at once (I1). Then `player.paused` is cleared (I1, final review):
    /// as with legacy, a stop ends the session and the next wallpaper starts playing.
    /// `instant` (stepped clock / quit): silence and destroy now — virtual time won't move
    /// on by itself.
    pub(crate) fn stop_all(&mut self, instant: bool) -> Vec<String> {
        let now = self.now();
        // Phase 3: the session ends — every program goes (its pending switches with the
        // transitions below).
        for id in self.programs.destroy_all(&self.graph) {
            let _ = self.graph.destroy(&id);
        }
        for st in self.tr.status() {
            log::event(
                "transition",
                Level::Info,
                "transition.cancelled",
                Some(st.corr.clone()),
                json!({ "reason": "stopped", "at_ms": now.as_secs_f64() * 1000.0 }),
            );
        }
        if let Some(req) = self.parked_req.take() {
            log::event(
                "transition",
                Level::Info,
                "transition.cancelled",
                Some(req.corr),
                json!({ "reason": "stopped", "at_ms": now.as_secs_f64() * 1000.0, "parked": true }),
            );
        }
        self.tr = Transitions::new();
        self.anim = Animator::new();
        self.setting_anim = Animator::new();
        self.onsets = Onsets::new();
        for l in self.graph.ids_of(NodeKind::Layer) {
            let _ = self
                .graph
                .set(&p(&format!("{l}.content")), PropValue::Str(String::new()));
        }
        for fx in self.graph.ids_of(NodeKind::Effect) {
            let _ = self.graph.destroy(&fx);
        }
        let ids = self.graph.ids_of(NodeKind::Source);
        let corr = log::new_corr("stop");
        self.parked = None;
        self.graph.set_parked(None);
        if instant {
            for id in &ids {
                let path = p(&format!("{id}.gain.anticlick"));
                let _ = self.graph.set(&path, PropValue::F64(SILENT_DB));
            }
            self.sync_sources(); // the −96 reaches mpv before the source goes
            for id in &ids {
                self.forget_source_anims(id);
                let _ = self.graph.destroy(id);
            }
            self.pending_destroy.clear();
            self.teardown_anim = Animator::new();
            self.sync_sources();
        } else {
            for id in &ids {
                self.retire(id);
            }
        }
        // I1: the session ends here — whatever comes next plays (the stop ramps above
        // run on the unpaused clock, so they complete either way).
        let _ = self.graph.set(&p("player.paused"), PropValue::Bool(false));
        self.refresh_srcs();
        log::event(
            "runtime",
            Level::Info,
            "player.stopped",
            Some(corr),
            json!({ "sources": ids }),
        );
        ids
    }

    /// Destroy every retired source whose ramp is over — `now` is the unpaused base
    /// clock (I1) — then settle a parked wallpaper whose park ramp is over.
    fn destroy_due(&mut self, now: Duration) {
        let mut due = Vec::new();
        for (at, id, armed) in &mut self.pending_destroy {
            if *at <= now {
                if *armed {
                    due.push(id.clone());
                } else {
                    *armed = true; // this tick's sync carries the final −96 dB
                }
            }
        }
        self.pending_destroy.retain(|(_, id, _)| !due.contains(id));
        for id in due {
            self.forget_source_anims(&id);
            let _ = self.graph.destroy(&id);
        }
        self.settle_parked(now);
    }

    /// `quit`: stop (ramped on the real clock), then exit once that's done.
    pub(crate) fn begin_quit(&mut self, why: &str) {
        if self.quit_at.is_some() {
            return;
        }
        log::event(
            "runtime",
            Level::Info,
            "player.quitting",
            None,
            json!({ "why": why }),
        );
        // What was on screen, not the empty graph `stop` leaves (a later `--restore`).
        self.snapshot_final();
        let instant = self.stepped();
        self.stop_all(instant);
        self.quit_at = Some(Instant::now() + STOP_RAMP * 4);
    }

    fn should_exit(&self) -> bool {
        self.quit_at
            .is_some_and(|at| self.pending_destroy.is_empty() || Instant::now() >= at)
    }

    /// Final teardown: every source gone (cores to the reaper), the reaper joined with a
    /// bounded wait, stragglers logged. Returns the number of stragglers.
    fn shutdown(&mut self) -> usize {
        for id in self.graph.ids_of(NodeKind::Source) {
            let _ = self.graph.destroy(&id);
        }
        self.pending_destroy.clear();
        self.sync_sources();
        // a requested capture is still written (each bounded by its encode)
        self.capture.shutdown(&self.gfx);
        let t = Instant::now();
        self.host.finish_teardown(Duration::from_millis(500));
        // Phase 2: the render worker frees every render context it still holds (each before
        // its core goes to the reaper) and exits; one it couldn't free is a straggler too.
        let render_left = self.host.render_worker().map_or(0, |w| {
            let t = Instant::now();
            let left = w.shutdown(REAPER_WAIT);
            log::event(
                "runtime",
                if left > 0 { Level::Warn } else { Level::Info },
                "render_worker.stopped",
                None,
                json!({ "left": left, "waited_ms": t.elapsed().as_secs_f64() * 1000.0 }),
            );
            left
        });
        // I5: an async open still creating its core counts like a reaper straggler.
        let left =
            reaper::shutdown(REAPER_WAIT) + crate::sources::host::opening_pending() + render_left;
        if left > 0 {
            log::event(
                "runtime",
                Level::Warn,
                "mpv.reaper_stragglers",
                None,
                json!({ "count": left, "waited_ms": t.elapsed().as_secs_f64() * 1000.0 }),
            );
        }
        // R79 (review fix round): kills any in-flight dropout-probe ffmpeg decode
        // outright and joins its analysis thread, bounded the same way as the mpv
        // reaper above.
        let t_dropout = Instant::now();
        let dropout_left = dropout::shutdown(REAPER_WAIT);
        if dropout_left > 0 {
            log::event(
                "runtime",
                Level::Warn,
                "probe.dropout_analysis_stragglers",
                None,
                json!({
                    "count": dropout_left,
                    "waited_ms": t_dropout.elapsed().as_secs_f64() * 1000.0,
                }),
            );
        }
        // Every stream is gone: now the bus can go (nothing gets moved to the default sink).
        self.audio.close();
        self.snap.writer.finish(); // the final snapshot is on disk
        if let Some(tok) = self.snap.timer.take() {
            self.handle.remove(tok);
        }
        log::event(
            "runtime",
            Level::Info,
            "player.exit",
            None,
            json!({ "reaper_wait_ms": t.elapsed().as_secs_f64() * 1000.0 }),
        );
        self.flush_tap();
        for c in self.server.clients.values_mut() {
            c.flush();
        }
        left
    }

    // ------------------------------------------------------------------ snapshot

    /// A graph change: save [`snapshot::DEBOUNCE`] after the first unsaved one (a burst of
    /// changes = one write; a continuous animation can't postpone it).
    fn snapshot_dirty(&mut self) {
        if self.snap.frozen || self.snap.due.is_some() {
            return;
        }
        self.snap.due = Some(Instant::now() + snapshot::DEBOUNCE);
        if self.snap.timer.is_none() {
            // Only wakes the loop (the stepped clock has no tick timer); `after_dispatch`
            // writes it.
            self.snap.timer = self
                .handle
                .insert_source(
                    Timer::from_duration(snapshot::DEBOUNCE),
                    |_, _, rt: &mut Runtime| {
                        rt.snap.timer = None;
                        TimeoutAction::Drop
                    },
                )
                .ok();
        }
    }

    /// Write the snapshot if it's due: the debounce is over, or [`snapshot::REFRESH`]
    /// passed while a video plays (positions move without graph changes).
    pub(crate) fn snapshot_maybe(&mut self) {
        if self.snap.frozen {
            return;
        }
        if self.programs.def_dirty() || self.programs.resume_dirty() {
            self.snapshot_dirty(); // program.json / resume.json go with the next write
        }
        let now = Instant::now();
        let due = match self.snap.due {
            Some(d) => now >= d,
            None => {
                self.snap
                    .last_write
                    .is_none_or(|t| now.duration_since(t) >= snapshot::REFRESH)
                    && self.media_playing()
            }
        };
        if due {
            self.write_snapshot();
        }
    }

    /// A video or scene is playing: its position moves without graph changes, so the
    /// snapshot refreshes every `snapshot::REFRESH` — so does a program's play time.
    fn media_playing(&self) -> bool {
        (self.programs.any_started() && !self.player_paused)
            || self.graph.ids_of(NodeKind::Source).iter().any(|id| {
            onset::kind_has_audio(&self.str_prop(id, "kind"))
                && self.bool_prop(id, "ready")
                && !self.bool_prop(id, "paused")
        })
    }

    /// What `snapshot.json` would hold now (`crate::snapshot::capture`).
    pub(crate) fn capture_snapshot(&self) -> Snapshot {
        let status = self.tr.status();
        let mut snap = snapshot::capture(&snapshot::Capture {
            graph: &self.graph,
            anim: &self.anim,
            setting_anim: &self.setting_anim,
            transitions: &status,
            parked: self.parked.as_ref().map(|pk| snapshot::ParkedSnap {
                id: pk.id.clone(),
                resume_paused: pk.resume_paused,
                connector: pk.connector.clone(),
            }),
            remembered: &self.out_props,
        });
        snap.programs = self.programs.snaps();
        snap
    }

    fn write_snapshot(&mut self) {
        // Phase 3: `program.json` first (a definition changed), then the snapshot whose
        // program state names that revision.
        if self.programs.def_dirty() {
            let f = self.programs.program_file(&self.graph);
            self.snap
                .writer
                .send_file(crate::recipes::program::store::FILE, f.to_bytes());
        }
        if self.programs.resume_dirty() {
            let b = self.programs.resume_bytes();
            self.snap
                .writer
                .send_file(crate::recipes::program::resume::FILE, b);
        }
        let bytes = self.capture_snapshot().to_bytes();
        self.snap.writer.send(bytes);
        self.snap.last_write = Some(Instant::now());
        self.snap.due = None;
        if let Some(tok) = self.snap.timer.take() {
            self.handle.remove(tok);
        }
    }

    /// Exit (quit / SIGTERM / a lost compositor): queue the snapshot of what is on screen
    /// now and write no more — the teardown that follows empties the graph.
    fn snapshot_final(&mut self) {
        if self.snap.frozen {
            return;
        }
        self.programs.mark_def_dirty();
        self.programs.put_all_points(&self.graph); // quit: each playlist's resume point
        self.write_snapshot();
        self.snap.frozen = true;
    }

    /// `--restore`: load `<state>/snapshot.json` and recreate it; a corrupt or
    /// unknown-version file is moved aside (`snapshot.invalid.json`) and the player starts
    /// empty — never a crash loop over a bad file.
    fn restore_from_disk(&mut self, dir: &std::path::Path, session_start: bool) {
        match snapshot::load(dir) {
            Ok(Some(s)) => self.restore_snapshot(s, session_start),
            Ok(None) => log::event(
                "snapshot",
                Level::Info,
                "snapshot.none",
                None,
                json!({ "dir": dir.display().to_string() }),
            ),
            Err(reason) => {
                let moved = snapshot::set_aside(dir);
                log::event(
                    "snapshot",
                    Level::Warn,
                    "snapshot.invalid",
                    None,
                    json!({ "reason": reason,
                            "moved_to": moved.map(|m| m.display().to_string()),
                            "hint": "starting empty; the next snapshot replaces it" }),
                );
            }
        }
    }

    /// Recreate a snapshot (§ Snapshot): player props; each saved connector that is
    /// present gets its output props, main-layer settings and content (fresh source ids,
    /// at the saved positions); a saved connector that is missing keeps its props for
    /// when it appears, and its content — unless a present output shows it — is parked
    /// for that connector (R60: never lost); the saved parked wallpaper is shown on the
    /// outputs that show nothing, else parked again; a present connector the snapshot
    /// didn't know shows the current wallpaper (as hotplug would). Audible sources start
    /// silent and ramp in over 30 ms once ready.
    fn restore_snapshot(&mut self, mut snap: Snapshot, session_start: bool) {
        // § Playlist start: a session start of a `start_over` program never shows the item
        // it was on — that item isn't restored at all (the program starts afresh below).
        let starting_over = if session_start {
            self.starting_over(&mut snap)
        } else {
            BTreeMap::new()
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let age_ms = now_ms.saturating_sub(snap.saved_unix_ms);
        self.apply_props("player", &snap.player);
        let present: BTreeSet<String> = self
            .graph
            .ids_of(NodeKind::Output)
            .iter()
            .filter_map(|o| o.strip_prefix("out:"))
            .map(str::to_string)
            .collect();
        let empty =
            |rt: &Runtime, c: &str| rt.str_prop(&format!("lay:{c}:main"), "content").is_empty();
        let mut made: BTreeMap<String, String> = BTreeMap::new();
        let mut outputs = Vec::new();
        let mut missing = Vec::new();
        for (conn, o) in &snap.outputs {
            if !present.contains(conn) {
                if !o.props.is_empty() {
                    self.out_props.insert(conn.clone(), o.props.clone());
                }
                if let Some(c) = &o.content {
                    missing.push((conn.clone(), c.clone()));
                }
                continue;
            }
            self.apply_props(&format!("out:{conn}"), &o.props);
            self.apply_props(&format!("lay:{conn}:main"), &o.layer);
            if let Some(c) = &o.content
                && let Some(id) = self.restored_source(&snap, c, &mut made)
            {
                let _ = self
                    .graph
                    .set(&p(&format!("lay:{conn}:main.content")), PropValue::Str(id));
            }
            outputs.push(conn.clone());
        }
        for (conn, props) in &snap.output_props {
            if present.contains(conn) {
                self.apply_props(&format!("out:{conn}"), props);
            } else {
                self.out_props.insert(conn.clone(), props.clone());
            }
        }
        let mut dropped = Vec::new();
        for (conn, c) in missing {
            if made.contains_key(&c) {
                continue; // a present output shows it
            }
            if self.parked.is_some() {
                dropped.push(c);
                continue;
            }
            if let Some(id) = self.restored_source(&snap, &c, &mut made) {
                self.park(&id, false, Some(conn));
            }
        }
        if let Some(pk) = &snap.parked
            && !made.contains_key(&pk.id)
        {
            let blank: Vec<String> = present.iter().filter(|c| empty(self, c)).cloned().collect();
            if !blank.is_empty() {
                if let Some(id) = self.restored_source(&snap, &pk.id, &mut made) {
                    for c in blank {
                        let _ = self.graph.set(
                            &p(&format!("lay:{c}:main.content")),
                            PropValue::Str(id.clone()),
                        );
                    }
                }
            } else if self.parked.is_none() {
                if let Some(id) = self.restored_source(&snap, &pk.id, &mut made) {
                    self.park(&id, false, pk.connector.clone());
                }
            } else {
                dropped.push(pk.id.clone());
            }
        }
        for conn in &present {
            if !snap.outputs.contains_key(conn)
                && empty(self, conn)
                && let Some(cur) = self.current_wallpaper()
            {
                let _ = self
                    .graph
                    .set(&p(&format!("lay:{conn}:main.content")), PropValue::Str(cur));
            }
        }
        if !dropped.is_empty() {
            log::event(
                "snapshot",
                Level::Warn,
                "snapshot.dropped",
                None,
                json!({ "sources": dropped,
                        "why": "saved for connectors that aren't present, and only one wallpaper can be parked" }),
            );
        }
        log::event(
            "snapshot",
            Level::Info,
            "snapshot.restored",
            None,
            json!({ "sources": made.len(), "outputs": outputs, "age_ms": age_ms,
                    "parked": self.parked.as_ref().map(|pk| pk.id.clone()), "ids": made }),
        );
        self.restore_programs(&snap, &starting_over, session_start);
    }

    /// `--session-start`: every `program.json` program whose `start_mode` is `start_over`
    /// → the item it was on (id → path), and that item taken off the snapshot's outputs and
    /// parked slot so it is never created.
    fn starting_over(&self, snap: &mut Snapshot) -> BTreeMap<String, Option<String>> {
        use crate::recipes::program::store;
        let mut out = BTreeMap::new();
        let Ok(Some(file)) = store::load(&self.snap.writer.dir) else {
            return out;
        };
        for def in &file.programs {
            if def.props.get("start_mode").and_then(Value::as_str) == Some("resume") {
                continue;
            }
            let last = snap
                .programs
                .iter()
                .find(|x| x.id == def.id)
                .and_then(|x| x.current_path.clone());
            if let Some(path) = &last {
                let ids: BTreeSet<String> = snap
                    .sources
                    .iter()
                    .filter(|(_, s)| &s.path == path)
                    .map(|(k, _)| k.clone())
                    .collect();
                for o in snap.outputs.values_mut() {
                    if o.content.as_ref().is_some_and(|c| ids.contains(c)) {
                        o.content = None;
                    }
                }
                if snap.parked.as_ref().is_some_and(|pk| ids.contains(&pk.id)) {
                    snap.parked = None;
                }
            }
            out.insert(def.id.clone(), last);
        }
        out
    }

    /// Phase 3 (`recipes::program::store`): after the snapshot's sources, every program of
    /// `<state>/program.json` is created again and given its saved state
    /// (`Programs::restore`): current = what its first output shows (or the parked
    /// wallpaper) when that is its saved item.
    fn restore_programs(
        &mut self,
        snap: &Snapshot,
        starting_over: &BTreeMap<String, Option<String>>,
        session_start: bool,
    ) {
        use crate::recipes::program::store;
        let file = match store::load(&self.snap.writer.dir) {
            Ok(Some(f)) => f,
            Ok(None) => return,
            Err(reason) => {
                log::event(
                    "program",
                    Level::Warn,
                    "program.restore_failed",
                    None,
                    json!({ "reason": reason, "hint": "starting without programs" }),
                );
                return;
            }
        };
        for def in &file.programs {
            if let Err(e) = self
                .graph
                .create(NodeKind::Program, Some(def.id.clone()), def.props.clone())
            {
                log::event(
                    "program",
                    Level::Warn,
                    "program.restore_failed",
                    None,
                    json!({ "id": def.id, "reason": e.to_string() }),
                );
                continue;
            }
            let _ = self.programs.configure(&def.id, &mut self.graph);
            let outputs = match self.graph.get(&p(&format!("{}.outputs", def.id))) {
                Ok(PropValue::Str(s)) => s,
                _ => "out:*".to_string(),
            };
            let shown = self
                .graph
                .resolve(&outputs)
                .into_iter()
                .next()
                .and_then(|o| {
                    let c = o.strip_prefix("out:")?.to_string();
                    self.graph.resolve(&format!("cur:{c}")).into_iter().next()
                })
                .or_else(|| self.parked.as_ref().map(|pk| pk.id.clone()));
            let saved = snap.programs.iter().find(|x| x.id == def.id);
            let now = self.now();
            if let Some(last) = starting_over.get(&def.id) {
                // a session start, start over: its order only, then a fresh start (a cut)
                self.programs
                    .restore(&def.id, def, None, file.rev, None, &mut self.graph);
                let cat = &self.cat;
                let acts = self.programs.session_start(
                    &def.id,
                    last.as_deref(),
                    now,
                    &|e| cat.defaults(e),
                );
                self.run_program_actions(acts);
                continue;
            }
            self.programs
                .restore(&def.id, def, saved, file.rev, shown, &mut self.graph);
            if session_start {
                let cat = &self.cat;
                let acts =
                    self.programs
                        .session_start(&def.id, None, now, &|e| cat.defaults(e));
                self.run_program_actions(acts);
            }
        }
    }

    /// Whether `id`'s `gain.anticlick` animation is still the restore fade-in (not
    /// superseded by a recipe's or a park's ramp).
    fn restore_fade_pending(&self, id: &str) -> bool {
        self.anim
            .corr_of(&p(&format!("{id}.gain.anticlick")))
            .is_some_and(|c| c.0 == RESTORE_FADE)
    }

    /// A restored source is ready: start its 30 ms ramp in — unless something else took
    /// its `gain.anticlick` meanwhile (a transition's hold ramp: that one rules).
    fn start_restore_fade(&mut self, id: &str, reason: &str) {
        if !self.restore_fade_pending(id) {
            return;
        }
        onset::started(
            id,
            "anticlick",
            reason,
            Duration::ZERO,
            Some(CorrId(RESTORE_FADE.into())),
        );
        self.anim.add(Animation {
            target: p(&format!("{id}.gain.anticlick")),
            from: db_to_lin(SILENT_DB),
            to: 1.0,
            start: self.now(),
            duration: STOP_RAMP,
            curve: Curve::Linear,
            unit: AnimUnit::GainLinear,
            corr: Some(CorrId(RESTORE_FADE.into())),
        });
    }

    /// Create (once per saved id) the source the snapshot saved as `saved`. An audible one
    /// (a playing video) starts at `gain.anticlick` −96 and ramps in over 30 ms once ready
    /// (core invariant: a stream that will be heard starts silent): until then a
    /// not-yet-started animation to 0 dB holds its place (`fade_in`).
    fn restored_source(
        &mut self,
        snap: &Snapshot,
        saved: &str,
        made: &mut BTreeMap<String, String>,
    ) -> Option<String> {
        if let Some(id) = made.get(saved) {
            return Some(id.clone());
        }
        let s = snap.sources.get(saved)?;
        let mut props = s.create_props();
        // A video or a scene (its worker's stream, Phase 2) will be heard — not a scene
        // restored broken (Task 10: its preview, no worker, nothing to fade in).
        let audible = onset::kind_has_audio(&s.kind) && !s.paused && !s.broken;
        if audible {
            props.insert("gain.anticlick".into(), json!(SILENT_DB));
        }
        match self.graph.create(NodeKind::Source, None, props) {
            Ok(id) => {
                if audible {
                    // Starts "never" until `start_restore_fade` re-adds it at Ready.
                    self.anim.add(Animation {
                        target: p(&format!("{id}.gain.anticlick")),
                        from: db_to_lin(SILENT_DB),
                        to: 1.0,
                        start: self.now() + Duration::from_secs(365 * 24 * 3600),
                        duration: STOP_RAMP,
                        curve: Curve::Linear,
                        unit: AnimUnit::GainLinear,
                        corr: Some(CorrId(RESTORE_FADE.into())),
                    });
                    self.fade_in.insert(id.clone(), FadeWait::default());
                }
                made.insert(saved.to_string(), id.clone());
                Some(id)
            }
            Err(e) => {
                log::event(
                    "snapshot",
                    Level::Warn,
                    "snapshot.source_failed",
                    None,
                    json!({ "source": saved, "path": s.path, "error": e.to_string() }),
                );
                None
            }
        }
    }

    // ------------------------------------------------------------------ stepped mode

    /// `step {ms}` (stepped clock only). The reply is deferred until the step is done;
    /// meanwhile the client's later requests wait (per-client FIFO). At most
    /// [`STEP_QUEUE_MAX`] steps wait behind the running one.
    pub(crate) fn queue_step(
        &mut self,
        client: u64,
        req: Value,
        dt: Duration,
    ) -> Result<(), ApiError> {
        if self.step_queue.len() >= STEP_QUEUE_MAX {
            return Err(ApiError {
                code: "busy",
                message: format!("{STEP_QUEUE_MAX} steps are already queued"),
                hint: "wait for each `step` reply before sending the next".into(),
            });
        }
        self.step_queue.push_back((client, req, dt));
        self.advance_step();
        Ok(())
    }

    fn begin_step(&mut self, client: u64, req: Value, dt: Duration) {
        let t = Instant::now();
        if let ClockKind::Stepped(c) = &self.clock {
            c.step(dt);
        }
        self.cover_tick();
        self.automute_tick();
        self.update_player_paused();
        let now = self.now();
        self.run_anims(now);
        self.destroy_due(now);
        let t_sync = Instant::now();
        self.sync_sources();
        let sync_d = t_sync.elapsed();
        self.update_sources();

        let dt_s = dt.as_secs_f64();
        let mut waits = Vec::new();
        for id in self.host.ids() {
            // Phase 2 Task 5: a scene gets the same virtual time (no duration: never clamped
            // or wrapped) and ticks exactly it (`SceneSource::step_to`).
            let scene = self.host.scene(&id).is_some();
            let video = match self.host.mpv(&id) {
                Some(m) => crate::sources::Source::kind(m) == "video",
                None if scene => false,
                None => continue,
            };
            let num = |prop: &str| match self.graph.get(&p(&format!("{id}.{prop}"))) {
                Ok(PropValue::F64(f)) => f,
                Ok(PropValue::I64(i)) => i as f64,
                _ => 0.0,
            };
            let flag = |prop: &str| {
                matches!(
                    self.graph.get(&p(&format!("{id}.{prop}"))),
                    Ok(PropValue::Bool(true))
                )
            };
            let (paused, looped, speed, dur) =
                (flag("paused"), flag("loop"), num("speed"), num("duration"));
            let start = num("position");
            let lt = self.local.entry(id.clone()).or_insert(LocalTime {
                t: start,
                steps: 0,
                reset: None,
            });
            if let Some(r) = lt.reset.take() {
                lt.t = r;
            } else if lt.steps > 0 && !paused && !self.player_paused {
                // R75: player-level pause freezes virtual media time too, same as a
                // node-level pause — `step_seek` below then sees an unchanged target and
                // skips the seek entirely (§ Runtime "Stepped mode").
                lt.t += dt_s * speed;
            }
            lt.steps += 1;
            if dur > 0.0 {
                if looped {
                    lt.t = lt.t.rem_euclid(dur);
                } else {
                    lt.t = lt.t.clamp(0.0, dur);
                }
            }
            let at_end = video && !looped && dur > 0.0 && lt.t >= dur;
            let t_now = lt.t;
            if let Some(s) = self.host.scene_mut(&id) {
                s.step_to(t_now);
                let opened = !s.is_ready();
                waits.push(StepWait {
                    id,
                    t: t_now,
                    video: false,
                    seeked: true,
                    done: false,
                    opened,
                });
                continue;
            }
            if let Some(m) = self.host.mpv_mut(&id) {
                m.step_end(at_end);
            }
            waits.push(StepWait {
                id,
                t: t_now,
                video,
                seeked: false,
                done: false,
                opened: false,
            });
        }
        let hosted: BTreeSet<String> = self.host.ids().into_iter().collect();
        self.local.retain(|id, _| hosted.contains(id));

        let timer = self
            .handle
            // Only wakes the loop: `after_dispatch` → `advance_step` sees the deadline.
            .insert_source(
                Timer::from_duration(STEP_TIMEOUT),
                |_, _, _: &mut Runtime| TimeoutAction::Drop,
            )
            .ok();
        self.step = Some(PendingStep {
            client,
            req,
            deadline: Instant::now() + STEP_TIMEOUT,
            waits,
            timer,
            work: t.elapsed(),
            sync: sync_d,
        });
    }

    /// Run the step machinery as far as it goes now — iteratively: start the next queued
    /// step whenever none is running, re-check the running one, repeat while they finish.
    pub(crate) fn advance_step(&mut self) {
        loop {
            if self.step.is_none() {
                match self.step_queue.pop_front() {
                    Some((c, r, dt)) => self.begin_step(c, r, dt),
                    None => return,
                }
            }
            if !self.check_step() {
                return; // still waiting for frames
            }
        }
    }

    /// Re-check the running step: seek ready sources; when every frame is in (or the
    /// deadline passed) finish its tick and reply. `true` = it finished.
    fn check_step(&mut self) -> bool {
        let Some(mut st) = self.step.take() else {
            return true;
        };
        let t = Instant::now();
        self.update_sources();
        let mut opened_now = false;
        for w in st.waits.iter_mut().filter(|w| !w.done) {
            if let Some(s) = self.host.scene(&w.id) {
                let status = s.step_status();
                // Its worker came up during this step: the frame gets a STEP_TIMEOUT of its own.
                if w.opened && !matches!(status, StepStatus::Pending("ready")) {
                    w.opened = false;
                    opened_now = true;
                }
                if matches!(status, StepStatus::Done | StepStatus::Broken(_)) {
                    w.done = true;
                }
                continue;
            }
            let Some(m) = self.host.mpv_mut(&w.id) else {
                w.done = true; // gone meanwhile
                continue;
            };
            if !w.seeked {
                match m.step_status() {
                    StepStatus::Broken(_) => {
                        w.done = true;
                        continue;
                    }
                    _ if !m.is_ready() => {
                        w.opened = true;
                        continue;
                    }
                    _ => {}
                }
                w.seeked = true;
                opened_now |= w.opened;
                if w.video
                    && m.step_target() != Some(w.t)
                    && let Err(e) = m.step_seek(w.t)
                {
                    log::event(
                        "runtime",
                        Level::Warn,
                        "step.seek_failed",
                        None,
                        json!({ "id": w.id, "error": e.to_string() }),
                    );
                    w.done = true;
                    continue;
                }
            }
            match m.step_status() {
                StepStatus::Done | StepStatus::Broken(_) => w.done = true,
                StepStatus::Pending(_) => {}
            }
        }
        st.work += t.elapsed();
        // A fresh source's open (core, demux, first decoded frame) is not its frame's wait: once
        // it is ready, its seek gets a STEP_TIMEOUT of its own. Under load an open alone took
        // ~2 s, and the seek it then sent timed out at once (`t=0.000s, waiting for seek reply`).
        // Still bounded: a source not ready at the first deadline times out there (`ready`).
        if opened_now {
            st.deadline = Instant::now() + STEP_TIMEOUT;
            if let Some(tok) = st.timer.take() {
                self.handle.remove(tok);
            }
            st.timer = self
                .handle
                .insert_source(
                    Timer::from_duration(STEP_TIMEOUT),
                    |_, _, _: &mut Runtime| TimeoutAction::Drop,
                )
                .ok();
        }
        let all_done = st.waits.iter().all(|w| w.done);
        if !all_done && Instant::now() < st.deadline {
            self.step = Some(st);
            return false;
        }
        if let Some(tok) = st.timer.take() {
            self.handle.remove(tok);
        }
        let result = if all_done {
            Ok(())
        } else {
            let pending: Vec<String> = st
                .waits
                .iter()
                .filter(|w| !w.done)
                .map(|w| {
                    let status = self
                        .host
                        .mpv(&w.id)
                        .map(|m| m.step_status())
                        .or_else(|| self.host.scene(&w.id).map(|s| s.step_status()));
                    let what = match status {
                        Some(StepStatus::Pending(what)) => what,
                        _ => "?",
                    };
                    format!("{} (t={:.3}s, waiting for {what})", w.id, w.t)
                })
                .collect();
            Err(ApiError {
                code: "timeout",
                message: format!(
                    "step: no frame within {} s from {}",
                    STEP_TIMEOUT.as_secs(),
                    pending.join(", ")
                ),
                hint: "`liascape-player ctl probe '{\"name\":\"sources\"}'` shows each source's \
                       state; `ctl logs '{\"kind_prefix\":\"source.\"}'` its events"
                    .into(),
            })
        };
        if let Err(e) = &result {
            log::event(
                "runtime",
                Level::Warn,
                "step.timeout",
                None,
                json!({ "error": e.message }),
            );
        }
        self.finish_tick(st.work, st.sync);
        let now_ms = self.now().as_secs_f64() * 1000.0;
        self.respond(
            st.client,
            &st.req,
            result.map(|()| json!({ "now_ms": now_ms })),
        );
        // The client's requests queued behind this step may proceed now.
        if let Some(c) = self.server.clients.get_mut(&st.client) {
            c.awaiting = false;
            c.more_input = true;
        }
        true
    }

    // ------------------------------------------------------------------ API plumbing

    /// Route queued log events to subscribers (before any reply, so a command's events
    /// reach its own connection before its result).
    pub(crate) fn flush_tap(&mut self) {
        let dropped = self.tap.dropped();
        if dropped > self.tap_dropped_seen {
            self.tap_dropped_seen = dropped;
            warn_limited(
                &mut self.warned,
                "api.tap_overflow".into(),
                "api",
                "api.tap_overflow",
                json!({ "dropped_total": dropped,
                        "hint": "a subscriber's events outran the loop; narrow its topics" }),
            );
        }
        for _ in 0..8 {
            let evs = self.tap.drain();
            if evs.is_empty() {
                break;
            }
            self.server.route(&evs);
        }
    }

    /// Send a reply to `client`.
    pub(crate) fn respond(&mut self, client: u64, id: &Value, r: Result<Value, ApiError>) {
        self.flush_tap();
        let line = match &r {
            Ok(v) => proto::ok_line(id, v.clone()),
            Err(e) => proto::err_line(id, e),
        };
        if let Some(c) = self.server.clients.get_mut(&client) {
            c.send_line(&line);
        }
    }

    /// Read + handle what client `cid` sent; flush its output.
    pub(crate) fn client_io(&mut self, cid: u64, readable: bool, writable: bool) {
        if readable {
            let lines = match self.server.clients.get_mut(&cid) {
                // FIFO: nothing more is read while a deferred reply is outstanding.
                Some(c) if c.awaiting => Vec::new(),
                Some(c) => c.read_lines(),
                None => return,
            };
            let mut lines = lines.into_iter();
            while let Some(line) = lines.next() {
                let Some(c) = self.server.clients.get_mut(&cid) else {
                    return;
                };
                if c.dead.is_some() {
                    break;
                }
                if c.awaiting {
                    // Wait for the deferred reply; keep the rest, in order, for later.
                    c.unread(std::iter::once(line).chain(lines.by_ref()).collect());
                    break;
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                match proto::parse(&line) {
                    Ok(req) => match {
                        let t = Instant::now();
                        let r = handlers::handle(self, cid, &req);
                        self.stats.request(t.elapsed(), &req.cmd);
                        r
                    } {
                        Some(r) => self.respond(cid, &req.id, r),
                        None => {
                            // Deferred (`step`, `capture`) — unless answered at once.
                            if (self.step_pending_for(cid, &req.id)
                                || self.capture.pending_for(cid, &req.id))
                                && let Some(c) = self.server.clients.get_mut(&cid)
                            {
                                c.awaiting = true;
                            }
                        }
                    },
                    Err((id, e)) => self.respond(cid, &id, Err(e)),
                }
            }
        }
        if writable && let Some(c) = self.server.clients.get_mut(&cid) {
            c.flush();
        }
    }

    /// Register a freshly accepted client with the loop (edge-triggered, read + write).
    fn register_client(&mut self, cid: u64) {
        let Some(c) = self.server.clients.get_mut(&cid) else {
            return;
        };
        let src = Generic::new(ClientFd(c.raw_fd()), Interest::BOTH, Mode::Edge);
        match self
            .handle
            .insert_source(src, move |r, _, rt: &mut Runtime| {
                let t = Instant::now();
                rt.client_io(cid, r.readable || r.error, r.writable);
                let open = rt.host.take_open_time();
                rt.stats.busy(t.elapsed(), open);
                Ok(PostAction::Continue)
            }) {
            Ok(tok) => c.token = Some(tok),
            Err(e) => c.dead = Some(format!("loop registration failed: {e}")),
        }
    }

    /// After every dispatch: forward + update sources if mpv woke us, advance a pending
    /// step, read clients with input left, deliver events, drop dead clients.
    fn after_dispatch(&mut self) {
        let t = Instant::now();
        self.stats.iterations += 1;
        // Changes from handlers reach the sources promptly; mpv wakes update textures.
        if self.sync_due() {
            self.sync_sources();
        } else {
            self.arm_gain_timer_if_needed();
        }
        if self.wake_pending {
            self.wake_pending = false;
            self.update_woken_sources();
        }
        self.advance_step();
        if self.capture.in_flight() > 0 {
            self.pump_captures();
        }
        self.capture.expire_spare(&self.gfx);
        let more: Vec<u64> = self
            .server
            .clients
            .iter()
            .filter(|(_, c)| c.more_input && !c.awaiting && c.dead.is_none())
            .map(|(id, _)| *id)
            .collect();
        for cid in more {
            self.client_io(cid, true, false);
        }
        let open = self.host.take_open_time();
        self.stats.busy(t.elapsed(), open);
        self.flush_tap();
        for c in self.server.clients.values_mut() {
            c.flush();
            c.finish_eof();
        }
        let dead = self.server.take_dead();
        for mut c in dead {
            if let Some(tok) = c.token.take() {
                self.handle.remove(tok);
            }
            drop(c); // closes the socket, after its registration is gone
        }
        self.tap.set_topics(self.server.topics());
        self.snapshot_maybe();
    }

    /// F6b: whether this iteration's `sync_sources` could do anything the tick's own (every
    /// tick, at the highest refresh) wouldn't — a change to forward (a handler's `set`, a
    /// recipe's step), a node created or destroyed or re-routed, an async open finished, a
    /// low-VRAM stop/resume, a pause gate, a retire or a park in flight. Not on an iteration
    /// that only brought a worker frame (each one is a wake) or a fast gain push (which
    /// forwards its own changes): those `sync_sources` walked every source for nothing, and
    /// each worker frame paid for every worker. The stepped clock always syncs.
    fn sync_due(&self) -> bool {
        self.stepped()
            || self.graph.has_changes()
            || self.graph.picture_rev() != self.snap.seen_rev
            || self.graph.demand_rev() != self.synced_demand_rev
            || self.host.sync_pending()
            || !self.pause_gates.is_empty()
            || !self.pending_destroy.is_empty()
            || self.parked.as_ref().is_some_and(|pk| pk.settle_at.is_some())
    }

    fn has_more_input(&self) -> bool {
        self.server
            .clients
            .values()
            .any(|c| c.more_input && !c.awaiting && c.dead.is_none())
    }

    /// Hand finished GPU readbacks of `capture` to `lia-capture`; while one is still on the
    /// GPU a 1 ms timer re-polls it (a stepped loop has no tick to do it).
    pub(crate) fn pump_captures(&mut self) {
        self.capture.pump(&self.gfx, None);
        self.finish_captures();
        if self.capture_timer || !self.capture.waiting_gpu() {
            return;
        }
        self.capture_timer = true;
        if let Err(e) = self.handle.insert_source(
            Timer::from_duration(CAPTURE_POLL),
            |_, _, rt: &mut Runtime| {
                rt.capture.pump(&rt.gfx, None);
                rt.finish_captures();
                if rt.capture.waiting_gpu() {
                    TimeoutAction::ToDuration(CAPTURE_POLL)
                } else {
                    rt.capture_timer = false;
                    TimeoutAction::Drop
                }
            },
        ) {
            // every dispatch still pumps: a capture finishes at the next wake-up
            self.capture_timer = false;
            log::event(
                "runtime",
                Level::Warn,
                "loop.capture_timer_failed",
                None,
                json!({ "error": e.to_string() }),
            );
        }
    }

    /// Answer every `capture` whose file `lia-capture` finished writing (its buffer unmapped
    /// first); its client's later requests may proceed (a client has at most one deferred
    /// reply: nothing more is read from it meanwhile).
    pub(crate) fn finish_captures(&mut self) {
        for d in self.capture.take_done(&self.gfx) {
            self.respond(d.client, &d.id, d.result);
            if let Some(c) = self.server.clients.get_mut(&d.client) {
                c.awaiting = false;
                c.more_input = true;
            }
        }
    }

    /// Whether client `cid`'s request `req` is a step still running or queued.
    fn step_pending_for(&self, cid: u64, req: &Value) -> bool {
        self.step
            .as_ref()
            .is_some_and(|s| s.client == cid && &s.req == req)
            || self
                .step_queue
                .iter()
                .any(|(c, r, _)| *c == cid && r == req)
    }
}

/// Emit a warning at most once per [`WARN_EVERY`] per `key` (e.g. node + reason); the
/// next one carries `suppressed`: how many were swallowed meanwhile.
fn warn_limited(
    warned: &mut BTreeMap<String, (Instant, u64)>,
    key: String,
    comp: &'static str,
    kind: &str,
    mut fields: Value,
) {
    let now = Instant::now();
    match warned.get_mut(&key) {
        Some((at, n)) if now.duration_since(*at) < WARN_EVERY => {
            *n += 1;
        }
        e => {
            let suppressed = e.map_or(0, |(_, n)| *n);
            if let Value::Object(m) = &mut fields {
                m.insert("suppressed".into(), json!(suppressed));
            }
            log::event(comp, Level::Warn, kind, None, fields);
            warned.insert(key, (now, 0));
        }
    }
    if warned.len() > 1024 {
        warned.retain(|_, (at, _)| now.duration_since(*at) < WARN_EVERY);
    }
}

/// Block SIGINT/SIGTERM for the whole process (before any thread exists) and return a
/// signalfd that reports them — a clean `quit` instead of a kill.
fn signal_fd() -> Result<OwnedFd, String> {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::sigaddset(&mut set, libc::SIGTERM);
        if libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
            return Err("pthread_sigmask failed".into());
        }
        let fd = libc::signalfd(-1, &set, libc::SFD_NONBLOCK | libc::SFD_CLOEXEC);
        if fd < 0 {
            return Err(format!("signalfd: {}", std::io::Error::last_os_error()));
        }
        Ok(OwnedFd::from_raw_fd(fd))
    }
}

/// `liascape-player serve [--headless …]`: run until `quit` / SIGINT / SIGTERM (or the Wayland
/// connection is lost — then every source is silenced and torn down, and it returns `Err`).
pub fn serve(opts: ServeOpts) -> Result<(), ServeError> {
    crate::mem::apply_policy(); // Task 20b: allocator policy, first thing (before the mpv cores exist)
    if opts.wayland {
        crate::wl::apply_driver_env(); // Task 20e: before any thread (setenv) and before EGL
    }
    supervise::make_sent_faults_fatal(); // `kill -SEGV` crashes, never shrugged off
    let sigfd = signal_fd()?;
    log::init(&opts.state_dir, opts.log_level).map_err(|e| {
        format!(
            "event log in {}: {e} (set XDG_STATE_HOME to a writable directory)",
            opts.state_dir.display()
        )
    })?;
    crate::mem::log_policy();
    if opts.wayland {
        crate::wl::log_driver_env();
    }
    // R73: a restarted child says why, first thing (the supervisor has no socket).
    let restart_event = opts
        .supervised
        .as_ref()
        .and_then(|s| s.restart.as_ref())
        .map(|r| r.event_fields(supervise::mono_ms()));
    if let Some(f) = &restart_event {
        log::event(
            "supervisor",
            Level::Warn,
            "supervisor.restart",
            None,
            f.clone(),
        );
    }
    if std::env::var(supervise::TEST_CRASH_ENV).as_deref() == Ok("startup") {
        log::event(
            "runtime",
            Level::Warn,
            "test.crash",
            None,
            json!({ "env": supervise::TEST_CRASH_ENV }),
        );
        std::process::abort(); // test knob (tests/supervise.rs): crash at startup
    }
    let (listener, mut socket_file) = crate::api::server::bind(&opts.socket, opts.own_socket_dir)?;
    // Wayland: connect first (EGL needs the wl_display), then the context on it. Both
    // failure classes here are "compositor/EGL not available yet" (Task 16b) — the
    // supervisor retries these with backoff, unlike `bind`'s "already running" above.
    let wl = if opts.wayland {
        Some(crate::wl::Wayland::connect().map_err(ServeError::NoCompositor)?)
    } else {
        None
    };
    // The bus comes after the socket (a second instance exits above without touching
    // PipeWire) and the compositor connection (a start waiting for its compositor doesn't
    // load and unload a sink in the user's session on every retry). Its thread connects in
    // the background (never blocking serve on the audio server — cold boot, 2026-10-29)
    // while EGL and the catalogue come up; sources play into it unless `--ao` routes them
    // elsewhere (then there's none).
    let audio_started = Instant::now();
    let audio = Audio::start(opts.ao.as_deref());
    let (gfx, wl_source) = if let Some((wl, src)) = wl {
        let gfx = Gfx::new_wayland(wl.display_ptr())
            .map_err(|e| ServeError::NoCompositor(format!("EGL on Wayland: {e}")))?;
        (gfx, Some((wl, src)))
    } else {
        let gfx = Gfx::new_offscreen()
            .map_err(|e| ServeError::NoCompositor(format!("no EGL device: {e}")))?;
        (gfx, None)
    };
    crate::health::warm(); // the VRAM check, off the loop (hello.health)
    let cat = match Catalogue::resolve_dir() {
        Some(dir) => Catalogue::load(&dir).map_err(|e| format!("effect catalogue: {e}"))?,
        None => {
            log::event(
                "runtime",
                Level::Warn,
                "effects.missing",
                None,
                json!({ "hint": "no transitions/ directory resolved (LIASCAPE_TRANSITIONS_DIR, \
                                 ~/.local/lib/liascape/transitions, the repo); \
                                 only cuts are available" }),
            );
            Catalogue::empty()
        }
    };
    let composer = Composer::new(&gfx)?;

    let mut event_loop: EventLoop<'static, Runtime> =
        EventLoop::try_new().map_err(|e| format!("event loop: {e}"))?;
    let handle = event_loop.handle();
    let (ping, ping_src) = calloop::ping::make_ping().map_err(|e| format!("ping: {e}"))?;
    let tap = Arc::new(EventTap::new(ping));
    log::set_tap(Some(tap.clone()));

    // A bounded wait for the bus's first session, so a normal start (setup ~0.2 s, mostly
    // overlapped with the startup above) opens its sources straight onto the bus; past
    // `BUS_STARTUP_WAIT` from the start the loop runs anyway, sources open on mpv's default
    // device and move onto the bus when it comes up (`track_bus_route`).
    let bus_route = audio.wait_bus(audio_started, audio_started + BUS_STARTUP_WAIT);
    let mut base = Map::new();
    if let Some(ao) = &opts.ao {
        base.insert("ao".into(), json!(ao));
    }
    if let (Some(bus), Some((true, _))) = (&audio.bus, bus_route) {
        base.insert("audio_device".into(), json!(bus.device()));
        // Compensate what the bus adds; a source's own `audio_delay` adds to this.
        base.insert(
            "audio_delay_bias".into(),
            json!(-bus.latency().as_secs_f64()),
        );
    }
    // I5: mpv's GL shader cache under the player's state dir (repeat opens skip the
    // shader compile that otherwise dominates a switch's loop time).
    let shader_cache = opts.state_dir.join("shader-cache");
    if std::fs::create_dir_all(&shader_cache).is_ok() {
        base.insert(
            "shader_cache_dir".into(),
            json!(shader_cache.display().to_string()),
        );
    }
    // Phase 2 Task 5: `kind: scene` sources. The worker binary (none → a scene's open fails
    // naming it; `hello` has no `scene` capability), crash records under the state dir, and
    // the synthetic test renderer only when this process runs with
    // `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1` (D7; production never sets it).
    if let Some(bin) = crate::paths::scene_worker_bin() {
        base.insert("scene_worker".into(), json!(bin));
    }
    base.insert(
        "scene_crash_dir".into(),
        json!(opts.state_dir.join("crashes")),
    );
    if std::env::var("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES").as_deref() == Ok("1") {
        base.insert("allow_synthetic".into(), json!(true));
    }
    let clock = match opts.clock {
        ClockMode::Real => ClockKind::Real(MonoClock::new()),
        ClockMode::Stepped => {
            base.insert("stepped".into(), json!(true));
            ClockKind::Stepped(SteppedClock::new())
        }
    };
    let (backend, wl_source): (Box<dyn OutputBackend>, _) = match wl_source {
        Some((wl, src)) => (Box::new(wl), Some(src)),
        None => {
            let mut h = Headless::new(&gfx, &opts.outputs);
            h.set_content_paced(opts.redraw_content);
            (Box::new(h), None)
        }
    };
    // `capture` encodes on `lia-capture`; a finished one wakes the loop, which answers it.
    let (capture_ping, capture_ping_src) =
        calloop::ping::make_ping().map_err(|e| format!("ping: {e}"))?;
    handle
        .insert_source(capture_ping_src, |_, _, rt: &mut Runtime| {
            rt.finish_captures()
        })
        .map_err(|e| format!("event loop: {}", e.error))?;
    let mut rt = Runtime {
        gfx,
        cat,
        composer,
        graph: Graph::new(),
        anim: Animator::new(),
        clock,
        host: SourceHost::new(base),
        tr: Transitions::new(),
        programs: Programs::new(),
        tr_backlog: Vec::new(),
        backend,
        server: Server::default(),
        tap,
        handle: handle.clone(),
        stats: LoopStats::default(),
        tick_period: Duration::from_secs_f64(1.0 / 60.0),
        src_events: Vec::new(),
        last_event: BTreeMap::new(),
        wake_regs: BTreeMap::new(),
        wake_pending: false,
        woken: Vec::new(),
        synced_demand_rev: (0, 0),
        step: None,
        step_queue: VecDeque::new(),
        capture: crate::api::capture::Capturer::new(Arc::new(move || capture_ping.ping())),
        capture_timer: false,
        local: BTreeMap::new(),
        pending_destroy: Vec::new(),
        teardown_anim: Animator::new(),
        setting_anim: Animator::new(),
        onsets: Onsets::new(),
        parked_req: None,
        bus_route: bus_route.unwrap_or((false, 0)),
        quit_at: None,
        parked: None,
        warned: BTreeMap::new(),
        tap_dropped_seen: 0,
        started: Instant::now(),
        redraw: Redraw::new(),
        routes: crate::redraw::Routes::default(),
        frames: BTreeMap::new(),
        audio,
        out_props: BTreeMap::new(),
        snap: SnapState {
            writer: snapshot::Writer::start(&opts.state_dir),
            due: None,
            last_write: None,
            seen_rev: 0,
            frozen: false,
            timer: None,
        },
        supervised: opts.supervised.clone(),
        restart_event,
        fade_in: BTreeMap::new(),
        player_paused: false,
        paused_at: None,
        pause_offset: Duration::ZERO,
        gain_history: GainHistory::new(),
        scene_envelopes: dropout::SceneEnvelopes::new(),
        dropout_windows: PendingWindows::new(),
        dropout_due: Vec::new(),
        pause_gates: BTreeMap::new(),
        pause_gate_prev: false,
        pause_gate_corr: BTreeMap::new(),
        gain_timer_armed: false,
        sysmon: None,
        scene_assets_for: None,
        next_budget: Instant::now(),
        vram: VramState {
            monitor: None,
            timing: crate::vram::Timing::from_env(),
            seen: 0,
            low: crate::vram::LowVram::new(crate::vram::Timing::from_env()),
            hold: None,
            over_since: BTreeMap::new(),
            last: None,
            pids: Vec::new(),
        },
        cover: crate::signal::CoverRt::idle(),
        automute: crate::signal::automute::AutoMuteRt::new(
            crate::signal::automute::env_enabled(),
        ),
    };
    // Phase 3 Task 9: the backend's outbox (`<state>/outbox.jsonl`), compacted on `lia-snapshot`
    let runner = rt.snap.writer.runner();
    crate::outbox::install(crate::outbox::Outbox::open(
        &opts.state_dir,
        runner.map(|r| Box::new(move |f| r.run(f)) as crate::outbox::Spawner),
    ));
    rt.update_scene_assets();
    rt.start_cover();
    rt.start_automute();
    if opts.debug {
        let _ = rt.graph.set(&p("player.debug"), PropValue::Bool(true));
    }
    rt.apply_output_changes();
    // Phase 3 (§ Playlist start): the per-playlist resume points, restore or not
    rt.programs.load_resume(&opts.state_dir);
    if opts.restore {
        rt.restore_from_disk(&opts.state_dir, opts.session_start);
    }
    // Always save the starting state soon: a crash right after a fresh (non-restore) start
    // must not bring back an older session's snapshot.
    rt.snapshot_dirty();

    let ins = |e: calloop::InsertError<_>| format!("event loop: {}", e.error);
    handle
        .insert_source(
            Generic::new(listener, Interest::READ, Mode::Level),
            |_, l, rt: &mut Runtime| {
                for cid in rt.server.accept(l) {
                    rt.register_client(cid);
                }
                Ok(PostAction::Continue)
            },
        )
        .map_err(ins)?;
    handle
        .insert_source(ping_src, |_, _, _: &mut Runtime| {})
        .map_err(|e| format!("event loop: {}", e.error))?;
    handle
        .insert_source(
            Generic::new(sigfd, Interest::READ, Mode::Level),
            |_, fd, rt: &mut Runtime| {
                let mut info = [0u8; 128];
                let fd = std::os::fd::AsRawFd::as_raw_fd(&**fd);
                unsafe { libc::read(fd, info.as_mut_ptr().cast(), info.len()) };
                rt.begin_quit("signal");
                Ok(PostAction::Continue)
            },
        )
        .map_err(|e| format!("event loop: {}", e.error))?;
    if let Some(src) = wl_source {
        // The queue dispatches into the backend's sctk state; hotplug/configures/frame
        // callbacks are applied after the dispatch (`apply_output_changes`, `render_paced`).
        handle
            .insert_source(src, |_, queue, rt: &mut Runtime| {
                match rt.backend.as_wayland_mut() {
                    Some(w) => queue.dispatch_pending(&mut w.state),
                    None => Ok(0),
                }
            })
            .map_err(|e| format!("event loop: {}", e.error))?;
    }
    if opts.clock == ClockMode::Real {
        // I5 (final review): mpv cores are created on a worker thread; its ping wakes the
        // loop, whose next `sync_sources` opens the source (GL half on this thread).
        // Stepped mode keeps synchronous opens (its frames must be deterministic).
        let (open_ping, open_ping_src) =
            calloop::ping::make_ping().map_err(|e| format!("ping: {e}"))?;
        handle
            .insert_source(open_ping_src, |_, _, _: &mut Runtime| {})
            .map_err(|e| format!("event loop: {}", e.error))?;
        rt.host
            .set_async_open(Some(Arc::new(move || open_ping.ping())));
        // Phase 2: render contexts (creation, first render, every frame) on `lia-render`.
        // Real clock only, like the async opens it rides on.
        if opts.render_worker {
            match crate::sources::RenderWorker::start(&rt.gfx) {
                Ok(w) => {
                    log::event(
                        "render",
                        Level::Info,
                        "render_worker.started",
                        None,
                        json!({}),
                    );
                    rt.host.set_render_worker(Some(w));
                }
                Err(e) => log::event(
                    "render",
                    Level::Warn,
                    "render_worker.unavailable",
                    None,
                    json!({ "reason": e, "hint": "mpv sources render on the loop" }),
                ),
            }
        }
        let period = rt.tick_period;
        handle
            .insert_source(
                Timer::from_duration(period),
                |deadline, _, rt: &mut Runtime| {
                    rt.tick();
                    let next = deadline + rt.tick_period;
                    let now = Instant::now();
                    TimeoutAction::ToInstant(if next <= now {
                        now + rt.tick_period
                    } else {
                        next
                    })
                },
            )
            .map_err(|e| format!("event loop: {}", e.error))?;
    } else {
        // Stepped: render once so captures before the first step see the empty outputs.
        rt.tick();
    }
    log::event(
        "runtime",
        Level::Info,
        "player.started",
        None,
        json!({
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "socket": opts.socket.display().to_string(),
            "clock": rt.clock_name(),
            "backend": rt.backend.kind(),
            "outputs": rt.backend.outputs().iter().map(|o| o.name.clone()).collect::<Vec<_>>(),
            "effects": rt.cat.ids().len(),
        }),
    );

    let mut fatal = None;
    loop {
        let timeout = if rt.has_more_input() {
            Some(Duration::ZERO)
        } else if rt.quit_at.is_some() {
            Some(Duration::from_millis(5))
        } else {
            None
        };
        if let Err(e) = event_loop.dispatch(timeout, &mut rt) {
            // E.g. the compositor went away: silence + tear down like a quit, then fail.
            log::event(
                "runtime",
                Level::Error,
                "loop.failed",
                None,
                json!({ "error": e.to_string(), "backend": rt.backend.kind() }),
            );
            fatal = Some(format!("event loop ({} backend): {e}", rt.backend.kind()));
            rt.snapshot_final(); // the restarted player (exit 3) restores what was shown
            rt.stop_all(true);
            break;
        }
        rt.after_dispatch();
        // Phase 2: the render worker died (a panic on `lia-render`): every mpv picture would
        // freeze and every open wait out the attach timeout — fail like a lost compositor
        // instead (silenced + torn down, exit 3: the supervisor restarts with `--restore`).
        if rt.quit_at.is_none()
            && let Some(reason) = rt.host.render_worker().and_then(|w| w.died())
        {
            log::event(
                "runtime",
                Level::Error,
                "loop.failed",
                None,
                json!({ "error": format!("render worker died: {reason}"),
                        "backend": rt.backend.kind() }),
            );
            fatal = Some(format!("render worker died: {reason}"));
            rt.snapshot_final();
            rt.stop_all(true);
            break;
        }
        rt.apply_output_changes();
        rt.pointer_events();
        if rt.backend.paced() {
            rt.render_paced();
        }
        if rt.should_exit() {
            break;
        }
    }
    let stragglers = rt.shutdown();
    log::set_tap(None);
    if stragglers > 0 {
        // An mpv core is still being destroyed on the reaper thread: a normal exit would
        // run atexit/static destructors (libmpv, ffmpeg, EGL) under it. The log is already
        // on disk (every event is flushed), so remove the socket + lock and leave now with
        // the status a normal return would give (item 16) — a failed loop's EXIT_RUNTIME,
        // never 0: the supervisor ends supervision on 0, so a failure must not read as one.
        socket_file.remove_now();
        let code = if fatal.is_some() {
            i32::from(supervise::EXIT_RUNTIME)
        } else {
            0
        };
        unsafe { libc::_exit(code) };
    }
    drop(socket_file);
    fatal.map_or(Ok(()), |m| Err(ServeError::Runtime(m)))
}
