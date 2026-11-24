// Cards leaving and joining probe — `scripts/test-ui-matrix.sh --probe probe-presence.js` (the matrix's hermetic stack). A card
// that leaves a list (the Library grid, Browse's grid, the playlist bar's row) fades and shrinks out where it was, its
// neighbours glide into the gap, a card that joins grows in (the leave backwards), Undo included (app/ui/src/hooks/usePresence.ts).
// Every cell samples the cards per animation frame (the box as drawn and the opacity as seen) and the animations the lists run.
//   lib:trash         a Library card's Delete: it passes through in-between opacities as it shrinks, then goes; the next card
//                     glides into its slot through in-between places
//   lib:undo          Undo after it: the card grows back in through in-between opacities, the next card glides back
//   lib:filter        a search that hides some cards: one leaves, a kept one glides to its new slot; clearing it brings the hidden
//                     one back (joins) and the kept one glides back
//   bar:remove        a playlist bar item's ×: it leaves, its right neighbour glides left into its place
//   browse:filter     a Workshop search that narrows the list: a card leaves, a kept one glides to the front
//   <cell>:off        "Smooth window animations" off: the leaving / joining card only fades, in place (app/shell/motion-off.js),
//                     nothing glides (the neighbour takes its place at once), and every animation runs on opacity alone
//   lib:trash:reduced the same under prefers-reduced-motion
//   look:toggles      Glow effects off + the live wallpaper behind every tab: the leave still plays; mid-leave screenshot
//   perf:onScreen     a search over ~50 cards: only cards on screen (or within half a view of it) animate, all of them on
//                     opacity / translate / scale (the compositor's properties)
// Motion on, every animation is opacity / translate / scale. Screenshots: <LIASCAPE_OUT>/presence-<cell>-{mid,end}.png.
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const MO = require("./motion-off");
const K = JSON.parse(E.LIASCAPE_CLIPS);
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
app.setPath("userData", path.join(OUT, "electron-user-data"));

const LIB_N = 46;  // library items the probe adds (copies of a clip): ~50 cards with the stack's own four, more than one screen
const BR_N = 24;   // fake Workshop items
const MID = 3;     // in-between frames a move or a fade must show (the matrix's Xvfb runs at 60 Hz: a 220 ms leave is ~13 frames)

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : J(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);
async function setSettings(patch) { const s0 = (await http("GET", "/settings")).json; await post("/settings", { ...s0, ...patch }); }

