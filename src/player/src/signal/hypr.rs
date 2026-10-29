//! The Hyprland cover source (Task 6, designer call 9): a thread (`lia-cover`) that listens on
//! `.socket2.sock` and, on every event that can change what is on screen, re-reads
//! `j/monitors` + `j/clients` in one `[[BATCH]]` request on `.socket.sock` and publishes
//! [`covered::hypr_cover`] of them to the [`Feed`]. Read-only: it never sends a dispatch.
//!
//! - **Why re-query:** the `fullscreen>>0|1` event names no window (and an app may send several
//!   enters), so the state is always read back, never inferred from events.
//! - **Focus is not visibility:** `activewindow`/`activewindowv2` also fire on every title change
//!   of the focused window (a terminal's spinner: ~1/s, measured 2026-10-30), and focus alone never
//!   changes what is on screen. Only `activewindowv2` with a *new* address triggers a re-read
//!   ([`Relevance`]); `activewindow` (v1, the same change) never does.
//! - **Coalescing:** a burst of events (a workspace switch emits several) is one query,
//!   [`COALESCE`] after the first; one confirm query follows [`CONFIRM`] later, in case Hyprland
//!   reported the event before its state settled.
//! - **The socket dir:** `$XDG_RUNTIME_DIR/hypr/<sig>/`, else `/run/user/<uid>/hypr/<sig>/`
//!   (a player run with a private `XDG_RUNTIME_DIR` still finds the session's), else
//!   `/tmp/hypr/<sig>/` (Hyprland < 0.40). Re-resolved on every reconnect.
//! - **Failure:** no socket / a dead connection → the feed reports `ok: false` with the reason
//!   and no cover (never a false pause); it retries every [`RETRY`].

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::Feed;
use super::covered::{self, CoverMap};

const COALESCE: Duration = Duration::from_millis(30);
const CONFIRM: Duration = Duration::from_millis(300);
const RETRY: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(100);
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// socket2 events that can change which window is on screen, or how.
pub const EVENTS: &[&str] = &[
    "fullscreen",
    "workspace",
    "workspacev2",
    "focusedmon",
    "focusedmonv2",
    "activespecial",
    "activespecialv2",
    "moveworkspace",
    "moveworkspacev2",
    "openwindow",
    "closewindow",
    "movewindow",
    "movewindowv2",
    "changefloatingmode",
    "minimized",
    "monitoradded",
    "monitoraddedv2",
    "monitorremoved",
    "monitorremovedv2",
    "configreloaded",
];

/// Whether a socket2 line (`EVENT>>DATA`) is one of [`EVENTS`].
pub fn relevant(line: &str) -> bool {
    let name = line.split_once(">>").map(|(n, _)| n).unwrap_or(line.trim());
    EVENTS.contains(&name)
}

/// [`relevant`] plus focus changes: `activewindowv2>>ADDR` counts only when the address differs
/// from the last one seen (a title change repeats it).
#[derive(Debug, Default)]
pub struct Relevance {
    active: Option<String>,
}

impl Relevance {
    pub fn check(&mut self, line: &str) -> bool {
        match line.split_once(">>") {
            Some(("activewindowv2", addr)) => {
                let changed = self.active.as_deref() != Some(addr);
                if changed {
                    self.active = Some(addr.to_string());
                }
                changed
            }
            _ => relevant(line),
        }
    }
}

/// The candidate socket dirs for instance `sig`, in order.
pub fn dirs(sig: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR").filter(|s| !s.is_empty()) {
        out.push(PathBuf::from(rt).join("hypr").join(sig));
    }
    // SAFETY: getuid never fails.
    let uid = unsafe { libc::getuid() };
    let run = PathBuf::from(format!("/run/user/{uid}/hypr/{sig}"));
    if !out.contains(&run) {
        out.push(run);
    }
    out.push(PathBuf::from("/tmp/hypr").join(sig));
    out
}

