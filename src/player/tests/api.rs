//! Task 12: the runtime + command API end to end. Every test spawns the real binary —
//! `lp-player serve --no-supervise --headless --outputs 640x360@60,320x180@60 --clock
//! stepped --ao null` — with a temp `XDG_RUNTIME_DIR` / `XDG_STATE_HOME` (never the real
//! ones), talks JSON lines over its socket, and kills the child on drop (also on panic).
//! `--no-supervise` (Task 16): the spawned process *is* the compositor (pid checks, lock
//! owner, SIGTERM); supervision has its own suite (`tests/supervise.rs`). Skips (prints
//! `SKIP: …`) only without an EGL device or a `transitions/` catalogue — fails instead
//! under `LP_REQUIRE_GPU=1` (`common::skip_gpu`).
//!
//! One server at a time (a process-wide lock): parallel 1080p decoders starve each other
//! and the teardown-timing test measures the loop itself.

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use common::{ClipSpec, ensure_clip, headless_gl};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_lp-player");
static SERIAL: Mutex<()> = Mutex::new(());
static N: AtomicU32 = AtomicU32::new(0);
/// `lp_player::supervise::EXIT_NO_COMPOSITOR` (black-box: spelled out).
const EXIT_NO_COMPOSITOR: i32 = 5;

// ---------------------------------------------------------------- server + client

struct Serve {
    child: Option<Child>,
    root: PathBuf,
    sock: PathBuf,
    _serial: Option<MutexGuard<'static, ()>>,
}

/// `LP_REQUIRE_GPU=1` turns a skip into a failure (`common::skip_gpu`).
fn can_run() -> bool {
    headless_gl().is_some() && common::catalogue_dir().is_some()
}

fn new_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "lp-api-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("run")).unwrap();
    std::fs::create_dir_all(root.join("state")).unwrap();
    root
}

/// Kill the child if the spawning test thread goes away without its `Drop` (an abort,
/// a killed test run): `PR_SET_PDEATHSIG` — no stray `serve` ever outlives its test.
fn die_with_parent(c: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        c.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
}

fn serve_cmd(root: &Path, extra: &[&str]) -> Command {
    let mut c = Command::new(BIN);
    die_with_parent(&mut c);
    c.args([
        "serve",
        "--no-supervise",
        "--headless",
        "--outputs",
        "640x360@60,320x180@60",
        "--clock",
        "stepped",
        "--ao",
        "null",
    ])
    .args(extra)
    .env("XDG_RUNTIME_DIR", root.join("run"))
    .env("XDG_STATE_HOME", root.join("state"))
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::from(
        std::fs::File::create(
            root.join(format!("stderr-{}.log", N.fetch_add(1, Ordering::Relaxed))),
        )
        .unwrap(),
    ));
    c
}

impl Serve {
    fn start() -> Option<Serve> {
        Serve::start_with(&[])
    }

    fn start_with(extra: &[&str]) -> Option<Serve> {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        if !can_run() {
            return None;
        }
        let root = new_root();
        Some(Serve::spawn_in(root, extra, Some(serial)))
    }

    fn spawn_in(root: PathBuf, extra: &[&str], serial: Option<MutexGuard<'static, ()>>) -> Serve {
        Serve::spawn_env(root, extra, &[], serial)
    }

    /// [`Serve::spawn_in`] with extra environment variables for the child.
    fn spawn_env(
        root: PathBuf,
        extra: &[&str],
        env: &[(&str, &Path)],
        serial: Option<MutexGuard<'static, ()>>,
    ) -> Serve {
        Serve::spawn_env_without(root, extra, env, &[], serial)
    }

    /// [`Serve::spawn_env`] that also removes `unset` from the child's environment.
    fn spawn_env_without(
        root: PathBuf,
        extra: &[&str],
        env: &[(&str, &Path)],
        unset: &[&str],
        serial: Option<MutexGuard<'static, ()>>,
    ) -> Serve {
        let mut cmd = serve_cmd(&root, extra);
        for (k, v) in env {
            cmd.env(k, v);
        }
        for k in unset {
            cmd.env_remove(k);
        }
        let child = cmd.spawn().expect("spawn lp-player serve");
        let sock = root.join("run/livepaper/lp-player.sock");
        let mut s = Serve {
            child: Some(child),
            root,
            sock,
            _serial: serial,
        };
        s.wait_up();
        s
    }

    fn wait_up(&mut self) {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(15) {
            if UnixStream::connect(&self.sock).is_ok() {
                return;
            }
            if let Some(st) = self.child.as_mut().unwrap().try_wait().unwrap() {
                panic!("serve exited early ({st}): {}", self.stderr());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("serve socket never came up: {}", self.stderr());
    }

    fn stderr(&self) -> String {
        let mut out = String::new();
        if let Ok(rd) = std::fs::read_dir(&self.root) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("stderr") {
                    out.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
                }
            }
        }
        out
    }

    fn client(&self) -> Client {
        Client::connect(&self.sock)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// Wait for the child to exit on its own (after `quit`).
    fn wait_exit(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let t = Instant::now();
        while t.elapsed() < timeout {
            if let Some(st) = self.child.as_mut().unwrap().try_wait().unwrap() {
                return Some(st);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Client {
    w: UnixStream,
    r: BufReader<UnixStream>,
    id: u64,
    events: std::collections::VecDeque<Value>,
}

impl Client {
    fn connect(sock: &Path) -> Client {
        let w = UnixStream::connect(sock).expect("connect");
        w.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let r = BufReader::new(w.try_clone().unwrap());
        Client {
            w,
            r,
            id: 0,
            events: Default::default(),
        }
    }

    fn read_msg(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.r.read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(serde_json::from_str(&line).unwrap_or_else(|e| {
                panic!("server sent non-JSON {line:?}: {e}");
            })),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => None,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => None,
            // A unix socket closed with our unread bytes still queued reports a reset
            // after the data it did send: a disconnect.
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => None,
            Err(e) => panic!("read: {e}"),
        }
    }

    /// One request → its full response object (events seen meanwhile are queued).
    fn call(&mut self, cmd: &str, args: Value) -> Value {
        self.id += 1;
        let id = self.id;
        let line = json!({"id": id, "cmd": cmd, "args": args}).to_string();
        self.w.write_all(line.as_bytes()).unwrap();
        self.w.write_all(b"\n").unwrap();
        loop {
            let m = self
                .read_msg()
                .unwrap_or_else(|| panic!("no response to {cmd} {line}"));
            if m.get("event").is_some() {
                self.events.push_back(m);
            } else if m["id"] == json!(id) {
                return m;
            } else {
                panic!("response for another id: {m}");
            }
        }
    }

    fn ok(&mut self, cmd: &str, args: Value) -> Value {
        let r = self.call(cmd, args.clone());
        assert_eq!(r["ok"], json!(true), "{cmd} {args} failed: {r}");
        r["result"].clone()
    }

    /// Every request in ONE write (the server handles them in one dispatch, ≤ 32 per wake)
    /// → their results, in order; each must succeed.
    fn ok_batch(&mut self, reqs: &[(&str, Value)]) -> Vec<Value> {
        let first = self.id + 1;
        let mut out = String::new();
        for (cmd, args) in reqs {
            self.id += 1;
            out.push_str(&json!({"id": self.id, "cmd": cmd, "args": args}).to_string());
            out.push('\n');
        }
        self.w.write_all(out.as_bytes()).unwrap();
        let mut results = Vec::new();
        for id in first..=self.id {
            loop {
                let m = self
                    .read_msg()
                    .unwrap_or_else(|| panic!("no response to id {id}"));
                if m.get("event").is_some() {
                    self.events.push_back(m);
                    continue;
                }
                assert_eq!(m["id"], json!(id), "responses out of order: {m}");
                assert_eq!(m["ok"], json!(true), "request {id} failed: {m}");
                results.push(m["result"].clone());
                break;
            }
        }
        results
    }

    fn err(&mut self, cmd: &str, args: Value) -> Value {
        let r = self.call(cmd, args.clone());
        assert_eq!(r["ok"], json!(false), "{cmd} {args} should fail: {r}");
        r["error"].clone()
    }

    fn step(&mut self, ms: u64) {
        let r = self.call("step", json!({ "ms": ms }));
        if r["ok"] != json!(true) {
            // A step timeout names the source and what it waits for; its story is in the
            // log (the source's events, the seek/frame order) — keep it with the failure.
            let probe = self.call("probe", json!({"name": "sources"}));
            let logs = self.call("logs", json!({"limit": 300}));
            panic!("step {ms} failed: {r}\nsources: {probe}\nlogs: {logs}");
        }
    }

    /// Every event received so far (queued + whatever is already buffered).
    fn drain_events(&mut self) -> Vec<Value> {
        self.w
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        while let Some(m) = self.read_msg() {
            if m.get("event").is_some() {
                self.events.push_back(m);
            }
        }
        self.w
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        self.events.drain(..).collect()
    }

    /// Step `ms` at a time until an event named `name` (for `corr`, if given) has arrived.
    fn step_until_event(&mut self, ms: u64, max_steps: u32, name: &str, corr: &str) -> Vec<Value> {
        let mut seen = Vec::new();
        for _ in 0..max_steps {
            self.step(ms);
            seen.extend(self.events.drain(..));
            if seen.iter().any(|e| e["event"] == name && e["corr"] == corr) {
                return seen;
            }
        }
        panic!("no {name} for {corr} within {max_steps} steps of {ms} ms; saw {seen:?}");
    }
}

// ---------------------------------------------------------------- helpers

fn png_pixel(path: &Path, x: u32, y: u32) -> [u8; 4] {
    let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
    let mut rd = dec.read_info().unwrap();
    let mut buf = vec![0; rd.output_buffer_size().unwrap()];
    let info = rd.next_frame(&mut buf).unwrap();
    let i = ((y * info.width + x) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

fn near(got: [u8; 4], want: [u8; 3], tol: u8, what: &str) {
    for c in 0..3 {
        assert!(
            got[c].abs_diff(want[c]) <= tol,
            "{what}: {got:?} vs {want:?} ± {tol}"
        );
    }
}

fn color(c: &mut Client, rgb: [u8; 3]) -> String {
    let r = c.ok(
        "create",
        json!({"kind": "source", "props": {"kind": "color", "color": rgb}}),
    );
    r["id"].as_str().unwrap().to_string()
}

fn show_all(c: &mut Client, id: &str) {
    c.ok("set", json!({"path": "lay:*:main.content", "value": id}));
}

fn names(evs: &[Value], corr: &str) -> Vec<String> {
    evs.iter()
        .filter(|e| e["corr"] == corr)
        .map(|e| e["event"].as_str().unwrap_or("").to_string())
        .collect()
}

/// A red → blue colour transition over `out:*` (fade, `ms`), stepped to `transition.done`
/// (subscribes `c` to `transition.` to see it).
fn color_transition(c: &mut Client, ms: u32) -> (String, Vec<Value>) {
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a = color(c, [255, 0, 0]);
    show_all(c, &a);
    c.step(16);
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"kind": "color", "color": [0, 0, 255]},
               "effect_id": "fade", "duration_ms": ms}),
    );
    let corr = r["corr"].as_str().expect("transition → {corr}").to_string();
    let evs = c.step_until_event(16, 200, "transition.done", &corr);
    (corr, evs)
}

const RED_3S: ClipSpec = ClipSpec::Solid {
    rgb: [255, 0, 0],
    secs: 3.0,
    tone_hz: 440.0,
    tone_dbfs: -20.0,
};
const RED_10S: ClipSpec = ClipSpec::Solid {
    rgb: [255, 0, 0],
    secs: 10.0,
    tone_hz: 440.0,
    tone_dbfs: -20.0,
};
const BLUE_10S: ClipSpec = ClipSpec::Solid {
    rgb: [0, 0, 255],
    secs: 10.0,
    tone_hz: 660.0,
    tone_dbfs: -20.0,
};

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

// ---------------------------------------------------------------- brief tests

#[test]
fn hello_and_state() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let h = c.ok("hello", json!({}));
    let caps: Vec<&str> = h["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    for want in ["video", "image", "color", "transition", "headless"] {
        assert!(caps.contains(&want), "capabilities {caps:?} lack {want}");
    }
    assert!(h["pid"].as_u64().unwrap() > 0);
    assert_eq!(h["version"], env!("CARGO_PKG_VERSION"));
    let st = c.ok("state", json!({}));
    let g = &st["graph"];
    assert_eq!(g["out:VIRTUAL-1"]["width"], 640, "{st}");
    assert_eq!(g["out:VIRTUAL-1"]["height"], 360);
    assert_eq!(g["out:VIRTUAL-1"]["refresh_hz"], 60);
    assert_eq!(g["out:VIRTUAL-2"]["width"], 320);
    assert_eq!(g["lay:VIRTUAL-2:main"]["kind"], "layer");
    assert_eq!(st["clock"]["mode"], "stepped");
}

#[test]
fn error_shape() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let e = c.err("set", json!({"path": "nope.x", "value": 1}));
    assert_eq!(e["code"], "no_such_node", "{e}");
    assert!(!e["message"].as_str().unwrap().is_empty());
    assert!(!e["hint"].as_str().unwrap().is_empty(), "{e}");
    // A global setting broadcast to nobody is fine — but still type-checked.
    let r = c.ok("set", json!({"path": "srcs:*.gain.user", "value": -3}));
    assert_eq!(r["targets"], json!([]));
    let e = c.err("set", json!({"path": "srcs:*.speed", "value": 99}));
    assert_eq!(e["code"], "out_of_range", "{e}");
    let e = c.err("set", json!({"path": "srcs:*.nope", "value": 1}));
    assert_eq!(e["code"], "no_such_prop", "{e}");
    // An unknown verb names the verb list.
    let e = c.err("frobnicate", json!({}));
    assert_eq!(e["code"], "no_such_verb", "{e}");
    assert!(e["hint"].as_str().unwrap().contains("Command API"), "{e}");
    // step needs the stepped clock — it's on here; a bad arg is still bad_request.
    let e = c.err("step", json!({"ms": "x"}));
    assert_eq!(e["code"], "bad_request", "{e}");
}

#[test]
fn color_capture() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let id = color(&mut c, [0, 255, 0]);
    show_all(&mut c, &id);
    c.step(16);
    let p = srv.path("x.png");
    let r = c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": s(&p)}));
    assert_eq!(r["width"], 640);
    near(png_pixel(&p, 320, 180), [0, 255, 0], 1, "VIRTUAL-1 centre");
    let p2 = srv.path("y.png");
    c.ok(
        "capture",
        json!({"target": "out:VIRTUAL-2", "path": s(&p2)}),
    );
    near(png_pixel(&p2, 160, 90), [0, 255, 0], 1, "VIRTUAL-2 centre");
    // A source captures as its own texture (a colour is 1×1).
    let p3 = srv.path("src.png");
    let r = c.ok("capture", json!({"target": id, "path": s(&p3)}));
    assert_eq!(
        (r["width"].clone(), r["height"].clone()),
        (json!(1), json!(1))
    );
    near(png_pixel(&p3, 0, 0), [0, 255, 0], 0, "source capture");
    let e = c.err("capture", json!({"target": "out:NOPE", "path": s(&p3)}));
    assert_eq!(e["code"], "no_such_node", "{e}");
    let e = c.err("capture", json!({"target": id, "path": "rel.png"}));
    assert_eq!(e["code"], "bad_request", "{e}");
}

/// `animate` moves a number on the virtual clock and reports `anim.done`; `stop` silences
/// and removes every source and empties the layers.
#[test]
fn animate_then_stop() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["anim.", "player."]}));
    let id = color(&mut c, [255, 255, 255]);
    show_all(&mut c, &id);
    c.step(16);
    let r = c.ok(
        "animate",
        json!({"path": "lay:VIRTUAL-1:main.opacity", "to": 0.0, "duration_ms": 100}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    c.step(50);
    let v = c.ok("get", json!({"path": "lay:VIRTUAL-1:main.opacity"}))["value"]
        .as_f64()
        .unwrap();
    assert!((v - 0.5).abs() < 1e-9, "opacity at 50 of 100 ms: {v}");
    let p = srv.path("half.png");
    c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": s(&p)}));
    near(
        png_pixel(&p, 320, 180),
        [127, 127, 127],
        2,
        "half-opacity white",
    );
    let evs = c.step_until_event(16, 10, "anim.done", &corr);
    assert!(evs.iter().any(|e| e["event"] == "anim.done"));
    assert_eq!(
        c.ok("get", json!({"path": "lay:VIRTUAL-1:main.opacity"}))["value"],
        json!(0.0)
    );
    // Not a number → bad_type; unknown curve → bad_request.
    let e = c.err(
        "animate",
        json!({"path": "lay:VIRTUAL-1:main.fit", "to": 1, "duration_ms": 10}),
    );
    assert_eq!(e["code"], "bad_type", "{e}");
    let e = c.err(
        "animate",
        json!({"path": "lay:VIRTUAL-1:main.opacity", "to": 1, "duration_ms": 10, "curve": "x"}),
    );
    assert_eq!(e["code"], "bad_request", "{e}");

    let r = c.ok("stop", json!({}));
    assert_eq!(r["stopping"], json!([id]));
    c.step(16);
    let st = c.ok("state", json!({}));
    assert!(st["sources"].as_array().unwrap().is_empty(), "{st}");
    assert_eq!(st["graph"]["lay:VIRTUAL-1:main"]["content"], "");
    assert!(st["graph"].get(&id).is_none(), "{st}");
}

/// The real clock: the timer drives the recipe (no `step`), events arrive in order.
#[test]
fn real_clock_transition() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let serial = srv._serial.take();
    drop(srv);
    let srv = Serve::spawn_in(new_root(), &["--clock", "real"], serial);
    let mut c = srv.client();
    assert_eq!(c.ok("hello", json!({}))["clock"], "real");
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a = color(&mut c, [255, 0, 0]);
    show_all(&mut c, &a);
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"kind": "color", "color": [0, 0, 255]},
               "effect_id": "fade", "duration_ms": 200}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let t = Instant::now();
    let mut evs = Vec::new();
    while !evs.iter().any(|e: &Value| e["event"] == "transition.done") {
        assert!(t.elapsed() < Duration::from_secs(5), "no done: {evs:?}");
        evs.extend(c.drain_events());
    }
    assert_eq!(
        names(&evs, &corr),
        [
            "transition.scheduled",
            "transition.started",
            "transition.handoff",
            "transition.done"
        ]
    );
    let e = c.err("step", json!({"ms": 16}));
    assert_eq!(e["code"], "unsupported", "{e}");
    assert!(
        e["hint"].as_str().unwrap().contains("--clock stepped"),
        "{e}"
    );
    std::thread::sleep(Duration::from_millis(50));
    let p = srv.path("rt.png");
    c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": s(&p)}));
    near(
        png_pixel(&p, 320, 180),
        [0, 0, 255],
        1,
        "real clock: B on screen",
    );
}

#[test]
fn transition_events_in_order() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let sub = c.ok("subscribe", json!({"topics": ["transition."]}));
    assert_eq!(sub["topics"], json!(["transition."]));
    let (corr, evs) = color_transition(&mut c, 200);
    let n: Vec<String> = names(&evs, &corr)
        .into_iter()
        .filter(|n| {
            [
                "transition.scheduled",
                "transition.started",
                "transition.handoff",
                "transition.done",
                "transition.cancelled",
                "transition.failed",
            ]
            .contains(&n.as_str())
        })
        .collect();
    assert_eq!(
        n,
        [
            "transition.scheduled",
            "transition.started",
            "transition.handoff",
            "transition.done"
        ],
        "{evs:?}"
    );
    for e in &evs {
        assert!(
            e["event"].as_str().unwrap().starts_with("transition."),
            "subscription leaked {e}"
        );
        assert!(e["t_mono_ms"].as_f64().is_some(), "{e}");
        assert!(e.get("corr").is_some(), "{e}");
    }
}

#[test]
fn logs_by_corr() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let (corr1, _) = color_transition(&mut c, 100);
    let (corr2, _) = color_transition(&mut c, 100);
    assert_ne!(corr1, corr2);
    let r = c.ok("logs", json!({"corr": corr1}));
    let evs = r["events"].as_array().unwrap();
    assert!(!evs.is_empty());
    for e in evs {
        assert_eq!(e["corr"], json!(corr1), "{e}");
    }
    let kinds: Vec<&str> = evs.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    for want in [
        "transition.scheduled",
        "transition.started",
        "transition.handoff",
        "transition.done",
    ] {
        assert!(kinds.contains(&want), "{kinds:?} lacks {want}");
    }
}

#[test]
fn hotplug_mid_transition() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition.", "output."]}));
    let a = color(&mut c, [255, 0, 0]);
    show_all(&mut c, &a);
    c.step(16);
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"kind": "color", "color": [0, 0, 255]},
               "effect_id": "fade", "duration_ms": 500}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let b = r["to"].as_str().unwrap().to_string();
    c.step_until_event(16, 50, "transition.started", &corr);
    for _ in 0..5 {
        c.step(16);
    }
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    let st = c.ok("state", json!({}));
    assert!(st["graph"].get("out:VIRTUAL-2").is_none(), "{st}");
    let evs = c.step_until_event(16, 200, "transition.done", &corr);
    assert!(
        !names(&evs, &corr)
            .iter()
            .any(|n| n == "transition.failed" || n == "transition.cancelled"),
        "{evs:?}"
    );
    assert!(
        c.drain_events()
            .iter()
            .chain(evs.iter())
            .any(|e| e["event"] == "output.removed"),
        "no output.removed event"
    );
    c.step(16);
    let p = srv.path("v1.png");
    c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": s(&p)}));
    near(png_pixel(&p, 320, 180), [0, 0, 255], 1, "VIRTUAL-1 shows B");

    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 320, "height": 180, "hz": 60}),
    );
    c.step(16);
    let got = c.ok("get", json!({"path": "lay:VIRTUAL-3:main.content"}));
    assert_eq!(got["value"], json!(b), "new output shows B");
    let p3 = srv.path("v3.png");
    c.ok(
        "capture",
        json!({"target": "out:VIRTUAL-3", "path": s(&p3)}),
    );
    near(png_pixel(&p3, 160, 90), [0, 0, 255], 1, "VIRTUAL-3 shows B");
}

// ---------------------------------------------------------------- controller rulings

/// R49: effect ids are checked against the catalogue; the error says how to list them.
#[test]
fn unknown_effect_rejected() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let ids = c.ok("effects", json!({}));
    let ids: Vec<&str> = ids["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(ids.len() > 100 && ids.contains(&"fade"), "{ids:?}");
    let a = color(&mut c, [255, 0, 0]);
    show_all(&mut c, &a);
    let before = c.ok("state", json!({}))["graph"].clone();
    let e = c.err(
        "transition",
        json!({"outputs": "out:*", "to": {"kind": "color", "color": [0, 0, 255]},
               "effect_id": "no_such_effect_xyz", "duration_ms": 100}),
    );
    assert_eq!(e["code"], "no_such_effect", "{e}");
    assert!(e["hint"].as_str().unwrap().contains("effects"), "{e}");
    assert_eq!(
        c.ok("state", json!({}))["graph"],
        before,
        "a rejected transition changed the graph"
    );
}

/// R48: same command script twice → byte-identical captures; the frame is the one the
/// virtual clock says (frame-index marker).
#[test]
fn stepped_is_deterministic() {
    let Some(mut srv1) = Serve::start() else {
        return;
    };
    let clip = ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 });
    let run = |srv: &Serve| -> (Vec<u8>, Vec<u8>, u8, u8) {
        let mut c = srv.client();
        let r = c.ok(
            "create",
            json!({"kind": "source", "props": {"path": s(&clip)}}),
        );
        let id = r["id"].as_str().unwrap().to_string();
        show_all(&mut c, &id);
        for _ in 0..20 {
            c.step(16); // opened at step 1 (t = 0), then 19 × 16 ms → 0.304 s → frame 9
        }
        let p1 = srv.path("d1.png");
        c.ok(
            "capture",
            json!({"target": "out:VIRTUAL-1", "path": s(&p1)}),
        );
        c.ok(
            "set",
            json!({"path": format!("{id}.position"), "value": 2.0}),
        );
        for _ in 0..3 {
            c.step(16); // t = 2.0 at the first, 2.032 at the third → frame 60
        }
        let p2 = srv.path("d2.png");
        c.ok(
            "capture",
            json!({"target": "out:VIRTUAL-1", "path": s(&p2)}),
        );
        (
            std::fs::read(&p1).unwrap(),
            std::fs::read(&p2).unwrap(),
            png_pixel(&p1, 5, 5)[0],
            png_pixel(&p2, 5, 5)[0],
        )
    };
    let (a1, a2, m1, m2) = run(&srv1);
    // The second server inherits the first's lock (no other test runs in between).
    let serial = srv1._serial.take();
    drop(srv1);
    let srv2 = Serve::spawn_in(new_root(), &[], serial);
    let (b1, b2, _, _) = run(&srv2);
    assert!(
        m1.abs_diff(9) <= 1,
        "frame marker {m1} at t=0.304 s (want 9 ± 1)"
    );
    assert!(
        m2.abs_diff(60) <= 1,
        "frame marker {m2} at t=2.032 s (want 60 ± 1)"
    );
    assert!(a1 == b1, "capture 1 differs between runs");
    assert!(a2 == b2, "capture 2 differs between runs");
}

/// R50: a global setting sent to `srcs:*` reaches the pending B of an in-flight
/// transition (not just what's on screen), in the graph and in mpv.
#[test]
fn settings_reach_pending_b() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a_clip = ensure_clip("tr_red_3s", RED_3S);
    let b_clip = ensure_clip("tr_blue_10s", BLUE_10S);
    let a = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&a_clip), "loop": true}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(16);
    }
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&b_clip), "loop": true},
               "effect_id": "fade", "duration_ms": 500, "method": "full-live", "align": "end"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let b = r["to"].as_str().unwrap().to_string();
    for _ in 0..5 {
        c.step(16);
    }
    let st = c.ok("state", json!({}));
    let tr = &st["transitions"][0];
    assert_eq!(tr["phase"], "waiting_start", "{st}");
    // srcs:* = what's on screen (A) + the pending B.
    let r = c.ok("set", json!({"path": "srcs:*.gain.user", "value": -6.0}));
    let mut targets: Vec<String> = r["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    targets.sort();
    let mut want = vec![a.clone(), b.clone()];
    want.sort();
    assert_eq!(targets, want);
    for id in [&a, &b] {
        let v = c.ok("get", json!({"path": format!("{id}.gain.user")}));
        assert_eq!(v["value"], json!(-6.0), "{id}");
    }
    c.step(16);
    let probe = c.ok("probe", json!({"name": "sources"}));
    let src = |p: &Value, id: &str| -> Value {
        p["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .unwrap_or_else(|| panic!("{id} not in {p}"))
    };
    let pb = src(&probe, &b);
    assert_eq!(pb["gains"]["user"], json!(-6.0), "B's live source: {pb}");
    assert!(
        (pb["mpv_volume_gain"].as_f64().unwrap() - (-96.0)).abs() < 0.01,
        "pending B is silent: {pb}"
    );
    let pa = src(&probe, &a);
    assert!(
        (pa["mpv_volume_gain"].as_f64().unwrap() - (-6.0)).abs() < 0.01,
        "A at -6 dB: {pa}"
    );
    // Through A's end (3 s) and the handoff: B keeps the setting at full level.
    c.step_until_event(100, 60, "transition.done", &corr);
    c.step(16);
    let probe = c.ok("probe", json!({"name": "sources"}));
    let pb = src(&probe, &b);
    assert!(
        (pb["mpv_volume_gain"].as_f64().unwrap() - (-6.0)).abs() < 0.01,
        "B after handoff: {pb}"
    );
    assert_eq!(pb["gain_effective_db"], json!(-6.0), "{pb}");
}

/// Stepped mode composes with the recipe's `align: end`: a non-looping A reaches its end
/// on the virtual clock (`source.ended`, last frame held), and a reveal transition aligned
/// to that end starts there.
#[test]
fn stepped_align_end_reveal() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok(
        "subscribe",
        json!({"topics": ["transition.", "source.ended"]}),
    );
    let clip = ensure_clip("tr_frame_index_90", ClipSpec::FrameIndex { frames: 90 });
    let b_clip = ensure_clip("tr_blue_10s", BLUE_10S);
    let a = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&clip), "loop": true}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(100); // A at 0.2 s
    }
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&b_clip), "loop": true},
               "effect_id": "fade", "duration_ms": 300, "method": "reveal", "align": "end"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    // A (3 s, loop turned off by align:end) ends at its 3 s; the effect starts there.
    let evs = c.step_until_event(100, 60, "transition.started", &corr);
    let ended = evs
        .iter()
        .position(|e| e["event"] == "source.ended" && e["id"] == a)
        .expect("A's source.ended");
    let started = evs
        .iter()
        .position(|e| e["event"] == "transition.started" && e["corr"] == corr)
        .unwrap();
    assert!(ended <= started, "started before A ended: {evs:?}");
    let at = evs[started]["at_ms"].as_f64().unwrap();
    assert!(
        (at - 3000.0).abs() <= 150.0,
        "started at {at} ms, A ends at 3000: {evs:?}"
    );
    c.step_until_event(100, 30, "transition.done", &corr);
}

