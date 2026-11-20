//! Scene worker protocol + process lifecycle (`docs/player/modules/scene-worker.md`).
//! No GPU: every worker here is `liascape-scene-worker --stub`, whose behaviour the
//! `LIASCAPE_SCENE_WORKER_TEST` knobs script (`crash_after_ms`, `hang_after_ms`, `exit_code`,
//! `ignore_quit`, `spam_stderr`). Crash records go to a private dir under `temp_dir()`; the
//! stub sets its own `RLIMIT_CORE` 1 before `abort()` (no systemd-coredump / DrKonqi popups).

/// This suite's own temp root, removed at exit (`src/test_tmp.rs`).
#[path = "../src/test_tmp.rs"]
#[allow(dead_code)]
mod test_tmp;

use std::io::Read;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
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

/// NVIDIA's shader disk cache folder for a worker spawned with crash dir `dir` (`tests/common`'s
/// `shader_cache_dir`, which this suite doesn't include).
fn shader_cache_dir(dir: &Path) -> PathBuf {
    dir.join("nv-shader-cache")
}

/// Every worker a test spawns starts from this: crash records and NVIDIA's shader cache in a
/// private dir (the renderer would otherwise create and fill the caller's
/// `__GL_SHADER_DISK_CACHE_PATH`). Guard `spawned_worker_never_inherits_the_shader_cache_path`.
fn spec(id: &str) -> WorkerSpec {
    let mut s = WorkerSpec::new(id, bin(), start());
    s.crash_dir = tmp_dir(id);
    let cache = shader_cache_dir(&s.crash_dir);
    set_env(&mut s, "__GL_SHADER_DISK_CACHE_PATH", &cache.to_string_lossy());
    s
}

/// Set `k` in `s`'s environment, replacing an earlier value (the child would read the first).
fn set_env(s: &mut WorkerSpec, k: &str, v: &str) {
    s.env.retain(|(sk, _)| sk != k);
    s.env.push((k.into(), v.into()));
}

