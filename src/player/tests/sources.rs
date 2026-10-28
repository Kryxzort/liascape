//! Task 10: libmpv video/image sources + the colour source, on the real GPU.
//!
//! Every `MpvSource` here is opened with `ao: "null"` (R26) so a test run is silent on the
//! owner's speakers — `audio-params` still populate with the null AO, so the audio-path
//! tests still see a real audio chain.
//!
//! **Pixel coordinates: GL bottom-left origin** (`tests/common::read_rgba`). A raw source
//! texture holds the image's TOP row at texture row 0 (R25 / Task 9's orientation
//! convention), so the image's top-left corner is at small `(x, y)` here.
//!
//! **Colour tolerances.** Clips are H.264 `yuv420p` (BT.709 limited range, tagged): solid
//! colours come back within ±3 per channel after RGB→YUV→RGB plus mpv's output dither;
//! `FrameIndex`'s neutral-grey `(n,n,n)` marker within ±1 (luma quantisation only).
//!
//! Skips (prints `SKIP: …`, returns) only when there's no EGL device at all — fails instead
//! under `LIASCAPE_REQUIRE_GPU=1` (`common::skip_gpu`).

mod common;

use std::os::fd::RawFd;
use std::time::{Duration, Instant};

use common::{ClipSpec, ensure_clip, headless_gl, read_rgba};
use glow::HasContext;
use liascape_player::gfx::Gfx;
use liascape_player::graph::PropValue;
use liascape_player::sources::mpv::mpv_hwdec;
use liascape_player::sources::{ColorSource, MpvSource, RenderWorker, Source, SourceEvent};
use serde_json::{Map, Value, json};

/// `opts` for `MpvSource::open`, always with `ao: "null"` (R26).
fn opts(v: Value) -> Map<String, Value> {
    let mut m = v.as_object().expect("opts must be an object").clone();
    m.insert("ao".into(), json!("null"));
    m
}

/// `MpvSource::open`, or — with the render worker on (`LIASCAPE_PLAYER_RENDER_WORKER`, the same
/// switch `serve` reads; § Sources "Render worker") — the same open with the render context
/// on a worker sharing `gfx`'s context, exactly as the real-clock runtime's async open does
/// it (`prepare_core` → `attach_render` → `open_with_core`). Each source gets its own worker;
/// it is joined when the source (its last handle) drops. So the whole file runs in both modes.
fn open_src(
    gfx: &Gfx,
    path: &str,
    o: &Map<String, Value>,
) -> Result<MpvSource, liascape_player::graph::ApiError> {
    if !worker_mode() {
        return MpvSource::open(gfx, path, o);
    }
    let worker = RenderWorker::start(gfx).expect("render worker");
    // The hwdec GL interop exactly when the runtime's async open asks for it (`sources::host`:
    // a hardware `hwdec` this interop can show; an image never).
    let hw = o.get("hwdec").and_then(Value::as_str).unwrap_or("");
    let interop = worker.hwdec_interop().is_some_and(|i| {
        mpv_hwdec(hw, Some(i)) != mpv_hwdec(hw, None)
            && o.get("kind").and_then(Value::as_str) != Some("image")
    });
    let core = MpvSource::prepare_core(o)?.attach_render(&worker, interop)?;
    MpvSource::open_with_core(gfx, path, o, core)
}

fn worker_mode() -> bool {
    liascape_player::runtime::render_worker_enabled(None)
}

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Every test's GPU context — and, with the render worker on, a process-wide lock held for
/// the whole test: one player renders through ONE worker, but 24 of these tests at once are
/// 24 more threads in the NVIDIA driver, whose process-wide lock (libnvidia-glsi; even
/// `glBindTexture` on a shared context takes it) a new context's first `eglMakeCurrent` holds
/// through a GPU ioctl — renders then waited ~1 s (p90 832 ms vs 262 ms on the loop),
/// past mpv's 200 ms VO flip timeout, which drops a still/paused source's only frame
/// (measured; same reason the transition harness and `tests/api.rs` run one at a time).
/// Bind it as `(_serial, gfx)`: locals drop in reverse order, so the context goes before the
/// lock is released.
fn gpu() -> Option<(Option<std::sync::MutexGuard<'static, ()>>, Gfx)> {
    let serial = worker_mode().then(|| SERIAL.lock().unwrap_or_else(|e| e.into_inner()));
    headless_gl().map(|g| (serial, g))
}

fn path_str(p: &std::path::Path) -> &str {
    p.to_str().expect("utf-8 test path")
}

const RED_2S: ClipSpec = ClipSpec::Solid {
    rgb: [255, 0, 0],
    secs: 2.0,
    tone_hz: 440.0,
    tone_dbfs: -20.0,
};

/// Wait (≤ `ms`) for the source's wake fd to become readable — the Task 12 runtime's
/// contract, exercised here instead of a blind sleep.
fn wait_wake(fd: Option<RawFd>, ms: i32) {
    match fd {
        Some(fd) => {
            let mut p = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe { libc::poll(&mut p, 1, ms) };
        }
        None => std::thread::sleep(Duration::from_millis(ms as u64)),
    }
}

/// Drive `src` (update + poll_events) until `done` says so or `timeout` passes. Returns
/// every event seen and whether `done` was satisfied.
fn pump<S: Source>(
    gfx: &Gfx,
    src: &mut S,
    wake: Option<RawFd>,
    timeout: Duration,
    mut done: impl FnMut(&[SourceEvent], &S) -> bool,
) -> (Vec<SourceEvent>, bool) {
    let t0 = Instant::now();
    let mut seen = Vec::new();
    loop {
        src.update(gfx);
        seen.extend(src.poll_events());
        if done(&seen, src) {
            return (seen, true);
        }
        if t0.elapsed() >= timeout {
            return (seen, false);
        }
        wait_wake(wake, 10);
    }
}

fn has(evs: &[SourceEvent], want: &SourceEvent) -> bool {
    evs.iter().any(|e| e == want)
}

fn ended(evs: &[SourceEvent]) -> bool {
    has(evs, &SourceEvent::Ended)
}

fn ready(evs: &[SourceEvent]) -> bool {
    has(evs, &SourceEvent::Ready)
}

fn assert_rgb(px: [u8; 4], want: [u8; 3], tol: i32, what: &str) {
    for c in 0..3 {
        let d = (px[c] as i32 - want[c] as i32).abs();
        assert!(
            d <= tol,
            "{what}: pixel {px:?} vs expected {want:?} (±{tol}) — channel {c} off by {d}"
        );
    }
}

/// Pump until every async mpv request this source issued has been answered (≤ 2 s) —
/// after this, raw `mpv_get_*` reads reflect every `apply` so far.
fn settle(gfx: &Gfx, src: &mut MpvSource) -> Vec<SourceEvent> {
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(gfx, src, wake, Duration::from_secs(2), |_, s| {
        s.requests_in_flight() == 0
    });
    assert!(ok, "async mpv requests never settled; events: {evs:?}");
    evs
}

fn centre(gfx: &Gfx, src: &impl Source) -> [u8; 4] {
    let tex = src.texture().expect("texture");
    read_rgba(gfx, tex, tex.w / 2, tex.h / 2)
}

const BLUE_1S: ClipSpec = ClipSpec::Solid {
    rgb: [0, 0, 255],
    secs: 1.0,
    tone_hz: 440.0,
    tone_dbfs: -20.0,
};

