// Headless self-test: loads the UI offscreen, captures console, counts rendered cards, exits.
// Usage: electron app/shell/probe.js http://127.0.0.1:<port>
const { app, BrowserWindow } = require("electron");
const url = process.argv[2] || "http://127.0.0.1:8080";
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { backgroundThrottling: false } });
  const logs = [];
  win.webContents.on("console-message", (_e, level, msg) => logs.push(`[${level}] ${msg}`));
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 6000)); // let init() fetch + render
  const browse = await win.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll('.card').length,
    pills: document.querySelectorAll('.pill').length,
    themeOptions: document.querySelectorAll('.theme-pick option').length,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    title: document.querySelector('.card .title')?.textContent || null,
  }))()`).catch((e) => ({ error: String(e) }));
  console.log("PROBE_BROWSE " + JSON.stringify(browse));

  // switch to Library tab + verify grid + playlist strip
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`);
  await new Promise((r) => setTimeout(r, 2000));
  const lib = await win.webContents.executeJavaScript(`(() => ({
    libCards: document.querySelectorAll('.card.lib').length,
    libTitle: document.querySelector('.card.lib .title')?.textContent || null,
    strip: !!document.querySelector('.strip'),
    plItems: document.querySelectorAll('.pl-item').length,
    sortOptions: document.querySelectorAll('.topbar select')[0]?.options.length || 0,
  }))()`).catch((e) => ({ error: String(e) }));
  console.log("PROBE_LIBRARY " + JSON.stringify(lib));

  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Settings')?.click()`);
  await new Promise((r) => setTimeout(r, 1500));
  const settings = await win.webContents.executeJavaScript(`(() => ({
    sections: document.querySelectorAll('.ssection').length,
    rows: document.querySelectorAll('.srow').length,
    mpvLen: (document.querySelector('.mpv')?.textContent || '').length,
    keybinds: document.querySelectorAll('.kb').length,
    steamSignedIn: [...document.querySelectorAll('.shint')].some(e => /Signed in as/.test(e.textContent||'')),
  }))()`).catch((e) => ({ error: String(e) }));
  console.log("PROBE_SETTINGS " + JSON.stringify(settings));
  console.log("PROBE_LOGS " + JSON.stringify(logs.slice(0, 20)));
  app.quit();
});
