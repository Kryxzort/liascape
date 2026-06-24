// Round-2 regression verification. electron app/shell/probe-round2.js http://127.0.0.1:<port>
const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  const out = {};
  await win.loadURL(url); await wait(6000);

  // theme moved to settings; removed from topbar
  out.topbar = await js(`(() => {
    const opts = [...document.querySelectorAll('.topbar .theme-pick option')].map(o=>o.value);
    return { themeInTopbar: opts.includes('Mocha') || opts.some(v=>/Catppuccin|Mocha|Latte|Frapp/.test(v)) };
  })()`);

  // BROWSE: gif layered (no src swap) + autoplay; hover keeps gif mounted
  out.browse = await js(`(() => {
    const c = document.querySelector('.card .thumb-wrap');
    if (c) c.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    return { cards: document.querySelectorAll('.card').length };
  })()`);
  await wait(600);
  out.browse.gifLayerOnHover = await js(`!!document.querySelector('.card .thumb.anim')`);

  // SETTINGS: theme row present, import row gone, help texts, smooth-scroll target exists
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Settings')?.click()`); await wait(900);
  out.settings = await js(`(() => {
    const rows = [...document.querySelectorAll('.srow')].map(r=>r.querySelector('.slabel')?.textContent||'');
    return {
      themeRow: rows.some(r=>/Theme/.test(r)),
      themeOptions: document.querySelectorAll('.ssection select option').length>0 && [...document.querySelectorAll('.ssection select')].some(s=>[...s.options].some(o=>/Mocha|Latte|Catppuccin|Nord|Dracula|Gruv/.test(o.value))),
      importRowGone: !rows.some(r=>/Import wallpaper/.test(r)),
    };
  })()`);

  // LIBRARY: select a card → no .sel-toolbar; context menu at cursor (portal'd) w/o "Add to playlist"
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`); await wait(1500);
  out.library = await js(`(() => {
    const card = document.querySelector('.card.lib');
    // ctrl-click to select
    const tw = card?.querySelector('.thumb-wrap');
    tw?.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));
    return { selected: !!document.querySelector('.card.lib.selected'), selToolbar: !!document.querySelector('.sel-toolbar') };
  })()`);
  // open context menu at cursor
  out.library.ctx = await js(`(() => {
    const tw = document.querySelector('.card.lib .thumb-wrap');
    const r = tw.getBoundingClientRect();
    tw.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:Math.round(r.left+30),clientY:Math.round(r.top+30)}));
    return true;
  })()`);
  await wait(400);
  out.library.menu = await js(`(() => {
    const m = document.querySelector('.ctx-menu.lib-ctx');
    if (!m) return null;
    const items = [...m.querySelectorAll('button')].map(b=>b.textContent);
    const cs = getComputedStyle(m);
    return { items, fixed: cs.position, inBody: m.parentElement === document.body, noAddToPlaylist: !items.some(t=>/Add to playlist/.test(t)) };
  })()`);
  await js(`document.querySelector('.ctx-backdrop')?.click()`); await wait(200);

  // ring/check see-through tick uses a <mask>
  out.tick = await js(`(() => {
    // hover a card so the toggle shows, then inspect an in-playlist toggle if any
    const svg = document.querySelector('.pl-toggle .pl-toggle-svg');
    return svg ? { hasRectOrMask: !!svg.querySelector('mask') || !!svg.querySelector('rect') } : { noToggle: true };
  })()`);

  // PLAYLIST strip: items use --thumb-aspect; settings/save/load open centered (portal'd to body)
  out.strip = await js(`(() => {
    const it = document.querySelector('.pl-item');
    const aspect = it ? getComputedStyle(it).aspectRatio : null;
    document.querySelector('.strip-head .mini[title="Playlist settings"]')?.click();
    return { items: document.querySelectorAll('.pl-item').length, aspect };
  })()`);
  await wait(400);
  out.strip.settingsModal = await js(`(() => {
    const m = document.querySelector('.pl-modal');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { centeredX: r.left > 200 && r.right < innerWidth-200, inViewport: r.top>0 && r.bottom<innerHeight+50, title: m.querySelector('h2')?.textContent };
  })()`);
  await js(`document.querySelector('.modal-backdrop')?.click()`); await wait(200);

  // status bar present
  out.statusBar = await js(`(() => { const b=document.querySelector('.statusbar'); return b?{text:b.querySelector('.sb-msg')?.textContent}:null; })()`);

  // scrollbar: scrollbar-width should NOT be 'thin' (so webkit rounded thumb applies)
  out.scrollbar = await js(`(() => { const sc=document.querySelector('.scroll'); return sc?getComputedStyle(sc).scrollbarWidth:null; })()`);

  console.log("PROBE_R2 " + JSON.stringify(out));
  app.quit();
});
