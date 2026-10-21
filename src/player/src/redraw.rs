//! The redraw policy for frame-paced outputs (Task 13, Wayland): an output presents a new
//! frame only when its picture can have changed — never 240 fps of a static colour.
//!
//! An output **wants a frame** when any of these holds since its last present:
//! - the graph's [`Graph::picture_rev`] moved (a create/destroy or a non-gain `set` —
//!   conservative: any picture change anywhere wakes every output once);
//! - a source it shows (main layer `content`, or either side of the effect there) produced
//!   a new texture ([`Redraw::mark_shown`], from `SourceHost::take_changed`) — a playing
//!   video presents at its own frame rate, each frame at the next refresh;
//! - the backend asked for one (first configure, resize, re-created surface —
//!   [`Redraw::mark`]);
//! - or something **animates** ([`animating`]: a started, unfinished animation on a
//!   non-gain path, e.g. a transition's `progress` or an opacity ramp) — then it presents
//!   on *every* frame callback, at its own refresh, even between two animator ticks.
//!
//! Otherwise it is **idle**: no frame is drawn and no frame callback requested (the
//! `frames` probe reports `idle: true`). Headless outputs don't use this — they compose on
//! every tick, unchanged (R46).

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use crate::anim::{Animator, PropPath};
use crate::graph::{Graph, NodeKind, PropValue};

/// Per-output "has the picture changed since its last present" bookkeeping.
#[derive(Debug, Default)]
pub struct Redraw {
    /// Output name → the graph's `picture_rev` at its last present.
    drawn_rev: BTreeMap<String, u64>,
    /// Outputs with a new source frame / a backend request since their last present.
    dirty: BTreeSet<String>,
}

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
    }
}

/// Whether `path` only changes audio (a `gain.<slot>`), never a picture.
pub fn audio_only(path: &PropPath) -> bool {
    path.0
        .split_once('.')
        .is_some_and(|(_, prop)| prop.starts_with("gain."))
}

/// Something visible moves: a started, unfinished animation on a non-gain path.
pub fn animating(anim: &Animator, now: Duration) -> bool {
    anim.any_live(now, |p| !audio_only(p))
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
