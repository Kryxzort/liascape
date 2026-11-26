// A FAKE steamclient.so for scripts/test-steam-signin.sh — what Helpers/SteamClientUgc.cs calls, playing the Steam
// client's part with real C++-shaped objects (first word = a vtable; only the slots the helper uses are filled):
// ISteamClient "SteamClient020" CreateSteamPipe 0, BReleaseSteamPipe 1, ConnectToGlobalUser 2, ReleaseUser 4,
// GetISteamGenericInterface 12; ISteamUGC "STEAMUGC_INTERFACE_VERSION018" SubscribeItem 68, UnsubscribeItem 69, GetItemState 72,
// GetItemInstallInfo 73, GetItemDownloadInfo 74, DownloadItem 75. SubscribeItem → "subscribed" at once, "downloading" with
// bytes climbing over ~1.2 s, then installed in $FAKE_UGC_DIR/<id> (project.json + v.mp4 copied from $FAKE_UGC_CLIP).
// DownloadItem → the same download without subscribing (the subscribed bit stays as it was). Never talks to Steam.
//   $FAKE_UGC_DIR/template-<id>/ exists → that item installs as a copy of it instead (a preset, a scene) of the video,
//   over the files of a folder already there when $FAKE_UGC_DIR/refetch-<id> exists (removed once installed)
//   $FAKE_UGC_DIR/refuse-download exists → DownloadItem returns false for an item that isn't subscribed
//   $FAKE_UGC_DIR/downloads ← a line "<id>" per DownloadItem Steam took
//   $FAKE_UGC_DIR/fail-init exists → ConnectToGlobalUser returns 0 (Steam not running / WE not owned)
//   $FAKE_UGC_DIR/hold-install exists → a download stays at 50 % until it's removed (its helper keeps the one Steam-client turn)
//   $FAKE_UGC_DIR/calls ← a line "subscribe <id>" / "unsubscribe <id>" per SubscribeItem / UnsubscribeItem Steam took
//   $FAKE_UGC_DIR/hang-once exists → the next GetItemState removes it, writes a line to $FAKE_UGC_DIR/hung and never returns
//   (a hung library: the parent's ping of a held child gets no answer)
//   $FAKE_UGC_DIR/hold-unsub exists → UnsubscribeItem writes $FAKE_UGC_DIR/unsub-held and waits until it's removed, then unsubscribes
//   $FAKE_UGC_OPEN_DELAY_MS (env) → every helper takes that long to connect (CreateInterface): a loaded or cold machine, where
//   starting a helper takes seconds, made repeatable (a rerun of the suite with it shows which waits assume a fast helper)
//   SteamAppId must be 431960 (the helper sets it in its child only) — else ConnectToGlobalUser returns 0
//   The account and its favourites (the `steamid` / `favorites` commands): "SteamUser021" BLoggedOn 1, GetSteamID 2 (76561190000000042,
//   or $FAKE_UGC_DIR/steamid's number); "SteamUtils010" IsAPICallCompleted 11, GetAPICallResult 13 (a 280-byte
//   SteamUGCQueryCompleted_t, callback 3401, nothing else); ISteamUGC CreateQueryUserUGCRequest 0 (the account's own id, the
//   favourited list, Wallpaper Engine as creator and consumer app, else an invalid handle), SendQueryUGCRequest 4,
//   GetQueryUGCResult 5, ReleaseQueryUGCRequest 19, SetReturnOnlyIDs 23. The favourites: $FAKE_UGC_DIR/favorites, an id a
//   line, 50 a page.
//   $FAKE_UGC_DIR/offline exists → BLoggedOn false; $FAKE_UGC_DIR/query-fail exists → every query answers EResult 2
//   $FAKE_UGC_DIR/queries ← a line "<pid> <page> <unix s>" per query sent; $FAKE_UGC_DIR/queries-released ← a line per handle released
//   $FAKE_UGC_DIR/child.pid ← the caller's pid; $FAKE_UGC_DIR/released ← a line per pipe released
//   $FAKE_UGC_DIR/sub-<id> = subscribed (a file: each helper run is a NEW process — an unsubscribe run must see what an
//   earlier download subscribed); UnsubscribeItem deletes it
//   $FAKE_UGC_DIR/helpers.log ← "start <pid> <unix s>" (CreateInterface called), "open <pid> <unix s>" (it returned), "use <pid>"
//   (Subscribe/Unsubscribe/DownloadItem), "close <pid> <unix s>" (BReleaseSteamPipe) — the test checks that no two
//   subscribe/unsubscribe helpers were connected at once
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
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
static void *client_vt[32], *ugc_vt[80], *user_vt[8], *utils_vt[16];
static Obj client = { client_vt }, ugc = { ugc_vt }, user = { user_vt }, utils = { utils_vt };

