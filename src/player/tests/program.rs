//! Phase 3: programs (`prog:<name>`, kind `program`) — the rotation recipe end to end.
//! Every test spawns the real binary (`serve --no-supervise --headless --outputs
//! 640x360@60,320x180@60 --clock stepped --ao null`) with temp `XDG_*` dirs, talks JSON
//! lines over its socket and kills the child on drop (`tests/api.rs`' harness, trimmed).
//! Skips (prints `SKIP: …`) without an EGL device or a catalogue — fails instead under
//! `LIASCAPE_REQUIRE_GPU=1`.
//!
//! One server at a time (a process-wide lock), as in `tests/api.rs`.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use common::{ClipSpec, ensure_clip, headless_gl};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_liascape-player");
static SERIAL: Mutex<()> = Mutex::new(());
static N: AtomicU32 = AtomicU32::new(0);

// ---------------------------------------------------------------- server + client

struct Serve {
    child: Option<Child>,
    root: PathBuf,
    sock: PathBuf,
    _serial: MutexGuard<'static, ()>,
}

impl Serve {
    fn start() -> Option<Serve> {
        Serve::start_env(&[])
    }

    fn start_env(env: &[(&str, &str)]) -> Option<Serve> {
        Serve::start_clock(env, "stepped")
    }

    fn start_clock(env: &[(&str, &str)], clock: &str) -> Option<Serve> {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        if headless_gl().is_none() || common::catalogue_dir().is_none() {
            common::skip_gpu("no EGL device or no transitions/ catalogue");
            return None;
        }
        let root = std::env::temp_dir().join(format!(
            "liascape-program-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("run")).unwrap();
        std::fs::create_dir_all(root.join("state")).unwrap();
        let mut c = Command::new(BIN);
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                c.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    Ok(())
                });
            }
        }
        c.args([
            "serve",
            "--no-supervise",
            "--headless",
            "--outputs",
            "640x360@60,320x180@60",
            "--clock",
            clock,
            "--ao",
            "null",
        ])
        .env("LIASCAPE_PLAYER_VRAM_PROBE", "none")
        .env("XDG_RUNTIME_DIR", root.join("run"))
        .env("XDG_STATE_HOME", root.join("state"))
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
        let mut s = Serve {
            child: Some(child),
            root,
            sock,
            _serial: serial,
        };
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(15) {
            if UnixStream::connect(&s.sock).is_ok() {
                return Some(s);
            }
            if let Some(st) = s.child.as_mut().unwrap().try_wait().unwrap() {
                panic!("serve exited early ({st}): {}", s.stderr());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("serve socket never came up: {}", s.stderr());
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(self.root.join("stderr.log")).unwrap_or_default()
    }

    fn client(&self) -> Client {
        Client::connect(&self.sock)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
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
    /// Every event received so far, in order (never drained by the helpers below).
    events: Vec<Value>,
}

impl Client {
    fn connect(sock: &Path) -> Client {
        let w = UnixStream::connect(sock).expect("connect");
        w.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        let r = BufReader::new(w.try_clone().unwrap());
        Client {
            w,
            r,
            id: 0,
            events: Vec::new(),
        }
    }

    fn call(&mut self, cmd: &str, args: Value) -> Value {
        self.id += 1;
        let id = self.id;
        let line = json!({"id": id, "cmd": cmd, "args": args}).to_string();
        self.w.write_all(line.as_bytes()).unwrap();
        self.w.write_all(b"\n").unwrap();
        loop {
            let mut buf = String::new();
            let n = self.r.read_line(&mut buf).expect("read");
            assert!(n > 0, "server closed the connection during {cmd} {line}");
            let m: Value = serde_json::from_str(&buf).unwrap();
            if m.get("event").is_some() {
                self.events.push(m);
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
        let r = self.call("step", json!({ "ms": ms }));
        assert_eq!(r["ok"], json!(true), "step {ms} failed: {r}");
    }

    fn get(&mut self, path: &str) -> Value {
        self.ok("get", json!({ "path": path }))["value"].clone()
    }

    /// The events named `name` seen so far.
    fn named(&self, name: &str) -> Vec<Value> {
        self.events
            .iter()
            .filter(|e| e["event"] == name)
            .cloned()
            .collect()
    }
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

const RED_3S: ClipSpec = ClipSpec::Solid {
    rgb: [255, 0, 0],
    secs: 3.0,
    tone_hz: 440.0,
    tone_dbfs: -20.0,
};

/// A program with every settable prop given.
fn every_prop(clip: &str) -> Value {
    json!({
        "outputs": "out:*",
        "items": [{"path": clip, "props": {"gain.user": -3.0, "speed": 1.5}, "skip": false},
                  {"path": "/nope/b.mkv"}],
        "defaults": {"gain.user": -6.0, "no_audio": false},
        "order": "shuffle",
        "mode": "timer",
        "interval_ms": 4000.0,
        "max_ms": 9000.0,
        "separate_scenes": false,
        "scenes_after_ms": 6000.0,
        "transition": {"enabled": true, "effects": ["fade"], "shuffle": false,
                       "duration_ms": 500, "duration_max_ms": 700, "method": "reveal"},
        "seed": 42,
    })
}

// ---------------------------------------------------------------- Task 2: the node + verbs

#[test]
fn program_node_roundtrips() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let clip = ensure_clip("prog_red_3s", RED_3S);
    let props = every_prop(s(&clip));
    let r = c.ok(
        "create",
        json!({"kind": "program", "id": "prog:main", "props": props}),
    );
    assert_eq!(r["id"], "prog:main");
    for (k, v) in props.as_object().unwrap() {
        let got = c.get(&format!("prog:main.{k}"));
        match k.as_str() {
            // stored as given, defaults filled in
            "items" => {
                assert_eq!(got[0]["path"], v[0]["path"]);
                assert_eq!(got[0]["props"], v[0]["props"]);
                assert_eq!(got[1]["props"], json!({}));
                assert_eq!(got[1]["skip"], json!(false));
            }
            _ => assert_eq!(&got, v, "prog:main.{k}"),
        }
    }
    let st = c.ok("state", json!({}));
    assert_eq!(st["graph"]["prog:main"]["kind"], "program", "{st}");
    assert_eq!(st["programs"][0]["id"], "prog:main", "{st}");
    assert_eq!(st["programs"][0]["phase"], "idle", "{st}");
    assert_eq!(st["programs"][0]["items"], 2, "{st}");
    // observed defaults
    assert_eq!(c.get("prog:main.index"), json!(-1));
    assert_eq!(c.get("prog:main.phase"), json!("idle"));
    // an auto id; an id with a `.` is refused
    let r = c.ok("create", json!({"kind": "program", "props": {}}));
    assert_eq!(r["id"], "prog1");
    let e = c.err("create", json!({"kind": "program", "id": "prog:a.b"}));
    assert_eq!(e["code"], "bad_request", "{e}");
    // `outputs` is fixed after create; a default seed is minted
    let e = c.err(
        "set",
        json!({"path": "prog:main.outputs", "value": "out:VIRTUAL-1"}),
    );
    assert_eq!(e["code"], "read_only", "{e}");
    assert_ne!(c.get("prog1.seed"), json!(0));
    // live props go through the schema
    c.ok(
        "set",
        json!({"path": "prog:main.interval_ms", "value": 1000}),
    );
    assert_eq!(c.get("prog:main.interval_ms"), json!(1000.0));
    let e = c.err(
        "set",
        json!({"path": "prog:main.mode", "value": "sometimes"}),
    );
    assert_eq!(e["code"], "bad_type", "{e}");
    let e = c.err(
        "set",
        json!({"path": "prog:main.interval_ms", "value": 4e9}),
    );
    assert_eq!(e["code"], "out_of_range", "{e}");
    let e = c.err(
        "set",
        json!({"path": "prog:main.transition", "value": {"method": "slide"}}),
    );
    assert_eq!(e["code"], "out_of_range", "{e}");
    let e = c.err(
        "set",
        json!({"path": "prog:main.defaults", "value": {"nope": 1}}),
    );
    assert_eq!(e["code"], "no_such_prop", "{e}");
    // hello advertises it
    let h = c.ok("hello", json!({}));
    assert!(
        h["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("program")),
        "{h}"
    );
    let l = c.ok("logs", json!({"kind_prefix": "program.created"}));
    assert!(
        l["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == "prog:main"),
        "{l}"
    );
}

#[test]
fn items_are_validated() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok(
        "create",
        json!({"kind": "program", "id": "prog:main",
               "props": {"items": [{"path": "/a.mkv"}, {"path": "/b.mkv"}]}}),
    );
    let before = c.get("prog:main.items");
    let set =
        |c: &mut Client, v: Value| c.err("set", json!({"path": "prog:main.items", "value": v}));
    // a bad props key → no_such_prop naming the index
    let e = set(
        &mut c,
        json!([{"path": "/a.mkv"}, {"path": "/b.mkv", "props": {"nope": 1}}]),
    );
    assert_eq!(e["code"], "no_such_prop", "{e}");
    assert!(e["message"].as_str().unwrap().contains("items[1]"), "{e}");
    // a badly typed / out-of-range prop
    let e = set(
        &mut c,
        json!([{"path": "/a.mkv", "props": {"speed": "fast"}}]),
    );
    assert_eq!(e["code"], "bad_type", "{e}");
    assert!(e["message"].as_str().unwrap().contains("items[0]"), "{e}");
    let e = set(&mut c, json!([{"path": "/a.mkv", "props": {"speed": 99}}]));
    assert_eq!(e["code"], "out_of_range", "{e}");
    // an empty path, a non-object item, an unknown item key
    let e = set(&mut c, json!([{"path": "/a.mkv"}, {"path": ""}]));
    assert_eq!(e["code"], "bad_type", "{e}");
    assert!(e["message"].as_str().unwrap().contains("items[1]"), "{e}");
    let e = set(&mut c, json!(["/a.mkv"]));
    assert_eq!(e["code"], "bad_type", "{e}");
    let e = set(&mut c, json!([{"path": "/a.mkv", "skipp": true}]));
    assert_eq!(e["code"], "bad_type", "{e}");
    // 10 001 items
    let many: Vec<Value> = (0..10_001)
        .map(|i| json!({"path": format!("/m{i}.mkv")}))
        .collect();
    let e = set(&mut c, Value::Array(many));
    assert_eq!(e["code"], "out_of_range", "{e}");
    // nothing changed after any failure
    assert_eq!(c.get("prog:main.items"), before);
    // the same checks at create (nothing created)
    let e = c.err(
        "create",
        json!({"kind": "program", "id": "prog:x", "props": {"items": [{"path": ""}]}}),
    );
    assert_eq!(e["code"], "bad_type", "{e}");
    let e = c.err("get", json!({"path": "prog:x.items"}));
    assert_eq!(e["code"], "no_such_node", "{e}");
    // 10 000 is fine
    let many: Vec<Value> = (0..10_000)
        .map(|i| json!({"path": format!("/m{i}.mkv")}))
        .collect();
    c.ok("set", json!({"path": "prog:main.items", "value": many}));
    let st = c.ok("state", json!({}));
    assert_eq!(st["programs"][0]["items"], 10_000);
}

#[test]
fn observed_props_are_read_only() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("create", json!({"kind": "program", "id": "prog:main"}));
    for (k, v) in [
        ("index", json!(3)),
        ("phase", json!("playing")),
        ("path", json!("/a.mkv")),
        ("next_path", json!("/b.mkv")),
        ("played_ms", json!(1.0)),
        ("remaining_ms", json!(1.0)),
    ] {
        let e = c.err("set", json!({"path": format!("prog:main.{k}"), "value": v}));
        assert_eq!(e["code"], "read_only", "{k}: {e}");
    }
}

#[test]
fn verbs_on_missing_or_empty_program() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    for verb in [
        "program.play",
        "program.next",
        "program.prev",
        "program.random",
    ] {
        let e = c.err(verb, json!({"id": "prog:x"}));
        assert_eq!(e["code"], "no_such_node", "{verb}: {e}");
    }
    c.ok("create", json!({"kind": "program", "id": "prog:main"}));
    for verb in [
        "program.play",
        "program.next",
        "program.prev",
        "program.random",
    ] {
        let e = c.err(verb, json!({"id": "prog:main"}));
        assert_eq!(e["code"], "unsupported", "{verb}: {e}");
        assert!(
            e["hint"].as_str().unwrap().contains("probe"),
            "{verb}: the hint names the programs probe: {e}"
        );
    }
    // a non-program node
    let r = c.ok(
        "create",
        json!({"kind": "source", "props": {"kind": "color", "color": [1, 0, 0]}}),
    );
    let e = c.err("program.next", json!({"id": r["id"]}));
    assert_eq!(e["code"], "no_such_node", "{e}");
    // the probe answers
    let p = c.ok("probe", json!({"name": "programs"}));
    assert_eq!(p["programs"][0]["id"], "prog:main", "{p}");
}

#[test]
fn transition_events_carry_origin() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    c.ok("subscribe", json!({"topics": ["transition."]}));
    let r = c.ok(
        "create",
        json!({"kind": "source", "props": {"kind": "color", "color": [1, 0, 0]}}),
    );
    c.ok(
        "set",
        json!({"path": "lay:*:main.content", "value": r["id"]}),
    );
    c.step(16);
    // a client can't claim another origin
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"kind": "color", "color": [0, 0, 1]},
               "effect_id": null, "origin": "program:prog:main"}),
    );
    let corr = r["corr"].as_str().unwrap().to_string();
    c.step(16);
    let sched: Vec<Value> = c
        .named("transition.scheduled")
        .into_iter()
        .filter(|e| e["corr"] == corr)
        .collect();
    assert_eq!(sched.len(), 1, "{:?}", c.events);
    assert_eq!(sched[0]["origin"], "api", "{}", sched[0]);
}

