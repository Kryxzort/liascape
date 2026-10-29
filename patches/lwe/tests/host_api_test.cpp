// Tests of liascape's patches to LWE's public API (patches/lwe/0003-0006, 0012-0016, 0018, 0019), run by
// `bash scripts/lwe.sh test` against the built core. C++ only because LWE's public headers are:
// they use `struct` tags as type names (`wp_mute_check*`), which C rejects.
//
//   host_api_test <fixtures dir> <empty dir> [<WE assets dir>]
//
// Fixtures: min-scene (clear colour only — builds without WE's assets: docs/player/spikes/lwe-core.md
// §7), fail-scene (loads, then its renderer build throws: an object with a missing parent),
// case-scene (min-scene whose project.json names its scene file in another case) and text-scene
// (text objects with `padding` as a string / a number / an array and `"particle": "None"`).
//
// Exit 0 = every test passed (or SKIPped, with the reason printed); 1 = a failure. Needs
// SDL_AUDIODRIVER=dummy (the SDL test must not open a real device). The render tests need a
// surfaceless EGL desktop-GL 3.3 context (SKIP without one); the audio-mix, sound and script tests need WE's
// assets (a scene only builds its renderer with them; the scripts' classes and modules are WE's — SKIP without).
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <SDL.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>
#include <vector>

#include "linux-wallpaperengine/configuration.h"
#include "linux-wallpaperengine/context.h"
#include "linux-wallpaperengine/project.h"
#include "linux-wallpaperengine/render.h"

static int g_failures = 0;
static int g_passes = 0;