static void install(uint64_t id) {
  char d[4096], p[4200]; snprintf(d, sizeof d, "%s/%llu", dir(), (unsigned long long)id);
  // installed once; again only while $FAKE_UGC_DIR/refetch-<id> exists (a folder Steam left empty, fetched again: removed
  // once it is)
  char r[4096]; snprintf(r, sizeof r, "%s/refetch-%llu", dir(), (unsigned long long)id);
  struct stat st; if (stat(d, &st) == 0 && stat(r, &st) != 0) return;
  unlink(r);
  char t[4096]; snprintf(t, sizeof t, "%s/template-%llu", dir(), (unsigned long long)id);
  if (stat(t, &st) == 0 && S_ISDIR(st.st_mode)) {
    // cp -RT <template> <d>: d becomes the copy (files/ and all); a d already there (a download Steam left empty, fetched
    // again) gets the template's files over its own, as Steam rewrites an item in place
    pid_t c = fork();
    if (c == 0) { execlp("cp", "cp", "-RT", t, d, (char *)NULL); _exit(127); }
    if (c > 0) { int rc; waitpid(c, &rc, 0); }
    return;
  }
  mkdir(d, 0755);
  snprintf(p, sizeof p, "%s/project.json", d); FILE *f = fopen(p, "w");
  if (f) { fprintf(f, "{\"type\":\"video\",\"file\":\"v.mp4\",\"title\":\"ws-%llu\"}", (unsigned long long)id); fclose(f); }
  const char *clip = getenv("FAKE_UGC_CLIP");
  if (clip) { snprintf(p, sizeof p, "%s/v.mp4", d); FILE *a = fopen(clip, "rb"), *b = fopen(p, "wb");
    if (a && b) { char buf[65536]; size_t n; while ((n = fread(buf, 1, sizeof buf, a)) > 0) fwrite(buf, 1, n, b); }
    if (a) fclose(a); if (b) fclose(b); }
}
static bool exists(const char *file) { char p[4096]; snprintf(p, sizeof p, "%s/%s", dir(), file); return access(p, F_OK) == 0; }
static double frac(uint64_t id) {
  if (t_sub < 0 || id != sub_id) return -1; double e = now() - t_sub - 0.3;
  if (exists("hold-install") && e > 0.6) e = 0.6;
  return e < 0 ? 0 : e > 1.2 ? 1 : e / 1.2;
}

static int32_t create_pipe(Obj *s) { (void)s; return 7; }
static bool release_pipe(Obj *s, int32_t pipe) { (void)s; (void)pipe; note("released", "pipe\n"); helper_log("close", 1); return true; }
static int32_t connect_user(Obj *s, int32_t pipe) {
  (void)s; (void)pipe; char p[4096]; snprintf(p, sizeof p, "%s/fail-init", dir());
  if (access(p, F_OK) == 0) return 0;
  const char *app = getenv("SteamAppId"); if (!app || strcmp(app, "431960") != 0) return 0;
  return 3;
}
static void release_user(Obj *s, int32_t pipe, int32_t user) { (void)s; (void)pipe; (void)user; note("released", "user\n"); }
static void *generic(Obj *s, int32_t u, int32_t pipe, const char *ver) {
  (void)s; if (u != 3 || pipe != 7) return NULL;
  if (strcmp(ver, "STEAMUGC_INTERFACE_VERSION018") == 0) return &ugc;
  if (strcmp(ver, "SteamUser021") == 0) return &user;
  if (strcmp(ver, "SteamUtils010") == 0) return &utils;
  return NULL;
}

