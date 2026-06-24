// Verify animated library previews: hover renders an animated layer; AutoPlayGifs bulk-plays gif assets.
const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  const out = {};
  await win.loadURL(url); await wait(6000);
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

  // B. enable AutoPlayGifs → gif-asset cards animate in bulk (count onscreen animated <img>)
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Settings')?.click()`); await wait(800);
  out.toggledOn = await js(`(() => {
    const sec=[...document.querySelectorAll('.ssection')].find(s=>/Appearance/.test(s.querySelector('h3')?.textContent||''));
    const cb=[...(sec?.querySelectorAll('.srow')||[])].find(r=>/Autoplay GIF/.test(r.textContent||''))?.querySelector('input[type=checkbox]');
    if(!cb) return false; if(!cb.checked) cb.click(); return true;
  })()`);
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Library')?.click()`); await wait(1500);
  out.bulkAnimImgs = await js(`document.querySelectorAll('.card.lib img.thumb.anim').length`);
  // revert the toggle (leave settings as found = off)
  await js(`[...document.querySelectorAll('.tab')].find(b=>b.textContent==='Settings')?.click()`); await wait(700);
  await js(`(() => {
    const sec=[...document.querySelectorAll('.ssection')].find(s=>/Appearance/.test(s.querySelector('h3')?.textContent||''));
    const cb=[...(sec?.querySelectorAll('.srow')||[])].find(r=>/Autoplay GIF/.test(r.textContent||''))?.querySelector('input[type=checkbox]');
    if(cb&&cb.checked) cb.click();
  })()`); await wait(500);

  console.log("PROBE_GIF " + JSON.stringify(out));
  app.quit();
});