#define CHECK(cond, ...)                                                                                               \
    do {                                                                                                               \
        if (!(cond)) {                                                                                                 \
            fprintf (stderr, "    FAIL %s:%d: %s — ", __FILE__, __LINE__, #cond);                                     \
            fprintf (stderr, __VA_ARGS__);                                                                             \
            fprintf (stderr, "\n");                                                                                    \
            return false;                                                                                              \
        }                                                                                                              \
    } while (0)

// HOST_API_TEST_ONLY=<substring>: run only the tests whose name contains it
static void run (const char* name, bool (*fn) ()) {
    if (const char* only = getenv ("HOST_API_TEST_ONLY"); only && !strstr (name, only)) {
        return;
    }
    printf ("  %s ...\n", name);
    fflush (stdout);
    if (fn ()) {
        printf ("  ok   %s\n", name);
        g_passes++;
    } else {
        printf ("  FAIL %s\n", name);
        g_failures++;
    }
    fflush (stdout);
}

static std::string g_fixtures, g_emptyDir, g_assets;

// ---------------------------------------------------------------------------------------------
// EGL: surfaceless desktop GL 3.3 core (the scene worker's context shape)

static EGLDisplay g_dpy = EGL_NO_DISPLAY;
static EGLContext g_ctx = EGL_NO_CONTEXT;
static std::string g_eglSkip;

static void* proc_address (void*, const char* name) { return reinterpret_cast<void*> (eglGetProcAddress (name)); }
static wp_gl_proc_address g_proc = { .user_parameter = nullptr, .get_proc_address = proc_address };

static bool egl_up () {
    if (g_ctx != EGL_NO_CONTEXT) {
        return true;
    }
    if (!g_eglSkip.empty ()) {
        return false;
    }
    auto getPlatformDisplay
        = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC> (eglGetProcAddress ("eglGetPlatformDisplayEXT"));
    const char* client = eglQueryString (EGL_NO_DISPLAY, EGL_EXTENSIONS);
    if (!getPlatformDisplay || !client || !strstr (client, "EGL_MESA_platform_surfaceless")) {
        g_eglSkip = "no EGL_MESA_platform_surfaceless";
        return false;
    }
    g_dpy = getPlatformDisplay (EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr);
    EGLint maj, min;
    if (g_dpy == EGL_NO_DISPLAY || !eglInitialize (g_dpy, &maj, &min)) {
        g_eglSkip = "surfaceless eglInitialize failed";
        return false;
    }
    eglBindAPI (EGL_OPENGL_API);
    const EGLint cfgAttr[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE };
    EGLConfig cfg;
    EGLint n = 0;
    if (!eglChooseConfig (g_dpy, cfgAttr, &cfg, 1, &n) || n == 0) {
        g_eglSkip = "no desktop-GL EGL config";
        return false;
    }
    const EGLint ctxAttr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
                               EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE };
    g_ctx = eglCreateContext (g_dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
    if (g_ctx == EGL_NO_CONTEXT || !eglMakeCurrent (g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, g_ctx)) {
        g_eglSkip = "no GL 3.3 core context";
        g_ctx = EGL_NO_CONTEXT;
        return false;
    }
    return true;
}

// a w x h RGBA8 FBO, through the GL entry points the core itself would use
static unsigned int scratch_fbo (int w = 1, int h = 1) {
    using GenFn = void (*) (int, unsigned int*);
    using BindFn = void (*) (unsigned int, unsigned int);
    using TexImageFn = void (*) (unsigned, int, int, int, int, int, unsigned, unsigned, const void*);
    using FbTexFn = void (*) (unsigned, unsigned, unsigned, unsigned, int);
    auto genTextures = reinterpret_cast<GenFn> (eglGetProcAddress ("glGenTextures"));
    auto bindTexture = reinterpret_cast<BindFn> (eglGetProcAddress ("glBindTexture"));
    auto texImage2D = reinterpret_cast<TexImageFn> (eglGetProcAddress ("glTexImage2D"));
    auto genFramebuffers = reinterpret_cast<GenFn> (eglGetProcAddress ("glGenFramebuffers"));
    auto bindFramebuffer = reinterpret_cast<BindFn> (eglGetProcAddress ("glBindFramebuffer"));
    auto fbTex = reinterpret_cast<FbTexFn> (eglGetProcAddress ("glFramebufferTexture2D"));
    unsigned int tex = 0, fbo = 0;
    genTextures (1, &tex);
    bindTexture (0x0DE1 /*GL_TEXTURE_2D*/, tex);
    texImage2D (0x0DE1, 0, 0x8058 /*GL_RGBA8*/, w, h, 0, 0x1908 /*GL_RGBA*/, 0x1401 /*GL_UNSIGNED_BYTE*/, nullptr);
    genFramebuffers (1, &fbo);
    bindFramebuffer (0x8D40 /*GL_FRAMEBUFFER*/, fbo);
    fbTex (0x8D40, 0x8CE0 /*GL_COLOR_ATTACHMENT0*/, 0x0DE1, tex, 0);
    return fbo;
}

static void read_pixel (unsigned int fbo, int x, int y, unsigned char rgba[4]) {
    using BindFn = void (*) (unsigned int, unsigned int);
    using ReadFn = void (*) (int, int, int, int, unsigned, unsigned, void*);
    reinterpret_cast<BindFn> (eglGetProcAddress ("glBindFramebuffer")) (0x8D40, fbo);
    reinterpret_cast<ReadFn> (eglGetProcAddress ("glReadPixels")) (x, y, 1, 1, 0x1908, 0x1401, rgba);
}

static float g_now = 0.0f;
static float fake_time (void*) { return g_now; }
static wp_time_counter g_clock = { .user_parameter = nullptr, .get_time = fake_time };

// ---------------------------------------------------------------------------------------------
// 0003: host audio output driver

static const wp_audio_output kStereo48k = { .sample_rate = 48000, .channels = 2 };

static bool host_output_replaces_sdl () {
    wp_configuration* cfg = wp_config_create ();
    wp_config_set_audio_output (cfg, &kStereo48k);
    wp_context* ctx = wp_context_create (cfg);
    CHECK (ctx != nullptr, "wp_context_create returned NULL");
    const char* name = wp_context_audio_driver_name (ctx);
    CHECK (name && strcmp (name, "host") == 0, "driver is '%s'", name ? name : "(null)");
    CHECK (SDL_WasInit (SDL_INIT_AUDIO) == 0, "SDL's audio subsystem was initialised");
    CHECK (wp_context_audio_stream_count (ctx) == 0, "streams: %d", wp_context_audio_stream_count (ctx));
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    CHECK (SDL_WasInit (SDL_INIT_AUDIO) == 0, "SDL's audio subsystem was initialised at teardown");
    return true;
}

static bool pull_without_streams_is_silence () {
    wp_configuration* cfg = wp_config_create ();
    wp_config_set_audio_output (cfg, &kStereo48k);
    wp_context* ctx = wp_context_create (cfg);
    CHECK (ctx != nullptr, "wp_context_create returned NULL");
    std::vector<float> buf (1024 * 2, 0.75f);
    const size_t got = wp_context_audio_pull (ctx, buf.data (), 1024);
    CHECK (got == 1024, "pulled %zu frames", got);
    for (size_t i = 0; i < buf.size (); i++) {
        CHECK (buf[i] == 0.0f, "sample %zu = %f", i, buf[i]);
    }
    // a zero-frame pull and a null buffer are harmless
    CHECK (wp_context_audio_pull (ctx, buf.data (), 0) == 0, "zero-frame pull");
    CHECK (wp_context_audio_pull (ctx, nullptr, 16) == 0, "null-buffer pull");
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    return true;
}

static bool pull_on_sdl_context_returns_zero () {
    wp_configuration* cfg = wp_config_create ();
    wp_context* ctx = wp_context_create (cfg);
    CHECK (ctx != nullptr, "wp_context_create returned NULL");
    std::vector<float> buf (64 * 2, 0.75f);
    CHECK (wp_context_audio_pull (ctx, buf.data (), 64) == 0, "an SDL-driven context must not be pulled");
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    return true;
}

static bool sdl_stays_default_without_host_output () {
    wp_configuration* cfg = wp_config_create ();
    wp_context* ctx = wp_context_create (cfg);
    CHECK (ctx != nullptr, "wp_context_create returned NULL");
    const char* name = wp_context_audio_driver_name (ctx);
    CHECK (name && strcmp (name, "sdl") == 0, "driver is '%s'", name ? name : "(null)");
    // a NULL output resets a config to SDL too
    wp_configuration* cfg2 = wp_config_create ();
    wp_config_set_audio_output (cfg2, &kStereo48k);
    wp_config_set_audio_output (cfg2, nullptr);
    wp_context* ctx2 = wp_context_create (cfg2);
    const char* name2 = wp_context_audio_driver_name (ctx2);
    CHECK (name2 && strcmp (name2, "sdl") == 0, "after a NULL output the driver is '%s'", name2 ? name2 : "(null)");
    wp_context_destroy (ctx2);
    wp_config_destroy (cfg2);
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    return true;
}

// a scene with one looping sound object: a 440 Hz sine at 0.5 peak, 44.1 kHz mono 16-bit WAV
static std::string write_tone_scene () {
    char tmpl[] = "/tmp/lwe-tone-scene.XXXXXX";
    const char* dir = mkdtemp (tmpl);
    if (!dir) {
        return {};
    }
    const std::string d = dir;
    FILE* f = fopen ((d + "/project.json").c_str (), "w");
    fputs ("{\"title\":\"tone\",\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{}}\n", f);
    fclose (f);
    f = fopen ((d + "/scene.json").c_str (), "w");
    fputs (
        "{\"camera\":{\"center\":\"0 0 -1\",\"eye\":\"0 0 0\",\"up\":\"0 1 0\"},"
        "\"general\":{\"clearcolor\":\"0 0 0\",\"orthogonalprojection\":{\"width\":64,\"height\":32}},"
        "\"objects\":[{\"id\":1,\"name\":\"tone\",\"sound\":[\"tone.wav\"],\"playbackmode\":\"loop\"}]}\n",
        f
    );
    fclose (f);
    const int rate = 44100, n = rate; // 1 s
    std::vector<int16_t> pcm (n);
    for (int i = 0; i < n; i++) {
        pcm[i] = static_cast<int16_t> (std::lround (0.5 * 32767.0 * std::sin (2.0 * M_PI * 440.0 * i / rate)));
    }
    f = fopen ((d + "/tone.wav").c_str (), "wb");
    auto u32 = [f] (uint32_t v) { fwrite (&v, 4, 1, f); };
    auto u16 = [f] (uint16_t v) { fwrite (&v, 2, 1, f); };
    fwrite ("RIFF", 1, 4, f);
    u32 (36 + n * 2);
    fwrite ("WAVEfmt ", 1, 8, f);
    u32 (16);
    u16 (1);
    u16 (1);
    u32 (rate);
    u32 (rate * 2);
    u16 (2);
    u16 (16);
    fwrite ("data", 1, 4, f);
    u32 (n * 2);
    fwrite (pcm.data (), 2, n, f);
    fclose (f);
    return d;
}

static bool host_pull_mixes_scene_sound_at_unity_gain () {
    if (g_assets.empty ()) {
        printf ("    SKIP: no WE assets dir given (a scene builds its renderer only with them)\n");
        return true;
    }
    if (!egl_up ()) {
        printf ("    SKIP: %s\n", g_eglSkip.c_str ());
        return true;
    }
    const std::string dir = write_tone_scene ();
    CHECK (!dir.empty (), "mkdtemp");
    wp_configuration* cfg = wp_config_create ();
    CHECK (wp_config_set_assets_dir (cfg, g_assets.c_str ()), "assets dir %s refused", g_assets.c_str ());
    wp_config_set_audio_output (cfg, &kStereo48k);
    wp_config_set_audio_volume (cfg, 15); // the SDL driver's volume — must NOT apply to a host pull
    wp_context* ctx = wp_context_create (cfg);
    wp_context_set_gl_proc_address (ctx, &g_proc);
    wp_context_set_time_counter (ctx, &g_clock);
    wp_project* p = wp_project_load_folder (ctx, nullptr, dir.c_str ());
    CHECK (p != nullptr, "load of %s failed", dir.c_str ());
    wp_project_set_output_framebuffer (p, scratch_fbo ());
    wp_render_update_time (ctx);
    wp_render_frame (p); // builds the renderer → the sound object → its stream
    CHECK (wp_project_get_width (p) > 1, "renderer build failed (width %d)", wp_project_get_width (p));
    CHECK (wp_context_audio_stream_count (ctx) == 1, "streams: %d", wp_context_audio_stream_count (ctx));
    // the decode thread fills asynchronously: pull 20 ms blocks until the tone shows (≤ 2 s)
    std::vector<float> buf (960 * 2);
    float peak = 0.0f, peakR = 0.0f;
    // a mono source reaches each stereo channel at -3 dB: FFmpeg's default rematrix maps mono as a
    // centre channel (centre mix level 1/sqrt 2); the driver itself adds nothing (volume 15/128 would
    // give 0.059)
    const float expect = 0.5f * static_cast<float> (M_SQRT1_2);
    for (int i = 0; i < 400 && peak < 0.3f; i++) {
        const size_t got = wp_context_audio_pull (ctx, buf.data (), 960);
        CHECK (got == 960, "pulled %zu frames", got);
        for (size_t s = 0; s < buf.size (); s += 2) {
            peak = std::fmax (peak, std::fabs (buf[s]));
            peakR = std::fmax (peakR, std::fabs (buf[s + 1]));
        }
        if (peak < 0.3f) {
            usleep (5000);
        }
    }
    printf ("    tone peak L %.3f R %.3f (expect %.3f: unity gain of a 0.5 mono sine)\n", peak, peakR, expect);
    CHECK (std::fabs (peak - expect) < 0.03f, "left peak %.3f", peak);
    CHECK (std::fabs (peakR - expect) < 0.03f, "right peak %.3f", peakR);
    // a steady state: the next 100 ms are the same tone, without dropouts
    int quiet = 0;
    for (int i = 0; i < 5; i++) {
        wp_context_audio_pull (ctx, buf.data (), 960);
        float blockPeak = 0.0f;
        for (float v : buf) {
            blockPeak = std::fmax (blockPeak, std::fabs (v));
        }
        quiet += blockPeak < 0.3f;
    }
    CHECK (quiet == 0, "%d of 5 blocks quiet after the tone started", quiet);
    wp_project_destroy (p);
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    CHECK (SDL_WasInit (SDL_INIT_AUDIO) == 0, "SDL audio initialised by a host-output scene");
    return true;
}

// ---------------------------------------------------------------------------------------------
// 0004: a project whose renderer failed to build is never rendered again

static bool render_after_failed_build_returns () {
    if (!egl_up ()) {
        printf ("    SKIP: %s\n", g_eglSkip.c_str ());
        return true;
    }
    wp_configuration* cfg = wp_config_create ();
    wp_config_set_audio_output (cfg, &kStereo48k);
    wp_context* ctx = wp_context_create (cfg);
    wp_context_set_gl_proc_address (ctx, &g_proc);
    wp_context_set_time_counter (ctx, &g_clock);
    const std::string dir = g_fixtures + "/fail-scene";
    wp_project* p = wp_project_load_folder (ctx, nullptr, dir.c_str ());
    CHECK (p != nullptr, "load of %s failed (it must load and fail only at the build)", dir.c_str ());
    wp_project_set_output_framebuffer (p, scratch_fbo ());
    for (int i = 0; i < 3; i++) { // unpatched: SIGSEGV on the 2nd call
        g_now = i / 30.0f;
        wp_render_update_time (ctx);
        wp_render_frame (p);
    }
    const int w = wp_project_get_width (p), h = wp_project_get_height (p);
    CHECK (w <= 1 && h <= 1, "a failed build reports %dx%d", w, h);
    wp_project_destroy (p);
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    return true;
}

// D7 probe (Task 1 Step 6): a scene of nothing but a clear colour builds without WE's assets
static bool min_scene_renders_without_assets () {
    if (!egl_up ()) {
        printf ("    SKIP: %s\n", g_eglSkip.c_str ());
        return true;
    }
    wp_configuration* cfg = wp_config_create ();
    // an empty dir is refused as an assets dir; on a machine whose Steam auto-detection finds WE the
    // core would use those, so this test only means "assets-free" where detection finds none
    wp_config_set_assets_dir (cfg, g_emptyDir.c_str ());
    wp_config_set_audio_output (cfg, &kStereo48k);
    wp_context* ctx = wp_context_create (cfg);
    wp_context_set_gl_proc_address (ctx, &g_proc);
    wp_context_set_time_counter (ctx, &g_clock);
    const std::string dir = g_fixtures + "/min-scene";
    wp_project* p = wp_project_load_folder (ctx, nullptr, dir.c_str ());
    CHECK (p != nullptr, "load of %s failed", dir.c_str ());
    wp_project_set_output_framebuffer (p, scratch_fbo ());
    g_now = 0.0f;
    wp_render_update_time (ctx);
    wp_render_frame (p);
    const int w = wp_project_get_width (p), h = wp_project_get_height (p);
    CHECK (w == 64 && h == 32, "native size %dx%d (scene.json says 64x32)", w, h);
    const unsigned int fbo = scratch_fbo (w, h);
    wp_project_set_output_framebuffer (p, fbo);
    for (int i = 1; i <= 2; i++) {
        g_now = i / 30.0f;
        wp_render_update_time (ctx);
        wp_render_frame (p);
    }
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (fbo, w / 2, h / 2, px);
    printf ("    min-scene centre pixel %u %u %u %u (clear colour 0.2 0.4 0.6 = 51 102 153)\n", px[0], px[1], px[2],
            px[3]);
    CHECK (std::abs (px[0] - 51) <= 2 && std::abs (px[1] - 102) <= 2 && std::abs (px[2] - 153) <= 2,
           "centre pixel %u %u %u", px[0], px[1], px[2]);
    wp_project_destroy (p);
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    return true;
}

// load + build + render a clear-colour-only scene folder; its native size and centre pixel
static bool render_clear_scene (const std::string& dir, int wantW, int wantH, int r, int g, int b) {
    wp_configuration* cfg = wp_config_create ();
    wp_config_set_assets_dir (cfg, g_emptyDir.c_str ());
    wp_config_set_audio_output (cfg, &kStereo48k);
    wp_context* ctx = wp_context_create (cfg);
    wp_context_set_gl_proc_address (ctx, &g_proc);
    wp_context_set_time_counter (ctx, &g_clock);
    wp_project* p = wp_project_load_folder (ctx, nullptr, dir.c_str ());
    CHECK (p != nullptr, "load of %s failed", dir.c_str ());
    wp_project_set_output_framebuffer (p, scratch_fbo ());
    g_now = 0.0f;
    wp_render_update_time (ctx);
    wp_render_frame (p);
    const int w = wp_project_get_width (p), h = wp_project_get_height (p);
    CHECK (w == wantW && h == wantH, "native size %dx%d (scene.json says %dx%d)", w, h, wantW, wantH);
    const unsigned int fbo = scratch_fbo (w, h);
    wp_project_set_output_framebuffer (p, fbo);
    g_now = 1 / 30.0f;
    wp_render_update_time (ctx);
    wp_render_frame (p);
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (fbo, w / 2, h / 2, px);
    CHECK (std::abs (px[0] - r) <= 2 && std::abs (px[1] - g) <= 2 && std::abs (px[2] - b) <= 2,
           "centre pixel %u %u %u, want %d %d %d", px[0], px[1], px[2], r, g, b);
    wp_project_destroy (p);
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    return true;
}

static std::string read_file (const std::string& path) {
    std::string out;
    if (FILE* f = fopen (path.c_str (), "rb")) {
        char buf[4096];
        size_t n;
        while ((n = fread (buf, 1, sizeof buf, f)) > 0) {
            out.append (buf, n);
        }
        fclose (f);
    }
    return out;
}

static bool write_file (const std::string& path, const std::string& data) {
    FILE* f = fopen (path.c_str (), "wb");
    if (!f) {
        return false;
    }
    const bool ok = fwrite (data.data (), 1, data.size (), f) == data.size ();
    return fclose (f) == 0 && ok;
}

// a scene.pkg (PKGV0001: sized header, file count, then name / offset / length per file, then the data)
static std::string make_pkg (const std::vector<std::pair<std::string, std::string>>& files) {
    std::string out;
    auto u32 = [&out] (uint32_t v) { out.append (reinterpret_cast<const char*> (&v), 4); };
    auto sized = [&] (const std::string& s) {
        u32 (static_cast<uint32_t> (s.size ()));
        out += s;
    };
    sized ("PKGV0001");
    u32 (static_cast<uint32_t> (files.size ()));
    uint32_t offset = 0;
    for (const auto& [name, data] : files) {
        sized (name);
        u32 (offset);
        u32 (static_cast<uint32_t> (data.size ()));
        offset += static_cast<uint32_t> (data.size ());
    }
    for (const auto& file : files) {
        out += file.second;
    }
    return out;
}

// 0016: Wallpaper Engine's filesystem is case-insensitive; scenes name files in whatever case the author
// typed (scene corpus 3354740764: models/Shadow.json → materials/shadow.json, the pkg holds Shadow.json)
static bool case_insensitive_asset_lookup () {
    if (!egl_up ()) {
        printf ("    SKIP: %s\n", g_eglSkip.c_str ());
        return true;
    }
    // a plain folder: project.json says "Scene.JSON", the file is scene.json (unpatched: load failed)
    if (!render_clear_scene (g_fixtures + "/case-scene", 48, 24, 153, 102, 51)) {
        return false;
    }
    // the same inside a scene.pkg
    char tmpl[] = "/tmp/lwe-case-pkg.XXXXXX";
    const char* tmp = mkdtemp (tmpl);
    CHECK (tmp != nullptr, "mkdtemp failed");
    const std::string dir = tmp;
    CHECK (write_file (dir + "/project.json", read_file (g_fixtures + "/case-scene/project.json")), "write project.json");
    CHECK (write_file (dir + "/scene.pkg", make_pkg ({ { "scene.json", read_file (g_fixtures + "/case-scene/scene.json") } })),
           "write scene.pkg");
    const bool ok = render_clear_scene (dir, 48, 24, 153, 102, 51);
    unlink ((dir + "/project.json").c_str ());
    unlink ((dir + "/scene.pkg").c_str ());
    rmdir (dir.c_str ());
    return ok;
}

// 0012 (#652) + 0014 (#692) + 0015: text objects as Workshop scenes write them load — "padding" as a
// "x y" string (unpatched: type_error 302 escaping a noexcept function → SIGABRT, corpus 3233141951 /
// 3326873240) or a number, "particle": "None" on a text object — and a field in a shape WE never writes
// (an array) falls back to its default instead of aborting the process
static bool odd_text_fields_load () {
    wp_configuration* cfg = wp_config_create ();
    wp_config_set_assets_dir (cfg, g_emptyDir.c_str ());
    wp_config_set_audio_output (cfg, &kStereo48k);
    wp_context* ctx = wp_context_create (cfg);
    const std::string dir = g_fixtures + "/text-scene";
    wp_project* p = wp_project_load_folder (ctx, nullptr, dir.c_str ());
    CHECK (p != nullptr, "load of %s failed", dir.c_str ());
    wp_project_destroy (p);
    wp_context_destroy (ctx);
    wp_config_destroy (cfg);
    return true;
}

// ---------------------------------------------------------------------------------------------
// 0018: sound objects play the way Wallpaper Engine plays them (docs/player/spikes/we-sound-semantics.md § 4)

// a 440 Hz sine at `amp` peak, 48 kHz stereo 16-bit WAV, `secs` long
static std::string tone_wav (float amp, double secs) {
    const int rate = 48000, n = static_cast<int> (rate * secs);
    std::string out;
    auto u32 = [&out] (uint32_t v) { out.append (reinterpret_cast<const char*> (&v), 4); };
    auto u16 = [&out] (uint16_t v) { out.append (reinterpret_cast<const char*> (&v), 2); };
    out += "RIFF";
    u32 (36 + n * 4);
    out += "WAVEfmt ";
    u32 (16);
    u16 (1);
    u16 (2);
    u32 (rate);
    u32 (rate * 4);
    u16 (4);
    u16 (16);
    out += "data";
    u32 (n * 4);
    for (int i = 0; i < n; i++) {
        const auto v = static_cast<int16_t> (std::lround (amp * 32767.0 * std::sin (2.0 * M_PI * 440.0 * i / rate)));
        u16 (static_cast<uint16_t> (v));
        u16 (static_cast<uint16_t> (v));
    }
    return out;
}

// a scene folder with the given objects (JSON array body), project properties (JSON object body) and files
static std::string sound_scene (const std::string& objects, const std::string& properties,
                                const std::vector<std::pair<std::string, std::string>>& files) {
    char tmpl[] = "/tmp/lwe-sound-scene.XXXXXX";
    const char* dir = mkdtemp (tmpl);
    if (!dir) {
        return {};
    }
    const std::string d = dir;
    write_file (d + "/project.json", "{\"title\":\"sound\",\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{\"properties\":{"
                                         + properties + "}}}\n");
    write_file (d + "/scene.json", "{\"camera\":{\"center\":\"0 0 -1\",\"eye\":\"0 0 0\",\"up\":\"0 1 0\"},"
                                   "\"general\":{\"clearcolor\":\"0 0 0\",\"orthogonalprojection\":{\"width\":64,\"height\":32}},"
                                   "\"objects\":["
                                       + objects + "]}\n");
    for (const auto& [name, data] : files) {
        write_file (d + "/" + name, data);
    }
    return d;
}

// one loaded scene, rendered + pulled in lockstep: every step is 20 ms of the host's clock
struct SoundRig {
    wp_configuration* cfg = nullptr;
    wp_context* ctx = nullptr;
    wp_project* p = nullptr;
    std::vector<float> buf = std::vector<float> (960 * 2);

    bool open (const std::string& dir) {
        g_now = 0.0f;
        cfg = wp_config_create ();
        if (!wp_config_set_assets_dir (cfg, g_assets.c_str ())) {
            return false;
        }
        wp_config_set_audio_output (cfg, &kStereo48k);
        ctx = wp_context_create (cfg);
        wp_context_set_gl_proc_address (ctx, &g_proc);
        wp_context_set_time_counter (ctx, &g_clock);
        p = wp_project_load_folder (ctx, nullptr, dir.c_str ());
        if (p == nullptr) {
            return false;
        }
        wp_project_set_output_framebuffer (p, scratch_fbo ());
        wp_render_update_time (ctx);
        wp_render_frame (p);
        return wp_project_get_width (p) > 1;
    }

    // 20 ms: a frame on the host clock, then a pull; returns the block's peak
    float step () {
        g_now += 0.02f;
        wp_render_update_time (ctx);
        wp_render_frame (p);
        usleep (3000); // the read threads fill asynchronously (a pull never waits)
        wp_context_audio_pull (ctx, buf.data (), 960);
        float peak = 0.0f;
        for (float v : buf) {
            peak = std::fmax (peak, std::fabs (v));
        }
        return peak;
    }

    // steps until a block's peak is above `level` (≤ `max` steps); the peak, 0 if never
    float until_above (float level, int max = 100) {
        for (int i = 0; i < max; i++) {
            const float peak = step ();
            if (peak > level) {
                return peak;
            }
        }
        return 0.0f;
    }

    ~SoundRig () {
        if (p) {
            wp_project_destroy (p);
        }
        if (ctx) {
            wp_context_destroy (ctx);
        }
        if (cfg) {
            wp_config_destroy (cfg);
        }
    }
};

static bool sound_tests_can_run () {
    if (g_assets.empty ()) {
        printf ("    SKIP: no WE assets dir given (a scene builds its renderer only with them)\n");
        return false;
    }
    if (!egl_up ()) {
        printf ("    SKIP: %s\n", g_eglSkip.c_str ());
        return false;
    }
    return true;
}

// two files of one `loop` object: one at a time (0.4 or 0.2 — never both, 0.6), each start a new random
// pick, back to back; and the plain-string `sound` form
static bool loop_plays_one_file_at_a_time () {
    if (!sound_tests_can_run ()) {
        return true;
    }
    const std::string dir = sound_scene (
        "{\"id\":1,\"name\":\"two\",\"sound\":[\"a.wav\",\"b.wav\"],\"playbackmode\":\"loop\"}", "",
        { { "a.wav", tone_wav (0.4f, 0.3) }, { "b.wav", tone_wav (0.2f, 0.3) } }
    );
    SoundRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    CHECK (wp_context_audio_stream_count (rig.ctx) == 1, "streams: %d", wp_context_audio_stream_count (rig.ctx));
    CHECK (rig.until_above (0.1f) > 0.1f, "never audible");
    int a = 0, b = 0, quiet = 0, both = 0;
    for (int i = 0; i < 200; i++) { // 4 s ≈ 13 files
        const float peak = rig.step ();
        if (peak > 0.45f) {
            both++;
        } else if (peak > 0.3f) {
            a++;
        } else if (peak > 0.1f) {
            b++;
        } else {
            quiet++;
        }
    }
    printf ("    blocks: a %d, b %d, quiet %d, louder than one file %d\n", a, b, quiet, both);
    CHECK (both == 0, "%d blocks louder than one file: both files at once", both);
    CHECK (a > 15 && b > 15, "a %d / b %d blocks: not a random pick per start", a, b);
    // back to back: a frame at each boundary at most (+ the new stream's first decode)
    CHECK (quiet <= 13 * 3, "%d quiet blocks between files", quiet);

    // `"sound": "a.wav"` (a string, not a list) is a sound object too
    const std::string one = sound_scene ("{\"id\":1,\"name\":\"one\",\"sound\":\"a.wav\"}", "", { { "a.wav", tone_wav (0.4f, 0.3) } });
    SoundRig rig2;
    CHECK (rig2.open (one), "load/build of %s failed", one.c_str ());
    CHECK (wp_context_audio_stream_count (rig2.ctx) == 1, "string form: streams %d", wp_context_audio_stream_count (rig2.ctx));
    CHECK (rig2.until_above (0.3f) > 0.3f, "string form never audible");
    // one file, playbackmode absent = loop: it keeps playing past its 0.3 s
    int silent = 0;
    for (int i = 0; i < 50; i++) {
        silent += rig2.step () < 0.3f;
    }
    CHECK (silent == 0, "a single looping file had %d quiet blocks", silent);
    return true;
}

// `random`: a file, then a uniform [mintime, maxtime] of silence on the host's clock, then a new pick
static bool random_waits_mintime_to_maxtime () {
    if (!sound_tests_can_run ()) {
        return true;
    }
    const std::string dir = sound_scene (
        "{\"id\":1,\"name\":\"rnd\",\"sound\":[\"a.wav\"],\"playbackmode\":\"random\",\"mintime\":0.4,\"maxtime\":0.8}", "",
        { { "a.wav", tone_wav (0.4f, 0.2) } }
    );
    SoundRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    CHECK (rig.until_above (0.3f) > 0.3f, "never audible");
    std::vector<double> gaps;
    bool loud = true;
    int quietRun = 0;
    for (int i = 0; i < 400 && gaps.size () < 6; i++) {
        const bool now = rig.step () > 0.3f;
        if (!now) {
            quietRun++;
        } else if (!loud) {
            gaps.push_back (quietRun * 0.02);
        }
        if (now) {
            quietRun = 0;
        }
        loud = now;
    }
    CHECK (gaps.size () >= 4, "only %zu gaps in 8 s", gaps.size ());
    double lo = 1e9, hi = 0;
    for (double g : gaps) {
        printf ("    gap %.2f s\n", g);
        lo = std::fmin (lo, g);
        hi = std::fmax (hi, g);
    }
    // the silence follows the file's end to a frame (20 ms) + the next stream's first decode
    CHECK (lo >= 0.38 && hi <= 0.9, "gaps %.2f..%.2f s outside 0.4..0.8 s", lo, hi);
    CHECK (hi - lo > 0.02, "every gap %.2f s: not drawn at random", lo);
    return true;
}

// volume 0.5 → amplitude 0.25 (WE squares it); a bound property moves the gain at the very next pull;
// above 1 boosts (no clamp)
static bool volume_is_squared_and_live () {
    if (!sound_tests_can_run ()) {
        return true;
    }
    const std::string dir = sound_scene (
        "{\"id\":1,\"name\":\"lit\",\"sound\":[\"a.wav\"],\"volume\":0.5},"
        "{\"id\":2,\"name\":\"bound\",\"sound\":[\"b.wav\"],\"volume\":{\"user\":\"lvl\",\"value\":1}}",
        "\"lvl\":{\"type\":\"slider\",\"value\":0,\"min\":0,\"max\":2,\"text\":\"level\"}",
        { { "a.wav", tone_wav (0.8f, 1.0) }, { "b.wav", tone_wav (0.1f, 1.0) } }
    );
    SoundRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    CHECK (wp_context_audio_stream_count (rig.ctx) == 2, "streams: %d (a slider at 0 keeps its slot)",
           wp_context_audio_stream_count (rig.ctx));
    float peak = rig.until_above (0.1f);
    for (int i = 0; i < 5; i++) {
        peak = std::fmax (peak, rig.step ());
    }
    printf ("    volume 0.5 on a 0.8 tone: peak %.3f (expect 0.200)\n", peak);
    CHECK (std::fabs (peak - 0.2f) < 0.015f, "peak %.3f, want 0.8 × 0.5² = 0.2", peak);

    // the slider 0 → 2: the bound object starts (it wasn't playing) and plays at 0.1 × 2² = 0.4 on top
    CHECK (wp_project_property_set_slider_by_name (rig.p, "lvl", 2.0f), "slider refused");
    float both = 0.0f;
    for (int i = 0; i < 50 && both < 0.45f; i++) {
        both = std::fmax (both, rig.step ());
    }
    printf ("    + the bound object at slider 2: peak %.3f (expect ≤ 0.600, > 0.45)\n", both);
    CHECK (both > 0.45f && both < 0.62f, "peak %.3f", both);

    // 2 → 1: the very next pull is at the new level (no ramp): ≤ 0.2 + 0.1
    CHECK (wp_project_property_set_slider_by_name (rig.p, "lvl", 1.0f), "slider refused");
    usleep (3000);
    wp_context_audio_pull (rig.ctx, rig.buf.data (), 960);
    float next = 0.0f;
    for (float v : rig.buf) {
        next = std::fmax (next, std::fabs (v));
    }
    printf ("    slider 1, the next pull: peak %.3f (expect ≤ 0.300)\n", next);
    CHECK (next < 0.31f && next > 0.15f, "peak %.3f right after the change", next);
    return true;
}

// startsilent: silent, no slot (only a script's play() starts it); volume 0 → 1 starts a `loop` object
// but never a `single` one
static bool startsilent_and_volume_rise () {
    if (!sound_tests_can_run ()) {
        return true;
    }
    const std::string dir = sound_scene (
        "{\"id\":1,\"name\":\"silent\",\"sound\":[\"a.wav\"],\"startsilent\":true},"
        "{\"id\":2,\"name\":\"single\",\"sound\":[\"b.wav\"],\"playbackmode\":\"single\",\"volume\":{\"user\":\"on1\",\"value\":0}},"
        "{\"id\":3,\"name\":\"loop\",\"sound\":[\"c.wav\"],\"playbackmode\":\"loop\",\"volume\":{\"user\":\"on2\",\"value\":0}}",
        "\"on1\":{\"type\":\"bool\",\"value\":false,\"text\":\"a\"},\"on2\":{\"type\":\"bool\",\"value\":false,\"text\":\"b\"}",
        { { "a.wav", tone_wav (0.4f, 1.0) }, { "b.wav", tone_wav (0.4f, 1.0) }, { "c.wav", tone_wav (0.2f, 1.0) } }
    );
    SoundRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    CHECK (wp_context_audio_stream_count (rig.ctx) == 2, "streams: %d (startsilent has no slot)",
           wp_context_audio_stream_count (rig.ctx));
    float peak = 0.0f;
    for (int i = 0; i < 30; i++) {
        peak = std::fmax (peak, rig.step ());
    }
    CHECK (peak < 1e-4f, "audible (%.3f) with startsilent and two objects at volume 0", peak);
    // the single's bool on: still silent (WE starts a single only at load or from a script)
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "on1", true), "bool refused");
    for (int i = 0; i < 30; i++) {
        peak = std::fmax (peak, rig.step ());
    }
    CHECK (peak < 1e-4f, "the single started on a volume rise (%.3f)", peak);
    // the loop's bool on: it starts
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "on2", true), "bool refused");
    peak = rig.until_above (0.1f);
    for (int i = 0; i < 10; i++) {
        peak = std::fmax (peak, rig.step ());
    }
    printf ("    loop started on its volume rise: peak %.3f (expect 0.200)\n", peak);
    CHECK (std::fabs (peak - 0.2f) < 0.015f, "peak %.3f: the loop alone at 0.2", peak);
    // back to 0: keeps running, silently
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "on2", false), "bool refused");
    peak = 0.0f;
    for (int i = 0; i < 10; i++) {
        peak = std::fmax (peak, rig.step ());
    }
    CHECK (peak < 1e-4f, "peak %.3f at volume 0", peak);
    return true;
}

