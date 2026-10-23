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

/// Uploads a `w`×`h` texture directly (not via an FBO clear, since a uniform colour can't
/// distinguish a Y flip): the **first** `h/2` rows of the pixel buffer handed to
/// `glTexImage2D` are `top`, the rest `bottom` — i.e. "top" in the same sense a PNG
/// decoder or any standard image loader uses it (row 0 of the raw data = the image's top
/// row). Used by `y_axis_orientation_matches_image_top` to pin down whether
/// `gfx::compose`'s sampling convention actually matches that, since nothing else in this
/// file varies along Y.
fn make_top_bottom_tex(gfx: &Gfx, w: u32, h: u32, top: [u8; 4], bottom: [u8; 4]) -> Tex {
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let half = (h / 2) as usize;
    for row in 0..h as usize {
        let colour = if row < half { top } else { bottom };
        for col in 0..w as usize {
            let i = (row * w as usize + col) * 4;
            buf[i..i + 4].copy_from_slice(&colour);
        }
    }
    unsafe {
        let id = gfx.gl.create_texture().expect("create_texture");
        gfx.gl.bind_texture(glow::TEXTURE_2D, Some(id));
        gfx.gl.tex_image_2d(
            glow::TEXTURE_2D,
            0,
            glow::RGBA8 as i32,
            w as i32,
            h as i32,
            0,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelUnpackData::Slice(Some(&buf)),
        );
        gfx.gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_MIN_FILTER,
            glow::LINEAR as i32,
        );
        gfx.gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_MAG_FILTER,
            glow::LINEAR as i32,
        );
        gfx.gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_WRAP_S,
            glow::CLAMP_TO_EDGE as i32,
        );
        gfx.gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_WRAP_T,
            glow::CLAMP_TO_EDGE as i32,
        );
        gfx.gl.bind_texture(glow::TEXTURE_2D, None);
        Tex { id, w, h }
    }
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

