//! Layer composition (spec §4.2 "Layer"/"Effect", §4.3 span/mirror recipes): draws one
//! output's main layer — a single source, or an effect blending two sources — into the
//! caller's target [`Fbo`], applying the layer's `fit`/`viewport` transform and `opacity`.
//!
//! See `.claude/rules/player-core.md`'s "Composition" section for the fit-semantics
//! table, the viewport/span rule, the coordinate conventions, the premultiplied-opacity
//! contract, and rulings R19/R20 this module implements.
//!
//! **R19 (no frame memory here).** [`Composer::compose_output`] never remembers a
//! previous frame. A missing texture — the caller's `textures` lookup returning `None` —
//! draws as fully transparent, for both a plain source layer and either side of an
//! effect. Keeping the last good frame around when a source stalls is the *Source*'s job
//! (Task 10), not this module's: this module is purely `(graph state, live textures) ->
//! one composited frame`.
//!
//! **R20 (this task's exact API).** The brief's free `compose_output` function becomes a
//! method on [`Composer`], which caches the output-sized intermediate textures an effect
//! needs across calls (keyed by `(width, height)`, since every output this process will
//! ever drive is one of a small, effectively-fixed set of sizes) and owns the small
//! blit/transform shader every draw (source or effect-result) is composited through.
//! [`fit_rect`] stays a pure free function — the brief's exact signature, unit-testable
//! with no GPU at all.
//!
//! ## Coordinate conventions (read this before touching pixel math here)
//!
//! Both halves of [`UvRect`] — `uv` (a sub-rectangle of the *source* texture) and `dst` (a
//! sub-rectangle of the *output*, in pixels) — use **GL's native bottom-left origin**:
//! `(0, 0)` is the bottom-left corner, matching `tests/common::read_rgba` (`glReadPixels`'s
//! own convention) and `gl_FragCoord`. **This placement math (`fit_rect`/`axis`, and
//! `dst`'s effect on `gl.viewport`) is never flipped** — `dst`'s bars/crop/centring land
//! at the same screen position regardless of which texture is being sampled. Every pixel
//! assertion in `tests/compose.rs` is read through `read_rgba`, so it inherits this origin
//! directly. `fit_letterbox`'s and `fill_crops`' fixtures vary only in X (uniform in Y) and
//! `span_halves`' only tests an X split, so none of them can tell a correct Y placement
//! from a swapped one — `y_axis_orientation_matches_image_top` (below) is the one that
//! does, with a Y-asymmetric (top-red/bottom-blue) source.
//!
//! **Sampling, separately from placement, *is* flipped — but exactly once per source,
//! on exactly one of this module's three draw sites.** A raw source texture is assumed
//! uploaded in standard top-down/PNG row order (buffer row 0 = the image's top row); GL's
//! own texel addressing places that row at `t = 0`, i.e. the texture's bottom-left-origin
//! "bottom." Sampled with no correction anywhere, a plain `Source` layer would render
//! upside down. [`BLIT_FRAG_SRC`]'s `flip_v` uniform is `true` *only* for
//! [`Composer::compose_output`]'s plain-`Source` branch (drawn straight into the target,
//! with nothing else downstream to correct it) and `false` everywhere else — including
//! [`render_side`]'s `from`/`to` passes into an effect's intermediates, which must hand
//! `effects::EffectProgram::draw` *uncorrected* data, because that function's own,
//! unconditional `getFromColor`/`getToColor` flip (via `transitions/wrap.frag.template`,
//! untouched — this crate never edits `transitions/`) is the correction for the `Effect`
//! path. Flipping in both places compounds to no correction at all (flip∘flip =
//! identity) — a real bug this module shipped once, caught by review rather than by a
//! test that actually compared the two paths; see [`BLIT_FRAG_SRC`]'s own doc comment
//! ("Which draws need `flip_v = true`") for the full reasoning and
//! `tests/compose.rs::effect_progress_endpoints_match_plain_source` for the regression
//! test (a transition at `progress = 0`/`1` must be pixel-identical to the plain `Source`
//! layer it starts/ends on, Y-asymmetric sources, both a full `stretch` and a `viewport`-
//! restricted case).
//!
//! ## Premultiplied-alpha opacity
//!
//! Every draw this module issues — a plain source layer, either side of an effect
//! rendered into its intermediate, and the effect's own blended result — goes through the
//! same blit shader, which outputs **premultiplied** colour (`rgb * opacity`, `a *
//! opacity`) and blends with `glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA)` onto a target
//! already cleared to transparent black (`0,0,0,0`). Concretely: a fully-opaque red
//! source (`1,0,0,1`) at `opacity = 0.5` writes `(0.5, 0, 0, 0.5)` into the (transparent)
//! target — read back as `rgb ≈ (127, 0, 0)`, matching the brief's `opacity_half` number
//! directly, with **no separate "composite over black" step needed**: because premultiplied
//! colour *is* the correct final RGB once actually displayed over black, reading it
//! straight off the target already gives the right answer for a black backdrop. A real
//! on-screen present (a later task) composites this premultiplied buffer over whatever's
//! actually behind the output surface; this module only has to get the premultiplied
//! maths right once.
//!
//! ## Fit semantics (brief's four modes, unified by [`fit_rect`]/[`axis`])
//!
//! | `fit`      | meaning                                              | mpv equivalent    |
//! |------------|-------------------------------------------------------|-------------------|
//! | `fill`     | covers the output, cropping the excess (same scale on both axes) | `panscan=1.0` |
//! | `fit`      | contains with letterbox/pillarbox bars (same scale on both axes) | `panscan=0.0` |
//! | `stretch`  | ignores aspect — independent scale per axis, always fills exactly | — |
//! | `crop`     | source pixels 1:1 (scale fixed at `1.0`), centred, crops *or* pads per axis independently | — |
//!
//! All four reduce to the same per-axis rule ([`axis`]): given the *effective* source size
//! on that axis (see "viewport" below) and that axis's scale factor, either the scaled
//! source overflows the output axis (→ crop: the output axis is filled completely, the
//! source's visible fraction on that axis shrinks and is centred) or it underflows (→ pad:
//! the source is shown in full on that axis, centred, leaving transparent bars — which read
//! back as black per the opacity section above, since the target started transparent-black
//! and bars are simply never drawn over). What differs between the four modes is only
//! *which* scale factor(s) feed that one rule: `fill`/`fit` use one shared scale
//! (`max`/`min` of the two per-axis ratios); `stretch` uses each axis's own exact-fit ratio
//! (so both axes always land in the "exact/overflow" branch with a visible fraction of
//! `1.0` — no crop, no pad, by construction); `crop` fixes the scale at `1.0` and lets each
//! axis decide crop-vs-pad independently.
//!
//! ## Viewport / spanning
//!
//! `viewport` (`Layer.viewport`, already range-checked by `graph::props` to `x,y ∈ [0,1]`,
//! `w,h ∈ (0,1]`) selects a normalised sub-rectangle of the *source* texture **before**
//! `fit` ever runs: the "effective source size" `fit_rect` scales/crops is `(src_w *
//! viewport.w, src_h * viewport.h)` pixels, and every `uv` this function returns is that
//! sub-rectangle's own coordinates re-expressed in the *full* texture's `[0,1]` space
//! (`viewport.xy + (sub-rect coords) * viewport.wh`). Spanning one source across two
//! outputs is exactly two layers with the same `content`, same `fit`, and complementary
//! viewports — e.g. `DP-1` gets `[0, 0, 0.5, 1]` (the source's left half) and `DP-2` gets
//! `[0.5, 0, 0.5, 1]` (its right half), per the brief.

