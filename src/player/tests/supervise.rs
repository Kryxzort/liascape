//! Task 16: the supervisor + the state snapshot, end to end. Every test spawns the real
//! binary **supervised** (`liascape-player serve --headless --outputs 640x360@60,320x180@60
//! --clock real --ao null`, no `--no-supervise`) with a temp `XDG_RUNTIME_DIR` /
//! `XDG_STATE_HOME`, crashes or stops the compositor child (`hello.pid`), and checks what
//! the restarted child shows. The guard kills the supervisor on drop (the child then gets
//! its `PR_SET_PDEATHSIG` SIGTERM; it is SIGKILLed if it lingers), every spawned process
//! has `PR_SET_PDEATHSIG(SIGKILL)` towards the test and `RLIMIT_CORE` 1 (the deliberate
//! crashes reach no core dump handler). Skips (prints `SKIP: …`) only without an EGL device or a
//! `transitions/` catalogue — fails instead under `LIASCAPE_REQUIRE_GPU=1` (`common::skip_gpu`).
//! One server at a time.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use common::{ClipSpec, ensure_clip, headless_gl};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_liascape-player");
static SERIAL: Mutex<()> = Mutex::new(());
static N: AtomicU32 = AtomicU32::new(0);
/// The brief: the restarted player answers `hello` within this.
const RESTART_BUDGET: Duration = Duration::from_millis(1500);
/// How long a test waits for a snapshot it needs on disk (a precondition — `wait_snapshot`
/// returns the moment it matches). Written 250 ms after a change, but `fsync`ed twice (file +
/// dir): under IO load (other builds; 4 fsync writers) that took > 1 s — the old 300 ms / 1 s
/// waits failed 11 of 14 runs there.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(20);
/// `liascape_player::supervise::TEST_CRASH_ENV` (black-box: spelled out).
const TEST_CRASH_ENV: &str = "LIASCAPE_PLAYER_TEST_CRASH";
/// `liascape_player::supervise::EXIT_GAVE_UP`.
const EXIT_GAVE_UP: i32 = 4;
/// `liascape_player::supervise::TEST_COMPOSITOR_WAIT_ENV` (black-box: spelled out).
const TEST_COMPOSITOR_WAIT_ENV: &str = "LIASCAPE_PLAYER_TEST_COMPOSITOR_WAIT_MS";

/// `LIASCAPE_REQUIRE_GPU=1` turns a skip into a failure (`common::skip_gpu`).
fn can_run() -> bool {
    headless_gl().is_some() && common::catalogue_dir().is_some()
}

fn new_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "liascape-sup-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("run")).unwrap();
    std::fs::create_dir_all(root.join("state")).unwrap();
    root
}

fn state_dir(root: &Path) -> PathBuf {
    root.join("state/liascape/liascape-player")
}

/// `PR_SET_PDEATHSIG(SIGKILL)` (no stray supervisor outlives an aborted test run) and no
/// core dump handling of the deliberate crashes: `RLIMIT_CORE` = 1 (inherited by the
/// children) makes the kernel skip a piped `core_pattern` entirely ("RLIMIT_CORE is set to
/// 1, aborting core") — with 0, systemd-coredump still runs and the desktop's crash handler
/// (DrKonqi) pops a notification per crash (measured).
fn guard(c: &mut Command) {
    use std::os::unix::process::CommandExt;
    // Task 8: hermetic VRAM — the low-VRAM rule never sees this machine's real GPU (a test
    // that drives it sets `fake:<file>` after this).
    c.env("LIASCAPE_PLAYER_VRAM_PROBE", "none");
    unsafe {
        c.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            let one = libc::rlimit {
                rlim_cur: 1,
                rlim_max: 1,
            };
            libc::setrlimit(libc::RLIMIT_CORE, &one);
            Ok(())
        });
    }
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

struct Sup {
    child: Option<Child>,
    root: PathBuf,
    sock: PathBuf,
    /// The compositor child's pid (from `hello`).
    pid: u32,
    _serial: Option<MutexGuard<'static, ()>>,
}

impl Sup {
    fn start(extra: &[&str]) -> Option<Sup> {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        if !can_run() {
            return None;
        }
        Some(Sup::spawn_in(new_root(), extra, &[], Some(serial), true))
    }

