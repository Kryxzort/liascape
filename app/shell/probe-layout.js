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
//   perf:idle             an idle page asks for no frames
//   perf:tabs             on a PERF_N-item library: each real tab click forces no layout from script (an effect / handler
//                         measuring the new page before its frame does); prints the longest task and what mounted
//   perf:sidebar          right-click open / switch / Escape close re-render the sidebar, not the grid's cards or the
//                         playlist bar (React's commit hook counts the components that ran), and force no layout
//                         (LIASCAPE_PERF_DUMP=1: every step's trace → <LIASCAPE_OUT>/perf-trace-<n>.json)
//   perf:dockRepaint      on a heavy Library (long playlist, autoplaying video thumbnails, live wallpaper, a playing card) a
//                         dock sweep doesn't repaint the whole playlist bar every frame, and its items stack exactly as they
//                         magnify; prints the layer tree (element + Chromium's compositing reasons) and what repainted most
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

// ---- perf cells: a library the size of a real one, a React commit counter, a trace per step ----
const PERF_N = 160;           // library items the perf cells add (copies of the 10 s clip)
const PERF_PLAYLIST = 30;     // of them in the playlist bar
const PERF_FORCED_MAX = 0;    // layouts forced from script per step
const PERF_SCRIPT_SHARE_MAX = 0.5; // of a Library switch's script time, the most one task may run
const PERF_SIDE_RENDERS_MAX = 200; // components re-rendered per sidebar step: the sidebar's own few dozen pass, the grid's
                                   // cards (~6 components each, PERF_N of them) don't
const DOCK_PLAYLIST = 45;          // perf:dockRepaint: playlist bar items (most of them scrolled out of the bar's view)
const DOCK_GROW = 8;               // hooks/useDockLift.ts RISE − LIFT: px an item grows at amount 1 (its scale: 1 + DOCK_GROW / height)
const DOCK_BAR_REPAINTS_MAX = 0.75; // perf:dockRepaint: repaints of the whole playlist bar per dock frame: ~1 when every frame
                                    // writes a z-index, ~0.5 when only a change of the items' order does (a sweep reorders them often)
