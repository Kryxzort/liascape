//! Task 7 brief, Step 1: clear a 64x64 FBO to a known color, read it back, and write it to
//! a decodable PNG. This is the one test that must run on the real GPU (not skipped) on
//! the owner's NVIDIA 595.84 machine — see `tests/common::headless_gl` for the one
//! condition under which it legitimately skips instead (no EGL device at all) — and
//! `LIASCAPE_REQUIRE_GPU=1`, which turns that skip into a failure (last test here).

mod common;

use common::{headless_gl, read_rgba};
use glow::HasContext;

#[test]
fn clear_readback() {
    let Some(gfx) = headless_gl() else {
        return;
    };

    let tex = gfx.tex(64, 64);
    let fbo = gfx.fbo(&tex);

    unsafe {
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
        gfx.gl.viewport(0, 0, 64, 64);
        gfx.gl.clear_color(1.0, 0.0, 0.0, 1.0);
        gfx.gl.clear(glow::COLOR_BUFFER_BIT);
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    }

    let pixel = read_rgba(&gfx, &tex, 10, 10);
    assert_eq!(
        pixel,
        [255, 0, 0, 255],
        "cleared FBO must read back as opaque red"
    );

    let out = std::env::temp_dir().join(format!(
        "liascape_player_gfx_basic_clear_readback_{}.png",
        std::process::id()
    ));
    gfx.write_png(&tex, &out).expect("write_png failed");

    let decoder = png::Decoder::new(std::io::BufReader::new(
        std::fs::File::open(&out).expect("png file must exist and be openable"),
    ));
    let reader = decoder.read_info().expect("png must be decodable");
    let (w, h) = reader.info().size();
    assert_eq!((w, h), (64, 64), "decoded PNG must be 64x64");

    let _ = std::fs::remove_file(&out);
}

/// Phase 2 Task 13: `capture` writes its PNG on the player's loop, and the png crate's default
/// (`Balanced`) compression held the loop 820–875 ms for a 3840×1080 scene frame (release
/// build; every output froze for it). `write_png` uses fdeflate's `Fast` mode (39–112 ms). Guard
/// without an absolute bound (debug builds encode far slower): on the same noisy 1920×1080
/// frame, `write_png` (readback + encode) takes well under half of a `Balanced` encode alone
/// and still decodes to the same pixels. RED with `Balanced`: ≥ 1×.
#[test]
fn write_png_is_fast_enough_for_the_loop() {
    let Some(gfx) = headless_gl() else {
        return;
    };
    let (w, h) = (1920u32, 1080u32);
    // Deterministic noise with some structure (a gradient + an LCG), like a scene frame.
    let mut seed = 0x2545_f491u32;
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    for (i, px) in pixels.chunks_mut(4).enumerate() {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let x = (i as u32 % w) as u8;
        px[0] = x.wrapping_add((seed >> 24) as u8 & 0x1f);
        px[1] = (seed >> 16) as u8;
        px[2] = ((i as u32 / w) as u8).wrapping_add((seed >> 8) as u8 & 0x0f);
        px[3] = 255;
    }
    let tex = gfx.tex(w, h);
    unsafe {
        gfx.gl.bind_texture(glow::TEXTURE_2D, Some(tex.id));
        gfx.gl.tex_sub_image_2d(
            glow::TEXTURE_2D,
            0,
            0,
            0,
            w as i32,
            h as i32,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelUnpackData::Slice(Some(&pixels)),
        );
        gfx.gl.bind_texture(glow::TEXTURE_2D, None);
    }
    let dir = std::env::temp_dir();
    let ours = dir.join(format!("liascape_player_fast_png_{}.png", std::process::id()));
    let reference = dir.join(format!("liascape_player_balanced_png_{}.png", std::process::id()));
    let balanced = || {
        let t = std::time::Instant::now();
        let file = std::fs::File::create(&reference).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Balanced);
        let mut wr = enc.write_header().unwrap();
        wr.write_image_data(&pixels).unwrap();
        drop(wr);
        t.elapsed().as_secs_f64()
    };
    let ours_t = || {
        let t = std::time::Instant::now();
        gfx.write_png_source(&tex, &ours).expect("write_png_source");
        t.elapsed().as_secs_f64()
    };
    // Best of 3 each (scheduler noise on a shared machine).
    let b = (0..3).map(|_| balanced()).fold(f64::MAX, f64::min);
    let o = (0..3).map(|_| ours_t()).fold(f64::MAX, f64::min);
    let decoded = {
        let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(&ours).unwrap()));
        let mut reader = dec.read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut buf).unwrap();
        buf
    };
    let _ = std::fs::remove_file(&ours);
    let _ = std::fs::remove_file(&reference);
    assert!(decoded == pixels, "the PNG decodes to the texture's pixels");
    assert!(
        o < 0.7 * b,
        "write_png_source {:.1} ms vs a Balanced encode alone {:.1} ms",
        o * 1e3,
        b * 1e3
    );
}

