//! The spare scene worker (`docs/player/modules/scene-worker.md` § The spare worker): one
//! `liascape-scene-worker` started ahead of time, its GL context up, waiting for the next scene
//! source to [`take`](Spare::take) it, so a scene apply skips the spawn → `Hello` (exec and
//! dynamic link ~35 ms, EGL ~75–85 ms).
//!
//! **Policy** ([`Spare::maintain`], run from `SourceHost::sync`): at most one, and only while
//! - `player.scene_spare` is on and scenes can play here (a worker binary, WE's assets or the
//!   synthetic test scenes);
//! - scenes are in use: a scene worker was started since the player started or last stopped
//!   (`stop`), and a scene source was hosted within [`Timing::idle_after`] — a player that only
//!   ever plays videos never pays for a spare;
//! - media aren't suspended by the low-VRAM rule's `stop` mode.
//!
//! A taken spare is replaced once nothing competes with the new one's start: no scene loading,
//! no transition in flight, [`Timing::refill_after`] since the last take — the spare's own EGL
//! setup is CPU and driver time the scene the user waits for would otherwise share. A spare
//! launched differently from what a scene would launch now (`player.scene_fonts` changed: the
//! worker hands its fonts to fontconfig at start; another worker binary) is reaped at once, so
//! no scene ever starts in a stale one, and replaced by the same rule. A spare that dies, hangs or can't make a context is
//! no crash of anything: no restart budget, no crash record, no scene marked broken; the next
//! one starts after a backoff ([`Timing::retry`], doubling to [`Timing::retry_max`]).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::proto::FromWorker;
use super::{WorkerEvent, WorkerHost, WorkerSpec, WorkerState};
use crate::log::{self, Level};

/// The pool every scene source of a `SourceHost` shares.
pub type SharedSpare = Arc<Mutex<Spare>>;

/// Locks the pool (a poisoned lock still holds a usable pool: nothing in it panics halfway).
pub fn lock(s: &SharedSpare) -> std::sync::MutexGuard<'_, Spare> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a worker process is started with — a spare serves only a scene whose launch is the
/// same, since a running worker can't take another environment (its fonts are fontconfig's).
#[derive(Debug, Clone, PartialEq)]
pub struct Launch {
    pub bin: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl Launch {
    pub fn of(spec: &WorkerSpec) -> Launch {
        Launch {
            bin: spec.bin.clone(),
            args: spec.args.clone(),
            env: spec.env.clone(),
        }
    }
}

/// `LIASCAPE_PLAYER_SPARE_TIMING=<refill_ms>,<idle_ms>,<retry_ms>,<retry_max_ms>` (tests).
pub const TIMING_ENV: &str = "LIASCAPE_PLAYER_SPARE_TIMING";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    /// After a take, the next spare waits at least this long (and for the loads and
    /// transitions to finish).
    pub refill_after: Duration,
    /// No scene source hosted this long → scenes are no longer in use: the spare goes.
    pub idle_after: Duration,
    /// After a spare failed, the next starts this much later, doubling per failure in a row…
    pub retry: Duration,
    /// …up to this.
    pub retry_max: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            refill_after: Duration::from_secs(2),
            idle_after: Duration::from_secs(30 * 60),
            retry: Duration::from_secs(5),
            retry_max: Duration::from_secs(300),
        }
    }
}

impl Timing {
    /// The defaults with [`TIMING_ENV`]'s values (a missing or bad field keeps its default).
    pub fn from_env(v: Option<&str>) -> Timing {
        let mut t = Timing::default();
        let Some(v) = v else { return t };
        let f: Vec<Option<u64>> = v.split(',').map(|x| x.trim().parse().ok()).collect();
        let at = |i: usize| f.get(i).copied().flatten().map(Duration::from_millis);
        t.refill_after = at(0).unwrap_or(t.refill_after);
        t.idle_after = at(1).unwrap_or(t.idle_after);
        t.retry = at(2).unwrap_or(t.retry);
        t.retry_max = at(3).unwrap_or(t.retry_max).max(t.retry);
        t
    }
}

/// What the pool is told each sync.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Want {
    /// `player.scene_spare`.
    pub enabled: bool,
    /// How a scene worker is launched now; `None` = scenes can't play here.
    pub launch: Option<Launch>,
    /// The hang timeout scene workers get (the spare's heartbeat until it is taken).
    pub hang_timeout: Duration,
    /// The low-VRAM rule's `stop` holds every media source.
    pub suspended: bool,
    /// A scene source is hosted now.
    pub scenes_hosted: bool,
    /// Nothing competes with a new spare's start: no scene loading, no transition in flight.
    pub quiet: bool,
}

