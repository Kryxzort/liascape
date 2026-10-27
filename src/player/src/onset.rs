//! Invariant #8's one onset helper (final review I6, M12): every "un-pause, then ramp a
//! gain in" path — the transition recipe's B onsets, `restore_a` (snap-back, a failed or
//! cancelled switch, a grave shown again), unpark, a restored source's fade-in, and the
//! player-pause gate's resume (`Runtime`'s R88 gate, on its own wall clock) — holds its
//! ramp until the source's audio is really flowing ([`SourceEvent::AudioFlowing`]), never
//! longer than [`ONSET_TIMEOUT`], and skips the wait entirely for a source with nothing to
//! hear ([`has_audio`]).
//!
//! Also the one "can this source be heard" predicate: [`has_audio`] (does it carry audio
//! at all) and [`audible`] (is it producing sound right now) replace the per-module copies
//! that had drifted apart (`is_silent` ignored `has_audio`/`no_audio`).

use std::time::Duration;

use serde_json::json;

use crate::anim::{AnimUnit, Animation, Animator, Curve, PropPath};
use crate::graph::{Graph, PropValue};
use crate::log::{self, CorrId, Level};
use crate::sources::SourceEvent;
use crate::units::SILENT_DB;

/// R85 (Task 16c): the longest an onset ramp waits for [`SourceEvent::AudioFlowing`]
/// before ramping anyway. Measured real restart latency (owner's machine, PipeWire/mpv) is
/// ~19–85 ms; 150 ms gives headroom for a slow/cold audio-out restart while staying far
/// short of anything a viewer would read as "the wallpaper froze". Logged
/// `<comp>.onset_timeout` when hit.
pub const ONSET_TIMEOUT: Duration = Duration::from_millis(150);

fn prop(g: &Graph, id: &str, name: &str) -> Option<PropValue> {
    g.get(&PropPath(format!("{id}.{name}"))).ok()
}

fn flag(g: &Graph, id: &str, name: &str) -> bool {
    matches!(prop(g, id, name), Some(PropValue::Bool(true)))
}

/// Can a source of this `kind` carry audio at all? A `video` (mpv) and a `scene` (its
/// worker's stream, Phase 2) — never a `color`/`image`/`snapshot`.
pub fn kind_has_audio(kind: &str) -> bool {
    matches!(kind, "video" | "scene")
}

/// Does `id` carry audio at all? Only a live source of a kind with audio
/// ([`kind_has_audio`]: video, scene) — not `no_audio` (our own `aid=no`), and not one
/// found to have no audio (`has_audio`, R92: mpv's selected track, a scene worker's `Ready`;
/// unknown reads `true`, the conservative "don't skip a real wait" default). A `color`/
/// `image`/`snapshot` source has no audio behind it and never reports
/// [`SourceEvent::AudioFlowing`].
pub fn has_audio(g: &Graph, id: &str) -> bool {
    matches!(prop(g, id, "kind"), Some(PropValue::Str(k)) if kind_has_audio(&k))
        && !flag(g, id, "no_audio")
        && !matches!(prop(g, id, "has_audio"), Some(PropValue::Bool(false)))
}

/// Can `id` be heard right now? It has audio ([`has_audio`]), is playing (not node-paused,
/// not `effectively_paused` by the player-level pause), has played (`ready`), and isn't at
/// the −96 dB floor. Anything else may go without a ramp (`Runtime::retire`/`park`).
pub fn audible(g: &Graph, id: &str, effectively_paused: bool) -> bool {
    has_audio(g, id)
        && !flag(g, id, "paused")
        && !effectively_paused
        && flag(g, id, "ready")
        && g.effective_gain_db(id)
            .is_some_and(|db| db > SILENT_DB + 1e-9)
}

/// Whether this iteration's events confirm `id`'s audio is flowing.
pub fn flowed(events: &[(String, SourceEvent)], id: &str) -> bool {
    events
        .iter()
        .any(|(e, ev)| e == id && matches!(ev, SourceEvent::AudioFlowing))
}

/// One gain ramp held until `id`'s audio flows (or [`ONSET_TIMEOUT`]). The source has
/// already been un-paused; the slot sits at `from` (silent) until the ramp starts.
#[derive(Debug, Clone)]
pub struct PendingOnset {
    pub id: String,
    pub slot: &'static str,
    /// Linear amplitudes (`AnimUnit::GainLinear`).
    pub from: f64,
    pub to: f64,
    pub dur: Duration,
    pub curve: Curve,
    /// When the un-pause was requested (the holder's clock) — what [`ONSET_TIMEOUT`]
    /// bounds.
    pub requested: Duration,
    pub corr: Option<CorrId>,
}

