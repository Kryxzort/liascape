// Spike (throwaway): shared wire protocol + helpers for the worker -> compositor GPU frame-sharing spike.
// producer.c = the worker (surfaceless EGL, desktop GL 3.3 core), consumer.c = the compositor stand-in
// (layer-shell surface on one output). They talk over a SOCK_SEQPACKET socketpair; fds ride SCM_RIGHTS.
#pragma once
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

#define FRAME_W 1920
#define FRAME_H 1080
#define FRAME_BYTES ((size_t)FRAME_W * FRAME_H * 4)
#define RING 3     // buffers in flight between worker and compositor
#define CORNER 64  // top-left CORNERxCORNER block = frame counter n
#define PROBE 16   // bottom-right PROBExPROBE block = gradient(n), checked exactly (catches torn/stale frames)

// fence  : dmabuf + EGL_ANDROID_native_fence_sync acquire fence (worker->compositor) and release fence back
// finish : dmabuf, worker glFinish()es before handing the buffer over; compositor releases on a local GL fence
// shm    : CPU copy: glReadPixels -> PBO -> memfd ring -> glTexSubImage2D (no GPU buffer sharing at all)
// nosync : dmabuf with NO acquire sync at all (glFlush only) -- negative control that proves the checks bite
// local  : consumer only, no worker: one static texture redrawn per vblank -- baseline cost of presenting itself
// fdpoll : dmabuf, CPU-side handshake WITHOUT glFinish: the worker poll()s its own sync_file (kernel wait, no
//          spinning) and hands over only completed frames; no fence crosses the process boundary
enum mode { MODE_FENCE, MODE_FINISH, MODE_SHM, MODE_NOSYNC, MODE_LOCAL, MODE_FDPOLL, MODE__COUNT };
static const char *const mode_names[] = { "fence", "finish", "shm", "nosync", "local", "fdpoll" };
static inline int parse_mode(const char *s) {
    for (int i = 0; i < MODE__COUNT; i++)
        if (!strcmp(s, mode_names[i]))
            return i;
    return -1;
}

enum msg_type {
    MSG_BUFFER = 1, // producer->consumer, once per ring slot: dmabuf plane fd(s) + layout (import once)
    MSG_SHM,        // producer->consumer, once: memfd holding RING frames (shm mode)
    MSG_START,      // consumer->producer: start rendering; t_ns/t2_ns = measurement window [begin, end)
    MSG_FRAME,      // producer->consumer: slot holds frame n; optional acquire fence fd
    MSG_RELEASE,    // consumer->producer: slot free again; optional release fence fd
    MSG_STATS,      // producer->consumer: producer-side measurements over the window
};

struct prod_stats {
    uint64_t frames;       // frames rendered whose timestamp falls in the window
    uint64_t missed_ticks; // 1/fps ticks skipped because the producer was late
    uint64_t slot_stalls;  // ticks where no ring slot was free (waited for a RELEASE)
    int64_t stall_ns_total, stall_ns_max;
    int64_t cpu_ns, wall_ns; // getrusage(RUSAGE_SELF) user+sys over the window (all threads incl. driver)
    int64_t submit_p50_ns, submit_p99_ns, submit_max_ns; // render start -> FRAME sent (CPU-side)
    uint64_t release_fence_fail;
    uint64_t release_fence_unsignaled; // release fence not yet signaled when the slot was reused
    int32_t threads;
};

struct msg {
    uint32_t type, slot;
    uint64_t n;
    int64_t t_ns;  // FRAME: producer timestamp (CLOCK_MONOTONIC at render start); START: window begin
    int64_t t2_ns; // FRAME: time the message was sent; START: window end
    uint32_t nfds;
    uint32_t width, height, fourcc, nplanes;
    uint32_t stride[4], offset[4];
    uint64_t modifier;
    uint64_t shm_size;
    struct prod_stats ps;
};

static inline int64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static inline int64_t cpu_ns(void) {
    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    return ((int64_t)ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000000000LL
           + ((int64_t)ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) * 1000LL;
}

static inline int thread_count(void) {
    FILE *f = fopen("/proc/self/status", "r");
    char line[256];
    int n = -1;
    if (!f)
        return -1;
    while (fgets(line, sizeof line, f))
        if (!strncmp(line, "Threads:", 8))
            n = atoi(line + 8);
    fclose(f);
    return n;
}

static inline bool has_ext(const char *list, const char *ext) {
    if (!list)
        return false;
    const size_t n = strlen(ext);
    for (const char *p = list; (p = strstr(p, ext)); p += n)
        if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == 0))
            return true;
    return false;
}