fn stub_spec(id: &str, knobs: &str) -> WorkerSpec {
    let mut s = spec(id);
    s.args = vec!["--stub".into()];
    set_env(&mut s, "LIASCAPE_SCENE_WORKER_TEST", knobs);
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
            input: Some(proto::AudioInput::from_stereo(
                48_000,
                &(0..2048)
                    .map(|i| (i % 255) as f32 / 255.0 - 0.5)
                    .collect::<Vec<_>>(),
            )),
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

/// Spawn the real renderer (no `--stub`) with `env` and wait for its `Hello`, which it sends
/// after its GL context attempt — so after the shader cache step, GPU or not. Returns its crash
/// dir.
fn renderer_hello(id: &str, env: &[(&str, &std::path::Path)], extra: &[(&str, &str)]) -> PathBuf {
    let mut spec = spec(id);
    let crash_dir = spec.crash_dir.clone();
    for (k, v) in env {
        set_env(&mut spec, k, &v.to_string_lossy());
    }
    for (k, v) in extra {
        set_env(&mut spec, k, v);
    }
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(20), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    assert!(
        matches!(evs.last(), Some((_, WorkerEvent::Msg(FromWorker::Hello { .. }, _)))),
        "no Hello from the renderer: {evs:?}\n{}",
        host.log_tail().join("\n")
    );
    host.stop();
    crash_dir
}

/// Set in the child [`spawned_worker_never_inherits_the_shader_cache_path`] re-runs this binary
/// as: only then does [`shader_cache_guard_child`] do anything.
const SHADER_CACHE_GUARD_ENV: &str = "LIASCAPE_TEST_SHADER_CACHE_GUARD";

/// A test's workers never use the caller's NVIDIA shader cache: on a desktop that sets
/// `__GL_SHADER_DISK_CACHE_PATH` (its real cache), the renderer would create that folder and
/// fill it. Re-runs this binary with the variable naming a missing sentinel and starts the real
/// renderer through [`spec`] there; it creates whatever folder it's given before its GL
/// context, so an inherited sentinel would appear.
#[test]
fn spawned_worker_never_inherits_the_shader_cache_path() {
    const PATH: &str = "__GL_SHADER_DISK_CACHE_PATH";
    let root = tmp_dir("nvguard");
    let sentinel = root.join("callers-nv");
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "shader_cache_guard_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(SHADER_CACHE_GUARD_ENV, "1")
        .env(PATH, &sentinel)
        .output()
        .expect("re-run this test binary");
    let text =
        String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    assert!(
        !sentinel.exists(),
        "a spawned worker inherited the caller's {PATH} and created {sentinel:?}\n{text}"
    );
    assert!(out.status.success(), "{text}");
    assert!(
        text.contains("SHADER_CACHE_GUARD_SPAWNED"),
        "the child never spawned a renderer: proved nothing\n{text}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// [`spawned_worker_never_inherits_the_shader_cache_path`]'s child: spawn the real renderer the
/// way every test does; it must have made its cache folder in its own dir.
#[test]
fn shader_cache_guard_child() {
    if std::env::var_os(SHADER_CACHE_GUARD_ENV).is_none() {
        return;
    }
    let dir = renderer_hello("nvguard-child", &[], &[]);
    let own = shader_cache_dir(&dir);
    assert!(own.is_dir(), "the renderer didn't create its own {own:?}");
    let _ = std::fs::remove_dir_all(&dir);
    println!("SHADER_CACHE_GUARD_SPAWNED");
}

/// NVIDIA's shader disk cache works only when `__GL_SHADER_DISK_CACHE_PATH` exists; the
/// renderer creates it (0700) before its GL context, leaves it alone when the cache is off,
/// and an uncreatable path never stops it.
#[test]
fn renderer_creates_the_shader_cache_dir() {
    use std::os::unix::fs::MetadataExt;
    const PATH: &str = "__GL_SHADER_DISK_CACHE_PATH";
    let root = tmp_dir("nvcache");
    let dir = root.join("cache/nv");
    renderer_hello("nvcache", &[(PATH, &dir)], &[]);
    assert!(dir.is_dir(), "the renderer didn't create {dir:?}");
    assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o7777, 0o700);

    let off = root.join("off/nv");
    renderer_hello("nvcache-off", &[(PATH, &off)], &[("__GL_SHADER_DISK_CACHE", "0")]);
    assert!(!root.join("off").exists(), "__GL_SHADER_DISK_CACHE=0 created {off:?}");

    let file = root.join("file");
    std::fs::write(&file, b"").unwrap();
    renderer_hello("nvcache-bad", &[(PATH, &file.join("nv"))], &[]);
    let _ = std::fs::remove_dir_all(&root);
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

/// A stub with a ring of 3 (`ring:3`): spawn it, wait for its three `Buffer`s, then send
/// ticks until every slot is with the host (three `Frame`s, none released) and one more tick
/// is waiting for a slot. Returns the host, `t0`, the time the starving tick was sent, and
/// the three held slots.
fn starve(id: &str, knobs: &str, hang_ms: u64) -> (WorkerHost, Instant, Instant, Vec<u8>) {
    let mut spec = stub_spec(id, knobs);
    spec.hang_timeout = Duration::from_millis(hang_ms);
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let mut buffers = 0;
    pump(&mut host, t0, Duration::from_secs(2), |e| {
        buffers += matches!(e, WorkerEvent::Msg(FromWorker::Buffer { .. }, _)) as u32;
        buffers == 3
    });
    assert_eq!(buffers, 3, "the stub announced its ring");
    let mut held = Vec::new();
    for seq in 1..=3u64 {
        host.send(&ToWorker::Tick { seq, t: seq as f64, input: None }, &[])
            .unwrap();
        let evs = pump(&mut host, t0, Duration::from_secs(1), |e| {
            matches!(e, WorkerEvent::Msg(FromWorker::Frame { .. }, _))
        });
        match evs.last() {
            Some((_, WorkerEvent::Msg(FromWorker::Frame { slot, seq: s, .. }, _))) => {
                assert_eq!(*s, seq);
                held.push(*slot);
            }
            other => panic!("expected frame {seq}, got {other:?}"),
        }
    }
    host.send(&ToWorker::Tick { seq: 4, t: 4.0, input: None }, &[])
        .unwrap();
    (host, t0, Instant::now(), held)
}

/// After a suspend/resume every slot of the worker's ring can be with the compositor
/// (latched + queued frames whose fences haven't signalled yet), so the
/// next tick can't be rendered — the worker sits idle waiting for a `Release`
/// (`Renderer::run` → `recv`), which a naive heartbeat kills as hung. A worker the host starves of
/// slots is waiting on the host, not hung: it answers pings, and renders the tick the moment
/// a slot comes back.
#[test]
fn starved_worker_is_not_hung() {
    let (mut host, t0, starved_at, held) = starve("starved", "ring:3", 300);
    let pid = host.pid().unwrap();
    // 4 × the hang timeout with every slot held.
    let evs = pump(&mut host, t0, Duration::from_millis(1200), |e| {
        matches!(e, WorkerEvent::Hung { .. } | WorkerEvent::Exited { .. })
    });
    assert!(
        !evs.iter().any(|(_, e)| matches!(
            e,
            WorkerEvent::Hung { .. } | WorkerEvent::Exited { .. } | WorkerEvent::Msg(FromWorker::Frame { .. }, _)
        )),
        "a starved worker is neither hung nor framing: {evs:?}"
    );
    assert!(starved_at.elapsed() >= Duration::from_millis(1200));
    assert_eq!(host.pid(), Some(pid));
    // Give one slot back: the waiting tick is rendered at once.
    host.send(&ToWorker::Release { slot: held[0] }, &[]).unwrap();
    let released = Instant::now();
    let evs = pump(&mut host, t0, Duration::from_millis(300), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Frame { .. }, _) | WorkerEvent::Hung { .. })
    });
    assert!(
        matches!(evs.last(), Some((_, WorkerEvent::Msg(FromWorker::Frame { seq: 4, slot, .. }, _))) if *slot == held[0]),
        "tick 4 into the released slot: {evs:?}"
    );
    assert!(released.elapsed() < Duration::from_millis(300));
    // And the heartbeat runs normally again afterwards: no stray Hung.
    let evs = pump(&mut host, t0, Duration::from_millis(700), |e| {
        matches!(e, WorkerEvent::Hung { .. })
    });
    assert!(!evs.iter().any(|(_, e)| matches!(e, WorkerEvent::Hung { .. })), "{evs:?}");
    host.stop();
}