fn rejections(evs: &[SourceEvent]) -> Vec<String> {
    evs.iter()
        .filter_map(|e| match e {
            SourceEvent::Rejected { prop, reason } => Some(format!("{prop}: {reason}")),
            _ => None,
        })
        .collect()
}

fn errors(evs: &[SourceEvent]) -> Vec<String> {
    evs.iter()
        .filter_map(|e| match e {
            SourceEvent::Error { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

fn open_ready(gfx: &Gfx, path: &str, o: Value) -> MpvSource {
    let mut src = open_src(gfx, path, &opts(o)).expect("MpvSource::open");
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(gfx, &mut src, wake, Duration::from_secs(3), |e, _| ready(e));
    assert!(ok, "no Ready within 3 s for {path}; events: {evs:?}");
    src
}

#[test]
fn first_frame_and_ready() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let src = open_ready(&gfx, path_str(&clip), json!({}));
    assert_eq!(src.kind(), "video");
    assert_eq!(src.read("ready"), Some(PropValue::Bool(true)));
    let tex = src.texture().expect("texture after Ready");
    assert_eq!((tex.w, tex.h), (1920, 1080), "native video size");
    assert_eq!(src.size(), (1920, 1080));
    assert_eq!(src.read("width"), Some(PropValue::I64(1920)));
    assert_eq!(src.read("height"), Some(PropValue::I64(1080)));
    let px = read_rgba(&gfx, tex, tex.w / 2, tex.h / 2);
    assert_rgb(px, [255, 0, 0], 3, "centre of solid red");
    // libmpv's render (with the glFenceSync stub) leaves no GL error behind.
    assert_eq!(
        unsafe { gfx.gl.get_error() },
        glow::NO_ERROR,
        "GL error after mpv render"
    );
}

/// R25: mpv renders with `MPV_RENDER_PARAM_FLIP_Y = 0` into the source FBO, which must
/// land the image's TOP row at texture row 0 (t = 0, GL's bottom row) — the same layout
/// as uploading image rows top-down, which is what `gfx::compose` expects of a raw source.
#[test]
fn source_texture_holds_image_top_at_t0() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip(
        "split_red_over_blue",
        ClipSpec::SplitV {
            top: [255, 0, 0],
            bottom: [0, 0, 255],
            secs: 2.0,
        },
    );
    let src = open_ready(&gfx, path_str(&clip), json!({"paused": true}));
    let tex = src.texture().expect("texture after Ready");
    let low = read_rgba(&gfx, tex, tex.w / 2, tex.h / 8);
    let high = read_rgba(&gfx, tex, tex.w / 2, tex.h * 7 / 8);
    assert_rgb(
        low,
        [255, 0, 0],
        3,
        "low y (t≈0) must be the image TOP (red)",
    );
    assert_rgb(
        high,
        [0, 0, 255],
        3,
        "high y must be the image BOTTOM (blue)",
    );
}

#[test]
fn frame_exact_seek() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 });
    let mut src = open_ready(&gfx, path_str(&clip), json!({"paused": true}));
    let wake = Some(src.wake_fd());

    src.apply("position", &PropValue::F64(2.0))
        .expect("seek applies");
    let (evs, ok) = pump(
        &gfx,
        &mut src,
        wake,
        Duration::from_secs(3),
        |_, s| matches!(s.read("time_pos"), Some(PropValue::F64(t)) if (t - 2.0).abs() < 1e-3),
    );
    assert!(
        ok,
        "time_pos never reached 2.0 (got {:?}); events: {evs:?}",
        src.read("time_pos")
    );
    // Paused: let any frame still in flight land, then the held frame must be frame 60.
    pump(&gfx, &mut src, wake, Duration::from_millis(300), |_, _| {
        false
    });
    let tex = src.texture().expect("texture");
    let px = read_rgba(&gfx, tex, 32, 32);
    assert_rgb(
        px,
        [60, 60, 60],
        1,
        "top-left marker after seek to 2.0 s (frame 60)",
    );
    // The rest of the frame is mid-grey — proves we read the marker, not a flat frame.
    let rest = read_rgba(&gfx, tex, tex.w / 2, tex.h / 2);
    assert_rgb(rest, [128, 128, 128], 2, "mid-grey background");
}

/// § Sources "Hardware decoding": a hardware `hwdec` on the render worker decodes zero-copy
/// through the worker's GL interop (nvdec frames written into mpv's textures by CUDA, then
/// rendered into ours on the lane and fenced) — and the picture is exactly the software
/// one: orientation (R25), colours within ±3, a frame-exact seek's marker within ±1, frames
/// advancing while playing. On the loop (worker off) the same `hwdec` stays a copy mode with
/// no interop in the render context (Task 20d). Torn/stale frames under fence faults with the
/// interop: `tests/api.rs::render_worker_never_composes_a_torn_frame` (its `hwdec: auto` cases).
#[test]
fn hardware_decoding_matches_software_in_both_render_modes() {
    let Some((_serial, gfx)) = gpu() else { return };
    let split = ensure_clip(
        "split_red_over_blue",
        ClipSpec::SplitV {
            top: [255, 0, 0],
            bottom: [0, 0, 255],
            secs: 2.0,
        },
    );
    let src = open_ready(
        &gfx,
        path_str(&split),
        json!({"paused": true, "hwdec": "auto"}),
    );
    let interop = src.hwdec_interop();
    let cur = src.mpv_get_string("hwdec-current").unwrap_or_default();
    let loaded = src.mpv_get_string("gpu-hwdec-interop").unwrap_or_default();
    println!(
        "render {}: interop {interop:?} (mpv {loaded:?}), hwdec {:?} → {cur:?}",
        src.render_mode(),
        src.mpv_get_string("hwdec")
    );
    if worker_mode() {
        assert_eq!(src.render_mode(), "worker");
        assert_eq!(loaded, interop.unwrap_or("no"));
        if interop == Some("cuda") {
            assert_eq!(cur, "nvdec", "the CUDA interop is loaded: zero-copy nvdec");
        }
    } else {
        assert_eq!(interop, None);
        assert_eq!(loaded, "no", "no interop init in a loop render context");
        assert!(cur == "no" || cur.ends_with("-copy"), "{cur:?}");
    }
    let tex = src.texture().expect("texture after Ready");
    assert_rgb(
        read_rgba(&gfx, tex, tex.w / 2, tex.h / 8),
        [255, 0, 0],
        3,
        "low y (t≈0) must be the image TOP (red)",
    );
    assert_rgb(
        read_rgba(&gfx, tex, tex.w / 2, tex.h * 7 / 8),
        [0, 0, 255],
        3,
        "high y must be the image BOTTOM (blue)",
    );
    drop(src);

    let clip = ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 });
    let mut src = open_ready(
        &gfx,
        path_str(&clip),
        json!({"paused": true, "hwdec": "auto"}),
    );
    let wake = Some(src.wake_fd());
    src.apply("position", &PropValue::F64(2.0))
        .expect("seek applies");
    let (evs, ok) = pump(
        &gfx,
        &mut src,
        wake,
        Duration::from_secs(3),
        |_, s| matches!(s.read("time_pos"), Some(PropValue::F64(t)) if (t - 2.0).abs() < 1e-3),
    );
    assert!(ok, "time_pos never reached 2.0; events: {evs:?}");
    pump(&gfx, &mut src, wake, Duration::from_millis(300), |_, _| {
        false
    });
    let tex = src.texture().expect("texture");
    assert_rgb(
        read_rgba(&gfx, tex, 32, 32),
        [60, 60, 60],
        1,
        "marker after a seek to 2.0 s (frame 60)",
    );
    assert_rgb(
        read_rgba(&gfx, tex, tex.w / 2, tex.h / 2),
        [128, 128, 128],
        2,
        "mid-grey background",
    );
    // Playing: the texture keeps following the decoder (every adopted frame a whole one —
    // a marker on the ladder, never a blend of two).
    src.apply("paused", &PropValue::Bool(false)).unwrap();
    let mut markers = Vec::new();
    let t = Instant::now();
    while t.elapsed() < Duration::from_millis(900) {
        pump(&gfx, &mut src, wake, Duration::from_millis(40), |_, _| {
            false
        });
        if let Some(tex) = src.texture() {
            let px = read_rgba(&gfx, tex, 32, 32);
            assert!(
                (px[0] as i32 - px[1] as i32).abs() <= 1
                    && (px[1] as i32 - px[2] as i32).abs() <= 1,
                "marker not grey (torn/garbled frame?): {px:?}"
            );
            markers.push(px[0]);
        }
    }
    markers.dedup();
    assert!(
        markers.len() >= 10 && markers.windows(2).all(|w| w[1] > w[0]),
        "frames must advance while playing: {markers:?}"
    );
}