// ---------------------------------------------------------------------------------------------
// 0019: property scripts run the way Wallpaper Engine runs them (docs/player/spikes/we-lwe-gap-audit.md B1:
// S1-S7, S9, S33-S35, S38). Solid-colour squares (WE's models/util/solidlayer.json, 8x8, on a blue clear) in a
// 64x32 scene; a script on a property moves, hides or scales its square, read back from the centre row

// a scene folder of the given objects (JSON array body) on a 0 0 0.5 clear colour
static std::string script_scene (const std::string& objects) {
    char tmpl[] = "/tmp/lwe-script-scene.XXXXXX";
    const char* dir = mkdtemp (tmpl);
    if (!dir) {
        return {};
    }
    const std::string d = dir;
    write_file (d + "/project.json", "{\"title\":\"scripts\",\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{\"properties\":"
                                     "{\"speed\":{\"type\":\"slider\",\"value\":0.25,\"min\":0,\"max\":1,\"text\":\"s\"}}}}\n");
    write_file (d + "/scene.json", "{\"camera\":{\"center\":\"0 0 -1\",\"eye\":\"0 0 0\",\"up\":\"0 1 0\"},"
                                   "\"general\":{\"clearcolor\":\"0 0 0.5\",\"orthogonalprojection\":{\"width\":64,\"height\":32}},"
                                   "\"objects\":["
                                       + objects + "]}\n");
    return d;
}

