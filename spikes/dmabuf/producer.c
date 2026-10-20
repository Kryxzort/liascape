// Spike (throwaway): the WORKER side of worker -> compositor GPU frame sharing.
// Surfaceless EGL desktop-GL 3.3 core context (EGL_MESA_platform_surfaceless first, else EGL_EXT_platform_device,
// same approach as spikes/lwe-core/host.cpp). Renders 1920x1080 frames at --fps into a RING of textures:
//   top-left 64x64 = colour (n & 255, (n >> 8) & 255, 0), the rest = an animated integer gradient of n.
// Each ring texture is exported ONCE as a dmabuf (eglCreateImage(EGL_GL_TEXTURE_2D) +
// eglExportDMABUFImageQueryMESA/eglExportDMABUFImageMESA); per frame only {slot, n, timestamps, fence fd} travel.
//
//   producer --fd N --mode fence|finish|shm|nosync|fdpoll [--fps 144]   (spawned by consumer)
//   producer --dump-ext                                            (print EGL client/display extensions, exit)
#include "common.h"

#include <sys/mman.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#define GL_GLEXT_PROTOTYPES 1
#include <GL/gl.h>
#include <GL/glext.h>

static int g_sock = -1;
static int g_mode = MODE_FENCE;
static double g_fps = 144.0;
static EGLDisplay g_dpy = EGL_NO_DISPLAY;
static EGLContext g_ctx = EGL_NO_CONTEXT;
static const char *g_eglPath = "?";

static PFNEGLEXPORTDMABUFIMAGEQUERYMESAPROC p_exportQuery;
static PFNEGLEXPORTDMABUFIMAGEMESAPROC p_export;
static PFNEGLDUPNATIVEFENCEFDANDROIDPROC p_dupFence;

#define LOG(...) fprintf(stderr, "[producer] " __VA_ARGS__)

static void die(const char *what) {
    LOG("FATAL: %s (egl 0x%x, gl 0x%x)\n", what, eglGetError(), g_ctx ? glGetError() : 0);
    exit(2);
}

