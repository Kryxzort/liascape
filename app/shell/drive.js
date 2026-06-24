// Drive the LIVE debug window over CDP, measure REAL fps (visible → real rAF). node app/shell/drive.js
const http = require("http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FPS = `new Promise(r=>{let n=0,t=performance.now();(function f(){n++;performance.now()-t<1500?requestAnimationFrame(f):r(Math.round(n*1000/(performance.now()-t)))})()})`;

function connect() {
  return new Promise((res, rej) => {
    http.get("http://localhost:9222/json", (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => {
        const t = JSON.parse(d).find((x) => x.type === "page");
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        let id = 0; const pend = {};
        ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; } });
        ws.addEventListener("open", () => res({
          eval: (expr) => new Promise((rr) => { const i = ++id; pend[i] = (r) => rr(r && r.result && ("value" in r.result ? r.result.value : r.result)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); }),
        }));
        ws.addEventListener("error", rej);
      });
    }).on("error", rej);
  });
}

(async () => {
  const c = await connect();
  const log = (k, v) => console.log(k.padEnd(14), JSON.stringify(v));
  log("tab", await c.eval("lpdbg.tab('library')")); await sleep(1500);
  log("gifs_on", await c.eval("lpdbg.gifs(true)")); await sleep(2500);
  log("anim", await c.eval("document.querySelectorAll('.thumb.anim').length"));
  log("fps_idle", await c.eval(FPS));
  await c.eval("(()=>{const card=document.querySelector('.card.lib .thumb-wrap');const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+20,clientY:r.top+20}));})()");
  await sleep(300);
  log("openSettings", await c.eval("(()=>{const b=[...document.querySelectorAll('.ctx-menu.lib-ctx button')].find(b=>/Settings/.test(b.textContent));if(b){b.click();return 'clicked';}return 'no-btn';})()"));
  await sleep(700);
  log("modalOpen", await c.eval("!!document.querySelector('.modal')"));
  log("fps_modal", await c.eval(FPS));
  log("autoscroll_fps", await (async () => { await c.eval("document.querySelector('.modal-backdrop')?.click()"); await sleep(300); await c.eval("lpdbg.autoscroll(3000,4)"); return c.eval(FPS); })());
  log("metrics", await c.eval("lpdbg.metrics()"));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
