//! A program's play order (pure, seeded): the cycle through its items, shuffle cycles,
//! the history next/previous walk, random and the live reorder — `PlayerHelper`'s
//! `_timedPaths` / `_timedIndex` / `_history` / `_historyIndex`, ported.
//!
//! Unlike the C# (which advanced its cursor when it *requested* an end-of-video switch, the
//! "pre-fetch", and had to step back on a cancel), a step is **planned** and only
//! **committed** when its B starts ([`Order::commit`]): the cursor always names what plays.
//! A planned [`Step`] carries the cursor state after it; committing one that a reorder
//! made stale re-seats the cursor at its path instead.

use super::Rng;

/// The most entries the history keeps (the oldest dropped first).
pub const HISTORY_MAX: usize = 100;

/// Why a step goes where it goes (`program.current.reason` comes from the caller; this is
/// the order's own view).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepWhy {
    /// The order's next item (a new history entry).
    Forward,
    /// The next entry of a history walked back.
    HistoryForward,
    /// The previous history entry.
    Back,
    /// A random pick.
    Random,
    /// An explicit play of an item.
    Play,
}

/// The cursor state a step leaves behind.
#[derive(Debug, Clone, PartialEq)]
struct OrderState {
    /// `Some` only when the step reshuffled the items (a shuffle cycle's end).
    items: Option<Vec<String>>,
    idx: usize,
    history: Vec<String>,
    hist_idx: usize,
}

/// A planned move: where it goes, why, and the order state after it (applied by
/// [`Order::commit`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub path: String,
    pub why: StepWhy,
    state: OrderState,
    /// The order revision it was planned on (a reorder in between makes it stale).
    rev: u64,
}

impl Step {
    /// Committing it changes the play order itself (a shuffle cycle's end reshuffles).
    pub fn reshuffles(&self) -> bool {
        self.state.items.is_some()
    }
}

#[derive(Debug, Clone)]
pub struct Order {
    /// The play order (`_timedPaths`): the bar order, or a cycle's shuffle.
    items: Vec<String>,
    /// The cursor in `items` (`_timedIndex`).
    idx: usize,
    shuffle: bool,
    history: Vec<String>,
    hist_idx: usize,
    /// The item list as last given (the playlist bar's order): a reorder's "previous".
    bar: Vec<String>,
    rev: u64,
}

impl Order {
    /// `PlayerHelper.ApplyTimedPlaylist`'s order: `paths` as given (the caller is
    /// responsible for the initial order; `shuffle` only reshuffles at a cycle's end), the
    /// cursor at `first` (clamped), the history `[paths[first]]`.
    pub fn new(paths: Vec<String>, first: usize, shuffle: bool) -> Order {
        let idx = first.min(paths.len().saturating_sub(1));
        let history = paths.get(idx).cloned().into_iter().collect();
        Order {
            bar: paths.clone(),
            items: paths,
            idx,
            shuffle,
            history,
            hist_idx: 0,
            rev: 0,
        }
    }

    /// A saved order brought back (`store`): `items` in play order with the cursor at `idx`,
    /// `bar` the item list as given, the history and its cursor. Out-of-range cursors are
    /// clamped; an empty or inconsistent history becomes `[items[idx]]`.
    pub fn from_parts(
        items: Vec<String>,
        idx: usize,
        shuffle: bool,
        bar: Vec<String>,
        history: Vec<String>,
        hist_idx: usize,
    ) -> Order {
        let idx = idx.min(items.len().saturating_sub(1));
        let (history, hist_idx) = if hist_idx < history.len() && history.len() <= HISTORY_MAX {
            (history, hist_idx)
        } else {
            (items.get(idx).cloned().into_iter().collect(), 0)
        };
        Order {
            items,
            idx,
            shuffle,
            history,
            hist_idx,
            bar,
            rev: 0,
        }
    }

    /// The item list as last given (`items` in the playlist bar's order).
    pub fn bar(&self) -> &[String] {
        &self.bar
    }

    /// What plays (the history's cursor), `None` for an empty order.
    pub fn current(&self) -> Option<&str> {
        self.history.get(self.hist_idx).map(String::as_str)
    }

    pub fn items(&self) -> &[String] {
        &self.items
    }

