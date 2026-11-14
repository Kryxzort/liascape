// Settings rows probe — `scripts/test-ui-matrix.sh --probe probe-settings.js` (the matrix's hermetic stack: private backend
// + headless liascape-player + this tree's UI; its HOME is the stack's, so the cache fixtures below never touch a real one).
//   rename:autoMute   Sound → the auto-mute switch is the row "Mute when other audio plays" under the "Auto-mute" heading (no "Hush when other audio plays"), it saves autoMute
//   copy:feedback     Keyboard shortcuts' Copy turns into a green "Copied" and settles back to "Copy" (hooks/useCopied.ts, the
//                     sidebar pill's timing): the two faces roll (motion on) or only cross-fade (motion off, prefers-reduced-motion),
//                     the button keeps its width and the command beside it never moves
//   copy:commands     what lands on the clipboard: a shortcut's command, Autostart's, and (Expert) the whole "mpv command (live)"
//                     and "linux-wallpaperengine command (live)" blocks
//   copy:sidebarPill  the Library sidebar's Workshop ID pill, which shares the feedback (hooks/useCopied.ts), still flips and copies
//   copy:look         hover glow, no-glow, bg-live (a see-through fill), "Copied" in --success; pictures settings-copy-*.png
//   nudge:engine      "Full-live sync nudge" (Full-live at Advanced) only while the legacy engine runs — the page is told
//                     "legacy" by a stubbed /player-engine; hidden, its value stays saved
//   cache:size        Housekeeping names what it clears and shows the size of exactly those folders (workshop_previews,
//                     we_thumbs — not video_clips)
//   cache:clear       Clear Cache empties them (the clips stay), the row then shows what was freed (a cross-fade in place,
//                     motion on and off); pictures settings-cache-*.png
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  try {
    const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : J(body) });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, error: e.message }; }
}
async function waitFor(pred, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
// never prints a /settings response: only the single non-secret fields asked for
const field = async (k) => ((await http("GET", "/settings")).json ?? {})[k];
const setSettings = (patch) => http("POST", "/settings", patch); // a partial body merges

let win;
const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const send = (e) => win.webContents.sendInputEvent(e);
const mv = async (x, y, ms = 0) => { send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); if (ms) await sleep(ms); };
async function clickAt(x, y) {
  await mv(x, y, 60);
  send({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(40);
  send({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
}
async function reducedMotion(on) {
  const d = win.webContents.debugger;
  if (!d.isAttached()) d.attach("1.3");
  await d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] });
}
async function shot(name, rect) {
  const img = await win.webContents.capturePage(rect);
  fs.writeFileSync(path.join(OUT, `settings-${name}.png`), img.toPNG());
}

// page helpers (installed per load): rows by label, an element brought to the middle of the view
const HELPERS = `
  window.__x = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    label: (r) => r.querySelector(".slabel-row")?.firstChild?.textContent?.trim(),
    row(label) { return [...document.querySelectorAll(".settings .srow")].find((r) => this.label(r) === label); },
    async show(el) { if (!el) return null; el.scrollIntoView({ block: "center" }); await this.sleep(500);
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height }; },
    async tab(name) { [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === name)?.click(); await this.sleep(500); },
  }; true`;
// `engine`: answer the page's /player-engine with this engine (the Settings view asks it when it mounts)
async function load({ engine } = {}) {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
  await js(HELPERS);
  await js(`await window.__x.tab("Library"); return true`);
  if (engine) await js(`const of = window.fetch.bind(window);
    window.fetch = (u, o) => String(u).includes("/player-engine")
      ? Promise.resolve(new Response(${J(J({ engine, active: engine, available: true, binary: null, reason: null }))}, { headers: { "Content-Type": "application/json" } }))
      : of(u, o); return true`);
  await js(`await window.__x.tab("Settings"); for (let i = 0; i < 60 && !document.querySelector(".settings .srow"); i++) await window.__x.sleep(100);
    await window.__x.sleep(700); return true`);
}
const has = (label) => js(`return !!window.__x.row(${J(label)})`);

// per frame for `ms`: the copy-like control `sel` (its faces' opacity + vertical offset, its width / left, data-copied) and
// a neighbour `near` (its layout left, so a pressed button's squeeze isn't a move) — what the eye sees while the words change
const SAMPLE = (sel, near, ms) => `(() => new Promise((res) => { const out = []; const t0 = performance.now();
  const f = () => { const t = Math.round(performance.now() - t0), b = document.querySelector(${J(sel)}), n = ${near ? `document.querySelector(${J(near)})` : "null"};
    if (!b) out.push({ t, gone: true });
    else { const r = b.getBoundingClientRect();
      out.push({ t, on: b.hasAttribute("data-copied"), w: +r.width.toFixed(2), x: +r.x.toFixed(2), nx: n ? n.offsetLeft : null,
        faces: [...b.querySelectorAll(".xfade > *")].map((x) => { const cs = getComputedStyle(x); return { o: +(+cs.opacity).toFixed(3), ty: +new DOMMatrix(cs.transform).f.toFixed(2), tf: cs.transform, tx: x.textContent }; }) }); }
    if (t < ${ms}) requestAnimationFrame(f); else res(out); };
  requestAnimationFrame(f); }))()`;
const mid = (o) => o > 0.05 && o < 0.95;
// a face's change of state in the frames: how many in-between opacity frames, how many off-rest offsets, how long it took
function swap(fr, i, from, to) {
  const k0 = fr.findIndex((f) => f.faces?.[i] && (from ? f.faces[i].o < 0.95 : f.faces[i].o > 0.05));
  if (k0 < 0) return null;
  const k1 = fr.findIndex((f, k) => k >= k0 && f.faces?.[i] && (to ? f.faces[i].o >= 0.95 : f.faces[i].o <= 0.05));
  const part = fr.slice(Math.max(0, k0 - 1), k1 < 0 ? undefined : k1 + 1);
  return { mids: part.filter((f) => mid(f.faces[i].o)).length, moved: part.filter((f) => Math.abs(f.faces[i].ty) > 0.3).length,
    rolled: part.filter((f) => Math.abs(f.faces[i].ty) > 0.3 && mid(f.faces[i].o)).length,
    ms: k1 < 0 ? null : fr[k1].t - fr[Math.max(0, k0 - 1)].t, done: k1 >= 0 };
}
// the frames' verdict for one copy / cache swap: `onIdx` = the face that comes in, `back` = it must also settle back
function judgeSwap(name, fr, mode, { onIdx = 1, back = true, steady = true } = {}) {
  const v = [];
  if (!fr.length || fr.some((f) => f.gone)) return [`${name}: the control left the page`];
  const offIdx = onIdx === 1 ? 0 : 1;
  const inn = swap(fr, onIdx, false, true), out = swap(fr, offIdx, true, false);
  if (!inn?.done) return [`${name}: the new words never fully showed (${brief(fr, onIdx)})`];
  if (!out?.done) v.push(`${name}: the old words never left (${brief(fr, offIdx)})`);
  if (!inn.mids) v.push(`${name}: the new words popped in — no in-between frame (${brief(fr, onIdx)})`);
  if (out && !out.mids) v.push(`${name}: the old words popped out — no in-between frame (${brief(fr, offIdx)})`);
  // a face keeps its words while it shows: the leaving one fades out as it read, never rewritten mid-fade
  for (const i of [0, 1]) {
    const seen = [...new Set(fr.filter((f) => f.faces[i] && f.faces[i].o > 0.05).map((f) => f.faces[i].tx))];
    if (seen.length > 1) v.push(`${name}: face ${i} changed its words while shown (${J(seen)})`);
  }
  if (mode === "on" && inn.rolled < 2) v.push(`${name}: motion on, the new words didn't roll in (${inn.rolled} frames mid-roll)`);
  if (mode !== "on") {
    const moved = fr.filter((f) => f.faces.some((x) => x.tf !== "none" && Math.abs(x.ty) > 0.01));
    if (moved.length) v.push(`${name}: motion ${mode}, the words moved in ${moved.length} frames (${J(moved[0].faces)})`);
    if (inn.ms != null && inn.ms > 300) v.push(`${name}: motion ${mode}, the fade took ${inn.ms} ms (want ≈ 120)`);
  }
  if (steady) {
    const ws = fr.map((f) => f.w), xs = fr.map((f) => f.x), ns = fr.map((f) => f.nx).filter((x) => x != null);
    if (Math.max(...ws) - Math.min(...ws) > 0.5) v.push(`${name}: the button's width changed (${Math.min(...ws)}–${Math.max(...ws)} px)`);
    if (Math.max(...xs) - Math.min(...xs) > 0.5) v.push(`${name}: the button moved (${Math.min(...xs)}–${Math.max(...xs)} px)`);
    if (ns.length && Math.max(...ns) - Math.min(...ns) > 0.5) v.push(`${name}: the command beside it moved (${Math.min(...ns)}–${Math.max(...ns)} px)`);
  }
  if (back) {
    const last = fr[fr.length - 1];
    if (last.on || last.faces[onIdx].o > 0.05 || last.faces[offIdx].o < 0.95) v.push(`${name}: never settled back to "Copy" (${J(last)})`);
    else {
      const k = fr.findIndex((f) => f.on);
      const kOff = fr.findIndex((f, i) => i > k && !f.on);
      const held = kOff < 0 ? null : fr[kOff].t - fr[k].t;
      if (held == null || held < 900 || held > 1600) v.push(`${name}: "Copied" held ${held} ms (want ≈ 1200, the sidebar pill's)`);
      const backSwap = swap(fr.slice(Math.max(0, kOff)), offIdx, false, true);
      if (!backSwap?.mids) v.push(`${name}: "Copy" popped back — no in-between frame`);
    }
  }
  return v;
}
const brief = (fr, i) => fr.map((f) => (f.faces?.[i] ? f.faces[i].o.toFixed(2) : "-")).filter((x, k, a) => k === 0 || x !== a[k - 1]).slice(0, 14).join(" ");

const results = [];
const cell = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  let v;
  try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
  results.push({ name, v });
  console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
  for (const x of v) console.log(`        - ${x}`);
};

