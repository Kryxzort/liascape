// Regression probe: the playlist bar's right-click menu must never start playback.
// The menu is portal'd to document.body, but React bubbles a portal's events through the
// React tree — up to the .pl-item's onClick (playFrom). Loads the UI offscreen, stubs the
// playback endpoints (nothing reaches the backend, so the live wallpaper is never touched),
// right-clicks a playlist item and clicks each menu entry / the backdrop, and reports which
// playback requests the UI tried to send. `/open` is stubbed as well (no real file manager).
// Usage: electron app/shell/probe-plmenu.js "http://127.0.0.1:5173/?api=5174"   (exit 0 = pass)
const { app, BrowserWindow } = require("electron");
const url = process.argv[2] || "http://127.0.0.1:5173/?api=5174";
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

const PLAYBACK = ["/playlist/play-from", "/playlist/play", "/apply", "/next", "/prev", "/random"];
// Stubbed too but not a failure: "Open in file manager" must not open a real window on the desktop.
const SIDE_EFFECTS = ["/open"];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { backgroundThrottling: false } });
  await win.loadURL(url);
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
  for (const target of ["Settings (volume / speed)", "Open in file manager", "__backdrop__"]) {
    await js(`window.__sent = []; (() => {
      const it = document.querySelector('.pl-item'); const r = it.getBoundingClientRect();
      it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }));
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await js(`(() => {
      const t = ${JSON.stringify(target)};
      const el = t === "__backdrop__" ? document.querySelector('.ctx-backdrop')
        : [...document.querySelectorAll('.pl-ctx button')].find(b => b.textContent === t);
      el && el.click();
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    results[target] = await js(`window.__sent.slice()`);
    // close whatever opened (settings modal) before the next round
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 400));
  }
  const bad = Object.entries(results).filter(([, v]) => v.length);
  console.log("PROBE_PLMENU " + JSON.stringify(results));
  console.log(bad.length ? "PROBE_PLMENU FAIL: menu clicks started playback" : "PROBE_PLMENU PASS");
  app.exit(bad.length ? 1 : 0);
});
