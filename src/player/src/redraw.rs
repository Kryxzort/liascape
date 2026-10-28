//! The redraw policy for frame-paced outputs (Task 13, Wayland): an output presents a new
//! frame only when its picture can have changed — never 240 fps of a static colour.
//!
//! An output **wants a frame** when any of these holds since its last present:
//! - the graph's [`Graph::picture_rev`] moved (a create/destroy or a non-gain `set` other
//!   than the Animator's — conservative: such a change anywhere wakes every output once);
//! - an animated value changed on a node it shows ([`Redraw::mark_nodes`]: the Animator's
//!   per-tick sets go through `Graph::set_animated`, which doesn't move `picture_rev`, and
//!   mark only the outputs whose [`shown_nodes`] contain the animated node — Task 16);
//! - a source it shows (main layer `content`, or either side of the effect there) produced
//!   a new texture ([`Redraw::mark_shown`], from `SourceHost::take_changed`) — a playing
//!   video presents at its own frame rate, each frame at the next refresh;
//! - the backend asked for one (first configure, resize, re-created surface —
//!   [`Redraw::mark`]);
//! - or something **animates on it** ([`animating_on`]: a started, unfinished animation on
//!   a non-gain path of a node it shows — its `out:` node, its main layer, the layer's
//!   content (a source or an effect) or either side of that effect; e.g. a transition's
//!   `progress` or an opacity ramp) — then it presents on *every* frame callback, at its
//!   own refresh, even between two animator ticks. An animation on another output's
//!   nodes doesn't count (Task 16, review item a).
//!
//! Otherwise it is **idle**: no frame is drawn and no frame callback requested (the
//! `frames` probe reports `idle: true`). Headless outputs don't use this — they compose on
//! every tick, unchanged (R46).
//!
//! **Scene frames are gated per output (Phase 2 Task 8):** one scene worker serves every
//! output showing it (D1) and ticks at the fastest of their `eff(scene_fps, refresh)`, so a
//! new scene frame wakes output `<c>` at most `eff(out:<c>.scene_fps, refresh)` times per
//! second ([`Redraw::mark_shown_gated`]): on a grid of that period, a frame that comes early
//! is deferred to its slot ([`Redraw::promote_due`]) — never dropped, so the last frame before
//! a pause is still drawn. Anything else that wakes the output (a video it shows, an
//! animation) presents the scene's newest frame with it.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use crate::anim::{Animator, PropPath, is_gain_path};
use crate::graph::{Graph, NodeKind, PropValue};

/// Per-output "has the picture changed since its last present" bookkeeping.
#[derive(Debug, Default)]
pub struct Redraw {
    /// Output name → the graph's `picture_rev` at its last present.
    drawn_rev: BTreeMap<String, u64>,
    /// Outputs with a new source frame / a backend request since their last present.
    dirty: BTreeSet<String>,
    /// Task 8: per output, the grid slot of the last scene frame let through…
    gate_last: BTreeMap<String, Instant>,
    /// …and when a scene frame that came early may wake it.
    gate_due: BTreeMap<String, Instant>,
}

/// A gated scene frame this close before its slot is on time (the loop's own jitter must not
/// cost a slot).
pub const GATE_SLACK: Duration = Duration::from_millis(2);

impl Redraw {
    pub fn new() -> Redraw {
        Redraw::default()
    }

    /// Output `name` needs a fresh frame (backend: configured, resized, re-created).
    pub fn mark(&mut self, name: &str) {
        self.dirty.insert(name.to_string());
    }

    /// `changed` sources have new textures: mark every output showing one of them.
    pub fn mark_shown(&mut self, graph: &Graph, changed: &BTreeSet<String>) {
        if changed.is_empty() {
            return;
        }
        for out in graph.ids_of(NodeKind::Output) {
            let Some(name) = out.strip_prefix("out:") else {
                continue;
            };
            if shown_by(graph, &format!("lay:{name}:main"))
                .iter()
                .any(|s| changed.contains(s))
            {
                self.dirty.insert(name.to_string());
            }
        }
    }