// fake Workshop thumbnails in the stack's cache dir (/media serves only the app's own dirs)
const THUMBS = [];
function makeThumbs() {
  const d = path.join(E.XDG_CACHE_HOME || path.join(OUT, ".cache"), "liascape", "pr-thumbs"); fs.mkdirSync(d, { recursive: true });
  ["0x4c4f9a", "0x1f6f8b", "0x8b3a62", "0x2e7d4f", "0x9a6b2f", "0x5a2e8b"].forEach((c, i) => {
    const f = path.join(d, `t${i}.jpg`);
    require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `gradients=size=480x270:c0=${c}:c1=0x101018:seed=${i + 1}`,
      "-frames:v", "1", f], { timeout: 30000 });
    THUMBS.push(f);
  });
}
// the Workshop source's network, stubbed before the page's scripts run: a search keeps the titles that contain it
const stub = () => `(() => { const items = ${J(Array.from({ length: BR_N }, (_, i) => ({
  title: `ws-${String(i).padStart(2, "0")}`, thumbnailUrl: THUMBS[i % THUMBS.length], animatedThumbnailUrl: null,
  pageUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${930000 + i}`, resolution: "1920 x 1080", isScene: false,
  workshopId: String(930000 + i), addedAt: null, description: "fake", authorName: "probe", fileSizeBytes: 1000, subscriptions: i, favorites: i,
  views: i, tags: ["Anime"] })))};
  const f = window.fetch; window.fetch = (u, o) => { const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    const ok = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (p === "/browse" && (o?.method || "GET") === "POST") { const b = JSON.parse(o.body); const q = (b.query || "").toLowerCase();
      return ok(b.page > 1 ? [] : items.filter((w) => w.title.includes(q))); }
    if (p === "/detail" && (o?.method || "GET") === "POST") { const b = JSON.parse(o.body); return ok({ title: b.result.title, previewUrl: b.result.thumbnailUrl, downloadUrl: "", needsReferrer: false }); }
    return f(u, o); }; })();`;

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__pr = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  box(g) { return document.querySelector(g === "lib" ? ".lib-scroll > .grid" : g === "br" ? ".scroll:not(.lib-scroll) > .grid" : ".playlist-bar-row"); },
  // the list's cards in order by their morph id (an older build has no data-key: --ui-dir RED runs), not one still leaving, not a
  // placeholder
  mid(e) { return e.dataset.morphId ?? e.querySelector(":scope > [data-morph-id]")?.dataset.morphId ?? null; },
  keys(g) { return [...(this.box(g)?.children ?? [])].filter((e) => this.mid(e) != null && e.dataset.leaving == null).map((e) => this.mid(e)); },
  title(g, k) { const e = [...(this.box(g)?.children ?? [])].find((x) => this.mid(x) === k); return e?.querySelector("[data-title]")?.dataset.title ?? e?.dataset.title ?? null; },
  // a React-controlled field typed into
  type(el, v) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); },
  search(v) { const i = [...document.querySelectorAll(".tsearch input.search")].find((x) => x.checkVisibility()); if (!i) throw new Error("no search field"); this.type(i, v); },
  async until(f, ms = 4000) { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (f()) return true; await this.sleep(16); } return false; },
}; true`;
const page = (code) => js(`(async () => { const m = window.__pr; ${code} })()`);
// a card's root by its morph id (`k`: lib-<path>, br-<page URL>, pl-<path>)
const sel = (g, k) => (g === "pl" ? `.playlist-bar-row > [data-morph-id=${J(k)}]`
  : `${g === "lib" ? ".lib-scroll > .grid" : ".scroll:not(.lib-scroll) > .grid"} > :has(> [data-morph-id=${J(k)}])`);

// per animation frame for `ms`: each selector's first rendered match as MO.SAMPLE records it ([t, opacity as seen, x, y, w, h],
// [t, null] = absent), and every property the lists' own script animations animate (CSS hover transitions aside)
const SAMPLE = (sels, ms) => `window.__smp = new Promise((res) => { const S = ${J(sels)}, out = {}, props = new Set(); for (const k in S) out[k] = [];
  const t0 = performance.now();
  const f = () => { const t = Math.round(performance.now() - t0);
    for (const k in S) { const e = document.querySelector(S[k]);
      if (!e || !e.getClientRects().length) { out[k].push([t, null]); continue; }
      let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
      const r = e.getBoundingClientRect(); out[k].push([t, +op.toFixed(3), +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]); }
    for (const a of document.getAnimations()) { if (a instanceof CSSTransition || a instanceof CSSAnimation) continue;
      const tg = a.effect?.target; if (!tg?.parentElement?.matches?.(".grid, .playlist-bar-row")) continue;
      for (const kf of a.effect.getKeyframes()) for (const p of Object.keys(kf)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) props.add(p); }
    if (t < ${ms}) requestAnimationFrame(painted); else res({ out, props: [...props] }); };
  // read each frame as it was painted: a task posted from the frame's rAF runs after its paint. Read in the rAF itself, it
  // would miss what the frame's ResizeObserver callbacks start before the paint (the list's own glides and fades)
  const painted = () => { const ch = new MessageChannel(); ch.port1.onmessage = f; ch.port2.postMessage(0); };
  f(); }); true`; // the first sample at once: the change can land before the next frame

async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `presence-${name}.png`), img.toPNG()); }

