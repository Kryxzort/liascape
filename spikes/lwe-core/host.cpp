// Spike (throwaway): host linux-wallpaperengine `next-v2` core in OUR surfaceless EGL desktop-GL context,
// driven by OUR loop and clock, rendering into an FBO WE own. See spikes/lwe-core/README.md.
//
//   lwe-core-host <scene-folder> [options]
//     --out DIR             PNG output dir (default ./out)
//     --frames N            frames to render after the load frame (default 300)
//     --save LIST           1-based frames to write as PNG (default 1,150,300)
//     --hint WxH            wp_project_hint_size + presented output size (default 1920x1080)
//     --assets DIR          WE assets dir (default: core's Steam auto-detection)
//     --clock real|fake     real = CLOCK_MONOTONIC since start; fake = frame * --dt (default real)
//     --dt S                fake-clock step (default 1/60)
//     --pause F:N           fake clock: time frozen for frames F..F+N-1; prints frame-to-frame diffs
//     --fps N               pace the loop to N fps (default 0 = uncapped)
//     --finish              glFinish after every frame (GPU time included in frame time)
//     --no-audio            wp_config_enable_audio(false)
//     --volume V            wp_config_set_audio_volume (0..128)
//     --volume-at F:V       change volume live at frame F (repeatable)
//     --mute-at F           mute-check callback starts returning true at frame F
//     --unmute-at F         ... and false again at frame F
//     --audio-input noise   feed a synthetic 1024-sample u8 audio frame each frame (visualisers)
//     --second DIR          load a second project, render both each frame
//     --second-context      ... in a separate wp_context (default: same context)
//     --gl-debug            debug context + count GL debug messages
//     --native              also save the native-size scene FBO
//     --prop K=V            wp_config_set_property before load (repeatable)
//     --live-prop F:K=V     wp_project_property_set_value_by_name at frame F (repeatable)
//     --keep-going          keep calling wp_render_frame after a failed first render (crash probe)
#include <glad/glad.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>

#include "linux-wallpaperengine/configuration.h"
#include "linux-wallpaperengine/context.h"
#include "linux-wallpaperengine/project.h"
#include "linux-wallpaperengine/render.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

#include <sys/resource.h>
#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <map>
#include <set>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------------------------------------
// options
static std::string g_scene, g_out = "out", g_assets, g_clock = "real", g_second, g_audioInput;
static int g_frames = 300, g_hintW = 1920, g_hintH = 1080, g_volume = -1, g_muteAt = -1, g_unmuteAt = -1;
static int g_pauseFrom = -1, g_pauseLen = 0;
static double g_dt = 1.0 / 60.0, g_fps = 0;
static bool g_keepGoing = false;
static bool g_finish = false, g_noAudio = false, g_secondCtx = false, g_glDebug = false, g_native = false;
static std::set<int> g_save = { 1, 150, 300 };
static std::map<int, int> g_volumeAt;
static std::vector<std::pair<std::string, std::string>> g_props;
static std::multimap<int, std::pair<std::string, std::string>> g_liveProps;
static std::pair<std::string, std::string> kv (const std::string& s) {
    const auto eq = s.find ('=');
    return { s.substr (0, eq), eq == std::string::npos ? "1" : s.substr (eq + 1) };
}