impl PendingOnset {
    /// Start the ramp now (confirmed, timed out, or forced) — `start` is the instant of
    /// confirmation, never backdated to the un-pause. Logged `onset.started {id, slot,
    /// reason, held_ms}` (debug): `reason` = `flowed` | `timeout` | `forced` | `no_audio`
    /// — the evidence that a ramp began on flowing audio (I6 tests).
    pub fn start(self, anim: &mut Animator, now: Duration, reason: &str) {
        started(
            &self.id,
            self.slot,
            reason,
            now.saturating_sub(self.requested),
            self.corr.clone(),
        );
        anim.add(Animation {
            target: PropPath(format!("{}.gain.{}", self.id, self.slot)),
            from: self.from,
            to: self.to,
            start: now,
            duration: self.dur,
            curve: self.curve,
            unit: AnimUnit::GainLinear,
            corr: self.corr,
        });
    }

    pub fn timed_out(&self, now: Duration) -> bool {
        now >= self.requested + ONSET_TIMEOUT
    }
}

/// `onset.held {id, slot}` (debug): a ramp-in is waiting for `id`'s audio to flow.
pub fn held(id: &str, slot: &str, corr: Option<CorrId>) {
    log::event(
        "onset",
        Level::Debug,
        "onset.held",
        corr,
        json!({ "id": id, "slot": slot }),
    );
}

/// `onset.started {id, slot, reason, held_ms}` (debug) — every held onset path, and the
/// player-pause gate's resume, report the start of their ramp-in through this.
pub fn started(id: &str, slot: &str, reason: &str, held: Duration, corr: Option<CorrId>) {
    log::event(
        "onset",
        Level::Debug,
        "onset.started",
        corr,
        json!({ "id": id, "slot": slot, "reason": reason,
                "held_ms": held.as_secs_f64() * 1000.0 }),
    );
}

/// Log a timed-out onset (`<comp>.onset_timeout`).
pub fn log_timeout(comp: &'static str, o: &PendingOnset, now: Duration) {
    log::event(
        comp,
        Level::Warn,
        if comp == "transition" {
            "transition.onset_timeout"
        } else {
            "runtime.onset_timeout"
        },
        o.corr.clone(),
        json!({ "id": o.id, "slot": o.slot,
                "waited_ms": now.saturating_sub(o.requested).as_secs_f64() * 1000.0 }),
    );
}

/// A holder of pending onsets (the recipe's restore onsets, the runtime's unpark/restore
/// fades). The recipe's per-transition B onset uses [`PendingOnset`] directly.
#[derive(Debug, Default)]
pub struct Onsets {
    pending: Vec<PendingOnset>,
}

impl Onsets {
    pub fn new() -> Onsets {
        Onsets::default()
    }

    /// Hold `o` until `o.id`'s audio flows — or start it now when there's nothing to
    /// wait for (no audio). Supersedes a pending onset on the same id + slot. Returns
    /// whether it was held. The caller has already un-paused the source and put the slot
    /// at `o.from`.
    pub fn schedule(
        &mut self,
        g: &Graph,
        anim: &mut Animator,
        o: PendingOnset,
        now: Duration,
    ) -> bool {
        self.pending.retain(|p| !(p.id == o.id && p.slot == o.slot));
        if has_audio(g, &o.id) {
            // Nothing else may move the slot meanwhile (the hold is the ramp's start).
            anim.cancel_target(&PropPath(format!("{}.gain.{}", o.id, o.slot)));
            held(&o.id, o.slot, o.corr.clone());
            self.pending.push(o);
            true
        } else {
            o.start(anim, now, "no_audio");
            false
        }
    }

    /// Start every onset this iteration's events confirm, and every one past
    /// [`ONSET_TIMEOUT`] (logged by `comp`). Returns the ids started.
    pub fn tick(
        &mut self,
        events: &[(String, SourceEvent)],
        anim: &mut Animator,
        now: Duration,
        comp: &'static str,
    ) -> Vec<String> {
        let mut started = Vec::new();
        let mut keep = Vec::new();
        for o in std::mem::take(&mut self.pending) {
            if flowed(events, &o.id) {
                started.push(o.id.clone());
                o.start(anim, now, "flowed");
            } else if o.timed_out(now) {
                log_timeout(comp, &o, now);
                started.push(o.id.clone());
                o.start(anim, now, "timeout");
            } else {
                keep.push(o);
            }
        }
        self.pending = keep;
        started
    }

    /// Start `id`'s pending onsets right now (it's about to be captured/ramped by someone
    /// else — a hold left pending would fight that).
    pub fn force(&mut self, id: &str, anim: &mut Animator, now: Duration) {
        let (go, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|o| o.id == id);
        self.pending = keep;
        for o in go {
            o.start(anim, now, "forced");
        }
    }

