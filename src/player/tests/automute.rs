//! Phase 3 Task 14: the in-player auto-mute Signal end to end, on a **private, hermetic**
//! PipeWire + WirePlumber (`common::pw`; the owner's audio is never touched) with a second null
//! sink, `foreign-sink`, that every "foreign" test stream plays to (synthetic tones, `pw-cat`).
//! The player runs `serve --headless --clock real --ao pipewire` with
//! `LIASCAPE_PLAYER_AUTOMUTE=1`; its wallpaper plays a −20 dBFS tone on the bus, which forwards
//! to `hermetic-sink`.
//!
//! `measure_automute_latency` (ignored; `scripts/measure-automute-latency.py` runs it) times
//! both engines in the same harness: the Signal, and a faithful port of today's backend
//! `AudioMonitor` (`pactl subscribe` + `pactl list sink-inputs` classification + one `parec
//! --monitor-stream --latency-msec=10` per sink-input, 20 ms chunks, a 20 ms poll loop, then the
//! adapter's `animate <id>.gain.mute` over 30 ms) on a private `pipewire-pulse`. An in-test
//! observer captures both sinks' monitors on one PipeWire connection, so the first audible
//! foreign sample and the wallpaper's silence are timed on the same graph cycles.
//!
//! Skips without an EGL device / catalogue (fails under `LIASCAPE_REQUIRE_GPU=1`) and without the
//! PipeWire binaries.

mod common;

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use common::pw::PrivatePw;
use common::{ClipSpec, ensure_clip, headless_gl};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_liascape-player");
static SERIAL: Mutex<()> = Mutex::new(());
static N: AtomicU32 = AtomicU32::new(0);

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

// ---------------------------------------------------------------- the rig

struct Rig {
    pw: PrivatePw,
    child: Option<Child>,
    root: PathBuf,
    sock: PathBuf,
    env: Vec<(String, String)>,
    foreign: Vec<Child>,
    _serial: MutexGuard<'static, ()>,
}

fn pw_cmd(pw: &PrivatePw, bin: &str, args: &[&str]) -> std::process::Output {
    pw.command(bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|e| panic!("{bin}: {e}"))
}

impl Rig {
    /// A private PipeWire with `foreign-sink`, and the player on it (`env` added).
    fn start(env: &[(&str, &str)]) -> Option<Rig> {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        if headless_gl().is_none() || common::catalogue_dir().is_none() {
            common::skip_gpu("no EGL device or no transitions/ catalogue");
            return None;
        }
        if !PrivatePw::available() {
            println!("SKIP: no pipewire/wireplumber binaries for a private instance");
            return None;
        }
        // short: the PipeWire / pulse socket paths must fit a sockaddr_un
        let root = std::env::temp_dir().join(format!(
            "lia-am-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("run")).unwrap();
        std::fs::create_dir_all(root.join("state")).unwrap();
        let mut pw = PrivatePw::new(root.join("pw"));
        pw.start();
        let out = pw_cmd(
            &pw,
            "pw-cli",
            &[
                "create-node",
                "adapter",
                "{ factory.name = support.null-audio-sink node.name = foreign-sink \
                 node.description = \"foreign sink\" media.class = Audio/Sink \
                 audio.position = [ FL FR ] object.linger = true node.group = pipewire.dummy \
                 monitor.channel-volumes = true }",
            ],
        );
        assert!(out.status.success(), "foreign-sink: {out:?}");
        let _ = pw_cmd(
            &pw,
            "pw-metadata",
            &[
                "0",
                "default.configured.audio.sink",
                "{ \"name\": \"hermetic-sink\" }",
            ],
        );
        let sock = root.join("run/liascape/liascape-player.sock");
        let run = pw.run_dir().display().to_string();
        let mut env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        env.push(("PIPEWIRE_RUNTIME_DIR".into(), run));
        env.push(("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES".into(), "1".into()));
        if !env.iter().any(|(k, _)| k == "DBUS_SESSION_BUS_ADDRESS") {
            env.push(("DBUS_SESSION_BUS_ADDRESS".into(), "unix:path=/nonexistent".into()));
        }
        let mut r = Rig {
            pw,
            child: None,
            root,
            sock,
            env,
            foreign: Vec::new(),
            _serial: serial,
        };
        r.spawn(&[]);
        Some(r)
    }

    fn spawn(&mut self, extra: &[&str]) {
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
            "real",
            "--ao",
            "pipewire",
            "--log-level",
            "debug",
        ])
        .args(extra)
        .env("LIASCAPE_PLAYER_VRAM_PROBE", "none")
        .env("XDG_RUNTIME_DIR", self.root.join("run"))
        .env("XDG_STATE_HOME", self.root.join("state"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.root.join("stderr.log"))
                .unwrap(),
        ));
        for (k, v) in &self.env {
            c.env(k, v);
        }
        self.child = Some(c.spawn().expect("spawn liascape-player serve"));
        *DIAG_SOCK.lock().unwrap_or_else(|e| e.into_inner()) = Some(self.sock.clone());
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
        std::fs::read_to_string(self.root.join("stderr.log")).unwrap_or_default()
    }

    fn client(&self) -> Client {
        Client::connect(&self.sock)
    }

    fn pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    /// A synthetic tone WAV under the rig (`lead_ms` of silence, then `tone_ms` at `dbfs`).
    fn wav(&self, name: &str, lead_ms: u32, tone_ms: u32, dbfs: f64) -> PathBuf {
        let p = self.root.join(format!("{name}.wav"));
        write_wav(&p, lead_ms, tone_ms, dbfs, 1000.0);
        p
    }

    /// `pw-cat --playback` of `wav` into `foreign-sink` (`props`: extra node properties).
    fn play(&mut self, wav: &Path, props: &str, extra: &[&str]) -> u32 {
        let mut c = self.pw.command("pw-cat");
        c.args(["--playback", "--target", "foreign-sink"])
            .args(if props.is_empty() {
                vec![]
            } else {
                vec!["-P", props]
            })
            .args(extra)
            .arg(wav)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let ch = c.spawn().expect("pw-cat");
        let pid = ch.id();
        self.foreign.push(ch);
        pid
    }

    fn stop_foreign(&mut self) {
        for mut c in self.foreign.drain(..) {
            unsafe { libc::kill(c.id() as i32, libc::SIGTERM) };
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(2) {
                if c.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.stop_foreign();
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.pw.kill();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A mono 48 kHz s16 WAV: `lead_ms` digital silence, then a `hz` sine at `dbfs` peak.
fn write_wav(p: &Path, lead_ms: u32, tone_ms: u32, dbfs: f64, hz: f64) {
    let rate = 48_000u32;
    let lead = (rate as u64 * lead_ms as u64 / 1000) as usize;
    let tone = (rate as u64 * tone_ms as u64 / 1000) as usize;
    let amp = 10f64.powf(dbfs / 20.0) * 32767.0;
    let mut pcm = Vec::with_capacity((lead + tone) * 2);
    for _ in 0..lead {
        pcm.extend_from_slice(&0i16.to_le_bytes());
    }
    for i in 0..tone {
        let v = (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin()).round();
        pcm.extend_from_slice(&(v as i16).to_le_bytes());
    }
    let mut f = Vec::new();
    f.extend_from_slice(b"RIFF");
    f.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    f.extend_from_slice(b"WAVEfmt ");
    f.extend_from_slice(&16u32.to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&rate.to_le_bytes());
    f.extend_from_slice(&(rate * 2).to_le_bytes());
    f.extend_from_slice(&2u16.to_le_bytes());
    f.extend_from_slice(&16u16.to_le_bytes());
    f.extend_from_slice(b"data");
    f.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    f.extend_from_slice(&pcm);
    std::fs::write(p, f).unwrap();
}

// ---------------------------------------------------------------- client

struct Client {
    w: UnixStream,
    r: BufReader<UnixStream>,
    id: u64,
}

impl Client {
    fn connect(sock: &Path) -> Client {
        let w = UnixStream::connect(sock).expect("connect");
        w.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        let r = BufReader::new(w.try_clone().unwrap());
        Client { w, r, id: 0 }
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
            assert!(n > 0, "server closed the connection during {cmd}");
            let m: Value = serde_json::from_str(&buf).unwrap();
            if m.get("event").is_some() {
                continue;
            }
            if m["id"] == json!(id) {
                return m;
            }
        }
    }

    fn ok(&mut self, cmd: &str, args: Value) -> Value {
        let r = self.call(cmd, args.clone());
        assert_eq!(r["ok"], json!(true), "{cmd} {args} failed: {r}");
        r["result"].clone()
    }

    fn get(&mut self, path: &str) -> Value {
        self.ok("get", json!({ "path": path }))["value"].clone()
    }

    fn set(&mut self, path: &str, v: Value) {
        self.ok("set", json!({ "path": path, "value": v }));
    }

    fn probe(&mut self) -> Value {
        self.ok("probe", json!({"name": "automute"}))
    }

    fn events(&mut self, prefix: &str) -> Vec<Value> {
        self.ok("logs", json!({"kind_prefix": prefix, "limit": 10000}))["events"]
            .as_array()
            .unwrap()
            .clone()
    }
}

/// The running player's socket, for [`wait_for`]'s diagnosis on a timeout.
static DIAG_SOCK: Mutex<Option<PathBuf>> = Mutex::new(None);

fn wait_for<T>(limit: Duration, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let t = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        if t.elapsed() >= limit {
            let sock = DIAG_SOCK.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(sock) = sock.filter(|p| p.exists()) {
                let mut c = Client::connect(&sock);
                println!("DIAG probe automute: {}", c.probe());
                let evs = c.events("automute.");
                println!("DIAG automute events: {}", json!(evs));
                let evs = c.events("audio.visualiser");
                println!("DIAG sysmon events: {}", json!(evs));
            }
            panic!("timed out after {limit:?} waiting for {what}");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// A looping wallpaper with a tone, on every output, playing on the bus.
fn wallpaper(c: &mut Client, spec: ClipSpec, name: &str) -> String {
    wait_for(Duration::from_secs(5), "bus up", || {
        (c.ok("probe", json!({"name": "bus"}))["state"] == json!("up")).then_some(())
    });
    let id = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&ensure_clip(name, spec)), "loop": true}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    c.ok("set", json!({"path": "lay:*:main.content", "value": id}));
    wait_for(Duration::from_secs(5), "the wallpaper's tone on the bus", || {
        let r = c.call(
            "probe",
            json!({"name": "meter.window", "args": {"last_ms": 200, "samples": false}}),
        );
        r["result"]["median_db"]
            .as_f64()
            .is_some_and(|db| db > -40.0)
            .then_some(())
    });
    id
}

fn active(c: &mut Client) -> bool {
    c.get("player.automute_active") == json!(true)
}

fn automute_on(c: &mut Client, delay: f64, undelay: f64) {
    c.set("player.automute_delay_ms", json!(delay));
    c.set("player.autounmute_delay_ms", json!(undelay));
    c.set("player.automute", json!(true));
    wait_for(Duration::from_secs(5), "the capture connected", || {
        (c.probe()["monitor"]["connected"] == json!(true)).then_some(())
    });
}

fn stream_of<'a>(p: &'a Value, pred: impl Fn(&Value) -> bool) -> Option<&'a Value> {
    p["streams"].as_array()?.iter().find(|s| pred(s))
}

