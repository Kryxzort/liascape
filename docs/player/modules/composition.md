<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Composition

`src/gfx/compose.rs` (spec §4.2 "Layer"/"Effect", §4.3 span/mirror recipes): the per-output
frame builder — `Composer::compose_output` draws one output's main layer (`lay:<connector>
:main`) into a caller-owned target `Fbo`, applying `fit`/`viewport`/`opacity`, blending a
two-source `Effect` when `content` points at one. `fit_rect` (a pure free function) and
`UvRect` are unit-tested with no GPU at all; `Composer` is the stateful half (the blit
shader program, plus cached per-size intermediates for effects).

**R19 — no frame memory in this module.** A missing texture (the caller's `textures`
closure returning `None`) always draws as fully transparent — for a plain `Source` layer,
and for either side of an `Effect`. Keeping the last good frame when a source stalls is
the *Source*'s job (Task 10), never this module's: `compose_output` is purely `(graph
state, live textures) -> one composited frame`, called fresh every time.

**R20 — the exact API.** The brief's free `compose_output` function is a method on
`Composer`, which owns the small blit/transform shader (`BlitProgram`, compiled once in
`Composer::new`) and caches the two input intermediates + one result intermediate an
`Effect` layer needs, keyed by `(width, height)` in a `HashMap` — a process drives a
small, effectively-fixed set of output sizes, so entries are created lazily and never
evicted. `fit_rect(src: (u32,u32), dst: (u32,u32), fit: Fit, viewport: [f64;4]) -> UvRect`
stays a pure free function exactly as specified.

**Fit semantics** — all four modes reduce to one per-axis rule (`axis`): given the
viewport-selected *effective* source size on that axis and that axis's scale factor,
either the scaled source overflows the output axis (crop: output axis filled completely,
visible source fraction shrinks and centres) or underflows it (pad: whole source visible,
centred, transparent bars on both sides).

| `fit` | meaning | scale factor(s) fed to `axis` | mpv equivalent |
|---|---|---|---|
| `fill` | covers the output, crops the excess | one shared scale, `max` of the two per-axis ratios | `panscan=1.0` |
| `fit` | contains, letterbox/pillarbox bars | one shared scale, `min` of the two per-axis ratios | `panscan=0.0` |
| `stretch` | ignores aspect, always fills exactly | independent per-axis exact-fit ratio (both axes land in the overflow/exact branch, frac `1.0`) | — |
| `crop` | source pixels 1:1, centred | fixed at `1.0`; each axis decides crop-vs-pad independently | — |

**Viewport / spanning.** `Layer.viewport` (already range-checked by `graph::props` to
`x,y ∈ [0,1]`, `w,h ∈ (0,1]`) selects a normalised sub-rectangle of the *source* before
`fit` ever runs — `fit_rect`'s "effective source size" is `(src_w * viewport.w, src_h *
viewport.h)`, and every returned `uv` is that sub-rectangle's own coordinates re-expressed
in the full texture's `[0,1]` space (`viewport.xy + local * viewport.wh`). Spanning one
source across two outputs is exactly two layers with the same `content`/`fit` and
complementary viewports (`DP-1`: `[0,0,0.5,1]`, `DP-2`: `[0.5,0,0.5,1]`).

**Coordinate conventions — GL bottom-left origin, matching `tests/common::read_rgba`.**
Both halves of `UvRect` (`uv` into the source, `dst` into the output, pixels) use `(0,0)`
as the bottom-left corner. **Placement** (`fit_rect`/`axis`'s math, and `dst`'s effect on
`gl.viewport`) is never flipped — bars/crop/centring land at the same screen position
regardless of which texture is sampled.

**Sampling is a separate concern, and it *is* flipped — but exactly once per source,
on exactly one of this module's three draw sites, never more.** A raw, caller-supplied
source texture is assumed uploaded in standard top-down/PNG row order (buffer row 0 =
image top), which GL's own texel addressing places at `t = 0` — the bottom-left-origin
"bottom." Sampled uncorrected anywhere, a plain `Source` layer would render upside down.
`compose.rs`'s own blit shader (`BLIT_VERT_SRC`/`BLIT_FRAG_SRC`, a from-scratch
fullscreen-triangle shader, not a reuse of `wrap.vert`) carries a `flip_v` uniform that is
`true` for exactly **one** call site and `false` everywhere else:

- **`Composer::compose_output`'s plain-`Source` branch (raw texture → target directly):
  `flip_v = true`.** Nothing else downstream corrects orientation for this draw, so it
  must.
- **`render_side`'s `from`/`to` passes (raw texture → an effect's intermediate):
  `flip_v = false`.** The intermediate is consumed next by
  `effects::EffectProgram::draw`, which *unconditionally* applies
  `transitions/wrap.frag.template`'s own `getFromColor`/`getToColor` flip (untouched —
  this crate never edits `transitions/`) when it samples `fromTex`/`toTex`. Pre-flipping
  here too would compose two flips into the identity (flip∘flip = no correction at all),
  silently reintroducing the upside-down bug for every transition while leaving plain
  `Source` layers correct.
- **The effect's "result" intermediate → target, end of `draw_effect`: `flip_v =
  false`.** `EffectProgram::draw` already applied the one necessary correction (the
  previous point) when it wrote this texture; it's already in finished/screen
  orientation, so a further flip here would un-correct it.

**This exact double-flip shipped once** in this module's first attempt at fixing the
orientation bug (`flip_v = true` on `render_side` too, by the same, wrong "every raw
source needs correcting" reasoning) — caught by review, not by any test running at the
time, because the only Y-asymmetric test then (`y_axis_orientation_matches_image_top`)
only exercises a plain `Source` layer; a Y-uniform-coloured effect test
(`effect_fade_midpoint_through_graph`) can't distinguish a flip from no flip at all.
The actual regression test for this (`tests/compose.rs::
effect_progress_endpoints_match_plain_source`) asserts the property that matters: a
transition at `progress = 0`/`1` must be pixel-identical (every row, Y-asymmetric
sources) to the plain `Source` layer it starts/ends on — for both a full `stretch` and a
`viewport`-restricted case.

**Premultiplied-alpha opacity.** Every draw (`draw_rect`) goes through the blit shader,
which outputs premultiplied colour (`rgb * opacity`, `a * opacity`) and blends with
`glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA)` onto a target already cleared to transparent
black. A fully-opaque red source at `opacity = 0.5` writes `(0.5, 0, 0, 0.5)` — read back
as `rgb ≈ (127, 0, 0)` directly, no separate "composite over black" step needed, because
premultiplied colour already *is* the correct final RGB over a black backdrop. A real
on-screen present (a later task) composites this premultiplied buffer over whatever's
actually behind the output; this module only has to get the premultiplied maths right
once, consistently, for every draw it issues (plain source, each effect input, and the
effect's own blended result).

**Effect compositing.** For `content` pointing at an `Effect` node (`fx*`), `draw_effect`:
renders `from` and `to` each into their own output-sized intermediate under the layer's
*shared* `fit`/`viewport` (`render_side` — both sides of a transition share one on-screen
transform, since the transition happens at one screen position regardless of which side
currently dominates); binds a third ("result") intermediate and calls
`EffectProgram::draw(gfx, &from_tex, &to_tex, progress, ratio = width/height, &params)`
with blending explicitly disabled (a straight overwrite into a just-cleared, fully
transparent target); then blits that result into the real `target` at identity `uv`
(`[0,0,1,1]`, since the result intermediate already *is* the final-output composition
pixel-for-pixel) and the layer's `opacity`. A third intermediate is needed specifically
because `EffectProgram::draw` has no opacity input of its own — it always draws fully
opaque (or whatever alpha the effect shader itself produces) — so opacity has to be
applied in this separate pass afterwards instead of folded into the effect draw.

**A missing effect input is a transparent intermediate, not a literal 1×1 texture.**
R19/R20 describe a missing effect-side input as "a transparent 1×1 texture" — implemented
here as *clearing that side's output-sized intermediate to transparent and simply not
drawing into it*. These are observably identical to anything that only ever samples the
texture (every sample reads `(0,0,0,0)` either way, regardless of the texture's actual
resolution), and this way avoids keeping a real 1×1 `Tex` object around just for the
degenerate case.

**Which `content` kind applies** is decided by trying `graph.get("{content}.effect_id")`:
`Ok` means `content` is an `Effect` (only `Effect` nodes have that property); `Err`
`no_such_prop` means some other node kind — in every case the schema allows for
`Layer.content`, that's a `Source`; `Err` `no_such_node` means `content` is dangling
(destroyed mid-transition — the same situation `graph::Graph`'s own `cur:` alias already
handles), treated the same as an empty `content`: nothing more is drawn, target stays
transparent.

**Lifetime deviation from the brief's literal `textures` signature.** The brief writes
`textures: &dyn Fn(&str) -> Option<&Tex>`, but Rust's elision rule for a bare
`Fn(&str) -> Option<&Tex>` trait bound ties the output reference's lifetime to the
*input* `&str`'s (`for<'a> Fn(&'a str) -> Option<&'a Tex>`) — no closure backed by a
longer-lived registry (`move |id| registry.get(id)`, the only sensible implementation)
can satisfy that, since the trait object would have to hand back a reference valid for
*any* caller-chosen `'a`, up to and including `'static`. Confirmed directly: that exact
closure fails to coerce with "one type is more general than the other" / "requires that
`registry` is borrowed for `'static`". `Composer::compose_output`/`draw_effect` instead
take an explicit lifetime parameter (`textures: &dyn Fn(&str) -> Option<&'t Tex>`), tying
the output to *the registry's* lifetime — what every real implementation actually
provides — while every call site is still spelled exactly `&dyn Fn(&str) -> Option<&Tex>`
(the `'t` is inferred, never written out).

**Round-pixels-only-at-the-GL-call rule.** `fit_rect`/`axis` stay exact `f64` throughout
(so their own unit tests can assert precise fractions, e.g. the `fill_crops` 0.7407 uv
span) — only `draw_rect`/`clear_transparent`/`render_side`, right where they call
`gl.viewport`, round `UvRect::dst` to whole pixels.
