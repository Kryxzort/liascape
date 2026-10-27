//! Compositor side of the scene worker (Phase 2 Tasks 3–4; `.claude/rules/player-core.md`
//! § Scene worker): [`WorkerHost`] spawns and supervises one `lp-scene-worker` process over a
//! `SOCK_SEQPACKET` socketpair ([`proto`]), [`dmabuf`] imports its frames.
//!
//! **Lifecycle.** `spawn` → `Starting` (no `Hello` yet) → `Running` (the host answers `Hello`
//! with the spec's `Start`). A crash = socket EOF or the process gone (`waitpid`); a hang = a
//! `Tick` or `Ping` unanswered for `hang_timeout` → SIGKILL. Either way: `Exited`, then a
//! restart (`Restarting {attempt}` → `Running`, the new process gets the last `Start` at
//! [`WorkerHost::set_resume_position`]) while the [`RestartBudget`] allows (3 per 60 s),
//! else `Broken` + a crash record. `stop` (and `Drop`) never block: `Quit`, then the
//! process goes to the reaper thread (`lp-worker-reap`), SIGKILLed after [`STOP_GRACE`].
//!
//! **Spawn = `posix_spawn`** (glibc: `clone(CLONE_VM|CLONE_VFORK)`), never `fork`: no
//! page-table copy of the compositor, so it is cheap enough to run on the loop thread — and it
//! must run on a thread that lives as long as the worker: `PR_SET_PDEATHSIG` (which the worker
//! sets itself, then checks `getppid()` against `--parent-pid`) fires when the *spawning
//! thread* exits, not the process (`prctl(2)`), so a pool thread that exits when idle would
//! take its workers down with it. The child gets its socket end at fd 3, stderr + stdout on a
//! pipe the host keeps the last [`LOG_TAIL`] lines of, stdin `/dev/null`, an empty signal
//! mask and default dispositions (the compositor blocks SIGINT/SIGTERM for its signalfd).

