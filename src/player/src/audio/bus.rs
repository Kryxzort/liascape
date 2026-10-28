//! The player audio bus (spec §5.3 "(my call) Player audio bus"; Task 14). One in-process
//! PipeWire loopback (`libpipewire-module-loopback`) owned by the player: a virtual sink,
//! `lp-player-bus`, that every wallpaper stream plays into, forwarded at 0 dB to the user's
//! current default sink (so chains such as EasyEffects keep working) and re-targeted when
//! the default changes.
//!
//! ```text
//!  mpv (src1) ─┐                 ┌─ lp-player-bus.playback ──▶ default sink (EasyEffects…)
//!  mpv (src2) ─┼─▶ lp-player-bus ┤   (Stream/Output/Audio, node.target = default,
//!     …       ─┘   (Audio/Sink)  │    re-targeted on default.audio.sink changes)
//!                                └─ monitor ──▶ lp-player-bus.meter (the Meter)
//! ```
//!
//! **Identity contract (auto-mute relies on it verbatim, Task 17):** the playback stream is
//! `node.name = lp-player-bus.playback`, `application.name = lp-player`, `media.role =
//! Wallpaper`; the sink is `node.name = lp-player-bus`, `node.description = "lp-player bus"`.
//!
//! Everything PipeWire runs on one thread ("lp-bus") with its own main loop + context +
//! core: the module's nodes, the registry/metadata watch, the latency measurement and the
//! meter's capture stream (none of which use `RT_PROCESS`, so every callback runs on that
//! one thread — capture buffers carry their own cycle time, `pw_buffer.time`). The rest of
//! the player only sees [`Bus`] (state behind a mutex) and [`super::Meter`].
//!
//! **Latency** ([`Bus::latency`]): measured once at creation with an impulse — a probe
//! stream plays one −60 dBFS sample into the bus while two captures watch the bus monitor
//! (the loopback's input) and the bus playback stream's output; the difference of the two
//! arrival times (same graph cycles, so same clock) is what the bus adds. Three shots, the
//! median is kept. The quantum is pinned to 10 ms for it (`node.latency = 480/48000`, the
//! meter's request, which holds while the player runs).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CString, c_char, c_void};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::context::ContextRc;
use pw::core::CoreRc;
use pw::main_loop::MainLoopRc;
use pw::metadata::{Metadata, MetadataListener};
use pw::properties::properties;
use pw::registry::RegistryWeak;
use pw::spa;
use pw::stream::{StreamFlags, StreamListener, StreamRc, StreamState};
use pw::types::ObjectType;
use serde::Serialize;
use serde_json::json;

use super::meter::{MeterRt, MeterShared, mono_ns};
use crate::log::{self, Level};

/// The bus sink's `node.name` (identity contract).
pub const SINK_NAME: &str = "lp-player-bus";
/// The bus sink's `node.description` (identity contract).
pub const SINK_DESCRIPTION: &str = "lp-player bus";
/// The loopback playback stream's `node.name` (identity contract).
pub const PLAYBACK_NAME: &str = "lp-player-bus.playback";
/// `application.name` of every lp-player bus stream (identity contract).
pub const APP_NAME: &str = "lp-player";
/// `media.role` of the bus playback stream (identity contract).
pub const MEDIA_ROLE: &str = "Wallpaper";
/// The meter's capture stream.
pub const METER_NAME: &str = "lp-player-bus.meter";
/// mpv `audio-device` that plays into the bus (`ao=pipewire`).
pub const DEVICE: &str = "pipewire/lp-player-bus";
/// The bus format: 48 kHz, F32, stereo.
pub const RATE: u32 = 48_000;
/// The latency probes' quantum request: 10 ms. The meter no longer requests one (R68 fix
/// round) — this is kept only for `measure_latency`'s transient streams.
pub const QUANTUM: u32 = 480;
/// PipeWire's own default max quantum (`default.clock.max-quantum`), in frames. Since the
/// meter's capture no longer pins `node.latency` (R68), the graph it runs on can grow up to
/// this before the meter's RT scratch buffer, sized for it below, would need to.
const MAX_QUANTUM_FRAMES: usize = 8192;
/// The meter capture is always stereo (FL/FR, [`RATE`]'s format): one scratch slot per
/// interleaved sample, sized for [`MAX_QUANTUM_FRAMES`] so `Watch::start_meter`'s scratch
/// never reallocates inside the RT process callback.
pub(crate) const METER_SCRATCH_CAP: usize = MAX_QUANTUM_FRAMES * 2;

/// `Bus::create` gives up after this long without a linked loopback.
const CREATE_TIMEOUT: Duration = Duration::from_secs(5);
/// `Bus::create` returns `Err` if setup (roundtrips, link, latency) takes longer.
const SETUP_LIMIT: Duration = Duration::from_secs(10);
/// A retarget that hasn't linked the new sink by then is reported failed.
const RETARGET_TIMEOUT: Duration = Duration::from_secs(3);
/// Latency impulse amplitude (one sample per channel; −60 dBFS — inaudible).
const IMPULSE: f32 = 1.0e-3;
/// Anything above this in an otherwise digitally silent bus is the impulse.
const IMPULSE_SEEN: f32 = 1.0e-6;
/// The bus thread wakes at least this often (commands, retarget timeouts, quit).
const TICK: Duration = Duration::from_millis(10);
/// I7 (final review): after the PipeWire connection is lost the bus is re-created —
/// first after this, then doubling up to [`RECONNECT_MAX`] while attempts keep failing.
const RECONNECT_INITIAL: Duration = Duration::from_millis(500);
const RECONNECT_MAX: Duration = Duration::from_secs(10);

/// `Bus::state()` (events `audio.bus.up` / `.retargeting` / `.down`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BusState {
    Up,
    Retargeting,
    Down,
}

/// What the `bus` probe shows.
#[derive(Debug, Clone, Serialize)]
pub struct BusInfo {
    pub state: BusState,
    pub device: String,
    /// What the bus adds (impulse-measured at creation; 0 if unmeasured).
    pub latency_ms: f64,
    pub latency_samples: u64,
    /// The graph quantum during the measurement, ms.
    pub quantum_ms: f64,
    /// The sink the bus playback is linked to now.
    pub target: Option<String>,
    /// PipeWire's `default.audio.sink`.
    pub default_sink: Option<String>,
    pub playback_node: Option<u32>,
    pub sink_node: Option<u32>,
    pub retargets: u64,
    /// The sink the bus last asked for (creation default, then each retarget).
    pub requested: Option<String>,
    /// Another client re-pointed the playback away from `requested` (a session policy such
    /// as EasyEffects' "process all output streams"); the bus doesn't fight it.
    pub overridden: bool,
    pub reason: Option<String>,
}

struct Shared {
    info: Mutex<BusInfo>,
    quit: AtomicBool,
    /// I7: bumped every time the bus comes up (1 = created, 2+ = reconnected) — the
    /// runtime re-targets every source's `audio-device` when it moves.
    generation: AtomicU64,
    /// I7: the bus is up (cheap to poll every tick, unlike `info`).
    up: AtomicBool,
}

impl Shared {
    fn update(&self, f: impl FnOnce(&mut BusInfo)) {
        let mut g = self.info.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g);
    }
}

enum Cmd {
    StartMeter(Arc<MeterShared>),
    StopMeter,
}

/// The running bus (see the module doc). Dropping it stops the thread, which unloads the
/// loopback: the sink is gone with the player (a killed player's sink goes with its
/// PipeWire connection).
pub struct Bus {
    shared: Arc<Shared>,
    tx: mpsc::Sender<Cmd>,
    thread: Option<JoinHandle<()>>,
}