/// TODO "a speed-up inside the last D of an `align:end` wait / a global speed change
/// mid-effect", real libmpv on the virtual clock: a 1.5 s full-live fade aligned to the end
/// of a 3 s A, A sped up 4× (`srcs:*.speed`, the backend's global path) 300 ms into the
/// effect — the effect is compressed and hands off at A's new end. RED before: at the
/// requested 1.5 s, ~0.9 s after A ended (A frozen on its last frame meanwhile).
#[test]
fn align_end_speed_up_mid_effect_hands_off_at_a_end() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_3s", RED_3S)), "loop": true}),
    );
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(100);
    }
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&ensure_clip("tr_blue_10s", BLUE_10S)), "loop": true},
               "effect_id": "fade", "duration_ms": 1500, "method": "full-live", "align": "end"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let evs = c.step_until_event(16, 300, "transition.started", &corr);
    let started = evs
        .iter()
        .find(|e| e["event"] == "transition.started")
        .unwrap()["at_ms"]
        .as_f64()
        .unwrap();
    for _ in 0..19 {
        c.step(16);
    }
    let now = c.ok("state", json!({}))["clock"]["now_ms"]
        .as_f64()
        .unwrap();
    let tp = get(&mut c, &format!("{a}.time_pos"))["result"]["value"]
        .as_f64()
        .unwrap();
    let t = c.ok("set", json!({"path": "srcs:*.speed", "value": 4.0}));
    assert!(
        t["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x == &json!(a)),
        "{t}"
    );
    let a_end = now + (3.0 - tp) / 4.0 * 1000.0;
    let evs = c.step_until_event(16, 300, "transition.handoff", &corr);
    let handoff = evs
        .iter()
        .find(|e| e["event"] == "transition.handoff")
        .unwrap()["at_ms"]
        .as_f64()
        .unwrap();
    assert!(
        (handoff - a_end).abs() <= 40.0,
        "handoff {:+.0} ms vs A's end (effect started at {started:.0}, A sped up at {now:.0}, \
         time_pos {tp:.3}; RED: the full 1.5 s)",
        handoff - a_end
    );
    c.step_until_event(16, 100, "transition.done", &corr);
}

/// Finds `id` in a `probe sources` reply.
fn probe_source<'a>(probe: &'a Value, id: &str) -> &'a Value {
    probe["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap_or_else(|| panic!("{id} not in {probe}"))
}

/// Task 16b, R75: player-level pause freezes the Animator and `Transitions` — a
/// full-live transition's effect progress, both sides' `gain.xfade` and both sides'
/// `time_pos` all stay exactly where they were through a full second of stepped time,
/// and both are *effectively* paused (`probe sources`) even though neither side's own
/// `paused` node prop ever changes (full-live never pauses either side — R34/§10). (d):
/// `player.paused` is reflected in `get`, `state` and `probe sources` throughout. On
/// resume the transition continues forward from where it paused (never restarts) and
/// completes normally.
#[test]
fn player_pause_freezes_full_live_transition() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a_clip = ensure_clip("tr_red_10s", RED_10S);
    let b_clip = ensure_clip("tr_blue_10s", BLUE_10S);
    let a = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&a_clip), "loop": true}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &a);
    for _ in 0..5 {
        c.step(16);
    }

    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&b_clip), "loop": true},
               "effect_id": "fade", "duration_ms": 2000, "method": "full-live",
               "align": "now"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let b = r["to"].as_str().unwrap().to_string();
    c.step_until_event(16, 60, "transition.started", &corr);
    let fx = content(&mut c, "VIRTUAL-1");

    // Advance to ~50% progress.
    loop {
        let p = get(&mut c, &format!("{fx}.progress"))["result"]["value"]
            .as_f64()
            .unwrap();
        if p >= 0.45 {
            break;
        }
        c.step(32);
    }

    let progress_before = get(&mut c, &format!("{fx}.progress"))["result"]["value"]
        .as_f64()
        .unwrap();
    let a_gain_before = get(&mut c, &format!("{a}.gain.xfade"))["result"]["value"].clone();
    let b_gain_before = get(&mut c, &format!("{b}.gain.xfade"))["result"]["value"].clone();
    let a_pos_before = get(&mut c, &format!("{a}.time_pos"))["result"]["value"].clone();
    let b_pos_before = get(&mut c, &format!("{b}.time_pos"))["result"]["value"].clone();

    c.ok("set", json!({"path": "player.paused", "value": true}));

    // (d) visible via get/state/probe sources.
    assert_eq!(get(&mut c, "player.paused")["result"]["value"], json!(true));
    let st = c.ok("state", json!({}));
    assert_eq!(st["graph"]["player"]["paused"], json!(true), "{st}");
    let probe = c.ok("probe", json!({"name": "sources"}));
    for id in [&a, &b] {
        let src = probe_source(&probe, id);
        assert_eq!(
            src["paused"],
            json!(false),
            "the node's own paused is untouched: {src}"
        );
        assert_eq!(src["effective_paused"], json!(true), "{src}");
    }

    // A full second (stepped): nothing moves.
    for _ in 0..32 {
        c.step(32);
    }
    assert_eq!(
        get(&mut c, &format!("{fx}.progress"))["result"]["value"],
        json!(progress_before)
    );
    assert_eq!(
        get(&mut c, &format!("{a}.gain.xfade"))["result"]["value"],
        a_gain_before
    );
    assert_eq!(
        get(&mut c, &format!("{b}.gain.xfade"))["result"]["value"],
        b_gain_before
    );
    assert_eq!(
        get(&mut c, &format!("{a}.time_pos"))["result"]["value"],
        a_pos_before
    );
    assert_eq!(
        get(&mut c, &format!("{b}.time_pos"))["result"]["value"],
        b_pos_before
    );

    // Resume: continues forward from here (never restarts), then completes.
    c.ok("set", json!({"path": "player.paused", "value": false}));
    c.step(32);
    let progress_after = get(&mut c, &format!("{fx}.progress"))["result"]["value"]
        .as_f64()
        .unwrap();
    assert!(
        progress_after > progress_before,
        "must continue forward from where it paused, not restart: \
         {progress_before} -> {progress_after}"
    );
    c.step_until_event(32, 300, "transition.done", &corr);
}

/// Task 16b, R75: pausing mid-`frozen` hold must not disturb the recipe's own hold — A
/// and B are already held (`paused: true`) by the method itself, the player-level
/// override is a no-op on top of that, and the handoff (driven by the frozen clock) must
/// not fire while paused even once real step-time well past `duration_ms` has gone by.
/// Resuming lets it complete normally, at which point B's own handoff unpauses it
/// (never the player-pause override).
#[test]
fn player_pause_freezes_frozen_hold() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a_clip = ensure_clip("tr_red_10s", RED_10S);
    let b_clip = ensure_clip("tr_blue_10s", BLUE_10S);
    let a = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&a_clip), "loop": true}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &a);
    for _ in 0..5 {
        c.step(16);
    }

    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&b_clip), "loop": true},
               "effect_id": "fade", "duration_ms": 300, "method": "frozen",
               "align": "now"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let b = r["to"].as_str().unwrap().to_string();
    c.step_until_event(16, 60, "transition.started", &corr);
    // Frozen holds both A and B paused through the effect (the method itself, nothing to
    // do with player.paused yet) — A pauses once its 30 ms anti-click ramp lands.
    for _ in 0..5 {
        c.step(16);
    }
    assert_eq!(
        get(&mut c, &format!("{a}.paused"))["result"]["value"],
        json!(true)
    );
    assert_eq!(
        get(&mut c, &format!("{b}.paused"))["result"]["value"],
        json!(true)
    );

    c.ok("set", json!({"path": "player.paused", "value": true}));
    let probe = c.ok("probe", json!({"name": "sources"}));
    for id in [&a, &b] {
        let src = probe_source(&probe, id);
        assert_eq!(src["paused"], json!(true), "recipe-held already: {src}");
        assert_eq!(src["effective_paused"], json!(true), "{src}");
    }

    // Step well past the 300 ms duration while paused: the handoff must not fire.
    c.drain_events();
    for _ in 0..40 {
        c.step(100); // 4 s of (frozen) virtual time
    }
    let evs = c.drain_events();
    assert!(
        !evs.iter()
            .any(|e| e["event"] == "transition.handoff" && e["corr"] == corr),
        "handoff fired while paused: {evs:?}"
    );
    assert_eq!(
        get(&mut c, &format!("{a}.paused"))["result"]["value"],
        json!(true),
        "still held exactly as the method wants"
    );
    assert_eq!(
        get(&mut c, &format!("{b}.paused"))["result"]["value"],
        json!(true)
    );

    // Resume: it completes, and B's own handoff (not the player-pause override) unpauses it.
    c.ok("set", json!({"path": "player.paused", "value": false}));
    c.step_until_event(32, 60, "transition.handoff", &corr);
    c.step_until_event(32, 60, "transition.done", &corr);
    assert_eq!(
        get(&mut c, &format!("{b}.paused"))["result"]["value"],
        json!(false),
        "B's own handoff unpauses it once the effect is over"
    );
}

/// Task 16b, R75: pausing during an `align: end` wait holds A (via the generic
/// effective-pause override, not anything the recipe itself does) so it never reaches
/// its own natural end while paused — the wait must not fire — and resumes once
/// unpaused.
#[test]
fn player_pause_freezes_align_end_wait() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok(
        "subscribe",
        json!({"topics": ["transition.", "source.ended"]}),
    );
    let a_clip = ensure_clip("tr_red_3s", RED_3S);
    let b_clip = ensure_clip("tr_blue_10s", BLUE_10S);
    let a = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&a_clip)}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(100); // A at 0.3 s
    }

    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&b_clip), "loop": true},
               "effect_id": "fade", "duration_ms": 300, "method": "reveal",
               "align": "end"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    for _ in 0..5 {
        c.step(50); // B becomes ready; still waiting on A's own end (3 s)
    }
    let st = c.ok("state", json!({}));
    assert_eq!(st["transitions"][0]["phase"], "waiting_start", "{st}");

    c.ok("set", json!({"path": "player.paused", "value": true}));
    let probe = c.ok("probe", json!({"name": "sources"}));
    let src = probe_source(&probe, &a);
    assert_eq!(src["paused"], json!(false), "A's own intent: still playing");
    assert_eq!(src["effective_paused"], json!(true), "{src}");
    let a_pos_before = get(&mut c, &format!("{a}.time_pos"))["result"]["value"].clone();

    c.drain_events();
    // Well past A's 3 s end, if it moved at all.
    for _ in 0..40 {
        c.step(100);
    }
    assert_eq!(
        get(&mut c, &format!("{a}.time_pos"))["result"]["value"],
        a_pos_before,
        "A must never reach its own end while paused"
    );
    let evs = c.drain_events();
    assert!(
        !evs.iter()
            .any(|e| e["event"] == "transition.started" && e["corr"] == corr),
        "the align:end wait fired while paused: {evs:?}"
    );

    c.ok("set", json!({"path": "player.paused", "value": false}));
    let evs = c.step_until_event(100, 60, "transition.started", &corr);
    assert!(
        evs.iter()
            .any(|e| e["event"] == "source.ended" && e["id"] == a),
        "{evs:?}"
    );
}

/// Task 16c (R88): player-level pause/resume on a *plain* source (not part of any
/// transition) ramps `gain.anticlick` to silence over the ANTICLICK + settle-tail window
/// before the source is actually paused, and — on resume — un-pauses immediately then
/// ramps back in once real audio is confirmed flowing. Real clock (not stepped): the gate
/// is timed off the wall clock on purpose (never the player clock, which freezes the
/// instant `player.paused` does — R75), so it needs real time to pace against, the same
/// reason `destroy_ramps_audible_source_out` (above) uses `--clock real` too.
#[test]
fn player_pause_ramps_a_plain_source() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let serial = srv._serial.take();
    drop(srv);
    let srv = Serve::spawn_in(new_root(), &["--clock", "real"], serial);
    let mut c = srv.client();
    let id = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &id);
    let t = Instant::now();
    loop {
        let v = get(&mut c, &format!("{id}.time_pos"))["result"]["value"]
            .as_f64()
            .unwrap_or(0.0);
        if v >= 0.3 {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_secs(5),
            "never started playing"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    c.ok("set", json!({"path": "player.paused", "value": true}));

    // `probe sources`: `mpv_pause` is a synchronous, real read of mpv's own property —
    // unlike `get id.paused` (the *node's* raw intent, deliberately never touched by R75
    // and so never reflects the gate either, same as the existing
    // `player_pause_freezes_*` tests' own `src["paused"]` checks).
    let mpv_paused = |c: &mut Client| -> bool {
        let p = c.ok("probe", json!({"name": "sources"}));
        probe_source(&p, &id)["mpv_pause"].as_str() == Some("yes")
    };

    // Must see the anticlick ramp genuinely under way *while the source is still
    // un-paused* — never jumping straight from 0 dB to paused=true.
    let mut saw_ramping_while_unpaused = false;
    let mut saw_paused = false;
    let t = Instant::now();
    while !saw_paused {
        assert!(t.elapsed() < Duration::from_secs(2), "never paused");
        let anticlick = get(&mut c, &format!("{id}.gain.pause"))["result"]["value"]
            .as_f64()
            .unwrap();
        let paused = mpv_paused(&mut c);
        if !paused && anticlick < -0.5 && anticlick > -95.0 {
            saw_ramping_while_unpaused = true;
        }
        if paused {
            saw_paused = true;
            assert!(
                anticlick <= -95.9,
                "paused before the ramp reached silence: {anticlick} dB"
            );
        }
    }
    assert!(
        saw_ramping_while_unpaused,
        "never observed a mid-ramp, still-unpaused sample — pause must not be instant"
    );
    let probe = c.ok("probe", json!({"name": "sources"}));
    assert_eq!(
        probe_source(&probe, &id)["effective_paused"],
        json!(true),
        "{probe}"
    );

    // Frozen: time_pos must not move once actually paused.
    let held = get(&mut c, &format!("{id}.time_pos"))["result"]["value"]
        .as_f64()
        .unwrap();
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        get(&mut c, &format!("{id}.time_pos"))["result"]["value"]
            .as_f64()
            .unwrap(),
        held,
        "picture moved while player-paused"
    );

    // Resume: un-pauses right away (not held hostage by the onset wait), then ramps back
    // in once real audio is confirmed flowing.
    c.ok("set", json!({"path": "player.paused", "value": false}));
    let t = Instant::now();
    loop {
        if !mpv_paused(&mut c) {
            break;
        }
        assert!(t.elapsed() < Duration::from_millis(500), "never un-paused");
    }
    let t = Instant::now();
    loop {
        let anticlick = get(&mut c, &format!("{id}.gain.pause"))["result"]["value"]
            .as_f64()
            .unwrap();
        if (anticlick - 0.0).abs() < 1e-6 {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_millis(500),
            "never ramped back in: {anticlick} dB"
        );
    }
    let before = get(&mut c, &format!("{id}.time_pos"))["result"]["value"]
        .as_f64()
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        get(&mut c, &format!("{id}.time_pos"))["result"]["value"]
            .as_f64()
            .unwrap()
            > before,
        "picture never resumed"
    );
}

/// R93 (review of Task 16c/16d): destroying a plain source while its R88 player-pause
/// anticlick gate is still open — in any of its four states (`Pausing`, `Paused`,
/// `AwaitingFlow`, `Resuming`) — must never leak the gate or its dropout-probe window,
/// and `retire`'s own 30 ms ramp must be the *only* writer left touching
/// `gain.anticlick` from that point on (reaching silence cleanly, not fought over by a
/// gate that kept writing underneath it). `--clock real`: the gate is wall-clock timed.
#[test]
fn r93_destroy_mid_gate_never_leaks() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let serial = srv._serial.take();
    drop(srv);
    let srv = Serve::spawn_in(new_root(), &["--clock", "real"], serial);
    let mut c = srv.client();

    let mpv_paused = |c: &mut Client, id: &str| -> bool {
        let p = c.ok("probe", json!({"name": "sources"}));
        probe_source(&p, id)["mpv_pause"].as_str() == Some("yes")
    };
    // The gate ramps its own slot (final review I2).
    let anticlick = |c: &mut Client, id: &str| -> f64 {
        get(c, &format!("{id}.gain.pause"))["result"]["value"]
            .as_f64()
            .unwrap()
    };
    let loop_probe = |c: &mut Client| c.ok("probe", json!({"name": "loop"}));

    for state in ["Pausing", "Paused", "AwaitingFlow", "Resuming"] {
        let base = loop_probe(&mut c);
        let open_before = base["dropout_windows_open"].as_u64().unwrap();

        let id = create_src(
            &mut c,
            json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
        );
        show_all(&mut c, &id);
        let t = Instant::now();
        loop {
            let v = get(&mut c, &format!("{id}.time_pos"))["result"]["value"]
                .as_f64()
                .unwrap_or(0.0);
            if v >= 0.3 {
                break;
            }
            assert!(
                t.elapsed() < Duration::from_secs(5),
                "never started playing"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        c.ok("set", json!({"path": "player.paused", "value": true}));
        match state {
            "Pausing" => {
                // No wait at all: destroy while the gate is still mid-ramp-down (< the
                // 45 ms ANTICLICK + AUDIO_SETTLE_TAIL window).
            }
            "Paused" | "AwaitingFlow" | "Resuming" => {
                let t = Instant::now();
                while !mpv_paused(&mut c, &id) {
                    assert!(t.elapsed() < Duration::from_secs(2), "never paused");
                }
                if state == "Paused" {
                    // Destroy right here, fully paused, gate idle but still open.
                } else {
                    c.ok("set", json!({"path": "player.paused", "value": false}));
                    if state == "Resuming" {
                        // Wait for AudioFlowing to confirm (anticlick starts rising from
                        // SILENT_DB) before destroying — lands mid-ramp-in.
                        let t = Instant::now();
                        while anticlick(&mut c, &id) <= -95.0 {
                            assert!(
                                t.elapsed() < Duration::from_secs(1),
                                "never started resuming"
                            );
                        }
                    }
                    // AwaitingFlow: destroy immediately after the resume request, well
                    // before AudioFlowing can confirm.
                }
            }
            _ => unreachable!(),
        }

        c.ok("destroy", json!({ "id": id }));
        // I1 (final review): the teardown runs on the unpaused clock — "Pausing"/"Paused"
        // left the player paused, and the destroy must still complete (decoder freed)
        // without a resume.

        // The node must actually go (retire's own ramp, or an instant destroy).
        let t = Instant::now();
        loop {
            if get(&mut c, &format!("{id}.gain.anticlick"))["ok"] != json!(true) {
                break;
            }
            assert!(
                t.elapsed() < Duration::from_secs(2),
                "{state}: source never destroyed"
            );
        }

        let after = loop_probe(&mut c);
        assert_eq!(
            after["pause_gates"],
            json!(0),
            "{state}: a gate leaked: {after}"
        );
        let open_after = after["dropout_windows_open"].as_u64().unwrap();
        assert!(
            open_after <= open_before,
            "{state}: a dropout window was left open (before {open_before}, after \
             {open_after}): {after}"
        );

        // retire's own ramp was the only writer left: the teardown's reported level is
        // clean silence, same evidence `destroy_ramps_audible_source_out` uses.
        let t = Instant::now();
        let teardown = loop {
            let l = c.ok("logs", json!({"kind_prefix": "source.teardown"}));
            if let Some(e) = l["events"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|e| e["id"] == id)
            {
                break e.clone();
            }
            assert!(
                t.elapsed() < Duration::from_secs(2),
                "{state}: no source.teardown"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(
            teardown["gain_db"].as_f64().unwrap() <= -95.9,
            "{state}: torn down while still audible (a second writer fought the ramp): \
             {teardown}"
        );
        // Fully torn down while (still) paused: no longer hosted.
        let t = Instant::now();
        loop {
            let p = c.ok("probe", json!({"name": "sources"}));
            let hosted = p["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["id"] == json!(id));
            if !hosted {
                break;
            }
            assert!(
                t.elapsed() < Duration::from_secs(2),
                "{state}: still hosted"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        c.ok("set", json!({"path": "player.paused", "value": false}));
    }
}

/// R93 (review of Task 16c/16d, minor fix): under the stepped clock, `player.paused`
/// must never open an R88 gate for a plain source at all — mpv itself stays paused for
/// good there (§ Sources "Stepped mode"), and the gate's wall-clock (`Instant`) ramp has
/// nothing meaningful to pace against. Pausing/resuming stays the ordinary, instant R75
/// composition (`node.paused || player.paused`, § invariant #7) — no ramp, `gain.
/// anticlick` untouched, `probe loop`'s `pause_gates` stays 0 throughout. Default
/// `Serve::start()` (`--clock stepped`).
#[test]
fn stepped_player_pause_never_opens_a_gate() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let id = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &id);
    c.step(16);
    c.step(16);
    let anticlick_before = get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"]
        .as_f64()
        .unwrap();

    c.ok("set", json!({"path": "player.paused", "value": true}));
    c.step(16);
    let lp = c.ok("probe", json!({"name": "loop"}));
    assert_eq!(
        lp["pause_gates"],
        json!(0),
        "a gate opened under stepped: {lp}"
    );
    let probe = c.ok("probe", json!({"name": "sources"}));
    let src = probe["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == json!(id))
        .unwrap();
    assert_eq!(
        src["effective_paused"],
        json!(true),
        "instant R75 composition, same step: {src}"
    );
    assert_eq!(
        get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"].as_f64(),
        Some(anticlick_before),
        "no gate means no gain ramp at all"
    );

    c.ok("set", json!({"path": "player.paused", "value": false}));
    c.step(16);
    let lp = c.ok("probe", json!({"name": "loop"}));
    assert_eq!(lp["pause_gates"], json!(0), "{lp}");
}

/// R92 (review of Task 16c/16d): a frozen transition onto a B that is a real `video`
/// with literally no audio stream (`ClipSpec::FrameIndex`, generated with no `-c:a`/
/// audio input at all — not `no_audio`, which is our own request) must complete
/// quickly, never waiting the full `ONSET_TIMEOUT` (150 ms) or logging
/// `transition.onset_timeout` — `has_audio` resolves `false` once mpv loads the file,
/// so `b_has_audio` already treats it like a colour/image B (R85's existing fast path).
/// `--clock real`: the whole point is real wall-clock timing of the onset wait.
#[test]
fn r92_transition_onto_video_with_no_audio_skips_onset_wait() {
    let Some(srv) = Serve::start_with(&["--clock", "real"]) else {
        return;
    };
    let mut c = srv.client();
    let a = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &a);
    let t0 = Instant::now();
    loop {
        let v = get(&mut c, &format!("{a}.time_pos"))["result"]["value"]
            .as_f64()
            .unwrap_or(0.0);
        if v >= 0.3 {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "A never started playing"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    let r = c.ok(
        "transition",
        json!({"outputs": "out:*",
               "to": {"path": s(&ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 })),
                      "loop": true},
               "effect_id": "fade", "duration_ms": 300, "method": "frozen"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();

    let t = Instant::now();
    let mut handoff_at = None;
    let mut done_at = None;
    loop {
        let logs = c.ok("logs", json!({"corr": corr}));
        for e in logs["events"].as_array().unwrap() {
            match e["kind"].as_str().unwrap_or("") {
                "transition.handoff" if handoff_at.is_none() => handoff_at = Some(t.elapsed()),
                "transition.done" if done_at.is_none() => done_at = Some(t.elapsed()),
                "transition.onset_timeout" => {
                    panic!("must never time out for a B known to have no audio: {logs}")
                }
                _ => {}
            }
        }
        if done_at.is_some() {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_secs(3),
            "transition never completed: {logs}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let handoff_at = handoff_at.expect("handoff must have fired before done");
    let gap = done_at.unwrap().saturating_sub(handoff_at);
    println!("R92: handoff->done gap {gap:?} (the old bug would have been >= 150 ms)");
    assert!(
        gap < Duration::from_millis(100),
        "done took {gap:?} after handoff — looks like it still waited for an onset \
         confirmation that could never arrive"
    );
}

/// TODO "`transition.onset_timeout` on audio-less videos" (85 in the Task 20 re-run): EVERY
/// method × align onto a B that has nothing (more) to play — no audio stream at all, or a
/// selected audio track that ends 30 ms in (RED before: the confirmation needed a SECOND
/// `audio-pts` change ≥ 40 ms after the first, which never came, so every one of these
/// waited out `ONSET_TIMEOUT` and warned) — must hand off without the timeout. A has audio
/// (a 3 s clip, so `align: end` arrives quickly); `--clock real`. Then a `/next` storm.
#[test]
fn audio_less_b_never_times_out_its_onset_any_method_or_align() {
    let Some(srv) = Serve::start_with(&["--clock", "real"]) else {
        return;
    };
    let mut c = srv.client();
    let b_clip = ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 });
    let short = ensure_clip(
        "api_short_audio_4s",
        ClipSpec::ShortAudio {
            rgb: [0, 0, 255],
            secs: 4.0,
            audio_secs: 0.03,
        },
    );
    let mut timeouts = Vec::new();
    for (bname, bpath) in [("no-audio", &b_clip), ("short-audio", &short)] {
        for method in ["full-live", "reveal", "frozen"] {
            for align in ["now", "end"] {
                let a = create_src(
                    &mut c,
                    json!({"path": s(&ensure_clip("api_red_3s", RED_3S)), "loop": true}),
                );
                show_all(&mut c, &a);
                let t0 = Instant::now();
                while get(&mut c, &format!("{a}.time_pos"))["result"]["value"]
                    .as_f64()
                    .unwrap_or(0.0)
                    < 0.3
                {
                    assert!(t0.elapsed() < Duration::from_secs(5), "A never started");
                    std::thread::sleep(Duration::from_millis(10));
                }
                let r = c.ok(
                    "transition",
                    json!({"outputs": "out:*", "to": {"path": s(bpath), "loop": true},
                       "effect_id": "fade", "duration_ms": 300, "method": method, "align": align}),
                );
                let corr = r["corr"].as_str().unwrap().to_string();
                let t = Instant::now();
                loop {
                    let logs = c.ok("logs", json!({"corr": corr}));
                    let evs = logs["events"].as_array().unwrap();
                    if evs.iter().any(|e| e["kind"] == "transition.onset_timeout") {
                        timeouts.push(format!("{bname} {method}/{align}"));
                    }
                    if evs.iter().any(|e| e["kind"] == "transition.done") {
                        break;
                    }
                    assert!(
                        t.elapsed() < Duration::from_secs(8),
                        "{bname} {method}/{align}: no transition.done: {logs}"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                c.ok("stop", json!({}));
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    // a /next storm (the battery's fast cells): audio-less ↔ audio-less, every request
    // superseding or committing the previous one, 60–120 ms apart
    let b2 = ensure_clip("frame_index_90", ClipSpec::FrameIndex { frames: 90 });
    let first = create_src(&mut c, json!({"path": s(&b_clip), "loop": true}));
    show_all(&mut c, &first);
    std::thread::sleep(Duration::from_millis(500));
    let mut corrs = Vec::new();
    for i in 0..16 {
        let to = if i % 2 == 0 { &b2 } else { &b_clip };
        let method = ["full-live", "reveal", "frozen"][i % 3];
        let r = c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"path": s(to), "loop": true},
                   "effect_id": "fade", "duration_ms": 200, "method": method, "align": "now"}),
        );
        corrs.push(r["corr"].as_str().unwrap().to_string());
        std::thread::sleep(Duration::from_millis(60 + 15 * (i as u64 % 4)));
    }
    std::thread::sleep(Duration::from_millis(1500));
    for corr in &corrs {
        let logs = c.ok("logs", json!({"corr": corr}));
        if logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "transition.onset_timeout")
        {
            timeouts.push(format!("storm {corr}"));
        }
    }
    let rt = c.ok("logs", json!({"kind_prefix": "runtime.onset_timeout"}));
    for e in rt["events"].as_array().unwrap() {
        timeouts.push(format!("runtime {}", e));
    }
    timeouts.dedup();
    assert!(
        timeouts.is_empty(),
        "transition.onset_timeout onto a B with no audio track: {timeouts:?}"
    );
}

/// R92/R88: a plain (non-transition) playing source with no audio track must pause and
/// resume *instantly* on `player.paused` — `source_has_audio` must be false for it, so
/// `Runtime`'s anticlick gate never opens at all (no ramp, no `player.pause_gate` log
/// event), exactly like a colour/image source.
#[test]
fn r92_pause_gate_skips_video_with_no_audio() {
    let Some(srv) = Serve::start_with(&["--clock", "real"]) else {
        return;
    };
    let mut c = srv.client();
    let id = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 })),
               "loop": true}),
    );
    show_all(&mut c, &id);
    let t0 = Instant::now();
    loop {
        let v = get(&mut c, &format!("{id}.time_pos"))["result"]["value"]
            .as_f64()
            .unwrap_or(0.0);
        if v >= 0.3 {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "never started playing"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // Let `has_audio` resolve to false (the file loaded well before this point already).
    std::thread::sleep(Duration::from_millis(50));

    c.ok("set", json!({"path": "player.paused", "value": true}));
    let mpv_paused = |c: &mut Client| -> bool {
        let p = c.ok("probe", json!({"name": "sources"}));
        probe_source(&p, &id)["mpv_pause"].as_str() == Some("yes")
    };
    let t = Instant::now();
    loop {
        if mpv_paused(&mut c) {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_millis(100),
            "never paused — if a gate opened for a no-audio source, this is why"
        );
    }
    let logs = c.ok("logs", json!({"kind_prefix": "player.pause_gate"}));
    assert!(
        logs["events"].as_array().unwrap().is_empty(),
        "no gate should ever open for a source with no audio track: {logs}"
    );

    c.ok("set", json!({"path": "player.paused", "value": false}));
    let t = Instant::now();
    loop {
        if !mpv_paused(&mut c) {
            break;
        }
        assert!(t.elapsed() < Duration::from_millis(100), "never resumed");
    }
}

/// Task 16b/16c review fix: `probe sources`' `effective_paused` must read `player.paused`
/// straight off the graph, never the runtime's own cached field — which is only refreshed
/// at the top of the next tick/step. A `set player.paused true` immediately followed by
/// `probe sources`, *pipelined on the wire* (both written before either reply is read, so
/// the server very likely handles both within the same dispatch), must already see the
/// new value.
#[test]
fn effective_paused_is_live_even_pipelined() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let a_clip = ensure_clip("tr_red_10s", RED_10S);
    let a = create_src(&mut c, json!({"path": s(&a_clip), "loop": true}));
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(16);
    }

    // Pipeline: write both requests before reading either reply.
    let id1 = c.id + 1;
    let id2 = c.id + 2;
    c.id = id2;
    let l1 = json!({"id": id1, "cmd": "set", "args": {"path": "player.paused", "value": true}})
        .to_string();
    let l2 = json!({"id": id2, "cmd": "probe", "args": {"name": "sources"}}).to_string();
    c.w.write_all(l1.as_bytes()).unwrap();
    c.w.write_all(b"\n").unwrap();
    c.w.write_all(l2.as_bytes()).unwrap();
    c.w.write_all(b"\n").unwrap();

    let mut r1 = None;
    let mut r2 = None;
    while r1.is_none() || r2.is_none() {
        let m = c.read_msg().unwrap_or_else(|| panic!("no response"));
        if m.get("event").is_some() {
            continue;
        } else if m["id"] == json!(id1) {
            r1 = Some(m);
        } else if m["id"] == json!(id2) {
            r2 = Some(m);
        }
    }
    let r1 = r1.unwrap();
    let r2 = r2.unwrap();
    assert_eq!(r1["ok"], json!(true), "{r1}");
    assert_eq!(r2["ok"], json!(true), "{r2}");
    let src = probe_source(&r2["result"], &a);
    assert_eq!(
        src["effective_paused"],
        json!(true),
        "pipelined probe saw a stale effective_paused: {src}"
    );
}

/// One bad client never affects another: garbage JSON gets an error (connection kept), a
/// line over 1 MiB or a mid-line disconnect gets dropped, a client that never reads its
/// replies is dropped once its bounded queue overflows — the good client is answered
/// promptly throughout.
#[test]
fn bad_client_isolated() {
    let Some(srv) = Serve::start() else { return };
    let mut good = srv.client();
    good.ok("subscribe", json!({"topics": ["api."]}));

    // Garbage: an error naming the problem, and the connection still works.
    let mut bad = srv.client();
    bad.w.write_all(b"this is not json{{{\n").unwrap();
    let m = bad.read_msg().expect("error reply to garbage");
    assert_eq!(m["ok"], json!(false), "{m}");
    assert_eq!(m["id"], Value::Null);
    assert_eq!(m["error"]["code"], "bad_request", "{m}");
    assert!(!m["error"]["hint"].as_str().unwrap().is_empty());
    bad.ok("hello", json!({}));

    // A huge line (written slowly, in 64 KiB chunks): the good client is answered
    // meanwhile; the huge one gets an error, then a disconnect.
    let mut huge = srv.client();
    let mut hw = huge.w.try_clone().unwrap();
    let writer = std::thread::spawn(move || {
        let chunk = vec![b'a'; 64 * 1024];
        for _ in 0..32 {
            if hw.write_all(&chunk).is_err() {
                break; // the server hung up mid-line
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    });
    let mut worst_huge = Duration::ZERO;
    for _ in 0..20 {
        let t = Instant::now();
        good.ok("hello", json!({}));
        worst_huge = worst_huge.max(t.elapsed());
        std::thread::sleep(Duration::from_millis(5));
    }
    writer.join().unwrap();
    assert!(
        worst_huge < Duration::from_millis(200),
        "good client waited {worst_huge:?} while a huge line came in"
    );
    let m = huge.read_msg().expect("error reply to an oversized line");
    assert_eq!(m["error"]["code"], "bad_request", "{m}");
    assert!(
        huge.read_msg().is_none(),
        "oversized client not disconnected"
    );

    // Half a line, then gone: dropped (logged as such), everyone else unaffected.
    {
        let mut half = UnixStream::connect(&srv.sock).unwrap();
        half.write_all(br#"{"id":1,"cmd":"hel"#).unwrap();
    }
    let t = Instant::now();
    loop {
        let l = good.ok("logs", json!({"kind_prefix": "api.client_dropped"}));
        if l["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["reason"].as_str().unwrap_or("").contains("mid-line"))
        {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_secs(3),
            "no mid-line drop: {l}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    good.ok("hello", json!({}));
    bad.ok("hello", json!({}));

    // A client that floods requests and never reads: dropped on overflow.
    let flood_sock = srv.sock.clone();
    let flood = std::thread::spawn(move || {
        let mut f = UnixStream::connect(&flood_sock).unwrap();
        let mut sent = 0;
        let line = br#"{"id":1,"cmd":"state"}
"#;
        for _ in 0..40_000 {
            if f.write_all(line).is_err() {
                break;
            }
            sent += 1;
        }
        sent
    });
    // The good client keeps getting prompt answers while that happens.
    let mut worst = Duration::ZERO;
    let t_end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < t_end {
        let t = Instant::now();
        good.ok("hello", json!({}));
        worst = worst.max(t.elapsed());
        std::thread::sleep(Duration::from_millis(20));
    }
    let sent = flood.join().unwrap();
    assert!(
        worst < Duration::from_millis(500),
        "good client waited {worst:?}"
    );
    assert!(sent < 40_000, "flooding client was never dropped");
    let logs = good.ok("logs", json!({"kind_prefix": "api.client_dropped"}));
    let reasons: Vec<String> = logs["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["reason"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(
        reasons.iter().any(|r| r.contains("overflow")),
        "{reasons:?}"
    );
    assert!(reasons.iter().any(|r| r.contains("1 MiB")), "{reasons:?}");
    good.ok("hello", json!({}));
}

/// R51: destroying a playing video never stalls the loop (mpv core teardown runs on the
/// reaper thread; only the render context is freed on the GL thread).
#[test]
fn destroy_never_stalls_the_loop() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let mut c = srv.client();
    let clip = ensure_clip("tr_red_10s", RED_10S);
    let id = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&clip)}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &id);
    for _ in 0..5 {
        c.step(16);
    }
    c.ok("destroy", json!({"id": id}));
    c.step(16);
    c.step(16); // 30 ms ramp out (item 10)…
    // …then the source goes: from here, the longest synchronous stretch anywhere (the
    // post-dispatch sync that drops it, the step after).
    c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
    c.step(16);
    c.step(16);
    let lp = c.ok("probe", json!({"name": "loop"}));
    let busy = lp["max_busy_ms"].as_f64().expect("max_busy_ms");
    println!("R51 stepped: max busy {busy:.2} ms around the destroy");
    assert!(
        busy < 8.0,
        "the loop was busy {busy} ms around the destroy: {lp}"
    );
    let last = lp["last_tick_ms"].as_f64().expect("last_tick_ms");
    assert!(last < 8.0, "a tick after the destroy took {last} ms: {lp}");
    let probe = c.ok("probe", json!({"name": "sources"}));
    assert!(probe["sources"].as_array().unwrap().is_empty(), "{probe}");

    // The same on the real clock, with the video actually playing.
    let serial = srv._serial.take();
    drop(srv);
    let srv = Serve::spawn_in(new_root(), &["--clock", "real"], serial);
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["source.ready"]}));
    let id = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&clip)}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &id);
    let t = Instant::now();
    while !c
        .events
        .iter()
        .any(|e| e["event"] == "source.ready" && e["id"] == id)
    {
        assert!(t.elapsed() < Duration::from_secs(5), "never ready");
        c.drain_events()
            .into_iter()
            .for_each(|e| c.events.push_back(e));
    }
    std::thread::sleep(Duration::from_millis(300));
    let tp = c.ok("get", json!({"path": format!("{id}.time_pos")}))["value"]
        .as_f64()
        .unwrap();
    assert!(tp > 0.1, "not playing: time_pos {tp}");
    c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
    c.ok("destroy", json!({"id": id}));
    std::thread::sleep(Duration::from_millis(300));
    let lp = c.ok("probe", json!({"name": "loop"}));
    let busy = lp["max_busy_ms"].as_f64().unwrap();
    println!("R51 real clock: max busy {busy:.2} ms around the destroy");
    assert!(
        busy < 8.0,
        "real clock: the loop was busy {busy} ms around the destroy: {lp}"
    );
    assert!(
        lp["tick_hz_last_s"].as_u64().unwrap() >= 50,
        "real clock: the timer kept ticking at ~60 Hz: {lp}"
    );
}