// React's DevTools hook, installed before the page's scripts: production react-dom calls onCommitFiberRoot on every commit.
// A fiber object that is still the current one from the last commit was never visited (its subtree neither); a new current
// one with no alternate mounted; with PerformedWork (flag 1) its component ran.
const RC_HOOK = `(() => {
  const C = new Set([0, 1, 11, 14, 15]); const cur = new WeakSet(); window.__rc = { rendered: 0, mounted: 0 }; window.__rcWho = {};
  // what re-rendered, named by the class of its first DOM node (production names are minified)
  const who = (f) => { let h = f.child; while (h && typeof h.type !== "string") h = h.child;
    const k = h ? h.type + "." + String(h.memoizedProps?.className ?? "").split(" ")[0] : "?"; window.__rcWho[k] = (window.__rcWho[k] ?? 0) + 1; };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, onScheduleFiberRoot() {},
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
const dbg = () => { const d = win.webContents.debugger; if (!d.isAttached()) d.attach("1.3"); return d; };
async function perfSetup() {
  const dir = path.join(OUT, "perf-lib"); fs.mkdirSync(dir, { recursive: true });
  const src = K[K.length - 1];
  const paths = [];
  for (let i = 0; i < PERF_N; i += 8) {
    paths.push(...(await Promise.all(Array.from({ length: Math.min(8, PERF_N - i) }, async (_, j) => {
      const f = path.join(dir, `p${i + j}.mp4`); fs.copyFileSync(src, f);
      return (await post("/library/import", { path: f, title: `perf ${String(i + j).padStart(3, "0")}` })).json?.videoPath;
    }))));
  }
  if (paths.filter(Boolean).length < PERF_N) throw new Error(`perf setup: imported ${paths.filter(Boolean).length} of ${PERF_N}`);
  await post("/playlist/state", { videoPaths: paths.slice(0, PERF_PLAYLIST), settings: null, name: null });
  const d = dbg(); await d.sendCommand("Page.enable");
  await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: RC_HOOK });
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= PERF_N) break; await sleep(100); }
  await js(PAGE); await sleep(1500);
  if (!(await js(`!!window.__rc && window.__rc.mounted > 0`))) throw new Error("perf setup: the React commit hook saw no commit");
}
async function centreOf(sel, text) {
  return page(`const e = m.byText(${JSON.stringify(sel)}, ${JSON.stringify(text)}); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };`);
}
// a press held like a hand holds it (down and up in one batch run in one task: the up's hit test then lays out what the
// down's handler changed, inside the measured task)
async function clickAt({ x, y }, button = "left") {
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
  await sleep(80);
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
}
// one step under a trace + the commit counter: the renderer main thread's longest task, its busy time, the layouts that ran
// inside a JS call (forced), and the components React rendered / mounted meanwhile
let perfDumps = 0; // LIASCAPE_PERF_DUMP=1: each step's trace → <LIASCAPE_OUT>/perf-trace-<n>.json (open in DevTools' Performance panel)
async function perfStep(fn) {
  const d = dbg();
  const evs = [];
  const onMsg = (_e, method, params) => { if (method === "Tracing.dataCollected") evs.push(...params.value); };
  d.on("message", onMsg);
  const rc0 = await js(`(window.__rcWho = {}, { ...window.__rc })`);
  const cats = ["toplevel", "blink", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.stack", "v8.execute"];
  if (E.LIASCAPE_PERF_DUMP) cats.push("disabled-by-default-v8.cpu_profiler"); // + JS samples in the dumped trace
  await d.sendCommand("Tracing.start", { traceConfig: { includedCategories: cats }, transferMode: "ReportEvents" });
  await fn();
  const rc1 = await js(`({ ...window.__rc, who: Object.entries(window.__rcWho).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + "×" + n).join(", ") })`);
  const done = new Promise((res) => { const h = (_e, m) => { if (m === "Tracing.tracingComplete") { d.removeListener("message", h); res(); } }; d.on("message", h); });
  await d.sendCommand("Tracing.end"); await done; d.removeListener("message", onMsg);
  if (E.LIASCAPE_PERF_DUMP) fs.writeFileSync(path.join(OUT, `perf-trace-${++perfDumps}.json`), JSON.stringify({ traceEvents: evs }));
  const names = {}; for (const e of evs) if (e.name === "thread_name") names[`${e.pid}:${e.tid}`] = e.args.name;
  const runs = {}; for (const e of evs) { const k = `${e.pid}:${e.tid}`; if (names[k] === "CrRendererMain" && e.name === "RunTask" && e.dur) runs[k] = (runs[k] ?? 0) + e.dur; }
  const main = Object.entries(runs).sort((a, b) => b[1] - a[1])[0]?.[0];
  const on = evs.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X");
  const tasks = on.filter((e) => e.name === "RunTask");
  // forced = a Layout run from script in the input's task, a timer or a React effect — not in a requestAnimationFrame or
  // ResizeObserver callback: those run inside the frame's own lifecycle (a per-frame aim like gridKeys.ts keepCardInView,
  // a grid re-fit), where a read only does the frame's coming layout early
  const JS = new Set(["FunctionCall", "EventDispatch", "TimerFire", "RunMicrotasks", "v8.callFunction", "EvaluateScript"]);
  const inside = (e, spans) => spans.some((j) => e.ts >= j.ts && e.ts < j.ts + j.dur);
  const jsSpans = on.filter((e) => JS.has(e.name));
  const frameCbs = on.filter((e) => e.name === "FireAnimationFrame" || e.name === "LocalFrameView::NotifyResizeObservers");
  const forced = on.filter((e) => e.name === "Layout" && inside(e, jsSpans) && !inside(e, frameCbs));
  // script per task: its outermost JS calls (rendering — style, layout, paint — is the browser's, not split by code)
  const top = jsSpans.filter((e) => !jsSpans.some((j) => j !== e && e.ts >= j.ts && e.ts + e.dur <= j.ts + j.dur && (j.ts < e.ts || j.dur > e.dur)));
  const perTask = tasks.map((t) => top.filter((e) => e.ts >= t.ts && e.ts < t.ts + t.dur).reduce((s, e) => s + e.dur, 0) / 1000);
  const script = perTask.reduce((a, b) => a + b, 0), maxScript = Math.max(0, ...perTask);
  return { longest: Math.max(0, ...tasks.map((e) => e.dur)) / 1000, busy: tasks.reduce((s, e) => s + e.dur, 0) / 1000,
    script, maxScript, share: script ? maxScript / script : 0,
    forced: forced.length, forcedMs: forced.reduce((s, e) => s + e.dur, 0) / 1000,
    // who forced it: the JS frame that asked (file:line:col of the bundle)
    forcedBy: forced.map((e) => { const f = e.args?.beginData?.stackTrace?.[0]; return f ? `${f.functionName || "?"}@${String(f.url).split("/").pop()}:${f.lineNumber}:${f.columnNumber}` : "?"; }).join(", "),
    rendered: rc1.rendered - rc0.rendered, mounted: rc1.mounted - rc0.mounted, who: rc1.who };
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

    // ---- perf: tab switches and the item sidebar on a full library ----
    if (!ONLY || ONLY.test("perf:tabs") || ONLY.test("perf:sidebar") || ONLY.test("perf:dockRepaint")) await perfSetup();
    // A tab switch: Browse → Library → Settings → Library → Browse, each one a real click (sendInputEvent) under a trace.
    // Per switch: the longest main-thread task, the layouts forced from script (a Layout inside a JS call: the effect that
    // reads a size before the frame would lay out anyway), and the React components that rendered / mounted.
    await cell("perf:tabs", async () => {
      const v = [];
      await tab("Browse"); await sleep(800);
      const rows = [];
      for (const t of ["Library", "Settings", "Library", "Browse", "Library"]) {
        // measured and pointed at before the trace (the probe's own read forces a layout; a hand reaches the tab before it clicks)
        const at = await centreOf(".tab", t); win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y }); await sleep(400);
        const r = await perfStep(async () => { await clickAt(at); await sleep(900); });
        rows.push({ t, ...r });
        console.log(`        → ${t.padEnd(8)} longest task ${r.longest.toFixed(0)} ms, busy ${r.busy.toFixed(0)} ms, script ${r.script.toFixed(0)} ms (one task ${r.maxScript.toFixed(0)} ms = ${(r.share * 100).toFixed(0)} %), ${r.forced} forced layouts (${r.forcedMs.toFixed(1)} ms), rendered ${r.rendered}, mounted ${r.mounted}`);
      }
      const lib = rows.filter((r) => r.t === "Library");
      if (lib.some((r) => r.mounted < 20)) v.push(`a switch to Library mounted only ${Math.min(...lib.map((r) => r.mounted))} components — nothing measured (proved nothing)`);
      // building the library page (~1000 components) is split into short slices: no one task runs most of the switch's script
      for (const r of lib) if (r.share > PERF_SCRIPT_SHARE_MAX) v.push(`→ Library: one task ran ${(r.share * 100).toFixed(0)} % of the switch's script (${r.maxScript.toFixed(0)} of ${r.script.toFixed(0)} ms; ≤ ${PERF_SCRIPT_SHARE_MAX * 100} %)`);
      for (const r of rows) if (r.forced > PERF_FORCED_MAX) v.push(`→ ${r.t}: ${r.forced} layouts forced from script (≤ ${PERF_FORCED_MAX}): ${r.forcedBy}`);
      return v;
    });
    // The item sidebar: right-click a card (opens it), two more cards (switches), Escape (closes). A focus change re-renders
    // the sidebar, not the grid: every card and the playlist bar keep their props, so their memo holds.
    await cell("perf:sidebar", async () => {
      const v = [];
      await tab("Library"); await sleep(800);
      // the n-th card on screen that isn't the focused one (the docked sidebar re-fits the grid: positions move), measured
      // before the step's trace — the probe's own read would force a layout
      const cardAt = (n) => page(`const f = document.querySelector(".card.focused .thumb-wrap");
        const on = [...document.querySelectorAll(".card.lib .thumb-wrap")].filter((e) => e !== f).map((e) => e.getBoundingClientRect())
          .filter((b) => b.width > 0 && b.top > 0 && b.bottom < innerHeight - 200 && b.right < (document.querySelector(".side-panel")?.getBoundingClientRect().left ?? innerWidth));
        const b = on[${n}]; return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 3) } : null;`);
      let prevSide = null;
      for (const [what, n] of [["open", 0], ["switch", 1], ["switch", 2], ["close", null]]) {
        const at = n == null ? null : await cardAt(n);
        if (n != null && !at) { v.push(`${what}: no card on screen to right-click`); break; }
        if (at) win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y }); // the pointer gets there first
        await sleep(400);
        const r = await perfStep(async () => {
          if (at) await clickAt(at, "right");
          else { win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); await sleep(80); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); }
          await sleep(700);
        });
        const side = await js(`document.querySelector(".side-panel:not(.closing)")?.dataset.sideId ?? null`);
        console.log(`        ${what.padEnd(6)} longest task ${r.longest.toFixed(0)} ms, busy ${r.busy.toFixed(0)} ms, script ${r.script.toFixed(0)} ms (one task ${r.maxScript.toFixed(0)} ms), ${r.forced} forced layouts (${r.forcedMs.toFixed(1)} ms), rendered ${r.rendered}, mounted ${r.mounted}`);
        if (what === "close" ? side : !side || side === prevSide) { v.push(`${what}: the sidebar is ${side ? (side === prevSide ? "still on the same item" : "still open") : "not open"} — nothing measured (proved nothing)`); break; }
        prevSide = side;
        if (r.rendered > PERF_SIDE_RENDERS_MAX) v.push(`${what}: ${r.rendered} components re-rendered (≤ ${PERF_SIDE_RENDERS_MAX}: the grid's cards and the playlist bar must not) — most: ${r.who}`);
        if (r.forced > PERF_FORCED_MAX) v.push(`${what}: ${r.forced} layouts forced from script (≤ ${PERF_FORCED_MAX}): ${r.forcedBy}`);
      }
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
      return v;
    });
    // The dock on a heavy Library (a long playlist, autoplaying video thumbnails, the live wallpaper behind the tab, a playing
    // card): a dock frame doesn't repaint the whole playlist bar (every z-index write does — the dock writes an item's stacking
    // RANK, which changes only when the items' order does), and that rank stacks the items exactly as their magnification
    // does (the more magnified on top, equal ones in DOM order, barely moved ones under the bar's head). Prints the layer
    // tree (element + Chromium's compositing reasons) and what repainted most.
    await cell("perf:dockRepaint", async () => {
      const v = [];
      const lib = (await http("GET", "/library")).json ?? [];
      const vids = lib.filter((i) => !i.isScene).map((i) => i.videoPath);
      if (vids.length < DOCK_PLAYLIST) return [`only ${vids.length} library videos — the cell proves nothing`];
      await post("/playlist/state", { videoPaths: vids.slice(0, DOCK_PLAYLIST), settings: null, name: null });
      await setSettings({ autoPlayVideoThumbs: true, liveWallpaperBehindAllTabs: true, isPlaylistBarCollapsed: false });
      await post("/apply", { path: vids[2] });
      for (let i = 0; i < 60 && (await http("GET", "/current")).json?.path !== vids[2]; i++) await sleep(250);
      await win.loadURL(withToken(U + "/")); // the open page doesn't see a /settings POST
      for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.pl-item').length`) >= DOCK_PLAYLIST) break; await sleep(100); }
      await js(PAGE); await tab("Library");
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 300 });
      const ready = async () => js(`({ vids: [...document.querySelectorAll(".card video.thumb.anim")].filter((x) => x.readyState >= 2).length,
        bg: !!document.querySelector("video.settings-bg"), playing: !!document.querySelector(".card.playing") })`);
      let st;
      for (let i = 0; i < 60; i++) { st = await ready(); if (st.vids >= 2 && st.bg && st.playing) break; await sleep(250); }
      if (st.vids < 2 || !st.bg || !st.playing) return [`no heavy Library to measure (${st.vids} autoplaying card videos, live wallpaper ${st.bg}, playing card ${st.playing}) — proved nothing`];
      await sleep(800);
      const d = dbg();
      await d.sendCommand("DOM.enable"); await d.sendCommand("DOM.getDocument", { depth: 0 });
      const label = async (backendNodeId) => {
        const n = await d.sendCommand("DOM.describeNode", { backendNodeId }).then((x) => x.node).catch(() => null);
        const cls = (n?.attributes ?? []).reduce((a, x, i, arr) => (x === "class" ? arr[i + 1] : a), "");
        return n ? `${n.localName}${cls ? "." + cls.split(" ").join(".") : ""}` : "?";
      };
      // the layer tree of the next commit, by element + reasons
      let tree = null;
      const onTree = (_e, m, p) => { if (m === "LayerTree.layerTreeDidChange" && p.layers) tree = p.layers; };
      d.on("message", onTree);
      await d.sendCommand("LayerTree.enable");
      for (let i = 0; i < 40 && !tree; i++) { if (i % 10 === 9) win.webContents.invalidate(); await sleep(100); }
      d.removeListener("message", onTree);
      const by = new Map();
      for (const l of tree ?? []) {
        const why = (await d.sendCommand("LayerTree.compositingReasons", { layerId: l.layerId }).catch(() => ({}))).compositingReasonIds ?? [];
        const k = `${l.backendNodeId ? (await label(l.backendNodeId)).split(".").slice(0, 2).join(".") : "(no element)"} [${why.join(",")}]`;
        by.set(k, (by.get(k) ?? 0) + 1);
      }
      await d.sendCommand("LayerTree.disable");
      console.log(`        idle: ${tree?.length ?? 0} layers — ${[...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c}× ${k}`).join(", ")}`);
      // per dock frame (its "dockframe" signal comes after its writes): the order the z-indexes give vs the magnification's
      await js(`(() => { const row = document.querySelector(".playlist-bar-row"); window.__dz = { bad: [], moved: 0 };
        const mag = ${DOCK_GROW} / row.children[0].offsetHeight; // read once: a read in the listener would force the frame's layout
        row.addEventListener("dockframe", () => {
          const its = [...row.children].map((e, i) => { const t = e.style.getPropertyValue("--dock"); if (!t) return null;
            // the amount ×100 (the dock's stacking key before rounding), from the written scale (4 decimals: ±0.07)
            const sc = +/scale\\(([-\\d.]+)\\)/.exec(t)[1], k = Math.max(0, (sc - 1) / mag) * 100;
            return { i, k, z: +e.style.zIndex }; }).filter(Boolean);
          window.__dz.moved = Math.max(window.__dz.moved, its.length);
          const bad = (x) => { if (window.__dz.bad.length < 5) window.__dz.bad.push(x); };
          for (const p of its) {
            if ((p.k >= 1 && p.z < 2) || (p.k < 0.4 && p.z >= 2)) bad("item " + p.i + " (amount " + p.k.toFixed(2) + "%) z " + p.z + " vs the head's 2");
            for (const q of its) if (p.i !== q.i && p.k - q.k > 1.5 && p.z <= q.z)
              bad("item " + p.i + " (" + p.k.toFixed(1) + "%) under item " + q.i + " (" + q.k.toFixed(1) + "%): z " + p.z + " / " + q.z);
          }
        }); })()`);
      // a sweep across the bar's items under a trace, ending at rest on one
      const r = await page(`const its = [...document.querySelectorAll(".pl-item")].map((e) => e.getBoundingClientRect()).filter((b) => b.right < innerWidth);
        return its.length < 4 ? null : { y: its[0].y + its[0].height / 2, x0: its[0].x + 4, x1: its[its.length - 1].right - 4 };`);
      if (!r) return ["fewer than 4 playlist bar items on screen — proved nothing"];
      const bar = (await d.sendCommand("DOM.describeNode", { objectId: (await d.sendCommand("Runtime.evaluate", { expression: `document.querySelector(".playlist-bar")` })).result.objectId })).node.backendNodeId;
      const evs = []; let done;
      const onMsg = (_e, m, p) => { if (m === "Tracing.dataCollected") evs.push(...p.value); else if (m === "Tracing.tracingComplete") done(); };
      d.on("message", onMsg);
      await d.sendCommand("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] }, transferMode: "ReportEvents" });
      for (let i = 0; i <= 120; i++) { win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(r.x0 + (r.x1 - r.x0) * (i / 120)), y: Math.round(r.y) }); await sleep(16); }
      const mid = Math.round((r.x0 + r.x1) / 2);
      for (let i = 0; i <= 30; i++) { win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(r.x1 + (mid - r.x1) * (i / 30)), y: Math.round(r.y) }); await sleep(16); }
      await sleep(500);
      const complete = new Promise((res) => { done = res; });
      await d.sendCommand("Tracing.end"); await complete; d.removeListener("message", onMsg);
      const frames = evs.filter((e) => e.name === "EventDispatch" && e.args?.data?.type === "dockframe").length;
      const barPaints = evs.filter((e) => e.name === "Paint" && e.args?.data?.nodeId === bar).length;
      const painted = new Map(); for (const e of evs) if (e.name === "Paint" && e.args?.data?.nodeId) painted.set(e.args.data.nodeId, (painted.get(e.args.data.nodeId) ?? 0) + 1);
      const most = [];
      for (const [id, c] of [...painted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) most.push(`${c}× ${await label(id)}`);
      const dz = await js(`window.__dz`);
      console.log(`        sweep: ${frames} dock frames, the bar repainted ${barPaints}× (${frames ? (barPaints / frames).toFixed(2) : "-"} per frame), up to ${dz.moved} items moved at once; most repainted: ${most.join(", ")}`);
      if (frames < 40) v.push(`only ${frames} dock frames during the sweep — proved nothing`);
      if (dz.moved < 3) v.push(`at most ${dz.moved} items moved at once — the stacking proved nothing`);
      for (const x of dz.bad) v.push(`stacking differs from the magnification: ${x}`);
      if (frames && barPaints / frames > DOCK_BAR_REPAINTS_MAX) v.push(`the playlist bar repainted in ${barPaints} of ${frames} dock frames (≤ ${DOCK_BAR_REPAINTS_MAX} per frame: every z-index write repaints it)`);
      win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`LAYOUT pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "layout.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