impl Bus {
    /// Load the loopback, wait until its playback is linked to the default sink, measure
    /// the latency. Measured ~0.2 s; gives up after [`SETUP_LIMIT`] (the thread stops at
    /// its next wait). `Err(reason)` → the caller falls back to direct streams
    /// (sources keep mpv's default device) and logs `audio.bus.down {reason}`.
    /// `LP_PLAYER_BUS=off` disables it (reason says so).
    pub fn create() -> Result<Bus, String> {
        if std::env::var("LP_PLAYER_BUS").is_ok_and(|v| v == "off") {
            return Err("disabled by LP_PLAYER_BUS=off".into());
        }
        let shared = Arc::new(Shared {
            info: Mutex::new(BusInfo {
                state: BusState::Down,
                device: DEVICE.into(),
                latency_ms: 0.0,
                latency_samples: 0,
                quantum_ms: 0.0,
                target: None,
                default_sink: None,
                playback_node: None,
                sink_node: None,
                retargets: 0,
                requested: None,
                overridden: false,
                reason: Some("starting".into()),
            }),
            quit: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            up: AtomicBool::new(false),
        });
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let sh = shared.clone();
        let thread = std::thread::Builder::new()
            .name("lp-bus".into())
            .spawn(move || {
                let r = run(&sh, rx, &ready_tx);
                if let Err(e) = r {
                    sh.update(|i| {
                        i.state = BusState::Down;
                        i.reason = Some(e.clone());
                    });
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| format!("can't start the PipeWire bus thread: {e}"))?;
        let r = ready_rx
            .recv_timeout(SETUP_LIMIT)
            .unwrap_or_else(|_| Err("PipeWire bus setup timed out".into()));
        let bus = Bus {
            shared,
            tx,
            thread: Some(thread),
        };
        match r {
            Ok(()) => Ok(bus),
            Err(e) => Err(e), // `bus` drops: thread joined
        }
    }

    /// mpv `audio-device` for sources (`ao=pipewire`): [`DEVICE`].
    pub fn device(&self) -> String {
        DEVICE.to_string()
    }

    /// What the bus adds to a stream's path to the speakers (measured at creation).
    pub fn latency(&self) -> Duration {
        Duration::from_secs_f64(self.info().latency_ms.max(0.0) / 1000.0)
    }

    pub fn state(&self) -> BusState {
        self.info().state
    }

    /// I7: `(up, generation)` — cheap; the runtime re-targets sources when it changes
    /// (down → mpv's default device; up again → the bus).
    pub fn route(&self) -> (bool, u64) {
        (
            self.shared.up.load(Ordering::SeqCst),
            self.shared.generation.load(Ordering::SeqCst),
        )
    }

    pub fn info(&self) -> BusInfo {
        self.shared
            .info
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Start the meter's capture stream on the bus thread; the returned closure stops it.
    pub(crate) fn start_meter(&self, m: Arc<MeterShared>) -> Option<Box<dyn FnOnce() + Send>> {
        let tx = self.tx.clone();
        if tx.send(Cmd::StartMeter(m.clone())).is_err() {
            m.set_error("audio bus thread is gone");
            return None;
        }
        Some(Box::new(move || {
            let _ = tx.send(Cmd::StopMeter);
        }))
    }
}

impl Drop for Bus {
    fn drop(&mut self) {
        self.shared.quit.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take()
            && let Err(e) = t.join()
        {
            let msg = panic_message(&e);
            log::event(
                "audio",
                Level::Error,
                "audio.bus.thread_panicked",
                None,
                json!({ "panic": msg }),
            );
            self.shared.update(|i| {
                i.state = BusState::Down;
                i.reason = Some(format!("lp-bus thread panicked: {msg}"));
            });
        }
    }
}

/// The best-effort message out of a `std::thread::Result::Err` panic payload.
fn panic_message(e: &(dyn std::any::Any + Send + 'static)) -> String {
    if let Some(s) = e.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

// ---------------------------------------------------------------- the PipeWire thread

#[derive(Debug, Clone)]
struct NodeRec {
    name: String,
    class: String,
    serial: Option<u64>,
}

/// What the registry + default metadata say (bus thread only).
#[derive(Default)]
struct Seen {
    nodes: HashMap<u32, NodeRec>,
    /// link id → (output node, input node)
    links: HashMap<u32, (u32, u32)>,
    metadata: Option<(Metadata, MetadataListener)>,
    default_sink: Option<String>,
    /// Every `target.object` write in the default metadata, in order (subject, value;
    /// `None` = removed) — whoever wrote it, our own writes included (they echo back).
    meta_events: Vec<(u32, Option<String>)>,
    done_seq: Option<i32>,
    core_error: Option<String>,
    /// Set while `Bus::create` may give up on us: setup waits end as soon as the `Bus`
    /// drops (its `quit`), so a timed-out create never blocks on the join.
    abort: Option<Arc<Shared>>,
}

impl Seen {
    /// Newest node called `name` (highest serial) of media class `class`.
    fn node(&self, name: &str, class: &str) -> Option<u32> {
        self.nodes
            .iter()
            .filter(|(_, n)| n.name == name && n.class == class)
            .max_by_key(|(id, n)| (n.serial.unwrap_or(0), **id))
            .map(|(id, _)| *id)
    }

    fn playback(&self) -> Option<u32> {
        self.node(PLAYBACK_NAME, "Stream/Output/Audio")
    }

    fn sink(&self) -> Option<u32> {
        self.node(SINK_NAME, "Audio/Sink")
    }

    /// Sinks (`Audio/Sink` nodes) the bus playback is linked to, by name. Only sinks: other
    /// clients' captures of the playback (e.g. the legacy AudioMonitor's `parec`) are links
    /// too, and counting them made a relink look like "linked to nothing but parec" — which
    /// re-issued the retarget (found on this machine).
    fn linked_targets(&self, pb: u32) -> Vec<String> {
        let mut v: Vec<String> = self
            .links
            .values()
            .filter(|(o, _)| *o == pb)
            .filter_map(|(_, i)| self.nodes.get(i))
            .filter(|n| n.class == "Audio/Sink")
            .map(|n| n.name.clone())
            .collect();
        v.sort();
        v.dedup();
        v
    }

    fn linked(&self, from: Option<u32>, to: Option<u32>) -> bool {
        let (Some(from), Some(to)) = (from, to) else {
            return false;
        };
        self.links.values().any(|l| *l == (from, to))
    }

    /// The node a `target.object` value names: an `object.serial` (what pavucontrol,
    /// pipewire-pulse, WirePlumber and EasyEffects write) or a `node.name`. Never a global
    /// id — ids and serials overlap (serial 136 = easyeffects_sink while id 136 was the bus
    /// sink: the first version matched either and named the wrong node).
    fn name_of_target(&self, v: &str) -> Option<String> {
        match v.parse::<u64>() {
            Ok(n) => self
                .nodes
                .values()
                .find(|r| r.serial == Some(n))
                .map(|r| r.name.clone()),
            Err(_) => self
                .nodes
                .values()
                .any(|r| r.name == v)
                .then(|| v.to_string()),
        }
    }

    fn sink_by_name(&self, name: &str) -> Option<(u32, Option<u64>)> {
        self.nodes
            .iter()
            .filter(|(_, n)| n.name == name && n.class == "Audio/Sink")
            .max_by_key(|(id, n)| (n.serial.unwrap_or(0), **id))
            .map(|(id, n)| (*id, n.serial))
    }
}

/// `{"name":"…"}` (the `default.audio.sink` metadata value) → the name; the bus itself
/// never counts as a default (it would loop into itself).
fn parse_default(value: Option<&str>) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(value?).ok()?;
    let name = v.get("name")?.as_str()?.to_string();
    (!name.is_empty() && name != SINK_NAME).then_some(name)
}

/// SPA-JSON string literal.
fn spa_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        if c == '"' || c == '\\' {
            o.push('\\');
        }
        o.push(c);
    }
    o.push('"');
    o
}

/// WirePlumber's stream-state hooks key saved volumes/targets by `application.name` — the
/// same key as every mpv source (`audio-client-name=lp-player`). The bus streams opt out of
/// both, so the bus always starts at 0 dB and our own re-targets (metadata `target.object`)
/// are never saved as a "user choice" that WirePlumber would later apply to an mpv stream.
const NO_RESTORE: &str = "state.restore-props = false state.restore-target = false";

/// The module-loopback arguments (brief values verbatim + the identity contract).
fn loopback_args(target: Option<&str>) -> String {
    let target = target
        .map(|t| {
            let t = spa_str(t);
            format!("node.target = {t} target.object = {t}")
        })
        .unwrap_or_default();
    format!(
        "{{ node.description = {desc} audio.position = [ FL FR ] \
           capture.props = {{ media.class = Audio/Sink node.name = {sink} \
             node.description = {desc} audio.position = [ FL FR ] \
             application.name = {app} {nr} }} \
           playback.props = {{ node.name = {pb} node.description = {pbdesc} \
             application.name = {app} media.role = {role} {nr} {target} }} }}",
        desc = spa_str(SINK_DESCRIPTION),
        sink = SINK_NAME,
        app = APP_NAME,
        pb = PLAYBACK_NAME,
        pbdesc = spa_str("lp-player bus (to the default sink)"),
        role = MEDIA_ROLE,
        nr = NO_RESTORE,
    )
}

unsafe extern "C" {
    // libpipewire's in-process module API (pipewire/impl-module.h; not in pipewire-sys's
    // wrapper.h). Linked through pipewire-sys's `-lpipewire-0.3`.
    fn pw_context_load_module(
        context: *mut pw::sys::pw_context,
        name: *const c_char,
        args: *const c_char,
        properties: *mut pw::sys::pw_properties,
    ) -> *mut c_void;
    fn pw_impl_module_destroy(module: *mut c_void);
}

/// The loaded loopback; destroying it removes the sink + playback.
struct Module(*mut c_void);

impl Drop for Module {
    fn drop(&mut self) {
        unsafe { pw_impl_module_destroy(self.0) };
    }
}

/// Iterate the bus loop until `done()` or `deadline` (or a core error).
fn wait_until(
    ml: &MainLoopRc,
    seen: &Rc<RefCell<Seen>>,
    deadline: Instant,
    mut done: impl FnMut(&Seen) -> bool,
) -> Result<(), String> {
    loop {
        {
            let s = seen.borrow();
            if let Some(e) = &s.core_error {
                return Err(format!("PipeWire connection error: {e}"));
            }
            if s.abort
                .as_ref()
                .is_some_and(|sh| sh.quit.load(Ordering::SeqCst))
            {
                return Err("bus dropped during setup".into());
            }
            if done(&s) {
                return Ok(());
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("timed out".into());
        }
        ml.loop_()
            .iterate(pw::loop_::Timeout::Finite((deadline - now).min(TICK)));
    }
}

/// One server roundtrip (everything sent before it has been answered).
fn roundtrip(ml: &MainLoopRc, core: &CoreRc, seen: &Rc<RefCell<Seen>>) -> Result<(), String> {
    let seq = core
        .sync(0)
        .map_err(|e| format!("PipeWire sync: {e}"))?
        .seq();
    wait_until(ml, seen, Instant::now() + Duration::from_secs(3), |s| {
        s.done_seq == Some(seq)
    })
    .map_err(|e| format!("PipeWire roundtrip: {e}"))
}

/// Rate-limits the `audio.meter.scratch_exceeded` warning (T14 residual fix round): at
/// most once per [`SCRATCH_WARN_EVERY`], regardless of which capture stream hit it.
static SCRATCH_WARN_LAST: Mutex<Option<Instant>> = Mutex::new(None);
const SCRATCH_WARN_EVERY: Duration = Duration::from_secs(5);

fn scratch_cap_exceeded(frames: usize, cap_frames: usize) {
    let mut last = SCRATCH_WARN_LAST.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    if last.is_some_and(|t| now.duration_since(t) < SCRATCH_WARN_EVERY) {
        return;
    }
    *last = Some(now);
    drop(last);
    log::event(
        "audio",
        Level::Warn,
        "audio.meter.scratch_exceeded",
        None,
        json!({ "frames": frames, "cap_frames": cap_frames }),
    );
}

/// Splits interleaved F32 `bytes` (one dequeued capture buffer, first frame at `t0_ns`)
/// into pieces of at most `scratch`'s own capacity — **never grown** — each handed to
/// `on_chunk` with its own `t_ns` advanced by its frame offset at [`RATE`], so a buffer
/// bigger than the scratch (a negotiated quantum above PipeWire's default max,
/// [`MAX_QUANTUM_FRAMES`] — T14 residual, found in review) is chunked rather than
/// reallocating the RT callback's scratch, and no frame is dropped, only chunked. The
/// pure half of [`read_capture`]'s chunking — unit-tested without PipeWire. `channels`
/// keeps a chunk boundary frame-aligned.
fn chunk_into(
    bytes: &[u8],
    t0_ns: i64,
    channels: usize,
    scratch: &mut Vec<f32>,
    mut on_chunk: impl FnMut(&[f32], i64),
) {
    let channels = channels.max(1);
    let total_samples = bytes.len() / 4;
    let cap_samples = scratch.capacity().max(channels);
    let step = (cap_samples / channels).max(1) * channels;
    if total_samples > step {
        scratch_cap_exceeded(total_samples / channels, step / channels);
    }
    let ns_per_frame = 1e9 / RATE as f64;
    let mut pos = 0usize;
    loop {
        let n = (total_samples - pos).min(step);
        scratch.clear();
        scratch.extend(
            bytes[pos * 4..(pos + n) * 4]
                .chunks_exact(4)
                .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]])),
        );
        let frame_offset = (pos / channels) as f64;
        on_chunk(scratch, t0_ns + (frame_offset * ns_per_frame) as i64);
        pos += n;
        if pos >= total_samples {
            break;
        }
    }
}