// ---- judging one element's frames ----
const shown = (f) => f[1] != null && f[1] > 0.02;
const mids = (fr) => fr.filter((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95).length;
const ctr = (f) => [f[2] + f[4] / 2, f[3] + f[5] / 2];
// a leave in motion: in-between opacities while it shrinks (its drawn width under 97 % of its own), then gone
function leaveMotion(name, fr) {
  const v = [];
  const s = fr.find(shown);
  if (!s) return [`${name}: never shown — proved nothing`];
  if (fr[fr.length - 1][1] != null) v.push(`${name}: still there when the sampling ended`);
  const n = mids(fr);
  if (n < MID) v.push(`${name}: popped out — ${n} in-between opacity frames (want ≥ ${MID}; ${MO.brief(fr)})`);
  const small = fr.filter((f) => shown(f) && f[4] < s[4] * 0.97).length;
  if (small < 2) v.push(`${name}: didn't shrink as it left (${small} frames under 97 % of its width ${s[4]})`);
  return v;
}
// a join in motion: absent or transparent first, then in-between opacities as it grows to its size
function joinMotion(name, fr) {
  const v = [];
  const last = fr[fr.length - 1];
  if (!shown(last)) return [`${name}: not shown when the sampling ended`];
  const i = fr.findIndex(shown);
  if (i === 0 && fr[0][1] >= 0.95) return [`${name}: already shown when the sampling began — proved nothing`];
  const n = mids(fr);
  if (n < MID) v.push(`${name}: popped in — ${n} in-between opacity frames (want ≥ ${MID}; ${MO.brief(fr)})`);
  const small = fr.filter((f) => shown(f) && f[4] < last[4] * 0.97).length;
  if (small < 2) v.push(`${name}: didn't grow as it came (${small} frames under 97 % of its width ${last[4]})`);
  return v;
}
// a glide from where it was to `to` (a centre), through in-between places
function glide(name, fr, to) {
  const s = fr.find(shown), e = [...fr].reverse().find(shown);
  if (!s || !e) return [`${name}: not shown — proved nothing`];
  const [sx, sy] = ctr(s), [ex, ey] = ctr(e);
  const v = [];
  if (to && Math.hypot(ex - to[0], ey - to[1]) > 2) v.push(`${name}: ended at ${ex.toFixed(1)},${ey.toFixed(1)}, want ${to[0].toFixed(1)},${to[1].toFixed(1)}`);
  if (Math.hypot(ex - sx, ey - sy) < 4) return [...v, `${name}: didn't move — proved nothing`];
  const between = fr.filter((f) => shown(f) && Math.hypot(ctr(f)[0] - sx, ctr(f)[1] - sy) > 2 && Math.hypot(ctr(f)[0] - ex, ctr(f)[1] - ey) > 2).length;
  if (between < MID) v.push(`${name}: jumped — ${between} frames between ${sx.toFixed(0)},${sy.toFixed(0)} and ${ex.toFixed(0)},${ey.toFixed(0)} (want ≥ ${MID})`);
  return v;
}
// motion off: it takes its new place at once (no in-between frames), and did move
function jump(name, fr, to) {
  const s = fr.find(shown), e = [...fr].reverse().find(shown);
  if (!s || !e) return [`${name}: not shown — proved nothing`];
  const [sx, sy] = ctr(s), [ex, ey] = ctr(e);
  const v = [];
  if (to && Math.hypot(ex - to[0], ey - to[1]) > 2) v.push(`${name}: ended at ${ex.toFixed(1)},${ey.toFixed(1)}, want ${to[0].toFixed(1)},${to[1].toFixed(1)}`);
  if (Math.hypot(ex - sx, ey - sy) < 4) return [...v, `${name}: didn't move — proved nothing`];
  const between = fr.filter((f) => shown(f) && Math.hypot(ctr(f)[0] - sx, ctr(f)[1] - sy) > 2 && Math.hypot(ctr(f)[0] - ex, ctr(f)[1] - ey) > 2).length;
  if (between) v.push(`${name}: glided with motion off (${between} frames between its places)`);
  return v;
}
const COMPOSITED = new Set(["opacity", "translate", "scale", "transform"]);
function propsOk(props, on) {
  const bad = props.filter((p) => (on ? !COMPOSITED.has(p) : p !== "opacity"));
  return bad.length ? [`the lists animate ${bad.join(", ")} (${on ? "want opacity / translate / scale only" : "motion off: want opacity only"})`] : [];
}

// run `act` (in-page code) while sampling the given elements for `ms`; a screenshot when a card starts leaving or joining
async function sampled(name, sels, act, ms = 1600, midWait = 90) {
  await js(SAMPLE(sels, ms));
  await page(act);
  // the moment the change lands: a card pinned to leave, or the target in its new state
  await page(`await m.until(() => document.querySelector("[data-leaving]") || document.getAnimations().some((a) => !(a instanceof CSSTransition) && a.effect?.target?.parentElement?.matches?.(".grid, .playlist-bar-row")), 2500);`);
  await sleep(midWait); await shot(`${name}-mid`);
  const r = await js(`window.__smp`);
  await shot(`${name}-end`);
  return r;
}

async function reload() {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 150; i++) { if (await js(`document.querySelectorAll('.tab').length`) >= 3) break; await sleep(100); }
  await js(PAGE); await sleep(600);
}
async function tab(name) { await page(`m.byText(".tab", ${J(name)}).click();`); await sleep(800); }
async function toLibrary() {
  await tab("Library");
  for (let i = 0; i < 60 && (await page(`return m.keys("lib").length;`)) < 8; i++) await sleep(100);
  await page(`document.querySelector(".lib-scroll").scrollTop = 0;`); await sleep(300);
}
let wsName = null;
async function toWorkshop() {
  await tab("Browse"); await page(`m.byText(".pill", ${J(wsName)})?.click();`);
  for (let i = 0; i < 60 && (await page(`return m.keys("br").length;`)) < BR_N; i++) await sleep(100);
  await sleep(900); // the placeholders' page 2 (empty) lands and they go
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1000, height: 800, webPreferences: { backgroundThrottling: false } });
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
    await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, autoAddWeWallpapersToLibrary: false, previewNotHovered: ["image"] });
    const srcs = (await http("GET", "/sources")).json;
    wsName = srcs.find((s) => s.supportsTagFilter)?.name;
    if (!wsName) throw new Error("no Workshop source (supportsTagFilter) in /sources");
    // the library: the stack's four clips, then ~46 copies titled "pr NNN", imported in order (the default sort is oldest first)
    const dir = path.join(OUT, "pr-lib"); fs.mkdirSync(dir, { recursive: true });
    const added = [];
    for (let i = 0; i < LIB_N; i++) {
      const f = path.join(dir, `p${i}.mp4`); fs.copyFileSync(K[K.length - 1], f);
      const p = (await post("/library/import", { path: f, title: `pr ${String(i).padStart(3, "0")}` })).json?.videoPath;
      if (p) added.push(p);
    }
    if (added.length < LIB_N) throw new Error(`imported ${added.length} of ${LIB_N}`);
    const PL = [...K, ...added.slice(0, 4)];
    await post("/playlist/state", { videoPaths: PL, settings: null, name: null });
    await win.loadURL(withToken(U + "/")); // a page first: the debugger's Page domain needs a renderer
    const d = win.webContents.debugger; d.attach("1.3"); await d.sendCommand("Page.enable");
    await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: stub() });
    const reduced = (on) => d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] });
    await reload();

    // ---- the Library: Delete, then Undo ----
    const trashCells = async (sfx, on) => {
      let undoable = null;
      await cell(`lib:trash${sfx}`, async () => {
        await toLibrary();
        const keys = await page(`return m.keys("lib");`);
        const [t, n] = [keys[2], keys[3]];
        undoable = { t, n };
        const at = await page(`const r = document.querySelector(${J(sel("lib", t))}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
        const r = await sampled(`lib-trash${sfx}`, { t: sel("lib", t), n: sel("lib", n) }, `document.querySelector(${J(sel("lib", t))} + " .del").click();`);
        const v = on ? [...leaveMotion("the deleted card", r.out.t), ...glide("the next card", r.out.n, at)]
          : [...MO.judge("the deleted card", r.out.t, { leave: true }), ...jump("the next card", r.out.n, at)];
        console.log(`        deleted card ${MO.brief(r.out.t)}; animated: ${r.props.join(", ") || "nothing"}`);
        return [...v, ...propsOk(r.props, on)];
      });
      if (!undoable || sfx === ":reduced") return undoable;
      await cell(`lib:undo${sfx}`, async () => {
        const { t, n } = undoable;
        await page(`await m.until(() => document.querySelector('button[aria-label="Undo"]'));`);
        const at = await page(`const r = document.querySelector(${J(sel("lib", n))}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
        const r = await sampled(`lib-undo${sfx}`, { t: sel("lib", t), n: sel("lib", n) }, `document.querySelector('button[aria-label="Undo"]').click();`, 2000);
        const back = await page(`return m.keys("lib").includes(${J(t)});`);
        if (!back) return ["Undo didn't bring the card back — proved nothing"];
        const v = on ? [...joinMotion("the restored card", r.out.t), ...glide("the next card", r.out.n, null)]
          : [...MO.judge("the restored card", r.out.t, { appear: true }), ...jump("the next card", r.out.n, null)];
        console.log(`        restored card ${MO.brief(r.out.t)}; the next card back at ${ctr([...r.out.n].reverse().find(shown)).map((x) => x.toFixed(0))} (was ${at.map((x) => x.toFixed(0))})`);
        return [...v, ...propsOk(r.props, on)];
      });
      return undoable;
    };
    // a search that hides the stack's four clips ("k1"…): the second leaves, the first "pr" card glides to the front; cleared,
    // the clip comes back and the "pr" card glides back
    const filterCells = async (sfx, on) => {
      await cell(`lib:filter${sfx}`, async () => {
        await toLibrary();
        const keys = await page(`return m.keys("lib");`), titles = await page(`return m.keys("lib").map((k) => m.title("lib", k));`);
        const kIdx = titles.findIndex((x) => /^k\d/.test(x)), pIdx = titles.findIndex((x) => /^pr /.test(x));
        if (kIdx < 0 || pIdx <= 0) return [`want clips before the "pr" cards, got ${titles.slice(0, 6).join(", ")}`];
        const t = keys[kIdx + 1] ?? keys[kIdx], n = keys[pIdx];
        const first = await page(`const r = document.querySelector(${J(sel("lib", keys[0]))}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
        const was = await page(`const r = document.querySelector(${J(sel("lib", n))}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
        console.log(`        cards: ${titles.slice(0, 8).join(", ")}…; hidden: ${titles[keys.indexOf(t)]}, kept: ${titles[pIdx]}`);
        const a = await sampled(`lib-filter${sfx}`, { t: sel("lib", t), n: sel("lib", n) }, `m.search("pr ");`);
        console.log(`        search: the hidden card ${MO.brief(a.out.t)} (${a.out.t.length} frames), the kept card ${J(a.out.n[0])} → ${J(a.out.n[a.out.n.length - 1])}`);
        const b = await sampled(`lib-unfilter${sfx}`, { t: sel("lib", t), n: sel("lib", n) }, `m.search("");`);
        const v = on ? [...leaveMotion("a hidden card", a.out.t), ...glide("a kept card", a.out.n, first), ...joinMotion("the hidden card coming back", b.out.t), ...glide("the kept card going back", b.out.n, was)]
          : [...MO.judge("a hidden card", a.out.t, { leave: true }), ...jump("a kept card", a.out.n, first),
            ...MO.judge("the hidden card coming back", b.out.t, { appear: true }), ...jump("the kept card going back", b.out.n, was)];
        return [...v, ...propsOk([...a.props, ...b.props], on)];
      });
    };
    const barCells = async (sfx, on) => {
      await cell(`bar:remove${sfx}`, async () => {
        await toLibrary();
        win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 }); await sleep(500);
        const keys = await page(`return m.keys("pl");`);
        if (keys.length < 3) return [`the playlist bar shows ${keys.length} items`];
        const [t, n] = [keys[1], keys[2]];
        const at = await page(`const r = document.querySelector(${J(sel("pl", t))}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
        const r = await sampled(`bar-remove${sfx}`, { t: sel("pl", t), n: sel("pl", n) }, `document.querySelector(${J(sel("pl", t))} + " .pl-remove").click();`);
        const v = on ? [...leaveMotion("the removed item", r.out.t), ...glide("its right neighbour", r.out.n, at)]
          : [...MO.judge("the removed item", r.out.t, { leave: true }), ...jump("its right neighbour", r.out.n, at)];
        // put it back for the next cell
        await post("/playlist/state", { videoPaths: PL, settings: null, name: null });
        return [...v, ...propsOk(r.props, on)];
      });
    };
    const browseCells = async (sfx, on) => {
      await cell(`browse:filter${sfx}`, async () => {
        await toWorkshop();
        const keys = await page(`return m.keys("br");`);
        if (keys.length < BR_N) return [`Browse shows ${keys.length} of ${BR_N} cards`];
        const t = keys[2], n = keys[10];
        const first = await page(`const r = document.querySelector(${J(sel("br", keys[0]))}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
        const r = await sampled(`browse-filter${sfx}`, { t: sel("br", t), n: sel("br", n) }, `m.search("ws-1");`, 1800);
        const v = on ? [...leaveMotion("a card the search drops", r.out.t), ...glide("a card it keeps", r.out.n, first)]
          : [...MO.judge("a card the search drops", r.out.t, { leave: true }), ...jump("a card it keeps", r.out.n, first)];
        await page(`m.search("");`); await sleep(900);
        return [...v, ...propsOk(r.props, on)];
      });
    };

    await trashCells("", true);
    await filterCells("", true);
    await barCells("", true);
    await browseCells("", true);

    await cell("perf:onScreen", async () => {
      await toLibrary();
      const view = await page(`const r = document.querySelector(".lib-scroll").getBoundingClientRect(); return { t: Math.max(0, r.top), b: Math.min(innerHeight, r.bottom), n: m.keys("lib").length,
        off: [...m.box("lib").children].filter((e) => e.getBoundingClientRect().top > r.bottom).length };`);
      if (!view.off) return [`all ${view.n} cards fit on screen — proved nothing`];
      // the search keeps "pr 04x": most cards leave, some from below the view move up
      await js(`window.__far = []; window.__n = 0; (() => { const t0 = performance.now(); const f = () => { for (const a of document.getAnimations()) {
        if (a instanceof CSSTransition || a instanceof CSSAnimation) continue; const tg = a.effect?.target; if (!tg?.parentElement?.matches?.(".grid")) continue;
        if (a.__seen) continue; a.__seen = true; window.__n++; const r = tg.getBoundingClientRect(), reach = (${view.b} - ${view.t}) / 2 + 40;
        if (r.bottom < ${view.t} - reach || r.top > ${view.b} + reach) window.__far.push(tg.dataset.key); }
        if (performance.now() - t0 < 1200) requestAnimationFrame(f); }; requestAnimationFrame(f); })(); true`);
      await page(`m.search("pr 04");`); await sleep(1400);
      const got = await js(`({ n: window.__n, far: window.__far })`);
      await page(`m.search("");`); await sleep(900);
      console.log(`        ${view.n} cards (${view.off} below the view): ${got.n} animations started`);
      const v = [];
      if (!got.n) v.push("nothing animated — proved nothing");
      if (got.far.length) v.push(`${got.far.length} cards animated far off screen`);
      if (got.n > view.n - view.off + 12) v.push(`${got.n} animations for ~${view.n - view.off} cards on screen`);
      return v;
    });

    await cell("look:toggles", async () => {
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true }); await reload(); await toLibrary();
      const cls = await js(`document.documentElement.className`);
      const keys = await page(`return m.keys("lib");`);
      const r = await sampled("look-toggles", { t: sel("lib", keys[5]) }, `document.querySelector(${J(sel("lib", keys[5]))} + " .del").click();`);
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: false });
      const v = leaveMotion("the deleted card", r.out.t);
      if (!/no-glow/.test(cls)) v.push(`no :root.no-glow with Glow effects off (${cls})`);
      if (!/bg-live/.test(cls)) v.push(`no :root.bg-live with the live wallpaper behind every tab (${cls})`);
      return v;
    });

    // ---- motion off: the toggle, then the OS's reduced motion ----
    await setSettings({ morphs: false }); await reload();
    await trashCells(":off", false);
    await filterCells(":off", false);
    await barCells(":off", false);
    await browseCells(":off", false);
    await setSettings({ morphs: true }); await reduced(true); await reload();
    await trashCells(":reduced", false);
    await reduced(false);
  } catch (e) {
    console.log(`ERROR ${e.stack || e}`);
    results.push({ name: "setup", v: [String(e)] });
  }
  const fails = results.filter((r) => r.v.length);
  console.log(`PRESENCE ${results.length - fails.length}/${results.length} passed`);
  app.exit(fails.length ? 1 : 0);
});