use std::collections::HashMap;

use glow::HasContext;
use serde_json::{Map, Value};

use super::effects::Catalogue;
use super::egl::Gfx;
use super::gl::{Fbo, Tex};
use crate::anim::PropPath;
use crate::graph::{Fit, Graph, PropValue};

/// `fit_rect`'s result: a mapping from one normalised sub-rectangle of the *source*
/// texture (`uv`) to one pixel sub-rectangle of the *output* (`dst`). Both use GL's
/// bottom-left origin — see the module doc comment's "Coordinate conventions" section.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UvRect {
    /// `[x, y, w, h]`, normalised (`0..=1`) coordinates within the *source* texture.
    pub uv: [f64; 4],
    /// `[x, y, w, h]`, pixel coordinates within the *output*.
    pub dst: [f64; 4],
}

/// One axis of [`fit_rect`]'s rule (see the module doc comment's "Fit semantics"
/// section): given `effective_px` (the viewport-selected source size on this axis, in
/// source pixels) and `scale` (how much this axis is being scaled by), decide whether the
/// scaled source overflows or underflows `output_px`, and return `(uv_start, uv_span,
/// dst_start, dst_span)` for this axis alone — `uv_start`/`uv_span` are normalised
/// *within the viewport sub-rectangle already selected* (the caller re-expresses them in
/// full-texture space), `dst_start`/`dst_span` are output pixels.
///
/// `effective_px <= 0.0` (a degenerate/empty viewport slice) can't divide sanely; callers
/// never produce one (`viewport.w`/`h` are range-checked to `(0, 1]` by `graph::props`,
/// and a real texture is never `0`-sized), so this isn't guarded further here.
fn axis(effective_px: f64, scale: f64, output_px: u32) -> (f64, f64, f64, f64) {
    let output_px = output_px as f64;
    let scaled_px = effective_px * scale;
    if scaled_px >= output_px {
        // Overflow (or an exact match, which takes this branch too — `visible_frac`
        // comes out to exactly `1.0` either way): crop. The output axis is filled
        // completely; the *visible* fraction of the effective source shrinks and is
        // centred.
        let visible_px = output_px / scale;
        let visible_frac = (visible_px / effective_px).min(1.0);
        let uv_start = (1.0 - visible_frac) / 2.0;
        (uv_start, visible_frac, 0.0, output_px)
    } else {
        // Underflow: pad. The whole effective source is visible on this axis; it's
        // centred within the output, leaving bars on both sides.
        let dst_span = scaled_px;
        let dst_start = (output_px - dst_span) / 2.0;
        (0.0, 1.0, dst_start, dst_span)
    }
}

