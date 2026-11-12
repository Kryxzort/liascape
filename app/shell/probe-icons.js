// Icon motion probe — `scripts/test-ui-matrix.sh --probe probe-icons.js` (the matrix's hermetic stack). The vocabulary:
// docs/superpowers/specs/2026-11-12-icon-motion-design.md; the rule: .claude/rules/ui/design.md § Icon motion. Browse / Steam
// answers are stubbed in the page (like probe-steam.js: nothing reaches Steam). Per-frame samples of the icon (or its moving
// part) read in a rAF loop while a REAL pointer (sendInputEvent) hovers / presses its button.
//   icon:act:<name>     hover → the icon (or its part) animates on transform / opacity only (its animations' keyframes), starts at
//                       its rest state (no jump as the hover lands), passes
//                       through ≥ 3 in-between frames, overshoots its rest (a spring) and settles back to rest. Names: download
//                       (Browse sidebar), card-download (a Browse card's own button: the arrow into its tray), external-link
//                       + copy (the sidebar's tiles), cloud-download (Subscribe), refresh (Browse top bar),
//                       upload (Import), save + sliders + play (the playlist bar), sparkles (Settings → Transitions…), arrow-right
//                       + skip-forward + stop (the Steam to-do). Frames: <OUT>/icons-<name>-f<i>.png
//   icon:hold:<name>    trash (a Library card's delete: the lid), folder (the playlist bar's Load: the flap), x (the sidebar's
//                       close), chevron (the playlist bar's fold, clicked): hover → it moves through in-between frames, overshoots,
//                       HOLDS a moved state; leaving → back to rest through in-between frames
//   icon:object         a Settings section's chip: tilts on the spring (overshoots its held tilt) while its card is hovered
//   icon:press          mouseDown on an icon button → the icon's `scale` drops under .9 within a few frames; mouseUp → it springs
//                       back past 1 and settles at 1
//   icon:toggle         a Library card's playlist toggle clicked → the new state pops (scale through in-between frames); a fresh
//                       page pops none of the cards
//   icon:status         Subscribed's cloud-check: no motion on hover; a glow under Glow effects, none under no-glow
//   icon:loops          after hovering every icon host of the Library, the playlist bar and the Browse sidebar + card: no icon
//                       animation loops except progress (the spinner, the indeterminate bar)
//   icon:magnet[:off]   the playlist bar's Play leans toward a pointer 14 px off its edge (≤ 3 px), is home when it's far; motion
//                       off → never leans
//   icon:playRing       Play's accent ring ripples out once per hover (motion on), none with motion off
//   icon:act:off / icon:act:reduced   motion off / prefers-reduced-motion: hover / press start no animation and no transition
//                       frames (download, the close X, the press)
//   icon:still:off                    motion off: the hover holds, an emblem's tilt and the press squeeze end where they started
//   icon:perf           while one-shots, holds and the magnet run: no layout forced from script and none bigger than an icon's
//                       own SVG (dirty objects per Layout, from a trace; an idle stretch alongside for comparison), and an idle
//                       page afterwards asks for no frames (rAF callbacks)
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth");
const K = JSON.parse(E.LIASCAPE_CLIPS);
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
const setSettings = (patch) => http("POST", "/settings", patch); // a partial body merges

