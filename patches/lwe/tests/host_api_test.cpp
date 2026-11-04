// Tests of liascape's patches to LWE's public API (patches/lwe/0003-0006, 0012-0016, 0018-0023), run by
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
#include <array>
#include <cmath>
#include <initializer_list>
#include <sstream>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <functional>
#include <string>
#include <sys/stat.h>
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

// the same square in white (B2 reads its red channel as alpha × 255)
static std::string white_square (int id, const std::string& props) {
    std::string sq = square (id, props);
    const std::string from = "\"color\":\"1 1 1\"";
    sq.replace (sq.find (from), from.size (), "\"color\":\"1.0 1.0 1.0\"");
    return sq;
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
    /** more files under `dir` to delete (B3's particle JSON and materials) */
    std::vector<std::string> extra;
    /** the pointer LWE reads (B5), none by default */
    wp_mouse_input* mouse = nullptr;
    /** localStorage's directory (B10), none by default */
    std::string storage;
    /** called once the project loaded, before its first frame (B10: what a host reports before the scene exists) */
    std::function<void (wp_project*)> loaded;
    /** the scene's size (B4's text scenes are bigger) */
    int width = 64;
    int height = 32;

    bool open (const std::string& sceneDir) {
        dir = sceneDir;
        g_now = 0.0f;
        cfg = wp_config_create ();
        if (!wp_config_set_assets_dir (cfg, g_assets.c_str ())) {
            return false;
        }
        wp_config_set_audio_output (cfg, &kStereo48k);
        if (!storage.empty () && !wp_config_set_storage_dir (cfg, storage.c_str ())) {
            return false;
        }
        ctx = wp_context_create (cfg);
        wp_context_set_gl_proc_address (ctx, &g_proc);
        wp_context_set_time_counter (ctx, &g_clock);
        p = wp_project_load_folder (ctx, mouse, dir.c_str ());
        if (p == nullptr) {
            return false;
        }
        if (loaded) {
            loaded (p);
        }
        wp_project_set_output_framebuffer (p, scratch_fbo ());
        step ();
        if (wp_project_get_width (p) != width || wp_project_get_height (p) != height) {
            return false;
        }
        fbo = scratch_fbo (width, height);
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
            for (const auto& f : extra) {
                unlink ((dir + "/" + f).c_str ());
                // and the folders it was in (E41's effects/<name>/), when empty now
                for (auto at = f.rfind ('/'); at != std::string::npos && at > 0; at = f.rfind ('/', at - 1)) {
                    rmdir ((dir + "/" + f.substr (0, at)).c_str ());
                }
            }
            rmdir ((dir + "/particles").c_str ());
            unlink ((dir + "/project.json").c_str ());
            unlink ((dir + "/scene.json").c_str ());
            for (const char* sub : { "shaders", "materials", "models" }) {
                const std::string d = dir + "/" + sub;
                for (const char* f : { "c4.vert", "c4.frag", "c4.json", "b9.vert", "b9.frag", "b9.json" }) {
                    unlink ((d + "/" + f).c_str ());
                }
                rmdir (d.c_str ());
            }
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

// ---------------------------------------------------------------------------------------------
// 0022-0023 (B2): object alpha/colour reach the shader live, g_Color4 = (colour, alpha), keyframe animations
// (docs/player/spikes/we-lwe-gap-audit.md B2: E2, E3, G01, G02). The squares are translucent white over the 0 0 0.5
// clear colour, so a square's red channel is its alpha × 255; read at each square's centre on the centre row

// the red channel at column x of the centre row
static int red_at (const ScriptRig& rig, int x) {
    // (the squares are white: "1.0 1.0 1.0" — a colour without a '.' is 0..255, so "1 1 1" is nearly black)
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, x, 16, px);
    return px[0];
}

static bool near (int got, double want, int slack = 3) { return std::abs (got - static_cast<int> (std::lround (want))) <= slack; }

// a property's animation object: `curves` is the c0.. members, `options` the members of options
static std::string animated (const std::string& name, const std::string& value, const std::string& curves,
                             const std::string& options, bool relative = false) {
    return "\"" + name + "\":{\"value\":" + value + ",\"animation\":{" + curves + ",\"options\":{" + options + "}"
         + (relative ? ",\"relative\":true" : "") + "}}";
}

// a curve of keys {frame, value[, front x y][, back x y][, step]} — handles are WE's {enabled, x, y}
static std::string key (int frame, double value, const std::string& extra = "") {
    char buf[96];
    snprintf (buf, sizeof buf, "{\"frame\":%d,\"value\":%g", frame, value);
    return std::string (buf) + extra + "}";
}
static std::string handle (const char* side, double x, double y) {
    char buf[96];
    snprintf (buf, sizeof buf, ",\"%s\":{\"enabled\":true,\"x\":%g,\"y\":%g}", side, x, y);
    return buf;
}

// a script returning a constant alpha / colour reaches the shader (unpatched: g_Alpha / g_Color were copies taken at
// setup, so the square stayed opaque white); a static alpha reaches g_Color4.w (unpatched: the colour's own w, 1)
static bool object_uniforms_are_live () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (
        white_square (1, "\"origin\":\"8 16 0\"," + scripted ("alpha", "1.0", "export function update(value) {\n  return 0.25;\n}"))
        + "," + white_square (2, "\"origin\":\"24 16 0\"," + scripted ("color", "\"1.0 1.0 1.0\"", "export function update(value) {\n  return new Vec3(0, 1, 0);\n}"))
        + ",{\"id\":3,\"name\":\"c4\",\"image\":\"models/c4.json\",\"size\":\"8 8\",\"color\":\"1.0 1.0 1.0\",\"alpha\":0.5,\"origin\":\"40 16 0\"}"
    );
    // a solid layer whose shader draws g_Color4 as is (genericimage2-4 multiply their texel by it)
    mkdir ((dir + "/shaders").c_str (), 0755);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/shaders/c4.vert", "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\n"
                                          "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n}\n");
    write_file (dir + "/shaders/c4.frag", "uniform vec4 g_Color4;\nvoid main() {\n\tgl_FragColor = g_Color4;\n}\n");
    write_file (dir + "/materials/c4.json", "{\"passes\":[{\"shader\":\"c4\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                            "\"depthwrite\":\"disabled\",\"blending\":\"translucent\"}]}\n");
    write_file (dir + "/models/c4.json", "{\"material\":\"materials/c4.json\",\"solidlayer\":true}\n");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 4; i++) {
        rig.step ();
    }
    unsigned char green[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, 24, 16, green);
    const int a1 = red_at (rig, 8), a3 = red_at (rig, 40);
    printf ("    alpha script: r=%d; colour script: %d %d %d; g_Color4 alpha 0.5: r=%d\n", a1, green[0], green[1], green[2], a3);
    CHECK (near (a1, 0.25 * 255), "the alpha script's 0.25 didn't reach g_Alpha (r=%d)", a1);
    CHECK (green[0] < 16 && green[1] > 240, "the colour script's green didn't reach g_Color (%d %d %d)", green[0], green[1], green[2]);
    CHECK (near (a3, 0.5 * 255), "g_Color4.w isn't the layer's alpha 0.5 (r=%d)", a3);
    return true;
}

// keyframe alpha: linear, a bezier ease, `single` holding its end, `startpaused`, a `step` key, `wraploop`
// (unpatched: `animation` was never read, every square stayed at its value 1)
static bool keyframes_drive_alpha () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string ease = "\"c0\":[" + key (0, 0, handle ("front", 0.6, 0)) + "," + key (30, 1, handle ("back", -0.2, 0)) + "]";
    const std::string dir = script_scene (
        white_square (1, "\"origin\":\"4 16 0\"," + animated ("alpha", "1.0", "\"c0\":[" + key (0, 0) + "," + key (30, 1) + "]", "\"fps\":30,\"length\":30,\"mode\":\"loop\""))
        + "," + white_square (2, "\"origin\":\"14 16 0\"," + animated ("alpha", "1.0", ease, "\"fps\":30,\"length\":30,\"mode\":\"loop\""))
        + "," + white_square (3, "\"origin\":\"24 16 0\"," + animated ("alpha", "1.0", "\"c0\":[" + key (0, 1) + "," + key (10, 0.2) + "]", "\"fps\":30,\"length\":10,\"mode\":\"single\""))
        + "," + white_square (4, "\"origin\":\"34 16 0\"," + animated ("alpha", "1.0", "\"c0\":[" + key (0, 0.75) + "," + key (10, 0) + "]", "\"fps\":30,\"length\":10,\"mode\":\"loop\",\"startpaused\":true"))
        + "," + white_square (5, "\"origin\":\"44 16 0\"," + animated ("alpha", "1", "\"c0\":[" + key (0, 0.9) + "," + key (20, 0.1, ",\"step\":true") + "]", "\"fps\":30,\"length\":40,\"mode\":\"loop\""))
        + "," + white_square (6, "\"origin\":\"54 16 0\"," + animated ("alpha", "1.0", "\"c0\":[" + key (0, 0) + "," + key (10, 1) + "]", "\"fps\":30,\"length\":20,\"mode\":\"loop\",\"wraploop\":true"))
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    while (rig.frames < 15) {
        rig.step ();
    }
    int r[6];
    for (int i = 0; i < 6; i++) {
        r[i] = red_at (rig, 4 + 10 * i);
    }
    printf ("    after %d ticks: linear %d, ease %d, single %d, paused %d, step %d, wraploop %d\n", rig.frames, r[0], r[1], r[2], r[3], r[4], r[5]);
    // frame 15 of 30: 0.5; the ease (control x 0.3 / 0.9) solved at u = 0.5: 0.4079; `single` held 0.2 since frame 10;
    // paused at frame 0: 0.75; before the step key: 0.9; wraploop's key at 20 copies frame 0's 0: halfway back, 0.5
    CHECK (near (r[0], 0.5 * 255), "linear: r=%d", r[0]);
    CHECK (near (r[1], 0.4079 * 255), "bezier ease: r=%d", r[1]);
    CHECK (near (r[2], 0.2 * 255), "single: r=%d", r[2]);
    CHECK (near (r[3], 0.75 * 255), "startpaused: r=%d", r[3]);
    CHECK (near (r[4], 0.9 * 255), "step: r=%d", r[4]);
    CHECK (near (r[5], 0.5 * 255), "wraploop: r=%d", r[5]);
    while (rig.frames < 25) {
        rig.step ();
    }
    const int step = red_at (rig, 44);
    const int loop = red_at (rig, 4);
    printf ("    after %d ticks: step %d, linear %d\n", rig.frames, step, loop);
    CHECK (near (step, 0.1 * 255), "step key at 20 reached: r=%d", step);
    CHECK (near (loop, 25.0 / 30.0 * 255), "linear at 25: r=%d", loop);
    while (rig.frames < 35) {
        rig.step ();
    }
    const int wrapped = red_at (rig, 4);
    printf ("    after %d ticks: linear %d (looped)\n", rig.frames, wrapped);
    CHECK (near (wrapped, 5.0 / 30.0 * 255), "loop: r=%d", wrapped);
    return true;
}

// keyframe origin: `relative` curves add to the "x y z" value; `mirror` comes back
static bool keyframes_move_origin () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string flat0 = "\"c2\":[" + key (0, 0) + "," + key (10, 0) + "]";
    const std::string dir = script_scene (
        square (1, animated ("origin", "\"8 16 0\"", "\"c0\":[" + key (0, 0) + "," + key (30, 30) + "],\"c1\":[" + key (0, 0) + "," + key (30, 0) + "]," + flat0,
                            "\"fps\":30,\"length\":30,\"mode\":\"loop\"", true))
        + "," + square (2, animated ("origin", "\"0 0 0\"", "\"c0\":[" + key (0, 40) + "," + key (10, 50) + "],\"c1\":[" + key (0, 16) + "," + key (10, 16) + "]," + flat0,
                                    "\"fps\":30,\"length\":10,\"mode\":\"mirror\""))
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    while (rig.frames < 15) {
        rig.step ();
    }
    // square 1: 8 + 15 = 23 (19..26); square 2: up to 50 at frame 10, back to 45 at 15 (41..48)
    std::string want = covered (19, 26);
    for (int x = 41; x <= 48; x++) {
        want[x] = '#';
    }
    const std::string got = rig.row ();
    printf ("    after %d ticks: %s\n", rig.frames, got.c_str ());
    CHECK (got == want, "want %s", want.c_str ());
    return true;
}

// ---------------------------------------------------------------------------------------------
// B3 (docs/player/spikes/we-lwe-gap-audit.md: P1, P3–P7, P38): particle maths. Particles are drawn by WE's own
// genericparticle shader with util/white, in the 64x32 scene of the script tests on a black or green clear.

// a particle material (WE's genericparticle, white texture) with the given blending
static std::string particle_material (const char* blending) {
    return std::string ("{\"passes\":[{\"shader\":\"genericparticle\",\"depthtest\":\"disabled\",\"depthwrite\":\"disabled\",")
         + "\"blending\":\"" + blending + "\",\"cullmode\":\"nocull\",\"textures\":[\"util/white\"]}]}\n";
}

// a scene of particle objects; `systems` are (file name under particles/, its JSON). Materials: materials/add.json
// (additive) and materials/opaque.json (translucent; the particles' alpha is 1, so they replace what's below)
static std::string particle_scene (const std::string& objects, const char* clear,
                                   const std::vector<std::pair<std::string, std::string>>& systems,
                                   std::vector<std::string>& files) {
    std::string dir = script_scene (objects);
    if (dir.empty ()) {
        return dir;
    }
    std::string scene = read_file (dir + "/scene.json");
    const std::string from = "\"clearcolor\":\"0 0 0.5\"";
    scene.replace (scene.find (from), from.size (), std::string ("\"clearcolor\":\"") + clear + "\"");
    write_file (dir + "/scene.json", scene);
    mkdir ((dir + "/particles").c_str (), 0755);
    mkdir ((dir + "/materials").c_str (), 0755);
    write_file (dir + "/materials/add.json", particle_material ("additive"));
    write_file (dir + "/materials/opaque.json", particle_material ("translucent"));
    files = { "materials/add.json", "materials/opaque.json" };
    for (const auto& [name, json] : systems) {
        write_file (dir + "/particles/" + name, json);
        files.push_back ("particles/" + name);
    }
    return dir;
}

// a particle object at (x, y) of the scene (top-left origin), with an optional instanceoverride body
static std::string particle_object (int id, const std::string& file, int x, int y, const std::string& overrides = "") {
    std::string o = "{\"id\":" + std::to_string (id) + ",\"name\":\"ps" + std::to_string (id) + "\",\"particle\":\"particles/"
                  + file + "\",\"origin\":\"" + std::to_string (x) + " " + std::to_string (y) + " 0\",\"scale\":\"1 1 1\","
                  + "\"angles\":\"0 0 0\"";
    if (!overrides.empty ()) {
        o += ",\"instanceoverride\":{" + overrides + "}";
    }
    return o + "}";
}

// a system: one sphererandom emitter (`emitter` = its extra members), `initializers` after a fixed size
static std::string particle_system (const char* material, const std::string& top, const std::string& emitter,
                                    const std::string& initializers) {
    return std::string ("{\"material\":\"materials/") + material + ".json\"" + top
         + ",\"emitter\":[{\"name\":\"sphererandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 0\"" + emitter + "}],"
         + "\"initializer\":[{\"name\":\"sizerandom\",\"min\":12,\"max\":12}," + initializers + "]}\n";
}

static bool particle_rig_open (ScriptRig& rig, const std::string& dir, const std::vector<std::string>& files) {
    rig.extra = files;
    return rig.open (dir);
}

// how many particles are stacked on a pixel: additive particles of colour 8/255 each, on black
static double stacked (const ScriptRig& rig, int x, int y) {
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, x, y, px);
    return px[0] / 8.0;
}

// `count` multiplies the emission rate (unpatched: it scaled the pool, the rate stayed); `rate` scales the whole
// step, so a half-rate system also ages at half speed (unpatched: it scaled the emission only, particles of 0.6 s
// lived 0.6 s); `starttime` prewarms the system before its first frame (unpatched: it started empty)
static bool particle_count_rate_and_prewarm () {
    if (!script_tests_can_run ()) {
        return true;
    }
    // every particle at the system's origin (distance 0), 8/255 grey, additive
    const std::string grey = "{\"name\":\"colorrandom\",\"min\":\"8 8 8\",\"max\":\"8 8 8\"}";
    const std::string still = ",\"distancemin\":0,\"distancemax\":0,\"rate\":10";
    const std::string longLived = particle_system ("add", ",\"maxcount\":100", still,
        grey + ",{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}");
    const std::string shortLived = particle_system ("add", ",\"maxcount\":100", still,
        grey + ",{\"name\":\"lifetimerandom\",\"min\":0.6,\"max\":0.6}");
    const std::string prewarmed = particle_system ("add", ",\"maxcount\":100,\"starttime\":1", still,
        grey + ",{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}");
    std::vector<std::string> files;
    const std::string dir = particle_scene (
        particle_object (1, "long.json", 8, 16) + "," + particle_object (2, "long.json", 24, 16, "\"count\":2")
            + "," + particle_object (3, "short.json", 40, 16, "\"rate\":0.5") + "," + particle_object (4, "warm.json", 56, 16),
        "0 0 0", { { "long.json", longLived }, { "short.json", shortLived }, { "warm.json", prewarmed } }, files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    rig.step (); // open() drew its first frame elsewhere; this one is 1/30 s in (0.3 of a particle emitted)
    const double warm0 = stacked (rig, 56, 16), plain0 = stacked (rig, 8, 16);
    printf ("    before the first step: prewarmed %.1f particles, plain %.1f\n", warm0, plain0);
    while (rig.frames < 46) {
        rig.step ();
    }
    const double plain = stacked (rig, 8, 16), counted = stacked (rig, 24, 16), slow = stacked (rig, 40, 16),
                 warm = stacked (rig, 56, 16);
    printf ("    after 1.5 s: plain %.1f, count 2 %.1f, rate 0.5 (0.6 s lives) %.1f, prewarmed %.1f\n", plain, counted, slow,
            warm);
    // 10/s for 1 s of prewarm (0.05 s steps): ~10; 1.5 s at 10/s: ~15; at 20/s: ~30; at half speed 0.75 s of
    // simulation, 7 born, those of the last 0.6 simulated s alive: ~6 (at full-speed ageing: 3); prewarm + 1.5 s: ~25
    CHECK (warm0 >= 8.5 && warm0 <= 11.5, "prewarm: %.1f particles before the first step", warm0);
    CHECK (plain0 < 0.5, "an unwarmed system has particles before its first step (%.1f)", plain0);
    CHECK (plain >= 13.5 && plain <= 16.5, "rate 10 for 1.5 s: %.1f", plain);
    CHECK (counted >= 2 * plain - 2.5 && counted <= 2 * plain + 2.5, "count 2: %.1f against %.1f", counted, plain);
    CHECK (slow >= 5 && slow <= 7.5, "rate 0.5: %.1f alive", slow);
    CHECK (warm >= warm0 + plain - 2 && warm <= warm0 + plain + 2, "prewarmed + 1.5 s: %.1f", warm);
    return true;
}

// colorrandom draws one t for all three channels, raised to `exponent` (unpatched: a draw per channel, no
// exponent): every particle of a 0 0 0 → 255 0 255 range has r = b, and with exponent 4 the mean is 1/5 of 255
static bool particle_colorrandom_one_t () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string sys = particle_system ("opaque", ",\"maxcount\":400",
        ",\"distancemin\":0,\"distancemax\":15,\"rate\":4000,\"instantaneous\":300",
        "{\"name\":\"colorrandom\",\"min\":\"0 0 0\",\"max\":\"255 0 255\",\"exponent\":4},"
        "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}");
    // smaller particles: 2 px
    std::string small = sys;
    small.replace (small.find ("\"min\":12,\"max\":12"), 17, "\"min\":4,\"max\":4");
    std::vector<std::string> files;
    const std::string dir = particle_scene (particle_object (1, "c.json", 32, 16), "0 1 0", { { "c.json", small } }, files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 3; i++) {
        rig.step ();
    }
    int covered = 0, off = 0;
    double sum = 0;
    for (int y = 0; y < 32; y++) {
        for (int x = 0; x < 64; x++) {
            unsigned char px[4] = { 0, 0, 0, 0 };
            read_pixel (rig.fbo, x, y, px);
            if (px[1] > 8) {
                continue; // the green clear colour
            }
            covered++;
            sum += px[0];
            if (std::abs (px[0] - px[2]) > 3) {
                off++;
            }
        }
    }
    const double mean = covered ? sum / covered : 0;
    printf ("    %d px covered, %d with r != b, mean r %.1f (uniform: 127.5, exponent 4: 51)\n", covered, off, mean);
    CHECK (covered > 300, "only %d px covered", covered);
    CHECK (off * 50 <= covered, "%d of %d px have r != b: the channels are drawn apart", off, covered);
    CHECK (mean > 35 && mean < 70, "mean r %.1f: the exponent isn't applied", mean);
    return true;
}

// colorn shifts the colour initializers in HSV by (colorn − the system's reference colour) (unpatched: an RGB
// multiply): a red system with colorn blue turns blue (was black); colorn equal to a grey system's own colour
// leaves it (was grey²); a system without a colour source takes colorn as its colour
static bool particle_colorn_hsv_shift () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string still = ",\"distancemin\":0,\"distancemax\":0,\"rate\":10";
    const std::string life = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    const std::string red = particle_system ("opaque", ",\"maxcount\":50", still,
        "{\"name\":\"colorrandom\",\"min\":\"255 0 0\",\"max\":\"255 0 0\"}," + life);
    const std::string grey = particle_system ("opaque", ",\"maxcount\":50", still,
        "{\"name\":\"colorrandom\",\"min\":\"128 128 128\",\"max\":\"128 128 128\"}," + life);
    const std::string plain = particle_system ("opaque", ",\"maxcount\":50", still, life);
    std::vector<std::string> files;
    const std::string dir = particle_scene (
        particle_object (1, "red.json", 8, 16, "\"colorn\":\"0 0 1\"") + "," + particle_object (2, "grey.json", 24, 16, "\"colorn\":\"0.5 0.5 0.5\"")
            + "," + particle_object (3, "plain.json", 40, 16, "\"colorn\":\"1 0 0\"") + "," + particle_object (4, "red.json", 56, 16),
        "0 0 0", { { "red.json", red }, { "grey.json", grey }, { "plain.json", plain } }, files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 10; i++) {
        rig.step ();
    }
    unsigned char px[4][4] = {};
    for (int i = 0; i < 4; i++) {
        read_pixel (rig.fbo, 8 + 16 * i, 16, px[i]);
    }
    printf ("    red + colorn blue: %d %d %d; grey 128 + colorn 0.5: %d %d %d; no colour + colorn red: %d %d %d; red: %d %d %d\n",
            px[0][0], px[0][1], px[0][2], px[1][0], px[1][1], px[1][2], px[2][0], px[2][1], px[2][2], px[3][0], px[3][1], px[3][2]);
    CHECK (px[0][0] < 8 && px[0][1] < 8 && px[0][2] > 247, "red shifted to colorn blue: %d %d %d", px[0][0], px[0][1], px[0][2]);
    CHECK (std::abs (px[1][0] - 128) <= 2 && std::abs (px[1][2] - 128) <= 2, "grey at its reference: %d %d %d", px[1][0], px[1][1], px[1][2]);
    CHECK (px[2][0] > 247 && px[2][1] < 8 && px[2][2] < 8, "colorn as the colour: %d %d %d", px[2][0], px[2][1], px[2][2]);
    CHECK (px[3][0] > 247 && px[3][1] < 8 && px[3][2] < 8, "untinted red: %d %d %d", px[3][0], px[3][1], px[3][2]);
    return true;
}

// a hidden system with particles is reset (WE resets when it has any): shown again, its one-shot burst replays, with
// new lifetimes (unpatched: it froze, and the old burst died on its old schedule); a `count` bound to a user
// property is live (unpatched: taken once, as the pool size)
static bool particle_hide_resets_and_overrides_live () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string grey = "{\"name\":\"colorrandom\",\"min\":\"4 4 4\",\"max\":\"4 4 4\"}";
    const std::string burst = particle_system ("add", ",\"maxcount\":100", ",\"distancemin\":0,\"distancemax\":0,\"rate\":0,\"instantaneous\":5",
        grey + ",{\"name\":\"lifetimerandom\",\"min\":2,\"max\":2}");
    const std::string steady = particle_system ("add", ",\"maxcount\":100", ",\"distancemin\":0,\"distancemax\":0,\"rate\":10",
        grey + ",{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}");
    std::vector<std::string> files;
    std::string burstObject = particle_object (1, "burst.json", 16, 16);
    burstObject.insert (burstObject.size () - 1, ",\"visible\":{\"user\":\"show\",\"value\":true}");
    const std::string dir = particle_scene (burstObject + "," + particle_object (2, "steady.json", 48, 16, "\"count\":{\"user\":\"cnt\",\"value\":1}"),
        "0 0 0", { { "burst.json", burst }, { "steady.json", steady } }, files);
    write_file (dir + "/project.json", "{\"title\":\"particles\",\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{\"properties\":{"
                                       "\"show\":{\"type\":\"bool\",\"value\":true,\"text\":\"s\"},"
                                       "\"cnt\":{\"type\":\"slider\",\"value\":1,\"min\":0,\"max\":5,\"text\":\"c\"}}}}\n");
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    auto stack = [&] (int x) {
        unsigned char px[4] = { 0, 0, 0, 0 };
        read_pixel (rig.fbo, x, 16, px);
        return px[0] / 4.0;
    };
    rig.step ();
    rig.step ();
    const double burst0 = stack (16);
    while (rig.frames < 32) {
        rig.step ();
    }
    const double burstAlive = stack (16), steady1 = stack (48);
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "show", false), "bool refused");
    rig.step ();
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "show", true), "bool refused");
    CHECK (wp_project_property_set_slider_by_name (rig.p, "cnt", 3.0f), "slider refused");
    while (rig.frames < 63) {
        rig.step ();
    }
    const double steady2 = stack (48);
    while (rig.frames < 83) {
        rig.step ();
    }
    const double burstAgain = stack (16);
    printf ("    burst (2 s lives): %.1f, at 1 s %.1f, hidden + shown, at 2.7 s %.1f; count 1 for 1 s: %.1f, then count 3 for 1 s: %.1f\n",
            burst0, burstAlive, burstAgain, steady1, steady2);
    CHECK (burst0 >= 4.5 && burst0 <= 5.5, "the burst: %.1f", burst0);
    CHECK (burstAlive >= 4.5 && burstAlive <= 5.5, "the burst at 1 s: %.1f", burstAlive);
    CHECK (burstAgain >= 4.5 && burstAgain <= 5.5, "shown again at 1.1 s, the burst didn't replay (alive at 2.7 s: %.1f)", burstAgain);
    CHECK (steady2 - steady1 >= 26 && steady2 - steady1 <= 33, "count 3 for ~1 s added %.1f (want ~30)", steady2 - steady1);
    return true;
}

// B11 (docs/player/spikes/we-lwe-gap-audit.md P15, P22, P28, P32, P33): the operators as WE's interpreter (GH 0x140265800)
// runs them. A 64x32 scene of three systems, read on its centre row:
//   x 8:  two alphachange 0.5 → 0.5 on a white particle compose to 0.25 (unpatched: the second overwrote, 0.5)
//   x 26: box particles 10 px either side of a control point with threshold 15 are pulled in (unpatched: half the
//         threshold, so they stayed at x 16 and 36)
//   x 50: sizerandom 8 with size override 2 and a sizechange 1 → 1 is 16 px wide (the override twice; unpatched 8)
// and a second scene: a box particle 4 px out with speedmin = speedmax 40 leaves its spawn point (unpatched: at rest)
static bool particle_operators_as_we () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string white = "{\"name\":\"colorrandom\",\"min\":\"255 255 255\",\"max\":\"255 255 255\"}";
    const std::string life = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    const std::string one = ",\"distancemin\":0,\"distancemax\":0,\"rate\":0,\"instantaneous\":1";
    auto box = [&] (const char* distance, const char* speed, int count, const std::string& top, const std::string& ops) {
        return std::string ("{\"material\":\"materials/opaque.json\",\"maxcount\":10") + top
             + ",\"emitter\":[{\"name\":\"boxrandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 1\",\"distancemin\":\""
             + distance + "\",\"distancemax\":\"" + distance + "\"" + speed + ",\"rate\":0,\"instantaneous\":"
             + std::to_string (count) + "}],\"initializer\":[{\"name\":\"sizerandom\",\"min\":4,\"max\":4}," + white
             + "," + life + "],\"operator\":[" + ops + "]}\n";
    };
    std::string halves = particle_system ("opaque", ",\"maxcount\":5", one, white + "," + life);
    halves.insert (halves.rfind ('}'), ",\"operator\":[{\"name\":\"alphachange\",\"startvalue\":0.5,\"endvalue\":0.5},"
                                        "{\"name\":\"alphachange\",\"startvalue\":0.5,\"endvalue\":0.5}]");
    const std::string pulled = box ("10 0 0", "", 6, ",\"controlpoint\":[{\"id\":0,\"offset\":\"0 0 0\"}]",
        "{\"name\":\"movement\",\"drag\":3},{\"name\":\"controlpointattract\",\"controlpoint\":0,\"scale\":600,\"threshold\":15}");
    std::string sized = particle_system ("opaque", ",\"maxcount\":5", one, white + "," + life);
    sized.replace (sized.find ("\"min\":12,\"max\":12"), 17, "\"min\":8,\"max\":8");
    sized.insert (sized.rfind ('}'), ",\"operator\":[{\"name\":\"sizechange\",\"startvalue\":1,\"endvalue\":1}]");
    std::vector<std::string> files;
    const std::string dir = particle_scene (
        particle_object (1, "halves.json", 8, 16) + "," + particle_object (2, "pulled.json", 26, 16) + ","
            + particle_object (3, "sized.json", 50, 16, "\"size\":2"),
        "0 0 0", { { "halves.json", halves }, { "pulled.json", pulled }, { "sized.json", sized } }, files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 30; i++) {
        rig.step ();
    }
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, 8, 16, px);
    const int halvesRed = px[0];
    // the pulled particles: lit columns of the centre row near their spawn points (x 14-18, 34-38) and at the point
    int atSpawn = 0, atPoint = 0;
    for (int x = 14; x <= 38; x++) {
        read_pixel (rig.fbo, x, 16, px);
        const bool lit = px[0] > 64;
        atSpawn += lit && (x <= 18 || x >= 34);
        atPoint += lit && x >= 22 && x <= 30;
    }
    int sizedWidth = 0;
    for (int x = 38; x < 64; x++) {
        read_pixel (rig.fbo, x, 16, px);
        sizedWidth += px[0] > 64;
    }
    printf ("    two alphachange 0.5: red %d (want ~64); pulled particles: %d px lit at their spawn points, %d px at the "
            "point; sizechange + size 2: %d px wide (want 16)\n",
            halvesRed, atSpawn, atPoint, sizedWidth);
    CHECK (halvesRed >= 54 && halvesRed <= 74, "two alphachange 0.5 compose to %d/255", halvesRed);
    CHECK (atSpawn == 0 && atPoint > 0, "the particles weren't pulled to the point (%d px at the spawn points, %d at it)",
           atSpawn, atPoint);
    CHECK (sizedWidth >= 15 && sizedWidth <= 17, "sizechange with size 2: %d px", sizedWidth);

    std::vector<std::string> files2;
    const std::string dir2 = particle_scene (particle_object (1, "boxed.json", 32, 16), "0 0 0",
        { { "boxed.json", box ("4 0 0", ",\"speedmin\":40,\"speedmax\":40", 1, "", "{\"name\":\"movement\"}") } }, files2);
    ScriptRig rig2;
    CHECK (particle_rig_open (rig2, dir2, files2), "load/build of %s failed", dir2.c_str ());
    for (int i = 0; i < 15; i++) {
        rig2.step ();
    }
    int nearSpawn = 0, out = 0;
    for (int x = 0; x < 64; x++) {
        read_pixel (rig2.fbo, x, 16, px);
        const bool lit = px[0] > 64;
        nearSpawn += lit && x >= 24 && x <= 40;
        out += lit && (x < 24 || x > 40);
    }
    printf ("    box particle with speed 40 after 0.5 s: %d px lit within 8 px of the centre, %d px further out\n", nearSpawn, out);
    CHECK (nearSpawn == 0 && out > 0, "the box particle didn't move out (%d px near the centre, %d out)", nearSpawn, out);
    return true;
}

// B11 (P2): child systems. WE parses `children` into child templates (parser 0x1401fe52a) and runs them: a static one
// always, event ones per particle event (GH 0x14025cfe0, 0x14025c2e0), each in its parent's space at its origin plus,
// for an event child, its particle's position. Unpatched, `children` was parsed and nothing read it. Rows of a 64x32
// scene (white 2 px child particles that never move; the parents' own particles are black; object y is WE's, up):
//   y 8:  a static child with origin "12 0 0" of a system at x 8: lit at x 20
//   y 16: a parent particle moving right at 20 px/s from x 10 with an eventfollow child emitting 30/s: a trail
//   y 24: a parent particle living 0.3 s at x 48 with an eventdeath child (one particle): lit at x 48 after it died;
//         a second, moving parent from x 4 with an eventspawn child: lit only where it spawned
static bool particle_children_run () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string white = "{\"name\":\"colorrandom\",\"min\":\"255 255 255\",\"max\":\"255 255 255\"}";
    const std::string black = "{\"name\":\"colorrandom\",\"min\":\"0 0 0\",\"max\":\"0 0 0\"}";
    auto sys = [] (const std::string& top, const char* rate, const char* instantaneous, const std::string& inits,
                   const std::string& extra) {
        return std::string ("{\"material\":\"materials/opaque.json\",\"maxcount\":100") + top
             + ",\"emitter\":[{\"name\":\"sphererandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 0\",\"distancemin\":0,"
               "\"distancemax\":0,\"rate\":" + rate + ",\"instantaneous\":" + instantaneous + "}],"
             + "\"initializer\":[{\"name\":\"sizerandom\",\"min\":4,\"max\":4}," + inits + "]" + extra + "}\n";
    };
    const std::string life = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    const std::string dot = sys ("", "0", "1", white + "," + life, "");
    const std::string trail = sys ("", "30", "0", white + "," + life, "");
    const std::string moving = ",{\"name\":\"velocityrandom\",\"min\":\"20 0 0\",\"max\":\"20 0 0\"}";
    const std::string staticParent = sys (",\"children\":[{\"name\":\"particles/dot.json\",\"origin\":\"12 0 0\"}]", "0", "0", black + "," + life, "");
    const std::string followParent = sys (",\"children\":[{\"name\":\"particles/trail.json\",\"type\":\"eventfollow\"}]", "0", "1",
        black + "," + life + moving, ",\"operator\":[{\"name\":\"movement\"}]");
    const std::string deathParent = sys (",\"children\":[{\"name\":\"particles/dot.json\",\"type\":\"eventdeath\"}]", "0", "1",
        black + ",{\"name\":\"lifetimerandom\",\"min\":0.3,\"max\":0.3}", "");
    const std::string spawnParent = sys (",\"children\":[{\"name\":\"particles/trail.json\",\"type\":\"eventspawn\"}]", "0", "1",
        black + "," + life + moving, ",\"operator\":[{\"name\":\"movement\"}]");
    std::vector<std::string> files;
    const std::string dir = particle_scene (
        particle_object (1, "static.json", 8, 24) + "," + particle_object (2, "follow.json", 10, 16) + ","
            + particle_object (3, "death.json", 48, 8) + "," + particle_object (4, "spawn.json", 4, 8),
        "0 0 0",
        { { "dot.json", dot }, { "trail.json", trail }, { "static.json", staticParent }, { "follow.json", followParent },
          { "death.json", deathParent }, { "spawn.json", spawnParent } },
        files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 30; i++) {
        rig.step ();
    }
    unsigned char px[4] = { 0, 0, 0, 0 };
    auto lit = [&] (int x, int y) {
        read_pixel (rig.fbo, x, y, px);
        return px[0] > 128;
    };
    const bool staticLit = lit (20, 8);
    int trailFrom = -1, trailTo = -1;
    for (int x = 0; x < 64; x++) {
        if (lit (x, 16)) {
            trailFrom = trailFrom < 0 ? x : trailFrom;
            trailTo = x;
        }
    }
    const bool deathLit = lit (48, 24);
    int spawnLit = 0;
    for (int x = 0; x < 32; x++) {
        spawnLit += lit (x, 24);
    }
    printf ("    static child at x 20: %s; follow trail lit x %d..%d (the parent went 10 → ~30); death child at x 48: %s; "
            "spawn child: %d px lit on row 24 left of x 32 (want its spawn point only, ~4)\n",
            staticLit ? "lit" : "dark", trailFrom, trailTo, deathLit ? "lit" : "dark", spawnLit);
    CHECK (staticLit, "the static child isn't drawn");
    CHECK (trailFrom >= 6 && trailFrom <= 10 && trailTo >= 24 && trailTo <= 34, "the follow trail spans x %d..%d", trailFrom, trailTo);
    CHECK (deathLit, "the death child isn't drawn");
    CHECK (spawnLit >= 2 && spawnLit <= 6, "the spawn child covers %d px", spawnLit);
    return true;
}

// B11 (P10, P34, P35): control points. Systems whose sphererandom emitter spawns at control point 1, read on the centre
// row of a 64x32 scene:
//   x 8:  control point 1's offset 0 0 0, instanceoverride controlpoint1 "12 0 0": spawns at x 20 (unpatched: x 8,
//         the override wasn't read)
//   x 40 (scale 2): control point 1 in the scene's space (flags 2) at "56 16": spawns at x 56 whatever the system's
//         scale (unpatched: the offset was read as centred and not unscaled, x 136)
// and control point 1 offset "0 8 0" lands where an emitter origin "0 8 0" does (both are WE's y-up particle space;
// unpatched the control point went the other way)
static bool particle_control_points () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string white = "{\"name\":\"colorrandom\",\"min\":\"255 255 255\",\"max\":\"255 255 255\"}";
    const std::string life = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    auto sys = [&] (const std::string& cp1, const char* origin) {
        return std::string ("{\"material\":\"materials/opaque.json\",\"maxcount\":5,\"controlpoint\":[{\"id\":0},") + cp1 + "],"
             + "\"emitter\":[{\"name\":\"sphererandom\",\"origin\":\"" + origin + "\",\"directions\":\"1 1 0\",\"distancemin\":0,"
               "\"distancemax\":0,\"rate\":0,\"instantaneous\":1,\"controlpoint\":1}],"
             + "\"initializer\":[{\"name\":\"sizerandom\",\"min\":4,\"max\":4}," + white + "," + life + "]}\n";
    };
    const std::string overridden = sys ("{\"id\":1,\"offset\":\"0 0 0\"}", "0 0 0");
    const std::string world = sys ("{\"id\":1,\"flags\":2,\"offset\":\"56 16 0\"}", "0 0 0");
    const std::string up = sys ("{\"id\":1,\"offset\":\"0 8 0\"}", "0 0 0");
    const std::string upOrigin = sys ("{\"id\":1,\"offset\":\"0 0 0\"}", "0 8 0");
    std::vector<std::string> files;
    std::string scaled = particle_object (2, "world.json", 40, 16);
    scaled.replace (scaled.find ("\"scale\":\"1 1 1\""), 15, "\"scale\":\"2 2 1\"");
    const std::string dir = particle_scene (
        particle_object (1, "over.json", 8, 16, "\"controlpoint1\":\"12 0 0\"") + "," + scaled + ","
            + particle_object (3, "up.json", 28, 16) + "," + particle_object (4, "uporigin.json", 34, 16),
        "0 0 0", { { "over.json", overridden }, { "world.json", world }, { "up.json", up }, { "uporigin.json", upOrigin } },
        files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 10; i++) {
        rig.step ();
    }
    unsigned char px[4] = { 0, 0, 0, 0 };
    auto lit = [&] (int x, int y) {
        read_pixel (rig.fbo, x, y, px);
        return px[0] > 128;
    };
    // the up pair: the row each is lit on, in column 28 and 34
    auto rowOf = [&] (int x) {
        for (int y = 0; y < 32; y++) {
            if (lit (x, y)) {
                return y;
            }
        }
        return -1;
    };
    const bool overAt20 = lit (20, 16), overAt8 = lit (8, 16), worldAt56 = lit (56, 16);
    const int upRow = rowOf (28), originRow = rowOf (34);
    printf ("    controlpoint1 override: x 20 %s, x 8 %s; scene-space point at x 56 of a scale-2 system: %s; control "
            "point \"0 8 0\" on row %d, emitter origin \"0 8 0\" on row %d\n",
            overAt20 ? "lit" : "dark", overAt8 ? "lit" : "dark", worldAt56 ? "lit" : "dark", upRow, originRow);
    CHECK (overAt20 && !overAt8, "the controlpoint1 override isn't where the particle spawns");
    CHECK (worldAt56, "the scene-space control point isn't at x 56");
    CHECK (upRow >= 0 && std::abs (upRow - originRow) <= 1, "control point up (row %d) vs origin up (row %d)", upRow, originRow);
    return true;
}

