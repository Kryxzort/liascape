//! Compositor side of the scene worker (`docs/player/modules/scene-worker.md`): [`WorkerHost`] spawns and supervises one `liascape-scene-worker` process over a
//! `SOCK_SEQPACKET` socketpair ([`proto`]), [`dmabuf`] imports its frames.
//!
//! **Lifecycle.** `spawn` → `Starting` (no `Hello` yet) → `Running` (the host answers `Hello`
//! with the spec's `Start`). A crash = socket EOF or the process gone (`waitpid`); a hang = a
//! `Tick` or `Ping` unanswered for `hang_timeout` → SIGKILL. Either way: `Exited`, then a
//! restart (`Restarting {attempt}` → `Running`, the new process gets the last `Start` at
//! [`WorkerHost::set_resume_position`]) while the [`RestartBudget`] allows (3 per 60 s),
//! else `Broken` + a crash record. `stop` (and `Drop`) never block: `Quit`, then the
//! process goes to the reaper thread (`lia-worker-reap`), SIGKILLed after [`STOP_GRACE`].
//!
//! **Spawn = `posix_spawn`** (glibc: `clone(CLONE_VM|CLONE_VFORK)`), never `fork`: no
//! page-table copy of the compositor, so it is cheap enough to run on the loop thread — and it
//! must run on a thread that lives as long as the worker: `PR_SET_PDEATHSIG` (which the worker
//! sets itself, then checks `getppid()` against `--parent-pid`) fires when the *spawning
//! thread* exits, not the process (`prctl(2)`), so a pool thread that exits when idle would
//! take its workers down with it. The child gets its socket end at fd 3, stderr + stdout on a
//! pipe the host keeps the last [`LOG_TAIL`] lines of, stdin `/dev/null`, an empty signal
//! mask and default dispositions (the compositor blocks SIGINT/SIGTERM for its signalfd).

pub mod dmabuf;
pub mod proto;
pub mod renderer;
pub mod spare;

use std::collections::VecDeque;
use std::ffi::{CString, OsString};
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::log::{self, CorrId, Level};
use proto::{FromWorker, ToWorker};

/// A `Tick` or `Ping` unanswered this long = hung → SIGKILL.
pub const HANG_TIMEOUT: Duration = Duration::from_secs(2);
/// `stop`: how long a worker gets to act on `Quit` before SIGKILL.
pub const STOP_GRACE: Duration = Duration::from_millis(500);
/// Lines of worker output kept (and written into a crash record).
pub const LOG_TAIL: usize = 50;
/// Crash records kept in the crash dir (oldest dropped).
pub const MAX_CRASH_RECORDS: usize = 20;
/// A spawned worker that hasn't said `Hello` by then is hung — unless it is still starting
/// ([`start_activity`] moved within the last `HELLO_TIMEOUT / HELLO_PROGRESS_DIV`). A worker is
/// starting until its first `Frame`: a cold start pages its binary and the GL driver in, and with
/// those evicted from the page cache and the disk busy the debug build's `Hello` took over 5 s
/// and its first frame over 10 s more — its first render's driver calls can miss a `Ping` past
/// the hang timeout the same way. Killing a slow start only starts it over from scratch, and
/// three restarts mark the scene broken.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// The quiet window that ends a start's grace, as a fraction of the bound it extends (the hello
/// timeout, then the hang timeout once `Hello` came): no CPU time and no major fault that long =
/// blocked (on a lock, in the driver).
pub const HELLO_PROGRESS_DIV: u32 = 3;
/// A start still making progress is waited for up to this many × the hello timeout from its spawn:
/// 50 s, as long as a transition waits for a loading B (`recipes::transition::LOADING_READY_TIMEOUT`).
/// A worker paging in from a saturated disk was seen in D state for over 20 s, 2–3 major faults
/// a second.
pub const HELLO_TIMEOUT_MAX_FACTOR: u32 = 10;
/// Heartbeat period while no ticks flow (shortened to `hang_timeout / 2` for short timeouts,
/// so a hang is always seen within `1.5 × hang_timeout`).
pub const PING_INTERVAL: Duration = Duration::from_secs(1);
/// A worker starved of slots (every one held by the host) with a tick waiting is hung after
/// this many hang timeouts all the same — slots that never come back (fences that never
/// signal: a dead GPU timeline) are recovered by a restart (a fresh ring).
pub const STARVE_LIMIT_FACTOR: u32 = 5;
/// A gap between two `poll`s longer than this = the host itself was stalled (see
/// `WorkerHost::host_stall_grace`): half the hang timeout (1 s in production, where polls come
/// at the loop's tick rate, ≤ 17 ms apart).
pub fn host_stall_gap(hang_timeout: Duration) -> Duration {
    hang_timeout / 2
}
/// An adopted spare's load whose process shows no progress (no CPU time, no major fault, no IO
/// wait) this long is dropped for a fresh worker (`WorkerHost::watch_adopted_load`): one hang
/// timeout, 2 s in production. A load works on the CPU or pages in the whole time (a heavy build
/// starved at 5 runnable threads per CPU still got a slice every 1.3 s at worst), so a process
/// quiet that long is blocked.
pub fn spare_load_stall(hang_timeout: Duration) -> Duration {
    hang_timeout
}

/// A starting worker's activity, from `/proc/<pid>/stat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StartActivity {
    /// CPU time, clock ticks (`utime + stime`).
    cpu: u64,
    majflt: u64,
    /// In uninterruptible IO wait (`D`): on a saturated disk one fault outlasts the quiet window.
    in_io: bool,
}

/// Moving = still starting. Before `Hello` CPU time counts too (nothing else answers then);
/// after it only paging in does: CPU work is a load the worker's own protocol thread covers
/// (`LoadGate`, with its own cap), and outside it a renderer that spins without answering is
/// hung. Guards: `tests/worker.rs::slow_start_is_not_a_hang`, `slow_first_render_is_not_a_hang`,
/// `busy_first_render_is_hung`, `stuck_start_is_hung`, `tests/scene.rs::starved_scene_load_outlasts_the_load_timeout`,
/// unit `start_activity_parses_stat`.
fn start_activity(pid: libc::pid_t) -> Option<StartActivity> {
    parse_start_activity(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

fn parse_start_activity(stat: &str) -> Option<StartActivity> {
    // Fields after the `(comm)` (which may hold spaces and parentheses): state is field 3,
    // majflt 12, utime 14, stime 15.
    let f: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let n = |field: usize| f.get(field - 3)?.parse::<u64>().ok();
    Some(StartActivity {
        cpu: n(14)? + n(15)?,
        majflt: n(12)?,
        in_io: *f.first()? == "D",
    })
}

/// The dynamic loader's exit code when it can't load a library the worker needs (`ld.so`): the
/// worker never exits with it itself.
pub const LOADER_FAILED: i32 = 127;
/// Why a worker that can't load LWE's core can't play (the binary or its core is gone: a Nix
/// garbage collection, a half-removed install). User-facing: the backend shows it with the item.
pub const RENDERER_MISSING: &str = "The scene renderer is missing — rebuild or reinstall Liascape";

/// The child's socket end.
pub const CHILD_FD: RawFd = 3;
/// After socket EOF, a process that still hasn't exited by then is killed.
const EOF_KILL_AFTER: Duration = Duration::from_secs(1);
/// One output line longer than this is cut (kept up to here, then `…`).
const MAX_LINE: usize = 4096;
/// Most worker output read per `poll` (the rest next time).
const MAX_READ_PER_POLL: usize = 256 * 1024;
/// How often [`WorkerHost::poll`] `waitpid`s a worker whose socket and output are still open
/// (an ending one — EOF, or killed — is reaped on every poll). F6b: `poll` runs on every
/// frame; a process that exits closes both, so this only bounds an odd case (a descendant
/// still holding the socket).
const REAP_CHECK: Duration = Duration::from_millis(100);

/// Restart policy: at most `max` restarts within a sliding `window` (spec §6.3: 3 per 60 s).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartBudget {
    pub window: Duration,
    pub max: u32,
}

impl Default for RestartBudget {
    fn default() -> Self {
        RestartBudget {
            window: Duration::from_secs(60),
            max: 3,
        }
    }
}

impl RestartBudget {
    /// A crash at `now`, given the instants of earlier restarts (`history`, oldest first,
    /// pruned here to the window): `Some(attempt)` = restart (recorded; `attempt` = restarts
    /// within the window including this one), `None` = the budget is spent → broken.
    pub fn admit(&self, history: &mut VecDeque<Instant>, now: Instant) -> Option<u32> {
        while history
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= self.window)
        {
            history.pop_front();
        }
        if history.len() as u32 >= self.max {
            return None;
        }
        history.push_back(now);
        Some(history.len() as u32)
    }
}