    /// The cursor in [`Order::items`].
    pub fn index(&self) -> usize {
        self.idx
    }

    pub fn shuffle(&self) -> bool {
        self.shuffle
    }

    /// `(history, cursor)`.
    pub fn history(&self) -> (&[String], usize) {
        (&self.history, self.hist_idx)
    }

    fn state(&self) -> OrderState {
        OrderState {
            items: None,
            idx: self.idx,
            history: self.history.clone(),
            hist_idx: self.hist_idx,
        }
    }

    fn step(&self, path: String, why: StepWhy, state: OrderState) -> Step {
        Step {
            path,
            why,
            state,
            rev: self.rev,
        }
    }

    /// `PlayerHelper.AdvanceToNext`: forward through the history first (a next after a
    /// previous, past entries skipped since they played), then the order's next item —
    /// a cycle's end reshuffles (when shuffled; its first ≠ the old cycle's last) and wraps.
    /// Skipped items are passed over; `None` = nothing playable.
    pub fn plan_next(&self, skip: &dyn Fn(&str) -> bool, rng: &mut Rng) -> Option<Step> {
        let mut st = self.state();
        while st.hist_idx + 1 < st.history.len() {
            st.hist_idx += 1;
            if !skip(&st.history[st.hist_idx]) {
                let path = st.history[st.hist_idx].clone();
                return Some(self.step(path, StepWhy::HistoryForward, st));
            }
        }
        let n = self.items.len();
        let mut items: Option<Vec<String>> = None;
        for _ in 0..n {
            st.idx += 1;
            if st.idx >= n {
                if self.shuffle {
                    let cur = items.as_ref().unwrap_or(&self.items);
                    let last = cur[n - 1].clone();
                    let mut re = cur.clone();
                    loop {
                        rng.shuffle(&mut re);
                        if n <= 1 || re[0] != last {
                            break;
                        }
                    }
                    items = Some(re);
                }
                st.idx = 0;
            }
            let path = items.as_ref().unwrap_or(&self.items)[st.idx].clone();
            if skip(&path) {
                continue;
            }
            push_history(&mut st.history, &mut st.hist_idx, path.clone());
            st.items = items;
            return Some(self.step(path, StepWhy::Forward, st));
        }
        None
    }

    /// `PlayerHelper.StepBackAndLaunch`: the previous history entry; `None` at the
    /// session's first item.
    pub fn plan_back(&self) -> Option<Step> {
        if self.hist_idx == 0 || self.hist_idx > self.history.len() {
            return None;
        }
        let mut st = self.state();
        st.hist_idx -= 1;
        let path = st.history[st.hist_idx].clone();
        Some(self.step(path, StepWhy::Back, st))
    }

    /// `PlayerHelper.RandomAndLaunch`: uniform over the playable items except the current
    /// one (`PickRandomExcluding`); the pick replaces the forward history and re-seats the
    /// cursor at its place. `None` = nothing playable.
    pub fn plan_random(&self, skip: &dyn Fn(&str) -> bool, rng: &mut Rng) -> Option<Step> {
        let pool: Vec<&String> = self.items.iter().filter(|p| !skip(p)).collect();
        if pool.is_empty() {
            return None;
        }
        let current = self.current();
        let ex = current.and_then(|c| pool.iter().position(|p| p.as_str() == c));
        let pick = match ex {
            Some(ex) if pool.len() > 1 => {
                let mut i = rng.below(pool.len() - 1);
                if i >= ex {
                    i += 1;
                }
                pool[i].clone()
            }
            _ => pool[rng.below(pool.len())].clone(),
        };
        let mut st = self.state();
        if !st.history.is_empty() {
            st.history.truncate(st.hist_idx + 1);
        }
        push_history(&mut st.history, &mut st.hist_idx, pick.clone());
        if let Some(at) = self.items.iter().position(|p| *p == pick) {
            st.idx = at;
        }
        Some(self.step(pick, StepWhy::Random, st))
    }

    /// An explicit play of `items[index]` (`PlayerHelper.ApplyTimedPlaylist`: the session
    /// starts there, its history `[item]`). `None` for an empty order; the index is clamped.
    pub fn plan_play(&self, index: usize) -> Option<Step> {
        let idx = index.min(self.items.len().checked_sub(1)?);
        let path = self.items[idx].clone();
        let st = OrderState {
            items: None,
            idx,
            history: vec![path.clone()],
            hist_idx: 0,
        };
        Some(self.step(path, StepWhy::Play, st))
    }