// before the page's own scripts: Workshop items for Browse, the Steam / subscription answers, a fake WS for the Steam to-do;
// /open and the downloads recorded, never done
const STUB = `(() => {
  const OrigWS = window.WebSocket, sockets = [];
  window.WebSocket = class extends OrigWS { constructor(...a) { super(...a); sockets.push(this); } };
  window.__fakeWs = (type, payload) => { let n = 0; for (const s of sockets) if (s.readyState === 1 && s.onmessage) { s.onmessage({ data: JSON.stringify({ type, payload }) }); n++; } return n; };
  const items = Array.from({ length: 6 }, (_, i) => ({ title: "ws-" + (i + 1), thumbnailUrl: "", animatedThumbnailUrl: null,
    pageUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + (940000 + i), resolution: "1920 x 1080", isScene: false,
    workshopId: String(940000 + i), addedAt: null, description: "fake", authorName: "probe", fileSizeBytes: 1000, subscriptions: 1,
    favorites: 1, views: 1, tags: ["Anime"], trailerKnown: true }));
  const f = window.fetch.bind(window);
  window.fetch = (u, o = {}) => {
    const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0], m = (o.method || "GET").toUpperCase();
    const res = (b, status = 200) => Promise.resolve(new Response(b == null ? "" : JSON.stringify(b), { status, headers: b == null ? {} : { "Content-Type": "application/json" } }));
    if (p === "/steam/status") return res({ signedIn: false, rejected: false, accountName: "", daysLeft: null, mode: "subscribe" });
    if (p.startsWith("/steam/")) return res(null);
    if (p === "/steam-todo") return res({ finished: true });
    if (p.startsWith("/steam-todo/") && m === "POST") return res(null);
    if (p === "/workshop/state" && m === "POST") { const ids = JSON.parse(o.body).ids || [], r = {};
      for (const id of ids) r[id] = (window.__subscribed || []).includes(id) ? { subscribed: true, pending: null, inLibrary: false, onDisk: true } : { subscribed: false, pending: null, inLibrary: false, onDisk: false };
      return res(r); }
    if (p.startsWith("/workshop/") && m === "POST") return res({ subscribed: false, inSteamTodo: true, message: "" });
    if (p === "/browse" && m === "POST") { const b = JSON.parse(o.body); if (b.filter) return res(b.page > 1 ? [] : items); }
    if (p === "/detail" && m === "POST") return res({ title: "x", previewUrl: "", downloadUrl: "", needsReferrer: false });
    if ((p === "/download" || p === "/open") && m === "POST") return new Promise(() => {});
    return f(u, o);
  };
})();`;

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__ic = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; },
  // one frame's look of an element: its transform (matrix → translate, rotation, scale), the individual rotate / scale
  // properties, opacity
  look(el) { const cs = getComputedStyle(el); const t = cs.transform; const mx = new DOMMatrixReadOnly(t === "none" ? undefined : t);
    const sc = cs.scale === "none" ? 1 : parseFloat(cs.scale); const rot = cs.rotate === "none" ? 0 : parseFloat(cs.rotate);
    return { tx: mx.m41, ty: mx.m42, ang: Math.atan2(mx.m12, mx.m11) * 180 / Math.PI + rot, sx: Math.hypot(mx.m11, mx.m12) * sc, sy: Math.hypot(mx.m21, mx.m22) * sc,
      skew: mx.m21, op: +cs.opacity }; },
  // samples \`el\` (a getter: it may remount) every frame for n frames
  sample(get, n) { return new Promise((res) => { const out = []; const f = () => { const e = get(); out.push(e ? this.look(e) : null); if (out.length >= n) res(out); else requestAnimationFrame(f); }; requestAnimationFrame(f); }); },
  // the properties every animation on it (and its subtree) moves
  // (not the hosts' hover colour fades — CSS transitions of state, not the icon's motion)
  animProps(el) { const s = new Set(); for (const a of el.getAnimations({ subtree: true })) { const fx = a.effect; if (!fx?.getKeyframes || a instanceof CSSTransition) continue;
    for (const k of fx.getKeyframes()) for (const p of Object.keys(k)) if (!["offset", "computedOffset", "easing", "composite"].includes(p)) s.add(p); } return [...s]; },
};
true`;
const page = (code) => js(`(async () => { const m = window.__ic; ${code} })()`);
const send = (e) => win.webContents.sendInputEvent(e);
const mv = async (x, y, ms = 0) => { send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); if (ms) await sleep(ms); };
async function tab(name) { await page(`m.byText(".tab", ${J(name)}).click();`); await sleep(700); }
async function load() {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= 4) break; await sleep(100); }
  for (let i = 0; i < 50; i++) { if (await js(`window.__fakeWs ? window.__fakeWs("noop", null) : 0`) > 0) break; await sleep(100); }
  await js(PAGE); await sleep(500);
}
async function setMotion(on) {
  await tab("Settings");
  for (let i = 0; i < 80 && !(await js(`!!document.querySelector(".srow")`)); i++) await sleep(100);
  await page(`const row = [...document.querySelectorAll(".srow")].find((r) => r.querySelector(".slabel")?.textContent.includes("Smooth window animations"));
    if (!row) throw new Error("no Smooth window animations row");
    const cb = row.querySelector("input[type=checkbox]"); if (cb.checked !== ${on}) cb.click(); await m.sleep(500);`);
}
async function reducedMotion(on) {
  const d = win.webContents.debugger; if (!d.isAttached()) d.attach("1.3");
  await d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] });
}
async function browse() { // the Workshop source's (stubbed) items
  await tab("Browse");
  const srcs = (await http("GET", "/sources")).json || [];
  const ws = srcs.find((x) => x.supportsTagFilter)?.name;
  await page(`[...document.querySelectorAll(".pill")].find((e) => e.textContent.trim() === ${J(ws)})?.click();`);
  for (let i = 0; i < 40 && !(await js(`document.querySelectorAll(".scroll:not(.lib-scroll) .card:not(.skel-card)").length > 0`)); i++) await sleep(100);
}
async function browseSide() { // the first Browse card's sidebar
  await browse(); await mv(3, 3, 100);
  await page(`document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .thumb-wrap").click();`);
  for (let i = 0; i < 30 && !(await js(`!!document.querySelector(".side-panel[data-side=browse]:not(.closing) .side-go")`)); i++) await sleep(100);
  await sleep(700);
}
async function closeSide() { await page(`document.querySelector(".side-panel:not(.closing) [data-side-close]")?.click();`); await sleep(500); }
async function steamTodo() { // a fake Steam to-do (3 entries left)
  await js(`window.__fakeWs("steam-todo", { finished: false, action: "subscribe", index: 2, total: 4, remaining: 3, current: { id: "940001", title: "ws-2" },
    delivered: false, autoNext: false, message: null, busy: false })`);
  for (let i = 0; i < 30 && !(await js(`!!document.querySelector("[data-st=next]")`)); i++) await sleep(100);
  await sleep(500);
}

