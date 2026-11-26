// Electron shell. Two modes, auto-detected:
//  • DEV (HMR): if Liascape's Vite dev server is up on :5173 (systemd liascape-vite; LIASCAPE_VITE = another), load the UI from Vite
//    (hot-reload) and talk to the systemd `dotnet watch -- serve` backend (port via serve.port).
//  • PROD: no Vite → spawn our own backend (LIASCAPE_BACKEND or `dotnet run`) and load the built dist
//    same-origin. Packaging spawns the published binary.
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { configDir, tokenFile, withToken } = require("./api-auth");
const { liascapeViteUp } = require("./vite-detect");
const { guardWebContents } = require("./outside-links");

const repoRoot = path.resolve(__dirname, "..", "..");
const uiDir = path.join(repoRoot, "app", "ui", "dist");
// the backend's config dir ($XDG_CONFIG_HOME/liascape, else ~/.config/liascape — .NET's ApplicationData)
const portFile = path.join(configDir(), "serve.port");
const VITE = process.env.LIASCAPE_VITE || "http://localhost:5173";
// Chromium's profile (the renderer's localStorage, caches) in ~/.config/liascape-shell — productName
// "Liascape" would otherwise put it in ~/.config/Liascape, beside the backend's own ~/.config/liascape.
app.setPath("userData", path.join(app.getPath("appData"), "liascape-shell"));
// LIASCAPE_MUTE=1: no sound reaches any device (the agent window, scripts/agent-window.sh).
if (process.env.LIASCAPE_MUTE) { app.commandLine.appendSwitch("mute-audio"); app.commandLine.appendSwitch("disable-audio-output"); }

// ── GPU / ozone platform selection (the load-bearing bit on Linux) ─────────────────────────────
// ozone platform follows the ACTUAL session: Wayland if WAYLAND_DISPLAY is set, else X11. Use the
// HARD `--ozone-platform` — the `-hint` variant is advisory and Electron ≥42 ignores it (it would
// silently fall back to native Wayland and break; that was the "window renders but never displays").
const onWayland = !!process.env.WAYLAND_DISPLAY;
app.commandLine.appendSwitch("ozone-platform", process.env.LIASCAPE_OZONE || (onWayland ? "wayland" : "x11"));

// NVIDIA (proprietary/open) with Chromium's default GL crash-loops the GPU process on both paths: native Wayland
// makes the surface via Vulkan, which the wayland ozone backend rejects (invisible window), and XWayland segfaults
// the GPU process (OzoneImageBacking/EGLImage, exit 139). ANGLE on NVIDIA's EGL (`--use-angle=gles-egl`) brings up
// hardware GPU compositing with no GPU-process crash, so it's the NVIDIA default (docs/decisions.md § "Default
// NVIDIA to hardware GL through ANGLE on EGL"; SwiftShader cost a morph ~13.6 ms of CPU a frame). AMD/Intel keep
// Chromium's default hardware GL (mesa is stable). The "--ozone-platform=wayland is not compatible with Vulkan" log
// line is harmless (ANGLE uses EGL, not Vulkan). A GPU process that dies is logged (`[gpu]`, below).
// Overrides: LIASCAPE_SOFTGL=1 forces SwiftShader; LIASCAPE_ANGLE=<backend> picks another ANGLE backend.
const isNvidia = fs.existsSync("/proc/driver/nvidia") || fs.existsSync("/dev/nvidia0");
const softGL = !!process.env.LIASCAPE_SOFTGL;
if (softGL) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}

// ANGLE backend: NVIDIA → gles-egl by default (above); LIASCAPE_ANGLE overrides anywhere.
const angle = process.env.LIASCAPE_ANGLE || (isNvidia && !softGL ? "gles-egl" : "");
if (angle) {
  app.commandLine.appendSwitch("use-angle", angle);
  if (angle === "vulkan") app.commandLine.appendSwitch("enable-features", "Vulkan");
}

