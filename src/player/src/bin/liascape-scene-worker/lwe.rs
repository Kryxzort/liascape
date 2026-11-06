//! LWE's core (`linux-wallpaperengine` `next-v2` + `patches/lwe/`), linked only into this binary
//! (feature `lwe`, `build.rs`): its C API declared by hand — the public headers are C++-only
//! (struct tags used as type names) — and a minimal owner for one project in one context.
//!
//! Phase 2 Task 1–2 ship this as the link proof and the `--lwe-smoke` diagnostic
//! ([`smoke`]); Task 7 builds the real renderer (`render.rs`) on [`Scene`] and adds the mouse
//! (`wp_mouse_input`), the visualiser feed (stereo `wp_context_audio_input_push`) and the live user-property
//! setters (`wp_project_property_set_*_by_name`).
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

#[repr(C)]
struct WpMouseInput {
    user_parameter: *mut c_void,
    get_x: extern "C" fn(*mut c_void) -> f64,
    get_y: extern "C" fn(*mut c_void) -> f64,
    is_pressed: extern "C" fn(*mut c_void, c_int) -> c_int,
}

unsafe extern "C" {
    fn wp_config_create() -> *mut c_void;
    fn wp_config_destroy(config: *mut c_void);
    fn wp_config_set_assets_dir(config: *mut c_void, dir: *const c_char) -> bool;
    fn wp_config_set_backgrounds_dir(config: *mut c_void, dir: *const c_char) -> bool;
    fn wp_config_set_storage_dir(config: *mut c_void, dir: *const c_char) -> bool;
    fn wp_config_set_audio_output(config: *mut c_void, output: *const WpAudioOutput);
    fn wp_context_create(config: *const c_void) -> *mut c_void;
    fn wp_context_destroy(context: *mut c_void);
    fn wp_context_set_gl_proc_address(context: *mut c_void, address: *mut WpGlProcAddress);
    fn wp_context_set_time_counter(context: *mut c_void, counter: *mut WpTimeCounter);
    fn wp_context_audio_input_push(
        context: *mut c_void,
        interleaved: *const f32,
        frames: usize,
        channels: c_int,
        sample_rate: c_int,
    );
    fn wp_context_audio_spectrum(
        context: *mut c_void,
        resolution: c_int,
        channel: c_int,
        out: *mut f32,
    ) -> bool;
    fn wp_context_audio_pull(context: *mut c_void, interleaved: *mut f32, frames: usize) -> usize;
    fn wp_context_audio_stream_count(context: *mut c_void) -> c_int;
    fn wp_context_audio_driver_name(context: *mut c_void) -> *const c_char;
    fn wp_project_load_folder(
        context: *mut c_void,
        mouse_input: *mut WpMouseInput,
        folder: *const c_char,
    ) -> *mut c_void;
    fn wp_project_destroy(project: *mut c_void);
    fn wp_project_get_width(project: *mut c_void) -> c_int;
    fn wp_project_get_height(project: *mut c_void) -> c_int;
    fn wp_project_set_output_framebuffer(project: *mut c_void, framebuffer: c_uint);
    fn wp_project_hint_size(project: *mut c_void, width: c_int, height: c_int);
    fn wp_project_set_frame_rate(project: *mut c_void, hz: f32);
    fn wp_project_pointer_jump(project: *mut c_void);
    fn wp_project_property_set_value_by_name(
        project: *mut c_void,
        name: *const c_char,
        value: *const c_char,
    ) -> bool;
    fn wp_project_property_set_boolean_by_name(
        project: *mut c_void,
        name: *const c_char,
        value: bool,
    ) -> bool;
    fn wp_project_property_set_slider_by_name(
        project: *mut c_void,
        name: *const c_char,
        value: f32,
    ) -> bool;
    fn wp_project_property_set_color_by_name(
        project: *mut c_void,
        name: *const c_char,
        r: f32,
        g: f32,
        b: f32,
        a: f32,
    ) -> bool;
    fn wp_render_update_time(context: *mut c_void);
    fn wp_project_uses_media(project: *mut c_void) -> bool;
    fn wp_project_notify_media_status(project: *mut c_void, enabled: bool);
    fn wp_project_notify_track_metadata_change(
        project: *mut c_void,
        title: *const c_char,
        artist: *const c_char,
        album: *const c_char,
    );
    fn wp_project_notify_track_metadata_extra(
        project: *mut c_void,
        album_artist: *const c_char,
        sub_title: *const c_char,
        genres: *const c_char,
        content_type: *const c_char,
    );
    fn wp_project_notify_album_art_url_change(project: *mut c_void, url: *const c_char);
    fn wp_project_notify_playback_state_change(project: *mut c_void, state: c_int);
    fn wp_project_notify_playback_position_and_duration_change(
        project: *mut c_void,
        position: f64,
        duration: f64,
    );
    fn wp_render_frame(project: *mut c_void);
    fn wp_project_shader_check(
        project: *mut c_void,
        shader: *const c_char,
        request: *const c_char,
        out: *mut c_char,
        out_size: usize,
    ) -> usize;
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

/// The pointer LWE reads (native scene pixels, y down; buttons = `WP_MOUSE_INPUT_BUTTON_*`).
/// `set` = the host gave one; until then it sits at the scene's centre once the size is known
/// (a corner would pull a mouse-parallax scene off-centre while no pointer ever came).
#[derive(Default)]
struct Pointer {
    x: Cell<f64>,
    y: Cell<f64>,
    buttons: Cell<u32>,
    set: Cell<bool>,
}

extern "C" fn mouse_x(user: *mut c_void) -> f64 {
    unsafe { (*(user as *const Pointer)).x.get() }
}

extern "C" fn mouse_y(user: *mut c_void) -> f64 {
    unsafe { (*(user as *const Pointer)).y.get() }
}

extern "C" fn mouse_pressed(user: *mut c_void, button: c_int) -> c_int {
    unsafe { ((*(user as *const Pointer)).buttons.get() as c_int) & button }
}

/// Where scenes' scripts keep their `localStorage` (one JSON file per project):
/// `LIASCAPE_SCENE_STORAGE_DIR`, else `$XDG_STATE_HOME/liascape/scene-storage` (`~/.local/state/…`).
fn storage_dir() -> Option<std::path::PathBuf> {
    if let Some(d) = std::env::var_os("LIASCAPE_SCENE_STORAGE_DIR").filter(|d| !d.is_empty()) {
        return Some(d.into());
    }
    std::env::var_os("XDG_STATE_HOME")
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/state")))
        .map(|d| d.join("liascape/scene-storage"))
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
    _mouse: Box<WpMouseInput>,
    pointer: Box<Pointer>,
    built: bool,
    /// the "now playing" feed (B10), for a scene that takes media events
    media: Option<crate::media::Media>,
}

impl Scene {
    /// Loads `dir` (the item folder: `project.json` + `scene.pkg`/`scene.json`). No GL work.
    pub fn load(dir: &Path, assets: &Path) -> Result<Scene, String> {
        Scene::load_in(dir, assets, None)
    }

    /// [`load`](Self::load), with the Workshop folder the item lives in (`backgrounds` =
    /// `<library>/steamapps/workshop/content/431960`, LWE's `backgrounds_dir` for an id — the
    /// `next-v2` core resolves no project dependency yet, so this is recorded, not required).
    pub fn load_in(dir: &Path, assets: &Path, backgrounds: Option<&Path>) -> Result<Scene, String> {
        let cdir = CString::new(dir.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
        let cassets =
            CString::new(assets.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
        let cbg = backgrounds
            .map(|b| CString::new(b.as_os_str().as_encoded_bytes()))
            .transpose()
            .map_err(|e| e.to_string())?;
        unsafe {
            let config = wp_config_create();
            if config.is_null() {
                return Err("wp_config_create failed".into());
            }
            if !wp_config_set_assets_dir(config, cassets.as_ptr()) {
                wp_config_destroy(config);
                return Err(format!("not a WE assets dir: {}", assets.display()));
            }
            if let Some(b) = &cbg {
                wp_config_set_backgrounds_dir(config, b.as_ptr());
            }
            // scripts' localStorage (B10, S36): one file per project here
            if let Some(d) = storage_dir()
                && std::fs::create_dir_all(&d).is_ok()
                && let Ok(cd) = CString::new(d.as_os_str().as_encoded_bytes())
            {
                wp_config_set_storage_dir(config, cd.as_ptr());
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
            let pointer = Box::new(Pointer::default());
            let mut mouse = Box::new(WpMouseInput {
                user_parameter: &*pointer as *const Pointer as *mut c_void,
                get_x: mouse_x,
                get_y: mouse_y,
                is_pressed: mouse_pressed,
            });
            wp_context_set_gl_proc_address(context, &mut *proc);
            wp_context_set_time_counter(context, &mut *clock);
            let project = wp_project_load_folder(context, &mut *mouse, cdir.as_ptr());
            let scene = Scene {
                config,
                context,
                project,
                _proc: proc,
                _clock: clock,
                time,
                _mouse: mouse,
                pointer,
                built: false,
                media: None,
            };
            if project.is_null() {
                return Err(format!("load failed: {}", dir.display()));
            }
            let mut scene = scene;
            if wp_project_uses_media(project) {
                scene.media = crate::media::Media::start();
            }
            Ok(scene)
        }
    }

    /// Renders frame 0 into `scratch_fbo` (any size) and returns the native size; ≤ 1 = the
    /// renderer failed to build (missing assets, a broken scene) — the caller never renders again.
    pub fn first_render(&mut self, scratch_fbo: u32) -> Result<(u32, u32), String> {
        self.apply_media();
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
            if !self.pointer.set.get() {
                self.pointer.x.set(f64::from(w) / 2.0);
                self.pointer.y.set(f64::from(h) / 2.0);
            }
            Ok((w as u32, h as u32))
        }
    }

    /// The screen the scene is shown on (the largest output showing it, pixels): the scripts'
    /// `engine.screenResolution`, and `resizeScreen` when it changes after the first frame (a
    /// size given before it is the screen from the start). 0 = unknown: nothing.
    pub fn hint_screen(&self, w: u32, h: u32) {
        if w == 0 || h == 0 || self.project.is_null() {
            return;
        }
        let clamp = |v: u32| v.min(c_int::MAX as u32) as c_int;
        unsafe { wp_project_hint_size(self.project, clamp(w), clamp(h)) };
    }

    /// Renders the scene at scene time `t` (seconds) into `fbo`, which must be native-sized.
    pub fn render(&mut self, t: f32, fbo: u32) {
        if !self.built {
            return;
        }
        self.time.set(t);
        self.apply_media();
        unsafe {
            wp_project_set_output_framebuffer(self.project, fbo);
            wp_render_update_time(self.context);
            wp_render_frame(self.project);
        }
    }

    /// Hands what the media feed saw since the last frame to the scene's scripts.
    fn apply_media(&mut self) {
        let Some(media) = self.media.as_mut() else {
            return;
        };
        let project = self.project;
        let c = |s: &str| CString::new(s.replace('\0', "")).unwrap_or_default();
        media.apply(&mut |n| unsafe {
            use crate::media::Notify;
            match n {
                Notify::Status(on) => wp_project_notify_media_status(project, on),
                Notify::Properties(t) => {
                    let (a, b, d) = (c(&t.title), c(&t.artist), c(&t.album));
                    wp_project_notify_track_metadata_change(project, a.as_ptr(), b.as_ptr(), d.as_ptr());
                    let (aa, g, ct) = (c(&t.album_artist), c(&t.genres), c("music"));
                    wp_project_notify_track_metadata_extra(
                        project,
                        aa.as_ptr(),
                        c"".as_ptr(),
                        g.as_ptr(),
                        ct.as_ptr(),
                    );
                }
                Notify::Art(url) => {
                    let u = c(url);
                    wp_project_notify_album_art_url_change(project, u.as_ptr());
                }
                Notify::State(s) => wp_project_notify_playback_state_change(project, s),
                Notify::Timeline(p, d) => {
                    wp_project_notify_playback_position_and_duration_change(project, p, d)
                }
            }
        });
    }

    /// The pointer for the next frames: native scene pixels (y down), `buttons` bit 0 left,
    /// 1 right, 2 middle (= `WP_MOUSE_INPUT_BUTTON_*`).
    pub fn set_pointer(&self, x: f64, y: f64, buttons: u32) {
        self.pointer.x.set(x);
        self.pointer.y.set(y);
        self.pointer.buttons.set(buttons);
        self.pointer.set.set(true);
    }

    /// The pointer's next position is a jump, not a move (it entered the output, or came back
    /// from behind a window — Wallpaper Engine sees the cursor on the whole desktop, so it never
    /// jumps there): the frame that reads it takes it as `g_PointerPositionLast` too, and
    /// cursorripple strokes no line along it (fork patch 0106).
    pub fn pointer_jump(&self) {
        unsafe { wp_project_pointer_jump(self.project) }
    }

    /// The rate the scene is meant to tick at (what its outputs ask for, before the GPU
    /// budget's cap): a simulation effect (cursorripple) steps at it whatever rate the frames
    /// arrive at — its strength depends on the frame rate in WE too (fork patch 0105).
    pub fn set_frame_rate(&self, hz: f64) {
        unsafe { wp_project_set_frame_rate(self.project, hz as f32) }
    }

    /// System audio, interleaved stereo f32 at `rate` Hz, every frame in order (B8 "feed
    /// stereo"): the core runs WE's analysis on each channel apart as the frames come
    /// (`wp_context_audio_input_push`; render thread, between frames).
    pub fn push_input(&self, interleaved: &[f32], rate: u32) {
        let frames = interleaved.len() / 2;
        if frames > 0 {
            unsafe {
                wp_context_audio_input_push(
                    self.context,
                    interleaved.as_ptr(),
                    frames,
                    2,
                    rate as c_int,
                )
            };
        }
    }

    /// The spectrum the scene sees this frame: `channel` 0 left, 1 right, 2 their average.
    pub fn spectrum(&self, resolution: usize, channel: i32) -> Option<Vec<f32>> {
        let mut out = vec![0f32; resolution];
        unsafe {
            wp_context_audio_spectrum(self.context, resolution as c_int, channel, out.as_mut_ptr())
        }
        .then_some(out)
    }

    /// Set one user property (`project.json` `general.properties`): a bool → boolean, a
    /// number → slider, `[r, g, b(, a)]` → colour (0–1), a string → LWE's parse by the
    /// property's own type (text, combo key, colour `"r g b"`). `Err` = LWE refused (an unknown
    /// name — the core's `Property not found` — or a value of another shape).
    pub fn set_property(&self, name: &str, value: &serde_json::Value) -> Result<(), String> {
        use serde_json::Value;
        let cname = CString::new(name).map_err(|e| e.to_string())?;
        let ok = unsafe {
            match value {
                Value::Bool(b) => {
                    wp_project_property_set_boolean_by_name(self.project, cname.as_ptr(), *b)
                }
                Value::Number(n) => wp_project_property_set_slider_by_name(
                    self.project,
                    cname.as_ptr(),
                    n.as_f64().unwrap_or(0.0) as f32,
                ),
                Value::Array(a) if (3..=4).contains(&a.len()) && a.iter().all(Value::is_number) => {
                    let c = |i: usize| a.get(i).and_then(Value::as_f64).unwrap_or(1.0) as f32;
                    wp_project_property_set_color_by_name(
                        self.project,
                        cname.as_ptr(),
                        c(0),
                        c(1),
                        c(2),
                        c(3),
                    )
                }
                Value::String(v) => {
                    let cv = CString::new(v.as_str()).map_err(|e| e.to_string())?;
                    wp_project_property_set_value_by_name(self.project, cname.as_ptr(), cv.as_ptr())
                }
                other => return Err(format!("{name}: unsupported value {other}")),
            }
        };
        if ok {
            Ok(())
        } else {
            Err(format!(
                "{name}: refused by the scene (no such property, or a value of another type)"
            ))
        }
    }

    /// The next `out.len() / CHANNELS` frames of the scene's sound (each sound object at its volume²).
    pub fn pull_audio(&self, out: &mut [f32]) -> usize {
        unsafe {
            wp_context_audio_pull(
                self.context,
                out.as_mut_ptr(),
                out.len() / CHANNELS as usize,
            )
        }
    }

    /// The context's host audio driver as a [`Pull`](crate::stretch::Pull) for the audio
    /// thread (Task 6). It holds the raw context: take it out of the audio thread's hands
    /// (`audio::Control::remove`) before this `Scene` is dropped.
    pub fn audio_puller(&self) -> LwePull {
        LwePull {
            context: self.context,
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

/// `wp_context_audio_pull` from another thread (patch 0003: the host driver locks its own
/// stream list, and the pull never waits for decoding).
pub struct LwePull {
    context: *mut c_void,
}

// The context outlives every pull: the renderer removes the puller before dropping the scene.
unsafe impl Send for LwePull {}

impl crate::stretch::Pull for LwePull {
    fn pull(&mut self, out: &mut [f32]) {
        let n = out.len() / CHANNELS as usize;
        let got = unsafe { wp_context_audio_pull(self.context, out.as_mut_ptr(), n) };
        if got < n {
            out[got * CHANNELS as usize..].fill(0.0);
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

/// `liascape-scene-worker --shader-sweep <request.json> --assets <dir> --out <results.jsonl>`: compiles shaders
/// through the core's own pipeline (its preprocessing, glslang + SPIRV-Cross, the GL compile and link on an
/// offscreen context) without rendering — `wp_project_shader_check`, fork patch "core: a shader sweep". The request is
/// `{"jobs": [{"scene": <dir whose files the shaders come from>, "checks": [{"shader", "combos", "textures", …}]}]}`;
/// each check's result (its own keys kept, the core's `ok` / `stage` / `message` / `compat` added) is one line of
/// `<out>`. A job whose scene doesn't load writes one `{"scene", "ok": false, "stage": "project"}` line.
/// `tests/onmachine/shader_sweep.py` writes the request and reports the results.
pub fn shader_sweep(args: &[String]) -> ! {
    let (mut request, mut assets, mut out) = (None, None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--shader-sweep" => request = it.next().cloned(),
            "--assets" => assets = it.next().cloned(),
            "--out" => out = it.next().cloned(),
            _ => {}
        }
    }
    let (Some(request), Some(assets), Some(out)) = (request, assets, out) else {
        eprintln!("usage: liascape-scene-worker --shader-sweep <request.json> --assets <dir> --out <results.jsonl>");
        std::process::exit(2)
    };
    match run_sweep(Path::new(&request), Path::new(&assets), Path::new(&out)) {
        Ok(n) => {
            println!("{}", serde_json::json!({ "ok": true, "checks": n }));
            std::process::exit(0)
        }
        Err(e) => {
            println!("{}", serde_json::json!({ "ok": false, "error": e }));
            std::process::exit(1)
        }
    }
}

fn run_sweep(request: &Path, assets: &Path, out: &Path) -> Result<usize, String> {
    use std::io::Write as _;
    let text = std::fs::read_to_string(request).map_err(|e| e.to_string())?;
    let req: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let _gfx = liascape_player::gfx::Gfx::new_offscreen()?;
    let mut file = std::io::BufWriter::new(std::fs::File::create(out).map_err(|e| e.to_string())?);
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0;
    for job in req["jobs"].as_array().into_iter().flatten() {
        let dir = job["scene"].as_str().unwrap_or_default();
        let scene = match Scene::load(Path::new(dir), assets) {
            Ok(s) => s,
            Err(e) => {
                let line = serde_json::json!({ "scene": dir, "ok": false, "stage": "project", "message": e });
                writeln!(file, "{line}").map_err(|e| e.to_string())?;
                continue;
            }
        };
        for check in job["checks"].as_array().into_iter().flatten() {
            let shader = CString::new(check["shader"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
            let body = serde_json::json!({
                "combos": check.get("combos").cloned().unwrap_or(serde_json::json!({})),
                "textures": check.get("textures").cloned().unwrap_or(serde_json::json!([])),
                "gl": check.get("gl").cloned().unwrap_or(serde_json::json!(true)),
                "source": check.get("source").cloned().unwrap_or(serde_json::json!(false)),
            });
            let body = CString::new(body.to_string()).map_err(|e| e.to_string())?;
            let mut len = unsafe {
                wp_project_shader_check(scene.project, shader.as_ptr(), body.as_ptr(), buf.as_mut_ptr().cast(), buf.len())
            };
            if len >= buf.len() {
                buf.resize(len + 1, 0);
                len = unsafe {
                    wp_project_shader_check(scene.project, shader.as_ptr(), body.as_ptr(), buf.as_mut_ptr().cast(), buf.len())
                };
            }
            let got = &buf[..len.min(buf.len() - 1)];
            let mut result: serde_json::Value = serde_json::from_slice(got)
                .unwrap_or_else(|_| serde_json::json!({ "ok": false, "stage": "core", "message": "no result" }));
            if let (Some(r), Some(c)) = (result.as_object_mut(), check.as_object()) {
                for (k, v) in c {
                    r.entry(k.clone()).or_insert(v.clone());
                }
                r.insert("scene".into(), dir.into());
            }
            writeln!(file, "{result}").map_err(|e| e.to_string())?;
            // a check that crashes the driver leaves the ones before it on disk
            file.flush().map_err(|e| e.to_string())?;
            n += 1;
        }
        drop(scene);
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(n)
}

/// `liascape-scene-worker --lwe-smoke <scene dir> --assets <dir> --out <dir> [--seconds S]`: renders a
/// real scene offscreen through LWE's core, writes the native frames at 1 s and at S (default 3)
/// as `<out>/lwe-smoke-1s.png` / `-<S>s.png` (upright, alpha forced to 1), pulls 0.5 s of its
/// sound through the host driver, and prints one JSON line. Exit 0 = rendered and animating.
/// A diagnostic for the build (Task 1) and the patches (Task 2); not used by liascape-player.
/// `--prop name=value` (repeatable) sets a user property at load, like `scene_props` (the value as
/// JSON — `0.8`, `true`, `"text"` — else a string); `--prop-at T name=value` sets it `T` s into the
/// `--audio-dump` (a live change, as the worker applies `SetProperty`), or without `--audio-dump`
/// `T` s into the frames, after writing the frame before it as `<out>/lwe-smoke-before-<T>s.png`.
/// `--pointer X0,Y0:X1,Y1` moves the pointer (native scene px, y down, as the host feeds it) in a straight
/// line from the first point at frame 1 to the second at the last frame — a scripted cursor path, so a
/// pointer-driven layer (a trail, parallax, a cursor-follow script) can be checked for direction.
/// The core's build report (`WPENGINE_HEALTH`, fork patch 0061: each object built or dropped and why, shader /
/// script / asset errors, each layer's canvas bbox at frames 1 and 31) goes to `<out>/health.json` beside the PNGs.
/// `--tone HZ` feeds the visualiser input a full-scale sine of `HZ` (synthetic: nothing is played), 48 kHz
/// stereo, every frame's samples in order — compare with a run without it. `--tone-channel left|right`
/// puts it on one channel only (the other silent); `--tone noise` is white noise (every band, like music
/// that fills the spectrum) at −6 dBFS RMS; `--tone-sweep HZ1` glides from `HZ` to `HZ1`
/// (log, over the run). The JSON's `spectrum` is the 16-band left/right spectrum the scene saw last.
/// Frames are paced to the wall clock (frame `f` at `f/30` s after the first): video textures are
/// decoded by libmpv in real time, so an unpaced run (all of `S` s in a few ms) shows them black
/// (3426575339, 3432876246, 3556794116). `--unpaced` renders as fast as it can, as before.
/// `--shots T,T…` also writes the frames at those scene times (`lwe-smoke-<T>s.png`; the run lasts at least the
/// last of them), and `--shot-width W` box-filters every smoke PNG down to at most `W` px wide — the preview
/// compare (`tests/onmachine/scene_preview_compare.sh`) takes small frames at 0.5 / 2 / 5 s.
pub fn smoke(args: &[String]) -> ! {
    let mut scene_dir = None;
    let mut assets = None;
    let mut out = None;
    let mut seconds = 3.0f32;
    let mut audio_dump = 0.0f32;
    let mut tone = Tone::default();
    let mut paced = true;
    let mut pointer: Option<[f64; 4]> = None;
    let mut shot_at: Vec<f32> = Vec::new();
    let mut shot_width = 0u32;
    let mut props: Vec<(String, serde_json::Value)> = Vec::new();
    let mut props_at: Vec<(f32, String, serde_json::Value)> = Vec::new();
    let prop = |kv: Option<&String>| -> Option<(String, serde_json::Value)> {
        let (k, v) = kv?.split_once('=')?;
        let v = serde_json::from_str(v).unwrap_or_else(|_| serde_json::Value::String(v.into()));
        Some((k.to_string(), v))
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--lwe-smoke" => scene_dir = it.next().cloned(),
            "--assets" => assets = it.next().cloned(),
            "--out" => out = it.next().cloned(),
            "--seconds" => seconds = it.next().and_then(|v| v.parse().ok()).unwrap_or(3.0),
            "--audio-dump" => audio_dump = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
            "--tone" => {
                tone.hz = match it.next().map(String::as_str) {
                    Some("noise") => -1.0,
                    v => v.and_then(|v| v.parse().ok()).unwrap_or(0.0),
                }
            }
            "--tone-sweep" => tone.to_hz = it.next().and_then(|v| v.parse().ok()),
            "--tone-channel" => {
                tone.gains = match it.next().map(String::as_str) {
                    Some("left") => [1.0, 0.0],
                    Some("right") => [0.0, 1.0],
                    _ => [1.0, 1.0],
                }
            }
            "--unpaced" => paced = false,
            "--shots" => {
                shot_at = it
                    .next()
                    .map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect())
                    .unwrap_or_default()
            }
            "--shot-width" => shot_width = it.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            "--pointer" => {
                pointer = it.next().and_then(|v| {
                    let n: Vec<f64> = v.split([',', ':']).filter_map(|x| x.parse().ok()).collect();
                    (n.len() == 4).then(|| [n[0], n[1], n[2], n[3]])
                })
            }
            "--prop" => props.extend(prop(it.next())),
            "--prop-at" => {
                let at = it.next().and_then(|v| v.parse().ok());
                if let (Some(at), Some((k, v))) = (at, prop(it.next())) {
                    props_at.push((at, k, v));
                }
            }
            _ => {}
        }
    }
    let (Some(scene_dir), Some(assets), Some(out)) = (scene_dir, assets, out) else {
        eprintln!(
            "usage: liascape-scene-worker --lwe-smoke <scene dir> --assets <dir> --out <dir> [--seconds S] [--audio-dump S] [--tone HZ [--tone-channel left|right] [--tone-sweep HZ1]] [--prop name=value]... [--prop-at T name=value]... [--pointer X0,Y0:X1,Y1] [--unpaced] [--shots T,T…] [--shot-width W]"
        );
        std::process::exit(2)
    };
    props_at.sort_by(|a, b| a.0.total_cmp(&b.0));
    // the core's build report (fork patch 0061): WPENGINE_HEALTH is read when the project loads
    let health_lines = health_path(Path::new(&out));
    let result = run_smoke(
        Path::new(&scene_dir),
        Path::new(&assets),
        Path::new(&out),
        seconds,
        audio_dump,
        tone,
        paced,
        pointer,
        (&shot_at, shot_width),
        &props,
        &props_at,
    );
    if let Some(lines) = health_lines {
        let smoke = match &result {
            Ok(json) => serde_json::from_str(json).unwrap_or(serde_json::Value::Null),
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        };
        write_health(Path::new(&out), &lines, &scene_dir, smoke);
    }
    match result {
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

/// The smoke's health dump: unless the caller set `WPENGINE_HEALTH` itself (then it's theirs, raw), the core writes
/// its JSON lines to `<out>/health.jsonl` (a fresh file per run) and [`write_health`] gathers them into
/// `<out>/health.json` beside the PNGs. Returns the lines file when the smoke owns it.
fn health_path(out: &Path) -> Option<std::path::PathBuf> {
    if std::env::var_os("WPENGINE_HEALTH").is_some() {
        return None;
    }
    std::fs::create_dir_all(out).ok()?;
    let lines = out.join("health.jsonl");
    let _ = std::fs::remove_file(&lines);
    // SAFETY: the smoke mode is single-threaded until the scene loads
    unsafe { std::env::set_var("WPENGINE_HEALTH", &lines) };
    Some(lines)
}

/// `<out>/health.json`: `{scene, smoke (the smoke's own JSON line, or its error), events (the core's records, in
/// order), counts (records per event)}` — the scene health report (`tests/onmachine/scene_health.sh`) reads it.
fn write_health(out: &Path, lines: &Path, scene: &str, smoke: serde_json::Value) {
    let text = std::fs::read_to_string(lines).unwrap_or_default();
    let events: Vec<serde_json::Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let mut counts = serde_json::Map::new();
    for e in &events {
        let ev = e.get("ev").and_then(|v| v.as_str()).unwrap_or("?").to_string();
        let n = counts.get(&ev).and_then(|v| v.as_u64()).unwrap_or(0);
        counts.insert(ev, (n + 1).into());
    }
    let json = serde_json::json!({
        "scene": scene,
        "smoke": smoke,
        "events": events,
        "counts": counts,
    });
    let _ = std::fs::write(out.join("health.json"), serde_json::to_vec_pretty(&json).unwrap_or_default());
}

fn run_smoke(
    dir: &Path,
    assets: &Path,
    out: &Path,
    seconds: f32,
    audio_dump: f32,
    tone: Tone,
    paced: bool,
    pointer: Option<[f64; 4]>,
    (shot_at, shot_width): (&[f32], u32),
    props: &[(String, serde_json::Value)],
    props_at: &[(f32, String, serde_json::Value)],
) -> Result<String, String> {
    use glow::HasContext;
    use liascape_player::gfx::Gfx;

    let gfx = Gfx::new_offscreen()?;
    let t0 = std::time::Instant::now();
    // a smoke run keeps the scene's localStorage with its PNGs, not in the user's state
    if std::env::var_os("LIASCAPE_SCENE_STORAGE_DIR").is_none() {
        // SAFETY: the smoke mode is single-threaded until the scene loads
        unsafe { std::env::set_var("LIASCAPE_SCENE_STORAGE_DIR", out.join("storage")) };
    }
    let mut scene = Scene::load(dir, assets)?;
    let load_ms = t0.elapsed().as_secs_f64() * 1e3;
    // before the renderer build, like the worker's `Start.properties`
    let mut prop_errors = Vec::new();
    for (k, v) in props {
        if let Err(e) = scene.set_property(k, v) {
            prop_errors.push(e);
        }
    }
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
    let last_shot = shot_at.iter().copied().fold(0.0f32, f32::max);
    let frames = (seconds.max(last_shot) * 30.0).round().max(30.0) as u32;
    let shot_frames: Vec<u32> = shot_at.iter().map(|t| (t * 30.0).round().max(1.0) as u32).collect();
    let write_shot = |gfx: &Gfx, path: &Path| -> Result<(), String> {
        let px = gfx.read_back(&tex, false);
        let px = if shot_width > 0 { px.shrink(shot_width) } else { px };
        px.write_png(path).map_err(|e| format!("{}: {e}", path.display()))
    };
    let mut frame_ms = Vec::new();
    let mut at_1s = Vec::new();
    let mut shots = Vec::new();
    let mut live = props_at.iter().filter(|_| audio_dump <= 0.0).peekable();
    let mut live_errors = Vec::new();
    let start = std::time::Instant::now();
    let mut tone_phase = 0.0f64;
    for f in 1..=frames {
        let t = f as f32 / 30.0;
        if paced {
            // video textures play on the wall clock (libmpv), so scene time may not run ahead of it
            let due = std::time::Duration::from_secs_f32((f - 1) as f32 / 30.0);
            if let Some(wait) = due.checked_sub(start.elapsed()) {
                std::thread::sleep(wait);
            }
        }
        if live.peek().is_some_and(|(at, _, _)| *at <= t) {
            opaque(&gfx);
            let path = out.join(format!("lwe-smoke-before-{}s.png", (t * 10.0).round() / 10.0));
            write_shot(&gfx, &path)?;
            shots.push(path.display().to_string());
            while let Some((_, k, v)) = live.next_if(|(at, _, _)| *at <= t) {
                if let Err(e) = scene.set_property(k, v) {
                    live_errors.push(e);
                }
            }
        }
        if tone.hz != 0.0 {
            // this frame's 1/30 s of the tone, in order, as the worker feeds system audio
            let pcm = tone.render(&mut tone_phase, (f - 1) as f32 / 30.0, t, seconds);
            scene.push_input(&pcm, SAMPLE_RATE as u32);
        }
        if let Some([x0, y0, x1, y1]) = pointer {
            let k = if frames > 1 { (f - 1) as f64 / (frames - 1) as f64 } else { 1.0 };
            scene.set_pointer(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, 0);
        }
        let s = std::time::Instant::now();
        scene.render(t, fbo_id);
        unsafe { gfx.gl.finish() }; // a diagnostic: time the GPU too
        frame_ms.push(s.elapsed().as_secs_f64() * 1e3);
        if f == 30 || f == frames || shot_frames.contains(&f) {
            opaque(&gfx);
            let name = format!("lwe-smoke-{}s.png", (t * 10.0).round() / 10.0);
            let path = out.join(&name);
            write_shot(&gfx, &path)?;
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
    let dump = if audio_dump > 0.0 {
        audio_dump_stretch(
            &mut scene,
            fbo_id,
            frames as f32 / 30.0,
            out,
            audio_dump,
            props_at,
        )?
    } else {
        serde_json::Value::Null
    };
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
        "spectrum": {
            "left": scene.spectrum(16, 0),
            "right": scene.spectrum(16, 1),
        },
        "shots": shots,
        "audio_dump": dump,
        "prop_errors": prop_errors,
        "prop_at_errors": live_errors,
    });
    drop(scene);
    if changed == 0 || lit == 0 {
        return Err(format!("not animating or blank: {json}"));
    }
    Ok(json.to_string())
}

/// The smoke's synthetic visualiser input (`--tone`, `--tone-channel`, `--tone-sweep`).
#[derive(Clone, Copy)]
struct Tone {
    hz: f32,
    to_hz: Option<f32>,
    gains: [f32; 2],
}

impl Default for Tone {
    fn default() -> Tone {
        Tone {
            hz: 0.0,
            to_hz: None,
            gains: [1.0, 1.0],
        }
    }
}

impl Tone {
    /// Interleaved stereo f32 at 48 kHz for scene time `t0..t1` (of a `len` s run),
    /// phase-continuous through `phase` (cycles).
    fn render(&self, phase: &mut f64, t0: f32, t1: f32, len: f32) -> Vec<f32> {
        let rate = SAMPLE_RATE as f64;
        let (a, b) = ((t0 as f64 * rate) as i64, (t1 as f64 * rate) as i64);
        let mut v = Vec::with_capacity(((b - a).max(0) * 2) as usize);
        if self.hz < 0.0 {
            // white noise, uniform ±0.87 (≈ −6 dBFS RMS), an xorshift on the frame index
            for n in a..b {
                let mut x = (n as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let u = (x >> 11) as f32 / (1u64 << 53) as f32 * 2.0 - 1.0;
                v.extend([0.87 * u * self.gains[0], 0.87 * u * self.gains[1]]);
            }
            return v;
        }
        for n in a..b {
            let hz = match self.to_hz {
                Some(to) if to > 0.0 => {
                    let k = (n as f64 / rate / len.max(0.001) as f64).clamp(0.0, 1.0);
                    self.hz as f64 * (to as f64 / self.hz as f64).powf(k)
                }
                _ => self.hz as f64,
            };
            *phase = (*phase + hz / rate).fract();
            let x = (std::f64::consts::TAU * *phase).sin() as f32;
            v.extend([x * self.gains[0], x * self.gains[1]]);
        }
        v
    }
}

/// `--audio-dump S` (Task 6 diagnostic): `S` seconds of the scene's sound pulled at 1× in real
/// time (64-frame pulls, like the stream's callbacks) → `<out>/audio-in.f32`, then that same
/// input through the time stretch at 0.5× and 1.5× → `audio-out-0.5.f32` / `-1.5.f32`
/// (interleaved stereo F32, 48 kHz). Reports each file's exact-silence 1 ms blocks. The scene
/// keeps rendering at 30 fps of its clock meanwhile (from `t_scene`), as the worker does: LWE's
/// sound objects advance their playlists on that clock (fork patch 0018). `props_at` (sorted)
/// are set when the dump reaches their time.
fn audio_dump_stretch(
    scene: &mut Scene,
    fbo: u32,
    t_scene: f32,
    out: &Path,
    secs: f32,
    props_at: &[(f32, String, serde_json::Value)],
) -> Result<serde_json::Value, String> {
    use crate::stretch::{Pull, Stretch};
    let ch = CHANNELS as usize;
    let total = (secs * SAMPLE_RATE as f32) as usize;
    let mut input = vec![0f32; total * ch];
    let t0 = std::time::Instant::now();
    let mut next_frame = 0.0f64;
    let mut pending = props_at.iter().peekable();
    let mut applied = Vec::new();
    for (i, chunk) in input.chunks_mut(64 * ch).enumerate() {
        let at = i as f64 * 64.0 / SAMPLE_RATE as f64;
        let due = std::time::Duration::from_secs_f64(at);
        if let Some(w) = due.checked_sub(t0.elapsed()) {
            std::thread::sleep(w);
        }
        while let Some((t, k, v)) = pending.next_if(|p| p.0 as f64 <= at) {
            applied.push(serde_json::json!({"t": t, "name": k, "value": v,
                "ok": scene.set_property(k, v).map_err(|e| e.to_string())}));
        }
        if at >= next_frame {
            scene.render(t_scene + at as f32, fbo);
            next_frame += 1.0 / 30.0;
        }
        scene.pull_audio(chunk);
    }
    struct VecPull(Vec<f32>, usize);
    impl Pull for VecPull {
        fn pull(&mut self, out: &mut [f32]) {
            for v in out.iter_mut() {
                *v = self.0.get(self.1).copied().unwrap_or(0.0);
                self.1 += 1;
            }
        }
    }
    let silent_blocks = |x: &[f32]| {
        x.chunks_exact(48 * ch)
            .filter(|b| liascape_player::audio::meter::dbfs_block(b, ch) <= -95.9)
            .count()
    };
    let write = |name: &str, x: &[f32]| -> Result<(), String> {
        let bytes: Vec<u8> = x.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(out.join(name), bytes).map_err(|e| e.to_string())
    };
    write("audio-in.f32", &input)?;
    let mut report =
        serde_json::json!({"in_silent_1ms": silent_blocks(&input), "props_at": applied});
    for speed in [0.5f64, 1.5] {
        let n = ((total as f64 / speed) as usize).saturating_sub(4800);
        let mut st = Stretch::new();
        let mut src = VecPull(input.clone(), 0);
        let mut o = vec![0f32; n * ch];
        for chunk in o.chunks_mut(64 * ch) {
            st.produce(chunk, speed, &mut src);
        }
        write(&format!("audio-out-{speed}.f32"), &o)?;
        report[format!("out_{speed}_silent_1ms")] = serde_json::json!(silent_blocks(&o));
    }
    Ok(report)
}
