//! R51 — mpv core teardown off the render thread. `MpvSource::drop` frees its render
//! context on the GL thread (it must: GL current, before the core) and hands the core
//! here; one background thread runs `mpv_terminate_destroy` (measured 30–240 ms for a
//! playing 1080p clip — never on the loop). `quit` calls [`shutdown`] with a bounded wait
//! and logs any straggler. After each batch of destroyed cores it runs
//! `mem::trim_after_reap` (Task 20b: `malloc_trim(0)`, the allocator policy's second half)
//! — never once shutdown has started, and a straggler is a core not destroyed yet, never a
//! trim still running (TODO "Reaper trim at shutdown").

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

/// The mpv cores' reaper (started on first use).
static REAPER: Reaper<Doomed> = Reaper::new("lia-mpv-reaper", trim_batch);

/// Task 20b: give the pages a batch of destroyed cores freed back (`mem::apply_policy`).
fn trim_batch() {
    if let Some((released, ms)) = crate::mem::trim_after_reap() {
        log::event(
            "mpv",
            Level::Debug,
            "mpv.trimmed",
            None,
            json!({
                "ms": ms,
                "released": released,
                "rss_kib": crate::mem::proc_status().rss_kib,
            }),
        );
    }
}

struct Worker<T> {
    tx: Sender<T>,
    done: Receiver<()>,
    thread: JoinHandle<()>,
}

/// One background thread that drops whatever it is handed, in order, then runs
/// `after_batch` once its queue is empty. The mpv cores' instance is [`REAPER`]; the type
/// is generic so its shutdown rules are unit-tested with slow fakes.
pub(crate) struct Reaper<T: Send + 'static> {
    name: &'static str,
    after_batch: fn(),
    worker: Mutex<Option<Worker<T>>>,
    shut_down: AtomicBool,
    /// Handed over and not yet destroyed + `after_batch`ed.
    pending: AtomicUsize,
    /// Handed over and not yet destroyed — what [`Self::shutdown`] reports (a core whose
    /// batch trim still runs is destroyed: no straggler).
    undestroyed: AtomicUsize,
}

impl<T: Send + 'static> Reaper<T> {
    pub(crate) const fn new(name: &'static str, after_batch: fn()) -> Reaper<T> {
        Reaper {
            name,
            after_batch,
            worker: Mutex::new(None),
            shut_down: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            undestroyed: AtomicUsize::new(0),
        }
    }

    fn spawn(&'static self) -> Option<Worker<T>> {
        let (tx, rx) = mpsc::channel::<T>();
        let (done_tx, done) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name(self.name.into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut next = Some(first);
                    let mut batch = 0usize;
                    while let Some(d) = next.take() {
                        let t = Instant::now();
                        drop(d);
                        self.undestroyed.fetch_sub(1, Ordering::SeqCst);
                        batch += 1;
                        log::event(
                            "mpv",
                            Level::Debug,
                            "mpv.reaped",
                            None,
                            json!({ "ms": t.elapsed().as_secs_f64() * 1000.0 }),
                        );
                        next = rx.try_recv().ok();
                    }
                    // TODO "Reaper trim at shutdown": once shutdown has started the process
                    // is exiting — giving pages back is pointless, and `quit`'s bounded wait
                    // would cover the trim too.
                    if !self.shut_down.load(Ordering::SeqCst) {
                        (self.after_batch)();
                    }
                    // Only now: `pending() == 0` means destroyed AND trimmed (the t20b test
                    // waits on it, deterministically).
                    self.pending.fetch_sub(batch, Ordering::SeqCst);
                }
                let _ = done_tx.send(());
            })
            .ok()?;
        Some(Worker { tx, done, thread })
    }

    /// Drop `item` on the reaper thread (started on first use). After [`Self::shutdown`],
    /// or if the thread can't be started, it's dropped right here instead.
    pub(crate) fn reap(&'static self, item: T) {
        let mut g = self.worker.lock().unwrap_or_else(|e| e.into_inner());
        if !self.shut_down.load(Ordering::SeqCst) && g.is_none() {
            *g = self.spawn();
        }
        let Some(w) = g.as_ref() else {
            drop(g);
            drop(item);
            return;
        };
        self.pending.fetch_add(1, Ordering::SeqCst);
        self.undestroyed.fetch_add(1, Ordering::SeqCst);
        if let Err(mpsc::SendError(d)) = w.tx.send(item) {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            self.undestroyed.fetch_sub(1, Ordering::SeqCst);
            drop(g);
            drop(d);
        }
    }

    /// Items handed over and not dropped (+ their batch's `after_batch` run) yet.
    pub(crate) fn pending(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    /// Stop accepting items and wait up to `timeout` for every queued one to be dropped.
    /// Returns how many are still not dropped when the wait ends (0 = all done — a batch's
    /// `after_batch` still running doesn't count, and none starts once this is called);
    /// later [`Self::reap`]s drop synchronously.
    pub(crate) fn shutdown(&self, timeout: Duration) -> usize {
        self.shut_down.store(true, Ordering::SeqCst);
        let w = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(Worker { tx, done, thread }) = w {
            drop(tx); // the thread's loop ends once the queue is empty
            if done.recv_timeout(timeout).is_ok() {
                let _ = thread.join();
            }
        }
        self.undestroyed.load(Ordering::SeqCst)
    }
}

