//! Signals (spec §4.2 "Signal"; Phase 3): facts about the world outside the player that rules
//! read. So far one, **covered** (Task 6, designer call 9 as revised 2026-10-30): per output,
//! whether a window that is on screen there is fullscreen or maximized.
//!
//! - **Sources** ([`choose`], at serve start): Hyprland IPC when `HYPRLAND_INSTANCE_SIGNATURE`
//!   is set ([`hypr`]), else Sway IPC when `SWAYSOCK` is ([`sway`]), else wlr-foreign-toplevel
//!   when the compositor advertises it (`crate::wl`), else **unavailable** (GNOME, KDE: every
//!   `out:<c>.covered` reads `unavailable`, the rule never pauses). Headless: the
//!   `headless.cover` verb (tests' fake source). `LIASCAPE_PLAYER_COVER_SOURCE` = `hyprland` |
//!   `sway` | `wlr` | `headless` | `none` forces one (`hyprland`/`sway` work headless too: an
//!   end-to-end test of the IPC path against a fake socket).
//! - **The Signal** (general, for rules later — `docs/superpowers/specs/2026-10-29-rules-recon.md`):
//!   observed `out:<c>.covered` (`none|maximized|fullscreen|unavailable`) and
//!   `out:<c>.covered_by` (`{app_id, pid}` where the source gives them), the `cover.changed`
//!   event per change, the `cover` probe, `state.cover`, `hello.health.cover`.
//! - **The rule on it** (pause when covered): `player.pause_when_covered` = `off` (the prop's
//!   default — the backend asserts the user's setting) | `fullscreen` | `maximized`. When every
//!   output showing content is covered at that threshold for [`covered::COVER_ENGAGE_MS`] (base
//!   clock), the **cover hold** engages: a player-level hold composed in
//!   `Runtime::update_player_paused` beside the low-VRAM hold — never written to
//!   `player.paused`, so a user pause survives the release, and the R88 pause gates ramp the
//!   audio with the picture. It releases at the first tick the rule stops holding.
//!   `player.cover_hold_active` mirrors it; `cover.engaged` / `cover.released` log it.
//!
//! See `.claude/rules/player-core.md` § Signals.

pub mod covered;
pub mod hypr;
pub mod sway;

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::graph::{NodeKind, PropValue};
use crate::log::{self, Level};
use crate::runtime::Runtime;
use covered::{CoverHold, CoverMap, CoverState, HoldEdge};

/// How many hold decisions the `cover` probe keeps.
const DECISIONS: usize = 16;

// ---------------------------------------------------------------- the feed (thread sources)

#[derive(Default)]
struct FeedState {
    map: CoverMap,
    ok: Option<bool>,
    reason: Option<String>,
    events: u64,
    queries: u64,
}

#[derive(Default)]
struct FeedInner {
    version: AtomicU64,
    st: Mutex<FeedState>,
}

/// What a source thread publishes and the runtime reads (`version` changes only on a change, so a
/// tick's check is one atomic load).
#[derive(Clone, Default)]
pub struct Feed(Arc<FeedInner>);

impl Feed {
    fn lock(&self) -> std::sync::MutexGuard<'_, FeedState> {
        self.0.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A fresh reading.
    pub fn publish(&self, m: CoverMap) {
        let mut st = self.lock();
        st.queries += 1;
        if st.map != m || st.ok != Some(true) {
            st.map = m;
            st.ok = Some(true);
            st.reason = None;
            self.0.version.fetch_add(1, Ordering::Release);
        }
    }

    /// The source can't read: nothing is covered, and why.
    pub fn fail(&self, reason: String) {
        let mut st = self.lock();
        if st.ok != Some(false) || st.reason.as_deref() != Some(&reason) || !st.map.is_empty() {
            st.map.clear();
            st.ok = Some(false);
            st.reason = Some(reason);
            self.0.version.fetch_add(1, Ordering::Release);
        }
    }

    pub fn count_event(&self) {
        self.lock().events += 1;
    }

    pub fn version(&self) -> u64 {
        self.0.version.load(Ordering::Acquire)
    }

