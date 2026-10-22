//! The running player (spec §4.1/§4.2): one calloop loop that owns the graph, the
//! animator, the clock, the live sources, the transition recipe, the compositor and the
//! outputs, and serves the command API (`api/`). `lp-player serve` is [`serve`].
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
use crate::probe::dropout::{self, GainHistory, PendingWindows};
use crate::probe::frames::FrameStats;
use crate::recipes::{TransitionEventKind, Transitions};
use crate::redraw::{self, Redraw};
use crate::snapshot::{self, Snapshot};
use crate::sources::{SourceEvent, SourceHost, StepStatus, reaper};
use crate::supervise::{self, RestartInfo};
use crate::units::{SILENT_DB, db_to_lin};

/// The longest a `step` waits for every video source's frame.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(2);
/// How long `quit` waits for the mpv reaper to destroy the last cores.
pub const REAPER_WAIT: Duration = Duration::from_secs(2);
/// Anti-click ramp used by `stop`/`quit` before sources are destroyed (invariant #4).
const STOP_RAMP: Duration = Duration::from_millis(30);
/// Steps that may wait behind the running one (one per client at most, by the FIFO).
pub const STEP_QUEUE_MAX: usize = 64;
/// Repeated warnings (same key) are logged at most this often (`warn_limited`).
const WARN_EVERY: Duration = Duration::from_secs(5);
/// Tick durations the `loop` probe keeps.
const TICK_HISTORY: usize = 64;
/// The corr of a restored source's pending fade-in (`Runtime::fade_in`).
const RESTORE_FADE: &str = "restore-fade";

/// `--clock`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockMode {
    Real,
    Stepped,
}

/// What `lp-player serve` was asked to run.
#[derive(Debug, Clone)]
pub struct ServeOpts {
    /// `(width, height, hz)` per virtual output (`--outputs`), headless only.
    pub outputs: Vec<(u32, u32, u32)>,
    pub clock: ClockMode,
    /// mpv `ao` for every source (`--ao null` in tests — R26); `None` = mpv's default
    /// for lp-player (`pipewire`).
    pub ao: Option<String>,
    pub socket: PathBuf,
    /// The socket's directory is ours to `chmod 0700` even if it exists (the default
    /// `$XDG_RUNTIME_DIR/livepaper`); `false` for `--socket`/`LP_PLAYER_SOCKET`.
    pub own_socket_dir: bool,
    pub state_dir: PathBuf,
    pub log_level: Level,
    /// Real outputs: one layer-shell surface per `wl_output` (`crate::wl`); `false` =
    /// headless virtual outputs from [`outputs`](Self::outputs).
    pub wayland: bool,
    /// `--restore`: recreate what `<state>/snapshot.json` saved (`crate::snapshot`).
    pub restore: bool,
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
    /// When its park ramp is over (then it's paused); `None` = settled.
    settle_at: Option<Duration>,
    /// The ramp end has been reached once (its final value sent): pause next.
    armed: bool,
    /// The connector it was parked for (a restored snapshot's output that isn't present):
    /// that connector shows it when it appears, whatever else is on screen. `None` = the
    /// R60 "no output left" park (the next output shows it).
    pub connector: Option<String>,
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
    /// source sync/update) since the last `probe loop {"reset": true}`.
    pub max_busy_ms: f64,
    /// The same with the synchronous source opens taken out (`max_open_ms` is those).
    pub max_busy_excl_open_ms: f64,
    pub max_open_ms: f64,
    pub iterations: u64,
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
        self.max_busy_ms = self.max_busy_ms.max(ms(d));
        self.max_busy_excl_open_ms = self.max_busy_excl_open_ms.max(ms(d.saturating_sub(open)));
        self.max_open_ms = self.max_open_ms.max(ms(open));
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
    step: Option<PendingStep>,
    step_queue: VecDeque<(u64, Value, Duration)>,
    pub(crate) local: BTreeMap<String, LocalTime>,
    /// `stop`/`quit`: sources to destroy once their anti-click ramp is over.
    /// `(ramp end, id, armed)`: armed at the first tick at/after the ramp end — whose sync
    /// sends the final −96 dB to the live source — and destroyed at the next one.
    pending_destroy: Vec<(Duration, String, bool)>,
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
    fade_in: BTreeSet<String>,
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
    /// Recent transitions' audio windows (`transition.started`/`.done`), for the
    /// dropout probe's auto-trigger and its on-demand `probe dropout` verb.
    pub(crate) dropout_windows: PendingWindows,
}

