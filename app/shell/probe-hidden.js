// The item sidebar on both tabs (components/ItemSide.tsx: one component, the same parts, order and actions for the same item)
// and the hidden cards — `scripts/test-ui-matrix.sh --probe probe-hidden.js` (the matrix's hermetic stack).
// docs/decisions.md § "One sidebar for an item, the same on both tabs", § "Left click does the tab's main action,
// right click opens the item sidebar".
// Hide, Unhide and Undo go to the stack's own backend (GET / POST /hidden, POST /library/undo: its hidden.json); the
// Workshop's list (with the library's scene s1 among its results), the subscription state, every apply, unsubscribe and
// delete, and the Workshop's community pieces are answered by a script injected before the page's own (recorded, never
// reaching the stack's backend: its library and its player stay as they are). Real input: right-clicks, clicks, Ctrl-clicks
// and keys through webContents.sendInputEvent.
//   menu:none        a real right-click on a Library card and on a Workshop card opens the sidebar on it and NO menu at the
//                    pointer (sampled for 500 ms), requests nothing
//   same:parts       the library's Workshop scene s1 opened in the Library and in Browse: the sidebar's blocks in the same order,
//                    the one skeleton (the info pills, the action area, Made by, Presets, About, the tiles, Playback, Scene
//                    properties, Comments), the info pills (facts only) in the same order; Browse's "Show in Library" is an
//                    icon under the close button, never a chip. Shots hidden-same-lib.png, hidden-same-browse.png (side by side)
//   same:actions     s1 in both: one split button, Play | Unsubscribe (its right-click: "Unsubscribe without deleting"), the
//                    same tiles with the same words (no Favourite tile: the favourites pill is the toggle), no subscription
//                    card, no line under the buttons; its Unsubscribe posts the Library's own /workshop/delete-from-source
//                    [s1] from either tab. A Workshop result the library doesn't hold: "Subscribe and apply" and "Subscribe"
//                    (their right-click: the one-off download), no Unsubscribe, no card, no line under them
//   same:play        s1 in both: Play and a click on the picture each apply it (POST /apply {s1's path})
//   unsub:browse     a Workshop result Steam keeps subscribed that the library doesn't hold: "Download and apply" / "Download"
//                    and an Unsubscribe → POST /workshop/unsubscribe {940000}; one not subscribed: Subscribe, no Unsubscribe
//   unsub:signedOut  signed out under "Subscribe with Steam login": both tabs' Unsubscribe are on, with no reason, and
//                    post the same unsubscribe
//   hide:lib         the sidebar's Hide on a Library card: the card leaves (fading, per frame), the sidebar closes, the status
//                    says "Hidden: k1. Undo brings it back.", the stack's /hidden holds its path, a reload keeps it hidden; the
//                    top bar's Undo brings it back ("Unhidden: k1", /hidden empty). Shot hidden-hide-lib.png (mid-leave)
//   hide:look        the Hide tile in the tiles' material: a fill of its own and an accent icon glow; no-glow: no glow; bg-live:
//                    its own fill over the wallpaper; motion off: a hover moves nothing. Shots hidden-tile*.png
//   hide:multi       three Ctrl-selected cards: the sidebar of one of them says "Hide 3" and hides all three (one Undo brings
//                    all three back); a card outside the selection: "Hide"
//   hide:filter      the Library's filter column has no Hidden row until a card is hidden; then Yours → Hidden: ✓ shows only
//                    the hidden card, its sidebar says "Unhide", which shows it in the grid again (/hidden empty), and the
//                    view says "No wallpapers match these filters"; ✕ / off leave hidden cards out. Shot hidden-filter.png
//   hide:browse      the Workshop: Hide leaves the card out of the list; the column's Hidden row ✓ shows it (no /browse
//                    request) with Unhide in its sidebar; off: the list again without it
//   hide:web         a web source has no filter toggle until one of its cards is hidden; then a column with Yours → Hidden
//                    alone, ✓ shows the card; Unhide and the row off: the toggle goes again
// Screenshots: <LIASCAPE_OUT>/hidden-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
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
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : J(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const setSettings = (patch) => http("POST", "/settings", patch); // a partial body merges (PATCH)
// nothing hidden on the stack's backend (each cell starts from it)
async function unhideAll() {
  const h = (await http("GET", "/hidden")).json ?? { library: {}, browse: {} };
  for (const scope of ["library", "browse"]) {
    const keys = Object.keys(h[scope] ?? {});
    if (keys.length) await http("POST", "/hidden", { scope, unhide: keys });
  }
}

// the facts the library's s1 and its Workshop result share (the stack's index has none of them: /library is patched)
const S1 = { description: "A scene for the probe", tags: ["Anime", "Everyone"], resolution: "1920 x 1080" };

// runs in the page before its own scripts (every load)
const STUB = `(() => {
  const st = { calls: [], browses: 0 };
  window.__st = st;
  const status = JSON.parse(localStorage.getItem("__probe_hid_status") || "null")
    ?? { signedIn: true, rejected: false, accountName: "probe", daysLeft: 200, mode: "subscribe", usable: true };
  const OrigWS = window.WebSocket, sockets = [];
  window.WebSocket = class extends OrigWS { constructor(...a) { super(...a); sockets.push(this); } };
  window.__fakeWs = (type, payload) => { let n = 0; for (const s of sockets) if (s.readyState === 1 && s.onmessage) { s.onmessage({ data: JSON.stringify({ type, payload }) }); n++; } return n; };
  const S1 = ${J(S1)};
  const items = Array.from({ length: 6 }, (_, i) => ({ title: "ws-" + (i + 1), thumbnailUrl: "", animatedThumbnailUrl: null,
    pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + (940000 + i), resolution: "1920 x 1080", isScene: false,
    workshopId: String(940000 + i), addedAt: null, description: "fake", authorName: "probe", fileSizeBytes: 1000,
    subscriptions: 10 + i, favorites: 5 + i, tags: ["Anime"], trailerKnown: true }));
  // the library's Workshop scene s1 as a Workshop result (the same item on both tabs: same:*)
  items.push({ title: "s1", thumbnailUrl: "", animatedThumbnailUrl: null, pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=900000001",
    isScene: true, workshopId: "900000001", addedAt: null, authorName: "probe", authorId: "76561190000000007", fileSizeBytes: 2000,
    subscriptions: 11, favorites: 6, trailerKnown: true, ...S1 });
  const f = window.fetch.bind(window);
  window.fetch = (u, o = {}) => {
    const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    const m = (o.method || "GET").toUpperCase();
    const res = (b, s = 200) => Promise.resolve(new Response(b == null ? "" : JSON.stringify(b), { status: s, headers: b == null ? {} : { "Content-Type": "application/json" } }));
    if (p === "/steam/status") return res(status);
    if (p === "/steam-todo") return res({ finished: true });
    // the Workshop's list (a web source's comes from the stack's own fixture); every list read counted
    if (p === "/browse" && m === "POST") { st.browses++; const b = JSON.parse(o.body); if (b.filter) return res(b.page > 1 || b.list ? [] : items); }
    // the subscription state a cell sets (window.__wsState), every apply, unsubscribe and delete recorded, never reaching the backend
    if (p === "/workshop/state" && m === "POST") {
      const ids = JSON.parse(o.body).ids || [], s = window.__wsState || {}, r = {};
      st.calls.push({ p, body: { ids } });
      for (const id of ids) r[id] = s[id] ?? { subscribed: false, pending: null, inLibrary: false, onDisk: false };
      return res(r);
    }
    if ((p === "/workshop/unsubscribe" || p === "/workshop/delete-from-source" || p === "/workshop/drain" || p === "/library/trash" || p === "/apply" || p === "/download") && m === "POST") {
      st.calls.push({ p, body: o.body ? JSON.parse(o.body) : null });
      return res(p.endsWith("source") ? { batch: "", unsubscribeInMs: 5000 } : p.endsWith("unsubscribe") ? { inLibrary: false, batch: null, unsubscribeInMs: 5000 } : p === "/apply" ? null : { batch: "" });
    }
    if (p === "/hidden" && m === "POST") st.calls.push({ p, body: JSON.parse(o.body) });
    // the Workshop's community pieces: a creator, counts, the favourite, no comments
    if (p === "/workshop/creator") return res({ steamId: "76561190000000007", name: "Probe Creator", avatar: null });
    if (p === "/workshop/counts") return res({ subscriptions: 11, favorites: 6 });
    if (p === "/workshop/favorite" && m === "GET") return res({ signedIn: true, favorited: false });
    if (p === "/workshop/comments") return res({ signedIn: true, owner: "76561190000000007", total: 0, start: 0, comments: [] });
    if (p === "/workshop/one-off") return res({ route: "steamapp", missing: null });
    // the library: s1 on the Workshop with S1's facts; which Workshop items Steam keeps subscribed: __probe_hid_sub = { workshopId: true }
    if (p === "/library" && m === "GET") {
      const sub = JSON.parse(localStorage.getItem("__probe_hid_sub") || "{}");
      return f(u, o).then((r) => r.json()).then((list) => res(list.map((x) => {
        let y = x.workshopId === "900000001" ? { ...x, ...S1, offWorkshop: false } : x;
        if (x.workshopId && x.workshopId in sub) y = { ...y, subscribed: sub[x.workshopId] };
        return y; })));
    }
    if (p === "/detail" && m === "POST") return res({ title: "x", previewUrl: "", downloadUrl: "" });
    return f(u, o);
  };
})();`;

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const page = (code) => js(`(async () => { ${code} })()`);
const send = (e) => win.webContents.sendInputEvent(e);
async function key(k, mods = []) { send({ type: "keyDown", keyCode: k, modifiers: mods }); send({ type: "keyUp", keyCode: k, modifiers: mods }); await sleep(80); }
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `hidden-${name}.png`), img.toPNG()); }
const mvTo = async (x, y, ms = 0) => { send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); if (ms) await sleep(ms); };
const clickAt = async (x, y, button = "left", modifiers = []) => {
  await mvTo(x, y, 60);
  send({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button, clickCount: 1, modifiers }); await sleep(40);
  send({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button, clickCount: 1, modifiers });
};
const calls = () => js(`window.__st.calls`);
async function waitFor(fn, ms = 3000) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(60); } return v; }
// how many samples lie strictly between the first and the last value (an animation passes through them; a jump doesn't)
const between = (xs, eps = 1.5) => { const ys = xs.filter((x) => x != null); if (ys.length < 2) return 0; const a = ys[0], b = ys.at(-1);
  const lo = Math.min(a, b) + eps, hi = Math.max(a, b) - eps; return ys.filter((y) => y > lo && y < hi).length; };