#[test]
fn destroy_program_leaves_the_picture() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let r = c.ok(
        "create",
        json!({"kind": "source", "props": {"kind": "color", "color": [1, 0, 0]}}),
    );
    let src = r["id"].as_str().unwrap().to_string();
    c.ok("set", json!({"path": "lay:*:main.content", "value": src}));
    c.ok(
        "create",
        json!({"kind": "program", "id": "prog:main", "props": {"items": [{"path": "/a.mkv"}]}}),
    );
    c.step(16);
    c.ok("destroy", json!({"id": "prog:main"}));
    c.step(16);
    let st = c.ok("state", json!({}));
    assert!(st["graph"].get("prog:main").is_none(), "{st}");
    assert_eq!(st["programs"], json!([]), "{st}");
    assert_eq!(c.get("lay:VIRTUAL-1:main.content"), json!(src));
    assert_eq!(c.get("cur:VIRTUAL-1.kind"), json!("color"));
    let l = c.ok("logs", json!({"kind_prefix": "program.destroyed"}));
    assert_eq!(l["events"].as_array().unwrap().len(), 1, "{l}");
    let _ = srv.path("unused");
}

// ---------------------------------------------------------------- Task 3: the rotation engine

use liascape_player::scene::synthetic::{Pattern, SyntheticSpec};

const ORIGIN: &str = "program:prog:main";

/// A FrameIndex clip of `secs` (30 fps, no audio) under its own name (distinct paths).
fn clip(name: &str, secs: f64) -> String {
    let frames = (secs * 30.0).round() as u32;
    s(&ensure_clip(
        &format!("prog_{name}_{frames}f"),
        ClipSpec::FrameIndex { frames },
    ))
    .to_string()
}

fn png(name: &str, rgb: [u8; 3]) -> String {
    s(&common::solid_png(&format!("prog_{name}"), rgb)).to_string()
}

/// `prog:main` with `seed` 1, `transition` off unless given, subscribed to its events.
fn program(c: &mut Client, items: &[&str], props: Value) -> Vec<String> {
    c.ok(
        "subscribe",
        json!({"topics": ["program.", "transition.", "source."]}),
    );
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
    items.iter().map(|s| s.to_string()).collect()
}

/// Step `ms` at a time until `pred` holds over every event so far (≤ `max_ms` of player
/// time); panics with the events otherwise.
fn step_until(c: &mut Client, ms: u64, max_ms: u64, what: &str, pred: impl Fn(&[Value]) -> bool) {
    let mut t = 0;
    while !pred(&c.events) {
        assert!(
            t <= max_ms,
            "{what}: not within {max_ms} ms; events: {:#?}",
            c.events
                .iter()
                .filter(|e| e["event"]
                    .as_str()
                    .is_some_and(|k| k.starts_with("program.")
                        || k == "transition.scheduled"
                        || k == "transition.failed"
                        || k == "transition.cancelled"))
                .collect::<Vec<_>>()
        );
        c.step(ms);
        t += ms;
    }
}

/// Step `total` ms in `ms` steps.
fn step_for(c: &mut Client, ms: u64, total: u64) {
    let mut t = 0;
    while t < total {
        c.step(ms);
        t += ms;
    }
}

fn currents(c: &Client) -> Vec<Value> {
    c.named("program.current")
}

/// The program's own `transition.scheduled` events.
fn scheduled(c: &Client) -> Vec<Value> {
    c.named("transition.scheduled")
        .into_iter()
        .filter(|e| e["origin"] == ORIGIN)
        .collect()
}

fn ms_of(e: &Value) -> f64 {
    e["at_ms"]
        .as_f64()
        .unwrap_or_else(|| panic!("no at_ms: {e}"))
}

fn n_currents(n: usize) -> impl Fn(&[Value]) -> bool {
    move |evs: &[Value]| {
        evs.iter()
            .filter(|e| e["event"] == "program.current")
            .count()
            >= n
    }
}

fn close(got: f64, want: f64, tol: f64, what: &str) {
    assert!((got - want).abs() <= tol, "{what}: {got} vs {want} ± {tol}");
}

fn fade(ms: u32) -> Value {
    json!({"enabled": true, "effects": ["fade"], "duration_ms": ms, "method": "full-live"})
}

#[test]
fn timer_mode_switches_every_interval() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("ta", 4.0), clip("tb", 4.0), clip("tc", 4.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 3000, "transition": fade(500)}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 12_000, "4 currents", n_currents(4));
    let cur = currents(&c);
    let paths: Vec<&str> = cur.iter().map(|e| e["path"].as_str().unwrap()).collect();
    assert_eq!(paths, [items[0], items[1], items[2], items[0]]);
    assert_eq!(cur[0]["reason"], "play");
    for e in &cur[1..] {
        assert_eq!(e["reason"], "timer", "{e}");
    }
    let sch = scheduled(&c);
    assert_eq!(sch.len(), 4, "{sch:?}");
    for w in 1..4 {
        assert_eq!(sch[w]["align"], "now", "{}", sch[w]);
        assert_eq!(sch[w]["effect_id"], "fade", "{}", sch[w]);
        // the countdown restarts at each commit (B's effect start)
        close(
            ms_of(&sch[w]) - ms_of(&cur[w - 1]),
            3000.0,
            17.0,
            "request − previous commit",
        );
    }
    // a non-program transition says so
    assert!(
        c.named("transition.scheduled")
            .iter()
            .all(|e| e["origin"] == ORIGIN)
    );
    assert_eq!(c.get("prog:main.path"), json!(items[0]));
}

