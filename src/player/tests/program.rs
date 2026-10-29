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
            "stepped",
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
    let e = c.err("set", json!({"path": "prog:main.outputs", "value": "out:VIRTUAL-1"}));
    assert_eq!(e["code"], "read_only", "{e}");
    assert_ne!(c.get("prog1.seed"), json!(0));
    // live props go through the schema
    c.ok("set", json!({"path": "prog:main.interval_ms", "value": 1000}));
    assert_eq!(c.get("prog:main.interval_ms"), json!(1000.0));
    let e = c.err("set", json!({"path": "prog:main.mode", "value": "sometimes"}));
    assert_eq!(e["code"], "bad_type", "{e}");
    let e = c.err("set", json!({"path": "prog:main.interval_ms", "value": 4e9}));
    assert_eq!(e["code"], "out_of_range", "{e}");
    let e = c.err("set", json!({"path": "prog:main.transition", "value": {"method": "slide"}}));
    assert_eq!(e["code"], "out_of_range", "{e}");
    let e = c.err("set", json!({"path": "prog:main.defaults", "value": {"nope": 1}}));
    assert_eq!(e["code"], "no_such_prop", "{e}");
    // hello advertises it
    let h = c.ok("hello", json!({}));
    assert!(
        h["capabilities"].as_array().unwrap().contains(&json!("program")),
        "{h}"
    );
    let l = c.ok("logs", json!({"kind_prefix": "program.created"}));
    assert!(
        l["events"].as_array().unwrap().iter().any(|e| e["id"] == "prog:main"),
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
    let set = |c: &mut Client, v: Value| {
        c.err("set", json!({"path": "prog:main.items", "value": v}))
    };
    // a bad props key → no_such_prop naming the index
    let e = set(&mut c, json!([{"path": "/a.mkv"}, {"path": "/b.mkv", "props": {"nope": 1}}]));
    assert_eq!(e["code"], "no_such_prop", "{e}");
    assert!(e["message"].as_str().unwrap().contains("items[1]"), "{e}");
    // a badly typed / out-of-range prop
    let e = set(&mut c, json!([{"path": "/a.mkv", "props": {"speed": "fast"}}]));
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
    let many: Vec<Value> = (0..10_001).map(|i| json!({"path": format!("/m{i}.mkv")})).collect();
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
    let many: Vec<Value> = (0..10_000).map(|i| json!({"path": format!("/m{i}.mkv")})).collect();
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
    for verb in ["program.play", "program.next", "program.prev", "program.random"] {
        let e = c.err(verb, json!({"id": "prog:x"}));
        assert_eq!(e["code"], "no_such_node", "{verb}: {e}");
    }
    c.ok("create", json!({"kind": "program", "id": "prog:main"}));
    for verb in ["program.play", "program.next", "program.prev", "program.random"] {
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
    c.ok("set", json!({"path": "lay:*:main.content", "value": r["id"]}));
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
