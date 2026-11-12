// The top bar's progress line for the library's background operations — `scripts/test-ui-matrix.sh --probe probe-libops.js`
// (the matrix's hermetic stack: private backend + headless liascape-player + this tree's UI). The line
// (app/ui/src/components/LibraryOpsLine.tsx) is driven by a real operation: three imported 1280×720 videos get their full
// clips, then "Video preview quality" changes and the backend's sweep re-makes them (Web/ClipStore.cs, WS library-ops).
//   libops:motion    it appears after the change settles, fades in while its tab drops from under the top bar; it reads
//                    "Making Low previews n / total" (and says so to a screen reader); the fill eases to each count while a
//                    highlight sweeps along it; at the end it fades out
//   libops:noGlow    "Glow effects" off: the fill's glow goes; "Wallpaper behind every tab" (bg-live): a dark track under
//                    the fill, the tab keeps a translucent fill of its own
//   libops:noMotion  "Smooth window animations" off: the line and its tab fade in and out in place (opacity only, in-between
//                    frames, nothing moves), the fill steps (no ease), no sweep
//   libops:hold      on the Settings tab a quality change waits (well past its settle, nothing runs); switching to the
//                    Library starts it and the line shows (App.tsx holds the sweep while Settings shows: ClipStore.HoldSweep)
//   libops:resync    a page opened mid-operation shows the line at once (GET /library/ops)
// Pictures (looked at, not only counted): libops-appear.png, libops-steady.png, libops-noglow-bglive.png, libops-nomotion.png,
// in $LIASCAPE_OUT. Exit 1 on any FAIL.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const MO = require("./motion-off");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const OUT = E.LIASCAPE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));
// a page replaced under the probe leaves its promises pending: the whole run has a ceiling (.claude/rules/testing.md)
setTimeout(() => { console.log("ERROR probe-libops: overall timeout"); app.exit(2); }, 10 * 60 * 1000).unref();

async function http(method, p, body) {
  try {
    const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, error: e.message }; }
}
async function waitFor(pred, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}

let win;
const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const shot = async (name) => fs.writeFileSync(path.join(OUT, `libops-${name}.png`), (await win.webContents.capturePage({ x: 0, y: 0, width: 1400, height: 180 })).toPNG());
const J = JSON.stringify;

// three library videos with their full clips at `q`, as on a user's machine before a quality change
async function fixtures(q) {
  const paths = [];
  for (const t of ["libopsA", "libopsB", "libopsC"]) {
    const f = path.join(OUT, `${t}.mp4`);
    if (!fs.existsSync(f)) cp.execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f], { timeout: 60000 });
    const p = (await http("POST", "/library/import", { path: f, title: t })).json?.videoPath;
    if (p) paths.push(p);
  }
  const ask = (p) => http("GET", `/clip?path=${encodeURIComponent(p)}&info=1&w=400&h=400&q=${q}`);
  const done = await waitFor(async () => (await Promise.all(paths.map(ask))).every((r) => r.json?.full && r.json?.q === q), 90000, 600);
  return done ? paths : null;
}
const opsIdle = () => waitFor(async () => !((await http("GET", "/library/ops")).json?.ops ?? [1]).length, 120000, 300);
const loadLibrary = async () => {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
  await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Library")?.click(); return true`);
  await sleep(800);
};

// every frame until the line has come and gone (≤ ms): the line, its tab and its fill as motion-off.js's SAMPLE records them
// ([t, opacity, x, y, w, h] / [t, null]), the texts it showed and its accessible name
const LINE_SAMPLE = (ms) => `(() => new Promise((res) => { const S = { line: ".libops", tab: ".libops-tab", fill: ".libops-fill" }, out = { texts: [], aria: [] };
  for (const k in S) out[k] = [];
  const t0 = performance.now(); let seen = 0, goneAt = 0;
  const f = () => { const t = Math.round(performance.now() - t0);
    for (const k in S) { const e = document.querySelector(S[k]);
      if (!e || !e.getClientRects().length) { out[k].push([t, null]); continue; }
      let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
      const r = e.getBoundingClientRect(); out[k].push([t, +op.toFixed(3), +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]); }
    const l = document.querySelector(".libops");
    if (l) { seen = 1; goneAt = 0; const tx = l.querySelector(".libops-tab")?.textContent; if (out.texts.at(-1) !== tx) out.texts.push(tx);
      const a = [l.getAttribute("role"), l.getAttribute("aria-label"), l.getAttribute("aria-valuetext")].join("|"); if (out.aria.at(-1) !== a) out.aria.push(a); }
    else if (seen && !goneAt) goneAt = t;
    if (t < ${ms} && !(goneAt && t - goneAt > 600)) requestAnimationFrame(f); else res(out); };
  requestAnimationFrame(f); }))()`;