/// The worker's `--preload` argv for `start`: a real scene's folder, assets and Steam library, so
/// the worker loads the project while its EGL context comes up instead of after `Hello`
/// (`docs/player/modules/scene-worker.md` § The worker binary). The `Start` sent at `Hello`
/// stays the authority (the worker drops a preload it doesn't match); a synthetic scene or one
/// with no assets dir (an error at `Start`) gets none. Guard: unit
/// `preload_args_name_a_real_scene_only`.
pub fn preload_args(start: &ToWorker) -> Vec<String> {
    let ToWorker::Start {
        path,
        assets_dir: Some(assets),
        steam_dir,
        synthetic: false,
        ..
    } = start
    else {
        return Vec::new();
    };
    let mut a = vec![
        "--preload".to_string(),
        path.clone(),
        "--preload-assets".to_string(),
        assets.clone(),
    ];
    if let Some(s) = steam_dir {
        a.extend(["--preload-steam".to_string(), s.clone()]);
    }
    a
}

/// What to run and how to supervise it.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
    /// The owning source's id (logs, crash records' `id`).
    pub id: String,
    pub bin: PathBuf,
    /// Extra argv after `--fd 3 --parent-pid P` (tests: `--stub`).
    pub args: Vec<String>,
    /// Sent in answer to every `Hello` (a restart's carries the resume position).
    pub start: ToWorker,
    /// Added to (and overriding) the compositor's environment.
    pub env: Vec<(String, String)>,
    pub hang_timeout: Duration,
    /// [`HELLO_TIMEOUT`] (tests shorten it).
    pub hello_timeout: Duration,
    pub budget: RestartBudget,
    /// Where crash records go ([`crate::paths::crash_dir`] by default).
    pub crash_dir: PathBuf,
    /// The item a crash record names when it isn't the `Start`'s folder (a preset loading its
    /// base scene: the record, like every event, names the preset). Guard:
    /// `tests/api.rs::scene_dir_crash_record_names_the_preset`.
    pub record_path: Option<String>,
}