// one solid 8x8 square; `props` is the rest of the object's JSON members (each scripted property's object)
static std::string square (int id, const std::string& props) {
    return "{\"id\":" + std::to_string (id) + ",\"name\":\"sq" + std::to_string (id)
         + "\",\"image\":\"models/util/solidlayer.json\",\"size\":\"8 8\",\"color\":\"1 1 1\"," + props + "}";
}

// a property value with a script, as the editor writes it: {"value": …, "script": …}
static std::string scripted (const std::string& name, const std::string& value, const std::string& script) {
    std::string escaped;
    for (char c : script) {
        if (c == '"' || c == '\\') {
            escaped += '\\';
        }
        if (c == '\n') {
            escaped += "\\n";
            continue;
        }
        escaped += c;
    }
    return "\"" + name + "\":{\"value\":" + value + ",\"script\":\"" + escaped + "\"}";
}

struct ScriptRig {
    wp_configuration* cfg = nullptr;
    wp_context* ctx = nullptr;
    wp_project* p = nullptr;
    unsigned int fbo = 0;
    int frames = 0;
    std::string dir;

    bool open (const std::string& sceneDir) {
        dir = sceneDir;
        g_now = 0.0f;
        cfg = wp_config_create ();
        if (!wp_config_set_assets_dir (cfg, g_assets.c_str ())) {
            return false;
        }
        wp_config_set_audio_output (cfg, &kStereo48k);
        ctx = wp_context_create (cfg);
        wp_context_set_gl_proc_address (ctx, &g_proc);
        wp_context_set_time_counter (ctx, &g_clock);
        p = wp_project_load_folder (ctx, nullptr, dir.c_str ());
        if (p == nullptr) {
            return false;
        }
        wp_project_set_output_framebuffer (p, scratch_fbo ());
        step ();
        if (wp_project_get_width (p) != 64 || wp_project_get_height (p) != 32) {
            return false;
        }
        fbo = scratch_fbo (64, 32);
        wp_project_set_output_framebuffer (p, fbo);
        return true;
    }