    /// A step to what the cursor already names (a start planned elsewhere — `resume::plan_start`
    /// — and installed as the order): committing it changes nothing but marks the switch.
    pub fn plan_stay(&self) -> Option<Step> {
        let path = self.current()?.to_string();
        Some(self.step(path, StepWhy::Play, self.state()))
    }

    /// The step's B started: it is what plays now. A step planned before a reorder
    /// (stale) re-seats the cursor at its path and appends it to the history instead.
    pub fn commit(&mut self, step: Step) {
        if step.rev == self.rev {
            if let Some(items) = step.state.items {
                self.items = items;
            }
            self.idx = step.state.idx;
            self.history = step.state.history;
            self.hist_idx = step.state.hist_idx;
        } else {
            if let Some(at) = self.items.iter().position(|p| *p == step.path) {
                self.idx = at;
            }
            if self.current() != Some(step.path.as_str()) {
                if !self.history.is_empty() {
                    self.history.truncate(self.hist_idx + 1);
                }
                push_history(&mut self.history, &mut self.hist_idx, step.path);
            }
        }
        self.rev += 1;
    }

    /// Plan on the order as it will be once `prev` (a step requested and not started yet)
    /// commits — a user switch while another is still on its way goes on from *that* one
    /// (`PlayerHelper` advanced its cursor at each request: ten `next`s land ten items on).
    /// The step returned commits on `self` as if planned here (it carries the whole cursor
    /// state, `prev`'s reshuffle included).
    pub fn plan_after(
        &self,
        prev: &Step,
        plan: impl FnOnce(&Order) -> Option<Step>,
    ) -> Option<Step> {
        let mut then = self.clone();
        then.commit(prev.clone());
        then.rev = self.rev;
        let mut step = plan(&then)?;
        if step.state.items.is_none() && then.items != self.items {
            step.state.items = Some(then.items.clone());
        }
        Some(step)
    }

    /// `PlayerHelper.ReorderPlaylist`, timed branch: a new item list (`new`, the bar's
    /// order) keeps the current item — it goes first, the rest follow from its place
    /// (wrapping; shuffled when `shuffle`), the cursor on it. A current item that was
    /// removed finishes without a replay: the rest starts with the first item after its
    /// old place that is still there (an edit of the same list only), and the cursor sits
    /// on the last slot so the next step wraps to it. The history resets to `[current]`;
    /// the countdown and play time are the caller's and stay.
    pub fn reorder(&mut self, new: &[String], shuffle: bool, rng: &mut Rng) {
        if new.is_empty() {
            return;
        }
        let current = self.current().map(str::to_string);
        let cur_idx = current
            .as_ref()
            .and_then(|c| new.iter().position(|p| p == c));
        let mut rest: Vec<String> = Vec::with_capacity(new.len());
        if let Some(ci) = cur_idx {
            rest.extend_from_slice(&new[ci + 1..]);
            rest.extend_from_slice(&new[..ci]);
        } else {
            rest.extend_from_slice(new);
            let was = current
                .as_ref()
                .filter(|_| new.iter().all(|p| self.bar.contains(p)))
                .and_then(|c| self.bar.iter().position(|p| p == c));
            if let (Some(was), Some(cur)) = (was, current.as_ref()) {
                let n = self.bar.len();
                let after = (1..=n)
                    .map(|k| &self.bar[(was + k) % n])
                    .find(|p| *p != cur && rest.contains(p))
                    .cloned();
                if let Some(at) = after.and_then(|a| rest.iter().position(|p| *p == a))
                    && at > 0
                {
                    rest.rotate_left(at);
                }
            }
        }
        if shuffle {
            rng.shuffle(&mut rest);
        }
        let (items, idx) = match (cur_idx, current.as_ref()) {
            (Some(_), Some(cur)) => {
                let mut items = Vec::with_capacity(rest.len() + 1);
                items.push(cur.clone());
                items.extend(rest);
                (items, 0)
            }
            _ => {
                let last = rest.len() - 1;
                (rest, last)
            }
        };
        self.history = vec![current.unwrap_or_else(|| items[0].clone())];
        self.hist_idx = 0;
        self.items = items;
        self.idx = idx;
        self.shuffle = shuffle;
        self.bar = new.to_vec();
        self.rev += 1;
    }
}

