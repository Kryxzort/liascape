// The window's opening probe — `scripts/test-ui-matrix.sh --probe probe-intro.js` (the matrix's hermetic stack). The app
// logo plays once when the shell opens a window (app/shell/main.js adds `?intro`; app/ui/src/components/Intro.tsx). Every
// cell opens a NEW window (a fresh sessionStorage, as a new app window has) and samples the overlay per animation frame from
// the page's first script on (a sampler injected before the app's own scripts).
//   intro:absent      a page loaded without `?intro` (every other probe, a browser tab): no overlay ever
//   intro:plays       motion on: the logo, its picture decoded, fades and scales in through in-between frames, its accent
//                     ring ripples out, then the ground dissolves (in-between opacities) while the logo lifts away (grows,
//                     fades); only opacity / scale animate; the halo glows (Glow effects on). Every cell's deadlines: the
//                     overlay never takes a pointer event, the UI shows through (the ground under half) by SEE_MS after the
//                     logo starts and by USABLE_MS after the page's navigation began, the overlay is gone by END_MS after
//                     the logo starts. Screenshots intro-plays-{in,mid,open}.png
//   intro:once        the same window loaded again with `?intro` (a reload: Vite's, the renderer recovery's): nothing plays
//   intro:skip        a click on the Browse tab while the logo comes in: everything fades out at once (in-between frames,
//                     gone within a fade), and the click opened Browse (never held)
//   intro:skipKey     a key (Shift) while the logo comes in: the same fade out
//   intro:clickThrough a click on the Settings tab while the cover dissolves: the tab opens and the overlay fades out
//   intro:off         "Smooth window animations" off (at the window before: the next one plays still): the logo fades in
//                     and out in place, nothing moves or resizes, only opacity animates (app/shell/motion-off.js), no ring
//   intro:reduced     the same under prefers-reduced-motion, read at once
//   look:toggles      Glow effects off + the live wallpaper behind every tab: no accent halo (the depth shadow stays), the
//                     ground covers the wallpaper and the UI until it dissolves; screenshot intro-toggles-mid.png
//   look:theme        a light theme (Catppuccin Latte, at the window before): the ground in the theme's colour from its
//                     first frame (the store's kept theme), the Lavender logo, the ring in the accent; screenshot
//                     intro-theme-mid.png
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
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

const MID = 3;           // in-between frames a fade or a scale must show (the matrix's Xvfb runs at 60 Hz)
const SEE_MS = 600;      // from the logo's start to the ground under half (Intro.tsx REVEAL_MS 320 + ~130 ms of its ease-out
                         // fade + timer and frame slack on the software-rendered stack; measured ~460)
const END_MS = 900;      // from the logo's start to the overlay gone (REVEAL_MS 320 + OUT_MS 320 + slack for the software-rendered stack)
const USABLE_MS = 2500;  // from the page's navigation start to the UI showing through: the user's whole wait
const SKIP_MS = 350;     // from a skipping click / key to the overlay gone (FADE_EXIT_MS 170 + input and frame latency)

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : J(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
async function setSettings(patch) { const s0 = (await http("GET", "/settings")).json; await http("POST", "/settings", { ...s0, ...patch }); }

// per animation frame from the document's first script, for 3 s: the overlay's phase, whether the window's centre hits it,
// the ground's colours on its first frame, and for each part its first rendered match as motion-off.js records it ([t, opacity as seen, x, y, w, h] / [t, null]).
// `t` = ms since the page's navigation began (performance.now's origin).
const SAMPLER = `(() => { const S = { root: ".intro", bg: ".intro-bg", logo: ".intro-logo", tile: ".intro-tile", ring: ".intro-ring" };
  const out = { phase: [], hit: [], ui: null, firstBg: null }; for (const k in S) out[k] = [];
  window.__intro = out;
  const f = () => { const t = Math.round(performance.now());
    const root = document.querySelector(".intro");
    out.phase.push([t, root?.dataset.phase ?? null]);
    if (out.ui == null && document.querySelector(".topbar .tab")) out.ui = t;
    const c = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    out.hit.push([t, c ? !!c.closest(".intro") : null]);
    const g = document.querySelector(".intro-bg"); if (g && out.firstBg == null) out.firstBg = getComputedStyle(g).backgroundImage;
    for (const k in S) { const e = [...document.querySelectorAll(S[k])].find((x) => x.getClientRects().length);
      if (!e) { out[k].push([t, null]); continue; }
      let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
      const r = e.getBoundingClientRect(); out[k].push([t, +op.toFixed(3), +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]); }
    if (t < 3000) requestAnimationFrame(f); else out.done = true; };
  requestAnimationFrame(f); })();`;

let win = null;
const js = (code) => win.webContents.executeJavaScript(code);
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `intro-${name}.png`), img.toPNG()); }

