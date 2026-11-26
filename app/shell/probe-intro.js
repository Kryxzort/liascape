// The window's opening probe — `scripts/test-ui-matrix.sh --probe probe-intro.js` (the matrix's hermetic stack). The app
// logo plays once when the shell opens a window (app/shell/main.js adds `?intro`; app/ui/index.html draws it in the page's
// first frame, app/ui/src/components/Intro.tsx plays the rest). Every cell opens a NEW window (a fresh sessionStorage, as a
// new app window has) and samples the overlay per animation frame from the page's first script on (a sampler injected
// before the page's own scripts); "the logo starts" = the first frame it shows in.
//   intro:absent      a page loaded without `?intro` (every other probe, a browser tab): no overlay ever
//   intro:firstFrame  the window's frames as Chromium draws them (a CDP screencast from before the navigation): the first
//                     frame of the page is the logo on its cover, and so is every frame up to the cover opening (no blank
//                     or ground-only frame, no logo popping in late). Screenshot intro-firstFrame.png (that frame)
//   intro:plays       motion on: the logo, its picture inline (nothing to load), whole from the first frame and scaling in
//                     through in-between frames, its accent ring ripples out, then the ground dissolves (in-between
//                     opacities); only opacity / scale / transform animate; the halo glows (Glow effects on). Every cell's
//                     deadlines: the overlay never takes a pointer event, the UI shows through (the ground under half) by
//                     SEE_MS after the logo starts and by USABLE_MS after the page's navigation began, the overlay is gone
//                     by END_MS after the logo starts. Screenshots intro-plays-{in,mid,open}.png
//   intro:slowData    the first data in after the old 700 ms hold but within HOLD_MAX_MS of the logo (a stubbed /settings,
//                     answered SLOW_DATA_MS after the logo's first frame; the 8-screen library): the hand-over plays, not
//                     the lift
//   intro:cards       the hand-over, on a library of 8 screens (a stubbed /library): as the ground dissolves no card of the
//                     Library shows; the logo splits into one tile per card of its first row (all of them, in its order),
//                     the tiles together covering the whole logo box; each glides through in-between places, lands on its
//                     card's box as drawn in the same frame (within LAND_PX), its card showing only under it, and fades out
//                     over it; the tiles glow (Glow effects on). Then the other cards in view join in reading order (each
//                     one's first shown frame no earlier than the one before it, row by row, left to right, over several
//                     frames, each fading in and rising: first shown below its place, then past it upward, then on it),
//                     after the first row's first card; every card in view ends shown and on top at its centre; the
//                     overlay is gone within END_CARDS_MS. Screenshots
//                     intro-cards-{split,mid,land,cascade}.png
//   intro:fewCards    a library of 2 (a stubbed /library): 2 tiles, each landing on its card
//   intro:fallback:empty  an empty library (a stubbed /library): no tiles, the logo lifts away (grows, fades) as before
//   intro:fallback:tab    another page showing when the cover dissolves (Browse, opened by a script's click): no tiles, the
//                     logo lifts away
//   intro:fallback:late   the first data not in by HOLD_MAX_MS (a stubbed /settings, answered 2.4 s late): the cover
//                     dissolves anyway (no earlier than HELD_MS), no tiles, the logo lifts away, within the HOLD_MAX_MS deadlines
//   intro:once        the same window loaded again with `?intro` (a reload: Vite's, the renderer recovery's): nothing plays
//   intro:click       a Ctrl+click on a card of the second row before it has joined (the 8-screen library): the card is
//                     selected at once, and the opening plays on to its end (the same hand-over and reading order, the
//                     overlay gone no earlier than its own timeline)
//   intro:key         Ctrl+A while the tiles fly: every card is selected at once, and the opening plays on to its end
//   intro:scroll      the grid scrolled (a wheel) while the tiles fly: the tiles land on their cards where they are now, and
//                     no card in view is left hidden once the opening ends
//   intro:clickThrough a click on the Settings tab while the cover dissolves: the tab opens, the opening plays on
//   intro:off         "Smooth window animations" off (at the window before: the next one plays still): the logo whole and
//                     still in the window's first drawn frame (the screencast), then it and the ground fade out in place,
//                     nothing moves or resizes, only opacity animates (app/shell/motion-off.js), no ring, no tiles, and the
//                     cards show throughout (no hidden grid, no joining)
//   intro:reduced     the same under prefers-reduced-motion, read at once
//   look:toggles      Glow effects off + the live wallpaper behind every tab: no accent halo on the logo or the tiles (the
//                     depth shadows stay), the tiles still hand over, the ground covers the wallpaper and the UI until it
//                     dissolves; screenshots intro-toggles-{mid,cards}.png
//   look:themePartial a kept theme missing colours: the opening plays, in the default theme's colours
//   look:theme        a light theme (Catppuccin Latte, at the window before): the ground in the theme's colour from its
//                     first frame (the store's kept theme, applied by index.html), the Lavender logo, the ring in the
//                     accent; screenshot intro-theme-mid.png
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const MO = require("./motion-off");
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
app.setPath("userData", path.join(OUT, "electron-user-data"));

const MID = 3;           // in-between frames a fade or a scale must show (the matrix's Xvfb runs at 60 Hz)
const SEE_MS = 600;      // from the logo's start to the ground under half (Intro.tsx REVEAL_MS 320 + ~130 ms of its ease-out
                         // fade + timer and frame slack on the software-rendered stack; measured ~460)
const END_MS = 900;      // from the logo's start to the overlay gone (REVEAL_MS 320 + OUT_MS 320 + slack for the software-rendered stack)
const END_CARDS_MS = 1700; // the same with the hand-over and the cards rising (REVEAL_MS 320 + Intro.tsx timeline() about
                         // 1080 for 6 columns by 5 rows in view + slack for the software-rendered stack)
const RISE_BELOW = 10;   // px: a rising card's first shown frame sits this far below its place, at least (Intro.tsx RISE_PX 24;
                         // a card growing in from 0.88 alone starts its top only about 8 px lower)
const OVER_PX = 0.75;    // px: past its place by more than this (the measurement's resolution), it overshot
const SETTLE_PX = 0.5;   // px: on its place at the end
const USABLE_MS = 2500;  // from the page's navigation start to the UI showing through: the user's whole wait
const LATE = { see: 1550, end: 1750 }; // the same two with the cover opening at HOLD_MAX_MS 1200 instead of REVEAL_MS
const LAND_PX = 3;       // a landed tile on its card's box: subpixel layout and a frame's last spring residue
const HELD_MS = 1100;    // the cover opening later than this after the logo started: it waited for HOLD_MAX_MS (1200)
const SLOW_DATA_MS = 1050; // intro:slowData's first data, this long after the logo's first frame: after the old hold (700 ms
                         // from a logo the app's code drew, about 200 ms after the page's first frame) and within HOLD_MAX_MS
