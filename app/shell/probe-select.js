// Box (marquee) selection probe — `LIASCAPE_MATRIX_SCREEN=1920x1080 scripts/test-ui-matrix.sh --probe probe-select.js` (the
// matrix's hermetic stack; the 1080p screen is for the look:shot cells). A drag on the empty space of the Library / Browse grid
// draws a box and selects the cards it touches (app/ui/src/hooks/useMarquee.ts). Real input: webContents.sendInputEvent mouse
// drags, Ctrl / Shift clicks and keys. Every cell runs on both grids (<g> = lib | br); Browse is the Workshop source with the
// page's POST /browse, /detail and /download stubbed (no network: a "download" is only recorded in window.__dl).
//   <g>:box           a box selects exactly the cards it touches, lit live mid-drag; then a bulk action takes exactly those
//                     (Library: a selected card's playlist toggle adds them all to the playlist; Browse: "Download N")
//   <g>:ctrlClick     after a box, Ctrl+click adds a card, Ctrl+click on a boxed card removes it
//   <g>:shift         after a box drawn bottom-right → top-left, Shift+click ranges from the box's first card in reading order
//   <g>:ctrlDrag      Ctrl+drag adds the box to the selection; a plain drag afterwards replaces it
//   <g>:escape        Escape mid-drag restores the selection from before the drag (and the sidebar stays); the release after
//                     it changes nothing
//   <g>:autoscroll    held at the bottom edge the container scrolls and the box grows with it: the selection is exactly the
//                     cards under the box afterwards (cards that were off screen at the start included); the top edge scrolls up
//   <g>:tiny          a 2 px drag is a click: no box, the selection clears (the empty-space click)
//   <g>:fromCard      a drag that starts on a card draws no box and selects nothing
//   look:glow         the box: rounded corners, a translucent accent fill, the small glow; none under no-glow; still
//                     translucent under bg-live; the fill strengthens as it catches more cards
//   look:motion[:off] motion on: the box fades in and out (per-frame samples pass through in-between opacities); "Smooth window
//                     animations" off: the same short fade in and out (opacity only), never a pop
//   look:shot         1920×1080 screenshots of a box mid-drag: <LIASCAPE_OUT>/select-{lib,br}-middrag.png
//   perf:drag         a sweep over ~170 cards: no layout forced from script, the selection set at most once a frame, and only the
//                     cards whose selection flipped re-render (React's commit hook counts components that ran)
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
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
const J = JSON.stringify;
app.setPath("userData", path.join(OUT, "electron-user-data"));

const LIB_N = 166;      // library items the probe adds (copies of a clip): ~170 cards with the stack's own four
const BR_N = 72;        // fake Workshop items
// perf:drag budgets (counts, refresh- and GPU-independent)
const FORCED_MAX = 0;           // layouts forced from script over the whole drag
const RENDERS_PER_COMMIT = 4;   // per selection change: the view itself and the status line (measured 1–2)
const RENDERS_PER_FLIP = 12;    // a card whose `selected` flipped: the card, its thumb, toggle and icons (measured ~11) — one
                                // untouched card re-rendering per commit already breaks the budget

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : J(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);
async function setSettings(patch) { const s0 = (await http("GET", "/settings")).json; await post("/settings", { ...s0, ...patch }); }

// fake Workshop thumbnails in the stack's cache dir (/media serves only the app's own dirs)
const THUMBS = [];
function makeThumbs() {
  const d = path.join(E.XDG_CACHE_HOME || path.join(OUT, ".cache"), "liascape", "sel-thumbs"); fs.mkdirSync(d, { recursive: true });
  ["0x4c4f9a", "0x1f6f8b", "0x8b3a62", "0x2e7d4f", "0x9a6b2f", "0x5a2e8b"].forEach((c, i) => {
    const f = path.join(d, `t${i}.jpg`);
    require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `gradients=size=480x270:c0=${c}:c1=0x101018:seed=${i + 1}`,
      "-frames:v", "1", f], { timeout: 30000 });
    THUMBS.push(f);
  });
}