    void step () {
        g_now += 1.0f / 30.0f;
        wp_render_update_time (ctx);
        wp_render_frame (p);
        frames++;
    }

    // the columns of the centre row a square covers ("#" = covered, "." = the blue clear colour)
    std::string row () {
        if (getenv ("SCRIPT_TEST_DEBUG")) {
            for (int y = 0; y < 32; y++) {
                std::string line;
                for (int x = 0; x < 64; x++) {
                    unsigned char px[4] = { 0, 0, 0, 0 };
                    read_pixel (fbo, x, y, px);
                    line += px[2] < 64 ? '#' : '.';
                }
                printf ("    %2d %s\n", y, line.c_str ());
            }
        }
        std::string out;
        for (int x = 0; x < 64; x++) {
            unsigned char px[4] = { 0, 0, 0, 0 };
            read_pixel (fbo, x, 16, px);
            out += px[2] < 64 ? '#' : '.';
        }
        return out;
    }

    ~ScriptRig () {
        if (p) {
            wp_project_destroy (p);
        }
        if (ctx) {
            wp_context_destroy (ctx);
        }
        if (cfg) {
            wp_config_destroy (cfg);
        }
        if (!dir.empty ()) {
            unlink ((dir + "/project.json").c_str ());
            unlink ((dir + "/scene.json").c_str ());
            rmdir (dir.c_str ());
        }
    }
};