// ---------------------------------------------------------------- api tests

#[test]
fn automute_mutes_on_a_foreign_stream() {
    let Some(mut rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    let caps = c.ok("hello", json!({}))["capabilities"].clone();
    let id = wallpaper(&mut c, RED_10S, "am_red_10s");
    assert!(
        c.ok("hello", json!({}))["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("automute")),
        "automute capability with the bus up: {caps}"
    );
    // defaults (owner 2026-10-29): 500 ms mute delay, 2000 ms unmute, −70 dB, off
    assert_eq!(c.get("player.automute"), json!(false));
    assert_eq!(c.get("player.automute_delay_ms"), json!(500.0));
    assert_eq!(c.get("player.autounmute_delay_ms"), json!(2000.0));
    assert_eq!(c.get("player.automute_min_level_db"), json!(-70.0));
    automute_on(&mut c, 0.0, 300.0);
    // its own wallpaper is metered and never counts
    let p = wait_for(Duration::from_secs(3), "the wallpaper's stream seen", || {
        let p = c.probe();
        stream_of(&p, |s| s["verdict"].as_str().is_some_and(|v| v.starts_with("own:")))
            .is_some()
            .then_some(p)
    });
    assert!(!active(&mut c), "own audio never mutes: {p}");
    // a user's `mpv` is foreign (today's application.name filter was a bug) — here a pw-cat
    // that calls itself mpv
    let wav = rig.wav("tone1500", 0, 1500, -20.0);
    let pid = rig.play(&wav, "{ application.name = mpv }", &[]);
    wait_for(Duration::from_secs(3), "auto-muted", || active(&mut c).then_some(()));
    let p = c.probe();
    let st = stream_of(&p, |s| s["pid"] == json!(pid)).unwrap_or_else(|| panic!("{p}"));
    assert_eq!(st["verdict"], json!("foreign"), "{st}");
    assert_eq!(st["counts"], json!(true), "{st}");
    assert_eq!(st["app"], json!("mpv"));
    wait_for(Duration::from_secs(1), "the source at −96", || {
        (c.get(&format!("{id}.gain.automute")).as_f64() == Some(-96.0)).then_some(())
    });
    // the tone ends → unmute after 300 ms of silence
    wait_for(Duration::from_secs(4), "auto-unmuted", || {
        (!active(&mut c)).then_some(())
    });
    wait_for(Duration::from_secs(1), "the source back at 0", || {
        (c.get(&format!("{id}.gain.automute")).as_f64() == Some(0.0)).then_some(())
    });
    let evs = c.events("automute.");
    let muted = evs.iter().find(|e| e["kind"] == "automute.muted").unwrap();
    let unmuted = evs.iter().find(|e| e["kind"] == "automute.unmuted").unwrap();
    println!("muted {muted}\nunmuted {unmuted}");
    assert!(
        (unmuted["silent_ms"].as_f64().unwrap() - 300.0).abs() < 25.0,
        "{unmuted}"
    );
    // switched off while foreign audio plays: never mutes
    c.set("player.automute", json!(false));
    rig.play(&wav, "", &[]);
    std::thread::sleep(Duration::from_millis(600));
    assert!(!active(&mut c));
}

#[test]
fn automute_ignores_own_switches_every_combo() {
    use liascape_player::scene::synthetic::{Pattern, SyntheticSpec};
    let Some(rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    automute_on(&mut c, 0.0, 0.0);
    let scene = |name: &str, hz: f64| {
        common::synthetic_scene(
            name,
            &SyntheticSpec {
                pattern: Pattern::Solid,
                tone_hz: hz,
                has_audio: true,
                ..SyntheticSpec::default()
            },
        )
    };
    let v1 = ensure_clip("am_red_10s", RED_10S);
    let v2 = ensure_clip("am_blue_10s", BLUE_10S);
    let s1 = scene("am-scene-a", 550.0);
    let s2 = scene("am-scene-b", 770.0);
    let to = |kind: &str, p: &Path| json!({"kind": kind, "path": s(p), "loop": true});
    // V→V, V→S, S→S, S→V in a chain, each under every method
    let chain = [
        to("video", &v2),
        to("scene", &s1),
        to("scene", &s2),
        to("video", &v1),
    ];
    let mut n = 0;
    for method in ["full-live", "reveal", "frozen"] {
        for target in &chain {
            let r = c.ok(
                "transition",
                json!({"outputs": "out:*", "to": target, "effect_id": "fade",
                       "duration_ms": 400, "method": method}),
            );
            let corr = r["corr"].as_str().unwrap().to_string();
            wait_for(Duration::from_secs(15), "transition.done", || {
                c.events("transition.done")
                    .iter()
                    .any(|e| e["corr"] == json!(corr))
                    .then_some(())
            });
            std::thread::sleep(Duration::from_millis(250));
            n += 1;
            assert!(!active(&mut c), "auto-muted by its own switch #{n} ({method})");
        }
    }
    let p = c.probe();
    let own: Vec<&Value> = p["streams"].as_array().unwrap().iter().collect();
    assert!(!own.is_empty());
    for st in &own {
        assert!(
            st["verdict"].as_str().unwrap().starts_with("own:"),
            "only our own streams play here: {st}"
        );
    }
    let muted = c.events("automute.muted");
    assert!(muted.is_empty(), "{n} switches → 0 mutes, got {muted:?}");
    println!("{n} switches, 0 mutes; verdicts {:?}", own.iter().map(|s| s["verdict"].clone()).collect::<Vec<_>>());
}

#[test]
fn automute_delays_and_threshold() {
    let Some(mut rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    automute_on(&mut c, 500.0, 700.0);
    // below the threshold (−80 dBFS < −70): heard, never counts
    let quiet = rig.wav("quiet", 0, 5000, -80.0);
    rig.play(&quiet, "", &[]);
    std::thread::sleep(Duration::from_millis(1000));
    assert!(!active(&mut c), "a −80 dBFS tone under a −70 dB threshold");
    // the threshold lowered live: the same tone mutes
    c.set("player.automute_min_level_db", json!(-90.0));
    wait_for(Duration::from_secs(2), "muted at −90", || active(&mut c).then_some(()));
    rig.stop_foreign();
    wait_for(Duration::from_secs(3), "unmuted", || (!active(&mut c)).then_some(()));
    c.set("player.automute_min_level_db", json!(-70.0));
    // a tone shorter than the delay never mutes
    let short = rig.wav("short", 0, 300, -20.0);
    rig.play(&short, "", &[]);
    std::thread::sleep(Duration::from_millis(900));
    assert!(!active(&mut c), "300 ms < the 500 ms delay");
    // the delays land where they are set (the player's own account; the measure script
    // times it from outside)
    let tone = rig.wav("tone2000", 300, 1500, -20.0);
    rig.play(&tone, "", &[]);
    wait_for(Duration::from_secs(3), "muted", || active(&mut c).then_some(()));
    wait_for(Duration::from_secs(4), "unmuted", || (!active(&mut c)).then_some(()));
    let evs = c.events("automute.");
    let m = evs
        .iter()
        .rev()
        .find(|e| e["kind"] == "automute.muted")
        .unwrap()
        .clone();
    let u = evs
        .iter()
        .rev()
        .find(|e| e["kind"] == "automute.unmuted")
        .unwrap()
        .clone();
    println!("muted {m}\nunmuted {u}");
    let end_after_run = m["end_ms"].as_f64().unwrap() - m["run_start_ms"].as_f64().unwrap();
    assert!((end_after_run - 500.0).abs() < 15.0, "mute ends at the delay: {m}");
    assert!((u["silent_ms"].as_f64().unwrap() - 700.0).abs() < 15.0, "{u}");
    // turned down below the threshold (the meter reads post-volume): not silent by its Props,
    // and it never mutes
    let down = rig.wav("down", 0, 1500, -20.0);
    let pid = rig.play(&down, "", &["--volume", "0.001"]);
    std::thread::sleep(Duration::from_millis(900));
    let p = c.probe();
    let st = stream_of(&p, |s| s["pid"] == json!(pid)).unwrap_or_else(|| panic!("{p}"));
    println!("turned-down stream: {st}");
    assert_eq!(st["silent_by_volume"], json!(false), "{st}");
    assert!(st["peak_db"].as_f64().unwrap() < -70.0, "post-volume: {st}");
    assert!(!active(&mut c), "turned down below the threshold: {st}");
    rig.stop_foreign();
    wait_for(Duration::from_secs(3), "still unmuted", || (!active(&mut c)).then_some(()));
    // a stream muted by its own volume is silent (Props `mute`), one at volume 0 too
    let loud = rig.wav("loud", 0, 3000, -20.0);
    let pid = rig.play(&loud, "", &["--volume", "0"]);
    std::thread::sleep(Duration::from_millis(1200));
    let p = c.probe();
    let st = stream_of(&p, |s| s["pid"] == json!(pid)).unwrap_or_else(|| panic!("{p}"));
    println!("volume-0 stream: {st}");
    assert!(!active(&mut c), "a volume-0 stream: {st}");
    assert_eq!(st["counts"], json!(false), "{st}");
    assert_eq!(st["silent_by_volume"], json!(true), "{st}");
    rig.stop_foreign();
    // an audible stream that mutes the wallpaper, then is muted itself (its node's Props
    // `mute`, as pavucontrol does): it stops counting → the unmute delay runs
    let pid = rig.play(&loud, "", &[]);
    wait_for(Duration::from_secs(3), "muted by the loud stream", || {
        active(&mut c).then_some(())
    });
    let p = c.probe();
    let node = stream_of(&p, |s| s["pid"] == json!(pid)).unwrap()["id"]
        .as_u64()
        .unwrap()
        .to_string();
    let out = pw_cmd(&rig.pw, "pw-cli", &["set-param", &node, "Props", "{ mute: true }"]);
    assert!(out.status.success(), "{out:?}");
    wait_for(Duration::from_secs(3), "its Props mute seen", || {
        let p = c.probe();
        let st = stream_of(&p, |s| s["pid"] == json!(pid))?.clone();
        (st["mute"] == json!(true) && st["counts"] == json!(false)).then_some(())
    });
    wait_for(Duration::from_secs(3), "unmuted while it plays muted", || {
        (!active(&mut c)).then_some(())
    });
}

#[test]
fn automute_new_source_comes_up_muted() {
    let Some(mut rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    automute_on(&mut c, 0.0, 2000.0);
    let long = rig.wav("long", 0, 20_000, -20.0);
    rig.play(&long, "", &[]);
    wait_for(Duration::from_secs(3), "muted", || active(&mut c).then_some(()));
    // a plain create
    let b = c.ok(
        "create",
        json!({"kind": "source", "props": {"path": s(&ensure_clip("am_blue_10s", BLUE_10S)), "loop": true}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(c.get(&format!("{b}.gain.automute")), json!(-96.0), "at create");
    // a transition's B (every program switch makes one)
    let r = c.ok(
        "transition",
        json!({"outputs": "out:*", "to": {"kind": "video", "path": s(&ensure_clip("am_red_10s", RED_10S))},
               "effect_id": "fade", "duration_ms": 300}),
    );
    let to = r["to"].as_str().unwrap().to_string();
    assert_eq!(c.get(&format!("{to}.gain.automute")), json!(-96.0), "B at create");
    std::thread::sleep(Duration::from_millis(800));
    // and the bus stays silent through the switch
    let w = c.ok(
        "probe",
        json!({"name": "meter.window", "args": {"last_ms": 600, "samples": false}}),
    );
    assert!(w["max_db"].as_f64().unwrap() <= -90.0, "silent while muted: {w}");
    assert!(active(&mut c));
}

#[test]
fn automute_survives_a_crash_restart() {
    let Some(mut rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    automute_on(&mut c, 0.0, 800.0);
    c.set("player.automute_min_level_db", json!(-60.0));
    let long = rig.wav("long", 0, 30_000, -20.0);
    rig.play(&long, "", &[]);
    wait_for(Duration::from_secs(3), "muted", || active(&mut c).then_some(()));
    let writes = c.ok("probe", json!({"name": "snapshot"}))["writes"].as_u64().unwrap();
    wait_for(Duration::from_secs(10), "a snapshot with the settings", || {
        let p = c.ok("probe", json!({"name": "snapshot"}));
        (p["writes"].as_u64().unwrap() > writes && p["due_in_ms"].is_null()).then_some(())
    });
    // a crash: SIGKILL, then the restart a supervisor would do
    let mut child = rig.child.take().unwrap();
    unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
    let _ = child.wait();
    let _ = std::fs::remove_file(&rig.sock);
    rig.spawn(&["--restore"]);
    let mut c = rig.client();
    assert_eq!(c.get("player.automute"), json!(true));
    assert_eq!(c.get("player.automute_delay_ms"), json!(0.0));
    assert_eq!(c.get("player.autounmute_delay_ms"), json!(800.0));
    assert_eq!(c.get("player.automute_min_level_db"), json!(-60.0));
    wait_for(Duration::from_secs(5), "muted again (foreign audio still playing)", || {
        active(&mut c).then_some(())
    });
    let id = c.ok("state", json!({}))["graph"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, n)| n["kind"] == "video")
        .map(|(id, _)| id.clone())
        .expect("the restored wallpaper");
    wait_for(Duration::from_secs(5), "the restored wallpaper at −96", || {
        (c.get(&format!("{id}.gain.automute")).as_f64() == Some(-96.0)).then_some(())
    });
    rig.stop_foreign();
    wait_for(Duration::from_secs(4), "unmuted after the crash", || {
        (!active(&mut c)).then_some(())
    });
}

/// Every child process of `pid` (`/proc/*/stat` ppid).
fn children_of(pid: u32) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir("/proc").unwrap().flatten() {
        let Ok(p) = e.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(st) = std::fs::read_to_string(format!("/proc/{p}/stat")) else {
            continue;
        };
        let Some(close) = st.rfind(')') else { continue };
        let comm = st[st.find('(').unwrap_or(0) + 1..close].to_string();
        if st[close + 1..].split_whitespace().nth(1) == Some(&pid.to_string()) {
            out.push((p, comm));
        }
    }
    out
}

#[test]
fn automute_spawns_no_processes() {
    let Some(mut rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    automute_on(&mut c, 0.0, 2000.0);
    let before = children_of(rig.pid());
    let quiet = rig.wav("silence", 10_000, 0, -20.0);
    let mut pids = BTreeSet::new();
    for _ in 0..20 {
        pids.insert(rig.play(&quiet, "", &[]));
    }
    let p = wait_for(Duration::from_secs(10), "20 foreign streams metered", || {
        let p = c.probe();
        let n = p["streams"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["pid"].as_u64().is_some_and(|x| pids.contains(&(x as u32))))
            .count();
        (n == 20).then_some(p)
    });
    let after = children_of(rig.pid());
    println!("children before {before:?}, with 20 streams {after:?}");
    assert_eq!(after, before, "0 processes spawned for 20 streams");
    assert!(
        p["streams"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["verdict"] == json!("foreign"))
            .count()
            >= 20
    );
    assert!(!active(&mut c), "20 silent streams never mute");
}

#[test]
fn automute_mpris_mode_without_a_session_bus_never_mutes() {
    let Some(mut rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    c.set("player.automute_only_if_mpris", json!(true));
    automute_on(&mut c, 0.0, 300.0);
    let wav = rig.wav("tone", 0, 1500, -20.0);
    let pid = rig.play(&wav, "", &[]);
    std::thread::sleep(Duration::from_millis(800));
    let p = c.probe();
    println!("{}", p["mpris"]);
    assert_eq!(p["mpris"]["available"], json!(false), "{p}");
    let st = stream_of(&p, |s| s["pid"] == json!(pid)).unwrap();
    assert_eq!(st["verdict"], json!("foreign"));
    assert_eq!(st["counts"], json!(false), "no Playing player owns it");
    assert!(!active(&mut c));
}

/// A fake MPRIS player on a private session bus, owned by this test process — so a `pw-cat`
/// this process spawns is in its pid tree (like a browser's audio child).
struct FakeMpris {
    status: Arc<Mutex<String>>,
}

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl FakeMpris {
    #[zbus(property)]
    fn playback_status(&self) -> String {
        self.status.lock().unwrap().clone()
    }
}

struct FakeRoot;

#[zbus::interface(name = "org.mpris.MediaPlayer2")]
impl FakeRoot {
    #[zbus(property)]
    fn identity(&self) -> String {
        "Fake Player".into()
    }
}

#[test]
fn automute_mpris_hears_only_the_playing_players_own_streams() {
    let bus_dir = std::env::temp_dir().join(format!("lia-am-dbus-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&bus_dir);
    let addr = format!("unix:path={}", bus_dir.join("bus").display());
    let mut dbus = match Command::new("dbus-daemon")
        .args(["--session", "--nofork", &format!("--address={addr}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => {
            println!("SKIP: no dbus-daemon");
            return;
        }
    };
    wait_for(Duration::from_secs(5), "the private session bus", || {
        bus_dir.join("bus").exists().then_some(())
    });
    let Some(mut rig) = Rig::start(&[
        ("LIASCAPE_PLAYER_AUTOMUTE", "1"),
        ("DBUS_SESSION_BUS_ADDRESS", addr.as_str()),
    ]) else {
        let _ = dbus.kill();
        return;
    };
    let status = Arc::new(Mutex::new("Paused".to_string()));
    let _conn = zbus::blocking::connection::Builder::address(addr.as_str())
        .unwrap()
        .name("org.mpris.MediaPlayer2.fake")
        .unwrap()
        .serve_at("/org/mpris/MediaPlayer2", FakeRoot)
        .unwrap()
        .serve_at(
            "/org/mpris/MediaPlayer2",
            FakeMpris {
                status: status.clone(),
            },
        )
        .unwrap()
        .build()
        .unwrap();
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    c.set("player.automute_only_if_mpris", json!(true));
    automute_on(&mut c, 0.0, 300.0);
    let players = |c: &mut Client| c.probe()["mpris"]["players"].clone();
    wait_for(Duration::from_secs(5), "the fake player read", || {
        (players(&mut c)[0]["identity"] == json!("Fake Player")).then_some(())
    });
    // another app's sound: a pw-cat NOT in our pid tree (orphaned by `sh`)
    let other = rig.wav("other", 0, 20_000, -20.0);
    let out = rig
        .pw
        .command("sh")
        .args([
            "-c",
            &format!(
                "pw-cat --playback --target foreign-sink {} >/dev/null 2>&1 & echo $!",
                other.display()
            ),
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let other_pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
    let kill_other = || unsafe {
        libc::kill(other_pid as i32, libc::SIGTERM);
    };
    std::thread::sleep(Duration::from_millis(800));
    assert!(!active(&mut c), "no player is Playing");
    // the player starts Playing — its own song muted (volume 0), the other app still playing
    *status.lock().unwrap() = "Playing".into();
    wait_for(Duration::from_secs(4), "Playing read", || {
        (players(&mut c)[0]["playing"] == json!(true)).then_some(())
    });
    let song = rig.wav("song", 0, 20_000, -20.0);
    let song_pid = rig.play(&song, "", &["--volume", "0"]);
    std::thread::sleep(Duration::from_millis(1000));
    let p = c.probe();
    println!("mpris {}", p["mpris"]);
    let st = stream_of(&p, |s| s["pid"] == json!(song_pid)).unwrap().clone();
    assert_eq!(st["mpris"]["how"], json!("pid_tree"), "{st}");
    let o = stream_of(&p, |s| s["pid"] == json!(other_pid)).unwrap().clone();
    assert!(o["mpris"].is_null() && o["counts"] == json!(false), "{o}");
    assert!(!active(&mut c), "a muted song + another app's sound → no mute");
    // the song audible → mute
    rig.stop_foreign();
    let song_pid = rig.play(&song, "", &[]);
    wait_for(Duration::from_secs(3), "muted by the player's own song", || {
        active(&mut c).then_some(())
    });
    let p = c.probe();
    assert_eq!(
        stream_of(&p, |s| s["pid"] == json!(song_pid)).unwrap()["counts"],
        json!(true)
    );
    // Paused again → its stream stops counting → unmute (the other app plays on)
    *status.lock().unwrap() = "Paused".into();
    wait_for(Duration::from_secs(5), "unmuted on Paused", || {
        (!active(&mut c)).then_some(())
    });
    // Playing with only a stream it doesn't own: reported unmatched
    rig.stop_foreign();
    *status.lock().unwrap() = "Playing".into();
    let unmatched = wait_for(Duration::from_secs(5), "mpris.unmatched", || {
        let u = c.probe()["mpris"]["unmatched"].clone();
        (u.as_array().is_some_and(|a| !a.is_empty())).then_some(u)
    });
    assert_eq!(unmatched, json!(["mpris.unmatched:Fake Player"]));
    assert!(!active(&mut c));
    kill_other();
    let _ = dbus.kill();
    let _ = dbus.wait();
    let _ = std::fs::remove_dir_all(&bus_dir);
}

/// A pipewire-pulse client (a notification's `paplay`, binary `pacat`): its stream carries the client's own
/// `application.process.id`, never the pulse server's pid, and it mutes like any other.
#[test]
fn automute_hears_a_pulse_client() {
    let Some(rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    automute_on(&mut c, 0.0, 300.0);
    let mut pulse = rig.pw.command("pipewire-pulse");
    pulse
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut pulse = pulse.spawn().expect("pipewire-pulse");
    wait_for(Duration::from_secs(5), "the private pulse socket", || {
        rig.pw.run_dir().join("pulse/native").exists().then_some(())
    });
    std::thread::sleep(Duration::from_millis(300));
    let wav = rig.wav("note", 0, 1200, -20.0);
    let mut paplay = rig
        .pw
        .command("paplay")
        .args(["--device=foreign-sink", s(&wav)])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("paplay");
    wait_for(Duration::from_secs(3), "muted by paplay", || {
        active(&mut c).then_some(())
    });
    let p = c.probe();
    let st = stream_of(&p, |s| s["app"] == json!("paplay"))
        .unwrap_or_else(|| panic!("{p}"))
        .clone();
    println!("pulse stream: {st}");
    assert_eq!(st["pid"], json!(paplay.id()), "its own pid, not {}: {st}", pulse.id());
    assert_eq!(st["verdict"], json!("foreign"), "{st}");
    let _ = paplay.wait();
    wait_for(Duration::from_secs(3), "unmuted", || (!active(&mut c)).then_some(()));
    let _ = pulse.kill();
    let _ = pulse.wait();
}

#[test]
fn automute_absent_without_the_env_gate() {
    let Some(rig) = Rig::start(&[]) else {
        return;
    };
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    let caps = c.ok("hello", json!({}))["capabilities"].clone();
    assert!(!caps.as_array().unwrap().contains(&json!("automute")), "{caps}");
    assert_eq!(c.probe()["env"], json!(false));
}

/// Criterion 10: no bus → no capability, so the backend keeps `AudioMonitor`.
#[test]
fn automute_absent_with_the_bus_down() {
    let Some(rig) = Rig::start(&[
        ("LIASCAPE_PLAYER_AUTOMUTE", "1"),
        ("LIASCAPE_PLAYER_BUS", "off"),
    ]) else {
        return;
    };
    let mut c = rig.client();
    let caps = c.ok("hello", json!({}))["capabilities"].clone();
    assert!(!caps.as_array().unwrap().contains(&json!("automute")), "{caps}");
    assert_eq!(c.probe()["env"], json!(true));
}

// ---------------------------------------------------------------- measurement

/// The observer's last buffer size in frames (the graph quantum).
static QUANTUM_SEEN: AtomicI64 = AtomicI64::new(0);

/// One 1 ms block of a sink monitor: `(CLOCK_MONOTONIC ns, peak dBFS of both channels)`.
type Blocks = Arc<Mutex<Vec<(i64, f32)>>>;

/// Captures `foreign-sink` and `hermetic-sink` monitors on one PipeWire connection (same graph
/// cycles, `pw_buffer.time`), in 1 ms peak blocks.
struct Observer {
    quit: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    foreign: Blocks,
    wallpaper: Blocks,
}

impl Observer {
    fn start(run_dir: &Path) -> Observer {
        let quit = Arc::new(AtomicBool::new(false));
        let foreign: Blocks = Arc::default();
        let wallpaper: Blocks = Arc::default();
        let (q, f, w) = (quit.clone(), foreign.clone(), wallpaper.clone());
        let remote = run_dir.join("pipewire-0").display().to_string();
        let ready = Arc::new(AtomicI64::new(0));
        let r2 = ready.clone();
        let thread = std::thread::spawn(move || observe(&remote, &q, &f, &w, &r2));
        wait_for(Duration::from_secs(5), "the observer's captures flowing", || {
            (ready.load(Ordering::SeqCst) == 2).then_some(())
        });
        Observer {
            quit,
            thread: Some(thread),
            foreign,
            wallpaper,
        }
    }

    fn take(&self) -> (Vec<(i64, f32)>, Vec<(i64, f32)>) {
        (
            std::mem::take(&mut *self.foreign.lock().unwrap()),
            std::mem::take(&mut *self.wallpaper.lock().unwrap()),
        )
    }
}

impl Drop for Observer {
    fn drop(&mut self) {
        self.quit.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn observe(remote: &str, quit: &AtomicBool, f: &Blocks, w: &Blocks, ready: &Arc<AtomicI64>) {
    use pipewire as pw;
    use pw::properties::properties;
    pw::init();
    let ml = pw::main_loop::MainLoopRc::new(None).unwrap();
    let ctx = pw::context::ContextRc::new(&ml, None).unwrap();
    let core = ctx
        .connect_rc(Some(properties! { "remote.name" => remote }))
        .expect("observer: connect to the private PipeWire");
    let mut keep = Vec::new();
    for (target, blocks) in [("foreign-sink", f.clone()), ("hermetic-sink", w.clone())] {
        let stream = pw::stream::StreamRc::new(
            core.clone(),
            &format!("observer.{target}"),
            properties! {
                "media.type" => "Audio",
                "media.category" => "Capture",
                "node.name" => format!("observer.{target}"),
                "target.object" => target,
                "stream.capture.sink" => "true",
                "node.dont-reconnect" => "true",
            },
        )
        .unwrap();
        let rd = ready.clone();
        let mut first = true;
        let l = stream
            .add_local_listener_with_user_data(())
            .process(move |st, _| unsafe {
                let b = st.dequeue_raw_buffer();
                if b.is_null() {
                    return;
                }
                let t0 = (*b).time as i64;
                let sb = (*b).buffer;
                if !sb.is_null() && (*sb).n_datas > 0 {
                    let d = &*(*sb).datas;
                    if !d.data.is_null() && !d.chunk.is_null() {
                        let c = &*d.chunk;
                        let off = c.offset as usize;
                        let size = (c.size as usize).min(d.maxsize as usize - off);
                        let fl = std::slice::from_raw_parts(
                            (d.data as *const u8).add(off) as *const f32,
                            size / 4,
                        );
                        QUANTUM_SEEN.store((size / 8) as i64, Ordering::Relaxed);
                        let mut out = blocks.lock().unwrap();
                        for (k, blk) in fl.chunks(96).enumerate() {
                            let pk = blk.iter().fold(0f32, |m, v| m.max(v.abs()));
                            let db = if pk > 1e-12 { 20.0 * pk.log10() } else { -240.0 };
                            out.push((t0 + k as i64 * 1_000_000, db));
                        }
                        if first {
                            first = false;
                            rd.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
                st.queue_raw_buffer(b);
            })
            .register()
            .unwrap();
        liascape_player::audio::bus::connect_with(
            &stream,
            pw::spa::utils::Direction::Input,
            pw::stream::StreamFlags::AUTOCONNECT
                | pw::stream::StreamFlags::MAP_BUFFERS
                | pw::stream::StreamFlags::RT_PROCESS,
        )
        .unwrap();
        keep.push((stream, l));
    }
    while !quit.load(Ordering::SeqCst) {
        ml.loop_().iterate(pw::loop_::Timeout::Finite(Duration::from_millis(20)));
    }
}

/// Faithful port of the backend's `AudioMonitor` (src/backend/Helpers/AudioMonitor.cs) against
/// the private pipewire-pulse, muting through the player's API like the adapter
/// (`animate <id>.gain.mute` over 30 ms per source).
struct Legacy {
    quit: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Legacy {
    fn start(
        pw: &PrivatePw,
        sock: &Path,
        player_pid: u32,
        mute_ms: u64,
        unmute_ms: u64,
        thr_db: f64,
    ) -> Legacy {
        let quit = Arc::new(AtomicBool::new(false));
        let above = Arc::new(AtomicI64::new(0));
        let mut threads = Vec::new();
        // WatchStreamsAsync
        {
            let (q, a) = (quit.clone(), above.clone());
            let mk = {
                let base = pw.command("true");
                let envs: Vec<(String, String)> = base
                    .get_envs()
                    .filter_map(|(k, v)| {
                        Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned()))
                    })
                    .collect();
                move |bin: &str| {
                    let mut c = Command::new(bin);
                    c.env_clear();
                    for (k, v) in &envs {
                        c.env(k, v);
                    }
                    c.stdin(Stdio::null()).stderr(Stdio::null());
                    c
                }
            };
            threads.push(std::thread::spawn(move || {
                legacy_streams(mk, player_pid, thr_db, &q, &a)
            }));
        }
        // WatchMuteAsync
        {
            let (q, a) = (quit.clone(), above.clone());
            let sock = sock.to_path_buf();
            threads.push(std::thread::spawn(move || {
                let mut c = Client::connect(&sock);
                let need_m = (mute_ms / 20).max(1);
                let need_u = (unmute_ms / 20).max(1);
                let (mut ac, mut bc, mut muted) = (0u64, 0u64, false);
                let ids: Vec<String> = c.ok("state", json!({}))["graph"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter(|(_, n)| n.get("gain_effective_db").is_some())
                    .map(|(id, _)| id.clone())
                    .collect();
                let send = |c: &mut Client, m: bool| {
                    for id in &ids {
                        c.call(
                            "animate",
                            json!({"path": format!("{id}.gain.mute"),
                                   "to": if m { -96.0 } else { 0.0 }, "duration_ms": 30}),
                        );
                    }
                };
                while !q.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                    let has = a.load(Ordering::SeqCst) > 0;
                    if has && !muted {
                        ac += 1;
                        bc = 0;
                        if ac >= need_m {
                            send(&mut c, true);
                            muted = true;
                            ac = 0;
                        }
                    } else if !has && muted {
                        bc += 1;
                        ac = 0;
                        if bc >= need_u {
                            send(&mut c, false);
                            muted = false;
                            bc = 0;
                        }
                    } else {
                        ac = 0;
                        bc = 0;
                    }
                }
                if muted {
                    send(&mut c, false);
                }
            }));
        }
        Legacy { quit, threads }
    }
}

impl Drop for Legacy {
    fn drop(&mut self) {
        self.quit.store(true, Ordering::SeqCst);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

/// `AudioMonitor.ParseStreams` + `LiascapePlayerMedia.IsOwnStream`: (listed, foreign).
fn legacy_parse(out: &str, pid: u32, bus: Option<&str>) -> (BTreeSet<u32>, BTreeSet<u32>) {
    let (mut listed, mut foreign) = (BTreeSet::new(), BTreeSet::new());
    for block in out.split("Sink Input #").filter(|b| !b.is_empty()) {
        let Some(id) = block.lines().next().and_then(|l| l.trim().parse::<u32>().ok()) else {
            continue;
        };
        listed.insert(id);
        let has = |s: &str| block.contains(s);
        if has("application.process.binary = \"mpv\"")
            || has("application.name = \"mpv\"")
            || has("application.process.binary = \"linux-wallpaperengine\"")
            || has("application.name = \"linux-wallpaperengine\"")
        {
            continue;
        }
        let own = block.lines().any(|raw| {
            let t = raw.trim();
            let q = |k: &str| {
                t.strip_prefix(&format!("{k} = \""))
                    .map(|v| v.trim_end_matches('"').to_string())
            };
            q("application.process.id").as_deref() == Some(&pid.to_string())
                || q("node.name").is_some_and(|n| n.starts_with("liascape-player-"))
                || q("target.object").as_deref() == Some("liascape-player-bus")
                || q("application.name").as_deref() == Some("liascape-player")
                || bus.is_some_and(|b| t.strip_prefix("Sink: ").map(str::trim) == Some(b))
        });
        if !own {
            foreign.insert(id);
        }
    }
    (listed, foreign)
}

fn legacy_list(mk: &impl Fn(&str) -> Command, pid: u32) -> (BTreeSet<u32>, BTreeSet<u32>) {
    // the listing and the bus index concurrently, like ListStreamsAsync
    let bus_t = {
        let mut c = mk("pactl");
        c.args(["list", "short", "sinks"]).stdout(Stdio::piped());
        c.spawn().ok()
    };
    let out = mk("pactl")
        .args(["list", "sink-inputs"])
        .stdout(Stdio::piped())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let bus = bus_t
        .and_then(|c| c.wait_with_output().ok())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout).lines().find_map(|l| {
                let cols: Vec<&str> = l.split('\t').collect();
                (cols.len() > 1 && cols[1].trim() == "liascape-player-bus")
                    .then(|| cols[0].trim().to_string())
            })
        });
    legacy_parse(&out, pid, bus.as_deref())
}

fn legacy_streams(
    mk: impl Fn(&str) -> Command + Send + Sync + 'static,
    pid: u32,
    thr_db: f64,
    quit: &Arc<AtomicBool>,
    above: &Arc<AtomicI64>,
) {
    let mk = Arc::new(mk);
    // id → (cancel, foreign)
    let watches: Arc<Mutex<std::collections::BTreeMap<u32, (Arc<AtomicBool>, Arc<AtomicBool>)>>> =
        Arc::default();
    let own: Arc<Mutex<BTreeSet<u32>>> = Arc::default();
    let on_stream = {
        let (mk, watches, own, above) = (mk.clone(), watches.clone(), own.clone(), above.clone());
        move |id: u32, known: Option<bool>| {
            let (cancel, fgn) = {
                let mut w = watches.lock().unwrap();
                if own.lock().unwrap().contains(&id) || w.contains_key(&id) {
                    return;
                }
                let e = (
                    Arc::new(AtomicBool::new(false)),
                    Arc::new(AtomicBool::new(known == Some(true))),
                );
                w.insert(id, e.clone());
                e
            };
            // MonitorStreamAsync
            {
                let (mk, cancel, fgn, above) = (mk.clone(), cancel.clone(), fgn.clone(), above.clone());
                std::thread::spawn(move || {
                    let Ok(mut p) = mk("parec")
                        .args([
                            &format!("--monitor-stream={id}"),
                            "--format=float32le",
                            "--channels=1",
                            "--rate=8000",
                            "--raw",
                            "--latency-msec=10",
                        ])
                        .stdout(Stdio::piped())
                        .spawn()
                    else {
                        return;
                    };
                    let mut out = p.stdout.take().unwrap();
                    let mut buf = [0u8; 640];
                    let mut is_above = false;
                    while !cancel.load(Ordering::SeqCst) {
                        if out.read_exact(&mut buf).is_err() {
                            break;
                        }
                        let peak = buf
                            .chunks_exact(4)
                            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]).abs())
                            .fold(0f32, f32::max);
                        let db = if peak > 1e-9 {
                            20.0 * f64::from(peak).log10()
                        } else {
                            -100.0
                        };
                        let now = fgn.load(Ordering::SeqCst) && db > thr_db;
                        if now && !is_above {
                            above.fetch_add(1, Ordering::SeqCst);
                            is_above = true;
                        } else if !now && is_above {
                            above.fetch_sub(1, Ordering::SeqCst);
                            is_above = false;
                        }
                    }
                    if is_above {
                        above.fetch_sub(1, Ordering::SeqCst);
                    }
                    let _ = p.kill();
                    let _ = p.wait();
                });
            }
            if known == Some(true) {
                return;
            }
            let (mk, watches, own) = (mk.clone(), watches.clone(), own.clone());
            std::thread::spawn(move || {
                for attempt in 0..4 {
                    if attempt > 0 {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    let (listed, foreign) = legacy_list(&*mk, pid);
                    if !listed.contains(&id) {
                        continue;
                    }
                    if foreign.contains(&id) {
                        fgn.store(true, Ordering::SeqCst);
                    } else {
                        watches.lock().unwrap().remove(&id);
                        own.lock().unwrap().insert(id);
                        cancel.store(true, Ordering::SeqCst);
                    }
                    return;
                }
                watches.lock().unwrap().remove(&id);
                cancel.store(true, Ordering::SeqCst);
            });
        }
    };
    let (listed, foreign) = legacy_list(&*mk, pid);
    for id in listed {
        if foreign.contains(&id) {
            on_stream(id, Some(true));
        } else {
            own.lock().unwrap().insert(id);
        }
    }
    let Ok(mut sub) = mk("pactl").arg("subscribe").stdout(Stdio::piped()).spawn() else {
        return;
    };
    let out = BufReader::new(sub.stdout.take().unwrap());
    let q2 = quit.clone();
    let sub_pid = sub.id();
    std::thread::spawn(move || {
        while !q2.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe { libc::kill(sub_pid as i32, libc::SIGTERM) };
    });
    for line in out.lines() {
        let Ok(line) = line else { break };
        if quit.load(Ordering::SeqCst) {
            break;
        }
        if !line.contains("sink-input") {
            continue;
        }
        let id = line
            .rsplit('#')
            .next()
            .and_then(|x| x.trim().parse::<u32>().ok());
        let Some(id) = id else { continue };
        if line.contains("'new'") || line.contains("'change'") {
            on_stream(id, None);
        } else if line.contains("'remove'") {
            own.lock().unwrap().remove(&id);
            if let Some((c, _)) = watches.lock().unwrap().remove(&id) {
                c.store(true, Ordering::SeqCst);
            }
        }
    }
    for (_, (c, _)) in watches.lock().unwrap().iter() {
        c.store(true, Ordering::SeqCst);
    }
    let _ = sub.wait();
}

/// One trial's timing from the observer's blocks (ms, `None` = didn't happen).
#[derive(Debug, Clone, serde::Serialize)]
struct Trial {
    /// first audible foreign sample → the wallpaper at −96 (silent from then on)
    mute_ms: Option<f64>,
    /// last audible foreign sample → the wallpaper audible again
    unmute_ms: Option<f64>,
}

const AUDIBLE_DB: f32 = -70.0;
/// The wallpaper (a −20 dBFS tone) at −96 dB gain reads −116 dBFS.
const SILENT_OUT_DB: f32 = -100.0;

fn analyse(f: &[(i64, f32)], w: &[(i64, f32)]) -> Trial {
    let on = f.iter().find(|(_, db)| *db > AUDIBLE_DB).map(|b| b.0);
    let off = f.iter().rev().find(|(_, db)| *db > AUDIBLE_DB).map(|b| b.0 + 1_000_000);
    let mut mute_ms = None;
    let mut unmute_ms = None;
    if let (Some(on), Some(off)) = (on, off) {
        // the first block after `on` from which the wallpaper stays silent until `off`
        let during: Vec<&(i64, f32)> = w.iter().filter(|b| b.0 >= on && b.0 < off).collect();
        if let Some(last_loud) = during.iter().rposition(|b| b.1 > SILENT_OUT_DB) {
            if last_loud + 1 < during.len() {
                mute_ms = Some((during[last_loud + 1].0 - on) as f64 / 1e6);
            }
        } else if let Some(b) = during.first() {
            mute_ms = Some((b.0 - on) as f64 / 1e6);
        }
        unmute_ms = w
            .iter()
            .find(|b| b.0 >= off && b.1 > SILENT_OUT_DB)
            .map(|b| (b.0 - off) as f64 / 1e6);
    }
    Trial { mute_ms, unmute_ms }
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return f64::NAN;
    }
    let i = ((v.len() - 1) as f64 * p).round() as usize;
    v[i]
}

/// `LIASCAPE_AUTOMUTE_ENGINE` = `signal` | `audiomonitor`, `LIASCAPE_AUTOMUTE_TRIALS` (30),
/// `LIASCAPE_AUTOMUTE_DELAYS` (`0,500,2000`: mute = unmute delay per set),
/// `LIASCAPE_AUTOMUTE_SCENARIO` = `onset` (an existing stream starts sounding: 400 ms of
/// silence first) | `new` (a new stream, audible from its first sample),
/// `LIASCAPE_AUTOMUTE_QUANTUM` (forces the graph quantum, frames). Prints `MEASURE {json}`.
#[test]
#[ignore]
fn measure_automute_latency() {
    let engine = std::env::var("LIASCAPE_AUTOMUTE_ENGINE").unwrap_or("signal".into());
    let trials: usize = std::env::var("LIASCAPE_AUTOMUTE_TRIALS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let delays: Vec<u64> = std::env::var("LIASCAPE_AUTOMUTE_DELAYS")
        .unwrap_or("0,500,2000".into())
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let scenario = std::env::var("LIASCAPE_AUTOMUTE_SCENARIO").unwrap_or("onset".into());
    let signal = engine == "signal";
    let env: &[(&str, &str)] = if signal {
        &[("LIASCAPE_PLAYER_AUTOMUTE", "1")]
    } else {
        &[]
    };
    let Some(mut rig) = Rig::start(env) else {
        return;
    };
    if let Ok(q) = std::env::var("LIASCAPE_AUTOMUTE_QUANTUM") {
        let _ = pw_cmd(&rig.pw, "pw-metadata", &["-n", "settings", "0", "clock.force-quantum", &q]);
    }
    let mut pulse = None;
    if !signal {
        let mut c = rig.pw.command("pipewire-pulse");
        c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        pulse = Some(c.spawn().expect("pipewire-pulse"));
        let sock = rig.pw.run_dir().join("pulse/native");
        wait_for(Duration::from_secs(5), "the private pulse socket", || {
            sock.exists().then_some(())
        });
        std::thread::sleep(Duration::from_millis(300));
    }
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    let obs = Observer::start(&rig.pw.run_dir());
    let lead = if scenario == "new" { 0 } else { 400 };
    for &d in &delays {
        let tone_ms = d as u32 + 700;
        let wav = rig.wav(&format!("m{d}"), lead, tone_ms, -20.0);
        let legacy = if signal {
            automute_on(&mut c, d as f64, d as f64);
            None
        } else {
            Some(Legacy::start(&rig.pw, &rig.sock, rig.pid(), d, d, -70.0))
        };
        std::thread::sleep(Duration::from_millis(500));
        let mut rows = Vec::new();
        for i in 0..trials {
            obs.take();
            rig.play(&wav, "", &[]);
            let settle = Duration::from_millis(lead as u64 + tone_ms as u64 + d.max(50) + 600);
            std::thread::sleep(settle);
            rig.stop_foreign();
            std::thread::sleep(Duration::from_millis(150));
            let (f, w) = obs.take();
            let t = analyse(&f, &w);
            println!("trial {engine} {scenario} d={d} #{i}: {t:?}");
            if signal && std::env::var("LIASCAPE_AUTOMUTE_TIMELINE").is_ok() {
                // where this trial's time went, on the player's `t_mono_ms` clock: the tone at
                // the sink → the stream in the registry → its capture's first audible data →
                // the ramp starting
                let now_ms = c.probe()["now_ms"].as_f64().unwrap();
                let off = liascape_player::audio::meter::mono_ns() as f64 / 1e6 - now_ms;
                let on = f.iter().find(|(_, db)| *db > AUDIBLE_DB).map(|b| b.0 as f64 / 1e6 - off);
                if let Some(on) = on {
                    let seen = c
                        .events("audio.visualiser.stream")
                        .iter()
                        .rev()
                        .find_map(|e| e["t_mono_ms"].as_f64())
                        .unwrap_or(f64::NAN);
                    let m = c.events("automute.muted");
                    let m = m.last().cloned().unwrap_or_default();
                    let at = |k: &str| m[k].as_f64().unwrap_or(f64::NAN);
                    println!(
                        "TIMELINE #{i}: mute {:?} | registry +{:.1} | first captured data +{:.1} | ramp +{:.1} ms",
                        t.mute_ms,
                        seen - on,
                        at("run_start_ms") - on,
                        at("ramp_start_ms") - on
                    );
                }
            }
            if t.mute_ms.is_none() || t.unmute_ms.is_none() {
                // why: did the tone reach the sink, did the wallpaper keep playing, what did
                // the player decide
                let quant = |b: &[(i64, f32)]| {
                    let loudest = b.iter().map(|x| x.1).fold(f32::MIN, f32::max);
                    let span = b.last().map_or(0, |l| l.0) - b.first().map_or(0, |x| x.0);
                    (b.len(), loudest, span as f64 / 1e6)
                };
                let wall_silent = w.iter().filter(|x| x.1 <= SILENT_OUT_DB).count();
                println!(
                    "MISS #{i}: foreign (n, max_db, span_ms) {:?}, wallpaper {:?}, wallpaper silent blocks {wall_silent}",
                    quant(&f),
                    quant(&w)
                );
                if signal {
                    let p = c.probe();
                    println!("MISS #{i}: active {} streams {}", p["active"], p["streams"]);
                    let evs = c.events("automute.");
                    println!(
                        "MISS #{i}: last events {}",
                        json!(evs.iter().rev().take(4).collect::<Vec<_>>())
                    );
                }
            }
            rows.push(t);
        }
        drop(legacy);
        if signal {
            c.set("player.automute", json!(false));
        }
        let mut m: Vec<f64> = rows.iter().filter_map(|r| r.mute_ms).collect();
        let mut u: Vec<f64> = rows.iter().filter_map(|r| r.unmute_ms).collect();
        let res = json!({
            "engine": engine, "scenario": scenario, "delay_ms": d, "trials": trials,
            "quantum": std::env::var("LIASCAPE_AUTOMUTE_QUANTUM").ok(),
            "quantum_frames_seen": QUANTUM_SEEN.load(Ordering::Relaxed),
            "mute_n": m.len(), "unmute_n": u.len(),
            "mute_p50": pct(&mut m, 0.5), "mute_p95": pct(&mut m, 0.95),
            "mute_min": pct(&mut m, 0.0), "mute_max": pct(&mut m, 1.0),
            "mute_overhead_p50": pct(&mut m, 0.5) - d as f64,
            "mute_overhead_p95": pct(&mut m, 0.95) - d as f64,
            "unmute_p50": pct(&mut u, 0.5), "unmute_p95": pct(&mut u, 0.95),
            "unmute_min": pct(&mut u, 0.0), "unmute_max": pct(&mut u, 1.0),
            "unmute_overhead_p50": pct(&mut u, 0.5) - d as f64,
            "unmute_overhead_p95": pct(&mut u, 0.95) - d as f64,
            "rows": rows,
        });
        println!("MEASURE {res}");
    }
    if signal {
        let evs = c.events("automute.");
        println!("SIGNAL_EVENTS {}", json!(evs.iter().rev().take(6).collect::<Vec<_>>()));
    }
    drop(obs);
    if let Some(mut p) = pulse {
        let _ = p.kill();
        let _ = p.wait();
    }
}

#[test]
fn legacy_parse_matches_the_backend() {
    let out = "Sink Input #12\n\tSink: 3\n\tProperties:\n\t\tapplication.name = \"paplay\"\n\t\tapplication.process.id = \"500\"\nSink Input #13\n\tSink: 7\n\tProperties:\n\t\tapplication.name = \"liascape-player\"\nSink Input #14\n\tSink: 7\n\tProperties:\n\t\tapplication.name = \"x\"\nSink Input #15\n\tSink: 3\n\tProperties:\n\t\tapplication.name = \"mpv\"\n";
    let (l, f) = legacy_parse(out, 100, Some("7"));
    assert_eq!(l, [12, 13, 14, 15].into());
    assert_eq!(f, [12].into(), "own by name / bus sink; mpv by name (the old bug)");
}

/// utime + stime of `pid` in clock ticks (`/proc/<pid>/stat` fields 14 + 15).
fn cpu_ticks(pid: u32) -> u64 {
    let Ok(st) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return 0;
    };
    let Some(close) = st.rfind(')') else { return 0 };
    let f: Vec<&str> = st[close + 2..].split_whitespace().collect();
    f.get(11).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
        + f.get(12).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
}

/// Criterion 9: the player's added CPU with 5 foreign streams (auto-mute on vs off) against
/// today's 5 `parec` processes. Prints `CPU {json}` (ms of CPU per second of wall time).
#[test]
#[ignore]
fn measure_automute_cpu() {
    let Some(mut rig) = Rig::start(&[("LIASCAPE_PLAYER_AUTOMUTE", "1")]) else {
        return;
    };
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    let secs = 10.0;
    let mut c = rig.client();
    wallpaper(&mut c, RED_10S, "am_red_10s");
    let tone = rig.wav("cpu-tone", 0, 60_000, -20.0);
    for _ in 0..5 {
        rig.play(&tone, "", &[]);
    }
    std::thread::sleep(Duration::from_millis(1500));
    let pid = rig.pid();
    let sample = |what: &str| {
        let t0 = cpu_ticks(pid);
        std::thread::sleep(Duration::from_secs_f64(secs));
        let ms = (cpu_ticks(pid) - t0) as f64 / hz * 1000.0 / secs;
        println!("{what}: {ms:.2} ms CPU/s");
        ms
    };
    let off = sample("player, auto-mute off");
    c.set("player.automute_delay_ms", json!(600_000.0));
    c.set("player.automute", json!(true));
    std::thread::sleep(Duration::from_millis(1500));
    let on = sample("player, auto-mute on (5 streams metered)");
    c.set("player.automute", json!(false));
    // today: one parec per sink-input on a private pipewire-pulse
    let mut pulse = rig.pw.command("pipewire-pulse");
    pulse.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut pulse = pulse.spawn().expect("pipewire-pulse");
    wait_for(Duration::from_secs(5), "pulse", || {
        rig.pw.run_dir().join("pulse/native").exists().then_some(())
    });
    std::thread::sleep(Duration::from_millis(300));
    let pa_idle0 = cpu_ticks(pulse.id());
    std::thread::sleep(Duration::from_secs_f64(secs));
    let pulse_idle_ms = (cpu_ticks(pulse.id()) - pa_idle0) as f64 / hz * 1000.0 / secs;
    let list = pw_cmd(&rig.pw, "pactl", &["list", "sink-inputs"]);
    let (_, foreign) = legacy_parse(&String::from_utf8_lossy(&list.stdout), pid, None);
    let mut parecs: Vec<Child> = foreign
        .iter()
        .map(|id| {
            rig.pw
                .command("parec")
                .args([
                    &format!("--monitor-stream={id}"),
                    "--format=float32le",
                    "--channels=1",
                    "--rate=8000",
                    "--raw",
                    "--latency-msec=10",
                ])
                .stdout(Stdio::null())
                .stdin(Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    std::thread::sleep(Duration::from_millis(1000));
    let pids: Vec<u32> = parecs.iter().map(Child::id).collect();
    let t0: u64 = pids.iter().map(|p| cpu_ticks(*p)).sum();
    let pa0 = cpu_ticks(pulse.id());
    std::thread::sleep(Duration::from_secs_f64(secs));
    let parec_ms = (pids.iter().map(|p| cpu_ticks(*p)).sum::<u64>() - t0) as f64 / hz * 1000.0 / secs;
    let pulse_ms = (cpu_ticks(pulse.id()) - pa0) as f64 / hz * 1000.0 / secs;
    println!(
        "CPU {}",
        json!({"player_off_ms_per_s": off, "player_on_ms_per_s": on,
               "added_ms_per_s": on - off, "parecs": pids.len(),
               "parec_total_ms_per_s": parec_ms, "pipewire_pulse_ms_per_s": pulse_ms, "pipewire_pulse_idle_ms_per_s": pulse_idle_ms,
               "legacy_added_ms_per_s": parec_ms + pulse_ms - pulse_idle_ms,
               "clk_tck": hz, "window_s": secs})
    );
    for p in parecs.iter_mut() {
        let _ = p.kill();
        let _ = p.wait();
    }
    let _ = pulse.kill();
    let _ = pulse.wait();
}