// ---------------------------------------------------------------- ctl + lifecycle

fn ctl(srv: &Serve, args: &[&str]) -> (i32, String) {
    let out = Command::new(BIN)
        .arg("ctl")
        .args(args)
        .env("XDG_RUNTIME_DIR", srv.root.join("run"))
        .output()
        .unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    )
}

#[test]
fn ctl_cli() {
    let Some(srv) = Serve::start() else { return };
    let (code, out) = ctl(&srv, &["hello"]);
    assert_eq!(code, 0, "{out}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["pid"].as_u64().is_some(), "{v}");
    assert!(out.contains("\n  "), "result is pretty-printed: {out}");

    let (code, out) = ctl(&srv, &["set", r#"{"path":"nope.x","value":1}"#]);
    assert_eq!(code, 1, "{out}");
    let e: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(e["code"], "no_such_node", "{e}");
    assert!(!e["hint"].as_str().unwrap().is_empty());

    let (code, out) = ctl(&srv, &["set", "{not json"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("hint"), "{out}");

    // ctl subscribe streams events one per line until killed.
    let mut sub = Command::new(BIN);
    die_with_parent(&mut sub);
    let mut sub = sub
        .args(["ctl", "subscribe", "transition."])
        .env("XDG_RUNTIME_DIR", srv.root.join("run"))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut c = srv.client();
    let t = Instant::now();
    while !c.ok("probe", json!({"name": "loop"}))["subscribed_topics"]
        .as_array()
        .unwrap()
        .contains(&json!("transition."))
    {
        assert!(
            t.elapsed() < Duration::from_secs(5),
            "ctl subscribe never subscribed"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let (corr, _) = color_transition(&mut c, 50);
    let mut out = sub.stdout.take().unwrap();
    let rd = std::thread::spawn(move || {
        let mut s = String::new();
        let mut buf = [0u8; 4096];
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) && !s.contains("transition.done") {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => s.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        s
    });
    let got = rd.join().unwrap();
    let _ = sub.kill();
    let _ = sub.wait();
    let lines: Vec<Value> = got
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
        .collect();
    assert!(
        lines
            .iter()
            .any(|e| e["event"] == "transition.done" && e["corr"] == corr),
        "{got}"
    );
}

#[test]
fn single_instance_stale_socket_and_quit() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let mut c = srv.client();
    let pid = c.ok("hello", json!({}))["pid"].as_u64().unwrap();
    // A second server on the same socket refuses to start, naming the running one.
    let out = serve_cmd(&srv.root, &[])
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains(&format!("already running (pid {pid})")),
        "{err}"
    );
    // The socket is private.
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&srv.sock).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "socket mode {mode:o}");
    let dmode = std::fs::metadata(srv.sock.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(dmode, 0o700, "socket dir mode {dmode:o}");
    // quit: clean exit, socket removed.
    c.ok("quit", json!({}));
    let st = srv
        .wait_exit(Duration::from_secs(5))
        .expect("quit didn't exit");
    assert!(st.success(), "{st}");
    assert!(!srv.sock.exists(), "socket left behind");
    // A stale socket (nobody listening) is replaced.
    drop(std::os::unix::net::UnixListener::bind(&srv.sock).unwrap());
    assert!(srv.sock.exists());
    srv.child = Some(serve_cmd(&srv.root, &[]).spawn().unwrap());
    srv.wait_up();
    srv.client().ok("hello", json!({}));
}

// ---------------------------------------------------------------- fix round 1

fn create_src(c: &mut Client, props: Value) -> String {
    c.ok("create", json!({"kind": "source", "props": props}))["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// The raw `get` reply (ok or not).
fn get(c: &mut Client, path: &str) -> Value {
    c.call("get", json!({ "path": path }))
}

fn exists(c: &mut Client, id: &str) -> bool {
    c.ok("state", json!({}))["graph"].get(id).is_some()
}

fn content(c: &mut Client, output: &str) -> String {
    c.ok("get", json!({"path": format!("lay:{output}:main.content")}))["value"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Video sources that are playing and not silent.
fn audible(c: &mut Client) -> Vec<String> {
    let st = c.ok("state", json!({}));
    let mut out = Vec::new();
    for (id, n) in st["graph"].as_object().unwrap() {
        // A source node's snapshot `kind` is its Source kind (video/image/color/snapshot);
        // only sources carry `gain_effective_db`.
        if n.get("gain_effective_db").is_some()
            && n["kind"] == "video"
            && n["paused"] == json!(false)
            && n["gain_effective_db"].as_f64().unwrap_or(-96.0) > -95.99
        {
            out.push(id.clone());
        }
    }
    out
}

fn srcs_targets(c: &mut Client, prop: &str, v: Value) -> Vec<String> {
    let r = c.ok("set", json!({"path": format!("srcs:*.{prop}"), "value": v}));
    let mut t: Vec<String> = r["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    t.sort();
    t
}

/// R59: an output added before the transition runs joins it — at `done` every output
/// shows B, A is gone, exactly one source is audible.
#[test]
fn hotplug_added_before_running_joins_transition() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(16);
    }
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&ensure_clip("tr_blue_10s", BLUE_10S)), "loop": true},
               "effect_id": "fade", "duration_ms": 300}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let b = r["to"].as_str().unwrap().to_string();
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 320, "height": 180, "hz": 60}),
    );
    assert_eq!(content(&mut c, "VIRTUAL-3"), a, "before Running: shows A");
    let st = c.ok("state", json!({}));
    assert!(
        st["transitions"][0]["outputs"]
            .as_array()
            .unwrap()
            .contains(&json!("out:VIRTUAL-3")),
        "VIRTUAL-3 joined the transition: {st}"
    );
    c.step_until_event(16, 100, "transition.done", &corr);
    c.step(16);
    for o in ["VIRTUAL-1", "VIRTUAL-2", "VIRTUAL-3"] {
        assert_eq!(content(&mut c, o), b, "{o} shows B at done");
    }
    assert!(!exists(&mut c, &a), "A destroyed");
    assert_eq!(
        audible(&mut c),
        vec![b.clone()],
        "exactly one audible source"
    );
}

/// R59: an output added while the effect runs shows the effect; a cancel snaps every
/// output back to A, B is destroyed, nothing dangles.
#[test]
fn hotplug_added_during_running_then_cancel() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(16);
    }
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&ensure_clip("tr_blue_10s", BLUE_10S)), "loop": true},
               "effect_id": "fade", "duration_ms": 1000}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let b = r["to"].as_str().unwrap().to_string();
    c.step_until_event(16, 100, "transition.started", &corr);
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 320, "height": 180, "hz": 60}),
    );
    let fx = content(&mut c, "VIRTUAL-1");
    assert!(fx.starts_with("fx"), "VIRTUAL-1 shows the effect: {fx}");
    assert_eq!(
        content(&mut c, "VIRTUAL-3"),
        fx,
        "during Running: shows the effect"
    );
    for _ in 0..3 {
        c.step(16);
    }
    c.ok("cancel", json!({ "corr": corr }));
    for _ in 0..5 {
        c.step(16);
    }
    for o in ["VIRTUAL-1", "VIRTUAL-2", "VIRTUAL-3"] {
        assert_eq!(content(&mut c, o), a, "{o} back on A");
    }
    assert!(!exists(&mut c, &b), "B destroyed");
    assert!(!exists(&mut c, &fx), "effect destroyed");
    assert_eq!(audible(&mut c), vec![a.clone()]);
}

/// R60: a removed output's own wallpaper (shown nowhere else) is ramped out and
/// destroyed; `srcs:*` never targets it.
#[test]
fn remove_output_retires_what_only_it_showed() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let x = color(&mut c, [0, 255, 0]);
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-1:main.content", "value": x}),
    );
    let sv = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-2:main.content", "value": sv}),
    );
    for _ in 0..3 {
        c.step(16);
    }
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    assert_eq!(
        srcs_targets(&mut c, "gain.user", json!(-3)),
        vec![x.clone()]
    );
    c.step(16);
    assert!(exists(&mut c, &sv), "ramping, not cut");
    let ac = get(&mut c, &format!("{sv}.gain.anticlick"))["result"]["value"]
        .as_f64()
        .unwrap();
    assert!(ac < -1.0 && ac > -96.0, "mid-ramp anticlick {ac}");
    c.step(16);
    c.step(16);
    assert!(!exists(&mut c, &sv), "destroyed after its ramp");
    let p = c.ok("probe", json!({"name": "sources"}));
    assert!(
        !p["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == sv),
        "{p}"
    );
    assert_eq!(
        content(&mut c, "VIRTUAL-1"),
        x,
        "the other output is untouched"
    );
}

/// R60: with no output left the current wallpaper is parked (paused, silent, reachable by
/// `srcs:*`); the next output shows it and it plays again.
#[test]
fn remove_all_outputs_parks_and_readd_resumes() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let sv = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &sv);
    for _ in 0..3 {
        c.step(16);
    }
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-1"}));
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    for _ in 0..3 {
        c.step(16);
    }
    assert!(exists(&mut c, &sv), "parked, not destroyed");
    assert_eq!(
        get(&mut c, &format!("{sv}.paused"))["result"]["value"],
        json!(true)
    );
    assert_eq!(
        c.ok("state", json!({}))["graph"][&sv]["gain_effective_db"],
        json!(-96.0),
        "parked = silent"
    );
    assert_eq!(
        srcs_targets(&mut c, "gain.user", json!(-4)),
        vec![sv.clone()]
    );
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 320, "height": 180, "hz": 60}),
    );
    assert_eq!(
        content(&mut c, "VIRTUAL-3"),
        sv,
        "the parked wallpaper is shown"
    );
    for _ in 0..3 {
        c.step(16);
    }
    assert_eq!(
        get(&mut c, &format!("{sv}.paused"))["result"]["value"],
        json!(false)
    );
    let st = c.ok("state", json!({}));
    assert_eq!(st["graph"][&sv]["gain_effective_db"], json!(-4.0), "{st}");
    let t1 = c.ok("probe", json!({"name": "sources"}))["sources"][0]["virtual_t"]
        .as_f64()
        .unwrap();
    c.step(100);
    let t2 = c.ok("probe", json!({"name": "sources"}))["sources"][0]["virtual_t"]
        .as_f64()
        .unwrap();
    assert!(t2 > t1 + 0.05, "it plays again: {t1} → {t2}");
}

/// R60: a transition whose outputs all disappear is committed; its B is parked.
#[test]
fn remove_all_outputs_mid_transition_commits_and_parks_b() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let a = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &a);
    for _ in 0..3 {
        c.step(16);
    }
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&ensure_clip("tr_blue_10s", BLUE_10S)), "loop": true},
               "effect_id": "fade", "duration_ms": 1000}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    let b = r["to"].as_str().unwrap().to_string();
    c.step_until_event(16, 100, "transition.started", &corr);
    c.step(16);
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-1"}));
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    let evs = c.step_until_event(16, 20, "transition.done", &corr);
    let handoff = evs
        .iter()
        .find(|e| e["event"] == "transition.handoff" && e["corr"] == corr)
        .unwrap_or_else(|| panic!("no handoff: {evs:?}"));
    assert_eq!(handoff["committed"], json!(true), "{handoff}");
    for _ in 0..3 {
        c.step(16);
    }
    assert!(!exists(&mut c, &a), "A destroyed");
    assert!(exists(&mut c, &b), "B parked");
    assert_eq!(
        get(&mut c, &format!("{b}.paused"))["result"]["value"],
        json!(true)
    );
    assert_eq!(srcs_targets(&mut c, "gain.user", json!(0)), vec![b.clone()]);
    assert!(audible(&mut c).is_empty());
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 320, "height": 180, "hz": 60}),
    );
    for _ in 0..3 {
        c.step(16);
    }
    assert_eq!(content(&mut c, "VIRTUAL-3"), b);
    assert_eq!(audible(&mut c), vec![b]);
}

/// Item 10: `destroy` of an audible source ramps it to silence before it goes.
#[test]
fn destroy_ramps_audible_source_out() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let serial = srv._serial.take();
    drop(srv);
    let srv = Serve::spawn_in(new_root(), &["--clock", "real"], serial);
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["source."]}));
    let id = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S))}),
    );
    show_all(&mut c, &id);
    let t = Instant::now();
    while !c
        .events
        .iter()
        .any(|e| e["event"] == "source.ready" && e["id"] == id)
    {
        assert!(t.elapsed() < Duration::from_secs(5), "never ready");
        let evs = c.drain_events();
        c.events.extend(evs);
    }
    std::thread::sleep(Duration::from_millis(200));
    c.ok("destroy", json!({ "id": id }));
    let mut seen = Vec::new();
    let t = Instant::now();
    loop {
        let r = get(&mut c, &format!("{id}.gain.anticlick"));
        if r["ok"] != json!(true) {
            break;
        }
        seen.push(r["result"]["value"].as_f64().unwrap());
        assert!(
            t.elapsed() < Duration::from_secs(2),
            "never destroyed: {seen:?}"
        );
    }
    assert!(
        seen.iter().any(|v| *v < -0.5 && *v > -95.0),
        "no ramp seen between destroy and removal: {seen:?}"
    );
    let t = Instant::now();
    let teardown = loop {
        let l = c.ok("logs", json!({"kind_prefix": "source.teardown"}));
        if let Some(e) = l["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == id)
        {
            break e.clone();
        }
        assert!(t.elapsed() < Duration::from_secs(2), "no source.teardown");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        teardown["gain_db"].as_f64().unwrap() <= -95.9,
        "torn down while audible: {teardown}"
    );
}

/// Item 14: create + destroy at once, 20× (destroyed before the VO is up), never stalls
/// the loop and leaves nothing behind.
#[test]
fn rapid_create_destroy_never_stalls() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let serial = srv._serial.take();
    drop(srv);
    let srv = Serve::spawn_in(new_root(), &["--clock", "real"], serial);
    let mut c = srv.client();
    let clip = ensure_clip("tr_red_10s", RED_10S);
    c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
    for _ in 0..20 {
        let id = create_src(&mut c, json!({"path": s(&clip)}));
        show_all(&mut c, &id);
        c.ok("destroy", json!({ "id": id }));
    }
    let t = Instant::now();
    loop {
        let p = c.ok("probe", json!({"name": "sources"}));
        if p["sources"].as_array().unwrap().is_empty() && p["dying"] == json!(0) {
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(5), "left behind: {p}");
        std::thread::sleep(Duration::from_millis(20));
    }
    let lp = c.ok("probe", json!({"name": "loop"}));
    // Opening is synchronous (mpv init — a known cost, reported apart as max_open_ms);
    // everything else, teardown included, stays under the bound.
    let busy = lp["max_busy_excl_open_ms"].as_f64().unwrap();
    println!(
        "rapid create/destroy: max busy {busy:.2} ms excl. opens (opens ≤ {} ms)",
        lp["max_open_ms"]
    );
    assert!(busy < 8.0, "loop busy {busy} ms: {lp}");
}

/// Item 8: a client's requests after a pending `step` are answered after it — a pipelined
/// step + capture captures the post-step frame.
#[test]
fn pipelined_step_then_capture() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    // A video on VIRTUAL-2 makes every step wait for its frame (a deferred reply).
    let v = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 }))}),
    );
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-2:main.content", "value": v}),
    );
    c.step(16);
    let id = color(&mut c, [0, 255, 0]);
    let p = srv.path("pipe.png");
    let batch = format!(
        "{}\n{}\n{}\n",
        json!({"id": 101, "cmd": "set", "args": {"path": "lay:VIRTUAL-1:main.content", "value": id}}),
        json!({"id": 102, "cmd": "step", "args": {"ms": 16}}),
        json!({"id": 103, "cmd": "capture", "args": {"target": "out:VIRTUAL-1", "path": s(&p)}}),
    );
    c.w.write_all(batch.as_bytes()).unwrap();
    let mut ids = Vec::new();
    while ids.len() < 3 {
        let m = c.read_msg().expect("reply");
        if m.get("event").is_none() {
            assert_eq!(m["ok"], json!(true), "{m}");
            ids.push(m["id"].as_u64().unwrap());
        }
    }
    assert_eq!(ids, [101, 102, 103], "replies in request order");
    near(
        png_pixel(&p, 320, 180),
        [0, 255, 0],
        1,
        "capture after the step",
    );
}

/// Item 8: a client that half-closes after a `step` still gets the (deferred) reply.
#[test]
fn half_closed_client_gets_step_reply() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let id = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 }))}),
    );
    show_all(&mut c, &id);
    c.step(16);
    let mut h = srv.client();
    h.w.write_all(format!("{}\n", json!({"id": 7, "cmd": "step", "args": {"ms": 500}})).as_bytes())
        .unwrap();
    h.w.shutdown(std::net::Shutdown::Write).unwrap();
    let m = h
        .read_msg()
        .expect("the deferred step reply before the close");
    assert_eq!(
        (m["id"].clone(), m["ok"].clone()),
        (json!(7), json!(true)),
        "{m}"
    );
    assert!(h.read_msg().is_none(), "closed after the reply");
}

