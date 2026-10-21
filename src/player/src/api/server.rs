//! The command socket (spec §4.2 "Command API"): binding (single instance, private
//! permissions), per-client non-blocking I/O with bounded queues, and the event tap that
//! feeds `subscribe`d clients.
//!
//! **Isolation.** Every client socket is non-blocking and edge-triggered in the loop; a
//! read never takes more than [`READ_BUDGET`] per wake (the rest is picked up on the next
//! iteration), a line over [`proto::MAX_LINE`] gets a `bad_request` and the connection is
//! closed, garbage JSON gets a `bad_request` reply (connection kept), and a client whose
//! unsent output passes [`MAX_BACKLOG`] — a dead/slow subscriber, or one that never reads
//! its replies — is dropped with an `api.client_dropped` warning. Nothing a client does can
//! block the loop or delay another client.

use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::thread::ThreadId;
use std::time::Duration;

use calloop::RegistrationToken;
use calloop::ping::Ping;
use serde_json::{Value, json};

use super::proto;
use crate::log::{self, Level, Tap};

/// Unsent bytes a client may have queued before it's dropped (dead/slow reader).
pub const MAX_BACKLOG: usize = 16 * 1024 * 1024;
/// Bytes read from one client per wake; more is read on the next loop iteration.
pub const READ_BUDGET: usize = 256 * 1024;
/// Requests handled per client per loop iteration (the rest wait their turn).
pub const LINES_PER_WAKE: usize = 32;
/// Events the tap buffers between loop iterations before dropping the oldest.
const TAP_CAPACITY: usize = 50_000;

/// The instance's files: the socket and its lock file (`<socket>.lock`, `flock`ed for
/// the process lifetime). Dropping it (clean exit, or an error after binding) removes the
/// socket, then the lock file — while still holding the lock — then releases it.
pub struct SocketFile {
    pub socket: PathBuf,
    pub lock_path: PathBuf,
    socket_bound: bool,
    _lock: std::fs::File,
}

impl SocketFile {
    /// Remove both files now (before an `_exit`, where `Drop` won't run).
    pub fn remove_now(&mut self) {
        if self.socket_bound {
            let _ = std::fs::remove_file(&self.socket);
            self.socket_bound = false;
        }
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

impl Drop for SocketFile {
    fn drop(&mut self) {
        self.remove_now();
    }
}

/// The lock file next to `socket`: `lp-player.sock` → `lp-player.lock`.
pub fn lock_path(socket: &Path) -> PathBuf {
    socket.with_extension("lock")
}

fn already_running(pid: &str, socket: &Path) -> String {
    format!(
        "lp-player is already running (pid {pid}) on {}; stop it with `lp-player ctl quit`, \
         or give this one another --socket",
        socket.display()
    )
}

/// Take the single-instance lock: `flock(LOCK_EX|LOCK_NB)` on `<socket>.lock` (created
/// `0600`), re-checked against the path (a lock file unlinked by an exiting owner between
/// our open and our lock is retried), then our pid written into it. Held → `Err("already
/// running (pid N)")` with N read from the file.
fn take_lock(socket: &Path) -> Result<std::fs::File, String> {
    use std::io::Seek;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let lp = lock_path(socket);
    for _ in 0..50 {
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&lp)
            .map_err(|e| format!("open lock file {}: {e}", lp.display()))?;
        let r = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if r != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                return Err(format!("lock {}: {err}", lp.display()));
            }
            // Held: the owner writes its pid right after locking — give it a moment.
            let mut pid = String::new();
            for _ in 0..100 {
                pid.clear();
                let _ = f.rewind();
                let _ = f.read_to_string(&mut pid);
                if !pid.trim().is_empty() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid = pid.trim();
            return Err(already_running(
                if pid.is_empty() { "?" } else { pid },
                socket,
            ));
        }
        // Locked — but is it still the file at that path? (Its previous owner may have
        // unlinked it between our open and our flock.)
        let same = match (f.metadata(), std::fs::metadata(&lp)) {
            (Ok(a), Ok(b)) => a.ino() == b.ino() && a.dev() == b.dev(),
            _ => false,
        };
        if !same {
            continue;
        }
        f.set_len(0)
            .and_then(|()| f.rewind())
            .and_then(|()| write!(f, "{}", std::process::id()))
            .and_then(|()| f.flush())
            .map_err(|e| format!("write lock file {}: {e}", lp.display()))?;
        return Ok(f);
    }
    Err(format!(
        "lock file {} keeps being replaced; is another lp-player starting and stopping?",
        lp.display()
    ))
}

