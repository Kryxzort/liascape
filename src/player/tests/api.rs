//! Task 12: the runtime + command API end to end. Every test spawns the real binary —
//! `lp-player serve --no-supervise --headless --outputs 640x360@60,320x180@60 --clock
//! stepped --ao null` — with a temp `XDG_RUNTIME_DIR` / `XDG_STATE_HOME` (never the real
//! ones), talks JSON lines over its socket, and kills the child on drop (also on panic).
//! `--no-supervise` (Task 16): the spawned process *is* the compositor (pid checks, lock
//! owner, SIGTERM); supervision has its own suite (`tests/supervise.rs`). Skips (prints
//! `SKIP: …`) only without an EGL device or a `transitions/` catalogue.
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
use lp_player::gfx::Catalogue;
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

fn can_run() -> bool {
    if headless_gl().is_none() {
        return false;
    }
    if Catalogue::resolve_dir().is_none() {
        println!("SKIP: no transitions/ directory resolved");
        return false;
    }
    true
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
        let mut cmd = serve_cmd(&root, extra);
        for (k, v) in env {
            cmd.env(k, v);
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

    fn err(&mut self, cmd: &str, args: Value) -> Value {
        let r = self.call(cmd, args.clone());
        assert_eq!(r["ok"], json!(false), "{cmd} {args} should fail: {r}");
        r["error"].clone()
    }

    fn step(&mut self, ms: u64) {
        self.ok("step", json!({ "ms": ms }));
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
        let anticlick = get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"]
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
        let anticlick = get(&mut c, &format!("{id}.gain.anticlick"))["result"]["value"]
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
    let anticlick = |c: &mut Client, id: &str| -> f64 {
        get(c, &format!("{id}.gain.anticlick"))["result"]["value"]
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
        // `player.paused` freezes *every* animation (R75, invariant #7) — including
        // `retire`'s own teardown ramp, if the player is still paused when `destroy`
        // was issued ("Pausing"/"Paused" above left it `true`; "AwaitingFlow"/
        // "Resuming" already turned it back off before destroying). That's the correct,
        // consistent behaviour (everything freezes together), not something this test
        // should fight — un-pause so the ramp (and so the destroy) can actually
        // complete, the same way a real session would eventually resume.
        c.ok("set", json!({"path": "player.paused", "value": false}));

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
    assert!(
        before["gain_timer_armed"] == json!(true),
        "the animation hasn't finished: the timer must still be armed: {before}"
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
