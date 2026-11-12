// Workshop filter column probe — `scripts/test-ui-matrix.sh --probe probe-filters.js` (the matrix's hermetic stack; run it with
// LIASCAPE_MATRIX_SCREEN=2560x1440 so the wide sizes fit the private Xvfb). Wallpaper Engine's left filter column with a
// three-way switch per tag and click-to-cycle names (docs/decisions.md § "Filter the Workshop in a column of three-way
// switches"). The stack has no network: the page's POST /browse
// and /detail are stubbed (each page-1 /browse body recorded in window.__browse — later pages in __more —, a fixed list of 24 fake Workshop items returned).
//   wf:workshopOnly   the Workshop's column shows on it (none on the web sources — the WE folder's: local:weFolder); docked at 1400 px, left of the
//                     grid (the grid starts at its right edge, no card under it); Features collapsed by default
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
//   wf:migrate        an old saved filter (type / ageRating / resolution / genres / features) → all includes, once; sort kept
//   wf:library       the "In my library" row: ✓ = only the owned card, ✕ = all but it, no /browse request for it, never POSTed;
//                    no download button on the owned card
//   wf:morphLift     the fold/unfold ghost lifts and glows mid-flight only in proportion to how far it flies (no flash in place)
//   wf:collapseCol   the docked column's collapse button → gone, the grid's margin too, the pill brings it back; remembered
//   wf:drawer         below 1100 px: no docked column, "Filters · N" in the sort row opens it as a drawer over the grid with a
//                     scrim (left edge, inside the window, above the item sidebar); a switch works in it; Escape / the scrim close it
//   wf:size:<w>x<h>   the nine layout sizes: docked iff ≥ 1100 px, the grid keeps ≥ 240 px (also with the item sidebar open),
//                     cards inside it, no sideways scroll; narrow: the drawer fits the window
//   wf:noMotion       "Smooth window animations" off → the drawer opens and closes with no animation; on → it slides (transform
//                     + opacity only)
//   wf:noGlow         Glow effects off → an included segment has no glow
//   wf:liveBg         live wallpaper behind the tabs → the docked column has no fill, its groups carry the darkness; the drawer
//                     keeps a fill
//   wf:cardSize:<w>x<h> 1920×1080 / 1100×700: the docked column — and the item sidebar opened beside it — changes the column
//                     count, not the card size (within 5 % of the folded column's, or the closest column count's where none
//                     is), no edge gap wider than the grid's gap
// The local filters — the Library's and the local Wallpaper Engine folder's, filtered in the page from each item's tags (the stack's
// scenes s1-s3 get project.json tags / age ratings; a fake WE folder of four videos):
//   lib:column        the Library's column docks at 1400 px left of its grid, above the playlist bar (full width); it offers only
//                     what the items know: Age / Type / Genre / Features (no "In my library", no Resolution), Everyone + Mature,
//                     Anime + Nature; the row above the grid has the pill only (no Workshop sort)
//   lib:filter        include / exclude / age (untagged out under any age filter) / genre any → all / features all, from the
//                     page: the cards follow, no /browse request; nothing left → "No wallpapers match" + Clear filters
//   lib:scope         the Library's filter and the Workshop's never mix (each column, the POST, localStorage); both kept over a reload
//   lib:interplay     Ctrl+A / the arrows reach only shown cards; a filter change drops hidden cards from the selection and
//                     starts the grid at its top; a tab visit keeps the view; the playlist bar is untouched; over 300+ cards a
//                     filter change re-renders the Library and its column, never the cards that stay (React's commit hook)
//   lib:fold          the Library folds its own column (Browse's stays), the pill ⇄ title morph, the grid doesn't move down;
//                     remembered; motion off → no ghost, no slide
//   lib:drawer        below 1100 px the Library's pill opens its drawer; a switch works in it; Escape closes; a tab visit closes it
//   local:weFolder    Browse's "Wallpaper Engine (Local)": the column with what the folder's items know, filtered in the page
//                     (no filter POSTed), "In my library" too, its own saved filter; no Workshop sort in its row
// Screenshots: <LIASCAPE_OUT>/wf-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
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
async function toWorkshop() { await tab("Browse"); await source(wsName); }
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
        if (await page(`return !!m.q(".wf-col, [data-wf-open]");`)) v.push(`the filter column / button shows for ${n}`);
      }
      await source(wsName);
      const r = await page(`const c = m.col(); if (!c) return null; const sc = m.q(".scroll");
        const cards = [...sc.querySelectorAll(".card")].slice(0, 30).map((x) => x.getBoundingClientRect()).filter((b) => b.width);
        return { mode: c.dataset.mode, c: m.rect(c), s: m.rect(sc), under: cards.filter((b) => b.left < m.rect(c).r - 1).length,
          groups: [...c.querySelectorAll("[data-wf-group]")].map((g) => g.dataset.wfGroup),
          featRows: m.grp("features")?.querySelectorAll(".wf-row").length ?? -1, genreRows: m.grp("genre")?.querySelectorAll(".wf-row").length ?? -1,
          subs: [...(m.grp("resolution")?.querySelectorAll(".wf-sub") ?? [])].map((x) => x.textContent), open: !!m.q("[data-wf-open]"),
          cards: m.cards(), title: document.title };`);
      if (!r) return [...v, "no filter column on the Workshop source"];
      console.log(`        ${J({ mode: r.mode, c: r.c, sLeft: r.s.x, groups: r.groups, subs: r.subs, cards: r.cards })}`);
      if (r.mode !== "dock") v.push(`at 1400 px the column is "${r.mode}", not docked`);
      if (r.c.x > 0.5 || r.c.w < 200 || r.c.w > 260) v.push(`the column sits at x ${r.c.x}, ${r.c.w} px wide (≈ 240 at the left edge)`);
      if (r.s.x < r.c.r - 1) v.push(`the grid starts at ${r.s.x}, under the column (its right edge ${r.c.r})`);
      if (r.under) v.push(`${r.under} cards under the column`);
      if (J(r.groups) !== J(["library", "age", "type", "resolution", "genre", "features"])) v.push(`groups ${J(r.groups)}`);
      if (r.featRows !== 0) v.push(`Features isn't collapsed by default (${r.featRows} rows)`);
      if (r.genreRows < 20) v.push(`${r.genreRows} genre rows`);
      if (J(r.subs) !== J(["Standard", "Ultrawide", "Dual", "Triple", "Portrait", "Other"])) v.push(`resolution sub-headings ${J(r.subs)}`);
      if (r.open) v.push("docked, but the sort row still has the Filters pill (it morphed into the column's title)");
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

    await cell("wf:migrate", async () => {
      const v = [];
      const old = { sort: "toprated", trendDays: 30, type: "Scene", ageRating: "Everyone", resolution: "1920 x 1080", genres: ["Anime", "Nature"], features: ["HDR"] };
      await loadUi(`localStorage.setItem("liascape.browseFilter", ${J(J(old))}); true`);
      await toWorkshop();
      const want = ["Scene", "Everyone", "1920 x 1080", "Anime", "Nature", "HDR"];
      const r = await page(`return { inc: [...m.qa('.wf-col .wf-row[data-state="inc"]')].map((x) => x.dataset.wfTag),
        exc: m.qa('.wf-col .wf-row[data-state="exc"]').length, saved: JSON.parse(localStorage.getItem("liascape.browseFilter")), last: m.last(),
        sort: m.q(".wfilter .sel .sel-val")?.textContent };`);
      // HDR sits in Features — collapsed or not, its count says it
      const visible = want.filter((t) => t !== "HDR" || r.inc.includes("HDR"));
      for (const t of visible) if (!r.inc.includes(t)) v.push(`${t} isn't included after the migration`);
      if (r.exc) v.push(`${r.exc} excluded rows after the migration`);
      if (!r.last || !sameSet(r.last.filter.include, want) || r.last.filter.exclude.length) v.push(`the POST: ${J(r.last?.filter)}`);
      if (r.last?.filter.sort !== "toprated" || r.last?.filter.trendDays !== 30) v.push(`sort ${r.last?.filter.sort} / ${r.last?.filter.trendDays} not kept`);
      if (r.sort !== "Top Rated") v.push(`the sort Select shows "${r.sort}"`);
      if (!r.saved || "genres" in r.saved || "type" in r.saved || !sameSet(r.saved.include ?? [], want)) v.push(`saved after the migration: ${J(r.saved)}`);
      // once: a reload reads the new shape as it is (an exclude added after the migration stays)
      await page(`m.seg("Anime", "exc").click(); await m.sleep(500);`);
      await loadUi(); await toWorkshop();
      if ((await page(`return m.st("Anime");`)) !== "exc") v.push("after the migration + an edit + a reload Anime isn't excluded (migrated again?)");
      await page(`m.q("[data-wf-clear]").click(); await m.sleep(500);`);
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

    await cell("wf:morphLift", async () => {
      // the ghost's mid-flight lift and accent glow scale with how far it flies: docked, the title sits a few px from where the
      // pill lands, and a full lift over no distance flashes the pill in place (swells + glows) instead of moving it
      const v = [];
      if (!(await page(`return !!m.q(".wf-col[data-mode=dock]:not(.closing) [data-wf-title]");`))) { v.push("no docked column title (window too narrow?)"); return v; }
      const k = await page(`m.q("[data-wf-title]").click(); await m.sleep(30);
        const g = m.q(".wf-morph"); const a = g?.getAnimations().find((x) => x.effect.getKeyframes().length === 3);
        if (!a) return null; const f = a.effect.getKeyframes();
        const end = new DOMMatrixReadOnly(f[2].transform), mid = new DOMMatrixReadOnly(f[1].transform);
        return { dist: Math.hypot(end.e, end.f), midScale: mid.a / ((1 + end.a) / 2), midGlow: /var\(--accent\)|rgb/.test(f[1].boxShadow ?? "") };`);
      await page(`await m.sleep(500); m.q("[data-wf-open]")?.click(); await m.sleep(600);`);
      if (!k) { v.push("no ghost animation on the fold"); return v; }
      if (k.dist < 30 && k.midScale > 1.015) v.push(`a ${k.dist.toFixed(1)} px flight lifts the ghost ${k.midScale.toFixed(3)}× mid-way (it flashes in place)`);
      if (k.dist < 30 && k.midGlow) v.push(`a ${k.dist.toFixed(1)} px flight glows mid-way (it flashes in place)`);
      if (k.dist >= 120 && k.midScale < 1.05) v.push(`a ${k.dist.toFixed(0)} px flight lost its lift (${k.midScale.toFixed(3)}×)`);
      // a real hovered click (the user's): the glow of whatever shows (pill, ghost, landed title) never dims mid-way — the
      // landed button gets :hover only a beat after it appears under a still pointer, and must not ease back up to it
      for (const dir of ["fold", "unfold"]) {
        const c = await page(`const b = m.q("[data-wf-title]") || m.q("[data-wf-open]"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
        send({ type: "mouseMove", x: Math.round(c.x), y: Math.round(c.y) }); await sleep(500);
        await page(`window.__gl = []; const t0 = performance.now(); const f = () => {
          const el = m.q(".wf-morph") || [m.q("[data-wf-open]"), m.q("[data-wf-title]")].find((e) => e && getComputedStyle(e).visibility === "visible");
          const mm = el && /(-?[0-9.]+)px (-?[0-9.]+)px ([0-9.]+)px/.exec(getComputedStyle(el).boxShadow); if (mm) window.__gl.push(+mm[3]);
          if (performance.now() - t0 < 900) requestAnimationFrame(f); }; requestAnimationFrame(f); return true;`);
        send({ type: "mouseDown", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 }); await sleep(40);
        send({ type: "mouseUp", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 }); await sleep(1100);
        const gl = await page(`return window.__gl;`);
        if (gl.length < 10) v.push(`${dir}: only ${gl.length} glow samples — proved nothing`);
        else if (Math.min(...gl) < gl[0] * 0.95) v.push(`${dir} under a hovering pointer: the glow dims ${gl[0]} → ${Math.min(...gl)} px and comes back (a blink)`);
      }
      send({ type: "mouseMove", x: 2, y: 2 }); await sleep(300);
      return v;
    });

    await cell("wf:collapseCol", async () => {
      // fold / unfold the docked column: ONE control —
      // the column's title while it's out, the sort row's pill while it's folded — and a ghost flying between them while the
      // column slides (transform + opacity) and the grid glides (transform); remembered over a reload; no replay on a tab visit
      const v = [];
      const ml = `parseFloat(getComputedStyle(m.q(".scroll")).marginLeft)`;
      const st = `({ col: !!m.q(".wf-col[data-mode=dock]:not(.closing)"), title: !!m.q("[data-wf-title]"),
        pill: !!m.q("[data-wf-open]"), ml: ${ml}, ghosts: m.qa(".wf-morph").length })`;
      const anim = `const a = (el) => el ? el.getAnimations().map((x) => Object.keys(x.effect.getKeyframes()[0] ?? {}).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))).flat() : null;`;
      const r0 = await page(`return ${st};`);
      if (!r0.col) { v.push("no docked column (window too narrow?)"); return v; }
      if (!r0.title || r0.pill) v.push(`column out: title ${r0.title}, pill ${r0.pill} (want the title only)`);
      const t0 = await page(`const t = m.q("[data-wf-title]").getBoundingClientRect(); return [t.left, t.top];`);
      // fold: mid-flight
      const fold = await page(`${anim} m.q("[data-wf-title]").click(); await m.sleep(120);
        const g = m.q(".wf-morph"), col = m.q(".wf-col[data-mode=dock]"), pill = m.q("[data-wf-open]");
        const gr = g?.getBoundingClientRect();
        const ch = g?.querySelector(".wf-chev"), chA = ch?.getAnimations()[0];
        const chDeg = ch ? (() => { const m = new DOMMatrixReadOnly(getComputedStyle(ch).transform); return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI); })() : null;
        return { ghost: !!g, gx: gr?.left, chevAnim: !!chA, chDeg, colAnim: a(col), gridAnim: a(m.q(".scroll > .grid")), ghostAnim: a(g),
          pillHidden: pill ? getComputedStyle(pill).visibility === "hidden" : null,
          oldTitle: (() => { const t = m.q(".wf-col.closing [data-wf-title]"); return t ? getComputedStyle(t).visibility : "gone"; })() };`);
      if (!fold.ghost) v.push("no ghost flying from the title to the pill");
      else if (fold.ghostAnim.some((k) => !["transform", "backgroundColor", "color", "boxShadow", "borderRadius"].includes(k))) v.push(`the ghost animates ${J(fold.ghostAnim)}`);
      // the chevron turns on the way (0° on the title → 180° on the pill), mid-turn at 120 ms of 340 — not snapped at the landing
      if (!fold.chevAnim) v.push("the ghost's chevron doesn't rotate");
      else if (fold.chDeg === 0 || Math.abs(fold.chDeg) === 180) v.push(`the chevron sits at ${fold.chDeg}° mid-flight (not turning)`);
      if (fold.pillHidden !== true) v.push(`the pill isn't held hidden under the flying ghost (${fold.pillHidden})`);
      if (fold.oldTitle === "visible") v.push("the sliding-out column still shows its title beside the ghost (two buttons)");
      if (!fold.colAnim?.length) v.push("the column didn't slide out");
      else if (fold.colAnim.some((k) => !["transform", "opacity"].includes(k))) v.push(`the column animates ${J(fold.colAnim)}`);
      if (!fold.gridAnim?.length) v.push("the grid didn't glide");
      else if (fold.gridAnim.some((k) => k !== "transform")) v.push(`the grid animates ${J(fold.gridAnim)}`);
      await page(`await m.sleep(500);`);
      const r1 = await page(`const p = m.q("[data-wf-open]"); return { ...${st}, vis: p ? getComputedStyle(p).visibility : null,
        exp: p?.getAttribute("aria-expanded"), anims: m.q(".scroll > .grid").getAnimations().length };`);
      if (r1.col || r1.title) v.push("the column / its title is still there after folding");
      if (!r1.pill || r1.vis !== "visible") v.push(`after folding the pill is ${r1.pill ? r1.vis : "missing"}`);
      if (r1.exp !== "false") v.push(`the pill's aria-expanded is ${r1.exp}`);
      if (r1.ml > 1) v.push(`the grid keeps a ${r1.ml}px left margin`);
      if (r1.ghosts || r1.anims) v.push(`${r1.ghosts} ghost(s) / ${r1.anims} grid animation(s) left after the fold`);
      await loadUi(); await toWorkshop();
      if (await page(`return !!m.q(".wf-col");`)) v.push("folded isn't remembered over a reload");
      // unfold: the ghost lands on the title
      const unf = await page(`m.q("[data-wf-open]").click(); await m.sleep(120);
        const t = m.q("[data-wf-title]"); return { cls: m.q(".wf-col[data-mode=dock]")?.className,
        ghost: !!m.q(".wf-morph"), hidden: t ? getComputedStyle(t).visibility === "hidden" : null };`);
      if (!/entering/.test(unf.cls ?? "")) v.push(`the column didn't slide in (${unf.cls})`);
      if (!unf.ghost || !unf.hidden) v.push(`unfolding: ghost ${unf.ghost}, title held hidden ${unf.hidden}`);
      await page(`await m.sleep(500);`);
      const r2 = await page(`const t = m.q("[data-wf-title]"); return { ...${st}, vis: t ? getComputedStyle(t).visibility : null,
        at: t ? [t.getBoundingClientRect().left, t.getBoundingClientRect().top] : null };`);
      if (!r2.col || !r2.title || r2.pill) v.push(`after unfolding: column ${r2.col}, title ${r2.title}, pill ${r2.pill}`);
      if (r2.vis !== "visible") v.push(`the title is ${r2.vis} after the ghost landed`);
      if (r2.ghosts) v.push(`${r2.ghosts} ghost(s) left after unfolding`);
      if (r2.at && (Math.abs(r2.at[0] - t0[0]) > 1 || Math.abs(r2.at[1] - t0[1]) > 1)) v.push(`the title rests at ${J(r2.at)}, was ${J(t0)}`);
      if (Math.abs(r2.ml - r0.ml) > 1) v.push(`grid margin ${r2.ml} after unfolding (was ${r0.ml})`);
      await tab("Library"); await tab("Browse");
      if (await page(`return (m.q(".wf-col")?.getAnimations().length ?? -1) + m.qa(".wf-morph").length;`)) v.push("a tab visit replays the slide / morph");
      return v;
    });

    await cell("wf:drawer", async () => {
      const v = [];
      await resize(1000, 700);
      let r = await page(`return { col: !!m.q(".wf-col"), btn: m.q("[data-wf-open]")?.textContent.trim() ?? null };`);
      if (r.col) v.push("at 1000 px the column is still on screen (docked)");
      if (!r.btn) return [...v, "no Filters button in the sort row at 1000 px"];
      // open, set two tags inside it
      await page(`m.q("[data-wf-open]").click(); await m.sleep(450);`);
      r = await page(`const c = m.col(); if (!c) return null; const s = m.q(".wf-scrim");
        return { mode: c.dataset.mode, c: m.rect(c), scrim: !!s, z: +getComputedStyle(c).zIndex, W: innerWidth, H: innerHeight };`);
      if (!r) return [...v, "the Filters button didn't open the drawer"];
      if (r.mode !== "drawer") v.push(`the column opened as "${r.mode}"`);
      if (r.c.x < -0.5 || r.c.x > 0.5 || r.c.r > r.W + 0.5 || r.c.b > r.H + 0.5) v.push(`the drawer (${J(r.c)}) isn't at the left edge inside the ${r.W}×${r.H} window`);
      if (!r.scrim) v.push("no scrim");
      if (!(r.z > 40)) v.push(`the drawer's z-index ${r.z} is under the item sidebar's (40)`);
      await page(`m.seg("Anime", "inc").click(); m.seg("Mature", "exc").click(); await m.sleep(500);`);
      const btn = await page(`return m.q("[data-wf-open]")?.textContent.trim();`);
      if (!/Filters · 2/.test(btn ?? "")) v.push(`the button reads "${btn}" with two tags on`);
      await shot("drawer-1000x700");
      // Escape closes it (and the item sidebar stays as it was)
      await page(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await m.sleep(400);`);
      if (await page(`return !!m.q(".wf-col");`)) v.push("Escape didn't close the drawer");
      // the scrim closes it; with the item sidebar open the drawer sits above it
      await page(`m.q(".scroll:not(.lib-scroll) .card .thumb-wrap")?.click(); await m.sleep(600); m.q("[data-wf-open]").click(); await m.sleep(450);`);
      r = await page(`const c = m.col(), s = m.q(".side-panel:not(.closing)"); if (!c) return null;
        const b = m.rect(c); const hit = document.elementFromPoint(b.x + b.w / 2, b.y + 60); return { side: !!s, top: !!hit?.closest(".wf-col"), W: innerWidth };`);
      if (!r) v.push("the drawer didn't open again with the item sidebar open");
      else { if (!r.side) v.push("(the item sidebar didn't open for the check)"); if (!r.top) v.push("the item sidebar covers the drawer"); }
      await shot("drawer-sidebar-1000x700");
      await page(`const c = m.col(), b = m.rect(c); document.elementFromPoint(Math.min(innerWidth - 20, b.r + 40), b.y + 40)?.click(); await m.sleep(400);`);
      if (await page(`return !!m.q(".wf-col");`)) v.push("a click on the scrim didn't close the drawer");
      await page(`m.q(".side-panel [data-side-close]")?.click(); await m.sleep(400);`);
      // widening docks it again
      await resize(1400, 900);
      if ((await page(`return m.col()?.dataset.mode;`)) !== "dock") v.push("back at 1400 px the column isn't docked");
      if (await page(`return !!m.q("[data-wf-open]");`)) v.push("back at 1400 px the Filters pill is still there");
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
        const docked = W >= 1100;
        if (docked !== (g.col?.mode === "dock")) v.push(`${W} px: the column is ${g.col ? g.col.mode : "absent"} (docked from 1100)`);
        if (g.grid < 240) v.push(`the grid is ${g.grid} px wide`);
        if (g.over) v.push(`${g.over}/${g.n} cards stick out of the grid`);
        if (g.doc) v.push("something scrolls sideways");
        if (docked && g.s.x < g.col.r.r - 1) v.push("the grid runs under the column");
        await shot(`size-${w}x${h}`);
        // the item sidebar open too
        await page(`m.q(".scroll:not(.lib-scroll) .card .thumb-wrap")?.click(); await m.sleep(650);`);
        g = await geo();
        const side = await page(`const p = m.q(".side-panel:not(.closing)"); return p ? m.rect(p) : null;`);
        if (side && W >= 900) {
          if (g.grid < 240) v.push(`with the item sidebar open the grid is ${g.grid} px`);
          if (g.s.r > side.x + 1) v.push("the grid runs under the item sidebar");
        }
        if (g.over) v.push(`sidebar open: ${g.over}/${g.n} cards stick out of the grid`);
        if (docked) await shot(`size-${w}x${h}-sidebar`);
        await page(`m.q(".side-panel [data-side-close]")?.click(); await m.sleep(400);`);
        if (!docked) {
          await page(`m.q("[data-wf-open]")?.click(); await m.sleep(450);`);
          const d = await page(`const c = m.col(); if (!c) return null; const b = m.rect(c); const close = c.querySelector(".wf-close"); const cb = close ? m.rect(close) : null;
            return { b, cb, W: innerWidth, H: innerHeight, sh: c.querySelector(".wf-scroll").scrollHeight > c.querySelector(".wf-scroll").clientHeight };`);
          if (!d) v.push("the Filters button didn't open the drawer");
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
      await resize(1000, 700);
      const probe = () => page(`m.q("[data-wf-open]").click(); await m.sleep(30);
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
      await setMotion(false);
      r = await probe();
      console.log(`        motion off: ${J(r)}`);
      if (r.n) v.push(`motion off: ${r.n} animations on the drawer / scrim`);
      if (r.gone > 100) v.push(`motion off: the drawer took ${r.gone} ms to go`);
      await setMotion(true);
      await resize(1400, 900);
      return v;
    });

    await cell("wf:noGlow", async () => {
      const v = [];
      await page(`m.seg("Anime", "inc").click(); await m.sleep(100);`);
      const bs = () => page(`return getComputedStyle(m.seg("Anime", "inc")).boxShadow;`);
      const on = await bs();
      await setSettings({ glows: false }); await loadUi(); await toWorkshop();
      const off = await bs();
      if (on === "none") v.push("glow on: an included segment has no glow");
      if (off !== "none" && !/0px 0px 0px 0px/.test(off) && !/rgba\(0, 0, 0, 0\)/.test(off)) v.push(`Glow effects off: the included segment still glows (${off})`);
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
      await resize(1000, 700);
      await page(`m.q("[data-wf-open]").click(); await m.sleep(450);`);
      const d = await page(`return getComputedStyle(m.col()).backgroundColor;`);
      if (alpha(d) < 0.6) v.push(`the drawer over the grid has no fill (${d})`);
      await shot("liveBg-drawer");
      await page(`m.col()?.querySelector(".wf-close")?.click(); await m.sleep(300);`);
      await resize(1400, 900);
      await setSettings({ liveWallpaperBehindAllTabs: false });
      await page(`m.q("[data-wf-clear]")?.click();`);
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
        if (!(await page(`return !!m.q(".wf-col[data-mode=dock]:not(.closing)");`))) {
          await page(`m.q("[data-wf-open]")?.click(); await m.sleep(700);`);
        }
        const gCol = await geo();
        if (!gCol || !(gCol.ml > 0)) return [`no docked column at ${w}×${h} (grid margin-left ${gCol?.ml}) — proved nothing`];
        await page(`m.q("[data-wf-title]").click(); await m.sleep(700);`);
        const g0 = await geo();
        await page(`m.q("[data-wf-open]").click(); await m.sleep(700);`);
        if (!g0 || g0.ml > 1) return [`folding the column left the grid ${g0 ? `a ${g0.ml} px margin` : "empty"} — proved nothing`];
        await page(`m.q(".scroll:not(.lib-scroll) .card .thumb-wrap")?.click(); await m.sleep(800);`);
        const gBoth = await geo();
        await page(`m.q(".side-panel [data-side-close]")?.click(); await m.sleep(600);`);
        console.log(`        no panel ${show(g0)}; filter column ${show(gCol)}; column + item sidebar ${show(gBoth)}`);
        if (Math.max(g0.lgap, g0.rgap) > g0.gap + 1) v.push(`no panel: an edge gap of ${Math.max(g0.lgap, g0.rgap).toFixed(1)} px beside the row`);
        same("filter column", g0, gCol);
        if (!(gBoth?.mr > 0)) v.push(`the item sidebar didn't dock beside the column (margin-right ${gBoth?.mr})`);
        else same("filter column + item sidebar", g0, gBoth);
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
    const libSeg = (tag, st) => page(`const r = [...(m.q('.wf-col[data-wf-page="library"]:not(.closing)')?.querySelectorAll(".wf-row") ?? [])].find((x) => x.dataset.wfTag === ${J(tag)});
      if (!r) return false; r.querySelector('[data-seg="${st}"]').click(); await m.sleep(250); return true;`);
    // open the Features group (collapsed by default, and the collapse is shared with Browse's column) → its rows
    const libFeatures = () => page(`const h = m.q('.wf-col[data-wf-page="library"] [data-wf-head="features"]');
      if (h?.getAttribute("aria-expanded") === "false") { h.click(); await m.sleep(200); }
      return [...(m.q('.wf-col[data-wf-page="library"] [data-wf-group="features"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag);`);
    const libClear = () => page(`m.q('.wf-col[data-wf-page="library"] [data-wf-clear]')?.click(); await m.sleep(250);`);

    await cell("lib:column", async () => {
      const v = [];
      await libSetup();
      const r = await page(`const c = m.q('.wf-col[data-wf-page="library"]:not(.closing)'); if (!c) return null;
        const sc = m.q(".lib-scroll"), bar = m.q(".playlist-bar"), grid = sc.querySelector(".grid");
        const rows = (g) => [...(c.querySelector('[data-wf-group="' + g + '"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag);
        return { mode: c.dataset.mode, scope: c.dataset.wfScope, c: m.rect(c), grid: m.rect(grid), bar: bar ? m.rect(bar) : null,
          groups: [...c.querySelectorAll("[data-wf-group]")].map((g) => g.dataset.wfGroup), age: rows("age"), type: rows("type"), genre: rows("genre"),
          sorts: sc.querySelectorAll(".wfilter .sel").length, pill: !!sc.querySelector("[data-wf-open]"), label: c.getAttribute("aria-label"),
          cards: m.qa(".lib-scroll .card").length };`);
      if (!r) return ["no filter column on the Library"];
      console.log(`        ${J(r)}`);
      if (r.mode !== "dock" || r.scope !== "library") v.push(`the Library's column is ${r.mode} / ${r.scope}`);
      if (r.c.x > 0.5 || r.c.w < 200) v.push(`the column sits at x ${r.c.x}, ${r.c.w} px wide`);
      if (r.grid.x < r.c.r - 1) v.push(`the grid starts at ${r.grid.x}, under the column (its right edge ${r.c.r})`);
      if (!r.bar) v.push("no playlist bar");
      else {
        if (r.c.b > r.bar.y + 1) v.push(`the column runs into the playlist bar (column bottom ${r.c.b}, bar top ${r.bar.y})`);
        if (r.bar.x > 0.5) v.push(`the playlist bar starts at x ${r.bar.x} (want its full width)`);
      }
      if (J(r.groups) !== J(["age", "type", "genre", "features"])) v.push(`groups ${J(r.groups)} (want age, type, genre, features)`);
      if (J(r.age) !== J(["Everyone", "Mature"])) v.push(`age rows ${J(r.age)} (want what the items know: Everyone, Mature)`);
      if (J(r.type) !== J(["Video", "Scene"])) v.push(`type rows ${J(r.type)}`);
      if (J(r.genre) !== J(["Anime", "Nature"])) v.push(`genre rows ${J(r.genre)}`);
      if (r.sorts) v.push("a Workshop sort in the Library's row");
      if (r.pill) v.push("docked, but the Library's row still has the Filters pill");
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
      await libSetup(); await tab("Library");
      const st = () => page(`const sc = m.q(".lib-scroll"); return { col: !!m.q('.wf-col[data-wf-page="library"][data-mode=dock]:not(.closing)'),
        pill: !!sc.querySelector("[data-wf-open]"), title: !!m.q('[data-wf-title][data-wf-page="library"]'),
        ml: parseFloat(getComputedStyle(sc).marginLeft), gridTop: sc.querySelector(".grid").getBoundingClientRect().top };`);
      const s0 = await st();
      if (!s0.col || !s0.title || s0.pill) return [`unfolded: column ${s0.col}, title ${s0.title}, pill ${s0.pill} — proved nothing`];
      const f = await page(`m.q('[data-wf-title][data-wf-page="library"]').click(); await m.sleep(120);
        return { ghost: m.qa(".wf-morph").length, gridAnim: m.q(".lib-scroll > .grid").getAnimations().length };`);
      if (!f.ghost) v.push("no ghost flying the title down to the pill");
      if (!f.gridAnim) v.push("the Library's grid didn't glide");
      await sleep(600);
      const s1 = await st();
      if (s1.col || !s1.pill || s1.ml > 1) v.push(`folded: column ${s1.col}, pill ${s1.pill}, grid margin ${s1.ml}`);
      if (Math.abs(s1.gridTop - s0.gridTop) > 1) v.push(`folding moved the grid down ${s0.gridTop} → ${s1.gridTop} (the pill's row must keep its height)`);
      await toWorkshop();
      if (!(await page(`return !!m.q('.wf-col[data-wf-page="browse"][data-mode=dock]:not(.closing)');`))) v.push("folding the Library's column folded Browse's too");
      if (await page(`return parseFloat(getComputedStyle(m.q(".scroll")).marginLeft) < 1;`)) v.push("Browse's grid lost its margin beside its column");
      await loadUi(); await tab("Library");
      if ((await st()).col) v.push("the Library's fold isn't remembered over a reload");
      await shot("lib-folded");
      // motion off: unfold / fold with no ghost and no slide
      await setMotion(false); await tab("Library");
      const off = await page(`m.q('.lib-scroll [data-wf-open]').click(); await m.sleep(40);
        const c = m.q('.wf-col[data-wf-page="library"]'); return { ghost: m.qa(".wf-morph").length, anims: c ? c.getAnimations().length : -1 };`);
      if (off.anims < 0) v.push("motion off: the pill didn't bring the column back");
      if (off.ghost || off.anims > 0) v.push(`motion off: ${off.ghost} ghost(s), ${off.anims} column animation(s)`);
      await setMotion(true); await tab("Library");
      if (!(await st()).col) v.push("the Library's column isn't back after unfolding");
      return v;
    });

    await cell("lib:drawer", async () => {
      const v = [];
      await libSetup(); await resize(1000, 700); await tab("Library");
      if (await page(`return !!m.q('.wf-col[data-wf-page="library"]');`)) v.push("at 1000 px the Library's column is still docked");
      const opened = await page(`const p = m.q('.lib-scroll [data-wf-open]'); if (!p) return null; p.click(); await m.sleep(450);
        const c = m.q('.wf-col[data-wf-page="library"]'); return c ? { mode: c.dataset.mode, r: m.rect(c), scrim: !!m.q(".wf-scrim") } : false;`);
      if (opened === null) return [...v, "no Filters pill in the Library's row at 1000 px"];
      if (!opened || opened.mode !== "drawer" || !opened.scrim) v.push(`the pill opened ${J(opened)} (want the drawer + scrim)`);
      else {
        await libSeg("Scene", "inc");
        if (J(await libTitles()) !== J(["s1", "s2", "s3"])) v.push(`a switch in the drawer: ${J(await libTitles())}`);
        await shot("lib-drawer");
        await libClear();
        await page(`document.activeElement?.blur();`);
        send({ type: "keyDown", keyCode: "Escape" }); send({ type: "keyUp", keyCode: "Escape" }); await sleep(400);
        if (await page(`return !!m.q('.wf-col[data-wf-page="library"]');`)) v.push("Escape didn't close the drawer");
        await page(`m.q('.lib-scroll [data-wf-open]').click(); await m.sleep(400);`);
        await tab("Settings"); await tab("Library");
        if (await page(`return !!m.q('.wf-col[data-wf-page="library"]');`)) v.push("the drawer is still open after a tab visit");
      }
      await libClear(); await resize(1400, 900);
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
        await tab("Browse"); await source(src.name); await sleep(800);
        const titles = () => page(`return m.qa(".scroll:not(.lib-scroll) .card .lib-title[data-title]").map((e) => e.dataset.title).sort();`);
        const all = await titles();
        if (all.length !== 4) return [`${J(all)} on ${src.name} (want the fake folder's 4) — proved nothing`];
        const r = await page(`const c = m.col(); if (!c) return null; const rows = (g) => [...(c.querySelector('[data-wf-group="' + g + '"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag);
          return { scope: c.dataset.wfScope, mode: c.dataset.mode, groups: [...c.querySelectorAll("[data-wf-group]")].map((g) => g.dataset.wfGroup),
            age: rows("age"), type: rows("type"), genre: rows("genre"), sorts: m.qa(".scroll:not(.lib-scroll) .wfilter .sel").length };`);
        if (!r) return [`no filter column on ${src.name}`];
        console.log(`        ${J(r)}`);
        if (r.scope !== "weLocal" || r.mode !== "dock") v.push(`column ${r.scope} / ${r.mode}`);
        if (J(r.groups) !== J(["library", "age", "type", "genre", "features"])) v.push(`groups ${J(r.groups)}`);
        if (J(r.age) !== J(["Everyone", "Questionable"]) || J(r.type) !== J(["Video"]) || J(r.genre) !== J(["Anime", "Game", "Music", "Nature"]))
          v.push(`rows age ${J(r.age)}, type ${J(r.type)}, genre ${J(r.genre)}`);
        if (r.sorts) v.push("a Workshop sort in the WE folder's row");
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
        await sleep(1500);
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