/// Dequeues one capture buffer and hands its interleaved F32 samples to `on_chunk` in
/// pieces of at most `scratch`'s capacity ([`chunk_into`]); `channels` must match the
/// stream's own format (2, here — stereo FL/FR). Returns `false` only when there was no
/// buffer to dequeue (`on_chunk` is never called then).
pub(crate) fn read_capture(
    stream: &pw::stream::Stream,
    scratch: &mut Vec<f32>,
    channels: usize,
    on_chunk: impl FnMut(&[f32], i64),
) -> bool {
    unsafe {
        let b = stream.dequeue_raw_buffer();
        if b.is_null() {
            return false;
        }
        let raw_t = (*b).time as i64;
        let t0 = if raw_t > 0 { raw_t } else { mono_ns() };
        let mut bytes: &[u8] = &[];
        let sb = (*b).buffer;
        if !sb.is_null() && (*sb).n_datas > 0 && !(*sb).datas.is_null() {
            let d = &*(*sb).datas;
            if !d.data.is_null() && !d.chunk.is_null() {
                let c = &*d.chunk;
                let max = d.maxsize as usize;
                let off = (c.offset as usize).min(max);
                let size = (c.size as usize).min(max - off);
                bytes = std::slice::from_raw_parts((d.data as *const u8).add(off), size);
            }
        }
        chunk_into(bytes, t0, channels, scratch, on_chunk);
        stream.queue_raw_buffer(b);
        true
    }
}