// a new window (its own sessionStorage, as a new app window has), the sampler in before the app's scripts; `intro` adds the
// shell's ask to the address
async function open({ intro = true, reduced = false } = {}) {
  // the new one before the old one goes: with no window left the app would quit
  const old = win;
  win = new BrowserWindow({ show: true, useContentSize: true, width: 1200, height: 800, webPreferences: { backgroundThrottling: false } });
  if (old) { try { old.webContents.debugger.detach(); } catch { /* not attached */ } old.destroy(); }
  await win.loadURL("about:blank"); // a page first: the debugger's Page domain needs a renderer
  const d = win.webContents.debugger; d.attach("1.3"); await d.sendCommand("Page.enable");
  await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: SAMPLER });
  await d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "" }] });
  win.focus();
  const u = new URL(withToken(U + "/")); if (intro) u.searchParams.set("intro", "");
  win.loadURL(u.toString()).catch(() => {}); // not awaited: the logo starts before the page's load event
}
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(15); } return null; }
const phaseNow = () => js(`document.querySelector(".intro")?.dataset.phase ?? ""`);
const frames = () => until(() => js(`window.__intro?.done ? window.__intro : null`), 8000);

// ---- reading the samples ----
const shown = (f) => f && f[1] != null && f[1] > 0.02;
const mids = (fr) => fr.filter((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95).length;
const firstPhase = (s, p) => s.phase.find((x) => x[1] === p)?.[0] ?? null;
const goneAt = (s) => { const i = s.phase.findLastIndex((x) => x[1] != null); return i >= 0 && i < s.phase.length - 1 ? s.phase[i + 1][0] : null; };
// the first frame, the app's tabs there, from which the ground stays under half (or gone): the UI shows through
const seeAt = (s) => { const i = s.bg.findLastIndex((f) => f[1] != null && f[1] > 0.5); const t = i < s.bg.length - 1 ? s.bg[i + 1][0] : null;
  return t == null || s.ui == null ? null : Math.max(t, s.ui); };
const timing = (s) => {
  const play = firstPhase(s, "play"), gone = goneAt(s), see = seeAt(s);
  return { play, open: firstPhase(s, "open"), gone, see, ui: s.ui, line: `ui ${s.ui} play ${play} open ${firstPhase(s, "open")} seen ${see} gone ${gone} (ms since navigation)` };
};
function deadlines(s, v) {
  const tm = timing(s);
  const held = s.hit.filter((x) => x[1] === true).length;
  if (held) v.push(`the overlay took the pointer in ${held} frames (it must never hold input)`);
  if (tm.play == null) { v.push(`the logo never started (${tm.line})`); return tm; }
  if (tm.see == null || tm.see - tm.play > SEE_MS) v.push(`the UI showed through ${tm.see == null ? "never" : `${tm.see - tm.play} ms`} after the logo started (want ≤ ${SEE_MS})`);
  if (tm.see != null && tm.see > USABLE_MS) v.push(`the UI showed through only ${tm.see} ms after the navigation (want ≤ ${USABLE_MS})`);
  if (tm.gone == null || tm.gone - tm.play > END_MS) v.push(`the overlay was gone ${tm.gone == null ? "never" : `${tm.gone - tm.play} ms`} after the logo started (want ≤ ${END_MS})`);
  return tm;
}
// what the overlay's running animations animate (its subtree), other than opacity / scale
const props = () => js(`(() => { const r = document.querySelector(".intro"); if (!r) return null; const p = new Set();
  for (const a of r.getAnimations({ subtree: true })) for (const k of a.effect?.getKeyframes?.() ?? []) for (const n of Object.keys(k))
    if (!["offset", "easing", "composite", "computedOffset"].includes(n)) p.add(n); return [...p]; })()`);

app.on("window-all-closed", () => { /* the probe decides when it ends */ });
app.whenReady().then(async () => {
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
    await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false, theme: "Catppuccin Mocha" });

    await cell("intro:absent", async () => {
      await open({ intro: false });
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [];
      if (s.ui == null) v.push("the app never mounted — proved nothing");
      const seen = s.phase.filter((x) => x[1] != null);
      if (seen.length) v.push(`an overlay showed without ?intro (${seen.length} frames, phase ${seen[0][1]})`);
      return v;
    });

    await cell("intro:plays", async () => {
      await open();
      // mid-animation screenshots: as the logo comes in, as the cover dissolves
      if (await until(async () => (await phaseNow()) === "play")) { await sleep(90); await shot("plays-in"); await sleep(140); await shot("plays-mid"); }
      if (await until(async () => (await phaseNow()) === "open", 1500)) { await sleep(90); await shot("plays-open"); }
      const anim = await props();
      const glow = await js(`getComputedStyle(document.querySelector(".intro-tile") ?? document.body).boxShadow`);
      const decoded = await js(`(() => { const i = document.querySelector(".intro-img"); return i ? i.complete && i.naturalWidth > 0 : null; })()`);
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v);
      console.log(`        ${tm.line}`);
      if (tm.play == null) return v;
      const tile = s.tile.filter((f) => f[0] >= tm.play);
      // its resting width: the logo's box as it comes in (only the tile inside it scales then)
      const restW = s.logo.find((f) => f[0] >= tm.play && shown(f))?.[4];
      const ins = tile.filter((f) => f[0] < tm.play + 320);
      if (mids(ins) < MID) v.push(`the logo popped in: ${mids(ins)} in-between opacity frames (want ≥ ${MID}; ${MO.brief(ins)})`);
      const growing = ins.filter((f) => shown(f) && f[4] < restW * 0.97).length;
      if (growing < MID) v.push(`the logo didn't scale in: ${growing} frames under 97 % of its width ${restW} (want ≥ ${MID})`);
      const ring = s.ring.filter((f) => f[0] >= tm.play && shown(f));
      const ringWide = ring.filter((f) => f[4] > restW * 1.1).length;
      if (ringWide < MID) v.push(`no ring rippled off the logo: ${ringWide} frames wider than 110 % of the logo (want ≥ ${MID})`);
      const outs = s.bg.filter((f) => tm.open != null && f[0] >= tm.open - 40);
      if (mids(outs) < MID) v.push(`the ground popped out: ${mids(outs)} in-between opacity frames (want ≥ ${MID}; ${MO.brief(outs)})`);
      const lift = s.logo.filter((f) => tm.open != null && f[0] >= tm.open - 40 && shown(f) && f[4] > restW * 1.03).length;
      if (lift < 2) v.push(`the logo didn't lift away (${lift} frames wider than 103 % as it left)`);
      if (!anim) v.push("no overlay when its animations were read");
      else { const bad = anim.filter((p) => p !== "opacity" && p !== "scale"); if (bad.length) v.push(`animates ${bad.join(", ")} (only opacity / scale)`); }
      if (!/rgb/.test(glow ?? "") || (glow.match(/rgb/g) ?? []).length < 2) v.push(`no accent halo with Glow effects on (box-shadow ${glow})`);
      if (!restW) v.push("the logo never showed — proved nothing");
      if (decoded === false) v.push("the logo's picture wasn't loaded while it showed");
      console.log(`        frames: logo in ${mids(ins)} fading / ${growing} scaling, ring ${ringWide} wide, ground out ${mids(outs)} fading, lift ${lift}; tile opacity ${MO.brief(ins)}; ground ${MO.brief(outs)}`);
      return v;
    });

    await cell("intro:once", async () => {
      // the same window again: its sessionStorage holds the mark
      if (!win) return ["no window from intro:plays"];
      await win.loadURL(new URL(withToken(U + "/?intro")).toString());
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [];
      if (s.ui == null) v.push("the app never mounted — proved nothing");
      const seen = s.phase.filter((x) => x[1] != null);
      if (seen.length) v.push(`it played again on a reload of the same window (${seen.length} frames)`);
      return v;
    });

    const skipCell = (name, input, wantTab) => cell(name, async () => {
      await open();
      if (!(await until(async () => (await phaseNow()) === "play"))) return ["the logo never started"];
      await sleep(60);
      const before = await js(`document.querySelector(".tab.active")?.textContent ?? ""`);
      const t0 = await js(`performance.now()`);
      await input();
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [];
      const skipAt = firstPhase(s, "skip"), gone = goneAt(s);
      if (skipAt == null) v.push(`it didn't skip (${timing(s).line})`);
      if (gone == null || gone - t0 > SKIP_MS) v.push(`gone ${gone == null ? "never" : `${Math.round(gone - t0)} ms`} after the input (want ≤ ${SKIP_MS})`);
      const root = s.root.filter((f) => skipAt != null && f[0] >= skipAt - 20);
      const vis = s.tile.filter((f) => f[0] >= t0);
      const fade = root.filter((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95).length;
      if (fade < 2) v.push(`it popped out: ${fade} in-between opacity frames of the overlay (${MO.brief(root)})`);
      if (!vis.some(shown)) v.push("the logo wasn't on screen when skipped — proved nothing");
      const want = wantTab ?? before;
      const after = await until(async () => { const a = await js(`document.querySelector(".tab.active")?.textContent ?? ""`); return a === want ? a : null; }, 1500)
        ?? await js(`document.querySelector(".tab.active")?.textContent ?? ""`);
      if (after !== want) v.push(`the active tab is ${after} after the input (want ${want}${wantTab ? ": the click must reach the tab under the logo" : ""})`);
      if (wantTab && before === wantTab) v.push(`${wantTab} was active already — proved nothing`);
      return v;
    });
    await skipCell("intro:skip", async () => {
      // on the Browse tab under the cover: the click skips the logo AND opens Browse
      const p = await js(`(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Browse")?.getBoundingClientRect(); return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : { x: 40, y: 20 }; })()`);
      win.webContents.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 });
    }, "Browse");
    await skipCell("intro:skipKey", async () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
    });

    await cell("intro:clickThrough", async () => {
      await open();
      if (!(await until(async () => (await phaseNow()) === "open", 4000))) return ["the cover never started to dissolve"];
      const p = await js(`(() => { const b = [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings")?.getBoundingClientRect(); return b && { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
      if (!p) return ["no Settings tab"];
      win.webContents.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 });
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [];
      const ph = s.phase.map((x) => x[1]).filter((x, i, a) => x !== a[i - 1]);
      if (!ph.includes("skip") && !ph.slice(-2).includes("open")) v.push(`phases ${ph.join(" → ")}`);
      const tab = await until(async () => ((await js(`document.querySelector(".tab.active")?.textContent ?? ""`)) === "Settings" ? "y" : null), 1500);
      if (!tab) v.push(`the click on Settings while the cover dissolved didn't reach it (active: ${await js(`document.querySelector(".tab.active")?.textContent`)})`);
      return v;
    });

    const offCell = (name, reduced) => cell(name, async () => {
      // the window before this one learns the setting (the look is fixed when a window opens)
      if (!reduced) { await open(); await frames(); }
      await open({ reduced });
      // what the overlay animates while the logo shows, and a screenshot of it (the fade's middle)
      const anim = await until(async () => ((await phaseNow()) === "play" ? props() : null));
      await sleep(70); await shot(`${name.split(":")[1]}-mid`);
      const s = await frames(); if (!s) return ["the sampler never finished"];
      const v = [], tm = deadlines(s, v);
      console.log(`        ${tm.line}`);
      if (tm.play == null) return v;
      const after = (fr) => fr.filter((f) => f[0] >= tm.play - 20);
      console.log(`        frames: logo ${MO.brief(after(s.tile))}; ground ${MO.brief(after(s.bg))}; animates ${J(anim)}`);
      const bad = (anim ?? []).filter((p) => p !== "opacity");
      if (bad.length) v.push(`animates ${bad.join(", ")} with motion off (only opacity)`);
      v.push(...MO.judge("the logo", after(s.tile), { appear: true }));
      v.push(...MO.judge("the logo", after(s.logo), { leave: true }));
      v.push(...MO.judge("the ground", after(s.bg), { leave: true }));
      if (s.ring.some((f) => f[1] != null && f[1] > 0.02)) v.push("the ring showed with motion off");
      return v;
    });
    await setSettings({ morphs: false });
    await offCell("intro:off", false);
    await setSettings({ morphs: true });
    await offCell("intro:reduced", true);

    await cell("look:toggles", async () => {
      await setSettings({ glows: false, liveWallpaperBehindAllTabs: true });
      try {
        await open();
        let glow = null, cls = "";
        if (await until(async () => (await phaseNow()) === "play")) {
          await sleep(200); await shot("toggles-mid");
          glow = await js(`getComputedStyle(document.querySelector(".intro-tile")).boxShadow`);
          cls = await js(`document.documentElement.className`);
        }
        const s = await frames(); if (!s) return ["the sampler never finished"];
        const v = []; deadlines(s, v);
        if (!/no-glow/.test(cls)) v.push(`no :root.no-glow with Glow effects off (${cls})`);
        if (!/bg-live/.test(cls)) v.push(`no :root.bg-live with the live wallpaper behind every tab (${cls})`);
        if (glow == null) v.push("the logo never started");
        else if ((glow.match(/rgb/g) ?? []).length > 1) v.push(`an accent halo with Glow effects off (box-shadow ${glow})`);
        else if (!/rgba\(0, 0, 0/.test(glow)) v.push(`the depth shadow went too (box-shadow ${glow})`);
        const tm = timing(s), under = s.bg.filter((f) => tm.play != null && f[0] >= tm.play && (tm.open == null || f[0] < tm.open));
        if (!under.length) v.push("no frames of the logo coming in — proved nothing");
        else if (under.some((f) => f[1] == null || f[1] < 0.95)) v.push(`the UI showed through the ground while the logo came in (${MO.brief(under)})`);
        return v;
      } finally { await setSettings({ glows: true, liveWallpaperBehindAllTabs: false }); }
    });

    await cell("look:theme", async () => {
      await setSettings({ theme: "Catppuccin Latte" });
      try {
        await open(); await frames(); // the window before this one keeps the theme for the next one's first frames
        await open();
        let got = null;
        if (await until(async () => (await phaseNow()) === "play")) {
          await sleep(200); await shot("theme-mid");
          got = await js(`(() => { const p = document.createElement("i"); p.style.color = "var(--accent)"; p.style.background = "var(--bg-base)"; document.body.append(p);
            const cs = getComputedStyle(p), accent = cs.color, base = cs.backgroundColor; p.remove();
            const img = [...document.querySelectorAll(".intro-img")].find((i) => i.getClientRects().length);
            return { accent, base, ring: getComputedStyle(document.querySelector(".intro-ring")).borderTopColor,
              bg: getComputedStyle(document.querySelector(".intro-bg")).backgroundImage, variant: img?.dataset.variant ?? null, decoded: !!img?.complete && img.naturalWidth > 0 }; })()`);
        }
        const s = await frames(); if (!s) return ["the sampler never finished"];
        const v = []; deadlines(s, v);
        if (!got) return [...v, "the logo never started"];
        if (got.variant !== "lavender") v.push(`the ${got.variant} logo on a light theme (want lavender)`);
        if (!got.decoded) v.push("the logo's picture wasn't loaded when it showed");
        if (got.ring !== got.accent) v.push(`the ring is ${got.ring}, the theme's accent ${got.accent}`);
        if (!got.bg.includes(got.base)) v.push(`the ground (${got.bg}) isn't in the theme's base colour ${got.base}`);
        if (!s.firstBg?.includes(got.base)) v.push(`the ground's first frame (${s.firstBg}) isn't in the theme's base colour ${got.base} (the kept theme)`);
        return v;
      } finally { await setSettings({ theme: "Catppuccin Mocha" }); }
    });
  } catch (e) {
    console.log(`ERROR ${e.stack || e}`);
    results.push({ name: "setup", v: [String(e)] });
  }
  const fails = results.filter((r) => r.v.length);
  console.log(`INTRO ${results.length - fails.length}/${results.length} passed`);
  app.exit(fails.length ? 1 : 0);
});
