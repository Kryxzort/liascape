//! Scene worker protocol + process lifecycle (Phase 2 Task 3; `.claude/rules/player-core.md`
//! § Scene worker). No GPU: every worker here is `liascape-scene-worker --stub`, whose behaviour the
//! `LIASCAPE_SCENE_WORKER_TEST` knobs script (`crash_after_ms`, `hang_after_ms`, `exit_code`,
//! `ignore_quit`, `spam_stderr`). Crash records go to a private dir under `temp_dir()`; the
//! stub sets its own `RLIMIT_CORE` 1 before `abort()` (no systemd-coredump / DrKonqi popups).

use std::io::Read;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use liascape_player::worker::proto::{self, AudioRoute, FromWorker, Plane, ToWorker};
use liascape_player::worker::{
    RestartBudget, STOP_GRACE, WorkerEvent, WorkerHost, WorkerSpec, WorkerState,
};

const HELPER_ENV: &str = "LIASCAPE_WORKER_TEST_HELPER";

fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_liascape-scene-worker"))
}

/// A fresh private directory under `temp_dir()` (crash records).
fn tmp_dir(name: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!(
        "liascape-worker-test-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn start() -> ToWorker {
    ToWorker::Start {
        path: "/nonexistent/workshop/1234567".into(),
        assets_dir: None,
        steam_dir: None,
        position: 0.0,
        paused: false,
        audio: AudioRoute::Null,
        max_size: [640, 360],
        synthetic: false,
        properties: Default::default(),
        id: "stub".into(),
        gain_db: -96.0,
        no_audio: false,
        speed: 1.0,
        loudness: true,
    }
}

fn stub_spec(id: &str, knobs: &str) -> WorkerSpec {
    let mut s = WorkerSpec::new(id, bin(), start());
    s.args = vec!["--stub".into()];
    s.env = vec![("LIASCAPE_SCENE_WORKER_TEST".into(), knobs.into())];
    s.crash_dir = tmp_dir(id);
    s
}

/// Poll `host` (waiting on its wake fd ≤ 5 ms at a time) until `stop` says so or `limit`
/// passes; every event is returned with its time since `t0`.
fn pump(
    host: &mut WorkerHost,
    t0: Instant,
    limit: Duration,
    mut stop: impl FnMut(&WorkerEvent) -> bool,
) -> Vec<(Duration, WorkerEvent)> {
    let mut out = Vec::new();
    let end = Instant::now() + limit;
    while Instant::now() < end {
        let mut p = libc::pollfd {
            fd: host.wake_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe { libc::poll(&mut p, 1, 5) };
        for ev in host.poll(Instant::now()) {
            let done = stop(&ev);
            out.push((t0.elapsed(), ev));
            if done {
                return out;
            }
        }
    }
    out
}

/// The process is gone: no `/proc/<pid>` any more, or a zombie / dead entry.
fn pid_dead(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(s) => {
            let state = s.rsplit(')').next().unwrap_or("").trim_start();
            state.starts_with('Z') || state.starts_with('X')
        }
    }
}

/// The process doesn't exist at all any more (reaped).
fn pid_reaped(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == -1 && *libc::__errno_location() == libc::ESRCH }
}

fn seqpacket_pair() -> (OwnedFd, OwnedFd) {
    let mut fds = [0i32; 2];
    let r = unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    };
    assert_eq!(r, 0, "socketpair");
    unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
}

fn memfd_with(bytes: &[u8]) -> OwnedFd {
    let fd = unsafe { libc::memfd_create(c"liascape-test".as_ptr(), libc::MFD_CLOEXEC) };
    assert!(fd >= 0);
    let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
    assert_eq!(n as usize, bytes.len());
    unsafe { OwnedFd::from_raw_fd(fd) }
}

fn read_all(fd: OwnedFd) -> Vec<u8> {
    unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_SET) };
    let mut f = std::fs::File::from(fd);
    let mut v = Vec::new();
    f.read_to_end(&mut v).unwrap();
    v
}

