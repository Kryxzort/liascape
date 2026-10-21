//! Shared test harness for `gfx` integration tests (this task's `gfx_basic.rs`; later
//! tasks — effect shaders, layer composition, mpv textures — extend this module rather
//! than duplicating it).

pub mod harness;

use glow::HasContext;
use lp_player::gfx::{Gfx, Tex};

/// Create a real, surfaceless [`Gfx`] for a test, or skip cleanly.
///
/// Returns `None` **only** when [`Gfx::new_offscreen`] fails (no EGL device at all — e.g.
/// a sandboxed `nix build` check phase with no `/dev/dri`), printing `"SKIP: no EGL
/// device"` plus the reason so a skipped run still says why. On this machine
/// (NVIDIA 595.84) it always succeeds, so tests that call this genuinely exercise the GPU
/// here — they are not quietly skipped on the owner's box.
///
/// Callers: `let Some(gfx) = headless_gl() else { return };`
pub fn headless_gl() -> Option<Gfx> {
    match Gfx::new_offscreen() {
        Ok(gfx) => Some(gfx),
        Err(e) => {
            println!("SKIP: no EGL device ({e})");
            None
        }
    }
}

/// Read back one pixel of `tex` at `(x, y)` through a temporary FBO.
///
/// **Origin: GL bottom-left.** `(0, 0)` is the *bottom-left* corner of the texture, not
/// the top-left — this is `glReadPixels`'s native coordinate system, the same one
/// `gl_FragCoord` uses, and this function makes no attempt to flip it (unlike
/// [`lp_player::gfx::Gfx::write_png`], which flips rows specifically because a PNG's own
/// convention is top-down). Every later task reading pixels back for assertions inherits
/// this origin — don't re-flip here and then get flipped again at the PNG layer.
pub fn read_rgba(gfx: &Gfx, tex: &Tex, x: u32, y: u32) -> [u8; 4] {
    let mut pixel = [0u8; 4];
    unsafe {
        let fbo = gfx.fbo(tex);
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
        gfx.gl.read_pixels(
            x as i32,
            y as i32,
            1,
            1,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelPackData::Slice(Some(&mut pixel)),
        );
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        gfx.gl.delete_framebuffer(fbo.id);
    }
    pixel
}

/// What [`ensure_clip`] generates. Every video is 1920×1080 @ 30 fps, H.264 (`libx264`,
/// `yuv420p`, tagged BT.709 limited range so mpv decodes with the same matrix ffmpeg
/// encoded with), in Matroska. Colours are built in `rgb24` first and converted once, so
/// the only colour error is the RGB→YUV→RGB round trip (plus mpv's output dither) —
/// that's what the ±3 colour tolerances in `tests/sources.rs` account for.
#[allow(dead_code)] // each integration-test binary compiles this module; not all use every variant
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ClipSpec {
    /// One solid colour for `secs`, with a stereo 48 kHz sine at `tone_hz`, peak
    /// amplitude `tone_dbfs` dBFS on both channels (PCM s16le, so the level is exact).
    Solid {
        rgb: [u8; 3],
        secs: f64,
        tone_hz: f64,
        tone_dbfs: f64,
    },
    /// `frames` frames; frame `n`'s top-left 64×64 block is `(n,n,n)`, the rest mid-grey
    /// `(128,128,128)` — for frame-exact seek checks. No audio. `n` survives the YUV round
    /// trip to within ±1 (neutral grey has no chroma, so only luma quantisation applies).
    FrameIndex { frames: u32 },
    /// A single 1920×1080 PNG of one colour (lossless RGB, no YUV involved).
    Image { rgb: [u8; 3] },
    /// Top half `top`, bottom half `bottom`, for `secs` — the R25 orientation pin
    /// (`tests/sources.rs::source_texture_holds_image_top_at_t0`). No audio.
    SplitV {
        top: [u8; 3],
        bottom: [u8; 3],
        secs: f64,
    },
}