    /// Drop `id`'s pending onsets without starting them (it's going away, or another
    /// writer now owns the slot).
    pub fn cancel(&mut self, id: &str) {
        self.pending.retain(|o| o.id != id);
    }

    /// Drop every onset whose source `keep` rejects (its node is gone).
    pub fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.pending.retain(|o| keep(&o.id));
    }

    pub fn contains(&self, id: &str) -> bool {
        self.pending.iter().any(|o| o.id == id)
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// The level `id.gain.<slot>` is held at by a pending onset's ramp target (what a
    /// recipe recording a gain to restore later must see — R41: never the silent hold).
    pub fn target_of(&self, id: &str, slot: &str) -> Option<f64> {
        self.pending
            .iter()
            .find(|o| o.id == id && o.slot == slot)
            .map(|o| crate::units::lin_to_db(o.to))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::NodeKind;
    use serde_json::Map;

    fn video(g: &mut Graph) -> String {
        let mut p = Map::new();
        p.insert("path".into(), json!("/a.mkv"));
        let id = g.create(NodeKind::Source, None, p).unwrap();
        g.set_observed(&PropPath(format!("{id}.ready")), PropValue::Bool(true))
            .unwrap();
        id
    }

    fn onset(id: &str, requested: Duration) -> PendingOnset {
        PendingOnset {
            id: id.into(),
            slot: "anticlick",
            from: 0.0,
            to: 1.0,
            dur: Duration::from_millis(30),
            curve: Curve::Linear,
            requested,
            corr: None,
        }
    }

    #[test]
    fn holds_until_audio_flows_then_ramps_from_then() {
        let mut g = Graph::new();
        let id = video(&mut g);
        let mut anim = Animator::new();
        let mut o = Onsets::new();
        assert!(o.schedule(&g, &mut anim, onset(&id, Duration::ZERO), Duration::ZERO));
        let path = PropPath(format!("{id}.gain.anticlick"));
        assert!(
            anim.target_of(&path).is_none(),
            "no ramp before audio flows"
        );
        assert!(
            o.tick(&[], &mut anim, Duration::from_millis(40), "runtime")
                .is_empty()
        );
        assert!(anim.target_of(&path).is_none());
        let ev = vec![(id.clone(), SourceEvent::AudioFlowing)];
        assert_eq!(
            o.tick(&ev, &mut anim, Duration::from_millis(50), "runtime"),
            vec![id.clone()]
        );
        assert_eq!(
            anim.value_at(&path, Duration::from_millis(50)),
            Some(SILENT_DB)
        );
        assert_eq!(anim.value_at(&path, Duration::from_millis(80)), Some(0.0));
        assert!(o.is_empty());
    }

    #[test]
    fn times_out_and_skips_sources_without_audio() {
        let mut g = Graph::new();
        let id = video(&mut g);
        let mut anim = Animator::new();
        let mut o = Onsets::new();
        o.schedule(&g, &mut anim, onset(&id, Duration::ZERO), Duration::ZERO);
        assert_eq!(
            o.tick(&[], &mut anim, ONSET_TIMEOUT, "runtime"),
            vec![id.clone()]
        );
        // No audio track: ramped at once, never held.
        g.set_observed(&PropPath(format!("{id}.has_audio")), PropValue::Bool(false))
            .unwrap();
        assert!(!o.schedule(&g, &mut anim, onset(&id, Duration::ZERO), Duration::ZERO));
        assert!(o.is_empty());
    }

    #[test]
    fn kind_has_audio_counts_scenes() {
        assert!(kind_has_audio("video"));
        assert!(kind_has_audio("scene"));
        for k in ["image", "color", "snapshot", ""] {
            assert!(!kind_has_audio(k), "{k}");
        }
        let mut g = Graph::new();
        let mut p = Map::new();
        p.insert("kind".into(), json!("scene"));
        p.insert("path".into(), json!("/w/431960/123"));
        let id = g.create(NodeKind::Source, None, p).unwrap();
        assert!(has_audio(&g, &id), "unknown = true until the worker says");
        g.set_observed(&PropPath(format!("{id}.has_audio")), PropValue::Bool(false))
            .unwrap();
        assert!(!has_audio(&g, &id), "a scene without sound");
    }

    #[test]
    fn audible_is_the_one_predicate() {
        let mut g = Graph::new();
        let id = video(&mut g);
        assert!(audible(&g, &id, false));
        assert!(!audible(&g, &id, true), "effectively paused = silent");
        g.set(&PropPath(format!("{id}.no_audio")), PropValue::Bool(true))
            .unwrap();
        assert!(
            !audible(&g, &id, false),
            "no_audio = silent (is_silent used to miss it)"
        );
    }
}