/// Maps a `src`-sized texture into a `dst`-sized output under `fit`, after first
/// selecting `viewport` (a normalised sub-rectangle of `src`) — the brief's exact pure
/// function. See the module doc comment for the full semantics; this is the one place
/// that picks each mode's per-axis scale factor(s) and feeds them through [`axis`].
pub fn fit_rect(src: (u32, u32), dst: (u32, u32), fit: Fit, viewport: [f64; 4]) -> UvRect {
    let (sw, sh) = (src.0 as f64, src.1 as f64);
    let (dw, dh) = dst;
    let [vx, vy, vw, vh] = viewport;

    // The viewport-selected sub-rectangle's own size, in source pixels — this is what
    // every fit mode below actually scales/crops, not the full source.
    let vsw = sw * vw;
    let vsh = sh * vh;

    let (scale_x, scale_y) = match fit {
        Fit::Fill => {
            let s = (dw as f64 / vsw).max(dh as f64 / vsh);
            (s, s)
        }
        Fit::Fit => {
            let s = (dw as f64 / vsw).min(dh as f64 / vsh);
            (s, s)
        }
        Fit::Stretch => (dw as f64 / vsw, dh as f64 / vsh),
        Fit::Crop => (1.0, 1.0),
    };

    let (uv_x, uv_w, dst_x, dst_w) = axis(vsw, scale_x, dw);
    let (uv_y, uv_h, dst_y, dst_h) = axis(vsh, scale_y, dh);

    UvRect {
        // Re-express the viewport-local uv back into full-texture normalised space.
        uv: [vx + uv_x * vw, vy + uv_y * vh, uv_w * vw, uv_h * vh],
        dst: [dst_x, dst_y, dst_w, dst_h],
    }
}

/// `transitions/wrap.vert`'s fullscreen-triangle trick, re-derived here (rather than
/// reused) because this shader's `vUv` must NOT carry that file's deliberate vertical
/// flip (see the module doc comment) — this crate never edits `transitions/` itself, and
/// this is a different shader with a different contract, not an edit of that one.
const BLIT_VERT_SRC: &str = "#version 330 core
out vec2 vUv;
const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main() {
    vec2 p = P[gl_VertexID];
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}
";

/// The blit/transform fragment shader: samples `tex` within the `uv_rect` sub-window
/// (i.e. `vUv` walks the *currently bound viewport's* extent, which the caller has
/// already restricted to the destination sub-rectangle — see [`draw_rect`]) and outputs
/// premultiplied colour scaled by `opacity` (module doc comment's "Premultiplied-alpha
/// opacity" section).
///
/// `flip_v` is `true` (`ty = 1.0 - vUv.y`, applied *within* the already-selected
/// `uv_rect` window, not globally) for exactly **one** call site — [`Composer::
/// compose_output`]'s plain-`Source` branch, drawing a raw caller-supplied texture
/// straight into the final target — and `false` (pass-through, `ty = vUv.y`) everywhere
/// else. This is **not** "every raw-source draw gets the correction, every already-
/// written texture doesn't" (that was this module's first, buggy attempt, fixed by this
/// round): what actually decides it is whether *anything downstream* already applies
/// `transitions/wrap.frag.template`'s `getFromColor`/`getToColor` flip
/// (`texture(fromTex, vec2(uv.x, 1.0 - uv.y))`, untouched — this crate never edits
/// `transitions/`) to the same texture before it reaches the screen:
///
/// - **Plain `Source` layer → target: `flip_v = true`.** Nothing else in this draw's path
///   corrects orientation, so this draw must. A raw texture is assumed uploaded in
///   standard top-down/PNG row order (buffer row 0 = image top); GL's own texel
///   addressing places that row at `t = 0`, the bottom-left-origin "bottom." Uncorrected,
///   the image's top would render at the output's visual bottom.
/// - **[`render_side`]'s `from`/`to` passes → their intermediate: `flip_v = false`.**
///   The intermediate is consumed next by `effects::EffectProgram::draw`, which *always*
///   applies the `getFromColor`/`getToColor` flip when it samples `fromTex`/`toTex` —
///   regardless of what this module does. If `render_side` pre-flipped too, the two
///   flips would compose to the identity (flip∘flip = no correction at all), silently
///   reintroducing the exact upside-down bug `flip_v` exists to fix — for every
///   transition, while a plain `Source` layer stayed correct. (This is precisely what
///   shipped in this module's first attempt at the fix, caught by review, not by any
///   test at the time.) `render_side` must hand `EffectProgram::draw` data in the *same*
///   raw, uncorrected orientation a live source texture would already be in, and let that
///   one, already-unconditional flip be the *only* correction applied.
/// - **The effect's "result" intermediate → target (end of [`Composer::draw_effect`]):
///   `flip_v = false`.** By the time `EffectProgram::draw` has written it, the one
///   necessary correction (above) has already happened; this blit is a plain, same-
///   orientation copy into the target, so flipping again would un-correct it.
///
/// Net effect: exactly one correction is ever applied to a given source's image data on
/// its way to the screen, regardless of whether it got there via a plain `Source` layer
/// or via an `Effect` — which is the actual property that matters (a transition at
/// `progress = 0`/`1` must look identical to the plain layer it's transitioning from/to;
/// covered by `tests/compose.rs::effect_progress_endpoints_match_plain_source`).
const BLIT_FRAG_SRC: &str = "#version 330 core
uniform sampler2D tex;
uniform vec4 uv_rect;
uniform float opacity;
uniform bool flip_v;
in vec2 vUv;
out vec4 fragColor;
void main() {
    float ty = flip_v ? (1.0 - vUv.y) : vUv.y;
    vec2 uv = vec2(uv_rect.x + vUv.x * uv_rect.z, uv_rect.y + ty * uv_rect.w);
    vec4 c = texture(tex, uv);
    fragColor = vec4(c.rgb * opacity, c.a * opacity);
}
";