impl WorkerSpec {
    /// The production defaults: no extra args/env, [`HANG_TIMEOUT`], 3 restarts per 60 s,
    /// records in `<state>/crashes/`.
    pub fn new(id: impl Into<String>, bin: impl Into<PathBuf>, start: ToWorker) -> WorkerSpec {
        WorkerSpec {
            id: id.into(),
            bin: bin.into(),
            args: Vec::new(),
            start,
            env: Vec::new(),
            hang_timeout: HANG_TIMEOUT,
            hello_timeout: HELLO_TIMEOUT,
            budget: RestartBudget::default(),
            crash_dir: crate::paths::crash_dir(),
            record_path: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorkerState {
    /// A spare ([`WorkerHost::spawn_spare`]): started or idle with its context ready, holding
    /// no scene until [`WorkerHost::adopt`].
    Spare,
    Starting,
    Running,
    Restarting { attempt: u32 },
    Broken { reason: String },
    Stopped,
}

#[derive(Debug)]
pub enum WorkerEvent {
    /// Every message but `Pong` (the heartbeat's own).
    Msg(FromWorker, Vec<OwnedFd>),
    Exited {
        signal: Option<i32>,
        code: Option<i32>,
    },
    Hung {
        waited_ms: u64,
    },
    Restarted {
        attempt: u32,
    },
    /// An adopted spare's load stalled: it was killed and a fresh worker started for the same
    /// scene — no crash (no budget, no record, no `Exited` before it); the load starts over.
    Replaced {
        why: String,
    },
    Broken {
        record: PathBuf,
    },
}

/// One live worker process.
struct Proc {
    pid: libc::pid_t,
    sock: Option<OwnedFd>,
    out: Option<OwnedFd>,
    started: Instant,
    hello_at: Option<Instant>,
    /// A `Frame` came: the start (see [`HELLO_TIMEOUT`]) is over.
    framed: bool,
    /// While starting: the process's [`start_activity`] when last sampled, and when it last moved.
    start_activity: Option<StartActivity>,
    start_moved_at: Instant,
    /// Sent ticks not answered yet (`seq`, sent at); a `Frame {seq}` answers every tick ≤ it.
    ticks: VecDeque<(u64, Instant)>,
    ping: Option<(u64, Instant)>,
    /// The last `Tick`/`Ping` sent (or the `Start`): the ping cadence. Other traffic (gains,
    /// the pointer) proves nothing about the worker, so it never postpones a ping.
    last_beat: Instant,
    /// The worker's current ring (slot ids of its latest `Buffer` set, `ring_size` each) and
    /// the slots the host holds (a `Frame` named it, no `Release` sent yet): when the host
    /// holds the whole ring the worker can't render a tick — it is *starved*, waiting on us.
    ring: Vec<u8>,
    ring_size: (u32, u32),
    held: Vec<u8>,
    /// Since when a tick has been waiting while the worker was starved (bounded by
    /// [`STARVE_LIMIT_FACTOR`] × the hang timeout).
    starved_since: Option<Instant>,
    eof_at: Option<Instant>,
    killed: bool,
    hung: bool,
    /// Why the host killed it (`kill_for_restart`) — the restart's / record's reason.
    why: Option<String>,
    /// An adopted spare still inside its first load (see [`spare_load_stall`]).
    adopted: Option<AdoptedLoad>,
}

/// An adopted spare's load, watched for progress until its `Ready` / first `Frame`.
struct AdoptedLoad {
    at: Instant,
    /// When the process last moved, what it showed then, and the last sample.
    moved_at: Instant,
    activity: Option<StartActivity>,
    sampled: Instant,
}

/// Supervises one scene worker. See the module docs.
pub struct WorkerHost {
    spec: WorkerSpec,
    epoll: OwnedFd,
    proc_: Option<Proc>,
    state: WorkerState,
    history: VecDeque<Instant>,
    total_restarts: u32,
    tail: VecDeque<String>,
    partial: Vec<u8>,
    ping_seq: u64,
    corr: CorrId,
    sync: Option<String>,
    /// The previous `poll` (the host-stall grace).
    last_poll: Option<Instant>,
    /// The last `waitpid` of a worker that showed no sign of ending ([`REAP_CHECK`]).
    reap_checked: Option<Instant>,
    /// A spare: no `Start` is sent at its `Hello`, and its death is no crash (no restart, no
    /// budget, no record) — the [`spare::Spare`] pool replaces it.
    spare: bool,
    /// A spare's `Hello`, handed to the adopter at its next poll (it was read before anyone
    /// owned the worker).
    hello_replay: Option<FromWorker>,
    /// Events for the next poll (the adopter's replayed `Hello`).
    pending: Vec<WorkerEvent>,
}

impl WorkerHost {
    /// Start the worker. Never waits for it (`Hello` arrives through [`poll`](Self::poll)).
    pub fn spawn(spec: WorkerSpec) -> io::Result<WorkerHost> {
        WorkerHost::start(spec, false)
    }

    /// Start a spare worker: launched like a scene's (`spec`'s binary, args and environment)
    /// but with no scene, so no `--preload`; it sets its GL context up, says `Hello` and waits
    /// for [`adopt`](Self::adopt) to hand it a scene's spec. Its heartbeat runs as usual (a hung
    /// spare is killed); its death is reported as [`WorkerEvent::Exited`] and nothing else — no
    /// restart, no budget, no crash record. `spec.start` is ignored. Guards:
    /// `tests/worker.rs::spare_waits_for_its_scene_and_takes_the_start`,
    /// `spare_death_is_not_a_crash`.
    pub fn spawn_spare(mut spec: WorkerSpec) -> io::Result<WorkerHost> {
        // Never sent (a spare answers `Hello` with nothing); a `Quit` if a bug ever did.
        spec.start = ToWorker::Quit;
        WorkerHost::start(spec, true)
    }

    fn start(spec: WorkerSpec, spare: bool) -> io::Result<WorkerHost> {
        let epoll = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
        if epoll < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut host = WorkerHost {
            spec,
            epoll: unsafe { OwnedFd::from_raw_fd(epoll) },
            proc_: None,
            state: if spare {
                WorkerState::Spare
            } else {
                WorkerState::Starting
            },
            history: VecDeque::new(),
            total_restarts: 0,
            tail: VecDeque::new(),
            partial: Vec::new(),
            ping_seq: 0,
            corr: log::new_corr("wk"),
            sync: None,
            last_poll: None,
            reap_checked: None,
            spare,
            hello_replay: None,
            pending: Vec::new(),
        };
        host.proc_ = Some(host.spawn_proc(0)?);
        Ok(host)
    }

    /// Give this spare a scene: `spec` becomes its spec (id, `Start`, budget, hang timeout,
    /// crash dir) and it is an ordinary worker from now on, its start timed from now (the
    /// hello and first-frame grace count from the adoption, not from the spare's spawn). Said
    /// `Hello` already: the `Start` goes now and the `Hello` is replayed to the caller at its
    /// next poll; else the `Start` answers its `Hello` as for any worker. `Err(spec)` = not
    /// adoptable (not a spare, gone or dying, or launched differently: another binary, args or
    /// environment) — the caller spawns its own.
    /// Its load is watched until `Ready`: one that stalls is dropped for a fresh worker
    /// ([`WorkerEvent::Replaced`]).
    pub fn adopt(&mut self, spec: WorkerSpec) -> Result<(), WorkerSpec> {
        let alive = self
            .proc_
            .as_ref()
            .is_some_and(|p| !p.killed && p.sock.is_some() && p.eof_at.is_none());
        if !self.spare
            || !alive
            || self.state != WorkerState::Spare
            || spare::Launch::of(&self.spec) != spare::Launch::of(&spec)
        {
            return Err(spec);
        }
        let now = Instant::now();
        let p = self.proc_.as_mut().unwrap();
        if p.hello_at.is_some()
            && proto::send(p.sock.as_ref().unwrap().as_fd(), &spec.start, &[]).is_err()
        {
            return Err(spec);
        }
        let hello = p.hello_at.is_some();
        let (pid, spare_ms) = (p.pid, now.saturating_duration_since(p.started).as_secs_f64() * 1e3);
        // The load starts now: the start's grace and its cap count from here.
        p.started = now;
        p.start_moved_at = now;
        p.start_activity = None;
        p.last_beat = now;
        p.adopted = Some(AdoptedLoad {
            at: now,
            moved_at: now,
            activity: start_activity(p.pid),
            sampled: now,
        });
        let prev_id = std::mem::replace(&mut self.spec, spec).id;
        self.spare = false;
        self.state = if hello {
            WorkerState::Running
        } else {
            WorkerState::Starting
        };
        if let Some(h) = self.hello_replay.take() {
            self.pending.push(WorkerEvent::Msg(h, Vec::new()));
        }
        self.push_line(format!(
            "--- liascape-player: spare worker adopted by {} ---",
            self.spec.id
        ));
        log::event(
            "worker",
            Level::Info,
            "worker.adopted",
            Some(self.corr.clone()),
            json!({"id": self.spec.id, "pid": pid, "was": prev_id, "hello": hello,
                   "spare_ms": spare_ms}),
        );
        Ok(())
    }

    /// A spare not adopted yet.
    pub fn is_spare(&self) -> bool {
        self.spare
    }

    /// The live worker said `Hello` (its GL context is up).
    pub fn said_hello(&self) -> bool {
        self.proc_.as_ref().is_some_and(|p| p.hello_at.is_some())
    }

    /// Since the live worker's spawn (a spare's age; restarted at an adoption).
    pub fn age(&self, now: Instant) -> Option<Duration> {
        self.proc_
            .as_ref()
            .map(|p| now.saturating_duration_since(p.started))
    }

    /// Readable whenever [`poll`](Self::poll) has something to do (a message, worker output,
    /// EOF). An epoll fd over the current socket + output pipe — **stable across restarts**;
    /// owned by the host (register a `dup`, like the mpv wake fds).
    pub fn wake_fd(&self) -> RawFd {
        self.epoll.as_raw_fd()
    }

    /// Record `m` for the next `Start` only (what [`send`](Self::send) folds), never sent
    /// to the running worker — `false` = not a message that folds. F6b: a gain push to a
    /// scene without sound (no stream to apply it to) — a fade pushes one per source per
    /// millisecond.
    pub fn fold(&mut self, m: &ToWorker) -> bool {
        self.fold_into_start(m)
    }

    /// Send `m` (+ fds). While no worker is connected (`Starting` before `Hello`,
    /// `Restarting`, `Broken`, `Stopped`) only what folds into the next `Start` is accepted
    /// (`Start` itself, `Paused`, `Resize`, `Route`, `SetProperty` — recorded for the
    /// restart's `Start`, so a restart never resumes with stale values; `SetProperty` is
    /// recorded while connected too); everything else is `NotConnected` (the
    /// caller re-sends gains/pointer after the new worker's `Ready`). `WouldBlock` = the
    /// worker isn't reading (its socket buffer is full).
    pub fn send(&mut self, m: &ToWorker, fds: &[BorrowedFd]) -> io::Result<()> {
        let folded = self.fold_into_start(m);
        let Some(p) = self
            .proc_
            .as_mut()
            .filter(|p| p.hello_at.is_some() && p.sock.is_some() && !p.killed)
        else {
            return if folded {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::NotConnected,
                    "scene worker not connected",
                ))
            };
        };
        proto::send(p.sock.as_ref().unwrap().as_fd(), m, fds)?;
        let now = Instant::now();
        match m {
            ToWorker::Tick { seq, .. } => {
                p.ticks.push_back((*seq, now));
                p.last_beat = now;
            }
            ToWorker::Ping { seq } => {
                p.ping = Some((*seq, now));
                p.last_beat = now;
            }
            ToWorker::Release { slot } => p.held.retain(|s| s != slot),
            _ => {}
        }
        Ok(())
    }

    /// Never blocks: drains messages and output, reaps, runs the heartbeat and the restart
    /// policy. Call on every wake and regularly (the hang check needs time to pass).
    pub fn poll(&mut self, now: Instant) -> Vec<WorkerEvent> {
        self.poll_io(now, true)
    }

    /// [`poll`](Self::poll), told whether [`wake_fd`](Self::wake_fd) was readable — `false`
    /// (the caller's own epoll just said it isn't) skips the reads, leaving the heartbeat,
    /// the hang check and the reaping. F6b: a scene source polls on every frame and every
    /// tick.
    pub fn poll_io(&mut self, now: Instant, io: bool) -> Vec<WorkerEvent> {
        let mut out = std::mem::take(&mut self.pending);
        if self.proc_.is_none() {
            return out;
        }
        self.host_stall_grace(now);
        // F6b: read only what is ready (one `epoll_wait` instead of a `read` and a `recvmsg`
        // that mostly find nothing — this runs on every frame).
        let (sock_ready, out_ready) = if io { self.ready() } else { (false, false) };
        if out_ready {
            self.drain_output(false);
        }
        if sock_ready {
            self.drain_socket(now, &mut out);
        }
        self.heartbeat(now, &mut out);
        self.watch_adopted_load(now, &mut out);
        let ending = self
            .proc_
            .as_ref()
            .is_some_and(|p| p.killed || p.sock.is_none() || p.out.is_none());
        if ending
            || self
                .reap_checked
                .is_none_or(|t| now.saturating_duration_since(t) >= REAP_CHECK)
        {
            self.reap_checked = Some(now);
            self.reap(now, &mut out);
        }
        out
    }

    /// `(socket, output)` readable (or hung up) now, from the host's own epoll set; both
    /// when it can't tell.
    fn ready(&self) -> (bool, bool) {
        let Some(p) = self.proc_.as_ref() else {
            return (false, false);
        };
        let mut evs = [libc::epoll_event { events: 0, u64: 0 }; 4];
        let n = unsafe {
            libc::epoll_wait(
                self.epoll.as_raw_fd(),
                evs.as_mut_ptr(),
                evs.len() as i32,
                0,
            )
        };
        if n < 0 {
            return (true, true);
        }
        let sock = p.sock.as_ref().map(|f| f.as_raw_fd() as u64);
        let out = p.out.as_ref().map(|f| f.as_raw_fd() as u64);
        let mut r = (false, false);
        for ev in &evs[..n as usize] {
            let fd = ev.u64;
            r.0 |= sock == Some(fd);
            r.1 |= out == Some(fd);
        }
        r
    }

    /// The scene time a restart's `Start` carries.
    pub fn set_resume_position(&mut self, t: f64) {
        if let ToWorker::Start { position, .. } = &mut self.spec.start {
            *position = t;
        }
    }

    /// End the live worker as a crash — SIGKILL now, then the usual path (`Exited`,
    /// a restart through the [`RestartBudget`], or `Broken` + a crash record), with `why`
    /// leading the restart's / record's reason (`"GL context lost, killed by signal 9"`).
    /// For a worker that reported it can't go on (`ContextLost`). Never blocks; a no-op when
    /// nothing is running or it is already being killed.
    pub fn kill_for_restart(&mut self, why: &str) {
        let Some(p) = self.proc_.as_mut().filter(|p| !p.killed) else {
            return;
        };
        unsafe { libc::kill(p.pid, libc::SIGKILL) };
        p.killed = true;
        p.why = Some(why.to_string());
        let pid = p.pid;
        log::event(
            "worker",
            Level::Warn,
            "worker.killed",
            Some(self.corr.clone()),
            json!({"id": self.spec.id, "pid": pid, "why": why}),
        );
    }

    /// `Quit`, then the process is handed to the reaper (SIGKILL after [`STOP_GRACE`]).
    /// Never blocks; `Stopped` afterwards, no more events.
    pub fn stop(&mut self) {
        // What the worker wrote before the message that made us stop (a fatal error's own
        // stderr line) is still in the pipe: keep it in the tail (non-blocking).
        self.drain_output(false);
        if let Some(p) = self.proc_.take() {
            if let Some(s) = &p.sock {
                let _ = proto::send(s.as_fd(), &ToWorker::Quit, &[]);
            }
            self.forget_fds(&p);
            reap::hand_off(p.pid, Instant::now() + STOP_GRACE);
            log::event(
                "worker",
                Level::Info,
                "worker.stopped",
                Some(self.corr.clone()),
                json!({"id": self.spec.id, "pid": p.pid}),
            );
        }
        self.state = WorkerState::Stopped;
    }

    pub fn state(&self) -> &WorkerState {
        &self.state
    }

    /// The live worker's pid (none once broken or stopped).
    pub fn pid(&self) -> Option<u32> {
        self.proc_.as_ref().map(|p| p.pid as u32)
    }

    /// The last [`LOG_TAIL`] lines of worker output (stderr/stdout + `Log` messages), oldest
    /// first, across restarts.
    pub fn log_tail(&self) -> Vec<String> {
        self.tail.iter().cloned().collect()
    }

    /// Restarts within the budget's window right now, and since spawn.
    pub fn restarts(&self, now: Instant) -> (u32, u32) {
        let w = self.spec.budget.window;
        let recent = self
            .history
            .iter()
            .filter(|t| now.saturating_duration_since(**t) < w)
            .count() as u32;
        (recent, self.total_restarts)
    }

    /// The live worker's `Hello.sync` (`fence` | `fdpoll` | `none`).
    pub fn sync(&self) -> Option<&str> {
        self.sync.as_deref()
    }

    pub fn spec(&self) -> &WorkerSpec {
        &self.spec
    }

    // ---- internals ----------------------------------------------------------------------

    fn fold_into_start(&mut self, m: &ToWorker) -> bool {
        let ToWorker::Start {
            paused: sp,
            max_size: sm,
            audio: sa,
            properties: props,
            gain_db: sg,
            no_audio: sn,
            speed: ss,
            loudness: sl,
            ..
        } = &mut self.spec.start
        else {
            return false;
        };
        match m {
            ToWorker::Start { .. } => self.spec.start = m.clone(),
            ToWorker::Paused { paused } => *sp = *paused,
            ToWorker::Resize { max_size } => *sm = *max_size,
            ToWorker::Route { audio } => *sa = audio.clone(),
            // A scene property set live must survive a restart.
            ToWorker::SetProperty { name, value } => {
                props.insert(name.clone(), value.clone());
            }
            // The stream's state is recorded while connected too (like
            // `SetProperty`): a restart starts at the latest gain (faded in by the worker's
            // own gate), mute and speed.
            ToWorker::Gain { db } => *sg = *db,
            ToWorker::NoAudio { on } => *sn = *on,
            ToWorker::Speed { speed } => *ss = *speed,
            // A capped loudness measurement stays capped across a restart.
            ToWorker::LoudnessMeter { on } => *sl = *on,
            _ => return false,
        }
        true
    }

    fn spawn_proc(&mut self, attempt: u32) -> io::Result<Proc> {
        let (host_end, child_end) = socketpair()?;
        set_nonblocking(host_end.as_raw_fd())?;
        let (out_r, out_w) = pipe()?;
        set_nonblocking(out_r.as_raw_fd())?;
        // Out of the 0..=3 range the child's dup2s write to, so no action clobbers another
        // and fd 3 never equals its source (an `adddup2(3, 3)` would keep CLOEXEC set).
        let child_end = high_fd(child_end)?;
        let out_w = high_fd(out_w)?;

        let mut argv: Vec<CString> = vec![
            cstr(self.spec.bin.as_os_str().as_bytes())?,
            c"--fd".into(),
            CString::new(CHILD_FD.to_string()).unwrap(),
            c"--parent-pid".into(),
            CString::new(std::process::id().to_string()).unwrap(),
        ];
        for a in self.spec.args.iter().chain(&preload_args(&self.spec.start)) {
            argv.push(cstr(a.as_bytes())?);
        }
        let mut envp: Vec<CString> = Vec::new();
        for (k, v) in std::env::vars_os() {
            if self.spec.env.iter().any(|(sk, _)| OsString::from(sk) == k) {
                continue;
            }
            let mut kv = k.as_bytes().to_vec();
            kv.push(b'=');
            kv.extend_from_slice(v.as_bytes());
            if let Ok(c) = CString::new(kv) {
                envp.push(c);
            }
        }
        for (k, v) in &self.spec.env {
            envp.push(cstr(format!("{k}={v}").as_bytes())?);
        }
        let mut argv_p: Vec<*mut libc::c_char> =
            argv.iter().map(|c| c.as_ptr() as *mut _).collect();
        argv_p.push(std::ptr::null_mut());
        let mut envp_p: Vec<*mut libc::c_char> =
            envp.iter().map(|c| c.as_ptr() as *mut _).collect();
        envp_p.push(std::ptr::null_mut());

        let mut pid: libc::pid_t = 0;
        let rc = unsafe {
            let mut fa: libc::posix_spawn_file_actions_t = std::mem::zeroed();
            libc::posix_spawn_file_actions_init(&mut fa);
            libc::posix_spawn_file_actions_addopen(
                &mut fa,
                0,
                c"/dev/null".as_ptr(),
                libc::O_RDONLY,
                0,
            );
            libc::posix_spawn_file_actions_adddup2(&mut fa, out_w.as_raw_fd(), 1);
            libc::posix_spawn_file_actions_adddup2(&mut fa, out_w.as_raw_fd(), 2);
            libc::posix_spawn_file_actions_adddup2(&mut fa, child_end.as_raw_fd(), CHILD_FD);
            let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
            libc::posix_spawnattr_init(&mut attr);
            let mut empty: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut empty);
            let mut dfl: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut dfl);
            for s in [
                libc::SIGPIPE,
                libc::SIGINT,
                libc::SIGTERM,
                libc::SIGHUP,
                libc::SIGQUIT,
                libc::SIGCHLD,
                libc::SIGUSR1,
                libc::SIGUSR2,
                libc::SIGALRM,
            ] {
                libc::sigaddset(&mut dfl, s);
            }
            libc::posix_spawnattr_setsigmask(&mut attr, &empty);
            libc::posix_spawnattr_setsigdefault(&mut attr, &dfl);
            libc::posix_spawnattr_setflags(
                &mut attr,
                (libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF) as libc::c_short,
            );
            let rc = libc::posix_spawn(
                &mut pid,
                argv[0].as_ptr(),
                &fa,
                &attr,
                argv_p.as_ptr(),
                envp_p.as_ptr(),
            );
            libc::posix_spawn_file_actions_destroy(&mut fa);
            libc::posix_spawnattr_destroy(&mut attr);
            rc
        };
        drop(child_end);
        drop(out_w);
        if rc != 0 {
            let e = io::Error::from_raw_os_error(rc);
            log::event(
                "worker",
                Level::Error,
                "worker.spawn_failed",
                Some(self.corr.clone()),
                json!({"id": self.spec.id, "bin": self.spec.bin, "error": e.to_string()}),
            );
            return Err(io::Error::new(
                e.kind(),
                format!("spawn {}: {e}", self.spec.bin.display()),
            ));
        }
        epoll_add(self.epoll.as_raw_fd(), host_end.as_raw_fd())?;
        epoll_add(self.epoll.as_raw_fd(), out_r.as_raw_fd())?;
        log::event(
            "worker",
            Level::Info,
            "worker.spawned",
            Some(self.corr.clone()),
            json!({"id": self.spec.id, "pid": pid, "bin": self.spec.bin, "attempt": attempt}),
        );
        let now = Instant::now();
        Ok(Proc {
            pid,
            sock: Some(host_end),
            out: Some(out_r),
            started: now,
            hello_at: None,
            framed: false,
            start_activity: None,
            start_moved_at: now,
            ticks: VecDeque::new(),
            ping: None,
            last_beat: now,
            ring: Vec::new(),
            ring_size: (0, 0),
            held: Vec::new(),
            starved_since: None,
            eof_at: None,
            killed: false,
            hung: false,
            why: None,
            adopted: None,
        })
    }

    fn forget_fds(&self, p: &Proc) {
        for fd in [&p.sock, &p.out].into_iter().flatten() {
            epoll_del(self.epoll.as_raw_fd(), fd.as_raw_fd());
        }
    }

    fn push_line(&mut self, line: String) {
        if self.tail.len() == LOG_TAIL {
            self.tail.pop_front();
        }
        self.tail.push_back(line);
    }

    /// Read worker output into the tail; `to_eof` = the process is gone, read everything.
    fn drain_output(&mut self, to_eof: bool) {
        let Some(fd) = self
            .proc_
            .as_ref()
            .and_then(|p| p.out.as_ref())
            .map(|f| f.as_raw_fd())
        else {
            return;
        };
        let mut buf = [0u8; 16 * 1024];
        let mut total = 0;
        let mut eof = false;
        while to_eof || total < MAX_READ_PER_POLL {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n == 0 {
                eof = true;
                break;
            }
            if n < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break; // EAGAIN (nothing more now) or a real error
            }
            total += n as usize;
            for &b in &buf[..n as usize] {
                if b == b'\n' {
                    let l = std::mem::take(&mut self.partial);
                    self.push_line(line_of(&l));
                } else if self.partial.len() < MAX_LINE {
                    self.partial.push(b);
                } else if self.partial.len() == MAX_LINE {
                    self.partial.extend_from_slice("…".as_bytes());
                }
            }
        }
        if eof || to_eof {
            if !self.partial.is_empty() {
                let l = std::mem::take(&mut self.partial);
                self.push_line(line_of(&l));
            }
            if eof && let Some(p) = self.proc_.as_mut() {
                let f = p.out.take();
                if let Some(f) = &f {
                    epoll_del(self.epoll.as_raw_fd(), f.as_raw_fd());
                }
            }
        }
    }

    fn drain_socket(&mut self, now: Instant, out: &mut Vec<WorkerEvent>) {
        loop {
            let Some(p) = self.proc_.as_mut() else { return };
            let Some(sock) = p.sock.as_ref() else { return };
            match proto::recv::<FromWorker>(sock.as_fd()) {
                Ok(None) => return,
                Ok(Some((m, fds))) => self.on_message(now, m, fds, out),
                Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                    log::event(
                        "worker",
                        Level::Warn,
                        "worker.bad_message",
                        Some(self.corr.clone()),
                        json!({"id": self.spec.id, "error": e.to_string()}),
                    );
                }
                Err(_) => {
                    // EOF (the crash signal, `docs/player/spikes/dmabuf.md` §6) or a dead socket.
                    let p = self.proc_.as_mut().unwrap();
                    let s = p.sock.take().unwrap();
                    p.eof_at = Some(now);
                    epoll_del(self.epoll.as_raw_fd(), s.as_raw_fd());
                    return;
                }
            }
        }
    }

    fn on_message(
        &mut self,
        now: Instant,
        m: FromWorker,
        fds: Vec<OwnedFd>,
        out: &mut Vec<WorkerEvent>,
    ) {
        let p = self.proc_.as_mut().unwrap();
        match &m {
            FromWorker::Pong { seq } => {
                if p.ping.is_some_and(|(s, _)| s == *seq) {
                    p.ping = None;
                }
                return;
            }
            FromWorker::Frame { seq, slot, .. } => {
                p.framed = true;
                p.adopted = None;
                while p.ticks.front().is_some_and(|(s, _)| s <= seq) {
                    p.ticks.pop_front();
                }
                if !p.held.contains(slot) {
                    p.held.push(*slot);
                }
            }
            FromWorker::Buffer { slot, w, h, .. } => {
                // A ring is exported whole, before any frame of it, and a re-export (`resize`)
                // is always a new size: a new size starts a new ring.
                if p.ring_size != (*w, *h) {
                    p.ring.clear();
                    p.ring_size = (*w, *h);
                }
                if !p.ring.contains(slot) {
                    p.ring.push(*slot);
                }
            }
            FromWorker::Hello {
                protocol,
                pid,
                features,
                sync,
            } => {
                p.hello_at = Some(now);
                renderer::note_loads("worker");
                let (protocol, features, sync) = (*protocol, features.clone(), sync.clone());
                log::event(
                    "worker",
                    Level::Info,
                    "worker.ready",
                    Some(self.corr.clone()),
                    json!({"id": self.spec.id, "pid": pid, "protocol": protocol,
                           "features": features, "sync": sync,
                           "ms": now.saturating_duration_since(p.started).as_secs_f64() * 1e3}),
                );
                if protocol != proto::PROTOCOL {
                    // A different build of the worker: it can't play, and a restart wouldn't
                    // change that — the caller sees a fatal error and stops the host.
                    out.push(WorkerEvent::Msg(
                        FromWorker::Error {
                            reason: format!(
                                "scene worker {} speaks protocol {protocol}, this player {} — \
                                 rebuild/reinstall both",
                                self.spec.bin.display(),
                                proto::PROTOCOL
                            ),
                            fatal: true,
                        },
                        Vec::new(),
                    ));
                    return;
                }
                self.sync = Some(sync);
                if self.spare {
                    // No scene yet: the `Start` goes at the adoption, which replays this.
                    self.hello_replay = Some(m.clone());
                    out.push(WorkerEvent::Msg(m, fds));
                    return;
                }
                self.state = WorkerState::Running;
                let start = self.spec.start.clone();
                let p = self.proc_.as_mut().unwrap();
                if let Some(s) = &p.sock {
                    let _ = proto::send(s.as_fd(), &start, &[]);
                    p.last_beat = now;
                }
            }
            FromWorker::Log { level, line } => {
                let l = format!("[{level}] {line}");
                self.push_line(l);
            }
            // The load is over: built, or it can't play.
            FromWorker::Ready { .. } | FromWorker::Error { fatal: true, .. } => p.adopted = None,
            _ => {}
        }
        out.push(WorkerEvent::Msg(m, fds));
    }

    /// Time the host itself didn't run is not the worker's: a gap between two polls longer
    /// than [`host_stall_gap`] (the loop was blocked — a driver call while the whole GPU is
    /// busy, e.g. NVIDIA saving VRAM before a suspend) gives every outstanding tick/ping (and
    /// a pending `Hello`) a fresh hang timeout from now. Polls come at the loop's tick rate,
    /// so only a real stall reaches the gap; a worker that freezes while the host keeps
    /// polling is judged exactly as before.
    fn host_stall_grace(&mut self, now: Instant) {
        let last = self.last_poll.replace(now);
        let Some(gap) = last.map(|l| now.saturating_duration_since(l)) else {
            return;
        };
        if gap <= host_stall_gap(self.spec.hang_timeout) {
            return;
        }
        let Some(p) = self.proc_.as_mut().filter(|p| !p.killed) else {
            return;
        };
        let outstanding = p.ticks.len() + p.ping.is_some() as usize;
        for t in p.ticks.iter_mut() {
            t.1 = now;
        }
        if let Some(ping) = p.ping.as_mut() {
            ping.1 = now;
        }
        if p.hello_at.is_none() {
            p.started = now;
        }
        p.start_moved_at = now;
        if let Some(a) = p.adopted.as_mut() {
            a.moved_at = now;
        }
        if outstanding > 0 || p.hello_at.is_none() {
            log::event(
                "worker",
                Level::Info,
                "worker.host_stalled",
                Some(self.corr.clone()),
                json!({"id": self.spec.id, "pid": p.pid, "gap_ms": gap.as_secs_f64() * 1e3,
                       "outstanding": outstanding, "hello": p.hello_at.is_some()}),
            );
        }
    }

    fn heartbeat(&mut self, now: Instant, out: &mut Vec<WorkerEvent>) {
        let ping_every = PING_INTERVAL.min(self.spec.hang_timeout / 2);
        let hang = self.spec.hang_timeout;
        let Some(p) = self.proc_.as_mut() else { return };
        if p.killed {
            return;
        }
        // Starved = the host holds every slot of the worker's ring: it can't render a tick
        // until we release one, so its ticks wait on us — their age doesn't count (they are
        // re-stamped while it lasts) and its liveness is the ping instead (the renderer,
        // idle waiting for a `Release`, answers it). Bounded: a tick starved past
        // `STARVE_LIMIT_FACTOR` × the hang timeout is a hang all the same.
        let starved = !p.ring.is_empty() && p.ring.iter().all(|s| p.held.contains(s));
        let mut starved_ms = None;
        if starved && !p.ticks.is_empty() {
            let since = *p.starved_since.get_or_insert(now);
            let w = now.saturating_duration_since(since);
            if w > hang * STARVE_LIMIT_FACTOR {
                starved_ms = Some(w);
            } else {
                for t in p.ticks.iter_mut() {
                    t.1 = now;
                }
            }
        } else {
            p.starved_since = None;
        }
        // Still starting (no `Frame` yet, see `HELLO_TIMEOUT`): a late answer is no hang while
        // the process moved within the last third of the bound it is late for, up to the cap
        // from its spawn. Sampled on each poll from one window before that bound on (an unloaded
        // start answers in time and reads nothing).
        let base = self.spec.hello_timeout.max(hang);
        let since_spawn = now.saturating_duration_since(p.started);
        let starting_moves = |p: &mut Proc, window: Duration, near_bound: bool| -> bool {
            if p.framed || since_spawn > base * HELLO_TIMEOUT_MAX_FACTOR {
                return false;
            }
            if near_bound {
                let cpu_counts = p.hello_at.is_none();
                let a = start_activity(p.pid);
                let moved = match (p.start_activity, a) {
                    (_, Some(a)) if a.in_io => true,
                    (Some(b), Some(a)) => a.majflt != b.majflt || (cpu_counts && a.cpu != b.cpu),
                    _ => false,
                };
                if moved {
                    p.start_moved_at = now;
                }
                p.start_activity = a;
            }
            now.saturating_duration_since(p.start_moved_at) < window
        };
        let waited = match p.hello_at {
            None => {
                let window = base / HELLO_PROGRESS_DIV;
                let moves = starting_moves(p, window, since_spawn + window > base);
                (since_spawn > base && !moves).then_some(since_spawn)
            }
            Some(_) => {
                let oldest = [p.ticks.front().map(|t| t.1), p.ping.map(|t| t.1)]
                    .into_iter()
                    .flatten()
                    .min()
                    .map(|t| now.saturating_duration_since(t));
                let window = hang / HELLO_PROGRESS_DIV;
                let moves = starting_moves(p, window, oldest.is_some_and(|w| w + window > hang));
                oldest
                    .filter(|w| *w > hang && !moves)
                    .or(starved_ms)
            }
        };
        if let Some(w) = waited {
            unsafe { libc::kill(p.pid, libc::SIGKILL) };
            p.killed = true;
            p.hung = true;
            let waited_ms = w.as_millis() as u64;
            log::event(
                "worker",
                Level::Warn,
                "worker.hung",
                Some(self.corr.clone()),
                json!({"id": self.spec.id, "pid": p.pid, "waited_ms": waited_ms,
                       "hello": p.hello_at.is_some(),
                       "starved_ms": starved_ms.map(|w| w.as_millis() as u64)}),
            );
            out.push(WorkerEvent::Hung { waited_ms });
            return;
        }
        if let Some(t) = p.eof_at
            && now.saturating_duration_since(t) > EOF_KILL_AFTER
        {
            // Closed its socket but kept running: useless — make it a crash.
            unsafe { libc::kill(p.pid, libc::SIGKILL) };
            p.killed = true;
            return;
        }
        if p.hello_at.is_some()
            && p.ping.is_none()
            && (p.ticks.is_empty() || starved)
            && now.saturating_duration_since(p.last_beat) >= ping_every
            && let Some(s) = &p.sock
        {
            self.ping_seq += 1;
            if proto::send(s.as_fd(), &ToWorker::Ping { seq: self.ping_seq }, &[]).is_ok() {
                p.ping = Some((self.ping_seq, now));
                p.last_beat = now;
            }
        }
    }

    /// An adopted spare whose load stopped moving (no CPU time, major fault or IO wait for
    /// [`spare_load_stall`]) is dropped: SIGKILLed and replaced by a fresh
    /// worker that loads the scene from scratch, as if no spare had been there. Not a crash — the
    /// spare process is suspect, not the scene: no restart budget, no crash record, no `Exited`
    /// (the source keeps waiting for its first frame, no preview); `worker.spare_dropped` says
    /// why. Only the adopted process is watched: the fresh one is an ordinary worker, judged by
    /// the heartbeat and the worker's `LoadGate` alone, so a stall the machine causes costs one
    /// extra load at most. Guards: `tests/worker.rs::spare_load_stall_drops_it_for_a_fresh_worker`,
    /// `spare_load_that_moves_is_kept`, `tests/api.rs::spare_load_stall_is_replaced_by_a_fresh_worker`.
    fn watch_adopted_load(&mut self, now: Instant, out: &mut Vec<WorkerEvent>) {
        let window = spare_load_stall(self.spec.hang_timeout);
        let Some(p) = self.proc_.as_mut().filter(|p| !p.killed) else {
            return;
        };
        let pid = p.pid;
        let Some(a) = p.adopted.as_mut() else { return };
        if now.saturating_duration_since(a.sampled) < REAP_CHECK.min(window / 4) {
            return;
        }
        a.sampled = now;
        // Unreadable = gone: the reap decides.
        let Some(cur) = start_activity(pid) else {
            return;
        };
        let moved = cur.in_io
            || a.activity
                .is_none_or(|b| b.cpu != cur.cpu || b.majflt != cur.majflt);
        a.activity = Some(cur);
        if moved {
            a.moved_at = now;
            return;
        }
        let quiet = now.saturating_duration_since(a.moved_at);
        if quiet < window {
            return;
        }
        let load_ms = now.saturating_duration_since(a.at).as_secs_f64() * 1e3;
        let wchan = std::fs::read_to_string(format!("/proc/{pid}/wchan")).unwrap_or_default();
        let why = format!(
            "the adopted spare's load stalled: no CPU time, page fault or IO for {:.0} ms, {load_ms:.0} ms \
             into the load{}",
            quiet.as_secs_f64() * 1e3,
            if wchan.is_empty() || wchan == "0" {
                String::new()
            } else {
                format!(" (waiting in {wchan})")
            }
        );
        // Its last lines (what it was doing) stay in the tail.
        self.drain_output(false);
        let p = self.proc_.take().unwrap();
        unsafe { libc::kill(p.pid, libc::SIGKILL) };
        self.forget_fds(&p);
        reap::hand_off(p.pid, now);
        self.sync = None;
        log::event(
            "worker",
            Level::Warn,
            "worker.spare_dropped",
            Some(self.corr.clone()),
            json!({"id": self.spec.id, "pid": p.pid, "why": why, "load_ms": load_ms,
                   "quiet_ms": quiet.as_secs_f64() * 1e3, "wchan": wchan}),
        );
        self.push_line(format!(
            "--- liascape-player: {why}; a fresh worker loads the scene ---"
        ));
        match self.spawn_proc(0) {
            Ok(np) => {
                self.proc_ = Some(np);
                self.state = WorkerState::Starting;
                out.push(WorkerEvent::Replaced { why });
            }
            Err(e) => self.broken(
                format!("{why}; its replacement failed to start: {e}"),
                None,
                None,
                Duration::from_secs_f64(load_ms / 1e3),
                out,
            ),
        }
    }

    fn reap(&mut self, now: Instant, out: &mut Vec<WorkerEvent>) {
        let Some(pid) = self.proc_.as_ref().map(|p| p.pid) else {
            return;
        };
        let mut status = 0;
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == 0 {
            return;
        }
        let (signal, code) = if r < 0 {
            (None, None) // ECHILD: someone else reaped it — gone all the same
        } else if libc::WIFSIGNALED(status) {
            (Some(libc::WTERMSIG(status)), None)
        } else {
            (None, Some(libc::WEXITSTATUS(status)))
        };
        self.drain_output(true);
        let p = self.proc_.take().unwrap();
        self.forget_fds(&p);
        let uptime = now.saturating_duration_since(p.started);
        log::event(
            "worker",
            Level::Warn,
            "worker.exited",
            Some(self.corr.clone()),
            json!({"id": self.spec.id, "pid": pid, "signal": signal, "code": code,
                   "hung": p.hung, "uptime_ms": uptime.as_secs_f64() * 1e3}),
        );
        out.push(WorkerEvent::Exited { signal, code });
        self.sync = None;
        if self.spare {
            // A spare holds no scene: its death is no crash of anything (the pool replaces it).
            self.state = WorkerState::Stopped;
            return;
        }
        if code == Some(LOADER_FAILED) && p.hello_at.is_none() {
            // The dynamic loader gave up before the worker ran a line: every restart would too, and
            // the scene did nothing wrong — the install did. No restart, no crash record (that
            // would mark every scene crashed): a fatal error with the reason, which the caller
            // stops the host on, and the renderer marked missing ([`renderer`]: the outbox fact
            // `scene.renderer_missing`, scenes off until a worker loads again).
            // Guards: `tests/api.rs::worker_without_its_core_fails_without_crash_record`, adapter IT
            // § "a scene worker that can't load the scene renderer".
            let detail = self
                .tail
                .iter()
                .rev()
                .find(|l| l.contains("error while loading shared libraries"))
                .cloned()
                .unwrap_or_else(|| format!("exited with code {LOADER_FAILED} before it started"));
            self.state = WorkerState::Stopped;
            let path = self.scene_path();
            renderer::note_missing(
                &self.spec.bin,
                &detail,
                json!({"id": self.spec.id, "path": path, "scene_id": scene_id_of(&path, &self.spec.id)}),
            );
            out.push(WorkerEvent::Msg(
                FromWorker::Error {
                    reason: format!("{RENDERER_MISSING} ({detail})"),
                    fatal: true,
                },
                Vec::new(),
            ));
            return;
        }

        let how = match (signal, code) {
            (Some(s), _) => format!("killed by signal {s}"),
            (_, Some(c)) => format!("exited with code {c}"),
            _ => "vanished".to_string(),
        };
        let how = match (&p.why, p.hung) {
            (Some(why), _) => format!("{why}, {how}"),
            (None, true) => format!("hung, {how}"),
            (None, false) => how,
        };
        match self.spec.budget.admit(&mut self.history, now) {
            Some(attempt) => match self.spawn_proc(attempt) {
                Ok(np) => {
                    self.proc_ = Some(np);
                    self.total_restarts += 1;
                    self.state = WorkerState::Restarting { attempt };
                    self.push_line(format!(
                        "--- liascape-player: worker {how}; restart {attempt} ---"
                    ));
                    log::event(
                        "worker",
                        Level::Warn,
                        "worker.restart",
                        Some(self.corr.clone()),
                        json!({"id": self.spec.id, "attempt": attempt, "prev_pid": pid,
                               "pid": self.proc_.as_ref().unwrap().pid, "why": how}),
                    );
                    out.push(WorkerEvent::Restarted { attempt });
                }
                Err(e) => self.broken(
                    format!("{how}; restart failed: {e}"),
                    signal,
                    code,
                    uptime,
                    out,
                ),
            },
            None => {
                let reason = format!(
                    "{how} after {} restarts within {} s",
                    self.history.len(),
                    self.spec.budget.window.as_secs()
                );
                self.broken(reason, signal, code, uptime, out);
            }
        }
    }

    /// The scene's identity (`path`, not the folder a preset loads): what events and records name.
    fn scene_path(&self) -> String {
        match (&self.spec.record_path, &self.spec.start) {
            (Some(p), _) => p.clone(),
            (None, ToWorker::Start { path, .. }) => path.clone(),
            _ => String::new(),
        }
    }

    fn broken(
        &mut self,
        reason: String,
        signal: Option<i32>,
        code: Option<i32>,
        uptime: Duration,
        out: &mut Vec<WorkerEvent>,
    ) {
        let path = self.scene_path();
        let scene_id = scene_id_of(&path, &self.spec.id);
        let mut rec = json!({
            "scene_id": scene_id,
            "id": self.spec.id,
            "path": path,
            "reason": reason,
            "restarts": self.history.len(),
            "total_restarts": self.total_restarts,
            "uptime_ms": uptime.as_secs_f64() * 1e3,
            "t_wall": wall_now(),
            "log_tail": self.log_tail(),
        });
        match (signal, code) {
            (Some(s), _) => rec["signal"] = json!(s),
            (_, Some(c)) => rec["code"] = json!(c),
            _ => {}
        }
        let record = match write_crash_record(&self.spec.crash_dir, &scene_id, &rec) {
            Ok(p) => p,
            Err(e) => {
                log::event(
                    "worker",
                    Level::Error,
                    "worker.record_failed",
                    Some(self.corr.clone()),
                    json!({"id": self.spec.id, "dir": self.spec.crash_dir, "error": e.to_string()}),
                );
                self.spec.crash_dir.join(format!("{scene_id}.json"))
            }
        };
        log::event(
            "worker",
            Level::Error,
            "worker.broken",
            Some(self.corr.clone()),
            json!({"id": self.spec.id, "reason": reason, "record": record,
                   "restarts": self.history.len()}),
        );
        self.state = WorkerState::Broken { reason };
        out.push(WorkerEvent::Broken { record });
    }
}

