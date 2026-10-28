//! `capture` off the loop (`.claude/rules/player-core.md` § GFX / EGL → "`capture` never stalls
//! the loop"). The loop only **starts** the GPU readback (`Gfx::start_read_back`:
//! `glReadPixels` into a pixel-pack buffer + a fence — the picture as of the request, GL runs
//! commands in order), polls the fence on later iterations ([`Capturer::pump`]: after every
//! dispatch, and on a 1 ms timer while one is on the GPU) and, once the copy is done, maps the
//! buffer and hands the mapping to one `lia-capture` thread, which encodes and writes the PNG
//! straight from it. The loop then unmaps the buffer (kept for the next capture of that size,
//! freed after [`SPARE_IDLE`]) and sends the reply — deferred until the file is complete (like
//! `step`'s: the client's later requests wait behind it, per-client FIFO).
//!
//! Every GL call stays on the loop's context: a second context on another thread (tried: a
//! GPU copy read back on `lia-capture`'s own shared context) stalled the loop 29–47 ms — the
//! NVIDIA driver's process-wide lock around the new context's first `eglMakeCurrent`.
//!
//! Before (Task 13): readback + encode on the loop — 39–112 ms (release, fdeflate `Fast`) /
//! 810 ms (debug) for a 3840×1080 frame, every output frozen; a synchronous readback alone is
//! 1.6–10 ms (the GPU wait + a 16 MB copy into fresh pages).

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::gfx::{Gfx, MappedPixels, PackBuffer, PendingReadback};
use crate::graph::ApiError;

/// A pixel-pack buffer unused this long is freed (3840×1080: 16 MB of pinned memory).
pub const SPARE_IDLE: Duration = Duration::from_secs(10);

/// One capture being made: who asked, where to, its readback.
struct Entry {
    key: u64,
    client: u64,
    id: Value,
    path: PathBuf,
    readback: PendingReadback,
    /// Mapped and handed to `lia-capture`.
    sent: bool,
    /// Written (the result), waiting for the loop to unmap the buffer and reply.
    result: Option<Result<Value, ApiError>>,
}

/// A mapped readback for `lia-capture` to encode.
struct Job {
    key: u64,
    path: PathBuf,
    pixels: MappedPixels,
}

/// A finished capture: the reply for `client`'s request `id`.
pub struct Done {
    pub client: u64,
    pub id: Value,
    pub result: Result<Value, ApiError>,
}

type Results = Arc<Mutex<Vec<(u64, Result<Value, ApiError>)>>>;

/// The `lia-capture` thread + the captures in flight.
pub struct Capturer {
    wake: Arc<dyn Fn() + Send + Sync>,
    tx: Option<mpsc::Sender<Job>>,
    thread: Option<JoinHandle<()>>,
    /// No thread could be started: encode on the loop (as before this existed).
    inline: bool,
    results: Results,
    entries: Vec<Entry>,
    next_key: u64,
    /// The last finished capture's buffer, for the next one (the driver pins a new one's
    /// memory at its first use: 2.7–7.6 ms on the loop for 3840×1080), and when it was freed.
    spare: Option<(PackBuffer, Instant)>,
}

impl Capturer {
    /// `wake` is called (from `lia-capture`) whenever a file was written.
    pub fn new(wake: Arc<dyn Fn() + Send + Sync>) -> Capturer {
        Capturer {
            wake,
            tx: None,
            thread: None,
            inline: false,
            results: Arc::new(Mutex::new(Vec::new())),
            entries: Vec::new(),
            next_key: 0,
            spare: None,
        }
    }

    /// The spare buffer for [`Gfx::start_read_back`] (taken: one capture uses it).
    pub fn take_spare(&mut self) -> Option<PackBuffer> {
        self.spare.take().map(|(b, _)| b)
    }

    /// A readback started for `client`'s request `id`, to be written to `path`; its reply
    /// comes from [`Capturer::take_done`] once the file is complete.
    pub fn submit(&mut self, client: u64, id: Value, path: PathBuf, readback: PendingReadback) {
        self.next_key += 1;
        self.entries.push(Entry {
            key: self.next_key,
            client,
            id,
            path,
            readback,
            sent: false,
            result: None,
        });
    }

    /// Whether `client`'s request `id` is a capture still being made.
    pub fn pending_for(&self, client: u64, id: &Value) -> bool {
        self.entries
            .iter()
            .any(|e| e.client == client && e.id == *id)
    }

    /// Captures in flight (probes).
    pub fn in_flight(&self) -> usize {
        self.entries.len()
    }

