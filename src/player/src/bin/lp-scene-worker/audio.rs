//! The scene's sound as a stream on the player bus (Task 6; `.claude/rules/player-core.md`
//! § Scene worker → "Scene audio (Task 6)").
//!
//! One PipeWire playback stream per worker — F32 stereo 48 kHz, `node.latency 256/48000`,
//! `node.name = lp-player-scene.<source id>`, `media.role = Wallpaper`, `target.object =
//! lp-player-bus` when the route is the bus — run from its own thread (`lp-scene-audio`, its own
//! PipeWire main loop) with **`RT_PROCESS`**: the process callback runs on PipeWire's data
//! thread (real-time priority through the client's `module-rt`, as mpv's AO does) — on the
//! main-loop thread it missed graph cycles under CPU load (1.3 ms of silence on the bus at a
//! 64-frame quantum: `pw-top` ERR on `lp-player-scene.*`, the `scene_gain_ramp_reaches_the_bus`
//! flake). The callback owns the [`Dsp`] (a mutex the main loop never takes while streaming) and
//! hands the envelope + `AudioFlowing` to the main loop through [`Outbox`] (`try_lock` /
//! atomics: never a wait on the main loop). The callback **pulls** the scene's mix
//! (`wp_context_audio_pull`, or the synthetic tone) through the time stretch ([`Stretch`]: the
//! scene clock's `speed`, pitch kept, bit-exact at 1×), then:
//!
//! - **the gate** — the worker's own ≤ 30 ms anti-click fade ([`ANTICLICK_FRAMES`]): open while
//!   the scene plays (not paused, not `no_audio`, not quitting), closed otherwise; it jumps at
//!   once when the stream is silent anyway (nothing to declick — so a pause after the
//!   compositor's ramp never pulls a sample more: no decode drift). It is what fades a
//!   restarted worker back in at its folded `Start.gain_db`, and a pause/mute/route change/quit
//!   that arrives while audible;
//! - **the gain** — the compositor's `Gain {db}` pushes (the effective sum of the source's
//!   `gain.*` slots), interpolated **linearly in amplitude** from the previous to the latest
//!   across one buffer, so a 1 kHz push train is a smooth ramp (never a step); ≤ −96 dB is
//!   exact `0.0`.
//!
//! The stream is opened once the loaded scene turns out to have sound (`Ready.has_audio`; a
//! scene without any never opens one — no wake-ups for silence) — silent (gate shut, the gain
//! ramping from 0) — and the process only exits after its level reached exactly 0
//! ([`Control::quit`]), so an audible stream is never closed. `AudioFlowing` goes out from the
//! first callback after an arming change (a start that plays, an un-pause, `no_audio` off, a
//! route change) that pulled the scene's samples into the stream; an `Envelope` (1 ms
//! max-channel RMS dBFS of the gated, pre-gain samples) every 50 ms — the dropout detector's
//! reference for a scene. `AudioRoute::Null` (`--ao null`, tests) is a real-time timer pulling
//! and discarding; a PipeWire that can't be reached falls back to that timer (keeping the
//! scene's sound in step with its picture, reporting no flow) and is retried every second.

use std::cell::RefCell;
use std::os::fd::{AsFd, OwnedFd};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::MutexGuard;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lp_player::audio::bus::{APP_NAME, MEDIA_ROLE, SINK_NAME};
use lp_player::audio::loudness::{Segment, SegmentMeter};
use lp_player::audio::meter::{BlockMeter, mono_ns};
use lp_player::units::SILENT_DB;
use lp_player::worker::proto::{self, AudioRoute, FromWorker, ToWorker};
use pipewire as pw;
use pw::context::ContextRc;
use pw::main_loop::MainLoopRc;
use pw::properties::properties;
use pw::spa;
use pw::stream::StreamRc;

use crate::stretch::{CH, Pull, Stretch};

pub const RATE: u32 = 48_000;
/// The stream's `node.latency` request (plan Task 6).
pub const QUANTUM: u32 = 256;
/// The worker's own anti-click fade (invariant #4: ≤ 30 ms).
pub const ANTICLICK_FRAMES: usize = 1440;
/// 1 ms blocks per `Envelope` message.
const ENVELOPE_BLOCKS: usize = 50;
/// The null route's (and the fallback's) timer period.
const NULL_PERIOD: Duration = Duration::from_millis(5);
/// How often an unreachable PipeWire is retried.
const RETRY: Duration = Duration::from_secs(1);
/// The loop's wake-up period (commands, outbox).
const ITERATE: Duration = Duration::from_millis(5);
/// How often the audio thread checks for a sound to play before there is one.
const IDLE_POLL: Duration = Duration::from_millis(20);