// where the pointer goes: a button's centre (expr = a page expression for the HOST), and what moves (part = a selector inside
// it, null = its svg.lucide)
async function centre(host) {
  const r = await page(`const h = ${host}; if (!h) return null; h.scrollIntoView({ block: "nearest" }); await m.sleep(60); const b = h.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };`);
  if (!r || !r.w) throw new Error(`no ${host}`);
  return r;
}
const partExpr = (host, part) => `(() => { const h = ${host}; return h ? h.querySelector(${J(part || "svg.lucide")}) : null; })()`;
// the scalar a role moves: whichever component deviates most from rest across the samples
function motionOf(samples, rest) {
  const keys = ["tx", "ty", "ang", "sx", "sy", "skew", "op"], s = samples.filter(Boolean);
  let best = null, dev = 0;
  for (const k of keys) { const d = Math.max(...s.map((x) => Math.abs(x[k] - rest[k]))); if (d > dev) { dev = d; best = k; } }
  return { key: best, dev, vals: best ? s.map((x) => x[best] - rest[best]) : [] };
}
const EPS = { tx: 0.08, ty: 0.08, ang: 0.6, sx: 0.006, sy: 0.006, skew: 0.006, op: 0.02 };
// in-between frames (neither rest nor the extreme), a crossing of `target` after the peak (an overshoot), the last value
function judge(vals, key, target = 0) {
  const eps = EPS[key] ?? 0.05, peak = vals.reduce((a, v, i) => (Math.abs(v - target) > Math.abs(vals[a] - target) ? i : a), 0);
  const between = vals.filter((v) => Math.abs(v) > eps && Math.abs(v - vals[peak]) > eps).length;
  let cross = 0;
  for (let i = peak + 1; i < vals.length; i++) if (Math.sign(vals[i] - target) !== Math.sign(vals[peak] - target) && Math.abs(vals[i] - target) > eps / 2) cross++;
  return { between, cross, last: vals[vals.length - 1], eps };
}
async function frames(name, host, stay) { // a short strip, motion on: what the owner looks at
  const r = await page(`const h = ${host}; if (!h) return null; const b = h.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };`);
  if (!r) return;
  const pad = 10, rect = { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)), width: Math.ceil(r.w + 2 * pad), height: Math.ceil(r.h + 2 * pad) };
  if (stay) await mv(r.x - 30, r.y - 30, 900); else await mv(3, 3, 900);
  await mv(r.x + r.w / 2, r.y + r.h / 2);
  for (let i = 0; i < 6; i++) {
    const img = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(OUT, `icons-${name}-f${i}.png`), img.resize({ width: img.getSize().width * 4, quality: "good" }).toPNG());
    await sleep(70);
  }
}

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
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
    await mv(3, 3, 50);
  };

  // hover → one-shot: animations on transform / opacity only, in-between frames, an overshoot, back at rest
  async function act(name, setup, host, part, opts = {}) {
    await cell(`icon:act:${name}`, async () => {
      const v = [];
      await setup();
      const c = await centre(host);
      if (opts.stay) await mv(c.x - 30, c.y - 30, 900); else await mv(3, 3, 900); // stay: park on its card (it shows only there)
      const rest = await page(`const e = ${partExpr(host, part)}; return e ? m.look(e) : null;`);
      if (!rest) return [`no icon part ${part || "svg.lucide"} in ${host} — proved nothing`];
      await page(`window.__smp = m.sample(() => ${partExpr(host, part)}, ${opts.n ?? 75}); true`);
      await mv(c.x, c.y);
      // read 120 ms into the hover, while the one-shot still runs: its first keyframe must be the icon's rest state (a
      // first keyframe off rest is a visible jump the moment the hover lands)
      const { props, offRest } = await page(`await m.sleep(120); const e = ${partExpr(host, "svg")}; if (!e) return { props: [], offRest: [] };
        const offRest = e.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSTransition)).map((a) => a.effect.getKeyframes()[0])
          .filter((f) => (f.transform && f.transform !== "none" && !new DOMMatrixReadOnly(f.transform).isIdentity) || (f.opacity != null && +f.opacity !== 1)).map((f) => (f.transform ?? "") + " o" + (f.opacity ?? 1));
        return { props: m.animProps(e), offRest };`);
      const s = await js(`window.__smp`);
      const mo = motionOf(s, rest), j = judge(mo.vals, mo.key);
      console.log(`        ${name}: moves ${mo.key} (max ${mo.dev.toFixed(2)}), ${j.between} in-between frames, ${j.cross} past rest after the peak, ends ${j.last?.toFixed(3)}; animates ${J(props)}`);
      if (j.between < 3) v.push(`hover: the icon doesn't animate (${j.between} in-between frames${mo.key ? ` of ${mo.key}` : ""})`);
      else {
        if (!opts.noOvershoot && j.cross < 1) v.push(`hover: no spring — it never passes its rest after the peak (${mo.key})`);
        if (Math.abs(j.last) > j.eps * 2) v.push(`hover: it doesn't settle at rest (${mo.key} ends ${j.last.toFixed(3)})`);
      }
      if (offRest.length) v.push(`hover: starts off its rest state (${offRest.join("; ")}) — it jumps when the hover lands`);
      const bad = props.filter((p) => !["transform", "opacity", "transformOrigin"].includes(p));
      if (bad.length) v.push(`animates ${bad.join(", ")} (transform / opacity only)`);
      await frames(name, host, opts.stay);
      return v;
    });
  }
  // hover → a held state on the spring, and back on leave
  async function hold(name, setup, host, part, trigger) {
    await cell(`icon:hold:${name}`, async () => {
      const v = [];
      await setup();
      const c = await centre(host);
      if (!trigger) await mv(3, 3, 900);
      const rest = await page(`const e = ${partExpr(host, part)}; return e ? m.look(e) : null;`);
      if (!rest) return [`no icon part ${part} in ${host} — proved nothing`];
      await page(`window.__smp = m.sample(() => ${partExpr(host, part)}, 60); true`);
      if (trigger) await trigger(c); else await mv(c.x, c.y);
      const s = await js(`window.__smp`);
      const mo = motionOf(s, rest);
      const held = mo.vals[mo.vals.length - 1] ?? 0;
      const j = judge(mo.vals, mo.key, held);
      console.log(`        ${name} in: ${mo.key} → held ${held.toFixed(3)}, ${j.between} in-between, ${j.cross} past the held value`);
      if (Math.abs(held) < (EPS[mo.key] ?? 0.05) * 3) return [...v, `hover: no held state (${mo.key} ${held.toFixed(3)}, max ${mo.dev.toFixed(3)}) — the part doesn't move`];
      if (j.between < 3) v.push(`in: it jumps (${j.between} in-between frames)`);
      if (j.cross < 1) v.push(`in: no spring — it never passes its held ${mo.key} (${held.toFixed(3)})`);
      await frames(name, host);
      if (trigger) return v;
      await mv(c.x, c.y, 900);
      await page(`window.__smp = m.sample(() => ${partExpr(host, part)}, 60); true`);
      await mv(3, 3);
      const s2 = (await js(`window.__smp`)).filter(Boolean).map((x) => x[mo.key] - rest[mo.key]);
      const j2 = judge(s2.map((x) => x - held), mo.key, -held);
      const back = s2[s2.length - 1];
      if (Math.abs(back) > (EPS[mo.key] ?? 0.05) * 2) v.push(`out: not back at rest (${mo.key} ${back.toFixed(3)})`);
      if (j2.between < 3) v.push(`out: it jumps back (${j2.between} in-between frames)`);
      return v;
    });
  }

  try {
    await http("POST", "/playlist/state", { videoPaths: K.slice(0, 3), settings: null, name: null });
    await setSettings({ morphs: true, glows: true, settingsLevel: "standard" });
    await load();
    const lib = async () => { await closeSide(); await tab("Library"); await mv(3, 3, 300); };
    const bar = (label) => `document.querySelector('.playlist-bar-head [title=${J(label)}]')`;
    const sideBtn = (t) => `[...document.querySelectorAll(".side-panel:not(.closing) button, .side-panel:not(.closing) a")].find((b) => b.textContent.trim() === ${J(t)})`;

    // ---- act ----
    await act("download", browseSide, sideBtn("Download & Apply"), ":scope svg.lucide-download > :nth-child(1)");
    await act("external-link", browseSide, sideBtn("Open on Steam"), ":scope svg.lucide-external-link > :nth-child(2)");
    await act("copy", browseSide, sideBtn("Copy ID"), ":scope svg.lucide-copy > rect");
    await act("cloud-download", browseSide, `document.querySelector("[data-side-sub-btn=subscribe]")`, ":scope svg.lucide-cloud-download > :nth-child(1)");
    await act("refresh", async () => { await closeSide(); await browse(); }, `document.querySelector(".pills .mini[aria-label=Refresh]")`, null, { n: 80 });
    await act("upload", lib, `[...document.querySelectorAll(".topbar .btn")].find((b) => b.textContent.trim() === "Import")`, ":scope svg.lucide-upload > :nth-child(1)");
    await act("save", lib, bar("Save playlist"), null);
    await act("sliders", lib, bar("Playlist settings"), ":scope svg.lucide-sliders-horizontal > :nth-child(3)");
    await act("play", lib, `document.querySelector(".play-btn")`, null);
    await cell("icon:playRing", async () => {
      // Play's push: one accent ring ripples out from the button once per hover (index.css .play-btn::after), never under motion off
      const v = [];
      const ring = async () => { const c = await centre(`document.querySelector(".play-btn")`); await mv(3, 3, 500); await mv(c.x, c.y, 250);
        return page(`return document.getAnimations().filter((a) => a.animationName === "play-ring" && a.effect.pseudoElement === "::after").length;`); };
      await lib();
      const on = await ring();
      if (on !== 1) v.push(`motion on: ${on} ring animations on hover (want 1)`);
      await setSettings({ morphs: false }); await load(); await lib();
      const off = await ring();
      if (off !== 0) v.push(`motion off: ${off} ring animations on hover (want 0)`);
      await setSettings({ morphs: true }); await load();
      return v;
    });
    await act("sparkles", async () => { await tab("Settings"); await sleep(600); }, `[...document.querySelectorAll(".settings .btn")].find((b) => b.querySelector(".lucide-sparkles"))`, ":scope svg.lucide-sparkles > :nth-child(1)");
    await act("arrow-right", async () => { await lib(); await steamTodo(); }, `document.querySelector("[data-st=next]")`, null);
    await act("skip-forward", steamTodo, `document.querySelector("[data-st=skip]")`, ":scope svg.lucide-skip-forward > :nth-child(2)");
    await act("stop", steamTodo, `document.querySelector("[data-st=stop]")`, null);
    await js(`window.__fakeWs("steam-todo", { finished: true })`);
    // the Browse card's own (hand-drawn) download button: the arrow drops into its tray
    await act("card-download", async () => { await closeSide(); await browse();
      const t = await centre(`document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .thumb-wrap")`); await mv(t.x - 10, t.y - 10, 300); },
      `document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .dl-btn")`, ":scope .dl-glyph .dl-arrow", { stay: true });

    // ---- hold ----
    await hold("trash", async () => { await lib(); const c = await centre(`document.querySelector(".card.lib .thumb-wrap")`); await mv(c.x, c.y - 20, 400); },
      `document.querySelector(".card.lib .del")`, ":scope svg.lucide-trash-2 > :nth-child(4)");
    await hold("folder", lib, bar("Load playlist"), ":scope svg > :nth-child(2)");
    await hold("x", browseSide, `document.querySelector(".side-panel:not(.closing) [data-side-close]")`, null);
    await hold("chevron", lib, `document.querySelector(".playlist-bar-head .mini")`, ":scope svg.lucide", async (c) => {
      await mv(c.x, c.y, 50); send({ type: "mouseDown", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 });
      await sleep(30); send({ type: "mouseUp", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 }); });
    // unfold it again
    await page(`document.querySelector(".playlist-bar-head .mini").click();`); await sleep(600);

    // ---- object ----
    await cell("icon:object", async () => {
      await closeSide(); await tab("Settings"); await sleep(900);
      const sec = `document.querySelector(".ssection")`, ico = `document.querySelector(".ssection .ssection-ico")`;
      const c = await centre(sec); await mv(3, 3, 400);
      const rest = await page(`return m.look(${ico});`);
      await page(`window.__smp = m.sample(() => ${ico}, 60); true`);
      await mv(c.x, c.y);
      const s = await js(`window.__smp`), mo = motionOf(s, rest), held = mo.vals[mo.vals.length - 1], j = judge(mo.vals, mo.key, held);
      console.log(`        section chip: ${mo.key} → ${held?.toFixed(2)}, ${j.between} in-between, ${j.cross} past it`);
      const v = [];
      if (Math.abs(held) < 1) return ["the section chip doesn't tilt — proved nothing"];
      if (j.cross < 1) v.push(`no spring: the tilt never passes its held ${mo.key} (${held.toFixed(2)})`);
      return v;
    });

    // ---- press ----
    await cell("icon:press", async () => {
      await lib();
      const host = bar("Save playlist"), c = await centre(host);
      await mv(c.x, c.y, 1100);
      await page(`window.__smp = m.sample(() => ${partExpr(host, null)}, 12); true`);
      send({ type: "mouseDown", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 });
      const down = (await js(`window.__smp`)).filter(Boolean).map((x) => x.sx);
      await page(`window.__smp = m.sample(() => ${partExpr(host, null)}, 60); true`);
      send({ type: "mouseUp", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 });
      const up = (await js(`window.__smp`)).filter(Boolean).map((x) => x.sx);
      await page(`document.querySelector(".modal-backdrop")?.click(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));`);
      await sleep(400);
      const v = [], lo = Math.min(...down), hi = Math.max(...up), end = up[up.length - 1];
      console.log(`        press: scale down to ${lo.toFixed(3)} (${down.map((x) => x.toFixed(2)).join(" ")}); release peaks ${hi.toFixed(3)}, ends ${end.toFixed(3)}`);
      if (!(lo < 0.9)) v.push(`press: the icon doesn't squeeze (min scale ${lo.toFixed(3)})`);
      else if (down.findIndex((x) => x < 0.9) > 6) v.push("press: the squeeze comes late (> 6 frames)");
      if (!(hi > 1.005)) v.push(`release: no spring back past 1 (peak ${hi.toFixed(3)})`);
      if (Math.abs(end - 1) > 0.01) v.push(`release: doesn't settle at 1 (${end.toFixed(3)})`);
      return v;
    });

    // ---- toggle ----
    await cell("icon:toggle", async () => {
      await lib();
      const v = [];
      const atLoad = await page(`return [...document.querySelectorAll(".pl-toggle svg")].filter((s) => s.getAnimations().length).length;`);
      if (atLoad) v.push(`${atLoad} playlist toggles pop on a page load`);
      const host = `document.querySelectorAll(".card.lib .pl-toggle")[3]`;
      const c = await centre(host);
      const was = await page(`return ${host}.classList.contains("on");`);
      await mv(c.x, c.y, 300);
      await page(`window.__smp = m.sample(() => ${partExpr(host, "svg")}, 40); true`);
      send({ type: "mouseDown", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 }); await sleep(30);
      send({ type: "mouseUp", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 });
      const s = (await js(`window.__smp`)).filter(Boolean).map((x) => x.sx);
      const now = await page(`return ${host}.classList.contains("on");`);
      const between = s.filter((x) => x < 0.97).length, cross = s.filter((x) => x > 1.005).length;
      console.log(`        toggle ${was} → ${now}: scale ${s.map((x) => x.toFixed(2)).join(" ")}`);
      if (was === now) return [...v, "the click didn't toggle — proved nothing"];
      if (between < 3) v.push(`the new state doesn't pop (${between} frames under scale .97)`);
      if (!cross) v.push("the pop doesn't spring past 1");
      await page(`${host}.click();`); await sleep(500);
      return v;
    });

    // ---- status ----
    await cell("icon:status", async () => {
      const v = [];
      await js(`window.__subscribed = ["940000"]`);
      await browseSide();
      const ico = `document.querySelector(".side-sub-ico.subscribed svg")`;
      if (!(await js(`!!${ico}`))) return ["no Subscribed icon — proved nothing"];
      const c = await centre(`document.querySelector(".side-sub-ico")`);
      await page(`window.__smp = m.sample(() => ${ico}, 30); true`);
      await mv(c.x, c.y);
      const s = (await js(`window.__smp`)).filter(Boolean), moved = s.some((x) => Math.abs(x.tx) + Math.abs(x.ty) + Math.abs(x.ang) > 0.05 || Math.abs(x.sx - 1) > 0.005);
      const glowOn = await js(`getComputedStyle(${ico}).filter`);
      if (moved) v.push("a status icon moves on hover");
      if (!/drop-shadow/.test(glowOn)) v.push(`glows on: no glow on the status icon (filter ${glowOn})`);
      await setSettings({ glows: false }); await load(); await js(`window.__subscribed = ["940000"]`); await browseSide();
      const glowOff = await js(`(${ico}) ? getComputedStyle(${ico}).filter : "?"`);
      if (glowOff !== "none") v.push(`no-glow: the status icon still glows (filter ${glowOff})`);
      console.log(`        status: moved ${moved}; filter ${glowOn} / no-glow ${glowOff}`);
      await setSettings({ glows: true }); await load(); await js(`window.__subscribed = []`);
      return v;
    });

    // ---- loops ----
    await cell("icon:loops", async () => {
      const v = [], hosts = [];
      const visit = async (sel) => {
        const pts = await page(`return [...document.querySelectorAll(${J(sel)})].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.bottom > 0 && b.top < innerHeight; })
          .slice(0, 14).map((e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });`);
        for (const p of pts) { await mv(p.x, p.y, 120); hosts.push(sel); }
        await sleep(500);
        const loops = await page(`return document.getAnimations().filter((a) => { const t = a.effect?.target; const it = a.effect?.getComputedTiming?.().iterations;
          return it === Infinity && t && (t.closest("svg") || t.matches?.(".dl-glyph, .side-dl-ico")) && !t.closest(".side-sub-spin, .dl-bar"); })
          .map((a) => (a.animationName || "waapi") + " on " + (a.effect.target.getAttribute("class") || a.effect.target.tagName));`);
        if (loops.length) v.push(`after hovering ${sel}: looping icon animations ${[...new Set(loops)].join(", ")}`);
      };
      await lib();
      await visit(".topbar button");
      await visit(".playlist-bar-head button");
      const c = await centre(`document.querySelector(".card.lib .thumb-wrap")`); await mv(c.x, c.y - 20, 300);
      await visit(".card.lib:hover button");
      await browse(); await mv(3, 3, 200);
      const t = await centre(`document.querySelector(".scroll:not(.lib-scroll) .card:not(.skel-card) .thumb-wrap")`); await mv(t.x - 10, t.y - 10, 300);
      await visit(".scroll:not(.lib-scroll) .card:not(.skel-card) .dl-btn");
      await browseSide();
      await visit(".side-panel:not(.closing) button");
      console.log(`        hovered ${hosts.length} icon hosts`);
      if (hosts.length < 12) v.push(`only ${hosts.length} hosts hovered — proved little`);
      return v;
    });

    // ---- magnet ----
    const magnet = async (off) => {
      const v = [];
      await lib();
      const host = `document.querySelector(".play-btn")`, r = await centre(host);
      const tr = () => page(`const t = getComputedStyle(${host}).translate; return t === "none" ? [0, 0] : t.split(" ").map(parseFloat).concat([0]).slice(0, 2);`);
      await mv(3, 3, 700); const far = await tr();
      await mv(r.x + r.w / 2 + 14, r.y + 2, 120); await mv(r.x + r.w / 2 + 12, r.y + 3, 500); const near = await tr();
      await mv(r.x - r.w / 2 - 14, r.y, 120); await mv(r.x - r.w / 2 - 12, r.y, 500); const left = await tr();
      await mv(3, 3, 800); const back = await tr();
      console.log(`        magnet${off ? " (motion off)" : ""}: far ${J(far)}, 12 px right ${J(near)}, 12 px left ${J(left)}, far again ${J(back)}`);
      if (off) { if ([near, left].some((p) => Math.hypot(...p) > 0.05)) v.push(`motion off: Play still leans (${J(near)} / ${J(left)})`); return v; }
      if (!(near[0] > 0.3)) v.push(`Play doesn't lean toward a pointer on its right (${J(near)})`);
      if (!(left[0] < -0.3)) v.push(`Play doesn't lean toward a pointer on its left (${J(left)})`);
      if ([near, left].some((p) => Math.abs(p[0]) > 3.05 || Math.abs(p[1]) > 2.05)) v.push(`Play leans too far (${J(near)} / ${J(left)})`);
      if (Math.hypot(...far) > 0.05 || Math.hypot(...back) > 0.05) v.push(`far away Play isn't home (${J(far)} / ${J(back)})`);
      return v;
    };
    await cell("icon:magnet", () => magnet(false));

    // ---- perf: holds and one-shots lay out nothing beyond the icon, force no layout; idle → no frames ----
    // An SVG child's transform re-lays-out that <svg>'s own few objects in Chromium (counted as a Layout), so the guard is
    // the SIZE of each layout (dirty objects, from the trace) and that none is forced from script — not their count.
    await cell("icon:perf", async () => {
      const v = [];
      await lib();
      const d = win.webContents.debugger;
      const targets = [bar("Save playlist"), bar("Playlist settings"), bar("Load playlist"), `document.querySelector(".play-btn")`];
      const pts = []; for (const t of targets) pts.push(await centre(t));
      const run = async (hover) => {
        await mv(3, 3, 900);
        const evs = []; let done;
        const onMsg = (_e, method, params) => { if (method === "Tracing.dataCollected") evs.push(...params.value); else if (method === "Tracing.tracingComplete") done(); };
        d.on("message", onMsg);
        await d.sendCommand("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] }, transferMode: "ReportEvents" });
        await page(`window.__smp = m.sample(() => null, 150); true`); // ~150 frames
        if (hover) for (const p of pts) await mv(p.x, p.y, 550);
        await js(`window.__smp`);
        const complete = new Promise((r) => { done = r; });
        await d.sendCommand("Tracing.end"); await complete;
        d.removeListener("message", onMsg);
        const SCRIPT = new Set(["FunctionCall", "EventDispatch", "FireAnimationFrame", "TimerFire", "EvaluateScript", "v8.callFunction"]);
        const xs = evs.filter((e) => e.ph === "X").sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0));
        const stack = []; let n = 0, forced = 0, maxDirty = 0, dirty = 0;
        for (const e of xs) {
          while (stack.length && stack[stack.length - 1].ts + (stack[stack.length - 1].dur || 0) <= e.ts) stack.pop();
          if (e.name === "Layout") { n++; const k = e.args?.beginData?.dirtyObjects ?? 0; dirty += k; maxDirty = Math.max(maxDirty, k);
            if (stack.some((q) => SCRIPT.has(q.name))) forced++; }
          stack.push(e);
        }
        return { n, forced, maxDirty, dirty };
      };
      const base = await run(false), hov = await run(true);
      console.log(`        ~150 frames idle: ${J(base)}; with ${pts.length} hovers (one-shots, the flap, the magnet): ${J(hov)}`);
      if (hov.forced) v.push(`${hov.forced} layouts forced from script while icons moved`);
      if (hov.maxDirty > 30) v.push(`a layout of ${hov.maxDirty} dirty objects while icons moved (more than an icon's own)`);
      await mv(3, 3, 1500);
      await js(`(() => { window.__rafN = 0; if (!window.__rafWrapped) { const o = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => { window.__rafN++; return o(cb); }; window.__rafWrapped = true; } })()`);
      await sleep(3000);
      const raf = await js(`window.__rafN`);
      console.log(`        idle 3 s after: ${raf} rAF callbacks`);
      if (raf > 12) v.push(`an idle page asks for frames (${raf} rAF callbacks in 3 s)`);
      return v;
    });

    // ---- motion off / reduced ----
    const off = async (how) => {
      if (how === "reduced") await reducedMotion(true); else await setMotion(false);
      const v = [];
      // download (a one-shot), the close X (a hold), the press — no animation, no transition frames
      await browseSide();
      for (const [name, host, part] of [["download", sideBtn("Download & Apply"), ":scope svg.lucide-download > :nth-child(1)"],
        ["x", `document.querySelector(".side-panel:not(.closing) [data-side-close]")`, null]]) {
        const c = await centre(host); await mv(3, 3, 300);
        const rest = await page(`return m.look(${partExpr(host, part)});`);
        await page(`window.__smp = m.sample(() => ${partExpr(host, part)}, 40); true`);
        await mv(c.x, c.y);
        const s = await js(`window.__smp`), mo = motionOf(s, rest), j = judge(mo.vals, mo.key);
        const anims = await page(`return ${partExpr(host, "svg")}.getAnimations({ subtree: true }).length;`);
        if (anims) v.push(`${name}: ${anims} animations started with motion ${how}`);
        if (mo.key && j.between > 1) v.push(`${name}: ${j.between} in-between frames of ${mo.key} with motion ${how}`);
      }
      await lib();
      const host = bar("Save playlist"), c = await centre(host);
      await mv(c.x, c.y, 800);
      await page(`window.__smp = m.sample(() => ${partExpr(host, null)}, 20); true`);
      send({ type: "mouseDown", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 });
      const s = (await js(`window.__smp`)).filter(Boolean).map((x) => x.sx);
      send({ type: "mouseUp", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 });
      await sleep(200); await page(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.querySelector(".modal-backdrop")?.click();`);
      if (s.filter((x) => x < 0.995 && x > 0.83).length > 1) v.push(`press: the squeeze eases with motion ${how} (${s.map((x) => x.toFixed(2)).join(" ")})`);
      if (how === "reduced") await reducedMotion(false); else await setMotion(true);
      return v;
    };
    await cell("icon:act:off", () => off("off"));
    // motion off = icons stay still, not snap: the X's quarter turn, the trash lid, a section emblem's tilt and the press
    // squeeze end where they started. Each is checked first with motion ON (it must move there, or this proved nothing).
    await cell("icon:still:off", async () => {
      const v = [], J = JSON.stringify;
      const cases = [
        ["x", browseSide, `document.querySelector(".side-panel:not(.closing) [data-side-close]")`, `document.querySelector(".side-panel:not(.closing) [data-side-close] svg")`],
        ["trash lid", async () => { await closeSide(); await lib(); const c = await centre(`document.querySelector(".card.lib .thumb-wrap")`); await mv(c.x, c.y - 20, 400); },
          `document.querySelector(".card.lib .del")`, `document.querySelector(".card.lib .del svg.lucide-trash-2 > :nth-child(4)")`],
        ["section emblem", async () => { await closeSide(); await tab("Settings"); await sleep(900); },
          `document.querySelector(".ssection")`, `document.querySelector(".ssection .ssection-ico")`],
      ];
      const moved = (l) => Math.abs(l.ang) > 1 || Math.abs(l.sx - 1) > 0.02 || Math.abs(l.tx) > 0.3 || Math.abs(l.ty) > 0.3 || Math.abs(l.skew) > 0.02;
      const run = async () => {
        const out = {};
        for (const [name, go, host, part] of cases) {
          await go(); const c = await centre(host); await mv(c.x, c.y, 120); await sleep(500);
          out[name] = await page(`return m.look(${part});`); await mv(3, 3, 200);
        }
        await lib(); const c = await centre(bar("Save playlist")); await mv(c.x, c.y, 300);
        send({ type: "mouseDown", x: Math.round(c.x), y: Math.round(c.y), button: "left", clickCount: 1 }); await sleep(250);
        out.press = await page(`return m.look(${bar("Save playlist")}.querySelector("svg.lucide"));`);
        await mv(3, 3, 50); send({ type: "mouseUp", x: 3, y: 3, button: "left", clickCount: 1 }); await sleep(200);
        return out;
      };
      const on = await run();
      await setMotion(false);
      try {
        const offL = await run();
        console.log(`        on ${J(on)}\n        off ${J(offL)}`);
        for (const k of Object.keys(on)) {
          if (!moved(on[k])) v.push(`${k}: doesn't move with motion on either — proved nothing (${J(on[k])})`);
          else if (moved(offL[k])) v.push(`${k}: still moves with motion off (${J(offL[k])})`);
        }
      } finally { await setMotion(true); }
      return v;
    });
    await cell("icon:act:reduced", () => off("reduced"));
    await cell("icon:magnet:off", async () => { await setMotion(false); try { return await magnet(true); } finally { await setMotion(true); } });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`ICONS pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "icons.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
