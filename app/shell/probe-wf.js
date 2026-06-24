const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  await win.loadURL(url); await wait(6000);
  // click the Steam Workshop pill (last pill)
  await js(`(()=>{const p=[...document.querySelectorAll('.pill')];const w=p.find(b=>/Workshop/i.test(b.textContent))||p[p.length-1];w&&w.click();})()`);
  await wait(4000);
  const r = {};
  r.filterBar = await js(`!!document.querySelector('.wfilter')`);
  r.selects = await js(`document.querySelectorAll('.wfilter select').length`);
  r.cards = await js(`document.querySelectorAll('.card').length`);
  // open filters popup
  await js(`[...document.querySelectorAll('.wfilter .pill')].find(b=>/Filters/.test(b.textContent))?.click()`);
  await wait(400);
  r.genres = await js(`document.querySelectorAll('.wfilter-pop .chips')[0]?.querySelectorAll('.chip').length||0`);
  r.features = await js(`document.querySelectorAll('.wfilter-pop .chips')[1]?.querySelectorAll('.chip').length||0`);
  console.log("PROBE_WF " + JSON.stringify(r));
  app.quit();
});