// B12: puppet warp (docs/player/spikes/we-lwe-gap-audit.md G06-G09), decoded from wallpaper64.exe 2.8.485: the MDL
// loader GH 0x1402873f0, the layer clock GH 0x1401d6a00, the mixing GH 0x140228470 (normal GH 0x140223b90, additive
// GH 0x140224390), the attachment transform GH 0x1401b5170

// an .mdl file written field by field
struct MdlWriter {
    std::string out;
    MdlWriter& u8 (unsigned v) { out.push_back (static_cast<char> (v)); return *this; }
    MdlWriter& u16 (unsigned v) { out.append (reinterpret_cast<const char*> (&v), 2); return *this; }
    MdlWriter& u32 (uint32_t v) { out.append (reinterpret_cast<const char*> (&v), 4); return *this; }
    MdlWriter& f32 (float v) { out.append (reinterpret_cast<const char*> (&v), 4); return *this; }
    MdlWriter& str (const std::string& s) { out += s; out.push_back ('\0'); return *this; }
    MdlWriter& identity () {
        for (int i = 0; i < 16; i++) {
            f32 (i % 5 == 0 ? 1.0f : 0.0f);
        }
        return *this;
    }
    // a section: its tag, the offset of its end, then `body`
    MdlWriter& section (const std::string& tag, const std::string& body) {
        str (tag);
        u32 (static_cast<uint32_t> (out.size () + 4 + body.size ()));
        out += body;
        return *this;
    }
};

// a 4 x 4 square centred on the mesh's origin, every vertex on bone 0. MDLV0016 has format 0x1800009 (position,
// blend indices, weights, uv: 52 B) and 16-bit indices; MDLV0023 here 0x180000f (+ normal, tangent: 80 B) and 32-bit
static std::string puppet_mesh (int version) {
    const bool v23 = version == 23;
    const uint32_t format = v23 ? 0x180000f : 0x1800009;
    MdlWriter w;
    w.str (v23 ? "MDLV0023" : "MDLV0016").u32 (0x1800009).u32 (1).u32 (1).str ("materials/puppet.json");
    w.u32 (v23 ? 1 : 0); // flags: bit 0 = 32-bit indices
    if (v23) {
        for (int i = 0; i < 6; i++) {
            w.f32 (0.0f);
        }
    }
    w.u32 (format);
    MdlWriter verts;
    const float corners[4][2] = { { -2, -2 }, { 2, -2 }, { 2, 2 }, { -2, 2 } };
    for (const auto& c : corners) {
        verts.f32 (c[0]).f32 (c[1]).f32 (0.0f);
        if (v23) {
            verts.f32 (0).f32 (0).f32 (1).f32 (1).f32 (0).f32 (0).f32 (1);
        }
        verts.u32 (0).u32 (0).u32 (0).u32 (0).f32 (1).f32 (0).f32 (0).f32 (0);
        verts.f32 (0.5f).f32 (0.5f);
    }
    w.u32 (static_cast<uint32_t> (verts.out.size ()));
    w.out += verts.out;
    const unsigned tris[6] = { 0, 1, 2, 0, 2, 3 };
    w.u32 (v23 ? 24 : 12);
    for (unsigned t : tris) {
        v23 ? w.u32 (t) : w.u16 (t);
    }
    if (v23) {
        w.u8 (0).u8 (0).u32 (0);
    }
    return w.out;
}

// one root bone at the origin
static std::string puppet_skeleton (int version) {
    MdlWriter b;
    b.u32 (1).str ("").u32 (1).u32 (0xffffffff).u32 (64).identity ().str ("");
    if (version >= 2) {
        b.u16 (0).u8 (0).u32 (0);
    }
    return b.out;
}

// animations moving the bone to (x, 0) in both of their 2 samples: (id, x)
static std::string puppet_animations (int version, const std::vector<std::pair<int, float>>& anims,
                                      const std::vector<std::pair<uint32_t, std::string>>& events = {}) {
    MdlWriter a;
    a.u32 (static_cast<uint32_t> (anims.size ()));
    for (const auto& [id, x] : anims) {
        a.u32 (id).u32 (0).str ("anim").str ("loop").f32 (1.0f).u32 (1).u32 (0).u32 (1);
        a.u32 (0).u32 (72);
        for (int k = 0; k < 2; k++) {
            a.f32 (x).f32 (0).f32 (0).f32 (0).f32 (0).f32 (0).f32 (1).f32 (1).f32 (1);
        }
        if (version > 2) {
            a.u32 (0).u8 (0);
        }
        if (version > 3) {
            a.u8 (0);
        }
        if (version > 4) {
            for (int i = 0; i < 6; i++) {
                a.u32 (0);
            }
        }
        if (version > 5) {
            a.u8 (0);
        }
        a.u32 (static_cast<uint32_t> (events.size ())); // events: a frame, a name
        for (const auto& [frame, name] : events) {
            a.u32 (frame).str (name);
        }
    }
    return a.out;
}

// two 32 x 32 puppets on a 64 x 32 scene (y up). Layer 1 (MDLV0016, at x 16) plays one animation that moves its
// bone 8 px right: its 4 px square covers x 22..25. Layer 2 (MDLV0023, at x 48) has a normal layer to +4 and an
// additive layer to +8 at blend 0.5: +4 + 4 = +8, x 54..57. Its attachment "tip" sits on the bone; the black 4 px
// square pinned to it 8 px up follows: x 54..57, rows 6..9. Neither has an effect, so each draws straight to the
// scene. Unpatched: MDLV0016 was rejected (the whole 32 px quad), the MDLV0023 mesh was misread (nothing drawn) and
// the attached square sat on the parent's origin (x 46..49)
static bool puppet_warp_as_we () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string material = "{\"passes\":[{\"shader\":\"genericimage2\",\"blending\":\"translucent\",\"depthtest\":"
                                 "\"disabled\",\"depthwrite\":\"disabled\",\"cullmode\":\"nocull\",\"textures\":[\"util/white\"]}]}\n";
    MdlWriter a;
    a.out = puppet_mesh (16);
    a.section ("MDLS0001", puppet_skeleton (1)).section ("MDLA0001", puppet_animations (1, { { 7, 8.0f } }));
    MdlWriter b;
    b.out = puppet_mesh (23);
    MdlWriter attach;
    attach.u16 (1).u16 (0).str ("tip").identity ();
    b.section ("MDLS0004", puppet_skeleton (4)).section ("MDAT0001", attach.out)
        .section ("MDLA0006", puppet_animations (6, { { 1, 4.0f }, { 2, 8.0f } }));

    const std::string objects
        = "{\"id\":1,\"name\":\"a\",\"image\":\"models/pa.json\",\"origin\":\"16 16 0\",\"size\":\"32 32\","
          "\"animationlayers\":[{\"id\":10,\"animation\":7,\"rate\":1,\"blend\":1,\"visible\":true}]},"
          "{\"id\":2,\"name\":\"b\",\"image\":\"models/pb.json\",\"origin\":\"48 16 0\",\"size\":\"32 32\","
          "\"animationlayers\":[{\"id\":11,\"animation\":1,\"blend\":1,\"additive\":false},"
          "{\"id\":12,\"animation\":2,\"blend\":0.5,\"additive\":true}]},"
          "{\"id\":3,\"name\":\"c\",\"image\":\"models/util/solidlayer.json\",\"size\":\"4 4\",\"color\":\"1 1 1\","
          "\"origin\":\"0 8 0\",\"parent\":2,\"attachment\":\"tip\"}";
    const std::string dir = script_scene (objects);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/materials/puppet.json", material);
    write_file (dir + "/models/pa.json", "{\"material\":\"materials/puppet.json\",\"puppet\":\"models/pa.mdl\"}\n");
    write_file (dir + "/models/pb.json", "{\"material\":\"materials/puppet.json\",\"puppet\":\"models/pb.mdl\"}\n");
    write_file (dir + "/models/pa.mdl", a.out);
    write_file (dir + "/models/pb.mdl", b.out);
    ScriptRig rig;
    rig.extra = { "materials/puppet.json", "models/pa.json", "models/pb.json", "models/pa.mdl", "models/pb.mdl" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 4; i++) {
        rig.step ();
    }
    auto lit = [&] (int x, int y) {
        unsigned char px[4] = { 0, 0, 0, 0 };
        read_pixel (rig.fbo, x, y, px);
        return px[0] > 128;
    };
    auto span = [&] (int y, int from, int to) {
        std::string s;
        for (int x = from; x <= to; x++) {
            s += lit (x, y) ? '#' : '.';
        }
        return s;
    };
    if (getenv ("SCRIPT_TEST_DEBUG")) {
        for (int y = 0; y < 32; y++) {
            std::string line;
            for (int x = 0; x < 64; x++) {
                unsigned char px[4] = { 0, 0, 0, 0 };
                read_pixel (rig.fbo, x, y, px);
                line += px[0] > 128 ? '#' : px[2] < 64 ? 'o' : '.';
            }
            printf ("    %2d %s\n", y, line.c_str ());
        }
    }
    printf ("    row 16 x 0..31: %s, x 32..63: %s\n", span (16, 0, 31).c_str (), span (16, 32, 63).c_str ());
    auto dark = [&] (int x, int y) {
        unsigned char px[4] = { 0, 0, 0, 0 };
        read_pixel (rig.fbo, x, y, px);
        return px[2] < 64;
    };
    CHECK (lit (24, 16) && !lit (5, 16) && !lit (16, 16), "MDLV0016 puppet isn't the skinned 4 px square at x 22..25");
    CHECK (lit (55, 16) && lit (56, 16) && !lit (47, 16) && !lit (51, 16), "normal + additive layers aren't at +8 (x 54..57)");
    CHECK (dark (55, 7) && !dark (47, 7), "the attached square doesn't follow the bone (x 54..57, rows 6..9)");
    return true;
}

// B5: parallax and camera (docs/player/spikes/we-lwe-gap-audit.md G10-G12, G14/E1, G15-G19), decoded from
// wallpaper64.exe 2.8.485: the camera update GH 0x1401b8af0, the per-object offset in the render loop GH 0x1401b9b50,
// the shake GH 0x1401c7680, the zoom in the scene tick GH 0x1401afbf0. The pointer is native scene px, y down

static double g_mouseX = 0.0, g_mouseY = 0.0;
static double mouse_x (void*) { return g_mouseX; }
static double mouse_y (void*) { return g_mouseY; }
static int mouse_pressed (void*, int) { return 0; }
static wp_mouse_input g_mouse = { .user_parameter = nullptr, .get_x = mouse_x, .get_y = mouse_y, .is_pressed = mouse_pressed };

// a 64x32 scene like script_scene, with more `general` members and the project's properties
static std::string camera_scene (const std::string& general, const std::string& objects, const std::string& properties = "") {
    char tmpl[] = "/tmp/lwe-camera-scene.XXXXXX";
    const char* dir = mkdtemp (tmpl);
    if (!dir) {
        return {};
    }
    const std::string d = dir;
    write_file (d + "/project.json", "{\"title\":\"camera\",\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{\"properties\":{"
                                     + properties + "}}}\n");
    write_file (d + "/scene.json", "{\"camera\":{\"center\":\"0 0 -1\",\"eye\":\"0 0 0\",\"up\":\"0 1 0\"},"
                                   "\"general\":{\"clearcolor\":\"0 0 0.5\",\"orthogonalprojection\":{\"width\":64,\"height\":32},"
                                   + general + "},\"objects\":[" + objects + "]}\n");
    return d;
}

// the first covered column of a row, -1 when none
static int left_edge (const std::string& row) {
    const auto at = row.find ('#');
    return at == std::string::npos ? -1 : static_cast<int> (at);
}

// the pointer moves a layer by (origin − target) · amount · depth, the target centred at mouse influence 0;
// depth 0 stays; delay 0 snaps, a delay eases in by k = (1 − delay/3) · 10 · dt; the cameraparallax switch is read
// live and off puts the layers back (unpatched: the delay was read as a bool, k = 0, nothing ever moved; with it
// moving, a depth 0 layer moved by the amount and the target was the raw cursor)
static bool parallax_follows_the_pointer () {
    if (!script_tests_can_run ()) {
        return true;
    }
    // amount 1, influence 1, both squares on the centre row (the offset depends on the origin, so off the centre
    // row a centred pointer moves a layer in y). The depth 0.5 square at x 32: a pointer at the right edge puts the
    // target at x 64, (32 − 64) · 0.5 = −16 px. The depth 0 square at x 56 never moves
    const std::string dir = camera_scene (
        "\"cameraparallax\":{\"user\":\"par\",\"value\":true},\"cameraparallaxamount\":1,\"cameraparallaxdelay\":0,"
        "\"cameraparallaxmouseinfluence\":1",
        square (1, "\"origin\":\"56 16 0\",\"parallaxDepth\":\"0 0\"") + ","
            + square (2, "\"origin\":\"32 16 0\",\"parallaxDepth\":\"0.5 0.5\""),
        "\"par\":{\"type\":\"bool\",\"value\":true,\"text\":\"p\"}"
    );
    ScriptRig rig;
    rig.mouse = &g_mouse;
    g_mouseX = 32.0;
    g_mouseY = 16.0;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    // the depth 0.5 square's left edge (the first covered column left of the static square) and whether the static
    // square still covers exactly 52..59
    auto moving = [&rig] () { return left_edge (rig.row ().substr (0, 48)); };
    auto still = [&rig] () { return rig.row ().substr (48) == covered (52, 59).substr (48); };
    rig.step ();
    const int rest = moving ();
    const bool restStill = still ();
    g_mouseX = 64.0;
    rig.step ();
    const int right = moving ();
    const bool rightStill = still ();
    g_mouseX = 0.0;
    rig.step ();
    const int left = moving ();
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "par", false), "bool refused");
    rig.step ();
    const int off = moving ();
    printf ("    depth 0.5: rest %d, pointer right %d, left %d, parallax off %d; depth 0 still: %d %d\n", rest, right, left, off,
            restStill, rightStill);
    CHECK (restStill && rightStill, "a depth 0 layer moved");
    CHECK (rest == 28, "a centred pointer moved the layer (%d, want 28)", rest);
    CHECK (right == 12, "a pointer at the right edge put the layer at %d, want 12 (−16 px)", right);
    CHECK (left == 44, "a pointer at the left edge put the layer at %d, want 44 (+16 px)", left);
    CHECK (off == 28, "turning parallax off left the layer at %d, want 28", off);

    // delay 1.5: k = (1 − 0.5) · 10 / 30 = 1/6 per 30 fps frame
    const std::string eased = camera_scene (
        "\"cameraparallax\":true,\"cameraparallaxamount\":1,\"cameraparallaxdelay\":1.5,\"cameraparallaxmouseinfluence\":1",
        square (1, "\"origin\":\"32 16 0\",\"parallaxDepth\":\"0.5 0.5\"")
    );
    ScriptRig rig2;
    rig2.mouse = &g_mouse;
    g_mouseX = 32.0;
    CHECK (rig2.open (eased), "load/build of %s failed", eased.c_str ());
    rig2.step ();
    g_mouseX = 64.0;
    std::vector<int> edges;
    for (int i = 0; i < 6; i++) {
        rig2.step ();
        edges.push_back (left_edge (rig2.row ()));
    }
    printf ("    delay 1.5, pointer right: edges");
    bool ok = true;
    for (size_t i = 0; i < edges.size (); i++) {
        const double want = 28.0 - 16.0 * (1.0 - std::pow (5.0 / 6.0, static_cast<double> (i + 1)));
        printf (" %d (%.1f)", edges[i], want);
        ok = ok && std::abs (edges[i] - want) <= 1.0;
    }
    printf ("\n");
    CHECK (ok, "the layer didn't ease in at k = 1/6 per frame");
    return true;
}

// 3414858021 (the owner's report): a pointer-linked control point (flags 1) is where the pointer is, y down from the
// top like the host's pointer. A system whose emitter spawns at control point 0, the pointer at (16, 6): its particle
// is on the row of a reference system's at WE's world (40, 26) (unpatched: the pointer was taken y up, the particle
// at world y 6, so a trail went up when the pointer went down)
static bool particle_pointer_is_y_down () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string white = "{\"name\":\"colorrandom\",\"min\":\"255 255 255\",\"max\":\"255 255 255\"}";
    const std::string life = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    auto sys = [&] (const char* cp0, const char* emitterCp) {
        return std::string ("{\"material\":\"materials/opaque.json\",\"maxcount\":5,\"controlpoint\":[") + cp0 + "],"
             + "\"emitter\":[{\"name\":\"sphererandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 0\",\"distancemin\":0,"
               "\"distancemax\":0,\"rate\":0,\"instantaneous\":1" + emitterCp + "}],"
             + "\"initializer\":[{\"name\":\"sizerandom\",\"min\":4,\"max\":4}," + white + "," + life + "]}\n";
    };
    std::vector<std::string> files;
    const std::string dir = particle_scene (
        particle_object (1, "pointer.json", 16, 16) + "," + particle_object (2, "ref.json", 40, 26), "0 0 0",
        { { "pointer.json", sys ("{\"id\":0,\"flags\":1,\"offset\":\"0 0 0\"}", ",\"controlpoint\":0") },
          { "ref.json", sys ("{\"id\":0}", "") } },
        files);
    ScriptRig rig;
    rig.mouse = &g_mouse;
    g_mouseX = 16.0;
    g_mouseY = 6.0;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 10; i++) {
        rig.step ();
    }
    auto rowOf = [&] (int x) {
        unsigned char px[4] = { 0, 0, 0, 0 };
        for (int y = 0; y < 32; y++) {
            read_pixel (rig.fbo, x, y, px);
            if (px[0] > 128) {
                return y;
            }
        }
        return -1;
    };
    const int pointerRow = rowOf (16), referenceRow = rowOf (40);
    printf ("    pointer at y 6 (down): particle on row %d; reference at world y 26: row %d\n", pointerRow, referenceRow);
    CHECK (pointerRow >= 0 && referenceRow >= 0 && std::abs (pointerRow - referenceRow) <= 1,
           "the pointer's particle (row %d) isn't on the reference's row (%d)", pointerRow, referenceRow);
    return true;
}

// SceneScript's angles are degrees (2679248947 writes `value.z = angle * WEMath.rad2deg`), the scene's radians: a
// 4x24 bar whose angles script returns z 90 lies across (lit 10 px left and right of its centre, not above); a square
// whose scene angles are z π/2 reads thisLayer.angles.z as 90 (its alpha script returns z / 180: red ≈ 128)
// (unpatched: 90 was taken as radians, the bar at 116.6°, and the script read 1.5708, red ≈ 2)
static bool script_angles_are_degrees () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::string bar = white_square (1, scripted ("angles", "\"0 0 0\"", "export function update(value) {\n  return new Vec3(0, 0, 90);\n}")
                                         + ",\"origin\":\"16 16 0\"");
    bar.replace (bar.find ("\"size\":\"8 8\""), 12, "\"size\":\"4 24\"");
    const std::string reader = white_square (
        2, scripted ("alpha", "1", "export function update(value) {\n  return thisLayer.angles.z / 180;\n}")
               + ",\"origin\":\"48 16 0\",\"angles\":\"0 0 1.5707963\"");
    const std::string dir = script_scene (bar + "," + reader);
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 4; i++) {
        rig.step ();
    }
    unsigned char left[4] = {}, right[4] = {}, above[4] = {}, half[4] = {};
    read_pixel (rig.fbo, 6, 16, left);
    read_pixel (rig.fbo, 26, 16, right);
    read_pixel (rig.fbo, 16, 26, above);
    read_pixel (rig.fbo, 48, 16, half);
    printf ("    bar at z 90°: left %d right %d above %d; thisLayer.angles.z / 180 → red %d\n", left[0], right[0], above[0],
            half[0]);
    CHECK (left[0] > 200 && right[0] > 200 && above[0] < 60, "the bar isn't turned 90° (left %d right %d above %d)", left[0],
           right[0], above[0]);
    CHECK (near (half[0], 127.5, 6), "thisLayer.angles.z of a π/2 layer isn't 90 (red %d)", half[0]);
    return true;
}

// g_ParallaxPosition = the smoothed position over the scene size, clamped 0..1 (unpatched: never fed, 0)
static bool parallax_position_uniform () {
    if (!script_tests_can_run ()) {
        return true;
    }
    // influence 0.5, the pointer at the right edge and the top: x = 64 · (0.25 + 0.5) = 48 → 0.75,
    // y (up) = 32 · (0.25 + 0.5) → 0.75
    const std::string dir = camera_scene (
        "\"cameraparallax\":true,\"cameraparallaxamount\":1,\"cameraparallaxdelay\":0,\"cameraparallaxmouseinfluence\":0.5",
        "{\"id\":1,\"name\":\"prlx\",\"image\":\"models/c4.json\",\"size\":\"64 32\",\"origin\":\"32 16 0\",\"parallaxDepth\":\"0 0\"}"
    );
    mkdir ((dir + "/shaders").c_str (), 0755);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/shaders/c4.vert", "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\n"
                                          "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n}\n");
    write_file (dir + "/shaders/c4.frag", "uniform vec2 g_ParallaxPosition;\nvoid main() {\n\tgl_FragColor = vec4(g_ParallaxPosition, 0.0, 1.0);\n}\n");
    write_file (dir + "/materials/c4.json", "{\"passes\":[{\"shader\":\"c4\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                            "\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    write_file (dir + "/models/c4.json", "{\"material\":\"materials/c4.json\",\"solidlayer\":true}\n");
    ScriptRig rig;
    rig.mouse = &g_mouse;
    g_mouseX = 32.0;
    g_mouseY = 16.0;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    unsigned char centre[4] = { 0, 0, 0, 0 }, moved[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, 32, 16, centre);
    g_mouseX = 64.0;
    g_mouseY = 0.0;
    rig.step ();
    read_pixel (rig.fbo, 32, 16, moved);
    printf ("    centred pointer: %d %d; pointer top right: %d %d\n", centre[0], centre[1], moved[0], moved[1]);
    CHECK (near (centre[0], 127.5, 2) && near (centre[1], 127.5, 2), "a centred pointer isn't 0.5 0.5 (%d %d)", centre[0], centre[1]);
    CHECK (near (moved[0], 0.75 * 255, 2) && near (moved[1], 0.75 * 255, 2), "the top-right pointer isn't 0.75 0.75 (%d %d)",
           moved[0], moved[1]);
    return true;
}

// general.zoom scales the view about the centre, times the active camera object's zoom (the last visible one); the
// shake at speed 0 sits at cos 0 = 1: x moves by amplitude · 0.01 · the scene height (unpatched: zoom, camera objects
// and the shake were ignored)
static bool camera_zoom_and_shake () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string zoomed = camera_scene ("\"zoom\":2", square (1, "\"origin\":\"32 16 0\""));
    ScriptRig rig;
    CHECK (rig.open (zoomed), "load/build of %s failed", zoomed.c_str ());
    rig.step ();
    const std::string z2 = rig.row ();

    const std::string cams = camera_scene (
        "\"zoom\":2",
        square (1, "\"origin\":\"32 16 0\"") + ",{\"id\":2,\"name\":\"cam\",\"camera\":\"default\",\"zoom\":0.5}"
            + ",{\"id\":3,\"name\":\"off\",\"camera\":\"default\",\"zoom\":4,\"visible\":{\"user\":\"c\",\"value\":false}}",
        "\"c\":{\"type\":\"bool\",\"value\":false,\"text\":\"c\"}"
    );
    ScriptRig rig2;
    CHECK (rig2.open (cams), "load/build of %s failed", cams.c_str ());
    rig2.step ();
    const std::string withCamera = rig2.row ();
    CHECK (wp_project_property_set_boolean_by_name (rig2.p, "c", true), "bool refused");
    rig2.step ();
    const std::string lastCamera = rig2.row ();

    // amplitude 50: 32 · 0.01 · 50 = 16 px; the camera moves right, the layer left
    const std::string shaken = camera_scene (
        "\"camerashake\":true,\"camerashakespeed\":0,\"camerashakeamplitude\":50,\"camerashakeroughness\":1",
        square (1, "\"origin\":\"32 16 0\"")
    );
    ScriptRig rig3;
    CHECK (rig3.open (shaken), "load/build of %s failed", shaken.c_str ());
    rig3.step ();
    const std::string shake = rig3.row ();
    printf ("    zoom 2:         %s\n    camera 0.5:     %s\n    last camera 4:  %s\n    shake 16 px:    %s\n", z2.c_str (),
            withCamera.c_str (), lastCamera.c_str (), shake.c_str ());
    CHECK (z2 == covered (24, 39), "general.zoom 2 didn't double the square");
    CHECK (withCamera == covered (28, 35), "the camera object's zoom 0.5 didn't cancel general.zoom 2");
    CHECK (lastCamera == covered (0, 63), "the last visible camera object (zoom 4 · 2) isn't the active one");
    CHECK (shake == covered (12, 19), "the shake didn't move the view by 16 px");
    return true;
}

// ---------------------------------------------------------------------------------------------
// B6 (docs/player/spikes/we-lwe-gap-audit.md G03, G04 particles, P36, G31): the hierarchy, decoded from
// wallpaper64.exe 2.8.485: "effectively visible" GH 0x1401b50e0 (own bit AND the parent's, recursively), the image
// model matrix GH 0x1402277d0 (the object's transform times T(the alignment offset) set at GH 0x140230a80)

// a hidden parent hides its children, a group as much as an image, and live (unpatched: only the object's own
// `visible` was read, so the children of a hidden group or image drew; and an image hidden while its passes were
// built never reached the screen, so showing it later did nothing)
static bool hidden_parent_hides_children () {
    if (!script_tests_can_run ()) {
        return true;
    }
    // a hidden group (a user property) with square 1 at 8; hidden square 3 at 40 with square 4 at its −16 (24);
    // square 5 at 56 has no parent
    const std::string dir = camera_scene (
        "\"zoom\":1",
        "{\"id\":10,\"name\":\"grp\",\"origin\":\"0 0 0\",\"scale\":\"1 1 1\",\"angles\":\"0 0 0\","
        "\"visible\":{\"user\":\"grp\",\"value\":false}},"
            + square (1, "\"origin\":\"8 16 0\",\"parent\":10") + ","
            + square (3, "\"origin\":\"40 16 0\",\"visible\":false") + ","
            + square (4, "\"origin\":\"-16 0 0\",\"parent\":3") + ","
            + square (5, "\"origin\":\"56 16 0\""),
        "\"grp\":{\"type\":\"bool\",\"value\":false,\"text\":\"g\"}"
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const std::string hidden = rig.row ();
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "grp", true), "bool refused");
    rig.step ();
    const std::string shown = rig.row ();
    printf ("    group hidden: %s\n    group shown:  %s\n", hidden.c_str (), shown.c_str ());
    CHECK (hidden == covered (52, 59), "a child of a hidden parent drew (want only square 5)");
    std::string want = covered (4, 11);
    for (int x = 52; x <= 59; x++) {
        want[x] = '#';
    }
    CHECK (shown == want, "showing the group live: want %s", want.c_str ());
    return true;
}

// a particle system's origin is in its parent's space: a rotated, scaled group places it, a moving image parent
// carries it along, and a hidden group hides it (unpatched: its own origin in the scene, frozen at setup)
static bool particle_follows_its_parent () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string grey = "{\"name\":\"colorrandom\",\"min\":\"8 8 8\",\"max\":\"8 8 8\"}";
    const std::string still = particle_system ("add", ",\"maxcount\":100", ",\"distancemin\":0,\"distancemax\":0,\"rate\":10",
        grey + ",{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}");
    // group 10 at 20 16, turned 90° and scaled 2: the system at its 0 3 sits at 20 − 6 = 14. Square 20 at 48 is moved
    // to 32 by its script: its system (at 0 0) follows. Group 30 is hidden: its system at 56 16 never shows
    auto child = [] (int id, int parent, const char* origin) {
        std::string o = particle_object (id, "still.json", 0, 0);
        const std::string from = "\"origin\":\"0 0 0\"";
        o.replace (o.find (from), from.size (), std::string ("\"origin\":\"") + origin + "\"");
        o.insert (o.size () - 1, ",\"parent\":" + std::to_string (parent));
        return o;
    };
    std::vector<std::string> files;
    const std::string dir = particle_scene (
        "{\"id\":10,\"name\":\"turned\",\"origin\":\"20 16 0\",\"scale\":\"2 2 2\",\"angles\":\"0 0 1.5707964\"},"
        "{\"id\":30,\"name\":\"off\",\"origin\":\"0 0 0\",\"scale\":\"1 1 1\",\"angles\":\"0 0 0\",\"visible\":false},"
            + square (20, scripted ("origin", "\"48 16 0\"", "export function update(value) {\n  return new Vec3(32, 16, 0);\n}")) + ","
            + child (1, 10, "0 3 0") + "," + child (2, 20, "0 0 0") + "," + child (3, 30, "56 16 0"),
        "0 0 0", { { "still.json", still } }, files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    while (rig.frames < 31) {
        rig.step ();
    }
    const double turned = stacked (rig, 14, 16), moved = stacked (rig, 32, 16), left = stacked (rig, 48, 16),
                 hidden = stacked (rig, 56, 16), raw = stacked (rig, 0, 3);
    printf ("    after 1 s: turned group's child at 14: %.1f; moved parent's child at 32: %.1f, at 48: %.1f; hidden "
            "group's child: %.1f; at the raw origin 0 3: %.1f\n", turned, moved, left, hidden, raw);
    CHECK (turned >= 8 && turned <= 12.5, "the turned, scaled group's system isn't at 14 (%.1f there)", turned);
    CHECK (moved >= 8 && moved <= 12.5, "the system didn't follow its moving parent to 32 (%.1f there)", moved);
    CHECK (left < 0.5, "particles left behind at the parent's first origin (%.1f)", left);
    CHECK (hidden < 0.5, "a hidden group's system drew (%.1f)", hidden);
    return true;
}

// F9/P29: a sprite's `orientation` (WE GH 0x1401efc50 parses it, GH 0x14024fd30 turns it into g_Orientation*): a
// screen sprite faces the camera however its system is tilted, a `fixed` one lies in the plane `axis` is the normal
// of (edge-on when that is world y), a child system uses its own renderer's. Unpatched every sprite took the
// system's own axes (a tilted system's sprites foreshortened, a fixed one faced the camera, a child copied its
// parent's)
static bool sprite_orientation_as_we () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string white = "{\"name\":\"colorrandom\",\"min\":\"255 255 255\",\"max\":\"255 255 255\"}";
    const std::string life = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    auto sys = [&] (const std::string& top, const char* instantaneous) {
        return std::string ("{\"material\":\"materials/opaque.json\",\"maxcount\":10") + top
             + ",\"emitter\":[{\"name\":\"sphererandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 0\",\"distancemin\":0,"
               "\"distancemax\":0,\"rate\":0,\"instantaneous\":" + instantaneous + "}],"
             + "\"initializer\":[{\"name\":\"sizerandom\",\"min\":24,\"max\":24}," + white + "," + life + "]}\n";
    };
    const std::string flat = ",\"renderer\":[{\"name\":\"sprite\",\"orientation\":\"fixed\",\"axis\":\"0 1 0\",\"flags\":1}]";
    const std::string facing = ",\"renderer\":[{\"name\":\"sprite\",\"orientation\":\"fixed\",\"axis\":\"0 0 1\",\"flags\":1}]";
    std::string tilted = particle_object (1, "screen.json", 8, 16);
    const std::string level = "\"angles\":\"0 0 0\"";
    tilted.replace (tilted.find (level), level.size (), "\"angles\":\"1 0 0\"");
    std::vector<std::string> files;
    const std::string dir = particle_scene (
        tilted + "," + particle_object (2, "flat.json", 24, 16) + "," + particle_object (3, "parent.json", 40, 16) + ","
            + particle_object (4, "facing.json", 56, 16),
        "0 0 0",
        { { "screen.json", sys ("", "1") }, { "flat.json", sys (flat, "1") }, { "facing.json", sys (facing, "1") },
          { "parent.json", sys (",\"children\":[{\"name\":\"particles/flat.json\"}]", "0") } },
        files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 5; i++) {
        rig.step ();
    }
    auto height = [&] (int x) {
        int n = 0;
        unsigned char px[4] = { 0, 0, 0, 0 };
        for (int y = 0; y < 32; y++) {
            read_pixel (rig.fbo, x, y, px);
            n += px[0] > 128 ? 1 : 0;
        }
        return n;
    };
    const int tiltedH = height (8), flatH = height (24), childH = height (40), facingH = height (56);
    printf ("    sprite heights: screen in a system tilted 1 rad about x %d, fixed on world y %d, its child copy %d, "
            "fixed facing the camera %d\n", tiltedH, flatH, childH, facingH);
    CHECK (facingH >= 10 && facingH <= 14, "the camera-facing fixed sprite isn't 12 tall (%d)", facingH);
    CHECK (tiltedH >= 10 && tiltedH <= 14, "the tilted system's screen sprite doesn't face the camera (%d tall)", tiltedH);
    CHECK (flatH <= 1, "the fixed sprite on world y isn't edge-on (%d tall)", flatH);
    CHECK (childH <= 1, "the child system didn't use its own (fixed) renderer (%d tall)", childH);
    return true;
}

// an aligned image turns about its origin, its anchor point, not the centre of its quad (unpatched: the quad's
// centre, so a left-aligned layer turned half round stayed where it was)
static bool aligned_layer_turns_about_its_origin () {
    if (!script_tests_can_run ()) {
        return true;
    }
    // left-aligned at 24: the quad is 24..32; turned by π about 24 it is 16..24. A centred square at 48 turned by
    // π stays 44..52
    const std::string dir = script_scene (
        square (1, "\"origin\":\"24 16 0\",\"alignment\":\"left\",\"angles\":\"0 0 3.1415927\"") + ","
            + square (2, "\"origin\":\"48 16 0\",\"angles\":\"0 0 3.1415927\"")
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const std::string got = rig.row ();
    std::string want = covered (16, 23);
    for (int x = 44; x <= 51; x++) {
        want[x] = '#';
    }
    printf ("    turned by π: %s\n", got.c_str ());
    CHECK (got == want, "want %s", want.c_str ());
    return true;
}

// ---------------------------------------------------------------------------------------------
// B9 (docs/player/spikes/we-lwe-gap-audit.md): small uniform, property and shader fixes, each decoded from
// wallpaper64.exe 2.8.485 where WE's behaviour was in question.

static bool g_buttonDown = false;
static int pressed_left (void*, int button) { return g_buttonDown ? (button & WP_MOUSE_INPUT_BUTTON_LEFT) : 0; }
static wp_mouse_input g_clicker = { .user_parameter = nullptr, .get_x = mouse_x, .get_y = mouse_y, .is_pressed = pressed_left };

// a solid layer at `x` drawing `frag` (a fragment body over the given uniforms) as models/b9.json
static void b9_layer (const std::string& dir, const std::string& uniforms, const std::string& body,
                      const std::string& vertexExtra = "", const std::string& vertexBody = "") {
    mkdir ((dir + "/shaders").c_str (), 0755);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/shaders/b9.vert", "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\n" + vertexExtra
                                              + "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n"
                                              + vertexBody + "}\n");
    write_file (dir + "/shaders/b9.frag", uniforms + "void main() {\n\t" + body + "\n}\n");
    write_file (dir + "/materials/b9.json", "{\"passes\":[{\"shader\":\"b9\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                            "\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    write_file (dir + "/models/b9.json", "{\"material\":\"materials/b9.json\",\"solidlayer\":true}\n");
}

static std::string b9_object (int id, int x) {
    return "{\"id\":" + std::to_string (id) + ",\"name\":\"b9\",\"image\":\"models/b9.json\",\"size\":\"8 8\",\"origin\":\"" + std::to_string (x)
         + " 16 0\"}";
}

// WE's effect shaders are HLSL-era sources, compiled leniently where GLSL 3.30 refuses (3414858021's compose layer
// holding the girl's head failed on all four, so neither it nor anything under it was drawn): a backslash continues a
// line, a fragment unit may assign to its varyings, a vec4 times a vec2 is truncated to a vec2, and an #endif with
// no #if is dropped. A layer whose shaders use each draws red 1 (0.5 doubled) and green 0.5 (0.25 doubled)
// (unpatched: its material didn't build, the 0 0 0.5 clear shows)
static bool shaders_compile_like_hlsl () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (b9_object (1, 16));
    b9_layer (dir, "", "");
    write_file (dir + "/shaders/b9.vert", "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nvarying vec2 v_Half;\n"
                                          "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n"
                                          "\tvec4 wide = vec4(0.5, 0.25, 9.0, 9.0);\n\tvec2 scale = vec2(1.0, 1.0);\n"
                                          "\tvec2 h = wide * scale;\n\tv_Half = h;\n#if 1\n#endif\n#endif\n}\n");
    write_file (dir + "/shaders/b9.frag", "varying vec2 v_Half;\nvoid main() {\n\tv_Half *= 2.0;\n"
                                          "\tgl_FragColor = vec4(v_Half.x, \\\n\t                    v_Half.y, 0.0, 1.0);\n}\n");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, 16, 16, px);
    printf ("    the layer's centre: %d %d %d\n", px[0], px[1], px[2]);
    CHECK (near (px[0], 255, 3) && near (px[1], 127.5, 3) && px[2] < 4, "want 255 128 0, got %d %d %d", px[0], px[1], px[2]);
    return true;
}

