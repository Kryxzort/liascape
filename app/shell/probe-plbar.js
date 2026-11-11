// Playlist bar probe — `scripts/test-ui-matrix.sh --probe probe-plbar.js` (the matrix's hermetic stack): the bar's row
// scrolls on the wheel, and the hover survives the gaps between playlist items.
//   bar:wheel        a real wheel over the bar's row scrolls it (the row overflows: a narrow window)
//   bar:wheelReopen  collapse + expand the bar (the row unmounts / mounts again): the wheel still scrolls it
//   bar:gap          pointer on item 1 → the gap → item 2: item 1 stays lifted (and glowing) in the gap, then item 2 takes over
//   bar:leave        pointer off the row: nothing stays lifted, no glow left behind
//   bar:bounce       the bounce on entering + on the item the pointer stops on, none on the items a sweep (fast or slow) passes
//   bar:sweepCost    a sweep forces no layout from script, restyles only the moved items, re-renders only the hovered items
//   bar:shape        the items are 112 px tall, as wide as the Thumbnail shape makes them; fully magnified one rises ~12 px
//                    and the headroom above the items isn't much more than that rise + its clearance
//   bar:shapes       Square vs Widescreen: the bar is equally tall, a neighbour of the magnified item moves the same
// The dock cells (bar:gap … bar:sweepCost, bar:shape) run at Thumbnail shape Square, then again as `<cell>:wide` at
// Widescreen; their magnification thresholds are fractions of the item's measured full magnification.
// Real input events (webContents.sendInputEvent), not synthetic DOM events: :hover and the wheel listener see them as a user's.
// Screenshots: <LIASCAPE_OUT>/plbar-<cell>.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const K = JSON.parse(E.LIASCAPE_CLIPS);
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
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
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform); return { x: r.x, y: r.y, w: r.width, h: r.height, push: +m.m41.toFixed(2), lift: +m.m42.toFixed(2), mag: +m.m11.toFixed(4) }; }),
  glow: !!document.querySelector(".pl-hover-glow"), glowBox: (() => { const g = document.querySelector(".pl-hover-glow"); if (!g) return null;
    const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(), scroll: ${row}?.scrollLeft ?? null, rowL: ${row}?.getBoundingClientRect().left, rowR: ${row}?.getBoundingClientRect().right, max: ${row} ? ${row}.scrollWidth - ${row}.clientWidth : null };`);
const move = (x, y) => win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
const wheel = (x, y, dy) => win.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: dy, canScroll: true });
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `plbar-${name}.png`), img.toPNG()); }

// hooks/useDockLift.ts RISE: how far a fully magnified item's top rises at every shape; CLEAR: the least room between it, at
// its bounce's peak, and the bar header's controls
const RISE = 12, CLEAR = 3;
const SHAPES = [["1:1", ""], ["16:9", ":wide"]]; // Thumbnail shape → the dock cells' name suffix
const DOCK_CELLS = ["bar:shape", "bar:gap", "bar:sweep", "bar:bounce", "bar:continuous", "bar:edge", "bar:headroom", "bar:leave", "bar:sweepCost"];
// at rest, then with the pointer resting on item 2: the items' size, the bar's height, the headroom between the header's
// controls and the items, item 2's full magnification and rise, and how far its right neighbour moves (sideways, up)
async function measure() {
  move(5, 5); await sleep(700);
  await page(`${row}.scrollLeft = 0;`); await sleep(200);
  const h = await page(`const c = [...document.querySelectorAll(".playlist-bar-head > *")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    return { ctlBottom: Math.max(...c.map((r) => r.bottom)), barH: document.querySelector(".playlist-bar").getBoundingClientRect().height };`);
  const s0 = await state();
  if (s0.items.length < 3) throw new Error(`only ${s0.items.length} playlist items`);
  const b = s0.items[1];
  move(b.x + b.w / 2, b.y + b.h / 2); await sleep(900);
  const s1 = await state();
  move(5, 5); await sleep(500);
  const n0 = s0.items[2], n1 = s1.items[2];
  return { w: b.w, h: b.h, barH: h.barH, gap: b.y - h.ctlBottom, full: s1.items[1].mag, rise: b.y - s1.items[1].y,
    push: n1.push, nLift: -n1.lift, nRise: n0.y - n1.y };
}

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
    await setSettings({ morphs: true, glows: true, isPlaylistBarCollapsed: false, thumbnailAspect: "1:1" });
    await win.loadURL(withToken(U + "/"));
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

    // the dock cells at each Thumbnail shape (the items' width follows it; their height, the dock's rise and its bell in item
    // pitches don't)
    const seen = {};
    for (const [aspect, sfx] of SHAPES) {
      if (ONLY && !ONLY.test("bar:shapes") && !DOCK_CELLS.some((c) => ONLY.test(c + sfx))) continue;
      await setSettings({ thumbnailAspect: aspect });
      await win.loadURL(withToken(U + "/")); // the open page doesn't see a /settings POST
      for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.pl-item').length`) >= 3) break; await sleep(100); }
      win.setContentSize(1000, 800); await sleep(800);
      const g = seen[aspect] = await measure();
      const amt = (m) => (m - 1) / (g.full - 1); // a scale as a fraction of the full magnification

      await cell("bar:shape" + sfx, async () => {
        const v = [], want = 112 * (aspect === "16:9" ? 16 / 9 : 1);
        console.log(`        ${aspect}: items ${g.w.toFixed(1)} × ${g.h.toFixed(1)}, bar ${g.barH.toFixed(1)} px tall, headroom ${g.gap.toFixed(1)} px;`
          + ` full magnification ×${g.full} rises ${g.rise.toFixed(1)} px; its neighbour moves ${g.push} px sideways, lifts ${g.nLift} px (top rises ${g.nRise.toFixed(1)} px)`);
        if (Math.abs(g.h - 112) > 0.5) v.push(`the items are ${g.h.toFixed(1)} px tall (expected 112 at every shape)`);
        if (Math.abs(g.w - want) > 1) v.push(`the items are ${g.w.toFixed(1)} px wide (expected ${want.toFixed(1)} at ${aspect})`);
        if (!(g.full > 1.01)) return [...v, `the item under the pointer didn't magnify (×${g.full}) — proved nothing`];
        if (Math.abs(g.rise - RISE) > 1) v.push(`a fully magnified item rises ${g.rise.toFixed(1)} px (expected ~${RISE} at every shape)`);
        // the rise, its bounce (~13 % more) and CLEAR fit in ~rise + 5; more is headroom nothing uses
        if (g.gap - g.rise > 6) v.push(`${g.gap.toFixed(1)} px of headroom over the items for a ${g.rise.toFixed(1)} px rise (expected ≤ rise + 6)`);
        await shot("shape" + sfx);
        return v;
      });

      await cell("bar:gap" + sfx, async () => {
        const v = [];
        await page(`${row}.scrollLeft = 0;`); await sleep(300);
        let s = await state();
        const [a, b] = s.items;
        if (!a || !b) return ["fewer than 2 playlist items"];
        const y = a.y + a.h / 2;
        move(a.x + a.w / 2, y); await sleep(120); move(a.x + a.w - 4, y); await sleep(350);
        s = await state();
        const big = (i) => amt(i.mag) > 0.6 || (i.mag < 1.001 && i.lift < -3); // magnified — or, motion off, the 2 px fallback can't reach here
        if (!big(s.items[0])) v.push(`on item 1: scale ${s.items[0].mag}, lift ${s.items[0].lift} px (expected magnified)`);
        const gapX = (a.x + a.w + b.x) / 2;
        move(gapX, y); await sleep(350);
        s = await state();
        await shot("gap" + sfx);
        if (!(amt(s.items[0].mag) > 0.5)) v.push(`in the gap item 1 dropped to scale ${s.items[0].mag} (it should stay magnified, ×${g.full} full)`);
        if (!s.glow) v.push("in the gap the hover glow went away");
        else { const g = s.glowBox, i = s.items[0]; const off = Math.max(Math.abs(g.x - i.x), Math.abs(g.y - i.y), Math.abs(g.w - i.w), Math.abs(g.h - i.h));
          if (off > 0.5) v.push(`the glow sits ${off.toFixed(2)} px off item 1 (glow ${JSON.stringify(g)}, item ${JSON.stringify(i)})`); }
        move(b.x + 6, y); await sleep(120); move(b.x + b.w / 2, y); await sleep(350);
        s = await state();
        if (!(amt(s.items[1].mag) > 0.81)) v.push(`on item 2 its scale is ${s.items[1].mag} (expected ~×${g.full})`);
        if (!(amt(s.items[0].mag) < amt(s.items[1].mag) - 0.19)) v.push(`item 1 (${s.items[0].mag}) as magnified as item 2 (${s.items[1].mag}) with the pointer on item 2`);
        return v;
      });

      // a pointer sweep across the bar, ~60 moves/s: frame pacing + long tasks + React commits (the hover must stay smooth)
      await cell("bar:sweep" + sfx, async () => {
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

      // docs/decisions.md § "Bounce the playlist bar's dock only when entering, stopping or leaving": the item the pointer ENTERS on overshoots
      // (its full magnification → above it, then back); the items a sweep passes — fast or slow — don't (critically damped:
      // never past it); the item it STOPS on overshoots again.
      // Every frame's scale per item, sampled in the page.
      await cell("bar:bounce" + sfx, async () => {
        const v = [];
        win.setContentSize(1000, 800); move(5, 5); await sleep(800);
        await page(`${row}.scrollLeft = 0;`); await sleep(300);
        const s = await state();
        const W = await js("innerWidth");
        const its = s.items.filter((i) => i.x + i.w < W);
        if (its.length < 4) return [`only ${its.length} items on screen (need 4)`];
        const y = its[0].y + its[0].h / 2, cx = (i) => its[i].x + its[i].w / 2;
        // the gestures' speeds in item pitches (122 px at Square): the dock's bell is measured in pitches, so a sweep at a fixed
        // px speed would be a slower gesture over wider items, and lag (the bounce on settle) less
        const k = (its[1].x - its[0].x) / 122;
        const rec = (ms) => page(`const els = [...document.querySelectorAll(".pl-item")]; const peak = els.map(() => 1);
          const t0 = performance.now();
          while (performance.now() - t0 < ${ms}) { await new Promise((r) => requestAnimationFrame(r));
            els.forEach((e, i) => { peak[i] = Math.max(peak[i], new DOMMatrixReadOnly(getComputedStyle(e).transform).m11); }); }
          return peak;`);
        // 1. enter onto the first item from outside the row
        let p = rec(700); await sleep(30); move(cx(0), y);
        const enter = await p;
        // 2. a fast sweep (~12 pitches/s) from the first item to the last on screen, then rest there
        const last = its.length - 1;
        p = rec(1400); await sleep(30);
        const n = Math.round((cx(last) - cx(0)) / (25 * k));
        for (let i = 1; i <= n; i++) { move(cx(0) + (cx(last) - cx(0)) * (i / n), y); await sleep(16); }
        const sweep = await p;
        const mids = sweep.slice(1, last); // the items passed (not the start or the stop)
        // 3. a slow drift (~2.5 pitches/s) back to the first item
        await sleep(400);
        const m = Math.round((cx(last) - cx(0)) / (5 * k));
        p = rec(m * 17 + 900); await sleep(30);
        for (let i = 1; i <= m; i++) { move(cx(last) + (cx(0) - cx(last)) * (i / m), y); await sleep(16); }
        const slow = await p;
        const slowMids = slow.slice(1, last);
        // in fractions of the full magnification: a bounce peaks > 3 % past it, a critically damped pass ≤ 1 %
        const pc = (m) => `${(amt(m) * 100).toFixed(1)} %`;
        console.log(`        full ×${g.full}; enter peak ×${enter[0].toFixed(4)} (${pc(enter[0])}); sweep mids peak ×${Math.max(...mids).toFixed(4)} (${pc(Math.max(...mids))}); stop peak ×${sweep[last].toFixed(4)} (${pc(sweep[last])})`);
        if (!(amt(enter[0]) > 1.03)) v.push(`the entered item peaked at ×${enter[0].toFixed(4)} (${pc(enter[0])}) — no bounce on entry (expected > 103 % of ×${g.full})`);
        if (mids.some((m) => amt(m) > 1.01)) v.push(`items passed mid-sweep overshot: peaks ×[${mids.map((m) => m.toFixed(4))}] (expected ≤ ×${g.full})`);
        console.log(`        slow drift mids peak ×${Math.max(...slowMids).toFixed(4)} (${pc(Math.max(...slowMids))})`);
        if (slowMids.some((m) => amt(m) > 1.01)) v.push(`items passed in a slow drift overshot: peaks ×[${slowMids.map((m) => m.toFixed(4))}] (expected ≤ ×${g.full})`);
        if (!(amt(sweep[last]) > 1.03)) v.push(`the item the sweep stopped on peaked at ×${sweep[last].toFixed(4)} (${pc(sweep[last])}) — no bounce on settle`);
        return v;
      });

      // the magnification follows the pointer's position, not the item it's on — the neighbours move while the pointer moves
      // within one item: the pointer on item 2's left quarter, then its right quarter → item 1 / item 3 trade lift
      await cell("bar:continuous" + sfx, async () => {
        const v = [];
        await page(`${row}.scrollLeft = 0;`); await sleep(300);
        let s = await state();
        if (s.items.length < 3) return ["fewer than 3 items"];
        const b = s.items[1], y = b.y + b.h / 2;
        move(b.x + b.w * 0.25, y); await sleep(450);
        const L = (await state()).items.map((i) => amt(i.mag));
        for (let i = 1; i <= 10; i++) { move(b.x + b.w * (0.25 + 0.05 * i), y); await sleep(16); } // slide along the same item
        await sleep(450);
        const R = (await state()).items.map((i) => amt(i.mag));
        const st = await state();
        // amounts: fractions of the full magnification
        const f = (xs) => xs.slice(0, 4).map((x) => x.toFixed(3)).join(" ");
        console.log(`        left quarter: ${f(L)}  right quarter: ${f(R)} (of ×${g.full})`);
        if (!(L[0] > L[2] + 0.125)) v.push(`on item 2's left quarter item 1 (${L[0].toFixed(3)}) isn't magnified more than item 3 (${L[2].toFixed(3)})`);
        if (!(R[2] > R[0] + 0.125)) v.push(`on item 2's right quarter item 3 (${R[2].toFixed(3)}) isn't magnified more than item 1 (${R[0].toFixed(3)})`);
        if (!(L[1] > 0.81 && R[1] > 0.81)) v.push(`item 2 under the pointer magnifies only ${L[1].toFixed(3)} / ${R[1].toFixed(3)} of ×${g.full}`);
        if (Math.abs(L[1] - R[1]) > 0.0625) v.push(`item 2's own magnification differs left vs right (${L[1].toFixed(3)} vs ${R[1].toFixed(3)}): the curve isn't symmetric`);
        return v;
      });

      // the magnified item, at the PEAK of its bounce,
      // stays below the bar header's controls and inside the row (its clip) — sampled every frame through the rise
      // the first item sits at the row's left edge: magnified (the pointer on it) or a magnified neighbour's push must never cut it off
      await cell("bar:edge" + sfx, async () => {
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
        await shot("edge" + sfx);
        return v;
      });

      await cell("bar:headroom" + sfx, async () => {
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
        await shot("headroom" + sfx);
        g.peakRise = it.y - r.top; g.clear = r.top - r.ctlBottom;
        console.log(`        peak top ${r.top.toFixed(1)} (risen ${g.peakRise.toFixed(1)} px), header controls end ${r.ctlBottom.toFixed(1)} (${g.clear.toFixed(1)} px clear), row top ${r.rowTop.toFixed(1)}`);
        if (g.clear < CLEAR) v.push(`at its peak the item (top ${r.top.toFixed(1)}) comes within ${g.clear.toFixed(1)} px of the header's controls (bottom ${r.ctlBottom.toFixed(1)}; expected ≥ ${CLEAR})`);
        if (r.hit.length) v.push(`at its peak the item (top ${r.top.toFixed(1)}) runs into a header control above it (bottom ${r.hit.map((x) => x.toFixed(1))})`);
        if (r.top < r.rowTop + 1) v.push(`at its peak the item is clipped by the row's top (${r.top.toFixed(1)} vs ${r.rowTop.toFixed(1)})`);
        return v;
      });

      await cell("bar:leave" + sfx, async () => {
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

      // what a pointer sweep costs the renderer, read from Chromium's own trace (no rAF meter of ours): the dock's frame reads
      // cached geometry and the hovered item's glow reads the item's box once per dock frame, after the dock's writes — so no
      // script forces a layout, and the style recalc it does force (the glow's read) restyles only the moved items (--dock
      // doesn't inherit). The dock frame's live scrollLeft read adds one while a CSS transition runs (a hover change's glow
      // fade): style is dirty from the frame's animation update by then. A hover change re-renders only the items it moves
      // between (the hovered item lives outside PlaylistBar's state), counted through a React DevTools hook. Runs last: it
      // reloads the page with the hook installed (the next shape loads it again).
      await cell("bar:sweepCost" + sfx, async () => {
        const v = [];
        const d = win.webContents.debugger; if (!d.isAttached()) d.attach("1.3");
        // components that rendered per commit: a fiber not in the previous commit's tree (React cloned it) with PerformedWork
        // (flag 1) set — a cloned fiber that bailed out has it cleared
        await d.sendCommand("Page.enable");
        const { identifier } = await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
          const S = window.__rc = { on: false, commits: 0, renders: 0 }; let seen = new WeakSet();
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE() {},
            onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
            onCommitFiberRoot(id, root) { const next = new WeakSet(); let n = 0; const st = [root.current];
              while (st.length) { const x = st.pop(); next.add(x); if (!seen.has(x) && (x.flags & 1) && [0, 1, 11, 14, 15].includes(x.tag)) n++;
                if (x.child) st.push(x.child); if (x.sibling) st.push(x.sibling); }
              seen = next; if (S.on) { S.commits++; S.renders += n; } } };
        })();` });
        await win.loadURL(withToken(U + "/"));
        await d.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.pl-item').length`) >= 3) break; await sleep(100); }
        if (!(await js(`!!window.__rc`))) return ["the React DevTools hook wasn't installed before the page loaded"];
        win.setContentSize(1000, 800); move(5, 5); await sleep(1200);
        await page(`${row}.scrollLeft = 0;`); await sleep(300);
        const s = await state();
        const W = await js("innerWidth");
        const its = s.items.filter((i) => i.x + i.w < W);
        if (its.length < 3) return ["fewer than 3 items on screen"];
        const y = its[0].y + its[0].h / 2, x0 = its[0].x + 4, x1 = its[its.length - 1].x + its[its.length - 1].w - 4;
        const evs = []; let done;
        const onMsg = (_e, method, params) => { if (method === "Tracing.dataCollected") evs.push(...params.value); else if (method === "Tracing.tracingComplete") done(); };
        d.on("message", onMsg);
        await d.sendCommand("Performance.enable");
        const metrics = async () => Object.fromEntries((await d.sendCommand("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
        await page(`window.__rc.on = true; window.__hov = 0;
          window.__mo = new MutationObserver((ms) => { for (const m of ms) if (m.target.classList?.contains("hov") !== m.oldValue?.split(" ").includes("hov")) window.__hov++; });
          window.__mo.observe(${row}, { subtree: true, attributeFilter: ["class"], attributeOldValue: true });`);
        await d.sendCommand("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
        const m0 = await metrics();
        // the bar:sweep sweep (~60 moves/s, there and back), then a slow one (~4 moves per item pitch per frame-ish)
        for (let k = 0; k < 2; k++) for (let i = 0; i <= 60; i++) { const t = k ? 1 - i / 60 : i / 60; move(x0 + (x1 - x0) * t, y); await sleep(16); }
        for (let i = 0; i <= 150; i++) { move(x0 + (x1 - x0) * (i / 150), y); await sleep(16); }
        await sleep(600);
        const m1 = await metrics();
        const complete = new Promise((r) => { done = r; });
        await d.sendCommand("Tracing.end"); await complete;
        d.removeListener("message", onMsg);
        const rc = await page(`window.__rc.on = false; window.__mo.disconnect(); return { ...window.__rc, hov: window.__hov };`);
        // the renderer's main thread: the one that fired the dock's frames
        const by = new Map();
        for (const e of evs) if (e.name === "EventDispatch" && e.args?.data?.type === "dockframe") { const k = `${e.pid}:${e.tid}`; by.set(k, (by.get(k) || 0) + 1); }
        const main = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (!main) return ["no dock frame in the trace — the sweep proved nothing"];
        const xs = evs.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X").sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0));
        const SCRIPT = new Set(["FunctionCall", "EventDispatch", "FireAnimationFrame", "TimerFire", "FireIdleCallback", "EvaluateScript", "v8.callFunction"]);
        const whoS = {}; const stack = []; let frames = 0, fStyle = 0, fLayout = 0, styleN = 0, styleEls = 0, layoutN = 0, ioN = 0;
        for (const e of xs) {
          while (stack.length && stack[stack.length - 1].ts + (stack[stack.length - 1].dur || 0) <= e.ts) stack.pop();
          const forced = stack.some((p) => SCRIPT.has(p.name));
          if (e.name === "EventDispatch" && e.args?.data?.type === "dockframe") frames++;
          else if (e.name === "UpdateLayoutTree") { styleN++; styleEls += e.args?.elementCount || 0; if (forced) fStyle++;
            if (forced) { const p = [...stack].reverse().find((q) => SCRIPT.has(q.name)); const k = `${p.name}:${p.args?.data?.type || p.args?.data?.functionName || ""}@${p.args?.data?.lineNumber ?? ""}:${p.args?.data?.columnNumber ?? ""}`; whoS[k] = (whoS[k] || 0) + 1; } }
          else if (e.name === "Layout") { layoutN++; if (forced) fLayout++; }
          else if (e.name === "IntersectionObserverController::computeIntersections") ioN++;
          stack.push(e);
        }
        const per = (n) => (n / frames).toFixed(2);
        console.log(`        ${frames} dock frames: style recalcs ${styleN} (${fStyle} forced by script, ${per(fStyle)}/frame; ${per(styleEls)} elements/frame), layouts ${layoutN} (${fLayout} forced, ${per(fLayout)}/frame);`
          + ` metrics: RecalcStyleCount +${m1.RecalcStyleCount - m0.RecalcStyleCount}, LayoutCount +${m1.LayoutCount - m0.LayoutCount},`
          + ` IntersectionObserver passes ${ioN}, script ${Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000)} ms, task ${Math.round((m1.TaskDuration - m0.TaskDuration) * 1000)} ms`);
        console.log(`        forced recalcs by (script@line:col): ${JSON.stringify(whoS)}`);
        console.log(`        React: ${rc.commits} commits, ${rc.renders} component renders for ${rc.hov} .hov class toggles (${rc.hov ? (rc.renders / rc.hov).toFixed(1) : "-"} per toggle)`);
        if (frames < 40) v.push(`only ${frames} dock frames during the sweep — it proved nothing`);
        if (rc.hov < 2 * (its.length - 1)) v.push(`only ${rc.hov} hover changes across ${its.length} items — the sweep proved nothing`);
        if (fLayout > frames * 0.1) v.push(`script forced ${fLayout} layouts in ${frames} dock frames (expected ~0: the dock's geometry is cached and the glow reads after the dock writes)`);
        if (fStyle > frames * 1.7) v.push(`script forced ${fStyle} style recalcs in ${frames} dock frames (expected ~1 per frame — the glow's read after the dock's writes — plus one while a transition runs)`);
        if (styleEls > frames * 15) v.push(`${per(styleEls)} elements restyled per dock frame (expected only the moved items and the glow: --dock must not inherit)`);
        if (rc.hov && rc.renders / rc.hov > 6) v.push(`${(rc.renders / rc.hov).toFixed(1)} component renders per .hov toggle (expected only the items the hover moves between)`);
        return v;
      });
    }

    await cell("bar:shapes", async () => {
      const a = seen["1:1"], b = seen["16:9"];
      if (!a || !b) return ["a shape wasn't measured — proved nothing"];
      const v = [], off = (p, q) => Math.abs(p - q) / Math.max(Math.abs(p), Math.abs(q));
      console.log(`        bar ${a.barH.toFixed(1)} / ${b.barH.toFixed(1)} px tall; a neighbour moves ${a.push} / ${b.push} px sideways, lifts ${a.nLift} / ${b.nLift} px (Square / Widescreen)`);
      if (Math.abs(a.barH - b.barH) > 0.5) v.push(`the bar is ${a.barH.toFixed(1)} px tall at Square, ${b.barH.toFixed(1)} px at Widescreen (expected equal)`);
      if (!(a.push > 1 && b.push > 1 && a.nLift > 0.5 && b.nLift > 0.5)) return [...v, `the neighbour barely moved (${a.push} / ${b.push} px, lift ${a.nLift} / ${b.nLift}) — proved nothing`];
      if (off(a.push, b.push) > 0.15) v.push(`a neighbour moves ${a.push} px sideways at Square, ${b.push} px at Widescreen (expected within 15 %)`);
      if (off(a.nLift, b.nLift) > 0.15) v.push(`a neighbour lifts ${a.nLift} px at Square, ${b.nLift} px at Widescreen (expected within 15 %)`);
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
