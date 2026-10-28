//! The gl-transitions effect catalogue (spec §5.1 "Graphics": "the gl-transitions GLSL
//! catalogue (`transitions/`) is reused and adapted to the core-profile wrapper").
//!
//! [`Catalogue`] loads the repo's shared `transitions/` directory — the same assets the
//! Electron UI's WebGL previews use — and lazily compiles each effect's
//! `wrap.vert`/`wrap.frag.template`/`glsl/<id>.glsl` trio into a desktop-GL 3.3 core
//! [`EffectProgram`]. **Never edit anything under `transitions/` for this crate**: those
//! assets are shared with the UI, and this module's whole job is adapting them at load
//! time, not changing them in place.
//!
//! See `.claude/rules/player-core.md`'s "Effects" section for the directory-resolution
//! order, the header-rewrite/fail-loud rule, the uniform type mapping, and the
//! draw-into-whatever-FBO-is-bound contract.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use glow::HasContext;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::egl::Gfx;
use super::gl::Tex;

/// `transitions/wrap.vert` and `wrap.frag.template` both start life as GLSL ES 3.00
/// (`#version 300 es`, for the Electron UI's WebGL2 previews). This module rewrites that
/// one line to `#version 330 core` for every shader it assembles — see
/// [`rewrite_header`].
const ES_VERSION_LINE: &str = "#version 300 es";
const CORE_VERSION_LINE: &str = "#version 330 core";
const PRECISION_LINE: &str = "precision highp float;";

/// Marks where a per-effect body (`glsl/<id>.glsl`) is spliced into the rewritten
/// `wrap.frag.template`.
const BODY_PLACEHOLDER: &str = "//<<BODY>>";

// No compatibility prelude is needed before splicing a body in. One body
// (`glsl/TVStatic.glsl`) declares GLSL ES precision qualifiers (`highp float noise(...)`
// and several `highp float` locals) unconditionally rather than guarding them behind
// `#ifdef GL_ES` the way most of the catalogue does — on paper a candidate to fail under
// desktop GLSL 330 core, which doesn't define those qualifiers by default. Measured
// directly on this machine (NVIDIA 595.84): it compiles as-is — the driver accepts
// `lowp`/`mediump`/`highp` as reserved, no-op keywords even outside GLSL ES and outside
// `#ifdef GL_ES` guards (verified by temporarily forcing a `#define highp` / etc. prelude
// off and re-running `all_compile`: still 122/122). So there is nothing to work around
// here; if a future driver/body combination needs one, the brief's intended seam is right
// here, in `Catalogue::program`'s assembly step — never in `transitions/` itself.

/// One `uniforms[]` entry from `manifest.json`, resolved to a concrete GL uniform shape.
#[derive(Debug, Clone)]
struct UniformSpec {
    name: String,
    kind: UniformKind,
    /// Manifest default, always present as an array even for scalar types (brief: "the
    /// manifest `uniforms[].default`" — "default is always an array").
    default: Vec<f64>,
}

/// The uniform types the brief enumerates: `bool | float | int | ivec2 | vec2 | vec3 |
/// vec4`. Resolved once at [`Catalogue::load`] time from the manifest's `type` string so
/// a typo'd/unrecognised type fails loudly at load rather than silently skipping a
/// uniform later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UniformKind {
    Bool,
    Float,
    Int,
    IVec2,
    Vec2,
    Vec3,
    Vec4,
}

impl UniformKind {
    fn parse(ty: &str) -> Result<Self, String> {
        match ty {
            "bool" => Ok(Self::Bool),
            "float" => Ok(Self::Float),
            "int" => Ok(Self::Int),
            "ivec2" => Ok(Self::IVec2),
            "vec2" => Ok(Self::Vec2),
            "vec3" => Ok(Self::Vec3),
            "vec4" => Ok(Self::Vec4),
            other => Err(format!(
                "unknown uniform type `{other}` (expected bool|float|int|ivec2|vec2|vec3|vec4)"
            )),
        }
    }
}