/// Item 4: two servers started at once on one socket → exactly one serves; the other
/// names it.
#[test]
fn concurrent_starts_one_serves() {
    let Some(_srv) = Serve::start() else { return };
    for round in 0..5 {
        let root = new_root();
        let mut a = serve_cmd(&root, &[])
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut b = serve_cmd(&root, &[])
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // The loser exits quickly; the winner keeps serving.
        let t = Instant::now();
        let (loser, mut winner) = loop {
            if let Some(st) = a.try_wait().unwrap() {
                break ((a, st), b);
            }
            if let Some(st) = b.try_wait().unwrap() {
                break ((b, st), a);
            }
            assert!(
                t.elapsed() < Duration::from_secs(10),
                "round {round}: both still up"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        let (mut lchild, lst) = loser;
        let mut err = String::new();
        lchild
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut err)
            .unwrap();
        assert!(!lst.success(), "round {round}: loser exit {lst}");
        let sock = root.join("run/livepaper/lp-player.sock");
        let t = Instant::now();
        let mut c = loop {
            if let Ok(s) = UnixStream::connect(&sock) {
                drop(s);
                break Client::connect(&sock);
            }
            assert!(
                winner.try_wait().unwrap().is_none(),
                "round {round}: winner died too; loser said {err}"
            );
            assert!(
                t.elapsed() < Duration::from_secs(10),
                "round {round}: no socket"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        let pid = c.ok("hello", json!({}))["pid"].as_u64().unwrap();
        assert_eq!(pid, winner.id() as u64);
        assert!(
            err.contains(&format!("already running (pid {pid})")),
            "round {round}: {err}"
        );
        let _ = winner.kill();
        let _ = winner.wait();
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Item 15: SIGTERM is a clean quit — exit 0, socket and lock file removed.
#[test]
fn sigterm_is_a_clean_exit() {
    let Some(mut srv) = Serve::start() else {
        return;
    };
    let mut c = srv.client();
    let id = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S))}),
    );
    show_all(&mut c, &id);
    c.step(16);
    let lock = srv.sock.with_extension("lock");
    assert!(lock.exists(), "lock file next to the socket");
    let pid = srv.child.as_ref().unwrap().id() as i32;
    unsafe { libc::kill(pid, libc::SIGTERM) };
    let st = srv
        .wait_exit(Duration::from_secs(5))
        .expect("no exit on SIGTERM");
    assert!(st.success(), "{st}");
    assert!(!srv.sock.exists(), "socket left behind");
    assert!(!lock.exists(), "lock left behind");
}

/// Item 15: a source capture is upright (top-red / bottom-blue clip).
#[test]
fn source_capture_is_upright() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let clip = ensure_clip(
        "split_red_over_blue",
        ClipSpec::SplitV {
            top: [255, 0, 0],
            bottom: [0, 0, 255],
            secs: 1.0,
        },
    );
    let id = create_src(&mut c, json!({ "path": s(&clip) }));
    show_all(&mut c, &id);
    c.step(16);
    c.step(16);
    let p = srv.path("split.png");
    let r = c.ok("capture", json!({"target": id, "path": s(&p)}));
    let h = r["height"].as_u64().unwrap() as u32;
    near(png_pixel(&p, 100, 10), [255, 0, 0], 3, "source capture top");
    near(
        png_pixel(&p, 100, h - 10),
        [0, 0, 255],
        3,
        "source capture bottom",
    );
    let p2 = srv.path("split_out.png");
    c.ok(
        "capture",
        json!({"target": "out:VIRTUAL-1", "path": s(&p2)}),
    );
    near(png_pixel(&p2, 320, 10), [255, 0, 0], 3, "output top");
    near(png_pixel(&p2, 320, 350), [0, 0, 255], 3, "output bottom");
}

/// Items 6, 11, 12: effect ids checked on create/set too; animate's `from`/`unit`
/// checked; `srcs:<connector>` on an idle output is an empty broadcast.
#[test]
fn validation_round_1() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let e = c.err(
        "create",
        json!({"kind": "effect", "props": {"effect_id": "no_such_effect_xyz"}}),
    );
    assert_eq!(e["code"], "no_such_effect", "{e}");
    let fx = c.ok(
        "create",
        json!({"kind": "effect", "props": {"effect_id": "fade"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let e = c.err(
        "set",
        json!({"path": format!("{fx}.effect_id"), "value": "nope_xyz"}),
    );
    assert_eq!(e["code"], "no_such_effect", "{e}");
    assert!(e["hint"].as_str().unwrap().contains("effects"), "{e}");
    c.ok(
        "set",
        json!({"path": format!("{fx}.effect_id"), "value": "fade"}),
    );

    let e = c.err(
        "animate",
        json!({"path": "lay:VIRTUAL-1:main.opacity", "to": 0.5, "from": 2.0, "duration_ms": 10}),
    );
    assert_eq!(e["code"], "out_of_range", "{e}");
    let e = c.err(
        "animate",
        json!({"path": "lay:VIRTUAL-1:main.opacity", "to": 0.5, "duration_ms": 10, "unit": "gain_linear"}),
    );
    assert_eq!(e["code"], "bad_request", "{e}");

    let r = c.ok(
        "set",
        json!({"path": "srcs:VIRTUAL-1.gain.user", "value": -2}),
    );
    assert_eq!(r["targets"], json!([]));
    let e = c.err("set", json!({"path": "srcs:NOPE.gain.user", "value": -2}));
    assert_eq!(e["code"], "no_such_node", "{e}");
}

/// Item 9: `ctl` gives up after `--timeout-ms` with a timeout error (and a hint).
#[test]
fn ctl_times_out() {
    let root = new_root();
    let sock = root.join("hang.sock");
    let _l = std::os::unix::net::UnixListener::bind(&sock).unwrap(); // accepts, never answers
    let t = Instant::now();
    let out = Command::new(BIN)
        .args(["ctl", "--timeout-ms", "300", "hello"])
        .env("LP_PLAYER_SOCKET", &sock)
        .output()
        .unwrap();
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    assert_eq!(out.status.code(), Some(1));
    let e: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(e["code"], "timeout", "{e}");
    assert!(e["hint"].as_str().unwrap().contains("--timeout-ms"), "{e}");
    let _ = std::fs::remove_dir_all(&root);
}

/// Task 13: the `frames` probe. Headless outputs compose on every tick (policy
/// `every_tick`, never idle): both outputs report paced present intervals at the 60 Hz
/// tick; `reset` clears the windows after reading.
#[test]
fn frames_probe_reports_present_intervals() {
    let Some(srv) = Serve::start_with(&["--clock", "real"]) else {
        return;
    };
    let mut c = srv.client();
    let list = c.ok("probe", json!({"name": "list"}));
    assert!(
        list["probes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "frames"),
        "{list}"
    );
    std::thread::sleep(Duration::from_millis(700));
    let f = c.ok("probe", json!({"name": "frames", "args": {"reset": true}}));
    assert_eq!(f["policy"], "every_tick", "{f}");
    assert_eq!(f["backend"], "headless");
    let outs = f["outputs"].as_array().unwrap();
    let names: Vec<&str> = outs.iter().map(|o| o["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["VIRTUAL-1", "VIRTUAL-2"], "{f}");
    let mut before = 0;
    for o in outs {
        assert_eq!(o["refresh_mhz"], 60_000, "{o}");
        assert!(
            (o["period_ms"].as_f64().unwrap() - 16.667).abs() < 0.01,
            "{o}"
        );
        assert_eq!(o["idle"], false, "headless never idles: {o}");
        let p = &o["paced"];
        let n = p["count"].as_u64().unwrap();
        assert!(n >= 20, "≥ 20 paced intervals in 0.7 s at 60 Hz: {o}");
        let mean = p["mean_ms"].as_f64().unwrap();
        assert!(
            (12.0..=22.0).contains(&mean),
            "mean {mean} ms at a 60 Hz tick: {o}"
        );
        for k in ["p50_ms", "p95_ms", "max_ms"] {
            assert!(p[k].as_f64().unwrap() > 0.0, "{k}: {o}");
        }
        assert!(o["totals"]["presents"].as_u64().unwrap() > n);
        before = before.max(n);
    }
    let f2 = c.ok("probe", json!({"name": "frames"}));
    for o in f2["outputs"].as_array().unwrap() {
        let n = o["paced"]["count"].as_u64().unwrap();
        assert!(
            n < before,
            "reset cleared the window ({n} vs {before}): {o}"
        );
    }
}

/// Task 16 (Task 13 review items a + b): mixed content under the content redraw policy.
/// Headless composes every tick by default, so this forces the Wayland policy with
/// `--redraw-policy content` (no frame callbacks: an output that wants a frame presents on
/// the next loop pass). A 30 fps video on VIRTUAL-1 presents at its frame rate while a
/// static colour on VIRTUAL-2 stays idle — 0 presents — also while an opacity animation
/// runs on VIRTUAL-1's layer only (an animation counts for the outputs showing its node).
#[test]
fn mixed_content_static_output_stays_idle() {
    let Some(srv) = Serve::start_with(&["--clock", "real", "--redraw-policy", "content"]) else {
        return;
    };
    let mut c = srv.client();
    let clip = ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 });
    let v = create_src(&mut c, json!({"path": s(&clip), "loop": true}));
    let blue = color(&mut c, [0, 0, 255]);
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-1:main.content", "value": v}),
    );
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-2:main.content", "value": blue}),
    );
    let t = Instant::now();
    while get(&mut c, &format!("{v}.ready"))["result"]["value"] != json!(true) {
        assert!(t.elapsed() < Duration::from_secs(5), "video never ready");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(400));
    let presents = |f: &Value, o: &str| {
        f["outputs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["name"] == o)
            .unwrap_or_else(|| panic!("no {o}: {f}"))["totals"]["presents"]
            .as_u64()
            .unwrap()
    };
    let window = |c: &mut Client| {
        let f0 = c.ok("probe", json!({"name": "frames"}));
        std::thread::sleep(Duration::from_millis(1000));
        let f1 = c.ok("probe", json!({"name": "frames"}));
        assert_eq!(f1["policy"], "content", "{f1}");
        let d = |o: &str| presents(&f1, o) - presents(&f0, o);
        (d("VIRTUAL-1"), d("VIRTUAL-2"), f1)
    };
    let (video, still, f) = window(&mut c);
    println!("content policy, 1 s: video output {video} presents, colour output {still}");
    assert!(
        (20..=45).contains(&video),
        "a 30 fps clip presents ≈ 30/s, got {video}: {f}"
    );
    assert_eq!(still, 0, "the static colour output stays idle: {f}");
    let v2 = f["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "VIRTUAL-2")
        .unwrap();
    assert_eq!(v2["idle"], true, "{v2}");

    c.ok(
        "animate",
        json!({"path": "lay:VIRTUAL-1:main.opacity", "from": 1.0, "to": 0.5, "duration_ms": 4000}),
    );
    std::thread::sleep(Duration::from_millis(200));
    let (anim, still, f) = window(&mut c);
    println!("opacity animation on VIRTUAL-1, 1 s: {anim} presents there, {still} on VIRTUAL-2");
    assert!(
        anim >= 50,
        "an animating output presents every pass (≥ the 60 Hz tick): {anim}: {f}"
    );
    assert_eq!(
        still, 0,
        "VIRTUAL-1's animation doesn't wake VIRTUAL-2: {f}"
    );
}

/// Task 13: `serve` without `--headless` is the Wayland backend. `--outputs` is
/// headless-only (exit 2), and an unreachable compositor is "not available yet" (Task
/// 16b: exit [`EXIT_NO_COMPOSITOR`], not 1 — 1 is reserved for "never worth retrying",
/// e.g. already running) with a hint, socket + lock removed — never a hang or a panic.
/// `--no-supervise`: this checks the bare child's own behavior; the supervisor's retry
/// of this same exit code has its own test, `tests/supervise.rs::
/// gives_up_without_compositor_after_backoff`. (The real compositor is only touched by
/// `tests/onmachine/outputs.sh`.)
#[test]
fn wayland_serve_args_and_missing_compositor() {
    let root = new_root();
    let run = |args: &[&str]| {
        let mut c = Command::new(BIN);
        die_with_parent(&mut c);
        c.args(args)
            .env("XDG_RUNTIME_DIR", root.join("run"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("WAYLAND_DISPLAY", root.join("no-such-wayland-0"))
            .env_remove("WAYLAND_SOCKET")
            .stdin(Stdio::null())
            .output()
            .expect("run lp-player")
    };
    let out = run(&["serve", "--outputs", "640x360@60"]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{err}");
    assert!(
        err.contains("--outputs only applies with --headless"),
        "{err}"
    );

    let t = Instant::now();
    let out = run(&["serve", "--no-supervise", "--ao", "null"]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(EXIT_NO_COMPOSITOR), "{err}");
    assert!(
        err.contains("can't connect to the Wayland display"),
        "{err}"
    );
    assert!(
        err.contains("--headless"),
        "the hint names the alternative: {err}"
    );
    assert!(t.elapsed() < Duration::from_secs(10), "no hang");
    let sock = root.join("run/livepaper/lp-player.sock");
    assert!(!sock.exists(), "socket left behind");
    assert!(!sock.with_extension("lock").exists(), "lock left behind");
}

// ---------------------------------------------------------------- audio bus (Task 14)

/// The bus fallback (spec §5.3): when the bus can't be created — here PipeWire is
/// unreachable (an empty `PIPEWIRE_RUNTIME_DIR` and a socket name that doesn't exist) —
/// `serve` still runs, logs `audio.bus.down {reason}`, the `bus` probe says `down` with
/// that reason, sources open on the default device (mpv `audio-device` `auto`, no
/// `audio-delay` bias), and the meter reports itself unavailable instead of passing
/// silently. Default AO (`pipewire`, not `null`): that's what would route through the bus.
/// The source is an image (no audio track), so the run stays silent (R26's intent).
#[test]
fn bus_down_falls_back_to_default_device() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let root = new_root();
    let no_pw = root.join("no-pipewire");
    std::fs::create_dir_all(&no_pw).unwrap();
    let srv = Serve::spawn_env(
        root,
        &["--ao", "pipewire"],
        &[
            ("PIPEWIRE_RUNTIME_DIR", no_pw.as_path()),
            (
                "PIPEWIRE_REMOTE",
                Path::new("lp-player-test-no-such-socket"),
            ),
        ],
        Some(serial),
    );
    let mut c = srv.client();

    let down = c.ok("logs", json!({"kind_prefix": "audio.bus."}));
    let evs = down["events"].as_array().unwrap();
    let ev = evs
        .iter()
        .find(|e| e["kind"] == "audio.bus.down")
        .unwrap_or_else(|| panic!("no audio.bus.down logged: {down}"));
    let reason = ev["reason"].as_str().expect("audio.bus.down {reason}");
    assert!(reason.contains("PipeWire"), "reason: {reason}");
    assert!(
        !evs.iter().any(|e| e["kind"] == "audio.bus.up"),
        "bus up although PipeWire is unreachable: {down}"
    );

    let bus = c.ok("probe", json!({"name": "bus"}));
    assert_eq!(bus["state"], "down", "{bus}");
    assert_eq!(bus["reason"], json!(reason), "{bus}");
    assert_eq!(bus["meter"]["available"], json!(false), "{bus}");

    let e = c.err(
        "probe",
        json!({"name": "meter.window", "args": {"last_ms": 1000}}),
    );
    assert_eq!(e["code"], "unsupported", "{e}");
    assert!(
        e["message"].as_str().unwrap().contains("unavailable"),
        "{e}"
    );
    assert!(e["hint"].as_str().unwrap().contains("bus"), "{e}");

    let img = ensure_clip("bus_fallback_image", ClipSpec::Image { rgb: [10, 200, 30] });
    let id = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&img)}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    show_all(&mut c, &id);
    c.step(16);
    let probe = c.ok("probe", json!({"name": "sources"}));
    let src = &probe["sources"][0];
    assert_eq!(src["id"], json!(id), "{probe}");
    assert_eq!(src["mpv_audio_device"], "auto", "{probe}");
    assert_eq!(src["mpv_audio_delay"], json!(0.0), "{probe}");
}

/// `--ao null` (every other test, R26): nothing would play through PipeWire, so no bus is
/// created at all (nothing appears in the owner's session) — `bus` says why.
#[test]
fn ao_null_runs_without_bus() {
    let Some(srv) = Serve::start() else {
        return;
    };
    let mut c = srv.client();
    let bus = c.ok("probe", json!({"name": "bus"}));
    assert_eq!(bus["state"], "down", "{bus}");
    assert!(
        bus["reason"].as_str().unwrap_or("").contains("--ao null"),
        "{bus}"
    );
    let logs = c.ok("logs", json!({"kind_prefix": "audio.bus.down"}));
    assert_eq!(logs["events"].as_array().unwrap().len(), 1, "{logs}");
}

// ---------------------------------------------------------------- Task 16d (R90): the
// fast (>= 1 kHz) gain-only timer, independent of the output refresh.

/// `gain_fast_timer_dense_pushes_at_60hz`'s floor: 5× the 2–3 evaluations a 30 ms ramp
/// gets from a 60 Hz main timer alone.
const MIN_FAST_PUSHES: u64 = 15;

/// R90: a 30 ms anti-click gain ramp must land as a genuinely dense push sequence, not
/// the 1-2 `Animator::tick` evaluations a 60 Hz main tick alone would give it (Task
/// 16c's measured residual: held steps then an abrupt final jump). `--clock real`, the
/// default headless outputs (`640x360@60,320x180@60`) — 60 Hz, same as the brief's own
/// acceptance line. A colour source needs no mpv/audio device at all, so this is a pure,
/// fast check of the push *mechanism* (graph.set + forward), independent
/// of real audio hardware (the on-machine `dropout.sh` covers the real-audio case).
#[test]
fn gain_fast_timer_dense_pushes_at_60hz() {
    let Some(srv) = Serve::start_with(&["--clock", "real"]) else {
        return;
    };
    let mut c = srv.client();
    let id = color(&mut c, [255, 0, 0]);

    // Idle before any gain animation exists: never armed.
    let idle = c.ok("probe", json!({"name": "loop"}));
    assert_eq!(idle["gain_timer_armed"], json!(false), "{idle}");

    c.ok(
        "animate",
        json!({"path": format!("{id}.gain.anticlick"), "from": 0.0, "to": 1.0,
               "duration_ms": 30, "unit": "gain_linear"}),
    );

    // Give the ramp (30 ms) + a generous margin time to fully run and self-disarm.
    std::thread::sleep(Duration::from_millis(150));

    let lp = c.ok("probe", json!({"name": "loop"}));
    let pushes = lp["gain_pushes"].as_u64().expect("gain_pushes");
    println!("R90: {pushes} gain pushes over a 30 ms ramp at 60 Hz output: {lp}");
    // Unloaded: 29–30 (one per ms). The bound is what proves R90 — the main timer alone
    // gives a 30 ms ramp at most 2–3 evaluations at 60 Hz — while tolerating the single
    // loop thread being busy for a few ms at a time on a loaded machine (a late fire
    // pushes the value for *now*, it just skips the missed ms): measured once in seven
    // full `tests/api.rs` runs with the owner's desktop busy, < 25 (Task 16d).
    assert!(
        pushes >= MIN_FAST_PUSHES,
        "expected >= {MIN_FAST_PUSHES} distinct pushes, got {pushes}: {lp}"
    );
    assert!(
        lp["gain_ticks"].as_u64().unwrap() >= pushes,
        "fast-tick count must be >= pushes: {lp}"
    );

    let recent = lp["recent_gain_pushes"]
        .as_array()
        .expect("recent_gain_pushes");
    let dbs: Vec<f64> = recent.iter().map(|p| p[1].as_f64().unwrap()).collect();
    let distinct: std::collections::BTreeSet<i64> =
        dbs.iter().map(|db| (db * 1e6) as i64).collect();
    assert!(
        distinct.len() >= MIN_FAST_PUSHES as usize,
        "expected >= {MIN_FAST_PUSHES} distinct values, got {}: {dbs:?}",
        distinct.len()
    );
    // M6 (final review): the count above can't tell 500 Hz from 1 kHz — the median
    // interval between consecutive pushes can: ≤ 1.5 ms (1 kHz; a 500 Hz timer is 2 ms).
    let ts: Vec<f64> = recent.iter().map(|p| p[0].as_f64().unwrap()).collect();
    let mut gaps: Vec<f64> = ts.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = gaps[gaps.len() / 2];
    println!(
        "R90: median inter-push interval {median:.3} ms over {} gaps",
        gaps.len()
    );
    assert!(
        median <= 1.5,
        "median inter-push interval {median:.3} ms > 1.5 ms (not a 1 kHz timer): {ts:?}"
    );
    // A linear-amplitude ramp to 0 dB (unity) is monotonically increasing in dB too.
    for w in dbs.windows(2) {
        assert!(w[1] >= w[0] - 1e-9, "not monotonic: {dbs:?}");
    }
    assert!(
        (*dbs.last().unwrap() - 0.0).abs() < 1e-6,
        "must settle at 0 dB: {dbs:?}"
    );

    // Self-disarm: nothing left to drive.
    assert_eq!(
        lp["gain_timer_armed"],
        json!(false),
        "must disarm once the ramp finished: {lp}"
    );
    assert_eq!(
        get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"],
        json!(0.0)
    );
}

/// R90: while `player.paused`, the fast gain timer must make no progress at all on an
/// in-flight ramp — `Runtime::now` is frozen (R75/invariant #7), so re-evaluating with
/// an unchanged `now` must push nothing new. Resuming must let it continue and finish.
#[test]
fn gain_fast_timer_paused_makes_no_progress() {
    let Some(srv) = Serve::start_with(&["--clock", "real"]) else {
        return;
    };
    let mut c = srv.client();
    let id = color(&mut c, [0, 255, 0]);

    c.ok(
        "animate",
        json!({"path": format!("{id}.gain.anticlick"), "from": 0.0, "to": 1.0,
               "duration_ms": 300, "unit": "gain_linear"}),
    );
    // Let it get genuinely under way before pausing.
    std::thread::sleep(Duration::from_millis(60));
    c.ok("set", json!({"path": "player.paused", "value": true}));
    // Settle past the pause edge itself (the fast timer may legitimately fire once
    // more, still unpaused, if it was already queued in the same dispatch batch as the
    // `set` — the same race `drive_pause_gates_pre_sync`'s own doc describes for R88's
    // gate) before taking the "now it's frozen" baseline below.
    std::thread::sleep(Duration::from_millis(30));

    let before = c.ok("probe", json!({"name": "loop"}));
    let pushes_baseline = before["gain_pushes"].as_u64().unwrap();
    let value_baseline = get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"]
        .as_f64()
        .unwrap();
    // M1 (final review): a gain animation frozen by the player pause isn't moving — the
    // 1 kHz timer disarms for the pause instead of firing 1000×/s for nothing.
    assert!(
        before["gain_timer_armed"] == json!(false),
        "paused mid-ramp: the fast timer must be disarmed: {before}"
    );

    // Sample repeatedly across a 160 ms window: every sample must match the settled
    // baseline exactly (frozen `now()` is bit-for-bit deterministic, R75) — not just the
    // first and last point, which would miss a slow trickle a single before/after pair
    // could average away.
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(20));
        let v = get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"]
            .as_f64()
            .unwrap();
        let p = c.ok("probe", json!({"name": "loop"}))["gain_pushes"]
            .as_u64()
            .unwrap();
        assert_eq!(p, pushes_baseline, "no new pushes while paused");
        let armed = c.ok("probe", json!({"name": "loop"}))["gain_timer_armed"].clone();
        assert_eq!(armed, json!(false), "still disarmed while paused");
        assert!(
            (v - value_baseline).abs() < 1e-9,
            "gain.anticlick must not move while paused: {value_baseline} vs {v}"
        );
    }

    c.ok("set", json!({"path": "player.paused", "value": false}));
    let t = Instant::now();
    loop {
        let v = get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"]
            .as_f64()
            .unwrap();
        if (v - 0.0).abs() < 1e-6 {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_secs(2),
            "ramp never finished resuming"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(20));
    let done = c.ok("probe", json!({"name": "loop"}));
    assert!(
        done["gain_pushes"].as_u64().unwrap() > pushes_baseline,
        "resume must push new values: {done}"
    );
    assert_eq!(
        done["gain_timer_armed"],
        json!(false),
        "disarmed once finished: {done}"
    );
}

/// UI × player-state matrix: a user setting ramped while the player is paused lands —
/// the backend mutes with `animate srcs:*.gain.mute` over 30 ms, and on the pause-excised
/// clock that ramp stood still until the resume (a keybind mute while paused reached no
/// source; at the resume it raced the pause gate's ramp-in). Setting slots (user/override/
/// normalize/mute/automute) ramp on the unpaused clock; the recipe's own slots stay frozen.
#[test]
fn setting_gain_ramp_lands_while_paused() {
    let Some(srv) = Serve::start_with(&["--clock", "real"]) else {
        return;
    };
    let mut c = srv.client();
    let id = color(&mut c, [0, 255, 0]);
    c.ok("set", json!({"path": "player.paused", "value": true}));
    std::thread::sleep(Duration::from_millis(30));
    c.ok(
        "animate",
        json!({"path": format!("{id}.gain.mute"), "to": -96.0, "duration_ms": 30}),
    );
    c.ok(
        "animate",
        json!({"path": format!("{id}.gain.user"), "to": -6.0, "duration_ms": 30}),
    );
    c.ok(
        "animate",
        json!({"path": format!("{id}.gain.anticlick"), "to": -40.0, "duration_ms": 30}),
    );
    let read = |c: &mut Client, slot: &str| {
        get(c, &format!("{id}.gain.{slot}"))["result"]["value"]
            .as_f64()
            .unwrap()
    };
    wait_for(
        Duration::from_secs(1),
        "gain.mute/user to land while paused",
        || {
            ((read(&mut c, "mute") + 96.0).abs() < 1e-6
                && (read(&mut c, "user") + 6.0).abs() < 1e-6)
                .then_some(())
        },
    );
    // the recipe's slot keeps the player clock: still where it was while paused
    std::thread::sleep(Duration::from_millis(60));
    assert!(
        read(&mut c, "anticlick").abs() < 1e-6,
        "anticlick moved while paused"
    );
    c.ok("set", json!({"path": "player.paused", "value": false}));
    wait_for(Duration::from_secs(1), "anticlick after the resume", || {
        ((read(&mut c, "anticlick") + 40.0).abs() < 1e-6).then_some(())
    });
    std::thread::sleep(Duration::from_millis(20));
    let done = c.ok("probe", json!({"name": "loop"}));
    assert_eq!(
        done["gain_timer_armed"],
        json!(false),
        "disarmed once finished: {done}"
    );
}

// ---------------------------------------------------------------- final review fixes

/// Poll `f` every 5 ms until it returns `Some`, failing after `limit`.
fn wait_for<T>(limit: Duration, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let t = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(
            t.elapsed() < limit,
            "timed out after {limit:?} waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn f64_of(c: &mut Client, path: &str) -> Option<f64> {
    get(c, path)["result"]["value"].as_f64()
}

/// A real-clock server (`extra` appended, e.g. `--log-level debug`).
fn real_serve(extra: &[&str]) -> Option<Serve> {
    let mut srv = Serve::start()?;
    let serial = srv._serial.take();
    drop(srv);
    let mut args = vec!["--clock", "real"];
    args.extend_from_slice(extra);
    Some(Serve::spawn_in(new_root(), &args, serial))
}

/// Wait until `id` has played past `t` seconds.
fn wait_playing(c: &mut Client, id: &str, t: f64) {
    wait_for(Duration::from_secs(5), "playback", || {
        (f64_of(c, &format!("{id}.time_pos")).unwrap_or(0.0) >= t).then_some(())
    });
}

fn mpv_pause_of(c: &mut Client, id: &str) -> Option<String> {
    let p = c.ok("probe", json!({"name": "sources"}));
    p["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == json!(id))
        .and_then(|s| s["mpv_pause"].as_str().map(str::to_string))
}

/// C1 (final review): 200 create → transition → destroy cycles; every per-source
/// collection the `loop` probe's `bounds` reports stays bounded — `GainHistory` (tracks
/// and samples) by its caps, everything else back to a handful.
#[test]
fn c1_long_run_switches_stay_bounded() {
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    let first = color(&mut c, [10, 10, 10]);
    show_all(&mut c, &first);
    for i in 0..200u32 {
        let rgb = [(i % 250) as u8, 0, 255 - (i % 250) as u8];
        let corr = c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"kind": "color", "color": rgb},
                   "effect_id": null}),
        )["corr"]
            .as_str()
            .unwrap()
            .to_string();
        wait_for(Duration::from_secs(5), "transition done", || {
            let st = c.ok("state", json!({}));
            let live = st["transitions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["corr"] == json!(corr));
            (!live).then_some(())
        });
        if i % 10 == 9 {
            // and an explicit destroy of something created and never shown
            let x = color(&mut c, [1, 2, 3]);
            c.ok("destroy", json!({ "id": x }));
        }
    }
    std::thread::sleep(Duration::from_millis(200));
    let b = c.ok("probe", json!({"name": "loop"}))["bounds"].clone();
    println!("C1 bounds after 200 switches: {b}");
    let n = |k: &str| b[k].as_u64().unwrap_or_else(|| panic!("bounds.{k}: {b}"));
    // GainHistory: dead tracks linger (post-roll analysis) but never past the caps.
    assert!(n("gain_history_tracks") <= 64, "{b}");
    assert!(n("gain_history_samples") <= 131_072, "{b}");
    // The graph holds 2 outputs + 2 layers + the player + the one current source.
    assert!(n("graph_nodes") <= 8, "{b}");
    for k in [
        "anim_entries",
        "teardown_anim_entries",
        "pending_destroy",
        "onsets",
        "fade_in",
        "pause_gates",
        "transitions",
        "graves",
        "ended",
        "restore_onsets",
        "dying",
        "open_queued",
    ] {
        assert!(n(k) <= 4, "bounds.{k} grew: {b}");
    }
    assert!(n("hosted") <= 2, "{b}");
    assert!(n("last_event") <= 4, "{b}");
    assert!(n("dropout_windows") <= 64, "{b}");
}

/// I1 (final review): `stop` ends the session's pause — pause → stop → a new switch plays
/// and is audible (legacy semantics), and the stop's teardown finishes while paused.
#[test]
fn i1_pause_stop_then_switch_plays() {
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    let a = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);
    c.ok("set", json!({"path": "player.paused", "value": true}));
    wait_for(Duration::from_secs(2), "A paused", || {
        (mpv_pause_of(&mut c, &a).as_deref() == Some("yes")).then_some(())
    });
    c.ok("stop", json!({}));
    assert_eq!(
        get(&mut c, "player.paused")["result"]["value"],
        json!(false),
        "stop clears player.paused"
    );
    // The teardown completed although the player had been paused.
    wait_for(Duration::from_secs(2), "A torn down", || {
        let p = c.ok("probe", json!({"name": "sources"}));
        p["sources"].as_array().unwrap().is_empty().then_some(())
    });
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&ensure_clip("tr_blue_10s", BLUE_10S)),
               "loop": true}, "effect_id": "fade", "duration_ms": 200}),
    );
    let b = r["to"].as_str().unwrap().to_string();
    wait_playing(&mut c, &b, 0.5);
    wait_for(Duration::from_secs(2), "B audible", || {
        let st = c.ok("state", json!({}));
        (st["graph"][&b]["gain_effective_db"] == json!(0.0)).then_some(())
    });
    assert_eq!(mpv_pause_of(&mut c, &b).as_deref(), Some("no"));
    assert_eq!(content(&mut c, "VIRTUAL-1"), b);
}

