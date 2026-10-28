//! Task 8 brief, Step 1: the gl-transitions effect catalogue compiles every one of the
//! repo's 122 shared effects under desktop GL 3.3 core, and the one with no uniforms
//! ("fade") renders a correct midpoint blend.
//!
//! Skips cleanly (prints `SKIP: ...` and returns) when either precondition is missing:
//! no EGL device at all (`common::headless_gl`, mirrors `gfx_basic.rs`), or no
//! `transitions/` directory can be resolved (`Catalogue::resolve_dir`) — the case inside
//! `nix build .#liascape-player`'s sandboxed check phase, where `src/player` is built without
//! its sibling `transitions/` directory present. Never fails the build over either —
//! unless `LIASCAPE_REQUIRE_GPU=1` says this run must have both (`common::skip_gpu`).

mod common;

use common::{headless_gl, read_rgba};
use glow::HasContext;
use liascape_player::gfx::{Catalogue, Gfx, Tex};

/// Build a real `Gfx` + loaded `Catalogue`, or print why this test is skipping and
/// return `None`. Shared by every test below so each one's skip message names which of
/// the two preconditions was missing.
fn setup() -> Option<(Gfx, Catalogue)> {
    let gfx = headless_gl()?;
    let dir = common::catalogue_dir()?;
    let catalogue = Catalogue::load(&dir).unwrap_or_else(|e| {
        panic!("Catalogue::load({}) failed: {e}", dir.display());
    });
    Some((gfx, catalogue))
}

/// Clear `tex` (already wrapped nowhere — this creates its own short-lived FBO) to an
/// opaque solid color.
fn clear_to(gfx: &Gfx, tex: &Tex, rgba: [f32; 4]) {
    unsafe {
        let fbo = gfx.fbo(tex);
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
        gfx.gl.viewport(0, 0, tex.w as i32, tex.h as i32);
        gfx.gl.clear_color(rgba[0], rgba[1], rgba[2], rgba[3]);
        gfx.gl.clear(glow::COLOR_BUFFER_BIT);
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    }
}

#[test]
fn all_compile() {
    let Some((gfx, mut catalogue)) = setup() else {
        return;
    };

    let ids = catalogue.ids();
    assert_eq!(
        ids.len(),
        122,
        "manifest.json must list all 122 gl-transitions effects"
    );

    let mut failures = Vec::new();
    for id in &ids {
        if let Err(e) = catalogue.program(&gfx, id) {
            failures.push(format!("{id}:\n{e}"));
        }
    }

    assert!(
        failures.is_empty(),
        "{} / {} effects failed to compile under desktop GL 3.3 core:\n\n{}",
        failures.len(),
        ids.len(),
        failures.join("\n\n")
    );
}

#[test]
fn fade_midpoint() {
    let Some((gfx, mut catalogue)) = setup() else {
        return;
    };

    let from = gfx.tex(64, 64);
    let to = gfx.tex(64, 64);
    clear_to(&gfx, &from, [1.0, 0.0, 0.0, 1.0]);
    clear_to(&gfx, &to, [0.0, 0.0, 1.0, 1.0]);

    let target = gfx.tex(64, 64);
    let target_fbo = gfx.fbo(&target);

    let program = catalogue.program(&gfx, "fade").expect("fade must compile");

    unsafe {
        gfx.gl
            .bind_framebuffer(glow::FRAMEBUFFER, Some(target_fbo.id));
        gfx.gl.viewport(0, 0, 64, 64);
    }
    let params = serde_json::Map::new();
    program.draw(&gfx, &from, &to, 0.5, 1.0, &params);
    unsafe {
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    }

    let pixel = read_rgba(&gfx, &target, 32, 32);
    assert!(
        (pixel[0] as i32 - 127).abs() <= 2,
        "red channel at progress=0.5 should be ~127, got {}",
        pixel[0]
    );
    assert_eq!(pixel[1], 0, "green channel should be 0, got {}", pixel[1]);
    assert!(
        (pixel[2] as i32 - 127).abs() <= 2,
        "blue channel at progress=0.5 should be ~127, got {}",
        pixel[2]
    );
}

#[test]
fn defaults_applied() {
    let Some((gfx, mut catalogue)) = setup() else {
        return;
    };

    // Find the first manifest entry with a non-empty `uniforms` list by reading
    // manifest.json directly (the same file Catalogue::load already parsed) — this test
    // only needs an id, not Catalogue's internal uniform bookkeeping.
    let dir = Catalogue::resolve_dir().expect("setup() already proved this resolves");
    let manifest_text = std::fs::read_to_string(dir.join("manifest.json"))
        .expect("manifest.json must be readable (setup() already loaded it once)");
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).expect("manifest.json must be valid JSON");
    let id = manifest
        .as_array()
        .expect("manifest.json must be a JSON array")
        .iter()
        .find_map(|entry| {
            let uniforms = entry.get("uniforms")?.as_array()?;
            if uniforms.is_empty() {
                return None;
            }
            entry.get("id")?.as_str().map(|s| s.to_string())
        })
        .expect("at least one manifest entry must have non-empty uniforms");

    let from = gfx.tex(32, 32);
    let to = gfx.tex(32, 32);
    clear_to(&gfx, &from, [1.0, 1.0, 1.0, 1.0]);
    clear_to(&gfx, &to, [0.0, 0.0, 0.0, 1.0]);

    let target = gfx.tex(32, 32);
    let target_fbo = gfx.fbo(&target);

    let program = catalogue
        .program(&gfx, &id)
        .unwrap_or_else(|e| panic!("{id} must compile: {e}"));

    unsafe {
        gfx.gl
            .bind_framebuffer(glow::FRAMEBUFFER, Some(target_fbo.id));
        gfx.gl.viewport(0, 0, 32, 32);
        // Drain any GL error accumulated before this test's own draw call.
        while gfx.gl.get_error() != glow::NO_ERROR {}
    }

    // Empty params map: every uniform must fall back to its manifest default.
    let params = serde_json::Map::new();
    program.draw(&gfx, &from, &to, 0.5, 1.0, &params);

    let error = unsafe { gfx.gl.get_error() };
    unsafe {
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    }
    assert_eq!(
        error,
        glow::NO_ERROR,
        "{id}: drawing with only manifest defaults raised GL error 0x{error:x}"
    );
}
