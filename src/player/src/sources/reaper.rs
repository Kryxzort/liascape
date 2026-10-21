//! R51 — mpv core teardown off the render thread. `MpvSource::drop` frees its render
//! context on the GL thread (it must: GL current, before the core) and hands the core
//! here; one background thread runs `mpv_terminate_destroy` (measured 30–240 ms for a
//! playing 1080p clip — never on the loop). `quit` calls [`shutdown`] with a bounded wait
//! and logs any straggler.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::log::{self, Level};
use crate::mpv::Handle;

/// A core nobody uses any more: its render context is freed and its wakeup callback
/// cleared before it gets here.
struct Doomed {
    _core: Handle,
}

// SAFETY: libmpv's client API is thread-safe (client.h: every function may be called from
// any thread unless noted, and `mpv_terminate_destroy` isn't restricted); a handle moved
// here is never touched by its old owner again, so destroying it on this thread races
// nothing.
unsafe impl Send for Doomed {}

struct Reaper {
    tx: Sender<Doomed>,
    done: Receiver<()>,
    thread: JoinHandle<()>,
}

static REAPER: Mutex<Option<Reaper>> = Mutex::new(None);
static SHUT_DOWN: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicUsize = AtomicUsize::new(0);

fn spawn() -> Option<Reaper> {
    let (tx, rx) = mpsc::channel::<Doomed>();
    let (done_tx, done) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("lp-mpv-reaper".into())
        .spawn(move || {
            for d in rx {
                let t = Instant::now();
                drop(d);
                PENDING.fetch_sub(1, Ordering::SeqCst);
                log::event(
                    "mpv",
                    Level::Debug,
                    "mpv.reaped",
                    None,
                    json!({ "ms": t.elapsed().as_secs_f64() * 1000.0 }),
                );
            }
            let _ = done_tx.send(());
        })
        .ok()?;
    Some(Reaper { tx, done, thread })
}

/// Destroy `h` on the reaper thread (started on first use). After [`shutdown`], or if
/// the thread can't be started, it's destroyed right here instead.
pub(crate) fn reap(h: Handle) {
    let mut g = REAPER.lock().unwrap_or_else(|e| e.into_inner());
    if !SHUT_DOWN.load(Ordering::SeqCst) && g.is_none() {
        *g = spawn();
    }
    let Some(r) = g.as_ref() else {
        drop(g);
        drop(h);
        return;
    };
    PENDING.fetch_add(1, Ordering::SeqCst);
    if let Err(mpsc::SendError(d)) = r.tx.send(Doomed { _core: h }) {
        PENDING.fetch_sub(1, Ordering::SeqCst);
        drop(g);
        drop(d);
    }
}

/// Cores handed to the reaper and not destroyed yet (probes).
pub fn pending() -> usize {
    PENDING.load(Ordering::SeqCst)
}

/// Stop accepting cores and wait up to `timeout` for every queued one to be destroyed.
/// Returns how many are still being destroyed when the wait ends (0 = all done); later
/// [`reap`]s destroy synchronously.
pub fn shutdown(timeout: Duration) -> usize {
    SHUT_DOWN.store(true, Ordering::SeqCst);
    let r = REAPER.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(Reaper { tx, done, thread }) = r {
        drop(tx); // the thread's loop ends once the queue is empty
        if done.recv_timeout(timeout).is_ok() {
            let _ = thread.join();
        }
    }
    pending()
}
