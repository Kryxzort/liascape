# Composition and effects

Covers `src/player/src/gfx/compose.rs` (the per-output frame builder) and `src/player/src/gfx/effects.rs` (the
transition-effect catalogue). Rules: `.claude/rules/player/core.md` § Effects, § Composition.

## Effect catalogue

`Catalogue` compiles the repo's shared `transitions/` assets (the gl-transitions GLSL also used by the UI's WebGL
previews) into desktop GL 3.3 core programs. The assets are never edited for the player: `rewrite_header` turns
`#version 300 es` into `#version 330 core` in `wrap.vert` and `wrap.frag.template` and drops the template's
precision line; each `glsl/<id>.glsl` body is spliced in at `//<<BODY>>` lazily in `Catalogue::program`. A body
that some driver can't compile gets a compatibility prelude at that seam, never an asset edit. On NVIDIA the GLSL ES
precision qualifiers some bodies use unguarded (`TVStatic`) are accepted as no-op keywords, so every effect
compiles with no prelude.

Directory resolution (`Catalogue::resolve_dir`): `LIASCAPE_TRANSITIONS_DIR`, then
`~/.local/lib/liascape/transitions`, then a `transitions/` found walking up from the exe or from
`CARGO_MANIFEST_DIR`; a candidate counts only with a `manifest.json`. Nothing resolves inside the
`nix build .#liascape-player` sandbox (it builds `src/player` alone): tests skip, the runtime serves cuts
(`Catalogue::empty`).

Uniforms are typed once at load from the manifest (`bool`, `int`, `ivec2`, `float`, `vec2`–`vec4`; anything else
fails the load). A caller's param may be the manifest's array shape or a bare number/bool; a missing name falls
back to the manifest default (always an array, even for a scalar); names the effect doesn't declare are never
read; a uniform the driver optimised away is skipped. `fromTex`/`toTex` are texture units 0/1.

## Composer

`Composer::compose_output` draws one output's main layer (`lay:<c>:main`) into a caller-owned FBO: a plain source
with `fit`/`viewport`/`opacity`, or an `Effect` node blending two sources. It keeps no frame memory; only the
blit program and per-size intermediates (two inputs + one result per output size, created lazily, never evicted —
a process drives a small fixed set of sizes).

**Fit.** All four modes reduce to one per-axis rule: the scaled source either overflows the axis (crop, centred)
or underflows it (pad, centred, transparent bars).

| `fit` | scale | mpv equivalent |
|---|---|---|
| `fill` | one shared scale, the larger per-axis ratio | `panscan=1.0` |
| `fit` | one shared scale, the smaller ratio | `panscan=0.0` |
| `stretch` | each axis its exact ratio | — |
| `crop` | 1.0, each axis decides crop or pad | — |

`viewport` selects a normalised sub-rectangle of the source before `fit` runs; spanning one source over two
outputs is two layers with the same content and complementary viewports (`[0,0,0.5,1]`, `[0.5,0,0.5,1]`).

**Orientation.** Source textures hold the image's top row at texture row 0 (`t = 0`, GL's bottom). The blit
shader's `flip_v` corrects that exactly once per path: `true` for a plain source → target; `false` for an
effect's input passes, because `wrap.frag.template`'s `getFromColor`/`getToColor` already flip when sampling;
`false` for the effect result → target, which is already upright. Placement (`fit_rect`, `dst`) is GL
bottom-left and never flipped. A Y-uniform effect test can't see a double flip; the guard compares a transition
at progress 0 and 1 with the plain source it starts and ends on, row by row.

**Effects.** `draw_effect` renders `from` and `to` into their own output-sized intermediates under the layer's
shared `fit`/`viewport` (a transition happens at one screen position), runs `EffectProgram::draw` into the result
intermediate with blending off, then blits the result to the target with the layer's opacity — the effect shader
has no opacity input, hence the third intermediate. A missing side is its intermediate cleared to transparent.
Which kind `content` names is decided by reading `<content>.effect_id`: present → effect, `no_such_prop` →
source, `no_such_node` (destroyed mid-transition) → nothing drawn. An uncompilable effect draws as a cut at
progress 0.5 (`from` before, `to` from it), compiled and logged once.

**Premultiplied alpha.** Every draw outputs `rgb·opacity, a·opacity` blended with `ONE, ONE_MINUS_SRC_ALPHA` onto
transparent black, so the result already is the picture over black; the present path forces alpha to 1.

**Seams.** `Composer::last_missing` names what the last compose drew transparent although a visible main layer
(`opacity > 0`) pointed at it: a source or effect side with no texture, or a dangling `content`. An empty layer or
opacity 0 is never a seam. By the recipes nothing shown ever lacks a texture (B is shown only once `Ready`, a
crashed scene holds its frame), so any count is a hole a viewer saw; only a raw `set lay:*.content` of a source
that isn't ready makes one on purpose. The runtime counts them per output in the `frames` probe
([wayland.md](wayland.md)).