// ---------------------------------------------------------------------------------------------------------------
static void egl_init(bool dump) {
    const char *client = eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);
    if (dump)
        printf("EGL client extensions (EGL_NO_DISPLAY):\n%s\n\n", client ? client : "(none)");

    if (has_ext(client, "EGL_MESA_platform_surfaceless")) {
        EGLDisplay d = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
        if (d != EGL_NO_DISPLAY && eglInitialize(d, NULL, NULL)) {
            g_dpy = d;
            g_eglPath = "EGL_PLATFORM_SURFACELESS_MESA";
        }
    }
    if (g_dpy == EGL_NO_DISPLAY && has_ext(client, "EGL_EXT_platform_device")) {
        PFNEGLQUERYDEVICESEXTPROC queryDevices = (void *)eglGetProcAddress("eglQueryDevicesEXT");
        EGLDeviceEXT devs[16];
        EGLint n = 0;
        if (queryDevices)
            queryDevices(16, devs, &n);
        for (int i = 0; i < n && g_dpy == EGL_NO_DISPLAY; i++) {
            EGLDisplay d = eglGetPlatformDisplay(EGL_PLATFORM_DEVICE_EXT, devs[i], NULL);
            if (d != EGL_NO_DISPLAY && eglInitialize(d, NULL, NULL)) {
                g_dpy = d;
                g_eglPath = "EGL_PLATFORM_DEVICE_EXT";
            }
        }
    }
    if (g_dpy == EGL_NO_DISPLAY)
        die("no surfaceless EGL display");

    const char *dext = eglQueryString(g_dpy, EGL_EXTENSIONS);
    LOG("EGL path %s, vendor %s, version %s\n", g_eglPath, eglQueryString(g_dpy, EGL_VENDOR),
        eglQueryString(g_dpy, EGL_VERSION));
    if (dump)
        printf("EGL display extensions (%s, vendor %s, EGL %s):\n%s\n\n", g_eglPath, eglQueryString(g_dpy, EGL_VENDOR),
               eglQueryString(g_dpy, EGL_VERSION), dext ? dext : "(none)");

    const char *need[] = { "EGL_KHR_surfaceless_context", "EGL_KHR_gl_texture_2D_image", "EGL_MESA_image_dma_buf_export",
                           "EGL_ANDROID_native_fence_sync", "EGL_KHR_wait_sync" };
    for (size_t i = 0; i < sizeof need / sizeof *need; i++) {
        bool ok = has_ext(dext, need[i]);
        LOG("  %-34s %s\n", need[i], ok ? "yes" : "MISSING");
        if (dump)
            printf("  %-34s %s\n", need[i], ok ? "yes" : "MISSING");
    }

    if (!eglBindAPI(EGL_OPENGL_API))
        die("eglBindAPI(EGL_OPENGL_API)");
    const EGLint cfgAttr[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_RED_SIZE, 8,
                               EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE };
    EGLConfig cfg;
    EGLint ncfg = 0;
    if (!eglChooseConfig(g_dpy, cfgAttr, &cfg, 1, &ncfg) || ncfg == 0)
        die("eglChooseConfig");
    const int prio = env_prio("LP_SPIKE_PRODUCER_PRIO"); // EGL_IMG_context_priority experiment
    EGLint ctxAttr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
                         EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE, 0, EGL_NONE };
    if (prio)
        ctxAttr[6] = 0x3100 /* EGL_CONTEXT_PRIORITY_LEVEL_IMG */, ctxAttr[7] = prio;
    g_ctx = eglCreateContext(g_dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
    if (g_ctx == EGL_NO_CONTEXT || !eglMakeCurrent(g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, g_ctx))
        die("eglCreateContext/eglMakeCurrent (surfaceless)");
    if (prio) {
        EGLint got = 0;
        eglQueryContext(g_dpy, g_ctx, 0x3100, &got);
        LOG("context priority requested %s, granted %s\n", prio_name(prio), prio_name(got));
    }
    GLint prof = 0;
    glGetIntegerv(GL_CONTEXT_PROFILE_MASK, &prof);
    LOG("GL %s | %s | %s | %s\n", glGetString(GL_VENDOR), glGetString(GL_RENDERER), glGetString(GL_VERSION),
        prof & GL_CONTEXT_CORE_PROFILE_BIT ? "core" : "compat");
    if (dump)
        printf("\nGL: %s | %s | %s | %s\n", glGetString(GL_VENDOR), glGetString(GL_RENDERER), glGetString(GL_VERSION),
               prof & GL_CONTEXT_CORE_PROFILE_BIT ? "core" : "compat");

    p_exportQuery = (void *)eglGetProcAddress("eglExportDMABUFImageQueryMESA");
    p_export = (void *)eglGetProcAddress("eglExportDMABUFImageMESA");
    p_dupFence = (void *)eglGetProcAddress("eglDupNativeFenceFDANDROID");
}

// ---------------------------------------------------------------------------------------------------------------
static const char *VS = "#version 330 core\n"
                        "void main() {\n"
                        "  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);\n"
                        "  gl_Position = vec4(p, 0.0, 1.0);\n"
                        "}\n";