static bool script_tests_can_run () {
    if (g_assets.empty ()) {
        printf ("    SKIP: no WE assets dir given (solid layers, the flat shader and WE's script classes)\n");
        return false;
    }
    if (!egl_up ()) {
        printf ("    SKIP: %s\n", g_eglSkip.c_str ());
        return false;
    }
    return true;
}

// a run of '#' from `from` to `to` inclusive, '.' elsewhere
static std::string covered (int from, int to) {
    std::string out (64, '.');
    for (int x = std::max (from, 0); x <= std::min (to, 63); x++) {
        out[x] = '#';
    }
    return out;
}

// update(value) returning value + 1 moves the property every tick (unpatched: the module was a Promise, update
// was never found and the origin was written as null, (0,0)); a returned Vec3 keeps its z (S9); thisLayer is the
// script's own layer, also in a second object's scripts (S7); `visible` drives the rendered value (S3)
static bool update_moves_the_property () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (
        square (1, scripted ("origin", "\"8 16 5\"", "export function update(value) {\n  return value.add(new Vec3(1, 0, 0));\n}")
                       + ","
                       + scripted ("visible", "true", "export function update(value) {\n  return thisLayer.origin.z == 5;\n}"))
        + "," + square (2, scripted ("origin", "\"48 16 0\"", "export function update(value) {\n  return thisLayer.origin;\n}"))
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 9; i++) {
        rig.step ();
    }
    // 10 ticks: square 1's centre 8 → 18 (columns 14..21), square 2 still at 48 (44..51)
    std::string want = covered (4 + rig.frames, 11 + rig.frames);
    for (int x = 44; x <= 51; x++) {
        want[x] = '#';
    }
    const std::string got = rig.row ();
    printf ("    after %d ticks: %s\n", rig.frames, got.c_str ());
    CHECK (got == want, "want %s", want.c_str ());
    return true;
}