#[test]
fn timer_countdown_scales_with_speed() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [png("sp_a", [255, 0, 0]), png("sp_b", [0, 255, 0])];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 3000, "defaults": {"speed": 2.0}}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 4000, "2 currents", n_currents(2));
    let cur = currents(&c);
    let sch = scheduled(&c);
    close(
        ms_of(&sch[1]) - ms_of(&cur[0]),
        1500.0,
        17.0,
        "2× speed halves the interval",
    );
}

#[test]
fn timer_one_item_never_switches() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let a = png("one_a", [255, 0, 0]);
    program(&mut c, &[&a], json!({"mode": "timer", "interval_ms": 1000}));
    c.ok("program.play", json!({"id": "prog:main"}));
    step_for(&mut c, 100, 10_000);
    assert_eq!(scheduled(&c).len(), 1, "only the play: {:?}", scheduled(&c));
    assert_eq!(currents(&c).len(), 1);
    assert!(c.get("prog:main.remaining_ms").as_f64().unwrap() <= 1000.0);
}

#[test]
fn on_end_switches_at_each_end_aligned() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("ea", 2.0), clip("eb", 2.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "transition": fade(500)}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 12_000, "5 currents", n_currents(5));
    let cur = currents(&c);
    let sch = scheduled(&c);
    for w in 1..5 {
        assert_eq!(cur[w]["reason"], "end", "{}", cur[w]);
        assert_eq!(cur[w]["path"], items[w % 2], "{}", cur[w]);
        assert_eq!(sch[w]["align"], "end", "{}", sch[w]);
        // armed after the previous effect handed off, long before A's end
        assert!(
            ms_of(&sch[w]) < ms_of(&cur[w - 1]) + 1000.0,
            "{} vs {}",
            sch[w],
            cur[w - 1]
        );
        // full-live ends at A's end: B's effect starts 500 ms before it (2 s clips)
        close(
            ms_of(&cur[w]) - ms_of(&cur[w - 1]),
            1500.0,
            50.0,
            "commit spacing",
        );
    }
    assert!(c.named("transition.failed").is_empty());
}

#[test]
fn min_hold_loops_short_clip_to_the_reaching_loop_end() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("ha", 2.0), clip("hb", 2.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "interval_ms": 5000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    let t0 = ms_of(&currents(&c)[0]);
    step_for(&mut c, 16, 300);
    let st = c.ok("state", json!({}));
    assert_eq!(st["programs"][0]["phase"], "holding", "{st}");
    assert_eq!(
        c.get("cur:VIRTUAL-1.loop"),
        json!(true),
        "A loops while held"
    );
    step_until(&mut c, 16, 8000, "the switch", n_currents(2));
    let sch = scheduled(&c);
    assert_eq!(sch.len(), 2, "{sch:?}");
    assert_eq!(sch[1]["align"], "end");
    assert!(
        ms_of(&sch[1]) - t0 >= 4000.0 - 150.0 - 17.0,
        "requested in the 3rd loop: {}",
        sch[1]
    );
    let cur = currents(&c);
    close(
        ms_of(&cur[1]) - t0,
        6000.0,
        60.0,
        "handoff at the 3rd loop's end",
    );
}

#[test]
fn max_cuts_mid_video_now() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("ma", 10.0), clip("mb", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "max_ms": 3000, "transition": fade(500)}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 6000, "the max switch", n_currents(2));
    let cur = currents(&c);
    let sch = scheduled(&c);
    assert_eq!(cur[1]["reason"], "max", "{}", cur[1]);
    assert_eq!(cur[1]["path"], items[1]);
    let armed = &sch[1];
    assert_eq!(armed["align"], "end", "{armed}");
    let now = &sch[2];
    assert_eq!(now["align"], "now", "{now}");
    assert_eq!(now["effect_id"], "fade", "{now}");
    assert_eq!(now["path"], armed["path"], "the armed B's path is taken");
    close(ms_of(now) - ms_of(&cur[0]), 3000.0, 17.0, "at played 3000");
    let cancelled: Vec<Value> = c
        .named("transition.cancelled")
        .into_iter()
        .filter(|e| e["corr"] == armed["corr"])
        .collect();
    assert_eq!(cancelled.len(), 1, "{cancelled:?}");
    assert_eq!(cancelled[0]["reason"], "superseded");
}

#[test]
fn max_beats_min() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("mma", 10.0), clip("mmb", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "interval_ms": 8000, "max_ms": 3000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 6000, "the max switch", n_currents(2));
    let cur = currents(&c);
    assert_eq!(cur[1]["reason"], "max");
    let sch = scheduled(&c);
    // the 10 s clip reaches the 8 s minimum in its first loop: its end is armed at once…
    assert_eq!(sch[1]["align"], "end", "{sch:?}");
    // …and the cap still cuts it at 3 s, taking the armed B
    assert_eq!(sch[2]["align"], "now", "{sch:?}");
    assert_eq!(sch[2]["path"], sch[1]["path"]);
    close(
        ms_of(&sch[2]) - ms_of(&cur[0]),
        3000.0,
        17.0,
        "at played 3000",
    );
}

#[test]
fn zero_means_off_for_both() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("za", 4.0), clip("zb", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "interval_ms": 0, "max_ms": 0}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 33, 16_000, "a → b → a", n_currents(3));
    let cur = currents(&c);
    close(
        ms_of(&cur[1]) - ms_of(&cur[0]),
        4000.0,
        60.0,
        "a to its end",
    );
    close(
        ms_of(&cur[2]) - ms_of(&cur[1]),
        10_000.0,
        60.0,
        "b to its end",
    );
    assert!(
        scheduled(&c)[1..].iter().all(|e| e["align"] == "end"),
        "{:?}",
        scheduled(&c)
    );
}

fn synth_scene(name: &str, rgb: [u8; 3]) -> String {
    let spec = SyntheticSpec {
        pattern: Pattern::Solid,
        rgb,
        ..SyntheticSpec::default()
    };
    s(&common::synthetic_scene(name, &spec)).to_string()
}

fn scene_program(c: &mut Client, items: &[(&str, bool)], props: Value) {
    c.ok(
        "subscribe",
        json!({"topics": ["program.", "transition.", "source."]}),
    );
    let mut p = json!({
        "items": items.iter().map(|(i, scene)| if *scene {
            json!({"path": i, "props": {"kind": "scene"}})
        } else {
            json!({"path": i})
        }).collect::<Vec<_>>(),
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

fn scene_serve() -> Option<Serve> {
    Serve::start_env(&[("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES", "1")])
}

#[test]
fn scene_switches_after_scenes_after() {
    let Some(srv) = scene_serve() else { return };
    let mut c = srv.client();
    let sc = synth_scene("prog-sa-900000101", [255, 0, 0]);
    let v = clip("sa_v", 4.0);
    scene_program(
        &mut c,
        &[(&sc, true), (&v, false)],
        json!({"mode": "on_end", "interval_ms": 3000, "separate_scenes": true,
               "scenes_after_ms": 3000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 6000, "scene → video", n_currents(2));
    let cur = currents(&c);
    assert_eq!(cur[1]["reason"], "scenes_after", "{}", cur[1]);
    let sch = scheduled(&c);
    assert_eq!(sch[1]["align"], "now");
    close(
        ms_of(&sch[1]) - ms_of(&cur[0]),
        3000.0,
        17.0,
        "the scene at 3000",
    );
    // the video ignores "scenes after" and its 3 s minimum is under its 4 s: its end
    step_until(&mut c, 16, 8000, "video → scene", n_currents(3));
    let cur = currents(&c);
    assert_eq!(cur[2]["reason"], "end", "{}", cur[2]);
    close(
        ms_of(&cur[2]) - ms_of(&cur[1]),
        4000.0,
        60.0,
        "the video to its end",
    );
}

#[test]
fn separate_off_scene_follows_min_then_max() {
    let Some(srv) = scene_serve() else { return };
    let mut c = srv.client();
    let a = synth_scene("prog-so-900000102", [255, 0, 0]);
    let b = synth_scene("prog-so-900000103", [0, 0, 255]);
    scene_program(
        &mut c,
        &[(&a, true), (&b, true)],
        json!({"mode": "on_end", "interval_ms": 3000, "separate_scenes": false}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 6000, "min", n_currents(2));
    let cur = currents(&c);
    assert_eq!(cur[1]["reason"], "end", "{}", cur[1]);
    close(
        ms_of(&cur[1]) - ms_of(&cur[0]),
        3000.0,
        60.0,
        "a scene's minimum is its end",
    );
    // min 0 + max 2000 → at 2000
    c.ok("set", json!({"path": "prog:main.interval_ms", "value": 0}));
    c.ok("set", json!({"path": "prog:main.max_ms", "value": 2000}));
    step_until(&mut c, 16, 4000, "max", n_currents(3));
    let cur = currents(&c);
    assert_eq!(cur[2]["reason"], "max", "{}", cur[2]);
    close(ms_of(&cur[2]) - ms_of(&cur[1]), 2000.0, 60.0, "the maximum");
    // both 0 → no switch in 8 s
    c.ok("set", json!({"path": "prog:main.max_ms", "value": 0}));
    step_for(&mut c, 50, 8000);
    assert_eq!(currents(&c).len(), 3);
}

#[test]
fn image_follows_scene_rule_with_toggle_on() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [png("is_a", [255, 0, 0]), png("is_b", [0, 255, 0])];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "interval_ms": 0, "separate_scenes": true,
               "scenes_after_ms": 3000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 5000, "after 3000", n_currents(2));
    let cur = currents(&c);
    assert_eq!(cur[1]["reason"], "scenes_after");
    close(
        ms_of(&cur[1]) - ms_of(&cur[0]),
        3000.0,
        60.0,
        "the image's 3 s",
    );
}

#[test]
fn image_min_with_toggle_off() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [png("im_a", [255, 0, 0]), png("im_b", [0, 255, 0])];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "interval_ms": 0, "separate_scenes": false}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    let t0 = ms_of(&currents(&c)[0]);
    step_until(&mut c, 16, 2000, "the next request", |evs| {
        evs.iter()
            .filter(|e| e["event"] == "transition.scheduled" && e["origin"] == ORIGIN)
            .count()
            >= 2
    });
    // minimum 0: the image moves on within one tick of its commit
    assert!(ms_of(&scheduled(&c)[1]) - t0 <= 17.0, "{:?}", scheduled(&c));
}

#[test]
fn b_commits_at_effect_start() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [png("bc_a", [255, 0, 0]), png("bc_b", [0, 255, 0])];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 1000, "transition": fade(1000)}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 4000, "the switch", n_currents(2));
    let cur = currents(&c)[1].clone();
    let started: Vec<Value> = c
        .named("transition.started")
        .into_iter()
        .filter(|e| e["corr"] == cur["corr"])
        .collect();
    assert_eq!(started.len(), 1, "{:?}", c.named("transition.started"));
    assert_eq!(ms_of(&started[0]), ms_of(&cur), "the same instant");
    assert!(
        c.named("transition.handoff")
            .iter()
            .all(|e| e["corr"] != cur["corr"]),
        "before the handoff"
    );
    assert_eq!(
        c.get("prog:main.path"),
        json!(items[1]),
        "B during the effect"
    );
    assert_eq!(c.get("prog:main.played_ms"), json!(0.0));
}

