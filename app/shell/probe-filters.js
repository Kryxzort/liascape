// Filter panel probe — `scripts/test-ui-matrix.sh --probe probe-filters.js` (the matrix's hermetic stack; run it with
// LIASCAPE_MATRIX_SCREEN=2560x1440 so the wide sizes fit the private Xvfb). Wallpaper Engine's filter column with a
// three-way switch per tag and click-to-cycle names (docs/decisions.md § "Filter the Workshop in a column of three-way
// switches"), opened from the top bar's split button and on the right (the same entry, its placement).
// The stack has no network: the page's POST /browse
// and /detail are stubbed (each page-1 /browse body recorded in window.__browse — later pages in __more —, a fixed list of 24 fake Workshop items returned).
//   split:present     the split button `[⚟ N │ sort ▾]` in the top bar: the Library (toggle + its sort), the Workshop (toggle +
//                     its sort menu with the period in it: "Most Popular · Month" POSTs trend / 30, "Most Recent" mostrecent;
//                     no second select), the WE folder (toggle + its client sort); a web source has none; no row above any
//                     grid (no `.wfilter`), the grid starts at the top of its scroll box
//   split:toggle      the toggle: aria-expanded / aria-controls / aria-label ("Filters", "Filters, 2 on"), the count beside the
//                     icon with tags on (gone at 0), lit in the accent while the panel is open and not while closed
//   wf:workshopOnly   the Workshop's column shows on it (none on the web sources — the WE folder's: local:weFolder); docked at 1400 px, right of the
//                     grid (the grid ends at its left edge, no card under it); Features collapsed by default
//   wf:cycle          a click on a tag's NAME toggles include (off → include → off; an excluded tag → off); the POSTed include / exclude follow
//   wf:segments       the switch's segments set include / off / exclude; a radiogroup labelled by the tag, aria-labels
//                     "Include X" / "Off" / "Hide X", one Tab stop (the checked one), arrow keys step it
//   wf:rightClick     a right-click on a row toggles exclude (real input events), no menu
//   wf:post           a mixed set: the POST carries exactly it (include XOR exclude, no old keys), one POST for a burst of
//                     clicks (the 280 ms debounce), the group counts
//   wf:match          Genre's and Features' All / Any switch (only those two): muted with < 2 included, live from 2; the
//                     defaults (genres any, features all), the flip POSTed as genreMatch / featureMatch, kept over a reload;
//                     the radiogroups' aria-labels
//   wf:collapse       a group's head collapses / expands it, remembered over a reload
//   wf:clearAll       Clear all → nothing on, include / exclude [] POSTed, the button disabled
//   wf:library       the "In my library" row: ✓ = only the owned card, ✕ = all but it, no /browse request for it, never POSTed;
//                    no download button on the owned card
//   panel:head        the panel's head: a plain "Filters" title (no button, no pill), Clear all, a close ×; no ghost copy
//                     anywhere (the old fold morph is gone); × closes it
//   panel:right       docked at 1400 px on the right, under the top bar and its button; opened it slides in from the right
//                     (per frame: transform + opacity only, offsets that pass through in-between values and land on 0), closed
//                     it slides out right; the grid's margin-right follows; remembered over a reload; a tab visit doesn't replay
//   panel:persist     each page keeps its own open state over a reload (localStorage libFilterHidden / browseFilterHidden); the
//                     item sidebar's isn't kept
//   swap:browse / swap:library  one right-hand panel at a time: a right-click / an arrow key opens the item sidebar and closes the
//                     filters, the toggle opens the filters and closes the sidebar; each plays its own slide (both animate),
//                     and no frame shows both docked (per frame) or a grid margin wider than the larger of the two
//   split:noWrap:<w>  800 / 960 / 1100 / 1920 px, Library and Workshop: the top bar is one row; the sort shows its label from
//                     1280 px, below it folds to its icon with the label in its tooltip; panel open and closed. Screenshots
//                     wf-split-<page>-<w>-<open|closed>.png
//   search:fold:<w>   800 / 850 / 870 / 1100 px, Library and Workshop: below 860 px the search is a "Search" magnifier button
//                     (components/TopbarSearch.tsx), from 860 px a field ≥ 120 px; the bar one row. Screenshots
//                     wf-search-fold-<page>-<w>.png
//   search:worst:<w>  761–1279 px with Undo (a trashed item) and Stop (a wallpaper playing) beside the rest, the search closed
//                     and opened: one row, nothing out of the window or over another control, a field ≥ 120 px
//   search:open       motion on, 800 px: a click on the magnifier opens it focused — the field's edge and the control left of
//                     it glide (in-between frames), the split right of it never moves, only transforms / opacity / a clip
//                     animate; a blur while empty folds it back the same way. Screenshots wf-search-open-<page>-mid/end.png
//   search:off        motion off: opening, the field fades in and the magnifier it was fades out; folding, the reverse — opacity
//                     only, nothing moves (motion-off.js)
//   search:keep       holding a query it stays open after a blur where the status slot keeps its room, folds lit (accent, dot,
//                     "Search: <query>") where it hasn't; the list stays filtered; widening shows the field with the query
//   search:escape     Escape clears and folds it (the list unfiltered); on the full field it clears it
//   search:look       glow on: the focused field glows; Glow effects off: no glow round it nor on the lit dot; bg-live: its fill
//                     is translucent. Screenshots wf-search-look-glow.png, wf-search-look-noglow-bglive.png
//   wf:drawer         below 900 px (the item sidebar's breakpoint): no docked column, the split's toggle opens it as a drawer over the grid with a scrim
//                     (right edge, inside the window, above the item sidebar); a switch works in it; Escape / the scrim close it
//   wf:size:<w>x<h>   the nine layout sizes: docked iff ≥ 900 px, the grid keeps ≥ 240 px (also with the item sidebar open,
//                     which closes the panel), cards inside it, no sideways scroll; narrow: the drawer fits the window
//   wf:noMotion       "Smooth window animations" off → the drawer, its scrim and the docked panel fade in and out in place
//                     (opacity only, per frame: in-between frames, the boxes still); on → they slide (transform + opacity only)
//   wf:noGlow         Glow effects off → an included segment and the lit toggle have no glow
//   wf:liveBg         live wallpaper behind the tabs → the docked column has no fill, its groups carry the darkness; the drawer
//                     keeps a fill
//   wf:cardSize:<w>x<h> 1920×1080 / 1100×700: the docked panel — and the item sidebar in its place — changes the column
//                     count, not the card size (within 5 % of the no-panel one, or the closest column count's where none
//                     is), no edge gap wider than the grid's gap
// The local filters — the Library's and the local Wallpaper Engine folder's, filtered in the page from each item's tags (the stack's
// scenes s1-s3 get project.json tags / age ratings; a fake WE folder of four videos):
//   lib:column        the Library's column docks at 1400 px right of its grid, above the playlist bar (full width); it offers only
//                     what the items know: Age / Type / Resolution / Genre / Features (no "In my library"), Everyone + Mature,
//                     Standard Definition (k1-k4's 320×180 files, read by the backend), Anime + Nature; no row above the grid
//   lib:filter        include / exclude / age (untagged out under any age filter) / genre any → all / features all, from the
//                     page: the cards follow, no /browse request; nothing left → "No wallpapers match" + Clear filters
//   lib:scope         the Library's filter and the Workshop's never mix (each column, the POST, localStorage); both kept over a reload
//   lib:interplay     Ctrl+A / the arrows reach only shown cards; a filter change drops hidden cards from the selection and
//                     starts the grid at its top; a tab visit keeps the view; the playlist bar is untouched; over 300+ cards a
//                     filter change re-renders the Library and its column, never the cards that stay (React's commit hook)
//   lib:fold          the Library's toggle closes its own panel (Browse's stays), the grid doesn't move down; remembered;
//                     motion off → it fades in place (opacity only)
//   lib:drawer        below 900 px the Library's toggle opens its drawer; a switch works in it; Escape closes; a tab visit closes it
//   local:weFolder    Browse's "Wallpaper Engine (Local)": the column with what the folder's items know, filtered in the page
//                     (no filter POSTed), "In my library" too, its own saved filter; its client sort in the split, no Workshop sort
//   lib:steamTags     an item auto-imported from a Wallpaper Engine folder (its project.json: a genre, no resolution, no age)
//                     gets Steam's tags from the backend's one look-up (the stack's fake Steam servers, LIASCAPE_STEAM_CM_FIXTURE —
//                     asked for its id alone): the Library's column grows its rows (3840 x 2160, Questionable) and they filter it
//   wf:emblem         each group's head carries one emblem chip (.wf-gico) with its own glyph (Library / Shield / Layers / Monitor
//                     / Palette / Sparkles), no tag row any icon but its switch's; Fit: the head's height, the column's width and
//                     the button's rhythm unchanged by it (same with the chips hidden; chevron → chip → name gaps equal, all on
//                     one centre line); its glow on; hovering the group tilts the chip on the spring (per frame: in-between
//                     frames, past its held tilt), its glyph neither tilts nor acts on its own (Features' sparkles too).
//                     Screenshots wf-emblem.png, wf-emblem-tilt-<i>.png
//   wf:emblem:look    Glow effects off: no glow round a chip at rest or hovered; bg-live: the chips drawn over the groups'
//                     darkness; motion off: hovering a group leaves its chip still (motion-off.js). Screenshots
//                     wf-emblem-noglow.png, wf-emblem-bglive.png
//   wf:emblem:centre  at 1400×900 and 1920×1080: every chip and glyph whole pixels with even margins, and the glyph on its chip's
//                     centre as drawn (pixel-centre.js: ±0.5 css px at a whole device pixel ratio, one device pixel at a
//                     fractional one — the matrix's). Close-ups wf-emblem-px-<group>-<w>.png
// Screenshots: <LIASCAPE_OUT>/wf-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const MO = require("./motion-off"); // motion off: only opacity changes, nothing moves, appear / leave fade
const PXC = require("./pixel-centre"); // a chip's glyph centred as drawn, in pixels
const NF = "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));"; // in-page: two frames pass
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);
async function setSettings(patch) { const s0 = (await http("GET", "/settings")).json; await post("/settings", { ...s0, ...patch }); }