// init(value) runs once, before the first update, and what it returns is written; WE's own script modules import
// (WEMath from the assets' scripts/jsmodules); applyUserProperties gets the user properties once after init
static bool init_runs_first_and_modules_load () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (
        square (1, scripted ("origin", "\"8 16 0\"",
                             "import * as WEMath from 'WEMath';\n"
                             "let base, inits = 0, speed;\n"
                             "export function init(value) {\n  inits++;\n  base = WEMath.mix(value.x, value.x + 64, 0.5);\n}\n"
                             "export function applyUserProperties(p) {\n  speed = p.speed;\n}\n"
                             "export function update(value) {\n  return new Vec3(inits == 1 && speed == 0.25 ? base : -100, value.y, value.z);\n}"))
        + "," + square (2, scripted ("scale", "\"1 1 1\"", "export function init(value) {\n  return new Vec3(2, 2, 1);\n}")
                               + ",\"origin\":\"56 16 0\"")
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 9; i++) {
        rig.step ();
    }
    // square 1 at 8 + 32 = 40 (36..43); square 2 scaled by init's return to 16x16 around 56 (48..63)
    std::string expect = covered (36, 43);
    for (int x = 48; x <= 63; x++) {
        expect[x] = '#';
    }
    const std::string got = rig.row ();
    printf ("    after %d ticks: %s\n", rig.frames, got.c_str ());
    CHECK (got == expect, "want %s", expect.c_str ());
    return true;
}

