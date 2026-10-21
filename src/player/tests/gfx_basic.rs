//! Task 7 brief, Step 1: clear a 64x64 FBO to a known color, read it back, and write it to
//! a decodable PNG. This is the one test that must run on the real GPU (not skipped) on
//! the owner's NVIDIA 595.84 machine — see `tests/common::headless_gl` for the one
//! condition under which it legitimately skips instead (no EGL device at all).

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