#[test]
fn transition_off_on_end_is_a_gapless_cut_at_a_end() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("ga", 2.0), clip("gb", 2.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "transition": {"enabled": false}}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 4000, "the switch", n_currents(2));
    let sch = scheduled(&c);
    assert_eq!(sch[1]["effect_id"], Value::Null, "{}", sch[1]);
    assert_eq!(sch[1]["align"], "end", "{}", sch[1]);
    let cur = currents(&c);
    close(ms_of(&cur[1]) - ms_of(&cur[0]), 2000.0, 40.0, "at A's end");
}

#[test]
fn effect_pick_reaches_the_request() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [png("ep_a", [255, 0, 0]), png("ep_b", [0, 255, 0])];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 1000,
               "transition": {"enabled": true, "effects": ["fade", "wipeLeft"],
                              "duration_ms": 400, "duration_max_ms": 600}}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 6000, "4 currents", n_currents(4));
    let sch = scheduled(&c);
    let effects: Vec<&str> = sch[..3]
        .iter()
        .map(|e| e["effect_id"].as_str().unwrap())
        .collect();
    assert_eq!(effects, ["fade", "wipeLeft", "fade"]);
    for e in &sch {
        let d = e["duration_ms"].as_u64().unwrap();
        assert!((400..=600).contains(&d), "{e}");
    }
    // the catalogue's default params reach the transition (its effect node)
    let defaults = c.ok("effects", json!({}));
    assert!(
        defaults["ids"]
            .as_array()
            .unwrap()
            .contains(&json!("wipeLeft"))
    );
}

#[test]
fn failed_item_backs_off_and_skips() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let bad1 = srv.path("garbage1.mp4");
    let bad2 = srv.path("garbage2.mp4");
    std::fs::write(&bad1, b"not a video at all").unwrap();
    std::fs::write(&bad2, b"not a video either").unwrap();
    let a = png("fl_a", [255, 0, 0]);
    let d = png("fl_d", [0, 0, 255]);
    let items = [a.as_str(), s(&bad1), s(&bad2), d.as_str()];
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 1000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 50, 20_000, "d", n_currents(2));
    let failed = c.named("program.failed");
    assert_eq!(failed.len(), 2, "{failed:?}");
    assert_eq!(failed[0]["path"], items[1]);
    assert_eq!(failed[0]["backoff_ms"], 1000);
    assert_eq!(failed[1]["path"], items[2]);
    assert_eq!(failed[1]["backoff_ms"], 2000, "a second failure in a row");
    let cur = currents(&c);
    assert_eq!(cur[1]["path"], items[3]);
    assert_eq!(cur[1]["reason"], "failed_skip");
    // a handoff resets the ladder; the failed items are passed over
    step_until(&mut c, 50, 5000, "a again", n_currents(3));
    let cur = currents(&c);
    assert_eq!(cur[2]["path"], items[0], "{cur:?}");
    let st = c.ok("state", json!({}));
    assert_eq!(st["programs"][0]["failures"], 0, "{st}");
    let p = c.ok("probe", json!({"name": "programs"}));
    assert_eq!(p["programs"][0]["item_flags"][1]["failed"], true, "{p}");
}

#[test]
fn all_items_unplayable_stops_without_spinning() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let col = c.ok(
        "create",
        json!({"kind": "source", "props": {"kind": "color", "color": [0, 1, 0]}}),
    );
    c.ok(
        "set",
        json!({"path": "lay:*:main.content", "value": col["id"]}),
    );
    c.step(16);
    let bad: Vec<String> = (0..3)
        .map(|i| {
            let p = srv.path(&format!("junk{i}.mp4"));
            std::fs::write(&p, format!("junk {i}")).unwrap();
            s(&p).to_string()
        })
        .collect();
    let items: Vec<&str> = bad.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 1000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_for(&mut c, 100, 60_000);
    let sch = scheduled(&c);
    assert!(sch.len() <= 6, "{} requests in 60 s: {sch:?}", sch.len());
    assert_eq!(
        c.named("program.empty").len(),
        1,
        "{:?}",
        c.named("program.empty")
    );
    assert_eq!(
        c.get("cur:VIRTUAL-1.kind"),
        json!("color"),
        "what was shown stays"
    );
}

#[test]
fn skip_flag_is_respected() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [
        png("sk_a", [255, 0, 0]),
        png("sk_b", [0, 255, 0]),
        png("sk_c", [0, 0, 255]),
    ];
    c.ok("subscribe", json!({"topics": ["program.", "transition."]}));
    c.ok(
        "create",
        json!({"kind": "program", "id": "prog:main", "props": {
            "items": [{"path": items[0]}, {"path": items[1], "skip": true}, {"path": items[2]}],
            "mode": "timer", "interval_ms": 500, "seed": 1}}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 5000, "5 currents", n_currents(5));
    assert!(
        currents(&c).iter().all(|e| e["path"] != items[1]),
        "{:?}",
        currents(&c)
    );
}