/// `loop = true`: never `Ended`; `Position` keeps flowing at ≤ ~10 Hz.
#[test]
fn loop_never_ends_and_position_is_rate_limited() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip(
        "solid_blue_1s",
        ClipSpec::Solid {
            rgb: [0, 0, 255],
            secs: 1.0,
            tone_hz: 440.0,
            tone_dbfs: -20.0,
        },
    );
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({"loop": true}))).expect("open");
    let wake = Some(src.wake_fd());
    let (evs, _) = pump(&gfx, &mut src, wake, Duration::from_millis(2500), |_, _| {
        false
    });
    assert!(ready(&evs), "no Ready: {evs:?}");
    assert!(!ended(&evs), "loop=true must never end: {evs:?}");
    let pos: Vec<f64> = evs
        .iter()
        .filter_map(|e| match e {
            SourceEvent::Position(t) => Some(*t),
            _ => None,
        })
        .collect();
    assert!(
        (5..=27).contains(&pos.len()),
        "{} Position events in 2.5 s (want ~10 Hz, max ~25)",
        pos.len()
    );
    assert!(
        pos.windows(2).any(|w| w[1] < w[0]),
        "position must wrap on loop: {pos:?}"
    );
}

/// The `glFenceSync` stub (mpvpaper PR #132 technique) is on libmpv's actual path.
#[test]
fn fence_sync_stub_is_used() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_ready(&gfx, path_str(&clip), json!({}));
    let wake = Some(src.wake_fd());
    pump(&gfx, &mut src, wake, Duration::from_millis(300), |_, _| {
        false
    });
    assert!(
        liascape_player::sources::mpv::fence_stub_calls() > 0,
        "libmpv never called glFenceSync through our get_proc_address"
    );
}

#[test]
fn ended_holds_last_frame() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip(
        "solid_blue_1s",
        ClipSpec::Solid {
            rgb: [0, 0, 255],
            secs: 1.0,
            tone_hz: 440.0,
            tone_dbfs: -20.0,
        },
    );
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({"loop": false}))).expect("open");
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(5), |e, _| {
        ended(e)
    });
    assert!(ok, "no Ended within 5 s; events: {evs:?}");
    let ready_at = evs.iter().position(|e| *e == SourceEvent::Ready);
    let ended_at = evs.iter().position(|e| *e == SourceEvent::Ended);
    assert!(
        ready_at.is_some() && ready_at < ended_at,
        "Ready must precede Ended: {evs:?}"
    );

    // keep-open: the last frame stays, and Ended fires once per play-through.
    let (more, _) = pump(&gfx, &mut src, wake, Duration::from_millis(500), |_, _| {
        false
    });
    assert!(!ended(&more), "Ended fired twice: {more:?}");
    let tex = src.texture().expect("texture held after end");
    let px = read_rgba(&gfx, tex, tex.w / 2, tex.h / 2);
    assert_rgb(px, [0, 0, 255], 3, "held last frame after Ended");
    // keep-open-pause=no: mpv must not flip `pause` at EOF (the graph never asked).
    assert_eq!(
        src.read("paused"),
        Some(PropValue::Bool(false)),
        "EOF must not pause the source"
    );

    // A seek back after the end plays again: new frames, time advancing, a second Ended.
    src.apply("position", &PropValue::F64(0.0)).unwrap();
    let t0 = Instant::now();
    let (mut frames, mut evs2) = (0, Vec::new());
    while t0.elapsed() < Duration::from_secs(4) && !ended(&evs2) {
        if src.update(&gfx) {
            frames += 1;
        }
        evs2.extend(src.poll_events());
        wait_wake(wake, 10);
    }
    assert!(
        frames >= 5,
        "only {frames} new frames after seeking back from the end"
    );
    assert!(
        evs2.iter()
            .any(|e| matches!(e, SourceEvent::Position(t) if *t > 0.3)),
        "time_pos never advanced after the seek: {evs2:?}"
    );
    assert!(
        ended(&evs2),
        "no second Ended for the second play-through: {evs2:?}"
    );
    assert_rgb(
        centre(&gfx, &src),
        [0, 0, 255],
        3,
        "held after the second end",
    );
}

#[test]
fn gain_maps_to_volume_gain() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    src.apply("gain.user", &PropValue::F64(-6.0)).unwrap();
    src.apply("gain.xfade", &PropValue::F64(-3.0103)).unwrap();
    settle(&gfx, &mut src);
    let vg = src
        .mpv_get_f64("volume-gain")
        .expect("volume-gain readable");
    assert!(
        (vg - -9.0103).abs() < 1e-3,
        "volume-gain = {vg}, want -9.0103 (sum of slots in dB)"
    );
    assert_eq!(src.mpv_get_f64("volume"), Some(100.0), "volume stays 100");
    assert_eq!(src.read("gain.user"), Some(PropValue::F64(-6.0)));
    // Mute dominates down to the -96 dB floor (volume-gain-min=-96 lets mpv accept it).
    src.apply("gain.mute", &PropValue::F64(-96.0)).unwrap();
    settle(&gfx, &mut src);
    assert_eq!(src.mpv_get_f64("volume-gain"), Some(-96.0));
}

#[test]
fn image_source() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("image_green", ClipSpec::Image { rgb: [0, 255, 0] });
    let mut src = open_ready(&gfx, path_str(&clip), json!({}));
    assert_eq!(src.kind(), "image");
    let tex = src.texture().expect("texture");
    let px = read_rgba(&gfx, tex, tex.w / 2, tex.h / 2);
    assert_rgb(px, [0, 255, 0], 3, "centre of green image");
    assert_eq!(src.read("duration"), None, "an image has no duration");
    let wake = Some(src.wake_fd());
    let (evs, _) = pump(&gfx, &mut src, wake, Duration::from_secs(2), |e, _| {
        ended(e)
    });
    assert!(!ended(&evs), "an image must never end: {evs:?}");
}