static double now_s () {
    timespec ts;
    clock_gettime (CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static long status_kb (const char* key) {
    FILE* f = fopen ("/proc/self/status", "r");
    char line[256];
    long v = -1;
    while (f && fgets (line, sizeof line, f))
        if (!strncmp (line, key, strlen (key)))
            v = atol (line + strlen (key) + 1);
    if (f)
        fclose (f);
    return v;
}

// our process' VRAM as nvidia-smi sees it (compute-apps query as the brief asks; -q PIDS as fallback,
// since a pure-GL process is listed as type "G" and may be absent from the compute-apps query)
static std::string vram_query () {
    std::string res;
    char cmd[256], buf[512];
    const int pid = getpid ();
    snprintf (cmd, sizeof cmd, "nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader 2>/dev/null");
    if (FILE* p = popen (cmd, "r")) {
        while (fgets (buf, sizeof buf, p))
            if (atoi (buf) == pid)
                res += std::string ("compute-apps: ") + buf;
        pclose (p);
    }
    snprintf (cmd, sizeof cmd, "nvidia-smi -q -d PIDS 2>/dev/null | grep -A4 -E 'Process ID +: %d$'", pid);
    if (FILE* p = popen (cmd, "r")) {
        while (fgets (buf, sizeof buf, p))
            if (strstr (buf, "Used GPU Memory") || strstr (buf, "Type"))
                res += std::string ("q-pids: ") + buf;
        pclose (p);
    }
    return res.empty () ? "nvidia-smi: pid not listed\n" : res;
}

static GLint nvx_avail_kb () {
    // GL_GPU_MEMORY_INFO_CURRENT_AVAILABLE_VIDMEM_NVX (device-wide, not per-process)
    GLint kb = -1;
    glGetIntegerv (0x9049, &kb);
    if (glGetError () != GL_NO_ERROR)
        kb = -1;
    return kb;
}

// ---------------------------------------------------------------------------------------------------------
// callbacks handed to the core
static void* cb_proc (void*, const char* name) { return reinterpret_cast<void*> (eglGetProcAddress (name)); }

struct Clock {
    double start = now_s ();
    double fakeT = 0;
    bool fake = false;
};
static Clock g_clk;
static float cb_time (void* u) {
    auto* c = static_cast<Clock*> (u);
    return static_cast<float> (c->fake ? c->fakeT : now_s () - c->start);
}

static bool g_muted = false;
static bool cb_is_muted (void*) { return g_muted; }

static unsigned char g_audioFrame[WP_AUDIO_INPUT_FRAME_SIZE];
static int g_frameIndex = 0;
static bool cb_frame_ready (void*) { return true; }
static unsigned char* cb_get_frame (void*) {
    // broadband noise with a pulsing envelope (a 6-tone input barely moved Bunk's bars in testing; noise lights
    // every band). The core reduces a 1024-pt real FFT to 16/32/64 bands from bins band*2.
    const double t = g_frameIndex / 60.0;
    const double env = 0.15 + 0.85 * (0.5 + 0.5 * sin (t * 2 * M_PI * 1.5));
    static uint32_t lcg = 12345;
    for (int n = 0; n < WP_AUDIO_INPUT_FRAME_SIZE; n++) {
        lcg = lcg * 1664525u + 1013904223u;
        const double noise = ((lcg >> 8) & 0xffff) / 32767.5 - 1.0;
        g_audioFrame[n] = static_cast<unsigned char> (std::clamp (128.0 + 100.0 * env * noise, 0.0, 255.0));
    }
    return g_audioFrame;
}

// ---------------------------------------------------------------------------------------------------------
// GL helpers
struct Target {
    GLuint fbo = 0, tex = 0;
    int w = 0, h = 0;
};
static Target make_target (int w, int h) {
    Target t { 0, 0, w, h };
    glGenTextures (1, &t.tex);
    glBindTexture (GL_TEXTURE_2D, t.tex);
    glTexImage2D (GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri (GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri (GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glGenFramebuffers (1, &t.fbo);
    glBindFramebuffer (GL_FRAMEBUFFER, t.fbo);
    glFramebufferTexture2D (GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t.tex, 0);
    const GLenum db[] = { GL_COLOR_ATTACHMENT0 };
    glDrawBuffers (1, db);
    if (glCheckFramebufferStatus (GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        fprintf (stderr, "FBO %dx%d incomplete\n", w, h);
        exit (3);
    }
    glClearColor (1, 0, 1, 1); // magenta: anything the core does not overwrite stays visible
    glClear (GL_COLOR_BUFFER_BIT);
    return t;
}

// cover-fit the scene FBO into the presented output (what a compositor would do). The core's output is
// y-down (row 0 = top of the picture, measured: an unflipped readback is upside down), so the blit also
// flips it into GL's bottom-up convention.
static void present (const Target& src, const Target& dst) {
    const double s = std::max (double (dst.w) / src.w, double (dst.h) / src.h);
    const int cw = int (dst.w / s), ch = int (dst.h / s);
    const int x0 = (src.w - cw) / 2, y0 = (src.h - ch) / 2;
    glBindFramebuffer (GL_READ_FRAMEBUFFER, src.fbo);
    glBindFramebuffer (GL_DRAW_FRAMEBUFFER, dst.fbo);
    glBlitFramebuffer (x0, y0, x0 + cw, y0 + ch, 0, dst.h, dst.w, 0, GL_COLOR_BUFFER_BIT, GL_LINEAR);
}

static std::vector<unsigned char> readback (const Target& t) {
    std::vector<unsigned char> px (size_t (t.w) * t.h * 4);
    glBindFramebuffer (GL_READ_FRAMEBUFFER, t.fbo);
    glPixelStorei (GL_PACK_ALIGNMENT, 1);
    glReadPixels (0, 0, t.w, t.h, GL_RGBA, GL_UNSIGNED_BYTE, px.data ());
    return px;
}

struct PixStats {
    double meanLuma, stdLuma;
    double magentaFrac;
    double opaqueFrac;
};
static PixStats pix_stats (const std::vector<unsigned char>& px) {
    double s = 0, s2 = 0;
    size_t mag = 0, opaque = 0;
    const size_t n = px.size () / 4;
    for (size_t i = 0; i < n; i++) {
        const unsigned char *p = &px[i * 4];
        const double y = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
        s += y;
        s2 += y * y;
        mag += (p[0] == 255 && p[1] == 0 && p[2] == 255);
        opaque += p[3] == 255;
    }
    const double m = s / n;
    return { m, sqrt (std::max (0.0, s2 / n - m * m)), double (mag) / n, double (opaque) / n };
}

static double mean_abs_diff (const std::vector<unsigned char>& a, const std::vector<unsigned char>& b) {
    double d = 0;
    for (size_t i = 0; i < a.size (); i++)
        if (i % 4 != 3)
            d += std::abs (int (a[i]) - int (b[i]));
    return d / (a.size () * 3 / 4);
}

// GL rows are bottom-up; PNG rows are top-down -> flip on write (flip=false for the raw y-down scene FBO).
// Alpha is forced opaque: the core leaves alpha at 0 (measured), which a PNG viewer shows as transparent.
static void write_png (const std::string& path, const Target& t, const std::vector<unsigned char>& px, bool flip = true) {
    std::vector<unsigned char> flipped (px.size ());
    const size_t row = size_t (t.w) * 4;
    for (int y = 0; y < t.h; y++)
        memcpy (&flipped[y * row], &px[(flip ? t.h - 1 - y : y) * row], row);
    for (size_t i = 3; i < flipped.size (); i += 4)
        flipped[i] = 255;
    stbi_write_png (path.c_str (), t.w, t.h, 4, flipped.data (), int (row));
}

static std::map<std::string, int> g_debugMsgs;
static int g_debugCount[4] = { 0, 0, 0, 0 };
static void GLAPIENTRY cb_debug (GLenum, GLenum type, GLuint, GLenum severity, GLsizei, const GLchar* msg, const void*) {
    const int sev = severity == GL_DEBUG_SEVERITY_HIGH ? 0 : severity == GL_DEBUG_SEVERITY_MEDIUM ? 1
                  : severity == GL_DEBUG_SEVERITY_LOW  ? 2 : 3;
    g_debugCount[sev]++;
    if (type == GL_DEBUG_TYPE_ERROR || sev <= 1)
        g_debugMsgs[std::string (msg).substr (0, 160)]++;
}

// ---------------------------------------------------------------------------------------------------------
// EGL: surfaceless desktop GL 3.3 core. EGL_MESA_platform_surfaceless first, else EGL_EXT_platform_device.
static EGLDisplay g_dpy;
static EGLContext g_ctx;
static std::string g_eglPath;

static bool has_ext (const char* list, const char* ext) {
    if (!list)
        return false;
    const size_t n = strlen (ext);
    for (const char* p = list; (p = strstr (p, ext)); p += n)
        if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == 0))
            return true;
    return false;
}

static void egl_init () {
    const char* client = eglQueryString (EGL_NO_DISPLAY, EGL_EXTENSIONS);
    auto getPlatformDisplay = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC> (
        eglGetProcAddress ("eglGetPlatformDisplayEXT"));
    printf ("[egl] client extensions: %s\n", client ? client : "(none)");

    g_dpy = EGL_NO_DISPLAY;
    if (has_ext (client, "EGL_MESA_platform_surfaceless") && getPlatformDisplay) {
        g_dpy = getPlatformDisplay (EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr);
        EGLint maj, min;
        if (g_dpy != EGL_NO_DISPLAY && eglInitialize (g_dpy, &maj, &min)) {
            g_eglPath = "EGL_PLATFORM_SURFACELESS_MESA";
        } else {
            printf ("[egl] surfaceless platform present but eglInitialize failed (0x%x)\n", eglGetError ());
            g_dpy = EGL_NO_DISPLAY;
        }
    }
    if (g_dpy == EGL_NO_DISPLAY && has_ext (client, "EGL_EXT_platform_device") && getPlatformDisplay) {
        auto queryDevices = reinterpret_cast<PFNEGLQUERYDEVICESEXTPROC> (eglGetProcAddress ("eglQueryDevicesEXT"));
        auto queryDeviceString
            = reinterpret_cast<PFNEGLQUERYDEVICESTRINGEXTPROC> (eglGetProcAddress ("eglQueryDeviceStringEXT"));
        EGLDeviceEXT devs[16];
        EGLint n = 0;
        queryDevices (16, devs, &n);
        for (int i = 0; i < n && g_dpy == EGL_NO_DISPLAY; i++) {
            const char* dext = queryDeviceString (devs[i], EGL_EXTENSIONS);
            printf ("[egl] device %d extensions: %s\n", i, dext ? dext : "(none)");
            // skip Mesa's software device when a hardware one exists
            if (has_ext (dext, "EGL_MESA_device_software") && i + 1 < n)
                continue;
            EGLDisplay d = getPlatformDisplay (EGL_PLATFORM_DEVICE_EXT, devs[i], nullptr);
            EGLint maj, min;
            if (d != EGL_NO_DISPLAY && eglInitialize (d, &maj, &min)) {
                g_dpy = d;
                g_eglPath = "EGL_PLATFORM_DEVICE_EXT (device " + std::to_string (i) + ")";
            }
        }
    }
    if (g_dpy == EGL_NO_DISPLAY) {
        fprintf (stderr, "[egl] no surfaceless display available\n");
        exit (2);
    }
    printf ("[egl] path: %s, vendor: %s, version: %s\n", g_eglPath.c_str (), eglQueryString (g_dpy, EGL_VENDOR),
            eglQueryString (g_dpy, EGL_VERSION));
    if (!has_ext (eglQueryString (g_dpy, EGL_EXTENSIONS), "EGL_KHR_surfaceless_context"))
        printf ("[egl] WARNING: EGL_KHR_surfaceless_context missing\n");

    eglBindAPI (EGL_OPENGL_API);
    const EGLint cfgAttr[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
                               EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE };
    EGLConfig cfg;
    EGLint ncfg = 0;
    if (!eglChooseConfig (g_dpy, cfgAttr, &cfg, 1, &ncfg) || ncfg == 0) {
        fprintf (stderr, "[egl] no config\n");
        exit (2);
    }
    const EGLint ctxAttr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
                               EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
                               EGL_CONTEXT_OPENGL_DEBUG, g_glDebug ? EGL_TRUE : EGL_FALSE, EGL_NONE };
    g_ctx = eglCreateContext (g_dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
    if (g_ctx == EGL_NO_CONTEXT || !eglMakeCurrent (g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, g_ctx)) {
        fprintf (stderr, "[egl] context/makecurrent failed 0x%x\n", eglGetError ());
        exit (2);
    }
    if (!gladLoadGLLoader (reinterpret_cast<GLADloadproc> (eglGetProcAddress))) {
        fprintf (stderr, "[gl] glad load failed\n");
        exit (2);
    }
    GLint prof = 0;
    glGetIntegerv (GL_CONTEXT_PROFILE_MASK, &prof);
    printf ("[gl] %s | %s | %s | profile=%s\n", glGetString (GL_VENDOR), glGetString (GL_RENDERER),
            glGetString (GL_VERSION), prof & GL_CONTEXT_CORE_PROFILE_BIT ? "core" : "compat");
    if (g_glDebug) {
        // a 3.3 context has no core glDebugMessageCallback (4.3); glad only loads it for >=4.3, so fetch the
        // KHR_debug entry point directly
        auto debugCb = reinterpret_cast<PFNGLDEBUGMESSAGECALLBACKPROC> (eglGetProcAddress ("glDebugMessageCallback"));
        GLint next = 0;
        bool khrDebug = false;
        glGetIntegerv (GL_NUM_EXTENSIONS, &next);
        for (GLint i = 0; i < next; i++)
            khrDebug |= !strcmp (reinterpret_cast<const char*> (glGetStringi (GL_EXTENSIONS, i)), "GL_KHR_debug");
        printf ("[gl] GL_KHR_debug=%d glDebugMessageCallback=%p\n", khrDebug, reinterpret_cast<void*> (debugCb));
        if (khrDebug && debugCb) {
            glEnable (GL_DEBUG_OUTPUT);
            glEnable (GL_DEBUG_OUTPUT_SYNCHRONOUS);
            debugCb (cb_debug, nullptr);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
static void parse (int argc, char** argv) {
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&] () -> std::string {
            if (i + 1 >= argc) {
                fprintf (stderr, "missing value for %s\n", a.c_str ());
                exit (1);
            }
            return argv[++i];
        };
        if (a == "--out") g_out = next ();
        else if (a == "--frames") g_frames = atoi (next ().c_str ());
        else if (a == "--save") {
            g_save.clear ();
            std::string v = next ();
            for (char* t = strtok (v.data (), ","); t; t = strtok (nullptr, ",")) g_save.insert (atoi (t));
        } else if (a == "--hint") sscanf (next ().c_str (), "%dx%d", &g_hintW, &g_hintH);
        else if (a == "--assets") g_assets = next ();
        else if (a == "--clock") g_clock = next ();
        else if (a == "--dt") g_dt = atof (next ().c_str ());
        else if (a == "--pause") sscanf (next ().c_str (), "%d:%d", &g_pauseFrom, &g_pauseLen);
        else if (a == "--fps") g_fps = atof (next ().c_str ());
        else if (a == "--finish") g_finish = true;
        else if (a == "--no-audio") g_noAudio = true;
        else if (a == "--volume") g_volume = atoi (next ().c_str ());
        else if (a == "--volume-at") {
            int f, v;
            sscanf (next ().c_str (), "%d:%d", &f, &v);
            g_volumeAt[f] = v;
        } else if (a == "--mute-at") g_muteAt = atoi (next ().c_str ());
        else if (a == "--unmute-at") g_unmuteAt = atoi (next ().c_str ());
        else if (a == "--audio-input") g_audioInput = next ();
        else if (a == "--second") g_second = next ();
        else if (a == "--second-context") g_secondCtx = true;
        else if (a == "--gl-debug") g_glDebug = true;
        else if (a == "--native") g_native = true;
        else if (a == "--keep-going") g_keepGoing = true;
        else if (a == "--prop") g_props.push_back (kv (next ()));
        else if (a == "--live-prop") {
            const std::string v = next ();
            const auto colon = v.find (':');
            g_liveProps.insert ({ atoi (v.substr (0, colon).c_str ()), kv (v.substr (colon + 1)) });
        }
        else if (a[0] != '-' && g_scene.empty ()) g_scene = a;
        else {
            fprintf (stderr, "unknown arg %s\n", a.c_str ());
            exit (1);
        }
    }
    if (g_scene.empty ()) {
        fprintf (stderr, "usage: lwe-core-host <scene-folder> [options] (see host.cpp header)\n");
        exit (1);
    }
}

struct Slot {
    std::string name, path;
    wp_context* ctx;
    wp_project* project = nullptr;
    Target scene, out;
    std::vector<unsigned char> prev;
};

int main (int argc, char** argv) {
    parse (argc, argv);
    std::filesystem::create_directories (g_out);
    g_clk.fake = g_clock == "fake";
    setvbuf (stdout, nullptr, _IOLBF, 0);

    egl_init ();
    const GLint vramBefore = nvx_avail_kb ();
    printf ("[mem] before load: VmRSS=%ld kB, NVX avail=%d kB\n", status_kb ("VmRSS:"), vramBefore);

    // ---- configuration + context(s) ----
    wp_configuration* config = wp_config_create ();
    if (!g_assets.empty () && !wp_config_set_assets_dir (config, g_assets.c_str ())) {
        fprintf (stderr, "bad assets dir %s\n", g_assets.c_str ());
        return 1;
    }
    wp_config_enable_audio (config, !g_noAudio);
    for (auto& [k, v] : g_props)
        wp_config_set_property (config, k.c_str (), v.c_str ());
    if (g_volume >= 0)
        wp_config_set_audio_volume (config, g_volume);
    wp_mute_check mute = { .user_parameter = nullptr, .is_muted = cb_is_muted };
    wp_config_set_mute_check (config, &mute);

    wp_gl_proc_address proc = { .user_parameter = nullptr, .get_proc_address = cb_proc };
    wp_time_counter clock = { .user_parameter = &g_clk, .get_time = cb_time };
    wp_audio_input_mix mix = { .user_parameter = nullptr, .is_frame_ready = cb_frame_ready, .get_frame = cb_get_frame };

    auto make_ctx = [&] () {
        wp_context* c = wp_context_create (config);
        if (!c) {
            fprintf (stderr, "wp_context_create failed\n");
            exit (4);
        }
        wp_context_set_gl_proc_address (c, &proc);
        wp_context_set_time_counter (c, &clock);
        if (g_audioInput == "noise")
            wp_context_set_audio_input_mix (c, &mix);
        return c;
    };

    std::vector<Slot> slots;
    wp_context* ctx0 = make_ctx ();
    slots.push_back ({ "a", g_scene, ctx0 });
    if (!g_second.empty ())
        slots.push_back ({ "b", g_second, g_secondCtx ? make_ctx () : ctx0 });

    // ---- load (no GL work happens here: parsing + VFS mount only) ----
    for (auto& s : slots) {
        const double t0 = now_s ();
        s.project = wp_project_load_folder (s.ctx, nullptr, s.path.c_str ());
        printf ("[load] %s: wp_project_load_folder(%s) -> %p in %.1f ms\n", s.name.c_str (), s.path.c_str (),
                s.project, (now_s () - t0) * 1e3);
        if (!s.project) {
            fprintf (stderr, "RESULT load-failed %s\n", s.path.c_str ());
            return 5;
        }
        wp_project_hint_size (s.project, g_hintW, g_hintH);
        printf ("[load] %s: size before first render = %dx%d\n", s.name.c_str (), wp_project_get_width (s.project),
                wp_project_get_height (s.project));
    }

    // property listing (first few) — proves the live-property API is reachable
    {
        int n = 0;
        wp_project_property_list_reset (slots[0].project);
        while (wp_project_property* p = wp_project_property_list_next (slots[0].project)) {
            if (n++ < 8)
                printf ("[prop] type=%d name=%s\n", p->type, p->name ? p->name : "?");
        }
        printf ("[prop] %d properties\n", n);
    }

    // ---- frame 0: the core builds its renderer lazily on the first wp_render_frame. Render it into a 1x1
    //      scratch FBO, then size our FBO to the scene (the core blits with glViewport(0,0,sceneW,sceneH)). ----
    Target scratch = make_target (1, 1);
    for (auto& s : slots) {
        const double t0 = now_s ();
        wp_project_set_output_framebuffer (s.project, scratch.fbo);
        wp_render_update_time (s.ctx);
        wp_render_frame (s.project);
        glFinish ();
        const int w = wp_project_get_width (s.project), h = wp_project_get_height (s.project);
        printf ("[load] %s: first render (renderer build) %.1f ms, scene size %dx%d, GL error 0x%x\n", s.name.c_str (),
                (now_s () - t0) * 1e3, w, h, glGetError ());
        if (w <= 1 || h <= 1) {
            fprintf (stderr, "RESULT no-renderer %s\n", s.path.c_str ());
            if (!g_keepGoing)
                return 6;
            for (int i = 1; i <= 3; i++) {
                printf ("[keep-going] wp_render_frame call %d after failed first render...\n", i);
                wp_render_update_time (s.ctx);
                wp_render_frame (s.project);
                printf ("[keep-going] call %d returned\n", i);
            }
            return 6;
        }
        s.scene = make_target (w, h);
        s.out = make_target (g_hintW, g_hintH);
        wp_project_set_output_framebuffer (s.project, s.scene.fbo);
    }
    printf ("[mem] after load: VmRSS=%ld kB, NVX avail=%d kB (delta %d kB)\n", status_kb ("VmRSS:"), nvx_avail_kb (),
            vramBefore - nvx_avail_kb ());

    // ---- render loop: OUR loop, OUR clock ----
    std::vector<double> frameMs;
    const double loopStart = now_s ();
    double ioTime = 0; // readback + PNG + nvidia-smi time, excluded from fps
    int glErrors = 0;
    for (int f = 1; f <= g_frames; f++) {
        g_frameIndex = f;
        const double t0 = now_s ();
        if (g_clk.fake) {
            const bool paused = g_pauseFrom > 0 && f >= g_pauseFrom && f < g_pauseFrom + g_pauseLen;
            if (!paused)
                g_clk.fakeT += g_dt;
        }
        if (g_volumeAt.count (f)) {
            wp_config_set_audio_volume (config, g_volumeAt[f]);
            printf ("[audio] frame %d: volume -> %d (t=%.2fs)\n", f, g_volumeAt[f], now_s () - g_clk.start);
        }
        if (f == g_muteAt) {
            g_muted = true;
            printf ("[audio] frame %d: mute-check -> true (t=%.2fs)\n", f, now_s () - g_clk.start);
        }
        if (f == g_unmuteAt) {
            g_muted = false;
            printf ("[audio] frame %d: mute-check -> false (t=%.2fs)\n", f, now_s () - g_clk.start);
        }

        for (auto [it, end] = g_liveProps.equal_range (f); it != end; ++it) {
            const bool ok = wp_project_property_set_value_by_name (slots[0].project, it->second.first.c_str (),
                                                                   it->second.second.c_str ());
            printf ("[prop] frame %d: live set %s=%s -> %d\n", f, it->second.first.c_str (), it->second.second.c_str (), ok);
        }
        std::set<wp_context*> updated;
        for (auto& s : slots) {
            if (updated.insert (s.ctx).second)
                wp_render_update_time (s.ctx); // once per context per frame
            wp_render_frame (s.project);
            present (s.scene, s.out);
        }
        while (glGetError () != GL_NO_ERROR)
            glErrors++;
        if (g_finish)
            glFinish ();
        frameMs.push_back ((now_s () - t0) * 1e3);

        const double io0 = now_s ();
        const bool pauseProbe = g_pauseFrom > 0 && f >= g_pauseFrom - 2 && f <= g_pauseFrom + g_pauseLen + 1;
        for (auto& s : slots) {
            if (!g_save.count (f) && !pauseProbe)
                continue;
            auto px = readback (s.out);
            if (pauseProbe && !s.prev.empty ())
                printf ("[pause] %s frame %d t=%.4f diff-vs-prev=%.4f\n", s.name.c_str (), f, cb_time (&g_clk),
                        mean_abs_diff (px, s.prev));
            if (pauseProbe)
                s.prev = px;
            if (g_save.count (f)) {
                const PixStats st = pix_stats (px);
                char path[512];
                snprintf (path, sizeof path, "%s/%s-frame-%04d.png", g_out.c_str (), s.name.c_str (), f);
                write_png (path, s.out, px);
                printf ("[png] %s mean-luma=%.1f std=%.1f magenta=%.4f opaque=%.4f\n", path, st.meanLuma, st.stdLuma,
                        st.magentaFrac, st.opaqueFrac);
                if (g_native) {
                    auto npx = readback (s.scene);
                    snprintf (path, sizeof path, "%s/%s-native-%04d.png", g_out.c_str (), s.name.c_str (), f);
                    write_png (path, s.scene, npx, false);
                }
            }
        }
        if (f == g_frames / 2)
            printf ("[mem] mid-run VRAM: %s", vram_query ().c_str ());
        ioTime += now_s () - io0;

        if (g_fps > 0) {
            const double left = 1.0 / g_fps - (now_s () - t0);
            if (left > 0)
                usleep (useconds_t (left * 1e6));
        }
    }
    glFinish ();
    const double total = now_s () - loopStart - ioTime;

    std::vector<double> sorted = frameMs;
    std::sort (sorted.begin (), sorted.end ());
    double sum = 0;
    for (double v : frameMs) sum += v;
    rusage ru;
    getrusage (RUSAGE_SELF, &ru);
    printf ("[stats] (wall excludes %.3fs of readback/PNG/nvidia-smi)\n", ioTime);
    printf ("[stats] frames=%d wall=%.3fs fps=%.1f frame-ms mean=%.2f p50=%.2f p95=%.2f max=%.2f (finish=%d paced=%.0f)\n",
            g_frames, total, g_frames / total, sum / frameMs.size (), sorted[sorted.size () / 2],
            sorted[size_t (sorted.size () * 0.95)], sorted.back (), g_finish, g_fps);
    printf ("[stats] peak RSS (VmHWM)=%ld kB, ru_maxrss=%ld kB, VmRSS now=%ld kB, GL errors in loop=%d\n",
            status_kb ("VmHWM:"), ru.ru_maxrss, status_kb ("VmRSS:"), glErrors);
    printf ("[stats] NVX avail now=%d kB (device-wide delta since start %d kB)\n", nvx_avail_kb (),
            vramBefore - nvx_avail_kb ());
    printf ("[stats] VRAM: %s", vram_query ().c_str ());
    if (g_glDebug) {
        printf ("[gl-debug] high=%d medium=%d low=%d notification=%d\n", g_debugCount[0], g_debugCount[1],
                g_debugCount[2], g_debugCount[3]);
        int k = 0;
        for (auto& [m, c] : g_debugMsgs)
            if (k++ < 12)
                printf ("[gl-debug] x%d %s\n", c, m.c_str ());
    }

    // ---- teardown ----
    const double td = now_s ();
    for (auto& s : slots)
        wp_project_destroy (s.project);
    std::set<wp_context*> ctxs;
    for (auto& s : slots) ctxs.insert (s.ctx);
    for (auto* c : ctxs)
        wp_context_destroy (c);
    wp_config_destroy (config);
    printf ("[teardown] %.1f ms\n", (now_s () - td) * 1e3);
    eglMakeCurrent (g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroyContext (g_dpy, g_ctx);
    eglTerminate (g_dpy);
    printf ("RESULT ok\n");
    return 0;
}
