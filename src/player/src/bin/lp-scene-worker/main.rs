//! `lp-scene-worker --fd N --parent-pid P [--stub]` — renders one WE scene for lp-player in its
//! own process (Phase 2; `.claude/rules/player-core.md` § Scene worker). Spawned by
//! `worker::WorkerHost`, never by hand: fd `N` is its end of a `SOCK_SEQPACKET` socketpair
//! (`worker::proto`), `P` the compositor's pid.
//!
//! First thing: `PR_SET_PDEATHSIG(SIGKILL)`, then `getppid() == P` (the parent may have died
//! before the prctl) — a compositor killed outright never leaves a worker behind.
//!
//! `--stub` (tests): no GPU, no scene — answers `Hello`/`Ping`/`Tick`, logs each `Start`'s
//! position, scripted by `LP_SCENE_WORKER_TEST` (comma-separated): `crash_after_ms:N` (prints
//! `stub: crashing` to stderr, then `abort()`), `hang_after_ms:N` (stops answering),
//! `exit_code:N` (exit with N — at `crash_after_ms` if given, else right after `Hello`),
//! `ignore_quit` (ignores `Quit` and EOF; only SIGKILL ends it), `spam_stderr:N` (N stderr
//! lines after `Hello`).

use std::io::Write;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

use lp_player::worker::proto::{self, FromWorker, ToWorker};

/// `LP_SCENE_WORKER_TEST`'s knobs (also honoured by the synthetic renderer's spec).
#[derive(Debug, Default, Clone)]
struct Knobs {
    crash_after_ms: Option<u64>,
    hang_after_ms: Option<u64>,
    exit_code: Option<i32>,
    ignore_quit: bool,
    spam_stderr: u32,
}

impl Knobs {
    fn parse(s: &str) -> Knobs {
        let mut k = Knobs::default();
        for item in s.split(',').map(str::trim).filter(|i| !i.is_empty()) {
            let (key, val) = item.split_once(':').unwrap_or((item, ""));
            match key {
                "crash_after_ms" => k.crash_after_ms = val.parse().ok(),
                "hang_after_ms" => k.hang_after_ms = val.parse().ok(),
                "exit_code" => k.exit_code = val.parse().ok(),
                "ignore_quit" => k.ignore_quit = true,
                "spam_stderr" => k.spam_stderr = val.parse().unwrap_or(0),
                other => warn(&format!("unknown LP_SCENE_WORKER_TEST knob {other:?}")),
            }
        }
        k
    }
}

fn warn(line: &str) {
    let _ = writeln!(std::io::stderr(), "lp-scene-worker: {line}");
}

fn usage() -> ! {
    warn("usage: lp-scene-worker --fd N --parent-pid P [--stub] (spawned by lp-player)");
    std::process::exit(2)
}

fn main() {
    let mut fd: Option<i32> = None;
    let mut parent: Option<i32> = None;
    let mut stub = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--fd" => fd = args.next().and_then(|v| v.parse().ok()),
            "--parent-pid" => parent = args.next().and_then(|v| v.parse().ok()),
            "--stub" => stub = true,
            _ => usage(),
        }
    }
    let (Some(fd), Some(parent)) = (fd, parent) else {
        usage()
    };
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
        if libc::getppid() != parent {
            warn(&format!("parent {parent} is already gone"));
            std::process::exit(3);
        }
        // Nothing this process starts (LWE's helpers) may hold the socket: EOF is the crash
        // signal the compositor relies on.
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let sock = unsafe { OwnedFd::from_raw_fd(fd) };
    let knobs = Knobs::parse(&std::env::var("LP_SCENE_WORKER_TEST").unwrap_or_default());
    if stub {
        run_stub(sock, knobs)
    }
    run_renderer(sock, knobs)
}

fn send(sock: &OwnedFd, m: &FromWorker) {
    let _ = proto::send(sock.as_fd(), m, &[]);
}

fn hello(sock: &OwnedFd, features: &[&str], sync: &str) {
    send(
        sock,
        &FromWorker::Hello {
            protocol: proto::PROTOCOL,
            pid: std::process::id(),
            features: features.iter().map(|f| f.to_string()).collect(),
            sync: sync.into(),
        },
    );
}

