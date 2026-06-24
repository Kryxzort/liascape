const http = require("http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FPS = `new Promise(r=>{let n=0,t=performance.now();(function f(){n++;performance.now()-t<1000?requestAnimationFrame(f):r(Math.round(n*1000/(performance.now()-t)))})()})`;
function connect() {
  return new Promise((res, rej) => {
    http.get("http://localhost:9222/json", (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => {
      const t = JSON.parse(d).find((x) => x.type === "page"); const ws = new WebSocket(t.webSocketDebuggerUrl);
      let id = 0; const pend = {};
      ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; } });
      ws.addEventListener("open", () => res((expr) => new Promise((rr) => { const i = ++id; pend[i] = (r) => rr(r && r.result && ("value" in r.result ? r.result.value : r.result)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); })));
      ws.addEventListener("error", rej);
    }); }).on("error", rej);
  });
}
(async () => {
  const ev = await connect();
  // wait for lpdbg + library cards
  for (let i = 0; i < 60; i++) { if (await ev("!!(window.lpdbg)")) break; await sleep(300); }
  await ev(`lpdbg.tab('library')`); await sleep(800); await ev(`lpdbg.gifs(true)`); await sleep(2500);
  const log = (k, v) => console.log(k.padEnd(16), JSON.stringify(v));
  log("anim", await ev(`document.querySelectorAll('.thumb.anim').length`));
  log("idle_fps", await ev(FPS));
  // morph: open settings, measure fps + long-task ms over the morph window
  const M = `new Promise(res=>{let lt=0;const po=new PerformanceObserver(l=>{for(const e of l.getEntries())lt+=e.duration;});po.observe({entryTypes:['longtask']});const c=document.querySelector('.card.lib .thumb-wrap');const r=c.getBoundingClientRect();let n=0,t0=performance.now();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+20,clientY:r.top+20}));setTimeout(()=>{const b=[...document.querySelectorAll('.ctx-menu.lib-ctx button')].find(x=>/Settings/.test(x.textContent));if(b)b.click();},50);(function f(){n++;if(performance.now()-t0<500)requestAnimationFrame(f);else{po.disconnect();res('morphFps='+Math.round(n*1000/(performance.now()-t0))+' longTaskMs='+Math.round(lt)+' modal='+!!document.querySelector('.modal'));}})();})`;
  log("MORPH", await ev(M));
  await ev(`document.querySelector('.modal-backdrop')?.click()`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
