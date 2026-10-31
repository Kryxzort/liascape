//! The in-player **auto-mute** Signal (Phase 3 Task 14, spec §4.4) — behind
//! `LIASCAPE_PLAYER_AUTOMUTE=1` until it passes its parity bar against the backend's
//! `AudioMonitor` (plan Task 14; `docs/TODO.md` records which criterion is open).
//!
//! - **Input:** `audio::sysmon`'s per-stream captures (one per application playback stream, on
//!   PipeWire's RT thread, metered in 10 ms slices as each buffer arrives) and the verdicts
//!   `audio::foreign` gives them: every **foreign** stream counts — voice chat, notifications, a
//!   user's `mpv` — never the player's own (by ownership: its pid, its scene workers, anything
//!   aimed at or linked into `liascape-player-bus`), never a muted / volume-0 one, and with
//!   `automute_only_if_mpris` only a Playing MPRIS player's own streams (`signal::mpris`).
//! - **The Signal** (spec §4.4 `audio.foreign_level`): the counted streams' audible runs, read
//!   here. Not a graph prop yet: the `automute` probe shows each stream with its verdict and
//!   level, `player.automute_active` the outcome; the rules system can expose it when it exists.
//! - **The rule** ([`decide`]): audio continuously present (no gap > `RUN_GAP_NS`) for
//!   `automute_delay_ms` → every source's `gain.automute` ramps to −96 over the anti-click ramp
//!   (`ANTICLICK`, 30 ms) **ending at the delay** (run start + delay; the ramp leads by its own
//!   length, so the user's delay is what they get — with delay < ramp it ends a ramp after the
//!   first audible slice was seen). Silence (no counted audible slice) for
//!   `autounmute_delay_ms` → the ramp back **starts at the delay**. A new source created while
//!   muted comes up at −96 (enforced before its first sync); `player.automute_active` mirrors
//!   the state; `automute.muted` / `automute.unmuted` log each edge with its timing.
//! - **Timing:** a counted stream's rising edge pings the loop from the RT thread; every
//!   deadline is a calloop timer at that instant (no polling tick). Times are the buffers'
//!   cycle times (CLOCK_MONOTONIC), so the delay counts from the first audible sample.
//!
//! See `.claude/rules/player-core.md` § Signals → Auto-mute.

use std::collections::{BTreeSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use calloop::timer::{TimeoutAction, Timer};
use serde_json::{Value, json};

use crate::anim::{AnimUnit, Animation, Curve, PropPath};
use crate::audio::meter::mono_ns;
use crate::audio::sysmon::{MprisFeed, RUN_GAP_NS, SysMon};
use crate::graph::{NodeKind, PropValue};
use crate::log::{self, Level};
use crate::recipes::transition::ANTICLICK;
use crate::runtime::Runtime;
use crate::units::{SILENT_DB, db_to_lin};

/// The env gate (`1` = the Signal runs; anything else = it never starts).
pub const ENV: &str = "LIASCAPE_PLAYER_AUTOMUTE";
/// The probe's `audible`: a last audible slice this recent (the gap rule + a 1024-frame buffer
/// and some margin). The rule itself uses the run gap + the measured buffer period.
pub const LIVE_NS: i64 = RUN_GAP_NS + 30_000_000;
/// The buffer period assumed before any counted stream delivered one (1024 frames at 48 kHz).
pub const DEFAULT_BUF_NS: i64 = 21_333_333;
/// How many decisions the probe keeps.
const DECISIONS: usize = 32;

pub fn env_enabled() -> bool {
    std::env::var(ENV).as_deref() == Ok("1")
}

/// The player props it reads (`player.automute*`).
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub on: bool,
    pub mute_delay_ms: f64,
    pub unmute_delay_ms: f64,
    pub min_level_db: f64,
    pub only_mpris: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            on: false,
            mute_delay_ms: 500.0,
            unmute_delay_ms: 2000.0,
            min_level_db: -70.0,
            only_mpris: false,
        }
    }
}