/// I2 (a): a source waiting on a pending `align: end` switch (the advance-on-end mode)
/// is playing and audible — a pause ramps it out (gain.pause mid-ramp while mpv still
/// plays) and a resume ramps it back in, never an unramped cut or onset. The pending
/// switch stays pending throughout.
#[test]
fn i2_pause_while_align_end_pending_is_ramped_both_ways() {
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    let a = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);
    let corr = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": s(&ensure_clip("tr_blue_10s", BLUE_10S))},
               "effect_id": "fade", "duration_ms": 500, "align": "end"}),
    )["corr"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for(Duration::from_secs(5), "waiting_start", || {
        let st = c.ok("state", json!({}));
        (st["transitions"][0]["phase"] == json!("waiting_start")).then_some(())
    });
    c.ok("set", json!({"path": "player.paused", "value": true}));
    let mut mid_down = false;
    wait_for(Duration::from_secs(2), "A paused", || {
        let g = f64_of(&mut c, &format!("{a}.gain.pause")).unwrap_or(0.0);
        let paused = mpv_pause_of(&mut c, &a).as_deref() == Some("yes");
        if !paused && g < -0.5 && g > -95.0 {
            mid_down = true;
        }
        if paused {
            assert!(g <= -95.9, "paused before the ramp reached silence: {g}");
        }
        paused.then_some(())
    });
    assert!(mid_down, "A paused without a ramp (an unramped cut)");
    c.ok("set", json!({"path": "player.paused", "value": false}));
    let mut mid_up = false;
    wait_for(Duration::from_secs(2), "A back", || {
        let g = f64_of(&mut c, &format!("{a}.gain.pause")).unwrap_or(-96.0);
        if g > -95.0 && g < -0.5 {
            mid_up = true;
        }
        (g.abs() < 1e-6).then_some(())
    });
    assert!(mid_up, "A resumed without a ramp (an unramped onset)");
    let st = c.ok("state", json!({}));
    assert_eq!(st["transitions"][0]["corr"], json!(corr));
    assert_eq!(
        st["transitions"][0]["phase"],
        json!("waiting_start"),
        "{st}"
    );
    assert_eq!(st["graph"][&a]["gain_effective_db"], json!(0.0), "{st}");
}

/// `KeepPauseOnSwitch` (the backend's "stay paused" on a user switch): a cut requested while
/// the player is paused swaps at once and B shows its first frame, still paused. A's 30 ms
/// anti-click ramp ran on the frozen clock, so the swap — and the picture — waited for the
/// resume; an A the pause gate already holds silent needs no ramp. Then a second cut while
/// still paused (A = the first cut's B), and a cut that interrupts a paused fade.
#[test]
fn cut_while_paused_swaps_at_once() {
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);
    c.ok("set", json!({"path": "player.paused", "value": true}));
    wait_for(Duration::from_secs(2), "A gated and paused", || {
        (mpv_pause_of(&mut c, &a).as_deref() == Some("yes")).then_some(())
    });
    let mut prev = a.clone();
    for (path, effect) in [(&blue, Value::Null), (&red, Value::Null)] {
        let r = c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"path": path, "loop": true}, "effect_id": effect}),
        );
        let b = r["to"].as_str().unwrap().to_string();
        wait_for(
            Duration::from_secs(2),
            "the cut to swap while paused",
            || {
                let st = c.ok("state", json!({}));
                let shows = ["lay:VIRTUAL-1:main", "lay:VIRTUAL-2:main"]
                    .iter()
                    .all(|l| st["graph"][l]["content"] == json!(b));
                (shows && st["graph"][&prev].is_null()).then_some(())
            },
        );
        assert_eq!(get(&mut c, "player.paused")["result"]["value"], json!(true));
        assert_eq!(
            mpv_pause_of(&mut c, &b).as_deref(),
            Some("yes"),
            "B plays while paused"
        );
        prev = b;
    }
    // a paused fade, then a cut: the fade commits, the cut swaps, nothing waits for the resume
    c.ok("set", json!({"path": "player.paused", "value": false}));
    wait_playing(&mut c, &prev, 0.3);
    c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": blue, "loop": true}, "effect_id": "fade", "duration_ms": 3000}),
    );
    wait_for(Duration::from_secs(5), "the fade running", || {
        let st = c.ok("state", json!({}));
        (st["transitions"][0]["phase"] == json!("running")).then_some(())
    });
    c.ok("set", json!({"path": "player.paused", "value": true}));
    std::thread::sleep(Duration::from_millis(150));
    let b = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": red, "loop": true}, "effect_id": null}),
    )["to"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for(
        Duration::from_secs(2),
        "the cut over a paused fade to swap",
        || {
            let st = c.ok("state", json!({}));
            let shows = ["lay:VIRTUAL-1:main", "lay:VIRTUAL-2:main"]
                .iter()
                .all(|l| st["graph"][l]["content"] == json!(b));
            let effects = st["graph"]
                .as_object()
                .unwrap()
                .values()
                .any(|n| n["kind"] == json!("effect"));
            (shows && !effects).then_some(())
        },
    );
    // and it all plays again on the resume
    c.ok("set", json!({"path": "player.paused", "value": false}));
    wait_for(Duration::from_secs(3), "B audible after the resume", || {
        let st = c.ok("state", json!({}));
        (st["graph"][&b]["gain_effective_db"] == json!(0.0)).then_some(())
    });
}

/// I2 (b): pause mid-gate, then a switch that fails / is cancelled / is superseded while
/// paused — after the resume nothing that plays is left silent (no `anticlick` −96 on a
/// playing source), and the current wallpaper is audible.
#[test]
fn i2_switch_while_gated_never_leaves_a_playing_source_silent() {
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);
    for case in ["failed", "cancelled", "superseded"] {
        c.ok("set", json!({"path": "player.paused", "value": true}));
        let cur = content(&mut c, "VIRTUAL-1");
        wait_for(Duration::from_secs(2), "gated", || {
            (mpv_pause_of(&mut c, &cur).as_deref() == Some("yes")).then_some(())
        });
        match case {
            "failed" => {
                c.ok(
                    "transition",
                    json!({"outputs": "out:*", "to": {"path": "/no/such/file.mkv"},
                           "effect_id": "fade", "duration_ms": 300, "method": "reveal"}),
                );
                std::thread::sleep(Duration::from_millis(300));
            }
            "cancelled" => {
                let corr = c.ok(
                    "transition",
                    json!({"outputs": "out:*", "to": {"path": blue, "loop": true},
                           "effect_id": "fade", "duration_ms": 400}),
                )["corr"]
                    .as_str()
                    .unwrap()
                    .to_string();
                std::thread::sleep(Duration::from_millis(300));
                c.ok("cancel", json!({ "corr": corr }));
            }
            _ => {
                c.ok(
                    "transition",
                    json!({"outputs": "out:*", "to": {"path": blue, "loop": true},
                           "effect_id": "fade", "duration_ms": 400, "method": "reveal",
                           "align": "end"}),
                );
                std::thread::sleep(Duration::from_millis(100));
                c.ok(
                    "transition",
                    json!({"outputs": "out:*", "to": {"path": red, "loop": true},
                           "effect_id": null}),
                );
            }
        }
        std::thread::sleep(Duration::from_millis(100));
        c.ok("set", json!({"path": "player.paused", "value": false}));
        // Every transition settles; then whatever is shown plays at 0 dB.
        wait_for(Duration::from_secs(5), "settled", || {
            let st = c.ok("state", json!({}));
            st["transitions"]
                .as_array()
                .unwrap()
                .is_empty()
                .then_some(())
        });
        std::thread::sleep(Duration::from_millis(300));
        let st = c.ok("state", json!({}));
        let shown = content(&mut c, "VIRTUAL-1");
        assert_eq!(
            st["graph"][&shown]["gain_effective_db"],
            json!(0.0),
            "{case}: the current wallpaper must be audible: {st}"
        );
        for (id, n) in st["graph"].as_object().unwrap() {
            if n.get("gain_effective_db").is_some() && n["paused"] == json!(false) {
                assert!(
                    n["gain_effective_db"].as_f64().unwrap() > -95.0,
                    "{case}: {id} plays at −96 (a gate left its slot silent): {st}"
                );
            }
        }
        assert_eq!(
            mpv_pause_of(&mut c, &shown).as_deref(),
            Some("no"),
            "{case}"
        );
    }
}

/// I4 (final review): with no output at all, `transition` is accepted — each target
/// replaces the parked wallpaper — and when an output comes back the LAST target is shown
/// and plays; an `align: end` request made meanwhile hands off only then.
#[test]
fn i4_transitions_while_no_output_replace_the_parked_wallpaper() {
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-1"}));
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    std::thread::sleep(Duration::from_millis(100));
    let mut last = String::new();
    let mut corrs = Vec::new();
    for (i, path) in [&blue, &red, &blue].into_iter().enumerate() {
        let r = c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"path": path, "loop": true},
                   "effect_id": "fade", "duration_ms": 300,
                   "align": if i == 2 { "end" } else { "now" }}),
        );
        assert_eq!(r["parked"], json!(true), "{r}");
        last = r["to"].as_str().unwrap().to_string();
        corrs.push(r["corr"].as_str().unwrap().to_string());
        std::thread::sleep(Duration::from_millis(50));
    }
    let st = c.ok("state", json!({}));
    assert_eq!(st["parked"], json!(last), "the last target is parked: {st}");
    let sources: Vec<&String> = st["graph"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, n)| n.get("gain_effective_db").is_some())
        .map(|(id, _)| id)
        .collect();
    assert_eq!(sources, vec![&last], "every earlier target retired: {st}");
    let evs = c.drain_events();
    let handed = |evs: &[Value], corr: &str| {
        evs.iter()
            .any(|e| e["corr"] == json!(corr) && e["event"] == "transition.handoff")
    };
    assert!(
        handed(&evs, &corrs[0]) && handed(&evs, &corrs[1]),
        "{evs:?}"
    );
    assert!(
        !handed(&evs, &corrs[2]),
        "align:end waits for an output: {evs:?}"
    );
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 320, "height": 180, "hz": 60}),
    );
    assert_eq!(content(&mut c, "VIRTUAL-3"), last);
    wait_playing(&mut c, &last, 0.3);
    wait_for(Duration::from_secs(2), "audible", || {
        let st = c.ok("state", json!({}));
        (st["graph"][&last]["gain_effective_db"] == json!(0.0)).then_some(())
    });
    let evs = c.drain_events();
    assert!(handed(&evs, &corrs[2]), "handed off once shown: {evs:?}");
}

/// The `onset.started` record for `id` (and the last `source.audio_flowing` of `id`
/// before it): invariant #8 — the ramp-in began on flowing audio, never before.
fn onset_after_flow(c: &mut Client, id: &str, slot: &str, after_ms: f64) -> Value {
    wait_for(Duration::from_secs(3), "onset.started", || {
        let evs = c.ok(
            "logs",
            json!({"kind_prefix": "", "min_level": "debug", "limit": 10000}),
        )["events"]
            .as_array()
            .unwrap()
            .clone();
        let started = evs.iter().find(|e| {
            e["kind"] == "onset.started"
                && e["id"] == json!(id)
                && e["slot"] == json!(slot)
                && e["t_mono_ms"].as_f64().unwrap() > after_ms
        })?;
        let t = started["t_mono_ms"].as_f64().unwrap();
        let flowed = evs.iter().any(|e| {
            e["kind"] == "source.audio_flowing"
                && e["id"] == json!(id)
                && (after_ms..=t).contains(&e["t_mono_ms"].as_f64().unwrap())
        });
        assert_eq!(
            started["reason"],
            json!("flowed"),
            "{id}/{slot}: the ramp-in didn't wait for flowing audio: {started}"
        );
        assert!(
            flowed,
            "{id}/{slot}: started before any source.audio_flowing: {started}"
        );
        Some(started.clone())
    })
}

fn now_ms(c: &mut Client) -> f64 {
    c.ok("probe", json!({"name": "loop"}))["uptime_ms"]
        .as_f64()
        .unwrap()
}

/// I6 (final review): every un-pause-then-ramp-in path holds its ramp until the source's
/// audio flows — unpark, snap-back (`restore_a`), the R88 resume, a frozen B's onset, and
/// a restored source's fade-in — checked through `onset.started {reason}` against the
/// source's own `source.audio_flowing`, with the slot silent meanwhile.
#[test]
fn i6_every_onset_waits_for_flowing_audio() {
    let Some(srv) = real_serve(&["--log-level", "debug"]) else {
        return;
    };
    let mut c = srv.client();
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);

    // Unpark.
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-1"}));
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    wait_for(Duration::from_secs(2), "parked + paused", || {
        (mpv_pause_of(&mut c, &a).as_deref() == Some("yes")).then_some(())
    });
    let t0 = now_ms(&mut c);
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-1", "width": 640, "height": 360, "hz": 60}),
    );
    assert_eq!(
        f64_of(&mut c, &format!("{a}.gain.anticlick")),
        Some(-96.0),
        "unpark: silent until the audio flows"
    );
    onset_after_flow(&mut c, &a, "anticlick", t0);

    // Snap-back of a reveal (A held paused, then restored).
    wait_for(Duration::from_secs(2), "A audible", || {
        (c.ok("state", json!({}))["graph"][&a]["gain_effective_db"] == json!(0.0)).then_some(())
    });
    let corr = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": blue, "loop": true},
               "effect_id": "fade", "duration_ms": 3000, "method": "reveal"}),
    )["corr"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for(Duration::from_secs(3), "A held", || {
        (mpv_pause_of(&mut c, &a).as_deref() == Some("yes")).then_some(())
    });
    let t1 = now_ms(&mut c);
    c.ok("cancel", json!({ "corr": corr }));
    onset_after_flow(&mut c, &a, "anticlick", t1);

    // The R88 resume.
    wait_for(Duration::from_secs(3), "settled", || {
        let st = c.ok("state", json!({}));
        st["transitions"]
            .as_array()
            .unwrap()
            .is_empty()
            .then_some(())
    });
    c.ok("set", json!({"path": "player.paused", "value": true}));
    wait_for(Duration::from_secs(2), "gated", || {
        (mpv_pause_of(&mut c, &a).as_deref() == Some("yes")).then_some(())
    });
    let t2 = now_ms(&mut c);
    c.ok("set", json!({"path": "player.paused", "value": false}));
    onset_after_flow(&mut c, &a, "pause", t2);

    // A frozen B's onset at handoff.
    let t3 = now_ms(&mut c);
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": blue, "loop": true},
               "effect_id": "fade", "duration_ms": 200, "method": "frozen"}),
    );
    let b = r["to"].as_str().unwrap().to_string();
    onset_after_flow(&mut c, &b, "anticlick", t3);

    // A restored source's fade-in (quit → serve --restore on the same state dir).
    wait_for(Duration::from_secs(3), "settled", || {
        let st = c.ok("state", json!({}));
        st["transitions"]
            .as_array()
            .unwrap()
            .is_empty()
            .then_some(())
    });
    wait_playing(&mut c, &b, 0.5);
    drop(c);
    let mut srv = srv;
    srv.client().ok("quit", json!({}));
    assert!(srv.wait_exit(Duration::from_secs(5)).is_some(), "quit");
    let root = srv.root.clone();
    let serial = srv._serial.take();
    srv.child = None;
    std::mem::forget(srv); // keep the state dir for the restore
    let srv2 = Serve::spawn_in(
        root,
        &["--clock", "real", "--log-level", "debug", "--restore"],
        serial,
    );
    let mut c2 = srv2.client();
    let restored = wait_for(Duration::from_secs(5), "restored source", || {
        let v = content(&mut c2, "VIRTUAL-1");
        (!v.is_empty()).then_some(v)
    });
    let st = onset_after_flow(&mut c2, &restored, "anticlick", 0.0);
    println!("restore fade-in: {st}");
}

/// I5 (final review): what one switch costs the loop — per switch, the longest
/// synchronous stretch (`max_busy_ms`) and the synchronous source-open share
/// (`max_open_ms`) around a cut to a fresh 1080p video. Prints every switch (the report's
/// before/after numbers); asserts the bound the async open buys: with the core created on
/// a worker, the open share is small and a warm switch never blocks presentation for
/// more than a few frames' worth.
#[test]
fn i5_switch_loop_busy() {
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    let (busy, open) = switch_loop_busy(&mut c);
    println!("I5 per-switch max_busy_ms: {busy:.1?}");
    println!("I5 per-switch max_open_ms: {open:.1?}");
    let warm = sorted(&busy[1..]);
    println!(
        "I5 warm median max_busy_ms {:.1}, worst {:.1}",
        warm[warm.len() / 2],
        warm[warm.len() - 1]
    );
    if std::env::var("LP_I5_BASELINE").is_err() {
        // Before (sync open, fruit dither): opens 3–14 ms, per-switch busy 32–54 ms
        // (median 36–44). After: the core is made on a worker (opens 1–8 ms: render
        // context + applies + loadfile) and the first render is cheaper.
        assert!(
            open.iter().all(|o| *o < 12.0),
            "the mpv core open must be off the loop: {open:?}"
        );
        assert!(
            warm[warm.len() / 2] < 30.0,
            "a warm switch still blocks the loop: {busy:?}"
        );
    }
}

fn sorted(v: &[f64]) -> Vec<f64> {
    let mut v = v.to_vec();
    v.sort_by(|x, y| x.partial_cmp(y).unwrap());
    v
}

/// 10 switches (cuts and 300 ms fades, alternating two fresh 1080p clips) on a real-clock
/// server: per switch, the loop probe's `max_busy_ms` and `max_open_ms` (reset before each).
fn switch_loop_busy(c: &mut Client) -> (Vec<f64>, Vec<f64>) {
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let a = create_src(c, json!({"path": red, "loop": true}));
    show_all(c, &a);
    wait_playing(c, &a, 0.3);
    let mut busy = Vec::new();
    let mut open = Vec::new();
    for i in 0..10 {
        std::thread::sleep(Duration::from_millis(300));
        c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
        let path = if i % 2 == 0 { &blue } else { &red };
        let r = c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"path": path, "loop": true},
                   "effect_id": if i % 4 < 2 { json!(null) } else { json!("fade") },
                   "duration_ms": 300}),
        );
        let b = r["to"].as_str().unwrap().to_string();
        wait_playing(c, &b, 0.2);
        wait_for(Duration::from_secs(5), "done", || {
            let st = c.ok("state", json!({}));
            st["transitions"]
                .as_array()
                .unwrap()
                .is_empty()
                .then_some(())
        });
        let lp = c.ok("probe", json!({"name": "loop"}));
        busy.push(lp["max_busy_ms"].as_f64().unwrap());
        open.push(lp["max_open_ms"].as_f64().unwrap());
    }
    (busy, open)
}

/// `lp_player::sources::host::MAX_OPEN_WORKERS` (black-box: spelled out).
const OPEN_WORKERS_CAP: u64 = 2;

