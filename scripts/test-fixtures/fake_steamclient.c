// A FAKE steamclient.so for scripts/test-steam-signin.sh — what Helpers/SteamClientUgc.cs calls, playing the Steam
// client's part with real C++-shaped objects (first word = a vtable; only the slots the helper uses are filled):
// ISteamClient "SteamClient020" CreateSteamPipe 0, BReleaseSteamPipe 1, ConnectToGlobalUser 2, ReleaseUser 4,
// GetISteamGenericInterface 12; ISteamUGC "STEAMUGC_INTERFACE_VERSION018" SubscribeItem 68, UnsubscribeItem 69, GetItemState 72,
// GetItemInstallInfo 73, GetItemDownloadInfo 74. SubscribeItem → "subscribed" at once, "downloading" with bytes climbing
// over ~1.2 s, then installed in $FAKE_UGC_DIR/<id> (project.json + v.mp4 copied from $FAKE_UGC_CLIP). Never talks to Steam.
//   $FAKE_UGC_DIR/fail-init exists → ConnectToGlobalUser returns 0 (Steam not running / WE not owned)
//   SteamAppId must be 431960 (the helper sets it in its child only) — else ConnectToGlobalUser returns 0
//   $FAKE_UGC_DIR/child.pid ← the caller's pid; $FAKE_UGC_DIR/released ← a line per pipe released
//   $FAKE_UGC_DIR/sub-<id> = subscribed (a file: each helper run is a NEW process — an unsubscribe run must see what an
//   earlier download subscribed); UnsubscribeItem deletes it
//   $FAKE_UGC_DIR/helpers.log ← "open <pid> <unix s>" (CreateInterface), "use <pid>" (Subscribe/UnsubscribeItem), "close <pid>
//   <unix s>" (BReleaseSteamPipe) — the test checks that no two subscribe/unsubscribe helpers were connected at once
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static double t_sub = -1; static uint64_t sub_id;
static const uint64_t TOTAL = 4000000;
static double now(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec / 1e9; }
static const char *dir(void) { const char *d = getenv("FAKE_UGC_DIR"); return d ? d : "/nonexistent"; }
static double wall(void) { struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); return ts.tv_sec + ts.tv_nsec / 1e9; }
static void helper_log(const char *what, int stamp) {
  char line[96]; if (stamp) snprintf(line, sizeof line, "%s %d %.3f\n", what, getpid(), wall()); else snprintf(line, sizeof line, "%s %d\n", what, getpid());
  char p[4096]; snprintf(p, sizeof p, "%s/helpers.log", getenv("FAKE_UGC_DIR") ? getenv("FAKE_UGC_DIR") : "/nonexistent");
  FILE *f = fopen(p, "a"); if (f) { fputs(line, f); fclose(f); }
}
static void note(const char *file, const char *text) { char p[4096]; snprintf(p, sizeof p, "%s/%s", dir(), file); FILE *f = fopen(p, "a"); if (f) { fputs(text, f); fclose(f); } }

typedef struct { void **vt; } Obj;
static void *client_vt[32], *ugc_vt[80];
static Obj client = { client_vt }, ugc = { ugc_vt };

static void install(uint64_t id) {
  char d[4096], p[4200]; snprintf(d, sizeof d, "%s/%llu", dir(), (unsigned long long)id);
  struct stat st; if (stat(d, &st) == 0) return;
  mkdir(d, 0755);
  snprintf(p, sizeof p, "%s/project.json", d); FILE *f = fopen(p, "w");
  if (f) { fprintf(f, "{\"type\":\"video\",\"file\":\"v.mp4\",\"title\":\"ws-%llu\"}", (unsigned long long)id); fclose(f); }
  const char *clip = getenv("FAKE_UGC_CLIP");
  if (clip) { snprintf(p, sizeof p, "%s/v.mp4", d); FILE *a = fopen(clip, "rb"), *b = fopen(p, "wb");
    if (a && b) { char buf[65536]; size_t n; while ((n = fread(buf, 1, sizeof buf, a)) > 0) fwrite(buf, 1, n, b); }
    if (a) fclose(a); if (b) fclose(b); }
}
static double frac(uint64_t id) { if (t_sub < 0 || id != sub_id) return -1; double e = now() - t_sub - 0.3; return e < 0 ? 0 : e > 1.2 ? 1 : e / 1.2; }

