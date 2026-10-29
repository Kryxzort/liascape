//! The covered Signal's pure half (Phase 3 Task 6, designer call 9 as revised 2026-10-30):
//! what "output X is covered" means on each source, the pause rule over it and the hold's
//! debounce. Nothing here talks to a compositor, so every rule is tested on plain records.
//!
//! **Covered = visible**, never focused (rules recon §0.1: wlr-ft's `activated` is keyboard
//! focus, so a fullscreen game on DP-1 would stop covering when the user clicks DP-2):
//! - **Hyprland** ([`hypr_cover`]): a monitor is covered by a mapped, non-hidden client on its
//!   active workspace or its open special workspace, by the client's `fullscreen` bits (1 =
//!   maximized, 2 = fullscreen, 3 = both). Hyprland's `visible` field is never read (it isn't
//!   "on screen").
//! - **Sway** ([`sway_cover`]): a container with `fullscreen_mode` 1 that is visible (it, or a
//!   view inside it) covers its output; `fullscreen_mode` 2 (global) covers every output. Sway
//!   has no maximized state.
//! - **wlr-foreign-toplevel** ([`Toplevels`]): a toplevel that is fullscreen/maximized and not
//!   minimized covers every output it entered, whatever its focus. It can't see workspaces: a
//!   fullscreen window on a hidden workspace still covers (the fallback's known false positive).
//!
//! The rule ([`cover_rule`]) pauses only when every output showing content is covered at the
//! mode's threshold; [`CoverHold`] engages after it held for [`COVER_ENGAGE_MS`] and lets go at
//! once.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use serde_json::{Value, json};

/// How an output is covered, ordered: `None < Maximized < Fullscreen`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub enum CoverState {
    #[default]
    None,
    Maximized,
    Fullscreen,
}

impl CoverState {
    pub fn as_str(self) -> &'static str {
        match self {
            CoverState::None => "none",
            CoverState::Maximized => "maximized",
            CoverState::Fullscreen => "fullscreen",
        }
    }

    pub fn parse(s: &str) -> Option<CoverState> {
        match s {
            "none" => Some(CoverState::None),
            "maximized" => Some(CoverState::Maximized),
            "fullscreen" => Some(CoverState::Fullscreen),
            _ => None,
        }
    }

    /// Hyprland's `fullscreen` mode bitmask (`eFullscreenMode`): bit 1 fullscreen, bit 0
    /// maximized.
    pub fn from_hypr(bits: i64) -> CoverState {
        if bits & 2 != 0 {
            CoverState::Fullscreen
        } else if bits & 1 != 0 {
            CoverState::Maximized
        } else {
            CoverState::None
        }
    }
}

/// One output's cover: its state and the covering window (where the source names it).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Cover {
    pub state: CoverState,
    /// Hyprland: `class` (else `initialClass`); Sway: `app_id` (else the X11 class); wlr-ft:
    /// `app_id`. `None` when uncovered or unknown.
    pub app_id: Option<String>,
    /// Hyprland/Sway only (wlr-ft has no pid).
    pub pid: Option<u32>,
}

impl Cover {
    pub fn by(state: CoverState, app_id: Option<String>, pid: Option<u32>) -> Cover {
        Cover { state, app_id, pid }
    }

    /// `out:<c>.covered_by`: `{app_id, pid}` of the covering window, `{}` when uncovered.
    pub fn by_json(&self) -> Value {
        if self.state == CoverState::None {
            return json!({});
        }
        json!({ "app_id": self.app_id, "pid": self.pid })
    }
}

/// Connector name → its cover. An output a source doesn't name is uncovered.
pub type CoverMap = BTreeMap<String, Cover>;

/// The window a source reports, the better one first: a higher state, then the earlier
/// candidate (a special workspace before the active one).
fn better(cur: &Cover, cand: &Cover) -> bool {
    cand.state > cur.state
}