/// Review finding (Important): nothing above varies along Y (`fit_letterbox`'s bars are
/// symmetric top/bottom, `fill_crops`/`opacity_half`/`effect_fade_midpoint_through_graph`
/// are uniform in colour, `span_halves` only splits along X) — a silently Y-flipped
/// sampling convention would have passed every one of them. This pins the whole chain
/// (raw pixel upload → `Composer::compose_output` → `read_rgba` → `Gfx::write_png` →
/// decoded PNG) against a source that's genuinely asymmetric in Y: the **first** half of
/// the uploaded pixel rows (standard PNG/raster "top") is red, the second half (the
/// image's "bottom") is blue — see `make_top_bottom_tex`.
#[test]
fn y_axis_orientation_matches_image_top() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];

    // --- Part 1: `stretch`, full (default) viewport. The image's top (red, the first
    // uploaded rows) must land at the OUTPUT's visual top; its bottom (blue) at the
    // output's visual bottom. In `read_rgba`'s bottom-left-origin coordinates that means
    // a HIGH y reads red, a LOW y reads blue.
    let out = {
        let mut g = Graph::new();
        make_output(&mut g, "out:DP-1", 64, 64);
        make_source(&mut g, "src1");
        g.set(
            &p("lay:DP-1:main.fit"),
            PropValue::Str("stretch".to_string()),
        )
        .unwrap();
        g.set(
            &p("lay:DP-1:main.content"),
            PropValue::Str("src1".to_string()),
        )
        .unwrap();

        let src_tex = make_top_bottom_tex(&gfx, 64, 64, RED, BLUE);
        let target_tex = gfx.tex(64, 64);
        let target_fbo = gfx.fbo(&target_tex);
        let mut registry: HashMap<String, Tex> = HashMap::new();
        registry.insert("src1".to_string(), src_tex);
        let textures = |id: &str| registry.get(id);

        composer
            .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &target_fbo)
            .expect("compose_output");

        let top = read_rgba(&gfx, &target_tex, 32, 59);
        assert_eq!(
            top, RED,
            "image top (the first uploaded pixel rows) must land at the output's visual \
             top (high read_rgba y), got {top:?}"
        );
        let bottom = read_rgba(&gfx, &target_tex, 32, 4);
        assert_eq!(
            bottom, BLUE,
            "image bottom must land at the output's visual bottom (low read_rgba y), got \
             {bottom:?}"
        );
        target_tex
    };

    // --- write_png round trip on the same composed output: a decoded PNG is top-down by
    // definition (`Gfx::write_png`'s documented contract), so its near-top rows must be
    // red and its near-bottom rows blue — closing the loop end to end (upload convention
    // → compose → read_rgba's GL convention → write_png's deliberate re-flip → the PNG a
    // human would actually look at).
    {
        let path = std::env::temp_dir().join(format!(
            "lp_player_compose_y_axis_{}.png",
            std::process::id()
        ));
        gfx.write_png(&out, &path).expect("write_png failed");

        let decoder = png::Decoder::new(std::io::BufReader::new(
            std::fs::File::open(&path).expect("png file must exist and be openable"),
        ));
        let mut reader = decoder.read_info().expect("png must be decodable");
        let mut buf = vec![
            0u8;
            reader
                .output_buffer_size()
                .expect("png must report a buffer size")
        ];
        let info = reader.next_frame(&mut buf).expect("png must decode");
        let stride = info.width as usize * 4;

        let top_row = &buf[2 * stride..2 * stride + 4];
        assert_eq!(
            top_row, RED,
            "decoded PNG row 2 (near its top) must be red, got {top_row:?}"
        );
        let bottom_row_start = (info.height as usize - 3) * stride;
        let bottom_row = &buf[bottom_row_start..bottom_row_start + 4];
        assert_eq!(
            bottom_row, BLUE,
            "decoded PNG row near its bottom must be blue, got {bottom_row:?}"
        );

        let _ = std::fs::remove_file(&path);
    }

    // --- Part 2: a `viewport` restricted to `[0, 0, 1, 0.5]` — per this module's
    // documented convention, the source's *first* half (native-texel terms) — must
    // select the image's actual top (red) half, not its bottom. If it did, the whole
    // output would read uniformly red; sampled anywhere.
    {
        let mut g = Graph::new();
        make_output(&mut g, "out:DP-2", 32, 32);
        make_source(&mut g, "src2");
        g.set(
            &p("lay:DP-2:main.fit"),
            PropValue::Str("stretch".to_string()),
        )
        .unwrap();
        g.set(
            &p("lay:DP-2:main.viewport"),
            PropValue::List(vec![0.0, 0.0, 1.0, 0.5]),
        )
        .unwrap();
        g.set(
            &p("lay:DP-2:main.content"),
            PropValue::Str("src2".to_string()),
        )
        .unwrap();

        let src_tex = make_top_bottom_tex(&gfx, 64, 64, RED, BLUE);
        let target_tex = gfx.tex(32, 32);
        let target_fbo = gfx.fbo(&target_tex);
        let mut registry: HashMap<String, Tex> = HashMap::new();
        registry.insert("src2".to_string(), src_tex);
        let textures = |id: &str| registry.get(id);

        composer
            .compose_output(&gfx, &g, &mut cat, "out:DP-2", &textures, &target_fbo)
            .expect("compose_output");

        for (x, y) in [(16, 4), (16, 27), (2, 16), (29, 16)] {
            let px = read_rgba(&gfx, &target_tex, x, y);
            assert_eq!(
                px, RED,
                "viewport [0,0,1,0.5] must select the image's actual top (red) half \
                 everywhere, got {px:?} at ({x},{y})"
            );
        }
    }
}