#[derive(Debug, Default, Clone, Copy)]
struct Stats {
    spawned: u64,
    adopted: u64,
    replaced: u64,
    failed: u64,
    reaped: u64,
}

pub struct Spare {
    timing: Timing,
    host: Option<WorkerHost>,
    /// A scene worker was started since the player started or last stopped.
    in_use: bool,
    last_scene: Option<Instant>,
    last_take: Option<Instant>,
    /// Spares that failed in a row, and when the next may start.
    failures: u32,
    retry_at: Option<Instant>,
    /// Why there is no spare now (the probe).
    why_none: &'static str,
    last: Want,
    stats: Stats,
}

impl Default for Spare {
    fn default() -> Self {
        Spare::new(Timing::from_env(std::env::var(TIMING_ENV).ok().as_deref()))
    }
}

impl Spare {
    pub fn new(timing: Timing) -> Spare {
        Spare {
            timing,
            host: None,
            in_use: false,
            last_scene: None,
            last_take: None,
            failures: 0,
            retry_at: None,
            why_none: "off",
            last: Want::default(),
            stats: Stats::default(),
        }
    }

    pub fn shared() -> SharedSpare {
        Arc::new(Mutex::new(Spare::default()))
    }

    /// A scene source starts a worker for `spec`: the spare if there is one launched the same
    /// way and alive (`Ok`, adopted: [`WorkerHost::adopt`]), else `Err(spec)` back — the
    /// caller spawns its own. Either way scenes are in use from now on.
    pub fn take(&mut self, spec: WorkerSpec, now: Instant) -> Result<WorkerHost, WorkerSpec> {
        self.in_use = true;
        self.last_take = Some(now);
        self.last_scene = Some(now);
        let Some(mut h) = self.host.take() else {
            return Err(spec);
        };
        // What happened to it since the last sync (a death, its `Hello`) counts first.
        if self.on_events(&mut h, now) {
            return Err(spec);
        }
        match h.adopt(spec) {
            Ok(()) => {
                self.stats.adopted += 1;
                self.failures = 0;
                self.why_none = "taken";
                Ok(h)
            }
            Err(spec) => {
                // Launched for another setting: `maintain` starts a matching one.
                self.host = Some(h);
                Err(spec)
            }
        }
    }

    /// Keep the pool as the policy says (module docs). Never blocks: a spawn is a
    /// `posix_spawn` on this (the loop) thread, a reap goes to the reaper thread.
    pub fn maintain(&mut self, want: Want, now: Instant) {
        if want.scenes_hosted {
            self.last_scene = Some(now);
        }
        if self.in_use
            && !want.scenes_hosted
            && self
                .last_scene
                .is_some_and(|t| now.saturating_duration_since(t) >= self.timing.idle_after)
        {
            self.in_use = false;
        }
        let why_not = if !want.enabled {
            Some("off")
        } else if want.launch.is_none() {
            Some("scenes can't play")
        } else if want.suspended {
            Some("low VRAM")
        } else if !self.in_use {
            Some("scenes not in use")
        } else {
            None
        };
        self.last = want.clone();
        if let Some(why) = why_not {
            self.reap(why);
            self.why_none = why;
            return;
        }
        let launch = want.launch.unwrap();
        if let Some(mut h) = self.host.take() {
            if self.on_events(&mut h, now) {
                // failed: backoff set, `why_none` says so
            } else if Launch::of(h.spec()) != launch {
                self.stats.replaced += 1;
                log::event(
                    "worker",
                    Level::Info,
                    "worker.spare_replaced",
                    None,
                    json!({"pid": h.pid(), "why": "a scene worker's launch changed"}),
                );
                // Gone at once so no scene can take it; its replacement waits like any refill
                // (the setting usually restarts the playing scene's worker too: no competing
                // with that load).
                h.stop();
            } else {
                self.host = Some(h);
                return;
            }
        }
        if self.retry_at.is_some_and(|t| now < t) {
            return;
        }
        if !want.quiet {
            self.why_none = "waiting for loads and transitions";
            return;
        }
        if self
            .last_take
            .is_some_and(|t| now.saturating_duration_since(t) < self.timing.refill_after)
        {
            self.why_none = "waiting after a take";
            return;
        }
        self.spawn(&launch, want.hang_timeout, now);
    }

    /// Stop the spare now (`stop`, the player quitting) and forget that scenes were in use.
    pub fn stop(&mut self, why: &'static str) {
        self.reap(why);
        self.in_use = false;
        self.why_none = why;
    }

