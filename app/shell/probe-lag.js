// Isolate the modal-backdrop blur as the lag cause. VISIBLE window (real rAF — offscreen throttles).
// electron app/shell/probe-lag.js <url-with-?debug>
const { app, BrowserWindow } = require("electron");
const url = process.argv[2];
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1500, height: 1000, webPreferences: { backgroundThrottling: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  const fps = (ms = 1500) => js(`new Promise(res=>{let n=0,t0=performance.now();function f(){n++;if(performance.now()-t0<${ms})requestAnimationFrame(f);else res(Math.round(n*1000/(performance.now()-t0)));}requestAnimationFrame(f);})`);
  await win.loadURL(url); await wait(6500);
  const out = {};

  // library + autoplay gifs ON (lots of animating content behind any modal)
  await js(`window.lpdbg.tab('library')`); await wait(1500);
  await js(`window.lpdbg.gifs(true)`); await wait(2000);
  out.anim = await js(`document.querySelectorAll('.thumb.anim').length`);

  out.idle = await fps();                                   // gifs animating, no modal

  // open the playlist-settings modal (empty content → isolates the backdrop)
  await js(`document.querySelector('.strip-head .mini[title="Playlist settings"]')?.click()`); await wait(800);
  out.modalOpen = await js(`!!document.querySelector('.pl-modal')`);
  out.modal_noblur = await fps();                           // current fix: solid overlay

  // inject the OLD blur back onto the live backdrop → should tank
  await js(`(()=>{const b=document.querySelector('.modal-backdrop'); if(b){b.style.backdropFilter='blur(6px)'; b.style.webkitBackdropFilter='blur(6px)';} return getComputedStyle(b).backdropFilter;})()`);
  await wait(600);
  out.modal_blur = await fps();                             // re-blur full screen every frame

  // remove it again → recover
  await js(`(()=>{const b=document.querySelector('.modal-backdrop'); if(b){b.style.backdropFilter='none';b.style.webkitBackdropFilter='none';}})()`);
  await wait(600);
  out.modal_noblur2 = await fps();

  console.log("PROBE_LAG " + JSON.stringify(out));
  app.quit();
});
