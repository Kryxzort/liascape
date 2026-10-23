//! The supervisor (spec §4.1 "Supervision"; Task 16, R72/R73): `lp-player serve` keeps the
//! compositor alive. It runs **before any thread, GL context or PipeWire connection
//! exists** and only ever does three things: spawn the compositor (fork + exec of its own
//! binary, `/proc/self/exe serve --supervised …`), wait for it, and forward SIGINT/SIGTERM
//! to it. It never binds the socket or takes the instance lock (the child does), never
//! touches EGL/PipeWire, and has no socket of its own.
//!
//! **Exit classification** ([`classify`]): exit codes 0 (quit / SIGTERM / SIGINT), 1
//! (refused at startup: another instance already holds the lock, or an unusable socket
//! dir/state dir) and 2 (usage) are **clean** — not restarted, the supervisor exits with
//! that code. [`EXIT_NO_COMPOSITOR`] (5 — Task 16b) is its own, third class: the
//! compositor/EGL genuinely isn't available *yet* (no Wayland compositor running, EGL
//! init failing before a GPU driver/device is ready — the two can't be told apart from
//! out here, and don't need to be) — handled below, not restarted through the crash
//! budget. Everything else is a real crash and is restarted through [`Budget`]: death by
//! a signal, a Rust panic (101), [`EXIT_RUNTIME`] (3 — the compositor connection was lost
//! mid-run), any other code.
//!
//! **Startup-failure classes, why they're split:** "already running" can never be fixed
//! by waiting — the other instance owns the lock until *it* exits — so retrying would
//! only ever burn the crash budget on something a restart never helps. "No compositor
//! yet" is the opposite: on a session starting at boot, `lp-player` can easily win the
//! race against the compositor (or the GPU driver) coming up, and *will* succeed a moment
//! later with no code change at all. [`EXIT_NO_COMPOSITOR`] gets its own backoff instead
//! of either extreme (treating it as instantly fatal, or feeding the 5-per-60s crash
//! budget meant for real crashes): [`run`] retries with a doubling delay (0.5 s, 1 s, 2 s,
//! 4 s, …), logging `supervisor.waiting_for_compositor {pid, uptime_ms, delay_ms,
//! waited_ms, budget_ms}` (warn) before each sleep, until the *next* delay would push the
//! running total past [`compositor_wait_budget`] (30 s in production;
//! [`TEST_COMPOSITOR_WAIT_ENV`] shortens it for tests) — then `supervisor.giving_up
//! {reason: "no_compositor", pid, waited_ms, budget_ms, hint}` (error) and
//! [`EXIT_GAVE_UP`] (4, the same code the crash-loop budget gives up with). A later real
//! crash (`Exit::Abnormal`) resets this streak back to the start of the backoff — it's an
//! independent concern from the crash budget, which stays exactly 5 restarts per 60 s
//! regardless.
//!
//! **Restart** ([`Budget`]): immediately (well under the 1 s budget — measured in
//! `tests/supervise.rs::crash_restores`), with `--restore` (the child restores
//! `<state>/snapshot.json`, `crate::snapshot`) and `--restarted <spec>` ([`RestartInfo`]:
//! the signal/code, the count, when the old child died) — the child logs
//! `supervisor.restart {signal|code, count, total, since_ms, prev_pid, restore}` as one of
//! its first events (R73). **Give up** when the next restart would be the 6th within 60 s
//! ([`MAX_RESTARTS`], [`WINDOW`]): `supervisor.giving_up` is appended to the event log
//! (shared with the child; [`log::append_detached`]) and the supervisor exits
//! [`EXIT_GAVE_UP`] (4). From the 4th restart in the window on ([`RESTORE_RESTARTS`]) the
//! child starts **without** `--restore`: a snapshot that crashes the player at startup
//! can't take supervision down with it.
//!
//! **Stop:** SIGTERM/SIGINT to the supervisor are forwarded to the child; the supervisor
//! waits ≤ [`STOP_WAIT`] (then SIGKILLs it) and exits with the child's status — never a
//! restart. The child has `PR_SET_PDEATHSIG(SIGTERM)` (set between fork and exec, the
//! parent re-checked after), so a supervisor killed outright never leaves an orphan
//! player: the child gets SIGTERM and quits cleanly.
//!
//! **A sent SIGSEGV/SIGBUS is a crash** ([`make_sent_faults_fatal`], installed first thing
//! in `serve`): Rust's runtime catches SIGSEGV/SIGBUS for its stack-overflow check and, for
//! anything that isn't a guard-page hit, resets the handler and *returns* — fine for a real
//! fault (it re-faults and dies), but a `kill -SEGV` from outside (si_code ≤ 0) was simply
//! survived once (measured). Our handler makes a sent one fatal at once and hands real
//! faults back to the previous handler (stack-overflow message kept).
//!
//! **Test knob:** [`TEST_CRASH_ENV`]`=startup` makes every child abort right after logging
//! its startup events (`tests/supervise.rs::gives_up_after_5_in_60s`). Never set it
//! outside tests.