/// Raw `manifest.json` shapes, deserialized as-is before [`Catalogue::load`] resolves
/// each uniform's `type` string into a [`UniformKind`]. Fields this module doesn't need
/// (`name`, `category`, `defaultOn`, `author`, `license`) are simply left out — serde
/// ignores JSON fields with no matching struct field.
#[derive(Debug, Deserialize)]
struct RawUniform {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    default: Vec<f64>,
}

#[derive(Debug, Deserialize)]
struct RawManifestEntry {
    id: String,
    #[serde(default)]
    uniforms: Vec<RawUniform>,
}

/// One effect's id plus its resolved uniform specs — [`Catalogue::load`]'s parsed form of
/// a `manifest.json` entry.
#[derive(Debug, Clone)]
struct EffectSpec {
    id: String,
    uniforms: Vec<UniformSpec>,
}

/// The gl-transitions effect catalogue: every id from `transitions/manifest.json`, plus
/// the two shared wrapper shaders (already header-rewritten for desktop GL — see
/// [`rewrite_header`]) that every effect's `glsl/<id>.glsl` body gets spliced into.
///
/// Compilation is lazy and cached per id ([`Catalogue::program`]) — loading the
/// catalogue only reads and parses `manifest.json` plus the two wrapper files, not all
/// 122 bodies.
pub struct Catalogue {
    dir: PathBuf,
    effects: Vec<EffectSpec>,
    vert_src: String,
    /// The rewritten `wrap.frag.template` source, still containing [`BODY_PLACEHOLDER`]
    /// — substituted per effect in [`Catalogue::program`].
    frag_template: String,
    programs: HashMap<String, EffectProgram>,
    /// M3 (final review): effects that failed to load/compile on this driver — the error,
    /// cached so a failing effect is read and compiled once (logged once,
    /// `effects.compile_failed`), not on every frame of every output.
    failed: HashMap<String, String>,
}

impl Catalogue {
    /// Resolve the `transitions/` directory to load, in order (brief's exact order):
    ///
    /// 1. `LIASCAPE_TRANSITIONS_DIR` env var.
    /// 2. `~/.local/lib/liascape/transitions` (the default install, `install.sh`).
    /// 3. The repo's own `transitions/`, found by walking up from the current exe's path
    ///    and, failing that, from `CARGO_MANIFEST_DIR` (a build-time constant, so this
    ///    works at `cargo test` time even before any exe-relative candidate would).
    ///
    /// Each candidate is only accepted if it actually contains a `manifest.json` —
    /// a directory that merely exists but is empty (or mid-rewrite) is skipped rather
    /// than handed to [`Catalogue::load`] to fail on.
    ///
    /// Returns `None` if nothing above resolves — notably true inside `nix build
    /// .#liascape-player`'s sandboxed check phase, where `src/player` is built without its
    /// sibling `transitions/` directory present. Callers (every test in
    /// `tests/effects_all.rs`) treat `None` as a clean skip, not a failure.
    pub fn resolve_dir() -> Option<PathBuf> {
        if let Ok(env_dir) = std::env::var("LIASCAPE_TRANSITIONS_DIR") {
            let p = PathBuf::from(env_dir);
            if p.join("manifest.json").is_file() {
                return Some(p);
            }
        }

        if let Some(home) = std::env::var_os("HOME") {
            let p = PathBuf::from(home).join(".local/lib/liascape/transitions");
            if p.join("manifest.json").is_file() {
                return Some(p);
            }
        }

        if let Ok(exe) = std::env::current_exe()
            && let Some(found) = walk_up_for_transitions(&exe)
        {
            return Some(found);
        }

        walk_up_for_transitions(Path::new(env!("CARGO_MANIFEST_DIR")))
    }

    /// Load `manifest.json` (122 entries) plus `wrap.vert`/`wrap.frag.template` from
    /// `dir`, header-rewritten for desktop GL. Does not touch `glsl/` yet — bodies are
    /// read lazily, per id, by [`Catalogue::program`].
    pub fn load(dir: &Path) -> Result<Catalogue, String> {
        let manifest_path = dir.join("manifest.json");
        let manifest_text = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("reading {}: {e}", manifest_path.display()))?;
        let raw: Vec<RawManifestEntry> = serde_json::from_str(&manifest_text)
            .map_err(|e| format!("parsing {}: {e}", manifest_path.display()))?;