/// One counted stream's audible run (CLOCK_MONOTONIC ns).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Run {
    pub start_ns: i64,
    pub last_ns: i64,
    /// The end of the newest buffer the stream delivered (silence after `last_ns` is proven up
    /// to here).
    pub buf_end_ns: i64,
}

/// What [`decide`] says.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Start the mute ramp now; it ends at `end_ns` (= now + ramp, or later is never).
    Mute { run_start_ns: i64, target_end_ns: i64 },
    /// Start the unmute ramp now (`last_ns` = the last audible slice).
    Unmute { last_ns: i64 },
    /// Nothing now; look again at this instant (or on the next wake).
    At(i64),
    Idle,
}

fn ms_ns(ms: f64) -> i64 {
    (ms.max(0.0) * 1e6) as i64
}

/// The rule (module doc), pure: `muted` = the current state, `runs` = every counted stream's
/// latest run, `last_ns` = the newest counted audible slice ever seen (also of streams that
/// went away), `since_ns` = when the current state began (an unmute never counts silence from
/// before it), `buf_ns` = the buffer period (graph quantum). An unmute waits at least
/// `RUN_GAP_NS` of silence whatever the delay (today's `AudioMonitor` waits one quiet 20 ms
/// chunk), **proven by data**: every counted stream delivered a buffer reaching that far past
/// its last audible slice — else (a stream that stopped delivering) one buffer period more.
pub fn decide(
    muted: bool,
    s: &Settings,
    now_ns: i64,
    runs: &[Run],
    last_ns: i64,
    since_ns: i64,
    ramp_ns: i64,
    buf_ns: i64,
) -> Decision {
    if !s.on {
        return if muted {
            Decision::Unmute { last_ns }
        } else {
            Decision::Idle
        };
    }
    if !muted {
        let Some(start) = runs
            .iter()
            // live: a gap that long ends a run; audio arrives a buffer at a time, so a steady
            // tone between two buffers is up to one period older
            .filter(|r| r.last_ns != 0 && now_ns - r.last_ns <= RUN_GAP_NS + buf_ns)
            .map(|r| r.start_ns)
            .min()
        else {
            return Decision::Idle;
        };
        let end = start + ms_ns(s.mute_delay_ms);
        let ramp_at = end - ramp_ns;
        if now_ns >= ramp_at {
            Decision::Mute {
                run_start_ns: start,
                target_end_ns: end,
            }
        } else {
            Decision::At(ramp_at)
        }
    } else {
        let last = runs
            .iter()
            .map(|r| r.last_ns)
            .chain([last_ns, since_ns])
            .max()
            .unwrap_or(since_ns);
        let at = last + ms_ns(s.unmute_delay_ms).max(RUN_GAP_NS);
        if now_ns < at {
            return Decision::At(at);
        }
        // silence proven for each counted stream, or it has gone quiet without buffers
        let fallback = runs
            .iter()
            .filter(|r| r.last_ns != 0 && r.buf_end_ns - r.last_ns < RUN_GAP_NS)
            .map(|r| r.last_ns + RUN_GAP_NS + buf_ns)
            .max();
        match fallback {
            Some(t) if now_ns < t => Decision::At(t),
            _ => Decision::Unmute { last_ns: last },
        }
    }
}

/// The runtime's auto-mute state.
pub struct AutoMuteRt {
    pub env: bool,
    ping: Option<calloop::ping::Ping>,
    timer: Option<(calloop::RegistrationToken, i64)>,
    pub muted: bool,
    since_ns: i64,
    settings: Settings,
    mpris: Option<Arc<MprisFeed>>,
    decisions: VecDeque<Value>,
    /// The newest counted stream's buffer period (the graph quantum), for the unmute gap.
    buf_ns: i64,
    ticks: u64,
    restored_checked: bool,
}

impl AutoMuteRt {
    pub fn new(env: bool) -> AutoMuteRt {
        AutoMuteRt {
            env,
            ping: None,
            timer: None,
            muted: false,
            since_ns: mono_ns(),
            settings: Settings::default(),
            mpris: None,
            decisions: VecDeque::new(),
            buf_ns: DEFAULT_BUF_NS,
            ticks: 0,
            restored_checked: false,
        }
    }