    /// [`mark_shown`](Self::mark_shown) with the per-output scene gate (Task 8): `period(src,
    /// output)` = `Some(1 / eff(scene_fps, refresh))` for a scene source, `None` for anything
    /// else (marks at once). An output only woken by gated sources is marked on a grid of its
    /// period; an early frame is deferred to its slot (`promote_due`).
    pub fn mark_shown_gated(
        &mut self,
        graph: &Graph,
        changed: &BTreeSet<String>,
        now: Instant,
        period: impl Fn(&str, &str) -> Option<Duration>,
    ) {
        if changed.is_empty() {
            return;
        }
        for out in graph.ids_of(NodeKind::Output) {
            let Some(name) = out.strip_prefix("out:") else {
                continue;
            };
            let mut gated: Option<Duration> = None;
            let mut ungated = false;
            for s in shown_by(graph, &format!("lay:{name}:main")) {
                if !changed.contains(&s) {
                    continue;
                }
                match period(&s, name) {
                    Some(p) => gated = Some(gated.map_or(p, |g| g.min(p))),
                    None => ungated = true,
                }
            }
            if ungated {
                self.dirty.insert(name.to_string());
            } else if let Some(p) = gated {
                self.gate(name, p, now);
            }
        }
    }

    fn gate(&mut self, name: &str, period: Duration, now: Instant) {
        match self.gate_last.get(name).copied() {
            Some(last) if now + GATE_SLACK < last + period => {
                self.gate_due.entry(name.to_string()).or_insert(last + period);
            }
            last => self.open_gate(name, last, period, now),
        }
    }

    /// Let a scene frame through on `name`'s grid (`last` + `period`, or now after a gap).
    fn open_gate(&mut self, name: &str, last: Option<Instant>, period: Duration, now: Instant) {
        let slot = match last {
            Some(l) if l + period + period > now => l + period,
            _ => now,
        };
        self.dirty.insert(name.to_string());
        self.gate_last.insert(name.to_string(), slot);
        self.gate_due.remove(name);
    }

    /// Deferred scene frames whose slot came (`mark_shown_gated`): mark their outputs. Call
    /// before deciding what presents (every paced pass).
    pub fn promote_due(&mut self, now: Instant) {
        let due: Vec<(String, Instant)> = self
            .gate_due
            .iter()
            .filter(|(_, d)| now + GATE_SLACK >= **d)
            .map(|(n, d)| (n.clone(), *d))
            .collect();
        for (name, d) in due {
            self.dirty.insert(name.clone());
            self.gate_last.insert(name.clone(), d);
            self.gate_due.remove(&name);
        }
    }

    /// The Animator just set values on `nodes` (`Graph::set_animated`): mark every output
    /// that shows one of them ([`shown_nodes`]).
    pub fn mark_nodes(&mut self, graph: &Graph, nodes: &BTreeSet<String>) {
        if nodes.is_empty() {
            return;
        }
        for out in graph.ids_of(NodeKind::Output) {
            let Some(name) = out.strip_prefix("out:") else {
                continue;
            };
            if shown_nodes(graph, name).iter().any(|n| nodes.contains(n)) {
                self.dirty.insert(name.to_string());
            }
        }
    }

    /// Whether output `name` should present now (given it can take a frame): the graph's
    /// picture moved since its last present (`rev` = [`Graph::picture_rev`]), it is
    /// marked, or something animates.
    pub fn wants(&self, name: &str, rev: u64, animating: bool) -> bool {
        animating || self.dirty.contains(name) || self.drawn_rev.get(name) != Some(&rev)
    }

    /// Output `name` just presented the picture of graph revision `rev`.
    pub fn drawn(&mut self, name: &str, rev: u64) {
        self.dirty.remove(name);
        self.drawn_rev.insert(name.to_string(), rev);
    }

    /// Output `name` is gone.
    pub fn forget(&mut self, name: &str) {
        self.dirty.remove(name);
        self.drawn_rev.remove(name);
        self.gate_last.remove(name);
        self.gate_due.remove(name);
    }
}

/// Whether `path` only changes audio (a `gain.<slot>`), never a picture. Shares its
/// definition with [`is_gain_path`] (R90, Task 16d) — one predicate, not two that could
/// drift apart.
pub fn audio_only(path: &PropPath) -> bool {
    is_gain_path(path)
}

/// Something visible moves: a started, unfinished animation on a non-gain path.
pub fn animating(anim: &Animator, now: Duration) -> bool {
    anim.any_live(now, |p| !audio_only(p))
}

/// The node an animation path targets (`lay:DP-1:main.opacity` → `lay:DP-1:main`).
pub fn node_of(path: &PropPath) -> &str {
    path.0.split_once('.').map_or(path.0.as_str(), |(n, _)| n)
}