/// mpv's VO waits only 200 ms for us to render a frame (vo_libmpv `flip_page`), then drops it. A
/// playing source sends the next one, but a paused source (a transition's pending B) or an image has
/// none: when its only frame went unrendered — the loop busy past that (a burst of switches and
/// teardowns, a debug build, a loaded machine), or not yet knowing the size to render at — it never
/// became Ready and the switch failed after 10 s ("no first frame"; the UI matrix's
/// race:settingsDuringApply, 4/4 on the debug player). Here nothing pumps or renders the source while
/// mpv shows its first frame and gives up on it — then it must still become Ready, with that frame.
#[test]
fn dropped_first_frame_of_a_paused_source_or_image_still_readies() {
    let Some((_serial, gfx)) = gpu() else { return };
    let red = ensure_clip("solid_red_2s", RED_2S);
    let green = ensure_clip("image_green", ClipSpec::Image { rgb: [0, 255, 0] });
    for (path, o, rgb) in [
        (&red, json!({"paused": true}), [255, 0, 0]),
        (&green, json!({}), [0, 255, 0]),
    ] {
        let mut src = open_src(&gfx, path_str(path), &opts(o)).expect("MpvSource::open");
        std::thread::sleep(Duration::from_millis(800)); // the loop stalls: > 3 × mpv's flip timeout
        let wake = Some(src.wake_fd());
        let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
            ready(e)
        });
        assert!(
            ok,
            "{}: never Ready after its first frame was dropped; events: {evs:?}",
            path.display()
        );
        let tex = src.texture().expect("texture after Ready");
        assert_rgb(
            read_rgba(&gfx, tex, tex.w / 2, tex.h / 2),
            rgb,
            3,
            "the first frame",
        );
    }
}

/// A short clip that plays to its end before anything rendered it (the loop or the render worker
/// stalled): it still becomes Ready with its last frame, and `Ended` comes after `Ready` in either
/// renderer — the loop renderer used to report Ended first (a loaded full run failed
/// `ended_holds_last_frame`), and an ended clip, like a paused one, has no next frame to render.
#[test]
fn clip_ended_before_any_render_readies_then_ends() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip(
        "solid_blue_1s",
        ClipSpec::Solid {
            rgb: [0, 0, 255],
            secs: 1.0,
            tone_hz: 440.0,
            tone_dbfs: -20.0,
        },
    );
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({"loop": false}))).expect("open");
    std::thread::sleep(Duration::from_millis(1800)); // the whole clip plays out unrendered
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        ended(e)
    });
    assert!(ok, "no Ended within 3 s; events: {evs:?}");
    let ready_at = evs.iter().position(|e| *e == SourceEvent::Ready);
    let ended_at = evs.iter().position(|e| *e == SourceEvent::Ended);
    assert!(
        ready_at.is_some() && ready_at < ended_at,
        "Ready must precede Ended: {evs:?}"
    );
    let tex = src.texture().expect("texture after Ready");
    assert_rgb(
        read_rgba(&gfx, tex, tex.w / 2, tex.h / 2),
        [0, 0, 255],
        3,
        "its last frame",
    );
}

#[test]
fn no_audio_live() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_ready(&gfx, path_str(&clip), json!({"loop": true}));
    let wake = Some(src.wake_fd());
    let audio_up = |s: &MpvSource| s.mpv_get_string("audio-params/samplerate").is_some();

    let (_, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |_, s| {
        audio_up(s)
    });
    assert!(ok, "audio-params never populated at start");

    // `options/aid` is the raw option we set; the `aid` *property* reads back the
    // selected track id ("1") once `auto` has picked one, so it can't show "auto".
    src.apply("no_audio", &PropValue::Bool(true)).unwrap();
    settle(&gfx, &mut src);
    assert_eq!(src.mpv_get_string("options/aid").as_deref(), Some("no"));
    assert_eq!(src.mpv_get_string("aid").as_deref(), Some("no"));
    let (_, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |_, s| {
        !audio_up(s)
    });
    assert!(ok, "audio-params still set after no_audio=true");

    src.apply("no_audio", &PropValue::Bool(false)).unwrap();
    settle(&gfx, &mut src);
    assert_eq!(src.mpv_get_string("options/aid").as_deref(), Some("auto"));
    let (_, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |_, s| {
        audio_up(s)
    });
    assert!(
        ok,
        "audio-params not set again after no_audio=false (AO re-init)"
    );
    assert_eq!(
        src.mpv_get_string("aid").as_deref(),
        Some("1"),
        "auto picked the track"
    );
}

/// R92 (review of Task 16c/16d): `has_audio` must reflect what mpv actually resolved —
/// `true` for a clip with a real audio stream, `false` for one with none at all
/// (`ClipSpec::FrameIndex`, which `ensure_clip`'s own doc says carries no audio). This is
/// distinct from `no_audio` ([`no_audio_live`] above, our own request to disable it): a
/// file that simply never had an audio track must resolve to `false` here on its own,
/// with nothing else asked of it.
#[test]
fn has_audio_reflects_real_track_presence() {
    let Some((_serial, gfx)) = gpu() else { return };

    let with_audio = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_ready(&gfx, path_str(&with_audio), json!({}));
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |_, s| {
        s.read("has_audio") == Some(PropValue::Bool(true))
    });
    assert!(
        ok,
        "has_audio never became true for a clip with audio: {evs:?}"
    );

    let no_audio_clip = ensure_clip("frame_index_90_r92", ClipSpec::FrameIndex { frames: 90 });
    let mut src2 = open_ready(&gfx, path_str(&no_audio_clip), json!({}));
    let wake2 = Some(src2.wake_fd());
    let (evs2, ok2) = pump(&gfx, &mut src2, wake2, Duration::from_secs(3), |_, s| {
        s.read("has_audio") == Some(PropValue::Bool(false))
    });
    assert!(
        ok2,
        "has_audio never became false for a clip with no audio stream: {evs2:?}"
    );
}