    /// `(ok, reason)`: `ok` is `None` until the first reading.
    pub fn status(&self) -> (Option<bool>, Option<String>) {
        let st = self.lock();
        (st.ok, st.reason.clone())
    }

    pub fn peek(&self) -> CoverMap {
        self.lock().map.clone()
    }

    /// The map and the version it belongs to, once the source has reported.
    pub fn take_map(&self) -> Option<(CoverMap, u64)> {
        let st = self.lock();
        st.ok.map(|_| (st.map.clone(), self.version()))
    }

    /// `(events, queries)` so far.
    pub fn counts(&self) -> (u64, u64) {
        let st = self.lock();
        (st.events, st.queries)
    }
}

// ---------------------------------------------------------------- choosing a source

/// The cover source for this process.
#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    /// Hyprland IPC for instance `sig`.
    Hyprland(String),
    /// Sway (i3) IPC on this socket.
    Sway(PathBuf),
    /// wlr-foreign-toplevel on the Wayland connection (if advertised).
    Foreign,
    /// `headless.cover`.
    Headless,
    /// Forced off.
    Off,
}

fn nonempty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// Pick the source: `forced` (`LIASCAPE_PLAYER_COVER_SOURCE`) first, else headless → its verb,
/// else Hyprland → Sway → wlr-ft by the session's environment.
pub fn choose(
    headless: bool,
    forced: Option<&str>,
    hypr_sig: Option<&str>,
    swaysock: Option<&str>,
) -> Choice {
    let hypr = nonempty(hypr_sig).map(|s| Choice::Hyprland(s.to_string()));
    let sway = nonempty(swaysock).map(|s| Choice::Sway(PathBuf::from(s)));
    match nonempty(forced) {
        Some("none" | "off") => Choice::Off,
        Some("hyprland") => hypr.unwrap_or(Choice::Hyprland(String::new())),
        Some("sway") => sway.unwrap_or(Choice::Sway(PathBuf::new())),
        Some("wlr") if !headless => Choice::Foreign,
        Some("headless") if headless => Choice::Headless,
        _ if headless => Choice::Headless,
        _ => hypr.or(sway).unwrap_or(Choice::Foreign),
    }
}

/// [`choose`] from this process's environment.
pub fn choose_from_env(headless: bool) -> Choice {
    let var = |k: &str| std::env::var(k).ok();
    choose(
        headless,
        var("LIASCAPE_PLAYER_COVER_SOURCE").as_deref(),
        var("HYPRLAND_INSTANCE_SIGNATURE").as_deref(),
        var("SWAYSOCK").as_deref(),
    )
}

// ---------------------------------------------------------------- the runtime's side

/// The runtime's cover state (`Runtime::cover`).
pub struct CoverRt {
    /// `hyprland` | `sway` | `wlr-foreign-toplevel` | `headless` | `unavailable`.
    pub source: &'static str,
    feed: Option<Feed>,
    stop: Option<Arc<AtomicBool>>,
    seen_version: u64,
    /// The source's status as last logged: `None` = no reading yet.
    pub ok: Option<bool>,
    pub reason: Option<String>,
    /// The newest reading: connector → cover.
    pub map: CoverMap,
    /// Base-clock time each output's cover last changed.
    pub since: BTreeMap<String, Duration>,
    pub hold: CoverHold,
    /// What the engaged hold covered: `(outputs, mode)`.
    engaged: Option<(Vec<String>, String)>,
    /// The latest hold decisions, newest last.
    pub decisions: VecDeque<Value>,
    /// `cover.changed` count.
    pub changes: u64,
}

impl Drop for CoverRt {
    fn drop(&mut self) {
        if let Some(s) = &self.stop {
            s.store(true, Ordering::Relaxed);
        }
    }
}

impl CoverRt {
    /// No source yet (`Runtime` construction); [`CoverRt::start`] picks one.
    pub fn idle() -> CoverRt {
        CoverRt {
            source: "unavailable",
            feed: None,
            stop: None,
            seen_version: 0,
            ok: None,
            reason: Some("not started".into()),
            map: CoverMap::new(),
            since: BTreeMap::new(),
            hold: CoverHold::default(),
            engaged: None,
            decisions: VecDeque::new(),
            changes: 0,
        }
    }