fn push_history(history: &mut Vec<String>, hist_idx: &mut usize, path: String) {
    history.push(path);
    if history.len() > HISTORY_MAX {
        history.remove(0);
    }
    *hist_idx = history.len() - 1;
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

    /// plan_next + commit; the path.
    fn next(o: &mut Order, rng: &mut Rng) -> String {
        let s = o.plan_next(&none, rng).expect("a next step");
        let p = s.path.clone();
        o.commit(s);
        p
    }

    #[test]
    fn plan_after_chains_requests_that_never_started() {
        let mut rng = Rng::new(3);
        let mut o = Order::new(v(&["a", "b", "c", "d"]), 0, false);
        let s1 = o.plan_next(&none, &mut rng).unwrap();
        let s2 = o
            .plan_after(&s1, |t| t.plan_next(&none, &mut rng))
            .unwrap();
        let s3 = o
            .plan_after(&s2, |t| t.plan_next(&none, &mut rng))
            .unwrap();
        assert_eq!((s1.path.as_str(), s3.path.as_str()), ("b", "d"));
        // only the last one starts: the cursor and the history are as if each had played
        o.commit(s3);
        assert_eq!(o.current(), Some("d"));
        assert_eq!(o.history().0, v(&["a", "b", "c", "d"]).as_slice());
        assert_eq!(next(&mut o, &mut rng), "a");
        // back from a step on its way
        let s = o.plan_next(&none, &mut rng).unwrap();
        let back = o.plan_after(&s, |t| t.plan_back()).unwrap();
        assert_eq!(back.path, "a");
        // a reshuffle in the step on its way carries over
        let mut sh = Order::new(v(&["a", "b", "c"]), 2, true);
        let s1 = sh.plan_next(&none, &mut rng).unwrap();
        let s2 = sh
            .plan_after(&s1, |t| t.plan_next(&none, &mut rng))
            .unwrap();
        sh.commit(s2.clone());
        assert_eq!(sh.current(), Some(s2.path.as_str()));
        assert_eq!(sh.items()[sh.index()], s2.path);
    }

    #[test]
    fn sequential_wraps() {
        let mut rng = Rng::new(1);
        let mut o = Order::new(v(&["a", "b", "c"]), 0, false);
        assert_eq!(o.current(), Some("a"));
        let got: Vec<String> = (0..4).map(|_| next(&mut o, &mut rng)).collect();
        assert_eq!(got, v(&["b", "c", "a", "b"]));
    }

    #[test]
    fn shuffle_cycle_never_repeats_across_the_boundary() {
        let mut rng = Rng::new(42);
        let items = v(&["a", "b", "c", "d", "e"]);
        let mut o = Order::new(items.clone(), 0, true);
        let mut played = vec![o.current().unwrap().to_string()];
        for _ in 0..(200 * 5 - 1) {
            played.push(next(&mut o, &mut rng));
        }
        let mut prev_last: Option<String> = None;
        for cycle in played.chunks(5) {
            let mut sorted = cycle.to_vec();
            sorted.sort();
            assert_eq!(sorted, items, "each cycle is a permutation: {cycle:?}");
            if let Some(pl) = &prev_last {
                assert_ne!(&cycle[0], pl, "a cycle's first ≠ the previous cycle's last");
            }
            prev_last = Some(cycle[4].clone());
        }
    }

    #[test]
    fn back_then_forward_walks_history() {
        let mut rng = Rng::new(7);
        let mut o = Order::new(v(&["a", "b", "c", "d"]), 0, false);
        next(&mut o, &mut rng);
        next(&mut o, &mut rng);
        assert_eq!(o.current(), Some("c"));
        let s = o.plan_back().unwrap();
        assert_eq!((s.path.as_str(), s.why), ("b", StepWhy::Back));
        o.commit(s);
        let s = o.plan_back().unwrap();
        assert_eq!(s.path, "a");
        o.commit(s);
        assert!(
            o.plan_back().is_none(),
            "previous at the session's first item"
        );
        let s = o.plan_next(&none, &mut rng).unwrap();
        assert_eq!((s.path.as_str(), s.why), ("b", StepWhy::HistoryForward));
        o.commit(s);
        let s = o.plan_next(&none, &mut rng).unwrap();
        assert_eq!((s.path.as_str(), s.why), ("c", StepWhy::HistoryForward));
        o.commit(s);
        let s = o.plan_next(&none, &mut rng).unwrap();
        assert_eq!((s.path.as_str(), s.why), ("d", StepWhy::Forward));
        o.commit(s);
        assert_eq!(o.history().0, &v(&["a", "b", "c", "d"])[..]);
    }

    #[test]
    fn random_reseats_and_drops_forward_history() {
        for seed in 0..50 {
            let mut rng = Rng::new(seed);
            let items = v(&["a", "b", "c", "d", "e"]);
            let mut o = Order::new(items.clone(), 0, false);
            next(&mut o, &mut rng);
            next(&mut o, &mut rng);
            let s = o.plan_back().unwrap();
            o.commit(s);
            assert_eq!(o.current(), Some("b"));
            let s = o.plan_random(&none, &mut rng).unwrap();
            assert_eq!(s.why, StepWhy::Random);
            let pick = s.path.clone();
            assert_ne!(pick, "b", "never the current item");
            o.commit(s);
            assert_eq!(
                o.history().0,
                &[v(&["a", "b"]), vec![pick.clone()]].concat()[..]
            );
            assert_eq!(o.history().1, 2);
            let at = items.iter().position(|p| *p == pick).unwrap();
            let s = o.plan_next(&none, &mut rng).unwrap();
            assert_eq!(s.why, StepWhy::Forward, "the forward history is gone");
            assert_eq!(
                s.path,
                items[(at + 1) % items.len()],
                "next follows the pick's place"
            );
        }
    }

    #[test]
    fn random_is_uniform_excluding_current() {
        let mut rng = Rng::new(3);
        let o = Order::new(v(&["a", "b", "c", "d"]), 1, false);
        let mut counts = std::collections::BTreeMap::new();
        for _ in 0..3000 {
            *counts
                .entry(o.plan_random(&none, &mut rng).unwrap().path)
                .or_insert(0) += 1;
        }
        assert!(!counts.contains_key("b"));
        for k in ["a", "c", "d"] {
            assert!((800..1200).contains(&counts[k]), "{counts:?}");
        }
        // a one-item order picks its one item
        let o = Order::new(v(&["a"]), 0, false);
        assert_eq!(o.plan_random(&none, &mut rng).unwrap().path, "a");
    }

    #[test]
    fn skip_is_passed_over() {
        let mut rng = Rng::new(1);
        let skip = |p: &str| p == "b";
        let mut o = Order::new(v(&["a", "b", "c"]), 0, false);
        for want in ["c", "a", "c"] {
            let s = o.plan_next(&skip, &mut rng).unwrap();
            assert_eq!(s.path, want);
            o.commit(s);
        }
        // history forward past an item skipped since it played
        let mut o = Order::new(v(&["a", "b", "c", "d"]), 0, false);
        for _ in 0..3 {
            next(&mut o, &mut rng);
        }
        for _ in 0..3 {
            let s = o.plan_back().unwrap();
            o.commit(s);
        }
        assert_eq!(o.current(), Some("a"));
        let s = o.plan_next(&skip, &mut rng).unwrap();
        assert_eq!((s.path.as_str(), s.why), ("c", StepWhy::HistoryForward));
        // random never picks a skipped item
        for _ in 0..200 {
            assert_ne!(o.plan_random(&skip, &mut rng).unwrap().path, "b");
        }
    }

    #[test]
    fn all_skipped_is_none() {
        let mut rng = Rng::new(1);
        let all = |_: &str| true;
        for shuffle in [false, true] {
            let o = Order::new(v(&["a", "b", "c"]), 0, shuffle);
            assert!(o.plan_next(&all, &mut rng).is_none());
            assert!(o.plan_random(&all, &mut rng).is_none());
        }
        let o = Order::new(vec![], 0, false);
        assert!(o.current().is_none());
        assert!(o.plan_next(&none, &mut rng).is_none());
        assert!(o.plan_back().is_none());
        assert!(o.plan_play(0).is_none());
    }

    #[test]
    fn reorder_keeps_current_and_resets_history() {
        let mut rng = Rng::new(1);
        let mut o = Order::new(v(&["a", "b", "c"]), 0, false);
        next(&mut o, &mut rng);
        assert_eq!(o.current(), Some("b"));
        o.reorder(&v(&["c", "b", "a"]), false, &mut rng);
        assert_eq!(o.items(), &v(&["b", "a", "c"])[..]);
        assert_eq!(o.index(), 0);
        assert_eq!(o.history(), (&v(&["b"])[..], 0));
        assert_eq!(next(&mut o, &mut rng), "a");
    }

    #[test]
    fn reorder_removed_current_plays_successor_next() {
        let mut rng = Rng::new(1);
        let mut o = Order::new(v(&["a", "b", "c"]), 0, false);
        next(&mut o, &mut rng);
        o.reorder(&v(&["a", "c"]), false, &mut rng);
        assert_eq!(o.current(), Some("b"), "it finishes");
        assert_eq!(next(&mut o, &mut rng), "c");
        assert_eq!(next(&mut o, &mut rng), "a");
        // a different list loaded over it starts at its own top
        let mut o = Order::new(v(&["a", "b", "c"]), 0, false);
        next(&mut o, &mut rng);
        o.reorder(&v(&["x", "y", "c"]), false, &mut rng);
        assert_eq!(next(&mut o, &mut rng), "x");
    }

    #[test]
    fn stale_step_reseats_at_its_path() {
        let mut rng = Rng::new(1);
        let mut o = Order::new(v(&["a", "b", "c", "d"]), 0, false);
        let s = o.plan_next(&none, &mut rng).unwrap();
        assert_eq!(s.path, "b");
        o.reorder(&v(&["a", "d", "c", "b"]), false, &mut rng);
        o.commit(s);
        assert_eq!(o.current(), Some("b"));
        assert_eq!(o.history().0, &v(&["a", "b"])[..]);
        assert_eq!(next(&mut o, &mut rng), "a", "the cursor sits on b's place");
    }

    #[test]
    fn shuffle_on_mid_session_plays_rest_first() {
        for seed in 0..20 {
            let mut rng = Rng::new(seed);
            let items = v(&["a", "b", "c", "d", "e", "f"]);
            let mut o = Order::new(items.clone(), 0, false);
            next(&mut o, &mut rng);
            o.reorder(&items, true, &mut rng);
            assert!(o.shuffle());
            let mut rest: Vec<String> = (0..5).map(|_| next(&mut o, &mut rng)).collect();
            assert!(
                !rest.contains(&"b".to_string()),
                "b doesn't repeat before the rest"
            );
            rest.sort();
            assert_eq!(rest, v(&["a", "c", "d", "e", "f"]));
        }
    }

    #[test]
    fn history_bounded_100() {
        let mut rng = Rng::new(1);
        let items: Vec<String> = (0..7).map(|i| format!("p{i}")).collect();
        let mut o = Order::new(items, 0, true);
        for _ in 0..250 {
            next(&mut o, &mut rng);
        }
        let (h, i) = o.history();
        assert_eq!(h.len(), HISTORY_MAX);
        assert_eq!(i, HISTORY_MAX - 1);
        let mut o2 = o.clone();
        let s = o2.plan_random(&none, &mut rng).unwrap();
        o2.commit(s);
        assert_eq!(o2.history().0.len(), HISTORY_MAX);
    }

    #[test]
    fn play_resets_history() {
        let mut rng = Rng::new(1);
        let mut o = Order::new(v(&["a", "b", "c"]), 0, false);
        next(&mut o, &mut rng);
        let s = o.plan_play(2).unwrap();
        assert_eq!((s.path.as_str(), s.why), ("c", StepWhy::Play));
        o.commit(s);
        assert_eq!(o.history(), (&v(&["c"])[..], 0));
        assert_eq!(next(&mut o, &mut rng), "a");
        assert_eq!(o.plan_play(99).unwrap().path, "c", "clamped");
    }
}