/// The brief's property map, checked against what mpv itself reports.
#[test]
fn property_map_reaches_mpv() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    let s = |src: &MpvSource, n: &str| src.mpv_get_string(n).unwrap_or_default();
    // Every apply is async on the render thread; settle before reading mpv back.
    let ap = |src: &mut MpvSource, p: &str, v: PropValue| {
        src.apply(p, &v).unwrap();
        settle(&gfx, src);
    };

    ap(&mut src, "loop", PropValue::Bool(true));
    assert_eq!(s(&src, "loop-file"), "inf");
    ap(&mut src, "loop", PropValue::Bool(false));
    assert_eq!(s(&src, "loop-file"), "no");
    ap(&mut src, "paused", PropValue::Bool(true));
    assert_eq!(s(&src, "pause"), "yes");
    ap(&mut src, "speed", PropValue::F64(1.5));
    assert_eq!(src.mpv_get_f64("speed"), Some(1.5));
    ap(&mut src, "hwdec", PropValue::Str("no".into()));
    assert_eq!(s(&src, "hwdec"), "no");
    // Task 20d: copy modes only (no GL interop init on the loop); the graph keeps the
    // user's value.
    assert_eq!(s(&src, "gpu-hwdec-interop"), "no");
    ap(&mut src, "hwdec", PropValue::Str("auto".into()));
    assert_eq!(s(&src, "hwdec"), "nvdec-copy,vaapi-copy,auto-copy");
    assert_eq!(src.read("hwdec"), Some(PropValue::Str("auto".into())));
    ap(&mut src, "hwdec", PropValue::Str("nvdec".into()));
    assert_eq!(s(&src, "hwdec"), "nvdec-copy");
    ap(&mut src, "hwdec", PropValue::Str("no".into()));
    ap(&mut src, "fps_cap", PropValue::F64(24.0));
    assert!(s(&src, "vf").contains("fps"), "vf = {:?}", s(&src, "vf"));
    ap(&mut src, "fps_cap", PropValue::F64(0.0));
    assert_eq!(s(&src, "vf"), "");
    ap(&mut src, "cache", PropValue::Bool(false));
    assert_eq!(s(&src, "cache"), "no");
    // `cache: true` = mpv's normal policy (`auto`, the legacy engine's DisableCache=false),
    // not a forced `yes` (which would RAM-cache every local wallpaper).
    ap(&mut src, "cache", PropValue::Bool(true));
    assert_eq!(s(&src, "cache"), "auto");
    ap(&mut src, "cache", PropValue::Bool(false));
    ap(&mut src, "demuxer_max_mib", PropValue::F64(32.0));
    assert_eq!(src.mpv_get_f64("demuxer-max-bytes"), Some(32.0 * 1048576.0));
    ap(&mut src, "demuxer_max_mib", PropValue::F64(1.5));
    assert_eq!(src.mpv_get_f64("demuxer-max-bytes"), Some(1.5 * 1048576.0));
    ap(&mut src, "demuxer_max_mib", PropValue::F64(0.0));
    assert_eq!(
        src.mpv_get_f64("demuxer-max-bytes"),
        Some(150.0 * 1048576.0),
        "0 = unset → mpv's default (legacy convention)"
    );
    ap(&mut src, "demuxer_back_mib", PropValue::F64(8.0));
    assert_eq!(
        src.mpv_get_f64("demuxer-max-back-bytes"),
        Some(8.0 * 1048576.0)
    );
    ap(&mut src, "af", PropValue::Str("lavfi=[anull]".into()));
    assert!(s(&src, "af").contains("anull"), "af = {:?}", s(&src, "af"));
    ap(&mut src, "audio_delay", PropValue::F64(0.25));
    assert_eq!(src.mpv_get_f64("audio-delay"), Some(0.25));
    // Every applied value reads back through the Source.
    assert_eq!(src.read("speed"), Some(PropValue::F64(1.5)));
    assert_eq!(src.read("cache"), Some(PropValue::Bool(false)));
}

/// `path` is live too: a new file loads into the same source, `Ready` fires again, the
/// old frame is held until the new one lands, and `kind` follows mpv's image flag.
#[test]
fn path_change_is_live() {
    let Some((_serial, gfx)) = gpu() else { return };
    let red = ensure_clip("solid_red_2s", RED_2S);
    let green = ensure_clip("image_green", ClipSpec::Image { rgb: [0, 255, 0] });
    let mut src = open_ready(&gfx, path_str(&red), json!({"loop": true}));
    assert_eq!(src.kind(), "video");
    src.apply("path", &PropValue::Str(path_str(&green).into()))
        .unwrap();
    assert!(
        src.texture().is_some(),
        "last good frame held across the reload"
    );
    let wake = Some(src.wake_fd());
    let mut held_checks = 0;
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, s| {
        if !ready(e) {
            // Until the new file's Ready, update() keeps running but the texture must
            // still be the OLD file's frame (never a blank/old redraw/half-loaded one).
            held_checks += 1;
            assert_rgb(
                centre(&gfx, s),
                [255, 0, 0],
                3,
                "old frame held before Ready",
            );
        }
        ready(e)
    });
    assert!(ok, "no second Ready after the path change: {evs:?}");
    assert!(held_checks >= 1, "never observed the held frame");
    assert_eq!(src.kind(), "image");
    assert_eq!(src.read("duration"), None);
    let tex = src.texture().expect("texture");
    assert_rgb(
        read_rgba(&gfx, tex, tex.w / 2, tex.h / 2),
        [0, 255, 0],
        3,
        "new file shown",
    );
}

/// Fix round 1 (#1): after `open`, `apply` never makes a synchronous core call on the
/// render thread. Provoke the window where a sync call would stall — frames queued that
/// we don't render (vo_libmpv waits on the render thread) plus a seek (the core waits on
/// the VO for the first frame after the restart) — and time a burst of per-frame-style
/// gain changes.
#[test]
fn apply_never_blocks_the_render_thread() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_ready(&gfx, path_str(&clip), json!({"loop": true}));
    std::thread::sleep(Duration::from_millis(80)); // render thread "busy": no update()
    let t = Instant::now();
    src.apply("position", &PropValue::F64(0.5)).unwrap();
    let mut worst = t.elapsed();
    let mut last = 0.0;
    for i in 0..240 {
        last = -(i as f64) * 0.1;
        let t = Instant::now();
        src.apply("gain.xfade", &PropValue::F64(last)).unwrap();
        worst = worst.max(t.elapsed());
    }
    assert!(
        worst <= Duration::from_millis(2),
        "an apply blocked the render thread for {worst:?}"
    );
    let evs = settle(&gfx, &mut src);
    assert!(
        errors(&evs).is_empty() && rejections(&evs).is_empty(),
        "burst produced errors: {evs:?}"
    );
    let vg = src.mpv_get_f64("volume-gain").unwrap();
    // mpv stores volume-gain as a float option (single precision).
    assert!(
        (vg - last).abs() < 1e-4,
        "final volume-gain {vg}, want {last}"
    );
}

/// Fix round 1 (#1): a value mpv rejects (after the synchronous schema gate passed)
/// surfaces as `SourceEvent::Error` naming the property — and `read` reverts.
/// R45: a refused write is `Rejected` (the source is fine), never a load `Error`.
#[test]
fn rejected_property_is_a_rejected_event() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_ready(&gfx, path_str(&clip), json!({}));
    let before = src.read("af");
    src.apply("af", &PropValue::Str("no_such_filter_lp".into()))
        .expect("shape is valid: apply returns Ok, mpv's verdict arrives async");
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(2), |e, _| {
        !rejections(e).is_empty()
    });
    assert!(ok, "no Rejected event for a rejected af: {evs:?}");
    assert!(
        errors(&evs).is_empty(),
        "a refused write is not an Error: {evs:?}"
    );
    let reason = rejections(&evs).remove(0);
    assert!(
        reason.starts_with("af: ") && reason.contains("no_such_filter_lp"),
        "Rejected must name the property and value: {reason}"
    );
    assert_eq!(
        src.read("af"),
        before,
        "rejected value must not stick in read()"
    );
}

