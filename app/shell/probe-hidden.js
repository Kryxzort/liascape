// A card's right-click menu (Unsubscribe, Hide / Unhide) and the hidden cards — `scripts/test-ui-matrix.sh --probe
// probe-hidden.js` (the matrix's hermetic stack). docs/decisions.md § "Right-click a card for its sidebar and its menu".
// Hide, Unhide and Undo go to the stack's own backend (GET / POST /hidden, POST /library/undo: its hidden.json); the
// Workshop's list, the subscription state and every unsubscribe / delete are answered by a script injected before the page's
// own (recorded, never reaching the stack's backend: its library stays as it is). Real input: right-clicks, Ctrl-clicks and
// keys through webContents.sendInputEvent.
//   menu:lib         a real right-click on a Library card opens its sidebar on that card AND a menu at the pointer (role menu,
//                    its first entry focused, growing in per frame, nothing requested): a video's "Hide"; a subscribed Workshop
//                    scene's "Unsubscribe", "Hide"; Escape closes it (the sidebar stays); no-glow + bg-live: the menu keeps its
//                    own fill, no glow. Shots hidden-menu-lib*.png
//   menu:through     with the menu open, another card's right-click opens that card's menu and sidebar (one menu), a press on the
//                    sidebar's close reaches it and closes the menu, a key it doesn't use (Ctrl+A, →) closes it and reaches the grid
//   menu:libOff      motion off: the menu fades in and out in place (motion-off.js)
//   menu:browse      the Workshop's card: "Unsubscribe", "Hide", the sidebar on it; a web source's card: "Hide" alone
//   hide:lib         Hide on a Library card: the card leaves (fading, per frame), the status says "Hidden: k1. Undo brings it
//                    back.", the stack's /hidden holds its path, a reload keeps it hidden; the top bar's Undo brings it back
//                    ("Unhidden: k1", /hidden empty). Shot hidden-hide-lib.png (mid-leave)
//   hide:multi       three Ctrl-selected cards: a right-click on one says "Hide 3" and hides all three (one Undo brings all
//                    three back); a right-click on a card outside the selection acts on that card alone ("Hide")
//   hide:filter      the Library's filter column has no Hidden row until a card is hidden; then Yours → Hidden: ✓ shows only
//                    the hidden card, its menu says "Unhide", which shows it in the grid again (/hidden empty), and the view
//                    says "No wallpapers match these filters"; ✕ / off leave hidden cards out. Shot hidden-filter.png
//   hide:browse      the Workshop: Hide leaves the card out of the list; the column's Hidden row ✓ shows it (no /browse
//                    request) with Unhide; off: the list again without it
//   hide:web         a web source has no filter toggle until one of its cards is hidden; then a column with Yours → Hidden
//                    alone, ✓ shows the card; Unhide and the row off: the toggle goes again
//   unsub:lib        signed in, a subscribed Workshop scene's Unsubscribe → ONE POST /workshop/delete-from-source [s1] (the
//                    Library's unsubscribe), "Unsubscribing from s1. Undo brings it back."; a video offers none
//   unsub:browse     the Workshop card's Unsubscribe asks /workshop/state at the pick: subscribed → POST /workshop/unsubscribe
//                    {workshopId, title}; not subscribed → nothing posted, "Not subscribed to ws-2"
//   unsub:signedOut  signed out under "Subscribe with Steam login" (the page's route: the drain opens the item's Steam page,
//                    scripts/test-steam-signin.sh): the Library's Unsubscribe and Browse's are on, with no "Sign in" note, and
//                    post the same unsubscribe
// Screenshots: <LIASCAPE_OUT>/hidden-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
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