        let mut effects = Vec::with_capacity(raw.len());
        for entry in raw {
            let mut uniforms = Vec::with_capacity(entry.uniforms.len());
            for u in entry.uniforms {
                let kind = UniformKind::parse(&u.ty)
                    .map_err(|e| format!("manifest.json: effect `{}`: {e}", entry.id))?;
                uniforms.push(UniformSpec {
                    name: u.name,
                    kind,
                    default: u.default,
                });
            }
            effects.push(EffectSpec {
                id: entry.id,
                uniforms,
            });
        }

        let vert_path = dir.join("wrap.vert");
        let vert_raw = fs::read_to_string(&vert_path)
            .map_err(|e| format!("reading {}: {e}", vert_path.display()))?;
        // wrap.vert has no `precision` line of its own (it only emits `gl_Position` /
        // `vUv`) — only the version line is mandatory here.
        let vert_src = rewrite_header(&vert_raw, "wrap.vert", false)?;

        let frag_path = dir.join("wrap.frag.template");
        let frag_raw = fs::read_to_string(&frag_path)
            .map_err(|e| format!("reading {}: {e}", frag_path.display()))?;
        let frag_template = rewrite_header(&frag_raw, "wrap.frag.template", true)?;

        Ok(Catalogue {
            dir: dir.to_path_buf(),
            effects,
            vert_src,
            frag_template,
            programs: HashMap::new(),
            failed: HashMap::new(),
        })
    }

    /// A catalogue with no effects (no `transitions/` directory resolved — e.g. a bare
    /// install): cuts still work, every [`Catalogue::program`] is an unknown-id error.
    pub fn empty() -> Catalogue {
        Catalogue {
            dir: PathBuf::new(),
            effects: Vec::new(),
            vert_src: String::new(),
            frag_template: String::new(),
            programs: HashMap::new(),
            failed: HashMap::new(),
        }
    }

    /// The directory it was loaded from (`None` for [`Catalogue::empty`]).
    pub fn dir(&self) -> Option<&Path> {
        (!self.dir.as_os_str().is_empty()).then_some(self.dir.as_path())
    }

    /// Every effect id from `manifest.json`, in manifest order.
    pub fn ids(&self) -> Vec<String> {
        self.effects.iter().map(|e| e.id.clone()).collect()
    }

    /// Compile-and-link `id`'s program if it hasn't been already, then return it.
    /// Compile/link errors are prefixed with the effect id (so a batch run like
    /// `tests/effects_all.rs`'s `all_compile` can list failures by id without having to
    /// re-thread it through `Gfx::program`'s own stage-only error).
    ///
    /// A failure is cached (M3): later calls return the same error at once, and it is
    /// logged once (`effects.compile_failed`) — the compositor then draws a cut.
    pub fn program(&mut self, gfx: &Gfx, id: &str) -> Result<&EffectProgram, String> {
        if let Some(e) = self.failed.get(id) {
            return Err(e.clone());
        }
        if !self.programs.contains_key(id)
            && let Err(e) = self.build(gfx, id)
        {
            {
                if self.effects.iter().any(|x| x.id == id) {
                    crate::log::event(
                        "effects",
                        crate::log::Level::Warn,
                        "effects.compile_failed",
                        None,
                        serde_json::json!({ "id": id, "error": e,
                            "hint": "this effect draws as a cut on this driver" }),
                    );
                    self.failed.insert(id.to_string(), e.clone());
                }
                return Err(e);
            }
        }
        Ok(self.programs.get(id).expect("just inserted above"))
    }

    /// Whether `id` is cached as failing to compile (tests/probes).
    pub fn failed(&self, id: &str) -> bool {
        self.failed.contains_key(id)
    }

    fn build(&mut self, gfx: &Gfx, id: &str) -> Result<(), String> {
        {
            let spec = self
                .effects
                .iter()
                .find(|e| e.id == id)
                .ok_or_else(|| format!("{id}: no such effect in this catalogue"))?
                .clone();

            let body_path = self.dir.join("glsl").join(format!("{id}.glsl"));
            let body = fs::read_to_string(&body_path)
                .map_err(|e| format!("{id}: reading {}: {e}", body_path.display()))?;

            let frag_src = self.frag_template.replacen(BODY_PLACEHOLDER, &body, 1);

            let gl_program = gfx
                .program(&self.vert_src, &frag_src)
                .map_err(|e| format!("{id}: {e}"))?;

            let effect = EffectProgram::new(gfx, gl_program, spec);
            self.programs.insert(id.to_string(), effect);
        }
        Ok(())
    }
}