/// Fix round 1 (#3a): a path change before the first pump — only the NEW file may ever
/// produce `Ready`, exactly once, and the texture at that moment is the new file's.
#[test]
fn path_change_before_first_pump_shows_only_new_file() {
    let Some((_serial, gfx)) = gpu() else { return };
    let red = ensure_clip("solid_red_2s", RED_2S);
    let blue = ensure_clip("solid_blue_1s", BLUE_1S);
    let mut src = open_src(&gfx, path_str(&red), &opts(json!({"loop": true}))).expect("open");
    // Let A load fully — its FILE_LOADED / PLAYBACK_RESTART / first frame all queued —
    // without pumping anything, then move on: every one of those is now stale.
    std::thread::sleep(Duration::from_millis(300));
    src.apply("path", &PropValue::Str(path_str(&blue).into()))
        .unwrap();
    let wake = Some(src.wake_fd());
    let (mut readies, mut at_ready) = (0, Vec::new());
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(2500) {
        src.update(&gfx);
        for e in src.poll_events() {
            if e == SourceEvent::Ready {
                readies += 1;
                at_ready.push(centre(&gfx, &src));
            }
        }
        wait_wake(wake, 10);
    }
    assert_eq!(
        readies, 1,
        "exactly one Ready (texture colours at Ready: {at_ready:?})"
    );
    assert_rgb(
        at_ready[0],
        [0, 0, 255],
        3,
        "texture at Ready must be the new file",
    );
}

/// Fix round 1 (#3, stale END_FILE): a load that fails *after* the path already moved on
/// must not be reported — least of all under the NEW path — and the new file plays.
#[test]
fn stale_load_error_is_not_reported_for_new_path() {
    let Some((_serial, gfx)) = gpu() else { return };
    let red = ensure_clip("solid_red_2s", RED_2S);
    let missing = "/nonexistent/liascape-player-stale-error.mkv";
    let mut src = open_src(&gfx, missing, &opts(json!({"loop": true}))).expect("open");
    std::thread::sleep(Duration::from_millis(300)); // A's END_FILE(ERROR) queued, unpumped
    src.apply("path", &PropValue::Str(path_str(&red).into()))
        .unwrap();
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        ready(e)
    });
    assert!(ok, "no Ready for the new path: {evs:?}");
    let (more, _) = pump(&gfx, &mut src, wake, Duration::from_millis(300), |_, _| {
        false
    });
    let errs: Vec<String> = errors(&evs).into_iter().chain(errors(&more)).collect();
    assert!(errs.is_empty(), "stale load error leaked: {errs:?}");
    assert_rgb(centre(&gfx, &src), [255, 0, 0], 3, "new file shown");
}

/// Fix round 1 (#3b): a path change to a missing file reports an Error naming THAT
/// path (the old frame stays), and changing back to a valid file recovers with Ready.
#[test]
fn path_change_to_missing_then_back() {
    let Some((_serial, gfx)) = gpu() else { return };
    let red = ensure_clip("solid_red_2s", RED_2S);
    let green = ensure_clip("image_green", ClipSpec::Image { rgb: [0, 255, 0] });
    let mut src = open_ready(&gfx, path_str(&red), json!({"loop": true}));
    let missing = "/nonexistent/liascape-player-path-change-missing.mkv";
    src.apply("path", &PropValue::Str(missing.into())).unwrap();
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        !errors(e).is_empty()
    });
    assert!(ok, "no Error for the missing path: {evs:?}");
    let errs = errors(&evs);
    assert!(
        errs.len() == 1 && errs[0].contains(missing),
        "one Error naming the missing path: {errs:?}"
    );
    assert!(!ready(&evs), "no Ready for a file that failed: {evs:?}");
    assert_rgb(
        centre(&gfx, &src),
        [255, 0, 0],
        3,
        "old frame held after a failed load",
    );

    src.apply("path", &PropValue::Str(path_str(&green).into()))
        .unwrap();
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        ready(e)
    });
    assert!(ok, "no Ready after changing back to a valid file: {evs:?}");
    assert!(
        errors(&evs).is_empty(),
        "stale errors after recovery: {evs:?}"
    );
    assert_rgb(centre(&gfx, &src), [0, 255, 0], 3, "recovered file shown");
}

/// Fix round 1 (#6): a string with an interior NUL is rejected — never silently
/// truncated/stripped into a different path or filter.
#[test]
fn nul_bytes_are_rejected() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let code = |r: Result<(), liascape_player::graph::ApiError>| r.unwrap_err().code;
    let nul_path = format!("{}\0.png", path_str(&clip));
    assert_eq!(
        open_src(&gfx, &nul_path, &opts(json!({})))
            .err()
            .map(|e| e.code),
        Some("out_of_range")
    );
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    assert_eq!(
        code(src.apply("path", &PropValue::Str(nul_path.clone()))),
        "out_of_range"
    );
    assert_eq!(
        code(src.apply("af", &PropValue::Str("anull\0x".into()))),
        "out_of_range"
    );
    assert_eq!(
        src.read("path"),
        Some(PropValue::Str(path_str(&clip).into()))
    );
}

/// Fix round 1 (#7): every schema default is pushed at open, so `read` and mpv agree
/// before anything is applied.
#[test]
fn defaults_applied_at_open_match_mpv() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    settle(&gfx, &mut src);
    let s = |n: &str| src.mpv_get_string(n).unwrap_or_default();
    assert_eq!(src.read("cache"), Some(PropValue::Bool(true)));
    assert_eq!(
        s("cache"),
        "auto",
        "cache:true = mpv's normal (auto) policy"
    );
    assert_eq!(src.read("paused"), Some(PropValue::Bool(false)));
    assert_eq!(s("pause"), "no");
    assert_eq!(src.read("loop"), Some(PropValue::Bool(false)));
    assert_eq!(s("loop-file"), "no");
    assert_eq!(src.read("hwdec"), Some(PropValue::Str(String::new())));
    assert_eq!(s("hwdec"), "no");
    assert_eq!(s("vf"), "");
    assert_eq!(src.read("af"), Some(PropValue::Str(String::new())));
    assert!(
        s("af").contains("scaletempo2"),
        "mpv's chain always holds a tempo filter (speed storm): af = {:?}",
        s("af")
    );
    assert_eq!(s("options/aid"), "auto");
    assert_eq!(src.mpv_get_f64("speed"), Some(1.0));
    assert_eq!(src.mpv_get_f64("audio-delay"), Some(0.0));
    assert_eq!(
        src.mpv_get_f64("demuxer-max-bytes"),
        Some(150.0 * 1048576.0)
    );
    assert_eq!(
        src.mpv_get_f64("demuxer-max-back-bytes"),
        Some(50.0 * 1048576.0)
    );
    assert_eq!(src.mpv_get_f64("volume-gain"), Some(0.0));
    assert_eq!(src.mpv_get_f64("volume"), Some(100.0));
}

/// TODO "mpv's built-in Lua scripts per core": every core used to start six Lua script
/// threads (`lua/commands`, `lua/console`, `lua/context_menu`, `lua/positioning`,
/// `lua/select`, `lua/stats` — 6 of a 1080p core's 28 threads, measured) for an OSD, a
/// console and menus nobody can open on a wallpaper. Each option reads back `no`, and no
/// `lua/*`/`js/*` thread exists in this process while a source plays (sources from the
/// other tests of this binary included: they all go through the same fixed options). RED
/// before: every option `yes` (`load-auto-profiles` `auto`), 6 script threads per core.
#[test]
fn builtin_scripts_are_not_loaded() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    settle(&gfx, &mut src);
    let s = |n: &str| {
        src.mpv_get_string(&format!("options/{n}"))
            .unwrap_or_default()
    };
    for name in [
        "load-scripts",
        "osc",
        "ytdl",
        "load-stats-overlay",
        "load-console",
        "load-auto-profiles",
        "load-select",
        "load-commands",
        "load-positioning",
        "load-context-menu",
        "input-builtin-bindings",
        "input-default-bindings",
    ] {
        assert_eq!(s(name), "no", "options/{name}");
    }
    let mut scripts = Vec::new();
    for t in std::fs::read_dir("/proc/self/task").expect("/proc/self/task") {
        let comm = std::fs::read_to_string(t.unwrap().path().join("comm")).unwrap_or_default();
        let comm = comm.trim();
        if comm.starts_with("lua/") || comm.starts_with("js/") {
            scripts.push(comm.to_string());
        }
    }
    assert!(
        scripts.is_empty(),
        "mpv script threads running: {scripts:?}"
    );
}

