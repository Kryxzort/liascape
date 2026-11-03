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
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
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
        p = wp_project_load_folder (ctx, mouse, dir.c_str ());
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
    run ("parallax_follows_the_pointer", parallax_follows_the_pointer);
    run ("parallax_position_uniform", parallax_position_uniform);
    run ("camera_zoom_and_shake", camera_zoom_and_shake);
    run ("hidden_parent_hides_children", hidden_parent_hides_children);
    run ("particle_follows_its_parent", particle_follows_its_parent);
    run ("aligned_layer_turns_about_its_origin", aligned_layer_turns_about_its_origin);
    run ("engine_uniforms_are_fed", engine_uniforms_are_fed);
    run ("bloom_is_live_and_tinted", bloom_is_live_and_tinted);
    run ("annotation_defaults_parse", annotation_defaults_parse);
    run ("fragment_gets_vertex_varyings", fragment_gets_vertex_varyings);
    run ("properties_list_as_written", properties_list_as_written);
    run ("usertexture_reads_its_property", usertexture_reads_its_property);
    run ("effect_visible_is_live", effect_visible_is_live);
    run ("sdl_stays_default_without_host_output", sdl_stays_default_without_host_output);
    run ("pull_on_sdl_context_returns_zero", pull_on_sdl_context_returns_zero);
    printf ("host_api_test: %d passed, %d failed\n", g_passes, g_failures);
    return g_failures ? 1 : 0;
}