// the cache fixtures: in the stack's own HOME (the backend sizes and clears ~/.cache/liascape/<dir>)
const CACHE = path.join(E.HOME, ".cache", "liascape");
const FIX = [["workshop_previews", "probe-still.jpg", 3 << 20], ["workshop_previews", "probe-anim.gif", 1 << 20], ["we_thumbs", "probe-we.jpg", 1 << 20]];
const CLIP = ["video_clips", "probe-clip.mp4", 2 << 20];
function writeFixtures() {
  for (const [d, n, size] of [...FIX, CLIP]) { fs.mkdirSync(path.join(CACHE, d), { recursive: true }); fs.writeFileSync(path.join(CACHE, d, n), Buffer.alloc(size, 7)); }
}
const dirBytes = (d) => { try { return fs.readdirSync(path.join(CACHE, d), { withFileTypes: true }).filter((x) => x.isFile()).reduce((s, x) => s + fs.statSync(path.join(CACHE, d, x.name)).size, 0); } catch { return 0; } };
// Settings.tsx fmtBytes
const fmtBytes = (b) => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : b >= 2 ** 20 ? `${Math.round(b / 2 ** 20)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const CACHE_ROW = "Clear thumbnails and GIF previews";

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  win.focus();
  try {
    await setSettings({ SettingsLevel: "standard", Morphs: true, Glows: true });
    await load();

    await cell("rename:autoMute — the row is \"Mute when other audio plays\" and still switches autoMute", async () => {
      const v = [];
      await setSettings({ SettingsLevel: "basic", AutoMute: false }); await load();
      if (await has("Hush when other audio plays")) v.push('the old label "Hush when other audio plays" is still a row');
      const r = await js(`const r = window.__x.row("Mute when other audio plays"); if (!r) return null;
        return { section: r.closest(".ssection")?.querySelector("h3")?.textContent.trim(), box: !!r.querySelector("input[type=checkbox]"), toggle: r.hasAttribute("data-row-toggle"),
          hint: r.querySelector(".shint")?.textContent ?? "" }`);
      if (!r) return [...v, 'no row labelled "Mute when other audio plays" at Basic'];
      if (!r.box || !r.toggle) v.push(`the row isn't a whole-row checkbox (${J(r)})`);
      if (!/^Auto-mute$/i.test(r.section ?? "")) v.push(`it sits in section ${J(r.section)}, want Auto-mute`);
      const p = await js(`return await window.__x.show(window.__x.row("Mute when other audio plays").querySelector(".slabel"))`);
      await clickAt(p.x, p.y);
      if (!(await waitFor(async () => (await field("autoMute")) === true, 4000))) v.push(`a click on the row didn't save autoMute (${await field("autoMute")})`);
      await setSettings({ AutoMute: false, SettingsLevel: "standard" });
      return v;
    });

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`copy:feedback:${mode} — Copy turns into "Copied", settles back, nothing beside it moves`, async () => {
        await setSettings({ SettingsLevel: "standard", Morphs: mode !== "off" }); await reducedMotion(mode === "reduced"); await load();
        try {
          const noMotion = await js(`return document.documentElement.classList.contains("no-motion")`);
          if (noMotion !== (mode !== "on")) return [`:root.no-motion is ${noMotion} under motion ${mode} — proved nothing`];
          const sel = '[data-copy="liascape next"]';
          if (!(await js(`return !!document.querySelector(${J(sel)})`))) return [`no Copy button for "liascape next" (${sel})`];
          const p = await js(`return await window.__x.show(document.querySelector(${J(sel)}))`);
          const rest = await js(`const b = document.querySelector(${J(sel)}); return [...b.querySelectorAll(".xfade > *")].filter((x) => +getComputedStyle(x).opacity > 0.5).map((x) => x.textContent.trim())`);
          if (J(rest) !== J(["Copy"])) return [`at rest it reads ${J(rest)}, want ["Copy"]`];
          const samp = js(`return await ${SAMPLE(sel, '.srow:has([data-copy="liascape next"]) code.kb', 1900)}`);
          await sleep(60); await clickAt(p.x, p.y);
          const fr = await samp;
          const v = judgeSwap(`motion ${mode}`, fr, mode);
          const words = fr.find((f) => f.on && f.faces[1].o >= 0.95);
          if (!words) v.push("no frame shows the \"Copied\" face fully");
          const label = await js(`return [...document.querySelectorAll(".srow")].find((r) => r.querySelector(${J(sel)}))?.querySelector(".slabel-row")?.textContent.trim()`);
          if (label !== "next") v.push(`the button sits in row ${J(label)}`);
          return v;
        } finally { await reducedMotion(false); await mv(5, 5); }
      });
    }
    await setSettings({ Morphs: true });

    await cell("copy:commands — a shortcut, Autostart and both Expert command blocks copy what they show", async () => {
      const v = [];
      await setSettings({ SettingsLevel: "expert" }); await load();
      // the page's own writes too: a cross-check when the session's clipboard can't be read
      await js(`const w = navigator.clipboard.writeText.bind(navigator.clipboard); window.__wrote = [];
        navigator.clipboard.writeText = (t) => { window.__wrote.push(t); return w(t); }; return true`);
      const blocks = await js(`return Object.fromEntries([...document.querySelectorAll(".settings .ssection")].map((s) => [s.querySelector("h3")?.textContent.trim(), s.querySelector("pre.mpv")?.textContent ?? null]).filter(([, t]) => t != null))`);
      const want = [
        ["volume-up shortcut", '[data-copy="liascape volume up"]', "liascape volume up"],
        ["Autostart", '[data-copy="liascape restore"]', "liascape restore"],
        ["mpv command (live)", '[data-copy="mpv command"]', blocks["mpv command (live)"]],
        ["linux-wallpaperengine command (live)", '[data-copy="linux-wallpaperengine command"]', blocks["linux-wallpaperengine command (live)"]],
      ];
      for (const [what, sel, text] of want) {
        if (!text || text === "…") { v.push(`${what}: nothing to copy (${J(text)}) — proved nothing`); continue; }
        const p = await js(`return await window.__x.show(document.querySelector(${J(sel)}))`);
        if (!p) { v.push(`${what}: no Copy button (${sel})`); continue; }
        clipboard.writeText("");
        await js(`window.__wrote.length = 0; return true`);
        await clickAt(p.x, p.y);
        await waitFor(() => clipboard.readText() !== "", 1500);
        const got = clipboard.readText(), wrote = await js(`return window.__wrote.slice()`);
        if (got !== text) v.push(`${what}: the clipboard holds ${J(got.slice(0, 80))}${wrote.length ? ` (the page wrote ${J(wrote[0]?.slice(0, 80))})` : " (no write)"}, want ${J(text.slice(0, 80))}`);
        if (!(await js(`return document.querySelector(${J(sel)})?.hasAttribute("data-copied")`))) v.push(`${what}: the button didn't turn into "Copied"`);
      }
      // the block's button doesn't sit over the command's first line
      const lap = await js(`return [...document.querySelectorAll(".cmd-block")].map((c) => { const b = c.querySelector(".copy-btn").getBoundingClientRect(), pre = c.querySelector("pre");
        const cs = getComputedStyle(pre), textRight = pre.getBoundingClientRect().right - parseFloat(cs.paddingRight); return +(textRight - b.left).toFixed(1); })`);
      if (lap.length !== 2) v.push(`${lap.length} command blocks with a Copy button, want 2`);
      for (const d of lap) if (d > 0) v.push(`a block's Copy button covers ${d} px of its command's lines`);
      await setSettings({ SettingsLevel: "standard" });
      return v;
    });

    await cell("copy:sidebarPill — the Library sidebar's Workshop ID pill (the same hooks/useCopied.ts) still flips to \"Copied\" and back", async () => {
      const v = [];
      await setSettings({ SettingsLevel: "standard" }); await load();
      await js(`await window.__x.tab("Library"); await window.__x.sleep(600); return true`);
      const PILL = ".side-panel:not(.closing) [data-side-row=workshop-id]";
      // the face it shows: both faces stay in the pill (one grid cell, so its width never changes), the other one aria-hidden
      const SHOWN = `${PILL} .xfade > :not([data-off])`;
      const id = await js(`for (const c of document.querySelectorAll(".card.lib")) {
          c.querySelector(".thumb-wrap")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
          for (let i = 0; i < 20 && !document.querySelector(${J(PILL)}); i++) await window.__x.sleep(100);
          const p = document.querySelector(${J(SHOWN)}); if (p) return p.textContent.trim();
        } return null`);
      if (!id) return ["no Library item with a Workshop ID pill — proved nothing"];
      await sleep(600);
      const p = await js(`const r = document.querySelector(${J(PILL)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`);
      clipboard.writeText("");
      await clickAt(p.x, p.y);
      const t0 = Date.now();
      if (!(await waitFor(() => js(`return document.querySelector(${J(SHOWN)})?.textContent.trim() === "Copied"`), 600, 30))) v.push(`the pill never read "Copied" (${await js(`return document.querySelector(${J(SHOWN)})?.textContent.trim()`)})`);
      if (!(await waitFor(() => js(`return document.querySelector(${J(SHOWN)})?.textContent.trim() === ${J(id)}`), 2500, 50))) v.push("the pill never went back to its ID");
      else if (Date.now() - t0 < 900) v.push(`"Copied" held only ${Date.now() - t0} ms (want ≈ 1200)`);
      if (clipboard.readText() !== id) v.push(`the clipboard holds ${J(clipboard.readText())}, want ${J(id)}`);
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true`);
      return v;
    });

    await cell("copy:look — hover glow, no-glow, bg-live, green \"Copied\"; pictures", async () => {
      const v = [];
      await setSettings({ SettingsLevel: "expert" }); await load();
      const C = (expr) => js(`const p = document.createElement("i"); p.style.color = ${J(expr)}; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c`);
      const lit = (sh) => !!sh && sh !== "none" && sh.split(/,(?![^(]*\))/).some((part) => {
        const m = /rgba?\(([^)]*)\)/.exec(part); if (!m) return false; const c = m[1].split(",").map(Number); return c.length < 4 || c[3] > 0; });
      const sel = '[data-copy="liascape next"]';
      const read = () => js(`const b = document.querySelector(${J(sel)}), cs = getComputedStyle(b); return { shadow: cs.boxShadow, bg: cs.backgroundColor, color: cs.color }`);
      const p = await js(`return await window.__x.show(document.querySelector(${J(sel)}))`);
      const row = await js(`const r = [...document.querySelectorAll(".srow")].find((r) => r.querySelector(${J(sel)})).getBoundingClientRect(); return { x: Math.round(r.x) - 8, y: Math.round(r.y) - 8, width: Math.round(r.width) + 16, height: Math.round(r.height) + 16 }`);
      await mv(5, 5, 300);
      await shot("copy-rest", row);
      if (lit((await read()).shadow)) v.push(`at rest it glows (${(await read()).shadow})`);
      await mv(p.x, p.y, 400);
      if (!lit((await read()).shadow)) v.push(`hovered, no glow (${(await read()).shadow})`);
      await shot("copy-hover", row);
      await js(`document.documentElement.classList.add("no-glow"); return true`); await sleep(300);
      if (lit((await read()).shadow)) v.push(`no-glow: still glowing (${(await read()).shadow})`);
      await shot("copy-hover-noglow", row);
      await js(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live"); return true`); await sleep(300);
      const bl = await read(), a = /\/\s*([0-9.]+)\s*\)$/.exec(bl.bg)?.[1] ?? /rgba\([^)]*,\s*([0-9.]+)\)/.exec(bl.bg)?.[1] ?? 1;
      if (!(+a < 1)) v.push(`bg-live: the fill ${bl.bg} is opaque (want --tr translucency)`);
      await js(`document.documentElement.classList.remove("bg-live"); return true`); await sleep(200);
      await clickAt(p.x, p.y); await sleep(70); await shot("copy-mid", row);
      await sleep(450);
      const done = await read();
      if (done.color !== await C("var(--success)")) v.push(`"Copied" is ${done.color}, want --success ${await C("var(--success)")}`);
      await shot("copy-done", row);
      await mv(5, 5, 1500);
      const b = await js(`return await window.__x.show(document.querySelector('[data-copy="mpv command"]')?.closest(".ssection"))`);
      if (b) {
        const rect = { x: Math.round(b.l) - 6, y: Math.round(b.t) - 6, width: Math.round(b.w) + 12, height: Math.round(b.h) + 12 };
        await shot("copy-mpv-rest", rect);
        const q = await js(`const r = document.querySelector('[data-copy="mpv command"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`);
        await clickAt(q.x, q.y); await sleep(500); await shot("copy-mpv-done", rect);
        await js(`document.documentElement.classList.add("bg-live"); return true`); await sleep(300); await shot("copy-mpv-bglive", rect);
        await js(`document.documentElement.classList.remove("bg-live"); return true`);
      } else v.push("no mpv command block at Expert");
      await mv(5, 5);
      await setSettings({ SettingsLevel: "standard" });
      return v;
    });

    await cell("nudge:engine — \"Full-live sync nudge\" only under the legacy engine; its value stays saved", async () => {
      const v = [];
      const eng = (await http("GET", "/player-engine")).json?.active;
      if (eng !== "liascape-player") return [`the stack runs ${J(eng)}, not liascape-player — proved nothing`];
      await setSettings({ SettingsLevel: "advanced", TransitionMethod: "full-live", FullLiveSyncOffsetMs: -40 });
      try {
        await load();
        if (!(await has("Transition style"))) return ['no "Transition style" row at Advanced — proved nothing'];
        if (await has("Full-live sync nudge")) v.push("liascape-player: the nudge row shows (only the legacy helper reads it)");
        await load({ engine: "legacy" });
        if (!(await has("Full-live sync nudge"))) v.push("legacy, Full-live: no nudge row");
        await setSettings({ TransitionMethod: "reveal" }); await load({ engine: "legacy" });
        if (await has("Full-live sync nudge")) v.push("legacy, Reveal: the nudge row shows (it's Full-live only)");
        if ((await field("fullLiveSyncOffsetMs")) !== -40) v.push(`hiding changed the saved value: fullLiveSyncOffsetMs ${await field("fullLiveSyncOffsetMs")}, want -40`);
      } finally {
        await setSettings({ SettingsLevel: "standard", TransitionMethod: "reveal", FullLiveSyncOffsetMs: -30 });
      }
      return v;
    });

    await cell("cache:size — the row says what it clears and shows the size of exactly those folders", async () => {
      const v = [];
      writeFixtures();
      const want = dirBytes("workshop_previews") + dirBytes("we_thumbs");
      await load();
      const r = await js(`const r = window.__x.row(${J(CACHE_ROW)}); if (!r) return null; await window.__x.show(r); await window.__x.sleep(400);
        const sz = r.querySelector("[data-size]"); return { hint: r.querySelector(".shint")?.textContent ?? "", size: sz?.textContent ?? null, o: sz ? +getComputedStyle(sz).opacity : null }`);
      if (!r) return [`no "${CACHE_ROW}" row in Housekeeping`];
      if (!/clips aren't touched/.test(r.hint)) v.push(`the hint doesn't say the preview clips stay: ${J(r.hint)}`);
      if (r.size !== fmtBytes(want) || !(r.o > 0.95)) v.push(`the size reads ${J(r.size)} (opacity ${r.o}), want ${J(fmtBytes(want))} — workshop_previews + we_thumbs, not video_clips (${fmtBytes(dirBytes("video_clips"))})`);
      const api = (await http("GET", "/cache/size")).json;
      if (api?.bytes !== want) v.push(`/cache/size answers ${J(api)}, want bytes ${want}`);
      const rect = await js(`const b = window.__x.row(${J(CACHE_ROW)}).getBoundingClientRect(); return { x: Math.round(b.x) - 8, y: Math.round(b.y) - 8, width: Math.round(b.width) + 16, height: Math.round(b.height) + 16 }`);
      await shot("cache-size", rect);
      return v;
    });

    for (const mode of ["on", "off"]) {
      await cell(`cache:clear:${mode} — Clear Cache empties those folders (not the clips) and the row shows what it freed`, async () => {
        const v = [];
        await setSettings({ Morphs: mode === "on" });
        writeFixtures();
        await load();
        const want = dirBytes("workshop_previews") + dirBytes("we_thumbs");
        const row = `window.__x.row(${J(CACHE_ROW)})`;
        if (!(await js(`return !!${row}`))) return [`no "${CACHE_ROW}" row`];
        const p = await js(`await window.__x.show(${row}); await window.__x.sleep(300); return await window.__x.show(${row}.querySelector("[data-cache-clear]"))`);
        const rect = await js(`const b = ${row}.getBoundingClientRect(); return { x: Math.round(b.x) - 8, y: Math.round(b.y) - 8, width: Math.round(b.width) + 16, height: Math.round(b.height) + 16 }`);
        const samp = js(`return await ${SAMPLE("[data-cache-note]", "[data-cache-clear]", 900)}`);
        await sleep(60); await clickAt(p.x, p.y);
        if (mode === "on") { await sleep(110); await shot("cache-mid", rect); }
        const fr = await samp;
        v.push(...judgeSwap(`motion ${mode}`, fr, mode, { back: false, steady: false }));
        const bx = fr.map((f) => f.nx).filter((x) => x != null);
        if (Math.max(...bx) - Math.min(...bx) > 0.5) v.push(`the Clear Cache button moved (${Math.min(...bx)}–${Math.max(...bx)} px)`);
        const after = await js(`const r = ${row}; return { freed: r.querySelector("[data-freed]")?.textContent ?? null, disabled: r.querySelector("[data-cache-clear]")?.disabled ?? null }`);
        if (after.freed !== `Freed ${fmtBytes(want)}`) v.push(`after the clear it reads ${J(after.freed)}, want ${J(`Freed ${fmtBytes(want)}`)}`);
        if (after.disabled !== true) v.push("Clear Cache stays enabled on an empty cache");
        for (const [d, n] of FIX) if (fs.existsSync(path.join(CACHE, d, n))) v.push(`${d}/${n} survived the clear`);
        if (!fs.existsSync(path.join(CACHE, ...CLIP.slice(0, 2)))) v.push("the clear deleted a preview clip (video_clips)");
        await shot(`cache-freed-${mode}`, rect);
        return v;
      });
    }
    await setSettings({ Morphs: true });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`SETTINGS pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "settings.json"), J(results, null, 1));
  app.exit(fail ? 1 : 0);
});