// ---- the account and its favourites ----
static uint64_t steam_id(void) {
  char p[4096]; snprintf(p, sizeof p, "%s/steamid", dir()); FILE *f = fopen(p, "r"); unsigned long long v = 0;
  if (f) { if (fscanf(f, "%llu", &v) != 1) v = 0; fclose(f); }
  return v ? (uint64_t)v : 76561190000000042ULL;
}
static bool logged_on(Obj *s) { (void)s; return !exists("offline"); }
static uint64_t get_steamid(Obj *s) { (void)s; return steam_id(); }
#define MAXFAV 4096
static uint64_t favs[MAXFAV]; static int nfav;
static void read_favs(void) {
  char p[4096]; snprintf(p, sizeof p, "%s/favorites", dir()); FILE *f = fopen(p, "r"); nfav = 0;
  if (!f) return; unsigned long long v; while (nfav < MAXFAV && fscanf(f, "%llu", &v) == 1) favs[nfav++] = v; fclose(f);
}
static uint32_t q_page; // the one query in flight (the helper sends one at a time)
static uint64_t create_user_query(Obj *s, uint32_t account, int list, int matching, int sort, uint32_t creator, uint32_t consumer, uint32_t page) {
  (void)s; (void)matching; (void)sort;
  if (account != (uint32_t)(steam_id() & 0xffffffffu) || list != 5 || creator != 431960 || consumer != 431960 || page == 0) return ~0ULL;
  q_page = page; read_favs();
  char line[96]; snprintf(line, sizeof line, "%d %u %.3f\n", getpid(), page, wall()); note("queries", line);
  return 0x5000 + page;
}
static bool set_only_ids(Obj *s, uint64_t h, bool on) { (void)s; (void)h; (void)on; return true; }
static uint64_t send_query(Obj *s, uint64_t h) { (void)s; return h == 0x5000 + q_page ? h + 0x1000 : 0; }
static bool call_done(Obj *s, uint64_t call, bool *failed) { (void)s; (void)call; *failed = false; return true; }
static bool call_result(Obj *s, uint64_t call, void *out, int size, int expected, bool *failed) {
  (void)s; if (size != 280 || expected != 3401 || call != 0x6000 + q_page) { *failed = true; return false; }
  memset(out, 0, (size_t)size); char *b = out; uint64_t h = 0x5000 + q_page; memcpy(b, &h, 8);
  int32_t er = exists("query-fail") ? 2 : 1; int first = (int)(q_page - 1) * 50;
  uint32_t n = first >= nfav ? 0 : (uint32_t)(nfav - first < 50 ? nfav - first : 50), total = (uint32_t)nfav;
  memcpy(b + 8, &er, 4); memcpy(b + 12, &n, 4); memcpy(b + 16, &total, 4);
  *failed = false; return true;
}
static bool query_result(Obj *s, uint64_t h, uint32_t i, void *details) {
  (void)s; int k = (int)(q_page - 1) * 50 + (int)i; if (h != 0x5000 + q_page || k >= nfav || i >= 50) return false;
  memcpy(details, &favs[k], 8); return true;
}
static bool release_query(Obj *s, uint64_t h) { (void)s; (void)h; note("queries-released", "x\n"); return true; }
static void subfile(uint64_t id, char *p, size_t n) { snprintf(p, n, "%s/sub-%llu", dir(), (unsigned long long)id); }
static uint64_t subscribe(Obj *s, uint64_t id) {
  (void)s; helper_log("use", 0); sub_id = id; t_sub = now(); char p[4096]; subfile(id, p, sizeof p); FILE *f = fopen(p, "w"); if (f) fclose(f);
  char line[48]; snprintf(line, sizeof line, "subscribe %llu\n", (unsigned long long)id); note("calls", line); return 1;
}
static uint64_t unsubscribe(Obj *s, uint64_t id) {
  (void)s; helper_log("use", 0);
  if (exists("hold-unsub")) { note("unsub-held", "x\n"); while (exists("hold-unsub")) usleep(50000); }
  char p[4096]; subfile(id, p, sizeof p); unlink(p); if (id == sub_id) t_sub = -1; note("unsubscribed", "x\n");
  char line[48]; snprintf(line, sizeof line, "unsubscribe %llu\n", (unsigned long long)id); note("calls", line); return 2;
}
static uint32_t item_state(Obj *s, uint64_t id) {
  if (exists("hang-once")) {
    char h[4096]; snprintf(h, sizeof h, "%s/hang-once", dir()); unlink(h); note("hung", "x\n");
    for (;;) pause();
  }
  (void)s; double f = frac(id); char p[4096]; subfile(id, p, sizeof p);
  uint32_t sub = access(p, F_OK) == 0 ? 1 : 0;
  if (f < 0) return sub ? (1 | 4) : 0; // subscribed by an earlier run
  if (f >= 1) { install(id); return sub | 4; }
  return sub | 8 | 16;
}
static bool download_item(Obj *s, uint64_t id, bool high) {
  (void)s; (void)high; helper_log("use", 0);
  char p[4096], sp[4096]; snprintf(p, sizeof p, "%s/refuse-download", dir()); subfile(id, sp, sizeof sp);
  if (access(p, F_OK) == 0 && access(sp, F_OK) != 0) return false;
  sub_id = id; t_sub = now();
  char line[32]; snprintf(line, sizeof line, "%llu\n", (unsigned long long)id); note("downloads", line);
  return true;
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
  helper_log("start", 1);
  const char *slow = getenv("FAKE_UGC_OPEN_DELAY_MS"); if (slow && atoi(slow) > 0) usleep((useconds_t)atoi(slow) * 1000);
  client_vt[0] = (void *)create_pipe; client_vt[1] = (void *)release_pipe; client_vt[2] = (void *)connect_user;
  client_vt[4] = (void *)release_user; client_vt[12] = (void *)generic;
  ugc_vt[68] = (void *)subscribe; ugc_vt[69] = (void *)unsubscribe; ugc_vt[72] = (void *)item_state; ugc_vt[73] = (void *)install_info; ugc_vt[74] = (void *)download_info;
  ugc_vt[75] = (void *)download_item;
  ugc_vt[0] = (void *)create_user_query; ugc_vt[4] = (void *)send_query; ugc_vt[5] = (void *)query_result; ugc_vt[19] = (void *)release_query;
  ugc_vt[23] = (void *)set_only_ids;
  user_vt[1] = (void *)logged_on; user_vt[2] = (void *)get_steamid; utils_vt[11] = (void *)call_done; utils_vt[13] = (void *)call_result;
  helper_log("open", 1);
  char pid[32]; snprintf(pid, sizeof pid, "%d\n", getpid());
  char p[4096]; snprintf(p, sizeof p, "%s/child.pid", dir()); FILE *f = fopen(p, "w"); if (f) { fputs(pid, f); fclose(f); }
  return &client;
}
bool Steam_BGetCallback(int32_t pipe, void *msg) { (void)pipe; (void)msg; return false; }
bool Steam_FreeLastCallback(int32_t pipe) { (void)pipe; return true; }