    /// Start the source `choice` names. `backend` = the output backend's own source (wlr-ft /
    /// headless): its name, or why there is none.
    pub fn start(choice: Choice, backend: Result<&'static str, String>) -> CoverRt {
        let mut c = CoverRt::idle();
        c.reason = None;
        let thread =
            |c: &mut CoverRt,
             name: &'static str,
             spawn: &dyn Fn(Feed, Arc<AtomicBool>) -> std::io::Result<()>| {
                let feed = Feed::default();
                let stop = Arc::new(AtomicBool::new(false));
                match spawn(feed.clone(), stop.clone()) {
                    Ok(()) => {
                        c.source = name;
                        c.feed = Some(feed);
                        c.stop = Some(stop);
                    }
                    Err(e) => {
                        c.ok = Some(false);
                        c.reason = Some(format!("can't start the {name} cover thread: {e}"));
                    }
                }
            };
        match choice {
            Choice::Hyprland(sig) if sig.is_empty() => {
                c.ok = Some(false);
                c.reason = Some("HYPRLAND_INSTANCE_SIGNATURE is not set".into());
            }
            Choice::Hyprland(sig) => {
                let dirs = hypr::dirs(&sig);
                thread(&mut c, "hyprland", &|f, s| hypr::spawn(dirs.clone(), f, s));
            }
            Choice::Sway(p) if p.as_os_str().is_empty() => {
                c.ok = Some(false);
                c.reason = Some("SWAYSOCK is not set".into());
            }
            Choice::Sway(p) => thread(&mut c, "sway", &|f, s| sway::spawn(p.clone(), f, s)),
            Choice::Foreign | Choice::Headless => match backend {
                Ok(name) => {
                    c.source = name;
                    c.ok = Some(true);
                }
                Err(e) => {
                    c.ok = Some(false);
                    c.reason = Some(e);
                }
            },
            Choice::Off => {
                c.ok = Some(false);
                c.reason = Some("LIASCAPE_PLAYER_COVER_SOURCE=none".into());
            }
        }
        c
    }

    /// The source works (a reading, or a backend source): `out:<c>.covered` is real.
    pub fn available(&self) -> bool {
        self.source != "unavailable" && self.ok == Some(true)
    }