/// Bind the command socket at `path`. Single instance (R item 4): the `flock` on
/// `<socket>.lock` decides — the loser exits with "already running (pid N)" and never
/// touches the socket; the winner (holding the lock, so any socket file is a dead one's)
/// unlinks a stale **socket** and binds, but refuses a path that isn't a socket. The
/// directory is created `0700` — and only chmod-ed if we created it or `own_dir` (the
/// default `$XDG_RUNTIME_DIR/livepaper`); a `--socket` in someone else's directory is left
/// alone. The socket is made `0600`.
pub fn bind(path: &Path, own_dir: bool) -> Result<(UnixListener, SocketFile), String> {
    use std::os::unix::fs::FileTypeExt;
    let dir = path
        .parent()
        .ok_or_else(|| format!("socket path {} has no directory", path.display()))?;
    let created = !dir.exists();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    if created || own_dir {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod 0700 {}: {e}", dir.display()))?;
    }
    let lock = take_lock(path)?;
    let mut guard = SocketFile {
        socket: path.to_path_buf(),
        lock_path: lock_path(path),
        socket_bound: false,
        _lock: lock,
    };
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_socket() => {
            // We hold the lock: whoever bound this is gone (a crash leftover).
            std::fs::remove_file(path)
                .map_err(|e| format!("remove stale socket {}: {e}", path.display()))?;
        }
        Ok(_) => {
            return Err(format!(
                "refusing to replace {}: it exists and is not a socket; pass another --socket",
                path.display()
            ));
        }
        Err(_) => {}
    }
    let l = UnixListener::bind(path).map_err(|e| format!("bind {}: {e}", path.display()))?;
    guard.socket_bound = true;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod 0600 {}: {e}", path.display()))?;
    l.set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking: {e}"))?;
    Ok((l, guard))
}

/// A borrowed client fd for the loop registration (the [`Client`] owns the stream and
/// removes the registration before closing it).
pub struct ClientFd(pub RawFd);

impl AsFd for ClientFd {
    fn as_fd(&self) -> BorrowedFd<'_> {
        // SAFETY: the registration holding this is removed before the owning stream is
        // dropped (`Server::reap`).
        unsafe { BorrowedFd::borrow_raw(self.0) }
    }
}

/// One connection.
pub struct Client {
    pub id: u64,
    stream: UnixStream,
    pub token: Option<RegistrationToken>,
    inbuf: Vec<u8>,
    out: Vec<u8>,
    out_pos: usize,
    /// Event-kind prefixes this client subscribed to (`subscribe`).
    pub subs: Vec<String>,
    /// Why it's being dropped; removed after the current dispatch.
    pub dead: Option<String>,
    /// Closed without being a fault (EOF, `quit`) — no warning.
    pub quiet: bool,
    /// The read budget ran out with data possibly left: read again next iteration.
    pub more_input: bool,
    /// The peer closed its write side.
    pub eof: bool,
    /// A deferred reply (`step`) is outstanding: its later requests wait (FIFO).
    pub awaiting: bool,
}

impl Client {
    fn new(id: u64, stream: UnixStream) -> Client {
        Client {
            id,
            stream,
            token: None,
            inbuf: Vec::new(),
            out: Vec::new(),
            out_pos: 0,
            subs: Vec::new(),
            dead: None,
            quiet: false,
            more_input: false,
            eof: false,
            awaiting: false,
        }
    }

    /// Put `lines` back in front of the unread input (FIFO behind a deferred reply).
    pub fn unread(&mut self, lines: Vec<Vec<u8>>) {
        if lines.is_empty() {
            return;
        }
        let mut front = Vec::new();
        for l in lines {
            front.extend_from_slice(&l);
            front.push(b'\n');
        }
        front.extend_from_slice(&self.inbuf);
        self.inbuf = front;
    }

    /// After the peer's EOF: once every queued request is handled and every reply sent,
    /// close — quietly, or as a drop if it left half a line behind.
    pub fn finish_eof(&mut self) {
        if !self.eof || self.more_input || self.awaiting || self.dead.is_some() {
            return;
        }
        self.flush();
        if self.out_pos < self.out.len() {
            return; // still sending; the writable edge flushes the rest
        }
        let partial = self.inbuf.len();
        if partial > 0 {
            self.kill(
                format!("disconnected mid-line ({partial} bytes unparsed)"),
                false,
            );
        } else {
            self.kill("closed".into(), true);
        }
    }

