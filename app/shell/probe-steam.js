// Steam sign-in + "Subscribe via Steam" without a sign-in — `scripts/test-ui-matrix.sh --probe probe-steam.js` (the matrix's
// hermetic stack). Owner 2026-11-11: "is it a dead end for users without mobile guard?" → a password sign-in (SteamPasswordModal)
// next to the QR one, and Workshop downloads that open in the Steam app when there's no usable sign-in. NOTHING here reaches
// Steam: a script injected before the page's own (CDP Page.addScriptToEvaluateOnNewDocument) answers /steam/status (the state
// a cell wants), /steam/login* and /steam/qr/* itself (recording each body), stubs POST /browse (Workshop items) and /download
// (held until the cell lets go / cancels), wraps WebSocket so a cell can push fake WS events (steam-login-code, steam-signed-in,
// steam-login-error, download-progress) through the page's own socket, and records every request body + console line.
//   steam:row:signedOut   Settings → Getting Workshop wallpapers → Steam: "Not signed in — downloads open in the Steam app…",
//                         Sign in with QR + Sign in with password; no tooltips
//   steam:row:rejected    a sign-in Steam turned down: the warning (in the warn colour), both sign-in buttons, no Sign out
//   steam:row:signedIn    "Signed in as …" + Sign out, no sign-in buttons
//   steam:row:steamcmd    "Download via steamcmd" → no Steam row (the steamcmd rows instead)
//   look:toggles          every Settings checkbox / radio is the themed control: dark when off, accent when on, the tick centred
//                         (pixels); a click anywhere on a checkbox / radio row ticks it, a slider row's name doesn't
//                         (shots steam-toggles.png, steam-tick.png)
//   steam:row:steamApp    the four download-mode radios (steamapp, steampage, subscribe, steamcmd): a click saves each, the
//                         Steam app's note, the sign-in row only under subscribe
//   steam:modal:email     the password button → the modal (a labelled dialog: account name autocomplete=username focused,
//                         password type=password autocomplete=current-password); real typing + Enter → POST /steam/login once
//                         with both, the field emptied at once, "Signing in…"; WS email step → its text + the hint, the code field
//                         focused; a code → POST /steam/login/code; retry → "That code wasn't right"; steam-signed-in → closed,
//                         the row says signed in; the password nowhere (DOM, input values, storage, console, other requests,
//                         WS sends, status bar)
//   steam:modal:device    the authenticator step's text + label
//   steam:modal:confirm   approve-in-the-app: its text, "Waiting for your approval…", a code field too; signed-in closes it
//   steam:modal:error     steam-login-error → back to step 1, the message inline (role=alert), the account name kept, the password
//                         field empty + focused; a refused start (400 {error}: Steam's rate limit) shows its words, no retry
//   steam:modal:cancel    Escape on a code step → closed + POST /steam/login/cancel; a click outside doesn't close it; Cancel
//   steam:modal:keys      Tab order account → password → Cancel → Sign in; nothing in the modal has a title (tooltip)
//   steam:dlStatus        a Workshop download from the Browse sidebar while the backend waits on the Steam app: the sidebar and the
//                         status bar show download-progress's status ("…click Subscribe in Steam…"); the card the step in short
//                         words over a sweeping bar (each phase, + "In the Steam to-do" / "Waiting for the Steam app…"); Cancel
//                         aborts the request
//   steam:todo            the Steam to-do panel (components/SteamTodoPanel.tsx) for a fake WS steam-todo: "Subscribe in Steam · 2 of
//                         5", the title, the hint, Done — next / Open again / Skip / Stop + "Let the Steam app do all 4" (remaining);
//                         no tooltips, aria-label on the icon-only fold, fixed bottom-right on <body> above the item sidebar; each
//                         button → one POST /steam-todo/<action>; folds to a pill; the last entry: "Done", no Steam-app line, the
//                         message; gone after `finished`; the "Let the Steam app" note (needs WE, shows you playing). Shot
//                         steam-todo.png
//   steam:todoMotion:on|off  per frame: a playlist bar appearing → the dock's translateY passes through in-between values; fold /
//                         unfold → the panel's height too; the chevron is one icon turned 180°; a new current entry → its x off
//                         its place for ≥ 3 frames. off (Smooth window animations off): all instant. Mid-animation shots
//                         steam-todo-glide.png / -fold.png / -slide.png
//   steam:subToggle:workshop  the Browse sidebar's subscription toggle per a stubbed /workshop/state: Not subscribed → Subscribe
//                         (POST /workshop/subscribe {workshopId, title}) → Subscribing… + the bar (WS subscribe-progress) →
//                         Subscribed (danger Unsubscribe) → in the library: "also removes it from your library" → Unsubscribe
//                         (POST) → Unsubscribing…; Open on Steam → POST /steam/open-page, ok:false → window.open(https page)
//   steam:subToggle:weLocal   a WE-local item: Subscribed → Unsubscribe → "Unsubscribed" (folder still there), the words slide
//                         (per frame); no-glow (the chip's glow off) + bg-live (the card keeps its own fill). Shots steam-subtoggle*.png
// Screenshots: <LIASCAPE_OUT>/steam-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
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
const PASSWORD = "Pr0be-pa55-Zq9!xK";
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
async function setSettings(patch) { await http("POST", "/settings", patch); } // a partial body merges (PATCH)

// runs in the page before its own scripts (every load)
const STUB = `(() => {
  const st = { calls: [], bodies: [], wsSent: [], dl: null };
  try { st.status = JSON.parse(localStorage.getItem("__probe_steam_status") || "null"); } catch { st.status = null; }
  st.status ??= { signedIn: false, rejected: false, accountName: "", daysLeft: null, mode: "subscribe" };
  window.__st = st;
  const OrigWS = window.WebSocket, sockets = [];
  window.WebSocket = class extends OrigWS {
    constructor(...a) { super(...a); sockets.push(this); }
    send(d) { st.wsSent.push(String(d)); return super.send(d); }
  };
  window.__fakeWs = (type, payload) => { let n = 0; for (const s of sockets) if (s.readyState === 1 && s.onmessage) { s.onmessage({ data: JSON.stringify({ type, payload }) }); n++; } return n; };
  const items = Array.from({ length: 6 }, (_, i) => ({ title: "ws-" + (i + 1), thumbnailUrl: "", animatedThumbnailUrl: null,
    pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + (930000 + i), resolution: "1920 x 1080", isScene: false,
    workshopId: String(930000 + i), addedAt: null, description: "fake", authorName: "probe", fileSizeBytes: 1000, subscriptions: 1,
    favorites: 1, views: 1, tags: ["Anime"], trailerKnown: true }));
  const f = window.fetch.bind(window);
  window.fetch = (u, o = {}) => {
    const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    const m = (o.method || "GET").toUpperCase();
    st.bodies.push({ p, m, body: typeof o.body === "string" ? o.body : null });
    const res = (b, status = 200) => Promise.resolve(new Response(b == null ? "" : JSON.stringify(b), { status, headers: b == null ? {} : { "Content-Type": "application/json" } }));
    if (p === "/steam/status") return res(st.status);
    if (p.startsWith("/steam/")) {
      st.calls.push({ p, body: o.body ? JSON.parse(o.body) : null });
      const r = (window.__replies || {})[p];
      return r ? res(r.body, r.status) : res(null);
    }
    // the Steam to-do: idle at load, every button's POST recorded (steam:todo)
    if (p === "/steam-todo") return res({ finished: true });
    if (p.startsWith("/steam-todo/") && m === "POST") { st.calls.push({ p, body: null }); return res(p.endsWith("use-steam-app") ? { error: null } : null); }
    // the Browse sidebar's subscription toggle (steam:subToggle): the state a cell sets in window.__wsState, every write recorded
    if (p === "/workshop/state" && m === "POST") {
      const ids = JSON.parse(o.body).ids || [], s = window.__wsState || {}, r = {};
      for (const id of ids) r[id] = s[id] ?? { subscribed: false, pending: null, inLibrary: false, onDisk: false };
      return res(r);
    }
    if ((p === "/workshop/subscribe" || p === "/workshop/unsubscribe") && m === "POST") {
      st.calls.push({ p, body: JSON.parse(o.body) });
      return res(p.endsWith("unsubscribe") ? { inLibrary: !!(window.__wsState?.[JSON.parse(o.body).workshopId]?.inLibrary), batch: null }
        : { subscribed: false, inSteamTodo: true, message: "Click Subscribe in Steam, then Next…" });
    }
    if (p === "/browse" && m === "POST") {
      const b = JSON.parse(o.body); if (b.filter) return res(b.page > 1 ? [] : items);
      // a fake Wallpaper Engine (Local) folder (steam:subToggle): local page paths + Workshop ids
      if (localStorage.getItem("__probe_we_local") === "1") return res(b.page > 1 ? [] : items.map((x, i) => ({ ...x, title: "we-" + (i + 1),
        pageUrl: "/tmp/probe-we/" + (931000 + i), workshopId: String(931000 + i), description: null, subscriptions: null, favorites: null, views: null })));
    }
    if (p === "/detail" && m === "POST") return res({ title: "x", previewUrl: "", downloadUrl: "", needsReferrer: false });
    if (p === "/download" && m === "POST") {
      return new Promise((resolve, reject) => {
        st.dl = { body: JSON.parse(o.body), aborted: false, resolve };
        o.signal?.addEventListener("abort", () => { st.dl.aborted = true; reject(new DOMException("aborted", "AbortError")); });
      });
    }
    return f(u, o);
  };
})();`;