use std::collections::VecDeque;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, ExitStatus};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::log::{self, Level};

/// Restarts allowed within [`WINDOW`]; the next crash gives up.
pub const MAX_RESTARTS: usize = 5;
pub const WINDOW: Duration = Duration::from_secs(60);
/// Restarts within [`WINDOW`] that still get `--restore`.
pub const RESTORE_RESTARTS: usize = 3;
/// How long a forwarded SIGTERM/SIGINT may take before the child is SIGKILLed.
pub const STOP_WAIT: Duration = Duration::from_secs(10);
/// The child's exit code when the compositor connection was lost mid-run (restarted).
pub const EXIT_RUNTIME: u8 = 3;
/// The supervisor's exit code after giving up.
pub const EXIT_GAVE_UP: u8 = 4;
/// The child's exit code when the compositor/EGL isn't available *yet* (Task 16b):
/// distinct from [`ServeError::Startup`](crate::runtime::ServeError::Startup)'s 1
/// ("already running", or another startup refusal that waiting never fixes) — this one
/// the supervisor retries with backoff ([`run`]'s module-doc "Startup-failure classes").
pub const EXIT_NO_COMPOSITOR: u8 = 5;
/// Child exit codes that end supervision (not restarted).
pub const CLEAN_CODES: [i32; 3] = [0, 1, 2];
/// Test-only: `startup` → every child aborts right after its first events.
pub const TEST_CRASH_ENV: &str = "LP_PLAYER_TEST_CRASH";
/// The real total backoff budget for [`EXIT_NO_COMPOSITOR`] retries, before giving up.
pub const COMPOSITOR_WAIT_BUDGET: Duration = Duration::from_secs(30);
/// The first retry delay; each later one doubles it.
pub const COMPOSITOR_WAIT_INITIAL_DELAY: Duration = Duration::from_millis(500);
/// Test-only: overrides [`COMPOSITOR_WAIT_BUDGET`] (milliseconds) so a test doesn't really
/// wait 30 s for the give-up. Never set it outside tests.
pub const TEST_COMPOSITOR_WAIT_ENV: &str = "LP_PLAYER_TEST_COMPOSITOR_WAIT_MS";

/// [`COMPOSITOR_WAIT_BUDGET`], unless [`TEST_COMPOSITOR_WAIT_ENV`] overrides it.
fn compositor_wait_budget() -> Duration {
    std::env::var(TEST_COMPOSITOR_WAIT_ENV)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(COMPOSITOR_WAIT_BUDGET)
}

/// Why a child died abnormally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Signal(i32),
    Code(i32),
}

impl Reason {
    /// `{"signal": n}` or `{"code": n}`.
    pub fn fields(&self) -> Map<String, Value> {
        let mut m = Map::new();
        match self {
            Reason::Signal(s) => m.insert("signal".into(), json!(s)),
            Reason::Code(c) => m.insert("code".into(), json!(c)),
        };
        m
    }

    fn describe(&self) -> String {
        match self {
            Reason::Signal(s) => format!("signal {s}"),
            Reason::Code(c) => format!("exit code {c}"),
        }
    }
}