fn raw_send(fd: &OwnedFd, bytes: &[u8]) {
    let n = unsafe { libc::send(fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len(), 0) };
    assert_eq!(n as usize, bytes.len(), "raw send");
}

#[test]
fn proto_roundtrip_with_fds() {
    let (a, b) = seqpacket_pair();
    let msg = FromWorker::Buffer {
        slot: 1,
        w: 1920,
        h: 1080,
        fourcc: 0x3432_4241,
        modifier: 0x0300_0000_00e0_8014,
        planes: vec![
            Plane {
                offset: 0,
                stride: 7680,
            },
            Plane {
                offset: 4096,
                stride: 7680,
            },
        ],
    };
    let m1 = memfd_with(b"alpha plane");
    let m2 = memfd_with(b"beta plane");
    proto::send(a.as_fd(), &msg, &[m1.as_fd(), m2.as_fd()]).unwrap();
    drop((m1, m2)); // the receiver's copies must stand on their own
    let (got, fds) = proto::recv::<FromWorker>(b.as_fd())
        .unwrap()
        .expect("a message");
    assert_eq!(got, msg);
    assert_eq!(fds.len(), 2);
    let mut fds = fds.into_iter();
    assert_eq!(read_all(fds.next().unwrap()), b"alpha plane");
    assert_eq!(read_all(fds.next().unwrap()), b"beta plane");

    // Every shape survives the trip (u64 modifiers exactly, unit variants, nested enums).
    let to = [
        start(),
        ToWorker::Tick {
            seq: u64::MAX - 3,
            t: 12.345678,
            input: Some((0..=255).cycle().take(1024).collect()),
        },
        ToWorker::Route {
            audio: AudioRoute::Device("pipewire/liascape-player-bus".into()),
        },
        ToWorker::Quit,
    ];
    for m in &to {
        proto::send(b.as_fd(), m, &[]).unwrap();
        let (got, fds) = proto::recv::<ToWorker>(a.as_fd()).unwrap().unwrap();
        assert_eq!(&got, m);
        assert!(fds.is_empty());
    }
    // Nothing queued → None (never blocks).
    assert!(proto::recv::<ToWorker>(a.as_fd()).unwrap().is_none());
}

#[test]
fn proto_rejects_oversized_and_garbage() {
    let (a, b) = seqpacket_pair();
    // A message that would serialise past 64 KiB is refused by the sender.
    let big = FromWorker::Log {
        level: "info".into(),
        line: "x".repeat(65 * 1024),
    };
    let e = proto::send(a.as_fd(), &big, &[]).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput, "{e}");
    // A 65 KiB datagram that arrives anyway is an error at the receiver, not a truncated parse.
    raw_send(&a, &vec![b'{'; 65 * 1024]);
    let e = proto::recv::<FromWorker>(b.as_fd()).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::InvalidData, "{e}");
    // Garbage → an error; the next valid datagram still parses.
    raw_send(&a, b"this is not json");
    assert!(proto::recv::<FromWorker>(b.as_fd()).is_err());
    raw_send(&a, br#"{"msg":"no_such_message"}"#);
    assert!(proto::recv::<FromWorker>(b.as_fd()).is_err());
    proto::send(a.as_fd(), &FromWorker::Pong { seq: 7 }, &[]).unwrap();
    let (m, _) = proto::recv::<FromWorker>(b.as_fd()).unwrap().unwrap();
    assert_eq!(m, FromWorker::Pong { seq: 7 });
    // Peer gone → UnexpectedEof. (Wait for the hang-up first: a sibling test's worker spawn
    // can hold a copy of `a` for the µs between its clone and exec.)
    drop(a);
    let mut p = libc::pollfd {
        fd: b.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe { libc::poll(&mut p, 1, 2000) };
    let e = proto::recv::<FromWorker>(b.as_fd()).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::UnexpectedEof, "{e}");
}