// One layer drawn with the given units (plus `files`: {path, text} beside them); its centre pixel
static bool hlsl_layer_draws (const std::string& vert, const std::string& frag,
                              const std::vector<std::pair<std::string, std::string>>& files, int r, int g, int b) {
    const std::string dir = script_scene (b9_object (1, 16));
    b9_layer (dir, "", "");
    write_file (dir + "/shaders/b9.vert", vert);
    write_file (dir + "/shaders/b9.frag", frag);
    for (const auto& [path, text] : files) {
        write_file (dir + "/" + path, text);
    }
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, 16, 16, px);
    printf ("    the layer's centre: %d %d %d\n", px[0], px[1], px[2]);
    CHECK (near (px[0], r, 3) && near (px[1], g, 3) && near (px[2], b, 3), "want %d %d %d, got %d %d %d (the clear = the layer didn't build)",
           r, g, b, px[0], px[1], px[2]);
    return true;
}

static const char* kHlslVert = "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\n"
                               "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n}\n";

// WE pastes an include where its `#include` line is (GH 0x1401917f0), and only a line that starts with `#include`
// is one; its uniforms are declared ahead of all code (cbuffers, GH 0x140125e80). So a function above main may use
// an include's #define (3235948233's auto_sway uses common.h's M_PI there; LWE pasted includes just before main),
// an include may read a uniform the unit declares below the #include (common_blur.h samples g_Texture0), and a
// commented-out #include of a missing file is nothing. Draws 255 128 0 (unpatched: M_PI_HALF undeclared, the clear)
static bool shaders_include_in_place () {
    if (!script_tests_can_run ()) {
        return true;
    }
    return hlsl_layer_draws (
        kHlslVert,
        "#include \"b9inc.h\"\n// #include \"nowhere.h\"\n"
        "float half_of_one () { return HALF_PI_RATIO; }\n"
        "uniform float u_Red; // {\"material\":\"red\",\"default\":1}\n"
        "void main() {\n\tgl_FragColor = vec4(red_of (), half_of_one (), 0.0, 1.0);\n}\n",
        { { "shaders/b9inc.h", "#define HALF_PI_RATIO (M_HALF / 2.0)\n#define M_HALF 1.0\nfloat red_of () { return u_Red; }\n" } },
        255, 128, 0);
}

// The fragment unit's varyings are the vertex unit's outputs, with the vertex's types (WE's PS input is its
// VS_OUTPUT struct, GH 0x140125e80): a fragment declaring `varying vec2 v_T` against a vertex `varying vec4 v_T`
// reads the vec4, truncated as HLSL does where it's used as a vec2 (2846673187's audio ring; LWE linked a vec2 input
// to a vec4 output and the driver refused SPIRV-Cross's `vec2 = vec4`, C7011). Draws 255 128 0
static bool fragment_varying_takes_vertex_type () {
    if (!script_tests_can_run ()) {
        return true;
    }
    return hlsl_layer_draws (
        "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nvarying vec4 v_T;\n"
        "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n\tv_T = vec4(0.5, 0.25, 9.0, 9.0);\n}\n",
        "varying vec2 v_T;\nvoid main() {\n\tvec2 p = v_T;\n\tgl_FragColor = vec4(p * 2.0, 0.0, 1.0);\n}\n", {}, 255, 128, 0);
}

// HLSL's conversions, which FXC (WE's compiler) applies and GLSL refuses: a bool into an int, a scalar into a vector,
// a vec4 into a vec2 (an initializer, not just an operand), a float as a condition (ternary and if), a local const
// set from a uniform, a global const set from a uniform (a static const: FXC initialises it before main) — the
// library's color_grading, Simple_Audio_Bars, frame_builder, clipping_mask, oscilloscope. Draws 255 128 64
static bool hlsl_conversions_compile () {
    if (!script_tests_can_run ()) {
        return true;
    }
    return hlsl_layer_draws (
        kHlslVert,
        "uniform float u_One; // {\"material\":\"one\",\"default\":1}\n"
        "const float g_Half = u_One * 0.5;\n"
        "void main() {\n"
        "\tint hit = 0.25 < 0.5;\n"
        "\tvec3 c = 0.25;\n"
        "\tconst float local = u_One * 0.25;\n"
        "\tvec4 wide = vec4(g_Half, 0.25, 9.0, 9.0);\n"
        "\tvec2 n = wide;\n"
        "\tvec4 clip = vec4(n * 2.0, 0.0, 1.0) + vec4(0.0, 0.0, 0.0, 0.0);\n"
        "\tfloat yes = 1.0;\n"
        "\tvec4 picked = yes ? clip : vec4(0.0, 0.0, 0.0, 1.0);\n"
        "\tif (yes) { picked.b = local + c.b * 0.0; }\n"
        "\tgl_FragColor = vec4(picked.r * float(hit), picked.g, picked.b, 1.0);\n"
        "}\n",
        {}, 255, 128, 64);
}

// Names and leftovers HLSL lets through: a variable called `input` (GLSL reserves it; 3573886911's
// custom_user_texture), a user function overloading an intrinsic the header has as a macro (`float log10 (float)`,
// 2812601803's tone_mapping), WE's header macros (CASTF, the stock fur4), a function with no return on the combo
// path when nothing calls it (2821337237's shadow_map with SHADOWMASK 0), an #if a preprocessor can't read guarding
// broken code (3042492564's aa_gaussian: `#if g_Texture0Resolution.y <= 640`, false in WE), a vertex unit writing its
// attribute (3088030303's shadow) and a declared gl_ built-in (the stock shadow casters). Draws 255 128 0
static bool hlsl_names_and_leftovers_compile () {
    if (!script_tests_can_run ()) {
        return true;
    }
    return hlsl_layer_draws (
        "uniform mat4 g_ModelViewProjectionMatrix;\nuniform vec4 g_Texture0Resolution;\nattribute vec3 a_Position;\nin uint gl_InstanceID;\n"
        "void main() {\n\ta_Position.z = 0.0;\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n"
        "#if g_Texture0Resolution.y <= 640\n\tgl_Position = 0\n#endif\n}\n",
        "float log10 (float x) { return log(x) / log(10.0); }\n"
        "vec3 unused (vec2 uv) {\n#if 0\n\treturn vec3(uv, 0.0);\n#endif\n}\n"
        "void main() {\n\tfloat input = log10 (10.0);\n\tvec2 two = log10 (vec2(10.0, 10.0));\n"
        "\tgl_FragColor = vec4(input * CASTF(1), two.y * 0.5, 0.0, 1.0);\n}\n",
        {}, 255, 128, 0);
}

// WPENGINE_HEALTH=<path>: the core writes what it built and what it left out as JSON lines — a layer whose shaders
// don't compile is `dropped` (its glslang error a `shader_error` naming the layer and shader), a script that throws is a
// `script_error` with its layer and property, and each drawn layer's canvas bbox (y down) at frame 1 is in `layers`, so a
// layer placed off the canvas shows. Unset, nothing is written (unpatched: no such switch, the file stays empty)
static std::vector<std::string> health_lines (const std::string& path) {
    std::vector<std::string> out;
    std::istringstream in (read_file (path));
    for (std::string line; std::getline (in, line);) {
        if (!line.empty ()) {
            out.push_back (line);
        }
    }
    return out;
}

static const std::string* health_find (const std::vector<std::string>& lines, std::initializer_list<const char*> parts) {
    for (const auto& line : lines) {
        bool all = true;
        for (const char* part : parts) {
            all = all && line.find (part) != std::string::npos;
        }
        if (all) {
            return &line;
        }
    }
    return nullptr;
}

static bool health_reports_what_was_dropped () {
    if (!script_tests_can_run ()) {
        return true;
    }
    // 1: a drawn square, its centre at WE's (16, 8) — canvas rows 20..28 (y down); 2: a layer whose fragment shader
    // doesn't parse; 3: a square off the canvas (x 200); 4: a square whose origin script throws
    const std::string objects = "{\"id\":1,\"name\":\"good\",\"image\":\"models/b9.json\",\"size\":\"8 8\",\"origin\":\"16 8 0\"},"
                                "{\"id\":2,\"name\":\"broken\",\"image\":\"models/c4.json\",\"size\":\"8 8\",\"origin\":\"40 16 0\"},"
                                "{\"id\":3,\"name\":\"away\",\"image\":\"models/b9.json\",\"size\":\"8 8\",\"origin\":\"200 16 0\"},"
                              + square (4, scripted ("origin", "\"48 16 0\"", "export function update(value) {\n  return value.nothing.here;\n}"));
    const std::string dir = script_scene (objects);
    b9_layer (dir, "", "gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);");
    write_file (dir + "/shaders/c4.vert", "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\n"
                                          "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n}\n");
    write_file (dir + "/shaders/c4.frag", "void main() {\n\tgl_FragColor = vec4(1.0, 0.0, 0.0, 1.0) +;\n}\n");
    write_file (dir + "/materials/c4.json", "{\"passes\":[{\"shader\":\"c4\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                            "\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    write_file (dir + "/models/c4.json", "{\"material\":\"materials/c4.json\",\"solidlayer\":true}\n");

    const std::string path = dir + "/health.jsonl";
    setenv ("WPENGINE_HEALTH", path.c_str (), 1);
    std::vector<std::string> lines;
    {
        ScriptRig rig;
        const bool opened = rig.open (dir);
        unsetenv ("WPENGINE_HEALTH");
        CHECK (opened, "load/build of %s failed", dir.c_str ());
        rig.step ();
        lines = health_lines (path);
        printf ("    %zu health lines\n", lines.size ());
        if (getenv ("HEALTH_TEST_DEBUG")) {
            for (const auto& line : lines) {
                printf ("    %s\n", line.c_str ());
            }
        }
        CHECK (health_find (lines, { "\"ev\":\"scene\"", "\"objects\":4", "\"width\":64" }), "no scene record");
        CHECK (health_find (lines, { "\"ev\":\"object\"", "\"object\":1,", "\"built\":true" }), "layer 1 not reported built");
        CHECK (health_find (lines, { "\"ev\":\"object\"", "\"object\":2,", "\"built\":false" }), "layer 2 not reported unbuilt");
        CHECK (health_find (lines, { "\"ev\":\"dropped\"", "\"object\":2,", "\"object_name\":\"broken\"", "\"reason\":" }),
               "layer 2's drop has no reason");
        CHECK (health_find (lines, { "\"ev\":\"shader_error\"", "\"object\":2,", "\"shader\":\"c4\"", "\"unit\":\"fragment\"" }),
               "layer 2's shader error isn't attributed");
        CHECK (health_find (lines, { "\"ev\":\"script_error\"", "\"object\":4,", "\"property\":\"origin\"" }),
               "layer 4's script error isn't attributed");
        // the source line the stack's first frame points at (QuickJS names no callee in "not a function")
        CHECK (health_find (lines, { "\"ev\":\"script_error\"", "\"line\":", "\"source_line\":\"" }),
               "layer 4's script error has no source line");
        const std::string* good = health_find (lines, { "\"ev\":\"layers\"", "\"frame\":1,", "\"object\":1," });
        CHECK (good != nullptr, "no frame-1 layer record for layer 1");
        float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
        const auto at = good->find ("\"bbox\":[");
        CHECK (at != std::string::npos && sscanf (good->c_str () + at + 8, "%f,%f,%f,%f", &x0, &y0, &x1, &y1) == 4,
               "no bbox: %s", good->c_str ());
        printf ("    layer 1 bbox %.1f %.1f %.1f %.1f\n", x0, y0, x1, y1);
        CHECK (std::abs (x0 - 12) < 0.6 && std::abs (x1 - 20) < 0.6 && std::abs (y0 - 20) < 0.6 && std::abs (y1 - 28) < 0.6,
               "want 12 20 20 28");
        const std::string* away = health_find (lines, { "\"ev\":\"layers\"", "\"frame\":1,", "\"object\":3," });
        CHECK (away != nullptr && away->find ("\"on_canvas_px\":0.0") != std::string::npos, "layer 3 isn't off the canvas: %s",
               away ? away->c_str () : "(none)");
    }

    // unset: a project loaded now (one with a script that throws) writes nothing, to the old file or anywhere
    const size_t before = lines.size ();
    const std::string quiet = script_scene (square (1, scripted ("origin", "\"8 16 0\"", "export function update(value) {\n  return value.nothing.here;\n}")));
    {
        ScriptRig rig;
        CHECK (rig.open (quiet), "load of %s failed", quiet.c_str ());
        rig.step ();
        CHECK (health_lines (path).size () == before, "a load without WPENGINE_HEALTH wrote to the file");
    }
    unlink (path.c_str ());
    rmdir (dir.c_str ());
    return true;
}

// g_Frametime (the frame's dt), g_PointerState (xy held, z the press frame), g_Daytime (the local time of day) and
// g_Time wrapped at 432000 s are fed (unpatched: the first three read 0, g_Time ran on)
static bool engine_uniforms_are_fed () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (b9_object (1, 16));
    b9_layer (dir, "uniform float g_Frametime;\nuniform vec4 g_PointerState;\nuniform float g_Daytime;\nuniform float g_Time;\n",
              "gl_FragColor = vec4(g_Frametime * 15.0, g_Daytime, g_PointerState.x * 0.5 + g_PointerState.z * 0.5, 1.0);");
    ScriptRig rig;
    rig.mouse = &g_clicker;
    g_buttonDown = false;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    auto at = [&rig] () {
        std::array<unsigned char, 4> px {};
        read_pixel (rig.fbo, 16, 16, px.data ());
        return px;
    };
    rig.step ();
    const auto up = at ();
    g_buttonDown = true;
    rig.step ();
    const auto pressed = at ();
    rig.step ();
    const auto held = at ();
    g_buttonDown = false;
    // the local time of day now, as WE computes it
    const std::time_t now = std::time (nullptr);
    std::tm local {};
    localtime_r (&now, &local);
    const double day = local.tm_hour / 24.0 + local.tm_min / 1440.0 + local.tm_sec / 86400.0;
    printf ("    frametime 1/30 → r=%d; daytime → g=%d (local %.3f → %d); pointer up %d, pressed %d, held %d\n", up[0], up[1], day,
            static_cast<int> (std::lround (day * 255)), up[2], pressed[2], held[2]);
    CHECK (near (up[0], 0.5 * 255), "g_Frametime isn't 1/30 (r=%d)", up[0]);
    CHECK (near (up[1], day * 255, 2), "g_Daytime isn't the local time of day (g=%d)", up[1]);
    CHECK (up[2] < 3 && near (pressed[2], 255) && near (held[2], 127), "g_PointerState: up %d, pressed %d, held %d", up[2],
           pressed[2], held[2]);

    // g_Time past 5 days wraps (WE: reset to 0 above 432000 s)
    const std::string wrap = script_scene (b9_object (1, 16));
    b9_layer (wrap, "uniform float g_Time;\n", "gl_FragColor = vec4(g_Time * 0.1, 0.0, 0.0, 1.0);");
    ScriptRig rig2;
    CHECK (rig2.open (wrap), "load/build of %s failed", wrap.c_str ());
    g_now = 432005.0f - 1.0f / 30.0f;
    rig2.step ();
    std::array<unsigned char, 4> px {};
    read_pixel (rig2.fbo, 16, 16, px.data ());
    printf ("    g_Time at 432005 s: r=%d (5 s → 127)\n", px[0]);
    CHECK (near (px[0], 0.5 * 255, 4), "g_Time didn't wrap at 432000 s (r=%d)", px[0]);
    return true;
}

// bloom follows its user properties live and is tinted (unpatched: strength/threshold were literals taken at load, the
// tint was never passed, and a scene whose bloom was off at load never got the bloom passes)
static bool bloom_is_live_and_tinted () {
    if (!script_tests_can_run ()) {
        return true;
    }
    // a white square (28..35) on the blue clear (0.5, under the threshold 0.6); the glow at 37 is green only (tint 0 1 0)
    const std::string dir = camera_scene (
        "\"bloom\":{\"user\":\"bl\",\"value\":false},\"bloomstrength\":{\"user\":\"bs\",\"value\":4},\"bloomthreshold\":0.6,"
        "\"bloomtint\":\"0 1 0\"",
        white_square (1, "\"origin\":\"32 16 0\""),
        "\"bl\":{\"type\":\"bool\",\"value\":false,\"text\":\"b\"},\"bs\":{\"type\":\"slider\",\"value\":4,\"min\":0,\"max\":4,\"text\":\"s\"}"
    );
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    auto glow = [&rig] () {
        std::array<unsigned char, 4> px {};
        read_pixel (rig.fbo, 37, 16, px.data ());
        return px;
    };
    rig.step ();
    const auto off = glow ();
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "bl", true), "bool refused");
    rig.step ();
    const auto on = glow ();
    CHECK (wp_project_property_set_slider_by_name (rig.p, "bs", 0.0f), "slider refused");
    rig.step ();
    const auto none = glow ();
    printf ("    next to the square: bloom off %d %d %d; on %d %d %d; strength 0 %d %d %d\n", off[0], off[1], off[2], on[0], on[1],
            on[2], none[0], none[1], none[2]);
    CHECK (off[1] < 3, "a glow with bloom off (g=%d)", off[1]);
    CHECK (on[1] >= 6, "turning bloom on live didn't glow (g=%d)", on[1]);
    CHECK (on[0] < 3, "the glow isn't tinted green (r=%d)", on[0]);
    CHECK (none[1] < 3, "strength 0 still glows (g=%d)", none[1]);
    return true;
}

// the centre pixel of the b9 layer at x 16
static std::array<unsigned char, 4> b9_pixel (const ScriptRig& rig) {
    std::array<unsigned char, 4> px {};
    read_pixel (rig.fbo, 16, 16, px.data ());
    return px;
}

// a float uniform's `default` written as a string is that float, and a vector's written as a number broadcasts
// (unpatched: std::stoi ("0.25") = 0, and the number threw, which lost the layer's pass)
static bool annotation_defaults_parse () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (b9_object (1, 16));
    b9_layer (dir,
              "uniform float u_Spacing; // {\"material\":\"spacing\",\"default\":\"0.25\"}\n"
              "uniform vec2 u_Pair; // {\"material\":\"pair\",\"default\":0.5}\n",
              "gl_FragColor = vec4(u_Spacing, u_Pair.x, u_Pair.y, 1.0);");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto px = b9_pixel (rig);
    printf ("    \"0.25\" → r=%d; 0 for a vec2 → g=%d b=%d\n", px[0], px[1], px[2]);
    CHECK (near (px[0], 0.25 * 255), "a string float default isn't 0.25 (r=%d)", px[0]);
    CHECK (near (px[1], 0.5 * 255) && near (px[2], 0.5 * 255), "a number vec2 default didn't broadcast (%d %d)", px[1], px[2]);
    return true;
}

// a fragment unit reading a varying only its vertex unit declares compiles (WE's packaged foliagesway reads v_Bounds
// that way; unpatched: an undeclared identifier, the pass failed)
static bool fragment_gets_vertex_varyings () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (b9_object (1, 16));
    b9_layer (dir, "", "gl_FragColor = vec4(v_Bounds.x, v_Bounds.y, 0.0, 1.0);", "varying vec2 v_Bounds;\n",
              "\tv_Bounds = vec2(0.5, 0.25);\n");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto px = b9_pixel (rig);
    printf ("    v_Bounds 0.5 0.25 → %d %d %d\n", px[0], px[1], px[2]);
    CHECK (near (px[0], 0.5 * 255) && near (px[1], 0.25 * 255), "the vertex-only varying didn't reach the fragment (%d %d %d)",
           px[0], px[1], px[2]);
    return true;
}

// the property listing: a textinput is listed with its text, without JSON quotes; a combo option 0.5 keeps its
// value; a file property is not taken for a boolean (unpatched: "Unknown property type" ended the listing, the
// default was "\"YOURNAME\"", 0.5 became "0" and WP_PROPERTY_TYPE_FILE was 4, the boolean's)
static bool properties_list_as_written () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = camera_scene ("\"zoom\":1", square (1, "\"origin\":\"16 16 0\""),
        "\"a_flag\":{\"type\":\"bool\",\"value\":true,\"text\":\"f\"},"
        "\"b_name\":{\"type\":\"textinput\",\"value\":\"YOURNAME\",\"text\":\"n\"},"
        "\"c_mode\":{\"type\":\"combo\",\"value\":0.5,\"text\":\"m\",\"options\":[{\"label\":\"half\",\"value\":0.5},{\"label\":\"one\",\"value\":1}]},"
        "\"d_file\":{\"type\":\"file\",\"value\":\"\",\"text\":\"p\"}");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    wp_project_property_list_reset (rig.p);
    std::string name, combo, kinds;
    for (wp_project_property* property; (property = wp_project_property_list_next (rig.p)) != nullptr;) {
        kinds += std::string (property->name) + "=" + std::to_string (property->type) + " ";
        if (const auto text = WP_PROPERTY_AS_TEXT_INPUT (property)) {
            name = text->value;
        } else if (const auto options = WP_PROPERTY_AS_COMBO (property)) {
            for (int i = 0; i < options->value_count; i++) {
                combo += std::string (options->values[i].key) + "/";
            }
        }
    }
    printf ("    listed: %s; textinput \"%s\"; combo keys %s\n", kinds.c_str (), name.c_str (), combo.c_str ());
    CHECK (name == "YOURNAME", "the textinput isn't YOURNAME (\"%s\")", name.c_str ());
    CHECK (combo.find ("0.5/") != std::string::npos, "the combo option 0.5 is listed as %s", combo.c_str ());
    CHECK (kinds.find ("d_file=5") != std::string::npos && kinds.find ("a_flag=4") != std::string::npos,
           "file and boolean types: %s", kinds.c_str ());
    return true;
}

// a pass's usertexture names a scenetexture property, whose value is the texture (unpatched: the property's name
// was resolved as a texture path, which failed, and the slot stayed unbound)
static bool usertexture_reads_its_property () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = camera_scene ("\"zoom\":1", b9_object (1, 16) + "," + b9_object (2, 48),
        "\"picked\":{\"type\":\"scenetexture\",\"value\":\"util/white\",\"text\":\"t\"}");
    b9_layer (dir, "uniform sampler2D g_Texture1;\n", "gl_FragColor = vec4(texSample2D(g_Texture1, vec2(0.5, 0.5)).rgb, 1.0);");
    write_file (dir + "/materials/b9.json", "{\"passes\":[{\"shader\":\"b9\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                            "\"depthwrite\":\"disabled\",\"blending\":\"normal\",\"textures\":[\"util/black\",\"util/black\"],"
                                            "\"usertextures\":[null,\"picked\"]}]}\n");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto px = b9_pixel (rig);
    printf ("    g_Texture1 from the property's util/white: %d %d %d\n", px[0], px[1], px[2]);
    CHECK (px[0] > 250 && px[1] > 250 && px[2] > 250, "the picked texture isn't white (%d %d %d)", px[0], px[1], px[2]);
    return true;
}

// an effect pass of the E41 test: the previous output with channel `ch` raised to 1
static void e41_effect (const std::string& dir, const std::string& name, const char* ch) {
    mkdir ((dir + "/effects").c_str (), 0755);
    mkdir ((dir + "/effects/" + name).c_str (), 0755);
    write_file (dir + "/shaders/" + name + ".vert",
                "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\n"
                "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n\tv_TexCoord = a_TexCoord;\n}\n");
    write_file (dir + "/shaders/" + name + ".frag",
                std::string ("uniform sampler2D g_Texture0;\nvarying vec2 v_TexCoord;\nvoid main() {\n\tvec4 c = texSample2D(g_Texture0, v_TexCoord);\n\tc.")
                    + ch + " = 1.0;\n\tgl_FragColor = vec4(c.rgb, 1.0);\n}\n");
    write_file (dir + "/materials/" + name + ".json", "{\"passes\":[{\"shader\":\"" + name + "\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                                      "\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    write_file (dir + "/effects/" + name + "/effect.json",
                "{\"name\":\"" + name + "\",\"passes\":[{\"material\":\"materials/" + name + ".json\"}]}\n");
}

// an effect's `visible` bound to a user property turns it on and off live, the chain after it still drawn (E41;
// unpatched: an effect hidden at load was never built, a visible one never left the chain)
static bool effect_visible_is_live () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::string object = b9_object (1, 16);
    object.pop_back ();
    object += ",\"effects\":[{\"id\":2,\"name\":\"g\",\"file\":\"effects/e41g/effect.json\",\"visible\":{\"user\":\"fx\",\"value\":false}},"
              "{\"id\":3,\"name\":\"b\",\"file\":\"effects/e41b/effect.json\",\"visible\":{\"user\":\"last\",\"value\":true}}]}";
    const std::string dir = camera_scene ("\"zoom\":1", object,
        "\"fx\":{\"type\":\"bool\",\"value\":false,\"text\":\"f\"},\"last\":{\"type\":\"bool\",\"value\":true,\"text\":\"l\"}");
    b9_layer (dir, "", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
    e41_effect (dir, "e41g", "g");
    e41_effect (dir, "e41b", "b");
    ScriptRig rig;
    rig.extra = { "effects/e41g/effect.json", "effects/e41b/effect.json", "shaders/e41g.vert", "shaders/e41g.frag",
                  "shaders/e41b.vert", "shaders/e41b.frag", "materials/e41g.json", "materials/e41b.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto hidden = b9_pixel (rig);
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "fx", true), "bool refused");
    rig.step ();
    const auto shown = b9_pixel (rig);
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "last", false), "bool refused");
    rig.step ();
    const auto lastOff = b9_pixel (rig);
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "fx", false), "bool refused");
    rig.step ();
    const auto none = b9_pixel (rig);
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "fx", true), "bool refused");
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "last", true), "bool refused");
    rig.step ();
    const auto both = b9_pixel (rig);
    printf ("    green effect off %d %d %d; on %d %d %d; blue off %d %d %d; both off %d %d %d; both on %d %d %d\n", hidden[0],
            hidden[1], hidden[2], shown[0], shown[1], shown[2], lastOff[0], lastOff[1], lastOff[2], none[0], none[1], none[2],
            both[0], both[1], both[2]);
    CHECK (hidden[0] > 250 && hidden[1] < 5 && hidden[2] > 250, "hidden at load: not red + blue (%d %d %d)", hidden[0], hidden[1], hidden[2]);
    CHECK (shown[0] > 250 && shown[1] > 250 && shown[2] > 250, "shown live: not white (%d %d %d)", shown[0], shown[1], shown[2]);
    CHECK (lastOff[0] > 250 && lastOff[1] > 250 && lastOff[2] < 5, "last effect hidden: not yellow (%d %d %d)", lastOff[0], lastOff[1], lastOff[2]);
    CHECK (none[0] > 250 && none[1] < 5 && none[2] < 5, "both hidden: not the red base (%d %d %d)", none[0], none[1], none[2]);
    CHECK (both[0] > 250 && both[1] > 250 && both[2] > 250, "both back: not white (%d %d %d)", both[0], both[1], both[2]);
    return true;
}


// ---------------------------------------------------------------------------------------------
// B7: blend modes and the framebuffer (docs/player/spikes/we-lwe-gap-audit.md E27, E28, E30, E31, E33)

// a layer material `name` drawing `body` (v_TexCoord is the layer's 0..1), as models/<name>.json; `textures` is the
// material's texture list (JSON), `solid` makes it a solid layer (no texture of its own). Returns the files it wrote
static std::vector<std::string> b7_layer (const std::string& dir, const std::string& name, const std::string& body,
                                          const std::string& textures = "", bool solid = true, const std::string& uniforms = "") {
    mkdir ((dir + "/shaders").c_str (), 0755);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/shaders/" + name + ".vert",
                "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\n"
                "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n\tv_TexCoord = a_TexCoord;\n}\n");
    write_file (dir + "/shaders/" + name + ".frag", "varying vec2 v_TexCoord;\n" + uniforms + "void main() {\n\t" + body + "\n}\n");
    write_file (dir + "/materials/" + name + ".json",
                "{\"passes\":[{\"shader\":\"" + name + "\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\",\"depthwrite\":\"disabled\","
                "\"blending\":\"normal\"" + (textures.empty () ? std::string () : ",\"textures\":" + textures) + "}]}\n");
    write_file (dir + "/models/" + name + ".json",
                "{\"material\":\"materials/" + name + ".json\"" + (solid ? ",\"solidlayer\":true" : "") + "}\n");
    return { "shaders/" + name + ".vert", "shaders/" + name + ".frag", "materials/" + name + ".json", "models/" + name + ".json" };
}

// an effect `name` of one pass drawing `body` over g_Texture0 (the layer so far) at v_TexCoord
static std::vector<std::string> b7_effect (const std::string& dir, const std::string& name, const std::string& body) {
    mkdir ((dir + "/effects").c_str (), 0755);
    mkdir ((dir + "/effects/" + name).c_str (), 0755);
    auto files = b7_layer (dir, name, body, "", true, "uniform sampler2D g_Texture0;\n");
    unlink ((dir + "/models/" + name + ".json").c_str ());
    files.pop_back ();
    write_file (dir + "/effects/" + name + "/effect.json",
                "{\"name\":\"" + name + "\",\"passes\":[{\"material\":\"materials/" + name + ".json\"}]}\n");
    files.push_back ("effects/" + name + "/effect.json");
    return files;
}

static std::string b7_object (int id, const std::string& model, int x, const std::string& size, const std::string& extra = "") {
    return "{\"id\":" + std::to_string (id) + ",\"name\":\"o" + std::to_string (id) + "\",\"image\":\"models/" + model
         + ".json\",\"size\":\"" + size + "\",\"origin\":\"" + std::to_string (x) + " 16 0\"" + extra + "}";
}

static std::array<unsigned char, 4> pixel_at (const ScriptRig& rig, int x) {
    std::array<unsigned char, 4> px {};
    read_pixel (rig.fbo, x, 16, px.data ());
    return px;
}

static bool rgb_near (const std::array<unsigned char, 4>& px, int r, int g, int b) {
    return near (px[0], r, 3) && near (px[1], g, 3) && near (px[2], b, 3);
}

// a layer's composite FBOs clamp unless `clampuvs` is false (WE's default is true): an effect sampling past the
// layer's right edge gets the edge, not the left side (unpatched: the FBOs took the texture's flags, a solid layer's
// none, and wrapped)
static bool clampuvs_clamps_the_composite () {
    if (!script_tests_can_run ()) {
        return true;
    }
    auto run = [] (const std::string& flag, std::array<unsigned char, 4>& out) {
        const std::string dir = camera_scene ("\"zoom\":1",
            b7_object (1, "b7uv", 32, "32 8",
                       flag + ",\"effects\":[{\"id\":2,\"name\":\"s\",\"file\":\"effects/b7shift/effect.json\",\"visible\":true}]"));
        ScriptRig rig;
        rig.extra = b7_layer (dir, "b7uv", "gl_FragColor = mix(vec4(0.0, 1.0, 0.0, 1.0), vec4(1.0, 0.0, 0.0, 1.0), step(v_TexCoord.x, 0.25));");
        const auto fx = b7_effect (dir, "b7shift", "gl_FragColor = texSample2D(g_Texture0, v_TexCoord + vec2(0.5, 0.0));");
        rig.extra.insert (rig.extra.end (), fx.begin (), fx.end ());
        if (!rig.open (dir)) {
            return false;
        }
        rig.step ();
        out = pixel_at (rig, 36);
        return true;
    };
    std::array<unsigned char, 4> clamped {}, wrapped {};
    CHECK (run ("", clamped), "load/build failed");
    CHECK (run (",\"clampuvs\":false", wrapped), "load/build failed (clampuvs false)");
    printf ("    u 0.63 + 0.5: default %d %d %d (want green: the edge), clampuvs false %d %d %d (want red: wrapped)\n", clamped[0],
            clamped[1], clamped[2], wrapped[0], wrapped[1], wrapped[2]);
    CHECK (rgb_near (clamped, 0, 255, 0), "default clampuvs didn't clamp (%d %d %d)", clamped[0], clamped[1], clamped[2]);
    CHECK (rgb_near (wrapped, 255, 0, 0), "clampuvs false didn't wrap (%d %d %d)", wrapped[0], wrapped[1], wrapped[2]);
    return true;
}

// `_rt_imageLayerComposite_<id>_a` holds what the layer's last pass reads, `_b` the stage before (WE starts the
// ping-pong by the parity of the passes that write it; unpatched: the base always went to _a, so with two effects
// _a held the bare base and _b what the last pass read)
static bool composite_a_is_what_the_last_pass_reads () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string fx = ",\"effects\":[{\"id\":2,\"name\":\"g\",\"file\":\"effects/e41g/effect.json\",\"visible\":true},"
                           "{\"id\":3,\"name\":\"b\",\"file\":\"effects/e41b/effect.json\",\"visible\":true}]";
    const std::string dir = camera_scene ("\"zoom\":1",
        b7_object (1, "b7red", 16, "8 8", fx) + "," + b7_object (4, "b7a", 32, "8 8") + "," + b7_object (5, "b7b", 48, "8 8"));
    ScriptRig rig;
    rig.extra = b7_layer (dir, "b7red", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
    const std::string sample = "gl_FragColor = texSample2D(g_Texture0, v_TexCoord);";
    for (const auto& files : { b7_layer (dir, "b7a", sample, "[\"_rt_imageLayerComposite_1_a\"]", false, "uniform sampler2D g_Texture0;\n"),
                               b7_layer (dir, "b7b", sample, "[\"_rt_imageLayerComposite_1_b\"]", false, "uniform sampler2D g_Texture0;\n") }) {
        rig.extra.insert (rig.extra.end (), files.begin (), files.end ());
    }
    e41_effect (dir, "e41g", "g");
    e41_effect (dir, "e41b", "b");
    for (const char* f : { "effects/e41g/effect.json", "effects/e41b/effect.json", "shaders/e41g.vert", "shaders/e41g.frag",
                           "shaders/e41b.vert", "shaders/e41b.frag", "materials/e41g.json", "materials/e41b.json" }) {
        rig.extra.emplace_back (f);
    }
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    const auto layer = pixel_at (rig, 16), a = pixel_at (rig, 32), b = pixel_at (rig, 48);
    printf ("    layer %d %d %d; _a %d %d %d (want yellow: base + green); _b %d %d %d (want red: the base)\n", layer[0], layer[1],
            layer[2], a[0], a[1], a[2], b[0], b[1], b[2]);
    CHECK (rgb_near (layer, 255, 255, 255), "the layer isn't white (%d %d %d)", layer[0], layer[1], layer[2]);
    CHECK (rgb_near (a, 255, 255, 0), "_a isn't what the last pass reads (%d %d %d)", a[0], a[1], a[2]);
    CHECK (rgb_near (b, 255, 0, 0), "_b isn't the stage before (%d %d %d)", b[0], b[1], b[2]);
    return true;
}

