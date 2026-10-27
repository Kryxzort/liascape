//! LWE's core (`linux-wallpaperengine` `next-v2` + `patches/lwe/`), linked only into this binary
//! (feature `lwe`, `build.rs`): its C API declared by hand — the public headers are C++-only
//! (struct tags used as type names) — and a minimal owner for one project in one context.
//!
//! Phase 2 Task 1–2 ship this as the link proof and the `--lwe-smoke` diagnostic
//! ([`smoke`]); Task 7 builds the real renderer (`render.rs`) on [`Scene`].
//!
//! Host rules (docs/player/spikes/lwe-core.md §6): the assets dir is passed explicitly; frame 0
//! renders into a scratch FBO, then the output is sized to `wp_project_get_width/height`; a NULL
//! load or a size ≤ 1 after the first render = broken, never rendered again (patch 0004 makes a
//! second render harmless anyway); `wp_render_update_time` once per frame; the output is y-down
//! (row 0 = the image's top, our R25 source layout — no flip); alpha is 0 in every pixel.
//! Audio goes through the host driver (patch 0003): no SDL device is ever opened.

use std::cell::Cell;
use std::ffi::{CStr, CString, c_char, c_int, c_uint, c_void};
use std::path::Path;

#[repr(C)]
struct WpGlProcAddress {
    user_parameter: *mut c_void,
    get_proc_address: extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
}

#[repr(C)]
struct WpTimeCounter {
    user_parameter: *mut c_void,
    get_time: extern "C" fn(*mut c_void) -> f32,
}

#[repr(C)]
struct WpAudioOutput {
    sample_rate: c_int,
    channels: c_int,
}

unsafe extern "C" {
    fn wp_config_create() -> *mut c_void;
    fn wp_config_destroy(config: *mut c_void);
    fn wp_config_set_assets_dir(config: *mut c_void, dir: *const c_char) -> bool;
    fn wp_config_set_audio_output(config: *mut c_void, output: *const WpAudioOutput);
    fn wp_context_create(config: *const c_void) -> *mut c_void;
    fn wp_context_destroy(context: *mut c_void);
    fn wp_context_set_gl_proc_address(context: *mut c_void, address: *mut WpGlProcAddress);
    fn wp_context_set_time_counter(context: *mut c_void, counter: *mut WpTimeCounter);
    fn wp_context_audio_pull(context: *mut c_void, interleaved: *mut f32, frames: usize) -> usize;
    fn wp_context_audio_stream_count(context: *mut c_void) -> c_int;
    fn wp_context_audio_driver_name(context: *mut c_void) -> *const c_char;
    fn wp_project_load_folder(
        context: *mut c_void,
        mouse_input: *mut c_void,
        folder: *const c_char,
    ) -> *mut c_void;
    fn wp_project_destroy(project: *mut c_void);
    fn wp_project_get_width(project: *mut c_void) -> c_int;
    fn wp_project_get_height(project: *mut c_void) -> c_int;
    fn wp_project_set_output_framebuffer(project: *mut c_void, framebuffer: c_uint);
    fn wp_render_update_time(context: *mut c_void);
    fn wp_render_frame(project: *mut c_void);
}

// libEGL is linked by khronos-egl's `static` feature.
unsafe extern "C" {
    fn eglGetProcAddress(name: *const c_char) -> *mut c_void;
}

extern "C" fn gl_proc_address(_: *mut c_void, name: *const c_char) -> *mut c_void {
    unsafe { eglGetProcAddress(name) }
}

extern "C" fn scene_time(user: *mut c_void) -> f32 {
    unsafe { (*(user as *const Cell<f32>)).get() }
}

/// The host audio format: what Task 6's PipeWire stream plays.
pub const SAMPLE_RATE: i32 = 48_000;
pub const CHANNELS: i32 = 2;

/// One LWE project in its own context (+ configuration), on the calling thread's current GL
/// context. Single-threaded except [`Scene::pull_audio`] (the context's host audio driver
/// locks its own stream list).
pub struct Scene {
    config: *mut c_void,
    context: *mut c_void,
    project: *mut c_void,
    // LWE keeps these pointers: they live exactly as long as the context
    _proc: Box<WpGlProcAddress>,
    _clock: Box<WpTimeCounter>,
    time: Box<Cell<f32>>,
    built: bool,
}