/// TODO "No explicit cap on concurrent `lp-open` worker threads" (final review I5): a burst
/// of creates starts at most [`OPEN_WORKERS_CAP`] core-making workers at once, the rest
/// wait in order and none is lost; a node destroyed while queued never opens (its job is
/// skipped — no core made), a prop changed while queued still reaches the source it opens
/// (opened from the node's CURRENT props); quit with a burst still queued stays bounded and
/// clean (no `mpv.reaper_stragglers`). RED before the cap: 16 `lp-open` threads at once.
#[test]
fn i5_open_burst_is_capped_and_none_lost() {
    let Some(mut srv) = real_serve(&[]) else {
        return;
    };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["source.open"]}));
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    const N: usize = 16;
    let burst = |c: &mut Client| -> Vec<String> {
        let reqs: Vec<(&str, Value)> = (0..N)
            .map(|_| {
                (
                    "create",
                    json!({"kind": "source", "props": {"path": red, "loop": true, "paused": true}}),
                )
            })
            .collect();
        c.ok_batch(&reqs)
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    };
    let ids = burst(&mut c);
    // The back of the burst is still waiting for a worker (2–8 ms per core at the cap).
    let gone: Vec<String> = ids[N - 3..].to_vec();
    let changed = ids[N - 4].clone();
    let mut reqs: Vec<(&str, Value)> = gone
        .iter()
        .map(|id| ("destroy", json!({ "id": id })))
        .collect();
    reqs.push((
        "set",
        json!({"path": format!("{changed}.paused"), "value": false}),
    ));
    c.ok_batch(&reqs);
    let kept: Vec<String> = ids[..N - 3].to_vec();
    let t = Instant::now();
    wait_for(Duration::from_secs(20), "every kept source ready", || {
        let st = c.ok("state", json!({}));
        kept.iter()
            .all(|id| st["graph"][id]["ready"] == json!(true))
            .then_some(())
    });
    println!("I5 burst of {N}: all kept ready after {:?}", t.elapsed());
    let p = c.ok("probe", json!({"name": "sources"}));
    let pool = p["open_pool"].clone();
    println!("I5 burst open_pool {pool}");
    let peak = pool["peak"].as_u64().unwrap();
    assert!(
        (1..=OPEN_WORKERS_CAP).contains(&peak),
        "lp-open workers at once: {peak} (cap {OPEN_WORKERS_CAP}): {pool}"
    );
    assert_eq!(
        pool["workers"],
        json!(0),
        "workers left after the burst: {pool}"
    );
    assert_eq!(
        pool["queued"],
        json!(0),
        "jobs left after the burst: {pool}"
    );
    let opened: std::collections::BTreeSet<String> = c
        .drain_events()
        .iter()
        .filter(|e| e["event"] == "source.open")
        .filter_map(|e| e["id"].as_str().map(str::to_string))
        .collect();
    for id in &kept {
        assert!(opened.contains(id), "{id} never opened: {opened:?}");
    }
    let hosted = p["sources"].as_array().unwrap();
    for id in &gone {
        assert!(
            hosted.iter().all(|s| s["id"] != json!(id)),
            "{id} was destroyed but is hosted"
        );
    }
    // Each destroyed one was skipped in the queue or (it got its worker first) opened and
    // retired — never both, never neither.
    let skipped = pool["skipped"].as_u64().unwrap() as usize;
    let gone_opened = gone.iter().filter(|id| opened.contains(*id)).count();
    assert_eq!(skipped + gone_opened, gone.len(), "{pool} {opened:?}");
    assert_eq!(mpv_pause_of(&mut c, &changed).as_deref(), Some("no"));
    assert_eq!(mpv_pause_of(&mut c, &kept[0]).as_deref(), Some("yes"));

    // Quit with a second burst still queued (nothing else left to tear down).
    for id in &kept {
        c.ok("destroy", json!({ "id": id }));
    }
    wait_for(Duration::from_secs(10), "the first burst torn down", || {
        let p = c.ok("probe", json!({"name": "sources"}));
        (p["sources"].as_array().unwrap().is_empty()
            && p["dying"] == json!(0)
            && p["reaper_pending"] == json!(0))
        .then_some(())
    });
    burst(&mut c);
    let t = Instant::now();
    c.ok("quit", json!({}));
    let st = srv
        .wait_exit(Duration::from_secs(6))
        .expect("quit with opens queued must exit");
    println!("I5 quit with a burst queued: exit after {:?}", t.elapsed());
    assert!(st.success(), "{st}");
    let log = std::fs::read_to_string(srv.path("state/livepaper/lp-player/events.jsonl")).unwrap();
    assert!(
        !log.contains("mpv.reaper_stragglers"),
        "straggler at quit: {}",
        log.lines()
            .filter(|l| l.contains("stragglers"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Task 20d (R107): the I5 switch bound must hold whatever `hwdec` says. Two NVIDIA traps,
/// both on the loop thread: (1) mpv's render context loads the CUDA GL interop eagerly
/// whenever `libcuda.so.1` is loadable from libmpv (the flake wrapper's `LD_LIBRARY_PATH`,
/// or once libavutil has loaded it for `nvdec-copy`) — CUDA context creation inside
/// `mpv_render_context_create`, 65–90 ms per switch, *even with `hwdec=no`*; (2) without it
/// mpv's `auto` resolves to `vulkan-copy`, whose per-core `vkCreateDevice` (mpv's core
/// thread) holds an NVIDIA driver lock our GL calls wait on — 230–320 ms per switch, but
/// only when no X server is reachable (with the session's Xwayland in `DISPLAY` it doesn't
/// contend; measured). Scenario A = the dev binary's environment, B = the packaged one
/// (libcuda on the library path); both without `DISPLAY`/`WAYLAND_DISPLAY` (hermetic, and
/// the X-less case is the one that stalls). Per switch: the loop's longest synchronous
/// stretch, and what mpv really decodes with: a LOOP-rendered source never a GL interop mode
/// (`no` or a `-copy` mode, `sources::mpv::mpv_hwdec`); a source on the render worker with the
/// worker's interop loaded (`hwdec_interop`, § Sources "Hardware decoding") decodes zero-copy
/// — the interop's init (a CUDA context) runs on an `lp-render` lane, so the same bound must
/// hold — and still asks for the copy twin as its fallback. Runs in both render modes
/// (`LP_PLAYER_RENDER_WORKER`).
#[test]
fn t20d_hwdec_switch_never_stalls_the_loop() {
    // SKIP (no EGL / no catalogue — e.g. the nix build sandbox, which has no ffmpeg either)
    // before generating any clip.
    let Some(probe) = Serve::start() else {
        return;
    };
    drop(probe);
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let driver = Path::new("/run/opengl-driver/lib");
    let mut cuda_env: Vec<(&str, &Path)> = Vec::new();
    if driver.is_dir() {
        cuda_env.push(("LD_LIBRARY_PATH", driver));
    }
    type Env<'a> = &'a [(&'a str, &'a Path)];
    let scenarios: [(&str, Env, &[&str]); 2] = [
        ("dev env", &[], &["auto"]),
        ("libcuda on the path", &cuda_env, &["auto", "no", "nvdec"]),
    ];
    let mut failures = Vec::new();
    for (label, env, modes) in scenarios {
        let Some(mut srv) = Serve::start() else {
            return;
        };
        let serial = srv._serial.take();
        drop(srv);
        let srv = Serve::spawn_env_without(
            new_root(),
            &["--clock", "real"],
            env,
            &["DISPLAY", "WAYLAND_DISPLAY"],
            serial,
        );
        let mut c = srv.client();
        let a = create_src(&mut c, json!({"path": red, "loop": true, "hwdec": "no"}));
        show_all(&mut c, &a);
        wait_playing(&mut c, &a, 0.3);
        let mut i = 0usize;
        for hwdec in modes {
            let mut busy = Vec::new();
            let mut picked = Vec::new();
            let mut interop = Vec::new();
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(300));
                c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
                let path = if i.is_multiple_of(2) { &blue } else { &red };
                i += 1;
                let r = c.ok(
                    "transition",
                    json!({"outputs": "out:*", "to": {"path": path, "loop": true, "hwdec": hwdec},
                           "effect_id": "fade", "duration_ms": 300}),
                );
                let b = r["to"].as_str().unwrap().to_string();
                wait_playing(&mut c, &b, 0.2);
                wait_for(Duration::from_secs(5), "done", || {
                    let st = c.ok("state", json!({}));
                    st["transitions"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                        .then_some(())
                });
                let lp = c.ok("probe", json!({"name": "loop"}));
                busy.push(lp["max_busy_ms"].as_f64().unwrap());
                let p = c.ok("probe", json!({"name": "sources"}));
                let src = p["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["id"] == json!(b));
                let cur = src
                    .map(|s| s["mpv_hwdec_current"].as_str().unwrap_or("?").to_string())
                    .unwrap_or_default();
                // What we asked mpv for: a hardware hwdec must ask for a copy mode (a decoder
                // that silently fell back to software reports `no` above — this catches a
                // mapping that stopped asking for hardware at all).
                let asked = src
                    .map(|s| s["mpv_hwdec"].as_str().unwrap_or("?").to_string())
                    .unwrap_or_default();
                if *hwdec != "no" && !asked.split(',').any(|e| e.ends_with("-copy")) {
                    failures.push(format!(
                        "{label}, hwdec={hwdec}: mpv was asked for {asked:?}, not a copy mode"
                    ));
                }
                // The render context's interop: only ever on the worker, only for a hardware
                // hwdec (the async open skips it for `no`).
                let mode = src.map(|s| s["render_mode"].clone()).unwrap_or_default();
                let io = src.and_then(|s| s["hwdec_interop"].as_str().map(str::to_string));
                if io.is_some() && (mode != json!("worker") || *hwdec == "no") {
                    failures.push(format!(
                        "{label}, hwdec={hwdec}: interop {io:?} loaded on a {mode} source"
                    ));
                }
                // NVIDIA with the CUDA interop loaded: zero-copy really in use (a silent
                // fallback to the copy would keep the CPU cost this exists to remove).
                if io.as_deref() == Some("cuda") && cur != "nvdec" {
                    failures.push(format!(
                        "{label}, hwdec={hwdec}: CUDA interop loaded but mpv decodes with {cur:?}"
                    ));
                }
                picked.push(cur);
                interop.push(io);
            }
            let mut warm = busy[1..].to_vec();
            warm.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let median = warm[warm.len() / 2];
            println!(
                "T20d {label}, hwdec={hwdec}: max_busy_ms {busy:.1?} (warm median {median:.1}), \
                 mpv decodes with {picked:?}, interop {interop:?}"
            );
            // Fixed, every mode costs what `hwdec=no` does (I5: 8–26 ms per switch; medians
            // 16–36 ms here with the full suite and other GPU work running); the traps this
            // guards cost >= 65 ms. 50 keeps both margins.
            if median >= 50.0 {
                failures.push(format!(
                    "{label}, hwdec={hwdec}: a warm switch blocks the loop {median:.1} ms \
                     (median; bound 50): {busy:.1?}, decoder {picked:?}"
                ));
            }
            // A zero-copy decoder only where its interop was loaded (the worker).
            if let Some((bad, _)) = picked
                .iter()
                .zip(&interop)
                .find(|(h, io)| *h != "no" && !h.ends_with("-copy") && io.is_none())
            {
                failures.push(format!(
                    "{label}, hwdec={hwdec}: mpv decodes with GL interop mode {bad:?} without \
                     the worker's interop — its init runs in a render context on the loop"
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Task 20b: per-switch allocator retention — the Task 20 soak's RSS slope (6.4 MiB/min
/// with malloc's in-use bytes flat). Fade between two playing 1080p clips: after `WARM`
/// switches, `MEASURE` more must leave RSS nearly flat, and an on-demand `malloc_trim(0)`
/// (`probe memory {trim: true}`) must find little to give back — glibc keeping freed
/// frame buffers resident in its arenas is exactly the bug (`mem::apply_policy`). Both
/// checks are ratios of the process's own RSS, not absolute sizes. Old behaviour on
/// demand: `LP_PLAYER_MALLOC=glibc cargo test --test api t20b` (RED).
#[test]
fn t20b_switch_loop_rss_stays_flat() {
    const WARM: usize = 4;
    const MEASURE: usize = 16;
    let Some(srv) = real_serve(&[]) else { return };
    let mut c = srv.client();
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);
    let switch = |c: &mut Client, i: usize| {
        let path = if i.is_multiple_of(2) { &blue } else { &red };
        let r = c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"path": path, "loop": true},
                   "effect_id": "fade", "duration_ms": 300}),
        );
        let b = r["to"].as_str().unwrap().to_string();
        wait_playing(c, &b, 0.2);
        wait_for(Duration::from_secs(5), "transition done", || {
            let st = c.ok("state", json!({}));
            st["transitions"]
                .as_array()
                .unwrap()
                .is_empty()
                .then_some(())
        });
    };
    // Every old core destroyed (and the reaper's trim after it run) before a reading.
    let settled = |c: &mut Client| {
        wait_for(Duration::from_secs(5), "reaper idle", || {
            let m = c.ok("probe", json!({"name": "memory"}));
            (m["reaper_pending"] == json!(0) && m["dying_sources"] == json!(0)).then_some(())
        });
        // `reaper_pending` only drops to 0 after the batch's trim (reaper.rs), so no sleep.
    };
    for i in 0..WARM {
        switch(&mut c, i);
    }
    settled(&mut c);
    let m0 = c.ok("probe", json!({"name": "memory"}));
    for i in WARM..WARM + MEASURE {
        switch(&mut c, i);
    }
    settled(&mut c);
    let m1 = c.ok("probe", json!({"name": "memory", "args": {"trim": true}}));
    let kib = |v: &Value| v.as_u64().unwrap_or_else(|| panic!("rss: {v}")) as f64;
    let (r0, r1) = (kib(&m0["proc"]["rss_kib"]), kib(&m1["proc"]["rss_kib"]));
    let trimmed = kib(&m1["trim"]["proc_after"]["rss_kib"]);
    let growth = (r1 - r0) / r0;
    let retained = (r1 - trimmed) / r1;
    println!(
        "T20b rss after {WARM} switches {:.0} MiB, after {} {:.0} MiB (growth {:.1} %), \
         trim gives back {:.0} MiB ({:.1} %); malloc {} -> {}; policy {}",
        r0 / 1024.0,
        WARM + MEASURE,
        r1 / 1024.0,
        growth * 100.0,
        (r1 - trimmed) / 1024.0,
        retained * 100.0,
        m0["malloc"],
        m1["malloc"],
        m1["policy"],
    );
    // Near-vacuous under the policy (the reaper already trimmed); it is the RED detector for
    // `LP_PLAYER_MALLOC=glibc`. The growth check below is the meaningful one.
    assert!(
        retained < 0.05,
        "malloc keeps {:.0} MiB of freed memory resident ({:.1} % of RSS) after {} switches — \
         allocator retention (mem::apply_policy): {m1}",
        (r1 - trimmed) / 1024.0,
        retained * 100.0,
        WARM + MEASURE
    );
    assert!(
        growth < 0.10,
        "RSS grew {:.1} % over {MEASURE} warm switches ({:.0} -> {:.0} MiB): {m1}",
        growth * 100.0,
        r0 / 1024.0,
        r1 / 1024.0
    );
}

/// Task 20e: the live soak's in-use heap grew ~2 MiB/min (headless runs flat). Cause: every
/// present on Wayland leaves one `wl_buffer.release` event (a ~224 B `wl_closure`) queued
/// on an event queue nobody dispatches — NVIDIA egl-wayland2 ≤ 1.0.2 keeps its buffers on
/// a per-swapchain queue it never dispatches under explicit sync, and upstream's fix moves
/// them to libwayland's *default* queue, which wayland-rs never dispatches either. A long
/// colour fade on every output (each output redraws every refresh, no decoder in the heap)
/// must leave the heap flat per present (`wl::apply_driver_env` + the default-queue drain in
/// `Wayland::process`). Opt-in — it draws on a real compositor's outputs for ~25 s:
/// `LP_PLAYER_TEST_WAYLAND=<absolute wayland socket path> cargo test --test api t20e` (absolute: the
/// test runs with its own `XDG_RUNTIME_DIR`). Old behaviour on demand:
/// add `__NV_DISABLE_EXPLICIT_SYNC=0` (RED on egl-wayland2 ≤ 1.0.2).
#[test]
fn t20e_wayland_present_heap_stays_flat() {
    let Some(display) = std::env::var_os("LP_PLAYER_TEST_WAYLAND") else {
        println!(
            "SKIP: set LP_PLAYER_TEST_WAYLAND=<absolute wayland socket path> to run (draws on that \
             compositor's outputs for ~25 s)"
        );
        return;
    };
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if common::catalogue_dir().is_none() {
        return;
    }
    let root = new_root();
    let mut cmd = Command::new(BIN);
    die_with_parent(&mut cmd);
    cmd.args(["serve", "--no-supervise", "--clock", "real", "--ao", "null"])
        .env("XDG_RUNTIME_DIR", root.join("run"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("WAYLAND_DISPLAY", &display)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            std::fs::File::create(root.join("stderr-wayland.log")).unwrap(),
        ));
    let mut srv = Serve {
        child: Some(cmd.spawn().expect("spawn lp-player serve (wayland)")),
        sock: root.join("run/livepaper/lp-player.sock"),
        root,
        _serial: Some(serial),
    };
    srv.wait_up();
    let mut c = srv.client();
    let fade = |c: &mut Client, rgb: [u8; 3], ms: u32| {
        c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"kind": "color", "color": rgb},
                   "effect_id": "fade", "duration_ms": ms}),
        );
    };
    fade(&mut c, [255, 0, 0], 100);
    std::thread::sleep(Duration::from_millis(500));
    fade(&mut c, [0, 0, 255], 60_000); // redraws every output at its refresh rate
    // A one-off ~0.4 MiB (the first frames' allocations) is freed within ~8 s; then the
    // heap is flat to the byte when nothing leaks (measured).
    std::thread::sleep(Duration::from_secs(10));
    let read = |c: &mut Client| {
        let m = c.ok("probe", json!({"name": "memory"}));
        let f = c.ok("probe", json!({"name": "frames"}));
        let presents: u64 = f["outputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["totals"]["presents"].as_u64().unwrap())
            .sum();
        (m["malloc"]["in_use_bytes"].as_f64().unwrap(), presents, f)
    };
    let (m0, p0, _) = read(&mut c);
    std::thread::sleep(Duration::from_secs(10));
    let (m1, p1, f) = read(&mut c);
    let presents = p1 - p0;
    let per_present = (m1 - m0) / presents.max(1) as f64;
    println!(
        "T20e heap {:+.0} KiB over {presents} presents ({per_present:.1} B/present); \
         explicit sync: {}, default queue dispatched: {}",
        (m1 - m0) / 1024.0,
        f["explicit_sync"],
        f["default_queue_dispatched"]
    );
    assert!(
        presents >= 300,
        "only {presents} presents in 10 s — is the compositor giving frame callbacks? {f}"
    );
    assert!(
        per_present < 32.0,
        "the heap grew {per_present:.1} B per present ({:+.0} KiB over {presents}) — an \
         undispatched Wayland event queue (wl::apply_driver_env, Wayland::process): {f}",
        (m1 - m0) / 1024.0
    );
}

/// I7 (final review): a **private, hermetic** PipeWire + WirePlumber (their own runtime/
/// config/state dirs, no D-Bus, WirePlumber's `policy` profile — no ALSA/Bluetooth/V4L2
/// monitors, so no real device is ever touched; one null sink as the only output). The
/// owner's PipeWire is never involved: `PIPEWIRE_RUNTIME_DIR` points every client of this
/// test (the bus, mpv's AO) at the private socket.
struct PrivatePw {
    dir: PathBuf,
    procs: Vec<Child>,
}

impl PrivatePw {
    fn available() -> bool {
        ["pipewire", "wireplumber"].iter().all(|b| {
            Command::new(b)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
    }

    fn new(dir: PathBuf) -> PrivatePw {
        for d in ["run", "state", "cfg/wireplumber/wireplumber.conf.d"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            dir.join("pw.conf"),
            r#"context.properties = { core.daemon = true core.name = pipewire-0
  default.clock.rate = 48000 support.dbus = false log.level = 1 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-protocol-native } { name = libpipewire-module-profiler }
  { name = libpipewire-module-access } { name = libpipewire-module-metadata }
  { name = libpipewire-module-spa-device-factory } { name = libpipewire-module-spa-node-factory }
  { name = libpipewire-module-client-node } { name = libpipewire-module-client-device }
  { name = libpipewire-module-adapter } { name = libpipewire-module-link-factory } ]
context.objects = [
  { factory = spa-node-factory args = { factory.name = support.node.driver node.name = Dummy-Driver
      node.group = pipewire.dummy priority.driver = 20000 } }
  { factory = adapter args = { factory.name = support.null-audio-sink node.name = hermetic-sink
      node.description = "hermetic sink" media.class = Audio/Sink audio.position = [ FL FR ]
      monitor.channel-volumes = true node.group = pipewire.dummy priority.driver = 21000 } } ]
"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("cfg/wireplumber/wireplumber.conf.d/99-hermetic.conf"),
            "wireplumber.profiles = { policy = { support.reserve-device = disabled \
             monitor.alsa.reserve-device = disabled support.portal-permissionstore = disabled \
             script.client.access-portal = disabled support.logind = disabled \
             monitor.bluez.seat-monitoring = disabled hooks.device.profile.state = disabled \
             hooks.device.routes.state = disabled } }\n",
        )
        .unwrap();
        PrivatePw {
            dir,
            procs: Vec::new(),
        }
    }

    fn run_dir(&self) -> PathBuf {
        self.dir.join("run")
    }

    fn spawn(&self, bin: &str, args: &[&str]) -> Child {
        let mut c = Command::new(bin);
        die_with_parent(&mut c);
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.dir)
            .env("XDG_RUNTIME_DIR", self.run_dir())
            .env("PIPEWIRE_RUNTIME_DIR", self.run_dir())
            .env("XDG_CONFIG_HOME", self.dir.join("cfg"))
            .env("XDG_STATE_HOME", self.dir.join("state"))
            .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c.spawn().expect("spawn private pipewire")
    }

    fn start(&mut self) {
        let conf = self.dir.join("pw.conf");
        let pw = self.spawn("pipewire", &["-c", conf.to_str().unwrap()]);
        wait_for(Duration::from_secs(5), "private pipewire socket", || {
            self.run_dir().join("pipewire-0").exists().then_some(())
        });
        let wp = self.spawn("wireplumber", &["-p", "policy"]);
        self.procs = vec![pw, wp];
        std::thread::sleep(Duration::from_millis(700));
    }

    /// The audio server "restarts": both daemons die at once.
    fn kill(&mut self) {
        for mut p in self.procs.drain(..) {
            let _ = p.kill();
            let _ = p.wait();
        }
    }
}

impl Drop for PrivatePw {
    fn drop(&mut self) {
        self.kill();
    }
}

#[test]
fn i7_bus_reconnects_after_pipewire_restart() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    if !PrivatePw::available() {
        println!("SKIP: no pipewire/wireplumber binaries for a private instance");
        return;
    }
    let root = new_root();
    let mut pw = PrivatePw::new(root.join("pw"));
    pw.start();
    let run = pw.run_dir();
    let srv = Serve::spawn_env(
        root,
        &[
            "--ao",
            "pipewire",
            "--clock",
            "real",
            "--log-level",
            "debug",
        ],
        &[("PIPEWIRE_RUNTIME_DIR", run.as_path())],
        Some(serial),
    );
    let mut c = srv.client();
    let bus_state = |c: &mut Client| c.ok("probe", json!({"name": "bus"}))["state"].clone();
    wait_for(Duration::from_secs(5), "bus up", || {
        (bus_state(&mut c) == json!("up")).then_some(())
    });
    let id = create_src(
        &mut c,
        json!({"path": s(&ensure_clip("tr_red_10s", RED_10S)), "loop": true}),
    );
    show_all(&mut c, &id);
    wait_playing(&mut c, &id, 0.3);
    let loud = |c: &mut Client| {
        let r = c.call(
            "probe",
            json!({"name": "meter.window", "args": {"last_ms": 200, "samples": false}}),
        );
        r["result"]["median_db"]
            .as_f64()
            .is_some_and(|db| db > -40.0)
    };
    let device = |c: &mut Client, id: &str| {
        let p = c.ok("probe", json!({"name": "sources"}));
        p["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == json!(id))
            .map(|s| (s["mpv_audio_device"].clone(), s["mpv_current_ao"].clone()))
    };
    wait_for(Duration::from_secs(3), "the tone on the bus", || {
        loud(&mut c).then_some(())
    });

    pw.kill();
    wait_for(Duration::from_secs(3), "bus down", || {
        (bus_state(&mut c) == json!("down")).then_some(())
    });
    wait_for(Duration::from_secs(2), "re-routed to mpv's default", || {
        (device(&mut c, &id).map(|d| d.0) == Some(json!("auto"))).then_some(())
    });
    let t_down = now_ms(&mut c);

    pw.start();
    wait_for(Duration::from_secs(10), "bus back up", || {
        (bus_state(&mut c) == json!("up")).then_some(())
    });
    wait_for(Duration::from_secs(3), "re-routed to the bus", || {
        let d = device(&mut c, &id)?;
        (d.0 == json!("pipewire/lp-player-bus") && d.1 == json!("pipewire")).then_some(())
    });
    wait_for(Duration::from_secs(5), "the tone on the bus again", || {
        loud(&mut c).then_some(())
    });
    let evs = c.ok("logs", json!({"kind_prefix": "audio.bus.", "limit": 1000}))["events"]
        .as_array()
        .unwrap()
        .clone();
    let kinds: Vec<&str> = evs.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    println!("I7 bus events: {kinds:?}");
    let pos = |k: &str| kinds.iter().position(|x| *x == k);
    assert!(pos("audio.bus.down").is_some(), "{kinds:?}");
    assert!(
        evs.iter()
            .any(|e| e["kind"] == "audio.bus.up" && e["reconnected"] == json!(true)),
        "{evs:?}"
    );
    assert!(
        pos("audio.bus.reconnecting") > pos("audio.bus.down"),
        "{kinds:?}"
    );
    // The re-routed source ramps back in on flowing audio (invariant #8).
    onset_after_flow(&mut c, &id, "pause", t_down);
}

/// M13 (final review): `animate` on a broadcast alias that matches nothing is a broadcast
/// to nobody — `{targets: []}`, exactly like `set` — after the same schema check.
#[test]
fn m13_animate_and_set_agree_on_an_empty_wildcard() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let set = c.ok("set", json!({"path": "srcs:*.gain.mute", "value": -96.0}));
    assert_eq!(set["targets"], json!([]));
    let an = c.ok(
        "animate",
        json!({"path": "srcs:*.gain.mute", "to": -96.0, "duration_ms": 30}),
    );
    assert_eq!(an["targets"], json!([]), "{an}");
    let e = c.err(
        "animate",
        json!({"path": "srcs:*.path", "to": 1.0, "duration_ms": 30}),
    );
    assert_eq!(e["code"], "bad_type", "{e}");
    let e = c.err(
        "animate",
        json!({"path": "src999.gain.mute", "to": 0.0, "duration_ms": 30}),
    );
    assert_eq!(
        e["code"], "no_such_node",
        "a concrete id still has to exist: {e}"
    );
}

// ---------------------------------------------------------------- Phase 2: render worker

/// A real-clock server with extra environment for the child.
fn real_serve_env(extra: &[&str], env: &[(&str, &Path)]) -> Option<Serve> {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return None;
    }
    let mut args = vec!["--clock", "real"];
    args.extend_from_slice(extra);
    Some(Serve::spawn_env(new_root(), &args, env, Some(serial)))
}