    fn decide_log(&mut self, v: Value) {
        if self.decisions.len() == DECISIONS {
            self.decisions.pop_front();
        }
        self.decisions.push_back(v);
    }
}

/// ns (CLOCK_MONOTONIC) → the `t_mono_ms` log clock.
fn t_ms(ns: i64) -> f64 {
    let origin = mono_ns() - log::mono_now().map_or(0, |d| d.as_nanos() as i64);
    (ns - origin) as f64 / 1e6
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

impl Runtime {
    /// Serve start: with the env gate, a ping the RT meter wakes the loop with.
    pub(crate) fn start_automute(&mut self) {
        if !self.automute.env {
            return;
        }
        match calloop::ping::make_ping() {
            Ok((ping, src)) => {
                if self
                    .handle
                    .insert_source(src, |_, _, rt: &mut Runtime| rt.automute_tick())
                    .is_ok()
                {
                    self.automute.ping = Some(ping);
                }
            }
            Err(e) => log::event(
                "signal",
                Level::Warn,
                "automute.ping_failed",
                None,
                json!({ "error": e.to_string() }),
            ),
        }
        log::event("signal", Level::Info, "automute.enabled", None, json!({ "env": ENV }));
    }

    /// The `automute` capability: the env gate and the audio bus up (PipeWire reachable with a
    /// session manager). Without it the backend keeps `AudioMonitor` (criterion 10).
    pub(crate) fn automute_capable(&self) -> bool {
        self.automute.env && self.audio.bus.is_some() && self.bus_route.0
    }

    fn automute_settings(&self) -> Settings {
        let b = |k: &str, d: bool| match self.graph.get(&PropPath(format!("player.{k}"))) {
            Ok(PropValue::Bool(v)) => v,
            _ => d,
        };
        let f = |k: &str, d: f64| match self.graph.get(&PropPath(format!("player.{k}"))) {
            Ok(PropValue::F64(v)) => v,
            _ => d,
        };
        let d = Settings::default();
        Settings {
            on: b("automute", d.on),
            mute_delay_ms: f("automute_delay_ms", d.mute_delay_ms),
            unmute_delay_ms: f("autounmute_delay_ms", d.unmute_delay_ms),
            min_level_db: f("automute_min_level_db", d.min_level_db),
            only_mpris: b("automute_only_if_mpris", d.only_mpris),
        }
    }

    /// Whether the auto-mute keeps the per-stream capture running (beside the visualiser).
    pub(crate) fn automute_wants_monitor(&self) -> bool {
        self.automute.env && self.automute.settings.on
    }

    /// Every wake (the RT meter's ping, a deadline, the main tick, a dispatch): read the
    /// settings, keep the capture configured, decide, act, arm the next deadline.
    pub(crate) fn automute_tick(&mut self) {
        if !self.automute.env {
            return;
        }
        self.automute.ticks += 1;
        let s = self.automute_settings();
        if !self.automute.restored_checked {
            // a crash restart: sources restored at −96 by the snapshot are the muted state
            self.automute.restored_checked = true;
            if self.graph.ids_of(NodeKind::Source).iter().any(|id| {
                matches!(self.graph.get(&PropPath(format!("{id}.gain.automute"))),
                    Ok(PropValue::F64(db)) if db <= SILENT_DB + 1.0)
            }) {
                self.automute.muted = true;
                self.automute.since_ns = mono_ns();
                let _ = self.graph.set_observed(
                    &PropPath("player.automute_active".into()),
                    PropValue::Bool(true),
                );
            }
        }
        if s != self.automute.settings {
            log::event(
                "signal",
                Level::Info,
                "automute.settings",
                None,
                json!({ "on": s.on, "mute_delay_ms": s.mute_delay_ms,
                        "unmute_delay_ms": s.unmute_delay_ms, "min_level_db": s.min_level_db,
                        "only_if_mpris": s.only_mpris }),
            );
            self.automute.settings = s.clone();
        }
        if s.on {
            if s.only_mpris && self.automute.mpris.is_none() {
                self.automute.mpris = Some(super::mpris::start());
            }
            let ping = self.automute.ping.clone();
            let mon = self.sysmon.get_or_insert_with(SysMon::start);
            if let Some(p) = ping {
                mon.set_wake(Arc::new(move || p.ping()));
            }
            mon.set_threshold_db(s.min_level_db);
            mon.set_only_mpris(s.only_mpris, self.automute.mpris.clone());
            let workers: BTreeSet<u32> = self
                .host
                .scene_ids()
                .iter()
                .filter_map(|id| self.host.scene(id).and_then(|sc| sc.pid()))
                .collect();
            mon.set_worker_pids(workers);
        }
        let now = mono_ns();
        let (runs, last) = match (&self.sysmon, s.on) {
            (Some(m), true) => (
                m.streams()
                    .iter()
                    .filter(|e| e.tap.counts.load(Ordering::SeqCst))
                    .inspect(|e| {
                        let b = e.tap.buf_ns.load(Ordering::Relaxed);
                        if b > 0 {
                            self.automute.buf_ns = b;
                        }
                    })
                    .map(|e| Run {
                        start_ns: e.tap.run_start_ns.load(Ordering::Acquire),
                        last_ns: e.tap.last_above_ns.load(Ordering::Acquire),
                        buf_end_ns: e.tap.buf_end_ns.load(Ordering::Acquire),
                    })
                    .collect::<Vec<_>>(),
                m.last_counted_above_ns(),
            ),
            _ => (Vec::new(), 0),
        };
        let ramp_ns = ANTICLICK.as_nanos() as i64;
        match decide(
            self.automute.muted,
            &s,
            now,
            &runs,
            last,
            self.automute.since_ns,
            ramp_ns,
            self.automute.buf_ns,
        ) {
            Decision::Mute {
                run_start_ns,
                target_end_ns,
            } => {
                self.automute_ramp(true);
                self.automute.muted = true;
                self.automute.since_ns = now;
                let fields = json!({
                    "run_start_ms": round3(t_ms(run_start_ns)),
                    "ramp_start_ms": round3(t_ms(now)),
                    "end_ms": round3(t_ms(now + ramp_ns)),
                    "target_end_ms": round3(t_ms(target_end_ns)),
                    "late_ms": round3((now + ramp_ns - target_end_ns) as f64 / 1e6),
                    "delay_ms": s.mute_delay_ms,
                    "ramp_ms": ANTICLICK.as_secs_f64() * 1e3,
                    "streams": self.automute_counting(),
                });
                log::event("signal", Level::Info, "automute.muted", None, fields.clone());
                let mut d = fields;
                d["decision"] = json!("muted");
                d["unix_ms"] = json!(unix_ms());
                self.automute.decide_log(d);
            }
            Decision::Unmute { last_ns } => {
                self.automute_ramp(false);
                self.automute.muted = false;
                self.automute.since_ns = now;
                let fields = json!({
                    "last_audible_ms": round3(t_ms(last_ns)),
                    "ramp_start_ms": round3(t_ms(now)),
                    "silent_ms": round3((now - last_ns) as f64 / 1e6),
                    "delay_ms": s.unmute_delay_ms,
                    "reason": if s.on { "silence" } else { "off" },
                });
                log::event("signal", Level::Info, "automute.unmuted", None, fields.clone());
                let mut d = fields;
                d["decision"] = json!("unmuted");
                d["unix_ms"] = json!(unix_ms());
                self.automute.decide_log(d);
            }
            Decision::At(at) => self.automute_arm(at),
            Decision::Idle => self.automute_disarm(),
        }
        if s.on || self.automute.muted {
            self.automute_enforce();
        }
    }

    fn automute_counting(&self) -> Vec<Value> {
        self.sysmon
            .as_ref()
            .map(|m| {
                m.streams()
                    .iter()
                    .filter(|e| e.counts)
                    .map(|e| json!({ "id": e.props.id, "app": e.identity.app_name,
                                     "binary": e.identity.binary, "pid": e.identity.pid }))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Ramp every source's `gain.automute` (on the unpaused clock: it lands while paused).
    fn automute_ramp(&mut self, mute: bool) {
        let now = self.base_now();
        for id in self.graph.ids_of(NodeKind::Source) {
            let path = PropPath(format!("{id}.gain.automute"));
            let cur = match self.graph.get(&path) {
                Ok(PropValue::F64(db)) => db,
                _ => 0.0,
            };
            self.anim.cancel_target(&path);
            self.setting_anim.cancel_target(&path);
            self.setting_anim.add(Animation {
                target: path,
                from: db_to_lin(cur),
                to: if mute { 0.0 } else { 1.0 },
                start: now,
                duration: ANTICLICK,
                curve: Curve::Linear,
                unit: AnimUnit::GainLinear,
                corr: None,
            });
        }
        let _ = self.graph.set_observed(
            &PropPath("player.automute_active".into()),
            PropValue::Bool(mute),
        );
        self.arm_gain_timer_if_needed();
    }

    /// A source created while muted comes up at −96; one left at −96 after an unmute (a crash
    /// restart's snapshot) ramps back. Only sources with no ramp of their own on the slot.
    pub(crate) fn automute_enforce(&mut self) {
        if !self.automute.env {
            return;
        }
        let want = if self.automute.muted { SILENT_DB } else { 0.0 };
        let mut ramp_back = false;
        for id in self.graph.ids_of(NodeKind::Source) {
            let path = PropPath(format!("{id}.gain.automute"));
            if self.setting_anim.target_of(&path).is_some() || self.anim.target_of(&path).is_some()
            {
                continue;
            }
            let cur = match self.graph.get(&path) {
                Ok(PropValue::F64(db)) => db,
                _ => continue,
            };
            if (cur - want).abs() < 0.01 {
                continue;
            }
            if self.automute.muted {
                let _ = self.graph.set(&path, PropValue::F64(SILENT_DB));
            } else {
                ramp_back = true;
                self.setting_anim.add(Animation {
                    target: path,
                    from: db_to_lin(cur),
                    to: 1.0,
                    start: self.base_now(),
                    duration: ANTICLICK,
                    curve: Curve::Linear,
                    unit: AnimUnit::GainLinear,
                    corr: None,
                });
            }
        }
        if ramp_back {
            self.arm_gain_timer_if_needed();
        }
    }

    fn automute_arm(&mut self, at_ns: i64) {
        if let Some((tok, at)) = self.automute.timer {
            if at == at_ns {
                return;
            }
            self.handle.remove(tok);
            self.automute.timer = None;
        }
        let wait = Duration::from_nanos((at_ns - mono_ns()).max(0) as u64);
        match self.handle.insert_source(
            Timer::from_deadline(Instant::now() + wait),
            |_, _, rt: &mut Runtime| {
                rt.automute.timer = None;
                rt.automute_tick();
                TimeoutAction::Drop
            },
        ) {
            Ok(tok) => self.automute.timer = Some((tok, at_ns)),
            Err(e) => log::event(
                "signal",
                Level::Warn,
                "automute.timer_failed",
                None,
                json!({ "error": e.to_string() }),
            ),
        }
    }

    fn automute_disarm(&mut self) {
        if let Some((tok, _)) = self.automute.timer.take() {
            self.handle.remove(tok);
        }
    }

    /// The `automute` probe: settings, state, every captured stream with its verdict and level,
    /// MPRIS, recent decisions (`t_ms` on the `t_mono_ms` clock).
    pub(crate) fn automute_probe(&self) -> Value {
        let now = mono_ns();
        let s = self.automute_settings();
        let streams: Vec<Value> = self
            .sysmon
            .as_ref()
            .map(|m| {
                m.streams()
                    .iter()
                    .map(|e| {
                        let last = e.tap.last_above_ns.load(Ordering::Acquire);
                        let start = e.tap.run_start_ns.load(Ordering::Acquire);
                        let opt = |ns: i64| (ns != 0).then(|| round3(t_ms(ns)));
                        json!({
                            "id": e.props.id,
                            "node_name": e.props.node_name,
                            "media_name": e.props.media_name,
                            "media_role": e.props.media_role,
                            "app": e.identity.app_name,
                            "binary": e.identity.binary,
                            "pid": e.identity.pid,
                            "portal_app_id": e.identity.portal_app_id,
                            "target": e.identity.target,
                            "verdict": e.verdict.as_str(),
                            "counts": e.counts,
                            "mpris": e.mpris.as_ref().map(|(n, how)| json!({"player": n, "how": how})),
                            "mute": e.volume.mute,
                            "channel_volumes": e.volume.channel_volumes,
                            "volume": e.volume.volume,
                            "silent_by_volume": e.volume.silent(),
                            "peak_db": round3(f64::from(e.tap.peak_db())),
                            "audible": e.tap.audible_at(now, LIVE_NS),
                            "run_start_ms": opt(start),
                            "last_audible_ms": opt(last),
                            "buffers": e.tap.buffers(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mpris = self.automute.mpris.as_ref().map(|f| {
            let st = f.state.lock().unwrap_or_else(|e| e.into_inner()).clone();
            json!({
                "available": st.available,
                "reason": st.reason,
                "refreshes": st.refreshes,
                "players": st.players.iter().map(|p| json!({
                    "bus_name": p.bus_name, "identity": p.identity,
                    "desktop_entry": p.desktop_entry, "pid": p.pid, "playing": p.playing,
                    "title": p.title,
                })).collect::<Vec<_>>(),
                "unmatched": self.sysmon.as_ref().map(SysMon::mpris_unmatched).unwrap_or_default(),
            })
        });
        json!({
            "env": self.automute.env,
            "capability": self.automute_capable(),
            "settings": {
                "on": s.on, "mute_delay_ms": s.mute_delay_ms, "unmute_delay_ms": s.unmute_delay_ms,
                "min_level_db": s.min_level_db, "only_if_mpris": s.only_mpris,
            },
            "active": self.automute.muted,
            "since_ms": round3(t_ms(self.automute.since_ns)),
            "now_ms": round3(t_ms(now)),
            "monitor": self.sysmon.as_ref().map(|m| json!({
                "connected": m.connected(), "error": m.error(), "edges": m.edges(),
                "last_counted_audible_ms": (m.last_counted_above_ns() != 0)
                    .then(|| round3(t_ms(m.last_counted_above_ns()))),
            })),
            "timer_at_ms": self.automute.timer.map(|(_, at)| round3(t_ms(at))),
            "ramp_ms": ANTICLICK.as_secs_f64() * 1e3,
            "buffer_ms": round3(self.automute.buf_ns as f64 / 1e6),
            "ticks": self.automute.ticks,
            "streams": streams,
            "mpris": mpris,
            "decisions": self.automute.decisions.iter().collect::<Vec<_>>(),
        })
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: i64 = 1_000_000;
    const RAMP: i64 = 30 * MS;
    const BUF: i64 = 21 * MS;

    fn on(mute: f64, unmute: f64) -> Settings {
        Settings {
            on: true,
            mute_delay_ms: mute,
            unmute_delay_ms: unmute,
            ..Settings::default()
        }
    }

    #[test]
    fn mute_ramp_ends_at_the_delay() {
        let s = on(500.0, 2000.0);
        let run = Run {
            start_ns: 1000 * MS,
            last_ns: 1010 * MS,
            buf_end_ns: 0,
        };
        // seen at once: wait until the ramp has to start (500 − 30 ms after the run start)
        assert_eq!(
            decide(false, &s, 1010 * MS, &[run], run.last_ns, 0, RAMP, BUF),
            Decision::At(1470 * MS)
        );
        let still = Run {
            last_ns: 1465 * MS,
            ..run
        };
        assert_eq!(
            decide(false, &s, 1470 * MS, &[still], still.last_ns, 0, RAMP, BUF),
            Decision::Mute {
                run_start_ns: 1000 * MS,
                target_end_ns: 1500 * MS
            }
        );
        // the run broke before the deadline: nothing (a tone that stopped 25 ms before the
        // ramp is due, past the gap + one buffer of 1 ms, too)
        let short = Run {
            last_ns: 1445 * MS,
            ..run
        };
        assert_eq!(
            decide(false, &s, 1470 * MS, &[short], short.last_ns, 0, RAMP, MS),
            Decision::Idle
        );
        assert_eq!(
            decide(false, &s, 1470 * MS, &[run], run.last_ns, 0, RAMP, BUF),
            Decision::Idle
        );
        // delay 0: at once
        assert!(matches!(
            decide(false, &on(0.0, 0.0), 1012 * MS, &[run], run.last_ns, 0, RAMP, BUF),
            Decision::Mute { .. }
        ));
        // off: never
        let mut off = s.clone();
        off.on = false;
        assert_eq!(
            decide(false, &off, 1500 * MS, &[still], 0, 0, RAMP, BUF),
            Decision::Idle
        );
        // the earliest live run of several counts
        let other = Run {
            start_ns: 1200 * MS,
            last_ns: 1465 * MS,
            buf_end_ns: 0,
        };
        assert!(matches!(
            decide(false, &s, 1470 * MS, &[other, still], 0, 0, RAMP, BUF),
            Decision::Mute { run_start_ns, .. } if run_start_ns == 1000 * MS
        ));
    }

    #[test]
    fn unmute_starts_at_the_delay_after_the_last_audible_slice() {
        let s = on(500.0, 2000.0);
        let run = Run {
            start_ns: 1000 * MS,
            last_ns: 3000 * MS,
            buf_end_ns: 0,
        };
        assert_eq!(
            decide(true, &s, 3100 * MS, &[run], run.last_ns, 1500 * MS, RAMP, BUF),
            Decision::At(5000 * MS)
        );
        assert_eq!(
            decide(true, &s, 5000 * MS, &[run], run.last_ns, 1500 * MS, RAMP, BUF),
            Decision::Unmute {
                last_ns: 3000 * MS
            }
        );
        // a stream that went away still counts through `last_ns`
        assert_eq!(
            decide(true, &s, 4000 * MS, &[], 3000 * MS, 1500 * MS, RAMP, BUF),
            Decision::At(5000 * MS)
        );
        // silence counts only from the mute on (a restart's restored mute)
        assert_eq!(
            decide(true, &s, 4000 * MS, &[], 0, 3500 * MS, RAMP, BUF),
            Decision::At(5500 * MS)
        );
        // switched off while muted: unmute now
        let mut off = s.clone();
        off.on = false;
        assert!(matches!(
            decide(true, &off, 3100 * MS, &[run], 0, 0, RAMP, BUF),
            Decision::Unmute { .. }
        ));
        // unmute delay 0 still waits out one run gap (20 ms) …
        assert_eq!(
            decide(true, &on(0.0, 0.0), 3010 * MS, &[run], run.last_ns, 0, RAMP, BUF),
            Decision::At(3000 * MS + RUN_GAP_NS)
        );
        // … proven by a buffer reaching past it: at once
        let proven = Run {
            buf_end_ns: 3021 * MS,
            ..run
        };
        assert_eq!(
            decide(true, &on(0.0, 0.0), 3020 * MS, &[proven], run.last_ns, 0, RAMP, BUF),
            Decision::Unmute {
                last_ns: 3000 * MS
            }
        );
        // no such buffer yet (a steady tone between two 21 ms buffers looks quiet): wait for
        // it, or one buffer period more when the stream stopped delivering
        assert_eq!(
            decide(true, &on(0.0, 0.0), 3020 * MS, &[run], run.last_ns, 0, RAMP, BUF),
            Decision::At(3000 * MS + RUN_GAP_NS + BUF)
        );
    }
}