// a compose (passthrough) layer draws its children (origin parent-local: x 16) into itself, from the background (copybackground, the default) or
// from transparent, and its effects apply to them; an object outside it is drawn as before (unpatched: the children
// were drawn after the layer, untouched, and `copybackground: false` still tinted the background)
static bool compose_layer_draws_its_children () {
    if (!script_tests_can_run ()) {
        return true;
    }
    auto run = [] (const std::string& flag, std::array<std::array<unsigned char, 4>, 3>& out, bool effect = true) {
        const std::string compose
            = "{\"id\":1,\"name\":\"c\",\"image\":\"models/util/composelayer.json\",\"size\":\"64 32\",\"origin\":\"32 16 0\"" + flag
            + (effect ? ",\"effects\":[{\"id\":2,\"name\":\"t\",\"file\":\"effects/b7tint/effect.json\",\"visible\":true}]}" : "}");
        const std::string dir = camera_scene ("\"zoom\":1",
            compose + ",{\"id\":3,\"name\":\"o3\",\"image\":\"models/b7red.json\",\"size\":\"8 8\",\"origin\":\"-16 0 0\",\"parent\":1},"
                + b7_object (4, "b7red", 48, "8 8"));
        ScriptRig rig;
        rig.extra = b7_layer (dir, "b7red", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
        // green = coverage: the transparent stays transparent
        const auto fx = b7_effect (dir, "b7tint", "vec4 c = texSample2D(g_Texture0, v_TexCoord);\n\tgl_FragColor = vec4(c.r, c.a, c.b, c.a);");
        rig.extra.insert (rig.extra.end (), fx.begin (), fx.end ());
        if (!rig.open (dir)) {
            return false;
        }
        rig.step ();
        rig.step ();
        out = { pixel_at (rig, 16), pixel_at (rig, 32), pixel_at (rig, 48) };
        return true;
    };
    std::array<std::array<unsigned char, 4>, 3> copied {}, clear {}, bare {};
    CHECK (run ("", copied), "load/build failed");
    CHECK (run (",\"copybackground\":false", clear), "load/build failed (copybackground false)");
    CHECK (run ("", bare, false), "load/build failed (no effect)");
    printf ("    no effect: child %d %d %d, background %d %d %d, outside %d %d %d\n", bare[0][0], bare[0][1], bare[0][2], bare[1][0],
            bare[1][1], bare[1][2], bare[2][0], bare[2][1], bare[2][2]);
    CHECK (rgb_near (bare[0], 255, 0, 0) && rgb_near (bare[1], 0, 0, 128) && rgb_near (bare[2], 255, 0, 0),
           "no effect: the layer isn't just its background and child");
    printf ("    copybackground: child %d %d %d, background %d %d %d, outside %d %d %d\n", copied[0][0], copied[0][1], copied[0][2],
            copied[1][0], copied[1][1], copied[1][2], copied[2][0], copied[2][1], copied[2][2]);
    printf ("    copybackground false: child %d %d %d, background %d %d %d, outside %d %d %d\n", clear[0][0], clear[0][1],
            clear[0][2], clear[1][0], clear[1][1], clear[1][2], clear[2][0], clear[2][1], clear[2][2]);
    CHECK (rgb_near (copied[0], 255, 255, 0), "copybackground: the child wasn't drawn through the layer (%d %d %d)", copied[0][0],
           copied[0][1], copied[0][2]);
    CHECK (rgb_near (copied[1], 0, 255, 128), "copybackground: the background wasn't tinted (%d %d %d)", copied[1][0], copied[1][1],
           copied[1][2]);
    CHECK (rgb_near (copied[2], 255, 0, 0), "copybackground: the object outside changed (%d %d %d)", copied[2][0], copied[2][1],
           copied[2][2]);
    CHECK (rgb_near (clear[0], 255, 255, 0), "copybackground false: the child wasn't drawn through the layer (%d %d %d)", clear[0][0],
           clear[0][1], clear[0][2]);
    CHECK (rgb_near (clear[1], 0, 0, 128), "copybackground false: the background was touched (%d %d %d)", clear[1][0], clear[1][1],
           clear[1][2]);
    CHECK (rgb_near (clear[2], 255, 0, 0), "copybackground false: the object outside changed (%d %d %d)", clear[2][0], clear[2][1],
           clear[2][2]);
    return true;
}

// colour blend modes over the scene: 31 adds (WE: additive blending, no blend pass), 2 multiplies through
// genericimage3's BLENDMODE pass, which reads a copy of the scene, not the target it draws into
static bool color_blend_modes_read_the_scene () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = camera_scene ("\"zoom\":1",
        b7_object (1, "b7red", 32, "64 32") + "," + b7_object (2, "b7add", 16, "8 8", ",\"colorBlendMode\":31") + ","
            + b7_object (3, "b7mul", 48, "8 8", ",\"colorBlendMode\":2"));
    ScriptRig rig;
    rig.extra = b7_layer (dir, "b7red", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
    for (const auto& files : { b7_layer (dir, "b7add", "gl_FragColor = vec4(0.0, 0.5, 0.0, 1.0);"),
                               b7_layer (dir, "b7mul", "gl_FragColor = vec4(0.5, 1.0, 1.0, 1.0);") }) {
        rig.extra.insert (rig.extra.end (), files.begin (), files.end ());
    }
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    const auto add = pixel_at (rig, 16), mul = pixel_at (rig, 48), bg = pixel_at (rig, 32);
    printf ("    red + (0 .5 0) mode 31 → %d %d %d (want 255 128 0); red × (.5 1 1) mode 2 → %d %d %d (want 128 0 0); red %d %d %d\n",
            add[0], add[1], add[2], mul[0], mul[1], mul[2], bg[0], bg[1], bg[2]);
    CHECK (rgb_near (add, 255, 128, 0), "mode 31 didn't add (%d %d %d)", add[0], add[1], add[2]);
    CHECK (rgb_near (mul, 128, 0, 0), "mode 2 didn't multiply the scene (%d %d %d)", mul[0], mul[1], mul[2]);
    CHECK (rgb_near (bg, 255, 0, 0), "the background isn't red (%d %d %d)", bg[0], bg[1], bg[2]);
    return true;
}

// ---------------------------------------------------------------------------------------------
// B10: the SceneScript API surface (docs/player/spikes/we-lwe-gap-audit.md S10–S37)

// a JS check list a script runs: every failed name is logged, the script returns whether all passed
static std::string js_checks (const std::string& checks) {
    return "let fails = [];\nfunction check(n, c) { if (!c) fails.push(n); }\n" + checks
         + "if (fails.length) console.log('FAILS ' + fails.join(','));\n";
}

// layers by index for every type (a group too), one JS object per layer, enumerateLayers/getLayerIndex/sortLayer,
// engine.canvasSize/is*()/userProperties, solid/size, what a script stores on a layer stays, a write through
// getLayer (index) moves that layer (unpatched: numbers were ids, groups undefined, engine.canvasSize threw)
static bool layer_api_reaches_layers () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string checks = js_checks (
        "check('count', thisScene.getLayerCount() == 4);\n"
        "check('index0', thisScene.getLayer(0).name == 'sq1');\n"
        "check('same', thisScene.getLayer('sq2') === thisScene.getLayer(1));\n"
        "check('group', thisScene.getLayer('grp') !== undefined && thisScene.getLayer(3).visible === true);\n"
        "check('enum', thisScene.enumerateLayers().length == 4);\n"
        "check('idx', thisScene.getLayerIndex('sq3') == 2 && thisScene.getLayerIndex(thisLayer) == 0);\n"
        "check('sort', thisScene.sortLayer('sq3', 0) && thisScene.getLayer(0).name == 'sq3' && thisScene.getLayerIndex('sq1') == 1);\n"
        "thisScene.sortLayer('sq3', 2);\n"
        "check('unsort', thisScene.getLayerIndex('sq3') == 2);\n"
        "check('canvas', engine.canvasSize.x == 64 && engine.canvasSize.y == 32);\n"
        "check('desk', engine.isDesktopDevice() && !engine.isRunningInEditor() && engine.isLandscape() && engine.isObjectValid(thisLayer));\n"
        "check('uprops', Math.abs(engine.userProperties.speed - 0.25) < 1e-6);\n"
        "check('solid', thisLayer.solid === true && thisScene.getLayer('sq2').solid === false);\n"
        "check('size', thisLayer.size.x == 8 && thisLayer.size.y == 8);\n"
        "thisScene.getLayer('sq2').mark = 7;\n"
        "check('kept', thisScene.getLayer('sq2').mark === 7);\n"
        "check('effects', thisLayer.getEffectCount() == 0 && thisLayer.getEffect('x') === undefined);\n"
        "check('parent', thisLayer.getParent() === undefined && thisScene.getLayer('grp').getChildren().length == 0);\n"
        "check('scene', typeof thisScene.bloomstrength === 'number' && thisScene.clearenabled === true);\n");
    const std::string dir = script_scene (
        square (1, scripted ("visible", "true", "export function update(value) {\n" + checks
                                                    + "thisScene.getLayer(2).origin = new Vec3(48, 16, 0);\nreturn fails.length == 0;\n}")
                       + ",\"origin\":\"8 16 0\"")
        + "," + square (2, "\"origin\":\"24 16 0\",\"solid\":false") + "," + square (3, "\"origin\":\"40 16 0\"")
        + ",{\"id\":4,\"name\":\"grp\",\"origin\":\"0 0 0\",\"visible\":true}");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    std::string want = covered (4, 11);
    for (int x = 20; x <= 27; x++) {
        want[x] = '#';
    }
    for (int x = 44; x <= 51; x++) {
        want[x] = '#';
    }
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    CHECK (got == want, "want %s (a missing square at 4..11: a failed check, see FAILS above)", want.c_str ());
    return true;
}

// thisLayer.getEffect (name).visible written by a script turns the effect on live (an effect hidden at load is
// built because the scene's scripts call getEffect); applyUserProperties gets every property once, then only the
// changed ones (unpatched: getEffect was undefined, applyUserProperties never saw a change)
static bool script_effect_and_property_changes () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::string object = b9_object (1, 16);
    object.pop_back ();
    object += "," + scripted ("visible", "true",
                              "let seen = [];\n"
                              "export function applyUserProperties(p) { seen.push(Object.keys(p).sort().join(',')); }\n"
                              "export function update(value) {\n"
                              "  thisLayer.getEffect('g').visible = engine.userProperties.fx === true\n"
                              "    && seen.join('|') == 'fx,other|fx' && thisLayer.getEffect(0).name == 'g';\n"
                              "}")
            + ",\"effects\":[{\"id\":2,\"name\":\"g\",\"file\":\"effects/e41g/effect.json\",\"visible\":false}]}";
    const std::string dir = camera_scene ("\"zoom\":1", object,
        "\"fx\":{\"type\":\"bool\",\"value\":false,\"text\":\"f\"},\"other\":{\"type\":\"bool\",\"value\":false,\"text\":\"o\"}");
    b9_layer (dir, "", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
    e41_effect (dir, "e41g", "g");
    ScriptRig rig;
    rig.extra = { "effects/e41g/effect.json", "shaders/e41g.vert", "shaders/e41g.frag", "materials/e41g.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto before = b9_pixel (rig);
    CHECK (wp_project_property_set_boolean_by_name (rig.p, "fx", true), "bool refused");
    rig.step ();
    rig.step ();
    const auto after = b9_pixel (rig);
    printf ("    effect hidden %d %d %d; shown by the script %d %d %d\n", before[0], before[1], before[2], after[0], after[1],
            after[2]);
    CHECK (before[0] > 250 && before[1] < 5, "not the red base at first (%d %d %d)", before[0], before[1], before[2]);
    CHECK (after[0] > 250 && after[1] > 250, "the script didn't show the effect (%d %d %d)", after[0], after[1], after[2]);
    return true;
}

// a text layer's script: thisLayer is the real layer (name, text written through it), init (value) gets the text,
// a combo's default is its first option, engine/thisScene are the real ones, it runs while its layer is hidden,
// and it gets applyUserProperties (unpatched: thisLayer was {text}, init had no value, the combo read undefined,
// a hidden text never ran)
static bool text_script_is_a_real_layer () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string script =
        "export var scriptProperties = createScriptProperties()"
        ".addCombo({name: 'mode', options: [{label: 'a', value: 'x'}, {label: 'b', value: 'y'}]}).finish();\n"
        "let started = '';\nlet applied = false;\n"
        "export function init(value) { started = value; return value + '|' + scriptProperties.mode; }\n"
        "export function applyUserProperties(p) { applied = p.speed !== undefined; }\n"
        "export function update(value) {\n"
        + js_checks ("check('name', thisLayer.name == 'txt');\ncheck('init', started == 'hello');\n"
                     "check('text', value == 'hello|x' && thisLayer.text == 'hello|x');\n"
                     "check('applied', applied);\ncheck('canvas', engine.canvasSize.x == 64);\n")
        + "  thisScene.getLayer('sq1').visible = fails.length == 0;\n}";
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
    const std::string dir = script_scene (
        square (1, "\"origin\":\"8 16 0\",\"visible\":false")
        + ",{\"id\":2,\"name\":\"txt\",\"origin\":\"40 16 0\",\"visible\":false,\"font\":\"systemfont_arial\",\"pointsize\":10,"
          "\"text\":{\"value\":\"hello\",\"script\":\"" + escaped + "\"}}");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    CHECK (got == covered (4, 11), "the text script didn't show sq1 (a failed check, see FAILS above)");
    return true;
}


// a JS string literal of a script, for a text object's "script" (the same escaping as scripted ())
static std::string json_escaped (const std::string& script) {
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
    return escaped;
}

// the host's media notifications reach property scripts and text-layer scripts: the status (reported before the
// scene existed), every MediaPropertiesEvent field, a thumbnail's colours from the image (red art: primary red,
// black as the high-contrast colour), sent once per image, the playback state and the timeline (unpatched: no
// status, no albumArtist/genres/contentType, fixed greys, text scripts got nothing)
static bool media_events_reach_scripts () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string checks = js_checks (
        "check('status', got.status === true);\n"
        "check('props', got.props == 'T/A/L/AA/rock, pop/music');\n"
        "check('thumb', got.thumb === true && got.n == 1);\n"
        "check('state', got.state == 1);\n"
        "check('timeline', got.pos == 12 && got.dur == 200);\n");
    const std::string script =
        "let got = {};\n"
        "export function mediaStatusChanged(e) { got.status = e.enabled; }\n"
        "export function mediaPropertiesChanged(e) { got.props = [e.title, e.artist, e.albumTitle, e.albumArtist, e.genres, e.contentType].join('/'); }\n"
        "export function mediaThumbnailChanged(e) {\n"
        "  got.n = (got.n || 0) + 1;\n"
        "  got.thumb = e.hasThumbnail && e.primaryColor.x > 0.9 && e.primaryColor.z < 0.1 && e.highContrastColor.x == 0\n"
        "    && e.textColor !== undefined && e.secondaryColor.z > 0.9;\n"
        "}\n"
        "export function mediaPlaybackChanged(e) { got.state = e.state; }\n"
        "export function mediaTimelineChanged(e) { got.pos = e.position; got.dur = e.duration; }\n"
        "export function update(value) {\n" + checks + "return fails.length == 0;\n}";
    const std::string text = "export function mediaPropertiesChanged(e) { thisScene.getLayer('sq2').visible = e.title == 'T'; }\n";
    const std::string dir = script_scene (
        square (1, scripted ("visible", "false", script) + ",\"origin\":\"8 16 0\"") + ","
        + square (2, "\"origin\":\"24 16 0\",\"visible\":false")
        + ",{\"id\":3,\"name\":\"txt\",\"origin\":\"40 16 0\",\"visible\":false,\"font\":\"systemfont_arial\",\"pointsize\":10,"
          "\"text\":{\"value\":\"x\",\"script\":\"" + json_escaped (text) + "\"}}");
    // the album art: a 4x4 PPM, 12 red pixels and 4 blue
    const std::string art = dir + "/art.ppm";
    std::string ppm = "P6\n4 4\n255\n";
    for (int i = 0; i < 16; i++) {
        ppm += i < 12 ? std::string ("\xff\x00\x00", 3) : std::string ("\x00\x00\xff", 3);
    }
    write_file (art, ppm);
    const std::string url = "file://" + art;
    ScriptRig rig;
    rig.extra = { "art.ppm" };
    rig.loaded = [] (wp_project* p) { wp_project_notify_media_status (p, true); };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    CHECK (wp_project_uses_media (rig.p), "the scene's media events aren't seen");
    wp_project_notify_track_metadata_change (rig.p, "T", "A", "L");
    wp_project_notify_track_metadata_extra (rig.p, "AA", "", "rock, pop", nullptr);
    wp_project_notify_album_art_url_change (rig.p, url.c_str ());
    wp_project_notify_playback_state_change (rig.p, WP_MEDIA_PLAYBACK_STATE_PLAYING);
    wp_project_notify_playback_position_and_duration_change (rig.p, 12.0, 200.0);
    rig.step ();
    // the same image again (the next track of an album): no second event
    wp_project_notify_album_art_url_change (rig.p, url.c_str ());
    rig.step ();
    rig.step ();
    std::string want = covered (4, 11);
    for (int x = 20; x <= 27; x++) {
        want[x] = '#';
    }
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    CHECK (got == want, "want %s (sq1: the property script's checks, see FAILS; sq2: the text script)", want.c_str ());
    return true;
}


// a script on an effect's `visible` has thisObject = that effect: a media thumbnail shows the effect, the layer stays
// (unpatched: thisObject was the layer, so `thisObject.visible = …` hid the whole layer, and no event came)
static bool effect_script_this_object_is_the_effect () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::string object = b9_object (1, 16);
    object.pop_back ();
    object += ",\"effects\":[{\"id\":2,\"name\":\"g\",\"file\":\"effects/e41g/effect.json\",\"visible\":{\"value\":false,\"script\":\""
              + json_escaped ("export function mediaThumbnailChanged(e) { thisObject.visible = e.hasThumbnail && thisObject.name == 'g'; }\n")
              + "\"}}]}";
    const std::string dir = camera_scene ("\"zoom\":1", object);
    b9_layer (dir, "", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
    e41_effect (dir, "e41g", "g");
    const std::string art = dir + "/art.ppm";
    write_file (art, "P6\n1 1\n255\n" + std::string ("\x20\x40\xc0", 3));
    const std::string url = "file://" + art;
    ScriptRig rig;
    rig.extra = { "effects/e41g/effect.json", "shaders/e41g.vert", "shaders/e41g.frag", "materials/e41g.json", "art.ppm" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto before = b9_pixel (rig);
    wp_project_notify_album_art_url_change (rig.p, url.c_str ());
    rig.step ();
    rig.step ();
    const auto after = b9_pixel (rig);
    printf ("    before the thumbnail %d %d %d; after %d %d %d\n", before[0], before[1], before[2], after[0], after[1], after[2]);
    CHECK (before[0] > 250 && before[1] < 5, "not the red layer at first (%d %d %d)", before[0], before[1], before[2]);
    CHECK (after[0] > 250 && after[1] > 250, "the effect isn't shown on the layer (%d %d %d)", after[0], after[1], after[2]);
    return true;
}


// thisObject.getAnimation () is the script's own property's keyframe animation: a `startpaused` fade a script
// play ()s runs to its end; the same fade with no script stays paused (unpatched: getAnimation was undefined)
static bool script_plays_a_keyframe_animation () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string curve = "\"c0\":[" + key (0, 0.75) + "," + key (10, 0) + "]";
    const std::string options = "\"fps\":30,\"length\":10,\"mode\":\"single\",\"startpaused\":true";
    std::string scriptedFade = animated ("alpha", "1.0", curve, options);
    scriptedFade.pop_back ();
    scriptedFade += ",\"script\":\"let n = 0;\\nexport function update(value) {\\n  const a = thisObject.getAnimation();\\n"
                    "  if (++n == 3) { a.play(); }\\n  if (n == 2 && (a.isPlaying() || a.frameCount != 10)) { console.log('FAILS anim'); }\\n}\"}";
    const std::string dir = script_scene (white_square (1, "\"origin\":\"4 16 0\"," + scriptedFade) + ","
                                          + white_square (2, "\"origin\":\"14 16 0\"," + animated ("alpha", "1.0", curve, options)));
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    while (rig.frames < 20) {
        rig.step ();
    }
    const int played = red_at (rig, 4), paused = red_at (rig, 14);
    printf ("    after %d ticks: played %d, paused %d\n", rig.frames, played, paused);
    CHECK (near (played, 0), "the played fade didn't reach 0: r=%d", played);
    CHECK (near (paused, 0.75 * 255), "the paused fade moved: r=%d", paused);
    return true;
}


// cursor events: enter/down/up/click on the solid layer under the pointer, with localPosition 0..size and
// worldPosition in scene pixels (y up); a hidden solid layer gets enter/leave/move but no press or click;
// a non-solid one gets none; input.cursorWorldPosition follows the pointer (unpatched: no cursor event at all,
// cursorWorldPosition 0 0 0)
static bool cursor_events_reach_layers () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string sq1 = "shared.log = shared.log || [];\n"
                            "export function cursorEnter(e) { shared.log.push('enter1'); }\n"
                            "export function cursorLeave(e) { shared.log.push('leave1'); }\n"
                            "export function cursorDown(e) { shared.log.push('down1'); }\n"
                            "export function cursorUp(e) { shared.log.push('up1'); }\n"
                            "export function cursorClick(e) { shared.log.push('click1:' + Math.round(e.localPosition.x) + ','\n"
                            "  + Math.round(e.localPosition.y) + ':' + Math.round(e.worldPosition.x) + ',' + Math.round(e.worldPosition.y)); }\n";
    const std::string sq2 = "shared.log = shared.log || [];\nexport function cursorClick(e) { shared.log.push('click2'); }\n"
                            "export function cursorEnter(e) { shared.log.push('enter2'); }\n";
    const std::string sq3 = "shared.log = shared.log || [];\nexport function cursorEnter(e) { shared.log.push('enter3'); }\n";
    const std::string sq4 = "export function update(value) {\n"
                            "  const log = (shared.log || []).join(' ');\n"
                            "  const p = input.cursorWorldPosition;\n"
                            "  const ok = log == 'enter1 down1 up1 click1:4,4:8,24 leave1 enter2' && p.x == 24 && p.y == 16 && !input.cursorLeftDown;\n"
                            "  return ok;\n}";
    const std::string dir = script_scene (
        square (1, scripted ("visible", "true", sq1) + ",\"origin\":\"8 24 0\"") + ","
        + square (2, scripted ("visible", "false", sq2) + ",\"origin\":\"40 8 0\"") + ","
        + square (3, scripted ("visible", "true", sq3) + ",\"origin\":\"24 16 0\",\"solid\":false") + ","
        + square (4, scripted ("visible", "false", sq4) + ",\"origin\":\"56 16 0\""));
    ScriptRig rig;
    g_mouseX = 60.0;
    g_mouseY = 30.0;
    g_buttonDown = false;
    rig.mouse = &g_clicker;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    // y down: (8, 8) is world (8, 24), sq1's centre
    g_mouseX = 8.0;
    g_mouseY = 8.0;
    rig.step ();
    g_buttonDown = true;
    rig.step ();
    g_buttonDown = false;
    rig.step ();
    g_mouseX = 40.0;
    g_mouseY = 24.0;
    rig.step ();
    g_buttonDown = true;
    rig.step ();
    g_buttonDown = false;
    rig.step ();
    g_mouseX = 24.0;
    g_mouseY = 16.0;
    rig.step ();
    rig.step ();
    const std::string got = rig.row ();
    std::string want = covered (20, 27);
    for (int x = 52; x <= 59; x++) {
        want[x] = '#';
    }
    printf ("    %s\n", got.c_str ());
    CHECK (got == want, "want %s (sq4 shows when the event log is right)", want.c_str ());
    return true;
}


// localStorage persists in the host's storage dir from one load to the next, keeps a number a number and a Vec3 a
// Vec3, keeps LOCATION_GLOBAL apart from the default screen store; delete answers whether the key was there
// (unpatched: an in-memory object, lost on reload; set stored String(value))
static bool local_storage_persists () {
    if (!script_tests_can_run ()) {
        return true;
    }
    char tmpl[] = "/tmp/lwe-storage.XXXXXX";
    const char* storage = mkdtemp (tmpl);
    CHECK (storage != nullptr, "mkdtemp");
    const std::string first = "export function init(value) {\n"
                              "  localStorage.set('n', 41);\n"
                              "  localStorage.set('pos', new Vec3(1, 2, 3), localStorage.LOCATION_GLOBAL);\n"
                              "  localStorage.set('gone', 1);\n"
                              "  return localStorage.delete('gone') && !localStorage.delete('gone');\n"
                              "}";
    const std::string second = js_checks ("check('number', localStorage.get('n') + 1 === 42);\n"
                                          "check('screen', localStorage.get('pos') === undefined);\n"
                                          "check('vec', localStorage.get('pos', 'global').add(new Vec3(1, 0, 0)).x === 2);\n"
                                          "check('deleted', localStorage.get('gone') === undefined);\n");
    for (int run = 0; run < 2; run++) {
        const std::string dir = script_scene (square (1, scripted ("visible", "false", run == 0 ? first
                                                                       : "export function init(value) {\n" + second + "return fails.length == 0;\n}")
                                                         + ",\"origin\":\"8 16 0\""));
        ScriptRig rig;
        rig.storage = storage;
        CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
        rig.step ();
        const std::string got = rig.row ();
        printf ("    load %d: %s\n", run + 1, got.c_str ());
        CHECK (got == covered (4, 11), "load %d: the script's checks failed (see FAILS above)", run + 1);
    }
    const std::string file = std::string (storage) + "/scripts.json";
    const std::string stored = read_file (file);
    printf ("    %s: %s\n", file.c_str (), stored.c_str ());
    unlink (file.c_str ());
    rmdir (storage);
    CHECK (stored.find ("\"n\":41") != std::string::npos, "not stored as a number");
    return true;
}

// ---------------------------------------------------------------------------------------------
// The SceneScript coverage batch (docs/player/spikes/we-coverage.md § 1)

// a property script that runs `checks` once (its first update) and then shows its layer only if they all passed
static std::string checked_once (const std::string& checks) {
    return "let result;\nexport function update(value) {\n  if (result === undefined) {\n" + js_checks (checks)
         + "    result = fails.length == 0;\n  }\n  return result;\n}";
}

// ILayer's transform API: getTransformMatrix (world, with the parent's), rotateObjectSpace (degrees), setParent with
// and without adjustTransforms (and a refused cycle), getParent undefined when unparented, getLayerByID,
// getAttachmentIndex on a layer without a puppet, lookAt, IImageLayer.alignment read and written (the quad moves
// right of its origin). Unpatched: getTransformMatrix and the rest were not functions, alignment undefined
static bool layer_transform_api () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string checks =
        "const m = thisLayer.getTransformMatrix();\n"
        "check('world', m instanceof Mat4 && Math.abs(m.m[12] - 24) < 1e-4 && Math.abs(m.m[13] - 16) < 1e-4);\n"
        "check('parent', thisLayer.getParent().name == 'grp' && thisScene.getLayerByID(10).name == 'grp');\n"
        "const sq2 = thisScene.getLayer('sq2'), sq3 = thisScene.getLayer('sq3'), grp = thisScene.getLayer('grp');\n"
        "check('unparented', sq2.getParent() === undefined);\n"
        "check('align0', sq2.alignment == 'center');\n"
        "sq2.alignment = 'left';\n"
        "check('align1', sq2.alignment == 'left');\n"
        "sq3.angles = new Vec3(0, 0, 0);\n"
        "sq3.rotateObjectSpace(new Vec3(0, 0, 30));\n"
        "sq3.rotateObjectSpace(new Vec3(0, 0, 30));\n"
        "check('rotate', Math.abs(sq3.angles.z - 60) < 1e-3 && Math.abs(sq3.angles.x) < 1e-3);\n"
        "sq3.angles = new Vec3(0, 0, 0);\n"
        "sq3.origin = new Vec3(30, 10, 0);\n"
        "sq3.setParent('grp', true);\n"
        "check('adopt', sq3.getParent().name == 'grp' && Math.abs(sq3.origin.x - 14) < 1e-3"
        " && Math.abs(sq3.getTransformMatrix().m[12] - 30) < 1e-3);\n"
        "sq3.setParent(undefined, true);\n"
        "check('release', sq3.getParent() === undefined && Math.abs(sq3.origin.x - 30) < 1e-3);\n"
        "sq3.setParent(grp);\n"
        "check('keep', Math.abs(sq3.origin.x - 30) < 1e-3 && Math.abs(sq3.getTransformMatrix().m[12] - 46) < 1e-3);\n"
        "grp.setParent(sq3);\n"
        "check('cycle', grp.getParent() === undefined);\n"
        "check('attach', thisLayer.getAttachmentIndex('x') == -1 && thisLayer.getAttachmentMatrix('x') === undefined);\n"
        "sq3.lookAt(new Vec3(30, 10, -100));\n"
        "check('look', sq3.angles.isFinite());\n";
    const std::string dir = script_scene (
        "{\"id\":10,\"name\":\"grp\",\"origin\":\"16 0 0\",\"visible\":true}," + square (1, scripted ("visible", "true", checked_once (checks))
                       + ",\"origin\":\"8 16 0\",\"parent\":10")
        + "," + square (2, "\"origin\":\"48 16 0\"") + "," + square (3, "\"origin\":\"30 10 0\",\"visible\":false"));
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    std::string want = covered (20, 27);
    for (int x = 48; x <= 55; x++) {
        want[x] = '#';
    }
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    CHECK (got == want, "want %s (no square at 20..27: a failed check, see FAILS above; sq2 at 44..51: alignment)",
           want.c_str ());
    return true;
}

// thisScene.createLayer from a configuration (vectors as WE serialises them) and from an asset path, drawn from that
// frame; sortLayer of a created layer; destroyLayer takes a layer out (no longer drawn, not valid, not found by name,
// a second destroy false). Unpatched: createLayer returned undefined, destroyLayer false
static bool create_layer_builds_layers () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string script =
        "export let __workshopId = '77';\n"
        "let made, bar, ok;\n"
        "export function init(value) {\n" + js_checks (
        "made = thisScene.createLayer({ image: 'models/util/solidlayer.json', size: new Vec2(8, 8), color: new Vec3(1, 1, 1),"
        " origin: new Vec3(40, 16, 0) });\n"
        "bar = thisScene.createLayer('models/util/solidlayer.json');\n"
        "const own = thisScene.createLayer('models/own.json');\n"
        "check('workshop', own !== undefined);\n"
        "own.visible = false;\n"
        "check('made', made !== undefined && bar !== undefined && made !== bar);\n"
        "check('count', thisScene.getLayerCount() == 5 && thisScene.getLayerIndex(made) == 2);\n"
        "check('origin', Math.abs(made.origin.x - 40) < 1e-4 && made.size.x == 8);\n"
        "check('sort', thisScene.sortLayer(made, 0) && thisScene.getLayerIndex(made) == 0);\n"
        "bar.visible = false;\n"
        "const gone = thisScene.getLayer('sq2');\n"
        "check('destroy', thisScene.destroyLayer(gone) && !engine.isObjectValid(gone) && engine.isObjectValid(made));\n"
        "check('after', thisScene.getLayerCount() == 4 && thisScene.getLayer('sq2') === undefined && !thisScene.destroyLayer(gone));\n")
        + "  ok = fails.length == 0;\n  return ok;\n}\n"
        "export function update(value) { return ok; }";
    const std::string dir = script_scene (square (1, scripted ("visible", "true", script) + ",\"origin\":\"8 16 0\"") + ","
                                          + square (2, "\"origin\":\"24 16 0\""));
    // the script's own Workshop item's model: `models/own.json` is models/workshop/77/own.json
    mkdir ((dir + "/models").c_str (), 0755);
    mkdir ((dir + "/models/workshop").c_str (), 0755);
    mkdir ((dir + "/models/workshop/77").c_str (), 0755);
    write_file (dir + "/models/workshop/77/own.json", read_file (g_assets + "/models/util/solidlayer.json"));
    ScriptRig rig;
    rig.extra = { "models/workshop/77/own.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    std::string want = covered (4, 11);
    for (int x = 36; x <= 43; x++) {
        want[x] = '#';
    }
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    CHECK (got == want, "want %s (sq1 missing: a failed check, see FAILS above; 36..43: the created layer; 20..27: sq2 "
                        "not destroyed)", want.c_str ());
    return true;
}

// a text script property the scene stores as "0.5, 1, 1" is that string (2 library scenes split it; unpatched it
// was parsed into a Vec3); V8's RegExp.$1 / lastMatch after a match (2932157836's clock; unpatched undefined)
static bool script_strings_and_regexp () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string checks =
        "check('text', typeof scriptProperties.textMin === 'string' && scriptProperties.textMin.split(/\\s*,\\s*/).length == 3);\n"
        "check('vec', scriptProperties.tint instanceof Vec3 && scriptProperties.tint.y == 0.5);\n"
        "check('re1', /(y+)/.test('yyyy-MM') && RegExp.$1 == 'yyyy');\n"
        "'ab12cd'.replace(/(\\d+)/, 'x');\n"
        "check('re2', RegExp.$1 == '12' && RegExp.lastMatch == '12' && RegExp.leftContext == 'ab' && RegExp.rightContext == 'cd');\n";
    std::string prop = scripted ("visible", "true",
                                 "export var scriptProperties = createScriptProperties().addText({ name: 'textMin', value: '1, 1, 1' })"
                                 ".addColor({ name: 'tint', value: new Vec3(1, 1, 1) }).finish();\n"
                                     + checked_once (checks));
    prop.insert (prop.size () - 1, ",\"scriptproperties\":{\"textMin\":\"0.5, 1, 1\",\"tint\":\"1 0.5 0\"}");
    const std::string dir = script_scene (square (1, prop + ",\"origin\":\"8 16 0\""));
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    CHECK (got == covered (4, 11), "the square is hidden: a failed check, see FAILS above");
    return true;
}


// a 1 s, 16 x 16, 10 fps red H.264 video (ffmpeg -f lavfi -i color=c=red:s=16x16:d=1:r=10 -pix_fmt yuv420p -c:v libx264
// -crf 40 -movflags +faststart), as a TEXV0005 / TEXB0004 mp4 texture holds it
static const char kTinyMp4[] =
    "\x00\x00\x00\x20\x66\x74\x79\x70\x69\x73\x6f\x6d\x00\x00\x02\x00\x69\x73\x6f\x6d\x69\x73\x6f\x32\x61\x76\x63\x31\x6d\x70\x34\x31\x00\x00\x03\x8b\x6d\x6f\x6f\x76"
    "\x00\x00\x00\x6c\x6d\x76\x68\x64\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x03\xe8\x00\x00\x03\xe8\x00\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00"
    "\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x40\x00\x00\x00"
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x00\x02\xb6\x74\x72\x61\x6b\x00\x00\x00\x5c"
    "\x74\x6b\x68\x64\x00\x00\x00\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x03\xe8\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    "\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x40\x00\x00\x00"
    "\x00\x10\x00\x00\x00\x10\x00\x00\x00\x00\x00\x24\x65\x64\x74\x73\x00\x00\x00\x1c\x65\x6c\x73\x74\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x03\xe8\x00\x00\x08\x00"
    "\x00\x01\x00\x00\x00\x00\x02\x2e\x6d\x64\x69\x61\x00\x00\x00\x20\x6d\x64\x68\x64\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x28\x00\x00\x00\x28\x00"
    "\x55\xc4\x00\x00\x00\x00\x00\x2d\x68\x64\x6c\x72\x00\x00\x00\x00\x00\x00\x00\x00\x76\x69\x64\x65\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x56\x69\x64\x65"
    "\x6f\x48\x61\x6e\x64\x6c\x65\x72\x00\x00\x00\x01\xd9\x6d\x69\x6e\x66\x00\x00\x00\x14\x76\x6d\x68\x64\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    "\x24\x64\x69\x6e\x66\x00\x00\x00\x1c\x64\x72\x65\x66\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x0c\x75\x72\x6c\x20\x00\x00\x00\x01\x00\x00\x01\x99\x73\x74\x62"
    "\x6c\x00\x00\x00\xc1\x73\x74\x73\x64\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\xb1\x61\x76\x63\x31\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00"
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x10\x00\x10\x00\x48\x00\x00\x00\x48\x00\x00\x00\x00\x00\x00\x00\x01\x14\x4c\x61\x76\x63\x36\x33\x2e\x31\x2e\x31\x30\x32"
    "\x20\x6c\x69\x62\x78\x32\x36\x34\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x18\xff\xff\x00\x00\x00\x37\x61\x76\x63\x43\x01\x64\x00\x0a\xff\xe1\x00\x19\x67"
    "\x64\x00\x0a\xac\x72\x04\x5e\xc0\x44\x00\x00\x03\x00\x04\x00\x00\x03\x00\x50\x3c\x48\x96\x11\x80\x01\x00\x07\x68\xe8\x43\x83\x92\xc8\xb0\xfd\xf8\xf8\x00\x00\x00"
    "\x00\x10\x70\x61\x73\x70\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00\x00\x14\x62\x74\x72\x74\x00\x00\x00\x00\x00\x00\x19\x90\x00\x00\x00\x00\x00\x00\x00\x18\x73\x74"
    "\x74\x73\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x0a\x00\x00\x04\x00\x00\x00\x00\x14\x73\x74\x73\x73\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00"
    "\x00\x38\x63\x74\x74\x73\x00\x00\x00\x00\x00\x00\x00\x05\x00\x00\x00\x01\x00\x00\x08\x00\x00\x00\x00\x01\x00\x00\x28\x00\x00\x00\x00\x01\x00\x00\x10\x00\x00\x00"
    "\x00\x03\x00\x00\x00\x00\x00\x00\x00\x04\x00\x00\x04\x00\x00\x00\x00\x1c\x73\x74\x73\x63\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00\x00\x0a\x00\x00"
    "\x00\x01\x00\x00\x00\x3c\x73\x74\x73\x7a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x0a\x00\x00\x02\xbd\x00\x00\x00\x0d\x00\x00\x00\x0d\x00\x00\x00\x0d\x00\x00"
    "\x00\x0d\x00\x00\x00\x0d\x00\x00\x00\x0d\x00\x00\x00\x0d\x00\x00\x00\x0d\x00\x00\x00\x0d\x00\x00\x00\x14\x73\x74\x63\x6f\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00"
    "\x03\xbb\x00\x00\x00\x61\x75\x64\x74\x61\x00\x00\x00\x59\x6d\x65\x74\x61\x00\x00\x00\x00\x00\x00\x00\x21\x68\x64\x6c\x72\x00\x00\x00\x00\x00\x00\x00\x00\x6d\x64"
    "\x69\x72\x61\x70\x70\x6c\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x2c\x69\x6c\x73\x74\x00\x00\x00\x24\xa9\x74\x6f\x6f\x00\x00\x00\x1c\x64\x61\x74\x61\x00"
    "\x00\x00\x01\x00\x00\x00\x00\x4c\x61\x76\x66\x36\x33\x2e\x31\x2e\x31\x30\x32\x00\x00\x00\x08\x66\x72\x65\x65\x00\x00\x03\x3a\x6d\x64\x61\x74\x00\x00\x02\xa2\x06"
    "\x05\xff\xff\x9e\xdc\x45\xe9\xbd\xe6\xd9\x48\xb7\x96\x2c\xd8\x20\xd9\x23\xee\xef\x78\x32\x36\x34\x20\x2d\x20\x63\x6f\x72\x65\x20\x31\x36\x35\x20\x2d\x20\x48\x2e"
    "\x32\x36\x34\x2f\x4d\x50\x45\x47\x2d\x34\x20\x41\x56\x43\x20\x63\x6f\x64\x65\x63\x20\x2d\x20\x43\x6f\x70\x79\x6c\x65\x66\x74\x20\x32\x30\x30\x33\x2d\x32\x30\x32"
    "\x35\x20\x2d\x20\x68\x74\x74\x70\x3a\x2f\x2f\x77\x77\x77\x2e\x76\x69\x64\x65\x6f\x6c\x61\x6e\x2e\x6f\x72\x67\x2f\x78\x32\x36\x34\x2e\x68\x74\x6d\x6c\x20\x2d\x20"
    "\x6f\x70\x74\x69\x6f\x6e\x73\x3a\x20\x63\x61\x62\x61\x63\x3d\x31\x20\x72\x65\x66\x3d\x31\x36\x20\x64\x65\x62\x6c\x6f\x63\x6b\x3d\x31\x3a\x30\x3a\x30\x20\x61\x6e"
    "\x61\x6c\x79\x73\x65\x3d\x30\x78\x33\x3a\x30\x78\x31\x33\x33\x20\x6d\x65\x3d\x75\x6d\x68\x20\x73\x75\x62\x6d\x65\x3d\x31\x30\x20\x70\x73\x79\x3d\x31\x20\x70\x73"
    "\x79\x5f\x72\x64\x3d\x31\x2e\x30\x30\x3a\x30\x2e\x30\x30\x20\x6d\x69\x78\x65\x64\x5f\x72\x65\x66\x3d\x31\x20\x6d\x65\x5f\x72\x61\x6e\x67\x65\x3d\x32\x34\x20\x63"
    "\x68\x72\x6f\x6d\x61\x5f\x6d\x65\x3d\x31\x20\x74\x72\x65\x6c\x6c\x69\x73\x3d\x32\x20\x38\x78\x38\x64\x63\x74\x3d\x31\x20\x63\x71\x6d\x3d\x30\x20\x64\x65\x61\x64"
    "\x7a\x6f\x6e\x65\x3d\x32\x31\x2c\x31\x31\x20\x66\x61\x73\x74\x5f\x70\x73\x6b\x69\x70\x3d\x31\x20\x63\x68\x72\x6f\x6d\x61\x5f\x71\x70\x5f\x6f\x66\x66\x73\x65\x74"
    "\x3d\x2d\x32\x20\x74\x68\x72\x65\x61\x64\x73\x3d\x31\x20\x6c\x6f\x6f\x6b\x61\x68\x65\x61\x64\x5f\x74\x68\x72\x65\x61\x64\x73\x3d\x31\x20\x73\x6c\x69\x63\x65\x64"
    "\x5f\x74\x68\x72\x65\x61\x64\x73\x3d\x30\x20\x6e\x72\x3d\x30\x20\x64\x65\x63\x69\x6d\x61\x74\x65\x3d\x31\x20\x69\x6e\x74\x65\x72\x6c\x61\x63\x65\x64\x3d\x30\x20"
    "\x62\x6c\x75\x72\x61\x79\x5f\x63\x6f\x6d\x70\x61\x74\x3d\x30\x20\x63\x6f\x6e\x73\x74\x72\x61\x69\x6e\x65\x64\x5f\x69\x6e\x74\x72\x61\x3d\x30\x20\x62\x66\x72\x61"
    "\x6d\x65\x73\x3d\x38\x20\x62\x5f\x70\x79\x72\x61\x6d\x69\x64\x3d\x32\x20\x62\x5f\x61\x64\x61\x70\x74\x3d\x32\x20\x62\x5f\x62\x69\x61\x73\x3d\x30\x20\x64\x69\x72"
    "\x65\x63\x74\x3d\x33\x20\x77\x65\x69\x67\x68\x74\x62\x3d\x31\x20\x6f\x70\x65\x6e\x5f\x67\x6f\x70\x3d\x30\x20\x77\x65\x69\x67\x68\x74\x70\x3d\x32\x20\x6b\x65\x79"
    "\x69\x6e\x74\x3d\x32\x35\x30\x20\x6b\x65\x79\x69\x6e\x74\x5f\x6d\x69\x6e\x3d\x31\x30\x20\x73\x63\x65\x6e\x65\x63\x75\x74\x3d\x34\x30\x20\x69\x6e\x74\x72\x61\x5f"
    "\x72\x65\x66\x72\x65\x73\x68\x3d\x30\x20\x72\x63\x5f\x6c\x6f\x6f\x6b\x61\x68\x65\x61\x64\x3d\x36\x30\x20\x72\x63\x3d\x63\x72\x66\x20\x6d\x62\x74\x72\x65\x65\x3d"
    "\x31\x20\x63\x72\x66\x3d\x34\x30\x2e\x30\x20\x71\x63\x6f\x6d\x70\x3d\x30\x2e\x36\x30\x20\x71\x70\x6d\x69\x6e\x3d\x30\x20\x71\x70\x6d\x61\x78\x3d\x36\x39\x20\x71"
    "\x70\x73\x74\x65\x70\x3d\x34\x20\x69\x70\x5f\x72\x61\x74\x69\x6f\x3d\x31\x2e\x34\x30\x20\x61\x71\x3d\x31\x3a\x31\x2e\x30\x30\x00\x80\x00\x00\x00\x13\x65\x88\x81"
    "\x00\x02\x3f\xfe\x24\x47\xc0\xa4\x87\xea\x60\x8e\x3c\xc8\x15\x61\x00\x00\x00\x09\x41\x9a\x09\x2d\x88\x6f\xff\xab\x80\x00\x00\x00\x09\x41\x9e\x10\x87\x10\x43\xff"
    "\xe0\x81\x00\x00\x00\x09\x01\x9e\x18\x26\x88\x6f\xff\xe5\x80\x00\x00\x00\x09\x01\x9e\x18\x46\x88\x6f\xff\xe5\x81\x00\x00\x00\x09\x01\x9e\x18\x66\x88\x6f\xff\xe5"
    "\x81\x00\x00\x00\x09\x01\x9e\x18\xad\x48\x6f\xff\xe5\x81\x00\x00\x00\x09\x01\x9e\x18\xcd\x48\x6f\xff\xe5\x81\x00\x00\x00\x09\x01\x9e\x18\xed\x48\x6f\xff\xe5\x80"
    "\x00\x00\x00\x09\x01\x9e\x19\x0d\x48\x6f\xff\xe5\x80";