/// A dB gain as the stream's amplitude: ≤ −96 dB is exactly 0.
pub fn gain_lin(db: f64) -> f32 {
    if db <= SILENT_DB {
        0.0
    } else {
        10f64.powf(db / 20.0) as f32
    }
}

/// The synthetic scene's sound (D7): a stereo sine at `hz`, peak `10^(dbfs/20)` (so a −20
/// dBFS tone reads −23 on the bus meter, like `bus.sh`'s clip).
pub struct Tone {
    phase: f64,
    step: f64,
    amp: f32,
}

impl Tone {
    pub fn new(hz: f64, dbfs: f64) -> Tone {
        Tone {
            phase: 0.0,
            step: 2.0 * std::f64::consts::PI * hz / RATE as f64,
            amp: gain_lin(dbfs),
        }
    }
}

impl Pull for Tone {
    fn pull(&mut self, out: &mut [f32]) {
        for fr in out.chunks_exact_mut(CH) {
            fr.fill(self.amp * self.phase.sin() as f32);
            self.phase = (self.phase + self.step) % (2.0 * std::f64::consts::PI);
        }
    }
}

/// What the stream should do, shared between the protocol thread (which applies `Gain`,
/// `Paused`, `NoAudio`, `Route`, `Speed` the moment they arrive — never behind a frame being
/// rendered) and the audio thread.
pub struct Control {
    gain_db: AtomicU64,
    paused: AtomicBool,
    no_audio: AtomicBool,
    speed: AtomicU64,
    /// Bumped on every arming change (see the module doc).
    arm: AtomicU64,
    quitting: AtomicBool,
    route: Mutex<(u64, AudioRoute)>,
    id: Mutex<String>,
    /// The scene's sound, once loaded. Locked by the callback for one pull; the renderer
    /// takes it out (waiting for a pull in flight) before the scene is destroyed.
    source: Mutex<Option<Box<dyn Pull>>>,
    /// The stream's output level after the last callback: `applied gain × gate` (f32 bits).
    level: AtomicU32,
    started: AtomicBool,
    installed: AtomicBool,
}

fn f64_bits(v: f64) -> u64 {
    v.to_bits()
}

impl Default for Control {
    fn default() -> Self {
        Control {
            gain_db: AtomicU64::new(f64_bits(SILENT_DB)),
            paused: AtomicBool::new(true),
            no_audio: AtomicBool::new(false),
            speed: AtomicU64::new(f64_bits(1.0)),
            arm: AtomicU64::new(0),
            quitting: AtomicBool::new(false),
            route: Mutex::new((0, AudioRoute::Null)),
            id: Mutex::new(String::new()),
            source: Mutex::new(None),
            level: AtomicU32::new(0),
            started: AtomicBool::new(false),
            installed: AtomicBool::new(false),
        }
    }
}

