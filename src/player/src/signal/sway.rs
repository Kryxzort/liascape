//! The Sway cover source (Task 6, designer call 9): i3 IPC on `$SWAYSOCK`. A thread
//! (`lia-cover`) subscribes to `window`/`workspace`/`output` events on one connection and, on
//! each (coalesced), reads `GET_TREE` on a second one and publishes [`covered::sway_cover`] of
//! it. Sway's `visible` is a real on-screen flag (unlike Hyprland's). Read-only. Not running on
//! the owner's machine: tested against a fake socket only.
//!
//! Wire format: `"i3-ipc"`, payload length (u32, native endian), type (u32), payload. Events
//! carry the high bit in their type.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::Feed;
use super::covered::{self, CoverMap};

const MAGIC: &[u8; 6] = b"i3-ipc";
pub const SUBSCRIBE: u32 = 2;
pub const GET_TREE: u32 = 4;
/// `shutdown` event (sway exits): reconnect.
pub const EVENT_SHUTDOWN: u32 = 0x8000_0006;
const COALESCE: Duration = Duration::from_millis(30);
const RETRY: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(100);
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

pub fn frame(ty: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(14 + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    out.extend_from_slice(&ty.to_ne_bytes());
    out.extend_from_slice(payload);
    out
}

/// Take every complete message off the front of `buf`: `(type, payload)`.
pub fn take_frames(buf: &mut Vec<u8>) -> Result<Vec<(u32, Vec<u8>)>, String> {
    let mut out = Vec::new();
    loop {
        if buf.len() < 14 {
            return Ok(out);
        }
        if &buf[..6] != MAGIC {
            return Err("i3 IPC: bad magic".into());
        }
        let len = u32::from_ne_bytes([buf[6], buf[7], buf[8], buf[9]]) as usize;
        let ty = u32::from_ne_bytes([buf[10], buf[11], buf[12], buf[13]]);
        if buf.len() < 14 + len {
            return Ok(out);
        }
        out.push((ty, buf[14..14 + len].to_vec()));
        buf.drain(..14 + len);
    }
}

/// One request/reply on `s` (blocking, [`QUERY_TIMEOUT`]).
fn call(s: &mut UnixStream, ty: u32, payload: &[u8]) -> Result<Vec<u8>, String> {
    s.set_read_timeout(Some(QUERY_TIMEOUT)).ok();
    s.write_all(&frame(ty, payload))
        .map_err(|e| format!("$SWAYSOCK: {e}"))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        let n = s.read(&mut chunk).map_err(|e| format!("$SWAYSOCK: {e}"))?;
        if n == 0 {
            return Err("$SWAYSOCK closed".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        // Events can't arrive on a connection that never subscribed.
        if let Some((_, p)) = take_frames(&mut buf)?.into_iter().find(|(t, _)| *t == ty) {
            return Ok(p);
        }
    }
}

/// `GET_TREE` → the cover per output.
pub fn query(s: &mut UnixStream) -> Result<CoverMap, String> {
    let raw = call(s, GET_TREE, b"")?;
    let tree: Value =
        serde_json::from_slice(&raw).map_err(|e| format!("GET_TREE: not JSON ({e})"))?;
    Ok(covered::sway_cover(&tree))
}

pub fn spawn(sock: PathBuf, feed: Feed, stop: Arc<AtomicBool>) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("lia-cover".into())
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if let Err(e) = session(&sock, &feed, &stop) {
                    feed.fail(e);
                    let end = Instant::now() + RETRY;
                    while !stop.load(Ordering::Relaxed) && Instant::now() < end {
                        std::thread::sleep(POLL);
                    }
                }
            }
        })
        .map(|_| ())
}

