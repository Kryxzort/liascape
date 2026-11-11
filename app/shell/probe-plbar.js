// Playlist bar probe — `scripts/test-ui-matrix.sh --probe probe-plbar.js` (the matrix's hermetic stack). Owner 2026-11-11:
// "i cant scroll on playlist bar, make it so it doesn't lose the hover thing in the gaps between playlist items".
//   bar:wheel        a real wheel over the bar's row scrolls it (the row overflows: a narrow window)
//   bar:wheelReopen  collapse + expand the bar (the row unmounts / mounts again): the wheel still scrolls it
//   bar:gap          pointer on item 1 → the gap → item 2: item 1 stays lifted (and glowing) in the gap, then item 2 takes over
//   bar:leave        pointer off the row: nothing stays lifted, no glow left behind
// Real input events (webContents.sendInputEvent), not synthetic DOM events: :hover and the wheel listener see them as a user's.
// Screenshots: <LIASCAPE_OUT>/plbar-<cell>.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const K = JSON.parse(E.LIASCAPE_CLIPS);
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);
const getSettings = async () => (await http("GET", "/settings")).json;
async function setSettings(patch) { await post("/settings", { ...(await getSettings()), ...patch }); }

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const page = (code) => js(`(async () => { ${code} })()`);
const row = `document.querySelector(".playlist-bar-row")`;
// each item's lift (the dock transform's translateY; the sortable's own transform is none at rest) + whether a glow is up
const state = () => page(`return { items: [...document.querySelectorAll(".pl-item")].map((e) => { const r = e.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform); return { x: r.x, y: r.y, w: r.width, h: r.height, lift: +m.m42.toFixed(2) }; }),
  glow: !!document.querySelector(".pl-hover-glow"), glowBox: (() => { const g = document.querySelector(".pl-hover-glow"); if (!g) return null;
    const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(), scroll: ${row}?.scrollLeft ?? null, max: ${row} ? ${row}.scrollWidth - ${row}.clientWidth : null };`);
const move = (x, y) => win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
const wheel = (x, y, dy) => win.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: dy, canScroll: true });
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `plbar-${name}.png`), img.toPNG()); }