static int32_t create_pipe(Obj *s) { (void)s; return 7; }
static bool release_pipe(Obj *s, int32_t pipe) { (void)s; (void)pipe; note("released", "pipe\n"); helper_log("close", 1); return true; }
static int32_t connect_user(Obj *s, int32_t pipe) {
  (void)s; (void)pipe; char p[4096]; snprintf(p, sizeof p, "%s/fail-init", dir());
  if (access(p, F_OK) == 0) return 0;
  const char *app = getenv("SteamAppId"); if (!app || strcmp(app, "431960") != 0) return 0;
  return 3;
}
static void release_user(Obj *s, int32_t pipe, int32_t user) { (void)s; (void)pipe; (void)user; note("released", "user\n"); }
static void *generic(Obj *s, int32_t user, int32_t pipe, const char *ver) {
  (void)s; return user == 3 && pipe == 7 && strcmp(ver, "STEAMUGC_INTERFACE_VERSION018") == 0 ? &ugc : NULL;
}
static void subfile(uint64_t id, char *p, size_t n) { snprintf(p, n, "%s/sub-%llu", dir(), (unsigned long long)id); }
static uint64_t subscribe(Obj *s, uint64_t id) {
  (void)s; helper_log("use", 0); sub_id = id; t_sub = now(); char p[4096]; subfile(id, p, sizeof p); FILE *f = fopen(p, "w"); if (f) fclose(f); return 1;
}
static uint64_t unsubscribe(Obj *s, uint64_t id) {
  (void)s; helper_log("use", 0); char p[4096]; subfile(id, p, sizeof p); unlink(p); if (id == sub_id) t_sub = -1; note("unsubscribed", "x\n"); return 2;
}
static uint32_t item_state(Obj *s, uint64_t id) {
  (void)s; double f = frac(id);
  if (f < 0) { char p[4096]; subfile(id, p, sizeof p); return access(p, F_OK) == 0 ? (1 | 4) : 0; } // subscribed by an earlier run
  if (f >= 1) { install(id); return 1 | 4; }
  return 1 | 8 | 16;
}
static bool download_info(Obj *s, uint64_t id, uint64_t *done, uint64_t *total) {
  (void)s; double f = frac(id); if (f < 0 || f >= 1) { *done = *total = 0; return f >= 1; }
  *total = TOTAL; *done = (uint64_t)(TOTAL * f); return true;
}
static bool install_info(Obj *s, uint64_t id, uint64_t *size, char *folder, uint32_t n, uint32_t *ts) {
  (void)s; if (frac(id) < 1) return false;
  snprintf(folder, n, "%s/%llu", dir(), (unsigned long long)id); *size = TOTAL; *ts = 0; return true;
}

void *CreateInterface(const char *ver, int *ret) {
  (void)ret;
  if (strcmp(ver, "SteamClient020") != 0) return NULL;
  client_vt[0] = (void *)create_pipe; client_vt[1] = (void *)release_pipe; client_vt[2] = (void *)connect_user;
  client_vt[4] = (void *)release_user; client_vt[12] = (void *)generic;
  ugc_vt[68] = (void *)subscribe; ugc_vt[69] = (void *)unsubscribe; ugc_vt[72] = (void *)item_state; ugc_vt[73] = (void *)install_info; ugc_vt[74] = (void *)download_info;
  helper_log("open", 1);
  char pid[32]; snprintf(pid, sizeof pid, "%d\n", getpid());
  char p[4096]; snprintf(p, sizeof p, "%s/child.pid", dir()); FILE *f = fopen(p, "w"); if (f) { fputs(pid, f); fclose(f); }
  return &client;
}
bool Steam_BGetCallback(int32_t pipe, void *msg) { (void)pipe; (void)msg; return false; }
bool Steam_FreeLastCallback(int32_t pipe) { (void)pipe; return true; }