/// Every node whose (non-gain) animation changes what output `name` shows: `out:<name>`,
/// its main layer, that layer's content (a source or an effect) and the effect's sides.
pub fn shown_nodes(graph: &Graph, name: &str) -> BTreeSet<String> {
    let layer = format!("lay:{name}:main");
    let mut s = shown_by(graph, &layer);
    if let Ok(PropValue::Str(c)) = graph.get(&PropPath(format!("{layer}.content")))
        && !c.is_empty()
    {
        s.insert(c);
    }
    s.insert(layer);
    s.insert(format!("out:{name}"));
    s
}

/// Something visible moves **on output `name`**: a started, unfinished, non-gain animation
/// on one of its [`shown_nodes`].
pub fn animating_on(anim: &Animator, now: Duration, graph: &Graph, name: &str) -> bool {
    if !animating(anim, now) {
        return false; // cheap common case: nothing moves anywhere
    }
    let nodes = shown_nodes(graph, name);
    anim.any_live(now, |p| !audio_only(p) && nodes.contains(node_of(p)))
}

/// The sources layer `layer` shows: its `content` if that is a source, or both sides of
/// the effect it shows.
pub fn shown_by(graph: &Graph, layer: &str) -> BTreeSet<String> {
    let str_prop = |id: &str, prop: &str| match graph.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::Str(s)) => s,
        _ => String::new(),
    };
    let mut out = BTreeSet::new();
    let c = str_prop(layer, "content");
    match graph.kind_of(&c) {
        Some(NodeKind::Source) => {
            out.insert(c);
        }
        Some(NodeKind::Effect) => {
            out.insert(str_prop(&c, "from"));
            out.insert(str_prop(&c, "to"));
        }
        _ => {}
    }
    out.retain(|s| !s.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anim::{AnimUnit, Animation, Curve};
    use serde_json::{Map, json};

    fn p(s: &str) -> PropPath {
        PropPath(s.to_string())
    }

    /// DP-1 shows `a`, DP-2 shows `b`.
    fn two_outputs() -> Graph {
        let mut g = Graph::new();
        for o in ["out:DP-1", "out:DP-2"] {
            g.create(NodeKind::Output, Some(o.into()), Map::new())
                .unwrap();
        }
        for s in ["a", "b"] {
            g.create(NodeKind::Source, Some(s.into()), Map::new())
                .unwrap();
        }
        g.set(&p("lay:DP-1:main.content"), PropValue::Str("a".into()))
            .unwrap();
        g.set(&p("lay:DP-2:main.content"), PropValue::Str("b".into()))
            .unwrap();
        g
    }

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn new_output_wants_its_first_frame() {
        let g = two_outputs();
        let r = Redraw::new();
        assert!(r.wants("DP-1", g.picture_rev(), false));
    }

    #[test]
    fn static_picture_goes_idle() {
        let g = two_outputs();
        let mut r = Redraw::new();
        let rev = g.picture_rev();
        r.drawn("DP-1", rev);
        r.drawn("DP-2", rev);
        assert!(!r.wants("DP-1", rev, false), "nothing changed: idle");
        assert!(!r.wants("DP-2", rev, false));
    }

    #[test]
    fn picture_change_wakes_every_output_once() {
        let mut g = two_outputs();
        let mut r = Redraw::new();
        r.drawn("DP-1", g.picture_rev());
        r.drawn("DP-2", g.picture_rev());
        g.set(&p("lay:DP-1:main.opacity"), PropValue::F64(0.5))
            .unwrap();
        let rev = g.picture_rev();
        assert!(r.wants("DP-1", rev, false));
        assert!(r.wants("DP-2", rev, false), "conservative: every output");
        r.drawn("DP-1", rev);
        assert!(!r.wants("DP-1", rev, false), "once");
    }

    #[test]
    fn gain_change_does_not_wake() {
        let mut g = two_outputs();
        let mut r = Redraw::new();
        r.drawn("DP-1", g.picture_rev());
        g.set(&p("a.gain.user"), PropValue::F64(-12.0)).unwrap();
        assert!(!r.wants("DP-1", g.picture_rev(), false));
    }

    #[test]
    fn new_source_frame_wakes_only_outputs_showing_it() {
        let g = two_outputs();
        let mut r = Redraw::new();
        let rev = g.picture_rev();
        r.drawn("DP-1", rev);
        r.drawn("DP-2", rev);
        r.mark_shown(&g, &set(&["b"]));
        assert!(!r.wants("DP-1", rev, false), "DP-1 shows a, not b");
        assert!(r.wants("DP-2", rev, false));
        r.mark_shown(&g, &set(&["unrelated"]));
        assert!(!r.wants("DP-1", rev, false));
    }

    #[test]
    fn both_sides_of_an_effect_count_as_shown() {
        let mut g = two_outputs();
        let mut props = Map::new();
        props.insert("effect_id".into(), json!("fade"));
        props.insert("from".into(), json!("a"));
        props.insert("to".into(), json!("b"));
        g.create(NodeKind::Effect, Some("fx1".into()), props)
            .unwrap();
        g.set(&p("lay:DP-1:main.content"), PropValue::Str("fx1".into()))
            .unwrap();
        assert_eq!(shown_by(&g, "lay:DP-1:main"), set(&["a", "b"]));
        let mut r = Redraw::new();
        let rev = g.picture_rev();
        r.drawn("DP-1", rev);
        r.mark_shown(&g, &set(&["b"]));
        assert!(
            r.wants("DP-1", rev, false),
            "B's frames show through the effect"
        );
    }

    /// Task 8: one scene frame every 1/60 s, shown on DP-1 (scene_fps 60) and DP-2 (15): DP-1
    /// presents every frame, DP-2 at most 15 per second — on a grid, the frame that came early
    /// deferred to its slot, never lost (the last one before the scene stops is drawn too).
    #[test]
    fn scene_frames_wake_each_output_at_its_scene_fps() {
        let mut g = two_outputs();
        g.set(&p("lay:DP-2:main.content"), PropValue::Str("a".into()))
            .unwrap();
        let mut r = Redraw::new();
        let rev = g.picture_rev();
        let period = |_: &str, out: &str| {
            Some(Duration::from_secs_f64(if out == "DP-1" { 1.0 / 60.0 } else { 1.0 / 15.0 }))
        };
        let t0 = Instant::now();
        let mut presents = [0, 0];
        let pass = |r: &mut Redraw, now: Instant, presents: &mut [i32; 2]| {
            r.promote_due(now);
            for (i, o) in ["DP-1", "DP-2"].iter().enumerate() {
                if r.wants(o, rev, false) {
                    presents[i] += 1;
                    r.drawn(o, rev);
                }
            }
        };
        pass(&mut r, t0, &mut presents);
        presents = [0, 0];
        // 1 s of 60 fps frames, with the loop's own jitter (±1 ms), a pass every 4 ms between.
        for i in 0..60u64 {
            let at = t0 + Duration::from_micros(i * 16_667 + (i % 3) * 1000);
            r.mark_shown_gated(&g, &set(&["a"]), at, period);
            for k in 0..4 {
                pass(&mut r, at + Duration::from_millis(k * 4), &mut presents);
            }
        }
        assert_eq!(presents[0], 60, "DP-1 at 60: {presents:?}");
        assert!((14..=16).contains(&presents[1]), "DP-2 at 15: {presents:?}");
        // The last frame came early on DP-2: it is drawn at its slot, not lost.
        let last = t0 + Duration::from_millis(1100);
        r.mark_shown_gated(&g, &set(&["a"]), last, period);
        let mut later = [0, 0];
        pass(&mut r, last, &mut later);
        pass(&mut r, last + Duration::from_millis(70), &mut later);
        assert_eq!(later[1], 1, "the deferred frame reaches DP-2: {later:?}");
        // A non-scene source is never gated.
        r.drawn("DP-1", rev);
        r.drawn("DP-2", rev);
        r.mark_shown_gated(&g, &set(&["a"]), last + Duration::from_millis(71), |_, _| None);
        assert!(r.wants("DP-2", rev, false), "ungated: marked at once");
    }

    #[test]
    fn backend_mark_and_forget() {
        let g = two_outputs();
        let mut r = Redraw::new();
        let rev = g.picture_rev();
        r.drawn("DP-1", rev);
        r.mark("DP-1"); // resized / re-created surface
        assert!(r.wants("DP-1", rev, false));
        r.forget("DP-1");
        assert!(r.wants("DP-1", rev, false), "a re-added output starts over");
    }

    #[test]
    fn animating_presents_every_frame() {
        let g = two_outputs();
        let mut r = Redraw::new();
        let rev = g.picture_rev();
        r.drawn("DP-1", rev);
        assert!(r.wants("DP-1", rev, true));
    }

    fn anim(target: &str, start_ms: u64, dur_ms: u64) -> Animation {
        Animation {
            target: p(target),
            from: 0.0,
            to: 1.0,
            start: Duration::from_millis(start_ms),
            duration: Duration::from_millis(dur_ms),
            curve: Curve::Linear,
            unit: AnimUnit::Scalar,
            corr: None,
        }
    }

    /// Review item a: an animation counts only for the outputs that show its node.
    #[test]
    fn animating_is_scoped_per_output() {
        let ms = Duration::from_millis;
        let mut g = two_outputs();
        let mut a = Animator::new();
        a.add(anim("lay:DP-1:main.opacity", 0, 1000));
        assert!(animating_on(&a, ms(10), &g, "DP-1"));
        assert!(
            !animating_on(&a, ms(10), &g, "DP-2"),
            "DP-2 shows b, not DP-1's layer"
        );

        // An effect shown on DP-2 only (its progress animating), with a on one side.
        let mut props = Map::new();
        props.insert("effect_id".into(), json!("fade"));
        props.insert("from".into(), json!("b"));
        props.insert("to".into(), json!("c"));
        g.create(NodeKind::Source, Some("c".into()), Map::new())
            .unwrap();
        g.create(NodeKind::Effect, Some("fx1".into()), props)
            .unwrap();
        g.set(&p("lay:DP-2:main.content"), PropValue::Str("fx1".into()))
            .unwrap();
        let mut a = Animator::new();
        a.add(anim("fx1.progress", 0, 1000));
        assert!(animating_on(&a, ms(10), &g, "DP-2"));
        assert!(!animating_on(&a, ms(10), &g, "DP-1"));
        assert_eq!(
            shown_nodes(&g, "DP-2"),
            set(&["b", "c", "fx1", "lay:DP-2:main", "out:DP-2"])
        );

        // A source's own (non-gain) animation: the outputs showing it; a gain never counts.
        let mut a = Animator::new();
        a.add(anim("a.speed", 0, 1000));
        assert!(animating_on(&a, ms(10), &g, "DP-1"));
        assert!(!animating_on(&a, ms(10), &g, "DP-2"));
        let mut a = Animator::new();
        a.add(anim("c.gain.xfade", 0, 1000));
        assert!(!animating_on(&a, ms(10), &g, "DP-2"), "audio only");
        // A node no output shows: nobody animates.
        let mut a = Animator::new();
        a.add(anim("lay9.opacity", 0, 1000));
        assert!(!animating_on(&a, ms(10), &g, "DP-1") && !animating_on(&a, ms(10), &g, "DP-2"));
    }

    #[test]
    fn animated_sets_mark_only_the_outputs_showing_the_node() {
        let mut g = two_outputs();
        let mut r = Redraw::new();
        let rev = g.picture_rev();
        r.drawn("DP-1", rev);
        r.drawn("DP-2", rev);
        g.set_animated(&p("lay:DP-1:main.opacity"), PropValue::F64(0.5))
            .unwrap();
        assert_eq!(g.picture_rev(), rev);
        r.mark_nodes(&g, &set(&["lay:DP-1:main"]));
        assert!(
            r.wants("DP-1", g.picture_rev(), false),
            "its final value gets drawn"
        );
        assert!(!r.wants("DP-2", g.picture_rev(), false), "DP-2 stays idle");
        r.mark_nodes(&g, &set(&["b"]));
        assert!(r.wants("DP-2", g.picture_rev(), false));
    }

    #[test]
    fn animating_counts_started_unfinished_picture_animations_only() {
        let ms = Duration::from_millis;
        let mut a = Animator::new();
        assert!(!animating(&a, ms(0)));
        a.add(anim("src1.gain.xfade", 0, 100));
        assert!(!animating(&a, ms(50)), "a gain ramp is audio only");
        a.add(anim("fx1.progress", 100, 100));
        assert!(!animating(&a, ms(50)), "not started yet");
        assert!(animating(&a, ms(150)));
        a.tick(ms(250)); // the progress animation finishes (holds its final value)
        assert!(!animating(&a, ms(260)), "finished: nothing moves");
        assert!(audio_only(&p("src1.gain.user")));
        assert!(!audio_only(&p("lay:DP-1:main.opacity")));
    }
}