impl Control {
    /// The `Start`'s audio state (the protocol thread, before the renderer sees it). Only the
    /// first `Start` counts.
    pub fn start(&self, m: &ToWorker) {
        let ToWorker::Start {
            paused,
            audio,
            id,
            gain_db,
            no_audio,
            speed,
            ..
        } = m
        else {
            return;
        };
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.gain_db.store(f64_bits(*gain_db), Ordering::SeqCst);
        self.paused.store(*paused, Ordering::SeqCst);
        self.no_audio.store(*no_audio, Ordering::SeqCst);
        self.speed.store(f64_bits(*speed), Ordering::SeqCst);
        *self.route.lock().unwrap_or_else(|e| e.into_inner()) = (0, audio.clone());
        *self.id.lock().unwrap_or_else(|e| e.into_inner()) = id.clone();
        if !*paused && !*no_audio {
            self.arm.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Apply an audio message; `false` = not one.
    pub fn apply(&self, m: &ToWorker) -> bool {
        match m {
            ToWorker::Gain { db } => self.gain_db.store(f64_bits(*db), Ordering::SeqCst),
            ToWorker::Paused { paused } => {
                if self.paused.swap(*paused, Ordering::SeqCst) && !*paused {
                    self.arm.fetch_add(1, Ordering::SeqCst);
                }
            }
            ToWorker::NoAudio { on } => {
                if self.no_audio.swap(*on, Ordering::SeqCst) && !*on {
                    self.arm.fetch_add(1, Ordering::SeqCst);
                }
            }
            ToWorker::Speed { speed } => self
                .speed
                .store(f64_bits(speed.clamp(0.05, 8.0)), Ordering::SeqCst),
            ToWorker::Route { audio } => {
                let mut r = self.route.lock().unwrap_or_else(|e| e.into_inner());
                *r = (r.0 + 1, audio.clone());
                self.arm.fetch_add(1, Ordering::SeqCst);
            }
            _ => return false,
        }
        true
    }

    /// The scene's sound is ready to pull (after its load).
    pub fn install(&self, src: Box<dyn Pull>) {
        *self.source.lock().unwrap_or_else(|e| e.into_inner()) = Some(src);
        self.installed.store(true, Ordering::SeqCst);
    }

    /// A sound was installed (the stream exists from then on).
    fn has_source(&self) -> bool {
        self.installed.load(Ordering::SeqCst)
    }

    /// Stop pulling (waits for a pull in flight): before the scene is destroyed.
    pub fn remove(&self) {
        self.source.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// Fade the stream out (the gate, ≤ 30 ms — at once if it's silent already) and wait
    /// until its level is exactly 0, at most `max`: the process may then exit without
    /// cutting an audible stream.
    pub fn quit(&self, max: Duration) {
        self.quitting.store(true, Ordering::SeqCst);
        let end = Instant::now() + max;
        while self.level() > 0.0 && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::SeqCst))
    }

    fn state(&self) -> State {
        State {
            gain_db: f64::from_bits(self.gain_db.load(Ordering::SeqCst)),
            plays: !self.paused.load(Ordering::SeqCst)
                && !self.no_audio.load(Ordering::SeqCst)
                && !self.quitting.load(Ordering::SeqCst),
            speed: f64::from_bits(self.speed.load(Ordering::SeqCst)),
            arm: self.arm.load(Ordering::SeqCst),
        }
    }

    fn route(&self) -> (u64, AudioRoute) {
        self.route.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn route_gen(&self) -> u64 {
        self.route.lock().unwrap_or_else(|e| e.into_inner()).0
    }
}

/// One callback's view of [`Control`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct State {
    pub gain_db: f64,
    /// Not paused, not `no_audio`, not quitting.
    pub plays: bool,
    pub speed: f64,
    pub arm: u64,
}

/// The stream's signal path after the pull: stretch → gate → envelope → gain. Pure (the
/// callers hand it the state and the source), unit-tested without PipeWire.
pub struct Dsp {
    /// The gain applied at the end of the last buffer (amplitude).
    pub applied: f32,
    /// The anti-click gate, 0..1.
    pub gate: f32,
    stretch: Stretch,
    meter: BlockMeter,
    /// Envelope blocks not sent yet: `(ns on CLOCK_MONOTONIC, dBFS)`.
    pub env: Vec<(i64, f32)>,
    /// Scene loudness learning: K-weights what the scene really plays (pre-gate, pre-gain).
    loud: SegmentMeter,
    /// Its 100 ms segments not sent yet.
    pub segs: Vec<Segment>,
    armed_seen: u64,
    /// The pulled/stretched buffer (pre-gain).
    scratch: Vec<f32>,
}

impl Default for Dsp {
    fn default() -> Self {
        Dsp::new()
    }
}

impl Dsp {
    pub fn new() -> Dsp {
        Dsp {
            applied: 0.0,
            gate: 0.0,
            stretch: Stretch::new(),
            meter: BlockMeter::new(RATE, CH as u32),
            env: Vec::new(),
            loud: SegmentMeter::new(CH),
            segs: Vec::new(),
            armed_seen: 0,
            scratch: Vec::new(),
        }
    }

