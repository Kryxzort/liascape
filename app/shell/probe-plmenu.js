// Regression probe: a right-click on a playlist bar item must never start playback. Since 2026-11-11 (owner: "right-click opens
// the sidebar on that item without applying it — no context menu anywhere") it opens the item's Library sidebar and no menu;
// the menu it replaced was portal'd to document.body and React bubbled its clicks up to the .pl-item's onClick (playFrom).
// Loads the UI offscreen, stubs the playback endpoints (nothing reaches the backend, so the live wallpaper is never touched),
// right-clicks a playlist item, then clicks the sidebar's playlist toggle twice and its picture's switch area, and reports which
// playback requests the UI tried to send. `/open` is stubbed as well (no real file manager).
// Usage: electron app/shell/probe-plmenu.js "http://127.0.0.1:5173/?api=5174"   (exit 0 = pass)
const { app, BrowserWindow } = require("electron");
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const url = process.argv.slice(2).find((a) => /^https?:/.test(a)) || process.env.LIASCAPE_URL || "http://127.0.0.1:5173/?api=5174"; // LIASCAPE_URL: scripts/test-ui-matrix.sh --probe probe-plmenu.js
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

const PLAYBACK = ["/playlist/play-from", "/playlist/play", "/apply", "/next", "/prev", "/random"];
// Stubbed too but not a failure: "Open in file manager" must not open a real window on the desktop.
const SIDE_EFFECTS = ["/open"];

app.whenReady().then(async () => {
  // in the matrix's hermetic stack (LIASCAPE_CLIPS): a playlist of its clips first, so there are bar items to right-click
  if (process.env.LIASCAPE_CLIPS) await fetch(new URL("/playlist/state", url), { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ videoPaths: JSON.parse(process.env.LIASCAPE_CLIPS).slice(0, 3), settings: null, name: null }) }).catch(() => {});
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { backgroundThrottling: false } });
  await win.loadURL(withToken(url));
  const js = (s) => win.webContents.executeJavaScript(s);
  // Stub playback POSTs before the app can send any; record them instead.
  await js(`(() => {
    window.__sent = [];
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const u = String(input && input.url || input);
      const path = u.replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
      const post = (init?.method || "GET") === "POST";
      if (post && ${JSON.stringify(SIDE_EFFECTS)}.includes(path))
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      if (post && ${JSON.stringify(PLAYBACK)}.includes(path)) {
        window.__sent.push(path);
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return real(input, init);
    };
  })()`);
  await new Promise((r) => setTimeout(r, 5000));
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`);
  await new Promise((r) => setTimeout(r, 2000));
  const n = await js(`document.querySelectorAll('.pl-item').length`);
  if (!n) { console.log("PROBE_PLMENU SKIP: no playlist items"); app.exit(0); return; }

  const results = {};
  await js(`window.__sent = []; (() => {
    const it = document.querySelector('.pl-item'); const r = it.getBoundingClientRect();
    it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const opened = await js(`({ side: document.querySelector('.side-panel[data-side="library"]')?.dataset.sideId ?? null,
    item: document.querySelector('.pl-item')?.dataset.morphId?.replace(/^pl-/, '') ?? null, menu: !!document.querySelector('.ctx-menu, .pl-ctx') })`);
  results.rightClick = await js(`window.__sent.slice()`);
  // (the sidebar's playlist toggle that a portal'd menu used to bubble through is gone — owner 2026-11-11)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 400));
  if (opened.menu) results.menu = ["a context menu opened"];
  if (!opened.side || opened.side !== opened.item) results.sidebar = [`the right-click opened ${opened.side ?? "no sidebar"} (the item: ${opened.item})`];
  const bad = Object.entries(results).filter(([, v]) => v.length);
  console.log("PROBE_PLMENU " + JSON.stringify(results));
  console.log(bad.length ? "PROBE_PLMENU FAIL: " + bad.map(([k]) => k).join(", ") : "PROBE_PLMENU PASS");
  app.exit(bad.length ? 1 : 0);
});
