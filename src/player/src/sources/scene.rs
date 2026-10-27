//! `SceneSource` — a WE scene rendered by an `lp-scene-worker` process (Phase 2; `.claude/
//! rules/player-core.md` § Scene worker). Task 4 builds the **texture path**: spawn the
//! worker ([`WorkerHost`]), import its exported ring once ([`ImportedRing`]), tick it at a
//! fixed `tick_hz`, latch only frames whose fence already signalled ([`Latch`]) and return
//! each replaced slot with a release fence. The latched texture survives the worker's death
//! (spike §6); a restarted worker's new ring replaces the old one only once its first frame
//! latched. Task 5 turns this into a graph `Source` (demand-driven ticks and size, pause,
//! Ready, properties); until then it is driven directly (tests).
//!
//! Imports, latching and release fences run on the caller's (the loop's) context — plan
//! "Render worker interplay": a one-off import per slot and an fd poll per frame, so no
//! share-group rebind and no extra thread hop.

use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::gfx::dmabuf::DmabufDesc;
use crate::gfx::{Gfx, GlKeepAlive, Tex};
use crate::log::{self, Level};
use crate::worker::dmabuf::{ImportedRing, Latch};
use crate::worker::proto::{AudioRoute, FromWorker, ToWorker};
use crate::worker::{HANG_TIMEOUT, RestartBudget, WorkerEvent, WorkerHost, WorkerSpec};

/// Most ticks in flight (sent, no `Frame` yet): a slow worker isn't flooded, and one tick
/// is always queued behind the frame it's rendering.
const MAX_INFLIGHT: u64 = 2;

/// How to open a scene (Task 5 replaces `tick_hz`/`max_size` with the graph's demand).
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
    /// Render `lp-synthetic.json` (tests; the worker also needs
    /// `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1`).
    pub synthetic: bool,
    /// Scene time at start (s).
    pub position: f64,
    pub env: Vec<(String, String)>,
    pub budget: RestartBudget,
    pub hang_timeout: Duration,
    pub crash_dir: PathBuf,
}

impl SceneOpts {
    /// Defaults: 30 ticks/s (D5), a 1920×1080 demand, LWE (not synthetic), position 0,
    /// production restart budget / hang timeout / crash dir.
    pub fn new(path: impl Into<PathBuf>, worker_bin: impl Into<PathBuf>) -> SceneOpts {
        SceneOpts {
            id: "scene".into(),
            path: path.into(),
            worker_bin: worker_bin.into(),
            tick_hz: 30.0,
            max_size: [1920, 1080],
            synthetic: false,
            position: 0.0,
            env: Vec::new(),
            budget: RestartBudget::default(),
            hang_timeout: HANG_TIMEOUT,
            crash_dir: crate::paths::crash_dir(),
        }
    }
}

/// Transport counters (the `workers` probe, Task 5).
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
    /// Worker generation of the latched frame (bumps at each restart).
    pub latched_gen: u32,
}

pub struct SceneSource {
    keep: GlKeepAlive,
    host: WorkerHost,
    rings: Vec<ImportedRing>,
    latch: Latch,
    modifiers: Vec<(u32, Vec<(u64, bool)>)>,
    tick_period: Duration,
    next_tick: Option<Instant>,
    seq: u64,
    inflight: u64,
    clock_start: Instant,
    position: f64,
    worker_ready: bool,
    native: Option<[u32; 2]>,
    size: Option<(u32, u32)>,
    error: Option<String>,
    broken: Option<String>,
    sync: Option<String>,
    stats: SceneStats,
    /// Ticks sent, by seq (≤ 64 kept), for the tick → latch latency.
    sent_at: std::collections::VecDeque<(u64, Instant)>,
    /// The last 1024 tick → latch latencies (ms).
    latency_ms: std::collections::VecDeque<f32>,
}

impl SceneSource {
    /// Spawn the worker for `opts.path` on `gfx`'s display. `Err` = this display can't
    /// import dmabufs or make native fences (both required — no CPU-copy path is built), or
    /// the worker can't be spawned. Spawn from a long-lived thread (the loop): the worker's
    /// `PR_SET_PDEATHSIG` follows the spawning thread.
    pub fn open(gfx: &Gfx, opts: SceneOpts) -> Result<SceneSource, String> {
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
        let start = ToWorker::Start {
            path: opts.path.to_string_lossy().into_owned(),
            assets_dir: None,
            steam_dir: None,
            position: opts.position,
            paused: false,
            audio: AudioRoute::Null,
            max_size: opts.max_size,
            synthetic: opts.synthetic,
        };
        let mut spec = WorkerSpec::new(opts.id.clone(), opts.worker_bin.clone(), start);
        spec.env = opts.env.clone();
        spec.budget = opts.budget;
        spec.hang_timeout = opts.hang_timeout;
        spec.crash_dir = opts.crash_dir.clone();
        let host = WorkerHost::spawn(spec).map_err(|e| format!("scene worker: {e}"))?;
        Ok(SceneSource {
            keep: gfx.keep_alive(),
            host,
            rings: vec![ImportedRing::new(0)],
            latch: Latch::new(),
            modifiers: Vec::new(),
            tick_period: Duration::from_secs_f64(1.0 / opts.tick_hz.clamp(1.0, 1000.0)),
            next_tick: None,
            seq: 0,
            inflight: 0,
            clock_start: Instant::now(),
            position: opts.position,
            worker_ready: false,
            native: None,
            size: None,
            error: None,
            broken: None,
            sync: None,
            stats: SceneStats::default(),
            sent_at: std::collections::VecDeque::new(),
            latency_ms: std::collections::VecDeque::new(),
        })
    }