/// A compiled-and-linked effect: `fromTex`/`toTex`/`progress`/`ratio` plus whatever
/// per-effect params its manifest entry declares, each resolved to a uniform location
/// (or `None` if the driver optimised it away — see [`EffectProgram::draw`]).
pub struct EffectProgram {
    program: glow::Program,
    uniforms: Vec<UniformSpec>,
    from_loc: Option<glow::UniformLocation>,
    to_loc: Option<glow::UniformLocation>,
    progress_loc: Option<glow::UniformLocation>,
    ratio_loc: Option<glow::UniformLocation>,
    param_locs: HashMap<String, Option<glow::UniformLocation>>,
}

impl EffectProgram {
    fn new(gfx: &Gfx, program: glow::Program, spec: EffectSpec) -> Self {
        // SAFETY: `program` just linked successfully (Gfx::program only returns Ok for a
        // linked program) and gfx's context is current on this thread for the lifetime of
        // this Gfx, same precondition every other gl.* call in this crate relies on.
        unsafe {
            let from_loc = gfx.gl.get_uniform_location(program, "fromTex");
            let to_loc = gfx.gl.get_uniform_location(program, "toTex");
            let progress_loc = gfx.gl.get_uniform_location(program, "progress");
            let ratio_loc = gfx.gl.get_uniform_location(program, "ratio");

            let mut param_locs = HashMap::with_capacity(spec.uniforms.len());
            for u in &spec.uniforms {
                param_locs.insert(
                    u.name.clone(),
                    gfx.gl.get_uniform_location(program, &u.name),
                );
            }

            EffectProgram {
                program,
                uniforms: spec.uniforms,
                from_loc,
                to_loc,
                progress_loc,
                ratio_loc,
                param_locs,
            }
        }
    }