#[test]
fn broken_scene_advances_now() {
    let Some(srv) = scene_serve() else { return };
    let mut c = srv.client();
    let spec = SyntheticSpec {
        pattern: Pattern::Solid,
        crash_after_ms: Some(50),
        ..SyntheticSpec::default()
    };
    let bad = s(&common::synthetic_scene("prog-broken-900000104", &spec)).to_string();
    let a = png("br_a", [0, 255, 0]);
    let b = png("br_b", [0, 0, 255]);
    scene_program(
        &mut c,
        &[(&bad, true), (&a, false), (&b, false)],
        json!({"mode": "timer", "interval_ms": 3000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    let t = Instant::now();
    while !currents(&c).iter().any(|e| e["reason"] == "broken") {
        assert!(
            t.elapsed() < Duration::from_secs(30),
            "no broken advance: {:?}",
            c.events
        );
        // a crashing scene's frame may never come: a step timeout is no failure here
        let _ = c.call("step", json!({"ms": 16}));
        std::thread::sleep(Duration::from_millis(10));
    }
    let cur = currents(&c);
    let br = cur.iter().find(|e| e["reason"] == "broken").unwrap();
    assert_eq!(br["path"], json!(a));
    let st = c.ok("state", json!({}));
    assert_eq!(st["programs"][0]["broken"], json!([bad]), "{st}");
    // passed over on the next cycle
    step_until(&mut c, 50, 10_000, "a cycle", n_currents(cur.len() + 2));
    assert!(currents(&c).iter().skip(1).all(|e| e["path"] != json!(bad)));
}

#[test]
fn countdown_survives_player_pause() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [png("pp_a", [255, 0, 0]), png("pp_b", [0, 255, 0])];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 2000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    step_until(&mut c, 16, 1000, "the play", n_currents(1));
    step_for(&mut c, 16, 500);
    c.ok("set", json!({"path": "player.paused", "value": true}));
    c.step(16);
    let r0 = c.get("prog:main.remaining_ms").as_f64().unwrap();
    step_for(&mut c, 100, 5000);
    assert_eq!(currents(&c).len(), 1, "no switch while paused");
    close(
        c.get("prog:main.remaining_ms").as_f64().unwrap(),
        r0,
        1.0,
        "the countdown stops",
    );
    c.ok("set", json!({"path": "player.paused", "value": false}));
    step_until(&mut c, 16, 3000, "the switch", n_currents(2));
}

#[test]
fn every_switch_combo() {
    let Some(srv) = scene_serve() else { return };
    let mut c = srv.client();
    let v1 = clip("cv1", 10.0);
    let v2 = clip("cv2", 10.0);
    let s1 = synth_scene("prog-combo-900000105", [255, 0, 0]);
    let s2 = synth_scene("prog-combo-900000106", [0, 0, 255]);
    // V→V, V→S, S→S, S→V in one cycle
    for method in ["full-live", "reveal", "frozen"] {
        if c.ok("state", json!({}))["programs"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
        {
            c.ok("destroy", json!({"id": "prog:main"}));
        }
        c.events.clear();
        scene_program(
            &mut c,
            &[(&v1, false), (&v2, false), (&s1, true), (&s2, true)],
            json!({"mode": "timer", "interval_ms": 2000,
                   "transition": {"enabled": true, "effects": ["fade"], "duration_ms": 300,
                                  "method": method}}),
        );
        c.ok("program.play", json!({"id": "prog:main"}));
        let mut t = 0;
        while currents(&c).len() < 5 {
            assert!(t < 15_000, "{method}: {:?}", currents(&c));
            c.step(33);
            t += 33;
            let p = c.ok("probe", json!({"name": "sources"}));
            let live = p["sources"]
                .as_array()
                .unwrap()
                .iter()
                // what plays: a live video or scene, not a still snapshot, not a grave
                // ramped to silence and waiting to be destroyed
                .filter(|s| {
                    s["effective_paused"] == json!(false)
                        && matches!(s["kind"].as_str(), Some("video" | "scene"))
                        && s["gains"]["anticlick"].as_f64().unwrap_or(0.0) > -90.0
                })
                .count();
            assert!(live <= 2, "{method}: {live} unpaused sources: {p}");
        }
        let n = c.named("transition.handoff").len();
        assert!(n >= 4, "{method}: every switch handed off ({n})");
        assert!(c.named("transition.failed").is_empty(), "{method}");
    }
}

/// The fake VRAM sampler's next reading (`tests/api.rs`' `write_vram`): an 8 GiB card with
/// `free` MiB free, `procs` = (pid, MiB); written via a rename.
fn write_vram(file: &Path, free: f64, procs: &[(u64, f64)]) {
    let m: serde_json::Map<String, Value> = procs
        .iter()
        .map(|(p, v)| (p.to_string(), json!(v)))
        .collect();
    let tmp = file.with_extension("tmp");
    std::fs::write(
        &tmp,
        json!({"total_mib": 8192, "free_mib": free, "procs": m}).to_string(),
    )
    .unwrap();
    std::fs::rename(&tmp, file).unwrap();
}

/// Real clock: poll (`state` pumps the events) until `pred`, ≤ `limit`.
fn wait_real(
    c: &mut Client,
    limit: Duration,
    what: &str,
    mut pred: impl FnMut(&mut Client) -> bool,
) {
    let t = Instant::now();
    while !pred(c) {
        assert!(
            t.elapsed() < limit,
            "{what}: not within {limit:?}: {:?}",
            c.named("program.current")
        );
        std::thread::sleep(Duration::from_millis(50));
        c.ok("state", json!({}));
    }
}

#[test]
fn vram_stopped_scene_advances_without_broken_flag() {
    let file =
        std::env::temp_dir().join(format!("liascape-program-vram-{}.json", std::process::id()));
    write_vram(&file, 6000.0, &[]);
    let probe = format!("fake:{}", file.display());
    let Some(srv) = Serve::start_clock(
        &[
            ("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES", "1"),
            ("LIASCAPE_PLAYER_VRAM_PROBE", &probe),
            ("LIASCAPE_PLAYER_VRAM_TIMING", "50,300,600,200,1000"),
        ],
        "real",
    ) else {
        return;
    };
    let mut c = srv.client();
    c.ok(
        "set",
        json!({"path": "player.scene_vram_limit_mib", "value": 1536}),
    );
    let sc = synth_scene("prog-vram-900000107", [10, 200, 30]);
    let a = png("vr_a", [255, 0, 0]);
    let b = png("vr_b", [0, 0, 255]);
    scene_program(
        &mut c,
        &[(&sc, true), (&a, false), (&b, false)],
        json!({"mode": "timer", "interval_ms": 60000}),
    );
    c.ok("program.play", json!({"id": "prog:main"}));
    let mut pid = 0;
    wait_real(&mut c, Duration::from_secs(10), "the scene's worker", |c| {
        let w = c.ok("probe", json!({"name": "workers"}));
        pid = w["workers"][0]["pid"].as_u64().unwrap_or(0);
        pid != 0
    });
    write_vram(&file, 6000.0, &[(pid, 1800.0)]);
    wait_real(&mut c, Duration::from_secs(8), "the vram advance", |c| {
        c.named("program.current")
            .iter()
            .any(|e| e["reason"] == "vram")
    });
    let cur = c.named("program.current");
    let v = cur.iter().find(|e| e["reason"] == "vram").unwrap();
    assert_eq!(v["path"], json!(a), "{v}");
    let st = c.ok("state", json!({}));
    assert_eq!(
        st["programs"][0]["broken"],
        json!([]),
        "a VRAM stop is not broken: {st}"
    );
    let p = c.ok("probe", json!({"name": "programs"}));
    assert_eq!(p["programs"][0]["item_flags"][0]["broken"], false, "{p}");
    let _ = std::fs::remove_file(&file);
}

// ---------------------------------------------------------------- Task 4: user switches, live edits

/// `state.programs[0]`.
fn prog(c: &mut Client) -> Value {
    c.ok("state", json!({}))["programs"][0].clone()
}

/// `program.<verb>` on `prog:main` (+ `extra` args) → its reply.
fn verb(c: &mut Client, verb: &str, extra: Value) -> Value {
    let mut a = json!({"id": "prog:main"});
    for (k, v) in extra.as_object().unwrap() {
        a[k] = v.clone();
    }
    c.ok(&format!("program.{verb}"), a)
}

/// `n` distinct solid PNGs named `<tag><i>`.
fn pngs(tag: &str, n: usize) -> Vec<String> {
    (0..n)
        .map(|i| png(&format!("{tag}{i}"), [(i * 20) as u8, 255 - (i * 20) as u8, 60]))
        .collect()
}

/// Step until a `program.armed` count reaches `n`, return the program's state then.
fn wait_armed(c: &mut Client, n: usize) -> Value {
    step_until(c, 16, 4000, "armed", |evs| {
        evs.iter().filter(|e| e["event"] == "program.armed").count() >= n
    });
    c.step(16);
    let p = prog(c);
    assert_eq!(p["phase"], "armed", "{p}");
    p
}

#[test]
fn next_prev_random_follow_the_history_contract() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("hc", 5);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    // the timer at 0 never switches by itself: only the verbs move it
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 0}));
    let mut n = 0;
    let mut go = |c: &mut Client, v: &str| -> Value {
        let r = verb(c, v, json!({}));
        if !r["corr"].is_null() {
            n += 1;
            step_until(c, 16, 2000, v, n_currents(n));
        }
        r
    };
    go(&mut c, "play");
    go(&mut c, "next");
    go(&mut c, "next");
    go(&mut c, "prev");
    go(&mut c, "prev");
    let none = go(&mut c, "prev");
    assert_eq!(none["corr"], Value::Null, "previous at the session's first item");
    assert_eq!(none["path"], Value::Null);
    go(&mut c, "next");
    go(&mut c, "next");
    go(&mut c, "next");
    let cur = currents(&c);
    let paths: Vec<&str> = cur.iter().map(|e| e["path"].as_str().unwrap()).collect();
    let i = |k: usize| items[k];
    assert_eq!(paths, [i(0), i(1), i(2), i(1), i(0), i(1), i(2), i(3)]);
    let reasons: Vec<&str> = cur.iter().map(|e| e["reason"].as_str().unwrap()).collect();
    assert_eq!(
        reasons,
        ["play", "next", "next", "prev", "prev", "next", "next", "next"]
    );
    // a, b, c, back → b; random → x ≠ b; history [a, b, x]; next follows x's order place
    go(&mut c, "prev");
    go(&mut c, "prev");
    let p = prog(&mut c);
    assert_eq!(p["path"], json!(i(1)), "{p}");
    let r = go(&mut c, "random");
    let x = r["path"].as_str().unwrap().to_string();
    assert_ne!(x, i(1));
    assert_eq!(currents(&c).last().unwrap()["reason"], "random");
    let p = prog(&mut c);
    assert_eq!(p["history"], json!([i(0), i(1), &x]), "{p}");
    let at = items.iter().position(|p| *p == x).unwrap();
    let r = go(&mut c, "next");
    assert_eq!(r["path"], json!(items[(at + 1) % items.len()]));
}

#[test]
fn prev_at_session_start_does_nothing() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("ps_a", 4.0), clip("ps_b", 4.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "on_end"}));
    verb(&mut c, "play", json!({}));
    let before = wait_armed(&mut c, 1);
    let r = verb(&mut c, "prev", json!({}));
    assert_eq!(r["corr"], Value::Null, "{r}");
    c.step(16);
    let after = prog(&mut c);
    assert_eq!(after["corr"], before["corr"], "the armed switch is left alone");
    assert_eq!(after["phase"], "armed");
    assert!(c.named("transition.cancelled").is_empty());
}

#[test]
fn next_during_armed_wait_takes_the_armed_b() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("na_a", 6.0), clip("na_b", 6.0), clip("na_c", 6.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "on_end", "order": "shuffle"}));
    verb(&mut c, "play", json!({}));
    let armed = wait_armed(&mut c, 1);
    let r = verb(&mut c, "next", json!({}));
    assert_eq!(r["path"], armed["next"], "{r} vs {armed}");
    step_until(&mut c, 16, 2000, "the next", n_currents(2));
    let cur = currents(&c);
    assert_eq!(cur[1]["reason"], "next");
    assert_eq!(cur[1]["path"], armed["next"]);
    let cancelled: Vec<Value> = c
        .named("transition.cancelled")
        .into_iter()
        .filter(|e| e["corr"] == armed["corr"])
        .collect();
    assert_eq!(cancelled.len(), 1, "{cancelled:?}");
    assert_eq!(cancelled[0]["reason"], "superseded");
}