fn pick(dirs: &[PathBuf]) -> Result<&Path, String> {
    dirs.iter()
        .map(PathBuf::as_path)
        .find(|d| d.join(".socket2.sock").exists())
        .ok_or_else(|| {
            format!(
                "no Hyprland IPC socket (.socket2.sock) in {}",
                dirs.iter()
                    .map(|d| d.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

/// One read-only request on `.socket.sock` → the raw reply.
pub fn request(dir: &Path, req: &str) -> Result<String, String> {
    let sock = dir.join(".socket.sock");
    let mut s = UnixStream::connect(&sock).map_err(|e| format!("{}: {e}", sock.display()))?;
    s.set_read_timeout(Some(QUERY_TIMEOUT)).ok();
    s.set_write_timeout(Some(QUERY_TIMEOUT)).ok();
    s.write_all(req.as_bytes())
        .map_err(|e| format!("{}: {e}", sock.display()))?;
    let mut out = String::new();
    s.read_to_string(&mut out)
        .map_err(|e| format!("{}: {e}", sock.display()))?;
    Ok(out)
}

/// `j/monitors` + `j/clients` (one batch; the replies are concatenated, separated by blank
/// lines) → the cover per monitor.
pub fn query(dir: &Path) -> Result<CoverMap, String> {
    let raw = request(dir, "[[BATCH]]j/monitors;j/clients")?;
    let vals: Vec<Value> = serde_json::Deserializer::from_str(&raw)
        .into_iter::<Value>()
        .collect::<Result<_, _>>()
        .map_err(|e| format!("j/monitors;j/clients: not JSON ({e})"))?;
    let [monitors, clients] = vals.as_slice() else {
        return Err(format!(
            "j/monitors;j/clients: {} replies, expected 2",
            vals.len()
        ));
    };
    let (m, c) = covered::hypr_parse(monitors, clients);
    Ok(covered::hypr_cover(&m, &c))
}

/// Start the source on its own thread. `stop` ends it (checked every [`POLL`]).
pub fn spawn(dirs: Vec<PathBuf>, feed: Feed, stop: Arc<AtomicBool>) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("lia-cover".into())
        .spawn(move || run(&dirs, &feed, &stop))
        .map(|_| ())
}

fn sleep_unless(stop: &AtomicBool, d: Duration) {
    let end = Instant::now() + d;
    while !stop.load(Ordering::Relaxed) && Instant::now() < end {
        std::thread::sleep(POLL.min(end.saturating_duration_since(Instant::now())));
    }
}

fn run(dirs: &[PathBuf], feed: &Feed, stop: &AtomicBool) {
    while !stop.load(Ordering::Relaxed) {
        let dir = match pick(dirs) {
            Ok(d) => d.to_path_buf(),
            Err(e) => {
                feed.fail(e);
                sleep_unless(stop, RETRY);
                continue;
            }
        };
        let sock = dir.join(".socket2.sock");
        let s = match UnixStream::connect(&sock) {
            Ok(s) => s,
            Err(e) => {
                feed.fail(format!("{}: {e}", sock.display()));
                sleep_unless(stop, RETRY);
                continue;
            }
        };
        let _ = s.set_read_timeout(Some(POLL));
        if let Err(e) = listen(&dir, s, feed, stop) {
            feed.fail(e);
            sleep_unless(stop, RETRY);
        }
    }
}

/// One socket2 connection: query at once, then on each relevant event (coalesced + confirmed).
/// Returns why the connection ended.
fn listen(dir: &Path, s: UnixStream, feed: &Feed, stop: &AtomicBool) -> Result<(), String> {
    let mut rd = BufReader::new(s);
    let mut due: Option<Instant> = Some(Instant::now());
    let mut confirm: Option<Instant> = None;
    let mut line = String::new();
    let mut rel = Relevance::default();
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let now = Instant::now();
        let fire = due.is_some_and(|d| now >= d) || confirm.is_some_and(|d| now >= d);
        if fire {
            if due.take().is_some() {
                confirm = Some(now + CONFIRM);
            } else {
                confirm = None;
            }
            match query(dir) {
                Ok(m) => feed.publish(m),
                Err(e) => feed.fail(e),
            }
        }
        match rd.read_line(&mut line) {
            Ok(0) => return Err("Hyprland closed .socket2.sock".into()),
            Ok(_) if line.ends_with('\n') => {
                feed.count_event();
                if rel.check(line.trim_end()) && due.is_none() {
                    due = Some(Instant::now() + COALESCE);
                }
                line.clear();
            }
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(format!(".socket2.sock: {e}")),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::Mutex;

    /// A fake Hyprland instance dir: `.socket.sock` answers every request with `reply`,
    /// `.socket2.sock` keeps each client and [`FakeHypr::emit`] writes events to them.
    pub(crate) struct FakeHypr {
        pub dir: PathBuf,
        pub reply: Arc<Mutex<String>>,
        pub requests: Arc<Mutex<Vec<String>>>,
        clients2: Arc<Mutex<Vec<UnixStream>>>,
    }

    pub(crate) fn batch(monitors: &str, clients: &str) -> String {
        format!("{monitors}\n\n\n{clients}")
    }

    pub(crate) const MONS: &str = r#"[{"id":0,"name":"DP-1","activeWorkspace":{"id":1,"name":"1"},"specialWorkspace":{"id":0,"name":""},"focused":false,"disabled":false},
        {"id":1,"name":"DP-2","activeWorkspace":{"id":6,"name":"6"},"specialWorkspace":{"id":0,"name":""},"focused":true,"disabled":false}]"#;

    impl FakeHypr {
        pub(crate) fn new(dir: PathBuf) -> FakeHypr {
            std::fs::create_dir_all(&dir).unwrap();
            let reply = Arc::new(Mutex::new(batch(MONS, "[]")));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let l1 = UnixListener::bind(dir.join(".socket.sock")).unwrap();
            let (r, q) = (reply.clone(), requests.clone());
            std::thread::spawn(move || {
                for c in l1.incoming() {
                    let Ok(mut c) = c else { return };
                    let mut buf = [0u8; 4096];
                    let n = c.read(&mut buf).unwrap_or(0);
                    q.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&buf[..n]).into());
                    let _ = c.write_all(r.lock().unwrap().as_bytes());
                }
            });
            let l2 = UnixListener::bind(dir.join(".socket2.sock")).unwrap();
            let clients2 = Arc::new(Mutex::new(Vec::new()));
            let c2 = clients2.clone();
            std::thread::spawn(move || {
                for c in l2.incoming() {
                    let Ok(c) = c else { return };
                    c2.lock().unwrap().push(c);
                }
            });
            FakeHypr {
                dir,
                reply,
                requests,
                clients2,
            }
        }

        pub(crate) fn set(&self, clients: &str) {
            *self.reply.lock().unwrap() = batch(MONS, clients);
        }

        pub(crate) fn emit(&self, line: &str) {
            for c in self.clients2.lock().unwrap().iter_mut() {
                let _ = c.write_all(format!("{line}\n").as_bytes());
            }
        }

        pub(crate) fn connected(&self) -> usize {
            self.clients2.lock().unwrap().len()
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lia-hypr-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn wait(what: &str, f: impl Fn() -> bool) {
        let t = Instant::now();
        while !f() {
            assert!(
                t.elapsed() < Duration::from_secs(5),
                "timed out waiting for {what}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn relevant_events() {
        assert!(relevant("fullscreen>>1"));
        assert!(relevant("workspacev2>>6,6"));
        assert!(relevant("monitorremoved>>DP-2"));
        assert!(!relevant("windowtitlev2>>55d0,foo"));
        assert!(!relevant("openlayer>>dms:bar"));
        // Focus: a new address counts once; title-change repeats and v1 never do.
        let mut r = Relevance::default();
        assert!(r.check("activewindowv2>>55d0"));
        assert!(!r.check("activewindow>>kitty,◑ title"));
        assert!(!r.check("activewindowv2>>55d0"));
        assert!(r.check("activewindowv2>>77a0"));
        assert!(r.check("fullscreen>>1"));
    }

    #[test]
    fn dirs_try_the_runtime_dir_then_run_user_then_tmp() {
        let d = dirs("SIG");
        assert!(d.iter().any(|p| p.ends_with("hypr/SIG")));
        assert_eq!(d.last().unwrap(), &PathBuf::from("/tmp/hypr/SIG"));
    }

    /// A socket2 event triggers a re-query and the map follows; the requests are read-only.
    #[test]
    fn an_event_requeries_and_the_map_follows() {
        let fake = FakeHypr::new(tmp("follow"));
        let feed = Feed::default();
        let stop = Arc::new(AtomicBool::new(false));
        spawn(vec![fake.dir.clone()], feed.clone(), stop.clone()).unwrap();
        wait("the first query", || feed.status().0 == Some(true));
        let (m, _) = feed.take_map().unwrap();
        assert_eq!(m.len(), 2);
        assert!(m.values().all(|c| c.state == covered::CoverState::None));
        wait("socket2 connected", || fake.connected() == 1);
        fake.set(
            r#"[{"class":"steam_app_9","pid":4242,"workspace":{"id":1,"name":"1"},"fullscreen":2,"mapped":true,"hidden":false}]"#,
        );
        fake.emit("fullscreen>>1");
        wait("the cover", || {
            feed.peek()
                .get("DP-1")
                .is_some_and(|c| c.state == covered::CoverState::Fullscreen)
        });
        assert_eq!(feed.peek()["DP-1"].pid, Some(4242));
        // An unrelated event changes nothing and isn't queried for.
        let n = fake.requests.lock().unwrap().len();
        std::thread::sleep(CONFIRM + Duration::from_millis(100));
        let n = n.max(fake.requests.lock().unwrap().len());
        fake.emit("windowtitlev2>>55d0,hi");
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(fake.requests.lock().unwrap().len(), n);
        assert!(
            fake.requests
                .lock()
                .unwrap()
                .iter()
                .all(|r| r == "[[BATCH]]j/monitors;j/clients"),
            "read-only requests only"
        );
        stop.store(true, Ordering::Relaxed);
    }

    #[test]
    fn no_socket_reports_why_and_covers_nothing() {
        let feed = Feed::default();
        let stop = Arc::new(AtomicBool::new(false));
        spawn(vec![tmp("none")], feed.clone(), stop.clone()).unwrap();
        wait("the failure", || feed.status().0 == Some(false));
        let reason = feed.status().1.unwrap();
        assert!(reason.contains(".socket2.sock"), "{reason}");
        assert!(feed.peek().is_empty());
        stop.store(true, Ordering::Relaxed);
    }
}
