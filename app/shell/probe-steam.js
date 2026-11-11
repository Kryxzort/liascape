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
//                         words over a sweeping bar (each phase); Cancel aborts the request
// Screenshots: <LIASCAPE_OUT>/steam-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (web-backend.md § Local API security)
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
    if (p === "/browse" && m === "POST") { const b = JSON.parse(o.body); if (b.filter) return res(b.page > 1 ? [] : items); }
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
      for (const [status, want] of [[STATUS, "Click Subscribe in Steam"], ["Steam is downloading it…", "Steam is downloading…"], ["Steam is finishing…", "Steam is finishing…"]]) {
        await ev("download-progress", { id: dl.result.pageUrl, value: 0, status }); await sleep(250);
        const c = await card();
        console.log(`        card: ${J(c)}`);
        if (c.label !== want) v.push(`for "${status}" the card says "${c.label}" (expected "${want}")`);
        if (!c.indet || c.anim !== "dl-indet") v.push(`for "${status}" the card's bar isn't sweeping (indet ${c.indet}, animation ${c.anim})`);
      }
      await shot("dl-status");
      await page(`[...document.querySelectorAll("[data-side-download] button")].find((b) => /Cancel/.test(b.textContent))?.click();`); await sleep(400);
      if (!(await js(`window.__st.dl.aborted`))) v.push("Cancel didn't abort the download request");
      if (await page(`return !!document.querySelector("[data-side-download]");`)) v.push("the progress row stayed after Cancel");
      // a late status for the cancelled download doesn't bring it back
      await ev("download-progress", { id: dl.result.pageUrl, value: 0, status: STATUS }); await sleep(300);
      if (await page(`return !!document.querySelector("[data-side-download]");`)) v.push("a late download-progress brought the progress row back");
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