/// Task 10 fix round: every surfaceless `Gfx` in a process shares one `EGLDisplay`.
/// Dropping one must not terminate that display under another: the survivor's context
/// (not current at the time) must still be valid, re-currentable, and drawable.
#[test]
fn two_gfx_on_one_display_survive_each_others_drop() {
    let Some(a) = headless_gl() else {
        return;
    };
    let b = headless_gl().expect("second context"); // b is current now
    let keep_a = a.keep_alive();
    drop(b); // previously: eglTerminate(display) → a's context destroyed
    let cur = keep_a.make_current();
    assert!(
        cur.is_current(),
        "the surviving Gfx's context can't be made current after the other's drop"
    );
    let tex = a.tex(4, 4);
    let fbo = a.fbo(&tex);
    unsafe {
        a.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
        a.gl.viewport(0, 0, 4, 4);
        a.gl.clear_color(0.0, 1.0, 0.0, 1.0);
        a.gl.clear(glow::COLOR_BUFFER_BIT);
        a.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    }
    assert_eq!(read_rgba(&a, &tex, 1, 1), [0, 255, 0, 255]);
}

/// TODO "`LIASCAPE_REQUIRE_GPU` test mode": the same GPU test, re-run as a child of this binary
/// with every EGL vendor hidden (`__EGL_VENDOR_LIBRARY_FILENAMES` naming no file — glvnd
/// then has no driver, so `Gfx::new_offscreen` fails as on a GPU-less machine): without
/// `LIASCAPE_REQUIRE_GPU` it passes with a `SKIP` line (the sandbox case), with
/// `LIASCAPE_REQUIRE_GPU=1` it fails and says why; `0`/empty = off.
#[test]
fn require_gpu_turns_a_missing_gpu_into_a_failure() {
    let run = |require: Option<&str>| {
        let mut c = std::process::Command::new(std::env::current_exe().unwrap());
        c.args([
            "clear_readback",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(
            "__EGL_VENDOR_LIBRARY_FILENAMES",
            "/nonexistent/liascape-no-egl-vendor.json",
        )
        .env_remove(common::REQUIRE_GPU_ENV);
        if let Some(v) = require {
            c.env(common::REQUIRE_GPU_ENV, v);
        }
        let out = c.output().expect("re-run this test binary");
        let text = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        (out.status.success(), text)
    };
    let (ok, text) = run(None);
    assert!(ok, "without {}: {text}", common::REQUIRE_GPU_ENV);
    assert!(text.contains("SKIP: no EGL device"), "{text}");
    for off in ["0", ""] {
        let (ok, text) = run(Some(off));
        assert!(ok, "{}={off:?} is off: {text}", common::REQUIRE_GPU_ENV);
    }
    let (ok, text) = run(Some("1"));
    assert!(
        !ok,
        "{}=1 must fail without a GPU: {text}",
        common::REQUIRE_GPU_ENV
    );
    assert!(
        text.contains("LIASCAPE_REQUIRE_GPU is set but a GPU test would skip: no EGL device"),
        "{text}"
    );
}