// integer math so the consumer can predict every probe pixel exactly (see grad_rgb in common.h)
static const char *FS = "#version 330 core\n"
                        "uniform int u_n;\n"
                        "uniform int u_work;\n"
                        "out vec4 o;\n"
                        "void main() {\n"
                        "  ivec2 p = ivec2(gl_FragCoord.xy);\n"
                        "  float acc = 0.0;\n" // optional synthetic GPU load (LP_SPIKE_WORK), never changes pixels
                        "  for (int i = 0; i < u_work; i++) acc += sin(float(i) * 0.001 + gl_FragCoord.x);\n"
                        "  if (acc == 12345.678) discard;\n"
                        "  if (p.x < 64 && p.y >= 1080 - 64) {\n"
                        "    o = vec4(float(u_n & 255), float((u_n >> 8) & 255), 0.0, 255.0) / 255.0;\n"
                        "    return;\n"
                        "  }\n"
                        "  int r = (p.x * 255 / 1919 + u_n) & 255;\n"
                        "  int g = (p.y * 255 / 1079 + 2 * u_n) & 255;\n"
                        "  int b = ((p.x + p.y) / 8 + 3 * u_n) & 255;\n"
                        "  o = vec4(float(r), float(g), float(b), 255.0) / 255.0;\n"
                        "}\n";

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

static GLuint g_prog, g_vao;
static GLint g_uN, g_uWork;
static int g_work; // env LP_SPIKE_WORK: per-pixel loop iterations of synthetic GPU load (0 = trivial frame)

static void gl_init(void) {
    g_prog = glCreateProgram();
    glAttachShader(g_prog, compile(GL_VERTEX_SHADER, VS));
    glAttachShader(g_prog, compile(GL_FRAGMENT_SHADER, FS));
    glLinkProgram(g_prog);
    GLint ok = 0;
    glGetProgramiv(g_prog, GL_LINK_STATUS, &ok);
    if (!ok)
        die("link");
    g_uN = glGetUniformLocation(g_prog, "u_n");
    g_uWork = glGetUniformLocation(g_prog, "u_work");
    glGenVertexArrays(1, &g_vao);
}

static GLuint make_target(GLuint *fbo) {
    GLuint tex;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, 0);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, FRAME_W, FRAME_H, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glGenFramebuffers(1, fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, *fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        die("FBO incomplete");
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    return tex;
}

static void render(GLuint fbo, uint64_t n) {
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glViewport(0, 0, FRAME_W, FRAME_H);
    glUseProgram(g_prog);
    glUniform1i(g_uN, (GLint)(n & 0xffff));
    glUniform1i(g_uWork, g_work);
    glBindVertexArray(g_vao);
    glDrawArrays(GL_TRIANGLES, 0, 3);
}

// ---------------------------------------------------------------------------------------------------------------
// ring slots. dmabuf modes: one exported texture per slot. shm mode: one memfd frame per slot.
struct slot {
    GLuint tex, fbo;
    EGLImage img;
    bool free;
    int relFd; // release fence from the consumer (fence mode), -1 = none
};
static struct slot g_slots[RING];
static int g_lastSlot = RING - 1;
static uint8_t *g_shm;

static struct prod_stats g_ps;
static int64_t g_winBegin, g_winEnd;
static bool g_eof;

static void handle_msg(const struct msg *m, const int *fds, int nfds) {
    if (m->type == MSG_RELEASE && m->slot < RING) {
        struct slot *s = &g_slots[m->slot];
        if (s->relFd >= 0)
            close(s->relFd);
        s->relFd = nfds > 0 ? fds[0] : -1;
        for (int i = 1; i < nfds; i++)
            close(fds[i]);
        s->free = true;
    } else {
        for (int i = 0; i < nfds; i++)
            close(fds[i]);
    }
}

static void drain(void) {
    struct msg m;
    int fds[4], nfds, r;
    while ((r = recv_msg(g_sock, &m, fds, &nfds, false)) == 1)
        handle_msg(&m, fds, nfds);
    if (r < 0)
        g_eof = true;
}

