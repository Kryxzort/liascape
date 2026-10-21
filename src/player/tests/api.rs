//! Task 12: the runtime + command API end to end. Every test spawns the real binary —
//! `lp-player serve --headless --outputs 640x360@60,320x180@60 --clock stepped --ao null`
//! — with a temp `XDG_RUNTIME_DIR` / `XDG_STATE_HOME` (never the real ones), talks JSON
//! lines over its socket, and kills the child on drop (also on panic). Skips (prints
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

fn serve_cmd(root: &Path, extra: &[&str]) -> Command {
    let mut c = Command::new(BIN);
    c.args([
        "serve",
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
        let child = serve_cmd(&root, extra)
            .spawn()
            .expect("spawn lp-player serve");
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

    // Half a line, then gone.
    {
        let mut half = UnixStream::connect(&srv.sock).unwrap();
        half.write_all(br#"{"id":1,"cmd":"hel"#).unwrap();
    }

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
    // From here on, the longest synchronous stretch the loop spends anywhere (the
    // post-dispatch sync that drops the source, then a whole step).
    c.ok("probe", json!({"name": "loop", "args": {"reset": true}}));
    c.ok("destroy", json!({"id": id}));
    c.step(16);
    c.step(16);
    let lp = c.ok("probe", json!({"name": "loop"}));
    let busy = lp["max_busy_ms"].as_f64().expect("max_busy_ms");
    println!("R51 stepped: max busy {busy:.2} ms around the destroy");
    assert!(
        busy < 20.0,
        "the loop was busy {busy} ms around the destroy: {lp}"
    );
    let last = lp["last_tick_ms"].as_f64().expect("last_tick_ms");
    assert!(last < 20.0, "a tick after the destroy took {last} ms: {lp}");
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
        busy < 20.0,
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
    let mut sub = Command::new(BIN)
        .args(["ctl", "subscribe", "transition."])
        .env("XDG_RUNTIME_DIR", srv.root.join("run"))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let mut c = srv.client();
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
