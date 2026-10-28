// Spike (throwaway): the COMPOSITOR side of worker -> compositor GPU frame sharing.
// A wlr-layer-shell surface on one output (default DP-2, layer BOTTOM: above the live wallpaper, below windows),
// desktop-GL 3.3 core via EGL on the Wayland platform. Spawns ./producer over a SOCK_SEQPACKET socketpair (the way
// liascape-player will spawn a worker), imports each ring buffer ONCE (eglCreateImage(EGL_LINUX_DMA_BUF_EXT) +
// glEGLImageTargetTexture2DOES), then per frame: wait on the acquire fence (eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID)
// + eglWaitSync, GPU-side), draw the texture fullscreen, read the 64x64 corner (and a 16x16 gradient probe) back
// through a PBO, and check n against the message and for monotonicity. Present timing comes from wp_presentation.
//
//   consumer --mode fence|finish|shm|nosync [--seconds 60] [--warmup 3] [--fps 144] [--output DP-2]
//            [--redraw vblank|new] [--layer bottom|background] [--producer ./producer] [--out results.jsonl]
//            [--label text] [--latch gpu-wait|signaled] [--verify on|off] [--kill-at SECONDS]
//   --redraw vblank : redraw on EVERY frame callback (what liascape-player does: present at the output's refresh)
//   --redraw new    : draw only when a new worker frame arrived (throttled by frame callbacks)
//   --latch gpu-wait: latch the newest frame at once, GPU waits on its fence (the brief's step 2)
//   --latch signaled: latch only frames whose sync_file already polls signaled; else reuse the previous frame
//   --kill-at S     : crash test, SIGKILL the worker S seconds into the window the moment a frame is in hand
//   env LIASCAPE_SPIKE_WORK=N (read by the producer): synthetic per-pixel GPU load, N loop iterations
#include "common.h"

#include <fcntl.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/wait.h>

#include <wayland-client.h>
#include <wayland-egl.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#define GL_GLEXT_PROTOTYPES 1
#include <GL/gl.h>
#include <GL/glext.h>

#include "presentation-time-protocol.h"
#include "wlr-layer-shell-unstable-v1-protocol.h"

#define LOG(...) fprintf(stderr, "[consumer] " __VA_ARGS__)
#define MAXN (1u << 16)

// ---- options ---------------------------------------------------------------------------------------------------
static int o_mode = MODE_FENCE;
static double o_seconds = 60, o_warmup = 3, o_fps = 144;
static const char *o_output = "DP-2";
static bool o_redrawVblank = true;
static uint32_t o_layer = ZWLR_LAYER_SHELL_V1_LAYER_BOTTOM;
static const char *o_producer = "./producer";
static const char *o_out = NULL;
static const char *o_label = "";
static bool o_verify = true;
static double o_killAt = 0; // crash test: SIGKILL the worker this many seconds into the window
static bool g_killed;
static int64_t g_killT;
static uint64_t c_heldChecks, c_heldBad, c_presentedAfterKill, c_latchedAfterKill;

// ---- wayland ---------------------------------------------------------------------------------------------------
static struct wl_display *g_wl;
static struct wl_compositor *g_comp;
static struct zwlr_layer_shell_v1 *g_layerShell;
static struct wp_presentation *g_pres;
static uint32_t g_presClock = UINT32_MAX;
struct out_info {
    struct wl_output *o;
    char name[64];
    int w, h, mhz;
};
static struct out_info g_outs[8];
static int g_nouts;
static struct wl_surface *g_surf;
static struct zwlr_layer_surface_v1 *g_ls;
static struct wl_egl_window *g_eglWin;
static int g_w, g_h;
static bool g_configured, g_closed, g_stopping;
static int g_outMhz;

// ---- egl / gl --------------------------------------------------------------------------------------------------
static EGLDisplay g_dpy;
static EGLContext g_ctx;
static EGLSurface g_eglSurf;
static PFNGLEGLIMAGETARGETTEXTURE2DOESPROC p_imageTargetTex;
static PFNEGLDUPNATIVEFENCEFDANDROIDPROC p_dupFence;
static PFNEGLQUERYDMABUFMODIFIERSEXTPROC p_queryMods;
static GLuint g_prog, g_vao;

// ---- transport -------------------------------------------------------------------------------------------------
static int g_sock = -1;
static pid_t g_child = -1;
static GLuint g_tex[RING];
static EGLImage g_img[RING];
static uint8_t *g_shm;
static size_t g_shmSize;
static GLsync g_relSync[RING]; // finish/nosync: release slot once the GPU stopped sampling it
struct frame {
    bool valid;
    uint32_t slot;
    uint64_t n;
    int fenceFd;
};
static struct frame g_current;
static struct frame g_q[RING]; // received but not yet latched, oldest first
static int g_nq;
// gpu-wait : latch the newest frame at the next vblank and make the GPU wait on its fence (eglWaitSync)
// signaled : latch only the newest frame whose sync_file is already signaled (poll); otherwise keep the previous
//            frame -- the compositor's GPU timeline never waits on a worker
enum { LATCH_GPU_WAIT, LATCH_SIGNALED };
static int o_latch = LATCH_GPU_WAIT;
static uint64_t c_notReady; // vblanks with frames queued but none signaled yet (previous frame reused)
static bool g_cbPending, g_gotStats;
static struct prod_stats g_ps;
static int64_t g_winBegin, g_winEnd;

// per-n record, indexed by n (n < MAXN for any run we do)
enum { F_RECV = 1, F_SUPERSEDED = 2, F_LATCHED = 4, F_PRESENTED = 8, F_DISCARDED = 16 };
struct frec {
    int64_t tProd, tSend, tRecv, tSwap, tPres;
    uint8_t flags;
};
static struct frec *g_f;

// counters (window-filtered where noted)
static uint64_t c_fenceImportFail, c_fenceAlreadySignaled, c_fenceWaited, c_readbacks, c_readbackSkipped,
    c_cornerBad, c_cornerNonUniform, c_gradBad, c_pixelOutOfOrder, c_metaOutOfOrder, c_gaps, c_gapFrames,
    c_commits, c_commitsPresented, c_commitsDiscarded;
static uint32_t g_lastPixelN = UINT32_MAX;
static uint64_t g_lastLatchedN;
static struct samples s_cbInterval;
static int64_t g_lastCb;
static int64_t g_cpu0, g_wall0, g_cpuNs, g_wallNs;
static int g_winState; // 0 before, 1 inside, 2 after

static bool in_win(uint64_t n) {
    return n && n < MAXN && g_f[n].tProd >= g_winBegin && g_f[n].tProd < g_winEnd;
}

static void die(const char *what) {
    LOG("FATAL: %s (egl 0x%x)\n", what, eglGetError());
    if (g_child > 0)
        kill(g_child, SIGTERM);
    exit(2);
}

