//! Per-stream capture of every application playback stream — **one capture per stream, shared
//! by two users**:
//!
//! - **The visualiser's audio input** (Phase 2 Task 7, owner decision D4): **all system audio,
//!   like Wallpaper Engine** — which listens to everything that plays, a wallpaper's own sound
//!   included. [`SysMon::frame`] sums every stream that delivered within [`STALE`] into the 1024
//!   u8 samples (centre 128) LWE's visualiser FFT takes (`wp_audio_input_mix`).
//! - **The in-player auto-mute's per-stream meter** (Phase 3 Task 14, `crate::signal::automute`;
//!   rules recon §0.6 "share it rather than add a second one"): each capture's callback runs on
//!   PipeWire's **real-time data thread** (`RT_PROCESS`, like the bus meter: a non-RT loop misses
//!   cycles under load) and meters peaks in ≤ [`FRAG_FRAMES`] (10 ms) slices **as each buffer
//!   arrives** — no slice waits for the next buffer. Per stream: the start of its current
//!   audible run (a slice above `automute_min_level_db`; a gap > [`RUN_GAP_NS`] starts a new
//!   run) and its last audible slice, on CLOCK_MONOTONIC (the buffer's cycle time,
//!   `pw_buffer.time`). A run starting on a stream that **counts** wakes the runtime at once
//!   ([`SysMon::set_wake`], a calloop ping — an eventfd write, fine from the RT thread).
//!   Whether a stream counts is decided here, on the `lia-sysmon` thread, from registry data by
//!   `audio::foreign` (ownership; MPRIS; the node's `Props` mute/volume) and re-decided on every
//!   registry/param/MPRIS change.
//!
//! [`SysMon::start`] runs its own PipeWire thread (`lia-sysmon`): every node of class
//! `Stream/Output/Audio` that [`admit`] lets through (by default: everything but loopback
//! halves — `node.virtual`, which would count a stream twice, e.g. our bus's playback carrying
//! every wallpaper source) gets a passive capture stream `liascape-player-visualiser.<id>` linked to
//! it (`target.object` = its serial; `node.dont-reconnect` + `node.dont-fallback`, so a target
//! that goes away is never replaced by the default source — a microphone). It also tracks
//! Client objects (a native node's pid is on its client), Links (a stream linked into the bus is
//! ours) and each stream's `Props`. Read-only: it never plays, links nothing else and changes no
//! routing; no capture requests a quantum (R68). The runtime runs it while ≥ 1 live scene wants
//! audio input **or** the auto-mute Signal is on, and drops it when neither does. A lost
//! PipeWire connection is retried every [`RETRY`].

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::context::ContextRc;
use pw::core::CoreRc;
use pw::main_loop::MainLoopRc;
use pw::properties::properties;
use pw::registry::GlobalObject;
use pw::spa;
use pw::stream::{StreamFlags, StreamListener, StreamRc};
use pw::types::ObjectType;
use serde_json::{Value, json};

use super::bus::{APP_NAME, METER_SCRATCH_CAP, SINK_NAME, connect_with, read_capture};
use super::foreign::{self, Identity, MprisPlayer, OwnCtx, StreamVolume, Verdict};
use super::meter::mono_ns;
use crate::log::{self, Level};

/// Samples per visualiser frame (`WP_AUDIO_INPUT_FRAME_SIZE`).
pub const FRAME: usize = 1024;
/// A stream that delivered nothing for this long counts as silent (a paused player keeps its
/// node but sends no buffers).
pub const STALE: Duration = Duration::from_millis(150);
/// Reconnect delay after a lost PipeWire connection.
pub const RETRY: Duration = Duration::from_secs(1);
/// Our capture streams' `node.name` prefix.
pub const NAME_PREFIX: &str = "liascape-player-visualiser.";
/// The auto-mute meter's slice: 10 ms at 48 kHz (spec §4.4 "10 ms fragments").
pub const FRAG_FRAMES: usize = 480;
/// A gap longer than this between audible slices ends a run (today's `AudioMonitor` resets its
/// count on one quiet 20 ms chunk).
pub const RUN_GAP_NS: i64 = 20_000_000;
const TICK: Duration = Duration::from_millis(20);

/// What a playback stream says about itself (registry props of its node).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StreamProps {
    pub id: u32,
    pub serial: Option<u64>,
    pub node_name: String,
    pub app_name: String,
    pub binary: String,
    pub media_class: String,
    pub virtual_node: bool,
    pub media_name: String,
    pub media_role: String,
    pub client_id: Option<u32>,
    /// The node's own `application.process.id` (a pulse client's; a native node has none).
    pub pid: Option<u32>,
    pub target: String,
    pub portal_app_id: Option<String>,
}

/// A Client object's identity (`application.process.id` etc.).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ClientProps {
    pub pid: Option<u32>,
    pub binary: String,
    pub app_name: String,
    pub portal_app_id: Option<String>,
}

/// The registry keys a stream's process id is read from — never `pipewire.sec.pid` (for a
/// pipewire-pulse client it is the pulse server's own pid).
pub fn identity_pid_keys() -> &'static [&'static str] {
    &["application.process.id"]
}

/// Node + client → [`Identity`] (the node's field first, its client's when the node has none).
pub fn identity_of(sp: &StreamProps, client: Option<&ClientProps>) -> Identity {
    let or = |a: &str, b: Option<&str>| {
        if a.is_empty() {
            b.unwrap_or("").to_string()
        } else {
            a.to_string()
        }
    };
    Identity {
        pid: sp.pid.or(client.and_then(|c| c.pid)),
        binary: or(&sp.binary, client.map(|c| c.binary.as_str())),
        app_name: or(&sp.app_name, client.map(|c| c.app_name.as_str())),
        portal_app_id: sp
            .portal_app_id
            .clone()
            .or(client.and_then(|c| c.portal_app_id.clone())),
        target: sp.target.clone(),
    }
}