// React's DevTools hook (as probe-layout.js): counts the components that ran per commit, and the commits
const RC_HOOK = `(() => {
  const C = new Set([0, 1, 11, 14, 15]); const cur = new WeakSet(); window.__rc = { rendered: 0, mounted: 0, commits: 0 }; window.__rcWho = {};
  const who = (f) => { let h = f.child; while (h && typeof h.type !== "string") h = h.child;
    const k = h ? h.type + "." + String(h.memoizedProps?.className ?? "").split(" ")[0] : "?"; window.__rcWho[k] = (window.__rcWho[k] ?? 0) + 1; };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      window.__rc.commits++;
      const st = [root.current];
      while (st.length) {
        const f = st.pop();
        if (f.sibling) st.push(f.sibling);
        if (cur.has(f)) continue;
        cur.add(f); if (f.alternate) cur.delete(f.alternate);
        if (C.has(f.tag)) { if (!f.alternate) window.__rc.mounted++; else if (f.flags & 1) { window.__rc.rendered++; who(f); } }
        if (f.child) st.push(f.child);
      }
    } };
})();`;
// the Workshop source's network, stubbed before the page's scripts run
const stub = () => `(() => { window.__dl = []; const items = ${J(Array.from({ length: BR_N }, (_, i) => ({
  title: `ws-${String(i).padStart(2, "0")}`, thumbnailUrl: THUMBS[i % THUMBS.length], animatedThumbnailUrl: null,
  pageUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${920000 + i}`, resolution: "1920 x 1080", isScene: i % 4 === 0,
  workshopId: String(920000 + i), addedAt: null, description: "fake", authorName: "probe", fileSizeBytes: 1000, subscriptions: i, favorites: i,
  views: i, tags: ["Anime"] })))};
  const f = window.fetch; window.fetch = (u, o) => { const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    const ok = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
    const m = (o?.method || "GET") === "POST";
    if (p === "/browse" && m) { const b = JSON.parse(o.body); return ok(b.page > 1 ? [] : items); }
    if (p === "/detail" && m) { const b = JSON.parse(o.body); return ok({ title: b.result.title, previewUrl: b.result.thumbnailUrl, downloadUrl: "", needsReferrer: false }); }
    if (p === "/download" && m) { const b = JSON.parse(o.body); window.__dl.push(b.result.pageUrl); return ok({ skipped: true }); }
    return f(u, o); }; })();`;

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const send = (e) => win.webContents.sendInputEvent(e);
const PAGE = `window.__ms = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  sc() { return document.querySelector(".scroll"); },
  cards() { return [...this.sc().querySelectorAll(":scope > .grid > .card:not(.skel-card)")]; },
  // the cards (id = data-morph-id, client rect) and the grid's column count
  geo() { const sc = this.sc(), b = sc.getBoundingClientRect();
    return { cols: +getComputedStyle(sc).getPropertyValue("--cols") || 1, top: sc.scrollTop, sc: { x: b.x, y: b.y, w: sc.clientWidth, h: sc.clientHeight, b: b.y + sc.clientHeight },
      cards: this.cards().map((c) => { const r = c.getBoundingClientRect(); return { id: c.firstElementChild.dataset.morphId, x: r.x, y: r.y, r: r.right, b: r.bottom }; }) }; },
  sel() { return this.cards().filter((c) => c.classList.contains("selected")).map((c) => c.firstElementChild.dataset.morphId); },
  // watch for a box overlay appearing (cleared per call)
  watch() { window.__mqSeen = false; this.mo?.disconnect(); this.mo = new MutationObserver((l) => { for (const r of l) for (const n of r.addedNodes) if (n.classList?.contains("marquee-clip")) window.__mqSeen = true; });
    this.mo.observe(document.body, { childList: true }); },
  box() { const b = document.querySelector(".marquee"); if (!b) return null; const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
    return { w: r.width, h: r.height, op: +cs.opacity, radius: parseFloat(cs.borderTopLeftRadius), bs: cs.boxShadow, bg: cs.backgroundColor, fill: +getComputedStyle(b, "::before").opacity }; },
}; true`;
const page = (code) => js(`(async () => { const m = window.__ms; ${code} })()`);

async function tab(name) { await page(`m.byText(".tab", ${J(name)}).click();`); await sleep(900); }
async function shot(name) { const img = await win.webContents.capturePage(); const f = path.join(OUT, `${name}.png`); fs.writeFileSync(f, img.toPNG()); return f; }
async function resize(w, h) {
  win.setContentSize(w, h);
  for (let i = 0; i < 30; i++) { const [cw, ch] = await js(`[innerWidth, innerHeight]`); if (cw === w && ch === h) break; await sleep(50); }
  await sleep(600);
}
async function setMotion(on, back) {
  await tab("Settings");
  await page(`const find = () => [...document.querySelectorAll(".srow")].find((r) => r.querySelector(".slabel")?.textContent.includes("Smooth window animations"));
    for (let w = 0; w < 8000 && !find(); w += 100) await m.sleep(100);
    const row = find(); if (!row) throw new Error("no Smooth window animations row");
    const cb = row.querySelector("input[type=checkbox]"); if (cb.checked !== ${on}) cb.click(); await m.sleep(500);`);
  await back();
}

const geo = () => page(`return m.geo();`);
const sel = () => page(`return m.sel();`);
const mid = (c) => ({ x: Math.round((c.x + c.r) / 2), y: Math.round((c.y + c.b) / 2) });
// the gap between card i and the next one in its row (the grid's own empty space)
const gap = (g, i) => ({ x: Math.round((g.cards[i].r + g.cards[i + 1].x) / 2), y: Math.round((g.cards[i].y + g.cards[i].b) / 2) });
const mods = (o) => [...(o.ctrl ? ["control"] : []), ...(o.shift ? ["shift"] : [])];
async function press(at, o = {}) {
  send({ type: "mouseMove", x: at.x, y: at.y, modifiers: mods(o) }); await sleep(40);
  send({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1, modifiers: mods(o) }); await sleep(60);
  send({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1, modifiers: mods(o) }); await sleep(500);
}
// a held drag: down at a, `steps` moves to b (one per ~frame); `held` runs before the release (if `up`)
async function drag(a, b, o = {}) {
  const md = mods(o), steps = o.steps ?? 12;
  send({ type: "mouseMove", x: a.x, y: a.y, modifiers: md }); await sleep(60);
  send({ type: "mouseDown", x: a.x, y: a.y, button: "left", clickCount: 1, modifiers: md }); await sleep(40);
  for (let s = 1; s <= steps; s++) {
    send({ type: "mouseMove", x: Math.round(a.x + (b.x - a.x) * s / steps), y: Math.round(a.y + (b.y - a.y) * s / steps), button: "left", modifiers: [...md, "leftButtonDown"] });
    await sleep(17);
  }
  await sleep(o.hold ?? 120);
  const r = o.held ? await o.held() : undefined;
  if (o.up !== false) { send({ type: "mouseUp", x: b.x, y: b.y, button: "left", clickCount: 1, modifiers: md }); await sleep(o.after ?? 350); }
  return r;
}
const up = async (b) => { send({ type: "mouseUp", x: b.x, y: b.y, button: "left", clickCount: 1 }); await sleep(350); };
async function key(k) { send({ type: "keyDown", keyCode: k }); await sleep(40); send({ type: "keyUp", keyCode: k }); await sleep(250); }
// nothing selected, no sidebar, scrolled to the top, the pointer parked off the grid
async function reset() {
  send({ type: "mouseMove", x: 3, y: 3 });
  await key("Escape"); await sleep(400);
  if ((await sel()).length) await key("Escape");
  await page(`m.sc().scrollTop = 0;`); await sleep(500);
}
const same = (a, b) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
const fmt = (ids, g) => `[${ids.map((id) => g.cards.findIndex((c) => c.id === id)).join(",")}]`;
// the cards a client-space box touches, from fresh rects
const touched = (g, l, t, r, b) => g.cards.filter((c) => c.x < r && c.r > l && c.y < b && c.b > t).map((c) => c.id);

// the box over card 1..2 of row 0 and row 1: down in the gap after card 0, released over card cols+2 — 4 cards
function box4(g) {
  return { a: gap(g, 0), b: mid(g.cards[g.cols + 2]), want: [1, 2, g.cols + 1, g.cols + 2].map((i) => g.cards[i].id) };
}

function gridCells(cell, G) {
  const n = G.key;
  cell(`${n}:box`, async () => {
    const v = [];
    await G.enter(); await reset();
    const g = await geo();
    const { a, b, want } = box4(g);
    const live = await drag(a, b, { held: () => page(`return { sel: m.sel(), box: m.box() };`) });
    if (!same(live.sel, want)) v.push(`mid-drag the lit cards are ${fmt(live.sel, g)}, want ${fmt(want, g)} (the box over cards 1, 2, ${g.cols + 1}, ${g.cols + 2})`);
    if (!live.box || live.box.w < 20 || live.box.h < 20) v.push(`no box drawn mid-drag (${J(live.box)})`);
    await sleep(300);
    const after = await sel();
    if (!same(after, want)) v.push(`after the release the selection is ${fmt(after, g)}, want ${fmt(want, g)}`);
    if (await page(`return !!document.querySelector(".marquee-clip");`)) v.push("the box is still on screen after the release");
    if (v.length) return v;
    v.push(...await G.bulk(g, want));
    return v;
  });
  cell(`${n}:ctrlClick`, async () => {
    const v = [];
    await G.enter(); await reset();
    const g = await geo();
    const { a, b, want } = box4(g);
    await drag(a, b);
    if (!same(await sel(), want)) return [`the box selected ${fmt(await sel(), g)}, want ${fmt(want, g)}`];
    const extra = g.cards[2 * g.cols + 4].id, drop = g.cards[2].id;
    // the card's centre, scrolled into view first: the first click docks the sidebar, the grid re-fits its columns and
    // keepCardInView (hooks/gridKeys.ts) holds the clicked card under the pointer — which can scroll row 0 above the
    // container. A press there lands on the top bar and toggles nothing, so the point must hit the card itself.
    const at = async (id) => {
      const p = await page(`const c = m.cards().find((x) => x.firstElementChild.dataset.morphId === ${J(id)}); if (!c) return null;
        c.scrollIntoView({ block: "nearest" }); await m.sleep(400);
        const r = c.getBoundingClientRect(), x = Math.round((r.left + r.right) / 2), y = Math.round((r.top + r.bottom) / 2);
        return { x, y, hit: c.contains(document.elementFromPoint(x, y)) };`);
      if (!p?.hit) throw new Error(`card ${fmt([id], g)} can't be clicked (${J(p)}): the Ctrl+click would prove nothing`);
      return p;
    };
    await press(await at(extra), { ctrl: true });
    const s1 = await sel(), w1 = [...want, extra];
    if (!same(s1, w1)) v.push(`Ctrl+click on card ${2 * g.cols + 4} after the box: ${fmt(s1, g)}, want ${fmt(w1, g)}`);
    await press(await at(drop), { ctrl: true });
    const s2 = await sel(), w2 = w1.filter((x) => x !== drop);
    if (!same(s2, w2)) v.push(`Ctrl+click on the boxed card 2: ${fmt(s2, g)}, want ${fmt(w2, g)}`);
    return v;
  });
  cell(`${n}:shift`, async () => {
    const v = [];
    await G.enter(); await reset();
    const g = await geo(), c = g.cols;
    // bottom-right → top-left: from the gap after card c+3 (row 1) to over card 1 (row 0); its first card in reading order is 1
    const a = gap(g, c + 3), b = mid(g.cards[1]);
    await drag(a, b);
    const boxed = [1, 2, 3, c + 1, c + 2, c + 3].map((i) => g.cards[i].id);
    const s0 = await sel();
    if (!same(s0, boxed)) return [`the box selected ${fmt(s0, g)}, want ${fmt(boxed, g)}`];
    const to = g.cards[3 * c].id;
    await press(mid((await geo()).cards.find((x) => x.id === to)), { shift: true });
    const s1 = await sel(), want = g.cards.slice(1, 3 * c + 1).map((x) => x.id);
    if (!same(s1, want)) v.push(`Shift+click on card ${3 * c} after the box: ${fmt(s1, g)}, want the range 1…${3 * c} (from the box's first card)`);
    return v;
  });
  cell(`${n}:ctrlDrag`, async () => {
    const v = [];
    await G.enter(); await reset();
    let g = await geo();
    const x = g.cards[3 * g.cols + 5].id;
    await press(mid(g.cards[3 * g.cols + 5]), { ctrl: true });
    await page(`m.sc().scrollTop = 0;`); await sleep(500);
    g = await geo(); // the docked sidebar re-fitted the columns
    const { a, b, want } = box4(g);
    await drag(a, b, { ctrl: true });
    const s1 = await sel();
    if (!same(s1, [x, ...want])) v.push(`Ctrl+drag: ${fmt(s1, g)}, want the earlier card plus the box ${fmt([x, ...want], g)}`);
    // a plain drag replaces: the box over cards 2·cols+1, 2·cols+2
    const a2 = gap(g, 2 * g.cols), b2 = mid(g.cards[2 * g.cols + 2]);
    await drag(a2, b2);
    const s2 = await sel(), w2 = [2 * g.cols + 1, 2 * g.cols + 2].map((i) => g.cards[i].id);
    if (!same(s2, w2)) v.push(`a plain drag after it: ${fmt(s2, g)}, want only its box ${fmt(w2, g)}`);
    return v;
  });
  cell(`${n}:escape`, async () => {
    const v = [];
    await G.enter(); await reset();
    let g = await geo();
    const x = g.cards[3 * g.cols + 5].id;
    await press(mid(g.cards[3 * g.cols + 5]), { ctrl: true });
    await page(`m.sc().scrollTop = 0;`); await sleep(500);
    g = await geo();
    const { a, b, want } = box4(g);
    const r = await drag(a, b, { up: false, held: async () => {
      const live = await sel();
      await key("Escape");
      return { live, after: await sel(), box: await page(`return !!document.querySelector(".marquee:not(.out)");`), side: await js(`document.querySelector(".side-panel:not(.closing)")?.dataset.sideId ?? null`) };
    } });
    await up(b);
    const end = await sel();
    if (!same(r.live, want)) v.push(`mid-drag (a plain drag replaces) ${fmt(r.live, g)}, want ${fmt(want, g)} — proved nothing`);
    if (!same(r.after, [x])) v.push(`after Escape: ${fmt(r.after, g)}, want the selection before the drag ${fmt([x], g)}`);
    if (r.box) v.push("the box stayed after Escape");
    if (!r.side) v.push("Escape during the drag closed the item sidebar (it belongs to the box)");
    if (!same(end, [x])) v.push(`after the release: ${fmt(end, g)}, want ${fmt([x], g)} (the release must not clear it)`);
    return v;
  });
  cell(`${n}:autoscroll`, async () => {
    const v = [];
    await G.enter(); await reset();
    const g = await geo();
    const a = gap(g, 0), visible = g.cards.filter((c) => c.b <= g.sc.b).length;
    const b = { x: mid(g.cards[g.cols + 2]).x, y: Math.round(g.sc.b - 8) };
    await drag(a, b, { hold: 1500, up: false });
    const r = await page(`return { top: m.sc().scrollTop };`);
    await up(b);
    const g2 = await geo(), s = await sel();
    // the box in client space now: from the start point (moved up by the scroll) to the release point
    const want = touched(g2, Math.min(a.x, b.x), a.y - g2.top, Math.max(a.x, b.x), b.y);
    if (r.top < 150) v.push(`held at the bottom edge for 1.5 s the container scrolled only ${r.top.toFixed(0)} px — proved nothing`);
    const deep = s.filter((id) => g.cards.findIndex((c) => c.id === id) >= visible).length;
    if (!deep) v.push(`no card below the first screen (${visible} cards) got selected`);
    if (!same(s, want)) v.push(`the selection ${fmt(s, g2)} isn't the cards under the box ${fmt(want, g2)}`);
    // the top edge: back up
    const a2 = gap(g2, g2.cards.findIndex((c) => c.y > g2.sc.y + g2.sc.h / 2)), b2 = { x: a2.x + 30, y: Math.round(g2.sc.y + 6) };
    const top0 = g2.top;
    await drag(a2, b2, { hold: 700, up: false });
    const top1 = await page(`return m.sc().scrollTop;`);
    await up(b2);
    if (!(top1 < top0 - 100)) v.push(`held at the top edge the container went ${top0.toFixed(0)} → ${top1.toFixed(0)} (want it to scroll up)`);
    return v;
  });
  cell(`${n}:tiny`, async () => {
    const v = [];
    await G.enter(); await reset();
    const g = await geo();
    const { a, b, want } = box4(g);
    await drag(a, b);
    if (!same(await sel(), want)) return [`the box selected ${fmt(await sel(), g)} — proved nothing`];
    await page(`m.watch();`);
    const t = gap(g, 2 * g.cols + 1);
    await drag(t, { x: t.x + 2, y: t.y + 1 }, { steps: 2 });
    if (await js(`window.__mqSeen`)) v.push("a 2 px drag drew a box");
    const s = await sel();
    if (s.length) v.push(`a 2 px drag on the empty space left ${fmt(s, g)} selected (it's a click: clears)`);
    return v;
  });
  cell(`${n}:fromCard`, async () => {
    const v = [];
    await G.enter(); await reset();
    const g = await geo();
    await page(`m.watch();`);
    const a = mid(g.cards[g.cols + 1]), b = mid(g.cards[2 * g.cols + 3]);
    await drag(a, b, { steps: 14 });
    await sleep(300);
    if (await js(`window.__mqSeen`)) v.push("a drag starting on a card drew a box");
    const s = await sel();
    if (s.length) v.push(`a drag starting on a card selected ${fmt(s, g)}`);
    return v;
  });
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  const results = [];
  const queue = [];
  const cell = (name, fn) => queue.push([name, fn]);
  const run = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  try {
    makeThumbs();
    await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false, autoPlayGifs: false });
    const srcs = (await http("GET", "/sources")).json;
    const wsName = srcs.find((s) => s.supportsTagFilter)?.name;
    if (!wsName) throw new Error("no Workshop source (supportsTagFilter) in /sources");
    // the library: ~170 cards
    const dir = path.join(OUT, "sel-lib"); fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (let i = 0; i < LIB_N; i += 8) {
      const got = await Promise.all(Array.from({ length: Math.min(8, LIB_N - i) }, async (_, j) => {
        const f = path.join(dir, `s${i + j}.mp4`); fs.copyFileSync(K[K.length - 1], f);
        return (await post("/library/import", { path: f, title: `sel ${String(i + j).padStart(3, "0")}` })).json?.videoPath;
      }));
      n += got.filter(Boolean).length;
    }
    if (n < LIB_N) throw new Error(`imported ${n} of ${LIB_N}`);
    await post("/playlist/state", { videoPaths: [], settings: null, name: null });
    await win.loadURL(withToken(U + "/")); // a page first: the debugger's Page domain needs a renderer
    const d = win.webContents.debugger; d.attach("1.3"); await d.sendCommand("Page.enable");
    await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: RC_HOOK + stub() });
    await win.loadURL(withToken(U + "/"));
    for (let i = 0; i < 150; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
    await js(PAGE); await sleep(800);

    // (the Library's grid stays in the document, hidden, while another tab shows: App.tsx)
    const LIB = { key: "lib", async enter() { if (!(await js(`!!document.querySelector(".lib-scroll")?.offsetParent`))) await tab("Library"); },
      // a selected card's playlist toggle adds the whole selection
      async bulk(g, want) {
        const at = await page(`const t = m.cards().find((c) => c.firstElementChild.dataset.morphId === ${J(want[0])}).querySelector(".pl-toggle").getBoundingClientRect();
          return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };`);
        await press(at);
        const paths = want.map((id) => id.slice(4));
        let pl = [];
        for (let i = 0; i < 30 && !same(pl, paths); i++) { await sleep(100); pl = (await http("GET", "/playlist/state")).json?.videoPaths ?? []; }
        return same(pl, paths) ? [] : [`the playlist toggle on a boxed card: the playlist holds ${pl.length} (${pl.filter((p) => !paths.includes(p)).length} not boxed), want exactly the ${paths.length} boxed`];
      } };
    const BR = { key: "br", async enter() {
        if (await js(`!!document.querySelector(".scroll:not(.lib-scroll) .card.lib")`)) return;
        await tab("Browse"); await page(`m.byText(".pill", ${J(wsName)})?.click();`);
        for (let i = 0; i < 60 && (await js(`document.querySelectorAll(".scroll:not(.lib-scroll) .card.lib:not(.skel-card)").length`)) < BR_N; i++) await sleep(100);
        await sleep(500);
      },
      // the selection toolbar's Download N: the (stubbed) /download gets exactly the boxed cards
      async bulk(g, want) {
        await js(`window.__dl = []`);
        const lbl = await page(`const b = [...document.querySelectorAll(".sel-toolbar button")].find((x) => x.textContent.startsWith("Download")); if (!b) return null; b.click(); return b.textContent;`);
        await sleep(800);
        const got = await js(`window.__dl`), urls = want.map((id) => id.slice(3));
        if (lbl !== `Download ${want.length}`) return [`the selection toolbar says "${lbl}", want "Download ${want.length}"`];
        return same(got, urls) ? [] : [`Download ${want.length} asked for ${got.length} (${got.filter((u) => !urls.includes(u)).length} not boxed), want exactly the boxed`];
      } };
    gridCells(cell, LIB);
    gridCells(cell, BR);

    cell("look:glow", async () => {
      const v = [];
      await LIB.enter(); await reset();
      const g = await geo();
      const r = await drag(gap(g, 0), mid(g.cards[1]), { up: false, held: () => page(`const one = m.box(); return one;`) });
      // grow it over ~3 rows × 4 cards: the fill strengthens
      const b2 = mid(g.cards[2 * g.cols + 4]);
      send({ type: "mouseMove", x: b2.x, y: b2.y, button: "left", modifiers: ["leftButtonDown"] }); await sleep(400);
      const big = await page(`return m.box();`);
      const ng = await page(`const root = document.documentElement; root.classList.add("no-glow"); await m.sleep(60); const b = m.box(); root.classList.remove("no-glow");
        root.classList.add("bg-live"); await m.sleep(60); const l = m.box(); root.classList.remove("bg-live"); return { ng: b, live: l };`);
      await up(b2);
      if (!r || !big) return ["no box mid-drag — proved nothing"];
      // rgb(r, g, b) / rgba(r, g, b, a) / color(srgb r g b / a)
      const alpha = (c) => { const m = /\/\s*([\d.]+)\s*\)$/.exec(c) ?? /rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(c); return m ? +m[1] : 1; };
      if (!(r.radius >= 4)) v.push(`the box's corners aren't rounded (${r.radius} px)`);
      if (!(alpha(r.bg) > 0 && alpha(r.bg) < 0.3)) v.push(`the box's fill isn't a translucent accent (${r.bg})`);
      if (!/12px/.test(r.bs)) v.push(`glows on: no glow around the box (${r.bs})`);
      if (/12px/.test(ng.ng?.bs ?? "")) v.push(`no-glow: the box still glows (${ng.ng?.bs})`);
      if (!(alpha(ng.live?.bg ?? "") < 0.3) || !(ng.live?.op > 0.9)) v.push(`bg-live: the box isn't a visible translucent wash (${J(ng.live)})`);
      if (!(big.fill > r.fill + 0.3)) v.push(`the fill didn't strengthen with the cards caught (1 card: ${r.fill}, ${2 * 4 + 4}+: ${big.fill})`);
      return v;
    });
    // per-frame opacity of the box from the press to after the release
    const motionRun = async () => {
      await LIB.enter(); await reset();
      const g = await geo();
      await js(`window.__mf = []; (() => { const t0 = performance.now(); const f = () => { const b = document.querySelector(".marquee");
        window.__mf.push([Math.round(performance.now() - t0), b ? +getComputedStyle(b).opacity : null]); if (performance.now() - t0 < 2500) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
      const a = gap(g, 0), b = mid(g.cards[g.cols + 2]);
      await drag(a, b, { after: 900 });
      return { s: await js(`window.__mf`) };
    };
    cell("look:motion", async () => {
      const v = [];
      const { s } = await motionRun();
      const shown = s.filter((x) => x[1] != null);
      if (!shown.length) return ["no box in any frame — proved nothing"];
      const iIn = s.findIndex((x) => x[1] != null), iOut = s.findLastIndex((x) => x[1] != null);
      const fadeIn = s.slice(iIn, iIn + 8).filter((x) => x[1] > 0.02 && x[1] < 0.98);
      const fadeOut = s.slice(Math.max(0, iOut - 12), iOut + 1).filter((x) => x[1] > 0.02 && x[1] < 0.98);
      if (!fadeIn.length) v.push(`motion on: the box popped in (first frames ${J(s.slice(iIn, iIn + 4))})`);
      if (!fadeOut.length) v.push(`motion on: the box popped out (last frames ${J(s.slice(Math.max(0, iOut - 4), iOut + 2))})`);
      return v;
    });
    cell("look:motion:off", async () => {
      const v = [];
      await setMotion(false, () => LIB.enter());
      try {
        const { s } = await motionRun();
        const shown = s.filter((x) => x[1] != null);
        if (!shown.length) return ["no box in any frame — proved nothing"];
        // the same fade in and out as with motion on (opacity only; the box itself follows the pointer), never a pop
        const iIn = s.findIndex((x) => x[1] != null), iOut = s.findLastIndex((x) => x[1] != null);
        const fadeIn = s.slice(iIn, iIn + 8).filter((x) => x[1] > 0.02 && x[1] < 0.98);
        const fadeOut = s.slice(Math.max(0, iOut - 12), iOut + 1).filter((x) => x[1] > 0.02 && x[1] < 0.98);
        if (!fadeIn.length) v.push(`motion off: the box popped in (first frames ${J(s.slice(iIn, iIn + 4))})`);
        if (!fadeOut.length) v.push(`motion off: the box popped out (last frames ${J(s.slice(Math.max(0, iOut - 4), iOut + 2))})`);
      } finally { await setMotion(true, () => LIB.enter()); }
      return v;
    });
    cell("look:shot", async () => {
      const v = [];
      await resize(1920, 1080);
      for (const G of [LIB, BR]) {
        await G.enter(); await reset();
        const g = await geo();
        await drag(gap(g, 0), mid(g.cards[2 * g.cols + 3]), { up: false, hold: 450, held: async () => console.log(`        shot: ${await shot(`select-${G.key}-middrag`)}`) });
        await up(mid(g.cards[2 * g.cols + 3]));
      }
      await resize(1400, 900);
      return v;
    });
    // A sweep across the Library grid under a trace: the drag grows and shrinks the box over ~4 rows. Forced layouts (a Layout
    // inside a JS call outside a rAF / ResizeObserver callback), React commits and rendered components, the cards whose
    // `selected` flipped (a class MutationObserver), the frames the drag spanned.
    cell("perf:drag", async () => {
      const v = [];
      await LIB.enter(); await reset();
      const g = await geo();
      if (g.cards.length < 150) return [`only ${g.cards.length} cards — proved nothing`];
      const a = gap(g, 0), b = mid(g.cards[3 * g.cols + Math.min(5, g.cols - 1)]), c = mid(g.cards[g.cols + 1]);
      send({ type: "mouseMove", x: a.x, y: a.y }); await sleep(300);
      await js(`window.__fl = 0; window.__fr = 0; window.__mo?.disconnect(); window.__mo = new MutationObserver((l) => { for (const r of l)
        if ((r.oldValue ?? "").includes(" selected") !== r.target.classList.contains("selected")) window.__fl++; });
        window.__mo.observe(document.querySelector(".lib-scroll > .grid"), { attributes: true, attributeFilter: ["class"], attributeOldValue: true, subtree: true }); true`);
      const dbg = win.webContents.debugger;
      const evs = [];
      const onMsg = (_e, method, params) => { if (method === "Tracing.dataCollected") evs.push(...params.value); };
      dbg.on("message", onMsg);
      const rc0 = await js(`(window.__rcWho = {}, { ...window.__rc })`);
      await dbg.sendCommand("Tracing.start", { traceConfig: { includedCategories: ["toplevel", "blink", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.stack", "v8.execute"] }, transferMode: "ReportEvents" });
      const frames0 = await js(`window.__fr0 = 0; (() => { let on = true; window.__frStop = () => { on = false; }; const f = () => { if (!on) return; window.__fr0++; requestAnimationFrame(f); }; requestAnimationFrame(f); })(); 0`);
      await drag(a, b, { steps: 30, up: false, hold: 50 });
      for (let s = 1; s <= 20; s++) { send({ type: "mouseMove", x: Math.round(b.x + (c.x - b.x) * s / 20), y: Math.round(b.y + (c.y - b.y) * s / 20), button: "left", modifiers: ["leftButtonDown"] }); await sleep(17); }
      await up(c);
      const frames = (await js(`window.__frStop(); window.__fr0`)) - frames0;
      const rc1 = await js(`({ ...window.__rc, who: Object.entries(window.__rcWho).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + "×" + n).join(", ") })`);
      const done = new Promise((res) => { const h = (_e, m2) => { if (m2 === "Tracing.tracingComplete") { dbg.removeListener("message", h); res(); } }; dbg.on("message", h); });
      await dbg.sendCommand("Tracing.end"); await done; dbg.removeListener("message", onMsg);
      const flips = await js(`window.__mo.disconnect(), window.__fl`);
      const names = {}; for (const e of evs) if (e.name === "thread_name") names[`${e.pid}:${e.tid}`] = e.args.name;
      const runs = {}; for (const e of evs) { const k = `${e.pid}:${e.tid}`; if (names[k] === "CrRendererMain" && e.name === "RunTask" && e.dur) runs[k] = (runs[k] ?? 0) + e.dur; }
      const main = Object.entries(runs).sort((x, y) => y[1] - x[1])[0]?.[0];
      const on = evs.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X");
      const JSN = new Set(["FunctionCall", "EventDispatch", "TimerFire", "RunMicrotasks", "v8.callFunction", "EvaluateScript"]);
      const inside = (e, spans) => spans.some((j) => e.ts >= j.ts && e.ts < j.ts + j.dur);
      const jsSpans = on.filter((e) => JSN.has(e.name));
      const frameCbs = on.filter((e) => e.name === "FireAnimationFrame" || e.name === "LocalFrameView::NotifyResizeObservers");
      const forced = on.filter((e) => e.name === "Layout" && inside(e, jsSpans) && !inside(e, frameCbs));
      const forcedBy = forced.map((e) => { const f = e.args?.beginData?.stackTrace?.[0]; return f ? `${f.functionName || "?"}@${String(f.url).split("/").pop()}:${f.lineNumber}:${f.columnNumber}` : "?"; }).join(", ");
      const commits = rc1.commits - rc0.commits, rendered = rc1.rendered - rc0.rendered;
      console.log(`        drag: ${frames} frames, ${commits} commits, ${flips} card flips, ${rendered} components rendered (${(rendered / Math.max(1, frames)).toFixed(1)} per frame) — most: ${rc1.who}; ${forced.length} forced layouts${forced.length ? ` (${forcedBy})` : ""}`);
      if (flips < 10) v.push(`only ${flips} cards flipped selection — proved nothing`);
      if (forced.length > FORCED_MAX) v.push(`${forced.length} layouts forced from script (≤ ${FORCED_MAX}): ${forcedBy}`);
      if (commits > frames) v.push(`${commits} React commits over ${frames} frames (the selection is set at most once a frame)`);
      const budget = RENDERS_PER_COMMIT * commits + RENDERS_PER_FLIP * flips;
      if (rendered > budget) v.push(`${rendered} components rendered (≤ ${budget} = ${RENDERS_PER_COMMIT}/commit + ${RENDERS_PER_FLIP}/flipped card: untouched cards must not) — most: ${rc1.who}`);
      return v;
    });

    for (const [name, fn] of queue) await run(name, fn);
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`SELECT pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "select.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