// Pick the next free slot (round-robin). If none is free, block on the socket for a RELEASE (a stall).
static int acquire_slot(bool inWindow) {
    drain();
    int64_t t0 = 0;
    for (;;) {
        for (int k = 1; k <= RING; k++) {
            int i = (g_lastSlot + k) % RING;
            if (g_slots[i].free) {
                if (t0 && inWindow) {
                    int64_t d = now_ns() - t0;
                    g_ps.slot_stalls++;
                    g_ps.stall_ns_total += d;
                    if (d > g_ps.stall_ns_max)
                        g_ps.stall_ns_max = d;
                }
                g_lastSlot = i;
                g_slots[i].free = false;
                return i;
            }
        }
        if (g_eof)
            return -1;
        if (!t0)
            t0 = now_ns();
        struct pollfd p = { g_sock, POLLIN, 0 };
        poll(&p, 1, 100);
        drain();
    }
}

// fence mode: make the GPU (not the CPU) wait until the consumer has finished sampling this slot
static void wait_release(struct slot *s, bool inWindow) {
    if (s->relFd < 0)
        return;
    if (inWindow) {
        struct pollfd p = { s->relFd, POLLIN, 0 };
        if (poll(&p, 1, 0) == 0)
            g_ps.release_fence_unsignaled++;
    }
    const EGLAttrib a[] = { EGL_SYNC_NATIVE_FENCE_FD_ANDROID, s->relFd, EGL_NONE };
    EGLSync sync = eglCreateSync(g_dpy, EGL_SYNC_NATIVE_FENCE_ANDROID, a);
    if (sync == EGL_NO_SYNC) { // fd not consumed: CPU-wait instead
        g_ps.release_fence_fail++;
        struct pollfd p = { s->relFd, POLLIN, 0 };
        poll(&p, 1, 1000);
        close(s->relFd);
    } else { // EGL owns the fd now
        eglWaitSync(g_dpy, sync, 0);
        eglDestroySync(g_dpy, sync);
    }
    s->relFd = -1;
}

static int make_fence_fd(void) {
    const EGLAttrib a[] = { EGL_SYNC_NATIVE_FENCE_FD_ANDROID, EGL_NO_NATIVE_FENCE_FD_ANDROID, EGL_NONE };
    EGLSync sync = eglCreateSync(g_dpy, EGL_SYNC_NATIVE_FENCE_ANDROID, a);
    if (sync == EGL_NO_SYNC)
        die("eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID)");
    glFlush(); // the native fence fd only exists once the fence command has been flushed
    int fd = p_dupFence(g_dpy, sync);
    eglDestroySync(g_dpy, sync);
    if (fd < 0)
        die("eglDupNativeFenceFDANDROID");
    return fd;
}

static void setup_dmabuf_ring(void) {
    if (!p_exportQuery || !p_export)
        die("EGL_MESA_image_dma_buf_export entry points missing");
    for (int i = 0; i < RING; i++) {
        struct slot *s = &g_slots[i];
        s->tex = make_target(&s->fbo);
        s->free = true;
        s->relFd = -1;
        const EGLAttrib ia[] = { EGL_GL_TEXTURE_LEVEL, 0, EGL_NONE };
        s->img = eglCreateImage(g_dpy, g_ctx, EGL_GL_TEXTURE_2D, (EGLClientBuffer)(uintptr_t)s->tex, ia);
        if (s->img == EGL_NO_IMAGE)
            die("eglCreateImage(EGL_GL_TEXTURE_2D)");
        int fourcc = 0, nplanes = 0;
        EGLuint64KHR mods[4] = { 0 };
        if (!p_exportQuery(g_dpy, s->img, &fourcc, &nplanes, mods))
            die("eglExportDMABUFImageQueryMESA");
        if (nplanes < 1 || nplanes > 4)
            die("unexpected plane count");
        int fds[4] = { -1, -1, -1, -1 };
        EGLint strides[4] = { 0 }, offsets[4] = { 0 };
        if (!p_export(g_dpy, s->img, fds, strides, offsets))
            die("eglExportDMABUFImageMESA");
        struct msg m = { .type = MSG_BUFFER, .slot = (uint32_t)i, .width = FRAME_W, .height = FRAME_H,
                         .fourcc = (uint32_t)fourcc, .nplanes = (uint32_t)nplanes, .modifier = mods[0] };
        // NVIDIA may hand back the same fd for every plane; send each plane's fd (dup'd by SCM_RIGHTS anyway)
        int nfds = 0, sendfds[4];
        for (int p = 0; p < nplanes; p++) {
            m.stride[p] = (uint32_t)strides[p];
            m.offset[p] = (uint32_t)offsets[p];
            sendfds[nfds++] = fds[p] >= 0 ? fds[p] : fds[0];
        }
        m.nfds = (uint32_t)nfds;
        LOG("slot %d: tex %u -> dmabuf fourcc %.4s (0x%08x) planes %d modifier 0x%016llx stride %d offset %d fd %d\n",
            i, s->tex, (char *)&fourcc, fourcc, nplanes, (unsigned long long)mods[0], strides[0], offsets[0], fds[0]);
        if (send_msg(g_sock, &m, sendfds, nfds) < 0)
            die("send MSG_BUFFER");
        for (int p = 0; p < nplanes; p++)
            if (fds[p] >= 0 && (p == 0 || fds[p] != fds[0]))
                close(fds[p]);
    }
}