#[test]
fn next_during_running_effect_goes_past_b() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("nr", 4);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 0, "transition": fade(2000)}),
    );
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 4000, "the play's handoff", |evs| {
        evs.iter().any(|e| e["event"] == "transition.handoff")
    });
    let b = verb(&mut c, "next", json!({}));
    assert_eq!(b["path"], json!(items[1]));
    step_until(&mut c, 16, 2000, "B started", n_currents(2));
    step_for(&mut c, 16, 400);
    assert!(
        c.named("transition.handoff")
            .iter()
            .all(|e| e["corr"] != b["corr"]),
        "B's effect still runs"
    );
    let r = verb(&mut c, "next", json!({}));
    assert_eq!(r["path"], json!(items[2]), "the item after B: {r}");
    step_until(&mut c, 16, 2000, "the next", n_currents(3));
    let h: Vec<Value> = c
        .named("transition.handoff")
        .into_iter()
        .filter(|e| e["corr"] == b["corr"])
        .collect();
    assert_eq!(h.len(), 1, "B committed early");
    assert_eq!(h[0]["committed"], json!(true), "{}", h[0]);
    let cur = currents(&c);
    assert_eq!(cur[2]["from"], json!(items[1]));
}

/// Sources playing now (not paused, not ramped to silence) and how many sources exist.
fn live_sources(c: &mut Client) -> (usize, Vec<String>) {
    let p = c.ok("probe", json!({"name": "sources"}));
    let srcs = p["sources"].as_array().unwrap();
    let live = srcs
        .iter()
        .filter(|s| {
            s["effective_paused"] == json!(false)
                && s["gains"]["anticlick"].as_f64().unwrap_or(0.0) > -90.0
        })
        .count();
    let paths = srcs
        .iter()
        .map(|s| s["path"].as_str().unwrap_or("").to_string())
        .collect();
    (live, paths)
}

#[test]
fn next_storm_lands_on_the_last() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("ns", 12);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 0, "transition": fade(300)}),
    );
    verb(&mut c, "play", json!({"index": 3}));
    step_until(&mut c, 16, 2000, "the play's handoff", |evs| {
        evs.iter().any(|e| e["event"] == "transition.handoff")
    });
    // 10 nexts within 3 steps (each a separate request, as from 10 CLI processes)
    let mut last = Value::Null;
    for burst in [4, 3, 3] {
        for _ in 0..burst {
            last = verb(&mut c, "next", json!({}));
        }
        c.step(16);
        let (live, _) = live_sources(&mut c);
        assert!(live <= 2, "{live} playing sources mid-storm");
    }
    let want = items[(3 + 10) % 12];
    assert_eq!(last["path"], json!(want), "{last}");
    step_until(&mut c, 16, 3000, "the last one's handoff", |evs| {
        evs.iter()
            .any(|e| e["event"] == "transition.handoff" && e["corr"] == last["corr"])
    });
    c.step(16);
    c.step(16);
    let (live, paths) = live_sources(&mut c);
    assert!(live <= 1, "{live}");
    assert!(
        paths.iter().all(|p| p == want),
        "every superseded B gone: {paths:?}"
    );
    assert_eq!(prog(&mut c)["path"], json!(want));
}

#[test]
fn keep_pause_next_is_a_cut_paused() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("kp_a", 6.0), clip("kp_b", 6.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 5000, "transition": fade(500)}),
    );
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 16, 600);
    c.ok("set", json!({"path": "player.paused", "value": true}));
    c.step(16);
    let r = verb(&mut c, "next", json!({"keep_pause": true}));
    step_until(&mut c, 16, 3000, "the next", n_currents(2));
    let sch = scheduled(&c);
    let req = sch.iter().find(|e| e["corr"] == r["corr"]).unwrap();
    assert_eq!(req["effect_id"], Value::Null, "a cut: {req}");
    c.step(16);
    let b = currents(&c)[1]["source"].as_str().unwrap().to_string();
    let p = c.ok("probe", json!({"name": "sources"}));
    let bs = p["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == b)
        .cloned()
        .unwrap();
    assert_eq!(bs["effective_paused"], json!(true), "{bs}");
    let r0 = c.get("prog:main.remaining_ms").as_f64().unwrap();
    step_for(&mut c, 100, 2000);
    close(
        c.get("prog:main.remaining_ms").as_f64().unwrap(),
        r0,
        1.0,
        "the rotation clock stays frozen",
    );
}

#[test]
fn one_item_next_and_random_switch_to_itself() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let a = png("oi_a", [200, 10, 10]);
    program(
        &mut c,
        &[&a],
        json!({"mode": "on_end", "transition": fade(300)}),
    );
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 16, 500);
    for (k, v) in ["next", "random"].iter().enumerate() {
        let r = verb(&mut c, v, json!({}));
        assert_eq!(r["path"], json!(a), "{v}: {r}");
        step_until(&mut c, 16, 2000, v, n_currents(k + 2));
        step_for(&mut c, 16, 500);
        let cur = currents(&c);
        assert_eq!(cur[k + 1]["reason"], *v);
        assert_ne!(cur[k + 1]["source"], cur[k]["source"], "a new source");
        let req = scheduled(&c)
            .into_iter()
            .find(|e| e["corr"] == r["corr"])
            .unwrap();
        assert_eq!(req["effect_id"], "fade", "with its transition: {req}");
    }
}

#[test]
fn live_interval_change_keeps_proportional_remaining() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("li", 2);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 10000}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 100, 6000);
    let r = c.get("prog:main.remaining_ms").as_f64().unwrap();
    close(r, 4000.0, 120.0, "6 s in");
    c.ok("set", json!({"path": "prog:main.interval_ms", "value": 20000}));
    let r2 = c.get("prog:main.remaining_ms").as_f64().unwrap();
    close(r2, r + 10000.0, 1.0, "elapsed < new → new − elapsed");
    c.ok("set", json!({"path": "prog:main.interval_ms", "value": 5000}));
    let r3 = c.get("prog:main.remaining_ms").as_f64().unwrap();
    close(r3, 5000.0, 1.0, "elapsed ≥ new → a full new interval");
    assert_eq!(currents(&c).len(), 1);
}

#[test]
fn live_min_change_rearms_same_b() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("lm_a", 10.0), clip("lm_b", 10.0), clip("lm_c", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "on_end", "order": "shuffle"}));
    verb(&mut c, "play", json!({}));
    let armed = wait_armed(&mut c, 1);
    step_for(&mut c, 16, 500);
    let played = c.get("prog:main.played_ms").as_f64().unwrap();
    c.ok("set", json!({"path": "prog:main.interval_ms", "value": 3000}));
    let re = wait_armed(&mut c, 2);
    assert_ne!(re["corr"], armed["corr"], "a new request");
    assert_eq!(re["next"], armed["next"], "the same B");
    assert!(re["played_ms"].as_f64().unwrap() >= played, "{re}");
    let cancelled = c.named("transition.cancelled");
    assert!(
        cancelled.iter().any(|e| e["corr"] == armed["corr"]),
        "{cancelled:?}"
    );
    assert_eq!(currents(&c).len(), 1, "no switch");
}

#[test]
fn live_max_change_applies_next_tick() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("lx_a", 10.0), clip("lx_b", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "on_end"}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 50, 5000);
    let n = scheduled(&c).len();
    c.ok("set", json!({"path": "prog:main.max_ms", "value": 4000}));
    c.step(16);
    let sch = scheduled(&c);
    assert_eq!(sch.len(), n + 1, "{sch:?}");
    assert_eq!(sch[n]["align"], "now");
    step_until(&mut c, 16, 2000, "the max switch", n_currents(2));
    assert_eq!(currents(&c)[1]["reason"], "max");
}

#[test]
fn live_mode_toggle_keeps_played_time() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("lt_a", 10.0), clip("lt_b", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 60000}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 100, 2000);
    let p0 = c.get("prog:main.played_ms").as_f64().unwrap();
    // timer → on_end: the 60 s minimum holds the 10 s clip
    c.ok("set", json!({"path": "prog:main.mode", "value": "on_end"}));
    step_for(&mut c, 16, 200);
    let p = prog(&mut c);
    assert_eq!(p["phase"], "holding", "{p}");
    assert!(p["played_ms"].as_f64().unwrap() >= p0, "{p}");
    // a minimum it reaches → armed
    c.ok("set", json!({"path": "prog:main.interval_ms", "value": 3000}));
    let armed = wait_armed(&mut c, 1);
    // on_end → timer: the armed switch is cancelled, the countdown starts at the interval
    c.ok("set", json!({"path": "prog:main.interval_ms", "value": 60000}));
    let armed2 = wait_armed_or_held(&mut c);
    let corr = armed2["corr"].clone();
    c.ok("set", json!({"path": "prog:main.mode", "value": "timer"}));
    c.step(16);
    let p = prog(&mut c);
    assert_eq!(p["phase"], "playing", "{p}");
    assert_eq!(p["corr"], Value::Null, "{p}");
    close(p["remaining_ms"].as_f64().unwrap(), 60000.0, 20.0, "full interval");
    assert!(p["played_ms"].as_f64().unwrap() >= p0 + 200.0, "{p}");
    let cancelled = c.named("transition.cancelled");
    for k in [&armed["corr"], &corr] {
        if !k.is_null() {
            assert!(cancelled.iter().any(|e| e["corr"] == *k), "{k}: {cancelled:?}");
        }
    }
    assert_eq!(currents(&c).len(), 1, "no switch");
}