#[allow(dead_code)]
fn hex(rgb: [u8; 3]) -> String {
    format!("0x{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// Serialises clip generation inside one test binary (tests run on parallel threads and
/// several may ask for the same clip at once).
#[allow(dead_code)]
static CLIP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Generate (once) a synthetic test clip into `<crate>/target/test-media/` with `ffmpeg`
/// from `PATH` and return its path. A clip is regenerated only when it's missing or its
/// `<name>.spec` stamp (the `Debug` form of `spec`) differs — so changing a spec under
/// the same name can't silently reuse stale media. Generation writes to a temp name and
/// renames into place, so a half-written file is never picked up.
///
/// Panics (failing the test, with ffmpeg's stderr) if `ffmpeg` is missing or fails —
/// callers check [`headless_gl`] first, so the GPU-less `nix build` sandbox skips before
/// ever getting here.
#[allow(dead_code)]
pub fn ensure_clip(name: &str, spec: ClipSpec) -> std::path::PathBuf {
    use std::process::Command;

    let _guard = CLIP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-media");
    std::fs::create_dir_all(&dir).expect("create target/test-media");
    let ext = if matches!(spec, ClipSpec::Image { .. }) {
        "png"
    } else {
        "mkv"
    };
    let out = dir.join(format!("{name}.{ext}"));
    let stamp = dir.join(format!("{name}.spec"));
    let want = format!("{spec:?}");
    if out.exists() && std::fs::read_to_string(&stamp).ok().as_deref() == Some(want.as_str()) {
        return out;
    }

    // Every video: build in rgb24, convert once to BT.709 limited-range yuv420p, and tag
    // the stream so the decoder (mpv) uses the same matrix.
    const TO_YUV: &str = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
    let video_codec = [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "4",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
    ];
    let tmp = dir.join(format!("{name}.tmp-{}.{ext}", std::process::id()));
    let mut args: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut push = |v: &[&str]| args.extend(v.iter().map(|s| s.to_string()));
    match spec {
        ClipSpec::Solid {
            rgb,
            secs,
            tone_hz,
            tone_dbfs,
        } => {
            let amp = 10f64.powf(tone_dbfs / 20.0);
            let ch = format!("{amp}*sin(2*PI*{tone_hz}*t)");
            push(&[
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={}:s=1920x1080:r=30:d={secs}", hex(rgb)),
                "-f",
                "lavfi",
                "-i",
                &format!("aevalsrc={ch}|{ch}:s=48000:d={secs}"),
                "-vf",
                &format!("format=rgb24,{TO_YUV}"),
            ]);
            push(&video_codec);
            push(&["-c:a", "pcm_s16le"]);
        }
        ClipSpec::FrameIndex { frames } => {
            let secs = frames as f64 / 30.0;
            push(&[
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=0x808080:s=1920x1080:r=30:d={secs}"),
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=black:s=64x64:r=30:d={secs}"),
                "-filter_complex",
                &format!(
                    "[1]format=rgb24,geq=r=N:g=N:b=N[box];[0]format=rgb24[bg];\
                     [bg][box]overlay=0:0:format=rgb,format=rgb24,{TO_YUV}[v]"
                ),
                "-map",
                "[v]",
                "-frames:v",
                &frames.to_string(),
            ]);
            push(&video_codec);
        }
        ClipSpec::Image { rgb } => {
            push(&[
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={}:s=1920x1080", hex(rgb)),
                "-vf",
                "format=rgb24",
                "-frames:v",
                "1",
            ]);
        }
        ClipSpec::SplitV { top, bottom, secs } => {
            push(&[
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={}:s=1920x540:r=30:d={secs}", hex(top)),
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={}:s=1920x540:r=30:d={secs}", hex(bottom)),
                "-filter_complex",
                &format!("[0]format=rgb24[a];[1]format=rgb24[b];[a][b]vstack,{TO_YUV}[v]"),
                "-map",
                "[v]",
            ]);
            push(&video_codec);
        }
    }
    args.push(tmp.to_string_lossy().into_owned());

    let res = Command::new("ffmpeg")
        .args(&args)
        .output()
        .unwrap_or_else(|e| panic!("ensure_clip({name}): can't run ffmpeg from PATH: {e}"));
    assert!(
        res.status.success(),
        "ensure_clip({name}): ffmpeg failed ({}): {}\nargs: {args:?}",
        res.status,
        String::from_utf8_lossy(&res.stderr)
    );
    std::fs::rename(&tmp, &out).expect("rename generated clip into place");
    std::fs::write(&stamp, want).expect("write clip spec stamp");
    out
}