// a fresh page: the filters as a new install has them (no Hidden row on), the status a cell wants, the libraries' subscriptions
async function load({ status = null, sub = null } = {}) {
  await js(`for (const k of ["libFilter", "browseFilter", "weLocalFilter", "webFilter", "libFilterHidden", "browseFilterHidden"]) localStorage.removeItem("liascape." + k);
    localStorage.setItem("liascape.libFilterHidden", "true"); localStorage.setItem("liascape.browseFilterHidden", "true");
    ${status ? `localStorage.setItem("__probe_hid_status", ${J(J(status))});` : `localStorage.removeItem("__probe_hid_status");`}
    ${sub ? `localStorage.setItem("__probe_hid_sub", ${J(J(sub))});` : `localStorage.removeItem("__probe_hid_sub");`} true`).catch(() => {});
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
  for (let i = 0; i < 50; i++) { if (await js(`window.__fakeWs ? window.__fakeWs("noop", null) : 0`) > 0) break; await sleep(100); }
  await sleep(300);
}
async function tab(name) { await page(`[...document.querySelectorAll(".tab")].find((e) => e.textContent.trim() === ${J(name)})?.click();`); await sleep(600); }
const GRID = (lib) => (lib ? ".lib-scroll" : ".scroll:not(.lib-scroll)");
const cardBox = (t, lib = true) => page(`const c = [...document.querySelectorAll("${GRID(lib)} .card:not([data-leaving]):not(.skel-card)")].find((x) => x.querySelector('[data-title="${t}"]'));
  if (!c) return null; c.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 120));
  const r = c.querySelector(".thumb-wrap").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 };`);