#[test]
fn spawn_handshake_hello() {
    let spec = stub_spec("hello", "");
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    // posix_spawn (vfork semantics) on the calling thread: no fork of the test process.
    let spawn_cost = t0.elapsed();
    println!("spawn() took {spawn_cost:?}");
    assert!(
        spawn_cost < Duration::from_millis(50),
        "spawn() took {spawn_cost:?}"
    );
    let pid = host.pid().expect("a pid right after spawn");
    let evs = pump(&mut host, t0, Duration::from_secs(1), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    let (at, ev) = evs.last().expect("an event within 1 s");
    match ev {
        WorkerEvent::Msg(
            FromWorker::Hello {
                protocol,
                pid: hp,
                features,
                ..
            },
            _,
        ) => {
            assert_eq!(*protocol, proto::PROTOCOL);
            assert_eq!(*hp, pid, "Hello names the child the host spawned");
            assert!(features.iter().any(|f| f == "stub"), "{features:?}");
        }
        other => panic!("expected Hello, got {other:?}"),
    }
    assert!(*at <= Duration::from_secs(1), "Hello after {at:?}");
    assert!(matches!(host.state(), WorkerState::Running));
    host.stop();
    assert!(matches!(host.state(), WorkerState::Stopped));
}

#[test]
fn worker_exit_is_seen_with_its_signal() {
    let mut spec = stub_spec("sig", "crash_after_ms:100");
    spec.budget = RestartBudget {
        window: Duration::from_secs(60),
        max: 0,
    };
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Exited { .. })
    });
    let (at, ev) = evs.last().expect("events");
    match ev {
        WorkerEvent::Exited { signal, code } => {
            assert_eq!(*signal, Some(libc::SIGABRT), "code {code:?}");
            assert_eq!(*code, None);
        }
        other => panic!("expected Exited, got {other:?} (all: {evs:?})"),
    }
    assert!(*at <= Duration::from_millis(500), "Exited after {at:?}");
}

#[test]
fn worker_exit_code_is_seen() {
    let mut spec = stub_spec("code", "exit_code:7");
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Exited { .. })
    });
    match evs.last() {
        Some((_, WorkerEvent::Exited { signal, code })) => {
            assert_eq!((*signal, *code), (None, Some(7)));
        }
        other => panic!("expected Exited, got {other:?}"),
    }
}

#[test]
fn hang_is_detected_by_heartbeat() {
    let mut spec = stub_spec("hang", "hang_after_ms:100");
    spec.hang_timeout = Duration::from_millis(300);
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let pid = host.pid().unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Hung { .. })
    });
    let (at, ev) = evs.last().expect("events");
    assert!(
        matches!(ev, WorkerEvent::Hung { waited_ms } if *waited_ms >= 300),
        "expected Hung after ≥ 300 ms of silence, got {ev:?} (all: {evs:?})"
    );
    assert!(*at <= Duration::from_millis(600), "Hung after {at:?}");
    let hung_at = Instant::now();
    pump(&mut host, t0, Duration::from_millis(100), |_| false);
    while !pid_reaped(pid) && hung_at.elapsed() < Duration::from_millis(100) {
        host.poll(Instant::now());
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(
        pid_reaped(pid),
        "the hung worker (pid {pid}) is still there {:?} after Hung",
        hung_at.elapsed()
    );
}

