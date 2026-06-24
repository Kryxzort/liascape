// Measure main-thread long-task cost of opening the modals (the 300-card re-render hypothesis).
// Long-tasks are main-thread → measurable even offscreen. electron app/shell/probe-lag2.js <url?debug>
const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  await win.loadURL(url); await wait(6500);

  await js(`window.lpdbg.tab('library')`); await wait(1500);
  await js(`window.__lt=0; window.__n=0; window.__po=new PerformanceObserver(l=>{for(const e of l.getEntries()){window.__lt+=e.duration;window.__n++;}}); window.__po.observe({entryTypes:['longtask']});`);
  const reset = () => js(`window.__lt=0;window.__n=0;`);
  const read = () => js(`({ms:Math.round(window.__lt), n:window.__n})`);

  const out = {};
  await reset(); await wait(2000); out.idle = await read();

  // open playlist-settings (empty modal)
  await reset();
  await js(`document.querySelector('.strip-head .mini[title="Playlist settings"]')?.click()`);
  await wait(1200); out.openPlaylistSettings = await read();
  await js(`document.querySelector('.modal-backdrop')?.click()`); await wait(500);

  // open a library-card settings modal (right-click → Settings)
  await reset();
  await js(`(()=>{const c=document.querySelector('.card.lib .thumb-wrap'); const r=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+20,clientY:r.top+20}));})()`);
  await wait(300);
  await js(`[...document.querySelectorAll('.ctx-menu.lib-ctx button')].find(b=>/Settings/.test(b.textContent))?.click()`);
  await wait(1200); out.openLibrarySettings = await read();
  await js(`document.querySelector('.modal-backdrop')?.click()`); await wait(500);

  // count library cards (the re-render surface)
  out.libCards = await js(`document.querySelectorAll('.card.lib').length`);
  console.log("PROBE_LAG2 " + JSON.stringify(out));
  app.quit();
});
