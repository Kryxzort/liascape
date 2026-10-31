//! The player outbox (Phase 3 Task 9, plan designer call 6): the facts the backend must store
//! even when it isn't listening — `source.broken` (→ the item is marked crashed),
//! `scene.loudness` (→ the index) and `scene.vram_exceeded` (UI text only) — kept in
//! `<state>/outbox.jsonl` until the backend acks them. The backend drains it on every
//! (re)subscription (`outbox.read`, then `outbox.ack`), so a fact that happened with the app
//! closed, or in a reconnect gap, still reaches the library.
//!
//! - **Lines:** `{seq, t_wall, kind, fields}` — `fields` is the live event's own fields (without
//!   `outbox_seq`, which the live event gains). `seq` is monotonic across restarts: at open it
//!   continues from the last line, or from `outbox.state.json`'s `last_seq` when the file is empty
//!   (every entry acked).
//! - **Appends:** `O_APPEND`, one `write` per line, never `fsync`ed (a crash keeps it in the page
//!   cache; only a power loss can lose the newest lines). Any thread, under one mutex.
//! - **Bound:** at most [`OUTBOX_MAX`] unacked entries count. A read never returns an older one
//!   (`dropped_before` says one was lost past `after`); the file is compacted once it holds
//!   [`COMPACT_SLACK`] more lines than that (`outbox.dropped {n, before}`).
//! - **Ack:** `outbox.ack {seq}` acks everything ≤ seq at once (reads skip it) and queues a
//!   compaction on the snapshot writer thread (`lia-snapshot`): the file is rewritten with only
//!   what is unacked (temp + `fsync` + rename; the lines appended meanwhile are carried over under
//!   the lock), `outbox.state.json` first (`{last_seq, acked, dropped_through}`, atomic).
//!
//! Every handler of a drained fact is idempotent (the backend's `MarkCrashed`,
//! `MergeSceneLoudness` keeping the longest), so a crash between a handled fact and its ack only
//! repeats it.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde_json::{Value, json};

use crate::log::{self, Level};

/// The outbox file in the state dir.
pub const FILE: &str = "outbox.jsonl";
/// `{last_seq, acked, dropped_through}` — what the file alone can't tell after a compaction.
pub const STATE_FILE: &str = "outbox.state.json";
/// The most unacked entries kept (the oldest dropped past it).
pub const OUTBOX_MAX: usize = 2000;
/// The file is compacted once it holds this many lines more than [`OUTBOX_MAX`] (no rewrite per
/// append past the bound; reads apply the bound exactly).
pub const COMPACT_SLACK: usize = 200;
/// `outbox.read`'s default page.
pub const READ_LIMIT: usize = 500;

/// Queues a job on another thread (the snapshot writer's `Runner`); false = it can't (stopped).
pub type Spawner = Box<dyn Fn(Box<dyn FnOnce() + Send>) -> bool + Send + Sync>;

/// `outbox.read`'s answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    /// `{seq, t_wall, kind, fields}`, oldest first.
    pub events: Vec<Value>,
    /// The newest seq ever appended (0 = none).
    pub last_seq: u64,
    /// Entries past `after` (and the ack) were dropped by the bound: everything before this seq.
    pub dropped_before: Option<u64>,
}

#[derive(Default)]
struct Inner {
    file: Option<File>,
    next_seq: u64,
    /// Lines in the file (acked ones included until a compaction).
    lines: usize,
    acked: u64,
    /// The newest seq a compaction dropped unacked (0 = none).
    dropped_through: u64,
    compacting: bool,
    again: bool,
    failing: bool,
}

pub struct Outbox {
    dir: PathBuf,
    inner: Mutex<Inner>,
    spawn: Option<Spawner>,
}

static GLOBAL: OnceLock<Arc<Outbox>> = OnceLock::new();

/// Make `o` the process's outbox (`serve`, once): [`append`] writes to it.
pub fn install(o: Arc<Outbox>) {
    let _ = GLOBAL.set(o);
}

/// The process's outbox (`None` before `serve` installed one — a harness, a test).
pub fn global() -> Option<&'static Arc<Outbox>> {
    GLOBAL.get()
}