// ---- wayland listeners -----------------------------------------------------------------------------------------
static void out_geometry(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t sp,
                         const char *m, const char *md, int32_t tr) {
    (void)d, (void)o, (void)x, (void)y, (void)pw, (void)ph, (void)sp, (void)m, (void)md, (void)tr;
}
static void out_mode(void *d, struct wl_output *o, uint32_t f, int32_t w, int32_t h, int32_t r) {
    (void)o;
    struct out_info *oi = d;
    if (f & WL_OUTPUT_MODE_CURRENT)
        oi->w = w, oi->h = h, oi->mhz = r;
}
static void out_done(void *d, struct wl_output *o) { (void)d, (void)o; }
static void out_scale(void *d, struct wl_output *o, int32_t s) { (void)d, (void)o, (void)s; }
static void out_name(void *d, struct wl_output *o, const char *name) {
    (void)o;
    snprintf(((struct out_info *)d)->name, 64, "%s", name);
}
static void out_desc(void *d, struct wl_output *o, const char *s) { (void)d, (void)o, (void)s; }
static const struct wl_output_listener out_listener = { out_geometry, out_mode, out_done, out_scale, out_name, out_desc };

static void pres_clock(void *d, struct wp_presentation *p, uint32_t clk) {
    (void)d, (void)p;
    g_presClock = clk;
}
static const struct wp_presentation_listener pres_listener = { pres_clock };

static void reg_global(void *d, struct wl_registry *r, uint32_t id, const char *iface, uint32_t ver) {
    (void)d;
    if (!strcmp(iface, wl_compositor_interface.name))
        g_comp = wl_registry_bind(r, id, &wl_compositor_interface, 4);
    else if (!strcmp(iface, zwlr_layer_shell_v1_interface.name))
        g_layerShell = wl_registry_bind(r, id, &zwlr_layer_shell_v1_interface, 1);
    else if (!strcmp(iface, wp_presentation_interface.name)) {
        g_pres = wl_registry_bind(r, id, &wp_presentation_interface, 1);
        wp_presentation_add_listener(g_pres, &pres_listener, NULL);
    } else if (!strcmp(iface, wl_output_interface.name) && g_nouts < 8) {
        struct out_info *oi = &g_outs[g_nouts++];
        oi->o = wl_registry_bind(r, id, &wl_output_interface, ver < 4 ? ver : 4);
        wl_output_add_listener(oi->o, &out_listener, oi);
    }
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t id) { (void)d, (void)r, (void)id; }
static const struct wl_registry_listener reg_listener = { reg_global, reg_remove };

static void ls_configure(void *d, struct zwlr_layer_surface_v1 *ls, uint32_t serial, uint32_t w, uint32_t h) {
    (void)d;
    zwlr_layer_surface_v1_ack_configure(ls, serial);
    g_w = (int)w, g_h = (int)h;
    g_configured = true;
}
static void ls_closed(void *d, struct zwlr_layer_surface_v1 *ls) {
    (void)d, (void)ls;
    g_closed = true;
}
static const struct zwlr_layer_surface_v1_listener ls_listener = { ls_configure, ls_closed };

// presentation feedback: one per commit
struct fb_rec {
    uint64_t n;  // frame shown by this commit (0 = none yet)
    bool newly;  // this commit is the one that latched n
};
static void fb_sync_output(void *d, struct wp_presentation_feedback *f, struct wl_output *o) { (void)d, (void)f, (void)o; }
static void fb_presented(void *d, struct wp_presentation_feedback *f, uint32_t sh, uint32_t sl, uint32_t ns,
                         uint32_t refresh, uint32_t qh, uint32_t ql, uint32_t flags) {
    (void)refresh, (void)qh, (void)ql, (void)flags;
    struct fb_rec *r = d;
    int64_t t = (int64_t)(((uint64_t)sh << 32) | sl) * 1000000000LL + ns;
    c_commitsPresented++;
    // the first presented commit showing n counts (covers a discarded latch commit shown by a later repeat)
    if (r->n && r->n < MAXN && !(g_f[r->n].flags & F_PRESENTED)) {
        g_f[r->n].tPres = t;
        g_f[r->n].flags |= F_PRESENTED;
    }
    wp_presentation_feedback_destroy(f);
    free(r);
}
static void fb_discarded(void *d, struct wp_presentation_feedback *f) {
    struct fb_rec *r = d;
    c_commitsDiscarded++;
    if (r->newly && r->n < MAXN)
        g_f[r->n].flags |= F_DISCARDED;
    wp_presentation_feedback_destroy(f);
    free(r);
}
static const struct wp_presentation_feedback_listener fb_listener = { fb_sync_output, fb_presented, fb_discarded };

// ---- EGL / GL setup --------------------------------------------------------------------------------------------
static void egl_init(void) {
    const char *client = eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);
    LOG("EGL client extensions: %s\n", client ? client : "(none)");
    g_dpy = eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR, g_wl, NULL);
    if (g_dpy == EGL_NO_DISPLAY || !eglInitialize(g_dpy, NULL, NULL))
        die("EGL wayland display");
    const char *dext = eglQueryString(g_dpy, EGL_EXTENSIONS);
    LOG("EGL display (wayland platform) vendor %s version %s\n", eglQueryString(g_dpy, EGL_VENDOR),
        eglQueryString(g_dpy, EGL_VERSION));
    LOG("EGL display extensions: %s\n", dext ? dext : "(none)");
    const char *need[] = { "EGL_EXT_image_dma_buf_import", "EGL_EXT_image_dma_buf_import_modifiers",
                           "EGL_ANDROID_native_fence_sync", "EGL_KHR_wait_sync" };
    for (size_t i = 0; i < sizeof need / sizeof *need; i++)
        LOG("  %-40s %s\n", need[i], has_ext(dext, need[i]) ? "yes" : "MISSING");

    if (!eglBindAPI(EGL_OPENGL_API))
        die("eglBindAPI");
    const EGLint cfgAttr[] = { EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_RED_SIZE, 8,
                               EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 0, EGL_NONE };
    EGLConfig cfg;
    EGLint ncfg = 0;
    if (!eglChooseConfig(g_dpy, cfgAttr, &cfg, 1, &ncfg) || !ncfg)
        die("eglChooseConfig");
    const int prio = env_prio("LIASCAPE_SPIKE_CONSUMER_PRIO"); // EGL_IMG_context_priority experiment
    EGLint ctxAttr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
                         EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE, 0, EGL_NONE };
    if (prio)
        ctxAttr[6] = 0x3100 /* EGL_CONTEXT_PRIORITY_LEVEL_IMG */, ctxAttr[7] = prio;
    g_ctx = eglCreateContext(g_dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
    if (g_ctx == EGL_NO_CONTEXT)
        die("eglCreateContext");
    if (prio) {
        EGLint got = 0;
        eglQueryContext(g_dpy, g_ctx, 0x3100, &got);
        LOG("context priority requested %s, granted %s\n", prio_name(prio), prio_name(got));
    }
    g_eglWin = wl_egl_window_create(g_surf, g_w, g_h);
    g_eglSurf = eglCreatePlatformWindowSurface(g_dpy, cfg, g_eglWin, NULL);
    if (g_eglSurf == EGL_NO_SURFACE || !eglMakeCurrent(g_dpy, g_eglSurf, g_eglSurf, g_ctx))
        die("window surface");
    eglSwapInterval(g_dpy, 0); // pacing comes from frame callbacks, never from a blocking swap
    GLint prof = 0;
    glGetIntegerv(GL_CONTEXT_PROFILE_MASK, &prof);
    LOG("GL %s | %s | %s | %s\n", glGetString(GL_VENDOR), glGetString(GL_RENDERER), glGetString(GL_VERSION),
        prof & GL_CONTEXT_CORE_PROFILE_BIT ? "core" : "compat");
    GLint next = 0;
    glGetIntegerv(GL_NUM_EXTENSIONS, &next);
    const char *glNeed[] = { "GL_OES_EGL_image", "GL_OES_EGL_image_external", "GL_EXT_EGL_image_storage",
                             "GL_EXT_memory_object_fd", "GL_EXT_semaphore_fd" };
    for (size_t k = 0; k < sizeof glNeed / sizeof *glNeed; k++) {
        bool ok = false;
        for (GLint i = 0; i < next; i++)
            ok |= !strcmp((const char *)glGetStringi(GL_EXTENSIONS, i), glNeed[k]);
        LOG("  %-40s %s\n", glNeed[k], ok ? "yes" : "no");
    }
    p_imageTargetTex = (void *)eglGetProcAddress("glEGLImageTargetTexture2DOES");
    p_dupFence = (void *)eglGetProcAddress("eglDupNativeFenceFDANDROID");
    p_queryMods = (void *)eglGetProcAddress("eglQueryDmaBufModifiersEXT");
    if (!p_imageTargetTex || !p_dupFence)
        die("glEGLImageTargetTexture2DOES / eglDupNativeFenceFDANDROID missing");
}