static inline int send_msg(int sock, const struct msg *m, const int *fds, int nfds) {
    struct iovec iov = { (void *)m, sizeof *m };
    union {
        char buf[CMSG_SPACE(sizeof(int) * 4)];
        struct cmsghdr align;
    } u;
    struct msghdr mh = { .msg_iov = &iov, .msg_iovlen = 1 };
    if (nfds > 0) {
        memset(&u, 0, sizeof u);
        mh.msg_control = u.buf;
        mh.msg_controllen = CMSG_SPACE(sizeof(int) * nfds);
        struct cmsghdr *c = CMSG_FIRSTHDR(&mh);
        c->cmsg_level = SOL_SOCKET;
        c->cmsg_type = SCM_RIGHTS;
        c->cmsg_len = CMSG_LEN(sizeof(int) * nfds);
        memcpy(CMSG_DATA(c), fds, sizeof(int) * nfds);
    }
    ssize_t r;
    do
        r = sendmsg(sock, &mh, MSG_NOSIGNAL);
    while (r < 0 && errno == EINTR);
    return r == (ssize_t)sizeof *m ? 0 : -1;
}

// 1 = got a message, 0 = nothing pending (non-blocking), -1 = EOF/error
static inline int recv_msg(int sock, struct msg *m, int *fds, int *nfds, bool block) {
    struct iovec iov = { m, sizeof *m };
    union {
        char buf[CMSG_SPACE(sizeof(int) * 4)];
        struct cmsghdr align;
    } u;
    struct msghdr mh = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = u.buf, .msg_controllen = sizeof u.buf };
    ssize_t r;
    do
        r = recvmsg(sock, &mh, MSG_CMSG_CLOEXEC | (block ? 0 : MSG_DONTWAIT));
    while (r < 0 && errno == EINTR);
    *nfds = 0;
    if (r < 0)
        return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -1;
    if (r == 0)
        return -1;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&mh); c; c = CMSG_NXTHDR(&mh, c))
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
            int k = (int)((c->cmsg_len - CMSG_LEN(0)) / sizeof(int));
            memcpy(fds + *nfds, CMSG_DATA(c), sizeof(int) * k);
            *nfds += k;
        }
    return r == (ssize_t)sizeof *m ? 1 : -1;
}

// growable sample set + percentiles
struct samples {
    int64_t *v;
    size_t n, cap;
};
static inline void samples_push(struct samples *s, int64_t x) {
    if (s->n == s->cap) {
        s->cap = s->cap ? s->cap * 2 : 1024;
        s->v = realloc(s->v, s->cap * sizeof *s->v);
    }
    s->v[s->n++] = x;
}
static inline int cmp_i64(const void *a, const void *b) {
    int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
    return x < y ? -1 : x > y;
}
static inline void samples_sort(struct samples *s) {
    if (s->n)
        qsort(s->v, s->n, sizeof *s->v, cmp_i64);
}
static inline int64_t samples_pct(const struct samples *s, double p) { // call samples_sort first
    if (!s->n)
        return -1;
    size_t i = (size_t)(p / 100.0 * (double)(s->n - 1) + 0.5);
    return s->v[i < s->n ? i : s->n - 1];
}

// The bottom-right probe value, exactly as the producer's fragment shader computes it (integer math).
static inline void grad_rgb(int x, int y, uint64_t n, uint8_t out[3]) {
    int nn = (int)(n & 0xffff);
    out[0] = (uint8_t)((x * 255 / (FRAME_W - 1) + nn) & 255);
    out[1] = (uint8_t)((y * 255 / (FRAME_H - 1) + 2 * nn) & 255);
    out[2] = (uint8_t)(((x + y) / 8 + 3 * nn) & 255);
}

// env -> EGL_IMG_context_priority level (0 = leave the attribute out)
static inline int env_prio(const char *var) {
    const char *v = getenv(var);
    if (!v)
        return 0;
    return !strcmp(v, "high") ? 0x3101 : !strcmp(v, "medium") ? 0x3102 : !strcmp(v, "low") ? 0x3103 : 0;
}
static inline const char *prio_name(int p) {
    return p == 0x3101 ? "high" : p == 0x3102 ? "medium" : p == 0x3103 ? "low" : "?";
}