/// The `EnumFormat` pod for 48 kHz F32 stereo FL/FR.
fn format_pod() -> Vec<u8> {
    let mut info = spa::param::audio::AudioInfoRaw::new();
    info.set_format(spa::param::audio::AudioFormat::F32LE);
    info.set_rate(RATE);
    info.set_channels(2);
    let mut pos = [0u32; spa::sys::SPA_AUDIO_MAX_CHANNELS as usize];
    pos[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
    pos[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
    info.set_position(pos);
    let obj = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: spa::param::ParamType::EnumFormat.as_raw(),
        properties: info.into(),
    };
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map(|(c, _)| c.into_inner())
    .unwrap_or_default()
}

/// Connect `stream` as 48 kHz F32 stereo FL/FR (`AUTOCONNECT | MAP_BUFFERS`). Public for the
/// scene worker's playback stream (Task 6), which uses the bus's exact format.
pub fn connect(stream: &StreamRc, dir: spa::utils::Direction) -> Result<(), String> {
    connect_with(stream, dir, StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS)
}

/// [`connect`] with explicit stream flags (the scene worker adds `RT_PROCESS`: its process
/// callback must run on PipeWire's real-time data thread — Phase 2 Task 6's stream, Task 10's
/// flake fix).
pub fn connect_with(
    stream: &StreamRc,
    dir: spa::utils::Direction,
    flags: StreamFlags,
) -> Result<(), String> {
    let bytes = format_pod();
    let pod = spa::pod::Pod::from_bytes(&bytes).ok_or("bad format pod")?;
    stream
        .connect(dir, None, flags, &mut [pod])
        .map_err(|e| format!("stream connect: {e}"))
}

fn latency_str() -> String {
    format!("{QUANTUM}/{RATE}")
}

/// A capture stream on `target` (`monitor`: the sink's monitor ports). `latency`, when
/// given, requests that graph quantum (`node.latency`) for this stream. Only the ~1 s
/// startup latency probes pass one; the meter's long-lived capture ([`Watch::start_meter`])
/// passes `None` (the graph default) — a 10 ms request held for as long as the player runs
/// would otherwise pin the *whole* PipeWire graph's quantum to it (R68: the meter must not
/// force the graph quantum).
pub(crate) fn capture_stream(
    core: &CoreRc,
    name: &str,
    target: &str,
    monitor: bool,
    latency: Option<&str>,
) -> Result<StreamRc, String> {
    let mut props = properties! {
        "media.type" => "Audio",
        "media.category" => "Capture",
        "node.name" => name,
        "node.description" => name,
        "application.name" => APP_NAME,
        "target.object" => target,
        "stream.capture.sink" => if monitor { "true" } else { "false" },
        "node.dont-reconnect" => "true",
        "state.restore-props" => "false",
        "state.restore-target" => "false",
    };
    if let Some(l) = latency {
        props.insert("node.latency", l);
    }
    StreamRc::new(core.clone(), name, props).map_err(|e| format!("stream {name}: {e}"))
}

/// The latency shot's shared state (bus thread only — no RT callbacks).
#[derive(Default)]
struct Shot {
    fire: Cell<bool>,
    fired: Cell<bool>,
    /// ns of the impulse's frame in the bus monitor / at the bus playback output.
    at_monitor: Cell<Option<i64>>,
    at_playback: Cell<Option<i64>>,
    frames: Cell<u64>,
    cycles: Cell<u64>,
}

fn find_impulse(samples: &[f32], t_ns: i64) -> Option<i64> {
    let k = samples
        .chunks_exact(2)
        .position(|f| f[0].abs() > IMPULSE_SEEN || f[1].abs() > IMPULSE_SEEN)?;
    Some(t_ns + (k as f64 * 1e9 / RATE as f64) as i64)
}

/// Measure what the bus adds (see the module doc): `(latency ns, quantum frames)`.
fn measure_latency(
    ml: &MainLoopRc,
    core: &CoreRc,
    seen: &Rc<RefCell<Seen>>,
) -> Result<(i64, u64), String> {
    let shot = Rc::new(Shot::default());
    let out = StreamRc::new(
        core.clone(),
        "lp-player-bus.latency-probe",
        properties! {
            "media.type" => "Audio",
            "media.category" => "Playback",
            "node.name" => "lp-player-bus.latency-probe",
            "node.description" => "lp-player bus latency probe",
            "application.name" => APP_NAME,
            "target.object" => SINK_NAME,
            "node.latency" => latency_str(),
            "node.dont-reconnect" => "true",
            "state.restore-props" => "false",
            "state.restore-target" => "false",
        },
    )
    .map_err(|e| format!("latency probe stream: {e}"))?;
    let sh = shot.clone();
    let _out_l = out
        .add_local_listener_with_user_data(())
        .process(move |st, _| unsafe {
            let b = st.dequeue_raw_buffer();
            if b.is_null() {
                return;
            }
            let sb = (*b).buffer;
            if !sb.is_null() && (*sb).n_datas > 0 && !(*sb).datas.is_null() {
                let d = &mut *(*sb).datas;
                if !d.data.is_null() && !d.chunk.is_null() {
                    let stride = 8usize;
                    let max = d.maxsize as usize / stride;
                    let req = (*b).requested as usize;
                    let n = if req > 0 {
                        req.min(max)
                    } else {
                        max.min(QUANTUM as usize)
                    };
                    let bytes = std::slice::from_raw_parts_mut(d.data as *mut u8, n * stride);
                    bytes.fill(0);
                    if n > 0 && sh.fire.replace(false) {
                        bytes[0..4].copy_from_slice(&IMPULSE.to_le_bytes());
                        bytes[4..8].copy_from_slice(&IMPULSE.to_le_bytes());
                        sh.fired.set(true);
                    }
                    let c = &mut *d.chunk;
                    c.offset = 0;
                    c.stride = stride as i32;
                    c.size = (n * stride) as u32;
                }
            }
            st.queue_raw_buffer(b);
        })
        .register()
        .map_err(|e| format!("latency probe listener: {e}"))?;
    connect(&out, spa::utils::Direction::Output)?;

    let mut caps = Vec::new();
    for (name, target, monitor) in [
        ("lp-player-bus.latency-in", SINK_NAME, true),
        ("lp-player-bus.latency-out", PLAYBACK_NAME, false),
    ] {
        let s = capture_stream(core, name, target, monitor, Some(&latency_str()))?;
        let sh = shot.clone();
        let mut scratch = Vec::with_capacity(4096);
        let l = s
            .add_local_listener_with_user_data(())
            .process(move |st, _| {
                read_capture(st, &mut scratch, 2, |buf, t| {
                    if monitor {
                        sh.cycles.set(sh.cycles.get() + 1);
                        sh.frames.set((buf.len() / 2) as u64);
                    }
                    if !sh.fired.get() {
                        return;
                    }
                    let slot = if monitor {
                        &sh.at_monitor
                    } else {
                        &sh.at_playback
                    };
                    if slot.get().is_none()
                        && let Some(at) = find_impulse(buf, t)
                    {
                        slot.set(Some(at));
                    }
                });
            })
            .register()
            .map_err(|e| format!("latency capture listener: {e}"))?;
        connect(&s, spa::utils::Direction::Input)?;
        caps.push((s, l));
    }

    // Both captures wired where they must be — the monitor one to the bus sink, the other
    // to the bus playback's output (else both would see the same signal and read 0) — and
    // running (a few cycles in); then three impulses.
    let wired = |s: &Seen| {
        let cap = |n: &str| s.node(n, "Stream/Input/Audio");
        s.linked(s.sink(), cap("lp-player-bus.latency-in"))
            && s.linked(s.playback(), cap("lp-player-bus.latency-out"))
            && s.linked(
                s.node("lp-player-bus.latency-probe", "Stream/Output/Audio"),
                s.sink(),
            )
    };
    wait_until(ml, seen, Instant::now() + Duration::from_secs(3), |s| {
        wired(s) && shot.cycles.get() >= 20
    })
    .map_err(|e| format!("latency probes never ran wired: {e}"))?;
    let mut shots = Vec::new();
    for _ in 0..3 {
        shot.at_monitor.set(None);
        shot.at_playback.set(None);
        shot.fired.set(false);
        shot.fire.set(true);
        let r = wait_until(ml, seen, Instant::now() + Duration::from_secs(1), |_| {
            shot.at_monitor.get().is_some() && shot.at_playback.get().is_some()
        });
        if r.is_ok()
            && let (Some(a), Some(b)) = (shot.at_monitor.get(), shot.at_playback.get())
        {
            shots.push(b - a);
        }
        // Let the impulse clear before the next one.
        let c = shot.cycles.get();
        let _ = wait_until(
            ml,
            seen,
            Instant::now() + Duration::from_millis(500),
            |_| shot.cycles.get() >= c + 5,
        );
    }
    let quantum = shot.frames.get();
    for (s, _) in &caps {
        let _ = s.disconnect();
    }
    let _ = out.disconnect();
    log::event(
        "audio",
        Level::Debug,
        "audio.bus.latency_shots",
        None,
        json!({ "shots_ms": shots.iter().map(|ns| *ns as f64 / 1e6).collect::<Vec<_>>(),
                "quantum_frames": quantum }),
    );
    if shots.is_empty() {
        return Err("the impulse never came through (bus playback muted?)".into());
    }
    shots.sort_unstable();
    let median = shots[shots.len() / 2];
    if median < 0 {
        return Err(format!(
            "the impulse reached the bus output {} ms before its input",
            -median as f64 / 1e6
        ));
    }
    Ok((median, quantum))
}

/// The bus thread: setup (→ `ready`), then the watch loop until `Bus` drops.
fn run(
    shared: &Arc<Shared>,
    rx: mpsc::Receiver<Cmd>,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    pw::init();
    let mut meter_req: Option<Arc<MeterShared>> = None;
    // The first session's setup failing is `Bus::create`'s error (the caller falls back
    // to direct streams); a connection lost *later* is re-created (I7).
    let mut lost = match session(shared, &rx, Some(ready), &mut meter_req)? {
        End::Quit => return Ok(()),
        End::Lost(reason) => reason,
    };
    let mut delay = RECONNECT_INITIAL;
    let mut attempt = 0u32;
    loop {
        down(shared, &lost);
        if let Some(m) = &meter_req {
            m.set_error("audio bus down");
        }
        loop {
            if wait_or_quit(shared, &rx, &mut meter_req, delay) {
                return Ok(());
            }
            attempt += 1;
            log::event(
                "audio",
                Level::Info,
                "audio.bus.reconnecting",
                None,
                json!({ "attempt": attempt, "after_ms": delay.as_millis() as u64 }),
            );
            match session(shared, &rx, None, &mut meter_req) {
                Ok(End::Quit) => return Ok(()),
                Ok(End::Lost(reason)) => {
                    lost = reason;
                    delay = RECONNECT_INITIAL;
                    attempt = 0;
                    break;
                }
                Err(e) => {
                    if shared.quit.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    shared.update(|i| i.reason = Some(e.clone()));
                    log::event(
                        "audio",
                        Level::Warn,
                        "audio.bus.reconnect_failed",
                        None,
                        json!({ "attempt": attempt, "reason": e }),
                    );
                    delay = (delay * 2).min(RECONNECT_MAX);
                }
            }
        }
    }
}

/// How a bus session ended.
enum End {
    /// The `Bus` dropped (player shutdown): the loopback is unloaded.
    Quit,
    /// The PipeWire connection failed (e.g. the server restarted): re-create it.
    Lost(String),
}

/// I7: sleep `d` (in `TICK`s), still taking meter commands; `true` = quit.
fn wait_or_quit(
    shared: &Shared,
    rx: &mpsc::Receiver<Cmd>,
    meter_req: &mut Option<Arc<MeterShared>>,
    d: Duration,
) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if shared.quit.load(Ordering::SeqCst) {
            return true;
        }
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::StartMeter(m) => {
                    m.set_error("audio bus down");
                    *meter_req = Some(m);
                }
                Cmd::StopMeter => *meter_req = None,
            }
        }
        std::thread::sleep(TICK);
    }
    shared.quit.load(Ordering::SeqCst)
}