/// The starvation grace never hides a real hang: a starved worker that stops answering (here
/// at 600 ms) is killed within the usual bound — its pings go unanswered.
#[test]
fn starved_worker_that_hangs_is_still_killed() {
    let (mut host, t0, _, _) = starve("starved-hang", "ring:3,hang_after_ms:600", 300);
    let evs = pump(&mut host, t0, Duration::from_secs(3), |e| {
        matches!(e, WorkerEvent::Hung { .. })
    });
    let (at, ev) = evs.last().expect("events");
    assert!(matches!(ev, WorkerEvent::Hung { .. }), "{evs:?}");
    // Hung at ≥ 600 + 300 ms (not while it was merely starved), ≤ 600 + 1.5 × 300 (+ slack).
    assert!(
        (Duration::from_millis(900)..=Duration::from_millis(1150)).contains(at),
        "Hung at {at:?} (hang_after_ms 600, hang_timeout 300)"
    );
}

/// Starvation is bounded: slots the host never gives back (a dead GPU timeline — fences that
/// never signal) end in a hang kill after `STARVE_LIMIT_FACTOR` × the hang timeout, so a
/// restart (a fresh ring) recovers the scene instead of a picture frozen forever.
#[test]
fn starved_forever_is_killed_after_the_starve_limit() {
    let (mut host, t0, starved_at, _) = starve("starved-forever", "ring:3", 300);
    let limit = Duration::from_millis(300) * liascape_player::worker::STARVE_LIMIT_FACTOR;
    let evs = pump(&mut host, t0, limit + Duration::from_secs(1), |e| {
        matches!(e, WorkerEvent::Hung { .. })
    });
    assert!(
        matches!(evs.last(), Some((_, WorkerEvent::Hung { .. }))),
        "{evs:?}"
    );
    let after = starved_at.elapsed();
    assert!(
        (limit..=limit + Duration::from_millis(250)).contains(&after),
        "Hung {after:?} after the starvation began (limit {limit:?})"
    );
}

/// A suspend with NVIDIA saving VRAM through its kernel suspend notifier can block the
/// compositor's own loop for ~6 s (its heartbeat runs nowhere near the 2 s deadline), and its
/// first poll after the thaw then finds a tick ~6.4 s old — a naive heartbeat kills the worker. Time the host itself didn't run is not the worker's: after a host stall
/// every outstanding tick/ping gets a fresh hang timeout. (The worker here is frozen too, and
/// comes back 150 ms after the host does — inside the timeout.)
#[test]
fn host_stall_is_not_a_hang() {
    let mut spec = stub_spec("host-stall", "freeze_after_ms:200,freeze_ms:1100");
    spec.hang_timeout = Duration::from_millis(300);
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.contains("start position"))
    });
    let hello = Instant::now();
    std::thread::sleep(Duration::from_millis(250).saturating_sub(hello.elapsed()));
    host.send(&ToWorker::Tick { seq: 1, t: 0.0, input: None }, &[])
        .unwrap();
    // The host stalls: no poll for 3 × the hang timeout.
    std::thread::sleep(Duration::from_millis(900));
    let evs = pump(&mut host, t0, Duration::from_millis(800), |e| {
        matches!(e, WorkerEvent::Hung { .. } | WorkerEvent::Msg(FromWorker::Frame { .. }, _))
    });
    assert!(
        matches!(evs.last(), Some((_, WorkerEvent::Msg(FromWorker::Frame { seq: 1, .. }, _)))),
        "the tick is answered after the stall, no Hung: {evs:?}"
    );
    host.stop();
}

/// The stall grace is the host's own stall only: a worker that freezes while the host keeps
/// polling is still hung within the usual bound.
#[test]
fn worker_freeze_while_the_host_polls_is_hung() {
    let mut spec = stub_spec("worker-freeze", "freeze_after_ms:200,freeze_ms:1100");
    spec.hang_timeout = Duration::from_millis(300);
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.contains("start position"))
    });
    std::thread::sleep(Duration::from_millis(250));
    host.send(&ToWorker::Tick { seq: 1, t: 0.0, input: None }, &[])
        .unwrap();
    let sent = Instant::now();
    let evs = pump(&mut host, t0, Duration::from_secs(1), |e| {
        matches!(e, WorkerEvent::Hung { .. })
    });
    assert!(matches!(evs.last(), Some((_, WorkerEvent::Hung { .. }))), "{evs:?}");
    assert!(
        sent.elapsed() < Duration::from_millis(400),
        "Hung {:?} after the tick",
        sent.elapsed()
    );
}