/// The compiled blit program plus its three uniform locations (any of which may be
/// `None` if the driver optimised it away — same "skip silently" rule as
/// `effects::EffectProgram`).
struct BlitProgram {
    program: glow::Program,
    tex_loc: Option<glow::UniformLocation>,
    uv_rect_loc: Option<glow::UniformLocation>,
    opacity_loc: Option<glow::UniformLocation>,
    flip_v_loc: Option<glow::UniformLocation>,
}

impl BlitProgram {
    fn new(gfx: &Gfx) -> Result<Self, String> {
        let program = gfx.program(BLIT_VERT_SRC, BLIT_FRAG_SRC)?;
        // SAFETY: `program` just linked successfully; `gfx`'s context is current on this
        // thread for `Gfx`'s lifetime, same precondition every other `gl.*` call in this
        // crate relies on.
        let (tex_loc, uv_rect_loc, opacity_loc, flip_v_loc) = unsafe {
            (
                gfx.gl.get_uniform_location(program, "tex"),
                gfx.gl.get_uniform_location(program, "uv_rect"),
                gfx.gl.get_uniform_location(program, "opacity"),
                gfx.gl.get_uniform_location(program, "flip_v"),
            )
        };
        Ok(BlitProgram {
            program,
            tex_loc,
            uv_rect_loc,
            opacity_loc,
            flip_v_loc,
        })
    }

    /// Draws the fullscreen triangle into whatever FBO/viewport is already bound — same
    /// draw-into-bound-FBO contract as `effects::EffectProgram::draw`. `uv` is the
    /// `[x,y,w,h]` sub-rectangle of `tex` to sample (`UvRect::uv`); the destination
    /// sub-rectangle is implicit in the caller's already-set `glViewport`, not a
    /// parameter here. `flip_v` is [`BLIT_FRAG_SRC`]'s orientation-correction switch —
    /// see that constant's doc comment ("Which draws need `flip_v = true`") for exactly
    /// which call sites need `true` (only one) and why the rest need `false`, including
    /// the raw-source ones.
    fn draw(&self, gfx: &Gfx, tex: &Tex, uv: [f64; 4], opacity: f64, flip_v: bool) {
        // SAFETY: same precondition as every other `gl.*` call in this crate.
        unsafe {
            gfx.gl.use_program(Some(self.program));
            gfx.gl.active_texture(glow::TEXTURE0);
            gfx.gl.bind_texture(glow::TEXTURE_2D, Some(tex.id));
            if let Some(loc) = &self.tex_loc {
                gfx.gl.uniform_1_i32(Some(loc), 0);
            }
            if let Some(loc) = &self.uv_rect_loc {
                gfx.gl.uniform_4_f32(
                    Some(loc),
                    uv[0] as f32,
                    uv[1] as f32,
                    uv[2] as f32,
                    uv[3] as f32,
                );
            }
            if let Some(loc) = &self.opacity_loc {
                gfx.gl.uniform_1_f32(Some(loc), opacity as f32);
            }
            if let Some(loc) = &self.flip_v_loc {
                gfx.gl.uniform_1_i32(Some(loc), flip_v as i32);
            }
            gfx.gl.bind_vertex_array(Some(gfx.empty_vao()));
            gfx.gl.draw_arrays(glow::TRIANGLES, 0, 3);
        }
    }
}