static GLuint compile(GLenum type, const char *src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[2048];
        glGetShaderInfoLog(s, sizeof log, NULL, log);
        LOG("shader: %s\n", log);
        die("compile");
    }
    return s;
}

static void gl_init(void) {
    static const char *VS = "#version 330 core\n"
                            "void main() {\n"
                            "  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);\n"
                            "  gl_Position = vec4(p, 0.0, 1.0);\n"
                            "}\n";
    static const char *FS = "#version 330 core\n"
                            "uniform sampler2D u_tex;\n"
                            "out vec4 o;\n"
                            "void main() { o = texelFetch(u_tex, ivec2(gl_FragCoord.xy), 0); }\n";
    g_prog = glCreateProgram();
    glAttachShader(g_prog, compile(GL_VERTEX_SHADER, VS));
    glAttachShader(g_prog, compile(GL_FRAGMENT_SHADER, FS));
    glLinkProgram(g_prog);
    GLint ok = 0;
    glGetProgramiv(g_prog, GL_LINK_STATUS, &ok);
    if (!ok)
        die("link");
    glUseProgram(g_prog);
    glUniform1i(glGetUniformLocation(g_prog, "u_tex"), 0);
    glGenVertexArrays(1, &g_vao);
}

// ---- import ----------------------------------------------------------------------------------------------------
static void dump_modifiers(uint32_t fourcc) {
    if (!p_queryMods)
        return;
    EGLuint64KHR mods[64];
    EGLBoolean ext[64];
    EGLint n = 0;
    if (!p_queryMods(g_dpy, (EGLint)fourcc, 64, mods, ext, &n))
        return;
    LOG("importable modifiers for %.4s on this display: %d\n", (char *)&fourcc, n);
    for (int i = 0; i < n; i++)
        LOG("    0x%016llx%s\n", (unsigned long long)mods[i], ext[i] ? " (external_only)" : "");
}

static void import_buffer(const struct msg *m, const int *fds, int nfds) {
    static bool dumped;
    if (m->slot >= RING || nfds < (int)m->nplanes || m->nplanes < 1)
        die("bad MSG_BUFFER");
    if (!dumped) {
        dump_modifiers(m->fourcc);
        dumped = true;
    }
    EGLAttrib a[64];
    int k = 0;
    a[k++] = EGL_WIDTH, a[k++] = m->width, a[k++] = EGL_HEIGHT, a[k++] = m->height;
    a[k++] = EGL_LINUX_DRM_FOURCC_EXT, a[k++] = m->fourcc;
    static const EGLAttrib planeAttr[4][5] = {
        { EGL_DMA_BUF_PLANE0_FD_EXT, EGL_DMA_BUF_PLANE0_OFFSET_EXT, EGL_DMA_BUF_PLANE0_PITCH_EXT,
          EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT },
        { EGL_DMA_BUF_PLANE1_FD_EXT, EGL_DMA_BUF_PLANE1_OFFSET_EXT, EGL_DMA_BUF_PLANE1_PITCH_EXT,
          EGL_DMA_BUF_PLANE1_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE1_MODIFIER_HI_EXT },
        { EGL_DMA_BUF_PLANE2_FD_EXT, EGL_DMA_BUF_PLANE2_OFFSET_EXT, EGL_DMA_BUF_PLANE2_PITCH_EXT,
          EGL_DMA_BUF_PLANE2_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE2_MODIFIER_HI_EXT },
        { EGL_DMA_BUF_PLANE3_FD_EXT, EGL_DMA_BUF_PLANE3_OFFSET_EXT, EGL_DMA_BUF_PLANE3_PITCH_EXT,
          EGL_DMA_BUF_PLANE3_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE3_MODIFIER_HI_EXT },
    };
    for (uint32_t p = 0; p < m->nplanes; p++) {
        a[k++] = planeAttr[p][0], a[k++] = fds[p];
        a[k++] = planeAttr[p][1], a[k++] = m->offset[p];
        a[k++] = planeAttr[p][2], a[k++] = m->stride[p];
        a[k++] = planeAttr[p][3], a[k++] = (EGLAttrib)(m->modifier & 0xffffffffu);
        a[k++] = planeAttr[p][4], a[k++] = (EGLAttrib)(m->modifier >> 32);
    }
    a[k++] = EGL_NONE;
    EGLImage img = eglCreateImage(g_dpy, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, (EGLClientBuffer)NULL, a);
    for (int i = 0; i < nfds; i++)
        close(fds[i]); // the image holds its own reference
    if (img == EGL_NO_IMAGE)
        die("eglCreateImage(EGL_LINUX_DMA_BUF_EXT)");
    glGenTextures(1, &g_tex[m->slot]);
    glBindTexture(GL_TEXTURE_2D, g_tex[m->slot]);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    p_imageTargetTex(GL_TEXTURE_2D, img);
    GLenum err = glGetError();
    if (err)
        LOG("glEGLImageTargetTexture2DOES -> GL error 0x%x\n", err), die("texture from dmabuf");
    g_img[m->slot] = img;
    LOG("imported slot %u: %ux%u %.4s modifier 0x%016llx stride %u -> tex %u\n", m->slot, m->width, m->height,
        (char *)&m->fourcc, (unsigned long long)m->modifier, m->stride[0], g_tex[m->slot]);
}