    pub fn raw_fd(&self) -> RawFd {
        self.stream.as_raw_fd()
    }

    fn kill(&mut self, reason: String, quiet: bool) {
        if self.dead.is_none() {
            self.dead = Some(reason);
            self.quiet = quiet;
        }
    }

    /// Queue one line (newline added) and try to send it now. Over [`MAX_BACKLOG`] → the
    /// client is dropped instead.
    pub fn send_line(&mut self, line: &str) {
        if self.dead.is_some() {
            return;
        }
        if self.out.len() - self.out_pos + line.len() + 1 > MAX_BACKLOG {
            self.kill(
                format!(
                    "output queue overflow ({} MiB unsent): the client isn't reading",
                    MAX_BACKLOG / (1024 * 1024)
                ),
                false,
            );
            return;
        }
        self.out.extend_from_slice(line.as_bytes());
        self.out.push(b'\n');
        self.flush();
    }

    /// Write as much as the socket takes (never blocks).
    pub fn flush(&mut self) {
        while self.out_pos < self.out.len() {
            match (&self.stream).write(&self.out[self.out_pos..]) {
                Ok(0) => {
                    self.kill("write returned 0".into(), true);
                    return;
                }
                Ok(n) => self.out_pos += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => {
                    self.kill(format!("write: {e}"), true);
                    return;
                }
            }
        }
        if self.out_pos == self.out.len() {
            self.out.clear();
            self.out_pos = 0;
        } else if self.out_pos > 1024 * 1024 {
            self.out.drain(..self.out_pos);
            self.out_pos = 0;
        }
    }

    /// Read what's there (up to [`READ_BUDGET`] per call) and return at most
    /// [`LINES_PER_WAKE`] complete lines — a flooding client gets its turn, then the
    /// others (`more_input` brings it back next iteration). An over-long line is answered
    /// with `bad_request` and closes the connection.
    pub fn read_lines(&mut self) -> Vec<Vec<u8>> {
        self.more_input = false;
        let mut got = 0;
        let mut buf = [0u8; 64 * 1024];
        // Don't pull more while plenty of complete requests are still unprocessed
        // (bounded memory per client) — but always keep reading an unfinished line, up to
        // the point where it's too long.
        let backlogged = self.inbuf.len() >= READ_BUDGET && self.inbuf.contains(&b'\n');
        while self.dead.is_none() && !self.eof && !backlogged {
            match (&self.stream).read(&mut buf) {
                Ok(0) => {
                    // Read side closed: what's queued still gets handled and answered;
                    // `finish_eof` closes once that's done.
                    self.eof = true;
                    break;
                }
                Ok(n) => {
                    self.inbuf.extend_from_slice(&buf[..n]);
                    got += n;
                    if got >= READ_BUDGET {
                        self.more_input = true;
                        break;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => {
                    self.kill(format!("read: {e}"), true);
                    break;
                }
            }
        }
        if backlogged {
            self.more_input = true; // didn't read: there may be more queued
        }
        let mut lines = Vec::new();
        let mut start = 0;
        while lines.len() < LINES_PER_WAKE {
            let Some(pos) = self.inbuf[start..].iter().position(|&b| b == b'\n') else {
                break;
            };
            if pos > proto::MAX_LINE {
                break;
            }
            lines.push(self.inbuf[start..start + pos].to_vec());
            start += pos + 1;
        }
        self.inbuf.drain(..start);
        let over = match self.inbuf.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                if lines.len() >= LINES_PER_WAKE || pos <= proto::MAX_LINE {
                    self.more_input = true; // complete lines left for the next turn
                }
                pos > proto::MAX_LINE && lines.len() < LINES_PER_WAKE
            }
            None => self.inbuf.len() > proto::MAX_LINE,
        };
        if over {
            let e = proto::bad_request(format!(
                "request line exceeds {} MiB; closing the connection",
                proto::MAX_LINE / (1024 * 1024)
            ));
            self.send_line(&proto::err_line(&Value::Null, &e));
            self.inbuf.clear();
            self.kill(
                format!("request line over {} MiB", proto::MAX_LINE / (1024 * 1024)),
                false,
            );
        }
        lines
    }
}

