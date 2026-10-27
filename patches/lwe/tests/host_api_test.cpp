// Tests of livepaper's patches to LWE's public API (patches/lwe/0003-0005), run by
// `bash scripts/lwe.sh test` against the built core. C++ only because LWE's public headers are:
// they use `struct` tags as type names (`wp_mute_check*`), which C rejects.
//
//   host_api_test <fixtures dir> <empty dir> [<WE assets dir>]
//
// Fixtures: min-scene (clear colour only — builds without WE's assets: docs/player/spikes/lwe-core.md
// §7) and fail-scene (loads, then its renderer build throws: an object with a missing parent).
//
// Exit 0 = every test passed (or SKIPped, with the reason printed); 1 = a failure. Needs
// SDL_AUDIODRIVER=dummy (the SDL test must not open a real device). The render tests need a
// surfaceless EGL desktop-GL 3.3 context (SKIP without one); the audio-mix test needs WE's assets
// (a scene only builds its renderer with them — SKIP without).
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <SDL.h>

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

static void run (const char* name, bool (*fn) ()) {
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

int main (int argc, char** argv) {
    if (argc < 3) {
        fprintf (stderr, "usage: %s <fixtures dir> <empty dir> [<WE assets dir>]\n", argv[0]);
        return 2;
    }
    g_fixtures = argv[1];
    g_emptyDir = argv[2];
    g_assets = argc > 3 ? argv[3] : "";
    setvbuf (stdout, nullptr, _IOLBF, 0);
    printf ("host_api_test: LWE core with livepaper patches\n");
    // order matters: nothing before the SDL tests may initialise SDL audio
    run ("host_output_replaces_sdl", host_output_replaces_sdl);
    run ("pull_without_streams_is_silence", pull_without_streams_is_silence);
    run ("render_after_failed_build_returns", render_after_failed_build_returns);
    run ("min_scene_renders_without_assets", min_scene_renders_without_assets);
    run ("host_pull_mixes_scene_sound_at_unity_gain", host_pull_mixes_scene_sound_at_unity_gain);
    run ("sdl_stays_default_without_host_output", sdl_stays_default_without_host_output);
    run ("pull_on_sdl_context_returns_zero", pull_on_sdl_context_returns_zero);
    printf ("host_api_test: %d passed, %d failed\n", g_passes, g_failures);
    return g_failures ? 1 : 0;
}
