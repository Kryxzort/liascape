//! Real-time scheduling for the player's PipeWire graph threads (`lia-rt`).
//!
//! Every PipeWire context in this process (the bus's, each mpv AO's) runs its graph on a
//! `data-loop.*` thread, which libpipewire's `module-rt` asks rtkit to make real-time once, as
//! the thread starts. `module-rt` is loaded `nofail`, and rtkit refuses a user's requests past
//! 25 in 20 s (`actions-per-burst-max` / `actions-burst-sec`: a session login, many graph clients
//! starting at once), so a thread started inside such a burst silently stays SCHED_OTHER for its
//! whole life — and loses graph cycles (audible holes) whenever the CPU is busy.
//!
//! The watcher reads every data thread's policy off `/proc/self/task` once a [`POLL`]. A thread
//! still SCHED_OTHER [`SETTLE`] after it was first seen counts as refused ([`RtInfo`], in
//! `hello.health.realtime` and the `bus` probe); it is asked for again through rtkit's
//! `MakeThreadRealtimeWithPID` on the [`BACKOFF`] ladder: first past the burst window that
//! refused it, a few more times, then every few minutes, until it is granted or gone. One request
//! per refused thread per step, so the retries can never make a burst themselves.
//! Guard: `src/player/tests/api.rs` `a_graph_thread_refused_real_time_asks_rtkit_again`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use crate::log::{self, Level};

/// How often the thread policies are read.
const POLL: Duration = Duration::from_secs(1);
/// `module-rt`'s own request is one D-Bus round trip after the thread starts: a thread is only
/// counted as refused once it has been SCHED_OTHER this long.
const SETTLE: Duration = Duration::from_secs(2);
/// The wait before each new request for a refused thread, from when it was seen refused; the
/// last step repeats. The first is past rtkit's 20 s burst window, which a refusal means is
/// still running.
const BACKOFF: [Duration; 5] = [
    Duration::from_secs(21),
    Duration::from_secs(21),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(300),
];
/// `module-rt`'s default `rt.prio`; rtkit's `MaxRealtimePriority` caps it (20 by default).
const RT_PRIO: i32 = 88;
/// How long one rtkit call may take (the watcher's thread is the only one waiting).
const DBUS_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether the process's graph threads run real-time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RtState {
    /// No PipeWire graph thread yet (no connection).
    Unknown,
    /// Every graph thread is SCHED_FIFO / SCHED_RR.
    On,
    /// At least one runs SCHED_OTHER (refused): being asked for again.
    Off,
}

/// The watcher's report.
#[derive(Debug, Clone, Serialize)]
pub struct RtInfo {
    pub state: RtState,
    /// PipeWire graph threads (`data-loop.*`) in the process.
    pub threads: usize,
    /// Of those, the ones refused real-time (SCHED_OTHER past [`SETTLE`]).
    pub off: usize,
    /// Requests made so far for the most-asked thread that is still off.
    pub attempts: u32,
    /// When the next request goes out, ms from now (while `off`).
    pub next_attempt_ms: Option<u64>,
    /// Why the last request failed (rtkit's error, no system bus, …).
    pub reason: Option<String>,
}

/// The running watcher; dropping it stops the thread (within a [`POLL`], or a D-Bus call).
pub struct RtWatch {
    info: Arc<Mutex<RtInfo>>,
    _stop: mpsc::Sender<()>,
}

impl RtWatch {
    pub fn start() -> Option<RtWatch> {
        let info = Arc::new(Mutex::new(RtInfo {
            state: RtState::Unknown,
            threads: 0,
            off: 0,
            attempts: 0,
            next_attempt_ms: None,
            reason: None,
        }));
        let (tx, rx) = mpsc::channel();
        let i = info.clone();
        std::thread::Builder::new()
            .name("lia-rt".into())
            .spawn(move || run(&i, &rx))
            .ok()?;
        Some(RtWatch { info, _stop: tx })
    }