/// The program's state once it is armed or holding (a minimum change re-plans).
fn wait_armed_or_held(c: &mut Client) -> Value {
    for _ in 0..50 {
        c.step(16);
        let p = prog(c);
        if p["phase"] == "armed" || p["phase"] == "holding" {
            return p;
        }
    }
    panic!("never armed or held: {}", prog(c));
}

#[test]
fn live_transition_change_rearms_armed_switch() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("lr_a", 10.0), clip("lr_b", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "on_end", "transition": fade(500)}),
    );
    verb(&mut c, "play", json!({}));
    let armed = wait_armed(&mut c, 1);
    let req = scheduled(&c)
        .into_iter()
        .find(|e| e["corr"] == armed["corr"])
        .unwrap();
    assert_eq!(req["effect_id"], "fade");
    c.ok(
        "set",
        json!({"path": "prog:main.transition",
               "value": {"enabled": true, "effects": ["wipeLeft"], "duration_ms": 500}}),
    );
    let re = wait_armed(&mut c, 2);
    assert_ne!(re["corr"], armed["corr"]);
    assert_eq!(re["next"], armed["next"]);
    let req = scheduled(&c)
        .into_iter()
        .find(|e| e["corr"] == re["corr"])
        .unwrap();
    assert_eq!(req["effect_id"], "wipeLeft", "{req}");
    assert_eq!(req["align"], "end");
    assert!(
        c.named("transition.cancelled")
            .iter()
            .any(|e| e["corr"] == armed["corr"])
    );
}

#[test]
fn live_order_change_plays_rest_once_first() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("lo", 5);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 0}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    c.ok("set", json!({"path": "prog:main.order", "value": "shuffle"}));
    let p = prog(&mut c);
    assert_eq!(p["order"][0], json!(items[0]), "{p}");
    for k in 0..4 {
        verb(&mut c, "next", json!({}));
        step_until(&mut c, 16, 2000, "next", n_currents(k + 2));
    }
    let mut rest: Vec<String> = currents(&c)[1..]
        .iter()
        .map(|e| e["path"].as_str().unwrap().to_string())
        .collect();
    rest.sort();
    let mut want: Vec<String> = items[1..].iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(rest, want, "the rest, once each");
}

#[test]
fn items_edit_keeps_current_and_played_time() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("ie", 4);
    program(
        &mut c,
        &[&items[0], &items[1], &items[2]],
        json!({"mode": "timer", "interval_ms": 60000}),
    );
    verb(&mut c, "play", json!({"index": 1}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 100, 2000);
    let p0 = c.get("prog:main.played_ms").as_f64().unwrap();
    let r0 = c.get("prog:main.remaining_ms").as_f64().unwrap();
    let new = json!([{"path": items[2]}, {"path": items[1]}, {"path": items[0]}, {"path": items[3]}]);
    c.ok("set", json!({"path": "prog:main.items", "value": new}));
    c.step(16);
    let p = prog(&mut c);
    assert_eq!(p["path"], json!(items[1]), "{p}");
    assert!(p["played_ms"].as_f64().unwrap() >= p0, "{p}");
    assert!(p["remaining_ms"].as_f64().unwrap() <= r0, "{p}");
    assert_eq!(p["history"], json!([items[1]]));
    assert_eq!(currents(&c).len(), 1, "no switch");
}

#[test]
fn removing_current_lets_it_finish_without_replay() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("rc", 3);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 3000}));
    verb(&mut c, "play", json!({"index": 1}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 100, 1000);
    c.ok(
        "set",
        json!({"path": "prog:main.items", "value": [{"path": items[0]}, {"path": items[2]}]}),
    );
    c.step(16);
    assert_eq!(currents(&c).len(), 1, "it keeps playing");
    step_until(&mut c, 50, 20_000, "a cycle", n_currents(5));
    let cur = currents(&c);
    assert_eq!(cur[1]["path"], json!(items[2]), "the item after its old place");
    assert!(
        cur[1..].iter().all(|e| e["path"] != json!(items[1])),
        "never replayed: {cur:?}"
    );
}

#[test]
fn removing_the_armed_b_rearms_to_the_new_next() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("rb_a", 10.0), clip("rb_b", 10.0), clip("rb_c", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "on_end", "interval_ms": 3000}));
    verb(&mut c, "play", json!({}));
    let armed = wait_armed(&mut c, 1);
    assert_eq!(armed["next"], json!(items[1]));
    assert_eq!(c.get("cur:VIRTUAL-1.loop"), json!(false), "align:end ends A's loop");
    let played = c.get("prog:main.played_ms").as_f64().unwrap();
    c.ok(
        "set",
        json!({"path": "prog:main.items", "value": [{"path": items[0]}, {"path": items[2]}]}),
    );
    assert_eq!(
        c.get("cur:VIRTUAL-1.loop"),
        json!(true),
        "the abort restored A's loop"
    );
    assert!(
        c.named("transition.cancelled")
            .iter()
            .any(|e| e["corr"] == armed["corr"])
            || {
                c.step(16);
                c.named("transition.cancelled")
                    .iter()
                    .any(|e| e["corr"] == armed["corr"])
            }
    );
    let re = wait_armed(&mut c, 2);
    assert_eq!(re["next"], json!(items[2]), "{re}");
    assert!(re["played_ms"].as_f64().unwrap() >= played);
    assert_eq!(currents(&c).len(), 1);
}

#[test]
fn undo_regrows_a_one_item_session() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("ug_a", 10.0), clip("ug_b", 10.0), clip("ug_c", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items[..1], json!({"mode": "on_end"}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 16, 500);
    assert_eq!(prog(&mut c)["phase"], "playing");
    assert_eq!(scheduled(&c).len(), 1);
    let all: Vec<Value> = items.iter().map(|p| json!({"path": p})).collect();
    c.ok("set", json!({"path": "prog:main.items", "value": all}));
    let armed = wait_armed(&mut c, 1);
    assert_eq!(armed["next"], json!(items[1]));
}

#[test]
fn defaults_and_item_props_reach_the_next_b() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("dp", 3);
    c.ok(
        "subscribe",
        json!({"topics": ["program.", "transition.", "source."]}),
    );
    c.ok(
        "create",
        json!({"kind": "program", "id": "prog:main", "props": {
            "items": [{"path": items[0]}, {"path": items[1], "props": {"gain.user": -3.0}},
                      {"path": items[2]}],
            "defaults": {"gain.user": -10.0},
            "mode": "timer", "interval_ms": 0, "seed": 1}}),
    );
    let gain = |c: &mut Client, k: usize| -> f64 {
        let src = currents(c)[k]["source"].as_str().unwrap().to_string();
        c.get(&format!("{src}.gain.user")).as_f64().unwrap()
    };
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    assert_eq!(gain(&mut c, 0), -10.0);
    verb(&mut c, "next", json!({}));
    step_until(&mut c, 16, 2000, "next", n_currents(2));
    assert_eq!(gain(&mut c, 1), -3.0, "the item's own wins");
    c.ok(
        "set",
        json!({"path": "prog:main.defaults", "value": {"gain.user": -20.0}}),
    );
    assert_eq!(gain(&mut c, 1), -3.0, "a live source is the resolver's job");
    verb(&mut c, "next", json!({}));
    step_until(&mut c, 16, 2000, "next", n_currents(3));
    assert_eq!(gain(&mut c, 2), -20.0, "the new defaults reach the next B");
}

// ---------------------------------------------------------------- Task 5: pause, VRAM, parking, persistence

fn remove_outputs(c: &mut Client) {
    for o in ["VIRTUAL-1", "VIRTUAL-2"] {
        c.ok("headless.remove_output", json!({"name": o}));
    }
}

fn add_output(c: &mut Client, name: &str) {
    c.ok(
        "headless.add_output",
        json!({"name": name, "width": 320, "height": 180, "hz": 60}),
    );
}

/// The program's `transition.scheduled` with `parked: true`.
fn scheduled_parked(c: &Client) -> Vec<Value> {
    scheduled(c)
        .into_iter()
        .filter(|e| e["parked"] == json!(true))
        .collect()
}

#[test]
fn pause_freezes_the_rotation() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("pf", 2);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 3000}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    let mut t = 0;
    while t < 1000 {
        c.step(20);
        t += 20;
    }
    c.ok("set", json!({"path": "player.paused", "value": true}));
    c.step(20);
    let r0 = c.get("prog:main.remaining_ms").as_f64().unwrap();
    let p0 = c.get("prog:main.played_ms").as_f64().unwrap();
    for _ in 0..250 {
        c.step(20);
    }
    t += 20 + 5000;
    close(c.get("prog:main.remaining_ms").as_f64().unwrap(), r0, 1.0, "remaining");
    close(c.get("prog:main.played_ms").as_f64().unwrap(), p0, 1.0, "played");
    c.ok("set", json!({"path": "player.paused", "value": false}));
    while currents(&c).len() < 2 {
        assert!(t < 12_000, "never switched");
        c.step(20);
        t += 20;
    }
    close(t as f64, 8000.0, 60.0, "the switch at 1000 + 5000 paused + 2000");
}