static std::string video_texture () {
    const std::string mp4 (kTinyMp4, sizeof kTinyMp4 - 1);
    MdlWriter t;
    t.out = std::string ("TEXV0005", 8) + '\0' + std::string ("TEXI0001", 8) + '\0';
    t.u32 (0).u32 (32 | 2).u32 (16).u32 (16).u32 (16).u32 (16).u32 (0);
    t.out += std::string ("TEXB0004", 8) + '\0';
    t.u32 (1).u32 (0xffffffff).u32 (1);
    // one image, one mipmap: TEXB0004's editor fields, its size, uncompressed
    t.u32 (1).u32 (0).u32 (0).str ("").u32 (0).u32 (16).u32 (16).u32 (0).u32 (static_cast<uint32_t> (mp4.size ()))
        .u32 (static_cast<uint32_t> (mp4.size ()));
    t.out += mp4;
    return t.out;
}

// IVideoTexture: a layer whose texture is a video gives one (a plain layer undefined); stop / play / pause and
// isPlaying, rate and loop read back, setCurrentTime reaches getCurrentTime, addEndedCallback takes a function.
// Unpatched: getVideoTexture was not a function
static bool video_texture_api () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string checks =
        "const v = thisScene.getLayer('vid').getVideoTexture();\n"
        "check('video', v !== undefined && typeof v.play === 'function');\n"
        "check('plain', thisLayer.getVideoTexture() === undefined);\n"
        "v.loop = false;\n"
        "v.rate = 2;\n"
        "check('settings', v.loop === false && Math.abs(v.rate - 2) < 1e-6);\n"
        "v.stop();\n"
        "check('stop', !v.isPlaying());\n"
        "v.play();\n"
        "check('play', v.isPlaying());\n"
        "v.setCurrentTime(0.5);\n"
        "check('seek', Math.abs(v.getCurrentTime() - 0.5) < 0.15);\n"
        "v.pause();\n"
        "check('pause', !v.isPlaying());\n"
        "v.addEndedCallback(() => {});\n"
        "check('duration', typeof v.duration === 'number');\n";
    // the checks run on a plain square (shown when they pass); the video layers draw on mpv's clock
    const std::string dir = script_scene (
        "{\"id\":1,\"name\":\"vid\",\"image\":\"models/v.json\",\"size\":\"8 8\",\"origin\":\"8 16 0\"},"
        + square (2, scripted ("visible", "false", checked_once (checks)) + ",\"origin\":\"40 16 0\"")
        + ",{\"id\":3,\"name\":\"hidden\",\"image\":\"models/v.json\",\"size\":\"8 8\",\"origin\":\"24 16 0\",\"visible\":false}");
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/materials/v.json", "{\"passes\":[{\"shader\":\"genericimage2\",\"blending\":\"translucent\","
                                           "\"depthtest\":\"disabled\",\"depthwrite\":\"disabled\",\"cullmode\":\"nocull\","
                                           "\"textures\":[\"v\"]}]}\n");
    write_file (dir + "/materials/v.tex", video_texture ());
    write_file (dir + "/models/v.json", "{\"material\":\"materials/v.json\"}\n");
    ScriptRig rig;
    rig.extra = { "materials/v.json", "materials/v.tex", "models/v.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 4; i++) {
        rig.step ();
    }
    unsigned char checked[4] = {}, hidden[4] = {};
    read_pixel (rig.fbo, 40, 16, checked);
    read_pixel (rig.fbo, 24, 16, hidden);
    printf ("    checks' square %d %d %d; hidden video layer %d %d %d\n", checked[0], checked[1], checked[2], hidden[0],
            hidden[1], hidden[2]);
    // mpv sets its own clear colour while it draws a frame: the scene's clear (0 0 0.5) still shows where nothing draws
    CHECK (hidden[2] > 100 && hidden[0] < 30, "the scene's clear colour is gone where nothing draws");
    CHECK (checked[2] < 64, "the checks' square is hidden: a failed check, see FAILS above");
    return true;
}

// IAnimationLayer on a puppet: count, by name and index (the same object), fps / frameCount / name, pause / play /
// isPlaying, rate, a script on the animation layer's visible sees it as thisObject, createAnimationLayer /
// destroyAnimationLayer, addEndedCallback fires as a fast loop wraps; the bones: count, index, parent, a local
// origin set by a script moves the mesh, blend 0 takes the animation off (the square leaves x 22..25 for 6..9).
// Unpatched: getAnimationLayer and the bone methods were not functions
static bool animation_layer_api () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string material = "{\"passes\":[{\"shader\":\"genericimage2\",\"blending\":\"translucent\",\"depthtest\":"
                                 "\"disabled\",\"depthwrite\":\"disabled\",\"cullmode\":\"nocull\",\"textures\":[\"util/white\"]}]}\n";
    MdlWriter a;
    a.out = puppet_mesh (16);
    a.section ("MDLS0001", puppet_skeleton (1)).section ("MDLA0001", puppet_animations (1, { { 7, 8.0f } }));
    const std::string checks =
        "check('count', thisLayer.getAnimationLayerCount() == 1);\n"
        "const anim = thisLayer.getAnimationLayer('walk');\n"
        "check('same', anim !== undefined && anim === thisLayer.getAnimationLayer(0));\n"
        "check('info', anim.name == 'walk' && anim.fps == 1 && anim.frameCount == 1 && anim.duration == 1);\n"
        "check('thisObject', shared.thisObjectIsLayer === true);\n"
        "check('playing', anim.isPlaying());\n"
        "anim.pause();\n"
        "check('paused', !anim.isPlaying());\n"
        "anim.play();\n"
        "anim.rate = 40;\n"
        "check('rate', anim.rate == 40);\n"
        "anim.addEndedCallback(() => { shared.ends = (shared.ends || 0) + 1; });\n"
        "const made = thisLayer.createAnimationLayer('anim', { blend: 0 });\n"
        "check('create', made !== undefined && thisLayer.getAnimationLayerCount() == 2 && made.blend == 0);\n"
        "check('destroy', thisLayer.destroyAnimationLayer(made) && thisLayer.getAnimationLayerCount() == 1);\n"
        "check('bones', thisLayer.getBoneCount() == 1 && thisLayer.getBoneIndex('') == 0 && thisLayer.getBoneParentIndex(0) == -1);\n"
        "anim.blend = 0;\n"
        "check('origin', thisLayer.getLocalBoneOrigin(0).length() < 1e-3);\n"
        "thisLayer.setLocalBoneOrigin(0, new Vec3(-8, 0, 0));\n"
        "check('set', Math.abs(thisLayer.getLocalBoneOrigin(0).x + 8) < 1e-3);\n";
    const std::string script = "let result, frames = 0;\nexport function update(value) {\n  if (result === undefined) {\n"
                             + js_checks (checks) + "    result = fails.length == 0;\n  }\n"
                               "  if (++frames == 6 && !(shared.ends > 0)) { console.log('FAILS ended'); result = false; }\n"
                               "  return result;\n}";
    const std::string onLayer = "export function init(value) { shared.thisObjectIsLayer = thisObject instanceof IAnimationLayer"
                                " && typeof thisObject.addEndedCallback === 'function'; return value; }";
    std::string animLayer = "{\"id\":10,\"name\":\"walk\",\"animation\":7,\"rate\":1,\"blend\":1," + scripted ("visible", "true", onLayer)
                          + "}";
    const std::string objects = "{\"id\":1,\"name\":\"a\",\"image\":\"models/pa.json\",\"origin\":\"16 16 0\",\"size\":\"32 32\","
                                "\"animationlayers\":[" + animLayer + "]," + scripted ("visible", "true", script) + "}";
    const std::string dir = script_scene (objects);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/materials/puppet.json", material);
    write_file (dir + "/models/pa.json", "{\"material\":\"materials/puppet.json\",\"puppet\":\"models/pa.mdl\"}\n");
    write_file (dir + "/models/pa.mdl", a.out);
    ScriptRig rig;
    rig.extra = { "materials/puppet.json", "models/pa.json", "models/pa.mdl" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 8; i++) {
        rig.step ();
    }
    auto lit = [&] (int x) {
        unsigned char px[4] = { 0, 0, 0, 0 };
        read_pixel (rig.fbo, x, 16, px);
        return px[0] > 128;
    };
    printf ("    x 7 %d, x 16 %d, x 24 %d\n", lit (7), lit (16), lit (24));
    CHECK (lit (7) && !lit (16) && !lit (24), "the square isn't at x 6..9 (hidden: a failed check, see FAILS above)");
    return true;
}

// F7: a puppet animation's own events (MDLA's event list: a frame, a name) reach the layer's scripts as
// animationEvent (event, value) when the clock passes them: a one-second loop with events at frames 0 and 1, played
// 1.5 s, gives start:0, end:1, start:0. Unpatched the list was skipped: no events
static bool puppet_animation_events () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string material = "{\"passes\":[{\"shader\":\"genericimage2\",\"blending\":\"translucent\",\"depthtest\":"
                                 "\"disabled\",\"depthwrite\":\"disabled\",\"cullmode\":\"nocull\",\"textures\":[\"util/white\"]}]}\n";
    MdlWriter a;
    a.out = puppet_mesh (16);
    a.section ("MDLS0001", puppet_skeleton (1))
        .section ("MDLA0001", puppet_animations (1, { { 7, 0.0f } }, { { 0, "start" }, { 1, "end" } }));
    const std::string script =
        "let frames = 0, result;\n"
        "export function animationEvent(event, value) { (shared.ev = shared.ev || []).push(event.name + ':' + event.frame); }\n"
        "export function update(value) {\n"
        "  if (++frames == 45) {\n" + js_checks (
        "check('events', shared.ev !== undefined && shared.ev.join(',') == 'start:0,end:1,start:0');\n"
        "if (fails.length) console.log('events ' + shared.ev);\n") + "    result = fails.length == 0;\n  }\n"
        "  return frames < 45 ? true : result;\n}";
    const std::string objects = "{\"id\":1,\"name\":\"a\",\"image\":\"models/pa.json\",\"origin\":\"16 16 0\",\"size\":\"32 32\","
                                "\"animationlayers\":[{\"id\":10,\"name\":\"walk\",\"animation\":7,\"rate\":1,\"blend\":1,\"visible\":true}],"
                                + scripted ("visible", "true", script) + "}";
    const std::string dir = script_scene (objects);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/materials/puppet.json", material);
    write_file (dir + "/models/pa.json", "{\"material\":\"materials/puppet.json\",\"puppet\":\"models/pa.mdl\"}\n");
    write_file (dir + "/models/pa.mdl", a.out);
    ScriptRig rig;
    rig.extra = { "materials/puppet.json", "models/pa.json", "models/pa.mdl" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    while (rig.frames < 48) {
        rig.step ();
    }
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (rig.fbo, 16, 16, px);
    printf ("    the puppet after 1.6 s: %d %d %d\n", px[0], px[1], px[2]);
    CHECK (px[0] > 128, "the puppet is hidden: a failed check, see FAILS above");
    return true;
}

// F3: a 4 x 4 puppet square with vec4 positions (format 0x181000e: position4, normal, tangent, blend indices,
// weights, uv; 84 B), every vertex a morph point (w 1..4), and an MDMP0001 of two targets at scale 8 (mesh flag 0x1000:
// alphas): "stretch" moves the right edge (points 2, 3) +6 px (snorm 0.75 · 8), "fade" moves nothing and has alpha 0
static std::string morph_puppet () {
    MdlWriter w;
    w.str ("MDLV0023").u32 (0x181000e).u32 (1).u32 (1).str ("materials/morph.json");
    w.u32 (1 | 0x1000);
    for (int i = 0; i < 6; i++) {
        w.f32 (0.0f);
    }
    w.u32 (0x181000e);
    MdlWriter verts;
    const float corners[4][2] = { { -2, -2 }, { 2, -2 }, { 2, 2 }, { -2, 2 } };
    for (int v = 0; v < 4; v++) {
        verts.f32 (corners[v][0]).f32 (corners[v][1]).f32 (0.0f).f32 (static_cast<float> (v + 1));
        verts.f32 (0).f32 (0).f32 (1).f32 (1).f32 (0).f32 (0).f32 (1);
        verts.u32 (0).u32 (0).u32 (0).u32 (0).f32 (1).f32 (0).f32 (0).f32 (0);
        verts.f32 (0.5f).f32 (0.5f);
    }
    w.u32 (static_cast<uint32_t> (verts.out.size ()));
    w.out += verts.out;
    const unsigned tris[6] = { 0, 1, 2, 0, 2, 3 };
    w.u32 (24);
    for (unsigned t : tris) {
        w.u32 (t);
    }
    w.u8 (0).u8 (0).u32 (0);
    return w.out;
}

static std::string morph_targets () {
    MdlWriter m;
    m.u16 (2).f32 (8.0f).u32 (4);
    const auto target = [&m] (uint32_t id, const char* name, bool stretch, int16_t alpha) {
        m.u32 (id).u32 (0).str (name).u32 (24);
        for (int p = 0; p < 4; p++) {
            m.u16 (stretch && (p == 1 || p == 2) ? 24575 : 0).u16 (0).u16 (0);
        }
        m.u32 (8);
        for (int p = 0; p < 4; p++) {
            m.u16 (static_cast<uint16_t> (alpha));
        }
    };
    target (1, "stretch", true, 32767);
    target (2, "fade", false, 0);
    return m.out;
}

// one animation (id `id`, 2 samples) holding the bone still, with (MDLA v3) a bone alpha track of `alpha` when it's
// ≥ 0, and (v4) a weight track of 1 for target `shape` when it's ≥ 0
static std::string morph_animation (int id, float alpha, int shape, float x = 0.0f) {
    MdlWriter a;
    a.u32 (1);
    a.u32 (id).u32 (0).str ("anim").str ("loop").f32 (1.0f).u32 (1).u32 (0).u32 (1);
    a.u32 (0).u32 (72);
    for (int k = 0; k < 2; k++) {
        a.f32 (x).f32 (0).f32 (0).f32 (0).f32 (0).f32 (0).f32 (1).f32 (1).f32 (1);
    }
    a.u32 (0); // curves
    if (alpha >= 0.0f) {
        a.u8 (1).u32 (0).u32 (8).f32 (alpha).f32 (alpha);
    } else {
        a.u8 (0);
    }
    if (shape >= 0) {
        a.u8 (1).u32 (1).f32 (8.0f).u16 (1).u16 (shape).u32 (8).f32 (1.0f).f32 (1.0f);
    } else {
        a.u8 (0);
    }
    for (int i = 0; i < 6; i++) {
        a.u32 (0);
    }
    a.u8 (0).u32 (0);
    return a.out;
}

// blend shapes (MDMP0001 + MDLA v4 weight tracks) and bone alpha (MDLA v3 alpha tracks), decoded from the loader GH
// 0x1402873f0 and genericimage4's MORPHING / SKINNING_ALPHA. Four puppets on the 64 x 32 scene (y up), genericimage4:
// A at x 6 whose animation weights "stretch" 1: its square reaches x 4..13 (unpatched 4..7); B at x 26 whose script
// sets "stretch" to 1 by name (and checks getBlendShapeIndex / getBlendShapeWeight; a failed check hides it): x 24..33;
// C at x 44 whose animation's bone alpha is 0, and D at x 56 whose animation weights "fade" (alpha 0) 1: both hidden
// (unpatched drawn)
static bool puppet_blend_shapes_and_alpha () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string material = "{\"passes\":[{\"shader\":\"genericimage4\",\"blending\":\"translucent\",\"depthtest\":"
                                 "\"disabled\",\"depthwrite\":\"disabled\",\"cullmode\":\"nocull\",\"textures\":[\"util/white\"]}]}\n";
    const auto model = [] (float alpha, int shape) {
        MdlWriter m;
        m.out = morph_puppet ();
        m.section ("MDLS0004", puppet_skeleton (4)).section ("MDLA0006", morph_animation (7, alpha, shape))
            .section ("MDMP0001", morph_targets ());
        return m.out;
    };
    const std::string script = checked_once (
        "check('index', thisLayer.getBlendShapeIndex('fade') === 1 && thisLayer.getBlendShapeIndex('nope') === -1);\n"
        "check('unset', thisLayer.getBlendShapeWeight('stretch') === 0);\n"
        "thisLayer.setBlendShapeWeight('stretch', 1);\n"
        "check('weight', Math.abs(thisLayer.getBlendShapeWeight(0) - 1) < 1e-6 && thisLayer.getBlendShapeWeight('fade') === 0);\n");
    const auto layer = [] (int id, const char* json, int x, const std::string& extra) {
        return "{\"id\":" + std::to_string (id) + ",\"name\":\"p" + std::to_string (id) + "\",\"image\":\"models/" + json
             + "\",\"origin\":\"" + std::to_string (x) + " 16 0\",\"size\":\"20 20\","
               "\"animationlayers\":[{\"id\":10,\"animation\":7,\"rate\":1,\"blend\":1,\"visible\":true}]" + extra + "}";
    };
    const std::string objects = layer (1, "ma.json", 6, "") + "," + layer (2, "mb.json", 26, "," + scripted ("visible", "true", script)) + ","
                                + layer (3, "mc.json", 44, "") + "," + layer (4, "md.json", 56, "");
    const std::string dir = script_scene (objects);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/models").c_str (), 0755);
    write_file (dir + "/materials/morph.json", material);
    const std::pair<const char*, std::string> files[] = { { "ma", model (-1.0f, 0) }, { "mb", model (-1.0f, -1) }, { "mc", model (0.0f, -1) }, { "md", model (-1.0f, 1) } };
    ScriptRig rig;
    rig.extra = { "materials/morph.json" };
    for (const auto& [name, mdl] : files) {
        write_file (dir + "/models/" + name + ".json", std::string ("{\"material\":\"materials/morph.json\",\"puppet\":\"models/") + name + ".mdl\"}\n");
        write_file (dir + "/models/" + name + ".mdl", mdl);
        rig.extra.push_back (std::string ("models/") + name + ".json");
        rig.extra.push_back (std::string ("models/") + name + ".mdl");
    }
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    for (int i = 0; i < 4; i++) {
        rig.step ();
    }
    auto lit = [&] (int x, int y) {
        unsigned char px[4] = { 0, 0, 0, 0 };
        read_pixel (rig.fbo, x, y, px);
        return px[0] > 128;
    };
    std::string row;
    for (int x = 0; x < 64; x++) {
        row += lit (x, 16) ? '#' : '.';
    }
    printf ("    row 16: %s\n", row.c_str ());
    CHECK (lit (5, 16) && lit (12, 16) && !lit (15, 16), "the animation's stretch weight doesn't widen A to x 4..13");
    CHECK (lit (25, 16) && lit (32, 16) && !lit (35, 16), "B's script weight doesn't widen it to x 24..33 (or a check failed, see FAILS)");
    CHECK (!lit (44, 16), "C's bone alpha 0 didn't hide it");
    CHECK (!lit (56, 16), "D's fade target (alpha 0) at weight 1 didn't hide it");
    return true;
}

// F4: IScene.createModelData (d.ts 2.8) builds a model from script buffers, createLayer ({ model: data }) draws it (in
// a 2D scene, "1 unit = 1 pixel", the layer's origin its origin), and IModelData.applyData moves it. An 8 x 8 square
// (POSITION, NORMAL, UV; a Uint16Array index buffer) at (48, 24): x 44..51, rows 4..11 of the y-down image; at frame
// 10 applyData shifts its vertices 30 px left. Unpatched: createModelData returned undefined (nothing drawn)
static bool create_model_data_draws () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string script =
        "let frames = 0, data, made;\n"
        "const square = (dx) => new Float32Array([-4 + dx, -4, 0, 0, 0, 1, 0, 1,  4 + dx, -4, 0, 0, 0, 1, 1, 1,\n"
        "  4 + dx, 4, 0, 0, 0, 1, 1, 0,  -4 + dx, 4, 0, 0, 0, 1, 0, 0]);\n"
        "export function update(value) {\n"
        "  frames++;\n"
        "  if (frames == 1) {\n"
        "    data = thisScene.createModelData({ shapes: [{ vertexBuffer: square(0), indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),\n"
        "      vertexFormat: [IModelData.POSITION, IModelData.NORMAL, IModelData.UV], material: engine.registerAsset('materials/md.json') }] });\n"
        "    made = thisScene.createLayer({ model: data, origin: new Vec3(48, 24, 0) });\n"
        "    if (!(data instanceof IModelData) || made === undefined || data.UV !== 'uv') { console.log('FAILS create'); return false; }\n"
        "  }\n"
        "  if (frames == 10) { data.applyData({ vertexBuffer: square(-30) }); }\n"
        "  return true;\n"
        "}";
    const std::string dir = script_scene (square (1, scripted ("visible", "true", script) + ",\"origin\":\"4 28 0\""));
    mkdir ((dir + "/materials").c_str (), 0755);
    write_file (dir + "/materials/md.json", "{\"passes\":[{\"shader\":\"generic4\",\"blending\":\"normal\",\"textures\":[\"util/white\"],"
                                             "\"combos\":{\"LIGHTING\":0,\"FOG\":0}}]}\n");
    ScriptRig rig;
    rig.extra = { "materials/md.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    auto lit = [&] (int x, int y) {
        unsigned char px[4] = { 0, 0, 0, 0 };
        read_pixel (rig.fbo, x, y, px);
        return px[0] > 128;
    };
    auto rowAt = [&] (int y) {
        std::string row;
        for (int x = 0; x < 64; x++) {
            row += lit (x, y) ? '#' : '.';
        }
        return row;
    };
    while (rig.frames < 5) {
        rig.step ();
    }
    const std::string made = rowAt (8);
    const bool madeOk = lit (45, 8) && lit (50, 8) && !lit (42, 8) && !lit (53, 8) && !lit (45, 14);
    while (rig.frames < 15) {
        rig.step ();
    }
    const std::string moved = rowAt (8);
    printf ("    row 8 at frame 5: %s\n    row 8 at frame 15: %s\n", made.c_str (), moved.c_str ());
    CHECK (madeOk, "the script model isn't the 8 px square at x 44..51, rows 4..11");
    CHECK (lit (15, 8) && lit (20, 8) && !lit (48, 8), "applyData didn't move it to x 14..21");
    return true;
}

// IParticleSystem: instance overrides read and write (count, a control point), stop () takes every particle away,
// pause () + emitParticles (5) shows those 5 and no more, isPlaying. Unpatched: instance was undefined, play / stop /
// pause did nothing on a particle system
static bool particle_system_api () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string grey = "{\"name\":\"colorrandom\",\"min\":\"8 8 8\",\"max\":\"8 8 8\"}";
    const std::string still = ",\"distancemin\":0,\"distancemax\":0,\"rate\":10";
    const std::string longLived = particle_system ("add", ",\"maxcount\":100", still,
        grey + ",{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}");
    auto withScript = [] (std::string object, const std::string& script) {
        object.insert (object.size () - 1, "," + scripted ("visible", "true", script));
        return object;
    };
    const std::string stopped = withScript (particle_object (1, "long.json", 8, 16),
        checked_once ("check('count', thisLayer.instance.count == 1);\n"
                      "thisLayer.instance.count = 0.5;\n"
                      "check('set', thisLayer.instance.count == 0.5 && thisLayer.instance === thisLayer.instance);\n"
                      "thisLayer.instance.controlpoint1 = new Vec3(1, 2, 3);\n"
                      "check('cp', thisLayer.instance.controlpoint1.z == 3);\n"
                      "thisLayer.stop();\n"
                      "check('stopped', !thisLayer.isPlaying());\n"));
    const std::string burst = withScript (particle_object (2, "long.json", 24, 16),
        "let done;\nexport function update(value) {\n  if (!done) { done = true; thisLayer.pause(); thisLayer.emitParticles(5); }\n  return true;\n}");
    std::vector<std::string> files;
    const std::string dir = particle_scene (stopped + "," + burst + "," + particle_object (3, "long.json", 40, 16), "0 0 0",
                                            { { "long.json", longLived } }, files);
    ScriptRig rig;
    CHECK (particle_rig_open (rig, dir, files), "load/build of %s failed", dir.c_str ());
    while (rig.frames < 31) {
        rig.step ();
    }
    const double none = stacked (rig, 8, 16), five = stacked (rig, 24, 16), plain = stacked (rig, 40, 16);
    printf ("    after 1 s: stopped %.1f, paused + 5 %.1f, plain %.1f\n", none, five, plain);
    CHECK (none < 0.5, "a stopped system has particles (%.1f; or a failed check, see FAILS above)", none);
    CHECK (five >= 4.5 && five <= 6.5, "paused + emitParticles (5): %.1f", five);
    CHECK (plain >= 8, "the plain system emits (%.1f)", plain);
    return true;
}

// applyGeneralSettings once on load with the language; animationEvent (event, value) as a keyframe timeline passes its
// events (not one past the end); destroy () for a layer a script destroys. Unpatched: none of the three was sent
static bool script_events_reach_scripts () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string onAlpha = "export function animationEvent(event, value) { (shared.events = shared.events || []).push(event.name + ':' + event.frame); }\n"
                                "export function applyGeneralSettings(s) { shared.language = s.language; }";
    const std::string alpha = animated ("alpha", "1", "\"c0\":[" + key (0, 1) + "," + key (20, 1) + "]",
                                        "\"fps\":30,\"length\":20,\"mode\":\"single\",\"events\":[{\"frame\":0,\"name\":\"a\"},"
                                        "{\"frame\":10,\"name\":\"b\"},{\"frame\":30,\"name\":\"never\"}]");
    // the script goes beside the animation: {"value", "animation", "script"}
    std::string escaped;
    for (char c : onAlpha) {
        if (c == '"' || c == '\\') {
            escaped += '\\';
        }
        if (c == '\n') {
            escaped += "\\n";
            continue;
        }
        escaped += c;
    }
    std::string alphaScripted = alpha;
    alphaScripted.insert (alphaScripted.size () - 1, ",\"script\":\"" + escaped + "\"");
    const std::string watcher =
        "let made, frames = 0, result;\n"
        "export function init(value) {\n"
        "  made = thisScene.createLayer({ image: 'models/util/solidlayer.json', size: '8 8', origin: '40 16 0',"
        " visible: { value: true, script: 'export function destroy() { shared.destroyed = true; }' } });\n"
        "}\n"
        "export function update(value) {\n"
        "  if (++frames == 3) { thisScene.destroyLayer(made); }\n"
        "  if (frames == 16) {\n" + js_checks (
        "check('language', typeof shared.language === 'string' && shared.language.length > 0);\n"
        "check('events', shared.events !== undefined && shared.events.join(',') == 'a:0,b:10');\n"
        "if (fails.length) console.log('events: ' + shared.events + ', language: ' + shared.language);\n"
        "check('destroy', shared.destroyed === true);\n") + "    result = fails.length == 0;\n  }\n  return frames < 16 ? true : result;\n}";
    const std::string dir = script_scene (square (1, alphaScripted + ",\"origin\":\"8 16 0\"") + ","
                                          + square (2, scripted ("visible", "true", watcher) + ",\"origin\":\"24 16 0\""));
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    while (rig.frames < 20) {
        rig.step ();
    }
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    std::string want = covered (4, 11);
    for (int x = 20; x <= 27; x++) {
        want[x] = '#';
    }
    CHECK (got == want, "want %s (20..27 missing: a failed check, see FAILS above; 36..43: the layer wasn't destroyed)",
           want.c_str ());
    return true;
}


// F8: the host's wp_project_hint_size is the screen the scene shows on: engine.screenResolution reads it, a change
// sends resizeScreen (size) (WE: on every change of the screen resolution, never on creation), and
// IInput.cursorScreenPosition is in its pixels (the scene covering it: the pointer at 48 8 of the 64×32 scene is 96 16
// of a 128×64 screen). Unpatched: screenResolution was the scene's size, no resizeScreen, the cursor 0..1
static bool resize_screen_reaches_scripts () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string watcher =
        "let frames = 0, result;\n"
        "export function resizeScreen(size) { (shared.sizes = shared.sizes || []).push(size.x + 'x' + size.y); }\n"
        "export function update(value) {\n"
        "  frames++;\n"
        "  if (frames == 1) { shared.first = engine.screenResolution.x + 'x' + engine.screenResolution.y; }\n"
        "  if (frames == 8) {\n" + js_checks (
        "const c = input.cursorScreenPosition;\n"
        "check('first', shared.first == '64x32');\n"
        "check('resized', shared.sizes !== undefined && shared.sizes.join(',') == '128x64');\n"
        "check('resolution', engine.screenResolution.x == 128 && engine.screenResolution.y == 64);\n"
        "check('cursor', Math.abs(c.x - 96) < 1.5 && Math.abs(c.y - 16) < 1.5);\n"
        "if (fails.length) console.log('first ' + shared.first + ' sizes ' + shared.sizes + ' cursor ' + c.x + ' ' + c.y);\n")
        + "    result = fails.length == 0;\n  }\n  return frames < 8 ? true : result;\n}";
    const std::string dir = script_scene (square (1, scripted ("visible", "true", watcher) + ",\"origin\":\"8 16 0\""));
    ScriptRig rig;
    rig.mouse = &g_mouse;
    g_mouseX = 48.0;
    g_mouseY = 8.0;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    wp_project_hint_size (rig.p, 128, 64);
    wp_project_hint_size (rig.p, 128, 64); // the same size again: no second event
    while (rig.frames < 12) {
        rig.step ();
    }
    g_mouseX = 0.0;
    g_mouseY = 0.0;
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    CHECK (got == covered (4, 11), "the square vanished: a check failed (see FAILS above)");
    // a size the host hints before the first frame is the screen from the start: no resizeScreen
    const std::string early =
        "let frames = 0, result;\n"
        "export function resizeScreen(size) { shared.early = size.x; }\n"
        "export function update(value) {\n"
        "  if (++frames == 4) {\n" + js_checks (
        "check('hinted', engine.screenResolution.x == 128 && engine.screenResolution.y == 64);\n"
        "check('no resize', shared.early === undefined);\n") + "    result = fails.length == 0;\n  }\n"
        "  return frames < 4 ? true : result;\n}";
    const std::string dir2 = script_scene (square (1, scripted ("visible", "true", early) + ",\"origin\":\"8 16 0\""));
    ScriptRig rig2;
    rig2.loaded = [] (wp_project* p) { wp_project_hint_size (p, 128, 64); };
    CHECK (rig2.open (dir2), "load/build of %s failed", dir2.c_str ());
    while (rig2.frames < 6) {
        rig2.step ();
    }
    CHECK (rig2.row () == covered (4, 11), "hinted before the first frame: a check failed (see FAILS above)");
    return true;
}

// a material's `alphatocoverage` blending sets the ALPHATOCOVERAGE combo (the stock shaders cut the alpha there and
// discard on GLSL) and draws unblended, `additive` sets ADDITIVE (WE's GH 0x140183570). The layer's shader discards
// under ALPHATOCOVERAGE and drops green under ADDITIVE. Unpatched: alphatocoverage was "unsupported, as normal" (the
// white square drew), additive set no combo (white + blue)
static bool blending_sets_combos () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = script_scene (b9_object (1, 8) + ",{\"id\":2,\"name\":\"add\",\"image\":\"models/b9add.json\","
                                          "\"size\":\"8 8\",\"origin\":\"40 16 0\"}");
    b9_layer (dir, "", "gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);\n#if ALPHATOCOVERAGE\n\tdiscard;\n#endif\n"
                       "#if ADDITIVE\n\tgl_FragColor.g = 0.0;\n#endif");
    std::string material = read_file (dir + "/materials/b9.json");
    const std::string add = material;
    material.replace (material.find ("\"normal\""), 8, "\"alphatocoverage\"");
    write_file (dir + "/materials/b9.json", material);
    std::string additive = add;
    additive.replace (additive.find ("\"normal\""), 8, "\"additive\"");
    write_file (dir + "/materials/b9add.json", additive);
    write_file (dir + "/models/b9add.json", "{\"material\":\"materials/b9add.json\",\"solidlayer\":true}\n");
    ScriptRig rig;
    rig.extra = { "materials/b9add.json", "models/b9add.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    unsigned char cut[4] = {}, summed[4] = {};
    read_pixel (rig.fbo, 8, 16, cut);
    read_pixel (rig.fbo, 40, 16, summed);
    printf ("    alphatocoverage %d %d %d, additive %d %d %d\n", cut[0], cut[1], cut[2], summed[0], summed[1], summed[2]);
    CHECK (cut[0] < 30 && cut[2] > 100, "the alphatocoverage layer drew (no ALPHATOCOVERAGE combo)");
    CHECK (summed[0] > 200 && summed[1] < 30 && summed[2] > 200, "the additive layer isn't 1 0 1 over the clear (no ADDITIVE combo)");
    return true;
}


