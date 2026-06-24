// Verify the debug HUD renders + the lpdbg bridge works. electron app/shell/probe-dbg.js <url-with-?debug>
const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  await win.loadURL(url); await wait(6500);
  const out = {};
  out.hud = await js(`(() => { const h=document.querySelector('.dbg-hud'); return h?h.textContent.replace(/\\s+/g,' ').trim():null; })()`);
  out.bridge = await js(`typeof window.lpdbg`);
  out.metrics = await js(`window.lpdbg && window.lpdbg.metrics()`).catch((e) => String(e));
  out.help = await js(`window.lpdbg && window.lpdbg.help()`).catch(() => null);
  // drive: switch to library, read cards, autoscroll briefly
  out.tab = await js(`window.lpdbg && window.lpdbg.tab('library')`);
  await wait(1500);
  out.libMetrics = await js(`window.lpdbg && window.lpdbg.metrics()`);
  out.autoscroll = await js(`window.lpdbg && window.lpdbg.autoscroll(3000,2)`);
  await wait(1600);
  out.afterScroll = await js(`window.lpdbg && window.lpdbg.metrics()`);
  console.log("PROBE_DBG " + JSON.stringify(out));
  app.quit();
});
