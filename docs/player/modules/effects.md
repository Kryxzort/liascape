<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Effects

`src/gfx/effects.rs` (spec §5.1 "Graphics": "the gl-transitions GLSL catalogue
(`transitions/`) is reused and adapted to the core-profile wrapper"): the effect
catalogue — `Catalogue` (`resolve_dir`/`load`/`ids`/`program`) and `EffectProgram`
(`draw`) — that compiles the repo's shared `transitions/` assets (122 effects, also used
by the Electron UI's WebGL previews) into desktop-GL 3.3 core programs.

**Never edit anything under `transitions/` for this crate.** Those assets are shared with
the UI; this module's whole job is adapting them at load time (header rewrite, body
splice), never changing them in place. If a future gl-transitions body genuinely fails to
compile under desktop GL 3.3 core, the fix belongs in this module's assembly step (e.g. a
small compatibility prelude), never in `transitions/` itself.

**Directory resolution** (`Catalogue::resolve_dir`), in order:

1. `LIASCAPE_TRANSITIONS_DIR` env var.
2. `~/.local/lib/liascape/transitions` (the default install, `install.sh`).
3. The repo's own `transitions/`, found by walking up from the current exe's path and,
   failing that, from `CARGO_MANIFEST_DIR` (a build-time constant — this is what makes
   `cargo test` find it even before any exe-relative candidate would resolve).

Each candidate is only accepted if it actually contains a `manifest.json`. Returns `None`
if nothing resolves — true inside `nix build .#liascape-player`'s sandboxed check phase, where
`src/player` is built without its sibling `transitions/` directory present (the flake's
`liascape-player` derivation sets `src = ./src/player`, nothing wider). Every test in
`tests/effects_all.rs` treats `None` the same way `tests/common::headless_gl` treats no
EGL device: print `"SKIP: ..."` and return, never fail the build over it — unless
`LIASCAPE_REQUIRE_GPU=1` (§ GFX / EGL: `tests/common::catalogue_dir` then fails the test).

**A failing effect is cached (final review M3).** `Catalogue::program` caches a load/compile
failure (`Catalogue::failed(id)`), logs `effects.compile_failed {id, error}` once and returns the
error at once afterwards; `Composer` then draws the effect as a **cut at the midpoint** (`from`
below progress 0.5, `to` from it) — never the transparent/black frame it used to present while
re-reading and re-compiling the body every frame. `tests/compose.rs::
uncompilable_effect_draws_a_cut_not_black` (a catalogue copy with a broken body).

**Header rewrite + fail-loud rule** (`rewrite_header`, applied to `wrap.vert` and
`wrap.frag.template` in `Catalogue::load`): replace the exact first line `#version 300
es` with `#version 330 core`, then delete a `precision highp float;` line if present.
The version-line check is mandatory for **both** files — its absence means the shared
asset changed shape under this code, and `rewrite_header` returns `Err` naming the file
rather than silently handing back malformed GLSL. The precision-line deletion is
conditional per file: `wrap.frag.template` is required to have one (fails loud if it ever
loses it); `wrap.vert` genuinely never has one (it only emits `gl_Position`/`vUv`), so its
absence there is not an error. Per-effect bodies (`glsl/<id>.glsl`) are spliced into the
rewritten `wrap.frag.template` at its `//<<BODY>>` placeholder, lazily, in
`Catalogue::program` — `Catalogue::load` itself never reads `glsl/`.

**Measured: no compatibility shim needed on this machine (NVIDIA 595.84).** One body
(`glsl/TVStatic.glsl`) declares GLSL ES precision qualifiers (`highp float noise(...)` and
several `highp float` locals) unconditionally rather than guarding them behind `#ifdef
GL_ES` the way most of the catalogue does — on paper a candidate to fail once the version
line is rewritten to desktop GLSL 330 core, which doesn't define those qualifiers by
default. Verified directly (temporarily forcing the qualifiers away with a `#define
highp`/etc. prelude and re-running `all_compile`, then without it): this driver accepts
`lowp`/`mediump`/`highp` as reserved, no-op keywords unconditionally, so all 122 effects
compile with no prelude at all. If a different driver ever needs one, the seam is
`Catalogue::program`'s shader assembly, not `transitions/`.

**Uniform type mapping** (`UniformKind`, resolved once per uniform at `Catalogue::load`
time from the manifest's `type` string — an unrecognised type fails loudly immediately,
not later at draw time): `bool` → `glUniform1i(0/1)`, `int` → `1i`, `ivec2` → `2i`,
`float`/`vec2`/`vec3`/`vec4` → the matching `Nf`. `fromTex`/`toTex` are always bound at
texture units 0/1 respectively, `progress`/`ratio` always set as floats. A param value
from the caller's `serde_json::Map` may be the manifest-shaped array (`default` is always
an array, even for a scalar — e.g. a `bool` default is `[0.0]`/`[1.0]`, never a literal
JSON `true`/`false`) or a bare number/bool, treated as a 1-element array either way; a
name missing from the map (or present but empty) falls back to that uniform's manifest
default. A param name the effect doesn't declare is never looked at (`EffectProgram::draw`
only iterates its own declared uniforms, never the caller's map keys) — "unknown param
names are ignored" falls out of that, with no special-case code. A uniform location the
driver optimised away (`glGetUniformLocation` returned `None` at link time) is skipped
silently, never an error.

**Draw-into-bound-FBO contract** (`EffectProgram::draw`): draws into whatever
framebuffer/viewport is already bound when called — it never binds or queries a
framebuffer, never touches the viewport, and restores no GL state afterwards. It binds
the crate-wide empty VAO (`Gfx::empty_vao`) and issues one `glDrawArrays(TRIANGLES, 0,
3)` — the fullscreen-triangle vertex shader needs no attributes, only `gl_VertexID`. What
it leaves bound for the next caller to either rely on or overwrite: this program
(`glUseProgram`), `from`/`to` at texture units 0/1 (unit 1 left active), and the empty
VAO. The caller (Task 9's layer compositor) owns the target FBO/viewport entirely.