// F9/E39: a material pass's `alphawriting` (WE: default / enabled / disabled, GH 0x140186aa0). The layer's pass
// writes (1, 1, 1, 0.25) into its composite and an effect after it shows that alpha as grey: by default a pass that
// isn't the last writes alpha (64), with "disabled" it doesn't (the composite's alpha before it). Unpatched the key
// wasn't read: both 64
static bool alphawriting_masks_alpha () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string effect = ",\"effects\":[{\"id\":9,\"name\":\"show\",\"file\":\"effects/show/effect.json\"}]}";
    std::string normal = b9_object (1, 16), masked = "{\"id\":2,\"name\":\"off\",\"image\":\"models/b9off.json\","
                                                     "\"size\":\"8 8\",\"origin\":\"48 16 0\"}";
    normal.pop_back ();
    masked.pop_back ();
    const std::string dir = camera_scene ("\"zoom\":1", normal + effect + "," + masked + effect, "");
    b9_layer (dir, "", "gl_FragColor = vec4(1.0, 1.0, 1.0, 0.25);");
    mkdir ((dir + "/effects").c_str (), 0755);
    mkdir ((dir + "/effects/show").c_str (), 0755);
    write_file (dir + "/shaders/show.vert",
                "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\n"
                "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n\tv_TexCoord = a_TexCoord;\n}\n");
    write_file (dir + "/shaders/show.frag", "uniform sampler2D g_Texture0;\nvarying vec2 v_TexCoord;\nvoid main() {\n"
                                            "\tfloat a = texSample2D(g_Texture0, v_TexCoord).a;\n\tgl_FragColor = vec4(a, a, a, 1.0);\n}\n");
    write_file (dir + "/materials/show.json", "{\"passes\":[{\"shader\":\"show\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                              "\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    write_file (dir + "/effects/show/effect.json", "{\"name\":\"show\",\"passes\":[{\"material\":\"materials/show.json\"}]}\n");
    std::string off = read_file (dir + "/materials/b9.json");
    off.replace (off.find ("\"blending\""), 10, "\"alphawriting\":\"disabled\",\"blending\"");
    write_file (dir + "/materials/b9off.json", off);
    write_file (dir + "/models/b9off.json", "{\"material\":\"materials/b9off.json\",\"solidlayer\":true}\n");
    ScriptRig rig;
    rig.extra = { "materials/b9off.json", "models/b9off.json", "effects/show/effect.json", "shaders/show.vert",
                  "shaders/show.frag", "materials/show.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    unsigned char written[4] = {}, kept[4] = {};
    read_pixel (rig.fbo, 16, 16, written);
    read_pixel (rig.fbo, 48, 16, kept);
    printf ("    the composite's alpha as grey: default %d, alphawriting disabled %d\n", written[0], kept[0]);
    CHECK (written[0] >= 55 && written[0] <= 75, "the default pass didn't write its alpha 0.25 (%d)", written[0]);
    CHECK (kept[0] < 40 || kept[0] > 90, "the alphawriting-disabled pass wrote its alpha (%d)", kept[0]);
    return true;
}

// F9/E26 + fbos.fit: an effect FBO's `fit` caps its longer side (aspect kept, GH 0x140216080: a 16×8 layer's fit 4
// FBO is 4×2) and a `command: swap` pass exchanges two FBOs (the stock fluid simulation's ping-pong): a pass draws
// green into B, the layer shows A, the swap makes A what B was, so from the second frame the layer is green.
// Unpatched the FBO was the layer's 16×8 and the swap pass was dropped (A stayed empty)
static bool effect_fbo_fit_and_swap () {
    if (!script_tests_can_run ()) {
        return true;
    }
    auto layer = [] (int id, int x, const char* effect) {
        return "{\"id\":" + std::to_string (id) + ",\"name\":\"l" + std::to_string (id) + "\",\"image\":\"models/b9.json\","
               "\"size\":\"16 8\",\"origin\":\"" + std::to_string (x) + " 16 0\",\"effects\":[{\"id\":" + std::to_string (id + 10)
             + ",\"name\":\"" + effect + "\",\"file\":\"effects/" + effect + "/effect.json\"}]}";
    };
    const std::string dir = camera_scene ("\"zoom\":1", layer (1, 16, "fit") + "," + layer (2, 48, "swap"), "");
    b9_layer (dir, "", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
    const std::string vert = "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nattribute vec2 a_TexCoord;\n"
                             "varying vec2 v_TexCoord;\nvoid main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), "
                             "g_ModelViewProjectionMatrix);\n\tv_TexCoord = a_TexCoord;\n}\n";
    auto shader = [&] (const std::string& name, const std::string& frag) {
        write_file (dir + "/shaders/" + name + ".vert", vert);
        write_file (dir + "/shaders/" + name + ".frag", frag);
        write_file (dir + "/materials/" + name + ".json", "{\"passes\":[{\"shader\":\"" + name + "\",\"cullmode\":\"nocull\","
                    "\"depthtest\":\"disabled\",\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    };
    shader ("green", "void main() {\n\tgl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);\n}\n");
    shader ("size", "uniform sampler2D g_Texture1;\nuniform vec4 g_Texture1Resolution;\nvoid main() {\n"
                    "\tgl_FragColor = vec4(g_Texture1Resolution.x / 16.0, g_Texture1Resolution.y / 16.0, 0.0, 1.0);\n}\n");
    shader ("show", "uniform sampler2D g_Texture0;\nvarying vec2 v_TexCoord;\nvoid main() {\n"
                    "\tgl_FragColor = vec4(texSample2D(g_Texture0, v_TexCoord).rgb, 1.0);\n}\n");
    mkdir ((dir + "/effects").c_str (), 0755);
    mkdir ((dir + "/effects/fit").c_str (), 0755);
    mkdir ((dir + "/effects/swap").c_str (), 0755);
    write_file (dir + "/effects/fit/effect.json",
                "{\"name\":\"fit\",\"fbos\":[{\"name\":\"_rt_small\",\"fit\":4,\"format\":\"rgba8888\"}],\"passes\":["
                "{\"material\":\"materials/green.json\",\"target\":\"_rt_small\"},"
                "{\"material\":\"materials/size.json\",\"bind\":[{\"name\":\"_rt_small\",\"index\":1}]}]}\n");
    write_file (dir + "/effects/swap/effect.json",
                "{\"name\":\"swap\",\"fbos\":[{\"name\":\"_rt_A\",\"unique\":true,\"format\":\"rgba8888\"},"
                "{\"name\":\"_rt_B\",\"unique\":true,\"format\":\"rgba8888\"}],\"passes\":["
                "{\"material\":\"materials/green.json\",\"target\":\"_rt_B\"},"
                "{\"material\":\"materials/show.json\",\"bind\":[{\"name\":\"_rt_A\",\"index\":0}]},"
                "{\"command\":\"swap\",\"source\":\"_rt_A\",\"target\":\"_rt_B\"}]}\n");
    ScriptRig rig;
    rig.extra = { "effects/fit/effect.json", "effects/swap/effect.json", "shaders/green.vert", "shaders/green.frag",
                  "shaders/size.vert", "shaders/size.frag", "shaders/show.vert", "shaders/show.frag", "materials/green.json",
                  "materials/size.json", "materials/show.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    unsigned char sized[4] = {}, shown[4] = {};
    read_pixel (rig.fbo, 16, 16, sized);
    read_pixel (rig.fbo, 48, 16, shown);
    printf ("    fit-4 FBO of a 16x8 layer: %.1f x %.1f; swapped A after two frames: %d %d %d\n", sized[0] * 16.0 / 255.0,
            sized[1] * 16.0 / 255.0, shown[0], shown[1], shown[2]);
    CHECK (sized[0] >= 60 && sized[0] <= 68 && sized[1] >= 28 && sized[1] <= 36, "the fit FBO isn't 4x2 (%d %d)", sized[0], sized[1]);
    CHECK (shown[1] > 200 && shown[0] < 30, "A doesn't hold what was drawn into B (no swap: %d %d %d)", shown[0], shown[1], shown[2]);
    return true;
}

// TEX<n>FORMAT: WE defines it for every `formatcombo` sampler, to the format of the texture bound there (GH
// 0x1401d2a20). An effect pass binds an r8 FBO at slot 1 and an rg88 one at slot 2: TEX1FORMAT is FORMAT_R8 (9),
// TEX2FORMAT FORMAT_RG88 (8) — the layer turns green. Unpatched only TEX0FORMAT was set: both 0, red
static bool texture_format_combos_per_slot () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::string object = b9_object (1, 16);
    object.pop_back ();
    object += ",\"effects\":[{\"id\":2,\"name\":\"fmt\",\"file\":\"effects/fmt/effect.json\"}]}";
    const std::string dir = camera_scene ("\"zoom\":1", object, "");
    b9_layer (dir, "", "gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0);");
    write_file (dir + "/shaders/fmt.vert", "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nvoid main() {\n"
                                           "\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n}\n");
    write_file (dir + "/shaders/fmt.frag",
                "uniform sampler2D g_Texture1; // {\"material\":\"one\",\"formatcombo\":true}\n"
                "uniform sampler2D g_Texture2; // {\"material\":\"two\",\"formatcombo\":true}\n"
                "void main() {\n#if TEX1FORMAT == 9 && TEX2FORMAT == 8\n\tgl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);\n#else\n"
                "\tgl_FragColor = vec4(1.0, 0.0, float(TEX1FORMAT) / 16.0, 1.0);\n#endif\n}\n");
    write_file (dir + "/materials/fmt.json", "{\"passes\":[{\"shader\":\"fmt\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                             "\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    mkdir ((dir + "/effects").c_str (), 0755);
    mkdir ((dir + "/effects/fmt").c_str (), 0755);
    write_file (dir + "/effects/fmt/effect.json",
                "{\"name\":\"fmt\",\"fbos\":[{\"name\":\"_rt_red\",\"format\":\"r8\"},{\"name\":\"_rt_rg\",\"format\":\"rg88\"}],"
                "\"passes\":[{\"material\":\"materials/fmt.json\",\"bind\":[{\"name\":\"_rt_red\",\"index\":1},"
                "{\"name\":\"_rt_rg\",\"index\":2}]}]}\n");
    ScriptRig rig;
    rig.extra = { "effects/fmt/effect.json", "shaders/fmt.vert", "shaders/fmt.frag", "materials/fmt.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto px = b9_pixel (rig);
    printf ("    a pass binding r8 at 1 and rg88 at 2: %d %d %d (green: TEX1FORMAT 9, TEX2FORMAT 8)\n", px[0], px[1], px[2]);
    CHECK (px[1] > 200 && px[0] < 30, "TEX1FORMAT / TEX2FORMAT aren't the bound FBOs' formats (%d %d %d)", px[0], px[1], px[2]);
    return true;
}

// IScene: get/setCameraTransforms (the scene's camera, a CameraTransforms), getInitialLayerConfig (the object as the
// scene file has it), getAnimation (a named keyframe timeline), getLayerByID; a camera object's ICamera zoom;
// renderContext exists. Unpatched: none of these existed (getAnimation, the camera methods: not functions)
static bool scene_camera_and_config_api () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string checks =
        "const t = thisScene.getCameraTransforms();\n"
        "check('camera', t instanceof CameraTransforms && t.eye instanceof Vec3 && t.center.z == -1 && t.up.y == 1 && t.zoom == 1);\n"
        "t.zoom = 1;\n"
        "thisScene.setCameraTransforms(t);\n"
        "check('config', thisScene.getInitialLayerConfig('sq2').origin == '24 16 0' && thisScene.getInitialLayerConfig(thisLayer).id == 1);\n"
        "const a = thisScene.getAnimation('fade');\n"
        "check('animation', a !== undefined && a.name == 'fade' && a.fps == 30);\n"
        "a.rate = 2;\n"
        "check('rate', a.rate == 2);\n"
        "check('cam', thisScene.getLayer('cam').zoom == 1);\n"
        "check('render', typeof renderContext === 'object');\n";
    const std::string dir = script_scene (
        square (1, scripted ("visible", "false", checked_once (checks)) + ",\"origin\":\"8 16 0\"") + ","
        + square (2, animated ("alpha", "1", "\"c0\":[" + key (0, 1) + "," + key (10, 1) + "]", "\"fps\":30,\"length\":10,\"name\":\"fade\"")
                         + ",\"origin\":\"24 16 0\"")
        + ",{\"id\":5,\"name\":\"cam\",\"camera\":\"default\",\"zoom\":1,\"origin\":\"0 0 0\"}");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    rig.step ();
    const std::string got = rig.row ();
    printf ("    %s\n", got.c_str ());
    std::string want = covered (4, 11);
    for (int x = 20; x <= 27; x++) {
        want[x] = '#';
    }
    CHECK (got == want, "want %s (4..11 missing: a failed check, see FAILS above)", want.c_str ());
    return true;
}


// ISoundLayer from a script: play () starts a startsilent sound, pause () silences it and play () resumes it,
// volume is live (0.5 → 0.25 gain), stop () silences it for good (unpatched: getLayer could not return a sound)
static bool script_controls_a_sound () {
    if (!sound_tests_can_run ()) {
        return true;
    }
    const std::string script = "export function applyUserProperties(p) {\n"
                               "  const s = thisScene.getLayer('snd');\n"
                               "  if (p.cmd === 1) { s.play(); }\n"
                               "  if (p.cmd === 2) { s.pause(); }\n"
                               "  if (p.cmd === 3) { s.stop(); }\n"
                               "  if (p.cmd === 4) { s.volume = 0.5; }\n"
                               "}";
    const std::string dir = sound_scene (
        "{\"id\":1,\"name\":\"snd\",\"sound\":[\"a.wav\"],\"startsilent\":true},"
            + square (2, scripted ("visible", "true", script) + ",\"origin\":\"8 16 0\""),
        "\"cmd\":{\"type\":\"slider\",\"value\":0,\"min\":0,\"max\":9,\"text\":\"c\"}",
        { { "a.wav", tone_wav (0.4f, 2.0) } });
    SoundRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    auto run = [&] (int steps) {
        float peak = 0.0f;
        for (int i = 0; i < steps; i++) {
            peak = std::fmax (peak, rig.step ());
        }
        return peak;
    };
    const float silent = run (15);
    CHECK (wp_project_property_set_slider_by_name (rig.p, "cmd", 1.0f), "slider refused");
    rig.until_above (0.1f);
    const float played = run (5);
    CHECK (wp_project_property_set_slider_by_name (rig.p, "cmd", 2.0f), "slider refused");
    run (3);
    const float paused = run (10);
    CHECK (wp_project_property_set_slider_by_name (rig.p, "cmd", 1.0f), "slider refused");
    rig.until_above (0.1f);
    const float resumed = run (5);
    CHECK (wp_project_property_set_slider_by_name (rig.p, "cmd", 4.0f), "slider refused");
    run (3);
    const float quieter = run (5);
    CHECK (wp_project_property_set_slider_by_name (rig.p, "cmd", 3.0f), "slider refused");
    run (3);
    const float stopped = run (30);
    printf ("    startsilent %.3f; play %.3f; pause %.3f; play again %.3f; volume 0.5 %.3f; stop %.3f\n", silent, played,
            paused, resumed, quieter, stopped);
    CHECK (silent < 1e-4f, "startsilent was audible (%.3f)", silent);
    CHECK (std::fabs (played - 0.4f) < 0.02f, "play: peak %.3f, want 0.4", played);
    CHECK (paused < 1e-4f, "pause: still audible (%.3f)", paused);
    CHECK (std::fabs (resumed - 0.4f) < 0.02f, "play after pause: peak %.3f", resumed);
    CHECK (std::fabs (quieter - 0.1f) < 0.01f, "volume 0.5: peak %.3f, want 0.1 (0.4 x 0.5²)", quieter);
    CHECK (stopped < 1e-4f, "stop: still audible (%.3f)", stopped);
    return true;
}

// ---- B8: the audio spectrum (wp_context_audio_input_push / wp_context_audio_spectrum) ----

// a context fed `seconds` of a tone per channel (frequency 0 = silence), `fps` frames a second at `rate` Hz,
// wp_render_update_time after each push (the frame tick that smooths the spectrum)
struct SpectrumRig {
    wp_configuration* cfg = nullptr;
    wp_context* ctx = nullptr;
    double phase[2] = { 0.0, 0.0 };
    double pending = 0.0;

    SpectrumRig () {
        g_now = 0.0f;
        cfg = wp_config_create ();
        wp_config_set_audio_output (cfg, &kStereo48k);
        ctx = wp_context_create (cfg);
        wp_context_set_time_counter (ctx, &g_clock);
    }
    ~SpectrumRig () {
        wp_context_destroy (ctx);
        wp_config_destroy (cfg);
    }
    void feed (double seconds, double fps, double fl, double fr, int rate = 48000, int channels = 2, float amp = 0.5f) {
        const int frames = static_cast<int> (std::lround (seconds * fps));
        std::vector<float> buf;
        for (int f = 0; f < frames; f++) {
            pending += rate / fps;
            const int n = static_cast<int> (pending);
            pending -= n;
            buf.assign (static_cast<size_t> (n) * channels, 0.0f);
            for (int i = 0; i < n; i++) {
                for (int c = 0; c < channels; c++) {
                    const double freq = c == 0 ? fl : fr;
                    buf[static_cast<size_t> (i) * channels + c]
                        = freq > 0.0 ? amp * static_cast<float> (std::sin (phase[c])) : 0.0f;
                    phase[c] += 2.0 * M_PI * freq / rate;
                }
            }
            if (n > 0) {
                wp_context_audio_input_push (ctx, buf.data (), n, channels, rate);
            }
            g_now += static_cast<float> (1.0 / fps);
            wp_render_update_time (ctx);
        }
    }
    // just time passing (no input)
    void idle (double seconds, double fps) {
        const int frames = static_cast<int> (std::lround (seconds * fps));
        for (int f = 0; f < frames; f++) {
            g_now += static_cast<float> (1.0 / fps);
            wp_render_update_time (ctx);
        }
    }
    std::vector<float> bands (int resolution, int channel) const {
        std::vector<float> out (resolution, -1.0f);
        wp_context_audio_spectrum (ctx, resolution, channel, out.data ());
        return out;
    }
};

static int loudest (const std::vector<float>& v) {
    return static_cast<int> (std::max_element (v.begin (), v.end ()) - v.begin ());
}

// WE's band of an FFT bin (GH 0x140103630): bins 1..639, pow ((i−1)/639, 0.25)·64, at most one band past the
// previous bin's. A tone's bin at 48 kHz: f / (48000 / 2089)
static int we_band_of (double freq, int rate) {
    const int size = static_cast<int> (std::max (rate / 44100.0f, 1.0f) * 64.0f * 30.0f);
    const int bin = static_cast<int> (std::lround (freq / (static_cast<double> (rate) / size)));
    int band = 0;
    for (int i = 1; i <= bin; i++) {
        band = std::min (band + 1, static_cast<int> (std::pow ((i - 1) / 639.0f, 0.25f) * 64.0f) & 63);
    }
    return band;
}

// a tone lands in WE's band for its frequency (bass bins one band each, then the pow mapping), at 44.1 and 48 kHz
// (unpatched: 64 linear bins of 21.5 Hz, u8 mono, so 5 kHz fell outside the spectrum)
static bool audio_tones_land_in_we_bands () {
    for (const int rate : { 48000, 44100 }) {
        for (const double freq : { 100.0, 440.0, 1000.0, 5000.0, 12000.0 }) {
            SpectrumRig rig;
            rig.feed (1.5, 60.0, freq, freq, rate);
            const auto left = rig.bands (64, 0);
            const int got = loudest (left), want = we_band_of (freq, rate);
            printf ("    %5d Hz %6.0f Hz tone → band %2d (WE's %2d), value %.3f\n", rate, freq, got, want, left[got]);
            CHECK (std::abs (got - want) <= 1, "%.0f Hz at %d Hz: loudest band %d, want %d", freq, rate, got, want);
            CHECK (left[got] > 0.05f, "%.0f Hz: band %d only %.4f", freq, got, left[got]);
        }
    }
    return true;
}

// left and right are their own channels, the average is their mean, 32/16 bands are the max of pairs; a mono
// input reads the same on both sides (unpatched: right was left's array)
static bool audio_left_right_and_resolutions () {
    SpectrumRig rig;
    rig.feed (1.5, 60.0, 1000.0, 5000.0);
    const auto l = rig.bands (64, 0), r = rig.bands (64, 1), a = rig.bands (64, 2);
    const int bl = loudest (l), br = loudest (r);
    printf ("    1 kHz left → left band %d (%.3f; right there %.3f), 5 kHz right → right band %d (%.3f; left there %.3f)\n",
            bl, l[bl], r[bl], br, r[br], l[br]);
    CHECK (std::abs (bl - we_band_of (1000.0, 48000)) <= 1 && std::abs (br - we_band_of (5000.0, 48000)) <= 1,
           "bands %d / %d", bl, br);
    CHECK (r[bl] < 0.2f * l[bl] && l[br] < 0.2f * r[br], "channels leak: %.3f / %.3f", r[bl], l[br]);
    bool mean = true, pairs = true;
    for (int c = 0; c < 3; c++) {
        const auto b64 = rig.bands (64, c), b32 = rig.bands (32, c), b16 = rig.bands (16, c);
        for (int i = 0; i < 32; i++) {
            pairs = pairs && b32[i] == std::max (b64[2 * i], b64[2 * i + 1]);
        }
        for (int i = 0; i < 16; i++) {
            pairs = pairs && b16[i] == std::max (b32[2 * i], b32[2 * i + 1]);
        }
    }
    for (int i = 0; i < 64; i++) {
        mean = mean && std::fabs (a[i] - 0.5f * (l[i] + r[i])) < 1e-6f;
    }
    CHECK (mean, "average isn't (left + right) / 2");
    CHECK (pairs, "32/16 bands aren't the max of pairs");
    float none[16];
    CHECK (!wp_context_audio_spectrum (rig.ctx, 20, 0, none) && !wp_context_audio_spectrum (rig.ctx, 16, 3, none),
           "a bad resolution/channel was accepted");

    SpectrumRig mono;
    mono.feed (1.5, 60.0, 1000.0, 0.0, 48000, 1);
    const auto ml = mono.bands (64, 0), mr = mono.bands (64, 1);
    CHECK (ml == mr && ml[loudest (ml)] > 0.05f, "mono: right isn't left");
    return true;
}

// the smoothing runs on the frame's dt: 30 and 144 fps reach the same values; a second without input is silence;
// a context never fed stays at zero (unpatched: movetowards 0.3 per frame)
static bool audio_smoothing_is_dt_based () {
    SpectrumRig slow, fast;
    slow.feed (2.0, 30.0, 440.0, 440.0);
    fast.feed (2.0, 144.0, 440.0, 440.0);
    const auto a = slow.bands (64, 0), b = fast.bands (64, 0);
    const int k = loudest (a);
    printf ("    440 Hz for 2 s: band %d = %.3f at 30 fps, %.3f at 144 fps\n", k, a[k], b[k]);
    CHECK (loudest (b) == k && std::fabs (a[k] - b[k]) < 0.1f * a[k], "30 vs 144 fps: %.3f vs %.3f", a[k], b[k]);

    // the follow is limited to 40/s: 0.1 s after a step it has moved ≤ 4 (at 60 fps ≈ 0.07 s of rise per frame)
    SpectrumRig step;
    step.feed (0.05, 60.0, 440.0, 440.0);
    const float early = step.bands (64, 0)[k];
    step.idle (1.2, 60.0);
    const auto after = step.bands (64, 0);
    printf ("    after 3 frames %.3f; 1.2 s without input → max %.4f\n", early, after[loudest (after)]);
    CHECK (after[loudest (after)] == 0.0f, "input stopped 1.2 s ago, band still %.4f", after[loudest (after)]);

    SpectrumRig unfed;
    unfed.idle (0.5, 60.0);
    const auto z = unfed.bands (64, 2);
    CHECK (z[loudest (z)] == 0.0f, "an unfed context has a spectrum");
    return true;
}

// one step of a rig with `freq` Hz (0 = silence) in the left channel only: 1/30 s of 48 kHz stereo
static void step_with_left_tone (ScriptRig& rig, double freq, double& phase) {
    std::vector<float> buf (1600 * 2, 0.0f);
    for (int i = 0; i < 1600; i++) {
        buf[2 * i] = freq > 0.0 ? 0.5f * static_cast<float> (std::sin (phase)) : 0.0f;
        phase += 2.0 * M_PI * freq / 48000.0;
    }
    wp_context_audio_input_push (rig.ctx, buf.data (), 1600, 2, 48000);
    rig.step ();
}

// the spectrum reaches g_AudioSpectrum16Left/Right (their own channels), engine.registerAudioBuffers (only at a
// module's top level, 16/32/64 only) and an emitter's audioprocessingmode (left / right) (unpatched: Right = Left,
// registerAudioBuffers was undefined so the module failed, emitters ignored the audio)
static bool audio_reaches_shaders_scripts_and_emitters () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string script = "const ab = engine.registerAudioBuffers(engine.AUDIO_RESOLUTION_16);\n"
                               "let bad = '';\n"
                               "try { engine.registerAudioBuffers(20); } catch (e) { bad = e.message; }\n"
                               "export function update(value) {\n"
                               "  let inside = '';\n"
                               "  try { engine.registerAudioBuffers(16); } catch (e) { inside = e.message; }\n"
                               "  if (bad != 'Resolution must be either 16, 32 or 64.' || inside.indexOf('global scope') < 0\n"
                               "      || ab.left.length != 16 || ab.right.length != 16 || ab.average.length != 16) {\n"
                               "    console.log('FAILS ' + bad + ' / ' + inside);\n"
                               "    return false;\n"
                               "  }\n"
                               "  return ab.left[0] > 0.2 && ab.right[0] < 0.05 && Math.abs(ab.average[0] - ab.left[0] / 2) < 1e-6;\n"
                               "}";
    const std::string dir
        = script_scene (b9_object (1, 16) + "," + square (2, scripted ("visible", "false", script) + ",\"origin\":\"40 16 0\""));
    b9_layer (dir, "uniform float g_AudioSpectrum16Left[16];\nuniform float g_AudioSpectrum16Right[16];\n",
              "gl_FragColor = vec4(min(g_AudioSpectrum16Left[0], 1.0), min(g_AudioSpectrum16Right[0], 1.0), 0.0, 1.0);");
    ScriptRig rig;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    double phase = 0.0;
    for (int i = 0; i < 3; i++) {
        step_with_left_tone (rig, 0.0, phase);
    }
    std::array<unsigned char, 4> quiet {};
    read_pixel (rig.fbo, 16, 16, quiet.data ());
    const bool shownQuiet = rig.row ()[40] == '#';
    for (int i = 0; i < 30; i++) {
        step_with_left_tone (rig, 100.0, phase);
    }
    std::array<unsigned char, 4> loud {};
    read_pixel (rig.fbo, 16, 16, loud.data ());
    const bool shownLoud = rig.row ()[40] == '#';
    printf ("    shader: silence r=%d g=%d, a 100 Hz tone on the left r=%d g=%d; the script's square: %s → %s\n", quiet[0],
            quiet[1], loud[0], loud[1], shownQuiet ? "shown" : "hidden", shownLoud ? "shown" : "hidden");
    CHECK (quiet[0] < 3 && quiet[1] < 3, "silence drew r=%d g=%d", quiet[0], quiet[1]);
    CHECK (loud[0] > 100 && loud[1] < 10, "left tone: r=%d g=%d (want left only)", loud[0], loud[1]);
    CHECK (!shownQuiet && shownLoud, "registerAudioBuffers: square %d → %d (see FAILS above)", shownQuiet, shownLoud);

    // emitters: rate 10 at full level; mode 1 listens to the left, mode 2 to the right
    const std::string grey = "{\"name\":\"colorrandom\",\"min\":\"8 8 8\",\"max\":\"8 8 8\"},"
                             "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    const auto system = [&grey] (int mode) {
        return particle_system ("add", ",\"maxcount\":100",
                                ",\"distancemin\":0,\"distancemax\":0,\"rate\":10,\"audioprocessingmode\":" + std::to_string (mode),
                                grey);
    };
    std::vector<std::string> files;
    const std::string pdir = particle_scene (particle_object (1, "left.json", 16, 16) + "," + particle_object (2, "right.json", 48, 16),
                                             "0 0 0", { { "left.json", system (1) }, { "right.json", system (2) } }, files);
    ScriptRig prig;
    CHECK (particle_rig_open (prig, pdir, files), "load/build of %s failed", pdir.c_str ());
    phase = 0.0;
    for (int i = 0; i < 15; i++) {
        step_with_left_tone (prig, 0.0, phase);
    }
    const double silentLeft = stacked (prig, 16, 16), silentRight = stacked (prig, 48, 16);
    for (int i = 0; i < 45; i++) {
        step_with_left_tone (prig, 100.0, phase);
    }
    const double left = stacked (prig, 16, 16), right = stacked (prig, 48, 16);
    printf ("    emitters (rate 10): silence 0.5 s → left %.1f right %.1f; then a left tone 1.5 s → left %.1f right %.1f\n",
            silentLeft, silentRight, left, right);
    CHECK (silentLeft < 0.5 && silentRight < 0.5, "silence emitted (%.1f / %.1f)", silentLeft, silentRight);
    CHECK (left >= 9.0 && left <= 16.5, "the left emitter: %.1f particles in 1.5 s of a loud left tone", left);
    CHECK (right < 0.5, "the right emitter emitted for a left-only tone (%.1f)", right);
    return true;
}

// ---------------------------------------------------------------------------------------------
// B4 (docs/player/spikes/we-lwe-gap-audit.md): text layers are image layers (WE's text class extends its image
// class) laid out the way WE lays text out (GH 0x1401dd330, 0x14027c600), in WE's NotoSans from the assets dir.
// White text on the 0 0 0.5 clear colour of a 256 x 128 scene, read back as the box of its lit pixels

// a scene folder of the given objects, `w` x `h`
static std::string sized_scene (const std::string& objects, int w, int h) {
    const std::string d = script_scene (objects);
    if (!d.empty ()) {
        write_file (d + "/scene.json", "{\"camera\":{\"center\":\"0 0 -1\",\"eye\":\"0 0 0\",\"up\":\"0 1 0\"},"
                                       "\"general\":{\"clearcolor\":\"0 0 0.5\",\"orthogonalprojection\":{\"width\":"
                                           + std::to_string (w) + ",\"height\":" + std::to_string (h) + "}},\"objects\":[" + objects + "]}\n");
    }
    return d;
}

// a text object in NotoSans; `props` is the rest of its JSON members
static std::string text_object (int id, const std::string& text, const std::string& props) {
    return "{\"id\":" + std::to_string (id) + ",\"name\":\"t" + std::to_string (id)
         + "\",\"font\":\"fonts/NotoSans-Regular.ttf\",\"text\":\"" + text + "\",\"color\":\"1.0 1.0 1.0\"," + props + "}";
}

struct InkBox {
    int x0 = 1 << 20, y0 = 1 << 20, x1 = -1, y1 = -1, count = 0;
    [[nodiscard]] int width () const { return count ? x1 - x0 + 1 : 0; }
    [[nodiscard]] int height () const { return count ? y1 - y0 + 1 : 0; }
    [[nodiscard]] float cx () const { return (x0 + x1) * 0.5f; }
    [[nodiscard]] float cy () const { return (y0 + y1) * 0.5f; }
};

// the box of the pixels lit by text (red over half: the clear colour has none) in x0..x1, y up from the bottom;
// `red` counts only red text (green under 100)
static InkBox ink_box (ScriptRig& rig, int fromX = 0, int toX = 1 << 20, bool red = false) {
    InkBox box;
    for (int y = 0; y < rig.height; y++) {
        for (int x = std::max (0, fromX); x < std::min (rig.width, toX + 1); x++) {
            unsigned char px[4] = { 0, 0, 0, 0 };
            read_pixel (rig.fbo, x, y, px);
            if (px[0] > 128 && (!red || px[1] < 100)) {
                box.x0 = std::min (box.x0, x);
                box.x1 = std::max (box.x1, x);
                box.y0 = std::min (box.y0, y);
                box.y1 = std::max (box.y1, y);
                box.count++;
            }
        }
    }
    return box;
}

// one text object alone in a 256 x 128 scene: its ink after two frames
static bool one_text (const std::string& object, InkBox& box, int w = 256, int h = 128) {
    ScriptRig rig;
    rig.width = w;
    rig.height = h;
    if (!rig.open (sized_scene (object, w, h))) {
        return false;
    }
    rig.step ();
    box = ink_box (rig);
    return true;
}

// a text layer's origin is in its parent's space and it turns with `angles` (G04, G30; unpatched: the raw local
// origin, upright)
static bool text_follows_its_parent_and_turns () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = sized_scene (
        "{\"id\":10,\"name\":\"group\",\"origin\":\"160 64 0\",\"scale\":\"1 1 1\",\"angles\":\"0 0 0\"},"
            + text_object (1, "H", "\"pointsize\":6,\"origin\":\"20 0 0\",\"parent\":10") + ","
            + text_object (2, "IIIIIIII", "\"pointsize\":6,\"origin\":\"60 64 0\",\"angles\":\"0 0 1.5707964\""),
        256, 128);
    ScriptRig rig;
    rig.width = 256;
    rig.height = 128;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const InkBox child = ink_box (rig, 130), turned = ink_box (rig, 0, 129);
    printf ("    child of the group at 160 64 (its origin 20 0): x %d..%d y %d..%d; turned 90°: %d x %d\n", child.x0, child.x1,
            child.y0, child.y1, turned.width (), turned.height ());
    CHECK (child.count > 0 && std::fabs (child.cx () - 180.0f) <= 4.0f && std::fabs (child.cy () - 64.0f) <= 12.0f,
           "the child isn't at 180 64 (%.1f %.1f)", child.cx (), child.cy ());
    CHECK (turned.count > 0 && turned.height () > 2 * turned.width (), "the turned text isn't upright-tall (%d x %d)",
           turned.width (), turned.height ());
    return true;
}

// WE's size (300 dpi), lines, alignment and UTF-8 (T2, T3, T4, T10; unpatched: pointsize as pixels, one line with a
// missing glyph for "\n", always centred, bytes as Latin-1)
static bool text_lays_out_like_we () {
    if (!script_tests_can_run ()) {
        return true;
    }
    InkBox h10, two, left, right, accented, plain;
    CHECK (one_text (text_object (1, "H", "\"pointsize\":10,\"origin\":\"128 64 0\""), h10), "load failed");
    CHECK (one_text (text_object (1, "H\\nH", "\"pointsize\":4,\"origin\":\"128 64 0\""), two), "load failed");
    CHECK (one_text (text_object (1, "HHH", "\"pointsize\":4,\"origin\":\"40 64 0\",\"horizontalalign\":\"left\""), left), "load failed");
    CHECK (one_text (text_object (1, "HHH", "\"pointsize\":4,\"origin\":\"216 64 0\",\"horizontalalign\":\"right\""), right), "load failed");
    CHECK (one_text (text_object (1, "\xc3\xa9\xc3\xa9", "\"pointsize\":4,\"origin\":\"128 64 0\""), accented), "load failed");
    CHECK (one_text (text_object (1, "ee", "\"pointsize\":4,\"origin\":\"128 64 0\""), plain), "load failed");
    printf ("    10 pt H: %d px tall (NotoSans' cap height 0.714 em at 41.7 px = 29.8)\n", h10.height ());
    printf ("    4 pt H\\nH: %d x %d (one H %.0f px, the line 1.362 em = 22.7)\n", two.width (), two.height (), 0.714f * 16.67f);
    printf ("    left-aligned at 40: x %d..%d; right-aligned at 216: x %d..%d\n", left.x0, left.x1, right.x0, right.x1);
    printf ("    \"\xc3\xa9\xc3\xa9\" %d px wide, \"ee\" %d\n", accented.width (), plain.width ());
    CHECK (h10.height () >= 28 && h10.height () <= 32, "a 10 pt H is %d px tall, not ~30 (300 dpi)", h10.height ());
    CHECK (two.height () >= 32 && two.height () <= 37 && two.width () <= 14, "H\\nH isn't two lines (%d x %d)", two.width (),
           two.height ());
    CHECK (left.x0 >= 40 && left.x0 <= 44, "left alignment: the ink starts at %d, not at the origin 40", left.x0);
    CHECK (right.x1 >= 211 && right.x1 <= 216, "right alignment: the ink ends at %d, not at the origin 216", right.x1);
    CHECK (accented.count > 0 && std::abs (accented.width () - plain.width ()) <= 2, "UTF-8: \"\xc3\xa9\xc3\xa9\" is %d px wide, \"ee\" %d",
           accented.width (), plain.width ());
    return true;
}

// a text layer takes effects (here one turning it red, keeping its alpha) and its colour (E34/T1; unpatched: drawn
// flat by its own shader, white)
static bool text_takes_effects_and_colour () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = sized_scene (
        text_object (1, "HHH", "\"pointsize\":5,\"origin\":\"64 64 0\",\"effects\":[{\"id\":5,\"name\":\"red\",\"file\":\"effects/b4red/effect.json\"}]")
            + "," + text_object (2, "HHH", "\"pointsize\":5,\"origin\":\"192 64 0\",\"color\":\"1.0 0.0 1.0\""),
        256, 128);
    mkdir ((dir + "/shaders").c_str (), 0755);
    mkdir ((dir + "/materials").c_str (), 0755);
    mkdir ((dir + "/effects").c_str (), 0755);
    mkdir ((dir + "/effects/b4red").c_str (), 0755);
    write_file (dir + "/shaders/b4red.vert",
                "uniform mat4 g_ModelViewProjectionMatrix;\nattribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\n"
                "void main() {\n\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);\n\tv_TexCoord = a_TexCoord;\n}\n");
    write_file (dir + "/shaders/b4red.frag", "uniform sampler2D g_Texture0;\nvarying vec2 v_TexCoord;\nvoid main() {\n"
                                             "\tvec4 c = texSample2D(g_Texture0, v_TexCoord);\n\tgl_FragColor = vec4(c.r, 0.0, 0.0, c.a);\n}\n");
    write_file (dir + "/materials/b4red.json", "{\"passes\":[{\"shader\":\"b4red\",\"cullmode\":\"nocull\",\"depthtest\":\"disabled\","
                                               "\"depthwrite\":\"disabled\",\"blending\":\"normal\"}]}\n");
    write_file (dir + "/effects/b4red/effect.json", "{\"name\":\"b4red\",\"passes\":[{\"material\":\"materials/b4red.json\"}]}\n");
    ScriptRig rig;
    rig.width = 256;
    rig.height = 128;
    rig.extra = { "shaders/b4red.vert", "shaders/b4red.frag", "materials/b4red.json", "effects/b4red/effect.json" };
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const InkBox redEffect = ink_box (rig, 0, 127, true), anyLeft = ink_box (rig, 0, 127);
    const InkBox magenta = ink_box (rig, 128), magentaRed = ink_box (rig, 128, 1 << 20, true);
    printf ("    with the red effect: %d lit, %d of them red; magenta text: %d lit, %d without green\n", anyLeft.count,
            redEffect.count, magenta.count, magentaRed.count);
    CHECK (anyLeft.count > 50 && redEffect.count >= anyLeft.count * 9 / 10, "the effect didn't turn the text red (%d of %d)",
           redEffect.count, anyLeft.count);
    CHECK (std::fabs (anyLeft.cx () - 64.0f) <= 3.0f, "the text with an effect moved (centre %.1f, origin 64)", anyLeft.cx ());
    CHECK (magenta.count > 50 && magentaRed.count >= magenta.count * 9 / 10, "the colour 1 0 1 didn't reach the text");
    return true;
}

// a colour user property written with whole numbers is 0..1 ("1 0 0" red), as WE's picker writes it (unpatched:
// 0..255, so 1/255: the text bound to it near black)
static bool colour_property_whole_numbers () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = sized_scene (
        text_object (1, "HHH", "\"pointsize\":5,\"origin\":\"128 64 0\",\"color\":{\"user\":\"tint\",\"value\":\"1.0 1.0 1.0\"}"), 256, 128);
    write_file (dir + "/project.json", "{\"title\":\"c\",\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{\"properties\":"
                                       "{\"tint\":{\"type\":\"color\",\"value\":\"1 0 0\",\"text\":\"t\"}}}}\n");
    ScriptRig rig;
    rig.width = 256;
    rig.height = 128;
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const InkBox lit = ink_box (rig), red = ink_box (rig, 0, 1 << 20, true);
    printf ("    \"1 0 0\": %d lit, %d red\n", lit.count, red.count);
    CHECK (lit.count > 50 && red.count >= lit.count * 9 / 10, "the text bound to \"1 0 0\" isn't red (%d of %d)", red.count, lit.count);
    return true;
}

// maxwidth wraps at a space, maxrows cuts with "…", spacing widens, and a script switches the alignment (T2, T5,
// S28; unpatched: one line, no limits, alignment read-only)
static bool text_wraps_and_limits () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string common = "\"pointsize\":4,\"origin\":\"128 64 0\",\"horizontalalign\":\"left\",\"maxwidth\":100,";
    InkBox one, wrapped, cut, plain, spaced, scripted;
    CHECK (one_text (text_object (1, "HHH HHH HHH", common + "\"limitwidth\":false"), one), "load failed");
    CHECK (one_text (text_object (1, "HHH HHH HHH", common + "\"limitwidth\":true"), wrapped), "load failed");
    CHECK (one_text (text_object (1, "HHH HHH HHH", common + "\"limitwidth\":true,\"limitrows\":true,\"maxrows\":1,\"limituseellipsis\":true"), cut),
           "load failed");
    CHECK (one_text (text_object (1, "HH", "\"pointsize\":4,\"origin\":\"128 64 0\""), plain), "load failed");
    CHECK (one_text (text_object (1, "HH", "\"pointsize\":4,\"origin\":\"128 64 0\",\"spacing\":\"10 0\""), spaced), "load failed");
    const std::string script = "export function update(value) {\n  thisLayer.horizontalalign = 'left';\n  return value;\n}";
    CHECK (one_text ("{\"id\":1,\"name\":\"t1\",\"font\":\"fonts/NotoSans-Regular.ttf\",\"color\":\"1.0 1.0 1.0\",\"pointsize\":4,"
                     "\"origin\":\"40 64 0\",\"text\":{\"value\":\"HHH\",\"script\":\"" + json_escaped (script) + "\"}}", scripted),
           "load failed");
    printf ("    no limit: %d x %d; wrapped at 100: %d x %d; 1 row with ellipsis: %d x %d\n", one.width (), one.height (),
            wrapped.width (), wrapped.height (), cut.width (), cut.height ());
    printf ("    HH: %d wide, with spacing 10: %d; scripted left at 40: x %d..%d\n", plain.width (), spaced.width (), scripted.x0,
            scripted.x1);
    CHECK (one.width () > 100 && one.height () <= 14, "unlimited: not one line (%d x %d)", one.width (), one.height ());
    CHECK (wrapped.width () <= 100 && wrapped.height () >= 32 && wrapped.height () <= 37, "not wrapped to two lines (%d x %d)",
           wrapped.width (), wrapped.height ());
    CHECK (cut.width () <= 100 && cut.height () <= 14 && cut.width () > 60, "not cut to one row (%d x %d)", cut.width (),
           cut.height ());
    CHECK (spaced.width () >= plain.width () + 9 && spaced.width () <= plain.width () + 11, "spacing.x: %d vs %d", spaced.width (),
           plain.width ());
    CHECK (scripted.x0 >= 40 && scripted.x0 <= 44, "the script's horizontalalign didn't apply (x %d)", scripted.x0);
    return true;
}

// B13 (docs/player/spikes/we-lwe-gap-audit.md E35, E23): HDR scenes and FBO formats, decoded from wallpaper64.exe
// 2.8.485. A scene with general.hdr renders into half float targets (WE: the scene RGB161616f, composites and
// rgba_backbuffer FBOs RGBA16161616f; GH 0x1401af5b0, 0x140216080) and blooms with WE's HDR chain (hdr_downsample_bloom,
// hdr_downsample, hdr_upsample(_cubic), combine_hdr_upsample; GH 0x1401afbf0, 0x1401b3b10, 0x1401b42b0)

