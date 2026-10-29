//! Scene loudness, learned on first play (Phase 2, owner decision: "measure a scene's
//! integrated loudness over its first ~60 s of play (from the worker's stream on the bus),
//! store it in the index like a video's `loudness*`, apply normalization from then on").
//! `.claude/rules/player-core.md` § Scene worker → "Scene loudness".
//!
//! ITU-R BS.1770-4 / EBU R128, split across the two processes:
//!
//! - **the worker** ([`SegmentMeter`]) K-weights the scene's sound **before its gain** (a user
//!   volume, mute or the normalization itself never biases it) and reports one [`Segment`] per
//!   100 ms of audio it really played: the channel-summed K-weighted mean square + the sample
//!   peak. Only buffers that pulled the scene's sound into a real stream count — paused,
//!   `no_audio`, a fade-out and the PipeWire-down fallback timer add nothing;
//! - **the compositor** ([`Learner`], one per scene source, surviving worker restarts) builds
//!   the 400 ms gating blocks (75 % overlap = 4 consecutive segments), keeps those above the
//!   absolute gate (−70 LUFS) and, once they cover the window ([`WINDOW_ENV`], 60 s of
//!   **audible** play — a silent stretch doesn't count), integrates them with the relative gate
//!   (−10 LU) → `scene.loudness {complete: true}`. A source that ends (switched away,
//!   destroyed, its path changed) with at least a third of the window reports what it has
//!   (`complete: false`).
//!
//! **Refined across plays** (owner 2026-10-28: "60s to normalize for rest of scene, keep
//! measuring to get a more accurate measure when the scene is played in future (probably add
//! a max cap …)"): the blocks are kept as a histogram (0.1 LU bins, −70…+5 LUFS) — exactly
//! what BS.1770's relative gate needs, and two of them add — reported with every
//! `scene.loudness` as `state` and stored by the backend; the next play's source is seeded
//! with it (`loudness_seed`) and continues the same integration. Reports: at the window
//! (seed included), after each further window of audible play, at the end for what's left,
//! and once at the cap ([`CAP_ENV`], 30 min of audible play over every session) — after which
//! nothing more is measured (the worker stops metering).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

/// The worker's stream rate (the K-weighting coefficients below are for it).
pub const RATE: u32 = 48_000;
/// One segment = 100 ms (the gating blocks' hop).
pub const SEGMENT_FRAMES: usize = RATE as usize / 10;
pub const SEGMENT_S: f64 = 0.1;
/// Segments per 400 ms gating block.
const BLOCK_SEGMENTS: usize = 4;
/// BS.1770-4's absolute gate.
pub const ABS_GATE_LUFS: f64 = -70.0;
/// BS.1770-4's relative gate (below the absolute-gated mean).
pub const REL_GATE_LU: f64 = -10.0;
/// The learning window in seconds of audible play (tests shorten it); default
/// [`DEFAULT_WINDOW_S`].
pub const WINDOW_ENV: &str = "LIASCAPE_PLAYER_LOUDNESS_WINDOW_S";
pub const DEFAULT_WINDOW_S: f64 = 60.0;

/// The window for the value of [`WINDOW_ENV`]: a positive number of seconds, else 60.
pub fn window_s(v: Option<&str>) -> f64 {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(DEFAULT_WINDOW_S)
}

/// The cap: total audible seconds measured over every play of a scene, after which nothing
/// more is measured (owner: "probably add a max cap for people who will never change
/// wallpaper") — 30 min; tests shorten it. Never below the window.
pub const CAP_ENV: &str = "LIASCAPE_PLAYER_LOUDNESS_CAP_S";
pub const DEFAULT_CAP_S: f64 = 1800.0;

/// The cap for the value of [`CAP_ENV`]: a positive number of seconds, else 1800.
pub fn cap_s(v: Option<&str>) -> f64 {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(DEFAULT_CAP_S)
}

/// Loudness (LUFS) of a channel-summed K-weighted mean square.
pub fn lufs_of(power: f64) -> f64 {
    if power <= 0.0 {
        f64::NEG_INFINITY
    } else {
        -0.691 + 10.0 * power.log10()
    }
}

/// One 100 ms of played audio: Σ over channels of the K-weighted mean square, and the
/// largest |sample| (pre-gain, linear).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    pub power: f64,
    pub peak: f32,
}

