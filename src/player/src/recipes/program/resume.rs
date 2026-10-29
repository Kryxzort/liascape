//! Playlist start (O4, plan § Playlist start): "When the playlist starts again" = start over
//! (default) | resume where it left off. A keyed program (`key` = `name:<saved name>` or
//! `bar`) keeps a resume point per key in `<state>/resume.json` — put when the program is
//! stopped, replaced (its key changes), destroyed or the player quits, whatever its
//! `start_mode`, so switching to Resume later still finds one. At most [`RESUME_MAX_KEYS`],
//! the least recently put dropped. [`plan_start`] is the whole start table, pure.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::Rng;
use super::order::Order;

/// The file in the state dir.
pub const FILE: &str = "resume.json";
/// The most playlists a resume point is kept for.
pub const RESUME_MAX_KEYS: usize = 50;

/// Where a playlist left off.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ResumePoint {
    /// The play order (a shuffle cycle's) and the cursor in it.
    pub order: Vec<String>,
    pub idx: usize,
    pub history: Vec<String>,
    pub hist_idx: usize,
    /// The item that played, its position (s), its play time and the timer's remaining.
    pub path: String,
    pub time_pos: f64,
    pub played_ms: u64,
    pub remaining_ms: u64,
    pub last_effect: Option<String>,
    pub saved_unix_ms: u64,
}

/// `resume.json`: key → point, oldest first.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ResumeStore {
    #[serde(default)]
    points: Vec<(String, ResumePoint)>,
}

impl ResumeStore {
    pub fn get(&self, key: &str) -> Option<&ResumePoint> {
        self.points.iter().find(|(k, _)| k == key).map(|(_, p)| p)
    }