impl Scene {
    /// Loads `dir` (the item folder: `project.json` + `scene.pkg`/`scene.json`). No GL work.
    pub fn load(dir: &Path, assets: &Path) -> Result<Scene, String> {
        let cdir = CString::new(dir.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
        let cassets =
            CString::new(assets.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
        unsafe {
            let config = wp_config_create();
            if config.is_null() {
                return Err("wp_config_create failed".into());
            }
            if !wp_config_set_assets_dir(config, cassets.as_ptr()) {
                wp_config_destroy(config);
                return Err(format!("not a WE assets dir: {}", assets.display()));
            }
            let out = WpAudioOutput {
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS,
            };
            wp_config_set_audio_output(config, &out);
            let context = wp_context_create(config);
            if context.is_null() {
                wp_config_destroy(config);
                return Err("wp_context_create failed".into());
            }
            let time = Box::new(Cell::new(0.0f32));
            let mut proc = Box::new(WpGlProcAddress {
                user_parameter: std::ptr::null_mut(),
                get_proc_address: gl_proc_address,
            });
            let mut clock = Box::new(WpTimeCounter {
                user_parameter: &*time as *const Cell<f32> as *mut c_void,
                get_time: scene_time,
            });
            wp_context_set_gl_proc_address(context, &mut *proc);
            wp_context_set_time_counter(context, &mut *clock);
            let project = wp_project_load_folder(context, std::ptr::null_mut(), cdir.as_ptr());
            let scene = Scene {
                config,
                context,
                project,
                _proc: proc,
                _clock: clock,
                time,
                built: false,
            };
            if project.is_null() {
                return Err(format!("load failed: {}", dir.display()));
            }
            Ok(scene)
        }
    }

    /// Renders frame 0 into `scratch_fbo` (any size) and returns the native size; ≤ 1 = the
    /// renderer failed to build (missing assets, a broken scene) — the caller never renders again.
    pub fn first_render(&mut self, scratch_fbo: u32) -> Result<(u32, u32), String> {
        unsafe {
            wp_project_set_output_framebuffer(self.project, scratch_fbo);
            wp_render_update_time(self.context);
            wp_render_frame(self.project);
            let (w, h) = (
                wp_project_get_width(self.project),
                wp_project_get_height(self.project),
            );
            if w <= 1 || h <= 1 {
                return Err(format!("renderer build failed ({w}x{h})"));
            }
            self.built = true;
            Ok((w as u32, h as u32))
        }
    }

    /// Renders the scene at scene time `t` (seconds) into `fbo`, which must be native-sized.
    pub fn render(&mut self, t: f32, fbo: u32) {
        if !self.built {
            return;
        }
        self.time.set(t);
        unsafe {
            wp_project_set_output_framebuffer(self.project, fbo);
            wp_render_update_time(self.context);
            wp_render_frame(self.project);
        }
    }

    /// The next `out.len() / CHANNELS` frames of the scene's sound (unity gain).
    pub fn pull_audio(&self, out: &mut [f32]) -> usize {
        unsafe {
            wp_context_audio_pull(
                self.context,
                out.as_mut_ptr(),
                out.len() / CHANNELS as usize,
            )
        }
    }

    pub fn audio_streams(&self) -> i32 {
        unsafe { wp_context_audio_stream_count(self.context) }
    }

    pub fn audio_driver(&self) -> String {
        unsafe {
            let p = wp_context_audio_driver_name(self.context);
            if p.is_null() {
                return String::new();
            }
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        unsafe {
            if !self.project.is_null() {
                wp_project_destroy(self.project);
            }
            wp_context_destroy(self.context);
            wp_config_destroy(self.config);
        }
    }
}

/// `lp-scene-worker --lwe-smoke <scene dir> --assets <dir> --out <dir> [--seconds S]`: renders a
/// real scene offscreen through LWE's core, writes the native frames at 1 s and at S (default 3)
/// as `<out>/lwe-smoke-1s.png` / `-<S>s.png` (upright, alpha forced to 1), pulls 0.5 s of its
/// sound through the host driver, and prints one JSON line. Exit 0 = rendered and animating.
/// A diagnostic for the build (Task 1) and the patches (Task 2); not used by lp-player.
pub fn smoke(args: &[String]) -> ! {
    let mut scene_dir = None;
    let mut assets = None;
    let mut out = None;
    let mut seconds = 3.0f32;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--lwe-smoke" => scene_dir = it.next().cloned(),
            "--assets" => assets = it.next().cloned(),
            "--out" => out = it.next().cloned(),
            "--seconds" => seconds = it.next().and_then(|v| v.parse().ok()).unwrap_or(3.0),
            _ => {}
        }
    }
    let (Some(scene_dir), Some(assets), Some(out)) = (scene_dir, assets, out) else {
        eprintln!(
            "usage: lp-scene-worker --lwe-smoke <scene dir> --assets <dir> --out <dir> [--seconds S]"
        );
        std::process::exit(2)
    };
    match run_smoke(
        Path::new(&scene_dir),
        Path::new(&assets),
        Path::new(&out),
        seconds,
    ) {
        Ok(json) => {
            println!("{json}");
            std::process::exit(0)
        }
        Err(e) => {
            println!("{}", serde_json::json!({ "ok": false, "error": e }));
            std::process::exit(1)
        }
    }
}

fn run_smoke(dir: &Path, assets: &Path, out: &Path, seconds: f32) -> Result<String, String> {
    use glow::HasContext;
    use lp_player::gfx::Gfx;

    let gfx = Gfx::new_offscreen()?;
    let t0 = std::time::Instant::now();
    let mut scene = Scene::load(dir, assets)?;
    let load_ms = t0.elapsed().as_secs_f64() * 1e3;
    let scratch = gfx.tex(1, 1);
    let scratch_fbo = gfx.fbo(&scratch);
    let t1 = std::time::Instant::now();
    let (w, h) = scene.first_render(scratch_fbo.id.0.get())?;
    let build_ms = t1.elapsed().as_secs_f64() * 1e3;
    let tex = gfx.tex(w, h);
    let fbo = gfx.fbo(&tex);
    let fbo_id = fbo.id.0.get();
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;

    let opaque = |gfx: &Gfx| unsafe {
        // LWE leaves alpha 0 in every pixel; the worker forces 1 (spike §2)
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
        gfx.gl.color_mask(false, false, false, true);
        gfx.gl.clear_color(0.0, 0.0, 0.0, 1.0);
        gfx.gl.clear(glow::COLOR_BUFFER_BIT);
        gfx.gl.color_mask(true, true, true, true);
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    };
    let read = |gfx: &Gfx| -> Vec<u8> {
        let mut px = vec![0u8; (w * h * 4) as usize];
        unsafe {
            gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
            gfx.gl.read_pixels(
                0,
                0,
                w as i32,
                h as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(Some(&mut px)),
            );
            gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        }
        px
    };

    // 30 fps of scene time from 0 to `seconds`
    let frames = (seconds * 30.0).round().max(30.0) as u32;
    let mut frame_ms = Vec::new();
    let mut at_1s = Vec::new();
    let mut shots = Vec::new();
    for f in 1..=frames {
        let t = f as f32 / 30.0;
        let s = std::time::Instant::now();
        scene.render(t, fbo_id);
        unsafe { gfx.gl.finish() }; // a diagnostic: time the GPU too
        frame_ms.push(s.elapsed().as_secs_f64() * 1e3);
        if f == 30 || f == frames {
            opaque(&gfx);
            let name = format!("lwe-smoke-{}s.png", (t * 10.0).round() / 10.0);
            let path = out.join(&name);
            gfx.write_png_source(&tex, &path)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            shots.push(path.display().to_string());
            if f == 30 {
                at_1s = read(&gfx);
            }
        }
    }
    let last = read(&gfx);
    let changed = at_1s
        .chunks_exact(4)
        .zip(last.chunks_exact(4))
        .filter(|(a, b)| a[..3] != b[..3])
        .count();
    let lit = last
        .chunks_exact(4)
        .filter(|p| p[0] as u32 + p[1] as u32 + p[2] as u32 > 24)
        .count();
    let gl_error = unsafe { gfx.gl.get_error() };

    // 0.5 s of the scene's sound through the host driver (the decode thread fills asynchronously)
    let mut buf = vec![0f32; 480 * CHANNELS as usize];
    let mut peak = 0f32;
    for _ in 0..50 {
        scene.pull_audio(&mut buf);
        peak = buf.iter().fold(peak, |p, v| p.max(v.abs()));
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    frame_ms.sort_by(|a, b| a.total_cmp(b));
    let mean = frame_ms.iter().sum::<f64>() / frame_ms.len() as f64;
    let p95 = frame_ms[(frame_ms.len() * 95 / 100).min(frame_ms.len() - 1)];
    let json = serde_json::json!({
        "ok": changed > 0 && lit > 0,
        "scene": dir.display().to_string(),
        "native": [w, h],
        "load_ms": load_ms,
        "build_ms": build_ms,
        "frames": frames,
        "frame_ms_mean": mean,
        "frame_ms_p95": p95,
        "pixels": w * h,
        "lit_pixels": lit,
        "changed_pixels_1s_to_end": changed,
        "gl_error": gl_error,
        "audio_driver": scene.audio_driver(),
        "audio_streams": scene.audio_streams(),
        "audio_peak": peak,
        "shots": shots,
    });
    drop(scene);
    if changed == 0 || lit == 0 {
        return Err(format!("not animating or blank: {json}"));
    }
    Ok(json.to_string())
}