static void import_shm(const struct msg *m, const int *fds, int nfds) {
    if (nfds < 1)
        die("MSG_SHM without fd");
    g_shmSize = m->shm_size;
    g_shm = mmap(NULL, g_shmSize, PROT_READ, MAP_SHARED, fds[0], 0);
    close(fds[0]);
    if (g_shm == MAP_FAILED)
        die("mmap shm");
    for (int i = 0; i < RING; i++) {
        glGenTextures(1, &g_tex[i]);
        glBindTexture(GL_TEXTURE_2D, g_tex[i]);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, FRAME_W, FRAME_H, 0, GL_BGRA, GL_UNSIGNED_BYTE, NULL);
    }
    LOG("shm ring mapped: %zu bytes\n", g_shmSize);
}

// ---- transport messages ----------------------------------------------------------------------------------------
static void send_release(uint32_t slot, int fenceFd) {
    struct msg m = { .type = MSG_RELEASE, .slot = slot, .nfds = fenceFd >= 0 ? 1 : 0 };
    send_msg(g_sock, &m, &fenceFd, fenceFd >= 0 ? 1 : 0);
    if (fenceFd >= 0)
        close(fenceFd);
}

static void supersede(const struct frame *f) { // a newer frame replaced this one before it was latched
    if (f->n < MAXN)
        g_f[f->n].flags |= F_SUPERSEDED;
    if (f->fenceFd >= 0)
        close(f->fenceFd); // never sampled; the producer's next render into the slot is ordered on its own context
    send_release(f->slot, -1);
}

static bool frame_ready(const struct frame *f) {
    if (o_latch == LATCH_GPU_WAIT || f->fenceFd < 0)
        return true;
    struct pollfd pf = { f->fenceFd, POLLIN, 0 }; // a sync_file polls readable once signaled
    return poll(&pf, 1, 0) == 1;
}

static int pick_latch(void) { // newest latchable queued frame, -1 = none
    for (int i = g_nq - 1; i >= 0; i--)
        if (frame_ready(&g_q[i]))
            return i;
    return -1;
}

static void handle_msg(const struct msg *m, int *fds, int nfds) {
    switch (m->type) {
    case MSG_FRAME: {
        const int64_t t = now_ns();
        if (o_latch == LATCH_GPU_WAIT || g_nq == RING) { // gpu-wait: the newest frame wins on arrival
            const int k = o_latch == LATCH_GPU_WAIT ? g_nq : 1;
            for (int i = 0; i < k; i++)
                supersede(&g_q[i]);
            memmove(g_q, g_q + k, (size_t)(g_nq - k) * sizeof *g_q);
            g_nq -= k;
        }
        g_q[g_nq++] = (struct frame){ true, m->slot, m->n, nfds > 0 ? fds[0] : -1 };
        const struct frame *nf = &g_q[g_nq - 1];
        for (int i = 1; i < nfds; i++)
            close(fds[i]);
        // crash test: kill the worker the moment a frame (and its fence) is in our hands, before it is latched
        if (o_killAt > 0 && !g_killed && g_child > 0 && t >= g_winBegin + (int64_t)(o_killAt * 1e9)) {
            int sig = -1;
            if (nf->fenceFd >= 0) {
                struct pollfd pf = { nf->fenceFd, POLLIN, 0 };
                sig = poll(&pf, 1, 0) == 1;
            }
            kill(g_child, SIGKILL);
            g_killed = true;
            g_killT = t;
            LOG("CRASH TEST: SIGKILL worker pid %d with frame n=%llu pending, its acquire fence %s\n", g_child,
                (unsigned long long)m->n, sig < 0 ? "absent" : sig ? "already signaled" : "NOT YET SIGNALED");
        }
        if (m->n < MAXN) {
            g_f[m->n].tProd = m->t_ns;
            g_f[m->n].tSend = m->t2_ns;
            g_f[m->n].tRecv = t;
            g_f[m->n].flags |= F_RECV;
        }
        break;
    }
    case MSG_STATS:
        g_ps = m->ps;
        g_gotStats = true;
        break;
    case MSG_BUFFER:
        import_buffer(m, fds, nfds);
        break;
    case MSG_SHM:
        import_shm(m, fds, nfds);
        break;
    default:
        for (int i = 0; i < nfds; i++)
            close(fds[i]);
    }
}

static bool g_sockEof;
static void drain_socket(void) {
    struct msg m;
    int fds[4], nfds, r;
    while ((r = recv_msg(g_sock, &m, fds, &nfds, false)) == 1)
        handle_msg(&m, fds, nfds);
    if (r < 0)
        g_sockEof = true;
}

// ---- readback verification -------------------------------------------------------------------------------------
#define NPBO 8
#define RB_BYTES ((CORNER * CORNER + PROBE * PROBE) * 4)
static GLuint g_pbo[NPBO];
static GLsync g_pboSync[NPBO];
static uint64_t g_pboN[NPBO];
static bool g_pboHeld[NPBO]; // readback of the held last frame after the worker was killed
static uint64_t g_pboSeq[NPBO], g_rbSeq, g_rbNextCheck;

static void verify(const uint8_t *p, uint64_t n) {
    const bool w = in_win(n);
    // BGRA bytes. Corner: every pixel == (R = n & 255, G = (n >> 8) & 255, B = 0)
    const uint8_t R = p[2], G = p[1];
    bool uniform = true, cornerOk = true;
    for (int i = 0; i < CORNER * CORNER; i++) {
        const uint8_t *q = p + i * 4;
        if (q[2] != R || q[1] != G || q[0] != 0)
            uniform = false;
    }
    const uint32_t pixN = (uint32_t)R | ((uint32_t)G << 8);
    if (pixN != (n & 0xffff))
        cornerOk = false;
    // gradient probe: bottom-right PROBE x PROBE of the frame (GL rows bottom-up)
    bool gradOk = true;
    const uint8_t *g = p + CORNER * CORNER * 4;
    for (int j = 0; j < PROBE && gradOk; j++)
        for (int i = 0; i < PROBE; i++) {
            uint8_t e[3];
            grad_rgb(FRAME_W - PROBE + i, j, n, e);
            const uint8_t *q = g + (j * PROBE + i) * 4;
            if (q[2] != e[0] || q[1] != e[1] || q[0] != e[2]) {
                gradOk = false;
                break;
            }
        }
    // monotonic: compare the decoded 16-bit n with the previous readback (latch order)
    bool ooo = false;
    if (g_lastPixelN != UINT32_MAX) {
        uint32_t d = (pixN - g_lastPixelN) & 0xffff;
        ooo = d == 0 || d >= 0x8000;
    }
    g_lastPixelN = pixN;
    if (!w)
        return;
    c_readbacks++;
    if (!uniform)
        c_cornerNonUniform++;
    if (!cornerOk)
        c_cornerBad++;
    if (!gradOk)
        c_gradBad++;
    if (ooo)
        c_pixelOutOfOrder++;
    static int logged;
    if ((!uniform || !cornerOk || !gradOk || ooo) && logged < 12) {
        logged++;
        LOG("CHECK FAIL n=%llu: corner pixel n=%u%s%s%s%s\n", (unsigned long long)n, pixN, uniform ? "" : " non-uniform",
            cornerOk ? "" : " corner!=n", gradOk ? "" : " gradient-mismatch", ooo ? " out-of-order" : "");
    }
}