// shm mode: 2 render targets + 2 pack PBOs pipelined (read back frame n while n+1 renders), RING memfd frames
static GLuint g_rt[2], g_rtFbo[2], g_pbo[2];

static void setup_shm_ring(void) {
    int fd = memfd_create("lp-dmabuf-spike-shm", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, (off_t)(FRAME_BYTES * RING)) < 0)
        die("memfd");
    g_shm = mmap(NULL, FRAME_BYTES * RING, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (g_shm == MAP_FAILED)
        die("mmap");
    for (int i = 0; i < RING; i++) {
        g_slots[i].free = true;
        g_slots[i].relFd = -1;
    }
    for (int i = 0; i < 2; i++) {
        g_rt[i] = make_target(&g_rtFbo[i]);
        glGenBuffers(1, &g_pbo[i]);
        glBindBuffer(GL_PIXEL_PACK_BUFFER, g_pbo[i]);
        glBufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr)FRAME_BYTES, NULL, GL_STREAM_READ);
    }
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    struct msg m = { .type = MSG_SHM, .width = FRAME_W, .height = FRAME_H, .shm_size = FRAME_BYTES * RING, .nfds = 1 };
    if (send_msg(g_sock, &m, &fd, 1) < 0)
        die("send MSG_SHM");
    close(fd);
    LOG("shm ring: memfd %zu bytes (%d x %zu)\n", FRAME_BYTES * RING, RING, FRAME_BYTES);
}