// a solid layer material `name` adding `rgb` (blending additive), as models/<name>.json
static std::vector<std::string> b13_adder (const std::string& dir, const std::string& name, const std::string& rgb) {
    auto files = b7_layer (dir, name, "gl_FragColor = vec4(" + rgb + ", 1.0);");
    const std::string material = dir + "/materials/" + name + ".json";
    std::string json = read_file (material);
    const std::string normal = "\"blending\":\"normal\"";
    json.replace (json.find (normal), normal.size (), "\"blending\":\"additive\"");
    write_file (material, json);
    return files;
}

// two additive 0.6 squares at x 16 make 1.2 (red, green) in an HDR scene; one at x 48 stays 0.6. HDR bloom (threshold
// 1, feather 0.1) glows only around the first: values above 1 survive in the half float scene, and below the knee
// (0.9) nothing blooms. Unpatched: the scene was RGBA8 (1.2 clipped to 1) and bloomed with the LDR chain, its
// bloomthreshold 0.3 lighting both squares; bloomhdr* were never read
static bool hdr_bloom_is_wes_chain () {
    if (!script_tests_can_run ()) {
        return true;
    }
    auto run = [] (const std::string& hdr, std::array<std::array<unsigned char, 4>, 3>& out) {
        const std::string dir = camera_scene (
            hdr + ",\"bloom\":true,\"bloomstrength\":4,\"bloomthreshold\":0.3,\"bloomhdrstrength\":8,\"bloomhdrthreshold\":1.0,"
                  "\"bloomhdrfeather\":0.1,\"bloomhdrscatter\":1.0,\"bloomhdriterations\":3",
            b7_object (1, "b13add", 16, "8 8") + "," + b7_object (2, "b13add", 16, "8 8") + "," + b7_object (3, "b13add", 48, "8 8"));
        ScriptRig rig;
        rig.extra = b13_adder (dir, "b13add", "0.6, 0.6, 0.0");
        if (!rig.open (dir)) {
            return false;
        }
        rig.step ();
        rig.step ();
        out = { pixel_at (rig, 16), pixel_at (rig, 23), pixel_at (rig, 55) };
        return true;
    };
    std::array<std::array<unsigned char, 4>, 3> hdr {}, ldr {};
    CHECK (run ("\"hdr\":true", hdr), "load/build of the HDR scene failed");
    CHECK (run ("\"hdr\":false", ldr), "load/build of the LDR scene failed");
    printf ("    HDR: square %d %d %d, 3 px past the bright square %d %d %d, past the dim one %d %d %d\n", hdr[0][0], hdr[0][1],
            hdr[0][2], hdr[1][0], hdr[1][1], hdr[1][2], hdr[2][0], hdr[2][1], hdr[2][2]);
    printf ("    LDR (same scene, hdr false): past the bright square %d %d %d, past the dim one %d %d %d\n", ldr[1][0], ldr[1][1],
            ldr[1][2], ldr[2][0], ldr[2][1], ldr[2][2]);
    CHECK (hdr[0][0] == 255 && hdr[0][2] >= 125, "the bright square isn't white-yellow on blue (%d %d %d)", hdr[0][0], hdr[0][1],
           hdr[0][2]);
    CHECK (hdr[1][0] >= 8 && hdr[1][1] >= 8, "no HDR glow past the square above 1 (%d %d)", hdr[1][0], hdr[1][1]);
    CHECK (hdr[2][0] < 3 && hdr[2][1] < 3, "an HDR glow past the square below the threshold (%d %d)", hdr[2][0], hdr[2][1]);
    CHECK (ldr[2][0] >= 4, "the LDR chain (threshold 0.3) didn't glow past the dim square (r=%d)", ldr[2][0]);
    return true;
}

// an effect FBO is the format it names: rg88 keeps red and green only (blue reads 0), rgba_backbuffer is half float
// in an HDR scene (2.0 · 0.25 = 0.5) and 8-bit otherwise (clipped: 1 · 0.25). Unpatched: every FBO was RGBA8
static bool fbo_formats_as_written () {
    if (!script_tests_can_run ()) {
        return true;
    }
    auto run = [] (bool hdr, std::array<unsigned char, 4>& rg, std::array<unsigned char, 4>& wide) {
        const std::string dir = camera_scene (hdr ? "\"hdr\":true" : "\"hdr\":false",
            b7_object (1, "b13base", 16, "8 8", ",\"effects\":[{\"id\":2,\"name\":\"rg\",\"file\":\"effects/b13rg/effect.json\",\"visible\":true}]")
                + "," + b7_object (3, "b13base", 48, "8 8",
                                   ",\"effects\":[{\"id\":4,\"name\":\"w\",\"file\":\"effects/b13wide/effect.json\",\"visible\":true}]"));
        ScriptRig rig;
        rig.extra = b7_layer (dir, "b13base", "gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);");
        const std::string sampler = "uniform sampler2D g_Texture0;\n";
        for (const auto& f : { b7_layer (dir, "b13put", "gl_FragColor = vec4(0.2, 0.4, 0.6, 1.0);", "", true, sampler),
                               b7_layer (dir, "b13big", "gl_FragColor = vec4(2.0, 0.0, 0.0, 1.0);", "", true, sampler),
                               b7_layer (dir, "b13get", "gl_FragColor = vec4(texSample2D(g_Texture0, v_TexCoord).rgb, 1.0);", "", true, sampler),
                               b7_layer (dir, "b13qtr", "gl_FragColor = vec4(texSample2D(g_Texture0, v_TexCoord).rgb * 0.25, 1.0);", "", true,
                                         sampler) }) {
            rig.extra.insert (rig.extra.end (), f.begin (), f.end ());
        }
        mkdir ((dir + "/effects").c_str (), 0755);
        const auto effect = [&dir, &rig] (const std::string& name, const std::string& format, const std::string& put, const std::string& get) {
            mkdir ((dir + "/effects/" + name).c_str (), 0755);
            write_file (dir + "/effects/" + name + "/effect.json",
                        "{\"name\":\"" + name + "\",\"fbos\":[{\"name\":\"_x\",\"format\":\"" + format + "\",\"scale\":1}],\"passes\":["
                        "{\"material\":\"materials/" + put + ".json\",\"target\":\"_x\"},"
                        "{\"material\":\"materials/" + get + ".json\",\"bind\":[{\"name\":\"_x\",\"index\":0}]}]}\n");
            rig.extra.push_back ("effects/" + name + "/effect.json");
        };
        effect ("b13rg", "rg88", "b13put", "b13get");
        effect ("b13wide", "rgba_backbuffer", "b13big", "b13qtr");
        if (!rig.open (dir)) {
            return false;
        }
        rig.step ();
        rg = pixel_at (rig, 16);
        wide = pixel_at (rig, 48);
        return true;
    };
    std::array<unsigned char, 4> rgH {}, wideH {}, rgL {}, wideL {};
    CHECK (run (true, rgH, wideH), "load/build of the HDR scene failed");
    CHECK (run (false, rgL, wideL), "load/build of the LDR scene failed");
    printf ("    rg88 FBO of (0.2 0.4 0.6): %d %d %d (want 51 102 0); rgba_backbuffer of 2.0, read · 0.25: HDR %d (want 127), "
            "LDR %d (want 64)\n", rgL[0], rgL[1], rgL[2], wideH[0], wideL[0]);
    CHECK (rgb_near (rgL, 51, 102, 0) && rgb_near (rgH, 51, 102, 0), "the rg88 FBO isn't red-green only (%d %d %d)", rgL[0], rgL[1], rgL[2]);
    CHECK (near (wideH[0], 127, 3), "rgba_backbuffer isn't half float in an HDR scene (r=%d)", wideH[0]);
    CHECK (near (wideL[0], 64, 3), "rgba_backbuffer isn't 8-bit in an LDR scene (r=%d)", wideL[0]);
    return true;
}

// ---------------------------------------------------------------------------------------------
// B14: 3D scenes (docs/player/spikes/we-lwe-gap-audit.md G19–G29, E13, E14). wallpaper64.exe 2.8.485: the scene loader
// GH 0x1401b6c60 (no orthogonalprojection = perspective), the perspective GH 0x1401b3f70, the object matrix
// GH 0x1401b5170 / 0x14020af40, the lights GH 0x1401bf270, the fog GH 0x1401ba300. A 3D scene renders 1920x1080

static constexpr int kW3 = 1920, kH3 = 1080;

// a 3D scene: no orthogonalprojection, the eye on +z looking at the origin, fov 50 (vertical), and `general` more
static std::string world_scene (const std::string& general, const std::string& objects, const std::string& eye = "0 0 10") {
    char tmpl[] = "/tmp/lwe-world-scene.XXXXXX";
    const char* dir = mkdtemp (tmpl);
    if (!dir) {
        return {};
    }
    const std::string d = dir;
    write_file (d + "/project.json", "{\"title\":\"world\",\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{\"properties\":{}}}\n");
    write_file (d + "/scene.json", "{\"camera\":{\"center\":\"0 0 0\",\"eye\":\"" + eye + "\",\"up\":\"0 1 0\"},"
                                   "\"general\":{\"clearcolor\":\"0 0 0.5\",\"orthogonalprojection\":null,\"fov\":50,"
                                   "\"nearz\":0.1,\"farz\":1000" + general + "},\"objects\":[" + objects + "]}\n");
    return d;
}

static std::array<unsigned char, 4> pixel_xy (const ScriptRig& rig, int x, int y) {
    std::array<unsigned char, 4> px {};
    read_pixel (rig.fbo, x, y, px.data ());
    return px;
}

// the columns (x0..x1) of row y where `hit` holds, -1 -1 when none
static std::pair<int, int> span_x (const ScriptRig& rig, int y, bool (*hit) (const std::array<unsigned char, 4>&), int step = 2) {
    int first = -1, last = -1;
    for (int x = 0; x < kW3; x += step) {
        if (hit (pixel_xy (rig, x, y))) {
            first = first < 0 ? x : first;
            last = x;
        }
    }
    return { first, last };
}
static std::pair<int, int> span_y (const ScriptRig& rig, int x, bool (*hit) (const std::array<unsigned char, 4>&), int step = 2) {
    int first = -1, last = -1;
    for (int y = 0; y < kH3; y += step) {
        if (hit (pixel_xy (rig, x, y))) {
            first = first < 0 ? y : first;
            last = y;
        }
    }
    return { first, last };
}
static bool is_red (const std::array<unsigned char, 4>& px) { return px[0] > 200 && px[1] < 60 && px[2] < 60; }
static bool is_green (const std::array<unsigned char, 4>& px) { return px[1] > 200 && px[0] < 60 && px[2] < 60; }

// a scene without orthogonalprojection loads and draws its layers through the perspective camera: a 2 x 2 unit layer
// 10 units away fills 2 / (2 · 10 · tan 25°) of the height (G24; unpatched: "Projection must have a width", no load)
static bool perspective_scene_loads () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = world_scene ("",
        "{\"id\":1,\"name\":\"r\",\"image\":\"models/b14red.json\",\"size\":\"200 200\",\"origin\":\"0 0 0\",\"scale\":\"0.01 0.01 0.01\"},"
        "{\"id\":2,\"name\":\"g\",\"image\":\"models/b14green.json\",\"size\":\"50 50\",\"origin\":\"0 3 0\",\"scale\":\"0.01 0.01 0.01\"}");
    ScriptRig rig;
    rig.width = kW3;
    rig.height = kH3;
    rig.extra = b7_layer (dir, "b14red", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
    const auto green = b7_layer (dir, "b14green", "gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);");
    rig.extra.insert (rig.extra.end (), green.begin (), green.end ());
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto across = span_x (rig, kH3 / 2, is_red), down = span_y (rig, kW3 / 2, is_red);
    const auto up = span_y (rig, kW3 / 2, is_green);
    // 2 / 9.326 · 1080 = 231.6 px, square
    const double want = 2.0 / (2.0 * 10.0 * std::tan (25.0 * M_PI / 180.0)) * kH3;
    printf ("    red layer %d..%d x %d..%d (want %.0f px square at the centre); the layer 3 units up at rows %d..%d\n",
            across.first, across.second, down.first, down.second, want, up.first, up.second);
    CHECK (across.first >= 0 && std::abs ((across.second - across.first) - want) <= 8, "the red layer isn't %.0f px wide", want);
    CHECK (down.first >= 0 && std::abs ((down.second - down.first) - want) <= 8, "the red layer isn't %.0f px tall", want);
    CHECK (std::abs ((across.first + across.second) / 2 - kW3 / 2) <= 4 && std::abs ((down.first + down.second) / 2 - kH3 / 2) <= 4,
           "the red layer isn't centred");
    // world y up is where a 2D scene's high y is (the control: a 2D scene's layer at y 28 of 32)
    const std::string flat = camera_scene ("\"zoom\":1", "{\"id\":1,\"name\":\"g\",\"image\":\"models/b14green.json\",\"size\":\"4 4\",\"origin\":\"32 28 0\"}");
    ScriptRig rig2;
    rig2.extra = b7_layer (flat, "b14green", "gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);");
    CHECK (rig2.open (flat), "load/build of %s failed", flat.c_str ());
    rig2.step ();
    int highRow = -1;
    for (int y = 0; y < 32; y++) {
        std::array<unsigned char, 4> px {};
        read_pixel (rig2.fbo, 32, y, px.data ());
        if (is_green (px)) {
            highRow = y;
        }
    }
    printf ("    2D control: y 28 of 32 is read at row %d\n", highRow);
    CHECK (highRow >= 0, "the 2D control layer wasn't drawn");
    CHECK (up.first >= 0 && (up.second < down.first) == (highRow < 16), "the layer 3 units up isn't on the 2D scene's top side (rows %d..%d)",
           up.first, up.second);
    return true;
}

// a 3D layer turns about x/y and sits at its origin's z: turned 60° about y it is cos 60° as wide; at z 5 (halfway to
// the eye) twice as big; and a child takes its parent's whole matrix (G22; unpatched: no load — and the 2D path
// draws z 0, angles z only)
static bool layer_tilts_and_moves_in_depth () {
    if (!script_tests_can_run ()) {
        return true;
    }
    auto width = [] (const std::string& object, int& w, int& h) {
        const std::string dir = world_scene ("", object);
        ScriptRig rig;
        rig.width = kW3;
        rig.height = kH3;
        rig.extra = b7_layer (dir, "b14red", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
        if (!rig.open (dir)) {
            return false;
        }
        rig.step ();
        const auto x = span_x (rig, kH3 / 2, is_red), y = span_y (rig, kW3 / 2, is_red);
        w = x.first < 0 ? 0 : x.second - x.first;
        h = y.first < 0 ? 0 : y.second - y.first;
        return true;
    };
    const std::string base = "{\"id\":1,\"name\":\"r\",\"image\":\"models/b14red.json\",\"size\":\"200 200\",\"scale\":\"0.01 0.01 0.01\"";
    int flatW = 0, flatH = 0, turnedW = 0, turnedH = 0, nearW = 0, nearH = 0, childW = 0, childH = 0;
    CHECK (width (base + ",\"origin\":\"0 0 0\"}", flatW, flatH), "load failed (flat)");
    CHECK (width (base + ",\"origin\":\"0 0 0\",\"angles\":\"0 1.0471976 0\"}", turnedW, turnedH), "load failed (turned)");
    CHECK (width (base + ",\"origin\":\"0 0 5\"}", nearW, nearH), "load failed (near)");
    // the parent at z 5 turned 90° about z: the child (2 x 1 units) stands upright
    CHECK (width ("{\"id\":9,\"name\":\"p\",\"origin\":\"0 0 5\",\"angles\":\"0 0 1.5707964\"}," + base
                      + ",\"size\":\"200 100\",\"origin\":\"0 0 0\",\"parent\":9}",
                  childW, childH),
           "load failed (child)");
    printf ("    flat %d x %d, turned 60° about y %d x %d, at z 5 %d x %d, 2 x 1 child of a z-turned parent at z 5 %d x %d\n", flatW,
            flatH, turnedW, turnedH, nearW, nearH, childW, childH);
    CHECK (flatW > 200 && std::abs (flatW - flatH) <= 6, "the flat layer isn't square (%d x %d)", flatW, flatH);
    CHECK (turnedW > flatW * 0.4 && turnedW < flatW * 0.62, "turned 60° about y isn't about half as wide (%d)", turnedW);
    CHECK (std::abs (nearW - 2 * flatW) <= 12, "at z 5 it isn't twice as wide (%d)", nearW);
    CHECK (childH > 1.8 * childW && std::abs (childH - nearW) <= 12, "the child didn't take its parent's turn and z (%d x %d)", childW,
           childH);
    return true;
}

// a minimal MDLV0016 file: one mesh, format 0xf (position, normal, tangent, texcoord), a 4 x 4 quad at z 0 facing +z
static std::string b14_mdl (const std::string& material) {
    std::string out;
    auto u32 = [&out] (uint32_t v) { out.append (reinterpret_cast<const char*> (&v), 4); };
    auto f32 = [&out] (float v) { out.append (reinterpret_cast<const char*> (&v), 4); };
    out += std::string ("MDLV0016") + '\0';
    u32 (0xf);
    u32 (1);
    u32 (1);
    out += material + '\0';
    u32 (0);   // flags: 16-bit indices
    u32 (0xf); // the mesh's format
    const float corners[4][2] = { { -2, -2 }, { 2, -2 }, { 2, 2 }, { -2, 2 } };
    u32 (4 * 48);
    for (const auto& c : corners) {
        f32 (c[0]); f32 (c[1]); f32 (0.0f);              // position
        f32 (0.0f); f32 (0.0f); f32 (1.0f);              // normal
        f32 (1.0f); f32 (0.0f); f32 (0.0f); f32 (1.0f);  // tangent
        f32 ((c[0] + 2) / 4); f32 ((2 - c[1]) / 4);      // texcoord
    }
    const uint16_t indices[] = { 0, 1, 2, 0, 2, 3 };
    u32 (sizeof (indices));
    out.append (reinterpret_cast<const char*> (indices), sizeof (indices));
    return out;
}

// the model and its generic4 material (util/white) with these combos
static std::vector<std::string> b14_model (const std::string& dir, const std::string& combos) {
    mkdir ((dir + "/models").c_str (), 0755);
    mkdir ((dir + "/materials").c_str (), 0755);
    write_file (dir + "/models/b14quad.mdl", b14_mdl ("materials/b14quad.json"));
    write_file (dir + "/materials/b14quad.json", "{\"passes\":[{\"shader\":\"generic4\",\"blending\":\"normal\",\"textures\":[\"util/white\"],"
                                                 "\"combos\":{" + combos + "}}]}\n");
    return { "models/b14quad.mdl", "materials/b14quad.json" };
}

// the centre pixel of a scene with the quad model
static bool model_centre (const std::string& general, const std::string& combos, const std::string& more, std::array<unsigned char, 4>& px) {
    const std::string dir = world_scene (general, "{\"id\":1,\"name\":\"m\",\"model\":\"models/b14quad.mdl\",\"origin\":\"0 0 0\"}" + more);
    ScriptRig rig;
    rig.width = kW3;
    rig.height = kH3;
    rig.extra = b14_model (dir, combos);
    if (!rig.open (dir)) {
        return false;
    }
    rig.step ();
    px = pixel_xy (rig, kW3 / 2, kH3 / 2);
    return true;
}

// a model object draws its MDL mesh with its material (G25; unpatched: no load, and a model was a placeholder):
// unlit it is the albedo (generic4 without LIGHTING), lit by a point light, and by a spot only when its x axis points
// at it (GH 0x1401bf270; unpatched PerformLighting_V1 returned 0)
static bool model_draws_and_lights () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::array<unsigned char, 4> unlit {}, dark {}, point {}, spotAt {}, spotAway {};
    CHECK (model_centre ("", "\"LIGHTING\":0,\"FOG\":0", "", unlit), "load failed (unlit)");
    const std::string black = ",\"ambientcolor\":\"0 0 0\",\"skylightcolor\":\"0 0 0\"";
    CHECK (model_centre (black, "\"LIGHTING\":1,\"FOG\":0", "", dark), "load failed (no light)");
    const std::string light = ",{\"id\":2,\"name\":\"l\",\"light\":\"lpoint\",\"origin\":\"0 0 3\",\"color\":\"1.0 1.0 1.0\",\"intensity\":4,"
                              "\"radius\":20,\"exponent\":1";
    CHECK (model_centre (black, "\"LIGHTING\":1,\"FOG\":0", light + "}", point), "load failed (point)");
    const std::string spot = ",{\"id\":2,\"name\":\"l\",\"light\":\"lspot\",\"origin\":\"0 0 3\",\"color\":\"1.0 1.0 1.0\",\"intensity\":4,"
                             "\"radius\":20,\"exponent\":1,\"innercone\":20,\"outercone\":30";
    CHECK (model_centre (black, "\"LIGHTING\":1,\"FOG\":0", spot + ",\"angles\":\"0 1.5707964 0\"}", spotAt), "load failed (spot at)");
    CHECK (model_centre (black, "\"LIGHTING\":1,\"FOG\":0", spot + ",\"angles\":\"0 -1.5707964 0\"}", spotAway), "load failed (spot away)");
    printf ("    unlit %d %d %d (want white), no light %d %d %d, point %d %d %d, spot at it %d %d %d, spot away %d %d %d\n", unlit[0],
            unlit[1], unlit[2], dark[0], dark[1], dark[2], point[0], point[1], point[2], spotAt[0], spotAt[1], spotAt[2], spotAway[0],
            spotAway[1], spotAway[2]);
    CHECK (unlit[0] > 240 && unlit[1] > 240 && unlit[2] > 240, "the unlit model isn't white");
    CHECK (dark[0] < 8 && dark[1] < 8 && dark[2] < 8, "the model without a light isn't black");
    CHECK (point[0] > 40 && point[0] == point[1], "the point light doesn't light the model");
    CHECK (spotAt[0] > 40, "the spot pointing at the model doesn't light it");
    CHECK (spotAway[0] < 8, "the spot pointing away lights the model");
    return true;
}

// distance fog: the model 10 units away, the fog from 0 to 5 at density 0 → 1 is all fog colour; and the depth test
// keeps a nearer model drawn first in front of a farther one drawn after it (G28, E14; unpatched: no load, no fog
// uniforms, no depth buffer)
static bool fog_and_depth () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::array<unsigned char, 4> clear {}, fogged {};
    CHECK (model_centre ("", "\"LIGHTING\":0", "", clear), "load failed (no fog)");
    CHECK (model_centre (",\"fogdistance\":true,\"fogdistancecolor\":\"1 0 0\",\"fogdistancestart\":0,\"fogdistanceend\":5,"
                         "\"fogdistancestartdensity\":0,\"fogdistanceenddensity\":1",
                         "\"LIGHTING\":0", "", fogged),
           "load failed (fog)");
    printf ("    no fog %d %d %d (want white), fog %d %d %d (want red)\n", clear[0], clear[1], clear[2], fogged[0], fogged[1], fogged[2]);
    CHECK (clear[0] > 240 && clear[1] > 240, "the model isn't white without fog");
    CHECK (fogged[0] > 240 && fogged[1] < 16 && fogged[2] < 16, "the fog didn't turn the far model red");

    // the white quad, then a red one 2 units behind it drawn after: the depth test keeps the white one in front
    const std::string dir = world_scene ("", "{\"id\":1,\"name\":\"m\",\"model\":\"models/b14quad.mdl\",\"origin\":\"0 0 0\"},"
                                             "{\"id\":2,\"name\":\"b\",\"model\":\"models/b14back.mdl\",\"origin\":\"0 0 -2\"}");
    ScriptRig rig;
    rig.width = kW3;
    rig.height = kH3;
    rig.extra = b14_model (dir, "\"LIGHTING\":0,\"FOG\":0");
    write_file (dir + "/models/b14back.mdl", b14_mdl ("materials/b14back.json"));
    write_file (dir + "/materials/b14back.json", "{\"passes\":[{\"shader\":\"generic4\",\"blending\":\"normal\",\"textures\":[\"util/white\"],"
                                                 "\"combos\":{\"LIGHTING\":0,\"FOG\":0},\"constantshadervalues\":{\"color\":\"1.0 0.0 0.0\"}}]}\n");
    rig.extra.insert (rig.extra.end (), { "models/b14back.mdl", "materials/b14back.json" });
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    rig.step ();
    const auto centre = pixel_xy (rig, kW3 / 2, kH3 / 2);
    printf ("    near white quad, far red quad drawn after: centre %d %d %d (want white)\n", centre[0], centre[1], centre[2]);
    CHECK (centre[0] > 240 && centre[1] > 240 && centre[2] > 240, "the far quad drawn after covered the near one (no depth test)");
    return true;
}

// F1: a generic4 quad material (white, lit), and an invisible one (additive black, no depth write) for an occluder
// that only casts its shadow
static void f1_materials (const std::string& dir, ScriptRig& rig) {
    rig.extra = b14_model (dir, "\"LIGHTING\":1,\"FOG\":0");
    write_file (dir + "/models/f1occluder.mdl", b14_mdl ("materials/f1occluder.json"));
    write_file (dir + "/materials/f1occluder.json", "{\"passes\":[{\"shader\":\"generic4\",\"blending\":\"additive\",\"depthwrite\":\"disabled\","
                                                    "\"textures\":[\"util/white\"],\"combos\":{\"LIGHTING\":0,\"FOG\":0},"
                                                    "\"constantshadervalues\":{\"color\":\"0.0 0.0 0.0\"}}]}\n");
    rig.extra.insert (rig.extra.end (), { "models/f1occluder.mdl", "materials/f1occluder.json" });
}

static const char* kF1Black = ",\"ambientcolor\":\"0 0 0\",\"skylightcolor\":\"0 0 0\"";
// pixels per world unit at z 0 (the camera 10 units away, fov 50, 1080 rows)
static constexpr double kF1PxPerUnit = 540.0 / (10.0 * 0.46630765815);

// the floor (a 4 x 4 quad at z 0), a 1 x 1 occluder at z 1.5 and a light at z 3 over the centre: the centre pixel
// and one 1.6 units to the right, outside the shadow
static bool f1_shadow_scene (const std::string& light, bool occluderCasts, std::array<unsigned char, 4>& centre,
                             std::array<unsigned char, 4>& side) {
    const std::string objects = std::string ("{\"id\":1,\"name\":\"floor\",\"model\":\"models/b14quad.mdl\",\"origin\":\"0 0 0\",\"castshadow\":true},")
        + "{\"id\":2,\"name\":\"occluder\",\"model\":\"models/f1occluder.mdl\",\"origin\":\"0 0 1.5\",\"scale\":\"0.25 0.25 0.25\","
          "\"castshadow\":" + (occluderCasts ? "true" : "false") + "}," + light;
    const std::string dir = world_scene (kF1Black, objects);
    ScriptRig rig;
    rig.width = kW3;
    rig.height = kH3;
    f1_materials (dir, rig);
    if (!rig.open (dir)) {
        return false;
    }
    rig.step ();
    centre = pixel_xy (rig, kW3 / 2, kH3 / 2);
    side = pixel_xy (rig, kW3 / 2 + static_cast<int> (1.6 * kF1PxPerUnit), kH3 / 2);
    return true;
}

// a light with castshadow draws the casters into the shadow atlas and the lit model samples it (WE's shadow pass,
// GH 0x1401bf270 / GH 0x1401c4f30; PerformLighting_V1's shadowFactor, GH 0x140197e20): the floor under a 1 x 1
// occluder is dark, beside it lit; the occluder without castshadow casts nothing. For a spot (one projected tile)
// and a point light (six cube faces). Unpatched: shadowFactor was always 1, the centre lit
static bool shadow_occludes_a_lit_point () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string spot = "{\"id\":3,\"name\":\"l\",\"light\":\"lspot\",\"origin\":\"0 0 3\",\"angles\":\"0 1.5707964 0\",\"color\":\"1.0 1.0 1.0\","
                             "\"intensity\":4,\"radius\":20,\"exponent\":1,\"innercone\":40,\"outercone\":45,\"castshadow\":true}";
    const std::string point = "{\"id\":3,\"name\":\"l\",\"light\":\"lpoint\",\"origin\":\"0 0 3\",\"color\":\"1.0 1.0 1.0\",\"intensity\":4,"
                              "\"radius\":20,\"exponent\":1,\"castshadow\":true}";
    for (const auto& [name, light] : { std::pair<const char*, std::string> { "spot", spot }, { "point", point } }) {
        std::array<unsigned char, 4> openC {}, openS {}, shadowC {}, shadowS {};
        CHECK (f1_shadow_scene (light, false, openC, openS), "load failed (%s, occluder without castshadow)", name);
        CHECK (f1_shadow_scene (light, true, shadowC, shadowS), "load failed (%s, occluder casts)", name);
        printf ("    %s: no caster centre %d side %d; caster centre %d (want dark) side %d (want lit)\n", name, openC[0], openS[0],
                shadowC[0], shadowS[0]);
        CHECK (openC[0] > 40 && openS[0] > 40, "%s: the floor isn't lit without a caster (centre %d, side %d)", name, openC[0], openS[0]);
        CHECK (shadowC[0] < 10, "%s: the occluder's shadow doesn't darken the centre (%d)", name, shadowC[0]);
        CHECK (near (shadowS[0], openS[0], 3), "%s: beside the shadow the floor changed (%d vs %d): acne or a wrong tile", name,
               shadowS[0], openS[0]);
    }
    return true;
}

// a TEXV0005 / TEXB0003 ARGB8888 texture, `w` x `h`, no interpolation, clamped
static std::string f1_texture (int w, int h, const std::vector<uint32_t>& rgba) {
    MdlWriter t;
    t.out = std::string ("TEXV0005", 8) + '\0' + std::string ("TEXI0001", 8) + '\0';
    t.u32 (0).u32 (1 | 2).u32 (w).u32 (h).u32 (w).u32 (h).u32 (0);
    t.out += std::string ("TEXB0003", 8) + '\0';
    t.u32 (1).u32 (0xffffffff);
    t.u32 (1).u32 (w).u32 (h).u32 (0).u32 (w * h * 4).u32 (w * h * 4);
    for (const uint32_t px : rgba) {
        t.u8 (px >> 24).u8 ((px >> 16) & 0xff).u8 ((px >> 8) & 0xff).u8 (px & 0xff);
    }
    return t.out;
}

// a spot with usecookie projects its `cookie` texture (GH 0x140282140 loads it, default cookie/flashlight1; the
// generated loop multiplies the light by it inside the projection, GH 0x140197e20): a red | green cookie lights the
// left of the floor red, the right green. Unpatched: white on both sides
static bool cookie_projects_its_texture () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::array<std::array<unsigned char, 4>, 2> plain {}, cookie {};
    for (const bool use : { false, true }) {
        const std::string light = std::string ("{\"id\":3,\"name\":\"l\",\"light\":\"lspot\",\"origin\":\"0 0 3\",\"angles\":\"0 1.5707964 0\",")
            + "\"color\":\"1.0 1.0 1.0\",\"intensity\":4,\"radius\":20,\"exponent\":1,\"innercone\":40,\"outercone\":45,"
              "\"usecookie\":" + (use ? "true" : "false") + ",\"cookie\":\"f1cookie\"}";
        const std::string dir = world_scene (kF1Black, std::string ("{\"id\":1,\"name\":\"floor\",\"model\":\"models/b14quad.mdl\",\"origin\":\"0 0 0\","
                                                                   "\"castshadow\":false},") + light);
        ScriptRig rig;
        rig.width = kW3;
        rig.height = kH3;
        f1_materials (dir, rig);
        write_file (dir + "/materials/f1cookie.tex", f1_texture (2, 1, { 0xff0000ff, 0x00ff00ff }));
        rig.extra.push_back ("materials/f1cookie.tex");
        CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
        rig.step ();
        auto& out = use ? cookie : plain;
        out[0] = pixel_xy (rig, kW3 / 2 - static_cast<int> (1.2 * kF1PxPerUnit), kH3 / 2);
        out[1] = pixel_xy (rig, kW3 / 2 + static_cast<int> (1.2 * kF1PxPerUnit), kH3 / 2);
    }
    printf ("    no cookie: left %d %d %d, right %d %d %d; cookie: left %d %d %d (want red), right %d %d %d (want green)\n",
            plain[0][0], plain[0][1], plain[0][2], plain[1][0], plain[1][1], plain[1][2], cookie[0][0], cookie[0][1], cookie[0][2],
            cookie[1][0], cookie[1][1], cookie[1][2]);
    CHECK (plain[0][0] > 40 && near (plain[0][0], plain[0][1], 3) && near (plain[1][0], plain[1][1], 3), "without a cookie the light isn't white");
    CHECK (cookie[0][0] > 40 && cookie[0][1] < 8 && cookie[0][2] < 8, "the cookie's red half doesn't light the left");
    CHECK (cookie[1][1] > 40 && cookie[1][0] < 8 && cookie[1][2] < 8, "the cookie's green half doesn't light the right");
    return true;
}

// the stock shadow casters build (their vertex unit writes gl_ViewportIndex: the cube faces and cascades are drawn one
// viewport at a time instead), and so does generic4 with shadows and cookies on (unpatched: the casters failed,
// "gl_ViewportIndex … not supported" at GLSL 3.30; the shadow sampler's .r on a float)
static bool shadow_casters_compile () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = world_scene ("", "{\"id\":1,\"name\":\"m\",\"model\":\"models/b14quad.mdl\",\"origin\":\"0 0 0\"}");
    ScriptRig rig;
    rig.width = kW3;
    rig.height = kH3;
    rig.extra = b14_model (dir, "\"LIGHTING\":1");
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    const std::pair<const char*, const char*> checks[] = {
        { "shadowcaster", "{}" },
        { "shadowcaster", "{\"combos\":{\"ALPHATOCOVERAGE\":1}}" },
        { "shadowcasterfoliage4", "{}" },
        { "shadowcasterfoliage4", "{\"combos\":{\"ALPHATOCOVERAGE\":1}}" },
        { "shadowcasterfur4", "{}" },
        { "generic4", "{\"combos\":{\"LIGHTING\":1,\"LIGHTS_SHADOW_MAPPING\":1,\"LIGHTS_SHADOW_MAPPING_QUALITY\":2,\"LIGHTS_COOKIE\":1}}" },
        { "generic4", "{\"combos\":{\"LIGHTING\":1,\"LIGHTS_SHADOW_MAPPING\":1,\"LIGHTS_SHADOW_MAPPING_QUALITY\":1,\"LIGHTS_DIRECTIONAL\":2}}" },
    };
    bool ok = true;
    for (const auto& [shader, request] : checks) {
        std::string out (8192, '\0');
        wp_project_shader_check (rig.p, shader, request, out.data (), out.size ());
        out.resize (strlen (out.c_str ()));
        const bool built = out.find ("\"ok\":true") != std::string::npos;
        printf ("    %s %s: %s\n", shader, request, built ? "ok" : out.substr (0, 400).c_str ());
        ok = ok && built;
    }
    CHECK (ok, "a shadow shader didn't build");
    return true;
}

// F4: the casters' SKINNING / MORPHING combos build (the shader sweep's 10 failures). WE sets BONECOUNT to the bone count
// with SKINNING (GH 0x140230ec0); shadowcasterfoliage4 reads the engine's g_Texture1Texel without declaring it, and
// shadowcasterfur4 passes gl_VertexID (int) to ApplyMorphPosition's uint, which HLSL converts. Unpatched: "array size
// must be a positive integer", "'g_Texture1Texel' : undeclared identifier", "no matching overloaded function"
static bool skinned_casters_compile () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string dir = world_scene ("", "{\"id\":1,\"name\":\"m\",\"model\":\"models/b14quad.mdl\",\"origin\":\"0 0 0\"}");
    ScriptRig rig;
    rig.width = kW3;
    rig.height = kH3;
    rig.extra = b14_model (dir, "\"LIGHTING\":1");
    CHECK (rig.open (dir), "load/build of %s failed", dir.c_str ());
    const char* casters[] = { "shadowcaster", "shadowcasterfoliage4", "shadowcasterfur4" };
    const char* combos[] = {
        "{\"SKINNING\":1}",
        "{\"MORPHING\":1}",
        "{\"BONECOUNT\":1,\"MORPHING\":1,\"MORPHING_NORMALS\":1}",
        "{\"BONECOUNT\":4,\"MORPHING\":1,\"SKINNING\":1}",
    };
    bool ok = true;
    for (const char* shader : casters) {
        for (const char* c : combos) {
            const std::string request = std::string ("{\"combos\":") + c + "}";
            std::string out (8192, '\0');
            wp_project_shader_check (rig.p, shader, request.c_str (), out.data (), out.size ());
            out.resize (strlen (out.c_str ()));
            const bool built = out.find ("\"ok\":true") != std::string::npos;
            printf ("    %s %s: %s\n", shader, c, built ? "ok" : out.substr (0, 300).c_str ());
            ok = ok && built;
        }
    }
    CHECK (ok, "a skinned or morphed caster didn't build");
    return true;
}

// F4: a model object with a skeleton and blend shapes is posed by its animation layers and skinned / morphed on the
// GPU (generic4's SKINNING with g_Bones and BONECOUNT, MORPHING over the g_Texture5 morph map; GH 0x140230ec0 sets the
// combos). The 4 x 4 quad (morph_puppet's mesh, all on bone 0) seen from z 40 (1 unit ≈ 29 px): its animation moves
// the bone +2 units, so the quad covers x 0..4; with the "stretch" weight 1 its right edge goes 6 more, x 0..10.
// Unpatched: the static quad at x −2..2 (models had no animation layers)
static bool model_skins_and_morphs () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const auto edges = [] (int shape, std::pair<int, int>& span) {
        const std::string object = "{\"id\":1,\"name\":\"m\",\"model\":\"models/skin.mdl\",\"origin\":\"0 0 0\","
                                   "\"animationlayers\":[{\"id\":10,\"animation\":7,\"rate\":1,\"blend\":1,\"visible\":true}]}";
        const std::string dir = world_scene ("", object, "0 0 40");
        mkdir ((dir + "/models").c_str (), 0755);
        mkdir ((dir + "/materials").c_str (), 0755);
        MdlWriter m;
        m.out = morph_puppet ();
        m.section ("MDLS0004", puppet_skeleton (4)).section ("MDLA0006", morph_animation (7, -1.0f, shape, 2.0f))
            .section ("MDMP0001", morph_targets ());
        write_file (dir + "/models/skin.mdl", m.out);
        write_file (dir + "/materials/morph.json", "{\"passes\":[{\"shader\":\"generic4\",\"blending\":\"normal\",\"textures\":[\"util/white\"],"
                                                   "\"combos\":{\"LIGHTING\":0,\"FOG\":0}}]}\n");
        ScriptRig rig;
        rig.width = kW3;
        rig.height = kH3;
        rig.extra = { "models/skin.mdl", "materials/morph.json" };
        if (!rig.open (dir)) {
            return false;
        }
        for (int i = 0; i < 3; i++) {
            rig.step ();
        }
        span = span_x (rig, kH3 / 2, [] (const std::array<unsigned char, 4>& px) { return px[0] > 128; });
        return true;
    };
    std::pair<int, int> skinned, morphed;
    CHECK (edges (-1, skinned), "load/build failed (skinned)");
    CHECK (edges (0, morphed), "load/build failed (skinned + stretch)");
    const double unit = kH3 / (80.0 * std::tan (25.0 * M_PI / 180.0));
    printf ("    1 unit = %.1f px; skinned x %d..%d (want %.0f..%.0f), + stretch %d..%d (want ..%.0f)\n", unit, skinned.first,
            skinned.second, kW3 / 2.0, kW3 / 2.0 + 4 * unit, morphed.first, morphed.second, kW3 / 2.0 + 10 * unit);
    CHECK (std::abs (skinned.first - kW3 / 2) <= 4 && std::abs (skinned.second - (kW3 / 2 + 4 * unit)) <= 4,
           "the bone's animation didn't move the quad to x 0..4");
    CHECK (std::abs (morphed.first - kW3 / 2) <= 4 && std::abs (morphed.second - (kW3 / 2 + 10 * unit)) <= 4,
           "the stretch weight didn't move the right edge to x 10");
    return true;
}