/// Binds `fbo`, restricts the viewport to `dst` (rounded to whole pixels — `fit_rect`
/// itself stays exact `f64` math so its unit tests can assert precise fractions; only the
/// actual GL draw rounds), enables premultiplied-alpha blending, draws, then disables
/// blending again (so a later caller — e.g. `effects::EffectProgram::draw`, which never
/// touches blend state itself — never inherits it by surprise). `flip_v` is threaded
/// straight through to [`BlitProgram::draw`] — see [`BLIT_FRAG_SRC`]'s doc comment for
/// which value each caller needs.
fn draw_rect(
    gfx: &Gfx,
    blit: &BlitProgram,
    tex: &Tex,
    uv: UvRect,
    opacity: f64,
    fbo: glow::Framebuffer,
    flip_v: bool,
) {
    // SAFETY: standard `gl.*` precondition.
    unsafe {
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
        gfx.gl.viewport(
            uv.dst[0].round() as i32,
            uv.dst[1].round() as i32,
            uv.dst[2].round().max(0.0) as i32,
            uv.dst[3].round().max(0.0) as i32,
        );
        gfx.gl.enable(glow::BLEND);
        gfx.gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);
    }
    blit.draw(gfx, tex, uv.uv, opacity, flip_v);
    // SAFETY: standard `gl.*` precondition.
    unsafe {
        gfx.gl.disable(glow::BLEND);
    }
}

/// Clears `fbo` (full `w`×`h`) to transparent black — the one colour every "nothing to
/// draw here" path in this module relies on: a missing texture (R19), the bars `fit`
/// leaves outside its centred content, and the two effect-input intermediates before
/// whatever `render_side` below actually draws into them.
fn clear_transparent(gfx: &Gfx, fbo: glow::Framebuffer, w: u32, h: u32) {
    // SAFETY: standard `gl.*` precondition.
    unsafe {
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
        gfx.gl.viewport(0, 0, w as i32, h as i32);
        gfx.gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gfx.gl.clear(glow::COLOR_BUFFER_BIT);
    }
}

/// Renders one effect side (`from` or `to`) into its `w`×`h` intermediate, transformed by
/// the layer's own `fit`/`viewport` — both sides of a transition share the layer's single
/// transform, since the transition happens at one screen position regardless of which
/// side is currently more visible. `tex` is `None` exactly when the caller's `textures`
/// lookup missed: per R19/R20, that side is simply left as the transparent clear this
/// function always starts with — observably identical to feeding
/// `effects::EffectProgram::draw` a transparent 1×1 texture for that input (anything that
/// only ever samples a texture can't tell "transparent everywhere, size 1×1" from
/// "transparent everywhere, size w×h" apart), without this module needing to keep a real
/// 1×1 texture object around just for that case.
///
/// `tex` is always a *raw* caller-supplied source texture here (never something this
/// module already wrote) — but this draws with `flip_v = false`, i.e. a pure pass-through
/// that preserves `tex`'s native orientation into the intermediate. This is the opposite
/// of what a direct-to-target `Source` draw needs, and is not a mistake: see
/// [`BLIT_FRAG_SRC`]'s doc comment ("Which draws need `flip_v = true`") for why pre-
/// flipping here would double-flip once `effects::EffectProgram::draw` samples this same
/// intermediate through its own, unconditional correction.
fn render_side(
    gfx: &Gfx,
    blit: &BlitProgram,
    tex: Option<&Tex>,
    fit: Fit,
    viewport: [f64; 4],
    (w, h): (u32, u32),
    fbo: glow::Framebuffer,
) {
    clear_transparent(gfx, fbo, w, h);
    let Some(tex) = tex else {
        return;
    };
    let uv = fit_rect((tex.w, tex.h), (w, h), fit, viewport);
    draw_rect(gfx, blit, tex, uv, 1.0, fbo, false);
}

/// The two input intermediates and one result intermediate an effect layer needs, all
/// sized `w`×`h` (the output's own size) — see [`Composer::ensure_intermediates`].
struct Intermediates {
    from: (Tex, Fbo),
    to: (Tex, Fbo),
    result: (Tex, Fbo),
}

/// Draws one output's main layer at a time. Owns the blit/transform shader program
/// ([`BlitProgram`]) and caches the output-sized intermediate textures/FBOs an effect
/// layer needs, keyed by `(width, height)` (R20) — a process drives a small, effectively
/// fixed set of output sizes, so this never evicts; the only growth is one entry per
/// distinct size ever seen.
pub struct Composer {
    blit: BlitProgram,
    intermediates: HashMap<(u32, u32), Intermediates>,
}

impl Composer {
    /// Compiles the blit program. The only fallible step — see [`BlitProgram::new`].
    pub fn new(gfx: &Gfx) -> Result<Composer, String> {
        Ok(Composer {
            blit: BlitProgram::new(gfx)?,
            intermediates: HashMap::new(),
        })
    }

    fn ensure_intermediates(&mut self, gfx: &Gfx, w: u32, h: u32) {
        self.intermediates.entry((w, h)).or_insert_with(|| {
            let from = gfx.tex(w, h);
            let from_fbo = gfx.fbo(&from);
            let to = gfx.tex(w, h);
            let to_fbo = gfx.fbo(&to);
            let result = gfx.tex(w, h);
            let result_fbo = gfx.fbo(&result);
            Intermediates {
                from: (from, from_fbo),
                to: (to, to_fbo),
                result: (result, result_fbo),
            }
        });
    }