// ---------------------------------------------------------------------------------------------------------------
int main(int argc, char **argv) {
    bool dump = false;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--fd") && i + 1 < argc)
            g_sock = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--mode") && i + 1 < argc)
            g_mode = parse_mode(argv[++i]);
        else if (!strcmp(argv[i], "--fps") && i + 1 < argc)
            g_fps = atof(argv[++i]);
        else if (!strcmp(argv[i], "--dump-ext"))
            dump = true;
        else {
            fprintf(stderr, "usage: producer --fd N --mode fence|finish|shm|nosync [--fps 144] | --dump-ext\n");
            return 1;
        }
    }
    egl_init(dump);
    if (dump)
        return 0;
    if (g_sock < 0 || g_mode < 0) {
        fprintf(stderr, "producer: --fd and a valid --mode are required\n");
        return 1;
    }
    if ((g_mode == MODE_FENCE || g_mode == MODE_FDPOLL) && !p_dupFence)
        die("eglDupNativeFenceFDANDROID missing");
    gl_init();
    if (getenv("LP_SPIKE_WORK"))
        g_work = atoi(getenv("LP_SPIKE_WORK"));
    if (g_work) { // measure the synthetic GPU time per frame once
        GLuint fbo, tex = make_target(&fbo);
        render(fbo, 1);
        glFinish();
        int64_t t0 = now_ns();
        for (int i = 0; i < 10; i++)
            render(fbo, 1);
        glFinish();
        LOG("synthetic GPU load LP_SPIKE_WORK=%d: %.3f ms GPU per frame\n", g_work, (now_ns() - t0) / 10 / 1e6);
        glDeleteFramebuffers(1, &fbo);
        glDeleteTextures(1, &tex);
    }
    if (g_mode == MODE_SHM)
        setup_shm_ring();
    else
        setup_dmabuf_ring();
    glFinish();

    // wait for START (the consumer has imported everything)
    struct msg m;
    int fds[4], nfds;
    for (;;) {
        if (recv_msg(g_sock, &m, fds, &nfds, true) < 0)
            die("socket closed before START");
        if (m.type == MSG_START)
            break;
        handle_msg(&m, fds, nfds);
    }
    g_winBegin = m.t_ns;
    g_winEnd = m.t2_ns;
    LOG("mode %s, %.1f fps, window [%+.3f s, %+.3f s] from now\n", mode_names[g_mode], g_fps,
        (g_winBegin - now_ns()) / 1e9, (g_winEnd - now_ns()) / 1e9);

    const int64_t period = (int64_t)(1e9 / g_fps + 0.5);
    const int64_t stopAt = g_winEnd + 250 * 1000000LL; // keep feeding a little past the window
    int64_t next = now_ns();
    int64_t cpu0 = 0, wall0 = 0;
    bool inWin = false, winDone = false;
    struct samples submit = { 0 };
    uint64_t n = 1;

    // shm pipeline state: frame waiting in a PBO for readback completion
    struct {
        bool valid;
        uint64_t n;
        int64_t t;
        GLsync fence;
        int idx;
    } pend = { 0 };
    int rtIdx = 0;

    while (!g_eof) {
        struct timespec ts = { next / 1000000000LL, next % 1000000000LL };
        while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL) == EINTR) {
        }
        const int64_t t = now_ns();
        if (t >= stopAt)
            break;
        if (!inWin && !winDone && t >= g_winBegin) {
            inWin = true;
            cpu0 = cpu_ns();
            wall0 = t;
        }
        if (inWin && t >= g_winEnd) {
            g_ps.cpu_ns = cpu_ns() - cpu0;
            g_ps.wall_ns = t - wall0;
            g_ps.threads = thread_count();
            inWin = false;
            winDone = true;
        }

        if (g_mode == MODE_SHM) {
            // render n into one target and queue its readback; then hand over the PREVIOUS frame
            render(g_rtFbo[rtIdx], n);
            glBindBuffer(GL_PIXEL_PACK_BUFFER, g_pbo[rtIdx]);
            glReadPixels(0, 0, FRAME_W, FRAME_H, GL_BGRA, GL_UNSIGNED_BYTE, (void *)0);
            GLsync f = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
            glFlush();
            if (pend.valid) {
                glClientWaitSync(pend.fence, GL_SYNC_FLUSH_COMMANDS_BIT, 100 * 1000000ULL);
                glDeleteSync(pend.fence);
                bool pendInWin = pend.t >= g_winBegin && pend.t < g_winEnd;
                int si = acquire_slot(pendInWin);
                if (si < 0)
                    break;
                glBindBuffer(GL_PIXEL_PACK_BUFFER, g_pbo[pend.idx]);
                const void *src = glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0, (GLsizeiptr)FRAME_BYTES, GL_MAP_READ_BIT);
                if (!src)
                    die("glMapBufferRange(pack PBO)");
                memcpy(g_shm + (size_t)si * FRAME_BYTES, src, FRAME_BYTES);
                glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
                struct msg fm = { .type = MSG_FRAME, .slot = (uint32_t)si, .n = pend.n, .t_ns = pend.t };
                fm.t2_ns = now_ns();
                if (send_msg(g_sock, &fm, NULL, 0) < 0)
                    break;
                if (pendInWin) {
                    g_ps.frames++;
                    samples_push(&submit, fm.t2_ns - pend.t);
                }
            }
            glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
            pend.valid = true;
            pend.n = n;
            pend.t = t;
            pend.fence = f;
            pend.idx = rtIdx;
            rtIdx ^= 1;
        } else {
            bool frameInWin = t >= g_winBegin && t < g_winEnd;
            int si = acquire_slot(frameInWin);
            if (si < 0)
                break;
            struct slot *s = &g_slots[si];
            const int64_t tr = now_ns(); // producer timestamp = render start (after any slot wait)
            wait_release(s, frameInWin);
            render(s->fbo, n);
            int fenceFd = -1;
            if (g_mode == MODE_FENCE)
                fenceFd = make_fence_fd();
            else if (g_mode == MODE_FINISH)
                glFinish();
            else if (g_mode == MODE_FDPOLL) { // wait for our own GPU work in the kernel, then hand over
                int fd = make_fence_fd();
                struct pollfd p = { fd, POLLIN, 0 };
                poll(&p, 1, 1000);
                close(fd);
            }
            else
                glFlush(); // MODE_NOSYNC: submitted, but nobody waits for completion
            struct msg fm = { .type = MSG_FRAME, .slot = (uint32_t)si, .n = n, .t_ns = tr };
            fm.nfds = fenceFd >= 0 ? 1 : 0;
            fm.t2_ns = now_ns();
            int r = send_msg(g_sock, &fm, &fenceFd, fenceFd >= 0 ? 1 : 0);
            if (fenceFd >= 0)
                close(fenceFd);
            if (r < 0)
                break;
            if (frameInWin) {
                g_ps.frames++;
                samples_push(&submit, fm.t2_ns - tr);
            }
        }
        n++;

        next += period;
        const int64_t late = now_ns() - next;
        if (late > 0) { // missed one or more ticks: skip them (never render a burst)
            int64_t k = late / period + 1;
            if (inWin)
                g_ps.missed_ticks += (uint64_t)k;
            next += k * period;
        }
    }
    if (!winDone) {
        g_ps.cpu_ns = cpu_ns() - cpu0;
        g_ps.wall_ns = now_ns() - wall0;
        g_ps.threads = thread_count();
    }
    samples_sort(&submit);
    g_ps.submit_p50_ns = samples_pct(&submit, 50);
    g_ps.submit_p99_ns = samples_pct(&submit, 99);
    g_ps.submit_max_ns = submit.n ? submit.v[submit.n - 1] : -1;

    struct msg sm = { .type = MSG_STATS, .ps = g_ps };
    send_msg(g_sock, &sm, NULL, 0);
    LOG("done: %llu frames in window, cpu %.2f%%, missed ticks %llu, slot stalls %llu, submit p50 %.3f ms p99 %.3f "
        "ms\n",
        (unsigned long long)g_ps.frames, g_ps.wall_ns ? 100.0 * g_ps.cpu_ns / g_ps.wall_ns : 0.0,
        (unsigned long long)g_ps.missed_ticks, (unsigned long long)g_ps.slot_stalls, g_ps.submit_p50_ns / 1e6,
        g_ps.submit_p99_ns / 1e6);

    // wait for the consumer to hang up, then tear down
    while (!g_eof) {
        struct pollfd p = { g_sock, POLLIN, 0 };
        if (poll(&p, 1, 5000) <= 0)
            break;
        drain();
    }
    for (int i = 0; i < RING; i++) {
        if (g_slots[i].img)
            eglDestroyImage(g_dpy, g_slots[i].img);
        if (g_slots[i].relFd >= 0)
            close(g_slots[i].relFd);
    }
    eglMakeCurrent(g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroyContext(g_dpy, g_ctx);
    eglTerminate(g_dpy);
    return 0;
}
