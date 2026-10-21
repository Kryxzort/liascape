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
//! Skips (prints `SKIP: …`, returns) only when there's no EGL device at all.

mod common;

use std::os::fd::RawFd;
use std::time::{Duration, Instant};

use common::{ClipSpec, ensure_clip, headless_gl, read_rgba};
use glow::HasContext;
use lp_player::gfx::Gfx;
use lp_player::graph::PropValue;
use lp_player::sources::{ColorSource, MpvSource, Source, SourceEvent};
use serde_json::{Map, Value, json};

/// `opts` for `MpvSource::open`, always with `ao: "null"` (R26).
fn opts(v: Value) -> Map<String, Value> {
    let mut m = v.as_object().expect("opts must be an object").clone();
    m.insert("ao".into(), json!("null"));
    m
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

fn open_ready(gfx: &Gfx, path: &str, o: Value) -> MpvSource {
    let mut src = MpvSource::open(gfx, path, &opts(o)).expect("MpvSource::open");
    let wake = Some(src.wake_fd());
    let (evs, ok) = pump(gfx, &mut src, wake, Duration::from_secs(3), |e, _| ready(e));
    assert!(ok, "no Ready within 3 s for {path}; events: {evs:?}");
    src
}

#[test]
fn first_frame_and_ready() {
    let Some(gfx) = headless_gl() else { return };
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
    let Some(gfx) = headless_gl() else { return };
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
    let Some(gfx) = headless_gl() else { return };
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

/// `loop = true`: never `Ended`; `Position` keeps flowing at ≤ ~10 Hz.
#[test]
fn loop_never_ends_and_position_is_rate_limited() {
    let Some(gfx) = headless_gl() else { return };
    let clip = ensure_clip(
        "solid_blue_1s",
        ClipSpec::Solid {
            rgb: [0, 0, 255],
            secs: 1.0,
            tone_hz: 440.0,
            tone_dbfs: -20.0,
        },
    );
    let mut src =
        MpvSource::open(&gfx, path_str(&clip), &opts(json!({"loop": true}))).expect("open");
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
    let Some(gfx) = headless_gl() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = open_ready(&gfx, path_str(&clip), json!({}));
    let wake = Some(src.wake_fd());
    pump(&gfx, &mut src, wake, Duration::from_millis(300), |_, _| {
        false
    });
    assert!(
        lp_player::sources::mpv::fence_stub_calls() > 0,
        "libmpv never called glFenceSync through our get_proc_address"
    );
}

#[test]
fn ended_holds_last_frame() {
    let Some(gfx) = headless_gl() else { return };
    let clip = ensure_clip(
        "solid_blue_1s",
        ClipSpec::Solid {
            rgb: [0, 0, 255],
            secs: 1.0,
            tone_hz: 440.0,
            tone_dbfs: -20.0,
        },
    );
    let mut src =
        MpvSource::open(&gfx, path_str(&clip), &opts(json!({"loop": false}))).expect("open");
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
}

#[test]
fn gain_maps_to_volume_gain() {
    let Some(gfx) = headless_gl() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = MpvSource::open(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    src.apply("gain.user", &PropValue::F64(-6.0)).unwrap();
    src.apply("gain.xfade", &PropValue::F64(-3.0103)).unwrap();
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
    assert_eq!(src.mpv_get_f64("volume-gain"), Some(-96.0));
}

#[test]
fn image_source() {
    let Some(gfx) = headless_gl() else { return };
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

#[test]
fn no_audio_live() {
    let Some(gfx) = headless_gl() else { return };
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
    assert_eq!(src.mpv_get_string("options/aid").as_deref(), Some("no"));
    assert_eq!(src.mpv_get_string("aid").as_deref(), Some("no"));
    let (_, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |_, s| {
        !audio_up(s)
    });
    assert!(ok, "audio-params still set after no_audio=true");

    src.apply("no_audio", &PropValue::Bool(false)).unwrap();
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

/// The brief's property map, checked against what mpv itself reports.
#[test]
fn property_map_reaches_mpv() {
    let Some(gfx) = headless_gl() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = MpvSource::open(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    let s = |src: &MpvSource, n: &str| src.mpv_get_string(n).unwrap_or_default();

    src.apply("loop", &PropValue::Bool(true)).unwrap();
    assert_eq!(s(&src, "loop-file"), "inf");
    src.apply("loop", &PropValue::Bool(false)).unwrap();
    assert_eq!(s(&src, "loop-file"), "no");
    src.apply("paused", &PropValue::Bool(true)).unwrap();
    assert_eq!(s(&src, "pause"), "yes");
    src.apply("speed", &PropValue::F64(1.5)).unwrap();
    assert_eq!(src.mpv_get_f64("speed"), Some(1.5));
    src.apply("hwdec", &PropValue::Str("no".into())).unwrap();
    assert_eq!(s(&src, "hwdec"), "no");
    src.apply("fps_cap", &PropValue::F64(24.0)).unwrap();
    assert!(s(&src, "vf").contains("fps"), "vf = {:?}", s(&src, "vf"));
    src.apply("fps_cap", &PropValue::F64(0.0)).unwrap();
    assert_eq!(s(&src, "vf"), "");
    src.apply("cache", &PropValue::Bool(false)).unwrap();
    assert_eq!(s(&src, "cache"), "no");
    src.apply("demuxer_max_mib", &PropValue::F64(32.0)).unwrap();
    assert_eq!(src.mpv_get_f64("demuxer-max-bytes"), Some(32.0 * 1048576.0));
    src.apply("demuxer_max_mib", &PropValue::F64(1.5)).unwrap();
    assert_eq!(src.mpv_get_f64("demuxer-max-bytes"), Some(1.5 * 1048576.0));
    src.apply("demuxer_max_mib", &PropValue::F64(0.0)).unwrap();
    assert_eq!(
        src.mpv_get_f64("demuxer-max-bytes"),
        Some(150.0 * 1048576.0),
        "0 = unset → mpv's default (legacy convention)"
    );
    src.apply("demuxer_back_mib", &PropValue::F64(8.0)).unwrap();
    assert_eq!(
        src.mpv_get_f64("demuxer-max-back-bytes"),
        Some(8.0 * 1048576.0)
    );
    src.apply("af", &PropValue::Str("lavfi=[anull]".into()))
        .unwrap();
    assert!(s(&src, "af").contains("anull"), "af = {:?}", s(&src, "af"));
    src.apply("audio_delay", &PropValue::F64(0.25)).unwrap();
    assert_eq!(src.mpv_get_f64("audio-delay"), Some(0.25));
    // Every applied value reads back through the Source.
    assert_eq!(src.read("speed"), Some(PropValue::F64(1.5)));
    assert_eq!(src.read("cache"), Some(PropValue::Bool(false)));
}

/// `path` is live too: a new file loads into the same source, `Ready` fires again, the
/// old frame is held until the new one lands, and `kind` follows mpv's image flag.
#[test]
fn path_change_is_live() {
    let Some(gfx) = headless_gl() else { return };
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
    let (evs, ok) = pump(&gfx, &mut src, wake, Duration::from_secs(3), |e, _| {
        ready(e)
    });
    assert!(ok, "no second Ready after the path change: {evs:?}");
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

/// `apply` gates values through the graph's own schema (same codes, same order).
#[test]
fn apply_validates_like_graph() {
    let Some(gfx) = headless_gl() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let mut src = MpvSource::open(&gfx, path_str(&clip), &opts(json!({}))).expect("open");
    let code = |r: Result<(), lp_player::graph::ApiError>| r.unwrap_err().code;
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
    let Some(gfx) = headless_gl() else { return };
    let path = "/nonexistent/lp-player-test-missing.mkv";
    let mut src = MpvSource::open(&gfx, path, &opts(json!({}))).expect("open is async");
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
    let Some(gfx) = headless_gl() else { return };
    let clip = ensure_clip("solid_red_2s", RED_2S);
    let src = open_ready(&gfx, path_str(&clip), json!({}));
    drop(gfx);
    drop(src); // must not crash or hang
}

#[test]
fn color_source() {
    let Some(gfx) = headless_gl() else { return };
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