#[test]
fn vram_hold_freezes_the_rotation() {
    let file = std::env::temp_dir().join(format!(
        "liascape-program-vramhold-{}.json",
        std::process::id()
    ));
    write_vram(&file, 6000.0, &[]);
    let probe = format!("fake:{}", file.display());
    let Some(srv) = Serve::start_clock(
        &[
            ("LIASCAPE_PLAYER_VRAM_PROBE", &probe),
            ("LIASCAPE_PLAYER_VRAM_TIMING", "50,300,600,200,1000"),
        ],
        "real",
    ) else {
        return;
    };
    let mut c = srv.client();
    c.ok("set", json!({"path": "player.vram_low_mode", "value": "pause"}));
    let items = pngs("vh", 2);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 2500}));
    verb(&mut c, "play", json!({}));
    wait_real(&mut c, Duration::from_secs(5), "the play", |c| {
        !c.named("program.current").is_empty()
    });
    write_vram(&file, 300.0, &[]);
    wait_real(&mut c, Duration::from_secs(5), "the hold", |c| {
        c.ok("state", json!({}))["graph"]["player"]["vram_low_active"] == json!(true)
    });
    let r0 = c.get("prog:main.remaining_ms").as_f64().unwrap();
    std::thread::sleep(Duration::from_secs(4));
    c.ok("state", json!({}));
    assert_eq!(c.named("program.current").len(), 1, "no switch while held");
    close(
        c.get("prog:main.remaining_ms").as_f64().unwrap(),
        r0,
        20.0,
        "the countdown stops",
    );
    write_vram(&file, 6000.0, &[]);
    wait_real(&mut c, Duration::from_secs(10), "the switch after the release", |c| {
        c.named("program.current").len() >= 2
    });
    let _ = std::fs::remove_file(&file);
}

#[test]
fn parked_keeps_rotating_invisibly_by_default() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("pk", 3);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 3000}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 20, 500);
    remove_outputs(&mut c);
    c.step(20);
    assert_eq!(prog(&mut c)["phase"], "parked");
    // 10 s parked: a switch every 3000 of play time, one each, each replacing the parked one
    let mut t = 20;
    while t < 10_000 {
        c.step(20);
        t += 20;
    }
    let sp = scheduled_parked(&c);
    assert_eq!(sp.len(), 3, "one per interval: {sp:?}");
    for w in sp.windows(2) {
        close(ms_of(&w[1]) - ms_of(&w[0]), 3000.0, 21.0, "the interval");
    }
    let last = currents(&c).last().unwrap()["path"].clone();
    add_output(&mut c, "VIRTUAL-1");
    c.step(20);
    let src = c.ok("state", json!({}))["graph"]["lay:VIRTUAL-1:main"]["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(c.get(&format!("{src}.path")), last, "the LAST target shown");
    let n = currents(&c).len();
    step_until(&mut c, 20, 4000, "the rotation goes on", n_currents(n + 1));
}

#[test]
fn parked_on_end_video_waits_for_an_output() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = [clip("pe_a", 2.0), clip("pe_b", 2.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "on_end", "interval_ms": 0}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    // the end switch armed before the outputs go is handed off by the runtime's removal (its
    // B becomes the parked wallpaper — R60/I4) and the program commits it
    remove_outputs(&mut c);
    c.step(16);
    c.step(16);
    let (n, k) = (scheduled(&c).len(), currents(&c).len());
    assert_eq!(prog(&mut c)["phase"], "parked");
    step_for(&mut c, 50, 8000);
    assert_eq!(scheduled(&c).len(), n, "a parked A never ends: nothing requested");
    assert_eq!(currents(&c).len(), k);
    add_output(&mut c, "VIRTUAL-1");
    step_until(&mut c, 16, 6000, "the end switch once shown", n_currents(k + 1));
    assert_eq!(currents(&c)[k]["reason"], "end");
    assert_eq!(scheduled(&c)[n]["align"], "end");
}

#[test]
fn parked_hold_mode_holds_and_resumes() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("ph", 3);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 3000, "while_parked": "hold"}),
    );
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    step_for(&mut c, 20, 1000);
    remove_outputs(&mut c);
    c.step(20);
    let p0 = prog(&mut c);
    assert_eq!(p0["phase"], "parked");
    step_for(&mut c, 50, 10_000);
    let p1 = prog(&mut c);
    assert_eq!(scheduled(&c).len(), 1, "nothing while held parked");
    assert_eq!(p1["played_ms"], p0["played_ms"]);
    assert_eq!(p1["remaining_ms"], p0["remaining_ms"]);
    add_output(&mut c, "VIRTUAL-1");
    c.step(20);
    let p2 = prog(&mut c);
    assert_eq!(p2["path"], json!(items[0]), "the same item");
    let mut t = 20u64;
    while currents(&c).len() < 2 {
        assert!(t < 4000, "never switched");
        c.step(20);
        t += 20;
    }
    let rem = p0["remaining_ms"].as_f64().unwrap();
    close(t as f64, rem, 45.0, "the switch at the remaining time");
}

#[test]
fn parked_mode_is_live() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("pl", 2);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 30_000}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    remove_outputs(&mut c);
    c.step(20);
    let r = |c: &mut Client| c.get("prog:main.remaining_ms").as_f64().unwrap();
    let r0 = r(&mut c);
    step_for(&mut c, 20, 1000);
    let r1 = r(&mut c);
    assert!(r1 < r0 - 900.0, "rotate counts while parked: {r0} → {r1}");
    c.ok("set", json!({"path": "prog:main.while_parked", "value": "hold"}));
    step_for(&mut c, 20, 1000);
    let r2 = r(&mut c);
    assert!((r2 - r1).abs() <= 21.0, "hold stops it at once: {r1} → {r2}");
    c.ok("set", json!({"path": "prog:main.while_parked", "value": "rotate"}));
    step_for(&mut c, 20, 1000);
    assert!(r(&mut c) < r2 - 900.0, "rotate again");
}

#[test]
fn hotplug_mid_program_switch_adopts() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("hp", 3);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(
        &mut c,
        &items,
        json!({"mode": "timer", "interval_ms": 2000, "transition": fade(1000)}),
    );
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 6000, "the timer switch", n_currents(2));
    c.step(100);
    add_output(&mut c, "VIRTUAL-3");
    step_until(&mut c, 16, 3000, "the handoff", |evs| {
        evs.iter().filter(|e| e["event"] == "transition.handoff").count() >= 2
    });
    assert!(
        !c.named("transition.output_adopted").is_empty(),
        "the new output adopted"
    );
    step_until(&mut c, 16, 4000, "the rotation goes on", n_currents(3));
    assert_eq!(currents(&c)[2]["path"], json!(items[2]));
    assert!(c.named("transition.failed").is_empty());
}

/// `<state>` of a `Serve`.
fn state_of(srv: &Serve) -> PathBuf {
    srv.path("state/liascape/liascape-player")
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// Poll `file` (real time) until `pred` holds over it.
fn wait_file(file: &Path, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let t = Instant::now();
    loop {
        if let Some(v) = read_json(file)
            && pred(&v)
        {
            return v;
        }
        assert!(
            t.elapsed() < Duration::from_secs(20),
            "{what}: {:?}",
            read_json(file)
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn stop_destroys_the_program() {
    let Some(srv) = Serve::start() else { return };
    let mut c = srv.client();
    let items = pngs("sd", 2);
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 3000}));
    verb(&mut c, "play", json!({}));
    step_until(&mut c, 16, 2000, "the play", n_currents(1));
    let st = state_of(&srv);
    wait_file(&st.join("program.json"), "program.json has it", |v| {
        v["programs"].as_array().is_some_and(|p| p.len() == 1)
    });
    wait_file(&st.join("snapshot.json"), "the snapshot has it", |v| {
        v["programs"].as_array().is_some_and(|p| p.len() == 1)
    });
    c.ok("stop", json!({}));
    assert_eq!(c.ok("state", json!({}))["programs"], json!([]));
    assert!(c.ok("state", json!({}))["graph"].get("prog:main").is_none());
    c.step(16);
    wait_file(&st.join("program.json"), "program.json empty", |v| {
        v["programs"] == json!([])
    });
    wait_file(&st.join("snapshot.json"), "no program in the snapshot", |v| {
        v.get("programs").is_none_or(|p| p == &json!([]))
    });
    step_for(&mut c, 50, 5000);
    assert!(scheduled(&c).len() == 1, "no rotation after stop");
}

#[test]
fn program_json_written_only_on_config_change() {
    let Some(srv) = Serve::start_clock(&[], "real") else {
        return;
    };
    let mut c = srv.client();
    let items = [clip("pj_a", 10.0), clip("pj_b", 10.0)];
    let items: Vec<&str> = items.iter().map(String::as_str).collect();
    program(&mut c, &items, json!({"mode": "timer", "interval_ms": 0}));
    verb(&mut c, "play", json!({}));
    let file = state_of(&srv).join("program.json");
    wait_file(&file, "program.json", |v| {
        v["programs"].as_array().is_some_and(|p| p.len() == 1)
    });
    std::thread::sleep(Duration::from_millis(600));
    let m0 = std::fs::metadata(&file).unwrap().modified().unwrap();
    let w0 = c.ok("probe", json!({"name": "snapshot"}))["writes"]
        .as_u64()
        .unwrap();
    std::thread::sleep(Duration::from_secs(10));
    let w1 = c.ok("probe", json!({"name": "snapshot"}))["writes"]
        .as_u64()
        .unwrap();
    assert!(w1 >= w0 + 4, "the snapshot refreshes while a video plays: {w0} → {w1}");
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        m0,
        "program.json untouched by playback"
    );
    c.ok("set", json!({"path": "prog:main.order", "value": "shuffle"}));
    let v = wait_file(&file, "the new order", |v| {
        v["programs"][0]["props"]["order"] == "shuffle"
    });
    std::thread::sleep(Duration::from_millis(1500));
    let m1 = std::fs::metadata(&file).unwrap().modified().unwrap();
    assert_ne!(m1, m0);
    assert_eq!(read_json(&file).unwrap()["rev"], v["rev"], "written once");
}