// fake Workshop thumbnails (served by /media): a few colours — in the stack's private cache dir, since /media serves only
// where the app keeps wallpapers (its data dir, its caches, the Workshop folder; .claude/rules/backend/api.md § Security)
const THUMBS = [];
function makeThumbs() {
  const d = path.join(E.XDG_CACHE_HOME || path.join(OUT, ".cache"), "liascape", "wf-thumbs"); fs.mkdirSync(d, { recursive: true });
  const cols = ["0x4c4f9a", "0x1f6f8b", "0x8b3a62", "0x2e7d4f", "0x9a6b2f", "0x5a2e8b"];
  cols.forEach((c, i) => {
    const f = path.join(d, `t${i}.jpg`);
    require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `gradients=size=480x270:c0=${c}:c1=0x101018:seed=${i + 1}`,
      "-frames:v", "1", f], { timeout: 30000 });
    THUMBS.push(f);
  });
}

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__wf = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; },
  // the first match that shows: the Library page stays in the document, hidden, once shown (App.tsx <Activity>) — with its
  // own filter column, pill and grid
  q(sel) { return [...document.querySelectorAll(sel)].find((e) => e.checkVisibility()) ?? null; },
  qa(sel) { return [...document.querySelectorAll(sel)].filter((e) => e.checkVisibility()); },
  col() { return this.q(".wf-col:not(.closing)"); },
  // the top bar's split button (one: the shown page's) and its filter toggle
  split() { return this.q("[data-sortsplit]"); },
  tog() { return this.q("[data-sortsplit] [data-wf-toggle]"); },
  isOpen() { return this.tog()?.getAttribute("aria-expanded") === "true"; },
  // the panel open (want) or closed through the toggle; false = no toggle
  async open(want = true) { const t = this.tog(); if (!t) return false; if (this.isOpen() !== want) { t.click(); await this.sleep(450); } return true; },
  // docked widths: the panel open (a cell before may have closed it — an item sidebar does)
  async ensure() { if (innerWidth >= 900) await this.open(true); },
  accent() { const e = document.createElement("i"); e.style.background = "var(--accent)"; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; },
  // a sort menu's options (opens and closes the split's select)
  async sortOpts() { const b = this.q("[data-sortsplit] .ss-sort"); if (!b) return null; b.click(); await this.sleep(150);
    const o = [...document.querySelectorAll(".sel-pop .sel-opt")].map((x) => x.textContent.trim()); document.querySelector(".sel-backdrop")?.click(); await this.sleep(100); return o; },
  async pickSort(label) { this.q("[data-sortsplit] .ss-sort").click(); await this.sleep(150); this.byText(".sel-pop .sel-opt", label)?.click(); await this.sleep(150); },
  row(tag) { return [...(this.col()?.querySelectorAll(".wf-row") ?? [])].find((r) => r.dataset.wfTag === tag); },
  st(tag) { return this.row(tag)?.dataset.state ?? null; },
  seg(tag, s) { return this.row(tag)?.querySelector('[data-seg="' + s + '"]'); },
  head(id) { return this.col()?.querySelector('[data-wf-head="' + id + '"]') ?? null; },
  grp(id) { return this.col()?.querySelector('[data-wf-group="' + id + '"]') ?? null; },
  last() { return window.__browse[window.__browse.length - 1] ?? null; },
  async settle(n0, ms = 1500) { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (window.__browse.length > n0) break; await this.sleep(30); }
    await this.sleep(380); return window.__browse.length > n0 ? this.last() : null; },
  // Browse's cards (the Library's grid stays in the document, hidden, once shown: App.tsx)
  cards() { return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length; },
}; true`;
const page = (code) => js(`(async () => { const m = window.__wf; ${code} })()`);

const SIZES = [[480, 720], [560, 430], [640, 480], [800, 600], [1100, 700], [1400, 900], [1920, 1080], [2400, 520], [1600, 400]];
let wsName = null, weName = null;

async function loadUi(lsInit) {
  await win.loadURL(withToken(U + "/"));
  // the stub goes in before the store's first reload can reach a Workshop source: a pre-load localStorage tweak (lsInit) needs a
  // second load, so the page reloads once with the stub's own script re-applied
  const stub = `(() => { window.__browse = []; window.__more = []; const items = ${J(Array.from({ length: 24 }, (_, i) => ({
    title: `ws-${i + 1}`, thumbnailUrl: "__T" + (i % 6), animatedThumbnailUrl: null, pageUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${910000 + i}`,
    resolution: "1920 x 1080", isScene: i % 3 === 0, workshopId: String(910000 + i), addedAt: null, description: "fake", authorName: "probe",
    fileSizeBytes: 1000, subscriptions: 10 * i, favorites: i, views: 100 * i, tags: ["Anime"] })).map((w, i) => i === 23
      ? { ...w, workshopId: "900000001" } /* = the stack's scene s1's Workshop id: "in library" (wf:library) */ : w))}.map((w) => ({ ...w, thumbnailUrl: ${J(THUMBS)}[+w.thumbnailUrl.slice(3)] }));
    const f = window.fetch; window.fetch = (u, o) => { const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
      const ok = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (p === "/browse" && (o?.method || "GET") === "POST") { const b = JSON.parse(o.body); if (b.filter) { (b.page > 1 ? window.__more : window.__browse).push(b); return ok(b.page > 1 ? [] : items); } }
      if (p === "/detail" && (o?.method || "GET") === "POST") { const b = JSON.parse(o.body); if (String(b.result?.pageUrl).includes("steamcommunity")) return ok({ title: b.result.title, previewUrl: b.result.thumbnailUrl, downloadUrl: "", needsReferrer: false }); }
      return f(u, o); }; })(); true`;
  if (lsInit) { await js(lsInit); await win.loadURL(withToken(U + "/")); }
  await js(stub);
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
  await js(PAGE); await sleep(400);
}
async function tab(name) { await page(`m.byText(".tab", ${J(name)}).click();`); await sleep(600); }
async function source(name) {
  await page(`m.byText(".pill", ${J(name)})?.click();`);
  for (let i = 0; i < 60; i++) { if (await page(`return m.cards() > 0 || !${J(name)}.includes("Workshop");`)) break; await sleep(100); }
  await sleep(300);
}
async function toWorkshop(open = true) { await tab("Browse"); await source(wsName); if (open) await page(`await m.ensure();`); }
async function shot(name) { const img = await win.webContents.capturePage(); const f = path.join(OUT, `wf-${name}.png`); fs.writeFileSync(f, img.toPNG()); return f; }
async function resize(w, h) {
  win.setContentSize(w, h);
  for (let i = 0; i < 30; i++) { const [cw, ch] = await js(`[innerWidth, innerHeight]`); if (cw === w && ch === h) break; await sleep(50); }
  await sleep(400);
}
async function setMotion(on) {
  await tab("Settings");
  await page(`const row = [...m.qa(".srow")].find((r) => r.querySelector(".slabel")?.textContent.includes("Smooth window animations"));
    if (!row) throw new Error("no Smooth window animations row");
    const cb = row.querySelector("input[type=checkbox]"); if (cb.checked !== ${on}) cb.click(); await m.sleep(500);`);
  await toWorkshop();
}
const send = (e) => win.webContents.sendInputEvent(e);
async function rightAt(x, y) {
  send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); await sleep(30);
  send({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "right", clickCount: 1 }); await sleep(40);
  send({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "right", clickCount: 1 });
}
// React's DevTools hook (as probe-layout's): production react-dom reports every commit; a component whose fiber did work ran
const RC_HOOK = `(() => {
  const C = new Set([0, 1, 11, 14, 15]); const cur = new WeakSet(); window.__rc = { rendered: 0, mounted: 0, unmounted: 0 }; window.__rcWho = {};
  const who = (f) => { let h = f.child; while (h && typeof h.type !== "string") h = h.child;
    const k = h ? h.type + "." + String(h.memoizedProps?.className ?? "").split(" ")[0] : "?"; window.__rcWho[k] = (window.__rcWho[k] ?? 0) + 1; };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; },
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
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

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
    makeThumbs();
    await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false });
    const srcs = (await http("GET", "/sources")).json;
    wsName = srcs.find((s) => s.supportsTagFilter)?.name;
    weName = srcs.find((s) => s.index === 3)?.name;
    if (!wsName) throw new Error("no Workshop source (supportsTagFilter) in /sources");
    // start from nothing saved (the probe's own Electron profile, but a rerun keeps it)
    await loadUi(`for (const k of ["browseFilter", "browseFilterCollapsed", "browseFilterHidden", "libFilter", "libFilterHidden", "weLocalFilter"]) localStorage.removeItem("liascape." + k); true`);

    await cell("wf:workshopOnly", async () => {
      const v = [];
      await tab("Browse");
      // the local Wallpaper Engine folder has its own column (local:weFolder)
      for (const n of srcs.filter((s) => s.available && !s.supportsTagFilter && !s.supportsLocalFilter).map((s) => s.name)) {
        await source(n);
        if (await page(`return !!m.q(".wf-col, [data-sortsplit]");`)) v.push(`the filter column / split button shows for ${n}`);
      }
      await source(wsName);
      const r = await page(`const c = m.col(); if (!c) return null; const sc = m.q(".scroll");
        const cards = [...sc.querySelectorAll(".card")].slice(0, 30).map((x) => x.getBoundingClientRect()).filter((b) => b.width);
        return { mode: c.dataset.mode, c: m.rect(c), s: m.rect(sc), W: innerWidth, under: cards.filter((b) => b.right > m.rect(c).x + 1).length,
          groups: [...c.querySelectorAll("[data-wf-group]")].map((g) => g.dataset.wfGroup),
          featRows: m.grp("features")?.querySelectorAll(".wf-row").length ?? -1, genreRows: m.grp("genre")?.querySelectorAll(".wf-row").length ?? -1,
          subs: [...(m.grp("resolution")?.querySelectorAll(".wf-sub") ?? [])].map((x) => x.textContent), row: !!m.q(".wfilter"),
          cards: m.cards(), title: document.title };`);
      if (!r) return [...v, "no filter column on the Workshop source"];
      console.log(`        ${J({ mode: r.mode, c: r.c, sRight: r.s.r, groups: r.groups, subs: r.subs, cards: r.cards })}`);
      if (r.mode !== "dock") v.push(`at 1400 px the column is "${r.mode}", not docked`);
      const sideW = Math.min(400, Math.max(300, 0.26 * r.W)); // the item sidebar's width (index.css --side-w)
      if (Math.abs(r.c.r - r.W) > 0.5 || Math.abs(r.c.w - sideW) > 1) v.push(`the column spans ${r.c.x}–${r.c.r}, ${r.c.w} px wide (want the item sidebar's ${sideW} at the right edge of ${r.W})`);
      if (r.s.r > r.c.x + 1) v.push(`the grid ends at ${r.s.r}, under the column (its left edge ${r.c.x})`);
      if (r.under) v.push(`${r.under} cards under the column`);
      if (J(r.groups) !== J(["library", "age", "type", "resolution", "genre", "features"])) v.push(`groups ${J(r.groups)}`);
      if (r.featRows !== 0) v.push(`Features isn't collapsed by default (${r.featRows} rows)`);
      if (r.genreRows < 20) v.push(`${r.genreRows} genre rows`);
      if (J(r.subs) !== J(["Standard", "Ultrawide", "Dual", "Triple", "Portrait", "Other"])) v.push(`resolution sub-headings ${J(r.subs)}`);
      if (r.row) v.push("a sort / filter row above the grid (.wfilter)");
      if (!r.cards) v.push("no cards (the /browse stub didn't serve the list)");
      if (await page(`return !!m.q(".wf-col [title]");`)) v.push("a tooltip in the column");
      await shot("wide");
      return v;
    });

    await cell("wf:cycle", async () => {
      const v = [];
      // off → ✓ → off by name clicks; then ✕ by its segment and a name click on the hidden tag → off (never straight to ✓)
      const exp = [["inc", ["Anime"], [], "name"], ["off", [], [], "name"], ["exc", [], ["Anime"], "seg"], ["off", [], [], "name"]];
      for (const [st, inc, exc, how] of exp) {
        const n0 = await page(`return window.__browse.length;`);
        await page(how === "seg" ? `m.seg("Anime", "exc").click();` : `m.row("Anime").querySelector(".wf-name").click();`);
        const b = await page(`return await m.settle(${n0});`);
        const got = await page(`return m.st("Anime");`);
        if (got !== st) v.push(`after a ${how} click Anime is "${got}", expected "${st}"`);
        if (!b) { v.push(`no POST after the click to ${st}`); continue; }
        if (!sameSet(b.filter.include, inc) || !sameSet(b.filter.exclude, exc)) v.push(`${st}: POSTed include ${J(b.filter.include)} exclude ${J(b.filter.exclude)}`);
        if (st === "exc") {
          const look = await page(`const n = m.row("Anime").querySelector(".wf-name"); const cs = getComputedStyle(n); return { td: cs.textDecorationLine, c: cs.color,
            d: (() => { const e = document.createElement("i"); e.style.color = "var(--danger)"; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })() };`);
          if (!/line-through/.test(look.td) || look.c !== look.d) v.push(`excluded name: decoration ${look.td}, colour ${look.c} (danger ${look.d})`);
        }
      }
      return v;
    });

    await cell("wf:segments", async () => {
      const v = [];
      const a = await page(`const r = m.row("Landscape"); const g = r.querySelector("[role=radiogroup]"); const lab = document.getElementById(g.getAttribute("aria-labelledby"))?.textContent;
        return { lab, radios: [...g.querySelectorAll("[role=radio]")].map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-checked"), b.tabIndex]) };`);
      if (a.lab !== "Landscape") v.push(`the radiogroup is labelled "${a.lab}"`);
      if (J(a.radios.map((x) => x[0])) !== J(["Include Landscape", "Off", "Hide Landscape"])) v.push(`aria-labels ${J(a.radios.map((x) => x[0]))}`);
      if (J(a.radios.map((x) => x[1])) !== J(["false", "true", "false"]) || J(a.radios.map((x) => x[2])) !== J([-1, 0, -1])) v.push(`off: checked / tabIndex ${J(a.radios)}`);
      for (const [s, want] of [["inc", "inc"], ["exc", "exc"], ["off", "off"], ["exc", "exc"]]) {
        const n0 = await page(`return window.__browse.length;`);
        await page(`m.seg("Landscape", ${J(s)}).click();`);
        const b = await page(`return await m.settle(${n0});`);
        const r = await page(`return { st: m.st("Landscape"), chk: m.row("Landscape").querySelector('[aria-checked="true"]')?.dataset.seg };`);
        if (r.st !== want || r.chk !== want) v.push(`segment ${s} → state ${r.st}, checked ${r.chk}`);
        const inc = b?.filter.include.includes("Landscape"), exc = b?.filter.exclude.includes("Landscape");
        if (!b || inc !== (want === "inc") || exc !== (want === "exc")) v.push(`segment ${s}: POST ${b ? J(b.filter) : "none"}`);
      }
      // the keyboard: the checked segment (✕) focused, → wraps to ✓, ← back to ✕, ← to ·
      const k = await page(`const g = m.row("Landscape").querySelector("[role=radiogroup]"); g.querySelector('[aria-checked="true"]').focus();
        const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
        const out = []; for (const k of ["ArrowRight", "ArrowLeft", "ArrowLeft"]) { key(k); await m.sleep(60); out.push([m.st("Landscape"), document.activeElement?.dataset.seg]); } return out;`);
      if (J(k) !== J([["inc", "inc"], ["exc", "exc"], ["off", "off"]])) v.push(`arrow keys: ${J(k)} (expected inc, exc, off with the focus following)`);
      await page(`document.activeElement?.blur();`);
      return v;
    });

    await cell("wf:rightClick", async () => {
      const v = [];
      const r = await page(`const n = m.row("Nature").querySelector(".wf-name"); n.scrollIntoView({ block: "center" }); await m.sleep(250); return m.rect(n);`);
      const n0 = await page(`return window.__browse.length;`);
      await rightAt(r.x + 10, r.y + r.h / 2); await sleep(150);
      let b = await page(`return await m.settle(${n0});`);
      if ((await page(`return m.st("Nature");`)) !== "exc") v.push(`a right-click left Nature "${await page(`return m.st("Nature");`)}"`);
      if (!b?.filter.exclude.includes("Nature")) v.push(`the POST after a right-click: ${J(b?.filter)}`);
      if (await page(`return !!m.q(".ctx-menu, .lib-ctx, .pl-ctx");`)) v.push("a context menu opened");
      const n1 = await page(`return window.__browse.length;`);
      await rightAt(r.x + 10, r.y + r.h / 2); await sleep(150);
      b = await page(`return await m.settle(${n1});`);
      if ((await page(`return m.st("Nature");`)) !== "off") v.push("a second right-click didn't turn Nature off");
      if (b?.filter.exclude.includes("Nature")) v.push("Nature still excluded in the POST");
      // from include, a right-click excludes it
      await page(`m.seg("Nature", "inc").click(); await m.sleep(100);`);
      await rightAt(r.x + 10, r.y + r.h / 2); await sleep(150);
      if ((await page(`return m.st("Nature");`)) !== "exc") v.push("a right-click on an included tag didn't exclude it");
      await page(`m.seg("Nature", "off").click();`); await sleep(500);
      return v;
    });

    await cell("wf:post", async () => {
      const v = [];
      await page(`m.head("features").click(); await m.sleep(200);`); // open Features (collapsed by default)
      const n0 = await page(`return window.__browse.length;`);
      // a burst: six changes in < 100 ms → one POST
      await page(`m.seg("Everyone", "inc").click(); m.seg("Mature", "exc").click(); m.seg("Video", "inc").click();
        m.seg("Ultrawide 3440 x 1440", "inc").click(); m.seg("3D", "inc").click(); m.seg("Memes", "exc").click();`);
      const b = await page(`return await m.settle(${n0});`);
      const posts = (await page(`return window.__browse.length;`)) - n0;
      if (posts !== 1) v.push(`${posts} POSTs for a burst of six clicks (debounced: 1)`);
      if (!b) return [...v, "no POST"];
      const f = b.filter;
      console.log(`        POST ${J(f)}`);
      if (!sameSet(f.include, ["Everyone", "Video", "Ultrawide 3440 x 1440", "3D"])) v.push(`include ${J(f.include)}`);
      if (!sameSet(f.exclude, ["Mature", "Memes"])) v.push(`exclude ${J(f.exclude)}`);
      if (f.include.some((t) => f.exclude.includes(t))) v.push("a tag in both include and exclude");
      for (const k of ["type", "ageRating", "resolution", "genres", "features"]) if (k in f) v.push(`the POST still carries "${k}"`);
      if (typeof f.sort !== "string" || typeof f.trendDays !== "number") v.push(`sort / trendDays ${f.sort} / ${f.trendDays}`);
      const counts = await page(`return Object.fromEntries([...m.qa(".wf-col [data-wf-group]")].map((g) => [g.dataset.wfGroup, g.querySelector("[data-wf-count]")?.textContent ?? "0"]));`);
      if (J(counts) !== J({ library: "0", age: "2", type: "1", resolution: "1", genre: "1", features: "1" })) v.push(`group counts ${J(counts)}`);
      // include → exclude on the same tag moves it (XOR)
      const n1 = await page(`return window.__browse.length;`);
      await page(`m.seg("Video", "exc").click();`);
      const b2 = await page(`return await m.settle(${n1});`);
      if (!b2 || b2.filter.include.includes("Video") || !b2.filter.exclude.includes("Video")) v.push(`Video include → exclude: ${J(b2?.filter)}`);
      await page(`m.seg("Video", "inc").click();`); await sleep(500);
      await shot("wide-active");
      return v;
    });

    // Genre + Features: the same All / Any switch (featureMatch default all; genreMatch default any — docs/decisions.md §
    // "AND Workshop features, OR genres, each switchable")
    await cell("wf:match", async () => {
      const v = [];
      const sw = (g) => page(`const g = m.grp(${J(g)}).querySelector(".wf-fm"); return g ? { idle: g.classList.contains("idle"), val: g.dataset.wfMatch,
        labels: [...g.querySelectorAll("[role=radio]")].map((b) => b.getAttribute("aria-label")), role: g.getAttribute("role"),
        inHead: !!g.closest(".wf-head"), aria: m.grp(${J(g)}).getAttribute("aria-label") } : null;`);
      const others = await page(`return ["age", "type", "resolution"].filter((g) => m.grp(g).querySelector(".wf-fm"));`);
      if (others.length) v.push(`an All / Any switch in ${others.join(", ")} (Genre and Features only)`);
      const cases = [
        { g: "features", key: "featureMatch", def: "all", flip: "any", one: "feature", plural: "features", add: ["HDR"], had: ["3D"] },
        { g: "genre", key: "genreMatch", def: "any", flip: "all", one: "genre", plural: "genres", add: ["Anime", "Nature"], had: [] },
      ];
      for (const c of cases) {
        let a = await sw(c.g);
        if (!a) { v.push(`no All / Any switch in the ${c.g} head`); continue; }
        if (a.role !== "radiogroup" || !a.inHead) v.push(`${c.g}: role ${a.role}, in the head ${a.inHead}`);
        if (J(a.labels) !== J([`Must have all ticked ${c.plural}`, `Any ticked ${c.one}`])) v.push(`${c.g}: aria-labels ${J(a.labels)}`);
        if (!a.idle) v.push(`${c.g}: with ${c.had.length} included the switch isn't muted`);
        if (a.val !== c.def) v.push(`${c.g}: default ${a.val} (expected ${c.def})`);
        if (!a.aria.includes(c.def === "all" ? "all of" : "any of")) v.push(`${c.g}: the group reads "${a.aria}" under ${c.def}`);
        for (const t of c.add) await page(`m.seg(${J(t)}, "inc").click();`);
        await sleep(100);
        a = await sw(c.g);
        if (a.idle) v.push(`${c.g}: with two included the switch is still muted`);
        const n0 = await page(`return window.__browse.length;`);
        await page(`m.grp(${J(c.g)}).querySelector('[data-fm="${c.flip}"]').click();`);
        const b = await page(`return await m.settle(${n0});`);
        if (b?.filter[c.key] !== c.flip) v.push(`${c.g}: POSTed ${c.key} ${b?.filter[c.key]} (expected ${c.flip})`);
        const other = c.key === "featureMatch" ? "genreMatch" : "featureMatch";
        if (!b || !["all", "any"].includes(b.filter[other])) v.push(`${c.g}: the POST's ${other} is ${b?.filter[other]}`);
        a = await sw(c.g);
        if (!a.aria.includes(c.flip === "all" ? "all of" : "any of")) v.push(`${c.g}: the group reads "${a.aria}" under ${c.flip}`);
      }
      // both kept over a reload (the saved filter)
      await loadUi(); await toWorkshop();
      const f = await sw("features"), g = await sw("genre");
      if (f?.val !== "any" || g?.val !== "all") v.push(`after a reload featureMatch ${f?.val}, genreMatch ${g?.val}`);
      const b2 = await page(`return m.last();`);
      if (b2?.filter.featureMatch !== "any" || b2?.filter.genreMatch !== "all"
        || !sameSet(b2.filter.include, ["Everyone", "Video", "Ultrawide 3440 x 1440", "3D", "HDR", "Anime", "Nature"])) v.push(`the first POST after the reload: ${J(b2?.filter)}`);
      // back: Anime / Nature off, both defaults
      await page(`m.seg("Anime", "off").click(); m.seg("Nature", "off").click(); m.grp("features").querySelector('[data-fm="all"]').click();
        m.grp("genre").querySelector('[data-fm="any"]').click(); await m.sleep(500);`);
      return v;
    });

    await cell("wf:collapse", async () => {
      const v = [];
      const rows = (id) => page(`return m.grp(${J(id)})?.querySelectorAll(".wf-row").length ?? -1;`);
      if ((await rows("features")) === 0) v.push("Features' expanded state (opened in wf:post) wasn't remembered over the reload");
      await page(`m.head("genre").click(); await m.sleep(150);`);
      const r = await page(`return { rows: m.grp("genre").querySelectorAll(".wf-row").length, exp: m.head("genre").getAttribute("aria-expanded"), n: m.grp("genre").querySelector("[data-wf-count]")?.textContent };`);
      if (r.rows !== 0 || r.exp !== "false") v.push(`collapsed Genre: ${r.rows} rows, aria-expanded ${r.exp}`);
      if (r.n !== "1") v.push(`collapsed Genre's count shows ${r.n} (Memes is excluded)`);
      await loadUi(); await toWorkshop();
      if ((await rows("genre")) !== 0) v.push("Genre's collapse wasn't remembered over a reload");
      await page(`m.head("genre").click(); await m.sleep(150);`);
      if ((await rows("genre")) < 20) v.push("Genre didn't expand again");
      return v;
    });

    await cell("wf:clearAll", async () => {
      const v = [];
      const n0 = await page(`return window.__browse.length;`);
      await page(`m.q("[data-wf-clear]").click();`);
      const b = await page(`return await m.settle(${n0});`);
      const r = await page(`return { on: m.qa('.wf-col .wf-row:not([data-state="off"])').length, dis: m.q("[data-wf-clear]").disabled,
        counts: m.qa(".wf-col [data-wf-count]").length };`);
      if (r.on) v.push(`${r.on} rows still on`);
      if (!r.dis) v.push("Clear all still enabled with nothing on");
      if (r.counts) v.push(`${r.counts} group counts left`);
      if (!b || b.filter.include.length || b.filter.exclude.length) v.push(`the POST after Clear all: ${J(b?.filter)}`);
      return v;
    });
    await cell("wf:library", async () => {
      // "In my library" (show only / hide what the library already has) + no download button on an owned card
      const v = [];
      const r0 = await page(`return { cards: m.cards(), owned: m.qa(".card [data-in-library]").length,
        dlOnOwned: [...m.qa(".card")].filter((c) => c.querySelector("[data-in-library]") && c.querySelector(".dl-btn")).length,
        dl: m.qa(".card .dl-btn").length, row: !!m.q('[data-wf-tag="@library"]') };`);
      if (!r0.row) v.push("no In my library row");
      if (r0.owned !== 1) v.push(`${r0.owned} cards marked In library (want 1)`);
      if (r0.dlOnOwned) v.push("the owned card still has a download button");
      if (r0.dl !== r0.cards - r0.owned) v.push(`${r0.dl} download buttons for ${r0.cards - r0.owned} cards not in the library`);
      const n0 = await page(`return window.__browse.length;`);
      const name = `m.q('[data-wf-tag="@library"] .wf-name').click(); await m.sleep(450);`;
      await page(name); // · → ✓ (the name toggles include)
      const only = await page(`return { cards: m.cards(), owned: m.qa(".card [data-in-library]").length };`);
      if (only.cards !== 1 || only.owned !== 1) v.push(`✓ In my library: ${only.cards} cards, ${only.owned} owned (want 1 / 1)`);
      await page(`m.seg("@library", "exc").click(); await m.sleep(450);`); // ✕ via its segment
      const hide = await page(`return { cards: m.cards(), owned: m.qa(".card [data-in-library]").length, st: m.st("@library") };`);
      if (hide.st !== "exc") v.push(`the row is ${hide.st} after its ✕ segment`);
      if (hide.owned || hide.cards !== r0.cards - 1) v.push(`✕ In my library: ${hide.cards} cards, ${hide.owned} owned (want ${r0.cards - 1} / 0)`);
      await page(name); // ✕ → off
      if (await page(`return m.st("@library");`) !== "off") v.push("a name click on the hidden row didn't turn it off");
      await page(`m.seg("@library", "exc").click(); await m.sleep(450);`);
      await page(`await m.sleep(400);`);
      const n1 = await page(`return window.__browse.length;`);
      if (n1 !== n0) v.push(`${n1 - n0} /browse request(s) for the library row (want none: it filters what's loaded)`);
      await page(`m.seg("Anime", "inc").click();`);
      const b = await page(`return await m.settle(${n1});`);
      if (!b) v.push("no request after including Anime");
      else if ([...b.filter.include, ...b.filter.exclude].some((t) => t.startsWith("@"))) v.push(`the pseudo-tag went to the backend: ${J(b.filter)}`);
      await page(`m.q("[data-wf-clear]").click(); await m.sleep(500);`);
      if (await page(`return m.cards();`) !== r0.cards) v.push("Clear all didn't bring the owned card back");
      return v;
    });

    // ---- the split button and the panel on the right ----
    await cell("split:present", async () => {
      const v = [];
      const look = () => page(`const s = m.split(); if (!s) return null; const sc = m.q(".scroll"), g = sc.querySelector(".grid");
        return { tog: !!s.querySelector("[data-wf-toggle]"), sort: s.querySelector(".ss-sort .sel-val")?.textContent ?? null, inTop: !!s.closest(".topbar"),
          sels: m.qa(".topbar .sel").length, row: !!m.q(".wfilter"), rowSels: sc.querySelectorAll(".sel").length,
          gridTop: g.getBoundingClientRect().top - sc.getBoundingClientRect().top - parseFloat(getComputedStyle(sc).paddingTop) };`);
      const plain = (who, r, sort) => {
        if (!r) { v.push(`${who}: no split button in the top bar`); return; }
        if (!r.inTop) v.push(`${who}: the split button isn't in the top bar`);
        if (!r.tog) v.push(`${who}: no filter toggle in the split button`);
        if (sort && !r.sort) v.push(`${who}: no sort half`);
        if (r.sels !== 1) v.push(`${who}: ${r.sels} selects in the top bar (want the split's sort only)`);
        if (r.row || r.rowSels) v.push(`${who}: a sort / filter row above the grid (${r.rowSels} selects in it)`);
        if (r.gridTop > 1) v.push(`${who}: the grid starts ${r.gridTop.toFixed(0)} px below its scroll box's top (want the top)`);
      };
      await tab("Library");
      plain("Library", await look(), true);
      const lo = await page(`return await m.sortOpts();`);
      if (J(lo) !== J(["Name A–Z", "Name Z–A", "Videos first", "Scenes first", "Newest", "Oldest"])) v.push(`Library sort menu ${J(lo)}`);
      await toWorkshop();
      plain("Workshop", await look(), true);
      const wo = await page(`return await m.sortOpts();`);
      const want = ["Today", "Week", "Month", "3 Months", "6 Months", "Year"].map((p) => `Most Popular · ${p}`).concat(["Most Recent", "Recently Updated", "Most Subscribed", "Top Rated"]);
      if (J(wo) !== J(want)) v.push(`Workshop sort menu ${J(wo)} (want the period inside it: ${J(want)})`);
      else {
        for (const [label, sort, days] of [["Most Popular · Month", "trend", 30], ["Most Recent", "mostrecent", null], ["Most Popular · Week", "trend", 7]]) {
          const n0 = await page(`return window.__browse.length;`);
          await page(`await m.pickSort(${J(label)});`);
          const b = await page(`return await m.settle(${n0});`);
          const r = await look();
          if (!b || b.filter.sort !== sort || (days != null && b.filter.trendDays !== days)) v.push(`"${label}" POSTed ${J(b && { sort: b.filter.sort, trendDays: b.filter.trendDays })}`);
          if (r?.sort !== label) v.push(`after picking "${label}" the sort reads "${r?.sort}"`);
          if (r?.sels !== 1) v.push(`"${label}": ${r?.sels} selects in the top bar (the period is in the one menu)`);
        }
      }
      await shot("split-workshop");
      return v;
    });

    await cell("split:toggle", async () => {
      const v = [];
      await toWorkshop();
      const st = () => page(`const t = m.tog(); if (!t) return null; const c = t.querySelector("[data-wf-count]"), i = t.querySelector("svg");
        return { exp: t.getAttribute("aria-expanded"), ctl: !!document.getElementById(t.getAttribute("aria-controls") ?? "-"), label: t.getAttribute("aria-label"),
          lit: getComputedStyle(t).backgroundColor === m.accent(), n: c?.textContent ?? null, beside: c && i ? c.getBoundingClientRect().left >= i.getBoundingClientRect().right - 1 : null,
          col: !!m.col() };`);
      let r = await st();
      if (!r) return ["no filter toggle in the top bar"];
      if (r.exp !== "true" || !r.col) v.push(`open: aria-expanded ${r.exp}, panel ${r.col}`);
      if (!r.ctl) v.push("open: aria-controls doesn't name the panel");
      if (r.label !== "Filters") v.push(`aria-label "${r.label}" with nothing on`);
      if (!r.lit) v.push("open: the toggle isn't lit in the accent");
      if (r.n !== null) v.push(`a count "${r.n}" with nothing on`);
      await page(`m.seg("Anime", "inc").click(); m.seg("Mature", "exc").click(); await m.sleep(450);`);
      r = await st();
      if (r.n !== "2" || !r.beside) v.push(`two tags on: count ${r.n}, beside the icon ${r.beside}`);
      if (r.label !== "Filters, 2 on") v.push(`aria-label "${r.label}" with two on`);
      await page(`await m.open(false);`);
      r = await st();
      if (r.exp !== "false" || r.col) v.push(`closed: aria-expanded ${r.exp}, panel ${r.col}`);
      if (r.lit) v.push("closed: the toggle is still lit");
      if (r.n !== "2") v.push(`closed: the count reads ${r.n} (want 2)`);
      await shot("split-toggle-closed");
      await page(`await m.open(true); m.q("[data-wf-clear]").click(); await m.sleep(500);`);
      r = await st();
      if (r.n !== null || r.label !== "Filters") v.push(`after Clear all: count ${r.n}, aria-label "${r.label}"`);
      return v;
    });

    await cell("panel:head", async () => {
      const v = [];
      await toWorkshop();
      const r = await page(`const c = m.col(); if (!c) return null; const top = c.querySelector(".wf-top");
        return { title: top.querySelector("[data-wf-title]")?.textContent.trim() ?? null, tag: top.querySelector("[data-wf-title]")?.tagName ?? null,
          btns: [...top.querySelectorAll("button")].map((b) => b.matches("[data-wf-clear]") ? "clear" : b.matches("[data-wf-close]") ? "close" : b.textContent.trim() || b.className),
          pills: top.querySelectorAll(".pill").length, close: top.querySelector("[data-wf-close]")?.getAttribute("aria-label") ?? null };`);
      if (!r) return ["no docked panel at 1400 px"];
      if (r.title !== "Filters" || r.tag !== "SPAN") v.push(`the head's title is ${r.tag} "${r.title}" (want a plain "Filters")`);
      if (J(r.btns) !== J(["clear", "close"])) v.push(`the head's buttons ${J(r.btns)} (want Clear all, ×)`);
      if (r.pills) v.push("a pill in the panel's head");
      if (r.close !== "Close filters") v.push(`the × is labelled "${r.close}"`);
      const g = await page(`m.col().querySelector("[data-wf-close]").click(); await m.sleep(40); const ghosts = document.querySelectorAll(".wf-morph").length;
        await m.sleep(400); return { ghosts, col: !!m.q(".wf-col"), exp: m.tog()?.getAttribute("aria-expanded") };`);
      if (g.ghosts) v.push(`${g.ghosts} ghost copies flying on close (no morph)`);
      if (g.col || g.exp !== "false") v.push(`the × left the panel ${g.col ? "open" : "closed"}, the toggle aria-expanded ${g.exp}`);
      await page(`await m.open(true);`);
      return v;
    });

    // per-frame samples of the shown page's panel (transform x, opacity, closing) for `ms` after `act` (a toggle click)
    const framesOf = (pg, act, ms = 650) => page(`window.__fr = []; const t0 = performance.now();
      const sc = m.q(${J(pg === "library" ? ".lib-scroll" : ".scroll:not(.lib-scroll)")}); window.__gr = [];
      const f = () => { const c = document.querySelector('.wf-col[data-wf-page="${pg}"]'); window.__gr.push(sc.getBoundingClientRect().right);
        if (c) { const t = getComputedStyle(c).transform; const mm = new DOMMatrixReadOnly(t === "none" ? undefined : t);
          window.__fr.push({ tx: mm.m41, op: +getComputedStyle(c).opacity, cl: c.classList.contains("closing"), an: c.getAnimations().length,
            props: [...new Set(c.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)) }); }
        else window.__fr.push(null);
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(f); };
      window.__gr.push(sc.getBoundingClientRect().right); // before the toggle: its click commits before the first frame
      requestAnimationFrame(f); ${act} await m.sleep(${ms + 120}); return window.__fr;`);
    const gridEdge = () => page(`return window.__gr;`);
    // the grid's right edge over a toggle: one step (the margin flips as the slide starts — the grid re-fits once, like for
    // the item sidebar), the given way, and nothing after it
    const oneStep = (v, what, gr, dir) => {
      const steps = gr.filter((x, i) => i && Math.abs(x - gr[i - 1]) > 0.5).length;
      if (steps !== 1) v.push(`${what}: the grid's right edge moved ${steps} times (want one step) ${J(gr.map(Math.round))}`);
      if (dir * (gr[gr.length - 1] - gr[0]) <= 0) v.push(`${what}: the grid's right edge went ${Math.round(gr[0])} → ${Math.round(gr[gr.length - 1])}`);
    };
    await cell("panel:right", async () => {
      const v = [];
      await toWorkshop();
      const geo = await page(`const c = m.col(), tb = document.querySelector(".topbar"), t = m.tog(); if (!c || !t) return null;
        return { c: m.rect(c), tb: m.rect(tb), t: m.rect(t), W: innerWidth, mode: c.dataset.mode, mr: parseFloat(getComputedStyle(m.q(".scroll")).marginRight) };`);
      if (!geo) return ["no docked panel / toggle at 1400 px"];
      if (geo.mode !== "dock" || Math.abs(geo.c.r - geo.W) > 0.5) v.push(`the panel (${geo.mode}) spans ${geo.c.x}–${geo.c.r}, not at the right edge of ${geo.W}`);
      if (Math.abs(geo.c.y - geo.tb.b) > 1) v.push(`the panel starts at ${geo.c.y}, the top bar ends at ${geo.tb.b}`);
      if (!(geo.t.r > geo.c.x && geo.t.x < geo.c.r)) v.push(`the toggle (${geo.t.x}–${geo.t.r}) isn't above the panel (${geo.c.x}–${geo.c.r})`);
      if (Math.abs(geo.mr - geo.c.w) > 1) v.push(`the grid's margin-right ${geo.mr} (want the panel's ${geo.c.w})`);
      // closing: slides out to the right, fading, then gone
      let fr = await framesOf("browse", `m.tog().click();`);
      const out = fr.filter(Boolean);
      const props = [...new Set(out.flatMap((x) => x.props))];
      if (!out.length || !out.every((x) => x.cl)) v.push(`closing: ${out.length} frames of the panel, closing on ${out.filter((x) => x.cl).length}`);
      if (!out.some((x) => x.tx > 2 && x.tx < 30 && x.op > 0.02 && x.op < 0.98)) v.push(`closing: no in-between frame (tx / opacity ${J(out.map((x) => [Math.round(x.tx), +x.op.toFixed(2)]))})`);
      if (out.some((x, i) => i && x.tx < out[i - 1].tx - 0.5)) v.push("closing: it moves back left on the way out");
      if (fr[fr.length - 1] !== null) v.push("closing: the panel is still there after the slide");
      if (props.some((p) => !["transform", "opacity"].includes(p))) v.push(`closing animates ${J(props)}`);
      oneStep(v, "closing", await gridEdge(), 1);
      const mr = await page(`return parseFloat(getComputedStyle(m.q(".scroll")).marginRight);`);
      if (mr > 1) v.push(`closed: the grid keeps a ${mr} px margin-right`);
      // opening: from the right, through in-between offsets, landing on 0
      fr = await framesOf("browse", `m.tog().click();`);
      const inn = fr.filter(Boolean), first = inn[0], last = inn[inn.length - 1];
      const props2 = [...new Set(inn.flatMap((x) => x.props))];
      if (!first || !(first.tx > 2) || !(first.op < 0.9)) v.push(`opening: the first frame sits at ${first ? `${first.tx.toFixed(1)} px, opacity ${first.op.toFixed(2)}` : "nothing"} (want off to the right, faded)`);
      if (!inn.some((x) => x.tx > 1 && x.tx < 38)) v.push(`opening: no in-between offset ${J(inn.map((x) => Math.round(x.tx)))}`);
      if (inn.some((x) => x.tx < -6)) v.push(`opening: it overshoots ${Math.min(...inn.map((x) => x.tx)).toFixed(1)} px to the left`);
      if (!last || Math.abs(last.tx) > 0.5 || last.op < 0.99 || last.cl) v.push(`opening: it lands at ${last ? `${last.tx.toFixed(1)} px, opacity ${last.op}` : "nothing"}`);
      if (props2.some((p) => !["transform", "opacity"].includes(p))) v.push(`opening animates ${J(props2)}`);
      oneStep(v, "opening", await gridEdge(), -1);
      // the same per-frame path closing as opening, reversed: out to the right and faded, from where it rests
      if (out.length && inn.length && (out[0].tx > 0.5 || out[0].op < 0.99)) v.push(`closing starts at ${out[0].tx.toFixed(1)} px / ${out[0].op} (want from rest)`);
      // remembered over a reload, both ways; a tab visit shows it without the slide
      await page(`await m.open(false);`); await loadUi(); await toWorkshop(false);
      if (await page(`return !!m.q(".wf-col") || m.isOpen();`)) v.push("closed isn't remembered over a reload");
      await page(`await m.open(true);`); await loadUi(); await toWorkshop(false);
      if (!(await page(`return !!m.col() && m.isOpen();`))) v.push("open isn't remembered over a reload");
      await tab("Library"); await tab("Browse");
      if (await page(`return m.col()?.getAnimations().length ?? -1;`)) v.push("a tab visit replays the slide (or the panel is gone)");
      return v;
    });

    // the panel's open / close is the item sidebar's, exactly: its duration, curve and keyframes, both ways; motion off → the
    // same fade for both (opacity only, ~120 ms), never a pop
    await cell("motion:match", async () => {
      const v = [];
      const SIG = `const sig = (el) => { const a = el?.getAnimations().find((x) => x.effect?.target === el); if (!a) return null;
        const k = a.effect.getKeyframes(), t = a.effect.getTiming(), f = k[0], l = k[k.length - 1];
        return { dur: t.duration, ease: getComputedStyle(el).animationTimingFunction, from: [f.transform ?? "", f.opacity ?? ""], to: [l.transform ?? "", l.opacity ?? ""] }; };`;
      const run = async () => {
        await toWorkshop();
        const c = await page(`const t = m.q(".scroll:not(.lib-scroll) .card .thumb-wrap"); return t ? m.rect(t) : null;`);
        if (!c) return null;
        await rightAt(c.x + c.w / 2, c.y + c.h / 2); // the sidebar opens, the panel closes
        // `lingers`: ms until the closed one is gone (polled to 150; the exit slide is 170 — motion off its fade, ~170 with the frame it starts on)
        const gone = (sel) => `await (async () => { const t0 = performance.now(); while (m.q(${J(sel)}) && performance.now() - t0 < 150) await m.sleep(5); return Math.round(performance.now() - t0); })()`;
        const a = await page(`${SIG} await m.sleep(30); return { sideIn: sig(m.q(".side-panel:not(.closing)")), panelOut: sig(m.q(".wf-col.closing")),
          lingers: ${gone(".wf-col")} };`);
        await sleep(600);
        const b = await page(`${SIG} m.tog().click(); await m.sleep(30); return { panelIn: sig(m.q(".wf-col:not(.closing)")), sideOut: sig(m.q(".side-panel.closing")),
          lingers: ${gone(".side-panel")} };`);
        await sleep(600);
        return { ...a, ...b, lingerA: a.lingers, lingerB: b.lingers };
      };
      const on = await run();
      if (!on) return ["no Workshop card to right-click"];
      console.log(`        motion on: ${J(on)}`);
      const same = (what, x, y) => { if (!x || !y) v.push(`${what}: ${!x ? "the filter panel" : "the item sidebar"} didn't animate`);
        else if (J(x) !== J(y)) v.push(`${what}: the panel ${J(x)} ≠ the sidebar ${J(y)}`); };
      same("opening", on.panelIn, on.sideIn);
      same("closing", on.panelOut, on.sideOut);
      await setMotion(false);
      const off = await run();
      console.log(`        motion off: ${J(off)}`);
      same("motion off, opening", off.panelIn, off.sideIn);
      same("motion off, closing", off.panelOut, off.sideOut);
      for (const [k, s] of Object.entries({ panelIn: off.panelIn, sideIn: off.sideIn, panelOut: off.panelOut, sideOut: off.sideOut }))
        if (s && (s.from[0] || s.to[0] || s.dur > MO.FADE_MS + 30)) v.push(`motion off: ${k} isn't a short fade in place (${J(s)})`);
      // the closed one fades out (gone ~170 ms after, polled from ~30 ms in), never popped
      if (off.lingerA < 60 || off.lingerB < 60) v.push(`motion off: the closed one popped out (panel ${off.lingerA} ms, sidebar ${off.lingerB} ms)`);
      await setMotion(true);
      return v;
    });

    await cell("panel:persist", async () => {
      const v = [];
      const ls = () => page(`return [JSON.parse(localStorage.getItem("liascape.libFilterHidden")), JSON.parse(localStorage.getItem("liascape.browseFilterHidden"))];`);
      await tab("Library");
      if (!(await page(`return await m.open(true);`))) return ["no filter toggle on the Library"];
      await toWorkshop();
      await tab("Library"); await page(`await m.open(false);`);
      await toWorkshop(false);
      if (!(await page(`return m.isOpen() && !!m.col();`))) v.push("closing the Library's panel closed Browse's");
      await loadUi(); await tab("Library");
      if (await page(`return m.isOpen() || !!m.q('.wf-col[data-wf-page="library"]');`)) v.push("the Library's closed panel came back after a reload");
      await toWorkshop(false);
      if (!(await page(`return m.isOpen() && !!m.col();`))) v.push("Browse's open panel didn't stay open over a reload");
      if (J(await ls()) !== J([true, false])) v.push(`saved ${J(await ls())} (want libFilterHidden true, browseFilterHidden false)`);
      // the other way round
      await page(`await m.open(false);`); await tab("Library"); await page(`await m.open(true);`);
      await loadUi(); await tab("Library");
      if (!(await page(`return m.isOpen() && !!m.q('.wf-col[data-wf-page="library"]:not(.closing)');`))) v.push("the Library's open panel didn't stay open over a reload");
      await toWorkshop(false);
      if (await page(`return m.isOpen() || !!m.q(".wf-col");`)) v.push("Browse's closed panel came back after a reload");
      if (J(await ls()) !== J([false, true])) v.push(`saved ${J(await ls())} (want libFilterHidden false, browseFilterHidden true)`);
      // the item sidebar's state isn't kept
      await tab("Library");
      const c = await page(`const t = m.q(".lib-scroll .card .thumb-wrap"); return t ? m.rect(t) : null;`);
      if (c) { await rightAt(c.x + c.w / 2, c.y + c.h / 2); await sleep(600); }
      if (!(await page(`return !!m.q(".side-panel:not(.closing)");`))) v.push("(the item sidebar didn't open for the check)");
      await loadUi(); await tab("Library");
      if (await page(`return !!m.q(".side-panel");`)) v.push("the item sidebar came back after a reload");
      await page(`await m.open(true);`); await toWorkshop();
      return v;
    });

    // one right-hand panel at a time, both ways, each with its own slide and never both docked in a frame
    // started before the action (a page-side one in `act`, or a real input event sent after it returns), read `ms` later
    const swapStart = (pg, ms = 650) => page(`window.__sw = []; window.__swEnd = false; const t0 = performance.now();
      const f = () => { const c = document.querySelector('.wf-col[data-wf-page="${pg}"]'), s = document.querySelector('.side-panel[data-side="${pg}"]');
        const run = (e) => e ? e.getAnimations().filter((a) => a.playState === "running" && a.effect?.target === e).length : 0;
        window.__sw.push({ col: !!c && !c.classList.contains("closing"), colAny: !!c, side: !!s && !s.classList.contains("closing"), sideAny: !!s,
          colAn: run(c), sideAn: run(s), mr: parseFloat(getComputedStyle(m.q(".scroll")).marginRight), gr: m.q(".scroll").getBoundingClientRect().right });
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(f); else window.__swEnd = true; };
      requestAnimationFrame(f); return true;`);
    const swapRead = () => page(`while (!window.__swEnd) await m.sleep(30); return window.__sw;`);
    const swapFrames = async (pg, act) => { await swapStart(pg); await page(act); return swapRead(); };
    const swapCell = (pg) => async () => {
      const v = [];
      if (pg === "library") { await tab("Library"); await page(`await m.ensure();`); } else await toWorkshop();
      const scroll = pg === "library" ? ".lib-scroll" : ".scroll:not(.lib-scroll)";
      const w0 = await page(`const c = m.col(); return c ? m.rect(c).w : null;`);
      if (!w0) return [`${pg}: no docked panel to swap — proved nothing`];
      const judge = (dir, fr, wSide) => {
        const both = fr.filter((x) => x.col && x.side).length;
        if (both) v.push(`${dir}: ${both} frame(s) with the filters and the item sidebar both docked`);
        const wide = Math.max(...fr.map((x) => x.mr));
        if (wide > Math.max(w0, wSide) + 1) v.push(`${dir}: the grid's margin-right reached ${wide} px (the panels are ${w0} / ${wSide})`);
        // the two are the same width: the grid doesn't move at all while one replaces the other
        const gr = fr.map((x) => x.gr);
        if (Math.max(...gr) - Math.min(...gr) > 0.5) v.push(`${dir}: the grid's right edge moved during the swap ${J([...new Set(gr.map(Math.round))])}`);
      };
      // a right-click on a card: the sidebar slides in, the filters slide out
      const c = await page(`const t = m.q("${scroll} .card .thumb-wrap"); return t ? m.rect(t) : null;`);
      if (!c) return [`${pg}: no card to right-click`];
      await swapStart(pg); await rightAt(c.x + c.w / 2, c.y + c.h / 2);
      let fr = await swapRead();
      const end1 = await page(`const s = m.q('.side-panel[data-side="${pg}"]:not(.closing)'); return { side: s ? m.rect(s).w : 0, col: !!m.q('.wf-col[data-wf-page="${pg}"]'), exp: m.tog()?.getAttribute("aria-expanded") };`);
      if (!end1.side) v.push("right-click: no item sidebar");
      if (end1.col || end1.exp !== "false") v.push(`right-click: the filters stayed (${end1.col ? "panel there" : "gone"}, toggle aria-expanded ${end1.exp})`);
      judge("right-click", fr, end1.side);
      if (!fr.some((x) => x.colAny && !x.col && x.colAn)) v.push("right-click: the filters didn't slide out (no closing frame with its animation)");
      if (!fr.some((x) => x.side && x.sideAn)) v.push("right-click: the item sidebar didn't slide in");
      // the toggle: the filters slide in, the sidebar slides out (both animate)
      fr = await swapFrames(pg, `m.tog().click();`);
      judge("toggle", fr, end1.side);
      if (!fr.some((x) => x.sideAny && !x.side && x.sideAn)) v.push("toggle: the item sidebar didn't slide out (no closing frame with its animation)");
      if (!fr.some((x) => x.col && x.colAn)) v.push("toggle: the filters didn't slide in");
      const end2 = await page(`return { side: !!m.q('.side-panel[data-side="${pg}"]'), col: !!m.q('.wf-col[data-wf-page="${pg}"]:not(.closing)'), exp: m.tog()?.getAttribute("aria-expanded") };`);
      if (end2.side || !end2.col || end2.exp !== "true") v.push(`toggle: sidebar ${end2.side}, filters ${end2.col}, aria-expanded ${end2.exp}`);
      await shot(`swap-${pg}-filters`);
      // a keyboard focus (an arrow) opens the sidebar: the filters slide out (animated) while it slides in
      await page(`document.activeElement?.blur();`);
      fr = await swapFrames(pg, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));`);
      judge("arrow key", fr, end1.side);
      if (!fr.some((x) => x.colAny && !x.col && x.colAn)) v.push("arrow key: the filters didn't slide out (no closing frame with its animation)");
      if (!fr.some((x) => x.side && x.sideAn)) v.push("arrow key: the item sidebar didn't slide in");
      const end3 = await page(`return { side: !!m.q('.side-panel[data-side="${pg}"]:not(.closing)'), col: !!m.q('.wf-col[data-wf-page="${pg}"]') };`);
      if (!end3.side || end3.col) v.push(`arrow key: sidebar ${end3.side}, filters ${end3.col}`);
      await shot(`swap-${pg}-sidebar`);
      await page(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await m.sleep(300); await m.open(true);`);
      return v;
    };
    await cell("swap:browse", swapCell("browse"));
    await cell("swap:library", swapCell("library"));

    // the top bar never wraps; the sort folds to its icon (its label in a tooltip) below 1280 px
    for (const [w, h] of [[800, 600], [960, 700], [1100, 700], [1920, 1080]]) {
      await cell(`split:noWrap:${w}`, async () => {
        const v = [];
        await resize(w, h);
        for (const pg of ["Library", "Workshop"]) {
          if (pg === "Library") await tab("Library"); else await toWorkshop(false);
          for (const st of ["closed", "open"]) {
            if (!(await page(`return await m.open(${st === "open"});`))) { v.push(`${pg} ${w} px: no filter toggle`); continue; }
            send({ type: "mouseMove", x: 2, y: h - 2 }); await sleep(200);
            const r = await page(`const tb = document.querySelector(".topbar");
              const kids = [...tb.querySelectorAll(":scope > *, :scope > .pills > *")].filter((e) => { const b = e.getBoundingClientRect();
                return b.width > 0 && b.height > 0 && !e.matches(".pills, .spacer"); });
              const mid = kids.map((e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; });
              const s = m.split(), val = s?.querySelector(".ss-sort .sel-val"), sb = s?.getBoundingClientRect();
              return { n: kids.length, spread: Math.max(...mid) - Math.min(...mid), tbH: tb.getBoundingClientRect().height, r: sb?.right ?? null, W: innerWidth,
                label: val ? val.getBoundingClientRect().width > 0 : null, title: s?.querySelector(".ss-sort")?.getAttribute("title") ?? null, text: val?.textContent ?? null };`);
            const at = `${pg} ${w} px, panel ${st}`;
            console.log(`        ${at}: ${J(r)}`);
            if (r.r == null) { v.push(`${at}: no split button`); continue; }
            if (r.spread > 4 || r.tbH > 60) v.push(`${at}: the top bar wraps (its controls' centres ${r.spread.toFixed(0)} px apart, ${r.tbH.toFixed(0)} px tall — one row is ≤ 60)`);
            if (r.r > r.W + 0.5) v.push(`${at}: the split button sticks out (${r.r} > ${r.W})`);
            if (w >= 1280 && (!r.label || r.title)) v.push(`${at}: the sort's label shows ${r.label}, tooltip "${r.title}" (want the label, no tooltip)`);
            if (w < 1280 && (r.label || r.title !== `Sort: ${r.text}`)) v.push(`${at}: the sort's label shows ${r.label}, tooltip "${r.title}" (want the icon, "Sort: ${r.text}")`);
            await shot(`split-${pg.toLowerCase()}-${w}-${st}`);
          }
          await page(`await m.open(false);`);
        }
        await resize(1400, 900); await tab("Library"); await page(`await m.ensure();`); await toWorkshop();
        return v;
      });
    }

    // ---- the search field's fold (components/TopbarSearch.tsx): below 860 px a magnifier; a click opens it in place (a morph on
    // transforms: the window over its frame slides open, the controls to its left glide aside, nothing to its right moves);
    // motion off it fades; it folds back on a blur while empty, holding a query it stays open where the bar has room, else
    // folds lit; Escape clears and folds it. The app has no search shortcut: the click is the way in.
    const SEARCH_AT = `(() => { const b = document.querySelector(".topbar .tsearch"); if (!b) return null; const i = b.querySelector("input.search"), btn = b.querySelector(".ts-btn");
      const r = (e) => { const x = e.getBoundingClientRect(); return { x: +x.x.toFixed(1), r: +x.right.toFixed(1), w: +x.width.toFixed(1) }; };
      return { folded: b.hasAttribute("data-folded"), open: b.hasAttribute("data-open"), lit: b.hasAttribute("data-lit"), box: r(b), input: r(i), label: btn.getAttribute("aria-label"),
        btnFocusable: btn.tabIndex >= 0, inputVis: getComputedStyle(i).visibility, focused: document.activeElement === i, value: i.value, W: innerWidth }; })()`;
    const searchAt = () => page(`return ${SEARCH_AT};`);
    const clickAt = async (sel) => {
      const p = await page(`const e = m.q(${J(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };`);
      if (!p) throw new Error(`nothing at ${sel}`);
      send({ type: "mouseMove", ...p }); await sleep(30);
      send({ type: "mouseDown", ...p, button: "left", clickCount: 1 }); await sleep(30);
      send({ type: "mouseUp", ...p, button: "left", clickCount: 1 });
    };
    const typeText = async (t) => { for (const ch of t) { send({ type: "char", keyCode: ch }); await sleep(25); } await sleep(300); };
    const pressKey = async (k) => { send({ type: "keyDown", keyCode: k }); await sleep(20); send({ type: "keyUp", keyCode: k }); await sleep(300); };
    const blurSearch = () => page(`document.activeElement?.blur(); await m.sleep(500);`);
    const fold = async () => { await page(`const i = m.q(".topbar .tsearch input.search"); if (i?.value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); }`); await blurSearch(); };
    // the page to search on: the Library, or the Workshop (its fake list) with its filter panel closed (the bar's room)
    const toPage = async (pg) => { if (pg === "Library") await tab("Library"); else await toWorkshop(false); await page(`await m.open(false);`); await fold(); };
    // the control left of the search that glides aside, the split right of it that must not move
    const LEFT = { Library: ".topbar > .btn.ghost[aria-label=Import]", Workshop: ".topbar > .pills > .mini" };
    const glides = (fr) => fr.filter((f, i) => i > 0 && i < fr.length - 1 && f[1] != null && fr[i - 1][1] != null && fr[i + 1][1] != null
      && Math.abs(f[2] - fr[i - 1][2]) > 0.3 && Math.abs(fr[i + 1][2] - f[2]) > 0.3 && Math.sign(f[2] - fr[i - 1][2]) === Math.sign(fr[i + 1][2] - f[2])).length;
    const stillX = (fr) => fr.filter((f, i) => i > 0 && f[1] != null && fr[i - 1][1] != null && Math.abs(f[2] - fr[i - 1][2]) > 0.75).length;
    const ANIM_PROPS = `[...new Set(document.querySelector(".topbar").getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSTransition))
      .flatMap((a) => (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))))]`;

    // the tier: folded below 860 px on both pages, a field from 860 px (the bar one row either way)
    for (const w of [800, 850, 870, 1100]) {
      await cell(`search:fold:${w}`, async () => {
        const v = [];
        await resize(w, 700);
        for (const pg of ["Library", "Workshop"]) {
          await toPage(pg);
          const s = await searchAt();
          if (!s) { v.push(`${pg} ${w} px: no search`); continue; }
          // the window manager-less Xvfb lands a px or so off the asked size: the tier is judged at the page's own width
          if (s.W !== w) console.log(`        ${pg}: the window is ${s.W} px wide (asked ${w})`);
          if (s.W < 860) {
            if (!s.folded || s.box.w > 37) v.push(`${pg} ${w} px: the search isn't folded (${s.box.w} px wide)`);
            if (s.label !== "Search" || !s.btnFocusable) v.push(`${pg} ${w} px: the magnifier is "${s.label}", focusable ${s.btnFocusable} (want a "Search" button)`);
            if (s.inputVis !== "hidden") v.push(`${pg} ${w} px: the folded field's input shows (${s.inputVis})`);
          } else if (s.folded || s.input.w < 119.5) v.push(`${pg} ${w} px: the field is ${s.folded ? "folded" : `${s.input.w} px wide`} (want a field ≥ 120 px)`);
          const r = await page(`const tb = document.querySelector(".topbar"); const kids = [...tb.querySelectorAll(":scope > *, :scope > .pills > *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && !e.matches(".pills, .spacer, .status"); });
            const mid = kids.map((e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; }); return { spread: Math.max(...mid) - Math.min(...mid), right: Math.max(...kids.map((e) => e.getBoundingClientRect().right)) };`);
          if (r.spread > 4) v.push(`${pg} ${w} px: the top bar wraps (centres ${r.spread.toFixed(0)} px apart)`);
          if (r.right > w + 0.5) v.push(`${pg} ${w} px: a control sticks out (${r.right} > ${w})`);
          await shot(`search-fold-${pg.toLowerCase()}-${w}`);
        }
        return v;
      });
    }

    // the fullest bar the fold is sized for: Undo (a trashed item) and Stop (a wallpaper playing) beside everything else: one row,
    // nothing out of the window, no control over another, a field ≥ 120 px where it isn't folded — closed and opened
    const lib0 = (await http("GET", "/library")).json ?? [];
    for (const w of [761, 800, 850, 870, 960, 1100, 1279]) {
      await cell(`search:worst:${w}`, async () => {
        const v = [];
        const vid = lib0.find((i) => !i.isScene && /\.(mp4|webm|mkv)$/i.test(i.videoPath)) ?? lib0[0];
        const gone = lib0.find((i) => i !== vid && i.videoPath !== vid?.videoPath);
        if (!vid || !gone) return ["the stack's library has fewer than two items — proved nothing"];
        // the undo depth is read on load; Stop follows the backend's wallpaper-changed, so the apply comes with the page open
        await post("/library/trash", { items: [gone] });
        await loadUi(); await resize(w, 700);
        const ap = await post("/apply", { path: vid.videoPath });
        for (let i = 0; i < 40 && !(await page(`return !!m.q(".topbar [aria-label=Stop]") && !!m.q(".topbar [aria-label=Undo]");`)); i++) await sleep(200);
        if (ap.status !== 200) console.log(`        /apply answered ${ap.status} ${J(ap.json)}`);
        try {
          for (const pg of ["Library", "Workshop"]) {
            await toPage(pg);
            const has = await page(`return { undo: !!m.q(".topbar [aria-label=Undo]"), stop: !!m.q(".topbar [aria-label=Stop]") };`);
            if (!has.undo || !has.stop) { v.push(`${pg} ${w} px: Undo ${has.undo}, Stop ${has.stop} — not the fullest bar, proved nothing`); continue; }
            for (const st of ["closed", "opened"]) {
              if (st === "opened") { if (!(await searchAt()).folded) break; await clickAt(".topbar .tsearch .ts-btn"); await sleep(600); }
              const r = await page(`const tb = document.querySelector(".topbar"), sb = tb.querySelector(".pill-strip")?.getBoundingClientRect();
                const parts = [...tb.querySelectorAll(".tab, .pill, .mini, .tsearch, .btn, [data-sortsplit]")].map((e) => { let b = e.getBoundingClientRect();
                  if (sb && e.closest(".pill-strip")) { const x = Math.max(b.left, sb.left + 10), rr = Math.min(b.right, sb.right - 10); if (rr - x <= 1) return null; b = new DOMRect(x, b.top, rr - x, b.height); }
                  return b.width > 0 ? { k: e.className.split(" ")[0] + ":" + (e.getAttribute("aria-label") ?? e.textContent.trim().slice(0, 12)), x: b.left, r: b.right, y: b.top, b: b.bottom, m: b.top + b.height / 2 } : null; }).filter(Boolean);
                return { parts, W: innerWidth };`);
              const at = `${pg} ${w} px, Undo + Stop, search ${st}`, ps = r.parts;
              const mid = ps.map((p) => p.m);
              if (Math.max(...mid) - Math.min(...mid) > 4) v.push(`${at}: the top bar wraps`);
              for (const p of ps) if (p.x < -0.5 || p.r > r.W + 0.5) v.push(`${at}: ${p.k} sticks out (${p.x.toFixed(0)}–${p.r.toFixed(0)})`);
              for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
                const a = ps[i], b = ps[j], ix = Math.min(a.r, b.r) - Math.max(a.x, b.x), iy = Math.min(a.b, b.b) - Math.max(a.y, b.y);
                if (ix > 1 && iy > 1) v.push(`${at}: ${a.k} overlaps ${b.k} (${ix.toFixed(0)} px)`);
              }
              const s = await searchAt();
              if (!s.folded && s.input.w < 119.5) v.push(`${at}: the field is ${s.input.w} px wide`);
              await shot(`search-worst-${pg.toLowerCase()}-${w}-${st}`);
            }
            await fold();
          }
        } finally {
          await post("/library/undo"); await post("/stop"); await loadUi(); await resize(1400, 900);
        }
        return v;
      });
    }

    // motion on: the click opens it — the window's edge, the control to its left pass through in-between places, the split
    // stays put; it takes the focus; only transforms / opacity / a clip animate. A blur while empty folds it the same way back.
    await cell("search:open", async () => {
      const v = [];
      await resize(800, 700);
      for (const pg of ["Library", "Workshop"]) {
        await toPage(pg);
        const sels = { win: ".topbar .tsearch .ts-win", left: LEFT[pg], split: ".topbar [data-sortsplit]" };
        const sm = js(MO.SAMPLE(sels, 700));
        await sleep(40);
        await clickAt(".topbar .tsearch .ts-btn");
        await sleep(90); await shot(`search-open-${pg.toLowerCase()}-mid`);
        const props = await js(ANIM_PROPS);
        const fr = await sm;
        const s = await searchAt();
        console.log(`        ${pg} open: win ${MO.brief(fr.win)} left ${MO.brief(fr.left)} props ${J(props)}`);
        if (s.folded || !s.focused) v.push(`${pg}: a click on the magnifier left it ${s.folded ? "folded" : "open but unfocused"}`);
        if (glides(fr.win) < 3) v.push(`${pg}: the field's edge didn't glide open (${glides(fr.win)} in-between frames)`);
        if (glides(fr.left) < 3) v.push(`${pg}: ${LEFT[pg]} didn't glide aside (${glides(fr.left)} in-between frames)`);
        if (stillX(fr.split)) v.push(`${pg}: the split button right of the search moved in ${stillX(fr.split)} frames`);
        const bad = props.filter((p) => !["transform", "translate", "opacity", "clipPath"].includes(p));
        if (bad.length) v.push(`${pg}: the morph animates ${bad.join(", ")}`);
        await sleep(300); await shot(`search-open-${pg.toLowerCase()}-end`);
        const sm2 = js(MO.SAMPLE(sels, 700));
        await sleep(40);
        await page(`document.activeElement?.blur();`);
        await sleep(90); await shot(`search-fold-${pg.toLowerCase()}-mid`);
        const fr2 = await sm2, s2 = await searchAt();
        if (!s2.folded) v.push(`${pg}: a blur while empty didn't fold it`);
        if (glides(fr2.win) < 3) v.push(`${pg}: the field's edge didn't glide shut (${glides(fr2.win)} in-between frames)`);
        if (glides(fr2.left) < 3) v.push(`${pg}: ${LEFT[pg]} didn't glide back (${glides(fr2.left)} in-between frames)`);
        if (stillX(fr2.split)) v.push(`${pg}: the split button moved while it folded`);
      }
      await resize(1400, 900);
      return v;
    });

    // motion off: the opened field fades in where it lands while the magnifier fades out where it was; folding, the reverse;
    // opacity only, nothing in it moves
    await cell("search:off", async () => {
      const v = [];
      await setMotion(false);
      await resize(800, 700);
      try {
        for (const pg of ["Library", "Workshop"]) {
          await toPage(pg);
          const sels = { field: ".topbar .tsearch:not([data-folded]) input.search", ghost: ".topbar .tsearch .ts-ghost", btn: ".topbar .tsearch[data-folded] .ts-btn" };
          let sm = js(MO.SAMPLE(sels, 500));
          await sleep(40);
          await clickAt(".topbar .tsearch .ts-btn");
          await sleep(40); await shot(`search-off-${pg.toLowerCase()}-open-mid`);
          const props = await page(`return ${MO.OPACITY_ONLY}(document.querySelector(".topbar .tsearch"));`);
          let fr = await sm;
          console.log(`        ${pg} motion off, open: field ${MO.brief(fr.field)} ghost ${MO.brief(fr.ghost)}`);
          v.push(...MO.judge(`${pg} motion off, open: the field`, fr.field, { appear: true }), ...MO.judge(`${pg} motion off, open: the magnifier it was`, fr.ghost, { leave: true, appear: false }));
          if (props.length) v.push(`${pg} motion off: the search animates ${props.join(", ")} (opacity only)`);
          if (!(await searchAt()).focused) v.push(`${pg} motion off: the opened field isn't focused`);
          sm = js(MO.SAMPLE(sels, 500));
          await sleep(40);
          await page(`document.activeElement?.blur();`);
          await sleep(40); await shot(`search-off-${pg.toLowerCase()}-fold-mid`);
          fr = await sm;
          v.push(...MO.judge(`${pg} motion off, fold: the magnifier`, fr.btn, { appear: true }), ...MO.judge(`${pg} motion off, fold: the field it was`, fr.ghost, { leave: true }));
        }
      } finally { await setMotion(true); await resize(1400, 900); }
      return v;
    });

    // holding a query: it stays open after a blur where the status slot keeps its room (the Library at 840 px, nothing playing),
    // the list filtered; where it hasn't (a wallpaper playing: Stop takes it), it folds lit — the accent, the dot, the query in
    // its name; widening shows the field with the query
    await cell("search:keep", async () => {
      const v = [];
      await resize(840, 700);
      await toPage("Library");
      const n0 = await page(`return m.qa(".lib-scroll .card.lib").length;`);
      const q = (lib0.find((i) => !i.isScene)?.title ?? "k1").slice(0, 3);
      await clickAt(".topbar .tsearch .ts-btn"); await sleep(450);
      await typeText(q);
      await blurSearch();
      let s = await searchAt();
      const n1 = await page(`return m.qa(".lib-scroll .card.lib").length;`);
      if (s.folded || s.value !== q) v.push(`840 px, room: after a blur holding "${q}" it is ${s.folded ? "folded" : "open"} reading "${s.value}" (want open)`);
      if (!(n1 < n0)) v.push(`the query "${q}" didn't filter the list (${n0} → ${n1} cards) — proved nothing`);
      await shot("search-keep-open");
      const vid = lib0.find((i) => !i.isScene) ?? lib0[0];
      await post("/apply", { path: vid.videoPath });
      try {
        await sleep(800);
        await clickAt(".topbar .tsearch .search"); await sleep(200);
        await blurSearch();
        s = await searchAt();
        const look = await page(`const b = m.q(".topbar .tsearch .ts-btn"); return { color: getComputedStyle(b).color, dot: getComputedStyle(b, "::after").opacity, accent: m.accent() };`);
        if (!s.lit || !s.folded) v.push(`840 px, Stop showing: after a blur holding "${q}" it is ${s.folded ? "folded" : "open"}, lit ${s.lit} (want folded and lit)`);
        if (s.label !== `Search: ${q}`) v.push(`the lit magnifier's name is "${s.label}" (want "Search: ${q}")`);
        if (look.color !== look.accent || +look.dot < 0.99) v.push(`the lit magnifier: colour ${look.color} (accent ${look.accent}), dot opacity ${look.dot}`);
        if ((await page(`return m.qa(".lib-scroll .card.lib").length;`)) !== n1) v.push("folded lit, the list isn't filtered any more");
        await shot("search-keep-lit");
        await resize(1100, 700);
        s = await searchAt();
        if (s.folded || s.value !== q) v.push(`at 1100 px the field ${s.folded ? "stays folded" : `reads "${s.value}"`}`);
      } finally { await post("/stop"); await resize(1400, 900); await fold(); }
      return v;
    });

    // Escape (a real key) clears the query and folds it, the list unfiltered; from the full field it clears it
    await cell("search:escape", async () => {
      const v = [];
      await resize(800, 700);
      await toPage("Library");
      const n0 = await page(`return m.qa(".lib-scroll .card.lib").length;`);
      await clickAt(".topbar .tsearch .ts-btn"); await sleep(450);
      await typeText("zzq");
      if ((await page(`return m.qa(".lib-scroll .card.lib").length;`)) >= n0) v.push("the query didn't filter — proved nothing");
      await pressKey("Escape");
      let s = await searchAt();
      if (!s.folded || s.value || s.focused) v.push(`after Escape: folded ${s.folded}, value "${s.value}", focused ${s.focused}`);
      if ((await page(`return m.qa(".lib-scroll .card.lib").length;`)) !== n0) v.push("after Escape the list is still filtered");
      await resize(1400, 900);
      await clickAt(".topbar .tsearch .search"); await sleep(200);
      await typeText("zzq");
      await pressKey("Escape");
      s = await searchAt();
      if (s.value || s.focused) v.push(`wide, after Escape: value "${s.value}", focused ${s.focused}`);
      return v;
    });

    // Glow effects off: no glow round the focused field or on the lit dot; the wallpaper behind every tab: the field's fill is
    // translucent like the bar's (it was opaque-equal before: compare)
    await cell("search:look", async () => {
      const v = [];
      const read = async (tag) => {
        await resize(800, 700); await toPage("Library");
        // past the morph and the glow's own fade in
        await clickAt(".topbar .tsearch .ts-btn"); await sleep(900);
        const r = await page(`const b = m.q(".topbar .tsearch"); return { glow: getComputedStyle(b.querySelector(".ts-glow")).boxShadow, glowOp: getComputedStyle(b.querySelector(".ts-glow")).opacity,
          fill: getComputedStyle(b.querySelector(".ts-win > .ts-frame")).backgroundColor, dot: getComputedStyle(b.querySelector(".ts-btn"), "::after").boxShadow };`);
        await shot(`search-look-${tag}`);
        await fold();
        return r;
      };
      const alpha = (c) => { const m = /\/\s*([\d.]+)\)|rgba\([^)]*,\s*([\d.]+)\)/.exec(c); return m ? +(m[1] ?? m[2]) : 1; };
      const glowless = (x) => x === "none" || /0px 0px 0px 0px/.test(x) || /rgba\(0, 0, 0, 0\)/.test(x);
      const on = await read("glow");
      if (glowless(on.glow) || +on.glowOp < 0.99) v.push(`glow on: the focused field has no glow (${on.glow}, opacity ${on.glowOp})`);
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true }); await loadUi();
      try {
        const off = await read("noglow-bglive");
        console.log(`        ${J({ on, off })}`);
        if (!glowless(off.glow)) v.push(`Glow effects off: the focused field still glows (${off.glow})`);
        if (!glowless(off.dot)) v.push(`Glow effects off: the lit dot still glows (${off.dot})`);
        if (!(alpha(off.fill) < alpha(on.fill)) && !(alpha(off.fill) < 1)) v.push(`bg-live: the field's fill isn't translucent (${off.fill}; without: ${on.fill})`);
      } finally { await setSettings({ glows: true, liveWallpaperBehindAllTabs: false }); await loadUi(); await resize(1400, 900); }
      return v;
    });

    await cell("wf:drawer", async () => {
      const v = [];
      // its own page: the Workshop's column (the cells before it may end anywhere — the search cells end on the Library)
      await loadUi(); await toWorkshop(false);
      await resize(860, 700);
      let r = await page(`return { col: !!m.q(".wf-col"), btn: !!m.tog() };`);
      if (r.col) v.push("at 860 px the column is still on screen (docked)");
      if (!r.btn) return [...v, "no filter toggle in the top bar at 860 px"];
      // open, set two tags inside it
      await page(`m.tog().click(); await m.sleep(450);`);
      r = await page(`const c = m.col(); if (!c) return null; const s = m.q(".wf-scrim");
        return { mode: c.dataset.mode, c: m.rect(c), scrim: !!s, z: +getComputedStyle(c).zIndex, W: innerWidth, H: innerHeight };`);
      if (!r) return [...v, "the filter toggle didn't open the drawer"];
      if (r.mode !== "drawer") v.push(`the column opened as "${r.mode}"`);
      if (r.c.x < -0.5 || Math.abs(r.c.r - r.W) > 0.5 || r.c.b > r.H + 0.5) v.push(`the drawer (${J(r.c)}) isn't at the right edge inside the ${r.W}×${r.H} window`);
      if (!r.scrim) v.push("no scrim");
      if (!(r.z > 40)) v.push(`the drawer's z-index ${r.z} is under the item sidebar's (40)`);
      await page(`m.seg("Anime", "inc").click(); m.seg("Mature", "exc").click(); await m.sleep(500);`);
      const btn = await page(`return m.tog()?.querySelector("[data-wf-count]")?.textContent ?? null;`);
      if (btn !== "2") v.push(`the toggle's count reads "${btn}" with two tags on`);
      await shot("drawer-860x700");
      // Escape closes it (and the item sidebar stays as it was)
      await page(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await m.sleep(400);`);
      if (await page(`return !!m.q(".wf-col");`)) v.push("Escape didn't close the drawer");
      // with the item sidebar open the toggle swaps it for the drawer (one right-hand panel); the scrim closes the drawer
      await page(`m.q(".scroll:not(.lib-scroll) .card .thumb-wrap")?.click(); await m.sleep(600);`);
      const side0 = await page(`return !!m.q(".side-panel:not(.closing)");`);
      await page(`m.tog().click(); await m.sleep(450);`);
      r = await page(`const c = m.col(); if (!c) return null; const b = m.rect(c); const hit = document.elementFromPoint(b.x + b.w / 2, b.y + 60);
        return { side: !!m.q(".side-panel"), top: !!hit?.closest(".wf-col") };`);
      if (!side0) v.push("(the item sidebar didn't open for the check)");
      if (!r) v.push("the toggle didn't open the drawer with the item sidebar open");
      else { if (r.side) v.push("the item sidebar stayed open beside the drawer"); if (!r.top) v.push("something covers the drawer"); }
      await shot("drawer-sidebar-860x700");
      await page(`const c = m.col(), b = m.rect(c); document.elementFromPoint(Math.max(20, b.x - 40), b.y + 40)?.click(); await m.sleep(400);`);
      if (await page(`return !!m.q(".wf-col");`)) v.push("a click on the scrim didn't close the drawer");
      // widening docks it again (open: the docked state is its own, remembered open)
      await resize(1400, 900);
      if ((await page(`return m.col()?.dataset.mode;`)) !== "dock") v.push("back at 1400 px the column isn't docked");
      return v;
    });

    for (const [w, h] of SIZES) {
      await cell(`wf:size:${w}x${h}`, async () => {
        const v = [];
        await resize(w, h);
        await toWorkshop();
        const W = await js(`innerWidth`);
        const geo = () => page(`const sc = m.q(".scroll"), s = m.rect(sc), c = m.col();
          const cards = [...sc.querySelectorAll(".card")].slice(0, 40).map((x) => x.getBoundingClientRect()).filter((b) => b.width > 0);
          return { s, col: c ? { mode: c.dataset.mode, r: m.rect(c) } : null, grid: sc.clientWidth,
            over: cards.filter((b) => b.right > s.r + 1 || b.left < s.x - 1).length, n: cards.length,
            doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || sc.scrollWidth > sc.clientWidth + 1 };`);
        let g = await geo();
        const docked = W >= 900;
        if (docked !== (g.col?.mode === "dock")) v.push(`${W} px: the column is ${g.col ? g.col.mode : "absent"} (docked from 900)`);
        if (g.grid < 240) v.push(`the grid is ${g.grid} px wide`);
        if (g.over) v.push(`${g.over}/${g.n} cards stick out of the grid`);
        if (g.doc) v.push("something scrolls sideways");
        if (docked && g.col && g.s.r > g.col.r.x + 1) v.push("the grid runs under the column");
        await shot(`size-${w}x${h}`);
        // the item sidebar opened: it takes the panel's place
        await page(`m.q(".scroll:not(.lib-scroll) .card .thumb-wrap")?.click(); await m.sleep(650);`);
        g = await geo();
        const side = await page(`const p = m.q(".side-panel:not(.closing)"); return p ? m.rect(p) : null;`);
        if (g.col) v.push(`the filter panel (${g.col.mode}) stayed open beside the item sidebar`);
        if (side && W >= 900) {
          if (g.grid < 240) v.push(`with the item sidebar open the grid is ${g.grid} px`);
          if (g.s.r > side.x + 1) v.push("the grid runs under the item sidebar");
        }
        if (g.over) v.push(`sidebar open: ${g.over}/${g.n} cards stick out of the grid`);
        if (docked) await shot(`size-${w}x${h}-sidebar`);
        await page(`m.q(".side-panel [data-side-close]")?.click(); await m.sleep(400);`);
        if (docked) await page(`await m.open(true);`);
        if (!docked) {
          await page(`m.tog()?.click(); await m.sleep(450);`);
          const d = await page(`const c = m.col(); if (!c) return null; const b = m.rect(c); const close = c.querySelector(".wf-close"); const cb = close ? m.rect(close) : null;
            return { b, cb, W: innerWidth, H: innerHeight, sh: c.querySelector(".wf-scroll").scrollHeight > c.querySelector(".wf-scroll").clientHeight };`);
          if (!d) v.push("the filter toggle didn't open the drawer");
          else {
            if (d.b.x < -0.5 || d.b.r > d.W + 0.5 || d.b.b > d.H + 0.5 || d.b.w < 200) v.push(`the drawer ${J(d.b)} doesn't fit the ${d.W}×${d.H} window`);
            if (!d.cb || d.cb.r > d.W + 0.5 || d.cb.y < 0) v.push("the drawer's close button is out of reach");
            await shot(`size-${w}x${h}-drawer`);
            await page(`m.col()?.querySelector(".wf-close")?.click(); await m.sleep(400);`);
          }
        }
        return v;
      });
    }
    await resize(1400, 900);

    await cell("wf:noMotion", async () => {
      const v = [];
      await resize(860, 700);
      const probe = () => page(`m.tog().click(); await m.sleep(30);
        const c = m.col(), s = m.q(".wf-scrim");
        const anims = [...(c?.getAnimations() ?? []), ...(s?.getAnimations() ?? [])];
        const props = [...new Set(anims.flatMap((a) => (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))))];
        await m.sleep(450);
        c.querySelector(".wf-close").click(); const t0 = performance.now();
        while (m.q(".wf-col") && performance.now() - t0 < 1000) await m.sleep(10);
        return { n: anims.length, props, gone: Math.round(performance.now() - t0) };`);
      let r = await probe();
      console.log(`        motion on: ${J(r)}`);
      if (!r.n) v.push("motion on: the drawer doesn't animate in");
      const bad = r.props.filter((p) => !["transform", "opacity", "translate"].includes(p));
      if (bad.length) v.push(`motion on: animates ${bad.join(", ")}`);
      // motion off: the drawer and its scrim fade in and out in place, opacity only
      await setMotion(false);
      const sides = { col: ".wf-col", scrim: ".wf-scrim" };
      r = await page(`let s = ${MO.SAMPLE(sides, 500)}; ${NF} m.tog().click(); await m.sleep(40); const none = document.createElement("i");
        const props = [...${MO.OPACITY_ONLY}(m.col() ?? none), ...${MO.OPACITY_ONLY}(m.q(".wf-scrim") ?? none)];
        const open = await s; s = ${MO.SAMPLE(sides, 500)}; ${NF} m.col().querySelector(".wf-close").click(); const close = await s; return { open, close, props };`);
      console.log(`        motion off, drawer: open ${MO.brief(r.open.col)} / ${MO.brief(r.open.scrim)}, close ${MO.brief(r.close.col)} / ${MO.brief(r.close.scrim)}`);
      if (r.props.length) v.push(`motion off: the drawer animates ${r.props.join(", ")} (opacity only)`);
      v.push(...MO.judge("motion off, drawer open: the panel", r.open.col, { appear: true }), ...MO.judge("motion off, drawer open: the scrim", r.open.scrim, { appear: true }),
        ...MO.judge("motion off, drawer close: the panel", r.close.col, { leave: true }), ...MO.judge("motion off, drawer close: the scrim", r.close.scrim, { leave: true }));
      // docked: closed and opened in place, fading
      await resize(1400, 900); await page(`await m.ensure();`);
      const dk = await page(`let s = ${MO.SAMPLE({ col: ".wf-col" }, 500)}; ${NF} m.tog().click(); const close = await s;
        s = ${MO.SAMPLE({ col: ".wf-col" }, 500)}; ${NF} m.tog().click(); await m.sleep(40); const props = m.col() ? ${MO.OPACITY_ONLY}(m.col()) : null; const open = await s; return { close, open, props };`);
      console.log(`        motion off, docked: close ${MO.brief(dk.close.col)}, open ${MO.brief(dk.open.col)}`);
      if (!dk.props) v.push("motion off: the docked panel didn't open");
      else if (dk.props.length) v.push(`motion off: the docked panel animates ${dk.props.join(", ")} (opacity only)`);
      v.push(...MO.judge("motion off, docked close", dk.close.col, { leave: true }), ...MO.judge("motion off, docked open", dk.open.col, { appear: true }));
      await setMotion(true);
      return v;
    });

    await cell("wf:noGlow", async () => {
      const v = [];
      await page(`m.seg("Anime", "inc").click(); await m.sleep(100);`);
      const bs = () => page(`return [getComputedStyle(m.seg("Anime", "inc")).boxShadow, getComputedStyle(m.tog()).boxShadow];`);
      const glowless = (x) => x === "none" || /0px 0px 0px 0px/.test(x) || /rgba\(0, 0, 0, 0\)/.test(x);
      const on = await bs();
      await setSettings({ glows: false }); await loadUi(); await toWorkshop();
      const off = await bs();
      if (on[0] === "none") v.push("glow on: an included segment has no glow");
      if (on[1] === "none") v.push("glow on: the lit filter toggle has no glow");
      if (!glowless(off[0])) v.push(`Glow effects off: the included segment still glows (${off[0]})`);
      if (!glowless(off[1])) v.push(`Glow effects off: the lit filter toggle still glows (${off[1]})`);
      await setSettings({ glows: true }); await loadUi(); await toWorkshop();
      return v;
    });

    await cell("wf:liveBg", async () => {
      const v = [];
      await setSettings({ liveWallpaperBehindAllTabs: true });
      await loadUi(); await toWorkshop(); await sleep(1200);
      const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return c === "transparent" ? 0 : 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? +p[3] : 1; };
      const r = await page(`const c = m.col(); return { live: document.documentElement.classList.contains("bg-live"), col: getComputedStyle(c).backgroundColor, img: getComputedStyle(c).backgroundImage,
        grp: getComputedStyle(m.grp("genre")).backgroundColor };`);
      console.log(`        ${J(r)}`);
      if (!r.live) v.push("no :root.bg-live with the setting on");
      if (alpha(r.col) > 0.01 || r.img !== "none") v.push(`the docked column has a fill (${r.col}, ${r.img.slice(0, 40)})`);
      if (alpha(r.grp) < 0.3) v.push(`its groups don't carry the darkness (${r.grp})`);
      await shot("liveBg-wide");
      await resize(860, 700);
      await page(`m.tog().click(); await m.sleep(450);`);
      const d = await page(`return getComputedStyle(m.col()).backgroundColor;`);
      if (alpha(d) < 0.6) v.push(`the drawer over the grid has no fill (${d})`);
      await shot("liveBg-drawer");
      await page(`m.col()?.querySelector(".wf-close")?.click(); await m.sleep(300);`);
      await resize(1400, 900);
      await setSettings({ liveWallpaperBehindAllTabs: false });
      await page(`m.q("[data-wf-clear]")?.click();`);
      return v;
    });

    // ---- the groups' emblems: one per group, in its head (never one per tag) ----
    const GICO = { library: "lucide-library", age: "lucide-shield", type: "lucide-layers", resolution: "lucide-monitor", genre: "lucide-palette", features: "lucide-sparkles" };
    const chipSel = (id) => `#wf-panel-browse [data-wf-gico="${id}"]`;
    const expandAll = () => page(`const ids = []; for (const g of m.col().querySelectorAll("[data-wf-group]")) if (g.dataset.wfCollapsed) { ids.push(g.dataset.wfGroup); m.head(g.dataset.wfGroup).click(); }
      await m.sleep(350); return ids;`);
    const recollapse = (ids) => page(`for (const id of ${J(ids)}) if (!m.grp(id)?.dataset.wfCollapsed) m.head(id)?.click(); await m.sleep(300);`);
    // the chip's look per frame (its own transform: rotation, scale) for n frames
    const chipLook = `(el) => { const t = getComputedStyle(el).transform; const mx = new DOMMatrixReadOnly(t === "none" ? undefined : t);
      return { ang: Math.atan2(mx.m12, mx.m11) * 180 / Math.PI, sc: Math.hypot(mx.m11, mx.m12) }; }`;
    const sampleChip = (sel, n) => `new Promise((res) => { const L = ${chipLook}, out = []; const f = () => { const e = document.querySelector(${J(sel)}); out.push(e ? L(e) : null);
      if (out.length >= ${n}) res(out); else requestAnimationFrame(f); }; requestAnimationFrame(f); })`;
    const at = async (sel) => { const r = await page(`const e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: "nearest" }); await m.sleep(80);
      const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };`); if (!r) throw new Error(`no ${sel}`); return r; };
    const mvTo = async (x, y, ms = 0) => { send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); if (ms) await sleep(ms); };
    const outerGlow = (bs) => bs.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => x && x !== "none" && !/inset/.test(x) && !/rgba\(0, 0, 0, 0\)/.test(x) && !/^0px 0px 0px 0px/.test(x.replace(/^rgba?\([^)]*\)\s*/, "")));

    await cell("wf:emblem", async () => {
      const v = [];
      await resize(1400, 900); await toWorkshop(); await page(`m.q("[data-wf-clear]")?.click();`); await mvTo(3, 3, 200);
      const opened = await expandAll();
      try {
        const r = await page(`const c = m.col(), gs = [...c.querySelectorAll("[data-wf-group]")];
          return { groups: gs.map((g) => ({ id: g.dataset.wfGroup, chips: g.querySelectorAll(".wf-gico").length, inHead: !!g.querySelector(".wf-head > .wf-head-btn > .wf-gico"),
              cls: [...(g.querySelector(".wf-gico svg.lucide")?.classList ?? [])] })),
            rows: c.querySelectorAll(".wf-row").length,
            rowIcons: [...c.querySelectorAll(".wf-body svg")].filter((x) => !x.closest(".wf-sw")).length };`);
        console.log(`        ${r.groups.length} groups, ${r.rows} tag rows, ${r.rowIcons} icons in the bodies outside the switches; ${J(r.groups.map((g) => [g.id, g.chips, g.cls.filter((k) => k !== "lucide").join(" ")]))}`);
        if (r.rows < 40) v.push(`only ${r.rows} tag rows shown — proved little`);
        if (r.rowIcons) v.push(`${r.rowIcons} icons on the tag rows besides their switches (an emblem is per group, never per tag)`);
        for (const g of r.groups) {
          if (g.chips !== 1 || !g.inHead) v.push(`${g.id}: ${g.chips} emblem chips${g.inHead ? "" : ", none in its head button"} (want one, in the head)`);
          else if (!GICO[g.id]) v.push(`${g.id}: a group the probe doesn't know — give it a glyph here (${g.cls.join(" ")})`);
          else if (!g.cls.includes(GICO[g.id])) v.push(`${g.id}: the emblem is ${g.cls.join(" ")}, want ${GICO[g.id]}`);
        }
        if (r.groups.length < 6) v.push(`only ${r.groups.length} groups on the Workshop's column (want Library, Age, Type, Resolution, Genre, Features)`);
        // Fit: the chip takes the head's rhythm — the head as tall as a head without one (its name's line, 6 px above and
        // below), the same column width, the button's own gap on both sides, one centre line
        const fit = await page(`const c = m.col(), g = m.grp("genre"), head = g.querySelector(".wf-head"), btn = g.querySelector(".wf-head-btn"), chip = btn.querySelector(".wf-gico"), chev = btn.querySelector(".wf-chev");
          if (!chip) return null; const tn = [...btn.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
          const nr = document.createRange(); nr.selectNodeContents(tn); const N = nr.getBoundingClientRect(), C = chip.getBoundingClientRect(), V = chev.getBoundingClientRect();
          const out = { head: head.getBoundingClientRect().height, col: c.getBoundingClientRect().width, gapA: C.left - V.right, gapB: N.left - C.right,
            cy: C.top + C.height / 2, ny: N.top + N.height / 2, vy: V.top + V.height / 2, chip: [C.width, C.height], btnGap: parseFloat(getComputedStyle(btn).columnGap) };
          const st = document.createElement("style"); st.textContent = ".wf-gico { display: none !important; } .wf-head-btn { padding-block: 6px !important; }"; document.head.append(st); ${NF}
          out.headBare = head.getBoundingClientRect().height; out.colBare = c.getBoundingClientRect().width; st.remove(); ${NF} return out;`);
        console.log(`        fit: ${J(fit)}`);
        if (!fit) return [...v, "no emblem in Genre's head to fit"];
        if (Math.abs(fit.head - fit.headBare) > 0.5) v.push(`the emblem changes the head's height (${fit.headBare} → ${fit.head} px)`);
        if (Math.abs(fit.col - fit.colBare) > 0.5) v.push(`the emblem changes the column's width (${fit.colBare} → ${fit.col} px)`);
        if (Math.abs(fit.gapA - fit.btnGap) > 0.5 || Math.abs(fit.gapB - fit.btnGap) > 0.5) v.push(`chevron → chip → name gaps ${fit.gapA.toFixed(1)} / ${fit.gapB.toFixed(1)} px, not the head's ${fit.btnGap} px`);
        if (Math.abs(fit.cy - fit.ny) > 0.5 || Math.abs(fit.cy - fit.vy) > 0.5) v.push(`the chip's centre line (${fit.cy.toFixed(1)}) isn't the name's (${fit.ny.toFixed(1)}) / the chevron's (${fit.vy.toFixed(1)})`);
        if (fit.chip.some((x) => x !== Math.round(x))) v.push(`a fractional chip size ${J(fit.chip)} (whole pixels centre the glyph)`);
        const glow = await page(`return getComputedStyle(document.querySelector(${J(chipSel("genre"))})).boxShadow;`);
        if (!outerGlow(glow).length) v.push(`glow on: the chip has no glow (${glow})`);
        const col = await page(`const b = m.col().getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };`);
        const clip = { x: Math.floor(col.x), y: Math.floor(col.y), width: Math.ceil(col.w), height: Math.min(Math.ceil(col.h), 520) };
        fs.writeFileSync(path.join(OUT, "wf-emblem.png"), (await win.webContents.capturePage(clip)).toPNG());
        // hovering the group (a tag row, not the head): the chip tilts on the spring and holds it; its glyph stays put in it
        const row = await at(`#wf-panel-browse [data-wf-group="genre"] .wf-row .wf-name`);
        await mvTo(3, 3, 400);
        await page(`window.__smp = ${sampleChip(chipSel("genre"), 60)}; true`);
        await mvTo(row.x, row.y);
        const ch = await page(`const a = []; for (let i = 0; i < 4; i++) { await m.sleep(55); const b = document.querySelector(${J(chipSel("genre"))}).getBoundingClientRect();
          a.push({ x: Math.floor(b.x) - 8, y: Math.floor(b.y) - 8, width: Math.ceil(b.width) + 16, height: Math.ceil(b.height) + 16 }); } return a[0];`);
        for (let i = 0; i < 4; i++) { const img = await win.webContents.capturePage(ch); fs.writeFileSync(path.join(OUT, `wf-emblem-tilt-${i}.png`), img.resize({ width: img.getSize().width * 6 }).toPNG()); await sleep(60); }
        const smp = (await js(`window.__smp`)).filter(Boolean), angs = smp.map((x) => x.ang), held = angs[angs.length - 1];
        const peak = angs.reduce((a, x) => (Math.abs(x) > Math.abs(a) ? x : a), 0), between = angs.filter((x) => Math.abs(x) > 0.3 && Math.abs(x - held) > 0.3).length;
        console.log(`        hover tilt: held ${held.toFixed(2)}°, peak ${peak.toFixed(2)}°, ${between} in-between frames`);
        if (Math.abs(held) < 4) v.push(`hovering the group doesn't tilt its emblem (held ${held.toFixed(2)}°)`);
        else { if (between < 3) v.push(`the tilt jumps (${between} in-between frames)`); if (!(Math.abs(peak) > Math.abs(held) + 0.3)) v.push(`no spring: the tilt never passes its held ${held.toFixed(2)}°`); }
        // the head button hovered: the glyph neither acts (Features' sparkles have a one-shot elsewhere) nor tilts on its own
        for (const id of ["genre", "features"]) {
          const h = await at(`#wf-panel-browse [data-wf-head="${id}"]`); await mvTo(3, 3, 300); await mvTo(h.x, h.y, 120);
          const g = await page(`const s = document.querySelector(${J(chipSel(id) + " > svg")}); await m.sleep(500); const t = getComputedStyle(s).transform;
            return { anims: s.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSTransition)).length, t, act: s.hasAttribute("data-act") };`);
          if (g.anims || g.act) v.push(`${id}: the emblem's glyph acts on hover (${g.anims} one-shots${g.act ? ", data-act" : ""}) — it's an object`);
          if (g.t !== "none" && !new DOMMatrixReadOnly(g.t).isIdentity) v.push(`${id}: the emblem's glyph tilts inside its tilting chip (${g.t})`);
        }
        await mvTo(3, 3, 300);
      } finally { await recollapse(opened); }
      return v;
    });

    await cell("wf:emblem:look", async () => {
      const v = [];
      const chip = chipSel("genre");
      const hoverBs = async () => { const r = await at(`#wf-panel-browse [data-wf-group="genre"] .wf-row .wf-name`); await mvTo(3, 3, 300);
        const rest = await page(`return getComputedStyle(document.querySelector(${J(chip)})).boxShadow;`); await mvTo(r.x, r.y, 800);
        const hov = await page(`return getComputedStyle(document.querySelector(${J(chip)})).boxShadow;`); await mvTo(3, 3, 300); return { rest, hov }; };
      const shotCol = async (name) => { const c = await page(`m.col().querySelector(".wf-scroll").scrollTop = 0; await m.sleep(150); const b = m.col().getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };`);
        fs.writeFileSync(path.join(OUT, `wf-emblem-${name}.png`), (await win.webContents.capturePage({ x: Math.floor(c.x), y: Math.floor(c.y), width: Math.ceil(c.w), height: Math.min(Math.ceil(c.h), 520) })).toPNG()); };
      try {
        await setSettings({ glows: false }); await loadUi(); await resize(1400, 900); await toWorkshop();
        const ng = await hoverBs();
        console.log(`        no-glow: rest ${ng.rest} / hovered ${ng.hov}`);
        if (outerGlow(ng.rest).length || outerGlow(ng.hov).length) v.push(`Glow effects off: the chip still glows (${ng.rest} / hovered ${ng.hov})`);
        if (!/inset/.test(ng.rest)) v.push(`Glow effects off: the chip lost its ring (${ng.rest})`);
        await shotCol("noglow");
        await setSettings({ glows: true, liveWallpaperBehindAllTabs: true }); await loadUi(); await toWorkshop(); await sleep(1000);
        const bl = await page(`const e = document.querySelector(${J(chip)}); return { live: document.documentElement.classList.contains("bg-live"), bg: getComputedStyle(e).backgroundColor,
          grp: getComputedStyle(m.grp("genre")).backgroundColor, vis: e.checkVisibility() };`);
        console.log(`        bg-live: ${J(bl)}`);
        if (!bl.live) v.push("bg-live: no :root.bg-live with the setting on");
        if (!bl.vis || /rgba\(0, 0, 0, 0\)|transparent/.test(bl.bg)) v.push(`bg-live: the chip isn't drawn (${bl.bg})`);
        await shotCol("bglive");
        await setSettings({ liveWallpaperBehindAllTabs: false }); await loadUi(); await toWorkshop();
        // motion off: a hovered group's chip stays where it is (no tilt, no transition frames)
        await setMotion(false);
        const r = await at(`#wf-panel-browse [data-wf-group="genre"] .wf-row .wf-name`); await mvTo(3, 3, 300);
        await page(`window.__mo = ${MO.SAMPLE({ chip }, 700)}; true`); await mvTo(r.x, r.y);
        const off = await js(`window.__mo`), held = await page(`return getComputedStyle(document.querySelector(${J(chip)})).transform;`);
        console.log(`        motion off: ${MO.brief(off.chip)}; transform hovered ${held}`);
        v.push(...MO.judge("motion off: the hovered group's emblem", off.chip));
        if (held !== "none" && !new DOMMatrixReadOnly(held).isIdentity) v.push(`motion off: the hovered group's emblem tilts (${held})`);
        await mvTo(3, 3, 200);
      } finally { await setSettings({ glows: true, liveWallpaperBehindAllTabs: false }); await setMotion(true); await loadUi(); await resize(1400, 900); await toWorkshop(); }
      return v;
    });

    // Whole-pixel sizes and even margins (the layout), then the glyph's drawn pixels on the chip's (pixel-centre.js) at the
    // window's own device pixel ratio: ±0.5 css px at a whole ratio; at a fractional one (the matrix's Xvfb draws at ~1.05) the
    // glyph's and the chip's edges round to device pixels each on their own, so one device pixel is the resolution there
    await cell("wf:emblem:centre", async () => {
      const v = [];
      try {
        for (const [w, h] of [[1400, 900], [1920, 1080]]) {
          await resize(w, h); await toWorkshop(); await mvTo(3, 3, 300);
          const dpr = await js("devicePixelRatio"), tag = `${w}x${h}@${+dpr.toFixed(3)}`, tol = PXC.tolerance(null, dpr);
          const lay = await page(`return [...m.col().querySelectorAll("[data-wf-gico]")].map((e) => { const c = e.getBoundingClientRect(), g = e.querySelector("svg").getBoundingClientRect();
            return { id: e.dataset.wfGico, cw: c.width, ch: c.height, gw: g.width, gh: g.height, dx: g.x + g.width / 2 - (c.x + c.width / 2), dy: g.y + g.height / 2 - (c.y + c.height / 2) }; });`);
          if (lay.length < 6) v.push(`${tag}: only ${lay.length} emblems — proved little`);
          for (const l of lay) {
            if (![l.cw, l.ch, l.gw, l.gh].every(Number.isInteger) || (l.cw - l.gw) % 2 || (l.ch - l.gh) % 2 || Math.abs(l.dx) > 0.01 || Math.abs(l.dy) > 0.01)
              v.push(`${tag} ${l.id}: chip ${l.cw}×${l.ch}, glyph ${l.gw}×${l.gh} at (${l.dx.toFixed(2)}, ${l.dy.toFixed(2)}) — want whole pixels, even margins, centred`);
          }
          for (const { id } of lay) {
            await page(`document.querySelector(${J(chipSel(id))}).scrollIntoView({ block: "center" }); await m.sleep(250); true`);
            // against the ring and fill: the outer glow is symmetric but soft (and off at once: its box-shadow transition would
            // still be running between the captures); the hover tilt isn't on (the pointer is away)
            const r = await PXC.measure(win, { chip: chipSel(id), glyph: `${chipSel(id)} > svg`, css: `${chipSel(id)} { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent) !important; transition: none !important; }`,
              png: path.join(OUT, `wf-emblem-px-${id}-${w}.png`) });
            console.log(`        ${tag} ${id}: ${r.error ?? `(${r.dx.toFixed(2)}, ${r.dy.toFixed(2)}) css px, glyph ${r.glyphPx} px, chip ${r.chipPx} px`} (±${tol.toFixed(2)})`);
            // a chip drawn a row or column short at a fractional ratio moves its own measured centre (PXC.tolerance); at ratio 1
            // (the agent window) every emblem measures exactly centred
            v.push(...PXC.judge(`${tag} ${id}`, r, PXC.tolerance(r, dpr)));
          }
          await page(`m.col().querySelector(".wf-scroll").scrollTop = 0; true`);
        }
      } finally { await resize(1400, 900); }
      return v;
    });

    // the docked column (and the item sidebar beside it) takes columns, not card size (hooks/useGridFit.ts)
    for (const [w, h] of [[1920, 1080], [1100, 700]]) {
      await cell(`wf:cardSize:${w}x${h}`, async () => {
        const v = [];
        await resize(w, h); await toWorkshop();
        send({ type: "mouseMove", x: 2, y: 2 }); await sleep(300);
        const geo = () => page(`const s = m.q(".scroll"), cs = getComputedStyle(s), sb = s.getBoundingClientRect();
          const cards = [...s.querySelectorAll(".grid > .card")].slice(0, 80).filter((c) => c.offsetWidth > 0);
          if (!cards.length) return null;
          const row = cards.filter((c) => Math.abs(c.offsetTop - cards[0].offsetTop) < 2).map((c) => c.getBoundingClientRect());
          const L = sb.left + s.clientLeft, R = L + s.clientWidth;
          return { w: row[0].width, cols: row.length, lgap: row[0].left - L, rgap: R - row[row.length - 1].right,
            gap: parseFloat(cs.getPropertyValue("--gap")) || 14, ml: parseFloat(cs.marginLeft), mr: parseFloat(cs.marginRight),
            cw: s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };`);
        const show = (g) => `${g.cols} × ${g.w.toFixed(1)} px (margins ${g.ml}/${g.mr}, edge gaps ${g.lgap.toFixed(1)}/${g.rgap.toFixed(1)})`;
        // within 5 %, or — where no whole column count gets that close (a narrow grid: 1fr columns, each count's width a step
        // apart) — the closest count's
        const same = (what, g0, g1) => {
          let best = Infinity;
          for (let c = 1; c <= 60; c++) { const x = (g1.cw - (c - 1) * g1.gap) / c; if (x <= 0) break; best = Math.min(best, Math.abs(x / g0.w - 1)); }
          const d = g1.w / g0.w - 1, tol = Math.max(0.05, best + 0.002);
          if (tol > 0.05) console.log(`        ${what}: no column count within ±5 % in a ${g1.cw.toFixed(0)} px grid — the closest is ${(best * 100).toFixed(1)} % off`);
          if (Math.abs(d) > tol) v.push(`${what}: cards ${g0.w.toFixed(1)} → ${g1.w.toFixed(1)} px (${(d * 100).toFixed(1)} %, within ±${(tol * 100).toFixed(1)} %) — ${g0.cols} → ${g1.cols} columns`);
          if (Math.max(g1.lgap, g1.rgap) > g1.gap + 1) v.push(`${what}: an edge gap of ${Math.max(g1.lgap, g1.rgap).toFixed(1)} px beside the row (≤ the ${g1.gap} px gap)`);
        };
        await page(`await m.open(true); await m.sleep(250);`);
        const gCol = await geo();
        if (!gCol || !(gCol.mr > 0)) return [`no docked panel at ${w}×${h} (grid margin-right ${gCol?.mr}) — proved nothing`];
        await page(`await m.open(false); await m.sleep(250);`);
        const g0 = await geo();
        if (!g0 || g0.mr > 1) return [`closing the panel left the grid ${g0 ? `a ${g0.mr} px margin` : "empty"} — proved nothing`];
        await page(`m.q(".scroll:not(.lib-scroll) .card .thumb-wrap")?.click(); await m.sleep(800);`);
        const gSide = await geo();
        await page(`m.q(".side-panel [data-side-close]")?.click(); await m.sleep(600); await m.open(true);`);
        console.log(`        no panel ${show(g0)}; filter panel ${show(gCol)}; item sidebar ${show(gSide)}`);
        if (Math.max(g0.lgap, g0.rgap) > g0.gap + 1) v.push(`no panel: an edge gap of ${Math.max(g0.lgap, g0.rgap).toFixed(1)} px beside the row`);
        same("filter panel", g0, gCol);
        if (!(gSide?.mr > 0)) v.push(`the item sidebar didn't dock (margin-right ${gSide?.mr})`);
        else same("item sidebar", g0, gSide);
        return v;
      });
    }
    await resize(1400, 900);

    // ---- the local filters ----
    // the stack's scenes get Wallpaper Engine metadata in their project.json (what an auto-imported item knows): s1 Everyone,
    // Anime, approved + audio responsive; s2 Mature, Nature; s3 Anime, no age rating. k1-k4 are imported videos: no tags.
    let libReady = false;
    const libSetup = async () => {
      if (libReady) return;
      const lib = path.join(E.XDG_DATA_HOME, "liascape", "library", "workshop");
      const tag = (id, patch) => { const f = path.join(lib, id, "project.json"); const j = JSON.parse(fs.readFileSync(f, "utf8"));
        fs.writeFileSync(f, JSON.stringify({ ...j, ...patch, general: { ...j.general, ...(patch.general ?? {}) } })); };
      tag("900000001", { contentrating: "Everyone", tags: ["Anime"], approved: true, general: { supportsaudioprocessing: true } });
      tag("900000002", { contentrating: "Mature", tags: ["Nature"] });
      tag("900000003", { tags: ["anime"] }); // WE's own spelling varies: matched case-blind
      await loadUi(); await tab("Library"); await sleep(600);
      libReady = true;
    };
    const libTitles = () => page(`return m.qa(".lib-scroll .card .lib-title[data-title]").map((e) => e.dataset.title).sort();`);
    const libSeg = (tag, st) => page(`await m.ensure(); const r = [...(m.q('.wf-col[data-wf-page="library"]:not(.closing)')?.querySelectorAll(".wf-row") ?? [])].find((x) => x.dataset.wfTag === ${J(tag)});
      if (!r) return false; r.querySelector('[data-seg="${st}"]').click(); await m.sleep(250); return true;`);
    // open the Features group (collapsed by default, and the collapse is shared with Browse's column) → its rows
    const libFeatures = () => page(`await m.ensure(); const h = m.q('.wf-col[data-wf-page="library"] [data-wf-head="features"]');
      if (h?.getAttribute("aria-expanded") === "false") { h.click(); await m.sleep(200); }
      return [...(m.q('.wf-col[data-wf-page="library"] [data-wf-group="features"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag);`);
    const libClear = () => page(`m.q('.wf-col[data-wf-page="library"] [data-wf-clear]')?.click(); await m.sleep(250);`);

    await cell("lib:column", async () => {
      const v = [];
      await libSetup();
      const r = await page(`await m.ensure(); const c = m.q('.wf-col[data-wf-page="library"]:not(.closing)'); if (!c) return null;
        const sc = m.q(".lib-scroll"), bar = m.q(".playlist-bar"), grid = sc.querySelector(".grid");
        const rows = (g) => [...(c.querySelector('[data-wf-group="' + g + '"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag);
        return { mode: c.dataset.mode, scope: c.dataset.wfScope, c: m.rect(c), grid: m.rect(grid), bar: bar ? m.rect(bar) : null,
          groups: [...c.querySelectorAll("[data-wf-group]")].map((g) => g.dataset.wfGroup), age: rows("age"), type: rows("type"), genre: rows("genre"),
          res: rows("resolution"), row: !!sc.querySelector(".wfilter"), W: innerWidth, label: c.getAttribute("aria-label"),
          cards: m.qa(".lib-scroll .card").length };`);
      if (!r) return ["no filter column on the Library"];
      console.log(`        ${J(r)}`);
      if (r.mode !== "dock" || r.scope !== "library") v.push(`the Library's column is ${r.mode} / ${r.scope}`);
      if (Math.abs(r.c.r - r.W) > 0.5 || r.c.w < 200) v.push(`the column spans ${r.c.x}–${r.c.r}, ${r.c.w} px wide (want the right edge of ${r.W})`);
      if (r.grid.r > r.c.x + 1) v.push(`the grid ends at ${r.grid.r}, under the column (its left edge ${r.c.x})`);
      if (!r.bar) v.push("no playlist bar");
      else {
        if (r.c.b > r.bar.y + 1) v.push(`the column runs into the playlist bar (column bottom ${r.c.b}, bar top ${r.bar.y})`);
        if (r.bar.x > 0.5) v.push(`the playlist bar starts at x ${r.bar.x} (want its full width)`);
      }
      if (J(r.groups) !== J(["age", "type", "resolution", "genre", "features"])) v.push(`groups ${J(r.groups)} (want age, type, resolution, genre, features)`);
      if (J(r.age) !== J(["Everyone", "Mature"])) v.push(`age rows ${J(r.age)} (want what the items know: Everyone, Mature)`);
      if (J(r.res) !== J(["Standard Definition"])) v.push(`resolution rows ${J(r.res)} (want k1-k4's: Standard Definition)`);
      if (J(r.type) !== J(["Video", "Scene"])) v.push(`type rows ${J(r.type)}`);
      if (J(r.genre) !== J(["Anime", "Nature"])) v.push(`genre rows ${J(r.genre)}`);
      if (r.row) v.push("a sort / filter row above the Library's grid");
      if (r.label !== "Library filters") v.push(`aria-label ${r.label}`);
      // Features (collapsed by default, shared with Browse): open it, read, close it again
      const feat = await libFeatures();
      if (J(feat) !== J(["Approved", "Audio responsive"])) v.push(`feature rows ${J(feat)} (want Approved, Audio responsive)`);
      await shot("lib-wide");
      return v;
    });

    await cell("lib:filter", async () => {
      const v = [];
      await libSetup();
      const all = await libTitles();
      if (all.length !== 7) return [`${all.length} library cards (want the stack's 7) — proved nothing`];
      const n0 = await page(`return window.__browse.length + window.__more.length;`);
      const steps = [
        [["Scene", "inc"]], ["s1", "s2", "s3"],
        [["Scene", "exc"]], ["k1", "k2", "k3", "k4"],
        [["Scene", "off"], ["Everyone", "inc"]], ["s1"],            // untagged items out under an age filter
        [["Everyone", "exc"]], ["s2"],                              // ages minus Everyone: Mature only, untagged still out
        [["Everyone", "off"], ["Anime", "inc"]], ["s1", "s3"],
        [["Nature", "inc"]], ["s1", "s2", "s3"],                     // genres: any
      ];
      for (let i = 0; i < steps.length; i += 2) {
        for (const [t, st] of steps[i]) if (!(await libSeg(t, st))) v.push(`no ${t} row in the Library's column`);
        const got = await libTitles();
        if (J(got) !== J(steps[i + 1])) v.push(`${steps[i].map((x) => x.join(":")).join(" + ")} → ${J(got)} (want ${J(steps[i + 1])})`);
      }
      await page(`m.q('.wf-col[data-wf-page="library"] [data-wf-group="genre"] [data-fm="all"]').click(); await m.sleep(250);`);
      const none = await page(`return { cards: m.qa(".lib-scroll .card").length, msg: !!m.q(".lib-scroll [data-wf-none]") };`);
      if (none.cards || !none.msg) v.push(`Anime AND Nature: ${none.cards} cards, message ${none.msg} (want none + "No wallpapers match")`);
      await shot("lib-none");
      await page(`m.q(".lib-scroll [data-wf-none] button")?.click(); await m.sleep(300);`);
      if ((await libTitles()).length !== 7) v.push("Clear filters didn't bring every card back");
      await page(`m.q('.wf-col[data-wf-page="library"] [data-wf-group="genre"] [data-fm="any"]').click(); await m.sleep(150);`);
      // features: all of them (the default)
      await libFeatures();
      for (const t of ["Approved", "Audio responsive"]) if (!(await libSeg(t, "inc"))) v.push(`no ${t} row in the Library's column`);
      if (J(await libTitles()) !== J(["s1"])) v.push(`Approved + Audio responsive → ${J(await libTitles())} (want s1)`);
      await libClear();
      const n1 = await page(`return window.__browse.length + window.__more.length;`);
      if (n1 !== n0) v.push(`${n1 - n0} /browse request(s) for the Library's filter (want none)`);
      return v;
    });

    await cell("lib:scope", async () => {
      const v = [];
      await libSetup(); await tab("Library");
      await libSeg("Anime", "inc");
      await toWorkshop();
      const ws = await page(`return { on: m.col() ? m.col().querySelectorAll('.wf-row:not([data-state="off"])').length : -1, scope: m.col()?.dataset.wfScope };`);
      if (ws.scope !== "workshop" || ws.on !== 0) v.push(`the Workshop's column: scope ${ws.scope}, ${ws.on} tags on (want workshop, 0 — the Library's Anime leaked)`);
      const n0 = await page(`return window.__browse.length;`);
      await page(`m.seg("Nature", "inc").click();`);
      const b = await page(`return await m.settle(${n0});`);
      if (!b) v.push("no Workshop request after including Nature");
      else if (!sameSet(b.filter.include, ["Nature"]) || b.filter.exclude.length) v.push(`the Workshop POSTed ${J(b.filter)} (want include [Nature])`);
      await tab("Library");
      const lib = await page(`const c = m.q('.wf-col[data-wf-page="library"]'); return { on: [...c.querySelectorAll('.wf-row:not([data-state="off"])')].map((x) => x.dataset.wfTag),
        ls: [JSON.parse(localStorage.getItem("liascape.libFilter"))?.include, JSON.parse(localStorage.getItem("liascape.browseFilter"))?.include] };`);
      if (J(lib.on) !== J(["Anime"])) v.push(`the Library's column has ${J(lib.on)} on (want Anime — the Workshop's Nature leaked)`);
      if (J(lib.ls) !== J([["Anime"], ["Nature"]])) v.push(`saved: library ${J(lib.ls[0])}, workshop ${J(lib.ls[1])}`);
      await loadUi(); await tab("Library");
      if (J(await libTitles()) !== J(["s1", "s3"])) v.push(`after a reload the Library shows ${J(await libTitles())} (want its kept Anime filter: s1, s3)`);
      await libClear(); await toWorkshop(); await page(`m.q("[data-wf-clear]")?.click(); await m.sleep(500);`); await tab("Library");
      return v;
    });

    await cell("lib:fold", async () => {
      const v = [];
      await libSetup(); await tab("Library"); await page(`await m.ensure();`);
      const st = () => page(`const sc = m.q(".lib-scroll"); return { col: !!m.q('.wf-col[data-wf-page="library"][data-mode=dock]:not(.closing)'),
        open: m.isOpen(), mr: parseFloat(getComputedStyle(sc).marginRight), gridTop: sc.querySelector(".grid").getBoundingClientRect().top };`);
      const s0 = await st();
      if (!s0.col || !s0.open) return [`open: column ${s0.col}, toggle ${s0.open} — proved nothing`];
      const f = await page(`m.tog().click(); await m.sleep(60); const c = m.q('.wf-col[data-wf-page="library"]');
        return { closing: !!c?.classList.contains("closing"), anims: c ? c.getAnimations().length : 0 };`);
      if (!f.closing || !f.anims) v.push(`closing the Library's panel: closing ${f.closing}, ${f.anims} animation(s) (want it sliding out)`);
      await sleep(500);
      const s1 = await st();
      if (s1.col || s1.open || s1.mr > 1) v.push(`closed: column ${s1.col}, toggle ${s1.open}, grid margin ${s1.mr}`);
      if (Math.abs(s1.gridTop - s0.gridTop) > 1) v.push(`closing moved the grid ${s0.gridTop} → ${s1.gridTop}`);
      await toWorkshop(false);
      if (!(await page(`return !!m.q('.wf-col[data-wf-page="browse"][data-mode=dock]:not(.closing)');`))) v.push("closing the Library's panel closed Browse's too");
      if (await page(`return parseFloat(getComputedStyle(m.q(".scroll")).marginRight) < 1;`)) v.push("Browse's grid lost its margin beside its panel");
      await loadUi(); await tab("Library");
      if ((await st()).col) v.push("the Library's closed panel isn't remembered over a reload");
      await shot("lib-folded");
      // motion off: opens in place, fading (opacity only)
      await setMotion(false); await tab("Library");
      const off = await page(`const s = ${MO.SAMPLE({ col: '.wf-col[data-wf-page="library"]' }, 500)}; ${NF} m.tog().click(); await m.sleep(40);
        const c = m.q('.wf-col[data-wf-page="library"]'); return { props: c ? ${MO.OPACITY_ONLY}(c) : null, fr: await s };`);
      if (!off.props) v.push("motion off: the toggle didn't open the panel");
      else if (off.props.length) v.push(`motion off: the panel animates ${off.props.join(", ")} (opacity only)`);
      v.push(...MO.judge("motion off, open", off.fr.col, { appear: true }));
      await setMotion(true); await tab("Library");
      if (!(await st()).col) v.push("the Library's panel isn't back after opening it");
      return v;
    });

    await cell("lib:drawer", async () => {
      const v = [];
      await libSetup(); await resize(860, 700); await tab("Library");
      if (await page(`return !!m.q('.wf-col[data-wf-page="library"]');`)) v.push("at 860 px the Library's column is still docked");
      const opened = await page(`const p = m.tog(); if (!p) return null; p.click(); await m.sleep(450);
        const c = m.q('.wf-col[data-wf-page="library"]'); return c ? { mode: c.dataset.mode, r: m.rect(c), scrim: !!m.q(".wf-scrim") } : false;`);
      if (opened === null) return [...v, "no filter toggle in the Library's top bar at 860 px"];
      if (!opened || opened.mode !== "drawer" || !opened.scrim) v.push(`the toggle opened ${J(opened)} (want the drawer + scrim)`);
      else {
        await page(`const r = [...m.col().querySelectorAll(".wf-row")].find((x) => x.dataset.wfTag === "Scene"); r?.querySelector('[data-seg="inc"]').click(); await m.sleep(250);`);
        if (J(await libTitles()) !== J(["s1", "s2", "s3"])) v.push(`a switch in the drawer: ${J(await libTitles())}`);
        await shot("lib-drawer");
        await page(`m.col()?.querySelector("[data-wf-clear]")?.click(); await m.sleep(250); document.activeElement?.blur();`);
        send({ type: "keyDown", keyCode: "Escape" }); send({ type: "keyUp", keyCode: "Escape" }); await sleep(400);
        if (await page(`return !!m.q('.wf-col[data-wf-page="library"]');`)) v.push("Escape didn't close the drawer");
        await page(`m.tog().click(); await m.sleep(400);`);
        await tab("Settings"); await tab("Library");
        if (await page(`return !!m.q('.wf-col[data-wf-page="library"]');`)) v.push("the drawer is still open after a tab visit");
      }
      await resize(1400, 900); await libClear();
      return v;
    });

    await cell("local:weFolder", async () => {
      const v = [];
      const s0 = (await http("GET", "/settings")).json;
      // a fake Wallpaper Engine folder: four videos with project.json metadata (900000001 = the stack's s1: "in library")
      const we = path.join(E.XDG_CACHE_HOME || path.join(OUT, ".cache"), "liascape", "fake-we");
      const items = [["920000001", "we-a", "Everyone", ["Anime"], true], ["920000002", "we-b", "Questionable", ["Game"], false],
        ["920000003", "we-c", null, ["Anime", "Music"], false], ["900000001", "we-own", "Everyone", ["Nature"], false]];
      items.forEach(([id, title, age, tags, approved], i) => {
        const d = path.join(we, id); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ type: "video", file: "v.mp4", title, preview: "preview.jpg", tags,
          ...(age ? { contentrating: age } : {}), ...(approved ? { approved: true } : {}), general: { properties: {} } }));
        fs.writeFileSync(path.join(d, "v.mp4"), ""); fs.copyFileSync(THUMBS[i % THUMBS.length], path.join(d, "preview.jpg"));
      });
      await setSettings({ workshopFolder: we });
      try {
        const src = (await http("GET", "/sources")).json.find((x) => x.supportsLocalFilter);
        if (!src) return ["no source with supportsLocalFilter in /sources"];
        await tab("Browse"); await source(src.name); await sleep(800); await page(`await m.ensure();`);
        const titles = () => page(`return m.qa(".scroll:not(.lib-scroll) .card .lib-title[data-title]").map((e) => e.dataset.title).sort();`);
        const all = await titles();
        if (all.length !== 4) return [`${J(all)} on ${src.name} (want the fake folder's 4) — proved nothing`];
        const r = await page(`const c = m.col(); if (!c) return null; const rows = (g) => [...(c.querySelector('[data-wf-group="' + g + '"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag);
          return { scope: c.dataset.wfScope, mode: c.dataset.mode, groups: [...c.querySelectorAll("[data-wf-group]")].map((g) => g.dataset.wfGroup),
            age: rows("age"), type: rows("type"), genre: rows("genre"), row: !!m.q(".wfilter"), tog: !!m.tog(), sorts: m.qa(".topbar .sel").length,
            sort: (await m.sortOpts())?.[0] ?? null };`);
        if (!r) return [`no filter column on ${src.name}`];
        console.log(`        ${J(r)}`);
        if (r.scope !== "weLocal" || r.mode !== "dock") v.push(`column ${r.scope} / ${r.mode}`);
        if (J(r.groups) !== J(["library", "age", "type", "genre", "features"])) v.push(`groups ${J(r.groups)}`);
        if (J(r.age) !== J(["Everyone", "Questionable"]) || J(r.type) !== J(["Video"]) || J(r.genre) !== J(["Anime", "Game", "Music", "Nature"]))
          v.push(`rows age ${J(r.age)}, type ${J(r.type)}, genre ${J(r.genre)}`);
        if (r.row) v.push("a sort / filter row above the WE folder's grid");
        if (!r.tog || r.sorts !== 1 || r.sort !== "Default") v.push(`the WE folder's split: toggle ${r.tog}, ${r.sorts} select(s), menu starting "${r.sort}" (want its client sort)`);
        const n0 = await page(`return window.__browse.length + window.__more.length;`);
        const steps = [[["Anime", "inc"]], ["we-a", "we-c"], [["Everyone", "inc"]], ["we-a"], [["Everyone", "off"], ["Anime", "off"], ["Questionable", "exc"]], ["we-a", "we-own"],
          [["Questionable", "off"], ["@library", "inc"]], ["we-own"], [["@library", "exc"]], ["we-a", "we-b", "we-c"]];
        for (let i = 0; i < steps.length; i += 2) {
          for (const [t, st] of steps[i]) { const ok = await page(`const s = m.seg(${J(t)}, ${J(st)}); if (!s) return false; s.click(); await m.sleep(250); return true;`); if (!ok) v.push(`no ${t} row`); }
          const got = await titles();
          if (J(got) !== J(steps[i + 1])) v.push(`${steps[i].map((x) => x.join(":")).join(" + ")} → ${J(got)} (want ${J(steps[i + 1])})`);
        }
        await shot("local-we");
        const ls = await page(`return [JSON.parse(localStorage.getItem("liascape.weLocalFilter"))?.exclude, JSON.parse(localStorage.getItem("liascape.browseFilter"))?.exclude ?? []];`);
        if (J(ls) !== J([["@library"], []])) v.push(`saved: WE folder ${J(ls[0])}, Workshop ${J(ls[1])}`);
        const n1 = await page(`return window.__browse.length + window.__more.length;`);
        if (n1 !== n0) v.push(`${n1 - n0} filtered /browse request(s) for the WE folder (want none)`);
        await page(`m.q("[data-wf-clear]")?.click(); await m.sleep(300);`);
        if ((await titles()).length !== 4) v.push("Clear all didn't bring every card back");
      } finally {
        await setSettings({ workshopFolder: s0.workshopFolder });
        await toWorkshop();
      }
      return v;
    });

    await cell("lib:steamTags", async () => {
      const v = [];
      await libSetup(); await tab("Library");
      const s0 = (await http("GET", "/settings")).json;
      const ID = "930000001";
      // the column's rows of one group
      const rows = (g) => page(`await m.ensure(); const c = m.q('.wf-col[data-wf-page="library"]:not(.closing)');
        return [...(c?.querySelector('[data-wf-group="${g}"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag);`);
      const before = { res: await rows("resolution"), age: await rows("age") };
      if (before.res.includes("3840 x 2160") || before.age.includes("Questionable")) return [`before the import the column has ${J(before)} — proved nothing`];
      // what Steam's servers answer for it (the stack's fixture) — its project.json knows only its genre
      const fx = E.LIASCAPE_STEAM_CM_FIXTURE;
      if (!fx) return ["no LIASCAPE_STEAM_CM_FIXTURE in the probe's environment"];
      fs.writeFileSync(fx + ".tmp", JSON.stringify({ [ID]: { tags: ["Video", "Questionable", "3840 x 2160", "Retro"] } })); fs.renameSync(fx + ".tmp", fx);
      const we = path.join(E.XDG_CACHE_HOME || path.join(OUT, ".cache"), "liascape", "steam-tags-we"), d = path.join(we, ID);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ type: "video", file: "v.mp4", title: "st-a", preview: "preview.jpg", tags: ["Retro"] }));
      fs.writeFileSync(path.join(d, "v.mp4"), ""); fs.copyFileSync(THUMBS[0], path.join(d, "preview.jpg"));
      const logLen = fs.existsSync(E.LIASCAPE_BACKEND_LOG) ? fs.statSync(E.LIASCAPE_BACKEND_LOG).size : 0;
      await setSettings({ workshopFolder: we });
      let item = null;
      try {
        const added = (await post("/library/sync")).json?.added ?? [];
        if (!added.some((p) => p.includes(`/${ID}/`))) return [...v, `/library/sync added ${J(added)} (want ${ID}) — proved nothing`];
        let after = null;
        for (let i = 0; i < 40; i++) {
          await sleep(250);
          after = { res: await rows("resolution"), age: await rows("age"), genre: await rows("genre") };
          if (after.res.includes("3840 x 2160") && after.age.includes("Questionable")) break;
        }
        console.log(`        before ${J(before)}; after ${J(after)}`);
        if (!after.res.includes("3840 x 2160")) v.push(`resolution rows ${J(after.res)} (want 3840 x 2160 from Steam's tags)`);
        if (!after.age.includes("Questionable")) v.push(`age rows ${J(after.age)} (want Questionable from Steam's tags)`);
        if (!after.genre.includes("Retro")) v.push(`genre rows ${J(after.genre)} (want Retro)`);
        await libSeg("3840 x 2160", "inc");
        if (J(await libTitles()) !== J(["st-a"])) v.push(`3840 x 2160 → ${J(await libTitles())} (want st-a)`);
        await shot("lib-steam-tags");
        await libClear();
        // the look-up asked Steam about the new arrival alone
        const log = fs.readFileSync(E.LIASCAPE_BACKEND_LOG, "utf8").slice(logLen);
        const asks = log.split("\n").filter((l) => l.includes("steam-cm: GetDetails"));
        if (asks.length !== 1 || !asks[0].includes(`(fixture: ${ID})`)) v.push(`Steam asked: ${J(asks)} (want one GetDetails of ${ID} alone)`);
        item = (await http("GET", "/library")).json.find((x) => x.videoPath.includes(`/${ID}/`)) ?? null;
      } finally {
        await setSettings({ workshopFolder: s0.workshopFolder });
        if (item) await post("/library/delete", item); // only the link goes; the later cells count the stack's items
        await sleep(300);
      }
      return v;
    });

    await cell("lib:interplay", async () => {
      const v = [];
      await libSetup();
      // a library of 300+: 300 more videos (a 1 s clip imported as x000…x299, untagged) — the last cell: the earlier ones count 7
      const dir = path.join(OUT, "x-clips"); fs.mkdirSync(dir, { recursive: true });
      const clip = path.join(dir, "src.mp4");
      require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1",
        "-pix_fmt", "yuv420p", clip], { timeout: 30000 });
      for (let i = 0; i < 300; i += 8) await Promise.all(Array.from({ length: Math.min(8, 300 - i) }, (_, j) => {
        const f = path.join(dir, `x${i + j}.mp4`); fs.copyFileSync(clip, f);
        return post("/library/import", { path: f, title: `x${String(i + j).padStart(3, "0")}` }); }));
      // the backend reads each new file's frame size in the background (Web/LibraryFactsOps.cs) and re-sends the library as
      // it goes: wait for it to finish, so no library reload lands among the renders counted below
      for (let i = 0; i < 120; i++) {
        const lib = (await http("GET", "/library")).json;
        if (lib.filter((x) => /^x\d{3}$/.test(x.title)).every((x) => x.resolution)) break;
        await sleep(500);
      }
      // React's commit hook before the page's scripts (probe-layout's RC_HOOK): what a filter change re-renders
      const d = win.webContents.debugger; if (!d.isAttached()) d.attach("1.3");
      await d.sendCommand("Page.enable"); await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: RC_HOOK });
      await loadUi(`localStorage.removeItem("liascape.libFilter"); true`); await tab("Library"); await sleep(1500);
      const nCards = await page(`return m.qa(".lib-scroll .card").length;`);
      if (nCards < 300) v.push(`${nCards} library cards after importing 300 — the perf check proves little`);
      // PERF: hiding one card re-renders the Library, the column and the changed row — never the 300 cards that stay
      if (!(await page(`return !!window.__rc;`))) v.push("no React commit hook — renders not counted");
      else {
        // counted over the click's own commits only (the switch commits in its event, the selection trim in a layout effect
        // right after): a card's own thumbnail loading meanwhile is not the filter's doing
        await page(`await m.ensure();`); await sleep(1500);
        const rc = await page(`const r = [...m.q('.wf-col[data-wf-page="library"]').querySelectorAll(".wf-row")].find((x) => x.dataset.wfTag === "Nature");
          window.__rc = { rendered: 0, mounted: 0, unmounted: 0 }; window.__rcWho = {};
          r.querySelector('[data-seg="exc"]').click(); await new Promise((res) => setTimeout(res, 0));
          return { ...window.__rc, who: Object.entries(window.__rcWho).sort((a, b) => b[1] - a[1]) };`);
        console.log(`        hide Nature over ${nCards} cards: ${J(rc)}`);
        // the Library, its column (the changed row, the groups) and App's own whole-store render (its top bar's icons) — a
        // count that doesn't grow with the grid; a re-rendered card would show as div.card
        const cards = rc.who.filter(([k]) => k.startsWith("div.card")).reduce((a, [, n]) => a + n, 0);
        if (cards) v.push(`hiding one card re-rendered ${cards} kept card(s) (want none) — ${J(rc.who.slice(0, 6))}`);
        if (rc.rendered > 60) v.push(`hiding one card re-rendered ${rc.rendered} components (≤ 60, whatever the grid holds) — ${J(rc.who.slice(0, 6))}`);
        if (rc.unmounted < 1) v.push("hiding Nature unmounted nothing — the render count proved nothing");
        await libSeg("Nature", "off");
      }
      const key = async (k, mods = []) => { send({ type: "keyDown", keyCode: k, modifiers: mods }); await sleep(40); send({ type: "keyUp", keyCode: k, modifiers: mods }); await sleep(200); };
      const blur = () => page(`document.activeElement?.blur(); return true;`);
      const selTitles = () => page(`return m.qa(".lib-scroll .card.selected .lib-title").map((e) => e.dataset.title).sort();`);
      const plN = await page(`return m.qa(".pl-item").length;`);
      await libSeg("Scene", "inc"); await blur();
      await key("a", ["control"]);
      if (J(await selTitles()) !== J(["s1", "s2", "s3"])) v.push(`Ctrl+A under Scene selected ${J(await selTitles())} (want the 3 shown)`);
      await libSeg("Scene", "exc"); await sleep(200);
      const pruned = await page(`return { sel: m.qa(".lib-scroll .card.selected").length, status: document.querySelector(".status")?.textContent ?? "" };`);
      if (pruned.sel) v.push(`${pruned.sel} hidden card(s) stayed selected after the filter hid them`);
      await libSeg("Scene", "off"); await blur(); await key("Escape");
      // the arrows walk the shown cards only
      await libSeg("Anime", "inc"); await blur();
      const seen = new Set();
      for (let i = 0; i < 4; i++) { await key("Right"); seen.add(await page(`return m.q(".lib-scroll .card.focused .lib-title")?.dataset.title ?? null;`)); }
      if (![...seen].every((t) => t === "s1" || t === "s3") || !seen.size) v.push(`the arrows focused ${J([...seen])} under Anime (want s1 / s3 only)`);
      await key("Escape"); await libSeg("Anime", "off");
      // the view: kept over a tab visit, the top after a filter change
      const geo = () => page(`const s = m.q(".lib-scroll"); return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight };`);
      await page(`const s = m.q(".lib-scroll"); s.scrollTop = s.scrollHeight; await m.sleep(300);`);
      const g0 = await geo();
      if (g0.max < 40 || g0.top < 40) v.push(`the Library doesn't scroll (max ${g0.max}) — proved nothing`);
      else {
        await tab("Settings"); await tab("Library"); await sleep(300);
        const g1 = await geo();
        if (Math.abs(g1.top - g0.top) > 2) v.push(`a tab visit moved the Library from ${g0.top} to ${g1.top} (want its kept view)`);
        await libSeg("Nature", "exc"); await sleep(250);
        const g2 = await geo();
        if (g2.max < 40) v.push(`after hiding Nature the grid no longer scrolls (max ${g2.max}) — proved nothing`);
        else if (g2.top > 1) v.push(`a filter change left the grid at ${g2.top} (want the top)`);
        await libSeg("Nature", "off");
      }
      // the docked panel opened / closed from its toggle: the grid re-fits, the row the eye is on stays put
      for (const want of [false, true]) {
        await page(`const s = m.q(".lib-scroll"); s.scrollTop = Math.round(s.scrollHeight / 2); await m.sleep(300);`);
        const at = (id) => page(`const sc = m.q(".lib-scroll"), top = sc.getBoundingClientRect().y;
          const a = [...sc.querySelectorAll(".card.lib")].find((c) => (${id == null} ? c.getBoundingClientRect().top >= top - 1 : c.querySelector("[data-title]")?.dataset.title === ${J(id ?? "")}));
          return a ? { id: a.querySelector("[data-title]")?.dataset.title ?? null, y: a.getBoundingClientRect().y - top } : { id: null, y: null };`);
        const at0 = await at(null);
        await page(`m.tog().click(); await m.sleep(600);`);
        const at1 = (await at(at0.id)).y;
        if (at0.id == null) v.push("no card in view to hold — proved nothing");
        else if (at1 == null || Math.abs(at1 - at0.y) > 2) v.push(`${want ? "opening" : "closing"} the panel moved the row in view: ${at0.id} from ${at0.y?.toFixed(0)} to ${at1?.toFixed(0)} px`);
      }
      const plN2 = await page(`return m.qa(".pl-item").length;`);
      if (plN2 !== plN) v.push(`the playlist bar went from ${plN} to ${plN2} items through the Library's filter`);
      await libClear();
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`FILTERS pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "filters.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