    fn spawn_in(
        root: PathBuf,
        extra: &[&str],
        env: &[(&str, &str)],
        serial: Option<MutexGuard<'static, ()>>,
        wait_up: bool,
    ) -> Sup {
        let mut c = Command::new(BIN);
        guard(&mut c);
        c.args([
            "serve",
            "--headless",
            "--outputs",
            "640x360@60,320x180@60",
            "--clock",
            "real",
            "--ao",
            "null",
        ])
        .args(extra)
        .env("XDG_RUNTIME_DIR", root.join("run"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env_remove(TEST_CRASH_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            std::fs::File::create(root.join("stderr.log")).unwrap(),
        ));
        for (k, v) in env {
            c.env(k, v);
        }
        let child = c.spawn().expect("spawn liascape-player serve");
        let sock = root.join("run/liascape/liascape-player.sock");
        let mut s = Sup {
            child: Some(child),
            root,
            sock,
            pid: 0,
            _serial: serial,
        };
        if wait_up {
            let t = Instant::now();
            loop {
                if let Some(h) = s.hello() {
                    s.pid = h["pid"].as_u64().unwrap() as u32;
                    break;
                }
                if let Some(st) = s.child.as_mut().unwrap().try_wait().unwrap() {
                    panic!("supervisor exited early ({st}): {}", s.stderr());
                }
                assert!(
                    t.elapsed() < Duration::from_secs(15),
                    "never came up: {}",
                    s.stderr()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        s
    }

    fn supervisor_pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(self.root.join("stderr.log")).unwrap_or_default()
    }

    /// `hello` over a fresh connection, or `None` if nothing answers right now.
    fn hello(&self) -> Option<Value> {
        let st = UnixStream::connect(&self.sock).ok()?;
        st.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        let mut c = Client::from(st);
        let r = c.call("hello", json!({}))?;
        (r["ok"] == json!(true)).then(|| r["result"].clone())
    }

    fn client(&self) -> Client {
        let st = UnixStream::connect(&self.sock).expect("connect");
        st.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        Client::from(st)
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let t = Instant::now();
        while t.elapsed() < timeout {
            if let Some(st) = self.child.as_mut().unwrap().try_wait().unwrap() {
                return Some(st);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    /// Every record of the shared event log (the children's and the supervisor's).
    fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(state_dir(&self.root).join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    fn kinds(&self, kind: &str) -> Vec<Value> {
        self.events()
            .into_iter()
            .filter(|e| e["kind"] == kind)
            .collect()
    }

    fn snapshot(&self) -> Option<Value> {
        let b = std::fs::read(state_dir(&self.root).join("snapshot.json")).ok()?;
        serde_json::from_slice(&b).ok()
    }

    /// Poll the snapshot file until `pred` holds (≤ `within`).
    fn wait_snapshot(&self, within: Duration, pred: impl Fn(&Value) -> bool) -> Value {
        let t = Instant::now();
        loop {
            if let Some(s) = self.snapshot()
                && pred(&s)
            {
                return s;
            }
            assert!(
                t.elapsed() < within,
                "snapshot never matched within {within:?}: {:?}",
                self.snapshot()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// `kill -<sig>` the compositor child; wait until `hello` answers from a new pid.
    /// Returns the new hello and how long that took.
    fn crash(&mut self, sig: i32) -> (Value, Duration) {
        let old = self.pid;
        let t = Instant::now();
        assert_eq!(unsafe { libc::kill(old as i32, sig) }, 0, "kill {old}");
        loop {
            if let Some(h) = self.hello()
                && h["pid"].as_u64() != Some(old as u64)
            {
                self.pid = h["pid"].as_u64().unwrap() as u32;
                return (h, t.elapsed());
            }
            assert!(
                t.elapsed() < Duration::from_secs(10),
                "no restarted player 10 s after signal {sig}: {}",
                self.stderr()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Sup {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        // The child got SIGTERM (PDEATHSIG) and quits cleanly; don't let it linger.
        let t = Instant::now();
        while self.pid != 0 && alive(self.pid) && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        if self.pid != 0 && alive(self.pid) {
            unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Client {
    w: UnixStream,
    r: BufReader<UnixStream>,
    id: u64,
}

impl From<UnixStream> for Client {
    fn from(w: UnixStream) -> Client {
        let r = BufReader::new(w.try_clone().unwrap());
        Client { w, r, id: 0 }
    }
}

impl Client {
    fn call(&mut self, cmd: &str, args: Value) -> Option<Value> {
        self.id += 1;
        let line = json!({"id": self.id, "cmd": cmd, "args": args}).to_string();
        self.w.write_all(line.as_bytes()).ok()?;
        self.w.write_all(b"\n").ok()?;
        loop {
            let mut buf = String::new();
            if self.r.read_line(&mut buf).ok()? == 0 {
                return None;
            }
            let m: Value = serde_json::from_str(&buf).ok()?;
            if m.get("event").is_none() && m["id"] == json!(self.id) {
                return Some(m);
            }
        }
    }

    fn ok(&mut self, cmd: &str, args: Value) -> Value {
        let r = self
            .call(cmd, args.clone())
            .unwrap_or_else(|| panic!("no reply to {cmd} {args}"));
        assert_eq!(r["ok"], json!(true), "{cmd} {args} failed: {r}");
        r["result"].clone()
    }

    fn create(&mut self, props: Value) -> String {
        self.ok("create", json!({"kind": "source", "props": props}))["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn show(&mut self, layer: &str, id: &str) {
        self.ok(
            "set",
            json!({"path": format!("{layer}.content"), "value": id}),
        );
    }

    fn get(&mut self, path: &str) -> Value {
        self.ok("get", json!({ "path": path }))["value"].clone()
    }

    fn state(&mut self) -> Value {
        self.ok("state", json!({}))
    }

    fn logs(&mut self, prefix: &str) -> Vec<Value> {
        self.ok("logs", json!({"kind_prefix": prefix}))["events"]
            .as_array()
            .unwrap()
            .clone()
    }
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// Source nodes in a `state.graph` (recognised by `gain_effective_db`), id → node.
fn sources(state: &Value) -> Vec<(String, Value)> {
    state["graph"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, n)| n.get("gain_effective_db").is_some())
        .map(|(id, n)| (id.clone(), n.clone()))
        .collect()
}

fn content(state: &Value, conn: &str) -> String {
    state["graph"][format!("lay:{conn}:main")]["content"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

/// Poll `state` until `pred` holds (≤ `within`), returning it.
fn wait_state(c: &mut Client, within: Duration, pred: impl Fn(&Value) -> bool) -> Value {
    let t = Instant::now();
    loop {
        let st = c.state();
        if pred(&st) {
            return st;
        }
        assert!(t.elapsed() < within, "state never matched: {st}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn snap_has_path(snap: &Value, path: &str) -> bool {
    snap["sources"]
        .as_object()
        .is_some_and(|m| m.values().any(|s| s["path"] == path))
}

fn frame_index() -> PathBuf {
    ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 })
}

// ---------------------------------------------------------------- tests

/// The brief's test: a SEGV of the compositor → the supervisor restarts it with
/// `--restore` → within 1.5 s `hello` answers from a new pid, the same clip plays on both
/// outputs from ≥ the saved position, and the child logged `supervisor.restart` with the
/// signal.
#[test]
fn crash_restores() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let clip = frame_index();
    let mut c = sup.client();
    let h = c.ok("hello", json!({}));
    assert_eq!(h["supervisor_pid"], json!(sup.supervisor_pid()), "{h}");
    assert_eq!(h["restart"], Value::Null);
    let id = c.create(json!({"path": s(&clip), "loop": true, "position": 2.0}));
    c.ok("set", json!({"path": "lay:*:main.content", "value": id}));
    // Precondition: the debounced snapshot (250 ms after the first change) is on disk.
    sup.wait_snapshot(SNAPSHOT_WAIT, |sn| snap_has_path(sn, s(&clip)));
    drop(c);

    let old = sup.pid;
    let (h2, latency) = sup.crash(libc::SIGSEGV);
    println!("restart latency (SIGSEGV → hello from the new child): {latency:?}");
    assert!(
        latency <= RESTART_BUDGET,
        "hello answered {latency:?} after the crash (budget {RESTART_BUDGET:?})"
    );
    assert_ne!(h2["pid"], json!(old));
    assert_eq!(
        h2["supervisor_pid"],
        json!(sup.supervisor_pid()),
        "same supervisor"
    );
    assert_eq!(h2["restart"]["signal"], json!(libc::SIGSEGV), "{h2}");

    let mut c = sup.client();
    let st = wait_state(&mut c, Duration::from_secs(5), |st| {
        sources(st)
            .iter()
            .any(|(_, n)| n["path"] == s(&clip) && n["ready"] == json!(true))
    });
    let (nid, node) = sources(&st)
        .into_iter()
        .find(|(_, n)| n["path"] == s(&clip))
        .unwrap();
    let pos = node["time_pos"].as_f64().unwrap();
    println!("restored {nid}: time_pos {pos:.3} s (saved position ≥ 2.0)");
    assert!(pos >= 2.0, "position {pos} < 2.0: {node}");
    assert_eq!(node["paused"], json!(false));
    assert_eq!(node["loop"], json!(true));
    for conn in ["VIRTUAL-1", "VIRTUAL-2"] {
        assert_eq!(content(&st, conn), nid, "{conn} shows the restored clip");
    }
    let r = c.logs("supervisor.restart");
    assert_eq!(r.len(), 1, "{r:?}");
    assert_eq!(r[0]["signal"], json!(libc::SIGSEGV), "{:?}", r[0]);
    assert_eq!(r[0]["count"], json!(1));
    assert_eq!(r[0]["prev_pid"], json!(old));
    assert!(r[0]["since_ms"].as_f64().unwrap() < RESTART_BUDGET.as_millis() as f64);
    let restored = c.logs("snapshot.restored");
    assert_eq!(restored.len(), 1, "{restored:?}");
    assert_eq!(restored[0]["sources"], json!(1));
    // The supervisor logged the death in the shared event log.
    let died = sup.kinds("supervisor.child_exited");
    assert!(
        died.iter()
            .any(|e| e["pid"] == json!(old) && e["signal"] == json!(libc::SIGSEGV)),
        "{died:?}"
    );
    // Audio-follows-picture plumbing: the restored (audible) clip ramps in to 0 dB.
    let st = wait_state(&mut c, Duration::from_secs(2), |st| {
        st["graph"][&nid]["gain_effective_db"].as_f64() == Some(0.0)
    });
    assert_eq!(st["graph"][&nid]["gain"]["anticlick"], json!(0.0));
}

/// Task 16b leftover: SIGKILLing the supervisor must orphan nothing — its
/// `PR_SET_PDEATHSIG(SIGTERM)` (set between fork and exec) fires from the kernel's own
/// notice of the parent's death, not from any cleanup code of ours. Asserted directly
/// (no fallback kill anywhere in this test masking a regression), in two parts:
/// - **the signal, within 300 ms** — the bound that is the point: the child logs
///   `player.quitting {why: "signal"}` stamped ≤ 300 ms after the SIGKILL (nothing else signals
///   it: its supervisor is dead and forwarded nothing). Measured 3.6–10.3 ms in 57 runs under
///   CPU and IO load.
/// - **the exit, on its own** — no kill of ours. That is the clean quit (stop, teardown, the
///   final snapshot written + `fsync`ed) and takes real time under IO load: 0.4–9.8 s, twice
///   > 10 s, with 4 fsync writers on the same disk (the old 300 ms bound on the whole exit failed
///   there and at load ~25 with other builds running). Bounded by [`ORPHAN_EXIT_WITHIN`].
#[test]
fn supervisor_sigkill_reaps_child_fast() {
    let Some(sup) = Sup::start(&[]) else {
        return;
    };
    let child = sup.pid;
    assert!(alive(child), "precondition: the compositor is up");
    let sup_pid = sup.supervisor_pid();
    let kill_wall = wall_s();
    assert_eq!(
        unsafe { libc::kill(sup_pid as i32, libc::SIGKILL) },
        0,
        "kill -9 {sup_pid}"
    );
    let t = Instant::now();
    let quitting = loop {
        if let Some(e) = sup
            .kinds("player.quitting")
            .into_iter()
            .find(|e| e["why"] == "signal")
        {
            break e;
        }
        assert!(
            t.elapsed() < ORPHAN_EXIT_WITHIN,
            "compositor pid {child} never logged player.quitting {{why: signal}} after \
             SIGKILLing the supervisor (pid {sup_pid}) — no PR_SET_PDEATHSIG SIGTERM reached it"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    let signal_ms = (wall_of(quitting["t_wall"].as_str().unwrap()) - kill_wall) * 1000.0;
    assert!(
        signal_ms <= 300.0,
        "the child's SIGTERM came {signal_ms:.1} ms after SIGKILLing the supervisor (pid \
         {sup_pid}) — PR_SET_PDEATHSIG should deliver it almost immediately"
    );
    while alive(child) && t.elapsed() < ORPHAN_EXIT_WITHIN {
        std::thread::sleep(Duration::from_millis(5));
    }
    let elapsed = t.elapsed();
    assert!(
        !alive(child),
        "compositor pid {child} still alive {elapsed:?} after SIGKILLing the supervisor \
         (pid {sup_pid}), {signal_ms:.1} ms after its PDEATHSIG SIGTERM"
    );
    println!(
        "child signalled {signal_ms:.1} ms and gone {elapsed:?} after SIGKILLing the supervisor"
    );
}

/// How long an orphaned child's clean quit may take (`supervisor_sigkill_reaps_child_fast`):
/// its final snapshot is `fsync`ed, which took up to > 10 s under IO load.
const ORPHAN_EXIT_WITHIN: Duration = Duration::from_secs(30);

/// Now, as seconds of the UTC day (to compare with an event's `t_wall`).
fn wall_s() -> f64 {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    (d.as_secs() % 86_400) as f64 + d.subsec_nanos() as f64 / 1e9
}

/// An event's `t_wall` (`2026-10-27T10:22:10.875123Z`) as seconds of its UTC day.
fn wall_of(t: &str) -> f64 {
    let hms = &t[11..t.len() - 1];
    let mut it = hms.split(':');
    let h: f64 = it.next().unwrap().parse().unwrap();
    let m: f64 = it.next().unwrap().parse().unwrap();
    let s: f64 = it.next().unwrap().parse().unwrap();
    h * 3600.0 + m * 60.0 + s
}

/// A clean exit is never restarted: `quit`, SIGTERM to the supervisor (forwarded), and
/// SIGTERM to the child all end supervision with exit 0.
#[test]
fn clean_quit_not_restarted() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let mut c = sup.client();
    c.create(json!({"kind": "color", "color": [255, 0, 0]}));
    c.ok("quit", json!({}));
    let st = sup
        .wait_exit(Duration::from_secs(5))
        .expect("no exit after quit");
    assert_eq!(st.code(), Some(0), "{st}: {}", sup.stderr());
    assert!(sup.kinds("supervisor.restart").is_empty());
    assert!(sup.kinds("supervisor.child_exited").is_empty());
    assert!(!sup.sock.exists(), "socket removed");
    let serial = sup._serial.take();
    drop(sup);

    // SIGTERM to the supervisor: forwarded, the child quits, exit 0.
    let mut sup = Sup::spawn_in(new_root(), &[], &[], serial, true);
    let child = sup.pid;
    unsafe { libc::kill(sup.supervisor_pid() as i32, libc::SIGTERM) };
    let st = sup
        .wait_exit(Duration::from_secs(5))
        .expect("no exit on SIGTERM");
    assert_eq!(st.code(), Some(0), "{st}: {}", sup.stderr());
    assert!(!alive(child), "the child is gone with it");
    assert!(
        sup.kinds("player.exit").len() == 1,
        "the child exited cleanly"
    );
    let serial = sup._serial.take();
    drop(sup);

    // SIGTERM to the child: a clean quit (exit 0) → supervision ends, no restart.
    let mut sup = Sup::spawn_in(new_root(), &[], &[], serial, true);
    unsafe { libc::kill(sup.pid as i32, libc::SIGTERM) };
    let st = sup.wait_exit(Duration::from_secs(5)).expect("no exit");
    assert_eq!(st.code(), Some(0), "{st}: {}", sup.stderr());
    assert!(sup.kinds("supervisor.restart").is_empty());
}

/// Test knob `LIASCAPE_PLAYER_TEST_CRASH=startup`: every child aborts at startup → 5 restarts
/// (the first three with `--restore`, then without), then `supervisor.giving_up` and exit
/// 4.
#[test]
fn gives_up_after_5_in_60s() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let root = new_root();
    let t = Instant::now();
    let mut sup = Sup::spawn_in(
        root,
        &[],
        &[(TEST_CRASH_ENV, "startup")],
        Some(serial),
        false,
    );
    let st = sup
        .wait_exit(Duration::from_secs(30))
        .expect("the supervisor never gave up");
    println!("gave up after {:?}", t.elapsed());
    assert_eq!(st.code(), Some(EXIT_GAVE_UP), "{st}: {}", sup.stderr());
    assert!(st.signal().is_none());
    let exited = sup.kinds("supervisor.child_exited");
    assert_eq!(exited.len(), 6, "the first child + 5 restarts: {exited:?}");
    assert!(exited.iter().all(|e| e["signal"] == json!(libc::SIGABRT)));
    let restarts = sup.kinds("supervisor.restart");
    let counts: Vec<u64> = restarts
        .iter()
        .map(|e| e["count"].as_u64().unwrap())
        .collect();
    assert_eq!(counts, [1, 2, 3, 4, 5], "{restarts:?}");
    let restore: Vec<bool> = restarts
        .iter()
        .map(|e| e["restore"].as_bool().unwrap())
        .collect();
    assert_eq!(restore, [true, true, true, false, false]);
    assert!(restarts.iter().all(|e| e["signal"] == json!(libc::SIGABRT)));
    let gave_up = sup.kinds("supervisor.giving_up");
    assert_eq!(gave_up.len(), 1, "{gave_up:?}");
    assert_eq!(gave_up[0]["restarts"], json!(5));
    assert_eq!(gave_up[0]["comp"], json!("supervisor"));
    assert!(
        t.elapsed() < Duration::from_secs(15),
        "restarts are immediate"
    );
    assert!(sup.stderr().contains("giving up"), "{}", sup.stderr());
}

/// Task 16b: "compositor/EGL not available yet" (here: Wayland mode, a bogus
/// `WAYLAND_DISPLAY`) is its own startup-failure class, distinct from "already running" —
/// the supervisor retries it with backoff instead of passing the exit code straight
/// through. `TEST_COMPOSITOR_WAIT_ENV` shortens the real 30 s budget so the test doesn't
/// really wait that long: with it at 1600 ms the schedule is 500 ms (waited 500 ≤ 1600),
/// 1000 ms (waited 1500 ≤ 1600), then the next 2000 ms would push the total to 3500 ms —
/// past the budget — so it gives up after exactly those two retries. Not `Sup` (its
/// `--headless` is hardcoded; this needs the Wayland path), so it drives the raw process
/// and the shared event log directly, the way `tests/api.rs`'s own missing-compositor
/// test does for the un-supervised case.
#[test]
fn gives_up_without_compositor_after_backoff() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let root = new_root();
    let mut c = Command::new(BIN);
    guard(&mut c);
    c.args(["serve", "--ao", "null"])
        .env("XDG_RUNTIME_DIR", root.join("run"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("WAYLAND_DISPLAY", "no-such-wayland-9")
        .env(TEST_COMPOSITOR_WAIT_ENV, "1600")
        .env_remove("WAYLAND_SOCKET")
        .stdin(Stdio::null());
    let t = Instant::now();
    let out = c.output().expect("run liascape-player");
    let elapsed = t.elapsed();
    println!("gave up without a compositor after {elapsed:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(EXIT_GAVE_UP), "{err}");
    assert!(elapsed < Duration::from_secs(10), "no hang: {err}");

    let events: Vec<Value> = std::fs::read_to_string(state_dir(&root).join("events.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let waiting: Vec<&Value> = events
        .iter()
        .filter(|e| e["kind"] == "supervisor.waiting_for_compositor")
        .collect();
    assert_eq!(waiting.len(), 2, "{events:?}");
    let delays: Vec<f64> = waiting
        .iter()
        .map(|e| e["delay_ms"].as_f64().unwrap())
        .collect();
    assert_eq!(delays, [500.0, 1000.0], "the backoff doubles: {waiting:?}");
    let gave_up: Vec<&Value> = events
        .iter()
        .filter(|e| e["kind"] == "supervisor.giving_up")
        .collect();
    assert_eq!(gave_up.len(), 1, "{events:?}");
    assert_eq!(
        gave_up[0]["reason"],
        json!("no_compositor"),
        "{:?}",
        gave_up[0]
    );
    assert!(err.contains("compositor"), "giving-up message: {err}");
    // Never counted against the real crash-loop budget: no `supervisor.restart` and no
    // `supervisor.child_exited` (those are the crash-loop's own events, R73) at all.
    assert!(
        !events
            .iter()
            .any(|e| e["kind"] == "supervisor.restart" || e["kind"] == "supervisor.child_exited"),
        "{events:?}"
    );
    drop(serial);
}

/// M9 (final review): a SIGTERM while the supervisor sits in its no-compositor backoff
/// ends it at once (exit 0, `supervisor.stopped`) — never a multi-second "hung" stop.
#[test]
fn sigterm_during_compositor_backoff_exits_at_once() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let root = new_root();
    let mut c = Command::new(BIN);
    guard(&mut c);
    c.args(["serve", "--ao", "null"])
        .env("XDG_RUNTIME_DIR", root.join("run"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("WAYLAND_DISPLAY", "no-such-wayland-9")
        .env(TEST_COMPOSITOR_WAIT_ENV, "60000")
        .env_remove("WAYLAND_SOCKET")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = c.spawn().expect("spawn liascape-player");
    let log = state_dir(&root).join("events.jsonl");
    let t = Instant::now();
    loop {
        let waiting = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| e["kind"] == "supervisor.waiting_for_compositor")
            .count();
        // The second wait is 1 s long: SIGTERM lands inside it.
        if waiting >= 2 {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_secs(10),
            "never entered the backoff"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(100));
    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    let t = Instant::now();
    let st = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break st;
        }
        assert!(
            t.elapsed() < Duration::from_millis(500),
            "SIGTERM during the backoff must end the supervisor at once"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    println!("supervisor gone {:?} after SIGTERM", t.elapsed());
    assert_eq!(st.code(), Some(0), "{st:?}");
    let stopped = std::fs::read_to_string(&log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .any(|e| e["kind"] == "supervisor.stopped");
    assert!(stopped, "supervisor.stopped logged");
    drop(serial);
}

/// A corrupt or unknown-version snapshot → `snapshot.invalid {reason}`, an empty player
/// (and the file moved aside) — never a crash.
#[test]
fn corrupt_snapshot_starts_empty() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let mut serial = Some(serial);
    for (bytes, want) in [
        (&b"{not json"[..], "not JSON"),
        (
            &br#"{"version": 99, "sources": {}}"#[..],
            "unknown version 99",
        ),
    ] {
        let root = new_root();
        std::fs::create_dir_all(state_dir(&root)).unwrap();
        std::fs::write(state_dir(&root).join("snapshot.json"), bytes).unwrap();
        let mut sup = Sup::spawn_in(root, &["--restore"], &[], serial.take(), true);
        let mut c = sup.client();
        let inv = c.logs("snapshot.invalid");
        assert_eq!(inv.len(), 1, "{inv:?}");
        let reason = inv[0]["reason"].as_str().unwrap();
        assert!(reason.contains(want), "{reason}");
        assert!(sources(&c.state()).is_empty(), "started empty");
        assert!(state_dir(&sup.root).join("snapshot.invalid.json").exists());
        // It keeps working, and the next snapshot is a valid (empty) one.
        let id = c.create(json!({"kind": "color", "color": [0, 255, 0]}));
        c.ok("set", json!({"path": "lay:*:main.content", "value": id}));
        let sn = sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
            sn["outputs"]["VIRTUAL-1"]["content"].is_string()
        });
        assert_eq!(sn["version"], json!(1));
        // A crash now restores that one: no crash loop over the bad file.
        drop(c);
        sup.crash(libc::SIGKILL);
        let mut c = sup.client();
        assert!(c.logs("snapshot.invalid").is_empty());
        let st = c.state();
        assert_eq!(sources(&st).len(), 1, "{st}");
        serial = sup._serial.take();
    }
}

/// A transition in flight is saved as its target B: after a crash mid-effect the
/// restarted player shows B on every output it covered — no effect, no transition, no A.
#[test]
fn transition_in_flight_restores_as_b() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let clip = frame_index();
    let mut c = sup.client();
    let red = c.create(json!({"kind": "color", "color": [255, 0, 0]}));
    c.ok("set", json!({"path": "lay:*:main.content", "value": red}));
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&clip), "loop": true},
               "effect_id": "fade", "duration_ms": 8000, "method": "full-live"}),
    );
    let b = r["to"].as_str().unwrap().to_string();
    wait_state(&mut c, Duration::from_secs(5), |st| {
        st["transitions"][0]["phase"] == "running"
    });
    let sn = sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
        sn["sources"]
            .as_object()
            .is_some_and(|m| m.values().any(|s| s["transition_target"] == json!(true)))
    });
    assert!(snap_has_path(&sn, s(&clip)), "{sn}");
    assert_eq!(sn["sources"].as_object().unwrap().len(), 1, "only B: {sn}");
    drop(c);
    sup.crash(libc::SIGSEGV);

    let mut c = sup.client();
    let st = wait_state(&mut c, Duration::from_secs(5), |st| {
        sources(st)
            .iter()
            .any(|(_, n)| n["path"] == s(&clip) && n["ready"] == json!(true))
    });
    assert_eq!(st["transitions"], json!([]), "nothing in flight");
    assert!(
        !st["graph"]
            .as_object()
            .unwrap()
            .values()
            .any(|n| n.get("effect_id").is_some()),
        "no effect node: {st}"
    );
    let srcs = sources(&st);
    assert_eq!(srcs.len(), 1, "only B: {srcs:?}");
    let (nb, node) = &srcs[0];
    assert_eq!(node["path"], json!(s(&clip)));
    assert_eq!(node["paused"], json!(false), "B plays");
    assert!(
        node["gain"].get("xfade").is_none(),
        "no transition gain: {node}"
    );
    for conn in ["VIRTUAL-1", "VIRTUAL-2"] {
        assert_eq!(&content(&st, conn), nb, "{conn} shows B ({b} before)");
    }
}

/// The parked wallpaper survives a restart: (1) a saved connector that's missing after
/// the restart parks what only it showed, and shows it again when it appears; (2) a
/// wallpaper parked because no output was left is shown on the outputs that exist after
/// the restart.
#[test]
fn parked_restores_parked() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let clip = frame_index();
    let mut c = sup.client();
    let a = c.create(json!({"path": s(&clip), "loop": true}));
    c.ok("set", json!({"path": "lay:*:main.content", "value": a}));
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 640, "height": 360}),
    );
    let x = c.create(json!({"kind": "color", "color": [0, 255, 0]}));
    c.show("lay:VIRTUAL-3:main", &x);
    sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
        let id = sn["outputs"]["VIRTUAL-3"]["content"].as_str().unwrap_or("");
        sn["sources"][id]["kind"] == "color"
    });
    drop(c);
    sup.crash(libc::SIGSEGV);

    // VIRTUAL-3 isn't there after the restart: its green is parked, for VIRTUAL-3.
    let mut c = sup.client();
    let st = c.state();
    let green = |n: &Value| n["kind"] == "color" && n["color"] == json!([0.0, 255.0, 0.0]);
    let (xp, xnode) = sources(&st)
        .into_iter()
        .find(|(_, n)| green(n))
        .expect("green");
    assert_eq!(st["parked"], json!(xp), "{st}");
    assert_eq!(xnode["paused"], json!(true), "parked = paused");
    let restored = c.logs("snapshot.restored");
    assert_eq!(restored[0]["parked"], json!(xp));
    let ap = content(&st, "VIRTUAL-1");
    assert_eq!(st["graph"][&ap]["path"], json!(s(&clip)));
    assert_eq!(content(&st, "VIRTUAL-2"), ap);
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 640, "height": 360}),
    );
    let st = wait_state(&mut c, Duration::from_secs(1), |st| {
        st["graph"][&xp]["paused"] == json!(false)
    });
    assert_eq!(
        content(&st, "VIRTUAL-3"),
        xp,
        "its own connector shows it again"
    );
    assert_eq!(st["parked"], Value::Null);
    assert_eq!(content(&st, "VIRTUAL-1"), ap, "the others are untouched");

    // (2) No output left → the last wallpaper (green, on VIRTUAL-3) is parked.
    for o in ["VIRTUAL-1", "VIRTUAL-2", "VIRTUAL-3"] {
        c.ok("headless.remove_output", json!({ "name": o }));
    }
    let st = c.state();
    assert_eq!(st["parked"], json!(xp), "{st}");
    sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
        sn["outputs"].as_object().is_some_and(|o| o.is_empty()) && sn["parked"]["id"].is_string()
    });
    drop(c);
    sup.crash(libc::SIGSEGV);
    let mut c = sup.client();
    let st = c.state();
    assert_eq!(
        st["parked"],
        Value::Null,
        "outputs exist again: shown, not parked"
    );
    let g1 = content(&st, "VIRTUAL-1");
    assert!(green(&st["graph"][&g1]), "{st}");
    assert_eq!(content(&st, "VIRTUAL-2"), g1);
    assert_eq!(st["graph"][&g1]["paused"], json!(false));
}

/// Output props persist: a re-plugged connector gets its `layer` back, and a restart
/// restores every output's props (present ones and remembered ones).
#[test]
fn output_props_survive_replug() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let mut c = sup.client();
    c.ok(
        "set",
        json!({"path": "out:VIRTUAL-1.layer", "value": "top"}),
    );
    c.ok(
        "set",
        json!({"path": "out:VIRTUAL-2.layer", "value": "overlay"}),
    );
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-2", "width": 320, "height": 180}),
    );
    assert_eq!(
        c.get("out:VIRTUAL-2.layer"),
        json!("overlay"),
        "replug keeps it"
    );
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-9", "width": 64, "height": 64}),
    );
    assert_eq!(
        c.get("out:VIRTUAL-9.layer"),
        json!("background"),
        "a new one: default"
    );
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
        sn["output_props"]["VIRTUAL-2"]["layer"] == "overlay"
            && sn["outputs"]["VIRTUAL-1"]["props"]["layer"] == "top"
    });
    drop(c);
    sup.crash(libc::SIGSEGV);
    let mut c = sup.client();
    assert_eq!(c.get("out:VIRTUAL-1.layer"), json!("top"));
    assert_eq!(
        c.get("out:VIRTUAL-2.layer"),
        json!("overlay"),
        "present again after the restart: its remembered layer"
    );
}