/// One biquad (transposed direct form II, f64 state).
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Biquad {
    const fn new(b: [f64; 3], a: [f64; 2]) -> Biquad {
        Biquad { b, a, z: [0.0; 2] }
    }

    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// BS.1770-4's K-weighting at 48 kHz: the head's high shelf, then the RLB high-pass.
fn k_weighting() -> [Biquad; 2] {
    [
        Biquad::new(
            [1.535_124_859_586_97, -2.691_696_189_406_38, 1.198_392_810_852_85],
            [-1.690_659_293_182_41, 0.732_480_774_215_85],
        ),
        Biquad::new([1.0, -2.0, 1.0], [-1.990_047_454_833_98, 0.990_072_250_366_21]),
    ]
}

/// The worker's half: interleaved samples in, a [`Segment`] per 100 ms out. Pure.
#[derive(Debug, Clone)]
pub struct SegmentMeter {
    channels: usize,
    filters: Vec<[Biquad; 2]>,
    sum: Vec<f64>,
    n: usize,
    peak: f32,
}

impl SegmentMeter {
    pub fn new(channels: usize) -> SegmentMeter {
        let channels = channels.max(1);
        SegmentMeter {
            channels,
            filters: vec![k_weighting(); channels],
            sum: vec![0.0; channels],
            n: 0,
            peak: 0.0,
        }
    }

    /// Feed interleaved `samples` the scene really played; every completed 100 ms goes to
    /// `out`. A partial segment carries into the next call.
    pub fn feed(&mut self, samples: &[f32], out: &mut Vec<Segment>) {
        for frame in samples.chunks_exact(self.channels) {
            for ((x, f), acc) in frame.iter().zip(&mut self.filters).zip(&mut self.sum) {
                let shelved = f[0].run(*x as f64);
                let y = f[1].run(shelved);
                *acc += y * y;
                self.peak = self.peak.max(x.abs());
            }
            self.n += 1;
            if self.n == SEGMENT_FRAMES {
                let power = self.sum.iter().sum::<f64>() / SEGMENT_FRAMES as f64;
                out.push(Segment {
                    power,
                    peak: self.peak,
                });
                self.sum.iter_mut().for_each(|s| *s = 0.0);
                self.n = 0;
                self.peak = 0.0;
            }
        }
    }
}

/// What a source reports (`scene.loudness`): the integration over every session measured so
/// far (its seed + this source's own play).
#[derive(Debug, Clone, PartialEq)]
pub struct Learned {
    /// Integrated loudness (gated), LUFS.
    pub lufs: f64,
    /// Sample peak over everything measured, dBFS (≤ the true peak).
    pub peak_dbfs: f64,
    /// Audible seconds measured over every session (blocks above the absolute gate × 100 ms).
    pub seconds: f64,
    /// Seconds of audio this source played (segments received), audible or not.
    pub played_s: f64,
    /// At least the window was measured (else a partial, at the source's end).
    pub complete: bool,
    /// Audible seconds measured by this source (the rest came from its seed).
    pub session_s: f64,
    /// The cap was reached: measuring stopped for good.
    pub capped: bool,
    /// Audible seconds this source continued (its seed, or what the source of the same scene
    /// before it measured — [`Book`]).
    pub seed_s: f64,
    pub window_s: f64,
    pub cap_s: f64,
    /// [`Learner::state_json`] at the report: what the backend stores and seeds the next play
    /// with.
    pub state: serde_json::Value,
}

/// The histogram's bins: [`HIST_STEP`] LU wide from [`ABS_GATE_LUFS`] up to +5 LUFS (a block
/// louder than that lands in the last bin). The standard trick for an integrated loudness
/// that can be continued: BS.1770's relative gate needs every block's loudness, which the
/// counts per 0.1 LU keep to ±0.05 LU — and two histograms add.
pub const HIST_STEP: f64 = 0.1;
pub const HIST_BINS: usize = 750;
/// The state's format version (`state_json`).
const STATE_V: u64 = 1;

fn bin_of(lufs: f64) -> usize {
    (((lufs - ABS_GATE_LUFS) / HIST_STEP).floor().max(0.0) as usize).min(HIST_BINS - 1)
}

/// A bin's block power (its centre's loudness).
fn bin_power(i: usize) -> f64 {
    10f64.powf((ABS_GATE_LUFS + (i as f64 + 0.5) * HIST_STEP + 0.691) / 10.0)
}

/// BS.1770's gated integration over a histogram of block loudness (already absolute-gated).
fn integrate(hist: &[u64]) -> Option<f64> {
    let (mut e, mut n) = (0.0, 0u64);
    for (i, c) in hist.iter().enumerate().filter(|(_, c)| **c > 0) {
        e += *c as f64 * bin_power(i);
        n += c;
    }
    if n == 0 {
        return None;
    }
    let rel = lufs_of(e / n as f64) + REL_GATE_LU;
    let (mut e, mut n) = (0.0, 0u64);
    for (i, c) in hist.iter().enumerate().filter(|(_, c)| **c > 0) {
        if ABS_GATE_LUFS + (i as f64 + 0.5) * HIST_STEP > rel {
            e += *c as f64 * bin_power(i);
            n += c;
        }
    }
    (n > 0).then(|| lufs_of(e / n as f64))
}

/// A seed (`state_json` of an earlier session) → (histogram, linear peak); `None` = malformed.
fn parse_state(v: &serde_json::Value) -> Option<(Vec<u64>, f32)> {
    if v.get("v")?.as_u64()? != STATE_V {
        return None;
    }
    let first = v.get("first")?.as_u64()? as usize;
    let counts = v.get("counts")?.as_array()?;
    if first.checked_add(counts.len())? > HIST_BINS {
        return None;
    }
    let mut hist = vec![0u64; HIST_BINS];
    for (i, c) in counts.iter().enumerate() {
        hist[first + i] = c.as_u64()?;
    }
    let peak = match v.get("peak_dbfs") {
        Some(p) if p.is_null() => 0.0,
        Some(p) => 10f64.powf(p.as_f64()? / 20.0) as f32,
        None => 0.0,
    };
    Some((hist, peak))
}

/// The compositor's half: segments in, the gated integration out. One per scene source,
/// **seeded** with the state stored after earlier plays (`with_seed`), so each play refines
/// the same measurement; reports when the audible play over every session reaches the window,
/// after each further window of this source's audible play, at the cap (then measuring stops
/// for good) and at the end ([`finish`](Self::finish)) for what's left.
#[derive(Debug, Clone)]
pub struct Learner {
    window_s: f64,
    cap_s: f64,
    recent: VecDeque<f64>,
    /// Block counts per 0.1 LU bin: the seed's + this source's.
    hist: Vec<u64>,
    /// Blocks in `hist` (above the absolute gate): every session's.
    blocks: u64,
    seed_blocks: u64,
    /// `blocks` at the last report (the seed's at the start).
    reported_blocks: u64,
    peak: f32,
    segments: u64,
    /// Nothing more is taken: the cap was reached, or the source ended.
    done: bool,
    capped: bool,
}

impl Learner {
    pub fn new(window_s: f64) -> Learner {
        Learner {
            window_s,
            cap_s: DEFAULT_CAP_S.max(window_s),
            recent: VecDeque::with_capacity(BLOCK_SEGMENTS),
            hist: vec![0; HIST_BINS],
            blocks: 0,
            seed_blocks: 0,
            reported_blocks: 0,
            peak: 0.0,
            segments: 0,
            done: false,
            capped: false,
        }
    }

    /// The total audible seconds after which measuring stops (never below the window).
    pub fn with_cap(mut self, cap_s: f64) -> Learner {
        self.cap_s = cap_s.max(self.window_s);
        self.check_cap();
        self
    }

    /// Continue an earlier measurement (`state_json` of the last report stored in the index);
    /// `None` or a malformed state = start from nothing.
    pub fn with_seed(mut self, seed: Option<&serde_json::Value>) -> Learner {
        let Some((hist, peak)) = seed.and_then(parse_state) else {
            return self;
        };
        self.blocks = hist.iter().sum();
        self.seed_blocks = self.blocks;
        self.reported_blocks = self.blocks;
        self.hist = hist;
        self.peak = peak;
        self.check_cap();
        self
    }

    fn check_cap(&mut self) {
        if self.audible_s() + 1e-9 >= self.cap_s {
            self.done = true;
            self.capped = true;
        }
    }

    pub fn window_s(&self) -> f64 {
        self.window_s
    }

    pub fn cap_s(&self) -> f64 {
        self.cap_s
    }

    /// A partial needs this much audible play (a third of the window: 20 s by default).
    pub fn min_s(&self) -> f64 {
        self.window_s / 3.0
    }

    /// What has to be left unreported for a report at the end (a twelfth of the window: 5 s by
    /// default) — a quick switch costs no index write.
    pub fn end_min_s(&self) -> f64 {
        self.window_s / 12.0
    }

    /// Nothing more is taken (capped, or ended).
    pub fn done(&self) -> bool {
        self.done
    }

    /// The cap was reached (measuring stopped for good, the worker needn't meter).
    pub fn capped(&self) -> bool {
        self.capped
    }

    /// Audible seconds over every session (the seed's + this source's).
    pub fn audible_s(&self) -> f64 {
        self.blocks as f64 * SEGMENT_S
    }

    /// Audible seconds the seed brought.
    pub fn seed_s(&self) -> f64 {
        self.seed_blocks as f64 * SEGMENT_S
    }

    /// Audible seconds this source measured.
    pub fn session_s(&self) -> f64 {
        (self.blocks - self.seed_blocks) as f64 * SEGMENT_S
    }

    pub fn played_s(&self) -> f64 {
        self.segments as f64 * SEGMENT_S
    }

    /// The gated integrated loudness of everything measured so far (`None`: nothing above the
    /// absolute gate — a silent scene).
    pub fn integrated(&self) -> Option<f64> {
        integrate(&self.hist)
    }

    /// What the backend stores and seeds the next play with: `{v: 1, first, counts, peak_dbfs}`
    /// — the non-zero span of the histogram (bin `first + i` holds the blocks between −70 +
    /// 0.1·(first + i) and 0.1 LU above), and the sample peak (null = none).
    pub fn state_json(&self) -> serde_json::Value {
        let first = self.hist.iter().position(|c| *c > 0).unwrap_or(0);
        let last = self.hist.iter().rposition(|c| *c > 0).map_or(first, |l| l + 1);
        serde_json::json!({
            "v": STATE_V,
            "first": first,
            "counts": &self.hist[first..last],
            "peak_dbfs": (self.peak > 0.0).then(|| 20.0 * (self.peak as f64).log10()),
        })
    }

    fn learned(&mut self) -> Option<Learned> {
        let lufs = self.integrated()?;
        self.reported_blocks = self.blocks;
        Some(Learned {
            lufs,
            peak_dbfs: if self.peak > 0.0 {
                20.0 * (self.peak as f64).log10()
            } else {
                f64::NEG_INFINITY
            },
            seconds: self.audible_s(),
            played_s: self.played_s(),
            complete: self.audible_s() + 1e-9 >= self.window_s,
            session_s: self.session_s(),
            capped: self.capped,
            seed_s: self.seed_s(),
            window_s: self.window_s,
            cap_s: self.cap_s,
            state: self.state_json(),
        })
    }

    /// Another source of the same scene continues this measurement ([`Book::join`], or the
    /// measuring one left while another still plays): what's measured so far becomes its seed
    /// (`seed_s`), its block forming and played time start over (blocks never span two
    /// sources), and it measures again unless capped. What's still unreported stays so — the
    /// next report includes it, once.
    pub fn begin_session(&mut self) {
        self.seed_blocks = self.blocks;
        self.segments = 0;
        self.recent.clear();
        self.done = self.capped;
    }

    /// The audible seconds at which the next report is due: the window, then each further
    /// window, never past the cap.
    fn next_report_s(&self) -> f64 {
        let reported = self.reported_blocks as f64 * SEGMENT_S;
        let next = if reported + 1e-9 < self.window_s {
            self.window_s
        } else {
            reported + self.window_s
        };
        next.min(self.cap_s)
    }

    /// Take one segment; `Some` when a report is due (the window reached, a further window
    /// measured, the cap).
    pub fn push(&mut self, seg: Segment) -> Option<Learned> {
        if self.done || !seg.power.is_finite() || seg.power < 0.0 {
            return None;
        }
        self.segments += 1;
        if self.recent.len() == BLOCK_SEGMENTS {
            self.recent.pop_front();
        }
        self.recent.push_back(seg.power);
        if self.recent.len() < BLOCK_SEGMENTS {
            return None;
        }
        let block = self.recent.iter().sum::<f64>() / BLOCK_SEGMENTS as f64;
        let l = lufs_of(block);
        if l <= ABS_GATE_LUFS {
            return None;
        }
        self.hist[bin_of(l)] += 1;
        self.blocks += 1;
        self.peak = self.peak.max(seg.peak);
        if self.audible_s() + 1e-9 < self.next_report_s() {
            return None;
        }
        self.check_cap();
        self.learned()
    }

    /// The source ends (switched away, destroyed, its path changed): a report of what's left
    /// unreported (≥ [`end_min_s`](Self::end_min_s)) once the play over every session reached
    /// [`min_s`](Self::min_s). Learning stops.
    pub fn finish(&mut self) -> Option<Learned> {
        if self.done {
            return None;
        }
        self.done = true;
        let unreported = (self.blocks - self.reported_blocks) as f64 * SEGMENT_S;
        if self.audible_s() + 1e-9 < self.min_s() || unreported + 1e-9 < self.end_min_s() {
            return None;
        }
        self.learned()
    }
}

/// Idle paths (no live source) whose measurement the [`Book`] keeps for a reopen — the least
/// recently left beyond this go (a rotation through more scenes than this falls back to the
/// backend's seed for the oldest: what it lost is at most a report's unreported rest).
pub const BOOK_IDLE_KEEP: usize = 64;

/// Every scene path's measurement in this player, shared by the sources playing it (TODO "A
/// reopen right after a stop can seed with the previous report"). The backend seeds a new
/// source from its index (`loudness_seed`), which can lag the player: the end-of-play report of
/// a source retired just before (stored off the backend's event thread) — or a rest too short
/// to report at all — isn't in it yet. The player holds the measurement itself, so:
///
/// - **one measurement per path, continued by every source of it** ([`join`](Self::join)): a
///   new source continues the path's live (or last left) learner — unless its seed covers MORE
///   audible play (another lineage — e.g. after a player restart, or the index edited — is then
///   adopted). Never both added: a seed is never merged into a learner, so no block is counted
///   twice (every report the backend stored came from this lineage, or is the one adopted). A
///   source opening with NO seed on a path no source plays starts afresh
///   ([`forget_idle`](Self::forget_idle): the item was deleted and re-added, or updated);
/// - **one source of a path measures — the head** ([`push`](Self::push)): a source joining a
///   path that is playing is **pending** until its first segment, and only then takes over
///   (a transition A → A' of one scene: A measures on while A' loads, waits or stays silent —
///   A' paused, restored broken, past its restart budget — and A's segments are dropped from
///   A''s first one on: the same sound, never counted twice). A member that joined before the
///   head never takes over by sounding. When the head leaves, the newest member that joined
///   before it measures on (it was playing), else the newest pending one; a pending member
///   leaving changes nothing;
/// - **the end of a play** ([`leave`](Self::leave)) reports what's left (`Learner::finish`) and
///   keeps the learner for the next source of the path (no wait, no index round trip).
///
/// Paths are keys as the caller gives them — `SceneSource` canonicalizes (`/home` vs its
/// physical path, a trailing slash, a `local/<id>` symlink share one entry). In memory only: a
/// player crash/restart starts from the backend's seeds again (the documented bounded loss —
/// player-core.md § "Scene loudness").
#[derive(Debug, Default)]
pub struct Book {
    paths: HashMap<String, Measure>,
    /// Paths without a live source, least recently left first (≤ [`BOOK_IDLE_KEEP`]).
    idle: VecDeque<String>,
}

#[derive(Debug)]
struct Measure {
    learner: Learner,
    /// Live sources of the path in the order they joined.
    members: Vec<String>,
    /// The measuring member (`Some` whenever `members` isn't empty).
    head: Option<String>,
}

impl Measure {
    fn pos(&self, id: &str) -> Option<usize> {
        self.members.iter().position(|x| x == id)
    }
}

/// The book the compositor's scene sources share (`SourceHost` owns one).
pub type SharedBook = Arc<Mutex<Book>>;

impl Book {
    pub fn shared() -> SharedBook {
        Arc::new(Mutex::new(Book::default()))
    }

    /// Source `id` opens on `path`; `seeded` = the learner its `loudness_seed` (the backend's
    /// index) makes. It continues the path's measurement — or adopts `seeded` when that covers
    /// more audible play. On a path no source plays it measures at once; else it is pending
    /// until its first segment ([`push`](Self::push)).
    pub fn join(&mut self, path: &str, id: &str, seeded: Learner) {
        self.idle.retain(|p| p != path);
        let m = self.paths.entry(path.to_string()).or_insert_with(|| Measure {
            learner: seeded.clone(),
            members: Vec::new(),
            head: None,
        });
        m.members.retain(|x| x != id);
        if m.head.as_deref() == Some(id) {
            m.head = None;
        }
        m.members.push(id.to_string());
        let adopt = seeded.blocks > m.learner.blocks;
        if adopt {
            m.learner = seeded;
        }
        if m.head.is_none() {
            m.head = Some(id.to_string());
            if !adopt {
                m.learner.begin_session();
            }
        }
    }

    /// A source opens on `path` without a seed: if no source plays the path, its idle entry
    /// goes (the backend has nothing for the item — deleted and re-added, or never reported —
    /// so a measurement left from before isn't continued). `true` = something was dropped.
    pub fn forget_idle(&mut self, path: &str) -> bool {
        if self.paths.get(path).is_some_and(|m| m.members.is_empty()) {
            self.paths.remove(path);
            self.idle.retain(|p| p != path);
            true
        } else {
            false
        }
    }

    /// Source `id` stops playing `path` (destroyed, its path changed): if it was the measuring
    /// one, the end's report of what's left (`Learner::finish`) — and another live source of
    /// the path, if any, measures on (the newest that joined before it, else the newest). The
    /// learner stays for a reopen. Idempotent.
    pub fn leave(&mut self, path: &str, id: &str) -> Option<Learned> {
        let m = self.paths.get_mut(path)?;
        let at = m.pos(id)?;
        let head = m.head.as_deref() == Some(id);
        m.members.remove(at);
        if !head {
            return None;
        }
        let r = m.learner.finish();
        m.head = None;
        if m.members.is_empty() {
            self.idle.push_back(path.to_string());
            while self.idle.len() > BOOK_IDLE_KEEP {
                if let Some(p) = self.idle.pop_front() {
                    self.paths.remove(&p);
                }
            }
        } else {
            // Members before `at` joined before the head: they were playing.
            let next = if at > 0 { at - 1 } else { m.members.len() - 1 };
            m.head = Some(m.members[next].clone());
            m.learner.begin_session();
        }
        r
    }

    /// A segment `id` played of `path`: measured if `id` is the path's measuring source
    /// (`Learner::push` — `Some` when a report is due); a pending member's first segment makes
    /// it the measuring one (`Learner::begin_session`); anything else is dropped.
    pub fn push(&mut self, path: &str, id: &str, seg: Segment) -> Option<Learned> {
        let m = self.paths.get_mut(path)?;
        if m.head.as_deref() != Some(id) {
            let (Some(me), Some(h)) = (m.pos(id), m.head.as_deref().and_then(|h| m.pos(h)))
            else {
                return None;
            };
            if me < h {
                return None;
            }
            m.head = Some(id.to_string());
            m.learner.begin_session();
        }
        m.learner.push(seg)
    }

    /// A live `loudness_seed` on source `id`: like a join's seed, adopted only when it covers
    /// more audible play than the path's measurement (never counted twice, never less); who
    /// measures is unchanged.
    pub fn reseed(&mut self, path: &str, id: &str, seeded: Learner) {
        match self.paths.get_mut(path) {
            Some(m) if m.pos(id).is_some() => {
                if seeded.blocks > m.learner.blocks {
                    m.learner = seeded;
                }
            }
            _ => self.join(path, id, seeded),
        }
    }

    /// `path`'s measurement, if the book holds one.
    pub fn learner(&self, path: &str) -> Option<&Learner> {
        self.paths.get(path).map(|m| &m.learner)
    }

    /// `id` is the source measuring `path`.
    pub fn measuring(&self, path: &str, id: &str) -> bool {
        self.paths
            .get(path)
            .is_some_and(|m| m.head.as_deref() == Some(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stereo sine (`hz`, peak `dbfs` on both channels), `secs` long, through the meter.
    fn sine_segments(hz: f64, dbfs: f64, secs: f64, channels: usize) -> Vec<Segment> {
        let amp = 10f64.powf(dbfs / 20.0);
        let n = (secs * RATE as f64) as usize;
        let mut buf = Vec::with_capacity(n * channels);
        for i in 0..n {
            let v = (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / RATE as f64).sin()) as f32;
            for _ in 0..channels {
                buf.push(v);
            }
        }
        let mut m = SegmentMeter::new(channels);
        let mut out = Vec::new();
        // In odd-sized buffers, as a stream delivers them.
        for c in buf.chunks(257 * channels) {
            m.feed(c, &mut out);
        }
        out
    }

    fn integrate(segs: &[Segment]) -> Option<f64> {
        let mut l = Learner::new(1e9);
        for s in segs {
            l.push(*s);
        }
        l.integrated()
    }

    /// EBU Tech 3341 case 1/2: a stereo 1 kHz sine at −23 dBFS (and −33) reads −23.0 (−33.0)
    /// LUFS ± 0.1; BS.1770's definition: a 997 Hz 0 dBFS sine on ONE channel is −3.01.
    #[test]
    fn stereo_1khz_sine_reads_its_level_in_lufs() {
        for db in [-23.0, -33.0, -20.0] {
            let l = integrate(&sine_segments(1000.0, db, 5.0, 2)).unwrap();
            assert!((l - db).abs() < 0.1, "{db} dBFS → {l} LUFS");
        }
        let mono = integrate(&sine_segments(997.0, 0.0, 5.0, 1)).unwrap();
        assert!((mono + 3.01).abs() < 0.1, "{mono}");
    }

    /// K-weighting: 100 Hz reads lower than 1 kHz (the RLB high-pass), 4 kHz higher (the shelf
    /// — about +2.7 dB at 4 kHz per the filter's response).
    #[test]
    fn k_weighting_shapes_the_spectrum() {
        let at = |hz| integrate(&sine_segments(hz, -20.0, 3.0, 2)).unwrap();
        let (low, mid, high) = (at(30.0), at(1000.0), at(4000.0));
        assert!(low < mid - 1.0, "30 Hz {low} vs 1 kHz {mid}");
        assert!(high > mid + 2.0 && high < mid + 4.0, "4 kHz {high} vs 1 kHz {mid}");
    }

    /// The absolute gate: silence between sound never pulls the result down (and isn't
    /// counted as audible); the relative gate: a long quiet passage (> 10 LU below) is
    /// excluded too (EBU Tech 3341 case 3/4-like).
    #[test]
    fn gating_excludes_silence_and_quiet_passages() {
        let mut segs = sine_segments(1000.0, -20.0, 10.0, 2);
        segs.extend(sine_segments(1000.0, -200.0, 10.0, 2)); // digital silence
        segs.extend(sine_segments(1000.0, -20.0, 10.0, 2));
        let l = integrate(&segs).unwrap();
        assert!((l + 20.0).abs() < 0.1, "{l}");
        let mut learner = Learner::new(1e9);
        for s in &segs {
            learner.push(*s);
        }
        assert!((learner.audible_s() - 20.0).abs() < 0.5, "{}", learner.audible_s());
        assert!((learner.played_s() - 30.0).abs() < 0.2);
        // 36 s loud + 24 s at −45 dBFS (25 LU below): the quiet part is gated out.
        let mut segs = sine_segments(1000.0, -20.0, 36.0, 2);
        segs.extend(sine_segments(1000.0, -45.0, 24.0, 2));
        let l = integrate(&segs).unwrap();
        assert!((l + 20.0).abs() < 0.2, "{l}");
        // −20 / −26 alternating (6 LU apart, within the gate): both count → between them.
        let mut segs = Vec::new();
        for _ in 0..5 {
            segs.extend(sine_segments(1000.0, -20.0, 2.0, 2));
            segs.extend(sine_segments(1000.0, -26.0, 2.0, 2));
        }
        let l = integrate(&segs).unwrap();
        let want = lufs_of((10f64.powf(-20.0 / 10.0) + 10f64.powf(-26.0 / 10.0)) / 2.0) + 0.691;
        assert!((l - want).abs() < 0.3, "{l} vs {want}");
    }

    /// A silent scene learns nothing (no event, ever); the window counts audible play only.
    #[test]
    fn silence_learns_nothing_and_the_window_is_audible_play() {
        let mut l = Learner::new(3.0);
        for s in sine_segments(1000.0, -200.0, 10.0, 2) {
            assert!(l.push(s).is_none());
        }
        assert_eq!(l.integrated(), None);
        assert!(l.finish().is_none(), "silent: no partial either");
        let mut l = Learner::new(3.0);
        let segs = sine_segments(1000.0, -20.0, 5.0, 2);
        let mut hits = Vec::new();
        for (i, s) in segs.iter().enumerate() {
            if let Some(x) = l.push(*s) {
                hits.push((i, x));
            }
        }
        assert_eq!(hits.len(), 1, "once: {hits:?}");
        let (i, x) = hits[0].clone();
        // 3 s audible: the first block needs 4 segments, then one per segment.
        assert_eq!(i, 32, "at segment {i}");
        assert!(x.complete && (x.lufs + 20.0).abs() < 0.1 && (x.seconds - 3.0).abs() < 1e-6);
        assert!((x.peak_dbfs + 20.0).abs() < 0.01, "{}", x.peak_dbfs);
        // Measuring goes on (the next report after another window, or at the end).
        assert!(!l.done());
        let end = l.finish().expect("the 1.7 s since, at the end");
        assert!((end.seconds - 4.7).abs() < 1e-6 && end.complete, "{end:?}");
        assert!(l.done() && l.finish().is_none(), "nothing more after the end");
    }

    /// Ending early: a partial from a third of the window on, nothing below it.
    #[test]
    fn a_source_ending_early_reports_a_partial_from_a_third_of_the_window() {
        let mut l = Learner::new(6.0);
        for s in sine_segments(1000.0, -20.0, 1.5, 2) {
            assert!(l.push(s).is_none());
        }
        assert!(l.finish().is_none(), "1.5 s < 2 s");
        let mut l = Learner::new(6.0);
        for s in sine_segments(1000.0, -26.0, 3.0, 2) {
            assert!(l.push(s).is_none());
        }
        let p = l.finish().expect("a partial");
        assert!(!p.complete && (p.lufs + 26.0).abs() < 0.1, "{p:?}");
        assert!(p.seconds > 2.0 && p.seconds < 3.0, "{p:?}");
    }

    /// The exact BS.1770 integration of `segs` (every gating block kept as is — no histogram):
    /// the reference a merged histogram is held to.
    /// Also the audible seconds (blocks above the absolute gate).
    fn exact(segs: &[Segment]) -> (f64, f64) {
        let p: Vec<f64> = segs.iter().map(|s| s.power).collect();
        let blocks: Vec<f64> = p
            .windows(BLOCK_SEGMENTS)
            .map(|w| w.iter().sum::<f64>() / BLOCK_SEGMENTS as f64)
            .filter(|b| lufs_of(*b) > ABS_GATE_LUFS)
            .collect();
        let secs = blocks.len() as f64 * SEGMENT_S;
        let mean = blocks.iter().sum::<f64>() / blocks.len() as f64;
        let rel = lufs_of(mean) + REL_GATE_LU;
        let g: Vec<f64> = blocks.into_iter().filter(|b| lufs_of(*b) > rel).collect();
        (lufs_of(g.iter().sum::<f64>() / g.len() as f64), secs)
    }

    /// Feed `segs` to `l`, collecting every report.
    fn feed(l: &mut Learner, segs: &[Segment]) -> Vec<Learned> {
        segs.iter().filter_map(|s| l.push(*s)).collect()
    }

    /// Owner (2026-10-28): "keep measuring to get a more accurate measure when the scene is
    /// played in future". A session seeded with the previous one's state (its histogram) ends
    /// where ONE long integration over both would — within 0.1 LU — for any split.
    #[test]
    fn histogram_merge_across_sessions_equals_one_long_integration() {
        let mut segs = Vec::new();
        for (db, secs) in [
            (-20.0, 8.0),
            (-31.0, 6.0),
            (-24.0, 9.0),
            (-200.0, 3.0),
            (-17.0, 4.0),
        ] {
            segs.extend(sine_segments(1000.0, db, secs, 2));
        }
        let (want, one) = exact(&segs);
        for split in [40, 95, 160, 230] {
            let mut a = Learner::new(5.0).with_cap(1e9);
            feed(&mut a, &segs[..split]);
            let _ = a.finish();
            let st = a.state_json();
            // The seed carries the first session's blocks; the next continues them.
            let mut b = Learner::new(5.0).with_cap(1e9).with_seed(Some(&st));
            feed(&mut b, &segs[split..]);
            let got = b.integrated().unwrap();
            assert!(
                (got - want).abs() < 0.1,
                "split {split}: {got} vs one integration {want}"
            );
            // Each session forms its own first block: the second session's first 3
            // segments start no block (0.3 s fewer audible seconds than one long run).
            let secs = b.audible_s();
            assert!(
                secs <= one + 1e-9 && secs > one - 0.35,
                "split {split}: {secs} vs {one}"
            );
            assert!((b.seed_s() - a.audible_s()).abs() < 1e-9, "seed seconds");
        }
    }

    /// The relative gate is recomputed over ALL sessions: a quiet first play followed by a
    /// loud one gates the quiet part out (−20), where combining the two results (a seconds-
    /// weighted energy mean, −25.8) or keeping the first (−38) would be wrong.
    #[test]
    fn relative_gate_is_recomputed_across_quiet_and_loud_sessions() {
        let quiet = sine_segments(1000.0, -38.0, 30.0, 2);
        let loud = sine_segments(1000.0, -20.0, 10.0, 2);
        let mut a = Learner::new(5.0).with_cap(1e9);
        feed(&mut a, &quiet);
        assert!((a.integrated().unwrap() + 38.0).abs() < 0.1);
        let st = a.state_json();
        let mut b = Learner::new(5.0).with_cap(1e9).with_seed(Some(&st));
        assert_eq!(feed(&mut b, &loud).len(), 1, "after a window of its own");
        let got = b.integrated().unwrap();
        assert!((got + 20.0).abs() < 0.1, "{got}");
        let last = b.finish().expect("the rest, at the end");
        assert!((last.lufs + 20.0).abs() < 0.1 && last.complete, "{last:?}");
        // The other order: the quiet session after the loud one changes nothing.
        let mut a = Learner::new(5.0).with_cap(1e9);
        feed(&mut a, &loud);
        let mut b = Learner::new(5.0)
            .with_cap(1e9)
            .with_seed(Some(&a.state_json()));
        feed(&mut b, &quiet);
        assert!(
            (b.integrated().unwrap() + 20.0).abs() < 0.1,
            "{:?}",
            b.integrated()
        );
    }

    /// Cadence: the first report when the audible play (seed included) reaches the window,
    /// then one per further window of audible play, and one at the end for what's left (≥ a
    /// twelfth of the window); a seeded source that already has the window reports after a
    /// window of its own play.
    #[test]
    fn reports_each_further_window_and_at_the_end() {
        let segs = sine_segments(1000.0, -20.0, 10.0, 2);
        let mut l = Learner::new(3.0).with_cap(1e9);
        let r = feed(&mut l, &segs);
        let at: Vec<f64> = r
            .iter()
            .map(|x| (x.seconds * 10.0).round() / 10.0)
            .collect();
        assert_eq!(at, vec![3.0, 6.0, 9.0], "{r:?}");
        assert!(r.iter().all(|x| x.complete && !x.capped));
        let end = l.finish().expect("what's left at the end (0.7 s ≥ 0.25 s)");
        assert!((end.seconds - 9.7).abs() < 0.05 && end.complete, "{end:?}");
        assert!(
            l.finish().is_none() && l.push(segs[0]).is_none(),
            "nothing after the end"
        );
        // Seeded with 9.7 s: the next report after 3 s more of this source's play.
        let mut s = Learner::new(3.0)
            .with_cap(1e9)
            .with_seed(Some(&l.state_json()));
        assert!((s.audible_s() - 9.7).abs() < 0.05);
        let r = feed(&mut s, &sine_segments(1000.0, -20.0, 4.0, 2));
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(
            (r[0].seconds - 12.7).abs() < 0.05 && (r[0].session_s - 3.0).abs() < 0.05,
            "{r:?}"
        );
        // Too little left at the end: nothing (a quick switch costs no index write).
        let mut q = Learner::new(3.0)
            .with_cap(1e9)
            .with_seed(Some(&l.state_json()));
        feed(&mut q, &sine_segments(1000.0, -20.0, 0.5, 2));
        assert!(q.finish().is_none(), "0.2 s < a twelfth of the window");
    }

    /// The cap: once the audible play measured over every session reaches it, one last report
    /// (`capped`) and nothing more is taken — a scene that's never switched away doesn't
    /// accumulate forever. A seed already at the cap measures nothing at all.
    #[test]
    fn cap_stops_measuring() {
        let mut l = Learner::new(2.0).with_cap(5.0);
        let r = feed(&mut l, &sine_segments(1000.0, -20.0, 12.0, 2));
        let last = r.last().unwrap();
        assert!(last.capped && (last.seconds - 5.0).abs() < 1e-9, "{r:?}");
        assert_eq!(r.iter().filter(|x| x.capped).count(), 1);
        assert!(
            l.done() && (l.audible_s() - 5.0).abs() < 1e-9,
            "stopped at the cap"
        );
        assert!(l.finish().is_none());
        let st = l.state_json();
        let mut s = Learner::new(2.0).with_cap(5.0).with_seed(Some(&st));
        assert!(s.done(), "a seed at the cap measures nothing");
        assert!(feed(&mut s, &sine_segments(1000.0, -20.0, 3.0, 2)).is_empty());
        assert!(s.finish().is_none());
        // A cap below the window is the window.
        assert_eq!(Learner::new(6.0).with_cap(2.0).cap_s(), 6.0);
    }

    /// The state round-trips (counts + peak); anything malformed is no seed.
    #[test]
    fn state_round_trips_and_a_bad_seed_is_ignored() {
        let mut l = Learner::new(2.0).with_cap(1e9);
        feed(&mut l, &sine_segments(1000.0, -26.0, 3.0, 2));
        let st = l.state_json();
        let s = Learner::new(2.0).with_cap(1e9).with_seed(Some(&st));
        assert_eq!(s.integrated(), l.integrated());
        assert_eq!(s.audible_s(), l.audible_s());
        assert_eq!(s.state_json(), st, "{st}");
        for bad in [
            serde_json::json!({}),
            serde_json::json!({"v": 2, "first": 0, "counts": [1]}),
            serde_json::json!({"v": 1, "first": 749, "counts": [1, 1]}),
            serde_json::json!({"v": 1, "first": 0, "counts": [-1]}),
            serde_json::json!("x"),
        ] {
            let s = Learner::new(2.0).with_cap(1e9).with_seed(Some(&bad));
            assert_eq!(s.audible_s(), 0.0, "{bad}");
        }
        assert_eq!(cap_s(None), 1800.0);
        assert_eq!(cap_s(Some("12")), 12.0);
        assert_eq!(cap_s(Some("0")), 1800.0);
    }

    /// The book (TODO "A reopen right after a stop can seed with the previous report"): a
    /// reopen continues what the path's last source measured — its end report, and a rest too
    /// short to report — whatever older seed the backend's index still has; the up-to-date seed
    /// is the same measurement, never added again; a longer seed (another lineage) is adopted.
    #[test]
    fn book_reopen_continues_the_last_source_never_twice() {
        let tone = |secs| sine_segments(1000.0, -20.0, secs, 2);
        let seeded = |st: Option<&serde_json::Value>| Learner::new(2.0).with_cap(1e9).with_seed(st);
        let mut b = Book::default();
        b.join("p", "a", seeded(None));
        let r: Vec<Learned> = tone(3.5).into_iter().filter_map(|s| b.push("p", "a", s)).collect();
        assert_eq!(r.len(), 1, "the window's report: {r:?}");
        let window = r[0].clone();
        let end = b.leave("p", "a").expect("the end's report (1.2 s left ≥ 0.17 s)");
        assert!(end.seconds > window.seconds + 1.0, "{end:?}");
        assert!(b.leave("p", "a").is_none(), "idempotent");
        // The race: the reopen is seeded with the window's report → continues the end.
        b.join("p", "b", seeded(Some(&window.state)));
        let l = b.learner("p").unwrap();
        assert_eq!((l.audible_s(), l.seed_s(), l.session_s()), (end.seconds, end.seconds, 0.0));
        assert!(b.leave("p", "b").is_none(), "nothing new: no report");
        // Up to date: the same, not twice.
        b.join("p", "c", seeded(Some(&end.state)));
        assert_eq!(b.learner("p").unwrap().audible_s(), end.seconds);
        // A rest too short to report at the end is continued too.
        let short: Vec<_> = tone(0.4).into_iter().filter_map(|s| b.push("p", "c", s)).collect();
        assert!(short.is_empty());
        let after_c = b.learner("p").unwrap().audible_s();
        assert!(after_c > end.seconds, "c measured");
        assert!(b.leave("p", "c").is_none(), "0.1 s < a twelfth of the window");
        b.join("p", "d", seeded(Some(&end.state)));
        assert_eq!(b.learner("p").unwrap().audible_s(), after_c, "the unreported rest kept");
        // …and reported by the next report, once: seconds = seed + its own.
        let r: Vec<Learned> = tone(2.5).into_iter().filter_map(|s| b.push("p", "d", s)).collect();
        assert_eq!(r.len(), 1, "{r:?}");
        assert!((r[0].seconds - r[0].seed_s - r[0].session_s).abs() < 1e-9, "{r:?}");
        assert_eq!(r[0].seed_s, after_c);
        // A seed covering more (another lineage) is adopted, never added.
        let long = {
            let mut l = seeded(None);
            feed(&mut l, &tone(20.0));
            l.state_json()
        };
        b.leave("p", "d");
        b.join("p", "e", seeded(Some(&long)));
        let l = b.learner("p").unwrap();
        assert!((l.audible_s() - 19.7).abs() < 0.05 && l.seed_s() == l.audible_s(), "{}", l.audible_s());
        // Paths are separate.
        b.join("q", "f", seeded(None));
        assert_eq!(b.learner("q").unwrap().audible_s(), 0.0);
    }

    /// Two live sources of one path (a transition A → A'): A' continues A's live measurement
    /// from its FIRST segment on (until then A measures — A' may be loading, paused or broken)
    /// and only A' measures then (A's segments — the same sound — are dropped); A leaving
    /// reports nothing; A' leaving first hands the measurement back to A.
    #[test]
    fn book_hands_a_live_measurement_over_at_the_newest_sources_first_segment() {
        let tone = |secs| sine_segments(1000.0, -20.0, secs, 2);
        let fresh = || Learner::new(2.0).with_cap(1e9);
        let mut b = Book::default();
        b.join("p", "a", fresh());
        for s in tone(1.0) {
            assert!(b.push("p", "a", s).is_none());
        }
        b.join("p", "a2", fresh());
        assert!(b.measuring("p", "a") && !b.measuring("p", "a2"), "a2 is pending");
        // a2 silent for a while: a keeps measuring (its segments count).
        let before = b.learner("p").unwrap().audible_s();
        for s in tone(0.5) {
            b.push("p", "a", s);
        }
        let at_join = b.learner("p").unwrap().audible_s();
        assert!(at_join > before + 0.4, "a measured on: {before} → {at_join}");
        assert!(b.measuring("p", "a"));
        // a2's first segment: it takes over.
        let mut r = Vec::new();
        let segs = tone(2.0);
        r.extend(b.push("p", "a2", segs[0]));
        assert!(b.measuring("p", "a2") && !b.measuring("p", "a"));
        let l = b.learner("p").unwrap();
        assert_eq!(l.seed_s(), at_join, "a2's session starts at the hand-over");
        // Both play the same sound: only a2's counts.
        for s in &segs[1..] {
            assert!(b.push("p", "a", *s).is_none(), "a no longer measures");
            r.extend(b.push("p", "a2", *s));
        }
        let l = b.learner("p").unwrap();
        assert!((l.session_s() - 1.7).abs() < 0.05, "a2's own play only: {}", l.session_s());
        assert_eq!(r.len(), 1, "the window (2 s) reached once: {r:?}");
        assert!(b.leave("p", "a").is_none(), "a handed its measurement over: no report");
        assert!(b.measuring("p", "a2"));
        // A pending member that leaves without a sound: no report, no new session.
        let l = b.learner("p").unwrap().clone();
        b.join("p", "a3", fresh());
        assert!(b.leave("p", "a3").is_none(), "pending: no report");
        let after = b.learner("p").unwrap();
        assert!(b.measuring("p", "a2"));
        assert_eq!((after.seed_s(), after.session_s()), (l.seed_s(), l.session_s()), "no begin_session");
        // The newest leaves first (after taking over) → the older one measures on.
        b.join("p", "a4", fresh());
        b.push("p", "a4", tone(0.1)[0]);
        assert!(b.measuring("p", "a4"));
        let before = b.learner("p").unwrap().audible_s();
        b.leave("p", "a4");
        assert!(b.measuring("p", "a2"));
        for s in tone(1.0) {
            b.push("p", "a2", s);
        }
        assert!(b.learner("p").unwrap().audible_s() > before + 0.5, "a2 measures again");
    }

    /// The head leaving while a newer member is still pending: that one measures on at once
    /// (nothing older plays); a member that joined BEFORE the head never takes over by sounding.
    #[test]
    fn book_head_leaving_passes_to_an_older_member_first_then_a_pending_one() {
        let tone = |secs| sine_segments(1000.0, -20.0, secs, 2);
        let fresh = || Learner::new(2.0).with_cap(1e9);
        let mut b = Book::default();
        b.join("p", "a", fresh());
        b.join("p", "b", fresh());
        b.join("p", "c", fresh());
        b.push("p", "b", tone(0.1)[0]);
        assert!(b.measuring("p", "b"));
        // a joined before the head: its sound is dropped.
        assert!(b.push("p", "a", tone(0.1)[0]).is_none());
        assert!(b.measuring("p", "b"));
        // b leaves → a (older, playing) measures, c stays pending.
        b.leave("p", "b");
        assert!(b.measuring("p", "a"));
        // c's first segment takes over from a.
        b.push("p", "c", tone(0.1)[0]);
        assert!(b.measuring("p", "c"));
        // c leaves → a; a leaves with nobody older → the newest pending.
        b.leave("p", "c");
        assert!(b.measuring("p", "a"));
        b.join("p", "d", fresh());
        assert!(b.measuring("p", "a"), "d pending");
        b.leave("p", "a");
        assert!(b.measuring("p", "d"), "nothing older plays: the pending one at once");
    }

    /// `reseed` follows the join's rule — adopted only when the seed covers more — and never
    /// changes who measures.
    #[test]
    fn book_reseed_adopts_only_more_and_keeps_the_head() {
        let tone = |secs| sine_segments(1000.0, -20.0, secs, 2);
        let seeded = |st: Option<&serde_json::Value>| Learner::new(2.0).with_cap(1e9).with_seed(st);
        let mut b = Book::default();
        b.join("p", "a", seeded(None));
        for s in tone(3.0) {
            b.push("p", "a", s);
        }
        b.join("p", "b", seeded(None));
        let had = b.learner("p").unwrap().audible_s();
        let short = {
            let mut l = seeded(None);
            feed(&mut l, &tone(1.0));
            l.state_json()
        };
        b.reseed("p", "b", seeded(Some(&short)));
        assert_eq!(b.learner("p").unwrap().audible_s(), had, "a shorter seed is ignored");
        assert!(b.measuring("p", "a") && !b.measuring("p", "b"), "no reorder");
        let long = {
            let mut l = seeded(None);
            feed(&mut l, &tone(10.0));
            l.state_json()
        };
        b.reseed("p", "b", seeded(Some(&long)));
        assert!(b.learner("p").unwrap().audible_s() > had + 5.0, "a longer one is adopted");
        assert!(b.measuring("p", "a"), "still a");
        // On a path the book doesn't have: a join.
        b.reseed("q", "c", seeded(Some(&short)));
        assert!(b.measuring("q", "c"));
    }

    /// No seed on a path no source plays: the idle entry goes (deleted and re-added, updated)
    /// — never while a source plays it.
    #[test]
    fn book_forgets_an_idle_path_only_without_live_sources() {
        let tone = |secs| sine_segments(1000.0, -20.0, secs, 2);
        let fresh = || Learner::new(2.0).with_cap(1e9);
        let mut b = Book::default();
        b.join("p", "a", fresh());
        for s in tone(1.0) {
            b.push("p", "a", s);
        }
        assert!(!b.forget_idle("p"), "a plays it");
        b.leave("p", "a");
        assert!(b.forget_idle("p"));
        assert!(b.learner("p").is_none() && !b.idle.iter().any(|x| x == "p"));
        b.join("p", "b", fresh());
        assert_eq!(b.learner("p").unwrap().audible_s(), 0.0, "starts afresh");
    }

    /// The book keeps at most [`BOOK_IDLE_KEEP`] idle paths (the least recently left go); a
    /// path with a live source is never dropped.
    #[test]
    fn book_keeps_a_bounded_number_of_idle_paths() {
        let mut b = Book::default();
        b.join("live", "x", Learner::new(2.0));
        for i in 0..BOOK_IDLE_KEEP + 5 {
            let p = format!("p{i}");
            b.join(&p, "s", Learner::new(2.0));
            b.leave(&p, "s");
        }
        assert!(b.learner("p0").is_none() && b.learner("p4").is_none());
        assert!(b.learner("p5").is_some() && b.learner(&format!("p{}", BOOK_IDLE_KEEP + 4)).is_some());
        assert!(b.learner("live").is_some());
        assert_eq!(b.paths.len(), BOOK_IDLE_KEEP + 1);
    }

    /// Rejoining an idle path refreshes its recency: the least recently LEFT goes first.
    #[test]
    fn book_idle_eviction_is_least_recently_left() {
        let mut b = Book::default();
        for i in 0..BOOK_IDLE_KEEP {
            let p = format!("p{i}");
            b.join(&p, "s", Learner::new(2.0));
            b.leave(&p, "s");
        }
        b.join("p0", "s", Learner::new(2.0));
        b.leave("p0", "s");
        b.join("new", "s", Learner::new(2.0));
        b.leave("new", "s");
        assert!(b.learner("p0").is_some(), "p0 was left most recently but one");
        assert!(b.learner("p1").is_none(), "p1 is now the least recently left");
        assert_eq!(b.paths.len(), BOOK_IDLE_KEEP);
    }

    #[test]
    fn window_knob() {
        assert_eq!(window_s(None), 60.0);
        assert_eq!(window_s(Some(" 3 ")), 3.0);
        assert_eq!(window_s(Some("0.5")), 0.5);
        for v in ["0", "-1", "x", "", "inf", "NaN"] {
            assert_eq!(window_s(Some(v)), 60.0, "{v}");
        }
    }
}