let win;
const consoleLines = [];
const js = (code) => win.webContents.executeJavaScript(code);
const page = (code) => js(`(async () => { ${code} })()`);
const send = (e) => win.webContents.sendInputEvent(e);
async function key(k, mods = []) { send({ type: "keyDown", keyCode: k, modifiers: mods }); if (k === "Enter") send({ type: "char", keyCode: "\r" }); send({ type: "keyUp", keyCode: k, modifiers: mods }); await sleep(60); }
async function type(text) { await win.webContents.insertText(text); await sleep(60); }
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `steam-${name}.png`), img.toPNG()); }

async function load(status) {
  await js(`localStorage.setItem("__probe_steam_status", ${J(J(status ?? null))}); true`).catch(() => {});
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
  for (let i = 0; i < 50; i++) { if (await js(`window.__fakeWs ? window.__fakeWs("noop", null) : 0`) > 0) break; await sleep(100); } // the page's socket is open
  await sleep(300);
}
async function tab(name) { await page(`[...document.querySelectorAll(".tab")].find((e) => e.textContent.trim() === ${J(name)})?.click();`); await sleep(500); }
const ev = (type, payload) => js(`window.__fakeWs(${J(type)}, ${J(payload)})`);
const steamRow = () => page(`const r = document.querySelector("[data-steam-state]"); if (!r) return null;
  const btn = (k) => r.querySelector('[data-steam-signin="' + k + '"]');
  const warn = r.querySelector(".s-warn-text");
  return { state: r.dataset.steamState, text: r.textContent, qr: !!btn("qr"), pw: !!btn("password"),
    signOut: [...r.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign out"),
    titles: [...r.querySelectorAll("[title]")].length, warnColor: warn ? getComputedStyle(warn).color : null,
    mutedColor: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() };`);
const modal = () => page(`const m = document.querySelector("[data-steam-pw-modal]"); if (!m) return null;
  const a = document.activeElement;
  return { step: m.dataset.step, text: m.textContent, role: m.getAttribute("role"), aria: m.getAttribute("aria-modal"),
    labelled: !!document.getElementById(m.getAttribute("aria-labelledby") || "-"),
    focus: a ? (a.dataset.steamPw !== undefined ? "password" : a.dataset.steamPwCode !== undefined ? "code" : a.name || a.tagName) : null,
    pwVal: m.querySelector("[data-steam-pw]")?.value ?? null, user: m.querySelector('input[name="username"]')?.value ?? null,
    err: m.querySelector("[data-steam-pw-error]")?.textContent ?? null, errRole: m.querySelector("[data-steam-pw-error]")?.getAttribute("role") ?? null,
    submit: m.querySelector("[data-steam-pw-submit]")?.textContent.trim() ?? null, titles: m.querySelectorAll("[title]").length };`);
const calls = () => js(`window.__st.calls`);
async function waitFor(fn, ms = 3000) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(60); } return v; }

// the password must be nowhere but the one /steam/login body
async function leakCheck(v, logins = 1) { // logins = how many sign-ins the cell submitted (each one /steam/login body)
  const r = await page(`const pw = ${J(PASSWORD)}; const st = window.__st;
    const inputs = [...document.querySelectorAll("input")].filter((i) => i.value.includes(pw)).length;
    const storage = [localStorage, sessionStorage].some((s) => Object.keys(s).some((k) => k.includes(pw) || (s.getItem(k) || "").includes(pw)));
    const bodies = st.bodies.filter((b) => (b.body || "").includes(pw)).map((b) => b.p);
    return { dom: document.documentElement.outerHTML.includes(pw) || document.body.innerText.includes(pw), inputs, storage, bodies,
      ws: st.wsSent.some((s) => s.includes(pw)), status: (document.querySelector(".status")?.textContent || "").includes(pw) };`);
  if (r.dom) v.push("the password is in the DOM");
  if (r.inputs) v.push(`the password is still in ${r.inputs} input value(s)`);
  if (r.storage) v.push("the password is in local/session storage");
  if (r.bodies.some((p) => p !== "/steam/login") || r.bodies.length !== logins) v.push(`the password went in ${r.bodies.length} request bodies (${logins} sign-in(s)): ${r.bodies.join(", ")}`);
  if (r.ws) v.push("the password went over the WebSocket");
  if (r.status) v.push("the password is in the status bar");
  if (consoleLines.some((l) => l.includes(PASSWORD))) v.push("the password is in the console");
}