    /// Draw this effect's fullscreen triangle into whatever FBO/viewport is currently
    /// bound — this function never binds or queries a framebuffer, resizes a viewport, or
    /// restores any GL state afterwards (the brief's contract: the caller, Task 9's layer
    /// compositor, owns the target). What it *does* leave behind, for the next caller to
    /// either rely on or overwrite: this program bound (`glUseProgram`), `fromTex`/`toTex`
    /// bound at texture units 0/1 with unit 1 left active, and the crate-wide empty VAO
    /// ([`Gfx::empty_vao`]) bound.
    ///
    /// `params` supplies this effect's per-uniform values; a name missing from `params`
    /// (or present but empty) falls back to that uniform's manifest default. Per the
    /// brief: a value may be the manifest-shaped array (`[x, y, ...]`) or, for a scalar
    /// uniform, a bare JSON number — both are accepted. A uniform name in `params` that
    /// this effect doesn't declare is simply never looked at (this loop only ever reads
    /// `self.uniforms`, never iterates `params`' own keys). A uniform the driver optimised
    /// away (`get_uniform_location` returned `None` at compile time) is skipped silently,
    /// never an error.
    pub fn draw(
        &self,
        gfx: &Gfx,
        from: &Tex,
        to: &Tex,
        progress: f64,
        ratio: f64,
        params: &Map<String, Value>,
    ) {
        // SAFETY: same precondition as every other `gl.*` call in this crate — gfx's
        // context is current on the calling thread.
        unsafe {
            gfx.gl.use_program(Some(self.program));

            gfx.gl.active_texture(glow::TEXTURE0);
            gfx.gl.bind_texture(glow::TEXTURE_2D, Some(from.id));
            gfx.gl.active_texture(glow::TEXTURE1);
            gfx.gl.bind_texture(glow::TEXTURE_2D, Some(to.id));

            if let Some(loc) = &self.from_loc {
                gfx.gl.uniform_1_i32(Some(loc), 0);
            }
            if let Some(loc) = &self.to_loc {
                gfx.gl.uniform_1_i32(Some(loc), 1);
            }
            if let Some(loc) = &self.progress_loc {
                gfx.gl.uniform_1_f32(Some(loc), progress as f32);
            }
            if let Some(loc) = &self.ratio_loc {
                gfx.gl.uniform_1_f32(Some(loc), ratio as f32);
            }

            for spec in &self.uniforms {
                let Some(Some(loc)) = self.param_locs.get(&spec.name) else {
                    continue;
                };
                let values = params
                    .get(&spec.name)
                    .map(value_to_f64_vec)
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| spec.default.clone());
                apply_uniform(&gfx.gl, loc, spec.kind, &values);
            }

            gfx.gl.bind_vertex_array(Some(gfx.empty_vao()));
            gfx.gl.draw_arrays(glow::TRIANGLES, 0, 3);
        }
    }
}

/// Normalize one `params` value to the manifest's `default`-array shape: a JSON array is
/// read element-by-element (numbers and bools both accepted, matching how the manifest
/// itself encodes `bool` defaults as `[0.0]`/`[1.0]` — see `.claude/rules/player-core.md`'s
/// "Effects" section); a bare number or bool is treated as a 1-element array (brief: "a
/// bare number is accepted as a 1-element array"). Anything else (string, object, null)
/// yields an empty vec, which [`EffectProgram::draw`] then treats the same as "absent" and
/// falls back to the manifest default.
fn value_to_f64_vec(v: &Value) -> Vec<f64> {
    match v {
        Value::Array(arr) => arr.iter().filter_map(value_to_f64).collect(),
        other => value_to_f64(other).into_iter().collect(),
    }
}

fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Apply one resolved `values` slice to `loc` per the brief's exact type mapping: `bool`
/// → `glUniform1i(0/1)`, `int` → `1i`, `ivec2` → `2i`, `float`/`vec2`/`vec3`/`vec4` →
/// `Nf`. Missing trailing components default to `0.0` (`1.0` for a `vec4`'s alpha, so an
/// under-specified color default still reads as opaque).
fn apply_uniform(
    gl: &glow::Context,
    loc: &glow::UniformLocation,
    kind: UniformKind,
    values: &[f64],
) {
    let get = |i: usize| values.get(i).copied().unwrap_or(0.0);
    // SAFETY: caller (EffectProgram::draw) already has gfx's context current.
    unsafe {
        match kind {
            UniformKind::Bool => gl.uniform_1_i32(Some(loc), if get(0) != 0.0 { 1 } else { 0 }),
            UniformKind::Int => gl.uniform_1_i32(Some(loc), get(0) as i32),
            UniformKind::IVec2 => gl.uniform_2_i32(Some(loc), get(0) as i32, get(1) as i32),
            UniformKind::Float => gl.uniform_1_f32(Some(loc), get(0) as f32),
            UniformKind::Vec2 => gl.uniform_2_f32(Some(loc), get(0) as f32, get(1) as f32),
            UniformKind::Vec3 => {
                gl.uniform_3_f32(Some(loc), get(0) as f32, get(1) as f32, get(2) as f32)
            }
            UniformKind::Vec4 => gl.uniform_4_f32(
                Some(loc),
                get(0) as f32,
                get(1) as f32,
                get(2) as f32,
                values.get(3).copied().unwrap_or(1.0) as f32,
            ),
        }
    }
}