    /// Fill `out` (interleaved stereo) for a buffer that plays at `t_ns`. `src` = the scene's
    /// sound if loaded; `real` = `out` goes to a real stream (a fallback timer never reports
    /// flow). Returns whether this buffer confirms an arming (`AudioFlowing`).
    pub fn process(
        &mut self,
        out: &mut [f32],
        st: State,
        src: Option<&mut dyn Pull>,
        t_ns: i64,
        real: bool,
    ) -> bool {
        let n = out.len() / CH;
        if n == 0 {
            return false;
        }
        let target = gain_lin(st.gain_db);
        let plays = st.plays && src.is_some();
        let gate_to = if plays { 1.0 } else { 0.0 };
        if self.applied == 0.0 && target == 0.0 {
            // Silent anyway: nothing to declick — and no sample pulled for a fade nobody hears.
            self.gate = gate_to;
        }
        let pulled = match src {
            Some(s) if plays || self.gate > 0.0 => {
                self.scratch.resize(out.len(), 0.0);
                self.stretch.produce(&mut self.scratch, st.speed, s);
                true
            }
            _ => false,
        };
        if !pulled {
            self.scratch.clear();
            self.scratch.resize(out.len(), 0.0);
        }
        // Loudness counts only the scene's sound really played into a stream: not paused, not
        // `no_audio`, not a fade-out (`plays`), not the PipeWire-down fallback (`real`) — and
        // before the gate and the gain, so neither a user volume nor the normalization biases it.
        if plays && pulled && real {
            self.loud.feed(&self.scratch, &mut self.segs);
        }
        // The gate in whole frames (exact 0 and 1 at its ends).
        let mut gn = (self.gate * ANTICLICK_FRAMES as f32).round() as usize;
        let to = if plays { ANTICLICK_FRAMES } else { 0 };
        for fr in self.scratch.chunks_exact_mut(CH) {
            if gn < to {
                gn += 1;
            } else if gn > to {
                gn -= 1;
            }
            let g = gn as f32 / ANTICLICK_FRAMES as f32;
            for v in fr.iter_mut() {
                *v *= g;
            }
        }
        self.gate = gn as f32 / ANTICLICK_FRAMES as f32;
        self.meter.feed(&self.scratch, t_ns, &mut self.env);
        let (a, d) = (self.applied, target - self.applied);
        for (i, (o, x)) in out
            .chunks_exact_mut(CH)
            .zip(self.scratch.chunks_exact(CH))
            .enumerate()
        {
            let g = if i + 1 == n {
                target
            } else {
                a + d * (i + 1) as f32 / n as f32
            };
            for (o, x) in o.iter_mut().zip(x) {
                *o = x * g;
            }
        }
        self.applied = target;
        if plays && pulled && real && st.arm > self.armed_seen {
            self.armed_seen = st.arm;
            return true;
        }
        false
    }

    /// `applied × gate`: 0 = the stream outputs exact silence.
    pub fn level(&self) -> f32 {
        self.applied * self.gate
    }
}

/// Run one buffer through `dsp` with `ctl`'s state and source; queue what goes out.
/// `stop` = fade out whatever the state says (a route change closing this stream).
fn fill(
    ctl: &Control,
    dsp: &mut Dsp,
    out: &mut [f32],
    t_ns: i64,
    real: bool,
    stop: bool,
    outbox: &Outbox,
) {
    let mut st = ctl.state();
    st.plays &= !stop;
    // The renderer holds the lock only to install/remove: a miss is that moment — silence.
    let flowed = match ctl.source.try_lock() {
        Ok(mut g) => {
            let src = g.as_mut().map(|b| b.as_mut() as &mut dyn Pull);
            dsp.process(out, st, src, t_ns, real)
        }
        Err(_) => dsp.process(out, st, None, t_ns, real),
    };
    ctl.level.store(dsp.level().to_bits(), Ordering::SeqCst);
    if flowed {
        outbox.flowed.store(true, Ordering::SeqCst);
    }
    // Never wait on the main loop: a held lock leaves the blocks in `dsp.env` for next time.
    if !dsp.env.is_empty()
        && let Ok(mut e) = outbox.env.try_lock()
    {
        e.append(&mut dsp.env);
    }
    if !dsp.segs.is_empty()
        && let Ok(mut l) = outbox.loud.try_lock()
    {
        l.append(&mut dsp.segs);
    }
}

/// What the stream's callback hands the main loop (which sends it): `AudioFlowing` and the
/// envelope's 1 ms blocks.
#[derive(Default)]
struct Outbox {
    flowed: AtomicBool,
    env: Mutex<Vec<(i64, f32)>>,
    /// Loudness segments (`FromWorker::Loudness`).
    loud: Mutex<Vec<Segment>>,
}

fn lock(dsp: &Mutex<Dsp>) -> MutexGuard<'_, Dsp> {
    dsp.lock().unwrap_or_else(|e| e.into_inner())
}