/// One bus session: connect, load the loopback, wait for it to link, measure the
/// latency, then watch (retarget, meter commands) until the `Bus` drops or the connection
/// fails. `ready` = the first session (its setup result goes to `Bus::create`).
fn session(
    shared: &Arc<Shared>,
    rx: &mpsc::Receiver<Cmd>,
    ready: Option<&mpsc::Sender<Result<(), String>>>,
    meter_req: &mut Option<Arc<MeterShared>>,
) -> Result<End, String> {
    let ml = MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
    let context = ContextRc::new(
        &ml,
        Some(properties! {
            "application.name" => APP_NAME,
        }),
    )
    .map_err(|e| format!("PipeWire context: {e}"))?;
    let core = context.connect_rc(None).map_err(|e| {
        let dir = std::env::var("PIPEWIRE_RUNTIME_DIR")
            .or_else(|_| std::env::var("XDG_RUNTIME_DIR"))
            .unwrap_or_default();
        format!("can't connect to PipeWire ({e}; runtime dir {dir:?})")
    })?;
    let seen = Rc::new(RefCell::new(Seen {
        abort: Some(shared.clone()),
        ..Seen::default()
    }));

    let _core_l = core
        .add_listener_local()
        .done({
            let seen = seen.clone();
            move |id, seq| {
                if id == pw::core::PW_ID_CORE {
                    seen.borrow_mut().done_seq = Some(seq.seq());
                }
            }
        })
        .error({
            let seen = seen.clone();
            move |id, _seq, res, msg| {
                if id == pw::core::PW_ID_CORE {
                    seen.borrow_mut().core_error = Some(format!("{msg} ({res})"));
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
            let seen = seen.clone();
            let reg: RegistryWeak = registry.downgrade();
            move |g| on_global(&seen, &reg, g)
        })
        .global_remove({
            let seen = seen.clone();
            move |id| {
                let mut s = seen.borrow_mut();
                s.nodes.remove(&id);
                s.links.remove(&id);
            }
        })
        .register();
    roundtrip(&ml, &core, &seen)?; // every global
    roundtrip(&ml, &core, &seen)?; // the default metadata's properties
    let default = seen.borrow().default_sink.clone();

    let args = CString::new(loopback_args(default.as_deref())).map_err(|e| e.to_string())?;
    let module = unsafe {
        pw_context_load_module(
            context.as_raw_ptr(),
            c"libpipewire-module-loopback".as_ptr(),
            args.as_ptr(),
            std::ptr::null_mut(),
        )
    };
    if module.is_null() {
        return Err(format!(
            "PipeWire: can't load libpipewire-module-loopback ({})",
            std::io::Error::last_os_error()
        ));
    }
    let module = Module(module);

    let deadline = Instant::now() + CREATE_TIMEOUT;
    wait_until(&ml, &seen, deadline, |s| {
        s.sink().is_some() && s.playback().is_some_and(|pb| !s.linked_targets(pb).is_empty())
    })
    .map_err(|e| {
        let s = seen.borrow();
        format!(
            "PipeWire: the bus loopback never linked to a sink ({e}; default sink {:?}, sink {:?}, playback {:?})",
            s.default_sink,
            s.sink(),
            s.playback()
        )
    })?;

    let requested = {
        let s = seen.borrow();
        let linked = s
            .playback()
            .map(|pb| s.linked_targets(pb))
            .unwrap_or_default();
        // `node.target` asked for the default; if the playback came up elsewhere (e.g. a
        // stream target restored by the session manager), nothing was requested yet.
        default.clone().filter(|d| linked.contains(d))
    };
    shared.update(|i| i.requested = requested.clone());
    let mut w = Watch {
        shared: shared.clone(),
        requested,
        written: None,
        echoed: false,
        foreign: None,
        override_seen: false,
        retarget: None,
        failed: None,
        meter: None,
    };
    // The playback may have come up linked elsewhere (e.g. a restored stream target):
    // put it on the default before measuring.
    w.step(&seen);
    let until = Instant::now() + RETARGET_TIMEOUT + Duration::from_millis(500);
    while w.retarget.is_some() && Instant::now() < until {
        ml.loop_().iterate(pw::loop_::Timeout::Finite(TICK));
        w.step(&seen);
    }
    let (lat_ns, quantum) = match measure_latency(&ml, &core, &seen) {
        Ok(v) => v,
        Err(e) => {
            log::event(
                "audio",
                Level::Warn,
                "audio.bus.latency_unmeasured",
                None,
                json!({ "reason": e }),
            );
            (0, 0)
        }
    };
    {
        let s = seen.borrow();
        let pb = s.playback();
        let target = pb.and_then(|pb| s.linked_targets(pb).into_iter().next());
        shared.update(|i| {
            i.state = BusState::Up;
            i.reason = None;
            i.latency_ms = lat_ns as f64 / 1e6;
            i.latency_samples = (lat_ns as f64 * RATE as f64 / 1e9).round() as u64;
            i.quantum_ms = quantum as f64 * 1000.0 / RATE as f64;
            i.target = target;
            i.default_sink = s.default_sink.clone();
            i.playback_node = pb;
            i.sink_node = s.sink();
        });
    }
    shared.up.store(true, Ordering::SeqCst);
    let generation = shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
    match ready {
        Some(r) => {
            let _ = r.send(Ok(()));
        }
        None => {
            // I7: re-created after a lost connection.
            let info = shared
                .info
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            log::event(
                "audio",
                Level::Info,
                "audio.bus.up",
                None,
                json!({
                    "device": info.device,
                    "latency_ms": info.latency_ms,
                    "target": info.target,
                    "reconnected": true,
                    "generation": generation,
                }),
            );
        }
    }
    // The meter (if one was asked for) comes back on the new connection.
    if let Some(m) = meter_req.clone() {
        m.clear_error();
        w.start_meter(&core, m);
    }

    // ------------------------------------------------------------ the watch loop
    while !shared.quit.load(Ordering::SeqCst) {
        ml.loop_().iterate(pw::loop_::Timeout::Finite(TICK));
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::StartMeter(m) => {
                    *meter_req = Some(m.clone());
                    w.start_meter(&core, m);
                }
                Cmd::StopMeter => {
                    *meter_req = None;
                    w.meter = None;
                }
            }
        }
        if let Some(e) = seen.borrow().core_error.clone() {
            // I7: everything on this connection is dead — re-create the bus. The loopback
            // module unloads itself on a core error (module-loopback's own core listener
            // schedules its destroy), so destroying it here too is a double free
            // (measured: "double free or corruption" on a PipeWire kill) — leave it to
            // the context's teardown below.
            shared.up.store(false, Ordering::SeqCst);
            w.meter = None;
            std::mem::forget(module);
            return Ok(End::Lost(format!("PipeWire connection error: {e}")));
        }
        w.step(&seen);
    }
    w.meter = None;
    drop(module);
    seen.borrow_mut().abort = None; // quit is set: this flush must still run
    let _ = roundtrip(&ml, &core, &seen);
    Ok(End::Quit)
}

