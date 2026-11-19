//! A **private, hermetic** PipeWire + WirePlumber for tests that need real audio flow (shared
//! by every test target): their own
//! runtime/config/state dirs, no session D-Bus, WirePlumber's `policy` profile — no ALSA/Bluetooth/
//! V4L2 monitors, so no real device is ever touched; one null sink (`hermetic-sink`) as the
//! only output. The owner's PipeWire is never involved: `PIPEWIRE_RUNTIME_DIR` points every
//! client of a test (the bus, mpv's AO, a scene worker's stream) at the private socket.
//!
//! **The daemon runs its graph real-time, like a desktop session's** (`libpipewire-module-rt` via rtkit
//! on the system bus — hence `support.dbus = true`; the session bus stays unreachable; the same
//! config as `tests/onmachine/scenes.sh`). Its data thread drives the graph (the null sink's
//! timer), and this machine's `client.conf.d/99-lowlatency.conf` asks every client stream for
//! `node.latency = 64/48000`, so a cycle is 1.33 ms. Without RT that thread runs SCHED_OTHER at
//! the test's nice level and loses whole cycles whenever it wakes late — the driver skipping a
//! period (`pw-profiler`: position +128, `Dummy-Driver` and the bus playback xrun), each one
//! 64 frames of exact silence at the sink, mostly as a stream joins or leaves the graph: "lost
//! cycles" in the recording tests (`tests/api.rs::*_never_skips_bus_cycles`) that aren't the
//! player's (measured: `mpv_source_teardown_never_skips_bus_cycles` failed 5 of 26 runs quiet
//! and every run under CPU load without RT; 0 of 20 quiet, 0–1 loaded with it). rtkit can refuse
//! (a burst limit the suite's own streams reach, [`RT_WAIT`]): a refused daemon is started again,
//! and the recording tests fail rather than record on a graph that isn't real-time.
#![allow(dead_code)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct PrivatePw {
    dir: PathBuf,
    procs: Vec<Child>,
}

fn die_with_parent(c: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        c.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
}