    /// Draws `output_id`'s main layer (`lay:<connector>:main`) into `target` (cleared to
    /// transparent black first — R19's default, and where `fit`'s bars come from).
    ///
    /// - `content` empty, or pointing at a destroyed node: nothing more is drawn (stays
    ///   transparent) — there's no live node to read a transform or texture from.
    /// - `content` a `Source` node: looked up in `textures`; missing → stays transparent
    ///   (R19). Present → drawn once via [`fit_rect`] + [`draw_rect`] at the layer's
    ///   `opacity`.
    /// - `content` an `Effect` node: `from`/`to` are each rendered into an output-sized
    ///   intermediate under the layer's `fit`/`viewport` ([`render_side`]), the effect
    ///   itself is drawn between those two intermediates into a third ("result")
    ///   intermediate at `ratio = width/height`, and that result is finally blitted into
    ///   `target` at identity `uv` (`[0,0,1,1]`) and the layer's `opacity` — a third
    ///   intermediate is needed because `effects::EffectProgram::draw` has no opacity
    ///   input of its own, so opacity is applied in this separate pass afterwards instead.
    ///
    /// Which of the two `content` cases applies is decided by trying to read
    /// `"{content}.effect_id"`: `Ok` means `content` is an `Effect` (only `Effect` nodes
    /// have that property); `no_such_prop` means it's some other node kind (a `Source`,
    /// in every case this graph's schema allows for `Layer.content`); `no_such_node` means
    /// `content` is dangling (destroyed mid-transition, same situation
    /// `graph::Graph`'s own `cur:` alias already has to handle) — treated the same as an
    /// empty `content`.
    ///
    /// **Lifetime note (deviation from the brief's literal signature).** The brief's
    /// shorthand writes `textures: &dyn Fn(&str) -> Option<&Tex>`, but Rust's elision
    /// rule for a bare `Fn(&str) -> Option<&Tex>` trait bound ties the output reference's
    /// lifetime to the *input* `&str`'s — i.e. `for<'a> Fn(&'a str) -> Option<&'a Tex>`.
    /// No closure backed by a longer-lived registry (`move |id| registry.get(id)`, the
    /// obvious — and only sensible — implementation) can satisfy that: the trait object
    /// would have to hand back a reference valid for *any* caller-chosen `'a`, including
    /// ones longer than the registry itself lives, which only a `'static` registry could
    /// ever provide (confirmed directly: that exact closure fails to coerce with "one type
    /// is more general than the other" / "requires that `registry` is borrowed for
    /// `'static`"). The fix is an explicit lifetime parameter `'t`, tying the output to
    /// *the registry's* lifetime instead of the per-call input string's — which is what
    /// every real implementation (this module's tests' `HashMap`-backed closures, and the
    /// eventual Source registry) actually provides, and is still exactly
    /// `textures: &dyn Fn(&str) -> Option<&Tex>` at every call site (the `'t` is inferred,
    /// never written there).
    pub fn compose_output<'t>(
        &mut self,
        gfx: &Gfx,
        graph: &Graph,
        cat: &mut Catalogue,
        output_id: &str,
        textures: &dyn Fn(&str) -> Option<&'t Tex>,
        target: &Fbo,
    ) -> Result<(), String> {
        let (ow, oh) = output_dims(graph, output_id)?;
        clear_transparent(gfx, target.id, ow, oh);

        let connector = output_id.strip_prefix("out:").unwrap_or(output_id);
        let layer_id = format!("lay:{connector}:main");

        let content = get_str(graph, &layer_id, "content")?;
        if content.is_empty() {
            return Ok(());
        }

        let fit: Fit = get_str(graph, &layer_id, "fit")?
            .parse()
            .map_err(|e: crate::graph::props::ParseFitError| e.to_string())?;
        let viewport = get_list4(graph, &layer_id, "viewport")?;
        let opacity = get_f64(graph, &layer_id, "opacity")?;

        match graph.get(&PropPath(format!("{content}.effect_id"))) {
            Ok(PropValue::Str(effect_id)) => self.draw_effect(
                gfx,
                graph,
                cat,
                &content,
                &effect_id,
                fit,
                viewport,
                opacity,
                (ow, oh),
                target,
                textures,
            ),
            Err(e) if e.code == "no_such_node" => Ok(()), // dangling content: stays transparent
            Err(e) if e.code == "no_such_prop" => {
                // A Source (or at least: something with no `effect_id` — the schema gives
                // `Layer.content` no other legal kind to point at). `tex` is a raw
                // caller-supplied texture, drawn straight into the final target, so this
                // needs the orientation correction (`flip_v = true` — see
                // `BLIT_FRAG_SRC`'s doc comment).
                if let Some(tex) = textures(&content) {
                    let uv = fit_rect((tex.w, tex.h), (ow, oh), fit, viewport);
                    draw_rect(gfx, &self.blit, tex, uv, opacity, target.id, true);
                }
                Ok(())
            }
            Err(e) => Err(format!("compose_output: {content}.effect_id: {e}")),
            Ok(_) => unreachable!("effect_id's schema type is always PropValue::Str"),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_effect<'t>(
        &mut self,
        gfx: &Gfx,
        graph: &Graph,
        cat: &mut Catalogue,
        fx_id: &str,
        effect_id: &str,
        fit: Fit,
        viewport: [f64; 4],
        opacity: f64,
        (ow, oh): (u32, u32),
        target: &Fbo,
        textures: &dyn Fn(&str) -> Option<&'t Tex>,
    ) -> Result<(), String> {
        let from_id = get_str(graph, fx_id, "from")?;
        let to_id = get_str(graph, fx_id, "to")?;
        let progress = get_f64(graph, fx_id, "progress")?;
        let params = get_map(graph, fx_id, "params")?;

        self.ensure_intermediates(gfx, ow, oh);
        let (from_fbo, to_fbo, result_fbo) = {
            let inter = self
                .intermediates
                .get(&(ow, oh))
                .expect("ensure_intermediates just inserted this key");
            (inter.from.1.id, inter.to.1.id, inter.result.1.id)
        };

        render_side(
            gfx,
            &self.blit,
            textures(&from_id),
            fit,
            viewport,
            (ow, oh),
            from_fbo,
        );
        render_side(
            gfx,
            &self.blit,
            textures(&to_id),
            fit,
            viewport,
            (ow, oh),
            to_fbo,
        );

        let ratio = ow as f64 / oh as f64;
        {
            let inter = self
                .intermediates
                .get(&(ow, oh))
                .expect("ensure_intermediates just inserted this key");
            // SAFETY: standard `gl.*` precondition.
            unsafe {
                gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(result_fbo));
                gfx.gl.viewport(0, 0, ow as i32, oh as i32);
                gfx.gl.disable(glow::BLEND);
            }
            let program = cat
                .program(gfx, effect_id)
                .map_err(|e| format!("compose_output: effect `{effect_id}`: {e}"))?;
            program.draw(gfx, &inter.from.0, &inter.to.0, progress, ratio, &params);
        }

        // `Tex`'s fields are all `Copy` (`glow::Texture`, `u32`, `u32`) — copying them out
        // into a fresh `Tex` (rather than holding `&inter.result.0` across the call
        // below) sidesteps borrowing `self.intermediates` across `&self.blit`'s use,
        // which the compiler can't see are disjoint through a `self.intermediates.get`
        // that's already gone out of scope.
        let result_tex = {
            let inter = self
                .intermediates
                .get(&(ow, oh))
                .expect("ensure_intermediates just inserted this key");
            // Identity: the result intermediate already *is* the final-output
            // composition, pixel for pixel — no further fit/viewport transform.
            Tex {
                id: inter.result.0.id,
                w: inter.result.0.w,
                h: inter.result.0.h,
            }
        };
        draw_rect(
            gfx,
            &self.blit,
            &result_tex,
            UvRect {
                uv: [0.0, 0.0, 1.0, 1.0],
                dst: [0.0, 0.0, ow as f64, oh as f64],
            },
            opacity,
            target.id,
            // `result_tex` is the effect's own output: `EffectProgram::draw` already
            // applied the one necessary orientation correction when *it* sampled the
            // (deliberately unflipped — see `render_side`) `from`/`to` intermediates.
            // This is a plain, same-orientation copy into the target; no further flip.
            false,
        );
        Ok(())
    }
}