    /// Keep `p` for `key` (the most recent one; the least recently put beyond
    /// [`RESUME_MAX_KEYS`] dropped).
    pub fn put(&mut self, key: &str, p: ResumePoint) {
        self.points.retain(|(k, _)| k != key);
        self.points.push((key.to_string(), p));
        if self.points.len() > RESUME_MAX_KEYS {
            let extra = self.points.len() - RESUME_MAX_KEYS;
            self.points.drain(..extra);
        }
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub fn keys(&self) -> Vec<String> {
        self.points.iter().map(|(k, _)| k.clone()).collect()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = serde_json::to_vec_pretty(self).unwrap_or_default();
        b.push(b'\n');
        b
    }

    /// `<dir>/resume.json`, or an empty store (none, or unreadable — a resume point is a
    /// convenience, never a reason not to start).
    pub fn load(dir: &Path) -> ResumeStore {
        std::fs::read(dir.join(FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
}

/// `program.play {from}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartFrom {
    /// Start over: sequential → the first playable item; shuffle → a fresh shuffle.
    Start,
    /// The playlist's resume point (none → as `Start`).
    Resume,
    /// That item at 0 (an explicit play-from beats the setting).
    Index(usize),
}

/// What a start plays: the order with its cursor on the item, where in it, and the clocks.
#[derive(Debug, Clone)]
pub struct StartPlan {
    pub order: Order,
    /// Seconds into the item (0 unless resumed).
    pub position: f64,
    pub played_ms: u64,
    /// The timer's remaining (`None` = a full interval).
    pub remaining_ms: Option<u64>,
    /// It resumed where it left off (exact item, time and play time).
    pub resumed: bool,
}

/// A fresh start's order (`ApplyTimedPlaylist`): sequential → the items as given, the
/// cursor on the first playable one; shuffle → a new permutation whose first is playable
/// and ≠ `avoid_first` (the last one played: a restart never repeats what was just on).
/// `None` when nothing is playable.
pub fn new_start(
    items: &[String],
    skip: &dyn Fn(&str) -> bool,
    shuffle: bool,
    avoid_first: Option<&str>,
    rng: &mut Rng,
) -> Option<Order> {
    let playable = items.iter().filter(|p| !skip(p)).count();
    if playable == 0 {
        return None;
    }
    if !shuffle {
        let idx = items.iter().position(|p| !skip(p))?;
        return Some(Order::new(items.to_vec(), idx, false));
    }
    let mut perm = items.to_vec();
    for _ in 0..64 {
        rng.shuffle(&mut perm);
        let first = perm.iter().position(|p| !skip(p))?;
        if playable <= 1 || avoid_first.is_none_or(|a| perm[first] != a) {
            perm[..=first].rotate_right(1); // the first playable leads
            return Some(Order::from_parts(perm, 0, true, items.to_vec(), Vec::new(), usize::MAX));
        }
    }
    let first = perm.iter().position(|p| !skip(p))?;
    perm[..=first].rotate_right(1);
    Some(Order::from_parts(perm, 0, true, items.to_vec(), Vec::new(), usize::MAX))
}

/// The § Playlist start table. `items` = the program's items (bar order), `point` = the
/// key's resume point, `avoid_first` = the last item played (a fresh shuffle won't start
/// there). `None` when nothing is playable.
pub fn plan_start(
    items: &[String],
    skip: &dyn Fn(&str) -> bool,
    shuffle: bool,
    from: StartFrom,
    point: Option<&ResumePoint>,
    rng: &mut Rng,
) -> Option<StartPlan> {
    let fresh = |order: Order| StartPlan {
        order,
        position: 0.0,
        played_ms: 0,
        remaining_ms: None,
        resumed: false,
    };
    match from {
        StartFrom::Index(i) => {
            let i = i.min(items.len().checked_sub(1)?);
            Some(fresh(Order::new(items.to_vec(), i, shuffle)))
        }
        StartFrom::Start => {
            let avoid = point.map(|p| p.path.as_str());
            new_start(items, skip, shuffle, avoid, rng).map(fresh)
        }
        StartFrom::Resume => {
            let Some(pt) = point.filter(|p| !p.order.is_empty()) else {
                return plan_start(items, skip, shuffle, StartFrom::Start, None, rng);
            };
            let same = super::store::same_items(&pt.order, items);
            if same && !skip(&pt.path) && pt.order.get(pt.idx).is_some() {
                // exactly where it left off
                let o = Order::from_parts(
                    pt.order.clone(),
                    pt.idx,
                    shuffle,
                    items.to_vec(),
                    pt.history.clone(),
                    pt.hist_idx,
                );
                if o.current() == Some(pt.path.as_str()) {
                    return Some(StartPlan {
                        order: o,
                        position: pt.time_pos.max(0.0),
                        played_ms: pt.played_ms,
                        remaining_ms: Some(pt.remaining_ms),
                        resumed: true,
                    });
                }
            }
            // the list was edited meanwhile: re-anchor (the reorder rule) — the same item
            // where it was if it is still there, else the item after its old place, at 0
            let at = pt.order.iter().position(|p| *p == pt.path).unwrap_or(0);
            let mut o = Order::from_parts(
                pt.order.clone(),
                at,
                shuffle,
                pt.order.clone(),
                vec![pt.path.clone()],
                0,
            );
            o.reorder(items, shuffle, rng);
            if items.contains(&pt.path) && !skip(&pt.path) {
                return Some(StartPlan {
                    order: o,
                    position: pt.time_pos.max(0.0),
                    played_ms: pt.played_ms,
                    remaining_ms: Some(pt.remaining_ms),
                    resumed: true,
                });
            }
            let step = o.plan_next(skip, rng)?;
            o.commit(step);
            Some(fresh(o))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    fn none(_: &str) -> bool {
        false
    }

    fn point(order: &[&str], path: &str) -> ResumePoint {
        let idx = order.iter().position(|p| *p == path).unwrap_or(0);
        ResumePoint {
            order: v(order),
            idx,
            history: v(&[path]),
            hist_idx: 0,
            path: path.into(),
            time_pos: 12.5,
            played_ms: 4000,
            remaining_ms: 6000,
            last_effect: None,
            saved_unix_ms: 1,
        }
    }

    #[test]
    fn plan_start_sequential_is_item_one() {
        let items = v(&["a", "b", "c"]);
        let pt = point(&["a", "b", "c"], "c");
        let p = plan_start(&items, &none, false, StartFrom::Start, Some(&pt), &mut Rng::new(1))
            .unwrap();
        assert_eq!(p.order.current(), Some("a"));
        assert_eq!((p.position, p.played_ms, p.resumed), (0.0, 0, false));
        assert_eq!(p.remaining_ms, None);
    }

    #[test]
    fn plan_start_shuffle_is_a_new_permutation() {
        let items = v(&["a", "b", "c", "d", "e", "f"]);
        let stored = v(&["c", "a", "f", "b", "e", "d"]);
        let mut rng = Rng::new(9);
        for _ in 0..200 {
            let pt = point(&["c", "a", "f", "b", "e", "d"], "e");
            let p = plan_start(&items, &none, true, StartFrom::Start, Some(&pt), &mut rng).unwrap();
            let mut sorted = p.order.items().to_vec();
            sorted.sort();
            assert_eq!(sorted, items, "a permutation");
            assert_ne!(p.order.current(), Some("e"), "its first ≠ the last played");
            assert_eq!(p.order.current(), Some(p.order.items()[0].as_str()));
        }
        let pt = point(&["c", "a", "f", "b", "e", "d"], "e");
        let p = plan_start(&items, &none, true, StartFrom::Start, Some(&pt), &mut Rng::new(3))
            .unwrap();
        assert_ne!(p.order.items(), stored.as_slice(), "a new shuffle");
    }

    #[test]
    fn plan_start_skips_a_skipped_first() {
        let items = v(&["a", "b", "c"]);
        let skip = |p: &str| p == "a";
        let p = plan_start(&items, &skip, false, StartFrom::Start, None, &mut Rng::new(1)).unwrap();
        assert_eq!(p.order.current(), Some("b"));
        let mut rng = Rng::new(5);
        for _ in 0..50 {
            let p = plan_start(&items, &skip, true, StartFrom::Start, None, &mut rng).unwrap();
            assert_ne!(p.order.current(), Some("a"));
        }
        let all = |_: &str| true;
        assert!(plan_start(&items, &all, false, StartFrom::Start, None, &mut rng).is_none());
    }

    #[test]
    fn plan_start_resume_is_exact_and_falls_back() {
        let items = v(&["a", "b", "c", "d"]);
        let mut rng = Rng::new(1);
        let mut pt = point(&["a", "b", "c", "d"], "c");
        pt.history = v(&["a", "b", "c"]);
        pt.hist_idx = 2;
        let p = plan_start(&items, &none, false, StartFrom::Resume, Some(&pt), &mut rng).unwrap();
        assert!(p.resumed);
        assert_eq!(p.order.current(), Some("c"));
        assert_eq!(p.order.history().0, v(&["a", "b", "c"]).as_slice());
        assert_eq!((p.position, p.played_ms, p.remaining_ms), (12.5, 4000, Some(6000)));
        // nothing to resume → as Start
        let p = plan_start(&items, &none, false, StartFrom::Resume, None, &mut rng).unwrap();
        assert!(!p.resumed);
        assert_eq!(p.order.current(), Some("a"));
        // an explicit item beats it
        let p = plan_start(&items, &none, false, StartFrom::Index(3), Some(&pt), &mut rng).unwrap();
        assert_eq!((p.order.current(), p.position), (Some("d"), 0.0));
    }

    #[test]
    fn plan_start_resume_after_edit_reanchors() {
        let mut rng = Rng::new(1);
        let pt = point(&["a", "b", "c", "d"], "c");
        // c removed: the item after its old place, at 0
        let items = v(&["a", "b", "d"]);
        let p = plan_start(&items, &none, false, StartFrom::Resume, Some(&pt), &mut rng).unwrap();
        assert_eq!(p.order.current(), Some("d"));
        assert!(!p.resumed);
        assert_eq!(p.position, 0.0);
        // c kept, an item added: c at its time, the order re-anchored on it
        let items = v(&["a", "b", "c", "d", "e"]);
        let p = plan_start(&items, &none, false, StartFrom::Resume, Some(&pt), &mut rng).unwrap();
        assert_eq!(p.order.current(), Some("c"));
        assert!(p.resumed);
        assert_eq!(p.order.items().len(), 5);
    }

    #[test]
    fn resume_store_is_bounded() {
        let mut st = ResumeStore::default();
        for k in 0..60 {
            st.put(&format!("k{k}"), point(&["a"], "a"));
        }
        assert_eq!(st.len(), RESUME_MAX_KEYS);
        assert!(st.get("k9").is_none(), "the least recently put gone");
        assert!(st.get("k10").is_some());
        st.put("k10", point(&["a"], "a"));
        st.put("k60", point(&["a"], "a"));
        assert!(st.get("k10").is_some(), "put again = used again");
        assert!(st.get("k11").is_none());
        let back: ResumeStore = serde_json::from_slice(&st.to_bytes()).unwrap();
        assert_eq!(back, st);
    }
}