// an update without a return (undefined) or returning null leaves the property alone (unpatched: written as
// null, the square at (0,0)); a script whose top level throws doesn't take its property down with it
static bool undefined_leaves_the_property () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (
        square (1, scripted ("origin", "\"8 16 0\"", "export function update(value) {\n}"))
        + "," + square (2, scripted ("origin", "\"28 16 0\"", "export function update(value) {\n  return null;\n}"))
        + "," + square (3, scripted ("origin", "\"48 16 0\"", "engine.noSuchFunction();\nexport function update(value) {\n  return new Vec3(0);\n}"))
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 9; i++) {
        rig.step ();
    }
    std::string want = covered (4, 11);
    for (int x : { 24, 44 }) {
        for (int i = 0; i < 8; i++) {
            want[x + i] = '#';
        }
    }
    const std::string got = rig.row ();
    printf ("    after %d ticks: %s\n", rig.frames, got.c_str ());
    CHECK (got == want, "want %s", want.c_str ());
    return true;
}

int main (int argc, char** argv) {
    if (argc < 3) {
        fprintf (stderr, "usage: %s <fixtures dir> <empty dir> [<WE assets dir>]\n", argv[0]);
        return 2;
    }
    g_fixtures = argv[1];
    g_emptyDir = argv[2];
    g_assets = argc > 3 ? argv[3] : "";
    setvbuf (stdout, nullptr, _IOLBF, 0);
    // 0018: the sound objects' random picks and gaps are the same on every run
    setenv ("WPENGINE_SOUND_SEED", "1", 1);
    printf ("host_api_test: LWE core with liascape patches\n");
    // order matters: nothing before the SDL tests may initialise SDL audio
    run ("host_output_replaces_sdl", host_output_replaces_sdl);
    run ("pull_without_streams_is_silence", pull_without_streams_is_silence);
    run ("render_after_failed_build_returns", render_after_failed_build_returns);
    run ("min_scene_renders_without_assets", min_scene_renders_without_assets);
    run ("case_insensitive_asset_lookup", case_insensitive_asset_lookup);
    run ("odd_text_fields_load", odd_text_fields_load);
    run ("host_pull_mixes_scene_sound_at_unity_gain", host_pull_mixes_scene_sound_at_unity_gain);
    run ("loop_plays_one_file_at_a_time", loop_plays_one_file_at_a_time);
    run ("random_waits_mintime_to_maxtime", random_waits_mintime_to_maxtime);
    run ("volume_is_squared_and_live", volume_is_squared_and_live);
    run ("startsilent_and_volume_rise", startsilent_and_volume_rise);
    run ("update_moves_the_property", update_moves_the_property);
    run ("init_runs_first_and_modules_load", init_runs_first_and_modules_load);
    run ("undefined_leaves_the_property", undefined_leaves_the_property);
    run ("sdl_stays_default_without_host_output", sdl_stays_default_without_host_output);
    run ("pull_on_sdl_context_returns_zero", pull_on_sdl_context_returns_zero);
    printf ("host_api_test: %d passed, %d failed\n", g_passes, g_failures);
    return g_failures ? 1 : 0;
}