/// Whether a stream counts for auto-mute now. **Classify, then count** (the bug the backend's
/// `AudioMonitor` had until 2026-10-28): a stream whose identity isn't read yet (`identified`:
/// its node's and its client's full props arrived) never counts, so a scene worker's stream
/// ramping in can't mute the wallpaper in the moment before its pid is known. Its run keeps
/// its first audible time, so a foreign stream's delay still counts from its first sample.
pub fn counts_now(
    identified: bool,
    verdict: Verdict,
    volume: &StreamVolume,
    only_mpris: bool,
    has_mpris_owner: bool,
) -> bool {
    identified && verdict.foreign() && !volume.silent() && (!only_mpris || has_mpris_owner)
}

/// Whether a stream is captured at all. **The plug point for a future per-app
/// white/blacklist** (D4): today every application playback stream counts (WE's "all system
/// audio"), except a loopback half (`node.virtual`), which re-plays streams already counted.
pub fn admit(p: &StreamProps) -> bool {
    p.media_class == "Stream/Output/Audio" && !p.virtual_node
}

/// The mix of each stream's latest mono samples → `FRAME` u8 samples (centre 128, ±127 =
/// full scale), clamped. Streams are aligned at their newest sample (a visualiser needs the
/// spectrum, not phase alignment).
pub fn mix_frame<'a>(streams: impl IntoIterator<Item = &'a VecDeque<f32>>) -> Vec<u8> {
    let mut acc = vec![0f32; FRAME];
    for s in streams {
        let n = s.len().min(FRAME);
        for (i, v) in s.iter().skip(s.len() - n).enumerate() {
            acc[FRAME - n + i] += *v;
        }
    }
    acc.iter()
        .map(|x| (128.0 + 127.0 * x.clamp(-1.0, 1.0)).round() as u8)
        .collect()
}