// frames where the fill's drawn width is between its neighbours' (gliding, not stepping)
const gliding = (fr) => fr.filter((f, i) => i > 0 && i < fr.length - 1 && f[1] != null && fr[i - 1][1] != null && fr[i + 1][1] != null
  && f[4] !== fr[i - 1][4] && f[4] !== fr[i + 1][4] && Math.sign(f[4] - fr[i - 1][4]) === Math.sign(fr[i + 1][4] - f[4])).length;
const moved = (fr) => fr.filter((f, i) => i > 0 && f[1] != null && fr[i - 1][1] != null && Math.abs(f[3] - fr[i - 1][3]) > 0.75).length;
// the shown line's look: the fill's glow, the line's track, the tab's fill and its sweep's animation
const LOOK = `const l = document.querySelector(".libops"); if (!l) return null; const f = l.querySelector(".libops-fill"), t = l.querySelector(".libops-tab");
  return { glow: getComputedStyle(f).boxShadow, track: getComputedStyle(l).backgroundColor, tab: getComputedStyle(t).backgroundColor,
    sweep: getComputedStyle(f, "::after").animationName, z: getComputedStyle(l).zIndex, top: l.getBoundingClientRect().top,
    bar: document.querySelector(".topbar").getBoundingClientRect().bottom };`;
// a sweep: change the quality, sample the line until it has come and gone, a picture as it appears and one while it runs
async function sweep(q, pics) {
  const sm = js(`return ${LINE_SAMPLE(60000)}`);
  await http("POST", "/settings", { videoPreviewQuality: q });
  let look = null;
  if (await waitFor(async () => js(`return !!document.querySelector(".libops")`), 20000, 30)) {
    if (pics?.appear) { await sleep(100); await shot(pics.appear); }
    await sleep(500);
    look = await js(LOOK);
    if (pics?.steady) await shot(pics.steady);
  }
  return { sm: await sm, look };
}