async function wheelScrolls(v, what) {
  const s0 = await state();
  if (s0.max === null) { v.push(`${what}: no playlist bar row`); return; }
  if (s0.max <= 0) { v.push(`${what}: the row doesn't overflow (max ${s0.max}) — the cell proves nothing`); return; }
  const it = s0.items[0];
  await page(`${row}.scrollLeft = 0;`); await sleep(100);
  for (let i = 0; i < 4; i++) { wheel(it.x + it.w / 2, it.y + it.h / 2, -120); await sleep(40); }
  await sleep(900);
  const s1 = await state();
  if (!(s1.scroll > 20)) v.push(`${what}: 4 wheel ticks over the row moved it ${s1.scroll} px (max ${s1.max})`);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1000, height: 800, webPreferences: { backgroundThrottling: false } });
  const results = [];
  const cell = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
    move(5, 5); await sleep(300);
  };
  try {
    await post("/playlist/state", { videoPaths: K, settings: null, name: null });
    await setSettings({ morphs: true, glows: true, isPlaylistBarCollapsed: false });
    await win.loadURL(U + "/");
    for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.pl-item').length`) >= 3) break; await sleep(100); }
    // narrow enough that the bar's items overflow its row (each item is 112 px + a 10 px gap)
    const n = await js(`document.querySelectorAll('.pl-item').length`);
    win.setContentSize(Math.max(260, n * 122 - 160), 800);
    await sleep(800);

    await cell("bar:wheel", async () => { const v = []; await wheelScrolls(v, "on load"); await shot("wheel"); return v; });

    await cell("bar:wheelReopen", async () => {
      const v = [];
      const toggle = `document.querySelector(".playlist-bar-head .mini").click();`;
      await page(toggle); await sleep(400);
      if (await js(`!!${row}`)) v.push("the collapse button didn't collapse the bar");
      await page(toggle); await sleep(600);
      await wheelScrolls(v, "after collapse + expand");
      return v;
    });

    await cell("bar:gap", async () => {
      const v = [];
      await page(`${row}.scrollLeft = 0;`); await sleep(300);
      let s = await state();
      const [a, b] = s.items;
      if (!a || !b) return ["fewer than 2 playlist items"];
      const y = a.y + a.h / 2;
      move(a.x + a.w / 2, y); await sleep(120); move(a.x + a.w - 4, y); await sleep(350);
      s = await state();
      if (!(s.items[0].lift < -3)) v.push(`on item 1 its lift is ${s.items[0].lift} px (expected −4)`);
      const gapX = (a.x + a.w + b.x) / 2;
      move(gapX, y); await sleep(350);
      s = await state();
      await shot("gap");
      if (!(s.items[0].lift < -3)) v.push(`in the gap item 1 dropped to ${s.items[0].lift} px (it should stay lifted)`);
      if (!s.glow) v.push("in the gap the hover glow went away");
      else { const g = s.glowBox, i = s.items[0]; const off = Math.max(Math.abs(g.x - i.x), Math.abs(g.y - i.y), Math.abs(g.w - i.w), Math.abs(g.h - i.h));
        if (off > 0.5) v.push(`the glow sits ${off.toFixed(2)} px off item 1 (glow ${JSON.stringify(g)}, item ${JSON.stringify(i)})`); }
      move(b.x + 6, y); await sleep(120); move(b.x + b.w / 2, y); await sleep(350);
      s = await state();
      if (!(s.items[1].lift < -3)) v.push(`on item 2 its lift is ${s.items[1].lift} px (expected −4)`);
      if (s.items[0].lift < -3) v.push(`item 1 still fully lifted (${s.items[0].lift}) with the pointer on item 2`);
      return v;
    });

    // a pointer sweep across the bar, ~60 moves/s: frame pacing + long tasks + React commits (the hover must stay smooth)
    await cell("bar:sweep", async () => {
      const v = [];
      win.setContentSize(1000, 800); await sleep(800); // every item on screen
      await page(`${row}.scrollLeft = 0;`); await sleep(300);
      const s = await state();
      const W = await js("innerWidth");
      const its = s.items.filter((i) => i.x + i.w < W);
      if (its.length < 3) return ["fewer than 3 items on screen"];
      const y = its[0].y + its[0].h / 2, x0 = its[0].x + 4, x1 = its[its.length - 1].x + its[its.length - 1].w - 4;
      await page(`window.__sw = { gaps: [], long: [], last: 0, on: true, muts: 0 };
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__sw.long.push(Math.round(e.duration)); }).observe({ type: "longtask" });
        new MutationObserver((ms) => { window.__sw.muts += ms.length; }).observe(document.body, { subtree: true, attributes: true, childList: true });
        const f = (t) => { const w = window.__sw; if (!w.on) return; if (w.last) w.gaps.push(t - w.last); w.last = t; requestAnimationFrame(f); }; requestAnimationFrame(f);`);
      for (let k = 0; k < 2; k++) for (let i = 0; i <= 60; i++) { const t = k ? 1 - i / 60 : i / 60; move(x0 + (x1 - x0) * t, y); await sleep(16); }
      await sleep(300);
      const r = await page(`const w = window.__sw; w.on = false; const g = w.gaps.slice().sort((a, b) => a - b);
        return { n: g.length, p50: g[Math.floor(g.length * .5)], p95: g[Math.floor(g.length * .95)], max: g[g.length - 1], long: w.long, muts: w.muts };`);
      console.log(`        sweep: ${r.n} frames, p50 ${r.p50?.toFixed(1)} ms, p95 ${r.p95?.toFixed(1)} ms, max ${r.max?.toFixed(1)} ms, long tasks [${r.long}], DOM mutations ${r.muts}`);
      if (r.long.some((d) => d > 50)) v.push(`long tasks during the sweep: [${r.long}] ms`);
      if (r.max > 50) v.push(`a ${r.max.toFixed(0)} ms frame during the sweep`);
      return v;
    });

    await cell("bar:leave", async () => {
      const v = [];
      let s = await state();
      const a = s.items[0];
      move(a.x + a.w / 2, a.y + a.h / 2); await sleep(350);
      move(a.x + a.w / 2, a.y - 60); await sleep(400); // up, off the row (the bar's head / the page)
      s = await state();
      const lifted = s.items.filter((i) => i.lift < -0.1).length;
      if (lifted) v.push(`${lifted} item(s) still lifted after the pointer left the row`);
      if (s.glow) v.push("a hover glow stayed after the pointer left the row");
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`PLBAR pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "plbar.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
