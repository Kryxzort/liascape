//! Task 9 brief, Step 1: GPU pixel tests for layer composition — `Composer::compose_output`
//! drawing a real output's main layer (source or effect) with fill/fit/stretch/crop,
//! viewport spanning, and opacity, read back pixel-for-pixel.
//!
//! **Coordinate system for every pixel coordinate below: GL bottom-left origin** — the
//! same convention `tests/common::read_rgba` uses natively (`glReadPixels`), and the one
//! `gfx::compose`'s module doc comment documents for `UvRect::dst`. `(0, 0)` is the
//! bottom-left corner of the texture being read, not the top-left.
//!
//! Skips cleanly (prints `SKIP: ...`, returns) when either precondition is missing — same
//! two conditions `tests/effects_all.rs` already skips on: no EGL device at all, or no
//! `transitions/` directory resolves (true inside `nix build .#lp-player`'s sandboxed
//! check phase). Every test here needs a `Catalogue` even when it never actually draws an
//! effect, because `Composer::compose_output`'s signature always takes one (R20) — so a
//! missing `transitions/` skips every test in this file, not just the effect ones.

mod common;

use std::collections::HashMap;

use common::{headless_gl, read_rgba};
use glow::HasContext;
use lp_player::anim::PropPath;
use lp_player::gfx::{Catalogue, Composer, Gfx, Tex, fit_rect};
use lp_player::graph::{Fit, Graph, NodeKind, PropValue};
use serde_json::{Map, json};

fn setup() -> Option<(Gfx, Catalogue)> {
    let gfx = headless_gl()?;
    let Some(dir) = Catalogue::resolve_dir() else {
        println!(
            "SKIP: no transitions/ directory resolved (LP_TRANSITIONS_DIR unset, no ~/.local/share/livepaper-web/transitions, no repo transitions/ found above the exe or CARGO_MANIFEST_DIR)"
        );
        return None;
    };
    let catalogue = Catalogue::load(&dir).unwrap_or_else(|e| {
        panic!("Catalogue::load({}) failed: {e}", dir.display());
    });
    Some((gfx, catalogue))
}

fn p(s: &str) -> PropPath {
    PropPath(s.to_string())
}

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

fn make_output(g: &mut Graph, id: &str, w: i64, h: i64) {
    let mut props = Map::new();
    props.insert("width".to_string(), json!(w));
    props.insert("height".to_string(), json!(h));
    g.create(NodeKind::Output, Some(id.to_string()), props)
        .expect("create output");
}

fn make_source(g: &mut Graph, id: &str) {
    g.create(NodeKind::Source, Some(id.to_string()), Map::new())
        .expect("create source");
}

/// Brief: source 1920×800 into a 1920×1080 output under `fit` → bars of 140px top and
/// bottom; pixel (960,70) is in a bar (black), pixel (960,540) is in the content region
/// (shows the source).
#[test]
fn fit_letterbox() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    let mut g = Graph::new();
    make_output(&mut g, "out:DP-1", 1920, 1080);
    make_source(&mut g, "src1");
    g.set(&p("lay:DP-1:main.fit"), PropValue::Str("fit".to_string()))
        .unwrap();
    g.set(
        &p("lay:DP-1:main.content"),
        PropValue::Str("src1".to_string()),
    )
    .unwrap();

    let src_tex = gfx.tex(1920, 800);
    clear_to(&gfx, &src_tex, [1.0, 1.0, 1.0, 1.0]); // opaque white, so "shows source" is obvious

    let target_tex = gfx.tex(1920, 1080);
    let target_fbo = gfx.fbo(&target_tex);

    let mut registry: HashMap<String, Tex> = HashMap::new();
    registry.insert("src1".to_string(), src_tex);
    let textures = |id: &str| registry.get(id);

    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &target_fbo)
        .expect("compose_output");

    let bar = read_rgba(&gfx, &target_tex, 960, 70);
    assert_eq!(
        [bar[0], bar[1], bar[2]],
        [0, 0, 0],
        "letterbox bar must read black (rgb==0), got {bar:?}"
    );
    let content = read_rgba(&gfx, &target_tex, 960, 540);
    assert_eq!(
        content,
        [255, 255, 255, 255],
        "content region must show the (opaque white) source, got {content:?}"
    );
}