static void poll_gl(void) {
    // readbacks, in submission order
    for (;;) {
        int best = -1;
        for (int i = 0; i < NPBO; i++)
            if (g_pboSync[i] && g_pboSeq[i] == g_rbNextCheck)
                best = i;
        if (best < 0)
            break;
        GLenum r = glClientWaitSync(g_pboSync[best], 0, 0);
        if (r != GL_ALREADY_SIGNALED && r != GL_CONDITION_SATISFIED)
            break;
        glDeleteSync(g_pboSync[best]);
        g_pboSync[best] = 0;
        glBindBuffer(GL_PIXEL_PACK_BUFFER, g_pbo[best]);
        const uint8_t *p = glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0, RB_BYTES, GL_MAP_READ_BIT);
        if (p) {
            if (g_pboHeld[best]) { // after a worker crash: the held frame must still be intact
                bool ok = (uint32_t)(p[2] | (p[1] << 8)) == (g_pboN[best] & 0xffff);
                for (int j = 0; j < PROBE && ok; j++)
                    for (int i = 0; i < PROBE && ok; i++) {
                        uint8_t e[3];
                        grad_rgb(FRAME_W - PROBE + i, j, g_pboN[best], e);
                        const uint8_t *q = p + CORNER * CORNER * 4 + (j * PROBE + i) * 4;
                        ok = q[2] == e[0] && q[1] == e[1] && q[0] == e[2];
                    }
                c_heldChecks++;
                if (!ok)
                    c_heldBad++;
            } else
                verify(p, g_pboN[best]);
            glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
        }
        glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        g_rbNextCheck++;
    }
    // finish/nosync releases
    for (int i = 0; i < RING; i++)
        if (g_relSync[i]) {
            GLenum r = glClientWaitSync(g_relSync[i], 0, 0);
            if (r == GL_ALREADY_SIGNALED || r == GL_CONDITION_SATISFIED) {
                glDeleteSync(g_relSync[i]);
                g_relSync[i] = 0;
                send_release((uint32_t)i, -1);
            }
        }
}

static void queue_readback(uint64_t n, bool held) {
    int idx = -1;
    for (int i = 0; i < NPBO; i++)
        if (!g_pboSync[i]) {
            idx = i;
            break;
        }
    if (idx < 0) {
        if (in_win(n))
            c_readbackSkipped++;
        return;
    }
    glBindBuffer(GL_PIXEL_PACK_BUFFER, g_pbo[idx]);
    glReadPixels(0, g_h - CORNER, CORNER, CORNER, GL_BGRA, GL_UNSIGNED_BYTE, (void *)0);
    glReadPixels(FRAME_W - PROBE, 0, PROBE, PROBE, GL_BGRA, GL_UNSIGNED_BYTE, (void *)(uintptr_t)(CORNER * CORNER * 4));
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    g_pboSync[idx] = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    g_pboN[idx] = n;
    g_pboHeld[idx] = held;
    g_pboSeq[idx] = g_rbSeq++;
}

// ---- the per-vblank frame --------------------------------------------------------------------------------------
static const struct wl_callback_listener frame_listener;

static void render(void) {
    bool newly = false;
    struct frame prev = { 0 };
    const int li = pick_latch();
    if (li < 0 && g_nq > 0 && g_winState == 1)
        c_notReady++;
    if (li >= 0) {
        struct frame fr = g_q[li];
        for (int i = 0; i < li; i++)
            supersede(&g_q[i]);
        memmove(g_q, g_q + li + 1, (size_t)(g_nq - li - 1) * sizeof *g_q);
        g_nq -= li + 1;
        const uint64_t n = fr.n;
        if (o_mode == MODE_FENCE && fr.fenceFd >= 0) {
            struct pollfd pf = { fr.fenceFd, POLLIN, 0 };
            const bool signaled = poll(&pf, 1, 0) == 1;
            if (in_win(n))
                signaled ? c_fenceAlreadySignaled++ : c_fenceWaited++;
            const EGLAttrib a[] = { EGL_SYNC_NATIVE_FENCE_FD_ANDROID, fr.fenceFd, EGL_NONE };
            EGLSync s = eglCreateSync(g_dpy, EGL_SYNC_NATIVE_FENCE_ANDROID, a);
            if (s == EGL_NO_SYNC) {
                c_fenceImportFail++;
                poll(&pf, 1, 1000); // CPU fallback
                close(fr.fenceFd);
            } else { // EGL owns the fd; the GPU (not the CPU) waits -- a no-op when latch=signaled
                eglWaitSync(g_dpy, s, 0);
                eglDestroySync(g_dpy, s);
            }
            fr.fenceFd = -1;
        } else if (fr.fenceFd >= 0) {
            close(fr.fenceFd);
            fr.fenceFd = -1;
        }
        if (o_mode == MODE_SHM) { // CPU copy into this slot's texture; the slot is free once the call returns
            glBindTexture(GL_TEXTURE_2D, g_tex[fr.slot]);
            glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
            glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, FRAME_W, FRAME_H, GL_BGRA, GL_UNSIGNED_BYTE,
                            g_shm + (size_t)fr.slot * FRAME_BYTES);
            send_release(fr.slot, -1);
        }
        if (n <= g_lastLatchedN && in_win(n))
            c_metaOutOfOrder++;
        if (g_lastLatchedN && n > g_lastLatchedN + 1 && in_win(n)) {
            c_gaps++;
            c_gapFrames += n - g_lastLatchedN - 1;
        }
        g_lastLatchedN = n;
        prev = g_current;
        g_current = fr;
        newly = true;
        if (n < MAXN)
            g_f[n].flags |= F_LATCHED;
    }

    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, g_w, g_h);
    if (g_current.valid) {
        glUseProgram(g_prog);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, g_tex[g_current.slot]);
        glBindVertexArray(g_vao);
        glDrawArrays(GL_TRIANGLES, 0, 3);
    } else {
        glClearColor(0.05f, 0.05f, 0.05f, 1);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    if (newly && o_verify)
        queue_readback(g_current.n, false);
    else if (g_killed && o_verify && g_current.valid && c_commits % 24 == 0)
        queue_readback(g_current.n, true);
    if (g_killed && newly)
        c_latchedAfterKill++;

    // the previous slot is no longer referenced by anything submitted after this point: release it
    if (prev.valid && o_mode != MODE_SHM) {
        if (o_mode == MODE_FENCE) {
            const EGLAttrib a[] = { EGL_SYNC_NATIVE_FENCE_FD_ANDROID, EGL_NO_NATIVE_FENCE_FD_ANDROID, EGL_NONE };
            EGLSync s = eglCreateSync(g_dpy, EGL_SYNC_NATIVE_FENCE_ANDROID, a);
            glFlush();
            int fd = s != EGL_NO_SYNC ? p_dupFence(g_dpy, s) : -1;
            if (s != EGL_NO_SYNC)
                eglDestroySync(g_dpy, s);
            send_release(prev.slot, fd);
        } else {
            if (g_relSync[prev.slot])
                glDeleteSync(g_relSync[prev.slot]);
            g_relSync[prev.slot] = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        }
    }

    struct wl_callback *cb = wl_surface_frame(g_surf);
    wl_callback_add_listener(cb, &frame_listener, NULL);
    g_cbPending = true;
    if (g_pres) {
        struct fb_rec *r = calloc(1, sizeof *r);
        r->n = g_current.valid ? g_current.n : 0;
        r->newly = newly;
        struct wp_presentation_feedback *fb = wp_presentation_feedback(g_pres, g_surf);
        wp_presentation_feedback_add_listener(fb, &fb_listener, r);
    }
    const int64_t tSwap = now_ns();
    if (newly && g_current.n < MAXN)
        g_f[g_current.n].tSwap = tSwap;
    if (!eglSwapBuffers(g_dpy, g_eglSurf))
        die("eglSwapBuffers");
    c_commits++;
    poll_gl();
}