/// Append `kind` + `fields` to the process's outbox → its seq (`None` without one, or when the
/// write failed — `outbox.write_failed`). The caller adds it to the live event as `outbox_seq`.
pub fn append(kind: &str, fields: &Value) -> Option<u64> {
    global().and_then(|o| o.append(kind, fields))
}

/// [`append`] `fields` under `kind`, then add the seq to them as `outbox_seq` (what the live
/// event carries — the backend acks what it handled live by it).
pub fn with_seq(kind: &str, fields: &mut Value) {
    if let Some(seq) = append(kind, fields) {
        fields["outbox_seq"] = json!(seq);
    }
}

/// The seq of a line written by [`Outbox::append`] (`{"seq":N,…`), else the parsed line's.
fn line_seq(line: &str) -> Option<u64> {
    if let Some(rest) = line.strip_prefix("{\"seq\":") {
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        if end > 0 {
            return rest[..end].parse().ok();
        }
    }
    serde_json::from_str::<Value>(line)
        .ok()?
        .get("seq")?
        .as_u64()
}

/// The complete lines of `bytes` (a torn last line — a power loss mid-append — is skipped).
fn complete_lines(bytes: &[u8]) -> impl Iterator<Item = &str> {
    let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    bytes[..end]
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| std::str::from_utf8(l).ok())
}

