//! Task 7 brief, Step 1: clear a 64x64 FBO to a known color, read it back, and write it to
//! a decodable PNG. This is the one test that must run on the real GPU (not skipped) on
//! the owner's NVIDIA 595.84 machine — see `tests/common::headless_gl` for the one
//! condition under which it legitimately skips instead (no EGL device at all) — and
//! `LP_REQUIRE_GPU=1`, which turns that skip into a failure (last test here).

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
        "lp_player_gfx_basic_clear_readback_{}.png",
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

/// TODO "`LP_REQUIRE_GPU` test mode": the same GPU test, re-run as a child of this binary
/// with every EGL vendor hidden (`__EGL_VENDOR_LIBRARY_FILENAMES` naming no file — glvnd
/// then has no driver, so `Gfx::new_offscreen` fails as on a GPU-less machine): without
/// `LP_REQUIRE_GPU` it passes with a `SKIP` line (the sandbox case), with
/// `LP_REQUIRE_GPU=1` it fails and says why; `0`/empty = off.
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
            "/nonexistent/lp-no-egl-vendor.json",
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
        text.contains("LP_REQUIRE_GPU is set but a GPU test would skip: no EGL device"),
        "{text}"
    );
}