pub mod proto;

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
/// A spawned worker that hasn't said `Hello` by then is hung.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// Heartbeat period while no ticks flow (shortened to `hang_timeout / 2` for short timeouts,
/// so a hang is always seen within `1.5 × hang_timeout`).
pub const PING_INTERVAL: Duration = Duration::from_secs(1);
/// The child's socket end.
pub const CHILD_FD: RawFd = 3;
/// After socket EOF, a process that still hasn't exited by then is killed.
const EOF_KILL_AFTER: Duration = Duration::from_secs(1);
/// One output line longer than this is cut (kept up to here, then `…`).
const MAX_LINE: usize = 4096;
/// Most worker output read per `poll` (the rest next time).
const MAX_READ_PER_POLL: usize = 256 * 1024;

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
    pub budget: RestartBudget,
    /// Where crash records go ([`crate::paths::crash_dir`] by default).
    pub crash_dir: PathBuf,
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
            budget: RestartBudget::default(),
            crash_dir: crate::paths::crash_dir(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorkerState {
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
    /// Sent ticks not answered yet (`seq`, sent at); a `Frame {seq}` answers every tick ≤ it.
    ticks: VecDeque<(u64, Instant)>,
    ping: Option<(u64, Instant)>,
    last_sent: Instant,
    eof_at: Option<Instant>,
    killed: bool,
    hung: bool,
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
}

impl WorkerHost {
    /// Start the worker. Never waits for it (`Hello` arrives through [`poll`](Self::poll)).
    pub fn spawn(spec: WorkerSpec) -> io::Result<WorkerHost> {
        let epoll = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
        if epoll < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut host = WorkerHost {
            spec,
            epoll: unsafe { OwnedFd::from_raw_fd(epoll) },
            proc_: None,
            state: WorkerState::Starting,
            history: VecDeque::new(),
            total_restarts: 0,
            tail: VecDeque::new(),
            partial: Vec::new(),
            ping_seq: 0,
            corr: log::new_corr("wk"),
            sync: None,
        };
        host.proc_ = Some(host.spawn_proc(0)?);
        Ok(host)
    }

    /// Readable whenever [`poll`](Self::poll) has something to do (a message, worker output,
    /// EOF). An epoll fd over the current socket + output pipe — **stable across restarts**;
    /// owned by the host (register a `dup`, like the mpv wake fds).
    pub fn wake_fd(&self) -> RawFd {
        self.epoll.as_raw_fd()
    }

    /// Send `m` (+ fds). While no worker is connected (`Starting` before `Hello`,
    /// `Restarting`, `Broken`, `Stopped`) only what folds into the next `Start` is accepted
    /// (`Start` itself, `Paused`, `Resize`, `Route` — recorded for the restart's `Start`, so
    /// a restart never resumes with stale values); everything else is `NotConnected` (the
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
        p.last_sent = now;
        match m {
            ToWorker::Tick { seq, .. } => p.ticks.push_back((*seq, now)),
            ToWorker::Ping { seq } => p.ping = Some((*seq, now)),
            _ => {}
        }
        Ok(())
    }

    /// Never blocks: drains messages and output, reaps, runs the heartbeat and the restart
    /// policy. Call on every wake and regularly (the hang check needs time to pass).
    pub fn poll(&mut self, now: Instant) -> Vec<WorkerEvent> {
        let mut out = Vec::new();
        if self.proc_.is_none() {
            return out;
        }
        self.drain_output(false);
        self.drain_socket(now, &mut out);
        self.heartbeat(now, &mut out);
        self.reap(now, &mut out);
        out
    }

    /// The scene time a restart's `Start` carries.
    pub fn set_resume_position(&mut self, t: f64) {
        if let ToWorker::Start { position, .. } = &mut self.spec.start {
            *position = t;
        }
    }

    /// `Quit`, then the process is handed to the reaper (SIGKILL after [`STOP_GRACE`]).
    /// Never blocks; `Stopped` afterwards, no more events.
    pub fn stop(&mut self) {
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
        for a in &self.spec.args {
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
            ticks: VecDeque::new(),
            ping: None,
            last_sent: now,
            eof_at: None,
            killed: false,
            hung: false,
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
                    // EOF (the crash signal, spike §6) or a dead socket.
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
            FromWorker::Frame { seq, .. } => {
                while p.ticks.front().is_some_and(|(s, _)| s <= seq) {
                    p.ticks.pop_front();
                }
            }
            FromWorker::Hello {
                protocol,
                pid,
                features,
                sync,
            } => {
                p.hello_at = Some(now);
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
                self.state = WorkerState::Running;
                let start = self.spec.start.clone();
                let p = self.proc_.as_mut().unwrap();
                if let Some(s) = &p.sock {
                    let _ = proto::send(s.as_fd(), &start, &[]);
                    p.last_sent = now;
                }
            }
            FromWorker::Log { level, line } => {
                let l = format!("[{level}] {line}");
                self.push_line(l);
            }
            _ => {}
        }
        out.push(WorkerEvent::Msg(m, fds));
    }

    fn heartbeat(&mut self, now: Instant, out: &mut Vec<WorkerEvent>) {
        let ping_every = PING_INTERVAL.min(self.spec.hang_timeout / 2);
        let hang = self.spec.hang_timeout;
        let Some(p) = self.proc_.as_mut() else { return };
        if p.killed {
            return;
        }
        let waited = match p.hello_at {
            None => {
                let w = now.saturating_duration_since(p.started);
                (w > HELLO_TIMEOUT.max(hang)).then_some(w)
            }
            Some(_) => {
                let oldest = [p.ticks.front().map(|t| t.1), p.ping.map(|t| t.1)]
                    .into_iter()
                    .flatten()
                    .min();
                oldest
                    .map(|t| now.saturating_duration_since(t))
                    .filter(|w| *w > hang)
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
                       "hello": p.hello_at.is_some()}),
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
            && p.ticks.is_empty()
            && now.saturating_duration_since(p.last_sent) >= ping_every
            && let Some(s) = &p.sock
        {
            self.ping_seq += 1;
            if proto::send(s.as_fd(), &ToWorker::Ping { seq: self.ping_seq }, &[]).is_ok() {
                p.ping = Some((self.ping_seq, now));
                p.last_sent = now;
            }
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

        let how = match (signal, code) {
            (Some(s), _) => format!("killed by signal {s}"),
            (_, Some(c)) => format!("exited with code {c}"),
            _ => "vanished".to_string(),
        };
        let how = if p.hung { format!("hung, {how}") } else { how };
        match self.spec.budget.admit(&mut self.history, now) {
            Some(attempt) => match self.spawn_proc(attempt) {
                Ok(np) => {
                    self.proc_ = Some(np);
                    self.total_restarts += 1;
                    self.state = WorkerState::Restarting { attempt };
                    self.push_line(format!(
                        "--- lp-player: worker {how}; restart {attempt} ---"
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

    fn broken(
        &mut self,
        reason: String,
        signal: Option<i32>,
        code: Option<i32>,
        uptime: Duration,
        out: &mut Vec<WorkerEvent>,
    ) {
        let path = match &self.spec.start {
            ToWorker::Start { path, .. } => path.clone(),
            _ => String::new(),
        };
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

/// Stopped workers' last moments: one `lp-worker-reap` thread (started on demand, gone once
/// nothing is dying) reaps them and SIGKILLs any still alive at its deadline — so `stop` and
/// `Drop` never wait for a process.
pub mod reap {
    use super::*;

    struct Dying {
        pid: libc::pid_t,
        kill_at: Instant,
        killed: bool,
    }

    struct State {
        dying: Vec<Dying>,
        running: bool,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        dying: Vec::new(),
        running: false,
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
                .name("lp-worker-reap".into())
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

    fn run() {
        loop {
            {
                let mut s = lock();
                let now = Instant::now();
                s.dying.retain_mut(|d| {
                    let mut st = 0;
                    let r = unsafe { libc::waitpid(d.pid, &mut st, libc::WNOHANG) };
                    if r != 0 {
                        return false; // reaped (or not ours any more)
                    }
                    if !d.killed && now >= d.kill_at {
                        unsafe { libc::kill(d.pid, libc::SIGKILL) };
                        d.killed = true;
                    }
                    true
                });
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
        };
        let mut spec = WorkerSpec::new("src1", "/nonexistent/lp-scene-worker", start);
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
        host.set_resume_position(3.25);
        let e = host.send(&ToWorker::Gain { db: -6.0 }, &[]).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::NotConnected);
        match &host.spec().start {
            ToWorker::Start {
                position,
                paused,
                max_size,
                audio,
                ..
            } => {
                assert_eq!(*position, 3.25);
                assert!(*paused);
                assert_eq!(*max_size, [2560, 1440]);
                assert_eq!(*audio, proto::AudioRoute::Default);
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
