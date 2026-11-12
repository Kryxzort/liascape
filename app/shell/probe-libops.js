// The top bar's progress line for the library's background operations and its words in the top bar's status slot —
// `scripts/test-ui-matrix.sh --probe probe-libops.js` (the matrix's hermetic stack: private backend + headless liascape-player +
// this tree's UI). The line (app/ui/src/components/LibraryOpsLine.tsx) and the words (TopbarStatus.tsx) are driven by a real
// operation: three imported 1280×720 videos get their full clips, then "Video preview quality" changes and the backend's sweep
// re-makes them (Web/ClipStore.cs, WS library-ops). Several operations at once and a status message come through the debug
// bridge (`?debug`: liascapeDbg.ops / .status — the store's own setters, as the library-ops event and a status line set them).
//   libops:motion    it appears after the change settles and fades in; the status slot reads "Making Low previews n / total"
//                    (fading in over the Library's hint, out at the end; no tab hangs under the bar); the line says it to a
//                    screen reader; the fill eases to each count while a highlight sweeps along it; at the end it fades out
//   libops:noGlow    "Glow effects" off: the fill's glow goes; "Wallpaper behind every tab" (bg-live): a dark track under
//                    the fill, the words on the top bar's own translucent fill
//   libops:noMotion  "Smooth window animations" off: the line and the words fade in and out in place (opacity only, in-between
//                    frames, nothing moves), the fill steps (no ease), no sweep
//   libops:hold      on the Settings tab a quality change waits (well past its settle, nothing runs); switching to the
//                    Library starts it and the line shows (App.tsx holds the sweep while Settings shows: ClipStore.HoldSweep)
//   libops:resync    a page opened mid-operation shows the line at once (GET /library/ops)
//   libops:browse    while an operation runs, switching to Browse fades the line out where it is (no run to the end) and Browse
//                    shows neither it nor its words; back on the Library they fade in again
//   libops:status    the slot's order: a status message, else the operation's words (the Library, Settings), else the Library's
//                    hint; each change cross-fades (the old line fades out while the new fades in); the controls right of
//                    the slot never move; below 1000 px the count alone, the full wording in its tooltip
//   libops:toggle    a wallpaper playing and an operation running: the words show the operation and are a toggle ("Show what's
//                    playing", the first of two dots); a click and Enter flip them to the now-playing line and back,
//                    cross-fading (motion on and off); the pick lasts while counts move; a timed message shows over both for
//                    its 5 s; the operation's end brings the now-playing line back, plain
//   libops:edge      the edge row of the top bar (its bottom border's pixels, captured) holds no border-coloured pixel while
//                    the operations' line (Library) or the load bar (Browse) runs, and is the border when neither does — with
//                    and without the wallpaper behind every tab. Pictures libops-edge-*.png (8× zoomed)
//   libops:combined  three operations at once: one line, its fill the sum of done over the sum of total; the words name the one
//                    that started first with its own count and "· +2 more" (narrow: "+2"), the line's accessible name lists all
//                    three; counts moving never switch the named one; when it ends the words cross-fade to the next
// Pictures (looked at, not only counted): libops-appear.png, libops-steady.png, libops-noglow-bglive.png, libops-nomotion.png,
// libops-browse-mid.png, libops-status-*.png, libops-combined*.png in $LIASCAPE_OUT. Exit 1 on any FAIL.
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
// `debug`: the page with the liascapeDbg bridge (fake operations, a status message)
const loadLibrary = async (debug = false) => {
  await win.loadURL(withToken(U + "/") + (debug ? "&debug" : ""));
  for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
  await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Library")?.click(); return true`);
  await sleep(800);
};