const titles = (lib = true) => page(`return [...document.querySelectorAll("${GRID(lib)} .card:not([data-leaving]):not(.skel-card) [data-title]")].map((e) => e.dataset.title).sort();`);
const MENU = "[data-ctx-menu]";
const SIDE = ".side-panel:not(.closing)";
const sideTitle = () => js(`document.querySelector("${SIDE} [data-side-title]")?.textContent.trim() ?? null`);
const status = () => js(`document.querySelector(".status")?.textContent ?? ""`);
const hidden = async () => (await http("GET", "/hidden")).json;
// a real right-click on card `t`: its sidebar (waited for)
async function openSide(t, lib = true) {
  const b = await cardBox(t, lib); if (!b) return null;
  await clickAt(b.x, b.y, "right");
  await waitFor(async () => (await sideTitle()) === t && await js(`!!document.querySelector("${SIDE} .side-body:not(.wait)")`), 3000);
  await sleep(250);
  return b;
}
// a real click on the sidebar's element `sel` (scrolled into view first)
async function sideClick(sel, button = "left") {
  const r = await page(`const e = document.querySelector("${SIDE} ${sel}"); if (!e) return null; e.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 150)); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };`);
  if (!r) return false;
  await clickAt(r.x, r.y, button); await sleep(450);
  return true;
}
const hideTile = () => js(`document.querySelector("${SIDE} [data-side-hide]")?.textContent.trim() ?? null`);
const menuItems = () => js(`[...document.querySelectorAll("${MENU}:not(.closing) [role=menuitem]")].map((b) => b.dataset.ctxItem)`);
const undoBtn = () => js(`(() => { const b = document.querySelector('.topbar button[aria-label="Undo"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function openFilters(lib) { await page(`const t = document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="${lib ? "library" : "browse"}"]'); if (t && t.getAttribute("aria-expanded") !== "true") t.click();`); await sleep(500); }
async function closeFilters(lib) { await page(`const t = document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="${lib ? "library" : "browse"}"]'); if (t && t.getAttribute("aria-expanded") === "true") t.click();`); await sleep(500); }
const hiddenRow = () => js(`(() => { const r = [...document.querySelectorAll(".wf-col:not(.closing) .wf-row")].find((x) => x.dataset.wfTag === "@hidden"); return r ? { text: r.textContent.trim() } : null; })()`);
const yoursRows = () => js(`[...(document.querySelector('.wf-col:not(.closing) [data-wf-group="yours"]')?.querySelectorAll(".wf-row") ?? [])].map((x) => x.dataset.wfTag)`);
const seg = async (s) => { await page(`[...document.querySelectorAll(".wf-col:not(.closing) .wf-row")].find((x) => x.dataset.wfTag === "@hidden")?.querySelector('[data-seg="${s}"]')?.click();`); await sleep(600); };
async function browseSource(pred) {
  const srcs = (await http("GET", "/sources")).json;
  const s = srcs.find(pred);
  if (!s) return null;
  await tab("Browse");
  await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(s.name)})?.click();`);
  await waitFor(() => page(`return document.querySelectorAll("${GRID(false)} .card:not(.skel-card):not([data-leaving])").length > 0;`), 6000);
  await sleep(400);
  return s;
}
const WS = (s) => s.supportsTagFilter && s.available;
const WEB = (s) => !s.supportsTagFilter && !s.supportsLocalFilter && s.available;

// the open sidebar as the parity cells compare it: its body's blocks, the hero's chips, the actions' words
const SIDE_SHAPE = `(() => { const b = document.querySelector("${SIDE} .side-body"); if (!b) return null;
  const part = (k) => k.dataset.sidePart ?? (k.matches(".side-hero") ? "hero" : k.matches(".ws-creator-row") && k.querySelector("[data-ws-creator]") || k.matches("[data-ws-creator]") ? "creator"
    : k.matches("[data-ws-presets]") || k.querySelector("[data-ws-presets]") ? "presets" : k.matches("[data-ws-base]") || k.querySelector("[data-ws-base]") ? "base"
    : k.matches("[data-side-crash]") ? "crash" : k.matches("[data-preset-note]") ? "notice" : k.matches("[data-sec]") ? k.dataset.sec
    : k.matches("[data-scene-props]") ? "props" : k.matches("[data-ws-comments]") ? "comments" : k.matches("[data-side-sub]") ? "subcard" : k.matches("[data-tip]") ? "tip" : "?" + k.className);
  const chip = (e) => e.matches("[data-in-library]") ? "inlib" : e.matches("[data-side-looping]") ? "looping" : e.matches(".side-chip") ? "type"
    : e.dataset.sideStat ?? e.dataset.sideRow ?? (e.matches("[data-side-author]") ? "author" : null);
  const hero = b.querySelector(":scope > .side-hero");
  const chips = hero ? [...hero.querySelectorAll(".side-chip, .side-pill, [data-in-library]")].filter((e) => !e.parentElement.closest("[data-in-library]") && getComputedStyle(e).display !== "none")
    .map(chip).filter((x) => x) : [];
  // a control's shown words (a two-faced one's hidden faces, data-off, left out)
  const words = (sel) => [...b.querySelectorAll(sel)].map((e) => { const c = e.cloneNode(true); for (const x of c.querySelectorAll("[data-off]")) x.remove(); return c.textContent.trim(); });
  return { parts: [...b.children].map(part), chips, cta: words(".side-cta .side-go"), tiles: words('[data-side-part="tiles"] > *'),
    subCard: !!b.querySelector("[data-side-sub]"), line: !!b.querySelector("[data-side-get-hint], [data-side-get-why], .side-cta-note"),
    play: !!document.querySelector("${SIDE} [data-side-play]"), showInLib: !!document.querySelector("${SIDE} .side-head-tools [data-show-in-library]"),
    favToggle: !!b.querySelector(":scope > .side-hero button[data-side-stat=favorites][data-ws-fav]") }; })()`;
// the one skeleton (docs/decisions.md § "One sidebar for an item, the same on both tabs")
const ORDER = ["hero", "crash", "notice", "cta", "tip", "creator", "presets", "base", "about", "tiles", "playback", "tip", "props", "comments"];
// in ORDER's order, each block at most where ORDER has it (a one-time tip sits under the action area or under Playback)
const inOrder = (xs) => { let at = -1; for (const x of xs) { at = ORDER.indexOf(x, at + 1); if (at < 0) return false; } return true; };

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  await win.loadURL("about:blank");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Page.enable");
  await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  const results = [];
  const cell = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    await unhideAll();
    try { v = await Promise.race([fn(), sleep(90000).then(() => ["ERROR the cell took over 90 s"])]); } catch (e) { v = [`ERROR ${e.message}`]; }
    await unhideAll();
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  const SIGNED_OUT = { signedIn: false, rejected: false, accountName: "", daysLeft: null, mode: "subscribe", usable: false };
  // the web sources' lists (the stack's fixture file, read per request; emptied again at the end): four cards each
  const FIX = E.LIASCAPE_WEB_SOURCES_FIXTURE;
  // s1 in the Library and in Browse: the sidebar's shape on each (a fresh page per tab)
  const bothTabs = async (opts = {}) => {
    await load(opts); await tab("Library");
    if (!(await openSide("s1"))) return { err: "no sidebar on the Library's s1 — proved nothing" };
    await sleep(900);
    const lib = await js(SIDE_SHAPE);
    await shot("same-lib");
    await load(opts);
    if (!(await browseSource(WS))) return { err: "no Workshop source — proved nothing" };
    if (!(await openSide("s1", false))) return { err: "no sidebar on Browse's s1 — proved nothing" };
    await sleep(900);
    const br = await js(SIDE_SHAPE);
    await shot("same-browse");
    return { lib, br };
  };
  try {
    const webs = ((await http("GET", "/sources")).json ?? []).filter(WEB);
    if (FIX) fs.writeFileSync(FIX, J(Object.fromEntries(webs.map((s, k) => [s.name, [1, 2, 3, 4].map((i) => ({ title: `web-${k}-${i}`, thumbnailUrl: "",
      pageUrl: `https://web-${k}.invalid/w/${i}`, isScene: false, resolution: "1920 x 1080" }))]))));
    // the app's own origin first: load() keeps its switches in that origin's localStorage
    await win.loadURL(withToken(U + "/"));
    await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: true, workshopDownloadMode: "subscribe", settingsLevel: "standard" });

    await cell("menu:none", async () => {
      const v = [];
      await load(); await tab("Library");
      for (const [t, lib] of [["k1", true], ["ws-1", false]]) {
        if (!lib && !(await browseSource(WS))) { v.push("no Workshop source — Browse unproved"); break; }
        const b = await cardBox(t, lib);
        if (!b) { v.push(`no ${t} card — proved nothing`); continue; }
        const n0 = (await calls()).length;
        const seen = js(`new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { if (document.querySelector(${J(MENU)})) n++;
          if (performance.now() - t0 < 500) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); })`);
        await sleep(20);
        await clickAt(b.x, b.y, "right");
        const n = await seen;
        await sleep(300);
        const got = (await calls()).slice(n0).map((c) => c.p).filter((p) => p !== "/workshop/state");
        console.log(`        ${t}: sidebar "${await sideTitle()}", a menu in ${n} frames, requests ${J(got)}`);
        if (n) v.push(`${t}: a right-click opened a menu at the pointer (${n} frames)`);
        if (await sideTitle() !== t) v.push(`${t}: the right-click didn't open its sidebar (${await sideTitle()})`);
        if (got.length) v.push(`${t}: the right-click sent ${J(got)}`);
        await key("Escape"); await sleep(300);
      }
      return v;
    });

    await cell("same:parts", async () => {
      const v = [];
      const r = await bothTabs({ sub: { "900000001": true } });
      if (r.err) return [r.err];
      const { lib, br } = r;
      console.log(`        Library: ${J(lib.parts)} | ${J(lib.chips)}`);
      console.log(`        Browse:  ${J(br.parts)} | ${J(br.chips)}`);
      if (J(lib.parts) !== J(br.parts)) v.push(`the blocks differ: Library ${J(lib.parts)}, Browse ${J(br.parts)}`);
      for (const [k, x] of [["Library", lib], ["Browse", br]]) {
        if (!inOrder(x.parts)) v.push(`${k}: the blocks out of order ${J(x.parts)} (want ${J(ORDER)})`);
        for (const want of ["hero", "creator", "cta", "about", "tiles", "playback", "props", "comments"])
          if (!x.parts.includes(want)) v.push(`${k}: no ${want} block (${J(x.parts)})`);
        if (!x.favToggle) v.push(`${k}: the favourites pill isn't the favourite's toggle`);
      }
      if (J(lib.chips) !== J(br.chips)) v.push(`the info pills differ: Library ${J(lib.chips)}, Browse ${J(br.chips)}`);
      if (lib.showInLib || !br.showInLib) v.push(`Show in Library: Library ${lib.showInLib}, Browse ${br.showInLib} (want Browse's head alone)`);
      const CHIPS = ["type", "looping", "duration", "resolution", "age", "subscribers", "favorites", "workshop-id", "author", "size"];
      if (!br.chips.every((c, i) => CHIPS.includes(c) && (i === 0 || CHIPS.indexOf(br.chips[i - 1]) < CHIPS.indexOf(c)))) v.push(`the chips out of order ${J(br.chips)} (want ${J(CHIPS)})`);
      for (const want of ["type", "resolution", "age", "subscribers", "favorites", "workshop-id"]) if (!lib.chips.includes(want)) v.push(`no ${want} chip (${J(lib.chips)})`);
      return v;
    });

    await cell("same:actions", async () => {
      const v = [];
      const r = await bothTabs({ sub: { "900000001": true } });
      if (r.err) return [r.err];
      const { lib, br } = r;
      console.log(`        Library: cta ${J(lib.cta)} tiles ${J(lib.tiles)} card ${lib.subCard} line ${lib.line}`);
      console.log(`        Browse:  cta ${J(br.cta)} tiles ${J(br.tiles)} card ${br.subCard} line ${br.line}`);
      for (const [k, x] of [["Library", lib], ["Browse", br]]) {
        if (J(x.cta) !== J(["Play", "Unsubscribe"])) v.push(`${k}: the action area ${J(x.cta)} (want the split Play | Unsubscribe)`);
        if (x.subCard || x.line) v.push(`${k}: a subscription card (${x.subCard}) or a line under the buttons (${x.line})`);
      }
      if (J(lib.tiles) !== J(br.tiles)) v.push(`the tiles differ: Library ${J(lib.tiles)}, Browse ${J(br.tiles)}`);
      if (J(lib.tiles) !== J(["Open in file manager", "Open on Steam", "Hide"])) v.push(`the tiles ${J(lib.tiles)}`);
      // the Unsubscribe tile's right-click menu and its plain click, from either tab: the Library's own unsubscribe
      for (const t of ["Library", "Browse"]) {
        await load({ sub: { "900000001": true } });
        if (t === "Library") await tab("Library"); else if (!(await browseSource(WS))) { v.push("no Workshop source"); continue; }
        if (!(await openSide("s1", t === "Library"))) { v.push(`${t}: no sidebar on s1`); continue; }
        await sideClick("[data-unsubscribe]", "right"); await sleep(200);
        const m = await menuItems();
        if (J(m) !== J(["keep"])) v.push(`${t}: the Unsubscribe tile's menu ${J(m)} (want "Unsubscribe without deleting")`);
        await key("Escape"); await sleep(300);
        const n0 = (await calls()).length;
        await sideClick("[data-unsubscribe]"); await sleep(600);
        const got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/drain" && c.p !== "/workshop/state");
        console.log(`        ${t} Unsubscribe: ${J(got.map((c) => [c.p, c.body?.items?.map((i) => i.title)]))} | "${await status()}"`);
        if (got.length !== 1 || got[0].p !== "/workshop/delete-from-source" || J(got[0].body?.items?.map((i) => i.title)) !== J(["s1"])) v.push(`${t}: Unsubscribe posted ${J(got)}`);
      }
      // a Workshop result the library doesn't hold: Subscribe and apply / Subscribe, their one-off menu, no Unsubscribe or card
      await load();
      if (!(await browseSource(WS))) return [...v, "no Workshop source"];
      if (!(await openSide("ws-1", false))) return [...v, "no sidebar on ws-1"];
      await sleep(500);
      const x = await js(SIDE_SHAPE);
      console.log(`        ws-1: cta ${J(x.cta)} tiles ${J(x.tiles)} card ${x.subCard}`);
      if (J(x.cta) !== J(["Subscribe and apply", "Subscribe"])) v.push(`ws-1's buttons ${J(x.cta)} (want "Subscribe and apply", "Subscribe")`);
      if (x.subCard || x.line) v.push(`ws-1: a subscription card (${x.subCard}) or a line under the buttons (${x.line})`);
      if (x.play) v.push("ws-1: its picture plays (nothing to play)");
      await sideClick("[data-side-get=only]", "right"); await sleep(300);
      const m = await menuItems();
      if (J(m) !== J(["oneoff"])) v.push(`Subscribe's menu ${J(m)} (want the one-off download)`);
      await key("Escape");
      return v;
    });

    await cell("same:play", async () => {
      const v = [];
      for (const t of ["Library", "Browse"]) {
        for (const how of ["[data-side-apply]", "[data-side-play]"]) {
          await load({ sub: { "900000001": true } });
          if (t === "Library") await tab("Library"); else if (!(await browseSource(WS))) { v.push("no Workshop source"); continue; }
          if (!(await openSide("s1", t === "Library"))) { v.push(`${t}: no sidebar on s1`); continue; }
          // s1's own path, as the library lists it
          const want = (await http("GET", "/library")).json?.find((x) => x.title === "s1")?.videoPath;
          const n0 = (await calls()).length;
          if (!(await sideClick(how))) { v.push(`${t}: no ${how}`); continue; }
          await sleep(400);
          const got = (await calls()).slice(n0).filter((c) => c.p === "/apply");
          console.log(`        ${t} ${how}: ${J(got.map((c) => c.body?.path))} | "${await status()}"`);
          if (!want || got.length !== 1 || got[0].body?.path !== want) v.push(`${t}: ${how} applied ${J(got)} (want s1's path ${J(want)} once)`);
        }
      }
      return v;
    });

    await cell("unsub:browse", async () => {
      const v = [];
      await load();
      if (!(await browseSource(WS))) return ["no Workshop source — proved nothing"];
      await js(`window.__wsState = { "940000": { subscribed: true, pending: null, inLibrary: false, onDisk: true } }; true`);
      if (!(await openSide("ws-1", false))) return ["no sidebar on ws-1"];
      await sleep(500);
      let x = await js(SIDE_SHAPE);
      if (!x) return [`ws-1's sidebar shows no body (panels ${J(await js(`[...document.querySelectorAll(".side-panel")].map((e) => e.className)`))}, title ${J(await sideTitle())})`];
      console.log(`        subscribed: cta ${J(x.cta)}`);
      if (J(x.cta) !== J(["Download and apply", "Download", "Unsubscribe"])) v.push(`a subscribed item's actions ${J(x.cta)} (want Download and an Unsubscribe: being offered Subscribe says it isn't subscribed)`);
      const n0 = (await calls()).length;
      await sideClick("[data-unsubscribe-steam]"); await sleep(500);
      const un = (await calls()).slice(n0).filter((c) => c.p === "/workshop/unsubscribe").map((c) => c.body?.workshopId);
      if (J(un) !== J(["940000"])) v.push(`Unsubscribe posted ${J(un)} (want one /workshop/unsubscribe 940000)`);
      await key("Escape"); await sleep(300);
      if (!(await openSide("ws-2", false))) return [...v, "no sidebar on ws-2"];
      await sleep(500);
      x = await js(SIDE_SHAPE);
      if (J(x.cta) !== J(["Subscribe and apply", "Subscribe"])) v.push(`an item not subscribed: ${J(x.cta)}`);
      return v;
    });

    await cell("unsub:signedOut", async () => {
      const v = [];
      for (const t of ["Library", "Browse"]) {
        await load({ status: SIGNED_OUT, sub: { "900000001": true } });
        if (t === "Library") await tab("Library"); else if (!(await browseSource(WS))) { v.push("no Workshop source"); continue; }
        if (!(await openSide("s1", t === "Library"))) { v.push(`${t}: no sidebar on s1`); continue; }
        const tl = await js(`(() => { const e = document.querySelector("${SIDE} [data-unsubscribe]"); return e ? { off: e.getAttribute("aria-disabled"), text: e.textContent.trim() } : null; })()`);
        if (!tl || tl.off) v.push(`${t} signed out: the Unsubscribe tile ${J(tl)}`);
        const n0 = (await calls()).length;
        await sideClick("[data-unsubscribe]"); await sleep(600);
        if (!(await calls()).slice(n0).some((c) => c.p === "/workshop/delete-from-source")) v.push(`${t}'s Unsubscribe signed out posted ${J((await calls()).slice(n0))}`);
      }
      await shot("unsub-signedout");
      return v;
    });

    await cell("hide:lib", async () => {
      const v = [];
      await load(); await tab("Library");
      if (!(await openSide("k1"))) return ["no sidebar on k1 — proved nothing"];
      if (await hideTile() !== "Hide") return [`k1's Hide tile says ${J(await hideTile())} — proved nothing`];
      const n0 = (await calls()).length;
      const SEL = `[...document.querySelectorAll(".lib-scroll .card")].find((c) => c.querySelector('[data-title="k1"]'))`;
      const ops = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const c = ${SEL};
        out.push(c ? +getComputedStyle(c).opacity : null); if (performance.now() - t0 < 1100) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      await sleep(20);
      await sideClick("[data-side-hide]"); await shot("hide-lib");
      const o = await ops;
      await sleep(300);
      const posted = (await calls()).slice(n0).filter((c) => c.p === "/hidden");
      const h = await hidden();
      const keys = Object.keys(h.library);
      console.log(`        hide: posted ${J(posted.map((c) => c.body))}, /hidden ${J(keys)}, status "${await status()}", opacity ${J(o.filter((x) => x != null).slice(0, 12))}`);
      if (posted.length !== 1 || posted[0].body.scope !== "library" || posted[0].body.hide?.length !== 1 || posted[0].body.hide[0].title !== "k1") v.push(`Hide posted ${J(posted)}`);
      if (keys.length !== 1 || !/k1/.test(keys[0])) v.push(`the backend holds ${J(keys)} (want k1's path)`);
      if ((await titles()).includes("k1")) v.push("k1 still shows in the grid");
      if (between(o, 0.05) < 2) v.push(`k1 didn't fade out (opacity per frame ${J(o.slice(0, 12))})`);
      if ((await status()) !== "Hidden: k1. Undo brings it back.") v.push(`the status says "${await status()}"`);
      if (await sideTitle()) v.push(`the sidebar stays open on ${await sideTitle()}`);
      // a reload keeps it hidden
      await load(); await tab("Library");
      if ((await titles()).includes("k1")) v.push("after a reload k1 shows again");
      // the top bar's Undo brings it back
      const u = await undoBtn();
      if (!u) return [...v, "no Undo in the top bar after the Hide"];
      await clickAt(u.x, u.y); await sleep(900);
      if (!(await titles()).includes("k1")) v.push("Undo didn't bring k1 back");
      if (Object.keys((await hidden()).library).length) v.push(`after Undo the backend still holds ${J(Object.keys((await hidden()).library))}`);
      if ((await status()) !== "Unhidden: k1") v.push(`after Undo the status says "${await status()}"`);
      return v;
    });

    await cell("hide:look", async () => {
      const v = [];
      const TILE = `(() => { const e = document.querySelector("${SIDE} [data-side-hide]"); if (!e) return null; const i = e.querySelector(".side-tile-ico"), cs = getComputedStyle(e);
        return { bg: cs.backgroundColor, tr: cs.transform, scale: cs.scale, glow: getComputedStyle(i).boxShadow, html: document.documentElement.className }; })()`;
      try {
        for (const [k, s] of [["on", { glows: true, liveWallpaperBehindAllTabs: false, morphs: true }], ["off", { glows: false, liveWallpaperBehindAllTabs: true, morphs: false }]]) {
          await setSettings(s);
          await load(); await tab("Library");
          if (!(await openSide("k2"))) { v.push(`${k}: no sidebar on k2`); continue; }
          const r = await page(`const e = document.querySelector("${SIDE} [data-side-hide]"); e?.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 200));
            const b = e?.getBoundingClientRect(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;`);
          if (!r) { v.push(`${k}: no Hide tile`); continue; }
          await mvTo(r.x, r.y, 450);
          const t = await js(TILE);
          console.log(`        ${k}: ${J(t)}`);
          if (/rgba\(0, 0, 0, 0\)|transparent/.test(t.bg)) v.push(`${k}: the tile has no fill of its own (${t.bg})`);
          // the glow: a coloured shadow outside the chip (its inset ring is the no-glow look)
          const glows = t.glow.split(/,(?![^(]*\))/).filter((x) => !/inset|none/.test(x) && !/rgba\(0, 0, 0/.test(x));
          if (k === "on" && !glows.length) v.push(`on: the tile's icon has no glow (${t.glow})`);
          if (k === "off") {
            if (!/no-glow/.test(t.html) || !/bg-live/.test(t.html) || !/no-motion/.test(t.html)) v.push(`the toggles didn't apply: "${t.html}" — proved nothing`);
            if (glows.length) v.push(`no-glow: the tile's icon still glows (${t.glow})`);
            if (t.tr !== "none" || (t.scale && t.scale !== "none")) v.push(`motion off: the hovered tile moved (transform ${t.tr}, scale ${t.scale})`);
          }
          await shot(`tile-${k}`);
          await mvTo(5, 5, 100);
        }
      } finally { await setSettings({ glows: true, liveWallpaperBehindAllTabs: false, morphs: true }); }
      return v;
    });

    await cell("hide:multi", async () => {
      const v = [];
      await load(); await tab("Library");
      for (const t of ["k2", "k3", "k4"]) { const b = await cardBox(t); if (!b) { v.push(`no card ${t}`); continue; } await clickAt(b.x, b.y, "left", ["control"]); await sleep(200); }
      const nSel = await js(`document.querySelectorAll(".lib-scroll .card:not([data-leaving]).selected").length`);
      if (nSel !== 3) return [...v, `Ctrl-clicks selected ${nSel} cards — proved nothing`];
      // a card outside the selection: its own Hide
      await openSide("k1");
      if (await hideTile() !== "Hide") v.push(`a card outside the selection: ${J(await hideTile())} (want its own "Hide")`);
      await openSide("k3");
      console.log(`        on the selection: ${J(await hideTile())} | ${await js(`document.querySelectorAll(".lib-scroll .card.selected").length`)} selected`);
      if (await hideTile() !== "Hide 3") v.push(`the selection's tile: ${J(await hideTile())} (want "Hide 3")`);
      await sideClick("[data-side-hide]"); await sleep(400);
      const left = await titles();
      if (["k2", "k3", "k4"].some((t) => left.includes(t)) || !left.includes("k1")) v.push(`after Hide 3 the grid shows ${J(left)}`);
      if (Object.keys((await hidden()).library).length !== 3) v.push(`the backend holds ${J(Object.keys((await hidden()).library))}`);
      if ((await status()) !== "Hidden: 3 wallpapers. Undo brings them back.") v.push(`the status says "${await status()}"`);
      const u = await undoBtn();
      if (u) { await clickAt(u.x, u.y); await sleep(900); }
      const back = await titles();
      if (!["k2", "k3", "k4"].every((t) => back.includes(t))) v.push(`one Undo brought back ${J(back)}`);
      return v;
    });

    await cell("hide:filter", async () => {
      const v = [];
      await load(); await tab("Library");
      await openFilters(true);
      const before = await yoursRows();
      if (await hiddenRow()) v.push(`a Hidden row with nothing hidden (Yours ${J(before)})`);
      await closeFilters(true); // the right side's other panel: the sidebar takes it
      await openSide("k2");
      if (!(await sideClick("[data-side-hide]"))) return [...v, "no Hide on k2's sidebar"];
      await openFilters(true);
      const after = await yoursRows();
      console.log(`        Yours before ${J(before)}, after a Hide ${J(after)}`);
      if (!after.includes("@hidden")) return [...v, `no Hidden row after a Hide (Yours ${J(after)})`];
      await seg("inc");
      let t = await titles();
      console.log(`        Hidden ✓: ${J(t)}`);
      if (J(t) !== J(["k2"])) v.push(`Hidden ✓ shows ${J(t)} (want only k2)`);
      await shot("filter");
      await seg("exc");
      t = await titles();
      if (t.includes("k2") || !t.includes("k1")) v.push(`Hidden ✕ shows ${J(t)} (want everything but k2)`);
      await seg("off");
      t = await titles();
      if (t.includes("k2") || !t.includes("k1")) v.push(`Hidden off shows ${J(t)} (want everything but k2)`);
      // ✓ again: Unhide in the sidebar
      await seg("inc");
      await closeFilters(true);
      await openSide("k2");
      console.log(`        a hidden card's tile: ${J(await hideTile())}`);
      if (await hideTile() !== "Unhide") v.push(`a hidden card's tile: ${J(await hideTile())} (want "Unhide")`);
      const n0 = (await calls()).length;
      if (await sideClick("[data-side-hide]")) {
        await sleep(500);
        const posted = (await calls()).slice(n0).filter((c) => c.p === "/hidden");
        if (posted.length !== 1 || J(posted[0].body.unhide?.length) !== "1") v.push(`Unhide posted ${J(posted)}`);
        if (Object.keys((await hidden()).library).length) v.push("the backend still holds k2 after Unhide");
        if ((await titles()).length) v.push(`the Hidden view still shows ${J(await titles())}`);
        if (!(await js(`!!document.querySelector(".lib-scroll [data-wf-none]")`))) v.push("the empty Hidden view says nothing");
        if ((await status()) !== "Unhidden: k2") v.push(`the status says "${await status()}"`);
      } else v.push("no Unhide tile to click");
      // the row off: k2 in the grid again
      await openFilters(true); await seg("off");
      if (!(await titles()).includes("k2")) v.push("after Unhide and the row off, k2 isn't in the grid");
      return v;
    });

    await cell("hide:browse", async () => {
      const v = [];
      await load();
      if (!(await browseSource(WS))) return ["no Workshop source — proved nothing"];
      await openSide("ws-2", false);
      if (!(await sideClick("[data-side-hide]"))) return ["no Hide on ws-2's sidebar"];
      await sleep(300);
      let t = await titles(false);
      const h = await hidden();
      const e = Object.values(h.browse)[0];
      console.log(`        after Hide: ${J(t)} | /hidden ${J(Object.keys(h.browse))} source ${e?.source} card ${e?.card?.workshopId}`);
      if (t.includes("ws-2") || !t.includes("ws-1")) v.push(`after Hide the Workshop shows ${J(t)}`);
      if (Object.keys(h.browse).length !== 1 || e?.card?.workshopId !== "940001") v.push(`the backend holds ${J(h.browse)}`);
      await openFilters(false);
      const rows = await yoursRows();
      if (!rows.includes("@hidden")) return [...v, `no Hidden row in the Workshop's column (${J(rows)})`];
      const b0 = await js(`window.__st.browses`);
      await seg("inc"); await sleep(300);
      t = await titles(false);
      console.log(`        Hidden ✓: ${J(t)}, ${await js(`window.__st.browses`) - b0} list read(s)`);
      if (J(t) !== J(["ws-2"])) v.push(`Hidden ✓ on the Workshop shows ${J(t)} (want only ws-2)`);
      if ((await js(`window.__st.browses`)) !== b0) v.push("Hidden ✓ asked the Workshop for a list");
      if (await js(`document.querySelectorAll(".scroll:not(.lib-scroll) .skel-card").length`)) v.push("placeholders under the Hidden view");
      await closeFilters(false);
      await openSide("ws-2", false);
      if (await hideTile() !== "Unhide") v.push(`the hidden Workshop card's tile: ${J(await hideTile())}`);
      if (!(await sideClick("[data-side-hide]"))) v.push("no Unhide to click");
      await sleep(300);
      if (Object.keys((await hidden()).browse).length) v.push("the backend still holds ws-2 after Unhide");
      await openFilters(false); await seg("off"); await sleep(400);
      t = await titles(false);
      if (!t.includes("ws-2")) v.push(`after Unhide and the row off the Workshop shows ${J(t)}`);
      return v;
    });

    await cell("hide:web", async () => {
      const v = [];
      await load();
      const web = await browseSource(WEB);
      if (!web) return ["no web source — proved nothing"];
      const tog = () => js(`!!document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="browse"]')`);
      if (await tog()) v.push(`${web.name}: a filter toggle with nothing hidden`);
      const first = (await titles(false))[0];
      await openSide(first, false);
      if (!(await sideClick("[data-side-hide]"))) return [...v, "no Hide to click"];
      await sleep(400);
      if ((await titles(false)).includes(first)) v.push(`${first} still shows after Hide`);
      if (!(await tog())) return [...v, "no filter toggle after a Hide on a web source"];
      await openFilters(false);
      const groups = await js(`[...document.querySelectorAll(".wf-col:not(.closing) [data-wf-group]")].map((g) => g.dataset.wfGroup)`);
      const rows = await yoursRows();
      console.log(`        ${web.name}: groups ${J(groups)}, Yours ${J(rows)}`);
      if (J(groups) !== J(["yours"]) || J(rows) !== J(["@hidden"])) v.push(`the web source's column: ${J({ groups, rows })}`);
      await seg("inc");
      const t = await titles(false);
      if (J(t) !== J([first])) v.push(`Hidden ✓ shows ${J(t)} (want ${first})`);
      await shot("web");
      await closeFilters(false);
      await openSide(first, false);
      if (!(await sideClick("[data-side-hide]"))) v.push("no Unhide to click");
      await openFilters(false); await seg("off"); await sleep(500);
      if (await tog()) v.push("the filter toggle stays with nothing hidden and the row off");
      if (!(await titles(false)).includes(first)) v.push(`${first} isn't back in the list`);
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  await setSettings({ autoAddWeWallpapersToLibrary: false, morphs: true, glows: true, liveWallpaperBehindAllTabs: false }).catch(() => {});
  if (FIX) { try { fs.writeFileSync(FIX, "{}"); } catch { /* the stack is going */ } }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`HIDDEN pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "hidden.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