fn down(shared: &Shared, reason: &str) {
    shared.up.store(false, Ordering::SeqCst);
    shared.update(|i| {
        i.state = BusState::Down;
        i.reason = Some(reason.to_string());
    });
    log::event(
        "audio",
        Level::Warn,
        "audio.bus.down",
        None,
        json!({ "reason": reason }),
    );
}

fn on_global(
    seen: &Rc<RefCell<Seen>>,
    reg: &RegistryWeak,
    g: &pw::registry::GlobalObject<&spa::utils::dict::DictRef>,
) {
    let Some(props) = g.props else {
        return;
    };
    match g.type_ {
        ObjectType::Node => {
            let rec = NodeRec {
                name: props.get("node.name").unwrap_or("").to_string(),
                class: props.get("media.class").unwrap_or("").to_string(),
                serial: props.get("object.serial").and_then(|s| s.parse().ok()),
            };
            seen.borrow_mut().nodes.insert(g.id, rec);
        }
        ObjectType::Link => {
            let num = |k: &str| props.get(k).and_then(|v| v.parse::<u32>().ok());
            if let (Some(o), Some(i)) = (num("link.output.node"), num("link.input.node")) {
                seen.borrow_mut().links.insert(g.id, (o, i));
            }
        }
        ObjectType::Metadata => {
            if props.get("metadata.name") != Some("default") || seen.borrow().metadata.is_some() {
                return;
            }
            let Some(reg) = reg.upgrade() else {
                return;
            };
            let Ok(md) = reg.bind::<Metadata, _>(g) else {
                return;
            };
            let s2 = seen.clone();
            let l = md
                .add_listener_local()
                .property(move |subject, key, _type, value| {
                    if subject == 0 && key == Some("default.audio.sink") {
                        s2.borrow_mut().default_sink = parse_default(value);
                    } else if key == Some("target.object") || key.is_none() {
                        let v = value.filter(|_| key.is_some()).map(str::to_string);
                        s2.borrow_mut().meta_events.push((subject, v));
                    }
                    0
                })
                .register();
            seen.borrow_mut().metadata = Some((md, l));
        }
        _ => {}
    }
}

/// The steady-state watcher: follow `default.audio.sink`, keep the meter stream.
///
/// Retargets are driven by *what was last requested* vs the default — never by the
/// momentary link set (links churn while WirePlumber relinks, and other clients' captures
/// of the playback are links too): a retarget is issued once per default change, completes
/// when a link to that sink appears, fails after [`RETARGET_TIMEOUT`] (not retried until
/// the default changes again). If someone else moves the playback (pavucontrol, a
/// session-manager rule), the bus doesn't fight it: `target` reports where it really is.
struct Watch {
    shared: Arc<Shared>,
    /// The sink last asked for (`node.target` at creation, then each retarget).
    requested: Option<String>,
    /// The `target.object` value the bus last wrote (to tell another client's write).
    written: Option<String>,
    /// Our write has echoed back through the metadata (later writes are someone else's).
    echoed: bool,
    /// A `target.object` another client wrote after our echo (the override), if any.
    foreign: Option<String>,
    /// That override already reported (`audio.bus.moved`).
    override_seen: bool,
    retarget: Option<Retarget>,
    /// A target that failed to link; not retried until the default changes again.
    failed: Option<String>,
    meter: Option<(Arc<MeterShared>, StreamRc, StreamListener<()>)>,
}