    pub fn info(&self) -> RtInfo {
        self.info.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// A refused thread's ladder.
struct Refused {
    since: Instant,
    attempts: u32,
    next: Instant,
}

fn run(info: &Mutex<RtInfo>, stop: &mpsc::Receiver<()>) {
    let pid = std::process::id();
    let mut refused: HashMap<u32, Refused> = HashMap::new();
    let mut state = RtState::Unknown;
    let mut reason: Option<String> = None;
    while let Err(mpsc::RecvTimeoutError::Timeout) = stop.recv_timeout(POLL) {
        let now = Instant::now();
        let threads = data_threads(pid);
        refused.retain(|tid, _| threads.iter().any(|(t, rt)| t == tid && !rt));
        for (tid, _) in threads.iter().filter(|(_, rt)| !rt) {
            refused.entry(*tid).or_insert(Refused {
                since: now,
                attempts: 0,
                next: now + BACKOFF[0],
            });
        }
        let due: Vec<u32> = refused
            .iter()
            .filter(|(_, r)| now >= r.next)
            .map(|(tid, _)| *tid)
            .collect();
        if !due.is_empty() {
            let rtkit = Rtkit::connect();
            for tid in due {
                let Some(r) = refused.get_mut(&tid) else {
                    continue;
                };
                r.attempts += 1;
                r.next = now + BACKOFF[(r.attempts as usize).min(BACKOFF.len() - 1)];
                let res = rtkit
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|k| k.make_realtime(pid, tid));
                log::event(
                    "audio",
                    if res.is_ok() {
                        Level::Info
                    } else {
                        Level::Warn
                    },
                    "audio.rt.retry",
                    None,
                    json!({ "tid": tid, "attempt": r.attempts, "granted": res.is_ok(),
                            "reason": res.as_ref().err() }),
                );
                match res {
                    Ok(()) => {
                        refused.remove(&tid);
                    }
                    Err(e) => reason = Some(e),
                }
            }
        }
        let off: Vec<&Refused> = refused
            .values()
            .filter(|r| now.duration_since(r.since) >= SETTLE)
            .collect();
        let next = match (threads.is_empty(), off.is_empty()) {
            (true, _) => RtState::Unknown,
            (false, true) => RtState::On,
            (false, false) => RtState::Off,
        };
        if next != state {
            match next {
                RtState::Off => log::event(
                    "audio",
                    Level::Warn,
                    "audio.rt.off",
                    None,
                    json!({ "threads": threads.len(), "off": off.len(),
                            "retry_in_ms": BACKOFF[0].saturating_sub(SETTLE).as_millis() as u64 }),
                ),
                RtState::On if state == RtState::Off => {
                    log::event("audio", Level::Info, "audio.rt.on", None, json!({}))
                }
                _ => {}
            }
            if next != RtState::Off {
                reason = None;
            }
            state = next;
        }
        let mut g = info.lock().unwrap_or_else(|e| e.into_inner());
        *g = RtInfo {
            state,
            threads: threads.len(),
            off: off.len(),
            attempts: off.iter().map(|r| r.attempts).max().unwrap_or(0),
            next_attempt_ms: off
                .iter()
                .map(|r| r.next.saturating_duration_since(now).as_millis() as u64)
                .min(),
            reason: reason.clone(),
        };
    }
}

/// Every PipeWire graph thread of `pid` (`data-loop.*`) and whether it runs real-time.
fn data_threads(pid: u32) -> Vec<(u32, bool)> {
    let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    dir.flatten()
        .filter(|t| {
            std::fs::read_to_string(t.path().join("comm"))
                .is_ok_and(|c| c.trim().starts_with("data-loop"))
        })
        .filter_map(|t| {
            let tid: i32 = t.file_name().to_str()?.parse().ok()?;
            // SAFETY: a plain query; a thread that just exited is -1 (skipped).
            let p = unsafe { libc::sched_getscheduler(tid) };
            (p >= 0).then(|| {
                let p = p & !libc::SCHED_RESET_ON_FORK;
                (tid as u32, p == libc::SCHED_FIFO || p == libc::SCHED_RR)
            })
        })
        .collect()
}

/// `org.freedesktop.RealtimeKit1` on the system bus, with its limits read once per step.
struct Rtkit {
    conn: zbus::blocking::Connection,
    prio: u32,
}

const RTKIT: &str = "org.freedesktop.RealtimeKit1";
const RTKIT_PATH: &str = "/org/freedesktop/RealtimeKit1";

impl Rtkit {
    fn connect() -> Result<Rtkit, String> {
        let conn = zbus::blocking::connection::Builder::system()
            .map(|b| b.method_timeout(DBUS_TIMEOUT))
            .and_then(|b| b.build())
            .map_err(|e| format!("no system D-Bus: {e}"))?;
        let k = Rtkit { conn, prio: 0 };
        let max_prio: i32 = k.property("MaxRealtimePriority")?;
        let rttime: i64 = k.property("RTTimeUSecMax")?;
        limit_rttime(rttime)?;
        Ok(Rtkit {
            prio: RT_PRIO.min(max_prio).max(1) as u32,
            ..k
        })
    }

    fn property<T: TryFrom<zbus::zvariant::OwnedValue>>(&self, name: &str) -> Result<T, String> {
        let reply = self
            .conn
            .call_method(
                Some(RTKIT),
                RTKIT_PATH,
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &(RTKIT, name),
            )
            .map_err(|e| format!("rtkit {name}: {e}"))?;
        let v: zbus::zvariant::OwnedValue = reply
            .body()
            .deserialize()
            .map_err(|e| format!("rtkit {name}: {e}"))?;
        T::try_from(v).map_err(|_| format!("rtkit {name}: unexpected type"))
    }

    fn make_realtime(&self, pid: u32, tid: u32) -> Result<(), String> {
        self.conn
            .call_method(
                Some(RTKIT),
                RTKIT_PATH,
                Some(RTKIT),
                "MakeThreadRealtimeWithPID",
                &(u64::from(pid), u64::from(tid), self.prio),
            )
            .map(|_| ())
            .map_err(|e| format!("rtkit refused: {e}"))
    }
}

/// rtkit grants real-time only to a process whose `RLIMIT_RTTIME` is at most its
/// `RTTimeUSecMax` (a runaway RT thread is then killed by the kernel, not the desktop frozen);
/// `module-rt` lowers it the same way before its own request.
fn limit_rttime(max_us: i64) -> Result<(), String> {
    let max = max_us.max(0) as libc::rlim_t;
    let mut cur = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: plain get/setrlimit on this process.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_RTTIME, &mut cur) != 0 {
            return Err(format!(
                "getrlimit(RTTIME): {}",
                std::io::Error::last_os_error()
            ));
        }
        if cur.rlim_max != libc::RLIM_INFINITY && cur.rlim_max <= max && cur.rlim_cur <= max {
            return Ok(());
        }
        let new = libc::rlimit {
            rlim_cur: cur.rlim_cur.min(max),
            rlim_max: cur.rlim_max.min(max),
        };
        if libc::setrlimit(libc::RLIMIT_RTTIME, &new) != 0 {
            return Err(format!(
                "setrlimit(RTTIME): {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}