/// Send what the callbacks queued: `AudioFlowing`, full `Envelope` batches.
fn flush(sock: &OwnedFd, outbox: &Outbox) {
    if outbox.flowed.swap(false, Ordering::SeqCst) {
        let _ = proto::send(sock.as_fd(), &FromWorker::AudioFlowing, &[]);
    }
    let mut batches = Vec::new();
    {
        let mut e = outbox.env.lock().unwrap_or_else(|e| e.into_inner());
        while e.len() >= ENVELOPE_BLOCKS {
            batches.push(e.drain(..ENVELOPE_BLOCKS).collect::<Vec<_>>());
        }
    }
    for batch in batches {
        let m = FromWorker::Envelope {
            t0_ms: batch[0].0 as f64 / 1e6,
            dbfs_1ms: batch.iter().map(|b| b.1).collect(),
        };
        let _ = proto::send(sock.as_fd(), &m, &[]);
    }
    let segments = std::mem::take(&mut *outbox.loud.lock().unwrap_or_else(|e| e.into_inner()));
    if !segments.is_empty() {
        let _ = proto::send(sock.as_fd(), &FromWorker::Loudness { segments }, &[]);
    }
}

fn log(sock: &OwnedFd, level: &str, line: String) {
    let _ = proto::send(
        sock.as_fd(),
        &FromWorker::Log {
            level: level.into(),
            line,
        },
        &[],
    );
}

/// Start the audio thread (at `Start`, before the load: the stream exists, silent, from the
/// first moment). `sock` = a clone of the worker's socket (datagrams are atomic).
pub fn spawn(ctl: Arc<Control>, sock: OwnedFd) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("lp-scene-audio".into())
        .spawn(move || run(ctl, sock))
        .map(|_| ())
}

fn run(ctl: Arc<Control>, sock: OwnedFd) {
    pw::init();
    // Kept across streams and routes (the gate's and the gain's state continue).
    let dsp = Arc::new(Mutex::new(Dsp::new()));
    // A scene without sound (or not loaded yet) has nothing to play: no stream, no timer —
    // a 64-frame graph would otherwise wake this thread 750×/s for silence.
    while !ctl.has_source() {
        std::thread::sleep(IDLE_POLL);
    }
    loop {
        let (rgen, route) = ctl.route();
        match route {
            AudioRoute::Null => run_null(&ctl, &dsp, &sock, rgen, true, None),
            AudioRoute::Default | AudioRoute::Device(_) => {
                let target = match &route {
                    AudioRoute::Device(d) => {
                        Some(d.strip_prefix("pipewire/").unwrap_or(d).to_string())
                    }
                    _ => None,
                };
                if let Err(e) = run_pw(&ctl, &dsp, &sock, rgen, target.as_deref()) {
                    log(
                        &sock,
                        "warn",
                        format!(
                            "audio: PipeWire stream ({route:?}): {e}; pulling on a timer, retry in 1 s"
                        ),
                    );
                    run_null(&ctl, &dsp, &sock, rgen, false, Some(Instant::now() + RETRY));
                }
            }
        }
    }
}

/// The null route (or a fallback until `until`): pull in real time and discard. Ends when
/// the route changes or `until` passes.
fn run_null(
    ctl: &Control,
    dsp: &Mutex<Dsp>,
    sock: &OwnedFd,
    rgen: u64,
    real: bool,
    until: Option<Instant>,
) {
    let t0 = Instant::now();
    let mut done: u64 = 0;
    let mut buf = Vec::new();
    let outbox = Outbox::default();
    while ctl.route_gen() == rgen && until.is_none_or(|u| Instant::now() < u) {
        std::thread::sleep(NULL_PERIOD);
        let due = (t0.elapsed().as_secs_f64() * RATE as f64) as u64;
        // At most 100 ms at once (a stalled thread never bursts a second's worth).
        let n = (due - done).min(RATE as u64 / 10) as usize;
        done = due;
        if n == 0 {
            continue;
        }
        buf.resize(n * CH, 0.0);
        fill(ctl, &mut lock(dsp), &mut buf, mono_ns(), real, false, &outbox);
        flush(sock, &outbox);
    }
}