// a tube light lights from the nearest point of its segment (origin to `controlpoint`, GH 0x1401bf270's second
// loop: g_LCluster_Direction = the far end) and a directional light from its −x axis at any distance
// (g_LDirectional_*, ComputePBRLightShadowInfinite); unpatched both were "Other" lights, the quad black
static bool tube_and_directional_lights () {
    if (!script_tests_can_run ()) {
        return true;
    }
    std::array<unsigned char, 4> tube {}, tubeFar {}, directional {}, away {};
    const std::string t = ",{\"id\":2,\"name\":\"l\",\"light\":\"ltube\",\"color\":\"1.0 1.0 1.0\",\"intensity\":4,\"radius\":20,\"exponent\":1,"
                          "\"controlpoint\":\"8 0 0\"";
    CHECK (model_centre (kF1Black, "\"LIGHTING\":1,\"FOG\":0", t + ",\"origin\":\"-4 0 1\"}", tube), "load failed (tube)");
    CHECK (model_centre (kF1Black, "\"LIGHTING\":1,\"FOG\":0", t + ",\"origin\":\"-4 0 18\"}", tubeFar), "load failed (tube far)");
    const std::string d = ",{\"id\":2,\"name\":\"l\",\"light\":\"ldirectional\",\"origin\":\"40 0 300\",\"color\":\"1.0 1.0 1.0\",\"intensity\":1";
    CHECK (model_centre (kF1Black, "\"LIGHTING\":1,\"FOG\":0", d + ",\"angles\":\"0 1.5707964 0\"}", directional), "load failed (directional)");
    CHECK (model_centre (kF1Black, "\"LIGHTING\":1,\"FOG\":0", d + ",\"angles\":\"0 -1.5707964 0\"}", away), "load failed (directional away)");
    printf ("    tube 1 unit over the quad %d, 18 units %d; directional at it %d, away %d\n", tube[0], tubeFar[0], directional[0], away[0]);
    CHECK (tube[0] > 40 && tube[0] == tube[1], "the tube light doesn't light the quad");
    CHECK (tubeFar[0] < tube[0], "the tube's falloff doesn't fall off");
    CHECK (directional[0] > 40, "the directional light doesn't light the quad");
    CHECK (away[0] < 8, "the directional light pointing away lights the quad");
    return true;
}

// ---------------------------------------------------------------------------------------------
// F5 (docs/player/spikes/we-coverage.md, the audit's "F5/F6 result"): an orthographic scene's perspective layers and
// particles. WE's image draw (GH 0x140214b50) and particle render (GH 0x14025bc30) swap in the perspective camera of
// GH 0x1401b4fd0 for a layer with `perspective` (flag 0x80) and a system with flags bit 2: fov =
// perspectiveoverridefov, the eye at d = (h / 2) / tan (fov / 2) so z 0 lands where the orthographic camera puts it,
// near 5, far max (15000, d + 1000). 64 x 32 at fov 90: d = 16, so z 8 draws twice as large

// the covered columns of the centre row of a 2D layer scene with `general` and one 8 x 8 square at (32, 16, z)
static std::string persp_row (const std::string& general, const std::string& props) {
    const std::string dir = camera_scene (general, square (1, "\"origin\":\"32 16 0\"," + props));
    ScriptRig rig;
    if (!rig.open (dir)) {
        return "load failed";
    }
    rig.step ();
    return rig.row ();
}

// the first and last covered columns of a row
static std::pair<int, int> persp_span (const std::string& row) {
    const auto a = row.find ('#'), b = row.rfind ('#');
    return a == std::string::npos ? std::pair<int, int> { -1, -1 } : std::pair<int, int> { (int) a, (int) b };
}

// unpatched: `perspective` and `perspectiveoverridefov` weren't read, every layer was flat (z and x/y angles ignored)
static bool perspective_layers_in_2d () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string fov90 = "\"perspectiveoverridefov\":90";
    const std::string flat = persp_row (fov90, "\"perspective\":true");
    const std::string flatDefault = persp_row ("\"zoom\":1", "\"perspective\":true");
    const std::string nearer = persp_row (fov90, "\"perspective\":true,\"origin\":\"32 16 8\"");
    const std::string nearerFlat = persp_row (fov90, "\"perspective\":false,\"origin\":\"32 16 8\"");
    const std::string turned = persp_row (fov90, "\"perspective\":true,\"angles\":\"0 1.0471976 0\"");
    const std::string turnedFlat = persp_row (fov90, "\"angles\":\"0 1.0471976 0\"");
    const std::string zoomed = persp_row ("\"perspectiveoverridefov\":90,\"zoom\":2", "\"perspective\":true,\"origin\":\"32 16 8\"");
    printf ("    perspective z 0:      %s\n    default fov 95 z 0:   %s\n    perspective z 8:      %s\n"
            "    flat z 8:             %s\n    perspective 60° y:    %s\n    flat 60° y:           %s\n"
            "    z 8, zoom 2:          %s\n",
            flat.c_str (), flatDefault.c_str (), nearer.c_str (), nearerFlat.c_str (), turned.c_str (), turnedFlat.c_str (),
            zoomed.c_str ());
    CHECK (flat == covered (28, 35), "a perspective layer at z 0 isn't where a flat one is");
    CHECK (flatDefault == covered (28, 35), "at the default fov (95) z 0 moved");
    CHECK (nearer == covered (24, 39), "z 8 at fov 90 (d 16) isn't twice the size");
    CHECK (nearerFlat == covered (28, 35), "a flat layer took its z");
    const auto t = persp_span (turned);
    const int w = t.second - t.first + 1;
    CHECK (w >= 3 && w <= 6 && t.first >= 28 && t.second <= 35, "turned 60° about y isn't about half as wide (%d px)", w);
    CHECK (turnedFlat == covered (28, 35), "a flat layer took its y angle");
    CHECK (zoomed == covered (16, 47), "the zoom doesn't scale the perspective view");

    // a particle system with flags 4: one 8 px particle at the origin, z 0 and z 8 (unpatched: general.fov 50 from an
    // eye at z 1000, so z 0 drew 1.16 x and z 8 almost the same; LWE's sprite of size 8 covers 4 px)
    const std::string white = "{\"name\":\"colorrandom\",\"min\":\"255 255 255\",\"max\":\"255 255 255\"}";
    const std::string life = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";
    std::string sys = particle_system ("opaque", ",\"maxcount\":1,\"flags\":4",
                                       ",\"distancemin\":0,\"distancemax\":0,\"rate\":0,\"instantaneous\":1", white + "," + life);
    sys.replace (sys.find ("\"min\":12,\"max\":12"), 17, "\"min\":8,\"max\":8");
    auto particleWidth = [&] (int z, bool persp = true) {
        std::vector<std::string> files;
        std::string sys2 = sys;
        if (!persp) {
            sys2.replace (sys2.find (",\"flags\":4"), 10, "");
        }
        std::string obj = particle_object (1, "p.json", 32, 16);
        obj.replace (obj.find ("32 16 0"), 7, "32 16 " + std::to_string (z));
        const std::string dir = particle_scene (obj, "0 0 0", { { "p.json", sys2 } }, files);
        std::string scene = read_file (dir + "/scene.json");
        scene.replace (scene.find ("\"orthogonalprojection\""), 0, fov90 + ",");
        write_file (dir + "/scene.json", scene);
        ScriptRig rig;
        if (!particle_rig_open (rig, dir, files)) {
            return -1;
        }
        rig.step ();
        rig.step ();
        int lit = 0;
        for (int x = 0; x < 64; x++) {
            unsigned char px[4] = { 0, 0, 0, 0 };
            read_pixel (rig.fbo, x, 16, px);
            lit += px[0] > 64;
        }
        return lit;
    };
    const int p0 = particleWidth (0), p8 = particleWidth (8), flat0 = particleWidth (0, false);
    printf ("    perspective particle 8 px: z 0 %d px, z 8 %d px (want the flat size, twice it); flat %d px\n", p0, p8,
            flat0);
    CHECK (flat0 > 0 && p0 == flat0, "a perspective particle at z 0 is %d px, a flat one %d", p0, flat0);
    CHECK (std::abs (p8 - 2 * flat0) <= 1, "a perspective particle at z 8 is %d px, not twice %d", p8, flat0);
    return true;
}

// a 2D layer scene (camera_scene) that names `camera.paths` = ["camera_paths.json"] with `paths` as that file's list
static std::string path_scene (const std::string& general, const std::string& paths, const std::string& objects) {
    const std::string dir = camera_scene (general, objects);
    std::string scene = read_file (dir + "/scene.json");
    scene.replace (scene.find ("\"camera\":{"), 10, "\"camera\":{\"paths\":[\"camera_paths.json\"],");
    write_file (dir + "/scene.json", scene);
    write_file (dir + "/camera_paths.json", "{\"paths\":[" + paths + "]}\n");
    return dir;
}

// camera paths (GH 0x1401c6ef0 parses them, GH 0x1401b8af0 plays them while no camera object is active: a cubic
// Hermite between keys with both tangents half the difference, so the midpoint is the mean; a key's zoom replaces
// general.zoom) and camerafade (GH 0x1401afbf0: 1 − 2 t over the first 0.5 s of a path, fade.json's colour).
// Unpatched: `camera.paths` and `camerafade` were not read
static bool camera_paths_and_fade () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string sq = square (1, "\"origin\":\"32 16 0\"");
    const std::string zoomPath = "{\"duration\":4,\"transforms\":[{\"eye\":\"0 0 0\",\"zoom\":2},{\"eye\":\"0 0 0\",\"zoom\":2}]}";
    ScriptRig zoomed;
    zoomed.extra = { "camera_paths.json" };
    CHECK (zoomed.open (path_scene ("\"camerafade\":false", zoomPath, sq)), "load failed (zoom path)");
    zoomed.step ();
    const std::string z2 = zoomed.row ();

    ScriptRig withCamera;
    withCamera.extra = { "camera_paths.json" };
    CHECK (withCamera.open (path_scene ("\"camerafade\":false", zoomPath,
                                        sq + ",{\"id\":2,\"name\":\"cam\",\"camera\":\"default\",\"zoom\":1}")),
           "load failed (camera object)");
    withCamera.step ();
    const std::string cam = withCamera.row ();

    // the eye from x 0 to 16 over 2 s: at 1 s it is at 8, the square 8 px left
    const std::string movePath = "{\"duration\":2,\"transforms\":[{\"eye\":\"0 0 0\"},{\"eye\":\"16 0 0\"}]}";
    ScriptRig moving;
    moving.extra = { "camera_paths.json" };
    CHECK (moving.open (path_scene ("\"camerafade\":true", movePath, sq)), "load failed (moving path)");
    moving.step ();
    unsigned char px[4] = { 0, 0, 0, 0 };
    read_pixel (moving.fbo, 2, 2, px);
    const int blueEarly = px[2];
    for (int i = 0; i < 28; i++) {
        moving.step ();
    }
    const std::string mid = moving.row ();
    read_pixel (moving.fbo, 2, 2, px);
    const int blueMid = px[2];
    printf ("    path zoom 2:          %s\n    with a camera object: %s\n    eye 8 at 1 s:         %s\n"
            "    camerafade: clear blue %d at the start, %d mid-path (want < 70, ~128)\n",
            z2.c_str (), cam.c_str (), mid.c_str (), blueEarly, blueMid);
    CHECK (z2 == covered (24, 39), "the path's zoom 2 didn't double the square");
    CHECK (cam == covered (28, 35), "a camera object didn't take precedence over the paths");
    const int left = left_edge (mid);
    CHECK (left >= 18 && left <= 22, "the path's eye at 1 s didn't move the square 8 px left (left edge %d)", left);
    CHECK (blueEarly < 70 && blueMid > 110, "camerafade: %d at the start, %d mid-path", blueEarly, blueMid);
    return true;
}

// a 3D scene's transparentsorting key (GH 0x1401b6660, comparator GH 0x1401cc550): sortorder ascending, then
// farthest first along the view. Unpatched: sortorder wasn't read (the distance alone ordered the run)
static bool transparent_sort_takes_sortorder () {
    if (!script_tests_can_run ()) {
        return true;
    }
    auto centre = [] (int nearOrder, int farOrder, bool& redOnTop) {
        const std::string near = "{\"id\":1,\"name\":\"g\",\"image\":\"models/b15green.json\",\"size\":\"200 200\","
                                 "\"scale\":\"0.01 0.01 0.01\",\"origin\":\"0 0 2\",\"sortorder\":" + std::to_string (nearOrder) + "}";
        const std::string far = "{\"id\":2,\"name\":\"r\",\"image\":\"models/b15red.json\",\"size\":\"200 200\","
                                "\"scale\":\"0.01 0.01 0.01\",\"origin\":\"0 0 0\",\"sortorder\":" + std::to_string (farOrder) + "}";
        const std::string dir = world_scene (",\"transparentsorting\":true", near + "," + far);
        ScriptRig rig;
        rig.width = kW3;
        rig.height = kH3;
        rig.extra = b7_layer (dir, "b15red", "gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);");
        const auto green = b7_layer (dir, "b15green", "gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);");
        rig.extra.insert (rig.extra.end (), green.begin (), green.end ());
        if (!rig.open (dir)) {
            return false;
        }
        rig.step ();
        redOnTop = is_red (pixel_xy (rig, kW3 / 2, kH3 / 2));
        return true;
    };
    bool plain = true, ordered = false;
    CHECK (centre (0, 0, plain), "load failed (same order)");
    CHECK (centre (0, 1, ordered), "load failed (far sortorder 1)");
    printf ("    same sortorder: %s on top; the far layer's sortorder 1: %s on top\n", plain ? "red (far)" : "green (near)",
            ordered ? "red (far)" : "green (near)");
    CHECK (!plain, "back to front: the near layer isn't on top");
    CHECK (ordered, "the far layer's higher sortorder didn't draw it last");
    return true;
}

// ---------------------------------------------------------------------------------------------
// F6: the operators and initializers only WE's stock presets use (the audit's "F5/F6 result"). Unpatched the parser
// dropped each one ("unsupported particle operator/initializer"), so these systems ran without them. 64 x 32, one
// system per scene at the centre, white 4 px particles that live 100 s on black (opaque material)

struct StockRig {
    ScriptRig rig;
    bool open (const std::string& system, const std::vector<std::pair<std::string, std::string>>& more = {}, int steps = 15) {
        std::vector<std::string> files;
        std::vector<std::pair<std::string, std::string>> systems = { { "s.json", system } };
        systems.insert (systems.end (), more.begin (), more.end ());
        const std::string dir = particle_scene (particle_object (1, "s.json", 32, 16), "0 0 0", systems, files);
        if (!particle_rig_open (rig, dir, files)) {
            return false;
        }
        for (int i = 0; i < steps; i++) {
            rig.step ();
        }
        return true;
    }
    std::array<unsigned char, 4> at (int x, int y) {
        std::array<unsigned char, 4> px {};
        read_pixel (rig.fbo, x, y, px.data ());
        return px;
    }
    bool lit (int x, int y) {
        const auto px = at (x, y);
        return px[0] > 64 || px[1] > 64 || px[2] > 64;
    }
    // lit columns of row y as '#'/'.'
    std::string row (int y) {
        std::string out;
        for (int x = 0; x < 64; x++) {
            out += lit (x, y) ? '#' : '.';
        }
        return out;
    }
    int litCount () {
        int n = 0;
        for (int y = 0; y < 32; y++) {
            for (int x = 0; x < 64; x++) {
                n += lit (x, y);
            }
        }
        return n;
    }
};

static const char* kStockWhite = "{\"name\":\"colorrandom\",\"min\":\"255 255 255\",\"max\":\"255 255 255\"}";
static const char* kStockLife = "{\"name\":\"lifetimerandom\",\"min\":100,\"max\":100}";

// a system: `emitter` (a whole emitter object), size 4 + white + 100 s life + `inits`, then `ops`; `top` more members
static std::string stock_system (const std::string& emitter, const std::string& inits, const std::string& ops,
                                 const std::string& top = "") {
    return std::string ("{\"material\":\"materials/opaque.json\",\"maxcount\":20") + top + ",\"emitter\":[" + emitter + "],"
         + "\"initializer\":[{\"name\":\"sizerandom\",\"min\":4,\"max\":4}," + kStockWhite + "," + kStockLife
         + (inits.empty () ? "" : "," + inits) + "],\"operator\":[" + ops + "]}\n";
}

// one particle at the origin (or `count` of them), `speed` "x y z" (WE's y up)
static std::string stock_point (int count = 1) {
    return "{\"name\":\"sphererandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 0\",\"distancemin\":0,\"distancemax\":0,"
           "\"rate\":0,\"instantaneous\":" + std::to_string (count) + "}";
}
static std::string stock_velocity (const char* v) {
    return std::string ("{\"name\":\"velocityrandom\",\"min\":\"") + v + "\",\"max\":\"" + v + "\"}";
}

// capvelocity (case 0x12: v ×= min (1, maxspeed / |v|)), reducemovementnearcontrolpoint (case 0xd), boids (case
// 0x11: cohesion pulls two particles 20 px apart together), maintaindistancetocontrolpoint (case 0xb: a particle 10 px
// from control point 1 put at `distance` 4), remapvalue (lifetimefraction → opacity 0.5)
static bool particle_stock_motion_operators () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string move = "{\"name\":\"movement\"}";
    const std::string fast = stock_velocity ("60 0 0");
    StockRig free, capped, reduced, flock, kept, remapped;
    CHECK (free.open (stock_system (stock_point (), fast, move)), "load failed (free)");
    CHECK (capped.open (stock_system (stock_point (), fast, move + ",{\"name\":\"capvelocity\",\"maxspeed\":10}")), "load failed (cap)");
    CHECK (reduced.open (stock_system (stock_point (), fast,
               move + ",{\"name\":\"reducemovementnearcontrolpoint\",\"distanceinner\":100,\"distanceouter\":200,\"reductioninner\":1000}")),
           "load failed (reduce)");
    const std::string pair = "{\"name\":\"boxrandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 1\",\"distancemin\":\"10 0 0\","
                             "\"distancemax\":\"10 0 0\",\"rate\":0,\"instantaneous\":2}";
    CHECK (flock.open (stock_system (pair, "", "{\"name\":\"movement\",\"drag\":1},{\"name\":\"boids\",\"cohesionfactor\":30,"
                                               "\"alignmentfactor\":0,\"neighborthreshold\":50,\"maxspeed\":500}"), {}, 20),
           "load failed (boids)");
    CHECK (kept.open (stock_system (stock_point (), "",
               "{\"name\":\"maintaindistancetocontrolpoint\",\"controlpoint\":1,\"distance\":4}",
               ",\"controlpoint\":[{\"id\":1,\"offset\":\"10 0 0\"}]")),
           "load failed (maintain)");
    CHECK (remapped.open (stock_system (stock_point (), "",
               "{\"name\":\"remapvalue\",\"input\":\"lifetimefraction\",\"output\":\"opacity\",\"outputrangemin\":0.5,\"outputrangemax\":0.5}")),
           "load failed (remap)");
    const std::string f = free.row (16), c = capped.row (16), r = reduced.row (16), b = flock.row (16), k = kept.row (16);
    const int alpha = remapped.at (32, 16)[0];
    printf ("    free 60 px/s, 0.5 s: %s\n    capvelocity 10:      %s\n    reduced near cp 0:   %s\n"
            "    boids cohesion:      %s\n    maintain 4 from cp:  %s\n    remap opacity 0.5: red %d\n",
            f.c_str (), c.c_str (), r.c_str (), b.c_str (), k.c_str (), alpha);
    CHECK (left_edge (f) >= 50, "the free particle didn't move (%s)", f.c_str ());
    CHECK (left_edge (c) >= 32 && left_edge (c) <= 40, "capvelocity 10 didn't slow it (left edge %d)", left_edge (c));
    CHECK (left_edge (r) >= 28 && left_edge (r) <= 36, "the reduction near the control point didn't stop it (left edge %d)", left_edge (r));
    const int flockLeft = left_edge (b), flockRight = static_cast<int> (b.rfind ('#'));
    CHECK (flockLeft > 23 && flockRight < 41 && flockRight - flockLeft <= 8, "boids' cohesion didn't pull the pair together (%s)", b.c_str ());
    const int keptAt = left_edge (k);
    CHECK (keptAt >= 34 && keptAt <= 38, "the particle isn't 4 px from the control point 10 px right (left edge %d)", keptAt);
    CHECK (alpha >= 110 && alpha <= 145, "remapvalue opacity 0.5: red %d", alpha);
    return true;
}

// the collisions: a plane (case 0x15) a falling particle slides on, a sphere (0x16) that deletes what's in it, a
// quad (0x19) a particle beside it falls past, the scene's bounds (0x18) a fast particle stops at
static bool particle_stock_collisions () {
    if (!script_tests_can_run ()) {
        return true;
    }
    const std::string fall = stock_velocity ("0 -60 0");
    const std::string move = "{\"name\":\"movement\"}";
    StockRig plane, sphere, quad, bounds;
    CHECK (plane.open (stock_system (stock_point (), fall,
               move + ",{\"name\":\"collisionplane\",\"plane\":\"0 1 0\",\"distance\":-6,\"collisionbehavior\":\"slide\"}")),
           "load failed (plane)");
    CHECK (sphere.open (stock_system (stock_point (), "",
               "{\"name\":\"collisionsphere\",\"origin\":\"0 0 0\",\"radius\":20,\"collisionbehavior\":\"delete\"}")),
           "load failed (sphere)");
    const std::string beside = "{\"name\":\"sphererandom\",\"origin\":\"20 0 0\",\"directions\":\"1 1 0\",\"distancemin\":0,"
                               "\"distancemax\":0,\"rate\":0,\"instantaneous\":1}";
    CHECK (quad.open (stock_system (beside, fall,
               move + ",{\"name\":\"collisionquad\",\"origin\":\"0 -6 0\",\"plane\":\"0 1 0\",\"forward\":\"0 0 1\","
                      "\"size\":\"20 20\",\"collisionbehavior\":\"slide\"}")),
           "load failed (quad)");
    CHECK (bounds.open (stock_system (stock_point (), stock_velocity ("400 0 0"),
               move + ",{\"name\":\"collisionbounds\",\"collisionbehavior\":\"slide\"}")),
           "load failed (bounds)");
    auto lowest = [] (StockRig& s, int x) {
        int y = -1;
        for (int row = 0; row < 32; row++) {
            if (s.lit (x, row)) {
                y = row;
            }
        }
        return y;
    };
    const int planeLow = lowest (plane, 32), quadLow = lowest (quad, 52);
    const int sphereLit = sphere.litCount ();
    const std::string edge = bounds.row (16);
    printf ("    plane at y -6: lowest lit row %d (want ~22); sphere delete: %d px lit; beside the quad: lowest row %d "
            "(fell past); bounds: %s\n", planeLow, sphereLit, quadLow, edge.c_str ());
    CHECK (planeLow >= 20 && planeLow <= 24, "the plane didn't stop the particle (lowest row %d)", planeLow);
    CHECK (sphereLit == 0, "the sphere didn't delete the particle (%d px lit)", sphereLit);
    CHECK (quadLow == -1 || quadLow > 26, "the particle beside the quad was stopped (row %d)", quadLow);
    CHECK (edge.back () == '#', "the bounds didn't keep the particle on screen (%s)", edge.c_str ());
    return true;
}

// the initializers: hsvcolorrandom (hue 1/3 → green), colorlist (one blue), positionoffsetrandom (10 particles
// spread along x), remapinitialvalue (size × 2 at spawn), mapsequencebetweencontrolpoints (3 particles from control
// point 0 to 1) with maintaindistancebetweencontrolpoints carrying them as control point 1 follows the pointer,
// inheritcontrolpointvelocity (a particle born on the moving pointer drifts with it), and an eventspawn child that
// takes its (invisible) parent particle's colour (inheritinitialvaluefromevent setcolor; inheritvaluefromevent
// multiplycolor keeps it red)
static bool particle_stock_initializers () {
    if (!script_tests_can_run ()) {
        return true;
    }
    StockRig hsv, list, offset, sized, plain;
    CHECK (hsv.open (stock_system (stock_point (), "{\"name\":\"hsvcolorrandom\",\"huemin\":0.3333,\"huemax\":0.3333,"
                                                   "\"saturationmin\":1,\"saturationmax\":1,\"valuemin\":1,\"valuemax\":1}", "")),
           "load failed (hsv)");
    CHECK (list.open (stock_system (stock_point (), "{\"name\":\"colorlist\",\"colors\":[\"0 0 1\"]}", "")), "load failed (colorlist)");
    CHECK (offset.open (stock_system (stock_point (10), "{\"name\":\"positionoffsetrandom\",\"distance\":12,\"scale\":0,"
                                                         "\"directions\":\"1 0 0\"}", "")),
           "load failed (offset)");
    CHECK (sized.open (stock_system (stock_point (), "{\"name\":\"remapinitialvalue\",\"input\":\"lifetimefraction\",\"output\":\"size\","
                                                     "\"operation\":\"multiply\",\"outputrangemin\":2,\"outputrangemax\":2}", "")),
           "load failed (remapinitialvalue)");
    CHECK (plain.open (stock_system (stock_point (), "", "")), "load failed (plain)");
    const auto green = hsv.at (32, 16), blue = list.at (32, 16);
    const std::string spread = offset.row (16), big = sized.row (16), small = plain.row (16);
    auto width = [] (const std::string& r) { return static_cast<int> (std::count (r.begin (), r.end (), '#')); };
    printf ("    hsv hue 1/3: %d %d %d; colorlist blue: %d %d %d\n    offset ±12 x: %s\n    remapinitialvalue size × 2: %s (plain %s)\n",
            green[0], green[1], green[2], blue[0], blue[1], blue[2], spread.c_str (), big.c_str (), small.c_str ());
    CHECK (green[1] > 200 && green[0] < 60 && green[2] < 60, "hsvcolorrandom hue 1/3 isn't green");
    CHECK (blue[2] > 200 && blue[0] < 60 && blue[1] < 60, "colorlist's only colour isn't blue");
    CHECK (std::abs (left_edge (spread) - static_cast<int> (spread.rfind ('#'))) >= 10, "positionoffsetrandom didn't spread them");
    CHECK (width (big) == 2 * width (small), "remapinitialvalue didn't double the size (%d vs %d)", width (big), width (small));

    // control point 0 at x −20, control point 1 on the pointer (scene x 52, then 52 + 8 · k): three particles at 0,
    // ½ and 1 along it; the segment's end moves 8 px right per step for 2 steps, so the middle moves 8, the end 16
    const std::string cps = ",\"controlpoint\":[{\"id\":0,\"offset\":\"-20 0 0\"},{\"id\":1,\"flags\":1,\"offset\":\"0 0 0\"}]";
    const std::string seq = "{\"name\":\"mapsequencebetweencontrolpoints\",\"controlpointstart\":0,\"controlpointend\":1,\"count\":3}";
    StockRig between, fixedEnds;
    between.rig.mouse = &g_mouse;
    fixedEnds.rig.mouse = &g_mouse;
    g_mouseX = 52.0;
    g_mouseY = 16.0;
    CHECK (fixedEnds.open (stock_system (stock_point (3), seq, "", cps), {}, 2), "load failed (sequence)");
    const std::string placed = fixedEnds.row (16);
    g_mouseX = 52.0;
    CHECK (between.open (stock_system (stock_point (3), seq,
               "{\"name\":\"maintaindistancebetweencontrolpoints\",\"controlpointstart\":0,\"controlpointend\":1}", cps), {}, 2),
           "load failed (between)");
    for (int i = 0; i < 2; i++) {
        g_mouseX += 8.0;
        between.rig.step ();
    }
    const std::string carried = between.row (16);

    // a particle born on the pointer, which moves 2 px per step (60 px/s): inheritcontrolpointvelocity min = max = 1
    StockRig inherit;
    inherit.rig.mouse = &g_mouse;
    g_mouseX = 10.0;
    const std::string onPointer = "{\"name\":\"sphererandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 0\",\"distancemin\":0,"
                                  "\"distancemax\":0,\"rate\":0,\"instantaneous\":0}";
    std::string carriedSys = stock_system (onPointer, "{\"name\":\"inheritcontrolpointvelocity\",\"controlpoint\":0,\"min\":1,\"max\":1}",
                                           "{\"name\":\"movement\"}", ",\"controlpoint\":[{\"id\":0,\"flags\":1,\"offset\":\"0 0 0\"}]");
    // one particle at the control point once the pointer moves (rate 30/s from the first step, maxcount 1)
    carriedSys.replace (carriedSys.find ("\"maxcount\":20"), 13, "\"maxcount\":1");
    carriedSys.replace (carriedSys.find ("\"rate\":0"), 8, "\"rate\":30");
    carriedSys.replace (carriedSys.find ("\"directions\":\"1 1 0\","), 21, "\"directions\":\"1 1 0\",\"controlpoint\":0,\"delay\":0.1,");
    CHECK (inherit.open (carriedSys, {}, 1), "load failed (inherit velocity)");
    for (int i = 0; i < 6; i++) {
        g_mouseX += 2.0;
        inherit.rig.step ();
    }
    const double stop = g_mouseX;
    for (int i = 0; i < 15; i++) {
        inherit.rig.step ();
    }
    const std::string drift = inherit.row (16);

    // an eventspawn child (white) of a red parent of alpha 0: setcolor → red; inheritvaluefromevent multiplycolor keeps it
    const std::string red = "{\"name\":\"colorrandom\",\"min\":\"255 0 0\",\"max\":\"255 0 0\"}";
    std::string parent = stock_system (stock_point (), red + ",{\"name\":\"alpharandom\",\"min\":0,\"max\":0}", "", ",\"children\":[{\"name\":\"particles/c.json\",\"type\":\"eventspawn\"}]");
    std::string child = stock_system ("{\"name\":\"sphererandom\",\"origin\":\"0 0 0\",\"directions\":\"1 1 0\",\"distancemin\":0,"
                                      "\"distancemax\":0,\"rate\":0,\"instantaneous\":1}",
                                      "{\"name\":\"inheritinitialvaluefromevent\",\"input\":\"setcolor\"}",
                                      "{\"name\":\"inheritvaluefromevent\",\"input\":\"multiplycolor\"}");
    child.replace (child.find ("\"min\":4,\"max\":4"), 15, "\"min\":8,\"max\":8");
    StockRig event;
    CHECK (event.open (parent, { { "c.json", child } }, 5), "load failed (event child)");
    const auto childPx = event.at (32, 16);
    printf ("    sequence 0, ½, 1 (cp 0 at 12, cp 1 at 52): %s\n    the end moved 16 px:   %s\n"
            "    pointer stopped at %.0f, the particle drifted on: %s\n    event child of a red particle: %d %d %d\n",
            placed.c_str (), carried.c_str (), stop, drift.c_str (), childPx[0], childPx[1], childPx[2]);
    CHECK (fixedEnds.lit (12, 16) && fixedEnds.lit (32, 16) && fixedEnds.lit (52, 16), "the sequence isn't at 12, 32, 52 (%s)", placed.c_str ());
    CHECK (between.lit (12, 16) && between.lit (40, 16) && !between.lit (52, 16) && !between.lit (32, 16),
           "the segment didn't carry its particles (%s)", carried.c_str ());
    CHECK (left_edge (drift) > static_cast<int> (stop) + 4, "the particle didn't take the pointer's velocity (%s)", drift.c_str ());
    CHECK (childPx[0] > 200 && childPx[1] < 60 && childPx[2] < 60, "the event child didn't take its particle's colour");
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
    // B3: the particles are the same on every run
    setenv ("WPENGINE_PARTICLE_SEED", "1", 1);
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
    run ("object_uniforms_are_live", object_uniforms_are_live);
    run ("keyframes_drive_alpha", keyframes_drive_alpha);
    run ("keyframes_move_origin", keyframes_move_origin);
    run ("particle_count_rate_and_prewarm", particle_count_rate_and_prewarm);
    run ("particle_colorrandom_one_t", particle_colorrandom_one_t);
    run ("particle_colorn_hsv_shift", particle_colorn_hsv_shift);
    run ("particle_hide_resets_and_overrides_live", particle_hide_resets_and_overrides_live);
    run ("particle_operators_as_we", particle_operators_as_we);
    run ("particle_children_run", particle_children_run);
    run ("particle_control_points", particle_control_points);
    run ("puppet_warp_as_we", puppet_warp_as_we);
    run ("parallax_follows_the_pointer", parallax_follows_the_pointer);
    run ("parallax_position_uniform", parallax_position_uniform);
    run ("particle_pointer_is_y_down", particle_pointer_is_y_down);
    run ("script_angles_are_degrees", script_angles_are_degrees);
    run ("shaders_compile_like_hlsl", shaders_compile_like_hlsl);
    run ("shaders_include_in_place", shaders_include_in_place);
    run ("fragment_varying_takes_vertex_type", fragment_varying_takes_vertex_type);
    run ("hlsl_conversions_compile", hlsl_conversions_compile);
    run ("hlsl_names_and_leftovers_compile", hlsl_names_and_leftovers_compile);
    run ("health_reports_what_was_dropped", health_reports_what_was_dropped);
    run ("camera_zoom_and_shake", camera_zoom_and_shake);
    run ("hidden_parent_hides_children", hidden_parent_hides_children);
    run ("particle_follows_its_parent", particle_follows_its_parent);
    run ("sprite_orientation_as_we", sprite_orientation_as_we);
    run ("aligned_layer_turns_about_its_origin", aligned_layer_turns_about_its_origin);
    run ("engine_uniforms_are_fed", engine_uniforms_are_fed);
    run ("bloom_is_live_and_tinted", bloom_is_live_and_tinted);
    run ("annotation_defaults_parse", annotation_defaults_parse);
    run ("fragment_gets_vertex_varyings", fragment_gets_vertex_varyings);
    run ("properties_list_as_written", properties_list_as_written);
    run ("usertexture_reads_its_property", usertexture_reads_its_property);
    run ("effect_visible_is_live", effect_visible_is_live);
    run ("clampuvs_clamps_the_composite", clampuvs_clamps_the_composite);
    run ("composite_a_is_what_the_last_pass_reads", composite_a_is_what_the_last_pass_reads);
    run ("compose_layer_draws_its_children", compose_layer_draws_its_children);
    run ("hdr_bloom_is_wes_chain", hdr_bloom_is_wes_chain);
    run ("fbo_formats_as_written", fbo_formats_as_written);
    run ("color_blend_modes_read_the_scene", color_blend_modes_read_the_scene);
    run ("layer_api_reaches_layers", layer_api_reaches_layers);
    run ("script_effect_and_property_changes", script_effect_and_property_changes);
    run ("text_script_is_a_real_layer", text_script_is_a_real_layer);
    run ("text_follows_its_parent_and_turns", text_follows_its_parent_and_turns);
    run ("text_lays_out_like_we", text_lays_out_like_we);
    run ("text_takes_effects_and_colour", text_takes_effects_and_colour);
    run ("colour_property_whole_numbers", colour_property_whole_numbers);
    run ("text_wraps_and_limits", text_wraps_and_limits);
    run ("perspective_scene_loads", perspective_scene_loads);
    run ("layer_tilts_and_moves_in_depth", layer_tilts_and_moves_in_depth);
    run ("model_draws_and_lights", model_draws_and_lights);
    run ("fog_and_depth", fog_and_depth);
    run ("shadow_casters_compile", shadow_casters_compile);
    run ("skinned_casters_compile", skinned_casters_compile);
    run ("model_skins_and_morphs", model_skins_and_morphs);
    run ("shadow_occludes_a_lit_point", shadow_occludes_a_lit_point);
    run ("cookie_projects_its_texture", cookie_projects_its_texture);
    run ("tube_and_directional_lights", tube_and_directional_lights);
    run ("media_events_reach_scripts", media_events_reach_scripts);
    run ("effect_script_this_object_is_the_effect", effect_script_this_object_is_the_effect);
    run ("script_plays_a_keyframe_animation", script_plays_a_keyframe_animation);
    run ("cursor_events_reach_layers", cursor_events_reach_layers);
    run ("local_storage_persists", local_storage_persists);
    run ("script_controls_a_sound", script_controls_a_sound);
    run ("layer_transform_api", layer_transform_api);
    run ("create_layer_builds_layers", create_layer_builds_layers);
    run ("create_model_data_draws", create_model_data_draws);
    run ("script_strings_and_regexp", script_strings_and_regexp);
    run ("video_texture_api", video_texture_api);
    run ("animation_layer_api", animation_layer_api);
    run ("puppet_animation_events", puppet_animation_events);
    run ("puppet_blend_shapes_and_alpha", puppet_blend_shapes_and_alpha);
    run ("particle_system_api", particle_system_api);
    run ("script_events_reach_scripts", script_events_reach_scripts);
    run ("resize_screen_reaches_scripts", resize_screen_reaches_scripts);
    run ("blending_sets_combos", blending_sets_combos);
    run ("alphawriting_masks_alpha", alphawriting_masks_alpha);
    run ("effect_fbo_fit_and_swap", effect_fbo_fit_and_swap);
    run ("texture_format_combos_per_slot", texture_format_combos_per_slot);
    run ("scene_camera_and_config_api", scene_camera_and_config_api);
    run ("audio_tones_land_in_we_bands", audio_tones_land_in_we_bands);
    run ("audio_left_right_and_resolutions", audio_left_right_and_resolutions);
    run ("audio_smoothing_is_dt_based", audio_smoothing_is_dt_based);
    run ("audio_reaches_shaders_scripts_and_emitters", audio_reaches_shaders_scripts_and_emitters);
    run ("perspective_layers_in_2d", perspective_layers_in_2d);
    run ("camera_paths_and_fade", camera_paths_and_fade);
    run ("transparent_sort_takes_sortorder", transparent_sort_takes_sortorder);
    run ("particle_stock_motion_operators", particle_stock_motion_operators);
    run ("particle_stock_collisions", particle_stock_collisions);
    run ("particle_stock_initializers", particle_stock_initializers);
    run ("sdl_stays_default_without_host_output", sdl_stays_default_without_host_output);
    run ("pull_on_sdl_context_returns_zero", pull_on_sdl_context_returns_zero);
    printf ("host_api_test: %d passed, %d failed\n", g_passes, g_failures);
    return g_failures ? 1 : 0;
}
