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
//   tabs:slide[:off|:reduced] switching tabs slides the active pill (transform) and slides/fades the page in
//                         (transform + opacity); off / prefers-reduced-motion → it jumps, nothing animates
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
  await page(`m.byText(".tab", "Settings").click(); await m.sleep(700);
    const row = [...document.querySelectorAll(".srow")].find((r) => r.querySelector(".slabel")?.textContent.includes("Smooth window animations"));
    if (!row) throw new Error("no Smooth window animations row");
    const cb = row.querySelector("input[type=checkbox]"); if (cb.checked !== ${on}) cb.click(); await m.sleep(500);`);
}

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__ly = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; },
  ty(el) { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === "none" ? undefined : getComputedStyle(el).transform); return m.m42; },
  // the top bar's visible controls (what a user sees and clicks), leaves of its flex rows
  topbarParts() {
    const tb = document.querySelector(".topbar");
    const parts = [...tb.querySelectorAll(".tab, .pill, .mini, .search, .sel, .btn, .status")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden"; });
    return { tb: this.rect(tb), parts: parts.map((e) => ({ k: e.className.split(" ")[0] + (e.textContent ? ":" + e.textContent.trim().slice(0, 14) : ""), ...this.rect(e), clipped: e.scrollWidth > e.clientWidth + 1 && !e.classList.contains("status") })) };
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
          return { b, cb, db, sb, under: cards.filter((x) => x.right > b.x + 1 && x.bottom > b.y && x.top < b.b).length,
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
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`LAYOUT pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "layout.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