fn p(s: &str) -> PropPath {
    PropPath(s.to_string())
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

    pub(crate) fn clock_name(&self) -> &'static str {
        if self.stepped() { "stepped" } else { "real" }
    }

    pub(crate) fn player_paused(&self) -> bool {
        self.player_paused
    }

    /// Reacts to a `player.paused` change: freezes/unfreezes [`Runtime::now`]. Called at
    /// the very top of [`Runtime::tick`]/`begin_step` — *before* `now` is read for
    /// `run_anims`/`destroy_due` — so a pause applied this tick/step freezes it too,
    /// never one tick later (the effective-pause push to every hosted source still
    /// happens in [`Runtime::sync_sources`], which reads the now-current
    /// `self.player_paused` this set). Cheap when nothing changed (one graph read).
    fn update_player_paused(&mut self) {
        let now_paused = matches!(
            self.graph.get(&p("player.paused")),
            Ok(PropValue::Bool(true))
        );
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
                json!({ "paused": now_paused }),
            );
        }
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
        self.update_player_paused();
        let now = self.now();
        self.run_anims(now);
        self.record_gain_history();
        self.destroy_due(now);
        let t_sync = Instant::now();
        self.sync_sources();
        let sync_ms = t_sync.elapsed();
        self.finish_tick(t.elapsed(), sync_ms);
    }

    /// R70: one `effective_gain_db` reading per live `Source` node per tick, on the log's
    /// real `t_mono_ms` clock — **not** `self.now()`, which may be the stepped/virtual
    /// clock and would disagree with the bus meter's real-time samples.
    fn record_gain_history(&mut self) {
        let t = log::mono_now().unwrap_or_default();
        let readings: Vec<(String, f64)> = self
            .graph
            .ids_of(NodeKind::Source)
            .into_iter()
            .filter_map(|id| {
                let db = self.graph.effective_gain_db(&id)?;
                Some((id, db))
            })
            .collect();
        self.gain_history.record(t, readings.into_iter());
    }

    /// The second half of a tick: update sources, run the recipes on every source event
    /// since the last tick, compose + present every output.
    fn finish_tick(&mut self, before: Duration, sync: Duration) {
        let t = Instant::now();
        let now = self.now();
        self.update_sources();
        let t_tr = Instant::now();
        let evs = std::mem::take(&mut self.src_events);
        self.tr.tick(&mut self.graph, &mut self.anim, &evs, now);
        // Already in the event log → subscribers via the tap; the dropout probe (Task 15,
        // R71) also watches for Started/Done here to track each transition's audio window.
        let tr_events = self.tr.drain_events();
        self.record_dropout_windows(&tr_events);
        self.refresh_srcs();
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
        self.redraw.mark_nodes(&self.graph, &moved);
        for (_, corr) in self.anim.finished() {
            if let Some(c) = corr
                && c.0.starts_with("an-")
            {
                log::event("runtime", Level::Info, "anim.done", Some(c), json!({}));
            }
        }
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
                    if self.debug_mode()
                        && let Some(pending) = self.dropout_windows.get(&ev.corr.0)
                    {
                        dropout::spawn_analysis(self, ev.corr.clone(), pending);
                    }
                }
                _ => {}
            }
        }
    }

    /// Forward graph changes to the live sources (and keep the wake-fd registrations in
    /// line with the hosted sources).
    pub(crate) fn sync_sources(&mut self) {
        // R75: catch a `player.paused` change promptly even between ticks/steps — this
        // runs after every dispatch (`after_dispatch`), not only on a timer/`step`, so a
        // plain `set` pushes the effective pause to every source at once (a no-op if
        // `tick`/`begin_step` already called this for `now`'s sake this iteration).
        self.update_player_paused();
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
        self.host
            .sync(&self.gfx, &self.graph, &changes, self.player_paused);
        self.sync_wake_regs();
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
            match self.handle.insert_source(src, |_, _, rt: &mut Runtime| {
                rt.wake_pending = true;
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
        self.host.update(&self.gfx, &mut self.graph);
        let changed = self.host.take_changed();
        self.redraw.mark_shown(&self.graph, &changed);
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
            };
            if !kind.is_empty() {
                log::event("source", level, kind, None, fields);
            }
            if matches!(ev, SourceEvent::Ready) && self.fade_in.remove(&id) {
                self.start_restore_fade(&id);
            }
            let name = match &ev {
                SourceEvent::Ready => "ready".to_string(),
                SourceEvent::Ended => "ended".to_string(),
                SourceEvent::Position(t) => format!("position {t:.3}"),
                SourceEvent::Error { reason } => format!("error: {reason}"),
                SourceEvent::Rejected { prop, reason } => format!("rejected {prop}: {reason}"),
            };
            self.last_event.insert(id.clone(), name);
            self.src_events.push((id, ev));
        }
        self.last_event
            .retain(|id, _| self.graph.kind_of(id) == Some(NodeKind::Source));
        self.fade_in
            .retain(|id| self.graph.kind_of(id) == Some(NodeKind::Source));
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
        let rev = self.graph.picture_rev();
        for o in self.backend.outputs() {
            if !self.backend.frame_state(&o.name).is_some_and(|f| f.ready) {
                continue;
            }
            let animating = redraw::animating_on(&self.anim, now, &self.graph, &o.name);
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

    /// Pointer samples from the backend → `out:<c>.pointer` `[x, y, buttons]` (observed).
    pub(crate) fn pointer_events(&mut self) {
        for s in self.backend.take_pointer() {
            let _ = self.graph.set_observed(
                &p(&format!("out:{}.pointer", s.output)),
                PropValue::List(vec![s.x, s.y, s.buttons as f64]),
            );
        }
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
        self.tr.drain_events();
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

    /// Ramp `id`'s `gain.anticlick` from where it is (or where it's heading) to `to_db`
    /// over 30 ms, starting now.
    fn ramp_anticlick(&mut self, id: &str, to_db: f64, corr: Option<CorrId>) {
        let path = p(&format!("{id}.gain.anticlick"));
        // A live ramp's target, else the value itself (a finished ramp's target is stale
        // once something `set` the slot directly — e.g. a silent park's −96).
        let cur = self
            .anim
            .live_target_of(&path)
            .unwrap_or(match self.graph.get(&path) {
                Ok(PropValue::F64(f)) => f,
                _ => 0.0,
            });
        let now = self.now();
        self.anim.add(Animation {
            target: path,
            from: db_to_lin(cur),
            to: db_to_lin(to_db),
            start: now,
            duration: STOP_RAMP,
            curve: Curve::Linear,
            unit: AnimUnit::GainLinear,
            corr,
        });
    }

    /// Whether `id` can make no sound right now (so it may go without a ramp): paused,
    /// not ready yet (never played), at −96 dB, or a kind without audio.
    fn is_silent(&self, id: &str) -> bool {
        matches!(
            self.str_prop(id, "kind").as_str(),
            "color" | "snapshot" | "image"
        ) || self.bool_prop(id, "paused")
            || !self.bool_prop(id, "ready")
            || self
                .graph
                .effective_gain_db(id)
                .is_some_and(|db| db <= SILENT_DB + 1e-9)
    }

    /// Remove a source without a click (core invariant, item 10): an audible one is ramped
    /// to −96 over 30 ms (`gain.anticlick`) and destroyed when the ramp is over; a silent
    /// one goes at once. Returns the ramp length. Used by `destroy`, `stop`, output removal.
    pub(crate) fn retire(&mut self, id: &str) -> Duration {
        if self.graph.kind_of(id) != Some(NodeKind::Source) {
            let _ = self.graph.destroy(id);
            return Duration::ZERO;
        }
        if self.parked.as_ref().is_some_and(|pk| pk.id == id) {
            self.parked = None;
            self.graph.set_parked(None);
        }
        let mut corr = None;
        let ramp = if self.is_silent(id) {
            let _ = self.graph.destroy(id);
            Duration::ZERO
        } else {
            // R80 (review fix round): a plain retire's own 30 ms anti-click ramp is a
            // dropout-probe window too — same mechanism as a transition's A, with a
            // silent/empty "B" (its decode is trivially silence, same as any other
            // empty-path source — no new case needed). Recorded unconditionally (not
            // gated on `player.debug`, same rule as a transition's — R70), so `ctl probe
            // '{"name":"dropout","args":{"corr":…}}'` can check any recent retire once
            // the meter has actually captured past its window's end.
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
            self.dropout_windows.done(&c.0, mono + STOP_RAMP);
            corr = Some(c);
            self.ramp_anticlick(id, SILENT_DB, None);
            let at = self.now() + STOP_RAMP;
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
    /// connector (a restored output that isn't present) — shown when it appears.
    fn park(&mut self, id: &str, pending_b: bool, connector: Option<String>) {
        if self.fade_in.remove(id) && self.restore_fade_pending(id) {
            // Parked = silent; unpark ramps it in from −96.
            self.anim.cancel_target(&p(&format!("{id}.gain.anticlick")));
        }
        let resume_paused = !pending_b && self.bool_prop(id, "paused");
        let silent = self.is_silent(id);
        if silent {
            let _ = self.graph.set(
                &p(&format!("{id}.gain.anticlick")),
                PropValue::F64(SILENT_DB),
            );
        } else {
            self.ramp_anticlick(id, SILENT_DB, None);
        }
        let settle_at = self.now() + if silent { Duration::ZERO } else { STOP_RAMP };
        self.parked = Some(Parked {
            id: id.to_string(),
            resume_paused,
            settle_at: Some(settle_at),
            armed: silent,
            connector,
        });
        self.graph.set_parked(Some(id.to_string()));
        self.settle_parked(self.now());
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
    /// back in over 30 ms. Returns its id.
    fn unpark(&mut self) -> Option<String> {
        let pk = self.parked.take()?;
        self.graph.set_parked(None);
        if self.graph.kind_of(&pk.id) != Some(NodeKind::Source) {
            return None;
        }
        if pk.settle_at.is_some() {
            // Unparked mid-ramp: its xfade may still be animating — leave it.
        }
        let _ = self.graph.set(
            &p(&format!("{}.paused", pk.id)),
            PropValue::Bool(pk.resume_paused),
        );
        self.ramp_anticlick(&pk.id, 0.0, None);
        log::event(
            "runtime",
            Level::Info,
            "source.unparked",
            None,
            json!({ "id": pk.id }),
        );
        Some(pk.id)
    }

    // ------------------------------------------------------------------ stop / quit

    /// `stop`: every in-flight transition is dropped (`transition.cancelled {reason:
    /// "stopped"}`), every layer emptied, every source ramped to silence over 30 ms
    /// (invariant #4) and then destroyed. `instant` (stepped clock / quit): silence and
    /// destroy now — virtual time won't move on by itself.
    pub(crate) fn stop_all(&mut self, instant: bool) -> Vec<String> {
        let now = self.now();
        for st in self.tr.status() {
            log::event(
                "transition",
                Level::Info,
                "transition.cancelled",
                Some(st.corr.clone()),
                json!({ "reason": "stopped", "at_ms": now.as_secs_f64() * 1000.0 }),
            );
        }
        self.tr = Transitions::new();
        self.anim = Animator::new();
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
                let _ = self.graph.destroy(id);
            }
            self.pending_destroy.clear();
            self.sync_sources();
        } else {
            for id in &ids {
                self.retire(id);
            }
        }
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
            for slot in crate::units::GainSlot::ALL {
                self.anim
                    .cancel_target(&p(&format!("{id}.gain.{}", slot.as_str())));
            }
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
        let t = Instant::now();
        self.host.finish_teardown(Duration::from_millis(500));
        let left = reaper::shutdown(REAPER_WAIT);
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
        let now = Instant::now();
        let due = match self.snap.due {
            Some(d) => now >= d,
            None => {
                self.snap
                    .last_write
                    .is_none_or(|t| now.duration_since(t) >= snapshot::REFRESH)
                    && self.video_playing()
            }
        };
        if due {
            self.write_snapshot();
        }
    }

    fn video_playing(&self) -> bool {
        self.graph.ids_of(NodeKind::Source).iter().any(|id| {
            self.str_prop(id, "kind") == "video"
                && self.bool_prop(id, "ready")
                && !self.bool_prop(id, "paused")
        })
    }

    /// What `snapshot.json` would hold now (`crate::snapshot::capture`).
    pub(crate) fn capture_snapshot(&self) -> Snapshot {
        let status = self.tr.status();
        snapshot::capture(&snapshot::Capture {
            graph: &self.graph,
            anim: &self.anim,
            transitions: &status,
            parked: self.parked.as_ref().map(|pk| snapshot::ParkedSnap {
                id: pk.id.clone(),
                resume_paused: pk.resume_paused,
                connector: pk.connector.clone(),
            }),
            remembered: &self.out_props,
        })
    }

    fn write_snapshot(&mut self) {
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
        self.write_snapshot();
        self.snap.frozen = true;
    }

    /// `--restore`: load `<state>/snapshot.json` and recreate it; a corrupt or
    /// unknown-version file is moved aside (`snapshot.invalid.json`) and the player starts
    /// empty — never a crash loop over a bad file.
    fn restore_from_disk(&mut self, dir: &std::path::Path) {
        match snapshot::load(dir) {
            Ok(Some(s)) => self.restore_snapshot(s),
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
    fn restore_snapshot(&mut self, snap: Snapshot) {
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
    fn start_restore_fade(&mut self, id: &str) {
        if !self.restore_fade_pending(id) {
            return;
        }
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
        let audible = s.kind == "video" && !s.paused;
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
                    self.fade_in.insert(id.clone());
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
            let Some(m) = self.host.mpv(&id) else {
                continue;
            };
            let video = crate::sources::Source::kind(m) == "video";
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
            if let Some(m) = self.host.mpv_mut(&id) {
                m.step_end(at_end);
            }
            waits.push(StepWait {
                id,
                t: t_now,
                video,
                seeked: false,
                done: false,
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
        for w in st.waits.iter_mut().filter(|w| !w.done) {
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
                    _ if !m.is_ready() => continue,
                    _ => {}
                }
                w.seeked = true;
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
                    let what = match self.host.mpv(&w.id).map(|m| m.step_status()) {
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
                hint: "`lp-player ctl probe '{\"name\":\"sources\"}'` shows each source's \
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
                    Ok(req) => match handlers::handle(self, cid, &req) {
                        Some(r) => self.respond(cid, &req.id, r),
                        None => {
                            // Deferred (`step`) — unless it was answered at once.
                            if self.step_pending_for(cid, &req.id)
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
                rt.client_io(cid, r.readable || r.error, r.writable);
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
        self.sync_sources();
        if self.wake_pending {
            self.wake_pending = false;
            self.update_sources();
        }
        self.advance_step();
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

    fn has_more_input(&self) -> bool {
        self.server
            .clients
            .values()
            .any(|c| c.more_input && !c.awaiting && c.dead.is_none())
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

/// `lp-player serve [--headless …]`: run until `quit` / SIGINT / SIGTERM (or the Wayland
/// connection is lost — then every source is silenced and torn down, and it returns `Err`).
pub fn serve(opts: ServeOpts) -> Result<(), ServeError> {
    supervise::make_sent_faults_fatal(); // `kill -SEGV` crashes, never shrugged off
    let sigfd = signal_fd()?;
    log::init(&opts.state_dir, opts.log_level).map_err(|e| {
        format!(
            "event log in {}: {e} (set XDG_STATE_HOME to a writable directory)",
            opts.state_dir.display()
        )
    })?;
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
    let (gfx, wl_source) = if opts.wayland {
        let (wl, src) = crate::wl::Wayland::connect().map_err(ServeError::NoCompositor)?;
        let gfx = Gfx::new_wayland(wl.display_ptr())
            .map_err(|e| ServeError::NoCompositor(format!("EGL on Wayland: {e}")))?;
        (gfx, Some((wl, src)))
    } else {
        let gfx = Gfx::new_offscreen()
            .map_err(|e| ServeError::NoCompositor(format!("no EGL device: {e}")))?;
        (gfx, None)
    };
    let cat = match Catalogue::resolve_dir() {
        Some(dir) => Catalogue::load(&dir).map_err(|e| format!("effect catalogue: {e}"))?,
        None => {
            log::event(
                "runtime",
                Level::Warn,
                "effects.missing",
                None,
                json!({ "hint": "no transitions/ directory resolved (LP_TRANSITIONS_DIR, \
                                 ~/.local/share/livepaper-web/transitions, the repo); \
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

    // The bus comes after the socket: a second instance exits above without touching
    // PipeWire. Sources play into it unless `--ao` routes them elsewhere (then there's none).
    let audio = Audio::start(opts.ao.as_deref());
    let mut base = Map::new();
    if let Some(ao) = &opts.ao {
        base.insert("ao".into(), json!(ao));
    }
    if let Some(bus) = &audio.bus {
        base.insert("audio_device".into(), json!(bus.device()));
        // Compensate what the bus adds; a source's own `audio_delay` adds to this.
        base.insert(
            "audio_delay_bias".into(),
            json!(-bus.latency().as_secs_f64()),
        );
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
    let mut rt = Runtime {
        gfx,
        cat,
        composer,
        graph: Graph::new(),
        anim: Animator::new(),
        clock,
        host: SourceHost::new(base),
        tr: Transitions::new(),
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
        step: None,
        step_queue: VecDeque::new(),
        local: BTreeMap::new(),
        pending_destroy: Vec::new(),
        quit_at: None,
        parked: None,
        warned: BTreeMap::new(),
        tap_dropped_seen: 0,
        started: Instant::now(),
        redraw: Redraw::new(),
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
        fade_in: BTreeSet::new(),
        player_paused: false,
        paused_at: None,
        pause_offset: Duration::ZERO,
        gain_history: GainHistory::new(),
        dropout_windows: PendingWindows::new(),
    };
    if opts.debug {
        let _ = rt.graph.set(&p("player.debug"), PropValue::Bool(true));
    }
    rt.apply_output_changes();
    if opts.restore {
        rt.restore_from_disk(&opts.state_dir);
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
        // a clean status (item 16).
        socket_file.remove_now();
        unsafe { libc::_exit(0) };
    }
    drop(socket_file);
    fatal.map_or(Ok(()), |m| Err(ServeError::Runtime(m)))
}