// runs in the page before its own scripts (every load)
const STUB = `(() => {
  const st = { calls: [], browses: 0 };
  window.__st = st;
  const status = JSON.parse(localStorage.getItem("__probe_hid_status") || "null")
    ?? { signedIn: true, rejected: false, accountName: "probe", daysLeft: 200, mode: "subscribe", usable: true };
  const OrigWS = window.WebSocket, sockets = [];
  window.WebSocket = class extends OrigWS { constructor(...a) { super(...a); sockets.push(this); } };
  window.__fakeWs = (type, payload) => { let n = 0; for (const s of sockets) if (s.readyState === 1 && s.onmessage) { s.onmessage({ data: JSON.stringify({ type, payload }) }); n++; } return n; };
  const items = Array.from({ length: 6 }, (_, i) => ({ title: "ws-" + (i + 1), thumbnailUrl: "", animatedThumbnailUrl: null,
    pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + (940000 + i), resolution: "1920 x 1080", isScene: false,
    workshopId: String(940000 + i), addedAt: null, description: "fake", authorName: "probe", fileSizeBytes: 1000,
    subscriptions: 10 + i, favorites: 5 + i, tags: ["Anime"], trailerKnown: true }));
  const f = window.fetch.bind(window);
  window.fetch = (u, o = {}) => {
    const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    const m = (o.method || "GET").toUpperCase();
    const res = (b, s = 200) => Promise.resolve(new Response(b == null ? "" : JSON.stringify(b), { status: s, headers: b == null ? {} : { "Content-Type": "application/json" } }));
    if (p === "/steam/status") return res(status);
    if (p === "/steam-todo") return res({ finished: true });
    // the Workshop's list (a web source's comes from the stack's own fixture); every list read counted
    if (p === "/browse" && m === "POST") { st.browses++; const b = JSON.parse(o.body); if (b.filter) return res(b.page > 1 ? [] : items); }
    // the subscription state a cell sets (window.__wsState), every unsubscribe and delete recorded, never reaching the backend
    if (p === "/workshop/state" && m === "POST") {
      const ids = JSON.parse(o.body).ids || [], s = window.__wsState || {}, r = {};
      st.calls.push({ p, body: { ids } });
      for (const id of ids) r[id] = s[id] ?? { subscribed: false, pending: null, inLibrary: false, onDisk: false };
      return res(r);
    }
    if ((p === "/workshop/unsubscribe" || p === "/workshop/delete-from-source" || p === "/workshop/drain" || p === "/library/trash") && m === "POST") {
      st.calls.push({ p, body: o.body ? JSON.parse(o.body) : null });
      return res(p.endsWith("source") ? { batch: "", unsubscribeInMs: 5000 } : p.endsWith("unsubscribe") ? { inLibrary: false, batch: null, unsubscribeInMs: 5000 } : { batch: "" });
    }
    if (p === "/hidden" && m === "POST") st.calls.push({ p, body: JSON.parse(o.body) });
    // which library items Steam keeps subscribed: __probe_hid_sub = { workshopId: true }
    if (p === "/library" && m === "GET" && localStorage.getItem("__probe_hid_sub")) {
      const sub = JSON.parse(localStorage.getItem("__probe_hid_sub"));
      return f(u, o).then((r) => r.json()).then((list) => res(list.map((x) => (x.workshopId && x.workshopId in sub ? { ...x, subscribed: sub[x.workshopId] } : x))));
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
const menuState = () => page(`const m = document.querySelector(${J(MENU)}); if (!m) return null; const r = m.getBoundingClientRect(), cs = getComputedStyle(m);
  return { items: [...m.querySelectorAll("[role=menuitem]")].map((b) => b.textContent.trim()), keys: [...m.querySelectorAll("[role=menuitem]")].map((b) => b.dataset.ctxItem),
    off: [...m.querySelectorAll("[role=menuitem]")].filter((b) => b.getAttribute("aria-disabled") === "true").length, note: m.querySelector("[data-ctx-note]")?.textContent ?? null,
    focus: document.activeElement?.dataset?.ctxItem ?? null, x: r.x, y: r.y, r: r.right, b: r.bottom, closing: m.classList.contains("closing"),
    bg: cs.backgroundColor, shadow: cs.boxShadow, role: m.getAttribute("role"), label: m.getAttribute("aria-label"), titles: m.querySelectorAll("[title]").length };`);
const pickAt = (k) => js(`(() => { const r = document.querySelector("[data-ctx-item=${k}]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
const sideTitle = () => js(`document.querySelector(".side-panel:not(.closing) .side-title, .side-panel:not(.closing) h2")?.textContent.trim() ?? null`);
const status = () => js(`document.querySelector(".status")?.textContent ?? ""`);
const hidden = async () => (await http("GET", "/hidden")).json;
// a right-click on card `t` at real input, then the menu as it stands
async function rightClick(t, lib = true) {
  const b = await cardBox(t, lib); if (!b) return { b: null, m: null };
  await clickAt(b.x, b.y, "right"); await sleep(350);
  return { b, m: await menuState() };
}
async function pick(k) { const p = await pickAt(k); if (!p) return false; await clickAt(p.x, p.y); await sleep(500); return true; }
const undoBtn = () => js(`(() => { const b = document.querySelector('.topbar button[aria-label="Undo"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function openFilters(lib) { await page(`const t = document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="${lib ? "library" : "browse"}"]'); if (t && t.getAttribute("aria-expanded") !== "true") t.click();`); await sleep(500); }
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
  try {
    const webs = ((await http("GET", "/sources")).json ?? []).filter(WEB);
    if (FIX) fs.writeFileSync(FIX, J(Object.fromEntries(webs.map((s, k) => [s.name, [1, 2, 3, 4].map((i) => ({ title: `web-${k}-${i}`, thumbnailUrl: "",
      pageUrl: `https://web-${k}.invalid/w/${i}`, isScene: false, resolution: "1920 x 1080" }))]))));
    // the app's own origin first: load() keeps its switches in that origin's localStorage
    await win.loadURL(withToken(U + "/"));
    await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: true, workshopDownloadMode: "subscribe" });

    await cell("menu:lib", async () => {
      const v = [];
      await load({ sub: { "900000001": true } }); await tab("Library");
      const b = await cardBox("k1");
      if (!b) return ["no k1 card — proved nothing"];
      const n0 = (await calls()).length;
      const grow = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { out.push(document.querySelector(${J(MENU)})?.getBoundingClientRect().width ?? null);
        if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      await sleep(20);
      await clickAt(b.x, b.y, "right");
      await sleep(70); await shot("menu-lib-opening");
      const ws = await grow;
      await sleep(300);
      const m = await menuState();
      console.log(`        k1: ${J(m && { items: m.items, focus: m.focus, label: m.label })} | widths ${J(ws.filter((x) => x != null).slice(0, 8).map((x) => +x.toFixed(1)))}`);
      if (!m) return [...v, "no menu after a right-click on a Library card"];
      if (J(m.items) !== J(["Hide"]) || m.role !== "menu" || m.focus !== "hide" || m.titles) v.push(`a video's menu: ${J(m)}`);
      if (Math.min(Math.abs(m.x - b.x), Math.abs(m.r - b.x)) > 2 || Math.min(Math.abs(m.y - b.y), Math.abs(m.b - b.y)) > 2) v.push(`the menu isn't at the pointer ${J({ b, m })}`);
      if (between(ws, 1) < 2) v.push(`the menu didn't grow in (widths ${J(ws.slice(0, 10))})`);
      if (await sideTitle() !== "k1") v.push(`the right-click didn't open the sidebar on k1 (${await sideTitle()})`);
      if ((await calls()).length !== n0) v.push(`the right-click sent ${J((await calls()).slice(n0))}`);
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) v.push(`the menu has no fill (${m.bg})`);
      await shot("menu-lib");
      await key("Escape"); await sleep(300);
      if (await menuState()) v.push("Escape didn't close the menu");
      if (await sideTitle() !== "k1") v.push("Escape in the menu closed the sidebar too");
      // a subscribed Workshop scene: Unsubscribe, Hide
      const s1 = await rightClick("s1");
      console.log(`        s1: ${J(s1.m?.items)}`);
      if (J(s1.m?.items) !== J(["Unsubscribe", "Hide"]) || s1.m?.focus !== "unsubscribe") v.push(`a subscribed Workshop item's menu: ${J(s1.m)}`);
      await key("Escape"); await sleep(250);
      // no-glow + bg-live: its own fill, no glow
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      await load({ sub: { "900000001": true } }); await tab("Library");
      const l = await rightClick("s1");
      const html = await js(`document.documentElement.className`);
      console.log(`        no-glow + bg-live: ${J({ html, bg: l.m?.bg, shadow: l.m?.shadow })}`);
      if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: "${html}" — proved nothing`);
      if (!l.m || /rgba\(0, 0, 0, 0\)|transparent/.test(l.m.bg)) v.push(`bg-live: the menu has no fill of its own (${l.m?.bg})`);
      if (l.m && (l.m.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((c) => !/rgba\(0, 0, 0/.test(c))) v.push(`no-glow: the menu still glows (${l.m.shadow})`);
      await shot("menu-lib-live");
      await key("Escape"); await sleep(250);
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
      return v;
    });

    await cell("menu:through", async () => {
      const v = [];
      await load(); await tab("Library");
      let r = await rightClick("k1");
      if (r.m?.label !== "k1") return [`no menu on k1 (${J(r.m)}) — proved nothing`];
      // another card's right-click with the menu open: that card's menu and sidebar
      r = await rightClick("k2");
      const n = await js(`document.querySelectorAll("${MENU}:not(.closing)").length`);
      console.log(`        a right-click on k2 with k1's menu open: ${J(r.m && { label: r.m.label, items: r.m.items })}, ${n} open, sidebar ${await sideTitle()}`);
      if (r.m?.label !== "k2" || n !== 1) v.push(`another card's right-click: menu ${J(r.m?.label)}, ${n} open (want k2's alone)`);
      if (await sideTitle() !== "k2") v.push(`the sidebar didn't follow to k2 (${await sideTitle()})`);
      // a press on the sidebar with the menu open does its own thing: the sidebar's close
      const x = await js(`(() => { const b = document.querySelector(".side-panel:not(.closing) .side-close, .side-panel:not(.closing) [aria-label='Close']"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!x) return [...v, "no close button on the sidebar"];
      await clickAt(x.x, x.y); await sleep(500);
      if (await js(`!!document.querySelector("${MENU}:not(.closing)")`)) v.push("a press outside left the menu open");
      if (await sideTitle()) v.push("the press on the sidebar's close didn't reach it (the menu ate it)");
      // a key the menu doesn't use goes on to the page: Ctrl+A selects every card
      r = await rightClick("k3");
      if (r.m?.label !== "k3") return [...v, `no menu on k3 before Ctrl+A (${J(r.m)}) — the key's way through proved nothing`];
      send({ type: "keyDown", keyCode: "A", modifiers: ["control"] }); send({ type: "char", keyCode: "a", modifiers: ["control"] }); send({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
      await sleep(400);
      const sel = await js(`document.querySelectorAll(".lib-scroll .card.selected").length`), cards = await js(`document.querySelectorAll(".lib-scroll .card:not([data-leaving])").length`);
      if (await js(`!!document.querySelector("${MENU}:not(.closing)")`)) v.push("Ctrl+A left the menu open");
      if (sel !== cards) v.push(`Ctrl+A with the menu open selected ${sel} of ${cards}`);
      await key("Escape"); await sleep(300);
      // ← → with the menu open: the menu goes, the grid's focus (the sidebar) steps to the next card as without it
      r = await rightClick("k1");
      if (r.m?.label !== "k1") return [...v, `no menu on k1 before → (${J(r.m)}) — proved nothing`];
      await key("Right"); await sleep(500);
      if (await js(`!!document.querySelector("${MENU}:not(.closing)")`)) v.push("→ left the menu open");
      if (await sideTitle() !== "k2") v.push(`→ with the menu open moved the sidebar to ${await sideTitle()} (want k2, the next card)`);
      return v;
    });

    await cell("menu:libOff", async () => {
      const v = [];
      await setSettings({ morphs: false });
      try {
        await load(); await tab("Library");
        const b = await cardBox("k2");
        if (!b) return ["no k2 card — proved nothing"];
        await mvTo(b.x, b.y, 300);
        let smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
        await clickAt(b.x, b.y, "right");
        const sIn = await smp;
        await sleep(200);
        smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
        await key("Escape");
        const sOut = await smp;
        console.log(`        motion off: in ${MO.brief(sIn.menu)} / out ${MO.brief(sOut.menu)}`);
        v.push(...MO.judge("motion off: the card's menu appearing", sIn.menu, { appear: true }), ...MO.judge("motion off: the card's menu leaving", sOut.menu, { leave: true }));
      } finally { await setSettings({ morphs: true }); }
      return v;
    });

    await cell("menu:browse", async () => {
      const v = [];
      await load();
      const ws = await browseSource(WS);
      if (!ws) return ["no Workshop source — proved nothing"];
      const { m } = await rightClick("ws-1", false);
      console.log(`        Workshop card: ${J(m?.items)}`);
      if (J(m?.items) !== J(["Unsubscribe", "Hide"]) || m?.focus !== "unsubscribe") v.push(`the Workshop card's menu: ${J(m)}`);
      if (await sideTitle() !== "ws-1") v.push(`the right-click didn't open the Browse sidebar on ws-1 (${await sideTitle()})`);
      await shot("menu-browse");
      await key("Escape"); await sleep(250);
      const web = await browseSource(WEB);
      if (!web) { v.push("no web source — its card unproved"); return v; }
      const first = (await titles(false))[0];
      const w = await rightClick(first, false);
      console.log(`        ${web.name} card ${first}: ${J(w.m?.items)}`);
      if (J(w.m?.items) !== J(["Hide"])) v.push(`a web source's card menu: ${J(w.m)}`);
      await key("Escape"); await sleep(250);
      return v;
    });

    await cell("hide:lib", async () => {
      const v = [];
      await load(); await tab("Library");
      const r = await rightClick("k1");
      if (J(r.m?.items) !== J(["Hide"])) return [`k1's menu: ${J(r.m)} — proved nothing`];
      const p = await pickAt("hide");
      const n0 = (await calls()).length;
      const SEL = `[...document.querySelectorAll(".lib-scroll .card")].find((c) => c.querySelector('[data-title="k1"]'))`;
      const ops = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const c = ${SEL};
        out.push(c ? +getComputedStyle(c).opacity : null); if (performance.now() - t0 < 900) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      await sleep(20);
      await clickAt(p.x, p.y); await sleep(90); await shot("hide-lib");
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
      if (await sideTitle() === "k1") v.push("the sidebar still shows the hidden card");
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

    await cell("hide:multi", async () => {
      const v = [];
      await load(); await tab("Library");
      for (const t of ["k2", "k3", "k4"]) { const b = await cardBox(t); if (!b) { v.push(`no card ${t}`); continue; } await clickAt(b.x, b.y, "left", ["control"]); await sleep(200); }
      const nSel = await js(`document.querySelectorAll(".lib-scroll .card:not([data-leaving]).selected").length`);
      if (nSel !== 3) return [...v, `Ctrl-clicks selected ${nSel} cards — proved nothing`];
      // a card outside the selection: its own menu
      let r = await rightClick("k1");
      if (J(r.m?.items) !== J(["Hide"])) v.push(`a card outside the selection: ${J(r.m?.items)} (want its own "Hide")`);
      await key("Escape"); await sleep(250);
      r = await rightClick("k3");
      console.log(`        on the selection: ${J(r.m?.items)} | ${await js(`document.querySelectorAll(".lib-scroll .card.selected").length`)} selected`);
      if (J(r.m?.items) !== J(["Hide 3"])) v.push(`the selection's menu: ${J(r.m?.items)} (want "Hide 3")`);
      if (!(await pick("hide"))) return [...v, "no Hide entry to pick"];
      await sleep(400);
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
      await page(`document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="library"]')?.click();`); await sleep(500); // the filters closed: the menu's sidebar side
      const r = await rightClick("k2");
      if (!(await pick("hide"))) return [...v, `no Hide to pick (${J(r.m)})`];
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
      // ✓ again: Unhide in the menu
      await seg("inc");
      await page(`document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="library"]')?.click();`); await sleep(500);
      const u = await rightClick("k2");
      console.log(`        a hidden card's menu: ${J(u.m?.items)}`);
      if (J(u.m?.items) !== J(["Unhide"])) v.push(`a hidden card's menu: ${J(u.m?.items)} (want "Unhide")`);
      const n0 = (await calls()).length;
      if (await pick("unhide")) {
        await sleep(500);
        const posted = (await calls()).slice(n0).filter((c) => c.p === "/hidden");
        if (posted.length !== 1 || J(posted[0].body.unhide?.length) !== "1") v.push(`Unhide posted ${J(posted)}`);
        if (Object.keys((await hidden()).library).length) v.push("the backend still holds k2 after Unhide");
        if ((await titles()).length) v.push(`the Hidden view still shows ${J(await titles())}`);
        if (!(await js(`!!document.querySelector(".lib-scroll [data-wf-none]")`))) v.push("the empty Hidden view says nothing");
        if ((await status()) !== "Unhidden: k2") v.push(`the status says "${await status()}"`);
      } else v.push("no Unhide entry to pick");
      // the row off: k2 in the grid again
      await openFilters(true); await seg("off");
      if (!(await titles()).includes("k2")) v.push("after Unhide and the row off, k2 isn't in the grid");
      return v;
    });

    await cell("hide:browse", async () => {
      const v = [];
      await load();
      if (!(await browseSource(WS))) return ["no Workshop source — proved nothing"];
      const r = await rightClick("ws-2", false);
      if (!(await pick("hide"))) return [`no Hide to pick (${J(r.m)})`];
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
      await page(`document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="browse"]')?.click();`); await sleep(500);
      const u = await rightClick("ws-2", false);
      if (J(u.m?.items) !== J(["Unsubscribe", "Unhide"])) v.push(`the hidden Workshop card's menu: ${J(u.m?.items)}`);
      if (!(await pick("unhide"))) v.push("no Unhide to pick");
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
      await rightClick(first, false);
      if (!(await pick("hide"))) return [...v, "no Hide to pick"];
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
      await page(`document.querySelector('[data-sortsplit] [data-wf-toggle][data-wf-page="browse"]')?.click();`); await sleep(500);
      await rightClick(first, false);
      if (!(await pick("unhide"))) v.push("no Unhide to pick");
      await openFilters(false); await seg("off"); await sleep(500);
      if (await tog()) v.push("the filter toggle stays with nothing hidden and the row off");
      if (!(await titles(false)).includes(first)) v.push(`${first} isn't back in the list`);
      return v;
    });

    await cell("unsub:lib", async () => {
      const v = [];
      await load({ sub: { "900000001": true } }); await tab("Library");
      const r = await rightClick("s1");
      if (J(r.m?.items) !== J(["Unsubscribe", "Hide"])) return [`s1's menu: ${J(r.m?.items)} — proved nothing`];
      const n0 = (await calls()).length;
      await pick("unsubscribe"); await sleep(500);
      const got = (await calls()).slice(n0).filter((c) => c.p !== "/workshop/drain");
      console.log(`        Unsubscribe: ${J(got.map((c) => [c.p, c.body?.items?.map((i) => i.title)]))} | "${await status()}"`);
      if (got.length !== 1 || got[0].p !== "/workshop/delete-from-source" || J(got[0].body?.items?.map((i) => i.title)) !== J(["s1"])) v.push(`Unsubscribe posted ${J(got)}`);
      if ((await status()) !== "Unsubscribing from s1. Undo brings it back.") v.push(`the status says "${await status()}"`);
      return v;
    });

    await cell("unsub:browse", async () => {
      const v = [];
      await load();
      if (!(await browseSource(WS))) return ["no Workshop source — proved nothing"];
      await js(`window.__wsState = { "940000": { subscribed: true, pending: null, inLibrary: false, onDisk: true } }; true`);
      // (the right-click's sidebar reads the state for its own Unsubscribe; the menu asks again at the pick)
      await rightClick("ws-1", false); await sleep(300);
      let n0 = (await calls()).length;
      await pick("unsubscribe"); await sleep(500);
      let got = (await calls()).slice(n0).map((c) => [c.p, c.body?.workshopId ?? c.body?.ids ?? null]);
      console.log(`        subscribed: ${J(got)}`);
      const un = got.filter((c) => c[0] === "/workshop/unsubscribe");
      if (got[0]?.[0] !== "/workshop/state" || J(un) !== J([["/workshop/unsubscribe", "940000"]])) v.push(`a subscribed card's Unsubscribe: ${J(got)} (want the state asked, then one unsubscribe)`);
      await rightClick("ws-2", false); await sleep(300);
      n0 = (await calls()).length;
      await pick("unsubscribe"); await sleep(500);
      got = (await calls()).slice(n0).map((c) => c.p);
      if (got.includes("/workshop/unsubscribe")) v.push(`a card not subscribed posted an unsubscribe ${J(got)}`);
      if ((await status()) !== "Not subscribed to ws-2") v.push(`the status says "${await status()}"`);
      return v;
    });

    await cell("unsub:signedOut", async () => {
      const v = [];
      await setSettings({ workshopDownloadMode: "subscribe" });
      await load({ status: SIGNED_OUT, sub: { "900000001": true } }); await tab("Library");
      let r = await rightClick("s1");
      console.log(`        Library, signed out: ${J(r.m && { items: r.m.items, off: r.m.off, note: r.m.note })}`);
      if (J(r.m?.items) !== J(["Unsubscribe", "Hide"]) || r.m?.off || r.m?.note) v.push(`the Library's menu signed out: ${J(r.m)}`);
      let n0 = (await calls()).length;
      await pick("unsubscribe"); await sleep(500);
      if (!(await calls()).slice(n0).some((c) => c.p === "/workshop/delete-from-source")) v.push(`the Library's Unsubscribe signed out posted ${J((await calls()).slice(n0))}`);
      if (!(await browseSource(WS))) return [...v, "no Workshop source"];
      await js(`window.__wsState = { "940000": { subscribed: true, pending: null, inLibrary: false, onDisk: true } }; true`);
      r = await rightClick("ws-1", false);
      if (r.m?.off || r.m?.note) v.push(`Browse's menu signed out: ${J(r.m)}`);
      n0 = (await calls()).length;
      await pick("unsubscribe"); await sleep(500);
      if (!(await calls()).slice(n0).some((c) => c.p === "/workshop/unsubscribe")) v.push(`Browse's Unsubscribe signed out posted ${J((await calls()).slice(n0))}`);
      await shot("unsub-signedout");
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