fn read_state(dir: &Path) -> (u64, u64, u64) {
    let v: Value = fs::read(dir.join(STATE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    (n("last_seq"), n("acked"), n("dropped_through"))
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

impl Outbox {
    /// Open (or create) `<dir>/outbox.jsonl`. `spawn` runs the compactions (the snapshot writer
    /// thread); `None` runs them inline (tests). A file past the bound, or holding acked
    /// entries, is compacted at once.
    pub fn open(dir: &Path, spawn: Option<Spawner>) -> Arc<Outbox> {
        let path = dir.join(FILE);
        let (state_last, acked, dropped_through) = read_state(dir);
        let bytes = fs::read(&path).unwrap_or_default();
        let mut lines = 0;
        let mut last = 0;
        let mut stale = 0;
        for l in complete_lines(&bytes) {
            lines += 1;
            if let Some(s) = line_seq(l) {
                last = last.max(s);
                if s <= acked {
                    stale += 1;
                }
            }
        }
        let _ = fs::create_dir_all(dir);
        let file = open_append(&path);
        if let Ok(f) = &file
            && bytes.last().is_some_and(|b| *b != b'\n')
        {
            // a torn last line (a power loss mid-append): end it, so the next line stays whole
            let mut w: &File = f;
            let _ = w.write_all(b"\n");
        }
        let failed = file.as_ref().err().map(|e| e.to_string());
        let o = Arc::new(Outbox {
            dir: dir.to_path_buf(),
            inner: Mutex::new(Inner {
                file: file.ok(),
                next_seq: last.max(state_last).max(acked) + 1,
                lines,
                acked,
                dropped_through,
                failing: failed.is_some(),
                ..Inner::default()
            }),
            spawn,
        });
        if let Some(e) = failed {
            o.write_failed("open", &e);
        }
        if lines > OUTBOX_MAX || stale > 0 {
            o.schedule();
        }
        o
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write_failed(&self, op: &str, e: &str) {
        log::event(
            "outbox",
            Level::Warn,
            "outbox.write_failed",
            None,
            json!({"file": self.dir.join(FILE), "op": op, "error": e,
                   "hint": "the state dir must be writable (XDG_STATE_HOME); a fact the backend \
                            misses now is lost to it if it isn't listening either"}),
        );
    }

    /// One line, one `write` → its seq (`None` when the write failed; the seq is then unused).
    pub fn append(self: &Arc<Self>, kind: &str, fields: &Value) -> Option<u64> {
        let mut g = self.lock();
        let seq = g.next_seq;
        // `seq` first, by hand (serde_json sorts an object's keys): `line_seq` reads it cheaply
        let line = format!(
            "{{\"seq\":{seq},\"t_wall\":{},\"kind\":{},\"fields\":{}}}\n",
            json!(log::wall_time_rfc3339()),
            json!(kind),
            fields
        );
        let res = match g.file.as_mut() {
            Some(f) => f.write_all(line.as_bytes()).map_err(|e| e.to_string()),
            None => Err("not open".to_string()),
        };
        let (ok, recovered, failed) = match res {
            Ok(()) => {
                g.next_seq += 1;
                g.lines += 1;
                let rec = std::mem::replace(&mut g.failing, false);
                (true, rec, None)
            }
            Err(e) => {
                let first = !std::mem::replace(&mut g.failing, true);
                (false, false, first.then_some(e))
            }
        };
        let compact = ok && g.lines > OUTBOX_MAX + COMPACT_SLACK;
        drop(g);
        if let Some(e) = failed {
            self.write_failed("append", &e);
        }
        if recovered {
            log::event(
                "outbox",
                Level::Info,
                "outbox.write_recovered",
                None,
                json!({}),
            );
        }
        if compact {
            self.schedule();
        }
        ok.then_some(seq)
    }

    /// The unacked entries after `after` (≤ `limit`), the newest [`OUTBOX_MAX`] only.
    pub fn read(&self, after: Option<u64>, limit: usize) -> Page {
        let (acked, dropped_through, last_seq) = {
            let g = self.lock();
            (g.acked, g.dropped_through, g.next_seq - 1)
        };
        let bytes = fs::read(self.dir.join(FILE)).unwrap_or_default();
        let entries: Vec<(u64, &str)> = complete_lines(&bytes)
            .filter_map(|l| line_seq(l).map(|s| (s, l)))
            .filter(|(s, _)| *s > acked)
            .collect();
        let cut = entries.len().saturating_sub(OUTBOX_MAX);
        let lost_through = entries[..cut]
            .last()
            .map_or(dropped_through, |(s, _)| dropped_through.max(*s));
        let from = after.unwrap_or(0).max(acked);
        let events = entries[cut..]
            .iter()
            .filter(|(s, _)| *s > from)
            .take(limit)
            .filter_map(|(_, l)| serde_json::from_str(l).ok())
            .collect();
        Page {
            events,
            last_seq,
            dropped_before: (lost_through > from).then_some(lost_through + 1),
        }
    }

    /// Everything ≤ `seq` is handled: reads skip it now, the file drops it at the compaction
    /// this queues. A `seq` past the newest acks everything.
    pub fn ack(self: &Arc<Self>, seq: u64) {
        let mut g = self.lock();
        let seq = seq.min(g.next_seq - 1);
        if seq <= g.acked {
            return;
        }
        g.acked = seq;
        drop(g);
        self.schedule();
    }

    /// Queue a compaction (one at a time; one more after it if asked meanwhile).
    fn schedule(self: &Arc<Self>) {
        {
            let mut g = self.lock();
            if g.compacting {
                g.again = true;
                return;
            }
            g.compacting = true;
        }
        let me = self.clone();
        match &self.spawn {
            Some(spawn) => {
                if !spawn(Box::new(move || me.compact())) {
                    self.lock().compacting = false; // the writer stopped (exit): the next start does it
                }
            }
            None => me.compact(),
        }
    }

    /// Rewrite the file with the unacked entries only, the newest [`OUTBOX_MAX`] of them.
    fn compact(&self) {
        loop {
            let t = Instant::now();
            let path = self.dir.join(FILE);
            let tmp = self.dir.join(format!("{FILE}.tmp"));
            let (acked, old_dropped, last_seq, len) = {
                let g = self.lock();
                let len = g
                    .file
                    .as_ref()
                    .and_then(|f| f.metadata().ok())
                    .map_or(0, |m| m.len());
                (g.acked, g.dropped_through, g.next_seq - 1, len)
            };
            let res = (|| -> io::Result<(usize, usize, u64, usize)> {
                let mut bytes = Vec::new();
                File::open(&path)?.take(len).read_to_end(&mut bytes)?;
                let kept: Vec<(u64, &str)> = complete_lines(&bytes)
                    .filter_map(|l| line_seq(l).map(|s| (s, l)))
                    .filter(|(s, _)| *s > acked)
                    .collect();
                let cut = kept.len().saturating_sub(OUTBOX_MAX);
                let dropped_seq = kept[..cut].last().map_or(0, |(s, _)| *s);
                let mut out = String::new();
                for (_, l) in &kept[cut..] {
                    out.push_str(l);
                    out.push('\n');
                }
                {
                    let mut f = File::create(&tmp)?;
                    f.write_all(out.as_bytes())?;
                    f.sync_all()?;
                }
                let dropped_through = old_dropped.max(dropped_seq);
                // the seq and the ack outlive an empty file
                crate::snapshot::write_atomic_named(
                    &self.dir,
                    STATE_FILE,
                    json!({"last_seq": last_seq, "acked": acked,
                           "dropped_through": dropped_through})
                    .to_string()
                    .as_bytes(),
                )?;
                // under the lock: the lines appended since `len` go along, then the swap
                let mut g = self.lock();
                let mut tail = Vec::new();
                let mut src = File::open(&path)?;
                src.seek(SeekFrom::Start(len))?;
                src.read_to_end(&mut tail)?;
                let mut f = OpenOptions::new().append(true).open(&tmp)?;
                f.write_all(&tail)?;
                fs::rename(&tmp, &path)?;
                g.file = Some(open_append(&path)?);
                let tail_lines = complete_lines(&tail).count();
                g.lines = kept.len() - cut + tail_lines;
                g.dropped_through = g.dropped_through.max(dropped_through);
                Ok((kept.len() - cut, cut, dropped_seq, tail_lines))
            })();
            if let Ok(d) = File::open(&self.dir) {
                let _ = d.sync_all();
            }
            let again = {
                let mut g = self.lock();
                let again = std::mem::replace(&mut g.again, false);
                if !again {
                    g.compacting = false;
                }
                again
            };
            match res {
                Ok((kept, n, dropped_seq, tail)) => {
                    if n > 0 {
                        log::event(
                            "outbox",
                            Level::Warn,
                            "outbox.dropped",
                            None,
                            json!({"n": n, "before": dropped_seq + 1, "max": OUTBOX_MAX,
                                   "hint": "no backend acked the outbox: it lost the oldest facts"}),
                        );
                    }
                    log::event(
                        "outbox",
                        Level::Debug,
                        "outbox.compacted",
                        None,
                        json!({"kept": kept, "acked": acked, "carried": tail,
                               "ms": t.elapsed().as_secs_f64() * 1e3}),
                    );
                }
                Err(e) => {
                    let _ = fs::remove_file(&tmp);
                    self.write_failed("compact", &e.to_string());
                }
            }
            if !again {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("liascape-outbox-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn seqs(p: &Page) -> Vec<u64> {
        p.events
            .iter()
            .map(|e| e["seq"].as_u64().unwrap())
            .collect()
    }

    fn file_lines(d: &Path) -> usize {
        fs::read_to_string(d.join(FILE))
            .unwrap_or_default()
            .lines()
            .count()
    }

    #[test]
    fn appends_read_back_in_order_and_survive_a_reopen() {
        let d = dir("reopen");
        let o = Outbox::open(&d, None);
        assert_eq!(o.append("source.broken", &json!({"path": "/a"})), Some(1));
        assert_eq!(
            o.append("scene.loudness", &json!({"path": "/b", "lufs": -20.0})),
            Some(2)
        );
        let p = o.read(None, READ_LIMIT);
        assert_eq!(seqs(&p), vec![1, 2]);
        assert_eq!(p.events[1]["kind"], json!("scene.loudness"));
        assert_eq!(p.events[1]["fields"]["lufs"], json!(-20.0));
        assert_eq!((p.last_seq, p.dropped_before), (2, None));
        let line = fs::read_to_string(d.join(FILE)).unwrap();
        assert!(
            line.starts_with("{\"seq\":1,"),
            "seq first (cheap skips): {line}"
        );
        drop(o);
        let o = Outbox::open(&d, None);
        assert_eq!(o.read(None, READ_LIMIT).events, p.events);
        assert_eq!(
            o.append("source.broken", &json!({})),
            Some(3),
            "seq continues"
        );
        assert_eq!(seqs(&o.read(Some(2), 1)), vec![3]);
    }

    #[test]
    fn ack_compacts_and_the_seq_outlives_an_empty_file() {
        let d = dir("ack");
        let o = Outbox::open(&d, None);
        for i in 0..5 {
            o.append("k", &json!({"i": i}));
        }
        o.ack(3);
        assert_eq!(seqs(&o.read(None, READ_LIMIT)), vec![4, 5]);
        assert_eq!(file_lines(&d), 2, "compacted (inline without a spawner)");
        o.ack(99); // past the newest: everything
        assert!(o.read(None, READ_LIMIT).events.is_empty());
        assert_eq!(file_lines(&d), 0);
        drop(o);
        let o = Outbox::open(&d, None);
        let p = o.read(None, READ_LIMIT);
        assert!(p.events.is_empty());
        assert_eq!(p.last_seq, 5);
        assert_eq!(o.append("k", &json!({})), Some(6));
    }

    #[test]
    fn an_ack_lost_before_its_compaction_is_still_honoured_at_open() {
        // the state file says acked 2, the file still has 1..3 (a crash between the two)
        let d = dir("stale");
        let o = Outbox::open(&d, None);
        for _ in 0..3 {
            o.append("k", &json!({}));
        }
        fs::write(
            d.join(STATE_FILE),
            json!({"last_seq": 3, "acked": 2, "dropped_through": 0}).to_string(),
        )
        .unwrap();
        drop(o);
        let o = Outbox::open(&d, None);
        assert_eq!(seqs(&o.read(None, READ_LIMIT)), vec![3]);
        assert_eq!(file_lines(&d), 1, "compacted at open");
    }

    #[test]
    fn appends_past_the_bound_drop_the_oldest() {
        let d = dir("bound");
        let o = Outbox::open(&d, None);
        for i in 1..=2500u64 {
            assert_eq!(o.append("k", &json!({"i": i})), Some(i));
        }
        let p = o.read(None, 5000);
        assert_eq!(p.events.len(), OUTBOX_MAX);
        assert_eq!(seqs(&p)[0], 501);
        assert_eq!(p.dropped_before, Some(501));
        assert_eq!(p.last_seq, 2500);
        assert!(
            file_lines(&d) <= OUTBOX_MAX + COMPACT_SLACK,
            "{}",
            file_lines(&d)
        );
        assert_eq!(o.read(None, READ_LIMIT).events.len(), READ_LIMIT);
        let p = o.read(Some(1000), 1);
        assert_eq!((seqs(&p), p.dropped_before), (vec![1001], None));
        o.ack(2500);
        let p = o.read(None, READ_LIMIT);
        assert_eq!((p.events.len(), p.dropped_before), (0, None));
        // the loss is remembered across a reopen until an ack passes it
        let d2 = dir("bound2");
        let o = Outbox::open(&d2, None);
        for i in 1..=2300u64 {
            o.append("k", &json!({"i": i}));
        }
        drop(o);
        let o = Outbox::open(&d2, None);
        assert_eq!(o.read(None, 1).dropped_before, Some(301));
        assert_eq!(file_lines(&d2), OUTBOX_MAX);
    }

    #[test]
    fn a_torn_last_line_is_skipped_and_ended() {
        let d = dir("torn");
        fs::write(
            d.join(FILE),
            "{\"seq\":1,\"t_wall\":\"x\",\"kind\":\"k\",\"fields\":{}}\n{\"seq\":2,\"t_w",
        )
        .unwrap();
        let o = Outbox::open(&d, None);
        assert_eq!(o.append("k", &json!({})), Some(2));
        assert_eq!(seqs(&o.read(None, READ_LIMIT)), vec![1, 2]);
    }

    #[test]
    fn a_queued_compaction_sees_every_ack_and_append_before_it() {
        let d = dir("spawned");
        let (tx, rx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let tx = Mutex::new(tx);
        let o = Outbox::open(
            &d,
            Some(Box::new(move |f| tx.lock().unwrap().send(f).is_ok())),
        );
        for _ in 0..4 {
            o.append("k", &json!({}));
        }
        o.ack(2);
        o.append("k", &json!({})); // after the ack, before its compaction runs
        o.ack(3); // another one meanwhile: compacted again after
        rx.recv().unwrap()();
        assert_eq!(seqs(&o.read(None, READ_LIMIT)), vec![4, 5]);
        assert_eq!(file_lines(&d), 2);
        assert_eq!(o.append("k", &json!({})), Some(6));
        assert_eq!(file_lines(&d), 3, "appends go to the new file");
    }
}