static void frame_done(void *d, struct wl_callback *cb, uint32_t t) {
    (void)d, (void)t;
    wl_callback_destroy(cb);
    g_cbPending = false;
    if (g_stopping)
        return;
    const int64_t now = now_ns();
    if (g_lastCb && g_winState == 1)
        samples_push(&s_cbInterval, now - g_lastCb);
    g_lastCb = now;
    if (o_redrawVblank || pick_latch() >= 0)
        render();
}
static const struct wl_callback_listener frame_listener = { frame_done };

// ---- main ------------------------------------------------------------------------------------------------------
static void usage(void) {
    fprintf(stderr, "usage: consumer --mode fence|finish|shm|nosync [--seconds 60] [--warmup 3] [--fps 144] "
                    "[--output DP-2] [--redraw vblank|new] [--layer bottom|background] [--producer ./producer] "
                    "[--out results.jsonl] [--label text]\n");
    exit(1);
}

static void pct_ms(const char *name, struct samples *s, FILE *f, bool json) {
    samples_sort(s);
    if (json)
        fprintf(f, "\"%s_p50_ms\":%.3f,\"%s_p95_ms\":%.3f,\"%s_p99_ms\":%.3f,\"%s_max_ms\":%.3f,", name,
                samples_pct(s, 50) / 1e6, name, samples_pct(s, 95) / 1e6, name, samples_pct(s, 99) / 1e6, name,
                s->n ? s->v[s->n - 1] / 1e6 : -1.0);
    else
        fprintf(f, "  %-22s p50 %7.3f  p95 %7.3f  p99 %7.3f  max %7.3f ms  (n=%zu)\n", name, samples_pct(s, 50) / 1e6,
                samples_pct(s, 95) / 1e6, samples_pct(s, 99) / 1e6, s->n ? s->v[s->n - 1] / 1e6 : -1.0, s->n);
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!v)
            usage();
        if (!strcmp(a, "--mode"))
            o_mode = parse_mode(v);
        else if (!strcmp(a, "--seconds"))
            o_seconds = atof(v);
        else if (!strcmp(a, "--warmup"))
            o_warmup = atof(v);
        else if (!strcmp(a, "--fps"))
            o_fps = atof(v);
        else if (!strcmp(a, "--output"))
            o_output = v;
        else if (!strcmp(a, "--redraw"))
            o_redrawVblank = !strcmp(v, "vblank");
        else if (!strcmp(a, "--layer"))
            o_layer = !strcmp(v, "background") ? ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND : ZWLR_LAYER_SHELL_V1_LAYER_BOTTOM;
        else if (!strcmp(a, "--producer"))
            o_producer = v;
        else if (!strcmp(a, "--out"))
            o_out = v;
        else if (!strcmp(a, "--label"))
            o_label = v;
        else if (!strcmp(a, "--verify"))
            o_verify = strcmp(v, "off") != 0;
        else if (!strcmp(a, "--latch"))
            o_latch = !strcmp(v, "signaled") ? LATCH_SIGNALED : LATCH_GPU_WAIT;
        else if (!strcmp(a, "--kill-at"))
            o_killAt = atof(v);
        else
            usage();
        i++;
    }
    if (o_mode < 0)
        usage();
    signal(SIGPIPE, SIG_IGN);
    g_f = calloc(MAXN, sizeof *g_f);

    // wayland: globals, output, layer surface
    g_wl = wl_display_connect(NULL);
    if (!g_wl)
        die("wl_display_connect");
    struct wl_registry *reg = wl_display_get_registry(g_wl);
    wl_registry_add_listener(reg, &reg_listener, NULL);
    wl_display_roundtrip(g_wl);
    wl_display_roundtrip(g_wl);
    if (!g_comp || !g_layerShell)
        die("compositor lacks wl_compositor / zwlr_layer_shell_v1");
    struct wl_output *out = NULL;
    for (int i = 0; i < g_nouts; i++)
        if (!strcmp(g_outs[i].name, o_output))
            out = g_outs[i].o, g_outMhz = g_outs[i].mhz;
    if (!out)
        die("output not found");
    LOG("output %s @ %.3f Hz, wp_presentation %s (clock %u, CLOCK_MONOTONIC=%d)\n", o_output, g_outMhz / 1000.0,
        g_pres ? "yes" : "NO", g_presClock, CLOCK_MONOTONIC);
    if (g_pres && g_presClock != CLOCK_MONOTONIC)
        LOG("WARNING: presentation clock is not CLOCK_MONOTONIC; present latency is invalid\n");

    g_surf = wl_compositor_create_surface(g_comp);
    struct wl_region *empty = wl_compositor_create_region(g_comp);
    wl_surface_set_input_region(g_surf, empty); // click-through
    wl_region_destroy(empty);
    g_ls = zwlr_layer_shell_v1_get_layer_surface(g_layerShell, g_surf, out, o_layer, "liascape-dmabuf-spike");
    zwlr_layer_surface_v1_add_listener(g_ls, &ls_listener, NULL);
    zwlr_layer_surface_v1_set_anchor(g_ls, ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM
                                               | ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT);
    zwlr_layer_surface_v1_set_exclusive_zone(g_ls, -1);
    zwlr_layer_surface_v1_set_keyboard_interactivity(g_ls, 0);
    wl_surface_commit(g_surf);
    while (!g_configured && wl_display_dispatch(g_wl) != -1) {
    }
    LOG("layer surface configured %dx%d (layer %s)\n", g_w, g_h,
        o_layer == ZWLR_LAYER_SHELL_V1_LAYER_BOTTOM ? "bottom" : "background");
    if (g_w != FRAME_W || g_h != FRAME_H)
        die("surface is not 1920x1080 (the probe readback assumes 1:1)");

    egl_init();
    gl_init();
    glGenBuffers(NPBO, g_pbo);
    for (int i = 0; i < NPBO; i++) {
        glBindBuffer(GL_PIXEL_PACK_BUFFER, g_pbo[i]);
        glBufferData(GL_PIXEL_PACK_BUFFER, RB_BYTES, NULL, GL_STREAM_READ);
    }
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);

    if (o_mode == MODE_LOCAL) { // baseline: no worker, one static texture, same present loop
        glGenTextures(1, &g_tex[0]);
        glBindTexture(GL_TEXTURE_2D, g_tex[0]);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, FRAME_W, FRAME_H, 0, GL_BGRA, GL_UNSIGNED_BYTE, NULL);
        g_current = (struct frame){ true, 0, 0, -1 };
        g_gotStats = true;
        g_sockEof = true;
        goto started;
    }
    // spawn the worker
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sv) < 0)
        die("socketpair");
    g_child = fork();
    if (g_child == 0) {
        int fd = dup(sv[1]); // dup() clears FD_CLOEXEC
        char fdArg[16], fpsArg[32];
        snprintf(fdArg, sizeof fdArg, "%d", fd);
        snprintf(fpsArg, sizeof fpsArg, "%g", o_fps);
        execl(o_producer, o_producer, "--fd", fdArg, "--mode", mode_names[o_mode], "--fps", fpsArg, (char *)NULL);
        perror("exec producer");
        _exit(127);
    }
    close(sv[1]);
    g_sock = sv[0];

    // receive + import the ring (blocking)
    int want = o_mode == MODE_SHM ? 1 : RING, got = 0;
    while (got < want) {
        struct msg m;
        int fds[4], nfds;
        if (recv_msg(g_sock, &m, fds, &nfds, true) < 0)
            die("producer hung up during setup");
        const int64_t t0 = now_ns();
        handle_msg(&m, fds, nfds);
        if (m.type == MSG_BUFFER || m.type == MSG_SHM) {
            got++;
            LOG("import took %.3f ms\n", (now_ns() - t0) / 1e6);
        }
    }

    const int64_t tStart = now_ns();
    g_winBegin = tStart + (int64_t)(o_warmup * 1e9);
    g_winEnd = g_winBegin + (int64_t)(o_seconds * 1e9);
    struct msg sm = { .type = MSG_START, .t_ns = g_winBegin, .t2_ns = g_winEnd };
    send_msg(g_sock, &sm, NULL, 0);
