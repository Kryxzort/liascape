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