impl Drop for WorkerHost {
    fn drop(&mut self) {
        if self.proc_.is_some() {
            self.stop();
        }
    }
}

/// The record name's scene id: the item folder's name (a Workshop id), else the source id.
fn scene_id_of(path: &str, fallback: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let clean: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if clean.is_empty() {
        fallback
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    } else {
        clean
    }
}

fn wall_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// `<dir>/<scene_id>-<unix_ms>.json` (`-<n>` appended on a collision), written atomically;
/// then the oldest records beyond [`MAX_CRASH_RECORDS`] are deleted.
pub fn write_crash_record(dir: &Path, scene_id: &str, rec: &Value) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut path = dir.join(format!("{scene_id}-{ms}.json"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{scene_id}-{ms}-{n}.json"));
        n += 1;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(rec)?)?;
    std::fs::rename(&tmp, &path)?;
    let mut all: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    if all.len() > MAX_CRASH_RECORDS {
        all.sort();
        for (_, p) in &all[..all.len() - MAX_CRASH_RECORDS] {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(path)
}

fn line_of(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches('\r')
        .to_string()
}

fn cstr(b: &[u8]) -> io::Result<CString> {
    CString::new(b).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

fn socketpair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    let r = unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let fl = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if fl < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, fl | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A `CLOEXEC` copy of `fd` numbered ≥ 10.
fn high_fd(fd: OwnedFd) -> io::Result<OwnedFd> {
    let n = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(n) })
}

fn epoll_add(ep: RawFd, fd: RawFd) -> io::Result<()> {
    let mut ev = libc::epoll_event {
        events: libc::EPOLLIN as u32,
        u64: fd as u64,
    };
    if unsafe { libc::epoll_ctl(ep, libc::EPOLL_CTL_ADD, fd, &mut ev) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn epoll_del(ep: RawFd, fd: RawFd) {
    unsafe { libc::epoll_ctl(ep, libc::EPOLL_CTL_DEL, fd, std::ptr::null_mut()) };
}

/// Stopped workers' last moments: one `lia-worker-reap` thread (started on demand, gone once
/// nothing is dying) reaps them and SIGKILLs any still alive at its deadline — so `stop` and
/// `Drop` never wait for a process. How each one ended is kept ([`ended`]): a worker told to
/// quit that dies of a signal nobody sent crashed in its own teardown (`worker.exit_crash`), which
/// nothing else would see — the scene was already gone from the screen. Guard:
/// `tests/scene.rs::real_worker_with_video_textures_ends_cleanly`.
pub mod reap {
    use super::*;

    struct Dying {
        pid: libc::pid_t,
        kill_at: Instant,
        killed: bool,
    }

    /// How a stopped worker ended.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Ended {
        pub pid: libc::pid_t,
        /// `exit(code)` / `_exit(code)`
        pub code: Option<i32>,
        /// died of this signal
        pub signal: Option<i32>,
        /// the reaper SIGKILLed it at its deadline (so `signal` 9 is ours, not a crash)
        pub killed: bool,
    }

    impl Ended {
        /// Died of a signal the reaper didn't send: a crash after `Quit` (at exit).
        pub fn crashed(&self) -> bool {
            self.signal.is_some() && !self.killed
        }
    }

    /// The newest endings kept for [`ended`].
    const ENDED_KEEP: usize = 64;

    struct State {
        dying: Vec<Dying>,
        running: bool,
        ended: VecDeque<Ended>,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        dying: Vec::new(),
        running: false,
        ended: VecDeque::new(),
    });

    fn lock() -> std::sync::MutexGuard<'static, State> {
        STATE.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reap `pid` once it exits; SIGKILL it at `kill_at` if it hasn't.
    pub fn hand_off(pid: libc::pid_t, kill_at: Instant) {
        let mut s = lock();
        s.dying.push(Dying {
            pid,
            kill_at,
            killed: false,
        });
        if !s.running {
            let spawned = std::thread::Builder::new()
                .name("lia-worker-reap".into())
                .spawn(run);
            match spawned {
                Ok(_) => s.running = true,
                Err(_) => {
                    // No thread: kill now; the zombie is collected by the next hand-off's
                    // thread (or by init after we exit).
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
        }
    }

    /// Workers stopped but not reaped yet (probes).
    pub fn pending() -> usize {
        lock().dying.len()
    }

    /// How the stopped worker `pid` ended, once reaped (among the last [`ENDED_KEEP`]).
    pub fn ended(pid: libc::pid_t) -> Option<Ended> {
        lock().ended.iter().rev().find(|e| e.pid == pid).copied()
    }

    fn run() {
        loop {
            {
                let mut s = lock();
                let now = Instant::now();
                let mut gone = Vec::new();
                s.dying.retain_mut(|d| {
                    let mut st = 0;
                    let r = unsafe { libc::waitpid(d.pid, &mut st, libc::WNOHANG) };
                    if r == d.pid {
                        let signaled = libc::WIFSIGNALED(st);
                        gone.push(Ended {
                            pid: d.pid,
                            code: (!signaled).then(|| libc::WEXITSTATUS(st)),
                            signal: signaled.then(|| libc::WTERMSIG(st)),
                            killed: d.killed,
                        });
                    }
                    if r != 0 {
                        return false; // reaped (or not ours any more)
                    }
                    if !d.killed && now >= d.kill_at {
                        unsafe { libc::kill(d.pid, libc::SIGKILL) };
                        d.killed = true;
                    }
                    true
                });
                for e in gone {
                    if e.crashed() {
                        log::event(
                            "worker",
                            Level::Warn,
                            "worker.exit_crash",
                            None,
                            json!({"pid": e.pid, "signal": e.signal}),
                        );
                    }
                    if s.ended.len() == ENDED_KEEP {
                        s.ended.pop_front();
                    }
                    s.ended.push_back(e);
                }
                if s.dying.is_empty() {
                    s.running = false;
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn start_activity_parses_stat() {
        // A comm with spaces and a `)`; state D; majflt 7, utime 30, stime 5.
        let stat = "4242 (liascape (x) w) D 1 2 3 0 -1 4194304 100 0 7 0 30 5 0 0 20 0 2 0 99";
        let a = |in_io| Some(super::StartActivity { cpu: 35, majflt: 7, in_io });
        assert_eq!(super::parse_start_activity(stat), a(true));
        let stat = "4242 (w) S 1 2 3 0 -1 4194304 100 0 7 0 30 5 0 0 20 0 2 0 99";
        assert_eq!(super::parse_start_activity(stat), a(false));
        assert_eq!(super::parse_start_activity("garbage"), None);
    }

    use super::*;

    #[test]
    fn budget_window_slides() {
        let b = RestartBudget::default();
        let t0 = Instant::now();
        let mut h = VecDeque::new();
        assert_eq!(b.admit(&mut h, t0), Some(1));
        assert_eq!(b.admit(&mut h, t0 + Duration::from_secs(1)), Some(2));
        assert_eq!(b.admit(&mut h, t0 + Duration::from_secs(2)), Some(3));
        // A fourth crash inside the window: broken.
        let mut spent = h.clone();
        assert_eq!(b.admit(&mut spent, t0 + Duration::from_secs(30)), None);
        // One 61 s after the first three: they've all left the window → a restart.
        assert_eq!(b.admit(&mut h, t0 + Duration::from_secs(63)), Some(1));
        // Partly slid: at +61 s one of three has left the window, at +71 s two.
        let h2 = VecDeque::from([
            t0,
            t0 + Duration::from_secs(10),
            t0 + Duration::from_secs(50),
        ]);
        assert_eq!(
            b.admit(&mut h2.clone(), t0 + Duration::from_secs(61)),
            Some(3)
        );
        assert_eq!(
            b.admit(&mut h2.clone(), t0 + Duration::from_secs(71)),
            Some(2)
        );
        // max 0 never restarts.
        let none = RestartBudget {
            window: Duration::from_secs(60),
            max: 0,
        };
        assert_eq!(none.admit(&mut VecDeque::new(), t0), None);
    }

    #[test]
    fn preload_args_name_a_real_scene_only() {
        let start = |assets: Option<&str>, steam: Option<&str>, synthetic: bool| ToWorker::Start {
            path: "/w/431960/123".into(),
            assets_dir: assets.map(Into::into),
            steam_dir: steam.map(Into::into),
            position: 0.0,
            paused: false,
            audio: proto::AudioRoute::Null,
            max_size: [640, 360],
            synthetic,
            properties: Default::default(),
            id: "src1".into(),
            gain_db: crate::units::SILENT_DB,
            no_audio: false,
            speed: 1.0,
            loudness: true,
        };
        assert_eq!(
            preload_args(&start(Some("/we/assets"), Some("/lib"), false)),
            [
                "--preload",
                "/w/431960/123",
                "--preload-assets",
                "/we/assets",
                "--preload-steam",
                "/lib"
            ]
        );
        assert_eq!(
            preload_args(&start(Some("/we/assets"), None, false)),
            ["--preload", "/w/431960/123", "--preload-assets", "/we/assets"]
        );
        // No assets dir is an error the `Start` reports; a synthetic scene has no project.
        assert!(preload_args(&start(None, Some("/lib"), false)).is_empty());
        assert!(preload_args(&start(Some("/we/assets"), None, true)).is_empty());
        assert!(preload_args(&ToWorker::Quit).is_empty());
    }

    #[test]
    fn restart_start_folds_live_changes() {
        let start = ToWorker::Start {
            path: "/s/1".into(),
            assets_dir: None,
            steam_dir: None,
            position: 0.0,
            paused: false,
            audio: proto::AudioRoute::Null,
            max_size: [640, 360],
            synthetic: false,
            properties: Default::default(),
            id: "src1".into(),
            gain_db: crate::units::SILENT_DB,
            no_audio: false,
            speed: 1.0,
            loudness: true,
        };
        let mut spec = WorkerSpec::new("src1", "/nonexistent/liascape-scene-worker", start);
        spec.crash_dir = std::env::temp_dir();
        // A host that never managed to spawn still folds (no process needed for this).
        let epoll = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
        let mut host = WorkerHost {
            spec,
            epoll: unsafe { OwnedFd::from_raw_fd(epoll) },
            proc_: None,
            state: WorkerState::Restarting { attempt: 1 },
            history: VecDeque::new(),
            total_restarts: 0,
            tail: VecDeque::new(),
            partial: Vec::new(),
            ping_seq: 0,
            corr: log::new_corr("wk"),
            sync: None,
            last_poll: None,
            reap_checked: None,
            spare: false,
            hello_replay: None,
            pending: Vec::new(),
        };
        host.send(&ToWorker::Paused { paused: true }, &[]).unwrap();
        host.send(
            &ToWorker::Resize {
                max_size: [2560, 1440],
            },
            &[],
        )
        .unwrap();
        host.send(
            &ToWorker::Route {
                audio: proto::AudioRoute::Default,
            },
            &[],
        )
        .unwrap();
        // A live scene property is part of what a restart must come back with.
        for (name, value) in [("clock", json!(false)), ("bar_color", json!("1 0 0"))] {
            host.send(
                &ToWorker::SetProperty {
                    name: name.into(),
                    value,
                },
                &[],
            )
            .unwrap();
        }
        host.send(
            &ToWorker::SetProperty {
                name: "clock".into(),
                value: json!(true),
            },
            &[],
        )
        .unwrap();
        host.set_resume_position(3.25);
        // The stream's level, mute and speed come back with a restart too.
        host.send(&ToWorker::Gain { db: -6.0 }, &[]).unwrap();
        host.send(&ToWorker::NoAudio { on: true }, &[]).unwrap();
        host.send(&ToWorker::Speed { speed: 1.5 }, &[]).unwrap();
        host.send(&ToWorker::LoudnessMeter { on: false }, &[]).unwrap();
        let e = host
            .send(
                &ToWorker::Pointer {
                    x: 1.0,
                    y: 1.0,
                    buttons: 0,
                    jump: false,
                },
                &[],
            )
            .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::NotConnected);
        match &host.spec().start {
            ToWorker::Start {
                position,
                paused,
                max_size,
                audio,
                properties,
                gain_db,
                no_audio,
                speed,
                loudness,
                ..
            } => {
                assert!(!*loudness, "the cap's meter-off survives a restart");
                assert_eq!(*gain_db, -6.0);
                assert!(*no_audio);
                assert_eq!(*speed, 1.5);
                assert_eq!(*position, 3.25);
                assert!(*paused);
                assert_eq!(*max_size, [2560, 1440]);
                assert_eq!(*audio, proto::AudioRoute::Default);
                assert_eq!(
                    properties.get("clock"),
                    Some(&json!(true)),
                    "the latest wins"
                );
                assert_eq!(properties.get("bar_color"), Some(&json!("1 0 0")));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn scene_ids_for_records() {
        assert_eq!(scene_id_of("/w/431960/1234567", "src1"), "1234567");
        assert_eq!(scene_id_of("/w/431960/1234567/", "src1"), "1234567");
        assert_eq!(scene_id_of("", "src:1"), "src_1");
        assert_eq!(scene_id_of("/w/a b*c", "x"), "abc");
    }
}