/// How a child ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// One of [`CLEAN_CODES`]: supervision ends with it.
    Clean(i32),
    /// [`EXIT_NO_COMPOSITOR`]: handled by its own backoff, never the crash budget.
    WaitingForCompositor,
    Abnormal(Reason),
}

pub fn classify(st: ExitStatus) -> Exit {
    if let Some(sig) = st.signal() {
        return Exit::Abnormal(Reason::Signal(sig));
    }
    match st.code() {
        Some(c) if CLEAN_CODES.contains(&c) => Exit::Clean(c),
        Some(c) if c == EXIT_NO_COMPOSITOR as i32 => Exit::WaitingForCompositor,
        Some(c) => Exit::Abnormal(Reason::Code(c)),
        None => Exit::Abnormal(Reason::Code(-1)),
    }
}

/// What to do after a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// `count` = restarts in the window including this one; `total` = since start.
    Restart {
        count: usize,
        total: u64,
        restore: bool,
    },
    GiveUp {
        restarts: usize,
    },
}

/// The restart budget: [`MAX_RESTARTS`] per sliding [`WINDOW`].
#[derive(Debug, Default)]
pub struct Budget {
    recent: VecDeque<Instant>,
    total: u64,
}

impl Budget {
    pub fn on_crash(&mut self, now: Instant) -> Decision {
        while self
            .recent
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= WINDOW)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= MAX_RESTARTS {
            return Decision::GiveUp {
                restarts: self.recent.len(),
            };
        }
        self.recent.push_back(now);
        self.total += 1;
        Decision::Restart {
            count: self.recent.len(),
            total: self.total,
            restore: self.recent.len() <= RESTORE_RESTARTS,
        }
    }
}

/// What the supervisor tells a restarted child: `--restarted <spec>`,
/// `signal=11,count=1,total=1,died_ms=123.4,prev_pid=99,restore=1`.
#[derive(Debug, Clone, PartialEq)]
pub struct RestartInfo {
    pub reason: Reason,
    pub count: usize,
    pub total: u64,
    /// `CLOCK_MONOTONIC` ms (system-wide) when the supervisor saw the old child die.
    pub died_mono_ms: f64,
    pub prev_pid: u32,
    pub restore: bool,
}

impl RestartInfo {
    pub fn to_arg(&self) -> String {
        let r = match self.reason {
            Reason::Signal(s) => format!("signal={s}"),
            Reason::Code(c) => format!("code={c}"),
        };
        format!(
            "{r},count={},total={},died_ms={:.3},prev_pid={},restore={}",
            self.count,
            self.total,
            self.died_mono_ms,
            self.prev_pid,
            u8::from(self.restore)
        )
    }

    pub fn parse(s: &str) -> Result<RestartInfo, String> {
        let bad = || {
            format!(
                "--restarted {s:?}: expected signal=N|code=N,count=N,total=N,died_ms=F,prev_pid=N,restore=0|1"
            )
        };
        let mut reason = None;
        let (mut count, mut total, mut died, mut prev, mut restore) =
            (None, None, None, None, None);
        for kv in s.split(',') {
            let (k, v) = kv.split_once('=').ok_or_else(bad)?;
            match k {
                "signal" => reason = Some(Reason::Signal(v.parse().map_err(|_| bad())?)),
                "code" => reason = Some(Reason::Code(v.parse().map_err(|_| bad())?)),
                "count" => count = Some(v.parse().map_err(|_| bad())?),
                "total" => total = Some(v.parse().map_err(|_| bad())?),
                "died_ms" => died = Some(v.parse().map_err(|_| bad())?),
                "prev_pid" => prev = Some(v.parse().map_err(|_| bad())?),
                "restore" => restore = Some(v == "1"),
                _ => return Err(bad()),
            }
        }
        Ok(RestartInfo {
            reason: reason.ok_or_else(bad)?,
            count: count.ok_or_else(bad)?,
            total: total.ok_or_else(bad)?,
            died_mono_ms: died.ok_or_else(bad)?,
            prev_pid: prev.ok_or_else(bad)?,
            restore: restore.ok_or_else(bad)?,
        })
    }