/// One PipeWire connection + playback stream, until the route changes (after fading out an
/// audible stream on the gate) or the connection fails (`Err`).
fn run_pw(
    ctl: &Arc<Control>,
    dsp: &Arc<Mutex<Dsp>>,
    sock: &OwnedFd,
    rgen: u64,
    target: Option<&str>,
) -> Result<(), String> {
    let ml = MainLoopRc::new(None).map_err(|e| format!("main loop: {e}"))?;
    let context = ContextRc::new(&ml, Some(properties! { "application.name" => APP_NAME }))
        .map_err(|e| format!("context: {e}"))?;
    let core = context
        .connect_rc(None)
        .map_err(|e| format!("can't connect ({e})"))?;
    let core_error: Rc<RefCell<Option<String>>> = Rc::default();
    let _core_l = core
        .add_listener_local()
        .error({
            let ce = core_error.clone();
            move |id, _seq, res, msg| {
                if id == pw::core::PW_ID_CORE {
                    *ce.borrow_mut() = Some(format!("{msg} ({res})"));
                }
            }
        })
        .register();
    let id = ctl.id.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let name = format!("lp-player-scene.{id}");
    let latency = format!("{QUANTUM}/{RATE}");
    let mut props = properties! {
        "media.type" => "Audio",
        "media.category" => "Playback",
        "media.role" => MEDIA_ROLE,
        "node.name" => name.as_str(),
        "node.description" => "lp-player scene",
        "application.name" => APP_NAME,
        "node.latency" => latency.as_str(),
        "state.restore-props" => "false",
        "state.restore-target" => "false",
    };
    if let Some(t) = target {
        props.insert("target.object", t);
        if t == SINK_NAME {
            // Bus gone = the compositor re-routes us (never a silent move to another sink).
            props.insert("node.dont-reconnect", "true");
        }
    }
    let stream =
        StreamRc::new(core.clone(), &name, props).map_err(|e| format!("stream {name}: {e}"))?;
    // Shared with the callback, which runs on PipeWire's data thread (`RT_PROCESS`).
    let outbox = Arc::new(Outbox::default());
    let closing = Arc::new(AtomicBool::new(false));
    let _l = stream
        .add_local_listener_with_user_data(())
        .process({
            let (ctl, dsp, outbox, closing) =
                (ctl.clone(), dsp.clone(), outbox.clone(), closing.clone());
            move |st, _| unsafe {
                let b = st.dequeue_raw_buffer();
                if b.is_null() {
                    return;
                }
                let sb = (*b).buffer;
                if !sb.is_null() && (*sb).n_datas > 0 && !(*sb).datas.is_null() {
                    let d = &mut *(*sb).datas;
                    if !d.data.is_null() && !d.chunk.is_null() {
                        let stride = CH * 4;
                        let max = d.maxsize as usize / stride;
                        let req = (*b).requested as usize;
                        let n = if req > 0 {
                            req.min(max)
                        } else {
                            max.min(QUANTUM as usize)
                        };
                        let out = std::slice::from_raw_parts_mut(d.data as *mut f32, n * CH);
                        // These samples play about one buffer from now.
                        let t = mono_ns() + (n as i64 * 1_000_000_000 / RATE as i64);
                        // A route change closing this stream fades out on the gate first.
                        fill(
                            &ctl,
                            &mut lock(&dsp),
                            out,
                            t,
                            true,
                            closing.load(Ordering::SeqCst),
                            &outbox,
                        );
                        let c = &mut *d.chunk;
                        c.offset = 0;
                        c.stride = stride as i32;
                        c.size = (n * stride) as u32;
                    }
                }
                st.queue_raw_buffer(b);
            }
        })
        .register()
        .map_err(|e| format!("stream listener: {e}"))?;
    lp_player::audio::bus::connect_with(
        &stream,
        spa::utils::Direction::Output,
        pw::stream::StreamFlags::AUTOCONNECT
            | pw::stream::StreamFlags::MAP_BUFFERS
            | pw::stream::StreamFlags::RT_PROCESS,
    )?;
    log(
        sock,
        "info",
        format!(
            "audio: stream {name} -> {}",
            target.unwrap_or("the default sink")
        ),
    );
    let mut close_by: Option<Instant> = None;
    loop {
        ml.loop_().iterate(pw::loop_::Timeout::Finite(ITERATE));
        flush(sock, &outbox);
        if let Some(e) = core_error.borrow_mut().take() {
            return Err(format!("connection error: {e}"));
        }
        if ctl.route_gen() != rgen {
            // Fade out (≤ 30 ms of callbacks), bounded — a stalled graph never holds us.
            let by = *close_by.get_or_insert_with(|| Instant::now() + Duration::from_millis(100));
            closing.store(true, Ordering::SeqCst);
            // The callback stores its level after every buffer (`fill`).
            if ctl.level() == 0.0 || Instant::now() >= by {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Ones;

    impl Pull for Ones {
        fn pull(&mut self, out: &mut [f32]) {
            out.fill(1.0);
        }
    }

    fn st(db: f64) -> State {
        State {
            gain_db: db,
            plays: true,
            speed: 1.0,
            arm: 0,
        }
    }

    /// A `Gain` push is a ramp across one buffer, linear in amplitude: first ≈ the old gain,
    /// last exactly the new one, monotonic, no step larger than one buffer's slope.
    #[test]
    fn gain_change_ramps_across_one_buffer() {
        let mut d = Dsp::new();
        let mut out = vec![0.0; 480 * CH];
        d.process(&mut out, st(0.0), Some(&mut Ones), 0, true);
        assert_eq!(d.applied, 1.0);
        // Open the gate fully first (30 ms).
        for _ in 0..4 {
            d.process(&mut out, st(0.0), Some(&mut Ones), 0, true);
        }
        assert_eq!(d.gate, 1.0);
        d.process(&mut out, st(SILENT_DB), Some(&mut Ones), 0, true);
        let l: Vec<f32> = out.chunks_exact(CH).map(|f| f[0]).collect();
        assert!((l[0] - 1.0).abs() < 2.0 / 480.0, "first {}", l[0]);
        assert_eq!(*l.last().unwrap(), 0.0, "last exactly silent");
        let max_step = l.windows(2).map(|w| w[0] - w[1]).fold(f32::MIN, f32::max);
        assert!(l.windows(2).all(|w| w[1] <= w[0]), "monotonic");
        assert!(max_step <= 1.0 / 479.0 + 1e-6, "max step {max_step}");
        assert!(out.chunks_exact(CH).all(|f| f[0] == f[1]), "both channels");
    }

    #[test]
    fn silent_db_is_exact_zero() {
        assert_eq!(gain_lin(SILENT_DB), 0.0);
        assert_eq!(gain_lin(-120.0), 0.0);
        assert!(gain_lin(-95.9) > 0.0);
        let mut d = Dsp::new();
        d.gate = 1.0;
        d.applied = 0.0;
        let mut out = vec![9.0; 256 * CH];
        d.process(&mut out, st(SILENT_DB), Some(&mut Ones), 0, true);
        assert!(out.iter().all(|v| *v == 0.0));
        assert_eq!(d.level(), 0.0);
    }

    #[test]
    fn gain_matches_db_to_lin() {
        assert!((gain_lin(-6.0206) - 0.5).abs() < 1e-6);
        assert!((gain_lin(0.0) - 1.0).abs() < 1e-9);
        assert!((gain_lin(-20.0) - 0.1).abs() < 1e-7);
        assert!((gain_lin(-6.0206) as f64 - lp_player::units::db_to_lin(-6.0206)).abs() < 1e-6);
    }

    /// The envelope (1 ms max-channel RMS dBFS) of a full-scale sine is −3.01 dBFS, like the
    /// bus meter's.
    #[test]
    fn envelope_of_full_scale_sine_is_minus_3_01() {
        let mut d = Dsp::new();
        d.gate = 1.0;
        let mut tone = Tone::new(1000.0, 0.0);
        let mut out = vec![0.0; 960 * CH];
        for _ in 0..5 {
            d.process(&mut out, st(0.0), Some(&mut tone), 0, true);
        }
        assert!(d.env.len() >= 90, "{}", d.env.len());
        for (_, db) in &d.env {
            assert!((db + 3.0103).abs() < 0.05, "{db}");
        }
        assert!((lp_player::audio::meter::dbfs_block(&out[..96], CH) + 3.0103).abs() < 0.05);
    }

    /// Paused / `no_audio` with the stream already silent (the compositor ramped first): not
    /// one sample more is pulled (no drift), the gate shuts at once. Audible: a 30 ms fade,
    /// still pulling, then nothing.
    #[test]
    fn gate_declicks_only_an_audible_stream() {
        struct Count(u64);
        impl Pull for Count {
            fn pull(&mut self, out: &mut [f32]) {
                self.0 += (out.len() / CH) as u64;
                out.fill(0.5);
            }
        }
        let mut d = Dsp::new();
        let mut src = Count(0);
        let mut out = vec![0.0; 240 * CH];
        let mut stop = st(SILENT_DB);
        stop.plays = false;
        d.process(&mut out, st(SILENT_DB), Some(&mut src), 0, true);
        assert_eq!(d.gate, 1.0, "silent: opens at once");
        let before = src.0;
        d.process(&mut out, stop, Some(&mut src), 0, true);
        assert_eq!(src.0, before, "silent pause: nothing pulled");
        assert_eq!(d.gate, 0.0);
        // Audible pause: fades over 30 ms (6 × 240 frames), pulling meanwhile.
        for _ in 0..8 {
            d.process(&mut out, st(0.0), Some(&mut src), 0, true);
        }
        assert_eq!(d.gate, 1.0);
        let before = src.0;
        let mut levels = Vec::new();
        for _ in 0..8 {
            let mut audible = st(0.0);
            audible.plays = false;
            d.process(&mut out, audible, Some(&mut src), 0, true);
            levels.push(out[out.len() - 2]);
        }
        assert_eq!(src.0 - before, 6 * 240, "pulled exactly the 30 ms fade");
        assert!(levels.windows(2).all(|w| w[1] <= w[0]), "{levels:?}");
        assert_eq!(levels[5], 0.0, "{levels:?}");
        assert_eq!(d.level(), 0.0);
    }

    /// Scene loudness learning: a 100 ms K-weighted segment per 100 ms the scene really played
    /// — pre-gain (a −40 dB gain reads the same), none while paused / `no_audio` (no `plays`)
    /// or on the PipeWire-down fallback timer (`real` false).
    #[test]
    fn loudness_segments_count_only_played_sound() {
        let mut d = Dsp::new();
        let mut tone = Tone::new(1000.0, -20.0);
        let mut out = vec![0.0; 480 * CH];
        for _ in 0..20 {
            d.process(&mut out, st(-40.0), Some(&mut tone), 0, true);
        }
        assert_eq!(d.segs.len(), 2, "{:?}", d.segs);
        let l = lp_player::audio::loudness::lufs_of(d.segs[1].power);
        assert!((l + 20.0).abs() < 0.2, "pre-gain: {l}");
        d.segs.clear();
        let mut paused = st(-40.0);
        paused.plays = false;
        for _ in 0..40 {
            d.process(&mut out, paused, Some(&mut tone), 0, true);
        }
        for _ in 0..40 {
            d.process(&mut out, st(-40.0), Some(&mut tone), 0, false);
        }
        assert!(d.segs.is_empty(), "paused / fallback: {:?}", d.segs);
    }

    /// `AudioFlowing` once per arming, from the first buffer that pulled the scene's sound
    /// into a real stream — never from a fallback timer, never without a source.
    #[test]
    fn audio_flowing_once_per_arming() {
        let mut d = Dsp::new();
        let mut out = vec![0.0; 64 * CH];
        let mut s = st(SILENT_DB);
        s.arm = 1;
        assert!(!d.process(&mut out, s, None, 0, true), "nothing loaded yet");
        assert!(
            !d.process(&mut out, s, Some(&mut Ones), 0, false),
            "fallback timer"
        );
        assert!(d.process(&mut out, s, Some(&mut Ones), 0, true));
        assert!(!d.process(&mut out, s, Some(&mut Ones), 0, true), "once");
        s.plays = false;
        s.arm = 2;
        assert!(!d.process(&mut out, s, Some(&mut Ones), 0, true), "paused");
        s.plays = true;
        assert!(d.process(&mut out, s, Some(&mut Ones), 0, true));
    }
}