// the words in the top bar's status slot (the one coming in, not one fading out)
const WORDS = ".topbar > .status .st-op:not(.out)";
// every frame until the line has come and gone (≤ ms): the line, its words and its fill as motion-off.js's SAMPLE records them
// ([t, opacity, x, y, w, h] / [t, null]), the texts the words showed, the line's accessible name, and whether a tab ever hung
// under the bar
// (the frames follow the words' layer through its fade out too: WORDS stops matching it once it is leaving)
const LINE_SAMPLE = (ms) => `(() => new Promise((res) => { const S = { line: ".libops", words: ".topbar > .status [data-st=op]", fill: ".libops-fill" }, out = { texts: [], aria: [], tab: 0 };
  for (const k in S) out[k] = [];
  const t0 = performance.now(); let seen = 0, goneAt = 0;
  const f = () => { const t = Math.round(performance.now() - t0);
    for (const k in S) { const e = document.querySelector(S[k]);
      if (!e || !e.getClientRects().length) { out[k].push([t, null]); continue; }
      let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
      const r = e.getBoundingClientRect(); out[k].push([t, +op.toFixed(3), +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]); }
    const l = document.querySelector(".libops");
    if (document.querySelector(".libops-tab")) out.tab++;
    const w = document.querySelector(${JSON.stringify(WORDS)}); if (w && out.texts.at(-1) !== w.textContent) out.texts.push(w.textContent);
    if (l) { seen = 1; goneAt = 0;
      const a = [l.getAttribute("role"), l.getAttribute("aria-label"), l.getAttribute("aria-valuetext")].join("|"); if (out.aria.at(-1) !== a) out.aria.push(a); }
    else if (seen && !goneAt) goneAt = t;
    if (t < ${ms} && !(goneAt && t - goneAt > 600)) requestAnimationFrame(f); else res(out); };
  requestAnimationFrame(f); }))()`;
// frames where the fill's drawn width is between its neighbours' (gliding, not stepping)
// the words are right-aligned and hug their text: a count with another digit widens them leftwards; their right edge stays
const rightMoved = (fr) => fr.filter((f, i) => i > 0 && f[1] != null && fr[i - 1][1] != null && Math.abs(f[2] + f[4] - fr[i - 1][2] - fr[i - 1][4]) > 0.75).length;
const gliding = (fr) => fr.filter((f, i) => i > 0 && i < fr.length - 1 && f[1] != null && fr[i - 1][1] != null && fr[i + 1][1] != null
  && f[4] !== fr[i - 1][4] && f[4] !== fr[i + 1][4] && Math.sign(f[4] - fr[i - 1][4]) === Math.sign(fr[i + 1][4] - f[4])).length;