    /// The child's `supervisor.restart` fields; `since_ms` = from the old child's death
    /// (as the supervisor saw it) to now.
    pub fn event_fields(&self, now_mono_ms: f64) -> Value {
        let mut m = self.reason.fields();
        m.insert("count".into(), json!(self.count));
        m.insert("total".into(), json!(self.total));
        m.insert(
            "since_ms".into(),
            json!((now_mono_ms - self.died_mono_ms).max(0.0)),
        );
        m.insert("prev_pid".into(), json!(self.prev_pid));
        m.insert("restore".into(), json!(self.restore));
        Value::Object(m)
    }
}

static PREV_FAULT: std::sync::OnceLock<[(libc::c_int, libc::sigaction); 2]> =
    std::sync::OnceLock::new();

extern "C" fn on_fault(sig: libc::c_int, info: *mut libc::siginfo_t, _: *mut libc::c_void) {
    unsafe {
        // SI_USER (kill) = 0, SI_QUEUE / SI_TKILL < 0; a real fault has si_code > 0.
        let sent = info.is_null() || (*info).si_code <= 0;
        let prev = PREV_FAULT
            .get()
            .and_then(|p| p.iter().find(|(s, _)| *s == sig).map(|(_, a)| *a));
        match prev {
            // A real fault: the previous handler (Rust's stack-overflow check) takes the
            // re-executed faulting instruction.
            Some(a) if !sent => {
                libc::sigaction(sig, &a, std::ptr::null_mut());
            }
            _ => {
                libc::signal(sig, libc::SIG_DFL);
                if sent {
                    libc::raise(sig); // delivered (default action) once this returns
                }
            }
        }
    }
}

/// Make a SIGSEGV/SIGBUS sent from outside (`kill -SEGV`) fatal, like a real fault (module
/// doc). Call before any thread exists.
pub fn make_sent_faults_fatal() {
    unsafe {
        let mut prev: [(libc::c_int, libc::sigaction); 2] = [
            (libc::SIGSEGV, std::mem::zeroed()),
            (libc::SIGBUS, std::mem::zeroed()),
        ];
        for (sig, old) in prev.iter_mut() {
            libc::sigaction(*sig, std::ptr::null(), old);
        }
        let _ = PREV_FAULT.set(prev);
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_fault as *const () as usize;
        sa.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
        libc::sigemptyset(&mut sa.sa_mask);
        for sig in [libc::SIGSEGV, libc::SIGBUS] {
            libc::sigaction(sig, &sa, std::ptr::null_mut());
        }
    }
}

/// `CLOCK_MONOTONIC` in ms — the same clock in every process.
pub fn mono_ms() -> f64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}

/// The child's argv after `serve`: `--supervised [--restore] [--restarted <spec>] <user args>`
/// (`user_args` without `--restore`).
pub fn child_args(
    user_args: &[String],
    restore: bool,
    restart: Option<&RestartInfo>,
) -> Vec<String> {
    let mut a = vec!["serve".to_string(), "--supervised".to_string()];
    if restore {
        a.push("--restore".into());
    }
    if let Some(r) = restart {
        a.push("--restarted".into());
        a.push(r.to_arg());
    }
    a.extend(user_args.iter().cloned());
    a
}

struct Sup {
    started: Instant,
    state_dir: PathBuf,
}

impl Sup {
    /// Append one supervisor record to the shared event log (best effort).
    fn event(&self, level: Level, kind: &str, fields: Value) {
        let t = self.started.elapsed().as_secs_f64() * 1000.0;
        if let Err(e) = log::append_detached(&self.state_dir, t, "supervisor", level, kind, fields)
        {
            eprintln!(
                "lp-player supervisor: can't write {kind} to the event log in {}: {e}",
                self.state_dir.display()
            );
        }
    }