    /// `out:<c>.covered` for connector `c`.
    pub fn covered_str(&self, c: &str) -> &'static str {
        if !self.available() {
            return "unavailable";
        }
        self.map
            .get(c)
            .map(|c| c.state)
            .unwrap_or_default()
            .as_str()
    }

    fn state_of(&self, c: &str) -> CoverState {
        self.map.get(c).map(|c| c.state).unwrap_or_default()
    }

    fn decide(&mut self, v: Value) {
        if self.decisions.len() >= DECISIONS {
            self.decisions.pop_front();
        }
        self.decisions.push_back(v);
    }

    /// `hello.health.cover`.
    pub fn health(&self) -> Value {
        let ok = match (self.source, self.ok) {
            ("unavailable", _) => Some(false),
            (_, ok) => ok,
        };
        let reason = match ok {
            Some(false) => Some(format!(
                "no window-state source here ({}) — \"Pause when covered\" can't act",
                self.reason.as_deref().unwrap_or("unknown")
            )),
            _ => None,
        };
        json!({ "ok": ok, "reason": reason, "source": self.source })
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

impl Runtime {
    /// Start the cover source for this process (serve start, after the backend exists).
    pub(crate) fn start_cover(&mut self) {
        let headless = self.backend.kind() == "headless";
        let choice = choose_from_env(headless);
        self.cover = CoverRt::start(choice.clone(), self.backend.cover_source());
        log::event(
            "signal",
            if self.cover.ok == Some(false) {
                Level::Warn
            } else {
                Level::Info
            },
            "cover.source",
            None,
            json!({ "source": self.cover.source, "ok": self.cover.ok,
                    "reason": self.cover.reason, "choice": format!("{choice:?}") }),
        );
        self.cover_mirror();
    }

    /// Task 6, every tick/step before `update_player_paused`: take a new reading (a source
    /// thread's feed, or the backend's wlr-ft/headless map), mirror it, then run the rule and
    /// move the hold. O(1) unless something changed or an output is covered.
    pub(crate) fn cover_tick(&mut self) {
        let fresh = match &self.cover.feed {
            Some(f) if f.version() != self.cover.seen_version => {
                self.cover.seen_version = f.version();
                let (ok, reason) = f.status();
                Some((f.peek(), ok, reason))
            }
            Some(_) => None,
            None => self
                .backend
                .take_cover()
                .map(|m| (m, self.cover.ok, self.cover.reason.clone())),
        };
        if let Some((map, ok, reason)) = fresh {
            self.cover_apply(map, ok, reason);
        }
        // Nothing covered, nothing pending or held: nothing to decide (the common tick).
        if !self.cover.hold.active()
            && self.cover.hold.pending_since().is_none()
            && self.cover.map.values().all(|c| c.state == CoverState::None)
        {
            return;
        }
        let mode = match self
            .graph
            .get(&crate::anim::PropPath("player.pause_when_covered".into()))
        {
            Ok(PropValue::Str(s)) => s,
            _ => "off".to_string(),
        };
        let now = self.base_now();
        let (rule, showing) = self.cover_rule_now(&mode);
        let Some(edge) = self.cover.hold.update(now, rule) else {
            return;
        };
        match edge {
            HoldEdge::Engaged { pending } => {
                let outputs: Vec<String> = showing.iter().map(|(c, _)| c.clone()).collect();
                let covers: Vec<Value> = showing
                    .iter()
                    .map(|(c, s)| {
                        let w = self.cover.map.get(c).cloned().unwrap_or_default();
                        json!({ "output": c, "covered": s.as_str(), "app_id": w.app_id, "pid": w.pid })
                    })
                    .collect();
                log::event(
                    "signal",
                    Level::Info,
                    "cover.engaged",
                    None,
                    json!({ "outputs": outputs, "mode": mode, "pending_ms": ms(pending),
                            "covers": covers, "source": self.cover.source }),
                );
                self.cover.decide(json!({ "decision": "engaged", "t_ms": ms(now), "unix_ms": unix_ms(),
                    "outputs": outputs, "mode": mode, "pending_ms": ms(pending), "covers": covers }));
                self.cover.engaged = Some((outputs, mode));
                let _ = self.graph.set_observed(
                    &crate::anim::PropPath("player.cover_hold_active".into()),
                    PropValue::Bool(true),
                );
            }
            HoldEdge::Released { held } => {
                let reason = if mode == "off" {
                    "mode_off"
                } else if showing.is_empty() && !self.cover_any_showing() {
                    "nothing_shown"
                } else {
                    "uncovered"
                };
                let (outputs, was_mode) = self.cover.engaged.take().unwrap_or_default();
                log::event(
                    "signal",
                    Level::Info,
                    "cover.released",
                    None,
                    json!({ "held_ms": ms(held), "reason": reason, "outputs": outputs,
                            "mode": was_mode, "now_mode": mode }),
                );
                self.cover.decide(
                    json!({ "decision": "released", "t_ms": ms(now), "unix_ms": unix_ms(),
                    "held_ms": ms(held), "reason": reason, "outputs": outputs, "mode": mode }),
                );
                let _ = self.graph.set_observed(
                    &crate::anim::PropPath("player.cover_hold_active".into()),
                    PropValue::Bool(false),
                );
            }
        }
    }

    /// The rule now: `(holds, the showing outputs with their state)`. Cheap when nothing
    /// covers at the mode's threshold (no output's sources are resolved then).
    fn cover_rule_now(&self, mode: &str) -> (bool, Vec<(String, CoverState)>) {
        if mode == "off"
            || !self.cover.available()
            || !self
                .cover
                .map
                .values()
                .any(|c| covered::mode_covers(mode, c.state))
        {
            return (false, Vec::new());
        }
        let mut showing = Vec::new();
        for id in self.graph.ids_of(NodeKind::Output) {
            let c = id.strip_prefix("out:").unwrap_or(&id);
            if self.graph.resolve(&format!("srcs:{c}")).is_empty() {
                continue;
            }
            let s = self.cover.state_of(c);
            if !covered::mode_covers(mode, s) {
                return (false, Vec::new());
            }
            showing.push((c.to_string(), s));
        }
        (covered::cover_rule(mode, &showing), showing)
    }

    fn cover_any_showing(&self) -> bool {
        self.graph.ids_of(NodeKind::Output).iter().any(|id| {
            let c = id.strip_prefix("out:").unwrap_or(id);
            !self.graph.resolve(&format!("srcs:{c}")).is_empty()
        })
    }

    /// A new reading: log the source's status change and each output's change, mirror it.
    fn cover_apply(&mut self, map: CoverMap, ok: Option<bool>, reason: Option<String>) {
        if ok != self.cover.ok || reason != self.cover.reason {
            log::event(
                "signal",
                if ok == Some(false) {
                    Level::Warn
                } else {
                    Level::Info
                },
                "cover.source",
                None,
                json!({ "source": self.cover.source, "ok": ok, "reason": reason }),
            );
            self.cover.ok = ok;
            self.cover.reason = reason;
        }
        let now = self.base_now();
        let names: BTreeSet<String> = self.cover.map.keys().chain(map.keys()).cloned().collect();
        for c in names {
            let old = self.cover.map.get(&c).cloned().unwrap_or_default();
            let new = map.get(&c).cloned().unwrap_or_default();
            if old == new {
                continue;
            }
            self.cover.since.insert(c.clone(), now);
            self.cover.changes += 1;
            log::event(
                "signal",
                Level::Info,
                "cover.changed",
                None,
                json!({ "output": c, "covered": new.state.as_str(), "was": old.state.as_str(),
                        "app_id": new.app_id, "pid": new.pid, "source": self.cover.source }),
            );
        }
        self.cover.since.retain(|c, _| map.contains_key(c));
        self.cover.map = map;
        self.cover_mirror();
    }

    /// `out:<c>.covered` / `covered_by` on every present output (observed).
    pub(crate) fn cover_mirror(&mut self) {
        for id in self.graph.ids_of(NodeKind::Output) {
            let c = id.strip_prefix("out:").unwrap_or(&id).to_string();
            let covered = PropValue::Str(self.cover.covered_str(&c).to_string());
            let by = match self.cover.map.get(&c) {
                Some(w) if self.cover.available() => w.by_json(),
                _ => json!({}),
            };
            let by = PropValue::Map(by.as_object().cloned().unwrap_or_default());
            for (prop, v) in [("covered", covered), ("covered_by", by)] {
                if self
                    .graph
                    .get(&crate::anim::PropPath(format!("{id}.{prop}")))
                    .ok()
                    .as_ref()
                    != Some(&v)
                {
                    let _ = self.graph.set_observed_on(&id, prop, v);
                }
            }
        }
    }

    /// The cover hold is engaged (`update_player_paused`).
    pub(crate) fn cover_held(&self) -> bool {
        self.cover.hold.active()
    }

    /// The `cover` probe.
    pub(crate) fn cover_probe(&self) -> Value {
        let mode = match self
            .graph
            .get(&crate::anim::PropPath("player.pause_when_covered".into()))
        {
            Ok(PropValue::Str(s)) => s,
            _ => String::new(),
        };
        let now = self.base_now();
        let outputs: Vec<Value> = self
            .graph
            .ids_of(NodeKind::Output)
            .into_iter()
            .map(|id| {
                let c = id.strip_prefix("out:").unwrap_or(&id).to_string();
                let w = self.cover.map.get(&c).cloned().unwrap_or_default();
                let showing = !self.graph.resolve(&format!("srcs:{c}")).is_empty();
                json!({
                    "name": c,
                    "covered": self.cover.covered_str(&c),
                    "app_id": w.app_id,
                    "pid": w.pid,
                    "showing": showing,
                    "counts": covered::mode_covers(&mode, w.state) && self.cover.available(),
                    "since_ms": self.cover.since.get(&c).map(|t| ms(*t)),
                })
            })
            .collect();
        // Monitors the source reports that the player has no output for (e.g. disabled).
        let others: Vec<Value> = self
            .cover
            .map
            .iter()
            .filter(|(c, _)| self.graph.kind_of(&format!("out:{c}")).is_none())
            .map(|(c, w)| json!({ "name": c, "covered": w.state.as_str(), "app_id": w.app_id, "pid": w.pid }))
            .collect();
        let (events, queries) = self.cover.feed.as_ref().map(Feed::counts).unwrap_or((0, 0));
        let (rule, _) = self.cover_rule_now(&mode);
        json!({
            "source": self.cover.source,
            "ok": self.cover.ok,
            "reason": self.cover.reason,
            "mode": mode,
            "now_ms": ms(now),
            "outputs": outputs,
            "unmatched": others,
            "rule": rule,
            "hold": {
                "active": self.cover.hold.active(),
                "pending_since_ms": self.cover.hold.pending_since().map(ms),
                "engaged_at_ms": self.cover.hold.engaged_at().map(ms),
                "engage_ms": covered::COVER_ENGAGE_MS,
            },
            "decisions": self.cover.decisions,
            "changes": self.cover.changes,
            "feed": { "events": events, "queries": queries },
        })
    }

    /// `state.cover`: the source and each output's cover, the hold.
    pub(crate) fn cover_state(&self) -> Value {
        let outputs: serde_json::Map<String, Value> = self
            .graph
            .ids_of(NodeKind::Output)
            .into_iter()
            .map(|id| {
                let c = id.strip_prefix("out:").unwrap_or(&id).to_string();
                let v = json!(self.cover.covered_str(&c));
                (c, v)
            })
            .collect();
        json!({
            "source": self.cover.source,
            "ok": self.cover.ok,
            "hold_active": self.cover.hold.active(),
            "outputs": outputs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choose_source_by_env() {
        assert_eq!(
            choose(false, None, Some("abc"), Some("/run/sway")),
            Choice::Hyprland("abc".into())
        );
        assert_eq!(
            choose(false, None, Some(""), Some("/run/sway")),
            Choice::Sway("/run/sway".into())
        );
        assert_eq!(choose(false, None, None, None), Choice::Foreign);
        assert_eq!(choose(false, Some("auto"), None, None), Choice::Foreign);
        // Headless: its verb, whatever session it runs in…
        assert_eq!(choose(true, None, Some("abc"), None), Choice::Headless);
        // …unless an IPC source is forced (the end-to-end test against a fake socket).
        assert_eq!(
            choose(true, Some("hyprland"), Some("abc"), None),
            Choice::Hyprland("abc".into())
        );
        assert_eq!(
            choose(true, Some("hyprland"), None, None),
            Choice::Hyprland(String::new())
        );
        assert_eq!(
            choose(false, Some("wlr"), Some("abc"), None),
            Choice::Foreign
        );
        assert_eq!(choose(false, Some("none"), Some("abc"), None), Choice::Off);
        assert_eq!(choose(true, Some("wlr"), None, None), Choice::Headless);
    }

    #[test]
    fn start_reports_unavailable_sources() {
        let c = CoverRt::start(
            Choice::Foreign,
            Err("no zwlr_foreign_toplevel_manager_v1".into()),
        );
        assert!(!c.available());
        assert_eq!(c.covered_str("DP-1"), "unavailable");
        assert_eq!(c.health()["ok"], json!(false));
        let c = CoverRt::start(Choice::Off, Ok("headless"));
        assert_eq!(c.source, "unavailable");
        let c = CoverRt::start(Choice::Headless, Ok("headless"));
        assert!(c.available());
        assert_eq!(c.covered_str("VIRTUAL-1"), "none");
        assert_eq!(
            c.health(),
            json!({"ok": true, "reason": null, "source": "headless"})
        );
    }

    #[test]
    fn feed_bumps_only_on_change() {
        let f = Feed::default();
        assert_eq!(f.status(), (None, None));
        let mut m = CoverMap::new();
        m.insert("DP-1".into(), covered::Cover::default());
        f.publish(m.clone());
        let g = f.version();
        f.publish(m.clone());
        assert_eq!(f.version(), g, "the same reading is no change");
        f.fail("gone".into());
        assert_eq!(f.status(), (Some(false), Some("gone".into())));
        assert!(f.peek().is_empty());
        let g = f.version();
        f.fail("gone".into());
        assert_eq!(f.version(), g);
        f.publish(m);
        assert_eq!(f.status().0, Some(true));
    }
}