/// Phase 2 Task 5: a scene shown when the compositor crashes is saved at its scene time
/// (`time_pos`, refreshed while it plays) and restored there by the restarted child, on a
/// fresh worker (the old one died with its compositor: PDEATHSIG).
#[test]
fn scene_snapshot_restores_at_position() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let mut sup = Sup::spawn_in(
        new_root(),
        &[],
        &[("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES", "1")],
        Some(serial),
        true,
    );
    let dir = common::synthetic_scene(
        "sup-scene",
        &liascape_player::scene::synthetic::SyntheticSpec::default(),
    );
    let mut c = sup.client();
    let id = c.create(json!({"kind": "scene", "path": s(&dir), "position": 3.0}));
    c.ok("set", json!({"path": "lay:*:main.content", "value": id}));
    wait_state(&mut c, Duration::from_secs(10), |st| {
        st["graph"][&id]["time_pos"].as_f64().unwrap_or(0.0) >= 4.5
    });
    let old_worker = c.state()["workers"][0]["pid"].as_u64().expect("a worker");
    // The periodic refresh (2 s while a scene plays) saved a position past the start.
    let snap = sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
        sn["sources"].as_object().is_some_and(|m| {
            m.values()
                .any(|s| s["path"] == s_json(&dir) && s["position"].as_f64().unwrap_or(0.0) >= 4.0)
        })
    });
    let saved = snap["sources"]
        .as_object()
        .unwrap()
        .values()
        .find(|s| s["path"] == s_json(&dir))
        .unwrap()
        .clone();
    assert_eq!(saved["kind"], json!("scene"), "{saved}");
    assert_eq!(saved["playing"], json!(true), "{saved}");
    let saved_pos = saved["position"].as_f64().unwrap();
    drop(c);
    let (_h, latency) = sup.crash(libc::SIGSEGV);
    println!("restart latency {latency:?}; saved scene position {saved_pos:.3}");
    let mut c = sup.client();
    let st = wait_state(&mut c, Duration::from_secs(10), |st| {
        sources(st)
            .iter()
            .any(|(_, n)| n["path"] == s_json(&dir) && n["ready"] == json!(true))
    });
    let (nid, node) = sources(&st)
        .into_iter()
        .find(|(_, n)| n["path"] == s_json(&dir))
        .unwrap();
    assert_eq!(node["kind"], json!("scene"), "{node}");
    let pos = node["time_pos"].as_f64().unwrap();
    println!("restored {nid}: time_pos {pos:.3} (saved {saved_pos:.3})");
    assert!(
        (pos - saved_pos).abs() <= 2.0,
        "restored at {pos}, saved {saved_pos}"
    );
    for conn in ["VIRTUAL-1", "VIRTUAL-2"] {
        assert_eq!(content(&st, conn), nid, "{conn} shows the restored scene");
    }
    let w = &st["workers"][0];
    let new_worker = w["pid"].as_u64().expect("a new worker");
    assert_ne!(new_worker, old_worker);
    assert!(
        !alive(old_worker as u32),
        "the old worker died with its compositor"
    );
}

