// Verify animated library previews: hover renders an animated layer; "Card previews" → "Always animate" bulk-plays gif assets.
const { app, BrowserWindow } = require("electron");
const { withToken } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  const out = {};
  await win.loadURL(withToken(url)); await wait(6000);
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`); await wait(1500);

  // A. hover a gif-backed card → animated <img> layer appears
  out.hover = await js(`(() => {
    const cards=[...document.querySelectorAll('.card.lib')];
    const card=cards[0]; const tw=card?.querySelector('.thumb-wrap'); if(!tw) return {err:'no card'};
    tw.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    tw.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
    return {dispatched:true};
  })()`);
  await wait(700);
  out.hoverLayer = await js(`(() => {
    const card=document.querySelector('.card.lib');
    const a=card?.querySelector('.thumb.anim');
    return a ? a.tagName : null;
  })()`);

  // B. "Card previews" → "Always animate" (Settings → Look & feel) → gif-asset cards animate in bulk (count onscreen animated <img>)
  const preset = (name) => js(`(async () => {
    const row=[...document.querySelectorAll('.settings .srow')].find(r=>r.querySelector('.slabel-row')?.firstChild?.textContent?.trim()==='Card previews');
    const sel=row?.querySelector('.sel'); if(!sel) return false; sel.click(); await new Promise(r=>setTimeout(r,250));
    const o=[...document.querySelectorAll('.sel-pop .sel-opt')].find(e=>e.textContent.trim()===${JSON.stringify(name)}); if(!o) return false; o.click(); return true;
  })()`);
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Settings')?.click()`); await wait(800);
  out.toggledOn = await preset("Always animate");
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`); await wait(1500);
  out.bulkAnimImgs = await js(`document.querySelectorAll('.card.lib img.thumb.anim').length`);
  // put the default back ("Animate on hover")
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Settings')?.click()`); await wait(700);
  await preset("Animate on hover"); await wait(500);

  console.log("PROBE_GIF " + JSON.stringify(out));
  app.quit();
});