started:
    if (o_mode == MODE_LOCAL) {
        g_winBegin = now_ns() + (int64_t)(o_warmup * 1e9);
        g_winEnd = g_winBegin + (int64_t)(o_seconds * 1e9);
    }
    LOG("mode %s, redraw %s, producer %.1f fps, warmup %.1f s, window %.1f s\n", mode_names[o_mode],
        o_redrawVblank ? "vblank" : "new", o_fps, o_warmup, o_seconds);

    render(); // first commit maps the surface and arms the frame callback

    const int wlFd = wl_display_get_fd(g_wl);
    int64_t statsDeadline = 0;
    while (!g_closed) {
        while (wl_display_prepare_read(g_wl) != 0)
            wl_display_dispatch_pending(g_wl);
        wl_display_flush(g_wl);
        struct pollfd pf[2 + RING] = { { wlFd, POLLIN, 0 }, { g_sock, g_sockEof ? 0 : POLLIN, 0 } };
        int npf = 2;
        if (!o_redrawVblank && !g_cbPending && o_latch == LATCH_SIGNALED)
            for (int i = 0; i < g_nq; i++)
                if (g_q[i].fenceFd >= 0)
                    pf[npf++] = (struct pollfd){ g_q[i].fenceFd, POLLIN, 0 };
        bool glWork = false;
        for (int i = 0; i < NPBO; i++)
            glWork |= g_pboSync[i] != 0;
        for (int i = 0; i < RING; i++)
            glWork |= g_relSync[i] != 0;
        if (g_sockEof)
            pf[1].fd = -1;
        int pr = poll(pf, (nfds_t)npf, glWork ? 4 : 50);
        if (pr > 0 && (pf[0].revents & POLLIN))
            wl_display_read_events(g_wl);
        else
            wl_display_cancel_read(g_wl);
        if (wl_display_dispatch_pending(g_wl) < 0)
            die("wayland connection lost");
        if (!g_sockEof && (pf[1].revents & (POLLIN | POLLHUP)))
            drain_socket();
        if (!o_redrawVblank && !g_cbPending && pick_latch() >= 0)
            render();
        if (glWork)
            poll_gl();

        const int64_t now = now_ns();
        if (g_winState == 0 && now >= g_winBegin) {
            g_winState = 1;
            g_cpu0 = cpu_ns();
            g_wall0 = now;
        } else if (g_winState == 1 && now >= g_winEnd) {
            g_winState = 2;
            g_cpuNs = cpu_ns() - g_cpu0;
            g_wallNs = now - g_wall0;
            statsDeadline = now + 3 * 1000000000LL;
        }
        // done once the producer reported and the last frames' presentation feedback had time to arrive
        if (g_winState == 2 && ((g_gotStats && now > g_winEnd + 600 * 1000000LL) || now > statsDeadline))
            break;
    }

    // unmap + tear down the surface FIRST so the live wallpaper is revealed immediately
    g_stopping = true;
    poll_gl();
    eglMakeCurrent(g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, g_ctx);
    eglDestroySurface(g_dpy, g_eglSurf);
    wl_egl_window_destroy(g_eglWin);
    zwlr_layer_surface_v1_destroy(g_ls);
    wl_surface_destroy(g_surf);
    wl_display_roundtrip(g_wl);
    if (g_sock >= 0)
        close(g_sock);
    int status = 0;
    if (g_child > 0)
        waitpid(g_child, &status, 0);

    // ---- results -----------------------------------------------------------------------------------------------
    uint64_t recv = 0, superseded = 0, latched = 0, presented = 0, discardedOnly = 0;
    struct samples sRecv = { 0 }, sSwap = { 0 }, sPres = { 0 }, sXfer = { 0 };
    for (uint32_t n = 1; n < MAXN; n++) {
        if (!in_win(n) || !(g_f[n].flags & F_RECV))
            continue;
        recv++;
        const struct frec *f = &g_f[n];
        samples_push(&sRecv, f->tRecv - f->tProd);
        samples_push(&sXfer, f->tRecv - f->tSend);
        if (f->flags & F_SUPERSEDED)
            superseded++;
        if (f->flags & F_LATCHED) {
            latched++;
            samples_push(&sSwap, f->tSwap - f->tProd);
        }
        if (f->flags & F_PRESENTED) {
            presented++;
            samples_push(&sPres, f->tPres - f->tProd);
        } else if (f->flags & F_DISCARDED)
            discardedOnly++;
    }
    const double win = o_seconds;
    const double cpuC = g_wallNs ? 100.0 * g_cpuNs / g_wallNs : -1, cpuP = g_ps.wall_ns ? 100.0 * g_ps.cpu_ns / g_ps.wall_ns : -1;
    const double delivered = presented / win;
    const bool pass = delivered >= 143.0 && c_pixelOutOfOrder == 0 && c_metaOutOfOrder == 0 && c_cornerBad == 0
                      && c_gradBad == 0 && cpuC < 5.0 && cpuP < 5.0;

    FILE *f = stdout;
    fprintf(f, "\n==== %s  redraw=%s  latch=%s  %s @ %.2f Hz  producer %.0f fps  window %.0f s %s====\n",
            mode_names[o_mode], o_redrawVblank ? "vblank" : "new", o_latch == LATCH_SIGNALED ? "signaled" : "gpu-wait",
            o_output, g_outMhz / 1000.0, o_fps, win, o_label);
    fprintf(f, "  producer: rendered %llu (%.2f fps), missed ticks %llu, slot stalls %llu (total %.2f ms, max %.2f ms), "
               "release fences unsignaled at reuse %llu, cpu %.2f %% (%d threads), submit p50 %.3f p99 %.3f max %.3f ms\n",
            (unsigned long long)g_ps.frames, g_ps.frames / win, (unsigned long long)g_ps.missed_ticks,
            (unsigned long long)g_ps.slot_stalls, g_ps.stall_ns_total / 1e6, g_ps.stall_ns_max / 1e6,
            (unsigned long long)g_ps.release_fence_unsignaled, cpuP, g_ps.threads, g_ps.submit_p50_ns / 1e6,
            g_ps.submit_p99_ns / 1e6, g_ps.submit_max_ns / 1e6);
    fprintf(f, "  consumer: received %llu, latched %llu, superseded-before-latch %llu, presented %llu, "
               "discarded-only %llu -> DELIVERED %.2f fps\n",
            (unsigned long long)recv, (unsigned long long)latched, (unsigned long long)superseded,
            (unsigned long long)presented, (unsigned long long)discardedOnly, delivered);
    fprintf(f, "  checks: readbacks %llu (skipped %llu), corner!=n %llu, corner non-uniform %llu, gradient mismatch %llu, "
               "pixel out-of-order %llu, meta out-of-order %llu, latch gaps %llu (%llu frames)\n",
            (unsigned long long)c_readbacks, (unsigned long long)c_readbackSkipped, (unsigned long long)c_cornerBad,
            (unsigned long long)c_cornerNonUniform, (unsigned long long)c_gradBad, (unsigned long long)c_pixelOutOfOrder,
            (unsigned long long)c_metaOutOfOrder, (unsigned long long)c_gaps, (unsigned long long)c_gapFrames);
    fprintf(f, "  fence: already signaled at latch %llu, GPU-waited %llu, vblanks reusing previous (not ready) %llu, "
               "import failures %llu, release import fail %llu\n",
            (unsigned long long)c_fenceAlreadySignaled, (unsigned long long)c_fenceWaited, (unsigned long long)c_notReady,
            (unsigned long long)c_fenceImportFail, (unsigned long long)g_ps.release_fence_fail);
    fprintf(f, "  consumer cpu %.2f %%, commits %llu (presented %llu, discarded %llu)\n", cpuC,
            (unsigned long long)c_commits, (unsigned long long)c_commitsPresented, (unsigned long long)c_commitsDiscarded);
    pct_ms("lat prod->recv", &sRecv, f, false);
    pct_ms("lat send->recv", &sXfer, f, false);
    pct_ms("lat prod->swap", &sSwap, f, false);
    pct_ms("lat prod->present", &sPres, f, false);
    pct_ms("frame-callback period", &s_cbInterval, f, false);
    if (g_killed) {
        for (uint32_t n = 1; n < MAXN; n++)
            if ((g_f[n].flags & F_PRESENTED) && g_f[n].tPres > g_killT)
                c_presentedAfterKill++;
        fprintf(f, "  CRASH TEST: worker SIGKILLed at +%.1f s; frames latched after kill %llu, held-frame readbacks %llu, "
                   "held-frame corrupt %llu; compositor kept presenting (commits total %llu, cb period max %.3f ms)\n",
                o_killAt, (unsigned long long)c_latchedAfterKill, (unsigned long long)c_heldChecks,
                (unsigned long long)c_heldBad, (unsigned long long)c_commits,
                s_cbInterval.n ? s_cbInterval.v[s_cbInterval.n - 1] / 1e6 : -1.0);
    }
    fprintf(f, "  RESULT: %s\n", pass ? "PASS" : "FAIL");

    if (o_out) {
        FILE *j = fopen(o_out, "a");
        if (j) {
            fprintf(j, "{\"latch\":\"%s\",\"not_ready_vblanks\":%llu,\"work\":%d,", o_latch == LATCH_SIGNALED ? "signaled" : "gpu-wait",
                    (unsigned long long)c_notReady, getenv("LIASCAPE_SPIKE_WORK") ? atoi(getenv("LIASCAPE_SPIKE_WORK")) : 0);
            fprintf(j, "\"label\":\"%s\",\"mode\":\"%s\",\"redraw\":\"%s\",\"output\":\"%s\",\"output_hz\":%.3f,"
                       "\"fps_target\":%.1f,\"seconds\":%.1f,\"delivered_fps\":%.3f,\"received\":%llu,\"latched\":%llu,"
                       "\"superseded\":%llu,\"presented\":%llu,\"discarded_only\":%llu,\"readbacks\":%llu,"
                       "\"corner_bad\":%llu,\"corner_nonuniform\":%llu,\"grad_bad\":%llu,\"pixel_ooo\":%llu,"
                       "\"meta_ooo\":%llu,\"gaps\":%llu,\"gap_frames\":%llu,\"fence_signaled_at_latch\":%llu,"
                       "\"fence_gpu_waited\":%llu,\"fence_import_fail\":%llu,\"consumer_cpu_pct\":%.3f,"
                       "\"producer_cpu_pct\":%.3f,\"producer_frames\":%llu,\"producer_missed_ticks\":%llu,"
                       "\"producer_slot_stalls\":%llu,\"producer_threads\":%d,\"producer_submit_p50_ms\":%.3f,"
                       "\"producer_submit_p99_ms\":%.3f,\"release_unsignaled\":%llu,",
                    o_label, mode_names[o_mode], o_redrawVblank ? "vblank" : "new", o_output, g_outMhz / 1000.0, o_fps,
                    win, delivered, (unsigned long long)recv, (unsigned long long)latched,
                    (unsigned long long)superseded, (unsigned long long)presented, (unsigned long long)discardedOnly,
                    (unsigned long long)c_readbacks, (unsigned long long)c_cornerBad,
                    (unsigned long long)c_cornerNonUniform, (unsigned long long)c_gradBad,
                    (unsigned long long)c_pixelOutOfOrder, (unsigned long long)c_metaOutOfOrder,
                    (unsigned long long)c_gaps, (unsigned long long)c_gapFrames,
                    (unsigned long long)c_fenceAlreadySignaled, (unsigned long long)c_fenceWaited,
                    (unsigned long long)c_fenceImportFail, cpuC, cpuP, (unsigned long long)g_ps.frames,
                    (unsigned long long)g_ps.missed_ticks, (unsigned long long)g_ps.slot_stalls, g_ps.threads,
                    g_ps.submit_p50_ns / 1e6, g_ps.submit_p99_ns / 1e6,
                    (unsigned long long)g_ps.release_fence_unsignaled);
            pct_ms("lat_recv", &sRecv, j, true);
            pct_ms("lat_swap", &sSwap, j, true);
            pct_ms("lat_present", &sPres, j, true);
            pct_ms("cb_period", &s_cbInterval, j, true);
            fprintf(j, "\"pass\":%s}\n", pass ? "true" : "false");
            fclose(j);
        }
    }
    for (int i = 0; i < RING; i++)
        if (g_img[i])
            eglDestroyImage(g_dpy, g_img[i]);
    eglMakeCurrent(g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroyContext(g_dpy, g_ctx);
    eglTerminate(g_dpy);
    wl_display_disconnect(g_wl);
    return pass ? 0 : 3;
}