#[test]
fn restarts_three_times_then_broken() {
    let spec = stub_spec("crashy", "crash_after_ms:50");
    let crash_dir = spec.crash_dir.clone();
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(10), |e| {
        matches!(e, WorkerEvent::Broken { .. })
    });
    let restarts: Vec<u32> = evs
        .iter()
        .filter_map(|(_, e)| match e {
            WorkerEvent::Restarted { attempt } => Some(*attempt),
            _ => None,
        })
        .collect();
    assert_eq!(restarts, vec![1, 2, 3], "events: {evs:?}");
    let exits = evs
        .iter()
        .filter(|(_, e)| matches!(e, WorkerEvent::Exited { .. }))
        .count();
    assert_eq!(exits, 4, "one Exited per process: {evs:?}");
    let record = match &evs.last().unwrap().1 {
        WorkerEvent::Broken { record } => record.clone(),
        other => panic!("expected Broken last, got {other:?}"),
    };
    assert!(matches!(host.state(), WorkerState::Broken { .. }));
    assert!(host.pid().is_none(), "a broken host has no process");
    assert_eq!(record.parent().unwrap(), crash_dir);
    let name = record.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("1234567-") && name.ends_with(".json"),
        "record named <scene-id>-<unix_ms>.json: {name}"
    );
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
    assert_eq!(v["scene_id"], "1234567");
    assert_eq!(v["path"], "/nonexistent/workshop/1234567");
    assert_eq!(v["restarts"], 3);
    assert_eq!(v["signal"], libc::SIGABRT);
    assert!(v["uptime_ms"].as_f64().unwrap() >= 40.0, "{v}");
    assert!(v["t_wall"].as_str().unwrap().contains('T'), "{v}");
    let tail: Vec<String> = serde_json::from_value(v["log_tail"].clone()).unwrap();
    assert!(
        tail.iter().any(|l| l.contains("stub: crashing")),
        "the stub's stderr line is in the record: {tail:?}"
    );
    // Nothing more happens once broken.
    let more = pump(&mut host, t0, Duration::from_millis(300), |_| false);
    assert!(more.is_empty(), "{more:?}");
}

#[test]
fn restart_resends_start_at_resume_position() {
    let spec = stub_spec("resume", "crash_after_ms:150");
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    // The stub logs the Start it gets: "stub: start position <p>".
    let first = pump(
        &mut host,
        t0,
        Duration::from_secs(2),
        |e| matches!(e, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.contains("start position")),
    );
    assert!(
        matches!(&first.last().unwrap().1, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.ends_with("start position 0")),
        "{first:?}"
    );
    host.set_resume_position(12.5);
    let evs = pump(
        &mut host,
        t0,
        Duration::from_secs(3),
        |e| matches!(e, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.contains("start position")),
    );
    assert!(
        evs.iter()
            .any(|(_, e)| matches!(e, WorkerEvent::Restarted { attempt: 1 })),
        "{evs:?}"
    );
    match &evs.last().unwrap().1 {
        WorkerEvent::Msg(FromWorker::Log { line, .. }, _) => {
            assert!(line.ends_with("start position 12.5"), "{line}")
        }
        other => panic!("expected the restarted stub's Start log, got {other:?}"),
    }
    host.stop();
}

#[test]
fn stop_never_blocks() {
    let mut host = WorkerHost::spawn(stub_spec("stop", "ignore_quit")).unwrap();
    let t0 = Instant::now();
    pump(&mut host, t0, Duration::from_secs(1), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    let pid = host.pid().unwrap();
    let t = Instant::now();
    host.stop();
    let took = t.elapsed();
    assert!(took < Duration::from_millis(5), "stop() took {took:?}");
    assert!(matches!(host.state(), WorkerState::Stopped));
    assert!(host.pid().is_none());
    let limit = STOP_GRACE + Duration::from_millis(100);
    while !pid_dead(pid) && t.elapsed() < limit + Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let gone = t.elapsed();
    assert!(
        pid_dead(pid),
        "a worker ignoring Quit is still alive after {gone:?}"
    );
    assert!(
        gone <= limit,
        "a worker ignoring Quit went after {gone:?} (> STOP_GRACE + 100 ms)"
    );
    assert!(
        gone >= STOP_GRACE - Duration::from_millis(50),
        "it got its grace period ({gone:?})"
    );
    // Dropping a stopped host is a no-op; dropping a live one stops it the same way.
    drop(host);
}

/// The helper half of [`worker_dies_with_its_parent`]: only runs inside the re-exec'd test
/// binary (env [`HELPER_ENV`]); spawns a stub, prints its pid and waits to be killed.
#[test]
fn helper_spawn_and_wait() {
    if std::env::var_os(HELPER_ENV).is_none() {
        return;
    }
    let mut host = WorkerHost::spawn(stub_spec("orphan", "ignore_quit")).unwrap();
    let t0 = Instant::now();
    pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    println!("WORKER_PID={}", host.pid().unwrap());
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(30));
}