fn output_dims(graph: &Graph, output_id: &str) -> Result<(u32, u32), String> {
    let w = get_i64(graph, output_id, "width")?;
    let h = get_i64(graph, output_id, "height")?;
    if w <= 0 || h <= 0 {
        return Err(format!(
            "compose_output: {output_id}: width/height must be > 0 (got {w}x{h})"
        ));
    }
    Ok((w as u32, h as u32))
}

fn get_str(graph: &Graph, id: &str, prop: &str) -> Result<String, String> {
    match graph.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::Str(s)) => Ok(s),
        Ok(_) => Err(format!("compose_output: {id}.{prop}: expected a string")),
        Err(e) => Err(format!("compose_output: {e}")),
    }
}

fn get_f64(graph: &Graph, id: &str, prop: &str) -> Result<f64, String> {
    match graph.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::F64(f)) => Ok(f),
        Ok(_) => Err(format!("compose_output: {id}.{prop}: expected a number")),
        Err(e) => Err(format!("compose_output: {e}")),
    }
}

fn get_i64(graph: &Graph, id: &str, prop: &str) -> Result<i64, String> {
    match graph.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::I64(n)) => Ok(n),
        Ok(_) => Err(format!("compose_output: {id}.{prop}: expected an integer")),
        Err(e) => Err(format!("compose_output: {e}")),
    }
}

fn get_list4(graph: &Graph, id: &str, prop: &str) -> Result<[f64; 4], String> {
    match graph.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::List(v)) if v.len() == 4 => Ok([v[0], v[1], v[2], v[3]]),
        Ok(_) => Err(format!(
            "compose_output: {id}.{prop}: expected a 4-element list"
        )),
        Err(e) => Err(format!("compose_output: {e}")),
    }
}