/// `abort()` (SIGABRT, no core: `RLIMIT_CORE` 1 skips a piped `core_pattern` — no
/// systemd-coredump, no desktop crash popup), or `exit(code)`.
fn crash(code: Option<i32>) -> ! {
    match code {
        Some(c) => {
            let _ = writeln!(std::io::stderr(), "stub: exiting with code {c}");
            std::process::exit(c)
        }
        None => {
            let _ = writeln!(std::io::stderr(), "stub: crashing");
            unsafe {
                let one = libc::rlimit {
                    rlim_cur: 1,
                    rlim_max: 1,
                };
                libc::setrlimit(libc::RLIMIT_CORE, &one);
            }
            std::process::abort()
        }
    }
}

fn hang() -> ! {
    let _ = writeln!(std::io::stderr(), "stub: hanging");
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Poll `fd` for input until `timeout` (`None` = forever). EINTR counts as a wake.
fn wait_readable(fd: i32, timeout: Option<Duration>) {
    let mut p = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let ms = timeout.map_or(-1, |t| t.as_millis().min(i32::MAX as u128) as i32);
    unsafe { libc::poll(&mut p, 1, ms) };
}

fn run_stub(sock: OwnedFd, k: Knobs) -> ! {
    hello(&sock, &["stub"], "none");
    {
        let mut err = std::io::stderr().lock();
        for i in 0..k.spam_stderr {
            let _ = writeln!(err, "stub: spam line {i}");
        }
    }
    if k.crash_after_ms.is_none()
        && let Some(c) = k.exit_code
    {
        crash(Some(c));
    }
    let t0 = Instant::now();
    let mut sock = Some(sock);
    loop {
        let el = t0.elapsed();
        if k.crash_after_ms
            .is_some_and(|c| el >= Duration::from_millis(c))
        {
            crash(k.exit_code);
        }
        if k.hang_after_ms
            .is_some_and(|h| el >= Duration::from_millis(h))
        {
            hang();
        }
        let next = [k.crash_after_ms, k.hang_after_ms]
            .into_iter()
            .flatten()
            .map(|ms| Duration::from_millis(ms).saturating_sub(el))
            .min();
        let Some(s) = sock.as_ref() else {
            // EOF with ignore_quit: nothing to read any more, only the knobs' deadlines.
            std::thread::sleep(next.unwrap_or(Duration::from_secs(3600)));
            continue;
        };
        wait_readable(s.as_raw_fd(), next);
        loop {
            match proto::recv::<ToWorker>(s.as_fd()) {
                Ok(Some((m, _fds))) => match m {
                    ToWorker::Ping { seq } => send(s, &FromWorker::Pong { seq }),
                    ToWorker::Tick { seq, t, .. } => send(
                        s,
                        &FromWorker::Frame {
                            slot: 0,
                            seq,
                            t,
                            gpu_ms: None,
                        },
                    ),
                    ToWorker::Start { position, .. } => send(
                        s,
                        &FromWorker::Log {
                            level: "info".into(),
                            line: format!("stub: start position {position}"),
                        },
                    ),
                    ToWorker::Quit if !k.ignore_quit => std::process::exit(0),
                    _ => {}
                },
                Ok(None) => break,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    if !k.ignore_quit {
                        std::process::exit(0);
                    }
                    sock = None;
                    break;
                }
                Err(e) => warn(&format!("bad message: {e}")),
            }
        }
    }
}

/// The real renderer (Task 4: synthetic; Task 7: LWE).
fn run_renderer(sock: OwnedFd, _k: Knobs) -> ! {
    hello(&sock, &[], "none");
    send(
        &sock,
        &FromWorker::Error {
            reason: "this lp-scene-worker has no renderer yet".into(),
            fatal: true,
        },
    );
    // A fatal error: stay up, idle, until Quit/EOF (the caller stops us — never a crash loop).
    loop {
        wait_readable(sock.as_raw_fd(), None);
        loop {
            match proto::recv::<ToWorker>(sock.as_fd()) {
                Ok(Some((ToWorker::Quit, _))) => std::process::exit(0),
                Ok(Some((ToWorker::Ping { seq }, _))) => send(&sock, &FromWorker::Pong { seq }),
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => std::process::exit(0),
                Err(_) => {}
            }
        }
    }
}