async function openPw() {
  await tab("Settings");
  await page(`document.querySelector('[data-steam-signin="password"]').click();`);
  return (await waitFor(async () => { const m = await modal(); return m && m.focus === "username" ? m : null; }, 2000)) || modal();
}
async function credentials(user = "probe-user") { await type(user); await key("Tab"); await type(PASSWORD); await key("Enter"); await sleep(250); }

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (...a) => { const m = a[0]?.message ?? a[2]; consoleLines.push(String(m)); });
  // the debugger needs a renderer: a window that never loaded anything has none (CDP commands then never answer)
  await win.loadURL("about:blank");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Page.enable");
  await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  console.log("== stub installed");
  const results = [];
  const cell = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await Promise.race([fn(), sleep(90000).then(() => ["ERROR the cell took over 90 s"])]); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  const SIGNED_OUT = { signedIn: false, rejected: false, accountName: "", daysLeft: null, mode: "subscribe" };
  try {
    await setSettings({ workshopDownloadMode: "subscribe", autoAddWeWallpapersToLibrary: false, morphs: true, glows: true });
    await win.loadURL(withToken(U + "/")); await sleep(500);

    await cell("steam:row:signedOut", async () => {
      const v = []; await load(SIGNED_OUT); await tab("Settings");
      const r = await steamRow(); console.log(`        ${J(r)}`);
      if (!r) return ["no Steam row"];
      if (r.state !== "signed-out") v.push(`state ${r.state}`);
      if (!/Not signed in/.test(r.text) || !/Steam app/.test(r.text) || !/Subscribe/.test(r.text)) v.push(`the row doesn't say downloads go through the Steam app: "${r.text}"`);
      if (!r.qr || !r.pw) v.push(`sign-in buttons: qr ${r.qr}, password ${r.pw}`);
      if (r.titles) v.push(`${r.titles} tooltip(s) in the row`);
      await page(`const el = document.querySelector("[data-steam-state]"), sc = el.closest(".scroll"); sc.scrollTop += el.getBoundingClientRect().top - innerHeight / 2;`); await sleep(900); await shot("row-signed-out");
      return v;
    });
    await cell("steam:row:rejected", async () => {
      const v = []; await load({ signedIn: true, rejected: true, accountName: "acct1", daysLeft: 120, mode: "subscribe" }); await tab("Settings");
      const r = await steamRow(); console.log(`        ${J(r)}`);
      if (!r) return ["no Steam row"];
      if (r.state !== "rejected") v.push(`state ${r.state}`);
      if (!/signed acct1 out/.test(r.text) || !/Steam app/.test(r.text)) v.push(`text: "${r.text}"`);
      if (!r.qr || !r.pw) v.push(`sign-in buttons: qr ${r.qr}, password ${r.pw}`);
      if (r.signOut) v.push("a Sign out button on a rejected sign-in");
      if (!r.warnColor) v.push("no warning text");
      await page(`const el = document.querySelector("[data-steam-state]"), sc = el.closest(".scroll"); sc.scrollTop += el.getBoundingClientRect().top - innerHeight / 2;`); await sleep(900); await shot("row-rejected");
      return v;
    });
    await cell("steam:row:signedIn", async () => {
      const v = []; await load({ signedIn: true, rejected: false, accountName: "acct2", daysLeft: 150, mode: "subscribe" }); await tab("Settings");
      const r = await steamRow(); console.log(`        ${J(r)}`);
      if (!r) return ["no Steam row"];
      if (r.state !== "signed-in" || !/Signed in as acct2/.test(r.text)) v.push(`state ${r.state}: "${r.text}"`);
      if (!r.signOut) v.push("no Sign out");
      if (r.qr || r.pw) v.push("sign-in buttons while signed in");
      return v;
    });
    await cell("steam:row:steamcmd", async () => {
      const v = []; await setSettings({ workshopDownloadMode: "steamcmd" }); await load(SIGNED_OUT); await tab("Settings");
      if (await steamRow()) v.push("the Steam row shows under steamcmd");
      if (!(await page(`return !!document.querySelector('[placeholder="/usr/bin/steamcmd"]');`))) v.push("no steamcmd path row");
      await setSettings({ workshopDownloadMode: "subscribe" });
      return v;
    });

    // owner 2026-11-11 ("drive steam" → "yeah, try it", then "why is this a checkbox"): "Use the Steam app" is the FIRST of the
    // three download-mode radios; picking it saves workshopDownloadMode "steamapp", shows its note and hides the Steam
    // sign-in row (only Subscribe via Steam uses it)
    await cell("steam:row:steamApp", async () => {
      const v = []; await setSettings({ workshopDownloadMode: "subscribe" }); await load(SIGNED_OUT); await tab("Settings");
      const radios = await page(`return [...document.querySelectorAll("[data-wsmode]")].map((r) => ({ m: r.dataset.wsmode, type: r.type, name: r.closest(".srow")?.textContent.slice(0, 40) }));`);
      console.log(`        ${J(radios)}`);
      if (radios.map((r) => r.m).join() !== "steamapp,steampage,subscribe,steamcmd" || radios.some((r) => r.type !== "radio"))
        v.push(`the modes: ${J(radios)} (expected four radios steamapp, steampage, subscribe, steamcmd)`);
      await page(`document.querySelector('[data-wsmode="steamapp"]').click();`); await sleep(900); // the debounced save
      const saved = (await http("GET", "/settings")).json?.workshopDownloadMode;
      if (saved !== "steamapp") v.push(`a click saved workshopDownloadMode = ${saved}`);
      const after = await page(`return { checked: document.querySelector('[data-wsmode="steamapp"]').checked,
        note: /Needs Steam running/.test(document.querySelector(".settings")?.textContent ?? ""), steamRow: !!document.querySelector("[data-steam-state]") };`);
      if (!after.checked) v.push("the radio isn't checked after the click");
      if (!after.note) v.push("no note under Use the Steam app");
      if (after.steamRow) v.push("the Steam sign-in row shows under Use the Steam app");
      // "Open in the Steam app": saved, no sign-in row either
      await page(`document.querySelector('[data-wsmode="steampage"]').click();`); await sleep(900);
      const saved2 = (await http("GET", "/settings")).json?.workshopDownloadMode;
      if (saved2 !== "steampage") v.push(`the Open in the Steam app click saved ${saved2}`);
      if (await page(`return !!document.querySelector("[data-steam-state]");`)) v.push("the Steam sign-in row shows under Open in the Steam app");
      await setSettings({ workshopDownloadMode: "subscribe" });
      return v;
    });

    // owner 2026-11-11 ("i wonder if a white checkbox matches the rest of the app or we just overlooked this part of the ui"):
    // every Settings checkbox + radio is the app's themed control — dark when off (never the browser's white), the accent when on
    await cell("look:toggles", async () => {
      const v = []; await setSettings({ workshopDownloadMode: "subscribe" }); await load(SIGNED_OUT); await tab("Settings");
      const r = await page(`const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const k = c.startsWith("color(") ? 1 : 255; /* color(srgb …) is 0–1, rgb() 0–255 */ return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / k; };
        const all = [...document.querySelectorAll('.settings input[type=checkbox], .settings input[type=radio]')];
        const info = (e) => { const cs = getComputedStyle(e); return { type: e.type, checked: e.checked, appearance: cs.appearance, bg: cs.backgroundColor, lum: +lum(cs.backgroundColor).toFixed(2), border: cs.borderColor }; };
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        return { n: all.length, accent, off: all.filter((e) => !e.checked).slice(0, 40).map(info), onBox: all.filter((e) => e.checked && e.type === "checkbox").slice(0, 3).map(info),
          onRadio: all.filter((e) => e.checked && e.type === "radio").slice(0, 3).map(info) };`);
      console.log(`        ${r.n} controls; off e.g. ${J(r.off[0])}; on box ${J(r.onBox[0])}; on radio ${J(r.onRadio[0])}`);
      if (r.n < 10) v.push(`only ${r.n} checkboxes / radios in Settings`);
      const native = [...r.off, ...r.onBox, ...r.onRadio].filter((c) => c.appearance !== "none");
      if (native.length) v.push(`${native.length} still the browser's own control (appearance ${native[0].appearance})`);
      const white = r.off.filter((c) => c.lum > 0.5);
      if (white.length) v.push(`${white.length} unchecked controls are light (e.g. ${white[0].bg})`);
      if (r.onBox[0] && r.onBox[0].lum < 0.05) v.push(`a ticked checkbox isn't filled (${r.onBox[0].bg})`);
      // the tick's own pixels, centred in its box (owner: "is it just me or the tick is off-center") — a ticked box, captured
      // at the device scale, the tick = pixels much darker than the accent fill around it
      const box = await page(`const e = [...document.querySelectorAll('.settings input[type=checkbox]')].find((x) => x.checked);
        if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      if (!box) v.push("no ticked checkbox in Settings to measure");
      else {
        await sleep(300);
        const b2 = await page(`const e = [...document.querySelectorAll('.settings input[type=checkbox]')].find((x) => x.checked); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
        const img = await win.webContents.capturePage({ x: Math.floor(b2.x), y: Math.floor(b2.y), width: Math.ceil(b2.w) + 1, height: Math.ceil(b2.h) + 1 });
        const { width: W, height: H } = img.getSize(), px = img.toBitmap(); // BGRA
        const sc = W / (Math.ceil(b2.w) + 1);
        // the fill = the most common colour inside; tick pixels = far from it (≥ 120 in summed channel distance)
        const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
        const inset = Math.round(3 * sc), fill = at(Math.round(W / 2), inset);
        // the tick's BOUNDING box (what the eye holds against the box's edges — its centre of mass sits ~½ px low by shape:
        // the long arm outweighs the short one)
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, sw = 0;
        for (let y = inset; y < H - inset; y++) for (let x = inset; x < W - inset; x++) {
          const c = at(x, y), d = Math.abs(c[0] - fill[0]) + Math.abs(c[1] - fill[1]) + Math.abs(c[2] - fill[2]);
          if (d >= 200) { sw++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        // box centre in captured pixels: the element starts at (b2.x − floor(b2.x)) inside the capture
        const cx = ((b2.x - Math.floor(b2.x)) + b2.w / 2) * sc, cy = ((b2.y - Math.floor(b2.y)) + b2.h / 2) * sc;
        const tx = sw ? (x0 + x1 + 1) / 2 : NaN, ty = sw ? (y0 + y1 + 1) / 2 : NaN;
        const dx = (tx - cx) / sc, dy = (ty - cy) / sc;
        console.log(`        tick's bounding box off the box centre by (${dx.toFixed(2)}, ${dy.toFixed(2)}) css px (${Math.round(sw)} tick px, scale ${sc.toFixed(2)})`);
        fs.writeFileSync(path.join(OUT, "steam-tick.png"), img.resize({ width: W * 8, quality: "good" }).toPNG());
        if (!sw) v.push("no tick pixels found in a ticked box");
        // ±0.5 css px: at most half a pixel of rounding
        else if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) v.push(`the tick is off-centre by (${dx.toFixed(2)}, ${dy.toFixed(2)}) css px`);
      }
      // owner 2026-11-11 ("clicking on name or the entire box of a specific setting should tick/untick it?"): a real click on a
      // radio row's HINT text picks it, on a checkbox row's NAME flips it (twice: back); a slider row's name changes nothing
      const rowPt = (sel, part) => page(`const row = ${sel}; if (!row) return null; row.scrollIntoView({ block: "center" });
        const t = row.querySelector(${J(part)}); const r = t.getBoundingClientRect(); return { x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2 };`);
      const click = async (p) => { win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: 1 });
        win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: 1 }); await sleep(900); };
      const pageRow = `document.querySelector('[data-wsmode="steampage"]')?.closest(".srow")`;
      let pt = await rowPt(pageRow, ".shint"); await sleep(300); pt = await rowPt(pageRow, ".shint");
      if (!pt) v.push("no Open in the Steam app row");
      else { await click(pt); const m = (await http("GET", "/settings")).json?.workshopDownloadMode;
        if (m !== "steampage") v.push(`a click on the radio row's hint saved ${m} (expected steampage)`); }
      const ckRow = `[...document.querySelectorAll(".srow[data-row-toggle]")].find((r) => r.querySelector('input[type=checkbox]:not(:disabled)'))`;
      const before = await page(`return ${ckRow}?.querySelector("input").checked ?? null;`);
      pt = await rowPt(ckRow, ".slabel-row"); await sleep(300); pt = await rowPt(ckRow, ".slabel-row");
      if (before === null || !pt) v.push("no checkbox row to click");
      else {
        await click(pt); const mid = await page(`return ${ckRow}.querySelector("input").checked;`);
        await click(pt); const end = await page(`return ${ckRow}.querySelector("input").checked;`);
        if (mid === before || end !== before) v.push(`a click on a checkbox row's name: ${before} → ${mid} → ${end} (expected a flip and back)`);
      }
      const rangeRow = `[...document.querySelectorAll(".srow")].find((r) => r.querySelector("input[type=range]"))`;
      const rv0 = await page(`return ${rangeRow}?.querySelector("input[type=range]").value ?? null;`);
      const rowIsLabel = await page(`return ${rangeRow}?.tagName ?? null;`);
      pt = await rowPt(rangeRow, ".slabel-row");
      if (pt) { await click(pt); const rv1 = await page(`return ${rangeRow}.querySelector("input[type=range]").value;`);
        if (rv1 !== rv0 || rowIsLabel === "LABEL") v.push(`a slider row reacted to a click on its name (${rv0} → ${rv1}, ${rowIsLabel})`); }
      const nToggle = await page(`return document.querySelectorAll(".srow[data-row-toggle]").length;`);
      console.log(`        ${nToggle} rows click anywhere to tick`);
      await setSettings({ workshopDownloadMode: "subscribe" });
      await page(`[...document.querySelectorAll(".ssection")].find((x) => /Getting Workshop wallpapers/i.test(x.textContent))?.scrollIntoView({ block: "center" });`);
      await sleep(400); await shot("toggles");
      return v;
    });

    await cell("steam:modal:email", async () => {
      const v = []; await load(SIGNED_OUT);
      let m = await openPw(); console.log(`        open ${J(m)}`);
      if (!m) return ["the password button opened no modal"];
      if (m.step !== "credentials" || m.role !== "dialog" || m.aria !== "true" || !m.labelled) v.push(`dialog semantics: ${J({ step: m.step, role: m.role, aria: m.aria, labelled: m.labelled })}`);
      const f = await page(`const m = document.querySelector("[data-steam-pw-modal]"); const pw = m.querySelector("[data-steam-pw]"), u = m.querySelector('input[name="username"]');
        const lab = (i) => !!m.querySelector('label[for="' + i.id + '"]');
        return { pwType: pw.type, pwAc: pw.autocomplete, uAc: u.autocomplete, labels: lab(pw) && lab(u) };`);
      if (f.pwType !== "password" || f.pwAc !== "current-password" || f.uAc !== "username" || !f.labels) v.push(`fields: ${J(f)}`);
      if (m.focus !== "username") v.push(`focus on open: ${m.focus}`);
      await shot("modal-credentials");
      await credentials();
      m = await modal();
      const c = (await calls()).filter((x) => x.p === "/steam/login");
      if (c.length !== 1 || c[0].body?.username !== "probe-user" || c[0].body?.password !== PASSWORD) v.push(`POST /steam/login: ${J(c.map((x) => ({ ...x.body, password: x.body?.password === PASSWORD ? "<the password>" : x.body?.password })))}`);
      if (m?.pwVal !== "") v.push("the password field still holds the password after Sign in");
      if (!/Signing in/.test(m?.submit ?? "")) v.push(`while Steam answers: "${m?.submit}"`);
      await ev("steam-login-code", { kind: "email", hint: "example.com", retry: false });
      m = await waitFor(async () => { const x = await modal(); return x?.step === "email" ? x : null; });
      console.log(`        email ${J(m && { step: m.step, focus: m.focus, text: m.text.slice(0, 120) })}`);
      if (m?.step !== "email" || !/emailed|email/.test(m.text) || !/example\.com/.test(m.text)) v.push(`email step: ${J(m && { step: m.step, text: m.text })}`);
      await sleep(150);
      if ((await modal())?.focus !== "code") v.push(`focus on the code step: ${(await modal())?.focus}`);
      await shot("modal-email");
      await type("WRONG"); await key("Enter"); await sleep(200);
      const cc = (await calls()).filter((x) => x.p === "/steam/login/code");
      if (cc.length !== 1 || cc[0].body?.code !== "WRONG") v.push(`POST /steam/login/code: ${J(cc)}`);
      await ev("steam-login-code", { kind: "email", hint: "example.com", retry: true }); await sleep(200);
      m = await modal();
      if (!/wasn't right/.test(m?.err ?? "") || m?.errRole !== "alert") v.push(`a wrong code: ${J({ err: m?.err, role: m?.errRole })}`);
      await shot("modal-email-retry");
      await type("ABCDE"); await key("Enter"); await sleep(200);
      await page(`window.__st.status = { signedIn: true, rejected: false, accountName: "probe-acct", daysLeft: 200, mode: "subscribe" };`);
      await ev("steam-signed-in", { signedIn: true, rejected: false, accountName: "probe-acct", daysLeft: 200, mode: "subscribe" });
      const gone = await waitFor(async () => !(await modal()), 2000);
      if (!gone) v.push("steam-signed-in didn't close the modal");
      const r = await waitFor(async () => { const x = await steamRow(); return x?.state === "signed-in" ? x : null; }, 2000);
      if (!r || !/probe-acct/.test(r.text)) v.push(`the row after signing in: ${J(r)}`);
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:device", async () => {
      const v = []; await load(SIGNED_OUT); await openPw(); await credentials();
      await ev("steam-login-code", { kind: "device", hint: null, retry: false });
      const m = await waitFor(async () => { const x = await modal(); return x?.step === "device" ? x : null; });
      if (!m || !/authenticator/i.test(m.text) || !/STEAM GUARD CODE/.test(m.text)) v.push(`device step: ${J(m && m.text)}`);
      await shot("modal-device");
      await page(`document.querySelector("[data-steam-pw-modal] .btn.ghost").click();`); await sleep(400);
      if (!(await waitFor(async () => !(await modal()), 2000))) v.push("Cancel didn't close it");
      if (!(await calls()).some((x) => x.p === "/steam/login/cancel")) v.push("Cancel on a code step sent no /steam/login/cancel");
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:confirm", async () => {
      const v = []; await load(SIGNED_OUT); await openPw(); await credentials();
      await ev("steam-login-code", { kind: "confirm", hint: null, retry: false });
      const m = await waitFor(async () => { const x = await modal(); return x?.step === "confirm" ? x : null; });
      if (!m || !/Approve/.test(m.text) || !/Waiting for your approval/.test(m.text)) v.push(`confirm step: ${J(m && m.text)}`);
      if (!(await page(`return !!document.querySelector("[data-steam-pw-code]");`))) v.push("no code field on the confirm step");
      await shot("modal-confirm");
      await ev("steam-signed-in", { signedIn: true, rejected: false, accountName: "c", daysLeft: 200, mode: "subscribe" });
      if (!(await waitFor(async () => !(await modal()), 2000))) v.push("signed-in didn't close it");
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:error", async () => {
      const v = []; await load(SIGNED_OUT); await openPw(); await credentials("err-user");
      await ev("steam-login-error", { message: "Wrong account name or password.", rateLimited: false }); await sleep(300);
      let m = await modal(); console.log(`        ${J(m && { step: m.step, err: m.err, user: m.user, focus: m.focus })}`);
      if (m?.step !== "credentials" || m.err !== "Wrong account name or password." || m.errRole !== "alert") v.push(`after the error: ${J(m)}`);
      if (m?.user !== "err-user") v.push(`the account name wasn't kept (${m?.user})`);
      if (m?.pwVal !== "") v.push("the password field isn't empty after the error");
      if (m?.focus !== "password") v.push(`focus after the error: ${m?.focus}`);
      await shot("modal-error");
      // a refused start (Steam's rate limit hold): its words inline, and nothing retries
      await js(`window.__replies = { "/steam/login": { status: 400, body: { error: "Steam is limiting sign-in attempts from this connection — try again after 17:05." } } }; true`);
      const n0 = (await calls()).filter((x) => x.p === "/steam/login").length;
      await type(PASSWORD); await key("Enter"); await sleep(400);
      m = await modal();
      if (!/limiting/.test(m?.err ?? "")) v.push(`the refused start: ${m?.err}`);
      if (/Signing in/.test(m?.submit ?? "")) v.push("still 'Signing in…' after the refusal");
      await sleep(1500);
      const n1 = (await calls()).filter((x) => x.p === "/steam/login").length;
      if (n1 !== n0 + 1) v.push(`/steam/login sent ${n1 - n0} times for one click`);
      await js(`window.__replies = {}; true`);
      await shot("modal-ratelimit");
      await page(`document.querySelector("[data-steam-pw-modal] .btn.ghost").click();`); await sleep(300);
      await leakCheck(v, 2); // the first try + the refused one
      return v;
    });
    await cell("steam:modal:cancel", async () => {
      const v = []; await load(SIGNED_OUT); await openPw();
      // a click outside the dialog keeps it (it'd throw away what was typed)
      await type("cancel-user");
      send({ type: "mouseDown", x: 20, y: 880, button: "left", clickCount: 1 }); send({ type: "mouseUp", x: 20, y: 880, button: "left", clickCount: 1 }); await sleep(300);
      if (!(await modal())) v.push("a click outside closed the modal");
      await page(`document.querySelector('[data-steam-pw-modal] input[name="username"]').focus();`);
      await key("Tab"); await type(PASSWORD); await key("Enter"); await sleep(200);
      await ev("steam-login-code", { kind: "email", hint: null, retry: false }); await sleep(250);
      await key("Escape"); await sleep(400);
      if (!(await waitFor(async () => !(await modal()), 2000))) v.push("Escape didn't close it");
      if (!(await calls()).some((x) => x.p === "/steam/login/cancel")) v.push("Escape sent no /steam/login/cancel");
      // reopened: fresh, empty
      const m = await openPw();
      if (m?.step !== "credentials" || m?.pwVal !== "" || m?.err) v.push(`reopened: ${J(m)}`);
      await page(`document.querySelector("[data-steam-pw-modal] .btn.ghost").click();`); await sleep(300);
      await leakCheck(v);
      return v;
    });
    await cell("steam:modal:keys", async () => {
      const v = []; await load(SIGNED_OUT); await openPw();
      const order = [];
      await key("Shift"); // the first key event only gives the page keyboard focus
      for (let i = 0; i < 4; i++) {
        order.push(await page(`const a = document.activeElement; return a?.name || a?.textContent.trim() || a?.tagName;`));
        await key("Tab");
      }
      if (J(order) !== J(["username", "password", "Cancel", "Sign in"])) v.push(`Tab order: ${J(order)}`);
      const m = await modal();
      if (m?.titles) v.push(`${m.titles} element(s) with a title (tooltip) in the modal`);
      await key("Escape"); await sleep(300);
      return v;
    });

    // owner 2026-11-11 ("its hilarious that the download button on browse cards is off-center but gets correctly centered once
    // you hover on it"): the arrow's pixel bounding box vs the button's centre — at rest (the card hovered, the button not) and
    // on the button (the bob frozen at its 0 % and 50 % keyframes). Pixels: the capture with the arrow minus without it.
    await cell("look:dlCentre", async () => {
      const v = []; await load(SIGNED_OUT);
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((x) => x.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll .card:not(.skel-card)").length > 0;`), 4000);
      const tw = await page(`const t = document.querySelector(".scroll .card:not(.skel-card):not(:has([data-in-library])) .thumb-wrap") ?? document.querySelector(".scroll .card:not(.skel-card) .thumb-wrap");
        t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      await sleep(300);
      const mv = (x, y) => win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      // the FIRST card's button (re-found each time — a resize moves it)
      const btnSel = `document.querySelector(".scroll .card:not(.skel-card) .dl-btn")`;
      const measure = async (label, css) => {
        await page(`let st = document.getElementById("__dlc"); if (!st) { st = document.createElement("style"); st.id = "__dlc"; document.head.append(st); } st.textContent = ${J(css)};`);
        await sleep(450);
        const b = await page(`const b = ${btnSel}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
        if (!b) return null;
        const rect = { x: Math.floor(b.x) - 2, y: Math.floor(b.y) - 2, width: Math.ceil(b.w) + 5, height: Math.ceil(b.h) + 5 };
        const withArrow = await win.webContents.capturePage(rect);
        await page(`document.getElementById("__dlc").textContent += " .dl-glyph { visibility: hidden !important; }";`); await sleep(120);
        const noArrow = await win.webContents.capturePage(rect);
        const A = withArrow.toBitmap(), B = noArrow.toBitmap(), { width: W, height: H } = withArrow.getSize();
        const sc = W / rect.width;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4, d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
          if (d > 90) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        const cx = (b.x - rect.x + b.w / 2) * sc, cy = (b.y - rect.y + b.h / 2) * sc;
        // Judge the arrow against the RING the eye sees (the inset accent shadow, same layer as the arrow), measured from the
        // same capture with the same kind of threshold: a fractional button position shifts both by the same snap, so it
        // cancels. Against the layout box the pixel grid alone is ±0.5 px — the old check failed or passed by where the card
        // happened to land (226.70 vs 227.06), not by how it looks.
        const lum = (P, i) => P[i] + P[i + 1] + P[i + 2], ci = (Math.round(cy) * W + Math.round(cx)) * 4, fill = lum(B, ci);
        const r0 = (b.w / 2) * sc;
        let rx0 = Infinity, rx1 = -Infinity, ry0 = Infinity, ry1 = -Infinity, rn = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const dr = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (dr < r0 - 3 * sc || dr > r0 + sc) continue; // the ring's annulus only — never the thumbnail outside the circle
          if (lum(B, (y * W + x) * 4) - fill > 90) { rn++; rx0 = Math.min(rx0, x); rx1 = Math.max(rx1, x); ry0 = Math.min(ry0, y); ry1 = Math.max(ry1, y); }
        }
        const ax = (x0 + x1 + 1) / 2, ay = (y0 + y1 + 1) / 2;
        const dx = ((ax - (rx0 + rx1 + 1) / 2)) / sc, dy = ((ay - (ry0 + ry1 + 1) / 2)) / sc;
        const lx = (ax - cx) / sc, ly = (ay - cy) / sc;
        fs.writeFileSync(path.join(OUT, `dlc-${label}.png`), withArrow.resize({ width: W * 8, quality: "good" }).toPNG());
        console.log(`        ${label}: arrow off the ring's centre by ${rn ? `(${dx.toFixed(2)}, ${dy.toFixed(2)}) css px` : "— (no ring: hovered, the chip is filled)"} (layout box: ${lx.toFixed(2)}, ${ly.toFixed(2)}) — ${n} arrow px, ${rn} ring px, button ${b.w.toFixed(1)}×${b.h.toFixed(1)} at (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
        return { dx, dy, n: rn ? n : 0 };
      };
      // owner: "weirdly, its not offcenter on a small window? try a 1920x1080 window" — every size (cards, and so the button's
      // position, land on fractional pixels at some sizes)
      const sizes = (E.LIASCAPE_DLC_SIZES || "1000x800,1920x1080,1600x900").split(",").map((x) => x.split("x").map(Number));
      for (const [W0, H0] of sizes) {
        win.setContentSize(W0, H0); await sleep(900);
        const t2 = await page(`const t = document.querySelector(".scroll .card:not(.skel-card) .thumb-wrap"); t.scrollIntoView({ block: "center" });
          const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
        Object.assign(tw, t2); await sleep(300);
        mv(tw.x + 12, tw.y + 12); // on the card, off the button: the button shows (opacity 1), not hovered
        const rest = await measure(`${W0}x${H0}-rest`, "");
        const b0 = await page(`const e = ${btnSel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
        if (!b0) { v.push(`${W0}x${H0}: no download button`); continue; }
        mv(b0.x, b0.y);
        await measure(`${W0}x${H0}-hover0`, ".dl-btn:hover .dl-glyph { animation: none !important; transform: translateY(-1px) !important; }");
        await page(`document.getElementById("__dlc")?.remove();`);
        mv(5, 5); await sleep(300);
        if (!rest || !rest.n) { v.push(`${W0}x${H0}: no arrow or ring pixels at rest`); continue; }
        if (Math.abs(rest.dx) > 0.5 || Math.abs(rest.dy) > 0.5) v.push(`${W0}x${H0}: at rest the arrow is off-centre by (${rest.dx.toFixed(2)}, ${rest.dy.toFixed(2)}) css px`);
      }
      win.setContentSize(1000, 800); await sleep(400);
      return v;
    });

    await cell("steam:dlStatus", async () => {
      const v = []; await load(SIGNED_OUT);
      const srcs = (await http("GET", "/sources")).json;
      const ws = srcs.find((s) => s.supportsTagFilter)?.name;
      if (!ws) return ["no Workshop source"];
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(ws)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll .card:not(.skel-card)").length > 0;`), 4000);
      await page(`document.querySelector(".scroll .card:not(.skel-card) .thumb-wrap").click();`); await sleep(700);
      const btn = await page(`const b = [...document.querySelectorAll(".side-go")].find((x) => x.textContent.trim() === "Download"); if (!b) return false; b.click(); return true;`);
      if (!btn) return ["no Download button in the Browse sidebar"];
      const dl = await waitFor(() => js(`window.__st.dl && window.__st.dl.body`), 2000);
      if (!dl) return ["no POST /download"];
      const STATUS = "Not signed in to Steam here — click Subscribe in Steam, then it downloads by itself…";
      await ev("download-progress", { id: dl.result.pageUrl, value: 0, status: STATUS }); await sleep(300);
      const r = await page(`return { side: document.querySelector("[data-side-download-status]")?.textContent ?? null, bar: document.querySelector(".status")?.textContent ?? null };`);
      console.log(`        ${J(r)}`);
      if (r.side !== STATUS) v.push(`the sidebar says "${r.side}"`);
      if (!(r.bar ?? "").includes("click Subscribe in Steam")) v.push(`the status bar says "${r.bar}"`);
      // owner 2026-11-11 (a 458 MB item: "Downloading…" over an empty bar for a minute, like a hang): the CARD says the step in
      // short words, over a sweeping (indeterminate) bar — each phase the backend reports, in order
      const card = (sel) => page(`const c = [...document.querySelectorAll("[data-morph-id]")].find((e) => e.getAttribute("data-morph-id") === ${J("br-" + dl.result.pageUrl)});
        const l = c?.querySelector("[data-dl-label]"), bar = c?.querySelector(".dl-bar"), f = bar?.querySelector(".dl-fill");
        return { label: l?.textContent ?? null, indet: !!bar?.classList.contains("indet"), anim: f ? getComputedStyle(f).animationName : null };`);
      // + the Steam to-do: waiting its page's turn, then (steamapp) its turn with the Steam client
      for (const [status, want] of [["In the Steam to-do — its page opens in Steam when it's its turn…", "In the Steam to-do"], ["Waiting for the Steam app…", "Waiting for the Steam app…"],
        [STATUS, "Click Subscribe in Steam"], ["Steam is downloading it…", "Steam is downloading…"], ["Steam is finishing…", "Steam is finishing…"]]) {
        await ev("download-progress", { id: dl.result.pageUrl, value: 0, status }); await sleep(250);
        const c = await card();
        console.log(`        card: ${J(c)}`);
        if (c.label !== want) v.push(`for "${status}" the card says "${c.label}" (expected "${want}")`);
        if (!c.indet || c.anim !== "dl-indet") v.push(`for "${status}" the card's bar isn't sweeping (indet ${c.indet}, animation ${c.anim})`);
      }
      // owner 2026-11-11 ("why is the loading bar so micro"): with a short label ("1%") the bar still spans ~72 % of the card
      await ev("download-progress", { id: dl.result.pageUrl, value: 0.01, status: "Steam is downloading it…" }); await sleep(250);
      const bw = await page(`const c = [...document.querySelectorAll("[data-morph-id]")].find((e) => e.getAttribute("data-morph-id") === ${J("br-" + dl.result.pageUrl)});
        const b = c?.querySelector(".dl-bar"); return b ? { bar: b.getBoundingClientRect().width, card: c.getBoundingClientRect().width, label: c.querySelector("[data-dl-label]")?.textContent } : null;`);
      console.log(`        bar ${J(bw)}`);
      if (!bw || bw.bar < bw.card * 0.6) v.push(`the progress bar is ${bw?.bar.toFixed(0)} px on a ${bw?.card.toFixed(0)} px card (label "${bw?.label}")`);
      await shot("dl-status");
      await page(`[...document.querySelectorAll("[data-side-download] button")].find((b) => /Cancel/.test(b.textContent))?.click();`); await sleep(400);
      if (!(await js(`window.__st.dl.aborted`))) v.push("Cancel didn't abort the download request");
      if (await page(`return !!document.querySelector("[data-side-download]");`)) v.push("the progress row stayed after Cancel");
      // a late status for the cancelled download doesn't bring it back
      await ev("download-progress", { id: dl.result.pageUrl, value: 0, status: STATUS }); await sleep(300);
      if (await page(`return !!document.querySelector("[data-side-download]");`)) v.push("a late download-progress brought the progress row back");
      return v;
    });

    // owner 2026-11-11 ("Guided, auto-advance" mockup → then "lets just have them click 'next'"): the Steam to-do panel, driven by
    // fake WS steam-todo events; every button POSTs its /steam-todo/<action> (stubbed — nothing reaches the backend)
    await cell("steam:todo", async () => {
      const v = []; await load(SIGNED_OUT);
      const TITLE = "Re:Zero Rem – Edit";
      const panel = () => page(`const p = document.querySelector("[data-steam-todo]"); if (!p) return null;
        const btn = (k) => p.querySelector('[data-st="' + k + '"]');
        const dock = p.closest("[data-steam-todo-dock]"), cs = getComputedStyle(dock || p), side = document.querySelector(".side-panel");
        return { step: p.querySelector("[data-st-step]")?.textContent ?? null, title: p.querySelector("[data-st-title]")?.textContent ?? null,
          hint: p.querySelector("[data-st-hint]")?.textContent ?? null, next: btn("next")?.textContent.trim() ?? null,
          reopen: btn("reopen")?.textContent.trim() ?? null, skip: btn("skip")?.textContent.trim() ?? null, stop: btn("stop")?.textContent.trim() ?? null,
          use: btn("use-steam-app")?.textContent.trim() ?? null, titles: p.querySelectorAll("[title]").length,
          iconOnlyNoLabel: [...p.querySelectorAll("button")].filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label")).length,
          fixed: cs.position, z: +cs.zIndex, sideZ: side ? +getComputedStyle(side).zIndex : 40, inBody: !!dock && dock.parentElement === document.body,
          useNote: p.querySelector("[data-st-use-note]")?.textContent ?? null,
          rect: (() => { const r = p.getBoundingClientRect(); const bar = document.querySelector(".playlist-bar"); return { r: innerWidth - r.right, b: innerHeight - r.bottom, w: r.width, barLift: bar ? innerHeight - bar.getBoundingClientRect().top : 0 }; })(),
          emoji: /\\p{Extended_Pictographic}/u.test(p.textContent), icons: p.querySelectorAll("svg.lucide").length };`);
      if (await panel()) v.push("a panel showed before any steam-todo event");
      const STEP = { action: "subscribe", index: 2, total: 5, remaining: 4, current: { id: "930001", title: TITLE }, delivered: false, message: null, busy: false };
      await ev("steam-todo", STEP); await sleep(700);
      const p = await panel();
      console.log(`        ${J(p)}`);
      if (!p) return ["no panel for a steam-todo event"];
      if (p.step !== "Subscribe in Steam · 2 of 5") v.push(`the step reads "${p.step}"`);
      if (p.title !== TITLE) v.push(`the title reads "${p.title}"`);
      if (!/Click Subscribe on the page Steam opened, then Done — next/.test(p.hint ?? "")) v.push(`the hint reads "${p.hint}"`);
      if (p.next !== "Done — next" || p.reopen !== "Open again" || p.skip !== "Skip" || p.stop !== "Stop") v.push(`the buttons read ${J([p.next, p.reopen, p.skip, p.stop])}`);
      if (p.use !== "Let the Steam app do all 4") v.push(`the Steam-app line reads "${p.use}" (4 remaining)`);
      // owner 2026-11-11: "'Let the Steam app do all N' should mention that it needs WE and it will show you as playing and stuff"
      if (!/Wallpaper Engine/.test(p.useNote ?? "") || !/playing/.test(p.useNote ?? "") || !/Steam running/.test(p.useNote ?? "")) v.push(`the Steam-app note reads "${p.useNote}"`);
      if (p.titles) v.push(`${p.titles} element(s) with a title (tooltip) in the panel`);
      if (p.iconOnlyNoLabel) v.push(`${p.iconOnlyNoLabel} icon-only button(s) without an aria-label`);
      // bottom-right: 16 px from the edge, lifted over the playlist bar when it shows (Library)
      if (p.fixed !== "fixed" || !p.inBody || !(p.z > p.sideZ) || p.rect.r > 40 || Math.abs(p.rect.b - (p.rect.barLift + 16)) > 4) v.push(`placement: ${J({ fixed: p.fixed, inBody: p.inBody, z: p.z, sideZ: p.sideZ, rect: p.rect })}`);
      if (p.emoji || p.icons < 4) v.push(`icons: emoji ${p.emoji}, ${p.icons} lucide icons`);
      await shot("todo");
      // each button → its endpoint, once
      for (const k of ["next", "reopen", "skip", "stop", "use-steam-app"]) {
        const n0 = (await calls()).length;
        await page(`document.querySelector('[data-steam-todo] [data-st="${k}"]').click();`); await sleep(250);
        const got = (await calls()).slice(n0).map((c) => c.p);
        if (J(got) !== J([`/steam-todo/${k}`])) v.push(`${k} → ${J(got)} (expected one POST /steam-todo/${k})`);
      }
      // the fold: a pill with the step, back again
      await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(300);
      const folded = await page(`const p = document.querySelector("[data-steam-todo]"); return { folded: p.classList.contains("folded"), step: p.querySelector("[data-st-step]")?.textContent, btns: p.querySelectorAll("[data-st]").length };`);
      if (!folded.folded || folded.step !== "Subscribe in Steam · 2 of 5" || folded.btns) v.push(`folded: ${J(folded)}`);
      await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(300);
      // the last one: "Done", no Steam-app line; an unsubscribe entry says so; a message shows
      await ev("steam-todo", { ...STEP, action: "unsubscribe", index: 5, total: 5, remaining: 1, message: "The Steam app couldn't be reached — Steam isn't running." }); await sleep(400);
      const last = await page(`const p = document.querySelector("[data-steam-todo]"); return { step: p?.querySelector("[data-st-step]")?.textContent,
        next: p?.querySelector('[data-st="next"]')?.textContent.trim(), use: !!p?.querySelector('[data-st="use-steam-app"]'), msg: p?.querySelector("[data-st-msg]")?.textContent ?? null };`);
      console.log(`        last: ${J(last)}`);
      if (last.step !== "Unsubscribe in Steam · 5 of 5" || last.next !== "Done" || last.use || !/couldn't be reached/.test(last.msg ?? "")) v.push(`at 1 remaining: ${J(last)}`);
      // finished → gone (after its exit)
      await ev("steam-todo", { finished: true }); await sleep(600);
      if (await panel()) v.push("the panel stayed after a finished event");
      return v;
    });

    // ---- per-frame sampling: run `act` (page statements), then read `expr` every animation frame for `ms` ----
    const frames = (act, expr, ms = 600) => page(`const out = []; const t0 = performance.now(); try { out.push(${expr}); } catch { out.push(null); }
      ${act}
      await new Promise((res) => { const f = () => { try { out.push(${expr}); } catch { out.push(null); } if (performance.now() - t0 < ${ms}) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      return out;`);
    // how many samples lie strictly between the first and the last value (an animation passes through them; a jump doesn't)
    const between = (xs, eps = 1.5) => { const ys = xs.filter((x) => x != null); if (ys.length < 2) return 0; const a = ys[0], b = ys.at(-1);
      const lo = Math.min(a, b) + eps, hi = Math.max(a, b) - eps; return ys.filter((y) => y > lo && y < hi).length; };
    const shotDuring = async (name, run, at = 110) => { const p = run(); await sleep(at); await shot(name); return p; };
    const STEP2 = { action: "subscribe", index: 2, total: 5, remaining: 4, current: { id: "930001", title: "Rem – Edit" }, delivered: false, message: null, busy: false, autoNext: true };
    const DOCK_Y = `new DOMMatrix(getComputedStyle(document.querySelector("[data-steam-todo-dock]")).transform).m42`;
    const PANEL_W = `document.querySelector("[data-steam-todo]")?.getBoundingClientRect().height ?? null`;
    // the newest entry block's x offset (the carousel slide): the live one is the last [data-st-entry] with the new id
    const ENTRY_X = (id) => `(() => { const e = [...document.querySelectorAll('[data-st-entry="${id}"]')].at(-1); return e ? new DOMMatrix(getComputedStyle(e).transform).m41 : null; })()`;
    const fakeBar = `if (!document.querySelector(".playlist-bar")) { const b = document.createElement("div"); b.className = "playlist-bar"; b.id = "__fakebar";
      b.style.cssText = "position:fixed;left:0;bottom:0;width:40px;height:130px;pointer-events:none"; document.body.append(b); }`;

    // owner 2026-11-11: "why does to-do panel have no morph and stuff or a smooth movement when switching tabs or anything" — the lift
    // GLIDES (a playlist bar appearing), fold ⇄ unfold MORPHS (widths in between), a new current entry SLIDES (the carousel);
    // under no-motion all three are instant. Mid-animation shots: steam-todo-glide.png, steam-todo-fold.png, steam-todo-slide.png
    for (const motion of [true, false]) {
      await cell(`steam:todoMotion:${motion ? "on" : "off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion });
        await load(SIGNED_OUT); await tab("Browse");
        await page(`document.getElementById("__fakebar")?.remove(); document.querySelector(".playlist-bar") && (window.__realBar = true);`);
        await ev("steam-todo", { ...STEP2, current: { id: "930001", title: "Rem – Edit" } }); await sleep(900);
        if (await js(`!!window.__realBar`)) console.log("        (a playlist bar already shows on Browse — the glide is measured against the fake one anyway)");
        // (a) the lift: a bar appears → the dock glides up to it (re-measured every 150 ms)
        const lift = await (motion ? shotDuring("todo-glide", () => frames(fakeBar, DOCK_Y, 900), 260) : frames(fakeBar, DOCK_Y, 900));
        const liftEnd = lift.filter((x) => x != null).at(-1);
        const nLift = between(lift);
        console.log(`        lift: ${lift[0]} → ${liftEnd}, ${nLift} frame(s) in between`);
        if (!(Math.abs(liftEnd - lift[0]) > 50)) v.push(`the dock didn't lift over the bar (${lift[0]} → ${liftEnd})`);
        if (motion && nLift < 4) v.push(`the lift jumped (${nLift} in-between frames)`);
        if (!motion && nLift > 1) v.push(`no-motion: the lift animated (${nLift} in-between frames)`);
        await page(`document.getElementById("__fakebar")?.remove();`); await sleep(700);
        // (b) fold ⇄ unfold: the box's width passes through sizes in between
        // heights: the folded pill keeps about the open width (its head), the height is what folds
        const fold = await (motion ? shotDuring("todo-fold", () => frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700), 90)
          : frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700));
        const unfold = await frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700);
        const nF = between(fold), nU = between(unfold);
        console.log(`        fold: ${fold[0]?.toFixed(0)} → ${fold.at(-1)?.toFixed(0)} (${nF} between); unfold → ${unfold.at(-1)?.toFixed(0)} (${nU} between)`);
        if (!(fold.at(-1) < fold[0] - 40) || Math.abs(unfold.at(-1) - fold[0]) > 2) v.push(`fold heights ${fold[0]} → ${fold.at(-1)} → ${unfold.at(-1)}`);
        if (motion && (nF < 3 || nU < 3)) v.push(`the fold popped (${nF} / ${nU} in-between frames)`);
        if (!motion && (nF > 1 || nU > 1)) v.push(`no-motion: the fold animated (${nF} / ${nU})`);
        // the chevron turns (one icon, rotated) — 180° folded
        await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(motion ? 600 : 100);
        const chev = await page(`const c = document.querySelector("[data-steam-todo] .st-chev"); return { n: document.querySelectorAll("[data-steam-todo] .st-fold svg").length, a: new DOMMatrix(getComputedStyle(c).transform).a, tr: getComputedStyle(c).transitionDuration };`);
        if (chev.n !== 1 || !(chev.a < -0.99)) v.push(`the folded chevron: ${J(chev)} (one icon turned 180°)`);
        if (motion && chev.tr === "0s") v.push("the chevron has no transition");
        await page(`document.querySelector("[data-steam-todo] .st-fold").click();`); await sleep(700);
        // (c) a new current entry: the content slides in (transform)
        const slide = await (motion
          ? shotDuring("todo-slide", () => frames(`window.__fakeWs("steam-todo", ${J({ ...STEP2, index: 3, remaining: 3, current: { id: "930002", title: "Emilia – Loop" } })});`, ENTRY_X("930002"), 600), 90)
          : frames(`window.__fakeWs("steam-todo", ${J({ ...STEP2, index: 3, remaining: 3, current: { id: "930002", title: "Emilia – Loop" } })});`, ENTRY_X("930002"), 600));
        const moved = slide.filter((x) => x != null && Math.abs(x) > 1.5).length;
        console.log(`        slide x: [${slide.slice(0, 10).map((x) => x == null ? "–" : x.toFixed(1))}…] ${moved} offset frame(s)`);
        if (motion && moved < 3) v.push(`the new entry didn't slide in (${moved} frames off its place)`);
        if (!motion && moved > 0) v.push(`no-motion: the new entry slid (${moved} frames)`);
        if (slide.at(-1) == null || Math.abs(slide.at(-1)) > 0.5) v.push(`the new entry didn't land (x ${slide.at(-1)})`);
        await ev("steam-todo", { finished: true }); await sleep(500);
        return v;
      });
    }
    await setSettings({ morphs: true });

    // owner 2026-11-11: "make it so browse > wallpaper engine (local) has option to unsubscribe / same for browse > workshop / it needs
    // to be in the sidebar / probably a button that lets you subscribe/unsubscribe in the sidebar" + "open on steam doesn't open in
    // real steam". The Browse sidebar's toggle (components/SubToggle.tsx) per the stubbed /workshop/state; its POSTs; Open on Steam
    // → POST /steam/open-page (ok:false → the https page through window.open). Shots steam-subtoggle*.png
    const openSide = async (n = 0) => { await page(`document.querySelectorAll(".scroll .card:not(.skel-card) .thumb-wrap")[${n}].click();`); await sleep(800); };
    const sub = () => page(`const s = document.querySelector("[data-side-sub]"); if (!s) return null; const b = s.querySelector("[data-side-sub-btn]");
      const ico = s.querySelector(".side-sub-ico");
      return { state: s.dataset.state, label: [...s.querySelectorAll("[data-side-sub-label]")].at(-1)?.textContent ?? null, hint: [...s.querySelectorAll("[data-side-sub-hint]")].at(-1)?.textContent ?? null,
        btn: b?.dataset.sideSubBtn ?? null, btnText: b?.textContent.trim() ?? null, btnClass: b?.className ?? "", progress: !!s.querySelector("[data-side-sub-progress]"),
        titles: s.querySelectorAll("[title]").length, bg: getComputedStyle(s).backgroundColor, icoShadow: ico ? getComputedStyle(ico).boxShadow : null,
        icons: s.querySelectorAll("svg.lucide").length };`);
    const setWs = (id, st) => js(`window.__wsState = { ...(window.__wsState || {}), ${J(id)}: ${J(st)} }; true`);
    const bump = () => ev("steam-todo", { finished: true }); // any event that can change a subscription → the toggle re-reads
    await cell("steam:subToggle:workshop", async () => {
      const v = []; await load(SIGNED_OUT);
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((s) => s.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll .card:not(.skel-card)").length > 0;`), 4000);
      await setWs("930000", { subscribed: false, pending: null, inLibrary: false, onDisk: false });
      await openSide(0);
      let s = await waitFor(() => sub().then((x) => x && x.state !== "loading" ? x : null), 3000);
      console.log(`        not subscribed: ${J(s)}`);
      if (!s || s.state !== "not-subscribed" || s.label !== "Not subscribed" || s.btn !== "subscribe" || s.btnText !== "Subscribe" || !/accent/.test(s.btnClass))
        v.push(`not subscribed: ${J(s)}`);
      if (s && !/without adding it to your library/.test(s.hint ?? "")) v.push(`the hint reads "${s?.hint}"`);
      if (s?.titles) v.push(`${s.titles} tooltip(s) in the toggle`);
      // Subscribe → POST /workshop/subscribe {workshopId, title}; WS subscribe-progress → "Subscribing…" + the bar; done → Subscribed
      let n0 = (await calls()).length;
      await page(`document.querySelector("[data-side-sub-btn]").click();`); await sleep(300);
      let got = (await calls()).slice(n0);
      if (got.length !== 1 || got[0].p !== "/workshop/subscribe" || got[0].body?.workshopId !== "930000" || got[0].body?.title !== "ws-1") v.push(`Subscribe posted ${J(got)}`);
      await ev("subscribe-progress", { id: "930000", value: 0, status: "Click Subscribe in Steam, then Next…" }); await sleep(400);
      s = await sub();
      if (s?.state !== "subscribing" || s.label !== "Subscribing…" || !s.progress || s.btn) v.push(`while subscribing: ${J(s)}`);
      await shot("subtoggle-subscribing");
      await setWs("930000", { subscribed: true, pending: null, inLibrary: false, onDisk: true });
      await ev("subscribe-progress", { id: "930000", value: 1, status: "Subscribed", done: true }); await sleep(600);
      s = await sub();
      if (s?.state !== "subscribed" || s.label !== "Subscribed" || s.btn !== "unsubscribe" || s.btnText !== "Unsubscribe" || !/danger/.test(s.btnClass)) v.push(`subscribed: ${J(s)}`);
      // in the library: the sub-line says Unsubscribe also removes it
      await setWs("930000", { subscribed: true, pending: null, inLibrary: true, onDisk: true }); await bump(); await sleep(500);
      s = await sub();
      if (!/also removes it from your library/.test(s?.hint ?? "")) v.push(`in the library, the hint reads "${s?.hint}"`);
      await shot("subtoggle");
      n0 = (await calls()).length;
      await page(`document.querySelector("[data-side-sub-btn]").click();`); await sleep(300);
      got = (await calls()).slice(n0);
      if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe" || got[0].body?.workshopId !== "930000") v.push(`Unsubscribe posted ${J(got)}`);
      await setWs("930000", { subscribed: false, pending: "unsubscribe", inLibrary: false, onDisk: true }); await bump(); await sleep(500);
      s = await sub();
      if (s?.state !== "unsubscribing" || s.label !== "Unsubscribing…" || s.btn) v.push(`pending unsubscribe: ${J(s)}`);
      // Open on Steam → POST /steam/open-page; the browser only when the Steam app couldn't be opened
      await page(`window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; window.__replies = { ...(window.__replies || {}), "/steam/open-page": { body: { ok: true } } };`);
      n0 = (await calls()).length;
      await page(`document.querySelector("[data-open-steam]").click();`); await sleep(400);
      got = (await calls()).slice(n0);
      let opened = await js(`window.__opened`);
      if (got.length !== 1 || got[0].p !== "/steam/open-page" || got[0].body?.workshopId !== "930000" || opened.length) v.push(`Open on Steam (ok): ${J(got)}, browser ${J(opened)}`);
      await page(`window.__replies["/steam/open-page"] = { body: { ok: false } };`);
      await page(`document.querySelector("[data-open-steam]").click();`); await sleep(400);
      opened = await js(`window.__opened`);
      if (J(opened) !== J(["https://steamcommunity.com/sharedfiles/filedetails/?id=930000"])) v.push(`Open on Steam (ok:false) → the browser got ${J(opened)}`);
      if (await page(`return !!document.querySelector('.side-panel a[href*="steamcommunity.com"]');`)) v.push("a plain steamcommunity.com link is still in the sidebar");
      return v;
    });
    await cell("steam:subToggle:weLocal", async () => {
      const v = [];
      await js(`localStorage.setItem("__probe_we_local", "1"); true`);
      await load(SIGNED_OUT);
      const srcs = (await http("GET", "/sources")).json;
      const local = srcs.find((s) => /Local/i.test(s.name) && !s.supportsTagFilter)?.name;
      if (!local) return ["no Wallpaper Engine (Local) source"];
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(local)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll .card:not(.skel-card)").length > 0;`), 4000);
      await setWs("931000", { subscribed: true, pending: null, inLibrary: false, onDisk: true });
      await openSide(0);
      let s = await waitFor(() => sub().then((x) => x && x.state !== "loading" ? x : null), 3000);
      console.log(`        WE local: ${J(s)}`);
      if (s?.state !== "subscribed" || s.btn !== "unsubscribe") v.push(`a WE-local subscription: ${J(s)}`);
      const n0 = (await calls()).length;
      // the state swap animates (the words slide) — per frame, the new words' x passes through offsets
      const xs = await frames(`document.querySelector("[data-side-sub-btn]").click(); window.__wsState["931000"] = { subscribed: false, pending: null, inLibrary: false, onDisk: true };`,
        `(() => { const t = [...document.querySelectorAll("[data-side-sub] [data-side-sub-label]")].at(-1); return t && t.textContent === "Unsubscribed" ? new DOMMatrix(getComputedStyle(t).transform).m41 : null; })()`, 900);
      const got = (await calls()).slice(n0);
      if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe" || got[0].body?.workshopId !== "931000") v.push(`Unsubscribe posted ${J(got)}`);
      s = await sub();
      if (s?.state !== "unsubscribed" || s.label !== "Unsubscribed" || s.btn !== "subscribe") v.push(`after the unsubscribe (folder still there): ${J(s)}`);
      const slid = xs.filter((x) => x != null && Math.abs(x) > 1).length;
      console.log(`        swap x: [${xs.filter((x) => x != null).slice(0, 8).map((x) => x.toFixed(1))}] ${slid} offset frame(s)`);
      if (slid < 2) v.push(`the state swap didn't slide (${slid} frames)`);
      await shot("subtoggle-welocal");
      // no-glow: the subscribed chip has no glow; bg-live: the card keeps its own dark fill
      await setWs("931000", { subscribed: true, pending: null, inLibrary: false, onDisk: true });
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      await load(SIGNED_OUT); await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(local)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll .card:not(.skel-card)").length > 0;`), 4000);
      await js(`window.__wsState = { "931000": { subscribed: true, pending: null, inLibrary: false, onDisk: true } }; true`);
      await openSide(0);
      s = await waitFor(() => sub().then((x) => x && x.state === "subscribed" ? x : null), 3000);
      const html = await js(`document.documentElement.className`);
      console.log(`        no-glow + bg-live: ${J({ html, bg: s?.bg, ico: s?.icoShadow })}`);
      if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: html "${html}"`);
      if (s && /0px 0px 10px/.test(s.icoShadow ?? "")) v.push(`no-glow: the chip still glows (${s.icoShadow})`);
      if (!s || /rgba\(0, 0, 0, 0\)|transparent/.test(s.bg)) v.push(`bg-live: the toggle has no fill of its own (${s?.bg})`);
      await shot("subtoggle-live");
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
      await js(`localStorage.removeItem("__probe_we_local"); true`);
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`STEAM pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "steam.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
