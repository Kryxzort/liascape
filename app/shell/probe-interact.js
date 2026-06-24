// Interaction self-test: drives real UI actions (no apply/download — those touch the real desktop).
// electron app/shell/probe-interact.js http://127.0.0.1:<port>
const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  const out = {};
  const js = (s) => win.webContents.executeJavaScript(s);
  await win.loadURL(url);
  await wait(6000);

  // A. open preview modal by clicking a browse card thumb, then close via Escape
  await js(`document.querySelector('.card .thumb-wrap')?.click()`);
  await wait(900);
  out.modalOpen = await js(`!!document.querySelector('.modal-img')`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await wait(600);
  out.modalClosed = await js(`!document.querySelector('.modal-img')`);

  // B. switch theme → accent CSS var changes
  const before = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  out.themeSwitched = await js(`(() => {
    const sel = document.querySelector('.theme-pick'); if(!sel) return false;
    const cur = sel.value;
    const other = [...sel.options].map(o=>o.value).find(v=>v!==cur);
    sel.value = other; sel.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await wait(500);
  const after = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  out.accentBefore = before; out.accentAfter = after; out.accentChanged = before !== after;

  // C. library tab → toggle first card into playlist → strip count rises
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`);
  await wait(1200);
  const plBefore = await js(`document.querySelectorAll('.pl-item').length`);
  await js(`document.querySelector('.card.lib .pl-toggle')?.click()`);
  await wait(600);
  const plAfter = await js(`document.querySelectorAll('.pl-item').length`);
  out.playlistBefore = plBefore; out.playlistAfter = plAfter; out.playlistAdded = plAfter > plBefore;

  // D. library search filters the grid
  const libBefore = await js(`document.querySelectorAll('.card.lib').length`);
  out.searchWorks = await js(`(() => {
    const inp = [...document.querySelectorAll('.search')].pop(); if(!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp, 'zzzznomatchzzz'); inp.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await wait(400);
  const libAfter = await js(`document.querySelectorAll('.card.lib').length`);
  out.libBefore = libBefore; out.libAfter = libAfter; out.searchFiltered = libAfter < libBefore;

  console.log("PROBE_INTERACT " + JSON.stringify(out));
  app.quit();
});
