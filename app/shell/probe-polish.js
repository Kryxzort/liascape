// Parity-polish self-test: asserts the new DOM (compact lib card title overlay, ring/check toggle,
// strip title bar + context menu, Save/Load modals, lucide icons, preview meta rows, settings help).
// electron app/shell/probe-polish.js http://127.0.0.1:<port>
const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  const out = {};
  await win.loadURL(url);
  await wait(6000);

  // --- BROWSE: lucide icons present, no emoji glyphs, refresh icon ---
  out.browse = await js(`(() => {
    const emoji = /[🔀⚙💾📂▶⟳■↶🗑⚠✕✓↺👁★♥]/u;
    return {
      lucide: document.querySelectorAll('svg.lucide').length,
      refreshIcon: !!document.querySelector('.pills .mini svg.lucide'),
      emojiInBody: emoji.test(document.body.innerText),
    };
  })()`).catch((e) => ({ error: String(e) }));

  // --- PREVIEW: open modal, check layered stage + icon meta rows + lucide actions ---
  await js(`document.querySelector('.card .thumb-wrap')?.click()`);
  await wait(1200);
  out.preview = await js(`(() => ({
    stage: !!document.querySelector('.modal-stage'),
    metaRows: document.querySelectorAll('.meta .mrow').length,
    actionIcons: document.querySelectorAll('.modal-actions svg.lucide').length,
  }))()`).catch((e) => ({ error: String(e) }));
  await wait(1400); // give detail fetch time to add the full-res layer
  out.preview.fullResLayer = await js(`document.querySelectorAll('.modal-stage .modal-img').length`).catch(() => 0);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await wait(500);

  // --- LIBRARY: compact card overlay + ring/check toggle + trash ---
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`);
  await wait(1500);
  out.library = await js(`(() => ({
    libCards: document.querySelectorAll('.card.lib').length,
    titleOverlay: !!document.querySelector('.card.lib .lib-title span'),
    overlayText: document.querySelector('.card.lib .lib-title span')?.textContent || null,
    ringCheckSvg: !!document.querySelector('.card.lib .pl-toggle .pl-toggle-svg'),
    trashIcon: !!document.querySelector('.card.lib .del svg.lucide'),
    noBelowTitle: !document.querySelector('.card.lib > .title'),
  }))()`).catch((e) => ({ error: String(e) }));

  // --- STRIP: title bar + context menu (fixed, opens on contextmenu) ---
  out.strip = await js(`(() => ({
    items: document.querySelectorAll('.pl-item').length,
    titleBar: !!document.querySelector('.pl-item .pl-title'),
    removeIcon: !!document.querySelector('.pl-item .pl-remove svg.lucide'),
  }))()`).catch((e) => ({ error: String(e) }));
  // open strip context menu on first item
  out.strip.ctxOpens = await js(`(() => {
    const it = document.querySelector('.pl-item'); if(!it) return false;
    it.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:600}));
    return true;
  })()`);
  await wait(400);
  out.strip.ctxMenu = await js(`(() => {
    const m = document.querySelector('.ctx-menu.pl-ctx');
    return m ? [...m.querySelectorAll('button')].map(b=>b.textContent) : null;
  })()`);
  await js(`document.querySelector('.ctx-backdrop')?.click()`);
  await wait(300);

  // --- SAVE / LOAD playlist modals ---
  await js(`[...document.querySelectorAll('.strip-head .mini')].find(b=>b.title==='Save playlist')?.click()`);
  await wait(400);
  out.saveModal = await js(`(() => { const m=document.querySelector('.pl-modal');
    return m ? { title: m.querySelector('h2')?.textContent, hasInput: !!m.querySelector('input.text') } : null; })()`);
  await js(`document.querySelector('.modal-backdrop')?.click()`);
  await wait(300);
  await js(`[...document.querySelectorAll('.strip-head .mini')].find(b=>b.title==='Load playlist')?.click()`);
  await wait(400);
  out.loadModal = await js(`(() => { const m=document.querySelector('.pl-modal');
    return m ? { title: m.querySelector('h2')?.textContent, loadDisabled: m.querySelector('.btn.accent')?.disabled } : null; })()`);
  await js(`document.querySelector('.modal-backdrop')?.click()`);
  await wait(300);

  // --- SETTINGS: help texts + disabled rows + native-picker browse buttons ---
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Settings')?.click()`);
  await wait(1200);
  out.settings = await js(`(() => ({
    helpTexts: document.querySelectorAll('.help').length,
    disabledRows: document.querySelectorAll('.srow.disabled').length,
    browseButtons: [...document.querySelectorAll('.btn')].filter(b=>/Browse/.test(b.textContent||'')).length,
    monitorNote: [...document.querySelectorAll('.help')].some(e=>/hyprctl/.test(e.textContent||'')),
  }))()`).catch((e) => ({ error: String(e) }));

  console.log("PROBE_POLISH " + JSON.stringify(out, null, 0));
  app.quit();
});