    fn reap(&mut self, why: &str) {
        if let Some(mut h) = self.host.take() {
            self.stats.reaped += 1;
            log::event(
                "worker",
                Level::Info,
                "worker.spare_reaped",
                None,
                json!({"pid": h.pid(), "why": why}),
            );
            h.stop();
        }
    }

    fn spawn(&mut self, launch: &Launch, hang_timeout: Duration, now: Instant) {
        let mut spec = WorkerSpec::new("spare", launch.bin.clone(), super::proto::ToWorker::Quit);
        spec.args = launch.args.clone();
        spec.env = launch.env.clone();
        spec.hang_timeout = hang_timeout;
        match WorkerHost::spawn_spare(spec) {
            Ok(h) => {
                self.stats.spawned += 1;
                log::event(
                    "worker",
                    Level::Info,
                    "worker.spare_spawned",
                    None,
                    json!({"pid": h.pid()}),
                );
                self.host = Some(h);
                self.why_none = "";
            }
            Err(e) => self.failed(now, &format!("spawn: {e}")),
        }
    }

    /// Poll `h`: `true` = it failed (died, hung, or can't render: a fatal error) and is gone.
    fn on_events(&mut self, h: &mut WorkerHost, now: Instant) -> bool {
        let mut failure = None;
        for ev in h.poll(now) {
            match ev {
                WorkerEvent::Msg(FromWorker::Error { reason, fatal: true }, _) => {
                    failure.get_or_insert(reason);
                }
                WorkerEvent::Exited { signal, code } => {
                    failure.get_or_insert(format!("exited (signal {signal:?}, code {code:?})"));
                }
                WorkerEvent::Hung { waited_ms } => {
                    failure.get_or_insert(format!("hung ({waited_ms} ms)"));
                }
                _ => {}
            }
        }
        if failure.is_none() && matches!(h.state(), WorkerState::Stopped) {
            failure = Some("stopped".into());
        }
        let Some(reason) = failure else {
            // Up and steady as long as the longest backoff: the failures in a row are over (a
            // `Hello` alone isn't: a spare dying right after it would retry at the first step
            // forever).
            if h.said_hello() && h.age(now).is_some_and(|a| a >= self.timing.retry_max) {
                self.failures = 0;
            }
            return false;
        };
        let pid = h.pid();
        h.stop();
        self.failed(now, &format!("{reason} (pid {pid:?})"));
        true
    }

    fn failed(&mut self, now: Instant, reason: &str) {
        self.stats.failed += 1;
        self.failures += 1;
        let backoff = self
            .timing
            .retry
            .saturating_mul(1 << (self.failures - 1).min(16))
            .min(self.timing.retry_max);
        self.retry_at = Some(now + backoff);
        self.why_none = "failed, retrying";
        log::event(
            "worker",
            Level::Warn,
            "worker.spare_failed",
            None,
            json!({"reason": reason, "failures": self.failures,
                   "retry_ms": backoff.as_secs_f64() * 1e3}),
        );
    }

    /// The live spare's pid.
    pub fn pid(&self) -> Option<u32> {
        self.host.as_ref().and_then(WorkerHost::pid)
    }

    /// The `workers` probe's `spare`: `state` `spare` (a process waiting: `hello` = its context
    /// is up) or `none` (`why`), and the counters; `log_tail` adds the spare's output.
    pub fn info(&self, now: Instant, log_tail: bool) -> Value {
        let h = self.host.as_ref();
        let mut v = json!({
            "state": if h.is_some() { "spare" } else { "none" },
            "pid": self.pid(),
            "hello": h.is_some_and(WorkerHost::said_hello),
            "age_ms": h.and_then(|h| h.age(now)).map(|a| a.as_secs_f64() * 1e3),
            "why": if h.is_some() { "" } else { self.why_none },
            "enabled": self.last.enabled,
            "in_use": self.in_use,
            "failures": self.failures,
            "retry_in_ms": self.retry_at.map(|t| t.saturating_duration_since(now).as_secs_f64() * 1e3),
            "spawned": self.stats.spawned,
            "adopted": self.stats.adopted,
            "replaced": self.stats.replaced,
            "failed": self.stats.failed,
            "reaped": self.stats.reaped,
        });
        if log_tail {
            v["log_tail"] = json!(h.map(WorkerHost::log_tail).unwrap_or_default());
        }
        v
    }
}

impl std::fmt::Debug for Spare {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Spare")
            .field("pid", &self.pid())
            .field("in_use", &self.in_use)
            .field("why_none", &self.why_none)
            .finish()
    }
}

impl Drop for Spare {
    fn drop(&mut self) {
        self.reap("player stop");
    }
}