/// A worker still starting past the hello timeout but making progress (here on the CPU; a cold
/// start on a busy disk pages its binary and the GL driver in, its major faults moving) is waited
/// for: it says `Hello` and is never killed. Killing it would only start it again from scratch,
/// and three restarts mark the scene broken.
#[test]
fn slow_start_is_not_a_hang() {
    let mut spec = stub_spec("slow-start", "start_busy_ms:3000");
    spec.hang_timeout = Duration::from_millis(300);
    spec.hello_timeout = Duration::from_millis(1500);
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(8), |e| {
        matches!(e, WorkerEvent::Hung { .. } | WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    assert!(
        matches!(evs.last(), Some((_, WorkerEvent::Msg(FromWorker::Hello { .. }, _)))),
        "Hello after the slow start, no Hung: {evs:?}"
    );
    let at = evs.last().unwrap().0;
    assert!(at >= Duration::from_millis(3000), "Hello after {at:?}: the start was not slow");
    assert!(matches!(host.state(), WorkerState::Running));
    host.stop();
}

/// The start lasts until the first `Frame`: a worker past `Hello` whose first render keeps it from
/// answering pings beyond the hang timeout while it pages in (on a busy disk the driver's first
/// calls fault their code in) is not hung either — it frames the tick once through.
#[test]
fn slow_first_render_is_not_a_hang() {
    first_render("slow-first", "ring:3,first_fault_ms:2000", true);
}

/// After `Hello` CPU time alone is no progress: a load's CPU work is covered by the worker's own
/// protocol thread (bounded by its load timeout), and a first render that spins without answering
/// is hung at the hang timeout, as before.
#[test]
fn busy_first_render_is_hung() {
    first_render("busy-first", "ring:3,first_busy_ms:2000", false);
}

fn first_render(id: &str, knobs: &str, frames: bool) {
    let mut spec = stub_spec(id, knobs);
    spec.hang_timeout = Duration::from_millis(300);
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    assert!(
        matches!(evs.last(), Some((_, WorkerEvent::Msg(FromWorker::Hello { .. }, _)))),
        "{evs:?}"
    );
    let hello = Instant::now();
    host.send(&ToWorker::Tick { seq: 1, t: 1.0, input: None }, &[])
        .unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(6), |e| {
        matches!(e, WorkerEvent::Hung { .. } | WorkerEvent::Msg(FromWorker::Frame { .. }, _))
    });
    if frames {
        assert!(
            matches!(evs.last(), Some((_, WorkerEvent::Msg(FromWorker::Frame { seq: 1, .. }, _)))),
            "the first tick framed after the slow first render, no Hung: {evs:?}"
        );
        assert!(hello.elapsed() >= Duration::from_millis(2000), "the first render was not slow");
    } else {
        assert!(matches!(evs.last(), Some((_, WorkerEvent::Hung { .. }))), "{evs:?}");
        assert!(
            hello.elapsed() < Duration::from_millis(1500),
            "Hung only {:?} after Hello",
            hello.elapsed()
        );
    }
    host.stop();
}

/// A start that stops moving (asleep: blocked on a lock or in the driver) is hung at the hello
/// timeout, as before.
#[test]
fn stuck_start_is_hung() {
    let mut spec = stub_spec("stuck-start", "start_sleep_ms:4000");
    spec.hang_timeout = Duration::from_millis(300);
    spec.hello_timeout = Duration::from_millis(600);
    spec.budget.max = 0;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(3), |e| {
        matches!(e, WorkerEvent::Hung { .. } | WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    match evs.last() {
        Some((at, WorkerEvent::Hung { waited_ms })) => {
            assert!(*waited_ms >= 600, "Hung after {waited_ms} ms");
            assert!(*at < Duration::from_millis(2000), "Hung only {at:?} after the spawn");
        }
        other => panic!("expected Hung, got {other:?} (all: {evs:?})"),
    }
}

/// A start that keeps moving but never says `Hello` (spinning) is hung at
/// `HELLO_TIMEOUT_MAX_FACTOR` × the hello timeout.
#[test]
fn endless_start_is_hung_at_the_cap() {
    let mut spec = stub_spec("endless-start", "start_busy_ms:12000");
    spec.hang_timeout = Duration::from_millis(300);
    spec.hello_timeout = Duration::from_millis(1000);
    spec.budget.max = 0;
    let cap = spec.hello_timeout * liascape_player::worker::HELLO_TIMEOUT_MAX_FACTOR;
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(13), |e| {
        matches!(e, WorkerEvent::Hung { .. } | WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    match evs.last() {
        Some((_, WorkerEvent::Hung { waited_ms })) => {
            let w = Duration::from_millis(*waited_ms);
            assert!(w >= cap && w < cap + Duration::from_secs(1), "Hung after {w:?} (cap {cap:?})");
        }
        other => panic!("expected Hung at the cap, got {other:?} (all: {evs:?})"),
    }
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

// ---- the spare worker (`worker::spare`, `docs/player/modules/scene-worker.md` § The spare worker)

fn start_at(id: &str, at: f64) -> ToWorker {
    let mut s = start();
    if let ToWorker::Start {
        position, id: sid, ..
    } = &mut s
    {
        *position = at;
        *sid = id.into();
    }
    s
}

fn is_start_log(e: &WorkerEvent) -> bool {
    matches!(e, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.contains("start position"))
}

/// A spare says `Hello` and then waits — no `Start`, pings answered, no hang — until a scene
/// adopts it: the same process then gets that scene's `Start` (the stub logs it), its `Hello` is
/// replayed to the adopter, and it is an ordinary running worker. A spec launched differently
/// (another environment: the synthetic test scenes switched since the spare started) isn't adopted.
#[test]
fn spare_waits_for_its_scene_and_takes_the_start() {
    let mut spare_spec = stub_spec("spare", "");
    spare_spec.hang_timeout = Duration::from_millis(400);
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn_spare(spare_spec.clone()).unwrap();
    assert!(host.is_spare());
    assert_eq!(*host.state(), WorkerState::Spare);
    let pid = host.pid().unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(2), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    assert!(host.said_hello(), "{evs:?}");
    assert_eq!(
        *host.state(),
        WorkerState::Spare,
        "a Hello doesn't make it a scene's worker"
    );
    // Several hang timeouts idle: pinged, never hung, never started.
    let idle = pump(&mut host, t0, Duration::from_millis(1500), |_| false);
    assert!(
        !idle
            .iter()
            .any(|(_, e)| matches!(e, WorkerEvent::Hung { .. } | WorkerEvent::Exited { .. })),
        "an idle spare is alive and answering: {idle:?}"
    );
    assert!(
        !idle.iter().any(|(_, e)| is_start_log(e)),
        "no Start before the adoption: {idle:?}"
    );
    assert_eq!(host.pid(), Some(pid));

    // Another launch (its environment differs) → not adopted, still the spare.
    let mut other = spare_spec.clone();
    set_env(&mut other, "LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES", "0");
    other.id = "src9".into();
    other.start = start_at("src9", 12.5);
    let back = host
        .adopt(other)
        .expect_err("a differently launched spec isn't adopted");
    assert_eq!(back.id, "src9");
    assert!(host.is_spare());

    let mut mine = spare_spec.clone();
    mine.id = "src9".into();
    mine.start = start_at("src9", 12.5);
    host.adopt(mine).expect("the spare is adopted");
    assert!(!host.is_spare());
    assert_eq!(*host.state(), WorkerState::Running);
    assert_eq!(host.pid(), Some(pid), "the same process");
    assert_eq!(host.spec().id, "src9");
    let evs = pump(&mut host, t0, Duration::from_secs(2), is_start_log);
    assert!(
        matches!(&evs.first().map(|e| &e.1), Some(WorkerEvent::Msg(FromWorker::Hello { pid: hp, .. }, _)) if *hp == pid),
        "the adopter sees the spare's Hello first: {evs:?}"
    );
    match &evs.last().unwrap().1 {
        WorkerEvent::Msg(FromWorker::Log { line, .. }, _) => {
            assert!(line.ends_with("start position 12.5"), "{line}")
        }
        other => panic!("expected the adopted stub's Start log, got {other:?}"),
    }
    assert!(
        host.log_tail()
            .iter()
            .any(|l| l.contains("spare worker adopted by src9"))
    );
    host.stop();
}

/// A spare adopted before its `Hello` gets the scene's `Start` at that `Hello`, like any worker.
#[test]
fn spare_adopted_before_its_hello_starts_at_the_hello() {
    let spare_spec = stub_spec("spare-early", "start_sleep_ms:300");
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn_spare(spare_spec.clone()).unwrap();
    let mut mine = spare_spec;
    mine.id = "early".into();
    mine.start = start_at("early", 3.0);
    host.adopt(mine).expect("a spare still starting is adopted");
    assert_eq!(*host.state(), WorkerState::Starting);
    let evs = pump(&mut host, t0, Duration::from_secs(3), is_start_log);
    assert!(
        matches!(&evs.last().unwrap().1, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.ends_with("start position 3")),
        "{evs:?}"
    );
    assert_eq!(*host.state(), WorkerState::Running);
    host.stop();
}

/// A spare's death is no crash: `Exited`, then nothing — no restart, no budget, no crash
/// record — and the host is stopped (the pool starts another).
#[test]
fn spare_death_is_not_a_crash() {
    let spec = stub_spec("spare-dies", "crash_after_ms:100");
    let crash_dir = spec.crash_dir.clone();
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn_spare(spec).unwrap();
    let evs = pump(&mut host, t0, Duration::from_secs(3), |e| {
        matches!(e, WorkerEvent::Exited { .. })
    });
    assert!(
        matches!(evs.last().map(|e| &e.1), Some(WorkerEvent::Exited { .. })),
        "{evs:?}"
    );
    let more = pump(&mut host, t0, Duration::from_millis(400), |_| false);
    assert!(more.is_empty(), "nothing after a spare's death: {more:?}");
    assert_eq!(*host.state(), WorkerState::Stopped);
    assert!(host.pid().is_none());
    assert_eq!(host.restarts(Instant::now()), (0, 0));
    let records = std::fs::read_dir(&crash_dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .count();
    assert_eq!(records, 0, "no crash record for a spare");
}

fn is_log(e: &WorkerEvent, needle: &str) -> bool {
    matches!(e, WorkerEvent::Msg(FromWorker::Log { line, .. }, _) if line.contains(needle))
}

fn crash_records(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .count()
}

/// An adopted spare whose load stalls (pings answered by its protocol thread, as the worker's
/// `LoadGate` does for 30 s, but no CPU time, page fault or IO) is dropped one stall window
/// (`worker::spare_load_stall`: the hang timeout) after its last progress, and a fresh worker
/// takes the same scene: `Replaced` and nothing a crash brings (no `Exited`, `Hung`,
/// `Restarted`, budget or crash record); the fresh process gets the scene's `Start`.
#[test]
fn spare_load_stall_drops_it_for_a_fresh_worker() {
    let flag = tmp_dir("spare-stall").join("stalled");
    let mut spare_spec = stub_spec("spare", &format!("load_stall:{}", flag.display()));
    spare_spec.hang_timeout = Duration::from_millis(400);
    let crash_dir = spare_spec.crash_dir.clone();
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn_spare(spare_spec.clone()).unwrap();
    pump(&mut host, t0, Duration::from_secs(3), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    let spare_pid = host.pid().unwrap();
    let mut mine = spare_spec;
    mine.id = "src7".into();
    mine.start = start_at("src7", 4.0);
    host.adopt(mine).expect("the spare is adopted");
    let adopted = Instant::now();
    let evs = pump(&mut host, t0, Duration::from_secs(4), |e| {
        matches!(e, WorkerEvent::Replaced { .. })
    });
    let dropped_after = adopted.elapsed();
    assert!(flag.exists(), "the spare never stalled: proved nothing: {evs:?}");
    match evs.last().map(|e| &e.1) {
        Some(WorkerEvent::Replaced { why }) => {
            assert!(why.contains("adopted spare's load stalled"), "{why}")
        }
        _ => panic!("a stalled adopted spare is replaced: {evs:?}"),
    }
    assert!(
        dropped_after >= Duration::from_millis(400),
        "dropped before a whole stall window passed: {dropped_after:?}"
    );
    let fresh = host.pid().expect("a fresh worker");
    assert_ne!(fresh, spare_pid, "a new process, not the spare");
    assert_eq!(*host.state(), WorkerState::Starting);
    // The fresh worker plays the scene; no crash path at any point.
    let more = pump(&mut host, t0, Duration::from_secs(3), |e| is_log(e, "start position 4"));
    let all: Vec<_> = evs.iter().chain(&more).collect();
    assert!(
        more.last().is_some_and(|(_, e)| is_log(e, "start position 4")),
        "the fresh worker takes the scene's Start: {more:?}"
    );
    assert!(
        !all.iter().any(|(_, e)| matches!(
            e,
            WorkerEvent::Exited { .. }
                | WorkerEvent::Hung { .. }
                | WorkerEvent::Restarted { .. }
                | WorkerEvent::Broken { .. }
        )),
        "a dropped spare is no crash: {all:?}"
    );
    assert_eq!(*host.state(), WorkerState::Running);
    assert_eq!(host.restarts(Instant::now()), (0, 0), "no restart budget spent");
    assert_eq!(crash_records(&crash_dir), 0, "no crash record");
    let t = Instant::now();
    while !pid_dead(spare_pid) && t.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(pid_dead(spare_pid), "the stalled spare is killed");
    let tail = host.log_tail().join("\n");
    assert!(tail.contains("stub: load stalled"), "the spare's own last lines stay: {tail}");
    assert!(tail.contains("a fresh worker loads the scene"), "{tail}");
    host.stop();
}

/// An adopted spare whose load is slow but works (CPU time on another thread, pings answered)
/// stays: the watchdog judges progress, not time.
#[test]
fn spare_load_that_moves_is_kept() {
    let mut spare_spec = stub_spec("spare", "load_busy_ms:1500");
    spare_spec.hang_timeout = Duration::from_millis(400);
    let t0 = Instant::now();
    let mut host = WorkerHost::spawn_spare(spare_spec.clone()).unwrap();
    pump(&mut host, t0, Duration::from_secs(3), |e| {
        matches!(e, WorkerEvent::Msg(FromWorker::Hello { .. }, _))
    });
    let pid = host.pid().unwrap();
    let mut mine = spare_spec;
    mine.id = "src8".into();
    mine.start = start_at("src8", 1.0);
    host.adopt(mine).expect("the spare is adopted");
    let evs = pump(&mut host, t0, Duration::from_secs(5), |e| is_log(e, "stub: loaded"));
    assert!(
        evs.last().is_some_and(|(_, e)| is_log(e, "stub: loaded")),
        "the slow load finishes in the adopted spare: {evs:?}"
    );
    assert!(
        !evs.iter().any(|(_, e)| matches!(
            e,
            WorkerEvent::Replaced { .. } | WorkerEvent::Exited { .. } | WorkerEvent::Hung { .. }
        )),
        "{evs:?}"
    );
    assert_eq!(host.pid(), Some(pid), "the same process");
    host.stop();
}

mod spare_pool {
    use super::*;
    use liascape_player::worker::spare::{Launch, Spare, Timing, Want};

    fn launch(knobs: &str, synthetic: &str) -> Launch {
        let s = stub_spec("spare", knobs);
        let mut l = Launch::of(&s);
        l.env.push(("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES".into(), synthetic.into()));
        l
    }

    fn want(launch: &Launch) -> Want {
        Want {
            enabled: true,
            launch: Some(launch.clone()),
            hang_timeout: Duration::from_secs(2),
            suspended: false,
            scenes_hosted: true,
            rotation: None,
            quiet: true,
        }
    }

    fn scene_spec(launch: &Launch, id: &str) -> WorkerSpec {
        let mut s = WorkerSpec::new(id, launch.bin.clone(), start_at(id, 0.0));
        s.args = launch.args.clone();
        s.env = launch.env.clone();
        s.crash_dir = tmp_dir(id);
        s
    }

    fn fast() -> Timing {
        Timing {
            refill_after: Duration::ZERO,
            idle_after: Duration::from_secs(3600),
            retry: Duration::from_millis(50),
            retry_max: Duration::from_millis(200),
        }
    }

    fn wait_dead(pid: u32) {
        let t = Instant::now();
        while !pid_dead(pid) && t.elapsed() < STOP_GRACE + Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(pid_dead(pid), "pid {pid} still alive");
    }

    /// The policy: no spare until scenes are in use; then one, and never two; a take hands it
    /// over and the next sync starts a new one; off, low VRAM, no scenes or `stop` reap it at
    /// once (and `stop` forgets that scenes were in use); a launch change (the synthetic test scenes switched)
    /// replaces it at once, so no scene starts in a stale one; a load or a transition in flight
    /// postpones a refill.
    #[test]
    fn spare_policy_consumed_replaced_never_two_reaped() {
        let l = launch("", "1");
        let mut pool = Spare::new(fast());
        let now = Instant::now;
        pool.maintain(want(&l), now());
        assert_eq!(pool.pid(), None, "no spare before a scene worker started");
        assert_eq!(pool.info(now(), false)["why"], "scenes not in use");

        // The first scene start: nothing to take, but scenes are in use from now on.
        assert!(pool.take(scene_spec(&l, "a"), now()).is_err(), "no spare to take yet");
        let mut busy = want(&l);
        busy.quiet = false;
        pool.maintain(busy, now());
        assert_eq!(pool.pid(), None, "a load or a transition postpones the spare");
        pool.maintain(want(&l), now());
        let p1 = pool.pid().expect("a spare once scenes are in use");
        for _ in 0..5 {
            pool.maintain(want(&l), now());
        }
        assert_eq!(pool.pid(), Some(p1), "never a second one");
        assert_eq!(pool.info(now(), false)["spawned"], 1);
        assert_eq!(pool.info(now(), false)["state"], "spare");

        // Taken by the next scene: the same process; the pool is empty until the next sync.
        let mut b = pool
            .take(scene_spec(&l, "b"), now())
            .expect("the spare is taken");
        assert_eq!(b.pid(), Some(p1));
        assert_eq!(b.spec().id, "b");
        assert_eq!(pool.pid(), None);
        pool.maintain(want(&l), now());
        let p2 = pool.pid().expect("replaced after the take");
        assert_ne!(p2, p1);
        assert_eq!(pool.info(now(), false)["adopted"], 1);
        b.stop();

        // A scene launched differently doesn't take it (and it stays).
        let other = launch("", "0");
        assert!(pool.take(scene_spec(&other, "c"), now()).is_err());
        assert_eq!(pool.pid(), Some(p2));
        // The launch changed (another environment): the stale one goes at once, so no scene can
        // take it; its replacement waits like any refill.
        let mut changed = want(&other);
        changed.quiet = false;
        pool.maintain(changed, now());
        assert_eq!(pool.pid(), None, "the stale spare is gone, the new one waits for quiet");
        wait_dead(p2);
        assert_eq!(pool.info(now(), false)["replaced"], 1);
        pool.maintain(want(&other), now());
        let p3 = pool.pid().expect("a spare with the new launch");
        assert_ne!(p3, p2);
        // `posix_spawn` returns mid-exec (the vfork parent resumes at the mm switch): the new
        // stack's environment shows a moment later.
        let t = Instant::now();
        let env = loop {
            let env = std::fs::read(format!("/proc/{p3}/environ")).unwrap();
            if !env.is_empty() || t.elapsed() > Duration::from_secs(2) {
                break env;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(
            env.split(|b| *b == 0)
                .any(|kv| kv == b"LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=0"),
            "the new spare has the new launch: {:?}",
            String::from_utf8_lossy(&env)
        );

        // Off → reaped at once; on again → back.
        let mut off = want(&other);
        off.enabled = false;
        pool.maintain(off, now());
        assert_eq!(pool.pid(), None);
        wait_dead(p3);
        pool.maintain(want(&other), now());
        let p4 = pool.pid().expect("on again");

        // Low VRAM (`stop` mode) → reaped; released → back.
        let mut low = want(&other);
        low.suspended = true;
        pool.maintain(low, now());
        assert_eq!(pool.pid(), None);
        assert_eq!(pool.info(now(), false)["why"], "low VRAM");
        wait_dead(p4);
        pool.maintain(want(&other), now());
        let p5 = pool.pid().expect("back after the low VRAM");

        // Scenes can't play (no assets) → reaped.
        let mut none = want(&other);
        none.launch = None;
        pool.maintain(none, now());
        assert_eq!(pool.pid(), None);
        wait_dead(p5);

        // `stop`: reaped, and scenes are no longer in use — no spare until the next scene.
        pool.maintain(want(&other), now());
        let p6 = pool.pid().expect("a spare");
        pool.stop("stop");
        wait_dead(p6);
        pool.maintain(want(&other), now());
        assert_eq!(pool.pid(), None, "no spare after a stop until a scene starts");
        let _ = pool.take(scene_spec(&other, "d"), now());
        pool.maintain(want(&other), now());
        let p7 = pool.pid().expect("a spare once a scene started again");
        drop(pool);
        wait_dead(p7);
    }

    /// No scene source hosted for `idle_after` → scenes are no longer in use: the spare goes.
    #[test]
    fn spare_goes_when_no_scene_was_hosted_for_a_while() {
        let l = launch("", "1");
        let mut t = fast();
        t.idle_after = Duration::from_millis(200);
        let mut pool = Spare::new(t);
        let _ = pool.take(scene_spec(&l, "a"), Instant::now());
        pool.maintain(want(&l), Instant::now());
        let p = pool.pid().expect("a spare");
        let mut idle = want(&l);
        idle.scenes_hosted = false;
        pool.maintain(idle.clone(), Instant::now());
        assert_eq!(pool.pid(), Some(p), "kept while a scene was hosted lately");
        std::thread::sleep(Duration::from_millis(250));
        pool.maintain(idle, Instant::now());
        assert_eq!(pool.pid(), None, "reaped after no scene for idle_after");
        wait_dead(p);
    }

    /// A rotation that holds a scene puts scenes in use before any scene worker started (the
    /// spare is ready for the run's first scene) and keeps them in use past `idle_after`; a
    /// video-only rotation starts none; a rotation that loses its last scene reaps the spare at
    /// once — but only once no scene shows; with no rotation the idle rule stands.
    #[test]
    fn spare_follows_the_scenes_in_the_rotation() {
        let l = launch("", "1");
        let mut t = fast();
        t.idle_after = Duration::from_millis(200);
        let mut pool = Spare::new(t);
        let now = Instant::now;
        let with = |rotation: Option<bool>, hosted: bool| {
            let mut w = want(&l);
            w.rotation = rotation;
            w.scenes_hosted = hosted;
            w
        };

        // A video-only rotation: none, and the probe says why.
        pool.maintain(with(Some(false), false), now());
        assert_eq!(pool.pid(), None);
        assert_eq!(pool.info(now(), false)["why"], "no scene in the rotation");
        assert_eq!(pool.info(now(), false)["rotation_scenes"], false);

        // A scene in the rotation, none played yet: a spare (still waiting for quiet first).
        let mut busy = with(Some(true), false);
        busy.quiet = false;
        pool.maintain(busy, now());
        assert_eq!(pool.pid(), None, "a load in flight postpones it");
        pool.maintain(with(Some(true), false), now());
        let p1 = pool.pid().expect("a spare before the rotation's first scene");
        assert_eq!(pool.info(now(), false)["in_use"], true);
        // Kept past idle_after while the rotation holds a scene, though none is hosted.
        std::thread::sleep(Duration::from_millis(250));
        pool.maintain(with(Some(true), false), now());
        assert_eq!(pool.pid(), Some(p1), "the rotation's scene is still coming");

        // The last scene leaves the rotation while one still shows: kept until it goes…
        pool.maintain(with(Some(false), true), now());
        assert_eq!(pool.pid(), Some(p1), "a scene still shows");
        // …then reaped at once, no idle wait.
        pool.maintain(with(Some(false), false), now());
        assert_eq!(pool.pid(), None, "reaped at once");
        assert_eq!(pool.info(now(), false)["why"], "no scene in the rotation");
        wait_dead(p1);

        // A scene added back: a spare again.
        pool.maintain(with(Some(true), false), now());
        let p2 = pool.pid().expect("the edit that adds a scene starts one");

        // The rotation goes (a single wallpaper replaced it): the idle rule, counted from the
        // last moment a scene was coming.
        pool.maintain(with(None, false), now());
        assert_eq!(pool.pid(), Some(p2), "kept within idle_after");
        std::thread::sleep(Duration::from_millis(250));
        pool.maintain(with(None, false), now());
        assert_eq!(pool.pid(), None, "reaped after idle_after with no rotation");
        wait_dead(p2);

        // Off still reaps a rotation's spare.
        pool.maintain(with(Some(true), false), now());
        let p3 = pool.pid().expect("a spare");
        let mut off = with(Some(true), false);
        off.enabled = false;
        pool.maintain(off, now());
        assert_eq!(pool.pid(), None);
        assert_eq!(pool.info(now(), false)["why"], "off");
        wait_dead(p3);
    }

    /// A spare that keeps dying is retried with a doubling backoff and never handed to a scene.
    #[test]
    fn failing_spares_back_off_and_are_never_taken() {
        let l = launch("crash_after_ms:30", "1");
        let mut pool = Spare::new(fast());
        let _ = pool.take(scene_spec(&l, "a"), Instant::now());
        let t0 = Instant::now();
        let mut pids = Vec::new();
        let mut taken = 0;
        while t0.elapsed() < Duration::from_millis(1500) {
            pool.maintain(want(&l), Instant::now());
            if let Some(p) = pool.pid()
                && !pids.contains(&p)
            {
                pids.push(p);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // A dead spare is never handed over (the take polls it first).
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(mut h) = pool.take(scene_spec(&l, "b"), Instant::now()) {
            taken += 1;
            h.stop();
        }
        let info = pool.info(Instant::now(), false);
        assert!(info["failed"].as_u64().unwrap() >= 3, "{info}");
        // backoff 50, 100, 200, 200, …: over 1.5 s ~8 spawns, not hundreds
        assert!(pids.len() <= 12, "{} spares in 1.5 s: {info}", pids.len());
        assert_eq!(taken, 0, "a spare that died isn't taken: {info}");
    }
}