    fn spawn(&self, args: &[String]) -> std::io::Result<Child> {
        let sup = std::process::id() as libc::pid_t;
        let argv0 = std::env::args_os()
            .next()
            .unwrap_or_else(|| "lp-player".into());
        let mut cmd = Command::new("/proc/self/exe");
        cmd.arg0(argv0).args(args);
        unsafe {
            cmd.pre_exec(move || {
                // Between fork and exec (this process is single-threaded): start the child
                // with no signal blocked, and tied to us.
                let mut set: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut set);
                libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != sup {
                    return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
        cmd.spawn()
    }
}

/// Block SIGCHLD/SIGINT/SIGTERM (they're taken with `sigtimedwait`).
fn block_signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for s in [libc::SIGCHLD, libc::SIGINT, libc::SIGTERM] {
            libc::sigaddset(&mut set, s);
        }
        libc::sigprocmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    }
}

/// Wait for `child`, forwarding SIGINT/SIGTERM. Returns its status and the stop signal
/// forwarded, if any (then it must not be restarted).
fn wait_child(sup: &Sup, child: &mut Child, set: &libc::sigset_t) -> (ExitStatus, Option<i32>) {
    let mut stopping: Option<(i32, Instant)> = None;
    loop {
        if let Ok(Some(st)) = child.try_wait() {
            return (st, stopping.map(|s| s.0));
        }
        if let Some((sig, at)) = stopping
            && at.elapsed() >= STOP_WAIT
        {
            sup.event(
                Level::Error,
                "supervisor.stop_timeout",
                json!({ "pid": child.id(), "waited_ms": STOP_WAIT.as_millis() as u64 }),
            );
            let _ = child.kill();
            let st = child
                .wait()
                .unwrap_or_else(|_| ExitStatus::from_raw(libc::SIGKILL));
            return (st, Some(sig));
        }
        let ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 200_000_000,
        };
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let sig = unsafe { libc::sigtimedwait(set, &mut info, &ts) };
        if sig == libc::SIGINT || sig == libc::SIGTERM {
            unsafe { libc::kill(child.id() as libc::pid_t, sig) };
            if stopping.is_none() {
                stopping = Some((sig, Instant::now()));
            }
        }
    }
}

/// Sleep `d` with SIGCHLD/SIGINT/SIGTERM blocked, but wake for a stop signal: returns
/// `Some(signal)` if SIGINT/SIGTERM arrived (M9), `None` once `d` has passed.
fn sleep_unless_stopped(set: &libc::sigset_t, d: Duration) -> Option<i32> {
    let end = Instant::now() + d;
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        let ts = libc::timespec {
            tv_sec: left.as_secs() as libc::time_t,
            tv_nsec: left.subsec_nanos() as libc::c_long,
        };
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let sig = unsafe { libc::sigtimedwait(set, &mut info, &ts) };
        if sig == libc::SIGINT || sig == libc::SIGTERM {
            return Some(sig);
        }
    }
}

fn status_code(st: ExitStatus) -> u8 {
    match (st.code(), st.signal()) {
        (Some(c), _) => c.clamp(0, 255) as u8,
        (None, Some(s)) => (128 + s).clamp(0, 255) as u8,
        _ => 1,
    }
}