struct Retarget {
    from: Option<String>,
    to: String,
    since: Instant,
}

impl Watch {
    fn step(&mut self, seen: &Rc<RefCell<Seen>>) {
        let evs = std::mem::take(&mut seen.borrow_mut().meta_events);
        let s = seen.borrow();
        let Some(pb) = s.playback() else {
            return;
        };
        if let Some(w) = &self.written {
            for (subj, v) in evs {
                if subj != pb {
                    continue;
                }
                if !self.echoed {
                    self.echoed = v.as_deref() == Some(w.as_str());
                    continue;
                }
                if v.as_deref() == Some(w.as_str()) {
                    continue; // still our own value
                }
                // Someone else's write (or it was cleared: `v` is `None`) — unless it's
                // this exact write that's foreign: a later write putting the subject's
                // `target.object` back onto the *current* default, after we'd already
                // reported an override, means the playback is observed back on the
                // default without any intervention of ours. Status accuracy only (never a
                // write of our own, R67): clear the stale flag so `overridden` reports what
                // is true now. Keyed off this explicit write event, never a `linked_targets`
                // snapshot — the module's own rule (see `Watch`'s doc): a relink the write
                // triggers lags the metadata by a tick or more, so reading the momentary
                // link set here would race the lag and misreport (found on-machine: the
                // very next tick after the first override detection still showed the link
                // on the old target, which this exact bug briefly cleared `override_seen`
                // over, letting a second, spurious `audio.bus.moved` fire later).
                if self.override_seen
                    && s.default_sink.is_some()
                    && v.as_deref()
                        .and_then(|val| s.name_of_target(val))
                        .as_deref()
                        == s.default_sink.as_deref()
                {
                    self.foreign = None;
                    self.override_seen = false;
                    let back = s.default_sink.clone();
                    self.shared.update(|i| {
                        i.overridden = false;
                        i.target = back.clone();
                    });
                } else {
                    self.foreign = v;
                    if self.foreign.is_none() {
                        self.foreign = Some(String::new());
                    }
                }
            }
        }
        let linked = s.linked_targets(pb);
        let desired = s.default_sink.clone();
        // Another client re-pointed the playback after our own write (e.g. EasyEffects'
        // "process all output streams" puts every output stream on its sink): accept it.
        let meta = self.foreign.clone();
        let overridden = meta.is_some();
        let by = meta.as_deref().and_then(|v| s.name_of_target(v));
        if overridden && !self.override_seen {
            let to = self
                .retarget
                .as_ref()
                .map(|r| r.to.clone())
                .or(self.requested.clone());
            // Where it's going: the other client's choice (links may still be moving).
            let lands_on = by.clone().or_else(|| linked.first().cloned());
            if lands_on.is_some() || self.retarget.is_none() {
                self.override_seen = true;
                let ms = self
                    .retarget
                    .as_ref()
                    .map(|r| r.since.elapsed().as_secs_f64() * 1000.0);
                let from = self.retarget.take().and_then(|r| r.from);
                let mut lat = 0.0;
                self.shared.update(|i| {
                    i.state = BusState::Up;
                    i.overridden = true;
                    if lands_on.is_some() {
                        i.target = lands_on.clone();
                    }
                    lat = i.latency_ms;
                });
                log::event(
                    "audio",
                    Level::Warn,
                    "audio.bus.moved",
                    None,
                    json!({ "requested": to, "target": lands_on, "by_target_object": meta,
                            "linked_now": linked, "reason": "another client re-pointed the bus playback \
                             (session policy, e.g. EasyEffects processing all output streams); \
                             not fought" }),
                );
                if let Some(ms) = ms {
                    log::event(
                        "audio",
                        Level::Info,
                        "audio.bus.up",
                        None,
                        json!({ "device": DEVICE, "latency_ms": lat, "target": lands_on,
                                "from": from, "requested": to, "overridden": true,
                                "retarget_ms": ms }),
                    );
                }
                return;
            }
        }
        if let Some(r) = &self.retarget {
            if !overridden && linked.contains(&r.to) {
                let ms = r.since.elapsed().as_secs_f64() * 1000.0;
                let (from, to) = (r.from.clone(), r.to.clone());
                self.retarget = None;
                let mut lat = 0.0;
                self.shared.update(|i| {
                    i.state = BusState::Up;
                    i.target = Some(to.clone());
                    lat = i.latency_ms;
                });
                log::event(
                    "audio",
                    Level::Info,
                    "audio.bus.up",
                    None,
                    json!({ "device": DEVICE, "latency_ms": lat, "target": to, "from": from,
                            "requested": to, "overridden": false, "retarget_ms": ms }),
                );
                return;
            }
            if r.since.elapsed() > RETARGET_TIMEOUT {
                let to = r.to.clone();
                log::event(
                    "audio",
                    Level::Warn,
                    "audio.bus.retarget_failed",
                    None,
                    json!({ "to": to, "linked": linked }),
                );
                self.failed = Some(to);
                self.retarget = None;
                let cur = linked.first().cloned();
                self.shared.update(|i| {
                    i.state = BusState::Up;
                    i.target = cur;
                });
                return;
            }
            if desired.as_deref().is_none_or(|d| d == r.to) {
                return; // still on its way
            }
            // The default moved again mid-retarget: follow the newest one (below).
        }
        let want = match desired {
            Some(w) if self.requested.as_deref() != Some(&w) || self.retarget.is_some() => w,
            _ => {
                // Nothing to request: report where the playback really is.
                let cur = by
                    .clone()
                    .filter(|b| overridden && linked.contains(b))
                    .or_else(|| self.requested.clone().filter(|r| linked.contains(r)))
                    .or_else(|| linked.first().cloned());
                self.shared.update(|i| {
                    i.default_sink = desired.clone();
                    if i.state == BusState::Up && cur.is_some() {
                        i.target = cur;
                    }
                });
                return;
            }
        };
        if self.failed.as_deref() == Some(&want) {
            return;
        }
        let Some((sink_id, serial)) = s.sink_by_name(&want) else {
            return; // the new default isn't in the registry yet
        };
        let Some((md, _)) = &s.metadata else {
            return;
        };
        // What it was meant to be on (WirePlumber's `linking.follow-default-target` may
        // already have moved it to `want` by itself — then this completes at once).
        let from = self
            .retarget
            .as_ref()
            .map(|r| r.to.clone())
            .or_else(|| self.requested.clone())
            .or_else(|| linked.first().cloned());
        md.set_property(
            pb,
            "target.node",
            Some("Spa:Id"),
            Some(&sink_id.to_string()),
        );
        let written = serial
            .map(|sr| sr.to_string())
            .unwrap_or_else(|| want.clone());
        match serial {
            Some(_) => md.set_property(pb, "target.object", Some("Spa:Id"), Some(&written)),
            None => md.set_property(pb, "target.object", None, Some(&want)),
        }
        self.written = Some(written);
        self.echoed = false;
        self.foreign = None;
        self.override_seen = false;
        self.failed = None;
        self.requested = Some(want.clone());
        self.shared.update(|i| {
            i.state = BusState::Retargeting;
            i.requested = Some(want.clone());
            i.overridden = false;
            i.default_sink = Some(want.clone());
            i.retargets += 1;
        });
        log::event(
            "audio",
            Level::Info,
            "audio.bus.retargeting",
            None,
            json!({ "from": from, "to": want }),
        );
        self.retarget = Some(Retarget {
            from,
            to: want,
            since: Instant::now(),
        });
    }

