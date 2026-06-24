const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  await win.loadURL(url); await wait(6000);
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`);
  await wait(1200);
  const r = {};
  // multiselect: ctrl-click two cards
  await js(`(()=>{const c=[...document.querySelectorAll('.card.lib .thumb-wrap')];
    c[0]?.dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}));
    c[1]?.dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}));})()`);
  await wait(400);
  r.selected = await js(`document.querySelectorAll('.card.lib.selected').length`);
  // context menu
  await js(`document.querySelector('.card.lib .thumb-wrap')?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}))`);
  await wait(300);
  r.ctxMenu = await js(`!!document.querySelector('.ctx-menu')`);
  r.ctxItems = await js(`document.querySelectorAll('.ctx-menu button').length`);
  await js(`document.querySelector('.ctx-backdrop')?.click()`);
  // playlist settings popup
  await wait(200);
  await js(`[...document.querySelectorAll('.strip-head .mini')].find(b=>b.title==='Settings')?.click()`);
  await wait(300);
  r.plSettings = await js(`!!document.querySelector('.pl-settings')`);
  // collapse toggle
  await js(`[...document.querySelectorAll('.strip-head .mini')].find(b=>/Collapse|Expand/.test(b.title))?.click()`);
  await wait(300);
  r.collapsedRowGone = await js(`!document.querySelector('.strip-row')`);
  console.log("PROBE_PARITY " + JSON.stringify(r));
  app.quit();
});