fn source_probe(c: &mut Client, id: &str) -> Value {
    let p = c.ok("probe", json!({"name": "sources"}));
    p["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == json!(id))
        .cloned()
        .unwrap_or_else(|| panic!("{id} not hosted: {p}"))
}

/// Phase 2 (§ Sources "Render worker"): `serve --render-worker on|off` (else
/// `LP_PLAYER_RENDER_WORKER`) decides where a real-clock player's mpv sources render — the
/// flag wins over the environment —, a stepped player always renders on the loop (its
/// captures stay deterministic), and the `sources` probe says which (`render_mode`, the
/// per-source `render` stats, top-level `render_worker`). The picture is the same either way.
#[test]
fn render_worker_switch_picks_where_sources_render() {
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    for (flag, want) in [("on", "worker"), ("off", "loop")] {
        let Some(srv) = real_serve(&["--render-worker", flag]) else {
            return;
        };
        let mut c = srv.client();
        let a = create_src(&mut c, json!({"path": red, "loop": true}));
        show_all(&mut c, &a);
        wait_playing(&mut c, &a, 0.3);
        let src = source_probe(&mut c, &a);
        let p = c.ok("probe", json!({"name": "sources"}));
        println!(
            "render worker {flag}: {} / {}",
            src["render"], p["render_worker"]
        );
        assert_eq!(src["render_mode"], json!(want), "{src}");
        if want == "worker" {
            assert!(src["render"]["adopted"].as_u64().unwrap() > 3, "{src}");
            assert!(p["render_worker"]["renders"].as_u64().unwrap() > 3, "{p}");
            assert_eq!(p["render_worker"]["slots"], json!(1), "{p}");
        } else {
            assert!(src["render"].is_null(), "{src}");
            assert!(p["render_worker"].is_null(), "{p}");
        }
        let png = srv.path("out.png");
        c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": png}));
        near(png_pixel(&png, 320, 180), [255, 0, 0], 3, "red on screen");
    }
    let Some(srv) = Serve::start_with(&["--render-worker", "on"]) else {
        return;
    };
    let mut c = srv.client();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    let r = c.call("step", json!({"ms": 100}));
    if r["ok"] != json!(true) {
        // Seen once in ~10 runs (never in 60 loops of the same sequence): the first step's
        // seek reply not in within 2 s — stepped mode, which never uses the worker. Keep the
        // whole story for when it recurs.
        let logs = c.ok("logs", json!({"limit": 200}));
        let probe = c.ok("probe", json!({"name": "sources"}));
        panic!("stepped: step failed: {r}\nsources: {probe}\nlogs: {logs}");
    }
    let src = source_probe(&mut c, &a);
    let p = c.ok("probe", json!({"name": "sources"}));
    assert_eq!(src["render_mode"], json!("loop"), "stepped: {src}");
    assert!(p["render_worker"].is_null(), "stepped: {p}");
}

/// Both Flash clips' length in frames.
const FLASH_FRAMES: u32 = 56;
const FLASH_A: ClipSpec = ClipSpec::Flash {
    w: 128,
    h: 72,
    fps: 30,
    frames: FLASH_FRAMES,
};
const FLASH_B: ClipSpec = ClipSpec::Flash {
    w: 192,
    h: 108,
    fps: 24,
    frames: FLASH_FRAMES,
};

/// A captured PNG's Flash frame index if the picture is ONE frame (every pixel within ±3 of
/// the first, on the ladder), else why not.
fn flash_frame(path: &Path) -> Result<u32, String> {
    let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
    let mut rd = dec.read_info().unwrap();
    let mut buf = vec![0; rd.output_buffer_size().unwrap()];
    let info = rd.next_frame(&mut buf).unwrap();
    let px = |i: usize| [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
    let first = px(0);
    let n = common::flash_index(first).ok_or_else(|| format!("off the ladder: {first:?}"))?;
    for i in (0..info.buffer_size()).step_by(4) {
        let p = px(i);
        if (0..3).any(|k| p[k].abs_diff(first[k]) > 3) {
            let (x, y) = ((i / 4) as u32 % info.width, (i / 4) as u32 / info.width);
            return Err(format!("not uniform: {first:?} at 0,0 vs {p:?} at {x},{y}"));
        }
    }
    Ok(n)
}

/// Phase 2: the loop never samples a frame the render worker hasn't finished. Two Flash clips
/// (every frame one uniform grey, a level per frame) at two sizes play on the two outputs,
/// one under speed jitter, while the test captures both sources and an output back to back:
/// every capture must be ONE frame (a partial frame isn't uniform), on the ladder (an
/// uninitialised texture isn't) and never older than the one before it on that target (a
/// stale, recycled texture is). Runs twice: as is, and with the worker's `slow-flush` test
/// fault — every frame stays unfinished on the GPU for 30 ms, so only the fences keep it out
/// of sight. RED: `LP_PLAYER_TEST_RENDER_WORKER_FAULT=publish-early` (each target handed to the
/// loop before the worker renders into it). `no-fence` (frames published unfenced, before
/// their flush) stays GREEN on NVIDIA 595: the driver serializes shared-texture access itself.
/// Each case also with `hwdec: auto` — zero-copy through the worker's GL interop (§ Sources
/// "Hardware decoding": CUDA writes mpv's textures, the lane renders them into ours, the fence
/// covers both) — the two sources on two lanes.
#[test]
fn render_worker_never_composes_a_torn_frame() {
    let a_clip = s(&ensure_clip("flash_128x72_30", FLASH_A)).to_string();
    let b_clip = s(&ensure_clip("flash_192x108_24", FLASH_B)).to_string();
    let inherited = std::env::var("LP_PLAYER_TEST_RENDER_WORKER_FAULT").unwrap_or_default();
    for (extra, hw) in [
        ("", ""),
        ("slow-flush", ""),
        ("", "auto"),
        ("slow-flush", "auto"),
    ] {
        let fault: Vec<&str> = [inherited.as_str(), extra]
            .into_iter()
            .filter(|f| !f.is_empty())
            .collect();
        let fault = fault.join(",");
        let Some(srv) = real_serve_env(
            &["--render-worker", "on"],
            &[("LP_PLAYER_TEST_RENDER_WORKER_FAULT", Path::new(&fault))],
        ) else {
            return;
        };
        let mut c = srv.client();
        let a = create_src(&mut c, json!({"path": a_clip, "paused": true, "hwdec": hw}));
        let b = create_src(&mut c, json!({"path": b_clip, "paused": true, "hwdec": hw}));
        c.ok(
            "set",
            json!({"path": "lay:VIRTUAL-1:main.content", "value": a}),
        );
        c.ok(
            "set",
            json!({"path": "lay:VIRTUAL-2:main.content", "value": b}),
        );
        wait_for(Duration::from_secs(10), "both ready", || {
            let st = c.ok("state", json!({}));
            (st["graph"][&a]["ready"] == json!(true) && st["graph"][&b]["ready"] == json!(true))
                .then_some(())
        });
        c.ok_batch(&[
            (
                "set",
                json!({"path": format!("{a}.paused"), "value": false}),
            ),
            (
                "set",
                json!({"path": format!("{b}.paused"), "value": false}),
            ),
        ]);
        let targets = [a.clone(), b.clone(), "out:VIRTUAL-2".to_string()];
        let mut seen: Vec<Vec<u32>> = vec![Vec::new(); targets.len()];
        let mut bad = Vec::new();
        let speeds = [1.4, 0.6, 1.0, 1.25, 0.8, 1.5, 0.7];
        let t = Instant::now();
        let mut k = 0usize;
        while t.elapsed() < Duration::from_millis(2600) {
            if k.is_multiple_of(6) {
                let v = speeds[(k / 6) % speeds.len()];
                c.ok("set", json!({"path": format!("{b}.speed"), "value": v}));
            }
            for (i, target) in targets.iter().enumerate() {
                // The output (320×180, a debug-build PNG encode per capture) every 3rd round.
                if i == 2 && !k.is_multiple_of(3) {
                    continue;
                }
                let png = srv.path(&format!("cap-{i}.png"));
                c.ok("capture", json!({"target": target, "path": png}));
                match flash_frame(&png) {
                    Ok(n) => {
                        if let Some(&prev) = seen[i].last()
                            && n < prev
                        {
                            bad.push(format!("{target} #{k}: frame {n} after {prev}"));
                        }
                        seen[i].push(n);
                    }
                    Err(e) => bad.push(format!("{target} #{k}: {e}")),
                }
            }
            k += 1;
        }
        let distinct = |v: &Vec<u32>| {
            let mut d = v.clone();
            d.dedup();
            d.len()
        };
        let p = c.ok("probe", json!({"name": "sources"}));
        println!(
            "torn-frame [{fault} hwdec={hw}]: {k} rounds; first/last {:?}; distinct {:?}; worker {}; a {}; b {}",
            seen.iter()
                .map(|v| (v.first().copied(), v.last().copied()))
                .collect::<Vec<_>>(),
            seen.iter().map(distinct).collect::<Vec<_>>(),
            p["render_worker"],
            source_probe(&mut c, &a)["render"],
            source_probe(&mut c, &b)["render"],
        );
        let decoders = [&a, &b].map(|id| source_probe(&mut c, id)["mpv_hwdec_current"].clone());
        println!("torn-frame [{fault} hwdec={hw}]: decoders {decoders:?}");
        assert!(
            bad.is_empty(),
            "[{fault} hwdec={hw}] {} bad captures of {}: {:#?}",
            bad.len(),
            seen.iter().map(Vec::len).sum::<usize>() + bad.len(),
            &bad[..bad.len().min(20)]
        );
        // The captures followed the playback (not one frame held throughout): at least half of
        // the captures taken before the clip's last frame show a frame of their own. Relative
        // to what was captured — a loaded machine captures fewer times in the window (a
        // debug-build PNG encode per capture; seen: 25 rounds instead of 37), and a clip that
        // reached its last frame holds it by design; an absolute count (20, 10) flaked there.
        for (i, v) in seen.iter().enumerate() {
            let last = FLASH_FRAMES - 1;
            let playing: Vec<u32> = v.iter().copied().filter(|&n| n < last).collect();
            let want = (playing.len() / 2).max(5);
            assert!(
                distinct(&playing) >= want,
                "[{fault} hwdec={hw}] {}: {v:?}",
                targets[i]
            );
        }
    }
}

/// Phase 2: with the render worker on, a switch costs the loop about a frame. The render
/// context's creation and its first render (shader compile, scaler LUTs, FBO setup) — 6–20 ms
/// on the loop before, the bulk of `i5_switch_loop_busy`'s per-switch busy — run on the
/// worker; the loop only adopts finished textures. Same 10 switches as I5. `LP_RW_SWITCH=off`
/// runs it with the worker off (the A/B and the RED run).
#[test]
fn render_worker_switch_keeps_the_loop_free() {
    let flag = std::env::var("LP_RW_SWITCH").unwrap_or_else(|_| "on".into());
    let Some(srv) = real_serve(&["--render-worker", &flag]) else {
        return;
    };
    let mut c = srv.client();
    let (busy, open) = switch_loop_busy(&mut c);
    let warm = sorted(&busy[1..]);
    let (median, worst) = (warm[warm.len() / 2], warm[warm.len() - 1]);
    println!("render worker {flag}: per-switch max_busy_ms {busy:.1?}");
    println!("render worker {flag}: per-switch max_open_ms {open:.1?}");
    println!("render worker {flag}: warm median {median:.1}, worst {worst:.1}");
    let p = c.ok("probe", json!({"name": "sources"}));
    println!("render worker {flag}: {}", p["render_worker"]);
    assert!(
        median < 8.0,
        "a warm switch blocks the loop for {median:.1} ms (median): {busy:?}"
    );
}

/// Phase 2: quit stays bounded and clean with the worker on, with sources playing, being
/// opened (a burst of creates, cores still attaching) and torn down at once: exit 0 well
/// within the bounds, the worker frees every render context (`render_worker.stopped {left:
/// 0}`) and no `mpv.reaper_stragglers`.
#[test]
fn render_worker_quit_is_bounded() {
    let Some(mut srv) = real_serve(&["--render-worker", "on"]) else {
        return;
    };
    let mut c = srv.client();
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    let b = create_src(&mut c, json!({"path": blue, "loop": true}));
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-1:main.content", "value": a}),
    );
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-2:main.content", "value": b}),
    );
    wait_playing(&mut c, &a, 0.3);
    wait_playing(&mut c, &b, 0.3);
    let mut reqs: Vec<(&str, Value)> = (0..6)
        .map(|i| {
            let path = if i % 2 == 0 { &red } else { &blue };
            (
                "create",
                json!({"kind": "source", "props": {"path": path, "loop": true}}),
            )
        })
        .collect();
    reqs.push(("destroy", json!({ "id": b })));
    c.ok_batch(&reqs);
    std::thread::sleep(Duration::from_millis(15));
    let t = Instant::now();
    c.ok("quit", json!({}));
    let st = srv
        .wait_exit(Duration::from_secs(5))
        .expect("quit with the worker on must exit");
    let took = t.elapsed();
    println!("render worker quit: exit after {took:?}");
    assert!(st.success(), "{st}");
    assert!(took < Duration::from_secs(3), "quit took {took:?}");
    let log = std::fs::read_to_string(srv.path("state/livepaper/lp-player/events.jsonl")).unwrap();
    let stopped: Vec<&str> = log
        .lines()
        .filter(|l| l.contains("render_worker.stopped"))
        .collect();
    println!("{stopped:?}");
    assert_eq!(stopped.len(), 1, "{stopped:?}");
    let v: Value = serde_json::from_str(stopped[0]).unwrap();
    assert_eq!(v["left"], json!(0), "{v}");
    assert!(
        !log.contains("mpv.reaper_stragglers"),
        "straggler at quit: {}",
        log.lines()
            .filter(|l| l.contains("stragglers"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Phase 2: a render worker that can't start (its shared context fails — test fault
/// `no-context`: the `lp-render` thread reports a failed start after creating it) never takes
/// the player down: `render_worker.unavailable` is logged, every mpv source renders on the
/// loop (`render_mode: loop`, no `render_worker` in the probe) and the picture is right.
#[test]
fn render_worker_unavailable_falls_back_to_the_loop() {
    let Some(srv) = real_serve_env(
        &["--render-worker", "on"],
        &[(
            "LP_PLAYER_TEST_RENDER_WORKER_FAULT",
            Path::new("no-context"),
        )],
    ) else {
        return;
    };
    let mut c = srv.client();
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);
    let src = source_probe(&mut c, &a);
    let p = c.ok("probe", json!({"name": "sources"}));
    assert_eq!(src["render_mode"], json!("loop"), "{src}");
    assert!(p["render_worker"].is_null(), "{p}");
    let logs = c.ok("logs", json!({"kind_prefix": "render_worker."}));
    let kinds: Vec<&str> = logs["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"render_worker.unavailable"), "{logs}");
    assert!(!kinds.contains(&"render_worker.started"), "{logs}");
    let png = srv.path("out.png");
    c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": png}));
    near(png_pixel(&png, 320, 180), [255, 0, 0], 3, "red on screen");
}

/// Phase 2: the render worker dying (a panic on `lp-render` — test fault `panic`, at its first
/// render) is a runtime failure like a lost compositor, never a silent freeze: before, the
/// thread just ended — every picture froze on its last frame, each new open waited out the 3 s
/// attach timeout, freed cores leaked — and the player kept serving. Now the loop sees it
/// (`render_worker.died {reason}`), silences + tears down like `loop.failed` and exits
/// `EXIT_RUNTIME` (3) — the supervisor restarts it with `--restore` — also when a leaked core
/// makes it leave through `_exit` (that path used to exit 0, which ends supervision).
#[test]
fn render_worker_death_fails_the_player() {
    let Some(mut srv) = real_serve_env(
        &["--render-worker", "on"],
        &[("LP_PLAYER_TEST_RENDER_WORKER_FAULT", Path::new("panic"))],
    ) else {
        return;
    };
    let mut c = srv.client();
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let a = create_src(&mut c, json!({"path": red, "loop": true}));
    show_all(&mut c, &a);
    let st = srv
        .wait_exit(Duration::from_secs(8))
        .expect("a dead render worker must fail the player");
    assert_eq!(st.code(), Some(3), "{st}: {}", srv.stderr());
    let log = std::fs::read_to_string(srv.path("state/livepaper/lp-player/events.jsonl")).unwrap();
    let died: Vec<&str> = log
        .lines()
        .filter(|l| l.contains("\"render_worker.died\""))
        .collect();
    assert_eq!(died.len(), 1, "{log}");
    assert!(died[0].contains("test fault"), "{}", died[0]);
    assert!(
        log.lines().any(|l| l.contains("\"loop.failed\"")),
        "no loop.failed: {log}"
    );
    // Its core was leaked (no worker left to free its render context): the `_exit` path.
    assert!(
        log.lines().any(|l| l.contains("\"mpv.reaper_stragglers\"")),
        "the leaked core isn't a straggler: {log}"
    );
    assert!(
        !srv.path("run/livepaper/lp-player.sock").exists(),
        "socket left behind"
    );
}

// ------------------------------------------------- Phase 2: render worker A/B (measurement)

const BENCH_1080P30: ClipSpec = ClipSpec::TestSrc {
    w: 1920,
    h: 1080,
    fps: 30,
    secs: 10,
};
const BENCH_4K60: ClipSpec = ClipSpec::TestSrc {
    w: 3840,
    h: 2160,
    fps: 60,
    secs: 6,
};
const BENCH_1080P120: ClipSpec = ClipSpec::TestSrc {
    w: 1920,
    h: 1080,
    fps: 120,
    secs: 6,
};

/// Per thread of `pid`: (comm, utime + stime in clock ticks).
fn thread_ticks(pid: u32) -> std::collections::BTreeMap<u32, (String, u64)> {
    let mut out = std::collections::BTreeMap::new();
    let Ok(rd) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return out;
    };
    for e in rd.flatten() {
        let Ok(tid) = e.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else {
            continue;
        };
        let (Some(l), Some(r)) = (stat.find('('), stat.rfind(')')) else {
            continue;
        };
        let comm = stat[l + 1..r].to_string();
        let f: Vec<&str> = stat[r + 2..].split_whitespace().collect();
        let ticks = f[11].parse::<u64>().unwrap_or(0) + f[12].parse::<u64>().unwrap_or(0);
        out.insert(tid, (comm, ticks));
    }
    out
}

/// CPU over `secs` as % of one core: (the loop thread, `lp-render`, the whole process).
fn cpu_split(pid: u32, secs: f64) -> (f64, f64, f64) {
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    let a = thread_ticks(pid);
    std::thread::sleep(Duration::from_secs_f64(secs));
    let b = thread_ticks(pid);
    let (mut main, mut render, mut total) = (0u64, 0u64, 0u64);
    for (tid, (comm, t1)) in &b {
        let t0 = a.get(tid).map_or(0, |(_, t)| *t);
        let d = t1.saturating_sub(t0);
        total += d;
        if *tid == pid {
            main += d;
        } else if comm == "lp-render" {
            render += d;
        }
    }
    let pct = |t: u64| t as f64 / hz / secs * 100.0;
    (pct(main), pct(render), pct(total))
}

/// The `frames` probe's first output, `all` window (reset after reading).
fn frames_all(c: &mut Client) -> Value {
    let f = c.ok("probe", json!({"name": "frames", "args": {"reset": true}}));
    f["outputs"][0]["all"].clone()
}

/// Phase 2 measurement (not a check — `cargo test --release --test api -- --ignored
/// bench_render_worker_ab --nocapture`; rounds `LP_BENCH_ROUNDS`, default 3): the render
/// worker off vs on, interleaved (off/on, then on/off, …), each run on a fresh server.
/// Prints one `BENCH {json}` line per run:
/// - `switch`: the I5 switch loop (`switch_loop_busy`, 640×360 + 320×180): per-switch
///   `max_busy_ms` (warm median, worst), `max_open_ms` (worst);
/// - `cpu`: steady state on two 1920×1080@60 outputs, % of one core for the loop thread,
///   `lp-render` and the process — a 1080p30 clip (`hwdec` no) and a 4K60 one (`nvdec-copy`);
/// - `pace`: one 1920×1080@240 output, `--redraw-policy content`, a 1080p120 clip at 2× (240
///   fps content), then 2× ± 0.05 every 90 ms, then a random 1.6–2.4× every 90 ms (192–288
///   fps: every content interval < 1.5 refresh periods, so each `missed` is a hitch, never a
///   slow frame rate): the `frames` probe's `all` window per 2 s (`missed` = intervals > 1.5
///   refresh periods, `fps`, p95, max) and the loop's `max_busy_ms`.
///
/// `LP_BENCH_ONLY=switch,cpu,pace` runs a subset.
#[test]
#[ignore]
fn bench_render_worker_ab() {
    let rounds: usize = std::env::var("LP_BENCH_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let c1080 = s(&ensure_clip("bench_testsrc_1080p30", BENCH_1080P30)).to_string();
    let c4k = s(&ensure_clip("bench_testsrc_4k60", BENCH_4K60)).to_string();
    let c120 = s(&ensure_clip("bench_testsrc_1080p120", BENCH_1080P120)).to_string();
    for round in 0..rounds {
        let order = if round % 2 == 0 {
            ["off", "on"]
        } else {
            ["on", "off"]
        };
        let only = std::env::var("LP_BENCH_ONLY").unwrap_or_default();
        let run = |k: &str| only.is_empty() || only.split(',').any(|o| o == k);
        for mode in order {
            // 1. Switch cost.
            if run("switch") {
                let Some(srv) = real_serve(&["--render-worker", mode]) else {
                    return;
                };
                let mut c = srv.client();
                let (busy, open) = switch_loop_busy(&mut c);
                let warm = sorted(&busy[1..]);
                println!(
                    "BENCH {}",
                    json!({"round": round, "mode": mode, "kind": "switch",
                       "busy": busy, "open": open,
                       "warm_median": warm[warm.len() / 2], "warm_worst": warm[warm.len() - 1],
                       "open_worst": sorted(&open)[open.len() - 1]})
                );
                drop(c);
                drop(srv);
            }

            // 2. Steady-state CPU.
            if run("cpu") {
                let Some(srv) = real_serve(&[
                    "--render-worker",
                    mode,
                    "--outputs",
                    "1920x1080@60,1920x1080@60",
                ]) else {
                    return;
                };
                let pid = srv.child.as_ref().unwrap().id();
                let mut c = srv.client();
                for (name, clip, hwdec) in [("1080p30", &c1080, ""), ("4k60", &c4k, "nvdec-copy")] {
                    let r = c.ok(
                        "transition",
                        json!({"outputs": "out:*",
                           "to": {"path": clip, "loop": true, "hwdec": hwdec}}),
                    );
                    let b = r["to"].as_str().unwrap().to_string();
                    wait_playing(&mut c, &b, 0.5);
                    std::thread::sleep(Duration::from_millis(1500));
                    c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
                    let (main, render, total) = cpu_split(pid, 6.0);
                    let lp = c.ok("probe", json!({"name": "loop"}));
                    let src = source_probe(&mut c, &b);
                    println!(
                        "BENCH {}",
                        json!({"round": round, "mode": mode, "kind": "cpu", "clip": name,
                           "loop_pct": main, "render_pct": render, "total_pct": total,
                           "max_busy_ms": lp["max_busy_ms"], "render": src["render"],
                           "hwdec_current": src["mpv_hwdec_current"]})
                    );
                }
                drop(c);
                drop(srv);
            }

            // 3. Pacing with high-fps content under speed jitter.
            if !run("pace") {
                continue;
            }
            let Some(srv) = real_serve(&[
                "--render-worker",
                mode,
                "--outputs",
                "1920x1080@240",
                "--redraw-policy",
                "content",
            ]) else {
                return;
            };
            let mut c = srv.client();
            let a = create_src(&mut c, json!({"path": c120, "loop": true, "speed": 2.0}));
            show_all(&mut c, &a);
            wait_playing(&mut c, &a, 0.5);
            std::thread::sleep(Duration::from_millis(1000));
            let speed_path = format!("{a}.speed");
            let mut seed = 0x9e37_79b9_u32.wrapping_add(round as u32);
            let mut rnd = move || {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as f64 / u32::MAX as f64
            };
            for phase in ["steady2x", "jitter2x", "random"] {
                let _ = frames_all(&mut c);
                c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
                let mut windows = Vec::new();
                for _ in 0..3 {
                    let t = Instant::now();
                    let mut k = 0u32;
                    while t.elapsed() < Duration::from_secs(2) {
                        let v = match phase {
                            "steady2x" => None,
                            "jitter2x" => Some(if k.is_multiple_of(2) { 2.05 } else { 1.95 }),
                            _ => Some(1.6 + 0.8 * rnd()),
                        };
                        if let Some(v) = v {
                            c.ok("set", json!({"path": speed_path, "value": v}));
                        }
                        k += 1;
                        std::thread::sleep(Duration::from_millis(90));
                    }
                    windows.push(frames_all(&mut c));
                }
                let lp = c.ok("probe", json!({"name": "loop"}));
                let missed: Vec<u64> = windows
                    .iter()
                    .map(|w| w["missed"].as_u64().unwrap_or(0))
                    .collect();
                println!(
                    "BENCH {}",
                    json!({"round": round, "mode": mode, "kind": "pace", "phase": phase,
                           "missed_per_2s": missed,
                           "missed_per_s": missed.iter().sum::<u64>() as f64 / 6.0,
                           "fps": windows.iter().map(|w| w["fps"].clone()).collect::<Vec<_>>(),
                           "p95_ms": windows.iter().map(|w| w["p95_ms"].clone()).collect::<Vec<_>>(),
                           "max_ms": windows.iter().map(|w| w["max_ms"].clone()).collect::<Vec<_>>(),
                           "max_busy_ms": lp["max_busy_ms"]})
                );
                if phase != "random" {
                    c.ok("set", json!({"path": speed_path, "value": 2.0}));
                }
            }
        }
    }
}

/// Phase 2 on a real compositor (opt-in like t20e — it draws on that compositor's outputs for
/// ~10 s: `LP_PLAYER_TEST_WAYLAND=<absolute wayland socket path>`; a nested headless sway is
/// enough): with the render worker off and on, a video plays on every output (`render_mode`
/// as asked, the right picture in `capture`, frame callbacks keep presents going), a fade to
/// another clip completes, and quit exits 0 with every render context freed. The worker's
/// context shares a Wayland-platform `EGLDisplay` here (headless tests only ever exercise the
/// surfaceless one).
#[test]
fn wayland_render_worker_plays_video() {
    let Some(display) = std::env::var_os("LP_PLAYER_TEST_WAYLAND") else {
        println!("SKIP: set LP_PLAYER_TEST_WAYLAND=<absolute wayland socket path> to run");
        return;
    };
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if common::catalogue_dir().is_none() {
        return;
    }
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let moving = s(&ensure_clip("bench_testsrc_1080p30", BENCH_1080P30)).to_string();
    let mut serial = Some(serial);
    for mode in ["off", "on"] {
        let root = new_root();
        let mut cmd = Command::new(BIN);
        die_with_parent(&mut cmd);
        cmd.args(["serve", "--no-supervise", "--clock", "real", "--ao", "null"])
            .args(["--render-worker", mode])
            .env("XDG_RUNTIME_DIR", root.join("run"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("WAYLAND_DISPLAY", &display)
            .env_remove("DISPLAY")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(
                std::fs::File::create(root.join("stderr-wayland.log")).unwrap(),
            ));
        let mut srv = Serve {
            child: Some(cmd.spawn().expect("spawn lp-player serve (wayland)")),
            sock: root.join("run/livepaper/lp-player.sock"),
            root,
            _serial: serial.take(),
        };
        srv.wait_up();
        let mut c = srv.client();
        let st = c.ok("state", json!({}));
        let out = st["outputs"][0]["name"].as_str().unwrap().to_string();
        let a = create_src(&mut c, json!({"path": red, "loop": true}));
        show_all(&mut c, &a);
        wait_playing(&mut c, &a, 0.5);
        let want = if mode == "on" { "worker" } else { "loop" };
        assert_eq!(source_probe(&mut c, &a)["render_mode"], json!(want));
        let png = srv.path("out.png");
        c.ok(
            "capture",
            json!({"target": format!("out:{out}"), "path": png}),
        );
        let (w, h) = (
            st["outputs"][0]["width"].as_u64().unwrap() as u32,
            st["outputs"][0]["height"].as_u64().unwrap() as u32,
        );
        near(
            png_pixel(&png, w / 2, h / 2),
            [255, 0, 0],
            3,
            "red on the output",
        );
        c.ok("probe", json!({"name": "frames", "args": {"reset": true}}));
        let r = c.ok(
            "transition",
            json!({"outputs": "out:*", "to": {"path": moving, "loop": true},
                   "effect_id": "fade", "duration_ms": 500}),
        );
        let b = r["to"].as_str().unwrap().to_string();
        wait_playing(&mut c, &b, 0.5);
        wait_for(Duration::from_secs(5), "fade done", || {
            let st = c.ok("state", json!({}));
            st["transitions"]
                .as_array()
                .unwrap()
                .is_empty()
                .then_some(())
        });
        std::thread::sleep(Duration::from_millis(1500));
        let f = c.ok("probe", json!({"name": "frames"}));
        let lp = c.ok("probe", json!({"name": "loop"}));
        let fps = f["outputs"][0]["all"]["fps"].as_f64().unwrap();
        println!(
            "wayland render worker {mode}: {out} fps {fps:.1}, paced {}, loop max_busy {} ms, \
             render {}",
            f["outputs"][0]["paced"],
            lp["max_busy_ms"],
            source_probe(&mut c, &b)["render"]
        );
        assert_eq!(source_probe(&mut c, &b)["render_mode"], json!(want));
        assert!(fps > 20.0, "a 30 fps clip presents ~30/s: {f}");
        c.ok("quit", json!({}));
        let st = srv.wait_exit(Duration::from_secs(5)).expect("quit exits");
        assert!(st.success(), "{st}: {}", srv.stderr());
        let log =
            std::fs::read_to_string(srv.path("state/livepaper/lp-player/events.jsonl")).unwrap();
        assert!(log.contains("\"wl.connected\""), "not on Wayland?");
        if mode == "on" {
            assert!(
                log.lines()
                    .any(|l| l.contains("render_worker.stopped") && l.contains("\"left\":0")),
                "render contexts left at quit"
            );
        }
        serial = srv._serial.take();
    }
}

// ---------------------------------------------------------------- the X server going away

/// A private X server for one test, on a display nothing else uses (no lock file, no socket
/// path, no live abstract socket). `None` (the test skips) without `Xvfb` on the PATH.
/// **Never `-displayfd`:** measured here, `Xvfb -displayfd` came up as `:1` while the
/// session's Xwayland held `/tmp/.X1-lock` for `:1` (Hyprland's Xwayland has no abstract
/// socket, and its `/tmp/.X11-unix/X1` path was gone) — and libxcb tries the abstract socket
/// first, so the session's new X clients reached the test's server until it exited.
struct Xvfb {
    child: Child,
    display: String,
}

impl Xvfb {
    fn start() -> Option<Xvfb> {
        use std::os::linux::net::SocketAddrExt;
        use std::os::unix::net::SocketAddr;
        let abstract_live = |n: u32| {
            SocketAddr::from_abstract_name(format!("/tmp/.X11-unix/X{n}"))
                .is_ok_and(|a| UnixStream::connect_addr(&a).is_ok())
        };
        let base = 200 + std::process::id() % 400;
        for n in (base..base + 40).map(|n| 200 + (n - 200) % 400) {
            if Path::new(&format!("/tmp/.X11-unix/X{n}")).exists()
                || Path::new(&format!("/tmp/.X{n}-lock")).exists()
                || abstract_live(n)
            {
                continue;
            }
            let mut c = Command::new("Xvfb");
            die_with_parent(&mut c);
            c.args([
                &format!(":{n}"),
                "-nolisten",
                "tcp",
                "-screen",
                "0",
                "64x64x24",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
            let mut child = c.spawn().ok()?;
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(10) {
                if abstract_live(n) {
                    return Some(Xvfb {
                        child,
                        display: format!(":{n}"),
                    });
                }
                if child.try_wait().ok().flatten().is_some() {
                    break; // lost a race for that display: the next one
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        None
    }

    /// The X server goes away (a session's Xwayland restarting, a logout): every client's
    /// connection breaks at once. SIGTERM, so it removes its socket and lock file (a
    /// SIGKILLed Xvfb leaves both behind); SIGKILL if it lingers.
    fn kill(&mut self) {
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) };
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Crash on rapid superseding switches (2026-10-26): the compositor died with SIGSEGV in
/// `glBindFramebuffer` (compose) while mpv's clipboard thread was in `XCloseDisplay` →
/// `_XIOError` → Xlib's default handler → `exit(1)`, whose atexit handlers tore NVIDIA's EGL
/// down under the loop; its stderr: `X connection to :1 broken (explicit kill or server
/// shutdown)`. mpv ≥ 0.40 gives every core a native clipboard — without `WAYLAND_DISPLAY`
/// (that run's environment) its own X connection — and those connections broke (both live
/// cores' at once, 2 ms after an Electron's scope ended: most likely a UI-matrix shard's
/// private `Xvfb -displayfd`, which comes up as `:1` here, going away with its shard). A
/// headless wallpaper player must not die with an X server it never needed.
/// Here: a video plays (`DISPLAY` = a private `Xvfb`, no `WAYLAND_DISPLAY`), the X server
/// goes away, the player plays on, switches and quits cleanly. RED before: SIGSEGV within
/// ms of the X loss, `X connection to :N broken …` on its stderr.
#[test]
fn losing_the_x_server_never_kills_the_player() {
    let Some(mut probe) = Serve::start() else {
        return;
    };
    let serial = probe._serial.take();
    drop(probe);
    let Some(mut x) = Xvfb::start() else {
        println!("SKIP: no Xvfb on the PATH");
        return;
    };
    let red = s(&ensure_clip("tr_red_10s", RED_10S)).to_string();
    let blue = s(&ensure_clip("tr_blue_10s", BLUE_10S)).to_string();
    let mut srv = Serve::spawn_env_without(
        new_root(),
        &["--clock", "real"],
        &[("DISPLAY", Path::new(&x.display))],
        &["WAYLAND_DISPLAY", "WAYLAND_SOCKET"],
        serial,
    );
    let mut c = srv.client();
    let pid = c.ok("hello", json!({}))["pid"].clone();
    let a = create_src(&mut c, json!({"path": red, "loop": true, "hwdec": "auto"}));
    show_all(&mut c, &a);
    wait_playing(&mut c, &a, 0.3);

    x.kill();
    std::thread::sleep(Duration::from_millis(1000));
    if let Some(st) = srv.child.as_mut().unwrap().try_wait().unwrap() {
        panic!("the player died with the X server ({st}): {}", srv.stderr());
    }
    assert_eq!(c.ok("hello", json!({}))["pid"], pid);
    // It plays on and still switches.
    let t0 = f64_of(&mut c, &format!("{a}.time_pos")).unwrap_or(0.0);
    wait_playing(&mut c, &a, t0 + 0.2);
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"path": blue, "loop": true, "hwdec": "auto"},
               "effect_id": "fade", "duration_ms": 200}),
    );
    let b = r["to"].as_str().unwrap().to_string();
    wait_playing(&mut c, &b, 0.2);
    wait_for(
        Duration::from_secs(10),
        "the switch after the X loss",
        || {
            let st = c.ok("state", json!({}));
            st["transitions"]
                .as_array()
                .unwrap()
                .is_empty()
                .then_some(())
        },
    );
    assert_eq!(content(&mut c, "VIRTUAL-1"), b);
    c.ok("quit", json!({}));
    let st = srv.wait_exit(Duration::from_secs(5)).expect("quit exits");
    assert!(st.success(), "{st}: {}", srv.stderr());
    assert!(!srv.stderr().contains("X connection"), "{}", srv.stderr());
}

// ---------------------------------------------------------------- Phase 2 Task 5: scenes

use lp_player::scene::synthetic::{Pattern, SyntheticSpec, marker_rgb};

/// A server whose scene sources may play the synthetic renderer (D7:
/// `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1`, test-only).
fn scene_serve(extra: &[&str]) -> Option<Serve> {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return None;
    }
    Some(scene_serve_in(extra, Some(serial)))
}

fn scene_serve_in(extra: &[&str], serial: Option<MutexGuard<'static, ()>>) -> Serve {
    Serve::spawn_env(
        new_root(),
        extra,
        &[("LP_PLAYER_ALLOW_SYNTHETIC_SCENES", Path::new("1"))],
        serial,
    )
}

fn synth(pattern: Pattern) -> SyntheticSpec {
    SyntheticSpec {
        pattern,
        ..SyntheticSpec::default()
    }
}

/// A synthetic scene folder as a `kind: scene` source (`extra` props merged).
fn create_scene(c: &mut Client, name: &str, spec: &SyntheticSpec, extra: Value) -> String {
    let dir = common::synthetic_scene(name, spec);
    let mut props = extra.as_object().cloned().unwrap_or_default();
    props.insert("kind".into(), json!("scene"));
    props.insert("path".into(), json!(s(&dir)));
    create_src(c, Value::Object(props))
}

/// `id`'s entry in the `workers` probe.
fn worker_of(c: &mut Client, id: &str) -> Value {
    let p = c.ok("probe", json!({"name": "workers"}));
    p["workers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == json!(id))
        .cloned()
        .unwrap_or_else(|| panic!("no worker for {id}: {p}"))
}

fn pid_alive(pid: u64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// `hello` offers `scene`; a scene source readies on a step; `state.workers`, the `workers`
/// probe and the `sources` probe all show its worker.
#[test]
fn scene_capability_state_and_workers_probe() {
    let Some(srv) = scene_serve(&[]) else { return };
    let mut c = srv.client();
    let h = c.ok("hello", json!({}));
    assert!(
        h["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("scene")),
        "{h}"
    );
    let id = create_scene(&mut c, "api-caps", &synth(Pattern::FrameIndex), json!({}));
    show_all(&mut c, &id);
    c.step(16);
    assert_eq!(
        get(&mut c, &format!("{id}.ready"))["result"]["value"],
        json!(true)
    );
    let st = c.ok("state", json!({}));
    assert_eq!(st["graph"][&id]["kind"], json!("scene"), "{st}");
    let w = &st["workers"][0];
    assert_eq!(w["id"], json!(id), "{st}");
    let pid = w["pid"].as_u64().expect("a worker pid");
    assert!(pid_alive(pid));
    let w = worker_of(&mut c, &id);
    for (k, v) in [
        ("state", json!("running")),
        ("sync", json!("fence")),
        ("fourcc", json!("AB24")),
        ("size", json!([640, 360])),
        ("native", json!([1920, 1080])),
        ("max_size", json!([640, 360])),
        ("stepped", json!(true)),
        ("ready", json!(true)),
        ("restarts_60s", json!(0)),
    ] {
        assert_eq!(w[k], v, "workers.{k}: {w}");
    }
    let p = c.ok("probe", json!({"name": "sources"}));
    let src = probe_source(&p, &id);
    assert_eq!(src["live_kind"], json!("scene"), "{src}");
    assert_eq!(src["pid"], json!(pid));
    assert_eq!(src["step_status"], json!("Done"));
}

/// R75 for scenes: `player.paused` freezes `time_pos` and the picture (no latch), the
/// node's own `paused` untouched, `effective_paused` in the probe; resuming continues.
#[test]
fn player_pause_freezes_scene() {
    let Some(mut srv) = scene_serve(&[]) else {
        return;
    };
    let serial = srv._serial.take();
    drop(srv);
    let srv = scene_serve_in(&["--clock", "real"], serial);
    let mut c = srv.client();
    let id = create_scene(&mut c, "api-ppause", &synth(Pattern::FrameIndex), json!({}));
    show_all(&mut c, &id);
    wait_playing(&mut c, &id, 0.3);
    c.ok("set", json!({"path": "player.paused", "value": true}));
    std::thread::sleep(Duration::from_millis(50));
    let t1 = f64_of(&mut c, &format!("{id}.time_pos")).unwrap();
    let l1 = worker_of(&mut c, &id)["latched"].as_u64().unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let t2 = f64_of(&mut c, &format!("{id}.time_pos")).unwrap();
    let w = worker_of(&mut c, &id);
    assert_eq!(t2, t1, "time_pos frozen");
    assert_eq!(w["latched"].as_u64().unwrap(), l1, "no frame latched: {w}");
    assert_eq!(w["paused"], json!(true), "the worker side is paused: {w}");
    let p = c.ok("probe", json!({"name": "sources"}));
    let src = probe_source(&p, &id);
    assert_eq!(src["paused"], json!(false), "the node's own paused: {src}");
    assert_eq!(src["effective_paused"], json!(true), "{src}");
    c.ok("set", json!({"path": "player.paused", "value": false}));
    std::thread::sleep(Duration::from_millis(300));
    let t3 = f64_of(&mut c, &format!("{id}.time_pos")).unwrap();
    assert!(
        t3 > t2 + 0.15 && t3 < t2 + 0.6,
        "continues from where it stopped: {t2} → {t3}"
    );
    assert!(worker_of(&mut c, &id)["latched"].as_u64().unwrap() > l1);
}

/// Stepped mode ticks exactly each step's scene time: two servers, the same script →
/// byte-identical captures (frame_index: the marker is the tick's seq).
#[test]
fn stepped_scene_is_deterministic() {
    let Some(mut srv1) = scene_serve(&[]) else {
        return;
    };
    let run = |srv: &Serve| -> (Vec<u8>, Value) {
        let mut c = srv.client();
        let id = create_scene(&mut c, "api-det", &synth(Pattern::FrameIndex), json!({}));
        show_all(&mut c, &id);
        let t = Instant::now();
        for _ in 0..60 {
            c.step(16);
        }
        // A frame whose fence signals after its `Frame` wakes the loop (no timer in stepped
        // mode): before, such a step finished only at its 2 s deadline (155 s for this test).
        let took = t.elapsed();
        assert!(took < Duration::from_secs(15), "60 steps took {took:?}");
        let p = srv.path("det.png");
        c.ok("capture", json!({"target": "out:VIRTUAL-1", "path": s(&p)}));
        let w = worker_of(&mut c, &id);
        (std::fs::read(&p).unwrap(), w)
    };
    let (a, wa) = run(&srv1);
    let serial = srv1._serial.take();
    drop(srv1);
    let srv2 = scene_serve_in(&[], serial);
    let (b, wb) = run(&srv2);
    // Opened at step 1 (t = 0), then 59 × 16 ms; one tick per step.
    for w in [&wa, &wb] {
        let t = w["latched_t"].as_f64().unwrap();
        assert!((t - 59.0 * 0.016).abs() < 1e-9, "latched_t {t}: {w}");
        assert_eq!(w["ticks_sent"], json!(60), "{w}");
    }
    assert!(a == b, "captures differ between runs");
}

/// Creating (spawn, imports) and destroying (quit, reap off the loop) a scene never stalls
/// the loop; the worker is gone soon after the destroy.
#[test]
fn scene_create_and_destroy_never_stall_the_loop() {
    let Some(mut srv) = scene_serve(&[]) else {
        return;
    };
    let serial = srv._serial.take();
    drop(srv);
    let srv = scene_serve_in(&["--clock", "real"], serial);
    let mut c = srv.client();
    // Warm up (first EGL import paths, the clip cache) so the measurement is the scene's.
    let warm = create_scene(&mut c, "api-stall-warm", &synth(Pattern::Solid), json!({}));
    show_all(&mut c, &warm);
    wait_playing(&mut c, &warm, 0.1);
    c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
    let id = create_scene(&mut c, "api-stall", &synth(Pattern::FrameIndex), json!({}));
    show_all(&mut c, &id);
    wait_playing(&mut c, &id, 0.2);
    let l = c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
    let busy_create = l["max_busy_ms"].as_f64().unwrap();
    let pid = worker_of(&mut c, &id)["pid"].as_u64().unwrap();
    c.ok("set", json!({"path": "lay:*:main.content", "value": ""}));
    c.ok("destroy", json!({"id": id}));
    let t = Instant::now();
    while pid_alive(pid) && t.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let gone = t.elapsed();
    std::thread::sleep(Duration::from_millis(50));
    let l = c.ok("probe", json!({"name": "loop"}));
    let busy_destroy = l["max_busy_ms"].as_f64().unwrap();
    println!(
        "loop max busy: create {busy_create:.2} ms, destroy {busy_destroy:.2} ms; worker gone after {gone:?}"
    );
    assert!(busy_create <= 3.0, "create: max busy {busy_create} ms");
    assert!(busy_destroy <= 3.0, "destroy: max busy {busy_destroy} ms");
    assert!(
        gone <= Duration::from_millis(600),
        "worker still there after {gone:?}"
    );
    assert!(!exists(&mut c, &id));
}

/// Review Focus #4: every output gone while a scene plays → parked (paused, silent, no
/// ticks, worker kept); an output back → unparked, ticking again, same worker.
#[test]
fn scene_parks_and_resumes_on_hotplug() {
    let Some(srv) = scene_serve(&[]) else { return };
    let mut c = srv.client();
    let id = create_scene(&mut c, "api-park", &synth(Pattern::FrameIndex), json!({}));
    show_all(&mut c, &id);
    for _ in 0..3 {
        c.step(16);
    }
    let pid = worker_of(&mut c, &id)["pid"].clone();
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-1"}));
    c.ok("headless.remove_output", json!({"name": "VIRTUAL-2"}));
    for _ in 0..3 {
        c.step(16);
    }
    let st = c.ok("state", json!({}));
    assert_eq!(st["parked"], json!(id), "{st}");
    assert_eq!(st["graph"][&id]["paused"], json!(true));
    assert_eq!(
        st["graph"][&id]["gain_effective_db"],
        json!(-96.0),
        "parked = silent"
    );
    let ticks = worker_of(&mut c, &id)["ticks_sent"].clone();
    for _ in 0..5 {
        c.step(16);
    }
    let w = worker_of(&mut c, &id);
    assert_eq!(w["ticks_sent"], ticks, "no ticks while parked: {w}");
    assert_eq!(w["pid"], pid, "worker kept");
    assert!(pid_alive(pid.as_u64().unwrap()));
    c.ok(
        "headless.add_output",
        json!({"name": "VIRTUAL-3", "width": 320, "height": 180, "hz": 60}),
    );
    assert_eq!(
        content(&mut c, "VIRTUAL-3"),
        id,
        "the parked scene is shown"
    );
    for _ in 0..3 {
        c.step(16);
    }
    let st = c.ok("state", json!({}));
    assert_eq!(st["graph"][&id]["paused"], json!(false));
    assert_eq!(st["parked"], Value::Null);
    let w = worker_of(&mut c, &id);
    assert!(
        w["ticks_sent"].as_u64().unwrap() > ticks.as_u64().unwrap(),
        "ticking again: {w}"
    );
    assert_eq!(w["pid"], pid, "same worker");
}

/// R25 for scenes: a captured scene source (and the output showing it) is upright — the
/// scene's top row is the image's top.
#[test]
fn capture_scene_source_is_upright() {
    let Some(srv) = scene_serve(&[]) else { return };
    let mut c = srv.client();
    let id = create_scene(&mut c, "api-upright", &synth(Pattern::SplitTb), json!({}));
    show_all(&mut c, &id);
    c.step(16);
    c.step(16);
    let p = srv.path("scene.png");
    let r = c.ok("capture", json!({"target": id, "path": s(&p)}));
    let h = r["height"].as_u64().unwrap() as u32;
    near(png_pixel(&p, 100, 10), [255, 0, 0], 0, "scene capture top");
    near(
        png_pixel(&p, 100, h - 10),
        [0, 0, 255],
        0,
        "scene capture bottom",
    );
    let p2 = srv.path("scene_out.png");
    c.ok(
        "capture",
        json!({"target": "out:VIRTUAL-1", "path": s(&p2)}),
    );
    near(png_pixel(&p2, 320, 10), [255, 0, 0], 0, "output top");
    near(png_pixel(&p2, 320, 350), [0, 0, 255], 0, "output bottom");
    let _ = marker_rgb(0);
}

// ---------------------------------------------------------------- Phase 2 Task 7: real scenes

/// `patches/lwe/tests/fixtures/<name>` (real LWE projects that need no WE assets).
fn lwe_fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../patches/lwe/tests/fixtures")
        .join(name)
}

/// A directory that passes for WE's `assets/` (the probe file the resolver looks for).
fn fake_assets(root: &Path) -> PathBuf {
    let a = root.join("we-assets");
    std::fs::create_dir_all(a.join("shaders")).unwrap();
    std::fs::write(a.join("shaders/genericimage2.vert"), "// probe").unwrap();
    a
}

/// `logs` records of `kind_prefix` (oldest first).
fn logs_of(c: &mut Client, kind_prefix: &str) -> Vec<Value> {
    c.ok("logs", json!({"kind_prefix": kind_prefix, "limit": 1000}))["events"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn crash_files(srv: &Serve) -> usize {
    std::fs::read_dir(srv.path("state/livepaper/lp-player/crashes"))
        .map(|r| r.flatten().count())
        .unwrap_or(0)
}

/// Review Focus #2: no WE assets (no Steam under `$HOME`, no `LP_WE_ASSETS_DIR`) → no `scene`
/// capability, `scene-check` exits 1 with the reason, and a scene created anyway errors with a
/// hint naming `LP_WE_ASSETS_DIR` / `player.scene_assets` — no worker, no 1×1 render loop.
/// Setting `player.scene_assets` brings scenes back live.
#[test]
fn no_assets_dir_hides_scenes_and_errors_with_hint() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let root = new_root();
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let unset = ["LP_WE_ASSETS_DIR", "LP_PLAYER_ALLOW_SYNTHETIC_SCENES"];
    let srv = Serve::spawn_env_without(
        root.clone(),
        &[],
        &[("HOME", home.as_path())],
        &unset,
        Some(serial),
    );
    let mut c = srv.client();
    let caps = c.ok("hello", json!({}))["capabilities"].clone();
    assert!(
        !caps.as_array().unwrap().contains(&json!("scene")),
        "{caps}"
    );
    assert_eq!(
        get(&mut c, "player.scene_assets_resolved")["result"]["value"],
        json!("")
    );
    // `lp-player scene-check` says the same, exit 1.
    let out = Command::new(BIN)
        .arg("scene-check")
        .env("HOME", &home)
        .env_remove("LP_WE_ASSETS_DIR")
        .env_remove("LP_PLAYER_ALLOW_SYNTHETIC_SCENES")
        .output()
        .unwrap();
    let j: Value = serde_json::from_slice(&out.stdout).expect("one JSON line");
    assert_eq!(out.status.code(), Some(1), "{j}");
    assert_eq!(j["ok"], json!(false));
    assert!(
        j["reason"].as_str().unwrap().contains("LP_WE_ASSETS_DIR"),
        "{j}"
    );
    // A scene anyway: an error with the hint, no worker.
    let id = create_src(
        &mut c,
        json!({"kind": "scene", "path": s(&lwe_fixture("min-scene"))}),
    );
    show_all(&mut c, &id);
    let _ = c.call("step", json!({"ms": 16}));
    let errs: Vec<Value> = logs_of(&mut c, "source.error")
        .into_iter()
        .filter(|e| e["id"] == json!(id))
        .collect();
    let reason = errs
        .first()
        .and_then(|e| e["reason"].as_str())
        .unwrap_or_else(|| panic!("no source.error for {id}"))
        .to_string();
    assert!(
        reason.contains("LP_WE_ASSETS_DIR") && reason.contains("player.scene_assets"),
        "{reason}"
    );
    let st = c.ok("state", json!({}));
    assert!(
        st["workers"].as_array().unwrap().is_empty(),
        "no worker: {}",
        st["workers"]
    );
    // Live: point the player at an assets dir.
    let assets = fake_assets(&root);
    c.ok(
        "set",
        json!({"path": "player.scene_assets", "value": s(&assets)}),
    );
    assert_eq!(
        get(&mut c, "player.scene_assets_resolved")["result"]["value"],
        json!(s(&assets))
    );
    let caps = c.ok("hello", json!({}))["capabilities"].clone();
    assert!(caps.as_array().unwrap().contains(&json!("scene")), "{caps}");
}

/// Review Focus #1: a scene folder that is gone (deleted, a dangling `local/<id>` link, Steam
/// still syncing) fails cleanly — `source.error` "load failed", no crash record, no worker
/// restart.
#[test]
fn missing_scene_folder_fails_without_crash_record() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    let root = new_root();
    let assets = fake_assets(&root);
    let srv = Serve::spawn_env(
        root.clone(),
        &[],
        &[("LP_WE_ASSETS_DIR", assets.as_path())],
        Some(serial),
    );
    let mut c = srv.client();
    let gone = root.join("library/local/2371103399");
    let id = create_src(&mut c, json!({"kind": "scene", "path": s(&gone)}));
    show_all(&mut c, &id);
    let reason = wait_for(Duration::from_secs(10), "source.error", || {
        let _ = c.call("step", json!({"ms": 16}));
        logs_of(&mut c, "source.error")
            .into_iter()
            .find(|e| e["id"] == json!(id))
            .and_then(|e| e["reason"].as_str().map(str::to_string))
    });
    assert!(reason.contains("load failed"), "{reason}");
    for _ in 0..5 {
        let _ = c.call("step", json!({"ms": 100}));
    }
    assert!(logs_of(&mut c, "worker.restart").is_empty());
    assert!(logs_of(&mut c, "worker.broken").is_empty());
    assert_eq!(crash_files(&srv), 0, "no crash record");
}

/// Mouse on: `headless.pointer` over an output reaches the scene in its own coordinates (the
/// pointer_dot scene draws its dot there), and during a fade both sides see it.
#[test]
fn pointer_reaches_scene_in_source_coords() {
    let Some(srv) = scene_serve(&[]) else { return };
    let mut c = srv.client();
    let dot = SyntheticSpec {
        pattern: Pattern::PointerDot,
        rgb: [255, 0, 0],
        rgb2: [0, 0, 255],
        ..SyntheticSpec::default()
    };
    let a = create_scene(&mut c, "api-ptr-a", &dot, json!({}));
    show_all(&mut c, &a);
    c.step(16);
    c.step(16);
    // VIRTUAL-1 is 640×360 showing a 1920×1080 scene (exported 640×360): (160, 90) on the
    // output = (480, 270) in the scene's native pixels = (160, 90) in the export.
    let r = c.ok(
        "headless.pointer",
        json!({"output": "VIRTUAL-1", "x": 160, "y": 90}),
    );
    assert_eq!(r["scenes"], json!([a]), "{r}");
    c.step(16);
    c.step(16);
    assert_eq!(worker_of(&mut c, &a)["pointer"], json!([480.0, 270.0, 0]));
    let p = srv.path("ptr-a.png");
    c.ok("capture", json!({"target": a, "path": s(&p)}));
    near(
        png_pixel(&p, 160, 90),
        [255, 0, 0],
        0,
        "the dot under the pointer",
    );
    near(
        png_pixel(&p, 160 + 14, 90),
        [255, 0, 0],
        0,
        "inside its radius",
    );
    near(png_pixel(&p, 480, 270), [0, 0, 255], 0, "elsewhere");
    // A fade to another scene: both sides get the pointer.
    let dir_b = common::synthetic_scene("api-ptr-b", &dot);
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"kind": "scene", "path": s(&dir_b)},
               "effect_id": "fade", "duration_ms": 5000}),
    );
    let b = r["to"].as_str().unwrap().to_string();
    for _ in 0..6 {
        c.step(16);
    }
    let r = c.ok(
        "headless.pointer",
        json!({"output": "VIRTUAL-1", "x": 480, "y": 270}),
    );
    let mut reached: Vec<String> = serde_json::from_value(r["scenes"].clone()).unwrap();
    reached.sort();
    let mut want = vec![a.clone(), b.clone()];
    want.sort();
    assert_eq!(reached, want, "both sides of the fade");
    c.step(16);
    c.step(16);
    for id in [&a, &b] {
        let p = srv.path(&format!("ptr-{id}.png"));
        c.ok("capture", json!({"target": id, "path": s(&p)}));
        near(
            png_pixel(&p, 480, 270),
            [255, 0, 0],
            0,
            &format!("{id}: dot"),
        );
        near(
            png_pixel(&p, 160, 90),
            [0, 0, 255],
            0,
            &format!("{id}: moved"),
        );
    }
    // A point outside the output's picture reaches nobody (VIRTUAL-2 is 320×180).
    let r = c.ok(
        "headless.pointer",
        json!({"output": "VIRTUAL-2", "x": -5, "y": 10}),
    );
    assert_eq!(r["scenes"], json!([]));
}

/// The scene properties' worker side: `scene_props` (name → value) is applied at open and
/// live (`wp_project_property_set_*` through the protocol; synthetic: `rgb`), same worker; an
/// unknown property is reported, not fatal.
#[test]
fn scene_props_apply_at_open_and_live() {
    let Some(srv) = scene_serve(&[]) else { return };
    let mut c = srv.client();
    let id = create_scene(
        &mut c,
        "api-props",
        &synth(Pattern::Solid),
        json!({"scene_props": {"rgb": [0, 0, 255]}}),
    );
    show_all(&mut c, &id);
    c.step(16);
    c.step(16);
    let cap = |c: &mut Client, n: &str| {
        let p = srv.path(n);
        c.ok("capture", json!({"target": id, "path": s(&p)}));
        png_pixel(&p, 100, 100)
    };
    near(cap(&mut c, "props0.png"), [0, 0, 255], 0, "applied at open");
    let pid = worker_of(&mut c, &id)["pid"].clone();
    c.ok(
        "set",
        json!({"path": format!("{id}.scene_props"), "value": {"rgb": [0, 255, 0]}}),
    );
    c.step(16);
    c.step(16);
    near(cap(&mut c, "props1.png"), [0, 255, 0], 0, "live");
    let w = worker_of(&mut c, &id);
    assert_eq!(w["pid"], pid, "same worker");
    assert_eq!(w["properties"]["rgb"]["ok"], json!(true), "{w}");
    c.ok(
        "set",
        json!({"path": format!("{id}.scene_props"),
               "value": {"rgb": [0, 255, 0], "no_such": 1}}),
    );
    c.step(16);
    c.step(16);
    let w = worker_of(&mut c, &id);
    assert_eq!(w["properties"]["no_such"]["ok"], json!(false), "{w}");
    let ev = logs_of(&mut c, "scene.property");
    assert!(
        ev.iter()
            .any(|e| e["name"] == json!("no_such") && e["ok"] == json!(false)),
        "{ev:?}"
    );
    near(cap(&mut c, "props2.png"), [0, 255, 0], 0, "still playing");
    assert_eq!(
        get(&mut c, &format!("{id}.ready"))["result"]["value"],
        json!(true)
    );
}

/// A 10 s 440 Hz −6 dBFS stereo s16 WAV.
fn tone_wav(path: &Path) {
    let rate = 48_000u32;
    let n = rate * 10;
    let mut b = Vec::with_capacity(44 + n as usize * 4);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n * 4).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 4).to_le_bytes());
    b.extend_from_slice(&4u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n * 4).to_le_bytes());
    for i in 0..n {
        let v = (0.5
            * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / rate as f64).sin()
            * 32767.0) as i16;
        b.extend_from_slice(&v.to_le_bytes());
        b.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
}