/// Brief: source 1920×800, `fill` into 1920×1080 → covers every pixel (no letterbox bars,
/// unlike `fit`), and the crop window `fit_rect` computes matches the exact 0.7407 uv.x
/// span from `compose::tests::fit_rect_fill_crops_uv_span`.
#[test]
fn fill_crops() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    let mut g = Graph::new();
    make_output(&mut g, "out:DP-1", 1920, 1080);
    make_source(&mut g, "src1");
    g.set(&p("lay:DP-1:main.fit"), PropValue::Str("fill".to_string()))
        .unwrap();
    g.set(
        &p("lay:DP-1:main.content"),
        PropValue::Str("src1".to_string()),
    )
    .unwrap();

    let src_tex = gfx.tex(1920, 800);
    clear_to(&gfx, &src_tex, [0.0, 1.0, 0.0, 1.0]); // opaque green

    let target_tex = gfx.tex(1920, 1080);
    let target_fbo = gfx.fbo(&target_tex);

    let mut registry: HashMap<String, Tex> = HashMap::new();
    registry.insert("src1".to_string(), src_tex);
    let textures = |id: &str| registry.get(id);

    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &target_fbo)
        .expect("compose_output");

    for (x, y) in [(0, 0), (1919, 0), (0, 1079), (1919, 1079), (960, 540)] {
        let px = read_rgba(&gfx, &target_tex, x, y);
        assert_eq!(
            px,
            [0, 255, 0, 255],
            "fill must cover every pixel (no bars), got {px:?} at ({x},{y})"
        );
    }

    let uv = fit_rect((1920, 800), (1920, 1080), Fit::Fill, [0.0, 0.0, 1.0, 1.0]);
    assert!(
        (uv.uv[2] - 0.740_740).abs() < 1e-3,
        "uv.x span = {}, want ≈0.7407",
        uv.uv[2]
    );
}

/// Brief: one 200×100 source (left half red, right half blue) spanned across two outputs
/// via complementary `viewport`s — DP-1 (left half) must show red at its centre, DP-2
/// (right half) blue.
#[test]
fn span_halves() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    let mut g = Graph::new();
    make_output(&mut g, "out:DP-1", 100, 100);
    make_output(&mut g, "out:DP-2", 100, 100);
    make_source(&mut g, "src1");
    for (connector, vp) in [
        ("DP-1", [0.0, 0.0, 0.5, 1.0]),
        ("DP-2", [0.5, 0.0, 0.5, 1.0]),
    ] {
        g.set(
            &p(&format!("lay:{connector}:main.fit")),
            PropValue::Str("fill".to_string()),
        )
        .unwrap();
        g.set(
            &p(&format!("lay:{connector}:main.viewport")),
            PropValue::List(vp.to_vec()),
        )
        .unwrap();
        g.set(
            &p(&format!("lay:{connector}:main.content")),
            PropValue::Str("src1".to_string()),
        )
        .unwrap();
    }

    // 200x100 source: left 100px red, right 100px blue.
    let src_tex = gfx.tex(200, 100);
    let src_fbo = gfx.fbo(&src_tex);
    unsafe {
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(src_fbo.id));
        gfx.gl.viewport(0, 0, 200, 100);
        gfx.gl.enable(glow::SCISSOR_TEST);
        gfx.gl.scissor(0, 0, 100, 100);
        gfx.gl.clear_color(1.0, 0.0, 0.0, 1.0);
        gfx.gl.clear(glow::COLOR_BUFFER_BIT);
        gfx.gl.scissor(100, 0, 100, 100);
        gfx.gl.clear_color(0.0, 0.0, 1.0, 1.0);
        gfx.gl.clear(glow::COLOR_BUFFER_BIT);
        gfx.gl.disable(glow::SCISSOR_TEST);
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    }

    let mut registry: HashMap<String, Tex> = HashMap::new();
    registry.insert("src1".to_string(), src_tex);
    let textures = |id: &str| registry.get(id);

    let dp1_tex = gfx.tex(100, 100);
    let dp1_fbo = gfx.fbo(&dp1_tex);
    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &dp1_fbo)
        .expect("compose_output DP-1");

    let dp2_tex = gfx.tex(100, 100);
    let dp2_fbo = gfx.fbo(&dp2_tex);
    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-2", &textures, &dp2_fbo)
        .expect("compose_output DP-2");

    let dp1_px = read_rgba(&gfx, &dp1_tex, 50, 50);
    assert_eq!(
        dp1_px,
        [255, 0, 0, 255],
        "DP-1 (left viewport half) centre must be red, got {dp1_px:?}"
    );
    let dp2_px = read_rgba(&gfx, &dp2_tex, 50, 50);
    assert_eq!(
        dp2_px,
        [0, 0, 255, 255],
        "DP-2 (right viewport half) centre must be blue, got {dp2_px:?}"
    );
}