/// Crash on rapid superseding switches (2026-10-26, SIGSEGV in the compositor): mpv ≥ 0.40
/// gives every core a native clipboard at `mpv_initialize` — on X11 (no `WAYLAND_DISPLAY`,
/// a reachable `DISPLAY`) its own X connection on its own thread, on Wayland its own
/// `ext-data-control` connection to the compositor. A wallpaper never reads the clipboard,
/// and when that X connection drops, mpv's clipboard thread `XCloseDisplay`s it → Xlib's
/// default I/O error handler → `exit(1)` from mpv's thread → the NVIDIA EGL atexit
/// teardown under the loop's GL → SIGSEGV. No backend at all, in any environment: the
/// option reads back empty and the core reports no clipboard backend. RED before:
/// `current-clipboard-backend` = `wayland` (a session's `WAYLAND_DISPLAY`), `x11`, or `vo`.
#[test]
fn no_clipboard_backend_per_core() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    settle(&gfx, &mut src);
    assert_eq!(
        src.mpv_get_string("current-clipboard-backend"),
        None,
        "an mpv core runs a clipboard backend"
    );
    assert_eq!(
        src.mpv_get_string("options/clipboard-backends").as_deref(),
        Some(""),
        "options/clipboard-backends"
    );
}

/// Fix round 1 (#8): a wrong-typed `open` option is `bad_type`; an mpv rejection of a
/// well-typed value at open is `out_of_range` (not `io`, which is for real I/O).
#[test]
fn open_error_codes() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let code = |o: Value| {
        open_src(&gfx, path_str(&clip), &opts(o))
            .err()
            .map(|e| e.code)
    };
    assert_eq!(code(json!({"kind": 5})), Some("bad_type"));
    assert_eq!(code(json!({"kind": "color"})), Some("out_of_range"));
    let mut o = opts(json!({}));
    o.insert("ao".into(), json!(5));
    assert_eq!(
        open_src(&gfx, path_str(&clip), &o).err().map(|e| e.code),
        Some("bad_type")
    );
    assert_eq!(
        code(json!({"af": "no_such_filter_lp"})),
        Some("out_of_range")
    );
    assert_eq!(code(json!({"position": "x"})), Some("bad_type"));
}

/// Fix round 1 (#9, features-must-compose): start muted, unmute live → the AO really
/// comes up (not just decoder-side audio-params), and mute again tears it down.
#[test]
fn start_muted_then_unmute_live() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_ready(
        &gfx,
        path_str(&clip),
        json!({"loop": true, "no_audio": true}),
    );
    settle(&gfx, &mut src);
    let ao_up = |s: &MpvSource| {
        s.mpv_get_string("current-ao").as_deref() == Some("null")
            && s.mpv_get_string("audio-out-params/samplerate").is_some()
    };
    assert!(!ao_up(&src), "no AO while started muted");
    let wake = Some(src.wake_fd());

    src.apply("no_audio", &PropValue::Bool(false)).unwrap();
    let (_, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |_, s| {
        ao_up(s)
    });
    assert!(ok, "AO never came up after unmuting a muted start");

    src.apply("no_audio", &PropValue::Bool(true)).unwrap();
    let (_, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |_, s| {
        !ao_up(s)
    });
    assert!(ok, "AO still up after muting again");
}

/// Fix round 1 (#5): `open` makes its own context current for the render-context
/// create, and `update` refuses a `Gfx` from a different context (UB per render.h)
/// instead of rendering with it — then works again with the right one.
#[test]
fn update_with_foreign_context_is_refused() {
    let Some((_serial, gfx1)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let gfx2 = headless_gl().expect("second context"); // now gfx2's context is current
    let mut src = open_src(&gfx1, path_str(&clip), &opts(json!({}))).expect("open");
    let t0 = Instant::now();
    let mut evs = Vec::new();
    while t0.elapsed() < Duration::from_millis(500) {
        assert!(!src.update(&gfx2), "rendered through a foreign context");
        evs.extend(src.poll_events());
        std::thread::sleep(Duration::from_millis(10));
    }
    let errs = errors(&evs);
    assert!(
        errs.len() == 1 && errs[0].contains("context"),
        "one Error about the foreign context: {evs:?}"
    );
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx1, &mut src, wake, Duration::from_secs(3), |e, _| {
        ready(e)
    });
    assert!(ok, "no Ready with the right context: {evs:?}");
    drop(src); // with gfx2 current: Drop switches to gfx1's context and back
}

/// `apply` gates values through the graph's own schema (same codes, same order).
#[test]
fn apply_validates_like_graph() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_src(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    let code = |r: Result<(), liascape_player::graph::ApiError>| r.unwrap_err().code;
    assert_eq!(
        code(src.apply("speed", &PropValue::F64(9.0))),
        "out_of_range"
    );
    assert_eq!(
        code(src.apply("duration", &PropValue::F64(1.0))),
        "read_only"
    );
    assert_eq!(code(src.apply("paused", &PropValue::F64(1.0))), "bad_type");
    assert_eq!(
        code(src.apply("bogus", &PropValue::F64(1.0))),
        "no_such_prop"
    );
    assert_eq!(
        code(src.apply("gain.bogus", &PropValue::F64(1.0))),
        "no_such_prop"
    );
    assert_eq!(
        code(src.apply("kind", &PropValue::Str("image".into()))),
        "unsupported"
    );
}