/// Destroy `h` on the reaper thread (started on first use). After [`shutdown`], or if
/// the thread can't be started, it's destroyed right here instead.
pub(crate) fn reap(h: Handle) {
    REAPER.reap(Doomed { _core: h });
}

/// Cores handed to the reaper and not destroyed (+ their batch's `malloc_trim` run) yet (probes).
pub fn pending() -> usize {
    REAPER.pending()
}

/// Stop accepting cores and wait up to `timeout` for every queued one to be destroyed.
/// Returns how many are still being destroyed when the wait ends (0 = all done; no batch is
/// trimmed once this is called, and one mid-trim doesn't count); later [`reap`]s destroy
/// synchronously.
pub fn shutdown(timeout: Duration) -> usize {
    REAPER.shutdown(timeout)
}

#[cfg(test)]
mod tests {
    use super::Reaper;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    /// Dropping it takes `.0` (a slow `mpv_terminate_destroy`).
    struct Slow(Duration);

    impl Drop for Slow {
        fn drop(&mut self) {
            std::thread::sleep(self.0);
        }
    }

    fn leak(after_batch: fn()) -> &'static Reaper<Slow> {
        Box::leak(Box::new(Reaper::new("lia-reaper-test", after_batch)))
    }

    static TRIMS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
    fn slow_trim_in_flight() {
        TRIMS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(400));
    }

    /// TODO "Reaper trim at shutdown": a core already destroyed whose batch trim is still
    /// running when `quit` waits is not a straggler (RED before: `pending` dropped only
    /// after the trim, so the wait reported 1).
    #[test]
    fn a_trim_in_flight_at_shutdown_is_no_straggler() {
        let r = leak(slow_trim_in_flight);
        r.reap(Slow(Duration::ZERO));
        let t = Instant::now();
        while TRIMS_IN_FLIGHT.load(Ordering::SeqCst) == 0 {
            assert!(t.elapsed() < Duration::from_secs(5), "the trim never ran");
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            r.shutdown(Duration::from_millis(50)),
            0,
            "a destroyed core whose trim still runs counted as a straggler"
        );
        // `pending` keeps counting it until the trim is done (t20b waits on that).
        assert_eq!(r.pending(), 1);
    }

    static TRIMS_AFTER_SHUTDOWN: AtomicUsize = AtomicUsize::new(0);
    fn slow_trim_after_shutdown() {
        TRIMS_AFTER_SHUTDOWN.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(400));
    }

    /// TODO "Reaper trim at shutdown": a batch that finishes once shutdown has started
    /// isn't trimmed — the process is exiting, and the wait would cover the trim too (RED
    /// before: 200 ms destroy + 400 ms trim waited, 1 trim).
    #[test]
    fn no_trim_once_shutdown_started() {
        let r = leak(slow_trim_after_shutdown);
        r.reap(Slow(Duration::from_millis(200)));
        std::thread::sleep(Duration::from_millis(20)); // the reaper is inside the drop
        let t = Instant::now();
        assert_eq!(r.shutdown(Duration::from_secs(2)), 0);
        let waited = t.elapsed();
        assert!(
            waited < Duration::from_millis(350),
            "shutdown waited {waited:?} for a trim"
        );
        assert_eq!(TRIMS_AFTER_SHUTDOWN.load(Ordering::SeqCst), 0);
        assert_eq!(r.pending(), 0);
    }

    fn no_trim() {}

    /// A destroy slower than the wait is still a straggler (the `_exit` path needs it).
    #[test]
    fn a_destroy_slower_than_the_wait_is_a_straggler() {
        let r = leak(no_trim);
        r.reap(Slow(Duration::from_millis(500)));
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(r.shutdown(Duration::from_millis(50)), 1);
    }

    static TRIMS: AtomicUsize = AtomicUsize::new(0);
    fn count_trim() {
        TRIMS.fetch_add(1, Ordering::SeqCst);
    }

    /// Normal operation: a batch is trimmed once, after its last item, and `pending` reaches
    /// 0 only after that trim; after shutdown a reap drops synchronously.
    #[test]
    fn batches_trim_once_and_reap_after_shutdown_is_synchronous() {
        let r = leak(count_trim);
        for _ in 0..3 {
            r.reap(Slow(Duration::from_millis(5)));
        }
        let t = Instant::now();
        while r.pending() > 0 {
            assert!(t.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(1));
        }
        let trims = TRIMS.load(Ordering::SeqCst);
        assert!((1..=3).contains(&trims), "{trims} trims for 3 items");
        assert_eq!(r.shutdown(Duration::from_secs(1)), 0);
        let t = Instant::now();
        r.reap(Slow(Duration::from_millis(30)));
        assert!(
            t.elapsed() >= Duration::from_millis(30),
            "dropped synchronously"
        );
        assert_eq!(r.pending(), 0);
    }
}