/// The log tap behind `subscribe` (a [`Tap`]): queues the records whose kind matches
/// any client's subscription; the loop routes them after each dispatch. Called from any
/// thread — off the loop thread it also pings the loop awake.
pub struct EventTap {
    queue: Mutex<VecDeque<Value>>,
    topics: RwLock<Vec<String>>,
    ping: Ping,
    loop_thread: ThreadId,
    dropped: AtomicU64,
}

impl EventTap {
    pub fn new(ping: Ping) -> EventTap {
        EventTap {
            queue: Mutex::new(VecDeque::new()),
            topics: RwLock::new(Vec::new()),
            ping,
            loop_thread: std::thread::current().id(),
            dropped: AtomicU64::new(0),
        }
    }

    /// Replace the union of every client's subscriptions.
    pub fn set_topics(&self, topics: Vec<String>) {
        if let Ok(mut t) = self.topics.write() {
            *t = topics;
        }
    }

    /// Everything queued since the last call.
    pub fn drain(&self) -> Vec<Value> {
        self.queue
            .lock()
            .map(|mut q| q.drain(..).collect())
            .unwrap_or_default()
    }

    /// Events dropped because the loop didn't drain fast enough (probes).
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl Tap for EventTap {
    fn wants(&self, _level: Level, kind: &str) -> bool {
        self.topics
            .read()
            .map(|t| t.iter().any(|p| kind.starts_with(p.as_str())))
            .unwrap_or(false)
    }

    fn send(&self, record: &Value) {
        if let Ok(mut q) = self.queue.lock() {
            if q.len() >= TAP_CAPACITY {
                q.pop_front();
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            q.push_back(record.clone());
        }
        if std::thread::current().id() != self.loop_thread {
            self.ping.ping();
        }
    }
}

/// Every connection, by id.
#[derive(Default)]
pub struct Server {
    pub clients: BTreeMap<u64, Client>,
    next_id: u64,
}

impl Server {
    /// Accept every pending connection (non-blocking); returns the new client ids.
    pub fn accept(&mut self, l: &UnixListener) -> Vec<u64> {
        let mut ids = Vec::new();
        loop {
            match l.accept() {
                Ok((s, _)) => {
                    if s.set_nonblocking(true).is_err() {
                        continue;
                    }
                    self.next_id += 1;
                    let id = self.next_id;
                    self.clients.insert(id, Client::new(id, s));
                    ids.push(id);
                    log::event(
                        "api",
                        Level::Debug,
                        "api.client_connected",
                        None,
                        json!({ "client": id }),
                    );
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => {
                    log::event(
                        "api",
                        Level::Warn,
                        "api.accept_failed",
                        None,
                        json!({ "error": e.to_string() }),
                    );
                    break;
                }
            }
        }
        ids
    }

    /// The union of every live client's subscriptions.
    pub fn topics(&self) -> Vec<String> {
        let mut t: Vec<String> = self
            .clients
            .values()
            .filter(|c| c.dead.is_none())
            .flat_map(|c| c.subs.iter().cloned())
            .collect();
        t.sort();
        t.dedup();
        t
    }

    /// Route event records to every client subscribed to their kind.
    pub fn route(&mut self, records: &[Value]) {
        for rec in records {
            let kind = rec.get("kind").and_then(Value::as_str).unwrap_or("");
            let mut line: Option<String> = None;
            for c in self.clients.values_mut() {
                if c.dead.is_none() && c.subs.iter().any(|p| kind.starts_with(p.as_str())) {
                    let l = line.get_or_insert_with(|| proto::event_line(rec));
                    c.send_line(l);
                }
            }
        }
    }

    /// Remove the dead clients — the loop registration first, then the socket. Returns
    /// the removed clients' registration tokens for the caller to unregister first.
    pub fn take_dead(&mut self) -> Vec<Client> {
        let dead: Vec<u64> = self
            .clients
            .iter()
            .filter(|(_, c)| c.dead.is_some())
            .map(|(id, _)| *id)
            .collect();
        let mut out = Vec::new();
        for id in dead {
            if let Some(c) = self.clients.remove(&id) {
                let reason = c.dead.clone().unwrap_or_default();
                if c.quiet {
                    log::event(
                        "api",
                        Level::Debug,
                        "api.client_closed",
                        None,
                        json!({ "client": id, "reason": reason }),
                    );
                } else {
                    log::event(
                        "api",
                        Level::Warn,
                        "api.client_dropped",
                        None,
                        json!({ "client": id, "reason": reason }),
                    );
                }
                out.push(c);
            }
        }
        out
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}