/// Review finding (Critical, fix round 1 → fix round 2): round 1's fix made plain
/// `Source` layers correct but introduced a *double* Y-flip for the `Effect` path
/// (`render_side` pre-flipped raw `from`/`to` textures, and
/// `effects::EffectProgram::draw` flips again via `transitions/wrap.frag.template`'s
/// unconditional `getFromColor`/`getToColor` — flip∘flip = identity = the *original*
/// upside-down bug, just now only for transitions). Untested at the time because
/// `y_axis_orientation_matches_image_top` only exercises a plain `Source` layer, and
/// `effect_fade_midpoint_through_graph` uses Y-uniform colours that can't distinguish a
/// flip from no flip.
///
/// This pins the property that actually matters: **a transition at `progress = 0`/`1`
/// must look pixel-identical to the plain `Source` layer it starts/ends on** — for two
/// Y-asymmetric sources (A: top-red/bottom-blue, B: top-green/bottom-yellow, "top" in the
/// first-uploaded-pixel-row/PNG sense, via `make_top_bottom_tex`), under both `fit =
/// stretch` with the default full viewport and `fit = stretch` with a `viewport`
/// restricted to the image's top half — scanning every output row, not just a sampled
/// upper/lower pair.
#[test]
fn effect_progress_endpoints_match_plain_source() {
    let Some((gfx, mut cat)) = setup() else {
        return;
    };
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    const A_TOP: [u8; 4] = [255, 0, 0, 255]; // red
    const A_BOTTOM: [u8; 4] = [0, 0, 255, 255]; // blue
    const B_TOP: [u8; 4] = [0, 255, 0, 255]; // green
    const B_BOTTOM: [u8; 4] = [255, 255, 0, 255]; // yellow

    const OUT_SIZE: (i64, i64) = (64, 64);

    for (scenario, viewport) in [
        ("stretch_full_viewport", [0.0_f64, 0.0, 1.0, 1.0]),
        ("stretch_top_half_viewport", [0.0_f64, 0.0, 1.0, 0.5]),
    ] {
        // progress = 0.0 must match plain A; progress = 1.0 must match plain B.
        for (progress, plain_is_a) in [(0.0_f64, true), (1.0_f64, false)] {
            let mut g = Graph::new();
            make_output(&mut g, "out:PLAIN", OUT_SIZE.0, OUT_SIZE.1);
            make_output(&mut g, "out:FX", OUT_SIZE.0, OUT_SIZE.1);
            make_source(&mut g, "a");
            make_source(&mut g, "b");

            let plain_content = if plain_is_a { "a" } else { "b" };
            g.set(
                &p("lay:PLAIN:main.fit"),
                PropValue::Str("stretch".to_string()),
            )
            .unwrap();
            g.set(
                &p("lay:PLAIN:main.viewport"),
                PropValue::List(viewport.to_vec()),
            )
            .unwrap();
            g.set(
                &p("lay:PLAIN:main.content"),
                PropValue::Str(plain_content.to_string()),
            )
            .unwrap();

            let mut fx_props = Map::new();
            fx_props.insert("effect_id".to_string(), json!("fade"));
            fx_props.insert("from".to_string(), json!("a"));
            fx_props.insert("to".to_string(), json!("b"));
            fx_props.insert("progress".to_string(), json!(progress));
            let fx = g
                .create(NodeKind::Effect, None, fx_props)
                .expect("create effect");
            g.set(&p("lay:FX:main.fit"), PropValue::Str("stretch".to_string()))
                .unwrap();
            g.set(
                &p("lay:FX:main.viewport"),
                PropValue::List(viewport.to_vec()),
            )
            .unwrap();
            g.set(&p("lay:FX:main.content"), PropValue::Str(fx))
                .unwrap();

            let a_tex = make_top_bottom_tex(&gfx, 64, 64, A_TOP, A_BOTTOM);
            let b_tex = make_top_bottom_tex(&gfx, 64, 64, B_TOP, B_BOTTOM);
            let mut registry: HashMap<String, Tex> = HashMap::new();
            registry.insert("a".to_string(), a_tex);
            registry.insert("b".to_string(), b_tex);
            let textures = |id: &str| registry.get(id);

            let plain_tex = gfx.tex(64, 64);
            let plain_fbo = gfx.fbo(&plain_tex);
            composer
                .compose_output(&gfx, &g, &mut cat, "out:PLAIN", &textures, &plain_fbo)
                .expect("plain compose_output");

            let fx_tex = gfx.tex(64, 64);
            let fx_fbo = gfx.fbo(&fx_tex);
            composer
                .compose_output(&gfx, &g, &mut cat, "out:FX", &textures, &fx_fbo)
                .expect("fx compose_output");

            // Full-row scan down the centre column: every row's colour must match
            // within ±1 per channel (float/texture-filtering slack, not an orientation
            // ambiguity — these fixtures are uniform within each half, far from any
            // filtering boundary at the sampled rows).
            for y in 0..64u32 {
                let plain_px = read_rgba(&gfx, &plain_tex, 32, y);
                let fx_px = read_rgba(&gfx, &fx_tex, 32, y);
                for c in 0..4 {
                    assert!(
                        (plain_px[c] as i32 - fx_px[c] as i32).abs() <= 1,
                        "{scenario}, progress={progress}: row {y} mismatch between plain \
                         Source ({plain_content}) and the effect's endpoint: plain={plain_px:?} \
                         fx={fx_px:?}"
                    );
                }
            }
        }
    }
}