fn session(sock: &Path, feed: &Feed, stop: &AtomicBool) -> Result<(), String> {
    let conn = || UnixStream::connect(sock).map_err(|e| format!("{}: {e}", sock.display()));
    let mut req = conn()?;
    let mut ev = conn()?;
    let ok = call(
        &mut ev,
        SUBSCRIBE,
        br#"["window","workspace","output","shutdown"]"#,
    )?;
    if !String::from_utf8_lossy(&ok).contains("true") {
        return Err(format!(
            "i3 IPC subscribe refused: {}",
            String::from_utf8_lossy(&ok)
        ));
    }
    ev.set_read_timeout(Some(POLL)).ok();
    let mut due = Some(Instant::now());
    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if due.is_some_and(|d| Instant::now() >= d) {
            due = None;
            feed.publish(query(&mut req)?);
        }
        match ev.read(&mut chunk) {
            Ok(0) => return Err("sway closed the IPC socket".into()),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                for (ty, _) in take_frames(&mut buf)? {
                    feed.count_event();
                    if ty == EVENT_SHUTDOWN {
                        return Err("sway is shutting down".into());
                    }
                    if ty & 0x8000_0000 != 0 && due.is_none() {
                        due = Some(Instant::now() + COALESCE);
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(format!("$SWAYSOCK: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::Mutex;

    #[test]
    fn frames_round_trip_and_split() {
        let mut buf = frame(GET_TREE, b"{}");
        buf.extend(frame(0x8000_0003, b"{\"change\":\"fullscreen_mode\"}"));
        let tail = frame(GET_TREE, b"[1,2]");
        buf.extend_from_slice(&tail[..5]);
        let got = take_frames(&mut buf).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], (GET_TREE, b"{}".to_vec()));
        assert_eq!(got[1].0, 0x8000_0003);
        assert_eq!(buf.len(), 5, "a partial frame stays");
        buf.extend_from_slice(&tail[5..]);
        assert_eq!(
            take_frames(&mut buf).unwrap(),
            vec![(GET_TREE, b"[1,2]".to_vec())]
        );
        assert!(take_frames(&mut b"xxxxxxxxxxxxxxxx".to_vec()).is_err());
    }

    fn tree(fs: i64) -> String {
        serde_json::json!({"type": "root", "nodes": [
            {"type": "output", "name": "DP-1", "nodes": [{"type": "workspace", "nodes": [
                {"type": "con", "fullscreen_mode": fs, "visible": true, "app_id": "mpv", "pid": 77}]}]}
        ]})
        .to_string()
    }

    /// A fake sway: GET_TREE answers from `tree`; a subscriber gets a `window` event on demand.
    #[test]
    fn a_window_event_rereads_the_tree() {
        let dir = std::env::temp_dir().join(format!("lia-sway-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("sway.sock");
        let l = UnixListener::bind(&sock).unwrap();
        let state = Arc::new(Mutex::new(tree(0)));
        let subs: Arc<Mutex<Vec<UnixStream>>> = Arc::default();
        let (st, sb) = (state.clone(), subs.clone());
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { return };
                let (st, sb) = (st.clone(), sb.clone());
                std::thread::spawn(move || {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let Ok(n) = c.read(&mut chunk) else { return };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        for (ty, _) in take_frames(&mut buf).unwrap() {
                            let reply = match ty {
                                SUBSCRIBE => {
                                    sb.lock().unwrap().push(c.try_clone().unwrap());
                                    frame(SUBSCRIBE, br#"{"success":true}"#)
                                }
                                GET_TREE => frame(GET_TREE, st.lock().unwrap().as_bytes()),
                                _ => frame(ty, b"{}"),
                            };
                            let _ = c.write_all(&reply);
                        }
                    }
                });
            }
        });
        let feed = Feed::default();
        let stop = Arc::new(AtomicBool::new(false));
        spawn(sock, feed.clone(), stop.clone()).unwrap();
        let wait = |what: &str, f: &dyn Fn() -> bool| {
            let t = Instant::now();
            while !f() {
                assert!(t.elapsed() < Duration::from_secs(5), "timed out: {what}");
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        wait("the first tree", &|| feed.status().0 == Some(true));
        assert_eq!(feed.peek()["DP-1"].state, covered::CoverState::None);
        wait("subscribed", &|| !subs.lock().unwrap().is_empty());
        *state.lock().unwrap() = tree(1);
        for s in subs.lock().unwrap().iter_mut() {
            s.write_all(&frame(0x8000_0003, br#"{"change":"fullscreen_mode"}"#))
                .unwrap();
        }
        wait("the cover", &|| {
            feed.peek()["DP-1"].state == covered::CoverState::Fullscreen
        });
        assert_eq!(feed.peek()["DP-1"].pid, Some(77));
        stop.store(true, Ordering::Relaxed);
    }
}
