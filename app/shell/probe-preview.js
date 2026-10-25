// Regression probe: the per-wallpaper settings modal's live drag (/preview) must name the item being
// edited. Mid-transition the backend's "playing item" is the INCOMING wallpaper, so a preview without
// a path moved the other side of the effect (owner report: changing A's volume/speed mid-transition
// changed B). Loads the UI offscreen, stubs every write (/preview, /library/volume|speed, playback,
// /open — nothing reaches the backend: the live wallpaper and the library are never touched), opens
// the modal from the playlist strip's right-click menu, drags the volume and speed sliders, and checks
// what the UI tried to send.
// Usage: electron app/shell/probe-preview.js "http://localhost:5173/?api=5174"   (exit 0 = pass)
const { app, BrowserWindow } = require("electron");
const url = process.argv[2] || "http://localhost:5173/?api=5174";
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

const STUB = ["/preview", "/library/volume", "/library/speed", "/library/whitelist",
  "/playlist/play-from", "/playlist/play", "/apply", "/next", "/prev", "/random", "/open"];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(url);
  const js = (s) => win.webContents.executeJavaScript(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await js(`(() => {
    window.__sent = [];
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const u = String(input && input.url || input);
      const path = u.replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
      if ((init?.method || "GET") === "POST" && ${JSON.stringify(STUB)}.includes(path)) {
        let body = null; try { body = JSON.parse(init.body); } catch {}
        window.__sent.push({ path, body });
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return real(input, init);
    };
  })()`);
  await wait(5000);
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`);
  await wait(2000);
  if (!(await js(`document.querySelectorAll('.pl-item').length`))) { console.log("PROBE_PREVIEW SKIP: no playlist items"); app.exit(0); return; }

  await js(`(() => { const it = document.querySelector('.pl-item'); const r = it.getBoundingClientRect();
    it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 })); })()`);
  await wait(300);
  await js(`[...document.querySelectorAll('.pl-ctx button')].find(b => b.textContent === "Settings (volume / speed)")?.click()`);
  await wait(900);
  const sliders = await js(`document.querySelectorAll('.lib-settings input[type=range]').length`);
  if (!sliders) { console.log("PROBE_PREVIEW FAIL: settings modal didn't open"); app.exit(1); return; }
  await js(`window.__sent = []`);
  // drag: a few input events like a real slider (React's onChange listens to `input`)
  await js(`(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const [vol, spd] = document.querySelectorAll('.lib-settings input[type=range]');
    for (const v of [40, 35, 30]) { set.call(vol, String(v)); vol.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 120)); }
    if (spd) for (const v of [1.5, 1.6]) { set.call(spd, String(v)); spd.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 120)); }
  })()`);
  await wait(700);
  const sent = await js(`window.__sent.slice()`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  const previews = sent.filter((s) => s.path === "/preview");
  const persisted = sent.filter((s) => s.path === "/library/volume" || s.path === "/library/speed");
  const edited = persisted.length ? persisted[0].body?.path : null;
  const bad = [];
  if (!previews.length) bad.push("no /preview sent while dragging");
  for (const p of previews) {
    if (!Array.isArray(p.body?.paths) || !p.body.paths.length) bad.push(`/preview without paths: ${JSON.stringify(p.body)}`);
    else if (edited && !p.body.paths.includes(edited)) bad.push(`/preview names ${JSON.stringify(p.body.paths)}, the modal edits ${edited}`);
  }
  if (!sent.some((s) => s.path === "/library/volume" && s.body?.intValue === 30)) bad.push("the volume drag (30) was never persisted");
  if (!sent.some((s) => s.path === "/library/speed" && s.body?.doubleValue === 1.6)) bad.push("the speed drag (1.6) was never persisted");
  if (!sent.some((s) => s.path === "/preview" && s.body?.volume === 30)) bad.push("the last volume (30) was never previewed");
  console.log("PROBE_PREVIEW " + JSON.stringify(sent));
  console.log(bad.length ? "PROBE_PREVIEW FAIL: " + bad.join("; ") : "PROBE_PREVIEW PASS");
  app.exit(bad.length ? 1 : 0);
});