#[test]
fn worker_dies_with_its_parent() {
    use std::io::BufRead;
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
    cmd.args([
        "--exact",
        "helper_spawn_and_wait",
        "--nocapture",
        "--test-threads=1",
    ])
    .env(HELPER_ENV, "1")
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let mut helper = cmd.spawn().unwrap();
    let out = helper.stdout.take().unwrap();
    let mut pid = None;
    for line in std::io::BufReader::new(out).lines() {
        let line = line.unwrap();
        // The harness prints "test helper_spawn_and_wait ... " on the same line first.
        if let Some(p) = line.split("WORKER_PID=").nth(1) {
            pid = Some(p.trim().parse::<u32>().unwrap());
            break;
        }
    }
    let pid = pid.expect("the helper printed its worker's pid");
    assert!(!pid_dead(pid), "the worker is alive before its parent dies");
    helper.kill().unwrap(); // SIGKILL: no Drop, no stop() — only PDEATHSIG can take it down
    helper.wait().unwrap();
    let t = Instant::now();
    while !pid_dead(pid) && t.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        t.elapsed() <= Duration::from_millis(300) && pid_dead(pid),
        "worker {pid} outlived its SIGKILLed parent by {:?}",
        t.elapsed()
    );
}

#[test]
fn log_tail_and_crash_records_are_bounded() {
    let mut spec = stub_spec("spam", "spam_stderr:10000,crash_after_ms:300");
    spec.budget.max = 0;
    let crash_dir = spec.crash_dir.clone();
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(10), |e| {
        matches!(e, WorkerEvent::Broken { .. })
    });
    assert!(
        matches!(evs.last(), Some((_, WorkerEvent::Broken { .. }))),
        "{evs:?}"
    );
    let tail = host.log_tail();
    assert_eq!(tail.len(), liascape_player::worker::LOG_TAIL, "{tail:?}");
    assert!(tail[49].contains("stub: crashing"), "newest last: {tail:?}");
    // stderr and the socket's Log lines interleave arbitrarily; the spam lines kept are the
    // newest ones, in order, ending with the last.
    let spam: Vec<u32> = tail
        .iter()
        .filter_map(|l| l.strip_prefix("stub: spam line ")?.parse().ok())
        .collect();
    assert!(spam.len() >= 45, "{tail:?}");
    assert_eq!(*spam.last().unwrap(), 9999, "{tail:?}");
    assert!(spam.windows(2).all(|w| w[1] == w[0] + 1), "{spam:?}");

    // 25 more broken workers into the same directory → only the newest 20 records stay.
    for i in 0..25 {
        let mut s = stub_spec(&format!("rec{i}"), "crash_after_ms:0");
        s.budget.max = 0;
        s.crash_dir = crash_dir.clone();
        let mut h = WorkerHost::spawn(s).unwrap();
        let evs = pump(&mut h, Instant::now(), Duration::from_secs(5), |e| {
            matches!(e, WorkerEvent::Broken { .. })
        });
        assert!(
            matches!(evs.last(), Some((_, WorkerEvent::Broken { .. }))),
            "{evs:?}"
        );
    }
    let n = std::fs::read_dir(&crash_dir)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "json")
        })
        .count();
    assert_eq!(
        n,
        liascape_player::worker::MAX_CRASH_RECORDS,
        "records in {crash_dir:?}"
    );
}