let backend;
// The UI's origin is http://127.0.0.1:<backend port>. A new random port every launch is a new origin, so
// everything the renderer keeps per origin (localStorage: library sort, source tab, …) started empty on
// every launch. Reuse the last port while it and the next one (the backend's media listener) are free (LIASCAPE_PORT,
// honoured by the backend); if one gets taken before the backend binds it, the backend exits without writing serve.port →
// retry on random ones.
function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}
async function startBackend() {
  let prev = null;
  try { prev = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10) || null; } catch { /* first run */ }
  try { fs.unlinkSync(portFile); } catch { /* fresh */ }
  // a fresh API token for every app launch: the backend makes one when the file is gone (.claude/rules/backend/api.md § Security)
  try { fs.unlinkSync(tokenFile()); } catch { /* none yet */ }
  const env = { ...process.env };
  if (!env.LIASCAPE_PORT && prev && (await portFree(prev)) && (await portFree(prev + 1))) env.LIASCAPE_PORT = String(prev);
  const spawnIt = () => {
    backend = process.env.LIASCAPE_BACKEND
      ? spawn(process.env.LIASCAPE_BACKEND, ["serve"], { env, stdio: "inherit" })
      : spawn("dotnet", ["run", "--project", "src/backend", "--", "serve"], { cwd: repoRoot, env: { ...env, LIASCAPE_UI_DIR: uiDir }, stdio: "inherit" });
    backend.once("exit", () => {
      if (fs.existsSync(portFile) || !env.LIASCAPE_PORT || process.env.LIASCAPE_PORT) return;
      delete env.LIASCAPE_PORT; spawnIt();
    });
  };
  spawnIt();
}

function waitForPort(cb, tries = 120) {
  if (fs.existsSync(portFile)) {
    const port = fs.readFileSync(portFile, "utf8").trim();
    if (port) return cb(port);
  }
  if (tries <= 0) { console.error("backend never wrote serve.port"); app.quit(); return; }
  setTimeout(() => waitForPort(cb, tries - 1), 500);
}

// Is Liascape's Vite dev server already running? → dev/HMR mode (another project's server on :5173 doesn't count:
// vite-detect.js). A LIASCAPE_VITE the caller started counts as up without asking: its first answer can take longer than
// the probe waits (a cold transform), and PROD mode would start a backend of its own.
function viteUp(cb) {
  if (process.env.LIASCAPE_VITE) return cb(true);
  liascapeViteUp(VITE, cb);
}

// ── Hardening (.claude/rules/backend/api.md § Security) ────────────
// The window shows the app's own UI and nothing else: a link, a window.open or a frame trying to leave goes to the user's
// browser instead (outside-links.js). No permissions but the clipboard write (Copy ID) and the trailer's fullscreen.
let appOrigin = null; // the UI's origin (the backend's or Vite's); file:// has none — then only file: pages count
const isAppUrl = (u) => {
  try { const x = new URL(u); return appOrigin ? x.origin === appOrigin : x.protocol === "file:"; } catch { return false; }
};
app.on("web-contents-created", (_e, wc) => guardWebContents(wc, { isAppUrl, openExternal: (u) => shell.openExternal(u) }));

// Native folder picker (Settings' folders, the Library's Import) — only for the app's own page. `kind` "files": wallpaper
// files instead (the Import's right-click), several at once → their paths. Each one opens where the last pick was made:
// without a defaultPath Electron opens Downloads every time.
let lastPickDir = null;
const MEDIA_EXTS = ["mp4", "webm", "mov", "mkv", "avi", "m4v", "gif", "png", "jpg", "jpeg", "webp"];
ipcMain.handle("liascape:pick", async (e, kind) => {
  if (!isAppUrl(e.senderFrame?.url ?? "")) return null;
  const files = kind === "files";
  const r = await dialog.showOpenDialog({
    properties: files ? ["openFile", "multiSelections"] : ["openDirectory"],
    ...(files ? { filters: [{ name: "Wallpapers", extensions: MEDIA_EXTS }] } : {}),
    ...(lastPickDir ? { defaultPath: lastPickDir } : {}),
  });
  if (r.canceled || !r.filePaths.length) return null;
  lastPickDir = path.dirname(r.filePaths[0]);
  return files ? r.filePaths : r.filePaths[0];
});