/// The `node.name`s of the private PipeWire's nodes.
fn pw_nodes(pw: &PrivatePw) -> Vec<String> {
    let out = Command::new("pw-dump")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("XDG_RUNTIME_DIR", pw.run_dir())
        .env("PIPEWIRE_RUNTIME_DIR", pw.run_dir())
        .output()
        .expect("pw-dump");
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(json!([]));
    v.as_array()
        .unwrap()
        .iter()
        .filter_map(|o| o["info"]["props"]["node.name"].as_str().map(str::to_string))
        .collect()
}

/// D4: the visualiser input is the system's audio (a mix of PipeWire playback streams) — a tone
/// played by another app reaches a scene that wants audio input (`input_level`), a scene
/// without the flag gets none, and no capture stream exists while no scene wants one
/// (private PipeWire; SKIP without the binaries).
#[test]
fn visualiser_input_reaches_only_scenes_that_want_it() {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !can_run() {
        return;
    }
    if !PrivatePw::available() {
        println!("SKIP: no pipewire/wireplumber binaries for a private instance");
        return;
    }
    let root = new_root();
    let mut pw = PrivatePw::new(root.join("pw"));
    pw.start();
    let run = pw.run_dir();
    let srv = Serve::spawn_env(
        root.clone(),
        &["--clock", "real"],
        &[
            ("PIPEWIRE_RUNTIME_DIR", run.as_path()),
            ("LP_PLAYER_ALLOW_SYNTHETIC_SCENES", Path::new("1")),
        ],
        Some(serial),
    );
    let mut c = srv.client();
    let has_capture = |pw: &PrivatePw| {
        pw_nodes(pw)
            .iter()
            .any(|n| n.starts_with("lp-player-visualiser."))
    };
    let b = create_scene(&mut c, "api-vis-b", &synth(Pattern::Solid), json!({}));
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-2:main.content", "value": b}),
    );
    wait_playing(&mut c, &b, 0.3);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(worker_of(&mut c, &b)["wants_audio_input"], json!(false));
    assert!(
        !has_capture(&pw),
        "no capture without a scene that wants it"
    );
    let wav = root.join("tone.wav");
    tone_wav(&wav);
    let mut tone = pw.spawn("pw-cat", &["--playback", wav.to_str().unwrap()]);
    let a = create_scene(&mut c, "api-vis-a", &synth(Pattern::InputLevel), json!({}));
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-1:main.content", "value": a}),
    );
    let db = wait_for(Duration::from_secs(8), "the tone at the scene", || {
        let w = worker_of(&mut c, &a);
        w["input_dbfs"].as_f64().filter(|d| *d > -30.0)
    });
    println!("visualiser input: {db:.1} dBFS");
    assert!(has_capture(&pw), "a capture stream while A wants input");
    let wb = worker_of(&mut c, &b);
    assert_eq!(wb["input_dbfs"], Value::Null, "B gets none: {wb}");
    let p = srv.path("vis.png");
    c.ok("capture", json!({"target": a, "path": s(&p)}));
    let lvl = png_pixel(&p, 10, 10)[0];
    assert!(lvl > 40, "the input_level scene shows the level: {lvl}");
    // A goes: the capture stops.
    c.ok(
        "set",
        json!({"path": "lay:VIRTUAL-1:main.content", "value": ""}),
    );
    c.ok("destroy", json!({"id": a}));
    wait_for(Duration::from_secs(5), "the capture to stop", || {
        (!has_capture(&pw)).then_some(())
    });
    let _ = tone.kill();
    let _ = tone.wait();
}