const FIRST_MS = 280;    // the first drawn frames judged: up to here the cover is closed whatever the data does
const LOGO_PART = 0.5;   // a screencast frame shows the logo when this share of its middle differs from the ground beside it
const SHOWN = 0.05;      // a card's opacity as seen above this: shown
const END_SETTLE_MS = 100; // the cards all shown this long after the overlay went (a few frames of animation start and timer slack)

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : J(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
async function setSettings(patch) { const s0 = (await http("GET", "/settings")).json; await http("POST", "/settings", { ...s0, ...patch }); }

// per animation frame from the document's first script, for 3 s: the overlay's phase, whether the window's centre hits it,
// the ground's colours on its first frame, and for each part its first rendered match as motion-off.js records it ([t, opacity as seen, x, y, w, h] / [t, null]).
// `t` = ms since the page's navigation began (performance.now's origin). `cards`: per frame, every hand-over tile as
// [key, opacity as seen, x, y, w, h, its card's box in the same frame [x, y, w, h] | null]. `grid`: per frame, every Library
// card in the grid's view as [key, opacity as seen (0 when not visible), x, y, w].
const SAMPLER = `(() => { const S = { root: ".intro", bg: ".intro-bg", logo: ".intro-logo", tile: ".intro-tile", ring: ".intro-ring" };
  const out = { phase: [], hit: [], ui: null, firstBg: null, cards: [], grid: [] }; for (const k in S) out[k] = [];
  const seen = (e) => { let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity; return +op.toFixed(3); };
  const box = (e) => { const r = e.getBoundingClientRect(); return [+r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]; };
  window.__intro = out;
  const f = () => { const t = Math.round(performance.now());
    const root = [...document.querySelectorAll(".intro")].find((x) => x.getClientRects().length);
    out.phase.push([t, root?.dataset.phase ?? null]);
    if (out.ui == null && document.querySelector(".topbar .tab")) out.ui = t;
    const c = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    out.hit.push([t, c ? !!c.closest(".intro") : null]);
    const g = document.querySelector(".intro-bg"); if (g && out.firstBg == null) out.firstBg = getComputedStyle(g).backgroundImage;
    out.cards.push([t, [...document.querySelectorAll(".intro-card")].map((e) => {
      const c = document.querySelector('.lib-scroll .card[data-key="' + CSS.escape(e.dataset.key ?? "") + '"]');
      return [e.dataset.key, getComputedStyle(e).visibility === "visible" ? seen(e) : 0, ...box(e), c ? box(c) : null]; })]);
    const sc = document.querySelector('.app[data-page="library"] .lib-scroll'), v = sc?.getBoundingClientRect();
    // every card's ancestors are the grid's: their opacity read once a frame, times each card's own (a light sampler); in
    // view by its place (its box less its own translate), so a card rising from below the scrollport's edge keeps its frames
    const gridOp = sc ? seen(sc.querySelector(".grid") ?? sc) : 0;
    out.grid.push([t, v ? [...sc.querySelectorAll(".grid > .card[data-key]")].flatMap((e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      const ty = parseFloat(cs.translate.split(" ")[1]) || 0;
      return r.bottom - ty > v.top && r.top - ty < v.bottom ? [[e.dataset.key, cs.visibility === "visible" ? +(gridOp * +cs.opacity).toFixed(3) : 0, +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1)]] : []; }) : []]);
    for (const k in S) { const e = [...document.querySelectorAll(S[k])].find((x) => x.getClientRects().length);
      if (!e) { out[k].push([t, null]); continue; }
      let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
      const r = e.getBoundingClientRect(); out[k].push([t, +op.toFixed(3), +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]); }
    if (t < 3000) requestAnimationFrame(f); else out.done = true; };
  requestAnimationFrame(f); })();`;

let win = null;
const js = (code) => win.webContents.executeJavaScript(code);
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `intro-${name}.png`), img.toPNG()); }

// the page's own answers changed before its first request: `empty` / `few` = GET /library answers no items / its first 2, `many`
// = its items 8 times over (each copy its own path, the same pictures: rows to join and room to scroll), `late` = GET
// /settings answers 2.4 s late (the first data, read as one, comes in after HOLD_MAX_MS), `slow` = `many` with GET /settings
// answered SLOW_DATA_MS after the page's first frame (the sampler's)
const STUB = (kind) => `(() => { const f = window.fetch.bind(window), many = ${J(kind)} === "many" || ${J(kind)} === "slow";
  window.fetch = async (u, o) => { const p = new URL(String(u?.url ?? u), location.href).pathname, get = !o?.method || o.method === "GET";
    // the copies have no files: the backend is never asked to make their previews ahead (it would work at files that aren't there
    // through the cells after this one)
    if (many && p === "/previews/seen") return new Response(null, { status: 204 });
    if (${J(kind)} === "late" && get && p === "/settings") { await new Promise((r) => setTimeout(r, 2400)); return f(u, o); }
    if (${J(kind)} === "slow" && get && p === "/settings") { const r = await f(u, o);
      const at = (window.__intro?.phase[0]?.[0] ?? 0) + ${SLOW_DATA_MS};
      await new Promise((ok) => setTimeout(ok, Math.max(0, at - performance.now()))); return r; }
    if (${J(kind)} !== "late" && get && p === "/library") { const r = await f(u, o); const all = await r.json();
      const out = ${J(kind)} === "empty" ? [] : ${J(kind)} === "few" ? all.slice(0, 2)
        : Array.from({ length: 8 }, (_, n) => all.map((it) => (n ? { ...it, videoPath: it.videoPath + ".copy" + n, title: it.title + " " + n } : it))).flat();
      return new Response(JSON.stringify(out), { status: r.status, headers: { "Content-Type": "application/json" } }); }
    return f(u, o); }; })();`;

// a new window (its own sessionStorage, as a new app window has), the sampler in before the app's scripts; `intro` adds the
// shell's ask to the address. `cast`: the window's frames as Chromium draws them, from the page's first one (a CDP screencast
// started on the blank page before it; a frame counts once the navigation has committed): an array filled as they come,
// [{ t (ms, this process's clock), png }]
async function open({ intro = true, reduced = false, stub = null, cast = false } = {}) {
  // the new one before the old one goes: with no window left the app would quit
  const old = win;
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1200, height: 800, webPreferences: { backgroundThrottling: false } });
  if (old) { try { old.webContents.debugger.detach(); } catch { /* not attached */ } old.destroy(); }
  await win.loadURL("about:blank"); // a page first: the debugger's Page domain needs a renderer
  const d = win.webContents.debugger; d.attach("1.3"); await d.sendCommand("Page.enable");
  await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: SAMPLER });
  if (stub) await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: STUB(stub) });
  await d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "" }] });
  win.focus();
  let frames = null;
  if (cast) {
    frames = [];
    let committed = false;
    d.on("message", (_e, method, p) => {
      if (method === "Page.frameNavigated" && !p.frame.parentId && p.frame.url.startsWith(U)) committed = true;
      if (method !== "Page.screencastFrame") return;
      d.sendCommand("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      if (committed) frames.push({ t: Date.now(), png: Buffer.from(p.data, "base64") });
    });
    await d.sendCommand("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await sleep(300); // the blank page's frames go by first
  }
  const u = new URL(withToken(U + "/")); if (intro) u.searchParams.set("intro", "");
  win.loadURL(u.toString()).catch(() => {}); // not awaited: the logo starts before the page's load event
  return frames;
}
// Does a screencast frame show the logo at the window's centre? The middle of the logo's box (its CSS size: clamp(88px,
// 12vmin, 128px), at least .84 of it while it pops in) against the ground beside it, a third of the window to the left:
// the share of its pixels that differ clearly (over 60 summed over r, g, b). A blank or ground-only frame shows none.
function logoShare(png) {
  const img = nativeImage.createFromBuffer(png), { width: w, height: h } = img.getSize(), px = img.toBitmap(); // BGRA
  const at = (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const side = Math.min(128, Math.max(88, 0.12 * Math.min(w, h))) * 0.84 * 0.6, cx = w / 2, cy = h / 2;
  const ground = at(cx - w / 3, cy);
  let n = 0, off = 0;
  for (let y = cy - side / 2; y < cy + side / 2; y += 2) for (let x = cx - side / 2; x < cx + side / 2; x += 2) {
    const c = at(x, y); n++;
    if (Math.abs(c[0] - ground[0]) + Math.abs(c[1] - ground[1]) + Math.abs(c[2] - ground[2]) > 60) off++;
  }
  return n ? off / n : 0;
}
// the page's drawn frames over its first FIRST_MS (the cover can't open sooner: Intro.tsx REVEAL_MS 320): each shows the
// logo; the first one saved as intro-<shot>.png
function firstFrames(frames, shot, v) {
  if (!frames.length) { v.push("no frame of the page was drawn — proved nothing"); return []; }
  const upto = frames.filter((f) => f.t - frames[0].t < FIRST_MS);
  const shares = upto.map((f) => +logoShare(f.png).toFixed(2));
  fs.writeFileSync(path.join(OUT, `intro-${shot}.png`), frames[0].png);
  if (shares[0] < LOGO_PART) v.push(`the page's first drawn frame shows no logo (${Math.round(shares[0] * 100)} % of its middle differs from the ground; want ≥ ${LOGO_PART * 100} %)`);
  const blank = shares.map((s, i) => [i, s]).filter(([, s]) => s < LOGO_PART);
  if (blank.length && shares[0] >= LOGO_PART) v.push(`${blank.length} of the first ${shares.length} drawn frames show no logo (frame ${blank[0][0]}: ${Math.round(blank[0][1] * 100)} %)`);
  return shares;
}
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(15); } return null; }
const phaseNow = () => js(`document.querySelector(".intro")?.dataset.phase ?? ""`);
const frames = () => until(() => js(`window.__intro?.done ? window.__intro : null`), 8000);