const results = [];
const cell = async (name, fn) => {
  let v;
  try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
  results.push({ name, v });
  console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
  for (const x of v) console.log(`        - ${x}`);
};

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  win.focus();
  try {
    await http("POST", "/settings", { settingsLevel: "advanced", autoPlayVideoThumbs: true, videoPreviewQuality: "high", glows: true, morphs: true, liveWallpaperBehindAllTabs: false });
    const paths = await fixtures("high");
    await loadLibrary();
    await opsIdle();

    let glowOn = null;
    await cell("libops:motion — fades in as its tab drops, reads \"Making Low previews n / total\", the fill eases, it fades out", async () => {
      const v = [];
      if (!paths) return ["the fixtures never got their full High clips — proved nothing"];
      const { sm, look } = await sweep("low", { appear: "appear", steady: "steady" });
      glowOn = look;
      fs.writeFileSync(path.join(OUT, "libops-motion.json"), J({ texts: sm.texts, aria: sm.aria, line: MO.brief(sm.line), tab: MO.brief(sm.tab) }));
      if (!sm.line.some((f) => f[1] != null)) return ["the line never showed — proved nothing"];
      v.push(...MO.judge("the line", sm.line, { appear: true, leave: true, maxMs: 700 }).filter((x) => !/took/.test(x)));
      if (!moved(sm.tab)) v.push(`the tab didn't drop in (no frame moved it: ${MO.brief(sm.tab)})`);
      if (!(gliding(sm.fill) >= 3)) v.push(`the fill didn't ease to its counts (${gliding(sm.fill)} gliding frames)`);
      const bad = sm.texts.filter((t) => !/^Making Low previews\d+ \/ \d+$/.test(t || ""));
      if (bad.length || !sm.texts.length) v.push(`the tab read ${J(sm.texts)}, want "Making Low previews" + "n / total"`);
      if (!sm.aria.length || !sm.aria.every((a) => /^progressbar\|Making Low previews\|Making Low previews: \d+ of \d+$/.test(a))) v.push(`its accessible name ${J(sm.aria)}`);
      if (!look) v.push("gone before its look could be read");
      else {
        if (look.glow === "none" || /^rgba?\(0, 0, 0, 0\)/.test(look.glow)) v.push(`glow on: the fill has no glow (${look.glow})`);
        if (look.sweep !== "slide") v.push(`no highlight sweeping along the fill (animation ${look.sweep})`);
        if (Math.abs(look.top - look.bar) > 1) v.push(`not on the top bar's bottom edge (line at ${look.top}, bar ends at ${look.bar})`);
      }
      return v;
    });

    await cell("libops:noGlow — glow off takes the fill's glow; bg-live puts a dark track under it, the tab keeps its fill", async () => {
      const v = [];
      await opsIdle();
      // a POST /settings reaches an open page only through its next read: load it again
      await http("POST", "/settings", { glows: false, liveWallpaperBehindAllTabs: true });
      await loadLibrary();
      const { look } = await sweep("mid", { steady: "noglow-bglive" });
      await http("POST", "/settings", { glows: true, liveWallpaperBehindAllTabs: false });
      await loadLibrary();
      if (!look || !glowOn) return ["the line wasn't up long enough to read its look — proved nothing"];
      if (!(look.glow === "none" || /0px 0px 0px 0px|^rgba?\(0, 0, 0, 0\) 0px 0px 0px$/.test(look.glow))) v.push(`no-glow: the fill still glows (${look.glow})`);
      if (look.track === glowOn.track) v.push(`bg-live: the same track as without the wallpaper behind (${look.track})`);
      if (/rgba?\(0, 0, 0, 0\)|transparent/.test(look.tab)) v.push(`bg-live: the tab lost its fill (${look.tab})`);
      return v;
    });

    await cell("libops:noMotion — motion off: it fades in and out in place, the fill steps, no sweep", async () => {
      const v = [];
      await opsIdle();
      await http("POST", "/settings", { morphs: false });
      await loadLibrary();
      const { sm, look } = await sweep("high", { steady: "nomotion" });
      await http("POST", "/settings", { morphs: true });
      await loadLibrary();
      if (!sm.line.some((f) => f[1] != null)) return ["the line never showed — proved nothing"];
      v.push(...MO.judge("motion off, the line", sm.line, { appear: true, leave: true }));
      v.push(...MO.judge("motion off, the tab", sm.tab, { appear: true, leave: true, size: false }));
      if (gliding(sm.fill)) v.push(`motion off: the fill glided in ${gliding(sm.fill)} frames (want steps)`);
      if (look && look.sweep !== "none") v.push(`motion off: the highlight still sweeps (${look.sweep})`);
      if (!sm.texts.every((t) => /^Making High previews\d+ \/ \d+$/.test(t || ""))) v.push(`the tab read ${J(sm.texts)}`);
      return v;
    });

    await cell("libops:hold — on Settings a quality change waits; switching to the Library starts it", async () => {
      await opsIdle();
      const tabTo = (t) => js(`const b = [...document.querySelectorAll(".tab")].find((x) => x.textContent.trim() === ${J(t)}); b?.click(); return !!b`);
      if (!(await tabTo("Settings"))) return ["no Settings tab"];
      await sleep(800);
      const cur = (await http("GET", "/settings")).json?.videoPreviewQuality;
      const q = cur === "mid" ? "low" : "mid";
      await http("POST", "/settings", { videoPreviewQuality: q });
      await sleep(7000);   // the settle is 4 s
      const v = [];
      const held = ((await http("GET", "/library/ops")).json?.ops ?? []).some((o) => o.id === "clips");
      if (held) v.push(`on Settings: the sweep to ${q} started anyway`);
      if (await js(`return !!document.querySelector(".libops")`)) v.push("on Settings: the line showed");
      await tabTo("Library");
      const t0 = Date.now();
      const shown = await waitFor(async () => js(`return !!document.querySelector(".libops")`), 8000, 50);
      if (!shown) v.push("back on the Library: no sweep line within 8 s");
      else console.log(`        the line showed ${Date.now() - t0} ms after leaving Settings`);
      await opsIdle();
      return v;
    });

    await cell("libops:resync — a page opened mid-operation shows the line at once", async () => {
      await opsIdle();
      await http("POST", "/settings", { videoPreviewQuality: "low" });
      const running = await waitFor(async () => ((await http("GET", "/library/ops")).json?.ops ?? []).some((o) => o.id === "clips"), 20000, 100);
      if (!running) return ["no sweep ran — proved nothing"];
      await win.loadURL(withToken(U + "/"));
      const t0 = Date.now();
      const shown = await waitFor(async () => js(`return !!document.querySelector(".libops")`), 5000, 50);
      const still = ((await http("GET", "/library/ops")).json?.ops ?? []).some((o) => o.id === "clips");
      if (!shown && still) return [`the reloaded page didn't show the running sweep within 5 s`];
      if (!shown) return ["the sweep ended before the page loaded — proved nothing"];
      return Date.now() - t0 > 4000 ? [`the line took ${Date.now() - t0} ms to show on the reloaded page`] : [];
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`LIBOPS pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "libops.json"), J(results, null, 1));
  app.exit(fail ? 1 : 0);
});