/// Run the supervisor (module doc) until supervision ends; returns the process exit code.
/// `user_args`: the `serve` options without `--restore`; `restore`: pass `--restore` to the
/// first child too.
pub fn run(user_args: Vec<String>, restore: bool, state_dir: &Path) -> ExitCode {
    let set = block_signals();
    let sup = Sup {
        started: Instant::now(),
        state_dir: state_dir.to_path_buf(),
    };
    let mut budget = Budget::default();
    let mut restore = restore;
    let mut restart: Option<RestartInfo> = None;
    // EXIT_NO_COMPOSITOR's own backoff (module doc "Startup-failure classes") —
    // independent of `budget`: it never counts against the 5-per-60s crash budget, and a
    // real crash (`Exit::Abnormal`) resets it back to the start.
    let compositor_budget = compositor_wait_budget();
    let mut compositor_waited = Duration::ZERO;
    let mut compositor_delay = COMPOSITOR_WAIT_INITIAL_DELAY;
    loop {
        let args = child_args(&user_args, restore, restart.as_ref());
        let started = Instant::now();
        let mut child = match sup.spawn(&args) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("lp-player supervisor: can't start the player: {e}");
                sup.event(
                    Level::Error,
                    "supervisor.spawn_failed",
                    json!({ "error": e.to_string() }),
                );
                return ExitCode::from(1);
            }
        };
        let pid = child.id();
        let (st, stop) = wait_child(&sup, &mut child, &set);
        if stop.is_some() {
            return ExitCode::from(status_code(st));
        }
        let reason = match classify(st) {
            Exit::Clean(c) => return ExitCode::from(c as u8),
            Exit::WaitingForCompositor => {
                let next_total = compositor_waited + compositor_delay;
                if next_total > compositor_budget {
                    sup.event(
                        Level::Error,
                        "supervisor.giving_up",
                        json!({
                            "reason": "no_compositor",
                            "pid": pid,
                            "waited_ms": compositor_waited.as_secs_f64() * 1000.0,
                            "budget_ms": compositor_budget.as_secs_f64() * 1000.0,
                            "hint": "the compositor/EGL never became available; check \
                                     WAYLAND_DISPLAY and the GPU driver, then run \
                                     `lp-player serve --no-supervise` to see the error \
                                     directly",
                        }),
                    );
                    eprintln!(
                        "lp-player supervisor: giving up after waiting {:?} for the \
                         compositor/EGL to become available",
                        compositor_waited
                    );
                    return ExitCode::from(EXIT_GAVE_UP);
                }
                sup.event(
                    Level::Warn,
                    "supervisor.waiting_for_compositor",
                    json!({
                        "pid": pid,
                        "uptime_ms": started.elapsed().as_secs_f64() * 1000.0,
                        "delay_ms": compositor_delay.as_secs_f64() * 1000.0,
                        "waited_ms": compositor_waited.as_secs_f64() * 1000.0,
                        "budget_ms": compositor_budget.as_secs_f64() * 1000.0,
                    }),
                );
                // M9 (final review): a SIGTERM/SIGINT during the backoff ends supervision
                // at once (there's no child to forward it to) — never a "hung" stop.
                if let Some(sig) = sleep_unless_stopped(&set, compositor_delay) {
                    sup.event(
                        Level::Info,
                        "supervisor.stopped",
                        json!({ "signal": sig, "while": "waiting_for_compositor",
                                "waited_ms": compositor_waited.as_secs_f64() * 1000.0 }),
                    );
                    return ExitCode::SUCCESS;
                }
                compositor_waited = next_total;
                compositor_delay *= 2;
                continue;
            }
            Exit::Abnormal(r) => r,
        };
        // A real crash: any compositor-wait streak so far no longer applies (this is an
        // independent concern from it).
        compositor_waited = Duration::ZERO;
        compositor_delay = COMPOSITOR_WAIT_INITIAL_DELAY;
        let died = mono_ms();
        let mut fields = reason.fields();
        fields.insert("pid".into(), json!(pid));
        fields.insert(
            "uptime_ms".into(),
            json!(started.elapsed().as_secs_f64() * 1000.0),
        );
        sup.event(
            Level::Warn,
            "supervisor.child_exited",
            Value::Object(fields.clone()),
        );
        match budget.on_crash(Instant::now()) {
            Decision::GiveUp { restarts } => {
                fields.insert("restarts".into(), json!(restarts));
                fields.insert("window_s".into(), json!(WINDOW.as_secs()));
                fields.insert(
                    "hint".into(),
                    json!(
                        "the player keeps crashing: `lp-player ctl` can't reach it; read \
                           events.jsonl in the state dir (kind_prefix supervisor. / the last \
                           error-level events) and run `lp-player serve --no-supervise` to see \
                           it fail"
                    ),
                );
                sup.event(Level::Error, "supervisor.giving_up", Value::Object(fields));
                eprintln!(
                    "lp-player supervisor: the player died ({}) after {restarts} restarts in {} s; \
                     giving up",
                    reason.describe(),
                    WINDOW.as_secs()
                );
                return ExitCode::from(EXIT_GAVE_UP);
            }
            Decision::Restart {
                count,
                total,
                restore: r,
            } => {
                eprintln!(
                    "lp-player supervisor: the player (pid {pid}) died ({}); restarting \
                     ({count} of {MAX_RESTARTS} in {} s{})",
                    reason.describe(),
                    WINDOW.as_secs(),
                    if r {
                        ", restoring its snapshot"
                    } else {
                        ", without --restore"
                    }
                );
                restore = r;
                restart = Some(RestartInfo {
                    reason,
                    count,
                    total,
                    died_mono_ms: died,
                    prev_pid: pid,
                    restore: r,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_classification() {
        let code = |c: i32| ExitStatus::from_raw(c << 8);
        assert_eq!(classify(code(0)), Exit::Clean(0));
        assert_eq!(classify(code(1)), Exit::Clean(1), "startup refused");
        assert_eq!(classify(code(2)), Exit::Clean(2), "usage");
        assert_eq!(
            classify(code(EXIT_RUNTIME as i32)),
            Exit::Abnormal(Reason::Code(3))
        );
        assert_eq!(
            classify(code(EXIT_NO_COMPOSITOR as i32)),
            Exit::WaitingForCompositor,
            "no compositor yet: its own class, not a crash"
        );
        assert_eq!(
            classify(code(101)),
            Exit::Abnormal(Reason::Code(101)),
            "panic"
        );
        assert_eq!(
            classify(ExitStatus::from_raw(libc::SIGSEGV)),
            Exit::Abnormal(Reason::Signal(libc::SIGSEGV))
        );
    }

    #[test]
    fn five_restarts_per_minute_then_give_up() {
        let mut b = Budget::default();
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_secs(n);
        for i in 1..=5 {
            match b.on_crash(s(i)) {
                Decision::Restart { count, restore, .. } => {
                    assert_eq!(count, i as usize);
                    assert_eq!(restore, i <= 3, "restore only for the first three");
                }
                d => panic!("{d:?}"),
            }
        }
        assert_eq!(b.on_crash(s(6)), Decision::GiveUp { restarts: 5 });
        // The window slides: 61 s after the first, one slot is free again.
        let mut b = Budget::default();
        for i in 0..5 {
            b.on_crash(s(i));
        }
        assert!(matches!(
            b.on_crash(s(61)),
            Decision::Restart {
                count: 4,
                total: 6,
                ..
            }
        ));
    }

    #[test]
    fn restart_info_round_trips() {
        let r = RestartInfo {
            reason: Reason::Signal(11),
            count: 2,
            total: 7,
            died_mono_ms: 12345.678,
            prev_pid: 4242,
            restore: true,
        };
        assert_eq!(RestartInfo::parse(&r.to_arg()).unwrap(), r);
        let c = RestartInfo {
            reason: Reason::Code(101),
            restore: false,
            ..r.clone()
        };
        assert_eq!(RestartInfo::parse(&c.to_arg()).unwrap(), c);
        assert!(RestartInfo::parse("signal=11").is_err());
        assert!(RestartInfo::parse("bogus").is_err());
        let f = r.event_fields(12345.678 + 40.0);
        assert_eq!(f["signal"], 11);
        assert_eq!(f["count"], 2);
        assert!((f["since_ms"].as_f64().unwrap() - 40.0).abs() < 1e-6);
    }

    #[test]
    fn child_args_put_internal_flags_first() {
        let user = vec!["--headless".to_string(), "--ao".into(), "null".into()];
        assert_eq!(
            child_args(&user, false, None),
            ["serve", "--supervised", "--headless", "--ao", "null"]
        );
        let r = RestartInfo {
            reason: Reason::Signal(6),
            count: 1,
            total: 1,
            died_mono_ms: 1.0,
            prev_pid: 1,
            restore: true,
        };
        let a = child_args(&user, true, Some(&r));
        assert_eq!(
            &a[..4],
            ["serve", "--supervised", "--restore", "--restarted"]
        );
        assert_eq!(RestartInfo::parse(&a[4]).unwrap(), r);
    }
}