/// `player.pause_when_covered`'s threshold: does `state` count as covered under `mode`?
pub fn mode_covers(mode: &str, state: CoverState) -> bool {
    match mode {
        "fullscreen" => state == CoverState::Fullscreen,
        "maximized" => state >= CoverState::Maximized,
        _ => false,
    }
}

/// How long the rule must hold before the cover hold engages (a flapping cover never pauses).
pub const COVER_ENGAGE_MS: u64 = 300;

/// The pause rule: `mode` isn't `off`, at least one output shows content, and **every** output
/// in `showing` (those showing content) is covered at `mode`'s threshold.
pub fn cover_rule(mode: &str, showing: &[(String, CoverState)]) -> bool {
    !showing.is_empty() && showing.iter().all(|(_, s)| mode_covers(mode, *s))
}

// ---------------------------------------------------------------- Hyprland

/// One `j/monitors` entry, the fields the rule reads.
#[derive(Debug, Clone, PartialEq)]
pub struct HyprMonitor {
    pub name: String,
    pub active_ws: i64,
    /// The open special workspace's id (negative), 0 when none is open.
    pub special_ws: i64,
}

/// One `j/clients` entry, the fields the rule reads.
#[derive(Debug, Clone, PartialEq)]
pub struct HyprClient {
    pub workspace: i64,
    pub fullscreen: i64,
    pub mapped: bool,
    /// A background tab of a group.
    pub hidden: bool,
    pub class: String,
    pub pid: Option<u32>,
}

fn num(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}

fn ws_id(v: &Value, k: &str) -> i64 {
    v.get(k).map(|w| num(w, "id")).unwrap_or(0)
}

/// Parse `j/monitors` + `j/clients` (Hyprland 0.56 field names; recon §1.1, checked on the
/// owner's machine 2026-10-30). Disabled monitors are left out.
pub fn hypr_parse(monitors: &Value, clients: &Value) -> (Vec<HyprMonitor>, Vec<HyprClient>) {
    let empty = Vec::new();
    let mons = monitors
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|m| m.get("disabled").and_then(Value::as_bool) != Some(true))
        .filter_map(|m| {
            Some(HyprMonitor {
                name: m.get("name")?.as_str()?.to_string(),
                active_ws: ws_id(m, "activeWorkspace"),
                special_ws: ws_id(m, "specialWorkspace"),
            })
        })
        .collect();
    let cls = clients
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|c| {
            let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let class = match s("class") {
                x if x.is_empty() => s("initialClass"),
                x => x,
            };
            HyprClient {
                workspace: ws_id(c, "workspace"),
                fullscreen: num(c, "fullscreen"),
                mapped: c.get("mapped").and_then(Value::as_bool).unwrap_or(true),
                hidden: c.get("hidden").and_then(Value::as_bool).unwrap_or(false),
                class,
                pid: u32::try_from(num(c, "pid")).ok().filter(|p| *p > 0),
            }
        })
        .collect();
    (mons, cls)
}

/// The Hyprland rule: each monitor is covered by the highest `fullscreen` mode among the
/// mapped, non-hidden clients on its open special workspace (checked first: it is on top) or
/// its active workspace. A client on any other workspace is not on screen and never covers.
pub fn hypr_cover(monitors: &[HyprMonitor], clients: &[HyprClient]) -> CoverMap {
    let mut out = CoverMap::new();
    for m in monitors {
        let mut best = Cover::default();
        let shown = [m.special_ws, m.active_ws];
        for ws in shown.into_iter().filter(|w| *w != 0) {
            for c in clients
                .iter()
                .filter(|c| c.workspace == ws && c.mapped && !c.hidden)
            {
                let cand = Cover::by(
                    CoverState::from_hypr(c.fullscreen),
                    Some(c.class.clone()).filter(|s| !s.is_empty()),
                    c.pid,
                );
                if better(&best, &cand) {
                    best = cand;
                }
            }
        }
        out.insert(m.name.clone(), best);
    }
    out
}

// ---------------------------------------------------------------- Sway

