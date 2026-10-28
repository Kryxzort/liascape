//! The visualiser's audio input (Phase 2 Task 7, owner decision D4): **all system audio, like
//! Wallpaper Engine** — which listens to everything that plays, a wallpaper's own sound
//! included — built as a **mix of PipeWire streams**, one capture per application playback
//! stream, not one opaque monitor capture, so a per-app white/blacklist ([`admit`]) can plug in
//! later. `.claude/rules/player-core.md` § Scene worker → "Real scenes".
//!
//! [`SysMon::start`] runs its own PipeWire thread (`lia-sysmon`): every node of class
//! `Stream/Output/Audio` that [`admit`] lets through (by default: everything but loopback
//! halves — `node.virtual`, which would count a stream twice, e.g. our bus's playback carrying
//! every wallpaper source) gets a passive capture stream `liascape-player-visualiser.<id>` linked to
//! it (`target.object` = its serial; `node.dont-reconnect` + `node.dont-fallback`, so a target
//! that goes away is never replaced by the default source — a microphone). Each capture keeps
//! the last [`FRAME`] mono samples; [`SysMon::frame`] sums every stream that delivered within
//! [`STALE`] into the 1024 u8 samples (centre 128) LWE's visualiser FFT takes
//! (`wp_audio_input_mix`). Read-only: it never plays, links nothing else and changes no
//! routing. The runtime starts it while ≥ 1 live scene wants audio input and drops it when none
//! does. A lost PipeWire connection is retried every [`RETRY`].

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::context::ContextRc;
use pw::core::CoreRc;
use pw::main_loop::MainLoopRc;
use pw::properties::properties;
use pw::spa;
use pw::stream::{StreamListener, StreamRc};
use pw::types::ObjectType;
use serde_json::{Value, json};

use super::bus::{APP_NAME, METER_SCRATCH_CAP, connect, read_capture};
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
const TICK: Duration = Duration::from_millis(20);

/// What a playback stream says about itself (the white/blacklist's input).
#[derive(Debug, Clone, PartialEq)]
pub struct StreamProps {
    pub id: u32,
    pub serial: Option<u64>,
    pub node_name: String,
    pub app_name: String,
    pub binary: String,
    pub media_class: String,
    pub virtual_node: bool,
}

/// Whether a stream is part of the visualiser's mix. **The plug point for a future per-app
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

#[derive(Default)]
struct Tap {
    samples: VecDeque<f32>,
    last: Option<Instant>,
}

struct Shared {
    quit: AtomicBool,
    taps: Mutex<BTreeMap<u32, Arc<Mutex<Tap>>>>,
    streams: Mutex<Vec<StreamProps>>,
    error: Mutex<Option<String>>,
}

/// The running capture (see the module doc). Dropping it stops the thread and every stream.
pub struct SysMon {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl SysMon {
    /// Start the capture thread; never blocks (the connection is made on the thread).
    pub fn start() -> SysMon {
        let shared = Arc::new(Shared {
            quit: AtomicBool::new(false),
            taps: Mutex::new(BTreeMap::new()),
            streams: Mutex::new(Vec::new()),
            error: Mutex::new(None),
        });
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
        let taps: Vec<Arc<Mutex<Tap>>> = self
            .shared
            .taps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        let live: Vec<VecDeque<f32>> = taps
            .iter()
            .filter_map(|t| {
                let t = t.lock().unwrap_or_else(|e| e.into_inner());
                t.last
                    .filter(|l| now.duration_since(*l) <= STALE)
                    .map(|_| t.samples.clone())
            })
            .collect();
        mix_frame(live.iter())
    }

    /// For probes: the streams in the mix and the last connection error.
    pub fn status(&self) -> Value {
        let streams = self
            .shared
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|s| json!({"id": s.id, "node_name": s.node_name, "app": s.app_name}))
            .collect::<Vec<_>>();
        json!({
            "streams": streams,
            "error": *self.shared.error.lock().unwrap_or_else(|e| e.into_inner()),
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
        shared
            .taps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        shared
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let end = Instant::now() + RETRY;
        while Instant::now() < end && !shared.quit.load(Ordering::SeqCst) {
            std::thread::sleep(TICK);
        }
    }
}

#[derive(Default)]
struct Pending {
    added: Vec<StreamProps>,
    removed: Vec<u32>,
    core_error: Option<String>,
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
        .register();
    let registry = core
        .get_registry_rc()
        .map_err(|e| format!("PipeWire registry: {e}"))?;
    let _reg_l = registry
        .add_listener_local()
        .global({
            let p = pending.clone();
            move |g| {
                if g.type_ != ObjectType::Node {
                    return;
                }
                let Some(props) = g.props else { return };
                let s = |k: &str| props.get(k).unwrap_or("").to_string();
                let sp = StreamProps {
                    id: g.id,
                    serial: props.get("object.serial").and_then(|v| v.parse().ok()),
                    node_name: s("node.name"),
                    app_name: s("application.name"),
                    binary: s("application.process.binary"),
                    media_class: s("media.class"),
                    virtual_node: props.get("node.virtual") == Some("true"),
                };
                if admit(&sp) {
                    p.borrow_mut().added.push(sp);
                }
            }
        })
        .global_remove({
            let p = pending.clone();
            move |id| p.borrow_mut().removed.push(id)
        })
        .register();

    let mut live: BTreeMap<u32, (StreamRc, StreamListener<()>)> = BTreeMap::new();
    while !shared.quit.load(Ordering::SeqCst) {
        ml.loop_().iterate(pw::loop_::Timeout::Finite(TICK));
        let (added, removed, err) = {
            let mut p = pending.borrow_mut();
            (
                std::mem::take(&mut p.added),
                std::mem::take(&mut p.removed),
                p.core_error.take(),
            )
        };
        if let Some(e) = err {
            return Err(format!("PipeWire connection error: {e}"));
        }
        for id in removed {
            if live.remove(&id).is_some() {
                shared
                    .taps
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                shared
                    .streams
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .retain(|s| s.id != id);
            }
        }
        for sp in added {
            if live.contains_key(&sp.id) {
                continue;
            }
            match tap_stream(&core, &sp, shared) {
                Ok(s) => {
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
                        .push(sp.clone());
                    live.insert(sp.id, s);
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
    }
    Ok(())
}

/// A passive capture of playback stream `sp` (its serial), downmixed to mono into a tap.
fn tap_stream(
    core: &CoreRc,
    sp: &StreamProps,
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
    let tap = Arc::new(Mutex::new(Tap::default()));
    shared
        .taps
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(sp.id, tap.clone());
    let mut scratch = Vec::with_capacity(METER_SCRATCH_CAP);
    let l = stream
        .add_local_listener_with_user_data(())
        .process(move |st, _| {
            read_capture(st, &mut scratch, 2, |buf, _t| {
                let mut t = tap.lock().unwrap_or_else(|e| e.into_inner());
                for fr in buf.chunks_exact(2) {
                    if t.samples.len() == FRAME {
                        t.samples.pop_front();
                    }
                    t.samples.push_back(0.5 * (fr[0] + fr[1]));
                }
                t.last = Some(Instant::now());
            });
        })
        .register()
        .map_err(|e| format!("stream listener: {e}"))?;
    connect(&stream, spa::utils::Direction::Input)?;
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
}