/// M3 (final review): an effect this driver can't compile draws as a cut (the side the
/// progress is nearer), never a black output — and the failure is cached: the next call
/// doesn't re-read or re-compile (`Catalogue::failed`).
#[test]
fn uncompilable_effect_draws_a_cut_not_black() {
    let Some((gfx, _cat)) = setup() else {
        return;
    };
    let Some(src) = Catalogue::resolve_dir() else {
        return;
    };
    // A catalogue copy whose `fade` body is broken GLSL (the shared assets stay untouched).
    let dir = std::env::temp_dir().join(format!("lp-broken-cat-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("glsl")).unwrap();
    for f in ["manifest.json", "wrap.vert", "wrap.frag.template"] {
        std::fs::copy(src.join(f), dir.join(f)).unwrap();
    }
    std::fs::write(dir.join("glsl/fade.glsl"), "this is not glsl {").unwrap();
    let mut cat = Catalogue::load(&dir).expect("load the copy");
    let mut composer = Composer::new(&gfx).expect("Composer::new");

    let mut g = Graph::new();
    make_output(&mut g, "out:DP-1", 64, 64);
    make_source(&mut g, "src1");
    make_source(&mut g, "src2");
    let mut fx_props = Map::new();
    fx_props.insert("effect_id".to_string(), json!("fade"));
    fx_props.insert("from".to_string(), json!("src1"));
    fx_props.insert("to".to_string(), json!("src2"));
    fx_props.insert("progress".to_string(), json!(0.25));
    let fx = g.create(NodeKind::Effect, None, fx_props).unwrap();
    g.set(&p("lay:DP-1:main.content"), PropValue::Str(fx.clone()))
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
        .expect("a broken effect is a cut, not a compose error");
    let px = read_rgba(&gfx, &target_tex, 32, 32);
    assert!(
        px[0] > 250 && px[2] < 5,
        "progress 0.25 → from (red), got {px:?}"
    );
    assert!(cat.failed("fade"), "the failure is cached");

    g.set(&p(&format!("{fx}.progress")), PropValue::F64(0.75))
        .unwrap();
    composer
        .compose_output(&gfx, &g, &mut cat, "out:DP-1", &textures, &target_fbo)
        .unwrap();
    let px = read_rgba(&gfx, &target_tex, 32, 32);
    assert!(
        px[2] > 250 && px[0] < 5,
        "progress 0.75 → to (blue), got {px:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