// ---- reading the samples ----
const shown = (f) => f && f[1] != null && f[1] > 0.02;
const mids = (fr) => fr.filter((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95).length;
const firstPhase = (s, p) => s.phase.find((x) => x[1] === p)?.[0] ?? null;
const goneAt = (s) => { const i = s.phase.findLastIndex((x) => x[1] != null); return i >= 0 && i < s.phase.length - 1 ? s.phase[i + 1][0] : null; };
// the first frame, the app's tabs there, from which the ground stays under half (or gone): the UI shows through
const seeAt = (s) => { const i = s.bg.findLastIndex((f) => f[1] != null && f[1] > 0.5); const t = i < s.bg.length - 1 ? s.bg[i + 1][0] : null;
  return t == null || s.ui == null ? null : Math.max(t, s.ui); };
const timing = (s) => {
  const play = firstPhase(s, "play"), gone = goneAt(s), see = seeAt(s);
  return { play, open: firstPhase(s, "open"), gone, see, ui: s.ui, line: `ui ${s.ui} play ${play} open ${firstPhase(s, "open")} seen ${see} gone ${gone} (ms since navigation)` };
};
function deadlines(s, v, { see = SEE_MS, end = s.cards.some(([, a]) => a.length) ? END_CARDS_MS : END_MS } = {}) {
  const tm = timing(s);
  const held = s.hit.filter((x) => x[1] === true).length;
  if (held) v.push(`the overlay took the pointer in ${held} frames (it must never hold input)`);
  if (tm.play == null) { v.push(`the logo never started (${tm.line})`); return tm; }
  if (tm.see == null || tm.see - tm.play > see) v.push(`the UI showed through ${tm.see == null ? "never" : `${tm.see - tm.play} ms`} after the logo started (want ≤ ${see})`);
  if (tm.see != null && tm.see > USABLE_MS) v.push(`the UI showed through only ${tm.see} ms after the navigation (want ≤ ${USABLE_MS})`);
  if (tm.gone == null || tm.gone - tm.play > end) v.push(`the overlay was gone ${tm.gone == null ? "never" : `${tm.gone - tm.play} ms`} after the logo started (want ≤ ${end})`);
  return tm;
}
// the logo's resting width as it came in (only the tile inside it scales then)
const restWidth = (s, tm) => s.logo.find((f) => f[0] >= tm.play && shown(f))?.[4];
// the lift (no cards to land on): the logo grows as it leaves, the ground fades out through in-between frames, no tiles
function lifted(s, tm, v) {
  const restW = restWidth(s, tm);
  if (!restW) { v.push("the logo never showed — proved nothing"); return; }
  const tiles = s.cards.filter(([, a]) => a.length).length;
  if (tiles) v.push(`hand-over tiles showed in ${tiles} frames (want the lift: nothing to land on)`);
  const lift = s.logo.filter((f) => tm.open != null && f[0] >= tm.open - 40 && shown(f) && f[4] > restW * 1.03).length;
  if (lift < 2) v.push(`the logo didn't lift away (${lift} frames wider than 103 % as it left)`);
  const outs = s.bg.filter((f) => tm.open != null && f[0] >= tm.open - 40);
  if (mids(outs) < MID) v.push(`the ground popped out: ${mids(outs)} in-between opacity frames (want ≥ ${MID}; ${MO.brief(outs)})`);
}
// per tile key: its frames [t, opacity, x, y, w, h, card box | null]
function tileFrames(s) {
  const by = new Map();
  for (const [t, a] of s.cards) for (const [k, ...f] of a) { if (!by.has(k)) by.set(k, []); by.get(k).push([t, ...f]); }
  return by;
}
const off = (f, c) => Math.max(Math.abs(f[2] - c[0]), Math.abs(f[3] - c[1]), Math.abs(f[4] - c[2]), Math.abs(f[5] - c[3]));
// the first row of the Library's cards now (the cards the tiles were meant for), in reading order
const firstRow = () => js(`(() => { const cs = [...document.querySelectorAll(".lib-scroll .grid > .card[data-key]")];
  const top = cs[0]?.getBoundingClientRect().top; return cs.filter((c) => Math.abs(c.getBoundingClientRect().top - top) <= 1).map((c) => c.dataset.key); })()`);
// the hand-over, judged per tile: each of `want` (keys) leaves from inside the logo's box, passes through in-between places,
// lands on its card as drawn in the same frame, fades out over it; then the cards show
async function handedOver(s, tm, want, v, { onTop = true, motion = true } = {}) {
  const by = tileFrames(s), keys = [...by.keys()];
  // the cover opened at HOLD_MAX_MS without the first data (the lift, rightly): nothing here can show the hand-over
  if (!keys.length && tm.open != null && tm.open - tm.play > HELD_MS) v.push(`the cover opened ${tm.open - tm.play} ms after the logo started, at HOLD_MAX_MS: the first data came late (a loaded machine?) — proved nothing`);
  else if (J(keys) !== J(want)) v.push(`tiles for ${J(keys)} (want one per card of the first row: ${J(want)})`);
  const L = s.logo.filter((f) => tm.open != null && f[0] < tm.open && shown(f)).at(-1);
  if (!L) v.push("no logo box before the hand-over — proved nothing");
  // the split: the tiles' first frame is the whole logo, edge to edge (their boxes fill the logo's box, none outside it)
  const split = s.cards.find(([, a]) => a.length);
  if (L && split) {
    const a = split[1], x0 = Math.min(...a.map((f) => f[2])), y0 = Math.min(...a.map((f) => f[3]));
    const x1 = Math.max(...a.map((f) => f[2] + f[4])), y1 = Math.max(...a.map((f) => f[3] + f[5]));
    const area = a.reduce((n, f) => n + f[4] * f[5], 0) / (L[4] * L[5]);
    if (Math.max(Math.abs(x0 - L[2]), Math.abs(y0 - L[3]), Math.abs(x1 - L[2] - L[4]), Math.abs(y1 - L[3] - L[5])) > 3 || area < 0.92 || area > 1.08)
      v.push(`the split isn't the whole logo: the tiles span ${J([x0, y0, x1 - x0, y1 - y0].map(Math.round))} over ${Math.round(area * 100)} % of its area, the logo ${J(L.slice(2, 6))}`);
  }
  // a first-row card shows only once its tile has landed: the tile's last drawn frame at or before the card's first shown one
  // is on it
  const grid = cardFrames(s);
  for (const k of want) {
    const t0 = grid.get(k)?.find((f) => tm.open != null && f[0] >= tm.open && f[1] > SHOWN)?.[0];
    if (t0 == null) { v.push(`card ${k} never showed`); continue; }
    const tf = by.get(k)?.filter((f) => f[0] <= t0 && f[6] && f[1] > 0.02).at(-1);
    if (!tf || off(tf, tf[6]) > LAND_PX) {
      v.push(`card ${k} showed at ${t0} ms before its tile landed (its tile then: ${tf ? `${tf[6] ? off(tf, tf[6]).toFixed(0) : "?"} px away, opacity ${tf[1]}` : "never drawn"})`); }
  }
  let moving = 0, fading = 0;
  for (const [k, fr] of by) {
    const vis = fr.filter((f) => f[1] > 0.02 && f[6]);
    if (!vis.length) { v.push(`tile ${k}: never drawn with its card`); continue; }
    const a = vis[0];
    if (L && (a[2] < L[2] - 3 || a[3] < L[3] - 3 || a[2] + a[4] > L[2] + L[4] + 3 || a[3] + a[5] > L[3] + L[5] + 3))
      v.push(`tile ${k}: first drawn at ${J(a.slice(2, 6))}, outside the logo's box ${J(L.slice(2, 6))}`);
    const mid = vis.filter((f) => f[1] > 0.5 && off(f, f[6]) > 4 && off(f, [a[2], a[3], a[4], a[5]]) > 4).length;
    moving = Math.max(moving, mid);
    if (motion && mid < MID) v.push(`tile ${k}: ${mid} in-between places on its way (want ≥ ${MID})`);
    const last = vis.at(-1), d = off(last, last[6]);
    if (d > LAND_PX) v.push(`tile ${k}: its last frame ${J(last.slice(2, 6))} is ${d.toFixed(1)} px off its card ${J(last[6])} (want ≤ ${LAND_PX})`);
    const fade = vis.filter((f) => f[1] < 0.95 && off(f, f[6]) <= LAND_PX).length;
    fading = Math.max(fading, fade);
    // one in-between frame on its card shows a fade (as app/shell/motion-off.js judges a leave); none is a pop
    if (motion && !fade) {
      // the page stalled over the fade (no frame sampled for longer than it lasts): it can't be judged
      const lastT = vis.at(-1)[0], next = s.phase.find(([t]) => t > lastT)?.[0];
      v.push(next != null && next - lastT >= 90 ? `tile ${k}: no frame sampled from ${lastT} to ${next} ms, over its fade — proved nothing`
        : `tile ${k}: popped off its card (no in-between opacity frame on it; its fading frames [t, opacity, px off its card]: ${J(fr.filter((f) => f[1] > 0.02 && f[1] < 0.98).slice(-6).map((f) => [f[0], f[1], f[6] ? +off(f, f[6]).toFixed(1) : null]))})`);
    }
  }
  const after = await js(`(${J(want)}).map((k) => { const c = document.querySelector('.lib-scroll .card[data-key="' + CSS.escape(k) + '"]'); if (!c) return [k, null];
    let op = 1; for (let x = c; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
    const r = c.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".card");
    return [k, +op.toFixed(3), hit === c]; })`);
  for (const [k, op, top] of after) if (op == null || op < 0.99 || (onTop && !top)) v.push(`card ${k} after the hand-over: ${op == null ? "gone" : `opacity ${op}${top ? "" : ", covered at its centre"}`}`);
  return { tiles: keys.length, moving, fading };
}
// per Library card key: its frames [t, own opacity, x, y, w] while in the grid's view
function cardFrames(s) {
  const by = new Map();
  for (const [t, a] of s.grid) for (const [k, ...f] of a) { if (!by.has(k)) by.set(k, []); by.get(k).push([t, ...f]); }
  return by;
}
// the cards in view at the end, in reading order (rows by their top, each left to right), as [key, row]; a row is the cards
// within half a card of its first card's top (a hovered or focused card sits a few px higher)
function readingOrder(s) {
  const last = [...(s.grid.findLast(([, a]) => a.length)?.[1] ?? [])].sort((a, b) => a[3] - b[3]);
  let row = -1, top = -Infinity;
  const rows = last.map((f) => { if (f[3] > top + f[4] / 2) { row++; top = f[3]; } return [f[0], row, f[2]]; });
  return rows.sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([k, r]) => [k, r]);
}
// the rest of the library joining after the first row: hidden as the ground starts to dissolve, then in reading order (each
// card's first shown frame no earlier than the one before it), over several frames, after the first row began to show, each
// rising into place: its first shown frame below its place, then above it (the spring's overshoot), then on it, fading in
// (in-between opacities); every card in view shown at the end
function joined(s, tm, row1, v) {
  const by = cardFrames(s), order = readingOrder(s), first = new Set(row1);
  const rest = order.filter(([k]) => !first.has(k));
  if (rest.length < 2) { v.push(`only ${rest.length} cards in view after the first row — proved nothing`); return { rest: rest.length, steps: 0 }; }
  const atOpen = s.grid.find(([t]) => tm.open != null && t >= tm.open)?.[1] ?? [];
  const early = atOpen.filter((f) => f[1] > SHOWN);
  if (!atOpen.length) v.push("no cards in view as the ground started to dissolve — proved nothing");
  else if (early.length) v.push(`${early.length} cards showed as the ground started to dissolve (want the grid unseen until its cards arrive: ${J(early.slice(0, 3))})`);
  const shownAt = (k) => by.get(k)?.find((f) => tm.open != null && f[0] >= tm.open && f[1] > SHOWN)?.[0] ?? null;
  const times = rest.map(([k, r]) => [k, r, shownAt(k)]);
  const never = times.filter(([, , t]) => t == null);
  if (never.length) v.push(`${never.length} cards never showed (${J(never.slice(0, 3).map(([k]) => k))})`);
  for (let i = 1; i < times.length; i++) if (times[i][2] != null && times[i - 1][2] != null && times[i][2] < times[i - 1][2]) {
    v.push(`out of reading order: ${times[i][0]} (row ${times[i][1] + 1}) showed at ${times[i][2]} ms, before ${times[i - 1][0]} (row ${times[i - 1][1] + 1}) at ${times[i - 1][2]} ms`); break; }
  const steps = new Set(times.map(([, , t]) => t).filter((t) => t != null)).size;
  if (steps < MID) v.push(`the cards joined in ${steps} frames (want a cascade over ≥ ${MID})`);
  const row1At = Math.min(...row1.map(shownAt).filter((t) => t != null));
  const restAt = Math.min(...times.map(([, , t]) => t).filter((t) => t != null));
  if (restAt < row1At) v.push(`the rest began to join at ${restAt} ms, before the first row showed at ${row1At} ms`);
  const fading = rest.filter(([k]) => (by.get(k) ?? []).some((f) => f[1] > 0.05 && f[1] < 0.95)).length;
  if (fading < rest.length / 2) v.push(`${fading} of ${rest.length} joining cards faded in (want most)`);
  // each one's vertical path against its place (its top in the last frame): below, past it upward, back on it
  let below = 0, over = 0, rise = 0;
  const odd = [];
  for (const [k] of rest) {
    const fr = (by.get(k) ?? []).filter((f) => tm.open != null && f[0] >= tm.open && f[1] > SHOWN);
    if (!fr.length) continue;
    const y = fr.at(-1)[3];
    const b = fr[0][3] - y, o = y - Math.min(...fr.map((f) => f[3]));
    if (b > RISE_BELOW) below++; if (o > OVER_PX) over++;
    rise = Math.max(rise, b);
    if (b <= RISE_BELOW || o <= OVER_PX) odd.push([k.split("/").pop(), +b.toFixed(1), +o.toFixed(1)]);
  }
  if (below < rest.length) v.push(`${rest.length - below} of ${rest.length} joining cards didn't start below their place (e.g. [card, px below at first, px above at most]: ${J(odd.slice(0, 3))})`);
  // the overshoot's top lasts a few frames; a sampling stall can step over one card's
  if (over < rest.length * 0.8) v.push(`${over} of ${rest.length} joining cards rose past their place (want ≥ 80 %: the spring's overshoot; e.g. ${J(odd.slice(0, 3))})`);
  const end = s.grid.find(([t]) => tm.gone != null && t >= tm.gone + END_SETTLE_MS)?.[1] ?? [];
  const finalY = new Map((s.grid.findLast(([, a]) => a.length)?.[1] ?? []).map((f) => [f[0], f[3]]));
  const astray = end.filter((f) => !first.has(f[0]) && finalY.has(f[0]) && Math.abs(f[3] - finalY.get(f[0])) > SETTLE_PX);
  if (astray.length) v.push(`${astray.length} joining cards not on their place ${END_SETTLE_MS} ms after the opening ended (${J(astray.slice(0, 3))})`);
  shownAtEnd(s, tm, v);
  return { rest: rest.length, steps, fading, below, over, rise: +rise.toFixed(1), row1At, restAt, lastAt: Math.max(...times.map(([, , t]) => t ?? 0)) };
}
// every card in view fully shown by END_SETTLE_MS after the overlay went (none left hidden by the opening): the last join can
// end a frame after the overlay's timer, its animation having started on the frame after the timer was set
function shownAtEnd(s, tm, v) {
  const end = s.grid.find(([t]) => tm.gone != null && t >= tm.gone + END_SETTLE_MS)?.[1] ?? [];
  if (!end.length) { v.push(`no cards in view as the opening ended (${tm.gone} ms) — proved nothing`); return; }
  const hidden = end.filter((f) => f[1] < 0.99);
  if (hidden.length) v.push(`${hidden.length} cards in view not fully shown ${END_SETTLE_MS} ms after the opening ended (${J(hidden.slice(0, 3))})`);
}
// the opening played to its end after an input: never cut short. `full` = how long the same opening ran with no input (ms
// from the cover opening to the overlay gone), less 3 frames of timer and frame slack
const FULL = { cards: null };
const MANY_MIN_MS = 750; // the `many` library's opening, cover open to overlay gone, when intro:cards didn't run (about 1 s)
function playedOn(s, tm, v, full) {
  const ph = s.phase.map((x) => x[1]).filter((x, i, a) => x !== a[i - 1]);
  if (ph.some((p) => p != null && !["cover", "play", "open"].includes(p))) v.push(`phases ${ph.join(" → ")}`);
  const want = full == null ? 400 : full - 50;
  if (tm.open == null || tm.gone == null || tm.gone - tm.open < want) v.push(`the opening ended ${tm.gone == null || tm.open == null ? "never" : `${tm.gone - tm.open} ms`} after the cover opened (want it played on to its end, ≥ ${want}${full == null ? "" : `: the same opening with no input ran ${full}`})`);
}
// what the overlay's running animations animate (its subtree), other than opacity / scale
const props = () => js(`(() => { const r = document.querySelector(".intro"); if (!r) return null; const p = new Set();
  for (const a of r.getAnimations({ subtree: true })) for (const k of a.effect?.getKeyframes?.() ?? []) for (const n of Object.keys(k))
    if (!["offset", "easing", "composite", "computedOffset"].includes(n)) p.add(n); return [...p]; })()`);