    /// A readback is still on the GPU (the loop polls its fence).
    pub fn waiting_gpu(&self) -> bool {
        self.entries.iter().any(|e| !e.sent)
    }

    /// Hand every readback whose GPU copy is done to `lia-capture` (never waits; `wait` only
    /// at shutdown).
    pub fn pump(&mut self, gfx: &Gfx, wait: Option<Duration>) {
        for i in 0..self.entries.len() {
            if self.entries[i].sent {
                continue;
            }
            let Some(pixels) = gfx.map_read_back(&mut self.entries[i].readback, wait) else {
                continue;
            };
            self.entries[i].sent = true;
            let (key, path) = (self.entries[i].key, self.entries[i].path.clone());
            if let Some(job) = self.send(Job { key, path, pixels }) {
                // no thread: encode here (the loop stalls for it, as before)
                let r = write(&job.path, &job.pixels);
                drop(job);
                self.entries[i].result = Some(r);
            }
        }
    }

    /// Send `job` to `lia-capture` (started on first use); `Some(job)` back = no thread.
    fn send(&mut self, job: Job) -> Option<Job> {
        if self.inline {
            return Some(job);
        }
        if self.tx.is_none() {
            let (tx, rx) = mpsc::channel::<Job>();
            let (results, wake) = (self.results.clone(), self.wake.clone());
            match std::thread::Builder::new()
                .name("lia-capture".into())
                .spawn(move || run(rx, results, wake))
            {
                Ok(t) => {
                    self.tx = Some(tx);
                    self.thread = Some(t);
                }
                Err(_) => {
                    self.inline = true;
                    return Some(job);
                }
            }
        }
        let tx = self.tx.as_ref()?;
        match tx.send(job) {
            Ok(()) => None,
            Err(mpsc::SendError(job)) => {
                self.inline = true;
                Some(job)
            }
        }
    }

    /// Every capture whose file is written — its buffer unmapped (on the loop's context,
    /// after `lia-capture` dropped its view) and kept as the spare — in completion order.
    pub fn take_done(&mut self, gfx: &Gfx) -> Vec<Done> {
        let finished = std::mem::take(&mut *self.results.lock().unwrap_or_else(|e| e.into_inner()));
        for (key, r) in finished {
            if let Some(e) = self.entries.iter_mut().find(|e| e.key == key) {
                e.result = Some(r);
            }
        }
        let mut done = Vec::new();
        let mut i = 0;
        while i < self.entries.len() {
            if self.entries[i].result.is_none() {
                i += 1;
                continue;
            }
            let e = self.entries.remove(i);
            let buf = gfx.end_read_back(e.readback);
            if let Some((old, _)) = self.spare.replace((buf, Instant::now())) {
                gfx.free_pack_buffer(old);
            }
            done.push(Done {
                client: e.client,
                id: e.id,
                result: e.result.expect("checked"),
            });
        }
        done
    }

    /// Free the spare buffer once unused for [`SPARE_IDLE`].
    pub fn expire_spare(&mut self, gfx: &Gfx) {
        if self
            .spare
            .as_ref()
            .is_some_and(|(_, t)| t.elapsed() >= SPARE_IDLE)
            && let Some((b, _)) = self.spare.take()
        {
            gfx.free_pack_buffer(b);
        }
    }

    /// Quit: every capture still in flight is written (each bounded by its GPU copy, ≤ 1 s,
    /// and its encode), the thread stopped, every buffer freed.
    pub fn shutdown(&mut self, gfx: &Gfx) {
        self.pump(gfx, Some(Duration::from_secs(1)));
        self.tx = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        let _ = self.take_done(gfx);
        for e in self.entries.drain(..) {
            // never mapped: its GPU copy didn't finish
            let b = gfx.end_read_back(e.readback);
            gfx.free_pack_buffer(b);
        }
        if let Some((b, _)) = self.spare.take() {
            gfx.free_pack_buffer(b);
        }
    }
}

fn write(path: &std::path::Path, pixels: &MappedPixels) -> Result<Value, ApiError> {
    let shown = path.display().to_string();
    pixels
        .write_png(path)
        .map(|()| json!({ "path": shown, "width": pixels.w, "height": pixels.h }))
        .map_err(|e| ApiError {
            code: "io",
            message: format!("writing {shown}: {e}"),
            hint: "check the directory exists and is writable".into(),
        })
}

fn run(rx: mpsc::Receiver<Job>, results: Results, wake: Arc<dyn Fn() + Send + Sync>) {
    while let Ok(job) = rx.recv() {
        let r = write(&job.path, &job.pixels);
        let key = job.key;
        drop(job); // the mapping is the loop's to unmap from here on
        results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((key, r));
        wake();
    }
}
