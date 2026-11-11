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
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform); return { x: r.x, y: r.y, w: r.width, h: r.height, lift: +m.m42.toFixed(2), mag: +m.m11.toFixed(4) }; }),
  glow: !!document.querySelector(".pl-hover-glow"), glowBox: (() => { const g = document.querySelector(".pl-hover-glow"); if (!g) return null;
    const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(), scroll: ${row}?.scrollLeft ?? null, rowL: ${row}?.getBoundingClientRect().left, rowR: ${row}?.getBoundingClientRect().right, max: ${row} ? ${row}.scrollWidth - ${row}.clientWidth : null };`);
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
      const big = (i) => i.mag > 1.1 || (i.mag < 1.01 && i.lift < -3); // magnified — or, motion off, the 2 px fallback can't reach here
      if (!big(s.items[0])) v.push(`on item 1: scale ${s.items[0].mag}, lift ${s.items[0].lift} px (expected magnified)`);
      const gapX = (a.x + a.w + b.x) / 2;
      move(gapX, y); await sleep(350);
      s = await state();
      await shot("gap");
      if (!(s.items[0].mag > 1.08)) v.push(`in the gap item 1 dropped to scale ${s.items[0].mag} (it should stay magnified)`);
      if (!s.glow) v.push("in the gap the hover glow went away");
      else { const g = s.glowBox, i = s.items[0]; const off = Math.max(Math.abs(g.x - i.x), Math.abs(g.y - i.y), Math.abs(g.w - i.w), Math.abs(g.h - i.h));
        if (off > 0.5) v.push(`the glow sits ${off.toFixed(2)} px off item 1 (glow ${JSON.stringify(g)}, item ${JSON.stringify(i)})`); }
      move(b.x + 6, y); await sleep(120); move(b.x + b.w / 2, y); await sleep(350);
      s = await state();
      if (!(s.items[1].mag > 1.13)) v.push(`on item 2 its scale is ${s.items[1].mag} (expected ~1.16)`);
      if (!(s.items[0].mag < s.items[1].mag - 0.03)) v.push(`item 1 (${s.items[0].mag}) as magnified as item 2 (${s.items[1].mag}) with the pointer on item 2`);
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

    // owner 2026-11-11: "detecting mouse position, not the item its focused on — so the surrounding stuff moves even if you move the
    // mouse on the same playlist item": the pointer on item 2's left quarter, then its right quarter → item 1 / item 3 trade lift
    await cell("bar:continuous", async () => {
      const v = [];
      await page(`${row}.scrollLeft = 0;`); await sleep(300);
      let s = await state();
      if (s.items.length < 3) return ["fewer than 3 items"];
      const b = s.items[1], y = b.y + b.h / 2;
      move(b.x + b.w * 0.25, y); await sleep(450);
      const L = (await state()).items.map((i) => i.mag);
      for (let i = 1; i <= 10; i++) { move(b.x + b.w * (0.25 + 0.05 * i), y); await sleep(16); } // slide along the same item
      await sleep(450);
      const R = (await state()).items.map((i) => i.mag);
      const st = await state();
      console.log(`        left quarter: ${L.slice(0, 4).join(" ")}  right quarter: ${R.slice(0, 4).join(" ")}`);
      if (!(L[0] > L[2] + 0.02)) v.push(`on item 2's left quarter item 1 (×${L[0]}) isn't magnified more than item 3 (×${L[2]})`);
      if (!(R[2] > R[0] + 0.02)) v.push(`on item 2's right quarter item 3 (×${R[2]}) isn't magnified more than item 1 (×${R[0]})`);
      if (!(L[1] > 1.13 && R[1] > 1.13)) v.push(`item 2 under the pointer magnifies only ×${L[1]} / ×${R[1]}`);
      if (Math.abs(L[1] - R[1]) > 0.01) v.push(`item 2's own scale differs left vs right (×${L[1]} vs ×${R[1]}): the curve isn't symmetric`);
      return v;
    });

    // owner 2026-11-11 ("its like really big, so its like colliding with the top"): the magnified item, at the PEAK of its bounce,
    // stays below the bar header's controls and inside the row (its clip) — sampled every frame through the rise
    // the first item sits at the row's left edge: magnified (the pointer on it) or a magnified neighbour's push must never cut it off
    await cell("bar:edge", async () => {
      const v = [];
      move(5, 5); await sleep(600);
      await page(`${row}.scrollLeft = 0;`); await sleep(200);
      let s = await state();
      for (const [k, f] of [[0, 0.3], [1, 0.5]]) {
        const it = s.items[k];
        move(it.x + it.w * f, it.y + it.h / 2); await sleep(600);
        const t = await state();
        const a = t.items[0];
        if (a.x < t.rowL - 0.5) v.push(`pointer on item ${k + 1}: item 1 is cut off at the row's left edge (${a.x.toFixed(1)} < ${t.rowL.toFixed(1)})`);
        s = t;
      }
      await shot("edge");
      return v;
    });

    await cell("bar:headroom", async () => {
      const v = [];
      move(5, 5); await sleep(700);
      await page(`${row}.scrollLeft = 0;`); await sleep(200);
      const s = await state();
      const it = s.items[1];
      const peak = page(`const el = document.querySelectorAll(".pl-item")[1], rowEl = ${row};
        const ctl = [...document.querySelectorAll(".playlist-bar-head > *")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
        let top = Infinity; const t0 = performance.now();
        while (performance.now() - t0 < 800) { await new Promise((r) => requestAnimationFrame(r)); top = Math.min(top, el.getBoundingClientRect().top); }
        const er = el.getBoundingClientRect();
        const hit = ctl.filter((r) => r.bottom > top && r.left < er.right && r.right > er.left).map((r) => r.bottom);
        return { top, rowTop: rowEl.getBoundingClientRect().top, ctlBottom: Math.max(...ctl.map((r) => r.bottom)), hit };`);
      await sleep(30); move(it.x + it.w / 2, it.y + it.h / 2);
      const r = await peak;
      await shot("headroom");
      console.log(`        peak top ${r.top.toFixed(1)}, header controls end ${r.ctlBottom.toFixed(1)}, row top ${r.rowTop.toFixed(1)}`);
      if (r.hit.length) v.push(`at its peak the item (top ${r.top.toFixed(1)}) runs into a header control above it (bottom ${r.hit.map((x) => x.toFixed(1))})`);
      if (r.top < r.rowTop + 1) v.push(`at its peak the item is clipped by the row's top (${r.top.toFixed(1)} vs ${r.rowTop.toFixed(1)})`);
      return v;
    });

    await cell("bar:leave", async () => {
      const v = [];
      let s = await state();
      const a = s.items[0];
      move(a.x + a.w / 2, a.y + a.h / 2); await sleep(350);
      move(a.x + a.w / 2, a.y - 25); await sleep(700); // up into the head's empty space (the row reaches under it): not on the items
      s = await state();
      if (s.items.some((i) => i.mag > 1.002)) v.push(`the pointer over the bar's header (above the items) still magnifies them (${s.items.map((i) => i.mag)})`);
      move(a.x + a.w / 2, a.y - 80); await sleep(700); // up, off the bar
      s = await state();
      const lifted = s.items.filter((i) => i.lift < -0.1 || i.mag > 1.002).length;
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
