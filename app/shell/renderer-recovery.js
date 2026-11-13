// Brings the window's page back when its renderer process dies or hangs (main.js: recoverRenderer(win, pageUrl)).
// Without it a renderer killed under memory pressure (the OOM killer, a per-user thread limit, a crash) leaves the
// window an empty frame until the app is restarted. The backend holds every piece of state, so a reload loses only what
// the page alone kept (scroll offsets, an open panel); the wallpaper keeps playing throughout.
//   gone (any reason but a clean exit): reload after RELOAD_DELAYS_MS[n-1] for the n-th death within CRASH_WINDOW_MS;
//     one more within the window shows a plain notice with a Reload button instead (a page that dies on every load,
//     or a machine too swamped to keep one alive, must not be relaunched forever)
//   unresponsive: Chromium raises it when the page leaves the user's input unanswered for its hang delay (~15 s; never
//     while a DevTools client is attached to the page, a paused debugger looks the same). A page that is
//     only busy answers on its own ("responsive", logged with how long it took); one still frozen HANG_KILL_MS later is
//     ended and goes through the path above — Electron offers no other way out of a hung renderer, its own menu
//     accelerators (Ctrl+R) wait on the renderer too.
// Guard: probe-recover recover:crash, recover:kill, recover:loop, recover:hang, notice:look.
const { authHeaders } = require("./api-auth");

const CRASH_WINDOW_MS = 60_000;
const RELOAD_DELAYS_MS = [1000, 5000];
const HANG_KILL_MS = 20_000;
// the notice page needs a renderer too: if it dies (a machine still out of threads), it is shown again this much later
const NOTICE_RETRY_MS = 10_000;
// the notice's Reload button sets this page title: a data: page can't reach main.js's IPC (isAppUrl refuses it) and
// a fragment change on a data: URL never navigates
const RELOAD_TITLE = "liascape-reload";

const REASONS = {
  oom: "it ran out of memory", killed: "the system ended it", crashed: "it crashed", "abnormal-exit": "it stopped unexpectedly",
  "launch-failed": "it could not start", "memory-eviction": "the system reclaimed its memory", "integrity-failure": "a code integrity check failed",
};

// Index.css's :root defaults (Catppuccin Mocha): the notice when the backend can't tell the theme
const DEFAULT_THEME = {
  bgBase: "#1e1e2e", bgMantle: "#181825", surface0: "#313244", surface1: "#45475a",
  textColor: "#cdd6f4", subtext: "#a6adc8", muted: "#6c7086", accent: "#89b4fa", accentFg: "#11111b",
};