// Chromium restarts a GPU process that dies; log each one (a run of them is the NVIDIA crash-loop above)
app.on("child-process-gone", (_e, d) => {
  if (d.type === "GPU") console.error(`[gpu] GPU process gone: ${d.reason} (exit code ${d.exitCode})`);
});

function openWindow(loadUrl) {
  try { appOrigin = new URL(loadUrl).origin; if (appOrigin === "null") appOrigin = null; } catch { appOrigin = null; }
  const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMISSIONS.has(perm)));
  // LIASCAPE_WINDOW=<w>x<h>: that size with no frame — the agent window's private compositor (scripts/agent-window.sh)
  // neither tiles nor decorates windows, so the page gets exactly the output's size
  const fixed = /^(\d+)x(\d+)$/.exec(process.env.LIASCAPE_WINDOW || "");
  const win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: "#1e1e2e", title: "Liascape",
    ...(fixed ? { width: Number(fixed[1]), height: Number(fixed[2]), frame: false, roundedCorners: false } : {}),
    webPreferences: {
      backgroundThrottling: false, preload: path.join(__dirname, "preload.js"),
      // Electron's defaults, pinned: the page never gets Node, the preload runs isolated and sandboxed (it only bridges
      // ipcRenderer), same-origin policy on
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  // FREEZE FIX: authoritative active/idle signal from the WM (OS-level focus), more reliable than DOM
  // visibilitychange — on X11 an occluded window (you fullscreened another app over it) never reports
  // hidden, so the renderer would keep decoding all the autoplay gifs forever → ThreadPool backlog →
  // main-thread wedge. blur/focus fire on real focus changes; the renderer pauses gifs on idle.
  const sendActive = (v) => { try { win.webContents.send("liascape:active", v); } catch {} };
  win.on("blur", () => sendActive(false));
  win.on("focus", () => sendActive(true));
  win.on("hide", () => sendActive(false));
  win.on("minimize", () => sendActive(false));
  win.on("show", () => sendActive(true));
  win.on("restore", () => sendActive(true));
  // a page whose renderer dies or hangs comes back by itself; each reload carries the token the backend has now
  require("./renderer-recovery").recoverRenderer(win, () => withToken(loadUrl));
  win.loadURL(loadUrl);
}

// LIASCAPE_DEBUG=1 → ?debug → the liascapeDbg control bridge + perf-metrics tracking (fetch via liascapeDbg.metrics()).
// It does NOT show the on-screen HUD: the visual overlay is gated to the Settings "Show debug overlay"
// toggle only (see DebugHud overlayOn) — bridge mode keeps the values accessible without painting them.
const DBG = process.env.LIASCAPE_DEBUG ? "debug" : "";
// `intro`: the page plays its opening once in this window (app/ui/src/components/Intro.tsx). Only the shell asks: the
// probes and a browser tab load the page without it. Guard: probe-intro intro:absent
const PAGE_FLAGS = ["intro", DBG].filter(Boolean).join("&");
// LIASCAPE_DEBUG opens a CDP remote-debugging port (LIASCAPE_CDP_PORT, default 9222) so tooling can attach to the live window.
if (process.env.LIASCAPE_DEBUG) app.commandLine.appendSwitch("remote-debugging-port", process.env.LIASCAPE_CDP_PORT || "9222");

app.whenReady().then(() => {
  viteUp((dev) => {
    if (dev) {
      // backend is the systemd dotnet-watch serve (pinned port) — don't spawn our own; just read it.
      // + the backend's API token (serve.token, written before serve.port; the page keeps it and drops it from its URL)
      waitForPort((port) => openWindow(withToken(`${VITE}/?api=${port}&${PAGE_FLAGS}`)));
    } else {
      startBackend();
      waitForPort((port) => openWindow(withToken(`http://127.0.0.1:${port}/?${PAGE_FLAGS}`)));
    }
  });
});

app.on("window-all-closed", () => { try { backend?.kill(); } catch {} app.quit(); });
app.on("before-quit", () => { try { backend?.kill(); } catch {} });