fn get_map(graph: &Graph, id: &str, prop: &str) -> Result<Map<String, Value>, String> {
    match graph.get(&PropPath(format!("{id}.{prop}"))) {
        Ok(PropValue::Map(m)) => Ok(m),
        Ok(_) => Err(format!("compose_output: {id}.{prop}: expected an object")),
        Err(e) => Err(format!("compose_output: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: [f64; 4] = [0.0, 0.0, 1.0, 1.0];

    fn approx(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    /// Brief's `fit_letterbox`: 1920×800 into 1920×1080 under `fit` must letterbox with
    /// 140px bars top and bottom, full width, no horizontal crop.
    #[test]
    fn fit_rect_letterbox_bars() {
        let r = fit_rect((1920, 800), (1920, 1080), Fit::Fit, FULL);
        assert_eq!(
            r.uv,
            [0.0, 0.0, 1.0, 1.0],
            "fit: no crop, full source visible"
        );
        assert!(approx(r.dst[0], 0.0, 1e-9), "dst.x = {}", r.dst[0]);
        assert!(
            approx(r.dst[1], 140.0, 1e-9),
            "dst.y (bottom bar) = {}",
            r.dst[1]
        );
        assert!(approx(r.dst[2], 1920.0, 1e-9), "dst.w = {}", r.dst[2]);
        assert!(approx(r.dst[3], 800.0, 1e-9), "dst.h = {}", r.dst[3]);
    }

    /// Brief's `fill_crops`: 1920×800, `fill` into 1920×1080 → the visible uv.x span is
    /// `1080/1458 ≈ 0.7407` (cover-scale 1.35, horizontal-only crop, full output covered).
    #[test]
    fn fit_rect_fill_crops_uv_span() {
        let r = fit_rect((1920, 800), (1920, 1080), Fit::Fill, FULL);
        assert!(
            approx(r.uv[2], 0.740_740, 1e-3),
            "uv.x span = {}, want ≈0.7407",
            r.uv[2]
        );
        assert!(
            approx(r.uv[3], 1.0, 1e-9),
            "uv.y span (no vertical crop) = {}",
            r.uv[3]
        );
        assert_eq!(
            r.dst,
            [0.0, 0.0, 1920.0, 1080.0],
            "fill covers the whole output"
        );
    }

    /// `stretch` ignores aspect entirely: always fills the output exactly, on both axes,
    /// with the whole source visible (no crop, no pad) regardless of aspect mismatch.
    #[test]
    fn fit_rect_stretch_ignores_aspect() {
        let r = fit_rect((100, 50), (200, 300), Fit::Stretch, FULL);
        assert_eq!(r.uv, [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(r.dst, [0.0, 0.0, 200.0, 300.0]);
    }

    /// `crop` is 1:1 pixels, centred, deciding crop-vs-pad independently per axis: a
    /// 2000×1000 source into 1920×1080 crops horizontally (source wider than output) and
    /// pads vertically (source shorter than output).
    #[test]
    fn fit_rect_crop_decides_per_axis() {
        let r = fit_rect((2000, 1000), (1920, 1080), Fit::Crop, FULL);
        // Horizontal: 2000 > 1920 -> crop, visible frac = 1920/2000 = 0.96, centred.
        assert!(approx(r.uv[0], 0.02, 1e-9), "uv.x = {}", r.uv[0]);
        assert!(approx(r.uv[2], 0.96, 1e-9), "uv.w = {}", r.uv[2]);
        assert!(approx(r.dst[0], 0.0, 1e-9) && approx(r.dst[2], 1920.0, 1e-9));
        // Vertical: 1000 < 1080 -> pad, fully visible, centred with a 40px bar each side.
        assert!(approx(r.uv[1], 0.0, 1e-9) && approx(r.uv[3], 1.0, 1e-9));
        assert!(approx(r.dst[1], 40.0, 1e-9), "dst.y = {}", r.dst[1]);
        assert!(approx(r.dst[3], 1000.0, 1e-9), "dst.h = {}", r.dst[3]);
    }

    /// Brief's span recipe: `viewport` selects a sub-rectangle of the source *before*
    /// fitting. A 200×100 source spanned across two outputs (left/right halves) must
    /// yield `uv`s of exactly `[0,0,0.5,1]` / `[0.5,0,0.5,1]` when each output is the same
    /// size as its half (`fill`, scale 1, no further crop within the half).
    #[test]
    fn fit_rect_viewport_spans_select_half() {
        let left = fit_rect((200, 100), (100, 100), Fit::Fill, [0.0, 0.0, 0.5, 1.0]);
        assert_eq!(left.uv, [0.0, 0.0, 0.5, 1.0]);
        assert_eq!(left.dst, [0.0, 0.0, 100.0, 100.0]);

        let right = fit_rect((200, 100), (100, 100), Fit::Fill, [0.5, 0.0, 0.5, 1.0]);
        assert_eq!(right.uv, [0.5, 0.0, 0.5, 1.0]);
        assert_eq!(right.dst, [0.0, 0.0, 100.0, 100.0]);
    }
}