app.on("window-all-closed", () => { /* the probe decides when it ends */ });
app.whenReady().then(async () => {
  const results = [];
  const cell = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  try {
    await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, theme: "Catppuccin Mocha" });

    await cell("intro:absent", async () => {
      await open({ intro: false });
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [];
      if (s.ui == null) v.push("the app never mounted — proved nothing");
      const seen = s.phase.filter((x) => x[1] != null);
      if (seen.length) v.push(`an overlay showed without ?intro (${seen.length} frames, phase ${seen[0][1]})`);
      return v;
    });

    await cell("intro:firstFrame", async () => {
      const cast = await open({ cast: true });
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v);
      console.log(`        ${tm.line}`);
      const shares = firstFrames(cast, "firstFrame", v);
      console.log(`        ${cast.length} drawn frames; the logo's share of the middle in the first ${shares.length}: ${J(shares)}`);
      return v;
    });

    await cell("intro:plays", async () => {
      await open();
      // mid-animation screenshots: as the logo comes in, as the cover dissolves
      if (await until(async () => (await phaseNow()) === "play")) { await sleep(90); await shot("plays-in"); await sleep(140); await shot("plays-mid"); }
      if (await until(async () => (await phaseNow()) === "open", 1500)) { await sleep(90); await shot("plays-open"); }
      const anim = await props();
      const glow = await js(`getComputedStyle(document.querySelector(".intro-tile") ?? document.body).boxShadow`);
      // the picture comes with the page (a data URL): nothing to load before it shows
      const inline = await js(`(() => { const i = document.querySelector(".intro-img"); return i ? getComputedStyle(i).backgroundImage.startsWith('url("data:image/svg+xml') : null; })()`);
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v);
      console.log(`        ${tm.line}`);
      if (tm.play == null) return v;
      const tile = s.tile.filter((f) => f[0] >= tm.play);
      const restW = restWidth(s, tm);
      const ins = tile.filter((f) => f[0] < tm.play + 320);
      if (!(ins[0]?.[1] >= 0.95)) v.push(`the logo wasn't whole in its first frame (opacity ${ins[0]?.[1]}; want it shown from the first frame, popping in on scale alone)`);
      const growing = ins.filter((f) => shown(f) && f[4] < restW * 0.97).length;
      if (growing < MID) v.push(`the logo didn't scale in: ${growing} frames under 97 % of its width ${restW} (want ≥ ${MID})`);
      const ring = s.ring.filter((f) => f[0] >= tm.play && shown(f));
      const ringWide = ring.filter((f) => f[4] > restW * 1.1).length;
      if (ringWide < MID) v.push(`no ring rippled off the logo: ${ringWide} frames wider than 110 % of the logo (want ≥ ${MID})`);
      const outs = s.bg.filter((f) => tm.open != null && f[0] >= tm.open - 40);
      if (mids(outs) < MID) v.push(`the ground popped out: ${mids(outs)} in-between opacity frames (want ≥ ${MID}; ${MO.brief(outs)})`);
      // how the logo leaves (the hand-over or the lift): intro:cards, intro:fallback:*
      if (!anim) v.push("no overlay when its animations were read");
      else { const bad = anim.filter((p) => !["opacity", "scale", "transform", "translate"].includes(p)); if (bad.length) v.push(`animates ${bad.join(", ")} (only opacity / scale / transform / translate)`); }
      if (!/rgb/.test(glow ?? "") || (glow.match(/rgb/g) ?? []).length < 2) v.push(`no accent halo with Glow effects on (box-shadow ${glow})`);
      if (!restW) v.push("the logo never showed — proved nothing");
      if (inline !== true) v.push(`the logo's picture isn't inline with the page (${inline === null ? "no .intro-img" : "a request to wait for"})`);
      console.log(`        frames: logo in ${mids(ins)} fading / ${growing} scaling, ring ${ringWide} wide, ground out ${mids(outs)} fading; tile opacity ${MO.brief(ins)}; ground ${MO.brief(outs)}`);
      return v;
    });

    await cell("intro:once", async () => {
      // the same window again: its sessionStorage holds the mark
      if (!win) return ["no window from intro:plays"];
      await win.loadURL(new URL(withToken(U + "/?intro")).toString());
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [];
      if (s.ui == null) v.push("the app never mounted — proved nothing");
      const seen = s.phase.filter((x) => x[1] != null);
      if (seen.length) v.push(`it played again on a reload of the same window (${seen.length} frames)`);
      return v;
    });

    // the hand-over onto the first row (all of it, or the first 2 of a 2-item library), then the rest joining
    const cardsCell = (name, stub, wantN, budget) => cell(name, async () => {
      await open({ stub });
      let glow = null, anim = null;
      if (await until(async () => (await js(`!!document.querySelector(".intro-card")`)) || null, 3000)) {
        // read before the screenshots: each capture takes a while, and the tiles live a few hundred ms
        anim = await props();
        glow = await js(`(() => { const c = document.querySelector(".intro-card"); return c && getComputedStyle(c).boxShadow; })()`);
        if (stub === "many" || stub === "slow") { const p = stub === "many" ? "cards" : "slow"; await shot(`${p}-split`); await sleep(110); await shot(`${p}-mid`); await sleep(140); await shot(`${p}-land`); await sleep(150); await shot(`${p}-cascade`); }
      }
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v, budget);
      console.log(`        ${tm.line}`);
      if (tm.play == null) return v;
      if (stub === "slow") {
        // the first data's arrival, as the page saw it: the frame its first card was in the grid
        const inAt = s.grid.find(([, a]) => a.length)?.[0];
        console.log(`        the first data in ${inAt == null ? "never" : `${inAt - tm.play} ms`} after the logo's first frame`);
        if (inAt == null || inAt - tm.play < 750 || inAt - tm.play > HELD_MS) return [...v, `the first data came in ${inAt == null ? "never" : `${inAt - tm.play} ms`} after the logo's first frame (want between the old hold and HOLD_MAX_MS: 750–${HELD_MS}) — proved nothing`];
        if (!s.cards.some(([, a]) => a.length)) v.push(`the logo lifted away though the first data came in within HOLD_MAX_MS (the cover opened ${tm.open == null ? "never" : `${tm.open - tm.play} ms`} after the logo's first frame; want the hand-over)`);
      }
      const row = await firstRow();
      if (!row?.length) return [...v, "no cards in the Library's first row — proved nothing"];
      if (wantN != null && row.length !== wantN) v.push(`the first row has ${row.length} cards (want ${wantN} from the stub) — proved nothing`);
      const got = await handedOver(s, tm, row, v);
      const join = stub === "many" || stub === "slow" ? joined(s, tm, row, v) : null;
      if (stub === "many" && tm.open != null && tm.gone != null) FULL.cards = tm.gone - tm.open;
      if (join) console.log(`        joining: ${join.rest} cards after the first row in ${join.steps} frames, first row from ${join.row1At} ms, the rest ${join.restAt}–${join.lastAt} ms, ${join.fading} fading, ${join.below} from below, ${join.over} past their place (rising up to ${join.rise} px)`);
      if (glow == null) v.push("no tile showed");
      else if ((glow.match(/rgb/g) ?? []).length < 2) v.push(`no accent halo on the tiles with Glow effects on (box-shadow ${glow})`);
      if (!anim?.length) v.push(`no running animations read while the tiles showed (${J(anim)}) — proved nothing`);
      else { const bad = anim.filter((p) => !["opacity", "scale", "transform", "translate"].includes(p)); if (bad.length) v.push(`animates ${bad.join(", ")} (only opacity / scale / transform / translate)`); }
      const outs = s.bg.filter((f) => tm.open != null && f[0] >= tm.open - 40);
      if (mids(outs) < MID) v.push(`the ground popped out: ${mids(outs)} in-between opacity frames (want ≥ ${MID}; ${MO.brief(outs)})`);
      console.log(`        frames: ${got.tiles} tiles for a row of ${row.length}, ≤ ${got.moving} in-between places, ≤ ${got.fading} fading on their cards; ground ${MO.brief(outs)}`);
      return v;
    });
    await cardsCell("intro:cards", "many", null);
    await cardsCell("intro:fewCards", "few", 2);
    await cardsCell("intro:slowData", "slow", null, { see: SLOW_DATA_MS + SEE_MS, end: SLOW_DATA_MS + END_CARDS_MS });

    // nothing to land on: the lift as before
    const liftCell = (name, stub, before, budget) => cell(name, async () => {
      await open({ stub });
      if (before && !(await until(async () => (await phaseNow()) === "play"))) return ["the logo never started"];
      if (before) { const r = await before(); if (r) return [r]; }
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v, budget);
      console.log(`        ${tm.line}`);
      if (tm.play == null) return v;
      lifted(s, tm, v);
      if (budget && !(await until(async () => (await js(`document.querySelectorAll(".lib-scroll .card").length`)) || null, 2500)))
        v.push("the late data never built the Library — proved nothing");
      if (budget && tm.open != null && tm.open - tm.play < HELD_MS) v.push(`the cover opened ${tm.open - tm.play} ms after the logo started, before HOLD_MAX_MS (want ≥ ${HELD_MS}: the first data was late) — proved nothing`);
      return v;
    });
    await liftCell("intro:fallback:empty", "empty", async () => {
      // an empty library shows the welcome in the grid's place (components/Welcome.tsx)
      const empty = await until(async () => (await js(`!!document.querySelector('.welcome[data-welcome="empty"]') && !document.querySelector(".lib-scroll .card")`)) || null, 1500);
      return empty ? null : "the library wasn't empty under the logo — proved nothing";
    });
    await liftCell("intro:fallback:tab", null, async () => {
      // a script's click: Browse shows before the cover opens, with no pointer near the logo
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Browse")?.click()`);
      const on = await until(async () => (await js(`document.querySelector(".app")?.dataset.page`)) === "browse" || null, 1000);
      if (!on) return "Browse never showed under the logo — proved nothing";
      return (await phaseNow()) === "play" ? null : `the phase was ${await phaseNow()} once Browse showed (want play) — proved nothing`;
    });
    await liftCell("intro:fallback:late", "late", async () => {
      await sleep(400);
      return (await js(`document.querySelectorAll(".lib-scroll .card").length`)) ? "the cards were in before HOLD_MAX_MS — proved nothing" : null;
    }, LATE);

    // input while the opening plays: it reaches the page at once and the opening plays on to its end
    const inputCell = (name, act) => cell(name, async () => {
      await open({ stub: "many" });
      if (!(await until(async () => (await js(`!!document.querySelector(".intro-card")`)) || null, 3000))) return ["no tile flew"];
      await sleep(40);
      const r = await act();
      if (typeof r === "string") return [r];
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v);
      console.log(`        ${tm.line}`);
      if (tm.play == null) return v;
      v.push(...r);
      playedOn(s, tm, v, FULL.cards ?? MANY_MIN_MS);
      const row = await firstRow();
      if (!row?.length) return [...v, "no cards in the Library's first row — proved nothing"];
      // the scroll cell proves where the tiles land and that no card stays hidden; how they move and fade is intro:cards' (a
      // wheel and its smooth glide on the software-rendered stack can take the frames those counts need)
      await handedOver(s, tm, row, v, { onTop: name !== "intro:scroll", motion: name !== "intro:scroll" });
      if (name === "intro:scroll") shownAtEnd(s, tm, v);
      else joined(s, tm, row, v);
      return v;
    });
    // the second row's first card, not shown yet: Ctrl+click selects it (the same click as ever, nothing in between)
    await inputCell("intro:click", async () => {
      const p = await js(`(() => { const cs = [...document.querySelectorAll(".lib-scroll .grid > .card[data-key]")], top = cs[0]?.getBoundingClientRect().top;
        const c = cs.find((e) => e.getBoundingClientRect().top > top + 1); if (!c) return null; const r = c.getBoundingClientRect();
        return { key: c.dataset.key, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), op: +getComputedStyle(c).opacity }; })()`);
      if (!p) return "no second row — proved nothing";
      if (p.op > SHOWN) return `the second row's first card already showed (opacity ${p.op}) — proved nothing`;
      win.webContents.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1, modifiers: ["control"] });
      win.webContents.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1, modifiers: ["control"] });
      const sel = await until(() => js(`(() => { const c = document.querySelector('.lib-scroll .card[data-key="' + CSS.escape(${J(p.key)}) + '"]');
        return c?.classList.contains("selected") ? [document.querySelector(".intro")?.dataset.phase ?? "gone", +getComputedStyle(c).opacity] : null; })()`), 600);
      return sel == null ? [`the Ctrl+click on a card not shown yet didn't select it`]
        : sel[0] === "gone" ? ["the card was selected only after the opening ended — proved nothing"]
        : sel[1] > SHOWN ? [`the card was selected only once it showed (opacity ${sel[1]}; want at once, while unseen)`] : [];
    });
    await inputCell("intro:key", async () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: ["control"] });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: ["control"] });
      const all = await until(() => js(`(() => { const n = document.querySelectorAll(".lib-scroll .grid > .card[data-key]").length, k = document.querySelectorAll(".lib-scroll .grid > .card.selected").length;
        return n && k === n ? (document.querySelector(".intro")?.dataset.phase ?? "gone") : null; })()`), 600);
      return all == null ? [`Ctrl+A while the tiles flew didn't select every card (${await js(`document.querySelectorAll(".lib-scroll .card.selected").length`)} selected)`]
        : all === "gone" ? ["the cards were selected only after the opening ended — proved nothing"] : [];
    });
    // a wheel over the grid: the grid scrolls at once (the smooth glide), the tiles follow their cards
    await inputCell("intro:scroll", async () => {
      const g = await js(`(() => { const r = document.querySelector(".lib-scroll").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.6) }; })()`);
      for (const dy of [-100, 100]) {
        win.webContents.sendInputEvent({ type: "mouseWheel", x: g.x, y: g.y, deltaX: 0, deltaY: dy, canScroll: true });
        if (await until(async () => (await js(`document.querySelector(".lib-scroll").scrollTop`)) > 20 || null, 500)) break;
      }
      const top = await js(`document.querySelector(".lib-scroll").scrollTop`), phase = await phaseNow();
      const flying = await js(`[...document.querySelectorAll(".intro-card")].filter((e) => { const c = document.querySelector('.lib-scroll .card[data-key="' + CSS.escape(e.dataset.key ?? "") + '"]');
        if (!c || +getComputedStyle(e).opacity < 0.02) return false; const a = e.getBoundingClientRect(), b = c.getBoundingClientRect();
        return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width)) > ${LAND_PX}; }).length`);
      if (!(top > 20)) return `the grid didn't scroll (scrollTop ${top}) — proved nothing`;
      if (!flying) return "every tile had landed by the time the grid scrolled — proved nothing";
      return phase === "open" ? [] : [`the scroll landed after the opening (${phase}) — proved nothing`];
    });

    await cell("intro:clickThrough", async () => {
      await open();
      if (!(await until(async () => (await phaseNow()) === "open", 4000))) return ["the cover never started to dissolve"];
      const p = await js(`(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings")?.getBoundingClientRect(); return b && { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
      if (!p) return ["no Settings tab"];
      win.webContents.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 });
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [];
      playedOn(s, timing(s), v);
      const tab = await until(async () => ((await js(`document.querySelector(".tab.active")?.textContent ?? ""`)) === "Settings" ? "y" : null), 1500);
      if (!tab) v.push(`the click on Settings while the cover dissolved didn't reach it (active: ${await js(`document.querySelector(".tab.active")?.textContent`)})`);
      return v;
    });

    const offCell = (name, reduced) => cell(name, async () => {
      // the window before this one learns the setting (the look is fixed when a window opens)
      if (!reduced) { await open(); await frames(); }
      const cast = await open({ reduced, cast: true });
      // what the overlay animates while the logo shows, and a screenshot of it (the fade's middle)
      const anim = await until(async () => ((await phaseNow()) === "play" ? props() : null));
      await sleep(70); await shot(`${name.split(":")[1]}-mid`);
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v);
      console.log(`        ${tm.line}`);
      if (tm.play == null) return v;
      const after = (fr) => fr.filter((f) => f[0] >= tm.play - 20);
      const shares = firstFrames(cast, `${name.split(":")[1]}-first`, v);
      console.log(`        frames: logo ${MO.brief(after(s.tile))}; ground ${MO.brief(after(s.bg))}; animates ${J(anim)}; the logo's share of the middle in the first ${shares.length} drawn: ${J(shares)}`);
      const bad = (anim ?? []).filter((p) => p !== "opacity");
      if (bad.length) v.push(`animates ${bad.join(", ")} with motion off (only opacity)`);
      // still: whole from the window's first frame, never moving, then a plain fade out
      if (!(s.tile.find((f) => f[1] != null)?.[1] >= 0.95)) v.push(`the logo wasn't whole in its first frame (${MO.brief(s.tile)})`);
      v.push(...MO.judge("the logo", after(s.tile)));
      v.push(...MO.judge("the logo", after(s.logo), { leave: true }));
      v.push(...MO.judge("the ground", after(s.bg), { leave: true }));
      if (s.ring.some((f) => f[1] != null && f[1] > 0.02)) v.push("the ring showed with motion off");
      const tiles = s.cards.filter(([, x]) => x.length).length;
      if (tiles) v.push(`hand-over tiles flew with motion off (${tiles} frames)`);
      const cards = s.grid.filter(([t, a]) => t >= tm.play && (tm.gone == null || t < tm.gone) && a.length);
      const dim = cards.flatMap(([t, a]) => a.filter((f) => f[1] < 0.99).map((f) => [t, f[0], f[1]]));
      if (!cards.length) v.push("no cards in view while it played — proved nothing");
      else if (dim.length) v.push(`cards hidden or joining with motion off (${dim.length} card frames, e.g. ${J(dim[0])})`);
      return v;
    });
    await setSettings({ morphs: false });
    await offCell("intro:off", false);
    await setSettings({ morphs: true });
    await offCell("intro:reduced", true);

    await cell("look:toggles", async () => {
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      try {
        // the window before this one learns "Smooth window animations" on (the cells before it end with it off or reduced)
        await open(); await frames();
        await open();
        let glow = null, cls = "", cardGlow = null, still = null;
        if (await until(async () => (await phaseNow()) === "play")) {
          still = await js(`document.documentElement.classList.contains("intro-still")`);
          await sleep(200); await shot("toggles-mid");
          glow = await js(`getComputedStyle(document.querySelector(".intro-tile")).boxShadow`);
          cls = await js(`document.documentElement.className`);
          cardGlow = await until(() => js(`(() => { const c = document.querySelector(".intro-card"); return c && getComputedStyle(c).boxShadow; })()`), 1500);
          if (cardGlow) await shot("toggles-cards");
        }
        const s = await frames(); if (!s) return ["the sampler never finished"];
        const v = [], tm0 = deadlines(s, v);
        console.log(`        ${tm0.line}`);
        if (still) v.push("it played still (motion off kept from a window before) — proved nothing");
        // the tiles hand over over the live wallpaper too, their depth without the halo
        if (tm0.play != null) { const row = await firstRow(); if (row?.length) await handedOver(s, tm0, row, v); else v.push("no cards in the first row — proved nothing"); }
        if (cardGlow == null) v.push("no tile showed");
        else if ((cardGlow.match(/rgb/g) ?? []).length > 1) v.push(`an accent halo on the tiles with Glow effects off (box-shadow ${cardGlow})`);
        else if (!/rgba\(0, 0, 0/.test(cardGlow)) v.push(`the tiles' depth shadow went too (box-shadow ${cardGlow})`);
        if (!/no-glow/.test(cls)) v.push(`no :root.no-glow with Glow effects off (${cls})`);
        if (!/bg-live/.test(cls)) v.push(`no :root.bg-live with the live wallpaper behind every tab (${cls})`);
        if (glow == null) v.push("the logo never started");
        else if ((glow.match(/rgb/g) ?? []).length > 1) v.push(`an accent halo with Glow effects off (box-shadow ${glow})`);
        else if (!/rgba\(0, 0, 0/.test(glow)) v.push(`the depth shadow went too (box-shadow ${glow})`);
        const tm = timing(s), under = s.bg.filter((f) => tm.play != null && f[0] >= tm.play && (tm.open == null || f[0] < tm.open));
        if (!under.length) v.push("no frames of the logo coming in — proved nothing");
        else if (under.some((f) => f[1] == null || f[1] < 0.95)) v.push(`the UI showed through the ground while the logo came in (${MO.brief(under)})`);
        return v;
      } finally { await setSettings({ glows: true, liveWallpaperBehindAllTabs: false }); }
    });

    await cell("look:theme", async () => {
      await setSettings({ theme: "Catppuccin Latte" });
      try {
        await open(); await frames(); // the window before this one keeps the theme for the next one's first frames
        await open();
        let got = null;
        if (await until(async () => (await phaseNow()) === "play")) {
          await sleep(200); await shot("theme-mid");
          got = await js(`(() => { const p = document.createElement("i"); p.style.color = "var(--accent)"; p.style.background = "var(--bg-base)"; document.body.append(p);
            const cs = getComputedStyle(p), accent = cs.color, base = cs.backgroundColor; p.remove();
            const img = [...document.querySelectorAll(".intro-img")].find((i) => i.getClientRects().length);
            const pic = img ? getComputedStyle(img).backgroundImage : "";
            // the two pictures differ in their tile's colour (app/icon/generate.py): Night's #3a3352, Lavender's #b48fd0
            return { accent, base, ring: getComputedStyle(document.querySelector(".intro-ring")).borderTopColor,
              bg: getComputedStyle(document.querySelector(".intro-bg")).backgroundImage,
              variant: /b48fd0/i.test(pic) ? "lavender" : /3a3352/i.test(pic) ? "night" : null, decoded: pic.startsWith('url("data:image/svg+xml') }; })()`);
        }
        const s = await frames(); if (!s) return ["the sampler never finished"];
        const v = []; deadlines(s, v);
        if (!got) return [...v, "the logo never started"];
        if (got.variant !== "lavender") v.push(`the ${got.variant} logo on a light theme (want lavender)`);
        if (!got.decoded) v.push("the logo's picture isn't inline with the page");
        if (got.ring !== got.accent) v.push(`the ring is ${got.ring}, the theme's accent ${got.accent}`);
        if (!got.bg.includes(got.base)) v.push(`the ground (${got.bg}) isn't in the theme's base colour ${got.base}`);
        if (!s.firstBg?.includes(got.base)) v.push(`the ground's first frame (${s.firstBg}) isn't in the theme's base colour ${got.base} (the kept theme)`);
        return v;
      } finally { await setSettings({ theme: "Catppuccin Mocha" }); }
    });

    await cell("look:themePartial", async () => {
      // a kept theme missing colours (a copy from an older build, a hand edit): the defaults, and the opening still plays
      if (!win) { await open({ intro: false }); await frames(); } // a page of the app's origin to write its storage from
      await js(`localStorage.setItem("liascape.themeVars", JSON.stringify({ bgBase: "#ffffff" }))`);
      try {
        await open();
        const s = await frames(); if (!s) return ["the sampler never finished"];
        const v = [], tm = deadlines(s, v);
        console.log(`        ${tm.line}; the ground's first frame ${s.firstBg}`);
        if (tm.play == null) return v;
        if (!/rgb\(24, 24, 37\)/.test(s.firstBg ?? "") || !/rgb\(30, 30, 46\)/.test(s.firstBg ?? "")) v.push(`the ground's first frame (${s.firstBg}) isn't the default theme's (Mocha's mantle and base)`);
        return v;
      } finally { await js(`localStorage.removeItem("liascape.themeVars")`).catch(() => {}); }
    });
  } catch (e) {
    console.log(`ERROR ${e.stack || e}`);
    results.push({ name: "setup", v: [String(e)] });
  }
  const fails = results.filter((r) => r.v.length);
  console.log(`INTRO ${results.length - fails.length}/${results.length} passed`);
  app.exit(fails.length ? 1 : 0);
});