fn s_json(p: &Path) -> Value {
    json!(s(p))
}

fn png_rgb(path: &Path, x: u32, y: u32) -> [u8; 3] {
    let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
    let mut rd = dec.read_info().unwrap();
    let mut buf = vec![0; rd.output_buffer_size().unwrap()];
    let info = rd.next_frame(&mut buf).unwrap();
    let i = ((y * info.width + x) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2]]
}

/// Phase 2 Task 10: a broken scene (its every worker crashed before a first frame: past the
/// restart budget, showing its preview) is saved `broken: true`, and the restarted compositor
/// restores it as its preview — `broken` again, **no worker** (none spawned for it), the
/// preview on every output — instead of crash-looping a fresh worker through a new budget.
#[test]
fn broken_scene_restores_as_preview() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let mut sup = Sup::spawn_in(
        new_root(),
        &[],
        &[("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES", "1")],
        Some(serial),
        true,
    );
    let png = common::solid_png("sup-t10-preview", [0, 255, 0]);
    let dir = common::synthetic_scene(
        "sup-t10-broken",
        &liascape_player::scene::synthetic::SyntheticSpec {
            crash_after_ms: Some(0),
            ..Default::default()
        },
    );
    let mut c = sup.client();
    let id = c.create(json!({"kind": "scene", "path": s(&dir), "preview": s(&png)}));
    c.ok("set", json!({"path": "lay:*:main.content", "value": id}));
    wait_state(&mut c, Duration::from_secs(20), |st| {
        st["graph"][&id]["broken"] == json!(true)
    });
    let snap = sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
        sn["sources"]
            .as_object()
            .is_some_and(|m| m.values().any(|s| s["path"] == s_json(&dir) && s["broken"] == true))
    });
    let saved = snap["sources"]
        .as_object()
        .unwrap()
        .values()
        .find(|s| s["path"] == s_json(&dir))
        .unwrap()
        .clone();
    assert_eq!(saved["kind"], json!("scene"), "{saved}");
    assert_eq!(saved["props"]["preview"], s_json(&png), "{saved}");
    drop(c);
    let (_h, latency) = sup.crash(libc::SIGSEGV);
    println!("restart latency {latency:?}");
    let mut c = sup.client();
    let st = wait_state(&mut c, Duration::from_secs(10), |st| {
        sources(st).iter().any(|(_, n)| n["path"] == s_json(&dir))
    });
    let (nid, node) = sources(&st)
        .into_iter()
        .find(|(_, n)| n["path"] == s_json(&dir))
        .unwrap();
    assert_eq!(node["kind"], json!("scene"), "{node}");
    assert_eq!(node["broken"], json!(true), "restored broken: {node}");
    for conn in ["VIRTUAL-1", "VIRTUAL-2"] {
        assert_eq!(content(&st, conn), nid, "{conn} shows the restored scene");
    }
    // The preview shows (the image opens on the restored source).
    let shot = sup.root.join("t10-restored.png");
    let t = Instant::now();
    loop {
        c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": s(&shot)}));
        let px = png_rgb(&shot, 320, 180);
        if px[0] <= 3 && px[1] >= 252 && px[2] <= 3 {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_secs(5),
            "the restored broken scene shows {px:?}, not its preview"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(500));
    let st = c.state();
    let w = st["workers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == json!(nid))
        .cloned()
        .expect("a workers entry");
    assert!(w["pid"].is_null(), "no worker for a restored broken scene: {w}");
    assert_eq!(w["state"], "broken", "{w}");
    let spawned: Vec<Value> = c
        .logs("worker.spawned")
        .into_iter()
        .filter(|e| e["id"] == json!(nid))
        .collect();
    assert!(spawned.is_empty(), "spawned {spawned:?}");
}

// ---------------------------------------------------------------- Phase 3 Task 5: programs

fn prog_clip(name: &str, secs: f64) -> String {
    let frames = (secs * 30.0).round() as u32;
    s(&ensure_clip(
        &format!("sup_prog_{name}_{frames}f"),
        ClipSpec::FrameIndex { frames },
    ))
    .to_string()
}

fn create_program(c: &mut Client, items: &[&str], props: Value) {
    let mut p = json!({
        "items": items.iter().map(|i| json!({"path": i})).collect::<Vec<_>>(),
        "seed": 1,
    });
    for (k, v) in props.as_object().unwrap() {
        p[k] = v.clone();
    }
    c.ok(
        "create",
        json!({"kind": "program", "id": "prog:main", "props": p}),
    );
}

fn program0(c: &mut Client) -> Value {
    c.state()["programs"][0].clone()
}

/// The snapshot's program part has played `ms` or more of the item at `path`.
fn snap_program(snap: &Value, path: &str, ms: f64) -> bool {
    snap["programs"][0]["current_path"] == path
        && snap["programs"][0]["played_ms"].as_f64().unwrap_or(0.0) >= ms
}

#[test]
fn program_survives_a_crash() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let items = [prog_clip("cr_a", 10.0), prog_clip("cr_b", 10.0), prog_clip("cr_c", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    let mut c = sup.client();
    create_program(&mut c, &items, json!({"mode": "timer", "interval_ms": 3000}));
    c.ok("program.play", json!({"id": "prog:main"}));
    // 2 switches, then 1.5 s into the third item
    let p = wait_state(&mut c, Duration::from_secs(15), |st| {
        st["programs"][0]["path"] == items[2]
    });
    assert_eq!(p["programs"][0]["history"], json!(items[..3]));
    sup.wait_snapshot(SNAPSHOT_WAIT, |sn| snap_program(sn, items[2], 1500.0));
    let before = program0(&mut c);
    drop(c);
    sup.crash(libc::SIGSEGV);
    let mut c = sup.client();
    let after = wait_state(&mut c, Duration::from_secs(5), |st| {
        st["programs"][0]["phase"] == "playing"
    })["programs"][0]
        .clone();
    assert_eq!(after["order"], before["order"], "{after}");
    assert_eq!(after["history"], before["history"]);
    assert_eq!(after["path"], json!(items[2]));
    let (a, b) = (
        after["played_ms"].as_f64().unwrap(),
        before["played_ms"].as_f64().unwrap(),
    );
    assert!((a - b).abs() <= 2500.0, "played {b} → {a}");
    // the rotation goes on: the next switch to the next item, from the program
    let st = wait_state(&mut c, Duration::from_secs(6), |st| {
        st["programs"][0]["path"] == items[0]
    });
    assert_eq!(st["programs"][0]["history"][3], json!(items[0]));
    let sch = c.logs("transition.scheduled");
    assert!(
        sch.iter()
            .any(|e| e["origin"] == "program:prog:main" && e["path"] == items[0]),
        "{sch:?}"
    );
}

#[test]
fn restored_armed_program_rearms_at_a_end() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let items = [prog_clip("ra_a", 6.0), prog_clip("ra_b", 6.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    let mut c = sup.client();
    create_program(&mut c, &items, json!({"mode": "on_end"}));
    c.ok("program.play", json!({"id": "prog:main"}));
    wait_state(&mut c, Duration::from_secs(5), |st| {
        st["programs"][0]["phase"] == "armed"
    });
    sup.wait_snapshot(SNAPSHOT_WAIT, |sn| {
        snap_program(sn, items[0], 2000.0) && snap_has_path(sn, items[0])
    });
    drop(c);
    sup.crash(libc::SIGSEGV);
    let mut c = sup.client();
    let st = wait_state(&mut c, Duration::from_secs(5), |st| {
        st["programs"][0]["phase"] == "armed"
    });
    assert_eq!(st["programs"][0]["path"], json!(items[0]), "A restored");
    assert_eq!(st["programs"][0]["next"], json!(items[1]));
    let (nid, _) = sources(&st)
        .into_iter()
        .find(|(_, n)| n["path"] == items[0])
        .expect("A");
    let st = wait_state(&mut c, Duration::from_secs(5), |st| {
        st["graph"][&nid]["ready"] == json!(true)
    });
    let node = st["graph"][&nid].clone();
    let sch = c.logs("transition.scheduled");
    assert!(!sch.is_empty());
    assert!(sch.iter().all(|e| e["align"] == "end"), "no align:now: {sch:?}");
    assert_eq!(content(&st, "VIRTUAL-1"), nid, "B is not shown early");
    let tp = node["time_pos"].as_f64().unwrap_or(0.0);
    assert!(tp >= 1.5, "A where it played: {tp}");
    // the handoff at A's end
    let t = Instant::now();
    wait_state(&mut c, Duration::from_secs(8), |st| {
        st["programs"][0]["path"] == items[1]
    });
    let left = 6.0 - tp;
    println!("handoff {:?} after the restore (A had {left:.2} s left)", t.elapsed());
    let h = c.logs("transition.handoff");
    assert!(!h.is_empty());
    assert!(
        c.logs("program.current")
            .iter()
            .any(|e| e["reason"] == "end" && e["path"] == items[1])
    );
}

#[test]
fn quit_then_restore_resumes_the_program() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let items = [prog_clip("qr_a", 10.0), prog_clip("qr_b", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    let mut c = sup.client();
    create_program(&mut c, &items, json!({"mode": "timer", "interval_ms": 30_000}));
    c.ok("program.play", json!({"id": "prog:main", "index": 1}));
    wait_state(&mut c, Duration::from_secs(5), |st| {
        sources(st)
            .iter()
            .any(|(_, n)| n["path"] == items[1] && n["time_pos"].as_f64().unwrap_or(0.0) >= 3.0)
    });
    let before = program0(&mut c);
    c.ok("quit", json!({}));
    drop(c);
    let st = sup.wait_exit(Duration::from_secs(30)).expect("quit");
    assert_eq!(st.code(), Some(0));
    let root = std::mem::take(&mut sup.root);
    let serial = sup._serial.take();
    sup.pid = 0;
    let sup2 = Sup::spawn_in(root, &["--restore"], &[], serial, true);
    let mut c = sup2.client();
    let st = wait_state(&mut c, Duration::from_secs(5), |st| {
        st["programs"][0]["phase"] == "playing"
            && sources(st)
                .iter()
                .any(|(_, n)| n["path"] == items[1] && n["ready"] == json!(true))
    });
    let p = &st["programs"][0];
    assert_eq!(p["path"], json!(items[1]), "{p}");
    let (a, b) = (
        p["played_ms"].as_f64().unwrap(),
        before["played_ms"].as_f64().unwrap(),
    );
    assert!((a - b).abs() <= 2000.0, "played {b} → {a}");
    let (_, node) = sources(&st)
        .into_iter()
        .find(|(_, n)| n["path"] == items[1])
        .unwrap();
    assert!(node["time_pos"].as_f64().unwrap() >= 2.0, "{node}");
    // the rotation continues
    c.ok("program.next", json!({"id": "prog:main"}));
    wait_state(&mut c, Duration::from_secs(5), |st| {
        st["programs"][0]["path"] == items[0]
    });
}

/// The supervisor's 4th restart within a minute starts without `--restore` (a snapshot that
/// crashes the player at startup can't loop): no program comes back — documented; the
/// backend re-sends it (Task 7 reconciliation).
#[test]
fn fourth_restart_in_a_minute_starts_without_program() {
    let Some(mut sup) = Sup::start(&[]) else {
        return;
    };
    let items = [prog_clip("fr_a", 10.0), prog_clip("fr_b", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    let mut c = sup.client();
    create_program(&mut c, &items, json!({"mode": "timer", "interval_ms": 30_000}));
    c.ok("program.play", json!({"id": "prog:main"}));
    sup.wait_snapshot(SNAPSHOT_WAIT, |sn| snap_program(sn, items[0], 0.0));
    drop(c);
    for k in 1..=4 {
        sup.crash(libc::SIGSEGV);
        let mut c = sup.client();
        if k <= 3 {
            let st = wait_state(&mut c, Duration::from_secs(5), |st| {
                st["programs"].as_array().is_some_and(|p| p.len() == 1)
            });
            assert_eq!(st["programs"][0]["path"], json!(items[0]), "restart {k}");
            sup.wait_snapshot(SNAPSHOT_WAIT, |sn| snap_program(sn, items[0], 0.0));
        } else {
            std::thread::sleep(Duration::from_millis(500));
            let st = c.state();
            assert_eq!(st["programs"], json!([]), "restart {k}: {st}");
        }
    }
}