fn sway_children(n: &Value) -> impl Iterator<Item = &Value> {
    ["nodes", "floating_nodes"]
        .into_iter()
        .filter_map(|k| n.get(k).and_then(Value::as_array))
        .flatten()
}

/// The node, or a view inside it, is on screen (`visible` is set on views only).
fn sway_visible(n: &Value) -> bool {
    n.get("visible").and_then(Value::as_bool) == Some(true) || sway_children(n).any(sway_visible)
}

fn sway_window(n: &Value) -> Cover {
    let app_id = n
        .get("app_id")
        .and_then(Value::as_str)
        .or_else(|| {
            n.get("window_properties")
                .and_then(|w| w.get("class"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let pid = u32::try_from(num(n, "pid")).ok().filter(|p| *p > 0);
    Cover::by(CoverState::Fullscreen, app_id, pid)
}

/// Every fullscreen, visible container under `n`: `(fullscreen_mode, cover)`.
fn sway_fullscreens(n: &Value, out: &mut Vec<(i64, Cover)>) {
    let mode = num(n, "fullscreen_mode");
    if mode > 0 && sway_visible(n) {
        out.push((mode, sway_window(n)));
    }
    for c in sway_children(n) {
        sway_fullscreens(c, out);
    }
}

/// The Sway rule over a `GET_TREE` reply: a visible container with `fullscreen_mode` 1 covers
/// its output, 2 (global fullscreen) every output. Sway has no maximized state.
pub fn sway_cover(tree: &Value) -> CoverMap {
    let mut out = CoverMap::new();
    let mut global = None;
    let outputs: Vec<&Value> = sway_children(tree)
        .filter(|o| o.get("type").and_then(Value::as_str) == Some("output"))
        .filter(|o| o.get("name").and_then(Value::as_str) != Some("__i3"))
        .collect();
    for o in &outputs {
        let name = o
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut found = Vec::new();
        sway_fullscreens(o, &mut found);
        let mut cover = Cover::default();
        for (mode, c) in found {
            if mode >= 2 {
                global.get_or_insert(c.clone());
            }
            if cover.state == CoverState::None {
                cover = c;
            }
        }
        out.insert(name, cover);
    }
    if let Some(g) = global {
        for c in out.values_mut() {
            *c = g.clone();
        }
    }
    out
}

// ---------------------------------------------------------------- wlr-foreign-toplevel

/// One `zwlr_foreign_toplevel_handle_v1` as of its last `done`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Toplevel {
    pub app_id: String,
    pub fullscreen: bool,
    pub maximized: bool,
    /// Keyboard focus — recorded, **never** part of the rule.
    pub activated: bool,
    pub minimized: bool,
    /// Connector names the toplevel entered (`output_enter`/`output_leave`).
    pub outputs: BTreeSet<String>,
}

impl Toplevel {
    fn state(&self) -> CoverState {
        if self.minimized {
            CoverState::None
        } else if self.fullscreen {
            CoverState::Fullscreen
        } else if self.maximized {
            CoverState::Maximized
        } else {
            CoverState::None
        }
    }
}

/// The wlr-ft tracker: handle key (the protocol object id) → its committed state.
#[derive(Debug, Clone, Default)]
pub struct Toplevels {
    map: BTreeMap<u32, Toplevel>,
}

impl Toplevels {
    pub fn upsert(&mut self, key: u32, t: Toplevel) {
        self.map.insert(key, t);
    }

    pub fn remove(&mut self, key: u32) {
        self.map.remove(&key);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&u32, &Toplevel)> {
        self.map.iter()
    }

    /// `connector`'s cover: the highest state among the toplevels on it, any focus.
    pub fn covered(&self, connector: &str) -> Cover {
        let mut best = Cover::default();
        for t in self.map.values().filter(|t| t.outputs.contains(connector)) {
            let cand = Cover::by(
                t.state(),
                Some(t.app_id.clone()).filter(|s| !s.is_empty()),
                None,
            );
            if better(&best, &cand) {
                best = cand;
            }
        }
        best
    }

    /// Every connector in `connectors`, covered or not.
    pub fn cover_map<'a>(&self, connectors: impl IntoIterator<Item = &'a str>) -> CoverMap {
        connectors
            .into_iter()
            .map(|c| (c.to_string(), self.covered(c)))
            .collect()
    }
}

/// wlr-ft `state` array (native-endian `u32`s): 0 maximized, 1 minimized, 2 activated,
/// 3 fullscreen. Returns `(maximized, minimized, activated, fullscreen)`.
pub fn ft_states(raw: &[u8]) -> (bool, bool, bool, bool) {
    let mut s = (false, false, false, false);
    for ch in raw.chunks_exact(4) {
        match u32::from_ne_bytes([ch[0], ch[1], ch[2], ch[3]]) {
            0 => s.0 = true,
            1 => s.1 = true,
            2 => s.2 = true,
            3 => s.3 = true,
            _ => {}
        }
    }
    s
}

// ---------------------------------------------------------------- the hold

/// A change of the hold ([`CoverHold::update`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HoldEdge {
    /// The rule held for [`COVER_ENGAGE_MS`]: `pending` is how long it held.
    Engaged { pending: Duration },
    /// The rule stopped holding: `held` is how long the hold was engaged.
    Released { held: Duration },
}

/// The cover hold's debounce, on the player's base clock: engages once the rule has held for
/// [`COVER_ENGAGE_MS`] in a row, releases the first time it doesn't.
#[derive(Debug, Clone, Default)]
pub struct CoverHold {
    pending_since: Option<Duration>,
    engaged_at: Option<Duration>,
}

impl CoverHold {
    pub fn update(&mut self, now: Duration, rule: bool) -> Option<HoldEdge> {
        if !rule {
            self.pending_since = None;
            return self.engaged_at.take().map(|at| HoldEdge::Released {
                held: now.saturating_sub(at),
            });
        }
        if self.engaged_at.is_some() {
            return None;
        }
        let since = *self.pending_since.get_or_insert(now);
        let pending = now.saturating_sub(since);
        if pending >= Duration::from_millis(COVER_ENGAGE_MS) {
            self.engaged_at = Some(now);
            return Some(HoldEdge::Engaged { pending });
        }
        None
    }

    pub fn active(&self) -> bool {
        self.engaged_at.is_some()
    }

    /// Since when the rule holds (pending or engaged).
    pub fn pending_since(&self) -> Option<Duration> {
        self.pending_since
    }

    pub fn engaged_at(&self) -> Option<Duration> {
        self.engaged_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(name: &str, active: i64, special: i64) -> HyprMonitor {
        HyprMonitor {
            name: name.into(),
            active_ws: active,
            special_ws: special,
        }
    }

    fn cl(ws: i64, fs: i64, class: &str) -> HyprClient {
        HyprClient {
            workspace: ws,
            fullscreen: fs,
            mapped: true,
            hidden: false,
            class: class.into(),
            pid: Some((100 + ws).unsigned_abs() as u32),
        }
    }

    fn st(m: &CoverMap, c: &str) -> CoverState {
        m.get(c).map(|c| c.state).unwrap_or_default()
    }

    #[test]
    fn hypr_fullscreen_on_the_active_workspace_covers() {
        let mons = [mon("DP-1", 1, 0), mon("DP-2", 6, 0)];
        let m = hypr_cover(&mons, &[cl(1, 2, "game"), cl(6, 0, "kitty")]);
        assert_eq!(st(&m, "DP-1"), CoverState::Fullscreen);
        assert_eq!(m["DP-1"].app_id.as_deref(), Some("game"));
        assert_eq!(m["DP-1"].pid, Some(101));
        assert_eq!(st(&m, "DP-2"), CoverState::None);
        assert_eq!(m["DP-2"].by_json(), json!({}));
    }

    /// The revision's reason: focus is not part of the Hyprland rule at all (the records carry
    /// none), so a fullscreen game on DP-1 still covers while DP-2 has the focus.
    #[test]
    fn hypr_focus_elsewhere_still_covers() {
        let monitors = json!([
            {"name": "DP-1", "activeWorkspace": {"id": 1}, "specialWorkspace": {"id": 0}, "focused": false},
            {"name": "DP-2", "activeWorkspace": {"id": 6}, "specialWorkspace": {"id": 0}, "focused": true}
        ]);
        let clients = json!([
            {"class": "steam_app_1", "pid": 4242, "workspace": {"id": 1}, "fullscreen": 2,
             "mapped": true, "hidden": false, "focusHistoryID": 1, "visible": true},
            {"class": "kitty", "pid": 10, "workspace": {"id": 6}, "fullscreen": 0,
             "mapped": true, "hidden": false, "focusHistoryID": 0, "visible": true}
        ]);
        let (m, c) = hypr_parse(&monitors, &clients);
        let map = hypr_cover(&m, &c);
        assert_eq!(st(&map, "DP-1"), CoverState::Fullscreen);
        assert_eq!(map["DP-1"].pid, Some(4242));
        assert_eq!(st(&map, "DP-2"), CoverState::None);
    }

    /// A fullscreen window on a workspace that isn't shown never covers — whatever Hyprland's
    /// `visible` field says (it reports `true` for windows on inactive workspaces).
    #[test]
    fn hypr_hidden_workspace_never_covers() {
        let monitors =
            json!([{"name": "DP-1", "activeWorkspace": {"id": 1}, "specialWorkspace": {"id": 0}}]);
        let clients = json!([{"class": "mpv", "pid": 7, "workspace": {"id": 4}, "fullscreen": 2,
                              "mapped": true, "hidden": false, "visible": true}]);
        let (m, c) = hypr_parse(&monitors, &clients);
        assert_eq!(st(&hypr_cover(&m, &c), "DP-1"), CoverState::None);
    }

    #[test]
    fn hypr_special_workspace_covers_its_monitor() {
        let mons = [mon("DP-1", 1, -98), mon("DP-2", 6, 0)];
        // The special workspace's fullscreen window covers DP-1 only.
        let m = hypr_cover(&mons, &[cl(-98, 2, "spotify"), cl(6, 0, "kitty")]);
        assert_eq!(st(&m, "DP-1"), CoverState::Fullscreen);
        assert_eq!(m["DP-1"].app_id.as_deref(), Some("spotify"));
        assert_eq!(st(&m, "DP-2"), CoverState::None);
        // Closed (id 0): its windows are not on screen.
        let m = hypr_cover(&[mon("DP-1", 1, 0)], &[cl(-98, 2, "spotify")]);
        assert_eq!(st(&m, "DP-1"), CoverState::None);
        // Open but not fullscreen, over a fullscreen window on the active workspace: the
        // wallpaper is still hidden behind that one.
        let m = hypr_cover(
            &[mon("DP-1", 1, -98)],
            &[cl(-98, 0, "spotify"), cl(1, 2, "game")],
        );
        assert_eq!(st(&m, "DP-1"), CoverState::Fullscreen);
        assert_eq!(m["DP-1"].app_id.as_deref(), Some("game"));
    }

    #[test]
    fn hypr_maximized_bit_and_both_bits() {
        assert_eq!(CoverState::from_hypr(0), CoverState::None);
        assert_eq!(CoverState::from_hypr(1), CoverState::Maximized);
        assert_eq!(CoverState::from_hypr(2), CoverState::Fullscreen);
        assert_eq!(CoverState::from_hypr(3), CoverState::Fullscreen);
        let m = hypr_cover(&[mon("DP-2", 7, 0)], &[cl(7, 1, "kitty")]);
        assert_eq!(st(&m, "DP-2"), CoverState::Maximized);
        // The highest wins on one workspace.
        let m = hypr_cover(&[mon("DP-2", 7, 0)], &[cl(7, 1, "kitty"), cl(7, 2, "mpv")]);
        assert_eq!(m["DP-2"].app_id.as_deref(), Some("mpv"));
    }

    #[test]
    fn hypr_unmapped_or_hidden_group_member_never_covers() {
        let mut a = cl(1, 2, "a");
        a.mapped = false;
        let mut b = cl(1, 2, "b");
        b.hidden = true;
        let m = hypr_cover(&[mon("DP-1", 1, 0)], &[a, b]);
        assert_eq!(st(&m, "DP-1"), CoverState::None);
        // Disabled monitors are left out; an empty class falls back to initialClass; pid −1 → none.
        let monitors = json!([{"name": "DP-1", "activeWorkspace": {"id": 1}, "specialWorkspace": {"id": 0}},
                              {"name": "HDMI-A-1", "disabled": true, "activeWorkspace": {"id": 2}}]);
        let clients = json!([{"class": "", "initialClass": "Xwl", "pid": -1, "workspace": {"id": 1},
                              "fullscreen": 1, "mapped": true, "hidden": false}]);
        let (m, c) = hypr_parse(&monitors, &clients);
        assert_eq!(m.len(), 1);
        let map = hypr_cover(&m, &c);
        assert_eq!(map["DP-1"].app_id.as_deref(), Some("Xwl"));
        assert_eq!(map["DP-1"].pid, None);
    }

    fn sway_tree(ws1: Value, ws2: Value) -> Value {
        json!({"type": "root", "nodes": [
            {"type": "output", "name": "__i3", "nodes": []},
            {"type": "output", "name": "DP-1", "nodes": [ws1]},
            {"type": "output", "name": "DP-2", "nodes": [ws2]}
        ]})
    }

    #[test]
    fn sway_visible_fullscreen_covers_and_global_covers_all() {
        let view = |fs: i64, vis: bool, app: &str| json!({"type": "con", "fullscreen_mode": fs, "visible": vis, "app_id": app, "pid": 55});
        let ws =
            |nodes: Vec<Value>| json!({"type": "workspace", "nodes": nodes, "floating_nodes": []});
        let m = sway_cover(&sway_tree(
            ws(vec![view(1, true, "mpv")]),
            ws(vec![view(0, true, "foot")]),
        ));
        assert_eq!(m.len(), 2, "__i3 is not an output");
        assert_eq!(st(&m, "DP-1"), CoverState::Fullscreen);
        assert_eq!(m["DP-1"].app_id.as_deref(), Some("mpv"));
        assert_eq!(m["DP-1"].pid, Some(55));
        assert_eq!(st(&m, "DP-2"), CoverState::None);
        // On a hidden workspace (`visible: false`): no cover.
        let m = sway_cover(&sway_tree(ws(vec![view(1, false, "mpv")]), ws(vec![])));
        assert_eq!(st(&m, "DP-1"), CoverState::None);
        // A fullscreen split container: visible through its views; XWayland → the class.
        let split = json!({"type": "con", "fullscreen_mode": 1, "nodes": [
            {"type": "con", "fullscreen_mode": 0, "visible": true, "app_id": null,
             "window_properties": {"class": "Steam"}, "pid": 9}]});
        let m = sway_cover(&sway_tree(ws(vec![split]), ws(vec![])));
        assert_eq!(st(&m, "DP-1"), CoverState::Fullscreen);
        // Global fullscreen covers every output.
        let m = sway_cover(&sway_tree(
            ws(vec![view(2, true, "game")]),
            ws(vec![view(0, true, "foot")]),
        ));
        assert_eq!(st(&m, "DP-1"), CoverState::Fullscreen);
        assert_eq!(st(&m, "DP-2"), CoverState::Fullscreen);
        assert_eq!(m["DP-2"].app_id.as_deref(), Some("game"));
    }

    fn tl(app: &str, fs: bool, max: bool, act: bool, min: bool, outs: &[&str]) -> Toplevel {
        Toplevel {
            app_id: app.into(),
            fullscreen: fs,
            maximized: max,
            activated: act,
            minimized: min,
            outputs: outs.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn ft_any_focus_covers_minimized_never() {
        let mut t = Toplevels::default();
        // Fullscreen on DP-1 without the focus (the user clicked DP-2): still covers.
        t.upsert(1, tl("game", true, false, false, false, &["DP-1"]));
        t.upsert(2, tl("foot", false, false, true, false, &["DP-2"]));
        assert_eq!(t.covered("DP-1").state, CoverState::Fullscreen);
        assert_eq!(t.covered("DP-1").app_id.as_deref(), Some("game"));
        assert_eq!(t.covered("DP-2").state, CoverState::None);
        // Minimized never covers.
        t.upsert(3, tl("mpv", true, false, true, true, &["DP-2"]));
        assert_eq!(t.covered("DP-2").state, CoverState::None);
        // Maximized on DP-2, then closed.
        t.upsert(4, tl("kitty", false, true, false, false, &["DP-2"]));
        assert_eq!(t.covered("DP-2").state, CoverState::Maximized);
        t.remove(4);
        let m = t.cover_map(["DP-1", "DP-2", "HDMI-A-1"]);
        assert_eq!(m.len(), 3);
        assert_eq!(st(&m, "DP-2"), CoverState::None);
        // The wire format.
        let raw: Vec<u8> = [3u32, 2].iter().flat_map(|v| v.to_ne_bytes()).collect();
        assert_eq!(ft_states(&raw), (false, false, true, true));
    }

    #[test]
    fn maximized_mode_counts_maximized_and_fullscreen() {
        assert!(mode_covers("maximized", CoverState::Maximized));
        assert!(mode_covers("maximized", CoverState::Fullscreen));
        assert!(!mode_covers("maximized", CoverState::None));
        assert!(mode_covers("fullscreen", CoverState::Fullscreen));
        assert!(!mode_covers("fullscreen", CoverState::Maximized));
        assert!(!mode_covers("off", CoverState::Fullscreen));
    }

    #[test]
    fn cover_rule_needs_every_showing_output() {
        let s =
            |a: CoverState, b: CoverState| vec![("DP-1".to_string(), a), ("DP-2".to_string(), b)];
        use CoverState::*;
        assert!(cover_rule("fullscreen", &s(Fullscreen, Fullscreen)));
        assert!(!cover_rule("fullscreen", &s(Fullscreen, None)));
        assert!(!cover_rule("fullscreen", &s(Fullscreen, Maximized)));
        assert!(cover_rule("maximized", &s(Fullscreen, Maximized)));
        assert!(!cover_rule("off", &s(Fullscreen, Fullscreen)));
        assert!(
            !cover_rule("maximized", &[]),
            "nothing shown → nothing to pause"
        );
        // Only showing outputs are passed: one covered output alone showing content pauses.
        assert!(cover_rule("maximized", &[("DP-1".into(), Maximized)]));
    }

    #[test]
    fn hold_engages_after_300_ms_and_releases_at_once() {
        let ms = Duration::from_millis;
        let mut h = CoverHold::default();
        assert_eq!(h.update(ms(0), true), None);
        assert_eq!(h.update(ms(299), true), None);
        assert!(!h.active());
        assert_eq!(
            h.update(ms(300), true),
            Some(HoldEdge::Engaged { pending: ms(300) })
        );
        assert!(h.active());
        assert_eq!(h.update(ms(5000), true), None);
        assert_eq!(
            h.update(ms(5016), false),
            Some(HoldEdge::Released { held: ms(4716) })
        );
        assert!(!h.active());
        // A flap restarts the wait.
        for i in 0..5 {
            assert_eq!(h.update(ms(6000 + i * 200), true), None);
            assert_eq!(h.update(ms(6100 + i * 200), false), None);
        }
        assert!(!h.active());
    }
}