/// Rewrite one wrapper shader's header for desktop GL 3.3 core (brief's exact rule):
/// replace the exact first line `#version 300 es` with `#version 330 core`, and delete a
/// `precision highp float;` line if present.
///
/// **Fails loudly** (names `filename`) if the first line isn't exactly
/// [`ES_VERSION_LINE`] — that line is mandatory in both `wrap.vert` and
/// `wrap.frag.template`, and its absence means the shared asset changed shape under this
/// code. The precision line is different: `wrap.vert` genuinely has none (it only ever
/// emits `gl_Position`/`vUv`), so `require_precision` lets the frag template demand it
/// (fail loudly if *it* ever loses that line) while the vert shader simply deletes it if
/// present and says nothing if not.
fn rewrite_header(src: &str, filename: &str, require_precision: bool) -> Result<String, String> {
    let mut lines: Vec<&str> = src.lines().collect();

    if lines.first().copied() != Some(ES_VERSION_LINE) {
        return Err(format!(
            "{filename}: expected first line `{ES_VERSION_LINE}`, found {:?} — \
             transitions/ asset shape changed, header rewrite needs updating",
            lines.first()
        ));
    }
    lines[0] = CORE_VERSION_LINE;

    match lines.iter().position(|l| *l == PRECISION_LINE) {
        Some(idx) => {
            lines.remove(idx);
        }
        None if require_precision => {
            return Err(format!(
                "{filename}: expected a `{PRECISION_LINE}` line, found none — \
                 transitions/ asset shape changed, header rewrite needs updating"
            ));
        }
        None => {}
    }

    Ok(lines.join("\n") + "\n")
}

/// Walk from `start` up through every ancestor directory, returning the first
/// `<ancestor>/transitions` that contains a `manifest.json`. `start` may be a file (e.g.
/// an exe path) or a directory; the first `join("transitions")` attempt on a file simply
/// never matches and costs nothing.
fn walk_up_for_transitions(start: &Path) -> Option<PathBuf> {
    let mut cur = start;
    loop {
        let candidate = cur.join("transitions");
        if candidate.join("manifest.json").is_file() {
            return Some(candidate);
        }
        cur = cur.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_header_rewrites_version_and_drops_precision() {
        let src = "#version 300 es\nprecision highp float;\nuniform sampler2D fromTex;\n";
        let got = rewrite_header(src, "wrap.frag.template", true).unwrap();
        assert_eq!(got, "#version 330 core\nuniform sampler2D fromTex;\n");
    }

    #[test]
    fn rewrite_header_allows_missing_precision_when_not_required() {
        let src = "#version 300 es\nout vec2 vUv;\n";
        let got = rewrite_header(src, "wrap.vert", false).unwrap();
        assert_eq!(got, "#version 330 core\nout vec2 vUv;\n");
    }

    #[test]
    fn rewrite_header_fails_loud_on_missing_version_line() {
        let src = "out vec2 vUv;\n";
        let err = rewrite_header(src, "wrap.vert", false).unwrap_err();
        assert!(err.contains("wrap.vert"), "error must name the file: {err}");
        assert!(
            err.contains("#version 300 es"),
            "error must name the missing line: {err}"
        );
    }

    #[test]
    fn rewrite_header_fails_loud_on_missing_required_precision() {
        let src = "#version 300 es\nuniform sampler2D fromTex;\n";
        let err = rewrite_header(src, "wrap.frag.template", true).unwrap_err();
        assert!(
            err.contains("wrap.frag.template"),
            "error must name the file: {err}"
        );
        assert!(
            err.contains("precision highp float;"),
            "error must name the missing line: {err}"
        );
    }

    #[test]
    fn value_to_f64_vec_accepts_bare_number_and_array() {
        assert_eq!(value_to_f64_vec(&Value::from(0.7)), vec![0.7]);
        assert_eq!(
            value_to_f64_vec(&Value::from(vec![1.0, 2.0])),
            vec![1.0, 2.0]
        );
        assert_eq!(value_to_f64_vec(&Value::from(true)), vec![1.0]);
    }
}