    fn start_meter(&mut self, core: &CoreRc, m: Arc<MeterShared>) {
        self.meter = None;
        // No `node.latency` request (R68): the meter must not pin the graph quantum for as
        // long as the player runs. See `capture_stream`'s doc.
        let stream = match capture_stream(core, METER_NAME, SINK_NAME, true, None) {
            Ok(s) => s,
            Err(e) => {
                m.set_error(e);
                return;
            }
        };
        let mut rt = MeterRt::new(m.clone(), RATE, 2);
        // Sized for PipeWire's own default max quantum up front (`METER_SCRATCH_CAP`) —
        // with no pinned `node.latency`, the graph can run at anything up to it. Never
        // reallocated inside the RT process callback: a buffer bigger than this capacity
        // is chunked by `read_capture`/`chunk_into` instead (T14 residual fix round).
        let mut scratch = Vec::with_capacity(METER_SCRATCH_CAP);
        let m_state = m.clone();
        let l = stream
            .add_local_listener_with_user_data(())
            .state_changed(move |_, _, _old, new| {
                let streaming = matches!(new, StreamState::Streaming);
                m_state.streaming.store(streaming, Ordering::Relaxed);
                if let StreamState::Error(e) = new {
                    m_state.set_error(format!("meter stream error: {e}"));
                }
            })
            .process(move |st, _| {
                read_capture(st, &mut scratch, 2, |buf, t| {
                    rt.process(buf, t);
                });
            })
            .register();
        let l = match l {
            Ok(l) => l,
            Err(e) => {
                m.set_error(format!("meter listener: {e}"));
                return;
            }
        };
        if let Err(e) = connect(&stream, spa::utils::Direction::Input) {
            m.set_error(format!("meter: {e}"));
            return;
        }
        log::event(
            "audio",
            Level::Info,
            "audio.meter.started",
            None,
            json!({ "stream": METER_NAME, "rate": RATE, "quantum": QUANTUM }),
        );
        self.meter = Some((m, stream, l));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sink_value_parses_and_never_names_the_bus() {
        assert_eq!(
            parse_default(Some(r#"{"name":"easyeffects_sink"}"#)).as_deref(),
            Some("easyeffects_sink")
        );
        assert_eq!(parse_default(Some(r#"{"name":"lp-player-bus"}"#)), None);
        assert_eq!(parse_default(Some("garbage")), None);
        assert_eq!(parse_default(None), None);
    }

    #[test]
    fn target_object_names_by_serial_never_by_id() {
        let mut s = Seen::default();
        let node = |name: &str, serial| NodeRec {
            name: name.into(),
            class: "Audio/Sink".into(),
            serial: Some(serial),
        };
        // id 136 = the bus sink; serial 136 = easyeffects_sink (ids and serials overlap).
        s.nodes.insert(136, node("lp-player-bus", 4100));
        s.nodes.insert(117, node("easyeffects_sink", 136));
        assert_eq!(s.name_of_target("136").as_deref(), Some("easyeffects_sink"));
        assert_eq!(s.name_of_target("117"), None);
        assert_eq!(
            s.name_of_target("easyeffects_sink").as_deref(),
            Some("easyeffects_sink")
        );
        assert_eq!(s.name_of_target("nope"), None);
    }

    #[test]
    fn meter_scratch_capacity_absorbs_default_max_quantum_without_reallocating() {
        // `Watch::start_meter`'s RT scratch (sized via `METER_SCRATCH_CAP`) must never grow
        // inside the process callback — it has to be sized for PipeWire's own default max
        // quantum (8192 frames, stereo) up front, now that the meter no longer pins
        // `node.latency` and the graph can run at anything up to that (R68).
        let mut scratch: Vec<f32> = Vec::with_capacity(METER_SCRATCH_CAP);
        let cap0 = scratch.capacity();
        assert!(cap0 >= MAX_QUANTUM_FRAMES * 2, "cap0={cap0}");
        // Simulate `read_capture`'s pattern for the largest buffer PipeWire's default max
        // quantum would ever hand the callback: clear (keeps capacity), then extend.
        scratch.clear();
        scratch.extend(std::iter::repeat_n(0.0f32, MAX_QUANTUM_FRAMES * 2));
        assert_eq!(
            scratch.len(),
            MAX_QUANTUM_FRAMES * 2,
            "didn't actually fill the buffer"
        );
        assert_eq!(
            scratch.capacity(),
            cap0,
            "RT scratch reallocated inside the process callback"
        );
    }

    #[test]
    fn chunk_into_never_reallocates_and_meters_every_frame_past_3x_capacity() {
        // T14 residual (found in review): a buffer more than `scratch`'s own capacity
        // must be chunked, never grown — and every frame must still reach `on_chunk`,
        // just split across more than one call.
        let channels = 2usize;
        let cap_frames = 64usize;
        let mut scratch: Vec<f32> = Vec::with_capacity(cap_frames * channels);
        let cap0 = scratch.capacity();
        let total_frames = cap_frames * 3 + 7; // > 3x capacity, not an exact multiple
        let bytes: Vec<u8> = (0..total_frames * channels)
            .flat_map(|i| (i as f32).to_le_bytes())
            .collect();
        let mut frames_seen = 0usize;
        let mut chunk_count = 0usize;
        let mut max_chunk_frames = 0usize;
        chunk_into(&bytes, 0, channels, &mut scratch, |buf, _t| {
            assert_eq!(buf.len() % channels, 0);
            let frames = buf.len() / channels;
            max_chunk_frames = max_chunk_frames.max(frames);
            frames_seen += frames;
            chunk_count += 1;
        });
        assert_eq!(frames_seen, total_frames, "every frame must be metered");
        assert!(
            chunk_count >= 3,
            "a >3x-capacity buffer must split into several chunks, got {chunk_count}"
        );
        assert!(
            max_chunk_frames <= cap_frames,
            "a chunk must never exceed the scratch capacity: {max_chunk_frames} > {cap_frames}"
        );
        assert_eq!(
            scratch.capacity(),
            cap0,
            "RT scratch reallocated while chunking"
        );
    }

    #[test]
    fn chunk_into_advances_t_ns_per_chunk_by_its_frame_offset() {
        let channels = 2usize;
        let mut scratch: Vec<f32> = Vec::with_capacity(4 * channels);
        let total_frames = 10usize; // > capacity (4): splits into chunks of 4,4,2
        let bytes: Vec<u8> = vec![0u8; total_frames * channels * 4];
        let ns_per_frame = 1e9 / RATE as f64;
        let mut starts = Vec::new();
        chunk_into(&bytes, 1_000_000, channels, &mut scratch, |_buf, t| {
            starts.push(t);
        });
        assert_eq!(starts.len(), 3);
        assert_eq!(starts[0], 1_000_000);
        assert_eq!(starts[1], 1_000_000 + (4.0 * ns_per_frame) as i64);
        assert_eq!(starts[2], 1_000_000 + (8.0 * ns_per_frame) as i64);
    }

    #[test]
    fn loopback_args_carry_the_identity_contract() {
        let a = loopback_args(Some("easy\"sink"));
        for want in [
            "media.class = Audio/Sink",
            "node.name = lp-player-bus ",
            "node.description = \"lp-player bus\"",
            "audio.position = [ FL FR ]",
            "node.name = lp-player-bus.playback",
            "application.name = lp-player",
            "media.role = Wallpaper",
            "node.target = \"easy\\\"sink\"",
            "state.restore-target = false",
        ] {
            assert!(a.contains(want), "{want:?} missing from {a}");
        }
        assert!(!loopback_args(None).contains("node.target"));
    }
}