impl PrivatePw {
    /// The `pipewire` and `wireplumber` binaries are there (else the caller prints SKIP).
    pub fn available() -> bool {
        ["pipewire", "wireplumber"].iter().all(|b| {
            Command::new(b)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
    }

    pub fn new(dir: PathBuf) -> PrivatePw {
        for d in ["run", "state", "cfg/wireplumber/wireplumber.conf.d"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            dir.join("pw.conf"),
            r#"context.properties = { core.daemon = true core.name = pipewire-0
  default.clock.rate = 48000 support.dbus = true log.level = 1 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-rt args = { nice.level = -11 rt.prio = 88 } flags = [ ifexists nofail ] }
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

    pub fn run_dir(&self) -> PathBuf {
        self.dir.join("run")
    }

    /// A command against the private instance only (`pw-cat`, `pw-dump`, …).
    pub fn spawn(&self, bin: &str, args: &[&str]) -> Child {
        let mut c = self.command(bin);
        c.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c.spawn().expect("spawn private pipewire")
    }

    /// `bin` with only the private instance's environment (dies with the test).
    pub fn command(&self, bin: &str) -> Command {
        let mut c = Command::new(bin);
        die_with_parent(&mut c);
        c.env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.dir)
            .env("XDG_RUNTIME_DIR", self.run_dir())
            .env("PIPEWIRE_RUNTIME_DIR", self.run_dir())
            .env("XDG_CONFIG_HOME", self.dir.join("cfg"))
            .env("XDG_STATE_HOME", self.dir.join("state"))
            .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent");
        c
    }

    pub fn start(&mut self) {
        self.start_daemon();
        self.start_session_manager();
    }

    /// Only the `pipewire` daemon, no session manager: clients connect, but nothing links
    /// a stream to a sink (a boot where WirePlumber isn't up yet). Its graph thread is
    /// real-time when this returns, unless rtkit kept refusing for [`RT_WAIT`] (printed;
    /// tests that need it check [`PrivatePw::graph_policy`]): a refused daemon is started
    /// again, before any client connects (see [`rt_refused_retry`]).
    pub fn start_daemon(&mut self) {
        let conf = self.dir.join("pw.conf");
        let t = Instant::now();
        loop {
            let pw = self.spawn("pipewire", &["-c", conf.to_str().unwrap()]);
            let sock = self.run_dir().join("pipewire-0");
            let t_sock = Instant::now();
            while !sock.exists() {
                assert!(
                    t_sock.elapsed() < Duration::from_secs(5),
                    "timed out waiting for the private pipewire socket"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            self.procs.push(pw);
            let policy = settled_policy(|| self.graph_policy());
            if !rt_refused_retry("the private pipewire's graph thread", policy, t) {
                return;
            }
            let mut pw = self.procs.pop().unwrap();
            let _ = pw.kill();
            let _ = pw.wait();
            let _ = std::fs::remove_file(&sock);
        }
    }

    /// WirePlumber on the running daemon ([`PrivatePw::start_daemon`] first).
    pub fn start_session_manager(&mut self) {
        let wp = self.spawn("wireplumber", &["-p", "policy"]);
        self.procs.push(wp);
        std::thread::sleep(Duration::from_millis(700));
    }

    /// The audio server "restarts": both daemons die at once.
    pub fn kill(&mut self) {
        for mut p in self.procs.drain(..) {
            let _ = p.kill();
            let _ = p.wait();
        }
    }

    /// The daemon's graph thread's (`data-loop.0`) scheduling policy: `other` | `fifo` | `rr`
    /// (the names the bus probe's `meter.callback_policy` uses), `None` while it can't be read.
    pub fn graph_policy(&self) -> Option<&'static str> {
        let pid = self.procs.first()?.id();
        for t in std::fs::read_dir(format!("/proc/{pid}/task")).ok()? {
            let p = t.ok()?.path();
            if std::fs::read_to_string(p.join("comm")).ok()?.trim() != "data-loop.0" {
                continue;
            }
            return stat_policy(&p);
        }
        None
    }

    /// `pw-dump` of the private instance (`[]` when it can't be read).
    pub fn dump(&self) -> serde_json::Value {
        let out = self.command("pw-dump").output().expect("pw-dump");
        serde_json::from_slice(&out.stdout).unwrap_or(serde_json::json!([]))
    }
}

/// How long a test keeps asking for a real-time graph thread. rtkit refuses every request of
/// a user past 25 in 20 s (`actions-per-burst-max` / `actions-burst-sec`), and the suite itself
/// makes that many: every graph client (each mpv AO, each scene worker's stream, `pw-record`)
/// asks once, so a test that switches 20 times leaves the next one's daemon and player refused.
pub const RT_WAIT: Duration = Duration::from_secs(45);

/// A graph thread's policy once it has one: `module-rt` sets it through rtkit (a D-Bus round
/// trip) just after the thread starts, so `other` is only final after a moment.
pub fn settled_policy(mut read: impl FnMut() -> Option<&'static str>) -> Option<&'static str> {
    let t = Instant::now();
    loop {
        let p = read();
        if matches!(p, Some("rr" | "fifo")) || t.elapsed() > Duration::from_secs(2) {
            return p;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Whether to start `what` again for a real-time thread: it runs `other` (rtkit refused it), rtkit
/// runs on this machine (without it nothing would ever change), and `since` is under [`RT_WAIT`]
/// ago. Waits a moment first (the burst window frees up by itself). Prints each refusal.
pub fn rt_refused_retry(what: &str, policy: Option<&'static str>, since: Instant) -> bool {
    if policy != Some("other") || !rtkit_running() {
        return false;
    }
    if since.elapsed() >= RT_WAIT {
        println!("{what} is still not real-time after {RT_WAIT:?} (rtkit refusing): going on without");
        return false;
    }
    println!(
        "{what} runs SCHED_OTHER (rtkit refused it, {:.1} s in): starting it again",
        since.elapsed().as_secs_f64()
    );
    std::thread::sleep(Duration::from_secs(2));
    true
}

/// A thread's scheduling policy from its `/proc/<pid>/task/<tid>` dir: `other` | `fifo` | `rr`.
fn stat_policy(task: &std::path::Path) -> Option<&'static str> {
    let stat = std::fs::read_to_string(task.join("stat")).ok()?;
    // field 41 (`policy`), counted from the first field after the `(comm)`, which is field 3
    let policy: i32 = stat.rsplit_once(')')?.1.split_whitespace().nth(38)?.parse().ok()?;
    Some(match policy & !libc::SCHED_RESET_ON_FORK {
        0 => "other",
        1 => "fifo",
        2 => "rr",
        _ => "unknown",
    })
}

/// Every PipeWire graph thread of `pid` (`data-loop.*`, one per PipeWire context: the bus's,
/// each mpv AO's) with its policy, read off `/proc` — not what the process says about itself.
pub fn data_loop_policies(pid: u32) -> Vec<(u32, &'static str)> {
    let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    dir.flatten()
        .filter(|t| {
            std::fs::read_to_string(t.path().join("comm"))
                .is_ok_and(|c| c.trim().starts_with("data-loop"))
        })
        .filter_map(|t| {
            let tid = t.file_name().to_str()?.parse().ok()?;
            Some((tid, stat_policy(&t.path())?))
        })
        .collect()
}

/// This user's rtkit burst budget used up on purpose, the way a session login or the suite's
/// own streams do: `MakeThreadHighPriorityWithPID` (nice 0 on the flooding thread itself — a
/// no-op for the system) 30 times a second until [`RtkitFlood::stop`] or `max`. rtkit then
/// refuses every real-time request of the user (the desktop's too) until its 20 s window ends:
/// keep floods short and few.
pub struct RtkitFlood {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    refused: std::sync::Arc<std::sync::atomic::AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RtkitFlood {
    /// `None` without rtkit or a system bus (nothing to flood).
    pub fn start(max: Duration) -> Option<RtkitFlood> {
        use std::sync::atomic::Ordering;
        if !rtkit_running() {
            return None;
        }
        let conn = zbus::blocking::Connection::system().ok()?;
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let refused = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let (st, rf) = (stop.clone(), refused.clone());
        let thread = std::thread::spawn(move || {
            let pid = u64::from(std::process::id());
            // SAFETY: plain syscall.
            let tid = unsafe { libc::gettid() } as u64;
            let t = Instant::now();
            while !st.load(Ordering::SeqCst) && t.elapsed() < max {
                let r = conn.call_method(
                    Some("org.freedesktop.RealtimeKit1"),
                    "/org/freedesktop/RealtimeKit1",
                    Some("org.freedesktop.RealtimeKit1"),
                    "MakeThreadHighPriorityWithPID",
                    &(pid, tid, 0i32),
                );
                if r.is_err() {
                    rf.fetch_add(1, Ordering::SeqCst);
                }
                std::thread::sleep(Duration::from_millis(33));
            }
        });
        Some(RtkitFlood {
            stop,
            refused,
            thread: Some(thread),
        })
    }

    /// Requests rtkit refused so far (the budget is used up from the first one).
    pub fn refused(&self) -> u64 {
        self.refused.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for RtkitFlood {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn rtkit_running() -> bool {
    std::fs::read_dir("/proc").into_iter().flatten().flatten().any(|e| {
        std::fs::read_to_string(e.path().join("comm")).is_ok_and(|c| c.trim() == "rtkit-daemon")
    })
}

impl Drop for PrivatePw {
    fn drop(&mut self) {
        self.kill();
    }
}