/// `dBFS → linear` for the threshold.
fn db_lin(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

#[derive(Default)]
struct Ring {
    samples: VecDeque<f32>,
    last: Option<Instant>,
}

/// One stream's capture: the visualiser's ring + the auto-mute meter (atomics, RT-written).
#[derive(Default)]
pub struct Tap {
    ring: Mutex<Ring>,
    /// This stream counts for auto-mute (decided on `lia-sysmon`).
    pub counts: AtomicBool,
    /// CLOCK_MONOTONIC ns of the current audible run's first slice (0 = none yet).
    pub run_start_ns: AtomicI64,
    /// …and of the end of the last audible slice (0 = never audible).
    pub last_above_ns: AtomicI64,
    /// The newest buffer's cycle time and its length (the graph quantum, in ns).
    pub last_buf_ns: AtomicI64,
    pub buf_ns: AtomicI64,
    /// …and its end (`last_buf_ns` + its length).
    pub buf_end_ns: AtomicI64,
    /// Its loudest slice (dBFS, f32 bits).
    peak_db: AtomicU32,
    buffers: AtomicU64,
}

impl Tap {
    pub fn peak_db(&self) -> f32 {
        f32::from_bits(self.peak_db.load(Ordering::Relaxed))
    }

    pub fn buffers(&self) -> u64 {
        self.buffers.load(Ordering::Relaxed)
    }

    /// Meter one interleaved stereo chunk starting at `t_ns` (RT thread: no allocation, no
    /// blocking — the ring is `try_lock`ed and skipped when the visualiser is reading it).
    fn feed(&self, buf: &[f32], t_ns: i64, thr: f32, shared: &Shared) {
        if shared.visual.load(Ordering::Relaxed)
            && let Ok(mut r) = self.ring.try_lock()
        {
            for fr in buf.chunks_exact(2) {
                if r.samples.len() == FRAME {
                    r.samples.pop_front();
                }
                r.samples.push_back(0.5 * (fr[0] + fr[1]));
            }
            r.last = Some(Instant::now());
        }
        let ns_per_frame = 1e9 / f64::from(super::bus::RATE);
        let mut loudest = 0f32;
        let mut rising = false;
        for (k, slice) in buf.chunks(FRAG_FRAMES * 2).enumerate() {
            let peak = slice.iter().fold(0f32, |m, v| m.max(v.abs()));
            loudest = loudest.max(peak);
            if thr > 0.0 && peak > thr {
                let t_s = t_ns + ((k * FRAG_FRAMES) as f64 * ns_per_frame) as i64;
                let t_e = t_s + ((slice.len() / 2) as f64 * ns_per_frame) as i64;
                let last = self.last_above_ns.load(Ordering::Relaxed);
                if last == 0 || t_s - last > RUN_GAP_NS {
                    self.run_start_ns.store(t_s, Ordering::Relaxed);
                    rising = true;
                }
                self.last_above_ns.store(t_e, Ordering::Release);
                if self.counts.load(Ordering::Relaxed) {
                    shared.last_counted_above_ns.fetch_max(t_e, Ordering::AcqRel);
                }
            }
        }
        let db = if loudest > 1e-9 {
            20.0 * loudest.log10()
        } else {
            -100.0
        };
        self.peak_db.store(db.to_bits(), Ordering::Relaxed);
        let len_ns = ((buf.len() / 2) as f64 * ns_per_frame) as i64;
        let last = self.last_above_ns.load(Ordering::Relaxed);
        let prev_end = self.buf_end_ns.swap(t_ns + len_ns, Ordering::AcqRel);
        // silence proven for a run gap after the last audible slice: the runtime's unmute
        // (delay 0) needn't wait for a timer that allows for a whole quantum more
        let quiet_edge = last != 0
            && prev_end - last < RUN_GAP_NS
            && t_ns + len_ns - last >= RUN_GAP_NS;
        self.last_buf_ns.store(t_ns, Ordering::Release);
        self.buf_ns.store(len_ns, Ordering::Relaxed);
        self.buffers.fetch_add(1, Ordering::Relaxed);
        if (rising || quiet_edge) && self.counts.load(Ordering::Relaxed) {
            if rising {
                shared.audible_edges.fetch_add(1, Ordering::Relaxed);
            }
            if let Some(w) = shared.wake.get() {
                w();
            }
        }
    }

    /// In an audible run as of `now_ns` (its last audible slice within `live_ns`).
    pub fn audible_at(&self, now_ns: i64, live_ns: i64) -> bool {
        let last = self.last_above_ns.load(Ordering::Acquire);
        last != 0 && now_ns - last <= live_ns
    }
}

/// What the runtime's wake looks like (a calloop ping).
pub type Wake = Arc<dyn Fn() + Send + Sync>;

/// One stream as the probe and the auto-mute see it.
#[derive(Clone)]
pub struct StreamEntry {
    pub props: StreamProps,
    pub identity: Identity,
    pub verdict: Verdict,
    pub volume: StreamVolume,
    /// MPRIS mode: the Playing player it belongs to and how (`None` = none / mode off).
    pub mpris: Option<(String, &'static str)>,
    pub counts: bool,
    pub tap: Arc<Tap>,
}

/// The MPRIS players as `crate::signal::mpris` reads them (shared; `version` bumps per change).
#[derive(Default)]
pub struct MprisFeed {
    pub version: AtomicU64,
    pub state: Mutex<MprisState>,
}

#[derive(Default, Clone)]
pub struct MprisState {
    /// `None` = not read yet, `Some(false)` = no session bus (MPRIS mode then never mutes).
    pub available: Option<bool>,
    pub reason: Option<String>,
    pub players: Vec<MprisPlayer>,
    pub refreshes: u64,
}

struct Shared {
    quit: AtomicBool,
    /// A scene wants the visualiser frame (else the per-sample ring isn't filled).
    visual: AtomicBool,
    streams: Mutex<BTreeMap<u32, StreamEntry>>,
    error: Mutex<Option<String>>,
    connected: AtomicBool,
    threshold_bits: AtomicU32,
    wake: OnceLock<Wake>,
    last_counted_above_ns: AtomicI64,
    audible_edges: AtomicU64,
    only_mpris: AtomicBool,
    mpris: OnceLock<Arc<MprisFeed>>,
    worker_pids: Mutex<BTreeSet<u32>>,
    /// Bumped by a setter whose change needs a re-classification on `lia-sysmon`.
    config_version: AtomicU64,
    /// Bumped by every re-classification (the runtime re-reads the streams then).
    version: AtomicU64,
    unmatched: Mutex<Vec<String>>,
}

impl Shared {
    fn new() -> Shared {
        Shared {
            quit: AtomicBool::new(false),
            visual: AtomicBool::new(true),
            streams: Mutex::new(BTreeMap::new()),
            error: Mutex::new(None),
            connected: AtomicBool::new(false),
            threshold_bits: AtomicU32::new(db_lin(-70.0).to_bits()),
            wake: OnceLock::new(),
            last_counted_above_ns: AtomicI64::new(0),
            audible_edges: AtomicU64::new(0),
            only_mpris: AtomicBool::new(false),
            mpris: OnceLock::new(),
            worker_pids: Mutex::new(BTreeSet::new()),
            config_version: AtomicU64::new(0),
            version: AtomicU64::new(0),
            unmatched: Mutex::new(Vec::new()),
        }
    }
}

/// The running capture (see the module doc). Dropping it stops the thread and every stream.
pub struct SysMon {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl SysMon {
    /// Start the capture thread; never blocks (the connection is made on the thread).
    pub fn start() -> SysMon {
        let shared = Arc::new(Shared::new());
        let sh = shared.clone();
        let thread = std::thread::Builder::new()
            .name("lia-sysmon".into())
            .spawn(move || run(&sh))
            .ok();
        log::event(
            "audio",
            Level::Info,
            "audio.visualiser.started",
            None,
            json!({}),
        );
        SysMon { shared, thread }
    }

    /// The latest visualiser frame: the mix of every live stream's last [`FRAME`] samples.
    pub fn frame(&self) -> Vec<u8> {
        let now = Instant::now();
        let taps: Vec<Arc<Tap>> = self
            .shared
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|e| e.tap.clone())
            .collect();
        let live: Vec<VecDeque<f32>> = taps
            .iter()
            .filter_map(|t| {
                let r = t.ring.lock().unwrap_or_else(|e| e.into_inner());
                r.last
                    .filter(|l| now.duration_since(*l) <= STALE)
                    .map(|_| r.samples.clone())
            })
            .collect();
        mix_frame(live.iter())
    }

    /// Every captured stream with its verdict (auto-mute; the `automute` probe).
    pub fn streams(&self) -> Vec<StreamEntry> {
        self.shared
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    /// Whether a scene reads [`SysMon::frame`] (the auto-mute alone needs no sample ring).
    pub fn set_visual(&self, on: bool) {
        self.shared.visual.store(on, Ordering::Relaxed);
    }

    /// The runtime's wake for a counted stream's audible edge (set once; later calls no-op).
    pub fn set_wake(&self, w: Wake) {
        let _ = self.shared.wake.set(w);
    }

    pub fn set_threshold_db(&self, db: f64) {
        self.shared
            .threshold_bits
            .store(db_lin(db).to_bits(), Ordering::Relaxed);
    }

    /// MPRIS mode on/off (re-classifies every stream). The feed is attached once.
    pub fn set_only_mpris(&self, on: bool, feed: Option<Arc<MprisFeed>>) {
        if let Some(f) = feed
            && self.shared.mpris.set(f).is_ok()
        {
            self.shared.config_version.fetch_add(1, Ordering::SeqCst);
        }
        if self.shared.only_mpris.swap(on, Ordering::SeqCst) != on {
            self.shared.config_version.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The scene workers' pids (also caught as the player's descendants).
    pub fn set_worker_pids(&self, pids: BTreeSet<u32>) {
        let mut g = self
            .shared
            .worker_pids
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *g != pids {
            *g = pids;
            self.shared.config_version.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// CLOCK_MONOTONIC ns of the end of the newest audible slice of any counting stream.
    pub fn last_counted_above_ns(&self) -> i64 {
        self.shared.last_counted_above_ns.load(Ordering::Acquire)
    }

    /// Counted rising edges so far (each one woke the runtime).
    pub fn edges(&self) -> u64 {
        self.shared.audible_edges.load(Ordering::Relaxed)
    }

    /// Re-classification count (the runtime re-reads [`SysMon::streams`] when it moves).
    pub fn version(&self) -> u64 {
        self.shared.version.load(Ordering::Acquire)
    }

    /// Connected to PipeWire with the registry read.
    pub fn connected(&self) -> bool {
        self.shared.connected.load(Ordering::Acquire)
    }

    /// Playing MPRIS players with no matched stream (`mpris.unmatched:<identity>`).
    pub fn mpris_unmatched(&self) -> Vec<String> {
        self.shared
            .unmatched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn error(&self) -> Option<String> {
        self.shared
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// For probes: the streams in the mix and the last connection error.
    pub fn status(&self) -> Value {
        let streams = self
            .streams()
            .iter()
            .map(|s| json!({"id": s.props.id, "node_name": s.props.node_name, "app": s.props.app_name}))
            .collect::<Vec<_>>();
        json!({
            "streams": streams,
            "error": self.error(),
        })
    }
}

impl Drop for SysMon {
    fn drop(&mut self) {
        self.shared.quit.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        log::event(
            "audio",
            Level::Info,
            "audio.visualiser.stopped",
            None,
            json!({}),
        );
    }
}

fn run(shared: &Arc<Shared>) {
    pw::init();
    while !shared.quit.load(Ordering::SeqCst) {
        if let Err(e) = session(shared) {
            *shared.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
            log::event(
                "audio",
                Level::Warn,
                "audio.visualiser.error",
                None,
                json!({ "reason": e }),
            );
        }
        shared.connected.store(false, Ordering::Release);
        shared
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        shared.version.fetch_add(1, Ordering::AcqRel);
        let end = Instant::now() + RETRY;
        while Instant::now() < end && !shared.quit.load(Ordering::SeqCst) {
            std::thread::sleep(TICK);
        }
    }
}

#[derive(Default)]
struct Pending {
    added: Vec<(StreamProps, u32)>,
    /// A Client global (its registry props are a subset: the full ones come with its info).
    clients: Vec<(u32, ClientProps, u32)>,
    client_info: Vec<(u32, ClientProps)>,
    /// A bound stream node's full props (the registry's are a subset — no pid, no
    /// `node.virtual`, no `target.object` there).
    node_info: Vec<(u32, StreamProps)>,
    links: Vec<(u32, u32, u32)>,
    bus: Option<(u32, Option<u64>)>,
    removed: Vec<u32>,
    volumes: Vec<(u32, StreamVolume)>,
    core_error: Option<String>,
    synced: bool,
}

/// The `Props` param → mute + channel volumes.
fn parse_props(pod: &spa::pod::Pod) -> Option<StreamVolume> {
    use spa::pod::deserialize::PodDeserializer;
    use spa::pod::{Value as PV, ValueArray};
    let (_, v) = PodDeserializer::deserialize_any_from(pod.as_bytes()).ok()?;
    let PV::Object(obj) = v else { return None };
    let mut out = StreamVolume::default();
    for p in obj.properties {
        if p.key == spa::sys::SPA_PROP_mute {
            if let PV::Bool(b) = p.value {
                out.mute = Some(b);
            }
        } else if p.key == spa::sys::SPA_PROP_volume {
            if let PV::Float(v) = p.value {
                out.volume = Some(v);
            }
        } else if p.key == spa::sys::SPA_PROP_channelVolumes
            && let PV::ValueArray(ValueArray::Float(v)) = p.value
        {
            out.channel_volumes = v;
        }
    }
    Some(out)
}

fn stream_props(id: u32, props: &spa::utils::dict::DictRef) -> StreamProps {
    let s = |k: &str| props.get(k).unwrap_or("").to_string();
    StreamProps {
        id,
        serial: props.get("object.serial").and_then(|v| v.parse().ok()),
        node_name: s("node.name"),
        app_name: s("application.name"),
        binary: s("application.process.binary"),
        media_class: s("media.class"),
        virtual_node: props.get("node.virtual") == Some("true"),
        media_name: s("media.name"),
        media_role: s("media.role"),
        client_id: props.get("client.id").and_then(|v| v.parse().ok()),
        pid: props
            .get(identity_pid_keys()[0])
            .and_then(|v| v.parse().ok()),
        target: props
            .get("target.object")
            .or(props.get("node.target"))
            .unwrap_or("")
            .to_string(),
        portal_app_id: props
            .get("pipewire.access.portal.app_id")
            .map(str::to_string),
    }
}

fn client_props(props: &spa::utils::dict::DictRef) -> ClientProps {
    let s = |k: &str| props.get(k).unwrap_or("").to_string();
    ClientProps {
        pid: props
            .get(identity_pid_keys()[0])
            .and_then(|v| v.parse().ok()),
        binary: s("application.process.binary"),
        app_name: s("application.name"),
        portal_app_id: props
            .get("pipewire.access.portal.app_id")
            .or(props.get("flatpak.app-id"))
            .map(str::to_string),
    }
}

/// Merge a bound node's full props over what the registry said (a missing field keeps the old).
fn merge_props(old: &StreamProps, new: StreamProps) -> StreamProps {
    let keep = |a: String, b: &String| if a.is_empty() { b.clone() } else { a };
    StreamProps {
        id: old.id,
        serial: new.serial.or(old.serial),
        node_name: keep(new.node_name, &old.node_name),
        app_name: keep(new.app_name, &old.app_name),
        binary: keep(new.binary, &old.binary),
        media_class: keep(new.media_class, &old.media_class),
        virtual_node: new.virtual_node || old.virtual_node,
        media_name: keep(new.media_name, &old.media_name),
        media_role: keep(new.media_role, &old.media_role),
        client_id: new.client_id.or(old.client_id),
        pid: new.pid.or(old.pid),
        target: keep(new.target, &old.target),
        portal_app_id: new.portal_app_id.or(old.portal_app_id.clone()),
    }
}

fn merge_client(old: Option<&ClientProps>, new: ClientProps) -> ClientProps {
    let Some(old) = old else { return new };
    let keep = |a: String, b: &String| if a.is_empty() { b.clone() } else { a };
    ClientProps {
        pid: new.pid.or(old.pid),
        binary: keep(new.binary, &old.binary),
        app_name: keep(new.app_name, &old.app_name),
        portal_app_id: new.portal_app_id.or(old.portal_app_id.clone()),
    }
}

/// A live capture: the stream, its listener and the bound node proxy (Props) — kept alive.
#[allow(dead_code)]
struct Live {
    stream: StreamRc,
    listener: StreamListener<()>,
    node: Option<(pw::node::Node, pw::node::NodeListener)>,
}

/// One connection: watch the registry, keep one capture per admitted playback stream.
fn session(shared: &Arc<Shared>) -> Result<(), String> {
    let ml = MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
    let context = ContextRc::new(&ml, Some(properties! { "application.name" => APP_NAME }))
        .map_err(|e| format!("PipeWire context: {e}"))?;
    let core = context
        .connect_rc(None)
        .map_err(|e| format!("can't connect to PipeWire ({e})"))?;
    *shared.error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let pending = Rc::new(RefCell::new(Pending::default()));
    let _core_l = core
        .add_listener_local()
        .error({
            let p = pending.clone();
            move |id, _seq, res, msg| {
                if id == pw::core::PW_ID_CORE {
                    p.borrow_mut().core_error = Some(format!("{msg} ({res})"));
                }
            }
        })
        .done({
            let p = pending.clone();
            move |id, _seq| {
                if id == pw::core::PW_ID_CORE {
                    p.borrow_mut().synced = true;
                }
            }
        })
        .register();
    let registry = core
        .get_registry_rc()
        .map_err(|e| format!("PipeWire registry: {e}"))?;
    let _reg_l = registry
        .add_listener_local()
        .global({
            let p = pending.clone();
            move |g| {
                let Some(props) = g.props else { return };
                match g.type_ {
                    ObjectType::Node => {
                        let sp = stream_props(g.id, props);
                        if sp.media_class == "Audio/Sink" && sp.node_name == SINK_NAME {
                            p.borrow_mut().bus = Some((g.id, sp.serial));
                        }
                        if admit(&sp) {
                            p.borrow_mut().added.push((sp, g.version));
                        }
                    }
                    ObjectType::Client => {
                        p.borrow_mut()
                            .clients
                            .push((g.id, client_props(props), g.version));
                    }
                    ObjectType::Link => {
                        let n = |k: &str| props.get(k).and_then(|v| v.parse::<u32>().ok());
                        if let (Some(o), Some(i)) = (n("link.output.node"), n("link.input.node"))
                        {
                            p.borrow_mut().links.push((g.id, o, i));
                        }
                    }
                    _ => {}
                }
            }
        })
        .global_remove({
            let p = pending.clone();
            move |id| {
                // an object added and removed within one batch never existed for us (removals
                // are applied first, so they must only name objects from earlier batches)
                let mut p = p.borrow_mut();
                p.added.retain(|(sp, _)| sp.id != id);
                p.clients.retain(|(c, _, _)| *c != id);
                p.client_info.retain(|(c, _)| *c != id);
                p.node_info.retain(|(n, _)| *n != id);
                p.links.retain(|(l, _, _)| *l != id);
                p.volumes.retain(|(n, _)| *n != id);
                if p.bus.is_some_and(|(b, _)| b == id) {
                    p.bus = None;
                }
                p.removed.push(id);
            }
        })
        .register();
    core.sync(0)
        .map_err(|e| format!("PipeWire sync: {e}"))?;

    let mut live: BTreeMap<u32, Live> = BTreeMap::new();
    let mut clients: BTreeMap<u32, ClientProps> = BTreeMap::new();
    #[allow(clippy::type_complexity)]
    let mut client_proxies: BTreeMap<u32, (pw::client::Client, pw::client::ClientListener)> =
        BTreeMap::new();
    let mut links: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
    let mut volumes: BTreeMap<u32, StreamVolume> = BTreeMap::new();
    let mut bus: Option<(u32, Option<u64>)> = None;
    // whose full props arrived (or can't: a bind that failed)
    let mut nodes_read: BTreeSet<u32> = BTreeSet::new();
    let mut clients_read: BTreeSet<u32> = BTreeSet::new();
    let mut seen_config = u64::MAX;
    let mut seen_mpris = u64::MAX;
    let player_pid = std::process::id();
    while !shared.quit.load(Ordering::SeqCst) {
        ml.loop_().iterate(pw::loop_::Timeout::Finite(TICK));
        let p = std::mem::take(&mut *pending.borrow_mut());
        if let Some(e) = p.core_error {
            return Err(format!("PipeWire connection error: {e}"));
        }
        let mut changed = p.synced
            || !p.clients.is_empty()
            || !p.client_info.is_empty()
            || !p.node_info.is_empty()
            || !p.links.is_empty()
            || !p.volumes.is_empty()
            || p.bus.is_some()
            || !p.added.is_empty()
            || !p.removed.is_empty();
        // Removals first: a global id is reused, and the registry sends an object's removal
        // before the new object with its id — applied after this batch's additions, a removal
        // wiped a new Client's record (measured: a foreign stream that never counted, 3 runs
        // in 10). An object added and removed within the batch was dropped at its removal.
        for id in p.removed {
            clients.remove(&id);
            client_proxies.remove(&id);
            clients_read.remove(&id);
            nodes_read.remove(&id);
            links.remove(&id);
            volumes.remove(&id);
            if bus.is_some_and(|(b, _)| b == id) {
                bus = None;
            }
            if live.remove(&id).is_some() {
                let gone = shared
                    .streams
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                if let Some(e) = gone {
                    log::event(
                        "audio",
                        Level::Debug,
                        "audio.visualiser.stream_gone",
                        None,
                        json!({"id": id, "buffers": e.tap.buffers(), "counts": e.counts,
                               "verdict": e.verdict.as_str(),
                               "audible_seen": e.tap.last_above_ns.load(Ordering::Relaxed) != 0}),
                    );
                }
            }
        }
        if let Some(b) = p.bus {
            bus = Some(b);
        }
        for (id, cp, version) in p.clients {
            let merged = merge_client(clients.get(&id), cp);
            clients.insert(id, merged);
            let g = GlobalObject::<&spa::utils::dict::DictRef> {
                id,
                permissions: pw::permissions::PermissionFlags::R,
                type_: ObjectType::Client,
                version,
                props: None,
            };
            let Ok(c) = registry.bind::<pw::client::Client, _>(&g) else {
                clients_read.insert(id);
                continue;
            };
            {
                let pp = pending.clone();
                let l = c
                    .add_listener_local()
                    .info(move |info| {
                        if let Some(props) = info.props() {
                            pp.borrow_mut().client_info.push((id, client_props(props)));
                        }
                    })
                    .register();
                client_proxies.insert(id, (c, l));
            }
        }
        for (id, cp) in p.client_info {
            clients_read.insert(id);
            let merged = merge_client(clients.get(&id), cp);
            clients.insert(id, merged);
        }
        for (id, o, i) in p.links {
            links.insert(id, (o, i));
        }
        for (id, v) in p.volumes {
            volumes.insert(id, v);
        }
        for (sp, version) in p.added {
            if live.contains_key(&sp.id) {
                continue;
            }
            let tap = Arc::new(Tap::default());
            match tap_stream(&core, &sp, tap.clone(), shared) {
                Ok((stream, listener)) => {
                    // the node's Props (mute, channelVolumes), live
                    let g = GlobalObject::<&spa::utils::dict::DictRef> {
                        id: sp.id,
                        permissions: pw::permissions::PermissionFlags::R,
                        type_: ObjectType::Node,
                        version,
                        props: None,
                    };
                    let node = registry.bind::<pw::node::Node, _>(&g).ok().map(|n| {
                        let pp = pending.clone();
                        let id = sp.id;
                        let pi = pending.clone();
                        let l = n
                            .add_listener_local()
                            .info(move |info| {
                                if let Some(props) = info.props() {
                                    pi.borrow_mut().node_info.push((id, stream_props(id, props)));
                                }
                            })
                            .param(move |_, ty, _, _, pod| {
                                if ty == spa::param::ParamType::Props
                                    && let Some(v) = pod.and_then(parse_props)
                                {
                                    pp.borrow_mut().volumes.push((id, v));
                                }
                            })
                            .register();
                        n.subscribe_params(&[spa::param::ParamType::Props]);
                        (n, l)
                    });
                    if node.is_none() {
                        nodes_read.insert(sp.id);
                    }
                    log::event(
                        "audio",
                        Level::Debug,
                        "audio.visualiser.stream",
                        None,
                        json!({"id": sp.id, "node_name": sp.node_name, "app": sp.app_name}),
                    );
                    shared
                        .streams
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(
                            sp.id,
                            StreamEntry {
                                props: sp.clone(),
                                identity: Identity::default(),
                                verdict: Verdict::Foreign,
                                volume: StreamVolume::default(),
                                mpris: None,
                                counts: false,
                                tap,
                            },
                        );
                    live.insert(
                        sp.id,
                        Live {
                            stream,
                            listener,
                            node,
                        },
                    );
                }
                Err(e) => log::event(
                    "audio",
                    Level::Warn,
                    "audio.visualiser.stream_failed",
                    None,
                    json!({"id": sp.id, "node_name": sp.node_name, "reason": e}),
                ),
            }
        }
        for (id, full) in p.node_info {
            nodes_read.insert(id);
            let mut streams = shared.streams.lock().unwrap_or_else(|e| e.into_inner());
            let Some(e) = streams.get_mut(&id) else {
                continue;
            };
            e.props = merge_props(&e.props, full);
            if !admit(&e.props) {
                // a loopback half after all (`node.virtual` is only in the full props)
                streams.remove(&id);
                drop(streams);
                live.remove(&id);
            }
        }
        if p.synced {
            shared.connected.store(true, Ordering::Release);
        }
        let cv = shared.config_version.load(Ordering::SeqCst);
        if cv != seen_config {
            seen_config = cv;
            changed = true;
        }
        let mv = shared
            .mpris
            .get()
            .map_or(0, |f| f.version.load(Ordering::SeqCst));
        if mv != seen_mpris {
            seen_mpris = mv;
            changed = true;
        }
        if changed {
            let own = OwnCtx {
                player_pid,
                worker_pids: shared
                    .worker_pids
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone(),
                bus_name: SINK_NAME.to_string(),
                bus_serial: bus.and_then(|b| b.1),
                bus_node: bus.map(|b| b.0),
            };
            let read = Read {
                nodes: &nodes_read,
                clients: &clients_read,
            };
            reclassify(shared, &own, &clients, &links, &volumes, &read);
        }
    }
    Ok(())
}

/// Whose full props have arrived.
struct Read<'a> {
    nodes: &'a BTreeSet<u32>,
    clients: &'a BTreeSet<u32>,
}

/// Re-decide every stream's verdict / MPRIS owner / `counts`, then wake the runtime (it
/// re-reads: a stream that started counting mid-run, or one that stopped).
fn reclassify(
    shared: &Shared,
    own: &OwnCtx,
    clients: &BTreeMap<u32, ClientProps>,
    links: &BTreeMap<u32, (u32, u32)>,
    volumes: &BTreeMap<u32, StreamVolume>,
    read: &Read<'_>,
) {
    let parent_of = |p: u32| foreign::proc_ppid(p);
    let only_mpris = shared.only_mpris.load(Ordering::SeqCst);
    let players: Vec<MprisPlayer> = shared
        .mpris
        .get()
        .map(|f| {
            f.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .players
                .clone()
        })
        .unwrap_or_default();
    let mut matched: BTreeSet<String> = BTreeSet::new();
    let now = mono_ns();
    {
        let mut streams = shared.streams.lock().unwrap_or_else(|e| e.into_inner());
        for e in streams.values_mut() {
            let client = e.props.client_id.and_then(|c| clients.get(&c));
            e.identity = identity_of(&e.props, client);
            let linked = own
                .bus_node
                .is_some_and(|b| links.values().any(|(o, i)| *o == e.props.id && *i == b));
            let prev_verdict = e.verdict;
            e.verdict = foreign::classify(&e.identity, linked, own, &parent_of);
            e.volume = volumes.get(&e.props.id).cloned().unwrap_or_default();
            e.mpris = if only_mpris && e.verdict.foreign() {
                foreign::playing_owner(&e.identity, &players, &parent_of)
                    .map(|(p, how)| (p.bus_name.clone(), how.as_str()))
            } else {
                None
            };
            if let Some((name, _)) = &e.mpris {
                matched.insert(name.clone());
            }
            let identified = read.nodes.contains(&e.props.id)
                && e.props.client_id.is_none_or(|c| read.clients.contains(&c));
            let counts = counts_now(
                identified,
                e.verdict,
                &e.volume,
                only_mpris,
                e.mpris.is_some(),
            );
            let was = e.tap.counts.swap(counts, Ordering::SeqCst);
            if counts != was || e.verdict != prev_verdict {
                log::event(
                    "audio",
                    Level::Debug,
                    "audio.visualiser.classified",
                    None,
                    json!({"id": e.props.id, "verdict": e.verdict.as_str(), "counts": counts,
                           "identified": identified, "pid": e.identity.pid,
                           "app": e.identity.app_name}),
                );
            }
            if counts && !was && e.tap.audible_at(now, 100_000_000) {
                shared
                    .last_counted_above_ns
                    .fetch_max(e.tap.last_above_ns.load(Ordering::Acquire), Ordering::AcqRel);
            }
            e.counts = counts;
        }
    }
    *shared.unmatched.lock().unwrap_or_else(|e| e.into_inner()) = if only_mpris {
        players
            .iter()
            .filter(|p| p.playing && !matched.contains(&p.bus_name))
            .map(|p| format!("mpris.unmatched:{}", p.identity))
            .collect()
    } else {
        Vec::new()
    };
    shared.version.fetch_add(1, Ordering::AcqRel);
    if let Some(w) = shared.wake.get() {
        w();
    }
}

/// A passive capture of playback stream `sp` (its serial), metered on the RT thread.
fn tap_stream(
    core: &CoreRc,
    sp: &StreamProps,
    tap: Arc<Tap>,
    shared: &Arc<Shared>,
) -> Result<(StreamRc, StreamListener<()>), String> {
    let target = sp
        .serial
        .map(|s| s.to_string())
        .ok_or("the stream has no object.serial")?;
    let name = format!("{NAME_PREFIX}{}", sp.id);
    let stream = StreamRc::new(
        core.clone(),
        &name,
        properties! {
            "media.type" => "Audio",
            "media.category" => "Capture",
            "node.name" => name.as_str(),
            "node.description" => "liascape-player visualiser input",
            "application.name" => APP_NAME,
            "target.object" => target.as_str(),
            "stream.capture.sink" => "false",
            "node.passive" => "true",
            "node.dont-reconnect" => "true",
            "node.dont-fallback" => "true",
            "state.restore-props" => "false",
            "state.restore-target" => "false",
        },
    )
    .map_err(|e| format!("stream {name}: {e}"))?;
    let mut scratch = Vec::with_capacity(METER_SCRATCH_CAP);
    let sh = shared.clone();
    let l = stream
        .add_local_listener_with_user_data(())
        .process(move |st, _| {
            let thr = f32::from_bits(sh.threshold_bits.load(Ordering::Relaxed));
            read_capture(st, &mut scratch, 2, |buf, t| tap.feed(buf, t, thr, &sh));
        })
        .register()
        .map_err(|e| format!("stream listener: {e}"))?;
    connect_with(
        &stream,
        spa::utils::Direction::Input,
        StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
    )?;
    Ok((stream, l))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(class: &str, virt: bool) -> StreamProps {
        StreamProps {
            id: 1,
            serial: Some(10),
            node_name: "x".into(),
            app_name: "app".into(),
            binary: "app".into(),
            media_class: class.into(),
            virtual_node: virt,
            ..StreamProps::default()
        }
    }

    #[test]
    fn admit_takes_app_playback_streams_only() {
        assert!(admit(&props("Stream/Output/Audio", false)));
        assert!(
            !admit(&props("Stream/Output/Audio", true)),
            "a loopback half"
        );
        assert!(!admit(&props("Stream/Input/Audio", false)), "a capture");
        assert!(!admit(&props("Audio/Sink", false)), "a device");
    }

    #[test]
    fn mix_frame_sums_streams_at_their_newest_sample() {
        assert_eq!(mix_frame(std::iter::empty()), vec![128u8; FRAME], "silence");
        let a: VecDeque<f32> = std::iter::repeat_n(0.5, FRAME).collect();
        let b: VecDeque<f32> = std::iter::repeat_n(0.25, 10).collect();
        let f = mix_frame([&a, &b]);
        assert_eq!(f.len(), FRAME);
        assert_eq!(f[0], (128.0f32 + 63.5).round() as u8, "only a");
        assert_eq!(
            f[FRAME - 1],
            (128.0f32 + 127.0 * 0.75).round() as u8,
            "a + b"
        );
        let loud: VecDeque<f32> = std::iter::repeat_n(0.9, FRAME).collect();
        assert_eq!(mix_frame([&loud, &loud])[0], 255, "clamped");
    }

    #[test]
    fn identity_joins_the_client_for_a_native_node() {
        let mut node = props("Stream/Output/Audio", false);
        node.pid = None;
        node.binary.clear();
        let client = ClientProps {
            pid: Some(4242),
            binary: "mpv".into(),
            app_name: "mpv".into(),
            portal_app_id: None,
        };
        let id = identity_of(&node, Some(&client));
        assert_eq!(id.pid, Some(4242), "the client's application.process.id");
        assert_eq!(id.binary, "mpv");
        assert_eq!(id.app_name, "app", "the node's own name wins");
        node.pid = Some(7);
        assert_eq!(identity_of(&node, Some(&client)).pid, Some(7));
    }

    #[test]
    fn a_stream_counts_only_once_it_is_identified() {
        let vol = StreamVolume::default();
        assert!(counts_now(true, Verdict::Foreign, &vol, false, false));
        assert!(
            !counts_now(false, Verdict::Foreign, &vol, false, false),
            "its pid isn't read yet: it may be ours"
        );
        assert!(!counts_now(true, Verdict::Own("pid"), &vol, false, false));
        let muted = StreamVolume {
            mute: Some(true),
            ..StreamVolume::default()
        };
        assert!(!counts_now(true, Verdict::Foreign, &muted, false, false));
        assert!(!counts_now(true, Verdict::Foreign, &vol, true, false), "no owner");
        assert!(counts_now(true, Verdict::Foreign, &vol, true, true));
    }

    #[test]
    fn pipewire_sec_pid_is_never_read_as_the_process() {
        // a pipewire-pulse client: its `pipewire.sec.pid` is the pulse server's own pid
        let server_only = properties! { "pipewire.sec.pid" => "2014" };
        assert_eq!(client_props(server_only.as_ref()).pid, None);
        assert_eq!(stream_props(1, server_only.as_ref()).pid, None);
        let both = properties! {
            "pipewire.sec.pid" => "2014",
            "application.process.id" => "73002",
        };
        assert_eq!(client_props(both.as_ref()).pid, Some(73002));
        assert_eq!(stream_props(1, both.as_ref()).pid, Some(73002));
    }

    #[test]
    fn tap_meters_slices_and_runs() {
        let sh = Shared::new();
        let woke = Arc::new(AtomicU64::new(0));
        let w2 = woke.clone();
        let _ = sh.wake.set(Arc::new(move || {
            w2.fetch_add(1, Ordering::SeqCst);
        }));
        let tap = Tap::default();
        tap.counts.store(true, Ordering::SeqCst);
        let thr = db_lin(-70.0);
        // a quantum of silence, then one sample above the threshold in the third 10 ms slice
        let mut buf = vec![0f32; 1024 * 2];
        tap.feed(&buf, 1_000_000_000, thr, &sh);
        assert_eq!(tap.run_start_ns.load(Ordering::SeqCst), 0);
        assert_eq!(woke.load(Ordering::SeqCst), 0);
        buf[2 * 962] = 0.01; // −40 dBFS at frame 962: slice 2 (frames 960–1023)
        tap.feed(&buf, 2_000_000_000, thr, &sh);
        let start = tap.run_start_ns.load(Ordering::SeqCst);
        assert_eq!(start, 2_000_000_000 + 20_000_000, "the slice's start");
        assert_eq!(woke.load(Ordering::SeqCst), 1, "a counted rising edge wakes");
        assert!(sh.last_counted_above_ns.load(Ordering::SeqCst) > start);
        // the next buffer, contiguous: the same run, no second wake
        let loud = vec![0.5f32; 1024 * 2];
        tap.feed(&loud, 2_000_000_000 + 21_333_333, thr, &sh);
        assert_eq!(tap.run_start_ns.load(Ordering::SeqCst), start);
        assert_eq!(woke.load(Ordering::SeqCst), 1);
        // a gap > RUN_GAP_NS: a new run
        tap.feed(&loud, 2_200_000_000, thr, &sh);
        assert_eq!(tap.run_start_ns.load(Ordering::SeqCst), 2_200_000_000);
        assert_eq!(woke.load(Ordering::SeqCst), 2);
        assert!((tap.peak_db() - (-6.02)).abs() < 0.1);
        // below the threshold: no run; a stream that doesn't count never wakes
        let t2 = Tap::default();
        t2.feed(&vec![db_lin(-75.0); 2048], 5, thr, &sh);
        assert_eq!(t2.last_above_ns.load(Ordering::SeqCst), 0);
        let t3 = Tap::default();
        t3.feed(&loud, 9_000_000_000, thr, &sh);
        assert_eq!(woke.load(Ordering::SeqCst), 2);
        assert!(t3.last_above_ns.load(Ordering::SeqCst) > 0, "metered anyway");
    }
}
