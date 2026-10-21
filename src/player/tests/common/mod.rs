//! Shared test harness for `gfx` integration tests (this task's `gfx_basic.rs`; later
//! tasks — effect shaders, layer composition, mpv textures — extend this module rather
//! than duplicating it).

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