#[test]
fn missing_file_reports_error_with_path() {
    let Some((_serial, gfx)) = gpu() else { return };
    let path = "/nonexistent/liascape-player-test-missing.mkv";
    let mut src = open_src(&gfx, path, &opts(json!({}))).expect("open is async");
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        e.iter().any(|e| matches!(e, SourceEvent::Error { .. }))
    });
    assert!(ok, "no Error within 3 s: {evs:?}");
    let reason = evs
        .iter()
        .find_map(|e| match e {
            SourceEvent::Error { reason } => Some(reason.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        reason.contains(path),
        "Error reason must name the path: {reason}"
    );
    assert!(src.texture().is_none() && !ready(&evs));
}

/// The render context is freed with its GL context current even when the `Gfx` that
/// created it was dropped first (the source keeps the EGL context alive).
#[test]
fn source_outlives_gfx_safely() {
    let Some((_serial, gfx)) = gpu() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let src = open_ready(&gfx, path_str(&clip), json!({}));
    drop(gfx);
    drop(src); // must not crash or hang
}

#[test]
fn color_source() {
    let Some((_serial, gfx)) = gpu() else { return };
    let mut c = ColorSource::new([0, 255, 0]);
    assert_eq!(c.kind(), "color");
    assert_eq!(
        c.poll_events(),
        vec![SourceEvent::Ready],
        "Ready immediately"
    );
    assert!(c.poll_events().is_empty(), "Ready only once");
    assert!(c.update(&gfx), "first update paints");
    assert!(!c.update(&gfx), "nothing new to paint");
    let tex = c.texture().expect("texture");
    assert_eq!(c.size(), (tex.w, tex.h));
    assert_eq!(read_rgba(&gfx, tex, 0, 0), [0, 255, 0, 255]);

    c.apply("color", &PropValue::List(vec![255.0, 0.0, 0.0]))
        .unwrap();
    assert!(c.update(&gfx), "a colour change repaints");
    let tex = c.texture().expect("texture");
    assert_eq!(read_rgba(&gfx, tex, 0, 0), [255, 0, 0, 255]);
    assert_eq!(
        c.read("color"),
        Some(PropValue::List(vec![255.0, 0.0, 0.0]))
    );
    assert_eq!(c.read("ready"), Some(PropValue::Bool(true)));
}

/// Fix round (T11 #9): a `SnapshotSource` is the source's frame at the moment it's made —
/// pixel-identical, same size, same orientation (image top at low y, R25) — and it stays
/// that frame while the source moves on.
#[test]
fn snapshot_copies_frame_and_orientation() {
    use liascape_player::sources::SnapshotSource;
    let Some((_serial, gfx)) = gpu() else { return };

    // Orientation + exact copy: top red / bottom blue.
    let clip = ensure_clip(
        "split_red_over_blue",
        ClipSpec::SplitV {
            top: [255, 0, 0],
            bottom: [0, 0, 255],
            secs: 2.0,
        },
    );
    let src = open_ready(&gfx, path_str(&clip), json!({"paused": true}));
    let mut snap = SnapshotSource::new(&gfx, "src1", src.texture());
    let (t, st) = (
        src.texture().unwrap(),
        snap.texture().expect("snapshot texture"),
    );
    assert_eq!((st.w, st.h), (t.w, t.h));
    assert_rgb(
        read_rgba(&gfx, st, st.w / 2, st.h / 8),
        [255, 0, 0],
        3,
        "snapshot low y = image top",
    );
    assert_rgb(
        read_rgba(&gfx, st, st.w / 2, st.h * 7 / 8),
        [0, 0, 255],
        3,
        "snapshot high y = bottom",
    );
    for (x, y) in [
        (5, 5),
        (t.w / 2, t.h / 2 - 2),
        (t.w - 3, t.h - 3),
        (t.w / 3, t.h * 3 / 4),
    ] {
        assert_eq!(
            read_rgba(&gfx, t, x, y),
            read_rgba(&gfx, st, x, y),
            "pixel ({x},{y})"
        );
    }
    assert_eq!(snap.poll_events(), vec![SourceEvent::Ready]);
    assert_eq!(snap.read("of"), Some(PropValue::Str("src1".into())));
    assert_eq!(snap.read("kind"), Some(PropValue::Str("snapshot".into())));

    // Frozen while the source advances.
    let idx = ensure_clip("frame_index_120", ClipSpec::FrameIndex { frames: 120 });
    let mut src = open_ready(&gfx, path_str(&idx), json!({"paused": true}));
    let at_copy = read_rgba(&gfx, src.texture().unwrap(), 32, 32)[0];
    let snap = SnapshotSource::new(&gfx, "src2", src.texture());
    src.apply("paused", &PropValue::Bool(false)).unwrap();
    let wake = Some(src.wake_fd());
    pump(&gfx, &mut src, wake, Duration::from_millis(500), |_, _| {
        false
    });
    let now = read_rgba(&gfx, src.texture().unwrap(), 32, 32)[0];
    assert!(
        now >= at_copy + 8,
        "the source advanced ({at_copy} → {now})"
    );
    assert_eq!(
        read_rgba(&gfx, snap.texture().unwrap(), 32, 32)[0],
        at_copy,
        "the snapshot keeps the frame it copied"
    );
}

/// An fps cap (`fps_cap`, the backend's `VideoFpsCap`) never stalls a still image (TODO "An fps
/// cap stalls a still image"): mpv's `fps` filter emits a frame only once it knows how long it
/// lasts, and a still shown with `image-display-duration=inf` never tells it — the image stayed
/// `ready: false` with no texture. A still runs no `vf` whatever the cap; a video keeps it.
/// Cases: opened capped; the cap changed live on a shown image; a capped source switched
/// image → video → image by `path`; a still whose extension says video (`.dat` — mpv's image
/// flag corrects the guess after the load). RED before: never Ready (events `[AudioFlowing]`).
#[test]
fn fps_cap_never_stalls_an_image() {
    let Some((_serial, gfx)) = gpu() else { return };
    let green = ensure_clip("image_green", ClipSpec::Image { rgb: [0, 255, 0] });
    let red = ensure_clip("solid_red_2s", RED_2S);
    let vf = |src: &MpvSource| src.mpv_get_string("vf").unwrap_or_default();
    let centre_is = |gfx: &Gfx, src: &MpvSource, rgb: [u8; 3], what: &str| {
        let tex = src.texture().expect("texture after Ready");
        assert_rgb(read_rgba(gfx, tex, tex.w / 2, tex.h / 2), rgb, 3, what);
    };
    // Opened with the cap.
    let mut src = open_ready(&gfx, path_str(&green), json!({"fps_cap": 30.0}));
    centre_is(&gfx, &src, [0, 255, 0], "the capped image");
    assert_eq!(
        src.read("fps_cap"),
        Some(PropValue::F64(30.0)),
        "the prop keeps the cap"
    );
    assert_eq!(vf(&src), "", "no fps filter on a still");
    // Live on a shown image.
    src.apply("fps_cap", &PropValue::F64(24.0))
        .expect("live cap");
    settle(&gfx, &mut src);
    assert_eq!(vf(&src), "", "still none after a live cap change");
    assert_eq!(src.read("fps_cap"), Some(PropValue::F64(24.0)));
    // → a video: the cap applies.
    src.apply("path", &PropValue::Str(path_str(&red).into()))
        .expect("path → video");
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        ready(e)
    });
    assert!(ok, "capped video never Ready; events: {evs:?}");
    settle(&gfx, &mut src);
    assert!(
        vf(&src).contains("fps"),
        "the video is capped: vf = {:?}",
        vf(&src)
    );
    centre_is(&gfx, &src, [255, 0, 0], "the capped video");
    // → an image again: no filter, Ready.
    src.apply("path", &PropValue::Str(path_str(&green).into()))
        .expect("path → image");
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        ready(e)
    });
    assert!(
        ok,
        "image loaded into a capped source never Ready; events: {evs:?}"
    );
    centre_is(&gfx, &src, [0, 255, 0], "the image after the path change");
    assert_eq!(vf(&src), "");
    drop(src);
    // A still the extension calls a video: capped at the load, corrected by mpv's image flag.
    let dat = green.with_file_name("image_green_misnamed.dat");
    std::fs::copy(&green, &dat).expect("copy the png");
    let src = open_ready(&gfx, path_str(&dat), json!({"fps_cap": 30.0}));
    assert_eq!(src.kind(), "image", "mpv's flag corrected the guess");
    centre_is(&gfx, &src, [0, 255, 0], "the misnamed still");
}
