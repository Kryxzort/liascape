// Steam sign-in + "Subscribe via Steam" without a sign-in — `scripts/test-ui-matrix.sh --probe probe-steam.js` (the matrix's
// hermetic stack). docs/decisions.md § "Offer a password sign-in beside the QR": a password sign-in (SteamPasswordModal)
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
//                         its place for ≥ 3 frames. off (Smooth window animations off): nothing moves — the lift, the fold's
//                         height and the chevron change at once; the panel, the body and the entries fade in / out (per
//                         frame: in-between opacity frames, the boxes still). Mid-animation shots
//                         steam-todo-glide.png / -fold.png / -slide.png
//   steam:subToggle:workshop  the Browse sidebar's subscription toggle per a stubbed /workshop/state: Not subscribed → Subscribe
//                         (POST /workshop/subscribe {workshopId, title}) → Subscribing… + the bar (WS subscribe-progress) →
//                         Subscribed (danger Unsubscribe) → in the library: "Also removes it from your library" → Unsubscribe
//                         (POST) → Unsubscribing…; Open on Steam → POST /steam/open-page, ok:false → window.open(https page)
//   steam:subToggle:weLocal   a WE-local item: Subscribed → Unsubscribe → "Unsubscribed" (folder still there), the words slide
//                         (per frame); no-glow (the chip's glow off) + bg-live (the card keeps its own fill). Shots steam-subtoggle*.png
//   side:idPill:still     the Library sidebar's Workshop ID pill (a scene, its hero row full: a stubbed resolution + age rating)
//                         keeps its box, and every hero chip keeps its own, per frame through "Copied" and back, at the window
//                         widths where the pill starts a row of its own and full screen (1920); the accessible name is the
//                         aria-label's ("— copy" / "— copied"), never the hidden face's; "Copied" rolls in (motion on) or only
//                         fades in place (motion off). Shots steam-idpill-*.png
//   side:deleteSource:names  "Delete from source" reads "Delete and unsubscribe" with a tooltip naming the unsubscribe; its click
//                         (stubbed POST /workshop/delete-from-source) → the status bar says "Unsubscribing …"; with auto-import on
//                         a Workshop item's Delete reads the same, a non-Workshop item's stays "Delete". Shots steam-delsource*.png
//   steam:subToggle:keepMenu  a library item's Unsubscribe: a real right-click opens a menu at the pointer ("Unsubscribe without
//                         deleting", focused; it grows in per frame; no request); Escape (focus back) and a click outside close it;
//                         picking it → ONE POST /workshop/unsubscribe-keep (never /workshop/unsubscribe), the menu fades out, the
//                         status says "kept in your library"; the left-click still posts /workshop/unsubscribe; no menu for an
//                         item not in the library; no-glow + bg-live (its own fill, no glow). Shots steam-keepmenu*.png
//   steam:subToggle:keepMenuOff  motion off: the menu fades in and out in place (motion-off.js)
//   side:copyIdTile       the Browse sidebar's Copy ID tile: a click copies the id (the clipboard) and the tile reads "Copied" (its
//                         name too, never both faces) for ≈ 1.2 s; every tile keeps its box per frame; the words roll (motion
//                         on) or only fade (motion off); another item's sidebar doesn't say "Copied". Shot steam-copyid.png
// Screenshots: <LIASCAPE_OUT>/steam-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const MO = require("./motion-off"); // motion off: only opacity changes, nothing moves, appear / leave fade
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
    // "Unsubscribe without deleting" and the Library sidebar's "Delete and unsubscribe" (side:*, steam:subToggle:keepMenu*):
    // recorded, answered here, never reaching the stack's backend (its library stays as it is)
    if ((p === "/workshop/unsubscribe-keep" || p === "/workshop/delete-from-source" || p === "/workshop/drain") && m === "POST") {
      st.calls.push({ p, body: o.body ? JSON.parse(o.body) : null });
      return res(p.endsWith("keep") ? { inLibrary: true, kept: 1 } : p.endsWith("source") ? { batch: "" } : null);
    }
    // a scene's sidebar with a full hero row (side:*): the stack's Workshop scenes get a resolution and an age rating
    if (p === "/library" && m === "GET" && localStorage.getItem("__probe_lib_full") === "1")
      return f(u, o).then((r) => r.json()).then((list) => res(list.map((x) => (x.isScene && x.workshopId ? { ...x, resolution: "3840 x 2160", ageRating: "Everyone" } : x))));
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

    // "Use the Steam app" (docs/decisions.md § "Drive the Steam client through its own `steamclient.so`") is the FIRST of the
    // download-mode radios; picking it saves workshopDownloadMode "steamapp", shows its note and hides the Steam
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
      // the tick's own pixels, centred in its box — a ticked box, captured
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
      // a click anywhere on a checkbox / radio row ticks it: a real click on a
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

    // the download button is a bare glyph, like the Library card's buttons: at rest (the card hovered, the button not) and
    // on the button (its one-shot drop held where it lands) it draws nothing but its arrow (the capture with the arrow
    // hidden equals the one with the whole button hidden: no chip), and the arrow sits in its box's centre.
    await cell("look:dlCentre", async () => {
      const v = []; await load(SIGNED_OUT);
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((x) => x.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length > 0;`), 4000);
      const tw = await page(`const t = document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card):not(:has([data-in-library])) .thumb-wrap") ?? document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .thumb-wrap");
        t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      await sleep(300);
      const mv = (x, y) => win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      // the FIRST card's button (re-found each time — a resize moves it)
      const btnSel = `document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .dl-btn")`;
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
        // no chip: with the glyph hidden the button draws nothing — the same pixels as with the whole button hidden
        await page(`document.getElementById("__dlc").textContent += " .dl-btn { visibility: hidden !important; }";`); await sleep(120);
        const C = (await win.webContents.capturePage(rect)).toBitmap();
        let chip = 0;
        for (let k = 0; k < W * H * 4; k += 4) if (Math.abs(B[k] - C[k]) + Math.abs(B[k + 1] - C[k + 1]) + Math.abs(B[k + 2] - C[k + 2]) > 30) chip++;
        // the glyph in its box: a pixel's grid snap either way (no ring to read it against any more)
        const lx = ((x0 + x1 + 1) / 2 - cx) / sc, ly = ((y0 + y1 + 1) / 2 - cy) / sc;
        fs.writeFileSync(path.join(OUT, `dlc-${label}.png`), withArrow.resize({ width: W * 8, quality: "good" }).toPNG());
        console.log(`        ${label}: ${n} arrow px, ${chip} chip px, arrow off its box's centre by (${lx.toFixed(2)}, ${ly.toFixed(2)}) css px`);
        return { lx, ly, n, chip };
      };
      // several window sizes (cards, and so the button's position, land on fractional pixels at some sizes; a small window
      // can hide it)
      const sizes = (E.LIASCAPE_DLC_SIZES || "1000x800,1920x1080,1600x900").split(",").map((x) => x.split("x").map(Number));
      for (const [W0, H0] of sizes) {
        win.setContentSize(W0, H0); await sleep(900);
        const t2 = await page(`const t = document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .thumb-wrap"); t.scrollIntoView({ block: "center" });
          const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
        Object.assign(tw, t2); await sleep(300);
        mv(tw.x + 12, tw.y + 12); // on the card, off the button: the button shows (opacity 1), not hovered
        const rest = await measure(`${W0}x${H0}-rest`, "");
        const b0 = await page(`const e = ${btnSel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
        if (!b0) { v.push(`${W0}x${H0}: no download button`); continue; }
        mv(b0.x, b0.y);
        await sleep(100); await page(`for (const e of document.querySelectorAll(".dl-glyph *")) for (const a of e.getAnimations()) a.finish();`); // its drop, landed
        const hov = await measure(`${W0}x${H0}-hover0`, ".dl-btn::before { display: none !important; }"); // the bloom is meant to show
        if (hov?.chip > 3) v.push(`${W0}x${H0}: hovered, the button draws ${hov.chip} px of its own (a chip): want the bare glyph`);
        await page(`document.getElementById("__dlc")?.remove();`);
        mv(5, 5); await sleep(300);
        if (!rest || !rest.n) { v.push(`${W0}x${H0}: no arrow pixels at rest — proved nothing`); continue; }
        if (rest.chip > 3) v.push(`${W0}x${H0}: at rest the button draws ${rest.chip} px of its own (a chip): want the bare glyph`);
        if (Math.abs(rest.lx) > 1 || Math.abs(rest.ly) > 1) v.push(`${W0}x${H0}: at rest the arrow is off its box's centre by (${rest.lx.toFixed(2)}, ${rest.ly.toFixed(2)}) css px`);
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
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length > 0;`), 4000);
      await page(`document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .thumb-wrap").click();`); await sleep(700);
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
      // a bare "Downloading…" over an empty bar for a minute looks like a hang: the CARD says the step in
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
      // with a short label ("1%") the bar still spans ~72 % of the card
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

    // docs/decisions.md § "Queue the Steam pages the user must click, one at a time, advanced by Next": the Steam to-do panel, driven by
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
      // "Let the Steam app do all N" says it needs WE, Steam running, and shows the user as playing
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
    // (a bar that shows: the Library's stays in the document, hidden, while another tab shows — App.tsx)
    const fakeBar = `if (![...document.querySelectorAll(".playlist-bar")].some((e) => e.getClientRects().length)) { const b = document.createElement("div"); b.className = "playlist-bar"; b.id = "__fakebar";
      b.style.cssText = "position:fixed;left:0;bottom:0;width:40px;height:130px;pointer-events:none"; document.body.append(b); }`;

    // the to-do panel moves smoothly — the lift
    // GLIDES (a playlist bar appearing), fold ⇄ unfold MORPHS (widths in between), a new current entry SLIDES (the carousel);
    // under no-motion nothing moves (the lift and the fold change at once) and what appears or leaves fades (components/motion.ts
    // FADE). Mid-animation shots: steam-todo-glide.png, steam-todo-fold.png, steam-todo-slide.png
    for (const motion of [true, false]) {
      await cell(`steam:todoMotion:${motion ? "on" : "off"}`, async () => {
        const v = [];
        await setSettings({ morphs: motion });
        await load(SIGNED_OUT); await tab("Browse");
        await page(`document.getElementById("__fakebar")?.remove(); [...document.querySelectorAll(".playlist-bar")].some((e) => e.getClientRects().length) && (window.__realBar = true);`);
        // motion off: what appears / leaves is sampled per frame (MO.judge)
        // (wrapped: an async function returning the bare promise would wait for the whole sample)
        const smp = async (sels, ms) => { if (motion) return { p: null }; const p = js(MO.SAMPLE(sels, ms)); await sleep(50); return { p }; };
        const pIn = await smp({ panel: "[data-steam-todo]" }, 500);
        await ev("steam-todo", { ...STEP2, current: { id: "930001", title: "Rem – Edit" } }); await sleep(900);
        const panelIn = await pIn.p;
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
        const bFold = await smp({ body: "[data-steam-todo] .st-body" }, 600);
        const fold = await (motion ? shotDuring("todo-fold", () => frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700), 90)
          : frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700));
        const bodyOut = await bFold.p, bUnfold = await smp({ body: "[data-steam-todo] .st-body" }, 600);
        const unfold = await frames(`document.querySelector("[data-steam-todo] .st-fold").click();`, PANEL_W, 700);
        const bodyIn = await bUnfold.p;
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
        const sEntry = await smp({ old: '[data-st-entry="930001"]', now: '[data-st-entry="930002"]' }, 600);
        const slide = await (motion
          ? shotDuring("todo-slide", () => frames(`window.__fakeWs("steam-todo", ${J({ ...STEP2, index: 3, remaining: 3, current: { id: "930002", title: "Emilia – Loop" } })});`, ENTRY_X("930002"), 600), 90)
          : shotDuring("todo-slide-off", () => frames(`window.__fakeWs("steam-todo", ${J({ ...STEP2, index: 3, remaining: 3, current: { id: "930002", title: "Emilia – Loop" } })});`, ENTRY_X("930002"), 600), 55));
        const moved = slide.filter((x) => x != null && Math.abs(x) > 1.5).length;
        console.log(`        slide x: [${slide.slice(0, 10).map((x) => x == null ? "–" : x.toFixed(1))}…] ${moved} offset frame(s)`);
        if (motion && moved < 3) v.push(`the new entry didn't slide in (${moved} frames off its place)`);
        if (!motion && moved > 0) v.push(`no-motion: the new entry slid (${moved} frames)`);
        if (slide.at(-1) == null || Math.abs(slide.at(-1)) > 0.5) v.push(`the new entry didn't land (x ${slide.at(-1)})`);
        const entries = await sEntry.p, pOut = await smp({ panel: "[data-steam-todo]" }, 500);
        await ev("steam-todo", { finished: true }); await sleep(500);
        if (!motion) {
          const panelOut = await pOut.p;
          console.log(`        no-motion: panel in ${MO.brief(panelIn.panel)}, body out ${MO.brief(bodyOut.body)} / in ${MO.brief(bodyIn.body)}, entry old ${MO.brief(entries.old)} / new ${MO.brief(entries.now)}, panel out ${MO.brief(panelOut.panel)}`);
          v.push(...MO.judge("no-motion: the panel coming in", panelIn.panel, { appear: true, size: false }),
            ...MO.judge("no-motion: the body folding away", bodyOut.body, { leave: true }), ...MO.judge("no-motion: the body unfolding", bodyIn.body, { appear: true }),
            ...MO.judge("no-motion: the old entry", entries.old, { leave: true }), ...MO.judge("no-motion: the new entry", entries.now, { appear: true, size: false }),
            ...MO.judge("no-motion: the panel leaving", panelOut.panel, { leave: true, size: false }));
        }
        return v;
      });
    }
    await setSettings({ morphs: true });

    // The Browse sidebar's subscribe / unsubscribe toggle for WE-local and Workshop items, and Open on Steam opening the Steam
    // client. The toggle (components/SubToggle.tsx) per the stubbed /workshop/state; its POSTs; Open on Steam
    // → POST /steam/open-page (ok:false → the https page through window.open). Shots steam-subtoggle*.png
    const openSide = async (n = 0) => { await page(`document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card) .thumb-wrap")[${n}].click();`); await sleep(800); };
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
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length > 0;`), 4000);
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
      if (!/also removes it from your library/i.test(s?.hint ?? "")) v.push(`in the library, the hint reads "${s?.hint}"`);
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
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length > 0;`), 4000);
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
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length > 0;`), 4000);
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
    // ---- the Library sidebar's Workshop ID pill and its "Delete and unsubscribe"; the Browse sidebar's "Unsubscribe without
    // deleting" (the Unsubscribe button's right-click menu, components/ContextMenu.tsx). Shots steam-idpill-*.png,
    // steam-delsource*.png, steam-keepmenu*.png
    const mvTo = async (x, y, ms = 0) => { send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); if (ms) await sleep(ms); };
    const clickAt = async (x, y, button = "left") => {
      await mvTo(x, y, 60);
      send({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button, clickCount: 1 }); await sleep(40);
      send({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
    };
    const SIDE = ".side-panel:not(.closing)";
    const PILL = `${SIDE} [data-side-row=workshop-id]`;
    const openLib = async (t) => {
      await tab("Library");
      return page(`const c = [...document.querySelectorAll(".card.lib")].find((x) => x.querySelector('[data-title="${t}"]'));
        if (!c) return false;
        c.querySelector(".thumb-wrap").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
        for (let i = 0; i < 30 && document.querySelector("${SIDE} .side-title, ${SIDE} h2")?.textContent.trim() !== "${t}"; i++) await new Promise((r) => setTimeout(r, 100));
        return !!document.querySelector("${SIDE} .side-hero");`);
    };
    // every hero chip's layout box [name, x, y, w, h] (offset*: the click's press squeeze, a transform, isn't a re-wrap) and the
    // viewport box of the pill's own, for aiming
    const HERO = `(() => { const h = document.querySelector("${SIDE} .side-hero"); if (!h) return null;
      return [...h.children].map((e) => [e.dataset.sideRow ?? e.textContent.trim().slice(0, 14), e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]); })()`;
    const pillAim = () => js(`(() => { const r = document.querySelector("${PILL}")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    // the pill's accessible name, as the accessibility tree has it (the hidden face must not be in it)
    const axName = async (sel) => {
      const d = win.webContents.debugger;
      const { root } = await d.sendCommand("DOM.getDocument", { depth: 0 });
      const { nodeId } = await d.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
      if (!nodeId) return null;
      const { nodes } = await d.sendCommand("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
      return nodes.find((n) => !n.ignored)?.name?.value ?? null;
    };
    const restoreLib = async () => { await js(`localStorage.removeItem("__probe_lib_full"); true`); win.setContentSize(1400, 900); await sleep(300); };

    // The Workshop ID pill keeps its box (and every other hero chip keeps its own) through "Copied" and back, at the window
    // widths where the hero row wraps (the sidebar is clamp(300px, 26vw, 400px) wide) and full screen; the accessible name is
    // the aria-label's (never the hidden face's words); motion on the faces roll, motion off they only cross-fade
    await cell("side:idPill:still", async () => {
      const v = [];
      await setSettings({ autoAddWeWallpapersToLibrary: false, morphs: true, glows: true, settingsLevel: "standard" });
      await js(`localStorage.setItem("__probe_lib_full", "1"); true`);
      await load(SIGNED_OUT);
      if (!(await openLib("s1"))) { await restoreLib(); return ["no sidebar for the scene s1 — proved nothing"]; }
      await sleep(700);
      const seen = [];
      for (const w of [1160, 1200, 1240, 1280, 1320, 1360, 1400, 1440, 1480, 1520, 1560, 1920]) {
        win.setContentSize(w, w >= 1920 ? 1080 : 900); await sleep(350);
        const b = await js(HERO), i = b ? b.findIndex((x) => x[0] === "workshop-id") : -1;
        if (i < 0) { v.push(`${w} px: no Workshop ID pill in the hero row (${J(b)})`); continue; }
        const wrapped = b[i][2] > b[0][2] + 2, startsRow = wrapped && (i === 0 || b[i - 1][2] < b[i][2] - 2);
        seen.push({ w, wrapped, startsRow, n: b.length });
      }
      console.log(`        rows: ${seen.map((s) => `${s.w}:${s.startsRow ? "starts a row" : s.wrapped ? "wrapped" : "first row"}`).join(" ")}`);
      const rowStarts = seen.filter((s) => s.startsRow).map((s) => s.w);
      if (!rowStarts.length) v.push("at no width does the ID pill start a row of its own — proved nothing about the re-wrap");
      const test = [...new Set([...rowStarts.slice(0, 3), rowStarts.at(-1), seen.find((s) => !s.startsRow)?.w, 1920].filter(Boolean))];
      for (const w of test) {
        win.setContentSize(w, w >= 1920 ? 1080 : 900); await sleep(400);
        await mvTo(3, 3, 200);
        const before = await js(HERO), p0 = await pillAim();
        const name0 = await axName(PILL);
        if (!/^Workshop ID \d+ — copy$/.test(name0 ?? "")) v.push(`${w} px: the pill's name before is ${J(name0)}`);
        const fr = js(`new Promise((res) => { const out = []; const t0 = performance.now();
          const f = () => { out.push({ t: Math.round(performance.now() - t0), b: ${HERO}, on: !!document.querySelector("${PILL}.done"),
            y: (() => { const e = document.querySelector("${PILL} .xfade > :last-child"); return e ? +new DOMMatrix(getComputedStyle(e).transform).m42.toFixed(2) : null; })() });
            if (performance.now() - t0 < 700) requestAnimationFrame(f); else res(out); };
          requestAnimationFrame(f); })`);
        await sleep(30);
        await clickAt(p0.x, p0.y);
        if (w === test[0]) { await sleep(90); await shot("idpill-roll"); }
        const frames = await fr;
        if (!frames.some((f) => f.on)) { v.push(`${w} px: the pill never turned into "Copied" — proved nothing`); continue; }
        const name1 = await axName(PILL);
        if (!/^Workshop ID \d+ — copied$/.test(name1 ?? "") || /Copied/.test(name1 ?? "")) v.push(`${w} px: the pill's name while copied is ${J(name1)}`);
        let moved = null;
        for (const f of frames) for (const [k, x, y, ww, h] of f.b ?? []) {
          const o = before.find((q) => q[0] === k);
          if (!o || Math.max(Math.abs(o[1] - x), Math.abs(o[2] - y), Math.abs(o[3] - ww), Math.abs(o[4] - h)) > 0.75) { moved ??= { t: f.t, k, was: o, now: [x, y, ww, h] }; }
        }
        if (moved) v.push(`${w} px: a hero chip moved or resized when the pill turned into "Copied": ${J(moved)}`);
        const ys = frames.filter((f) => f.on && f.y != null).map((f) => f.y);
        if (between(ys, 0.5) < 2) v.push(`${w} px: "Copied" didn't roll in (its y per frame ${J(ys.slice(0, 10))})`);
        if (w === 1920) await shot("idpill-copied-full");
        // back to its ID after ≈ 1.2 s: the same boxes
        await waitFor(() => js(`!document.querySelector("${PILL}.done")`), 2500); await sleep(400);
        const after = await js(HERO);
        if (J(after) !== J(before)) v.push(`${w} px: the hero row after "Copied" differs: ${J(before)} → ${J(after)}`);
      }
      // motion off: the faces only cross-fade in place (in-between opacity, no transform), the pill's box still
      await setSettings({ morphs: false });
      win.setContentSize(test[0] ?? 1400, 900); await load(SIGNED_OUT);
      if (!(await openLib("s1"))) v.push("motion off: no sidebar for s1");
      await sleep(700); await mvTo(3, 3, 150);
      if (!(await js(`document.documentElement.classList.contains("no-motion")`))) v.push("motion off: the page isn't in no-motion — proved nothing");
      const p1 = await pillAim();
      if (p1) {
        const smp = js(MO.SAMPLE({ face: `${PILL} .xfade > :last-child`, pill: PILL }, 500)); await sleep(40);
        await clickAt(p1.x, p1.y);
        const s = await smp;
        console.log(`        motion off: "Copied" ${MO.brief(s.face)}`);
        v.push(...MO.judge("motion off: \"Copied\"", s.face.map((f) => (f[1] === 0 ? [f[0], null] : f)), { appear: true }), ...MO.judge("motion off: the pill", s.pill));
        await waitFor(() => js(`!document.querySelector("${PILL}.done")`), 2500);
      }
      await setSettings({ morphs: true });
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await restoreLib();
      return v;
    });

    // "Delete from source" names the unsubscribe: the tile reads "Delete and unsubscribe" with a tooltip saying Steam is told too,
    // and the status bar after it says "Unsubscribing …"; with auto-import on, the Delete tile of a Workshop item (it also
    // unsubscribes: the import would bring it back) says so the same way, a non-Workshop item's stays a plain "Delete"
    await cell("side:deleteSource:names", async () => {
      const v = [];
      const tiles = () => page(`return [...document.querySelectorAll("${SIDE} .side-tiles > *")].map((t) => ({ text: t.textContent.trim(), title: t.getAttribute("title"),
        danger: t.classList.contains("danger"), name: t.getAttribute("aria-label") }));`);
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      await js(`localStorage.setItem("__probe_lib_full", "1"); true`);
      await load(SIGNED_OUT);
      if (!(await openLib("s1"))) { await restoreLib(); return ["no sidebar for the scene s1 — proved nothing"]; }
      await sleep(600);
      let t = await tiles(); console.log(`        auto-import off: ${J(t)}`);
      const ds = t.find((x) => /unsubscribe/i.test(x.text));
      if (!ds || ds.text !== "Delete and unsubscribe" || !ds.danger) v.push(`no "Delete and unsubscribe" tile: ${J(t)}`);
      if (ds && !/unsubscribes on Steam/i.test(ds.title ?? "")) v.push(`its tooltip doesn't name the unsubscribe: ${J(ds.title)}`);
      if (t.some((x) => /from source/i.test(x.text + (x.title ?? "")))) v.push(`"Delete from source" is still there: ${J(t)}`);
      if (!t.some((x) => x.text === "Delete" && !x.title)) v.push(`the plain Delete changed: ${J(t)}`);
      await page(`document.querySelector("${SIDE}").scrollTop = 0; document.querySelector("${SIDE} [data-delete-source]")?.scrollIntoView({ block: "center" });`); await sleep(400);
      await shot("delsource");
      const n0 = (await calls()).length;
      await page(`document.querySelector("${SIDE} [data-delete-source]")?.click();`); await sleep(700);
      const got = (await calls()).slice(n0);
      const status = await js(`document.querySelector(".status")?.textContent ?? ""`);
      console.log(`        clicked: ${J(got.map((c) => c.p))} | status "${status}"`);
      if (!got.some((c) => c.p === "/workshop/delete-from-source" && c.body?.items?.[0]?.workshopId === "900000001")) v.push(`the click posted ${J(got)}`);
      if (!/^Unsubscribing s1 — removed from your library/.test(status)) v.push(`the status bar says "${status}"`);
      // auto-import on: Delete of a Workshop item unsubscribes too — its tile says so; a plain item's doesn't
      await setSettings({ autoAddWeWallpapersToLibrary: true });
      await load(SIGNED_OUT);
      if (!(await openLib("s1"))) v.push("auto-import on: no sidebar for s1");
      else {
        await sleep(600); t = await tiles(); console.log(`        auto-import on, s1: ${J(t)}`);
        const del = t.find((x) => x.danger);
        if (t.filter((x) => x.danger).length !== 1 || del?.text !== "Delete and unsubscribe" || !/unsubscribes on Steam/i.test(del?.title ?? "")) v.push(`auto-import on, a Workshop item: ${J(t)}`);
        await shot("delsource-autoimport");
      }
      const plain = await page(`return [...document.querySelectorAll(".card.lib [data-title]")].map((e) => e.dataset.title).find((x) => !/^s\\d$/.test(x)) ?? null;`);
      if (!plain) v.push("no non-Workshop library item — proved nothing about the plain Delete");
      else if (!(await openLib(plain))) v.push(`auto-import on: no sidebar for ${plain}`);
      else {
        await sleep(600); t = await tiles(); console.log(`        auto-import on, ${plain}: ${J(t)}`);
        if (!t.some((x) => x.text === "Delete" && !x.title) || t.some((x) => /unsubscribe/i.test(x.text))) v.push(`auto-import on, a non-Workshop item: ${J(t)}`);
      }
      await setSettings({ autoAddWeWallpapersToLibrary: false });
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
      await restoreLib();
      return v;
    });

    // The Browse sidebar's Unsubscribe: a right-click on a library item's opens a menu with "Unsubscribe without deleting" (no
    // request, the plain click untouched); picking it → ONE POST /workshop/unsubscribe-keep, never /workshop/unsubscribe; Escape
    // and a click outside close it without one; an item not in the library has no menu. The menu grows in (per frame) and
    // shrinks out; no-glow and bg-live keep its fill
    const MENU = "[data-ctx-menu]";
    const browseWs = async () => {
      await load(SIGNED_OUT);
      const srcs = (await http("GET", "/sources")).json;
      const wsName = srcs.find((s) => s.supportsTagFilter)?.name;
      await tab("Browse");
      await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(wsName)})?.click();`);
      await waitFor(() => page(`return document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length > 0;`), 4000);
    };
    const btnBox = () => js(`(() => { const r = document.querySelector("[data-side-sub-btn=unsubscribe]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    const menuState = () => page(`const m = document.querySelector(${J(MENU)}); if (!m) return null; const r = m.getBoundingClientRect(), cs = getComputedStyle(m);
      return { items: [...m.querySelectorAll("[role=menuitem]")].map((b) => b.textContent.trim()), focus: document.activeElement?.dataset?.ctxItem ?? null,
        x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, closing: m.classList.contains("closing"), bg: cs.backgroundColor, shadow: cs.boxShadow,
        role: m.getAttribute("role"), titles: m.querySelectorAll("[title]").length };`);
    await cell("steam:subToggle:keepMenu", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });
      await browseWs();
      await setWs("930000", { subscribed: true, pending: null, inLibrary: true, onDisk: true });
      await openSide(0);
      let s = await waitFor(() => sub().then((x) => x && x.state === "subscribed" ? x : null), 3000);
      if (!s) return [`no subscribed toggle: ${J(await sub())}`];
      if (!/right-click keeps it/.test(s.hint ?? "")) v.push(`the hint doesn't tell about the menu: "${s.hint}"`);
      const title0 = await js(`document.querySelector("${SIDE} .side-title, ${SIDE} h2")?.textContent.trim() ?? null`);
      let b = await btnBox();
      // a real right-click: the menu grows in at the pointer (per frame: its width passes through in-between values)
      let n0 = (await calls()).length;
      const grow = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { out.push(document.querySelector(${J(MENU)})?.getBoundingClientRect().width ?? null);
        if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      await sleep(20);
      await clickAt(b.x, b.y, "right");
      await sleep(70); await shot("keepmenu-opening");
      const ws = await grow;
      let m = await menuState();
      console.log(`        menu: ${J(m)} | widths ${J(ws.filter((x) => x != null).slice(0, 8).map((x) => +x.toFixed(1)))}`);
      if (!m) return [...v, "no menu after a right-click on Unsubscribe"];
      if (J(m.items) !== J(["Unsubscribe without deleting"])) v.push(`menu items ${J(m.items)}`);
      if (m.role !== "menu" || m.titles) v.push(`role ${m.role}, ${m.titles} tooltip(s)`);
      if (m.focus !== "keep") v.push(`the first entry isn't focused (${m.focus})`);
      if (Math.min(Math.abs(m.x - b.x), Math.abs(m.r - b.x)) > 2 || Math.min(Math.abs(m.y - b.y), Math.abs(m.b - b.y)) > 2) v.push(`the menu isn't at the pointer (${J({ b, m })})`);
      if (m.x < 0 || m.y < 0 || m.r > 1400 || m.b > 900) v.push(`the menu leaves the window ${J(m)}`);
      if (between(ws, 1) < 2) v.push(`the menu didn't grow in (widths ${J(ws.slice(0, 10))})`);
      if ((await calls()).length !== n0) v.push(`the right-click sent ${J((await calls()).slice(n0))}`);
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) v.push(`the menu has no fill (${m.bg})`);
      await sleep(250); await shot("keepmenu");
      if ((await js(`document.querySelector("${SIDE} .side-title, ${SIDE} h2")?.textContent.trim() ?? null`)) !== title0) v.push("the right-click changed the sidebar");
      // Escape closes it, no request; focus back on the button
      await key("Escape"); await sleep(300);
      if (await menuState()) v.push("Escape didn't close the menu");
      if (!(await js(`document.activeElement?.dataset?.sideSubBtn === "unsubscribe"`))) v.push("after Escape the focus isn't back on Unsubscribe");
      if (!(await js(`!!document.querySelector("${SIDE}")`))) v.push("Escape in the menu closed the sidebar too");
      // a click outside closes it, no request
      await clickAt(b.x, b.y, "right"); await sleep(300);
      await clickAt(40, 450); await sleep(300);
      if (await menuState()) v.push("a click outside didn't close the menu");
      if ((await calls()).length !== n0) v.push(`closing sent ${J((await calls()).slice(n0))}`);
      // pick it: ONE POST /workshop/unsubscribe-keep, never /workshop/unsubscribe; the menu shrinks out; the status says kept
      await clickAt(b.x, b.y, "right"); await sleep(300);
      m = await menuState();
      const it = await js(`(() => { const r = document.querySelector("[data-ctx-item=keep]")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      if (!it) return [...v, "no menu entry to pick"];
      const shrink = js(`new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const e = document.querySelector(${J(MENU)}); out.push(e ? +getComputedStyle(e).opacity : null);
        if (performance.now() - t0 < 400) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })`);
      await sleep(20);
      n0 = (await calls()).length;
      await clickAt(it.x, it.y); await sleep(500);
      const ops = await shrink;
      const got = (await calls()).slice(n0);
      if (got.length !== 1 || got[0].p !== "/workshop/unsubscribe-keep" || got[0].body?.workshopId !== "930000" || got[0].body?.title !== "ws-1") v.push(`picking it posted ${J(got)}`);
      if (between(ops, 0.05) < 1 || ops.at(-1) != null) v.push(`the menu didn't fade / shrink out (opacity per frame ${J(ops.slice(0, 12))})`);
      const status = await js(`document.querySelector(".status")?.textContent ?? ""`);
      if (!/kept in your library/.test(status)) v.push(`the status bar says "${status}"`);
      // the plain left-click is still the deleting Unsubscribe
      await setWs("930000", { subscribed: true, pending: null, inLibrary: true, onDisk: true }); await bump(); await sleep(500);
      b = await btnBox(); n0 = (await calls()).length;
      await clickAt(b.x, b.y); await sleep(400);
      const plain = (await calls()).slice(n0);
      if (plain.length !== 1 || plain[0].p !== "/workshop/unsubscribe") v.push(`a left-click posted ${J(plain)}`);
      // not in the library: nothing to keep, no menu
      await setWs("930000", { subscribed: true, pending: null, inLibrary: false, onDisk: true }); await bump(); await sleep(500);
      b = await btnBox(); await clickAt(b.x, b.y, "right"); await sleep(300);
      if (await menuState()) v.push("a menu on an item that isn't in the library");
      // no-glow + bg-live: the menu keeps its own fill and loses its glow
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      await browseWs();
      await js(`window.__wsState = { "930000": { subscribed: true, pending: null, inLibrary: true, onDisk: true } }; true`);
      await openSide(0);
      await waitFor(() => sub().then((x) => x && x.state === "subscribed" ? x : null), 3000);
      b = await btnBox(); await clickAt(b.x, b.y, "right"); await sleep(350);
      m = await menuState();
      const html = await js(`document.documentElement.className`);
      console.log(`        no-glow + bg-live: ${J({ html, bg: m?.bg, shadow: m?.shadow })}`);
      if (!/no-glow/.test(html) || !/bg-live/.test(html)) v.push(`the toggles didn't apply: html "${html}"`);
      if (!m || /rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) v.push(`bg-live: the menu has no fill of its own (${m?.bg})`);
      if (m && (m.shadow.match(/rgba?\([^)]*\)/g) ?? []).some((c) => !/rgba\(0, 0, 0/.test(c))) v.push(`no-glow: the menu still glows (${m.shadow})`);
      await shot("keepmenu-live");
      await key("Escape"); await sleep(250);
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
      return v;
    });
    // motion off (Smooth window animations off): the menu fades in and out in place, nothing moves
    await cell("steam:subToggle:keepMenuOff", async () => {
      const v = [];
      await setSettings({ morphs: false });
      await browseWs();
      await setWs("930000", { subscribed: true, pending: null, inLibrary: true, onDisk: true });
      await openSide(0);
      await waitFor(() => sub().then((x) => x && x.state === "subscribed" ? x : null), 3000);
      const b = await btnBox();
      if (!b) { await setSettings({ morphs: true }); return ["no Unsubscribe button"]; }
      await mvTo(b.x, b.y, 300);
      let smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
      await clickAt(b.x, b.y, "right");
      const sIn = await smp;
      smp = js(MO.SAMPLE({ menu: MENU }, 450)); await sleep(30);
      await key("Escape");
      const sOut = await smp;
      console.log(`        motion off: in ${MO.brief(sIn.menu)} / out ${MO.brief(sOut.menu)}`);
      v.push(...MO.judge("motion off: the menu appearing", sIn.menu, { appear: true }), ...MO.judge("motion off: the menu leaving", sOut.menu, { leave: true }));
      await setSettings({ morphs: true });
      return v;
    });
    // The Browse sidebar's Copy ID tile turns into "Copied" (hooks/useCopied.ts) without any tile changing size or place
    await cell("side:copyIdTile", async () => {
      const v = [];
      await setSettings({ morphs: true, glows: true });
      await browseWs();
      await setWs("930000", { subscribed: false, pending: null, inLibrary: false, onDisk: false });
      await openSide(0);
      const TILE = `${SIDE} [data-copy-id]`;
      // layout boxes (offset*): the hover lift and the press squeeze are transforms, not a size change
      const TILES = `(() => [...document.querySelectorAll("${SIDE} .side-tiles > *")].map((e) => [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]))()`;
      const shownText = () => js(`document.querySelector("${TILE} .xfade:not(.side-tile-ico) > :not([data-off])")?.textContent.trim() ?? null`);
      if (!(await waitFor(() => js(`!!document.querySelector("${TILE}")`), 3000))) return ["no Copy ID tile in the Browse sidebar"];
      await page(`document.querySelector("${TILE}").scrollIntoView({ block: "center" });`); await sleep(400);
      const before = await js(TILES);
      const name0 = await axName(TILE);
      if (name0 !== "Copy ID") v.push(`its name at rest is ${J(name0)}`);
      const r = await js(`(() => { const r = document.querySelector("${TILE}").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      clipboard.writeText("");
      const tClick = Date.now();
      const fr = js(`new Promise((res) => { const out = []; const t0 = performance.now();
        const f = () => { out.push({ b: ${TILES}, on: !!document.querySelector("${TILE}[data-copied]"),
          y: (() => { const e = document.querySelector("${TILE} .xfade:not(.side-tile-ico) > :last-child"); return e ? +new DOMMatrix(getComputedStyle(e).transform).m42.toFixed(2) : null; })() });
          if (performance.now() - t0 < 600) requestAnimationFrame(f); else res(out); };
        requestAnimationFrame(f); })`);
      await sleep(30);
      await clickAt(r.x, r.y);
      await sleep(90); await shot("copyid-roll");
      const frames = await fr;
      if (!frames.some((f) => f.on)) return [...v, "the tile never turned into \"Copied\" — proved nothing"];
      if ((await shownText()) !== "Copied") v.push(`it reads ${J(await shownText())}, want "Copied"`);
      const name1 = await axName(TILE);
      if (name1 !== "Copied") v.push(`its name while copied is ${J(name1)}`);
      if (clipboard.readText() !== "930000") v.push(`the clipboard holds ${J(clipboard.readText())}, want "930000"`);
      const moved = frames.find((f) => J(f.b) !== J(before) && f.b.some((x, i) => x.some((n, k) => Math.abs(n - before[i][k]) > 0.75)));
      if (moved) v.push(`a tile moved or resized: ${J(before)} → ${J(moved.b)}`);
      const ys = frames.filter((f) => f.on && f.y != null).map((f) => f.y);
      if (between(ys, 0.5) < 2) v.push(`"Copied" didn't roll in (y per frame ${J(ys.slice(0, 10))})`);
      await sleep(250); await mvTo(3, 3, 100); await shot("copyid");
      // back after ≈ 1.2 s
      if (!(await waitFor(() => shownText().then((t) => t === "Copy ID"), 2500))) v.push("it never went back to Copy ID");
      else if (Date.now() - tClick < 1000) v.push(`"Copied" held only ≈ ${Date.now() - tClick} ms (want ≈ 1200)`);
      // another item's sidebar never carries "Copied"
      await clickAt(r.x, r.y); await sleep(200);
      await openSide(1);
      if (await js(`!!document.querySelector("${TILE}[data-copied]")`)) v.push("another item's sidebar shows \"Copied\"");
      // motion off: the words only fade, nothing moves
      await setSettings({ morphs: false });
      await browseWs();
      await setWs("930000", { subscribed: false, pending: null, inLibrary: false, onDisk: false });
      await openSide(0);
      await waitFor(() => js(`!!document.querySelector("${TILE}")`), 3000);
      if (!(await js(`document.documentElement.classList.contains("no-motion")`))) v.push("motion off: the page isn't in no-motion — proved nothing");
      await page(`document.querySelector("${TILE}")?.scrollIntoView({ block: "center" });`); await sleep(500);
      const r2 = await js(`(() => { const r = document.querySelector("${TILE}").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await mvTo(r2.x, r2.y, 300);
      const smp = js(MO.SAMPLE({ face: `${TILE} .xfade:not(.side-tile-ico) > :last-child`, tile: TILE }, 500)); await sleep(40);
      await clickAt(r2.x, r2.y);
      const s2 = await smp;
      console.log(`        motion off: "Copied" ${MO.brief(s2.face)}`);
      v.push(...MO.judge("motion off: \"Copied\"", s2.face, { appear: true }), ...MO.judge("motion off: the tile", s2.tile));
      await setSettings({ morphs: true });
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
