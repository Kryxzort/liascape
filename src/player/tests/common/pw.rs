//! A **private, hermetic** PipeWire + WirePlumber for tests that need real audio flow (I7;
//! moved here from `tests/api.rs` by Phase 2 Task 6 so every target can use it): their own
//! runtime/config/state dirs, no D-Bus, WirePlumber's `policy` profile — no ALSA/Bluetooth/
//! V4L2 monitors, so no real device is ever touched; one null sink (`hermetic-sink`) as the
//! only output. The owner's PipeWire is never involved: `PIPEWIRE_RUNTIME_DIR` points every
//! client of a test (the bus, mpv's AO, a scene worker's stream) at the private socket.
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
    /// a stream to a sink (a boot where WirePlumber isn't up yet).
    pub fn start_daemon(&mut self) {
        let conf = self.dir.join("pw.conf");
        let pw = self.spawn("pipewire", &["-c", conf.to_str().unwrap()]);
        let t = Instant::now();
        while !self.run_dir().join("pipewire-0").exists() {
            assert!(
                t.elapsed() < Duration::from_secs(5),
                "timed out waiting for the private pipewire socket"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        self.procs.push(pw);
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

    /// `pw-dump` of the private instance (`[]` when it can't be read).
    pub fn dump(&self) -> serde_json::Value {
        let out = self.command("pw-dump").output().expect("pw-dump");
        serde_json::from_slice(&out.stdout).unwrap_or(serde_json::json!([]))
    }
}

impl Drop for PrivatePw {
    fn drop(&mut self) {
        self.kill();
    }
}
