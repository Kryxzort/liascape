//! A real WE scene in the worker (Phase 2 Task 7; `.claude/rules/player-core.md` § Scene
//! worker → "Real scenes"): LWE's core ([`lwe::Scene`]) loaded and built on the worker's GL
//! context, rendered into a native-sized FBO (the core draws its final quad with
//! `glViewport(0, 0, sceneW, sceneH)`, spike §2), then blitted into the export ring's slot at
//! the slot's (cover) size — never exported at the native size — with no flip (the core's
//! output is y-down = R25) and alpha forced to 1 (the core leaves 0 in every pixel).

use std::path::{Path, PathBuf};

use glow::HasContext;
use lp_player::gfx::{Fbo, Gfx, Tex};
use lp_player::scene::assets;
use serde_json::{Map, Value};

use crate::lwe;

/// What a `Start` asks for.
pub struct LoadOpts<'a> {
    pub dir: &'a Path,
    pub assets: Option<&'a Path>,
    /// The Steam library the item lives in (`scene::assets::steam_root_of_item`).
    pub steam_dir: Option<&'a Path>,
    /// User properties applied after the load, before the first frame.
    pub properties: &'a Map<String, Value>,
}

pub struct LweScene {
    scene: lwe::Scene,
    pub native: (u32, u32),
    _tex: Tex,
    fbo: Fbo,
    /// `project.json` `general.supportsaudioprocessing`.
    pub wants_audio_input: bool,
    /// The scene plays sound (LWE built ≥ 1 audio stream).
    pub has_audio: bool,
    gl_errors: u32,
}

/// Why `dir` can't be a scene to load, if it can't — a missing or half-downloaded Workshop
/// folder (Steam still syncing, a dangling `local/<id>` symlink) is a clean load failure,
/// never a crash (plan Review Focus #1).
pub fn check_folder(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!(
            "load failed: {} does not exist (deleted, a dangling link, or Steam is still \
             downloading it)",
            dir.display()
        ));
    }
    if !dir.join("project.json").is_file() {
        return Err(format!(
            "load failed: {} has no project.json (Steam is still downloading it?)",
            dir.display()
        ));
    }
    Ok(())
}

/// `project.json` `general.supportsaudioprocessing` (a bool, or the string "true").
pub fn wants_audio_input(dir: &Path) -> bool {
    let Ok(text) = std::fs::read(dir.join("project.json")) else {
        return false;
    };
    let Ok(v) = serde_json::from_slice::<Value>(&text) else {
        return false;
    };
    match &v["general"]["supportsaudioprocessing"] {
        Value::Bool(b) => *b,
        Value::String(s) => s.eq_ignore_ascii_case("true"),
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        _ => false,
    }
}

impl LweScene {
    /// Load + build (the slow part: a cold build took up to 2.8 s — the caller keeps the
    /// protocol answered meanwhile). `on_prop` gets each `properties` entry's outcome.
    pub fn load(
        gfx: &Gfx,
        o: &LoadOpts,
        mut on_prop: impl FnMut(&str, Result<(), String>),
    ) -> Result<LweScene, String> {
        check_folder(o.dir)?;
        let Some(assets_dir) = o.assets else {
            return Err(format!(
                "no Wallpaper Engine assets dir was given to the scene worker; {}",
                assets::HINT
            ));
        };
        let backgrounds: Option<PathBuf> = o
            .steam_dir
            .map(|s| s.join("steamapps/workshop/content").join(assets::WE_APP_ID))
            .filter(|b| b.is_dir());
        let mut scene = lwe::Scene::load_in(o.dir, assets_dir, backgrounds.as_deref())
            .map_err(|e| format!("{e} (a truncated scene.pkg or an unsupported project)"))?;
        for (name, value) in o.properties {
            on_prop(name, scene.set_property(name, value));
        }
        let scratch = gfx.tex(1, 1);
        let scratch_fbo = gfx.fbo(&scratch);
        let (w, h) = scene.first_render(scratch_fbo.id.0.get()).map_err(|e| {
            format!(
                "{e}: renderer build failed (assets: {})",
                assets_dir.display()
            )
        })?;
        let tex = gfx.tex(w, h);
        let fbo = gfx.fbo(&tex);
        Ok(LweScene {
            has_audio: scene.audio_streams() > 0,
            wants_audio_input: wants_audio_input(o.dir),
            scene,
            native: (w, h),
            _tex: tex,
            fbo,
            gl_errors: 0,
        })
    }

    pub fn set_pointer(&self, x: f64, y: f64, buttons: u32) {
        self.scene.set_pointer(x, y, buttons);
    }

    pub fn set_input(&self, samples: &[u8]) {
        self.scene.set_input(samples);
    }

    pub fn set_property(&self, name: &str, value: &Value) -> Result<(), String> {
        self.scene.set_property(name, value)
    }

    /// Render scene time `t` and blit it into `slot` (`w`×`h`, the ring's cover size).
    pub fn render(&mut self, gfx: &Gfx, t: f64, slot: &Fbo, w: u32, h: u32) {
        self.scene.render(t as f32, self.fbo.id.0.get());
        let (nw, nh) = self.native;
        let gl = &gfx.gl;
        unsafe {
            // A GL error LWE left behind goes to the log tail (the first 10).
            let e = gl.get_error();
            if e != glow::NO_ERROR && self.gl_errors < 10 {
                self.gl_errors += 1;
                eprintln!("lwe: GL error {e:#06x} after frame t={t:.3}");
            }
            // LWE leaves its own state behind: a scissor would clip the blit.
            gl.disable(glow::SCISSOR_TEST);
            gl.color_mask(true, true, true, true);
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(self.fbo.id));
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(slot.id));
            let filter = if (nw, nh) == (w, h) {
                glow::NEAREST
            } else {
                glow::LINEAR
            };
            // Row order kept: the core's row 0 is the image's top (R25) — no flip.
            gl.blit_framebuffer(
                0,
                0,
                nw as i32,
                nh as i32,
                0,
                0,
                w as i32,
                h as i32,
                glow::COLOR_BUFFER_BIT,
                filter,
            );
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None);
            // Force alpha = 1 (the core leaves 0) without touching colour.
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(slot.id));
            gl.viewport(0, 0, w as i32, h as i32);
            gl.color_mask(false, false, false, true);
            gl.clear_color(0.0, 0.0, 0.0, 1.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
            gl.color_mask(true, true, true, true);
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            gl.bind_vertex_array(None);
            gl.use_program(None);
        }
    }
}
