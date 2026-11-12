// Layout + motion polish probe — `scripts/test-ui-matrix.sh --probe probe-layout.js` (same hermetic stack as the
// matrix; run it with LIASCAPE_MATRIX_SCREEN=2560x1440 so the wide sizes fit the private Xvfb).
//   resize:<tab>:<w>x<h>  the window at any tiled size / aspect: nothing in the top bar sticks out of the window or
//                         overlaps another top-bar control, the top bar stays a band (≤ 35 % of the height), the search
//                         field keeps a usable width, the page never scrolls sideways, the grid's cards fit its width.
//                         Screenshot per cell: <LIASCAPE_OUT>/layout-<tab>-<w>x<h>.png
//   resize:side:<w>x<h>   the item sidebar fits the window (inside it, close + actions reachable); ≥ 900 px it docks (the grid
//                         ends at its left edge, no card under it), narrower it floats over the page with a scrim
//   dock:hover[:off]      hovering a playlist bar item lifts it most (4 px) and its two neighbours a little (transform
//                         only); "Smooth window animations" off → only the hovered one (2 px, as before), no neighbours,
//                         no easing
//   look:plFold[:off|:reduced] the playlist bar's fold chevron, clicked: collapsing, the chevron turns, the bar's edge slides
//                         down and the row fades out through in-between frames, the items stay in the document (hidden);
//                         expanding plays it back to where it started. The grid's columns and cards never move, --playlist-bar-h
//                         ends at the bar's height, aria-expanded / the saved setting / locate-playing follow; motion off or
//                         reduced: no in-between frame. Screenshots plfold-<collapse|expand>-<mid|mode>.png
//   tabs:slide[:off|:reduced] switching tabs slides the active pill (transform) and slides/fades the page in
//                         (transform + opacity); off / prefers-reduced-motion → it jumps, nothing animates
//   tabs:keep             the Library page is kept while Browse shows (hidden, its sidebar too, taking no room from Browse's
//                         grid); back on it: the same grid, at the offset it was left at (the same card at the same place),
//                         its selection cleared, its sidebar docked again
//   tabs:browse           Browse (built on each visit) on a stubbed paged Workshop source: back on it, the list it had (no
//                         /browse request) at the offset it was left at, exact from the first frame it paints and in every
//                         frame after, with motion on, off and the item sidebar docked; a notch then glides on from there, →
//                         steps the focus on in view; a search, a filter or another source starts the list at its top, and
//                         a switch away and back keeps it there
//   scroll:bound          booted straight into the Library (its items arrive after mount): .lib-scroll carries the smooth
//                         scroll's wheel listener
//   scroll:glide[:browse|:settings] a notched wheel tick (whole-pixel delta, not precise) glides: the page cancels it and
//                         scrollTop keeps moving well after the event, ending ~1.5× the tick's native step
//   scroll:touchpad       a touchpad stream (precise, fractional deltas — one whole 120 mid-gesture) scrolls natively: never
//                         cancelled, lands on the summed deltas within a few frames of the last event, no coast
//   scroll:off[:reduced]  "Smooth window animations" off / prefers-reduced-motion: a notch scrolls natively (not cancelled,
//                         the native step, no long coast)
//   seg:glide:<w>x<h>     the segmented control (the Settings level picker): Basic → Expert, its highlight glides on transform
//                         through in-between frames with a spring's small overshoot and lands centred on Expert at its width;
//                         seg:jump:<w>x<h> / seg:jump:reduced — motion off / reduced motion: it jumps. Screenshots seg-*-midglide.png
//   seg:keys              arrows / Home / End move the choice and the focus, the key is taken, only the checked option is a Tab stop
//   seg:glow              the highlight glows, none under no-glow; the track goes translucent under bg-live
//   perf:idle             an idle page asks for no frames
//   perf:skeleton         Browse's placeholder cards + the load bar (a /browse that never answers): nothing asks for a main frame
//                         every refresh (≤ SKEL_RECALCS_PER_FRAME main-thread style recalcs per frame the compositor drew);
//                         the shimmer and the load bar sweep with motion on (transform + pixels), stand still with motion off /
//                         reduced motion
//   perf:tabs             on a PERF_N-item library: each real tab click forces no layout from script (an effect / handler
//                         measuring the new page before its frame does); a switch to Library restyles under PERF_STYLED_MAX
//                         elements per element of the document (no whole-page restyle) and runs no requestAnimationFrame
//                         callback; prints the longest task, what mounted and what was restyled
//   perf:sidebar          right-click open / switch / Escape close re-render the sidebar, not the grid's cards or the
//                         playlist bar (React's commit hook counts the components that ran), and force no layout
//                         (LIASCAPE_PERF_DUMP=1: every step's trace → <LIASCAPE_OUT>/perf-trace-<n>.json)
//   perf:plFold           a PERF_N-item playlist: folding and unfolding the playlist bar (real clicks) mount, unmount and
//                         re-render under PERF_FOLD_MAX components (the items stay mounted, hidden) and force no layout;
//                         the row comes back at its scroll offset; prints each click's longest task
//   perf:dockRepaint      on a heavy Library (long playlist, autoplaying video thumbnails, live wallpaper, a playing card) a
//                         dock sweep doesn't repaint the whole playlist bar every frame, and its items stack exactly as they
//                         magnify; prints the layer tree (element + Chromium's compositing reasons) and what repainted most
//   grid:boot[:wide]      booted straight into a Square (1:1) / widescreen (16:9) Library (its items and the settings arrive
//                         after mount): the column fit binds (the grid has a fitted --cols, a resize refits it) and the first
//                         column count painted with cards is the final one (no stylesheet default, no other aspect's fit first)
//   grid:panel:<w>x<h>    1920×1080 / 1100×700: opening the docked item sidebar changes the column count, not the card size
//                         (within 5 %, or the closest column count's where none is), no edge gap wider than the grid's gap;
//                         closing it restores the grid
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
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);
async function setSettings(patch) { const s0 = (await http("GET", "/settings")).json; await post("/settings", { ...s0, ...patch }); }
// "Smooth window animations" through its own Settings row (a /settings POST from here doesn't reach the open page's store)
async function setMotion(on) {
  // (Settings is a lazy chunk: a first visit can take seconds to mount)
  await page(`m.byText(".tab", "Settings").click(); await m.sleep(700);
    const find = () => [...document.querySelectorAll(".srow")].find((r) => r.querySelector(".slabel")?.textContent.includes("Smooth window animations"));
    for (let w = 0; w < 8000 && !find(); w += 100) await m.sleep(100);
    const row = find();
    if (!row) throw new Error("no Smooth window animations row");
    const cb = row.querySelector("input[type=checkbox]"); if (cb.checked !== ${on}) cb.click(); await m.sleep(500);`);
}

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__ly = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  // the Library grid's row the eye is on: the first card whose bottom is below the grid's top edge, and its place
  libAt() { const sc = document.querySelector(".lib-scroll"), top = sc.getBoundingClientRect().y;
    const a = [...sc.querySelectorAll(".card.lib")].find((c) => c.getBoundingClientRect().bottom > top + 1);
    return { id: a?.querySelector("[data-title]")?.dataset.title ?? null, y: a ? a.getBoundingClientRect().y - top : null }; },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; },
  ty(el) { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === "none" ? undefined : getComputedStyle(el).transform); return m.m42; },
  // the top bar's visible controls (what a user sees and clicks), leaves of its flex rows. A source pill shows only where its
  // sideways-scrolling strip does (components/SourcePills.tsx): clipped to the strip's box, gone when scrolled out of it
  topbarParts() {
    const tb = document.querySelector(".topbar");
    const shown = (e) => { const b = e.getBoundingClientRect(), st = e.closest(".pill-strip");
      if (!st || getComputedStyle(st).display === "contents") return b;
      const s = st.getBoundingClientRect(), cs = getComputedStyle(st), l = s.left + parseFloat(cs.paddingLeft), r = s.right - parseFloat(cs.paddingRight);
      const x = Math.max(b.left, l), rr = Math.min(b.right, r);
      return rr - x > 1 ? new DOMRect(x, b.top, rr - x, b.height) : new DOMRect(0, 0, 0, 0); };
    const parts = [...tb.querySelectorAll(".tab, .pill, .seg, .mini, .search, .sel, .btn, .status")].filter((e) => { const b = shown(e); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden"; });
    const r = (e) => { const b = shown(e); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
    return { tb: this.rect(tb), parts: parts.map((e) => ({ k: e.className.split(" ")[0] + (e.textContent ? ":" + e.textContent.trim().slice(0, 14) : ""), ...r(e), clipped: e.scrollWidth > e.clientWidth + 1 && !e.classList.contains("status") })) };
  },
}; true`;
const page = (code) => js(`(async () => { const m = window.__ly; ${code} })()`);

const SIZES = [[480, 720], [560, 430], [640, 480], [800, 600], [1100, 700], [1400, 900], [1920, 1080], [2400, 520], [1600, 400]];

async function resize(w, h) {
  win.setContentSize(w, h);
  for (let i = 0; i < 30; i++) { const [cw, ch] = await js(`[innerWidth, innerHeight]`); if (cw === w && ch === h) break; await sleep(50); }
  await sleep(450);
}
async function tab(name) { await page(`m.byText(".tab", ${JSON.stringify(name)}).click();`); await sleep(700); }
async function shot(name) { const img = await win.webContents.capturePage(); const f = path.join(OUT, `${name}.png`); fs.writeFileSync(f, img.toPNG()); return f; }
async function hover(el) { // a real pointer move (hit-tested), centre of the selector's nth match
  const r = await page(`const e = document.querySelectorAll(${JSON.stringify(el.sel)})[${el.i}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };`);
  if (!r) throw new Error(`no ${el.sel}[${el.i}]`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: r.x, y: r.y });
}
async function reducedMotion(on) {
  const d = win.webContents.debugger;
  if (!d.isAttached()) d.attach("1.3");
  await d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] });
}

// ---- perf cells: a library the size of a real one, a React commit counter, a trace per step ----
const PERF_N = 160;           // library items the perf cells add (copies of the 10 s clip)
const PERF_PLAYLIST = 30;     // of them in the playlist bar
const PERF_FORCED_MAX = 0;    // layouts forced from script per step
const PERF_SCRIPT_SHARE_MAX = 0.5; // of the script of a switch that builds a page, the most one task may run
const PERF_BUILD_MOUNTS = 200;     // components mounted by a switch that builds its page (the Library's: ~1,000)
const PERF_KEPT_MOUNTS_MAX = 50;   // components mounted by a switch back to the kept Library page (its sidebar, a status line)
// elements restyled by a switch to Library, per element in the document: the new page and the playlist bar are styled
// about once (their offscreen cards and items are content-visibility skipped); a value written that every element inherits
// (a measured height on .app or :root, a grid re-fit through a wrong height) restyles the page again each time
const PERF_STYLED_MAX = 0.6;
const PERF_RAFS_MAX = 0;      // requestAnimationFrame callbacks on a switch to Library: its motion is CSS, nothing to settle
// components mounted, unmounted or re-rendered by a click on the playlist bar's fold: the bar, its head and what reads the
// settings object the click saves (~70); a component per playlist item (perf:plFold's PERF_N, each item ~4) is far over it
const PERF_FOLD_MAX = 150;
const PERF_SIDE_RENDERS_MAX = 200; // components re-rendered per sidebar step: the sidebar's own few dozen pass, the grid's
                                   // cards (~6 components each, PERF_N of them) don't
const DOCK_PLAYLIST = 45;          // perf:dockRepaint: playlist bar items (most of them scrolled out of the bar's view)
const DOCK_GROW = 8;               // hooks/useDockLift.ts RISE − LIFT: px an item grows at amount 1 (its scale: 1 + DOCK_GROW / height)
const DOCK_BAR_REPAINTS_MAX = 0.75; // perf:dockRepaint: repaints of the whole playlist bar per dock frame: ~1 when every frame
                                    // writes a z-index, ~0.5 when only a change of the items' order does (a sweep reorders them often)
const SKEL_N = 72;            // perf:skeleton: Browse's placeholder cards while more pages are coming (views/Browse.tsx)
const SKEL_WINDOW = 1200;     // perf:skeleton: ms traced
// perf:skeleton: main-thread style recalcs per frame drawn. A main-thread animation anywhere on the page: 1 (each restyling
// every running animation, the 72 shimmers too); composited only: Chromium's own few syncs a second (~0.15 at 60 Hz, less faster)
const SKEL_RECALCS_PER_FRAME = 0.4;
const SKEL_DRAW_EVENT = "ProxyImpl::ScheduledActionDraw"; // perf:skeleton: a frame the renderer's compositor thread drew
const SKEL_GAP = 250;         // perf:skeleton: ms between the two looks at the sweep (≈ a fifth of its 1.2 s period)
const SKEL_PX_MIN = 200;      // perf:skeleton: pixel bytes that must change between them with motion on
// ---- tabs:browse: Browse's list and offset across tab switches, on a stubbed Workshop source ----
const BR_PER_PAGE = 40;       // items per stubbed /browse page
const BR_PAGES = 6;           // pages the stub serves before an empty one (the end of the list)
const BR_LOADED = 160;        // cards loaded (4 pages) before the offset is taken: rows the user scrolled through
const BR_FRAMES = 30;         // frames sampled after the return: none may move the grid
const BR_TOL = 0.5;           // px: the offset and the anchor card's place come back exact (the layout's own resolution)
const BR_THUMBS = [];
function makeBrowseThumbs() {
  if (BR_THUMBS.length) return;
  const d = path.join(E.XDG_CACHE_HOME || path.join(OUT, ".cache"), "liascape", "br-thumbs"); fs.mkdirSync(d, { recursive: true });
  ["0x4c4f9a", "0x1f6f8b", "0x8b3a62", "0x2e7d4f", "0x9a6b2f", "0x5a2e8b"].forEach((c, i) => {
    const f = path.join(d, `t${i}.jpg`);
    require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `gradients=size=480x270:c0=${c}:c1=0x101018:seed=${i + 1}`,
      "-frames:v", "1", f], { timeout: 30000 });
    BR_THUMBS.push(f);
  });
}
// The page's POST /browse for a Workshop source (it carries `filter`) answered here: BR_PER_PAGE items per page, distinct per
// search + filter (their titles carry both); every /browse request (any source) recorded in window.__br; /detail answered for the item sidebar.
const BR_STUB = () => `(() => { window.__br = []; const thumbs = ${JSON.stringify(BR_THUMBS)};
  const f = window.fetch; window.fetch = (u, o) => { const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    const ok = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (p === "/browse" && (o?.method || "GET") === "POST") { const b = JSON.parse(o.body);
      window.__br.push({ source: b.source, page: b.page, query: b.query ?? "", inc: b.filter?.include.join(",") ?? null }); if (b.filter) {
      const salt = (b.query ?? "") + "~" + b.filter.include.join(",");
      if (b.page > ${BR_PAGES}) return ok([]);
      return ok(Array.from({ length: ${BR_PER_PAGE} }, (_, i) => { const n = (b.page - 1) * ${BR_PER_PAGE} + i, id = String(7000000 + salt.length * 1000 + n);
        return { title: salt + " " + n, thumbnailUrl: thumbs[n % thumbs.length], animatedThumbnailUrl: null,
          pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + salt.length + "0" + n + "&s=" + encodeURIComponent(salt),
          resolution: "1920 x 1080", isScene: false, workshopId: id, addedAt: null, description: "probe", authorName: "probe",
          fileSizeBytes: 1000, subscriptions: n, favorites: n, views: n, tags: [] }; })); } }
    if (p === "/detail" && (o?.method || "GET") === "POST") { const b = JSON.parse(o.body); if (String(b.result?.pageUrl).includes("steamcommunity")) return ok({ title: b.result.title, previewUrl: b.result.thumbnailUrl, downloadUrl: "", needsReferrer: false }); }
    return f(u, o); }; })();`;
// where the shown Browse grid is: its offset, the first card whose bottom is below the grid's top edge (the row the eye
// is on) and that card's place in the grid, the cards loaded, the focused card
const BR_AT = `const sc = [...document.querySelectorAll(".app > .scroll:not(.lib-scroll)")].find((e) => e.offsetParent); if (!sc) return null;
  const top = sc.getBoundingClientRect().y, cards = [...sc.querySelectorAll(".card:not(.skel-card)")];
  const a = cards.find((c) => c.getBoundingClientRect().bottom > top + 1);
  return { top: sc.scrollTop, room: sc.scrollHeight - sc.clientHeight, n: cards.length, id: a?.querySelector("[data-title]")?.dataset.title ?? null,
    y: a ? a.getBoundingClientRect().y - top : null, focused: sc.querySelector(".card.focused [data-title]")?.dataset.title ?? null,
    cols: sc.style.getPropertyValue("--cols") };`;
// armed before a click on the Browse tab: the grid's place in the first frame the new page paints (read in a ResizeObserver
// made after the page's own, so after its first-layout work and before that frame's paint), then in each of BR_FRAMES frames
const BR_WATCH = `(() => { window.__brf = null; window.__brs = []; const read = () => { ${BR_AT} };
  const mo = new MutationObserver(() => { const sc = document.querySelector(".app > .scroll:not(.lib-scroll):not(.settings)"); if (!sc) return; mo.disconnect();
    const ro = new ResizeObserver(() => { ro.disconnect(); window.__brf = read(); let k = 0;
      const f = () => { window.__brs.push(read()); if (++k < ${BR_FRAMES}) requestAnimationFrame(f); }; requestAnimationFrame(f); });
    ro.observe(sc); });
  mo.observe(document.querySelector(".app"), { childList: true }); return true; })()`;
// React's DevTools hook, installed before the page's scripts: production react-dom calls onCommitFiberRoot on every commit.
// A fiber object that is still the current one from the last commit was never visited (its subtree neither); a new current
// one with no alternate mounted; with PerformedWork (flag 1) its component ran.
const RC_HOOK = `(() => {
  const C = new Set([0, 1, 11, 14, 15]); const cur = new WeakSet(); window.__rc = { rendered: 0, mounted: 0, unmounted: 0 }; window.__rcWho = {};
  // what re-rendered, named by the class of its first DOM node (production names are minified)
  const who = (f) => { let h = f.child; while (h && typeof h.type !== "string") h = h.child;
    const k = h ? h.type + "." + String(h.memoizedProps?.className ?? "").split(" ")[0] : "?"; window.__rcWho[k] = (window.__rcWho[k] ?? 0) + 1; };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; },
    // called for every fiber of a deleted subtree (react-dom walks it)
    onCommitFiberUnmount(_id, f) { if (C.has(f.tag)) window.__rc.unmounted++; }, onPostCommitFiberRoot() {}, checkDCE() {}, onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
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
// look:plFold — from a fold click on, each frame: the chevron's turn (deg), the bar's top edge, the row's effective opacity (it and
// its ancestors up to the bar; null = not in the document), the Library grid's --cols and first card's top, the properties
// the bar's subtree animates (CSS transitions and WAAPI)
const FOLD_MS = 1000;
const FOLD_REC = `(() => {
  const ang = (e) => { const t = e ? getComputedStyle(e).transform : "none"; if (!e) return null; if (t === "none") return 0; const m = new DOMMatrixReadOnly(t); return Math.atan2(m.b, m.a) * 180 / Math.PI; };
  const r = window.__pf = { f: [], on: true, stop() { this.on = false; return this.f; } };
  const grab = () => { const bar = document.querySelector(".playlist-bar"), row = bar?.querySelector(".playlist-bar-row"), sc = document.querySelector(".lib-scroll");
    let o = null; if (row) { o = 1; for (let e = row; e && e !== bar.parentElement; e = e.parentElement) o *= +getComputedStyle(e).opacity; if (!row.offsetParent) o = 0; }
    // the fold's own: the bar, its body and the chevron (the head's buttons have hover transitions of their own)
    const fold = (a) => { const t = a.effect?.target; return !!t && (!t.closest(".playlist-bar-head") || !!t.closest(".pl-chev")); };
    const props = bar ? bar.getAnimations({ subtree: true }).filter(fold).flatMap((a) => a.transitionProperty ? [a.transitionProperty]
      : (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))) : [];
    r.f.push({ chev: ang(bar?.querySelector(".pl-chev")), top: bar?.getBoundingClientRect().top, o, cols: sc?.style.getPropertyValue("--cols") ?? null,
      cardY: sc?.querySelector(".card.lib")?.getBoundingClientRect().top ?? null, props: [...new Set(props)] }); };
  grab();
  const f = () => { if (!r.on) return; grab(); requestAnimationFrame(f); }; requestAnimationFrame(f);
  return true; })()`;
const dbg = () => { const d = win.webContents.debugger; if (!d.isAttached()) d.attach("1.3"); return d; };
// grid:boot — from the document's start, each frame's first look at the Library grid: its element, its card count, the
// --cols the fit wrote on it ("" = none, the stylesheet's default)
const GRID_REC = `(() => {
  const r = window.__gb = { frames: [], on: true, stop() { this.on = false; } }; let id = 0;
  const tick = () => { if (!r.on || r.frames.length > 3000) return;
    const s = document.querySelector(".lib-scroll");
    if (s) { s.__gb ??= ++id; r.frames.push({ el: s.__gb, cards: s.querySelectorAll(".card.lib").length, cols: s.style.getPropertyValue("--cols") }); }
    requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();`;
// a grid's first row: the card width, the column count, the gaps between the row's ends and the scroll box's inner edges
// (its padding is one gap), the side margins the docked panels gave it
const GRID_GEO = (sel) => `const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return null;
  const cs = getComputedStyle(s), sb = s.getBoundingClientRect();
  const cards = [...s.querySelectorAll(".grid > .card")].slice(0, 80).filter((c) => c.offsetWidth > 0);
  if (!cards.length) return null;
  const row = cards.filter((c) => Math.abs(c.offsetTop - cards[0].offsetTop) < 2).map((c) => c.getBoundingClientRect());
  const L = sb.left + s.clientLeft, R = L + s.clientWidth;
  return { w: row[0].width, cols: row.length, lgap: row[0].left - L, rgap: R - row[row.length - 1].right,
    gap: parseFloat(cs.getPropertyValue("--gap")) || 14, ml: parseFloat(cs.marginLeft), mr: parseFloat(cs.marginRight),
    cw: s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };`;
// card width with a panel open vs without: within GRID_TOL, or — where no whole column count gets that close (a narrow grid:
// 1fr columns, each count's width a step apart) — the closest count's
const GRID_TOL = 0.05;
const gridBest = (g, target) => { let b = Infinity; for (let c = 1; c <= 60; c++) { const w = (g.cw - (c - 1) * g.gap) / c; if (w <= 0) break; b = Math.min(b, Math.abs(w / target - 1)); } return b; };
function gridSame(what, g0, g1) {
  const v = [], d = g1.w / g0.w - 1, best = gridBest(g1, g0.w), tol = Math.max(GRID_TOL, best + 0.002);
  if (tol > GRID_TOL) console.log(`        ${what}: no column count within ±${GRID_TOL * 100} % in a ${g1.cw.toFixed(0)} px grid — the closest is ${(best * 100).toFixed(1)} % off`);
  if (Math.abs(d) > tol) v.push(`${what}: cards ${g0.w.toFixed(1)} → ${g1.w.toFixed(1)} px (${(d * 100).toFixed(1)} %, within ±${(tol * 100).toFixed(1)} %) — ${g0.cols} → ${g1.cols} columns`);
  for (const [g, k] of [[g0, "no panel"], [g1, what]]) {
    if (Math.max(g.lgap, g.rgap) > g.gap + 1) v.push(`${k}: an edge gap of ${Math.max(g.lgap, g.rgap).toFixed(1)} px beside the row (≤ the ${g.gap} px gap)`);
  }
  return v;
}
let perfReady = false;
async function perfSetup() {
  if (perfReady) return; perfReady = true;
  const dir = path.join(OUT, "perf-lib"); fs.mkdirSync(dir, { recursive: true });
  const src = K[K.length - 1];
  const paths = [];
  for (let i = 0; i < PERF_N; i += 8) {
    paths.push(...(await Promise.all(Array.from({ length: Math.min(8, PERF_N - i) }, async (_, j) => {
      const f = path.join(dir, `p${i + j}.mp4`); fs.copyFileSync(src, f);
      return (await post("/library/import", { path: f, title: `perf ${String(i + j).padStart(3, "0")}` })).json?.videoPath;
    }))));
  }
  if (paths.filter(Boolean).length < PERF_N) throw new Error(`perf setup: imported ${paths.filter(Boolean).length} of ${PERF_N}`);
  await post("/playlist/state", { videoPaths: paths.slice(0, PERF_PLAYLIST), settings: null, name: null });
  const d = dbg(); await d.sendCommand("Page.enable");
  await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: RC_HOOK });
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= PERF_N) break; await sleep(100); }
  await js(PAGE); await sleep(1500);
  if (!(await js(`!!window.__rc && window.__rc.mounted > 0`))) throw new Error("perf setup: the React commit hook saw no commit");
}
async function centreOf(sel, text) {
  return page(`const e = m.byText(${JSON.stringify(sel)}, ${JSON.stringify(text)}); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };`);
}
// a press held like a hand holds it (down and up in one batch run in one task: the up's hit test then lays out what the
// down's handler changed, inside the measured task)
async function clickAt({ x, y }, button = "left") {
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
  await sleep(80);
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
}
// one step under a trace + the commit counter: the renderer main thread's longest task, its busy time, the layouts that ran
// inside a JS call (forced), and the components React rendered / mounted meanwhile
let perfDumps = 0; // LIASCAPE_PERF_DUMP=1: each step's trace → <LIASCAPE_OUT>/perf-trace-<n>.json (open in DevTools' Performance panel)
async function perfStep(fn) {
  const d = dbg();
  const evs = [];
  const onMsg = (_e, method, params) => { if (method === "Tracing.dataCollected") evs.push(...params.value); };
  d.on("message", onMsg);
  const rc0 = await js(`(window.__rcWho = {}, { ...window.__rc })`);
  const cats = ["toplevel", "blink", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.stack", "v8.execute"];
  if (E.LIASCAPE_PERF_DUMP) cats.push("disabled-by-default-v8.cpu_profiler"); // + JS samples in the dumped trace
  await d.sendCommand("Tracing.start", { traceConfig: { includedCategories: cats }, transferMode: "ReportEvents" });
  await fn();
  const rc1 = await js(`({ ...window.__rc, who: Object.entries(window.__rcWho).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + "×" + n).join(", ") })`);
  const done = new Promise((res) => { const h = (_e, m) => { if (m === "Tracing.tracingComplete") { d.removeListener("message", h); res(); } }; d.on("message", h); });
  await d.sendCommand("Tracing.end"); await done; d.removeListener("message", onMsg);
  if (E.LIASCAPE_PERF_DUMP) fs.writeFileSync(path.join(OUT, `perf-trace-${++perfDumps}.json`), JSON.stringify({ traceEvents: evs }));
  const names = {}; for (const e of evs) if (e.name === "thread_name") names[`${e.pid}:${e.tid}`] = e.args.name;
  const runs = {}; for (const e of evs) { const k = `${e.pid}:${e.tid}`; if (names[k] === "CrRendererMain" && e.name === "RunTask" && e.dur) runs[k] = (runs[k] ?? 0) + e.dur; }
  const main = Object.entries(runs).sort((a, b) => b[1] - a[1])[0]?.[0];
  const on = evs.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X");
  const tasks = on.filter((e) => e.name === "RunTask");
  // forced = a Layout run from script in the input's task, a timer or a React effect — not in a requestAnimationFrame or
  // ResizeObserver callback: those run inside the frame's own lifecycle (a per-frame aim like gridKeys.ts keepCardInView,
  // a grid re-fit), where a read only does the frame's coming layout early
  const JS = new Set(["FunctionCall", "EventDispatch", "TimerFire", "RunMicrotasks", "v8.callFunction", "EvaluateScript"]);
  const inside = (e, spans) => spans.some((j) => e.ts >= j.ts && e.ts < j.ts + j.dur);
  const jsSpans = on.filter((e) => JS.has(e.name));
  const frameCbs = on.filter((e) => e.name === "FireAnimationFrame" || e.name === "LocalFrameView::NotifyResizeObservers");
  const forced = on.filter((e) => e.name === "Layout" && inside(e, jsSpans) && !inside(e, frameCbs));
  // script per task: its outermost JS calls (rendering — style, layout, paint — is the browser's, not split by code)
  const top = jsSpans.filter((e) => !jsSpans.some((j) => j !== e && e.ts >= j.ts && e.ts + e.dur <= j.ts + j.dur && (j.ts < e.ts || j.dur > e.dur)));
  const perTask = tasks.map((t) => top.filter((e) => e.ts >= t.ts && e.ts < t.ts + t.dur).reduce((s, e) => s + e.dur, 0) / 1000);
  const script = perTask.reduce((a, b) => a + b, 0), maxScript = Math.max(0, ...perTask);
  // elements the style recalcs visited (an inherited custom property written high up restyles every element under it again)
  // against the document's size; the requestAnimationFrame callbacks that ran
  const styled = on.filter((e) => e.name === "UpdateLayoutTree").reduce((n, e) => n + (e.args?.elementCount ?? 0), 0);
  const dom = await js(`document.getElementsByTagName("*").length`);
  return { longest: Math.max(0, ...tasks.map((e) => e.dur)) / 1000, busy: tasks.reduce((s, e) => s + e.dur, 0) / 1000,
    script, maxScript, share: script ? maxScript / script : 0, styled, dom, rafs: on.filter((e) => e.name === "FireAnimationFrame").length,
    forced: forced.length, forcedMs: forced.reduce((s, e) => s + e.dur, 0) / 1000,
    // who forced it: the JS frame that asked (file:line:col of the bundle)
    forcedBy: forced.map((e) => { const f = e.args?.beginData?.stackTrace?.[0]; return f ? `${f.functionName || "?"}@${String(f.url).split("/").pop()}:${f.lineNumber}:${f.columnNumber}` : "?"; }).join(", "),
    rendered: rc1.rendered - rc0.rendered, mounted: rc1.mounted - rc0.mounted, unmounted: rc1.unmounted - rc0.unmounted, who: rc1.who };
}

// Wheel events through Chromium's input pipeline (webContents.sendInputEvent → a real WebMouseWheelEvent) at the scroller's
// left edge (clear of sliders), with scrollTop sampled every frame from 0. Returns the travel, when it last moved (ms after
// the first event), how many frames moved, the measured frame interval, and what the page saw of each event (cancelled?).
async function wheelRun(sel, evs, dur = 2200) {
  const at = await page(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollTop = 0; await m.sleep(300);
    const b = e.getBoundingClientRect(); return { x: Math.round(b.x + 12), y: Math.round(b.y + b.height / 2), room: e.scrollHeight - e.clientHeight };`);
  if (!at) throw new Error(`no ${sel} (tabs ${await js(`[...document.querySelectorAll('.tab')].map((t) => t.textContent + (t.classList.contains('active') ? '*' : '')).join(' ')`)}; scrollers ${await js(`[...document.querySelectorAll('.scroll')].map((e) => e.className).join(' | ')`)})`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y }); await sleep(400);
  await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); window.__ws = []; window.__wl = []; const t0 = window.__wt0 = performance.now();
    if (!window.__wlOn) { window.__wlOn = true; addEventListener("wheel", (e) => window.__wl.push({ t: performance.now() - window.__wt0, dp: e.defaultPrevented, dy: e.deltaY, wdy: e.wheelDeltaY, mode: e.deltaMode }), { passive: true }); }
    const tick = () => { const t = performance.now() - t0; window.__ws.push([t, el.scrollTop]); if (t < ${dur}) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  await sleep(100);
  for (const [i, ev] of evs.entries()) { win.webContents.sendInputEvent({ type: "mouseWheel", x: at.x, y: at.y, canScroll: true, ...ev }); if (i < evs.length - 1) await sleep(8); }
  await sleep(dur + 200);
  const { s, l } = await js(`({ s: window.__ws, l: window.__wl })`);
  const t0 = l[0]?.t ?? 0;
  let lastMove = 0, moves = 0;
  for (let i = 1; i < s.length; i++) if (s[i][1] !== s[i - 1][1]) { moves++; lastMove = s[i][0] - t0; }
  const dts = s.slice(1).map((x, i) => x[0] - s[i][0]).sort((a, b) => a - b);
  console.log(`        ${sel}: events ${JSON.stringify(l.map((e) => ({ dy: +e.dy.toFixed(2), wdy: e.wdy, mode: e.mode, cancelled: e.dp })))}; travel ${(s.at(-1)[1] - s[0][1]).toFixed(1)} px, ${moves} frames moved, last at ${lastMove.toFixed(0)} ms`);
  return { room: at.room, events: l, travel: s.at(-1)[1] - s[0][1], lastMove, moves, lastEvent: (l.at(-1)?.t ?? 0) - t0, frame: dts[dts.length >> 1] ?? 16.7 };
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
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
    await post("/playlist/state", { videoPaths: K.slice(0, Math.min(K.length, 4)), settings: null, name: null });
    await setSettings({ morphs: true, glows: true });
    await win.loadURL(withToken(U + "/"));
    for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
    await js(PAGE); await sleep(800);

    // ---- resize ----
    for (const [w, h] of SIZES) {
      await resize(w, h);
      for (const t of ["Browse", "Library", "Settings"]) {
        await cell(`resize:${t.toLowerCase()}:${w}x${h}`, async () => {
          await tab(t);
          const v = [];
          const { tb, parts } = await page(`return m.topbarParts();`);
          const vw = w, vh = h;
          for (const p of parts) {
            if (p.x < -0.5 || p.r > vw + 0.5) v.push(`top bar ${p.k} sticks out of the ${vw} px window (${p.x.toFixed(0)}–${p.r.toFixed(0)})`);
            if (p.clipped) v.push(`top bar ${p.k} cuts its own text (${p.w.toFixed(0)} px wide)`);
          }
          for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
            const a = parts[i], b = parts[j];
            const ix = Math.min(a.r, b.r) - Math.max(a.x, b.x), iy = Math.min(a.b, b.b) - Math.max(a.y, b.y);
            if (ix > 1 && iy > 1) v.push(`top bar ${a.k} overlaps ${b.k} (${ix.toFixed(0)}×${iy.toFixed(0)} px)`);
          }
          if (tb.h > 0.35 * vh) v.push(`the top bar takes ${tb.h.toFixed(0)} of ${vh} px`);
          const search = parts.find((p) => p.k.startsWith("search"));
          if (search && search.w < 110) v.push(`the search field is ${search.w.toFixed(0)} px wide`);
          const doc = await js(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth })`);
          if (doc.sw > doc.cw + 1 || doc.bw > doc.cw + 1) v.push(`the page scrolls sideways (${doc.sw} / ${doc.bw} > ${doc.cw})`);
          if (t !== "Settings") {
            const g = await page(`const s = document.querySelector(".scroll"); if (!s) return null; const sb = s.getBoundingClientRect();
              const cards = [...s.querySelectorAll(".card")].slice(0, 40).map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0);
              return { sr: sb.right, sl: sb.left, over: cards.filter((b) => b.right > sb.right + 1 || b.left < sb.left - 1).length, n: cards.length, hs: s.scrollWidth > s.clientWidth + 1 };`);
            if (g && (g.over || g.hs)) v.push(`${g.over}/${g.n} cards stick out of the grid${g.hs ? " (it scrolls sideways)" : ""}`);
          } else {
            const st = await page(`const s = document.querySelector(".settings"); if (!s) return null; return { sw: s.scrollWidth, cw: s.clientWidth };`);
            if (st && st.sw > st.cw + 1) v.push(`the settings page scrolls sideways (${st.sw} > ${st.cw})`);
          }
          await shot(`layout-${t.toLowerCase()}-${w}x${h}`);
          return v;
        });
      }
      await cell(`resize:side:${w}x${h}`, async () => {
        await tab("Library");
        // focus the first card without applying it (a right-click)
        await page(`const c = document.querySelector(".card.lib .thumb-wrap"); const r = c.getBoundingClientRect();
          c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }));`);
        await sleep(700);
        const r = await page(`const p = document.querySelector(".side-panel"); if (!p) return null; const b = m.rect(p);
          const close = p.querySelector("[data-side-close]"); const cb = close ? m.rect(close) : null;
          const del = m.byText(".side-panel button", "Delete"); del?.scrollIntoView({ block: "nearest" }); const db = del ? m.rect(del) : null;
          const sc = document.querySelector(".scroll"); const sb = sc ? m.rect(sc) : null;
          const cards = [...document.querySelectorAll(".card.lib")].slice(0, 40).map((c) => c.getBoundingClientRect()).filter((x) => x.width > 0);
          const scrimEl = document.querySelector(".side-scrim"), scrimTop = scrimEl && getComputedStyle(scrimEl).display !== "none" ? m.rect(scrimEl).y : null;
          return { b, cb, db, sb, tb: m.rect(document.querySelector(".topbar")), scrimTop, under: cards.filter((x) => x.right > b.x + 1 && x.bottom > b.y && x.top < b.b).length,
            scrim: document.elementFromPoint(Math.max(2, b.x / 2), b.y + 20)?.classList.contains("side-scrim") ?? false,
            doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, W: visualViewport?.width ?? innerWidth, H: visualViewport?.height ?? innerHeight };`);
        const v = [];
        if (!r) return ["no sidebar"];
        // against the page's own viewport: the window manager-less Xvfb window lands a few px off the asked size
        const W = r.W, H = r.H;
        if (r.b.x < -0.5 || r.b.y < -0.5 || r.b.r > W + 1 || r.b.b > H + 1) v.push(`the sidebar (${r.b.x.toFixed(1)},${r.b.y.toFixed(1)} ${r.b.w.toFixed(1)}×${r.b.h.toFixed(1)}) doesn't fit the ${W.toFixed(1)}×${H.toFixed(1)} window`);
        if (!r.cb || r.cb.b > H + 0.5 || r.cb.y < 0 || r.cb.r > W + 0.5) v.push("its close button is out of reach");
        if (!r.db || r.db.b > H + 0.5 || r.db.y < r.b.y - 0.5) v.push("its Delete button can't be scrolled into view");
        if (r.doc) v.push("the page scrolls sideways with the sidebar open");
        // it (and its scrim) start where the top bar ends, at every height the bar wraps to (index.css anchor(--topbar bottom))
        if (Math.abs(r.b.y - r.tb.b) > 0.5) v.push(`the sidebar starts at y ${r.b.y.toFixed(1)}, the top bar ends at ${r.tb.b.toFixed(1)}`);
        if (r.scrimTop !== null && Math.abs(r.scrimTop - r.tb.b) > 0.5) v.push(`the scrim starts at y ${r.scrimTop.toFixed(1)}, the top bar ends at ${r.tb.b.toFixed(1)}`);
        if (W >= 900) {
          if (r.under) v.push(`docked, but ${r.under} cards sit under the sidebar`);
          if (r.sb && r.sb.r > r.b.x + 1) v.push(`docked, but the grid runs under the sidebar (grid right ${r.sb.r.toFixed(0)} > ${r.b.x.toFixed(0)})`);
        } else if (!r.scrim) v.push("narrow window: the page beside the overlay sidebar isn't under its scrim (a click there must close it)");
        await shot(`layout-side-${w}x${h}`);
        await page(`document.querySelector(".side-panel [data-side-close]")?.click();`); await sleep(600);
        return v;
      });
    }
    await resize(1400, 900);

    // ---- dock hover ----
    const dock = async (morphs) => {
      await setMotion(morphs);
      await tab("Library");
      win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 }); await sleep(300);
      const n = await js(`document.querySelectorAll(".pl-item").length`);
      if (n < 4) return [`only ${n} playlist bar items`];
      await hover({ sel: ".pl-item", i: 1 });
      const mid = await page(`await m.sleep(40); return [...document.querySelectorAll(".pl-item")].map((e) => m.ty(e));`);
      await sleep(400);
      const ty = await page(`return [...document.querySelectorAll(".pl-item")].map((e) => m.ty(e));`);
      const v = [];
      console.log(`        lift ${ty.map((x) => x.toFixed(1)).join(" ")} (40 ms in: ${mid.map((x) => x.toFixed(1)).join(" ")})`);
      if (!(ty[1] < (morphs ? -2.5 : -1.5))) v.push(`the hovered item lifts ${(-ty[1]).toFixed(1)} px`);
      if (morphs) {
        if (!(ty[0] < -0.4 && ty[2] < -0.4)) v.push(`its neighbours don't lift (${ty[0].toFixed(1)}, ${ty[2].toFixed(1)})`);
        if (!(ty[0] > ty[1] && ty[2] > ty[1])) v.push(`a neighbour lifts as much as the hovered one`);
        if (Math.abs(ty[3]) > 0.4 && ty.length > 3 && Math.abs(ty[3]) >= Math.abs(ty[2])) v.push(`the item two away lifts as much as the neighbour (${ty[3].toFixed(1)})`);
      } else {
        if (Math.abs(ty[0]) > 0.1 || Math.abs(ty[2]) > 0.1) v.push(`animations off but the neighbours lift (${ty[0].toFixed(1)}, ${ty[2].toFixed(1)})`);
        if (Math.abs(mid[1] - ty[1]) > 0.1) v.push(`animations off but the lift eases in (${mid[1].toFixed(1)} → ${ty[1].toFixed(1)})`);
      }
      const props = await js(`getComputedStyle(document.querySelector(".pl-item")).transitionProperty`);
      if (/\b(top|margin|height|width|left)\b/.test(props)) v.push(`the lift transitions a layout property (${props})`);
      await shot(`dock-hover${morphs ? "" : "-off"}`);
      win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 }); await sleep(300);
      return v;
    };
    await cell("dock:hover", () => dock(true));
    await cell("dock:hover:off", () => dock(false));
    await setMotion(true);

    // ---- the playlist bar's fold ----
    // A real click on the fold chevron, then every frame for FOLD_MS: the chevron's turn, the bar's top edge on screen, the
    // row's effective opacity, place and whether it shows, the Library grid's --cols and its first card's top, and what the
    // bar animates. Collapse, then expand.
    const fold = async (mode) => {
      const v = [];
      await setMotion(mode !== "off"); await reducedMotion(mode === "reduced"); await sleep(300);
      await tab("Library");
      win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
      await page(`document.querySelector(".lib-scroll").scrollTop = 0;
        if (document.querySelector(".pl-fold")?.getAttribute("aria-expanded") === "false") { document.querySelector(".pl-fold").click(); await m.sleep(900); }`);
      const n0 = await js(`document.querySelectorAll(".pl-item").length`);
      if (n0 < 2) return [`only ${n0} playlist bar items — proved nothing`];
      const runs = {};
      for (const dir of ["collapse", "expand"]) {
        // the pointer gets to the chevron first (the fold moves the bar's head, so it is found again each time)
        const chev = await page(`const b = document.querySelector(".pl-fold").getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };`);
        win.webContents.sendInputEvent({ type: "mouseMove", x: chev.x, y: chev.y }); await sleep(400);
        await js(FOLD_REC);
        await clickAt(chev);
        await sleep(dir === "collapse" ? 120 : 200);
        if (mode === "on") await shot(`plfold-${dir}-mid`);
        await sleep(FOLD_MS);
        const f = await js(`window.__pf.stop()`);
        const end = await page(`const bar = document.querySelector(".playlist-bar"), row = bar.querySelector(".playlist-bar-row"), b = document.querySelector(".pl-fold");
          return { items: document.querySelectorAll(".pl-item").length, rowKept: !!row, rowShown: !!row?.offsetParent, exp: b.getAttribute("aria-expanded"),
            locate: !!bar.querySelector('[data-go-playing="bar"]')?.disabled, barH: bar.offsetHeight,
            varH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--playlist-bar-h")) };`);
        const saved = (await http("GET", "/settings")).json?.isPlaylistBarCollapsed;
        runs[dir] = { f, end, saved };
        await shot(`plfold-${dir}-${mode}`);
      }
      for (const [dir, { f, end, saved }] of Object.entries(runs)) {
        const want = dir === "collapse";
        if (f.length < 3) { v.push(`${dir}: only ${f.length} frames sampled — proved nothing`); continue; }
        const a = f[0], z = f[f.length - 1], fr = f.slice(1);
        const moving = (k) => fr.filter((x) => x[k] != null && a[k] != null && z[k] != null && Math.abs(x[k] - a[k]) > 1 && Math.abs(x[k] - z[k]) > 1).length;
        const fading = fr.filter((x) => x.o != null && x.o > 0.05 && x.o < 0.95).length;
        const cols = [...new Set(f.map((x) => x.cols))], dy = Math.max(...f.map((x) => Math.abs((x.cardY ?? 0) - (a.cardY ?? 0))));
        const props = [...new Set(f.flatMap((x) => x.props))];
        console.log(`        ${mode} ${dir}: chevron ${a.chev?.toFixed(0)}° → ${z.chev?.toFixed(0)}° (${moving("chev")} frames turning), bar top ${a.top?.toFixed(1)} → ${z.top?.toFixed(1)} px (${moving("top")} moving),`
          + ` row opacity ${fr.map((x) => x.o == null ? "-" : x.o.toFixed(2)).slice(0, 14).join(" ")}… (${fading} fading); ${f.length} frames; --cols ${cols.join("→")}, first card moved ${dy.toFixed(1)} px;`
          + ` animates [${props.join(", ")}]; end: ${end.items} items, row ${end.rowKept ? (end.rowShown ? "shown" : "hidden") : "gone"}, aria-expanded ${end.exp}, saved ${saved}, bar ${end.barH} px / --playlist-bar-h ${end.varH}`);
        // what must hold with motion on, off and reduced
        if (Math.abs(Math.abs(z.chev) - (want ? 90 : 0)) > 2) v.push(`${dir}: the chevron ends at ${z.chev?.toFixed(1)}° (${want ? "−90" : "0"})`);
        if (end.exp !== String(!want)) v.push(`${dir}: aria-expanded is ${end.exp}`);
        if (saved !== want) v.push(`${dir}: the setting saved isPlaylistBarCollapsed = ${saved}`);
        if (want && !end.locate) v.push("collapsed: locate-playing isn't disabled");
        if (end.items !== n0) v.push(`${dir}: ${end.items} playlist items in the document after it (${n0}): ${want ? "the collapse unmounted them" : "they were built again"}`);
        if (want ? end.rowShown || !end.rowKept : !end.rowShown) v.push(`${dir}: the row is ${end.rowKept ? (end.rowShown ? "shown" : "hidden") : "gone"} at the end`);
        if (!want && (Math.abs(z.o - 1) > 0.01 || Math.abs(z.top - runs.collapse.f[0].top) > 0.5)) v.push(`expand: it ends at opacity ${z.o}, top ${z.top} px (not where it started the collapse: ${runs.collapse.f[0].top} px)`);
        if (Math.abs(end.barH - end.varH) > 0.5) v.push(`${dir}: --playlist-bar-h is ${end.varH} px, the bar ${end.barH} px`);
        // the grid isn't re-fit by the bar: no column jump, its cards don't move
        if (cols.length > 1) v.push(`${dir}: the grid's columns changed ${cols.join(" → ")}`);
        if (dy > 0.5) v.push(`${dir}: the grid's first card moved ${dy.toFixed(1)} px`);
        const bad = props.filter((p) => !["transform", "opacity", "translate", "rotate", "scale"].includes(p));
        if (bad.length) v.push(`${dir}: the bar animates ${bad.join(", ")} (transform / opacity only)`);
        if (mode === "on") {
          if (moving("chev") < 3) v.push(`${dir}: the chevron jumped (${moving("chev")} frames turning)`);
          if (moving("top") < 3) v.push(`${dir}: the bar's edge jumped (${moving("top")} frames moving)`);
          if (fading < 2) v.push(`${dir}: the row didn't fade (${fading} frames between)`);
          if (!props.length) v.push(`${dir}: nothing in the bar animated`);
        } else {
          if (moving("chev") || moving("top") || fading) v.push(`${mode}: ${dir} still animates (chevron ${moving("chev")}, edge ${moving("top")}, fade ${fading} frames)`);
        }
      }
      await reducedMotion(false);
      win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
      return v;
    };
    // the playing card's pulse: one .playing-glow per grid, anchored behind the playing card (same box, also after the card
    // scrolls in from off screen, where content-visibility skipped it), pulsing by opacity alone (no repaint of the card),
    // gone under no-glow while the card's ring stays. Screenshot look-playingGlow.png.
    await cell("look:playingGlow", async () => {
      const v = [], J = JSON.stringify;
      const lib = (await http("GET", "/library")).json ?? [];
      const vid = lib.filter((i) => !i.isScene).map((i) => i.videoPath).pop();
      if (!vid) return ["no library video to play — proved nothing"];
      await post("/apply", { path: vid });
      for (let i = 0; i < 60 && (await http("GET", "/current")).json?.path !== vid; i++) await sleep(250);
      try {
        await win.loadURL(withToken(U + "/")); await js(PAGE); await tab("Library"); await sleep(600);
        const read = `(() => { const sc = document.querySelector(".lib-scroll"), c = sc?.querySelector(".card.playing"), g = sc?.querySelector(".playing-glow");
          const R = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
          return c && g ? { card: R(c), glow: R(g), op: +getComputedStyle(g).opacity, shadow: getComputedStyle(g).boxShadow, ring: getComputedStyle(c, "::before").boxShadow,
            anims: g.getAnimations().map((a) => a.animationName) } : { card: !!c, glow: !!g }; })()`;
        // from off screen: scroll away, then bring the card into view (the live app keeps it skipped until then)
        await js(`(() => { const sc = document.querySelector(".lib-scroll"); sc.scrollTo({ top: sc.scrollHeight, behavior: "instant" }); })()`); await sleep(300);
        await js(`document.querySelector(".lib-scroll .card.playing")?.scrollIntoView({ block: "center", behavior: "instant" })`); await sleep(400);
        const a = await js(read);
        if (!a.card || !a.glow || !Array.isArray(a.card)) return [`no playing card or no glow (${J(a)}) — proved nothing`];
        const off = Math.max(...a.card.map((x, i) => Math.abs(x - a.glow[i])));
        if (off > 1.5) v.push(`the glow isn't on the playing card: card ${J(a.card.map(Math.round))}, glow ${J(a.glow.map(Math.round))}`);
        if (!a.anims.includes("pulse-glow-op")) v.push(`the glow doesn't pulse (animations ${J(a.anims)})`);
        if (!/rgb/.test(a.ring)) v.push(`the card lost its ring (${a.ring})`);
        const ops = [];
        for (let i = 0; i < 12; i++) { ops.push((await js(read)).op); await sleep(150); }
        if (Math.max(...ops) - Math.min(...ops) < 0.4) v.push(`the pulse is too faint to see: opacity ${Math.min(...ops).toFixed(2)}–${Math.max(...ops).toFixed(2)}`);
        await shot("look-playingGlow");
        // the corners at the pulse's brightness levels: the glow held at fixed phases (its own animation paused there), the
        // card's top-left and bottom-right corners captured at 8x: look-playingGlow-corner-<phase>-<tl|br>.png
        const d = dbg();
        for (const [name, frac] of [["dim", 0], ["quarter", 0.15], ["half", 0.25], ["full", 0.5]]) {
          const box = await js(`(() => { const sc = document.querySelector(".lib-scroll"), c = sc.querySelector(".card.playing"), g = sc.querySelector(".playing-glow");
            const an = g.getAnimations()[0]; an.pause(); an.currentTime = ${frac} * 1800;
            const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, op: +getComputedStyle(g).opacity }; })()`);
          await sleep(250);
          for (const [corner, x, y] of [["tl", box.x - 14, box.y - 14], ["br", box.x + box.w - 26, box.y + box.h - 26]]) {
            const r = await d.sendCommand("Page.captureScreenshot", { format: "png", clip: { x, y, width: 40, height: 40, scale: 8 } });
            fs.writeFileSync(path.join(OUT, `look-playingGlow-corner-${name}-${corner}.png`), Buffer.from(r.data, "base64"));
          }
          console.log(`        corner shots at ${name}: opacity ${box.op.toFixed(2)}`);
        }
        await js(`document.querySelector(".lib-scroll .playing-glow").getAnimations()[0].play()`);
        // the open page doesn't see a /settings POST: reload, back to the playing card
        await setSettings({ glows: false }); await win.loadURL(withToken(U + "/")); await js(PAGE); await tab("Library"); await sleep(600);
        await js(`document.querySelector(".lib-scroll .card.playing")?.scrollIntoView({ block: "center", behavior: "instant" })`); await sleep(300);
        const ng = await js(read.replace("+getComputedStyle(g).opacity", "getComputedStyle(g).display === 'none' ? -1 : 1"));
        if (ng.op !== -1) v.push("no-glow: the pulse is still shown");
        if (!/rgb/.test(ng.ring ?? "")) v.push(`no-glow: the card lost its ring (${ng.ring})`);
        console.log(`        ${J({ off: +off.toFixed(2), ops: ops.map((x) => +x.toFixed(2)), ring: a.ring.slice(0, 40) })}`);
      } finally { await setSettings({ glows: true }); }
      return v;
    });

    await cell("look:plFold", () => fold("on"));
    await cell("look:plFold:off", () => fold("off"));
    await cell("look:plFold:reduced", () => fold("reduced"));
    await setMotion(true);

    // ---- tab slide ----
    const slide = async (mode) => {
      await setMotion(mode !== "off"); await reducedMotion(mode === "reduced"); await sleep(300);
      await tab("Browse"); await sleep(300);
      const r = await page(`const pill = document.querySelector(".tabs .tab-pill");
        const x0 = pill ? new DOMMatrixReadOnly(getComputedStyle(pill).transform === "none" ? undefined : getComputedStyle(pill).transform).m41 : null;
        m.byText(".tab", "Library").click();
        const xs = []; const anims = []; const t0 = performance.now();
        await new Promise((res) => { const f = () => {
          const p = document.querySelector(".tabs .tab-pill");
          xs.push(p ? new DOMMatrixReadOnly(getComputedStyle(p).transform === "none" ? undefined : getComputedStyle(p).transform).m41 : null);
          const sc = document.querySelector(".scroll");
          if (sc) for (const a of sc.getAnimations()) { const k = a.effect?.getKeyframes?.() ?? []; anims.push(...k.flatMap((x) => Object.keys(x).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))); }
          if (performance.now() - t0 < 500) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
        return { pill: !!pill, x0, xs, props: [...new Set(anims)] };`);
      const v = [];
      if (!r.pill) return ["no sliding pill (.tabs .tab-pill)"];
      const x1 = r.xs[r.xs.length - 1];
      const between = r.xs.filter((x) => x != null && Math.abs(x - r.x0) > 1 && Math.abs(x - x1) > 1).length;
      console.log(`        pill ${r.x0?.toFixed(0)} → ${x1?.toFixed(0)}, ${between} frames between, page animates [${r.props.join(", ")}]`);
      if (!(x1 > r.x0 + 10)) v.push(`the pill didn't move to Library (${r.x0} → ${x1})`);
      if (mode === "on") {
        if (between < 3) v.push(`the pill jumped (${between} frames between)`);
        if (!r.props.length) v.push("the page didn't slide/fade in");
        const bad = r.props.filter((p) => !["transform", "opacity", "translate"].includes(p));
        if (bad.length) v.push(`the page animates ${bad.join(", ")} (transform / opacity only)`);
      } else {
        if (between > 0) v.push(`${mode}: the pill still slides (${between} frames between)`);
        if (r.props.length) v.push(`${mode}: the page still animates (${r.props.join(", ")})`);
      }
      await shot(`tabs-slide-${mode}`);
      return v;
    };
    await cell("tabs:slide", () => slide("on"));
    await cell("tabs:slide:off", () => slide("off"));
    await cell("tabs:slide:reduced", () => slide("reduced"));
    // ---- the segmented control (components/Segmented.tsx), on the Settings level picker in the top bar ----
    // seg:glide: Basic → Expert, the highlight moves on transform through in-between frames (a spring: it passes the end a
    // little and settles), lands centred on Expert at its width; :off / :reduced it jumps. Both window sizes.
    const LV = (l) => `document.querySelector('[data-settings-level] [data-level="${l}"]')`;
    const segGlide = async (mode, W, H) => {
      await resize(W, H);
      await setMotion(mode !== "off"); await reducedMotion(mode === "reduced"); await sleep(300);
      await page(`${LV("basic")}?.click(); await m.sleep(800);`);
      try { return await segGlideAt(mode, W, H); } finally { await page(`${LV("standard")}?.click(); await m.sleep(600);`); await reducedMotion(false); }
    };
    const segGlideAt = async (mode, W, H) => {
      const r = await page(`const g = document.querySelector("[data-settings-level]"), hl = g?.querySelector(".seg-hl"); if (!hl) return null;
        const X = () => new DOMMatrixReadOnly(getComputedStyle(hl).transform === "none" ? undefined : getComputedStyle(hl).transform).m41;
        const x0 = X(); ${LV("expert")}.click(); const xs = [], props = new Set(); const t0 = performance.now();
        await new Promise((res) => { const f = () => { xs.push(X());
          for (const a of hl.getAnimations()) props.add(a.transitionProperty ?? Object.keys(a.effect?.getKeyframes?.()[0] ?? {}).join());
          if (performance.now() - t0 < 800) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
        const on = g.querySelector('[aria-checked="true"]'), h = hl.getBoundingClientRect(), o = on.getBoundingClientRect();
        return { x0, xs, props: [...props], on: on.dataset.level, dc: (h.x + h.width / 2) - (o.x + o.width / 2), dw: h.width - o.width,
          inTopbar: !!g.closest(".topbar") };`);
      const v = [];
      if (!r) return ["no segmented level picker ([data-settings-level] .seg-hl)"];
      const x1 = r.xs[r.xs.length - 1], peak = Math.max(...r.xs);
      const n = r.xs.filter((x) => Math.abs(x - r.x0) > 1 && Math.abs(x - x1) > 1).length;
      console.log(`        ${W}x${H} highlight ${r.x0.toFixed(1)} → ${x1.toFixed(1)} (peak ${peak.toFixed(1)}), ${n} frames between, animates [${r.props}]`);
      if (!r.inTopbar) v.push("the level picker isn't in the top bar");
      if (r.on !== "expert") v.push(`the checked option is ${r.on}, not expert`);
      if (!(x1 > r.x0 + 30)) v.push(`the highlight didn't move to Expert (${r.x0} → ${x1})`);
      if (Math.abs(r.dc) > 1 || Math.abs(r.dw) > 1) v.push(`the highlight landed ${r.dc.toFixed(2)} px off Expert's centre, ${r.dw.toFixed(2)} px off its width`);
      if (mode === "on") {
        if (n < 3) v.push(`the highlight jumped (${n} frames between)`);
        if (!(peak > x1 + 0.5)) v.push(`no spring: the highlight never passes its end (peak ${peak.toFixed(2)}, end ${x1.toFixed(2)})`);
        const bad = r.props.filter((p) => p && p !== "transform");
        if (bad.length) v.push(`it animates ${bad.join(", ")} (transform only)`);
      } else if (n) v.push(`${mode}: the highlight still glides (${n} frames between)`);
      // a picture mid-glide (motion on): back to Basic, captured on the way
      await page(`${LV("basic")}.click();`); await sleep(mode === "on" ? 120 : 30); await shot(`seg-${W}x${H}-${mode}-midglide`);
      await sleep(700);
      return v;
    };
    for (const [W, H] of [[1920, 1080], [1100, 700]]) {
      await cell(`seg:glide:${W}x${H}`, () => segGlide("on", W, H));
      await cell(`seg:jump:${W}x${H}`, () => segGlide("off", W, H));
    }
    await cell("seg:jump:reduced", () => segGlide("reduced", 1400, 900));
    await setMotion(true); await resize(1400, 900);
    // seg:keys: a radiogroup — only the checked option is a Tab stop; → / ← / End / Home move the choice and the focus (and
    // the setting saves); the key never reaches anything else (default prevented)
    await cell("seg:keys", async () => {
      const v = [];
      await tab("Settings"); await page(`${LV("standard")}?.click(); await m.sleep(500);`);
      const step = (k) => page(`const g = document.querySelector("[data-settings-level]"); const f = g.querySelector('[aria-checked="true"]'); f.focus();
        const e = new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(e); await m.sleep(400);
        const on = g.querySelector('[aria-checked="true"]');
        return { on: on?.dataset.level, focus: document.activeElement?.dataset.level ?? null, prevented: e.defaultPrevented,
          stops: [...g.querySelectorAll("[role=radio]")].filter((b) => b.tabIndex === 0).map((b) => b.dataset.level) };`);
      for (const [k, want] of [["ArrowRight", "advanced"], ["ArrowLeft", "standard"], ["End", "expert"], ["Home", "basic"], ["ArrowLeft", "expert"]]) {
        const r = await step(k);
        if (r.on !== want || r.focus !== want) v.push(`${k}: checked ${r.on}, focused ${r.focus} (want ${want})`);
        if (!r.prevented) v.push(`${k}: the key wasn't taken (default not prevented)`);
        if (r.stops.join() !== want) v.push(`${k}: Tab stops ${JSON.stringify(r.stops)} (only the checked option)`);
      }
      const saved = (await http("GET", "/settings")).json?.settingsLevel;
      if (saved !== "expert") v.push(`the keyboard choice didn't save (settingsLevel ${saved})`);
      await page(`${LV("standard")}?.click(); await m.sleep(500);`);
      return v;
    });
    // seg:glow: the highlight glows (brighter while its option is hovered), none under no-glow; under bg-live the track goes
    // translucent like the other chrome
    await cell("seg:glow", async () => {
      const v = [];
      await tab("Settings");
      const r = await page(`const root = document.documentElement, g = document.querySelector("[data-settings-level]"), hl = g?.querySelector(".seg-hl");
        if (!hl) return null; const out = { on: getComputedStyle(hl).boxShadow };
        root.classList.add("no-glow"); await m.sleep(50); out.off = getComputedStyle(hl).boxShadow; root.classList.remove("no-glow");
        const had = root.classList.contains("bg-live"); out.solid = getComputedStyle(g).backgroundColor;
        root.classList.add("bg-live"); await m.sleep(50); out.live = getComputedStyle(g).backgroundColor; if (!had) root.classList.remove("bg-live");
        return out;`);
      if (!r) return ["no segmented level picker"];
      if (!r.on || r.on === "none") v.push(`glows on: the highlight has no glow (${r.on})`);
      if (r.off !== "none") v.push(`no-glow: the highlight still glows (${r.off})`);
      if (r.solid === r.live) v.push(`bg-live: the track's fill doesn't go translucent (${r.live})`);
      return v;
    });
    // An idle page asks for no frames: a requestAnimationFrame loop that never stops (a frame counter, a "watch the box"
    // tick) makes Chromium render every refresh — 144 fps of style, layout and IntersectionObserver work, a third of a
    // core, with nothing on screen changing. CSS animations don't call rAF, so a shimmer or a spinner can't trip this.
    await cell("perf:idle", async () => {
      const v = [];
      await tab("Library"); win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 }); await sleep(1500);
      await js(`(() => { window.__rafN = 0; if (!window.__rafWrapped) { const o = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => { window.__rafN++; return o(cb); }; window.__rafWrapped = true; } })()`);
      const d = win.webContents.debugger; if (!d.isAttached()) d.attach("1.3");
      await d.sendCommand("Performance.enable");
      const get = async () => Object.fromEntries((await d.sendCommand("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
      const a = await get(); await sleep(3000); const b = await get();
      const raf = await js(`window.__rafN`);
      const recalc = Math.round((b.RecalcStyleCount - a.RecalcStyleCount) / 3), taskMs = Math.round(((b.TaskDuration - a.TaskDuration) / 3) * 1000);
      console.log(`        idle 3 s on Library: ${raf} rAF callbacks, ${recalc} style recalcs/s, main thread ${taskMs} ms/s`);
      if (raf > 12) v.push(`a requestAnimationFrame loop keeps running while idle (${raf} callbacks in 3 s)`);
      return v;
    });
    // Browse's placeholder cards while more pages are coming (a /browse that never answers keeps all of them up, and the
    // top bar's load bar with them). A compositor animation still costs main-thread style work in every main frame that
    // runs for another reason (Blink re-resolves each running animation then): so while the cards shimmer, nothing on the
    // page may ask for a main frame every refresh — the load bar's sweep included. Main-thread style recalcs per frame the
    // compositor drew ≤ SKEL_RECALCS_PER_FRAME; the shimmer and the load bar still sweep with motion on (transform moves,
    // pixels change) and stand still with motion off / reduced motion.
    await cell("perf:skeleton", async () => {
      const v = [];
      await setSettings({ morphs: true, autoPlayVideoThumbs: false, liveWallpaperBehindAllTabs: false });
      const d = dbg(); await d.sendCommand("Page.enable");
      const hang = `(() => { const f = window.fetch; window.fetch = (u, o) => {
        const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
        return p === "/browse" && (o?.method || "GET") === "POST" ? new Promise(() => {}) : f(u, o); }; })();`;
      const { identifier } = await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: hang });
      try {
        await win.loadURL(withToken(U + "/"));
        for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
        await js(PAGE); await reducedMotion(false); await tab("Browse");
        for (let i = 0; i < 50; i++) { if (await js(`document.querySelectorAll('.skel-card').length`) >= SKEL_N) break; await sleep(100); }
        win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 }); await sleep(1000);
        const st = await js(`({ n: document.querySelectorAll('.skel-card').length, bar: !!document.querySelector('.loadbar') })`);
        if (st.n < SKEL_N || !st.bar) return [`${st.n} placeholder cards on Browse (want ${SKEL_N}), load bar ${st.bar} — proved nothing`];
        // over SKEL_WINDOW ms, from Chromium's own trace (a rAF meter would force the main frames it counts): the renderer main
        // thread's style recalcs, the frames its compositor thread drew
        const evs = []; let done;
        const onMsg = (_e, m, p) => { if (m === "Tracing.dataCollected") evs.push(...p.value); else if (m === "Tracing.tracingComplete") done(); };
        d.on("message", onMsg);
        await d.sendCommand("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "cc"] }, transferMode: "ReportEvents" });
        await sleep(SKEL_WINDOW);
        const complete = new Promise((res) => { done = res; });
        await d.sendCommand("Tracing.end"); await complete; d.removeListener("message", onMsg);
        const names = {}; for (const e of evs) if (e.name === "thread_name") names[`${e.pid}:${e.tid}`] = e.args.name;
        const runs = {}; for (const e of evs) { const k = `${e.pid}:${e.tid}`; if (names[k] === "CrRendererMain" && e.name === "RunTask" && e.dur) runs[k] = (runs[k] ?? 0) + e.dur; }
        const main = Object.entries(runs).sort((a, b) => b[1] - a[1])[0]?.[0];
        const pid = main?.split(":")[0];
        const recalcs = evs.filter((e) => `${e.pid}:${e.tid}` === main && e.name === "UpdateLayoutTree" && e.ph === "X");
        const styled = recalcs.reduce((s, e) => s + (e.args?.elementCount ?? 0), 0);
        const comp = evs.filter((e) => String(e.pid) === pid && names[`${e.pid}:${e.tid}`] === "Compositor");
        const draws = comp.filter((e) => e.name === SKEL_DRAW_EVENT && e.ph === "X").length;
        console.log(`        ${st.n} placeholder cards + the load bar, ${SKEL_WINDOW} ms: the compositor drew ${draws} frames; the main thread ran ${recalcs.length} style recalcs (${draws ? (recalcs.length / draws).toFixed(2) : "-"} per frame), restyling ${styled} elements (${draws ? (styled / draws).toFixed(1) : "-"} per frame)`);
        if (draws < SKEL_WINDOW / 1000 * 20) {
          const top = {}; for (const e of comp) top[e.name] = (top[e.name] ?? 0) + 1;
          return [`the compositor drew ${draws} frames in ${SKEL_WINDOW} ms — proved nothing (its events: ${Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => `${k}×${c}`).join(", ")})`];
        }
        if (recalcs.length / draws > SKEL_RECALCS_PER_FRAME) v.push(`the main thread restyles while the placeholders shimmer: ${recalcs.length} style recalcs (${styled} elements) over ${draws} frames (≤ ${SKEL_RECALCS_PER_FRAME} per frame: something animates on the main thread)`);
        // the look: the first placeholder's shimmer (its transform + pixels) and the load bar's sweep, sampled SKEL_GAP ms apart
        const look = async () => {
          const r = await js(`(() => { const e = document.querySelector(".skel-card .skel"); const b = e.getBoundingClientRect(); const bar = document.querySelector(".loadbar");
            return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), t: getComputedStyle(e, "::after").transform,
              bar: bar ? getComputedStyle(bar, "::before").transform : null }; })()`);
          const img = await win.webContents.capturePage({ x: r.x + 2, y: r.y + 2, width: r.w - 4, height: r.h - 4 });
          return { t: r.t, bar: r.bar, px: img.toBitmap() };
        };
        const sweep = async () => {
          const a = await look(); await sleep(SKEL_GAP); const b = await look();
          let diff = 0; for (let i = 0; i < Math.min(a.px.length, b.px.length); i++) if (Math.abs(a.px[i] - b.px[i]) > 2) diff++;
          return { moved: a.t !== b.t, diff, a: a.t, b: b.t, barMoved: a.bar !== b.bar, bar: `${a.bar} → ${b.bar}` };
        };
        const s1 = await sweep(); await shot("perf-skeleton-on");
        console.log(`        motion on: shimmer ${s1.a} → ${s1.b}, ${s1.diff} pixel bytes changed; load bar ${s1.bar}`);
        if (!s1.moved || s1.diff < SKEL_PX_MIN) v.push(`motion on: the shimmer doesn't sweep (transform ${s1.a} → ${s1.b}, ${s1.diff} pixel bytes changed)`);
        if (!s1.barMoved) v.push(`motion on: the load bar's layer doesn't sweep (transform ${s1.bar})`);
        for (const mode of ["off", "reduced"]) {
          if (mode === "off") await setMotion(false); else { await setMotion(true); await reducedMotion(true); }
          await tab("Browse"); await sleep(500);
          const s = await sweep(); await shot(`perf-skeleton-${mode}`);
          console.log(`        motion ${mode}: shimmer ${s.a} → ${s.b}, ${s.diff} pixel bytes changed; load bar ${s.bar}`);
          if (s.moved || s.diff) v.push(`motion ${mode}: the shimmer still moves (transform ${s.a} → ${s.b}, ${s.diff} pixel bytes changed)`);
          if (s.barMoved) v.push(`motion ${mode}: the load bar still sweeps (transform ${s.bar})`);
        }
      } finally {
        await reducedMotion(false); await setMotion(true);
        await d.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        await win.loadURL(withToken(U + "/"));
        for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
        await js(PAGE); await sleep(800);
      }
      return v;
    });
    // tabs:browse — Browse is built on each visit, its list kept in the store: back on it, the list (no request) shows at the
    // offset it was left at, exact from the first frame it paints and still in every frame after (the rows scrolled past
    // and the ones skipped hold their size), with motion on and off; a wheel notch then glides on from there and the arrows
    // move the focus from the focused card (in view, no jump). Another search, filter or source starts its list at the top,
    // and a switch away and back keeps it there. A stubbed Workshop source (BR_STUB) with BR_PAGES pages of BR_PER_PAGE.
    await cell("tabs:browse", async () => {
      const v = [];
      makeBrowseThumbs();
      await resize(1400, 900);
      const srcs = (await http("GET", "/sources")).json;
      const ws = srcs.find((s) => s.supportsTagFilter && s.available);
      if (!ws) return ["no available Workshop source (supportsTagFilter) in /sources — proved nothing"];
      const ls0 = await js(`({ src: localStorage.getItem("liascape.activeSource"), bf: localStorage.getItem("liascape.browseFilter") })`);
      const d = dbg(); await d.sendCommand("Page.enable");
      const { identifier } = await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: BR_STUB() });
      const at = () => page(BR_AT);
      const posts = () => js(`window.__br.length`);
      const same = (a, b) => a && b && a.id === b.id && Math.abs(a.top - b.top) <= BR_TOL && Math.abs(a.y - b.y) <= BR_TOL;
      const show = (a) => a ? `${a.top.toFixed(1)} px, "${a.id}" at ${a.y?.toFixed(1)} px, ${a.n} cards` : "no grid";
      // scroll through the list until BR_LOADED cards came in (the infinite scroll's sentinel asks for each page), then to an
      // offset deep in it that isn't a row boundary
      const deep = async (frac) => {
        for (let i = 0; i < 60 && (await at())?.n < BR_LOADED; i++) { await page(`const sc = document.querySelector(".app > .scroll:not(.lib-scroll)"); sc.scrollTop = sc.scrollHeight;`); await sleep(250); }
        await page(`const sc = document.querySelector(".app > .scroll:not(.lib-scroll)"); sc.scrollTop = Math.round(${frac} * (sc.scrollHeight - sc.clientHeight)) + 37;`);
        for (let i = 0; i < 40 && (await js(`!!document.querySelector(".loadbar")`)); i++) await sleep(100);
        await sleep(700);
        return at();
      };
      // leave for the Library and come back by the Browse tab, the grid watched from the first frame the page paints
      const roundTrip = async (what, s0) => {
        const n0 = await posts();
        await tab("Library");
        await js(BR_WATCH); await page(`m.byText(".tab", "Browse").click();`); await sleep(1500);
        const { f, s } = await js(`({ f: window.__brf, s: window.__brs })`);
        const n1 = await posts(), s1 = await at();
        console.log(`        ${what}: left at ${show(s0)}; first frame back ${show(f)}; settled ${show(s1)}; ${n1 - n0} /browse requests`);
        if (n1 !== n0) v.push(`${what}: ${n1 - n0} /browse request(s) on the way back (the kept list loads again)`);
        if (!f) { v.push(`${what}: the watcher saw no Browse grid paint — proved nothing`); return s1; }
        if (!same(f, s0)) v.push(`${what}: the first frame back shows ${show(f)}, not where it was left (${show(s0)})`);
        const moved = s.findIndex((x) => !same(x, f));
        if (moved >= 0) v.push(`${what}: the grid moved ${moved + 1} frames after it showed: ${show(s[moved])} (first frame ${show(f)})`);
        if (s1?.n !== s0.n) v.push(`${what}: ${s1?.n} cards back, ${s0.n} were loaded`);
        return s1;
      };
      try {
        await win.loadURL(withToken(U + "/"));
        for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
        await js(PAGE); await reducedMotion(false);
        await tab("Browse");
        await page(`m.byText(".pill", ${JSON.stringify(ws.name)}).click();`);
        for (let i = 0; i < 60 && !((await at())?.n >= BR_PER_PAGE); i++) await sleep(100);
        win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
        // kept: a deep offset comes back exact, nothing requested
        const s0 = await deep(0.55);
        if (!s0 || s0.n < BR_LOADED || s0.top < 1500) return [`couldn't scroll the stubbed list deep (${show(s0)}; want ≥ ${BR_LOADED} cards, ≥ 1500 px) — proved nothing`];
        await roundTrip("motion on", s0);
        // a notch after the return glides on from the kept offset (the smooth scroll bound to the rebuilt grid)
        const g = await page(`const sc = document.querySelector(".app > .scroll:not(.lib-scroll)"); const b = sc.getBoundingClientRect();
          window.__wdp = null; sc.addEventListener("wheel", (e) => { window.__wdp = e.defaultPrevented; }, { once: true });
          return { x: Math.round(b.x + 12), y: Math.round(b.y + b.height / 2), top: sc.scrollTop };`);
        win.webContents.sendInputEvent({ type: "mouseMove", x: g.x, y: g.y }); await sleep(200);
        win.webContents.sendInputEvent({ type: "mouseWheel", x: g.x, y: g.y, canScroll: true, deltaX: 0, deltaY: -120, wheelTicksX: 0, wheelTicksY: -1, hasPreciseScrollingDeltas: false });
        await sleep(250); const g1 = await at(); await sleep(1200); const g2 = await at();
        console.log(`        notch after the return: ${g.top.toFixed(1)} → ${g1.top.toFixed(1)} (250 ms) → ${g2.top.toFixed(1)} px, cancelled ${await js("window.__wdp")}`);
        if (!(await js("window.__wdp"))) v.push("after the return a wheel notch wasn't taken by the smooth scroll (not cancelled)");
        if (!(g1.top > g.top + 20 && g2.top > g1.top + 5)) v.push(`after the return a notch doesn't glide on from ${g.top.toFixed(1)} px: ${g1.top.toFixed(1)} → ${g2.top.toFixed(1)} px`);
        // the arrows from a focused card: a right-click on a card in the middle of the view (the item sidebar opens), → steps on
        await sleep(400);
        const c = await page(`const sc = document.querySelector(".app > .scroll:not(.lib-scroll)"); const r = sc.getBoundingClientRect();
          const cs = [...sc.querySelectorAll(".card:not(.skel-card)")]; const k = cs.findIndex((e) => { const b = e.getBoundingClientRect(); return b.y > r.y + r.height * 0.3; });
          const b = cs[k].querySelector(".thumb-wrap").getBoundingClientRect();
          return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), id: cs[k].querySelector("[data-title]").dataset.title, next: cs[k + 1]?.querySelector("[data-title]").dataset.title };`);
        await clickAt(c, "right"); await sleep(900);
        const k0 = await at();
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" }); await sleep(600);
        const k1 = await at();
        const inView = await page(`const sc = document.querySelector(".app > .scroll:not(.lib-scroll)"); const r = sc.getBoundingClientRect(); const e = sc.querySelector(".card.focused");
          if (!e) return false; const b = e.getBoundingClientRect(); return b.y >= r.y - 1 && b.bottom <= r.bottom + 1;`);
        console.log(`        arrows: right-click "${c.id}" → focused "${k0.focused}" at ${k0.top.toFixed(1)} px; → "${k1.focused}" at ${k1.top.toFixed(1)} px, in view ${inView}`);
        if (k0.focused !== c.id) v.push(`a right-click on "${c.id}" after the return focused "${k0.focused}" — the arrows proved nothing`);
        else if (k1.focused !== c.next) v.push(`→ after the return focused "${k1.focused}", not the next card "${c.next}"`);
        if (!inView || Math.abs(k1.top - k0.top) > 400) v.push(`→ after the return: the focused card ${inView ? "is in view" : "is out of view"}, the grid went ${k0.top.toFixed(1)} → ${k1.top.toFixed(1)} px`);
        // with the item sidebar docked (the grid one column narrower): kept too
        await roundTrip("sidebar open", k1);
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await sleep(700);
        // another list starts at its top, and stays there across a switch: a search, a filter, another source
        const fresh = async (what, act, undo) => {
          const s1 = await deep(0.5);
          if (!(s1?.top > 500)) { v.push(`${what}: couldn't scroll deep first (${show(s1)}) — proved nothing`); return; }
          const n0 = await posts();
          await page(act);
          for (let i = 0; i < 40 && (await posts()) === n0; i++) await sleep(100);
          await sleep(900);
          const s2 = await at();
          console.log(`        ${what}: ${show(s1)} → ${show(s2)}`);
          if ((await posts()) === n0) v.push(`${what}: no /browse request — proved nothing`);
          else if (!s2 || s2.top !== 0) v.push(`${what}: the new list shows at ${s2?.top} px, not at its top`);
          await tab("Library"); await tab("Browse"); await sleep(300);
          const s3 = await at();
          if (!s3 || s3.top !== 0) v.push(`${what}: after a switch away and back the new list shows at ${s3?.top} px (the old list's offset came back)`);
          if (undo) { await page(undo); await sleep(1200); }
        };
        const setQ = (q) => `const i = document.querySelector("input.search"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event("input", { bubbles: true }));`;
        await fresh("search", setQ("probe"), setQ(""));
        // the item sidebar's round trip closed the filter panel (one right-hand panel at a time): its toggle brings it back
        await page(`const t = document.querySelector("[data-sortsplit] [data-wf-toggle]"); if (t?.getAttribute("aria-expanded") === "false") { t.click(); await m.sleep(500); }`);
        const tagged = await page(`const r = [...document.querySelectorAll(".wf-col:not(.closing) .wf-row[data-wf-tag]")].find((x) => !x.dataset.wfTag.startsWith("@") && x.querySelector(".wf-name")?.offsetParent); return r ? r.dataset.wfTag : null;`);
        if (!tagged) v.push("no filter row in the docked filter column — the filter case proved nothing");
        else {
          const name = `[...document.querySelectorAll(".wf-col:not(.closing) .wf-row")].find((r) => r.dataset.wfTag === ${JSON.stringify(tagged)}).querySelector(".wf-name").click();`;
          await fresh(`filter (${tagged})`, name, name);
        }
        const other = srcs.find((s) => s.available && s.index !== ws.index);
        if (!other) v.push("no second available source — the source case proved nothing");
        else await fresh(`source (${other.name})`, `m.byText(".pill", ${JSON.stringify(other.name)}).click();`, `m.byText(".pill", ${JSON.stringify(ws.name)}).click();`);
        // motion off: kept the same way, and the notch scrolls natively from there
        await setMotion(false); await tab("Browse");
        for (let i = 0; i < 60 && !((await at())?.n >= BR_PER_PAGE); i++) await sleep(100);
        const m0 = await deep(0.6);
        if (!m0 || m0.top < 1500) v.push(`motion off: couldn't scroll deep (${show(m0)}) — proved nothing`);
        else await roundTrip("motion off", m0);
      } finally {
        await setMotion(true);
        await d.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        await js(`(() => { const r = (k, x) => x == null ? localStorage.removeItem(k) : localStorage.setItem(k, x);
          r("liascape.activeSource", ${JSON.stringify(ls0.src)}); r("liascape.browseFilter", ${JSON.stringify(ls0.bf)}); })()`);
        await win.loadURL(withToken(U + "/"));
        for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
        await js(PAGE); await sleep(800);
      }
      return v;
    });
    // An app, not a page: Ctrl+A (or a drag) highlights none of the chrome; what you type and the text worth copying stays
    // selectable. Reads what the user would see: the live selection's text after selectAll, and computed user-select.
    await cell("select:chrome", async () => {
      const v = [];
      await tab("Browse"); await sleep(400);
      const r = await js(`(() => { document.getSelection().removeAllRanges(); document.execCommand("selectAll");
        const sel = document.getSelection().toString().trim(); document.getSelection().removeAllRanges();
        const us = (q) => { const e = document.querySelector(q); return e ? getComputedStyle(e).userSelect : null; };
        return { sel: sel.slice(0, 80), tab: us("button.tab"), pill: us(".pill"), search: us("input.search, .search input, input[type=search]") }; })()`);
      console.log(`        ${JSON.stringify(r)}`);
      if (r.sel) v.push(`Ctrl+A highlights app chrome: "${r.sel}"`);
      if (r.tab !== "none" || r.pill !== "none") v.push(`tabs / pills selectable (tab ${r.tab}, pill ${r.pill})`);
      if (r.search && r.search === "none") v.push("the search field's text can't be selected");
      return v;
    });
    await reducedMotion(false); await setMotion(true);

    // ---- smooth wheel scrolling (hooks/useSmoothScroll.ts) on a library that scrolls ----
    if (!ONLY || ONLY.test("scroll:bound") || ONLY.test("scroll:glide") || ONLY.test("scroll:touchpad") || ONLY.test("scroll:off")) {
      await perfSetup();
      // the real boot: a fresh load lands on the Library, which renders its "empty" placeholder until the items arrive
      await win.loadURL(withToken(U + "/"));
      for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= PERF_N) break; await sleep(100); }
      await js(PAGE); await sleep(1200);
    }
    await cell("scroll:bound", async () => {
      const d = dbg();
      const { result } = await d.sendCommand("Runtime.evaluate", { expression: `document.querySelector(".lib-scroll")` });
      if (!result.objectId) return ["no .lib-scroll after boot"];
      const { listeners } = await d.sendCommand("DOMDebugger.getEventListeners", { objectId: result.objectId });
      await d.sendCommand("Runtime.releaseObject", { objectId: result.objectId });
      const wheel = listeners.filter((l) => l.type === "wheel" && !l.passive);
      console.log(`        .lib-scroll after boot: ${wheel.length} non-passive wheel listener(s)`);
      return wheel.length ? [] : ["no wheel listener on .lib-scroll after booting into the Library — the smooth scroll never bound"];
    });
    const NOTCH = { deltaX: 0, deltaY: -120, wheelTicksX: 0, wheelTicksY: -1, hasPreciseScrollingDeltas: false };
    const notchRun = (sel) => wheelRun(sel, [NOTCH]);
    for (const [name, t, sel] of [["scroll:glide", "Library", ".lib-scroll"], ["scroll:glide:browse", "Browse", ".scroll:not(.lib-scroll):not(.settings)"], ["scroll:glide:settings", "Settings", ".scroll.settings"]]) {
      await cell(name, async () => {
        await tab(t);
        // Settings is a lazy chunk: its first visit mounts seconds later on the matrix's software GL
        for (let w = 0; w < 8000 && !(await js(`!!document.querySelector(${JSON.stringify(sel)})`)); w += 100) await sleep(100);
        await sleep(500);
        const r = await notchRun(sel);
        const v = [];
        if (r.room < 600) return [`${sel} can scroll only ${r.room} px — proved nothing`];
        if (!r.events.length) return ["no wheel event reached the page — proved nothing"];
        if (!r.events[0].dp) v.push("the notch was not cancelled (the browser scrolled it natively)");
        const ratio = r.travel / Math.abs(r.events[0].dy);
        if (ratio < 1.25 || ratio > 1.75) v.push(`travel ${r.travel.toFixed(0)} px = ${ratio.toFixed(2)}× the ${Math.abs(r.events[0].dy)} px step (1.25–1.75×)`);
        if (r.lastMove < 700) v.push(`scrollTop stopped ${r.lastMove.toFixed(0)} ms after the tick (a glide coasts ≥ 700 ms)`);
        if (r.moves < 15) v.push(`only ${r.moves} frames moved`);
        return v;
      });
    }
    await cell("scroll:touchpad", async () => {
      await tab("Library"); await sleep(400);
      // a two-finger swipe: fractional precise deltas from rest, one landing on a whole 120 mid-gesture (a fast frame)
      const dys = [2.3, 5.1, 9.7, 13.4, 120, 12.2, 8.6, 4.1];
      const r = await wheelRun(".lib-scroll", dys.map((dy) => ({ deltaX: 0, deltaY: -dy, wheelTicksX: 0, wheelTicksY: -dy / 120, hasPreciseScrollingDeltas: true })));
      const v = [];
      const sum = dys.reduce((a, b) => a + b, 0);
      if (r.events.length !== dys.length) return [`${r.events.length} of ${dys.length} wheel events reached the page — proved nothing`];
      const cancelled = r.events.filter((e) => e.dp).map((e) => e.dy);
      if (cancelled.length) v.push(`touchpad events cancelled (glided): ${cancelled.join(", ")}`);
      if (Math.abs(r.travel - sum) > 3) v.push(`travel ${r.travel.toFixed(1)} px, the deltas sum to ${sum.toFixed(1)} (native)`);
      const settle = r.lastMove - r.lastEvent;
      if (settle > 4 * r.frame) v.push(`scrollTop still moved ${settle.toFixed(0)} ms after the last event (≤ 4 frames of ${r.frame.toFixed(1)} ms: no coast)`);
      return v;
    });
    const off = async (mode) => {
      if (mode === "off") await setMotion(false); else await reducedMotion(true);
      await tab("Library"); await sleep(400);
      const r = await notchRun(".lib-scroll");
      if (mode === "off") await setMotion(true); else await reducedMotion(false);
      const v = [];
      if (!r.events.length) return ["no wheel event reached the page — proved nothing"];
      if (r.events[0].dp) v.push("the notch was cancelled (the smooth scroll took it)");
      if (Math.abs(r.travel - Math.abs(r.events[0].dy)) > 2) v.push(`travel ${r.travel.toFixed(1)} px, native is the ${Math.abs(r.events[0].dy)} px step`);
      if (r.lastMove > 500) v.push(`scrollTop moved until ${r.lastMove.toFixed(0)} ms after the tick (native settles < 500 ms)`);
      return v;
    };
    await cell("scroll:off", () => off("off"));
    await cell("scroll:off:reduced", () => off("reduced"));
    await reducedMotion(false);

    // ---- perf: tab switches and the item sidebar on a full library ----
    if (!ONLY || ["perf:tabs", "tabs:keep", "perf:sidebar", "perf:plFold", "perf:dockRepaint"].some((c) => ONLY.test(c))) await perfSetup();
    // A tab switch: Browse → Library → Settings → Library → Browse, each one a real click (sendInputEvent) under a trace.
    // Per switch: the longest main-thread task, the layouts forced from script (a Layout inside a JS call: the effect that
    // reads a size before the frame would lay out anyway), and the React components that rendered / mounted.
    await cell("perf:tabs", async () => {
      const v = [];
      await tab("Browse"); await sleep(800);
      const rows = [];
      for (const t of ["Library", "Settings", "Library", "Browse", "Library"]) {
        // measured and pointed at before the trace (the probe's own read forces a layout; a hand reaches the tab before it clicks)
        const at = await centreOf(".tab", t); win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y }); await sleep(400);
        const r = await perfStep(async () => { await clickAt(at); await sleep(900); });
        // the page the click asked for is the one showing (a kept page is in the document while hidden too)
        const showing = await js(`(() => { const sc = [...document.querySelectorAll(".app > .scroll")].filter((e) => e.offsetParent);
          return { n: sc.length, lib: sc.length === 1 && sc[0].classList.contains("lib-scroll") ? sc[0].querySelectorAll(".card.lib").length : -1 }; })()`);
        rows.push({ t, ...r, showing });
        console.log(`        → ${t.padEnd(8)} longest task ${r.longest.toFixed(0)} ms, busy ${r.busy.toFixed(0)} ms, script ${r.script.toFixed(0)} ms (one task ${r.maxScript.toFixed(0)} ms = ${(r.share * 100).toFixed(0)} %), ${r.forced} forced layouts (${r.forcedMs.toFixed(1)} ms), rendered ${r.rendered}, mounted ${r.mounted}, styled ${r.styled} of ${r.dom} elements, ${r.rafs} rAF callbacks`);
      }
      const lib = rows.filter((r) => r.t === "Library");
      for (const r of rows) if (r.showing.n !== 1) v.push(`→ ${r.t}: ${r.showing.n} pages showing after the switch (one)`);
      for (const r of lib) if (r.showing.lib < PERF_N) v.push(`→ Library: the Library page isn't showing its ${PERF_N} cards (${r.showing.lib}) — nothing measured (proved nothing)`);
      // the Library page stays mounted while another tab shows (App.tsx): coming back reveals it, nothing is built again
      for (const r of lib) if (r.mounted > PERF_KEPT_MOUNTS_MAX) v.push(`→ Library: ${r.mounted} components mounted (≤ ${PERF_KEPT_MOUNTS_MAX}): the page was built again, not kept`);
      // a page that is built (Settings, a first visit) builds in short slices: no one task runs most of the switch's script
      for (const r of rows) if (r.mounted >= PERF_BUILD_MOUNTS && r.share > PERF_SCRIPT_SHARE_MAX) v.push(`→ ${r.t}: one task ran ${(r.share * 100).toFixed(0)} % of the switch's script (${r.maxScript.toFixed(0)} of ${r.script.toFixed(0)} ms; ≤ ${PERF_SCRIPT_SHARE_MAX * 100} %)`);
      for (const r of rows) if (r.forced > PERF_FORCED_MAX) v.push(`→ ${r.t}: ${r.forced} layouts forced from script (≤ ${PERF_FORCED_MAX}): ${r.forcedBy}`);
      for (const r of lib) if (!r.styled) v.push("→ Library: the trace saw no style recalc — nothing measured (proved nothing)");
      for (const r of lib) if (r.styled > PERF_STYLED_MAX * r.dom) v.push(`→ Library: ${r.styled} elements restyled = ${(r.styled / r.dom).toFixed(2)}× the document's ${r.dom} (≤ ${PERF_STYLED_MAX}×): a whole-page restyle`);
      for (const r of lib) if (r.rafs > PERF_RAFS_MAX) v.push(`→ Library: ${r.rafs} requestAnimationFrame callbacks (≤ ${PERF_RAFS_MAX})`);
      return v;
    });
    // tabs:keep (on the PERF_N-card library) — the Library page is kept across tab switches (App.tsx <Activity>). Scrolled deep
    // with a card selected (a Ctrl+click: selects and focuses it, the sidebar opens, nothing is applied), then Browse: the
    // Library's grid and sidebar are hidden, not gone, and take no room from Browse's grid; back on the Library: the same grid
    // element at the offset it was left at (the same card at the same place: the rows it skipped hold their size), nothing
    // selected, its sidebar showing and docked again.
    await cell("tabs:keep", async () => {
      const v = [];
      await tab("Library"); await sleep(500);
      const s0 = await page(`const sc = document.querySelector(".lib-scroll"); if (!sc) return null; sc.__kept = 1;
        sc.querySelector(".card.lib .thumb-wrap").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
        await m.sleep(500); sc.scrollTop = Math.round(0.6 * (sc.scrollHeight - sc.clientHeight)) + 37; await m.sleep(400);
        return { top: sc.scrollTop, sel: sc.querySelectorAll(".card.selected").length, side: !!document.querySelector('.side-panel[data-side="library"]:not(.closing)'), ...m.libAt() };`);
      if (!s0) return ["no Library grid"];
      if (!(s0.top > 1000) || !s0.sel || !s0.side) return [`couldn't set the Library up (scrolled ${s0.top} px, ${s0.sel} selected, sidebar ${s0.side}) — proved nothing`];
      await tab("Browse"); await sleep(300);
      const b = await page(`const lib = document.querySelector(".lib-scroll"), sc = document.querySelector(".scroll");
        return { lib: !!lib, libShown: !!lib?.offsetParent, first: !!sc && !sc.classList.contains("lib-scroll") && !!sc.offsetParent,
          mr: sc ? parseFloat(getComputedStyle(sc).marginRight) : null, side: !!document.querySelector('.side-panel[data-side="library"]')?.offsetParent };`);
      if (!b.lib) v.push("on Browse: the Library's grid left the document (it is built again on the way back)");
      if (b.libShown) v.push("on Browse: the Library's grid still shows");
      if (!b.first) v.push("on Browse: the document's first .scroll isn't Browse's showing grid");
      if (b.mr) v.push(`on Browse: its grid leaves ${b.mr} px on its right for the Library's hidden sidebar`);
      if (b.side) v.push("on Browse: the Library's sidebar still shows");
      await tab("Library"); await sleep(300);
      const l = await page(`const sc = document.querySelector(".lib-scroll"); return { same: sc?.__kept === 1, top: sc?.scrollTop, sel: sc?.querySelectorAll(".card.selected").length,
        side: !!document.querySelector('.side-panel[data-side="library"]:not(.closing)')?.offsetParent, mr: sc ? parseFloat(getComputedStyle(sc).marginRight) : 0, ...m.libAt() };`);
      console.log(`        left at ${s0.top.toFixed(1)} px ("${s0.id}" at ${s0.y?.toFixed(1)} px); back at ${l.top?.toFixed(1)} px ("${l.id}" at ${l.y?.toFixed(1)} px)`);
      if (!l.same) v.push("back on the Library: its grid is a new element (built again, not kept)");
      if (Math.abs(l.top - s0.top) > BR_TOL || l.id !== s0.id || Math.abs(l.y - s0.y) > BR_TOL)
        v.push(`back on the Library: the grid is at ${l.top} px ("${l.id}" at ${l.y?.toFixed(1)} px), not where it was left (${s0.top} px, "${s0.id}" at ${s0.y?.toFixed(1)} px)`);
      if (l.sel) v.push(`back on the Library: ${l.sel} cards still selected`);
      if (!l.side) v.push("back on the Library: the focused card's sidebar isn't showing");
      else if (!(l.mr > 0)) v.push("back on the Library: its sidebar shows but the grid doesn't make room for it (not docked)");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await sleep(500);
      return v;
    });
    // The item sidebar: right-click a card (opens it), two more cards (switches), Escape (closes). A focus change re-renders
    // the sidebar, not the grid: every card and the playlist bar keep their props, so their memo holds.
    await cell("perf:sidebar", async () => {
      const v = [];
      await tab("Library"); await sleep(800);
      // the n-th card on screen that isn't the focused one (the docked sidebar re-fits the grid: positions move), measured
      // before the step's trace — the probe's own read would force a layout
      const cardAt = (n) => page(`const f = document.querySelector(".card.focused .thumb-wrap");
        const on = [...document.querySelectorAll(".card.lib .thumb-wrap")].filter((e) => e !== f).map((e) => e.getBoundingClientRect())
          .filter((b) => b.width > 0 && b.top > 0 && b.bottom < innerHeight - 200 && b.right < (document.querySelector(".side-panel")?.getBoundingClientRect().left ?? innerWidth));
        const b = on[${n}]; return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 3) } : null;`);
      let prevSide = null;
      for (const [what, n] of [["open", 0], ["switch", 1], ["switch", 2], ["close", null]]) {
        const at = n == null ? null : await cardAt(n);
        if (n != null && !at) { v.push(`${what}: no card on screen to right-click`); break; }
        if (at) win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y }); // the pointer gets there first
        await sleep(400);
        const r = await perfStep(async () => {
          if (at) await clickAt(at, "right");
          else { win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); await sleep(80); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); }
          await sleep(700);
        });
        const side = await js(`document.querySelector(".side-panel:not(.closing)")?.dataset.sideId ?? null`);
        console.log(`        ${what.padEnd(6)} longest task ${r.longest.toFixed(0)} ms, busy ${r.busy.toFixed(0)} ms, script ${r.script.toFixed(0)} ms (one task ${r.maxScript.toFixed(0)} ms), ${r.forced} forced layouts (${r.forcedMs.toFixed(1)} ms), rendered ${r.rendered}, mounted ${r.mounted}`);
        if (what === "close" ? side : !side || side === prevSide) { v.push(`${what}: the sidebar is ${side ? (side === prevSide ? "still on the same item" : "still open") : "not open"} — nothing measured (proved nothing)`); break; }
        prevSide = side;
        if (r.rendered > PERF_SIDE_RENDERS_MAX) v.push(`${what}: ${r.rendered} components re-rendered (≤ ${PERF_SIDE_RENDERS_MAX}: the grid's cards and the playlist bar must not) — most: ${r.who}`);
        if (r.forced > PERF_FORCED_MAX) v.push(`${what}: ${r.forced} layouts forced from script (≤ ${PERF_FORCED_MAX}): ${r.forcedBy}`);
      }
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
      return v;
    });
    // The playlist bar's fold on a long playlist (every library item, PERF_N): each click a real one under a trace. The items
    // stay mounted while the bar is folded (hidden, not unmounted), so neither click builds or tears down a component per
    // item; prints the click's longest task.
    await cell("perf:plFold", async () => {
      const v = [];
      const lib = (await http("GET", "/library")).json ?? [];
      const all = lib.map((i) => i.videoPath);
      if (all.length < PERF_N) return [`only ${all.length} library items — proved nothing`];
      await post("/playlist/state", { videoPaths: all, settings: null, name: null });
      await setSettings({ isPlaylistBarCollapsed: false });
      await win.loadURL(withToken(U + "/")); // the open page doesn't see a /settings POST
      for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.pl-item').length`) >= all.length) break; await sleep(100); }
      await js(PAGE); await tab("Library"); await sleep(1200);
      const n0 = await js(`document.querySelectorAll(".pl-item").length`);
      if (n0 < all.length) return [`${n0} of ${all.length} playlist items rendered — proved nothing`];
      // the row's scroll offset comes back with it (kept, not built again)
      const left0 = await page(`const r = document.querySelector(".playlist-bar-row"); r.scrollLeft = 1000; await m.sleep(300); return r.scrollLeft;`);
      if (!(left0 > 500)) return [`the row scrolled to ${left0} px, not 1000 — proved nothing`];
      for (const dir of ["collapse", "expand"]) {
        // the chevron, pointed at before the trace: the fold moves the bar's head
        const at = await page(`const b = document.querySelector(".pl-fold").getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };`);
        win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y }); await sleep(400);
        // the hand leaves once it has clicked: an expanding row rising under a still pointer would hover an item, and the
        // hover's own first glow placement (PlItem, probe-plbar bar:sweepCost) isn't the fold's cost
        const r = await perfStep(async () => { await clickAt(at); win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 }); await sleep(1000); });
        const s1 = await js(`({ exp: document.querySelector(".pl-fold").getAttribute("aria-expanded"), items: document.querySelectorAll(".pl-item").length })`);
        console.log(`        ${dir.padEnd(8)} longest task ${r.longest.toFixed(0)} ms, busy ${r.busy.toFixed(0)} ms, script ${r.script.toFixed(0)} ms, ${r.forced} forced layouts (${r.forcedMs.toFixed(1)} ms),`
          + ` rendered ${r.rendered}, mounted ${r.mounted}, unmounted ${r.unmounted}; ${s1.items} items in the document — most: ${r.who}`);
        if (s1.exp !== String(dir === "expand")) { v.push(`${dir}: aria-expanded is ${s1.exp} after the click — nothing measured (proved nothing)`); break; }
        if (r.mounted > PERF_FOLD_MAX) v.push(`${dir}: ${r.mounted} components mounted (≤ ${PERF_FOLD_MAX}): the items were built again`);
        if (r.unmounted > PERF_FOLD_MAX) v.push(`${dir}: ${r.unmounted} components unmounted (≤ ${PERF_FOLD_MAX}): the items were torn down`);
        if (r.rendered > PERF_FOLD_MAX) v.push(`${dir}: ${r.rendered} components re-rendered (≤ ${PERF_FOLD_MAX}) — most: ${r.who}`);
        if (r.forced > PERF_FORCED_MAX) v.push(`${dir}: ${r.forced} layouts forced from script (≤ ${PERF_FORCED_MAX}): ${r.forcedBy}`);
      }
      const left1 = await js(`document.querySelector(".playlist-bar-row")?.scrollLeft ?? null`);
      console.log(`        the row's scroll offset: ${left0} px before the fold, ${left1} after it`);
      if (!v.length && Math.abs(left1 - left0) > 1) v.push(`the row came back at scroll offset ${left1} px, not the ${left0} px it was left at`);
      await post("/playlist/state", { videoPaths: all.slice(0, PERF_PLAYLIST), settings: null, name: null });
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
      return v;
    });
    // The dock on a heavy Library (a long playlist, autoplaying video thumbnails, the live wallpaper behind the tab, a playing
    // card): a dock frame doesn't repaint the whole playlist bar (every z-index write does — the dock writes an item's stacking
    // RANK, which changes only when the items' order does), and that rank stacks the items exactly as their magnification
    // does (the more magnified on top, equal ones in DOM order, barely moved ones under the bar's head). Prints the layer
    // tree (element + Chromium's compositing reasons) and what repainted most.
    await cell("perf:dockRepaint", async () => {
      const v = [];
      const lib = (await http("GET", "/library")).json ?? [];
      const vids = lib.filter((i) => !i.isScene).map((i) => i.videoPath);
      if (vids.length < DOCK_PLAYLIST) return [`only ${vids.length} library videos — the cell proves nothing`];
      await post("/playlist/state", { videoPaths: vids.slice(0, DOCK_PLAYLIST), settings: null, name: null });
      await setSettings({ autoPlayVideoThumbs: true, liveWallpaperBehindAllTabs: true, isPlaylistBarCollapsed: false });
      await post("/apply", { path: vids[2] });
      for (let i = 0; i < 60 && (await http("GET", "/current")).json?.path !== vids[2]; i++) await sleep(250);
      await win.loadURL(withToken(U + "/")); // the open page doesn't see a /settings POST
      for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.pl-item').length`) >= DOCK_PLAYLIST) break; await sleep(100); }
      await js(PAGE); await tab("Library");
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 300 });
      const ready = async () => js(`({ vids: [...document.querySelectorAll(".card video.thumb.anim")].filter((x) => x.readyState >= 2).length,
        bg: !!document.querySelector("video.settings-bg"), playing: !!document.querySelector(".card.playing") })`);
      let st;
      for (let i = 0; i < 60; i++) { st = await ready(); if (st.vids >= 2 && st.bg && st.playing) break; await sleep(250); }
      if (st.vids < 2 || !st.bg || !st.playing) return [`no heavy Library to measure (${st.vids} autoplaying card videos, live wallpaper ${st.bg}, playing card ${st.playing}) — proved nothing`];
      await sleep(800);
      const d = dbg();
      await d.sendCommand("DOM.enable"); await d.sendCommand("DOM.getDocument", { depth: 0 });
      const label = async (backendNodeId) => {
        const n = await d.sendCommand("DOM.describeNode", { backendNodeId }).then((x) => x.node).catch(() => null);
        const cls = (n?.attributes ?? []).reduce((a, x, i, arr) => (x === "class" ? arr[i + 1] : a), "");
        return n ? `${n.localName}${cls ? "." + cls.split(" ").join(".") : ""}` : "?";
      };
      // the layer tree of the next commit, by element + reasons
      let tree = null;
      const onTree = (_e, m, p) => { if (m === "LayerTree.layerTreeDidChange" && p.layers) tree = p.layers; };
      d.on("message", onTree);
      await d.sendCommand("LayerTree.enable");
      for (let i = 0; i < 40 && !tree; i++) { if (i % 10 === 9) win.webContents.invalidate(); await sleep(100); }
      d.removeListener("message", onTree);
      const by = new Map();
      for (const l of tree ?? []) {
        const why = (await d.sendCommand("LayerTree.compositingReasons", { layerId: l.layerId }).catch(() => ({}))).compositingReasonIds ?? [];
        const k = `${l.backendNodeId ? (await label(l.backendNodeId)).split(".").slice(0, 2).join(".") : "(no element)"} [${why.join(",")}]`;
        by.set(k, (by.get(k) ?? 0) + 1);
      }
      await d.sendCommand("LayerTree.disable");
      console.log(`        idle: ${tree?.length ?? 0} layers — ${[...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c}× ${k}`).join(", ")}`);
      // per dock frame (its "dockframe" signal comes after its writes): the order the z-indexes give vs the magnification's
      await js(`(() => { const row = document.querySelector(".playlist-bar-row"); window.__dz = { bad: [], moved: 0 };
        const mag = ${DOCK_GROW} / row.children[0].offsetHeight; // read once: a read in the listener would force the frame's layout
        row.addEventListener("dockframe", () => {
          const its = [...row.children].map((e, i) => { const t = e.style.getPropertyValue("--dock"); if (!t) return null;
            // the amount ×100 (the dock's stacking key before rounding), from the written scale (4 decimals: ±0.07)
            const sc = +/scale\\(([-\\d.]+)\\)/.exec(t)[1], k = Math.max(0, (sc - 1) / mag) * 100;
            return { i, k, z: +e.style.zIndex }; }).filter(Boolean);
          window.__dz.moved = Math.max(window.__dz.moved, its.length);
          const bad = (x) => { if (window.__dz.bad.length < 5) window.__dz.bad.push(x); };
          for (const p of its) {
            if ((p.k >= 1 && p.z < 2) || (p.k < 0.4 && p.z >= 2)) bad("item " + p.i + " (amount " + p.k.toFixed(2) + "%) z " + p.z + " vs the head's 2");
            for (const q of its) if (p.i !== q.i && p.k - q.k > 1.5 && p.z <= q.z)
              bad("item " + p.i + " (" + p.k.toFixed(1) + "%) under item " + q.i + " (" + q.k.toFixed(1) + "%): z " + p.z + " / " + q.z);
          }
        }); })()`);
      // a sweep across the bar's items under a trace, ending at rest on one
      const r = await page(`const its = [...document.querySelectorAll(".pl-item")].map((e) => e.getBoundingClientRect()).filter((b) => b.right < innerWidth);
        return its.length < 4 ? null : { y: its[0].y + its[0].height / 2, x0: its[0].x + 4, x1: its[its.length - 1].right - 4 };`);
      if (!r) return ["fewer than 4 playlist bar items on screen — proved nothing"];
      const bar = (await d.sendCommand("DOM.describeNode", { objectId: (await d.sendCommand("Runtime.evaluate", { expression: `document.querySelector(".playlist-bar")` })).result.objectId })).node.backendNodeId;
      const evs = []; let done;
      const onMsg = (_e, m, p) => { if (m === "Tracing.dataCollected") evs.push(...p.value); else if (m === "Tracing.tracingComplete") done(); };
      d.on("message", onMsg);
      await d.sendCommand("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] }, transferMode: "ReportEvents" });
      for (let i = 0; i <= 120; i++) { win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(r.x0 + (r.x1 - r.x0) * (i / 120)), y: Math.round(r.y) }); await sleep(16); }
      const mid = Math.round((r.x0 + r.x1) / 2);
      for (let i = 0; i <= 30; i++) { win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(r.x1 + (mid - r.x1) * (i / 30)), y: Math.round(r.y) }); await sleep(16); }
      await sleep(500);
      const complete = new Promise((res) => { done = res; });
      await d.sendCommand("Tracing.end"); await complete; d.removeListener("message", onMsg);
      const frames = evs.filter((e) => e.name === "EventDispatch" && e.args?.data?.type === "dockframe").length;
      const barPaints = evs.filter((e) => e.name === "Paint" && e.args?.data?.nodeId === bar).length;
      const painted = new Map(); for (const e of evs) if (e.name === "Paint" && e.args?.data?.nodeId) painted.set(e.args.data.nodeId, (painted.get(e.args.data.nodeId) ?? 0) + 1);
      const most = [];
      for (const [id, c] of [...painted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) most.push(`${c}× ${await label(id)}`);
      const dz = await js(`window.__dz`);
      console.log(`        sweep: ${frames} dock frames, the bar repainted ${barPaints}× (${frames ? (barPaints / frames).toFixed(2) : "-"} per frame), up to ${dz.moved} items moved at once; most repainted: ${most.join(", ")}`);
      if (frames < 40) v.push(`only ${frames} dock frames during the sweep — proved nothing`);
      if (dz.moved < 3) v.push(`at most ${dz.moved} items moved at once — the stacking proved nothing`);
      for (const x of dz.bad) v.push(`stacking differs from the magnification: ${x}`);
      if (frames && barPaints / frames > DOCK_BAR_REPAINTS_MAX) v.push(`the playlist bar repainted in ${barPaints} of ${frames} dock frames (≤ ${DOCK_BAR_REPAINTS_MAX} per frame: every z-index write repaints it)`);
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
      return v;
    });

    // ---- the grid's column fit (hooks/useGridFit.ts) ----
    for (const [name, aspect] of [["grid:boot", "1:1"], ["grid:boot:wide", "16:9"]]) await cell(name, async () => {
      const v = [];
      await setSettings({ thumbnailAspect: aspect, cardSize: "Medium", autoPlayVideoThumbs: false, liveWallpaperBehindAllTabs: false });
      await perfSetup();
      await resize(1400, 900);
      const d = dbg(); await d.sendCommand("Page.enable");
      const { identifier } = await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: GRID_REC });
      try {
        await win.loadURL(withToken(U + "/"));
        for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.lib-scroll .card.lib').length`) >= PERF_N) break; await sleep(100); }
        await sleep(1500);
      } finally { await d.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier }); }
      await js(PAGE);
      const f = await js(`window.__gb.stop(); window.__gb.frames`);
      // a count is painted when two frames in a row start with it (one that a frame's ResizeObserver replaced never was)
      const painted = [];
      for (let i = 1; i < f.length; i++) {
        const a = f[i - 1], b = f[i];
        if (a.cards && b.cards && a.el === b.el && a.cols === b.cols && painted.at(-1) !== a.cols) painted.push(a.cols);
      }
      const fin = await js(`document.querySelector(".lib-scroll")?.style.getPropertyValue("--cols") ?? null`);
      console.log(`        ${f.length} frames sampled; column counts painted with cards: ${JSON.stringify(painted.map((c) => c || "(stylesheet default)"))}; final inline --cols ${JSON.stringify(fin)}`);
      if (!painted.length) return ["no frame painted the grid with cards — proved nothing"];
      if (!fin) v.push("the Library's grid has no fitted --cols after boot — the fit never bound");
      if (painted.includes("")) v.push("the grid painted with the stylesheet's default column count before any fit");
      if (painted.length > 1) v.push(`the first painted column count isn't the final one: ${painted.map((c) => c || "default").join(" → ")}`);
      // bound: a resize refits it (sizes whose fits differ: one of them may equal the boot size's, and two shapes of window
      // can fit the same count — 1920×1080 and 800×600 both take 6 widescreen columns — so a wide, short one too)
      const cols = () => js(`document.querySelector(".lib-scroll")?.style.getPropertyValue("--cols") ?? null`);
      await resize(1920, 1080); const wide = await cols();
      await resize(800, 600); const narrow = await cols();
      await resize(2400, 520); const band = await cols();
      console.log(`        after a resize: 1920×1080 → --cols ${JSON.stringify(wide)}, 800×600 → ${JSON.stringify(narrow)}, 2400×520 → ${JSON.stringify(band)}`);
      if (!wide || !narrow || !band || new Set([wide, narrow, band]).size < 2) v.push(`resizing to 1920×1080, 800×600 and 2400×520 left --cols at ${JSON.stringify(wide)} / ${JSON.stringify(narrow)} / ${JSON.stringify(band)} (the fit isn't observing the grid)`);
      await resize(1400, 900);
      await setSettings({ thumbnailAspect: "1:1" });
      return v;
    });
    // A docked item sidebar takes columns, not card size: the card width with it open stays within GRID_TOL of the width
    // without it, and the cards still fill the row (no edge gap wider than the grid's gap). (The Workshop filter column:
    // probe-filters wf:cardSize.)
    if (!ONLY || ONLY.test("grid:panel")) { // a fresh page on the Square settings (the open page doesn't see a /settings POST)
      await win.loadURL(withToken(U + "/"));
      for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.lib-scroll .card.lib').length`) >= 8) break; await sleep(100); }
      await js(PAGE); await sleep(800);
    }
    for (const [w, h] of [[1920, 1080], [1100, 700]]) {
      await cell(`grid:panel:${w}x${h}`, async () => {
        const v = [];
        await resize(w, h); await tab("Library");
        win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 }); await sleep(300);
        const geo = () => page(GRID_GEO(".lib-scroll"));
        const g0 = await geo();
        if (!g0) return ["no Library grid — proved nothing"];
        if (!(await js(`document.querySelector(".lib-scroll").style.getPropertyValue("--cols")`))) return ["the grid has no fitted --cols (see grid:boot) — proved nothing"];
        await page(`const c = document.querySelector(".card.lib .thumb-wrap"); const r = c.getBoundingClientRect();
          c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }));`);
        await sleep(800);
        const g1 = await geo();
        const open = await js(`!!document.querySelector(".side-panel:not(.closing)")`);
        await page(`document.querySelector(".side-panel [data-side-close]")?.click();`); await sleep(700);
        const g2 = await geo();
        const show = (g) => `${g.cols} × ${g.w.toFixed(1)} px (margins ${g.ml}/${g.mr}, edge gaps ${g.lgap.toFixed(1)}/${g.rgap.toFixed(1)})`;
        console.log(`        no panel ${show(g0)}; item sidebar ${show(g1)}; closed again ${show(g2)}`);
        if (!open || !(g1.mr > 0)) return [`the item sidebar didn't dock (open ${open}, grid margin-right ${g1.mr}) — proved nothing`];
        v.push(...gridSame("item sidebar", g0, g1));
        if (g2.cols !== g0.cols || Math.abs(g2.w - g0.w) > 0.5) v.push(`closing the sidebar left ${show(g2)}, not the ${show(g0)} it started at`);
        return v;
      });
    }
    await resize(1400, 900);
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`LAYOUT pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "layout.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