// The user's theme, glow and motion settings from the backend that served the page (?api=<port> under Vite, else the
// page's own origin), so the notice looks like the app it stands in for
async function lookOf(pageUrl) {
  const look = { theme: DEFAULT_THEME, glows: true, morphs: true };
  try {
    const u = new URL(pageUrl);
    const api = u.searchParams.get("api") ? `http://127.0.0.1:${u.searchParams.get("api")}` : u.origin;
    const get = async (p) => (await fetch(api + p, { headers: authHeaders(), signal: AbortSignal.timeout(1500) })).json();
    const [settings, themes] = await Promise.all([get("/settings"), get("/themes")]);
    const name = settings?.theme || themes?.[0]?.name;
    const t = Array.isArray(themes) ? themes.find((x) => x.name === name) ?? themes[0] : null;
    if (t) look.theme = { ...DEFAULT_THEME, ...t };
    look.glows = settings?.glows !== false;
    look.morphs = settings?.morphs !== false;
  } catch { /* backend down or slow: the default look */ }
  return look;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const colour = (s, fallback) => (/^#[0-9a-f]{3,8}$/i.test(String(s)) ? s : fallback);

// A static page, not React: the app's bundle is what keeps dying. It follows the app's design by hand: theme colours,
// the accent button with its glow (none under no-glow), a rise-and-fade appear that is a short fade alone with motion off
// (the "Smooth window animations" setting or prefers-reduced-motion), focus rings only while tabbing.
function noticeHtml(look, gone, count) {
  const t = look.theme, c = (k) => colour(t[k], DEFAULT_THEME[k]);
  const why = REASONS[gone.reason] ?? `it stopped (${gone.reason})`;
  const root = [look.glows ? "" : "no-glow", look.morphs ? "" : "no-motion"].filter(Boolean).join(" ");
  // lucide rotate-cw
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
  return `<!doctype html><html class="${root}" data-renderer-gone="${esc(gone.reason)}"><head><meta charset="utf-8"><title>Liascape</title><style>
:root { --bg-base: ${c("bgBase")}; --bg-mantle: ${c("bgMantle")}; --surface0: ${c("surface0")}; --surface1: ${c("surface1")};
  --text: ${c("textColor")}; --subtext: ${c("subtext")}; --muted: ${c("muted")}; --accent: ${c("accent")}; --accent-fg: ${c("accentFg")};
  --glow-sm: 0 0 12px -2px var(--accent); --glow: 0 0 22px -3px var(--accent), 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
  --spring-soft: linear(0, .048, .167, .32, .483, .638, .773, .882, .966, 1.024, 1.06, 1.078, 1.084, 1.079, 1.069, 1.057, 1.043,
    1.03, 1.019, 1.01, 1.003, .998, .995, .993, .993, .993, .994, .995, .996, .998, 1); --fade-dur: .12s; }
:root.no-glow { --glow-sm: none; --glow: none; }
html, body { margin: 0; height: 100%; }
body { display: grid; place-items: center; background: radial-gradient(120% 120% at 50% 0%, var(--bg-mantle), var(--bg-base) 60%);
  color: var(--text); font: 14px/1.45 Inter, system-ui, sans-serif; user-select: none; -webkit-user-select: none; overflow: hidden; }
.gone { max-width: 440px; padding: 26px 28px 22px; border-radius: 14px; background: var(--surface0); border: 1px solid var(--surface1);
  animation: rise .5s var(--spring-soft) both; }
:root.no-motion .gone { animation: fade var(--fade-dur) ease-out both; }
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
h1 { margin: 0 0 8px; font-size: 17px; font-weight: 700; }
p { margin: 0 0 14px; color: var(--subtext); }
.why { color: var(--muted); font-size: 12.5px; user-select: text; -webkit-user-select: text; }
.btn { display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px; border: 0; border-radius: 8px; font: inherit;
  font-weight: 700; font-size: 13px; cursor: pointer; background: var(--accent); color: var(--accent-fg); box-shadow: var(--glow-sm);
  transition: transform .08s, box-shadow .2s; }
.btn:hover { box-shadow: var(--glow); }
.btn:active { transform: scale(.96); }
:root.no-motion .btn { transition: none; }
:root.no-motion .btn:active { transform: none; }
.btn svg { display: block; flex: none; }
:root:not(.kbd-nav) :focus-visible { outline: none !important; }
:root.kbd-nav :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style></head><body><div class="gone" role="alert">
<h1>The page keeps stopping</h1>
<p>It stopped ${count} times within a minute, so Liascape stopped reloading it. Your wallpaper keeps playing.</p>
<p class="why">Last time ${esc(why)} (exit code ${Number(gone.exitCode) | 0}).</p>
<button class="btn" id="reload" autofocus>${icon}Reload</button>
</div><script>
if (matchMedia("(prefers-reduced-motion: reduce)").matches) document.documentElement.classList.add("no-motion");
addEventListener("keydown", (e) => { if (e.key === "Tab") document.documentElement.classList.add("kbd-nav"); });
addEventListener("pointerdown", () => document.documentElement.classList.remove("kbd-nav"));
document.getElementById("reload").addEventListener("click", () => { document.title = ${JSON.stringify(RELOAD_TITLE)}; });
</script></body></html>`;
}

// pageUrl(): the URL to load the app's page with, built fresh each time — the page drops ?token= from its address once
// read, and a restarted backend has a new token, so webContents.reload() could come back unable to reach the API.
function recoverRenderer(win, pageUrl, log = (m) => console.error(m)) {
  const wc = win.webContents;
  let deaths = [];        // when the page's renderer died, within the last CRASH_WINDOW_MS
  let timer = null;       // a pending reload / notice retry
  let hangTimer = null, hungAt = 0;
  let notice = false;     // the notice is what the window shows

  const later = (ms, fn) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; if (!win.isDestroyed()) fn(); }, ms); };
  const loadApp = () => {
    notice = false;
    wc.loadURL(pageUrl()).catch((e) => log(`renderer: reloading the page failed: ${e.message}`));
  };
  const showNotice = async (gone, count) => {
    notice = true;
    const html = noticeHtml(await lookOf(pageUrl()), gone, count);
    if (win.isDestroyed() || !notice) return;
    wc.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch((e) => log(`renderer: showing the notice failed: ${e.message}`));
  };
  let lastGone = null;

  wc.on("render-process-gone", (_e, d) => {
    clearTimeout(hangTimer); hangTimer = null; hungAt = 0;
    const what = `reason=${d.reason} exitCode=${d.exitCode}`;
    if (d.reason === "clean-exit" || win.isDestroyed()) { log(`renderer: exited (${what})`); return; }
    if (notice) {
      log(`renderer: the notice page is gone too (${what}): showing it again in ${NOTICE_RETRY_MS} ms`);
      later(NOTICE_RETRY_MS, () => showNotice(lastGone, deaths.length));
      return;
    }
    const now = Date.now();
    deaths = deaths.filter((t) => now - t < CRASH_WINDOW_MS);
    deaths.push(now);
    lastGone = d;
    const n = deaths.length;
    if (n > RELOAD_DELAYS_MS.length) {
      log(`renderer: gone (${what}), ${n} times in ${CRASH_WINDOW_MS / 1000} s: not reloading again, showing the reload notice`);
      clearTimeout(timer); timer = null;
      showNotice(d, n);
      return;
    }
    log(`renderer: gone (${what}): reloading the page in ${RELOAD_DELAYS_MS[n - 1]} ms (${n} of ${RELOAD_DELAYS_MS.length} in ${CRASH_WINDOW_MS / 1000} s)`);
    later(RELOAD_DELAYS_MS[n - 1], loadApp);
  });

  // the notice's Reload: the user asked, so the count starts over. The window's event, not the page's: preventDefault
  // there keeps the window's title
  win.on("page-title-updated", (e, title) => {
    if (!notice || title !== RELOAD_TITLE) return;
    e.preventDefault();
    log("renderer: Reload pressed on the notice");
    deaths = [];
    clearTimeout(timer); timer = null;
    loadApp();
  });

  wc.on("unresponsive", () => {
    if (hungAt) return;
    hungAt = Date.now();
    log(`renderer: unresponsive (the page isn't answering input): ending it if it still isn't in ${HANG_KILL_MS / 1000} s`);
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (win.isDestroyed()) return;
      log(`renderer: still unresponsive after ${Math.round((Date.now() - hungAt) / 1000)} s: ending it`);
      wc.forcefullyCrashRenderer();
    }, HANG_KILL_MS);
  });
  wc.on("responsive", () => {
    if (!hungAt) return;
    log(`renderer: responsive again after ${((Date.now() - hungAt) / 1000).toFixed(1)} s`);
    clearTimeout(hangTimer); hangTimer = null; hungAt = 0;
  });
}

module.exports = { recoverRenderer, CRASH_WINDOW_MS, RELOAD_DELAYS_MS, HANG_KILL_MS };