/// Brief: a red layer at opacity 0.5 over black → (127±2, 0, 0). The target starts
/// cleared to transparent black and the blit shader outputs premultiplied colour, so the
/// raw readback already equals the over-black result (see `gfx::compose`'s module doc
/// comment, "Premultiplied-alpha opacity").
#[test]
fn opacity_half() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    let mut g = Graph::new();
    make_output(&mut g, "out:DP-1", 64, 64);
    make_source(&mut g, "src1");
    g.set(&p("lay:DP-1:main.opacity"), PropValue::F64(0.5))
        .unwrap();
    g.set(
        &p("lay:DP-1:main.content"),
        PropValue::Str("src1".to_string()),
    )
    .unwrap();

    let src_tex = gfx.tex(64, 64);
    clear_to(&gfx, &src_tex, [1.0, 0.0, 0.0, 1.0]); // opaque red

    let target_tex = gfx.tex(64, 64);
    let target_fbo = gfx.fbo(&target_tex);

    let mut registry: HashMap<String, Tex> = HashMap::new();
    registry.insert("src1".to_string(), src_tex);
    let textures = |id: &str| registry.get(id);

    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &target_fbo)
        .expect("compose_output");

    let px = read_rgba(&gfx, &target_tex, 32, 32);
    assert!(
        (px[0] as i32 - 127).abs() <= 2,
        "red channel at opacity 0.5 should be ~127, got {}",
        px[0]
    );
    assert_eq!(px[1], 0, "green channel should be 0, got {}", px[1]);
    assert_eq!(px[2], 0, "blue channel should be 0, got {}", px[2]);
}

/// R19: a missing source texture (the `textures` lookup returns `None`) draws as fully
/// transparent — no frame memory in this module at all.
#[test]
fn missing_source_texture_is_transparent() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    let mut g = Graph::new();
    make_output(&mut g, "out:DP-1", 32, 32);
    make_source(&mut g, "src1");
    g.set(
        &p("lay:DP-1:main.content"),
        PropValue::Str("src1".to_string()),
    )
    .unwrap();

    let target_tex = gfx.tex(32, 32);
    let target_fbo = gfx.fbo(&target_tex);

    // Deliberately empty: `textures("src1")` always misses.
    let registry: HashMap<String, Tex> = HashMap::new();
    let textures = |id: &str| registry.get(id);

    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &target_fbo)
        .expect("compose_output");

    let px = read_rgba(&gfx, &target_tex, 16, 16);
    assert_eq!(
        px,
        [0, 0, 0, 0],
        "a missing source texture must draw as fully transparent (R19), got {px:?}"
    );
}

/// Reuses `tests/effects_all.rs`'s `fade_midpoint` expectation, now driven entirely
/// through the graph: an Effect node (`effect_id = "fade"`, `from`/`to` two colour
/// sources, `progress = 0.5`) set as a layer's `content` must blend to the same midpoint
/// `EffectProgram::draw` produces directly.
#[test]
fn effect_fade_midpoint_through_graph() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    let mut g = Graph::new();
    make_output(&mut g, "out:DP-1", 64, 64);
    make_source(&mut g, "src1");
    make_source(&mut g, "src2");

    let mut fx_props = Map::new();
    fx_props.insert("effect_id".to_string(), json!("fade"));
    fx_props.insert("from".to_string(), json!("src1"));
    fx_props.insert("to".to_string(), json!("src2"));
    fx_props.insert("progress".to_string(), json!(0.5));
    let fx = g
        .create(NodeKind::Effect, None, fx_props)
        .expect("create effect");
    g.set(&p("lay:DP-1:main.content"), PropValue::Str(fx))
        .unwrap();

    let from_tex = gfx.tex(64, 64);
    clear_to(&gfx, &from_tex, [1.0, 0.0, 0.0, 1.0]); // red
    let to_tex = gfx.tex(64, 64);
    clear_to(&gfx, &to_tex, [0.0, 0.0, 1.0, 1.0]); // blue

    let target_tex = gfx.tex(64, 64);
    let target_fbo = gfx.fbo(&target_tex);

    let mut registry: HashMap<String, Tex> = HashMap::new();
    registry.insert("src1".to_string(), from_tex);
    registry.insert("src2".to_string(), to_tex);
    let textures = |id: &str| registry.get(id);

    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &target_fbo)
        .expect("compose_output");

    let px = read_rgba(&gfx, &target_tex, 32, 32);
    assert!(
        (px[0] as i32 - 127).abs() <= 2,
        "red channel at progress=0.5 should be ~127, got {}",
        px[0]
    );
    assert_eq!(px[1], 0, "green channel should be 0, got {}", px[1]);
    assert!(
        (px[2] as i32 - 127).abs() <= 2,
        "blue channel at progress=0.5 should be ~127, got {}",
        px[2]
    );
}