    /// Never blocks: worker messages, imports, latching, releases, the next tick. Returns
    /// whether the texture changed. Call on every wake of [`wake_fd`](Self::wake_fd) and
    /// at least at `tick_hz`.
    pub fn update(&mut self, gfx: &Gfx) -> bool {
        if !self.keep.is_for(gfx) {
            return false;
        }
        let keep = self.keep.clone();
        let guard = keep.make_current();
        if !guard.is_current() {
            return false;
        }
        let now = Instant::now();
        for ev in self.host.poll(now) {
            self.on_event(gfx, now, ev);
        }
        let mut changed = false;
        if let Some(l) = self.latch.latch(|| gfx.native_fence().ok()) {
            // Already signalled — a free safety net, never a wait (spike §2 step 2).
            if let Some(fd) = l.acquire {
                let _ = gfx.gpu_wait_fence(fd);
            }
            self.rings.retain(|r| r.generation >= l.generation);
            self.host.set_resume_position(l.t);
            if let Some(&(_, at)) = self.sent_at.iter().find(|(s, _)| *s == l.seq) {
                if self.latency_ms.len() == 1024 {
                    self.latency_ms.pop_front();
                }
                self.latency_ms.push_back(at.elapsed().as_secs_f32() * 1e3);
            }
            changed = true;
        }
        for (slot, fence) in self.latch.take_releases() {
            let fds: Vec<BorrowedFd> = fence.iter().map(|f| f.as_fd()).collect();
            let _ = self.host.send(&ToWorker::Release { slot }, &fds);
        }
        self.tick(now);
        changed
    }

    fn on_event(&mut self, gfx: &Gfx, now: Instant, ev: WorkerEvent) {
        match ev {
            WorkerEvent::Msg(m, fds) => self.on_message(gfx, now, m, fds),
            WorkerEvent::Restarted { .. } => {
                self.stats.restarts += 1;
                self.latch.forget_worker();
                self.worker_ready = false;
                self.inflight = 0;
            }
            WorkerEvent::Broken { record } => {
                self.broken = Some(format!(
                    "scene worker broken (crash record {})",
                    record.display()
                ));
            }
            WorkerEvent::Exited { .. } | WorkerEvent::Hung { .. } => {}
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
                    Ok(()) => self.size = Some((w, h)),
                    Err(e) => self.fail(e),
                }
            }
            FromWorker::Frame { slot, seq, t, .. } => {
                self.stats.frames_received += 1;
                self.inflight = self.seq.saturating_sub(seq + 1);
                self.latch.push(slot, seq, t, fds.into_iter().next());
            }
            FromWorker::Ready { native, .. } => {
                self.native = Some(native);
                self.worker_ready = true;
                if self.next_tick.is_none() {
                    self.next_tick = Some(now);
                }
            }
            FromWorker::Error { reason, fatal } => {
                if fatal {
                    self.fail(reason);
                    self.host.stop();
                } else {
                    log::event(
                        "scene",
                        Level::Warn,
                        "scene.worker_error",
                        None,
                        json!({"reason": reason}),
                    );
                }
            }
            _ => {}
        }
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
            json!({"reason": reason}),
        );
        if self.error.is_none() {
            self.error = Some(reason);
        }
    }

    fn tick(&mut self, now: Instant) {
        if !self.worker_ready || self.error.is_some() || self.inflight >= MAX_INFLIGHT {
            return;
        }
        let Some(next) = self.next_tick else { return };
        if now < next {
            return;
        }
        let t = self.position
            + now
                .saturating_duration_since(self.clock_start)
                .as_secs_f64();
        let tick = ToWorker::Tick {
            seq: self.seq,
            t,
            input: None,
        };
        match self.host.send(&tick, &[]) {
            Ok(()) => {
                self.seq += 1;
                self.inflight += 1;
                self.stats.ticks_sent += 1;
                if self.sent_at.len() == 64 {
                    self.sent_at.pop_front();
                }
                self.sent_at.push_back((self.seq - 1, now));
            }
            Err(_) => self.stats.tick_send_failures += 1,
        }
        let mut n = next + self.tick_period;
        if n <= now {
            n = now + self.tick_period; // behind: skip ahead, never burst
        }
        self.next_tick = Some(n);
    }

    /// The latched frame (kept through a worker crash and restart); `None` before the first.
    pub fn texture(&self) -> Option<&Tex> {
        let (slot, _, _, generation) = self.latch.current()?;
        self.rings
            .iter()
            .find(|r| r.generation == generation)?
            .tex(slot)
    }

    /// The latched frame's tick `seq`.
    pub fn latched_seq(&self) -> Option<u64> {
        self.latch.current().map(|c| c.1)
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

    /// The worker crashed past its restart budget (Task 10 turns this into `Error`).
    pub fn broken(&self) -> Option<&str> {
        self.broken.as_deref()
    }

    pub fn pid(&self) -> Option<u32> {
        self.host.pid()
    }

    /// Readable when [`update`](Self::update) has worker input (stable across restarts).
    pub fn wake_fd(&self) -> std::os::fd::RawFd {
        self.host.wake_fd()
    }

    pub fn log_tail(&self) -> Vec<String> {
        self.host.log_tail()
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
            ..self.stats
        }
    }
}