// the shown line's look: the fill's glow, the line's track, the fill of the bar its words sit on and its sweep's animation
const LOOK = `const l = document.querySelector(".libops"); if (!l) return null; const f = l.querySelector(".libops-fill"), w = document.querySelector(${JSON.stringify(WORDS)});
  return { glow: getComputedStyle(f).boxShadow, track: getComputedStyle(l).backgroundColor, bar: w?.closest(".topbar") ? getComputedStyle(w.closest(".topbar")).backgroundColor : null,
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
    await cell("libops:motion — fades in, the status slot reads \"Making Low previews n / total\", the fill eases, it fades out", async () => {
      const v = [];
      if (!paths) return ["the fixtures never got their full High clips — proved nothing"];
      const { sm, look } = await sweep("low", { appear: "appear", steady: "steady" });
      glowOn = look;
      fs.writeFileSync(path.join(OUT, "libops-motion.json"), J({ texts: sm.texts, aria: sm.aria, line: MO.brief(sm.line), words: MO.brief(sm.words) }));
      if (!sm.line.some((f) => f[1] != null)) return ["the line never showed — proved nothing"];
      v.push(...MO.judge("the line", sm.line, { appear: true, leave: true, maxMs: 700 }).filter((x) => !/took/.test(x)));
      v.push(...MO.judge("the words", sm.words, { appear: true, leave: true, maxMs: 500, still: false }));
      if (rightMoved(sm.words)) v.push(`the words' right edge moved in ${rightMoved(sm.words)} frames (${MO.brief(sm.words)})`);
      if (sm.tab) v.push(`a tab hung under the top bar in ${sm.tab} frames (the words belong in its status slot)`);
      if (!(gliding(sm.fill) >= 3)) v.push(`the fill didn't ease to its counts (${gliding(sm.fill)} gliding frames)`);
      const bad = sm.texts.filter((t) => !/^Making Low previews\d+ \/ \d+$/.test(t || ""));
      if (bad.length || !sm.texts.length) v.push(`the status slot read ${J(sm.texts)}, want "Making Low previews" + "n / total"`);
      if (!sm.aria.length || !sm.aria.every((a) => /^progressbar\|Making Low previews\|Making Low previews: \d+ of \d+$/.test(a))) v.push(`its accessible name ${J(sm.aria)}`);
      if (!look) v.push("gone before its look could be read");
      else {
        if (look.glow === "none" || /^rgba?\(0, 0, 0, 0\)/.test(look.glow)) v.push(`glow on: the fill has no glow (${look.glow})`);
        if (look.sweep !== "slide") v.push(`no highlight sweeping along the fill (animation ${look.sweep})`);
        if (Math.abs(look.top - look.bar) > 1) v.push(`not on the top bar's bottom edge (line at ${look.top}, bar ends at ${look.bar})`);
      }
      return v;
    });

    await cell("libops:noGlow — glow off takes the fill's glow; bg-live puts a dark track under it, the words on the bar's fill", async () => {
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
      if (!look.bar || /rgba?\(0, 0, 0, 0\)|transparent/.test(look.bar)) v.push(`bg-live: the words aren't on the top bar's fill (${look.bar})`);
      return v;
    });

    await cell("libops:noMotion — motion off: the line and its words fade in and out in place, the fill steps, no sweep", async () => {
      const v = [];
      await opsIdle();
      await http("POST", "/settings", { morphs: false });
      await loadLibrary();
      const { sm, look } = await sweep("high", { steady: "nomotion" });
      await http("POST", "/settings", { morphs: true });
      await loadLibrary();
      if (!sm.line.some((f) => f[1] != null)) return ["the line never showed — proved nothing"];
      v.push(...MO.judge("motion off, the line", sm.line, { appear: true, leave: true }));
      v.push(...MO.judge("motion off, the words", sm.words, { appear: true, leave: true, still: false }));
      if (rightMoved(sm.words)) v.push(`motion off: the words' right edge moved in ${rightMoved(sm.words)} frames`);
      if (gliding(sm.fill)) v.push(`motion off: the fill glided in ${gliding(sm.fill)} frames (want steps)`);
      if (look && look.sweep !== "none") v.push(`motion off: the highlight still sweeps (${look.sweep})`);
      if (!sm.texts.every((t) => /^Making High previews\d+ \/ \d+$/.test(t || ""))) v.push(`the status slot read ${J(sm.texts)}`);
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

    const tabTo = async (t) => { await js(`const b = [...document.querySelectorAll(".tab")].find((x) => x.textContent.trim() === ${J(t)}); b?.click(); return !!b`); await sleep(700); };
    const opsRunning = async () => ((await http("GET", "/library/ops")).json?.ops ?? []).length > 0;

    await cell("libops:browse — on Browse the line fades out where it is and neither it nor its words show; back on the Library they do", async () => {
      // an operation that holds still (the debug bridge's, as the library-ops event sets it): a real sweep here ends in seconds
      const v = [];
      await opsIdle();
      await loadLibrary(true);
      if (!(await js(`return typeof window.liascapeDbg?.ops === "function"`))) return ["no debug bridge (liascapeDbg.ops) — proved nothing"];
      await js(`window.liascapeDbg.ops([{ id: "clips", phase: "low", done: 5, total: 12 }]); return true`);
      if (!(await waitFor(async () => js(`return !!document.querySelector(".libops")`), 3000, 30))) return ["no line showed — proved nothing"];
      await sleep(900);
      const sm = js(`return ${MO.SAMPLE({ line: ".libops", fill: ".libops-fill" }, 700)}`);
      await sleep(60);
      await js(`[...document.querySelectorAll(".tab")].find((x) => x.textContent.trim() === "Browse").click(); return true`);
      await sleep(70); await shot("browse-mid");
      const fr = await sm;
      await sleep(600);
      const onBrowse = await js(`return { line: !!document.querySelector(".libops"), words: !!document.querySelector(".topbar > .status [data-st=op]") }`);
      // still: false — Browse's bar is a little shorter, and the line stays on its edge as it fades
      v.push(...MO.judge("leaving for Browse, the line", fr.line, { leave: true, still: false }).filter((x) => !/took/.test(x)));
      const ws = fr.fill.filter((f) => f[1] != null).map((f) => f[4]);
      if (ws.length > 1 && Math.max(...ws) - Math.min(...ws) > 1) v.push(`leaving for Browse the fill moved (${Math.min(...ws)} → ${Math.max(...ws)} px wide): it fades where it is`);
      if (onBrowse.line || onBrowse.words) v.push(`on Browse while it runs: line ${onBrowse.line}, words ${onBrowse.words} (want neither)`);
      const sm2 = js(`return ${MO.SAMPLE({ line: ".libops", words: ".topbar > .status [data-st=op]" }, 1300)}`);
      await sleep(60);
      await js(`[...document.querySelectorAll(".tab")].find((x) => x.textContent.trim() === "Library").click(); return true`);
      const fr2 = await sm2;
      v.push(...MO.judge("back on the Library, the line", fr2.line, { appear: true, still: false }).filter((x) => !/took/.test(x)));
      v.push(...MO.judge("back on the Library, the words", fr2.words, { appear: true }).filter((x) => !/took/.test(x)));
      await js(`window.liascapeDbg.ops([]); return true`); await sleep(800);
      return v;
    });

    // the slot's words and their layers: what it says, the classes of the layers in it, the controls right of it
    const SLOT = `const st = document.querySelector(".topbar > .status"); const live = st.querySelector(".st-layer:not(.out)");
      const wrap = st.querySelector(".st-wrap");
      return { kind: st.dataset.status, text: live?.textContent ?? null, title: live?.getAttribute("title") ?? null,
        toggle: wrap?.getAttribute("role") === "button", name: wrap?.getAttribute("aria-label") ?? null, dot: st.querySelector(".st-dots")?.dataset.on ?? null,
        right: [...document.querySelectorAll(".topbar > .status ~ *")].map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x * 2) / 2, Math.round(b.width * 2) / 2]; }),
        line: document.querySelector(".libops")?.getAttribute("aria-label") ?? null };`;
    const slot = () => js(SLOT);
    const dbg = (call) => js(`return window.liascapeDbg.${call}`);
    const LAYERS = { hint: ".topbar > .status [data-st=hint]", op: ".topbar > .status [data-st=op]", status: ".topbar > .status [data-st=status]",
      playing: ".topbar > .status [data-st=playing]" };
    // a change of what the slot says: the one leaving fades out while the one coming fades in, neither moves
    const xfade = async (what, from, to, act) => {
      const sm = js(`return ${MO.SAMPLE(LAYERS, 900)}`);
      await sleep(60); await act();
      const fr = await sm;
      return [...MO.judge(`${what}: the ${from} leaving`, fr[from], { leave: true, maxMs: 400 }), ...MO.judge(`${what}: the ${to} coming`, fr[to], { appear: true, maxMs: 400 })];
    };

    await cell("libops:status — a status message, else the operation's words, else the hint; each change cross-fades, nothing right of it moves", async () => {
      const v = [];
      await opsIdle();
      await loadLibrary(true);
      if (!(await js(`return typeof window.liascapeDbg?.ops === "function"`))) return ["no debug bridge (liascapeDbg.ops) — proved nothing"];
      await dbg(`status("")`); await dbg(`ops([])`); await sleep(400);
      let r = await slot();
      if (r.kind !== "hint" || r.text !== "Your downloaded wallpapers") v.push(`no operation, no message: the slot reads ${r.kind} "${r.text}" (want the hint)`);
      const right0 = J(r.right);
      v.push(...await xfade("the operation starting", "hint", "op", () => dbg(`ops([{ id: "clips", phase: "low", done: 1, total: 6 }])`)));
      r = await slot();
      if (r.kind !== "op" || r.text !== "Making Low previews1 / 6") v.push(`an operation running: the slot reads ${r.kind} "${r.text}"`);
      if (r.toggle) v.push("nothing playing (one thing to tell), yet the words are a toggle");
      if (J(r.right) !== right0) v.push(`the words came and the controls right of the slot moved: ${right0} → ${J(r.right)}`);
      await shot("status-op");
      v.push(...await xfade("a status message", "op", "status", () => dbg(`status("Applied: probe wallpaper")`)));
      r = await slot();
      if (r.kind !== "status" || r.text !== "Applied: probe wallpaper") v.push(`a message over the operation: the slot reads ${r.kind} "${r.text}"`);
      if (J(r.right) !== right0) v.push(`the message moved the controls right of the slot: ${J(r.right)}`);
      await shot("status-message");
      v.push(...await xfade("the message cleared", "status", "op", () => dbg(`status("")`)));
      r = await slot();
      if (r.kind !== "op") v.push(`the message cleared: the slot reads ${r.kind} "${r.text}" (want the operation again)`);
      win.setContentSize(900, 900); await sleep(600);
      r = await slot();
      if (r.text !== "1 / 6" || !/Making Low previews: 1 of 6/.test(r.title ?? "")) v.push(`900 px: the slot reads "${r.text}", tooltip "${r.title}" (want "1 / 6", the full wording in the tooltip)`);
      await shot("status-narrow");
      win.setContentSize(1400, 900); await sleep(600);
      await tabTo("Settings");
      r = await slot();
      if (r.kind !== "op" || !r.line) v.push(`on Settings: the slot reads ${r.kind}, the line ${r.line} (want both)`);
      await tabTo("Browse");
      await sleep(400);
      r = await slot();
      if (r.kind === "op" || r.line) v.push(`on Browse: the slot reads ${r.kind} "${r.text}", the line ${r.line} (want neither)`);
      await tabTo("Library");
      v.push(...await xfade("the operation ending", "op", "hint", () => dbg(`ops([])`)));
      return v;
    });

    await cell("libops:combined — three operations: one line (summed), the first one named with \"· +2 more\", no switching while counts move, the next named when it ends", async () => {
      const v = [];
      await opsIdle();
      await loadLibrary(true);
      if (!(await js(`return typeof window.liascapeDbg?.ops === "function"`))) return ["no debug bridge (liascapeDbg.ops) — proved nothing"];
      await dbg(`status("")`);
      const set = (ops) => dbg(`ops(${J(ops)})`);
      const C = (d) => ({ id: "clips", phase: "low", done: d, total: 12 }), Sc = (d) => ({ id: "scene-loudness", phase: "", done: d, total: 4 }), Vi = (d) => ({ id: "video-loudness", phase: "", done: d, total: 8 });
      await set([C(3)]); await sleep(120);
      await set([C(3), Sc(1)]); await sleep(120);
      await set([C(3), Sc(1), Vi(0)]); await sleep(1300);
      const LINE = `const l = document.querySelector(".libops"); if (!l) return null; const m = new DOMMatrixReadOnly(getComputedStyle(l.querySelector(".libops-fill")).transform);
        return { label: l.getAttribute("aria-label"), text: l.getAttribute("aria-valuetext"), now: +l.getAttribute("aria-valuenow"), max: +l.getAttribute("aria-valuemax"), scale: +m.a.toFixed(3) };`;
      let l = await js(LINE), r = await slot();
      console.log(`        three at once: ${J({ l, r })}`);
      if (!l) return [...v, "no line with three operations running"];
      if (r.text !== "Making Low previews3 / 12· +2 more") v.push(`the slot reads "${r.text}" (want "Making Low previews" "3 / 12" "· +2 more")`);
      if (l.label !== "Making Low previews, Measuring scene loudness, Measuring video loudness") v.push(`the line's name is "${l.label}" (want all three)`);
      if (l.text !== "Making Low previews: 3 of 12; Measuring scene loudness: 1 of 4; Measuring video loudness: 0 of 8") v.push(`the line's value text is "${l.text}"`);
      if (l.now !== 4 || l.max !== 24 || Math.abs(l.scale - 4 / 24) > 0.01) v.push(`the fill is ${l.scale} (${l.now} / ${l.max}), want the sum: 4 / 24`);
      await shot("combined");
      // counts moving: the named one stays (never a cycle)
      const sm = js(`return new Promise((res) => { const seen = new Set(); const t0 = performance.now(); const f = () => { const w = document.querySelector(${J(WORDS)}); if (w) seen.add(w.dataset.opId);
        if (performance.now() - t0 < 1500) requestAnimationFrame(f); else res([...seen]); }; requestAnimationFrame(f); })`);
      for (const [c, sc, vi] of [[4, 2, 1], [4, 3, 3], [5, 4, 5], [6, 4, 6]]) { await set([C(c), Sc(sc), Vi(vi)]); await sleep(300); }
      const named = await sm;
      if (named.length !== 1 || named[0] !== "clips") v.push(`while the counts moved the words named ${J(named)} (want clips alone)`);
      win.setContentSize(900, 900); await sleep(600);
      r = await slot();
      if (r.text !== "6 / 12+2" || !/Measuring video loudness: 6 of 8/.test(r.title ?? "")) v.push(`900 px: the slot reads "${r.text}", tooltip "${r.title}" (want "6 / 12" "+2", every operation in the tooltip)`);
      await shot("combined-narrow");
      win.setContentSize(1400, 900); await sleep(600);
      // the named one ends: the words cross-fade to the next
      const sm2 = js(`return ${MO.SAMPLE({ old: ".topbar > .status [data-op-id=clips]", next: ".topbar > .status [data-op-id=scene-loudness]" }, 900)}`);
      await sleep(60); await set([Sc(4), Vi(6)]);
      const fr = await sm2;
      v.push(...MO.judge("the named one ending: its words", fr.old, { leave: true, maxMs: 400 }), ...MO.judge("the next one's words", fr.next, { appear: true, maxMs: 400 }));
      r = await slot(); l = await js(LINE);
      if (r.text !== "Measuring scene loudness4 / 4· +1 more") v.push(`after the first ended the slot reads "${r.text}" (want "Measuring scene loudness" "4 / 4" "· +1 more")`);
      if (!l || l.now !== 10 || l.max !== 12) v.push(`after the first ended the line sums ${l?.now} / ${l?.max} (want 10 / 12)`);
      await set([]); await sleep(900);
      r = await slot();
      if (r.kind !== "hint" || r.line) v.push(`all ended: the slot reads ${r.kind}, the line ${r.line} (want the hint, no line)`);
      return v;
    });

    // the now-playing line and the background work: the work shows first, the words flip between the two (a click, Enter),
    // cross-fading; the pick lasts while the work runs, a timed message shows over both for its life, the end brings the
    // now-playing line back. Motion off: the same, fading on opacity alone.
    await cell("libops:toggle — work first; a click or Enter flips to what's playing and back, cross-fading; the end brings what's playing back", async () => {
      const v = [];
      await opsIdle();
      const lib = (await http("GET", "/library")).json ?? [];
      const vids = lib.filter((i) => !i.isScene);
      if (vids.length < 2) return ["fewer than two library videos to play — proved nothing"];
      const clickWords = async () => {
        const p = await js(`const b = document.querySelector(".topbar > .status .st-wrap").getBoundingClientRect(); return { x: Math.round(b.right - 20), y: Math.round(b.y + b.height / 2) }`);
        win.webContents.sendInputEvent({ type: "mouseMove", ...p }); await sleep(30);
        win.webContents.sendInputEvent({ type: "mouseDown", ...p, button: "left", clickCount: 1 }); await sleep(30);
        win.webContents.sendInputEvent({ type: "mouseUp", ...p, button: "left", clickCount: 1 });
      };
      const flip = async (what, from, to, how, motion) => {
        const sm = js(`return ${MO.SAMPLE(LAYERS, 900)}`);
        await sleep(60); await how();
        const fr = await sm;
        // motion on, a press squeezes the words a little (scale) as they cross-fade: judged on their fade alone
        return motion ? [...MO.judge(`${what}: the ${from} leaving`, fr[from], { leave: true, maxMs: 400, still: false }), ...MO.judge(`${what}: the ${to} coming`, fr[to], { appear: true, maxMs: 400, still: false })]
          : [...MO.judge(`motion off, ${what}: the ${from} leaving`, fr[from], { leave: true }), ...MO.judge(`motion off, ${what}: the ${to} coming`, fr[to], { appear: true })];
      };
      try {
        for (const motion of [true, false]) {
          await http("POST", "/settings", { morphs: motion });
          await loadLibrary(true);
          await dbg(`ops([])`);
          // with the page open (another item each time, so a wallpaper-changed comes): the now-playing line follows it
          await http("POST", "/apply", { path: vids[motion ? 0 : 1].videoPath });
          if (!(await waitFor(async () => (await slot()).kind === "playing", 8000, 100))) return [...v, `nothing playing in the slot (${J(await slot())}) — proved nothing`];
          await dbg(`ops([{ id: "clips", phase: "low", done: 1, total: 6 }])`); await sleep(1100);
          let r = await slot();
          const M = motion ? "" : "motion off: ";
          if (r.kind !== "op" || !r.toggle || r.name !== "Show what's playing" || r.dot !== "0")
            v.push(`${M}work running beside what's playing: the slot is ${r.kind}, toggle ${r.toggle}, named "${r.name}", dot ${r.dot} (want the work, a toggle "Show what's playing", the first dot)`);
          if (motion) await shot("toggle-op");
          v.push(...await flip(`${M}a click`, "op", "playing", clickWords, motion));
          r = await slot();
          if (r.kind !== "playing" || r.name !== "Show the library's progress" || r.dot !== "1") v.push(`${M}after a click: ${r.kind}, named "${r.name}", dot ${r.dot}`);
          if (motion) { await sleep(150); await shot("toggle-playing"); }
          // the pick lasts while the work moves on
          await dbg(`ops([{ id: "clips", phase: "low", done: 2, total: 6 }])`); await sleep(400);
          if ((r = await slot()).kind !== "playing") v.push(`${M}a count moved and the slot went back to ${r.kind} (the pick should last)`);
          // the keyboard: focus it, Enter
          await js(`document.querySelector(".topbar > .status .st-wrap").focus(); return true`);
          v.push(...await flip(`${M}Enter`, "playing", "op", async () => { win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" }); await sleep(20); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" }); }, motion));
          if ((r = await slot()).kind !== "op") v.push(`${M}Enter left the slot on ${r.kind} (want the work)`);
          // a timed message over both, then back to the pick
          if (motion) {
            await dbg(`status("Applied: probe", true)`); await sleep(300);
            if ((r = await slot()).kind !== "status" || r.toggle) v.push(`a timed message: the slot is ${r.kind}, toggle ${r.toggle} (want the message, no toggle)`);
            await sleep(5600);
            if ((r = await slot()).kind !== "op" || !r.toggle) v.push(`the message's 5 s over: the slot is ${r.kind}, toggle ${r.toggle} (want the work again, a toggle)`);
          }
          // the work ends: what's playing comes back, not a toggle
          v.push(...await flip(`${M}the work ending`, "op", "playing", () => dbg(`ops([])`), motion));
          await sleep(300);
          if ((r = await slot()).kind !== "playing" || r.toggle) v.push(`${M}the work over: the slot is ${r.kind}, toggle ${r.toggle} (want what's playing, plain)`);
        }
      } finally {
        await http("POST", "/settings", { morphs: true });
        await http("POST", "/stop");
      }
      return v;
    });

    // the lines on the top bar's bottom edge cover its border: the edge's own pixel row, captured, holds no --surface0 pixel
    // while a line runs (Library: the operations' line; Browse: the load bar), and is the border's colour when none does —
    // with and without the wallpaper behind every tab. Pictures libops-edge-<case>.png (the edge, 8× zoomed by nearest)
    await cell("libops:edge — a running line covers the top bar's bottom border (no border pixel under it), the border shows without one", async () => {
      const v = [];
      await opsIdle();
      // the edge rows: how much of the most border-coloured one is the border's colour; and a zoomed picture
      // `at`: the device row the border was found on without a line (the line's own track below it may be near its colour)
      const edge = async (name, at = null) => {
        const g = await js(`const tb = document.querySelector(".topbar").getBoundingClientRect(); const i = document.createElement("i"); i.style.background = "var(--surface0)";
          document.body.append(i); const c = getComputedStyle(i).backgroundColor; i.remove(); return { bottom: tb.bottom, W: Math.floor(tb.width), c: c.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number) }`);
        const y0 = Math.floor(g.bottom) - 3, rect = { x: 0, y: y0, width: g.W, height: 6 };
        const img = await win.webContents.capturePage(rect);
        const { width: iw, height: ih } = img.getSize(), sf = iw / rect.width, bmp = img.toBitmap();
        // every device row around the edge (the border lands on one or two of them at a fractional scale): the most
        // border-coloured one counts
        let share = 0, row = at ?? -1;
        for (let y = at ?? 0; y < (at == null ? ih : at + 1); y++) {
          let hit = 0;
          for (let x = 0; x < iw; x++) { const o = (y * iw + x) * 4;
            if (Math.abs(bmp[o + 2] - g.c[0]) <= 6 && Math.abs(bmp[o + 1] - g.c[1]) <= 6 && Math.abs(bmp[o] - g.c[2]) <= 6) hit++; }
          if (hit / iw > share) { share = hit / iw; row = y; }
        }
        fs.writeFileSync(path.join(OUT, `libops-edge-${name}.png`), img.crop({ x: 0, y: 0, width: Math.min(iw, Math.round(320 * sf)), height: ih })
          .resize({ width: Math.min(iw, Math.round(320 * sf)) * 8, height: ih * 8, quality: "good" }).toPNG());
        return { share, row, sf };
      };
      for (const live of [false, true]) {
        await http("POST", "/settings", { liveWallpaperBehindAllTabs: live });
        await loadLibrary(true);
        const L = live ? "bg-live" : "plain";
        await dbg(`ops([])`); await sleep(700);
        const none = await edge(`${L}-none`);
        await dbg(`ops([{ id: "clips", phase: "low", done: 3, total: 12 }])`); await sleep(1500);
        const line = await edge(`${L}-libops`, none.row);
        await dbg(`ops([])`); await sleep(900);
        // Browse's load bar: its page request held open (a stub that never answers), so it stays up
        await js(`const f = window.fetch; window.fetch = (u, o) => String(u).split("?")[0].endsWith("/browse") && o?.method === "POST" ? new Promise(() => {}) : f(u, o); return true`);
        await tabTo("Browse");
        if (!(await waitFor(async () => js(`return !!document.querySelector(".loadbar")`), 1500, 50)))
          await js(`[...document.querySelectorAll(".pill")].find((p) => !p.classList.contains("active"))?.click(); return true`);
        const loading = await waitFor(async () => js(`return !!document.querySelector(".loadbar")`), 4000, 50);
        await sleep(400);
        const load = loading ? await edge(`${L}-loadbar`, none.row) : null;
        console.log(`        ${L}: border-coloured share of the edge row — no line ${none.share.toFixed(3)}, operations' line ${line.share.toFixed(3)}, load bar ${load?.share.toFixed(3) ?? "(none)"} (row ${none.row}, ×${none.sf})`);
        if (none.share < 0.5) v.push(`${L}: with no line the edge row is only ${(none.share * 100).toFixed(0)} % border-coloured — the check can't see the border, proved nothing`);
        if (line.share > 0.01) v.push(`${L}: the operations' line leaves ${(line.share * 100).toFixed(1)} % of the edge row border-coloured (want none)`);
        if (!load) v.push(`${L}: Browse's load bar never showed — proved nothing`);
        else if (load.share > 0.01) v.push(`${L}: the load bar leaves ${(load.share * 100).toFixed(1)} % of the edge row border-coloured (want none)`);
      }
      await http("POST", "/settings", { liveWallpaperBehindAllTabs: false });
      await loadLibrary();
      return v;
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
